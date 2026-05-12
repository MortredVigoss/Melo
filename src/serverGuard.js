/**
 * src/serverGuard.js
 *
 * Pure helper extracted from server.js's `_scanForOtherServerInstances`
 * so the per-line matching policy can be unit-tested without booting
 * the server (server.js has a top-level `await _acquireServerLock` that
 * makes import-for-test impractical).
 *
 * The policy here is the single source of truth — server.js imports it.
 *
 * History:
 *   • Pre-fix (≤ 4d572de): regex was `/src\/server\.js/`, matched ANY
 *     server.js with that suffix. Cross-repo false-positive: aihelper
 *     desktop-pet spawning its own `node src/server.js` triggered Melo's
 *     "Another Melo server instance is already running" → blocked
 *     Melo Desktop launch (user screenshot 2026-05-11).
 *   • Fix (6d925a4): match by absolute path of server.js (`fileURLToPath
 *     (import.meta.url)`), so only command lines containing OUR exact
 *     path are considered duplicates. Cross-repo neighbours coexist.
 *
 * This module is import-side-effect-free.
 */

/**
 * Decide whether a single `ps -axo pid=,command=` line represents
 * another running instance of THIS server.js.
 *
 * Per-line policy:
 *   • Line must look like `<pid> <command>` (numeric prefix).
 *   • PID must be present, non-zero, and ≠ caller's self pid.
 *   • Command must contain `node` as a whole word (`\bnode\b`).
 *   • Command must contain `serverPath` (THIS server.js's absolute path)
 *     as a substring.  This is the cross-repo discriminator.
 *
 * @param {string} rawLine    one line of `ps -axo pid=,command=` output
 * @param {number} selfPid    PID of the calling process (skip self)
 * @param {string} serverPath absolute path of THIS server.js
 * @returns {{ pid: number, command: string } | null}
 */
export function _matchOtherServerLine(rawLine, selfPid, serverPath) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const match = line.match(/^(\d+)\s+(.*)$/);
  if (!match) return null;
  const otherPid = Number(match[1]);
  const cmd = match[2];
  if (!otherPid || otherPid === selfPid) return null;
  if (!/\bnode\b/.test(cmd)) return null;
  if (!cmd.includes(serverPath)) return null;
  return { pid: otherPid, command: cmd };
}
