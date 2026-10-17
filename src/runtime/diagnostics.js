import { failureSnapshot } from './failureCounters.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { getResolvedConfig } from '../config.js';
import { collectMemoryStatus } from '../memory/status.js';
import { resolveRuntimePaths } from './paths.js';
import { probeDesktopRuntime, readDesktopDiagnostics } from './identity.js';
import { capabilityStatus, readCapabilityEvidence } from './capabilities.js';
import { collectStorageInventory } from './storageInventory.js';

const require = createRequire(import.meta.url);
const LABELS = { model: 'Model request', image: 'Image input / OCR', audio: 'Audio transcript', video: 'Video transcript / keyframes', document: 'Document text', link: 'Web page content', search: 'Web search' };

async function findExecutable(candidates) {
  for (const path of candidates.filter(Boolean)) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  return null;
}

export async function inspectReaderInstallations({ paths = resolveRuntimePaths(), env = process.env } = {}) {
  const root = env.MELO_EXTERNAL_READERS_DIR || join(dirname(paths.projectDir), 'external-readers');
  const pathDirs = String(env.PATH || '').split(delimiter).filter(Boolean);
  const readers = [
    ['crawl4ai', 'crwl', env.MELO_CRAWL4AI_BIN],
    ['scrapling', 'scrapling', env.MELO_SCRAPLING_BIN],
    ['camoufox', 'camoufox', env.MELO_CAMOUFOX_BIN],
  ];
  return Promise.all(readers.map(async ([id, command, override]) => {
    const path = await findExecutable([
      override, join(root, 'pipx', 'venvs', id, 'bin', command), join(root, 'bin', command),
      ...pathDirs.map(dir => join(dir, command)),
    ]);
    return { id, installed: Boolean(path), path, status: 'yellow', reason: path ? 'installed-not-live-tested' : 'not-installed' };
  }));
}

export async function collectRuntimeDiagnostics({ runtime = null, includeStorage = false, probe = false } = {}) {
  const env = { ...process.env };
  const paths = resolveRuntimePaths({ env });
  const configPromise = getResolvedConfig();
  const memory = collectMemoryStatus({ meloHome: paths.home });
  const [config, evidence, readers, desktop, storage] = await Promise.all([
    configPromise, readCapabilityEvidence(paths.home), inspectReaderInstallations({ paths, env }),
    runtime ? Promise.resolve({ status: 'running', runtime }) : probeDesktopRuntime(paths),
    includeStorage ? collectStorageInventory({ home: paths.home }) : Promise.resolve(null),
  ]);
  if (!runtime && desktop.status === 'running') {
    // The desktop may have launch-time env overrides absent from this CLI.
    const live = await readDesktopDiagnostics(paths, desktop, { includeStorage, probe });
    if (live) return { ...live, configurationSource: 'running-desktop' };
  }
  const capabilities = Object.entries(LABELS).map(([id, label]) => ({
    id, label, ...capabilityStatus(evidence[id], { model: id === 'model' ? config.model : '', authMode: config.authMode }),
  }));
  let searchProbe = null;
  if (probe) {
    const { checkSearchHealth } = await import('../tools/builtins/webSearchTool.js');
    searchProbe = await checkSearchHealth({ signal: AbortSignal.timeout(5000) });
  }
  const dependencies = ['ffmpeg-static', 'pdf-parse', 'tesseract.js', 'playwright-core'].map(id => {
    let installed = false;
    try { require.resolve(id); installed = true; } catch {}
    return { id, installed, status: 'yellow', reason: installed ? 'installed-not-live-tested' : 'not-installed' };
  });
  return {
    checkedAt: new Date().toISOString(),
    configurationSource: runtime ? 'running-desktop' : 'local-config',
    paths, desktop,
    config: { authMode: config.authMode, model: config.model, modelScope: 'global-default', mock: Boolean(env.MELO_MOCK_RESPONSE) },
    authentication: {
      status: config.authMode === 'local' ? 'yellow' : (config.authMode === 'codex' ? config.codexAuth?.loggedIn : config.apiKey) ? 'yellow' : 'red',
      reason: config.authMode === 'local' ? 'local-provider-not-probed' : (config.authMode === 'codex' ? config.codexAuth?.loggedIn : config.apiKey) ? 'credentials-present-not-validated' : 'credentials-missing',
    },
    capabilities, readers, dependencies,
    memory: {
      status: memory.store.openError ? 'red' : 'yellow',
      reason: memory.store.openError ? 'store-read-failed' : memory.store.exists ? 'store-readable-recall-not-tested' : 'store-not-created',
      path: memory.store.path, counts: memory.counts,
    },
    searchProbe, storage,
    // Swallowed-failure counters (audit A-10): non-empty means something has
    // been failing quietly in this process — see src/runtime/failureCounters.js.
    failures: failureSnapshot(),
  };
}

export function formatDiagnostics(report) {
  const lines = [
    'Melo doctor', '',
    `data directory ${report.paths.home} (${report.paths.source})`,
    `config path    ${report.paths.configPath}`,
    `config source  ${report.configurationSource}`,
    `desktop        ${report.desktop.status}`,
    `auth mode      ${report.config.authMode} (${report.authentication.reason})`,
    `default model  ${report.config.model} (agents may override)`,
  ];
  const runtime = report.desktop.runtime;
  if (runtime) lines.push(`server         pid ${runtime.pid}, port ${runtime.port}`, `code version   ${runtime.revision}${runtime.dirty ? ' + local changes at startup' : ''}`);
  lines.push('', 'Capability evidence (GREEN = recent real result at the stated level):');
  for (const item of [...report.capabilities, { id: 'memory', ...report.memory }]) {
    lines.push(`  ${item.status.toUpperCase().padEnd(6)} ${item.id.padEnd(10)} ${item.level || 'storage'} / ${item.reason}${item.checkedAt ? ` / ${item.checkedAt}` : ''}`);
    if (item.id === 'model') lines.push(`         requested ${item.model || 'unknown'} / provider reported ${item.reportedModel || 'not reported'}${item.simulated ? ' / simulated' : ''}`);
  }
  lines.push('', 'Reader installation (does not prove page access):');
  for (const reader of report.readers) lines.push(`  ${reader.id.padEnd(10)} ${reader.installed ? reader.path : 'not installed'}`);
  if (report.searchProbe) lines.push('', report.searchProbe.summary);
  lines.push('', `Legacy CLI data is preserved at ${report.paths.legacyHome}. Select it explicitly with MELO_HOME.`);
  if (report.storage) {
    lines.push('', `Storage inventory${report.storage.complete ? '' : ' (partial; scan budget reached)'}:`);
    for (const entry of report.storage.categories) lines.push(`  ${entry.label.padEnd(23)} ${(entry.bytes / 1024 / 1024).toFixed(1)} MiB`);
    lines.push(`  ${report.storage.cleanupPolicy}`);
  }
  return `${lines.join('\n')}\n`;
}
