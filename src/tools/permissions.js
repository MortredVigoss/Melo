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
  if (chatId === undefined || chatId === null || chatId === '') return DEFAULT_CHAT_SCOPE;
  return String(chatId);
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
      if (rule.toolId === toolId) {
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
export async function requestPermission(toolId, args, sseEmitter, signal, chatId = undefined) {
  const rule = await checkPermissionRule(toolId, args, chatId);
  if (rule === 'allow') return;
  if (rule === 'deny') throw new Error(`Tool "${toolId}" is not permitted by policy.`);

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
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
      chatId: scopeKey(chatId),
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
  if (!pending) return { ok: false, reason: 'Unknown or expired request.' };

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

  if (granted) {
    pending.resolve();
  } else {
    pending.reject(`Tool "${toolId || requestId}" was denied by the user.`);
  }

  return { ok: true };
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
  try {
    // Wrap in withConfigLock so two concurrent "Always allow" clicks
    // (or a permission write racing an updateModelConfig) can't both
    // load the same baseline and have one overwrite the other.
    const { withConfigLock } = await import('../config.js');
    await withConfigLock(async () => {
      const current = await loadConfig();
      const rules = Array.isArray(current.toolPermissionRules) ? [...current.toolPermissionRules] : [];
      const idx = rules.findIndex(r => r.toolId === toolId);
      if (idx >= 0) {
        rules[idx] = { toolId, action };
      } else {
        rules.push({ toolId, action });
      }
      await saveConfig({ ...current, toolPermissionRules: rules });
    });
  } catch {
    // Non-fatal — rule just won't persist
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
