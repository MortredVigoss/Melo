export function buildAgentProfilePatch(form, formData) {
  const hasFormField = name =>
    Boolean(form.elements.namedItem(name)) || formData.has(name);
  const csvList = value => String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const choiceList = name => formData.has(name+'__choices') ? formData.getAll(name).map(String) : csvList(formData.get(name));
  const patch = {};
  const assignString = (key, field = key) => {
    if (!hasFormField(field)) return;
    patch[key] = String(formData.get(field) || '').trim();
  };
  const assignNumber = (key, field = key) => {
    if (!hasFormField(field)) return;
    const raw = String(formData.get(field) ?? '').trim();
    patch[key] = raw ? Number(raw) : '';
  };

  if (hasFormField('capabilityVersion') && (!hasFormField('capabilityMigrationExpected') || formData.get('confirmCapabilityMigration')==='on')) {
    const flags=['readFiles','writeFiles','runCommands','network','knowledgeMemory','generateMedia','delegate'];
    patch.capabilities={version:1,...Object.fromEntries(flags.map(k=>[k,formData.get('cap_'+k)==='on'])),...Object.fromEntries(['skills','mcpServers','connectors'].map(k=>[k,choiceList('cap_'+k)]))};
    if(hasFormField('capabilityMigrationExpected')) patch.capabilityMigrationExpected=String(formData.get('capabilityMigrationExpected'));
    patch.collaboration={canDelegate:formData.get('canDelegate')==='on',delegateTargets:choiceList('delegateTargets'),maxDelegationDepth:Number(formData.get('maxDelegationDepth')||1),maxIterations:Number(formData.get('maxIterations')||8),maxTokens:Number(formData.get('maxTokens')||32000),timeoutMs:Number(formData.get('timeoutMs')||180000)};
    patch.contextSources=Object.fromEntries(['projects','knowledge','memory'].map(k=>[k,formData.get('context_'+k)==='on']));
  }
  assignString('name');
  assignString('laneLabel');
  assignString('description');
  if (hasFormField('instructions')) patch.instructions = String(formData.get('instructions') ?? '');
  assignString('rolePrompt');
  assignString('identity');
  assignString('soul.md');
  assignString('mood');
  assignString('model');
  assignString('systemPrompt');
  assignString('voiceReplyMode');
  assignString('voicePersonality');
  assignString('edgeTtsVoice');
  assignString('minimaxVoiceId');
  assignNumber('ttsSpeed');
  assignNumber('ttsPitch');
  assignNumber('ttsVol');

  // Tag protected metadata fields the user actively cleared. The form
  // submit is a full-form save (not a narrow patch), so an empty string
  // here is user intent. Backend's narrow-patch protection drops empty
  // strings unless the field is listed here, in which case it falls back
  // to the agent definition default.
  const protectedClearable = ['name', 'laneLabel', 'description', 'rolePrompt'];
  const clearedFields = protectedClearable.filter(
    key => key in patch && typeof patch[key] === 'string' && !patch[key].trim(),
  );
  if (clearedFields.length) patch._clearedFields = clearedFields;

  if (hasFormField('tools')) {
    patch.tools = csvList(formData.get('tools'));
  }
  if (hasFormField('enabledSkillIds')) {
    const rawSkillIds = formData.get('enabledSkillIds');
    patch.enabledSkillIds = rawSkillIds === '__all__'
      ? null
      : csvList(rawSkillIds);
  }
  if (hasFormField('enabledConnectorIds')) {
    const rawConnectorIds = formData.get('enabledConnectorIds');
    patch.enabledConnectorIds = rawConnectorIds === '__all__'
      ? null
      : csvList(rawConnectorIds);
  }
  if (hasFormField('enabledMcpServerIds')) {
    // Stdio MCP whitelist — unlike skills/connectors above, MCP defaults
    // to deny-all (`null` is coerced to `[]` by the backend normalizer),
    // so we never offer the "all servers" sentinel here.  An empty string
    // means "no MCP servers for this agent".
    patch.enabledMcpServerIds = csvList(formData.get('enabledMcpServerIds'));
  }

  const channels = {};
  if (
    hasFormField('telegramEnabled') ||
    hasFormField('telegramBotToken') ||
    hasFormField('telegramChatId') ||
    hasFormField('telegramVoiceReply')
  ) {
    channels.telegram = {
      enabled: formData.get('telegramEnabled') === 'on',
      botToken: String(formData.get('telegramBotToken') || '').trim(),
      chatId: String(formData.get('telegramChatId') || '').trim(),
      voiceReply: formData.get('telegramVoiceReply') === 'on',
    };
  }
  if (
    hasFormField('discordEnabled') ||
    hasFormField('discordBotToken') ||
    hasFormField('discordGuildId') ||
    hasFormField('discordChannelId') ||
    hasFormField('discordVoiceReply')
  ) {
    channels.discord = {
      enabled: formData.get('discordEnabled') === 'on',
      botToken: String(formData.get('discordBotToken') || '').trim(),
      guildId: String(formData.get('discordGuildId') || '').trim(),
      channelId: String(formData.get('discordChannelId') || '').trim(),
      voiceReply: formData.get('discordVoiceReply') === 'on',
    };
  }
  if (Object.keys(channels).length) {
    patch.channels = channels;
  }

  return patch;
}
