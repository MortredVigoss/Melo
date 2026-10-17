// Attachment externalization (design §2.3): large inline data URLs live on
// disk, the message keeps a local URL, and the model still gets bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentsDir, attachmentPath, externalizeAttachments, externalizeMessageAttachments, hydrateAttachments,
  hydrateMessagesForModel, isFileAttachmentUrl, migrateInlineAttachments, applyAttachmentMigration, INLINE_DATA_URL_LIMIT,
} from './attachments.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'melo-attachments-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const pngDataUrl = bytes => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
const ID = '0f0f0f0f-1111-4222-8333-444444444444';

test('a large data URL becomes a 0o600 file under desktop/attachments and hydrates back byte-for-byte', async t => {
  const h = await home(t);
  const url = pngDataUrl(100 * 1024);
  const [stored] = await externalizeAttachments([{ id: ID, kind: 'image', url, title: 'photo.png', mimeType: 'image/png' }], { home: h });
  assert.equal(stored.url, `/api/media/attachments/${ID}.png`);
  assert.equal(stored.storage, 'file');
  assert.equal(stored.mimeType, 'image/png');
  assert.equal(stored.byteSize, 100 * 1024);
  assert.equal(stored.title, 'photo.png', 'other fields are kept');
  assert.ok(isFileAttachmentUrl(stored.url));
  const path = attachmentPath(stored.url, h);
  assert.equal(path, join(attachmentsDir(h), `${ID}.png`));
  const info = await stat(path);
  assert.equal(info.size, 100 * 1024);
  if (process.platform !== 'win32') {
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await stat(attachmentsDir(h))).mode & 0o777, 0o700);
  }
  assert.deepEqual((await readdir(attachmentsDir(h))).sort(), [`${ID}.png`], 'no temp file left behind');
  const [hydrated] = await hydrateAttachments([stored], { home: h });
  assert.equal(hydrated.url, url);
  assert.equal(hydrated.storage, 'file', 'hydration only swaps the URL');
});

test('tiny data URLs, remote URLs and already file-backed attachments are returned by identity', async t => {
  const h = await home(t);
  const small = { id: ID, kind: 'image', url: pngDataUrl(1024) };
  const remote = { id: 'r', kind: 'link', url: 'https://example.com/a.png' };
  const text = { id: 't', kind: 'link', url: `data:text/plain,${'x'.repeat(INLINE_DATA_URL_LIMIT + 10)}` };
  const input = [small, remote, text];
  const output = await externalizeAttachments(input, { home: h });
  assert.equal(output, input, 'nothing to do → same array');
  await assert.rejects(readdir(attachmentsDir(h)), { code: 'ENOENT' }, 'no directory is created for nothing');
  const [stored] = await externalizeAttachments([{ id: ID, kind: 'image', url: pngDataUrl(8 * 1024) }], { home: h });
  const again = await externalizeAttachments([stored], { home: h });
  assert.equal(again[0], stored);
  assert.equal(await hydrateAttachments([remote], { home: h }).then(list => list[0]), remote);
});

test('attachment names are validated strictly: no traversal, no foreign names, nothing outside the prefix', async t => {
  const h = await home(t);
  for (const bad of [
    '/api/media/attachments/../../state.json',
    '/api/media/attachments/..%2F..%2Fstate.json',
    '/api/media/attachments/x.png',
    `/api/media/attachments/${ID}`,
    `/api/media/attachments/${ID}.png/extra`,
    `/api/media/attachments/${ID}.PNG`,
    `/api/media/attachments/${ID}..png`,
    `/api/media/uploads/${ID}.png`,
    `https://example.com/api/media/attachments/${ID}.png`,
    pngDataUrl(10),
    '', null, undefined,
  ]) {
    assert.equal(attachmentPath(bad, h), null, String(bad));
    assert.equal(isFileAttachmentUrl(bad), false, String(bad));
  }
  assert.ok(attachmentPath(`/api/media/attachments/${ID}.pdf`, h).startsWith(attachmentsDir(h)));
});

test('a missing file leaves the attachment untouched instead of producing a broken data URL', async t => {
  const h = await home(t);
  const orphan = { id: ID, kind: 'image', url: `/api/media/attachments/${ID}.png`, storage: 'file' };
  const [result] = await hydrateAttachments([orphan], { home: h });
  assert.equal(result, orphan);
});

test('hydrateMessagesForModel clones only messages with file-backed attachments and reads each file once', async t => {
  const h = await home(t);
  const url = pngDataUrl(20 * 1024);
  const [stored] = await externalizeAttachments([{ id: ID, kind: 'image', url }], { home: h });
  const plain = { id: 'm1', role: 'user', content: 'hello', attachments: [] };
  const assistant = { id: 'm2', role: 'assistant', content: 'hi' };
  const withFile = { id: 'm3', role: 'user', content: 'look', attachments: [stored, { id: 'l', kind: 'link', url: 'https://example.com' }] };
  const carried = { id: 'm4', role: 'user', content: 'zoom', attachments: [stored] };
  const messages = [plain, assistant, withFile, carried];
  const hydrated = await hydrateMessagesForModel(messages, { home: h });
  assert.notEqual(hydrated, messages);
  assert.equal(hydrated[0], plain); assert.equal(hydrated[1], assistant);
  assert.notEqual(hydrated[2], withFile);
  assert.equal(hydrated[2].attachments[0].url, url);
  assert.equal(hydrated[2].attachments[1].url, 'https://example.com');
  assert.equal(hydrated[3].attachments[0].url, url);
  assert.equal(withFile.attachments[0].url, stored.url, 'the persisted message is never mutated');
  const untouched = [plain, assistant];
  assert.equal(await hydrateMessagesForModel(untouched, { home: h }), untouched, 'nothing file-backed → same array');
  // Messages beyond the tail never reach the model with media, so they stay as-is.
  const old = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, role: 'user', content: 'x', attachments: [stored] }));
  const tailOnly = await hydrateMessagesForModel([...old, plain], { home: h, tail: 3 });
  assert.equal(tailOnly[0], old[0]);
  assert.equal(tailOnly[18].attachments[0].url, url);
});

test('lazy migration externalizes every inline attachment once, patches extractedMedia, and is idempotent', async t => {
  const h = await home(t);
  const big = pngDataUrl(30 * 1024), small = pngDataUrl(500);
  const chat = { id: 'chat-1', messages: [
    { id: 'u1', role: 'user', content: 'a', attachments: [{ id: ID, kind: 'image', url: big }],
      extractedMedia: [{ kind: 'caption', text: 'ocr', metadata: { source: 'tesseract-ocr', url: big } }] },
    { id: 'a1', role: 'assistant', content: 'b', attachments: [] },
    { id: 'u2', role: 'user', content: 'c', attachments: [{ id: 's', kind: 'image', url: small }, { id: 'l', kind: 'link', url: 'https://example.com' }] },
  ] };
  const first = chat.messages[0];
  const migration = await migrateInlineAttachments(chat, { home: h });
  assert.equal(migration.migrated, 1); assert.equal(migration.failed, 0); assert.equal(migration.complete, true);
  assert.equal(chat.attachmentsExternalized, true);
  assert.equal(chat.messages[0], first, 'messages are patched in place');
  assert.equal(first.attachments[0].url, `/api/media/attachments/${ID}.png`);
  assert.equal(first.extractedMedia[0].metadata.url, `/api/media/attachments/${ID}.png`, 'extractedMedia follows the attachment');
  assert.equal(chat.messages[2].attachments[0].url, small, 'small inline stays inline');
  assert.deepEqual(migration.patches.map(p => p.messageId), ['u1']);

  // Replay onto another copy of the same chat (what the state write queue sees).
  const copy = { id: 'chat-1', messages: [{ id: 'u1', role: 'user', content: 'a', attachments: [{ id: ID, kind: 'image', url: big }] }, { id: 'u2', attachments: [] }] };
  applyAttachmentMigration(copy, migration);
  assert.equal(copy.messages[0].attachments[0].url, `/api/media/attachments/${ID}.png`);
  assert.equal(copy.attachmentsExternalized, true);
  applyAttachmentMigration({ id: 'other', messages: [] }, migration);

  const second = await migrateInlineAttachments(chat, { home: h });
  assert.equal(second.migrated, 0); assert.deepEqual(second.patches, []); assert.equal(second.complete, true);
  assert.deepEqual((await readdir(attachmentsDir(h))).sort(), [`${ID}.png`]);
});

test('a failed write keeps the inline data URL and leaves the chat unmarked so the next turn retries', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const h = await home(t);
  const big = pngDataUrl(30 * 1024);
  await (await import('node:fs/promises')).mkdir(attachmentsDir(h), { recursive: true });
  await chmod(attachmentsDir(h), 0o500);
  t.after(() => chmod(attachmentsDir(h), 0o700).catch(() => {}));
  const chat = { id: 'chat-2', messages: [{ id: 'u1', role: 'user', content: 'a', attachments: [{ id: ID, kind: 'image', url: big }] }] };
  const migration = await migrateInlineAttachments(chat, { home: h });
  assert.equal(migration.failed, 1); assert.equal(migration.complete, false);
  assert.equal(chat.attachmentsExternalized, undefined);
  assert.equal(chat.messages[0].attachments[0].url, big);
  const message = { id: 'u2', attachments: [{ id: ID, kind: 'image', url: big }] };
  assert.equal(await externalizeMessageAttachments(message, { home: h }), message);
});

test('the same upload re-attached later maps onto one file; a different payload under a reused id gets its own name', async t => {
  const h = await home(t);
  const url = pngDataUrl(12 * 1024);
  const [a] = await externalizeAttachments([{ id: ID, kind: 'image', url }], { home: h });
  const [b] = await externalizeAttachments([{ id: ID, kind: 'image', url }], { home: h });
  assert.equal(a.url, b.url);
  const [c] = await externalizeAttachments([{ id: ID, kind: 'image', url: pngDataUrl(13 * 1024) }], { home: h });
  assert.notEqual(c.url, a.url);
  assert.ok(isFileAttachmentUrl(c.url));
  assert.equal((await readdir(attachmentsDir(h))).length, 2);
  // Non-UUID ids never leak into file names.
  const [d] = await externalizeAttachments([{ id: '../evil', kind: 'image', url }], { home: h });
  assert.ok(isFileAttachmentUrl(d.url));
  assert.equal(d.id, '../evil', 'the attachment id itself is left alone');
});
