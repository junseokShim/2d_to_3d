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
      if ((r > 170 && g < 90 && b < 90 && r - g > 110) || (g > 150 && g - r > 70 && g - b > 70) || (b > 140 && b - r > 70 && b - g > 70) || (r > 248 && g > 248 && b > 248)) m[i] = 1;
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
        for (let d = 15; d <= 90; d += 15) { const i1 = at(x0 + nx * d, y0 + ny * d), i2 = at(x0 - nx * d, y0 - ny * d); if (i1 >= 0 && i2 >= 0) { hb += F.texC[i1]; hd += F.texC[i2]; kh++; } }
        const dm = b / kb; for (let d = 25; ; d += 10) { const i2 = at(x0 - nx * d, y0 - ny * d); if (i2 < 0) break; dn++; if (F.g6[i2] > dm + .5 * step) dk++; }
      }
      c.lenPx = good * 4; c.step = good ? cSum / good : 0; c.texRatio = kh ? (hb + 1) / (hd + 1) : 1; c.darkClean = dn ? 1 - dk / dn : 1;
      c.score = c.lenPx * Math.max(.5, Math.min(3, c.texRatio)) * (.3 + .7 * c.darkClean);
    }
    cands.sort((p, q) => q.score - p.score);
    return {cands, best: cands[0] || null, cs, sn};
  }

  // sub-pixel edge points along the candidate (max dark -> bright gradient within +-SEARCH px of the line), then a robust
  // straight line fit: total least squares, points farther than max(1.5 px, 2.5 x MAD) dropped, repeated. Chipped (edge
  // inside the tool) and built-up (outside) stretches leave the line and are not used: the fit is the reference line.
  const SEARCH = 14;
  function edgePoints(I, F, valid, nx, ny, px, py, search) {
    const {w, h} = I, G = F.g1, tx = -ny, ty = nx, diag = Math.hypot(w, h), pts = [];
    const val = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1 ? null : G[yi * w + xi]; };
    for (let u = -diag; u < diag; u += 2) {
      const x0 = px + tx * u, y0 = py + ty * u; if (x0 < 4 || y0 < 4 || x0 >= w - 4 || y0 >= h - 4) continue;
      let best = 0, bd = null;
      for (let d = -search; d <= search; d++) {
        const a = val(x0 + nx * (d + 1.5), y0 + ny * (d + 1.5)), b = val(x0 + nx * (d - 1.5), y0 + ny * (d - 1.5)); if (a == null || b == null) continue;
        const gr = a - b; if (gr > best) { best = gr; bd = d; }
      }
      if (bd != null && best > 8) { const x = x0 + nx * bd, y = y0 + ny * bd, ii = Math.round(y) * w + Math.round(x); if (valid[ii]) pts.push({x, y, g: best}); }
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
  const MIN_VB_UM = 10, MIN_VB_PX = 4;   // narrower than this is the edge transition itself, not a land
  const MAX_VB_UM = 600;        // search depth into the tool
  const REF_UM = [150, 300];    // flank reference band (distance from the edge line)
  const FEAT_UM = [1.5, 6, 15]; // box radii of the multi-scale features
  function anomaly(I, valid, L, um) {
    const {w, h} = I, n = w * h, R = v => Math.max(1, Math.round(v / um));
    const g = new Float32Array(n), c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const r = I.r[i], gg = I.g[i], b = I.b[i]; g[i] = .299 * r + .587 * gg + .114 * b; c[i] = (Math.max(r, gg, b) - Math.min(r, gg, b)) / 255; }
    const srt = Float32Array.from(g).sort(), p5 = srt[Math.floor(.05 * n)], p95 = srt[Math.floor(.95 * n)];
    for (let i = 0; i < n; i++) g[i] = (g[i] - p5) / (p95 - p5 + 1);
    const B = (a, r) => boxMean(a, valid, w, h, r), absd = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.abs(a[i] - b[i]); return o; };
    const r1 = R(FEAT_UM[0]), r4_ = R(FEAT_UM[1]), r10 = R(FEAT_UM[2]);
    const b1 = B(g, r1), b4 = B(g, r4_), b10 = B(g, r10), g2 = new Float32Array(n); for (let i = 0; i < n; i++) g2[i] = g[i] * g[i];
    const s4 = B(g2, r4_), sd4 = new Float32Array(n); for (let i = 0; i < n; i++) sd4[i] = Math.sqrt(Math.max(0, s4[i] - b4[i] * b4[i]));
    const F = [b1, b4, b10, B(absd(g, b1), R(4.5)), B(absd(b1, b4), R(6)), B(absd(b4, b10), R(9)), B(c, R(4.5)), B(c, R(12)), sd4, B(absd(c, B(c, R(3))), R(6))];
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
    for (let k = 0; k < nU; k++) {
      let last = D0 - 1, miss = 0, seen = 0;
      for (let d = D0; d < nD; d++) {
        const v = Ts[k * nD + d]; if (v !== v) { if (++miss > gap) break; continue; }
        seen++;
        if (v > thr) { last = d; miss = 0; } else if (++miss > gap) break;
      }
      if (!seen) continue;
      const W = last + 1; vb[k] = W >= minPx ? W : 0;
      if (W >= minPx) {
        let a = 0, ca = 0, b = 0, cb = 0;
        for (let d = Math.max(D0, W - 2 * gap); d < W; d++) { const v = Ts[k * nD + d]; if (v === v) { a += v; ca++; } }
        for (let d = W + 1; d <= Math.min(nD - 1, W + 2 * gap); d++) { const v = Ts[k * nD + d]; if (v === v) { b += v; cb++; } }
        sharp[k] = ca && cb ? (a / ca) / Math.max(1e-3, b / cb) : NaN;
      }
    }
    return {U, vb, sharp, nU, nD, Ts, thr};
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
    if (!L || L.nFit < 30 || L.rms > 2.5) return fail('not-detected', 'cutting edge is not straight enough to fit a reference line', {edgeRms: L && r2(L.rms), cands: o.debug ? base.dbgL : undefined});
    const A = anomaly(I, valid, L, um);
    if (!A) return fail('not-detected', 'no intact flank beside the edge to compare the land with', {});
    const P = landProfile(I, valid, L, um, A, o);
    // VB(t): running median (+-3) over the positions, then statistics
    const vbs = new Float32Array(P.nU).fill(NaN);
    for (let k = 0; k < P.nU; k++) { const a = []; for (let j = Math.max(0, k - 3); j <= Math.min(P.nU - 1, k + 3); j++) if (P.vb[j] === P.vb[j]) a.push(P.vb[j]); if (a.length >= 3) { a.sort((p, q) => p - q); vbs[k] = a[a.length >> 1]; } }
    const prof = []; let kMax = -1, sum = 0, nW = 0, nAll = 0;
    for (let k = 0; k < P.nU; k++) {
      if (vbs[k] !== vbs[k]) continue; nAll++;
      const vUm = vbs[k] * um; prof.push({uUm: r2((P.U[k] - P.U[0]) * um), vbUm: r2(vUm)});
      if (vbs[k] > 0) { nW++; sum += vUm; if (kMax < 0 || vbs[k] > vbs[kMax]) kMax = k; }
    }
    const toImg = (x, y) => [r2(x * I.s), r2(y * I.s)];
    const edge = {p0: toImg(L.cx + L.tx * L.u0, L.cy + L.ty * L.u0), p1: toImg(L.cx + L.tx * L.u1, L.cy + L.ty * L.u1), normal: [r4(L.nx), r4(L.ny)], rmsUm: r2(L.rms * um), fitShare: r2(L.nFit / L.nPts)};
    const out = Object.assign(base, {edge, profile: prof, wornPct: r2(100 * nW / (nAll || 1)), ms: 0});
    if (o.debug) Object.defineProperty(out, 'dbg', {value: {I, F, L, P, vbs, E, A}, enumerable: false});
    if (!nW) return Object.assign(out, {status: 'no-wear', reason: 'no land wider than ' + MIN_VB_UM + ' um along the edge', vbMaxUm: 0, vbMeanUm: 0, ms: Date.now() - t0});
    const u = P.U[kMax], xE = L.cx + L.tx * u, yE = L.cy + L.ty * u, d = vbs[kMax];
    const sh = []; for (let k = Math.max(0, kMax - 4); k <= Math.min(P.nU - 1, kMax + 4); k++) if (P.sharp[k] === P.sharp[k]) sh.push(P.sharp[k]);
    const sharpMax = sh.length ? sh.sort((p, q) => p - q)[sh.length >> 1] : 0;
    Object.assign(out, {status: 'ok', vbMaxUm: r2(d * um), vbMeanUm: r2(sum / nW),
      max: {ref: toImg(xE, yE), front: toImg(xE + L.nx * d, yE + L.ny * d), uUm: r2((u - P.U[0]) * um)}, sharpness: r2(sharpMax), ms: Date.now() - t0});
    return out;
  }

  return {measure, detectScaleBar, _reduce: reduce, _boxMean: boxMean, _overlayMask: overlayMask, _features: features, _findEdge: findEdge, _refineEdge: refineEdge, WORK_LONG};
});
