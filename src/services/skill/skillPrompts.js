// Skill prompt summarization — sub-phase 7d-5β of the desktopStore
// decomposition. Pure leaf: takes a skill list and returns the
// system-prompt block (or a lean dispatch-hint form for remote/Telegram
// callers). Byte-for-byte port from desktopStore.js (CLAUDE.md §5).
//
// Already exported in the desktopStore version. desktopStore preserves
// a back-compat re-export so existing callers don't break; the test
// (`src/desktopStore.skills.test.js`) is updated to point at this new
// path as the canonical location.

// Legacy prompt-stuffing path. Only `type: 'prompt'` skills get their
// systemPrompt concatenated here. `type: 'executable'` skills are exposed
// to the model through the tool registry instead (see listExecutableSkills
// and the dynamic registration in the prepare node), so we deliberately
// skip them to keep the system prompt lean and avoid telling the model
// about skills it can both prompt-invoke AND tool-invoke, which creates
// ambiguity about which path to pick.
//
// `remote: true` returns a lean form suitable for Telegram/Discord bots —
// just a one-line per-skill summary so the shared skill set is discoverable
// without blowing the remote token budget. The full executable skill set
// is still available to the model as tools via buildToolsSystemPrompt.
export function summarizeSkillsPrompts(skills, { remote = false } = {}) {
  const candidates = skills.filter(skill =>
    skill.enabled
    && skill.type !== 'executable'
    && typeof skill.systemPrompt === 'string'
    && skill.systemPrompt.trim().length > 0,
  );

  if (!candidates.length) return '';

  if (remote) {
    // One-liner per skill so a Telegram bot still knows what its owner's
    // desktop skills can do. Truncate aggressively — the full prompt lives
    // on the desktop; here we only need dispatch-level awareness.
    const lines = ['Available skills (tools handle execution; these are dispatch hints):'];
    for (const skill of candidates) {
      const desc = String(skill.description || skill.name || '').trim();
      const shortDesc = desc.length > 140 ? desc.slice(0, 137) + '…' : desc;
      lines.push(`- ${skill.name}${shortDesc ? ` — ${shortDesc}` : ''}`);
    }
    return lines.join('\n');
  }

  return candidates
    .map(skill => `Skill: ${skill.name}\n${skill.systemPrompt}`)
    .join('\n\n');
}
