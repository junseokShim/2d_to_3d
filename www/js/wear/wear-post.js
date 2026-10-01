/* Tool3D wear, post-processing of a segmented wear land in the two ways VB measurement instruments report it.
 * Input: a class map (0 background, 1 tool, 2 flank wear, 3 chipping, 4 adhesion) of one side, e.g. the seg network's window.
 * The land (largest piece of classes 2 + 3) is cut into stations along its own axis; at each station the land has a
 * cutting-edge boundary e(s) and a wear boundary b(s) (offsets normal to the edge, mm on the tool surface).
 *
 * refLine  (digital microscope practice): the operator draws a straight reference line on the
 *          unworn part of the cutting edge and extends it; VB = perpendicular distance from that line to the wear
 *          boundary ([1] 90.34 um), edge recession / chipping = perpendicular distance from the line to the actual edge
 *          ([2] 24.33 um); the edge-height profile is read the same way (line on the unworn part, max drop below it).
 *          Here: the longest run of stations whose edge lies on the robust edge line (within the tolerance) = the unworn
 *          part; least-squares line on it, extrapolated over the whole land.
 * edgeDev  (3D edge-measurement practice, ISO 8688): a reference edge
 *          fitted to the whole evaluated edge; a defect = a stretch where the edge lies below the reference by more than
 *          the tolerance. Nd defects, L evaluated length, Pd = sum Li / L, Ddmax / Ddmean depth, Ldmax / Ldmean length
 *          along the edge, Ldcmax / Ldcmean length along the clearance (flank) surface, VBmax / VBmean / VB(s).
 *          From one photo: no rake face (Ldr*) and no heights (volumes Vp / Vv / Vd*) -> null.
 * Browser: Tool3D.wear.post.analyze(opts);  Node: require('wear-post.js').analyze(opts)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.wear = root.Tool3D.wear || {}; root.Tool3D.wear.post = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const TOL_PX = 1.5, TOL_MM = .01;   // defect tolerance: max(1.5 px, 10 um) below the reference edge

  // least-squares line o = a + c s over the points (s, o)
  function fitLine(S, O) {
    const n = S.length; if (n < 2) return {a: n ? O[0] : 0, c: 0};
    let ms = 0, mo = 0; for (let i = 0; i < n; i++) { ms += S[i]; mo += O[i]; } ms /= n; mo /= n;
    let sso = 0, sss = 0; for (let i = 0; i < n; i++) { sso += (S[i] - ms) * (O[i] - mo); sss += (S[i] - ms) ** 2; }
    const c = sss ? sso / sss : 0; return {a: mo - c * ms, c};
  }
  // reference edge: the edge's outer envelope. Iterated fit; stations receded more than tol below the line are dropped
  // (defects must not pull the reference in), the rest are kept.
  function robustEdge(S, E, tol) {
    let keep = S.map(() => true), L = fitLine(S, E);
    for (let it = 0; it < 8; it++) {
      const k2 = S.map((s, i) => E[i] - (L.a + L.c * s) <= tol);
      if (k2.filter(Boolean).length < Math.max(2, .2 * S.length)) break;
      const L2 = fitLine(S.filter((_, i) => k2[i]), E.filter((_, i) => k2[i]));
      keep = k2; if (Math.abs(L2.a - L.a) < 1e-6 && Math.abs(L2.c - L.c) < 1e-9) { L = L2; break; }
      L = L2;
    }
    return {L, keep};
  }
  function residualSd(S, O) { const L = fitLine(S, O); let q = 0; for (let i = 0; i < S.length; i++) q += (O[i] - L.a - L.c * S[i]) ** 2; return Math.sqrt(q / Math.max(1, S.length)); }

  // runs of true in a boolean array (gaps of <= gap stations are bridged)
  function runs(b, gap = 1) {
    const out = []; let s = -1, last = -1;
    for (let i = 0; i < b.length; i++) if (b[i]) { if (s < 0 || i - last > gap + 1) { if (s >= 0) out.push([s, last]); s = i; } last = i; }
    if (s >= 0) out.push([s, last]);
    return out;
  }

  /* opts: mask (Uint8Array w*h classes), w, h, pxPerMm (mask px per mm), rows [Y0, Y1) (optional), classes (default [2, 3]),
   *       toMm(X, Y) -> [x, y] mm on the tool surface (default X / ppm, Y / ppm; seg-wear passes the cylinder unwrap),
   *       edge 'auto' | 'background' | 'straight' (which land boundary is the cutting edge), tolMm */
  function analyze(opts) {
    const {mask, w, h, pxPerMm: ppm} = opts, cl = opts.classes || [2, 3], Y0 = Math.max(0, (opts.rows || [0])[0] | 0), Y1 = Math.min(h, opts.rows ? Math.ceil(opts.rows[1]) : h);
    const toMm = opts.toMm || ((X, Y) => [X / ppm, Y / ppm]), tol = Math.max(TOL_PX / ppm, opts.tolMm || TOL_MM), step = 1 / ppm;
    const isW = j => cl.includes(mask[j]);
    // largest 4-connected piece of the land inside the rows
    const lab = new Int32Array(w * h), st = []; let best = 0, bestN = 0, id = 0;
    for (let s0 = Y0 * w; s0 < Y1 * w; s0++) {
      if (!isW(s0) || lab[s0]) continue;
      let n = 0; lab[s0] = ++id; st.push(s0);
      while (st.length) { const i = st.pop(), x = i % w, y = i / w | 0; n++; for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { if (xx < 0 || xx >= w || yy < Y0 || yy >= Y1) continue; const j = yy * w + xx; if (isW(j) && !lab[j]) { lab[j] = id; st.push(j); } } }
      if (n > bestN) { bestN = n; best = id; }
    }
    if (bestN < 4) return null;
    // land points on the tool surface (mm) + what lies beyond each boundary pixel (background or tool)
    const P = [];
    for (let j = Y0 * w; j < Y1 * w; j++) if (lab[j] === best) {
      const x = j % w, y = j / w | 0, [px, py] = toMm(x + .5, y + .5); let bg = 0, edge = 0;
      for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { const out = xx < 0 || xx >= w || yy < 0 || yy >= h; if (out || lab[yy * w + xx] !== best) { edge = 1; if (!out && mask[yy * w + xx] === 0) bg = 1; } }
      P.push([px, py, edge, bg]);
    }
    // land axis (principal direction) -> station s along it, offset o normal to it
    let mx = 0, my = 0; for (const p of P) { mx += p[0]; my += p[1]; } mx /= P.length; my /= P.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of P) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = .5 * Math.atan2(2 * sxy, sxx - syy), t = [Math.cos(th), Math.sin(th)], nv = [-t[1], t[0]];
    let s0 = Infinity, s1 = -Infinity; const so = P.map(p => { const s = (p[0] - mx) * t[0] + (p[1] - my) * t[1], o = (p[0] - mx) * nv[0] + (p[1] - my) * nv[1]; s0 = Math.min(s0, s); s1 = Math.max(s1, s); return [s, o]; });
    const nb = Math.max(1, Math.floor((s1 - s0) / step) + 1), lo = new Float64Array(nb).fill(Infinity), hi = new Float64Array(nb).fill(-Infinity);
    so.forEach(([s, o]) => { const b = Math.min(nb - 1, Math.floor((s - s0) / step)); lo[b] = Math.min(lo[b], o); hi[b] = Math.max(hi[b], o); });
    // background beside each boundary: share of boundary pixels near lo / hi that touch the background
    const bgc = [0, 0], edc = [0, 0];
    so.forEach(([s, o], i) => { if (!P[i][2]) return; const b = Math.min(nb - 1, Math.floor((s - s0) / step)); const side = o - lo[b] <= step ? 0 : hi[b] - o <= step ? 1 : -1; if (side < 0) return; edc[side]++; bgc[side] += P[i][3]; });
    const S = [], LO = [], HI = []; for (let b = 0; b < nb; b++) if (lo[b] <= hi[b]) { S.push(s0 + (b + .5) * step); LO.push(lo[b] - step / 2); HI.push(hi[b] + step / 2); }
    if (S.length < 3) return null;
    const bf = [edc[0] ? bgc[0] / edc[0] : 0, edc[1] ? bgc[1] / edc[1] : 0];
    let edgeLo;
    const mode = opts.edge || 'auto';
    if (mode === 'background' || (mode === 'auto' && Math.max(...bf) > .3 && Math.abs(bf[0] - bf[1]) > .2)) edgeLo = bf[0] >= bf[1];
    else edgeLo = residualSd(S, LO) <= residualSd(S, HI);   // the cutting edge is the straight side, the wear boundary the ragged one
    // orient: offsets grow from the edge into the flank (e <= b)
    const E = edgeLo ? LO : HI.map(v => -v), B = edgeLo ? HI : LO.map(v => -v);
    const len = S[S.length - 1] - S[0] + step;

    // ---- edgeDev: reference edge over the whole evaluated edge, defects below tolerance ----
    const {L: La} = robustEdge(S, E, tol), refA = s => La.a + La.c * s;
    const dA = E.map((e, i) => e - refA(S[i])), vbA = B.map((b, i) => b - refA(S[i]));
    const defects = runs(dA.map(d => d > tol)).map(([a, b]) => {
      const ds = dA.slice(a, b + 1), vs = vbA.slice(a, b + 1), k = ds.indexOf(Math.max(...ds));
      return {fromMm: r4(S[a] - S[0]), toMm: r4(S[b] - S[0] + step), lengthMm: r4(S[b] - S[a] + step), depthMaxMm: r4(Math.max(...ds)), depthMeanMm: r4(ds.reduce((p, q) => p + q, 0) / ds.length),
        clearanceLengthMm: r4(Math.max(...vs)), clearanceMeanMm: r4(vs.reduce((p, q) => p + q, 0) / vs.length), atMm: r4(S[a + k] - S[0]), areaMm2: r4(ds.reduce((p, q) => p + q, 0) * step)};
    });
    const sum = a => a.reduce((p, q) => p + q, 0), mean = a => a.length ? sum(a) / a.length : 0, iMax = a => a.indexOf(Math.max(...a));
    const dDef = []; defects.forEach(d => { for (let i = 0; i < S.length; i++) if (S[i] - S[0] >= d.fromMm - 1e-9 && S[i] - S[0] < d.toMm - 1e-9) dDef.push(dA[i]); });
    const kA = iMax(vbA);
    const edgeDev = {
      method: 'reference edge = robust line over the whole edge; defect = edge below it by > tolerance',
      toleranceMm: r4(tol), L: r4(len), Nd: defects.length, Pd: r4(100 * sum(defects.map(d => d.lengthMm)) / len),
      Ddmax: r4(defects.length ? Math.max(...defects.map(d => d.depthMaxMm)) : 0), Ddmean: r4(mean(dDef)),
      Ldmax: r4(defects.length ? Math.max(...defects.map(d => d.lengthMm)) : 0), Ldmean: r4(mean(defects.map(d => d.lengthMm))),
      Ldcmax: r4(defects.length ? Math.max(...defects.map(d => d.clearanceLengthMm)) : 0), Ldcmean: r4(mean(defects.map(d => d.clearanceMeanMm))),
      Ldrmax: null, Ldrmean: null, Vdrel: null, Vp: null, Vv: null,
      Dmin: r4(-Math.max(0, ...dA)), Dmax: r4(Math.max(0, ...dA.map(d => -d))), Dmean: r4(-mean(dA)),
      VBmax: r4(vbA[kA]), VBmean: r4(mean(vbA)), VBmaxAtMm: r4(S[kA] - S[0]), defects};

    // ---- refLine: line on the unworn part of the edge (longest run on the reference), extended over the whole land ----
    const on = runs(dA.map(d => Math.abs(d) <= tol), 0).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
    const Lk = on && on[1] - on[0] >= 2 ? fitLine(S.slice(on[0], on[1] + 1), E.slice(on[0], on[1] + 1)) : La, refK = s => Lk.a + Lk.c * s;
    const vbK = B.map((b, i) => b - refK(S[i])), dK = E.map((e, i) => e - refK(S[i])), kK = iMax(vbK), kR = iMax(dK);
    const refLine = {
      method: 'reference line on the unworn cutting edge (least squares, extended); perpendicular distances to it',
      referenceMm: on ? [r4(S[on[0]] - S[0]), r4(S[on[1]] - S[0] + step)] : null,
      VBmax: r4(vbK[kK]), VBmaxAtMm: r4(S[kK] - S[0]), VBmean: r4(mean(vbK)),
      edgeRecessionMax: r4(Math.max(0, dK[kR])), edgeRecessionAtMm: r4(S[kR] - S[0]), angleDeg: r4(Math.atan(Lk.c - La.c) * 180 / Math.PI)};
    const profile = S.map((s, i) => ({sMm: r4(s - S[0]), vbMm: r4(vbA[i]), edgeDevMm: r4(dA[i])}));
    return {edgeSide: mode === 'auto' ? (Math.max(...bf) > .3 && Math.abs(bf[0] - bf[1]) > .2 ? 'background' : 'straight') : mode, lengthMm: r4(len), stations: S.length, refLine, edgeDev, profile};
  }

  return {analyze, fitLine, TOL_PX, TOL_MM};
});
