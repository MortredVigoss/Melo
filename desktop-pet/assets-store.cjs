'use strict';
// Where the pet's large media live. The 金冬天 pack (~364MB of WebM), its
// keyframe audit (~320MB of PNG) and the original 大肥鱼 clips (~52MB) are never
// committed: they sit in one fixed directory outside the repository and are
// linked into this tree by `npm run import:pet-skin`. The committed
// skins/winter/manifest.json (per-clip sha256) and assets.lock.json pin exactly
// which bytes a build may use; scripts/desktop-pet-assets.js verifies them.
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const root = __dirname;
const STORE = Object.freeze({ winterAnimation: 'winter-animation', winterFrames: 'winter-frames', mainAnimation: 'main-animation' });
// [path inside desktop-pet/, directory inside the store]
const LINKS = Object.freeze([
  ['skins/winter/winter-animation', STORE.winterAnimation],
  ['upstream/assets/webm', STORE.mainAnimation],
]);

function assetsStoreDir() {
  return path.resolve(process.env.MELO_PET_ASSETS_DIR || path.join(root, '..', '..', 'desktop-pet-assets'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Sorted relative paths of every regular file under dir (symlinked dirs are followed). */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...listFiles(full, prefix + entry.name + '/'));
    else if (stat.isFile()) out.push(prefix + entry.name);
  }
  return out;
}

module.exports = { root, STORE, LINKS, assetsStoreDir, sha256File, listFiles, lockFile: path.join(root, 'assets.lock.json') };
