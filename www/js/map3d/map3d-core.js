/* Tool3D map3d core: per-face wear segmentation -> parametric end mill (areas, volumes, chip depth).
 * Pure JS, no DOM. Browser: window.Tool3D.map3dCore. Node: module.exports.
 *
 * Input faces (board contract window.Tool3D.faceSeg, extended):
 *   {face:'side1'..|'top', angleDeg, w, h, mask:Uint8Array(w*h), pxPerMm, toTool(x,y), areasMm2?}
 *   mask classes: 0 background, 1 tool, 2 flank wear, 3 chipping/breakage, 4 adhesion/BUE.
 *   Optional extension fields used when present (else recovered by probing toTool):
 *     side: axisX (image column of the tool axis), tipY (image row of the tip, z = 0)
 *     top:  cx, cy (image centre of the end face)
 * Tool frame = render frame (endmill-geometry.js): z = axis, tip z = 0, shank +z, mm.
 * Side face at angleDeg looks at model azimuth ac = azSign * angleDeg; image column offset u (mm, +right)
 * lands on the envelope cylinder at azimuth ac + azSign * asin(u / R); image row -> z = (y + .5 - tipY) / ppm.
 * azSign = -1 matches index.html (its v0.1 azimuth runs left-handed, render gets phaseRad = -ph0).
 * Top face: camera on the axis looking at the tip (+z); image right = -X, image down = -Y, then rotated by
 * azSign * angleDeg about z.
 *
 * Mapping = inverse sampling on two atlases, so areas are true surface areas and overlaps blend:
 *   side atlas (azimuth x z, envelope cylinder r = R): every face that sees a cell (|phi| < 75 deg) votes its mask
 *   class with weight cos(phi); class probability = votes / total weight; a cell takes the class with p >= .5.
 *   end atlas (X x Y, r <= R - corner radius; the corner itself belongs to the side atlas): top face only.
 * Chipping depth (not observable in a face-on mask) = distance to the chip boundary (half-lens scoop), capped;
 * chip volume = sum cell area * depth. Flank wear volume per tooth and z row = 0.5 VB^2 tan(clearance) dz / cos(helix)
 * (same wedge model as js/wear), VB = arc extent of flank-class cells behind the cutting edge * cos(helix).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.map3dCore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;
  const CLS = {FLANK: 2, CHIP: 3, ADH: 4};
  const NAMES = {2: 'flank', 3: 'chip', 4: 'adhesion'};
  const PHI_MAX = 75 * DEG;
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

  // ---------- faces ----------
  function sideToTool(f, R, azSign) {
    const ac = azSign * f.angleDeg * DEG;
    return (x, y) => {
      const u = (x + .5 - f.axisX) / f.pxPerMm;
      if (Math.abs(u) > R) return null;
      const a = ac + azSign * Math.asin(u / R);
      return [R * Math.cos(a), R * Math.sin(a), (y + .5 - f.tipY) / f.pxPerMm];
    };
  }
  function topToTool(f, azSign) {
    const t = azSign * f.angleDeg * DEG, c = Math.cos(t), s = Math.sin(t);
    return (x, y) => {
      const X0 = -(x + .5 - f.cx) / f.pxPerMm, Y0 = -(y + .5 - f.cy) / f.pxPerMm;
      return [c * X0 - s * Y0, s * X0 + c * Y0, 0];
    };
  }

  // Normalise a contract entry: fills axisX/tipY or cx/cy (probing toTool when absent), toTool, kind.
  function normalizeFace(f, R, azSign = -1) {
    const kind = /^top|end/i.test(f.face || '') ? 'top' : 'side';
    const g = Object.assign({}, f, {kind, angleDeg: +f.angleDeg || 0});
    if (!(g.pxPerMm > 0)) throw new Error(`map3d: face ${f.face} has no pxPerMm`);
    if (kind === 'side' && !(Number.isFinite(g.axisX) && Number.isFinite(g.tipY))) {
      if (typeof f.toTool !== 'function') throw new Error(`map3d: face ${f.face} has neither axisX/tipY nor toTool`);
      const ac = azSign * g.angleDeg * DEG, eu = [-Math.sin(ac) * azSign, Math.cos(ac) * azSign];
      const x0 = Math.floor(g.w / 2), y0 = Math.floor(g.h / 2), P = f.toTool(x0, y0), Px = f.toTool(x0 + 1, y0);
      const u0 = P[0] * eu[0] + P[1] * eu[1], u1 = Px[0] * eu[0] + Px[1] * eu[1];
      const sc = 1 / ((u1 - u0) || 1 / g.pxPerMm);            // px per mm along u (sign-aware)
      g.axisX = x0 + .5 - u0 * sc; g.tipY = y0 + .5 - P[2] * g.pxPerMm;
    }
    if (kind === 'top' && !(Number.isFinite(g.cx) && Number.isFinite(g.cy))) {
      if (typeof f.toTool !== 'function') throw new Error(`map3d: face ${f.face} has neither cx/cy nor toTool`);
      // find the pixel that maps to the axis: solve the affine map from three probes
      const P = f.toTool(0, 0), Px = f.toTool(1, 0), Py = f.toTool(0, 1);
      const a = Px[0] - P[0], b = Py[0] - P[0], c = Px[1] - P[1], d = Py[1] - P[1], det = a * d - b * c || 1e-9;
      const dx = (-P[0] * d + b * P[1]) / det, dy = (-a * P[1] + c * P[0]) / det;
      g.cx = dx + .5; g.cy = dy + .5;
    }
    g.toTool = kind === 'side' ? sideToTool(g, R, azSign) : topToTool(g, azSign);
    return g;
  }

  // ---------- atlases ----------
  // opts: {diameterMm, cornerRadiusMm, zMaxMm, cellMm, azSign}
  function buildAtlases(faces, opts) {
    const D = opts.diameterMm, R = D / 2, azSign = opts.azSign || -1;
    const F = faces.map(f => f.kind ? f : normalizeFace(f, R, azSign));
    const sides = F.filter(f => f.kind === 'side'), tops = F.filter(f => f.kind === 'top');
    const ppmMax = Math.max(1, ...F.map(f => f.pxPerMm));
    const cell = opts.cellMm || Math.max(.004, Math.min(.05, .8 / ppmMax, D / 400));
    // side atlas
    let zMax = opts.zMaxMm || 0;
    if (!zMax) for (const f of sides) zMax = Math.max(zMax, (f.h - f.tipY) / f.pxPerMm);
    zMax = Math.max(cell, Math.min(zMax, opts.zLimitMm || 3 * D));
    const NA = Math.min(8192, Math.max(64, Math.round(TAU * R / cell))), NZ = Math.min(8192, Math.max(4, Math.ceil(zMax / cell)));
    const dA = TAU / NA, dz = zMax / NZ, cellArea = R * dA * dz;
    const n = NA * NZ, prob = [null, null, new Float32Array(n), new Float32Array(n), new Float32Array(n)], wsum = new Float32Array(n);
    const perFace = F.map(() => ({2: 0, 3: 0, 4: 0}));
    sides.forEach(f => {
      const fi = F.indexOf(f), ac = azSign * f.angleDeg * DEG, ppm = f.pxPerMm, m = f.mask, acc = perFace[fi];
      for (let j = 0; j < NA; j++) {
        const phi = wrap(azSign * ((j + .5) * dA - ac));
        if (Math.abs(phi) >= PHI_MAX) continue;
        const wgt = Math.cos(phi), x = Math.floor(f.axisX + R * Math.sin(phi) * ppm);
        if (x < 0 || x >= f.w) continue;
        for (let i = 0; i < NZ; i++) {
          const y = Math.floor(f.tipY + (i + .5) * dz * ppm);
          if (y < 0 || y >= f.h) continue;
          const c = m[y * f.w + x], k = i * NA + j;
          wsum[k] += wgt;
          if (c >= 2 && c <= 4) { prob[c][k] += wgt; acc[c] += cellArea; }
        }
      }
    });
    const cls = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (wsum[k] > 0) {
      let best = 0, bp = .5 - 1e-6;
      for (let c = 2; c <= 4; c++) { prob[c][k] /= wsum[k]; if (prob[c][k] >= bp && prob[c][k] > (best ? prob[best][k] : 0)) { best = c; bp = prob[c][k]; } }
      cls[k] = best;
    }
    const side = {NA, NZ, dA, dz, zMax, R, cellArea, cls, prob, wsum};
    // end atlas (top face)
    const rE = Math.max(0, opts.cornerRadiusMm == null ? .03 * D : opts.cornerRadiusMm), rIn = R - rE;
    const N = Math.min(4096, Math.max(32, Math.ceil(2 * R / cell))), c2 = 2 * R / N, en = N * N;
    const ecls = new Uint8Array(en), eIn = new Uint8Array(en);
    for (let yi = 0; yi < N; yi++) for (let xi = 0; xi < N; xi++) {
      const X = -R + (xi + .5) * c2, Y = -R + (yi + .5) * c2;
      if (X * X + Y * Y <= rIn * rIn) eIn[yi * N + xi] = 1;
    }
    tops.slice(0, 1).forEach(f => {
      const fi = F.indexOf(f), t = -azSign * f.angleDeg * DEG, c = Math.cos(t), s = Math.sin(t), ppm = f.pxPerMm, acc = perFace[fi];
      for (let yi = 0; yi < N; yi++) for (let xi = 0; xi < N; xi++) {
        const k = yi * N + xi; if (!eIn[k]) continue;
        const X = -R + (xi + .5) * c2, Y = -R + (yi + .5) * c2, X0 = c * X - s * Y, Y0 = s * X + c * Y;
        const x = Math.floor(f.cx - X0 * ppm), y = Math.floor(f.cy - Y0 * ppm);
        if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
        const v = f.mask[y * f.w + x];
        if (v >= 2 && v <= 4) { ecls[k] = v; acc[v] += c2 * c2; }
      }
    });
    const end = {N, cell: c2, R, rIn, cls: ecls, inside: eIn, cellArea: c2 * c2, has: tops.length > 0};
    return {faces: F, side, end, perFace, azSign, cellMm: cell};
  }

  // ---------- chip depth: chamfer distance to the chip boundary (mm), capped ----------
  // open[k] = 1 means the neighbour beyond the atlas edge on that side counts as chip (the chip runs off the edge)
  function distance(mask, W, H, sx, sy, wrapX, openYlo, openOutside) {
    const INF = 1e9, d = new Float32Array(W * H), sd = Math.hypot(sx, sy);
    for (let i = 0; i < W * H; i++) d[i] = mask[i] ? INF : 0;
    const get = (x, y) => {
      if (wrapX) x = (x + W) % W;
      if (y < 0) return openYlo ? INF : 0;
      if (x < 0 || x >= W || y >= H) return openOutside ? INF : 0;
      return d[y * W + x];
    };
    // edge cells whose outside neighbour is non-chip get half a cell of distance
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {                // forward
      const k = y * W + x; if (!mask[k]) continue;
      d[k] = Math.min(d[k], get(x - 1, y) + sx, get(x, y - 1) + sy, get(x - 1, y - 1) + sd, get(x + 1, y - 1) + sd);
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {       // backward
      const k = y * W + x; if (!mask[k]) continue;
      d[k] = Math.min(d[k], get(x + 1, y) + sx, get(x, y + 1) + sy, get(x + 1, y + 1) + sd, get(x - 1, y + 1) + sd);
    }
    if (wrapX) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {      // second forward pass across the seam
      const k = y * W + x; if (!mask[k]) continue;
      d[k] = Math.min(d[k], get(x - 1, y) + sx, get(x + 1, y) + sx);
    }
    for (let i = 0; i < W * H; i++) if (mask[i]) d[i] = Math.max(0, d[i] - .5 * Math.min(sx, sy));
    return d;
  }

  // ---------- tooth lookup from the parametric section (geometry.layout) ----------
  // layout: {cols:[{x,y,tooth,s,reg}], tanH, zTwistMax, land1Mm, land2Mm, clear1Deg, helixDeg}
  function toothLookup(layout) {
    const cols = layout.cols, n = cols.length, ang = cols.map(c => Math.atan2(c.y, c.x));
    const B = 8192, tab = new Int32Array(B);                 // azimuth bin -> column index (nearest)
    for (let b = 0; b < B; b++) {
      const a = -Math.PI + (b + .5) * TAU / B; let best = 0, bd = 1e9;
      for (let m = 0; m < n; m++) { const e = Math.abs(wrap(ang[m] - a)); if (e < bd) { bd = e; best = m; } }
      tab[b] = best;
    }
    // s (arc length behind the edge) interpolated between the two columns around the azimuth, same tooth and region only
    return (alpha, z) => {
      const a0 = wrap(alpha - layout.tanH * Math.min(z, layout.zTwistMax)), m = tab[Math.min(B - 1, Math.floor((a0 + Math.PI) / TAU * B))], c = cols[m];
      if (c.s > 50) return c;
      const e = wrap(a0 - ang[m]), o = cols[(m + (e > 0 ? 1 : -1) + n) % n], de = wrap(ang[(m + (e > 0 ? 1 : -1) + n) % n] - ang[m]);
      if (o.tooth !== c.tooth || o.s > 50 || Math.abs(de) < 1e-9) return c;
      const t = Math.max(0, Math.min(1, e / de));
      return Object.assign({}, c, {s: c.s + (o.s - c.s) * t});
    };
  }

  // ---------- full evaluation ----------
  // opts: {diameterMm, flutes, helixDeg, clearanceDeg, cornerRadiusMm, chipDepthMaxMm, layout, azSign, cellMm}
  function evaluate(faces, opts) {
    const D = opts.diameterMm, R = D / 2, A = buildAtlases(faces, opts), S = A.side, E = A.end;
    const helix = (opts.helixDeg || 30) * DEG, cb = Math.cos(helix), tc = Math.tan((opts.clearanceDeg || 8) * DEG);
    const cap = opts.chipDepthMaxMm || .06 * D;
    // chip depth fields
    const sChip = new Uint8Array(S.NA * S.NZ); for (let k = 0; k < sChip.length; k++) sChip[k] = S.cls[k] === 3;
    const sDist = distance(sChip, S.NA, S.NZ, R * S.dA, S.dz, true, true, false);
    const sDepth = new Float32Array(sDist.length); for (let k = 0; k < sDepth.length; k++) sDepth[k] = sChip[k] ? Math.min(cap, sDist[k]) : 0;
    // end chips that reach the rim continue into the (side-mapped) corner: cells outside the end disc count as open
    const eChip = new Uint8Array(E.N * E.N), eOpen = new Uint8Array(E.N * E.N);
    for (let k = 0; k < eChip.length; k++) { eChip[k] = E.cls[k] === 3; eOpen[k] = eChip[k] || !E.inside[k]; }
    const eDist = distance(eOpen, E.N, E.N, E.cell, E.cell, false, false, true);
    const eDepth = new Float32Array(eDist.length); for (let k = 0; k < eDepth.length; k++) eDepth[k] = eChip[k] ? Math.min(cap, eDist[k]) : 0;
    // totals
    const T = {areaMm2: {2: 0, 3: 0, 4: 0}, sideAreaMm2: {2: 0, 3: 0, 4: 0}, endAreaMm2: {2: 0, 3: 0, 4: 0}, chipVolumeMm3: 0, flankVolumeMm3: 0};
    // chip = local surface offset by depth (side: radially in, end: up into the tool); volume = area x depth
    for (let k = 0; k < S.cls.length; k++) { const c = S.cls[k]; if (c) { T.sideAreaMm2[c] += S.cellArea; if (c === 3) T.chipVolumeMm3 += S.cellArea * sDepth[k]; } }
    for (let k = 0; k < E.cls.length; k++) { const c = E.cls[k]; if (c) { T.endAreaMm2[c] += E.cellArea; if (c === 3) T.chipVolumeMm3 += E.cellArea * eDepth[k]; } }
    for (const c of [2, 3, 4]) T.areaMm2[c] = T.sideAreaMm2[c] + T.endAreaMm2[c];
    // per tooth (needs the parametric layout)
    const k = opts.flutes || 4, perTooth = Array.from({length: k}, () => ({areaMm2: {2: 0, 3: 0, 4: 0}, endAreaMm2: {2: 0, 3: 0, 4: 0}, vbMaxMm: 0, flankVolumeMm3: 0, onLandFrac: 0, _flank: 0, _land: 0}));
    if (opts.layout) {
      const look = toothLookup(opts.layout), landW = opts.layout.land1Mm + opts.layout.land2Mm;
      for (let i = 0; i < S.NZ; i++) {
        const z = (i + .5) * S.dz, wMax = new Float32Array(k);
        for (let j = 0; j < S.NA; j++) {
          const c = S.cls[i * S.NA + j]; if (!c) continue;
          const col = look((j + .5) * S.dA, z), t = Math.max(0, Math.min(k - 1, col.tooth | 0)), P = perTooth[t];
          P.areaMm2[c] += S.cellArea;
          if (c === 2) {
            P._flank++; if (col.s >= 0 && col.s <= landW) { P._land++; wMax[t] = Math.max(wMax[t], col.s + .5 * R * S.dA); }   // cell centre -> cell edge
          }
        }
        for (let t = 0; t < k; t++) if (wMax[t] > 0) {
          const vb = wMax[t] * cb, P = perTooth[t];
          P.vbMaxMm = Math.max(P.vbMaxMm, vb); P.flankVolumeMm3 += .5 * vb * vb * tc * S.dz / cb;
        }
      }
      // end teeth: nearest end cutting edge ahead in the cut direction, from the layout at z = 0
      const lookEnd = toothLookup(Object.assign({}, opts.layout, {tanH: 0}));
      for (let yi = 0; yi < E.N; yi++) for (let xi = 0; xi < E.N; xi++) {
        const c = E.cls[yi * E.N + xi]; if (!c) continue;
        const X = -R + (xi + .5) * E.cell, Y = -R + (yi + .5) * E.cell, t = Math.max(0, Math.min(k - 1, lookEnd(Math.atan2(Y, X), 0).tooth | 0));
        perTooth[t].endAreaMm2[c] += E.cellArea;
      }
      for (const P of perTooth) { P.onLandFrac = P._flank ? P._land / P._flank : 0; T.flankVolumeMm3 += P.flankVolumeMm3; delete P._flank; delete P._land; }
    }
    const rnd = o => Object.fromEntries(Object.entries(o).map(([a, v]) => [a, typeof v === 'number' ? r4(v) : v && typeof v === 'object' ? rnd(v) : v]));
    const faceRows = A.faces.map((f, i) => ({
      face: f.face, kind: f.kind, angleDeg: f.angleDeg, pxPerMm: r4(f.pxPerMm), source: f.source || null,
      areasMm2: rnd(A.perFace[i]),                               // on the model, as seen by this face alone
      imageAreasMm2: rnd(imageAreas(f, R))                       // flat pixel count / ppm^2 (no foreshortening)
    }));
    const totals = {
      areaMm2: rnd(T.areaMm2), sideAreaMm2: rnd(T.sideAreaMm2), endAreaMm2: rnd(T.endAreaMm2),
      flank: {areaMm2: r4(T.areaMm2[2]), volumeMm3: r4(T.flankVolumeMm3)},
      chip: {areaMm2: r4(T.areaMm2[3]), volumeMm3: r4(T.chipVolumeMm3), maxDepthMm: r4(Math.max(0, ...maxOf(sDepth), ...maxOf(eDepth)))},
      adhesion: {areaMm2: r4(T.areaMm2[4]), volumeMm3: null},
      totalAreaMm2: r4(T.areaMm2[2] + T.areaMm2[3] + T.areaMm2[4]),
      totalVolumeMm3: r4(T.flankVolumeMm3 + T.chipVolumeMm3)
    };
    return {
      faces: faceRows, totals, perTooth: perTooth.map(rnd),
      atlas: {side: Object.assign(S, {depth: sDepth}), end: Object.assign(E, {depth: eDepth}), cellMm: A.cellMm, azSign: A.azSign},
      model: 'side: envelope cylinder r = D/2, cos(view) blended votes, p >= .5; end: r <= R - corner radius; chip depth = distance to chip boundary capped at ' + r4(cap) + ' mm; flank volume = 0.5 VB^2 tan(clearance) dz / cos(helix)'
    };
  }
  const maxOf = a => { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return [m]; };

  function imageAreas(f, R) {
    const o = {2: 0, 3: 0, 4: 0}, px = 1 / (f.pxPerMm * f.pxPerMm);
    for (let i = 0; i < f.mask.length; i++) { const c = f.mask[i]; if (c >= 2 && c <= 4) o[c] += px; }
    return o;
  }

  // bilinear-ish lookups used for deformation (nearest cell; depth fields are smooth enough at cell scale)
  function sideDepthAt(atlas, alpha, z) {
    const S = atlas.side; if (z < 0) z = 0; if (z >= S.zMax) return 0;
    let a = alpha % TAU; if (a < 0) a += TAU;
    const fj = a / S.dA - .5, fi = z / S.dz - .5, j0 = Math.floor(fj), i0 = Math.max(0, Math.floor(fi)), u = fj - j0, v = Math.max(0, fi - i0);
    const g = (i, j) => S.depth[Math.min(S.NZ - 1, i) * S.NA + ((j % S.NA) + S.NA) % S.NA];
    return (g(i0, j0) * (1 - u) + g(i0, j0 + 1) * u) * (1 - v) + (g(i0 + 1, j0) * (1 - u) + g(i0 + 1, j0 + 1) * u) * v;
  }
  function endDepthAt(atlas, X, Y) {
    const E = atlas.end; if (!E.has) return 0;
    const fx = (X + E.R) / E.cell - .5, fy = (Y + E.R) / E.cell - .5, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
    const g = (y, x) => x < 0 || y < 0 || x >= E.N || y >= E.N ? 0 : E.depth[y * E.N + x];
    return (g(y0, x0) * (1 - u) + g(y0, x0 + 1) * u) * (1 - v) + (g(y0 + 1, x0) * (1 - u) + g(y0 + 1, x0 + 1) * u) * v;
  }

  // Deformation for endmill-geometry build(): the surface is offset into the tool by the chip depth (side: radially in,
  // end face: up); the rim of the end face follows the side depth so the two surfaces stay joined.
  function deformer(result) {
    const at = result.atlas, R = at.side.R, rIn = at.end.rIn;
    return {
      side(x, y, z, h = z) {
        const r = Math.hypot(x, y); if (r < 1e-9) return null;
        const w = Math.max(0, 1 - h / (.2 * R)), s = Math.min(1, rIn / r);
        const d = sideDepthAt(at, Math.atan2(y, x), z), dz = w > 0 ? endDepthAt(at, x * s, y * s) * w : 0;
        if (d <= 0 && dz <= 0) return null;
        const f = Math.max(0, r - d) / r; return [x * f, y * f, z + dz];
      },
      end(x, y, z, fr = 1) {
        const r = Math.hypot(x, y), s = r > rIn ? rIn / r : 1, dz = endDepthAt(at, x * s, y * s);
        const d = r > 1e-9 ? sideDepthAt(at, Math.atan2(y, x), z) * Math.pow(fr, 8) : 0;
        if (d <= 0 && dz <= 0) return null;
        const f = r > 1e-9 ? Math.max(0, r - d) / r : 1; return [x * f, y * f, z + dz];
      }
    };
  }

  // ---------- faceSeg derived from the current wear pipeline (until the segmentation model ships) ----------
  // strip (js/wear rectified side: column cx = axis, row top = tip, native px/mm) + band -> contract face.
  // Classes: 1 tool body, 2 flank band, 3 missing material at the tip (tip profile below the nominal end).
  function faceFromStrip(e, i, k, D) {
    const {w, h, g, cx, R, top, ppm} = e.strip, band = e.band, mask = new Uint8Array(w * h);
    for (let y = top; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(x + .5 - (cx + .5)) < R) mask[y * w + x] = 1;
    let nb = 0; for (let j = 0; j < w * h; j++) if (band[j]) { mask[j] = 2; nb++; }
    const chip = tipChips(e.strip, D), nc = chip.count;
    for (const j of chip.idx) mask[j] = 3;
    const f = {face: 'side' + (i + 1), angleDeg: i * 360 / k, w, h, mask, pxPerMm: ppm, axisX: cx + .5, tipY: top, source: 'wear-pipeline'};
    f.stats = {bandPx: nb, chipPx: nc};
    return f;
  }

  // Tip chipping from the rectified strip: first tool row per column vs a robust nominal tip line; a deficit deeper than
  // max(3 px, 0.02 D) over >= 3 adjacent columns (inside 0.92 R, clear of the corner radius) is missing material.
  function tipChips(strip, D) {
    const {w, h, g, cx, R, top, ppm} = strip, idx = [];
    const bg = [], body = [];
    for (let y = 0; y < Math.max(1, top - 2); y++) for (let x = 0; x < w; x += 2) { const v = g[y * w + x]; if (v === v) bg.push(v); }
    for (let y = top + Math.round(.1 * D * ppm); y < Math.min(h, top + Math.round(.3 * D * ppm)); y++) for (let x = Math.round(cx - .6 * R); x < cx + .6 * R; x += 2) { const v = g[y * w + x]; if (v === v) body.push(v); }
    if (bg.length < 20 || body.length < 20) return {idx, count: 0};
    const q = (a, p) => { const s = a.slice().sort((m, n) => m - n); return s[Math.floor(p * (s.length - 1))]; };
    const b0 = q(bg, .5), t0 = q(body, .5);
    if (Math.abs(t0 - b0) < 12) return {idx, count: 0};           // no contrast between tool and background
    const thr = (b0 + t0) / 2, isTool = v => v === v && (t0 > b0 ? v > thr : v < thr);
    const xa = Math.ceil(cx - .92 * R), xb = Math.floor(cx + .92 * R), first = new Float32Array(w).fill(-1), lim = top + Math.round(.25 * D * ppm);
    for (let x = xa; x <= xb; x++) for (let y = Math.max(0, top - 3); y < Math.min(h, lim); y++) if (isTool(g[y * w + x]) && isTool(g[Math.min(h - 1, y + 1) * w + x])) { first[x] = y; break; }
    const vals = []; for (let x = xa; x <= xb; x++) if (first[x] >= 0) vals.push(first[x]);
    if (vals.length < 10) return {idx, count: 0};
    const base = q(vals, .2), minDef = Math.max(3, .02 * D * ppm);
    let run = [];
    const flush = () => { if (run.length >= 3) for (const x of run) for (let y = Math.ceil(base); y < first[x]; y++) idx.push(y * w + x); run = []; };
    for (let x = xa; x <= xb; x++) { if (first[x] >= 0 && first[x] - base > minDef) run.push(x); else flush(); }
    flush();
    return {idx, count: idx.length};
  }

  // top photo (ImageData-like) + js/wear analyzeTop circle -> contract face. Bright pixels on the end face (the same
  // threshold js/wear uses for endBrightAreaMm2) become flank class; dropped when they cover > 30 % (glare, not wear).
  function faceFromTop(img, circle, D, sens = 4) {
    if (!img || !circle || !(circle.rPx > 0)) return null;
    const {width: w, height: h, data} = img, mask = new Uint8Array(w * h), r = circle.rPx, cx = circle.cx, cy = circle.cy, vals = [], idx = [];
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      const d2 = (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2; if (d2 > r * r) continue;
      mask[y * w + x] = 1;
      if (d2 < (.95 * r) ** 2) { const j = 4 * (y * w + x); vals.push(.299 * data[j] + .587 * data[j + 1] + .114 * data[j + 2]); idx.push(y * w + x); }
    }
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b), med = s[s.length >> 1], mad = vals.map(v => Math.abs(v - med)).sort((a, b) => a - b)[vals.length >> 1];
    const thr = med + sens * Math.max(4, 1.4826 * mad), hit = idx.filter((_, j) => vals[j] > thr);
    const glare = hit.length > .3 * idx.length;
    if (!glare) for (const j of hit) mask[j] = 2;
    return {face: 'top', angleDeg: 0, w, h, mask, pxPerMm: 2 * r / D, cx, cy, source: 'wear-pipeline', stats: {brightPx: hit.length, glare}};
  }

  // ---------- synthetic faces (mock / tests) ----------
  // Known rectangles/discs so the expected model areas are analytic.
  // layout (endmill-geometry layout()) puts side flank bands on the flank lands with VB = 0.10 + 0.04 i mm on face i.
  function mock(k = 4, D = 10, ppm = 40, layout = null) {
    const R = D / 2, faces = [], L = 1.6 * D, look = layout ? toothLookup(layout) : null;
    for (let i = 0; i < k; i++) {
      const w = Math.ceil(2.4 * R * ppm), h = Math.ceil((L + .4) * ppm), axisX = w / 2, tipY = Math.round(.4 * ppm), m = new Uint8Array(w * h);
      const put = (u0, u1, z0, z1, c) => {
        for (let y = Math.floor(tipY + z0 * ppm); y < tipY + z1 * ppm; y++) for (let x = Math.floor(axisX + u0 * ppm); x < axisX + u1 * ppm; x++) if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = c;
      };
      put(-R, R, 0, L, 1);
      if (look) {                                                        // flank band exactly on the land behind the edge
        const vb = .1 + .04 * i, sMax = vb / Math.cos(layout.q.helixDeg * DEG), zB = .35 * D;
        for (let y = tipY; y < tipY + zB * ppm; y++) for (let x = 0; x < w; x++) {
          const u = (x + .5 - axisX) / ppm; if (Math.abs(u) >= .97 * R) continue;
          const col = look(-(i * TAU / k + Math.asin(u / R)), (y + .5 - tipY) / ppm);
          if (col.s >= 0 && col.s < sMax) m[y * w + x] = 2;
        }
      } else put(.15 * R, .45 * R, 0, (1.2 + .3 * i) * .1 * D * 2, 2);   // flank band (no layout: plain rectangle)
      if (i === 0 && look) {                                             // corner chip: first 0.5 mm of land, z < 0.06 D
        for (let y = tipY; y < tipY + .06 * D * ppm; y++) for (let x = 0; x < w; x++) {
          const u = (x + .5 - axisX) / ppm; if (Math.abs(u) >= .97 * R) continue;
          const col = look(-Math.asin(u / R), (y + .5 - tipY) / ppm);
          if (col.s >= 0 && col.s < .05 * D) m[y * w + x] = 3;
        }
      } else if (i === 0) put(.2 * R, .5 * R, 0, .06 * D, 3);            // corner chip at the tip (no layout)
      if (i === 1) put(-.4 * R, -.15 * R, .3 * D, .45 * D, 4);           // adhesion patch
      faces.push({face: 'side' + (i + 1), angleDeg: i * 360 / k, w, h, mask: m, pxPerMm: ppm, axisX, tipY, source: 'mock'});
    }
    const N = Math.ceil(2.4 * R * ppm), m = new Uint8Array(N * N), cx = N / 2, cy = N / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const X = -(x + .5 - cx) / ppm, Y = -(y + .5 - cy) / ppm, r = Math.hypot(X, Y), a = Math.atan2(Y, X);
      if (r > R) continue;
      m[y * N + x] = 1;
      if (r > .55 * R && r < .8 * R && Math.abs(wrap(a - .35)) < .18) m[y * N + x] = 3;   // chipped end tooth
      else if (r > .3 * R && r < .9 * R && Math.abs(wrap(a - 2.0)) < .08) m[y * N + x] = 2;
    }
    faces.push({face: 'top', angleDeg: 0, w: N, h: N, mask: m, pxPerMm: ppm, cx, cy, source: 'mock'});
    return faces;
  }

  return {CLS, NAMES, normalizeFace, buildAtlases, evaluate, deformer, sideDepthAt, endDepthAt, faceFromStrip, faceFromTop, tipChips, mock, distance, toothLookup};
});
