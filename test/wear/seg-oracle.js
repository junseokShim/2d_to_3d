// exact labels in place of the network for seg-wear.js (opts.oracle): each side's label PNG sampled (nearest) into the
// network window as one-hot probabilities, so the same alignment + VB maths can be run on perfect segmentation
'use strict';
module.exports = labels => (i, toPhoto, Wn, Hn) => {
  const L = labels[i], P = Wn * Hn, p = new Float32Array(5 * P);
  for (let Y = 0; Y < Hn; Y++) for (let X = 0; X < Wn; X++) {
    const [x, y] = toPhoto(X, Y), xi = Math.max(0, Math.min(L.w - 1, Math.round(x))), yi = Math.max(0, Math.min(L.h - 1, Math.round(y)));
    const v = L.m[yi * L.w + xi]; p[(v < 5 ? v : 0) * P + Y * Wn + X] = 1;
  }
  return p;
};
