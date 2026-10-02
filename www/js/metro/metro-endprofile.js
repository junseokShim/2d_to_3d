/* Tool3D section ④ helpers (pure JS, no DOM: browser Tool3D.metroEP, Node module.exports):
 * (1) end-face (top view) segmentation: outer circle fit, scale bar detection, each tooth's face as a labelled mask with its
 *     area in mm²;
 * (2) profile graph: height / edge profile (µm vs µm), straight reference fitted on a chosen segment, perpendicular
 *     deviation of a picked point and the maximum deviation from the extended reference.
 * Reads RGBA images {width, height, data}; never touches the wear engine (www/js/wear).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.metroEP = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;
  const r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 1e4) / 1e4;
  const lum = (d, o) => .299 * d[o] + .587 * d[o + 1] + .114 * d[o + 2];
  const median = a => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); return b[b.length >> 1]; };
  function otsu(vals) {
    const h = new Float64Array(256); for (const v of vals) h[Math.max(0, Math.min(255, Math.round(v)))]++;
    let sum = 0, tot = 0; for (let v = 0; v < 256; v++) { sum += v * h[v]; tot += h[v]; }
    let wB = 0, sB = 0, best = -1, t = 128;
    for (let v = 0; v < 256; v++) { wB += h[v]; if (!wB || wB === tot) continue; sB += v * h[v]; const mB = sB / wB, mF = (sum - sB) / (tot - wB), b = wB * (tot - wB) * (mB - mF) ** 2; if (b > best) { best = b; t = v; } }
    return t;
  }

  // ---------- (1) end face ----------
  // algebraic (Kasa) circle fit of points [[x, y], ...]
  function kasa(P) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0; const n = P.length;
    for (const [x, y] of P) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
    // solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = [sxz syz sz]; centre (a/2, b/2), r^2 = c + cx^2 + cy^2
    const A = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
    for (let i = 0; i < 3; i++) {
      let p = i; for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      [A[i], A[p]] = [A[p], A[i]]; if (!A[i][i]) return null;
      for (let j = 0; j < 3; j++) if (j !== i) { const f = A[j][i] / A[i][i]; for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k]; }
    }
    const a = A[0][3] / A[0][0], b = A[1][3] / A[1][1], c = A[2][3] / A[2][2], cx = a / 2, cy = b / 2;
    return {cx, cy, r: Math.sqrt(Math.max(0, c + cx * cx + cy * cy))};
  }
  // robust circle: Kasa fit, then drop points whose radial residual exceeds 2.5 x the median absolute residual, three times
  function fitCircleRobust(P) {
    let use = P, c = kasa(use);
    for (let it = 0; it < 4 && c; it++) {
      const res = P.map(([x, y]) => Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r)), mad = Math.max(.5, median(res));
      const nxt = P.filter((_, i) => res[i] <= 2.5 * mad); if (nxt.length < 8 || nxt.length === use.length) break;
      use = nxt; c = kasa(use);
    }
    if (!c) return null;
    const rms = Math.sqrt(use.reduce((s, [x, y]) => s + (Math.hypot(x - c.cx, y - c.cy) - c.r) ** 2, 0) / use.length);
    return {cx: r4(c.cx), cy: r4(c.cy), rPx: r4(c.r), inliers: use.length, points: P.length, rmsPx: r4(rms)};
  }
  // outer circle of the tool end face on a top photo. Background colour = median of the image border; tool = pixels whose
  // colour differs from it (Otsu on the colour distance, at least 30 grey levels); the largest blob; its rim is sampled by
  // rays from the blob centroid (outermost tool pixel on each of 720 rays) and fitted robustly.
  function fitOuterCircle(img, o = {}) {
    const {width: w, height: h, data: d} = img, m = Math.max(2, Math.round(.02 * Math.min(w, h))), bR = [], bG = [], bB = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= m && y >= m && x < w - m && y < h - m) { x = w - m - 1; continue; }
      const q = 4 * (y * w + x); bR.push(d[q]); bG.push(d[q + 1]); bB.push(d[q + 2]);
    }
    const bg = [median(bR), median(bG), median(bB)], dist = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) dist[i] = Math.min(255, Math.hypot(d[4 * i] - bg[0], d[4 * i + 1] - bg[1], d[4 * i + 2] - bg[2]));
    const thr = Math.max(o.minDist || 30, otsu(dist)), fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) fg[i] = dist[i] > thr ? 1 : 0;
    // largest 4-connected blob
    const lab = new Int32Array(w * h), st = new Int32Array(w * h); let best = 0, bestN = 0, cur = 0;
    for (let s = 0; s < w * h; s++) {
      if (!fg[s] || lab[s]) continue; cur++; let n = 0, sp = 0; st[sp++] = s; lab[s] = cur;
      while (sp) { const i = st[--sp]; n++; const x = i % w, y = (i / w) | 0;
        if (x > 0 && fg[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; st[sp++] = i - 1; } if (x < w - 1 && fg[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; st[sp++] = i + 1; }
        if (y > 0 && fg[i - w] && !lab[i - w]) { lab[i - w] = cur; st[sp++] = i - w; } if (y < h - 1 && fg[i + w] && !lab[i + w]) { lab[i + w] = cur; st[sp++] = i + w; } }
      if (n > bestN) { bestN = n; best = cur; }
    }
    if (!best) return null;
    let mx = 0, my = 0; for (let i = 0; i < w * h; i++) if (lab[i] === best) { mx += i % w + .5; my += ((i / w) | 0) + .5; }
    mx /= bestN; my /= bestN;
    const P = [], rMax = Math.hypot(w, h), N = o.rays || 720;
    for (let a = 0; a < N; a++) {
      const t = a * TAU / N, c = Math.cos(t), s = Math.sin(t); let last = -1;
      for (let r = 0; r < rMax; r += .5) { const x = Math.floor(mx + r * c), y = Math.floor(my + r * s); if (x < 0 || y < 0 || x >= w || y >= h) break; if (lab[y * w + x] === best) last = r; }
      if (last > 0) { const x = mx + last * c, y = my + last * s; if (x > 1 && y > 1 && x < w - 2 && y < h - 2) P.push([x, y]); }   // rim cut by the frame is not the rim
    }
    const C = fitCircleRobust(P); if (!C) return null;
    return Object.assign(C, {bg: bg.map(Math.round), distThr: thr, blobPx: bestN});
  }

  // horizontal scale bar (a straight saturated line with end ticks, e.g. blue on grey): longest run of strongly coloured
  // pixels (max - min channel > 60) on one row, at least 40 px; with 2..3 adjacent rows of the same run the bar length is
  // their mean. Returns {x0, x1, y, px} or null.
  function detectScaleBar(img, o = {}) {
    const {width: w, height: h, data: d} = img, minRun = o.minRun || 40, sat = (x, y) => { const q = 4 * (y * w + x), a = d[q], b = d[q + 1], c = d[q + 2]; return Math.max(a, b, c) - Math.min(a, b, c) > 60 && c > a + 40 && c > b + 40; };
    const ex = o.exclude;   // circle {cx, cy, rPx}: ignore runs inside it (the tool itself)
    let best = null;
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && sat(x, y)) { run++; continue; }
        if (run >= minRun) {
          const x0 = x - run, x1 = x - 1, mid = (x0 + x1) / 2;
          if (!(ex && Math.hypot(mid - ex.cx, y - ex.cy) < ex.rPx * 1.05) && (!best || run > best.px + 2)) best = {x0, x1, y, px: run};
          else if (best && Math.abs(run - best.px) <= 2 && Math.abs(y - best.y) <= 3) best.rows = (best.rows || [best.px]).concat(run);
        }
        run = 0;
      }
    }
    if (!best) return null;
    const px = best.rows ? best.rows.reduce((s, v) => s + v, 0) / best.rows.length : best.px;
    return {x0: best.x0, x1: best.x1, y: best.y, px: r2(px)};
  }

  // tooth faces on the end face: Otsu split of the grey levels inside the circle (bright land faces vs dark flute gullies),
  // a 1 px opening, the hub (r < hubFrac R) cut out so faces that touch at the centre separate, 4-connected blobs larger
  // than minFrac of the disc = teeth (the k largest when k is given), hub and leftover face pixels joined to the nearest
  // tooth. Teeth are numbered clockwise from 12 o'clock. ppm = px per mm (from the diameter or the scale bar).
  function segmentFaces(img, C, o = {}) {
    const {width: w, height: h, data: d} = img, {cx, cy, rPx: R} = C, rIn = (o.rimFrac || .985) * R, ppm = o.pxPerMm, k = o.k || 0;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
    const inside = new Uint8Array(w * h), g = new Float32Array(w * h), vals = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x; if (Math.hypot(x + .5 - cx, y + .5 - cy) >= rIn) continue;
      inside[i] = 1; g[i] = lum(d, 4 * i); vals.push(g[i]);
    }
    const thr = o.threshold != null ? o.threshold : otsu(vals);
    let face = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) face[i] = inside[i] && g[i] > thr ? 1 : 0;
    const morph = (src, keep) => { const out = new Uint8Array(w * h); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (!inside[i]) continue; let n = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; c++; n += src[yy * w + xx]; } out[i] = keep(n, c, src[i]) ? 1 : 0; } return out; };
    face = morph(morph(face, n => n === 9 || false), n => n > 0);   // opening (3x3 erode, then dilate)
    const facePx = face.reduce((s, v) => s + v, 0), hub = (o.hubFrac == null ? .06 : o.hubFrac) * R, disc = Math.PI * rIn * rIn;
    const lab = new Int32Array(w * h), st = new Int32Array(w * h), comps = []; let cur = 0;
    const ok = i => face[i] && !lab[i] && Math.hypot(i % w + .5 - cx, ((i / w) | 0) + .5 - cy) >= hub;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const s = y * w + x; if (!ok(s)) continue; cur++; let n = 0, sp = 0; st[sp++] = s; lab[s] = cur;
      while (sp) { const i = st[--sp]; n++; const xx = i % w, yy = (i / w) | 0;
        for (const j of [xx > 0 ? i - 1 : -1, xx < w - 1 ? i + 1 : -1, yy > 0 ? i - w : -1, yy < h - 1 ? i + w : -1]) if (j >= 0 && ok(j)) { lab[j] = cur; st[sp++] = j; } }
      comps.push({id: cur, n});
    }
    let teeth = comps.filter(c => c.n >= (o.minFrac || .005) * disc).sort((a, b) => b.n - a.n);
    if (k) teeth = teeth.slice(0, k);
    const map = new Int32Array(cur + 1); teeth.forEach((c, j) => { map[c.id] = j + 1; });
    const tl = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (lab[i] && map[lab[i]]) tl[i] = map[lab[i]];
    // join leftover face pixels (hub, small specks) to the nearest tooth: multi-source BFS through face pixels
    let front = []; for (let i = 0; i < w * h; i++) if (tl[i]) front.push(i);
    while (front.length) { const nx = []; for (const i of front) { const xx = i % w, yy = (i / w) | 0;
      for (const j of [xx > 0 ? i - 1 : -1, xx < w - 1 ? i + 1 : -1, yy > 0 ? i - w : -1, yy < h - 1 ? i + w : -1]) if (j >= 0 && face[j] && !tl[j]) { tl[j] = tl[i]; nx.push(j); } } front = nx; }
    // per tooth: area, centroid, angle (clockwise from 12 o'clock), outermost radius
    const T = teeth.map(() => ({px: 0, sx: 0, sy: 0, rMax: 0}));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const j = tl[y * w + x]; if (!j) continue; const t = T[j - 1], px = x + .5, py = y + .5; t.px++; t.sx += px; t.sy += py; t.rMax = Math.max(t.rMax, Math.hypot(px - cx, py - cy)); }
    const ang = t => ((Math.atan2(t.sx / t.px - cx, -(t.sy / t.px - cy)) / DEG) + 360) % 360;
    const order = T.map((t, j) => ({t, j, a: ang(t)})).sort((a, b) => a.a - b.a), relabel = new Uint8Array(T.length + 1);
    order.forEach((e, n) => { relabel[e.j + 1] = n + 1; });
    for (let i = 0; i < w * h; i++) if (tl[i]) tl[i] = relabel[tl[i]];
    const px2 = ppm ? 1 / (ppm * ppm) : null;
    const out = order.map((e, n) => ({tooth: n + 1, areaPx: e.t.px, areaMm2: px2 ? r4(e.t.px * px2) : null, angleDeg: r2(e.a),
      cx: r2(e.t.sx / e.t.px), cy: r2(e.t.sy / e.t.px), rMaxMm: ppm ? r4(e.t.rMax / ppm) : null, pctOfDisc: r2(100 * e.t.px / disc)}));
    const tot = out.reduce((s, t) => s + t.areaPx, 0);
    return {w, h, label: tl, k: out.length, kWanted: k || null, threshold: thr, facePx, teeth: out, pxPerMm: ppm || null,
      total: {areaPx: tot, areaMm2: px2 ? r4(tot * px2) : null, discMm2: px2 ? r4(disc * px2) : null, pctOfDisc: r2(100 * tot / disc)},
      maxTooth: out.length ? out.reduce((b, t) => t.areaPx > b.areaPx ? t : b, out[0]).tooth : null};
  }

  // whole end-face analysis. o = {diameterMm, k, barUm (scale bar length, µm), scale: 'auto' | 'bar' | 'diameter'}
  // scale 'auto': the scale bar when one is found and barUm is given, else the diameter.
  function analyzeEndFace(img, o = {}) {
    const C = fitOuterCircle(img); if (!C) return {error: 'circle'};
    const bar = o.barUm ? detectScaleBar(img, {exclude: C}) : null, want = o.scale || 'auto';
    const ppmBar = bar && o.barUm ? bar.px / (o.barUm / 1000) : null, ppmDia = o.diameterMm > 0 ? 2 * C.rPx / o.diameterMm : null;
    const useBar = ppmBar && (want === 'bar' || (want === 'auto')) || (!ppmDia && ppmBar);
    const ppm = useBar ? ppmBar : ppmDia;
    const S = segmentFaces(img, C, {k: o.k, pxPerMm: ppm});
    return Object.assign(S, {circle: C, bar, scale: {method: ppm ? (useBar ? 'bar' : 'diameter') : 'none', pxPerMm: ppm ? r4(ppm) : null,
      diameterMm: ppm ? r4(2 * C.rPx / ppm) : null, diameterInputMm: o.diameterMm || null, barUm: o.barUm || null,
      diameterFromBarMm: ppmBar ? r4(2 * C.rPx / ppmBar) : null}});
  }

  // ---------- (2) profile graph ----------
  // two-column text (x µm, height µm): comma / tab / semicolon / space separated; header and comment lines skipped
  function parseProfile(text) {
    const pts = [];
    for (const line of String(text).split(/\r?\n/)) {
      const c = line.trim().split(/[\s,;\t]+/).map(Number); if (c.length >= 2 && c.every(Number.isFinite)) pts.push({x: c[0], y: c[1]});
    }
    return pts.sort((a, b) => a.x - b.x);
  }
  // straight reference: orthogonal (total least squares) fit of the points with x0 <= x <= x1 — both axes are µm, so the
  // fit minimises the perpendicular distances. Line: point (mx, my), unit direction (ux, uy) with ux > 0, unit normal (nx, ny) pointing up.
  function fitLine(pts, x0, x1) {
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1), P = pts.filter(p => p.x >= lo && p.x <= hi);
    if (P.length < 2) return null;
    const mx = P.reduce((s, p) => s + p.x, 0) / P.length, my = P.reduce((s, p) => s + p.y, 0) / P.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of P) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
    const th = .5 * Math.atan2(2 * sxy, sxx - syy); let ux = Math.cos(th), uy = Math.sin(th); if (ux < 0) { ux = -ux; uy = -uy; }
    const nx = -uy, ny = ux, res = P.map(p => (p.x - mx) * nx + (p.y - my) * ny);
    return {x0: lo, x1: hi, mx, my, ux, uy, nx, ny, n: P.length, slope: ux ? uy / ux : Infinity, angleDeg: r4(Math.atan2(uy, ux) / DEG),
      rmsUm: r4(Math.sqrt(res.reduce((s, v) => s + v * v, 0) / P.length)), at: x => my + (x - mx) * uy / ux};
  }
  // signed perpendicular distance of (x, y) from the line (+ above / - below) and the foot of the perpendicular
  function deviation(L, x, y) {
    const d = (x - L.mx) * L.nx + (y - L.my) * L.ny;
    return {x, y, devUm: r4(d), absUm: r4(Math.abs(d)), foot: [r4(x - d * L.nx), r4(y - d * L.ny)]};
  }
  // linear interpolation of the profile height at x
  function heightAt(pts, x) {
    if (!pts.length) return null; if (x <= pts[0].x) return pts[0].y; if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
    let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].x <= x) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi], t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x); return a.y + t * (b.y - a.y);
  }
  // largest |deviation| from the reference over points outside the fitted segment (where = 'outside', default) or all
  function maxDeviation(L, pts, where = 'outside') {
    let best = null;
    for (const p of pts) { if (where === 'outside' && p.x >= L.x0 && p.x <= L.x1) continue; const d = deviation(L, p.x, p.y); if (!best || d.absUm > best.absUm) best = d; }
    return best;
  }
  // full profile evaluation: seg = [x0, x1] (µm) for the reference, pick = x (µm) of the picked point (optional)
  function analyzeProfile(pts, seg, pick) {
    const L = fitLine(pts, seg[0], seg[1]); if (!L) return null;
    const p = pick == null ? null : deviation(L, pick, heightAt(pts, pick)), mx = maxDeviation(L, pts);
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    return {n: pts.length, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...ys), Math.max(...ys)],
      line: {x0: L.x0, x1: L.x1, n: L.n, slope: r4(L.slope), angleDeg: L.angleDeg, rmsUm: L.rmsUm, y0: r4(L.at(L.x0)), y1: r4(L.at(L.x1))}, L, pick: p, max: mx};
  }
  // default reference segment: the first 35 % of the x range (the unworn start of an edge / height profile)
  const defaultSegment = pts => { const a = pts[0].x, b = pts[pts.length - 1].x; return [a + .02 * (b - a), a + .35 * (b - a)]; };
  // "nice" axis ticks
  function ticks(lo, hi, n = 8) {
    const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(r4(v)); return out;
  }

  // ---------- CSV sections ----------
  function csvSections(s) {
    const L = [], esc = v => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }, row = a => L.push(a.map(esc).join(','));
    const E = s.endSeg;
    if (E && E.teeth) {
      row([]); row(['endface_seg_tooth', 'angle_deg', 'area_mm2', 'area_px', 'pct_of_disc', 'r_max_mm']);
      E.teeth.forEach(t => row(['T' + t.tooth, t.angleDeg, t.areaMm2, t.areaPx, t.pctOfDisc, t.rMaxMm]));
      row(['total', '', E.total.areaMm2, E.total.areaPx, E.total.pctOfDisc, '']);
      row(['endface_circle', 'cx_px', 'cy_px', 'r_px', 'rms_px', 'px_per_mm', 'scale', 'diameter_mm', 'bar_um', 'bar_px']);
      row(['circle', E.circle.cx, E.circle.cy, E.circle.rPx, E.circle.rmsPx, E.scale.pxPerMm, E.scale.method, E.scale.diameterMm, E.scale.barUm, E.bar ? E.bar.px : '']);
    }
    const P = s.profile;
    if (P && P.res) {
      const R = P.res;
      row([]); row(['profile_reference', 'x0_um', 'x1_um', 'points', 'slope', 'angle_deg', 'rms_um']);
      row(['line', R.line.x0, R.line.x1, R.line.n, R.line.slope, R.line.angleDeg, R.line.rmsUm]);
      row(['profile_deviation', 'x_um', 'height_um', 'dev_um', 'foot_x_um', 'foot_y_um']);
      if (R.pick) row(['picked', r4(R.pick.x), r4(R.pick.y), R.pick.devUm, R.pick.foot[0], R.pick.foot[1]]);
      if (R.max) row(['max', r4(R.max.x), r4(R.max.y), R.max.devUm, R.max.foot[0], R.max.foot[1]]);
      row(['profile_x_um', 'height_um']); P.pts.forEach(p => row([r4(p.x), r4(p.y)]));
    }
    return L.join('\r\n') + (L.length ? '\r\n' : '');
  }

  return {kasa, fitCircleRobust, fitOuterCircle, detectScaleBar, segmentFaces, analyzeEndFace, parseProfile, fitLine, deviation, heightAt, maxDeviation, analyzeProfile, defaultSegment, ticks, csvSections, otsu, r2, r4};
});
