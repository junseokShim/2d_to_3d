// Tool3D render: scanner-style three.js viewer for the parametric end mill.
// Public API (window.Tool3D.render):
//   update(params)   rebuild with measured params {flutes, diameterMm, helixDeg, hand, phaseRad, ...}
//   setWear(result)  same as assigning window.Tool3D.wearResult
//   view(name)       'iso' | 'tip' | 'side' | 'corner' (macro of flute 0's cutting corner)
//   cloud(on)        focus-variation point-cloud look on/off
//   stl()            ArrayBuffer, binary STL in mm, z = tool axis, tip z = 0
//   setMap(r|null)   per-face segmentation map from js/map3d (evaluate() result): class colours + chip deformation
//   volume(deformed) closed-mesh volume (mm3) of the current model, with or without the chip deformation
// It mounts next to #gl, hides the legacy WebGL canvas, and takes over the STL button.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};
  if (!window.THREE) { console.warn('Tool3D render: three.js missing (www/vendor/three)'); return; }

  const $ = s => document.querySelector(s);
  let renderer, scene, camera, controls, group, mesh = null, params = {}, wearSeen, showWear = true, hud, dirty = true, map = null;

  const mat = NS.surface.create(), U = NS.surface.uniforms;
  U.uWearTex.value = NS.wear.tex;

  // atlas (Float32 class probabilities per cell) -> RGBA8 texture, max-pooled down to <= 2048 so thin chips survive
  function atlasTexture(W, H, ch, wrapS) {
    const tw = Math.min(W, 2048), th = Math.min(H, 2048), bx = W / tw, by = H / th, d = new Uint8Array(tw * th * 4);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const o = 4 * (y * tw + x);
      for (let j = Math.floor(y * by); j < Math.min(H, Math.ceil((y + 1) * by)); j++) for (let i = Math.floor(x * bx); i < Math.min(W, Math.ceil((x + 1) * bx)); i++) {
        const k = j * W + i;
        for (let c = 0; c < 3; c++) { const v = 255 * ch[c](k); if (v > d[o + c]) d[o + c] = v; }
      }
      d[o + 3] = 255;
    }
    const t = new THREE.DataTexture(d, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.wrapS = wrapS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
    return t;
  }

  function mount() {
    const old = $('#gl');
    const wrap = document.createElement('div');
    wrap.id = 'tool3d-view';
    wrap.style.cssText = 'position:relative;width:100%;height:460px;border-radius:8px;overflow:hidden;touch-action:none;background:#b9bbbe';
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
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0xdfe8ff, .45); rim.position.set(-5, 2, -4);
    scene.add(key, rim, new THREE.HemisphereLight(0xeef2f6, 0x202226, .25));

    camera = new THREE.PerspectiveCamera(22, 1, .1, 2000);
    const head = new THREE.DirectionalLight(0xffffff, .9);    // coaxial ring light, like a focus-variation scanner
    head.position.set(0, 0, 1); camera.add(head); scene.add(camera);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .12;
    controls.addEventListener('change', () => dirty = true);

    group = new THREE.Group();
    group.rotation.x = Math.PI / 2;           // tool z -> -y: tip up, shank down
    scene.add(group);

    hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;left:10px;top:8px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#15181c;text-shadow:0 1px 1px #fff8;pointer-events:none;white-space:pre';
    wrap.append(hud);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;right:8px;bottom:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px;max-width:calc(100% - 16px)';
    for (const [t, f] of [['Iso', () => view('iso')], ['Tip', () => view('tip')], ['Side', () => view('side')],
      ['Corner', () => view('corner')], ['Wear', () => { showWear = !showWear; repaint(); }], ['Cloud', () => cloud()]]) {
      const b = document.createElement('button');
      b.textContent = t; b.type = 'button';
      b.style.cssText = 'font:12px system-ui;padding:4px 9px;border-radius:5px;border:1px solid #777;background:#2c3036d9;color:#eee;cursor:pointer';
      b.onclick = f; bar.append(b);
    }
    wrap.append(bar);
    const legend = document.createElement('div');
    legend.id = 'tool3d-legend';
    legend.style.cssText = 'position:absolute;left:10px;top:66px;font:11px system-ui;color:#15181c;display:flex;align-items:center;gap:6px;pointer-events:none';
    wrap.append(legend);

    new ResizeObserver(resize).observe(wrap);
    resize();
    loop();
  }

  function gradientBg() {
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#d4d6d8'); g.addColorStop(1, '#8e9195');
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
    const tx = NS.wear.texture(w);
    U.uZMax.value = tx.zMax; U.uVbMax.value = tx.vbMax; U.uRows.value = tx.rows; U.uWearOn.value = showWear && w && !map ? 1 : 0;
    U.uMapOn.value = showWear && map ? 1 : 0;
    const q = mesh.params, t = w && w.totals;
    hud.textContent =
      `Ø ${q.diameterMm.toFixed(2)} mm   ${q.flutes} FL   helix ${(+q.helixDeg).toFixed(1)}° ${q.hand > 0 ? 'RH' : 'LH'}\n` +
      `core ${(q.coreRatio * q.diameterMm).toFixed(2)} mm   rε ${q.cornerRadiusMm.toFixed(2)} mm   rake ${q.rakeDeg}°  clear ${q.clear1Deg}/${q.clear2Deg}°\n` +
      (t ? `VBmax ${t.vbMaxMm.toFixed(3)} mm   A ${t.areaMm2.toFixed(3)} mm²   V ${t.volumeMm3.toFixed(4)} mm³` +
        (w.mock ? '   [MOCK wear]' : '') : 'no wear data');
    const mt = map && map.totals;
    if (mt) hud.textContent += `
faces ${map.faces.length}   flank ${mt.flank.areaMm2.toFixed(3)} mm²   chip ${mt.chip.areaMm2.toFixed(3)} mm² / ${(map.result.chipVolumeModelMm3 ?? mt.chip.volumeMm3).toFixed(4)} mm³   adh ${mt.adhesion.areaMm2.toFixed(3)} mm²` + (map.mock ? '   [MOCK seg]' : '');
    const lg = $('#tool3d-legend');
    const sw = (c, t) => `<span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${c};margin-right:3px;vertical-align:-1px"></span>${t}`;
    if (lg) lg.style.top = (hud.offsetHeight + 14) + 'px';
    if (lg && showWear && mt) lg.innerHTML = [sw('#f59a0d', 'Flank wear'), sw('#c4085a', 'Chipping'), sw('#1473f2', 'Adhesion/BUE')].map(x => `<span data-cls>${x}</span>`).join('');
    else if (lg) lg.innerHTML = showWear && t ? `<span>VB 0</span><span style="width:90px;height:8px;border-radius:2px;background:linear-gradient(90deg,#f2b814,#eb5a08,#c80605)"></span><span>${t.vbMaxMm.toFixed(3)} mm</span>` : '';
    dirty = true;
  }

  function update(p) {
    params = Object.assign({}, params, p || {});
    if (map && (map.params.flutes !== params.flutes || map.params.diameterMm !== params.diameterMm)) setMapState(null);   // stale map
    if (mesh) { group.remove(mesh.obj); Object.values(mesh.parts).forEach(g => g.dispose()); }
    const b = NS.geometry.build(params, map && map.deform);
    const obj = new THREE.Group();
    for (const g of Object.values(b.parts)) obj.add(new THREE.Mesh(g, mat));
    group.add(obj);
    const first = !mesh;
    mesh = Object.assign(b, {obj});
    repaint();
    if (first) view('iso');
    return b.params;
  }

  // World frame: group maps tool (x, y, z) -> (x, -z, y), so the tip is at y = 0 and the shank runs to -y.
  function view(name) {
    if (!mesh) return;
    const q = mesh.params, D = q.diameterMm, R = D / 2;
    let tgt, dir, d;
    if (name === 'corner') {
      // flute 0's cutting corner: radial out, tangential toward the chip flute, from slightly above the end face
      const a = q.phaseRad, cut = q.hand >= 0 ? 1 : -1, rad = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const tan = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(cut);    // toward the tooth body: shows the flank land
      tgt = rad.clone().multiplyScalar(.8 * R).add(new THREE.Vector3(0, -.22 * D, 0));
      dir = rad.clone().multiplyScalar(1).addScaledVector(tan, .45).add(new THREE.Vector3(0, .6, 0));
      d = 2.1 * D;
    } else if (name === 'side') {
      tgt = new THREE.Vector3(0, -1.15 * D, 0); dir = new THREE.Vector3(1, .12, .05); d = 9.8 * D;   // tip clears the HUD
    } else if (name === 'tip') {
      tgt = new THREE.Vector3(0, -.3 * D, 0); dir = new THREE.Vector3(.35, .9, .55); d = 4.1 * D;
    } else {
      tgt = new THREE.Vector3(0, -.6 * D, 0); dir = new THREE.Vector3(.75, .55, .9); d = 4.4 * D;
    }
    camera.position.copy(tgt).addScaledVector(dir.normalize(), d);
    controls.target.copy(tgt); controls.update(); dirty = true;
  }

  function setMapState(r) {
    if (map) { map.sideTex.dispose(); map.endTex.dispose(); }
    map = null; U.uMapOn.value = 0;
    if (!r || !r.atlas || !window.Tool3D.map3dCore) return;
    const S = r.atlas.side, E = r.atlas.end, P = S.prob;
    const sideTex = atlasTexture(S.NA, S.NZ, [k => P[2][k], k => P[3][k], k => P[4][k]], true);
    const endTex = atlasTexture(E.N, E.N, [k => +(E.cls[k] === 2), k => +(E.cls[k] === 3), k => +(E.cls[k] === 4)], false);
    map = {result: r, faces: r.faces, totals: r.totals, mock: !!r.mock, params: r.params || {},
      sideTex, endTex, deform: r.totals.chip.areaMm2 > 0 ? window.Tool3D.map3dCore.deformer(r) : null};
    U.uSideTex.value = sideTex; U.uEndTex.value = endTex; U.uSideZMax.value = S.zMax; U.uMapR.value = E.R;
  }

  function setMap(r) {
    setMapState(r);
    if (mesh) update();
    return !!map;
  }

  // closed-mesh volume (divergence theorem) of the current parameters, with / without the chip deformation;
  // both at the same mesh resolution so their difference is the removed volume
  function volume(deformed = true) {
    if (!mesh) return 0;
    const b = NS.geometry.build(params, deformed && map && map.deform ? map.deform : {side: () => null, end: () => null}, {noNormals: true});
    let v = 0;
    for (const g of Object.values(b.parts)) {
      const p = g.getAttribute('position').array, ix = g.getIndex().array;
      for (let t = 0; t < ix.length; t += 3) {
        const a = 3 * ix[t], c = 3 * ix[t + 1], d = 3 * ix[t + 2];
        v += p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d]);
      }
      g.dispose();
    }
    return Math.abs(v / 6);
  }

  function cloud(on) {
    U.uCloud.value = on === undefined ? 1 - U.uCloud.value : on ? 1 : 0; dirty = true;
    return !!U.uCloud.value;
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

  const api = {update, view, cloud, stl, setMap, volume, refresh: () => repaint(), get map() { return map && map.result; }, setWear: w => { (window.Tool3D = window.Tool3D || {}).wearResult = w; }, get params() { return mesh && mesh.params; }};
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
