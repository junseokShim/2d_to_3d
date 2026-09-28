// Synthetic end-mill photos with known tilt, scale, helix and flank wear VB(z). Same (u, v) frame as wear-core align().
'use strict';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// o: {w, h, D, ppm, tiltDeg, axisDx, tipV, helixDeg, flutes, vb: z => mm, zoneMm, seed}
function side(o) {
  const {w, h, D, ppm, flutes: k} = o, t = o.tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), R = D / 2 * ppm;
  const tb = Math.tan(o.helixDeg * Math.PI / 180), cb = Math.cos(o.helixDeg * Math.PI / 180), circ = Math.PI * D, pitch = circ / k;
  const s0 = -(o.zoneMm || 3) * tb / 2, rnd = rng(o.seed || 1), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + .5 - w / 2, dy = y + .5 - h / 2, u = dx * c - dy * s - (o.axisDx || 0), v = dx * s + dy * c - o.tipV;
    let val = 45;
    if (Math.abs(u) < R && v >= 0) {
      const a = Math.asin(u / R), sm = D / 2 * a, z = v / ppm;
      val = 60 + 25 * Math.cos(a);
      for (let j = 0; j < k; j++) {
        let d = sm - (s0 + j * pitch + z * tb); d = ((d % circ) + 1.5 * circ) % circ - circ / 2;   // signed arc distance to edge j
        if (d < 0 && d > -.3 * pitch) val = 30;                                                   // flute groove ahead of the edge
        const vb = z <= (o.zoneMm || 3) ? o.vb(z) : 0;
        if (vb > 0 && d >= 0 && d <= vb / cb) val = 200;                                          // flank wear band behind the edge
      }
    }
    val += (rnd() - .5) * 12;
    data.set([val, val, val, 255], 4 * (y * w + x));
  }
  return {width: w, height: h, data};
}

// top view: bright-ish disc of known radius on a dark background
function top(o) {
  const {w, h, D, ppm} = o, r = D / 2 * ppm, rnd = rng(7), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = (x + .5 - o.cx) ** 2 + (y + .5 - o.cy) ** 2 < r * r, val = (inside ? 120 : 40) + (rnd() - .5) * 12;
    data.set([val, val, val, 255], 4 * (y * w + x));
  }
  return {width: w, height: h, data};
}

module.exports = {side, top};
