import { scopeMatches, hasApprovalSurface } from '../safety/permissionContext.js';
import { recordPermission } from '../safety/permissionAudit.js';
import { permissionReceipt, rememberPermissionDecision } from '../safety/permissionReceipts.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { resolveRuntimePaths } from '../runtime/paths.js';
/**
 * Tool permission manager.
 *
 * Because Melo is a client-server app (Node.js ↔ WebView via HTTP/SSE),
 * we can't block synchronously for user input. Instead:
 *
 *   1. Tool executor calls requestPermission(toolId, args, sseEmitter)
 *   2. A Promise is stored keyed by a unique requestId
 *   3. sseEmitter fires a "tool_permission" SSE event to the UI
 *   4. UI shows a dialog; user clicks Allow / Deny / Always Allow
 *   5. UI POSTs to /api/tools/permission-response
 *   6. resolvePermission(requestId, granted) is called
 *   7. The original Promise resolves → tool executes (or throws)
 *
 * Session rules persist in memory for the lifetime of the server process.
 * Persistent rules (alwaysAllow patterns) are stored in the user config.
 */

import { randomUUID } from 'node:crypto';
import { getResolvedConfig, loadConfig, saveConfig } from '../config.js';

// In-memory map: requestId → { resolve, reject, timeout, chatId }
const pendingRequests = new Map();

// Session-scoped "always allow" rules, keyed per-chat so that a permission
// granted inside Chat A does NOT silently apply to Chat B (or to Telegram
// requests, which share the same process). Shape: Map<chatId, Set<toolId>>.
const sessionAlwaysAllow = new Map();

// Session-scoped "always deny" rules, same shape.
const sessionAlwaysDeny = new Map();

// Sentinel chat id used when a caller doesn't supply one (e.g. ad-hoc
// CLI invocation, single-chat tests). Keeps a dedicated bucket rather
// than leaking into every chat's scope.
const DEFAULT_CHAT_SCOPE = '__default__';

function scopeKey(chatId) {
  return JSON.stringify([resolveRuntimePaths().home, String(chatId || DEFAULT_CHAT_SCOPE)]);
}

function ensureChatBucket(map, chatId) {
  const key = scopeKey(chatId);
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function chatHas(map, chatId, toolId) {
  return map.get(scopeKey(chatId))?.has(toolId) === true;
}

// How long (ms) to wait for user response before auto-denying
const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * Check whether a tool is already permitted without asking the user.
 * Returns 'allow', 'deny', or 'ask'.
 *
 * Session rules are scoped per-chatId: a grant in one chat does not apply
 * to another. Persistent config rules remain global (user-level policy).
 */
export async function checkPermissionRule(toolId, args = {}, chatId = undefined) {
  // Session deny overrides everything (for this chat)
  if (chatHas(sessionAlwaysDeny, chatId, toolId)) {
    return 'deny';
  }

  // Session allow (for this chat)
  if (chatHas(sessionAlwaysAllow, chatId, toolId)) {
    return 'allow';
  }

  // Persistent config rules (global — intentional; they represent a
  // user-level policy they've explicitly elected to persist)
  try {
    const config = await getResolvedConfig();
    const rules = Array.isArray(config.toolPermissionRules) ? config.toolPermissionRules : [];
    for (const rule of rules) {
      if (rule.toolId === toolId && scopeMatches(rule.permissionScope, currentRequestContext()?.permissionScope)) {
        recordPermission({operation:toolId,decision:rule.action,reason:rule.permissionScope ? '匹配角色与项目授权' : '匹配原有全局工具授权',ruleId:rule.id || rule.toolId});
        if (rule.action === 'allow') return 'allow';
        if (rule.action === 'deny') return 'deny';
      }
    }
  } catch {
    // Config read failure → fall through to 'ask'
  }

  return 'ask';
}

/**
 * Request permission to run a tool.
 * Returns true if permitted, throws if denied or timed out.
 *
 * @param {string}   toolId        - tool identifier
 * @param {Object}   args          - tool arguments (shown to user)
 * @param {Function} sseEmitter    - (event, payload) => void  (sends SSE to UI)
 * @param {AbortSignal} [signal]   - propagated abort
 * @param {string}   [chatId]      - scopes session-level rules to this chat
 * @returns {Promise<void>}        - resolves if allowed, throws if not
 */
export async function requestPermission(toolId, args, sseEmitter, signal, chatId = undefined, context = null) {
  context ||= currentRequestContext() || createRequestContext({ chatId, signal });
  if (currentRequestContext() !== context) {
    return runWithRequestContext(context, () => requestPermission(toolId, args, sseEmitter, signal, chatId, context));
  }
  signal?.throwIfAborted();
  const rule = await checkPermissionRule(toolId, args, chatId);
  signal?.throwIfAborted();
  if (rule === 'allow') return;
  if (rule === 'deny') throw new Error(`Tool "${toolId}" is not permitted by policy.`);

  // No approval surface → answer now instead of waiting the full timeout.
  // Remote channels (Telegram / Discord polling) call the executor without an
  // SSE emitter and the desktop UI does not poll pending requests, so a
  // request here could never be approved; it used to sit for 120 s and then
  // time out, blocking the whole polling loop meanwhile (2026-10-17 audit B-3).
  // Pass `context.permissionSurface = 'headless'` to opt back into waiting
  // (tests and future CLI prompts resolve via resolvePermission()).
  if (!hasApprovalSurface(sseEmitter, context) && context?.permissionSurface !== 'headless') {
    const error = new Error(`Tool "${toolId}" needs user approval, but this channel has no approval surface. Ask the user to run this action from the Melo desktop app instead.`);
    error.code = 'PERMISSION_NO_SURFACE';
    throw error;
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Permission request for "${toolId}" timed out after ${PERMISSION_TIMEOUT_MS / 1000}s.`));
    }, PERMISSION_TIMEOUT_MS);

    // Handle external abort
    const onAbort = () => {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('Aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    pendingRequests.set(requestId, {
      // Stash chatId on the pending entry so that resolvePermission can
      // key session rules to the right chat without requiring the UI to
      // echo it back in the POST body.
      chatId,
      context,
      toolId,
      resolve: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pendingRequests.delete(requestId);
        resolve();
      },
      reject: (reason) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pendingRequests.delete(requestId);
        reject(new Error(reason || `Tool "${toolId}" was denied by the user.`));
      },
    });

    // Notify the UI
    if (typeof sseEmitter === 'function') {
      sseEmitter('tool_permission', {
        requestId,
        toolId,
        args,
        chatId,
        runId: context.runId,
        turnRequestId: context.requestId,
        permissionScope: context.permissionScope || null,
      });
    }
  });
}

/**
 * Called by /api/tools/permission-response when the user responds.
 *
 * @param {string}  requestId
 * @param {boolean} granted
 * @param {string}  [scope] - 'once' | 'session' | 'always'
 * @param {string}  toolId  - needed when scope is 'session' or 'always'
 */
export async function resolvePermission(requestId, granted, scope = 'once', toolId = '') {
  const pending = pendingRequests.get(requestId);
  if (!pending) return permissionReceipt(requestId) || { ok: false, reason: 'Unknown or expired request.' };
  if (pending.context.home !== resolveRuntimePaths().home) return { ok: false, reason: 'Permission belongs to another home.' };
  if (toolId && toolId !== pending.toolId) return { ok: false, reason: 'Tool does not match the permission request.' };
  toolId = pending.toolId;
  if (currentRequestContext() !== pending.context) {
    return runWithRequestContext(pending.context, () => resolvePermission(requestId, granted, scope, toolId));
  }
  if (pending.context.signal?.aborted) return { ok: false, reason: 'Request was cancelled.' };
  if (pending.resolving) return { ok: false, reason: 'A decision is already being applied.' };
  if (!['once', 'session', 'always'].includes(scope)) return { ok: false, reason: 'Invalid permission scope.' };
  pending.resolving = true;
  try {

  // The chatId was captured when the request was created; using it here
  // guarantees session rules land in the right per-chat bucket even if
  // concurrent chats resolve permissions interleaved.
  const chatId = pending.chatId;

  // Apply scope rules before resolving
  if (toolId) {
    if (scope === 'session' && granted) {
      ensureChatBucket(sessionAlwaysAllow, chatId).add(toolId);
    } else if (scope === 'session' && !granted) {
      ensureChatBucket(sessionAlwaysDeny, chatId).add(toolId);
    } else if (scope === 'always' && granted) {
      // Persist to config (global — 'always' scope is user-level policy)
      await persistPermissionRule(toolId, 'allow');
    } else if (scope === 'always' && !granted) {
      await persistPermissionRule(toolId, 'deny');
    }
  }

  recordPermission({operation:toolId,decision:granted ? 'allow' : 'deny',reason:`用户决定 · ${scope}`}, pending.context);
  rememberPermissionDecision(requestId);
  if (granted) {
    pending.resolve();
  } else {
    pending.reject(`Tool "${toolId || requestId}" was denied by the user.`);
  }

  return { ok: true };
  } catch (error) {
    pending.resolving = false;
    return { ok: false, reason: `无法保存授权：${error.message}` };
  }
}

/**
 * Persist a permanent permission rule to the user config.
 *
 * IMPORTANT: Uses `loadConfig()` (pure disk state) rather than
 * `getResolvedConfig()` because the latter injects env-var overrides
 * (MELO_API_KEY, OPENAI_API_KEY, MELO_BASE_URL, MELO_SYSTEM_PROMPT, ...)
 * and a runtime-only `codexAuth` object. Persisting those back to disk
 * would bake transient env values into the file. `saveConfig` also
 * normalizes any missing field to DEFAULT_CONFIG's value, so we MUST
 * spread the full current config — otherwise apiKey / whisperApiKey /
 * domainCookies / minimaxApiKey / lastFmApiKey / tavilyApiKey /
 * serpApiKey / etc. all get wiped the moment a user clicks
 * "Always allow" on any tool.
 */
export async function persistPermissionRule(toolId, action) {
  const permissionScope = currentRequestContext()?.permissionScope || null;
  try {
    // Wrap in withConfigLock so two concurrent "Always allow" clicks
    // (or a permission write racing an updateModelConfig) can't both
    // load the same baseline and have one overwrite the other.
    const { withConfigLock } = await import('../config.js');
    await withConfigLock(async () => {
      const current = await loadConfig();
      const rules = Array.isArray(current.toolPermissionRules) ? [...current.toolPermissionRules] : [];
      const idx = rules.findIndex(r => r.toolId === toolId && JSON.stringify(r.permissionScope || null) === JSON.stringify(permissionScope));
      if (idx >= 0) {
        rules[idx] = { toolId, action, ...(permissionScope ? {permissionScope,id:rules[idx].id || randomUUID(),createdAt:Date.now()} : {}) };
      } else {
        rules.push({ toolId, action, ...(permissionScope ? {permissionScope,id:randomUUID(),createdAt:Date.now()} : {}) });
      }
      await saveConfig({ ...current, toolPermissionRules: rules });
    });
  } catch (error) {
    throw error;
  }
}

/**
 * Clear session-scope permission rules.
 *
 * - With a chatId: clears only that chat's session rules (safe to call
 *   when the user starts a new chat in a single tab without affecting
 *   other concurrent chats).
 * - Without a chatId: clears *all* session rules across all chats — use
 *   only for admin/debug flows (e.g. "reset everything" button), not for
 *   per-chat lifecycle.
 */
export function clearSessionPermissions(chatId = undefined) {
  if (chatId === undefined) {
    sessionAlwaysAllow.clear();
    sessionAlwaysDeny.clear();
    return;
  }
  const key = scopeKey(chatId);
  sessionAlwaysAllow.delete(key);
  sessionAlwaysDeny.delete(key);
}

/**
 * Get session-scope rules.
 *
 * - With a chatId: returns `{ allow: [...], deny: [...] }` for that chat.
 * - Without a chatId: returns a flattened view (union across all chats)
 *   so the legacy admin UI keeps working. Callers that need per-chat
 *   isolation must pass the chatId.
 */
export function getSessionPermissions(chatId = undefined) {
  if (chatId !== undefined) {
    const key = scopeKey(chatId);
    return {
      allow: [...(sessionAlwaysAllow.get(key) || [])],
      deny: [...(sessionAlwaysDeny.get(key) || [])],
    };
  }
  const allow = new Set();
  const deny = new Set();
  for (const set of sessionAlwaysAllow.values()) for (const id of set) allow.add(id);
  for (const set of sessionAlwaysDeny.values()) for (const id of set) deny.add(id);
  return { allow: [...allow], deny: [...deny] };
}

/**
 * Get all pending permission requests (for debug/admin).
 */
export function getPendingPermissions() {
  return [...pendingRequests.keys()];
}
