/* Tool3D measurement helpers for section ④ (pure JS, no DOM: browser Tool3D.metroVb, Node module.exports).
 * Microscope-style flank wear presentation: reference line fitted on the cutting edge, VB dimension lines across the land
 * with values, VBmax / VBB / VBC / VBN with positions, scale bar, VB profile along the edge, tool-life trend, tolerance
 * verdict, and the end-face (top view) wear AREA per tooth.
 * Nothing here measures VB: every VB value is a row of metro-core evaluate() (rows.vb), so the numbers match the
 * engine and the operator edits. The end-face area reads the class mask the wear engine already produced (read only).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.metroVb = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;
  const r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 1e4) / 1e4;
  const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1)); };
  const qFloor = (a, p) => { const b = Float32Array.from(a).sort(); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };   // as the wear engine
  const quant = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y), i = (b.length - 1) * p, l = Math.floor(i); return b[l] + (b[Math.min(b.length - 1, l + 1)] - b[l]) * (i - l); };
  const DEFAULTS = {
    helixDeg: 30,
    nVbLines: 5,          // VB dimension lines per flute (plus the maximum)
    magConstMm: 297,      // equivalent display magnification X ~= 297 mm / field-of-view width (desktop monitor convention)
    tol: {vbMaxMm: .3, vbbMaxMm: .5, vbcMm: .5, topWornMm2: .5}
  };

  // ---------- scale bar and equivalent magnification ----------
  // largest 1/2/2.5/5 x 10^n um bar that fits targetPx
  function scaleBar(pxPerMm, targetPx) {
    const ppu = pxPerMm / 1000; let best = null;
    for (let e = -1; e <= 5; e++) for (const m of [1, 2, 2.5, 5]) { const um = m * 10 ** e, px = um * ppu; if (px <= targetPx && (!best || um > best.um)) best = {um, px}; }
    if (!best) best = {um: .1, px: .1 * ppu};
    return {um: best.um, px: best.px, label: (best.um >= 1000 ? r2(best.um / 1000) + ' mm' : r2(best.um) + ' µm')};
  }
  const MAGS = [20, 30, 50, 80, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 2500, 3000, 5000];
  function magnification(pxPerMm, widthPx, magConstMm = DEFAULTS.magConstMm) {
    const fovMm = widthPx / pxPerMm, x = magConstMm / fovMm, sig = 10 ** (Math.floor(Math.log10(x)) - 1);
    const std = MAGS.find(m => Math.abs(x / m - 1) < .05), mag = std || Math.round(x / sig) * sig;
    return {fovMm: r4(fovMm), mag: r4(mag), umPerPx: r4(1000 / pxPerMm), label: '×' + r4(mag)};
  }

  // ---------- reference line (unworn cutting edge) ----------
  // rows = metro-core evaluate().rows {vb, A, B, dz}; edge 'a' | 'b'; top = strip row of the tip.
  // Straight line x = a + b*y fitted (least squares) on the edge-side boundary of the rows WITHOUT wear (the unworn edge);
  // when fewer than 5 such rows exist, on every row. Residual = rms distance of the edge points from the line (px).
  const edgeXs = (rows, edge) => Array.from(rows.vb, (_, r) => edge === 'a' ? rows.A[r] - .5 : rows.B[r] + .5);
  function refLine(rows, edge, top) {
    const n = rows.vb.length, xs = edgeXs(rows, edge), unworn = [];
    for (let r = 0; r < n; r++) if (!(rows.vb[r] > 0)) unworn.push(r);
    const use = unworn.length >= 5 ? unworn : Array.from({length: n}, (_, r) => r);
    const Y = use.map(r => top + r + .5), X = use.map(r => xs[r]), my = mean(Y), mx = mean(X);
    const syy = Y.reduce((s, y) => s + (y - my) ** 2, 0), b = syy ? Y.reduce((s, y, i) => s + (y - my) * (X[i] - mx), 0) / syy : 0, a = mx - b * my;
    const res = Math.sqrt(mean(Y.map((y, i) => (X[i] - a - b * y) ** 2)));
    return {a: r4(a), b: r4(b), y0: top + .5, y1: top + n - .5, fitRows: use.length, from: use === unworn ? 'unworn' : 'all', residualPx: r4(res), angleDeg: r2(Math.atan(b) / DEG),
      x: y => a + b * y};
  }
  // perpendicular foot of point (x, y) on the line x = a + b*y
  const foot = (L, x, y) => { const yy = (y + L.b * (x - L.a)) / (1 + L.b * L.b); return [L.a + L.b * yy, yy]; };

  // VB dimension lines: n evenly spaced worn rows + the row of VBmax. Each line runs from the edge (on the row) across
  // the land to the wear front; value = rows.vb (the measured VB, mm -> um). ref: foot of the front on the reference line.
  function vbLines(rows, edge, top, o = {}) {
    const n = o.n || DEFAULTS.nVbLines, cb = Math.cos((o.helixDeg == null ? DEFAULTS.helixDeg : o.helixDeg) * DEG), vb = rows.vb, worn = [];
    for (let r = 0; r < vb.length; r++) if (vb[r] > 0) worn.push(r);
    if (!worn.length) return [];
    const L = o.ref || refLine(rows, edge, top), pick = new Set(), r0 = worn[0], r1 = worn[worn.length - 1];
    for (let i = 0; i < n; i++) { const t = r0 + (r1 - r0) * (i + .5) / n; pick.add(worn.reduce((b, r) => Math.abs(r - t) < Math.abs(b - t) ? r : b, worn[0])); }
    const rMax = worn.reduce((b, r) => vb[r] > vb[b] ? r : b, worn[0]); pick.add(rMax);
    return [...pick].sort((a, b) => a - b).map((r, i) => {
      const xa = rows.A[r] - .5, xb = rows.B[r] + .5, y = top + r + .5, xF = edge === 'a' ? xb : xa, f = foot(L, xF, y);
      return {n: i + 1, r, y, xEdge: edge === 'a' ? xa : xb, xFront: xF, xRef: r4(L.x(y)), foot: [r4(f[0]), r4(f[1])], vbUm: r2(vb[r] * 1000),
        zMm: r4((r + .5) * rows.dz), uMm: r4((r + .5) * rows.dz / cb), isMax: r === rMax};
    });
  }

  // ---------- VB along the edge, statistics, ISO quantities with positions ----------
  // u = z / cos(helix) = length along the helical cutting edge
  function profileU(rows, helixDeg) {
    const cb = Math.cos((helixDeg == null ? DEFAULTS.helixDeg : helixDeg) * DEG), out = [];
    for (let r = 0; r < rows.vb.length; r++) out.push({uMm: r4((r + .5) * rows.dz / cb), zMm: r4((r + .5) * rows.dz), vbUm: r2(rows.vb[r] * 1000)});
    return out;
  }
  function stats(profile) {
    const v = profile.map(p => p.vbUm), w = v.filter(x => x > 0), du = profile.length > 1 ? (profile[profile.length - 1].uMm - profile[0].uMm) / (profile.length - 1) : 0;
    const iMax = v.reduce((b, x, i) => x > v[b] ? i : b, 0);
    return {n: w.length, lengthMm: r4(profile.length * du), wornMm: r4(w.length * du), wornPct: r2(100 * w.length / (v.length || 1)),
      maxUm: r2(Math.max(0, ...v)), uAtMaxMm: profile.length ? profile[iMax].uMm : null, minUm: r2(w.length ? Math.min(...w) : 0), meanUm: r2(mean(w)),
      sdUm: r2(sd(w)), medianUm: r2(quant(w, .5)), p25Um: r2(quant(w, .25)), p75Um: r2(quant(w, .75))};
  }
  // position (z from the tip, mm) of each ISO 8688-2 quantity; values are taken from evaluate().q so they stay identical
  function positions(ev) {
    const {vb, dz} = ev.rows, z = ev.zones, zr = r => (r + .5) * dz, n = vb.length;
    const zone = r => zr(r) < z.cornerMm ? 'C' : Math.abs(zr(r) - z.apMm) <= z.notchHalfMm ? 'N' : 'B';
    const at = pred => { let b = -1; for (let r = 0; r < n; r++) if (vb[r] > 0 && pred(r) && (b < 0 || vb[r] > vb[b])) b = r; return b < 0 ? null : r4(zr(b)); };
    const span = pred => { let a = null, b = null; for (let r = 0; r < n; r++) if (vb[r] > 0 && pred(r)) { if (a == null) a = r; b = r; } return a == null ? null : [r4(a * dz), r4((b + 1) * dz)]; };
    const tipFirst = ev.tipMm > 0 && ev.vbSource && /corner/.test(ev.vbSource);
    return {
      vbMax: {v: ev.q.vbMax.v, U: ev.q.vbMax.U, zMm: tipFirst ? 0 : ev.zAtMaxMm},
      vbb: {v: ev.q.vbb.v, U: ev.q.vbb.U, span: span(r => zone(r) === 'B')},
      vbbMax: {v: ev.q.vbbMax.v, U: ev.q.vbbMax.U, zMm: at(r => zone(r) === 'B')},
      vbc: {v: ev.q.vbc.v, U: ev.q.vbc.U, zMm: ev.tipMm > 0 && ev.tipMm >= ev.q.vbc.v ? 0 : at(r => zone(r) === 'C')},
      vbn: {v: ev.q.vbn.v, U: ev.q.vbn.U, zMm: at(r => zone(r) === 'N')}
    };
  }

  // ---------- tolerance verdict ----------
  // v: {vbMaxMm, vbbMaxMm, vbcMm, topWornMm2}; null values are not judged
  function tolerance(v, tol) {
    const t = Object.assign({}, DEFAULTS.tol, tol), row = (key, label, unit) => ({key, label, value: v[key] == null ? null : v[key], limit: t[key], unit, pass: v[key] == null ? null : v[key] <= t[key]});
    const rows = [row('vbMaxMm', 'VBmax', 'mm'), row('vbbMaxMm', 'VBB max (zone B)', 'mm'), row('vbcMm', 'VBC corner', 'mm'), row('topWornMm2', 'End-face wear area', 'mm²')];
    const judged = rows.filter(r => r.pass != null);
    return {rows, pass: judged.length ? judged.every(r => r.pass) : null, failed: judged.filter(r => !r.pass).map(r => r.key)};
  }

  // ---------- tool-life trend ----------
  // least squares VBmax vs x (cutting minutes when every entry has them, else the measurement index); x where VBmax
  // reaches the limit and how many more units that is from the last entry
  function trend(list, limitMm) {
    const p = list.filter(e => e && e.vbMax != null); if (p.length < 2) return null;
    const byTime = p.every(e => e.cutMin != null), x = p.map((e, i) => byTime ? +e.cutMin : i + 1), y = p.map(e => e.vbMax), mx = mean(x), my = mean(y);
    const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0); if (!sxx) return null;
    const slope = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx, icpt = my - slope * mx;
    const res = y.map((v, i) => v - (icpt + slope * x[i])), se = p.length > 2 ? Math.sqrt(res.reduce((s, v) => s + v * v, 0) / (p.length - 2)) : 0;
    const xLim = slope > 0 && limitMm ? (limitMm - icpt) / slope : null, last = x[x.length - 1];
    return {n: p.length, per: byTime ? 'min' : 'measurement', slope: r4(slope), intercept: r4(icpt), seMm: r4(se), x, y,
      xAtLimit: xLim == null ? null : r2(xLim), remaining: xLim == null ? null : r2(Math.max(0, xLim - last))};
  }

  // ---------- end face (top view): wear area per tooth ----------
  // Class mask of the end face: 0 background, 1 tool, 2 flank wear, 3 chipping, 4 adhesion (the wear engine's classes).
  // f = {w, h, cls, cx, cy, rPx, pxPerMm}; k = number of teeth. The end face is split into k sectors around the axis;
  // the tooth phase is the k-th circular harmonic of the tool pixels of the outer ring (0.55..0.95 R), where the teeth
  // reach out to the periphery and the flute gullies do not. Areas in mm² (pixel count / px/mm²).
  const CLS = {1: 'tool', 2: 'flank', 3: 'chipping', 4: 'adhesion'};
  function endFaceArea(f, k, o = {}) {
    const {w, h, cls, cx, cy, rPx: R, pxPerMm: ppm} = f, R2 = (1.03 * R) ** 2, px2 = 1 / (ppm * ppm);
    let re = 0, im = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = cls[y * w + x]; if (!c) continue;
      const dx = x + .5 - cx, dy = cy - (y + .5), rr = Math.hypot(dx, dy); if (rr < .55 * R || rr > .95 * R) continue;
      const t = k * Math.atan2(dy, dx); re += Math.cos(t); im += Math.sin(t);
    }
    const phase = o.phaseDeg != null ? o.phaseDeg * DEG : (re || im ? Math.atan2(im, re) / k : 0), sec = TAU / k;
    const teeth = Array.from({length: k}, (_, j) => ({tooth: j + 1, centreDeg: r2(((phase + j * sec) / DEG + 360) % 360), landPx: 0, flankPx: 0, chipPx: 0, adhPx: 0, rMinWorn: Infinity}));
    const sector = new Int8Array(w * h).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, c = cls[i], dx = x + .5 - cx, dy = cy - (y + .5), d2 = dx * dx + dy * dy; if (!c || d2 > R2) continue;
      const j = ((Math.round((Math.atan2(dy, dx) - phase) / sec) % k) + k) % k, T = teeth[j]; sector[i] = j;
      T.landPx++; if (c === 2) T.flankPx++; else if (c === 3) T.chipPx++; else if (c === 4) T.adhPx++;
      if (c >= 2) T.rMinWorn = Math.min(T.rMinWorn, Math.sqrt(d2));
    }
    const out = teeth.map(T => {
      const worn = T.flankPx + T.chipPx + T.adhPx;
      return {tooth: T.tooth, centreDeg: T.centreDeg, landMm2: r4(T.landPx * px2), wornMm2: r4(worn * px2), flankMm2: r4(T.flankPx * px2), chippingMm2: r4(T.chipPx * px2),
        adhesionMm2: r4(T.adhPx * px2), wornPct: r2(T.landPx ? 100 * worn / T.landPx : 0), rimDepthMm: worn ? r4(Math.max(0, R - T.rMinWorn) / ppm) : 0};
    });
    const sum = key => r4(out.reduce((s, t) => s + t[key], 0)), land = sum('landMm2'), worn = sum('wornMm2');
    return {k, phaseDeg: r2(((phase / DEG) % 360 + 360) % 360), pxPerMm: ppm, rPx: R, cx, cy, teeth: out, sector,
      total: {landMm2: land, wornMm2: worn, flankMm2: sum('flankMm2'), chippingMm2: sum('chippingMm2'), adhesionMm2: sum('adhesionMm2'), wornPct: r2(land ? 100 * worn / land : 0)},
      maxTooth: out.reduce((b, t) => t.wornMm2 > b.wornMm2 ? t : b, out[0]).tooth};
  }
  // class mask from the top photo when the network gave none (classic engine): worn = bright pixels inside 0.95 R by the
  // same rule as the wear engine's end-face check (median + sens * 1.4826 MAD, MAD >= 4 grey levels), so the worn total
  // equals its endBrightAreaMm2; tool vs gully = Otsu threshold of the grey levels inside R.
  // g = {w, h, g: Float32Array grey}; top = {cx, cy, rPx, pxPerMm} in the same pixels
  function classesFromGray(G, top, sens = 4) {
    const {w, h, g} = G, {cx, cy, rPx: r} = top, cls = new Uint8Array(w * h), vals = [], idx = [], all = [];
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < r * r) all.push(y * w + x);
      if (d2 < (.95 * r) ** 2) { vals.push(g[y * w + x]); idx.push(y * w + x); }
    }
    const med = qFloor(vals, .5), sig = Math.max(4, 1.4826 * qFloor(vals.map(v => Math.abs(v - med)), .5)), thr = med + sens * sig;
    const hist = new Float64Array(256); for (const i of all) hist[Math.max(0, Math.min(255, Math.round(g[i])))]++;
    let sum = 0, tot = 0; for (let v = 0; v < 256; v++) { sum += v * hist[v]; tot += hist[v]; }
    let wB = 0, sB = 0, best = 0, otsu = 128; for (let v = 0; v < 256; v++) { wB += hist[v]; if (!wB || wB === tot) continue; sB += v * hist[v]; const mB = sB / wB, mF = (sum - sB) / (tot - wB), b = wB * (tot - wB) * (mB - mF) ** 2; if (b > best) { best = b; otsu = v; } }
    for (const i of all) if (g[i] > otsu) cls[i] = 1;
    idx.forEach((i, j) => { if (vals[j] > thr) cls[i] = 2; });
    return {w, h, cls, cx, cy, rPx: r, pxPerMm: top.pxPerMm, thr: r2(thr), otsu};
  }

  // network end-face mask (seg engine: f = {w, h, mask, netD}, centred on the end-face circle, netD px = diameter) laid
  // onto the photo grid of classesFromGray(): the network decides worn / not worn, the grey-level Otsu split keeps
  // telling the tooth land from the dark flute gullies (the network labels the whole disc 'tool').
  function mergeNet(c, f, top) {
    const {w, h, cx, cy, rPx: r} = c, k = f.netD / (2 * r), cls = new Uint8Array(c.cls);
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      const i = y * w + x; if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 >= r * r) continue;
      const X = Math.floor((x + .5 - cx) * k + f.w / 2), Y = Math.floor((y + .5 - cy) * k + f.h / 2), s = X >= 0 && Y >= 0 && X < f.w && Y < f.h ? f.mask[Y * f.w + X] : 0;
      if (cls[i]) cls[i] = s >= 2 ? s : 1;
    }
    return Object.assign({}, c, {cls, source: 'network'});
  }

  // ---------- CSV sections appended to the measurement CSV (metro-core csv) ----------
  // s = Tool3D.metro.summary(): s.vb[i] {pos, lines, stats, mag, umPerPx, ref}, s.endFace, s.tolerance
  function csvSections(s) {
    const L = [], esc = v => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }, row = a => L.push(a.map(esc).join(','));
    const vb = (s.vb || []).map((x, i) => x && Object.assign({i}, x)).filter(Boolean);
    if (vb.length) {
      row([]); row(['vb_position_flute', 'VBmax_mm', 'VBmax_z_mm', 'VBB_mm', 'VBB_z0_mm', 'VBB_z1_mm', 'VBBmax_mm', 'VBBmax_z_mm', 'VBC_mm', 'VBC_z_mm', 'VBN_mm', 'VBN_z_mm']);
      vb.forEach(x => { const p = x.pos; row(['F' + (x.i + 1), p.vbMax.v, p.vbMax.zMm, p.vbb.v, p.vbb.span ? p.vbb.span[0] : '', p.vbb.span ? p.vbb.span[1] : '', p.vbbMax.v, p.vbbMax.zMm, p.vbc.v, p.vbc.zMm, p.vbn.v, p.vbn.zMm]); });
      row([]); row(['vb_line_flute', 'n', 'z_mm', 'u_mm', 'VB_um', 'is_max']);
      vb.forEach(x => x.lines.forEach(l => row(['F' + (x.i + 1), l.n, l.zMm, l.uMm, l.vbUm, l.isMax ? 1 : 0])));
      row([]); row(['vb_stats_flute', 'VBmax_um', 'VBmean_um', 'VBmin_um', 'sd_um', 'median_um', 'worn_mm', 'worn_pct', 'length_mm', 'mag_equiv', 'um_per_px', 'refline_angle_deg', 'refline_residual_px', 'refline_fit']);
      vb.forEach(x => { const t = x.stats; row(['F' + (x.i + 1), t.maxUm, t.meanUm, t.minUm, t.sdUm, t.medianUm, t.wornMm, t.wornPct, t.lengthMm, String(x.mag).replace('×', 'x'), x.umPerPx, x.ref.angleDeg, x.ref.residualPx, x.ref.from]); });
    }
    const E = s.endFace;
    if (E) {
      row([]); row(['end_face_tooth', 'centre_deg', 'land_mm2', 'worn_mm2', 'flank_mm2', 'chipping_mm2', 'adhesion_mm2', 'worn_pct', 'rim_depth_mm', 'source']);
      E.teeth.forEach(t => row(['T' + t.tooth, t.centreDeg, t.landMm2, t.wornMm2, t.flankMm2, t.chippingMm2, t.adhesionMm2, t.wornPct, t.rimDepthMm, E.source]));
      row(['total', '', E.total.landMm2, E.total.wornMm2, E.total.flankMm2, E.total.chippingMm2, E.total.adhesionMm2, E.total.wornPct, '', E.source]);
    }
    const T = s.tolerance;
    if (T) { row([]); row(['tolerance', 'value', 'limit', 'unit', 'result']); T.rows.forEach(r => row([r.key, r.value, r.limit, r.unit.replace('²', '2'), r.pass == null ? '' : r.pass ? 'PASS' : 'FAIL'])); row(['overall', '', '', '', T.pass == null ? '' : T.pass ? 'PASS' : 'FAIL']); }
    return L.join('\r\n') + (L.length ? '\r\n' : '');
  }

  return {DEFAULTS, csvSections, scaleBar, magnification, refLine, vbLines, profileU, stats, positions, tolerance, trend, endFaceArea, classesFromGray, mergeNet, CLS, r2, r4};
});
