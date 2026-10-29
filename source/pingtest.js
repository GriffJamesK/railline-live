// Checks when arrival pings fire, against scripted feed behaviour, with a simulated clock.
// Compares the current rule (feed-confirmed) with the previous one (drawn train reaches the stop).
const src = require('fs').readFileSync(__dirname + '/main.js', 'utf8');
const MODEL = new Function(src.slice(src.indexOf('/*MODEL*/'), src.indexOf('/*END MODEL*/')) + 'return MODEL;')();
const MPH = 1.609344 / 3600;
const oldArrivals = (st) => { const out = []; st.route.stopS.forEach((ss, k) => { if (k && !st.pinged.has(k) && st.sDisp >= ss - 0.08) { st.pinged.add(k); out.push(k); } }); return out; };
const route = { total: 300, stopS: [0, 100, 200, 300] };
function run(name, { secs, feed, expect, rule }) {
  const st = { route, sDisp: 0, vDisp: 0, sig: null, capS: null, pinged: new Set() };
  let now = 1e12; const pings = [];
  for (let t = 0; t <= secs * 60; t++) {
    const sec = t / 60;
    if (t % (30 * 60) === 0) {
      const f = feed(sec); // { s, ts, v, sig, status: [per stop] }
      MODEL.report(st, { sig: f.sig, s: f.s, ts: now - (sec - f.ts) * 1000, v: f.v * MPH });
      st.stopStatus = f.status;
      st.capS = MODEL.nextStop(route.stopS, f.status.indexOf('Enroute'), st.sMeas, route.total);
      if (t === 0) { st.sDisp = MODEL.target(st, now); f.status.forEach((x, k) => { if (MODEL.ARRIVE(x) || route.stopS[k] <= st.sDisp + 0.08) st.pinged.add(k); }); }
    }
    MODEL.step(st, 1 / 60, now);
    for (const k of (rule === 'old' ? oldArrivals : MODEL.arrivals)(st)) pings.push({ k, sec: Math.round(sec), at: +st.sDisp.toFixed(2) });
    now += 1000 / 60;
  }
  const ok = expect(pings);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${rule}] ${name} — pings: ${pings.length ? pings.map(p => `stop ${p.k} at t=${p.sec}s (drawn ${p.at} km)`).join(', ') : 'none'}`);
}
const scenarios = {
  // Approaching stop 1 (100 km) at 60 mph; the train arrives at t≈75 s; the first report showing it stopped there is the t=90 s poll, and its status changes from t=150 s
  'normal arrival': { secs: 300,
    feed: (sec) => sec < 150 ? { s: Math.min(100, 98 + sec * 60 * MPH), ts: sec, v: sec < 75 ? 60 : 0, sig: 'a' + sec, status: ['Departed', 'Enroute', 'Enroute', 'Enroute'] }
                              : { s: 100, ts: sec, v: 0, sig: 'b' + sec, status: ['Departed', 'Station', 'Enroute', 'Enroute'] },
    expect: (p) => p.length === 1 && p[0].k === 1 && p[0].sec >= 90 && Math.abs(p[0].at - 100) < 0.2 }, // first report showing it stopped there is at t=90
  // Held at a signal 1 km short of the stop for 5 minutes: it never arrives in this window
  'held at a signal short of the stop': { secs: 400,
    // (Amtrak's position report stays the same for 3 minutes, so the map carries the train on in the meantime)
    feed: (sec) => sec < 180 ? { s: 97, ts: 0, v: 60, sig: 'm', status: ['Departed', 'Enroute', 'Enroute', 'Enroute'] }
                              : { s: 99, ts: 180, v: 0, sig: 'h', status: ['Departed', 'Enroute', 'Enroute', 'Enroute'] },
    expect: (p) => p.length === 0 },
  // First seen standing at stop 1, then departs: no ping for a stop it was already at
  'first seen at a station': { secs: 200,
    feed: (sec) => sec < 90 ? { s: 100, ts: 0, v: 0, sig: 's', status: ['Departed', 'Station', 'Enroute', 'Enroute'] }
                             : { s: 101, ts: 90, v: 40, sig: 'd', status: ['Departed', 'Departed', 'Enroute', 'Enroute'] },
    expect: (p) => p.length === 0 },
  // Arrives and leaves between two reports: the feed jumps from Enroute to Departed; one ping as the drawn train passes the stop
  'arrive and leave between reports': { secs: 300,
    feed: (sec) => sec < 120 ? { s: 99, ts: 0, v: 30, sig: 'x', status: ['Departed', 'Enroute', 'Enroute', 'Enroute'] }
                              : { s: 100.6, ts: 120, v: 30, sig: 'y', status: ['Departed', 'Departed', 'Enroute', 'Enroute'] },
    expect: (p) => p.length === 1 && p[0].k === 1 },
  // A report puts the stopped train at the station while it's still drawn 0.6 km short: it jumps there and pings
  'jump onto the station': { secs: 120,
    feed: (sec) => sec < 30 ? { s: 99.2, ts: 0, v: 0, sig: 'p', status: ['Departed', 'Enroute', 'Enroute', 'Enroute'] }
                             : { s: 100, ts: 30, v: 0, sig: 'q', status: ['Departed', 'Station', 'Enroute', 'Enroute'] },
    expect: (p) => p.length === 1 && p[0].k === 1 && p[0].sec >= 30 },
};
for (const rule of ['old', 'new']) for (const [n, sc] of Object.entries(scenarios)) run(n, { ...sc, rule });
