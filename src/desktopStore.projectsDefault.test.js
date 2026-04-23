// Regression coverage for the "empty Projects by default" behavior.
//
// Historical bug: the desktop store seeded a "How to use Melo" example
// project whose workspacePath defaulted to the Melo source tree, so every
// fresh install leaked the user's install directory through the UI. We now:
//   1. Start with an empty projects[] and null selectedProjectId.
//   2. On hydrate, respect an explicit empty array (so "I deleted them all"
//      is not silently reverted).
//   3. On hydrate, drop the pristine legacy example project if still around.
//   4. In ensureSelectedEntities, keep null selectedProjectId as null — only
//      auto-pick projects[0] when the persisted id points at something that
//      no longer exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Each test points MELO_HOME at a fresh temp dir so we load state from our
// own crafted state.json. We import desktopStore.js AFTER setting the env,
// using a cache-busting query string so each call gets a fresh module copy.
async function loadStoreWithHome(home) {
  process.env.MELO_HOME = home;
  const query = `?t=${Date.now()}-${Math.random()}`;
  const mod = await import(`./desktopStore.js${query}`);
  return mod;
}

function freshHome(seedState) {
  const dir = mkdtempSync(join(tmpdir(), 'melo-store-test-'));
  const desktopDir = join(dir, 'desktop');
  mkdirSync(desktopDir, { recursive: true });
  if (seedState !== undefined) {
    writeFileSync(join(desktopDir, 'state.json'), JSON.stringify(seedState));
  }
  return dir;
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test('fresh install: zero projects and null selectedProjectId', async () => {
  const home = freshHome(); // no seed file → defaults
  try {
    const store = await loadStoreWithHome(home);
    const bootstrap = await store.getDesktopBootstrap();
    assert.equal(bootstrap.projects.length, 0, 'projects list should be empty');
    assert.equal(
      bootstrap.settings.selectedProjectId,
      null,
      'no project should be pre-selected on a fresh install',
    );
    assert.equal(bootstrap.activeProject, null);
  } finally {
    cleanup(home);
  }
});

test('hydrate respects explicit empty projects array', async () => {
  // Simulates a user who deleted every project — the store should NOT
  // re-seed anything.
  const home = freshHome({
    settings: { selectedProjectId: null, activeView: 'projects' },
    projects: [],
  });
  try {
    const store = await loadStoreWithHome(home);
    const bootstrap = await store.getDesktopBootstrap();
    assert.equal(bootstrap.projects.length, 0);
    assert.equal(bootstrap.settings.selectedProjectId, null);
  } finally {
    cleanup(home);
  }
});

test('hydrate drops pristine legacy example-project', async () => {
  // Simulates an existing install that still has the auto-seeded "How to use
  // Melo" project. It should disappear on next hydrate.
  const home = freshHome({
    settings: { selectedProjectId: 'example-project' },
    projects: [
      {
        id: 'example-project',
        name: 'How to use Melo',
        summary: 'onboarding example',
        tag: 'Example project',
        instructions: 'onboard',
        workspacePath: '/tmp/something',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
  });
  try {
    const store = await loadStoreWithHome(home);
    const bootstrap = await store.getDesktopBootstrap();
    assert.equal(
      bootstrap.projects.length,
      0,
      'pristine example project should be dropped',
    );
    assert.equal(
      bootstrap.settings.selectedProjectId,
      null,
      'selectedProjectId must be cleared when the project it pointed at is dropped',
    );
  } finally {
    cleanup(home);
  }
});

test('hydrate keeps a renamed legacy example-project', async () => {
  // If the user renamed the example, it has become their project — keep it.
  const home = freshHome({
    settings: { selectedProjectId: 'example-project' },
    projects: [
      {
        id: 'example-project',
        name: 'My real work', // renamed away from "How to use Melo"
        summary: 'stuff I care about',
        tag: 'Work',
        instructions: 'do the thing',
        workspacePath: '/home/me/work',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
  });
  try {
    const store = await loadStoreWithHome(home);
    const bootstrap = await store.getDesktopBootstrap();
    assert.equal(bootstrap.projects.length, 1, 'renamed project should survive');
    assert.equal(bootstrap.projects[0].name, 'My real work');
    assert.equal(bootstrap.settings.selectedProjectId, 'example-project');
  } finally {
    cleanup(home);
  }
});

test('explicit null selectedProjectId stays null (detail → overview)', async () => {
  // Reproduces the "Back to all projects" flow: null selectedProjectId must
  // NOT be auto-reset to projects[0].
  const home = freshHome({
    settings: { selectedProjectId: null, activeView: 'projects' },
    projects: [
      {
        id: 'real-project',
        name: 'Real project',
        summary: 'a project',
        tag: 'Work',
        instructions: '',
        workspacePath: '/home/me/work',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
  });
  try {
    const store = await loadStoreWithHome(home);
    const bootstrap = await store.getDesktopBootstrap();
    assert.equal(bootstrap.projects.length, 1);
    assert.equal(
      bootstrap.settings.selectedProjectId,
      null,
      'explicit null must stay null so the overview shows the grid',
    );
    assert.equal(bootstrap.activeProject, null);
  } finally {
    cleanup(home);
  }
});
