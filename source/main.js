(() => {
'use strict';
const API = 'https://api.amtraker.com/v3';
const POLL_MS = 30000;
const MPH = 1.609344 / 3600; // mph -> km/s
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const VEC_TILEJSON = 'https://tiles.openfreemap.org/planet';
const MARGIN = 256; // the base map image extends this far past each screen edge (CSS px)
const $ = (id) => document.getElementById(id);

// ---------- projection (must match the build step) ----------
const R = 6371, rad = Math.PI / 180;
const P1 = 29.5 * rad, P2 = 45.5 * rad, L0 = -96 * rad, F0 = 37.5 * rad;
const N = (Math.sin(P1) + Math.sin(P2)) / 2, C = Math.cos(P1) ** 2 + 2 * N * Math.sin(P1);
const RHO0 = Math.sqrt(C - 2 * N * Math.sin(F0)) / N;
function project(lon, lat) {
  const t = N * (lon * rad - L0), r = Math.sqrt(C - 2 * N * Math.sin(lat * rad)) / N;
  return [R * r * Math.sin(t), -R * (RHO0 - r * Math.cos(t))];
}

// ---------- geometry the page itself needs (the renderer has its own copy of the rest) ----------
const Q = GEO.q;
function dec(arr) {
  const out = new Float32Array(arr.length); let x = 0, y = 0;
  for (let i = 0; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; out[i] = x * Q; out[i + 1] = y * Q; }
  return out;
}
function simplify(a, tol) { // Douglas–Peucker on a flat [x,y,...] ring
  const n = a.length / 2; if (n < 4) return a;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [i, j] = st.pop(), ax = a[i * 2], ay = a[i * 2 + 1], dx = a[j * 2] - ax, dy = a[j * 2 + 1] - ay, L2 = dx * dx + dy * dy || 1e-12;
    let md = 0, mi = -1;
    for (let k = i + 1; k < j; k++) {
      let t = ((a[k * 2] - ax) * dx + (a[k * 2 + 1] - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - a[k * 2], ey = ay + t * dy - a[k * 2 + 1], d = ex * ex + ey * ey;
      if (d > md) { md = d; mi = k; }
    }
    if (md > tol * tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  const out = []; for (let k = 0; k < n; k++) if (keep[k]) out.push(a[k * 2], a[k * 2 + 1]);
  return out;
}
const landRings = GEO.land.map(dec);
function ringsPath(rings, tol) {
  const p = new Path2D();
  for (const r0 of rings) {
    const r = tol ? simplify(r0, tol) : r0; if (r.length < 6) continue;
    p.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]); p.closePath();
  }
  return p;
}
// The US outline at three levels of detail, for clipping glows cheaply at every zoom
const landLOD = [ringsPath(landRings, 3), ringsPath(landRings, 0.8), ringsPath(landRings, 0)];
const landClip = (s) => landLOD[s < 0.8 ? 0 : s < 4 ? 1 : 2];
// Bounding boxes of the coast/border outline, to know when a view needs clipping at all
const coastBoxes = [];
for (const a of GEO.coast.map(dec)) for (let st = 0; st < a.length - 2; st += 80) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = st; i < Math.min(a.length, st + 82); i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); y0 = Math.min(y0, a[i + 1]); y1 = Math.max(y1, a[i + 1]); }
  coastBoxes.push([x0, y0, x1, y1]);
}
const hitCtx = document.createElement('canvas').getContext('2d');
const landOutline = (() => { const p = new Path2D(); for (const a of GEO.coast.map(dec)) { p.moveTo(a[0], a[1]); for (let i = 2; i < a.length; i += 2) p.lineTo(a[i], a[i + 1]); } return p; })();
// A train is drawn only while its reported position is on US land (or within a few km of the
// coast or border, so lakeshore and coastal running isn't dropped)
function inUS(x, y) {
  if (hitCtx.isPointInPath(landLOD[2], x, y, 'evenodd')) return true;
  hitCtx.lineWidth = 6; return hitCtx.isPointInStroke(landOutline, x, y);
}

// Track graph
const QT = GEO.qt; // the track network is stored at finer precision than the background layers
const decT = (arr) => { const out = new Float32Array(arr.length); let x = 0, y = 0; for (let i = 0; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; out[i] = x * QT; out[i + 1] = y * QT; } return out; };
// Smooth a track polyline into curves: a centripetal Catmull–Rom spline through every surveyed point
// (so it stays on the data where the data is good), subdivided only where the line bends, about
// one point per 2.5° of turn and no closer than 15 m. Ends are kept exactly, so pieces still join at stations and junctions.
function smoothLine(p) {
  const n = p.length / 2; if (n < 3) return p;
  const out = [p[0], p[1]], P = (i) => [p[2 * Math.max(0, Math.min(n - 1, i))], p[2 * Math.max(0, Math.min(n - 1, i)) + 1]];
  const turn = (a, b, c) => { const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1]; return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)); };
  for (let i = 0; i < n - 1; i++) {
    const p1 = P(i), p2 = P(i + 1);
    let p0 = P(i - 1), p3 = P(i + 2);
    if (i === 0) p0 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    if (i + 2 >= n) p3 = [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const bend = Math.max(i > 0 ? turn(p0, p1, p2) : 0, i + 2 < n ? turn(p1, p2, p3) : 0), len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = bend < 0.05 || len < 0.015 || bend > 1.2 ? 1 : Math.min(10, Math.ceil(bend / 0.045), Math.max(1, Math.floor(len / 0.015)));
    if (k > 1) {
      const d = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
      const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
      for (let j = 1; j < k; j++) {
        const t = t1 + (t2 - t1) * j / k, L = (a, b, ta, tb) => [(tb - t) / (tb - ta) * a[0] + (t - ta) / (tb - ta) * b[0], (tb - t) / (tb - ta) * a[1] + (t - ta) / (tb - ta) * b[1]];
        const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3), B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3), Cc = L(B1, B2, t1, t2);
        out.push(Cc[0], Cc[1]);
      }
    }
    out.push(p2[0], p2[1]);
  }
  return Float32Array.from(out);
}
const nodes = GEO.nodes.map(([x, y]) => [x * QT, y * QT]);
const edges = GEO.edges.map(([a, b, d, w]) => {
  const pts = smoothLine(decT(d)); let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return { a, b, pts, len: len * (w || 1) }; // w > 1: supplementary track, used only where needed
});
const adj = nodes.map(() => []);
edges.forEach((e, i) => { adj[e.a].push(i, e.b); adj[e.b].push(i, e.a); });

// Stations: code -> {node, x, y}; node -1 means off the embedded network
const stations = {};
for (const [code, [node, x, y]] of Object.entries(GEO.stations)) stations[code] = { node, x: x * QT, y: y * QT };
const ST_ABBR = { Alabama: 'AL', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };
// State initials per station code, for labels like "Philadelphia 30th Street, PA"
const stState = {};
for (const [code, name] of Object.entries(GEO.stationNames)) { const m = name.match(/,\s*([^,]+)$/); if (m && ST_ABBR[m[1].trim()]) stState[code] = ST_ABBR[m[1].trim()]; }
const placeName = (name, code) => {
  const st = stState[code]; if (!name) return code || '–';
  return st && !new RegExp(',\\s*' + st + '$').test(name) ? `${name}, ${st}` : name;
};
// Stations drawn as dots: the rail stations from the embedded FRA list
const stationDots = Object.entries(GEO.stationNames).filter(([c]) => stations[c]).map(([code, name]) => {
  const m = name.match(/^(.*),\s*([^,]+)$/);
  return { code, x: stations[code].x, y: stations[code].y, name: m && ST_ABBR[m[2].trim()] ? `${m[1]}, ${ST_ABBR[m[2].trim()]}` : name };
});

// ---------- routing ----------
// Shortest track path between two graph nodes; results are cached per station pair because
// many trains share the same corridors
const pairCache = new Map();
function dijkstra(src, dst) {
  if (src === dst) return { steps: [], len: 0 };
  const key = src + '>' + dst; if (pairCache.has(key)) return pairCache.get(key);
  const n = nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevE = new Int32Array(n);
  const hd = [], hn = []; // binary heap as parallel arrays
  const push = (d, v) => { hd.push(d); hn.push(v); let i = hd.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break; [hd[p], hd[i]] = [hd[i], hd[p]]; [hn[p], hn[i]] = [hn[i], hn[p]]; i = p; } };
  const pop = () => {
    const d = hd[0], v = hn[0], ld = hd.pop(), lv = hn.pop();
    if (hd.length) { hd[0] = ld; hn[0] = lv; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hd.length && hd[l] < hd[m]) m = l; if (r < hd.length && hd[r] < hd[m]) m = r; if (m === i) break; [hd[m], hd[i]] = [hd[i], hd[m]]; [hn[m], hn[i]] = [hn[i], hn[m]]; i = m; } }
    return [d, v];
  };
  dist[src] = 0; push(0, src);
  while (hd.length) {
    const [d, u] = pop(); if (d > dist[u]) continue; if (u === dst) break;
    const A = adj[u];
    for (let k = 0; k < A.length; k += 2) { const ei = A[k], v = A[k + 1], nd = d + edges[ei].len; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevE[v] = ei; push(nd, v); } }
  }
  let res = null;
  if (isFinite(dist[dst])) { const seq = []; for (let v = dst; v !== src; v = prev[v]) seq.push([prevE[v], prev[v]]); res = { steps: seq.reverse(), len: dist[dst] }; }
  pairCache.set(key, res);
  return res;
}

const routeCache = new Map();
function buildRoute(codes) {
  const key = codes.join('>');
  if (routeCache.has(key)) return routeCache.get(key);
  const xs = [], ys = [];
  const add = (x, y) => { const n = xs.length; if (n && Math.abs(xs[n - 1] - x) < 1e-4 && Math.abs(ys[n - 1] - y) < 1e-4) return; xs.push(x); ys.push(y); };
  const stops = [];
  for (let i = 0; i < codes.length; i++) {
    const s = stations[codes[i]];
    if (i === 0) { add(s.x, s.y); stops.push(0); continue; }
    const a = stations[codes[i - 1]], b = s;
    const straight = Math.hypot(b.x - a.x, b.y - a.y);
    const path = a.node >= 0 && b.node >= 0 ? dijkstra(a.node, b.node) : null;
    if (path && path.len < straight * 2.2 + 40) {
      for (const [ei, from] of path.steps) {
        const p = edges[ei].pts, fwd = edges[ei].a === from;
        if (fwd) for (let k = 0; k < p.length; k += 2) add(p[k], p[k + 1]);
        else for (let k = p.length - 2; k >= 0; k -= 2) add(p[k], p[k + 1]);
      }
    }
    add(b.x, b.y);
    stops.push(xs.length - 1);
  }
  const n = xs.length, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const r = { xs: Float64Array.from(xs), ys: Float64Array.from(ys), cum, total: cum[n - 1] || 0, stopS: stops.map(i => cum[i]) };
  routeCache.set(key, r);
  return r;
}
function seg(r, s) { // index i with cum[i] <= s < cum[i+1]
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.cum[m] <= s) lo = m; else hi = m; }
  return lo;
}
function pointAt(r, s, out) {
  s = Math.max(0, Math.min(r.total, s));
  const i = seg(r, s), L = r.cum[i + 1] - r.cum[i];
  const t = L > 0 ? (s - r.cum[i]) / L : 0;
  out[0] = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * t; out[1] = r.ys[i] + (r.ys[i + 1] - r.ys[i]) * t;
  return out;
}
function locate(r, x, y, hint) { // nearest arc-length on route; prefers the window around hint
  const scan = (lo, hi) => {
    let bd = Infinity, bs = 0;
    for (let i = lo; i < hi; i++) {
      const ax = r.xs[i], ay = r.ys[i], dx = r.xs[i + 1] - ax, dy = r.ys[i + 1] - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < bd) { bd = d; bs = r.cum[i] + Math.sqrt(L2) * t; }
    }
    return { d: bd, s: bs };
  };
  const n = r.xs.length - 1;
  if (hint != null) {
    const w = scan(seg(r, Math.max(0, hint - 120)), Math.min(n, seg(r, hint + 120) + 1));
    if (w.d < 6) return w;
  }
  return scan(0, n);
}

// ---------- consist estimates (cars including locomotives) ----------
const CONSIST = [
  [/acela/i, 8, 'both'], [/auto train/i, 28, 'double'], [/empire builder|coast starlight|lake shore|silver meteor|silver star|floridian/i, 11, 'double'],
  [/zephyr|southwest chief|capitol limited|crescent/i, 10, 'double'], [/sunset|city of new orleans|texas eagle|cardinal/i, 8, 'double'],
  [/northeast regional|regional/i, 8, 'cab'], [/palmetto|carolinian|keystone|pennsylvanian|vermonter|cascades|surfliner/i, 7, 'cab'],
  [/piedmont|heartland|mardi gras|hartford|valley flyer|berkshire/i, 4, 'cab'], [/brightline/i, 7, 'both'],
];
function consistFor(name) {
  for (const [re, n, kind] of CONSIST) if (re.test(name)) return { n, kind };
  return { n: 6, kind: 'cab' };
}

// ---------- train state ----------
const trains = new Map(); // trainID -> state
let lastFetchOk = 0, stationsFetched = false, firstPollDone = false;

const LATE_MIN = 15, VERY_LATE_MIN = 60;
const tier = (late) => late >= VERY_LATE_MIN ? 'vlate' : late >= LATE_MIN ? 'late' : 'ok';
function parseTime(s) { const t = Date.parse(s); return isFinite(t) ? t : NaN; }
function lateness(t) {
  const next = t.stations.find(s => s.status === 'Enroute') || t.stations.filter(s => s.status === 'Departed').pop();
  if (!next) return 0;
  const a = parseTime(next.arr || next.dep), b = parseTime(next.schArr || next.schDep);
  return isFinite(a) && isFinite(b) ? Math.round((a - b) / 60000) : 0;
}

async function fetchMissingStations(codes) {
  if (stationsFetched || !codes.length) return;
  stationsFetched = true;
  try {
    const res = await fetch(API + '/stations'); if (!res.ok) return;
    const all = await res.json();
    for (const [code, m] of Object.entries(all)) {
      if (stations[code] || !isFinite(m.lat) || !isFinite(m.lon)) continue;
      const [x, y] = project(m.lon, m.lat); stations[code] = { node: -1, x, y };
      if (!stState[code] && m.state && /^[A-Z]{2}$/.test(m.state)) stState[code] = m.state;
    }
    routeCache.clear();
  } catch (_) { /* positions still work for stations we already know */ }
}

function ingest(data, fetchedAt) {
  const seen = new Set(), missing = new Set();
  for (const list of Object.values(data)) for (const t of list) {
    if (t.trainState !== 'Active' || !isFinite(t.lat) || !isFinite(t.lon)) continue;
    if (/via/i.test(t.provider || '') || /via/i.test(t.providerShort || '')) continue;
    const [x, y] = project(t.lon, t.lat);
    if (!inUS(x, y)) continue;
    const stops = (t.stations || []).filter(s => !s.bus);
    stops.forEach(s => { if (!stations[s.code]) missing.add(s.code); });
    const knownStops = stops.filter(s => stations[s.code]), known = knownStops.map(s => s.code);
    if (known.length < 2) continue;
    const route = buildRoute(known);
    if (route.total < 1) continue;
    const id = t.trainID || (t.routeName + t.trainNum);
    let st = trains.get(id);
    if (st && st.route !== route) { // same train, rebuilt route (e.g. more stations became known): keep its place
      pointAt(st.route, st.sDisp, tmpA);
      st.sDisp = locate(route, tmpA[0], tmpA[1], null).s; st.route = route; st.sig = null;
      st.pinged = new Set(); MODEL.reached(st);
    }
    const loc = locate(route, x, y, st ? st.sDisp : null);
    if (loc.d > 60) continue; // position nowhere near its scheduled route
    const v = Math.max(0, (+t.velocity || 0) * MPH);
    // When the report was taken. The feed repeats the same report for several polls; it keeps the
    // time it was first seen, so the train keeps moving from it instead of being pulled back
    let ts = parseTime(t.lastValTS);
    if (!isFinite(ts) || ts > fetchedAt + 60000 || ts < fetchedAt - 60 * 60000) ts = null;
    const sig = `${t.lastValTS}|${t.lat}|${t.lon}|${t.velocity}`;
    if (!st) {
      st = { id, route, sDisp: 0, vDisp: v, alpha: firstPollDone ? 0 : 1, pinged: new Set(), sig: null };
      trains.set(id, st);
    }
    MODEL.report(st, { sig, s: loc.s, ts: ts ?? fetchedAt, v });
    st.capS = MODEL.nextStop(route.stopS, knownStops.findIndex(s => s.status === 'Enroute'), st.sMeas, route.total);
    st.stops = knownStops; st.stopStatus = knownStops.map(s => s.status);
    if (!st.placed) { // first sighting: start where the train should be by now
      st.placed = true; st.sDisp = MODEL.target(st, Date.now()); st.vDisp = v; MODEL.reached(st);
    }
    const late = lateness(t);
    Object.assign(st, { info: t, late, tier: tier(late), consist: consistFor(t.routeName || ''), gone: false });
    seen.add(id);
  }
  for (const st of trains.values()) if (!seen.has(st.id) && !st.gone) {
    st.gone = true;
    const k = MODEL.finalArrival(st);
    if (k >= 0) { pointAt(st.route, st.route.stopS[k], tmpA); pings.push({ x: tmpA[0], y: tmpA[1], t0: performance.now(), rgb: RGB[st.tier] }); logArrival(st, k); announce(st, k); }
  }
  if (missing.size) fetchMissingStations([...missing]);
}

async function poll() {
  try {
    const res = await fetch(API + '/trains', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json(), at = Date.now();
    ingest(data, at);
    lastFetchOk = at;
    $('dot').classList.remove('err'); $('msg').hidden = true;
  } catch (err) {
    $('dot').classList.add('err');
    $('msg').hidden = false;
    $('msg').textContent = lastFetchOk
      ? 'Lost the train feed. Trains keep moving on their last known speed; retrying every 30 seconds.'
      : 'Can’t reach the Amtraker feed (api.amtraker.com). Check your connection or any blocker, and open this file in a regular browser tab. Retrying every 30 seconds.';
  }
  firstPollDone = true; loading.step();
  updateCount(); renderList();
  setTimeout(poll, POLL_MS);
}
function updateCount() {
  let n = 0; for (const t of trains.values()) if (!t.gone) n++;
  if (!lastFetchOk) { $('count').textContent = 'Waiting for train feed'; return; }
  const ago = Math.round((Date.now() - lastFetchOk) / 1000);
  $('count').textContent = `${n} trains · updated ${ago < 5 ? 'just now' : ago + ' s ago'}`;
}
setInterval(updateCount, 5000);

// ---------- motion model ----------
// Each train glides along its route at its reported speed. Corrections from new reports are
// folded in as a gentle speed change rather than a jump, so motion stays continuous.
const tmpA = [0, 0], tmpB = [0, 0];
const pings = [];
/*MODEL*/
// Pure motion model (no page state), so it can be tested on its own
const MODEL = {
  EXTRAP_S: 900,   // keep moving a train from its last report for up to 15 min
  // Take a report. Returns false when it's the same report as last time (nothing new).
  report(st, r) {
    if (st.sig === r.sig) return false;
    st.sig = r.sig; st.sMeas = r.s; st.tMeas = r.ts; st.vMeas = r.v;
    if (st.capS == null) st.capS = Infinity;
    return true;
  },
  // The next stop the train hasn't reached. Station status in the feed can lag behind the
  // position, so a stop the reported position has already passed doesn't count.
  nextStop(stopS, nextIdx, sMeas, total) {
    if (nextIdx < 0) return total;
    for (let k = Math.max(1, nextIdx); k < stopS.length; k++) if (stopS[k] > sMeas + 0.25) return stopS[k];
    return total;
  },
  // Where the train should be now: carried on from its report at the reported speed, but not past
  // the next stop it hasn't reached yet
  target(st, now) {
    const age = Math.min(MODEL.EXTRAP_S, Math.max(0, (now - st.tMeas) / 1000));
    const free = Math.min(st.route.total, st.sMeas + st.vMeas * age), hold = Math.max(st.capS, st.sMeas);
    return free > hold ? hold : free;
  },
  // Move the drawn train toward the target smoothly: matching the reported speed, folding small
  // corrections in, braking into stops and never running backwards
  step(st, dt, now) {
    const target = MODEL.target(st, now), hold = Math.max(st.capS, st.sMeas);
    const capped = target === hold && hold < st.route.total;
    const err = target - st.sDisp, v = st.vMeas, stopped = v < 0.0005; // under ~1 mph
    // Too far off to glide without looking wrong: jump. Slightly ahead of the report, it waits instead.
    if (err > (stopped ? 0.4 : Math.max(3, v * 60)) || err < -Math.max(4, v * 120)) { st.sDisp = target; st.vDisp = capped ? 0 : v; return 'snap'; }
    let want;
    if (stopped) { // reported stopped: settle into place within a few seconds, then hold still
      if (Math.abs(err) < 0.003) { st.sDisp = Math.max(st.sDisp, target); st.vDisp = 0; return 'glide'; }
      want = Math.min(0.06, Math.max(0.01, err / 3));
    }
    else want = Math.min((capped ? 0 : v) + err / 25, v + 0.015); // catching up never runs far above the train's own speed
    const brake = Math.sqrt(2 * 0.0006 * Math.max(0, hold - st.sDisp)); // ~0.6 m/s², like a real station stop
    const braking = want > brake; if (braking) want = brake;
    want = Math.max(0, want);
    st.vDisp += (want - st.vDisp) * Math.min(1, dt * (braking || stopped ? 4 : 0.8));
    let next = st.sDisp + st.vDisp * dt;
    if (stopped && next > target) { next = Math.max(st.sDisp, target); st.vDisp = 0; } // don't coast past it
    st.sDisp = Math.max(0, Math.min(st.route.total, next));
    return 'glide';
  },
};
MODEL.ARRIVE = (status) => status === 'Station' || status === 'Departed';
// The latest report has the train stopped within 500 m of stop k (long platforms and terminals
// put the reported position a few hundred metres from the station's point on the track)
MODEL.stoppedAt = (st, k) => st.vMeas < 0.0005 && Math.abs(st.sMeas - st.route.stopS[k]) < 0.5;
// Stops already reached when a train first appears (or its route is rebuilt): never pinged
MODEL.reached = (st) => {
  const stopS = st.route.stopS, status = st.stopStatus || [];
  for (let k = 0; k < stopS.length; k++) if (MODEL.ARRIVE(status[k]) || MODEL.stoppedAt(st, k) || stopS[k] <= st.sDisp + 0.08) st.pinged.add(k);
};
// A train that leaves the feed at its final stop usually does so right as it arrives, before the
// feed reports it there. If its last report was within 3 km of the final stop, that's the arrival.
MODEL.finalArrival = (st) => {
  const k = st.route.stopS.length - 1;
  if (st.pinged.has(k) || !(st.route.stopS[k] - st.sMeas < 3)) return -1;
  st.pinged.add(k);
  return k;
};
// Stops to ping now. A ping needs the feed to confirm the train reached the stop (its status is
// "Station" or "Departed", or its position report has it stopped at the stop), and fires when the
// drawn train is at the stop, so it lines up on screen.
// A confirmed stop the drawn train is already well past is dropped instead of pinging late.
MODEL.arrivals = (st) => {
  const out = [], stopS = st.route.stopS, status = st.stopStatus || [];
  for (let k = 1; k < stopS.length; k++) {
    if (st.pinged.has(k)) continue;
    // Evidence of arrival: the feed's status for the stop, or a report of the train stopped right at it
    const stoppedThere = MODEL.stoppedAt(st, k);
    if (!MODEL.ARRIVE(status[k]) && !stoppedThere) continue;
    const d = st.sDisp - stopS[k];
    if (d > 0.5) { st.pinged.add(k); continue; }
    if (d >= -0.15) { st.pinged.add(k); out.push(k); }
  }
  return out;
};
/*END MODEL*/
function stepTrains(dt) {
  const now = Date.now();
  for (const [id, t] of trains) {
    t.alpha = t.gone ? Math.max(0, t.alpha - dt / 2) : Math.min(1, t.alpha + dt / 1.5);
    if (t.gone && t.alpha <= 0) { trains.delete(id); continue; }
    MODEL.step(t, dt, now); // after a jump, stops it skipped are dropped by MODEL.arrivals; the one it lands on can still ping
    if (t.gone) continue;
    for (const k of MODEL.arrivals(t)) {
      pointAt(t.route, t.route.stopS[k], tmpA);
      pings.push({ x: tmpA[0], y: tmpA[1], t0: performance.now(), rgb: RGB[t.tier] });
      logArrival(t, k);
      announce(t, k);
    }
  }
}
// Arrival log, shown with #debug in the address: what the feed said when each ping fired
const arrivalLog = [], DEBUG = location.hash === '#debug';
function logArrival(t, k) {
  const s = t.stops && t.stops[k], i = t.info;
  const e = { at: new Date(), train: `${i.routeName} ${i.trainNum}`, stop: s ? placeName(s.name, s.code) : '?', status: s ? s.status : '?',
    arr: s ? fmtTime(s.arr || s.dep, s.tz) : '–', sched: s ? fmtTime(s.schArr || s.schDep, s.tz) : '–', gap: (t.sDisp - t.sMeas).toFixed(2), report: ago(t.tMeas) };
  arrivalLog.unshift(e); arrivalLog.length = Math.min(arrivalLog.length, 40);
  if (DEBUG) { console.info('[arrival]', e); renderDebug(); }
}
function renderDebug() {
  const el = $('debug'); if (!el) return;
  el.hidden = false;
  el.replaceChildren(...[Object.assign(document.createElement('div'), { className: 'h', textContent: `Arrival pings (${arrivalLog.length})` })].concat(arrivalLog.map(e => {
    const d = document.createElement('div');
    d.textContent = `${e.at.toLocaleTimeString()} · ${e.train} · ${e.stop} · feed: ${e.status}, arr ${e.arr} (sched ${e.sched}) · report ${e.report} · drawn ${e.gap} km from report`;
    return d;
  })));
}
// Arrival announcements: a quiet line in the top-right corner that fades after a few seconds
// Arrivals confirmed by the same feed update are announced one at a time, ~1.5 s apart
const toastQueue = []; let toastTimer = null;
function announce(t, k) {
  const s = t.stops && t.stops[k], i = t.info; if (!s) return;
  toastQueue.push(`${i.routeName || 'Train'} ${i.trainNum} arrived at ${placeName(s.name, s.code)}`);
  if (toastQueue.length > 8) toastQueue.shift();
  if (!toastTimer) showToast();
}
function showToast() {
  const box = $('toasts'), text = toastQueue.shift();
  if (!box || !text) { toastTimer = null; return; }
  const el = document.createElement('div'); el.textContent = text;
  el.addEventListener('animationend', () => el.remove());
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
  toastTimer = setTimeout(showToast, 1500);
}

// ---------- view ----------
const canvas = $('map'), ctx = canvas.getContext('2d', { alpha: false });
let W = 0, H = 0, DPR = 1;
const view = { x: 0, y: 0, s: 1 };          // world point at screen center, px per km
const goal = { s: 1, ax: 0, ay: 0, sx: 0, sy: 0, active: false };
let minS = 0.1, maxS = 1600, follow = null, lastViewChange = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function fit() {
  const x0 = -2400, x1 = 2300, y0 = -1550, y1 = 1450; // CONUS in projected km
  const s = Math.min(W / (x1 - x0), H / (y1 - y0)) * 0.94;
  view.x = (x0 + x1) / 2; view.y = (y0 + y1) / 2 + (W < 600 ? 120 : 0); view.s = goal.s = s; minS = s * 0.7;
}
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const first = !W;
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  if (first) fit();
  base.force = true; lastViewChange = performance.now();
}
const toScreen = (x, y) => [(x - view.x) * view.s + W / 2, (y - view.y) * view.s + H / 2];
const toWorld = (sx, sy) => [(sx - W / 2) / view.s + view.x, (sy - H / 2) / view.s + view.y];

// Camera flight onto a train: zoom and pan together, with the train sliding in a straight line from
// where it is on screen to the center as the view zooms, so it never leaves the frame
let flight = null;
const easeInOut = (u) => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
function flyTo(t, sTarget) {
  pointAt(t.route, t.sDisp, tmpA);
  goal.active = false;
  const zoomSteps = Math.abs(Math.log2(sTarget / view.s));
  flight = { t, t0: performance.now(), dur: reduceMotion ? 0 : 700 + 160 * Math.min(4, zoomSteps),
    s0: view.s, s1: sTarget, dx: (tmpA[0] - view.x) * view.s, dy: (tmpA[1] - view.y) * view.s };
}
function stepFlight(now) {
  const f = flight; if (!f) return false;
  if (!trains.has(f.t.id)) { flight = null; return false; }
  const u = f.dur ? Math.min(1, (now - f.t0) / f.dur) : 1, e = easeInOut(u);
  pointAt(f.t.route, f.t.sDisp, tmpA);
  view.s = Math.exp(Math.log(f.s0) + (Math.log(f.s1) - Math.log(f.s0)) * e);
  view.x = tmpA[0] - f.dx * (1 - e) / view.s; view.y = tmpA[1] - f.dy * (1 - e) / view.s;
  lastViewChange = now;
  if (u >= 1) flight = null;
  return true;
}
function zoomAt(factor, sx, sy) {
  flight = null;
  const ns = Math.max(minS, Math.min(maxS, (goal.active ? goal.s : view.s) * factor));
  const [wx, wy] = toWorld(sx, sy);
  Object.assign(goal, { s: ns, ax: wx, ay: wy, sx, sy, active: true });
  if (follow) { goal.ax = view.x; goal.ay = view.y; goal.sx = W / 2; goal.sy = H / 2; }
  if (reduceMotion) applyZoom(1);
}
function applyZoom(k) {
  if (!goal.active) return;
  const ls = Math.log(view.s), lg = Math.log(goal.s), nl = ls + (lg - ls) * k;
  view.s = Math.exp(nl);
  if (Math.abs(lg - nl) < 0.002) { view.s = goal.s; goal.active = false; }
  view.x = goal.ax - (goal.sx - W / 2) / view.s; view.y = goal.ay - (goal.sy - H / 2) / view.s;
}

// ---------- base map (painted by the renderer, composited here) ----------
const base = {
  worker: null, frames: [], overview: null, sent: null, seq: 0, force: true, interactiveSent: false,
};
function startRenderer() {
  const tileSrc = '(' + tileWorker.toString() + ')()';
  const tileURL = URL.createObjectURL(new Blob([tileSrc], { type: 'text/javascript' }));
  const init = {
    type: 'init', geo: GEO, tileURL, tileSrc, MARGIN, DEM_URL, VEC_TILEJSON,
    COL: rendererColors(),
    dots: stationDots.flatMap(d => [d.x, d.y]),
    track: edges.map(e => e.pts), // the same smoothed lines the trains run on
    trackFar: edges.map(e => Float32Array.from(simplify(e.pts, 0.04))), // a lighter copy for zoomed-out views
  };
  const onMsg = (ev) => {
    const m = ev.data;
    if (m.type === 'frame') {
      m.t0 = performance.now(); base.frames.push(m); trimFrames();
      if (m.settled && !m.preloading) loading.mapReady = true;
      loading.step();
    } else if (m.type === 'overview') { if (base.overview) closeFrame(base.overview); base.overview = m; }
    else if (m.type === 'progress') { loading.tiles = m; loading.step(); }
  };
  // Prefer a worker that can draw off the page; fall back to drawing on the page
  const canWorkerDraw = typeof OffscreenCanvas !== 'undefined' && 'transferToImageBitmap' in OffscreenCanvas.prototype && typeof Worker !== 'undefined';
  if (canWorkerDraw) {
    try {
      const src = '(' + rendererMain.toString() + ')()';
      base.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      base.worker.onmessage = onMsg;
    } catch (_) { base.worker = null; }
  }
  if (!base.worker) {
    const fake = { postMessage: (m) => setTimeout(() => onMsg({ data: m }), 0) };
    new Function('self', '(' + rendererMain.toString() + ')()')(fake);
    base.worker = { postMessage: (m) => fake.onmessage({ data: m }) };
  }
  base.worker.postMessage(init);
}
// Ask for a fresh paint only when the image on hand no longer fits: the zoom moved, the view
// drifted toward the image's edge, or interaction just settled (for a full-resolution pass)
function requestBase(now) {
  const interactive = goal.active || !!drag || !!pinch || now - lastViewChange < 160;
  // During an animated zoom, paint where the zoom is headed: the result is ready on arrival, and
  // when zooming out it already covers the screen while the animation plays
  let tv = !goal.active ? view : follow ? { s: goal.s, x: view.x, y: view.y } // following: the zoom is centered on the train
    : { s: goal.s, x: goal.ax - (goal.sx - W / 2) / goal.s, y: goal.ay - (goal.sy - H / 2) / goal.s };
  if (flight) { pointAt(flight.t.route, flight.t.sDisp, tmpB); tv = { s: flight.s1, x: tmpB[0], y: tmpB[1] }; } // paint where the flight ends
  const r = base.sent;
  let need = base.force || !r;
  if (r) {
    if (Math.abs(Math.log(tv.s / r.s)) > 0.002) need = true;
    else if (Math.abs((tv.x - r.x) * tv.s) > MARGIN * 0.45 || Math.abs((tv.y - r.y) * tv.s) > MARGIN * 0.45) need = true;
    else if (!interactive && base.interactiveSent) need = true;
  }
  const dpr = interactive ? 1 : DPR;
  const msg = { type: 'view', x: tv.x, y: tv.y, s: tv.s, W, H, dpr, interactive, render: need, seq: ++base.seq };
  if (need) { base.sent = msg; base.interactiveSent = interactive; base.force = false; }
  base.worker.postMessage(msg);
}
function baseRect(f) {
  const k = view.s / f.s;
  return [(f.x - view.x) * view.s + W / 2 - (f.BW / 2) * k, (f.y - view.y) * view.s + H / 2 - (f.BH / 2) * k, f.BW * k, f.BH * k];
}
// Each new image fades in over the ones before it, so newly loaded tiles and sharper detail blend
// in instead of popping. Images fully hidden under a newer opaque one that fills the screen are freed.
const FADE_MS = reduceMotion ? 0 : 260;
const closeFrame = (f) => { if (f.bmp.close) f.bmp.close(); };
const frameAlpha = (f, i, now) => i === 0 || !FADE_MS ? 1 : Math.min(1, (now - f.t0) / FADE_MS);
function coversScreen(f) { const r = baseRect(f); return r[0] <= 0.5 && r[1] <= 0.5 && r[0] + r[2] >= W - 0.5 && r[1] + r[3] >= H - 0.5; }
// Keep at most 4 images, but never drop the newest one that still fills the screen: during a fast
// zoom it's what shows around the newer, smaller images until they cover everything
function trimFrames() {
  const fr = base.frames;
  while (fr.length > 4) {
    let keep = -1; for (let i = fr.length - 2; i >= 0; i--) if (coversScreen(fr[i])) { keep = i; break; }
    closeFrame(fr.splice(keep === 0 ? 1 : 0, 1)[0]);
  }
}
function drawBase(now) {
  const fr = base.frames;
  for (let i = fr.length - 1; i > 0; i--) {
    if (frameAlpha(fr[i], i, now) >= 1 && coversScreen(fr[i])) { fr.splice(0, i).forEach(closeFrame); break; }
  }
  // Draw from the newest image that fills the screen on its own (older ones are hidden under it)
  let start = 0;
  for (let i = fr.length - 1; i > 0; i--) if (coversScreen(fr[i])) { start = i; break; }
  if (!fr.length || !coversScreen(fr[start])) {
    ctx.fillStyle = COL.ground; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (base.overview) { const r = baseRect(base.overview); ctx.drawImage(base.overview.bmp, r[0] * DPR, r[1] * DPR, r[2] * DPR, r[3] * DPR); }
  }
  for (let i = start; i < fr.length; i++) {
    const r = baseRect(fr[i]);
    ctx.globalAlpha = i === start ? 1 : frameAlpha(fr[i], i, now);
    ctx.drawImage(fr[i].bmp, r[0] * DPR, r[1] * DPR, r[2] * DPR, r[3] * DPR);
  }
  ctx.globalAlpha = 1;
}

// ---------- input ----------
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(Math.exp(-Math.max(-120, Math.min(120, d)) * 0.0024), e.clientX, e.clientY);
}, { passive: false });

const pointers = new Map(); let drag = null, pinch = null, moved = false;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); moved = false;
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: view.s }; drag = null; }
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, [wx, wy] = toWorld(cx, cy);
    view.s = Math.max(minS, Math.min(maxS, pinch.s * d / pinch.d));
    view.x = wx - (cx - W / 2) / view.s; view.y = wy - (cy - H / 2) / view.s;
    goal.active = false; moved = true; return;
  }
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > (e.pointerType === 'mouse' ? 6 : 10)) { moved = true; canvas.classList.add('dragging'); flight = null; if (follow) setFollow(null); }
    if (moved) { view.x = drag.vx - dx / view.s; view.y = drag.vy - dy / view.s; goal.active = false; }
    return;
  }
  mouseIn = true; mouse[0] = e.clientX; mouse[1] = e.clientY; hoverDirty = true;
});
const endPointer = (e) => {
  pointers.delete(e.pointerId); canvas.classList.remove('dragging');
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) { const [p] = pointers.values(); drag = { x: p[0], y: p[1], vx: view.x, vy: view.y }; }
  if (!pointers.size) drag = null;
};
canvas.addEventListener('pointerup', (e) => {
  if (!moved) {
    const t = pick(e.clientX, e.clientY);
    if (t) { setFollow(t); flyTo(t, view.s < 6 ? Math.min(view.s * 40, 18) : view.s); }
  }
  endPointer(e);
});
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { mouseIn = false; hovered = null; hoveredStation = null; $('tip').hidden = true; $('stip').hidden = true; canvas.classList.remove('over-train'); });
canvas.addEventListener('dblclick', (e) => zoomAt(2.4, e.clientX, e.clientY));
$('zin').onclick = () => zoomAt(2, W / 2, H / 2);
$('zout').onclick = () => zoomAt(0.5, W / 2, H / 2);
$('unfollow').onclick = () => setFollow(null);
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing in the train search
  if (e.key === '+' || e.key === '=') zoomAt(1.6, W / 2, H / 2);
  else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.6, W / 2, H / 2);
  else if (e.key === 'Escape') setFollow(null);
});
addEventListener('resize', resize);

// ---------- train list ----------
const listEl = $('trainList'), listBtn = $('listBtn'), listPanel = $('listPanel'), qEl = $('q');
function lateText(late) { return late >= 60 ? `${Math.floor(late / 60)} hr ${late % 60} min late` : late >= 1 ? `${late} min late` : late <= -1 ? `${-late} min early` : 'On time'; }
function renderList() {
  let n = 0; for (const t of trains.values()) if (!t.gone) n++;
  $('listCount').textContent = n;
  if (listPanel.hidden) return;
  const q = qEl.value.trim().toLowerCase();
  const rows = [...trains.values()].filter(t => !t.gone).map(t => {
    const i = t.info, next = i.stations.find(s => s.status === 'Enroute');
    return { t, name: `${i.routeName || 'Train'} ${i.trainNum}`, to: placeName(i.destName, i.destCode), next: next ? placeName(next.name, next.code) : '' };
  }).filter(r => !q || (r.name + ' ' + r.to + ' ' + r.next).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.className = 'tr ' + r.t.tier + (r.t.id === follow ? ' on' : '');
    const dot = document.createElement('i'), main = document.createElement('span'), sub = document.createElement('span'), st = document.createElement('b');
    main.className = 'nm'; main.textContent = r.name;
    sub.className = 'sub'; sub.textContent = 'to ' + r.to;
    st.className = 'd'; st.textContent = lateText(r.t.late);
    b.append(dot, main, st, sub);
    b.onclick = () => selectTrain(r.t);
    li.append(b); frag.append(li);
  }
  if (!rows.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = trains.size ? 'No trains match' : 'No train data yet'; frag.append(li); }
  listEl.replaceChildren(frag);
}
function openList(open) {
  listPanel.hidden = !open; listBtn.setAttribute('aria-expanded', String(open));
  if (open) { renderList(); qEl.focus(); }
}
listBtn.onclick = () => openList(listPanel.hidden);
qEl.oninput = renderList;
qEl.onkeydown = (e) => { if (e.key === 'Escape') { openList(false); listBtn.focus(); e.stopPropagation(); } };
// Picking a train follows it and zooms in close enough to see its cars
function selectTrain(t) {
  // A train that's far off screen: jump there at the current zoom (quick to paint), then zoom in,
  // rather than flying across the country past map that can't be painted fast enough
  pointAt(t.route, t.sDisp, tmpA);
  if (Math.hypot(tmpA[0] - view.x, tmpA[1] - view.y) * view.s > Math.max(W, H) * 0.6) {
    goal.active = false; view.x = tmpA[0]; view.y = tmpA[1]; base.force = true;
  }
  setFollow(t);
  flyTo(t, Math.max(view.s, 40));
  openList(false);
}

// ---------- hover, tooltips, info panel ----------
let hovered = null, hoveredStation = null, mouseIn = false, hoverDirty = false, lastHover = 0, tipAt = 0;
const mouse = [0, 0];
// Screen-space hit shapes from the last frame: each train is a polyline through its cars,
// matched within a generous radius so long trains are hoverable anywhere along their length
const hits = new Map();
function distToPolyline(pts, n, x, y) {
  if (n === 2) return Math.hypot(pts[0] - x, pts[1] - y);
  let d = Infinity;
  for (let i = 0; i < n - 2; i += 2) {
    const ax = pts[i], ay = pts[i + 1], dx = pts[i + 2] - ax, dy = pts[i + 3] - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    d = Math.min(d, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return d;
}
function pick(sx, sy) {
  let best = null, bd = Infinity;
  for (const [t, h] of hits) {
    if (sx < h.x0 - 20 || sx > h.x1 + 20 || sy < h.y0 - 20 || sy > h.y1 + 20) continue;
    const d = distToPolyline(h.pts, h.n, sx, sy) - h.w / 2;
    if (d < 14 && d < bd) { bd = d; best = t; }
  }
  return best;
}
function pickStation(sx, sy) {
  const [wx, wy] = toWorld(sx, sy), r = 11 / view.s;
  let best = null, bd = r;
  for (const st of stationDots) { const d = Math.hypot(st.x - wx, st.y - wy); if (d < bd) { bd = d; best = st; } }
  return best;
}
function hover(now) {
  const t = mouseIn && !drag && !pinch ? pick(mouse[0], mouse[1]) : null;
  const st = t || !mouseIn || drag ? null : pickStation(mouse[0], mouse[1]);
  if (t !== hovered) { hovered = t; tipAt = 0; canvas.classList.toggle('over-train', !!t); }
  if (st !== hoveredStation) { hoveredStation = st; renderStationTip(); }
  else if (st) placeStationTip();
  if (now - tipAt > 500) { renderTip(); tipAt = now; } else placeTip();
}
function setFollow(t) {
  follow = t ? t.id : null;
  $('info').hidden = !t;
  infoAt = 0;
}
const fmtCache = new Map();
function fmtTime(iso, tz) {
  const t = parseTime(iso); if (!isFinite(t)) return '–';
  try {
    let f = fmtCache.get(tz || '');
    if (!f) { f = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined, timeZoneName: 'short' }); fmtCache.set(tz || '', f); }
    return f.format(t);
  } catch (_) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} hr ${m % 60} min ago`;
}
function trainFacts(t) {
  const i = t.info, next = i.stations.find(s => s.status === 'Enroute'), at = i.stations.find(s => s.status === 'Station');
  const late = t.late, lateTxt = late >= 60 ? `${Math.floor(late / 60)} hr ${late % 60} min late` : late >= 1 ? `${late} min late` : late <= -1 ? `${-late} min early` : 'On time';
  const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
  const row = (k, v, cls) => { const d = el('div', 'row', k), b = el('b', cls, v); d.append(b); return d; };
  const title = el('div', 'ttl', (i.routeName || 'Train') + ' '); title.append(el('span', 'n', String(i.trainNum)));
  const rows = [
    row('Speed', `${Math.round(i.velocity || 0)} mph`),
    at ? row('Now at', placeName(at.name, at.code)) : row('Next stop', next ? placeName(next.name, next.code) : 'Arriving'),
    ...(!at && next ? [row('Due', fmtTime(next.arr || next.dep, next.tz))] : []),
    row('Status', lateTxt, 'd'),
    row('Position report', ago(t.tMeas)),
    row('Cars (est.)', String(t.consist.n)),
  ];
  return { title, rows, row };
}
let tipW = 0, tipH = 0;
function placeTip() {
  const tip = $('tip'); if (tip.hidden) return;
  let x = mouse[0], y = mouse[1];
  if (x + tipW + 30 > W) x -= tipW + 28; if (y + tipH + 30 > H) y -= tipH + 28;
  tip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
}
function renderTip() {
  const tip = $('tip'), t = hovered;
  if (!t || t.id === follow) { tip.hidden = true; return; }
  const f = trainFacts(t);
  tip.className = 'card ' + t.tier;
  tip.replaceChildren(f.title, f.row('To', placeName(t.info.destName, t.info.destCode)), ...f.rows);
  tip.hidden = false;
  tipW = tip.offsetWidth; tipH = tip.offsetHeight; // measured once per content change, not per frame
  placeTip();
}
function placeStationTip() {
  const st = hoveredStation, p = toScreen(st.x, st.y);
  $('stip').style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, calc(-100% - 10px))`;
}
function renderStationTip() {
  const tip = $('stip'), st = hoveredStation;
  if (!st) { tip.hidden = true; return; }
  const code = document.createElement('span'); code.textContent = st.code;
  tip.replaceChildren(st.name, code); tip.hidden = false; placeStationTip();
}
let infoAt = 0;
function renderInfo(now) {
  if (!follow || now - infoAt < 1000) return;
  infoAt = now;
  const t = trains.get(follow); if (!t) return;
  const f = trainFacts(t), i = t.info;
  $('infoTitle').replaceChildren(...f.title.childNodes);
  $('infoRoute').textContent = `${placeName(i.origName, i.origCode)} → ${placeName(i.destName, i.destCode)}`;
  const pct = t.route.total ? Math.round(100 * t.sDisp / t.route.total) : 0;
  $('infoPct').textContent = `${pct}% of trip`;
  $('infoBar').style.transform = `scaleX(${pct / 100})`;
  $('infoBar').style.background = `rgb(${RGB[t.tier]})`;
  $('infoRows').className = 'rows ' + t.tier;
  // Distance along the track to the next stop the train hasn't reached
  const at = (t.stopStatus || []).includes('Station'); // standing at a stop: the panel already says "Now at"
  const ni = (t.stopStatus || []).indexOf('Enroute');
  let k = ni < 0 ? -1 : ni; while (k >= 0 && k < t.route.stopS.length && t.route.stopS[k] <= t.sDisp + 0.05) k++;
  if (!at && k >= 0 && k < t.route.stopS.length) {
    const mi = (t.route.stopS[k] - t.sDisp) / 1.609344;
    f.rows.splice(2, 0, f.row('Distance to stop', mi < 0.1 ? 'Arriving' : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`));
  }
  $('infoRows').replaceChildren(...f.rows);
  // Fetch detail ahead of the train so following never outruns the map
  const pts = [], r = t.route, reach = (Math.max(W, H) * 1.5) / view.s;
  for (let k = 1; k <= 6; k++) { pointAt(r, t.sDisp + reach * k / 6, tmpA); pts.push(tmpA[0], tmpA[1]); }
  base.worker.postMessage({ type: 'prefetch', pts });
}

/*__TILEWORKER__*/

/*__RENDERER__*/

// ---------- trains ----------
// Map and train colors per theme (the page's own colors are CSS tokens that switch with it)
const THEMES = {
  dark: {
    COL: {
      ground: '#15181b', land: '#1f2327', coast: 'rgba(120,140,150,0.30)', border: 'rgba(150,172,182,0.34)',
      roadMajor: 'rgba(150,165,175,', roadMinor: 'rgba(140,155,165,', track: 'rgba(110,150,165,',
      water: 'rgba(96,140,160,', contour: 'rgba(150,176,186,', building: 'rgba(160,182,192,0.075)', green: 'rgba(120,160,150,0.035)',
      station: 'rgba(196,214,220,', shade: 1, car: '#dfeef0', ring: 'rgba(21,24,27,0.9)', hoverRing: 'rgba(228,238,240,0.7)',
    },
    RGB: { ok: '99,197,191', late: '227,168,107', vlate: '226,114,124' },
  },
  light: {
    COL: {
      ground: '#d9e1e5', land: '#f1f3f4', coast: 'rgba(80,100,110,0.35)', border: 'rgba(70,90,100,0.42)',
      roadMajor: 'rgba(90,105,115,', roadMinor: 'rgba(100,115,125,', track: 'rgba(40,105,120,',
      water: 'rgba(60,115,140,', contour: 'rgba(70,95,105,', building: 'rgba(70,90,100,0.09)', green: 'rgba(90,150,115,0.07)',
      station: 'rgba(45,65,75,', shade: 0.6, car: '#2f3e45', ring: 'rgba(241,243,244,0.95)', hoverRing: 'rgba(30,45,52,0.75)',
    },
    RGB: { ok: '30,143,137', late: '199,122,40', vlate: '200,70,84' },
  },
};
let theme = 'dark';
try { if (localStorage.getItem('rail-live-theme') === 'light') theme = 'light'; } catch (_) { /* default theme */ }
const COL = { ...THEMES[theme].COL }, RGB = { ...THEMES[theme].RGB };
document.documentElement.dataset.theme = theme;
const rendererColors = () => { const { car, ring, hoverRing, ...rest } = COL; return rest; };
function setTheme(name) {
  theme = name; document.documentElement.dataset.theme = name;
  Object.assign(COL, THEMES[name].COL); Object.assign(RGB, THEMES[name].RGB);
  for (const k of Object.keys(sprites)) delete sprites[k];
  base.worker.postMessage({ type: 'theme', COL: rendererColors() });
  base.force = true;
  const b = $('themeBtn'); b.setAttribute('aria-label', name === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); b.setAttribute('aria-pressed', String(name === 'light'));
  try { localStorage.setItem('rail-live-theme', name); } catch (_) { /* not remembered */ }
  infoAt = 0; renderList();
}
const ramp = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));
const sprites = {};
function glowSprite(t) {
  // Built pixel by pixel with a little noise so the very faint falloff doesn't band into rings
  if (sprites[t]) return sprites[t];
  const rgb = RGB[t].split(',').map(Number), S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const f = Math.min(1, Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) / (S / 2));
    const al = 0.17 * Math.exp(-f * f * 3.5) * (1 - f) ** 2 * 255 + Math.random() - 0.5;
    const o = (y * S + x) * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = Math.max(0, Math.round(al));
  }
  g.putImageData(img, 0, 0);
  return (sprites[t] = cv);
}
for (const t of Object.keys(RGB)) glowSprite(t); // built up front

function geom(s) {
  const far = 1 - ramp(s, 0.4, 3), near = ramp(s, 0.6, 25);
  // Car geometry: true scale when zoomed in, a legible minimum when zoomed out
  const carPx = Math.max(0.0255 * s, 3 + 7 * near), gapPx = Math.max(0.0015 * s, 0.8 + 1.2 * near);
  // dot: 1 = each train is a single dot (zoomed out), 0 = full cars; crossfades in between
  const dot = 1 - ramp(s, 1.6, 3.2);
  return { far, near, dot, wPx: Math.max(0.0031 * s, 2.6 + 2.6 * near), carKm: carPx / s, gapKm: gapPx / s };
}
// Screen points along a route between two arc lengths
const trailPts = new Float64Array(4096);
function routeScreen(r, sa, sb) {
  let n = 0;
  const put = (x, y) => { if (n < trailPts.length - 2) { trailPts[n++] = (x - view.x) * view.s + W / 2; trailPts[n++] = (y - view.y) * view.s + H / 2; } };
  pointAt(r, sa, tmpA); put(tmpA[0], tmpA[1]);
  // Skip route points closer than ~1.5 px on screen (zoomed out, a trail spans hundreds of them),
  // jumping ahead by binary search rather than visiting each one
  const step = 1.5 / view.s;
  for (let i = seg(r, sa) + 1; i < r.xs.length && r.cum[i] < sb;) {
    put(r.xs[i], r.ys[i]);
    const next = r.cum[i] + step;
    i = i + 1 < r.cum.length && r.cum[i + 1] < next ? Math.max(i + 1, seg(r, next) + 1) : i + 1;
  }
  pointAt(r, sb, tmpA); put(tmpA[0], tmpA[1]);
  return n;
}
function strokeRange(c, r, sa, sb, width, rgb, a0, a1) {
  if (sb - sa <= 0) return;
  const n = routeScreen(r, sa, sb); if (n < 4) return;
  const g = c.createLinearGradient(trailPts[0], trailPts[1], trailPts[n - 2], trailPts[n - 1]);
  g.addColorStop(0, `rgba(${rgb},${a0})`); g.addColorStop(1, `rgba(${rgb},${a1})`);
  c.strokeStyle = g; c.lineWidth = width;
  c.beginPath(); c.moveTo(trailPts[0], trailPts[1]); for (let i = 2; i < n; i += 2) c.lineTo(trailPts[i], trailPts[i + 1]); c.stroke();
}
// Soft effects: the trail behind each train and its glow. A few gradient strokes per train taper
// the trail (thin and faint at the far end, brighter near the cars).
function drawTrainFx(c, t, G) {
  const r = t.route, a = t.alpha, rgb = RGB[t.tier], s = view.s, head = t.sDisp;
  // As a dot the train has no length, and a shorter trail keeps busy corridors readable
  const trainKm = t.consist.n * (G.carKm + G.gapKm) * (1 - G.dot), tail0 = head - trainKm;
  const trailKm = Math.min((70 + 110 * G.far) * (1 - 0.6 * G.dot) / s, 400), trailA = (0.25 + 0.55 * G.far) * a;
  if (tail0 > 0 && trailA > 0.02) {
    const s0 = Math.max(0, tail0 - trailKm);
    strokeRange(c, r, s0, tail0, G.wPx * 2.6, rgb, 0, (trailA * 0.08).toFixed(3));
    strokeRange(c, r, s0, tail0, Math.max(1, G.wPx * 0.3), rgb, 0, (trailA * 0.55).toFixed(3));
    strokeRange(c, r, Math.max(s0, tail0 - trailKm * 0.55), tail0, Math.max(1, G.wPx * 0.45), rgb, 0, (trailA * 0.5).toFixed(3));
  }
  pointAt(r, Math.max(0, head - trainKm / 2), tmpB);
  const gx = (tmpB[0] - view.x) * s + W / 2, gy = (tmpB[1] - view.y) * s + H / 2;
  const gr = Math.min(Math.max(70 + 40 * G.near, trainKm * s * 0.6), 260);
  c.globalAlpha = (0.55 + 0.45 * G.far) * a * 0.42;
  c.drawImage(glowSprite(t.tier), gx - gr, gy - gr, gr * 2, gr * 2);
  c.globalAlpha = 1;
}
// One rounded rectangle along the direction (ux, uy)
function addCar(p, cx, cy, ux, uy, hl, hw, rr) {
  const vx = -uy, vy = ux;
  const ax = cx + ux * hl + vx * hw, ay = cy + uy * hl + vy * hw, bx = cx + ux * hl - vx * hw, by = cy + uy * hl - vy * hw;
  const qx = cx - ux * hl - vx * hw, qy = cy - uy * hl - vy * hw, dx = cx - ux * hl + vx * hw, dy = cy - uy * hl + vy * hw;
  p.moveTo((dx + ax) / 2, (dy + ay) / 2);
  p.arcTo(ax, ay, bx, by, rr); p.arcTo(bx, by, qx, qy, rr); p.arcTo(qx, qy, dx, dy, rr); p.arcTo(dx, dy, ax, ay, rr);
  p.closePath();
}
// Cars for every train go into a few shared paths (one per color) and are filled together
const DOT_R = 3.2;
function trainBodies(order, G) {
  const s = view.s, batch = {}, dots = {}, solo = [];
  const pathFor = (key) => batch[key] || (batch[key] = new Path2D());
  hits.clear();
  for (const t of order) {
    const r = t.route, head = t.sDisp, n = G.dot >= 1 ? 0 : t.consist.n, kind = t.consist.kind;
    const fading = t.alpha < 0.999, target = fading ? { loco: new Path2D(), car: new Path2D(), dot: new Path2D(), t } : null;
    if (fading) solo.push(target);
    pointAt(r, head, tmpA);
    let hx = (tmpA[0] - view.x) * s + W / 2, hy = (tmpA[1] - view.y) * s + H / 2;
    const pts = [hx, hy]; let x0 = hx, x1 = hx, y0 = hy, y1 = hy;
    if (G.dot > 0) { const d = fading ? target.dot : (dots[t.tier] || (dots[t.tier] = new Path2D())); d.moveTo(hx + DOT_R, hy); d.arc(hx, hy, DOT_R, 0, Math.PI * 2); }
    for (let i = 0; i < n; i++) {
      const sa = head - i * (G.carKm + G.gapKm), sb = sa - G.carKm;
      if (sa <= 0) break;
      pointAt(r, sa, tmpA); pointAt(r, Math.max(0, sb), tmpB);
      const ax = (tmpA[0] - view.x) * s + W / 2, ay = (tmpA[1] - view.y) * s + H / 2;
      const bx = (tmpB[0] - view.x) * s + W / 2, by = (tmpB[1] - view.y) * s + H / 2;
      pts.push(bx, by); x0 = Math.min(x0, bx); x1 = Math.max(x1, bx); y0 = Math.min(y0, by); y1 = Math.max(y1, by);
      const len = Math.hypot(ax - bx, ay - by); if (len < 0.5) continue;
      const loco = i === 0 || (kind === 'both' && i === n - 1) || (kind === 'double' && i === 1);
      const p = fading ? (loco ? target.loco : target.car) : pathFor(loco ? t.tier : 'car');
      addCar(p, (ax + bx) / 2, (ay + by) / 2, (ax - bx) / len, (ay - by) / len, len / 2, G.wPx / 2, Math.min(G.wPx * 0.45, i === 0 ? G.wPx : G.wPx * 0.35));
    }
    hits.set(t, { pts, n: pts.length, w: n ? G.wPx : DOT_R * 2, x0, x1, y0, y1 });
  }
  return { batch, dots, solo };
}
function drawTrains(order) {
  const G = geom(view.s), carA = 1 - G.dot;
  const { batch, dots, solo } = trainBodies(order, G);
  const fillDots = (p, rgb, a) => { // a thin ground-colored ring keeps overlapping dots distinct
    ctx.globalAlpha = a; ctx.lineWidth = 2; ctx.strokeStyle = COL.ring; ctx.stroke(p);
    ctx.fillStyle = `rgb(${rgb})`; ctx.fill(p); ctx.globalAlpha = 1;
  };
  if (carA > 0) {
    ctx.globalAlpha = carA;
    for (const k of Object.keys(batch)) { ctx.fillStyle = k === 'car' ? COL.car : `rgb(${RGB[k]})`; ctx.fill(batch[k]); }
    ctx.globalAlpha = 1;
  }
  if (G.dot > 0) for (const k of Object.keys(dots)) fillDots(dots[k], RGB[k], G.dot);
  for (const f of solo) {
    if (carA > 0) {
      ctx.globalAlpha = f.t.alpha * carA;
      ctx.fillStyle = COL.car; ctx.fill(f.car); ctx.fillStyle = `rgb(${RGB[f.t.tier]})`; ctx.fill(f.loco);
      ctx.globalAlpha = 1;
    }
    if (G.dot > 0) fillDots(f.dot, RGB[f.t.tier], f.t.alpha * G.dot);
  }
}
function drawSelected(t) { // the route ahead and an outline for the hovered or followed train
  const r = t.route, rgb = RGB[t.tier], head = t.sDisp, s = view.s;
  ctx.save(); ctx.strokeStyle = `rgba(${rgb},0.35)`; ctx.lineWidth = 1.2; ctx.setLineDash([2, 5]);
  const n = routeScreen(r, head, Math.min(r.total, head + Math.hypot(W, H) / s * 1.2));
  ctx.beginPath(); ctx.moveTo(trailPts[0], trailPts[1]); for (let i = 2; i < n; i += 2) ctx.lineTo(trailPts[i], trailPts[i + 1]); ctx.stroke();
  ctx.restore();
  const h = hits.get(t); if (!h) return;
  if (h.n === 2) { // a dot: ring it
    ctx.strokeStyle = `rgba(${rgb},0.8)`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(h.pts[0], h.pts[1], DOT_R + 3, 0, Math.PI * 2); ctx.stroke(); return;
  }
  ctx.strokeStyle = `rgba(${rgb},0.5)`; ctx.lineWidth = h.w + 3; ctx.lineCap = 'round'; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(h.pts[0], h.pts[1]); for (let i = 2; i < h.n; i += 2) ctx.lineTo(h.pts[i], h.pts[i + 1]); ctx.stroke();
  ctx.globalAlpha = 1;
}

// Arrival pings: two thin rings that spread out from the station and fade
const PING_MS = 2600;
function drawPings(c, now) {
  for (let i = pings.length - 1; i >= 0; i--) if (now - pings[i].t0 > PING_MS + 600) pings.splice(i, 1);
  c.lineWidth = 1.2;
  for (const pg of pings) {
    const p = toScreen(pg.x, pg.y);
    if (p[0] < -200 || p[1] < -200 || p[0] > W + 200 || p[1] > H + 200) continue;
    for (const delay of [0, 500]) {
      const k = (now - pg.t0 - delay) / PING_MS; if (k < 0 || k > 1) continue;
      const e = 1 - (1 - k) ** 3, r = 4 + 130 * e, al = 0.38 * (1 - k) ** 2;
      c.strokeStyle = `rgba(${pg.rgb},${al.toFixed(3)})`;
      c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.stroke();
    }
    const k0 = (now - pg.t0) / 900;
    if (k0 < 1) { c.fillStyle = `rgba(${pg.rgb},${(0.5 * (1 - k0)).toFixed(3)})`; c.beginPath(); c.arc(p[0], p[1], 3.5, 0, Math.PI * 2); c.fill(); }
  }
}

// ---------- loading screen ----------
// The map stays covered until the country-wide terrain, the first full-resolution base map and
// the first train report are all in, so nothing pops in after it appears
const loading = {
  tiles: null, mapReady: false, done: false, t0: performance.now(),
  step() {
    if (this.done) return;
    const tiles = this.tiles, tf = tiles && tiles.total ? tiles.done / tiles.total : 0;
    const p = 0.15 + 0.55 * tf + (this.mapReady ? 0.15 : 0) + (firstPollDone ? 0.15 : 0);
    $('veilBar').style.transform = `scaleX(${Math.min(1, p)})`;
    $('veilMsg').textContent = tf < 1 ? `Loading terrain · ${tiles ? tiles.done : 0} of ${tiles ? tiles.total : '…'} tiles` : !firstPollDone ? 'Finding trains' : 'Drawing the map';
    if ((this.mapReady && firstPollDone) || performance.now() - this.t0 > 15000) {
      this.done = true; $('veil').classList.add('gone');
      setTimeout(() => $('veil').remove(), 800);
    }
  },
};
setTimeout(() => loading.step(), 15200);

// ---------- frame loop ----------
let lastT = performance.now(), lastVX = NaN, lastVY = NaN, lastVS = NaN, clipCache = { key: '', near: false };
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  stepTrains(dt);
  if (stepFlight(now)) { /* the flight moves the camera */ }
  else if (follow) {
    const t = trains.get(follow);
    if (!t) setFollow(null);
    else {
      pointAt(t.route, t.sDisp, tmpA);
      const k = Math.min(1, dt * 4), mx = (tmpA[0] - view.x) * k, my = (tmpA[1] - view.y) * k;
      view.x += mx; view.y += my;
      if (Math.hypot(mx, my) * view.s > 2) lastViewChange = now; // still flying to the train: treat as moving
      if (goal.active) { goal.ax = view.x; goal.ay = view.y; goal.sx = W / 2; goal.sy = H / 2; } }
  }
  applyZoom(Math.min(1, dt * 9));
  const viewChanged = view.x !== lastVX || view.y !== lastVY || view.s !== lastVS;
  if (viewChanged) { lastVX = view.x; lastVY = view.y; lastVS = view.s; if (!follow || goal.active || drag || pinch) lastViewChange = now; hoverDirty = true; }
  requestBase(now);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawBase(now);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const pad = 400 / view.s + 50;
  const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(W, H);
  const order = [];
  for (const t of trains.values()) {
    pointAt(t.route, t.sDisp, tmpA);
    if (tmpA[0] < vx0 - pad || tmpA[0] > vx1 + pad || tmpA[1] < vy0 - pad || tmpA[1] > vy1 + pad) continue;
    order.push(t);
  }
  // Glows, trails and pings never spill past the US outline. Clipping is skipped when no stretch
  // of outline is near the view, and uses a coarser outline when zoomed out.
  const ck = Math.round(vx0) + ',' + Math.round(vy0) + ',' + Math.round(vx1) + ',' + Math.round(vy1);
  if (ck !== clipCache.key) {
    const gm = 300 / view.s;
    clipCache = { key: ck, near: coastBoxes.some(b => b[2] >= vx0 - gm && b[0] <= vx1 + gm && b[3] >= vy0 - gm && b[1] <= vy1 + gm) };
  }
  if (order.length || pings.length) {
    ctx.save();
    if (clipCache.near) {
      ctx.setTransform(view.s * DPR, 0, 0, view.s * DPR, (W / 2 - view.x * view.s) * DPR, (H / 2 - view.y * view.s) * DPR);
      ctx.clip(landClip(view.s), 'evenodd');
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const G = geom(view.s);
    for (const t of order) drawTrainFx(ctx, t, G);
    drawPings(ctx, now);
    ctx.restore();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  drawTrains(order);
  const sel = hovered && trains.has(hovered.id) ? hovered : null, fol = follow ? trains.get(follow) : null;
  if (fol && order.includes(fol)) drawSelected(fol);
  if (sel && sel !== fol && order.includes(sel)) drawSelected(sel);
  if (hoveredStation) {
    const p = toScreen(hoveredStation.x, hoveredStation.y);
    ctx.strokeStyle = COL.hoverRing; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.stroke();
  }
  // Hover is re-checked when the pointer or map moves, and a few times a second as trains move
  if (mouseIn && (hoverDirty || now - lastHover > 150)) { hover(now); hoverDirty = false; lastHover = now; }
  renderInfo(now);
  requestAnimationFrame(frame);
}

resize();
if (DEBUG) renderDebug();
$('themeBtn').onclick = () => setTheme(theme === 'dark' ? 'light' : 'dark');
$('themeBtn').setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
$('themeBtn').setAttribute('aria-pressed', String(theme === 'light'));
startRenderer();
requestAnimationFrame(frame);
poll();
})();
