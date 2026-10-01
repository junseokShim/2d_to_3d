/* Tool3D shot quality check: per-photo sharpness, noise, exposure / clipping, glare, colour cast and px/mm
 * -> verdict pass | warn | fail with retake advice. Pure JS, no DOM; browser (Tool3D.enhance.quality) and Node.
 * Image in: {width, height, data: RGBA}. opts: {diameterMm, align?: wear-core align result, core?: wear-core API}
 *
 * Metrics (all measured, not guessed):
 *  - blurPx: edge spread sigma of the strongest edges (10-90 % rise distance / 2.56 along the gradient). A sharp step
 *    sampled by a camera reads ~0.7-1 px; defocus / shake raises it. In mm (blurMm = blurPx / px-per-mm) it is directly
 *    comparable with VB: a wear land narrower than ~2 blur sigmas cannot be measured.
 *  - noise: Immerkaer (1996) Laplacian-difference estimate of the sensor noise sigma (grey levels), flat areas only.
 *  - exposure: luminance percentiles, clipped-dark / clipped-bright fractions, usable dynamic range.
 *  - glare: saturated (all channels > 245) fraction inside the tool (whole frame if the tool is not located).
 *  - cast: grey-world channel gain spread (|R/G - 1|, |B/G - 1|); corrected by enhance.js, so only a warning.
 *  - pxPerMm: from the tool silhouette (wear-core align) and diameterMm.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.enhance = root.Tool3D.enhance || {}; root.Tool3D.enhance.quality = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const quant = (a, p) => { const b = Float32Array.from(a).sort(); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
  const lum = img => { const {width: w, height: h, data: d} = img, g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2]; return g; };
  const bil = (g, w, h, x, y) => {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  };

  // thresholds; mm limits assume VB of interest >= ~0.1 mm (ISO 8688-2 criterion 0.3 mm)
  const LIM = {
    blurMm: [.06, .12],     // warn, fail: edge sigma in mm
    blurPx: [2, 4],         // used when px/mm is unknown
    noise: [8, 18],         // grey-level sigma
    pxPerMm: [20, 8],       // warn below 20, fail below 8
    darkFrac: [.25, .6], brightFrac: [.02, .08],
    range: [60, 25],        // p99 - p1 luminance: warn, fail below
    glare: [.05, .15],      // saturated fraction inside the tool
    cast: [.15, .35]
  };

  function sobel(g, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      gy[i] = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    }
    return {gx, gy};
  }

  // one profile P (samples every `dt` px, rising along the index) -> Gaussian sigma from the 10-90 % rise distance
  function spread(P, dt) {
    const lo = Math.min(...P.slice(0, 6)), hi = Math.max(...P.slice(-6)), dI = hi - lo;
    if (dI < 25) return null;
    const mid = P.length >> 1, cross = f => {       // first crossing walking out from the centre, linear interpolation
      const v = lo + f * dI;
      if (f < .5) { for (let k = mid; k >= 0; k--) if (P[k] <= v) return k + (P[k + 1] === P[k] ? 0 : (v - P[k]) / (P[k + 1] - P[k])); }
      else for (let k = mid; k < P.length; k++) if (P[k] >= v) return k - 1 + (P[k] === P[k - 1] ? 1 : (v - P[k - 1]) / (P[k] - P[k - 1]));
      return NaN;
    };
    const a = cross(.1), b = cross(.9);
    return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(.25, (b - a) * dt) / 2.563;
  }

  // edge spread across the tool silhouette (long straight edges, the most reliable step in the photo)
  function silhouetteBlur(g, w, h, al) {
    const S = [], R = al.sepPx / 2, n = [Math.cos(al.t), -Math.sin(al.t)];
    for (const uE of [al.uL, al.uR]) for (let v = al.vTip + .3 * R; v < al.vTip + 4 * R; v += 6) {
      const P = new Float64Array(37); let ok = true;           // mean of 6 rows along the edge: noise down, blur kept
      for (let dv = 0; dv < 6 && ok; dv++) { const [x, y] = al.toImg(uE, v + dv); for (let k = 0; k < 37; k++) { const q = bil(g, w, h, x + (k / 2 - 9) * n[0], y + (k / 2 - 9) * n[1]); if (Number.isNaN(q)) { ok = false; break; } P[k] += q / 6; } }
      if (!ok) continue;
      const A = Array.from(P), r = A[36] + A[35] > A[0] + A[1] ? A : A.reverse(), s = spread(r, .5);
      if (s != null) S.push(s);
    }
    return S.length >= 4 ? quant(S, .5) : null;
  }

  // edge spread: profiles across the strongest edge pixels (non-max along the gradient), 10-90 % rise / 2.56 = sigma
  function blurSigma(g, w, h, grad) {
    const {gx, gy} = grad, mag = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);
    const thr = quant(mag.filter((_, i) => i % 7 === 0), .995), cand = [];
    for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) { const i = y * w + x; if (mag[i] >= thr && mag[i] > 40) cand.push(i); }
    const step = Math.max(1, Math.floor(cand.length / 600)), S = [];
    for (let c = 0; c < cand.length; c += step) {
      const i = cand[c], x = i % w, y = i / w | 0, m = mag[i], nx = gx[i] / m, ny = gy[i] / m;
      if (mag[Math.round(y + ny) * w + Math.round(x + nx)] > m || mag[Math.round(y - ny) * w + Math.round(x - nx)] > m) continue;   // not the ridge
      const P = []; for (let t = -9; t <= 9; t += .5) P.push(bil(g, w, h, x + t * nx, y + t * ny));
      if (P.some(Number.isNaN)) continue;
      const v = spread(P, .5); if (v != null) S.push(v);
    }
    return S.length >= 10 ? quant(S, .5) : null;
  }

  // Immerkaer noise estimate on non-edge pixels
  function noiseSigma(g, w, h, grad) {
    const {gx, gy} = grad, mag = new Float32Array(w * h); for (let i = 0; i < w * h; i++) mag[i] = Math.abs(gx[i]) + Math.abs(gy[i]);
    const t = quant(mag.filter((_, i) => i % 5 === 0), .7); let s = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (mag[i] > t) continue;
      s += Math.abs(g[i - w - 1] - 2 * g[i - w] + g[i - w + 1] - 2 * g[i - 1] + 4 * g[i] - 2 * g[i + 1] + g[i + w - 1] - 2 * g[i + w] + g[i + w + 1]); n++;
    }
    return n ? Math.sqrt(Math.PI / 2) * s / (6 * n) : 0;
  }

  function locate(img, o) {
    if (o.align) return o.align;
    const core = o.core || (typeof require === 'function' ? (() => { try { return require('../wear/wear-core.js'); } catch (e) { return null; } })() : null) || (typeof self !== 'undefined' && self.Tool3D && self.Tool3D.wear);
    if (!core || !core.align || !(o.diameterMm > 0)) return null;
    try { const G = core.gray(img); return core.align(G, core.sobel(G), o.diameterMm); } catch (e) { return null; }
  }

  function assess(img, opts = {}) {
    const o = Object.assign({}, opts), {width: w, height: h, data: d} = img, g = lum(img), grad = sobel(g, w, h);
    const m = {};
    m.blurPx = blurSigma(g, w, h, grad); m.noise = noiseSigma(g, w, h, grad);
    const L = g.filter((_, i) => i % 3 === 0);
    m.p1 = quant(L, .01); m.p50 = quant(L, .5); m.p99 = quant(L, .99); m.range = m.p99 - m.p1;
    let dark = 0, br = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < w * h; i++) { const l = g[i]; if (l < 12) dark++; if (d[4 * i] > 250 && d[4 * i + 1] > 250 && d[4 * i + 2] > 250) br++; if (l > 20 && l < 235) { sr += d[4 * i]; sg += d[4 * i + 1]; sb += d[4 * i + 2]; } }
    m.darkFrac = dark / (w * h); m.brightFrac = br / (w * h);
    m.cast = sg ? Math.max(Math.abs(sr / sg - 1), Math.abs(sb / sg - 1)) : 0;
    const al = locate(img, o);
    if (al) {
      m.pxPerMm = al.pxPerMm; m.tiltDeg = al.tiltDeg;
      // glare inside the tool: pixels between the silhouette edges, from the tip down 1 D
      let n = 0, s = 0; const R = al.sepPx / 2;
      for (let v = al.vTip; v < al.vTip + 2 * R; v += 2) for (let u = al.uC - .9 * R; u <= al.uC + .9 * R; u += 2) {
        const [x, y] = al.toImg(u, v), X = Math.round(x), Y = Math.round(y); if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = 4 * (Y * w + X); n++; if (d[j] > 245 && d[j + 1] > 245 && d[j + 2] > 245) s++;
      }
      m.glare = n ? s / n : 0;
      const sb = silhouetteBlur(g, w, h, al); if (sb != null) m.blurPx = sb;
      if (m.blurPx != null) m.blurMm = m.blurPx / al.pxPerMm;
    } else m.glare = m.brightFrac;
    return Object.assign(verdict(m, !!al), {metrics: round(m)});
  }

  const round = m => { const r = {}; for (const k in m) r[k] = m[k] == null ? null : Math.round(m[k] * 1e4) / 1e4; return r; };

  // each check -> ok | warn | fail + retake advice; overall = worst
  function verdict(m, located) {
    const checks = [], add = (key, level, msg, advice) => checks.push({key, level, msg, advice});
    const lv = (v, [a, b], higherBad = true) => higherBad ? (v > b ? 'fail' : v > a ? 'warn' : 'ok') : (v < b ? 'fail' : v < a ? 'warn' : 'ok');
    if (!located) add('silhouette', 'fail', '공구 윤곽을 찾지 못함', '공구를 화면 중앙에 세로로(팁이 위) 두고, 배경은 무지(단색)로, 공구 전체 폭이 보이게 다시 촬영');
    if (m.pxPerMm != null) { const l = lv(m.pxPerMm, LIM.pxPerMm, false); add('pxPerMm', l, `해상도 ${m.pxPerMm.toFixed(1)} px/mm`, l === 'ok' ? '' : '더 가까이(매크로) 또는 확대 촬영: 20 px/mm 이상(1 px = 0.05 mm) 권장'); }
    if (m.blurMm != null || m.blurPx != null) {
      const l = m.blurMm != null ? lv(m.blurMm, LIM.blurMm) : lv(m.blurPx, LIM.blurPx);
      add('sharpness', l, `초점 번짐 σ ${m.blurPx.toFixed(1)} px` + (m.blurMm != null ? ` (${(m.blurMm * 1000).toFixed(0)} µm)` : ''), l === 'ok' ? '' : '날 끝(측면)에 초점을 맞추고(화면 탭), 손떨림 없이 거치대/타이머 사용');
    } else add('sharpness', 'warn', '선명도 측정 불가(강한 경계 없음)', '공구와 배경의 대비가 큰 곳에서 다시 촬영');
    { const l = lv(m.noise, LIM.noise); add('noise', l, `노이즈 σ ${m.noise.toFixed(1)}`, l === 'ok' ? '' : '조명을 밝게 하고 ISO를 낮춰(야간/저조도 모드 끄기) 다시 촬영'); }
    { const r = lv(m.range, LIM.range, false), dk = lv(m.darkFrac, LIM.darkFrac), l = r === 'fail' ? 'fail' : r === 'warn' || dk !== 'ok' ? 'warn' : 'ok';
      add('exposure', l, `노출 범위 ${m.range.toFixed(0)} (어두움 ${(100 * m.darkFrac).toFixed(0)} %)`, l === 'ok' ? '' : '조명을 추가하거나 노출을 올려 공구가 충분히 밝게 보이도록 촬영'); }
    { const l = lv(m.glare, LIM.glare); add('glare', l, `반사(포화) ${(100 * m.glare).toFixed(1)} %`, l === 'ok' ? '' : '직접 조명 대신 확산광(트레이싱지/흰 종이 반사) 사용, 광원 각도를 바꿔 날 끝 반사를 피해서 촬영'); }
    { const l = m.cast > LIM.cast[1] ? 'warn' : 'ok'; add('colour', l, `색 틀어짐 ${(100 * m.cast).toFixed(0)} %`, l === 'ok' ? '' : '자동 보정됨. 가능하면 백색광(주광색) 조명 사용'); }
    const rank = {ok: 0, warn: 1, fail: 2}, worst = checks.reduce((a, c) => rank[c.level] > rank[a] ? c.level : a, 'ok');
    return {verdict: worst === 'ok' ? 'pass' : worst, checks, advice: checks.filter(c => c.level !== 'ok' && c.advice).map(c => c.advice)};
  }

  return {assess, verdict, blurSigma, noiseSigma, LIM};
});
