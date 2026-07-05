# Shop Local Books (website)

A standalone, fully static website: search for a book via the Google
Books API, then check whether it's in stock at a nearby independent
bookstore via BookManager's Shop Local widget/API.

## How it works

1. **Search** ([app.js](app.js) `searchBooks`) queries
   `https://www.googleapis.com/books/v1/volumes` (no API key required for
   basic use, but see rate limits below).
2. **ISBN extraction** (`getProductCode`) pulls the ISBN-13 from
   `volumeInfo.industryIdentifiers`, converting ISBN-10 to ISBN-13 (EAN)
   when that's all Google Books returns.
3. **Location** — "Use My Location" calls `navigator.geolocation` once
   and caches lat/long in `localStorage` (no repeated prompts).
4. **Availability check** (`checkAvailability`) injects BookManager's
   `tbm_shop_local` widget div with your API key, the book's ISBN,
   your cached location, and your chosen search radius, then loads
   `https://bookmanager.com/public/api/tbm-shop-local.js`, exactly the
   way BookManager's own embed snippet works.

## Nearby store website scan (works with any inventory system)

Besides the BookManager widget, the availability panel has a **Scan
nearby stores** button that checks stores' own public websites — so it
works regardless of which POS/inventory system a store uses:

1. `GET /api/stores` finds bookstores near you via OpenStreetMap's
   Overpass API (free, no API key) — name, distance, website, phone.
   **Independent stores only by default**: chains are detected via OSM's
   `brand`/`brand:wikidata` tags plus a name blocklist (Barnes & Noble,
   Books-A-Million, Deseret Book, etc.) and filtered out. Pass
   `include_chains=1` (or click "show them" in the UI) to keep them.
2. `GET /api/availability` checks each store's website for the book,
   using platform adapters in order:
   - **Shopify** — public `search/suggest.json`; tries the ISBN, then
     falls back to a fuzzy title match (flagged "edition may differ")
     since most stores don't index ISBNs in searchable fields.
   - **IndieCommerce/IndieLite** (ABA) — fetches `/book/{isbn}` and reads
     the standard availability phrases ("On Our Shelves Now", etc.).
   - **Generic** — tries common storefront search URLs and looks for the
     ISBN in the results page.
3. Each store gets a status badge: In stock / Out of stock / Listed on
   site / Not on their site / Couldn't check / No website listed.

Caveats: store coverage depends on OpenStreetMap data (missing stores
can be added at openstreetmap.org); stores without a website tag show
their phone number instead; "Listed" from the generic adapter means the
book is on their site but stock couldn't be confirmed.

[server.js](server.js) is dependency-free Node — it serves the static
frontend and implements the two API endpoints above (with per-request
timeouts, an SSRF guard, and short-lived caching of store lookups).

## Run locally

```
npm start
```

Then open `http://localhost:3000` (or whatever `PORT` is set to).

## Deploying on Railway

Railway auto-detects this as a Node app from `package.json` and runs
`npm start`, which serves the site via `server.js` on Railway's assigned
`$PORT`. After your first deploy, Railway gives you a domain like
`bookfinder-production.up.railway.app` (or you can attach a custom
domain in the Railway project settings) — see the whitelisting note
below for what to do with that domain.

## Setup

Click **⚙ Settings** and paste your BookManager API key. A Google Books
API key is optional (see below). Both are saved in `localStorage`
(per-browser, not synced anywhere).

### Getting a Google Books API key (optional but recommended)

Unauthenticated requests to Google Books share a fairly low per-IP quota
and can return `429` errors under moderate traffic — the anonymous key
lifts that. To get one:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/),
   create (or pick) a project.
2. Enable the **Books API** under APIs & Services.
3. Create an API key under **Credentials**.
4. Restrict it to **HTTP referrers** and add your domain(s) (e.g.
   `localhost`, `*.up.railway.app`, your custom domain) — this key is
   used client-side and is visible in the page, so restrict it the same
   way you'd restrict the BookManager key by domain.
5. Paste it into Settings on this site.

## Important: domain whitelisting

BookManager API keys are restricted to specific authorized domains. If
you see **"Not authorized for this domain"** in the widget dropdown,
that means the domain you're testing/hosting from (e.g. `localhost`, or
your production domain) hasn't been whitelisted for this key yet — this
is a security setting on BookManager's side, not a bug here. Contact
BookManager to add whichever domain(s) you'll actually deploy to
(including `localhost`/`127.0.0.1` if you want local testing to work).

## Notes / limitations

- Google Books' unauthenticated endpoint has a modest per-IP rate limit;
  if searches start failing with a 429, add a Google Books API key in
  Settings (see above) — that's Google throttling, not a bug.
- Books with no ISBN in Google's data (some obscure/older editions) will
  show a disabled "Check Local Availability" button, since BookManager's
  API needs a product code to look anything up.
- The actual local-inventory search UI (postal code entry, results list)
  is rendered entirely by BookManager's own script — this site only
  supplies the book, location, and API key.
