// Builds a debug APK from the same web build the browser gets.
//
//   npm run apk           vite build -> cap sync -> gradlew assembleDebug -> build/mojazer-debug.apk
//   npm run apk:install   the above, then adb install -r to the connected device
//   npm run apk -- --no-web   skip vite build and package whatever is in dist/
//
// Neither `java` nor `gradle` is on PATH on the dev machine, so JAVA_HOME points
// at Android Studio's bundled JDK and Gradle comes from the wrapper in android/.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The project folder, not build/: the owner wants it where he can see it and
// drag it onto a phone without going hunting. It is gitignored - a 28 MB binary
// rewritten on every build would add a copy of itself to the history each time.
const OUT = join(ROOT, 'Mojazer-debug.apk');

const JDK_CANDIDATES = [
  process.env.JAVA_HOME,
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  'C:\\Program Files\\Android\\Android Studio\\jre',
];
const SDK_CANDIDATES = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
];

const pick = (list, probe, what) => {
  for (const p of list) if (p && existsSync(join(p, probe))) return p;
  die(`Could not find ${what}. Looked in:\n  ${list.filter(Boolean).join('\n  ')}`);
};

function die(msg) {
  console.error(`\n[apk] ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, env) {
  console.log(`\n[apk] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, env });
  return r.status === 0;
}

const args = process.argv.slice(2);
const install = args.includes('--install');
const skipWeb = args.includes('--no-web');

const JAVA_HOME = pick(JDK_CANDIDATES, 'bin\\java.exe', 'a JDK (Android Studio bundles one at jbr/)');
const SDK = pick(SDK_CANDIDATES, 'platform-tools', 'the Android SDK');
const env = { ...process.env, JAVA_HOME, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };
console.log(`[apk] JAVA_HOME  ${JAVA_HOME}`);
console.log(`[apk] ANDROID_HOME ${SDK}`);

// Gradle reads the SDK path from here. Machine-specific, so it is generated and
// gitignored rather than committed.
writeFileSync(join(ROOT, 'android', 'local.properties'), `sdk.dir=${SDK.replace(/\\/g, '\\\\')}\n`);

if (!skipWeb) {
  if (!run('npx', ['vite', 'build'], env)) {
    die('vite build failed. Fix the web build, or run `npm run apk -- --no-web` to\n'
      + '      package whatever is already in dist/.');
  }
} else {
  console.log('[apk] skipping vite build (--no-web)');
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) die('dist/index.html is missing, nothing to package.');

if (!run('npx', ['cap', 'sync', 'android'], env)) die('cap sync failed.');
// Quoted: the repo path has a space in it and these run through a shell.
if (!run(`"${join(ROOT, 'android', 'gradlew.bat')}"`, ['-p', 'android', 'assembleDebug'], env)) {
  die('gradle assembleDebug failed.');
}

const apk = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(apk)) die(`gradle reported success but ${apk} is missing.`);
mkdirSync(dirname(OUT), { recursive: true });
copyFileSync(apk, OUT);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
const adb = join(SDK, 'platform-tools', 'adb.exe');
console.log(`\n[apk] ${OUT}  (${mb} MB)`);
console.log(`[apk] install with:\n      "${adb}" install -r "${OUT}"`);

if (install) {
  const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  const connected = (devices.stdout || '').split('\n').slice(1).some((l) => /\sdevice$/.test(l.trim()));
  if (!connected) die('no device in `adb devices`. Plug in a phone with USB debugging on,\n      accept the prompt, then rerun.');
  if (!run(`"${adb}"`, ['install', '-r', `"${OUT}"`], env)) die('adb install failed.');
  console.log('\n[apk] installed. Launch "Mojazer" from the app drawer.');
}
