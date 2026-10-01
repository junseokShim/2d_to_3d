// Tool3D render: scanner-style three.js viewer for the parametric end mill.
// Public API (window.Tool3D.render):
//   update(params)   rebuild with measured params {flutes, diameterMm, helixDeg, hand, phaseRad, ...}
//                    helix hand: toolbar RH/LH choice (remembered) > params.hand > wearResult.helixHand (estimator) > RH;
//                    params.handEst (e.g. index.html's photo-texture guess) is only reported, never applied
//   hand(h|null)     user helix hand +1 RH / -1 LH, null = back to the automatic source; fires 'tool3d:params'
//   setWear(result)  same as assigning window.Tool3D.wearResult
//   view(name, o)    'iso' | 'tip' | 'side' | 'corner' (macro of flute 0's cutting corner) | 'face' ({angleDeg}: as side photo angleDeg saw it)
//   cloud(on)        focus-variation point-cloud look on/off
//   stl()            ArrayBuffer, binary STL in mm, z = tool axis, tip z = 0
//   setMap(r|null)   per-face segmentation map from js/map3d (evaluate() result): class colours + chip deformation
//   volume(deformed) closed-mesh volume (mm3) of the current model, with or without the chip deformation
//   mode(name)       display: 'photo' (true-colour texture) | 'dev' (deviation vs nominal, um) | 'height' (r - R, um) | 'cad'
//   setPhoto(o|null) true-colour textures projected from the photos (js/map3d/photo-map.js build() result)
//   setDeviation(dev|null)  deviation fields from js/map3d/surface-metrology.js (side / end grids, mm, <= 0)
//   setLabels([{pos:[x,y,z], text, cls}])  per-flute annotations pinned to tool-frame points
//   profileMode(on)  pick two points on the model -> 'tool3d:profile-line' {p0, p1, part}; clearProfile()
//   snapshot()       PNG data URL of the view with scale bar, ruler and labels burnt in (reports)
// It mounts next to #gl, hides the legacy WebGL canvas, and takes over the STL button.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};
  if (!window.THREE) { console.warn('Tool3D render: three.js missing (www/vendor/three)'); return; }

  const $ = s => document.querySelector(s);
  let renderer, scene, camera, controls, group, mesh = null, params = {}, wearSeen, showWear = true, hud, dirty = true, map = null, handBtn;
  let userHand = null, mode = 'cad', userMode = false, photo = null, dev = null, labels = [], labelEls = [], ruler, scaleEl, pickOn = false, picks = [], pickObj = null, pickDown = null;
  try { const h = +localStorage.getItem('tool3d.hand'); if (h === 1 || h === -1) userHand = h; } catch (e) { /* storage blocked */ }

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
    wrap.style.cssText = 'position:relative;width:100%;height:520px;border-radius:8px;overflow:hidden;touch-action:none;background:#23272d';
    if (old) { old.style.display = 'none'; old.after(wrap); } else document.body.append(wrap);

    renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .85;
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
    hud.style.cssText = 'position:absolute;left:10px;top:8px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#e9edf2;text-shadow:0 1px 2px #000c;pointer-events:none;white-space:pre';
    wrap.append(hud);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;right:8px;bottom:8px;z-index:2;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px;max-width:calc(100% - 16px)';
    for (const [t, f] of [['Iso', () => view('iso')], ['Tip', () => view('tip')], ['Side', () => view('side')],
      ['Corner', () => view('corner')], ['Wear', () => { showWear = !showWear; repaint(); }], ['Cloud', () => cloud()],
      ['RH', () => setHand(mesh && mesh.params.hand > 0 ? -1 : 1)], ['Profile', () => profileMode()]]) {
      const b = document.createElement('button');
      if (t === 'RH') { handBtn = b; b.title = 'Helix hand (click to switch RH / LH)'; }
      b.textContent = t; b.type = 'button';
      b.style.cssText = 'font:12px system-ui;padding:4px 9px;border-radius:5px;border:1px solid #777;background:#2c3036d9;color:#eee;cursor:pointer';
      if (t === 'Profile') b.dataset.profile = '';
      b.onclick = f; bar.append(b);
    }
    wrap.append(bar);
    // display modes (segmented, top right)
    const modes = document.createElement('div');
    modes.id = 'tool3d-modes';
    modes.style.cssText = 'position:absolute;right:8px;top:8px;display:flex;border:1px solid #777;border-radius:6px;overflow:hidden';
    for (const [m, t, tip] of [['photo', 'Photo', '실사 텍스처 (사진 매핑)'], ['dev', 'Deviation', '공칭 형상 대비 편차 (µm)'], ['height', 'Height', '반경 높이 r − R (µm)'], ['cad', 'CAD', '공칭 모델 (재질 표현)']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t; b.title = tip; b.dataset.mode = m;
      b.style.cssText = 'font:12px system-ui;padding:4px 10px;border:0;background:#2c3036d9;color:#ddd;cursor:pointer';
      b.onclick = () => setMode(m, true); modes.append(b);
    }
    wrap.append(modes);
    // colour scale bar (right) and length ruler (bottom left)
    scaleEl = document.createElement('div');
    scaleEl.id = 'tool3d-scale';
    scaleEl.addEventListener('click', e => { const b = e.target.closest('button[data-scale]'); if (b) devScale(+b.dataset.scale); });
    scaleEl.style.cssText = 'position:absolute;right:8px;top:42px;z-index:2;display:none;padding:6px 8px;border-radius:6px;background:#0d1014d9;font:11px/1 ui-monospace,Consolas,monospace;color:#e9edf2;pointer-events:none';
    wrap.append(scaleEl);
    ruler = document.createElement('div');
    ruler.id = 'tool3d-ruler';
    ruler.style.cssText = 'position:absolute;left:12px;bottom:12px;font:11px system-ui;color:#e9edf2;text-shadow:0 1px 2px #000c;pointer-events:none';
    wrap.append(ruler);
    const lab = document.createElement('div');
    lab.id = 'tool3d-labels';
    lab.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    wrap.append(lab);
    renderer.domElement.addEventListener('pointerdown', e => { pickDown = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', e => { if (pickOn && pickDown && Math.hypot(e.clientX - pickDown[0], e.clientY - pickDown[1]) < 5) pick(e); pickDown = null; });
    const legend = document.createElement('div');
    legend.id = 'tool3d-legend';
    legend.style.cssText = 'position:absolute;left:10px;top:66px;font:11px system-ui;color:#e9edf2;text-shadow:0 1px 2px #000c;display:flex;align-items:center;gap:6px;pointer-events:none';
    wrap.append(legend);

    new ResizeObserver(resize).observe(wrap);
    resize();
    loop();
  }

  function gradientBg() {
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#4a5059'); g.addColorStop(.55, '#2a2e35'); g.addColorStop(1, '#16191d');
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
    if (dirty) { renderer.render(scene, camera); overlays(); dirty = false; }
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
      `Ø ${q.diameterMm.toFixed(2)} mm   ${q.flutes} FL   helix ${(+q.helixDeg).toFixed(1)}° ${q.hand > 0 ? 'RH' : 'LH'} (${mesh.handSource})\n` +
      `core ${(q.coreRatio * q.diameterMm).toFixed(2)} mm   rε ${q.cornerRadiusMm.toFixed(2)} mm   rake ${q.rakeDeg}°  clear ${q.clear1Deg}/${q.clear2Deg}°\n` +
      (t ? `VBmax ${t.vbMaxMm.toFixed(3)} mm   A ${t.areaMm2.toFixed(3)} mm²   V ${t.volumeMm3.toFixed(4)} mm³` +
        (w.mock ? '   [MOCK wear]' : '') : 'no wear data');
    const mt = map && map.totals;
    if (mt) hud.textContent += `
faces ${map.faces.length}   flank ${mt.flank.areaMm2.toFixed(3)} mm²   chip ${mt.chip.areaMm2.toFixed(3)} mm² / ${(map.result.chipVolumeModelMm3 ?? mt.chip.volumeMm3).toFixed(4)} mm³   adh ${mt.adhesion.areaMm2.toFixed(3)} mm²` + (map.mock ? '   [MOCK seg]' : '');
    const lg = $('#tool3d-legend');
    const sw = (c, t) => `<span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${c};margin-right:3px;vertical-align:-1px"></span>${t}`;
    if (lg) lg.style.top = (hud.offsetHeight + 14) + 'px';
    scaleBar();
    if (lg && (mode === 'dev' || mode === 'height')) lg.innerHTML = '';
    else if (lg && showWear && mt) lg.innerHTML = [sw('#f59a0d', 'Flank wear'), sw('#c4085a', 'Chipping'), sw('#1473f2', 'Adhesion/BUE')].map(x => `<span data-cls>${x}</span>`).join('');
    else if (lg) lg.innerHTML = showWear && t ? `<span>VB 0</span><span style="width:90px;height:8px;border-radius:2px;background:linear-gradient(90deg,#f2b814,#eb5a08,#c80605)"></span><span>${t.vbMaxMm.toFixed(3)} mm</span>` : '';
    dirty = true;
  }

  function update(p) {
    params = Object.assign({}, params, p || {});
    const est = window.Tool3D && window.Tool3D.wearResult && window.Tool3D.wearResult.helixHand;
    const [hand, handSource] = userHand ? [userHand, 'user'] : params.hand === 1 || params.hand === -1 ? [params.hand, 'set'] :
      est === 1 || est === -1 ? [est, 'estimated'] : [1, 'default'];
    if (map && (map.params.flutes !== params.flutes || map.params.diameterMm !== params.diameterMm)) setMapState(null);   // stale map
    if (mesh) { group.remove(mesh.obj); Object.values(mesh.parts).forEach(g => g.dispose()); }
    const bp = Object.assign({}, params, {hand}), b = NS.geometry.build(bp, map && map.deform);
    b.buildParams = bp;
    b.handSource = handSource;
    if (handBtn) handBtn.textContent = hand > 0 ? 'RH' : 'LH';
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
  function view(name, o = {}) {
    if (!mesh) return;
    const q = mesh.params, D = q.diameterMm, R = D / 2;
    let tgt, dir, d;
    if (name === 'face') {
      // what side photo o.angleDeg saw (js/map3d azimuth convention: model azimuth = -angleDeg), lower flute
      const a = -(+o.angleDeg || 0) * Math.PI / 180;
      tgt = new THREE.Vector3(0, -.45 * D, 0); dir = new THREE.Vector3(Math.cos(a), .25, Math.sin(a)); d = 3.6 * D;
    } else if (name === 'corner') {
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

  function setHand(h) {
    userHand = h === 1 || h === -1 ? h : null;
    try { userHand ? localStorage.setItem('tool3d.hand', String(userHand)) : localStorage.removeItem('tool3d.hand'); } catch (e) { /* storage blocked */ }
    if (mesh) update();
    window.dispatchEvent(new CustomEvent('tool3d:params', {detail: mesh && mesh.params}));
    return mesh && mesh.params.hand;
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
    const b = NS.geometry.build(mesh.buildParams, deformed && map && map.deform ? map.deform : {side: () => null, end: () => null}, {noNormals: true});
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

  // ---------- display modes, photo texture, deviation map ----------
  const MODE = {cad: 0, photo: 1, dev: 2, height: 3};
  function setMode(m, user) {
    if (!(m in MODE)) return mode;
    if (user) userMode = true;
    mode = m; U.uMode.value = MODE[m];
    mat.envMapIntensity = m === 'cad' ? .8 : m === 'photo' ? .45 : .3;
    document.querySelectorAll('#tool3d-modes button').forEach(b => { const on = b.dataset.mode === m; b.style.background = on ? '#3d6fb6' : '#2c3036d9'; b.style.color = on ? '#fff' : '#ddd'; });
    repaint();
    return mode;
  }
  // o = js/map3d/photo-map.js build() result: side {data RGBA, NA, NZ, zMax}, end {data, N, R} | null
  function setPhoto(o) {
    if (photo) { photo.side.dispose(); if (photo.end) photo.end.dispose(); }
    photo = null; U.uPhotoOn.value = 0; U.uPhotoEndOn.value = 0;
    if (o && o.side && o.side.NA) {
      const tex = (d, W, H, wrapS) => {
        const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.wrapS = wrapS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
        t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
        return t;
      };
      photo = {side: tex(o.side.data, o.side.NA, o.side.NZ, true), end: o.end ? tex(o.end.data, o.end.N, o.end.N, false) : null, coverage: o.coverage, src: o};
      U.uPhoto.value = photo.side; U.uPhotoOn.value = 1; U.uPhotoZ.value = o.side.zMax;
      if (photo.end) { U.uPhotoEnd.value = photo.end; U.uPhotoEndOn.value = 1; U.uPhotoR.value = o.end.R; }
    }
    if (!userMode) setMode(photo ? 'photo' : 'cad'); else repaint();
    return !!photo;
  }
  // deviation grids (mm, <= 0) -> R8 textures normalised by the deepest point; scale = symmetric, rounded up to 1/2/5 x 10^n um
  function niceUm(v) { const e = 10 ** Math.floor(Math.log10(Math.max(v, 1))); return [1, 2, 5, 10].map(m => m * e).find(m => m >= v); }
  function setDeviation(d) {
    if (dev) { dev.side.dispose(); dev.end.dispose(); }
    dev = null; U.uDevOn.value = 0;
    if (d && d.side && d.NA) {
      const range = Math.max(1e-6, -(d.minMm || 0)), enc = (src, W, H) => {
        const a = new Uint8Array(W * H * 4);
        for (let k = 0; k < W * H; k++) { a[4 * k] = Math.round(255 * Math.min(1, Math.max(0, -src[k] / range))); a[4 * k + 3] = 255; }
        const t = new THREE.DataTexture(a, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
        return t;
      };
      const side = enc(d.side, d.NA, d.NZ), end = enc(d.end, d.N, d.N);
      side.wrapS = THREE.RepeatWrapping;
      // colour scale from the 95th percentile of the deviated cells, so one deep chip does not flatten the flank wear
      const all = []; for (const a of [d.side, d.end]) for (let k = 0; k < a.length; k++) if (a[k] < 0) all.push(-a[k]);
      all.sort((p, q) => p - q);
      const p95 = all.length ? all[Math.floor(.95 * (all.length - 1))] : range;
      dev = {side, end, range, scaleUm: niceUm(Math.max(5, p95 * 1000))}; dev.autoUm = dev.scaleUm;
      U.uDevSide.value = side; U.uDevEnd.value = end; U.uDevOn.value = 1; U.uDevRange.value = range;
      U.uDevZMax.value = d.NZ * d.dz; U.uDevR.value = d.R; U.uDevScale.value = dev.scaleUm / 1000;
    }
    repaint();
    return !!dev;
  }
  const RAMP = ['#d90d0d', '#ffe600', '#1ad933', '#00bfff', '#0d1ad9'], SB = 'font:11px system-ui;padding:1px 6px;border:1px solid #777;border-radius:4px;background:#2c3036;color:#eee;cursor:pointer';
  function devScale(step) {
    if (!dev) return null;
    const L = [1, 2, 5]; let s = dev.scaleUm;
    if (!step) s = dev.autoUm; else { const e = 10 ** Math.floor(Math.log10(s)), m = Math.round(s / e), i = L.indexOf(m) + step; s = i < 0 ? 5 * e / 10 : i > 2 ? 10 * e : L[i] * e; }
    dev.scaleUm = Math.max(1, s); U.uDevScale.value = dev.scaleUm / 1000; repaint();
    return dev.scaleUm;
  }
  function scaleBar() {
    if (!scaleEl) return;
    const q = mesh && mesh.params;
    let top = null, bot = null, mid = null, title = '';
    if (mode === 'dev') { const s = dev ? dev.scaleUm : 10; top = '+' + s; mid = '0'; bot = '−' + s; title = 'Deviation µm'; }
    else if (mode === 'height' && q) { const h = Math.round((1 - q.coreRatio) * q.diameterMm / 2 * 1000); top = '0'; mid = '−' + Math.round(h / 2); bot = '−' + h; title = 'r − R µm'; }
    if (top == null) { scaleEl.style.display = 'none'; return; }
    scaleEl.style.display = 'flex';
    scaleEl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><span>${title}</span><div style="display:flex;gap:5px;align-items:stretch">` +
      `<div style="display:flex;flex-direction:column;justify-content:space-between;text-align:right;height:180px"><span>${top}</span><span>${mid}</span><span>${bot}</span></div>` +
      `<div data-ramp style="width:14px;height:180px;border:1px solid #ddd;background:linear-gradient(${RAMP.join(',')})"></div></div>` +
      (mode === 'dev' && dev ? `<span style="pointer-events:auto;display:flex;gap:3px"><button type="button" data-scale="-1" title="범위 축소" style="${SB}">−</button><button type="button" data-scale="0" title="자동" style="${SB}">A</button><button type="button" data-scale="1" title="범위 확대" style="${SB}">+</button></span><span>min −${(dev.range * 1000).toFixed(1)}</span>${dev.range * 1000 > dev.scaleUm ? '<span>&lt; −' + dev.scaleUm + ' = blue</span>' : ''}` : mode === 'dev' ? '<span>no data</span>' : '') + '</div>';
  }
  function setLabels(list) { labels = Array.isArray(list) ? list : []; dirty = true; }
  // per redraw: ruler length from the camera, flute labels projected from the tool frame
  const tmpV = new THREE.Vector3();
  function overlays() {
    const w = renderer.domElement.clientWidth || 1, hh = renderer.domElement.clientHeight || 1;
    if (ruler) {
      const d = camera.position.distanceTo(controls.target), mmPerPx = 2 * d * Math.tan(camera.fov * Math.PI / 360) / hh, want = 110 * mmPerPx;
      const e = 10 ** Math.floor(Math.log10(want)), L = [1, 2, 5].map(m => m * e).filter(m => m <= want).pop() || e, px = L / mmPerPx;
      ruler.innerHTML = `<div style="width:${px.toFixed(0)}px;height:6px;border:2px solid #e9edf2;border-top:0"></div><div>${L >= 1 ? +L.toFixed(3) + ' mm' : +(L * 1000).toFixed(1) + ' µm'}</div>`;
    }
    const box = document.querySelector('#tool3d-labels'); if (!box) return;
    while (labelEls.length < labels.length) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);font:11px/1.3 ui-monospace,Consolas,monospace;color:#fff;background:#11151bd0;border:1px solid #8fb4ff;border-radius:4px;padding:2px 6px;white-space:pre';
      box.append(el); labelEls.push(el);
    }
    const eye = camera.position.clone().sub(controls.target);
    labelEls.forEach((el, i) => {
      const L = labels[i];
      if (!L || !mesh) { el.style.display = 'none'; return; }
      tmpV.set(L.pos[0], L.pos[1], L.pos[2]).applyMatrix4(group.matrixWorld);
      const facing = new THREE.Vector3(tmpV.x, 0, tmpV.z).dot(new THREE.Vector3(eye.x, 0, eye.z)) >= 0;   // radial direction vs view
      tmpV.project(camera);
      if (tmpV.z > 1) { el.style.display = 'none'; return; }
      el.style.display = ''; el.textContent = L.text; el.dataset.flute = L.cls || '';
      el.style.left = ((tmpV.x + 1) / 2 * w).toFixed(0) + 'px'; el.style.top = ((1 - tmpV.y) / 2 * hh - 6).toFixed(0) + 'px';
      el.style.opacity = facing ? 1 : .35;
    });
  }

  // ---------- section profile picking ----------
  function profileMode(on) {
    pickOn = on === undefined ? !pickOn : !!on;
    const b = document.querySelector('#tool3d-view button[data-profile]');
    if (b) b.style.background = pickOn ? '#3d6fb6' : '#2c3036d9';
    renderer.domElement.style.cursor = pickOn ? 'crosshair' : '';
    if (pickOn) { picks = []; drawPicks(); }
    return pickOn;
  }
  function clearProfile() { picks = []; drawPicks(); }
  const ray = new THREE.Raycaster();
  function pick(e) {
    if (!mesh) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
    const hit = ray.intersectObjects(mesh.obj.children, false)[0]; if (!hit) return;
    const p = group.worldToLocal(hit.point.clone()), nz = hit.face ? Math.abs(hit.face.normal.z) : 0;
    addPick([p.x, p.y, p.z], nz > .7 && p.z < .2 * mesh.params.diameterMm ? 'end' : 'side');
  }
  // points in the tool frame (mm); also used by tests and the panel presets
  function addPick(p, part) {
    if (picks.length >= 2) picks = [];
    picks.push({p, part: part || 'side'});
    drawPicks();
    if (picks.length === 2) {
      const part = picks[0].part === 'end' && picks[1].part === 'end' ? 'end' : 'side';
      window.dispatchEvent(new CustomEvent('tool3d:profile-line', {detail: {p0: picks[0].p, p1: picks[1].p, part}}));
    }
  }
  function drawPicks() {
    if (pickObj) { group.remove(pickObj); pickObj.traverse(o => { if (o.geometry) o.geometry.dispose(); }); pickObj = null; }
    if (!picks.length || !mesh) { dirty = true; return; }
    pickObj = new THREE.Group();
    const D = mesh.params.diameterMm, mk = new THREE.MeshBasicMaterial({color: 0xffe14d, depthTest: false});
    for (const q of picks) { const s = new THREE.Mesh(new THREE.SphereGeometry(.009 * D, 12, 8), mk); s.position.set(q.p[0], q.p[1], q.p[2]); s.renderOrder = 10; pickObj.add(s); }
    if (picks.length === 2) {
      const pts = [], a = picks[0].p, b = picks[1].p, end = picks[0].part === 'end' && picks[1].part === 'end';
      const ta = Math.atan2(a[1], a[0]), dt = ((Math.atan2(b[1], b[0]) - ta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, ra = Math.hypot(a[0], a[1]), rb = Math.hypot(b[0], b[1]);
      for (let i = 0; i <= 96; i++) {                     // side lines: straight in (azimuth, z) on the surface, as surface-metrology profile() samples
        const t = i / 96, z = a[2] + (b[2] - a[2]) * t;
        if (end) pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z - .002 * D));
        else { const th = ta + dt * t, r = 1.003 * (ra + (rb - ra) * t); pts.push(new THREE.Vector3(r * Math.cos(th), r * Math.sin(th), z)); }
      }
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color: 0xffe14d, depthTest: false}));
      ln.renderOrder = 10; pickObj.add(ln);
    }
    group.add(pickObj); dirty = true;
  }

  // the view with HUD, labels, ruler and scale bar burnt in, as a PNG data URL (reports)
  function snapshot() {
    renderer.render(scene, camera);
    const c = renderer.domElement, out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
    const x = out.getContext('2d'), k = c.width / (c.clientWidth || c.width), wrap = c.parentElement.getBoundingClientRect();
    const X = b => (b.left - wrap.left) * k, Y = b => (b.top - wrap.top) * k;
    x.drawImage(c, 0, 0);
    x.font = `${Math.round(11 * k)}px ui-monospace,Consolas,monospace`; x.textBaseline = 'top';
    const txt = (t, px, py) => { x.fillStyle = '#000b'; x.fillText(t, px + k, py + k); x.fillStyle = '#eef2f6'; x.fillText(t, px, py); };
    const bar = scaleEl && scaleEl.style.display !== 'none' && scaleEl.querySelector('[data-ramp]');
    if (bar) { const b = bar.getBoundingClientRect(), g = x.createLinearGradient(0, Y(b), 0, Y(b) + b.height * k); RAMP.forEach((s, i) => g.addColorStop(i / 4, s)); x.fillStyle = g; x.fillRect(X(b), Y(b), b.width * k, b.height * k); }
    const rl = ruler && ruler.firstElementChild;
    if (rl) { const b = rl.getBoundingClientRect(); x.fillStyle = '#eef2f6'; x.fillRect(X(b), Y(b) + b.height * k - 2 * k, b.width * k, 2 * k); x.fillRect(X(b), Y(b), 2 * k, b.height * k); x.fillRect(X(b) + b.width * k - 2 * k, Y(b), 2 * k, b.height * k); }
    for (const el of labelEls) if (el.style.display !== 'none' && el.textContent) { const b = el.getBoundingClientRect(); x.fillStyle = '#11151bd0'; x.fillRect(X(b), Y(b), b.width * k, b.height * k); }
    const texts = [hud, ...labelEls, ...document.querySelectorAll('#tool3d-legend > span, #tool3d-ruler > div:last-child, #tool3d-scale span')];
    for (const el of texts) {
      if (!el || el.style.display === 'none' || !el.textContent || !el.getClientRects().length) continue;
      const b = el.getBoundingClientRect();
      el.textContent.split('\n').forEach((t, i) => txt(t, X(b) + 3 * k, Y(b) + (2 + 15 * i) * k));
    }
    return out.toDataURL('image/png');
  }

  const api = {update, view, cloud, stl, setMap, hand: setHand, volume, refresh: () => repaint(), mode: m => m ? setMode(m, true) : mode, setPhoto, setDeviation, setLabels, profileMode, clearProfile, addPick, snapshot, get photo() { return photo && photo.src; }, get deviation() { return dev && {rangeUm: dev.range * 1000, scaleUm: dev.scaleUm}; }, devScale, get map() { return map && map.result; }, setWear: w => { (window.Tool3D = window.Tool3D || {}).wearResult = w; }, get params() { return mesh && mesh.params; }};
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
