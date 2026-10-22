const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSkinStore } = require('../adapters/skin-store.cjs');
const packageRoot = path.resolve(__dirname, '../upstream');
// The committed pack contract (manifest + config) with stub clips: the store's
// behaviour never depends on the 364MB of WebM, which stay outside Git.
const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-pack-'));
process.on('exit', () => fs.rmSync(pack, { recursive: true, force: true }));
for (const name of ['manifest.json', 'winter-config.json']) fs.copyFileSync(path.resolve(__dirname, '../skins/winter', name), path.join(pack, name));
fs.mkdirSync(path.join(pack, 'winter-animation'));
for (const clip of require('../skins/winter/manifest.json').clips) fs.writeFileSync(path.join(pack, 'winter-animation', clip.name + '.webm'), 'stub ' + clip.sha256);
const visible = config => Object.values(config).flatMap(c => c.pets).filter(p => ['both', 'desktop'].includes(p.display)).map(p => p.id);

test('大肥鱼 starts alone and Winter uses the same complete action contract without changing the original', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-skins-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createSkinStore(packageRoot, home, pack);
  assert.equal(store.selected, 'main');
  const maid = store.select('main');
  assert.deepEqual(visible(maid.config), ['main']);
  const maidAnimations = structuredClone(maid.config.main.animations);
  const winter = store.select('winter');
  assert.deepEqual(visible(winter.config), ['winter']);
  assert.deepEqual(winter.config.winter.animations, maidAnimations);
  assert.deepEqual(winter.config.main.animations, maidAnimations);
  assert.equal(maid.config.main.pets[0].name, '大肥鱼');
  assert.equal(winter.config.winter.pets[0].name, '金冬天');
  assert.equal(createSkinStore(packageRoot, home, pack).selected, 'winter');
  assert.deepEqual(visible(store.select('main').config), ['main']);
  assert.throws(() => store.select('../winter'), /未知皮肤/);
  assert.equal(createSkinStore(packageRoot, home, pack).selected, 'main');
});

test('existing seven-action profiles upgrade their bundle while retaining skin, size and position', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-upgrade-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const petDir = path.join(home, 'dsh-pet/pet');
  fs.mkdirSync(path.join(petDir, 'winter-animation'), { recursive: true });
  fs.writeFileSync(path.join(petDir, 'winter-animation/站立.webm'), 'old-asset');
  const legacy = JSON.parse(fs.readFileSync(path.join(pack, 'winter-config.json')));
  legacy.animations.idle = ['站立'];
  legacy.pets[0].size = 378;
  legacy.pets[0].position.marginX = 93;
  legacy.pets[0].display = 'desktop';
  fs.writeFileSync(path.join(petDir, 'winter-config.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(home, 'dsh-pet/melo-skin.json'), JSON.stringify({ skin: 'winter' }));
  const store = createSkinStore(packageRoot, home, pack);
  const result = store.select('winter').config;
  assert.equal(store.selected, 'winter');
  assert.equal(result.winter.pets[0].size, 378);
  assert.equal(result.winter.pets[0].position.marginX, 93);
  assert.deepEqual(result.winter.animations, result.main.animations);
  const files = fs.readdirSync(path.join(petDir, 'winter-animation')).filter(name => name.endsWith('.webm'));
  assert.equal(files.length, 106);
  assert.ok(!files.includes('站立.webm'));
  const backups = fs.readdirSync(path.join(home, 'dsh-pet/.melo-backups'));
  assert.equal(fs.readFileSync(path.join(home, 'dsh-pet/.melo-backups', backups[0], 'winter-animation/站立.webm'), 'utf8'), 'old-asset');
  createSkinStore(packageRoot, home, pack);
  assert.equal(fs.readdirSync(path.join(home, 'dsh-pet/.melo-backups')).length, backups.length);
});

test('an upgrade keeps only the newest skin backup and leaves unrelated folders alone', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-prune-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const petDir = path.join(home, 'dsh-pet/pet');
  const backupDir = path.join(home, 'dsh-pet/.melo-backups');
  for (const name of ['winter-1700000000000-11', 'winter-1700000000001-22']) {
    fs.mkdirSync(path.join(backupDir, name, 'winter-animation'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, name, 'winter-animation/站立.webm'), 'older-asset');
  }
  fs.mkdirSync(path.join(backupDir, 'manual-keep'));
  fs.mkdirSync(path.join(petDir, 'winter-animation'), { recursive: true });
  fs.writeFileSync(path.join(petDir, 'winter-animation/站立.webm'), 'old-asset');
  fs.writeFileSync(path.join(petDir, 'winter-config.json'), fs.readFileSync(path.join(pack, 'winter-config.json')));
  createSkinStore(packageRoot, home, pack);
  const remaining = fs.readdirSync(backupDir).sort();
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0], 'manual-keep');
  assert.match(remaining[1], /^winter-\d+-\d+$/);
  assert.ok(!['winter-1700000000000-11', 'winter-1700000000001-22'].includes(remaining[1]));
  assert.equal(fs.readFileSync(path.join(backupDir, remaining[1], 'winter-animation/站立.webm'), 'utf8'), 'old-asset');
});

test('a fresh install leaves no empty backup and keeps the last real one', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-prune-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = path.join(home, 'dsh-pet/.melo-backups/winter-1700000000000-11');
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(previous, 'winter-config.json'), '{}');
  createSkinStore(packageRoot, home, pack);
  assert.deepEqual(fs.readdirSync(path.join(home, 'dsh-pet/.melo-backups')), ['winter-1700000000000-11']);
});

test('switching preserves user-controlled size and position, while enforcing one visible skin after restart', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-dsh-skins-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let store = createSkinStore(packageRoot, home, pack);
  const file = store.paths.userFile;
  const config = JSON.parse(fs.readFileSync(file));
  config.pets[0].size = 386;
  config.pets[0].position.marginX = 87;
  fs.writeFileSync(file, JSON.stringify(config));
  store.select('winter');
  store = createSkinStore(packageRoot, home, pack);
  const result = store.select('main');
  assert.equal(result.config.main.pets[0].size, 386);
  assert.equal(result.config.main.pets[0].position.marginX, 87);
  assert.deepEqual(visible(result.config), ['main']);
});
