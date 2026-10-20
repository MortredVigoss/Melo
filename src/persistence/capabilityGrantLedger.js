// Capability grant ledger (2026-10-20, docs/capability-elevation-20261020.md).
//
// A separate desktop-local file, `<home>/desktop/capability-grants.json`, not a
// state.json collection and not knowledge / memory: it never enters prompts,
// bootstrap, Markdown export or mobile sync, and the file-safety gate treats it
// as Melo-internal (agent writes are hard-blocked, reads need approval). Only
// src/services/agent/capabilityElevation.js writes it, and only after a user
// decision on a live request (enforced by capabilityElevation.boundary.test.js).
//
// Format: { version: 1, grants: [GrantRecord] }. Writes are atomic (temp file
// in the same directory, fsync, rename), the file is 0600 and its directory
// 0700. Records are validated on read; expired grants, revoked grants and run
// grants of a previous process are pruned on every read and write.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAPABILITY_ELEVATION, isCapabilityAtom, sortAtoms } from '../domain/agent/capabilityElevation.js';

export const LEDGER_VERSION = 1;
export const LEDGER_FILE = 'capability-grants.json';
export const MAX_GRANTS = 500;

export const ledgerPath = home => join(home, 'desktop', LEDGER_FILE);

const text = (value, max = 200) => (typeof value === 'string' && value.trim() && value.length <= max ? value : null);
const time = value => (Number.isFinite(value) && value > 0 ? value : null);

/** A valid record, or null. Unknown fields are dropped; nothing is widened. */
export function normalizeGrant(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id, 80), agentId = text(raw.agentId, 100);
  const scope = Object.hasOwn(CAPABILITY_ELEVATION.grantScopes, raw.scope) ? raw.scope : null;
  const kind = CAPABILITY_ELEVATION.grantKinds.includes(raw.kind) ? raw.kind : null;
  const atoms = Array.isArray(raw.atoms) && raw.atoms.length && raw.atoms.length <= 16 && raw.atoms.every(isCapabilityAtom) ? sortAtoms(raw.atoms) : null;
  const createdAt = time(raw.createdAt), expiresAt = time(raw.expiresAt);
  if (!id || !agentId || !scope || !kind || !atoms || !createdAt || !expiresAt || expiresAt <= createdAt) return null;
  const record = {
    id, agentId, atoms, kind, scope,
    runId: scope === 'run' ? text(raw.runId) : null,
    // Run grants keep their project for display; chat grants exist only outside projects.
    projectId: scope === 'chat' ? null : text(raw.projectId),
    chatId: text(raw.chatId),
    parentAgentId: text(raw.parentAgentId, 100),
    toolId: text(raw.toolId, 240),
    requestId: text(raw.requestId, 80),
    decidedBy: raw.decidedBy === 'user' ? 'user' : null,
    createdAt, expiresAt,
    bootId: scope === 'run' ? text(raw.bootId, 80) : null,
  };
  if (scope === 'run' && (!record.runId || !record.bootId)) return null;
  if (scope === 'project' && !record.projectId) return null;
  if (scope === 'chat' && !record.chatId) return null;
  if (record.decidedBy !== 'user') return null;
  return record;
}

/** Drop expired and revoked grants and run grants of another process. */
export function pruneGrants(grants, { now = Date.now(), bootId } = {}) {
  return (Array.isArray(grants) ? grants : [])
    .map(normalizeGrant)
    .filter(grant => grant && grant.expiresAt > now && (grant.scope !== 'run' || grant.bootId === bootId))
    .slice(-MAX_GRANTS);
}

/**
 * Read the ledger. A missing file is an empty ledger; an unreadable or
 * malformed one is kept aside as `capability-grants.json.corrupt-<time>` and
 * treated as empty (it can only ever have held grants, so failing closed is safe).
 */
export function readLedger(home) {
  const path = ledgerPath(home);
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: LEDGER_VERSION, grants: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.grants)) throw new Error('unsupported ledger');
    return { version: LEDGER_VERSION, grants: parsed.grants.map(normalizeGrant).filter(Boolean) };
  } catch {
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch {}
    return { version: LEDGER_VERSION, grants: [] };
  }
}

/** Atomic, private write. `home` is captured by the caller (CLAUDE.md §6). */
export function writeLedger(home, grants) {
  const dir = join(home, 'desktop');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = ledgerPath(home);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ version: LEDGER_VERSION, grants: grants.map(normalizeGrant).filter(Boolean) }, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return path;
}
