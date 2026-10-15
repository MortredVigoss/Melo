// Persistent Agent records do not own local channel credentials or TTS settings.
// Runtime compatibility views keep existing channel/voice consumers working.
export const AGENT_VOICE_FIELDS = Object.freeze(['minimaxVoiceId','voiceReplyMode','voicePersonality','edgeTtsVoice','ttsSpeed','ttsPitch','ttsVol']);
const PERSONA_ALIASES = ['rolePrompt','identity','identify','soulMd','soul.md','soul','systemPrompt'];
export function hydrateAgentRecords(parsed = {}) {
  const records = {};
  for (const [id, value] of Object.entries(parsed.agentProfiles || {})) {
    records[id] = {...value};
    const channel = parsed.agentChannelBindings?.global?.[id];
    if (channel) records[id].channels = channel.channels;
    const voice = parsed.agentVoiceSettings?.global?.[id];
    if (voice) for (const key of AGENT_VOICE_FIELDS) if (Object.hasOwn(voice,key)) records[id][key] = voice[key];
  }
  return records;
}
export function hydrateProjectAgentRecords(parsed = {}) {
  return Object.fromEntries(Object.entries(parsed.projectAgentOverrides || {}).map(([projectId, records]) => [projectId,
    Object.fromEntries(Object.entries(records).map(([id, value]) => {
      const profile = {...value};
      const channel = parsed.agentChannelBindings?.projects?.[projectId]?.[id];
      if (channel) profile.channels = channel.channels;
      const voice = parsed.agentVoiceSettings?.projects?.[projectId]?.[id];
      if (voice) for (const key of AGENT_VOICE_FIELDS) if (Object.hasOwn(voice,key)) profile[key] = voice[key];
      return [id, profile];
    })),
  ]));
}
export function serializeAgentState(state) {
  const agentChannelBindings = {global:{},projects:{}};
  const agentVoiceSettings = {global:{},projects:{}};
  function record(id, raw, channels, voices) {
    const profile = {...raw};
    if (Object.hasOwn(profile,'channels')) channels[id] = {agentId:id,channels:profile.channels};
    delete profile.channels;
    const voice = {agentId:id};
    for (const key of AGENT_VOICE_FIELDS) {
      if (Object.hasOwn(profile,key)) voice[key] = profile[key];
      delete profile[key];
    }
    if (Object.keys(voice).length > 1) voices[id] = voice;
    // Sparse legacy project overrides remain readable until explicitly edited.
    if (typeof profile.instructions === 'string') for (const key of PERSONA_ALIASES) delete profile[key];
    return profile;
  }
  const agentProfiles = Object.fromEntries(Object.entries(state.agentProfiles || {}).map(([id,raw]) => [id,record(id,raw,agentChannelBindings.global,agentVoiceSettings.global)]));
  const projectAgentOverrides = Object.fromEntries(Object.entries(state.projectAgentOverrides || {}).map(([projectId, records]) => {
    const channels = agentChannelBindings.projects[projectId] = {};
    const voices = agentVoiceSettings.projects[projectId] = {};
    return [projectId,Object.fromEntries(Object.entries(records).map(([id,raw])=>[id,record(id,raw,channels,voices)]))];
  }));
  return {agentProfiles,projectAgentOverrides,agentChannelBindings,agentVoiceSettings};
}
