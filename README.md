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

The frontend itself is entirely static HTML/CSS/JS. [server.js](server.js)
is a tiny dependency-free Node static file server, included only so
Railway (or any Node host) has a process to run — it doesn't do anything
app-specific.

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
