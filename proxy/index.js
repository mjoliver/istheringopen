/**
 * ring-proxy — Cloud Run caching proxy for nuerburgring.de/track_status
 *
 * Sits between users and the Nürburgring API so that 10,000 people polling
 * every 30 seconds only generates 1 upstream request per 30 seconds.
 *
 * Cache TTL:
 *   - Track open  → 30 seconds  (catch live closures fast)
 *   - Track closed → 20 minutes (data barely changes)
 */

const https = require('https');
const http = require('http');

const UPSTREAM = 'https://nuerburgring.de/track_status';

// Cache TTLs: much shorter when track is open so status changes surface fast
const TTL_LIVE = 30 * 1000;                // 30 s   — track is currently open
const TTL_ACTIVE_DAY = 10 * 60 * 1000;     // 10 min — track is closed, but opens later today
const TTL_OFF_NEAR = 1 * 60 * 60 * 1000;   // 1 hr   — track opens tomorrow
const TTL_OFF_MID = 12 * 60 * 60 * 1000;   // 12 hrs — track opens within a week
const TTL_OFF_DEEP = 24 * 60 * 60 * 1000;  // 24 hrs — deep off-season
const PORT = process.env.PORT || 8080;

// In-memory cache — fine for a single-endpoint proxy.
// Multiple Cloud Run instances each get their own cache;
// worst case nuerburgring.de sees (instances × 1) req/TTL, not (users × 1).
let cache = { data: null, fetchedAt: 0, ttl: TTL_OFF_DEEP };

function isOpen(data) {
    try {
        const tracks = Object.values(data);
        return tracks.some(t => t?.opened === true);
    } catch { return false; }
}

function fetchUpstream() {
    return new Promise((resolve, reject) => {
        https.get(UPSTREAM, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://nuerburgring.de/',
                'Origin': 'https://nuerburgring.de',
            }
        }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Bad JSON from upstream')); }
            });
        }).on('error', reject);
    });
}

function getTtl(data) {
    if (isOpen(data)) return TTL_LIVE;

    try {
        // Evaluate "today" in Europe/Berlin time
        const berlinNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
        const y = berlinNow.getFullYear();
        const m = berlinNow.getMonth() + 1;
        const d = berlinNow.getDate();
        const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        const tracks = Object.values(data);
        let daysUntilOpen = Infinity;
        let msUntilNextOpen = Infinity;

        // Find the absolute closest opening day across all tracks
        for (const track of tracks) {
            const sched = track?.year_schedule;
            if (!sched) continue;

            for (const [dateStr, raw] of Object.entries(sched)) {
                if (dateStr < todayStr) continue; // Past

                const isOpened = (raw.exclusion || raw).opened === true;
                if (!isOpened) continue;

                const diffTime = new Date(dateStr) - new Date(todayStr);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays < daysUntilOpen) {
                    daysUntilOpen = diffDays;
                }

                // If scheduled for today, check exact hours.
                // NOTE: Must unwrap `exclusion` the same way isOpened does above, because most
                // dates store their data under raw.exclusion rather than directly on raw.
                const todayEntry = raw.exclusion || raw;
                if (diffDays === 0 && todayEntry.periods) {
                    for (const p of todayEntry.periods) {
                        const [sh, sm] = p.start.split(':').map(Number);
                        const [eh, em] = p.end.split(':').map(Number);
                        const startDt = new Date(y, m - 1, d, sh, sm, 0);
                        const endDt = new Date(y, m - 1, d, eh, em, 0);

                        // Inside a scheduled session window but opened=false → temporary closure
                        // (crash / red flag / incident). Poll at 30s — this is exactly when
                        // the site matters most: people waiting to know if it'll reopen.
                        if (berlinNow >= startDt && berlinNow < endDt) {
                            return TTL_LIVE;
                        }

                        // Within 1 hour before a session starts → also 30s
                        if (startDt > berlinNow) {
                            const msUntil = startDt - berlinNow;
                            if (msUntil < msUntilNextOpen) msUntilNextOpen = msUntil;
                        }
                    }
                }
            }
        }

        if (daysUntilOpen === 0) {
            // If the track opens in less than 1 hour, switch to fast 30s polling
            // so we don't miss the exact moment it flips live!
            if (msUntilNextOpen <= 60 * 60 * 1000) {
                return TTL_LIVE;
            }
            return TTL_ACTIVE_DAY;
        }

        if (daysUntilOpen === 1) return TTL_OFF_NEAR; // 1 hour (Tomorrow)
        if (daysUntilOpen <= 7) return TTL_OFF_MID;   // 12 hours (Within a week)

        return TTL_OFF_DEEP; // 24 hours (Deep off-season)

    } catch (e) {
        // Fallback silently
        return TTL_OFF_NEAR;
    }
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS); res.end(); return;
    }

    // Health check for Cloud Run
    if (req.url === '/healthz') {
        res.writeHead(200); res.end('ok'); return;
    }

    // Image proxy for S3 webcams (Requires Referer: https://nuerburgring.de/)
    if (req.url.startsWith('/webcam/')) {
        const camMap = {
            'nos': 'https://s3nbrg01webcam.s3.eu-central-1.amazonaws.com/NOS/snap_c1.jpg',
            'breid': 'https://s3nbrg01webcam.s3.eu-central-1.amazonaws.com/Breid/snap_c1.jpg',
            'ecka': 'https://s3nbrg01webcam.s3.eu-central-1.amazonaws.com/EckA/snap.jpg'
        };
        const camId = req.url.split('/')[2];
        const targetUrl = camMap[camId];

        if (!targetUrl) {
            res.writeHead(404); res.end('Not found'); return;
        }

        https.get(targetUrl, { headers: { 'Referer': 'https://nuerburgring.de/' } }, proxyRes => {
            res.writeHead(proxyRes.statusCode || 200, {
                ...CORS_HEADERS,
                'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
                'Cache-Control': 'public, max-age=60' // Cache images for 60s
            });
            proxyRes.pipe(res);
        }).on('error', err => {
            console.error('Image proxy failed:', err.message);
            res.writeHead(500); res.end('Error proxying image');
        });
        return;
    }

    // Only serve the status endpoint
    if (req.url !== '/' && req.url !== '/track-status' && req.url !== '/api/track-status') {
        res.writeHead(404); res.end('Not found'); return;
    }

    const now = Date.now();
    const stale = now - cache.fetchedAt > cache.ttl;

    if (!stale && cache.data) {
        // Serve from cache
        const age = Math.round((now - cache.fetchedAt) / 1000);
        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${Math.round(cache.ttl / 1000)}`,
            'X-Cache': 'HIT',
            'X-Cache-Age': `${age}s`,
        });
        // Inject timestamp and TTL into data
        const outData = { ...cache.data, _proxyFetchedAt: cache.fetchedAt, _proxyTtl: cache.ttl };
        res.end(JSON.stringify(outData));
        return;
    }

    // Cache miss or stale — fetch upstream
    try {
        const data = await fetchUpstream();
        const ttl = getTtl(data);
        cache = { data, fetchedAt: Date.now(), ttl };

        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${Math.round(ttl / 1000)}`,
            'X-Cache': 'MISS',
        });
        // Inject timestamp and TTL into data
        const outData = { ...data, _proxyFetchedAt: cache.fetchedAt, _proxyTtl: ttl };
        res.end(JSON.stringify(outData));
    } catch (err) {
        console.error('Upstream fetch failed:', err.message);
        if (cache.data) {
            // Serve stale rather than error
            res.writeHead(200, {
                ...CORS_HEADERS,
                'Content-Type': 'application/json',
                'X-Cache': 'STALE',
            });
            res.end(JSON.stringify(cache.data));
        } else {
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Upstream unavailable' }));
        }
    }
});

server.listen(PORT, () => {
    console.log(`ring-proxy listening on :${PORT}`);
});
