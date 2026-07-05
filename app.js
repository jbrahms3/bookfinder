const STORAGE_KEYS = {
  apiKey: "sl_api_key",
  googleApiKey: "sl_google_api_key",
  distanceKm: "sl_distance_km",
  location: "sl_location",
};

const SHOP_LOCAL_IMAGE = "https://bookmanager.com/public/api/btns/Shop Local Button.png";
const SHOP_LOCAL_SCRIPT_SRC = "https://bookmanager.com/public/api/tbm-shop-local.js";

// ---- storage helpers -------------------------------------------------

function getApiKey() {
  return localStorage.getItem(STORAGE_KEYS.apiKey) || "";
}

function setApiKey(key) {
  localStorage.setItem(STORAGE_KEYS.apiKey, key);
}

function getGoogleApiKey() {
  return localStorage.getItem(STORAGE_KEYS.googleApiKey) || "";
}

function setGoogleApiKey(key) {
  localStorage.setItem(STORAGE_KEYS.googleApiKey, key);
}

function getDistanceKm() {
  return Number(localStorage.getItem(STORAGE_KEYS.distanceKm)) || 50;
}

function setDistanceKm(km) {
  localStorage.setItem(STORAGE_KEYS.distanceKm, String(km));
}

function getLocation() {
  const raw = localStorage.getItem(STORAGE_KEYS.location);
  return raw ? JSON.parse(raw) : null;
}

function setLocation(location) {
  localStorage.setItem(STORAGE_KEYS.location, JSON.stringify(location));
}

// ---- ISBN/EAN helpers -------------------------------------------------

function isValidEAN13(digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(digits[12], 10);
}

function isbn10to13(isbn10) {
  const core = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(core[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

function getProductCode(volumeInfo) {
  const ids = volumeInfo.industryIdentifiers || [];
  const isbn13 = ids.find((id) => id.type === "ISBN_13");
  if (isbn13) return isbn13.identifier.replace(/[^0-9]/g, "");

  const isbn10 = ids.find((id) => id.type === "ISBN_10");
  if (isbn10) return isbn10to13(isbn10.identifier.replace(/[^0-9Xx]/g, ""));

  const other = ids.find((id) => /^\d{13}$/.test(id.identifier.replace(/[^0-9]/g, "")));
  if (other) return other.identifier.replace(/[^0-9]/g, "");

  return null;
}

// ---- location UI -------------------------------------------------

function formatUpdatedAt(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderLocationStatus(location) {
  const el = document.getElementById("location-status");
  if (location && typeof location.latitude === "number") {
    el.textContent = `Location: ${location.latitude.toFixed(4)}, ${location.longitude.toFixed(
      4
    )} (updated ${formatUpdatedAt(location.updatedAt)})`;
    el.classList.remove("error");
  } else {
    el.textContent = "Location not set — widget will ask for it when you check availability.";
    el.classList.remove("error");
  }
}

document.getElementById("use-location").addEventListener("click", () => {
  const status = document.getElementById("location-status");
  status.textContent = "Locating…";
  status.classList.remove("error");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        updatedAt: Date.now(),
      };
      setLocation(location);
      renderLocationStatus(location);
    },
    (error) => {
      status.textContent = `Couldn't get location: ${error.message}`;
      status.classList.add("error");
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

document.getElementById("distance-km").addEventListener("change", (event) => {
  setDistanceKm(Number(event.target.value));
});

// ---- settings UI -------------------------------------------------

document.getElementById("settings-toggle").addEventListener("click", () => {
  const panel = document.getElementById("settings-panel");
  panel.hidden = !panel.hidden;
});

document.getElementById("save-settings").addEventListener("click", () => {
  const apiKey = document.getElementById("api-key-input").value.trim();
  const googleApiKey = document.getElementById("google-api-key-input").value.trim();
  setApiKey(apiKey);
  setGoogleApiKey(googleApiKey);
  const status = document.getElementById("settings-status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});

// ---- search -------------------------------------------------

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("search-input").value.trim();
  if (query) searchBooks(query);
});

function searchBooks(query) {
  const results = document.getElementById("results");
  results.innerHTML = '<p class="status">Searching…</p>';

  const digitsOnly = query.replace(/[\s-]/g, "");
  const looksLikeIsbn = /^[\dXx]{10}$|^\d{13}$/.test(digitsOnly);
  const q = looksLikeIsbn ? `isbn:${digitsOnly}` : query;

  const googleApiKey = getGoogleApiKey();
  const keyParam = googleApiKey ? `&key=${encodeURIComponent(googleApiKey)}` : "";

  fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20${keyParam}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Google Books API error (${res.status})`);
      return res.json();
    })
    .then((data) => renderResults(data.items || []))
    .catch((error) => {
      results.innerHTML = `<p class="status error">Search failed: ${error.message}</p>`;
    });
}

function renderResults(items) {
  const results = document.getElementById("results");
  results.innerHTML = "";

  if (!items.length) {
    results.innerHTML = '<p class="status">No books found.</p>';
    return;
  }

  items.forEach((item) => {
    const info = item.volumeInfo || {};
    const productCode = getProductCode(info);

    const card = document.createElement("article");
    card.className = "book-card";

    const thumbnail = info.imageLinks && (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail);
    let cover;
    if (thumbnail) {
      cover = document.createElement("img");
      cover.src = thumbnail;
      cover.alt = info.title || "Book cover";
      cover.className = "book-cover";
    } else {
      cover = document.createElement("div");
      cover.className = "book-cover placeholder";
      cover.textContent = "No cover";
    }

    const details = document.createElement("div");
    details.className = "book-details";

    const title = document.createElement("h3");
    title.textContent = info.title || "Untitled";

    const authors = document.createElement("p");
    authors.className = "book-authors";
    authors.textContent = (info.authors || []).join(", ") || "Unknown author";

    const meta = document.createElement("p");
    meta.className = "book-meta";
    meta.textContent = [info.publisher, info.publishedDate].filter(Boolean).join(" · ");

    const code = document.createElement("p");
    code.className = "book-code";
    code.textContent = productCode ? `ISBN: ${productCode}` : "No ISBN/barcode available";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Check Local Availability";
    button.disabled = !productCode;
    button.addEventListener("click", () =>
      checkAvailability({ title: info.title || productCode, productCode })
    );

    details.append(title, authors, meta, code, button);
    card.append(cover, details);
    results.appendChild(card);
  });
}

// ---- availability check -------------------------------------------------

function buildOptionsAttr(options) {
  const entries = Object.entries(options).map(([key, value]) => `'${key}': '${value}'`);
  return `{${entries.join(", ")}}`;
}

function checkAvailability(book) {
  const apiKey = getApiKey();
  if (!apiKey) {
    alert("Please set your BookManager API key in Settings first.");
    document.getElementById("settings-panel").hidden = false;
    return;
  }

  const location = getLocation();
  const distanceKm = getDistanceKm();

  const options = {
    api_key: apiKey,
    product_code: book.productCode,
    distance_km: String(distanceKm),
    request_location: location ? "false" : "true",
    image: SHOP_LOCAL_IMAGE,
    enable_dropdown: "true",
  };
  if (location) {
    options.latitude = String(location.latitude);
    options.longitude = String(location.longitude);
  }

  document.getElementById("availability-title").textContent = book.title;

  const container = document.getElementById("tbm-widget-container");
  container.innerHTML = "";

  const widgetDiv = document.createElement("div");
  widgetDiv.className = "tbm_shop_local";
  widgetDiv.setAttribute("data-options", buildOptionsAttr(options));
  container.appendChild(widgetDiv);

  const script = document.createElement("script");
  script.src = SHOP_LOCAL_SCRIPT_SRC;
  script.async = true;
  container.appendChild(script);

  const section = document.getElementById("availability-section");
  section.hidden = false;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("close-availability").addEventListener("click", () => {
  document.getElementById("availability-section").hidden = true;
  document.getElementById("tbm-widget-container").innerHTML = "";
});

// ---- init -------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("api-key-input").value = getApiKey();
  document.getElementById("google-api-key-input").value = getGoogleApiKey();
  document.getElementById("distance-km").value = String(getDistanceKm());
  renderLocationStatus(getLocation());
});
