/* Tool3D microscope input: flank wear VB on microscope close-ups of one cutting edge (flank land in view, no silhouette,
 * like MUDESTREDA). Pure JS, no DOM: browser (window.Tool3D.micro.core) and Node (module.exports).
 *
 *  1. scale: px/mm from the microscope calibration of the chosen magnification (um/px typed in, or a stage micrometer /
 *     known length measured on an image), never from the tool diameter; saved per magnification (localStorage-like store)
 *  2. the U-Net of seg-wear.js runs on the whole image at the scale it saw MUDESTREDA at (no tool alignment); the image is
 *     first turned by 90-degree steps so the tool is above the edge (the network was trained that way, +-20 deg)
 *  3. cutting edge = the tool / background boundary, robust straight-line fit (chipped stretches, where the edge recedes
 *     into the tool, are left out: the reference is the original edge line)
 *  4. VB per position along the edge = the wear land (flank wear + chipping touching the edge) measured normal to the edge
 *     line; ISO 8688-2: VBB (mean) and VBBmax in zone B, VBC in the corner zone C (if the corner is in view)
 *  5. U (k=2) = scale (calibration) + edge line (fit residuals) + wear boundary (probability WEAR_LO/WEAR_HI spread) + pixel
 *  6. an edge-aligned strip per flute for the metrology panel (js/metro): rows along the edge, flank to the right of the
 *     edge column, flat (no cylinder), helix 0; several images of one flute are stacked along the edge with a gap
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.micro = root.Tool3D.micro || {}; root.Tool3D.micro.core = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAGS = [10, 20, 30, 50, 100, 200, 500];
  const NET_LONG = 1600;       // network input long side cap: the land reads best near native resolution (MUDESTREDA val T3: MAE VBmax 41 px at 500, 31 at 1100, 25 at 1550)
  const PADV = 24;             // strip columns kept on the background side of the edge line (px)
  const GAP = 8;               // strip rows between two images of one flute
  // wear = p(flank wear) + p(chipping) above WEAR_THR. The network was trained on MUDESTREDA with the unworn tool body ignored,
  // so at argmax it spills wear into the tool body (val T3: VBmax bias +25 px, sharp tools read x2). The threshold was picked
  // on the val split only (VBmax MAE 25 -> 6.7 px, VBB 12.4 -> 6.5); WEAR_LO / WEAR_HI bracket it for the boundary part of U
  const WEAR_THR = .985, WEAR_LO = .95, WEAR_HI = .995;
  const VB_REF = 'reference';   // default VB method: 'reference' (Keyence-style line on the unworn edge) | 'edge' (fitted edge)
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const med = a => { const b = Array.from(a).sort((p, q) => p - q); return b.length ? b[b.length >> 1] : 0; };

  // ---------- calibration (px/mm) ----------
  // typed um/px (the microscope's own calibration): u_rel as given (default 1 %, rectangular -> /sqrt3)
  function calibUm(umPerPx, tolPct = 1) {
    if (!(umPerPx > 0)) return null;
    const uRel = r4(tolPct / 100 / Math.sqrt(3));
    return {method: 'um/px', umPerPx: r4(umPerPx), pxPerMm: r4(1000 / umPerPx), uRel, parts: {microscope: uRel}};
  }
  // stage micrometer / known length: line of px pixels = mm; reference tolerance tolMm (rectangular) + two picked ends
  function calibLine(px, mm, tolMm = 0, sigmaPx = 1) {
    if (!(px > 0 && mm > 0)) return null;
    const parts = {reference: r4(tolMm / Math.sqrt(3) / mm), picks: r4(Math.SQRT2 * sigmaPx / px)}, ppm = px / mm;
    return {method: 'micrometer', umPerPx: r4(1000 / ppm), pxPerMm: r4(ppm), uRel: r4(Math.hypot(parts.reference, parts.picks)), parts, lineMm: mm, linePx: r4(px)};
  }
  // per-magnification store: {"50": {method, pxPerMm, umPerPx, uRel, parts, date}}
  const CKEY = 'tool3d.micro.calib';
  function calStore(store) {
    const all = () => { try { return JSON.parse(store.getItem(CKEY) || '{}') || {}; } catch (e) { return {}; } };
    const put = a => { try { store.setItem(CKEY, JSON.stringify(a)); } catch (e) { /* quota / private mode */ } };
    return {
      all, get: mag => all()[String(mag)] || null,
      set(mag, cal) { const a = all(); a[String(mag)] = Object.assign({}, cal, {date: cal.date || new Date().toISOString().slice(0, 10)}); put(a); return a[String(mag)]; },
      remove(mag) { const a = all(); delete a[String(mag)]; put(a); }
    };
  }
  // the metrology panel's calibration object (metro-core calibration() shape); fixed scale: strips are made at this px/mm
  function metroCalib(cal, mag) {
    return {method: 'microscope', pxPerMm: cal.pxPerMm, uRel: cal.uRel, U_pxPerMm: r4(2 * cal.uRel * cal.pxPerMm), parts: cal.parts, magnification: mag,
      source: cal.method, scaleFor: stripPpm => stripPpm / cal.pxPerMm};
  }

  // ---------- image helpers (ImageData-like {width, height, data RGBA}) ----------
  // rotate by q x 90 deg clockwise
  function rotate(img, q) {
    q = ((q % 4) + 4) % 4; if (!q) return img;
    const {width: w, height: h, data: d} = img, W = q % 2 ? h : w, H = q % 2 ? w : h, o = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [X, Y] = q === 1 ? [h - 1 - y, x] : q === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x], i = 4 * (y * w + x), j = 4 * (Y * W + X);
      o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255;
    }
    return {width: W, height: H, data: o};
  }
  // point in the rotated image -> original image (inverse of rotate)
  function unrotate(q, w, h, X, Y) { q = ((q % 4) + 4) % 4; return q === 0 ? [X, Y] : q === 1 ? [Y, h - 1 - X] : q === 2 ? [w - 1 - X, h - 1 - Y] : [w - 1 - Y, X]; }

  // which side the tool is on: mean gradient of the tool probability (1 - background) points into the tool.
  // -> clockwise quarter turns that bring the tool on top
  function toolSide(seg) {
    const {prob, w, h} = seg, fg = i => 1 - prob[i];
    let gx = 0, gy = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx += fg(i + 1) - fg(i - 1); gy += fg(i + w) - fg(i - w); }
    gx /= w * h; gy /= w * h;
    const q = Math.abs(gy) >= Math.abs(gx) ? (gy <= 0 ? 0 : 2) : (gx < 0 ? 1 : 3);
    return {q, gx: r4(gx), gy: r4(gy), strength: r4(Math.hypot(gx, gy))};
  }

  // ---------- cutting edge: tool / background boundary, robust line fit ----------
  // tool on top: per network column the lowest row of the tool run (tool = not background, 3 rows in a row), sub-pixel
  // at p_fg = .5; image px. Line y = a + b x fitted with Tukey weights, then points above the line by more than 2.5 sigma
  // (edge receded = chipped / broken) dropped and refitted: the reference is the original cutting edge
  function fitEdge(seg) {
    const {prob, w, h, scale: [sx, sy]} = seg, fg = (x, y) => 1 - prob[y * w + x], pts = [];
    for (let x = 0; x < w; x++) {
      let y = h - 1; while (y >= 2 && !(fg(x, y) > .5 && fg(x, y - 1) > .5 && fg(x, y - 2) > .5)) y--;
      if (y < 2 || y >= h - 1) continue;                     // no tool in this column, or the tool reaches the bottom
      const p0 = fg(x, y), p1 = fg(x, y + 1), t = p0 > p1 ? (p0 - .5) / (p0 - p1) : 0;
      // third element: label oracle only (seg.ign = ignore pixels of a hand mask): the edge lies in a wide ignore band (unknown)
      const ig = seg.ign && (() => { let n = 0; for (let k = y + 1; k >= 0 && seg.ign[k * w + x]; k--) n++; for (let k = y + 2; k < h && seg.ign[k * w + x]; k++) n++; return n >= 16; })();
      pts.push(ig ? [(x + .5) * sx - .5, (y + .5 + t) * sy - .5, 1] : [(x + .5) * sx - .5, (y + .5 + t) * sy - .5]);
    }
    if (pts.length < Math.max(8, .3 * w)) return null;
    const L = robustLine(pts); if (!L) return null;
    return Object.assign(L, {cover: r4(pts.length / w), pts});
  }
  // line y = a + b x through points: Tukey-weighted fit, then points above the line by more than 2.5 sigma (edge receded =
  // chipped / broken) dropped and refitted
  function robustLine(pts) {
    const fit = (P, wt) => {
      let s = 0, sxx = 0, sx_ = 0, sy_ = 0, sxy = 0;
      P.forEach(([x, y], i) => { const q = wt ? wt[i] : 1; s += q; sx_ += q * x; sy_ += q * y; sxx += q * x * x; sxy += q * x * y; });
      const d = s * sxx - sx_ * sx_; if (!d) return null; const b = (s * sxy - sx_ * sy_) / d; return {a: (sy_ - b * sx_) / s, b};
    };
    let L = fit(pts), wt = null, sig = 0;
    for (let it = 0; it < 8 && L; it++) {
      const res = pts.map(([x, y]) => y - L.a - L.b * x); sig = 1.4826 * med(res.map(Math.abs)) || 1;
      wt = res.map(r => { const u = r / (4.685 * sig); return Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0; });
      L = fit(pts, wt);
    }
    if (!L) return null;
    let res = pts.map(([x, y]) => y - L.a - L.b * x); sig = 1.4826 * med(res.map(Math.abs)) || 1;
    const keep = pts.filter((_, i) => res[i] > -2.5 * sig); L = fit(keep) || L;
    res = keep.map(([x, y]) => y - L.a - L.b * x); sig = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / Math.max(1, res.length - 2));
    return {a: L.a, b: L.b, sigmaPx: r4(sig), n: keep.length, receded: pts.length - keep.length};
  }

  // ---------- reference line (Keyence VHX style): the original cutting edge fitted on its unworn part ----------
  // The worn stretch of an edge is not where the edge was: it is rounded, chipped (receded into the tool) or smeared / built
  // up (lies outside the original line; Keyence 152008: up to 24 um). A VHX operator fits a line on the unworn part of the
  // edge and measures VB perpendicular to it. Here: edge points whose raw land (edge-line maths) is at most REF_UNWORN of the
  // largest land, or a few network px, are the unworn part; with fewer than REF_MIN of the edge points unworn, the edge fit
  // itself is the reference (source 'edge': the whole edge in view is worn, as in most MUDESTREDA close-ups); also when the
  // unworn line and the edge fit lie within max(REF_GAP network px, 2 sigma) of each other over the worn stretch.
  const REF_UNWORN = .15, REF_MIN = .1, REF_GAP = +(typeof process !== 'undefined' && process.env && process.env.REF_GAP) || 3;
  function refEdge(line, F, raw, sx) {
    const pts = line.pts || [], L = raw.length, uOf = ([x, y]) => x * F.t[0] + (y - line.a) * F.t[1] - F.u0;
    let mx = 0; for (let u = 0; u < L; u++) mx = Math.max(mx, raw[u]);
    const lim = Math.max(3 * sx, REF_UNWORN * mx), halfW = Math.max(2, Math.round(sx));
    const un = pts.filter(p => { const u = Math.round(uOf(p)); let m = 0; for (let k = Math.max(0, u - halfW); k <= Math.min(L - 1, u + halfW); k++) m = Math.max(m, raw[k]); return u >= 0 && u < L && m <= lim && !p[2]; });
    const base = {unwornLimPx: r4(lim), unwornPts: un.length, nPts: pts.length};
    if (!(mx > 0) || un.length < Math.max(8, REF_MIN * pts.length)) return Object.assign({a: line.a, b: line.b, sigmaPx: line.sigmaPx, source: 'edge'}, base);
    // consensus line: the unworn stretch can hold junk (overlay text, dust, the image border), so the line is the one most
    // unworn points lie on (within tol, deterministic pairs of an even subsample), then a robust refit on those points
    const tol = Math.max(2, 1.5 * sx), S = un.filter((_, i) => i % Math.max(1, Math.floor(un.length / 60)) === 0);
    let best = null, bestN = -1;
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
      const [x1, y1] = S[i], [x2, y2] = S[j]; if (Math.abs(x2 - x1) < 10 * sx) continue;
      const b = (y2 - y1) / (x2 - x1), a = y1 - b * x1, c = Math.sqrt(1 + b * b);
      let n = 0; for (const [x, y] of un) if (Math.abs(y - a - b * x) / c <= tol) n++;
      if (n > bestN) { bestN = n; best = {a, b}; }
    }
    const inl = best ? un.filter(([x, y]) => Math.abs(y - best.a - best.b * x) / Math.sqrt(1 + best.b * best.b) <= 2 * tol) : un;
    const R = inl.length >= 8 ? robustLine(inl) : null; if (!R) return Object.assign({a: line.a, b: line.b, sigmaPx: line.sigmaPx, source: 'edge'}, base);
    // span of the fitted unworn stretch along the edge (share of the edge line in view): a short stretch extrapolates its angle
    const us = inl.map(uOf).sort((p, q) => p - q), span = (us[Math.floor(.98 * (us.length - 1))] - us[Math.floor(.02 * (us.length - 1))]) / Math.max(1, L);
    // the two lines over the worn stretch: when they agree (the worn edge still lies on the original line), the fit to the
    // whole edge is the better-determined reference; they part when the worn edge is smeared out / rounded / broken
    const worn = pts.filter(p => !un.includes(p) && !p[2]), n1 = Math.hypot(1, R.b);
    const gap = worn.length ? med(worn.map(([x]) => Math.abs((line.a + line.b * x) - (R.a + R.b * x)) / n1)) : 0, gapLim = Math.max(REF_GAP * sx, 2 * line.sigmaPx);
    const outPx = worn.length ? med(worn.map(([x, y]) => (y - R.a - R.b * x) / n1)) : 0;   // + = the worn edge lies outside the line
    Object.assign(base, {inliers: inl.length, span: r4(span), gapPx: r4(gap), gapLimPx: r4(gapLim), wornOutPx: r4(outPx)});
    if (!(outPx > gapLim)) return Object.assign({a: line.a, b: line.b, sigmaPx: line.sigmaPx, source: 'edge'}, base);
    return Object.assign(R, base, {source: 'unworn'});
  }

  // ---------- edge frame: u along the edge line, v normal into the tool ----------
  function frame(line, W, H) {
    const n = Math.hypot(1, line.b), t = [1 / n, line.b / n], nv = [line.b / n, -1 / n];   // nv: up (into the tool)
    const p0 = [0, line.a];
    // u range: the part of the line inside the image
    let u0 = Infinity, u1 = -Infinity;
    for (let x = 0; x <= W - 1; x += .5) { const y = line.a + line.b * x; if (y >= 0 && y <= H - 1) { const u = (x - p0[0]) * t[0] + (y - p0[1]) * t[1]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); } }
    if (!(u1 > u0)) return null;
    const L = Math.floor(u1 - u0) + 1;
    // v range up to the far image border (max over the corners)
    let V = 0; for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) V = Math.max(V, (x - p0[0]) * nv[0] + (y - p0[1]) * nv[1]);
    V = Math.ceil(V);
    const toImg = (u, v) => [p0[0] + (u0 + u) * t[0] + v * nv[0], p0[1] + (u0 + u) * t[1] + v * nv[1]];
    return {L, V, u0, t, nv, toImg};
  }

  // class of an image position from the network probabilities (bilinear, argmax); outside the image -> -1
  function classAtImg(seg, x, y, W, H, thr) {
    if (x < -.5 || y < -.5 || x > W - .5 || y > H - .5) return -1;
    const {prob, w, h, scale: [sx, sy]} = seg, n = w * h;
    const X = Math.max(0, Math.min(w - 1.001, (x + .5) / sx - .5)), Y = Math.max(0, Math.min(h - 1.001, (y + .5) / sy - .5));
    const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0, i = y0 * w + x0;
    const P = c => { const o = c * n + i; return (prob[o] * (1 - fx) + prob[o + 1] * fx) * (1 - fy) + (prob[o + w] * (1 - fx) + prob[o + w + 1] * fx) * fy; };
    if (thr != null) { const pw = P(2) + P(3); return pw > thr ? 2 : P(0) > .5 ? 0 : 1; }
    let b = 0, bp = -1; for (let c = 0; c < 5; c++) { const p = P(c); if (p > bp) { bp = p; b = c; } }
    return b;
  }

  // VB per edge row (px, normal to the edge line) from a class lookup cls(u, v) (2/3 = wear, -1 outside):
  // wear pixels in connected pieces that touch the edge (|v| <= vTol), the land's far boundary per row, running median.
  // fill (reference line): background inside the line (v > 0, material broken out of the original edge) joins the pieces,
  // so a land behind a chipped stretch still touches the line; far is still the last wear pixel
  function landRows(cls, L, V, vTol, smooth, fill) {
    const Wc = PADV + V, m = new Uint8Array(L * Wc), out = new Uint8Array(L);
    for (let u = 0; u < L; u++) for (let c = 0; c < Wc; c++) { const k = cls(u, c - PADV); if (k === 2 || k === 3) m[u * Wc + c] = 1; else if (k < 0) out[u] = 1; else if (fill && k === 0 && c > PADV) m[u * Wc + c] = 2; }
    const lab = new Int32Array(L * Wc), touch = [0], st = [];
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || lab[s]) continue;
      const id = touch.length; let tt = 0; lab[s] = id; st.push(s);
      while (st.length) {
        const i = st.pop(), u = i / Wc | 0, c = i % Wc; if (Math.abs(c - PADV) <= vTol) tt = 1;
        for (const j of [c > 0 ? i - 1 : -1, c < Wc - 1 ? i + 1 : -1, u > 0 ? i - Wc : -1, u < L - 1 ? i + Wc : -1]) if (j >= 0 && m[j] && !lab[j]) { lab[j] = id; st.push(j); }
      }
      touch.push(tt);
    }
    const vb = new Float32Array(L), band = new Uint8Array(L * Wc);
    for (let u = 0; u < L; u++) {
      let far = -1; for (let c = Wc - 1; c >= PADV; c--) if (m[u * Wc + c] === 1 && touch[lab[u * Wc + c]]) { far = c; break; }
      if (far >= PADV) { vb[u] = far + 1 - PADV; for (let c = PADV; c <= far; c++) band[u * Wc + c] = 1; }
    }
    const sm = new Float32Array(L);
    for (let u = 0; u < L; u++) sm[u] = smooth > 0 ? med(vb.subarray(Math.max(0, u - smooth), Math.min(L, u + smooth + 1))) : vb[u];
    return {vb: sm, raw: vb, band, Wc};
  }

  // ISO 8688-2 quantities along one edge. vbMm per row, corner: 'start' | 'end' | 'none', cornerMm zone C length
  function isoStats(vbMm, ppm, corner, cornerMm) {
    const L = vbMm.length, nc = corner === 'none' ? 0 : Math.min(L, Math.round(cornerMm * ppm));
    const inC = u => corner === 'start' ? u < nc : corner === 'end' ? u >= L - nc : false;
    let bMax = 0, bSum = 0, bN = 0, cMax = 0, uMax = -1;
    for (let u = 0; u < L; u++) {
      const v = vbMm[u]; if (!(v > 0)) continue;
      if (inC(u)) { if (v > cMax) cMax = v; } else { bSum += v; bN++; if (v > bMax) { bMax = v; uMax = u; } }
    }
    return {vbb: r4(bN ? bSum / bN : 0), vbbMax: r4(bMax), vbc: nc ? r4(cMax) : null, vbMax: r4(Math.max(bMax, cMax)), uAtMaxMm: uMax >= 0 ? r4(uMax / ppm) : null,
      wornMm: r4(bN / ppm), lengthMm: r4(L / ppm)};
  }

  // ---------- one image ----------
  // img: ImageData-like; o: {runProbs, seg (seg-wear api), pxPerMm, uRel, corner, cornerMm, netLong, rotate (q or 'auto'), oracle}
  // o.oracle(imgRot) -> {prob, w, h, scale}: exact labels instead of the network (tests of the maths)
  async function analyzeImage(img, o) {
    const netLong = o.netLong || NET_LONG, s = Math.min(1, netLong / Math.max(img.width, img.height));
    const segOf = async im => o.oracle ? o.oracle(im) : o.seg.segmentImageProbs(o.runProbs, im, s);
    let q = o.rotate === 'auto' || o.rotate == null ? null : +o.rotate, seg0 = null, side = null;
    if (q == null) { seg0 = await segOf(img); side = toolSide(seg0); q = side.q; }
    const im = rotate(img, q), seg = q === 0 && seg0 ? seg0 : await segOf(im), W = im.width, H = im.height;
    const line = fitEdge(seg);
    if (!line) throw new Error('micro: 절삭날(공구/배경 경계)을 찾지 못했습니다');
    const ppm = o.pxPerMm, sx = seg.scale[0], vTol = Math.max(3, Math.round(2 * sx + line.sigmaPx)), smooth = o.smoothPx != null ? o.smoothPx : Math.max(2, Math.round(1.5 * sx));
    const corner = o.corner || 'none', cornerMm = o.cornerMm == null ? .2 : o.cornerMm, mm = a => Float32Array.from(a, v => v / ppm);
    const thr0 = o.thr === 'argmax' ? null : o.thr == null ? WEAR_THR : o.thr;
    // VB rows normal to a line (the fitted edge, or the reference line: fill = broken-out material counts)
    const measure = (Ln, fill) => {
      const F = frame(Ln, W, H); if (!F) return null;
      const lookup = thr => (u, v) => { const [x, y] = F.toImg(u, v); return classAtImg(seg, x, y, W, H, thr); };
      const main = landRows(lookup(thr0), F.L, F.V, vTol, smooth, fill), lo = landRows(lookup(WEAR_LO), F.L, F.V, vTol, smooth, fill), hi = landRows(lookup(WEAR_HI), F.L, F.V, vTol, smooth, fill);
      return {F, main, st: isoStats(mm(main.vb), ppm, corner, cornerMm), stLo: isoStats(mm(lo.vb), ppm, corner, cornerMm), stHi: isoStats(mm(hi.vb), ppm, corner, cornerMm)};
    };
    const E = measure(line, false); if (!E) throw new Error('micro: 절삭날 선이 영상 밖입니다');
    const ref = refEdge(line, E.F, E.main.raw, sx), Rm = ref.source === 'unworn' ? measure(ref, true) || E : E;
    // actual edge outside the reference line (Keyence [2] 'edge offset'): 95th percentile over the edge points, mm
    { const n = Math.hypot(1, ref.b), out = (line.pts || []).map(([x, y]) => (y - ref.a - ref.b * x) / n).filter(d => d > 0).sort((p, q) => p - q);
      ref.outsideMm = r4(out.length ? out[Math.floor(.95 * (out.length - 1))] / ppm : 0); }
    const method = o.vbRef || VB_REF, M = method === 'edge' ? E : Rm, F = M.F, main = M.main, st = M.st, stLo = M.stLo, stHi = M.stHi, refLine = method === 'edge' ? line : ref;
    // uncertainty (standard, mm): scale, edge line (fit residual / sqrt of the independent columns + a floor of one network
    // pixel's .5), wear boundary (threshold spread as a rectangular half width), boundary pixel (.5 network px)
    const uRel = o.uRel || 0, uLine = Math.hypot(line.sigmaPx, .5 * sx) / ppm, uPix = .5 * sx / ppm;
    const budget = (v, a, b) => {
      const spread = Math.abs(a - b), p = {scale: v * uRel, edge: uLine, boundary: spread / 2 / Math.sqrt(3), pixel: uPix}, u = Math.hypot(p.scale, p.edge, p.boundary, p.pixel);
      return {v: r4(v), U: r4(2 * u), u: r4(u), parts: {scale: r4(p.scale), edge: r4(p.edge), boundary: r4(p.boundary), pixel: r4(p.pixel)}, spread: r4(spread)};
    };
    const q2 = {vbMax: budget(st.vbMax, stLo.vbMax, stHi.vbMax), vbb: budget(st.vbb, stLo.vbb, stHi.vbb), vbbMax: budget(st.vbbMax, stLo.vbbMax, stHi.vbbMax),
      vbc: st.vbc == null ? null : budget(st.vbc, stLo.vbc, stHi.vbc)};
    const flags = [];
    if (q2.vbMax.spread > Math.max(.3 * st.vbMax, 4 * sx / ppm)) flags.push('vb-uncertain');
    if (line.sigmaPx > Math.max(3, 2 * sx)) flags.push('edge-ragged');
    if (line.cover < .6) flags.push('edge-short');
    if (!(st.vbMax > 0)) flags.push('no-wear');
    if (flags.some(f => f !== 'no-wear')) flags.push('review');   // confidence gate: the operator checks / drags the boundary in the metrology panel
    // edge-aligned strip for the metrology panel: rows = u, columns = v + PADV (flank to the right of column PADV)
    const Wc = main.Wc, rgb = new Uint8Array(F.L * Wc * 3), g = new Float32Array(F.L * Wc);
    for (let u = 0; u < F.L; u++) for (let c = 0; c < Wc; c++) {
      const [x, y] = F.toImg(u, c - PADV), j = u * Wc + c;
      if (x < 0 || y < 0 || x > W - 1 || y > H - 1) { g[j] = NaN; continue; }
      const x0 = Math.min(W - 2, Math.floor(x)), y0 = Math.min(H - 2, Math.floor(y)), fx = x - x0, fy = y - y0, d = im.data, i = 4 * (y0 * W + x0), k = i + 4 * W;
      let gg = 0;
      for (let ch = 0; ch < 3; ch++) { const v = (d[i + ch] * (1 - fx) + d[i + 4 + ch] * fx) * (1 - fy) + (d[k + ch] * (1 - fx) + d[k + 4 + ch] * fx) * fy; rgb[3 * j + ch] = v; gg += [.299, .587, .114][ch] * v; }
      g[j] = gg;
    }
    const methods = {edge: E.st, reference: Object.assign({}, Rm.st, {source: ref.source, outsideMm: ref.outsideMm})};
    // the other method's rows (reports / tests compare both at one position)
    const A = method === 'edge' ? Rm : E, aLine = method === 'edge' ? ref : line;
    const alt = {vbRef: method === 'edge' ? 'reference' : 'edge', refLine: {a: aLine.a, b: aLine.b}, frame: {L: A.F.L, V: A.F.V, u0: A.F.u0, t: A.F.t, nv: A.F.nv},
      vbPx: A.main.vb, vbRawPx: A.main.raw, toImg: (u, v) => { const [x, y] = A.F.toImg(u, v); return unrotate(q, img.width, img.height, x, y); }};
    return {q, side, line, ref: Object.assign({}, ref, {pts: undefined}), vbRef: method, refLine: {a: refLine.a, b: refLine.b}, methods, alt, frame: {L: F.L, V: F.V, u0: F.u0, t: F.t, nv: F.nv}, toImg: (u, v) => { const [x, y] = F.toImg(u, v); return unrotate(q, img.width, img.height, x, y); },
      netScale: r4(1 / sx), vbPx: main.vb, vbRawPx: main.raw, band: main.band, Wc, rgb, g, stats: st, q2, flags, ppm, seg};
  }

  // ---------- one flute from one or more images: stacked strip + metro inputs ----------
  // results: analyzeImage() outputs in edge order; corner 'start' = row 0 of the first image, 'end' = last row of the last
  // image (the strip is reversed so the corner is at row 0: metro's zone C starts at row 0)
  function fluteStrip(results, ppm, corner) {
    const Wc = Math.max(...results.map(r => r.Wc)), Lt = results.reduce((s, r) => s + r.frame.L, 0) + GAP * (results.length - 1);
    const g = new Float32Array(Lt * Wc).fill(NaN), rgb = new Uint8Array(Lt * Wc * 3), band = new Uint8Array(Lt * Wc), rowVbMm = new Float32Array(Lt), rowImg = new Int16Array(Lt).fill(-1);
    let o = 0;
    results.forEach((r, k) => {
      for (let u = 0; u < r.frame.L; u++) {
        const R = o + u; rowImg[R] = k; rowVbMm[R] = r.vbPx[u] / ppm;
        for (let c = 0; c < r.Wc; c++) { const a = u * r.Wc + c, b = R * Wc + c; g[b] = r.g[a]; rgb[3 * b] = r.rgb[3 * a]; rgb[3 * b + 1] = r.rgb[3 * a + 1]; rgb[3 * b + 2] = r.rgb[3 * a + 2]; band[b] = r.band[a]; }
      }
      o += r.frame.L + GAP;
    });
    if (corner === 'end') {   // flip rows
      const fl = (arr, n) => { for (let a = 0, b = Lt - 1; a < b; a++, b--) for (let c = 0; c < n; c++) { const t = arr[a * n + c]; arr[a * n + c] = arr[b * n + c]; arr[b * n + c] = t; } };
      fl(g, Wc); fl(rgb, 3 * Wc); fl(band, Wc); fl(rowVbMm, 1); fl(rowImg, 1);
    }
    // flat strip: R >> w makes metro-core's cylinder arc width linear (arc(u) = u / ppm to 2e-5), helix 0
    const strip = {w: Wc, h: Lt, g, rgb, cx: Wc / 2, R: 200 * Wc, top: 0, ppm, edgeCol: PADV, rowImg, micro: true};
    return {strip, band, rowVbMm};
  }

  return {MAGS, NET_LONG, WEAR_THR, WEAR_LO, WEAR_HI, VB_REF, REF_UNWORN, REF_MIN, PADV, GAP, calibUm, calibLine, calStore, CKEY, metroCalib, rotate, unrotate, toolSide, fitEdge, frame, classAtImg, landRows, isoStats, robustLine, refEdge,
    analyzeImage, fluteStrip, r4};
});
