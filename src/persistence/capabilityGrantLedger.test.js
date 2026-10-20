import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGrant, pruneGrants, readLedger, writeLedger, ledgerPath, MAX_GRANTS } from './capabilityGrantLedger.js';

const H = 3600000;
const grant = (extra = {}) => ({ id: 'cg_1', agentId: 'builder', atoms: ['writeFiles'], kind: 'elevate-beyond-parent', scope: 'project', projectId: 'p1', chatId: 'c1',
  decidedBy: 'user', createdAt: 1000, expiresAt: 1000 + 24 * H, ...extra });
const home = t => { const dir = mkdtempSync(join(tmpdir(), 'melo-grants-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('records are validated: shape, scope binding, user decision, atom grammar', () => {
  assert.deepEqual(normalizeGrant(grant()).atoms, ['writeFiles']);
  assert.equal(normalizeGrant(grant({ atoms: ['network', 'writeFiles'] })).atoms.join(), 'writeFiles,network', 'atoms are stored in canonical order');
  for (const broken of [{ id: '' }, { agentId: null }, { scope: 'forever' }, { kind: 'root' }, { atoms: [] }, { atoms: ['bash'] }, { expiresAt: 500 },
    { decidedBy: 'model' }, { decidedBy: undefined }, { scope: 'project', projectId: null }, { scope: 'chat', chatId: null }, { scope: 'run', runId: 'r' }, { scope: 'run', bootId: 'b' }]) {
    assert.equal(normalizeGrant(grant(broken)), null, JSON.stringify(broken));
  }
  assert.ok(normalizeGrant(grant({ scope: 'run', runId: 'r', bootId: 'b' })));
  assert.equal(normalizeGrant(grant({ scope: 'chat', projectId: 'p1' })).projectId, null, 'chat grants never carry a project');
  assert.equal(normalizeGrant(grant({ extra: 'x', capabilities: { runCommands: true } })).capabilities, undefined, 'unknown fields are dropped');
  assert.equal(normalizeGrant([]), null);
});

test('prune drops expired grants, run grants of another process and caps the size', () => {
  const now = 5000;
  const list = [grant({ id: 'live' }), grant({ id: 'old', expiresAt: now }), grant({ id: 'run-here', scope: 'run', runId: 'r', bootId: 'boot-a' }), grant({ id: 'run-before', scope: 'run', runId: 'r', bootId: 'boot-0' })];
  assert.deepEqual(pruneGrants(list, { now, bootId: 'boot-a' }).map(g => g.id), ['live', 'run-here']);
  const many = Array.from({ length: MAX_GRANTS + 7 }, (_, i) => grant({ id: `g${i}` }));
  const kept = pruneGrants(many, { now, bootId: 'x' });
  assert.equal(kept.length, MAX_GRANTS);
  assert.equal(kept.at(-1).id, `g${MAX_GRANTS + 6}`, 'the newest grants are kept');
});

test('write is atomic and private (0600 file, 0700 directory) and round-trips', t => {
  const dir = home(t);
  const path = writeLedger(dir, [grant(), { junk: true }]);
  assert.equal(path, ledgerPath(dir));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'desktop')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(dir, 'desktop')), ['capability-grants.json'], 'no temp file is left behind');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.grants.map(g => g.id), ['cg_1'], 'invalid records are never written');
  assert.deepEqual(readLedger(dir).grants.map(g => g.id), ['cg_1']);
  writeLedger(dir, []);
  assert.deepEqual(readLedger(dir).grants, []);
});

test('a missing ledger is empty; a corrupt one is kept aside and fails closed', t => {
  const dir = home(t);
  assert.deepEqual(readLedger(dir), { version: 1, grants: [] });
  mkdirSync(join(dir, 'desktop'), { recursive: true });
  writeFileSync(ledgerPath(dir), '{"version":1,"grants":[{"id":"x"');
  assert.deepEqual(readLedger(dir).grants, []);
  assert.ok(readdirSync(join(dir, 'desktop')).some(name => name.startsWith('capability-grants.json.corrupt-')));
  writeFileSync(ledgerPath(dir), JSON.stringify({ version: 9, grants: [grant()] }));
  assert.deepEqual(readLedger(dir).grants, [], 'an unknown version is not trusted');
});
