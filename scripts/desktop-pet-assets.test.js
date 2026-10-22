import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const realPet = new URL('../desktop-pet/', import.meta.url);

// The functions resolve the lock file through desktop-pet/assets-store.cjs, which
// is bound to the real package directory. Each test gets a copy of that module
// under a temporary pet root so nothing here touches the checkout or the store.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'melo-pet-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pet = join(root, 'pet'), source = join(root, 'source'), store = join(root, 'store');
  await mkdir(join(pet, 'skins/winter'), { recursive: true });
  await mkdir(join(pet, 'upstream/assets'), { recursive: true });
  await copyFile(new URL('assets-store.cjs', realPet), join(pet, 'assets-store.cjs'));
  const clips = [['待机', 'webm-a'], ['挥手', 'webm-b']];
  const manifest = { revision: 'winter-2-test-aaaa', framesDirectory: 'work/frames', actionCount: 2, clips: clips.map(([name, body]) => ({ name, sha256: sha(body), bytes: body.length })) };
  await mkdir(join(source, 'skins/winter/winter-animation'), { recursive: true });
  await writeFile(join(source, 'skins/winter/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'skins/winter/winter-config.json'), '{"pets":[]}');
  for (const [name, body] of clips) await writeFile(join(source, 'skins/winter/winter-animation', name + '.webm'), body);
  await mkdir(join(source, 'work/frames/000'), { recursive: true });
  await writeFile(join(source, 'work/frames/000/0.png'), 'png-0');
  await writeFile(join(source, 'work/frames/000/cut.json'), '{}');
  await mkdir(join(source, 'upstream/assets/webm'), { recursive: true });
  await writeFile(join(source, 'upstream/assets/webm/原版.webm'), 'main-a');
  // Load a private module instance so PET_ROOT and the lock file point at the fixture.
  const code = (await readFile(new URL('./desktop-pet-assets.js', import.meta.url), 'utf8'))
    .replace("resolve(dirname(here), '../desktop-pet')", JSON.stringify(pet))
    .replace("require('../desktop-pet/assets-store.cjs')", `require(${JSON.stringify(join(pet, 'assets-store.cjs'))})`);
  const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + root.split('/').pop());
  return { root, pet, source, store, manifest, clips, module, log: () => {} };
}

test('import verifies the source pack, fills the store, pins the revision and links the tree', async t => {
  const f = await fixture(t);
  const summary = f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: f.log });
  assert.equal(summary.revision, 'winter-2-test-aaaa');
  assert.deepEqual(summary.winter, { files: 2, bytes: 12 });
  assert.equal(summary.main, 1);
  assert.equal(summary.frames, 2);
  assert.equal(await readFile(join(f.store, 'winter-animation/挥手.webm'), 'utf8'), 'webm-b');
  assert.equal(await readFile(join(f.store, 'main-animation/原版.webm'), 'utf8'), 'main-a');
  assert.equal(await readFile(join(f.store, 'winter-frames/000/0.png'), 'utf8'), 'png-0');
  assert.equal(await readlink(join(f.pet, 'skins/winter/winter-animation')), join(f.store, 'winter-animation'));
  assert.equal(await readlink(join(f.pet, 'upstream/assets/webm')), join(f.store, 'main-animation'));
  assert.equal(JSON.parse(await readFile(join(f.pet, 'skins/winter/manifest.json'), 'utf8')).revision, 'winter-2-test-aaaa');
  const lock = JSON.parse(await readFile(join(f.pet, 'assets.lock.json'), 'utf8'));
  assert.equal(lock.winter.revision, 'winter-2-test-aaaa');
  assert.deepEqual(Object.keys(lock.mainAnimation.files), ['原版.webm']);
  assert.deepEqual(Object.keys(lock.winterFrames.files).sort(), ['000/0.png', '000/cut.json']);
  assert.ok(!existsSync(join(f.store, 'winter-animation', '.DS_Store')));
  // Repeatable: the same revision imports again without leaving staging directories behind.
  f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: f.log });
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(f.store).sort(), ['main-animation', 'winter-animation', 'winter-frames']);
});

test('verify names a corrupted clip, a stale pin and a missing link; a newer pack replaces the old one', async t => {
  const f = await fixture(t);
  f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: f.log });
  assert.ok(f.module.verifyAssets({ store: f.store, petRoot: f.pet, frames: true }));
  await writeFile(join(f.store, 'winter-animation/待机.webm'), 'webm-X');
  assert.throws(() => f.module.verifyAssets({ store: f.store, petRoot: f.pet }), /待机\.webm/);
  await writeFile(join(f.store, 'winter-animation/待机.webm'), 'webm-a');
  await writeFile(join(f.store, 'main-animation/原版.webm'), 'tampered');
  assert.throws(() => f.module.verifyAssets({ store: f.store, petRoot: f.pet }), /原版\.webm: sha256 differs/);
  await writeFile(join(f.store, 'main-animation/原版.webm'), 'main-a');
  await rm(join(f.pet, 'upstream/assets/webm'));
  assert.throws(() => f.module.verifyAssets({ store: f.store, petRoot: f.pet }), /not the store link/);
  // A rebuilt pack: new revision and clip bytes.
  const next = { ...f.manifest, revision: 'winter-2-test-bbbb', clips: [{ name: '待机', sha256: sha('webm-a2'), bytes: 7 }, { name: '挥手', sha256: sha('webm-b2'), bytes: 7 }] };
  await writeFile(join(f.source, 'skins/winter/manifest.json'), JSON.stringify(next));
  await writeFile(join(f.source, 'skins/winter/winter-animation/待机.webm'), 'webm-a2');
  await writeFile(join(f.source, 'skins/winter/winter-animation/挥手.webm'), 'webm-b2');
  const lines = [];
  f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: line => lines.push(line) });
  assert.match(lines[0], /winter-2-test-aaaa → winter-2-test-bbbb/);
  assert.equal(await readFile(join(f.store, 'winter-animation/待机.webm'), 'utf8'), 'webm-a2');
  assert.equal(JSON.parse(await readFile(join(f.pet, 'assets.lock.json'), 'utf8')).winter.revision, 'winter-2-test-bbbb');
  assert.ok(f.module.verifyAssets({ store: f.store, petRoot: f.pet, frames: true }));
});

test('a source pack that disagrees with its own manifest is refused before anything changes', async t => {
  const f = await fixture(t);
  f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: f.log });
  const before = await readFile(join(f.pet, 'assets.lock.json'), 'utf8');
  await writeFile(join(f.source, 'skins/winter/winter-animation/挥手.webm'), 'half-written');
  assert.throws(() => f.module.importAssets({ from: f.source, store: f.store, petRoot: f.pet, log: f.log }), /挥手\.webm: 12 bytes, manifest says 6/);
  assert.equal(await readFile(join(f.pet, 'assets.lock.json'), 'utf8'), before);
  assert.equal(await readFile(join(f.store, 'winter-animation/挥手.webm'), 'utf8'), 'webm-b');
  assert.ok(f.module.verifyAssets({ store: f.store, petRoot: f.pet }));
});
