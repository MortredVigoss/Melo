// Codex CLI resolution (2026-10-19): the Codex desktop app was merged into
// ChatGPT.app, and a broken npm `codex` launcher must not be picked just
// because it is executable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexExecutableCandidates, resolveCodexExecutable } from './codexAuth.js';

const APP_CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

test('ChatGPT.app bundled CLI comes right after explicit overrides', () => {
  const list = codexExecutableCandidates({ MELO_CODEX_PATH: '/x/codex' }, '/Users/u');
  assert.equal(list[0], '/x/codex');
  assert.ok(list.indexOf(APP_CLI) < list.indexOf('/Applications/Codex.app/Contents/Resources/codex'));
  assert.ok(list.includes('/Users/u/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'));
  assert.equal(list.at(-1), 'codex');
});

test('a candidate that is executable but cannot start is skipped', async () => {
  const run = async (file, args) => {
    if (file === 'which') return { stdout: '/nvm/bin/codex\n' };
    if (file === '/nvm/bin/codex') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    if (file === APP_CLI && args[0] === '--version') return { stdout: 'codex-cli 0.163.0\n' };
    throw new Error(`unexpected ${file}`);
  };
  const isExecutable = async () => true;
  assert.equal(await resolveCodexExecutable({ candidates: ['codex', APP_CLI], run, isExecutable }), APP_CLI);
  assert.equal(await resolveCodexExecutable({ candidates: ['codex'], run, isExecutable }), 'codex', 'falls back to the bare name');
  assert.equal(await resolveCodexExecutable({ candidates: ['', null, APP_CLI], run, isExecutable: async path => path !== APP_CLI }), 'codex', 'non-executable path skipped');
});
