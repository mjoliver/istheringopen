# Deployment Guide — istheringopen.com

Two services to deploy: the static frontend (Firebase Hosting) and the API proxy (Cloud Run).  
Both are on Google Cloud. Total cost: ~$0/month.

---

## Prerequisites

Install these once if you haven't already:

```bash
# Google Cloud SDK
https://cloud.google.com/sdk/docs/install

# Firebase CLI
npm install -g firebase-tools

# Docker Desktop (for building the proxy image)
https://www.docker.com/products/docker-desktop
```

---

## Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project, e.g. `istheringopen`
3. Note your **Project ID** (e.g. `istheringopen-12345`)
4. Enable billing (required for Cloud Run — but it stays in the free tier)

Enable the required APIs:
```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

---

## Step 2 — Deploy the Cloud Run proxy

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Build and push the container image
cd proxy
gcloud builds submit --tag europe-west3-docker.pkg.dev/YOUR_PROJECT_ID/ring/ring-proxy

# Deploy to Cloud Run (Frankfurt — closest to the Nürburgring)
gcloud run deploy ring-proxy \
  --image europe-west3-docker.pkg.dev/YOUR_PROJECT_ID/ring/ring-proxy \
  --region europe-west3 \
  --platform managed \
  --allow-unauthenticated \
  --memory 128Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --port 8080
```

> **Note the Cloud Run URL** — it will look like  
> `https://ring-proxy-xxxxxxxx-ey.a.run.app`  
> You don't need to put it in the app — Firebase routing handles it automatically.

**Test the proxy:**
```bash
curl https://ring-proxy-xxxxxxxx-ey.a.run.app/
# Should return the nuerburgring.de JSON with X-Cache: MISS on first hit, HIT after
```

---

## Step 3 — Set up Firebase

```bash
# Log in to Firebase
firebase login

# Initialise (from the project root, not /proxy)
cd ..
firebase init hosting
```

When prompted:
- **Project:** select your Google Cloud project
- **Public directory:** `.` (dot — the current directory)
- **Single-page app rewrites:** `No`
- **Overwrite index.html:** `No`

Then update `.firebaserc` with your real project ID:
```json
{
  "projects": {
    "default": "istheringopen-12345"
  }
}
```

---

## Step 4 — Link the proxy to Firebase Hosting

Open `firebase.json`. The rewrite is already configured:
```json
"rewrites": [
  {
    "source": "/api/track-status",
    "run": { "serviceId": "ring-proxy", "region": "europe-west3" }
  }
]
```

This means `https://istheringopen.com/api/track-status` routes to your Cloud Run service — same origin, no CORS needed.

---

## Step 5 — Deploy the frontend

```bash
firebase deploy --only hosting
```

Your site is now live at `https://YOUR_PROJECT_ID.web.app`.

---

## Step 6 — Connect your domain

In the Firebase console:

1. Go to **Hosting → Add custom domain**
2. Enter `istheringopen.com`
3. Firebase gives you two `A` records and a `TXT` record for verification

In **Cloudflare** (where your domain is registered):
1. Add the `TXT` record Firebase gives you (for ownership verification)
2. Add the two `A` records pointing to Firebase
3. Set the Cloudflare proxy status to **DNS only** (grey cloud, not orange) for the root domain — Firebase manages its own SSL

Firebase auto-provisions an SSL certificate. Takes 5–30 minutes to propagate.

**Also add `www` as a redirect:**  
In Cloudflare, add a `CNAME www → istheringopen.com` and Firebase will serve the same site.

---

## Step 7 — Verify everything works

```bash
# Check the proxy via your domain
curl https://istheringopen.com/api/track-status
# Should return JSON with X-Cache header

# Check the site
open https://istheringopen.com
```

The Service Worker will now activate (requires HTTPS), caching the app shell for offline use.

---

## Updating the site

```bash
# Frontend changes
firebase deploy --only hosting

# Proxy changes
cd proxy
gcloud builds submit --tag europe-west3-docker.pkg.dev/YOUR_PROJECT_ID/ring/ring-proxy
gcloud run deploy ring-proxy --image europe-west3-docker.pkg.dev/YOUR_PROJECT_ID/ring/ring-proxy --region europe-west3
```

---

## Cost monitoring & protection

GCP doesn't have a hard spending cap, but you can set billing alerts that email you before costs get out of hand.

### Set a billing alert (do this right after creating your project)

1. Go to **[console.cloud.google.com/billing](https://console.cloud.google.com/billing)**
2. Select your billing account → **Budgets & alerts → Create budget**
3. Set amount: **$5/month**
4. Set alerts at: **50%, 90%, 100%**
5. Add your email → **Save**

You'll get an email if spend approaches $5. For this project, it should never trigger.

### What actually costs money

| Service | Free tier | What happens after |
|---|---|---|
| Firebase Hosting | 10 GB storage, 360 MB/day egress | ~$0.026/GB — negligible |
| Cloud Run requests | 2M requests/month | $0.40 per million |
| Cloud Run compute | 360,000 GB-seconds/month | $0.00002/GB-second |
| Cloud Build (proxy deploys) | 120 min/day | $0.003/min |

### Built-in Cloud Run cost cap

The deploy command already includes `--max-instances 10`. Each instance handles ~80 concurrent requests, so this caps you at ~800 simultaneous users before Cloud Run starts queuing requests rather than scaling. At 10 instances running flat-out 24/7 (worst possible case, never happens): ~$4/month. In practice it'll be $0.

To change the cap later:
```bash
gcloud run services update ring-proxy --max-instances 5 --region europe-west3
```

---

## Cost estimate at scale

Cloud Run pricing reference:
- First **2 million requests/month** free
- First **360,000 GB-seconds** of memory free
- The proxy uses 128 MB and handles requests in <100ms → effectively free indefinitely
