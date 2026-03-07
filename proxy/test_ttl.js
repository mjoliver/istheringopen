/**
 * Tests for the TTL caching logic in index.js.
 *
 * Bugs fixed:
 * 1. schedule entries are wrapped in an `exclusion` object — raw.periods was read
 *    directly, so msUntilNextOpen was always Infinity and the 30s pre-open
 *    window never activated.
 * 2. Being inside a scheduled session window while opened=false (crash/red-flag
 *    closure) now correctly returns TTL_LIVE instead of TTL_ACTIVE_DAY.
 *
 * Run: node test_ttl.js
 */

'use strict';

const assert = require('assert');

// ---- TTL constants (mirrors proxy/index.js) ----
const TTL_LIVE = 30 * 1000;
const TTL_ACTIVE_DAY = 10 * 60 * 1000;
const TTL_OFF_NEAR = 1 * 60 * 60 * 1000;
const TTL_OFF_MID = 12 * 60 * 60 * 1000;
const TTL_OFF_DEEP = 24 * 60 * 60 * 1000;

// ---- Copy of getTtl from index.js (keep in sync) ----
function isOpen(data) {
    try {
        return Object.values(data).some(t => t?.opened === true);
    } catch { return false; }
}

function getTtl(data, nowOverride) {
    if (isOpen(data)) return TTL_LIVE;

    try {
        const berlinNow = nowOverride ?? new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
        const y = berlinNow.getFullYear();
        const m = berlinNow.getMonth() + 1;
        const d = berlinNow.getDate();
        const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        const tracks = Object.values(data);
        let daysUntilOpen = Infinity;
        let msUntilNextOpen = Infinity;

        for (const track of tracks) {
            const sched = track?.year_schedule;
            if (!sched) continue;

            for (const [dateStr, raw] of Object.entries(sched)) {
                if (dateStr < todayStr) continue;

                const isOpened = (raw.exclusion || raw).opened === true;
                if (!isOpened) continue;

                const diffTime = new Date(dateStr) - new Date(todayStr);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays < daysUntilOpen) daysUntilOpen = diffDays;

                const todayEntry = raw.exclusion || raw;
                if (diffDays === 0 && todayEntry.periods) {
                    for (const p of todayEntry.periods) {
                        const [sh, sm] = p.start.split(':').map(Number);
                        const [eh, em] = p.end.split(':').map(Number);
                        const startDt = new Date(y, m - 1, d, sh, sm, 0);
                        const endDt = new Date(y, m - 1, d, eh, em, 0);

                        if (berlinNow >= startDt && berlinNow < endDt) {
                            return TTL_LIVE;
                        }

                        if (startDt > berlinNow) {
                            const msUntil = startDt - berlinNow;
                            if (msUntil < msUntilNextOpen) msUntilNextOpen = msUntil;
                        }
                    }
                }
            }
        }

        if (daysUntilOpen === 0) {
            if (msUntilNextOpen <= 60 * 60 * 1000) return TTL_LIVE;
            return TTL_ACTIVE_DAY;
        }
        if (daysUntilOpen === 1) return TTL_OFF_NEAR;
        if (daysUntilOpen <= 7) return TTL_OFF_MID;
        return TTL_OFF_DEEP;

    } catch (e) {
        return TTL_OFF_NEAR;
    }
}

// ---- Helpers ----

/** Build a consistent Berlin "today" date at HH:MM */
function berlinAt(h, min) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0);
}

/** Build mock track data with today scheduled to open at openH:openM–closeH:closeM. */
function mockData({ openH = 14, openM = 0, closeH = 20, closeM = 0, excludeWrapper = true } = {}) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const d = now.getDate();
    const todayStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const startStr = `${String(openH).padStart(2, '0')}:${String(openM).padStart(2, '0')}`;
    const endStr = `${String(closeH).padStart(2, '0')}:${String(closeM).padStart(2, '0')}`;

    const dayEntry = {
        opened: true,
        status: 'opened',
        periods: [{ start: startStr, end: endStr }],
        message: { en: null, de: null }
    };

    return {
        nordschleife: {
            opened: false,
            year_schedule: {
                [todayStr]: excludeWrapper ? { exclusion: dayEntry } : dayEntry
            }
        }
    };
}

// ---- Tests ----

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
        failed++;
    }
}

console.log('\nTTL logic tests\n');

test('Track open → TTL_LIVE (30s)', () => {
    const data = { nordschleife: { opened: true, year_schedule: {} } };
    assert.strictEqual(getTtl(data), TTL_LIVE);
});

test('Scheduled today, >1h before open → TTL_ACTIVE_DAY (10m)', () => {
    // 14:00 open, simulated now = 12:00 (2h before)
    const data = mockData({ openH: 14 });
    const now = berlinAt(12, 0);
    assert.strictEqual(getTtl(data, now), TTL_ACTIVE_DAY);
});

test('Scheduled today, within 1h of open → TTL_LIVE (30s) [exclusion-wrapper bug fix]', () => {
    // 14:00-20:00 session, now = 13:30 (30 min before opening)
    const data = mockData({ openH: 14, closeH: 20 });
    const now = berlinAt(13, 30);
    assert.strictEqual(getTtl(data, now), TTL_LIVE);
});

test('Inside session window, opened=false → TTL_LIVE (30s) [crash/red-flag closure]', () => {
    // 08:00-18:30 session, now = 10:00, but opened=false (track stopped due to crash).
    // Must still poll at 30s so users know the moment it reopens.
    const data = mockData({ openH: 8, closeH: 18, closeM: 30 });
    const now = berlinAt(10, 0);
    assert.strictEqual(getTtl(data, now), TTL_LIVE);
});

test('Same test without exclusion wrapper still works', () => {
    // Some entries omit the exclusion wrapper — make sure we handle both forms
    const data = mockData({ openH: 14, excludeWrapper: false });
    const now = berlinAt(13, 30);
    assert.strictEqual(getTtl(data, now), TTL_LIVE);
});

test('After all sessions today → TTL_ACTIVE_DAY (10m, no future periods)', () => {
    // 08:00 open, simulated now = 20:30 (all sessions ended)
    const data = mockData({ openH: 8 });
    const now = berlinAt(20, 30);
    // daysUntilOpen === 0 but msUntilNextOpen === Infinity → TTL_ACTIVE_DAY
    assert.strictEqual(getTtl(data, now), TTL_ACTIVE_DAY);
});

test('No schedule at all → TTL_OFF_DEEP', () => {
    const data = { nordschleife: { opened: false, year_schedule: {} } };
    assert.strictEqual(getTtl(data), TTL_OFF_DEEP);
});

test('Next open day is tomorrow → TTL_OFF_NEAR (1h)', () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const d = now.getDate();
    const tomorrowStr = (() => {
        const t = new Date(y, mo - 1, d + 1);
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    })();
    const data = {
        nordschleife: {
            opened: false,
            year_schedule: {
                [tomorrowStr]: { exclusion: { opened: true, status: 'opened', periods: [{ start: '09:00', end: '18:00' }] } }
            }
        }
    };
    assert.strictEqual(getTtl(data), TTL_OFF_NEAR);
});

test('Next open day is 4 days away → TTL_OFF_MID (12h)', () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const y = now.getFullYear(); const mo = now.getMonth() + 1; const d = now.getDate();
    const futureStr = (() => {
        const t = new Date(y, mo - 1, d + 4);
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    })();
    const data = {
        nordschleife: {
            opened: false,
            year_schedule: {
                [futureStr]: { exclusion: { opened: true, status: 'opened', periods: [{ start: '09:00', end: '18:00' }] } }
            }
        }
    };
    assert.strictEqual(getTtl(data), TTL_OFF_MID);
});

// ---- Summary ----
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
