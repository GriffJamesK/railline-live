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
const Q = 0.05; // km per unit

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
let E = edges.map(([a, b, pts]) => [a, b, pts.map(([lo, la]) => proj(lo, la))]);
const st = JSON.parse(fs.readFileSync(S + 'dn_amtrak-stations.geojson'));
const stations = {}, stationNames = {};
for (const f of st.features) {
  const [lo, la] = f.geometry.coordinates; if (!inBox(lo, la)) continue;
  const P = proj(lo, la); let best = { d: 1e9 };
  E.forEach((e, ei) => {
    const p = e[2];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
      let t = Math.max(0, Math.min(1, ((P[0] - ax) * dx + (P[1] - ay) * dy) / L));
      const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x - P[0], y - P[1]);
      if (d < best.d) best = { d, ei, i, x, y };
    }
  });
  const code = f.properties.STNCODE;
  stationNames[code] = f.properties.STNNAME;
  if (best.d > 3) { stations[code] = [-1, Math.round(P[0] / Q), Math.round(P[1] / Q)]; continue; }
  const e = E[best.ei], p = e[2];
  let id;
  const first = Math.hypot(best.x - p[0][0], best.y - p[0][1]) < 0.05, last = Math.hypot(best.x - p[p.length-1][0], best.y - p[p.length-1][1]) < 0.05;
  if (first) id = e[0]; else if (last) id = e[1];
  else {
    id = nodes.length; nodes.push([best.x, best.y]);
    const A = p.slice(0, best.i + 1).concat([[best.x, best.y]]), B = [[best.x, best.y]].concat(p.slice(best.i + 1));
    E[best.ei] = [e[0], id, A]; E.push([id, e[1], B]);
  }
  stations[code] = [id, Math.round(nodes[id][0] / Q), Math.round(nodes[id][1] / Q)];
}
const edgeOut = E.map(([a, b, pts]) => [a, b, enc(simplify(pts, 0.06))]);
const nodeOut = nodes.map(([x, y]) => [Math.round(x / Q), Math.round(y / Q)]);
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
  q: Q,
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
