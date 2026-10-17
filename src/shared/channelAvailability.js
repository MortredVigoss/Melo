// Product availability is separate from saved channel configuration. Archiving
// a transport must not erase credentials or let an old enabled flag restart it.
//
// 2026-10-16: Telegram archived (user decision).
// 2026-10-17: Discord archived as well (user decision: "暂时归档 telegram
// discord 这些，这些功能暂时不用他们"). Both transports keep their saved
// tokens / ids / history; polling, voice runtime, outgoing sends and the
// settings entry are switched off at runtime only. Restore by removing the
// id from ARCHIVED_AGENT_CHANNELS — no env var, no hidden switch.
export const ARCHIVED_AGENT_CHANNELS = Object.freeze(['telegram', 'discord']);

const CHANNEL_LABELS = Object.freeze({ telegram: 'Telegram', discord: 'Discord' });

export function isAgentChannelAvailable(channelId) {
  return !ARCHIVED_AGENT_CHANNELS.includes(channelId);
}

export function assertAgentChannelAvailable(channelId) {
  if (isAgentChannelAvailable(channelId)) return;
  const label = CHANNEL_LABELS[channelId] || String(channelId);
  const error = new Error(`${label} is archived. Existing configuration and conversations are preserved.`);
  error.code = 'CHANNEL_ARCHIVED';
  error.statusCode = 410;
  error.permanent = true;
  throw error;
}
