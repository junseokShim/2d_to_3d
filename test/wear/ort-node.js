// Loads the bundled onnxruntime-web (wasm) + wear backbone in Node for tests. Returns runFeatures(x, H, W).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), url = require('url');
const WWW = path.join(__dirname, '..', '..', 'www');
module.exports = async function loadOrt() {
  global.self = global;
  for (const f of ['vendor/ort/ort-wasm-glue.js', 'vendor/ort/ort-wasm-bin.js', 'models/wear-backbone.onnx.js']) require(path.join(WWW, f));
  const ort = require(path.join(WWW, 'vendor/ort/ort.wasm.min.js')), T = global.Tool3D;
  const glue = path.join(os.tmpdir(), 'tool3d-ort-glue.mjs'); fs.writeFileSync(glue, T.ortGlue);
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmBinary = Buffer.from(T.ortWasmB64, 'base64'); ort.env.wasm.wasmPaths = {mjs: url.pathToFileURL(glue).href};
  const session = await ort.InferenceSession.create(Buffer.from(T.aiModelB64, 'base64'), {executionProviders: ['wasm']});
  return async (x, H, W) => { const o = (await session.run({image: new ort.Tensor('float32', x, [1, 3, H, W])})).features; return {data: o.data, C: o.dims[1], fh: o.dims[2], fw: o.dims[3]}; };
};
