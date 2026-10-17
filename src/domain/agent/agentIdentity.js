// Single renderer for "who this agent is" in a model prompt.
//
// Before 2026-10-17 four call sites each composed the persona differently
// (audit B-8): the main chat prompt (name + purpose + instructions + legacy
// tool list + channels), delegated members (bare `instructions`), the team
// lead summary (bare `instructions`) and Discord voice (identity → soul →
// rolePrompt → systemPrompt aliases in a non-canonical order, no headings).
// The same agent therefore "was" four different people. Every path now goes
// through this function; variants only decide how much framing surrounds the
// canonical instructions document.
//
// Pure domain module: no imports from services/state/http.

const APPLY_LINE = 'Apply this role on every turn. User-defined response requirements take precedence over generic persona text; current user instructions and permission boundaries remain controlling.';

function personaBody(profile) {
  if (typeof profile?.instructions === 'string') return [profile.instructions];
  // Legacy profiles (no merged `instructions` yet): canonical section order.
  return [
    profile?.rolePrompt,
    profile?.identity || profile?.identify ? `IDENTITY.md:\n${profile.identity || profile.identify}` : '',
    profile?.soulMd || profile?.['soul.md'] || profile?.soul ? `SOUL.md:\n${profile.soulMd || profile['soul.md'] || profile.soul}` : '',
    profile?.systemPrompt ? `Agent system prompt:\n${profile.systemPrompt}` : '',
  ];
}

/**
 * @param {object} profile — normalized agent profile (or legacy shape)
 * @param {{variant?: 'chat'|'member'|'voice'}} [options]
 *   chat   — full framing for the main conversation prompt
 *   member — same framing for a delegated / team member (no capability or
 *            channel lines; those come from the member's own tool scope)
 *   voice  — persona document only; the voice path appends its own mode suffix
 */
export function renderAgentIdentity(profile, { variant = 'chat' } = {}) {
  if (!profile) return '';
  const body = personaBody(profile).map(part => String(part || '').trim()).filter(Boolean);
  if (variant === 'voice') {
    return body.length ? body.join('\n\n') : `You are ${profile.name || 'a helpful assistant'}.`;
  }
  return [
    `User-selected role: ${profile.name || 'Melo'}\nRole purpose: ${profile.description || ''}`,
    APPLY_LINE,
    ...body,
  ].join('\n\n');
}
