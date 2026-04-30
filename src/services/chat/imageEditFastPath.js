// Image-edit fast-path for the Codex chat 流.
//
// Why this module exists
// ----------------------
// User audit 2026-04-30 identified that running image edits through
// the normal ReAct agent loop produces visibly worse results than
// ChatGPT's image editor. The cause has two halves we control:
//
//   1. The agent system prompt is huge (memory + project + retrieval +
//      tool routing + viz + citations + …). Image-edit instructions
//      compete with all of that and the model defaults to "I need a
//      file path" or re-paints loosely.
//   2. The chat-side image_generation tool config is bare (Codex
//      rejects input_fidelity, background, etc.) so there's no
//      tool-level signal to preserve unedited regions either.
//
// This fast-path short-circuits the agent loop when we recognise an
// image-edit intent. Instead of the full ReAct stack, we run the
// dedicated two-stage editImageViaCodex pipeline (vision analysis →
// image edit) with a frozen minimal prompt — no agent system prompt,
// no tool routing, no memory injection. The user gets a markdown URL
// of the edited image inlined in the chat. Failures fall through to
// the normal agent loop so the model can still apologise / explain.
//
// Gating (all must hold; AND only):
//   • config.authMode === 'codex' — only the Codex OAuth path has the
//     image_generation tool we rely on.
//   • workspace.rootPath is a writable absolute path — we save the
//     edited image into <workspace>/generated/ so the URL signer +
//     extractUrlAttachmentsFromText pipeline picks it up as a normal
//     image attachment on the assistant message.
//   • Latest user-role message carries an image_url part — the user
//     must have actually uploaded an image to edit. Cross-turn
//     reference still works because the message-builder's
//     IMAGE_FOLLOW_UP_PATTERN already carries earlier-turn images
//     forward when the latest text reads as an edit ask.
//   • detectImageEditIntent(latestUserText) is true — pinned in
//     messageBuilder.js, permissive on purpose since the image gate
//     above already bounds false positives.
//
// One gate fails → return null → caller (chatExecutionRunner) runs
// the normal agent loop verbatim. No throwing, no warnings on the
// happy path.

import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { editAndSaveImageViaCodex } from '../../images/codexImageEngine.js';
import { detectImageMimeFromBytes } from '../../images/imageGen.js';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';
import { detectImageEditIntent, IMAGE_FOLLOW_UP_PATTERN } from './messageBuilder.js';

// 1KiB floor — same as imageGen / codexImageEngine. Anything smaller is
// almost certainly a partial / placeholder, not a real image.
const IMAGE_MIN_BYTES = 1024;

/**
 * Find the latest user-role message's image_url. Scans in reverse so a
 * conversation with multiple images gets the most recently uploaded
 * one (matches the user's mental model: "edit the picture I just
 * sent"). Cross-turn carry-forward via messageBuilder lifts a
 * previous-turn image into the latest message before we get here, so
 * this function only has to look at one turn.
 */
export function findLatestUserImageUrl(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part?.type === 'image_url' &&
        typeof part?.image_url?.url === 'string' &&
        part.image_url.url.trim()
      ) {
        return part.image_url.url.trim();
      }
    }
  }
  return null;
}

/**
 * Extract the latest user message's plain text. Handles both plain
 * string content (old shape) and structured content arrays (new
 * shape with text + image_url parts). Joins multiple text parts with
 * a single space.
 */
export function findLatestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (typeof part?.text === 'string') parts.push(part.text);
        else if (
          part?.type === 'text' &&
          typeof part.text === 'string'
        ) {
          parts.push(part.text);
        }
      }
      if (parts.length) return parts.join(' ').trim();
    }
  }
  return '';
}

/**
 * Resolve an image_url to bytes + sniffed mime. Returns null on any
 * failure (malformed URI, too-small buffer, mime sniff fail).
 * Designed to never throw — callers fall through to the agent loop
 * when this returns null.
 *
 * SECURITY: data: URIs ONLY — http(s) URLs are unconditionally rejected.
 * ─────────────────────────────────────────────────────────────────────
 * Codex review (2026-04-30) flagged the original draft as a
 * server-side request forgery (SSRF) risk: melo runs Telegram /
 * Discord bot pollers, so a remote user could plant a URL like
 *   `http://127.0.0.1:8080/internal.png`
 *   `http://169.254.169.254/latest/meta-data/iam/security-credentials/.png`
 * inside a chat message. melo's URL detector promotes any extension-
 * matching link to a kind:'image' attachment, the attachment URL ends
 * up as `image_url` on a model message, and resolveImageBytes would
 * have happily fetched it server-side and forwarded the body to
 * Codex — leaking metadata from the host's loopback / private /
 * link-local network in the process.
 *
 * Hardening rule: the only safe image source is one whose bytes
 * arrive **inline** from the upload step — i.e. a data: URI. data:
 * URIs are self-contained: the bytes are already in the URL, so
 * there is no out-of-band fetch and no opportunity for a remote
 * user to pivot the server's network identity.
 *
 * Consequences for Telegram / Discord uploads:
 *   • Telegram / Discord image attachments arrive as Telegram /
 *     Discord CDN https URLs, NOT data: URIs. So fast-path will not
 *     fire for them — they fall through to the normal chat 流, which
 *     uses the existing buildCodexResponsesInput → readAttachment
 *     Resource pipeline. That pipeline has its OWN preexisting
 *     trust boundary (a separate concern, NOT introduced by this
 *     module); tightening it is a future PR's job.
 *   • Desktop drag-drop uploads come in as data: URIs already. So
 *     fast-path is a desktop-only feature in practice, which
 *     matches the user-visible UX the design audit asked for.
 *
 * Future enhancement (out of scope for this PR): also accept
 * URLs that pass `verifySignedFileUrl` (signed workspace URLs).
 * Those map to known absolute paths on disk that melo wrote
 * itself, so reading them locally bypasses any network call.
 */
export async function resolveImageBytes(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('data:')) return null;

  const match = url.match(/^data:(image\/[^;,]+);base64,(.*)$/i);
  if (!match) return null;
  let bytes;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (bytes.length < IMAGE_MIN_BYTES) return null;
  // Trust the bytes, not the data: URI's declared mime — same rule
  // imageGen / codexImageEngine enforce. A `data:image/png;base64,
  // <ASCII garbage>` URI is exactly the failure shape Codex review
  // round 3 made us pin against; we MUST reject it even though the
  // declared content-type says image.
  const sniffed = detectImageMimeFromBytes(bytes);
  if (!sniffed) return null;
  return { bytes, mime: sniffed };
}

/**
 * Allocate a fresh `<workspace>/generated/img-<ts>-<rand>.png` path.
 * Mirrors imageTool.allocateWorkspaceOutputPath so all chat-side
 * image artifacts share the same on-disk folder + naming scheme.
 * Always uses .png because editAndSaveImageViaCodex's stage 2 returns
 * PNG by default (Codex's image_generation tool default output).
 */
export async function allocateEditedImagePath(workspacePath) {
  if (
    !workspacePath ||
    typeof workspacePath !== 'string' ||
    !workspacePath.startsWith('/')
  ) {
    throw new Error('allocateEditedImagePath requires an absolute workspace path');
  }
  const dir = join(workspacePath, 'generated');
  await mkdir(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return join(dir, `img-${ts}-${rand}.png`);
}

/**
 * Top-level fast-path dispatcher. Runs the gating, and on a hit, the
 * full edit pipeline. Returns the markdown URL reply on success or
 * `null` when ANY gate failed / save failed / resolve failed. Callers
 * (chatExecutionRunner.invoke-model) fall through to the normal
 * ReAct agent loop on null.
 *
 * @param {object} opts
 * @param {object} opts.config        chat-side config (auth mode + …)
 * @param {Array}  opts.messages      modelMessages (post buildModelMessagesFromChat)
 * @param {object} opts.workspace     { rootPath, … } from graph state
 * @param {AbortSignal} [opts.signal]
 * @param {Function}    [opts.onDelta]  stream callback (UI sees the URL ASAP)
 * @param {Function}    [opts.sseEmitter]
 * @param {Function}    [opts.editFn]   test-only override for editAndSaveImageViaCodex
 * @returns {Promise<string|null>}    assistant reply text, or null
 */
export async function tryImageEditFastPath({
  config,
  messages,
  workspace,
  signal,
  onDelta,
  sseEmitter,
  editFn = editAndSaveImageViaCodex,
} = {}) {
  // Gate 1: Codex OAuth only.
  if (config?.authMode !== 'codex') return null;

  // Gate 2: writable workspace.
  const workspacePath = workspace?.rootPath;
  if (typeof workspacePath !== 'string' || !workspacePath.startsWith('/')) return null;

  // Gate 3: must have an uploaded image somewhere in the
  // (post-carry-forward) message window.
  const sourceUrl = findLatestUserImageUrl(messages);
  if (!sourceUrl) return null;

  // Gate 4: latest user text must read as an edit ask.
  const userText = findLatestUserText(messages);
  if (!userText) return null;
  if (!detectImageEditIntent(userText)) return null;

  // Gate 5: latest user text must ALSO reference an image OBJECT.
  // Codex review round 5 (2026-04-30) flagged a misroute case: a
  // chat with an earlier image + a later "把这个函数改成 async"
  // had the image carried forward (the old IMAGE_FOLLOW_UP_PATTERN
  // matched bare 改成) AND detectImageEditIntent matched 改成 →
  // fast-path fired on a pure code-edit turn.
  //
  // After narrowing IMAGE_FOLLOW_UP_PATTERN to image-OBJECT phrases
  // only, that pattern is now exactly the right "is the user talking
  // about an image?" check we need on top of the edit-intent check.
  // The chain is now:
  //   • IMAGE_EDIT_INTENT_PATTERN — "user wants to edit something"
  //     (permissive, includes generic verbs)
  //   • IMAGE_FOLLOW_UP_PATTERN — "user is talking about an image"
  //     (strict, image-object phrases only)
  //   • Both must match → it's an image edit, not a code/text edit
  //     that happens to share verbs.
  // Examples:
  //   "把这张图改成 gpt"  edit ✓ + image ✓ → fire
  //   "把这个函数改成 async"  edit ✓ + image ✗ → fall through
  //   "换背景"  edit ✓ + image ✓ → fire
  //   "修改函数"  edit ✓ + image ✗ → fall through
  if (!IMAGE_FOLLOW_UP_PATTERN.test(userText)) return null;

  // ── All gates passed. Resolve bytes and run the edit ────────────────
  // resolveImageBytes intentionally only accepts data: URIs — see the
  // SECURITY block in that function. Any http(s) URL returns null,
  // dropping the fast-path and routing the request through the normal
  // chat 流 (which has its own preexisting URL-fetch boundary in
  // buildCodexResponsesInput). For Telegram / Discord image uploads
  // (which arrive as CDN https URLs) this means the fast-path is a
  // desktop-only feature in practice — by design.
  const resolved = await resolveImageBytes(sourceUrl);
  if (!resolved) return null;

  let outputPath;
  try {
    outputPath = await allocateEditedImagePath(workspacePath);
  } catch {
    return null;
  }

  let result;
  try {
    result = await editFn({
      outputPath,
      prompt: userText,
      sourceImageBytes: resolved.bytes,
      sourceImageMime: resolved.mime,
      signal,
    });
  } catch {
    // editImageViaCodex itself throws on Codex 4xx / 5xx, on missing
    // credentials, on stream stall. Falling through to the agent
    // loop is the right move — the model will produce a text reply
    // explaining what went wrong, the user can retry.
    return null;
  }

  let url;
  try {
    url = signWorkspaceFileUrl(result.path);
  } catch {
    return null;
  }

  // Bracket the URL with blank lines so it never glues to surrounding
  // prose ("Here's a cat:![cat](http…)" would render but reads worse)
  // — same shape the inline image-generation path uses.
  const reply = `\n\n![edited image](${url})\n\n`;

  // Stream the URL to the UI immediately so users see the result
  // appear inline, matching ChatGPT's image-editor experience.
  if (typeof onDelta === 'function') {
    try {
      await onDelta({ delta: reply, text: reply });
    } catch {
      /* best-effort streaming — never block the return on a UI hiccup */
    }
  }
  if (typeof sseEmitter === 'function') {
    try {
      sseEmitter('reply_text', { text: reply });
    } catch {
      /* same */
    }
  }

  return reply;
}
