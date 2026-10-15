// Product availability is separate from saved channel configuration. Archiving
// a transport must not erase credentials or let an old enabled flag restart it.
export const ARCHIVED_AGENT_CHANNELS = Object.freeze(['telegram']);

export function isAgentChannelAvailable(channelId) {
  return !ARCHIVED_AGENT_CHANNELS.includes(channelId);
}

export function assertAgentChannelAvailable(channelId) {
  if (isAgentChannelAvailable(channelId)) return;
  const error = new Error('Telegram is archived. Existing configuration and conversations are preserved.');
  error.code = 'CHANNEL_ARCHIVED';
  error.statusCode = 410;
  error.permanent = true;
  throw error;
}
