import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { generateApiImage } from './openaiImageEngine.js';
import { imageConnection, visionConnection, validateImageTask } from './imageSettings.js';
import { prepareVisionInputs } from '../media/visionInputs.js';
import { inferImageTask, runImageTask } from '../services/chat/imageTask.js';
import {
  createExecutionScene,
  applyExecutionEvent,
  finishExecutionScene,
} from '../shared/executionScene.js';
import { chatRequestFingerprint, validateChatRequest } from '../services/chat/requestContract.js';
const connection = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'private-key',
  model: 'image-model',
};
const png = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } })
  .png()
  .toBuffer();
const encoded = png.toString('base64'),
  url = `data:image/png;base64,${encoded}`;
const event = (e) => `data: ${JSON.stringify(e)}\r\n\r\n`;

test('Images API sends real generation parameters, accepts only final image, tracks reported model', async () => {
  const previews = [];
  const result = await generateApiImage({
    connection,
    prompt: 'bird',
    quality: 'high',
    size: '1024x1024',
    previews: true,
    onPreview: (b, n) => previews.push([b, n]),
    fetchImpl: async (endpoint, init) => {
      assert.equal(endpoint, 'https://example.test/v1/images/generations');
      assert.equal(init.headers.Authorization, 'Bearer private-key');
      const submitted = JSON.parse(init.body);
      assert.ok(submitted.prompt.includes('\nUser request (verbatim):\nbird\n'));
      assert.deepEqual({...submitted, prompt: 'bird'}, {
        model: 'image-model',
        prompt: 'bird',
        n: 1,
        quality: 'high',
        size: '1024x1024',
        stream: true,
        partial_images: 2,
      });
      return new Response(
        event({
          type: 'image_generation.partial_image',
          partial_image_index: 0,
          b64_json: encoded,
        }) +
          event({
            type: 'image_generation.completed',
            b64_json: encoded,
            model: 'actual-image-model',
          }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  assert.equal(previews.length, 1);
  assert.equal(result.reportedModel, 'actual-image-model');
  assert.equal((await sharp(result.buffer).metadata()).width, 64);
  await assert.rejects(
    generateApiImage({
      connection,
      prompt: 'bird',
      fetchImpl: async () =>
        new Response(event({ type: 'image_generation.partial_image', b64_json: encoded }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    }),
    /未返回完整图像/,
  );
});
test('multi-image masked edit sends multipart input and refuses wrong mask dimensions', async () => {
  const mask = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  await generateApiImage({
    connection,
    prompt: 'edit',
    images: [
      { buffer: png, mimeType: 'image/png' },
      { buffer: png, mimeType: 'image/png' },
    ],
    mask,
    fetchImpl: async (endpoint, init) => {
      assert.match(endpoint, /\/images\/edits$/);
      assert.equal(init.body.getAll('image[]').length, 2);
      assert.ok(init.body.get('mask'));
      assert.equal(init.headers['Content-Type'], undefined);
      return Response.json({ data: [{ b64_json: encoded }] });
    },
  });
  const wrong = await sharp(mask).resize(32, 32).png().toBuffer();
  await assert.rejects(
    generateApiImage({
      connection,
      prompt: 'edit',
      images: [{ buffer: png }],
      mask: wrong,
      fetchImpl: () => assert.fail('must validate before network'),
    }),
    /同尺寸/,
  );
});
test('generation reports partial success, preserves genuine previews and retry count without fake candidates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melo-image-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scene = createExecutionScene({ runId: 'image-test', query: '生成三张图' });
  let calls = 0;
  const text = await runImageTask({
    task: { action: 'generate', count: 3 },
    config: { authMode: 'codex', model: 'language-model' },
    messages: [{ role: 'user', content: '生成三张图' }],
    workspace: { rootPath: root },
    sseEmitter: (kind, e) => {
      if (kind === 'execution_event') applyExecutionEvent(scene, e);
    },
    dependencies: {
      generate: async (options) => {
        assert.equal(options.model, 'language-model');
        await options.onPreview(encoded, 0);
        calls++;
        if (calls === 2) throw new Error('quota');
        return { buffer: png };
      },
    },
  });
  finishExecutionScene(scene);
  assert.equal(calls, 3);
  assert.equal(scene.artifacts.length, 2);
  assert.equal(scene.previews.length, 3);
  assert.equal(scene.selectedImageIds.length, 2);
  assert.equal(scene.requestedImages, 3);
  assert.match(text, /2\/3/);
  assert.match(text, /quota/);
  assert.equal(scene.operations.filter((o) => o.status === 'failed').length, 1);
  assert.ok((await readFile(scene.artifacts[0].path)).length);
  assert.doesNotMatch(JSON.stringify(scene), /data:image/);
  const previous = JSON.stringify(scene);
  applyExecutionEvent(scene, { kind: 'preview', id: 'fake', url: 'https://example.test/new.png' });
  assert.equal(JSON.stringify(scene), previous);
});
test('editing keeps every reference, explicit role, before image and completed artifact when inspection cancelled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melo-image-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scene = createExecutionScene({ runId: 'edit' }),
    controller = new AbortController();
  await assert.rejects(
    runImageTask({
      task: {
        action: 'edit',
        count: 1,
        inspect: true,
        references: [{ attachmentId: 'b', role: 'style' }],
      },
      config: { model: 'chosen' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '换颜色' },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ],
      attachments: [
        { id: 'a', kind: 'image', url },
        { id: 'b', kind: 'image', url },
      ],
      workspace: { rootPath: root },
      signal: controller.signal,
      sseEmitter: (k, e) => {
        if (k === 'execution_event') applyExecutionEvent(scene, e);
      },
      dependencies: {
        edit: async (o) => {
          assert.equal(o.referenceImages.length, 1);
          assert.equal(o.prompt, '换颜色');
          assert.deepEqual(o.referenceRoles, ['reference', 'style']);
          return { buffer: png };
        },
        reply: async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        },
      },
    }),
  );
  assert.equal(scene.artifacts.length, 1);
  assert.ok(scene.artifacts[0].beforeUrl);
  assert.equal(scene.operations[0].status, 'completed');
  assert.equal(scene.pipeline.at(-1).status, 'cancelled');
});
test('vision crop and role are actual input transforms, remote inaccessible URLs fail clearly', async () => {
  const messages = await prepareVisionInputs([
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url,
            detail: 'high',
            role: 'subject',
            crop: { x: 0, y: 0, width: 50, height: 50 },
          },
        },
      ],
    },
  ]);
  const image = messages[0].content[0];
  assert.equal(image.image_url.detail, 'high');
  const meta = await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 32);
  assert.match(messages[0].content[1].text, /subject/);
  await assert.rejects(
    prepareVisionInputs([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://local.invalid/image' } }],
      },
    ]),
    /无法读取/,
  );
});
test('image intent does not hijack website work; counts and credentials stay explicit', () => {
  assert.equal(inferImageTask('帮我做一个网站', [], null), null);
  assert.equal(inferImageTask('请帮我生成三张图片', [], null).count, 3);
  assert.equal(inferImageTask('画三张图片', [], { action: 'generate' }).count, 3);
  assert.throws(() => validateImageTask({ action: 'edit', count: 0 }), /1–20/);
  assert.throws(
    () =>
      validateImageTask({
        action: 'analyze',
        references: [
          { attachmentId: 'a', role: 'reference', crop: { x: 90, y: 0, width: 20, height: 20 } },
        ],
      }),
    /范围/,
  );
  assert.throws(() => imageConnection({}, { engine: 'openai-api' }), /连接/);
  assert.equal(
    visionConnection({
      model: 'chat',
      imageSettings: { visionProfileId: 'visual' },
      llmProfiles: { visual: { model: 'vision', apiKey: 'key' } },
    }).model,
    'vision',
  );
  const base = { chatId: 'c', content: 'edit', imageTask: { action: 'edit', count: 1 } };
  assert.notEqual(
    chatRequestFingerprint(base),
    chatRequestFingerprint({ ...base, imageTask: { ...base.imageTask, count: 2 } }),
  );
  assert.throws(() => validateChatRequest({ ...base, imageTask: { action: 'bad' } }), /类型/);
});

test('image workflow discussion and cancelled execution never trigger the generation shortcut', () => {
  const analysis = {
    action: 'analyze',
    detail: 'high',
    ocr: true,
    references: [
      { attachmentId: 'a', role: 'subject', crop: { x: 0, y: 0, width: 50, height: 50 } },
    ],
  };
  assert.deepEqual(
    inferImageTask('看看这张图是怎么生成的', [], analysis),
    validateImageTask(analysis),
  );
  for (const text of [
    '生成三张图片的代码，不要真的生成',
    '生成图片要怎么写接口？',
    'create an image prompt for a cat',
    '生成一张猫的图片，但不要实际生成',
  ]) {
    assert.equal(inferImageTask(text, [], null).action, 'analyze');
  }
  assert.equal(
    inferImageTask('生成一张猫的图片，但不要实际生成', [], { action: 'generate' }).action,
    'analyze',
  );
  assert.equal(inferImageTask('“生成三张图片”是什么意思？', [], null), null);
});

test('local image constraints and subject keywords do not cancel requested generation', () => {
  for (const text of [
    '生成一张海报，不要修改人物的脸。',
    '生成一张提示词海报',
    'Generate an image of a classroom; do not draw any text.',
    '生成一张 API 架构图。',
    '生成一张海报，上面写 prompt 和 code',
    '生成一张猫的图片，不要生成文字',
  ]) assert.equal(inferImageTask(text, [], {action:'generate'}).action, 'generate', text);
  for (const text of ['不要生成图片，只说方案', 'Do not generate an image.', '生成一张海报，但不要实际生成'])
    assert.equal(inferImageTask(text, [], {action:'generate'}).action, 'analyze', text);
});

test('output quantity excludes reference and constraint quantities', () => {
  for (const [text, count] of [
    ['参考这三张图片，生成一张海报。', 1],
    ['用三张参考图生成两张海报', 2],
    ['Use 3 images as references; generate 2 images.', 2],
    ['参考三张图片，生成一张海报，不要生成两张', 1],
    ['参考三张图片，生成海报', 1],
    ['Generate a poster from 3 photos.', 1],
    ['create a poster based on 3 photos', 1],
    ['生成图片，数量为三张', 3],
    ['生成图片，给我三张', 3],
    ['三张海报，参考这五张照片', 3],
    ['三张图片', 3],
    ['生成十二张图片', 12],
  ]) assert.equal(inferImageTask(text, [], {action:'generate'}).count, count, text);
  assert.equal(inferImageTask('参考三张图片，生成一张海报', [], {action:'generate',count:2}).count, 2);
});

test('new image inspection surfaces mismatches after image delivery without generating again', async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'melo-image-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let generated=0,reviewed=0;const sequence=[];
  const text=await runImageTask({task:{action:'generate',inspect:true},config:{model:'chosen'},messages:[{role:'user',content:'画一张图，只写“Melo”'}],workspace:{rootPath:root},onDelta:async()=>sequence.push('image'),dependencies:{
    generate:async()=>{generated++;return{buffer:png};},
    reply:async opts=>{reviewed++;sequence.push('review');assert.equal(opts.messages[0].content.filter(p=>p.type==='image_url').length,1);return JSON.stringify({verdict:'mismatch',changes:[],preserved:[],issues:['多出了文字']});},
  }});
  assert.equal(generated,1);assert.equal(reviewed,1);assert.deepEqual(sequence,['image','review']);
  assert.match(text,/1\/1/);assert.match(text,/模型判断.*发现不符/);assert.match(text,/多出了文字/);
});
test('a malformed review or failed inspection retains the image and never reports an unconditional pass', async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'melo-image-review-fail-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const fail of [false,true]){
    let generated=0;
    const text=await runImageTask({task:{action:'generate',inspect:true},config:{model:'chosen'},messages:[{role:'user',content:'画一张图'}],workspace:{rootPath:root},dependencies:{generate:async()=>{generated++;return{buffer:png};},reply:async()=>{if(fail)throw new Error('offline');return 'all perfect';}}});
    assert.equal(generated,1);assert.match(text,/!\[/);assert.match(text,/1\/1/);assert.match(text,fail?/未完成视觉核对/:/需人工核对/);assert.doesNotMatch(text,/未发现明显不符/);
  }
});
test('an oversized task fails before any generation, analysis or image file operation',async()=>{
  let generated=0;
  await assert.rejects(runImageTask({task:{action:'generate'},config:{},messages:[{role:'user',content:'x'.repeat(40000)}],workspace:{rootPath:'/must-not-create'},dependencies:{generate:async()=>{generated++;}}}),{code:'IMAGE_PROMPT_TOO_LONG'});
  assert.equal(generated,0);
});
