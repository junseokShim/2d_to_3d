const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media')); // 웹캠 허용
  const win = new BrowserWindow({ width: 1400, height: 900, autoHideMenuBar: true });
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
