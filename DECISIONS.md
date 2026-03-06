# ring-app — Architecture & Design Decisions

A reference for decisions made during development, including the reasoning so context isn't lost.

---

## What this is

A lightweight community website showing live Nürburgring track status — open/closed, today's session hours, upcoming schedule, monthly calendar, and live camera snapshots. Built specifically for people at or travelling to the track, where mobile networks are congested and data is limited.

---

## Data source

**Decision:** Use `https://nuerburgring.de/track_status` directly.

The official Nürburgring website uses a WebSocket at `wss://nuerburgring.de/cable` (Rails ActionCable) to push live flag/car-count data in real time. However:
- It requires a valid Rails session cookie + CSRF token — anonymous connections are rejected
- No public REST endpoints exist for flag state, car counts, or live conditions (`/flags`, `/live_data`, `/api/track` all 404)
- The official app is the only sanctioned consumer of WebSocket data

The `/track_status` JSON endpoint is public and gives us:
- Open / closed status per circuit (`opened: true/false`)
- Today's session time windows (`periods[].start`, `periods[].end`)
- Full year schedule for both Nordschleife and Grand Prix Circuit
- Special event labels (`message.en`)

**What we can't get publicly:** flag state (green/yellow/red), car counts, track conditions beyond scheduled open/closed. The 450+ camera + digital marshalling system feeds the official app — not a public API.

---

## Caching strategy

**Problem:** The track sits in a valley with notoriously congested mobile data during TF days. Every unnecessary network request makes the app slower for everyone.

**Solution:** Two layers.

### Layer 1 — `localStorage` (data cache)

On page load, cached data is rendered instantly. A background fetch then checks if the cache is stale:

| State | Stale threshold (TTL) |
|---|---|
| Track **open** | 30 seconds |
| Track **closed** | 20 minutes |

The open/closed state to pick the TTL comes from the cached data, so no network hit is needed to make that decision.

### Layer 2 — `setInterval` polling

After data loads, a poll timer reschedules itself based on the same open/closed logic. When the track is open, this is the mechanism that catches unexpected closures (weather, accidents) within ~30 seconds of the API updating.

`visibilitychange` fires a fresh `loadData()` when the user switches back to the tab, so stale data doesn't sit on screen after someone checks another app.

### Layer 3 — Service Worker (asset cache)

`sw.js` caches `index.html`, `style.css`, `app.js`, `manifest.json` after the first visit. From that point, the app shell loads with zero network requests — only the data fetch goes out.

> Note: Service Workers require HTTPS (or localhost). They don't activate on `file://`. This is expected — deploy to any web server and it activates automatically.

---

## Live track data when session is running

**Countdown timer:** When the track is open and a session end time is known from the API, each status card shows a live per-second countdown ("⏱ 2h 14m 37s remaining"). When it reaches zero, a forced data refresh fires to update the "Closed" state.

**Adaptive polling:** 30s when open, 30min when closed. Reschedules itself every time `applyData()` runs.

---

## Mobile-first performance decisions

These were deliberate tradeoffs to minimise payload and rendering cost for phones on congested networks:

| Removed | Replaced with | Reason |
|---|---|---|
| Google Fonts CDN | System font stack | Saves ~300ms DNS + download on first load |
| `backdrop-filter` | Plain dark backgrounds | GPU-intensive, causes jank on mid-range phones |
| Hero full-screen section | Compact 56px banner | Status cards visible immediately without scrolling |
| Animations (unconditional) | `prefers-reduced-motion` gate | Respects accessibility, saves repaints |
| Streaming webcam iframes | Opt-in static S3 JPEGs | Iframes are huge; user explicitly consents to ~400KB |

---

## Webcam section design

**Decision:** Completely hidden by default — no images load unless the user taps "Show Cameras".

**Reason:** At a packed track weekend, the page might be loaded by people on 1-bar 3G. Auto-loading 4 camera images (~400 KB) without consent would be rude. A button with an explicit data warning gives informed consent.

**Camera sources:** 4 lightweight static JPEG snapshots from the official Nürburgring S3 bucket, updated every 30 seconds. These are the same images the official site uses — no auth required from any HTTP host.

| Camera | URL |
|---|---|
| Nordschleife Entry | `s3nbrg01webcam.s3.eu-central-1.amazonaws.com/NOS/snap_c1.jpg` |
| Breidscheid | `s3nbrg01webcam.s3.eu-central-1.amazonaws.com/Breid/snap_c1.jpg` |
| Adenauer Forst | `s3nbrg01webcam.s3.eu-central-1.amazonaws.com/EckA/snap.jpg` |
| GP Start / Finish | `s3nbrg01webcam.s3.eu-central-1.amazonaws.com/Lindner/snap.jpg` |

Images are cache-busted with a timestamp parameter and auto-refresh every 30s while loaded. Unticking the button immediately removes all img elements from the DOM.

---

## Schedule & calendar design

**Decision:** No per-circuit tabs. All circuits merged into one chronological list; calendar shows dots per circuit per day.

**Reason:** Tabs require the user to know which track they care about before they can see the data. Most people just want to know "is anything open on Saturday?" The merged view answers that in one glance.

**Future-proofing:** Both `renderUpcoming()` and `renderCalendar()` iterate over `Object.keys(trackData)` to discover circuits. If the API ever adds a third track, it appears automatically with its own colour without any code change. `TRACK_META` provides human-readable names and colours for known keys, with a graceful prettify fallback for unknown ones.

---

## Hosting decision

**Decision:** Firebase Hosting (static files) + Cloud Run (API proxy).

**Why not a Compute VM:**
- Pay 24/7 even when no traffic
- You manage OS, updates, nginx, TLS renewal
- Minimum cost ~$7–15/month for a project that needs ~0 server-side compute
- Completely wrong tool for a static file server

**The real scaling problem — API fanout:**

Without a proxy, each user's browser hits `nuerburgring.de/track_status` directly. At 10,000 concurrent users with 30s polling when the track is open: ~333 requests/second to their server. This would likely trigger rate limiting or IP bans, silently breaking the app for all users.

**Solution:** A Cloud Run service acts as a caching proxy:
- Receives requests from all users
- Caches the nuerburgring.de response in memory (same TTL logic: 30s open, 20min closed)
- Forwards to nuerburgring.de at most once per TTL regardless of traffic
- Returns CORS headers so browsers can fetch it cross-origin

**Cost at scale:**

| Component | Cost |
|---|---|
| Firebase Hosting | $0 (free tier is ample for a 45KB static site) |
| Cloud Run proxy | $0 (2M requests/month free; ~$0.40/M after) |
| Domain | ~$12/year |

---

## What's still TODO

- [ ] Write the Cloud Run proxy service (`proxy/index.js`)
- [ ] Write `Dockerfile` for the proxy
- [ ] Write `firebase.json` deploy config
- [ ] Update `app.js` `API_URL` to point at the Cloud Run URL
- [ ] Deploy and verify Service Worker activates on HTTPS
- [ ] Set up custom domain
