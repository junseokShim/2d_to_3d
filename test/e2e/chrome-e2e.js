// Tool3D E2E via Chrome DevTools Protocol over --remote-debugging-pipe (no npm deps).
// Usage: hive/bin/runtime/node.cmd test/e2e/chrome-e2e.js <repo-abs-path> <out-dir>   (writes iso/tip/side/corner/page.png, e2e.json, dl/)
const {spawn} = require('child_process'), fs = require('fs'), path = require('path');
const REPO = process.argv[2], OUT = process.argv[3];
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const prof = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cq-'));
const dl = path.join(OUT, 'dl'); fs.mkdirSync(dl, {recursive: true});
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + prof, '--no-first-run',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,1600', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
const w = ch.stdio[3], r = ch.stdio[4];
let id = 0, buf = '', pend = new Map(), handlers = [];
r.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p[1](new Error(JSON.stringify(m.error))) : p[0](m.result); }
  else handlers.forEach(h => h(m)); } });
const send = (method, params = {}, sessionId) => new Promise((a, b) => { const i = ++id; pend.set(i, [a, b]); w.write(JSON.stringify({id: i, method, params, sessionId}) + '\0'); });
const sleep = ms => new Promise(a => setTimeout(a, ms));
const res = {console: [], errors: [], requests: [], checks: {}};
(async () => {
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId: S} = await send('Target.attachToTarget', {targetId, flatten: true});
  const s = (m, p) => send(m, p, S);
  handlers.push(m => { if (m.sessionId !== S) return;
    if (m.method === 'Runtime.consoleAPICalled') res.console.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') res.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded') res.console.push('log.' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Network.requestWillBeSent') res.requests.push(m.params.request.url.slice(0, 120));
  });
  await s('Runtime.enable'); await s('Log.enable'); await s('Network.enable'); await s('Page.enable'); await s('DOM.enable');
  await send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: dl});
  await s('Emulation.setDeviceMetricsOverride', {width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false});
  await s('Page.navigate', {url: 'file:///' + REPO + '/www/index.html'}); await sleep(2500);
  const ev = async e => { const x = await s('Runtime.evaluate', {expression: e, awaitPromise: true, returnByValue: true}); if (x.exceptionDetails) throw new Error(e + ' -> ' + JSON.stringify(x.exceptionDetails)); return x.result.value; };
  await ev(`document.querySelector('#flutes').value='4';document.querySelector('#flutes').dispatchEvent(new Event('change'));document.querySelector('#dia').value='10';document.querySelector('#dia').dispatchEvent(new Event('change'));1`);
  const {root} = await s('DOM.getDocument');
  const {nodeId} = await s('DOM.querySelector', {nodeId: root.nodeId, selector: '#multi'});
  const smp = ['side1', 'side2', 'side3', 'side4', 'top'].map(n => path.join(REPO, 'test/wear/samples', n + '.png').replace(/\//g, '\\'));
  await s('DOM.setFileInputFiles', {nodeId, files: smp}); await sleep(1500);
  res.checks.slotsFilled = await ev(`[...document.querySelectorAll('#slots .th')].filter(t=>t.querySelector('canvas')).length`);
  await ev(`window.__busySeen=false;new MutationObserver(()=>{if(!document.querySelector('#busy').hidden)window.__busySeen=true}).observe(document.querySelector('#busy'),{attributes:true});document.querySelector('#run').click();1`);
  const tRun = Date.now();
  while (Date.now() - tRun < 240000 && !(await ev(`document.querySelector('#engine').textContent`))) await sleep(500);   // AI wear: model load + inference
  res.checks.runMs = Date.now() - tRun; await sleep(1500); res.checks.spinnerShown = await ev(`window.__busySeen===true&&document.querySelector('#busy').hidden`);
  res.checks.engine = await ev(`document.querySelector('#engine').textContent`);
  res.checks.engineRow = await ev(`[...document.querySelectorAll('#res tr')].some(r=>/엔진/.test(r.textContent)&&/AI \\(PatchCore\\)|classic/.test(r.textContent))`);
  res.checks.wearDebugEngine = await ev(`Tool3D.wearDebug&&Tool3D.wearDebug.engine`);
  res.checks.msg = await ev(`document.querySelector('#msg').textContent`);
  res.checks.resRows = await ev(`document.querySelectorAll('#res tr').length`);
  res.checks.wearResult = await ev(`JSON.stringify(window.Tool3D&&Tool3D.wearResult&&{fl:Tool3D.wearResult.flutes,D:Tool3D.wearResult.diameterMm,n:Tool3D.wearResult.perFlute.length,totals:Tool3D.wearResult.totals,mock:Tool3D.wearResult.mock})`);
  res.checks.renderParams = await ev(`JSON.stringify(Tool3D.render&&Tool3D.render.params)`);
  res.checks.hud = await ev(`document.querySelector('#tool3d-view div').textContent`);
  res.checks.legend = await ev(`document.querySelector('#tool3d-legend').textContent`);
  const shotView = async name => {
    await ev(`Tool3D.render.view('${name}');1`); await sleep(1200);
    const b = await ev(`(()=>{const r=document.querySelector('#tool3d-view').getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]})()`);
    // red pixel count from the WebGL canvas
    res.checks['red_' + name] = await ev(`(()=>{const c=document.querySelector('#tool3d-view canvas'),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const x=t.getContext('2d');x.drawImage(c,0,0);const d=x.getImageData(0,0,t.width,t.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>140&&d[i+1]<80&&d[i+2]<80)n++;return n})()`);
    const {data} = await s('Page.captureScreenshot', {format: 'png', clip: {x: b[0], y: b[1], width: b[2], height: b[3], scale: 1}, captureBeyondViewport: true});
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  };
  for (const v of ['iso', 'tip', 'side', 'corner']) await shotView(v);
  const {data} = await s('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  fs.writeFileSync(path.join(OUT, 'page.png'), Buffer.from(data, 'base64'));
  await ev(`document.querySelector('#dlStl').click();1`); await sleep(2000);
  const stl = path.join(dl, 'tool.stl');
  if (fs.existsSync(stl)) { const b = fs.readFileSync(stl); res.checks.stl = {bytes: b.length, tris: b.readUInt32LE(80), ok: b.length === 84 + 50 * b.readUInt32LE(80)}; }
  else res.checks.stl = 'missing: ' + fs.readdirSync(dl).join(',');
  await ev(`document.querySelector('#dlJson').click();1`); await sleep(1500);
  const jf = path.join(dl, 'result.json'); res.checks.jsonHasWear = fs.existsSync(jf) && !!JSON.parse(fs.readFileSync(jf, 'utf8')).wear;
  await ev(`document.querySelector('#dlInputs').click();1`);
  const zf = path.join(dl, 'tool3d-inputs.zip'); for (let t = 0; t < 20 && !fs.existsSync(zf); t++) await sleep(500);
  if (fs.existsSync(zf)) {   // walk the central directory of the store-only zip; check CRC-free structure + params.json
    const b = fs.readFileSync(zf), e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])), n = b.readUInt16LE(e + 10), names = [];
    for (let o = b.readUInt32LE(e + 16), i = 0; i < n; i++) { const L = b.readUInt16LE(o + 28); names.push(b.toString('utf8', o + 46, o + 46 + L)); o += 46 + L + b.readUInt16LE(o + 30) + b.readUInt16LE(o + 32); }
    const pi = names.indexOf('params.json'), lo = pi < 0 ? -1 : b.readUInt32LE(e + 16) && (() => { let o = b.readUInt32LE(e + 16); for (let i = 0; i < pi; i++) o += 46 + b.readUInt16LE(o + 28) + b.readUInt16LE(o + 30) + b.readUInt16LE(o + 32); return b.readUInt32LE(o + 42); })();
    const params = lo < 0 ? null : JSON.parse(b.toString('utf8', lo + 30 + b.readUInt16LE(lo + 26), lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt32LE(lo + 22)));
    res.checks.exportZip = {bytes: b.length, names, ok: names.length === 6 && /^side1\./.test(names[0]) && /^top\./.test(names[4]) && params && params.flutes === 4 && params.diameterMm === 10};
  } else res.checks.exportZip = 'missing: ' + fs.readdirSync(dl).join(',');
  await ev(`const e=document.querySelector('#sens');e.value='3';e.dispatchEvent(new Event('change'));1`); await sleep(2000);
  res.checks.afterSlider = await ev(`Tool3D.render.params.helixDeg+' rows='+document.querySelectorAll('#res tr').length`);
  const c = res.checks;
  res.pass = {spinner: c.spinnerShown === true, engineLabel: /^Engine: (AI \(PatchCore\)|classic)/.test(c.engine || '') && c.engineRow === true, exportButton: !!(c.exportZip && c.exportZip.ok),
    wear: /"n":4/.test(c.wearResult || ''), stl: !!(c.stl && c.stl.ok), json: c.jsonHasWear === true};
  res.ok = Object.values(res.pass).every(Boolean);
  fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  console.log('E2E ' + (res.ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(res.pass) + ' engine=' + JSON.stringify(c.engine) + ' runMs=' + c.runMs);
  ch.kill(); process.exit(res.ok ? 0 : 1);
})().catch(e => { console.error(e); console.log(JSON.stringify(res, null, 1)); ch.kill(); process.exit(1); });
