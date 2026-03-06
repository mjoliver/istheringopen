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
const TTL_OPEN = 30 * 1000;
const TTL_CLOSED = 20 * 60 * 1000;
const PORT = process.env.PORT || 8080;

// In-memory cache — fine for a single-endpoint proxy.
// Multiple Cloud Run instances each get their own cache;
// worst case nuerburgring.de sees (instances × 1) req/TTL, not (users × 1).
let cache = { data: null, fetchedAt: 0, ttl: TTL_CLOSED };

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

    // Only serve the status endpoint
    if (req.url !== '/' && req.url !== '/track-status') {
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
        res.end(JSON.stringify(cache.data));
        return;
    }

    // Cache miss or stale — fetch upstream
    try {
        const data = await fetchUpstream();
        const ttl = isOpen(data) ? TTL_OPEN : TTL_CLOSED;
        cache = { data, fetchedAt: Date.now(), ttl };

        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${Math.round(ttl / 1000)}`,
            'X-Cache': 'MISS',
        });
        res.end(JSON.stringify(data));
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
