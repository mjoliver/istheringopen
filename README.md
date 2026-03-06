# Is The Ring Open? 🏁🏎️

[![Live Site](https://img.shields.io/badge/Live-istheringopen.com-red.svg)](https://istheringopen.com)
[![Firebase Deploy](https://github.com/mjoliver/istheringopen/actions/workflows/firebase-hosting-merge.yml/badge.svg)](https://github.com/mjoliver/istheringopen/actions/workflows/firebase-hosting-merge.yml)

A lightning-fast, mobile-first web app for checking the live status of the Nürburgring Nordschleife and Grand Prix Circuit. Built specifically to work flawlessly on unreliable, congested trackside mobile networks in the Eifel.

<p align="center">
  <img src="docs/preview.png" alt="Is The Ring Open? - App Walkthrough" width="350">
</p>

## The Problem

When the track is closed for a cleanup, it's a guessing game. You're sat with one bar of signal, trying to predict exactly when the barriers will lift. Get the timing right, and you're first out on a clear track; get it wrong, and you're buried in the access queue, destined for a lap full of traffic and frustration.

## The Solution

This app answers that single question instantly. 

- **Instant Load**: The entire app shell is cached locally on your device via a Service Worker.
- **Micro-Payloads**: It fetches live data straight from a highly-optimised edge proxy, returning only bytes of data.
- **Adaptive Caching**: Background polling automatically adjusts based on track schedules (every 30s when live, every 10m on active days, and paused completely off-season).
- **No bloat**: Pure HTML, CSS, and JS. No massive frameworks, no ads, no trackers. *Just the answer.*

## Architecture

To ensure it scales for thousands of users simultaneously without overwhelming the official Nürburgring API, the project uses a custom two-part serverless architecture:

1.  **Frontend (Firebase Hosting):** 
    *   Serves the static assets via Google's global CDN.
    *   Uses a Service Worker for aggressive offline caching.
    *   Custom `DM Sans` font subsetted and preloaded for immediate rendering.

2.  **API Proxy (Google Cloud Run):**
    *   A Node.js edge proxy that sits between the users and `nuerburgring.de`.
    *   If 10,000 people open the app at exactly the same time, the proxy absorbs the load and only hits the official Nürburgring API **once per 30 seconds**.
    *   Automatically spoofs headers to securely fetch protected endpoints without triggering Cloudflare blocks.

## Local Development

You don't need to run the proxy to develop the frontend locally — the `app.js` file handles the fallback logic gracefully.

1. Clone the repository.
2. Start any local web server in the project directory:

```bash
python -m http.server 3000
```

3. Visit `http://localhost:3000`.

## License & Data Sourcing

This is a free, open-source community resource built by and for motorsport fans. 

* The track schedule, live data, and webcam snapshots remain the property of **Nürburgring 1927 GmbH & Co. KG**. 
* This project is completely independent and is not affiliated with the official Nürburgring organisation.
