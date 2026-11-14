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
//   • draftSkillFromChat     — LLM-draft a skill from a chat conversation
//
// All upstream deps live in dedicated leaf modules — no reverse imports
// from desktopStore.

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
  saveSkillToDisk,
  removeSkillFromDisk,
  parseSkillMarkdown,
  skillToMarkdown,
  skillFromMarkdown,
} from '../../agents/skillsDisk.js';
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
