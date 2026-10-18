// Attachment externalization end to end (design §2.3): a user message with a
// 100 KB inline image is persisted with a small /api/media/attachments URL,
// the thread checkpoint on disk carries no base64, and the model request
// built by the runner still receives a data:image/... part.
//
// MELO_HOME isolation follows sendChatMessage.test.js: mkdtemp before the
// dynamic imports, restore after.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const ORIGINAL_MOCK_RESPONSE = process.env.MELO_MOCK_RESPONSE;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-attachment-e2e-'));
for (const dir of ['desktop', 'desktop/agents', 'desktop/threads']) mkdirSync(join(TEST_HOME, dir), { recursive: true });

const IMAGE_ID = '7a7a7a7a-0001-4bbb-8ccc-dddddddddddd';
// A 100 KB payload. The agent model advertises vision, so ingestion-time
// extraction skips OCR and the bytes only need to round-trip.
const IMAGE_BYTES = Buffer.alloc(100 * 1024, 42);
const IMAGE_DATA_URL = `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`;

writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [],
  chats: [{ id: 'img-chat-1', title: 'image-test', mode: 'chat', projectId: null, agentId: 'main', source: 'desktop', chatType: 'private', messages: [], sessionMemory: [] }],
  tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4o', identity: '', soulMd: '', tools: [], skills: [], channels: {} } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null,
    activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));

process.env.MELO_HOME = TEST_HOME;
process.env.MELO_MOCK_RESPONSE = 'mock-reply';
const { sendChatMessage } = await import('./sendChatMessage.js');
const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
const { loadState } = await import('../../state/stateStore.js');
const { attachmentsDir, hydrateMessagesForModel } = await import('../../media/attachments.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  if (ORIGINAL_MOCK_RESPONSE === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = ORIGINAL_MOCK_RESPONSE;
});

test('a 100 KB inline image is persisted as a file-backed attachment and the model still receives a data:image part', { timeout: 60000 }, async () => {
  const result = await sendChatMessage({
    chatId: 'img-chat-1', content: 'what do you see here?', mode: 'chat', skipBootstrap: true,
    attachments: [{ id: IMAGE_ID, kind: 'image', url: IMAGE_DATA_URL, title: 'photo.png', fileName: 'photo.png', mimeType: 'image/png' }],
  });
  assert.ok(result.assistantMessage, 'the mocked turn completes');

  // Persisted shape: small local URL + storage metadata, bytes on disk.
  const state = await loadState({ home: TEST_HOME });
  const chat = state.chats.find(entry => entry.id === 'img-chat-1');
  const userMessage = chat.messages.find(message => message.role === 'user');
  const [stored] = userMessage.attachments;
  assert.equal(stored.id, IMAGE_ID);
  assert.equal(stored.url, `/api/media/attachments/${IMAGE_ID}.png`);
  assert.equal(stored.storage, 'file');
  assert.equal(stored.byteSize, IMAGE_BYTES.length);
  assert.equal(stored.mimeType, 'image/png');
  assert.ok(readFileSync(join(attachmentsDir(TEST_HOME), `${IMAGE_ID}.png`)).equals(IMAGE_BYTES));
  assert.equal(chat.attachmentsExternalized, true, 'the chat is marked so the lazy migration does not rescan');

  // Nothing on disk under the thread store carries the base64 payload any more.
  const threadsDir = join(TEST_HOME, 'desktop', 'threads');
  const threadFiles = readdirSync(threadsDir, { recursive: true }).map(name => join(threadsDir, String(name))).filter(path => statSync(path).isFile());
  assert.ok(threadFiles.length, 'the thread checkpoint exists');
  for (const path of threadFiles) {
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('data:image/png;base64'), `${path} must not inline the image`);
    assert.ok(statSync(path).size < 20 * 1024, `${path} stays small (${statSync(path).size} bytes)`);
  }
  assert.ok(!readFileSync(join(TEST_HOME, 'desktop', 'state.json'), 'utf8').includes('base64'));

  // Read-back for the model: the hydrated view restores the exact data URL
  // without touching the persisted message.
  const hydrated = await hydrateMessagesForModel(chat.messages, { home: TEST_HOME });
  assert.equal(hydrated.find(message => message.id === userMessage.id).attachments[0].url, IMAGE_DATA_URL);
  assert.equal(userMessage.attachments[0].url, stored.url);

  // The runner's model request carries the image as a data: part. Re-run the
  // turn as the runner sees it (the file-backed user message is the latest).
  let requestMessages = null;
  const turnChat = { ...chat, messages: chat.messages.filter(message => message.role === 'user') };
  await runChatAgentExecutionGraph({
    config: { authMode: 'unset', apiKey: '', baseUrl: '', model: 'gpt-4o' }, home: TEST_HOME, state, chat: turnChat,
    workspace: { rootPath: '/tmp/test', exists: false, entries: [], filePaths: [], fileCount: 0, selectedFilePath: null, selectedFile: null, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: 'what do you see here?', agentId: 'main',
    _dependencies: { getEmbedding: async () => null, createReply: async options => { requestMessages = options.messages; return 'I see a photo.'; } },
  });
  assert.ok(Array.isArray(requestMessages), 'the injected provider received the request');
  const latestUser = [...requestMessages].reverse().find(message => message.role === 'user');
  assert.ok(Array.isArray(latestUser.content), 'the user turn is multi-part');
  const imagePart = latestUser.content.find(part => part.type === 'image_url');
  assert.ok(imagePart, 'an image_url part is present');
  assert.equal(imagePart.image_url.url, IMAGE_DATA_URL);
  assert.ok(!JSON.stringify(requestMessages).includes('/api/media/attachments/'), 'no local URL leaks into the provider payload');
});
