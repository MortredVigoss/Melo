import { spawn } from 'node:child_process';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = process.env.MELO_PROJECT_DIR || dirname(__dirname);
const serverUrl = 'http://127.0.0.1:43129';
const connectorUrl = 'http://127.0.0.1:43131';
const telegramMockUrl = 'http://127.0.0.1:43132';
const telegramMockToken = 'melo-mock-telegram-token';
// 2026-05-12 cleanup: build output moved to .tmp/desktop-build/ so the
// source tree no longer carries a third Melo.app duplicate (Spotlight was
// indexing it as a separate app).  Path tracks build-desktop-app.sh's APP_DIR.
const nativeAppPath = join(projectDir, '.tmp', 'desktop-build', 'Melo.app');
const desktopFolderAppPath = join(process.env.HOME || '', 'Desktop', 'melo', 'Melo.app');
const launchpadAppPath = join(process.env.HOME || '', 'Applications', 'Melo.app');
const nativeDebugPath = join(projectDir, '.tmp/desktop-app-debug.txt');
const autoCloseSentinelPath = join(projectDir, '.tmp/desktop-app-auto-close');
const verifyMeloHome = join(projectDir, '.tmp/melo-home-verify');

const runtimeHandles = [];
let cleanupPromise = null;
let shuttingDown = false;

function log(line) {
  process.stdout.write(`${line}\n`);
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function trackHandle(handle) {
  runtimeHandles.push(handle);
  return handle;
}

async function runStep(name, runner) {
  const startedAt = Date.now();
  try {
    const result = await runner();
    return {
      name,
      status: 'GREEN',
      durationMs: Date.now() - startedAt,
      detail: result || '',
    };
  } catch (error) {
    return {
      name,
      status: 'RED',
      durationMs: Date.now() - startedAt,
      detail: error.message || String(error),
    };
  }
}

function printSummary(results) {
  log('');
  log('Melo verification summary');
  for (const result of results) {
    log(
      `${result.status.padEnd(5)} ${result.name} (${result.durationMs}ms)${
        result.detail ? `\n       ${result.detail}` : ''
      }`,
    );
  }
  log('');
}

async function runCommand(command, args, { env = {}, cwd = projectDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, output = '') => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(output.trim());
      }
    };

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.once('error', error => {
      finish(
        new Error(
          `${formatCommand(command, args)} failed to spawn: ${error.message}\n${(stdout + stderr).trim()}`,
        ),
      );
    });

    child.once('close', (code, signal) => {
      const output = (stdout + stderr).trim();
      if (code === 0) {
        finish(null, output);
        return;
      }

      const reason =
        signal !== null
          ? `${formatCommand(command, args)} exited via signal ${signal}`
          : `${formatCommand(command, args)} failed with exit ${code}`;
      finish(new Error(`${reason}\n${output}`));
    });
  });
}

function spawnProcess(command, args, { env = {}, cwd = projectDir } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let spawnError = null;
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });
  child.once('error', error => {
    spawnError = error;
  });

  return trackHandle({
    child,
    output: () => output.trim(),
    async waitForReady() {
      await delay(25);
      if (spawnError) {
        throw new Error(`${formatCommand(command, args)} failed to spawn: ${spawnError.message}`);
      }
    },
  });
}

async function terminateProcess(handle) {
  const child = handle?.child;
  if (!child) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const closePromise = new Promise(resolve => {
    child.once('close', resolve);
  }).catch(() => {});

  child.kill('SIGTERM');
  await Promise.race([closePromise, delay(1500)]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([closePromise, delay(1500)]);
  }
}

async function cleanupAll() {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    await unlink(autoCloseSentinelPath).catch(() => {});
    for (const handle of [...runtimeHandles].reverse()) {
      await terminateProcess(handle);
    }
  })();

  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    cleanupAll()
      .catch(() => {})
      .finally(() => {
        process.exit(130);
      });
  });
}

async function waitForHealth(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {}

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}/api/health`);
}

async function fetchBootstrap() {
  const response = await fetch(`${serverUrl}/api/bootstrap`);
  if (!response.ok) {
    throw new Error(`bootstrap failed with ${response.status}`);
  }
  return response.json();
}

function assertAgentPersonaShape(bootstrap) {
  const agents = bootstrap?.customize?.agents || [];
  if (!agents.length) {
    throw new Error('No agents returned from bootstrap.');
  }
  if (!(bootstrap?.customize?.agentPresets || []).length) {
    throw new Error('No agent presets returned from bootstrap.');
  }

  for (const agent of agents) {
    if (!agent.identity?.trim()) {
      throw new Error(`Agent ${agent.id} is missing identity.`);
    }
    if (!agent.soulMd?.trim()) {
      throw new Error(`Agent ${agent.id} is missing soulMd.`);
    }
    if (!agent['soul.md']?.trim()) {
      throw new Error(`Agent ${agent.id} is missing soul.md.`);
    }
    if (!agent.mood?.trim()) {
      throw new Error(`Agent ${agent.id} is missing mood.`);
    }
    if (!Array.isArray(agent.toolIds) || !agent.toolIds.length) {
      throw new Error(`Agent ${agent.id} is missing enabled tool ids.`);
    }
    if (!Object.prototype.hasOwnProperty.call(agent, 'model')) {
      throw new Error(`Agent ${agent.id} is missing model.`);
    }
    if (!Object.prototype.hasOwnProperty.call(agent, 'systemPrompt')) {
      throw new Error(`Agent ${agent.id} is missing systemPrompt.`);
    }
    if (!['global', 'project'].includes(agent.scopeSource)) {
      throw new Error(`Agent ${agent.id} is missing a valid scopeSource.`);
    }
  }
}

function collectFailures(source, checks) {
  return checks
    .filter(check => !check.test(source[check.key], source))
    .map(
      check =>
        `- ${check.message} (got ${JSON.stringify(source[check.key])})`,
    );
}

function sanitizeSmokeOutput(rawOutput) {
  return String(rawOutput || '')
    .split(/\r?\n/)
    .filter(
      line =>
        !/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(line) &&
        !/^\(Use `node --trace-warnings/.test(line),
    )
    .join('\n')
    .trim();
}

function assertSmokeSummary(rawOutput) {
  let summary;
  const sanitizedOutput = sanitizeSmokeOutput(rawOutput);
  try {
    summary = JSON.parse(sanitizedOutput);
  } catch {
    throw new Error(`Smoke output was not valid JSON.\n${rawOutput}`);
  }

  const attachmentKinds = Array.isArray(summary.richAttachmentKinds)
    ? summary.richAttachmentKinds
    : [];

  const checks = [
    {
      key: 'homeSelectedChatId',
      test: value => value === null,
      message: 'New chat home did not preserve a null selectedChatId',
    },
    {
      key: 'homeThreadSelectedChatId',
      test: Boolean,
      message: 'Sending from the New chat home did not create and select a thread',
    },
    {
      key: 'homeThreadTitle',
      test: value => value === 'How large is Singapore',
      message: 'The first home prompt did not become the thread title',
    },
    {
      key: 'homeRecentTitle',
      test: value => value === 'How large is Singapore',
      message: 'The new thread did not appear in Recents with the first prompt as its title',
    },
    {
      key: 'homeFollowUpMessageCount',
      test: value => value >= 6,
      message: 'The new thread did not preserve multi-turn conversation after the initial New chat send',
    },
    {
      key: 'homeStreamDeltaCount',
      test: Boolean,
      message: 'Streaming chat send did not emit incremental delta events for the first turn',
    },
    {
      key: 'homeFollowUpStreamDeltaCount',
      test: Boolean,
      message: 'Streaming chat send did not emit incremental delta events for the second turn',
    },
    {
      key: 'homeThirdTurnStreamDeltaCount',
      test: Boolean,
      message: 'Streaming chat send did not emit incremental delta events for the third turn',
    },
    {
      key: 'homeFollowUpUserMessage',
      test: value => value === 'And answer one more follow-up in the same thread.',
      message: 'The later user turn was not preserved in the thread',
    },
    {
      key: 'homeFollowUpAssistantMessage',
      test: Boolean,
      message: 'The second turn did not receive an assistant reply',
    },
    {
      key: 'continuityContextHasRules',
      test: Boolean,
      message: 'Conversation continuity rules were not injected into the prompt context',
    },
    {
      key: 'continuityContextTreatsClarification',
      test: Boolean,
      message: 'Clarification follow-up context was not detected',
    },
    {
      key: 'continuityContextCarriesTopic',
      test: Boolean,
      message: 'The earlier ambiguous topic was not carried into continuation context',
    },
    {
      key: 'continuityContextCarriesReply',
      test: Boolean,
      message: 'The short follow-up reply was not marked as a contextual refinement',
    },
    {
      key: 'searchViewActive',
      test: value => value === 'search',
      message: 'Search view did not persist when selected',
    },
    {
      key: 'agentViewActive',
      test: value => value === 'agent',
      message: 'Agent view did not persist when selected',
    },
    {
      key: 'modelViewActive',
      test: value => value === 'model',
      message: 'Model view did not persist when selected',
    },
    {
      key: 'modelOptionsCount',
      test: value => Boolean(value) && Boolean(summary.modelOptionHit),
      message: 'Model setup did not expose a usable model option list',
    },
    {
      key: 'searchFeatureHit',
      test: Boolean,
      message: 'Feature search did not return a searchable app function',
    },
    {
      key: 'searchAgentHit',
      test: Boolean,
      message: 'Search did not return the Agent feature',
    },
    {
      key: 'searchModelHit',
      test: Boolean,
      message: 'Search did not return the Model feature',
    },
    {
      key: 'searchChatHit',
      test: Boolean,
      message: 'Chat search did not return a searchable chat content hit',
    },
    {
      key: 'codeStreamDeltaCount',
      test: value => Boolean(value) && Boolean(summary.richStreamDeltaCount),
      message: 'Streaming send did not work for code-mode and attachment flows',
    },
    {
      key: 'graphCommandApprovalStatus',
      test: value => value === 'pending' && summary.graphCommandApprovalTitle === 'Run Git status',
      message: 'Chat graph did not queue the expected local-command approval gate',
    },
    {
      key: 'graphExternalApprovalStatus',
      test: value =>
        value === 'pending' && summary.graphExternalApprovalTitle === 'Run Smoke MCP / docs.search',
      message: 'Chat graph did not queue the expected external connector approval gate',
    },
    {
      key: 'searchFilePathHit',
      test: Boolean,
      message: 'Workspace file search did not return the smoke file path',
    },
    {
      key: 'searchFileContentHit',
      test: Boolean,
      message: 'Workspace file-content search did not return the smoke file content hit',
    },
    {
      key: 'agentIdentityPath',
      test: value => Boolean(value) && Boolean(summary.agentSoulPath),
      message: 'Agent markdown files were not exposed in the bootstrap',
    },
    {
      key: 'agentIdentityFileHasContent',
      test: value => Boolean(value) && Boolean(summary.agentSoulFileHasContent),
      message: 'Agent markdown files were empty on disk',
    },
    {
      key: 'agentIdentityMatches',
      test: value => Boolean(value) && Boolean(summary.agentSoulMatches),
      message: 'Agent markdown file contents did not match the active persona state',
    },
    {
      key: 'telegramRoundTripAgentId',
      test: Boolean,
      message: 'Telegram smoke did not provision an agent-backed channel round-trip',
    },
    {
      key: 'telegramRoundTripTitle',
      test: value => value === 'Telegram smoke ping',
      message: 'Telegram smoke did not preserve the inbound Telegram prompt title',
    },
    {
      key: 'telegramRoundTripReply',
      test: value => value === 'Desktop smoke reply.',
      message: 'Telegram smoke did not emit the expected outbound reply',
    },
    {
      key: 'telegramRoundTripCount',
      test: value => Number(value) >= 1,
      message: 'Telegram smoke did not send any outbound bot messages',
    },
    {
      key: 'telegramImageRoundTripReply',
      test: value => value === 'Desktop smoke reply.',
      message: 'Telegram smoke did not emit the expected outbound reply for a photo-only update',
    },
    {
      key: 'telegramImageRoundTripCount',
      test: value => Number(value) >= 2,
      message: 'Telegram smoke did not send a second outbound bot message for the photo-only update',
    },
    {
      key: 'updatedAgentToolCount',
      test: Boolean,
      message: 'Agent update did not persist any enabled tools',
    },
    {
      key: 'updatedAgentModel',
      test: value => value === 'melo-smoke-model',
      message: 'Agent update did not persist the model override',
    },
    {
      key: 'updatedAgentSystemPrompt',
      test: value => String(value || '').includes('Smoke system prompt'),
      message: 'Agent update did not persist the system prompt override',
    },
  ];

  const failures = collectFailures(summary, checks);

  if (!attachmentKinds.includes('image') || !attachmentKinds.includes('link')) {
    failures.push(
      `- Rich attachment flow did not preserve both image and link attachments (got ${JSON.stringify(attachmentKinds)})`,
    );
  }

  if (failures.length) {
    throw new Error(`Smoke assertions failed:\n${failures.join('\n')}\n\nRaw:\n${rawOutput}`);
  }

  return summary;
}

function parseNativeDebugOutput(rawOutput) {
  const parsed = {
    raw: rawOutput.trim(),
    uiAudit: {},
  };

  for (const line of rawOutput.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (key === 'uiAudit') {
      try {
        parsed.uiAudit = JSON.parse(value);
      } catch (error) {
        throw new Error(`Failed to parse uiAudit from native debug output: ${error.message}`);
      }
      continue;
    }
    parsed[key] = value;
  }

  return parsed;
}

async function assertNativeLaunch(appPath, expectedBundlePath = appPath) {
  await writeFile(autoCloseSentinelPath, '', 'utf8');
  try {
    await runCommand('osascript', ['-e', 'tell application "Melo" to quit']).catch(() => '');
    await runCommand('open', ['-n', '-W', appPath]);
    const debugOutput = await readFile(nativeDebugPath, 'utf8');
    const parsed = parseNativeDebugOutput(debugOutput);
    const uiAudit = parsed.uiAudit || {};
    const expectedPaths = Array.isArray(expectedBundlePath)
      ? expectedBundlePath
      : [expectedBundlePath];

    const checks = [
      {
        key: 'status',
        test: value => value === 'page-loaded',
        message: 'Native launch did not report page-loaded',
      },
    ];
    const uiChecks = [
      {
        key: 'hasComposer',
        test: value => value === true,
        message: 'Native launch did not render the chat composer',
      },
      {
        key: 'homeSurfaceVisible',
        test: value => value === true,
        message: 'Native launch did not land on the New chat home surface',
      },
      {
        key: 'topbarOverlap',
        test: value => value === false,
        message: 'Native launch reported overlapping topbar layout',
      },
      {
        key: 'composerActionVisible',
        test: value => value === true,
        message: 'Native launch reported composer actions outside the viewport',
      },
      {
        key: 'primaryNavCount',
        test: value => value === 8,
        message: 'Native launch reported unexpected primary sidebar actions',
      },
      {
        key: 'primaryNavTitle',
        test: value => value === 'New chat',
        message: 'Native launch did not preserve New chat as the first sidebar action',
      },
      {
        key: 'primaryNavTitles',
        test: value => value === 'New chat|Search|Agent|Model|Customize|Chats|Projects|Artifacts',
        message: 'Native launch did not preserve the full primary sidebar action set',
      },
      {
        key: 'primaryNavVisible',
        test: value => value === true,
        message: 'Native launch reported primary sidebar actions outside the visible area',
      },
      {
        key: 'contentScrollbarPresent',
        test: value => value === true,
        message: 'Native launch did not mount the global right-side content scrollbar',
      },
    ];

    const failures = [
      ...collectFailures(parsed, checks),
      ...collectFailures(uiAudit, uiChecks),
    ];
    if (!expectedPaths.includes(parsed.bundlePath)) {
      failures.push(
        `- Native launch loaded the wrong app bundle (got ${JSON.stringify(parsed.bundlePath)})`,
      );
    }

    if (failures.length) {
      throw new Error(`Native launch assertions failed:\n${failures.join('\n')}\n\nRaw:\n${parsed.raw}`);
    }

    return parsed.raw;
  } finally {
    await unlink(autoCloseSentinelPath).catch(() => {});
  }
}

async function main() {
  const results = [];
  let connectorProcess = null;
  let telegramProcess = null;
  let serverProcess = null;

  try {
    // Fast-fail unit tests for scripts/ first.  Added per Codex C-gate
    // finding on aaaaeb8 (manual review): `scripts/inspect-search-trail.test.js`
    // and any future scripts/ unit tests were not part of the gate, so a
    // CLI-contract regression (e.g. exit-code mismatch) could slip past.
    // Runs in seconds; if it fails we skip the expensive desktop build.
    // Intentionally narrow: `src/**/*.test.js` is NOT included here — that
    // surface is much larger and currently has one known flake
    // (`src/media/orchestratorAbort.test.js` #14 — spawned task pending),
    // which would re-introduce flake into the gate.  Widening to src/ is
    // a separate decision after that flake lands.
    results.push(await runStep('scripts/ unit tests (test:scripts)', () => runCommand('npm', ['run', 'test:scripts'])));

    // Codex C-gate finding on 1f6b4fb: src/serverGuard.test.js was added
    // as a regression guard for the 6d925a4 cross-repo guard-regex fix
    // but lived under src/**/*.test.js (excluded above), so the gate
    // wouldn't run it — defeating the whole "防回归" intent.  Add a
    // single-file allowlist step (NOT a src/** glob, same flake reason
    // as test:scripts).  Mirrors the test:scripts pattern.
    results.push(await runStep('Server guard unit tests (test:server-guard)', () => runCommand('npm', ['run', 'test:server-guard'])));

    // 2026-05-12 Bug 1: TTS native say queue regression guard.  Same
    // single-file allowlist pattern as test:server-guard — pure state
    // machine, no spawn dependencies, fast.
    results.push(await runStep('TTS native queue unit tests (test:tts)', () => runCommand('npm', ['run', 'test:tts'])));

    // G-6 #6 (2026-05-12): markdownFiles factory now has the desktopStore.js
    // caller passing function-form `agentsDir` (G-6 #6 lazy refactor).  This
    // suite locks both the string-form and function-form paths so a future
    // "simplify by always treating as string" refactor would break loudly
    // instead of silently freezing MELO_HOME at module load.  Also contains
    // a source-level guard against re-introducing `const DESKTOP_DIR/AGENTS_DIR`
    // in desktopStore.js.
    results.push(await runStep('markdownFiles factory + desktopStore source guard (test:markdown-files)', () => runCommand('npm', ['run', 'test:markdown-files'])));

    // 2026-05-12 audit follow-up: src/web/externalReaders.js had a Codex
    // change introducing `MELO_EXTERNAL_READERS_DIR` env capture as a
    // module-load const — same §6 violation pattern the G-6 audit cleaned
    // up.  Refactored to lazy resolvers + appended 5 source-level guard
    // tests to externalReaders.test.js (existing 4 behavior tests still
    // pass).  Wired here so a future regression to module-load const
    // breaks at push gate.
    results.push(await runStep('External readers §6 + behavior (test:external-readers)', () => runCommand('npm', ['run', 'test:external-readers'])));

    // G-1d slice 1 (executor.js preserve) + G-1e (parser surface to LLM prompt)
    // — evidenceTrail end-to-end through tools layer.  Existing executor test
    // pinned by c3285d2; parser test added by G-1e commit.  Grouped under
    // one gate step because they share the evidenceTrail schema contract.
    results.push(await runStep('Tools evidenceTrail (executor + parser) (test:tools-evidence-trail)', () => runCommand('npm', ['run', 'test:tools-evidence-trail'])));

    // api-direct router (2026-05-14): structured-data providers (Wikipedia
    // for now; HN / arXiv / GitHub later) that short-circuit SERP for
    // well-shaped queries.  Gating this here so regressions in the
    // matches()/fetch() interface trip immediately — the webSearchTool
    // run() depends on the {provider, ok, results, contentMap} contract
    // shape and a silent drift would manifest as "Wikipedia results
    // vanish from search" without obvious cause.
    results.push(await runStep('API-direct router + Wikipedia provider (test:api-direct)', () => runCommand('npm', ['run', 'test:api-direct'])));

    // Phase G-2b SearchTask adapter (2026-05-21 cherry-picked from
    // wip/g-2b-adapter-phase2-refresh after 3 Codex C-rounds landed).
    // Pure-function adapter maps 3 tools' legacy returns to unified
    // SearchTaskResult — schema/error-code drift here is silent, so gate
    // it before the upcoming G-2c caller-migration phase consumes it.
    results.push(await runStep('SearchTask adapter (test:search-task)', () => runCommand('npm', ['run', 'test:search-task'])));

    // G-2b round-5 闭环 (2026-05-21): webSearchTool **producer side** of
    // the api-direct meta.contentItems serialization.  Consumer side is
    // gated by test:search-task above; this step pins the OTHER half so
    // future refactors can't desynchronize results vs contentItems.
    results.push(await runStep('webSearchTool api-direct shape (test:websearch-api-direct)', () => runCommand('npm', ['run', 'test:websearch-api-direct'])));

    // 2026-05-21 audit闭环 Tier-2B ⚪: Jina fan-out internal abort wiring
    // regression — proves quorum-hit / outer-signal abort actually flips
    // in-flight fetches' captured signal to aborted (pre-fix they'd keep
    // running to natural timeout).  Without this gate the abort wiring
    // could silently regress and we'd just see "slow background HTTP"
    // tokens / bandwidth waste without an obvious failure mode.
    results.push(await runStep('webSearchTool Jina abort wiring (test:websearch-jina-abort)', () => runCommand('npm', ['run', 'test:websearch-jina-abort'])));

    // 2026-05-21 audit闭环 #5: 6 regression guards that were written
    // explicitly to catch §6 cross-home / evidenceTrail contract drift
    // but had no gate step — i.e. silent-skip per
    // feedback_test_must_reach_gate.  Gate them in two narrow scripts
    // (cross-home / evidence-trail) so the protection actually fires
    // before push.  The §6 SWR microtask test (added same audit闭环 #1)
    // lives inside webSearchTool.crossHome.test.js — picking up that
    // file here locks both #1 and #3 regression protection.
    results.push(await runStep('Cross-home isolation regression guards (test:cross-home)', () => runCommand('npm', ['run', 'test:cross-home'])));
    results.push(await runStep('Tool-level evidenceTrail regression guards (test:evidence-trail-tools)', () => runCommand('npm', ['run', 'test:evidence-trail-tools'])));

    // meloChrome launcher (2026-05-16): CDP-attach Stage 1.  Pure unit
    // tests — no real Chrome spawn, all OS deps stubbed via DI seam.
    // Gating here so the lock-file / reuse / stale-detection contract
    // can't silently drift before Stage 2 wires this into fetchUrlTool.
    results.push(await runStep('Melo Chrome CDP launcher (test:melo-chrome)', () => runCommand('npm', ['run', 'test:melo-chrome'])));

    // Stage 2a (2026-05-16): connectMeloChrome wrapper on top of the
    // launcher.  Pure unit tests — playwright-core import + connect are
    // both DI-injected so this stays decoupled from real Chrome.  Gating
    // here so the launcher → connector contract (port handoff + signal
    // propagation + browser-close-on-throw) can't silently drift before
    // Stage 2b wires this into fetchUrlTool.
    results.push(await runStep('CDP connector helper (test:browser-connect)', () => runCommand('npm', ['run', 'test:browser-connect'])));

    // Stage 2b (2026-05-16): fetchUrlTool cdp-chrome tier — env-gated
    // escalation + explicit extract_mode='cdp-chrome'.  Gating here so
    // the "env off = no behavior change" promise + the cdp→playwright
    // fallthrough contract can't silently regress.
    results.push(await runStep('fetchUrlTool cdp-chrome tier (test:fetchurl-cdp)', () => runCommand('npm', ['run', 'test:fetchurl-cdp'])));

    // Stage 2c (2026-05-17): webSearchTool content-fetch CDP fallback.
    // Gating here so the env-on/off branch + trail method recording can't
    // silently drift after Stage 3 wires interactive browser tools.
    results.push(await runStep('webSearchTool content-fetch CDP (test:websearch-cdp)', () => runCommand('npm', ['run', 'test:websearch-cdp'])));

    // Stage 2c B 留账 闭环 (2026-05-18): real stale-SWR test (UPDATE
    // created_at into stale window) + real abort-during-hang test
    // (waitForLoadState 真挂 + 计时验证 + page.close 计数).  Both close
    // the "fake-green" gap MEMORY.md feedback_test_must_validate_real_invariant
    // requires for any abort/SWR path.
    results.push(await runStep('webSearchTool SWR + abort (test:websearch-swr-abort)', () => runCommand('npm', ['run', 'test:websearch-swr-abort'])));

    // Stage 3a (2026-05-17): pageRegistry — persistent page handle store
    // for the upcoming Stage 3b/3c interactive browser tools.  Gating
    // here so the env gate + contexts()[0] reuse + cleanup-on-error
    // contracts can't silently regress when tools start consuming the
    // registry.
    results.push(await runStep('Page registry (test:page-registry)', () => runCommand('npm', ['run', 'test:page-registry'])));

    // Stage 3b (2026-05-17): browser_open / browser_snapshot / browser_close
    // — the persistent-handle counterpart to fetchUrlTool's one-shot
    // cdp-chrome tier.  Tool-shape contracts (error mapping, idempotent
    // close, schema) need their own gate so registry refactors can't
    // silently break tool-side semantics.
    results.push(await runStep('Browser tools (test:browser-tools)', () => runCommand('npm', ['run', 'test:browser-tools'])));

    // G-1d slice 2 (2026-05-12): chat-message-level toolResults round-trip
    // through state.json normalize is the persistence backbone of slice 2.
    // Gating this catches the "older state with malformed toolResults
    // crashes hydration" regression class.
    results.push(await runStep('State hydration (stateHydration test) (test:state-hydration)', () => runCommand('npm', ['run', 'test:state-hydration'])));

    // G-1d slice 2 producer-side gate: chatExecutionRunner's toolResult
    // projection (via src/services/chat/toolResultProjection.js).  Codex on
    // slice 2 commit 1 (B + ⚪) flagged that only hydration was covered;
    // this pins the producer shape so refactoring the projection (e.g.
    // adding/removing fields) trips the gate immediately instead of
    // silently breaking the persisted assistantMessage.toolResults shape.
    results.push(await runStep('Tool result projection (G-1d slice 2 producer) (test:tool-result-projection)', () => runCommand('npm', ['run', 'test:tool-result-projection'])));

    // desktop-ui/**/*.test.js — same "test exists but gate doesn't run it"
    // gap.  In particular `streamTtsOnToolCall.test.js` was added 2026-05-12
    // as the regression guard for the mid-utterance TTS truncation bug
    // (don't kill the queue/afplay on every tool_call event).  Wire the
    // whole test:ui glob in so future desktop-ui regression guards land
    // in the gate automatically.  Suite is stable (~200 cases) and fast.
    results.push(await runStep('desktop-ui unit tests (test:ui)', () => runCommand('npm', ['run', 'test:ui'])));

    results.push(await runStep('Build syntax check', () => runCommand('npm', ['run', 'build'])));
    results.push(
      await runStep('Build desktop app bundle', () => runCommand('npm', ['run', 'build:desktop'])),
    );
    results.push(
      await runStep('Install desktop app bundle', () => runCommand('npm', ['run', 'install:desktop'])),
    );
    results.push(
      await runStep('Desktop folder Melo.app launch', async () => {
        const output = await assertNativeLaunch(desktopFolderAppPath, [
          desktopFolderAppPath,
          launchpadAppPath,
        ]);
        return output.split('\n').slice(0, 5).join('\n');
      }),
    );
    results.push(
      await runStep('Launchpad Melo.app launch', async () => {
        const output = await assertNativeLaunch(launchpadAppPath);
        return output.split('\n').slice(0, 5).join('\n');
      }),
    );

    await rm(verifyMeloHome, { recursive: true, force: true });

    connectorProcess = spawnProcess(
      'node',
      [join(projectDir, 'scripts/mock-external-connector.js'), '--host', '127.0.0.1', '--port', '43131'],
    );
    await connectorProcess.waitForReady();

    telegramProcess = spawnProcess(
      'node',
      [join(projectDir, 'scripts/mock-telegram.js'), '--host', '127.0.0.1', '--port', '43132'],
      {
        env: {
          MELO_MOCK_TELEGRAM_TOKEN: telegramMockToken,
        },
      },
    );
    await telegramProcess.waitForReady();

    serverProcess = spawnProcess(
      'node',
      [join(projectDir, 'src/server.js'), '--host', '127.0.0.1', '--port', '43129'],
      {
        env: {
          MELO_HOME: verifyMeloHome,
          MELO_MOCK_RESPONSE: 'Desktop smoke reply.',
          MELO_TELEGRAM_API_BASE: telegramMockUrl,
        },
      },
    );
    await serverProcess.waitForReady();

    results.push(await runStep('Wait for local UI server', () => waitForHealth(serverUrl)));
    results.push(
      await runStep('Desktop smoke flow', async () => {
        const output = await runCommand('node', [join(projectDir, 'scripts/smoke-desktop.js')], {
          env: {
            MELO_CONNECTOR_BASE_URL: connectorUrl,
            MELO_TELEGRAM_MOCK_BASE_URL: telegramMockUrl,
            MELO_MOCK_TELEGRAM_TOKEN: telegramMockToken,
          },
        });
        const summary = assertSmokeSummary(output);
        return JSON.stringify(
          {
            homeSelectedChatId: summary.homeSelectedChatId,
            richAttachmentKinds: summary.richAttachmentKinds,
            searchFeatureHit: summary.searchFeatureHit,
            searchChatHit: summary.searchChatHit,
            graphCommandApprovalStatus: summary.graphCommandApprovalStatus,
            graphExternalApprovalStatus: summary.graphExternalApprovalStatus,
            approvalStatus: summary.approvalStatus,
          },
          null,
          2,
        );
      }),
    );
    results.push(
      await runStep('Bootstrap agent persona contract', async () => {
        const bootstrap = await fetchBootstrap();
        assertAgentPersonaShape(bootstrap);
        return 'Agents expose identify, soul.md, soulMd, and mood.';
      }),
    );
  } finally {
    await cleanupAll();
  }

  printSummary(results);

  const failed = results.find(result => result.status === 'RED');
  if (failed) {
    if (serverProcess?.output?.()) {
      log('Server output:');
      log(serverProcess.output());
    }
    if (connectorProcess?.output?.()) {
      log('Connector output:');
      log(connectorProcess.output());
    }
    if (telegramProcess?.output?.()) {
      log('Telegram mock output:');
      log(telegramProcess.output());
    }
    process.exit(1);
  }

  log('Overall status: GREEN');
}

main().catch(error => {
  cleanupAll()
    .catch(() => {})
    .finally(() => {
      log(`RED   Verify pipeline\n       ${error.message || String(error)}`);
      process.exit(1);
    });
});
