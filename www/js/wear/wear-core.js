/* Tool3D wear core: flank wear VB (ISO 8688-2) from end-mill photos.
 * Pure JS, no DOM, no network. Works in the browser (window.Tool3D.wear) and in Node (module.exports).
 * Image in: {width, height, data: RGBA bytes}. Side photos: tip up, one photo per flute, that flute facing the camera.
 * Output: the board contract object (window.Tool3D.wearResult) + a debug object.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.wear = Object.assign(root.Tool3D.wear || {}, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180;
  const DEFAULTS = {
    helixDeg: null,        // null = estimate from photo (fallback 30)
    clearanceDeg: 8,       // peripheral clearance angle for the volume wedge
    zoneMm: null,          // axial length from tip to evaluate; null = 0.8 * D
    sens: 4,               // wear threshold = median + sens * robust sigma of tool body brightness
    binMm: 0.1             // profile step along the axis
  };

  // ---------- basic image ops ----------
  function gray(img) {
    const {width: w, height: h, data: d} = img, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2];
    return {w, h, g};
  }
  function sobel({w, h, g}) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      gy[i] = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    }
    return {gx, gy};
  }
  const quant = (a, p) => { const b = Float32Array.from(a).sort(); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
  const bilinear = (g, w, h, x, y) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
    const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y)), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  };
  const r4 = v => Math.round(v * 1e4) / 1e4;

  // ---------- 1. auto align: tilt, silhouette, scale, tip ----------
  // Frame: u across the tool, v along the axis (down = toward shank). Image point = c + u*n + v*a,
  // n = (cos t, -sin t), a = (sin t, cos t), c = image centre.
  function align(G, grad, diameterMm, expectSepPx) {
    const {w, h} = G, {gx, gy} = grad, cx0 = w / 2, cy0 = h / 2;
    const mag = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);
    const thr = quant(mag.filter((_, i) => i % 5 === 0), .85);
    const E = [];                                   // strong edge pixels only (speed)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (mag[i] > thr) E.push(i); }
    const U = Math.ceil(Math.hypot(w, h)), off = U / 2;
    const project = t => {
      const c = Math.cos(t), s = Math.sin(t), P = new Float32Array(U + 1);
      for (const i of E) {
        const x = i % w - cx0, y = (i / w | 0) - cy0, gu = gx[i] * c - gy[i] * s, gv = gx[i] * s + gy[i] * c;
        if (Math.abs(gu) > 2.5 * Math.abs(gv)) P[Math.round(x * c - y * s + off)] += Math.abs(gu);
      }
      const Q = new Float32Array(U + 1);            // light smoothing
      for (let i = 1; i < U; i++) Q[i] = .25 * P[i - 1] + .5 * P[i] + .25 * P[i + 1];
      return Q;
    };
    const pair = Q => {                             // outermost strong peaks = silhouette
      let mx = 0; for (const q of Q) mx = Math.max(mx, q);
      const pk = []; for (let i = 1; i < Q.length - 1; i++) if (Q[i] >= Q[i - 1] && Q[i] > Q[i + 1] && Q[i] > .35 * mx) pk.push(i);
      if (pk.length < 2) return null;
      if (expectSepPx) {                            // scale known from the other photos: best pair of about that width
        let b = null;
        for (const l of pk) for (const r of pk) if (r > l && Math.abs(r - l - expectSepPx) < .15 * expectSepPx && (!b || Q[l] + Q[r] > b.score)) b = {l, r, score: Q[l] + Q[r]};
        return b;
      }
      const l = pk[0], r = pk[pk.length - 1];
      return r - l < .03 * Math.min(w, h) ? null : {l, r, score: Q[l] + Q[r]};
    };
    let best = null;
    const tryT = t => { const p = pair(project(t)); if (p && (!best || p.score > best.score)) best = {t, ...p}; };
    for (let a = -15; a <= 15; a += 1) tryT(a * DEG);
    if (!best) return null;
    const t1 = best.t; for (let a = -1; a <= 1.001; a += .1) tryT(t1 + a * DEG);
    // sub-pixel peak position (parabola)
    const Q = project(best.t), sub = i => { const d = Q[i - 1] - 2 * Q[i] + Q[i + 1]; return d < 0 ? i + .5 * (Q[i - 1] - Q[i + 1]) / d : i; };
    const uL = sub(best.l) - off, uR = sub(best.r) - off, t = best.t, c = Math.cos(t), s = Math.sin(t);
    const sep = uR - uL, ppm = sep / diameterMm, uC = (uL + uR) / 2;
    const toImg = (u, v) => [cx0 + u * c + v * s, cy0 - u * s + v * c];
    const gu = (u, v) => { const [x, y] = toImg(u, v); const X = Math.round(x), Y = Math.round(y); return X > 0 && Y > 0 && X < w - 1 && Y < h - 1 ? Math.abs(gx[Y * w + X] * c - gy[Y * w + X] * s) : 0; };
    const gvAt = (u, v) => { const [x, y] = toImg(u, v); const X = Math.round(x), Y = Math.round(y); return X > 0 && Y > 0 && X < w - 1 && Y < h - 1 ? Math.abs(gx[Y * w + X] * s + gy[Y * w + X] * c) : 0; };
    // tip: first v (from top) where both silhouette edges are present
    const vMin = Math.ceil(-Math.hypot(w, h) / 2), vMax = -vMin, F = [], V = [];
    for (let v = vMin; v <= vMax; v++) {
      const [x, y] = toImg(uC, v); if (x < 0 || y < 0 || x >= w || y >= h) continue;
      let el = 0, er = 0; for (let j = -2; j <= 2; j++) { el = Math.max(el, gu(uL + j, v)); er = Math.max(er, gu(uR + j, v)); }
      V.push(v); F.push(Math.min(el, er));
    }
    const body = quant(F, .75), win = Math.max(3, Math.round(.08 * sep));
    let k = 0; const run = i => { let m = 0; for (let j = 0; j < win; j++) m += F[i + j] || 0; return m / win; };
    while (k < F.length - win && run(k) < .4 * body) k++;
    let vTip = V[k];
    // refine: strongest across-the-tool (horizontal) edge near the candidate, central 60 % of the width
    let bv = vTip, bs = -1;
    for (let v = vTip - Math.round(.15 * sep); v <= vTip + Math.round(.1 * sep); v++) {
      let sc = 0; for (let u = uC - .3 * sep; u <= uC + .3 * sep; u++) sc += gvAt(u, v);
      if (sc > bs) { bs = sc; bv = v; }
    }
    vTip = bv;
    return {t, tiltDeg: t / DEG, uL, uR, uC, sepPx: sep, pxPerMm: ppm, vTip, toImg, tipPx: toImg(uC, vTip)};
  }

  // resample into an axis-aligned strip: column = u (centred on the axis), row = v from the tip, native px/mm
  function rectify(G, al, lenMm) {
    const ppm = al.pxPerMm, R = al.sepPx / 2, m = Math.ceil(.1 * al.sepPx), W = Math.ceil(2 * R) + 2 * m;
    const top = Math.ceil(.1 * al.sepPx), H = Math.ceil(lenMm * ppm) + top, g = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let col = 0; col < W; col++) {
      const [x, y] = al.toImg(al.uC - R - m + col + .5, al.vTip - top + r);
      g[r * W + col] = bilinear(G.g, G.w, G.h, x, y);
    }
    return {w: W, h: H, g, cx: m + R - .5, R, top, ppm};
  }

  // helix angle from the dominant edge orientation in the central band of the body (structure tensor)
  function helix(strip, fromRow) {
    const {w, h, g, cx, R} = strip; let Jxx = 0, Jyy = 0, Jxy = 0;
    for (let y = Math.max(1, fromRow); y < h - 1; y++) for (let x = Math.round(cx - .4 * R); x <= cx + .4 * R; x++) {
      const i = y * w + x, a = (g[i + 1] - g[i - 1]) / 2, b = (g[i + w] - g[i - w]) / 2;
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      Jxx += a * a; Jyy += b * b; Jxy += a * b;
    }
    const phi = .5 * Math.atan2(2 * Jxy, Jxx - Jyy), coh = Math.hypot(Jxx - Jyy, 2 * Jxy) / ((Jxx + Jyy) || 1);
    const beta = Math.abs(phi) / DEG;
    return coh < .1 || beta < 10 || beta > 60 ? null : beta;
  }

  // ---------- 2. wear band segmentation on the flank land ----------
  function segment(strip, zoneRows, sens) {
    const {w, h, g, cx, R, top} = strip, inTool = x => Math.abs(x - cx) < .96 * R;
    const ref = [];
    for (let y = top + Math.round(.05 * 2 * R); y < h; y += 2) for (let x = 0; x < w; x += 2) if (inTool(x) && !Number.isNaN(g[y * w + x])) ref.push(g[y * w + x]);
    const med = quant(ref, .5), mad = quant(ref.map(v => Math.abs(v - med)), .5), sig = Math.max(4, 1.4826 * mad), thr = med + sens * sig;
    const y1 = Math.min(h, top + zoneRows), raw = new Uint8Array(w * h);
    for (let y = Math.max(0, top - 1); y < y1; y++) for (let x = 0; x < w; x++) if (inTool(x) && g[y * w + x] > thr) raw[y * w + x] = 1;
    // morphological opening with a 2x2 element: removes 1-px glints, keeps bands >= 2 px wide
    const er = new Uint8Array(w * h), mask = new Uint8Array(w * h);
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x; er[i] = raw[i] & raw[i + 1] & raw[i + w] & raw[i + w + 1]; }
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x; if (er[i]) mask[i] = mask[i + 1] = mask[i + w] = mask[i + w + 1] = 1; }
    // connected components; keep the largest (the flute facing the camera)
    const lab = new Int32Array(w * h), sizes = [0]; let n = 0;
    for (let s = 0; s < w * h; s++) if (mask[s] && !lab[s]) {
      n++; let size = 0; const st = [s]; lab[s] = n;
      while (st.length) {
        const p = st.pop(); size++; const x = p % w;
        for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && Math.abs(q % w - x) <= 1 && mask[q] && !lab[q]) { lab[q] = n; st.push(q); }
      }
      sizes.push(size);
    }
    let best = 0; for (let i = 1; i <= n; i++) if (sizes[i] > (sizes[best] || 0)) best = i;
    const band = new Uint8Array(w * h);
    if (best && sizes[best] >= 4) for (let i = 0; i < w * h; i++) if (lab[i] === best) band[i] = 1;
    return {band, thr, med, sig, y1};
  }

  // ---------- 3. VB profile along the cutting edge + area + volume ----------
  // Row width in the photo -> arc width on the cylinder (undo foreshortening) -> width normal to the helical edge.
  //   s = R * asin(u / R)  (arc length),  VB = (s2 - s1) * cos(helix)
  // Area   = sum over rows of (s2 - s1) * dz                  (true surface area of the band)
  // Volume = sum over rows of 0.5 * VB^2 * tan(clearance) * dz / cos(helix)   (wedge per unit edge length)
  function measureBand(strip, seg, o) {
    const {w, g, cx, R, top, ppm} = strip, Rmm = R / ppm, cb = Math.cos(o.helixDeg * DEG), tc = Math.tan(o.clearanceDeg * DEG);
    const arc = u => Rmm * Math.asin(Math.max(-1, Math.min(1, u / R)));
    const rows = [];
    for (let y = top; y < seg.y1; y++) {
      let a = -1, b = -1; for (let x = 0; x < w; x++) if (seg.band[y * w + x]) { if (a < 0) a = x; b = x; }
      rows.push(a < 0 ? 0 : arc(b + .5 - cx) - arc(a - .5 - cx));
    }
    // 3-row median against single-row noise
    const ws = rows.map((_, i) => { const q = rows.slice(Math.max(0, i - 1), i + 2).sort((p, r) => p - r); return q[q.length >> 1]; });
    const dz = 1 / ppm, vb = ws.map(s => s * cb);
    let area = 0, vol = 0; ws.forEach((s, i) => { area += s * dz; vol += .5 * vb[i] ** 2 * tc * dz / cb; });
    const nb = Math.max(1, Math.round(o.binMm * ppm)), profile = [];
    for (let i = 0; i < vb.length; i += nb) {
      const sl = vb.slice(i, i + nb); profile.push({zMm: r4((i + sl.length / 2) * dz), vbMm: r4(sl.reduce((p, q) => p + q, 0) / sl.length)});
    }
    const worn = vb.filter(v => v > 0);
    return {
      vbMaxMm: r4(worn.length ? Math.max(...worn) : 0),
      vbAvgMm: r4(worn.length ? worn.reduce((p, q) => p + q, 0) / worn.length : 0),
      areaMm2: r4(area), volumeMm3: r4(vol), profile, wornLengthMm: r4(worn.length * dz)
    };
  }

  function analyzeSide(img, opts) {
    const o = Object.assign({}, DEFAULTS, opts), D = o.diameterMm;
    if (!(D > 0)) throw new Error('diameterMm required');
    const G = gray(img), al = align(G, sobel(G), D, o.expectPxPerMm && o.expectPxPerMm * D);
    if (!al) return null;
    const zone = o.zoneMm || .8 * D, strip = rectify(G, al, Math.max(zone + .3 * D, 1.2 * D));
    const hEst = helix(strip, strip.top + Math.round(zone * strip.ppm));
    const helixDeg = o.helixDeg || hEst || 30;
    const seg = segment(strip, Math.round(zone * strip.ppm), o.sens);
    const m = measureBand(strip, seg, Object.assign({}, o, {helixDeg}));
    return Object.assign(m, {
      align: {tiltDeg: r4(al.tiltDeg), pxPerMm: r4(al.pxPerMm), tipPx: al.tipPx.map(r4), axisPx: al.toImg(al.uC, al.vTip + 10).map(r4)},
      helixDegEstimated: hEst && r4(hEst), helixDegUsed: helixDeg, threshold: r4(seg.thr), strip, band: seg.band
    });
  }

  // ---------- top photo: end-face circle -> scale check + bright (worn) area on the end face ----------
  function analyzeTop(img, opts) {
    const D = opts.diameterMm, G0 = gray(img), sc = Math.min(1, 240 / Math.max(G0.w, G0.h));
    const w = Math.round(G0.w * sc), h = Math.round(G0.h * sc), g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = bilinear(G0.g, G0.w, G0.h, x / sc, y / sc) || 0;
    const {gx, gy} = sobel({w, h, g}), mn = Math.min(w, h);
    const mag = new Float32Array(w * h).map((_, i) => Math.hypot(gx[i], gy[i])), T = .5 * quant(mag, .95);
    const score = (cx, cy, r) => {
      let v = 0;
      for (let j = 0; j < 48; j++) {
        const a = j * Math.PI / 24, c = Math.cos(a), s = Math.sin(a), x = Math.round(cx + r * c), y = Math.round(cy + r * s);
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1 && Math.abs(gx[y * w + x] * c + gy[y * w + x] * s) > T) v++;
      }
      return v / 48;
    };
    let b = {v: -1};
    for (let cy = .2 * h; cy <= .8 * h; cy += 3) for (let cx = .2 * w; cx <= .8 * w; cx += 3)
      for (let r = .06 * mn; r <= .45 * mn; r += 2) { const v = score(cx, cy, r); if (v > b.v) b = {v, cx, cy, r}; }
    const c0 = Object.assign({}, b);
    for (let cy = c0.cy - 3; cy <= c0.cy + 3; cy++) for (let cx = c0.cx - 3; cx <= c0.cx + 3; cx++)
      for (let r = c0.r - 2; r <= c0.r + 2; r += .5) { const v = score(cx, cy, r); if (v > b.v) b = {v, cx, cy, r}; }
    const cx = b.cx / sc, cy = b.cy / sc, r = b.r / sc, ppm = 2 * r / D, vals = [], idx = [];
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(G0.h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(G0.w, cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 < (.95 * r) ** 2) { vals.push(G0.g[y * G0.w + x]); idx.push(y * G0.w + x); }
    const med = quant(vals, .5), sig = Math.max(4, 1.4826 * quant(vals.map(v => Math.abs(v - med)), .5)), thr = med + (opts.sens || DEFAULTS.sens) * sig;
    const n = vals.filter(v => v > thr).length;
    return {cx: r4(cx), cy: r4(cy), rPx: r4(r), pxPerMm: r4(ppm), circleScore: r4(b.v), endBrightAreaMm2: r4(n / ppm / ppm)};
  }

  // ---------- full run -> board contract ----------
  function measure({sides, top, flutes, diameterMm, helixDeg, clearanceDeg, zoneMm, sens}) {
    const k = flutes || sides.length, o = {diameterMm, helixDeg, clearanceDeg, zoneMm, sens};
    Object.keys(o).forEach(key => o[key] == null && delete o[key]);
    let S = sides.slice(0, k).map(img => analyzeSide(img, o));
    // photos come from one camera setup: a side whose scale is >20 % off the median is re-aligned at the median scale
    const pp = S.filter(Boolean).map(s => s.align.pxPerMm).sort((a, b) => a - b), ppMed = pp[pp.length >> 1];
    if (pp.length >= 2) S = S.map((s, i) => !s || Math.abs(s.align.pxPerMm / ppMed - 1) > .2 ? analyzeSide(sides[i], Object.assign({}, o, {expectPxPerMm: ppMed})) : s);
    const ok = S.filter(Boolean);
    const hs = ok.map(s => s.helixDegEstimated).filter(Boolean).sort((a, b) => a - b);
    const helixUsed = helixDeg || (hs.length ? hs[hs.length >> 1] : 30);
    // re-run with one common helix angle so every flute uses the same geometry
    const S2 = S.map((s, i) => s && (s.helixDegUsed === helixUsed ? s : analyzeSide(sides[i], Object.assign({}, o, {helixDeg: helixUsed, expectPxPerMm: s.align.pxPerMm}))));
    const empty = {vbMaxMm: 0, vbAvgMm: 0, areaMm2: 0, volumeMm3: 0, profile: []};
    const perFlute = S2.map(s => s ? {vbMaxMm: s.vbMaxMm, vbAvgMm: s.vbAvgMm, areaMm2: s.areaMm2, volumeMm3: s.volumeMm3, profile: s.profile} : Object.assign({}, empty));
    const result = {
      flutes: k, diameterMm, helixDeg: r4(helixUsed), perFlute,
      totals: {
        vbMaxMm: r4(Math.max(0, ...perFlute.map(f => f.vbMaxMm))),
        areaMm2: r4(perFlute.reduce((p, f) => p + f.areaMm2, 0)),
        volumeMm3: r4(perFlute.reduce((p, f) => p + f.volumeMm3, 0))
      }
    };
    const topRes = top ? analyzeTop(top, {diameterMm, sens}) : null;
    const debug = {
      sides: S2.map(s => s && {align: s.align, threshold: s.threshold, wornLengthMm: s.wornLengthMm, helixDegEstimated: s.helixDegEstimated}),
      failedSides: S2.map((s, i) => s ? -1 : i).filter(i => i >= 0), top: topRes,
      warnings: S2.map((s, i) => s && s.align.pxPerMm < 20 ? `side ${i + 1}: ${s.align.pxPerMm.toFixed(1)} px/mm, below 20 px/mm; VB is not reliable (1 px = ${(1 / s.align.pxPerMm).toFixed(2)} mm)` : null).filter(Boolean),
      strips: S2.map(s => s && {strip: s.strip, band: s.band}),
      model: 'VB normal to helical edge = arc width * cos(helix); area = sum arc width * dz; volume = sum 0.5*VB^2*tan(clearance)*dz/cos(helix)'
    };
    return {result, debug};
  }

  return {DEFAULTS, gray, sobel, align, rectify, segment, measureBand, analyzeSide, analyzeTop, measure};
});
