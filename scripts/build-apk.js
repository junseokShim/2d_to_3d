// npm run apk : www/ -> android/ 동기화 후 디버그 APK 빌드.
// 필요: JDK 17 (JAVA_HOME 또는 PATH), Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT 또는 android/local.properties).
const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const android = path.join(root, 'android');
const win = process.platform === 'win32';
const fail = msg => { console.error('\n[apk] ' + msg + '\n'); process.exit(1); };
const run = (cmd, cwd = root) => execSync(cmd, {cwd, stdio: 'inherit'});

// JDK 17+
let javaOut = '';
try {
  const java = process.env.JAVA_HOME ? `"${path.join(process.env.JAVA_HOME, 'bin', 'java')}"` : 'java';
  javaOut = execSync(`${java} -version 2>&1`, {encoding: 'utf8'});
} catch { fail('JDK를 찾지 못했습니다. JDK 17을 설치하고 JAVA_HOME을 지정하세요 (예: winget install EclipseAdoptium.Temurin.17.JDK).'); }
const major = +(/version "(\d+)/.exec(javaOut) || [])[1];
if (major < 17) fail(`JDK ${major || '?'} 발견. JDK 17 이상이 필요합니다.`);

// Android SDK
const localProps = path.join(android, 'local.properties');
if (!fs.existsSync(localProps)) {
  const guess = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    win && path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'), path.join(os.homedir(), 'Library', 'Android', 'sdk')]
    .find(p => p && fs.existsSync(p));
  if (!guess) fail('Android SDK를 찾지 못했습니다. Android Studio(또는 command-line tools)를 설치하고 ANDROID_HOME을 지정하세요.');
  fs.writeFileSync(localProps, 'sdk.dir=' + guess.replace(/\\/g, '\\\\') + '\n');
}

run('npx cap sync android');
run(win ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug', android);

const apk = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(apk)) fail('빌드는 끝났지만 APK가 없습니다: ' + apk);
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
const out = path.join(root, 'dist', 'Tool3D-debug.apk');
fs.copyFileSync(apk, out);
console.log('\n[apk] 완료: ' + out);
