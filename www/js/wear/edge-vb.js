/* Tool3D close-up flank wear (pure JS, no DOM: browser Tool3D.wear.edgeVb, Node module.exports).
 * For microscope / macro close-ups of one cutting edge, where the tool diameter is not in the frame and so cannot give
 * the scale. Classical image analysis, no network:
 *  1. scale: the on-image scale bar (a straight saturated bar near a border; its length in um is typed in, 100 um by
 *     default) or a typed um/px; never the tool diameter
 *  2. cutting edge: the longest straight dark / bright boundary (background / tool), Hough vote then a robust straight
 *     line fit on sub-pixel edge points; points that leave the line (chipped or built-up stretches) are dropped, so the
 *     line is the reference line on the unworn edge
 *  3. wear land: along the normal of the reference line, into the tool, the land is the band that lacks the texture and
 *     colour of the unworn flank (worn smooth, or fractured); its far boundary is where the flank texture starts
 *  4. VB(t) = distance of that boundary from the reference line, normal to it; VBmax, VB mean over the worn length
 *  5. confidence: edge contrast and straightness, flank texture found, land boundary sharpness; below the gates the
 *     result is 'not-detected' (operator), never a large number
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.wear = root.Tool3D.wear || {}; root.Tool3D.wear.edgeVb = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 1e4) / 1e4;
  const WORK_LONG = 1400;          // analysis long side cap (px)
  const WORK_UM = 1.5;             // analysis resolution (um/px): finer images are reduced to it (speed; features are tuned at it)

  // ---------- image helpers ----------
  // ImageData-like {width, height, data RGBA} -> reduced copy {w, h, r, g, b, s} (s = image px per work px)
  function reduce(img, longSide) {
    const W = img.width, H = img.height, s = Math.max(1, Math.max(W, H) / longSide), w = Math.round(W / s), h = Math.round(H / s);
    const n = w * h, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), d = img.data;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s)); let r = 0, g = 0, b = 0, k = 0;
        for (let yy = y0; yy < y1 && yy < H; yy++) for (let xx = x0; xx < x1 && xx < W; xx++) { const i = 4 * (yy * W + xx); r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; }
        const o = y * w + x; R[o] = r / k; G[o] = g / k; B[o] = b / k;
      }
    }
    return {w, h, r: R, g: G, b: B, s};
  }
  // box mean of a over (2R+1)^2 with a weight mask (valid pixels only); integral images
  function boxMean(a, valid, w, h, R) {
    const W1 = w + 1, S = new Float64Array(W1 * (h + 1)), N = new Float64Array(W1 * (h + 1)), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let rs = 0, rn = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = valid ? valid[i] : 1; rs += v ? a[i] : 0; rn += v;
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs; N[(y + 1) * W1 + x + 1] = N[y * W1 + x + 1] + rn;
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
        const s = S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0], c = N[y1 * W1 + x1] - N[y0 * W1 + x1] - N[y1 * W1 + x0] + N[y0 * W1 + x0];
        out[y * w + x] = c ? s / c : 0;
      }
    }
    return out;
  }
  // annotation overlays of measuring software (pure red / green / blue marks, white label boxes): not image content
  function overlayMask(I) {
    const n = I.w * I.h, m = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = I.r[i], g = I.g[i], b = I.b[i];
      if ((r > 170 && g < 90 && b < 90 && r - g > 110) || (g > 150 && g - r > 70 && g - b > 70) || (b > 140 && b - r > 70 && b - g > 70)) m[i] = 1;
    }
    // white label boxes: connected near-white regions that fill their bounding box (saturated glints on the tool are
    // irregular and stay image content)
    const wt = new Uint8Array(n), seen = new Uint8Array(n), q = new Int32Array(n);
    for (let i = 0; i < n; i++) if (I.r[i] > 246 && I.g[i] > 246 && I.b[i] > 246) wt[i] = 1;
    for (let i0 = 0; i0 < n; i0++) {
      if (!wt[i0] || seen[i0]) continue;
      let qh = 0, qt = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; q[qt++] = i0; seen[i0] = 1;
      while (qh < qt) {
        const i = q[qh++], x = i % I.w, y = (i - x) / I.w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const j of [i - 1, i + 1, i - I.w, i + I.w]) if (j >= 0 && j < n && wt[j] && !seen[j] && Math.abs((j % I.w) - x) <= 1) { seen[j] = 1; q[qt++] = j; }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (qt >= 60 && qt >= .55 * bw * bh && bw >= 8 && bh >= 5) for (let y = Math.max(0, y0 - 3); y <= Math.min(I.h - 1, y1 + 3); y++) for (let x = Math.max(0, x0 - 3); x <= Math.min(I.w - 1, x1 + 3); x++) m[y * I.w + x] = 1;
    }
    // grow by 1 px (anti-aliased rims)
    const o = m.slice();
    for (let y = 1; y < I.h - 1; y++) for (let x = 1; x < I.w - 1; x++) { const i = y * I.w + x; if (m[i - 1] || m[i + 1] || m[i - I.w] || m[i + I.w]) o[i] = 1; }
    return o;
  }

  // ---------- scale bar ----------
  // A saturated (blue / white / black on contrast) horizontal bar near the bottom or top border: the longest run of
  // pure-blue pixels in the outer 20 % of the image rows. Returns {px, x0, x1, y} in image px, or null.
  function detectScaleBar(img) {
    const W = img.width, H = img.height, d = img.data, rows = [];
    const blue = i => d[i + 2] > 140 && d[i + 2] - d[i] > 70 && d[i + 2] - d[i + 1] > 70;
    let best = null;
    for (let y = 0; y < H; y++) {
      if (y > .2 * H && y < .8 * H) continue;
      let run = 0, x0 = 0;
      for (let x = 0; x <= W; x++) {
        if (x < W && blue(4 * (y * W + x))) { if (!run) x0 = x; run++; }
        else { if (run >= .03 * W && (!best || run > best.px)) best = {px: run, x0, x1: x0 + run - 1, y}; run = 0; }
      }
      rows.push(y);
    }
    if (!best || best.px > .5 * W) return null;
    // thickness: count rows holding most of that run
    let th = 0;
    for (let y = Math.max(0, best.y - 15); y < Math.min(H, best.y + 16); y++) {
      let k = 0; for (let x = best.x0; x <= best.x1; x++) if (blue(4 * (y * W + x))) k++;
      if (k > .8 * best.px) th++;
    }
    if (th > 12) return null;
    return Object.assign(best, {thicknessPx: th});
  }

  // ---------- features ----------
  // gray, chroma (max - min of RGB: the interference colours of an intact coating), fine texture |g - box3(g)|
  function features(I, valid) {
    const {w, h} = I, n = w * h, gray = new Float32Array(n), chroma = new Float32Array(n);
    for (let i = 0; i < n; i++) { const r = I.r[i], g = I.g[i], b = I.b[i]; gray[i] = .299 * r + .587 * g + .114 * b; chroma[i] = Math.max(r, g, b) - Math.min(r, g, b); }
    const g1 = boxMean(gray, valid, w, h, 1), g3 = boxMean(gray, valid, w, h, 3), g6 = boxMean(gray, valid, w, h, 6), g8 = boxMean(gray, valid, w, h, 8);
    const t1 = new Float32Array(n), t2 = new Float32Array(n);
    for (let i = 0; i < n; i++) { t1[i] = Math.abs(gray[i] - g3[i]); t2[i] = Math.abs(g3[i] - g8[i]); }
    return {gray, chroma, g1, g3, g6, tex: boxMean(t1, valid, w, h, 2), texC: boxMean(t2, valid, w, h, 3)};
  }

  // ---------- cutting edge ----------
  // Polarity-aware Hough of the coarse gradient (normal points dark -> bright), 1 deg bins. Candidates are scored by
  // the length over which a dark | bright step of > STEP grey levels holds, times how much more texture the bright side
  // has (the background beyond the edge is out of focus), times how clean the dark side stays out to the border.
  const STEP = 12;
  function findEdge(I, F, valid) {
    const {w, h} = I, n = w * h, G = F.g6, mag = new Float32Array(n), ang = new Float32Array(n);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x; if (!valid[i]) continue;
      const gx = G[i + 2] - G[i - 2], gy = G[i + 2 * w] - G[i - 2 * w]; mag[i] = Math.hypot(gx, gy); ang[i] = Math.atan2(gy, gx);
    }
    const ms = Float32Array.from(mag).sort(), thr = Math.max(6, ms[Math.floor(.9 * n)]);
    const diag = Math.ceil(Math.hypot(w, h)), NR = 2 * diag + 1, HS = new Float32Array(360 * NR), cs = [], sn = [];
    for (let a = 0; a < 360; a++) { cs.push(Math.cos(a * Math.PI / 180)); sn.push(Math.sin(a * Math.PI / 180)); }
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x; if (mag[i] < thr) continue; const a0 = Math.round(ang[i] * 180 / Math.PI);
      for (let da = -2; da <= 2; da++) { const a = ((a0 + da) % 360 + 360) % 360; HS[a * NR + Math.round(x * cs[a] + y * sn[a]) + diag] += mag[i]; }
    }
    const cands = [];
    for (let k = 0; k < 10; k++) {
      let b = 0, bi = -1; for (let i = 0; i < HS.length; i++) if (HS[i] > b) { b = HS[i]; bi = i; }
      if (bi < 0) break;
      const a = Math.floor(bi / NR), r = bi % NR - diag; cands.push({a, r});
      for (let da = -8; da <= 8; da++) for (let dr = -25; dr <= 25; dr++) { const aa = ((a + da) % 360 + 360) % 360, rr = r + dr + diag; if (rr >= 0 && rr < NR) HS[aa * NR + rr] = 0; }
    }
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : yi * w + xi; };
    for (const c of cands) {
      const nx = cs[c.a], ny = sn[c.a], tx = -ny, ty = nx; let good = 0, tot = 0, hb = 0, hd = 0, kh = 0, dk = 0, dn = 0, cSum = 0;
      for (let u = -diag; u < diag; u += 4) {
        const x0 = nx * c.r + tx * u, y0 = ny * c.r + ty * u; if (x0 < 15 || y0 < 15 || x0 >= w - 15 || y0 >= h - 15) continue; tot++;
        let a = 0, b = 0, ka = 0, kb = 0;
        for (let d = 3; d <= 20; d++) { const i1 = at(x0 + nx * d, y0 + ny * d), i2 = at(x0 - nx * d, y0 - ny * d); if (i1 >= 0 && valid[i1]) { a += F.g1[i1]; ka++; } if (i2 >= 0 && valid[i2]) { b += F.g1[i2]; kb++; } }
        if (!ka || !kb) continue;
        const step = a / ka - b / kb; if (step > STEP) { good++; cSum += step; }
        for (let d = 15; d <= 90; d += 15) { const i1 = at(x0 + nx * d, y0 + ny * d), i2 = at(x0 - nx * d, y0 - ny * d); if (i1 >= 0 && i2 >= 0) { hb += F.tex[i1] / (F.g6[i1] + 20); hd += F.tex[i2] / (F.g6[i2] + 20); kh++; } }
        const dm = b / kb; for (let d = 25; ; d += 10) { const i2 = at(x0 - nx * d, y0 - ny * d); if (i2 < 0) break; dn++; if (F.g6[i2] > dm + .5 * step) dk++; }
      }
      c.lenPx = good * 4; c.step = good ? cSum / good : 0; c.texRatio = kh ? (hb + 1e-3 * kh) / (hd + 1e-3 * kh) : 1; c.darkClean = dn ? 1 - dk / dn : 1;
      c.score = c.lenPx * Math.max(.5, Math.min(3, c.texRatio)) * c.darkClean ** 3;
    }
    cands.sort((p, q) => q.score - p.score);
    return {cands, best: cands[0] || null, cs, sn};
  }

  // sub-pixel edge points along the candidate (max dark -> bright gradient within +-SEARCH px of the line), then a robust
  // straight line fit: total least squares, points farther than max(1.5 px, 2.5 x MAD) dropped, repeated. Chipped (edge
  // inside the tool) and built-up (outside) stretches leave the line and are not used: the fit is the reference line.
  const SEARCH = 14;
  // The cutting edge is the OUTERMOST tool boundary: walking along the normal from the background side, the first place
  // where the grey crosses half way from the background level to the tool level (the land and the chips behind it have
  // their own steps, which must not pull the line inside the tool).
  function edgePoints(I, F, valid, nx, ny, px, py, search) {
    const {w, h} = I, G = F.g1, tx = -ny, ty = nx, diag = Math.hypot(w, h), pts = [];
    const val = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1 || !valid[yi * w + xi] ? null : G[yi * w + xi]; };
    const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    for (let u = -diag; u < diag; u += 2) {
      const x0 = px + tx * u, y0 = py + ty * u; if (x0 < 4 || y0 < 4 || x0 >= w - 4 || y0 >= h - 4) continue;
      const bg = [], tl = [];
      for (let d = -search - 12; d < -search; d++) { const v = val(x0 + nx * d, y0 + ny * d); if (v != null) bg.push(v); }
      for (let d = search; d < search + 12; d++) { const v = val(x0 + nx * d, y0 + ny * d); if (v != null) tl.push(v); }
      if (bg.length < 6 || tl.length < 6) continue;
      const b = med(bg), t = med(tl); if (t - b < 8) continue;
      const half = b + .5 * (t - b);
      let prev = null, hit = null;
      for (let d = -search; d <= search; d++) {
        const v = val(x0 + nx * d, y0 + ny * d); if (v == null) { prev = null; continue; }
        if (prev != null && prev < half && v >= half) { hit = d - 1 + (half - prev) / (v - prev); break; }
        prev = v;
      }
      if (hit != null) pts.push({x: x0 + nx * hit, y: y0 + ny * hit, g: t - b});
    }
    return pts;
  }
  function refineEdge(I, F, valid, c) {
    const nx0 = Math.cos(c.a * Math.PI / 180), ny0 = Math.sin(c.a * Math.PI / 180);
    let pts = edgePoints(I, F, valid, nx0, ny0, nx0 * c.r, ny0 * c.r, SEARCH);
    if (pts.length < 10) return null;
    // RANSAC (deterministic pairs) for the dominant straight run, then a re-search close to it and a trimmed fit
    let best = null, bestN = 0; const m = pts.length;
    for (let t = 0; t < 300; t++) {
      const i = (t * 7919) % m, j = (t * 104729 + 31) % m; if (i === j) continue;
      const p = pts[i], q = pts[j], L = Math.hypot(q.x - p.x, q.y - p.y); if (L < 20) continue;
      const nx = -(q.y - p.y) / L, ny = (q.x - p.x) / L; let k = 0;
      for (const r of pts) if (Math.abs((r.x - p.x) * nx + (r.y - p.y) * ny) < 1.5) k++;
      if (k > bestN) { bestN = k; best = {p, nx, ny}; }
    }
    if (!best) return null;
    let use = pts.filter(r => Math.abs((r.x - best.p.x) * best.nx + (r.y - best.p.y) * best.ny) < 1.5), L = tls(use);
    if (!L) return null;
    if (L.nx * nx0 + L.ny * ny0 < 0) { L.nx = -L.nx; L.ny = -L.ny; }
    pts = edgePoints(I, F, valid, L.nx, L.ny, L.cx, L.cy, 4);
    use = pts;
    for (let it = 0; it < 6; it++) {
      L = tls(use); if (!L) return null;
      const ad = use.map(p => Math.abs((p.x - L.cx) * L.nx + (p.y - L.cy) * L.ny)).sort((p, q) => p - q);
      const lim = Math.max(1, 2.5 * 1.4826 * ad[ad.length >> 1]);
      const nu = pts.filter(p => Math.abs((p.x - L.cx) * L.nx + (p.y - L.cy) * L.ny) <= lim); if (nu.length === use.length || nu.length < 10) break; use = nu;
    }
    L = tls(use);
    if (L.nx * nx0 + L.ny * ny0 < 0) { L.nx = -L.nx; L.ny = -L.ny; }   // normal towards the bright (tool) side
    const res = use.map(p => (p.x - L.cx) * L.nx + (p.y - L.cy) * L.ny);
    L.rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length); L.nFit = use.length; L.nPts = pts.length; L.pts = pts;
    L.tx = -L.ny; L.ty = L.nx;
    const us = use.map(p => (p.x - L.cx) * L.tx + (p.y - L.cy) * L.ty); L.u0 = Math.min(...us); L.u1 = Math.max(...us);
    return L;
  }
  function tls(P) {
    if (P.length < 2) return null;
    let cx = 0, cy = 0; for (const p of P) { cx += p.x; cy += p.y; } cx /= P.length; cy /= P.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of P) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = .5 * Math.atan2(2 * sxy, sxx - syy); return {cx, cy, nx: -Math.sin(th), ny: Math.cos(th)};
  }

  // ---------- wear land along the normals ----------
  // Per image, unsupervised: the intact flank is modelled from a reference band REF_UM away from the edge (median and
  // MAD of each feature), every pixel gets an anomaly score S = rms of its clipped robust z-scores, and the land is the
  // band next to the edge where S stays high (worn smooth, polished, or fractured: anything but intact flank).
  const DU = 2;                 // work px between profile positions along the edge
  const SMOOTH_UM = 12;         // +- along-edge averaging of S (um): one row is noise
  const S_THR = 1.6;            // land: anomaly above this (intact flank ~0.8-1.0, land ~2 on the labelled reference images)
  const GAP_UM = 6;             // gaps inside the land shorter than this are bridged (glints, coating fragments)
  const MIN_VB_UM = 20, MIN_VB_PX = 4;   // narrower than this is the edge transition itself, not a land
  const TAU = 1.3;              // evidence threshold between intact flank (S ~0.8-1.0) and land (S ~2)
  const JUMP_PEN = 0.5;
  const INTACT_UM = 25;         // this much intact flank after the land ends the search along a normal         // DP penalty per work px of front jump between neighbouring positions
  const MAX_VB_UM = 600;        // search depth into the tool
  const REF_UM = [150, 300];    // flank reference band (distance from the edge line)
  const FEAT_UM = [1.5, 6, 15]; // box radii of the multi-scale features
  function anomaly(I, valid, L, um, o) {
    const {w, h} = I, n = w * h, R = v => Math.max(1, Math.round(v / um));
    const g = new Float32Array(n), c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const r = I.r[i], gg = I.g[i], b = I.b[i]; g[i] = .299 * r + .587 * gg + .114 * b; c[i] = (Math.max(r, gg, b) - Math.min(r, gg, b)) / 255; }
    const srt = Float32Array.from(g).sort(), p5 = srt[Math.floor(.05 * n)], p95 = srt[Math.floor(.95 * n)];
    for (let i = 0; i < n; i++) g[i] = (g[i] - p5) / (p95 - p5 + 1);
    const B = (a, r) => boxMean(a, valid, w, h, r), absd = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.abs(a[i] - b[i]); return o; };
    const r1 = R(FEAT_UM[0]), r4_ = R(FEAT_UM[1]), r10 = R(FEAT_UM[2]);
    const b1 = B(g, r1), b4 = B(g, r4_), b10 = B(g, r10), g2 = new Float32Array(n); for (let i = 0; i < n; i++) g2[i] = g[i] * g[i];
    const s4 = B(g2, r4_), sd4 = new Float32Array(n); for (let i = 0; i < n; i++) sd4[i] = Math.sqrt(Math.max(0, s4[i] - b4[i] * b4[i]));
    const F0 = [b1, b4, b10, B(absd(g, b1), R(4.5)), B(absd(b1, b4), R(6)), B(absd(b4, b10), R(9)), B(c, R(4.5)), B(c, R(12)), sd4, B(absd(c, B(c, R(3))), R(6))];
    const F = o.feat ? o.feat.map(j => F0[j]) : F0;
    // reference band
    const lo = REF_UM[0] / um, hi = REF_UM[1] / um, ref = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = y * w + x; if (!valid[i]) continue;
      const d = (x - L.cx) * L.nx + (y - L.cy) * L.ny, u = (x - L.cx) * L.tx + (y - L.cy) * L.ty;
      if (d >= lo && d <= hi && u >= L.u0 && u <= L.u1) ref.push(i);
    }
    if (ref.length < 200) return null;
    const S = new Float32Array(n), med = [], mad = [];
    for (const f of F) {
      const v = Float32Array.from(ref, i => f[i]).sort(), m = v[v.length >> 1];
      const dv = Float32Array.from(v, x => Math.abs(x - m)).sort(); med.push(m); mad.push(dv[dv.length >> 1] * 1.4826 + 1e-4);
    }
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < F.length; j++) { const z = Math.max(-6, Math.min(6, (F[j][i] - med[j]) / mad[j])); s += z * z; } S[i] = Math.sqrt(s / F.length); }
    return {S: boxMean(S, valid, w, h, R(4.5)), nRef: ref.length};
  }
  function landProfile(I, valid, L, um, A, o) {
    const {w, h} = I, maxD = Math.min(Math.round((o.maxVbUm || MAX_VB_UM) / um), Math.round(.6 * Math.max(w, h)));
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : yi * w + xi; };
    const U = [], nU = Math.floor((L.u1 - L.u0) / DU) + 1, nD = maxD + 1, D0 = 2, sm = Math.max(1, Math.round(SMOOTH_UM / um / DU));
    const T = new Float32Array(nU * nD).fill(NaN);
    for (let k = 0; k < nU; k++) {
      const u = L.u0 + k * DU, x0 = L.cx + L.tx * u, y0 = L.cy + L.ty * u; U.push(u);
      for (let d = 0; d < nD; d++) { const i = at(x0 + L.nx * d, y0 + L.ny * d); if (i >= 0 && valid[i]) T[k * nD + d] = A.S[i]; }
    }
    const Ts = new Float32Array(nU * nD).fill(NaN);
    for (let k = 0; k < nU; k++) for (let d = 0; d < nD; d++) {
      let s = 0, c = 0; for (let j = Math.max(0, k - sm); j <= Math.min(nU - 1, k + sm); j++) { const v = T[j * nD + d]; if (v === v) { s += v; c++; } }
      if (c > sm) Ts[k * nD + d] = s / c;
    }
    const thr = o.sThr || S_THR, gap = Math.max(2, Math.round(GAP_UM / um)), minPx = Math.max(MIN_VB_PX, MIN_VB_UM / um);
    const vb = new Float32Array(nU).fill(NaN), sharp = new Float32Array(nU).fill(NaN);
    // front per position: change point of the cumulative evidence C(d) = sum_{D0..d} (S - TAU) (land is anomalous, intact
    // flank is not; holes inside the land only dent C), chosen jointly over all positions by dynamic programming with an
    // L1 penalty on front jumps between neighbours (the wear front is a connected curve)
    const tau = o.tau || TAU, drop = (o.intactUm || INTACT_UM) / um * .35, lam = (o.jumpPen || JUMP_PEN), C = new Float32Array(nU * nD), seenK = new Uint8Array(nU);
    for (let k = 0; k < nU; k++) {
      let c = 0, cMax = 0, miss = 0, dEnd = nD;
      for (let d = 0; d < nD; d++) {
        const v = Ts[k * nD + d];
        if (d < D0) { C[k * nD + d] = 0; continue; }
        if (v !== v) { if (++miss > gap) { dEnd = d; break; } C[k * nD + d] = c; continue; }
        miss = 0; seenK[k] = 1; c += v - tau; C[k * nD + d] = c; if (c > cMax) cMax = c;
        if (c < cMax - drop) { dEnd = d + 1; break; }    // a run of intact flank: the land is behind
      }
      for (let d = dEnd; d < nD; d++) C[k * nD + d] = -1e9;
      for (let d = 0; d < D0; d++) C[k * nD + d] = 0;
    }
    const acc = new Float32Array(nU * nD), arg = new Int32Array(nU * nD), tmp = new Float32Array(nD), ta = new Int32Array(nD);
    for (let d = 0; d < nD; d++) acc[d] = C[d];
    for (let k = 1; k < nU; k++) {
      // max-convolution of the previous row with -lam*|dd| (two passes)
      for (let d = 0; d < nD; d++) { tmp[d] = acc[(k - 1) * nD + d]; ta[d] = d; }
      for (let d = 1; d < nD; d++) if (tmp[d - 1] - lam > tmp[d]) { tmp[d] = tmp[d - 1] - lam; ta[d] = ta[d - 1]; }
      for (let d = nD - 2; d >= 0; d--) if (tmp[d + 1] - lam > tmp[d]) { tmp[d] = tmp[d + 1] - lam; ta[d] = ta[d + 1]; }
      for (let d = 0; d < nD; d++) { acc[k * nD + d] = tmp[d] + C[k * nD + d]; arg[k * nD + d] = ta[d]; }
    }
    const front = new Int32Array(nU); let bd = 0;
    for (let d = 1; d < nD; d++) if (acc[(nU - 1) * nD + d] > acc[(nU - 1) * nD + bd]) bd = d;
    for (let k = nU - 1; k >= 0; k--) { front[k] = bd; if (k) bd = arg[k * nD + bd]; }
    for (let k = 0; k < nU; k++) {
      if (!seenK[k]) continue;
      const W = front[k] < D0 ? 0 : front[k] + 1; vb[k] = W >= minPx ? W : 0;
      if (W >= minPx) {
        let a = 0, ca = 0, b = 0, cb = 0;
        for (let d = Math.max(D0, W - 2 * gap); d < W; d++) { const v = Ts[k * nD + d]; if (v === v) { a += v; ca++; } }
        for (let d = W + 1; d <= Math.min(nD - 1, W + 2 * gap); d++) { const v = Ts[k * nD + d]; if (v === v) { b += v; cb++; } }
        sharp[k] = ca && cb ? (a / ca) / Math.max(1e-3, b / cb) : NaN;
      }
    }
    return {U, vb, sharp, nU, nD, Ts, thr};
  }


  // ---------- wear front as a brightness step (default) ----------
  // On microscope close-ups the land (coating worn through, fractured, cratered) ends where the intact flank starts with
  // a step up in brightness (often with an interference-colour rim at the coating boundary). Along each normal the front
  // is the strongest dark -> bright step beyond the edge transition; the fronts of all positions are chosen together by
  // dynamic programming (L1 penalty on jumps, a switch penalty between 'land' and 'no land'), so one bright scratch or
  // glint cannot make a front on its own.
  const STEP_W_UM = 5;          // half width of the step detector (um)
  const D0_UM = 6;              // skip the edge transition itself (um)
  const G_THR = 0.12;           // step (normalised grey, p5..p95 = 0..1) a 'no land' position is worth
  const JUMP_STEP = 0.004;      // DP penalty per work px of front jump
  const SWITCH = 0.25;
  const INTACT_STEP_UM = 40;    // intact flank stretch that ends the search along a normal
  const INTACT_SD = 0.07;       // its grey spread (normalised, after along-edge averaging)
  const INTACT_LVL = 0.8;       // and its brightness relative to the flank reference band
  const DEPTH_BONUS = 0;           // per um of front depth (inside the intact cut)
  const OUT_UM = 15;            // level after a front, compared with the flank
  const BEYOND = 0.3;           // weight of steps beyond the intact stretch          // DP penalty land <-> no land
  function landStep(I, valid, L, um, o) {
    const {w, h} = I, n = w * h, maxD = Math.min(Math.round((o.maxVbUm || MAX_VB_UM) / um), Math.round(.6 * Math.max(w, h)));
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = .299 * I.r[i] + .587 * I.g[i] + .114 * I.b[i];
    const srt = Float32Array.from(g).sort(), p5 = srt[Math.floor(.05 * n)], p95 = srt[Math.floor(.95 * n)];
    const gs = boxMean(g, valid, w, h, Math.max(1, Math.round(1.5 / um)));
    for (let i = 0; i < n; i++) gs[i] = (gs[i] - p5) / (p95 - p5 + 1);
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : yi * w + xi; };
    const U = [], nU = Math.floor((L.u1 - L.u0) / DU) + 1, nD = maxD + 1, sm = Math.max(1, Math.round(SMOOTH_UM / um / DU));
    const T = new Float32Array(nU * nD).fill(NaN);
    for (let k = 0; k < nU; k++) {
      const u = L.u0 + k * DU, x0 = L.cx + L.tx * u, y0 = L.cy + L.ty * u; U.push(u);
      for (let d = 0; d < nD; d++) { const i = at(x0 + L.nx * d, y0 + L.ny * d); if (i >= 0 && valid[i]) T[k * nD + d] = gs[i]; }
    }
    const Ts = new Float32Array(nU * nD).fill(NaN);
    for (let k = 0; k < nU; k++) for (let d = 0; d < nD; d++) {
      let s = 0, c = 0; for (let j = Math.max(0, k - sm); j <= Math.min(nU - 1, k + sm); j++) { const v = T[j * nD + d]; if (v === v) { s += v; c++; } }
      if (c > sm) Ts[k * nD + d] = s / c;
    }
    const sw = Math.max(2, Math.round((o.stepWUm || STEP_W_UM) / um)), D0 = Math.max(2, Math.round((o.d0Um || D0_UM) / um)), minPx = Math.max(MIN_VB_PX, MIN_VB_UM / um);
    const G = new Float32Array(nU * nD).fill(-1), seenK = new Uint8Array(nU);
    for (let k = 0; k < nU; k++) for (let d = D0 + sw; d < nD - sw; d++) {
      let a = 0, ca = 0, b = 0, cb = 0;
      for (let j = 1; j <= sw; j++) { const v1 = Ts[k * nD + d + j], v0 = Ts[k * nD + d - j + 1]; if (v1 === v1) { a += v1; ca++; } if (v0 === v0) { b += v0; cb++; } }
      if (ca > sw / 2 && cb > sw / 2) { G[k * nD + d] = a / ca - b / cb; seenK[k] = 1; }
    }
    // the search along a normal ends where intact flank starts: a stretch of INTACT_STEP_UM that is homogeneous (the
    // land is broken up, the flank even under the along-edge averaging) and about as bright as the flank reference band
    // (REF_UM from the edge); steps beyond it (flank -> next face) are damped, so the DP only takes them with support
    const kO = Math.max(3, Math.round(OUT_UM / um)), depthB = o.depthBonus != null ? o.depthBonus : DEPTH_BONUS, kI = Math.max(4, Math.round(INTACT_STEP_UM / um)), r0 = Math.round(REF_UM[0] / um), r1 = Math.min(nD - 1, Math.round(REF_UM[1] / um));
    const refV = []; for (let k = 0; k < nU; k += 2) for (let d = r0; d <= r1; d += 2) { const v = Ts[k * nD + d]; if (v === v) refV.push(v); }
    refV.sort((p, q) => p - q); const flank = refV.length > 50 ? refV[refV.length >> 1] : 0.7;
    const cut = new Int32Array(nU).fill(nD);
    for (let k = 0; k < nU; k++) {
      let lvlK = flank;
      for (let d = D0; d + kI < nD; d++) {
        let s1 = 0, s2 = 0, c = 0; for (let j = d; j < d + kI; j++) { const v = Ts[k * nD + j]; if (v === v) { s1 += v; s2 += v * v; c++; } }
        if (c < kI / 2) continue;
        const m = s1 / c, sd = Math.sqrt(Math.max(0, s2 / c - m * m));
        if (sd < (o.intactSd || INTACT_SD) && m > INTACT_LVL * flank) { cut[k] = d; lvlK = m; break; }
      }
      for (let d = cut[k] + sw + 1; d < nD; d++) G[k * nD + d] *= BEYOND;
      // a front steps up INTO flank brightness: a step that ends on a level still well below the flank (a ledge inside
      // a crater) counts in proportion
      for (let d = D0; d < nD; d++) {
        const gi = k * nD + d; if (G[gi] <= 0.05) continue;
        let a = 0, c = 0; for (let j = d + 1; j <= Math.min(nD - 1, d + kO); j++) { const v = Ts[k * nD + j]; if (v === v) { a += v; c++; } }
        G[gi] *= c ? Math.min(1, a / c / (INTACT_LVL * lvlK)) : 0;
      }
      // the front is the OUTERMOST boundary of the land: a real step further out (inside the intact cut) is preferred
      // over an inner one (crater floor, chip facets) by a small depth bonus
      for (let d = D0; d <= Math.min(nD - 1, cut[k] + sw); d++) if (G[k * nD + d] > 0.05) G[k * nD + d] += depthB * d * um;
    }
    const gThr = o.gThr || G_THR, lam = o.jumpStep || JUMP_STEP, swp = o.switchPen || SWITCH;
    const acc = new Float32Array(nU * nD), arg = new Int32Array(nU * nD), tmp = new Float32Array(nD), ta = new Int32Array(nD);
    const accN = new Float32Array(nU), argN = new Int32Array(nU), fromN = new Uint8Array(nU * nD);
    let bestPrev = -1, bestPrevD = -1;
    for (let k = 0; k < nU; k++) {
      if (k === 0) { for (let d = 0; d < nD; d++) acc[d] = G[d]; accN[0] = gThr; }
      else {
        for (let d = 0; d < nD; d++) { tmp[d] = acc[(k - 1) * nD + d]; ta[d] = d; }
        for (let d = 1; d < nD; d++) if (tmp[d - 1] - lam > tmp[d]) { tmp[d] = tmp[d - 1] - lam; ta[d] = ta[d - 1]; }
        for (let d = nD - 2; d >= 0; d--) if (tmp[d + 1] - lam > tmp[d]) { tmp[d] = tmp[d + 1] - lam; ta[d] = ta[d + 1]; }
        const nPrev = accN[k - 1] - swp;
        for (let d = 0; d < nD; d++) {
          if (nPrev > tmp[d]) { acc[k * nD + d] = nPrev + G[k * nD + d]; fromN[k * nD + d] = 1; } else { acc[k * nD + d] = tmp[d] + G[k * nD + d]; arg[k * nD + d] = ta[d]; }
        }
        if (bestPrev - swp > accN[k - 1]) { accN[k] = bestPrev - swp + gThr; argN[k] = bestPrevD; } else { accN[k] = accN[k - 1] + gThr; argN[k] = -1; }
      }
      bestPrev = -1e9; for (let d = 0; d < nD; d++) if (acc[k * nD + d] > bestPrev) { bestPrev = acc[k * nD + d]; bestPrevD = d; }
    }
    // backtrack: state -1 = no land
    const front = new Int32Array(nU); let st = bestPrev > accN[nU - 1] ? bestPrevD : -1;
    for (let k = nU - 1; k >= 0; k--) {
      front[k] = st;
      if (!k) break;
      if (st < 0) st = argN[k]; else st = fromN[k * nD + st] ? -1 : arg[k * nD + st];
    }
    const vb = new Float32Array(nU).fill(NaN), sharp = new Float32Array(nU).fill(NaN);
    for (let k = 0; k < nU; k++) {
      if (!seenK[k] || cut[k] >= nD) continue;      // no intact flank found along this normal (image border, label): the front is unconfirmed
      const W = front[k] < 0 ? 0 : front[k]; vb[k] = W >= minPx ? W : 0;
      if (W >= minPx) sharp[k] = G[k * nD + W];
    }
    return {U, vb, sharp, nU, nD, Ts, front, G, cut, flank};
  }

  // ---------- main ----------
  // img: ImageData-like; o.umPerPx (image px) or o.scaleBarUm (length of the on-image bar, default 100) ->
  // {status: 'ok' | 'no-wear' | 'not-detected' | 'no-scale', reason, vbMaxUm, vbMeanUm, ...}
  function measure(img, o = {}) {
    const t0 = Date.now();
    let umPerPx = o.umPerPx > 0 ? o.umPerPx : null, scaleFrom = umPerPx ? 'um/px' : null, bar = null;
    if (!umPerPx) { bar = detectScaleBar(img); if (bar) { umPerPx = (o.scaleBarUm > 0 ? o.scaleBarUm : 100) / bar.px; scaleFrom = 'scale-bar'; } }
    if (!umPerPx) return {status: 'no-scale', reason: 'no scale bar found and no um/px given', ms: Date.now() - t0};
    const I = reduce(img, Math.min(o.workLong || WORK_LONG, Math.max(img.width, img.height) * Math.min(1, umPerPx / WORK_UM))), n = I.w * I.h, ov = overlayMask(I), valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) valid[i] = 1 - ov[i];
    const um = umPerPx * I.s, F = features(I, valid), E = findEdge(I, F, valid);
    const base = {umPerPx: r4(umPerPx), scaleFrom, scaleBar: bar, workScale: r4(I.s)};
    const fail = (status, reason, extra) => Object.assign({status, reason, vbMaxUm: null, vbMeanUm: null, ms: Date.now() - t0}, base, extra || {});
    if (!E.best || E.best.lenPx < .25 * Math.max(I.w, I.h) || E.best.step < 20) return fail('not-detected', 'no straight cutting edge (dark / bright boundary) in the image', {edgeCand: E.best && {lenPx: E.best.lenPx, step: r2(E.best.step)}});
    const L = refineEdge(I, F, valid, E.best);
    if (o.debug && L) Object.defineProperty(base, 'dbgL', {enumerable: false, value: {L, E: E.cands.slice(0, 3).map(c => ({a: c.a, r: c.r, len: c.lenPx, step: r2(c.step), tr: r2(c.texRatio), dc: r2(c.darkClean), score: Math.round(c.score)}))}});
    if (!L || L.nFit < 30 || (L.rms > 2.5 && L.rms * um > (o.edgeRmsUm || 6))) return fail('not-detected', 'cutting edge is not straight enough to fit a reference line', {edgeRms: L && r2(L.rms), cands: o.debug ? base.dbgL : undefined});
    const A = anomaly(I, valid, L, um, o);
    if (!A) return fail('not-detected', 'no intact flank beside the edge to compare the land with', {});
    const P = o.mode === 'anomaly' ? landProfile(I, valid, L, um, A, o) : landStep(I, valid, L, um, o);
    // VB(t): running median (+-3) over the positions, then statistics
    const vbs = new Float32Array(P.nU).fill(NaN);
    for (let k = 0; k < P.nU; k++) { const a = []; for (let j = Math.max(0, k - 3); j <= Math.min(P.nU - 1, k + 3); j++) if (P.vb[j] === P.vb[j]) a.push(P.vb[j]); if (a.length >= 3) { a.sort((p, q) => p - q); vbs[k] = a[a.length >> 1]; } }
    const prof = []; let kMax = -1, sum = 0, nW = 0, nAll = 0;
    const edgeSkip = Math.max(3, Math.round(SMOOTH_UM / um / DU));   // ends of the fitted run: half the smoothing window is outside it
    for (let k = edgeSkip; k < P.nU - edgeSkip; k++) {
      if (vbs[k] !== vbs[k]) continue; nAll++;
      const vUm = vbs[k] * um; prof.push({uUm: r2((P.U[k] - P.U[0]) * um), vbUm: r2(vUm)});
      if (vbs[k] > 0) { nW++; sum += vUm; if (kMax < 0 || vbs[k] > vbs[kMax]) kMax = k; }
    }
    const toImg = (x, y) => [r2(x * I.s), r2(y * I.s)];
    const edge = {p0: toImg(L.cx + L.tx * L.u0, L.cy + L.ty * L.u0), p1: toImg(L.cx + L.tx * L.u1, L.cy + L.ty * L.u1), normal: [r4(L.nx), r4(L.ny)], rmsUm: r2(L.rms * um), fitShare: r2(L.nFit / L.nPts)};
    const out = Object.assign(base, {edge, profile: prof, wornPct: r2(100 * nW / (nAll || 1)), ms: 0});
    if (o.debug) Object.defineProperty(out, 'dbg', {value: {I, F, L, P, vbs, E, A, cands: E.cands.slice(0, 4).map(c => ({a: c.a, r: c.r, len: c.lenPx, step: r2(c.step), tr: r2(c.texRatio), dc: r2(c.darkClean), score: Math.round(c.score)}))}, enumerable: false});
    if (!nW) return Object.assign(out, {status: 'no-wear', reason: 'no land wider than ' + MIN_VB_UM + ' um along the edge', vbMaxUm: 0, vbMeanUm: 0, ms: Date.now() - t0});
    const u = P.U[kMax], xE = L.cx + L.tx * u, yE = L.cy + L.ty * u, d = vbs[kMax];
    const sh = []; for (let k = Math.max(0, kMax - 4); k <= Math.min(P.nU - 1, kMax + 4); k++) if (P.sharp[k] === P.sharp[k]) sh.push(P.sharp[k]);
    const sharpMax = sh.length ? sh.sort((p, q) => p - q)[sh.length >> 1] : 0;
    Object.assign(out, {status: 'ok', vbMaxUm: r2(d * um), vbMeanUm: r2(sum / nW),
      vbbUm: r2(sum / nW), wornLengthUm: r2(nW * DU * um),
      max: {ref: toImg(xE, yE), front: toImg(xE + L.nx * d, yE + L.ny * d), uUm: r2((u - P.U[0]) * um)}, sharpness: r2(sharpMax), ms: Date.now() - t0});
    return out;
  }

  return {measure, detectScaleBar, _reduce: reduce, _boxMean: boxMean, _overlayMask: overlayMask, _features: features, _findEdge: findEdge, _refineEdge: refineEdge, WORK_LONG};
});
