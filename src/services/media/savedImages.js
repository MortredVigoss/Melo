import { realpath } from 'node:fs/promises';
import { readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, relative, resolve, join, isAbsolute, sep } from 'node:path';
import sharp from 'sharp';
import { loadState } from '../../state/stateStore.js';
import { readExecutionScene } from '../chat/executionScenes.js';
import { chatWorkspacePath } from '../workspace/toolWorkspace.js';
import { atomicOpenLeaf, C } from '../../safety/dirfdOps.js';
import { archiveSceneImages, bindImageWorkspace, readImageRecords, imageHomeScope, validRunId } from '../../media/imageRecords.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heif: 'image/heic' };
const failure = (code, statusCode, message) => Object.assign(new Error(message), { code, statusCode });
const unavailable = () => failure('IMAGE_RECORD_MISSING', 404, '未找到这张图片的可信保存记录。');
const inRoot = (root, path) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

function workspaceFor(state, chat, home) {
  return chat.projectId ? state.projects.find(project => project.id === chat.projectId)?.workspacePath
    : chatWorkspacePath(home, chat.id);
}

function messageRunId(chat, message) {
  return validRunId(message.metadata?.runId) ? message.metadata.runId
    : 'legacy-' + createHash('sha256').update(`${chat.id}\0${message.id}`).digest('hex').slice(0, 32);
}

function savedUrlMatchesPath(value, path) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && decodeURIComponent(url.pathname) === `/api/files/signed/${basename(path)}`
      && url.searchParams.getAll('p').length === 1
      && url.searchParams.get('p') === Buffer.from(path).toString('base64url');
  } catch { return false; }
}

function matchesAttachment(artifact, attachment) {
  return attachment.kind === 'image' && (artifact.id === attachment.id
    || [artifact.url, artifact.originalUrl].includes(attachment.url)
    || savedUrlMatchesPath(attachment.url, artifact.path));
}

async function imageBytes(home, chat, record, artifact, fallbackRoot) {
  try { return await originalBytes(record, artifact, fallbackRoot); }
  catch (error) {
    // A recovered binding is immutable. A changed canonical root must remain
    // denied rather than being accepted as another legacy recovery.
    if (artifact.workspacePath || !['IMAGE_FILE_MISSING', 'IMAGE_PATH_DENIED'].includes(error.code)) throw error;
    const path = artifact.path;
    if (!isAbsolute(path) || resolve(path) !== path || basename(dirname(path)) !== 'generated'
      || !/\.(?:png|jpe?g|webp|gif|avif|heic)$/i.test(path)
      || !savedUrlMatchesPath(artifact.originalUrl || artifact.url, path)) throw error;
    const attachment = chat.messages?.filter(m => m.role === 'assistant' && messageRunId(chat, m) === record.runId)
      .flatMap(m => m.attachments || []).find(a => a.kind === 'image' && savedUrlMatchesPath(a.url, path));
    if (!attachment) throw error;
    // Derive the historical root from the locally recorded artifact, never
    // from a request URL or its encoded p parameter. Only direct generated
    // images attested by this chat's saved assistant reply can be recovered.
    const root = dirname(dirname(path));
    if (record.canonicalRoot && record.workspacePath && resolve(record.workspacePath) === root) throw error;
    const canonicalRoot = await realpath(root).catch(() => null);
    if (!canonicalRoot) throw error;
    // Unlike an explicitly chosen workspace, an inferred legacy root has no
    // prior authorization for symlinks. Permit only macOS's system aliases.
    const systemAlias = process.platform === 'darwin' && /^\/(?:tmp|var)(?:\/|$)/.test(root) ? `/private${root}` : root;
    if (canonicalRoot !== root && canonicalRoot !== systemAlias) {
      throw failure('IMAGE_PATH_DENIED', 403, '图片路径包含软链接，无法安全打开。');
    }
    const binding = { workspacePath: root, canonicalRoot };
    const image = await originalBytes(binding, artifact, root);
    const repaired = await bindImageWorkspace(home, record.runId, artifact, binding);
    if (!repaired) throw unavailable();
    return image;
  }
}

// Older telemetry may already have been pruned. Recover only a persisted
// assistant attachment whose URL agrees with a file in THIS chat/project's
// generated folder. Construct the path from that owned root and a basename;
// never decode p into a path, accept a client path, or re-sign arbitrary files.
async function recoverGeneratedAttachment(home, state, chat, message, attachment, runId) {
  const root = workspaceFor(state, chat, home);
  if (!root || !isAbsolute(root)) throw unavailable();
  let url, name;
  try {
    url = new URL(attachment.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.startsWith('/api/files/signed/')) throw unavailable();
    name = decodeURIComponent(url.pathname.slice('/api/files/signed/'.length));
  } catch { throw unavailable(); }
  if (!name || name.includes('/') || name.includes('\\') || !/\.(?:png|jpe?g|webp|gif|avif|heic)$/i.test(name)) throw unavailable();
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) throw unavailable();
  const path = join(resolve(root), 'generated', name);
  const canonicalPath = join(canonicalRoot, 'generated', name);
  if (![path, canonicalPath].some(candidate => Buffer.from(candidate).toString('base64url') === url.searchParams.get('p'))) throw unavailable();
  const artifact = { id: attachment.id, kind: 'image', path, url: attachment.url, title: attachment.label || attachment.title };
  await originalBytes({ workspacePath: root, canonicalRoot }, artifact, root);
  await archiveSceneImages(home, { runId, chatId: chat.id, artifacts: [artifact] }, root);
}

async function originalBytes(record, artifact, fallbackRoot) {
  const binding = artifact.workspacePath ? artifact : record;
  const root = binding.workspacePath || fallbackRoot;
  if (!root || !isAbsolute(root)) {
    throw failure('IMAGE_PATH_DENIED', 403, '图片位置不在已登记的工作目录内。');
  }
  let canonicalRoot;
  try { canonicalRoot = await realpath(root); }
  catch { throw failure('IMAGE_FILE_MISSING', 404, '图片原文件已不存在。'); }
  if (binding.canonicalRoot && binding.canonicalRoot !== canonicalRoot) {
    throw failure('IMAGE_PATH_DENIED', 403, '图片工作目录已变化，无法安全打开。');
  }
  // Canonicalize only the approved root (e.g. /tmp → /private/tmp). The
  // dirfd walk rejects symlinks at every component below it, including leaf.
  const lexicalRoot = resolve(root), artifactPath = resolve(artifact.path);
  const relativePath = inRoot(lexicalRoot, artifactPath) ? relative(lexicalRoot, artifactPath)
    : inRoot(canonicalRoot, artifactPath) ? relative(canonicalRoot, artifactPath) : null;
  if (relativePath === null) throw failure('IMAGE_PATH_DENIED', 403, '图片位置不在已登记的工作目录内。');
  const path = join(canonicalRoot, relativePath);
  let opened;
  try { opened = await atomicOpenLeaf(dirname(path), basename(path), C.O_RDONLY | C.O_NONBLOCK); }
  catch (error) {
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw failure('IMAGE_PATH_DENIED', 403, '图片路径包含软链接，无法安全打开。');
    if (error.code === 'ENOENT') throw failure('IMAGE_FILE_MISSING', 404, '图片原文件已不存在。');
    throw error;
  }
  let bytes;
  try {
    if (!opened.leafStat.isFile()) throw failure('IMAGE_PATH_DENIED', 403, '图片位置不是普通文件。');
    const size = opened.leafStat.size;
    if (size <= 0) throw failure('IMAGE_DAMAGED', 422, '图片文件已损坏，无法读取。');
    if (size > MAX_BYTES) throw failure('IMAGE_TOO_LARGE', 413, '图片超过 64 MB，暂时无法打开。');
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) { const n = readSync(opened.leafFd, bytes, offset, size - offset, offset); if (!n) break; offset += n; }
    if (offset !== size) throw failure('IMAGE_DAMAGED', 422, '图片文件已损坏，无法读取。');
  } finally { opened.closeLeaf(); }
  let metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: 80_000_000, failOn: 'error' }).metadata(); }
  catch { throw failure('IMAGE_DAMAGED', 422, '图片文件已损坏或格式不受支持。'); }
  const type = MIME[metadata.format];
  if (!type) throw failure('IMAGE_DAMAGED', 422, '图片格式不受支持。');
  return { bytes, type, width: metadata.width, height: metadata.height };
}

export async function resolveSavedImage(home, reference) {
  if (!reference?.messageId || String(reference.messageId).length > 200 || String(reference.url || '').length > 8192) throw unavailable();
  const state = await loadState({ home });
  const chat = state.chats.find(c => (!reference.chatId || reference.chatId === c.id) && c.messages?.some(m => m.id === reference.messageId));
  const message = chat?.messages.find(m => m.id === reference.messageId);
  if (message?.role !== 'assistant') throw unavailable();
  const runId = messageRunId(chat, message);
  let record = await readImageRecords(home, runId);
  if (!record) {
    const scene = await readExecutionScene(home, runId);
    if (scene?.chatId === chat.id) await archiveSceneImages(home, scene, workspaceFor(state, chat, home));
    record = await readImageRecords(home, runId);
  }
  if (record && record.chatId !== chat.id) throw unavailable();
  let attachment = message.attachments?.find(a => a.kind === 'image' && (a.id === reference.attachmentId || reference.url && a.url === reference.url));
  if (!attachment && record) {
    // Scene replay projects a different id and refreshed URL into the card.
    // Resolve that alias only through this run's saved artifact AND the
    // persisted message attachment, never through the supplied URL alone.
    const projected = record.artifacts.find(a => a.id === reference.attachmentId
      && (!reference.url || savedUrlMatchesPath(reference.url, a.path)));
    if (projected) attachment = message.attachments?.find(a => a.kind === 'image'
      && (a.url === (projected.originalUrl || projected.url) || savedUrlMatchesPath(a.url, projected.path)));
  }
  if (!attachment) throw unavailable();
  if (!record) {
    await recoverGeneratedAttachment(home, state, chat, message, attachment, runId);
    record = await readImageRecords(home, runId);
  }
  if (!record || record.chatId !== chat.id) throw unavailable();
  let artifact = record.artifacts.find(a => matchesAttachment(a, attachment));
  if (!artifact) {
    await recoverGeneratedAttachment(home, state, chat, message, attachment, runId);
    record = await readImageRecords(home, runId);
    artifact = record?.artifacts.find(a => matchesAttachment(a, attachment));
  }
  if (!artifact) throw unavailable();
  const image = await imageBytes(home, chat, record, artifact, workspaceFor(state, chat, home));
  return { url: `/api/media/images/${record.homeScope}/${runId}/${artifact.key}`, type: image.type, width: image.width, height: image.height };
}

export async function readSavedImage(home, pathname) {
  const match = /^\/api\/media\/images\/([a-f0-9]{24})\/([a-zA-Z0-9_-]{1,128})\/([a-f0-9]{64})$/.exec(pathname);
  if (!match || match[1] !== imageHomeScope(home)) throw unavailable();
  const record = await readImageRecords(home, match[2]);
  const artifact = record?.artifacts.find(a => a.key === match[3]);
  if (!record || !artifact) throw unavailable();
  const state = await loadState({ home });
  const chat = state.chats.find(c => c.id === record.chatId);
  if (!chat) throw unavailable();
  return imageBytes(home, chat, record, artifact, workspaceFor(state, chat, home));
}
