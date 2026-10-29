// Builds the embedded geometry for the train map: state borders, coastline,
// roads, the Amtrak track graph and station coordinates, all pre-projected to
// Albers km coordinates and delta-encoded at 50 m resolution.
const fs = require('fs');
const topo = require('topojson-client');
const S = '/tmp/claude-0/-home-user/079675e6-996f-5c18-9fdd-43694fa93efb/scratchpad/';

const R = 6371, rad = Math.PI / 180;
const p1 = 29.5 * rad, p2 = 45.5 * rad, l0 = -96 * rad, f0 = 37.5 * rad;
const n = (Math.sin(p1) + Math.sin(p2)) / 2, C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
const r0 = Math.sqrt(C - 2 * n * Math.sin(f0)) / n;
function proj(lon, lat) {
  const t = n * (lon * rad - l0), r = Math.sqrt(C - 2 * n * Math.sin(lat * rad)) / n;
  return [R * r * Math.sin(t), -R * (r0 - r * Math.cos(t))]; // y down
}
const inBox = (lon, lat) => lon > -126 && lon < -65 && lat > 23 && lat < 50.5;
const Q = 0.05; // km per unit (background layers)
const QT = 0.005; // km per unit for the track network, stations and graph nodes: 5 m, so curves stay smooth up close
function encT(pts) { // track coordinates at QT
  const out = []; let px = 0, py = 0;
  for (const [x, y] of pts) { const qx = Math.round(x / QT), qy = Math.round(y / QT); out.push(qx - px, qy - py); px = qx; py = qy; }
  return out;
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      let t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - pts[i][0], ey = ay + t * dy - pts[i][1], d = ex * ex + ey * ey;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function enc(pts) { // projected km pts -> delta ints
  const out = []; let px = 0, py = 0;
  for (const [x, y] of pts) { const qx = Math.round(x / Q), qy = Math.round(y / Q); out.push(qx - px, qy - py); px = qx; py = qy; }
  return out;
}
function lines(coordsList, tol, clip = true) {
  const res = [];
  for (const cs of coordsList) {
    let cur = [];
    const flush = () => { if (cur.length > 1) { const s = simplify(cur, tol); if (s.length > 1) res.push(enc(s)); } cur = []; };
    for (const [lon, lat] of cs) { if (!clip || inBox(lon, lat)) cur.push(proj(lon, lat)); else flush(); }
    flush();
  }
  return res;
}

// States + coastline
const us = JSON.parse(fs.readFileSync(__dirname + '/node_modules/us-atlas/states-10m.json'));
const lower48 = g => !['02', '15', '60', '66', '69', '72', '78'].includes(g.id);
const sg = us.objects.states.geometries.filter(lower48);
const borders = topo.mesh(us, { type: 'GeometryCollection', geometries: sg }, (a, b) => a !== b);
const coast = topo.mesh(us, { type: 'GeometryCollection', geometries: sg }, (a, b) => a === b);
const land = topo.merge(us, sg);

// Roads
const ne = JSON.parse(fs.readFileSync(S + 'ne_roads.geojson'));
const roads = { major: [], minor: [] };
for (const f of ne.features) {
  const p = f.properties; if (p.sov_a3 !== 'USA' || p.type === 'Ferry Route') continue;
  const g = f.geometry, cl = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  const major = p.type === 'Major Highway' || p.type === 'Beltway' || p.scalerank <= 4;
  roads[major ? 'major' : 'minor'].push(...lines(cl, 0.15));
}

// Track graph: merge degree-2 chains between junctions
const tr = JSON.parse(fs.readFileSync(S + 'dn_amtrak-track.geojson'));
const segs = tr.features.filter(f => f.properties.NET !== 'X' || true).map(f => ({
  a: f.properties.FRFRANODE, b: f.properties.TOFRANODE, c: f.geometry.coordinates
}));
// Use coordinate endpoints rather than FRA node ids so gaps in ids don't break topology
const key = ([lon, lat]) => lon.toFixed(5) + ',' + lat.toFixed(5);
const adj = new Map();
segs.forEach((s, i) => {
  s.ka = key(s.c[0]); s.kb = key(s.c[s.c.length - 1]);
  for (const k of [s.ka, s.kb]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }
});
// Snap near-coincident endpoints (<30 m) together
const keys = [...adj.keys()], grid = new Map(), cell = 0.002;
const parent = new Map(keys.map(k => [k, k]));
const find = k => { while (parent.get(k) !== k) k = parent.get(k); return k; };
for (const k of keys) {
  const [lon, lat] = k.split(',').map(Number), gx = Math.floor(lon / cell), gy = Math.floor(lat / cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const o of grid.get((gx + dx) + ':' + (gy + dy)) || []) {
    const [ol, oa] = o.split(',').map(Number);
    if (Math.hypot((ol - lon) * Math.cos(lat * rad), oa - lat) < 0.0003) parent.set(find(k), find(o));
  }
  const g = gx + ':' + gy; if (!grid.has(g)) grid.set(g, []); grid.get(g).push(k);
}
const deg = new Map();
segs.forEach(s => { s.ka = find(s.ka); s.kb = find(s.kb); for (const k of [s.ka, s.kb]) deg.set(k, (deg.get(k) || 0) + 1); });
const nodeKeys = [...deg.keys()].filter(k => deg.get(k) !== 2);
const inc = new Map(); segs.forEach((s, i) => { for (const k of [s.ka, s.kb]) { if (!inc.has(k)) inc.set(k, []); inc.get(k).push(i); } });
const used = new Uint8Array(segs.length), edges = [];
const nodeId = new Map(); const nodes = [];
const nid = k => { if (!nodeId.has(k)) { nodeId.set(k, nodes.length); const [lo, la] = k.split(',').map(Number); nodes.push(proj(lo, la)); } return nodeId.get(k); };
function walk(start, si) {
  let k = start, pts = [], i = si;
  while (true) {
    used[i] = 1; const s = segs[i];
    const fwd = s.ka === k; const c = fwd ? s.c : [...s.c].reverse();
    pts.push(...(pts.length ? c.slice(1) : c));
    k = fwd ? s.kb : s.ka;
    if (deg.get(k) !== 2) break;
    const nx = inc.get(k).find(j => !used[j]); if (nx === undefined) break; i = nx;
  }
  return { k, pts };
}
for (const k of nodeKeys) for (const i of inc.get(k)) if (!used[i]) {
  const { k: end, pts } = walk(k, i);
  edges.push([nid(k), nid(end), pts]);
}
for (let i = 0; i < segs.length; i++) if (!used[i]) { // pure loops
  const { k: end, pts } = walk(segs[i].ka, i); edges.push([nid(segs[i].ka), nid(end), pts]);
}
// Project, then split edges at stations so every on-network station is a graph node
let E = edges.map(([a, b, pts]) => [a, b, pts.map(([lo, la]) => proj(lo, la)), 1]);
const st = JSON.parse(fs.readFileSync(S + 'dn_amtrak-stations.geojson'));
const SNAP_KM = 5; // a station joins the track network if it's within this distance of track
const distToTrack = (P) => {
  let best = 1e9;
  for (const e of E) { const q = e[2]; for (let i = 0; i < q.length - 1; i++) {
    const [ax, ay] = q[i], [bx, by] = q[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((P[0] - ax) * dx + (P[1] - ay) * dy) / L)); best = Math.min(best, Math.hypot(ax + t * dx - P[0], ay + t * dy - P[1]));
  } }
  return best;
};
// Supplement: the FRA track layer predates some current Amtrak service (e.g. the Gulf Coast line
// to Mobile, restored in 2025). Around stations it misses, Natural Earth railroads are added as extra
// track, at a routing penalty so FRA track is preferred wherever both exist.
{
  const orphans = st.features.map(f => f.geometry.coordinates).filter(([lo, la]) => inBox(lo, la)).map(([lo, la]) => proj(lo, la)).filter(P => distToTrack(P) > SNAP_KM);
  const ne = JSON.parse(fs.readFileSync(S + 'ne/ne_10m_railroads_north_america.geojson')).features.filter(f => f.properties.sov_a3 === 'USA' && f.geometry);
  const keyMap = new Map(); let added = 0;
  const nodeAt = (lo, la) => { const k = lo.toFixed(4) + ',' + la.toFixed(4); if (!keyMap.has(k)) { keyMap.set(k, nodes.length); nodes.push(proj(lo, la)); } return keyMap.get(k); };
  for (const f of ne) {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const cs of parts) {
      if (cs.length < 2 || !cs.some(([lo, la]) => { const P = proj(lo, la); return orphans.some(O => Math.hypot(O[0] - P[0], O[1] - P[1]) < 80); })) continue;
      const a = nodeAt(...cs[0]), b = nodeAt(...cs[cs.length - 1]);
      E.push([a, b, cs.map(([lo, la]) => proj(lo, la)), 1.4]); added++;
    }
  }
  console.log(`supplement: ${orphans.length} stations off FRA track, ${added} Natural Earth rail lines added`);
}
const stations = {}, stationNames = {};
for (const f of st.features) {
  const [lo, la] = f.geometry.coordinates; if (!inBox(lo, la)) continue;
  const P = proj(lo, la); let bestFra = { d: 1e9 }, bestAny = { d: 1e9 };
  E.forEach((e, ei) => {
    const p = e[2];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
      let t = Math.max(0, Math.min(1, ((P[0] - ax) * dx + (P[1] - ay) * dy) / L));
      const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x - P[0], y - P[1]);
      if (d < bestAny.d) bestAny = { d, ei, i, x, y };
      if (e[3] === 1 && d < bestFra.d) bestFra = { d, ei, i, x, y };
    }
  });
  const best = bestFra.d <= SNAP_KM ? bestFra : bestAny; // FRA track first; supplementary only if none is near
  const code = f.properties.STNCODE;
  stationNames[code] = f.properties.STNNAME;
  if (best.d > SNAP_KM) { stations[code] = [-1, Math.round(P[0] / QT), Math.round(P[1] / QT)]; continue; }
  const e = E[best.ei], p = e[2];
  let id;
  const first = Math.hypot(best.x - p[0][0], best.y - p[0][1]) < 0.05, last = Math.hypot(best.x - p[p.length-1][0], best.y - p[p.length-1][1]) < 0.05;
  if (first) id = e[0]; else if (last) id = e[1];
  else {
    id = nodes.length; nodes.push([best.x, best.y]);
    const A = p.slice(0, best.i + 1).concat([[best.x, best.y]]), B = [[best.x, best.y]].concat(p.slice(best.i + 1));
    E[best.ei] = [e[0], id, A, e[3]]; E.push([id, e[1], B, e[3]]);
  }
  stations[code] = [id, Math.round(nodes[id][0] / QT), Math.round(nodes[id][1] / QT)];
}
// Bridge gaps in the source data: dead ends that stop just short of other track (common at
// junctions, river crossings and terminal approaches) are joined with a short connector, so routes
// follow the track instead of falling back to straight lines between stations.
{
  const deg = new Array(nodes.length).fill(0), inc = nodes.map(() => new Set());
  E.forEach(([a, b], ei) => { deg[a]++; deg[b]++; inc[a].add(ei); inc[b].add(ei); });
  const dead = deg.map((d, i) => d === 1 ? i : -1).filter(i => i >= 0);
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const shareEdge = (m, n) => [...inc[m]].some(e => inc[n].has(e));
  // 1) facing dead ends within 5 km, closest pairs first
  const pairs = [];
  for (let i = 0; i < dead.length; i++) for (let j = i + 1; j < dead.length; j++) {
    const d = dist(nodes[dead[i]], nodes[dead[j]]);
    if (d < 5 && !shareEdge(dead[i], dead[j])) pairs.push([d, dead[i], dead[j]]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const joined = new Set(); let nPair = 0, nEdge = 0;
  for (const [d, m, n] of pairs) {
    if (joined.has(m) || joined.has(n)) continue;
    E.push([m, n, [nodes[m], nodes[n]], 1]); joined.add(m); joined.add(n); nPair++;
  }
  // 2) other dead ends: to the nearest point on any track within 3 km
  for (const n of dead) {
    if (joined.has(n)) continue;
    const P = nodes[n]; let best = { d: 3 };
    E.forEach((e, ei) => {
      if (e[0] === n || e[1] === n) return;
      const q = e[2];
      for (let i = 0; i < q.length - 1; i++) {
        const [ax, ay] = q[i], [bx, by] = q[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((P[0] - ax) * dx + (P[1] - ay) * dy) / L)), x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x - P[0], y - P[1]);
        if (d < best.d) best = { d, ei, i, x, y };
      }
    });
    if (best.ei == null) continue;
    const e = E[best.ei], q = e[2];
    let id;
    if (dist([best.x, best.y], q[0]) < 0.05) id = e[0];
    else if (dist([best.x, best.y], q[q.length - 1]) < 0.05) id = e[1];
    else {
      id = nodes.length; nodes.push([best.x, best.y]);
      E[best.ei] = [e[0], id, q.slice(0, best.i + 1).concat([[best.x, best.y]]), e[3]];
      E.push([id, e[1], [[best.x, best.y]].concat(q.slice(best.i + 1)), e[3]]);
    }
    E.push([n, id, [P, [best.x, best.y]], 1]); joined.add(n); nEdge++;
  }
  console.log(`gap bridging: ${dead.length} dead ends, ${nPair} joined in pairs, ${nEdge} joined to nearby track`);
}
// Only points that add less than 3 m of shape are dropped; the page smooths the rest into curves
const edgeOut = E.map(([a, b, pts, w]) => w === 1 ? [a, b, encT(simplify(pts, 0.003))] : [a, b, encT(simplify(pts, 0.003)), w]);
const nodeOut = nodes.map(([x, y]) => [Math.round(x / QT), Math.round(y / QT)]);
// connectivity report
const g = nodes.map(() => []); E.forEach(([a, b]) => { g[a].push(b); g[b].push(a); });
const comp = new Int32Array(nodes.length).fill(-1); let nc = 0; const sizes = [];
for (let i = 0; i < nodes.length; i++) if (comp[i] < 0) { let q = [i], c = 0; comp[i] = nc; while (q.length) { const u = q.pop(); c++; for (const v of g[u]) if (comp[v] < 0) { comp[v] = nc; q.push(v); } } sizes.push(c); nc++; }
console.log('components', nc, sizes.sort((a, b) => b - a).slice(0, 10));
const cc = c => stations[c] && stations[c][0] >= 0 ? comp[stations[c][0]] : 'off';
console.log(['SEA','LAX','NYP','CHI','NOL','MIA','BOS','WAS','EMY','DEN','SLC','ABQ','SAS','ATL','ALB','MKE','STL','PDX','SPK'].map(c => c + ':' + cc(c)).join(' '));
console.log('offnet', Object.entries(stations).filter(([k, v]) => v[0] < 0).map(([k]) => k).join(' '));

// Rivers and lakes (Natural Earth) for country and state zooms
const readNE = f => JSON.parse(fs.readFileSync(S + 'ne/' + f + '.geojson')).features;
const geomLines = g => !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
const rivers = { major: [], minor: [] };
for (const f of readNE('ne_10m_rivers_lake_centerlines')) rivers[f.properties.scalerank <= 6 ? 'major' : 'minor'].push(...lines(geomLines(f.geometry), 0.25));
for (const f of readNE('ne_10m_rivers_north_america')) rivers.minor.push(...lines(geomLines(f.geometry), 0.25));
const lakes = [];
for (const f of [...readNE('ne_10m_lakes'), ...readNE('ne_10m_lakes_north_america')]) {
  const g = f.geometry; if (!g) continue; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    const [lo, la] = poly[0][0]; if (!inBox(lo, la)) continue;
    lakes.push(...lines(poly, 0.15, false));
  }
}

const data = {
  q: Q, qt: QT,
  land: lines(land.coordinates.flat(), 0.4, false),
  coast: lines(coast.coordinates, 0.3, false),
  borders: lines(borders.coordinates, 0.4, false),
  roadsMajor: roads.major, roadsMinor: roads.minor,
  riversMajor: rivers.major, riversMinor: rivers.minor, lakes,
  nodes: nodeOut, edges: edgeOut, stations, stationNames,
};
const js = 'const GEO=' + JSON.stringify(data) + ';';
fs.writeFileSync(S + 'geo.js', js);
console.log('nodes', nodes.length, 'edges', edges.length, 'stations', Object.keys(stations).length);
for (const k of Object.keys(data)) console.log(k, (JSON.stringify(data[k]) || '').length);
console.log('total', js.length);
