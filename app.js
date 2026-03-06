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
const TTL_LIVE = 30 * 1000;              // 30 s  — while a session is running
const TTL_ACTIVE_DAY = 10 * 60 * 1000;  // 10 min — track opens later today
const TTL_OFF_NEAR = 60 * 60 * 1000;    // 1 hr  — track opens tomorrow
const TTL_OFF_MID = 12 * 60 * 60 * 1000;// 12 hr  — track opens within a week
const TTL_OFF_DAY = 24 * 60 * 60 * 1000;// 24 hrs — deep off-season

// State
let trackData = null;
let currentCalMonth = null;
let countdownTimer = null;
let showFullUpcoming = false;
let pollTimer = null;
let uiTimer = null;
let lastFetchedAt = 0;
let webcamTimer = null;
let webcamsLoaded = false;
let notificationsEnabled = localStorage.getItem('nring_notifications') === 'true';
let lastStatusOpen = null;

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
    { id: 'cam-nos', label: 'Nordschleife Entry', url: `${API_URL}/webcam/nos` },
    { id: 'cam-breid', label: 'Breidscheid', url: `${API_URL}/webcam/breid` },
    { id: 'cam-ecka', label: 'Adenauer Forst', url: `${API_URL}/webcam/ecka` },
    { id: 'cam-gp', label: 'GP Track', url: 'https://live-image.panomax.com/cams/2527/recent_reduced.jpg' },
];

let activeWebcams = new Set();

function initWebcams() {
    const container = document.getElementById('webcam-toggles');
    if (!container) return;

    let html = WEBCAMS.map(cam => `
        <button class="tab-btn" id="btn-${cam.id}" onclick="toggleWebcam('${cam.id}')">
            ${cam.label}
        </button>
    `).join('');

    html += `
        <button class="tab-btn" id="btn-all-cams" onclick="toggleAllWebcams()" style="margin-left: auto; border-color: var(--accent); color: var(--accent); background: transparent;">
            Show All
        </button>
    `;
    container.innerHTML = html;
}

function updateWebcamTimer() {
    if (activeWebcams.size > 0 && !webcamTimer) {
        webcamTimer = setInterval(renderWebcams, 30_000);
    } else if (activeWebcams.size === 0 && webcamTimer) {
        clearInterval(webcamTimer);
        webcamTimer = null;
    }
}

function toggleWebcam(id) {
    const btn = document.getElementById(`btn-${id}`);
    if (!btn) return;
    const isActive = btn.classList.toggle('active');

    if (isActive) activeWebcams.add(id);
    else activeWebcams.delete(id);

    const btnAll = document.getElementById('btn-all-cams');
    if (btnAll) {
        if (activeWebcams.size === WEBCAMS.length) {
            btnAll.textContent = 'Hide All';
            btnAll.classList.add('active');
            btnAll.style.color = 'var(--accent)';
            btnAll.style.background = 'transparent';
        } else {
            btnAll.textContent = 'Show All';
            btnAll.classList.remove('active');
            btnAll.style.color = 'var(--accent)';
            btnAll.style.background = 'transparent';
        }
    }

    updateWebcamTimer();
    renderWebcams();
}

function toggleAllWebcams() {
    const btnAll = document.getElementById('btn-all-cams');
    if (!btnAll) return;

    const allActive = activeWebcams.size === WEBCAMS.length;

    if (allActive) {
        // Hide all
        activeWebcams.clear();
        WEBCAMS.forEach(cam => {
            const btn = document.getElementById(`btn-${cam.id}`);
            if (btn) btn.classList.remove('active');
        });
        btnAll.textContent = 'Show All';
        btnAll.classList.remove('active');
        btnAll.style.color = 'var(--accent)';
        btnAll.style.background = 'transparent';
    } else {
        // Show all
        WEBCAMS.forEach(cam => {
            activeWebcams.add(cam.id);
            const btn = document.getElementById(`btn-${cam.id}`);
            if (btn) btn.classList.add('active');
        });
        btnAll.textContent = 'Hide All';
        btnAll.classList.add('active');
        btnAll.style.color = 'var(--accent)';
        btnAll.style.background = 'transparent';
    }

    updateWebcamTimer();
    renderWebcams();
}

function renderWebcams() {
    const grid = document.getElementById('webcam-grid');
    if (!grid) return;

    if (activeWebcams.size === 0) {
        grid.innerHTML = '';
        return;
    }

    const ts = Date.now(); // cache-bust so browsers re-fetch
    const activeCams = WEBCAMS.filter(cam => activeWebcams.has(cam.id));
    grid.innerHTML = activeCams.map(cam => `
    <div class="webcam-card">
        <div class="webcam-header">${cam.label}</div>
        <img src="${cam.url}?t=${ts}" class="webcam-img" alt="${cam.label}" loading="lazy" 
             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22%3E%3Crect width=%22400%22 height=%22300%22 fill=%22%23222%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23666%22 font-family=%22sans-serif%22 font-size=%2214%22%3EUnavailable%3C/text%3E%3C/svg%3E'">
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

function writeCache(data, fetchedAt) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt }));
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

// Use Berlin time for date comparisons (track is in Germany)
function today() {
    const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    return `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}-${String(tzDate.getDate()).padStart(2, '0')}`;
}

// Mirror the proxy's TTL logic: find how many days until the next open day
function getMinDaysUntilOpen(data) {
    if (!data) return Infinity;
    const t = today();
    let min = Infinity;
    for (const track of Object.values(data)) {
        const sched = track?.year_schedule;
        if (!sched) continue;
        for (const [ds, raw] of Object.entries(sched)) {
            if (ds <= t) continue;
            const opened = (raw.exclusion || raw).opened === true;
            if (!opened) continue;
            const diff = Math.ceil((new Date(ds) - new Date(t)) / 86400000);
            if (diff < min) min = diff;
        }
    }
    return min;
}

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

let nextPollTime = null;

function updateRefreshUI() {
    const el = document.getElementById('refresh-text');
    if (!el) return;

    if (!nextPollTime) {
        el.textContent = ' • Track Closed Today';
        return;
    }

    const diff = Math.max(0, Math.ceil((nextPollTime - Date.now()) / 1000));
    if (diff === 0) {
        el.textContent = ' • Refreshing...';
        return;
    }

    let refreshStr = '';
    if (diff > 3600) {
        refreshStr = `${Math.ceil(diff / 3600)}h`;
    } else if (diff > 60) {
        refreshStr = `${Math.ceil(diff / 60)}m`;
    } else {
        refreshStr = `${diff}s`;
    }

    const ageMs = Date.now() - lastFetchedAt;
    const ageStr = lastFetchedAt ? formatAge(ageMs) : '...';

    const t = today();
    const scheduledToday = trackData && (getDayData(trackData.nordschleife, t)?.opened || getDayData(trackData.ring_kartbahn, t)?.opened);
    const isLiveNow = isLive(trackData);

    let mode;
    if (isLiveNow) mode = 'Live';
    else if (scheduledToday) mode = 'Scheduled today';
    else mode = 'Standby';

    const isMobile = window.innerWidth < 480;
    if (isMobile) {
        el.textContent = `(${ageStr}) \u2022 Next ${refreshStr}`;
    } else {
        el.textContent = `Data ${ageStr} \u2022 Next check in ${refreshStr} (${mode})`;
    }
}

// -------- Trackside Alerts (Notifications) --------

async function toggleNotifications() {
    // 1. If we are turning them OFF, just do it. No permission check needed.
    if (notificationsEnabled) {
        notificationsEnabled = false;
        localStorage.setItem('nring_notifications', 'false');
        updateNotifyUI();
        return;
    }

    // 2. If we are turning them ON, check browser support and permissions.
    if (!("Notification" in window)) {
        alert("This browser does not support desktop notifications");
        return;
    }

    if (Notification.permission === "denied") {
        alert("Notifications are blocked in your browser settings. Please enable them to receive alerts.");
        return;
    }

    if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
    }

    // 3. Enable alerts
    notificationsEnabled = true;
    localStorage.setItem('nring_notifications', 'true');
    updateNotifyUI();

    if (notificationsEnabled) {
        new Notification("🔔 Trackside Alerts Active", {
            body: "We'll ping your pocket the second the barriers lift!",
            icon: '/manifest.json' // manifest icons are local
        });
    }
}

function updateNotifyUI() {
    const btn = document.getElementById('notify-btn');
    const label = document.getElementById('notify-label');
    if (!btn || !label) return;

    if (!("Notification" in window)) {
        btn.style.display = 'none';
        return;
    }

    btn.style.display = 'inline-flex';
    btn.classList.toggle('active', notificationsEnabled);
    label.textContent = notificationsEnabled ? 'Alerts Active' : 'Notify Me';
    btn.querySelector('.icon').textContent = notificationsEnabled ? '🔕' : '🔔';
}

function checkStatusChange(data) {
    if (!notificationsEnabled || !data) return;

    const currentlyOpen = isLive(data);

    // If it flipped from Closed -> Open
    if (currentlyOpen && lastStatusOpen === false) {
        new Notification("🏁 TRACK IS OPEN!", {
            body: "The cleanup is done. Get out there for a clear lap!",
            vibrate: [200, 100, 200],
            requireInteraction: true
        });
    }

    lastStatusOpen = currentlyOpen;
}

function toggleCacheInfo() {
    const popup = document.getElementById('cache-info-popup');
    if (popup) popup.classList.toggle('active');
}

function isLive(data) {
    if (!data) return false;
    return !!(data.nordschleife?.opened || data.ring_kartbahn?.opened);
}

/** Schedule the next data poll based on whether any track is currently open. */
function schedulePoll(fetchedAt = Date.now()) {
    clearInterval(pollTimer);
    clearInterval(uiTimer);
    nextPollTime = null;
    if (!trackData) return;

    const live = isLive(trackData);
    const t = today();
    const scheduledToday = getDayData(trackData.nordschleife, t)?.opened || getDayData(trackData.ring_kartbahn, t)?.opened;

    let interval = trackData._proxyTtl || TTL_OFF_DAY;

    // Fallback logic if _proxyTtl isn't present for some reason
    if (!trackData._proxyTtl) {
        if (live) interval = TTL_LIVE;
        else if (scheduledToday) interval = TTL_ACTIVE_DAY;
        else {
            const days = getMinDaysUntilOpen(trackData);
            if (days === 1) interval = TTL_OFF_NEAR;
            else if (days <= 7) interval = TTL_OFF_MID;
        }
    }

    // Set the expected next poll time relative to when the data was actually fetched
    nextPollTime = fetchedAt + interval;

    // If the proxy gave us a TTL but the data is ALREADY older than that TTL
    // (e.g. we just loaded the page and got a stale cache hit),
    // we want to poll immediately, not wait a full TTL cycle.
    const msUntilNext = Math.max(0, nextPollTime - Date.now());

    pollTimer = setTimeout(() => {
        loadData(true);
    }, msUntilNext);

    // Start UI update loop specifically for this polling lifecycle
    uiTimer = setInterval(updateRefreshUI, 1000);
    updateRefreshUI();
}

// -------- Render --------

function renderStatus(data, fetchedAt) {
    const t = today();
    const now = new Date();
    document.getElementById('status-date').textContent = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const infoPopupHtml = `
        <div class="cache-info-container" style="display:inline-block; margin-left:6px; vertical-align:middle;">
            <div class="info-btn" onclick="toggleCacheInfo()">i</div>
            <div class="cache-info-popup" id="cache-info-popup">
                <h4>🔋 Smart Data Refresh</h4>
                <p>To save battery and bandwidth, checking frequency depends on track activity:</p>
                <ul>
                    <li><span>Live Track</span> <span>30s</span></li>
                    <li><span>Scheduled Today</span> <span>10m</span></li>
                    <li><span>Opens Tomorrow</span> <span>1h</span></li>
                    <li><span>Opens This Week</span> <span>12h</span></li>
                    <li><span>Standby mode</span> <span>24h</span></li>
                </ul>
            </div>
        </div>
    `;

    // Render a static badge — 'refresh-text' span ticks every second with timing details
    const age = lastFetchedAt ? Date.now() - lastFetchedAt : 0;
    const isCached = age > 5000;
    const fetchTime = new Date();
    const badgeHtml = isCached
        ? `<span class="cache-badge">📦 Cached</span>`
        : `<span class="cache-badge live">🟢 Live</span> ${fetchTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} (Browser Time)`;

    const statusEl = document.getElementById('last-updated');
    statusEl.innerHTML = `${badgeHtml} <span id="refresh-text" style="opacity:0.8;"></span>${infoPopupHtml}`;
    if (typeof updateRefreshUI === 'function') updateRefreshUI();

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

    const trackKeys = Object.keys(trackData).filter(k => trackData[k]?.year_schedule);
    const t = today();
    const daysToShow = showFullUpcoming ? 30 : 10;
    const cutoff = new Date(t); cutoff.setDate(cutoff.getDate() + daysToShow);

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

    // Dynamic year detection for the sync button
    const firstDate = Object.keys(byDate).sort()[0] || today();
    const dataYear = firstDate.split('-')[0];
    const syncBtn = document.getElementById('sync-cal-btn');
    const syncYear = document.getElementById('sync-cal-year');
    if (syncBtn && syncYear) {
        syncYear.textContent = dataYear;
        syncBtn.style.display = 'inline-flex';
    }

    const dates = Object.keys(byDate).sort();
    const subEl = document.getElementById('upcoming-subtitle');
    if (subEl) {
        subEl.textContent = `${dates.length} scheduled ${dates.length === 1 ? 'day' : 'days'} found in the next ${daysToShow} days`;
    }

    if (!dates.length) {
        list.innerHTML = `<p style="color:var(--muted);padding:40px 0;text-align:center;">No open days scheduled for the next ${daysToShow} days.</p>`;
        return;
    }

    const scheduleHtml = dates.map((d, i) => {
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

    const toggleBtn = !showFullUpcoming ? `
        <div style="text-align:center; margin-top:24px;">
            <button class="btn" onclick="showFullUpcoming=true; renderUpcoming()">
                Show 30 Days
            </button>
        </div>
    ` : '';

    list.innerHTML = scheduleHtml + toggleBtn;
}

// -------- Full Year Calendar Sync (.ics) --------

function exportFullCalendar() {
    if (!trackData) return;

    const trackKeys = Object.keys(trackData).filter(k => trackData[k]?.year_schedule);
    let icsLines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//IsTheRingOpen//Nürburgring Schedule//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Nürburgring Tourist Drives'
    ];

    const todayStr = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    for (const key of trackKeys) {
        const sched = trackData[key].year_schedule || {};
        for (const dateStr of Object.keys(sched).sort()) {
            const info = getDayData(trackData[key], dateStr);
            if (!info?.opened) continue;

            const label = trackLabel(key);
            const msg = info.message?.en || '';

            for (const p of info.periods) {
                // Formatting: YYYYMMDDTHHMMSS
                const dateClean = dateStr.replace(/-/g, '');
                const start = dateClean + 'T' + p.start.replace(':', '') + '00';
                const end = dateClean + 'T' + p.end.replace(':', '') + '00';
                const uid = `${dateClean}-${key}-${p.start.replace(':', '')}@istheringopen.com`;

                icsLines.push('BEGIN:VEVENT');
                icsLines.push(`UID:${uid}`);
                icsLines.push(`DTSTAMP:${todayStr}`);
                icsLines.push(`DTSTART;TZID=Europe/Berlin:${start}`);
                icsLines.push(`DTEND;TZID=Europe/Berlin:${end}`);
                icsLines.push(`SUMMARY:${label} Open${msg ? ' (' + msg + ')' : ''}`);
                icsLines.push(`DESCRIPTION:Nürburgring Tourist Drives - ${label}${msg ? '\\nEvent: ' + msg : ''}`);
                icsLines.push('LOCATION:Nürburgring, Germany');
                icsLines.push('END:VEVENT');
            }
        }
    }

    icsLines.push('END:VCALENDAR');

    // Dynamic filename based on schedule year
    const firstDate = Object.keys(trackData[trackKeys[0]]?.year_schedule || {}).sort()[0] || '2026';
    const dataYear = firstDate.split('-')[0];

    const blob = new Blob([icsLines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.setAttribute('download', `nürburgring-schedule-${dataYear}.ics`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
        <span class="legend-dot" style="background:${trackColor(k)};border:1px solid ${trackColor(k)}"></span>
        ${trackLabel(k)}
      </span>`).join('');
        legend.innerHTML = extra +
            `<span class="legend-item"><span class="legend-dot" style="background:rgba(245,158,11,1);border:1px solid var(--amber)"></span>Event</span>` +
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

            // Prefer the proxy's server-side timestamp to show absolute data age.
            // Fall back to existing lastFetchedAt so a background refresh doesn't
            // silently reset the countdown to 60m when the proxy data hasn't changed.
            const fetchedAt = data._proxyFetchedAt || lastFetchedAt || Date.now();

            writeCache(data, fetchedAt);
            return { data, fetchedAt };
        } catch { }
    }
    return null;
}

function applyData(data, fetchedAt) {
    checkStatusChange(data);
    trackData = data;
    lastFetchedAt = fetchedAt;
    renderStatus(data, fetchedAt);
    renderUpcoming();   // no tab argument — all circuits
    const d = new Date();
    if (!currentCalMonth) currentCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCalendar(currentCalMonth.getFullYear(), currentCalMonth.getMonth());
    schedulePoll(fetchedAt);
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

    let ttl = cached?.data?._proxyTtl;

    // Fallback if _proxyTtl isn't present
    if (!ttl) {
        const live = cached?.data && (cached.data.nordschleife?.opened || cached.data.ring_kartbahn?.opened);
        const scheduledToday = cached?.data && (
            getDayData(cached.data.nordschleife, t)?.opened ||
            getDayData(cached.data.ring_kartbahn, t)?.opened
        );
        ttl = TTL_OFF_DAY;
        if (live) ttl = TTL_LIVE;
        else if (scheduledToday) ttl = TTL_ACTIVE_DAY;
        else {
            const days = getMinDaysUntilOpen(cached?.data);
            if (days === 1) ttl = TTL_OFF_NEAR;
            else if (days <= 7) ttl = TTL_OFF_MID;
        }
    }

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

// Close cache info on outside click
document.addEventListener('mousedown', e => {
    const popup = document.getElementById('cache-info-popup');
    const infoContainer = document.querySelector('.cache-info-container');
    if (popup?.classList.contains('active') && !infoContainer?.contains(e.target)) {
        popup.classList.remove('active');
    }
});

// -------- Init --------
loadData();
initWebcams();
updateNotifyUI();
