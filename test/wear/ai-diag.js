// diagnostic (not a test): classic vs AI per side on the ai-run.js inputs; where the AI band sits
'use strict';
const W = require('../../www/js/wear/wear-core.js'), AI = require('../../www/js/wear/ai-wear.js'), synth = require('./synth.js'), loadOrt = require('./ort-node.js');
(async () => {
  const seg = AI.createSegmenter(await loadOrt(), W, {netPx: +(process.argv[3] || 320)});
  const vbs = [.3, .2, .4, .25], vb = m => z => m * (1 - .35 * z / 3);
  const sets = {worn: vbs.map((m, i) => synth.sideReal({w: 420, h: 560, D: 10, ppm: 20, tiltDeg: [2, -3, 1, 0][i], axisDx: 0, tipV: -170, helixDeg: 30, flutes: 4, vb: vb(m), zoneMm: 3, seed: 11 + i + +(process.env.SEED || 0), bg: i % 2 ? 'light' : 'dark'})),
    clean: [0, 1].map(i => synth.sideReal({w: 420, h: 560, D: 10, ppm: 20, tiltDeg: 0, tipV: -170, helixDeg: 30, flutes: 2, vb: () => 0, zoneMm: 3, seed: 40 + i + +(process.env.SEED || 0), bg: 'dark'}))};
  for (const [name, sides] of Object.entries(sets)) {
    const args = {sides, flutes: sides.length, diameterMm: 10, stripMm: +(process.argv[2] || 0) || undefined};
    const C = W.measure(args).result, {result: R, debug} = await W.measureAsync(args, seg, 'ai');
    console.log(name, 'classic', C.perFlute.map(f => f.vbMaxMm).join(' '), '| ai', R.perFlute.map(f => f.vbMaxMm).join(' '));
    debug.strips.forEach((s, i) => {
      const {strip, band} = s, {w, cx, R: Rp, top} = strip; let n = 0, ys = [], xs = [];
      for (let k = 0; k < band.length; k++) if (band[k]) { n++; ys.push(Math.floor(k / w) - top); xs.push(((k % w) - cx) / Rp); }
      const a = debug.ai[i];
      if (process.argv[4]) { const {strip: S, band: B} = s, up = a ? AI.upsample(a.cells, a.fh, a.fw, S, a.sc) : new Float32Array(S.w * S.h), o = new Uint8Array(S.w * S.h * 9), W3 = 3 * S.w;
        for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { const k = y * S.w + x, v = Math.min(255, up[k] * 80);
          for (let c = 0; c < 3; c++) { o[3 * (y * W3 + x) + c] = S.rgb[3 * k + c]; o[3 * (y * W3 + S.w + x) + c] = c ? v * (up[k] > 1.5) : v; o[3 * (y * W3 + 2 * S.w + x) + c] = B[k] ? (c === 1 ? 255 : 0) : S.rgb[3 * k + c]; } }
        module.exports.writePng(`${process.argv[4]}/${name}${i}.png`, W3, S.h, o); }
      if (process.env.ROWS) { const r = []; for (let y = top - 2; y < top + 24; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (band[y * w + x]) { if (a < 0) a = x; b = x; } r.push(a < 0 ? 0 : b - a + 1); } console.log('   rows', r.join(' ')); }
      console.log(`  side${i} px=${n} rows ${Math.min(...ys)}..${Math.max(...ys)} u/R ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)} tau=${a && a.tau.toFixed(2)} max=${a && a.maxScore.toFixed(2)} ${a && a.edge} sep=${a && a.sep} seed=${a && a.seedPx} ppm=${strip.ppm.toFixed(1)}`);
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
// PNG writer for looking at strips: node ai-diag.js <stripMm> <netPx> <outdir>
const zlib = require('zlib'), fs = require('fs');
const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
module.exports.writePng = (file, w, h, rgb) => {
  const raw = Buffer.alloc((3 * w + 1) * h); for (let y = 0; y < h; y++) { raw[y * (3 * w + 1)] = 0; for (let i = 0; i < 3 * w; i++) raw[y * (3 * w + 1) + 1 + i] = rgb[3 * y * w + i]; }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};
