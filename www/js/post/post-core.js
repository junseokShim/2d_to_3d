/* Tool3D post-processing core: 3D deviation (worn vs nominal model), edge-defect profile and cross sections that
 * follow a measurement, computed from what Tool3D already has. Pure JS, no DOM: browser (window.Tool3D.postCore)
 * and Node (module.exports). The 2D views (reference-line VB, scale bar, statistics) live in js/metro (metro-vb.js).
 *
 * Inputs (all produced elsewhere, never modified here):
 *   metro rows  = Tool3D.metro evaluate() result per flute: rows {vb (mm, VB normal), A, B (band columns), dz (mm/row)},
 *                 tipMm, zones; F.edge ('a'|'b' = which band side is the cutting edge), F.strip {top, ppm, cx, R}
 *   map3d atlas = Tool3D.render.map.atlas (map3d-core evaluate()): side {NA, NZ, dA, dz, R, cellArea, cls, depth},
 *                 end {N, cell, R, cls, depth, inside, cellArea}; look = map3dCore.toothLookup(layout)
 * Depth model (photos have no height): a flank land of width VB removes a wedge, edge recession h = VB * tan(clearance),
 * depth behind the edge at arc distance s = (VB - s) * tan(clearance); chips take the map3d chip depth. Deviations are
 * negative below the nominal (reference) surface, in mm unless the name says Um.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.postCore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;
  const r4 = v => Math.round(v * 1e4) / 1e4, r2 = v => Math.round(v * 100) / 100;
  const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1)); };
  const quant = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y), i = (b.length - 1) * p, l = Math.floor(i); return b[l] + (b[Math.min(b.length - 1, l + 1)] - b[l]) * (i - l); };
  const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
  const DEFAULTS = {
    clearanceDeg: 8, rakeDeg: 8, helixDeg: 30,
    defectTolUm: 5,            // edge defects: a position is a defect when the edge lies this far below the reference
    devTolUm: 10,              // deviation volumes: Vdv / Vdp count the volume beyond this tolerance
    nVbLines: 5,               // VB dimension lines per flute (plus the maximum)
    magConstMm: 297,           // equivalent display magnification X ~= 297 mm / field-of-view width
    tol: {vbMaxMm: .3, ddMaxUm: 30, pdPct: 60, chipDepthUm: 50, vdvMm3: .005}
  };

  // ---------- scale bar, magnification, VB dimension lines, VB(u) statistics ----------
  // largest 1/2/2.5/5 x 10^n um bar that fits targetPx
  function scaleBar(pxPerMm, targetPx) {
    const ppu = pxPerMm / 1000; let best = null;
    for (let e = -1; e <= 5; e++) for (const m of [1, 2, 2.5, 5]) { const um = m * 10 ** e, px = um * ppu; if (px <= targetPx && (!best || um > best.um)) best = {um, px}; }
    if (!best) best = {um: .1, px: .1 * ppu};
    return {um: best.um, px: best.px, label: (best.um >= 1000 ? r2(best.um / 1000) + 'mm' : r2(best.um) + 'µm')};
  }
  const MAGS = [20, 30, 50, 80, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 2500, 3000, 5000];
  // equivalent display magnification of an image of widthPx at pxPerMm
  function magnification(pxPerMm, widthPx, magConstMm = DEFAULTS.magConstMm) {
    const fovMm = widthPx / pxPerMm, x = magConstMm / fovMm, sig = 10 ** (Math.floor(Math.log10(x)) - 1);
    const std = MAGS.find(m => Math.abs(x / m - 1) < .05), mag = std || Math.round(x / sig) * sig;   // standard lens steps when close
    return {fovMm: r4(fovMm), mag: r4(mag), umPerPx: r4(1000 / pxPerMm), label: 'X' + r4(mag)};
  }
  // arrows across the worn land on the rectified strip: n evenly spaced worn rows + the row of VBmax
  // rows = {vb, A, B, dz}; edge = 'a' | 'b'; top = strip row of the tip
  function vbLines(rows, edge, top, o = {}) {
    const n = o.n || DEFAULTS.nVbLines, cb = Math.cos((o.helixDeg == null ? DEFAULTS.helixDeg : o.helixDeg) * DEG), vb = rows.vb, worn = [];
    for (let r = 0; r < vb.length; r++) if (vb[r] > 0) worn.push(r);
    if (!worn.length) return [];
    const pick = new Set(), r0 = worn[0], r1 = worn[worn.length - 1];
    for (let i = 0; i < n; i++) { const t = r0 + (r1 - r0) * (i + .5) / n; pick.add(worn.reduce((b, r) => Math.abs(r - t) < Math.abs(b - t) ? r : b, worn[0])); }
    const rMax = worn.reduce((b, r) => vb[r] > vb[b] ? r : b, worn[0]); pick.add(rMax);
    return [...pick].sort((a, b) => a - b).map((r, i) => {
      const xa = rows.A[r] - .5, xb = rows.B[r] + .5;
      return {n: i + 1, r, y: top + r + .5, xEdge: edge === 'a' ? xa : xb, xFront: edge === 'a' ? xb : xa, vbUm: r2(vb[r] * 1000),
        zMm: r4((r + .5) * rows.dz), uMm: r4((r + .5) * rows.dz / cb), isMax: r === rMax};
    });
  }
  // VB along the cutting edge: u = z / cos(helix) = length along the helical edge (microscopes measure along the edge)
  function vbProfileU(rows, helixDeg) {
    const cb = Math.cos((helixDeg == null ? DEFAULTS.helixDeg : helixDeg) * DEG), out = [];
    for (let r = 0; r < rows.vb.length; r++) out.push({uMm: r4((r + .5) * rows.dz / cb), zMm: r4((r + .5) * rows.dz), vbUm: r2(rows.vb[r] * 1000)});
    return out;
  }
  function vbStats(profile) {
    const v = profile.map(p => p.vbUm), w = v.filter(x => x > 0), du = profile.length > 1 ? (profile[profile.length - 1].uMm - profile[0].uMm) / (profile.length - 1) : 0;
    const iMax = v.reduce((b, x, i) => x > v[b] ? i : b, 0);
    return {n: w.length, lengthMm: r4(profile.length * du), wornMm: r4(w.length * du), wornPct: r2(100 * w.length / (v.length || 1)),
      maxUm: r2(Math.max(0, ...v)), uAtMaxMm: profile.length ? profile[iMax].uMm : null, minUm: r2(w.length ? Math.min(...w) : 0), meanUm: r2(mean(w)),
      sdUm: r2(sd(w)), medianUm: r2(quant(w, .5)), p25Um: r2(quant(w, .25)), p75Um: r2(quant(w, .75))};
  }

  // ---------- edge defects: profile along the edge, defects, cross sections ----------
  // per row of one flute: D (um, <= 0 below the nominal edge), removed cross-section area (um^2), Ldc / Ldr (um)
  // flank land VB -> h = VB tan(a), area = VB h / 2, Ldc = VB / cos(a), Ldr = h / cos(g); corner damage (tipMm) replaces the
  // rows z < min(corner zone, tip depth) with D = -tip (the missing corner, measured by js/wear), area ~ tip^2 / 2
  function edgeProfile(rows, o = {}) {
    const a = (o.clearanceDeg == null ? DEFAULTS.clearanceDeg : o.clearanceDeg) * DEG, g = (o.rakeDeg == null ? DEFAULTS.rakeDeg : o.rakeDeg) * DEG;
    const cb = Math.cos((o.helixDeg == null ? DEFAULTS.helixDeg : o.helixDeg) * DEG), ta = Math.tan(a), n = rows.vb.length;
    const tip = (o.tipMm || 0) * 1000, zTip = Math.min(o.cornerMm == null ? Infinity : o.cornerMm, o.tipMm || 0);
    const P = {du: rows.dz / cb * 1000, u: [], D: [], area: [], ldc: [], ldr: [], vb: [], corner: []};
    for (let r = 0; r < n; r++) {
      const vb = rows.vb[r] * 1000, h = vb * ta, z = (r + .5) * rows.dz, isTip = tip > 0 && z < zTip && tip > h;
      P.u.push((r + .5) * P.du); P.vb.push(vb); P.corner.push(isTip ? 1 : 0);
      P.D.push(-(isTip ? tip : h)); P.area.push(isTip ? tip * tip / 2 : vb * h / 2);
      P.ldc.push(isTip ? tip : vb / Math.cos(a)); P.ldr.push(isTip ? tip : h / Math.cos(g));
    }
    return P;
  }
  // edge-defect parameters from an edgeProfile; tolUm = defect threshold below the reference
  function edgeDefects(P, tolUm = DEFAULTS.defectTolUm) {
    const n = P.D.length, L = n * P.du, defects = [];
    let cur = null;
    for (let i = 0; i <= n; i++) {
      const on = i < n && P.D[i] < -tolUm;
      if (on && !cur) cur = {i0: i, i1: i};
      else if (on) cur.i1 = i;
      else if (cur) { defects.push(cur); cur = null; }
    }
    const rowsIn = [];
    const D = defects.map((d, k) => {
      const idx = []; for (let i = d.i0; i <= d.i1; i++) { idx.push(i); rowsIn.push(i); }
      const iMin = idx.reduce((b, i) => P.D[i] < P.D[b] ? i : b, idx[0]);
      return {n: k + 1, u0Um: r2(d.i0 * P.du), u1Um: r2((d.i1 + 1) * P.du), LUm: r2(idx.length * P.du), DdUm: r2(P.D[iMin]), uAtDdUm: r2(P.u[iMin]),
        VdUm3: Math.round(idx.reduce((s, i) => s + P.area[i] * P.du, 0)), LdcUm: r2(Math.max(...idx.map(i => P.ldc[i]))), LdrUm: r2(Math.max(...idx.map(i => P.ldr[i]))),
        corner: idx.some(i => P.corner[i])};
    });
    const pos = rowsIn, sumL = D.reduce((s, d) => s + d.LUm, 0), sumV = D.reduce((s, d) => s + d.VdUm3, 0);
    const iMin = pos.length ? pos.reduce((b, i) => P.D[i] < P.D[b] ? i : b, pos[0]) : null;
    return {
      tolUm, defects: D,
      Nd: D.length, L: r2(L), Pd: r2(L ? 100 * sumL / L : 0), Vdrel: r2(L ? sumV / L : 0),
      Ddmax: r2(pos.length ? P.D[iMin] : 0), Ddmean: r2(mean(pos.map(i => P.D[i]))), uAtDdmax: iMin == null ? null : r2(P.u[iMin]),
      Vdmax: Math.max(0, ...D.map(d => d.VdUm3)), Vdmean: Math.round(mean(D.map(d => d.VdUm3))),
      Ldmax: r2(Math.max(0, ...D.map(d => d.LUm))), Ldmean: r2(mean(D.map(d => d.LUm))),
      Ldcmax: r2(Math.max(0, ...pos.map(i => P.ldc[i]))), Ldcmean: r2(mean(pos.map(i => P.ldc[i]))),
      Ldrmax: r2(Math.max(0, ...pos.map(i => P.ldr[i]))), Ldrmean: r2(mean(pos.map(i => P.ldr[i])))
    };
  }
  // one post-processing design with wear-post.js (Tool3D.wear.post -> wearResult.post[flute]): the per-side edge metrics
  // measured on the segmented land (Nd, L, Pd, Dd, Ld, Ldc; reference-line VB + edge recession) replace the wedge-model
  // values; what one photo cannot give (Ldr, Vd*, Vdrel: rake face, heights) stays from the wedge model.
  // Returns an edgeDefects-shaped object (Dd negative = below the reference, um) with source / measured / refLine.
  // The two input groups are the wear engine's per-side keys (wear-post.js): edge deviation and reference line.
  const EDGE_MEASURED = ['Nd', 'L', 'Pd', 'Ddmax', 'Ddmean', 'Ldmax', 'Ldmean', 'Ldcmax', 'Ldcmean'];
  function mergeEdge(eq, wp) {
    if (!wp || !wp.edgeDev) return Object.assign({}, eq, {source: 'model', measured: [], refLine: null});
    const A = wp.edgeDev, K = wp.refLine || null, um = v => v == null ? null : r2(1000 * v), neg = v => v ? -um(v) : 0;
    const defects = (A.defects || []).map((d, k) => ({n: k + 1, u0Um: um(d.fromMm), u1Um: um(d.toMm), LUm: um(d.lengthMm), DdUm: neg(d.depthMaxMm), uAtDdUm: um(d.atMm),
      VdUm3: null, LdcUm: um(d.clearanceLengthMm), LdrUm: null, corner: false}));
    return Object.assign({}, eq, {source: 'wear-post', measured: EDGE_MEASURED.slice(), tolUm: um(A.toleranceMm), defects, modelDefects: eq.defects,
      Nd: A.Nd, L: um(A.L), Pd: r2(A.Pd), Ddmax: neg(A.Ddmax), Ddmean: neg(A.Ddmean), uAtDdmax: defects.length ? defects.reduce((b, d) => d.DdUm < b.DdUm ? d : b).uAtDdUm : null,
      Ldmax: um(A.Ldmax), Ldmean: um(A.Ldmean), Ldcmax: um(A.Ldcmax), Ldcmean: um(A.Ldcmean), VBmaxUm: um(A.VBmax), VBmeanUm: um(A.VBmean),
      refLine: K && {VBmaxUm: um(K.VBmax), VBmaxAtUm: um(K.VBmaxAtMm), VBmeanUm: um(K.VBmean), recessionUm: um(K.edgeRecessionMax), recessionAtUm: um(K.edgeRecessionAtMm), referenceMm: K.referenceMm, angleDeg: K.angleDeg},
      edgeSide: wp.edgeSide || null, lengthMm: wp.lengthMm == null ? null : wp.lengthMm});
  }
  // edge-defect result-table rows: [name, value, unit, Korean description]
  const EDGE_ROWS = [['Nd', '', '결함 개수'], ['L', 'µm', '평가 길이 (절삭날 따라)'], ['Pd', '%', '결함이 있는 날 길이 비율 ΣLi / L'], ['Vdrel', 'µm²', '길이당 결함 체적'],
    ['Ddmax', 'µm', '프로파일 최대 결함 깊이'], ['Ddmean', 'µm', '프로파일 평균 결함 깊이'], ['Vdmax', 'µm³', '최대 결함 체적'], ['Vdmean', 'µm³', '평균 결함 체적'],
    ['Ldmax', 'µm', '프로파일 따라 최대 결함 길이'], ['Ldmean', 'µm', '프로파일 따라 평균 결함 길이'], ['Ldcmax', 'µm', '여유면 최대 결함 길이'], ['Ldcmean', 'µm', '여유면 평균 결함 길이'],
    ['Ldrmax', 'µm', '경사면 최대 결함 길이'], ['Ldrmean', 'µm', '경사면 평균 결함 길이']];

  // cross section normal to the edge at one position: nominal wedge vs worn (flank land parallel to the cutting direction)
  // frame (mm): edge at (0,0), x = cutting direction, y = radial outward; rake face leans back by g, clearance face drops by a
  function wedgeSection(vbMm, o = {}) {
    const a = (o.clearanceDeg == null ? DEFAULTS.clearanceDeg : o.clearanceDeg) * DEG, g = (o.rakeDeg == null ? DEFAULTS.rakeDeg : o.rakeDeg) * DEG;
    const Lc = o.lenMm || Math.max(.1, 2.5 * vbMm), Lr = Lc, h = vbMm * Math.tan(a);
    const rake = t => [-t * Math.sin(g), -t * Math.cos(g)], clr = t => [-t * Math.cos(a), -t * Math.sin(a)];
    const nominal = [rake(Lr), [0, 0], clr(Lc)];
    const tR = h / Math.cos(g), worn = vbMm > 0 ? [rake(Lr), rake(tR), [-vbMm, -h], clr(Lc)] : nominal.slice();
    return {nominal, worn, hMm: r4(h), LdcMm: r4(vbMm / Math.cos(a)), LdrMm: r4(tR), areaMm2: r4(vbMm * h / 2), wedgeDeg: r2(90 - (a + g) / DEG)};
  }

  // ---------- deviation worn vs nominal on the model ----------
  // side / end deviation fields (mm, <= 0 = material below the nominal surface) from the map3d atlas + the tooth lookup
  function deviationAtlas(atlas, look, o = {}) {
    // s is arc length behind the edge on the envelope; normal to the helical edge it is s * cos(helix) (VB = W cos(helix))
    const S = atlas.side, E = atlas.end, ta = Math.tan((o.clearanceDeg == null ? DEFAULTS.clearanceDeg : o.clearanceDeg) * DEG) * Math.cos((o.helixDeg == null ? DEFAULTS.helixDeg : o.helixDeg) * DEG);
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
    return {side, end, NA: S.NA, NZ: S.NZ, dA: S.dA, dz: S.dz, R: S.R, sideCell: S.cellArea, N: E.N, cell: E.cell, endCell: E.cellArea, offLand};
  }
  // deviation at a model point (tool frame, mm): side atlas by azimuth / z, end atlas by x / y
  function devAt(dev, x, y, z, part) {
    if (part === 'end') {
      const xi = Math.floor((x + dev.R) / dev.cell), yi = Math.floor((y + dev.R) / dev.cell);
      return xi < 0 || yi < 0 || xi >= dev.N || yi >= dev.N ? 0 : dev.end[yi * dev.N + xi];
    }
    if (z < 0 || z >= dev.NZ * dev.dz) return 0;
    let a = Math.atan2(y, x) % TAU; if (a < 0) a += TAU;
    return dev.side[Math.min(dev.NZ - 1, Math.floor(z / dev.dz)) * dev.NA + Math.floor(a / dev.dA) % dev.NA];
  }
  // deviation parameters; cells = {side|end} restricts to a subset (per face)
  function devStats(dev, tolUm = DEFAULTS.devTolUm, filter) {
    const tol = tolUm / 1000; let dMin = 0, dMax = 0, s = 0, n = 0, Vv = 0, Vp = 0, Vdv = 0, Vdp = 0, area = 0;
    const add = (d, A) => {
      if (!d) return; n++; s += d; area += A;
      if (d < 0) { dMin = Math.min(dMin, d); Vv += -d * A; if (-d > tol) Vdv += (-d - tol) * A; } else { dMax = Math.max(dMax, d); Vp += d * A; if (d > tol) Vdp += (d - tol) * A; }
    };
    for (let k = 0; k < dev.side.length; k++) if (!filter || filter.side(k)) add(dev.side[k], dev.sideCell);
    for (let k = 0; k < dev.end.length; k++) if (!filter || filter.end(k)) add(dev.end[k], dev.endCell);
    return {DminUm: r2(dMin * 1000), DmaxUm: r2(dMax * 1000), DmeanUm: r2(n ? s / n * 1000 : 0), VvMm3: r4(Vv), VpMm3: r4(Vp), VdvMm3: r4(Vdv), VdpMm3: r4(Vdp), areaMm2: r4(area), tolUm};
  }
  const DEV_ROWS = [['Dmin', 'DminUm', 'µm', '기준면 아래 최대 편차'], ['Dmax', 'DmaxUm', 'µm', '기준면 위 최대 편차 (응착 두께 미측정 → 0)'], ['Dmean', 'DmeanUm', 'µm', '편차 영역 평균 편차'],
    ['Vp', 'VpMm3', 'mm³', '기준면 위 볼록 체적'], ['Vv', 'VvMm3', 'mm³', '기준면 아래 오목 체적 (마모+치핑)'], ['Vdp', 'VdpMm3', 'mm³', '공차 초과 볼록 결함 체적'], ['Vdv', 'VdvMm3', 'mm³', '공차 초과 오목 결함 체적']];
  // per photographed face: cells that face saw (|view angle| < 75 deg), same convention as map3d (azSign)
  function perFace(dev, faces, azSign = -1, tolUm) {
    return faces.map(f => {
      if (f.kind === 'top' || /^(top|end)$/i.test(f.face)) return Object.assign({face: f.face, kind: 'top'}, devStats(dev, tolUm, {side: () => false, end: () => true}));
      const ac = azSign * f.angleDeg * DEG, lim = 75 * DEG;
      return Object.assign({face: f.face, kind: 'side', angleDeg: f.angleDeg}, devStats(dev, tolUm, {side: k => Math.abs(wrap(azSign * ((k % dev.NA + .5) * dev.dA - ac))) < lim, end: () => false}));
    });
  }
  // connected chip regions (4-neighbour, azimuth wraps) on the side atlas, plus the end atlas
  function chipList(atlas, look, o = {}) {
    const out = [], cb = Math.cos((o.helixDeg == null ? DEFAULTS.helixDeg : o.helixDeg) * DEG);
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
        out.push(Object.assign(info(cells, W), {cells: cells.length, areaMm2: r4(cells.length * cellA), maxDepthUm: r2(dMax * 1000), volumeMm3: r4(vol)}));
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

  // ---------- tolerances (pass / fail) ----------
  function tolerance(v, tol) {
    const t = Object.assign({}, DEFAULTS.tol, tol), rows = [
      {key: 'vbMaxMm', label: 'VBmax (ISO 8688-2)', value: v.vbMaxMm, limit: t.vbMaxMm, unit: 'mm', pass: v.vbMaxMm == null ? null : v.vbMaxMm <= t.vbMaxMm},
      {key: 'ddMaxUm', label: '|Ddmax| 절삭날 결함 깊이', value: v.ddMaxUm == null ? null : Math.abs(v.ddMaxUm), limit: t.ddMaxUm, unit: 'µm', pass: v.ddMaxUm == null ? null : Math.abs(v.ddMaxUm) <= t.ddMaxUm},
      {key: 'pdPct', label: 'Pd 결함 길이 비율', value: v.pdPct, limit: t.pdPct, unit: '%', pass: v.pdPct == null ? null : v.pdPct <= t.pdPct},
      {key: 'chipDepthUm', label: '치핑 최대 깊이', value: v.chipDepthUm, limit: t.chipDepthUm, unit: 'µm', pass: v.chipDepthUm == null ? null : v.chipDepthUm <= t.chipDepthUm},
      {key: 'vdvMm3', label: 'Vdv 공차 초과 결함 체적', value: v.vdvMm3, limit: t.vdvMm3, unit: 'mm³', pass: v.vdvMm3 == null ? null : v.vdvMm3 <= t.vdvMm3}];
    const judged = rows.filter(r => r.pass != null);
    return {rows, pass: judged.length ? judged.every(r => r.pass) : null, failed: judged.filter(r => !r.pass).map(r => r.key)};
  }

  // ---------- tool-life trend (history) ----------
  const HKEY = 'tool3d.post.history';
  function historyAll(store) { try { return JSON.parse(store.getItem(HKEY) || '{}') || {}; } catch (e) { return {}; } }
  const history = (store, id) => (historyAll(store)[id] || []).slice();
  function historyAdd(store, id, entry, max = 100) {
    const all = historyAll(store), list = (all[id] || []).concat([entry]).slice(-max); all[id] = list;
    try { store.setItem(HKEY, JSON.stringify(all)); } catch (e) { /* quota / private mode */ }
    return list;
  }
  // least squares VBmax vs x (cutting minutes when every entry has them, else the measurement index);
  // predicted x where VBmax reaches the limit and how many more units that is from the last entry
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

  // ---------- export ----------
  function csvRows(R) {
    const L = [], esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }, row = a => L.push(a.map(esc).join(','));
    row(['Tool3D post-processing (3D deviation / edge defects)']); row(['model', 'depths from the wedge model (VB tan clearance) and map3d chip depth; photos give no height']);
    row(['clearance_deg', R.o.clearanceDeg, 'rake_deg', R.o.rakeDeg, 'helix_deg', R.o.helixDeg, 'defect_tol_um', R.o.defectTolUm, 'dev_tol_um', R.o.devTolUm]);
    row([]); row(['edge_defects_flute'].concat(EDGE_ROWS.map(r => r[0] + (r[1] ? '_' + r[1].replace('µ', 'u').replace('²', '2').replace('³', '3') : ''))).concat(['source']));
    R.flutes.forEach(f => f && row(['F' + (f.i + 1)].concat(EDGE_ROWS.map(r => f.eq[r[0]])).concat([f.eq.source || 'model'])));
    if (R.flutes.some(f => f && f.eq.refLine)) {
      row([]); row(['refline_flute', 'VBmax_um', 'VBmax_at_um', 'VBmean_um', 'edge_recession_um', 'recession_at_um', 'source']);
      R.flutes.forEach(f => f && f.eq.refLine && row(['F' + (f.i + 1), f.eq.refLine.VBmaxUm, f.eq.refLine.VBmaxAtUm, f.eq.refLine.VBmeanUm, f.eq.refLine.recessionUm, f.eq.refLine.recessionAtUm, 'wear-post']));
    }
    row([]); row(['defect_flute', 'n', 'u0_um', 'u1_um', 'L_um', 'Dd_um', 'Vd_um3', 'Ldc_um', 'Ldr_um', 'corner']);
    R.flutes.forEach(f => f && f.eq.defects.forEach(d => row(['F' + (f.i + 1), d.n, d.u0Um, d.u1Um, d.LUm, d.DdUm, d.VdUm3, d.LdcUm, d.LdrUm, d.corner ? 1 : 0])));
    if (R.devStats) {
      row([]); row(['deviation'].concat(DEV_ROWS.map(r => r[0] + '_' + r[2].replace('µ', 'u').replace('³', '3'))).concat(['VBmax_mm', 'VBmean_mm']));
      row(['model'].concat(DEV_ROWS.map(r => R.devStats[r[1]])).concat([R.vbMaxMm, R.vbMeanMm]));
      R.faces.forEach(f => row([f.face].concat(DEV_ROWS.map(r => f[r[1]]))));
    }
    if (R.chips && R.chips.length) { row([]); row(['chip', 'where', 'tooth', 'z0_mm', 'z1_mm', 'length_mm', 'area_mm2', 'max_depth_um', 'volume_mm3']); R.chips.forEach(c => row([c.n, c.where, c.tooth == null ? '' : c.tooth + 1, c.z0Mm, c.z1Mm, c.lengthMm, c.areaMm2, c.maxDepthUm, c.volumeMm3])); }
    row([]); row(['tolerance', 'value', 'limit', 'unit', 'pass']); R.tol.rows.forEach(t => row([t.key, t.value, t.limit, t.unit, t.pass == null ? '' : t.pass ? 'PASS' : 'FAIL']));
    row(['overall', '', '', '', R.tol.pass == null ? '' : R.tol.pass ? 'PASS' : 'FAIL']);
    if (R.trend) { row([]); row(['trend_per', R.trend.per, 'slope_mm', R.trend.slope, 'at_limit', R.trend.xAtLimit, 'remaining', R.trend.remaining]); }
    return L.join('\r\n') + '\r\n';
  }

  return {DEFAULTS, EDGE_ROWS, DEV_ROWS, scaleBar, magnification, vbLines, vbProfileU, vbStats, edgeProfile, edgeDefects, wedgeSection,
    mergeEdge, EDGE_MEASURED, deviationAtlas, devAt, devStats, perFace, chipList, tolerance, HKEY, history, historyAdd, trend, csvRows, r4, r2};
});
