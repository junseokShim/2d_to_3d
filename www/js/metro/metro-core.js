/* Tool3D metrology core: ISO 8688-2 / ISO 3685 flank-wear quantities, manual correction, calibration, uncertainty,
 * CSV and a one-page PDF writer. Pure JS, no DOM: browser (window.Tool3D.metroCore) and Node (module.exports).
 * Input per flute = the rectified strip + wear band that js/wear leaves in Tool3D.wearDebug.strips[i]
 * (strip: {w, h, g, cx, R, top, ppm}; band: Uint8Array w*h). The wear algorithms are not changed: with no manual edit
 * evaluate() reproduces wear-core measureBand() exactly (same per-row arc width, 3-row median, bins).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.metroCore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, r4 = v => Math.round(v * 1e4) / 1e4;
  const DEFAULTS = {
    limitMm: .3,          // wear criterion VB (ISO 8688-2 uniform wear VBB = 0.3 mm)
    warnFrac: .8,         // amber from this fraction of the limit
    cornerMm: null,       // zone C length from the tip; null = 0.1 * D
    apMm: null,           // axial depth of cut (notch line, zone N); null = 0.5 * D
    notchHalfMm: null,    // half width of zone N around ap; null = 0.05 * D
    zoneMm: null,         // evaluated length (wear-core default 0.8 * D)
    clearanceDeg: 8, binMm: .1,
    sigmaEdgePx: .5,      // std. uncertainty of an auto-detected edge (px)
    sigmaManualPx: 1,     // std. uncertainty of an operator-placed edge / point (px)
    diaTolMm: .01,        // tool diameter tolerance (half width, rectangular) used for the scale
    helixUDeg: 2          // std. uncertainty of the helix angle
  };
  const opt = (o, D) => {
    const x = Object.assign({}, DEFAULTS, o);
    if (x.cornerMm == null) x.cornerMm = .1 * D;
    if (x.apMm == null) x.apMm = .5 * D;
    if (x.notchHalfMm == null) x.notchHalfMm = .05 * D;
    if (x.zoneMm == null) x.zoneMm = .8 * D;
    return x;
  };
  const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1)); };

  // ---------- flute model: per-row band boundaries + editable correction nodes ----------
  // Row r (0..n-1) is strip row top + r, i.e. axial position z = (r + .5) / ppm from the tip.
  // a0/b0 = first/last band column of the row. A row without wear gets a0 = e + .5, b0 = e - .5 (zero width) on the edge
  // line e, so dragging a node opens a band there too. Edits are node offsets (px), linearly interpolated between nodes.
  // rowVbMm (optional, AI (Seg) engine): per-row land thickness normal to the edge that wear-core measureBand() reports
  // as VB instead of the band's arc width; evaluate() uses it while the flute is unedited so the panel shows the engine's
  // numbers exactly. The band gives the (editable) boundary lines; an edit adds its width change to the engine rows.
  function flute(strip, band, D, o, rowVbMm) {
    o = opt(o, D);
    const {w, h, top, ppm, cx} = strip, n = Math.max(1, Math.min(h, top + Math.round(o.zoneMm * ppm)) - top);
    const a0 = new Float32Array(n), b0 = new Float32Array(n), has = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
      const y = top + r; let a = -1, b = -1;
      for (let x = 0; x < w; x++) if (band[y * w + x]) { if (a < 0) a = x; b = x; }
      if (a >= 0) { a0[r] = a; b0[r] = b; has[r] = 1; }
    }
    // cutting-edge side = the straighter boundary (a worn flank land is bounded by the edge on one side, the ragged
    // wear front on the other)
    let ra = 0, rb = 0, m = 0;
    for (let r = 1; r < n; r++) if (has[r] && has[r - 1]) { ra += Math.abs(a0[r] - a0[r - 1]); rb += Math.abs(b0[r] - b0[r - 1]); m++; }
    const edge = m && rb < ra ? 'b' : 'a';
    const src = edge === 'a' ? a0 : b0, idx = []; for (let r = 0; r < n; r++) if (has[r]) idx.push(r);
    const edgeAt = r => {                          // interpolate the edge line over rows without wear
      if (!idx.length) return cx;
      let lo = -1, hi = -1; for (const i of idx) { if (i <= r) lo = i; if (i >= r && hi < 0) hi = i; }
      if (lo < 0) return src[hi]; if (hi < 0) return src[lo];
      return lo === hi ? src[lo] : src[lo] + (src[hi] - src[lo]) * (r - lo) / (hi - lo);
    };
    for (let r = 0; r < n; r++) if (!has[r]) { const e = edgeAt(r); a0[r] = e + .5; b0[r] = e - .5; }
    const N = Math.max(3, Math.min(33, Math.round(n / (.25 * ppm)) + 1)), nodeRows = new Float32Array(N);
    for (let i = 0; i < N; i++) nodeRows[i] = i * (n - 1) / (N - 1);
    return {strip, D, n, a0, b0, has, edge, nodeRows, nodes: {a: new Float32Array(N), b: new Float32Array(N)}, edited: false, rowVbMm: rowVbMm || null};
  }
  // ---------- operator-assisted fallback (auto band failed / low confidence) ----------
  // Cutting-edge line from geometry: on the rectified strip a helical edge at arc position s(z) = s0 + sgn*z*tan(helix)
  // projects to x = cx + R*sin(s/Rmm). s0 and the hand (sgn) are searched for the strongest consistent step along that
  // curve (the edge is the sharpest long feature on the flank side: groove/margin vs land). The flank (wear) side is the
  // brighter one; the flute groove ahead of the edge is dark. The operator then drags the wear boundary (and the edge
  // line if needed); nothing here measures VB.
  function edgeGuess(strip, D, o) {
    o = opt(o, D);
    const {w, h, g, cx, R, top, ppm} = strip, n = Math.max(1, Math.min(h, top + Math.round(o.zoneMm * ppm)) - top), Rmm = R / ppm;
    const tb = Math.tan((o.helixDeg == null ? 30 : o.helixDeg) * DEG), at = (x, y) => {
      const x0 = Math.floor(x), f = x - x0; if (x0 < 0 || x0 >= w - 1) return NaN;
      return g[y * w + x0] * (1 - f) + g[y * w + x0 + 1] * f;
    };
    const X = (s0, sgn, r) => { const a = (s0 + sgn * (r + .5) / ppm * tb) / Rmm; return Math.abs(a) > 1.15 ? NaN : cx + R * Math.sin(a); };
    const rs = []; for (let r = 0; r < n; r += Math.max(1, Math.round(n / 60))) rs.push(r);
    let best = null;
    for (const sgn of [1, -1]) for (let s0 = -1.15 * Rmm; s0 <= 1.15 * Rmm; s0 += .5 / ppm) {
      let sum = 0, m = 0, pos = 0;
      for (const r of rs) {
        const x = X(s0, sgn, r); if (Number.isNaN(x)) continue;
        const y = top + r, d = (at(x + 1, y) + at(x + 2, y) - at(x - 1, y) - at(x - 2, y)) / 2; if (Number.isNaN(d)) continue;
        sum += d; pos += Math.abs(d); m++;
      }
      if (m < .6 * rs.length) continue;
      const sc = (Math.abs(sum) + pos) / 2 / m;   // mean step, favouring a consistent sign along the edge
      if (!best || sc > best.score) best = {score: sc, s0, sgn};
    }
    if (!best) return null;
    const x = new Float32Array(n); for (let r = 0; r < n; r++) { const v = X(best.s0, best.sgn, r); x[r] = Number.isNaN(v) ? (r ? x[r - 1] : cx) : v; }
    // side: mean grey 0.05..0.15 D either side of the line; the dark one is the groove, the band grows the other way
    const win = side => { let s = 0, c = 0; for (const r of rs) for (let k = .05 * D * ppm; k <= .15 * D * ppm; k += 1) { const v = at(x[r] + side * k, top + r); if (!Number.isNaN(v)) { s += v; c++; } } return c ? s / c : NaN; };
    const L = win(-1), Rr = win(1), edge = Number.isNaN(L) || Number.isNaN(Rr) ? 'a' : L < Rr ? 'a' : 'b', fs = edge === 'a' ? 1 : -1;
    // bright margin / edge glint: groove -> bright ridge (< 0.4 mm) -> land. The edge is the ridge's flank-side border.
    const stepAt = t => { let s = 0, c = 0; for (const r of rs) { const xx = x[r] + fs * t, y = top + r, d = fs * (at(xx + 1, y) + at(xx + 2, y) - at(xx - 1, y) - at(xx - 2, y)) / 2; if (!Number.isNaN(d)) { s += d; c++; } } return c ? s / c : 0; };
    const up = stepAt(0); let ridge = null;
    if (up > 0) for (let t = 2; t <= .4 * ppm; t += .5) { const d = -stepAt(t); if (d > .3 * up && (!ridge || d > ridge.d)) ridge = {t, d}; }
    if (ridge) for (let r = 0; r < n; r++) x[r] += fs * ridge.t;
    return {x, edge, n, score: r4(best.score), s0Mm: r4(best.s0), hand: best.sgn, contrast: r4(Math.abs(L - Rr) || 0), ridgeMm: ridge ? r4(ridge.t / ppm) : 0};
  }
  // flute model for the assisted path: zero-width band on the guessed edge line (drag the wear boundary to open it)
  function assistFlute(strip, D, o, reason) {
    const F = flute(strip, new Uint8Array(strip.w * strip.h), D, o), G = edgeGuess(strip, D, o);
    if (G) { F.edge = G.edge; for (let r = 0; r < F.n; r++) { F.a0[r] = G.x[r] + .5; F.b0[r] = G.x[r] - .5; } }
    F.assist = {reason: reason || 'no-band', guess: !!G, score: G ? G.score : 0};
    return F;
  }
  // result mode: auto | edited | awaiting-operator (assisted, not yet confirmed) | operator-assisted
  const mode = F => F.assist ? (F.edited ? 'operator-assisted' : 'awaiting-operator') : F.edited ? 'edited' : 'auto';

  function delta(F, side, r) {
    const R = F.nodeRows, d = F.nodes[side], N = R.length;
    if (r <= R[0]) return d[0]; if (r >= R[N - 1]) return d[N - 1];
    const s = (N - 1) * r / R[N - 1], i = Math.min(N - 2, Math.floor(s)), t = s - i;
    return d[i] * (1 - t) + d[i + 1] * t;
  }
  // corrected boundary columns of row r
  const bounds = (F, r) => [F.a0[r] + delta(F, 'a', r), F.b0[r] + delta(F, 'b', r)];
  // edge line x (outer pixel border of the edge-side boundary) at row r
  const edgeX = (F, r) => { const [A, B] = bounds(F, r); return F.edge === 'a' ? A - .5 : B + .5; };
  function setNode(F, side, i, dPx) { F.nodes[side][i] = dPx; F.edited = F.nodes.a.some(Boolean) || F.nodes.b.some(Boolean); }
  function resetNodes(F) { F.nodes.a.fill(0); F.nodes.b.fill(0); F.edited = false; }

  // ---------- evaluation: VB(z), ISO zones, area, volume, uncertainty ----------
  // o.helixDeg, o.scale (= strip px/mm / calibrated px/mm; 1 = diameter scale), o.uScaleRel (std. rel. scale uncertainty)
  function evaluate(F, o) {
    o = opt(o, F.D);
    const {strip: {cx, R, ppm}, n} = F, f = o.scale || 1, h = (o.helixDeg == null ? 30 : o.helixDeg) * DEG, cb = Math.cos(h), tc = Math.tan(o.clearanceDeg * DEG);
    const Rmm = R / ppm, arc = u => Rmm * Math.asin(Math.max(-1, Math.min(1, u / R)));
    const raw = new Float64Array(n), A = new Float32Array(n), B = new Float32Array(n);
    const arcW = (a, b) => b - a > -1 + 1e-6 ? Math.max(0, arc(b + .5 - cx) - arc(a - .5 - cx)) : 0;
    for (let r = 0; r < n; r++) {
      const [a, b] = bounds(F, r); A[r] = a; B[r] = b;
      // engine rows (AI (Seg)): land thickness as arc width, exactly as measureBand; an operator edit adds the change of
      // the corrected band width (0 while unedited), so dragging the front out/in grows/shrinks VB from the engine value
      raw[r] = F.rowVbMm ? Math.max(0, (F.rowVbMm[r] || 0) / cb + (F.edited ? arcW(a, b) - arcW(F.a0[r], F.b0[r]) : 0)) : arcW(a, b);
    }
    const ws = Array.from(raw, (_, i) => { const q = Array.from(raw.slice(Math.max(0, i - 1), i + 2)).sort((p, s) => p - s); return q[q.length >> 1]; });
    const dz = f / ppm, vb = ws.map(s => s * cb * f);
    let area = 0, vol = 0; ws.forEach((s, i) => { area += s * f * dz; vol += .5 * vb[i] ** 2 * tc * dz / cb; });
    const nb = Math.max(1, Math.round(o.binMm * ppm)), profile = [];
    for (let i = 0; i < n; i += nb) { const sl = vb.slice(i, i + nb); profile.push({zMm: r4((i + sl.length / 2) * dz), vbMm: r4(mean(sl))}); }
    const z = r => (r + .5) * dz, zone = r => z(r) < o.cornerMm ? 'C' : Math.abs(z(r) - o.apMm) <= o.notchHalfMm ? 'N' : 'B';
    const pick = pred => { const i = []; for (let r = 0; r < n; r++) if (pred(r)) i.push(r); return i; };
    const worn = pick(r => vb[r] > 0), inB = worn.filter(r => zone(r) === 'B');
    const argmax = rs => rs.reduce((b, r) => vb[r] > vb[b] ? r : b, rs[0]);
    const maxOf = rs => rs.length ? vb[argmax(rs)] : 0;
    // uncertainty components (standard, mm)
    const uRel = o.uScaleRel || 0, sig = F.edited ? o.sigmaManualPx : o.sigmaEdgePx, uEdge = Math.SQRT2 * sig / ppm * f * cb, uh = o.helixUDeg * DEG;
    const budget = (v, rep) => {
      const p = {scale: v * uRel, edge: uEdge, rep, helix: v * Math.tan(h) * uh};
      const u = Math.sqrt(p.scale ** 2 + p.edge ** 2 + p.rep ** 2 + p.helix ** 2);
      return {v: r4(v), U: r4(2 * u), u: r4(u), parts: {scale: r4(p.scale), edge: r4(p.edge), rep: r4(p.rep), helix: r4(p.helix)}};
    };
    const repMax = rs => { if (!rs.length) return 0; const m = argmax(rs); return sd(Array.from(vb.slice(Math.max(0, m - 3), m + 4)).filter(v => v > 0)); };
    const repAvg = rs => rs.length < 2 ? 0 : sd(rs.map(r => vb[r])) / Math.sqrt(Math.max(1, rs.length / 3));   // 3-row median: ~1/3 independent rows
    const avg = rs => mean(rs.map(r => vb[r]));
    const zC = pick(r => vb[r] > 0 && zone(r) === 'C'), zN = pick(r => vb[r] > 0 && zone(r) === 'N');
    // tip / corner damage measured by wear-core (strip.tip: chipping / broken end tooth, depth from the original corner)
    // is corner wear VBC (ISO 8688-2 zone C) and therefore also VBmax; the flank band alone is vbFlankMax
    const tipMm = F.strip.tip && F.strip.tip.depthMm > 0 ? F.strip.tip.depthMm * f : 0, flankMax = maxOf(worn);
    const tipQ = budget(tipMm, 0), vbc = budget(maxOf(zC), repMax(zC));
    const q = {
      vbMax: tipMm > flankMax ? tipQ : budget(flankMax, repMax(worn)),
      vbFlankMax: budget(flankMax, repMax(worn)),
      vbAvg: budget(avg(worn), repAvg(worn)),
      vbb: budget(avg(inB), repAvg(inB)),
      vbbMax: budget(maxOf(inB), repMax(inB)),
      vbc: tipMm > vbc.v ? tipQ : vbc,
      vbn: budget(maxOf(zN), repMax(zN))
    };
    return {
      q, vbMaxMm: q.vbMax.v, vbAvgMm: q.vbAvg.v, areaMm2: r4(area), volumeMm3: r4(vol), profile, wornLengthMm: r4(worn.length * dz),
      zAtMaxMm: worn.length ? r4(z(argmax(worn))) : null, rows: {vb, A, B, dz}, zones: {cornerMm: o.cornerMm, apMm: o.apMm, notchHalfMm: o.notchHalfMm, zoneMm: r4(n * dz)},
      tipMm: r4(tipMm), vbSource: tipMm > flankMax ? 'corner/tip (VBC)' : flankMax > 0 ? 'flank (VB)' : 'none',
      edited: F.edited, edge: F.edge, sigmaPx: sig, mode: mode(F), assist: F.assist ? F.assist.reason : null
    };
  }

  // ---------- conformity (ISO 14253-1 style decision with the expanded uncertainty) + traffic light ----------
  function status(v, U, limitMm, warnFrac) {
    const L = limitMm || DEFAULTS.limitMm, wf = warnFrac == null ? DEFAULTS.warnFrac : warnFrac;
    const decision = v + U < L ? 'conform' : v - U > L ? 'nonconform' : 'indeterminate';
    const light = v >= L ? 'red' : v + U >= L || v >= wf * L ? 'amber' : 'green';
    return {decision, light, pass: v < L, usedPct: r4(100 * v / L)};
  }

  // ---------- calibration: px/mm from the known diameter, or from a reference target (ruler / checkerboard) ----------
  // sides: [{pxPerMm}] from wear-core align(); ref: {px, mm, tolMm?} = two picked points and their known distance
  function calibration(sides, D, o, ref) {
    o = opt(o, D);
    const pp = sides.map(s => s && s.pxPerMm).filter(v => v > 0), m = mean(pp), sep = m * D;
    const diam = {
      method: 'diameter', pxPerMm: r4(m),
      parts: {diameter: r4(o.diaTolMm / Math.sqrt(3) / D), edges: r4(Math.SQRT2 * o.sigmaEdgePx / (sep || 1)), spread: r4(pp.length > 1 ? sd(pp) / m : 0)}
    };
    diam.uRel = r4(Math.hypot(diam.parts.diameter, diam.parts.edges, diam.parts.spread));
    if (!ref || !(ref.px > 0 && ref.mm > 0)) return Object.assign(diam, {U_pxPerMm: r4(2 * diam.uRel * m), scaleFor: () => 1});
    const ppm = ref.px / ref.mm, parts = {reference: r4((ref.tolMm || 0) / Math.sqrt(3) / ref.mm), picks: r4(Math.SQRT2 * o.sigmaManualPx / ref.px)};
    const uRel = r4(Math.hypot(parts.reference, parts.picks));
    return {method: 'reference', pxPerMm: r4(ppm), parts, uRel, U_pxPerMm: r4(2 * uRel * ppm), diameter: diam,
      deviationPct: r4(100 * (m / ppm - 1)), scaleFor: stripPpm => stripPpm / ppm};
  }

  // ---------- manual measurement on the calibrated (rectified) image ----------
  const dist = (p, q, ppm, f = 1) => Math.hypot(q[0] - p[0], q[1] - p[1]) / ppm * f;
  // VB caliper: point (strip px) -> perpendicular distance to the cutting-edge polyline, plus the VB-normal value
  // (arc width along the row * cos(helix)), which is how VB is defined on the cylinder
  function caliper(F, pt, o) {
    const {strip: {top, ppm, cx, R}, n} = F, f = o.scale || 1, cb = Math.cos((o.helixDeg == null ? 30 : o.helixDeg) * DEG);
    let best = {d: Infinity};
    for (let r = 0; r < n - 1; r++) {
      const x1 = edgeX(F, r), y1 = top + r + .5, x2 = edgeX(F, r + 1), y2 = y1 + 1, vx = x2 - x1, vy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((pt[0] - x1) * vx + (pt[1] - y1) * vy) / (vx * vx + vy * vy)));
      const px = x1 + t * vx, py = y1 + t * vy, d = Math.hypot(pt[0] - px, pt[1] - py);
      if (d < best.d) best = {d, foot: [px, py]};
    }
    const r = Math.max(0, Math.min(n - 1, Math.round(pt[1] - top - .5))), Rmm = R / ppm, arc = u => Rmm * Math.asin(Math.max(-1, Math.min(1, u / R)));
    const vbNormal = Math.abs(arc(pt[0] - cx) - arc(edgeX(F, r) - cx)) * cb * f;
    return {perpMm: r4(best.d / ppm * f), vbMm: r4(vbNormal), foot: best.foot, zMm: r4((r + .5) / ppm * f)};
  }
  // expanded uncertainty of a manual length (two operator points + scale)
  const manualU = (lenMm, ppm, uScaleRel, o) => r4(2 * Math.hypot(lenMm * (uScaleRel || 0), Math.SQRT2 * (o && o.sigmaManualPx || DEFAULTS.sigmaManualPx) / ppm));

  // ---------- CSV ----------
  function csv(rep) {
    const L = [], esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }, row = a => L.push(a.map(esc).join(','));
    row(['Tool3D wear measurement report']); row(['tool_id', rep.toolId]); row(['operator', rep.operator]); row(['date', rep.date]);
    row(['diameter_mm', rep.D]); row(['flutes', rep.k]); row(['helix_deg', rep.helixDeg]); row(['engine', rep.engine]);
    row(['scale_px_per_mm', rep.calib.pxPerMm]); row(['scale_method', rep.calib.method]); row(['scale_U_rel_k2', r4(2 * rep.calib.uRel)]);
    row(['limit_VB_mm', rep.limitMm]); row(['decision_rule', 'ISO 14253-1: conform if VB+U<limit, nonconform if VB-U>limit']);
    row([]);
    row(['flute', 'VBmax_mm', 'U_VBmax', 'VBavg_mm', 'U_VBavg', 'VBB_mm', 'U_VBB', 'VBBmax_mm', 'U_VBBmax', 'VBC_mm', 'U_VBC', 'VBN_mm', 'U_VBN', 'area_mm2', 'volume_mm3', 'z_at_max_mm', 'edited', 'decision', 'light', 'mode']);
    rep.flutes.forEach((e, i) => { const q = e.q; row([i + 1, q.vbMax.v, q.vbMax.U, q.vbAvg.v, q.vbAvg.U, q.vbb.v, q.vbb.U, q.vbbMax.v, q.vbbMax.U, q.vbc.v, q.vbc.U, q.vbn.v, q.vbn.U, e.areaMm2, e.volumeMm3, e.zAtMaxMm, e.edited ? 1 : 0, e.status.decision, e.status.light, e.mode || 'auto']); });
    row([]);
    row(['z_mm'].concat(rep.flutes.map((_, i) => 'VB_F' + (i + 1) + '_mm')));
    const nz = Math.max(...rep.flutes.map(e => e.profile.length));
    for (let j = 0; j < nz; j++) row([(rep.flutes.find(e => e.profile[j]) || {profile: []}).profile[j].zMm].concat(rep.flutes.map(e => e.profile[j] ? e.profile[j].vbMm : '')));
    if (rep.manual && rep.manual.length) { row([]); row(['manual_measurement', 'flute', 'value_mm', 'U_mm']); rep.manual.forEach(m => row([m.kind, m.flute, m.mm, m.U])); }
    return L.join('\r\n') + '\r\n';
  }

  // ---------- minimal one-page PDF writer (Helvetica, vector drawing, JPEG images) ----------
  // Coordinates in pt, origin top-left (converted to PDF bottom-left). Text is WinAnsi: keep it ASCII.
  function PdfPage(W = 595.28, H = 841.89) {
    const ops = [], images = [], col = c => { const v = typeof c === 'string' ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255) : c || [0, 0, 0]; return v.map(x => +x.toFixed(3)).join(' '); };
    const t = s => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1'), Y = y => +(H - y).toFixed(2), n = v => +(+v).toFixed(2);
    return {
      W, H, ops, images,
      text(x, y, str, size = 9, o = {}) {
        const w = o.align ? this.width(str, size, o.bold) : 0, x0 = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
        ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${col(o.color)} rg ${n(x0)} ${Y(y)} Td (${t(str)}) Tj ET`);
      },
      width: (str, size, bold) => String(str).length * size * (bold ? .56 : .52),   // Helvetica average advance (layout only)
      line(x1, y1, x2, y2, w = .5, c, dash) { ops.push(`${col(c)} RG ${w} w ${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${n(x1)} ${Y(y1)} m ${n(x2)} ${Y(y2)} l S`); },
      poly(pts, w = .8, c) { if (pts.length < 2) return; ops.push(`${col(c)} RG ${w} w [] 0 d ` + pts.map((p, i) => `${n(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' S'); },
      rect(x, y, w, h, fill, stroke, lw = .5) { ops.push(`${fill ? col(fill) + ' rg ' : ''}${stroke ? col(stroke) + ' RG ' + lw + ' w [] 0 d ' : ''}${n(x)} ${Y(y + h)} ${n(w)} ${n(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`); },
      image(jpeg, pw, ph, x, y, w, h) { const name = 'Im' + images.length; images.push({name, jpeg, pw, ph}); ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${Y(y + h)} cm /${name} Do Q`); }
    };
  }
  function pdfBytes(page) {
    const enc = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
    const chunks = [], offs = []; let len = 0;
    const put = b => { if (typeof b === 'string') b = enc(b); chunks.push(b); len += b.length; };
    const obj = (i, body) => { offs[i] = len; put(`${i} 0 obj\n`); (Array.isArray(body) ? body : [body]).forEach(put); put('\nendobj\n'); };
    // one page (object) or several ([page, page, ...]; js/post adds its page after the metrology page)
    const pages = Array.isArray(page) ? page : [page];
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    let next = 5; const kids = [];
    for (const pg of pages) {
      const pi = next, ci = next + 1, first = next + 2, content = pg.ops.join('\n'); next = first + pg.images.length; kids.push(pi + ' 0 R');
      const xo = pg.images.map((m, i) => `/${m.name} ${first + i} 0 R`).join(' ');
      obj(pi, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pg.W} ${pg.H}] /Contents ${ci} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> >>`);
      obj(ci, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
      pg.images.forEach((m, i) => obj(first + i, [`<< /Type /XObject /Subtype /Image /Width ${m.pw} /Height ${m.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${m.jpeg.length} >>\nstream\n`, m.jpeg, '\nendstream']));
    }
    obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
    const nObj = next, xref = len;
    put(`xref\n0 ${nObj}\n0000000000 65535 f \n` + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
    put(`trailer\n<< /Size ${nObj} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------- measurement history per tool id (storage = localStorage-like {getItem, setItem}) ----------
  const HKEY = 'tool3d.metro.history';
  function historyAll(store) { try { return JSON.parse(store.getItem(HKEY) || '{}') || {}; } catch (e) { return {}; } }
  const history = (store, id) => (historyAll(store)[id] || []).slice();
  function historyAdd(store, id, entry, max = 200) {
    const all = historyAll(store), list = (all[id] || []).concat([entry]).slice(-max); all[id] = list;
    try { store.setItem(HKEY, JSON.stringify(all)); } catch (e) { /* quota / private mode: keep in memory only */ }
    return list;
  }
  // wear rate from the history (mm per entry index or per hour when entries carry cutting time)
  function trend(list) {
    const p = list.filter(e => e.vbMax != null); if (p.length < 2) return null;
    const x = p.map((e, i) => e.cutMin != null ? e.cutMin : i), y = p.map(e => e.vbMax), mx = mean(x), my = mean(y);
    const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0); if (!sxx) return null;
    const slope = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx;
    return {slope: r4(slope), per: p.some(e => e.cutMin != null) ? 'min' : 'measurement'};
  }

  return {DEFAULTS, opt, flute, edgeGuess, assistFlute, mode, delta, bounds, edgeX, setNode, resetNodes, evaluate, status, calibration, dist, caliper, manualU, csv, PdfPage, pdfBytes,
    HKEY, history, historyAdd, historyAll, trend, r4};
});
