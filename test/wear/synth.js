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

// "Real-like" side photo of a heavily worn coated end mill (RGB), built to reproduce field failures:
// cluttered bright/dark background + fingers, dark AlTiN-like coating, specular glints on the flute margins
// that are brighter than the wear, a worn land of exposed carbide (mid grey, scratched) that is NOT the brightest
// thing on the tool, wear widest at the corner, and a chipped corner. o: side() options + {bg:'dark'|'light', vbTip}
function sideReal(o) {
  const {w, h, D, ppm, flutes: k} = o, t = o.tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), R = D / 2 * ppm;
  const tb = Math.tan(o.helixDeg * Math.PI / 180), cb = Math.cos(o.helixDeg * Math.PI / 180), circ = Math.PI * D, pitch = circ / k;
  const zone = o.zoneMm || 3, s0 = -zone * tb / 2, rnd = rng(o.seed || 1), data = new Uint8ClampedArray(w * h * 4);
  const light = o.bg === 'light', chip = o.chipMm || 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + .5 - w / 2, dy = y + .5 - h / 2, u = dx * c - dy * s - (o.axisDx || 0), v = dx * s + dy * c - o.tipV;
    // background: gradient + blotches; a finger-like blob near the bottom
    let rgb = light ? [205 + 20 * x / w, 200 + 18 * x / w, 190] : [70 + 30 * y / h, 72 + 30 * y / h, 68 + 26 * y / h];
    const fx = (x - w * .3) / (w * .22), fy = (y - h * 1.02) / (h * .16);
    if (fx * fx + fy * fy < 1) rgb = [200, 150, 125];
    const z = v / ppm, a = Math.abs(u) < R ? Math.asin(u / R) : 0, sm = D / 2 * a;
    const chipped = chip && z < chip && Math.abs(u) > R - (chip - z) * ppm * .8 && u > 0;
    if (Math.abs(u) < R && v >= 0 && !chipped) {
      const sh = .55 + .45 * Math.cos(a);
      rgb = [70 * sh, 62 * sh, 78 * sh];                                        // dark violet-grey coating
      for (let j = 0; j < k; j++) {
        let d = sm - (s0 + j * pitch + z * tb); d = ((d % circ) + 1.5 * circ) % circ - circ / 2;
        if (d < 0 && d > -.3 * pitch) rgb = [28, 26, 32];                       // flute groove
        if (d < 0 && d > -.03 * pitch) rgb = [250, 250, 245];                   // specular glint on the edge/margin
        const vb = z <= zone ? o.vb(z) : 0;
        if (vb > 0 && d >= 0 && d <= vb / cb) {                                  // worn land: exposed carbide, scratched
          const scr = 18 * Math.sin((z * 40 + d * 7) * 6.283) * (rnd() - .2);
          rgb = [150 + scr, 150 + scr, 152 + scr];
        }
      }
    }
    const n = (rnd() - .5) * 14;
    data.set([rgb[0] + n, rgb[1] + n, rgb[2] + n, 255], 4 * (y * w + x));
  }
  return {width: w, height: h, data};
}

module.exports.sideReal = sideReal;
