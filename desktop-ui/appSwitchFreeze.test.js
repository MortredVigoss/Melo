// Architecture optimization B1-6 (2026-10-20): app.js's central click and
// submit dispatchers are frozen. New `data-action` / `data-form` handlers
// register through features/registry.js instead of adding `case` branches.
// Removing cases is allowed (move them to a feature, then shrink the
// baseline in the same commit); adding a name not in the baseline fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const APP_SRC = await readFile(new URL('./app.js', import.meta.url), 'utf8');
// Frozen at abe1d20 (2026-10-20). Delete a name here in the same commit that
// moves its case out of app.js; never add one.
const BASELINE = {
  click: [
    "activate-edge-tts",
    "activate-local-voice-pack",
    "apply-artifact-to-selected-file",
    "apply-home-prompt",
    "artifact-collection",
    "cancel-edit-artifact",
    "cancel-edit-file",
    "clear-search-query",
    "close-command-palette",
    "confirm-task-restore",
    "copy-melo-state-path",
    "copy-surface-all",
    "copy-surface-select-all",
    "copy-surface-selection",
    "decide-retained-files",
    "delete-artifact",
    "delete-chat",
    "editable-copy",
    "editable-cut",
    "editable-paste",
    "editable-redo",
    "editable-select-all",
    "editable-undo",
    "execute-approval",
    "file-safety-allow",
    "file-safety-confirm-delete",
    "file-safety-deny",
    "focus-project",
    "insert-command",
    "kill-background-task",
    "neural-back",
    "neural-group",
    "neural-motion",
    "neural-overview",
    "new-chat",
    "open-artifact",
    "open-chat",
    "open-chat-files",
    "open-command-palette",
    "open-file",
    "open-file-match-line",
    "open-retained-files",
    "open-search-result",
    "open-view",
    "pick-default-model",
    "preview-task-backup",
    "refresh-advanced-status",
    "reject-approval",
    "resolve-sync-conflict",
    "retry-committed-save",
    "run-task",
    "run-task-lane",
    "run-task-team",
    "save-chat-as-skill",
    "select-agent-profile",
    "select-artifact",
    "select-file",
    "select-palette-command",
    "select-project",
    "set-task-status",
    "set-tts-engine",
    "start-edit-artifact",
    "start-edit-file",
    "submit-agent-profile",
    "switch-mode",
    "task-operation-retry",
    "task-operations",
    "toggle-artifact-form",
    "toggle-chat-lock",
    "toggle-model-picker",
    "toggle-search-group-hits",
    "toggle-task-form",
    "toggle-task-lane-overflow",
    "toggle-tts-autoplay",
    "toggle-tts-enable",
    "tool-permission-allow-always",
    "tool-permission-allow-once",
    "tool-permission-deny",
    "transcribe-audio-message",
  ],
  submit: [
    "artifact-create",
    "artifact-update",
    "command-run",
    "connector-config",
    "default-model-config",
    "file-save",
    "model-config",
    "task-create",
    "task-pricing",
  ],
};

function blockAt(source, index) {
  const open = source.indexOf('{', index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unterminated switch block');
}

// Only the switch's own top-level cases: nested switches inside a case body
// belong to that handler, not to the dispatcher.
function topLevelCases(block) {
  const names = [];
  let depth = 0;
  for (const line of block.split('\n')) {
    if (depth === 1) {
      const match = line.match(/^\s*case\s+'([^']+)'\s*:/);
      if (match) names.push(match[1]);
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  return names;
}

export function dispatcherCases(source) {
  const switches = [...source.matchAll(/switch \(([^)]+)\) \{/g)].map(m => ({ expr: m[1], block: blockAt(source, m.index) }));
  const click = switches.filter(s => s.expr === 'action' && /case 'retry-committed-save'/.test(s.block));
  const submit = switches.filter(s => s.expr === 'form.dataset.form');
  assert.equal(click.length, 1, 'exactly one central click dispatcher (the switch that handles retry-committed-save)');
  assert.equal(submit.length, 1, 'exactly one central submit dispatcher (switch on form.dataset.form)');
  return { click: topLevelCases(click[0].block), submit: topLevelCases(submit[0].block) };
}

test('central dispatchers add no case outside the frozen baseline', () => {
  const current = dispatcherCases(APP_SRC);
  for (const kind of ['click', 'submit']) {
    const allowed = new Set(BASELINE[kind]);
    const added = current[kind].filter(name => !allowed.has(name));
    assert.deepEqual(
      added,
      [],
      `app.js ${kind} dispatcher gained ${added.join(', ')}. Register the handler in a feature (features/registry.js) instead of adding a case.`,
    );
  }
});

test('baseline lists only cases that still exist, so it shrinks as cases move out', () => {
  const current = dispatcherCases(APP_SRC);
  for (const kind of ['click', 'submit']) {
    const present = new Set(current[kind]);
    const stale = BASELINE[kind].filter(name => !present.has(name));
    assert.deepEqual(stale, [], `BASELINE.${kind} still lists removed cases: ${stale.join(', ')}; delete them from BASELINE in this file`);
  }
});

test('the extractor sees the dispatchers it guards (non-empty, no duplicate names)', () => {
  const current = dispatcherCases(APP_SRC);
  assert.ok(current.click.length > 50, `click dispatcher looks mis-parsed (${current.click.length} cases)`);
  assert.ok(current.submit.length > 5, `submit dispatcher looks mis-parsed (${current.submit.length} cases)`);
  for (const kind of ['click', 'submit']) {
    assert.equal(new Set(current[kind]).size, current[kind].length, `${kind} dispatcher has duplicate case names`);
  }
});

async function featureSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...await featureSources(url));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(url);
  }
  return out;
}

test('feature modules never import app.js (old entry may forward to features, not the reverse)', async () => {
  for (const url of await featureSources(new URL('./features/', import.meta.url))) {
    const source = await readFile(url, 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]/gm)].map(m => m[1] || m[2]);
    const bad = specifiers.filter(spec => /(^|\/)app\.js$/.test(spec));
    assert.deepEqual(bad, [], `${url.pathname} imports app.js`);
  }
});
