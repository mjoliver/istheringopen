/* =====================================================
   Nürburgring Track Status App
   ===================================================== */

// Primary: Cloud Run proxy in Frankfurt (caches all users into 1 req/30s max)
// Fallbacks used if proxy is unreachable
const API_URL = 'https://ring-proxy-765054426821.europe-west3.run.app';
const DIRECT_URL = 'https://nuerburgring.de/track_status';
const PROXY_URL = `https://corsproxy.io/?url=${encodeURIComponent(DIRECT_URL)}`;
const CACHE_KEY = 'nring_track_data';

// Cache TTLs: much shorter when track is open so status changes surface fast
const TTL_LIVE = 30 * 1000;         // 30 s  — while a session is running
const TTL_ACTIVE_DAY = 10 * 60 * 1000;    // 10 min — track opens later today
const TTL_OFF_DAY = 12 * 60 * 60 * 1000; // 12 hours — off-season / no session today

// State
let trackData = null;
let currentCalMonth = null;
let countdownTimer = null;   // setInterval handle for countdown
let pollTimer = null;   // setInterval handle for data refresh
let webcamTimer = null;   // setInterval handle for webcam refresh
let webcamsLoaded = false;

// Human-readable names for known track keys (fallback: prettify key)
const TRACK_META = {
    nordschleife: { label: 'Nordschleife', short: 'Nord', color: 'var(--green)' },
    ring_kartbahn: { label: 'Grand Prix Circuit', short: 'GP', color: '#60a5fa' },
};

function trackLabel(key) {
    return TRACK_META[key]?.label ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function trackShort(key) {
    return TRACK_META[key]?.short ?? key.slice(0, 4).toUpperCase();
}
function trackColor(key) {
    return TRACK_META[key]?.color ?? 'var(--amber)';
}

// -------- Webcams --------

const WEBCAMS = [
    { label: 'Nordschleife Entry', url: `${API_URL}/webcam/nos` },
    { label: 'Breidscheid', url: `${API_URL}/webcam/breid` },
    { label: 'Adenauer Forst', url: `${API_URL}/webcam/ecka` },
    { label: 'GP Start / Finish', url: 'https://live-image.panomax.com/cams/2527/recent_reduced.jpg' },
];

function toggleWebcams(btn) {
    const isLoading = btn.classList.toggle('active');
    const grid = document.getElementById('webcam-grid');

    if (!isLoading) {
        // Unload
        clearInterval(webcamTimer);
        webcamTimer = null;
        grid.innerHTML = '';
        webcamsLoaded = false;
        btn.innerHTML = 'Show Cameras';
        return;
    }

    // Load
    btn.innerHTML = 'Hide Cameras';
    webcamsLoaded = true;
    renderWebcams();
    webcamTimer = setInterval(renderWebcams, 30_000);
}

function renderWebcams() {
    const grid = document.getElementById('webcam-grid');
    const ts = Date.now(); // cache-bust so browsers re-fetch
    grid.innerHTML = WEBCAMS.map(cam => `
    <div class="webcam-card">
      <img
        src="${cam.url}?t=${ts}"
        alt="${cam.label}"
        class="webcam-img"
        loading="lazy"
        onerror="this.parentElement.classList.add('cam-error')"
      >
      <div class="webcam-label">${cam.label}</div>
    </div>
  `).join('');
}

// -------- Cache --------

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const { data, fetchedAt } = JSON.parse(raw);
        return { data, fetchedAt, age: Date.now() - fetchedAt };
    } catch { return null; }
}

function writeCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }));
    } catch { }
}

function formatAge(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
}

// -------- Helpers --------

function today() { return new Date().toISOString().split('T')[0]; }

function fmtDate(ds) {
    const d = new Date(ds + 'T00:00:00');
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { day: d.getDate(), month: MONTHS[d.getMonth()], weekday: DAYS[d.getDay()] };
}

function calcDuration(start, end) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) return '';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function getDayData(track, ds) {
    const raw = track?.year_schedule?.[ds];
    if (!raw) return null;
    const src = raw.exclusion || raw;
    return { opened: src.opened, periods: src.periods || [], message: src.message || {}, status: src.status };
}

function findNextOpen(track, fromDate) {
    const sched = track?.year_schedule;
    if (!sched) return null;
    for (const d of Object.keys(sched).sort()) {
        if (d <= fromDate) continue;
        if (getDayData(track, d)?.opened) return d;
    }
    return null;
}

// -------- Countdown --------

/** Return seconds remaining until sessionEnd (HH:MM string, today). */
function secsUntilEnd(endTime) {
    const now = new Date();
    const [eh, em] = endTime.split(':').map(Number);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0);
    return Math.floor((end - now) / 1000);
}

function fmtCountdown(secs) {
    if (secs <= 0) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m remaining`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s remaining`;
    return `${s}s remaining`;
}

function startCountdowns() {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdowns, 1000);
    tickCountdowns();
}

function tickCountdowns() {
    for (const [id, trackKey] of [['countdown-nordschleife', 'nordschleife'], ['countdown-gp', 'ring_kartbahn']]) {
        const el = document.getElementById(id);
        if (!el) continue;
        const t = today();
        const info = trackData && getDayData(trackData[trackKey], t);
        if (!info?.opened || !info.periods?.length) { el.textContent = ''; continue; }

        const lastPeriod = info.periods[info.periods.length - 1];
        const secs = secsUntilEnd(lastPeriod.end);
        if (secs <= 0) {
            el.textContent = '🏁 Session ended';
            // Trigger a refresh — track might have updated its "opened" state
            loadData(true);
            return;
        }
        el.textContent = '⏱ ' + fmtCountdown(secs);
    }
}

// -------- Polling --------

function isLive(data) {
    if (!data) return false;
    return !!(data.nordschleife?.opened || data.ring_kartbahn?.opened);
}

/** Schedule the next data poll based on whether any track is currently open. */
function schedulePoll() {
    clearInterval(pollTimer);
    if (!trackData) return;

    const live = isLive(trackData);
    const t = today();
    const scheduledToday = getDayData(trackData.nordschleife, t)?.opened || getDayData(trackData.ring_kartbahn, t)?.opened;

    // When live: poll every 30s to catch live closures fast
    // When active day: poll every 10 minutes to catch unexpected early openings
    // When off-day: no background polling needed, relies on tab visibility logic
    if (live) {
        pollTimer = setInterval(() => loadData(true), TTL_LIVE);
    } else if (scheduledToday) {
        pollTimer = setInterval(() => loadData(true), TTL_ACTIVE_DAY);
    }
}

// -------- Render --------

function renderStatus(data, fetchedAt) {
    const t = today();
    const now = new Date();
    document.getElementById('status-date').textContent = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const age = Date.now() - fetchedAt;
    const isCached = age > 5000;
    const statusEl = document.getElementById('last-updated');
    statusEl.innerHTML = isCached
        ? `<span class="cache-badge">📦 Cached</span> ${formatAge(age)}`
        : `<span class="cache-badge live">🟢 Live</span> ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

    renderTrackStatus('nordschleife', data.nordschleife, t);
    renderTrackStatus('gp', data.ring_kartbahn, t);

    const anyOpen = getDayData(data.nordschleife, t)?.opened || getDayData(data.ring_kartbahn, t)?.opened;
    document.getElementById('live-dot').classList.toggle('active', Boolean(anyOpen));

    if (anyOpen) startCountdowns();
    else {
        clearInterval(countdownTimer);
        document.getElementById('countdown-nordschleife').textContent = '';
        document.getElementById('countdown-gp').textContent = '';
    }
}

function renderTrackStatus(id, track, ds) {
    const info = getDayData(track, ds);
    const badge = document.getElementById(`badge-${id}`);
    const hours = document.getElementById(`hours-${id}`);
    const event = document.getElementById(`event-${id}`);
    const next = document.getElementById(`next-${id}`);
    const card = document.getElementById(`card-${id === 'nordschleife' ? 'nordschleife' : 'gp'}`);
    const isOpen = Boolean(info?.opened);

    badge.className = `status-badge ${isOpen ? 'open' : 'closed'}`;
    badge.querySelector('.badge-text').textContent = isOpen ? 'Open' : 'Closed';
    card.classList.remove('is-open', 'is-closed');
    card.classList.add(isOpen ? 'is-open' : 'is-closed');

    if (isOpen && info.periods?.length) {
        hours.innerHTML = info.periods.map(p => `
      <div class="hours-row">
        <span>${p.start}</span><span class="hours-sep">–</span><span>${p.end}</span>
      </div>
      <div class="hours-label">Today's open hours &nbsp;·&nbsp; ${calcDuration(p.start, p.end)}</div>
    `).join('');
    } else {
        hours.innerHTML = `<div class="hours-row" style="color:var(--muted);font-size:1.1rem;font-weight:500;">Not open today</div>`;
    }

    const msg = info?.message?.en;
    event.textContent = msg || '';

    const nextDate = findNextOpen(track, ds);
    if (nextDate) {
        const d = fmtDate(nextDate);
        const h = getDayData(track, nextDate)?.periods?.[0];
        const hStr = h ? ` &nbsp;·&nbsp; ${h.start}–${h.end}` : '';
        next.innerHTML = `Next open: <strong>${d.weekday} ${d.day} ${d.month}${hStr}</strong>`;
    } else {
        next.textContent = isOpen ? 'Open today!' : 'No upcoming dates found';
    }
}

// -------- Upcoming Schedule (all circuits merged) --------

function renderUpcoming() {
    const list = document.getElementById('upcoming-list');
    if (!trackData) return;

    // Discover all track keys dynamically from the API response
    const trackKeys = Object.keys(trackData).filter(k => trackData[k]?.year_schedule);

    const t = today();
    const cutoff = new Date(t); cutoff.setDate(cutoff.getDate() + 30);

    // Build a date-keyed map: { 'YYYY-MM-DD': [{key, info}, ...] }
    const byDate = {};
    for (const key of trackKeys) {
        const sched = trackData[key].year_schedule || {};
        for (const d of Object.keys(sched).sort()) {
            const dObj = new Date(d + 'T00:00:00');
            if (dObj <= new Date(t) || dObj > cutoff) continue;
            const info = getDayData(trackData[key], d);
            if (!info?.opened) continue;
            if (!byDate[d]) byDate[d] = [];
            byDate[d].push({ key, info });
        }
    }

    const dates = Object.keys(byDate).sort();
    if (!dates.length) {
        list.innerHTML = `<p style="color:var(--muted);padding:40px 0;text-align:center;">No open days in the next 30 days.</p>`;
        return;
    }

    list.innerHTML = dates.map((d, i) => {
        const fd = fmtDate(d);
        const tracks = byDate[d];
        const rows = tracks.map(({ key, info }) => {
            const all = info.periods.map(p => `${p.start}–${p.end}`).join(', ');
            const dur = info.periods[0] ? calcDuration(info.periods[0].start, info.periods[0].end) : '';
            const msg = info.message?.en || '';
            const color = trackColor(key);
            return `
        <div class="upcoming-track-row">
          <span class="upcoming-track-badge" style="background:${color}22;color:${color};border-color:${color}44">${trackShort(key)}</span>
          <span class="upcoming-hours" style="font-size:0.88rem">${all || 'Open'}</span>
          ${msg ? `<span class="upcoming-event-tag" style="font-size:0.66rem">${msg}</span>` : ''}
          ${dur ? `<span class="upcoming-dur-inline">${dur}</span>` : ''}
        </div>`;
        }).join('');

        return `
      <div class="upcoming-item" style="animation-delay:${i * 0.035}s">
        <div class="upcoming-date-block">
          <div class="upcoming-day">${fd.day}</div>
          <div class="upcoming-month">${fd.month}</div>
          <div class="upcoming-weekday">${fd.weekday}</div>
        </div>
        <div class="upcoming-tracks">${rows}</div>
      </div>`;
    }).join('');
}

// -------- Calendar (all circuits) --------

function renderCalendar(year, month) {
    if (!trackData) return;

    const trackKeys = Object.keys(trackData).filter(k => trackData[k]?.year_schedule);
    const t = today();
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    document.getElementById('cal-month-label').textContent = `${MONTHS[month]} ${year}`;

    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => {
        const el = document.createElement('div');
        el.className = 'cal-header'; el.textContent = d; grid.appendChild(el);
    });

    let off = new Date(year, month, 1).getDay() - 1;
    if (off < 0) off = 6;
    for (let i = 0; i < off; i++) {
        const el = document.createElement('div'); el.className = 'cal-day empty'; grid.appendChild(el);
    }

    const days = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
        const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const el = document.createElement('div');

        // Collect status per track
        const openTracks = [];
        const eventTracks = [];
        let tooltipParts = [];

        for (const key of trackKeys) {
            const info = getDayData(trackData[key], ds);
            if (!info?.opened) continue;
            const msg = info.message?.en || '';
            if (msg) eventTracks.push(key); else openTracks.push(key);
            const p = info.periods?.[0];
            if (p) tooltipParts.push(`${trackShort(key)}: ${p.start}–${p.end}${msg ? ' (' + msg + ')' : ''}`);
        }

        const hasAny = openTracks.length + eventTracks.length > 0;
        const hasEvent = eventTracks.length > 0;
        let cls = 'cal-day';
        if (!hasAny) cls += ' closed';
        else if (hasEvent) cls += ' event';
        else cls += ' open';
        if (ds === t) cls += ' today';

        el.className = cls;
        if (tooltipParts.length) el.setAttribute('data-tooltip', tooltipParts.join(' | '));

        // Build dots — one per open track
        const dots = [...openTracks, ...eventTracks].map(k =>
            `<span class="cal-track-dot" style="background:${trackColor(k)}"></span>`
        ).join('');

        el.innerHTML = `<span class="cal-day-num">${d}</span>${dots ? `<span class="cal-dots">${dots}</span>` : ''}`;
        grid.appendChild(el);
    }

    // Update legend dynamically from actual tracks
    const legend = document.querySelector('.calendar-legend');
    if (legend) {
        const extra = trackKeys.map(k => `
      <span class="legend-item">
        <span class="legend-dot" style="background:${trackColor(k)}55;border:1px solid ${trackColor(k)}"></span>
        ${trackLabel(k)}
      </span>`).join('');
        legend.innerHTML = extra +
            `<span class="legend-item"><span class="legend-dot" style="background:rgba(245,158,11,0.4);border:1px solid var(--amber)"></span>Event</span>` +
            `<span class="legend-item"><span class="legend-dot closed"></span>Closed</span>`;
    }
}

function changeMonth(delta) {
    currentCalMonth.setMonth(currentCalMonth.getMonth() + delta);
    renderCalendar(currentCalMonth.getFullYear(), currentCalMonth.getMonth());
}

// -------- Data fetch + cache --------

async function fetchFresh() {
    for (const url of [API_URL, DIRECT_URL, PROXY_URL]) {
        try {
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!res.ok) continue;
            const data = await res.json();
            writeCache(data);
            return { data, fetchedAt: Date.now() };
        } catch { }
    }
    return null;
}

function applyData(data, fetchedAt) {
    trackData = data;
    renderStatus(data, fetchedAt);
    renderUpcoming();   // no tab argument — all circuits
    const d = new Date();
    if (!currentCalMonth) currentCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCalendar(currentCalMonth.getFullYear(), currentCalMonth.getMonth());
    schedulePoll();
}

function showError(hasCached) {
    const el = document.getElementById('last-updated');
    el.innerHTML = hasCached
        ? `<span class="cache-badge stale">⚠️ Offline</span> cached data`
        : `<span class="cache-badge stale">⚠️ No data</span>`;
}

async function loadData(force = false) {
    const cached = readCache();
    const t = today();

    // Determine the appropriate cache TTL
    const live = cached?.data && (cached.data.nordschleife?.opened || cached.data.ring_kartbahn?.opened);
    const scheduledToday = cached?.data && (
        getDayData(cached.data.nordschleife, t)?.opened ||
        getDayData(cached.data.ring_kartbahn, t)?.opened
    );
    let ttl = TTL_OFF_DAY;
    if (live) ttl = TTL_LIVE;
    else if (scheduledToday) ttl = TTL_ACTIVE_DAY;

    if (cached && !force) {
        applyData(cached.data, cached.fetchedAt);
        if (cached.age > ttl) {
            // Background refresh
            fetchFresh().then(fresh => {
                if (fresh) applyData(fresh.data, fresh.fetchedAt);
                // On off-days, allow stale data indefinitely instead of forcing an error
                else if (cached.age > TTL_OFF_DAY) showError(true);
            });
        }
        return;
    }

    const fresh = await fetchFresh();
    if (fresh) applyData(fresh.data, fresh.fetchedAt);
    else if (cached) { applyData(cached.data, cached.fetchedAt); showError(true); }
    else showError(false);
}

// -------- Service Worker --------
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => { })
        .catch(() => { });
}

// -------- Nav --------
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
        const href = link.getAttribute('href');
        if (href.startsWith('#')) {
            e.preventDefault();
            document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
        }
    });
});

// Refresh when returning to tab
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadData();
});

// -------- Init --------
loadData();
