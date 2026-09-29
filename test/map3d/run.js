// map3d tests: known synthetic masks -> expected areas / volumes on the parametric model. Run: node test/map3d/run.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const M = require('../../www/js/map3d/map3d-core.js');

let pass = 0, fail = 0;
const rel = (name, got, want, tol) => {
  const e = Math.abs(got - want) / Math.max(1e-9, Math.abs(want)), ok = e <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${(+got).toFixed(5)} want ${(+want).toFixed(5)} (${(100 * e).toFixed(2)} % <= ${100 * tol} %)`);
  ok ? pass++ : fail++;
};
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${(+got).toFixed(4)} want ${want} +-${tol}`); ok ? pass++ : fail++; };
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

// render geometry in a sandbox with a minimal THREE stub (only buffers are needed)
function loadGeometry() {
  class Attr { constructor(a, n) { this.array = a instanceof Float32Array ? a : new Float32Array(a); this.itemSize = n; } }
  class Geo { setAttribute(k, v) { this[k] = v; } getAttribute(k) { return this[k]; } setIndex(i) { this.index = {array: i}; } getIndex() { return this.index; } computeVertexNormals() {} }
  const ctx = {window: {}, THREE: {BufferGeometry: Geo, BufferAttribute: Attr, Float32BufferAttribute: Attr}, Math, Object, Float32Array, Uint8Array, Array, Number, Infinity, NaN};
  ctx.window.THREE = ctx.THREE; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../www/js/render/endmill-geometry.js'), 'utf8').replace(/window\.Tool3D/g, 'window.Tool3D'), ctx);
  return ctx.window.Tool3D._render.geometry;
}
const G = loadGeometry();

// signed volume of all parts (divergence theorem); parts share the same winding convention
function volume(b) {
  let v = 0;
  for (const g of Object.values(b.parts)) {
    const p = g.position.array, ix = g.index.array;
    for (let t = 0; t < ix.length; t += 3) {
      const a = 3 * ix[t], c = 3 * ix[t + 1], d = 3 * ix[t + 2];
      v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6;
    }
  }
  return v;
}

// side face with a rectangle [u0,u1] x [z0,z1] (mm) of class c
function sideFace(angleDeg, D, ppm, rects, name) {
  const R = D / 2, w = Math.ceil(2.4 * R * ppm), h = Math.ceil((1.5 * D + .5) * ppm), axisX = w / 2, tipY = Math.round(.5 * ppm), m = new Uint8Array(w * h);
  for (let y = tipY; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(x + .5 - axisX) < R * ppm) m[y * w + x] = 1;
  for (const [u0, u1, z0, z1, c] of rects)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + .5 - axisX) / ppm, z = (y + .5 - tipY) / ppm;
      if (u >= u0 && u < u1 && z >= z0 && z < z1) m[y * w + x] = c;
    }
  return {face: name || 'side', angleDeg, w, h, mask: m, pxPerMm: ppm, axisX, tipY};
}
const cylArea = (R, u0, u1, z0, z1) => R * (Math.asin(u1 / R) - Math.asin(u0 / R)) * (z1 - z0);

console.log('# 1. single side face, flank rectangle -> cylinder area');
{
  const D = 10, R = 5, ppm = 40, f = sideFace(0, D, ppm, [[-1.5, 2.5, .2, 3.2, 2]], 'side1');
  const r = M.evaluate([f], {diameterMm: D, flutes: 4});
  rel('flank area on model', r.totals.flank.areaMm2, cylArea(R, -1.5, 2.5, .2, 3.2), .03);
  rel('per-face area (side1)', r.faces[0].areasMm2[2], cylArea(R, -1.5, 2.5, .2, 3.2), .03);
  rel('image area (flat)', r.faces[0].imageAreasMm2[2], 4 * 3, .03);
}

console.log('\n# 2. near-limb rectangle (strong foreshortening) D6, ppm 60');
{
  const D = 6, R = 3, f = sideFace(0, D, 60, [[1.8, 2.7, 0, 1.5, 2]], 'side1');
  const r = M.evaluate([f], {diameterMm: D, flutes: 3});
  rel('flank area near limb', r.totals.flank.areaMm2, cylArea(R, 1.8, 2.7, 0, 1.5), .03);
}

console.log('\n# 3. 4 faces, same physical patch seen by two faces -> blended, no double count');
{
  const D = 10, R = 5, ppm = 40, k = 4;
  // physical patch: azimuth (model) from -70 to -20 deg (i.e. between side1 at 0 and side2 at -90 with azSign -1), z 0.5..2.5
  const a0 = 20 * Math.PI / 180, a1 = 70 * Math.PI / 180, z0 = .5, z1 = 2.5;
  const faces = [];
  for (let i = 0; i < k; i++) {
    const th = i * Math.PI / 2, rects = [];
    // image u of physical azimuth phi (relative to the face centre): u = R sin(phi); visible if |phi| < 75
    const p0 = a0 - th, p1 = a1 - th;
    if (Math.max(Math.abs(p0), Math.abs(p1)) < 75 * Math.PI / 180) rects.push([R * Math.sin(p0), R * Math.sin(p1), z0, z1, 2]);
    faces.push(sideFace(i * 90, D, ppm, rects, 'side' + (i + 1)));
  }
  const r = M.evaluate(faces, {diameterMm: D, flutes: k});
  rel('blended flank area', r.totals.flank.areaMm2, R * (a1 - a0) * (z1 - z0), .03);
  check('two faces contributed', r.faces.filter(f => f.areasMm2[2] > 0).length === 2, JSON.stringify(r.faces.map(f => f.areasMm2[2])));
}

console.log('\n# 4. face given only toTool (no axisX/tipY) -> same area as with explicit fields');
{
  const D = 8, R = 4, ppm = 50, f = sideFace(90, D, ppm, [[-1, 1, 0, 2, 3]], 'side2');
  const tt = M.normalizeFace(f, R).toTool, g = Object.assign({}, f, {toTool: tt}); delete g.axisX; delete g.tipY;
  const a = M.evaluate([f], {diameterMm: D}), b = M.evaluate([g], {diameterMm: D});
  rel('probed toTool area', b.totals.chip.areaMm2, a.totals.chip.areaMm2, .005);
  rel('chip area vs analytic', a.totals.chip.areaMm2, cylArea(R, -1, 1, 0, 2), .03);
}

console.log('\n# 5. top face: annular sector on the end face');
{
  const D = 10, R = 5, ppm = 40, N = Math.ceil(2.4 * R * ppm), cx = N / 2, cy = N / 2, m = new Uint8Array(N * N);
  const r0 = 1.5, r1 = 3.5, half = .4;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const X = -(x + .5 - cx) / ppm, Y = -(y + .5 - cy) / ppm, r = Math.hypot(X, Y);
    if (r <= R) m[y * N + x] = 1;
    if (r >= r0 && r < r1 && Math.abs(Math.atan2(Y, X) - 1) < half) m[y * N + x] = 2;
  }
  const r = M.evaluate([{face: 'top', angleDeg: 0, w: N, h: N, mask: m, pxPerMm: ppm, cx, cy}], {diameterMm: D});
  rel('end-face flank area', r.totals.endAreaMm2[2], half * (r1 * r1 - r0 * r0), .03);
  const rr = M.evaluate([{face: 'top', angleDeg: 90, w: N, h: N, mask: m, pxPerMm: ppm, cx, cy}], {diameterMm: D});
  rel('rotated top keeps area', rr.totals.endAreaMm2[2], half * (r1 * r1 - r0 * r0), .03);
}

console.log('\n# 6. mock faces -> per-face, totals, per-tooth, chip deformation volume');
{
  const D = 10, k = 4, L = G.layout({flutes: k, diameterMm: D}), faces = M.mock(k, D, 40, L);
  const t0 = Date.now(), r = M.evaluate(faces, {diameterMm: D, flutes: k, helixDeg: L.q.helixDeg, cornerRadiusMm: L.q.cornerRadiusMm, layout: L});
  const ms = Date.now() - t0;
  check('evaluate time < 1500 ms', ms < 1500, ms + ' ms');
  check('faces = k + 1', r.faces.length === k + 1);
  check('all three classes present', r.totals.flank.areaMm2 > 0 && r.totals.chip.areaMm2 > 0 && r.totals.adhesion.areaMm2 > 0, JSON.stringify(r.totals.areaMm2));
  const R = 5;
  check('side chip on the cutting corner', r.totals.sideAreaMm2[3] > .1 && r.perTooth.some(p => p.areaMm2[3] > .1), r.totals.sideAreaMm2[3] + ' mm2');
  check('end chip on tooth material (0 < area <= sector)', r.totals.endAreaMm2[3] > .2 && r.totals.endAreaMm2[3] <= .18 * ((.8 * R) ** 2 - (.55 * R) ** 2) * 1.01, r.totals.endAreaMm2[3] + ' mm2');
  const sumTooth = r.perTooth.reduce((s, p) => s + p.areaMm2[2], 0);
  rel('per-tooth flank areas sum to total side flank', sumTooth, r.totals.sideAreaMm2[2], .001);
  const vbs = r.perTooth.map(p => p.vbMaxMm).sort((a, b) => a - b);
  console.log('      per tooth [VBmax, on-land fraction]: ' + JSON.stringify(r.perTooth.map(p => [p.vbMaxMm, p.onLandFrac])));
  [.10, .14, .18, .22].forEach((v, i) => near(`tooth VBmax #${i + 1} (sorted)`, vbs[i], v, .03));
  check('flank on lands (on-land fraction > 0.95)', r.perTooth.every(p => p.onLandFrac > .95));
  let fv = 0; for (const v of [.10, .14, .18, .22]) fv += .5 * v * v * Math.tan(8 * Math.PI / 180) * .35 * D / Math.cos(L.q.helixDeg * Math.PI / 180);
  rel('flank volume (wedge model)', r.totals.flank.volumeMm3, fv, .15);
  check('chip depth capped', r.totals.chip.maxDepthMm > 0 && r.totals.chip.maxDepthMm <= .06 * D + 1e-6, r.totals.chip.maxDepthMm + ' mm');
  // geometry: removed volume of the deformed model ~ reported chip volume
  const b0 = G.build({flutes: k, diameterMm: D}, {side: () => null, end: () => null}), b1 = G.build({flutes: k, diameterMm: D}, M.deformer(r));
  const dv = Math.abs(volume(b0)) - Math.abs(volume(b1));
  console.log(`      model volume ${Math.abs(volume(b0)).toFixed(3)} -> ${Math.abs(volume(b1)).toFixed(3)} mm3, removed ${dv.toFixed(4)}, reported chip ${r.totals.chip.volumeMm3}`);
  check('deformation removes material', dv > 0);
  rel('removed volume vs reported chip volume', dv, r.totals.chip.volumeMm3, .15);
  // vertices of the deformed mesh inside the chip moved inward
  let moved = 0; const p0 = b0.parts.side.position.array, p1 = b1.parts.side.position.array;
  for (let i = 0; i < p0.length; i += 3) if (Math.hypot(p1[i], p1[i + 1]) < Math.hypot(p0[i], p0[i + 1]) - 1e-4) moved++;
  check('side vertices displaced', moved > 20, moved + ' vertices');
}

console.log('\n# 6b. left hand / other phase / 3 flutes D6: deformed mesh removal = reported chip volume');
for (const P of [{flutes: 4, diameterMm: 10, hand: -1, helixDeg: 32.5, phaseRad: .7}, {flutes: 3, diameterMm: 6, hand: 1, helixDeg: 35, phaseRad: -.4}]) {
  const L = G.layout(P), r = M.evaluate(M.mock(P.flutes, P.diameterMm, 50, L), {diameterMm: P.diameterMm, flutes: P.flutes, helixDeg: P.helixDeg, cornerRadiusMm: L.q.cornerRadiusMm, layout: L});
  const b0 = G.build(P, {side: () => null, end: () => null}), b1 = G.build(P, M.deformer(r)), dv = Math.abs(volume(b0)) - Math.abs(volume(b1));
  rel(`removal vs chip volume ${JSON.stringify(P)}`, dv, r.totals.chip.volumeMm3, .15);
  check('flank on lands', r.perTooth.every(p => p.onLandFrac > .95), JSON.stringify(r.perTooth.map(p => p.onLandFrac)));
}

console.log('\n# 7. tip chip derivation from a rectified strip');
{
  const D = 10, ppm = 30, R = 5 * ppm, m = 20, w = 2 * R + 2 * m, top = 20, h = top + 8 * ppm, g = new Float32Array(w * h), cx = m + R - .5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = y >= top && Math.abs(x - cx) < R ? 180 : 40;
  // missing material 0.4 mm deep over u in [1, 2] mm
  for (let y = top; y < top + .4 * ppm; y++) for (let x = Math.round(cx + ppm); x < cx + 2 * ppm; x++) g[y * w + x] = 40;
  const c = M.tipChips({w, h, g, cx, R, top, ppm}, D);
  rel('tip chip image area mm2', c.count / ppm / ppm, 1 * .4, .1);
  const f = M.faceFromStrip({strip: {w, h, g, cx, R, top, ppm}, band: new Uint8Array(w * h)}, 0, 4, D);
  const r = M.evaluate([f], {diameterMm: D, flutes: 4});
  rel('tip chip on the model', r.totals.chip.areaMm2, cylArea(5, 1, 2, 0, .4), .08);
  const none = M.tipChips({w, h, g: g.map((v, i) => (i / w | 0) >= top && Math.abs(i % w - cx) < R ? 180 : 40), cx, R, top, ppm}, D);
  check('intact tip -> no chip', none.count === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
