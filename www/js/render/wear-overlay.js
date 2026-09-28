// Tool3D render: flank wear overlay. Reads window.Tool3D.wearResult (contract in board.md):
// { flutes, diameterMm, helixDeg, perFlute:[{vbMaxMm, vbAvgMm, areaMm2, volumeMm3, profile:[{zMm, vbMm}]}], totals }
// Paints each flute's flank land red from the cutting edge back to VB(z). Never measures anything.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};

  // Placeholder until worker-wear publishes real data. Clearly flagged as mock.
  function mock(flutes, D) {
    const perFlute = [];
    for (let i = 0; i < flutes; i++) {
      const g = 1 + .35 * Math.sin(1.7 * i + .4), profile = [];
      for (let z = 0; z <= 1.2 * D; z += D / 40) {
        const vb = g * (.06 + .16 * Math.exp(-z / (.12 * D))) * (z < .9 * D ? 1 : Math.max(0, 1 - (z - .9 * D) / (.3 * D)));
        profile.push({zMm: +z.toFixed(3), vbMm: +vb.toFixed(4)});
      }
      const vbs = profile.map(p => p.vbMm), dz = D / 40;
      const area = vbs.reduce((s, v) => s + v * dz, 0);
      perFlute.push({vbMaxMm: Math.max(...vbs), vbAvgMm: area / (1.2 * D), areaMm2: area, volumeMm3: area * .004 * D, profile});
    }
    const sum = f => perFlute.reduce((s, p) => s + p[f], 0);
    return {mock: true, flutes, diameterMm: D, perFlute,
      totals: {vbMaxMm: Math.max(...perFlute.map(p => p.vbMaxMm)), areaMm2: sum('areaMm2'), volumeMm3: sum('volumeMm3')}};
  }

  function vbAt(profile, z) {
    if (!profile || !profile.length) return 0;
    if (z <= profile[0].zMm) return z < profile[0].zMm - .05 ? 0 : profile[0].vbMm;
    for (let i = 1; i < profile.length; i++) if (z <= profile[i].zMm) {
      const a = profile[i - 1], b = profile[i], u = (z - a.zMm) / ((b.zMm - a.zMm) || 1);
      return a.vbMm + (b.vbMm - a.vbMm) * u;
    }
    return 0;
  }

  // Base scanner shading per region: ground lands bright, pocket darker (like an Alicona albedo).
  const BASE = {0: .50, 1: .42, 2: .28, 3: .30, 4: .13, 5: .46};   // linear albedo
  const RED = [.72, .02, .015];

  // Writes a 'color' attribute on the geometry. Returns covered-area estimate for the HUD.
  function paint(geom, wear, show) {
    const m = geom.userData.meta, n = m.length / 4;
    let col = geom.getAttribute('color');
    if (!col) { col = new THREE.BufferAttribute(new Float32Array(n * 3), 3); geom.setAttribute('color', col); }
    const c = col.array, vbMax = wear && wear.totals ? Math.max(1e-6, wear.totals.vbMaxMm) : 1;
    for (let i = 0; i < n; i++) {
      const tooth = m[4 * i], s = m[4 * i + 1], reg = m[4 * i + 2], z = m[4 * i + 3];
      const b = reg >= 0 ? BASE[reg] : .7;
      let r = b, g = b, bl = b * 1.02;
      if (show && wear && wear.perFlute && s >= 0 && tooth >= 0) {
        const pf = wear.perFlute[tooth % wear.perFlute.length];
        const vb = pf ? vbAt(pf.profile, z) : 0;
        if (vb > 0 && s <= vb) {
          const k = .55 + .45 * Math.min(1, vb / vbMax);        // deeper red where VB is larger
          const edge = Math.min(1, (vb - s) / .015);             // soft 15 um boundary
          const w = k * edge;
          r = b * (1 - w) + RED[0] * w; g = b * (1 - w) + RED[1] * w; bl = b * (1 - w) + RED[2] * w;
        }
      }
      c[3 * i] = r; c[3 * i + 1] = g; c[3 * i + 2] = bl;
    }
    col.needsUpdate = true;
  }

  NS.wear = {mock, vbAt, paint};
})();
