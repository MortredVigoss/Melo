// Imports the desktop-pet skins (金冬天 + 大肥鱼) into the Android asset tree.
//
//   node android/scripts/import-pet-skins.mjs import [--source <desktop-pet dir>] [--width 480] [--crf 32] [--jobs N] [--skins winter,fish] [--force]
//   node android/scripts/import-pet-skins.mjs bundle --tag <release tag>
//   node android/scripts/import-pet-skins.mjs verify
//
// Media never enters Git: `import` writes the transcoded WebM files under
// android/app/src/main/assets/pet/skins/ (ignored) plus the committed
// catalog.json (action catalog, source revisions, hashes, opaque boxes).
// `bundle` zips the media and records the GitHub Release URL in the catalog so
// the Gradle task preparePetAssets can fetch it on machines without the source.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFileName, buildCatalog, bundleFileName, bundleUrl, catalogFiles, listClips, parseArgs, parseCropDetect, parseProbe, probeArgs, sha256File, transcodeArgs, verifyCatalogFiles, SKINS } from '../../scripts/android-pet-assets.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const options = parseArgs(process.argv.slice(2), { out: resolve(root, 'android/app/src/main/assets/pet'), ...(process.env.MELO_PET_SOURCE ? { source: process.env.MELO_PET_SOURCE } : {}) });
const assetRoot = resolve(options.out);
const catalogPath = join(assetRoot, 'catalog.json');
const cachePath = join(assetRoot, 'skins', '.import-cache.json');

function run(command, args, { capture = 'stderr' } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept(capture === 'stdout' ? stdout : stderr) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); }
  });
  await Promise.all(lanes);
  return results;
}

async function importSkin(id, cache, jobs) {
  const skin = SKINS[id];
  const sourceDirectory = resolve(options.source, skin.clips);
  const clips = await listClips(sourceDirectory);
  if (!clips.length) throw new Error(`No .webm clips in ${sourceDirectory}`);
  let sourceRevision = skin.revision; let sourceGeneratedAt = null; let manifestHashes = null;
  if (skin.manifest) {
    const manifest = await readJson(resolve(options.source, skin.manifest));
    sourceRevision = manifest.revision; sourceGeneratedAt = manifest.generatedAt ?? null;
    manifestHashes = new Map((manifest.clips ?? []).map(entry => [entry.name, entry.sha256]));
  }
  const outDirectory = join(assetRoot, 'skins', id);
  await mkdir(outDirectory, { recursive: true });
  console.log(`[${id}] ${clips.length} clips from ${sourceDirectory} (${sourceRevision})`);
  const records = await mapLimit(clips, jobs, async (clip, index) => {
    const file = assetFileName(id, index);
    const relative = `skins/${id}/${file}`;
    const output = join(outDirectory, file);
    const sourceSha256 = await sha256File(clip.file);
    if (manifestHashes) {
      const expected = manifestHashes.get(clip.name);
      if (expected && expected !== sourceSha256) throw new Error(`[${id}] ${clip.name}: source hash differs from manifest.json; the source pack is mid-rebuild, retry after it settles`);
    }
    const key = `${relative}|${sourceSha256}|${options.width}x${options.height}|crf${options.crf}`;
    const cached = cache[relative];
    if (!options.force && cached && cached.key === key && await exists(output) && (await stat(output)).size === cached.bytes && await sha256File(output) === cached.sha256) {
      return { name: clip.name, file: relative, ...cached.record, sourceSha256 };
    }
    const temporary = `${output}.part`;
    const stderr = await run('ffmpeg', transcodeArgs({ input: clip.file, output: temporary, width: options.width, height: options.height, crf: options.crf, threads: 4 }));
    const box = parseCropDetect(stderr, options.width, options.height);
    const probe = parseProbe(await run('ffprobe', probeArgs(temporary), { capture: 'stdout' }));
    if (probe.width !== options.width || probe.height !== options.height || !probe.alpha || probe.duration <= 0) throw new Error(`[${id}] ${clip.name}: unexpected output ${JSON.stringify(probe)}`);
    await rename(temporary, output);
    const sha256 = await sha256File(output);
    const bytes = (await stat(output)).size;
    const record = { sha256, bytes, duration: probe.duration, fps: probe.fps, box };
    cache[relative] = { key, sha256, bytes, record };
    console.log(`[${id}] ${String(index + 1).padStart(3)}/${clips.length} ${clip.name} → ${file} ${(bytes / 1024).toFixed(0)} KiB box ${box.w}×${box.h}@${box.x},${box.y}`);
    return { name: clip.name, file: relative, ...record, sourceSha256 };
  });
  return { name: skin.name, sourceRevision, sourceGeneratedAt, source: skin.clips, license: skin.license ?? null, clips: records };
}

async function importCommand() {
  const configPath = resolve(options.source, SKINS.winter.config);
  const config = await readJson(configPath);
  const jobs = options.jobs > 0 ? options.jobs : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  await mkdir(join(assetRoot, 'skins'), { recursive: true });
  const cache = await exists(cachePath) ? await readJson(cachePath) : {};
  const previous = await exists(catalogPath) ? await readJson(catalogPath) : null;
  const skins = {};
  for (const id of options.skins) {
    skins[id] = await importSkin(id, cache, jobs);
    await writeFile(cachePath, JSON.stringify(cache, null, 1));
  }
  if (previous?.skins) for (const [id, skin] of Object.entries(previous.skins)) if (!skins[id] && !options.skins.includes(id)) skins[id] = { name: skin.name, sourceRevision: skin.sourceRevision, sourceGeneratedAt: skin.sourceGeneratedAt, source: skin.source, license: skin.license, clips: Object.entries(skin.clips).map(([name, clip]) => ({ name, ...clip })) };
  const catalog = buildCatalog({ animations: config.animations, workStatusTexts: config.workStatusTexts ?? [], skins, stage: { width: options.width, height: options.height }, crf: options.crf });
  const sameMedia = previous && JSON.stringify(catalogFiles(previous)) === JSON.stringify(catalogFiles(catalog));
  if (sameMedia && previous.bundle?.url) catalog.bundle = previous.bundle;
  await writeFile(catalogPath, JSON.stringify(catalog, null, 1) + '\n');
  const total = Object.values(catalog.skins).reduce((sum, skin) => sum + skin.totalBytes, 0);
  for (const skin of Object.values(catalog.skins)) console.log(`${skin.name}: ${skin.clipCount} clips, ${(skin.totalBytes / 1048576).toFixed(1)} MiB, ${skin.sourceRevision}`);
  console.log(`Catalog written: ${catalogPath} (${(total / 1048576).toFixed(1)} MiB media${sameMedia ? ', bundle record kept' : ', bundle record cleared — run `bundle --tag <tag>` and publish it'})`);
}

async function verifyCommand() {
  const catalog = await readJson(catalogPath);
  const problems = await verifyCatalogFiles(catalog, assetRoot);
  for (const problem of problems) console.error(`${problem.file}: ${problem.reason}`);
  if (problems.length) throw new Error(`${problems.length} media file(s) do not match ${catalogPath}`);
  console.log(`${catalogFiles(catalog).length} media files match the catalog${catalog.bundle?.url ? ` · bundle ${catalog.bundle.file}` : ' · no bundle recorded'}`);
}

async function bundleCommand() {
  if (!options.tag) throw new Error('bundle requires --tag <release tag>');
  await verifyCommand();
  const catalog = await readJson(catalogPath);
  const file = bundleFileName(catalog);
  const outDirectory = resolve(root, '.tmp', 'android-pet-assets');
  await mkdir(outDirectory, { recursive: true });
  const zipPath = join(outDirectory, file);
  await rm(zipPath, { force: true });
  const listPath = join(outDirectory, `${file}.list`);
  await writeFile(listPath, catalogFiles(catalog).map(entry => entry.file).join('\n') + '\n');
  // Deterministic order from the catalog; -X drops platform extras so the hash only depends on content.
  await new Promise((accept, reject) => {
    const child = spawn('zip', ['-q', '-X', '-0', zipPath, '-@'], { cwd: assetRoot, stdio: ['pipe', 'inherit', 'inherit'] });
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`zip exited ${code}`)));
    child.stdin.end(catalogFiles(catalog).map(entry => entry.file).join('\n') + '\n');
  });
  const sha256 = await sha256File(zipPath);
  const bytes = (await stat(zipPath)).size;
  catalog.bundle = { file, sha256, bytes, url: bundleUrl(options.tag, file) };
  await writeFile(catalogPath, JSON.stringify(catalog, null, 1) + '\n');
  console.log(`Bundle ${zipPath} (${(bytes / 1048576).toFixed(1)} MiB, sha256 ${sha256})\nUpload with: gh release upload ${options.tag} "${zipPath}"\nCatalog bundle URL: ${catalog.bundle.url}`);
}

try {
  if (options.command === 'import') await importCommand();
  else if (options.command === 'verify') await verifyCommand();
  else await bundleCommand();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
