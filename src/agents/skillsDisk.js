// Phase 3.1: disk-based skill loader + SKILL.md frontmatter parser.
//
// Storage layout:
//   <MELO_HOME>/desktop/skills/
//     └── <skill-id>/
//         ├── SKILL.md           — required. YAML frontmatter + body.
//         ├── references/        — optional. Arbitrary reference files.
//         ├── scripts/           — optional. Helper scripts the skill can run.
//         └── assets/            — optional. Images/data/etc.
//
// Frontmatter contract (aligned with agentskills.io / Claude Code SKILL.md):
//   ---
//   name: my-skill
//   description: One-line trigger description (matched against user message)
//   type: executable | prompt
//   tags: [tag1, tag2]
//   triggers: [keyword1, keyword2]
//   allowed-tools: [tool-id-1, tool-id-2]    (maps to toolWhitelist)
//   allowed-agents: [main, builder]          (maps to allowedAgentIds)
//   max-iterations: 6
//   version: 1
//   ---
//   System prompt body goes here — plain markdown.
//
// The body of SKILL.md becomes the skill's systemPrompt. Frontmatter is
// optional; if absent, the first H1 becomes the name and everything else
// becomes the systemPrompt with sensible defaults elsewhere.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {currentRequestContext} from '../runtime/requestScope.js';
import {resolveRuntimePaths} from '../runtime/paths.js';

export const getSkillsDiskRoot=()=>path.join(currentRequestContext()?.home || resolveRuntimePaths().home,'desktop','skills');
// Compatibility export; runtime operations capture the current home at entry.
export const SKILLS_DISK_ROOT=getSkillsDiskRoot();

/**
 * Parse a YAML-frontmatter markdown file into { frontmatter, body }.
 * We implement a tiny subset of YAML (string, number, boolean, flow-style
 * arrays, block-style scalar) because we don't want a YAML dep for four
 * fields. Anything fancier should be quoted.
 */
export function parseSkillMarkdown(raw) {
  if (typeof raw !== 'string') return { frontmatter: {}, body: '' };
  const trimmed = raw.replace(/^\ufeff/, '');
  // No frontmatter — whole file is body.
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed };
  }
  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: trimmed };
  const yamlBlock = trimmed.slice(3, endIdx).replace(/^\r?\n/, '');
  const body = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '');
  const frontmatter = parseSimpleYaml(yamlBlock);
  return { frontmatter, body };
}

function parseSimpleYaml(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, rawKey, rawVal] = match;
    const key = rawKey.trim();
    const val = rawVal.trim();
    if (!val) continue;
    // Flow-style array: [a, b, "c with space"]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1);
      // Split by comma not inside quotes.
      const items = [];
      let buf = '';
      let inQuote = null;
      for (const ch of inner) {
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
          else buf += ch;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === ',') {
          const t = buf.trim();
          if (t) items.push(t);
          buf = '';
        } else {
          buf += ch;
        }
      }
      const t = buf.trim();
      if (t) items.push(t);
      out[key] = items;
      continue;
    }
    if (val === 'true') { out[key] = true; continue; }
    if (val === 'false') { out[key] = false; continue; }
    if (/^-?\d+(\.\d+)?$/.test(val)) { out[key] = Number(val); continue; }
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))) {
      out[key] = val.slice(1, -1);
      continue;
    }
    out[key] = val;
  }
  return out;
}

/**
 * Convert parsed SKILL.md into Melo's skill schema. Handles both
 * agentskills.io-style keys (allowed-tools, max-iterations) and our own
 * (allowedAgentIds, maxIterations).
 */
export function skillFromMarkdown(skillId, raw, diskPath) {
  const { frontmatter, body } = parseSkillMarkdown(raw);
  const name = String(frontmatter.name || skillId || 'skill').trim();
  const description = String(frontmatter.description || '').trim();
  const type = frontmatter.type === 'prompt' ? 'prompt' : 'executable';
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const triggers = Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [];
  const toolWhitelist =
    Array.isArray(frontmatter['allowed-tools'])
      ? frontmatter['allowed-tools']
      : Array.isArray(frontmatter.toolWhitelist)
        ? frontmatter.toolWhitelist
        : null;
  const allowedAgentIds =
    Array.isArray(frontmatter['allowed-agents'])
      ? frontmatter['allowed-agents']
      : Array.isArray(frontmatter.allowedAgentIds)
        ? frontmatter.allowedAgentIds
        : null;
  const maxIterations = Number(
    frontmatter['max-iterations'] ?? frontmatter.maxIterations ?? 6,
  );
  const version = Number(frontmatter.version ?? 1);
  // `source` marks where a disk-backed skill came from. 'melo-bundle'
  // denotes a skill shipped with Melo (installed by the bundle script) —
  // these are read-only from the user's perspective and the upgrade-proposal
  // flow must not mutate them. Anything else (unset, 'user', 'custom') is
  // user-owned and freely upgradable.
  const source = typeof frontmatter.source === 'string'
    ? frontmatter.source.trim()
    : null;
  return {
    id: String(skillId).trim(),
    name,
    description,
    systemPrompt: body.trim(),
    type,
    tags,
    triggers,
    toolWhitelist,
    allowedAgentIds,
    maxIterations,
    version,
    addedBy: 'User',
    invokedBy: 'User or Melo',
    origin: 'disk',
    source: source || null,
    diskPath,
  };
}

/**
 * Render a skill back to SKILL.md text so it can be exported to disk.
 */
export function skillToMarkdown(skill) {
  const lines = ['---'];
  lines.push(`name: ${safeYaml(skill.name || skill.id)}`);
  if (skill.description) lines.push(`description: ${safeYaml(skill.description)}`);
  if (skill.type) lines.push(`type: ${skill.type}`);
  if (Array.isArray(skill.tags) && skill.tags.length) {
    lines.push(`tags: [${skill.tags.map(safeYaml).join(', ')}]`);
  }
  if (Array.isArray(skill.triggers) && skill.triggers.length) {
    lines.push(`triggers: [${skill.triggers.map(safeYaml).join(', ')}]`);
  }
  if (Array.isArray(skill.toolWhitelist) && skill.toolWhitelist.length) {
    lines.push(`allowed-tools: [${skill.toolWhitelist.map(safeYaml).join(', ')}]`);
  }
  if (Array.isArray(skill.allowedAgentIds) && skill.allowedAgentIds.length) {
    lines.push(`allowed-agents: [${skill.allowedAgentIds.map(safeYaml).join(', ')}]`);
  }
  if (skill.maxIterations) lines.push(`max-iterations: ${skill.maxIterations}`);
  if (skill.version) lines.push(`version: ${skill.version}`);
  if (skill.source) lines.push(`source: ${safeYaml(skill.source)}`);
  lines.push('---');
  lines.push('');
  lines.push(String(skill.systemPrompt || '').trim());
  return lines.join('\n') + '\n';
}

function safeYaml(value) {
  const s = String(value ?? '');
  if (!s) return '""';
  if (/[:{}[\],&*#?|<>=!%@`]/.test(s) || s.includes(',') || s.includes('"')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Scan <MELO_HOME>/desktop/skills/ and load every subdir that has a SKILL.md.
 * Silently skips broken entries so one corrupt skill doesn't crash startup.
 */
export async function loadSkillsFromDisk(root = getSkillsDiskRoot()) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillId = entry.name;
    const dir = path.join(root, skillId);
    const mdPath = path.join(dir, 'SKILL.md');
    try {
      const raw = await fs.readFile(mdPath, 'utf8');
      out.push(skillFromMarkdown(skillId, raw, dir));
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      // eslint-disable-next-line no-console
      console.warn(`[skillsDisk] failed to load ${skillId}: ${err.message}`);
    }
  }
  return out;
}

/**
 * Export a single skill to <MELO_HOME>/desktop/skills/<id>/SKILL.md.
 * Creates the directory structure if missing.
 */
export async function saveSkillToDisk(skill, root = getSkillsDiskRoot()) {
  if (!skill || !skill.id) throw new Error('saveSkillToDisk: skill.id required');
  const dir = path.join(root, skill.id);
  await fs.mkdir(dir, { recursive: true });
  const mdPath = path.join(dir, 'SKILL.md');
  await fs.writeFile(mdPath, skillToMarkdown(skill), 'utf8');
  return dir;
}

/**
 * Delete a disk-based skill directory. Guard-railed to refuse if path
 * escapes the skills root.
 */
export async function removeSkillFromDisk(skillId, root = getSkillsDiskRoot()) {
  const dir = path.resolve(root, skillId);
  if (!dir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('removeSkillFromDisk: refused, path escaped root');
  }
  await fs.rm(dir, { recursive: true, force: true });
}
