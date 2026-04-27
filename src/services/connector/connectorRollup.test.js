// Tests for the connector rollup — specifically the artifacts connector
// counts.  Soft-deleted artifacts must not bleed into totalArtifacts /
// projectArtifacts (Codex 2026-04-27 🔵 audit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectors } from './connectorRollup.js';

function fixtureState({ artifacts = [], externalConnectors = [], externalToolRuns = [] } = {}) {
  return {
    artifacts,
    externalConnectors,
    externalToolRuns,
  };
}

const BASE_CONFIG = {};
const BASE_WORKSPACE = { commandRuns: [], rootPath: '/tmp/x', exists: false, fileCount: 0, selectedFilePath: null };

function pickArtifactsConnector(connectors) {
  return connectors.find(c => c.id === 'artifacts');
}

test('artifacts connector counts only live rows for totalArtifacts', () => {
  const state = fixtureState({
    artifacts: [
      { id: 'a1', projectId: 'p1', title: 'live a' },
      { id: 'a2', projectId: 'p1', title: 'live b' },
      { id: 'a3', projectId: 'p1', title: 'tomb', deletedAt: '2026-04-27T00:00:00.000Z' },
    ],
  });
  const connectors = buildConnectors([], BASE_CONFIG, BASE_WORKSPACE, state, null);
  const artifactsConnector = pickArtifactsConnector(connectors);
  assert.ok(artifactsConnector, 'artifacts connector should exist in BUILTIN_CONNECTORS');
  assert.equal(artifactsConnector.config.totalArtifacts, 2);
});

test('artifacts connector projectArtifacts excludes soft-deleted within the project', () => {
  const state = fixtureState({
    artifacts: [
      { id: 'a1', projectId: 'p1', title: 'live in p1' },
      { id: 'a2', projectId: 'p1', title: 'tomb in p1', deletedAt: '2026-04-27T00:00:00.000Z' },
      { id: 'a3', projectId: 'p2', title: 'live in p2' },
    ],
  });
  const project = { id: 'p1', name: 'demo' };
  const connectors = buildConnectors([], BASE_CONFIG, BASE_WORKSPACE, state, project);
  const artifactsConnector = pickArtifactsConnector(connectors);
  assert.equal(artifactsConnector.config.projectArtifacts, 1);
  assert.equal(artifactsConnector.config.totalArtifacts, 2);
});

test('artifacts connector counts are zero on an empty state', () => {
  const state = fixtureState({ artifacts: [] });
  const connectors = buildConnectors([], BASE_CONFIG, BASE_WORKSPACE, state, null);
  const artifactsConnector = pickArtifactsConnector(connectors);
  assert.equal(artifactsConnector.config.totalArtifacts, 0);
  assert.equal(artifactsConnector.config.projectArtifacts, 0);
});
