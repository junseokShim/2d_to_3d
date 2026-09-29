// In-app camera in headless Chrome with a fake camera (--use-fake-device-for-media-stream). No npm deps.
// Usage: hive/bin/runtime/node.cmd test/capture/cam-chrome.js <repo-abs-path> <out-dir>   (writes cam.png, cam.json)
// Checks: overlay opens, resolution raised, zoom (hardware if the fake track exposes it, else digital crop),
// sharpness meter + hint live, tap-to-focus does not throw, shot = zoomed crop, next side keeps the stream, close.
const {spawn} = require('child_process'), fs = require('fs'), path = require('path');
const REPO = process.argv[2], OUT = process.argv[3]; fs.mkdirSync(OUT, {recursive: true});
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const prof = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cc-'));
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + prof, '--no-first-run',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--window-size=412,900', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
const w = ch.stdio[3], r = ch.stdio[4];
let id = 0, buf = '', pend = new Map(), handlers = [];
r.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p[1](new Error(JSON.stringify(m.error))) : p[0](m.result); }
  else handlers.forEach(h => h(m)); } });
const send = (method, params = {}, sessionId) => new Promise((a, b) => { const i = ++id; pend.set(i, [a, b]); w.write(JSON.stringify({id: i, method, params, sessionId}) + '\0'); });
const sleep = ms => new Promise(a => setTimeout(a, ms));
const res = {errors: [], console: [], checks: {}}, fails = [];
const ok = (name, cond, v) => { res.checks[name] = v === undefined ? cond : v; if (!cond) fails.push(name); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${v === undefined ? '' : JSON.stringify(v)}`); };
(async () => {
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId: S} = await send('Target.attachToTarget', {targetId, flatten: true});
  const s = (m, p) => send(m, p, S);
  handlers.push(m => { if (m.sessionId !== S) return;
    if (m.method === 'Runtime.exceptionThrown') res.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled') res.console.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ')); });
  await s('Runtime.enable'); await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', {width: 412, height: 900, deviceScaleFactor: 1, mobile: true});
  await s('Page.navigate', {url: 'file:///' + REPO + '/www/index.html'}); await sleep(2500);
  const ev = async e => { const x = await s('Runtime.evaluate', {expression: e, awaitPromise: true, returnByValue: true, userGesture: true}); if (x.exceptionDetails) throw new Error(e.slice(0, 80) + ' -> ' + JSON.stringify(x.exceptionDetails).slice(0, 300)); return x.result.value; };
  await ev(`document.querySelector('#slots .slot button').click()`);
  let open = false; for (let t = 0; t < 40 && !open; t++) { await sleep(250); open = await ev(`!document.querySelector('#cam').hidden && Tool3D.capture.isOpen()`); }
  ok('cam opens', open);
  await sleep(1500);
  const info = await ev(`JSON.stringify(Tool3D.capture.info())`).then(JSON.parse);
  ok('video running', info.w > 0 && info.h > 0, [info.w, info.h]);
  res.checks.caps = {zoom: info.caps.zoom || null, width: info.caps.width || null, focusMode: info.focusModes, torch: info.torch, lenses: info.lenses};
  ok('zoom buttons shown', await ev(`document.querySelectorAll('#zbtns button').length`) >= 3);
  const hint = await ev(`document.querySelector('#camhint').textContent`);
  ok('meter live (hint + bar level)', !!hint && /blur|ok|sharp/.test(await ev(`document.querySelector('#sharpbar i').className`)), hint);
  await ev(`document.querySelector('#zbtns button[data-z="3"]').click()`); await sleep(800);
  const z = await ev(`JSON.stringify(Tool3D.capture.info())`).then(JSON.parse);
  ok('zoom 3x applied (hw or digital)', Math.abs(z.zoom - 3) < .01 && (z.hwZoom ? Math.abs((z.settings.zoom || 0) * z.digital - 3) < .2 : Math.abs(z.digital - 3) < .01), {hw: z.hwZoom, settingsZoom: z.settings.zoom, digital: z.digital});
  ok('zoom tag', /3\.0×/.test(await ev(`document.querySelector('#zoomtag').textContent`)), await ev(`document.querySelector('#zoomtag').textContent`));
  // tap to focus at the middle of the preview
  const b = await ev(`(()=>{const r=document.querySelector('#camwrap').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  await s('Input.dispatchMouseEvent', {type: 'mousePressed', x: b[0], y: b[1], button: 'left', clickCount: 1});
  await s('Input.dispatchMouseEvent', {type: 'mouseReleased', x: b[0], y: b[1], button: 'left', clickCount: 1});
  await sleep(500);
  ok('tap focus ring', await ev(`!document.querySelector('#focusring').hidden`));
  const {data} = await s('Page.captureScreenshot', {format: 'png'}); fs.writeFileSync(path.join(OUT, 'cam.png'), Buffer.from(data, 'base64'));
  await ev(`document.querySelector('#hiRes').checked=false; document.querySelector('#shutter').click()`); await sleep(1200);
  const shot = await ev(`(()=>{const c=Tool3D&&document.querySelector('#slots .th canvas');return JSON.stringify({thumb:!!c})})()`).then(JSON.parse);
  ok('slot 1 filled', shot.thumb);
  const dims = await ev(`JSON.stringify(Tool3D.capture.info())`).then(JSON.parse);
  ok('still open for side 2 (stream kept, zoom kept)', await ev(`!document.querySelector('#cam').hidden`) && Math.abs(dims.zoom - 3) < .01 && /측면 2/.test(await ev(`document.querySelector('#camtxt').textContent`)));
  // digital part of the shot = crop: expected shot size = frame / digital
  const sw = await ev(`JSON.stringify([st.shots[0].width, st.shots[0].height, st.hints[0] && st.hints[0].type])`).then(JSON.parse);
  ok('shot is the zoomed crop (native pixels) + hint', Math.abs(sw[0] - dims.w / dims.digital) <= 1 && Math.abs(sw[1] - dims.h / dims.digital) <= 1 && sw[2] === 'side', {shot: sw, frame: [dims.w, dims.h], digital: dims.digital});
  await ev(`document.querySelector('#zbtns button[data-z="1"]').click()`); await sleep(300);
  await ev(`document.querySelector('#camClose').click()`); await sleep(300);
  ok('close stops stream', await ev(`document.querySelector('#cam').hidden && !Tool3D.capture.isOpen()`));
  ok('no page errors', !res.errors.length, res.errors.slice(0, 3));
  fs.writeFileSync(path.join(OUT, 'cam.json'), JSON.stringify(res, null, 1));
  console.log(fails.length ? 'CAM FAIL: ' + fails.join(', ') : 'CAM PASS');
  ch.kill(); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('CAM FAIL', e.message); fs.writeFileSync(path.join(OUT, 'cam.json'), JSON.stringify(res, null, 1)); ch.kill(); process.exit(1); });
