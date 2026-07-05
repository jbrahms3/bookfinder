const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Store websites often WAF-block non-browser UAs, while Overpass rejects
// browser-impersonating ones — so each gets its own.
const USER_AGENT =
  "Mozilla/5.0 (compatible; Bookfinder/1.0; +https://github.com/jbrahms3/bookfinder)";
const OVERPASS_USER_AGENT = "Bookfinder/1.0 (local bookstore availability checker)";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_STORES = 15;
const MAX_SCAN_RADIUS_KM = 100;

// Name fragments used to flag chains when OSM lacks a brand tag. Matched
// case-insensitively against the store name. Kept deliberately small —
// the primary chain signal is OSM's brand/brand:wikidata tag.
const CHAIN_NAME_PATTERNS = [
  "barnes & noble",
  "barnes and noble",
  "books-a-million",
  "booksamillion",
  "waterstones",
  "indigo",
  "chapters",
  "coles",
  "half price books",
  "2nd & charles",
  "deseret book",
  "seagull book",
  "family christian",
  "lifeway",
  "walmart",
  "target",
  "costco",
];

function isChain(tags) {
  // OSM convention: chains carry a brand / brand:wikidata / operator tag.
  if (tags.brand || tags["brand:wikidata"] || tags.brand_wikidata) return true;
  const name = (tags.name || "").toLowerCase();
  return CHAIN_NAME_PATTERNS.some((frag) => name.includes(frag));
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function sendJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Basic SSRF guard: only fetch plain http(s) URLs on public-looking hosts.
function isSafePublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host.includes(":") // raw IPv6 literals
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// /api/stores — nearby bookstores from OpenStreetMap (Overpass API)
// ---------------------------------------------------------------------

const storesCache = new Map(); // key -> { at, data }
const STORES_CACHE_MS = 10 * 60 * 1000;

async function handleStores(query, res) {
  const lat = Number(query.get("lat"));
  const lon = Number(query.get("lon"));
  let radiusKm = Number(query.get("radius_km")) || 25;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return sendJSON(res, 400, { error: "lat and lon are required numbers" });
  }
  radiusKm = Math.min(Math.max(radiusKm, 1), MAX_SCAN_RADIUS_KM);

  // Independents only by default; pass include_chains=1 to keep chains.
  const includeChains = query.get("include_chains") === "1";

  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm},${includeChains}`;
  const cached = storesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STORES_CACHE_MS) {
    return sendJSON(res, 200, cached.data);
  }

  const overpassQuery = `
    [out:json][timeout:20];
    (
      node["shop"="books"](around:${radiusKm * 1000},${lat},${lon});
      way["shop"="books"](around:${radiusKm * 1000},${lat},${lon});
    );
    out center tags;
  `;

  let data;
  try {
    const overpassRes = await fetchWithTimeout(
      OVERPASS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": OVERPASS_USER_AGENT,
        },
        body: "data=" + encodeURIComponent(overpassQuery),
      },
      20000
    );
    if (!overpassRes.ok) {
      return sendJSON(res, 502, {
        error: `Store lookup failed (Overpass ${overpassRes.status})`,
      });
    }
    data = await overpassRes.json();
  } catch (err) {
    return sendJSON(res, 502, { error: `Store lookup failed: ${err.message}` });
  }

  const mapped = (data.elements || [])
    .map((el) => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      const tags = el.tags || {};
      if (elLat == null || elLon == null || !tags.name) return null;
      let website = tags.website || tags["contact:website"] || null;
      if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
      return {
        id: `${el.type}/${el.id}`,
        name: tags.name,
        lat: elLat,
        lon: elLon,
        website,
        phone: tags.phone || tags["contact:phone"] || null,
        secondHand: tags.second_hand === "yes" || tags.second_hand === "only",
        isChain: isChain(tags),
        distanceKm: Math.round(haversineKm(lat, lon, elLat, elLon) * 10) / 10,
      };
    })
    .filter(Boolean);

  const chainsFiltered = mapped.filter((s) => s.isChain).length;
  const stores = mapped
    .filter((s) => includeChains || !s.isChain)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, MAX_STORES);

  const payload = {
    stores,
    source: "openstreetmap",
    radiusKm,
    includeChains,
    chainsFiltered,
  };
  storesCache.set(cacheKey, { at: Date.now(), data: payload });
  sendJSON(res, 200, payload);
}

// ---------------------------------------------------------------------
// /api/availability — check one store's website for an ISBN
// ---------------------------------------------------------------------

// Shopify: public suggest endpoint returns structured product data.
async function shopifySuggest(origin, q) {
  const params = new URLSearchParams({
    q,
    "resources[type]": "product",
    "resources[limit]": "5",
  });
  let res;
  try {
    res = await fetchWithTimeout(`${origin}/search/suggest.json?${params}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const products = data?.resources?.results?.products;
  return Array.isArray(products) ? products : null; // null = not Shopify
}

function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = new Set(na.split(" "));
  const wordsB = nb.split(" ");
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap / wordsB.length >= 0.7;
}

async function checkShopify(origin, isbn, title) {
  // ISBN query first — matches stores that index ISBNs in titles/SKUs.
  const byIsbn = await shopifySuggest(origin, isbn);
  if (byIsbn === null) return null; // not a Shopify store

  if (byIsbn.length > 0) {
    const product = byIsbn[0];
    return {
      platform: "shopify",
      status: product.available === false ? "out_of_stock" : "in_stock",
      title: product.title || null,
      url: product.url ? origin + product.url : origin,
    };
  }

  // Most bookstores don't index ISBNs in searchable fields; fall back to
  // a title search and accept only close title matches.
  if (title) {
    const byTitle = (await shopifySuggest(origin, title)) || [];
    const match = byTitle.find((p) => titlesMatch(p.title, title));
    if (match) {
      return {
        platform: "shopify",
        status: match.available === false ? "out_of_stock" : "in_stock",
        title: match.title || null,
        url: match.url ? origin + match.url : origin,
        note: "matched by title — edition may differ",
      };
    }
  }

  return { platform: "shopify", status: "not_found" };
}

// IndieCommerce / IndieLite (ABA): book pages live at /book/{isbn} with
// well-known availability phrases.
async function checkIndieCommerce(origin, isbn) {
  const bookUrl = `${origin}/book/${isbn}`;
  let res;
  try {
    res = await fetchWithTimeout(bookUrl);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 600000);

  // Only claim a result if the page carries IndieCommerce's availability markers.
  if (!/On Our Shelves|Usually Ships|Special Order|Backordered|Out of Print/i.test(html)) {
    return null;
  }
  let status = "listed";
  if (/On Our Shelves Now/i.test(html)) status = "in_stock";
  else if (/Out of Print|Hard to Find/i.test(html)) status = "out_of_stock";
  return { platform: "indiecommerce", status, url: bookUrl };
}

// Generic fallback: try common storefront search URLs and look for the
// ISBN plus availability-ish wording in the HTML.
const GENERIC_SEARCH_PATHS = [
  "/search?q={q}",
  "/?s={q}",
  "/search/site/{q}",
  "/catalogsearch/result/?q={q}",
];

async function checkGeneric(origin, isbn) {
  for (const pattern of GENERIC_SEARCH_PATHS) {
    const url = origin + pattern.replace("{q}", encodeURIComponent(isbn));
    let res;
    try {
      res = await fetchWithTimeout(url, {}, 6000);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) continue;
    const html = (await res.text()).slice(0, 600000);
    if (!html.includes(isbn)) continue;
    const inStock = /in stock|on our shelves|add to cart|available now/i.test(html);
    return {
      platform: "generic",
      status: inStock ? "listed" : "listed_unknown",
      url,
    };
  }
  return null;
}

// When no adapter matched, fetch the homepage once to explain WHY rather
// than reporting a vague "couldn't check": is the site blocking us, down,
// or a BookManager webstore (which the Shop Local widget already covers)?
async function diagnoseOrigin(origin) {
  let res;
  try {
    res = await fetchWithTimeout(origin, {}, 8000);
  } catch (err) {
    return {
      platform: null,
      status: err.name === "AbortError" ? "timeout" : "unreachable",
      url: origin,
    };
  }

  if ([401, 403, 429, 503].includes(res.status) || /\/blocked\b/i.test(res.url || "")) {
    return { platform: null, status: "blocked", url: origin };
  }

  let html = "";
  try {
    html = (await res.text()).slice(0, 200000);
  } catch {
    /* ignore body read errors */
  }

  // BookManager-powered storefronts render inventory client-side and are
  // the Shop Local widget's job — flag them rather than pretend to scrape.
  if (/\bbookmanager\.com\b|cdn\d*\.bookmanager\.com/i.test(html)) {
    return { platform: "bookmanager", status: "bookmanager", url: origin };
  }

  return { platform: null, status: "not_found", url: origin };
}

async function handleAvailability(query, res) {
  const website = query.get("website") || "";
  const isbn = (query.get("isbn") || "").replace(/[^0-9Xx]/g, "");
  const title = (query.get("title") || "").slice(0, 200);

  if (!/^\d{13}$|^[\dXx]{10}$/.test(isbn)) {
    return sendJSON(res, 400, { error: "isbn must be a 10- or 13-digit ISBN" });
  }
  if (!isSafePublicUrl(website)) {
    return sendJSON(res, 400, { error: "website must be a public http(s) URL" });
  }

  const origin = new URL(website).origin;

  try {
    const result =
      (await checkShopify(origin, isbn, title)) ||
      (await checkIndieCommerce(origin, isbn)) ||
      (await checkGeneric(origin, isbn));

    if (result) return sendJSON(res, 200, result);
    return sendJSON(res, 200, await diagnoseOrigin(origin));
  } catch (err) {
    return sendJSON(res, 200, {
      platform: null,
      status: "unknown",
      url: origin,
      note: err.message,
    });
  }
}

// ---------------------------------------------------------------------
// server
// ---------------------------------------------------------------------

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(req.url.split("?")[0]);
  const safePath = path.normalize(path.join(ROOT, requestPath)).startsWith(ROOT)
    ? path.join(ROOT, requestPath)
    : ROOT;

  let filePath = safePath === ROOT || safePath.endsWith(path.sep)
    ? path.join(safePath, "index.html")
    : safePath;

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Single-page fallback: unknown paths serve index.html.
      fs.readFile(path.join(ROOT, "index.html"), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
        res.end(fallbackData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/stores") {
    return handleStores(url.searchParams, res).catch((err) =>
      sendJSON(res, 500, { error: err.message })
    );
  }
  if (url.pathname === "/api/availability") {
    return handleAvailability(url.searchParams, res).catch((err) =>
      sendJSON(res, 500, { error: err.message })
    );
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Bookfinder running at http://localhost:${PORT}`);
});
