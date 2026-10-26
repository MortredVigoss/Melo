import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentTool } from './developmentTool.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';

// Review finding 1 (2026-10-26): the tool is permission-gated, but a standing
// "always allow" rule bypasses the approval surface check, so the tool itself
// must refuse any chat that is not a desktop chat.
test('development_job refuses remote and mobile chats before touching the job runtime', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-dev-tool-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = Object.freeze({ ...createRequestContext({ home, env: {} }), capabilityScope: { agentId: 'main', capabilities: {} } });
  for (const chatSource of ['telegram', 'discord', 'mobile']) {
    await assert.rejects(runWithRequestContext(context, () => developmentTool.run({ action: 'list' }, { chatSource })), /desktop chat/, chatSource);
  }
  for (const chatSource of ['desktop', undefined]) {
    const result = await runWithRequestContext(context, () => developmentTool.run({ action: 'list' }, { chatSource }));
    assert.deepEqual(result, { ok: true, output: '[]' }, String(chatSource));
  }
  assert.equal(developmentTool.requiresPermission, true, 'the approval gate stays in place as well');
});
