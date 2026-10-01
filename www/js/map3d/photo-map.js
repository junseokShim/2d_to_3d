/* Tool3D photo map: true-colour texture of the model surface, projected from the photos (no DOM; browser
 * window.Tool3D.photoMap, Node module.exports).
 *
 * Every texel of the side texture is a point on the nominal model surface (azimuth theta, height z above the tip, radius
 * r = rNom(theta, z)); each side photo i (camera at model azimuth ac = azSign * angleDeg, orthographic) sees it at image
 * column x = axisX + u ppm - .5 with u = r sin(ac - theta), row y = tipY + z ppm - .5 (the map3d face convention, so the photo
 * and the wear map land on the same model points). Views are blended with weight (n . v)^3, n = the model surface normal,
 * v = the view direction; RGB is premultiplied by alpha = coverage; texels no view sees facing it keep alpha 0 (CAD shown there).
 * End texture: the top photo (circle cx, cy, rPx) on the end disc, X = -(x + .5 - cx) / ppm, Y = -(y + .5 - cy) / ppm.
 *
 *   build({views:[{rgb, g, w, h, axisX, tipY, ppm, angleDeg}], top:{data, width, height, cx, cy, rPx}|null, rNom, R, zMax, azSign})
 *     -> {side: {data: Uint8Array RGBA, NA, NZ, zMax}, end: {data, N, R} | null, coverage}
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.photoMap = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = 2 * Math.PI;

  // bilinear RGB at (x, y) in pixel-centre coordinates; null outside the image or on NaN (outside the rectified photo)
  function sample(v, x, y, out) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= v.w || y0 + 1 >= v.h) return false;
    const i = y0 * v.w + x0;
    if (v.g && (v.g[i] !== v.g[i] || v.g[i + 1] !== v.g[i + 1] || v.g[i + v.w] !== v.g[i + v.w] || v.g[i + v.w + 1] !== v.g[i + v.w + 1])) return false;
    const c = v.rgb;
    for (let k = 0; k < 3; k++) out[k] = (c[3 * i + k] * (1 - fx) + c[3 * i + 3 + k] * fx) * (1 - fy) + (c[3 * (i + v.w) + k] * (1 - fx) + c[3 * (i + v.w) + 3 + k] * fx) * fy;
    return true;
  }

  function build(o) {
    const views = (o.views || []).filter(v => v && v.rgb && v.ppm > 0), R = o.R, azSign = o.azSign || -1, rNom = o.rNom;
    if (!views.length || !rNom) return null;
    const ppm = Math.min(...views.map(v => v.ppm));
    const zMax = o.zMax || Math.max(...views.map(v => (v.h - v.tipY) / v.ppm));
    const NA = Math.min(4096, Math.max(256, Math.ceil(TAU * R * ppm / 4) * 4)), NZ = Math.min(2048, Math.max(16, Math.ceil(zMax * ppm)));
    const data = new Uint8Array(NA * NZ * 4), acs = views.map(v => azSign * v.angleDeg * DEG), col = [0, 0, 0], acc = [0, 0, 0];
    const dA = TAU / NA, dz = zMax / NZ;
    let covered = 0;
    for (let i = 0; i < NZ; i++) {
      const z = (i + .5) * dz;
      for (let j = 0; j < NA; j++) {
        const th = (j + .5) * dA, r = rNom(th, z), dr = (rNom(th + .5 * dA, z) - rNom(th - .5 * dA, z)) / dA;
        // outward normal of r(theta) in polar components (radial, tangential), normalised
        const nl = Math.hypot(r, dr) || 1, nr = r / nl, nt = -dr / nl;
        let ws = 0; acc[0] = acc[1] = acc[2] = 0;
        for (let k = 0; k < views.length; k++) {
          const d = th - acs[k], c = Math.cos(d), s = Math.sin(d), nv = nr * c - nt * s;
          if (nv < .15) continue;
          const v = views[k], u = -r * s;
          if (!sample(v, v.axisX + u * v.ppm - .5, v.tipY + z * v.ppm - .5, col)) continue;
          const w = nv * nv * nv; ws += w; acc[0] += w * col[0]; acc[1] += w * col[1]; acc[2] += w * col[2];
        }
        if (ws > 0) {
          const q = 4 * (i * NA + j), al = Math.min(1, ws / .2);   // premultiplied by the coverage alpha (clean filtering at the rim)
          data[q] = al * acc[0] / ws; data[q + 1] = al * acc[1] / ws; data[q + 2] = al * acc[2] / ws; data[q + 3] = Math.round(255 * al);
          covered++;
        }
      }
    }
    let end = null;
    const T = o.top;
    if (T && T.data && T.rPx > 0) {
      const tp = 2 * T.rPx / (2 * R), N = Math.min(1024, Math.max(64, Math.ceil(2 * R * tp))), cell = 2 * R / N, ed = new Uint8Array(N * N * 4);
      const img = {w: T.width, h: T.height, rgb: null, g: null}, rgb = new Uint8Array(T.width * T.height * 3);
      for (let p = 0, q = 0; p < T.width * T.height; p++, q += 4) { rgb[3 * p] = T.data[q]; rgb[3 * p + 1] = T.data[q + 1]; rgb[3 * p + 2] = T.data[q + 2]; }
      img.rgb = rgb;
      for (let yi = 0; yi < N; yi++) for (let xi = 0; xi < N; xi++) {
        const X = -R + (xi + .5) * cell, Y = -R + (yi + .5) * cell;
        if (X * X + Y * Y > R * R) continue;
        if (!sample(img, T.cx - X * tp - .5, T.cy - Y * tp - .5, col)) continue;
        const q = 4 * (yi * N + xi); ed[q] = col[0]; ed[q + 1] = col[1]; ed[q + 2] = col[2]; ed[q + 3] = 255;
      }
      end = {data: ed, N, R};
    }
    return {side: {data, NA, NZ, zMax}, end, coverage: covered / (NA * NZ)};
  }

  return {build, sample};
});
