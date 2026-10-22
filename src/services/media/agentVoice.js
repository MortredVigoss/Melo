// Per-Agent voice on every surface (user decision 2026-10-22: "桌面的 Agent
// 也是可以自定义风格"). The mode, voice and style an Agent's card sets apply
// to the desktop read-aloud exactly as they do to the archived Telegram /
// Discord voice replies:
//   summary → rewriteForVoice: the rule-based spoken extract, restyled by the
//             Agent's voice style instructions when it has any
//   full    → the reply as written (streamed sentence by sentence on the desktop)
//   off     → nothing is read automatically; an explicit "read aloud" still
//             reads the full text
// An unknown Agent (no profile) behaves like 'full', which was the desktop's
// only behaviour before.
import { rewriteForVoice } from './voiceRewrite.js';
import { normalizeAgentProfile } from '../../state/agentProfiles.js';

export const VOICE_REPLY_MODES = Object.freeze(['summary', 'full', 'off']);

export function agentVoiceProfile(state, agentId) {
  const id = String(agentId || '').trim();
  if (!id || !state?.agentProfiles || !Object.hasOwn(state.agentProfiles, id)) return null;
  return normalizeAgentProfile(id, state.agentProfiles[id]);
}

export function agentVoiceMode(profile) {
  if (!profile) return 'full';
  return VOICE_REPLY_MODES.includes(profile.voiceReplyMode) ? profile.voiceReplyMode : 'summary';
}

// The Agent's own voice ids and MiniMax tuning win over the global TTS
// settings (the same overlay the Telegram / Discord replies build).
export function agentTtsConfig(config, profile) {
  if (!profile) return config;
  const next = { ...config };
  if (profile.minimaxVoiceId) next.minimaxVoiceId = profile.minimaxVoiceId;
  if (profile.edgeTtsVoice) next.ttsEdgeVoice = profile.edgeTtsVoice;
  for (const key of ['ttsSpeed', 'ttsPitch', 'ttsVol']) if (profile[key] != null) next[key] = profile[key];
  return next;
}

// What this Agent says out loud for `text`. `rewrite` is injectable for tests.
export async function voiceTextForAgent({ text, profile, config, rewrite = rewriteForVoice }) {
  const mode = agentVoiceMode(profile);
  const input = String(text || '').trim();
  if (!input || mode !== 'summary') return { mode, text: input };
  const spoken = await rewrite(input, config, profile?.voicePersonality || '').catch(() => input);
  return { mode, text: String(spoken || '').trim() || input };
}
