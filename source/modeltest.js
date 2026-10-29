// Simulates the motion model with a fake clock against scripted feed behaviour
const src = require('fs').readFileSync(__dirname + '/main.js', 'utf8');
const MODEL = new Function(src.slice(src.indexOf('/*MODEL*/'), src.indexOf('/*END MODEL*/')) + '; return MODEL;')();
const MPH = 1.609344 / 3600;
const route = { total: 500, stopS: [0, 100, 200, 300, 400, 500] };
function run(name, { v, reports, stopIdx = () => 1, secs, check }) {
  const st = { route, sDisp: 0, vDisp: 0, sig: null, capS: null };
  let now = 1e12, log = [];
  for (let t = 0; t <= secs * 60; t++) { // 60 fps
    const sec = t / 60;
    if (t % (30 * 60) === 0) { // poll every 30 s
      const r = reports(sec); // { s, ts (sec), v, sig }
      MODEL.report(st, { sig: r.sig, s: r.s, ts: now - (sec - r.ts) * 1000, v: r.v * MPH });
      st.capS = MODEL.nextStop(route.stopS, stopIdx(sec), st.sMeas, route.total);
      if (t === 0) { st.sDisp = MODEL.target(st, now); st.vDisp = st.vMeas; }
    }
    MODEL.step(st, 1 / 60, now); now += 1000 / 60;
    if (t % 60 === 0) log.push({ sec, s: st.sDisp, v: st.vDisp / MPH });
  }
  const res = check(log);
  console.log((res.ok ? 'PASS ' : 'FAIL ') + name + ' — ' + res.msg);
}
const speedOver = (log, a, b) => (log[b].s - log[a].s) / (b - a) / MPH;
const stalls = (log, from) => log.slice(from).filter((p, i, a) => i && p.s - a[i - 1].s < 0.002).length;

// 1. Amtrak updates position every 3 min; each poll in between repeats the same report
run('repeated report, 60 mph', { secs: 600,
  reports: (sec) => { const k = Math.floor(sec / 180); return { s: 110 + k * 180 * 60 * MPH, ts: k * 180, v: 60, sig: 'r' + k }; },
  stopIdx: () => 2,
  check: (log) => { const sp = speedOver(log, 30, 590), st = stalls(log, 30); return { ok: Math.abs(sp - 60) < 4 && st === 0, msg: `avg ${sp.toFixed(1)} mph, ${st} stalled seconds` }; } });

// 2. A report that's already 6 minutes old and not updated for 5 more
run('stale report, 70 mph', { secs: 300,
  reports: () => ({ s: 120, ts: -360, v: 70, sig: 'old' }), stopIdx: () => 2,
  check: (log) => { const sp = speedOver(log, 10, 290); return { ok: Math.abs(sp - 70) < 4, msg: `avg ${sp.toFixed(1)} mph (old model froze after 4 min)` }; } });

// 3. Feed still lists stop 2 (s=200) as "Enroute" although the position is past it
run('station status lagging', { secs: 120,
  reports: (sec) => ({ s: 201 + sec * 50 * MPH, ts: sec, v: 50, sig: 'p' + Math.floor(sec / 30) }), stopIdx: () => 2,
  check: (log) => { const sp = speedOver(log, 10, 110); return { ok: sp > 45, msg: `avg ${sp.toFixed(1)} mph (old model held it at the passed stop)` }; } });

// 4. Train reported stopped; a new report puts it 1.2 km further on
run('stopped train, new position', { secs: 120,
  reports: (sec) => sec < 30 ? { s: 150, ts: 0, v: 0, sig: 'a' } : { s: 151.2, ts: 30, v: 0, sig: 'b' }, stopIdx: () => 2,
  check: (log) => { const arrive = log.findIndex((p, i) => i > 30 && Math.abs(p.s - 151.2) < 0.02); const after = log.slice(arrive + 1).some((p, i, a) => i && Math.abs(p.s - a[i - 1].s) > 0.001);
    return { ok: arrive > 0 && arrive - 30 <= 15 && !after, msg: `settled ${arrive - 30} s after the report, still moving after: ${after}` }; } });

// 5. Approaching a stop at 79 mph: stops there and waits, then departs when the feed says so
run('stop and depart', { secs: 240,
  reports: (sec) => sec < 120 ? { s: 198, ts: 0, v: 79, sig: 'x' } : { s: 200.2, ts: 120, v: 30, sig: 'y' },
  stopIdx: (sec) => sec < 120 ? 2 : 3,
  check: (log) => { const at = log[110].s, moved = log[230].s - log[125].s; return { ok: Math.abs(at - 200) < 0.1 && moved > 0.5, msg: `held at ${at.toFixed(2)} km (stop at 200), moved ${moved.toFixed(2)} km after departing` }; } });
