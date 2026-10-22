// Stages the desktop pet into a Melo.app build:
//   node scripts/bundle-desktop-pet.js <Melo.app/Contents/Resources/desktop-pet>
// Inputs: desktop-pet/ (committed code, generated host bundles), the pinned
// Electron from desktop-pet/node_modules (npm run install:desktop-pet) and the
// media store verified by scripts/desktop-pet-assets.js (npm run import:pet-skin).
// Output: a self-contained tree with the controller, dialog, upstream runtime,
// production node_modules, both skins and runtime/DSHPet.app (the pinned
// Electron with the pet's bundle identity, ad-hoc signed). build-desktop-app.sh
// seals the whole Melo.app afterwards; nothing here touches Melo's own signing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAssets, PET_ROOT, STORE } from './desktop-pet-assets.js';

const RUNTIME_FILES = ['package.json', 'main.cjs', 'runtime-info.cjs', 'melo-client.cjs', 'control-server.cjs', 'README.md', 'dialog'];
const UPSTREAM_FILES = ['LICENSE', 'UPSTREAM-README.md', 'README.md', 'package.json', 'lib', 'runtime', 'assets/config.jsonc', 'assets/fonts', 'assets/logo.png', 'assets/memes', 'assets/pic'];
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
const ditto = (from, to) => { mkdirSync(dirname(to), { recursive: true }); run('ditto', [from, to]); };

export function bundleDesktopPet(destination, { petRoot = PET_ROOT, log = console.log } = {}) {
  destination = resolve(destination);
  const electronApp = join(petRoot, 'node_modules/electron/dist/Electron.app');
  if (!existsSync(join(electronApp, 'Contents/MacOS/Electron'))) throw new Error(`pinned Electron missing at ${electronApp}: run npm run install:desktop-pet`);
  if (!existsSync(join(petRoot, 'node_modules/esbuild'))) throw new Error(`esbuild missing in ${petRoot}/node_modules: run npm run install:desktop-pet`);
  const media = verifyAssets({ petRoot });
  // Regenerate the host bundles from the committed TypeScript so the app never ships a stale adapter.
  run(process.execPath, [join(petRoot, 'build.cjs')], { cwd: petRoot });
  for (const file of ['upstream/lib/melo-host.mjs', 'upstream/runtime/electron-helper/shared-core.js', 'adapters/skin-store.cjs']) {
    if (!existsSync(join(petRoot, file))) throw new Error(`${file} was not produced by desktop-pet/build.cjs`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of RUNTIME_FILES) ditto(join(petRoot, name), join(destination, name));
  for (const name of UPSTREAM_FILES) ditto(join(petRoot, 'upstream', name), join(destination, 'upstream', name));
  // Skins: the committed contract files plus the store directories behind the links.
  for (const name of ['manifest.json', 'winter-config.json']) ditto(join(petRoot, 'skins/winter', name), join(destination, 'skins/winter', name));
  ditto(realpathSync(join(petRoot, 'skins/winter/winter-animation')), join(destination, 'skins/winter/winter-animation'));
  ditto(realpathSync(join(petRoot, 'upstream/assets/webm')), join(destination, 'upstream/assets/webm'));
  // Production dependencies only (zod, @electron/get and what they need); Electron and esbuild stay out.
  const packages = run('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: petRoot }).split('\n').map(line => line.trim()).filter(line => line.includes('/node_modules/'));
  if (!packages.length) throw new Error('npm ls found no production dependencies');
  for (const dir of packages) ditto(dir, join(destination, relative(petRoot, dir)));
  // Melo's build may run with a different umask; keep the tree readable as app resources.
  run('chmod', ['-R', 'u+rwX,go+rX', destination]);
  // The pet's own Electron: same binary as the pinned npm package, with the pet's bundle identity.
  const runtime = join(destination, 'runtime/DSHPet.app');
  ditto(electronApp, runtime);
  const plist = join(runtime, 'Contents/Info.plist');
  for (const [key, value] of [['CFBundleIdentifier', 'local.melo.dshpet.renderer'], ['CFBundleName', 'melo桌宠'], ['CFBundleDisplayName', 'melo桌宠']]) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  run('codesign', ['--force', '--deep', '--sign', '-', runtime]);
  run('codesign', ['--verify', '--deep', '--strict', runtime]);
  const electron = 'v' + JSON.parse(readFileSync(join(petRoot, 'node_modules/electron/package.json'), 'utf8')).version;
  // The staged tree must resolve its runtime packages on its own, without the checkout.
  run(join(runtime, 'Contents/MacOS/Electron'), ['-e', "require.resolve('zod');require.resolve('@electron/get')"], { cwd: join(destination, 'upstream/lib'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const petVersion = JSON.parse(readFileSync(join(petRoot, 'package.json'), 'utf8')).version;
  const bundle = { pet: petVersion, electron, winterRevision: media.revision, winterClips: media.winter.files, mainClips: media.main, upstream: 'PC2005-cloud/dsh-pet v0.3.7 (MIT)', builtAt: new Date().toISOString() };
  writeFileSync(join(destination, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  log(`desktop pet bundled into ${destination}: Electron ${electron}, 金冬天 ${media.revision} (${media.winter.files} clips), 大肥鱼 ${media.main} clips, ${packages.length} runtime packages`);
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: bundle-desktop-pet.js <destination directory>');
    bundleDesktopPet(process.argv[2]);
  } catch (error) { console.error(error.stderr ? `${error.message}\n${error.stderr}` : error.message); process.exitCode = 1; }
}
