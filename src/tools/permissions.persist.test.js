/**
 * Regression test for the config-wipe bug in persistPermissionRule.
 *
 * Prior to the fix, persistPermissionRule called
 *   saveConfig({ toolPermissionRules: rules })
 * which — because saveConfig normalizes via {...DEFAULT_CONFIG, ...config}
 * — reset every other user field (apiKey, whisperApiKey, whisperBaseUrl,
 * domainCookies, minimaxApiKey, lastFmApiKey, tavilyApiKey, serpApiKey, …)
 * to DEFAULT_CONFIG values the moment a user clicked "Always allow" on
 * any tool. The fix spreads the current loadConfig() result, so other
 * fields survive.
 *
 * This test seeds a realistic config, calls persistPermissionRule, then
 * asserts that *every* non-rule field is still present and correct.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use dynamic import inside each test so that the module's env-var-
// dependent code (MELO_HOME) picks up the per-test temp dir.
async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-perm-persist-'));
  const prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
}

test('persistPermissionRule preserves all other user config fields', async () => {
  await withTempMeloHome(async (dir) => {
    const configPath = join(dir, 'config.json');
    const seeded = {
      apiKey: 'sk-test-1234567890',
      whisperApiKey: 'whisper-abc',
      whisperBaseUrl: 'https://whisper.example.com/v1',
      minimaxApiKey: 'mm-xyz',
      minimaxGroupId: 'group-42',
      lastFmApiKey: 'lastfm-key',
      tavilyApiKey: 'tvly-key',
      serpApiKey: 'serp-key',
      domainCookies: {
        'douyin.com': 'sessionid=abc',
        'y.qq.com': 'uin=123; skey=xyz',
      },
      systemPrompt: 'custom system prompt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      authMode: 'codex',
      model: 'gpt-5.4',
    };
    await writeFile(configPath, JSON.stringify(seeded, null, 2), 'utf8');

    const { persistPermissionRule } = await import(
      `./permissions.js?tc=${Date.now()}-a`
    );
    await persistPermissionRule('bash', 'allow');

    const raw = await readFile(configPath, 'utf8');
    const after = JSON.parse(raw);

    // The rule was persisted
    assert.deepEqual(after.toolPermissionRules, [{ toolId: 'bash', action: 'allow' }]);

    // Every seeded field survives
    assert.equal(after.apiKey, seeded.apiKey, 'apiKey wiped');
    assert.equal(after.whisperApiKey, seeded.whisperApiKey, 'whisperApiKey wiped');
    assert.equal(after.whisperBaseUrl, seeded.whisperBaseUrl, 'whisperBaseUrl wiped');
    assert.equal(after.minimaxApiKey, seeded.minimaxApiKey, 'minimaxApiKey wiped');
    assert.equal(after.minimaxGroupId, seeded.minimaxGroupId, 'minimaxGroupId wiped');
    assert.equal(after.lastFmApiKey, seeded.lastFmApiKey, 'lastFmApiKey wiped');
    assert.equal(after.tavilyApiKey, seeded.tavilyApiKey, 'tavilyApiKey wiped');
    assert.equal(after.serpApiKey, seeded.serpApiKey, 'serpApiKey wiped');
    assert.equal(after.systemPrompt, seeded.systemPrompt, 'systemPrompt wiped');
    assert.deepEqual(after.domainCookies, seeded.domainCookies, 'domainCookies wiped');
  });
});

test('persistPermissionRule updates an existing rule in place', async () => {
  await withTempMeloHome(async (dir) => {
    const configPath = join(dir, 'config.json');
    const seeded = {
      apiKey: 'sk-keep-me',
      toolPermissionRules: [
        { toolId: 'bash', action: 'allow' },
        { toolId: 'fetch_url', action: 'allow' },
      ],
    };
    await writeFile(configPath, JSON.stringify(seeded, null, 2), 'utf8');

    const { persistPermissionRule } = await import(
      `./permissions.js?tc=${Date.now()}-b`
    );
    await persistPermissionRule('bash', 'deny');

    const after = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(after.apiKey, 'sk-keep-me', 'apiKey wiped during update');
    assert.deepEqual(
      after.toolPermissionRules,
      [
        { toolId: 'bash', action: 'deny' },       // was 'allow', now 'deny'
        { toolId: 'fetch_url', action: 'allow' }, // unchanged
      ],
      'existing rule not updated in place or other rules lost',
    );
  });
});

test('persistPermissionRule appends a new rule without dropping existing ones', async () => {
  await withTempMeloHome(async (dir) => {
    const configPath = join(dir, 'config.json');
    const seeded = {
      apiKey: 'sk-keep-me',
      toolPermissionRules: [{ toolId: 'bash', action: 'allow' }],
    };
    await writeFile(configPath, JSON.stringify(seeded, null, 2), 'utf8');

    const { persistPermissionRule } = await import(
      `./permissions.js?tc=${Date.now()}-c`
    );
    await persistPermissionRule('fetch_url', 'allow');

    const after = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(after.apiKey, 'sk-keep-me');
    assert.deepEqual(after.toolPermissionRules, [
      { toolId: 'bash', action: 'allow' },
      { toolId: 'fetch_url', action: 'allow' },
    ]);
  });
});
