// ---------- terrain and street detail (loaded as tiles while you zoom) ----------
// Elevation: AWS Terrain Tiles (Terrarium PNG). Streets, water, buildings: OpenFreeMap vector tiles
// (OpenMapTiles schema). Tiles are decoded, contoured and reprojected to the map's Albers km grid
// in a worker so following a train never stutters.
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const VEC_TILEJSON = 'https://tiles.openfreemap.org/planet';

function tileWorker() {
  const R = 6371, rad = Math.PI / 180;
  const P1 = 29.5 * rad, P2 = 45.5 * rad, L0 = -96 * rad, F0 = 37.5 * rad;
  const N = (Math.sin(P1) + Math.sin(P2)) / 2, C = Math.cos(P1) ** 2 + 2 * N * Math.sin(P1);
  const RHO0 = Math.sqrt(C - 2 * N * Math.sin(F0)) / N;
  const out = [0, 0];
  // tile fraction (fx, fy in 0..1) -> Albers km, written into out
  function tp(z, x, y, fx, fy) {
    const n = 2 ** z, lon = ((x + fx) / n) * 2 * Math.PI - Math.PI;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + fy) / n)));
    const t = N * (lon - L0), r = Math.sqrt(C - 2 * N * Math.sin(lat)) / N;
    out[0] = R * r * Math.sin(t); out[1] = -R * (RHO0 - r * Math.cos(t));
    return out;
  }

  // ---- minimal protobuf / Mapbox Vector Tile reader ----
  function decodeMVT(buf) {
    let pos = 0;
    const varint = () => { let v = 0, s = 1, b; do { b = buf[pos++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
    const skip = (w) => { if (w === 0) varint(); else if (w === 1) pos += 8; else if (w === 2) pos += varint(); else if (w === 5) pos += 4; };
    const str = (end) => new TextDecoder().decode(buf.subarray(pos, end));
    const packed = () => { const len = varint(), end = pos + len, a = []; while (pos < end) a.push(varint()); return a; };
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const layers = [];
    while (pos < buf.length) {
      const k = varint();
      if (k >> 3 !== 3 || (k & 7) !== 2) { skip(k & 7); continue; }
      const lend = varint() + pos, L = { name: '', extent: 4096, keys: [], values: [], features: [] };
      while (pos < lend) {
        const kk = varint(), f = kk >> 3, w = kk & 7;
        if (f === 1 && w === 2) { const e = varint() + pos; L.name = str(e); pos = e; }
        else if (f === 2 && w === 2) {
          const fend = varint() + pos, F = { type: 0, tags: [], geom: [] };
          while (pos < fend) { const fk = varint(), ff = fk >> 3, fw = fk & 7;
            if (ff === 2 && fw === 2) F.tags = packed(); else if (ff === 3 && fw === 0) F.type = varint(); else if (ff === 4 && fw === 2) F.geom = packed(); else skip(fw); }
          L.features.push(F);
        } else if (f === 3 && w === 2) { const e = varint() + pos; L.keys.push(str(e)); pos = e; }
        else if (f === 4 && w === 2) {
          const vend = varint() + pos; let val = null;
          while (pos < vend) { const vk = varint(), vf = vk >> 3, vw = vk & 7;
            if (vf === 1 && vw === 2) { const e = varint() + pos; val = str(e); pos = e; }
            else if (vf === 2 && vw === 5) { val = dv.getFloat32(pos, true); pos += 4; }
            else if (vf === 3 && vw === 1) { val = dv.getFloat64(pos, true); pos += 8; }
            else if (vw === 0) { const v = varint(); val = vf === 6 ? (v % 2 ? -(v + 1) / 2 : v / 2) : vf === 7 ? !!v : v; }
            else skip(vw); }
          L.values.push(val);
        } else if (f === 5 && w === 0) L.extent = varint();
        else skip(w);
      }
      layers.push(L);
    }
    return layers;
  }
  function geomParts(g) { // -> array of [x0,y0,x1,y1,...] parts in tile units, closed flag per part
    const parts = []; let x = 0, y = 0, cur = null, i = 0;
    while (i < g.length) {
      const c = g[i++], id = c & 7, cnt = c >> 3;
      if (id === 7) { if (cur) cur.closed = true; continue; }
      for (let k = 0; k < cnt; k++) {
        const dx = g[i++], dy = g[i++];
        x += (dx >>> 1) ^ -(dx & 1); y += (dy >>> 1) ^ -(dy & 1);
        if (id === 1) { cur = { pts: [x, y], closed: false }; parts.push(cur); } else if (cur) cur.pts.push(x, y);
      }
    }
    return parts;
  }
  const ROAD = { motorway: 'road1', trunk: 'road1', primary: 'road2', secondary: 'road2', tertiary: 'road3', minor: 'road3', service: 'road4', track: 'road4', path: 'road4', rail: 'rail', transit: 'rail' };
  function groupOf(layer, type, props) {
    const cl = props.class;
    if (layer === 'water' && type === 3) return 'water';
    if (layer === 'waterway' && type === 2) return cl === 'river' ? 'river' : 'stream';
    if (layer === 'transportation' && type === 2) return ROAD[cl] || null;
    if (layer === 'building' && type === 3) return 'building';
    if ((layer === 'landcover' && (cl === 'wood' || cl === 'grass')) || (layer === 'park' && type === 3)) return type === 3 ? 'green' : null;
    return null;
  }
  async function bytesOf(url) {
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    let b = new Uint8Array(await res.arrayBuffer());
    if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return b;
  }
  async function vector({ url, z, x, y }) {
    const layers = decodeMVT(await bytesOf(url)), groups = {};
    for (const L of layers) for (const F of L.features) {
      const props = {}; for (let i = 0; i < F.tags.length; i += 2) props[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]];
      const g = groupOf(L.name, F.type, props); if (!g) continue;
      const G = groups[g] || (groups[g] = { coords: [], starts: [], closed: F.type === 3 });
      for (const part of geomParts(F.geom)) {
        if (part.pts.length < 4) continue;
        G.starts.push(G.coords.length);
        for (let i = 0; i < part.pts.length; i += 2) { tp(z, x, y, part.pts[i] / L.extent, part.pts[i + 1] / L.extent); G.coords.push(out[0], out[1]); }
      }
    }
    const res = {}, transfer = [];
    for (const [k, G] of Object.entries(groups)) {
      const coords = new Float32Array(G.coords), starts = new Uint32Array(G.starts);
      res[k] = { coords, starts, closed: G.closed }; transfer.push(coords.buffer, starts.buffer);
    }
    return [{ groups: res }, transfer];
  }

  // ---- elevation: hillshade image + contour lines ----
  const INTERVAL = { 8: 100, 9: 100, 10: 50, 11: 50, 12: 20, 13: 10, 14: 10 };
  async function dem({ url, z, x, y }) {
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const S = 256, oc = new OffscreenCanvas(S, S), g = oc.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0); const px = g.getImageData(0, 0, S, S).data;
    let e = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) e[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;

    // Hillshade (light from the northwest), as translucent dark/light pixels
    const latC = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z)));
    const mpp = 40075016.7 * Math.cos(latC) / (S * 2 ** z);
    const ex = z <= 6 ? 7 : z <= 8 ? 4 : z <= 10 ? 2.5 : 1.6;
    const zen = 45 * rad, az = 135 * rad, flat = Math.cos(zen);
    const img = new Uint8ClampedArray(S * S * 4);
    const at = (i, j) => e[Math.min(S - 1, Math.max(0, j)) * S + Math.min(S - 1, Math.max(0, i))];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const o = (j * S + i) * 4, h = e[j * S + i];
      if (h <= 0) continue;
      const dzdx = (at(i + 1, j) - at(i - 1, j)) / (2 * mpp) * ex, dzdy = (at(i, j + 1) - at(i, j - 1)) / (2 * mpp) * ex;
      const slope = Math.atan(Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
      const sh = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect), d = sh - flat;
      if (d < 0) { img[o] = 8; img[o + 1] = 11; img[o + 2] = 14; img[o + 3] = Math.min(150, -d * 300); }
      else { img[o] = 205; img[o + 1] = 222; img[o + 2] = 228; img[o + 3] = Math.min(26, d * 70); }
    }
    // 5x5 warp grid: tile fractions -> Albers km, so the image can be drawn in small affine pieces
    const grid = new Float32Array(50);
    for (let b = 0; b <= 4; b++) for (let a = 0; a <= 4; a++) { tp(z, x, y, a / 4, b / 4); grid[(b * 5 + a) * 2] = out[0]; grid[(b * 5 + a) * 2 + 1] = out[1]; }

    // Contours on a lightly smoothed grid, padded by one sample so lines reach the tile edge
    const iv = INTERVAL[z] || 0, segs = [], major = [];
    if (iv) {
      const passes = z >= 12 ? 3 : 1;
      for (let p = 0; p < passes; p++) {
        const t = new Float32Array(S * S);
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
          let s = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += at(i + di, j + dj);
          t[j * S + i] = s / 9;
        }
        e = t;
      }
      const G = S + 2, pos = new Float32Array(G);
      for (let k = 0; k < G; k++) pos[k] = k === 0 ? 0 : k === G - 1 ? 1 : (k - 0.5) / S;
      const val = (a, b) => at(a - 1, b - 1);
      const emit = (L, ax, ay, bx, by) => {
        const arr = Math.round(L / iv) % 5 === 0 ? major : segs;
        tp(z, x, y, ax, ay); arr.push(out[0], out[1]); tp(z, x, y, bx, by); arr.push(out[0], out[1]);
      };
      for (let b = 0; b < G - 1; b++) for (let a = 0; a < G - 1; a++) {
        const v0 = val(a, b), v1 = val(a + 1, b), v2 = val(a + 1, b + 1), v3 = val(a, b + 1);
        const lo = Math.min(v0, v1, v2, v3), hi = Math.max(v0, v1, v2, v3);
        if (hi <= 0) continue;
        const x0 = pos[a], x1 = pos[a + 1], y0 = pos[b], y1 = pos[b + 1];
        for (let L = Math.max(iv, Math.ceil(lo / iv) * iv); L <= hi; L += iv) {
          if (L === lo) continue;
          const c = (v0 > L ? 1 : 0) | (v1 > L ? 2 : 0) | (v2 > L ? 4 : 0) | (v3 > L ? 8 : 0);
          if (c === 0 || c === 15) continue;
          const f = (p, q) => (L - p) / (q - p);
          const T = [x0 + (x1 - x0) * f(v0, v1), y0], Rr = [x1, y0 + (y1 - y0) * f(v1, v2)];
          const B = [x0 + (x1 - x0) * f(v3, v2), y1], Lf = [x0, y0 + (y1 - y0) * f(v0, v3)];
          const pairs = { 1: [Lf, T], 2: [T, Rr], 3: [Lf, Rr], 4: [Rr, B], 5: [Lf, T, Rr, B], 6: [T, B], 7: [Lf, B],
            8: [B, Lf], 9: [B, T], 10: [T, Rr, B, Lf], 11: [B, Rr], 12: [Rr, Lf], 13: [Rr, T], 14: [T, Lf] }[c];
          for (let k = 0; k < pairs.length; k += 2) emit(L, pairs[k][0], pairs[k][1], pairs[k + 1][0], pairs[k + 1][1]);
        }
      }
    }
    const minor = new Float32Array(segs), maj = new Float32Array(major);
    return [{ img, grid, minor, major: maj }, [img.buffer, grid.buffer, minor.buffer, maj.buffer]];
  }

  self.onmessage = async (ev) => {
    const m = ev.data;
    try {
      const [res, transfer] = m.kind === 'dem' ? await dem(m) : await vector(m);
      self.postMessage({ key: m.key, ...res }, transfer);
    } catch (err) { self.postMessage({ key: m.key, error: String(err && err.message || err) }); }
  };
}

const tiles = (() => {
  let worker = null;
  try { worker = new Worker(URL.createObjectURL(new Blob(['(' + tileWorker.toString() + ')()'], { type: 'text/javascript' }))); }
  catch (_) { /* no detail layers without workers */ }
  const cache = new Map(), queue = [];
  let inflight = 0, vecTemplate = null, vecMax = 14, stamp = 0;

  if (worker) fetch(VEC_TILEJSON).then(r => r.ok ? r.json() : null).then(j => {
    if (j && j.tiles && j.tiles[0]) { vecTemplate = j.tiles[0]; vecMax = Math.min(14, j.maxzoom || 14); baseDirty = true; }
  }).catch(() => {});

  function toPaths(m) {
    if (m.kind === 'dem') {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      cv.getContext('2d').putImageData(new ImageData(m.img, 256, 256), 0, 0);
      const seg = (a) => { const p = new Path2D(); for (let i = 0; i < a.length; i += 4) { p.moveTo(a[i], a[i + 1]); p.lineTo(a[i + 2], a[i + 3]); } return p; };
      return { img: cv, grid: m.grid, minor: m.minor.length ? seg(m.minor) : null, major: m.major.length ? seg(m.major) : null };
    }
    const g = {};
    for (const [k, G] of Object.entries(m.groups)) {
      const p = new Path2D(), c = G.coords, st = G.starts;
      for (let s = 0; s < st.length; s++) {
        const a = st[s], b = s + 1 < st.length ? st[s + 1] : c.length;
        p.moveTo(c[a], c[a + 1]); for (let i = a + 2; i < b; i += 2) p.lineTo(c[i], c[i + 1]);
        if (G.closed) p.closePath();
      }
      g[k] = p;
    }
    return { groups: g };
  }
  if (worker) worker.onmessage = (ev) => {
    const m = ev.data, ent = cache.get(m.key); inflight--;
    if (ent) {
      if (m.error) ent.state = 'error';
      else { m.kind = ent.kind; Object.assign(ent, toPaths(m)); ent.state = 'ready'; baseDirty = true; }
    }
    pump();
  };
  function pump() {
    while (inflight < 6 && queue.length) {
      queue.sort((a, b) => a.prio - b.prio);
      const q = queue.shift(), ent = cache.get(q.key);
      if (!ent || ent.state !== 'queued') continue;
      if (stamp - ent.used > 2) { cache.delete(q.key); continue; } // no longer on screen
      ent.state = 'loading'; inflight++;
      worker.postMessage({ key: q.key, kind: q.kind, url: q.url, z: q.z, x: q.x, y: q.y });
    }
  }
  function get(kind, z, x, y, prio) {
    const key = kind + z + '/' + x + '/' + y;
    let ent = cache.get(key);
    if (!ent) {
      const url = (kind === 'dem' ? DEM_URL : vecTemplate).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      ent = { kind, state: 'queued', used: stamp }; cache.set(key, ent);
      queue.push({ key, kind, url, z, x, y, prio });
    }
    ent.used = stamp;
    return ent;
  }
  function evict() {
    if (cache.size < 260) return;
    const old = [...cache.entries()].filter(([, e]) => e.state === 'ready' || e.state === 'error').sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < old.length && cache.size > 200; i++) cache.delete(old[i][0]);
  }
  const lonLatTile = (lon, lat, z) => {
    const n = 2 ** z, la = Math.max(-85, Math.min(85, lat)) * rad;
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)];
  };
  // Tiles covering the given world rectangle at zoom z, nearest the center first. Falls back to a
  // loaded ancestor for tiles still on their way, so detail never blinks out while zooming.
  function cover(kind, z, x0, y0, x1, y1, minZ) {
    let lo0 = 180, lo1 = -180, la0 = 90, la1 = -90;
    for (let k = 0; k <= 6; k++) for (const [x, y] of [[x0 + (x1 - x0) * k / 6, y0], [x0 + (x1 - x0) * k / 6, y1], [x0, y0 + (y1 - y0) * k / 6], [x1, y0 + (y1 - y0) * k / 6]]) {
      const [lon, lat] = unproject(x, y); lo0 = Math.min(lo0, lon); lo1 = Math.max(lo1, lon); la0 = Math.min(la0, lat); la1 = Math.max(la1, lat);
    }
    lo0 = Math.max(lo0, -127); lo1 = Math.min(lo1, -65); la0 = Math.max(la0, 23); la1 = Math.min(la1, 50);
    if (lo0 > lo1 || la0 > la1) return { list: [], ready: 1 };
    let tx0, ty0, tx1, ty1;
    for (;;) {
      [tx0, ty1] = lonLatTile(lo0, la0, z); [tx1, ty0] = lonLatTile(lo1, la1, z);
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 48 || z <= minZ) break;
      z--;
    }
    const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2, out = [], seen = new Set(); let ready = 0, total = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      total++;
      const e = get(kind, z, tx, ty, Math.hypot(tx - cx, ty - cy));
      if (e.state === 'ready') { ready++; out.push(e); continue; }
      for (let pz = z - 1, px = tx >> 1, py = ty >> 1; pz >= Math.max(minZ, z - 4); pz--, px >>= 1, py >>= 1) {
        const pk = kind + pz + '/' + px + '/' + py, pe = cache.get(pk);
        if (pe && pe.state === 'ready') { if (!seen.has(pk)) { seen.add(pk); pe.used = stamp; out.unshift(pe); } break; }
      }
    }
    return { list: out, ready: total ? ready / total : 1, z };
  }
  return {
    enabled: () => !!worker,
    hasVector: () => !!vecTemplate,
    vecMax: () => vecMax,
    begin() { stamp++; },
    end() { evict(); pump(); },
    cover,
  };
})();
