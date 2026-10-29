// ---------- base map renderer ----------
// Runs in its own worker (or on the page when workers can't draw). It owns every static layer and
// all tiles, and paints the base map for a requested view into an image. The page only stretches
// and slides the latest image while you drag or zoom, so the map never blocks interaction.
function rendererMain() {
  const R = 6371, rad = Math.PI / 180;
  const P1 = 29.5 * rad, P2 = 45.5 * rad, L0 = -96 * rad, F0 = 37.5 * rad;
  const N = (Math.sin(P1) + Math.sin(P2)) / 2, C = Math.cos(P1) ** 2 + 2 * N * Math.sin(P1);
  const RHO0 = Math.sqrt(C - 2 * N * Math.sin(F0)) / N;
  function proj(lon, lat) {
    const t = N * (lon * rad - L0), r = Math.sqrt(C - 2 * N * Math.sin(lat * rad)) / N;
    return [R * r * Math.sin(t), -R * (RHO0 - r * Math.cos(t))];
  }
  function unproj(x, y) {
    const X = x / R, Y = -y / R, rho = Math.sign(N) * Math.hypot(X, RHO0 - Y), th = Math.atan2(X, RHO0 - Y);
    return [(L0 + th / N) / rad, Math.asin(Math.max(-1, Math.min(1, (C - rho * rho * N * N) / (2 * N)))) / rad];
  }
  const ramp = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  const mk = (w, h) => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(globalThis.document.createElement('canvas'), { width: w, height: h });

  let COL, MARGIN, DEM_URL, VEC_TILEJSON, L = null, dots = [];
  let canvas = null, ctx = null, view = null, shade = null, sctx = null;

  // ---- static layers ----
  function dec(arr, Q) {
    const out = new Float32Array(arr.length); let x = 0, y = 0;
    for (let i = 0; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; out[i] = x * Q; out[i + 1] = y * Q; }
    return out;
  }
  function polyPath(rings, close) {
    const p = new Path2D();
    for (const a of rings) { p.moveTo(a[0], a[1]); for (let i = 2; i < a.length; i += 2) p.lineTo(a[i], a[i + 1]); if (close) p.closePath(); }
    return p;
  }
  // Line layers: one whole-country path for far zooms, plus small bounded chunks so close zooms
  // only stroke what is in view
  function lineLayer(polylines) {
    const CH = 40, chunks = [];
    for (const a of polylines) for (let st = 0; st < a.length - 2; st += CH * 2) {
      const end = Math.min(a.length, st + CH * 2 + 2), p = new Path2D();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = st; i < end; i += 2) {
        const x = a[i], y = a[i + 1]; i === st ? p.moveTo(x, y) : p.lineTo(x, y);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      chunks.push({ p, a: a.subarray(st, end), x0, y0, x1, y1 });
    }
    return { all: polyPath(polylines, false), chunks };
  }
  function init(m) {
    ({ COL, MARGIN, DEM_URL, VEC_TILEJSON } = m);
    const g = m.geo, Q = g.q, D = (k) => g[k].map(a => dec(a, Q));
    L = {
      land: polyPath(D('land'), true), lakes: polyPath(D('lakes'), true),
      coast: lineLayer(D('coast')), borders: lineLayer(D('borders')),
      roadsMajor: lineLayer(D('roadsMajor')), roadsMinor: lineLayer(D('roadsMinor')),
      riversMajor: lineLayer(D('riversMajor')), riversMinor: lineLayer(D('riversMinor')),
      track: Object.assign(lineLayer(m.track), { all: polyPath(m.trackFar, false) }), // chunks for close zooms, light copy for far
    };
    dots = m.dots;
    // Tile decoders: two workers, or inline when nested workers aren't available
    try { for (let i = 0; i < 2; i++) { const w = new Worker(m.tileURL); w.onmessage = onDecoded; decoders.push(w); } }
    catch (_) {
      const fake = { postMessage: (msg) => onDecoded({ data: msg }) };
      new Function('self', m.tileSrc)(fake);
      decoders.push({ postMessage: (msg) => fake.onmessage({ data: msg }) });
    }
    fetch(VEC_TILEJSON).then(r => r.ok ? r.json() : null).then(j => {
      if (j && j.tiles && j.tiles[0]) { vecTemplate = j.tiles[0]; vecMax = Math.min(14, j.maxzoom || 14); requestRender(50); }
    }).catch(() => {});
    preload();
  }

  // ---- tiles ----
  const decoders = [], cache = new Map(), queue = [], lastZ = {};
  let rr = 0, inflight = 0, stamp = 0, vecTemplate = null, vecMax = 14;
  const LIMIT = { dem: 320, vec: 700 };
  const keyOf = (kind, z, x, y) => kind + z + '/' + x + '/' + y;
  function get(kind, z, x, y, prio, pin) {
    const key = keyOf(kind, z, x, y);
    let e = cache.get(key);
    if (!e) {
      e = { kind, z, x, y, key, state: 'queued', used: stamp, pin: !!pin };
      cache.set(key, e); queue.push({ e, prio });
    } else if (e.state === 'queued') { const q = queue.find(q => q.e === e); if (q) q.prio = Math.min(q.prio, prio); }
    e.used = stamp; if (pin) e.pin = true;
    return e;
  }
  function pump() {
    if (!queue.length || inflight >= 8) return;
    queue.sort((a, b) => a.prio - b.prio);
    while (inflight < 8 && queue.length) {
      const { e } = queue.shift();
      if (e.state !== 'queued') continue;
      if (!e.pin && stamp - e.used > 30) { cache.delete(e.key); continue; } // left the view long ago
      const url = (e.kind === 'dem' ? DEM_URL : vecTemplate).replace('{z}', e.z).replace('{x}', e.x).replace('{y}', e.y);
      e.state = 'loading'; inflight++;
      decoders[rr++ % decoders.length].postMessage({ key: e.key, kind: e.kind, url, tmpl: DEM_URL, z: e.z, x: e.x, y: e.y });
    }
  }
  function onDecoded(ev) {
    const m = ev.data, e = cache.get(m.key); inflight--;
    if (e) {
      if (m.error) e.state = 'error';
      else if (e.kind === 'dem') {
        const cv = mk(256, 256); cv.getContext('2d').putImageData(new ImageData(m.img, 256, 256), 0, 0);
        const seg = (a) => { if (!a.length) return null; const p = new Path2D(); for (let i = 0; i < a.length; i += 4) { p.moveTo(a[i], a[i + 1]); p.lineTo(a[i + 2], a[i + 3]); } return p; };
        Object.assign(e, { img: cv, grid: m.grid, minor: seg(m.minor), major: seg(m.major), state: 'ready' });
      } else {
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
        Object.assign(e, { groups: g, state: 'ready' });
        // Detailed main-line rail goes to the page, which snaps trains onto it
        const R = m.groups.rail;
        if (e.z >= 12 && R && R.coords.length) { e.railSent = true; self.postMessage({ type: 'rail', key: e.key, coords: R.coords, starts: R.starts }, [R.coords.buffer, R.starts.buffer]); }
      }
      if (preloading && e.pin) checkPreload();
      if (e.state === 'ready' && e.used >= stamp - 1) requestRender(90);
    }
    pump();
  }
  function evict() {
    for (const kind of ['dem', 'vec']) {
      const all = [...cache.values()].filter(e => e.kind === kind);
      if (all.length <= LIMIT[kind]) continue;
      const old = all.filter(e => !e.pin && e.state !== 'loading' && e.state !== 'queued' && e.used < stamp - 2).sort((a, b) => a.used - b.used);
      for (let i = 0; i < old.length && all.length - i > LIMIT[kind] * 0.85; i++) {
        cache.delete(old[i].key);
        if (old[i].railSent) self.postMessage({ type: 'railGone', key: old[i].key });
      }
    }
  }
  const lonLatTile = (lon, lat, z) => {
    const n = 2 ** z, la = Math.max(-85, Math.min(85, lat)) * rad;
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)];
  };
  const tileLL = (z, x, y) => [x / 2 ** z * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / rad];
  function quadInto(p, z, x, y) { // tile outline in world km, edges subdivided so it follows the projection's curve
    const S = 6; let first = true;
    for (const [ax, ay, bx, by] of [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]]) for (let k = 0; k < S; k++) {
      const f = k / S, [lon, lat] = tileLL(z, x + ax + (bx - ax) * f, y + ay + (by - ay) * f), [px, py] = proj(lon, lat);
      first ? p.moveTo(px, py) : p.lineTo(px, py); first = false;
    }
    p.closePath();
  }
  function lonLatBox(x0, y0, x1, y1) {
    let lo0 = 180, lo1 = -180, la0 = 90, la1 = -90;
    for (let k = 0; k <= 6; k++) for (const [x, y] of [[x0 + (x1 - x0) * k / 6, y0], [x0 + (x1 - x0) * k / 6, y1], [x0, y0 + (y1 - y0) * k / 6], [x1, y0 + (y1 - y0) * k / 6]]) {
      const [lon, lat] = unproj(x, y); lo0 = Math.min(lo0, lon); lo1 = Math.max(lo1, lon); la0 = Math.min(la0, lat); la1 = Math.max(la1, lat);
    }
    return [Math.max(lo0, -127), Math.max(la0, 23), Math.min(lo1, -65), Math.min(la1, 50)];
  }
  function readyDescendants(kind, z, x, y, depth) {
    if (!depth) return null;
    const out = [];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const e = cache.get(keyOf(kind, z + 1, x * 2 + dx, y * 2 + dy));
      if (e && e.state === 'ready') { e.used = stamp; out.push(e); continue; }
      const deeper = readyDescendants(kind, z + 1, x * 2 + dx, y * 2 + dy, depth - 1);
      if (!deeper) return null;
      out.push(...deeper);
    }
    return out;
  }
  // Tiles to draw for a view. Each slot uses its own tile when loaded, else loaded children
  // (after zooming out), else the nearest loaded ancestor clipped to the slot (after zooming in),
  // so detail never blinks out while new tiles arrive. The zoom level has hysteresis so it doesn't
  // flip back and forth at a boundary.
  function cover(kind, zf, box, minZ, maxZ) {
    let z = Math.floor(zf);
    const last = lastZ[kind];
    if (last != null && zf > last - 0.4 && zf < last + 1.4) z = last;
    z = Math.max(minZ, Math.min(maxZ, z));
    const [lo0, la0, lo1, la1] = box;
    if (lo0 > lo1 || la0 > la1) return { exact: [], fills: [], ready: 1, z };
    let tx0, ty0, tx1, ty1;
    for (;;) {
      [tx0, ty1] = lonLatTile(lo0, la0, z); [tx1, ty0] = lonLatTile(lo1, la1, z);
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 60 || z <= minZ) break;
      z--;
    }
    lastZ[kind] = z;
    const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2, exact = [], fillMap = new Map(); let ready = 0, total = 0;
    // Buffer: request (but don't draw) a ring of tiles just outside the view, and the next coarser
    // level, so most tiles are already loaded by the time a pan or zoom brings them into view
    const ring = (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 30 ? 2 : 1;
    for (let ty = ty0 - ring; ty <= ty1 + ring; ty++) for (let tx = tx0 - ring; tx <= tx1 + ring; tx++) {
      if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue;
      if (tx >= 0 && ty >= 0 && tx < 2 ** z && ty < 2 ** z) get(kind, z, tx, ty, 30 + Math.hypot(tx - cx, ty - cy));
    }
    if (z > minZ) for (let ty = (ty0 >> 1); ty <= (ty1 >> 1); ty++) for (let tx = (tx0 >> 1); tx <= (tx1 >> 1); tx++) get(kind, z - 1, tx, ty, 20);
    // Draw the whole view from one level when possible: the wanted level if it's fully loaded,
    // else the most detailed coarser level that is. Detail then sharpens across the whole screen at
    // once (and crossfades on the page) instead of filling in tile by tile with visible seams.
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) get(kind, z, tx, ty, Math.hypot(tx - cx, ty - cy));
    for (let zz = z; zz >= Math.max(minZ, z - 3); zz--) {
      const sh = z - zz, list = [];
      let ok = true;
      for (let ty = ty0 >> sh; ty <= ty1 >> sh && ok; ty++) for (let tx = tx0 >> sh; tx <= tx1 >> sh && ok; tx++) {
        const e = cache.get(keyOf(kind, zz, tx, ty));
        if (e && e.state === 'ready') { e.used = stamp; list.push(e); continue; }
        if (e && e.state === 'error') continue; // missing at the source (e.g. open ocean); nothing to wait for
        const kids = readyDescendants(kind, zz, tx, ty, 2);
        if (kids) list.push(...kids); else ok = false;
      }
      if (ok) return { exact: list, fills: [], ready: zz === z ? 1 : 0, z };
    }
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      total++;
      const e = get(kind, z, tx, ty, Math.hypot(tx - cx, ty - cy));
      if (e.state === 'ready') { ready++; exact.push(e); continue; }
      const kids = readyDescendants(kind, z, tx, ty, 2);
      if (kids) { exact.push(...kids); ready++; continue; }
      let anc = null;
      for (let pz = z - 1, px = tx >> 1, py = ty >> 1; pz >= Math.max(0, z - 7); pz--, px >>= 1, py >>= 1) {
        const pe = cache.get(keyOf(kind, pz, px, py));
        if (pe && pe.state === 'ready') { anc = pe; break; }
      }
      if (anc) {
        anc.used = stamp;
        let f = fillMap.get(anc.key); if (!f) { f = { ent: anc, clip: new Path2D() }; fillMap.set(anc.key, f); }
        quadInto(f.clip, z, tx, ty);
      } else {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const ce = cache.get(keyOf(kind, z + 1, tx * 2 + dx, ty * 2 + dy));
          if (ce && ce.state === 'ready') { ce.used = stamp; exact.push(ce); }
        }
      }
    }
    return { exact, fills: [...fillMap.values()], ready: ready / total, z };
  }

  // Terrain for the whole country loads before the map is shown, so zoomed-out views never pop in
  let preloading = true;
  const preloadList = [];
  function preload() {
    const add = (z, pin, prio) => {
      const [x0, y0] = lonLatTile(-125.5, 49.5, z), [x1, y1] = lonLatTile(-66.5, 24, z);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const e = get('dem', z, x, y, prio, pin); if (prio < 0) preloadList.push(e); }
    };
    add(4, true, -20); add(5, true, -10);
    add(6, true, 200);   // background: sharper relief for state-level views
    pump(); checkPreload();
  }
  function checkPreload() {
    const done = preloadList.filter(e => e.state === 'ready' || e.state === 'error').length;
    self.postMessage({ type: 'progress', done, total: preloadList.length });
    if (done === preloadList.length && preloading) { preloading = false; requestRender(0); setTimeout(renderOverview, 1500); } // after the first view
  }

  // A whole-country image, painted once (and again on a theme change). The page keeps it under
  // everything, so a fast zoom or pan past the newest image shows a softer map instead of empty ground.
  function renderOverview() { if (L) render({ x: -50, y: -50, s: 0.42, W: 1975, H: 1260, dpr: 1, interactive: true, overview: true, seq: -1 }); }
  function prefetch(m) { // tiles ahead of a followed train, so following never outruns the detail
    if (!view) return;
    const kmPer = Math.cos(unproj(view.x, view.y)[1] * rad), s = view.s;
    const zd = Math.max(3, Math.min(14, Math.floor(Math.log2(40075 * kmPer * s / 256)) - 1));
    const zv = Math.min(vecMax, Math.floor(Math.log2(40075 * kmPer * s / 512) + 0.5));
    for (let i = 0; i < m.pts.length; i += 2) {
      const [lon, lat] = unproj(m.pts[i], m.pts[i + 1]);
      const [dx, dy] = lonLatTile(lon, lat, zd); get('dem', zd, dx, dy, 50 + i);
      if (vecTemplate && zv >= 9) { const [vx, vy] = lonLatTile(lon, lat, zv); get('vec', zv, vx, vy, 50 + i); }
    }
    pump();
  }

  // ---- painting ----
  function drawWarped(c, img, g) { // Mercator image tile into Albers space as 16 affine pieces
    const M = c.getTransform();
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      const i00 = (b * 5 + a) * 2, i10 = i00 + 2, i01 = i00 + 10, sx = a * 64, sy = b * 64;
      const ax = (g[i10] - g[i00]) / 64, ay = (g[i10 + 1] - g[i00 + 1]) / 64, cx = (g[i01] - g[i00]) / 64, cy = (g[i01 + 1] - g[i00 + 1]) / 64;
      const ex = g[i00] - ax * sx - cx * sy, ey = g[i00 + 1] - ay * sx - cy * sy;
      c.setTransform(M.a * ax + M.c * ay, M.b * ax + M.d * ay, M.a * cx + M.c * cy, M.b * cx + M.d * cy, M.a * ex + M.c * ey + M.e, M.b * ex + M.d * ey + M.f);
      c.drawImage(img, sx, sy, 65, 65, sx, sy, 65, 65);
    }
    c.setTransform(M);
  }
  let holdSeq = -1, holds = 0, lastPosted = null;
  function render(v) {
    const { x: vx, y: vy, s, W, H, dpr } = v, BW = W + 2 * MARGIN, BH = H + 2 * MARGIN;
    // Only worth waiting when the last image sent already shows this view; otherwise the screen
    // would sit empty, so paint right away
    const lp = lastPosted, shown = lp && Math.abs(Math.log(s / lp.s)) < 0.01 &&
      Math.abs(vx - lp.x) * s + W / 2 <= lp.BW / 2 && Math.abs(vy - lp.y) * s + H / 2 <= lp.BH / 2;
    if (!v.interactive && !preloading && shown) {
      if (v.seq !== holdSeq) { holdSeq = v.seq; holds = 0; }
      const hx0 = vx - W / 2 / s, hx1 = vx + W / 2 / s, hy0 = vy - H / 2 / s, hy1 = vy + H / 2 / s;
      const hb = lonLatBox(hx0, hy0, hx1, hy1), kp = Math.cos(unproj(vx, vy)[1] * rad);
      const zvf = Math.log2(40075 * kp * s / 512) + 0.5;
      const ok = cover('dem', Math.log2(40075 * kp * s / 256) - 1, hb, 4, 14).ready >= 1 &&
        (!(vecTemplate && zvf >= 9) || cover('vec', zvf, hb, 9, vecMax).ready >= 1);
      pump();
      if (!ok && holds++ < 6) { requestRender(100); return; } // waits at most ~0.6 s
    }
    const cw = Math.round(BW * dpr), chh = Math.round(BH * dpr);
    if (!canvas) { canvas = mk(cw, chh); ctx = canvas.getContext('2d', { alpha: false }); }
    else if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
    const c = ctx; stamp++;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COL.ground; c.fillRect(0, 0, cw, chh);
    c.setTransform(s * dpr, 0, 0, s * dpr, (BW / 2 - vx * s) * dpr, (BH / 2 - vy * s) * dpr);
    c.lineJoin = 'round'; c.lineCap = 'round';
    const x0 = vx - BW / 2 / s, x1 = vx + BW / 2 / s, y0 = vy - BH / 2 / s, y1 = vy + BH / 2 / s, m = 4 / s;
    const inView = (ch) => ch.x1 >= x0 - m && ch.x0 <= x1 + m && ch.y1 >= y0 - m && ch.y0 <= y1 + m;
    const stroke = (Ly) => { if (s < 2.5) c.stroke(Ly.all); else for (const ch of Ly.chunks) if (inView(ch)) c.stroke(ch.p); };
    const px = 1 / s, clampW = (k, lo, hi) => Math.max(lo, Math.min(hi, k * s)) * px;
    c.fillStyle = COL.land; c.fill(L.land, 'evenodd');

    // Ground detail stays inside the US outline
    c.save(); c.clip(L.land, 'evenodd');
    const box = lonLatBox(x0, y0, x1, y1), kmPer = Math.cos(unproj(vx, vy)[1] * rad);
    const each = (cov, fn, cc = c) => {
      for (const e of cov.exact) fn(e);
      for (const f of cov.fills) { cc.save(); cc.clip(f.clip); fn(f.ent); cc.restore(); }
    };
    // Terrain: hillshade everywhere, contours once zoomed in
    const dem = cover('dem', Math.log2(40075 * kmPer * s / 256) - 1, box, 4, 14);
    // Shading is drawn into its own layer first (opaque tiles, so overlaps are invisible), then
    // laid over the land in one pass, fading out when magnified past the data's resolution
    if (!shade || shade.width !== cw || shade.height !== chh) { shade = mk(cw, chh); sctx = shade.getContext('2d', { alpha: false }); }
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.fillStyle = '#808080'; sctx.fillRect(0, 0, cw, chh);
    sctx.setTransform(c.getTransform()); sctx.imageSmoothingEnabled = true;
    each(dem, e => drawWarped(sctx, e.img, e.grid), sctx);
    const M0 = c.getTransform();
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = COL.shade * (1 - 0.6 * ramp(s, 25, 300));
    c.globalCompositeOperation = 'hard-light'; c.drawImage(shade, 0, 0); c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1; c.setTransform(M0);
    each(dem, e => {
      if (e.minor) { c.strokeStyle = COL.contour + '0.085)'; c.lineWidth = 0.8 * px; c.stroke(e.minor); }
      if (e.major) { c.strokeStyle = COL.contour + '0.16)'; c.lineWidth = 1.1 * px; c.stroke(e.major); }
    });
    // Streets, water and buildings from vector tiles past state level; the built-in roads and
    // water fade out over the same zoom range rather than switching on load progress
    const zvf = Math.log2(40075 * kmPer * s / 512) + 0.5;
    const vec = vecTemplate && zvf >= 9 ? cover('vec', zvf, box, 9, vecMax) : null;
    const ne = vecTemplate ? 1 - ramp(s, 11, 22) : 1;
    const grp = (g, fn) => { if (vec) each(vec, e => { if (e.groups[g]) fn(e.groups[g]); }); };

    grp('green', p => { c.fillStyle = COL.green; c.fill(p); });
    if (ne > 0) {
      c.globalAlpha = ne; c.fillStyle = COL.ground; c.fill(L.lakes);
      c.strokeStyle = COL.water + '0.28)'; c.lineWidth = px; c.stroke(L.lakes); c.globalAlpha = 1;
    }
    grp('water', p => { c.fillStyle = COL.ground; c.fill(p); c.strokeStyle = COL.water + '0.3)'; c.lineWidth = px; c.stroke(p); });
    if (ne > 0) {
      const rmaj = ramp(s, 0.3, 0.8) * ne, rmin = ramp(s, 1.2, 2.6) * ne;
      if (rmin > 0) { c.strokeStyle = COL.water + (0.22 * rmin).toFixed(3) + ')'; c.lineWidth = px; stroke(L.riversMinor); }
      if (rmaj > 0) { c.strokeStyle = COL.water + (0.36 * rmaj).toFixed(3) + ')'; c.lineWidth = px * (s > 4 ? 1.6 : 1.1); stroke(L.riversMajor); }
    }
    grp('stream', p => { c.strokeStyle = COL.water + '0.3)'; c.lineWidth = clampW(0.003, 0.7, 1.6); c.stroke(p); });
    grp('river', p => { c.strokeStyle = COL.water + '0.45)'; c.lineWidth = clampW(0.012, 1.1, 5); c.stroke(p); });
    if (ne > 0) {
      const minor = ramp(s, 2.2, 4.5) * ne, major = ramp(s, 0.7, 1.6) * ne;
      if (minor > 0) { c.strokeStyle = COL.roadMinor + (0.16 * minor).toFixed(3) + ')'; c.lineWidth = px; stroke(L.roadsMinor); }
      if (major > 0) { c.strokeStyle = COL.roadMajor + (0.22 * major).toFixed(3) + ')'; c.lineWidth = px * (s > 4 ? 1.5 : 1); stroke(L.roadsMajor); }
    }
    grp('road4', p => { c.strokeStyle = COL.roadMinor + '0.11)'; c.lineWidth = clampW(0.004, 0.6, 2.2); c.stroke(p); });
    grp('road3', p => { c.strokeStyle = COL.roadMinor + '0.17)'; c.lineWidth = clampW(0.007, 0.8, 3.4); c.stroke(p); });
    grp('road2', p => { c.strokeStyle = COL.roadMajor + '0.23)'; c.lineWidth = clampW(0.01, 1, 4.6); c.stroke(p); });
    grp('road1', p => { c.strokeStyle = COL.roadMajor + '0.3)'; c.lineWidth = clampW(0.013, 1.3, 6); c.stroke(p); });
    grp('building', p => { c.fillStyle = COL.building; c.fill(p); });
    // Up close, OpenStreetMap's main-line rail becomes the drawn track (trains snap onto it on the page)
    // and the coarser FRA line fades back; sidings and yards stay faint
    const osm = vec && vec.z >= 12 ? ramp(s, 40, 100) : 0;
    grp('railMinor', p => { c.strokeStyle = COL.track + (0.16 + 0.06 * osm).toFixed(3) + ')'; c.lineWidth = clampW(0.002, 0.7, 1.6); c.stroke(p); });
    grp('rail', p => { c.strokeStyle = COL.track + (0.3 + 0.3 * osm).toFixed(3) + ')'; c.lineWidth = osm > 0 ? px * (1.6 + 0.6 * osm) : clampW(0.0025, 0.8, 2); c.stroke(p); });
    c.restore();
    evict(); pump();

    c.strokeStyle = COL.coast; c.lineWidth = px; stroke(L.coast);
    c.setLineDash([1.2 * px, 4 * px]); c.strokeStyle = COL.border; c.lineWidth = 1.2 * px;
    if (s < 2.5) stroke(L.borders);
    else {
      // Dashing costs per dash, so clip each border segment to the view first. Clipped starts snap
      // back to a whole dash period so the pattern doesn't crawl while panning.
      const per = 5.2 * px, bp = new Path2D();
      for (const ch of L.borders.chunks) {
        if (!inView(ch)) continue;
        const a = ch.a;
        for (let i = 0; i < a.length - 2; i += 2) {
          const ax = a[i], ay = a[i + 1], bx = a[i + 2], by = a[i + 3];
          const cl = clipSeg(ax, ay, bx, by, x0 - m, y0 - m, x1 + m, y1 + m); if (!cl) continue;
          const len = Math.hypot(bx - ax, by - ay); if (!len) continue;
          const t0 = Math.floor(cl[0] * len / per) * per / len;
          bp.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0); bp.lineTo(ax + (bx - ax) * cl[1], ay + (by - ay) * cl[1]);
        }
      }
      c.stroke(bp);
    }
    c.setLineDash([]);
    c.strokeStyle = COL.track + ((0.38 + 0.2 * ramp(s, 1, 10)) * (1 - 0.75 * osm)).toFixed(3) + ')'; c.lineWidth = px * (s > 30 ? 2.2 : s > 3 ? 1.5 : 1.1); stroke(L.track);

    // Station dots in image pixels so they keep a constant size
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dr = s < 0.6 ? 1.3 : s < 6 ? 1.8 : 2.6, dp = new Path2D();
    for (let i = 0; i < dots.length; i += 2) {
      const qx = (dots[i] - vx) * s + BW / 2, qy = (dots[i + 1] - vy) * s + BH / 2;
      if (qx < -5 || qy < -5 || qx > BW + 5 || qy > BH + 5) continue;
      dp.moveTo(qx + dr, qy); dp.arc(qx, qy, dr, 0, Math.PI * 2);
    }
    c.fillStyle = COL.station + (s < 0.6 ? 0.3 : 0.42) + ')'; c.fill(dp);

    let bmp;
    if (canvas.transferToImageBitmap) bmp = canvas.transferToImageBitmap();
    else { bmp = mk(cw, chh); bmp.getContext('2d').drawImage(canvas, 0, 0); }
    const msg = { type: v.overview ? 'overview' : 'frame', bmp, x: vx, y: vy, s, BW, BH, dpr, seq: v.seq, settled: !v.interactive, preloading };
    if (!v.overview) lastPosted = { x: vx, y: vy, s, BW, BH };
    try { self.postMessage(msg, canvas.transferToImageBitmap ? [bmp] : []); } catch (_) { self.postMessage(msg); }
  }
  function clipSeg(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
    const P = [-dx, dx, -dy, dy], Qv = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (let i = 0; i < 4; i++) {
      if (P[i] === 0) { if (Qv[i] < 0) return null; continue; }
      const r = Qv[i] / P[i];
      if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  }

  // Renders are coalesced: only the newest view is ever painted
  let queued = false;
  function requestRender(delay) {
    if (queued) return; queued = true;
    setTimeout(() => { queued = false; if (view && L) render(view); }, delay);
  }
  self.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'init') init(m);
    else if (m.type === 'view') { view = m; if (m.render) requestRender(0); }
    else if (m.type === 'prefetch') prefetch(m);
    else if (m.type === 'theme') { COL = m.COL; requestRender(0); if (!preloading) setTimeout(renderOverview, 600); }
  };
}
