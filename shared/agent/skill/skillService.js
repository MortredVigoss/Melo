import { AGENT_LOOP_CONTRACT } from '../loopContract.js';
// ─── Skill service ───────────────────────────────────────────────────────────
// Pure data + shape helpers for the "skill" domain — the built-in skill
// catalog, custom-skill normalization, the two-tier skill list assembled
// for the prompt/tool-loop, and the small helpers they share.
//
// This module owns:
//   - DEFAULT_SKILL_TASK_SCHEMA — parametersSchema fallback for executable
//     skills whose author didn't supply one
//   - BUILTIN_SKILLS — the static list of skills that ship with Melo
//   - Hard caps on skill string fields (MAX_SKILL_SYSTEM_PROMPT_CHARS, etc.)
//     and the prompt-injection tripwire pattern SUSPICIOUS_SKILL_PROMPT_PATTERN
//   - normalizeSkillParametersSchema(schema) — JSON-Schema-ish clamp
//   - normalizeBuiltinSkill(skill) — expand a terse built-in literal into
//     the full Phase-2 schema shape
//   - normalizeCustomSkill(skill) — canonicalize a user-authored skill,
//     enforce caps, reject shadow-of-built-in ids, and auto-upgrade legacy
//     prompt-only skills to executable with the default task schema
//   - buildSkills(enabledIds, customSkills) — merge built-in + custom into
//     the single list the UI and tool registry consume
//   - listExecutableSkills(skills) — filter enabled executable skills for
//     tool-loop registration (they're NOT concatenated into the system prompt)
//
// Extracted from desktopStore.js in the Phase 9b refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state, no side
// effects, no imports beyond Node built-ins.

// Default parametersSchema for executable skills that only take a free-form
// "task" string. Most built-in skills use this shape.
export const DEFAULT_SKILL_TASK_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'The concrete thing the skill should do, in plain language.',
    },
  },
  required: ['task'],
};

export const BUILTIN_SKILLS = [
  {
    id: 'skill-creator',
    name: 'skill-creator',
    addedBy: 'Melo',
    invokedBy: 'User or Melo',
    description:
      'Create new skills, refine prompts, and turn repeated workflows into reusable operating patterns.',
    systemPrompt:
      'When a request looks repetitive or process-heavy, suggest a reusable skill-shaped workflow.',
    folders: ['SKILL.md', 'agents', 'assets', 'eval-viewer', 'references', 'scripts'],
    type: 'executable',
    parametersSchema: DEFAULT_SKILL_TASK_SCHEMA,
    maxIterations: AGENT_LOOP_CONTRACT.skillLimits.iterations,
    tags: ['meta', 'authoring', 'productivity'],
    triggers: ['create skill', 'new skill', 'turn into a skill', 'reusable workflow', 'skill-ify', '做一个技能', '创建技能'],
  },
  {
    id: 'project-planner',
    name: 'project-planner',
    addedBy: 'Melo',
    invokedBy: 'User or Melo',
    description:
      'Break work into milestones, map features to architecture layers, and keep plans practical.',
    systemPrompt:
      'When the task is large, organize the answer into milestones and keep scope boundaries explicit.',
    folders: ['README.md', 'plans', 'checklists'],
    type: 'executable',
    parametersSchema: DEFAULT_SKILL_TASK_SCHEMA,
    maxIterations: AGENT_LOOP_CONTRACT.skillLimits.iterations,
    tags: ['planning', 'project', 'productivity'],
    triggers: ['plan', 'milestones', 'roadmap', 'break down', 'phased', '规划', '计划', '里程碑', '拆分任务'],
  },
  {
    id: 'connector-builder',
    name: 'connector-builder',
    addedBy: 'Melo',
    invokedBy: 'Melo',
    description:
      'Model how tools, APIs, and local data sources should be exposed inside the app.',
    systemPrompt:
      'Prefer connector-like abstractions for tools, data sources, and service integrations.',
    folders: ['CONNECTOR.md', 'examples', 'schemas'],
    type: 'executable',
    parametersSchema: DEFAULT_SKILL_TASK_SCHEMA,
    maxIterations: AGENT_LOOP_CONTRACT.skillLimits.iterations,
    tags: ['engineering', 'integration', 'architecture'],
    triggers: ['connector', 'integration', 'api', 'wire up', 'expose tool', '连接器', '集成'],
  },
  {
    id: 'artifact-curator',
    name: 'artifact-curator',
    addedBy: 'Melo',
    invokedBy: 'Melo',
    description:
      'Promote reusable code blocks, plans, and outputs into durable artifacts the user can revisit.',
    systemPrompt:
      'When you generate a durable output, make it artifact-friendly with concise titles and stable formatting.',
    folders: ['rules.md', 'examples', 'gallery'],
    type: 'executable',
    parametersSchema: DEFAULT_SKILL_TASK_SCHEMA,
    maxIterations: AGENT_LOOP_CONTRACT.skillLimits.iterations,
    tags: ['artifacts', 'productivity'],
    triggers: ['save as artifact', 'promote', 'make reusable', 'artifact', '沉淀', '保存'],
  },
];

// Hard caps on custom-skill string fields. These fields end up in the system
// prompt for every turn when enabled, so we bound them to keep context small
// and limit prompt-injection surface. The cap is generous but firm.
export const MAX_SKILL_SYSTEM_PROMPT_CHARS = 4096;
export const MAX_SKILL_DESCRIPTION_CHARS = 512;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_ID_CHARS = 80;
export const MAX_SKILL_FOLDER_CHARS = 128;
export const MAX_SKILL_FOLDERS = 32;
// Phase 3.3: classification + prefilter metadata. Tags are free-form
// short labels for UI filtering; triggers are keywords the rule-based
// pre-filter matches against to decide if this skill is "relevant" to a
// given user message before we inject its index entry into the prompt.
export const MAX_SKILL_TAG_CHARS = 32;
export const MAX_SKILL_TAGS = 16;
export const MAX_SKILL_TRIGGER_CHARS = 64;
export const MAX_SKILL_TRIGGERS = 24;

// Rough heuristic pattern that catches the most obvious prompt-injection
// attempts in user-supplied skill prompts. Not a security boundary — just
// a tripwire we can log / surface in the UI.
export const SUSPICIOUS_SKILL_PROMPT_PATTERN =
  /(ignore (?:all )?previous (?:instructions|prompts)|disregard (?:the )?(?:system|above)|you (?:are|must) no longer|jailbreak|prompt\s*injection|act as if you have no (?:rules|limits))/i;

function clampString(value, max) {
  const s = String(value ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function normalizeSkillParametersSchema(schema) {
  // Only accept well-formed JSON Schema-ish objects. Fallback to an empty
  // object schema so the wrapper tool is still valid.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, required: [] };
  }
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  const properties = {};
  for (const [key, def] of Object.entries(schema.properties)) {
    if (!def || typeof def !== 'object') continue;
    const typeVal = typeof def.type === 'string' ? def.type : 'string';
    properties[clampString(key, 64)] = {
      type: typeVal,
      description: clampString(def.description, 240),
    };
  }
  const required = Array.isArray(schema.required)
    ? schema.required.map(k => clampString(k, 64)).filter(k => k && properties[k])
    : [];
  return { type: 'object', properties, required };
}

// Built-in skills are defined as a terse literal for readability. This helper
// fills in the full Phase 2 schema (type/parametersSchema/toolWhitelist/…)
// with safe defaults so the rest of the pipeline can treat built-in and
// custom skills uniformly.
export function normalizeBuiltinSkill(skill) {
  const type = skill.type === 'executable' ? 'executable' : 'prompt';
  return {
    id: skill.id,
    name: skill.name || skill.id,
    addedBy: skill.addedBy || 'Melo',
    invokedBy: skill.invokedBy || 'User or Melo',
    description: skill.description || '',
    systemPrompt: skill.systemPrompt || '',
    folders: Array.isArray(skill.folders) ? skill.folders.slice() : [],
    type,
    parametersSchema: normalizeSkillParametersSchema(skill.parametersSchema),
    toolWhitelist: Array.isArray(skill.toolWhitelist) ? skill.toolWhitelist.slice() : null,
    allowedAgentIds: Array.isArray(skill.allowedAgentIds) ? skill.allowedAgentIds.slice() : null,
    maxIterations: Number.isFinite(Number(skill.maxIterations))
      ? Math.max(1, Math.min(AGENT_LOOP_CONTRACT.skillLimits.maxIterations, Math.floor(Number(skill.maxIterations))))
      : AGENT_LOOP_CONTRACT.skillLimits.iterations,
    createdFrom: null,
    tags: Array.isArray(skill.tags) ? skill.tags.map(t => String(t).toLowerCase()).filter(Boolean) : [],
    triggers: Array.isArray(skill.triggers) ? skill.triggers.map(t => String(t).toLowerCase()).filter(Boolean) : [],
    origin: 'built-in',
    diskPath: null,
    version: 1,
    _suspicious: false,
  };
}

export function normalizeCustomSkill(skill) {
  const id = clampString(skill?.id, MAX_SKILL_ID_CHARS);
  const name = clampString(skill?.name || skill?.id, MAX_SKILL_NAME_CHARS);
  if (!id || !name) return null;

  // Reject ids that would shadow a built-in skill, so the customSkills array
  // can never contain a duplicate id and buildSkills() cannot accidentally
  // emit two Skill: prompt blocks with the same id.
  if (BUILTIN_SKILLS.some(b => b.id === id)) {
    return null;
  }

  const systemPrompt = clampString(skill?.systemPrompt, MAX_SKILL_SYSTEM_PROMPT_CHARS);
  const description = clampString(skill?.description, MAX_SKILL_DESCRIPTION_CHARS);

  const suspicious = Boolean(systemPrompt) && SUSPICIOUS_SKILL_PROMPT_PATTERN.test(systemPrompt);

  const folders = Array.isArray(skill?.folders)
    ? skill.folders
        .map(f => clampString(f, MAX_SKILL_FOLDER_CHARS))
        .filter(Boolean)
        .slice(0, MAX_SKILL_FOLDERS)
    : [];

  // Phase 3.3: free-form tags for UI filtering. Stored lowercased so search
  // is case-insensitive and duplicates merge.
  const tags = Array.isArray(skill?.tags)
    ? Array.from(
        new Set(
          skill.tags
            .map(t => clampString(t, MAX_SKILL_TAG_CHARS).toLowerCase())
            .filter(Boolean),
        ),
      ).slice(0, MAX_SKILL_TAGS)
    : [];

  // Phase 3.2.2: pre-filter triggers. Used by matchSkillsForMessage to
  // decide which skills are "hot" for the current user turn. If triggers is
  // empty the skill matches on description/name instead (fallback).
  const triggers = Array.isArray(skill?.triggers)
    ? Array.from(
        new Set(
          skill.triggers
            .map(t => clampString(t, MAX_SKILL_TRIGGER_CHARS).toLowerCase())
            .filter(Boolean),
        ),
      ).slice(0, MAX_SKILL_TRIGGERS)
    : [];

  // Phase 3.1: source origin. 'json' = persisted in customSkills[];
  // 'disk' = loaded from ~/.melo/desktop/skills/<id>/SKILL.md; 'built-in'
  // is set by buildSkills, not here. Used by import/export and by the UI
  // to show where a skill came from.
  const origin = skill?.origin === 'disk' ? 'disk' : 'json';
  const diskPath = origin === 'disk' && typeof skill?.diskPath === 'string'
    ? skill.diskPath
    : null;

  // Phase 3.4.2: `source` marks skills that shipped with Melo ('melo-bundle')
  // as read-only from the upgrade-proposal flow. User-created / user-imported
  // skills have source=null and can be upgraded freely.
  const source = typeof skill?.source === 'string' && skill.source.trim()
    ? clampString(skill.source, 40).toLowerCase()
    : null;

  // Auto-upgrade path: legacy prompt-only skills (no explicit type) become
  // executable with a default {task:string} wrapper so the model can invoke
  // them through the tool loop. Callers who explicitly want the legacy
  // prompt-stuffing behavior must pass type:"prompt".
  const resolvedType = skill?.type === 'prompt' ? 'prompt' : 'executable';
  let resolvedParamsSchema = normalizeSkillParametersSchema(skill?.parametersSchema);
  if (
    resolvedType === 'executable'
    && (!resolvedParamsSchema.properties
      || Object.keys(resolvedParamsSchema.properties).length === 0)
  ) {
    resolvedParamsSchema = DEFAULT_SKILL_TASK_SCHEMA;
  }

  return {
    id,
    name,
    addedBy: clampString(skill?.addedBy || 'User', 40),
    invokedBy: clampString(skill?.invokedBy || 'User or Melo', 40),
    description,
    systemPrompt,
    folders,
    type: resolvedType,
    parametersSchema: resolvedParamsSchema,
    toolWhitelist: Array.isArray(skill?.toolWhitelist)
      ? skill.toolWhitelist.map(v => clampString(v, 64)).filter(Boolean).slice(0, 64)
      : null,
    allowedAgentIds: Array.isArray(skill?.allowedAgentIds)
      ? skill.allowedAgentIds.map(v => clampString(v, 64)).filter(Boolean).slice(0, 64)
      : null,
    maxIterations: Number.isFinite(Number(skill?.maxIterations))
      ? Math.max(1, Math.min(AGENT_LOOP_CONTRACT.skillLimits.maxIterations, Math.floor(Number(skill.maxIterations))))
      : AGENT_LOOP_CONTRACT.skillLimits.iterations,
    createdFrom: skill?.createdFrom && typeof skill.createdFrom === 'object'
      ? {
          conversationId: clampString(skill.createdFrom.conversationId, 80) || null,
          messageId: clampString(skill.createdFrom.messageId, 80) || null,
          autoGenerated: Boolean(skill.createdFrom.autoGenerated),
          createdAt: clampString(skill.createdFrom.createdAt, 40) || null,
        }
      : null,
    tags,
    triggers,
    origin,
    diskPath,
    source,
    version: Number.isFinite(Number(skill?.version)) ? Math.max(1, Math.floor(Number(skill.version))) : 1,
    _suspicious: suspicious || undefined,
  };
}

export function buildSkills(enabledIds, customSkills = []) {
  const builtIn = BUILTIN_SKILLS.map(normalizeBuiltinSkill).map(skill => ({
    ...skill,
    enabled: enabledIds.includes(skill.id),
    source: 'built-in',
    sourceLabel: 'Built-in skill',
    folderCount: skill.folders.length,
    folderSummary: skill.folders.join(', '),
  }));
  const custom = (Array.isArray(customSkills) ? customSkills : [])
    .map(normalizeCustomSkill)
    .filter(Boolean)
    .map(skill => ({
      ...skill,
      enabled: enabledIds.includes(skill.id),
      source: 'custom',
      sourceLabel: 'Custom skill',
      folderCount: skill.folders.length,
      folderSummary: skill.folders.join(', '),
    }));
  return [...builtIn, ...custom];
}

// Returns every enabled skill that should be registered as a callable tool.
// Executable skills are routed through skillExecutor and exposed via the
// tool-loop — they are NOT concatenated into the system prompt.
export function listExecutableSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.filter(skill => skill?.enabled && skill?.type === 'executable');
}
