/* Tool3D surface metrology core: 3D evaluations on the measured model (section ③), computed from what map3d already has.
 * Pure JS, no DOM: browser window.Tool3D.surfaceCore, Node module.exports.
 *
 * Inputs (produced elsewhere, never modified here):
 *   atlas = map3d-core evaluate().atlas: side {NA, NZ, dA, dz, R, cellArea, cls, depth}, end {N, cell, R, cls, depth, inside, cellArea}
 *   look  = map3dCore.toothLookup(layout) (tooth + arc length s behind the cutting edge at an azimuth / z)
 *   layout = render geometry layout(params): cols (tip cross-section, tooth / s per column), tanH, zTwistMax, endZ
 * Depth model (photos give no height): a flank land of width VB removes a wedge, edge recession h = VB tan(clearance), depth
 * behind the edge at arc distance s = (VB - s) tan(clearance); chips take the map3d chip depth (distance to the chip
 * boundary, capped). Deviations are negative below the nominal surface; mm unless the name says Um.
 *
 *   deviation(atlas, look, o)         deviation fields {side, end} on the atlas grids
 *   devAt(dev, x, y, z, part)         deviation at a tool-frame point
 *   volumeStats(dev, tolUm, filter)   Dmin / Dmean / Vv (below nominal) / Vp / Vdv, Vdp (beyond tolerance) / area
 *   perFace(dev, faces, azSign)       volumeStats per photographed face
 *   perFlute(dev, atlas, look, layout, perTooth, o)   per flute: worn area, wear volume, Dmin, chip depth, VBmax, edge section
 *   edgeSection(vbMm, o)              nominal vs worn wedge normal to the edge, recession, equivalent edge radius
 *   chips(atlas, look, o)             connected chip regions (side + end)
 *   nominalRadius(layout)             (theta, z) -> nominal radius of the parametric model (side surfaces)
 *   profile(o)                        section profile along a picked line: nominal and measured heights, deviation
 *   tolerance(v, tol)                 pass / fail rows
 *   history / historyAdd / trend      wear volume per measurement (tool life)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.surfaceCore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;
  const r4 = v => Math.round(v * 1e4) / 1e4, r2 = v => Math.round(v * 100) / 100, r6 = v => Math.round(v * 1e6) / 1e6;
  const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0;
  const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
  const DEFAULTS = {
    clearanceDeg: 8, rakeDeg: 8, helixDeg: 30,
    devTolUm: 10,              // volume beyond this deviation counts as a defect volume (Vdv / Vdp)
    tol: {devMaxUm: 60, chipDepthUm: 50, vdvMm3: .005, wearVolumeMm3: .02}
  };
  const deg = (o, k) => (o[k] == null ? DEFAULTS[k] : o[k]) * DEG;

  // ---------- deviation vs nominal on the model ----------
  function deviation(atlas, look, o = {}) {
    // s is arc length behind the edge on the envelope; normal to the helical edge it is s cos(helix) (VB = W cos(helix))
    const S = atlas.side, E = atlas.end, ta = Math.tan(deg(o, 'clearanceDeg')) * Math.cos(deg(o, 'helixDeg'));
    const landW = o.landMm == null ? Infinity : o.landMm, side = new Float32Array(S.NA * S.NZ), half = .5 * S.R * S.dA;
    let offLand = 0;
    for (let i = 0; i < S.NZ; i++) {
      const z = (i + .5) * S.dz, cols = [], vbT = new Map();
      for (let j = 0; j < S.NA; j++) {
        const k = i * S.NA + j, c = S.cls[k];
        if (c === 3) side[k] = -(S.depth ? S.depth[k] : 0);
        else if (c === 2) {
          const col = look ? look((j + .5) * S.dA, z) : {tooth: 0, s: 0};
          if (col.s >= 0 && col.s <= landW) { cols.push([k, col.tooth, col.s]); vbT.set(col.tooth, Math.max(vbT.get(col.tooth) || 0, col.s + half)); } else offLand++;
        }
      }
      for (const [k, t, s] of cols) side[k] = -Math.max(0, vbT.get(t) - s) * ta;
    }
    const end = new Float32Array(E.N * E.N);
    if (E.depth) for (let k = 0; k < end.length; k++) if (E.cls[k] === 3) end[k] = -E.depth[k];
    let min = 0; for (const a of [side, end]) for (let k = 0; k < a.length; k++) if (a[k] < min) min = a[k];
    return {side, end, NA: S.NA, NZ: S.NZ, dA: S.dA, dz: S.dz, R: S.R, sideCell: S.cellArea, N: E.N, cell: E.cell, endCell: E.cellArea, offLand, minMm: min};
  }
  function devAt(dev, x, y, z, part) {
    if (part === 'end') {
      const xi = Math.floor((x + dev.R) / dev.cell), yi = Math.floor((y + dev.R) / dev.cell);
      return xi < 0 || yi < 0 || xi >= dev.N || yi >= dev.N ? 0 : dev.end[yi * dev.N + xi];
    }
    if (z < 0 || z >= dev.NZ * dev.dz) return 0;
    let a = Math.atan2(y, x) % TAU; if (a < 0) a += TAU;
    return dev.side[Math.min(dev.NZ - 1, Math.floor(z / dev.dz)) * dev.NA + Math.floor(a / dev.dA) % dev.NA];
  }
  function volumeStats(dev, tolUm = DEFAULTS.devTolUm, filter) {
    const tol = tolUm / 1000; let dMin = 0, dMax = 0, s = 0, n = 0, Vv = 0, Vp = 0, Vdv = 0, Vdp = 0, area = 0;
    const add = (d, A) => {
      if (!d) return; n++; s += d; area += A;
      if (d < 0) { dMin = Math.min(dMin, d); Vv += -d * A; if (-d > tol) Vdv += (-d - tol) * A; } else { dMax = Math.max(dMax, d); Vp += d * A; if (d > tol) Vdp += (d - tol) * A; }
    };
    for (let k = 0; k < dev.side.length; k++) if (!filter || filter.side(k)) add(dev.side[k], dev.sideCell);
    for (let k = 0; k < dev.end.length; k++) if (!filter || filter.end(k)) add(dev.end[k], dev.endCell);
    return {DminUm: r2(dMin * 1000), DmaxUm: r2(dMax * 1000), DmeanUm: r2(n ? s / n * 1000 : 0), VvMm3: r4(Vv), VpMm3: r4(Vp), VdvMm3: r4(Vdv), VdpMm3: r4(Vdp), areaMm2: r4(area), tolUm};
  }
  const STAT_ROWS = [['Dmin', 'DminUm', 'µm', '공칭면 아래 최대 편차'], ['Dmean', 'DmeanUm', 'µm', '편차 영역 평균'], ['Vv', 'VvMm3', 'mm³', '공칭면 아래 체적 (마모 + 치핑)'],
    ['Vp', 'VpMm3', 'mm³', '공칭면 위 체적 (응착 두께 미측정 → 0)'], ['Vdv', 'VdvMm3', 'mm³', '허용 편차 초과 오목 체적'], ['A', 'areaMm2', 'mm²', '편차 영역 면적']];
  function perFace(dev, faces, azSign = -1, tolUm) {
    return faces.map(f => {
      if (f.kind === 'top' || /^(top|end)$/i.test(f.face)) return Object.assign({face: f.face, kind: 'top'}, volumeStats(dev, tolUm, {side: () => false, end: () => true}));
      const ac = azSign * f.angleDeg * DEG, lim = 75 * DEG;
      return Object.assign({face: f.face, kind: 'side', angleDeg: f.angleDeg}, volumeStats(dev, tolUm, {side: k => Math.abs(wrap(azSign * ((k % dev.NA + .5) * dev.dA - ac))) < lim, end: () => false}));
    });
  }

  // ---------- edge section normal to the cutting edge ----------
  // frame (mm): edge at (0,0), x = cutting direction, y = radial outward; rake face leans back by g, clearance face drops by a.
  // worn = flank land of width VB parallel to the cutting direction. The removed corner is the triangle edge / land ends;
  // equivalent edge radius = radius of the circle inscribed in that triangle (tangent to rake face, clearance face and land).
  function edgeSection(vbMm, o = {}) {
    const a = deg(o, 'clearanceDeg'), g = deg(o, 'rakeDeg'), Lc = o.lenMm || Math.max(.1, 2.5 * vbMm), h = vbMm * Math.tan(a);
    const rake = t => [-t * Math.sin(g), -t * Math.cos(g)], clr = t => [-t * Math.cos(a), -t * Math.sin(a)];
    const nominal = [rake(Lc), [0, 0], clr(Lc)], tR = h / Math.cos(g), tC = vbMm / Math.cos(a);
    const worn = vbMm > 0 ? [rake(Lc), rake(tR), clr(tC), clr(Lc)] : nominal.slice();
    const base = Math.max(0, vbMm - h * Math.tan(g)), area = .5 * base * h, per = tR + tC + base;
    const rEq = per > 0 ? 2 * area / per : 0;
    // incircle centre: weighted by the opposite side lengths
    const P0 = [0, 0], P1 = rake(tR), P2 = clr(tC), w0 = base, w1 = tC, w2 = tR, ws = w0 + w1 + w2 || 1;
    const centre = [(w0 * P0[0] + w1 * P1[0] + w2 * P2[0]) / ws, (w0 * P0[1] + w1 * P1[1] + w2 * P2[1]) / ws];
    return {nominal, worn, recessionUm: r2(h * 1000), landUm: r2(tC * 1000), rakeLenUm: r2(tR * 1000), areaUm2: r2(area * 1e6),
      edgeRadiusUm: r2(rEq * 1000), centre, wedgeDeg: r2(90 - (a + g) / DEG)};
  }

  // ---------- per flute ----------
  // perTooth = map3d evaluate().perTooth (VBmax from the mapped flank cells); end cells go to the tooth whose end edge leads them
  function perFlute(dev, atlas, look, layout, perTooth, o = {}) {
    const k = perTooth.length, S = atlas.side, E = atlas.end;
    const out = Array.from({length: k}, (_, t) => ({flute: t + 1, wornAreaMm2: 0, endAreaMm2: 0, volumeMm3: 0, chipVolumeMm3: 0, DminUm: 0, chipDepthUm: 0}));
    for (let i = 0; i < S.NZ; i++) for (let j = 0; j < S.NA; j++) {
      const q = i * S.NA + j, d = dev.side[q], c = S.cls[q];
      if (!(d < 0) && c !== 2 && c !== 3) continue;
      const t = look ? Math.max(0, Math.min(k - 1, look((j + .5) * S.dA, (i + .5) * S.dz).tooth | 0)) : 0, F = out[t];
      F.wornAreaMm2 += S.cellArea;
      if (d < 0) { F.volumeMm3 += -d * S.cellArea; F.DminUm = Math.min(F.DminUm, d * 1000); }
      if (c === 3) { F.chipVolumeMm3 += -d * S.cellArea; F.chipDepthUm = Math.max(F.chipDepthUm, -d * 1000); }
    }
    if (E && E.has !== false && layout) {
      const lookEnd = look && o.lookEnd ? o.lookEnd : null;
      for (let yi = 0; yi < E.N; yi++) for (let xi = 0; xi < E.N; xi++) {
        const q = yi * E.N + xi, c = E.cls[q]; if (c !== 2 && c !== 3) continue;
        const X = -E.R + (xi + .5) * E.cell, Y = -E.R + (yi + .5) * E.cell, d = dev.end[q];
        const t = lookEnd ? Math.max(0, Math.min(k - 1, lookEnd(Math.atan2(Y, X), 0).tooth | 0)) : 0, F = out[t];
        F.endAreaMm2 += E.cellArea; F.wornAreaMm2 += E.cellArea;
        if (d < 0) { F.volumeMm3 += -d * E.cellArea; F.DminUm = Math.min(F.DminUm, d * 1000); }
        if (c === 3) { F.chipVolumeMm3 += -d * E.cellArea; F.chipDepthUm = Math.max(F.chipDepthUm, -d * 1000); }
      }
    }
    return out.map((F, t) => {
      const vb = perTooth[t] ? perTooth[t].vbMaxMm || 0 : 0, sec = edgeSection(vb, o);
      return {flute: F.flute, vbMaxUm: r2(vb * 1000), edgeRadiusUm: sec.edgeRadiusUm, recessionUm: sec.recessionUm, wornAreaMm2: r4(F.wornAreaMm2), endAreaMm2: r4(F.endAreaMm2),
        volumeMm3: r6(F.volumeMm3), chipVolumeMm3: r6(F.chipVolumeMm3), DminUm: r2(F.DminUm), chipDepthUm: r2(F.chipDepthUm), section: sec};
    });
  }

  // ---------- chips ----------
  function chips(atlas, look, o = {}) {
    const out = [], cb = Math.cos(deg(o, 'helixDeg'));
    const scan = (W, H, cls, depth, cellA, wrapX, info) => {
      const seen = new Uint8Array(W * H);
      for (let s = 0; s < W * H; s++) if (cls[s] === 3 && !seen[s]) {
        const st = [s], cells = []; seen[s] = 1;
        while (st.length) {
          const k = st.pop(), x = k % W, y = (k - x) / W; cells.push(k);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let nx = x + dx; const ny = y + dy; if (wrapX) nx = (nx + W) % W; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx; if (cls[q] === 3 && !seen[q]) { seen[q] = 1; st.push(q); }
          }
        }
        let dMax = 0, vol = 0; for (const k of cells) { const d = depth ? depth[k] : 0; dMax = Math.max(dMax, d); vol += d * cellA; }
        out.push(Object.assign(info(cells, W), {cells: cells.length, areaMm2: r4(cells.length * cellA), maxDepthUm: r2(dMax * 1000), volumeMm3: r6(vol)}));
      }
    };
    const S = atlas.side;
    scan(S.NA, S.NZ, S.cls, S.depth, S.cellArea, true, (cells, W) => {
      const ys = cells.map(k => Math.floor(k / W)), z0 = Math.min(...ys) * S.dz, z1 = (Math.max(...ys) + 1) * S.dz, votes = new Map();
      if (look) for (const k of cells.slice(0, 400)) { const t = look((k % W + .5) * S.dA, (Math.floor(k / W) + .5) * S.dz).tooth; votes.set(t, (votes.get(t) || 0) + 1); }
      const tooth = votes.size ? [...votes.entries()].sort((p, q) => q[1] - p[1])[0][0] : null;
      return {where: 'side', tooth, z0Mm: r4(z0), z1Mm: r4(z1), lengthMm: r4((z1 - z0) / cb)};
    });
    const E = atlas.end;
    if (E && E.has) scan(E.N, E.N, E.cls, E.depth, E.cellArea, false, cells => {
      const rs = cells.map(k => Math.hypot(-E.R + (k % E.N + .5) * E.cell, -E.R + (Math.floor(k / E.N) + .5) * E.cell));
      return {where: 'end', tooth: null, z0Mm: 0, z1Mm: 0, lengthMm: r4(Math.max(...rs) - Math.min(...rs) + E.cell), rMaxMm: r4(Math.max(...rs))};
    });
    return out.sort((a, b) => b.volumeMm3 - a.volumeMm3 || b.areaMm2 - a.areaMm2).map((c, i) => Object.assign({n: i + 1}, c));
  }

  // ---------- nominal model + section profile ----------
  // polar table of the tip cross-section (outermost radius per azimuth bin), twisted with the helix along z
  function nominalRadius(layout, bins = 2048) {
    const cols = layout.cols, n = cols.length, tab = new Float32Array(bins);
    for (let m = 0; m < n; m++) {
      const p = cols[m], q = cols[(m + 1) % n];
      const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (TAU * layout.R / bins) * 2));
      for (let s = 0; s <= steps; s++) {
        const x = p.x + (q.x - p.x) * s / steps, y = p.y + (q.y - p.y) * s / steps, r = Math.hypot(x, y);
        let a = Math.atan2(y, x); if (a < 0) a += TAU;
        const b = Math.floor(a / TAU * bins) % bins; if (r > tab[b]) tab[b] = r;
      }
    }
    for (let b = 0; b < bins; b++) if (!tab[b]) tab[b] = tab[(b + bins - 1) % bins];
    const fl = layout.q.fluteLenMm;
    return (theta, z) => {
      if (z > fl + layout.q.runoutMm) return layout.q.shankDiaMm / 2;
      let a = (theta - layout.tanH * Math.min(z, layout.zTwistMax)) % TAU; if (a < 0) a += TAU;
      const f = a / TAU * bins, i = Math.floor(f) % bins, t = f - Math.floor(f);
      return tab[i] + (tab[(i + 1) % bins] - tab[i]) * t;
    };
  }
  // o = {p0, p1 (tool frame [x,y,z] mm), part 'side'|'end', n, rNom(theta,z), endZ(x,y), dev}
  // side: height = radius (mm) along the chord's azimuth / z; end: height = axial position of the end face (mm, tip = 0)
  function profile(o) {
    const n = o.n || 240, out = [];
    let dist = 0, prev = null;
    for (let i = 0; i < n; i++) {
      // side: straight in (azimuth, z) = a helix on the surface, the short way round; end: straight in (x, y)
      const t = i / (n - 1), z = o.p0[2] + (o.p1[2] - o.p0[2]) * t, th0 = Math.atan2(o.p0[1], o.p0[0]), th = th0 + wrap(Math.atan2(o.p1[1], o.p1[0]) - th0) * t;
      const x = o.part === 'end' ? o.p0[0] + (o.p1[0] - o.p0[0]) * t : Math.cos(th), y = o.part === 'end' ? o.p0[1] + (o.p1[1] - o.p0[1]) * t : Math.sin(th);
      let nom, d, P;
      if (o.part === 'end') {
        nom = o.endZ ? o.endZ(x, y) : 0; d = o.dev ? devAt(o.dev, x, y, 0, 'end') : 0; P = [x, y, nom];
      } else {
        nom = o.rNom(th, z); d = o.dev ? devAt(o.dev, Math.cos(th), Math.sin(th), z, 'side') : 0; P = [nom * Math.cos(th), nom * Math.sin(th), z];
      }
      if (prev) dist += Math.hypot(P[0] - prev[0], P[1] - prev[1], P[2] - prev[2]);
      prev = P;
      // end face: deviation goes up into the tool (+z) -> measured axial = nominal - d
      out.push({sMm: r4(dist), nominalMm: r4(nom), measuredMm: r4(o.part === 'end' ? nom - d : nom + d), devUm: r2(d * 1000)});
    }
    const dv = out.map(p => p.devUm), iMin = dv.reduce((b, v, i) => v < dv[b] ? i : b, 0);
    return {part: o.part || 'side', points: out, lengthMm: r4(dist), devMinUm: r2(Math.min(0, ...dv)), sAtMinMm: out[iMin].sMm,
      heightRangeMm: r4(Math.max(...out.map(p => p.nominalMm)) - Math.min(...out.map(p => p.nominalMm)))};
  }

  // ---------- tolerance (pass / fail) ----------
  function tolerance(v, tol) {
    const t = Object.assign({}, DEFAULTS.tol, tol), row = (key, label, value, unit) => ({key, label, value, limit: t[key], unit, pass: value == null ? null : value <= t[key]});
    const rows = [row('devMaxUm', '|Dmin| 최대 편차', v.devMaxUm, 'µm'), row('chipDepthUm', '치핑 최대 깊이', v.chipDepthUm, 'µm'),
      row('vdvMm3', 'Vdv 허용 편차 초과 체적', v.vdvMm3, 'mm³'), row('wearVolumeMm3', '날당 최대 마모 체적', v.wearVolumeMm3, 'mm³')];
    const judged = rows.filter(r => r.pass != null);
    return {rows, pass: judged.length ? judged.every(r => r.pass) : null, failed: judged.filter(r => !r.pass).map(r => r.key)};
  }

  // ---------- tool life (wear volume per measurement) ----------
  const HKEY = 'tool3d.surface.history';
  function historyAll(store) { try { return JSON.parse(store.getItem(HKEY) || '{}') || {}; } catch (e) { return {}; } }
  const history = (store, id) => (historyAll(store)[id] || []).slice();
  function historyAdd(store, id, entry, max = 100) {
    const all = historyAll(store), list = (all[id] || []).concat([entry]).slice(-max); all[id] = list;
    try { store.setItem(HKEY, JSON.stringify(all)); } catch (e) { /* quota / private mode */ }
    return list;
  }
  // least squares y(key) vs x (cutting minutes when every entry has them, else the measurement index); x where y reaches limit
  function trend(list, limit, key = 'volumeMm3') {
    const p = list.filter(e => e && e[key] != null); if (p.length < 2) return null;
    const byTime = p.every(e => e.cutMin != null), x = p.map((e, i) => byTime ? +e.cutMin : i + 1), y = p.map(e => e[key]), mx = mean(x), my = mean(y);
    const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0); if (!sxx) return null;
    const slope = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx, icpt = my - slope * mx;
    const xLim = slope > 0 && limit ? (limit - icpt) / slope : null, last = x[x.length - 1];
    return {n: p.length, per: byTime ? 'min' : 'measurement', key, slope: r6(slope), intercept: r6(icpt), x, y,
      xAtLimit: xLim == null ? null : r2(xLim), remaining: xLim == null ? null : r2(Math.max(0, xLim - last))};
  }

  return {DEFAULTS, STAT_ROWS, deviation, devAt, volumeStats, perFace, edgeSection, perFlute, chips, nominalRadius, profile, tolerance,
    HKEY, history, historyAdd, trend, r2, r4};
});
