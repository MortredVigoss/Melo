import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { target: 'all', outputRoot: projectRoot, iosOutput: null };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!value || !['--target', '--output-root', '--ios-output'].includes(flag)) {
    throw new Error('Usage: node scripts/render-app-icons.mjs [--target all|macos|ios] [--output-root PATH] [--ios-output PATH]');
  }
  if (flag === '--target') options.target = value;
  if (flag === '--output-root') options.outputRoot = resolve(value);
  if (flag === '--ios-output') options.iosOutput = resolve(value);
}
if (!['all', 'macos', 'ios'].includes(options.target)) throw new Error('Unknown icon target');
if (options.iosOutput && options.target !== 'ios') throw new Error('--ios-output requires --target ios');
if (options.target !== 'ios' && process.platform !== 'darwin') throw new Error('macOS icon export requires iconutil on macOS');

const master = await readFile(join(projectRoot, 'assets/brand/melo-black-ice-master.png'));
const metadata = await sharp(master).metadata();
if (metadata.width !== metadata.height || metadata.width < 1024) {
  throw new Error('The approved icon master must be square and at least 1024 pixels');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const masterHash = sha256(master);
const stage = await mkdtemp(join(tmpdir(), 'melo-icon-export-'));
const exports = [];
async function emit(relativePath, bytes, destination = join(options.outputRoot, relativePath)) {
  const stagedPath = join(stage, relativePath);
  await mkdir(dirname(stagedPath), { recursive: true });
  await writeFile(stagedPath, bytes);
  exports.push({ relativePath, stagedPath, destination, sha256: sha256(bytes) });
}
async function manifest(platform) {
  const files = exports.filter(item => platform === 'ios' ? item.relativePath.startsWith('ios/') : item.relativePath.startsWith('assets/') && !item.relativePath.startsWith('assets/brand/'));
  const value = {
    design: 'B - Black Ice Window',
    master: 'assets/brand/melo-black-ice-master.png',
    masterSha256: masterHash,
    platform,
    geometry: platform === 'ios' ? 'opaque square; system applies the corner mask' : '1024 canvas; 840 tile at 92,92; corner radius 188; transparent outer margin',
    files: files.map(({ relativePath, sha256 }) => ({ path: relativePath, sha256 })),
  };
  await emit('assets/brand/' + platform + '-icon-manifest.json', Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}

try {
  const square = await sharp(master).resize(1024, 1024, { kernel: 'lanczos3' }).flatten({ background: '#070809' }).removeAlpha().png().toBuffer();
  if (options.target === 'all' || options.target === 'ios') {
    for (const [name, dimension] of [['Icon-60@2x', 120], ['Icon-60@3x', 180], ['Icon-1024', 1024]]) {
      const bytes = await sharp(square).resize(dimension, dimension, { kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
      const relativePath = 'ios/Melo/' + name + '.png';
      await emit(relativePath, bytes, options.iosOutput ? join(options.iosOutput, name + '.png') : join(options.outputRoot, relativePath));
    }
    await manifest('ios');
  }
  if (options.target === 'all' || options.target === 'macos') {
    const tile = await sharp(square).resize(840, 840, { kernel: 'lanczos3' }).png().toBuffer();
    // Platform framing only: the approved artwork is not redrawn.
    const mask = Buffer.from('<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect x="92" y="92" width="840" height="840" rx="188" fill="white"/></svg>');
    const desktop = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
      .composite([{ input: tile, left: 92, top: 92 }, { input: mask, blend: 'dest-in' }]).png().toBuffer();
    await emit('assets/melo-icon.png', desktop);
    await emit('assets/melo-icon.svg.png', desktop);
    // Legacy SVG consumers use the same raster artwork, not the old teal vector.
    await emit('assets/melo-icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Melo Black Ice Window</title><image width="1024" height="1024" xlink:href="data:image/png;base64,' + desktop.toString('base64') + '"/></svg>\n'));
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = 'icon_' + points + 'x' + points + (scale === 2 ? '@2x' : '') + '.png';
        const bytes = await sharp(desktop).resize(points * scale, points * scale, { kernel: 'lanczos3' }).png().toBuffer();
        await emit('assets/Melo.iconset/' + name, bytes);
      }
    }
    const icnsPath = join(stage, 'melo.icns');
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', join(stage, 'assets/Melo.iconset'), '-o', icnsPath], { stdio: 'pipe' });
    await emit('assets/melo.icns', await readFile(icnsPath));
    await manifest('macos');
  }
  // Finish the complete requested set before replacing shipped resources.
  for (const item of exports) {
    await mkdir(dirname(item.destination), { recursive: true });
    await copyFile(item.stagedPath, item.destination);
  }
  console.log('Exported ' + exports.length + ' files from the approved B master (' + options.target + ').');
} finally {
  await rm(stage, { recursive: true, force: true });
}
