import { updateStateAtomically } from '../state/stateStore.js';
import { telegramApiBase, telegramApiRequest } from '../services/remote/telegramApi.js';
import { discordApiBase, discordApiRequest } from '../services/remote/discordApi.js';

export function createReminderDelivery({ home, update = updateStateAtomically,
  telegram = telegramApiRequest, discord = discordApiRequest } = {}) {
  const telegramBase = telegramApiBase();
  const discordBase = discordApiBase();
  return async (reminder, { beforeExternalSend = async () => {} } = {}) => {
    let target;
    const content = `提醒：${String(reminder.text).slice(0, 1800)}`;
    await update(state => {
      const chat = state.chats.find(entry => entry.id === reminder.chatId);
      if (!chat) throw Object.assign(new Error('Reminder chat no longer exists.'), { permanent: true, code: 'CHAT_REMOVED' });
      const messageId = `reminder_${reminder.id}`;
      if (!chat.messages.some(message => message.id === messageId || message.id === `reminder:${reminder.id}`)) {
        const createdAt = new Date().toISOString();
        chat.messages.push({ id: messageId, role: 'assistant', content,
          blocks: [{ type: 'text', text: content }], attachments: [], createdAt });
        chat.updatedAt = createdAt;
      }
      const parts = String(chat.externalThreadKey || '').split(':');
      const agentId = parts[1] || chat.agentId;
      const profile = state.agentProfiles?.[agentId];
      target = { source: chat.source, parts, channel: profile?.channels?.[chat.source],
        threadId: chat.messageThreadId };
      return state;
    }, { home });

    if (!['telegram', 'discord'].includes(target.source)) return;
    if (!target.channel?.enabled || !target.channel?.botToken) throw new Error('Reminder channel is disconnected.');
    if (target.source === 'telegram') {
      const remoteId = target.parts[2];
      if (target.parts[0] !== 'telegram' || !/^-?\d+$/.test(remoteId || '')) throw Object.assign(new Error('Invalid Telegram reminder destination.'), { permanent: true });
      const threadId = Number(target.threadId || target.parts[3]);
      await beforeExternalSend();
      await telegram(target.channel, 'sendMessage', { baseUrl: telegramBase, body: {
        chat_id: remoteId, text: content,
        ...(threadId > 0 ? { message_thread_id: threadId } : {}),
      } });
    } else {
      const channelId = target.parts[3];
      if (target.parts[0] !== 'discord' || !/^\d+$/.test(channelId || '')) throw Object.assign(new Error('Invalid Discord reminder destination.'), { permanent: true });
      await beforeExternalSend();
      await discord(target.channel, `/channels/${channelId}/messages`, {
        baseUrl: discordBase, method: 'POST', body: { content, allowed_mentions: { parse: [] } },
      });
    }
  };
}
