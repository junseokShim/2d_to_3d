// Tool3D render: flank wear overlay. Reads window.Tool3D.wearResult (contract in board.md):
// { flutes, diameterMm, helixDeg, perFlute:[{vbMaxMm, vbAvgMm, areaMm2, volumeMm3, profile:[{zMm, vbMm}]}], totals }
// Resamples each flute's VB(z) profile into one row of a small texture (linear interp + light Gaussian
// smoothing, so coarse photo profiles do not show as stair steps). The surface shader paints the flank land
// from the cutting edge back to VB(z) with a soft boundary. Never measures anything.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};
  const W = 256, ROWS = 8;                                   // 256 x 8 RGBA8 = 8 KB

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

  const data = new Uint8Array(W * ROWS * 4);
  const tex = new THREE.DataTexture(data, W, ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

  // Fills the texture; returns uniforms-ready numbers {zMax, vbMax, rows}.
  function texture(wear) {
    data.fill(0);
    const pf = wear && wear.perFlute || [];
    let zMax = 0, vbMax = 1e-6;
    for (const f of pf) for (const p of f.profile || []) { zMax = Math.max(zMax, p.zMm); vbMax = Math.max(vbMax, p.vbMm); }
    zMax = zMax * 1.02 + 1e-3;
    const dz = zMax / (W - 1), row = new Float32Array(W), sm = new Float32Array(W);
    pf.slice(0, ROWS).forEach((f, r) => {
      const prof = f.profile || [];
      const step = prof.length > 1 ? (prof[prof.length - 1].zMm - prof[0].zMm) / (prof.length - 1) : dz;
      const sig = Math.max(1, .45 * step / dz), rad = Math.ceil(2.5 * sig);   // ~half a profile step
      for (let i = 0; i < W; i++) row[i] = vbAt(prof, i * dz);
      for (let i = 0; i < W; i++) {
        let a = 0, n = 0;
        for (let j = -rad; j <= rad; j++) { const k = i + j; if (k < 0 || k >= W) continue; const g = Math.exp(-.5 * (j / sig) ** 2); a += g * row[k]; n += g; }
        sm[i] = a / n;
      }
      for (let i = 0; i < W; i++) data[4 * (r * W + i)] = Math.round(255 * Math.min(1, sm[i] / vbMax));
    });
    tex.needsUpdate = true;
    return {zMax, vbMax, rows: ROWS};
  }

  NS.wear = {mock, vbAt, texture, tex};
})();
