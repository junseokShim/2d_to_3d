// Tool3D render: scanner-style three.js viewer for the parametric end mill.
// Public API (window.Tool3D.render):
//   update(params)   rebuild with measured params {flutes, diameterMm, helixDeg, hand, phaseRad, ...}
//   setWear(result)  same as assigning window.Tool3D.wearResult
//   view(name)       'iso' | 'tip' | 'side'
//   stl()            ArrayBuffer, binary STL in mm, z = tool axis, tip z = 0
// It mounts next to #gl, hides the legacy WebGL canvas, and takes over the STL button.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};
  if (!window.THREE) { console.warn('Tool3D render: three.js missing (www/vendor/three)'); return; }

  const $ = s => document.querySelector(s);
  let renderer, scene, camera, controls, group, mesh = null, params = {}, wearSeen, showWear = true, hud, dirty = true;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, metalness: .65, roughness: .38, side: THREE.DoubleSide, envMapIntensity: .55
  });

  function mount() {
    const old = $('#gl');
    const wrap = document.createElement('div');
    wrap.id = 'tool3d-view';
    wrap.style.cssText = 'position:relative;width:100%;height:460px;border-radius:8px;overflow:hidden;touch-action:none;background:#2b2e33';
    if (old) { old.style.display = 'none'; old.after(wrap); } else document.body.append(wrap);

    renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .78;
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
    wrap.append(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = gradientBg();
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new THREE.RoomEnvironment(), .03).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0xdfe8ff, .5); rim.position.set(-5, 2, -4);
    scene.add(key, rim, new THREE.HemisphereLight(0xeef2f6, 0x202226, .25));

    camera = new THREE.PerspectiveCamera(22, 1, .1, 2000);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .12;
    controls.addEventListener('change', () => dirty = true);

    group = new THREE.Group();
    group.rotation.x = Math.PI / 2;           // tool z -> -y: tip up, shank down
    scene.add(group);

    hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;left:10px;top:8px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#e8eaee;text-shadow:0 1px 2px #000;pointer-events:none;white-space:pre';
    wrap.append(hud);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;right:8px;top:8px;display:flex;gap:6px';
    for (const [t, f] of [['Iso', () => view('iso')], ['Tip', () => view('tip')], ['Side', () => view('side')],
      ['Wear', () => { showWear = !showWear; repaint(); }]]) {
      const b = document.createElement('button');
      b.textContent = t; b.type = 'button';
      b.style.cssText = 'font:12px system-ui;padding:4px 9px;border-radius:5px;border:1px solid #666;background:#3a3e45cc;color:#eee;cursor:pointer';
      b.onclick = f; bar.append(b);
    }
    wrap.append(bar);
    const legend = document.createElement('div');
    legend.id = 'tool3d-legend';
    legend.style.cssText = 'position:absolute;left:10px;bottom:8px;font:11px system-ui;color:#ddd;display:flex;align-items:center;gap:6px;pointer-events:none';
    wrap.append(legend);

    new ResizeObserver(resize).observe(wrap);
    resize();
    loop();
  }

  function gradientBg() {
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#5a5f66'); g.addColorStop(1, '#1f2226');
    x.fillStyle = g; x.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function resize() {
    const el = renderer.domElement.parentElement, w = el.clientWidth || 600, h = el.clientHeight || 460;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  }

  function loop() {
    requestAnimationFrame(loop);
    const T = window.Tool3D || (window.Tool3D = {});
    if (!T.render) T.render = api;                          // survive `window.Tool3D = {...}` replacements
    if (T.wearResult !== wearSeen) { wearSeen = T.wearResult; repaint(); }
    controls.update();
    if (dirty) { renderer.render(scene, camera); dirty = false; }
  }

  function currentWear() {
    const w = window.Tool3D && window.Tool3D.wearResult;
    if (w && w.perFlute && w.perFlute.length) return w;
    const q = mesh && mesh.params;
    return q ? NS.wear.mock(q.flutes, q.diameterMm) : null;
  }

  function repaint() {
    if (!mesh) return;
    const w = currentWear();
    for (const g of Object.values(mesh.parts)) NS.wear.paint(g, w, showWear);
    const q = mesh.params, t = w && w.totals;
    hud.textContent =
      `Ø ${q.diameterMm.toFixed(2)} mm   ${q.flutes} FL   helix ${(+q.helixDeg).toFixed(1)}° ${q.hand > 0 ? 'RH' : 'LH'}\n` +
      `core ${(q.coreRatio * q.diameterMm).toFixed(2)} mm   rε ${q.cornerRadiusMm.toFixed(2)} mm   rake ${q.rakeDeg}°  clear ${q.clear1Deg}/${q.clear2Deg}°\n` +
      (t ? `VBmax ${t.vbMaxMm.toFixed(3)} mm   A ${t.areaMm2.toFixed(3)} mm²   V ${t.volumeMm3.toFixed(4)} mm³` +
        (w.mock ? '   [MOCK wear]' : '') : 'no wear data');
    const lg = $('#tool3d-legend');
    if (lg) lg.innerHTML = showWear && t ? `<span>VB 0</span><span style="width:90px;height:8px;border-radius:2px;background:linear-gradient(90deg,#c8c8c8,#8a1a14,#db1410)"></span><span>${t.vbMaxMm.toFixed(3)} mm</span>` : '';
    dirty = true;
  }

  function update(p) {
    params = Object.assign({}, params, p || {});
    if (mesh) { group.remove(mesh.obj); Object.values(mesh.parts).forEach(g => g.dispose()); }
    const b = NS.geometry.build(params);
    const obj = new THREE.Group();
    for (const g of Object.values(b.parts)) obj.add(new THREE.Mesh(g, mat));
    group.add(obj);
    const first = !mesh;
    mesh = Object.assign(b, {obj});
    repaint();
    if (first) view('iso');
    return b.params;
  }

  function view(name) {
    if (!mesh) return;
    const D = mesh.params.diameterMm, side = name === 'side';
    const tgt = new THREE.Vector3(0, side ? -1.3 * D : -.55 * D, 0), d = (side ? 8.5 : 4.4) * D;
    const dir = name === 'tip' ? new THREE.Vector3(.35, .9, .55) : name === 'side' ? new THREE.Vector3(1, .12, .05) : new THREE.Vector3(.75, .55, .9);
    camera.position.copy(tgt).addScaledVector(dir.normalize(), d);
    controls.target.copy(tgt); controls.update(); dirty = true;
  }

  function stl() {
    if (!mesh) return null;
    const tris = [];
    for (const g of Object.values(mesh.parts)) {
      const p = g.getAttribute('position').array, ix = g.getIndex().array;
      for (let t = 0; t < ix.length; t += 3) tris.push([ix[t], ix[t + 1], ix[t + 2]].map(i => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]));
    }
    const b = new DataView(new ArrayBuffer(84 + 50 * tris.length));
    b.setUint32(80, tris.length, true);
    tris.forEach((tr, t) => {
      const [A, B, C] = tr, u = B.map((v, i) => v - A[i]), v = C.map((w, i) => w - A[i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
      const o = 84 + 50 * t;
      for (let j = 0; j < 3; j++) b.setFloat32(o + 4 * j, n[j] / l, true);
      tr.forEach((P, k) => P.forEach((c, j) => b.setFloat32(o + 12 + 12 * k + 4 * j, c, true)));
    });
    return b.buffer;
  }

  function saveStl(e) {
    const buf = stl(); if (!buf) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], {type: 'model/stl'}));
    a.download = 'tool.stl'; a.click();
  }

  const api = {update, view, stl, setWear: w => { (window.Tool3D = window.Tool3D || {}).wearResult = w; }, get params() { return mesh && mesh.params; }};
  T3.render = api;

  function init() {
    mount();
    const fl = $('#flutes'), di = $('#dia');
    const fromUi = () => update({flutes: fl ? +fl.value : 4, diameterMm: di ? +di.value : 10, helixDeg: undefined, phaseRad: 0});
    if (fl) fl.addEventListener('change', fromUi);
    if (di) di.addEventListener('change', fromUi);
    document.addEventListener('click', e => { if (e.target && e.target.id === 'dlStl') saveStl(e); }, true);
    fromUi();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
