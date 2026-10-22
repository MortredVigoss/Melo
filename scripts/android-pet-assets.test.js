import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assetFileName, buildCatalog, bundleFileName, bundleUrl, catalogActionNames, catalogFiles, parseArgs, parseCropDetect, parseProbe, sha256File, transcodeArgs, verifyCatalogFiles, SKINS } from './android-pet-assets.js';

const animations = {
  idle: ['待机呼吸休闲'], turn: ['东张西望'], drag: ['被鼠标拖拽悬空反馈'], clicks: ['点击回应-开心跃动', '点击回应-害羞惊讶'],
  moves: { default: { minDist: 60 }, actions: [{ name: '螃蟹走路' }, { name: '原地漂浮踏步', params: { minDist: 40 } }] },
  categories: [{ id: '小动作', weight: 20, actions: ['悠闲哼歌', '东张西望'] }, { id: '文字', weight: 10, noMirror: true, actions: ['是啊，吃什么'] }],
  events: { workStatus: ['工作状态-思考冒泡', '工作状态-垂头叹气冒汗'], whisper: ['碎碎念-发呆碎碎念'] },
};
const digest = value => createHash('sha256').update(value).digest('hex');
const clip = (name, index, skin = 'winter') => ({ name, file: `skins/${skin}/${assetFileName(skin, index)}`, sha256: digest(`${skin}:${name}`), bytes: 1000 + index, duration: 10.03, fps: 30, box: { x: 150, y: 20, w: 180, h: 240, measured: true }, sourceSha256: digest(`src:${name}`) });
const names = catalogActionNames(animations);
const fullSkin = (id, name) => ({ name, sourceRevision: `${id}-rev`, source: SKINS[id].clips, clips: names.map((action, index) => clip(action, index, id)) });

test('action names are collected once, in catalog order, across every pool', () => {
  assert.deepEqual(names, ['待机呼吸休闲', '东张西望', '被鼠标拖拽悬空反馈', '点击回应-开心跃动', '点击回应-害羞惊讶', '螃蟹走路', '原地漂浮踏步', '悠闲哼歌', '是啊，吃什么', '工作状态-思考冒泡', '工作状态-垂头叹气冒汗', '碎碎念-发呆碎碎念']);
});

test('asset names stay ASCII, zero padded and skin prefixed', () => {
  assert.equal(assetFileName('winter', 0), 'w001.webm');
  assert.equal(assetFileName('fish', 105), 'f106.webm');
  assert.throws(() => assetFileName('ghost', 0), /Unknown skin/);
  assert.throws(() => assetFileName('winter', 1000), /out of range/);
});

test('ffmpeg arguments decode alpha with libvpx, scale to the stage, keep alpha and measure the opaque box in one pass', () => {
  const args = transcodeArgs({ input: '/in/a.webm', output: '/out/w001.webm', width: 480, height: 270, crf: 32 });
  assert.deepEqual(args.slice(0, 7), ['-hide_banner', '-nostdin', '-y', '-c:v', 'libvpx-vp9', '-i', '/in/a.webm']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=480:270:flags=lanczos/);
  assert.match(filter, /alphaextract,cropdetect=limit=4:round=2:reset=0/);
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuva420p');
  assert.equal(args[args.indexOf('-crf') + 1], '32');
  assert.ok(args.includes('ALPHA_MODE=1'));
  assert.equal(args[args.indexOf('-f') + 1], 'webm');
  assert.equal(args[args.lastIndexOf('-f') + 1], 'null');
  assert.throws(() => transcodeArgs({ input: '', output: 'x' }), /needs input and output/);
});

test('cropdetect parsing takes the final accumulated box and clamps it to the stage', () => {
  const stderr = '[Parsed_cropdetect_1 @ 0x1] x1:100 x2:300 y1:10 y2:200 w:200 h:190 x:100 y:10 pts:1 t:0.03 crop=200:190:100:10\n[Parsed_cropdetect_1 @ 0x1] crop=260:250:110:12\n';
  assert.deepEqual(parseCropDetect(stderr, 480, 270), { x: 110, y: 12, w: 260, h: 250, measured: true });
  assert.deepEqual(parseCropDetect('', 480, 270), { x: 0, y: 0, w: 480, h: 270, measured: false });
  assert.deepEqual(parseCropDetect('crop=600:100:400:0', 480, 270), { x: 400, y: 0, w: 80, h: 100, measured: true });
});

test('ffprobe output is reduced to the fields the catalog records', () => {
  const probe = parseProbe(JSON.stringify({ streams: [{ width: 480, height: 270, r_frame_rate: '30/1', tags: { ALPHA_MODE: '1' } }], format: { duration: '10.033000' } }));
  assert.deepEqual(probe, { width: 480, height: 270, fps: 30, alpha: true, duration: 10.033 });
  assert.equal(parseProbe({ streams: [{ r_frame_rate: '24000/1001' }] }).fps, 23.976);
  assert.equal(parseProbe({}).alpha, false);
});

test('catalog records both skins, totals and rejects a skin missing an action', () => {
  const catalog = buildCatalog({ animations, workStatusTexts: [['思考中']], skins: { winter: fullSkin('winter', '金冬天'), fish: fullSkin('fish', '大肥鱼') }, generatedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.stage, { width: 480, height: 270 });
  assert.equal(catalog.actionCount, names.length);
  assert.equal(catalog.skins.winter.clipCount, names.length);
  assert.equal(catalog.skins.fish.clips['是啊，吃什么'].file, 'skins/fish/f009.webm');
  assert.equal(catalog.skins.winter.totalBytes, names.reduce((sum, _, index) => sum + 1000 + index, 0));
  assert.deepEqual(catalog.bundle, { file: '', sha256: '', bytes: 0, url: '' });
  assert.deepEqual(catalog.animations, animations);
  const partial = fullSkin('winter', '金冬天');
  partial.clips = partial.clips.filter(entry => entry.name !== '螃蟹走路');
  assert.throws(() => buildCatalog({ animations, skins: { winter: partial } }), /missing 1 action clip\(s\): 螃蟹走路/);
  const duplicate = fullSkin('winter', '金冬天');
  duplicate.clips.push(duplicate.clips[0]);
  assert.throws(() => buildCatalog({ animations, skins: { winter: duplicate } }), /Duplicate clip/);
  assert.throws(() => buildCatalog({ animations: { idle: [] }, skins: {} }), /lists no actions/);
});

test('catalog files are listed in a stable order and verification reports missing, resized and altered media', async () => {
  const catalog = buildCatalog({ animations, skins: { winter: fullSkin('winter', '金冬天') } });
  const files = catalogFiles(catalog);
  assert.equal(files.length, names.length);
  assert.deepEqual(files.map(entry => entry.file), [...files.map(entry => entry.file)].sort());
  const root = await mkdtemp(join(tmpdir(), 'pet-assets-'));
  try {
    await mkdir(join(root, 'skins', 'winter'), { recursive: true });
    for (const entry of files) await writeFile(join(root, entry.file), Buffer.alloc(entry.bytes, 1));
    const hashes = new Map(files.map(entry => [join(root, entry.file), entry.sha256]));
    assert.deepEqual(await verifyCatalogFiles(catalog, root, { hash: async path => hashes.get(path) }), []);
    await writeFile(join(root, files[0].file), Buffer.alloc(files[0].bytes + 1, 1));
    await rm(join(root, files[1].file));
    hashes.set(join(root, files[2].file), digest('changed'));
    const problems = await verifyCatalogFiles(catalog, root, { hash: async path => hashes.get(path) });
    assert.deepEqual(problems.map(problem => problem.reason), [`size ${files[0].bytes + 1} != ${files[0].bytes}`, 'missing', 'sha256 mismatch']);
    await writeFile(join(root, 'real.bin'), 'melo');
    assert.equal(await sha256File(join(root, 'real.bin')), digest('melo'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundle name derives from content and source revisions; release URLs reject unsafe tags', () => {
  const catalog = buildCatalog({ animations, skins: { winter: fullSkin('winter', '金冬天') } });
  const name = bundleFileName(catalog);
  assert.match(name, /^melo-pet-assets-480x270-[a-f0-9]{12}\.zip$/);
  const other = buildCatalog({ animations, skins: { winter: { ...fullSkin('winter', '金冬天'), sourceRevision: 'rebuilt' } } });
  assert.notEqual(bundleFileName(other), name);
  assert.equal(bundleUrl('android-pet-assets-1', name), `https://github.com/MortredVigoss/Melo/releases/download/android-pet-assets-1/${name}`);
  assert.throws(() => bundleUrl('bad tag/..', name), /Invalid release tag/);
});

test('CLI options validate the stage, crf, skins and commands', () => {
  const options = parseArgs(['import', '--width', '480', '--crf', '30', '--skins', 'winter', '--jobs', '2', '--force']);
  assert.equal(options.command, 'import');
  assert.equal(options.height, 270);
  assert.deepEqual(options.skins, ['winter']);
  assert.equal(options.force, true);
  assert.equal(parseArgs([]).command, 'import');
  assert.equal(parseArgs(['bundle', '--tag', 'android-pet-assets-1']).tag, 'android-pet-assets-1');
  assert.throws(() => parseArgs(['--width', '500']), /multiple of 16/);
  assert.throws(() => parseArgs(['--crf', '99']), /4–63/);
  assert.throws(() => parseArgs(['--skins', 'cat']), /Unknown skin/);
  assert.throws(() => parseArgs(['publish']), /Unknown command/);
  assert.throws(() => parseArgs(['--tag']), /Missing value/);
});
