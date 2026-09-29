// Loads the bundled onnxruntime-web (wasm) + the wear segmentation model in Node for tests. Returns runProbs(x, H, W).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), url = require('url');
const WWW = path.join(__dirname, '..', '..', 'www');
module.exports = async function loadSeg() {
  global.self = global;
  for (const f of ['vendor/ort/ort-wasm-glue.js', 'vendor/ort/ort-wasm-bin.js']) require(path.join(WWW, f));
  require(process.env.SEG_MODEL ? path.resolve(process.env.SEG_MODEL) : path.join(WWW, 'models/wear-seg.onnx.js'));   // SEG_MODEL: compare exports
  const ort = require(path.join(WWW, 'vendor/ort/ort.wasm.min.js')), T = global.Tool3D;
  const glue = path.join(os.tmpdir(), `tool3d-ort-glue-${process.pid}.mjs`); fs.writeFileSync(glue, T.ortGlue);
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmBinary = Buffer.from(T.ortWasmB64, 'base64'); ort.env.wasm.wasmPaths = {mjs: url.pathToFileURL(glue).href};
  const session = await ort.InferenceSession.create(Buffer.from(T.segMicroModelB64 || T.segModelB64, 'base64'), {executionProviders: ['wasm']});   // SEG_MODEL may be the microscope variant
  const run = async (x, H, W) => (await session.run({image: new ort.Tensor('float32', x, [1, 3, H, W])})).probs.data;
  // side-view model as the app runs it (seg-wear.js createSegmenter uses run.side for sides). SEG_SIDE_MODEL=<file.onnx.js>
  // for another export (e.g. a held-out fold), =none for wear-seg on every view; with SEG_MODEL set and no SEG_SIDE_MODEL: none
  const sm = process.env.SEG_SIDE_MODEL || (process.env.SEG_MODEL ? 'none' : path.join(WWW, 'models/wear-seg-side.onnx.js'));
  if (sm !== 'none' && fs.existsSync(sm)) {
    require(path.resolve(sm));
    const sess2 = await ort.InferenceSession.create(Buffer.from(T.segSideModelB64, 'base64'), {executionProviders: ['wasm']});
    T.segSideModelB64 = null;
    run.side = async (x, H, W) => (await sess2.run({image: new ort.Tensor('float32', x, [1, 3, H, W])})).probs.data;
    run.sideModel = path.basename(sm);
  }
  return run;
};
