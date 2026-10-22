const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const store = require('../assets-store.cjs');
// The WebM clips and the keyframe audit (cut.json / interpolation.json / 12 PNG
// keys per action) live outside Git; `npm run import:pet-skin` links them in.
// A developer checkout without them fails here. Only CI, which never carries
// 700MB of media, records an explicit skip; the release gate runs this for real.
const animationDir = path.join(root, 'skins/winter/winter-animation');
const framesDir = path.join(store.assetsStoreDir(), store.STORE.winterFrames);
const missing = [animationDir, framesDir].filter(dir => !fs.existsSync(dir));
const skip = missing.length && process.env.CI ? `pet media not imported in CI (${missing.join(', ')}); verified locally and by the release gate` : false;
const requireMedia = () => assert.equal(missing.length, 0, `run npm run import:pet-skin first; missing ${missing.join(', ')}`);
test('all 106 configured actions have distinct assets and twelve distinct drawn keyframes at normal speed', { skip }, () => {
  requireMedia();
  const manifest = require('../skins/winter/manifest.json');
  const config = require('../skins/winter/winter-config.json');
  const a = config.animations;
  const names = [...new Set([...a.idle, ...a.turn, ...a.drag, ...a.clicks, ...a.moves.actions.map(x => x.name), ...a.categories.flatMap(c => c.actions), ...Object.values(a.events).flat(Infinity)])];
  assert.equal(names.length, 106);
  assert.deepEqual(manifest.clips.map(c => c.name), names);
  assert.equal(new Set(manifest.clips.map(c => c.sha256)).size, 106);
  for (const [index, clip] of manifest.clips.entries()) {
    const bytes = fs.readFileSync(path.join(animationDir, clip.name + '.webm'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256);
    assert.equal(clip.drawnKeyframes, 12);
    assert.equal(clip.fps, 30);
    assert.equal(clip.cycleDuration, index === 0 ? 6.4 : 1.6);
    assert.ok(Math.abs(clip.duration - clip.sourceDuration) < .041);
    const keys = Array.from({length:12}, (_,frame) => fs.readFileSync(path.join(framesDir, String(index).padStart(3, '0'), frame + '.png')));
    assert.equal(new Set(keys.map(b => createHash('sha256').update(b).digest('hex'))).size, 12);
  }
});

test('drawn keys are cut cleanly from the atlas and joined by optical-flow in-betweens, not crossfades', { skip }, () => {
  requireMedia();
  const manifest = require('../skins/winter/manifest.json');
  assert.match(manifest.interpolation, /optical flow/);
  assert.match(manifest.superResolution, /VTSuperResolutionScaler 4x/);
  assert.equal(manifest.width * 9, manifest.height * 16); // the renderer letterboxes any 16:9 clip to the stage
  for (const [index, clip] of manifest.clips.entries()) {
    const dir = path.join(framesDir, String(index).padStart(3, '0'));
    assert.equal(clip.framesPerCycle, Math.round(clip.cycleDuration * clip.fps));
    assert.equal(clip.interpolatedFramesPerCycle, clip.framesPerCycle - 12);
    const interpolation = JSON.parse(fs.readFileSync(path.join(dir, 'interpolation.json'), 'utf8'));
    assert.equal(interpolation.drawnKeys, 12);
    assert.equal(interpolation.inbetweensPerPair, clip.framesPerCycle / 12 - 1);
    assert.deepEqual(interpolation.pairs.map(p => [p.from, p.to]), Array.from({length:12}, (_, k) => [k, (k + 1) % 12]));
    const cut = JSON.parse(fs.readFileSync(path.join(dir, 'cut.json'), 'utf8'));
    assert.equal(cut.keys.length, 12);
    assert.deepEqual([cut.superResolution.tool, cut.superResolution.scale], ['VTSuperResolutionScaler', 4]);
    for (const key of cut.keys) {
      // Where two drawings touch in the atlas (soles resting on the next row's hair)
      // the seam runs along their shared edge, at most a few dozen atlas pixels long;
      // a seam through a body or a sliced prop leaves hundreds. Clipping cuts feet/props.
      assert.ok(key.opaqueOnSeam <= 32, `${clip.name} key ${key.frame} cut through the figure (${key.opaqueOnSeam})`);
      assert.equal(key.clippedPixels, 0, `${clip.name} key ${key.frame} clipped by the stage`);
      assert.ok(key.figuresInRow >= (index === 85 ? 6 : 12));
      const png = fs.readFileSync(path.join(dir, key.frame + '.png'));
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [manifest.width, manifest.height]);
    }
  }
});
