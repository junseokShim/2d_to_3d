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
  // per-shot quality badges (js/enhance/quality.js) appear under each side slot right after loading
  const qWait = async () => { for (let t = 0; t < 60; t++) { const q = await ev(`JSON.stringify([...document.querySelectorAll('#slots .qbox')].map(b=>[b.dataset.verdict||'',b.querySelector('.qb')?.textContent||'',b.querySelectorAll('.qadv li').length]))`); if (JSON.parse(q).length && JSON.parse(q).every(v => v[0])) return JSON.parse(q); await sleep(250); } return null; };
  res.checks.quality = await qWait();
  await ev(`window.__busySeen=false;new MutationObserver(()=>{if(!document.querySelector('#busy').hidden)window.__busySeen=true}).observe(document.querySelector('#busy'),{attributes:true});document.querySelector('#run').click();1`);
  const tRun = Date.now();
  while (Date.now() - tRun < 240000 && !(await ev(`document.querySelector('#engine').textContent`))) await sleep(500);   // AI wear: model load + inference
  res.checks.runMs = Date.now() - tRun; await sleep(1500); res.checks.spinnerShown = await ev(`window.__busySeen===true&&document.querySelector('#busy').hidden`);
  res.checks.engine = await ev(`document.querySelector('#engine').textContent`);
  res.checks.engineRow = await ev(`[...document.querySelectorAll('#res tr')].some(r=>/엔진/.test(r.textContent)&&/AI \\(Seg\\)|AI \\(PatchCore\\)|classic/.test(r.textContent))`);
  res.checks.wearDebugEngine = await ev(`Tool3D.wearDebug&&Tool3D.wearDebug.engine`);
  res.checks.msg = await ev(`document.querySelector('#msg').textContent`);
  res.checks.resRows = await ev(`document.querySelectorAll('#res tr').length`);
  res.checks.wearResult = await ev(`JSON.stringify(window.Tool3D&&Tool3D.wearResult&&{fl:Tool3D.wearResult.flutes,D:Tool3D.wearResult.diameterMm,n:Tool3D.wearResult.perFlute.length,totals:Tool3D.wearResult.totals,mock:Tool3D.wearResult.mock})`);
  res.checks.renderParams = await ev(`JSON.stringify(Tool3D.render&&Tool3D.render.params)`);
  res.checks.hud = await ev(`document.querySelector('#tool3d-view div').textContent`);
  res.checks.legend = await ev(`document.querySelector('#tool3d-legend').textContent`);
  // per-face segmentation -> 3D (js/map3d), from the real run: 4 sides + top in wearResult.faces, rows in the table
  res.checks.map3dRun = JSON.parse(await ev(`JSON.stringify((()=>{const w=Tool3D.wearResult||{},f=w.faces||[];return {n:f.length,names:f.map(x=>x.face),kinds:f.map(x=>x.kind),areas:f.map(x=>x.areasMm2),totals:w.facesTotals&&{area:w.facesTotals.totalAreaMm2,src:w.facesTotals.source},rows:document.querySelectorAll('#res tr[data-map3d]').length,faceSeg:(Tool3D.faceSeg||[]).length,ms:Tool3D.map3dResult&&Tool3D.map3dResult.ms}})())`));
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
  // ---------- ④ metrology panel (js/metro) ----------
  const mouse = async (type, [x, y], buttons = 1) => s('Input.dispatchMouseEvent', {type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1});
  const clickAt = async p => { await mouse('mouseMoved', p, 0); await mouse('mousePressed', p); await mouse('mouseReleased', p); await sleep(150); };
  await ev(`document.querySelector('#metro').scrollIntoView({block:'start'});Tool3D.metro.select(0);1`); await sleep(400);
  const m = res.checks.metro = {};
  m.rows = await ev(`document.querySelectorAll('#mtTable tr[data-row]').length`);
  m.badge = await ev(`document.querySelector('#mtOverall').textContent`);
  m.matchesWear = await ev(`(()=>{const s=Tool3D.metro.summary(),w=Tool3D.wearResult;return s.flutes.every((e,i)=>!e||Math.abs(e.vbMaxMm-w.perFlute[i].vbMaxMm)<1e-4&&Math.abs(e.vbAvgMm-w.perFlute[i].vbAvgMm)<1e-4)})()`);
  m.hasU = await ev(`Tool3D.metro.summary().flutes.every(e=>!e||e.q.vbMax.U>0&&e.q.vbb.U>0)`);
  // 2-point distance: two image points 20 px apart on the rectified strip -> 20 / (px/mm); kept inside the fitted view (strip can be short and zoomed ~9x)
  await ev(`Tool3D.metro.setTool('dist');1`);
  const [p1, p2, ppm] = await ev(`(()=>{const F=Tool3D.metro.state.F[0],t=F.strip.top+4,x=F.strip.cx-6;return [Tool3D.metro.imgToClient(x,t),Tool3D.metro.imgToClient(x+12,t+16),F.strip.ppm]})()`);
  await clickAt(p1); m.distAfter1 = await ev(`JSON.stringify({n:Tool3D.metro.state.pts.length,tool:Tool3D.metro.state.tool,p1:${JSON.stringify(p1)},r:(()=>{const r=document.querySelector('#mtCanvas').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()})`); await clickAt(p2);
  m.dist = await ev(`JSON.stringify(Tool3D.metro.state.manual.map(x=>[x.kind,x.mm,x.U]))`);
  const dm = JSON.parse(m.dist)[0]; m.distOk = !!dm && dm[0] === 'distance' && Math.abs(dm[1] - 20 / ppm) < .02 * 20 / ppm && dm[2] > 0;
  // VB caliper: point 10 px from the cutting-edge line toward the wear front
  await ev(`Tool3D.metro.setTool('vb');1`);
  const cp = await ev(`(()=>{const F=Tool3D.metro.state.F[0],r=F.n>>1,[x,y]=Tool3D.metro.edgePoint(r);return Tool3D.metro.imgToClient(x+(F.edge==='a'?10:-10),y)})()`);
  await clickAt(cp);
  m.caliper = await ev(`JSON.stringify(Tool3D.metro.state.manual.filter(x=>x.kind==='caliper').map(x=>[x.mm,x.U]))`);
  const cm = JSON.parse(m.caliper)[0]; m.caliperOk = !!cm && cm[0] > .5 * 10 / ppm && cm[0] < 1.2 * 10 / ppm && cm[1] > 0;
  m.readout = await ev(`document.querySelector('#mtReadout').textContent`);
  // Photo / Enhanced toggle: same geometry (canvas size), different pixels; back to Photo afterwards
  const canvasSig = `(()=>{const c=document.querySelector('#mtCanvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let s=0;for(let i=0;i<d.length;i+=16)s+=d[i]+d[i+1]+d[i+2];return s})()`;
  const sig0 = await ev(canvasSig);
  await ev(`document.querySelector('[data-enh="1"]').click();1`); await sleep(400);
  m.enh = await ev(`JSON.stringify({on:Tool3D.metro.state.enh,btn:document.querySelector('[data-enh="1"]').classList.contains('on'),info:Object.values(Tool3D.metro.state.enhImg).map(c=>c.enhanceInfo&&Object.keys(c.enhanceInfo).length),same:Object.values(Tool3D.metro.state.enhImg).every(c=>c.width===Tool3D.metro.stripImage(Tool3D.metro.state.sel).width)})`);
  const sig1 = await ev(canvasSig);
  await ev(`document.querySelector('[data-enh="0"]').click();1`); await sleep(300);
  const sig2 = await ev(canvasSig), me0 = JSON.parse(m.enh);
  m.enhSig = [sig0, sig1, sig2]; m.enhanceOk = me0.on === true && me0.btn && me0.info.length > 0 && me0.same && Math.abs(sig1 - sig0) > .01 * sig0 && Math.abs(sig2 - sig0) < .002 * sig0;   // back to Photo: same frame up to hover overlays
  const {data: mshot} = await s('Page.captureScreenshot', {format: 'png', clip: await ev(`(()=>{const r=document.querySelector('#metro').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`), captureBeyondViewport: true});
  fs.writeFileSync(path.join(OUT, 'metro-measure.png'), Buffer.from(mshot, 'base64'));
  // drag-to-correct: move a wear-front node 8 px outward -> VB of flute 1 grows, 3D contract updated
  await ev(`Tool3D.metro.setTool('edit');1`);
  const before = await ev(`Tool3D.metro.summary().flutes[0].areaMm2`);
  const [n0, dx] = await ev(`(()=>{const S=Tool3D.metro.state,F=S.F[0],side=F.edge==='a'?'b':'a',i=F.nodeRows.length>>1;return [Tool3D.metro.nodeClient(side,i),(side==='b'?8:-8)*S.view.s]})()`);
  await mouse('mouseMoved', n0, 0); await mouse('mousePressed', n0);
  for (let j = 1; j <= 4; j++) await mouse('mouseMoved', [n0[0] + dx * j / 4, n0[1]]);
  await mouse('mouseReleased', [n0[0] + dx, n0[1]]); await sleep(300);
  m.edit = await ev(`JSON.stringify({area:Tool3D.metro.summary().flutes[0].areaMm2,wrArea:Tool3D.wearResult.perFlute[0].areaMm2,vb:Tool3D.metro.summary().flutes[0].vbMaxMm,edited:Tool3D.metro.summary().flutes[0].edited,contract:Tool3D.wearResult.metro,wr:Tool3D.wearResult.perFlute[0].vbMaxMm})`);
  const me = JSON.parse(m.edit); m.editOk = me.edited === true && me.area > before && Math.abs(me.wr - me.vb) < 1e-4 && Math.abs(me.wrArea - me.area) < 1e-4 && me.contract && me.contract.edited === true; m.areaBefore = before;
  // report + CSV + HTML + history
  await ev(`document.querySelector('#mtTool').value='E2E-01';document.querySelector('#mtTool').dispatchEvent(new Event('input'));document.querySelector('#mtOp').value='e2e';document.querySelector('#mtOp').dispatchEvent(new Event('input'));1`);
  const waitFile = async re => { for (let t = 0; t < 30; t++) { const f = fs.readdirSync(dl).find(n => re.test(n) && !/crdownload$/.test(n)); if (f) return path.join(dl, f); await sleep(300); } return null; };
  await ev(`document.querySelector('#mtPdf').click();1`); const pf = await waitFile(/^tool3d-report-E2E-01-.*\.pdf$/);
  if (pf) { const b = fs.readFileSync(pf), t = b.toString('latin1'); m.pdf = {bytes: b.length, ok: t.startsWith('%PDF-1.4') && /\/Count [12]/.test(t) && /\/DCTDecode/.test(t) && /%%EOF/.test(t) && /E2E-01/.test(t), post: /\/Count 2/.test(t) && /Post-processing - Keyence VHX \/ Alicona style/.test(t)}; fs.copyFileSync(pf, path.join(OUT, 'report.pdf')); } else m.pdf = 'missing';
  await ev(`document.querySelector('#mtCsv').click();1`); const cf = await waitFile(/^tool3d-E2E-01-.*\.csv$/);
  m.csv = cf ? (t => ({ok: /VBmax_mm,U_VBmax/.test(t) && /VBC_mm/.test(t) && /manual_measurement/.test(t) && /\n1,/.test(t), lines: t.split('\n').length, post: /keyence_flute,n,u_mm/.test(t) && /edgequality_flute,Nd/.test(t) && /tolerance,value/.test(t)}))(fs.readFileSync(cf, 'utf8')) : 'missing';
  await ev(`document.querySelector('#mtHtml').click();1`); const hf = await waitFile(/^tool3d-report-E2E-01-.*\.html$/);
  m.html = hf ? (t => ({ok: /Tool wear inspection report/.test(t) && /<svg/.test(t) && /data:image\/jpeg/.test(t), bytes: t.length, post: /Post-processing — Keyence VHX style/.test(t) && /Ddmax/.test(t)}))(fs.readFileSync(hf, 'utf8')) : 'missing';
  if (hf) fs.copyFileSync(hf, path.join(OUT, 'report.html'));
  await ev(`document.querySelector('#mtSave').click();document.querySelector('#mtSave').click();1`);
  m.history = await ev(`JSON.parse(localStorage.getItem('tool3d.metro.history')||'{}')['E2E-01']?.length||0`);
  const shotEl = async (sel, name) => { const clip = await ev(`(()=>{const r=document.querySelector('${sel}').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`); const {data} = await s('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true}); fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64')); };
  await shotEl('#metro', 'metro-edit.png');
  await s('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 2, mobile: true}); await sleep(800);
  await ev(`Tool3D.metro.setTool('vb');Tool3D.metro.fit();1`); await sleep(300);
  m.mobileNoHScroll = await ev(`document.documentElement.scrollWidth<=innerWidth+1`);
  await shotEl('#metro', 'metro-mobile.png');
  await s('Emulation.setDeviceMetricsOverride', {width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false}); await sleep(500);
  // ---------- ⑤ post-processing (js/post): Keyence VHX overlay + Alicona deviation / EdgeQuality / trend ----------
  const Pp = res.checks.post = {};
  await ev(`document.querySelector('#post').scrollIntoView({block:'start'});Tool3D.post.setTab('keyence');1`); await sleep(600);
  Object.assign(Pp, JSON.parse(await ev(`JSON.stringify((()=>{const R=Tool3D.post.result,f=R&&R.flutes.filter(Boolean);return {n:f&&f.length,lines:f&&f.map(x=>x.lines.length),vbMaxUm:f&&f.map(x=>x.stats.maxUm),metroVb:Tool3D.metro.summary().flutes.map(e=>e&&Math.round(e.q.vbFlankMax.v*1e5)/100),assist:Tool3D.metro.summary().flutes.map(e=>!!(e&&e.assist)),mag:f&&f[0].mag.label,list:document.querySelectorAll('#pkList tr').length,stats:document.querySelectorAll('#pkStats tr').length,
    ink:(()=>{const c=document.querySelector('#pkCanvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let r=0,b=0;for(let i=0;i<d.length;i+=4){if(d[i]>200&&d[i+1]<90&&d[i+2]<90)r++;if(d[i+2]>200&&d[i]<80&&d[i+1]<90)b++}return {red:r,blue:b}})()}})())`)));
  await shotEl('#post', 'post-keyence.png');
  await ev(`Tool3D.post.setTab('alicona');1`); await sleep(1500);
  Object.assign(Pp, JSON.parse(await ev(`JSON.stringify((()=>{const R=Tool3D.post.result,v=document.querySelector('#paView');return {view:v.dataset.state,devVerts:+v.dataset.devVerts||0,eqRows:document.querySelectorAll('#paEq tr').length,wmm:R.wmm,faces:R.faces.length,tol:R.tol.rows.length,badge:document.querySelector('#psOverall').textContent}})())`)));
  await shotEl('#post', 'post-alicona.png');
  // synthetic chips + flank on the model (map3d mock) -> chip list, deviation colours; two saved results -> tool-life trend
  await ev(`Tool3D.map3d.mock();1`); await sleep(1200);
  await ev(`Tool3D.post.saveHistory();1`); await sleep(300); await ev(`Tool3D.post.saveHistory();1`); await sleep(600);
  Object.assign(Pp, {mock: JSON.parse(await ev(`JSON.stringify((()=>{const R=Tool3D.post.result,v=document.querySelector('#paView');return {chips:R.chips.length,chipSide:R.chips.some(c=>c.where==='side'),chipRows:document.querySelectorAll('#paChips tr').length,Dmin:R.wmm&&R.wmm.DminUm,Vv:R.wmm&&R.wmm.VvMm3,devVerts:+v.dataset.devVerts||0,hist:R.hist.length,trendTag:document.querySelector('#paTrTag').textContent,
    colours:(()=>{const c=v.querySelector('canvas'),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const x=t.getContext('2d');x.drawImage(c,0,0);const d=x.getImageData(0,0,t.width,t.height).data;let g=0,m=0;for(let i=0;i<d.length;i+=4){const r=d[i],G=d[i+1],b=d[i+2];if(G>r+30&&G>b+20)g++;if(b>G+40&&(r>G+20||b>150))m++}return {green:g,blueMag:m}})()}})())`))});
  await shotEl('#post', 'post-alicona-mock.png');
  await ev(`Tool3D.render.setMap(null);Tool3D.post.setTab('keyence');1`); await sleep(300);
  Pp.ok = Pp.n === 4 && Pp.lines.every((n, i) => n >= 1 || Pp.assist[i]) && Pp.lines.some(n => n >= 1) && Pp.vbMaxUm.every((v, i) => Pp.metroVb[i] == null || Math.abs(v - Pp.metroVb[i]) < .06) && /^X\d/.test(Pp.mag) && Pp.list >= 2 && Pp.stats >= 7 && Pp.ink.red > 50 && Pp.ink.blue > 20 &&
    Pp.view === 'ok' && Pp.eqRows === 15 && Pp.tol === 5 && Pp.faces === 5 && !!Pp.wmm && Pp.mock.chips > 0 && Pp.mock.chipSide && Pp.mock.Dmin < 0 && Pp.mock.Vv > 0 && Pp.mock.devVerts > 0 &&
    Pp.mock.colours.green > 500 && Pp.mock.colours.blueMag > 50 && Pp.mock.hist >= 2 && /µm\//.test(Pp.mock.trendTag) && !!(m.pdf && m.pdf.post && m.csv && m.csv.post && m.html && m.html.post);
  // ---------- operator-assisted fallback on degraded low-light photos (auto band empty on every flute) ----------
  const A = res.checks.assisted = {};
  const deg = require('./degraded-inputs.js')(path.join(OUT, 'degraded')).slice(0, 4).map(f => f.replace(/\//g, '\\'));
  await ev(`document.querySelector('#flutes').value='4';document.querySelector('#flutes').dispatchEvent(new Event('change'));document.querySelector('#engine').textContent='';1`);
  await s('DOM.setFileInputFiles', {nodeId, files: deg}); await sleep(1000);
  A.quality = await qWait();
  await ev(`document.querySelector('#run').click();1`);
  const tA = Date.now(); while (Date.now() - tA < 240000 && !(await ev(`document.querySelector('#engine').textContent`)) && !(await ev(`document.querySelector('#msg').textContent`))) await sleep(500);
  await sleep(800);
  A.msg = await ev(`document.querySelector('#msg').textContent`); A.engine = await ev(`document.querySelector('#engine').textContent`);
  await ev(`document.querySelector('#metro').scrollIntoView({block:'start'});document.querySelector('#mtTool').value='E2E-OA';document.querySelector('#mtTool').dispatchEvent(new Event('input'));1`); await sleep(300);
  A.before = JSON.parse(await ev(`JSON.stringify((()=>{const S=Tool3D.metro.state,F=S.F[S.sel],b=document.querySelector('#mtAssist');return {sel:S.sel,tool:S.tool,assist:F&&F.assist,modes:Tool3D.metro.summary().flutes.map(e=>e&&e.mode),banner:!b.hidden&&b.textContent,vb:Tool3D.metro.summary().flutes[S.sel].vbMaxMm,decision:Tool3D.metro.summary().flutes[S.sel].status.decision}})())`));
  const {data: ashot} = await s('Page.captureScreenshot', {format: 'png', clip: await ev(`(()=>{const r=document.querySelector('#metro').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`), captureBeyondViewport: true});
  fs.writeFileSync(path.join(OUT, 'metro-assist.png'), Buffer.from(ashot, 'base64'));
  // operator drags the wear boundary (mid node) 8 px toward the flank
  const [na, dxa] = await ev(`(()=>{const S=Tool3D.metro.state,F=S.F[S.sel],side=F.edge==='a'?'b':'a',i=F.nodeRows.length>>1;return [Tool3D.metro.nodeClient(side,i),(side==='b'?8:-8)*S.view.s]})()`);
  await mouse('mouseMoved', na, 0); await mouse('mousePressed', na);
  for (let j = 1; j <= 4; j++) await mouse('mouseMoved', [na[0] + dxa * j / 4, na[1]]);
  await mouse('mouseReleased', [na[0] + dxa, na[1]]); await sleep(300);
  A.after = JSON.parse(await ev(`JSON.stringify((()=>{const S=Tool3D.metro.state,e=Tool3D.metro.summary().flutes[S.sel],b=document.querySelector('#mtAssist');return {mode:e.mode,vb:e.vbMaxMm,U:e.q.vbMax.U,sigma:e.sigmaPx,banner:b.dataset.mode,table:[...document.querySelectorAll('#mtTable tr[data-row]')][S.sel].textContent,contract:Tool3D.wearResult.metro&&Tool3D.wearResult.metro.modes[S.sel],wr:Tool3D.wearResult.perFlute[S.sel].vbMaxMm}})())`));
  await ev(`document.querySelector('#mtCsv').click();1`); const acf = await waitFile(/^tool3d-E2E-OA-.*\.csv$/);
  A.csv = acf ? (t => ({mode: /,mode\r?\n/.test(t) || /,light,mode/.test(t), oa: /operator-assisted/.test(t)}))(fs.readFileSync(acf, 'utf8')) : 'missing';
  await ev(`document.querySelector('#mtHtml').click();1`); const ahf = await waitFile(/^tool3d-report-E2E-OA-.*\.html$/);
  A.html = ahf ? /operator-assisted/.test(fs.readFileSync(ahf, 'utf8')) : 'missing';
  await ev(`document.querySelector('#mtPdf').click();1`); const apf = await waitFile(/^tool3d-report-E2E-OA-.*\.pdf$/);
  A.pdf = apf ? /\(OA\)|\\\(OA\\\)/.test(fs.readFileSync(apf).toString('latin1')) : 'missing';
  const B = A.before, Af = A.after;
  A.ok = !A.msg && !!B.assist && (/no-band/.test(B.assist.reason) ? B.assist.guess === true : /low-quality/.test(B.assist.reason)) && B.tool === 'edit' && /Drag the wear boundary to measure/.test(B.banner || '') &&
    B.modes.every(x => x === 'awaiting-operator') && B.decision === 'indeterminate' && Af.mode === 'operator-assisted' && Af.vb > 0 && Af.U > 0 && Af.banner === 'operator-assisted' &&
    /operator-assisted/.test(Af.table) && Af.contract === 'operator-assisted' && Math.abs(Af.wr - Af.vb) < 1e-4 && A.csv.mode && A.csv.oa && A.html === true && A.pdf === true;
  // engine faceSeg (board contract, as seg-wear.js will publish): toTool-only faces built from this run's strips + a top face with a
  // chipped end tooth; published after the analysis via 'tool3d:faceseg'. Then: partial seg (2 sides) merges with the pipeline,
  // invalid entries are rejected (the inputs at this point are the degraded assist set, whose run may have no top photo), and a stale faceSeg (new wearResult, no new seg) falls back to the pipeline.
  {
    const E = res.checks.map3dSeg = JSON.parse(await ev(`JSON.stringify((()=>{
      const C=Tool3D.map3dCore,q=Tool3D.render.params,R=q.diameterMm/2,k=q.flutes,out={};
      const contract=f=>{const g=C.normalizeFace(f,R);return {face:f.face,angleDeg:f.angleDeg,w:f.w,h:f.h,mask:f.mask,pxPerMm:f.pxPerMm,toTool:g.toTool,source:'seg-test'}};
      const sides=Tool3D.wearDebug.strips.slice(0,k).map((e,i)=>contract(C.faceFromStrip(e,i,k,q.diameterMm)));
      const ppm=20,N=Math.ceil(2.2*R*ppm),m=new Uint8Array(N*N);
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){const X=(x+.5-N/2)/ppm,Y=(y+.5-N/2)/ppm,r=Math.hypot(X,Y);if(r>R)continue;m[y*N+x]=r>.5*R&&r<.8*R&&Math.abs(Math.atan2(Y,X)-.6)<.2?3:1}
      const top=contract({face:'top',angleDeg:0,w:N,h:N,mask:m,pxPerMm:ppm,cx:N/2,cy:N/2});
      const bad={face:'side2',angleDeg:90,w:10,h:10,mask:new Uint8Array(5),pxPerMm:20,axisX:5,tipY:0};
      const pick=()=>{const r=Tool3D.map3dResult;return {src:r.totals.source,names:r.faces.map(f=>f.face),srcs:r.faces.map(f=>f.source),top:r.faces.find(f=>f.face==='top'),rej:(r.rejected||[]).map(x=>x.why),rows:document.querySelectorAll('#res tr[data-map3d]').length,deform:!!(Tool3D.render.map&&Tool3D.render.volume(false)-Tool3D.render.volume(true)>0)}};
      Tool3D.faceSeg=sides.concat([top]);window.dispatchEvent(new Event('tool3d:faceseg'));out.full=pick();
      Tool3D.faceSeg=sides.slice(0,2).concat([bad]);window.dispatchEvent(new Event('tool3d:faceseg'));out.partial=pick();
      Tool3D.wearResult=Object.assign({},Tool3D.wearResult);window.dispatchEvent(new Event('tool3d:faceseg'));out.stale=pick();
      return out})())`));
    const F = E.full, P = E.partial, St = E.stale;
    E.ok = F.src === 'seg-test' && F.names.join() === 'side1,side2,side3,side4,top' && F.srcs.every(x => x === 'seg-test') && F.top && F.top.areasMm2[3] > .3 && F.deform && F.rows >= 7 &&
      P.src === 'seg-test + wear-pipeline' && P.srcs.slice(0, 4).join() === 'seg-test,seg-test,wear-pipeline,wear-pipeline' && P.rej.join() === 'mask size != w*h' &&
      St.src === 'wear-pipeline' && St.srcs.every(x => x === 'wear-pipeline');
  }
  // map3d deformation: synthetic masks on the current model (mock) -> class colours, chip removes material (render + STL), legend
  {
    const M3 = res.checks.map3d = {};
    Object.assign(M3, JSON.parse(await ev(`JSON.stringify((()=>{const r=Tool3D.map3d.mock();const v0=Tool3D.render.volume(false),v1=Tool3D.render.volume(true);return {faces:r.faces.length,classes:r.totals.areaMm2,chipArea:r.totals.chip.areaMm2,chipVolModel:r.chipVolumeModelMm3,chipVolEst:r.totals.chip.volumeMm3,dv:+(v0-v1).toFixed(4),v0,v1,ms:r.ms,legend:document.querySelector('#tool3d-legend').textContent,hud:document.querySelector('#tool3d-view div').textContent,wrFaces:(Tool3D.wearResult&&Tool3D.wearResult.faces||[]).length,rows:document.querySelectorAll('#res tr[data-map3d]').length}})())`)));
    // STL export = the displayed (deformed) mesh: same closed volume as volume(true), i.e. the intact model (same rows) minus the chip volume
    await ev(`window.__stlVol=()=>{const d=new DataView(Tool3D.render.stl()),n=d.getUint32(80,true);let v=0;for(let t=0;t<n;t++){const o=84+50*t+12,p=j=>d.getFloat32(o+4*j,true);v+=p(0)*(p(4)*p(8)-p(5)*p(7))-p(1)*(p(3)*p(8)-p(5)*p(6))+p(2)*(p(3)*p(7)-p(4)*p(6))}return Math.abs(v/6)};1`);
    M3.stlVolMap = await ev(`__stlVol()`);
    // pixels: grab the WebGL canvas (preserveDrawingBuffer) with and without the map from the same camera; the pixels the map changes
    // are binned by hue (ACES tone mapping shifts the albedo, so no fixed RGB boxes): flank 0-60 deg, adhesion 180-240, chipping 270-360
    await ev(`window.__grab=()=>{const c=document.querySelector('#tool3d-view canvas'),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const x=t.getContext('2d');x.drawImage(c,0,0);return x.getImageData(0,0,t.width,t.height).data};
      window.__cmp=(A,B)=>{const o=[0,0,0];let n=0;for(let i=0;i<A.length;i+=4){if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])<40)continue;n++;const r=A[i]/255,g=A[i+1]/255,b=A[i+2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b);if(mx-mn<.2*mx||mx<.15)continue;const h=60*(mx===r?((g-b)/(mx-mn)+6)%6:mx===g?(b-r)/(mx-mn)+2:(r-g)/(mx-mn)+4);if(h<60)o[0]++;else if(h>=270)o[1]++;else if(h>=180&&h<240)o[2]++}return {n,cls:o}};1`);
    const md = path.join(OUT, 'map3d'); fs.mkdirSync(md, {recursive: true});
    const snap = async name => {
      const b = await ev(`(()=>{const r=document.querySelector('#tool3d-view').getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]})()`);
      const {data} = await s('Page.captureScreenshot', {format: 'png', clip: {x: b[0], y: b[1], width: b[2], height: b[3], scale: 1}, captureBeyondViewport: true});
      fs.writeFileSync(path.join(md, name + '.png'), Buffer.from(data, 'base64'));
    };
    const wearBtn = `[...document.querySelectorAll('#tool3d-view button')].find(b=>b.textContent==='Wear').click();1`;
    const views = [['iso', `'iso'`], ['tip', `'tip'`], ['corner', `'corner'`], ['face90', `'face',{angleDeg:90}`]];
    const r0 = `Tool3D.render.setMap(null);1`, r1 = `Tool3D.render.setMap(Tool3D.map3dResult&&window.__m3r);1`;
    await ev(`window.__m3r=Tool3D.render.map;1`);
    for (const [v, arg] of views) {
      await ev(`Tool3D.render.view(${arg});` + r0); await sleep(900); await ev(`window.__A=__grab();1`);
      await ev(r1); await sleep(900); M3['px_' + v] = await ev(`__cmp(__grab(),__A)`); await snap('mock-' + v);
    }
    // geometry alone (class colours off): the chip scoop must still change the corner / tip render
    await ev(wearBtn);
    for (const [v, arg] of views.slice(1, 3)) {
      await ev(`Tool3D.render.view(${arg});` + r0); await sleep(900); await ev(`window.__A=__grab();1`);
      await ev(r1); await sleep(900); M3['geo_' + v] = await ev(`__cmp(__grab(),__A)`).then(x => x.n); await snap('mock-geometry-' + v);
    }
    await ev(wearBtn);
    await ev(r0); M3.stlDv = +(M3.v0 - M3.stlVolMap).toFixed(4); M3.stlVsModel = +(M3.stlVolMap - M3.v1).toFixed(5);
    const px = views.map(([v]) => M3['px_' + v].cls);
    M3.ok = M3.faces === 5 && M3.chipArea > 0 && M3.chipVolModel > 0 && M3.dv > 0 && Math.abs(M3.dv - M3.chipVolModel) < 1e-3 &&
      Math.abs(M3.chipVolModel / M3.chipVolEst - 1) < .2 && /Flank wear/.test(M3.legend) && /Chipping/.test(M3.legend) && /Adhesion/.test(M3.legend) &&
      M3.wrFaces === 5 && M3.rows >= 7 && px.some(p => p[0] > 200) && px.some(p => p[1] > 200) && px.some(p => p[2] > 200) &&
      M3.geo_tip > 300 && M3.geo_corner > 300 && Math.abs(M3.stlVsModel) < 2e-3 && Math.abs(M3.stlDv / M3.chipVolModel - 1) < .02 && / RH/.test(M3.hud);
    await ev(`Tool3D.render.view('iso');1`);
  }
  // helix hand: default RH (the photo-texture guess is not applied); the toolbar toggle switches to LH (user) and the map follows the new model
  res.checks.hand = JSON.parse(await ev(`JSON.stringify((()=>{const hud=()=>document.querySelector('#tool3d-view div').textContent.split('\\n')[0],btn=()=>[...document.querySelectorAll('#tool3d-view button')].find(b=>/^(RH|LH)$/.test(b.textContent));
    const o={def:hud(),btn0:btn().textContent};Tool3D.map3d.mock();btn().click();o.user=hud();o.btn1=btn().textContent;o.hand1=Tool3D.render.params.hand;o.mapAfter=!!Tool3D.render.map&&Tool3D.map3dResult.faces.length;
    Tool3D.render.hand(null);o.back=hud();o.hand2=Tool3D.render.params.hand;Tool3D.render.setMap(null);return o})())`));
  { const H = res.checks.hand; H.ok = /RH \(default\)/.test(H.def) && H.btn0 === 'RH' && /LH \(user\)/.test(H.user) && H.btn1 === 'LH' && H.hand1 === -1 && H.mapAfter === 5 && /RH \(default\)/.test(H.back) && H.hand2 === 1; }
  // one input path: no camera/microscope choice in step 1 (every photo goes through the camera pipeline)
  res.checks.oneInput = await ev(`!document.querySelector('#inmode') && !document.querySelector('[name=inmode]') && !document.querySelector('#miPanel') && !(window.Tool3D && Tool3D.microUI)`);
  const c = res.checks;
  res.pass = {spinner: c.spinnerShown === true, engineLabel: /^Engine: (AI \(Seg\)|AI \(PatchCore\)|classic)/.test(c.engine || '') && c.engineRow === true, exportButton: !!(c.exportZip && c.exportZip.ok),
    wear: /"n":4/.test(c.wearResult || ''), stl: !!(c.stl && c.stl.ok), json: c.jsonHasWear === true,
    metroPanel: m.rows === 4 && m.matchesWear === true && m.hasU === true && /VBmax/.test(m.badge), metroDistance: m.distOk, metroCaliper: m.caliperOk, metroEdit: m.editOk,
    metroReport: !!(m.pdf && m.pdf.ok && m.csv && m.csv.ok && m.html && m.html.ok), metroHistory: m.history === 2,
    qualityBadges: Array.isArray(c.quality) && c.quality.length === 4 && c.quality.every(v => /pass|warn|fail/.test(v[0]) && v[1]) && Array.isArray(A.quality) && A.quality.length === 4 && A.quality.every(v => v[0] === 'fail' && v[2] > 0),
    enhanceToggle: m.enhanceOk === true, assistedFallback: A.ok === true,
    map3dFaces: !!(c.map3dRun && c.map3dRun.n === 5 && c.map3dRun.names.join() === 'side1,side2,side3,side4,top' && c.map3dRun.rows >= 7 && c.map3dRun.areas.every(a => a && a[2] >= 0)),
    map3dDeform: !!(c.map3d && c.map3d.ok), map3dEngineSeg: !!(c.map3dSeg && c.map3dSeg.ok), helixHand: !!(c.hand && c.hand.ok), oneInputPath: c.oneInput === true, postProcessing: !!(c.post && c.post.ok)};
  res.ok = Object.values(res.pass).every(Boolean);
  fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  console.log('E2E ' + (res.ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(res.pass) + ' engine=' + JSON.stringify(c.engine) + ' runMs=' + c.runMs);
  ch.kill(); process.exit(res.ok ? 0 : 1);
})().catch(e => { console.error(e); console.log(JSON.stringify(res, null, 1)); ch.kill(); process.exit(1); });
