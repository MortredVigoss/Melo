// Attachment externalization (docs/tool-conversation-memory-design-20261017.md
// §2.3 "UI 长线程性能" item 2).
//
// User attachments used to live as inline `data:` URLs inside the message
// object, so every append rewrote a multi-MB thread file, cold start decoded
// all of that base64 into memory, the whole `activeChat` went to the UI and
// the sync layer carried it too. Large inline payloads are now written once
// to <home>/desktop/attachments/<id>.<ext> (0o600, dir 0o700) and the stored
// attachment keeps a small local URL (/api/media/attachments/<id>.<ext>),
// served by src/http/mediaRoutes.js. Tiny data URLs stay inline.
//
// The model request still needs bytes: `hydrateMessagesForModel` rebuilds
// data URLs for the few messages the message builder can actually send
// (the latest user turn plus the carry-forward reach), without touching the
// persisted chat.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const URL_PREFIX = '/api/media/attachments/';
// Data URLs at or below this size are kept inline: the file round trip would
// cost more than the bytes it saves.
export const INLINE_DATA_URL_LIMIT = 4 * 1024;
// Messages older than this (counted from the end of the thread) never reach
// the model with rich media: buildModelMessagesFromChat strips historical
// user turns and carries media forward at most 4 messages back.
const MODEL_HYDRATION_TAIL = 12;

const EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/avif': 'avif',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/octet-stream': 'bin',
};
const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  bmp: 'image/bmp', tiff: 'image/tiff', avif: 'image/avif',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', weba: 'audio/webm', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', bin: 'application/octet-stream',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only names this module minted resolve: <uuid>.<ext>. Anything else — path
// separators, dots, encoded traversal — is rejected before touching the disk.
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;
const DATA_URL = /^data:([^;,]*)(;[^,]*)?,(.*)$/s;

export const attachmentsDir = home => join(home, 'desktop', 'attachments');
export const attachmentUrl = name => URL_PREFIX + name;

export function isFileAttachmentUrl(url) {
  const value = String(url || '');
  return value.startsWith(URL_PREFIX) && NAME.test(value.slice(URL_PREFIX.length));
}

export function isDataUrl(url) {
  return String(url || '').startsWith('data:');
}

export function extensionForMime(mimeType = '') {
  const normalized = String(mimeType || '').trim().toLowerCase().split(';')[0];
  if (EXTENSIONS[normalized]) return EXTENSIONS[normalized];
  const generic = /^(?:image|audio|video)\/([a-z0-9]{1,8})$/.exec(normalized);
  return generic ? generic[1] : 'bin';
}

export function mimeTypeForName(name = '') {
  const extension = String(name || '').split('.').pop().toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

// The file a local attachment URL points to, or null for anything else
// (remote URLs, data URLs, malformed or traversal-shaped names).
export function attachmentPath(url, home) {
  const value = String(url || '');
  if (!value.startsWith(URL_PREFIX)) return null;
  const name = value.slice(URL_PREFIX.length);
  return NAME.test(name) ? join(attachmentsDir(home), name) : null;
}

function parseDataUrl(url) {
  const match = DATA_URL.exec(String(url || ''));
  if (!match) return null;
  const parameters = String(match[2] || '').toLowerCase();
  if (!parameters.split(';').includes('base64')) return null;
  return { mimeType: String(match[1] || '').trim().toLowerCase() || 'application/octet-stream', payload: match[3] };
}

function shouldExternalize(attachment) {
  if (!attachment || typeof attachment !== 'object') return false;
  const url = String(attachment.url || '');
  return url.startsWith('data:') && url.length > INLINE_DATA_URL_LIMIT && Boolean(parseDataUrl(url));
}

// Writes the decoded bytes next to a temp file and renames it into place, so
// a crash mid-write never leaves a half file under a valid name.
async function writeAttachmentFile(home, name, bytes) {
  const dir = attachmentsDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, name), partial = join(dir, `.${name}.part`);
  try {
    await writeFile(partial, bytes, { mode: 0o600 });
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

async function fileSize(path) {
  try { return (await stat(path)).size; } catch { return null; }
}

// Externalizes one attachment. Returns the file-backed attachment, or the
// input untouched when it is small, already file-backed, remote, or when the
// write fails (the inline bytes are then still the source of truth).
async function externalizeAttachment(attachment, home) {
  if (!shouldExternalize(attachment)) return attachment;
  const parsed = parseDataUrl(attachment.url);
  const bytes = Buffer.from(parsed.payload, 'base64');
  if (!bytes.length) return attachment;
  const extension = extensionForMime(parsed.mimeType || attachment.mimeType);
  let name = `${UUID.test(String(attachment.id || '')) ? String(attachment.id).toLowerCase() : randomUUID()}.${extension}`;
  try {
    const existing = await fileSize(join(attachmentsDir(home), name));
    // The same upload re-attached to a later turn (image follow-up / retry)
    // maps onto the same file; a different payload under a reused id gets
    // its own name rather than overwriting.
    if (existing !== null && existing !== bytes.length) name = `${randomUUID()}.${extension}`;
    if (existing === null || existing !== bytes.length) await writeAttachmentFile(home, name, bytes);
  } catch {
    return attachment;
  }
  return {
    ...attachment,
    url: attachmentUrl(name),
    storage: 'file',
    mimeType: parsed.mimeType || attachment.mimeType || mimeTypeForName(name),
    byteSize: bytes.length,
  };
}

export async function externalizeAttachments(attachments, { home } = {}) {
  if (!Array.isArray(attachments) || !attachments.length || !home) return Array.isArray(attachments) ? attachments : [];
  const result = [];
  let changed = false;
  for (const attachment of attachments) {
    const next = await externalizeAttachment(attachment, home);
    if (next !== attachment) changed = true;
    result.push(next);
  }
  return changed ? result : attachments;
}

// Media extractors copy the attachment URL into extractedMedia metadata
// (`metadata.url` / `metadata.originalUrl`); the UI matches previews by that
// value, so the copy follows the attachment to its file URL.
function rewriteExtractedMediaUrls(extractedMedia, replacements) {
  if (!Array.isArray(extractedMedia) || !replacements.size) return extractedMedia;
  let changed = false;
  const next = extractedMedia.map(entry => {
    const metadata = entry?.metadata;
    if (!metadata || typeof metadata !== 'object') return entry;
    let patched = null;
    for (const key of ['url', 'originalUrl']) {
      const replacement = replacements.get(metadata[key]);
      if (replacement) patched = { ...(patched || metadata), [key]: replacement };
    }
    if (!patched) return entry;
    changed = true;
    return { ...entry, metadata: patched };
  });
  return changed ? next : extractedMedia;
}

// Externalizes a whole message. Returns `message` by identity when nothing
// changed, otherwise a shallow clone with the new attachments (and patched
// extractedMedia metadata).
export async function externalizeMessageAttachments(message, { home } = {}) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const next = await externalizeAttachments(attachments, { home });
  if (next === attachments) return message;
  const replacements = new Map();
  attachments.forEach((attachment, index) => {
    if (next[index] !== attachment) replacements.set(attachment.url, next[index].url);
  });
  return { ...message, attachments: next, extractedMedia: rewriteExtractedMediaUrls(message.extractedMedia, replacements) };
}

// Reads file-backed attachments back into data URLs. Files are read once per
// path per call (`cache`), so an image carried forward across turns is not
// decoded twice. A missing file leaves the attachment untouched — the message
// builder then drops it rather than sending a broken URL.
export async function hydrateAttachments(attachments, { home, cache = new Map() } = {}) {
  if (!Array.isArray(attachments) || !attachments.length || !home) return Array.isArray(attachments) ? attachments : [];
  const result = [];
  let changed = false;
  for (const attachment of attachments) {
    const path = attachmentPath(attachment?.url, home);
    if (!path) { result.push(attachment); continue; }
    let dataUrl = cache.get(path);
    if (dataUrl === undefined) {
      try {
        const mimeType = typeof attachment.mimeType === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType)
          ? attachment.mimeType.toLowerCase() : mimeTypeForName(path);
        dataUrl = `data:${mimeType};base64,${(await readFile(path)).toString('base64')}`;
      } catch {
        dataUrl = null;
      }
      cache.set(path, dataUrl);
    }
    if (!dataUrl) { result.push(attachment); continue; }
    changed = true;
    result.push({ ...attachment, url: dataUrl });
  }
  return changed ? result : attachments;
}

// Model-facing view of a message window: shallow clones of the messages whose
// file-backed attachments were rehydrated; every other message is returned by
// identity. Only the last `tail` messages are considered (see
// MODEL_HYDRATION_TAIL). The persisted chat is never mutated.
export async function hydrateMessagesForModel(messages, { home, tail = MODEL_HYDRATION_TAIL } = {}) {
  if (!Array.isArray(messages) || !messages.length || !home) return Array.isArray(messages) ? messages : [];
  const cache = new Map();
  const start = Math.max(0, messages.length - tail);
  let changed = false;
  const result = messages.slice();
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    const attachments = message?.attachments;
    if (!Array.isArray(attachments) || !attachments.some(attachment => isFileAttachmentUrl(attachment?.url))) continue;
    const hydrated = await hydrateAttachments(attachments, { home, cache });
    if (hydrated === attachments) continue;
    changed = true;
    result[index] = { ...message, attachments: hydrated };
  }
  return changed ? result : messages;
}

// Lazy migration for threads written before externalization. Mutates `chat`
// in place (so the current turn already sees the file URLs) and returns the
// patches to replay onto the freshly loaded chat inside the state write queue
// (`applyAttachmentMigration`). Each file is written before its URL is
// replaced; a failed write keeps the inline data URL and leaves the chat
// unmarked so the next turn tries again.
export async function migrateInlineAttachments(chat, { home } = {}) {
  const migration = { chatId: chat?.id || null, patches: [], migrated: 0, failed: 0, complete: false };
  if (!chat || typeof chat !== 'object' || !home) return migration;
  if (chat.attachmentsExternalized === true) { migration.complete = true; return migration; }
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.some(shouldExternalize)) continue;
    const next = await externalizeMessageAttachments(message, { home });
    const remaining = next.attachments.filter(shouldExternalize).length;
    migration.failed += remaining;
    migration.migrated += attachments.filter(shouldExternalize).length - remaining;
    if (next === message) continue;
    // Patch in place so references held by the caller (the message just
    // pushed for this turn) keep pointing at the same object.
    message.attachments = next.attachments;
    message.extractedMedia = next.extractedMedia;
    migration.patches.push({ messageId: message.id, attachments: next.attachments, extractedMedia: next.extractedMedia });
  }
  migration.complete = migration.failed === 0;
  if (migration.complete) chat.attachmentsExternalized = true;
  return migration;
}

// Replays a migration onto another copy of the same chat (the one loaded
// inside updateStateAtomically). Messages are matched by id; a message that
// disappeared in the meantime is simply skipped.
export function applyAttachmentMigration(chat, migration) {
  if (!chat || !migration || migration.chatId !== chat.id) return chat;
  const byId = new Map(migration.patches.map(patch => [patch.messageId, patch]));
  if (byId.size && Array.isArray(chat.messages)) {
    chat.messages = chat.messages.map(message => {
      const patch = byId.get(message?.id);
      return patch ? { ...message, attachments: patch.attachments, extractedMedia: patch.extractedMedia } : message;
    });
  }
  if (migration.complete) chat.attachmentsExternalized = true;
  return chat;
}
