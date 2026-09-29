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
    return {w, h, g, img};
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
  // ---------- 1. auto align: tilt, silhouette, scale, tip ----------
  // Frame: u across the tool, v along the axis (down = toward shank). Image point = c + u*n + v*a,
  // n = (cos t, -sin t), a = (sin t, cos t), c = image centre.
  // Silhouette search (v0.6). Candidate lines = peaks of the COUNT of edge pixels (horizontal non-max suppressed, gradient
  // across the line) per u, so a long continuous line beats a short high-contrast one. A pair is scored by
  //   min(support of both lines) x (busy inside - quiet outside) contrast x framing prior (tool near the centre, ~0.3 w wide),
  // then each line is pushed outward to a weaker parallel edge when the region beyond it is quiet background (a dark tool
  // on a dark mat has a faint silhouette and a strong flute edge just inside it).
  // v0.5.4 took the outermost strong magnitude peaks: at a wrong tilt a helical flute edge projects as strongly as the
  // silhouette, which gave tilts of -9..-12 deg and strips of background on real photos (docs/debug-vb0.md).
  function align(G, grad, diameterMm, expectSepPx) {
    const {w, h} = G, {gx, gy} = grad, cx0 = w / 2, cy0 = h / 2, T = 40;
    const mag = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);
    const E = [];                                   // edge pixels: above T and a local max along x (tilt is within +-15 deg)
    for (let y = 1; y < h - 1; y++) for (let x = 2; x < w - 2; x++) { const i = y * w + x; if (mag[i] >= T && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) E.push(i); }
    // busyness = local mean gradient magnitude (tool: flutes, lands, glints; background: fine texture), sampled on a grid
    const rb = Math.max(2, Math.round(Math.max(w, h) / 120)), I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += Math.min(300, mag[y * w + x]); I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
    const busy = (x, y) => { const x0 = Math.max(0, x - rb), x1 = Math.min(w, x + rb + 1), y0 = Math.max(0, y - rb), y1 = Math.min(h, y + rb + 1); return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0)); };
    const gs = Math.max(1, Math.round(Math.sqrt(w * h / 60000))), Bp = [];
    for (let y = 0; y < h; y += gs) for (let x = 0; x < w; x += gs) Bp.push(x - cx0, y - cy0, busy(x, y));
    const U = Math.ceil(Math.hypot(w, h)), off = U / 2;
    const project = t => {
      const c = Math.cos(t), s = Math.sin(t), C = new Float32Array(U + 1), Bs = new Float64Array(U + 2), Bn = new Float64Array(U + 2);
      for (const i of E) {
        const gu = gx[i] * c - gy[i] * s, gv = gx[i] * s + gy[i] * c;
        if (Math.abs(gu) >= T && Math.abs(gu) >= 2 * Math.abs(gv)) C[Math.round((i % w - cx0) * c - ((i / w | 0) - cy0) * s + off)]++;
      }
      for (let j = 0; j < Bp.length; j += 3) { const k = Math.round(Bp[j] * c - Bp[j + 1] * s + off) + 1; Bs[k] += Bp[j + 2]; Bn[k]++; }
      for (let k = 1; k <= U + 1; k++) { Bs[k] += Bs[k - 1]; Bn[k] += Bn[k - 1]; }
      const Q = new Float32Array(U + 1); for (let i = 1; i < U; i++) Q[i] = C[i - 1] + C[i] + C[i + 1];
      const mb = (p, q) => { p = Math.max(0, Math.round(p)); q = Math.min(U + 1, Math.round(q)); const n = Bn[q] - Bn[p]; return n > 5 ? (Bs[q] - Bs[p]) / n : NaN; };
      return {Q, mb};
    };
    const pair = ({Q, mb}) => {
      const pk = []; for (let i = 1; i < U; i++) if (Q[i] >= Q[i - 1] && Q[i] > Q[i + 1]) pk.push(i);
      pk.sort((p, q) => Q[q] - Q[p]).splice(14);
      let b = null;
      for (const l of pk) for (const r of pk) {
        const sp = r - l;
        if (expectSepPx ? Math.abs(sp - expectSepPx) >= .15 * expectSepPx : sp < Math.max(8, .03 * Math.min(w, h)) || sp > .85 * w) continue;
        const bi = mb(l + .1 * sp, r - .1 * sp), bl = mb(l - .3 * sp, l - .06 * sp), br = mb(r + .06 * sp, r + .3 * sp);
        const bo = Math.max(Number.isNaN(bl) ? 0 : bl, Number.isNaN(br) ? 0 : br), con = (bi - bo) / (bi + bo);
        if (!(con > 0)) continue;
        const pc = (l + r) / 2 - off, prior = Math.exp(-.5 * (pc / (.3 * w)) ** 2 - (expectSepPx ? 0 : .5 * (Math.log(sp / (.3 * w)) / .7) ** 2));
        const score = Math.min(Q[l], Q[r]) / h * con * prior;
        if (!b || score > b.score) b = {l, r, score, con};
      }
      return b;
    };
    let best = null;
    const tryT = t => { const P = project(t), p = pair(P); if (p && (!best || p.score > best.score)) best = Object.assign({t, P}, p); };
    for (let a = -15; a <= 15; a += 1) tryT(a * DEG);
    if (!best) return null;
    const t1 = best.t; for (let a = -.9; a <= .901; a += .1) tryT(t1 + a * DEG);
    { // outward to the true silhouette: a parallel edge within 15 % of the width, >= 30 % of the support, quiet beyond it
      const {Q, mb} = best.P, sp = best.r - best.l, qi = mb(best.l + .1 * sp, best.r - .1 * sp);
      if (!expectSepPx) {
        for (let u = best.l - 1; u >= best.l - .15 * sp; u--) if (Q[u] >= Q[u - 1] && Q[u] > Q[u + 1] && Q[u] >= .3 * Q[best.l] && mb(u - .3 * sp, u - .04 * sp) < .6 * qi) best.l = u;
        for (let u = best.r + 1; u <= best.r + .15 * sp; u++) if (Q[u] >= Q[u - 1] && Q[u] > Q[u + 1] && Q[u] >= .3 * Q[best.r] && mb(u + .04 * sp, u + .3 * sp) < .6 * qi) best.r = u;
      }
    }
    // sub-pixel peak position (parabola)
    const Q = best.P.Q, sub = i => { const d = Q[i - 1] - 2 * Q[i] + Q[i + 1]; return d < 0 ? i + .5 * (Q[i - 1] - Q[i + 1]) / d : i; };
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

  // ---------- 1b. backdrop alignment (close-up side views on a plain backdrop) ----------
  // USB-microscope / macro side views (the human's samples, docs/debug-p5.md): the tool fills 70-100 % of the frame width,
  // so the framing prior of align() (tool ~0.3 w wide) and its edge-pair search pick flute edges (tilts of -11..-16 deg,
  // half the true px/mm on D12). Here the backdrop colours are learnt from the top / left / right frame border, the backdrop
  // is flooded in from the border, and the tool is the rest. Its silhouette is bounded by the lines u = +-R (the lands touch
  // them; flute gullies only recede), so the axis direction is the one of minimum projected width of the tool's convex
  // hull (any other direction adds L sin(dt)); the tip line is the top of the hull (chips only lower the end).
  // A side of the silhouette that runs along the frame border for > CUT_FRAC of the tool height is cut off: the width is
  // then a lower bound and the scale must come from expectSepPx (microscope calibration / the tool's other sides).
  const CUT_FRAC = .15, CLOSE_W = .5;
  function backdropAlign(G, diameterMm, expectSepPx) {
    const {w, h, img} = G; if (!img) return null;
    const d = img.data, sc = Math.min(1, 400 / Math.max(w, h)), W = Math.max(8, Math.round(w * sc)), H = Math.max(8, Math.round(h * sc));
    const rgb = new Float32Array(3 * W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const X = Math.min(w - 1, Math.round((x + .5) / sc - .5)), Y = Math.min(h - 1, Math.round((y + .5) / sc - .5)), j = 4 * (Y * w + X); for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = d[j + c]; }
    const px = i => [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]], bw = Math.max(2, Math.round(.03 * Math.min(W, H)));
    const border = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (y < bw || x < bw || x >= W - bw) border.push(y * W + x);
    if (border.length < 30) return null;
    const km = kmeans(border.map(px), 3, rgb);
    // backdrop colour Cb = the border's main cluster; tool colour Ct = the image colour cluster (>= 10 % of the frame) farthest
    // from it (the tool body; specular streaks on it are a minority). A pixel is backdrop-like when its colour projects past the midpoint from Ct towards Cb: robust to
    // a vignetted / two-tone backdrop (the variation is small next to |Cb - Ct|), and glints on the tool only count as
    // backdrop where they touch it
    const cnt = [0, 0, 0]; for (const i of border) cnt[km.near(px(i))[0]]++;
    const Cb = km.C[[0, 1, 2].sort((p, q) => cnt[q] - cnt[p])[0]];
    const all = []; for (let i = 0; i < W * H; i += 7) all.push(px(i));
    const ka = kmeans(all, 4, rgb), share = [0, 0, 0, 0]; for (const p of all) share[ka.near(p)[0]]++;
    const far = k => Math.hypot(ka.C[k][0] - Cb[0], ka.C[k][1] - Cb[1], ka.C[k][2] - Cb[2]);
    const kt = [0, 1, 2, 3].filter(k => share[k] > .1 * all.length).sort((p, q) => far(q) - far(p))[0];
    if (kt == null) return null;
    const Ct = ka.C[kt], dC = Cb.map((v, c) => v - Ct[c]), dd = dC.reduce((p, v) => p + v * v, 0) || 1;
    const bd = border.map(i => { const p = px(i); return Math.hypot(p[0] - Cb[0], p[1] - Cb[1], p[2] - Cb[2]); }).sort((p, q) => p - q);
    const tau = Math.max(8, bd[Math.floor(.5 * bd.length)]), contrast = Math.sqrt(dd) / tau;
    if (contrast < 4) return null;
    const isBg = i => { const p = px(i); return ((p[0] - Ct[0]) * dC[0] + (p[1] - Ct[1]) * dC[1] + (p[2] - Ct[2]) * dC[2]) / dd > .5; };
    const back = new Uint8Array(W * H), st = [];
    for (const i of border) if (isBg(i)) { back[i] = 1; st.push(i); }
    while (st.length) { const p = st.pop(), x = p % W; for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < W * H && !back[q] && isBg(q)) { back[q] = 1; st.push(q); } }
    // tool = largest non-backdrop component; 2-px opening against specks
    const tool = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) tool[i] = back[i] ? 0 : 1;
    const op = openMask(tool, W, H, 3), lab = new Int32Array(W * H); let best = 0, bestN = 0, n = 0;
    for (let s = 0; s < W * H; s++) if (op[s] && !lab[s]) {
      const q = [s]; lab[s] = ++n; let c = 0;
      while (q.length) { const p = q.pop(), x = p % W; c++; for (const r of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (r >= 0 && r < W * H && op[r] && !lab[r]) { lab[r] = n; q.push(r); } }
      if (c > bestN) { bestN = c; best = n; }
    }
    const frac = bestN / (W * H);
    if (!best || frac < .08 || frac > .97) return null;
    // the tip must be in frame: backdrop along most of the top border
    let topBg = 0; for (let x = 0; x < W; x++) if (back[x]) topBg++;
    if (topBg < .5 * W) return null;
    // boundary pixels of the tool component -> convex hull (image px)
    const pts = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== best) continue; if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || lab[i - 1] !== best || lab[i + 1] !== best || lab[i - W] !== best || lab[i + W] !== best) pts.push([(x + .5) / sc - .5, (y + .5) / sc - .5]); }
    const hull = convexHull(pts); if (hull.length < 3) return null;
    const cx0 = w / 2, cy0 = h / 2, proj = t => { const c = Math.cos(t), s = Math.sin(t); let a = 1e9, b = -1e9, v0 = 1e9; for (const [x, y] of hull) { const u = (x - cx0) * c - (y - cy0) * s, v = (x - cx0) * s + (y - cy0) * c; a = Math.min(a, u); b = Math.max(b, u); v0 = Math.min(v0, v); } return {a, b, v0}; };
    // cut-off sides: silhouette on the left / right frame border over > CUT_FRAC of the tool height
    let yTop = H, cutL = 0, cutR = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lab[y * W + x] === best) { yTop = Math.min(yTop, y); break; }
    for (let y = 0; y < H; y++) { if (lab[y * W] === best) cutL++; if (lab[y * W + W - 1] === best) cutR++; }
    const hT = Math.max(1, H - yTop), cut = {left: cutL > CUT_FRAC * hT, right: cutR > CUT_FRAC * hT};
    if (cut.left && cut.right && !expectSepPx) return null;
    // tilt: the tip line (the end face is square to the axis) = the longest top edge of the hull within +-20 deg of the
    // horizontal; chips and broken teeth only lower parts of the end, the hull spans the highest remaining points
    let bt = null, bl = 0; const yT = (yTop + .5) / sc;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      if (Math.abs(ang) > 20 * DEG && Math.abs(Math.abs(ang) - Math.PI) > 20 * DEG) continue;
      if (Math.max(p[1], q[1]) > yT + .25 * hT / sc) continue;   // top of the tool only
      if (L > bl) { bl = L; bt = Math.abs(ang) > Math.PI / 2 ? ang - Math.sign(ang) * Math.PI : ang; }
    }
    if (bt == null) return null;
    bt = -bt;   // image y down: a tip line rising to the right is a clockwise-tilted axis (u = (x-cx) cos t - (y-cy) sin t)
    // width at the tip: tool extent across the axis over the first 0.3 widths below the tip line (the lands at the end
    // teeth reach the full diameter; further down the silhouette alternates lands and flute gullies)
    const {v0} = proj(bt), c1 = Math.cos(bt), s1 = Math.sin(bt);
    let hw = 0; { const {a: lo, b: hi} = proj(bt); hw = hi - lo; }
    let uL = 1e9, uR = -1e9;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (lab[y * W + x] !== best) continue; const X = (x + .5) / sc - .5 - cx0, Y = (y + .5) / sc - .5 - cy0, v = X * s1 + Y * c1; if (v > v0 + .3 * hw) continue; const u = X * c1 - Y * s1; if (u < uL) uL = u; if (u > uR) uR = u; }
    if (expectSepPx && (cut.left || cut.right)) { if (cut.left) uL = uR - expectSepPx; else uR = uL + expectSepPx; }
    const sep = uR - uL; if (sep < 8) return null;
    const c = c1, s = s1, uC = (uL + uR) / 2;
    const toImg = (u, v) => [cx0 + u * c + v * s, cy0 - u * s + v * c];
    return {t: bt, tiltDeg: bt / DEG, uL, uR, uC, sepPx: sep, pxPerMm: sep / diameterMm, vTip: v0, toImg, tipPx: toImg(uC, v0), method: 'backdrop', cut, contrast: r4(contrast), toolFrac: r4(frac), mask: {W, H, sc, lab, best}};
  }
  function convexHull(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // resample into an axis-aligned strip: column = u (centred on the axis), row = v from the tip, native px/mm
  function rectify(G, al, lenMm) {
    const ppm = al.pxPerMm, R = al.sepPx / 2, m = Math.ceil(.1 * al.sepPx), W = Math.ceil(2 * R) + 2 * m;
    const top = Math.ceil(.1 * al.sepPx), H = Math.ceil(lenMm * ppm) + top, g = new Float32Array(W * H);
    const rgb = G.img ? new Uint8ClampedArray(W * H * 3) : null, d = G.img && G.img.data, iw = G.w;
    for (let r = 0; r < H; r++) for (let col = 0; col < W; col++) {
      const [x, y] = al.toImg(al.uC - R - m + col + .5, al.vTip - top + r), i = r * W + col;
      g[i] = bilinear(G.g, G.w, G.h, x, y);
      if (rgb && !Number.isNaN(g[i])) {            // colour, bilinear (same weights as the grey sample)
        const x0 = Math.min(G.w - 2, Math.floor(x)), y0 = Math.min(G.h - 2, Math.floor(y)), fx = x - x0, fy = y - y0, j = 4 * (y0 * iw + x0);
        for (let c = 0; c < 3; c++) rgb[3 * i + c] = (d[j + c] * (1 - fx) + d[j + 4 + c] * fx) * (1 - fy) + (d[j + 4 * iw + c] * (1 - fx) + d[j + 4 * iw + 4 + c] * fx) * fy;
      }
    }
    return {w: W, h: H, g, rgb, cx: m + R - .5, R, top, ppm};
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

  // ---------- helix angle (v0.6) ----------
  // Two estimates on a long strip (tip region + 0.3 D down to where the tool leaves the frame or a finger covers it):
  //  (a) orientation on the unwrapped cylinder: s = R asin(u/R), so dg/ds = dg/du * cos(a). On the unwrapped surface every
  //      flute edge is a straight line at the helix angle from the axis wherever it is (no foreshortening bias, so the
  //      whole visible width |u| < 0.85 R is used). Gradients are clipped at their 90th percentile so glints do not vote.
  //  (b) flute crossings at the silhouette edges: at a fixed azimuth the k flutes pass every p = pi D / (k tan(helix))
  //      along the axis; p = first autocorrelation peak of the grey profile just inside each edge (needs ~1.5 p visible).
  // Result clamped to 15..55 deg; confidence 'high' when (a) is coherent and (b) agrees within 6 deg, 'medium' when only
  // (a) is coherent, else 'low' (then the UI asks for the catalogue value).
  const HELIX_RANGE = [15, 55];
  // separable binomial blur, n passes of [1 2 1]/4 per axis; a NaN in the support gives NaN
  function blurNaN(g, w, h, n) {
    let a = Float32Array.from(g), b = new Float32Array(g.length);
    for (let p = 0; p < n; p++) for (const st of [1, w]) {
      for (let i = 0; i < a.length; i++) { const x = i % w, y = (i / w) | 0, ok = st === 1 ? x > 0 && x < w - 1 : y > 0 && y < h - 1; b[i] = ok ? (a[i - st] + 2 * a[i] + a[i + st]) / 4 : NaN; }
      [a, b] = [b, a];
    }
    return a;
  }
  function helixEstimate(G, al, D, k) {
    const ppm = al.pxPerMm, S = rectify(G, al, 5 * D), {w, g, cx, R, rgb} = S, Rmm = R / ppm;
    const y0 = S.top + Math.round(.3 * D * ppm); let h = S.h;
    for (let y = y0; y < S.h; y++) {   // stop at the photo end or where a finger (skin hue) covers a fifth of the row
      let nan = 0, skin = 0; for (let x = Math.round(cx - .8 * R); x <= cx + .8 * R; x++) { const i = y * w + x; if (Number.isNaN(g[i])) nan++; else if (rgb && rgb[3 * i] > rgb[3 * i + 1] + 18 && rgb[3 * i] > rgb[3 * i + 2] + 25) skin++; }
      if (nan > .2 * 1.6 * R || skin > .2 * 1.6 * R) { h = y; break; }
    }
    const lenMm = (h - y0) / ppm; if (lenMm < .5 * D) return null;
    // (a) structure tensor on the unwrapped surface
    // pre-blur (binomial): hard pixel-staircase edges bias a squared-gradient tensor towards the image axes
    const gb = blurNaN(g, w, h, 4), gs = [], gz = [];
    // cylinder shading and specular streaks run along the axis (z-invariant) and would vote for 0 deg: remove each
    // column's axial mean; helical flute edges sweep across every column and survive
    for (let x = 0; x < w; x++) {
      let m = 0, n = 0; for (let y = y0; y < h; y++) { const v = gb[y * w + x]; if (!Number.isNaN(v)) { m += v; n++; } }
      if (n) { m /= n; for (let y = 0; y < S.h; y++) gb[y * w + x] -= m; }
    }
    for (let y = y0 + 1; y < h - 1; y++) for (let x = Math.ceil(cx - .85 * R); x <= cx + .85 * R; x++) {
      const i = y * w + x, a = (gb[i + 1] - gb[i - 1]) / 2, b = (gb[i + w] - gb[i - w]) / 2; if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const ca = Math.sqrt(Math.max(0, 1 - ((x + .5 - cx) / R) ** 2)); gs.push(a * ca); gz.push(b);
    }
    // only edge pixels vote: |grad| above 3x the median (noise level; the unwrap factor cos(a) makes noise anisotropic, so
    // letting it vote biases the angle towards 90 deg), each clipped at the 90th percentile of the edge pixels (glints)
    const mags = gs.map((v, i) => Math.hypot(v, gz[i])), lo = 3 * (quant(mags, .5) || 1), clip = quant(mags.filter(m => m > lo), .9) || lo;
    let Jss = 0, Jzz = 0, Jsz = 0;
    for (let i = 0; i < gs.length; i++) { if (mags[i] <= lo) continue; const f = mags[i] > clip ? clip / mags[i] : 1, a = gs[i] * f, b = gz[i] * f; Jss += a * a; Jzz += b * b; Jsz += a * b; }
    const phi = .5 * Math.atan2(2 * Jsz, Jss - Jzz), coherence = Math.hypot(Jss - Jzz, 2 * Jsz) / ((Jss + Jzz) || 1);
    const tensorDeg = Math.abs(phi) / DEG, hand = phi > 0 ? 'L' : 'R';
    // (b) crossing period at both silhouette edges
    let periodDeg = null, periodMm = null;
    if (k > 0) {
      const lag0 = Math.round(Math.PI * D / (k * Math.tan(HELIX_RANGE[1] * DEG)) * ppm), lag1 = Math.round(Math.PI * D / (k * Math.tan(HELIX_RANGE[0] * DEG)) * ppm);
      const ac = new Float64Array(lag1 + 2); let used = 0;
      for (const sd of [-1, 1]) {
        const pr = []; for (let y = y0; y < h; y++) { let m = 0, n = 0; for (let x = Math.round(cx + sd * .88 * R) - 1; x <= Math.round(cx + sd * .88 * R) + 1; x++) { const v = g[y * w + x]; if (!Number.isNaN(v)) { m += v; n++; } } pr.push(n ? m / n : NaN); }
        const mu = pr.filter(v => !Number.isNaN(v)).reduce((p, q) => p + q, 0) / pr.length, d = pr.map(v => Number.isNaN(v) ? 0 : v - mu), n = d.length;
        if (n < 1.5 * lag0) continue;
        const v0 = d.reduce((p, q) => p + q * q, 0) || 1;
        for (let L = 1; L <= Math.min(lag1, n - 1); L++) { let c = 0; for (let i = 0; i + L < n; i++) c += d[i] * d[i + L]; ac[L] += c / v0 * n / (n - L); }
        used++;
      }
      if (used) {
        let best = -1, bl = 0;
        for (let L = Math.max(2, lag0); L <= Math.min(lag1, Math.floor((h - y0) / 1.5)); L++) if (ac[L] > ac[L - 1] && ac[L] >= ac[L + 1] && ac[L] / used > .15 && ac[L] > best) { best = ac[L]; bl = L; }
        if (bl) { periodMm = bl / ppm; periodDeg = Math.atan(Math.PI * D / (k * periodMm)) / DEG; }
      }
    }
    const coh = coherence >= .15, agree = periodDeg != null && Math.abs(periodDeg - tensorDeg) <= 6;
    const raw = coh ? (agree ? (tensorDeg + periodDeg) / 2 : tensorDeg) : periodDeg;
    const deg = raw == null ? null : Math.max(HELIX_RANGE[0], Math.min(HELIX_RANGE[1], raw));
    const confidence = raw == null ? 'none' : coh && agree && raw === deg ? 'high' : coh && raw === deg ? 'medium' : 'low';
    return {deg: deg && r4(deg), confidence, tensorDeg: r4(tensorDeg), coherence: r4(coherence), hand, periodDeg: periodDeg && r4(periodDeg), periodMm: periodMm && r4(periodMm), lengthMm: r4(lenMm), clamped: raw != null && raw !== deg};
  }

  // ---------- 2. wear band segmentation on the flank land ----------
  function segment(strip, zoneRows, sens) {
    const {w, h, g, cx, R, top} = strip, inTool = x => Math.abs(x - cx) < .96 * R;
    const ref = [];
    for (let y = top + Math.round(.05 * 2 * R); y < h; y += 2) for (let x = 0; x < w; x += 2) if (inTool(x) && !Number.isNaN(g[y * w + x])) ref.push(g[y * w + x]);
    const med = quant(ref, .5), mad = quant(ref.map(v => Math.abs(v - med)), .5), sig = Math.max(4, 1.4826 * mad), thr = med + sens * sig;
    const y1 = Math.min(h, top + zoneRows), raw = new Uint8Array(w * h);
    for (let y = Math.max(0, top - 1); y < y1; y++) for (let x = 0; x < w; x++) if (inTool(x) && g[y * w + x] > thr) raw[y * w + x] = 1;
    // no unworn body in the photo for a colour model (close-up: the zone reaches the photo end): same blob sorting as
    // segmentColor, tip damage from the saturated fracture faces + the chip blobs
    const tm = toolMask(strip), C = classifyBlobs(strip, raw, tm, y1), band = bandFromMask(strip, C.land);
    return {band, thr, med, sig, y1, method: 'bright', blobs: C.blobs, tip: tipDamage(strip, null, thr, band, C.chip)};
  }

  // raw candidate mask -> wear band: 2x2 opening, then the largest connected region
  function bandFromMask(strip, raw) {
    const {w, h} = strip;
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
    return band;
  }

  // Detection uses a low threshold (score > 1); the band edge is then placed at half contrast (score > half the
  // band's median score), i.e. at the 50 % point of the blurred body->wear transition, as for an edge in a gauge.
  function refineBand(strip, band, score, minMm2 = .004) {
    const v = []; for (let i = 0; i < band.length; i++) if (band[i]) v.push(score[i]);
    if (v.length < minMm2 * strip.ppm * strip.ppm) return {band: new Uint8Array(band.length), coreScore: 0};
    const core = quant(v, .5), t2 = Math.max(1, .5 * core), raw = new Uint8Array(band.length);
    for (let i = 0; i < band.length; i++) if (band[i] && score[i] > t2) raw[i] = 1;
    return {band: bandFromMask(strip, raw), coreScore: r4(core)};
  }

  // Reference rows = unworn body beyond the wear zone (same tool, same light, same photo).
  function refRows(strip, zoneRows) {
    const {h, R, top} = strip, y0 = top + zoneRows + Math.round(.1 * 2 * R);
    return h - y0 >= .15 * 2 * R ? [y0, h] : null;
  }

  // Specular glints: near-white, unsaturated pixels (every channel > GLINT), grown by 2 px to take the blended rim that
  // bilinear resampling leaves between a glint and the dark flute (those rim pixels have wear-like mid-grey colours).
  // Worn carbide is bright but never saturated white under a diffuse light; a glint is never wear.
  const GLINT = 225;
  function glintMask(strip) {
    if (strip.glint) return strip.glint;
    const {w, h, rgb, g} = strip, m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (rgb ? rgb[3 * i] > GLINT && rgb[3 * i + 1] > GLINT && rgb[3 * i + 2] > GLINT : g[i] > GLINT + 10) m[i] = 1;
    return (strip.glint = dilateMask(m, w, h, 2));
  }
  function dilateMask(m, w, h, r) {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let last = -1e9; for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) a[y * w + x] = 1; } last = 1e9; for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) a[y * w + x] = 1; } }
    for (let x = 0; x < w; x++) { let last = -1e9; for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= r) b[y * w + x] = 1; } last = 1e9; for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= r) b[y * w + x] = 1; } }
    return b;
  }

  // k-means (luminance-ordered init) over RGB samples; dist(i) = distance of strip pixel i to the nearest centre
  function kmeans(S, K, rgb) {
    const L = S.map(p => p[0] + p[1] + p[2]), ord = L.map((_, i) => i).sort((a, b) => L[a] - L[b]);
    let C = Array.from({length: K}, (_, k) => S[ord[Math.floor((k + .5) / K * S.length)]].slice());
    const near = p => { let b = 1e9, bi = 0; for (let k = 0; k < C.length; k++) { const d = (p[0] - C[k][0]) ** 2 + (p[1] - C[k][1]) ** 2 + (p[2] - C[k][2]) ** 2; if (d < b) { b = d; bi = k; } } return [bi, b]; };
    for (let it = 0; it < 8; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (const p of S) { const a = acc[near(p)[0]]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++; }
      C = acc.map((a, k) => a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : C[k]);
    }
    return {C, near, dist: i => Math.sqrt(near([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]])[1])};
  }

  // k-means colour model of the unworn body (glints excluded); pixel score = distance to the nearest body colour
  function colorModel(strip, rows, K = 8) {
    const {w, rgb, g, cx, R} = strip, S = [], step = Math.max(1, Math.round(Math.sqrt((rows[1] - rows[0]) * 2 * R / 20000))), gl = glintMask(strip);
    for (let y = rows[0]; y < rows[1]; y += step) for (let x = 0; x < w; x += step) {
      const i = y * w + x; if (Math.abs(x - cx) < .96 * R && !Number.isNaN(g[i]) && !gl[i]) S.push([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]]);
    }
    if (S.length < 50) return null;
    const {C, near, dist} = kmeans(S, K, rgb);
    const tau = Math.max(12, quant(S.map(p => Math.sqrt(near(p)[1])), .995));
    return {C, dist, tau};
  }

  // Tool mask: 1 where the tool is. Background colours are learnt from the strip margins (beside the silhouette, above the
  // tip); background-coloured pixels connected to that background are not tool. The flood may enter the tool outline only
  // in the tip region (end teeth, corner radius, chipped corners stand above/below the found tip line), never along the
  // flank, so a grey worn land on the face of the tool is never taken for background.
  function toolMask(strip) {
    if (strip.tool) return strip.tool;
    const {w, h, g, cx, R, top} = strip, rgb = strip.rgb, px = i => rgb ? [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]] : [g[i], g[i], g[i]];
    const outside = (x, y) => Math.abs(x + .5 - cx) > 1.04 * R || y < top - 2, S = [];
    const step = Math.max(1, Math.round(Math.sqrt(w * h / 8000)));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const i = y * w + x; if (outside(x, y) && !Number.isNaN(g[i])) S.push(px(i)); }
    const tool = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) tool[i] = Number.isNaN(g[i]) ? 0 : 1;
    if (S.length < 30) { if (strip.bdTool) for (let i = 0; i < w * h; i++) if (!strip.bdTool[i]) tool[i] = 0; return (strip.tool = tool); }
    const flat = new Uint8ClampedArray(3 * w * h); for (let i = 0; i < w * h; i++) flat.set(px(i), 3 * i);
    const km = kmeans(S, 3, flat), tau = Math.max(6, quant(S.map(p => Math.sqrt(km.near(p)[1])), .95));
    const st = [];
    const can = i => { const x = i % w, y = i / w | 0; return tool[i] && (outside(x, y) || y < top || Math.abs(x + .5 - cx) > .96 * R) && km.dist(i) <= tau; };
    for (let i = 0; i < w * h; i++) if (outside(i % w, i / w | 0) && can(i)) { tool[i] = 0; st.push(i); }
    while (st.length) {
      const p = st.pop(), x = p % w;
      for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && Math.abs(q % w - x) <= 1 && can(q)) { tool[q] = 0; st.push(q); }
    }
    if (strip.bdTool) for (let i = 0; i < w * h; i++) if (!strip.bdTool[i]) tool[i] = 0;   // backdrop seen between the end teeth (backdropAlign)
    return (strip.tool = tool);
  }

  // Classic v2: a pixel is worn when its colour is unlike every colour of the unworn body (either brighter or darker).
  // Robust to a bimodal body (dark flutes + bright margins), to glints (they also occur on the body) and to wear that
  // is not the brightest thing in the photo. Falls back to the brightness threshold when there is no reference body.
  function segmentColor(strip, zoneRows, o) {
    const rows = strip.rgb && refRows(strip, zoneRows), cm = rows && colorModel(strip, rows);
    if (!cm) return segment(strip, zoneRows, o.sens);
    const {w, h, cx, R, top} = strip, gl = glintMask(strip), tm = toolMask(strip), thr = (o.colorK || 1.5) * cm.tau, y1 = Math.min(h, top + zoneRows), raw = new Uint8Array(w * h);
    const score = new Float32Array(w * h);
    for (let y = Math.max(0, top - 1); y < y1; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (Math.abs(x - cx) >= .96 * R || !tm[i] || gl[i]) continue;
      score[i] = cm.dist(i) / thr; if (score[i] > 1) raw[i] = 1;
    }
    // every candidate blob is sorted (classifyBlobs): a specular streak is dropped, a compact blob at the tip line is tip
    // damage (chipping, VBC), the rest is flank land (VB); the band = the largest land piece
    const C = classifyBlobs(strip, raw, tm, y1);
    const rb = refineBand(strip, bandFromMask(strip, C.land), score);
    return Object.assign(rb, {thr, med: cm.tau, sig: 0, y1, score, colorModel: cm, method: 'color', blobs: C.blobs, tip: tipDamage(strip, cm, thr, rb.band, C.chip)});
  }

  // ---------- 2b. tip / corner damage (chipping, broken end teeth) ----------
  // The damage on real worn end mills is often at the tip: chipped corners and broken end teeth, whose fresh fracture
  // faces are bright, often saturated white. The flank-band stage drops saturated pixels as glints and only looks for a
  // band along the flank, so it reads VB 0 there (docs/debug-vb0.md). Here, in the tip region only (tip line + 0.3 D, at
  // least 1 mm), a pixel is a candidate when its colour is unlike the unworn body OR it is saturated; thin edge glints are
  // removed by an opening of ~0.3 mm; blobs must touch the tip line; the flank band and its rim are left out (flank wear, measured by the band). depthMm = axial depth from the tip line (localized wear VB3 /
  // chipping CH, ISO 8688-2), widthMm = arc width across the flank.
  const TIP_ZONE_D = .3;   // tip region depth, x D
  function tipDamage(strip, cm, thr, band, extra) {
    const {w, h, g, cx, R, top, ppm, rgb} = strip, D = 2 * R / ppm, tm = toolMask(strip), Rmm = R / ppm;
    const y1 = Math.min(h, top + Math.round(Math.max(1, TIP_ZONE_D * D) * ppm)), raw = new Uint8Array(w * h);
    const nb = band ? dilateMask(band, w, h, Math.max(1, Math.round(.15 * ppm))) : null;   // flank band + its rim: measured by the band
    const sat = i => rgb ? rgb[3 * i] > GLINT && rgb[3 * i + 1] > GLINT && rgb[3 * i + 2] > GLINT : g[i] > GLINT + 10;
    for (let y = 0; y < y1; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (Math.abs(x + .5 - cx) >= .96 * R || !tm[i] || (nb && nb[i])) continue;
      if (sat(i) || (cm ? cm.dist(i) / thr > 1 : false) || (extra && extra[i])) raw[i] = 1;
    }
    // opening ~0.3 mm against thin edge glints; the blobs classifyBlobs already sorted as chips skip it (a fracture face is
    // speckled at high magnification and would not survive a 0.3 mm opening)
    const k = Math.max(2, Math.round(.3 * ppm)), op = openMask(raw, w, y1, k);
    if (extra) for (let i = 0; i < w * y1; i++) if (extra[i] && tm[i]) op[i] = 1;
    // resolution limit: ~0.6 mm on the 4.6 px/mm phone photos this was tuned on = 2.8 px; at microscope scales 0.15 mm
    const resMm = Math.max(.15, 2.8 / ppm);
    const lab = new Int32Array(w * h), out = new Uint8Array(w * h), touch = top + Math.max(1, Math.round(.3 * ppm));
    let best = {depthMm: 0, widthMm: 0, areaMm2: 0, px: 0}, n = 0;
    for (let s = 0; s < w * y1; s++) if (op[s] && !lab[s]) {
      const st = [s], pts = []; lab[s] = ++n;
      while (st.length) { const p = st.pop(); pts.push(p); const x = p % w; for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * y1 && Math.abs(q % w - x) <= 1 && op[q] && !lab[q]) { lab[q] = n; st.push(q); } }
      let r0 = 1e9, r1 = -1;
      for (const p of pts) { const y = p / w | 0; r0 = Math.min(r0, y); r1 = Math.max(r1, y); }
      if (r0 > touch || pts.length < Math.max(2 * k * k, (.6 * ppm) ** 2)) continue;   // chips smaller than ~0.6 x 0.6 mm are not resolved (0.36 mm^2)
      const arc = u => Rmm * Math.asin(Math.max(-1, Math.min(1, u / R)));
      // width = median over the blob's rows of the row's arc span (a bounding box would take in glints touching the blob)
      const span = new Map(); for (const p of pts) { const y = p / w | 0, x = p % w, e = span.get(y); span.set(y, e ? [Math.min(e[0], x), Math.max(e[1], x)] : [x, x]); }
      const depthMm = r4((r1 + 1 - Math.max(r0, top)) / ppm), widthMm = r4(quant([...span.values()].map(([a, b]) => arc(b + 1 - cx) - arc(a - cx)), .5));
      // a thin streak running down from the tip (narrower than the 0.6 mm resolution limit, or > 4x deeper than wide) is the
      // specular line on a flute margin following the helix, not a chip (a chip / broken tooth is a compact notch)
      if (widthMm < resMm || depthMm > CHIP_ASPECT * widthMm) continue;
      // a fracture face ends: the body right below it (same columns, next TIP_BELOW_MM) is dark. A specular highlight on the
      // cylinder or a flute margin runs on down the tool at about the same brightness (synthetic false fires: below / blob
      // brightness >= 0.60; the human's broken teeth: 0.28-0.36; chosen on .work/valset43-57)
      if (continuesBelow(strip, tm, pts, span, r1)) continue;
      for (const p of pts) out[p] = 1;
      best.areaMm2 = r4(best.areaMm2 + pts.length / ppm / ppm); best.px += pts.length;
      if (depthMm > best.depthMm) Object.assign(best, {depthMm, widthMm});
    }
    return Object.assign(best, {mask: out, y1, openPx: k});
  }
  // ---------- 2c. candidate blobs -> flank land / tip damage / specular streak ----------
  // One photo, three look-alikes (docs/debug-p5.md, the human's USB-microscope side views): the worn land along the cutting
  // edge, fracture faces of chipped corners / broken end teeth at the tip, and specular streaks (the light reflected along
  // the helical flank, bright and smooth, running on down the tool). Per 4-connected blob of a candidate mask (S = strip or
  // any tool-aligned frame {w, h, g, rgb?, ppm, cx, R, top}; rows = axis from the tip line):
  //   streak: not a chip, and the tool right below it (along its slant) stays as bright (continuesBelow)
  //   chip:   it reaches the tip line (<= TOUCH_MM), is >= 2 resolution limits deep (not the rim of the end face) and compact
  //           (depth <= CHIP_ASPECT x width): material lost at the corner
  //   land:   the rest (a land along the edge is long and narrow)
  // blobs below MIN_BLOB_MM^2 are noise.
  const TOUCH_MM = .3, CHIP_ASPECT = 5, MIN_BLOB_MM = .15;
  function classifyBlobs(S, mask, tm, y1) {
    const {w, h, ppm, cx, R, top} = S, H = Math.min(h, y1 || h), n = w * H;
    const land = new Uint8Array(w * h), chip = new Uint8Array(w * h), streak = new Uint8Array(w * h), lab = new Int32Array(n), blobs = [];
    const Rmm = R / ppm, arc = u => Rmm * Math.asin(Math.max(-1, Math.min(1, u / R))), touch = top + Math.max(1, Math.round(TOUCH_MM * ppm));
    const resMm = Math.max(.15, 2.8 / ppm);   // resolution limit (see tipDamage): a chip is at least 2 x as deep
    let id = 0;
    for (let s0 = 0; s0 < n; s0++) if (mask[s0] && !lab[s0] && (!tm || tm[s0])) {
      const st = [s0], pts = []; lab[s0] = ++id;
      while (st.length) { const p = st.pop(); pts.push(p); const x = p % w; for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && mask[q] && !lab[q] && (!tm || tm[q])) { lab[q] = id; st.push(q); } }
      if (pts.length < (MIN_BLOB_MM * ppm) ** 2) continue;
      let r0 = 1e9, r1 = -1; const span = new Map();
      for (const p of pts) { const y = p / w | 0, x = p % w, e = span.get(y); r0 = Math.min(r0, y); r1 = Math.max(r1, y); span.set(y, e ? [Math.min(e[0], x), Math.max(e[1], x)] : [x, x]); }
      const depthMm = (r1 + 1 - Math.max(r0, top)) / ppm, widthMm = quant([...span.values()].map(([a, b]) => arc(b + 1 - cx) - arc(a - cx)), .5);
      const touches = r0 <= touch, kind = touches && depthMm >= 2 * resMm && depthMm <= CHIP_ASPECT * Math.max(widthMm, 1 / ppm) ? 'chip' : continuesBelow(S, tm, pts, span, r1) ? 'streak' : 'land';
      const out = kind === 'chip' ? chip : kind === 'land' ? land : streak; for (const p of pts) out[p] = 1;
      blobs.push({kind, r0, r1, depthMm: r4(depthMm), widthMm: r4(widthMm), areaMm2: r4(pts.length / ppm / ppm)});
    }
    return {land, chip, streak, blobs};
  }
  const TIP_BELOW_MM = 1.5, TIP_BELOW_X = .5;
  function continuesBelow(strip, tm, pts, span, r1) {
    const {w, h, g, rgb, ppm} = strip, lum = i => rgb ? (rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2]) / 3 : g[i];
    // the window follows the blob's slant (row-centre line fit: a highlight on a helical margin runs diagonally)
    const med = a => a.sort((p, q) => p - q)[a.length >> 1], sp = [...span.values()], hw = (med(sp.map(s => s[1] - s[0])) + 1) / 2;
    let my = 0, mx = 0, sxy = 0, syy = 0; for (const [y, [l, r]] of span) { my += y; mx += (l + r) / 2; } my /= span.size; mx /= span.size;
    for (const [y, [l, r]] of span) { sxy += (y - my) * ((l + r) / 2 - mx); syy += (y - my) ** 2; }
    const sl = Math.max(-2, Math.min(2, syy ? sxy / syy : 0)), xc = y => mx + sl * (y - my);
    let lb = 0; for (const p of pts) lb += lum(p); lb /= pts.length;
    let s = 0, n = 0;
    for (let y = r1 + 1; y < Math.min(h, r1 + 1 + Math.round(TIP_BELOW_MM * ppm)); y++) for (let x = Math.max(0, Math.round(xc(y) - hw)); x <= Math.min(w - 1, Math.round(xc(y) + hw)); x++) { const i = y * w + x; if (tm[i] && !Number.isNaN(g[i])) { s += lum(i); n++; } }
    return n >= .25 * 2 * hw * TIP_BELOW_MM * ppm && s / n > TIP_BELOW_X * lb;
  }
  // binary opening with a k x k square (separable running minimum / maximum)
  function openMask(m, w, h, k) {
    const at = (horiz, a, b) => horiz ? a * w + b : b * w + a;
    const run = (src, horiz, erode) => {
      const o = new Uint8Array(w * h), L = horiz ? w : h, N = horiz ? h : w;
      for (let a = 0; a < N; a++) for (let b = 0; b + k <= L; b++) {
        if (erode) { let all = 1; for (let j = 0; j < k && all; j++) all = src[at(horiz, a, b + j)]; if (all) o[at(horiz, a, b)] = 1; }   // anchor = first cell of the square
        else if (src[at(horiz, a, b)]) for (let j = 0; j < k; j++) o[at(horiz, a, b + j)] = 1;                                        // paint the square back
      }
      return o;
    };
    return run(run(run(run(m, true, true), false, true), true, false), false, false);
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
      // seg.rowVbMm (AI (Seg)): the segmenter measured the land width normal to the edge itself (band thickness); as arc width here
      if (seg.rowVbMm) { rows.push((seg.rowVbMm[y - top] || 0) / cb); continue; }
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

  // rotate an RGBA image by 90/180/270 degrees clockwise (photos taken sideways or tip down)
  function rotate(img, deg) {
    if (!deg) return img;
    const {width: w, height: h, data: d} = img, W = deg === 180 ? w : h, H = deg === 180 ? h : w, o = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [X, Y] = deg === 90 ? [h - 1 - y, x] : deg === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      o.set(d.subarray(4 * (y * w + x), 4 * (y * w + x) + 4), 4 * (Y * W + X));
    }
    return {width: W, height: H, data: o};
  }

  // align + rectify one side photo. Tries the photo as given (tip up) first; if no tool is found, or the "tip" is at the
  // image border (the tool runs out of the frame there, so that end is the shank), tries 90/270/180 degree rotations.
  // enh (optional): the same photo after Tool3D.enhance (same size). Geometry (silhouette, scale, tip) is always taken
  // from the original photo; only the strip pixels used for segmentation come from the enhanced one (strip.raw = original).
  function prepareSide(img, opts, enh) {
    const o = Object.assign({}, DEFAULTS, opts), D = o.diameterMm;
    if (!(D > 0)) throw new Error('diameterMm required');
    const tryRot = deg => {
      const im = rotate(img, deg), G = gray(im), exp = o.expectPxPerMm && o.expectPxPerMm * D;
      // close-up on a plain backdrop (tool >= CLOSE_W of the frame width, where align()'s framing prior does not hold) ->
      // backdrop alignment; otherwise the edge-pair search, and the backdrop one only when that finds nothing
      const ab = o.align !== 'edges' ? backdropAlign(G, D, exp) : null;
      const al = ab && ab.sepPx >= CLOSE_W * G.w ? ab : align(G, sobel(G), D, exp) || ab;
      if (!al) return null;
      const [, ty] = al.tipPx, [tx] = al.tipPx, edge = Math.min(ty, tx, G.w - 1 - tx) < .02 * al.sepPx + 2;
      return {G, al, deg, edge};
    };
    const rots = o.rotateDeg != null ? [o.rotateDeg] : [0, 90, 270, 180];
    let best = null;
    for (const deg of rots) { const r = tryRot(deg); if (r && !r.edge) { best = r; break; } if (r && !best) best = r; }
    if (!best) return null;
    const {G, al} = best, zone = o.zoneMm || .8 * D;
    // o.stripMm: rectify a longer strip (more unworn body for a reference); rows past the photo end are trimmed
    const lenMm = Math.max(zone + .6 * D, o.stripMm || 1.2 * D), raw = rectify(G, al, lenMm);
    let strip = enh && enh.width === img.width && enh.height === img.height ? Object.assign(rectify(gray(rotate(enh, best.deg)), al, lenMm), {raw}) : raw;
    if (o.stripMm) { const {w, g, cx, top} = raw, x = Math.round(cx); let h = strip.h; while (h > top + zone * strip.ppm && Number.isNaN(g[(h - 1) * w + x])) h--; strip = trimStrip(strip, h); }
    if (al.mask) strip.bdTool = stripMask(strip, al);
    const hx = helixEstimate(G, al, D, o.flutes), hEst = hx && hx.confidence !== 'none' ? hx.deg : null;
    // img: the photo as aligned (rotated tip up) for segmenters that work on the photo itself (seg-wear.js)
    return {o, al, strip, zone, zoneRows: Math.round(zone * strip.ppm), hEst, helix: hx, rotateDeg: best.deg, img: G.img};
  }

  // backdropAlign's tool mask (photo, downscaled) sampled onto the strip: 1 = tool
  function stripMask(strip, al) {
    const {W, H, sc, lab, best} = al.mask, {w, h, cx, top} = strip, m = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) for (let col = 0; col < w; col++) {
      const [x, y] = al.toImg(al.uC + col - cx, al.vTip - top + r);   // rectify(): u = uC - R - margin + col + .5, cx = margin + R - .5
      const X = Math.floor((x + .5) * sc), Y = Math.floor((y + .5) * sc);
      m[r * w + col] = X >= 0 && Y >= 0 && X < W && Y < H && lab[Y * W + X] === best ? 1 : 0;
    }
    return m;
  }
  const trimStrip = (S, h) => h >= S.h ? S : Object.assign({}, S, {h, g: S.g.subarray(0, S.w * h), rgb: S.rgb && S.rgb.subarray(0, 3 * S.w * h)}, S.raw ? {raw: trimStrip(S.raw, h)} : {});

  function finishSide(P, seg, helixDeg) {
    const {o, al, strip, hEst} = P, m = measureBand(strip, seg, Object.assign({}, o, {helixDeg}));
    // tip / corner damage (chipping, broken end tooth) counts in the reported VBmax as corner wear VBC (ISO 8688-2 zone C:
    // material lost from the original cutting corner, depth along the axis). The flank band alone stays in vbFlankMaxMm.
    const vbFlankMaxMm = m.vbMaxMm, vbTipMm = seg.tip && seg.tip.depthMm > 0 ? r4(seg.tip.depthMm) : 0;
    m.vbMaxMm = r4(Math.max(vbFlankMaxMm, vbTipMm));
    strip.tip = vbTipMm ? {depthMm: vbTipMm, widthMm: seg.tip.widthMm} : null;   // metro-core folds it into VBC / VBmax
    return Object.assign(m, {vbFlankMaxMm, vbTipMm, vbSource: vbTipMm > vbFlankMaxMm ? 'corner/tip (VBC)' : vbFlankMaxMm > 0 ? 'flank (VB)' : 'none',
      align: {tiltDeg: r4(al.tiltDeg), pxPerMm: r4(al.pxPerMm), tipPx: al.tipPx.map(r4), axisPx: al.toImg(al.uC, al.vTip + 10).map(r4), rotateDeg: P.rotateDeg},
      helixDegEstimated: hEst && r4(hEst), helixDegUsed: helixDeg, threshold: r4(seg.thr), method: seg.method, strip, band: seg.band, rowVbMm: seg.rowVbMm || null,
      tip: seg.tip ? {depthMm: seg.tip.depthMm, widthMm: seg.tip.widthMm, areaMm2: seg.tip.areaMm2} : null, tipMask: seg.tip ? seg.tip.mask : null
    }, evidence(al.pxPerMm, vbFlankMaxMm, seg.tip, seg.flags));
  }

  // Evidence verdict per side. A zero is only confident when the photo resolves the wear (>= MIN_PPM px/mm) and neither the
  // flank band nor the tip shows anything; otherwise the side goes to the operator (never a confident 0, never an
  // unconfirmed big number): 'low-resolution', 'tip-damage' (chipping / broken end tooth: VB3/CH, not a flank band).
  const LOW_X = .5, LOW_MED = .15;   // flank VB < 0.5 x the median of the other sides while that median is > 0.15 mm -> 'vb-low' (a land the photo does not resolve reads 0)
  const OUTLIER_X = 1.6;   // flank VB > 1.6 x the median of the other sides (and > +0.1 mm) -> 'vb-outlier'
  const MIN_PPM = 15;   // 1 px = 0.067 mm: a 0.1 mm land is 1.5 px (the quality check warns below 20, fails below 8)
  // flags: the segmenter's own reasons (e.g. 'tip-misplaced', 'ai-fallback')
  function evidence(ppm, vbMax, tip, flags) {
    const reasons = (flags || []).slice();
    if (ppm < MIN_PPM) reasons.push('low-resolution');
    if (tip && tip.depthMm > 0) reasons.push('tip-damage');
    const kind = vbMax > 0 && tip && tip.depthMm > 0 ? 'band+tip' : vbMax > 0 ? 'band' : tip && tip.depthMm > 0 ? 'tip' : 'none';
    return {evidence: kind, needsOperator: reasons.length > 0, reasons, confidence: reasons.length ? 'low' : 'ok'};
  }

  // classic segmenter (sync): colour model vs the unworn body; legacy brightness threshold with o.method = 'bright'
  const classicSegment = P => P.o.method === 'bright' ? segment(P.strip, P.zoneRows, P.o.sens) : segmentColor(P.strip, P.zoneRows, P.o);

  function analyzeSide(img, opts) {
    const P = prepareSide(img, opts); if (!P) return null;
    return finishSide(P, classicSegment(P), P.o.helixDeg || P.hEst || 30);
  }

  // all sides: align (+ scale consistency), then segment each with `segmenter`, then VB with one common helix
  function prepareAll({sides, enhanced, flutes, diameterMm, helixDeg, clearanceDeg, zoneMm, sens, method, stripMm}) {
    const k = flutes || sides.length, o = {diameterMm, helixDeg, clearanceDeg, zoneMm, sens, method, stripMm, flutes: k}, E = enhanced || [];
    Object.keys(o).forEach(key => o[key] == null && delete o[key]);
    let P = sides.slice(0, k).map((img, i) => prepareSide(img, o, E[i]));
    // photos come from one camera setup: a side whose scale is >20 % off the median is re-aligned at the median scale
    const pp = P.filter(Boolean).map(p => p.al.pxPerMm).sort((a, b) => a - b), ppMed = pp[pp.length >> 1];
    if (pp.length >= 2) P = P.map((p, i) => !p || Math.abs(p.al.pxPerMm / ppMed - 1) > .2 ? prepareSide(sides[i], Object.assign({}, o, {expectPxPerMm: ppMed}), E[i]) : p);
    return {k, o, P};
  }

  function assemble({k, P}, segs, {diameterMm, helixDeg, top, sens}, engine) {
    const hs = P.filter(Boolean).map(p => p.hEst).filter(Boolean).sort((a, b) => a - b);
    const helixUsed = helixDeg || (hs.length ? hs[hs.length >> 1] : 30);
    // helix: operator value (catalogue) > median photo estimate > 30 deg default; confidence from the per-side estimates
    const hx = P.map(p => p && p.helix), conf = ['high', 'medium', 'low'].find(c => hx.some(h => h && h.confidence === c)) || 'none';
    const helixInfo = {deg: r4(helixUsed), source: helixDeg ? 'operator' : hs.length ? 'estimated' : 'default', confidence: helixDeg ? 'operator' : hs.length ? conf : 'none',
      perSide: hx.map(h => h && {deg: h.deg, confidence: h.confidence, tensorDeg: h.tensorDeg, coherence: h.coherence, periodDeg: h.periodDeg, clamped: h.clamped})};
    const S2 = P.map((p, i) => p && finishSide(p, segs[i], helixUsed));
    // one flute's land much wider than the tool's other sides (the confident ones when >= 2, else every other measured
    // side) -> the operator confirms it: a real outlier (one damaged flute) keeps its number, a misread band does not pass silently
    const conf0 = S2.map(s => s && !s.needsOperator);
    S2.forEach((s, i) => {
      if (!s || !conf0[i] || !(s.vbFlankMaxMm > 0)) return;
      let ref = S2.filter((t, j) => t && j !== i && conf0[j]).map(t => t.vbFlankMaxMm);
      if (ref.length < 2) ref = S2.filter((t, j) => t && j !== i).map(t => t.vbFlankMaxMm);
      if (!ref.length) return;
      ref.sort((a, b) => a - b);
      const med = ref[ref.length >> 1];
      if (s.vbFlankMaxMm > OUTLIER_X * med && s.vbFlankMaxMm > med + .1) Object.assign(s, {needsOperator: true, reasons: s.reasons.concat('vb-outlier'), confidence: 'low'});
    });
    S2.forEach((s, i) => {
      if (!s || !conf0[i] || s.needsOperator) return;
      let ref = S2.filter((t, j) => t && j !== i && conf0[j]).map(t => t.vbFlankMaxMm);
      if (ref.length < 1) ref = S2.filter((t, j) => t && j !== i).map(t => t.vbFlankMaxMm);
      if (!ref.length) return;
      ref.sort((a, b) => a - b);
      const med = ref.length % 2 ? ref[ref.length >> 1] : (ref[ref.length / 2 - 1] + ref[ref.length / 2]) / 2;
      if (med > LOW_MED && s.vbFlankMaxMm < LOW_X * med) Object.assign(s, {needsOperator: true, reasons: s.reasons.concat('vb-low'), confidence: 'low'});
    });
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
      engine,
      sides: S2.map(s => s && {align: s.align, threshold: s.threshold, method: s.method, wornLengthMm: s.wornLengthMm, helixDegEstimated: s.helixDegEstimated,
        vbMaxMm: s.vbMaxMm, vbFlankMaxMm: s.vbFlankMaxMm, vbTipMm: s.vbTipMm, vbSource: s.vbSource, tip: s.tip, evidence: s.evidence, needsOperator: s.needsOperator, reasons: s.reasons, confidence: s.confidence}),
      helix: helixInfo,
      failedSides: S2.map((s, i) => s ? -1 : i).filter(i => i >= 0), top: topRes,
      warnings: S2.map((s, i) => s && s.align.pxPerMm < 20 ? `side ${i + 1}: ${s.align.pxPerMm.toFixed(1)} px/mm, below 20 px/mm; VB is not reliable (1 px = ${(1 / s.align.pxPerMm).toFixed(2)} mm)` : null).filter(Boolean)
        .concat(S2.map((s, i) => s ? null : `side ${i + 1}: tool silhouette not found (no wear measured on this side)`).filter(Boolean))
        .concat(S2.map((s, i) => s && s.tip && s.tip.depthMm > 0 ? `side ${i + 1}: tip damage (chipping / broken end tooth) ${s.tip.depthMm.toFixed(2)} mm deep x ${s.tip.widthMm.toFixed(2)} mm wide - counted in VBmax as corner/tip wear (VBC); confirm in the measurement panel` : null).filter(Boolean))
        .concat(helixInfo.source === 'default' || helixInfo.confidence === 'low' ? [`helix angle ${helixInfo.source === 'default' ? 'not measurable in the photos, 30 deg assumed' : `estimate ${helixUsed.toFixed(1)} deg is uncertain`}; enter the catalogue value`] : []),
      strips: S2.map(s => s && {strip: s.strip, band: s.band, tipMask: s.tipMask, rowVbMm: s.rowVbMm}),
      ai: segs.map(g => g && g.ai || null), aiErrors: segs.map(g => g && g.aiError || null),
      model: 'VB normal to helical edge = arc width * cos(helix); area = sum arc width * dz; volume = sum 0.5*VB^2*tan(clearance)*dz/cos(helix)'
    };
    return {result, debug};
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
  function measure(args) {
    const A = prepareAll(args);
    return assemble(A, A.P.map(p => p && classicSegment(p)), args, 'classic');
  }
  // segmenter(prep, sideIndex) -> Promise<seg> (e.g. the AI stage); a side it rejects falls back to the classic segmenter
  // segmenter.prepare(args) may ask for other prepare options (the AI stage wants a longer strip of unworn body)
  async function measureAsync(args, segmenter, engine) {
    const A = prepareAll(segmenter.prepare ? Object.assign({}, args, segmenter.prepare(args)) : args);
    const fallback = (p, e) => { const s = classicSegment(p); s.aiError = String(e && e.message || e); s.flags = ['ai-fallback']; return s; };
    const segs = segmenter.batch   // batch: all sides of the tool at once (e.g. one memory bank pooled over every side)
      ? (await segmenter.batch(A.P).catch(e => A.P.map(() => e))).map((s, i) => !A.P[i] ? null : !s || s instanceof Error ? fallback(A.P[i], s) : s)
      : await Promise.all(A.P.map(async (p, i) => { if (!p) return null; try { return await segmenter(p, i); } catch (e) { return fallback(p, e); } }));
    return assemble(A, segs, args, engine);
  }

  return {DEFAULTS, GLINT, MIN_PPM, HELIX_RANGE, backdropAlign, convexHull, classifyBlobs, continuesBelow, stripMask, TOUCH_MM, CHIP_ASPECT, helixEstimate, evidence, glintMask, toolMask, kmeans, tipDamage, openMask, dilateMask, gray, sobel, align, rectify, rotate, segment, segmentColor, bandFromMask, refineBand, refRows, colorModel, measureBand,
    prepareSide, finishSide, classicSegment, analyzeSide, analyzeTop, measure, measureAsync};
});
