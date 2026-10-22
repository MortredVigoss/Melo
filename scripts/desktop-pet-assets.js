// Desktop pet media store (see desktop-pet/assets-store.cjs for the layout).
//   node scripts/desktop-pet-assets.js import [--from <pet source dir>] [--store <dir>]
//     Verifies the source pack against its own manifest, copies the 金冬天 clips,
//     their keyframe audit and the 大肥鱼 clips into the store, pins them in
//     desktop-pet/skins/winter/manifest.json + desktop-pet/assets.lock.json and
//     links them into desktop-pet/. Repeatable: a newer pack replaces the old one.
//   node scripts/desktop-pet-assets.js verify [--store <dir>] [--frames]
//     Checks the store and links against the committed pins (every clip's sha256);
//     build:desktop and the release gate run this before bundling.
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, symlinkSync, realpathSync, copyFileSync, cpSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests load this module from a data: URL with PET_ROOT swapped for a fixture.
const here = import.meta.url.startsWith('file:') ? fileURLToPath(import.meta.url) : join(process.cwd(), 'scripts', 'desktop-pet-assets.js');
const require = createRequire(here);
export const PET_ROOT = resolve(dirname(here), '../desktop-pet');
// Static specifier on purpose: a computed require() would mark this file as an
// opaque dependency and widen every daily plan (scripts/test-impact.js).
const assets = require('../desktop-pet/assets-store.cjs');
export const { STORE, LINKS } = assets;
export const DEFAULT_SOURCE = process.env.MELO_PET_SOURCE_DIR || '/Users/mortred/Documents/New project/desktop-pet';

export function readManifest(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof manifest.revision !== 'string' || !/^winter-\d+-[\w-]+$/.test(manifest.revision)) throw new Error(`${file}: missing pack revision`);
  if (!Array.isArray(manifest.clips) || !manifest.clips.length) throw new Error(`${file}: no clips`);
  for (const clip of manifest.clips) {
    if (typeof clip.name !== 'string' || !clip.name || clip.name.includes('/') || clip.name.includes('..')) throw new Error(`${file}: invalid clip name ${JSON.stringify(clip.name)}`);
    if (!/^[0-9a-f]{64}$/.test(clip.sha256 || '') || !Number.isInteger(clip.bytes)) throw new Error(`${file}: clip ${clip.name} lacks sha256/bytes`);
  }
  if (manifest.actionCount !== undefined && manifest.actionCount !== manifest.clips.length) throw new Error(`${file}: actionCount ${manifest.actionCount} ≠ ${manifest.clips.length} clips`);
  return manifest;
}

/** Every clip of the manifest must exist with the recorded size and sha256. */
export function verifyClips(dir, manifest) {
  const problems = [];
  let bytes = 0;
  for (const clip of manifest.clips) {
    const file = join(dir, clip.name + '.webm');
    if (!existsSync(file)) { problems.push(`missing ${clip.name}.webm`); continue; }
    const size = statSync(file).size;
    if (size !== clip.bytes) { problems.push(`${clip.name}.webm: ${size} bytes, manifest says ${clip.bytes}`); continue; }
    const digest = assets.sha256File(file);
    if (digest !== clip.sha256) problems.push(`${clip.name}.webm: sha256 ${digest.slice(0, 12)}… ≠ manifest ${clip.sha256.slice(0, 12)}…`);
    bytes += size;
  }
  if (problems.length) throw new Error(`${dir}: ${problems.length} clip problem(s)\n  ${problems.slice(0, 10).join('\n  ')}${problems.length > 10 ? '\n  …' : ''}`);
  return { files: manifest.clips.length, bytes };
}

export function hashTree(dir) {
  const files = {};
  let bytes = 0;
  for (const name of assets.listFiles(dir)) { files[name] = assets.sha256File(join(dir, name)); bytes += statSync(join(dir, name)).size; }
  if (!Object.keys(files).length) throw new Error(`${dir}: empty`);
  return { files, bytes };
}

export function verifyTree(dir, expected) {
  const problems = [];
  for (const [name, digest] of Object.entries(expected.files)) {
    const file = join(dir, name);
    if (!existsSync(file)) problems.push(`missing ${name}`);
    else if (assets.sha256File(file) !== digest) problems.push(`${name}: sha256 differs from assets.lock.json`);
  }
  if (problems.length) throw new Error(`${dir}: ${problems.length} problem(s)\n  ${problems.slice(0, 10).join('\n  ')}${problems.length > 10 ? '\n  …' : ''}`);
  return Object.keys(expected.files).length;
}

function copyDir(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (process.platform === 'darwin') {
    // APFS clones: a 700MB import finishes in seconds and shares blocks with the source.
    try { execFileSync('cp', ['-Rc', from, to], { stdio: 'pipe' }); return; } catch { rmSync(to, { recursive: true, force: true }); }
  }
  cpSync(from, to, { recursive: true, dereference: true });
}

/** Replace store/<name> with staged, keeping the old copy until the new one is in place. */
function publish(store, name, staged) {
  const target = join(store, name);
  const retired = join(store, `.retired-${name}-${Date.now()}`);
  if (existsSync(target)) renameSync(target, retired);
  renameSync(staged, target);
  if (existsSync(retired)) rmSync(retired, { recursive: true, force: true });
}

function link(petRoot, store) {
  for (const [inside, name] of LINKS) {
    const at = join(petRoot, inside), target = join(store, name);
    if (existsSync(at) || isLink(at)) {
      if (isLink(at)) unlinkSync(at);
      else if (statSync(at).isDirectory() && !readdirSync(at).length) rmSync(at, { recursive: true });
      else throw new Error(`${at} is a real directory; move it away before importing (the store at ${target} replaces it)`);
    }
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at);
  }
}
const isLink = path => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

export function importAssets({ from = DEFAULT_SOURCE, store = assets.assetsStoreDir(), petRoot = PET_ROOT, log = console.log } = {}) {
  from = resolve(from); store = resolve(store);
  const sourcePack = join(from, 'skins/winter');
  const manifest = readManifest(join(sourcePack, 'manifest.json'));
  const committed = join(petRoot, 'skins/winter/manifest.json');
  const previous = existsSync(committed) ? readManifest(committed).revision : '(none)';
  log(`金冬天 pack: ${previous} → ${manifest.revision}${previous === manifest.revision ? ' (same revision, re-importing)' : ''}`);
  // The source may be mid-rebuild in another session: refuse anything that does not match its own manifest.
  const winter = verifyClips(join(sourcePack, 'winter-animation'), manifest);
  const framesSource = manifest.framesDirectory ? join(from, manifest.framesDirectory) : null;
  if (!framesSource || !existsSync(framesSource)) throw new Error(`keyframe audit directory missing: ${framesSource} (manifest.framesDirectory)`);
  const mainSource = join(from, 'upstream/assets/webm');
  if (!existsSync(mainSource)) throw new Error(`original 大肥鱼 clips missing: ${mainSource}`);
  mkdirSync(store, { recursive: true });
  const stamp = Date.now();
  const staged = name => join(store, `.importing-${name}-${stamp}`);
  for (const [name, source] of [[STORE.winterAnimation, join(sourcePack, 'winter-animation')], [STORE.winterFrames, framesSource], [STORE.mainAnimation, mainSource]]) {
    rmSync(staged(name), { recursive: true, force: true });
    copyDir(source, staged(name));
  }
  // Hash what was actually copied; the committed pins describe the store, not the source.
  verifyClips(staged(STORE.winterAnimation), manifest);
  const frames = hashTree(staged(STORE.winterFrames));
  const main = hashTree(staged(STORE.mainAnimation));
  if (!Object.keys(main.files).every(name => name.endsWith('.webm'))) throw new Error(`${mainSource}: expected only .webm clips`);
  for (const name of Object.values(STORE)) publish(store, name, staged(name));
  mkdirSync(join(petRoot, 'skins/winter'), { recursive: true });
  for (const name of ['manifest.json', 'winter-config.json']) copyFileSync(join(sourcePack, name), join(petRoot, 'skins/winter', name));
  const lock = {
    $comment: 'Pins of the desktop pet media kept outside Git (see desktop-pet/assets-store.cjs). Regenerated by npm run import:pet-skin; verified by npm run verify:pet-skin and build:desktop.',
    version: 1,
    winter: { revision: manifest.revision, clips: manifest.clips.length, bytes: winter.bytes, manifest: 'skins/winter/manifest.json' },
    winterFrames: { bytes: frames.bytes, files: frames.files },
    mainAnimation: { bytes: main.bytes, files: main.files },
    importedAt: new Date().toISOString(),
    importedFrom: from,
  };
  writeFileSync(assets.lockFile, JSON.stringify(lock, null, 2) + '\n');
  link(petRoot, store);
  const summary = verifyAssets({ store, petRoot, frames: true });
  log(`imported into ${store}: ${summary.winter.files} 金冬天 clips (${mb(summary.winter.bytes)}), ${summary.frames} audit files, ${summary.main} 大肥鱼 clips; pins written to ${relative(petRoot, assets.lockFile)}`);
  return summary;
}

export function verifyAssets({ store = assets.assetsStoreDir(), petRoot = PET_ROOT, frames = false } = {}) {
  store = resolve(store);
  if (!existsSync(assets.lockFile)) throw new Error(`${assets.lockFile} missing: run npm run import:pet-skin`);
  const lock = JSON.parse(readFileSync(assets.lockFile, 'utf8'));
  const manifest = readManifest(join(petRoot, 'skins/winter/manifest.json'));
  if (lock.winter?.revision !== manifest.revision) throw new Error(`assets.lock.json pins ${lock.winter?.revision} but skins/winter/manifest.json is ${manifest.revision}; run npm run import:pet-skin`);
  if (!existsSync(store)) throw new Error(`pet media store missing at ${store}: run npm run import:pet-skin (or set MELO_PET_ASSETS_DIR)`);
  for (const [inside, name] of LINKS) {
    const at = join(petRoot, inside), target = join(store, name);
    if (!isLink(at)) throw new Error(`${at} is not the store link; run npm run import:pet-skin`);
    if (realpathSync(at) !== realpathSync(target)) throw new Error(`${at} points to ${realpathSync(at)}, not ${target}`);
  }
  const winter = verifyClips(join(store, STORE.winterAnimation), manifest);
  const main = verifyTree(join(store, STORE.mainAnimation), lock.mainAnimation);
  const framesChecked = frames ? verifyTree(join(store, STORE.winterFrames), lock.winterFrames) : null;
  return { store, revision: manifest.revision, winter, main, frames: framesChecked };
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' || argv[i] === '--store') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} requires a directory`); options[argv[i].slice(2)] = argv[++i]; }
    else if (argv[i] === '--frames') options.frames = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

if (import.meta.url.startsWith('file:') && process.argv[1] && resolve(process.argv[1]) === here) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const options = parse(rest);
    if (command === 'import') importAssets(options);
    else if (command === 'verify') {
      const summary = verifyAssets(options);
      console.log(`desktop pet media verified: ${summary.revision}, ${summary.winter.files} 金冬天 clips (${mb(summary.winter.bytes)}), ${summary.main} 大肥鱼 clips${summary.frames === null ? '' : `, ${summary.frames} audit files`} in ${summary.store}`);
    } else throw new Error('Usage: desktop-pet-assets.js import [--from <dir>] [--store <dir>] | verify [--store <dir>] [--frames]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
