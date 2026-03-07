const https = require('https');
https.get('https://ring-proxy-765054426821.europe-west3.run.app/track-status', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let b = '';
    res.on('data', d => b += d);
    res.on('end', () => {
        const data = JSON.parse(b);
        const berlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
        const todayStr = berlin.toISOString().slice(0, 10);

        console.log('Berlin time now:', berlin.toLocaleTimeString('en-GB'));
        console.log('TTL:', data._proxyTtl / 1000 + 's');
        console.log('');

        for (const [key, track] of Object.entries(data)) {
            if (!track?.year_schedule) continue;
            const entry = track.year_schedule[todayStr];
            if (!entry) { console.log(`${key}: no entry for today`); continue; }
            const src = entry.exclusion || entry;
            console.log(`${key}: opened=${src.opened}, periods=${JSON.stringify(src.periods)}`);
        }
    });
});
