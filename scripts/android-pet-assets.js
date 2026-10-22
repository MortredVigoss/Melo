// Pure helpers for the Android desktop-pet skin import. The CLI that runs
// ffmpeg lives in android/scripts/import-pet-skins.mjs; everything here is
// deterministic so the gate can check it without media or ffmpeg.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

export const STAGE = { width: 480, height: 270 };
export const DEFAULT_CRF = 32;
export const DEFAULT_SOURCE = '/Users/mortred/Documents/New project/desktop-pet';
export const GITHUB_REPOSITORY = 'MortredVigoss/Melo';

/** Skins packaged into the APK. `prefix` keeps asset names ASCII; the catalog maps action names to files. */
export const SKINS = {
  winter: { id: 'winter', name: '金冬天', prefix: 'w', clips: 'skins/winter/winter-animation', manifest: 'skins/winter/manifest.json', config: 'skins/winter/winter-config.json' },
  fish: { id: 'fish', name: '大肥鱼', prefix: 'f', clips: 'upstream/assets/webm', license: 'MIT (PC2005-cloud/dsh-pet)', revision: 'dsh-pet v0.3.7 90ddd827fd9661958752855e899da452063ceaa5' },
};

export function assetFileName(skin, index) {
  const definition = SKINS[skin];
  if (!definition) throw new Error(`Unknown skin: ${skin}`);
  if (!Number.isInteger(index) || index < 0 || index > 999) throw new Error(`Clip index out of range: ${index}`);
  return `${definition.prefix}${String(index + 1).padStart(3, '0')}.webm`;
}

/** Every action name the animation catalog can ask for, in a stable order. */
export function catalogActionNames(animations) {
  const names = [];
  const add = value => { if (typeof value === 'string' && value && !names.includes(value)) names.push(value); };
  for (const name of animations.idle ?? []) add(name);
  for (const name of animations.turn ?? []) add(name);
  for (const name of animations.drag ?? []) add(name);
  for (const name of animations.clicks ?? []) add(name);
  for (const action of animations.moves?.actions ?? []) add(action?.name);
  for (const category of animations.categories ?? []) for (const name of category.actions ?? []) add(name);
  for (const pool of Object.values(animations.events ?? {})) for (const name of pool) add(name);
  return names;
}

/**
 * One ffmpeg invocation transcodes a VP9+alpha clip to the phone stage and, in
 * the same decode pass, measures the opaque bounding box through the alpha plane.
 */
export function transcodeArgs({ input, output, width = STAGE.width, height = STAGE.height, crf = DEFAULT_CRF, threads = 4 }) {
  if (!input || !output) throw new Error('transcodeArgs needs input and output');
  const filter = `[0:v]format=yuva420p,scale=${width}:${height}:flags=lanczos,split=2[v][c];[c]alphaextract,cropdetect=limit=4:round=2:reset=0[cd]`;
  return ['-hide_banner', '-nostdin', '-y', '-c:v', 'libvpx-vp9', '-i', input,
    '-filter_complex', filter,
    '-map', '[v]', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-threads', String(threads),
    '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0', '-g', '60', '-an', '-metadata:s:v:0', 'ALPHA_MODE=1', '-f', 'webm', output,
    '-map', '[cd]', '-f', 'null', '-'];
}

/** The last cropdetect line is the accumulated opaque box (reset=0 only grows). */
export function parseCropDetect(stderr, width = STAGE.width, height = STAGE.height) {
  const matches = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return { x: 0, y: 0, w: width, h: height, measured: false };
  const [, w, h, x, y] = matches[matches.length - 1].map(Number);
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: width, h: height, measured: false };
  return { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(width - Math.max(0, x), w), h: Math.min(height - Math.max(0, y), h), measured: true };
}

export function probeArgs(file) {
  return ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:stream_tags=ALPHA_MODE:format=duration', '-of', 'json', file];
}

export function parseProbe(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  const stream = parsed.streams?.[0] ?? {};
  const [num, den] = String(stream.r_frame_rate ?? '0/1').split('/').map(Number);
  return { width: Number(stream.width) || 0, height: Number(stream.height) || 0, fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
    alpha: String(stream.tags?.ALPHA_MODE ?? '') === '1', duration: Number(parsed.format?.duration) || 0 };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((accept, reject) => createReadStream(path).on('data', chunk => hash.update(chunk)).once('end', accept).once('error', reject));
  return hash.digest('hex');
}

export async function listClips(directory) {
  const entries = await readdir(directory);
  return entries.filter(name => name.endsWith('.webm')).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-co-pinyin')).map(name => ({ name: name.slice(0, -5), file: join(directory, name) }));
}

/**
 * Builds the committed catalog. `skins[id].clips` are the transcoded results
 * (`name`, `file` relative to the pet asset root, `sha256`, `bytes`, `duration`,
 * `fps`, `box`, `sourceSha256`). Fails when an action in the animation catalog
 * has no clip in a packaged skin, so the player never asks for a missing file.
 */
export function buildCatalog({ animations, workStatusTexts = [], skins, stage = STAGE, crf = DEFAULT_CRF, generatedAt = new Date().toISOString(), bundle = null }) {
  if (!animations || typeof animations !== 'object') throw new Error('animations catalog is required');
  const names = catalogActionNames(animations);
  if (!names.length) throw new Error('animations catalog lists no actions');
  const packaged = {};
  for (const [id, skin] of Object.entries(skins)) {
    const clips = {};
    let totalBytes = 0;
    for (const clip of skin.clips) {
      if (!clip.name || !clip.file || !/^[a-f0-9]{64}$/.test(clip.sha256 ?? '')) throw new Error(`Incomplete clip record for ${id}/${clip.name ?? '?'}`);
      if (clips[clip.name]) throw new Error(`Duplicate clip ${id}/${clip.name}`);
      clips[clip.name] = { file: clip.file, sha256: clip.sha256, bytes: clip.bytes, duration: clip.duration, fps: clip.fps, box: clip.box, sourceSha256: clip.sourceSha256 };
      totalBytes += clip.bytes;
    }
    const missing = names.filter(name => !clips[name]);
    if (missing.length) throw new Error(`Skin ${id} is missing ${missing.length} action clip(s): ${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}`);
    packaged[id] = { id, name: skin.name, sourceRevision: skin.sourceRevision, sourceGeneratedAt: skin.sourceGeneratedAt ?? null, source: skin.source, license: skin.license ?? null, clipCount: Object.keys(clips).length, totalBytes, clips };
  }
  if (!Object.keys(packaged).length) throw new Error('No skins packaged');
  return { version: 1, generatedAt, stage: { width: stage.width, height: stage.height }, encode: { codec: 'libvpx-vp9', pixelFormat: 'yuva420p', crf }, actionCount: names.length,
    animations, workStatusTexts, skins: packaged, bundle: bundle ?? { file: '', sha256: '', bytes: 0, url: '' } };
}

/** Files the catalog expects under the pet asset root, in a stable order (also the zip order). */
export function catalogFiles(catalog) {
  const files = [];
  for (const skin of Object.values(catalog.skins ?? {})) for (const clip of Object.values(skin.clips ?? {})) files.push({ file: clip.file, sha256: clip.sha256, bytes: clip.bytes });
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** Reports every missing or altered media file; an empty list means the local assets match the catalog. */
export async function verifyCatalogFiles(catalog, root, { hash = sha256File } = {}) {
  const problems = [];
  for (const entry of catalogFiles(catalog)) {
    const path = join(root, ...entry.file.split('/'));
    let size;
    try { size = (await stat(path)).size; } catch { problems.push({ file: entry.file, reason: 'missing' }); continue; }
    if (size !== entry.bytes) { problems.push({ file: entry.file, reason: `size ${size} != ${entry.bytes}` }); continue; }
    const digest = await hash(path);
    if (digest !== entry.sha256) problems.push({ file: entry.file, reason: 'sha256 mismatch' });
  }
  return problems;
}

export function bundleFileName(catalog) {
  const digest = createHash('sha256');
  for (const entry of catalogFiles(catalog)) digest.update(`${entry.file}\n${entry.sha256}\n`);
  const revisions = Object.values(catalog.skins).map(skin => skin.sourceRevision).join('+');
  digest.update(revisions);
  return `melo-pet-assets-${catalog.stage.width}x${catalog.stage.height}-${digest.digest('hex').slice(0, 12)}.zip`;
}

export function bundleUrl(tag, file, repository = GITHUB_REPOSITORY) {
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  return `https://github.com/${repository}/releases/download/${tag}/${posix.basename(file)}`;
}

export function parseArgs(argv, defaults = {}) {
  const options = { command: 'import', source: DEFAULT_SOURCE, width: STAGE.width, crf: DEFAULT_CRF, jobs: 0, skins: Object.keys(SKINS), force: false, tag: '', ...defaults };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('--')) options.command = rest.shift();
  while (rest.length) {
    const flag = rest.shift();
    const take = () => { const value = rest.shift(); if (value === undefined) throw new Error(`Missing value for ${flag}`); return value; };
    switch (flag) {
      case '--source': options.source = take(); break;
      case '--out': options.out = take(); break;
      case '--width': options.width = Number(take()); break;
      case '--crf': options.crf = Number(take()); break;
      case '--jobs': options.jobs = Number(take()); break;
      case '--skins': options.skins = take().split(',').map(value => value.trim()).filter(Boolean); break;
      case '--tag': options.tag = take(); break;
      case '--force': options.force = true; break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!['import', 'bundle', 'verify'].includes(options.command)) throw new Error(`Unknown command: ${options.command}`);
  if (!Number.isInteger(options.width) || options.width % 16 !== 0 || options.width < 160 || options.width > 960) throw new Error('--width must be a multiple of 16 between 160 and 960');
  if (!Number.isInteger(options.crf) || options.crf < 4 || options.crf > 63) throw new Error('--crf must be 4–63');
  for (const skin of options.skins) if (!SKINS[skin]) throw new Error(`Unknown skin: ${skin}`);
  options.height = options.width * 9 / 16;
  return options;
}
