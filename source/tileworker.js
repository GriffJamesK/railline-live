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

  const td = new TextDecoder();
  // ---- minimal protobuf / Mapbox Vector Tile reader ----
  function decodeMVT(buf) {
    let pos = 0;
    const varint = () => { let v = 0, s = 1, b; do { b = buf[pos++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
    const skip = (w) => { if (w === 0) varint(); else if (w === 1) pos += 8; else if (w === 2) pos += varint(); else if (w === 5) pos += 4; };
    const str = (end) => td.decode(buf.subarray(pos, end));
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
    const at = (i, j) => e[Math.min(S - 1, Math.max(0, j)) * S + Math.min(S - 1, Math.max(0, i))];
    const blur = (passes) => {
      for (let p = 0; p < passes; p++) {
        const t = new Float32Array(S * S);
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
          let s = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += at(i + di, j + dj);
          t[j * S + i] = s / 9;
        }
        e = t;
      }
    };
    blur(z >= 13 ? 3 : z >= 11 ? 2 : 1); // smooths the data's 1 m height steps, which otherwise shade as stripes on flat ground

    // Hillshade (light from the northwest), as translucent dark/light pixels
    const latC = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z)));
    const mpp = 40075016.7 * Math.cos(latC) / (S * 2 ** z);
    const ex = z <= 6 ? 7 : z <= 8 ? 4 : z <= 10 ? 2.5 : 1.6;
    const zen = 45 * rad, az = 135 * rad, flat = Math.cos(zen);
    const img = new Uint8ClampedArray(S * S * 4);
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
      blur(z >= 12 ? 2 : 1);
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
