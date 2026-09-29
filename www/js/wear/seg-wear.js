/* Tool3D wear, AI (Seg) stage: a trained segmentation network labels every pixel of the photo
 *   0 background, 1 tool, 2 flank wear (VB), 3 chipping / breakage, 4 adhesion / built-up edge.
 * Model: U-Net with a MobileNetV3-Large encoder (ImageNet weights, Apache-2.0), trained on synthetic phone photos of
 * worn end mills (scripts/seg, research/seg-model.md). Runs offline: onnxruntime-web (wasm, www/vendor/ort) +
 * www/models/wear-seg.onnx.js.
 *
 * Side photos: the tip region is resampled from the photo into a tool-aligned window (tip up, tool diameter NET_D px,
 * the scale the network was trained at), segmented, and the class map is sampled back onto wear-core's strip. The flank
 * band (class 2 + chipping 3 on the flank) then goes through the unchanged VB / area / volume maths of wear-core.
 * Top photo: the end face (circle from wear-core analyzeTop) is segmented the same way.
 *
 * Browser: await Tool3D.wear.seg.run(shots, opts) -> wearResult (engine 'seg'), also sets Tool3D.faceSeg and
 *          wearResult.faces;  await Tool3D.wear.seg.segment(imageData) -> {mask, w, h, classes, confidence}
 * Node:    require('seg-wear.js').createSegmenter(runProbs, core)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.wear = root.Tool3D.wear || {}; root.Tool3D.wear.seg = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NC = 5, CLASSES = ['background', 'tool', 'flank wear', 'chipping', 'adhesion'];
  const NET_MIN = 224, NET_MAX = 384;      // tool diameter in network pixels (training covered 60..460, mostly 150..400)
  const ABOVE = .3, BELOW = .3, SIDE = .8;  // window around the zone, in tool diameters
  const EDGE_U = .96;                       // |u| < EDGE_U R: the last few % of the silhouette are foreshortened
  const VB_SMOOTH_MM = .3;                  // VB profile: running median along the axis (chosen on .work/valset1-3, not the test set)
  const MAX_ABOVE = .5;                     // share of tool pixels allowed in the strip above the tip line (see segmentSide)
  // VB uncertainty -> 'vb-uncertain': the VBmax read at probability thresholds .3 / .7 and on the mirrored photo spread by
  // more than UNC_ABS mm, or by more than UNC_REL x the reading (floor 0.1 mm), or the mirrored photo alone moves it by
  // more than UNC_FLIP mm (chosen on .work/valset4-17, checked on 18-30; never on test/wear/seg)
  const UNC_ABS = .2, UNC_REL = .75, UNC_FLIP = .1;
  const MIN_TOOL = .5;                      // share of the silhouette the network must see as tool, else the side falls back
  const r4 = v => Math.round(v * 1e4) / 1e4, ceil32 = v => Math.max(32, Math.ceil(v / 32) * 32);

  // bilinear RGB sample of an ImageData at (x, y), clamped to the border; into out[o], out[o+P], out[o+2P] (0..1)
  function sampleRGB(img, x, y, out, o, P) {
    const {width: w, height: h, data: d} = img;
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = 4 * (y0 * w + x0), j = i + 4 * w;
    for (let c = 0; c < 3; c++) out[o + c * P] = ((d[i + c] * (1 - fx) + d[i + 4 + c] * fx) * (1 - fy) + (d[j + c] * (1 - fx) + d[j + 4 + c] * fx) * fy) / 255;
  }

  // window (network frame) -> photo: X, Y network px -> photo x, y
  function sideWindow(P) {
    const {al, zoneRows, strip} = P, sep = al.sepPx, D = NET_ClampD(sep), k = D / sep;
    const v0 = al.vTip - ABOVE * sep, v1 = al.vTip + zoneRows + BELOW * sep;
    const Wn = ceil32((1 + 2 * SIDE) * sep * k), Hn = ceil32((v1 - v0) * k);
    const toPhoto = (X, Y) => al.toImg(al.uC + (X + .5 - Wn / 2) / k, v0 + (Y + .5) / k);
    // strip pixel (col, row) -> network X, Y (continuous)
    const fromStrip = (col, row) => [(col - strip.cx) * k + Wn / 2 - .5, (al.vTip - strip.top + row - v0) * k - .5];
    return {k, Wn, Hn, v0, toPhoto, fromStrip, netD: D};
  }
  const NET_ClampD = sep => Math.max(NET_MIN, Math.min(NET_MAX, sep));

  function windowInput(img, Wn, Hn, toPhoto) {
    const P = Wn * Hn, x = new Float32Array(3 * P);
    for (let Y = 0; Y < Hn; Y++) for (let X = 0; X < Wn; X++) { const [px, py] = toPhoto(X, Y); sampleRGB(img, px, py, x, Y * Wn + X, P); }
    return x;
  }

  // probabilities (NC planes, Hn x Wn) -> argmax class + max prob
  function argmax(prob, n) {
    const cls = new Uint8Array(n), conf = new Float32Array(n);
    for (let i = 0; i < n; i++) { let b = 0, bp = prob[i]; for (let c = 1; c < NC; c++) { const p = prob[c * n + i]; if (p > bp) { bp = p; b = c; } } cls[i] = b; conf[i] = bp; }
    return {cls, conf};
  }

  // class of a continuous network position: bilinear probabilities, then argmax (sub-pixel boundaries)
  function classAt(prob, Wn, Hn, X, Y) {
    if (X < 0 || Y < 0 || X > Wn - 1 || Y > Hn - 1) return 0;
    const x0 = Math.min(Wn - 2, Math.floor(X)), y0 = Math.min(Hn - 2, Math.floor(Y)), fx = X - x0, fy = Y - y0, n = Wn * Hn, i = y0 * Wn + x0;
    let b = 0, bp = -1;
    for (let c = 0; c < NC; c++) {
      const o = c * n + i, p = (prob[o] * (1 - fx) + prob[o + 1] * fx) * (1 - fy) + (prob[o + Wn] * (1 - fx) + prob[o + Wn + 1] * fx) * fy;
      if (p > bp) { bp = p; b = c; }
    }
    return b;
  }

  // connected components (4-neighbour) of a mask; returns labels + sizes
  function components(m, w, h) {
    const lab = new Int32Array(w * h), sizes = [0], st = [];
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || lab[s]) continue;
      const id = sizes.length; let n = 0; lab[s] = id; st.push(s);
      while (st.length) {
        const i = st.pop(), x = i % w; n++;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < w * h && m[j] && !lab[j]) { lab[j] = id; st.push(j); }
      }
      sizes.push(n);
    }
    return {lab, sizes};
  }

  // chamfer (3-4) distance to the nearest pixel outside m, /3 = px
  function distIn(m, w, h) {
    const d = new Float32Array(w * h), B = 1e9;
    for (let i = 0; i < w * h; i++) d[i] = m[i] ? B : 0;
    const at = (x, y) => x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4); }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4); }
    for (let i = 0; i < w * h; i++) d[i] /= 3;
    return d;
  }

  // Flank land width VB per network row, normal to the cutting edge. The worn land runs along the helical edge, so the
  // row span of the band (first .. last pixel, wear-core's classic measure) takes in the land's length on a slanted edge;
  // here VB = the band's thickness (2 x inner distance at its ridge, per row), un-foreshortened on the cylinder: with m the
  // band normal in the photo (towards the nearest outside pixel) and f = 1 / sqrt(1 - (u/R)^2) the circumferential
  // compression, a projected thickness t is T = t / |(m_x / f, m_y)|.  Largest piece of flank wear + chipping in the zone (one photo = the flute it faces).
  function landWidth(wc, Wn, Hn, win, P, edgeU, vo = {}) {
    const Rn = win.netD / 2, Y0 = Math.round(ABOVE * win.netD), ppm = win.k * P.al.pxPerMm, vbMm = new Float32Array(Hn);
    const m = new Uint8Array(Wn * Hn), Yc = Y0 + Math.round((vo.zc || 0) * win.netD), uR = (vo.umax || 9) * Rn;
    for (let Y = Y0; Y < Hn; Y++) for (let X = 0; X < Wn; X++) { const c = wc[Y * Wn + X]; if ((c === 2 || c === 3) && Math.abs(X + .5 - Wn / 2) < edgeU * Rn) m[Y * Wn + X] = 1; }
    const {lab, sizes} = components(m, Wn, Hn);
    let best = 0; for (let c = 1; c < sizes.length; c++) if (sizes[c] > (sizes[best] || 0)) best = c;
    if (!best) return {vbMm, px: 0};
    for (let j = 0; j < m.length; j++) m[j] = lab[j] === best ? 1 : 0;
    const d = distIn(m, Wn, Hn);
    for (let Y = Yc; Y < Hn; Y++) {
      let jb = -1; for (let X = 0; X < Wn; X++) { const j = Y * Wn + X; if (m[j] && Math.abs(X + .5 - Wn / 2) < uR && (jb < 0 || d[j] > d[jb])) jb = j; }
      if (jb < 0) continue;
      // band normal at the ridge = direction to the nearest pixel outside the band
      const X = jb % Wn, r = Math.ceil(d[jb]) + 1; let bx = 0, by = 1, bd = 1e9;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = X + dx, y = Y + dy, q = dx * dx + dy * dy;
        if (q < bd && (x < 0 || y < 0 || x >= Wn || y >= Hn || !m[y * Wn + x])) { bd = q; bx = dx; by = dy; }
      }
      const u = Math.min(.96, Math.abs(X + .5 - Wn / 2) / Rn), f = 1 / Math.sqrt(1 - u * u), n = Math.hypot(bx, by) || 1;
      vbMm[Y] = Math.max(1, 2 * d[jb] - .5) / Math.sqrt((bx / n / f) ** 2 + (by / n) ** 2) / ppm;
    }
    // running median along the axis over +-VB_SMOOTH_MM: VBmax is the land's width, not a blob where lands meet
    const h = Math.round(VB_SMOOTH_MM * ppm), sm = new Float32Array(Hn);
    if (h > 0) { for (let Y = 0; Y < Hn; Y++) { const q = Array.from(vbMm.subarray(Math.max(0, Y - h), Math.min(Hn, Y + h + 1))).sort((p, r) => p - r); sm[Y] = q[q.length >> 1]; } return {vbMm: sm, px: sizes[best]}; }
    return {vbMm, px: sizes[best]};
  }

  // chipping / broken corner (class 3) that reaches the tip region -> wear-core's tip damage (VBC): axial depth from the
  // tip line, arc width, area; mask on the strip for the overlay
  function tipChips(wc, cls, Wn, Hn, win, P, strip, y1) {
    const Rn = win.netD / 2, Y0 = Math.round(ABOVE * win.netD), ppm = win.k * P.al.pxPerMm, Rmm = Rn / ppm;
    const reach = Y0 + Math.round(.3 * win.netD), minPx = (.15 * ppm) ** 2;
    const m = new Uint8Array(Wn * Hn); for (let j = 0; j < m.length; j++) m[j] = wc[j] === 3 ? 1 : 0;
    const {lab, sizes} = components(m, Wn, Hn), keep = new Uint8Array(sizes.length);
    const r0 = new Int32Array(sizes.length).fill(1e9), r1 = new Int32Array(sizes.length).fill(-1), span = sizes.map(() => new Map());
    for (let j = 0; j < m.length; j++) { const c = lab[j]; if (!c) continue; const Y = j / Wn | 0, X = j % Wn, e = span[c].get(Y); r0[c] = Math.min(r0[c], Y); r1[c] = Math.max(r1[c], Y); span[c].set(Y, e ? [Math.min(e[0], X), Math.max(e[1], X)] : [X, X]); }
    const arc = X => Rmm * Math.asin(Math.max(-1, Math.min(1, (X - Wn / 2) / Rn)));
    const best = {depthMm: 0, widthMm: 0, areaMm2: 0, px: 0};
    for (let c = 1; c < sizes.length; c++) {
      if (sizes[c] < minPx || r0[c] > reach || r1[c] < Y0) continue;
      keep[c] = 1;
      const depthMm = r4((r1[c] + 1 - Math.max(r0[c], Y0)) / ppm), widths = [...span[c].values()].map(([a, b]) => arc(b + 1) - arc(a)).sort((p, q) => p - q);
      best.areaMm2 = r4(best.areaMm2 + sizes[c] / ppm / ppm); best.px += sizes[c];
      if (depthMm > best.depthMm) Object.assign(best, {depthMm, widthMm: r4(widths[widths.length >> 1])});
    }
    if (!best.px) return null;
    const {w, h, top} = strip, mask = new Uint8Array(w * h);
    for (let y = top; y < y1; y++) for (let x = 0; x < w; x++) if (cls[y * w + x] === 3) mask[y * w + x] = 1;
    return Object.assign(best, {mask, y1, source: 'seg'});
  }

  // wear-core's colour tip-damage stage (tipDamage: fresh bright fracture faces at the tip) on the same strip. The network's
  // chipping class misses broken end teeth on real photos (the human's D10 read VBmax ~0.2 / chip 0 while tipDamage found
  // 1.3-2.7 mm), so its evidence is folded in: never a confident small VB on a visibly chipped tip.
  // A blob the network calls background for the most part is not tool material (the colour stage's tool mask leaked into
  // the backdrop): dropped.
  function classicTip(core, P, cls) {
    if (!core || !core.classicSegment) return null;
    let t; try { t = core.classicSegment(P).tip; } catch (e) { return null; }
    if (!t || !(t.depthMm > 0)) return null;
    let n = 0, bg = 0; for (let j = 0; j < t.mask.length; j++) if (t.mask[j]) { n++; if (!cls[j]) bg++; }
    return bg > .5 * n ? null : Object.assign({}, t, {source: 'color'});
  }
  // tip damage (VBC) = the deeper of the network's chips and the colour stage; the side goes to the operator anyway
  // ('tip-damage'), and 'tip-disagree' says the two stages do not agree (one >= TIP_DIS mm, the other < half of it)
  const TIP_DIS = .5;
  function mergeTip(net, col, flags) {
    const dn = net ? net.depthMm : 0, dc = col ? col.depthMm : 0;
    if (Math.max(dn, dc) >= TIP_DIS && Math.min(dn, dc) < .5 * Math.max(dn, dc)) flags.push('tip-disagree');
    if (!col) return net && Object.assign(net, {netDepthMm: dn, colorDepthMm: 0});
    const b = dc > dn ? col : net, mask = b.mask.slice();
    const o = net && net.mask !== b.mask ? net.mask : col.mask !== b.mask ? col.mask : null;
    if (o) for (let j = 0; j < mask.length; j++) if (o[j]) mask[j] = 1;
    return {depthMm: b.depthMm, widthMm: b.widthMm, areaMm2: r4(Math.max(dn ? net.areaMm2 : 0, col.areaMm2)), px: b.px, mask, y1: b.y1,
      source: dn && dc ? 'seg+color' : dc ? 'color' : 'seg', netDepthMm: dn, colorDepthMm: dc};
  }

  // runProbs(x Float32Array, H, W) -> Promise<Float32Array probs (NC*H*W)>;  core = wear-core api
  function createSegmenter(runProbs, core, opts = {}) {
    const faces = [];
    async function segmentSide(P, i) {
      if (!P.img) throw new Error('seg: photo missing (wear-core too old)');
      const win = sideWindow(P), {Wn, Hn, fromStrip} = win, n = Wn * Hn;
      // opts.oracle(i, toPhoto, Wn, Hn) -> probs: exact labels instead of the network (tests of the VB maths)
      const prob = opts.oracle ? opts.oracle(i, win.toPhoto, Wn, Hn) : await runProbs(windowInput(P.img, Wn, Hn, win.toPhoto), Hn, Wn);
      const {strip} = P, {w, h, cx, R, top} = strip, y1 = Math.min(h, top + P.zoneRows);
      const cls = new Uint8Array(w * h);
      let sil = 0, seen = 0;
      for (let y = Math.max(0, top - 2); y < Math.min(h, y1 + 2); y++) for (let x = 0; x < w; x++) {
        const [X, Y] = fromStrip(x, y), c = classAt(prob, Wn, Hn, X, Y); cls[y * w + x] = c;
        if (y >= top && y < y1 && Math.abs(x - cx) < .8 * R && !Number.isNaN(strip.g[y * w + x])) { sil++; if (c) seen++; }
      }
      const toolFrac = sil ? seen / sil : 0;
      const {cls: wc, conf} = argmax(prob, n);
      let cs = 0, cn = 0; for (let j = 0; j < n; j++) if (wc[j]) { cs += conf[j]; cn++; }
      const confidence = cn ? cs / cn : 0;
      if (toolFrac < MIN_TOOL) throw new Error(`seg: the network sees only ${Math.round(100 * toolFrac)} % of the tool in the zone`);
      // the window starts ABOVE * D over the tip line: that strip must be background. Tool there = the alignment put the
      // tip too low (the worn corner is outside the zone) -> the side goes to the operator instead of a confident 0
      const Yt = Math.round((ABOVE - .1) * win.netD), Rw = win.netD / 2;
      let an = 0, at = 0;
      for (let Y = 0; Y < Yt; Y++) for (let X = 0; X < Wn; X++) {
        if (Math.abs(X + .5 - Wn / 2) >= .6 * Rw) continue;
        const [px, py] = win.toPhoto(X, Y); if (px < 0 || py < 0 || px >= P.img.width || py >= P.img.height) continue;   // clamped border: not evidence
        an++; if (wc[Y * Wn + X]) at++;
      }
      const aboveTip = an ? at / an : 0, flags = aboveTip > MAX_ABOVE ? ['tip-misplaced'] : [];
      // flank band = flank wear + chipping inside the zone; one photo measures the flute it faces = the largest piece
      const m = new Uint8Array(w * h);
      for (let y = top; y < y1; y++) for (let x = 0; x < w; x++) { const c = cls[y * w + x]; if ((c === 2 || c === 3) && Math.abs(x - cx) < EDGE_U * R) m[y * w + x] = 1; }
      const {lab, sizes} = components(m, w, h);
      let best = 0; for (let c = 1; c < sizes.length; c++) if (sizes[c] > (sizes[best] || 0)) best = c;
      const band = new Uint8Array(w * h); if (best) for (let j = 0; j < w * h; j++) if (lab[j] === best) band[j] = 1;
      const land = landWidth(wc, Wn, Hn, win, P, EDGE_U, opts.vb);
      const rowVbMm = new Float32Array(y1 - top);
      for (let y = top; y < y1; y++) {
        const Ya = Math.max(0, Math.floor(fromStrip(cx, y - .5)[1])), Yb = Math.min(Hn - 1, Math.ceil(fromStrip(cx, y + .5)[1]));
        let v = 0; for (let Y = Ya; Y <= Yb; Y++) v = Math.max(v, land.vbMm[Y]); rowVbMm[y - top] = v;
      }
      // VB uncertainty: the land width read from the flank+chip probability at a low and a high threshold (instead of the
      // argmax), and from the horizontally mirrored photo (test-time flip). A soft or two-way land edge moves VBmax
      const zEnd0 = Math.min(Hn, Math.ceil((P.al.vTip + P.zoneRows - win.v0) * win.k)), Yw = Math.round(ABOVE * win.netD);
      const vbMaxOf = lw => { let v = 0; for (let Y = Yw; Y < zEnd0; Y++) v = Math.max(v, lw.vbMm[Y]); return v; };
      const byThr = t => { const a = new Uint8Array(n); for (let j = 0; j < n; j++) a[j] = prob[2 * n + j] + prob[3 * n + j] > t ? 2 : (wc[j] ? 1 : 0); return vbMaxOf(landWidth(a, Wn, Hn, win, P, EDGE_U, opts.vb)); };
      const vbArg = vbMaxOf(land), vbLo = byThr(.3), vbHi = byThr(.7);
      let vbFlip = null;
      if (opts.tta !== false && !opts.oracle) {
        const xin = windowInput(P.img, Wn, Hn, (X, Y) => win.toPhoto(Wn - 1 - X, Y)), pf = await runProbs(xin, Hn, Wn), wf = new Uint8Array(n);
        for (let Y = 0; Y < Hn; Y++) for (let X = 0; X < Wn; X++) { const i0 = Y * Wn + (Wn - 1 - X); let b = 0; for (let c = 1; c < NC; c++) if (pf[c * n + i0] > pf[b * n + i0]) b = c; wf[Y * Wn + X] = b; }
        vbFlip = vbMaxOf(landWidth(wf, Wn, Hn, win, P, EDGE_U, opts.vb));
      }
      const vbs = [vbArg, vbLo, vbHi].concat(vbFlip === null ? [] : [vbFlip]), vbSpreadMm = Math.max(...vbs) - Math.min(...vbs);
      if (vbSpreadMm > UNC_ABS || vbSpreadMm > UNC_REL * Math.max(vbArg, .1) || (vbFlip !== null && Math.abs(vbFlip - vbArg) > UNC_FLIP)) flags.push('vb-uncertain');
      const tip = mergeTip(tipChips(wc, cls, Wn, Hn, win, P, strip, y1), opts.oracle || opts.classicTip === false ? null : classicTip(core, P, cls), flags);
      // per-class areas in the zone (projected, mm^2) on the network window
      const ppmNet = win.k * P.al.pxPerMm, areas = {2: 0, 3: 0, 4: 0}, zEnd = (P.al.vTip + P.zoneRows - win.v0) * win.k;
      for (let Y = 0; Y < Math.min(Hn, zEnd); Y++) for (let X = 0; X < Wn; X++) { const c = wc[Y * Wn + X]; if (c >= 2) areas[c]++; }
      for (const c of [2, 3, 4]) areas[c] = r4(areas[c] / ppmNet / ppmNet);
      const al = P.al, Rmm = R / strip.ppm, k = opts.flutes || 0;
      faces[i] = {face: 'side' + (i + 1), angleDeg: k ? i * 360 / k : null, w: Wn, h: Hn, mask: wc, pxPerMm: r4(ppmNet), netD: win.netD,
        toTool: (X, Y) => { const u = (X + .5 - Wn / 2) / win.k / al.pxPerMm, z = (win.v0 + (Y + .5) / win.k - al.vTip) / al.pxPerMm; return {zMm: z, uMm: u, thetaDeg: (faces[i].angleDeg || 0) + Math.asin(Math.max(-1, Math.min(1, u / Rmm))) * 180 / Math.PI}; },
        areasMm2: areas, confidence: r4(confidence), toolFrac: r4(toolFrac), aboveTip: r4(aboveTip), bandPieces: sizes.length - 1,
        tip: tip ? {depthMm: tip.depthMm, source: tip.source || 'seg', netDepthMm: tip.netDepthMm, colorDepthMm: tip.colorDepthMm} : null,
        vb: {arg: r4(vbArg), lo: r4(vbLo), hi: r4(vbHi), flip: vbFlip === null ? null : r4(vbFlip), spreadMm: r4(vbSpreadMm)}};
      return {band, rowVbMm, tip, thr: r4(confidence), med: 0, sig: 0, y1, method: 'seg', classes: cls, flags,
        seg: {confidence: r4(confidence), toolFrac: r4(toolFrac), aboveTip: r4(aboveTip), pieces: sizes.length - 1, areasMm2: areas, netD: win.netD, Wn, Hn,
          vb: {arg: r4(vbArg), lo: r4(vbLo), hi: r4(vbHi), flip: vbFlip === null ? null : r4(vbFlip), spreadMm: r4(vbSpreadMm)}}};
    }
    const segmenter = (P, i) => segmentSide(P, i);
    segmenter.faces = faces;
    segmenter.segmentTop = async (img, top, D) => {
      if (!top || !(top.rPx > 0)) return null;
      const r = top.rPx, netD = NET_ClampD(2 * r), k = netD / (2 * r), S = ceil32(2.8 * r * k);
      const toPhoto = (X, Y) => [top.cx + (X + .5 - S / 2) / k, top.cy + (Y + .5 - S / 2) / k];
      const prob = await runProbs(windowInput(img, S, S, toPhoto), S, S), n = S * S, {cls, conf} = argmax(prob, n);
      const ppmNet = k * top.pxPerMm, areas = {2: 0, 3: 0, 4: 0}; let cs = 0, cn = 0;
      for (let j = 0; j < n; j++) { if (cls[j] >= 2) areas[cls[j]]++; if (cls[j]) { cs += conf[j]; cn++; } }
      for (const c of [2, 3, 4]) areas[c] = r4(areas[c] / ppmNet / ppmNet);
      return {face: 'top', angleDeg: 0, w: S, h: S, mask: cls, pxPerMm: r4(ppmNet), netD,
        toTool: (X, Y) => { const x = (X + .5 - S / 2) / ppmNet, y = -(Y + .5 - S / 2) / ppmNet; return {xMm: x, yMm: y, zMm: 0, rMm: Math.hypot(x, y), thetaDeg: Math.atan2(y, x) * 180 / Math.PI}; },
        areasMm2: areas, confidence: r4(cn ? cs / cn : 0)};
    };
    return segmenter;
  }

  // generic contract: whole image -> class mask (image scaled so its long side is <= maxSide, multiples of 32)
  async function segmentImage(runProbs, img, maxSide = 512) {
    const s = Math.min(1, maxSide / Math.max(img.width, img.height)), Wn = ceil32(img.width * s), Hn = ceil32(img.height * s);
    const sx = img.width / Wn, sy = img.height / Hn;
    const prob = await runProbs(windowInput(img, Wn, Hn, (X, Y) => [(X + .5) * sx - .5, (Y + .5) * sy - .5]), Hn, Wn);
    const {cls, conf} = argmax(prob, Wn * Hn);
    let cs = 0; for (const c of conf) cs += c;
    return {mask: cls, w: Wn, h: Hn, classes: CLASSES.slice(), confidence: r4(cs / conf.length), scale: [sx, sy]};
  }

  // ---------- browser: lazy-load onnxruntime-web (shared with ai-wear.js) + the model ----------
  let sessionP = null;
  const base = () => { const s = typeof document !== 'undefined' && [...document.scripts].find(e => /js\/wear\/seg-wear\.js/.test(e.src)); return s ? s.src.replace(/js\/wear\/seg-wear\.js.*$/, '') : ''; };
  const loadScript = src => new Promise((ok, bad) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => bad(new Error('load ' + src)); document.head.appendChild(e); });
  const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  // one onnxruntime-web per page: Tool3D.ortInit() is also used by ai-wear.js (PatchCore fallback)
  function ortInit() {
    const T = self.Tool3D;
    if (T.ortInitP) return T.ortInitP;
    T.ortInitP = (async () => {
      const b = base();
      if (!self.ort) await loadScript(b + 'vendor/ort/ort.wasm.min.js');
      if (!T.ortGlue) await loadScript(b + 'vendor/ort/ort-wasm-glue.js');
      if (!T.ortWasmBin) { if (!T.ortWasmB64) await loadScript(b + 'vendor/ort/ort-wasm-bin.js'); T.ortWasmBin = b64(T.ortWasmB64); T.ortWasmB64 = null; }
      const ort = self.ort;
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
      ort.env.wasm.wasmBinary = T.ortWasmBin;
      ort.env.wasm.wasmPaths = {mjs: URL.createObjectURL(new Blob([T.ortGlue], {type: 'text/javascript'}))};
      return ort;
    })();
    T.ortInitP.catch(() => { T.ortInitP = null; });
    return T.ortInitP;
  }
  function load() {
    if (sessionP) return sessionP;
    sessionP = (async () => {
      const T = self.Tool3D, ort = await ortInit();
      if (!T.segModelB64) await loadScript(base() + 'models/wear-seg.onnx.js');
      const session = await ort.InferenceSession.create(b64(T.segModelB64), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
      T.segModelB64 = null;
      return {ort, session};
    })();
    sessionP.catch(() => { sessionP = null; });
    return sessionP;
  }
  const ortRunner = ({ort, session}) => async (x, H, W) => (await session.run({image: new ort.Tensor('float32', x, [1, 3, H, W])})).probs.data;

  // same inputs as Tool3D.wear.run; resolves to the wearResult (engine 'seg'); sides the network cannot read use the classic path
  async function run(shots, opts) {
    const T = self.Tool3D, W = T.wear, k = opts.flutes;
    const sides = shots.slice(0, k).filter(Boolean).map(W.toImage), top = shots[k] ? W.toImage(shots[k]) : null;
    if (sides.length < k) throw new Error(`wear: need ${k} side photos, got ${sides.length}`);
    const t0 = Date.now(), runner = ortRunner(await load()), seg = createSegmenter(runner, W, {flutes: k});
    const {result, debug} = await W.measureAsync(Object.assign({}, opts, {sides, top}), seg, 'seg');
    let topFace = null;
    try { topFace = top && debug.top ? await seg.segmentTop(top, debug.top, opts.diameterMm) : null; } catch (e) { debug.segTopError = String(e && e.message || e); }
    T.faceSeg = seg.faces.filter(Boolean).concat(topFace ? [topFace] : []);
    result.faces = T.faceSeg.map(f => ({face: f.face, angleDeg: f.angleDeg, areasMm2: f.areasMm2, confidence: f.confidence}));
    debug.segMs = Date.now() - t0; debug.faceSeg = T.faceSeg;
    T.wearResult = result; T.wearDebug = debug;
    window.dispatchEvent(new CustomEvent('tool3d:wear', {detail: result}));
    return result;
  }
  const segment = async img => segmentImage(ortRunner(await load()), img);

  return {createSegmenter, segmentImage, sideWindow, windowInput, classAt, components, load, ortInit, run, segment, CLASSES, NC};
});
