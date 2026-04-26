// Regression test for the Codex §6 finding on commit 8e (chat 9c76db9 + fix
// 0a05a30): the original extracted form bound `getAgentMarkdownPaths` via a
// module-level lazy `() => getMeloHome()`, which means if MELO_HOME flipped
// during a single `getDesktopBootstrap()` call the helper would resolve to
// the new home — but the state we loaded came from the old home. The
// returned bootstrap could surface state from home A while pointing
// `identityPath` / `soulPath` at home B. Subsequent edits via those paths
// would write to the wrong home's `desktop/agents/` tree.
//
// The fix (commit 8e follow-up): captureBootstrapContext at the top of
// getDesktopBootstrap, hold the home-bound helper in `ctx`, pass it as an
// explicit parameter into buildAgentProfiles. This test plants two homes,
// dispatches the bootstrap under home A, flips env to home B before the
// awaits resolve, and asserts the returned identityPath/soulPath both
// reference home A's `desktop/agents/` tree.
//
// MELO_HOME isolation: per the data-loss lesson on commit 7c, this test
// always points MELO_HOME at a tmpdir before importing the module, and
// tears it down on suite exit.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME_STATE_PATH = join(homedir(), '.melo', 'desktop', 'state.json');
const REAL_HOME_GUARD_ENABLED = process.env.MELO_TEST_GUARD_REAL_HOME === '1';
const REAL_STATE_MTIME_BEFORE =
  REAL_HOME_GUARD_ENABLED && existsSync(REAL_HOME_STATE_PATH)
    ? statSync(REAL_HOME_STATE_PATH).mtimeMs
    : null;

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;

function freshHome(seedState) {
  const dir = mkdtempSync(join(tmpdir(), 'melo-bootstrap-test-'));
  mkdirSync(join(dir, 'desktop'), { recursive: true });
  mkdirSync(join(dir, 'desktop', 'agents'), { recursive: true });
  if (seedState) {
    writeFileSync(join(dir, 'desktop', 'state.json'), JSON.stringify(seedState));
  }
  return dir;
}

const homeA = freshHome({
  projects: [],
  chats: [],
  tasks: [],
  approvals: [],
  artifacts: [],
  commandRuns: [],
  externalConnectors: [],
  externalToolRuns: [],
  agentProfiles: {
    main: {
      id: 'main',
      name: 'main',
      model: 'gpt-4',
      identity: '',
      soulMd: '',
      tools: [],
      skills: [],
      channels: {},
    },
  },
  projectAgentOverrides: {},
  settings: {
    selectedProjectId: null,
    selectedChatId: null,
    selectedAgentId: 'main',
    selectedConnectorId: null,
    selectedFilePath: null,
    activeMode: 'chat',
    promptHistory: [],
    enabledConnectorIds: [],
    enabledSkillIds: [],
    customSkills: [],
  },
});
const homeB = freshHome();

process.env.MELO_HOME = homeA;
const { getDesktopBootstrap } = await import('./desktopBootstrap.js');

after(() => {
  try { rmSync(homeA, { recursive: true, force: true }); } catch {}
  try { rmSync(homeB, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) {
    delete process.env.MELO_HOME;
  } else {
    process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  }
  if (REAL_HOME_GUARD_ENABLED && REAL_STATE_MTIME_BEFORE !== null && existsSync(REAL_HOME_STATE_PATH)) {
    const after = statSync(REAL_HOME_STATE_PATH).mtimeMs;
    if (after > REAL_STATE_MTIME_BEFORE) {
      throw new Error(
        `MELO_HOME isolation regressed — ${REAL_HOME_STATE_PATH} was modified during this test suite (mtime ${REAL_STATE_MTIME_BEFORE} → ${after}).`,
      );
    }
  }
});

test('getDesktopBootstrap pins agent markdown paths to the home captured at entry, even when MELO_HOME flips mid-await', async () => {
  // Confirm baseline: env points at home A.
  process.env.MELO_HOME = homeA;

  // Kick off the bootstrap; the captureBootstrapContext call inside should
  // freeze `home = homeA` synchronously before the first await.
  const promise = getDesktopBootstrap();

  // Flip env BEFORE the bootstrap promise resolves. Without the §6 fix the
  // module-level lazy `() => getMeloHome()` would now resolve to homeB.
  process.env.MELO_HOME = homeB;

  const bootstrap = await promise;
  const main = bootstrap.customize.agents.find(a => a.id === 'main');
  assert.ok(main, 'main agent must be present in bootstrap');

  // The identity / soul paths must live under homeA — they were resolved
  // via the helper bound to home captured at function entry.
  assert.ok(
    main.identityPath.startsWith(homeA),
    `expected identityPath under homeA (${homeA}), got ${main.identityPath}`,
  );
  assert.ok(
    main.soulPath.startsWith(homeA),
    `expected soulPath under homeA (${homeA}), got ${main.soulPath}`,
  );
  // And explicitly NOT under homeB.
  assert.ok(
    !main.identityPath.startsWith(homeB),
    `identityPath leaked to homeB (${homeB})`,
  );
});
