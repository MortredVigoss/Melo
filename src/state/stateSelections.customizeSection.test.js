import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSelectedEntities } from './stateSelections.js';

function baseState(selectedCustomizeSection) {
  return {
    chats: [],
    projects: [],
    externalConnectors: [],
    agentProfiles: {},
    settings: {
      activeView: 'customize',
      activeMode: 'chat',
      selectedChatId: null,
      selectedProjectId: null,
      selectedAgentScope: 'global',
      selectedCustomizeSection,
      selectedAgentId: 'main',
      selectedSkillId: '',
      selectedConnectorId: '',
      promptHistory: [],
    },
  };
}

test('ensureSelectedEntities preserves current customize sections', () => {
  for (const section of ['advanced', 'memory', 'safety']) {
    assert.equal(
      ensureSelectedEntities(baseState(section)).settings.selectedCustomizeSection,
      section,
    );
  }
});

test('ensureSelectedEntities keeps legacy runtime customize section for UI migration', () => {
  assert.equal(
    ensureSelectedEntities(baseState('runtime')).settings.selectedCustomizeSection,
    'runtime',
  );
});
