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

## APK reverse-engineering investigation (dead end)

**What we tried:** Downloaded and decompiled three Android APKs — the official Nürburgring app (`nno.apk`), Greenhell, and Pacenotes — to look for undocumented endpoints that expose live flag state, car counts, or lap telemetry.

**Findings:**

| App | Transport | Auth | Result |
|---|---|---|---|
| Nürburgring official | WebSocket `wss://nuerburgring.de/cable` (Rails ActionCable) | Requires valid Rails session cookie + CSRF token obtained via login flow | Connection rejected without authenticated session |
| Pacenotes | Custom WebSocket-based protocol | API key baked into APK; session tokens rotate | Got data structure (`pacenotes_live.json`), but protocol is proprietary and the key/tokens expire |
| Greenhell | REST + WebSocket hybrid | Requires account + signed JWT | Account-gated; no anonymous access |

**Conclusion:** None of these are viable public data sources. The flag/car-count data is genuinely not publicly accessible:
- The official Nürburgring WebSocket requires an authenticated browser session — not an API key, so it can't be used server-side without scraping a full login flow (fragile, ToS violation risk).
- Third-party apps (Pacenotes, Greenhell) use proprietary protocols with rotating credentials. Even if we captured a session, it would expire within hours.
- There is no undocumented REST endpoint. We checked every path in the APK network calls — they all either 404 anonymously or require auth.

**What this means for the app:** We are permanently limited to `nuerburgring.de/track_status` for our data. The open/closed status and session schedule are the only signals we can reliably surface.

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
| Google Fonts CDN (full) | DM Sans subset via preconnect + `font-display:swap` | No render blocking; text shows instantly in system fallback then swaps. ~20KB, 1yr browser cache. |
| `backdrop-filter` | Plain dark backgrounds | GPU-intensive, causes jank on mid-range phones |
| Hero full-screen section | Compact 56px banner | Status cards visible immediately without scrolling |
| Animations (unconditional) | `prefers-reduced-motion` gate | Respects accessibility, saves repaints |
| Streaming webcam iframes | Opt-in static S3 JPEGs | Iframes are huge; user explicitly consents to ~400KB |

---

## Webcam section design

**Decision:** Completely hidden by default — no images load unless the user taps a camera button.

**Reason:** At a packed track weekend, the page might be loaded by people on 1-bar 3G. Auto-loading camera images without consent would be rude. A button with an explicit data warning gives informed consent.

**Camera sources:** 3 Panomax 360° snapshot JPEGs from the cameras the official Nürburgring site embeds. Each is ~100–150 KB. No auth or Referer required — loaded directly by the browser.

| Camera | Panomax ID | URL |
|---|---|---|
| TF Entrance | 2527 | `live-image.panomax.com/cams/2527/recent_reduced.jpg` |
| GP Track | 11220 | `live-image.panomax.com/cams/11220/recent_reduced.jpg` |
| Eifeldorf / Lindner | 2835 | `live-image.panomax.com/cams/2835/recent_reduced.jpg` |

> **Note:** The official Nürburgring site labels cams/2527 as "Webcam Grand-Prix Track" but its own player metadata says "Zufahrt Nordschleife" — it is the TF Entrance. Cams/11220 is the actual GP track overview.

> **Note:** The previous S3 bucket URLs (`s3nbrg01webcam.s3.eu-central-1.amazonaws.com`) returned 403 Forbidden as of March 2026 — the bucket ACL was tightened. BridgeToGantry.com confirmed the same. The S3 proxy route has been removed from the Cloud Run proxy.

Images are cache-busted with a timestamp parameter and auto-refresh every 30s while loaded.

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

## Status

### Completed
- [x] Cloud Run proxy (`proxy/index.js` + `Dockerfile`)
- [x] Firebase Hosting config (`firebase.json`)
- [x] `app.js` `API_URL` pointing at Cloud Run proxy (with CORS headers)
- [x] GitHub Actions CI/CD (auto-deploy on push to `main`) — required IAM grants for firebase-adminsdk-fbsvc, gcp-sa-firebase agent, github-action SA, and compute SA (see DEPLOY.md)
- [x] Domain purchased: `istheringopen.com`
- [x] `.git/` and `webcam_page.html` excluded from Firebase Hosting deploy

### Remaining
- [ ] **Custom domain** — connect `istheringopen.com` in Firebase console, add DNS records in Cloudflare
- [ ] **Verify Service Worker** — check it activates and shows in DevTools Application tab once HTTPS is confirmed
- [ ] **Billing alert** — set $5/month alert in GCP console (see DEPLOY.md)
