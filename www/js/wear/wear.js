/* Tool3D wear, browser adapter. Needs wear-core.js loaded first.
 * Tool3D.wear.run(shots, {flutes, diameterMm, helixDeg?, clearanceDeg?, zoneMm?, sens?})
 *   shots: side photos (one per flute, tip up) followed by the top photo; HTMLImageElement / canvas / ImageBitmap.
 * Sets window.Tool3D.wearResult (board contract) and window.Tool3D.wearDebug, fires 'tool3d:wear' on window.
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, W = T.wear;
  const MAX = 2400;   // longest side after downscale; keeps px/mm high enough for VB while bounding run time

  function toImage(src) {
    const w0 = src.naturalWidth || src.videoWidth || src.width, h0 = src.naturalHeight || src.videoHeight || src.height;
    const s = Math.min(1, MAX / Math.max(w0, h0)), w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = Object.assign(document.createElement('canvas'), {width: w, height: h}), x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(src, 0, 0, w, h);
    return x.getImageData(0, 0, w, h);
  }

  W.toImage = toImage;
  // opts.enhance: segment on Tool3D.enhance output (geometry still from the original photo); null when not available
  W.enhanceSides = (sides, opts) => opts && opts.enhance && T.enhance && T.enhance.enhance ? sides.map(s => s && T.enhance.enhance(s)) : null;

  W.run = function (shots, opts) {
    const k = opts.flutes, sides = shots.slice(0, k).filter(Boolean).map(toImage), top = shots[k] ? toImage(shots[k]) : null;
    if (sides.length < k) throw new Error(`wear: need ${k} side photos, got ${sides.length}`);
    const {result, debug} = W.measure(Object.assign({}, opts, {sides, top, enhanced: W.enhanceSides(sides, opts)}));
    T.wearResult = result; T.wearDebug = debug;
    window.dispatchEvent(new CustomEvent('tool3d:wear', {detail: result}));
    return result;
  };

  // strip image of one side with the measured band in red (for a results panel; optional)
  W.overlay = function (i) {
    const e = T.wearDebug && T.wearDebug.strips[i]; if (!e) return null;
    const {strip: {w, h, g}, band} = e, c = Object.assign(document.createElement('canvas'), {width: w, height: h}), x = c.getContext('2d'), im = x.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = g[i] || 0; im.data.set(band[i] ? [255, v * .3, v * .3, 255] : [v, v, v, 255], 4 * i); }
    x.putImageData(im, 0, 0);
    return c;
  };
})();
