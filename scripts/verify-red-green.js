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
const nativeAppPath = join(projectDir, 'Melo.app');
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
