// Android(Capacitor) 파일 저장/공유 보정.
// WebView는 <a download href="blob:..."> 클릭을 무시하므로, 네이티브 앱에서만
// 해당 클릭을 가로채 Filesystem(Cache) 에 쓰고 Share 시트로 넘깁니다.
// 브라우저/Electron 에서는 아무것도 바꾸지 않습니다.
(function () {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  const call = (plugin, method, opts) => cap.nativePromise(plugin, method, opts);

  const toBase64 = blob => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

  async function saveNative(name, href) {
    const blob = await (await fetch(href)).blob();
    const safe = (name || 'tool3d.bin').replace(/[\\/:*?"<>|]/g, '_');
    const {uri} = await call('Filesystem', 'writeFile', {path: safe, data: await toBase64(blob), directory: 'CACHE'});
    try {
      await call('Share', 'share', {title: safe, dialogTitle: safe + ' 저장/공유', files: [uri]});
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) throw e;   // 사용자가 공유 시트를 닫은 경우는 정상
    }
  }

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && /^(blob|data):/.test(this.href)) {
      saveNative(this.getAttribute('download'), this.href)
        .catch(e => alert('저장 실패: ' + (e && e.message || e)));
      return;
    }
    return click.call(this);
  };
})();
