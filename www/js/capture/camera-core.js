/* Tool3D in-app camera: pure helpers (no DOM). Browser: Tool3D.capture.core; Node: require().
 *
 * Why this exists: a phone main camera cannot focus closer than ~8-15 cm, so a D4-12 end mill filling the frame is
 * always out of focus when the phone is moved close. The fix is "stand back + zoom": hardware zoom where the track
 * exposes it (MediaStreamTrack zoom capability), otherwise a centre crop of the highest-resolution frame (digital
 * zoom that keeps every sensor pixel of the crop), plus a live sharpness meter that tells the user when to step back.
 *
 *  - cropRect(W, H, zoom, cx, cy): source rectangle of a centre (or point) crop for digital zoom, integer, in-bounds.
 *  - fitAspect(W, H, aspect): centre crop of a still photo to the preview aspect (4:3 sensor vs 16:9 preview).
 *  - splitZoom(total, hw): split a requested zoom into hardware part (track zoom range) and digital remainder.
 *  - sharpness(grey, w, h, rect): contrast-normalised Laplacian score (2x2 box pre-filter against sensor noise).
 *    score = sqrt(var(Laplacian)) / (std(grey) + 8). Defocus removes high frequencies but keeps overall contrast, so
 *    the ratio drops with blur and is roughly independent of how bright / contrasty the tool is.
 *  - Meter: running peak tracker -> level 'sharp' | 'ok' | 'blur' + Korean hint (too close -> step back + zoom).
 *  - motion(a, b): mean absolute difference of two small grey thumbnails (for auto-capture "still").
 *  - backCameras(devices): rear video inputs from enumerateDevices, main first.
 *  - guideSvg(g): SVG markup of the framing guide (side outline / top circle).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.capture = root.Tool3D.capture || {}; root.Tool3D.capture.core = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function cropRect(W, H, zoom, cx = .5, cy = .5) {
    const z = Math.max(1, zoom || 1), sw = Math.max(1, Math.round(W / z)), sh = Math.max(1, Math.round(H / z));
    const sx = clamp(Math.round(cx * W - sw / 2), 0, W - sw), sy = clamp(Math.round(cy * H - sh / 2), 0, H - sh);
    return {sx, sy, sw, sh};
  }

  function fitAspect(W, H, aspect) {
    if (!(aspect > 0)) return {sx: 0, sy: 0, sw: W, sh: H};
    if (W / H > aspect) { const sw = Math.round(H * aspect); return {sx: Math.round((W - sw) / 2), sy: 0, sw, sh: H}; }
    const sh = Math.round(W / aspect); return {sx: 0, sy: Math.round((H - sh) / 2), sw: W, sh};
  }

  // hw: {min, max} of the track zoom capability or null. Hardware first (real optical/sensor zoom), digital for the rest.
  function splitZoom(total, hw) {
    const t = Math.max(1, total || 1);
    if (!hw || !(hw.max > hw.min)) return {hw: null, digital: t};
    const h = clamp(t, Math.max(1, hw.min), hw.max);
    return {hw: h, digital: Math.max(1, t / h)};
  }

  const ZOOM_PRESETS = [1, 2, 3, 5];
  const DIGITAL_MAX = 8;
  function zoomMax(hw) { return Math.max(DIGITAL_MAX, hw && hw.max ? hw.max * 2 : 0); }

  function sharpness(g, w, h, rect) {
    const r = rect || {x: 0, y: 0, w, h};
    const x0 = clamp(Math.floor(r.x), 0, w - 2), y0 = clamp(Math.floor(r.y), 0, h - 2);
    const bw = Math.floor((Math.min(w, Math.floor(r.x + r.w)) - x0) / 2), bh = Math.floor((Math.min(h, Math.floor(r.y + r.h)) - y0) / 2);
    if (bw < 3 || bh < 3) return {score: 0, lapStd: 0, std: 0};
    const b = new Float32Array(bw * bh);            // 2x2 box average: sensor noise down, defocus blur (> 2 px) kept
    let s = 0, s2 = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (y0 + 2 * y) * w + x0 + 2 * x, v = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
      b[y * bw + x] = v; s += v; s2 += v * v;
    }
    const n = bw * bh, mean = s / n, std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    let l = 0, l2 = 0, m = 0;
    const hist = new Uint32Array(1024);             // |Laplacian| histogram in 1/4 grey steps, for the noise median
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x, v = b[i - 1] + b[i + 1] + b[i - bw] + b[i + bw] - 4 * b[i];
      l += v; l2 += v * v; m++; hist[Math.min(1023, Math.round(Math.abs(v) * 4))]++;
    }
    // Sensor noise also has a large Laplacian. Edges are sparse, so the median |Laplacian| is mostly noise:
    // for Gaussian noise median|L| = 0.6745 sigma_L. Remove that part of the variance.
    let c = 0, k = 0; while (k < 1023 && (c += hist[k]) < m / 2) k++;
    const nL = k / 4 / .6745, lapVar = Math.max(0, l2 / m - (l / m) * (l / m)), lapStd = Math.sqrt(Math.max(0, lapVar - nL * nL));
    return {score: lapStd / (std + 8), lapStd, std, noiseL: nL};
  }

  // Levels against the running peak (the best this scene has looked since the last lens / zoom change) and an absolute
  // floor: a textureless or wholly defocused view never reaches ABS_OK, so it cannot turn green by being "its own best".
  const ABS_OK = .12, ABS_SHARP = .2;
  function Meter() { this.reset(); }
  Meter.prototype.reset = function () { this.peak = 0; this.n = 0; this.last = 0; };
  Meter.prototype.push = function (score) {
    this.n++; this.last = score;
    this.peak = Math.max(score, this.peak * .997);    // slow decay: a lucky frame does not block green forever
    const rel = this.peak > 0 ? score / this.peak : 0;
    let level = 'blur';
    if (score >= ABS_SHARP && rel >= .85) level = 'sharp';
    else if (score >= ABS_OK && rel >= .6) level = 'ok';
    return {level, score, peak: this.peak, rel};
  };

  // info: {zoom, tooClose (AF parked at its minimum distance), torch}
  function hint(level, info = {}) {
    if (level === 'sharp') return '초점 OK — 촬영하세요';
    if (level === 'ok') return '거의 맞음 — 움직이지 말고 잠시 기다리세요 (공구를 탭하면 그 위치에 초점)';
    if (info.tooClose || (info.zoom || 1) < 2) return '너무 가까우면 초점이 안 맞습니다 — 10~15 cm 뒤로 물러나 줌(2×~3×)으로 확대하세요';
    return '초점이 흐립니다 — 공구를 탭해 초점을 맞추고, 흔들리지 않게 잡으세요';
  }

  function motion(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  // enumerateDevices() video inputs -> rear cameras. Labels (after permission) look like "camera2 0, facing back";
  // camera2 id 0 is the main camera on almost every phone, so it goes first; unlabeled devices are kept at the end.
  function backCameras(devices) {
    const vids = (devices || []).filter(d => d.kind === 'videoinput');
    const back = vids.filter(d => /back|rear|environment|후면|후방/i.test(d.label || ''));
    const list = back.length ? back : vids.filter(d => !/front|user|전면/i.test(d.label || ''));
    const num = d => { const m = /camera\S*\s+(\d+)/i.exec(d.label || ''); return m ? +m[1] : 99; };
    return list.slice().sort((a, b) => num(a) - num(b)).map((d, i) => ({deviceId: d.deviceId, label: d.label || '', name: `후면 ${i + 1}${i === 0 ? ' (기본)' : ''}`}));
  }

  function guideSvg(g) {
    return g.type === 'top'
      ? `<circle class="gd" cx="${g.cx}" cy="${g.cy}" r="${g.r}"/>`
      : `<path class="gd" d="M${g.cx - g.w / 2},${g.y1} V${g.y0 + g.w * .3} Q${g.cx},${g.y0 - g.w * .15} ${g.cx + g.w / 2},${g.y0 + g.w * .3} V${g.y1}"/>`;
  }
  // Region the meter measures, in view (crop) pixels: the tool body inside the guide.
  function guideRoi(g, w, h) {
    if (!g) return {x: w * .3, y: h * .3, w: w * .4, h: h * .4};
    if (g.type === 'top') return {x: g.cx - g.r, y: g.cy - g.r, w: 2 * g.r, h: 2 * g.r};
    return {x: g.cx - g.w / 2, y: g.y0, w: g.w, h: (g.y1 - g.y0) * .5};   // tip half: where the wear land is
  }

  return {cropRect, fitAspect, splitZoom, zoomMax, ZOOM_PRESETS, DIGITAL_MAX, sharpness, Meter, hint, motion, backCameras, guideSvg, guideRoi, ABS_OK, ABS_SHARP};
});
