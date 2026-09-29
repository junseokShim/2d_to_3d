/* Tool3D in-app camera (browser): drives the #cam overlay of index.html. Tool3D.capture.open(opts) / close().
 * opts: {guide(w, h) -> guide object in view pixels, label, onShot(canvas), onFile(File), onError(msg)}
 *
 *  - Resolution: asks for 4K, then raises to the track's width/height max; shots are native pixels.
 *  - Zoom: hardware (track zoom capability, applyConstraints) up to its max, then centre-crop digital zoom on top.
 *    Pinch, slider and 1x/2x/3x/5x buttons. The shot is exactly the zoomed view (crop of the full frame).
 *  - Focus: continuous AF; tap = point of interest + single-shot AF where supported (back to continuous after 3 s);
 *    manual focus-distance slider where the track exposes it. AF parked at its minimum distance => "too close".
 *  - Lens: rear cameras from enumerateDevices, user can switch (remembered). Torch toggle when supported.
 *  - Sharpness meter (camera-core.js) on the tool region at native pixels; shutter green when sharp;
 *    optional auto-capture when sharp and still. ImageCapture.takePhoto for a full-sensor still when it is larger.
 *  - Native camera app (input capture=environment) as an alternative: it has the phone's own macro mode.
 */
(function () {
  'use strict';
  const C = window.Tool3D.capture.core, $ = s => document.querySelector(s);
  const cv = (w, h) => Object.assign(document.createElement('canvas'), {width: w, height: h});
  const LS = 'tool3d.cam.lens';
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const S = {stream: null, track: null, caps: {}, hw: null, zoom: 1, digital: 1, meter: new C.Meter(), lenses: [], lensId: null,
    torch: false, opts: null, timer: 0, busy: false, prevThumb: null, stillSince: 0, lastShot: 0, afTimer: 0, zoomPending: 0};
  const roiCv = cv(384, 384), roiCx = roiCv.getContext('2d', {willReadFrequently: true});
  const thCv = cv(32, 24), thCx = thCv.getContext('2d', {willReadFrequently: true});

  const info = () => {
    const s = S.track && S.track.getSettings ? S.track.getSettings() : {};
    return {caps: S.caps, settings: s, hwZoom: S.hw, zoom: S.zoom, digital: S.digital, lenses: S.lenses.length, lensId: S.lensId,
      torch: !!S.caps.torch, focusModes: S.caps.focusMode || [], w: $('#video').videoWidth, h: $('#video').videoHeight};
  };

  async function getStream(deviceId) {
    const base = {width: {ideal: 3840}, height: {ideal: 2160}};
    const v = deviceId ? {...base, deviceId: {exact: deviceId}} : {...base, facingMode: {ideal: 'environment'}};
    const tries = [{...v, zoom: true}, v, deviceId ? null : {facingMode: 'environment'}, deviceId ? null : true].filter(Boolean);
    let err;
    for (const t of tries) {
      try { return await navigator.mediaDevices.getUserMedia({video: t, audio: false}); }
      catch (e) { err = e; if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; }
    }
    throw err;
  }

  async function start(deviceId) {
    stopStream();
    S.stream = await getStream(deviceId);
    S.track = S.stream.getVideoTracks()[0];
    S.caps = (S.track.getCapabilities && S.track.getCapabilities()) || {};
    const set = S.track.getSettings ? S.track.getSettings() : {};
    S.lensId = set.deviceId || deviceId || null;
    // highest resolution the track offers (many phones cap getUserMedia at 1080p unless asked for more)
    if (S.caps.width && S.caps.height && S.caps.width.max > (set.width || 0))
      await S.track.applyConstraints({width: {ideal: S.caps.width.max}, height: {ideal: S.caps.height.max}}).catch(() => {});
    if ((S.caps.focusMode || []).includes('continuous')) await S.track.applyConstraints({advanced: [{focusMode: 'continuous'}]}).catch(() => {});
    S.hw = S.caps.zoom && S.caps.zoom.max > S.caps.zoom.min ? {min: S.caps.zoom.min, max: S.caps.zoom.max, step: S.caps.zoom.step || .1} : null;
    S.torch = false;
    const v = $('#video'); v.srcObject = S.stream; await v.play().catch(() => {});
    if (!v.videoWidth) await new Promise(a => { v.onloadedmetadata = a; setTimeout(a, 3000); });
    await listLenses();
    buildControls();
    await setZoom(S.zoom);
  }
  function stopStream() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = S.track = null;
  }

  async function listLenses() {
    try { S.lenses = C.backCameras(await navigator.mediaDevices.enumerateDevices()); } catch (e) { S.lenses = []; }
    const sel = $('#lens');
    sel.hidden = S.lenses.length < 2;
    sel.innerHTML = S.lenses.map(l => `<option value="${l.deviceId}"${l.deviceId === S.lensId ? ' selected' : ''} title="${l.label}">${l.name}</option>`).join('');
  }

  function buildControls() {
    const zmax = C.zoomMax(S.hw), zr = $('#zoom');
    zr.max = zmax; zr.step = .1;
    $('#zbtns').innerHTML = C.ZOOM_PRESETS.filter(z => z <= zmax).map(z => `<button data-z="${z}">${z}×</button>`).join('');
    $('#torch').hidden = !S.caps.torch;
    $('#torch').classList.toggle('on', S.torch);
    const fd = S.caps.focusDistance, manual = (S.caps.focusMode || []).includes('manual');
    $('#mfocus').hidden = !(fd && manual && fd.max > fd.min);
    if (fd) Object.assign($('#focusDist'), {min: fd.min, max: fd.max, step: fd.step || (fd.max - fd.min) / 100});
  }

  // ---- zoom ----
  async function setZoom(z) {
    z = Math.max(1, Math.min(C.zoomMax(S.hw), +z || 1));
    const changed = Math.abs(z - S.zoom) > .05;
    S.zoom = z;
    const sp = C.splitZoom(z, S.hw);
    S.digital = sp.digital;
    if (sp.hw != null && S.track) {
      const want = sp.hw, t = ++S.zoomPending;          // coalesce pinch updates
      await S.track.applyConstraints({advanced: [{zoom: want}]}).catch(e => console.warn('zoom:', e));
      if (t !== S.zoomPending) return;
    }
    layout();
    $('#zoom').value = z;
    $('#zoomtag').textContent = `${z.toFixed(1)}×` + (sp.hw != null ? (sp.digital > 1.01 ? ' (광학+디지털)' : ' (광학)') : ' (디지털)');
    [...$('#zbtns').children].forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.z - z) < .05));
    if (changed) { S.meter.reset(); S.prevThumb = null; }
  }

  // View = centre crop of the frame (digital zoom). The guide is drawn in crop pixels, so a shot's hints match it.
  function crop() { const v = $('#video'); return C.cropRect(v.videoWidth || 1, v.videoHeight || 1, S.digital); }
  function layout() {
    const v = $('#video'), r = crop();
    v.style.transform = S.digital > 1.001 ? `scale(${S.digital})` : '';
    const g = S.opts && S.opts.guide ? S.opts.guide(r.sw, r.sh) : null, svg = $('#guide');
    svg.setAttribute('viewBox', `0 0 ${r.sw} ${r.sh}`);
    svg.innerHTML = g ? C.guideSvg(g) : '';
    $('#camtxt').textContent = (S.opts && S.opts.label) || '';
  }

  // ---- focus ----
  function viewPoint(e) {
    const b = $('#camwrap').getBoundingClientRect();
    return {x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height, px: e.clientX - b.left, py: e.clientY - b.top};
  }
  async function tapFocus(p) {
    const ring = $('#focusring');
    Object.assign(ring.style, {left: p.px + 'px', top: p.py + 'px'}); ring.hidden = false; ring.className = '';
    const v = $('#video'), r = crop(), W = v.videoWidth, H = v.videoHeight;
    const fx = (r.sx + p.x * r.sw) / W, fy = (r.sy + p.y * r.sh) / H;
    const sup = (navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints()) || {};
    const modes = S.caps.focusMode || [], adv = {};
    if (sup.pointsOfInterest) adv.pointsOfInterest = [{x: fx, y: fy}];
    if (modes.includes('single-shot')) adv.focusMode = 'single-shot';
    else if (modes.includes('continuous')) adv.focusMode = 'continuous';
    if (!Object.keys(adv).length || !S.track) { $('#camhint').textContent = '이 카메라는 탭 초점을 지원하지 않습니다 — 거리(10~15 cm)와 줌으로 맞추세요'; setTimeout(() => ring.hidden = true, 800); return; }
    S.meter.reset();
    await S.track.applyConstraints({advanced: [adv]}).catch(e => console.warn('focus:', e));
    ring.className = 'done';
    clearTimeout(S.afTimer);
    S.afTimer = setTimeout(() => {
      ring.hidden = true;
      if (S.track && modes.includes('continuous') && adv.focusMode === 'single-shot') S.track.applyConstraints({advanced: [{focusMode: 'continuous'}]}).catch(() => {});
    }, 3000);
  }

  // ---- live meter + auto capture ----
  function tick() {
    const v = $('#video'); if (!S.stream || !v.videoWidth || S.busy) return;
    const r = crop(), g = S.opts && S.opts.guide ? S.opts.guide(r.sw, r.sh) : null, roi = C.guideRoi(g, r.sw, r.sh);
    // centre window of the tool region at native sensor pixels (downscaling would hide the blur we look for)
    const n = Math.max(32, Math.min(384, Math.floor(roi.w), Math.floor(roi.h)));
    const cx = r.sx + roi.x + roi.w / 2, cy = r.sy + roi.y + roi.h / 2;
    const sx = Math.max(0, Math.min(v.videoWidth - n, Math.round(cx - n / 2))), sy = Math.max(0, Math.min(v.videoHeight - n, Math.round(cy - n / 2)));
    let res;
    try {
      roiCx.drawImage(v, sx, sy, n, n, 0, 0, n, n);
      const d = roiCx.getImageData(0, 0, n, n).data, gr = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) gr[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2];
      res = S.meter.push(C.sharpness(gr, n, n).score);
      thCx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, 32, 24);
      const t = thCx.getImageData(0, 0, 32, 24).data, th = new Uint8Array(32 * 24);
      for (let i = 0; i < th.length; i++) th[i] = t[4 * i + 1];
      const mv = C.motion(S.prevThumb, th); S.prevThumb = th;
      const now = performance.now();
      if (mv > 3) S.stillSince = now; else if (!S.stillSince) S.stillSince = now;
      res.still = mv <= 3 && now - S.stillSince > 700;
    } catch (e) { return; }   // frame not ready / tainted
    const s = S.track && S.track.getSettings ? S.track.getSettings() : {}, fd = S.caps.focusDistance;
    const tooClose = res.level === 'blur' && fd && s.focusDistance != null && s.focusDistance <= fd.min * 1.15;
    const bar = $('#sharpbar i');
    bar.style.width = Math.round(100 * Math.min(1, res.score / (C.ABS_SHARP * 1.5))) + '%';
    bar.className = res.level;
    $('#shutter').className = res.level;
    $('#camhint').textContent = C.hint(res.level, {zoom: S.zoom, tooClose});
    $('#cam').dataset.level = res.level;
    if ($('#autoShot').checked && res.level === 'sharp' && res.still && performance.now() - S.lastShot > 2000) shoot();
  }

  // ---- shot ----
  const timeout = (p, ms) => Promise.race([p, new Promise((a, b) => setTimeout(() => b(new Error('timeout')), ms))]);
  async function photoShot(v) {
    if (typeof ImageCapture === 'undefined' || !S.track) return null;
    const ic = new ImageCapture(S.track), pc = await timeout(ic.getPhotoCapabilities(), 1500);
    if (!(pc && pc.imageWidth && pc.imageWidth.max > v.videoWidth * 1.2)) return null;   // video frame is as good
    const blob = await timeout(ic.takePhoto({imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight && pc.imageHeight.max}).catch(() => ic.takePhoto()), 6000);
    const bmp = await createImageBitmap(blob);
    const f = C.fitAspect(bmp.width, bmp.height, v.videoWidth / v.videoHeight), r = C.cropRect(f.sw, f.sh, S.digital), c = cv(r.sw, r.sh);
    c.getContext('2d').drawImage(bmp, f.sx + r.sx, f.sy + r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
    bmp.close && bmp.close();
    // some devices reset zoom / torch after a still: put them back
    if (S.hw) S.track.applyConstraints({advanced: [{zoom: C.splitZoom(S.zoom, S.hw).hw}]}).catch(() => {});
    if (S.torch) S.track.applyConstraints({advanced: [{torch: true}]}).catch(() => {});
    return c;
  }
  async function shoot() {
    const v = $('#video'); if (S.busy || !S.stream || !v.videoWidth) return;
    S.busy = true; S.lastShot = performance.now(); $('#shutter').disabled = true; $('#cam').classList.add('flash');
    let c = null;
    if ($('#hiRes').checked) try { c = await photoShot(v); } catch (e) { console.warn('takePhoto:', e); }
    if (!c) { const r = crop(); c = cv(r.sw, r.sh); c.getContext('2d').drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh); }
    c.dataset.cam = JSON.stringify({zoom: +S.zoom.toFixed(2), digital: +S.digital.toFixed(2), level: $('#cam').dataset.level || '', score: +S.meter.last.toFixed(3)});
    S.busy = false; $('#shutter').disabled = false; setTimeout(() => $('#cam').classList.remove('flash'), 150);
    S.meter.reset(); S.prevThumb = null;
    S.opts && S.opts.onShot && S.opts.onShot(c);
  }

  // ---- open / close ----
  async function open(opts) {
    S.opts = opts;
    if (S.stream && S.track && S.track.readyState === 'live') { $('#cam').hidden = false; layout(); S.meter.reset(); return true; }   // next side: keep lens / zoom
    try { await start(lsGet(LS) || undefined); }
    catch (e) {
      if (lsGet(LS)) try { lsSet(LS, ''); await start(); } catch (e2) { e = e2; }
      if (!S.stream) {
        opts.onError && opts.onError('카메라를 열 수 없습니다: ' + (e && e.message || e) + ' — 기본 카메라 앱으로 촬영합니다');
        $('#nativeCam').click();             // still inside the tap's user activation window
        return false;
      }
    }
    $('#cam').hidden = false; layout();
    clearInterval(S.timer); S.timer = setInterval(tick, 150);
    return true;
  }
  function close() {
    clearInterval(S.timer); clearTimeout(S.afTimer); S.timer = 0;
    stopStream(); $('#cam').hidden = true; $('#focusring').hidden = true;
  }

  // ---- wiring ----
  function wire() {
    $('#shutter').onclick = shoot;
    $('#camClose').onclick = close;
    $('#zoom').oninput = e => setZoom(e.target.value);
    $('#zbtns').onclick = e => { const z = e.target.dataset && e.target.dataset.z; if (z) setZoom(z); };
    $('#lens').onchange = async e => {
      lsSet(LS, e.target.value);
      try { S.zoom = 1; await start(e.target.value); S.meter.reset(); } catch (err) { $('#camhint').textContent = '렌즈 전환 실패: ' + err.message; }
    };
    $('#torch').onclick = async () => {
      if (!S.track) return;
      S.torch = !S.torch;
      await S.track.applyConstraints({advanced: [{torch: S.torch}]}).catch(() => { S.torch = false; });
      $('#torch').classList.toggle('on', S.torch);
    };
    $('#focusDist').oninput = e => { clearTimeout(S.afTimer); S.meter.reset(); S.track && S.track.applyConstraints({advanced: [{focusMode: 'manual', focusDistance: +e.target.value}]}).catch(() => {}); };
    $('#afBtn').onclick = () => S.track && S.track.applyConstraints({advanced: [{focusMode: 'continuous'}]}).catch(() => {});
    $('#nativeCam').onchange = e => {
      const f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      const o = S.opts; close(); o && o.onFile && o.onFile(f);
    };
    // pinch = zoom, tap = focus
    const wrap = $('#camwrap'), pts = new Map(); let pinch = null, tap = null;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    wrap.addEventListener('pointerdown', e => {
      wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (pts.size === 2) { pinch = {d: dist(), z: S.zoom}; tap = null; }
      else if (pts.size === 1) tap = {x: e.clientX, y: e.clientY, t: performance.now(), e};
    });
    wrap.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (pinch && pts.size === 2) setZoom(pinch.z * dist() / Math.max(10, pinch.d));
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
    });
    const up = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (tap && !pts.size && performance.now() - tap.t < 500) tapFocus(viewPoint(e));
      if (!pts.size) tap = null;
    };
    wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', e => { pts.delete(e.pointerId); pinch = tap = null; });
    wrap.addEventListener('wheel', e => { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, {passive: false});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  Object.assign(window.Tool3D.capture, {open, close, shoot, setZoom, tapFocus, info, isOpen: () => !!S.stream});
})();
