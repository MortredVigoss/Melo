import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// Skill mutation handlers — sub-phase 7d-5ε commit 2 of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Skill-domain CRUD entry points server.js calls from HTTP routes.
// All ten functions are read-modify-persist orchestrators on top of
// the pure helpers already in skillService / skillsDisk / skillProposals
// / skillDrafting / diskSkills.
//
// Members (source-order):
//   • toggleSkill            — flip enabled flag in settings
//   • createCustomSkill      — add to customSkills + optional disk mirror
//   • updateCustomSkill      — patch + atomic re-normalize + disk mirror
//   • removeCustomSkill      — drop + disk cleanup
//   • exportSkillAsMarkdown  — serialize for download
//   • importSkillFromMarkdown — parse + delegate to create/update
//   • promoteSkillToDisk     — flip a JSON skill to disk-backed
//   • reloadDiskSkills       — re-sync state from skill folders on disk
//   • applySkillProposal     — apply an upgrade proposal from the scanner
//   • draftSkillFromChat     — LLM-draft a skill from a chat conversation
//
// All upstream deps live in dedicated leaf modules — no reverse imports
// from desktopStore.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getResolvedConfig } from '../../config.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { mergeDiskSkillsIntoState } from '../../state/diskSkills.js';
import {
  BUILTIN_SKILLS,
  normalizeBuiltinSkill,
  normalizeCustomSkill,
} from '../../domain/skill/skillService.js';
import {
  SKILLS_DISK_ROOT,
  saveSkillToDisk,
  removeSkillFromDisk,
  parseSkillMarkdown,
  skillToMarkdown,
  skillFromMarkdown,
} from '../../agents/skillsDisk.js';
import { defaultSkillProposalStore } from '../../agents/skillProposals.js';
import { draftSkillFromConversation } from '../../agents/skillDrafting.js';

export async function toggleSkill(skillId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => toggleSkill(...arguments));
  await updateStateAtomically(state => {
    const enabled = new Set(state.settings.enabledSkillIds);

    if (enabled.has(skillId)) {
      enabled.delete(skillId);
    } else {
      enabled.add(skillId);
    }

    state.settings.enabledSkillIds = [...enabled];
    state.settings.selectedSkillId = skillId;
    return state;
  });
  return getDesktopBootstrap();
}

export async function createCustomSkill(skillData = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createCustomSkill(...arguments));
  await updateStateAtomically(async state => {
    // Reject shadowing of built-in skill ids up-front so the API surfaces a
    // specific error instead of the generic "id and name are required".
    const rawId = String(skillData?.id || '').trim();
    if (rawId && BUILTIN_SKILLS.some(b => b.id === rawId)) {
      throw new Error(
        `Cannot create custom skill with id "${rawId}": that id is reserved for a built-in skill. ` +
        `Pick a different id (e.g. "${rawId}-custom").`,
      );
    }
    const skill = normalizeCustomSkill(skillData);
    if (!skill) {
      throw new Error('Invalid custom skill data: id and name are required');
    }
    if (!Array.isArray(state.settings.customSkills)) {
      state.settings.customSkills = [];
    }
    // Prevent duplicate IDs
    if (state.settings.customSkills.some(s => s.id === skill.id)) {
      throw new Error(`A custom skill with id "${skill.id}" already exists`);
    }
    state.settings.customSkills.push(skill);
    state.settings.selectedSkillId = skill.id;
    state.settings.selectedCustomizeSection = 'skills';
    if (skill.origin === 'disk') {
      try {
        await saveSkillToDisk(skill);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[desktopStore] createCustomSkill disk mirror failed: ${err.message}`);
      }
    }
    return state;
  });
  return getDesktopBootstrap();
}

export async function updateCustomSkill(skillId, patch = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateCustomSkill(...arguments));
  let updated = null;
  await updateStateAtomically(async s => {
    const state = ensureSelectedEntities(s);
    if (!Array.isArray(state.settings.customSkills)) {
      state.settings.customSkills = [];
    }
    const index = state.settings.customSkills.findIndex(sk => sk.id === skillId);
    if (index === -1) {
      throw new Error(`Custom skill "${skillId}" not found`);
    }
    const existing = state.settings.customSkills[index];
    const merged = { ...existing, ...patch };
    const normalized = normalizeCustomSkill(merged);
    if (!normalized) {
      throw new Error('Invalid patch: id and name are required');
    }
    // normalizeCustomSkill is a whitelist — it only returns fields it knows
    // about. Any extra fields that live on the existing skill (from a
    // future schema version, or user metadata the UI sets directly) would
    // be silently dropped on every edit. Preserve them by layering the
    // normalized shape over the merged input: known fields win, unknown
    // fields from existing/patch survive untouched.
    // See feedback_preserve_user_config.md.
    updated = { ...merged, ...normalized };
    state.settings.customSkills[index] = updated;

    if (updated?.origin === 'disk') {
      try {
        await saveSkillToDisk(updated);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[desktopStore] updateCustomSkill disk mirror failed: ${err.message}`);
      }
    }
    return state;
  });

  return getDesktopBootstrap();
}

export async function removeCustomSkill(skillId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => removeCustomSkill(...arguments));
  await updateStateAtomically(async state => {
    if (!Array.isArray(state.settings.customSkills)) {
      state.settings.customSkills = [];
    }
    const doomed = state.settings.customSkills.find(s => s.id === skillId);
    state.settings.customSkills = state.settings.customSkills.filter(s => s.id !== skillId);
    // Also remove from enabledSkillIds if present
    state.settings.enabledSkillIds = (state.settings.enabledSkillIds || []).filter(id => id !== skillId);
    if (state.settings.selectedSkillId === skillId) {
      state.settings.selectedSkillId = BUILTIN_SKILLS[0]?.id || null;
    }
    if (doomed && doomed.origin === 'disk') {
      try {
        await removeSkillFromDisk(skillId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[desktopStore] removeCustomSkill disk cleanup failed: ${err.message}`);
      }
    }
    return state;
  });
  return getDesktopBootstrap();
}

export async function exportSkillAsMarkdown(skillId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => exportSkillAsMarkdown(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const rawId = String(skillId || '').trim();
  if (!rawId) {
    throw new Error('exportSkillAsMarkdown: skillId is required');
  }
  const builtin = BUILTIN_SKILLS.find(s => s.id === rawId);
  if (builtin) {
    return { id: rawId, markdown: skillToMarkdown(normalizeBuiltinSkill(builtin)) };
  }
  const custom = (state.settings.customSkills || []).find(s => s.id === rawId);
  if (!custom) {
    throw new Error(`exportSkillAsMarkdown: skill "${rawId}" not found`);
  }
  return { id: rawId, markdown: skillToMarkdown(custom) };
}

export async function importSkillFromMarkdown(markdownText, { writeToDisk = false, idOverride = null } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => importSkillFromMarkdown(...arguments));
  const raw = String(markdownText || '').trim();
  if (!raw) throw new Error('importSkillFromMarkdown: markdown is required');
  const { frontmatter } = parseSkillMarkdown(raw);
  const derivedId = String(idOverride || frontmatter.name || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!derivedId) {
    throw new Error('importSkillFromMarkdown: could not determine skill id (frontmatter.name missing)');
  }
  if (BUILTIN_SKILLS.some(b => b.id === derivedId)) {
    throw new Error(`importSkillFromMarkdown: id "${derivedId}" is reserved for a built-in skill`);
  }
  const parsed = skillFromMarkdown(derivedId, raw, null);
  const skillInput = { ...parsed, origin: writeToDisk ? 'disk' : 'json' };
  // Delegate to createCustomSkill/updateCustomSkill so validation + preset +
  // disk mirroring all flow through the same code path. If an id collides
  // we update in place.
  const state = ensureSelectedEntities(await loadState());
  const exists = (state.settings.customSkills || []).some(s => s.id === derivedId);
  if (exists) {
    return updateCustomSkill(derivedId, skillInput);
  }
  return createCustomSkill(skillInput);
}

export async function promoteSkillToDisk(skillId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => promoteSkillToDisk(...arguments));
  await updateStateAtomically(async state => {
    const index = (state.settings.customSkills || []).findIndex(s => s.id === skillId);
    if (index === -1) {
      throw new Error(`promoteSkillToDisk: skill "${skillId}" not found`);
    }
    const before = state.settings.customSkills[index];
    const updated = { ...before, origin: 'disk' };
    state.settings.customSkills[index] = normalizeCustomSkill(updated);
    try {
      await saveSkillToDisk(state.settings.customSkills[index]);
    } catch (err) {
      throw new Error(`promoteSkillToDisk: failed to write disk copy: ${err.message}`);
    }
    return state;
  });
  return getDesktopBootstrap();
}

export async function reloadDiskSkills() {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => reloadDiskSkills(...arguments));
  await updateStateAtomically(async state => {
    await mergeDiskSkillsIntoState(state);
    return state;
  });
  return getDesktopBootstrap();
}

export async function applySkillProposal(seedId, {
  _store = defaultSkillProposalStore,
  _loadStateFn = loadState,
  _saveStateFn = null,
  _writeFileFn = writeFile,
  _mkdirFn = mkdir,
  _diskRoot = SKILLS_DISK_ROOT,
  nowFn = () => Date.now(),
} = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => applySkillProposal(...arguments));
  if (!_saveStateFn && _loadStateFn === loadState) {
    let result;
    await updateStateAtomically(async state => {
      result = await applySkillProposal(seedId, {
        _store, _loadStateFn: async () => state, _saveStateFn: async () => {},
        _writeFileFn, _mkdirFn, _diskRoot, nowFn,
      });
    });
    return result;
  }
  if (!seedId || typeof seedId !== 'string') {
    return { ok: false, error: 'BAD_SEED_ID', reason: 'seedId is required.' };
  }
  const proposal = _store.get(seedId);
  if (!proposal) {
    return { ok: false, error: 'NOT_FOUND', reason: `Proposal ${seedId} not found.` };
  }
  if (proposal.kind !== 'upgrade') {
    return {
      ok: false,
      error: 'UNSUPPORTED_KIND',
      reason: `Only upgrade proposals can be auto-applied; got kind="${proposal.kind || 'create'}". Use the skill-drafting flow to promote create proposals.`,
    };
  }
  if (BUILTIN_SKILLS.some(b => b.id === proposal.targetSkillId)) {
    return {
      ok: false,
      error: 'BUILTIN_TARGET',
      reason: `"${proposal.targetSkillId}" is a built-in skill and cannot be upgraded in place.`,
    };
  }

  const state = await _loadStateFn();
  if (!state?.settings) {
    return { ok: false, error: 'NO_STATE', reason: 'Store is not initialized.' };
  }
  if (!Array.isArray(state.settings.customSkills)) {
    state.settings.customSkills = [];
  }
  const idx = state.settings.customSkills.findIndex(s => s?.id === proposal.targetSkillId);
  if (idx < 0) {
    return {
      ok: false,
      error: 'TARGET_MISSING',
      reason: `Skill "${proposal.targetSkillId}" is no longer in customSkills. It may have been deleted.`,
    };
  }

  const before = state.settings.customSkills[idx];
  // Melo-bundled skills are protected — only a reinstall / backend update
  // can change them. The scanner should already have filtered them out of
  // the upgrade-match set, but this is a defense-in-depth guard for the
  // case where a proposal predates the skill being marked bundled.
  if (before?.source === 'melo-bundle') {
    return {
      ok: false,
      error: 'BUNDLED_TARGET',
      reason: `"${before.id}" is a Melo-bundled skill. Bundled skills can only be upgraded through a backend update; user activity cannot modify them.`,
    };
  }
  const triggersToAdd = Array.isArray(proposal.triggersToAdd) ? proposal.triggersToAdd : [];
  const beforeTriggers = Array.isArray(before.triggers) ? before.triggers : [];
  const seen = new Set(beforeTriggers.map(t => String(t).toLowerCase()));
  const mergedTriggers = [...beforeTriggers];
  for (const t of triggersToAdd) {
    if (!t) continue;
    const key = String(t).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mergedTriggers.push(t);
  }

  const appendix = String(proposal.systemPromptAppendix || '').trim();
  const currentPrompt = String(before.systemPrompt || '');
  const promptAlreadyHasAppendix =
    appendix && currentPrompt.includes(appendix.split('\n').find(l => l.trim()) || appendix);
  const mergedPrompt = !appendix || promptAlreadyHasAppendix
    ? currentPrompt
    : (currentPrompt.trim() + '\n\n' + appendix).trim();

  const updatedSkill = {
    ...before,
    triggers: mergedTriggers,
    systemPrompt: mergedPrompt,
    updatedAt: new Date(nowFn()).toISOString(),
  };

  state.settings.customSkills[idx] = updatedSkill;

  // Persist to disk if the skill is disk-backed (loadSkillsFromDisk sets
  // `origin: 'disk'` and `diskPath`). Best-effort — a disk write failure
  // should not block the in-memory update.
  const diskActions = [];
  const wantsDiskSave = before.origin === 'disk' || before.diskPath;
  const diskPath = before.diskPath || join(_diskRoot, proposal.targetSkillId);
  if (wantsDiskSave) {
    try {
      await saveSkillToDisk(updatedSkill, _diskRoot);
      diskActions.push('skill.md written');
    } catch (err) {
      diskActions.push(`skill.md FAILED: ${err?.message || err}`);
    }
  }

  // Write reference file, regardless of disk-backed — even a purely
  // json-persisted skill gets its evidence archived under the skills root.
  let referenceWritten = null;
  const referenceDraft = String(proposal.referenceDraft || '');
  if (referenceDraft) {
    try {
      const refDir = join(diskPath, 'references');
      await _mkdirFn(refDir, { recursive: true });
      const fileName = proposal.referenceFileName || `${new Date(nowFn()).toISOString().slice(0, 10)}.md`;
      const target = join(refDir, fileName);
      await _writeFileFn(target, referenceDraft, 'utf8');
      referenceWritten = target;
      diskActions.push(`reference → ${fileName}`);
    } catch (err) {
      diskActions.push(`reference FAILED: ${err?.message || err}`);
    }
  }

  await _saveStateFn(state);
  _store.dismiss(seedId);

  return {
    ok: true,
    skillId: proposal.targetSkillId,
    triggersAdded: mergedTriggers.length - (Array.isArray(before.triggers) ? before.triggers.length : 0),
    promptAppended: mergedPrompt !== currentPrompt,
    referenceWritten,
    diskActions,
  };
}

export async function draftSkillFromChat(chatId, {
  hint = '',
  _draftFn = draftSkillFromConversation,
  _loadStateFn = loadState,
  _configFn = getResolvedConfig,
} = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => draftSkillFromChat(...arguments));
  if (!chatId || typeof chatId !== 'string') {
    return { ok: false, error: 'NO_CONVERSATION', reason: 'chatId is required.' };
  }
  const [config, rawState] = await Promise.all([_configFn(), _loadStateFn()]);
  // We intentionally don't go through `ensureSelectedEntities` here — all we
  // need is chat.messages, and the normalization step can throw on incomplete
  // stubbed state (which tests reasonably provide).
  const chats = Array.isArray(rawState?.chats) ? rawState.chats : [];
  const chat = chats.find(entry => entry?.id === chatId);
  if (!chat) {
    return { ok: false, error: 'NO_CONVERSATION', reason: `Chat "${chatId}" not found.` };
  }
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  return _draftFn({ messages, config, hint });
}
