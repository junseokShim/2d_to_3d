// In-app camera helpers (www/js/capture/camera-core.js). Run: node test/capture/run.js   (no dependencies)
'use strict';
const path = require('path');
const C = require('../../www/js/capture/camera-core.js'), readPng = require('../wear/png.js');

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

// ---- digital zoom crop ----
{
  const r = C.cropRect(3840, 2160, 2);
  check('crop 2x centre', r.sx === 960 && r.sy === 540 && r.sw === 1920 && r.sh === 1080, JSON.stringify(r));
  const r1 = C.cropRect(1920, 1080, 1);
  check('crop 1x = full frame', r1.sx === 0 && r1.sy === 0 && r1.sw === 1920 && r1.sh === 1080);
  const rc = C.cropRect(1000, 1000, 4, .98, .01);   // near a corner: stays inside
  check('crop clamps to frame', rc.sx === 750 && rc.sy === 0 && rc.sw === 250, JSON.stringify(rc));
  const r5 = C.cropRect(4032, 3024, 5);
  check('crop 5x keeps native pixels (no resample)', r5.sw === 806 && r5.sh === 605, JSON.stringify(r5));
  check('crop zoom < 1 treated as 1', C.cropRect(100, 50, .5).sw === 100);
  const f = C.fitAspect(4000, 3000, 16 / 9);
  check('fitAspect 4:3 photo -> 16:9 preview', f.sw === 4000 && f.sh === 2250 && f.sy === 375, JSON.stringify(f));
  const f2 = C.fitAspect(1920, 1080, 4 / 3);
  check('fitAspect 16:9 -> 4:3', f2.sw === 1440 && f2.sx === 240 && f2.sh === 1080);
  const s1 = C.splitZoom(3, {min: 1, max: 10});
  check('splitZoom all hardware', s1.hw === 3 && s1.digital === 1);
  const s2 = C.splitZoom(8, {min: 1, max: 4});
  check('splitZoom hw max then digital', s2.hw === 4 && s2.digital === 2);
  const s3 = C.splitZoom(3, null);
  check('splitZoom no hw -> digital', s3.hw === null && s3.digital === 3);
  check('zoomMax', C.zoomMax(null) === 8 && C.zoomMax({min: 1, max: 10}) === 20);
}

// ---- sharpness meter ----
// Gaussian blur (separable) of a grey image, sigma in px: stands in for defocus.
function blur(g, w, h, sigma) {
  if (!sigma) return g;
  const r = Math.ceil(3 * sigma), k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); ks += v; }
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * g[y * w + Math.min(w - 1, Math.max(0, x + i))]; t[y * w + x] = s / ks; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * t[Math.min(h - 1, Math.max(0, y + i)) * w + x]; o[y * w + x] = s / ks; }
  return o;
}
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const noisy = (g, s) => g.map(v => v + (rnd() + rnd() + rnd() - 1.5) * 2 * s);
// synthetic end-mill side: bright body with helical flute edges and fine grinding marks on a dark background
function synthTool(w, h, contrast = 1) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x - w / 2) / (w * .35); let v = 30;
    if (Math.abs(u) < 1) { const ph = (x * .6 + y * .35) / 40; v = 150 + 50 * Math.sign(Math.sin(ph * Math.PI)) + 12 * Math.sin(x * 1.3 + y * .2); }
    g[y * w + x] = 128 + (v - 128) * contrast;
  }
  return g;
}
const W = 384, H = 384;
for (const [name, base] of [['synthetic tool', synthTool(W, H)], ['synthetic tool, low contrast', synthTool(W, H, .35)]]) {
  const sc = [0, 1, 2, 4, 8].map(s => C.sharpness(noisy(blur(base, W, H, s), 2), W, H).score);
  console.log(`# ${name}: scores sigma 0/1/2/4/8 = ${sc.map(v => v.toFixed(3)).join(' / ')}`);
  check(`${name}: score falls with blur (sigma 0-4 strictly, 8 stays low)`, sc.slice(0, 4).every((v, i) => !i || v < sc[i - 1]) && sc[4] < C.ABS_OK);
  check(`${name}: sharp >= ABS_SHARP`, sc[0] >= C.ABS_SHARP, sc[0].toFixed(3));
  check(`${name}: sigma 4 defocus < ABS_OK`, sc[3] < C.ABS_OK, sc[3].toFixed(3));
}
{ // contrast invariance: same scene at 35 % contrast scores within 30 % of full contrast
  const a = C.sharpness(synthTool(W, H), W, H).score, b = C.sharpness(synthTool(W, H, .35), W, H).score;
  check('score roughly contrast-invariant', Math.abs(a - b) / a < .3, `${a.toFixed(3)} vs ${b.toFixed(3)}`);
}
{ // flat noisy view (camera pointed at a wall) never reads sharp
  const flat = noisy(new Float32Array(W * H).fill(120), 3), s = C.sharpness(flat, W, H).score;
  check('flat noisy view below ABS_SHARP', s < C.ABS_SHARP, s.toFixed(3));
}
{ // real sample photo: full-res crop of the tool body is sharp, 3 px defocus is not
  const img = readPng(path.join(__dirname, '../wear/samples/side1.png')), w = img.width, h = img.height, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = .299 * img.data[4 * i] + .587 * img.data[4 * i + 1] + .114 * img.data[4 * i + 2];
  const roi = {x: w * .3, y: h * .1, w: w * .4, h: h * .5};
  const s0 = C.sharpness(g, w, h, roi).score, s3 = C.sharpness(blur(g, w, h, 3), w, h, roi).score;
  console.log(`# side1.png ${w}x${h}: sharp ${s0.toFixed(3)}, sigma 3 ${s3.toFixed(3)}`);
  check('sample: blurred scores < 60 % of sharp', s3 < .6 * s0);
}
{ // meter levels + hints
  const m = new C.Meter();
  const lv = [.3, .31, .05, .3].map(s => m.push(s).level);
  check('meter: sharp, sharp, blur, sharp', lv.join() === 'sharp,sharp,blur,sharp', lv.join());
  m.reset(); check('meter: textureless never green', m.push(.05).level === 'blur');
  m.reset(); m.push(.4); check('meter: 60-85 % of peak = ok', m.push(.3).level === 'ok');
  check('hint: blur at 1x says step back + zoom', /10~15 cm/.test(C.hint('blur', {zoom: 1})) && /줌/.test(C.hint('blur', {zoom: 1})));
  check('hint: blur at 3x says tap to focus', /탭/.test(C.hint('blur', {zoom: 3})));
  check('hint: AF at min distance says step back even zoomed', /10~15 cm/.test(C.hint('blur', {zoom: 3, tooClose: true})));
  check('hint: sharp', /촬영/.test(C.hint('sharp')));
}
{ // motion + lenses + guide
  const a = new Uint8Array(100).fill(10), b = a.map((v, i) => i % 2 ? 14 : 10);
  check('motion', C.motion(a, a) === 0 && C.motion(a, b) === 2 && C.motion(a, null) === Infinity);
  const devs = [{kind: 'audioinput', label: 'mic'}, {kind: 'videoinput', deviceId: 'f', label: 'camera2 1, facing front'},
    {kind: 'videoinput', deviceId: 't', label: 'camera2 2, facing back'}, {kind: 'videoinput', deviceId: 'm', label: 'camera2 0, facing back'}];
  const bc = C.backCameras(devs);
  check('backCameras: rear only, main (id 0) first', bc.length === 2 && bc[0].deviceId === 'm' && bc[1].deviceId === 't' && /기본/.test(bc[0].name), JSON.stringify(bc.map(d => d.deviceId)));
  check('backCameras: unlabeled (no permission yet) kept', C.backCameras([{kind: 'videoinput', deviceId: 'x', label: ''}]).length === 1);
  check('guideSvg side/top', /<path/.test(C.guideSvg({type: 'side', cx: 50, w: 30, y0: 10, y1: 90})) && /<circle/.test(C.guideSvg({type: 'top', cx: 5, cy: 5, r: 2})));
  const r = C.guideRoi({type: 'side', cx: 100, w: 60, y0: 20, y1: 180}, 200, 200);
  check('guideRoi side = tip half of the outline', r.x === 70 && r.y === 20 && r.w === 60 && r.h === 80, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
