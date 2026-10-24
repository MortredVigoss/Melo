/**
 * Discord runtime unit tests — covers the pure helpers introduced to mirror
 * the Telegram polling cycle. End-to-end integration with fetch + state is
 * validated separately in desktopStore.discord.poll.test.js.
 *
 * Scope:
 *   - snowflake comparison (lastUpdateId advancement)
 *   - message extraction (bot filter, attachments, reply-to-bot detection)
 *   - alias collection (nicknames, agent name, bot user id)
 *   - reply-score signals (mention, invoke prefix, alias, follow-up)
 *   - thread key construction (per guild/channel)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __discordTesting } from './desktopStore.js';

const {
  snowflakeGt,
  hasDiscordInvokePrefix,
  extractDiscordAttachments,
  normalizeDiscordAttachmentKind,
  buildDiscordThreadKey,
  buildDiscordReplyScore,
  collectDiscordBotAliases,
  latestProcessableDiscordMessage,
  isDiscordMessageFromBot,
} = __discordTesting;

// ── snowflakeGt ─────────────────────────────────────────────────────────────
test('snowflakeGt: empty base accepts any non-empty id', () => {
  assert.equal(snowflakeGt('12345', ''), true);
  assert.equal(snowflakeGt('', '12345'), false);
  assert.equal(snowflakeGt('', ''), false);
});

test('snowflakeGt: longer string wins regardless of lexical order', () => {
  // Snowflakes are monotonic — newer IDs are both numerically larger AND
  // tend to be longer. A 20-digit id beats a 19-digit even if it starts "0".
  assert.equal(snowflakeGt('10000000000000000000', '9999999999999999999'), true);
});

test('snowflakeGt: same length → lexical compare matches numeric', () => {
  assert.equal(snowflakeGt('1234567890', '1234567889'), true);
  assert.equal(snowflakeGt('1234567888', '1234567889'), false);
  assert.equal(snowflakeGt('1234567890', '1234567890'), false);
});

// ── hasDiscordInvokePrefix ──────────────────────────────────────────────────
test('hasDiscordInvokePrefix: matches explicit commands, not an implicit product alias', () => {
  assert.equal(hasDiscordInvokePrefix('/ask when is the deadline'), true);
  assert.equal(hasDiscordInvokePrefix('/melo help'), true);
  assert.equal(hasDiscordInvokePrefix('melo: quick question'), false);
  assert.equal(hasDiscordInvokePrefix('melo，能帮我查一下吗'), false);
  assert.equal(hasDiscordInvokePrefix('melo how are you'), false);
  assert.equal(hasDiscordInvokePrefix('  /ask   padded  '), true);
});

test('hasDiscordInvokePrefix: no false positives on normal chatter', () => {
  assert.equal(hasDiscordInvokePrefix('hey everyone'), false);
  assert.equal(hasDiscordInvokePrefix('what about the melon'), false); // melon ≠ melo,
  assert.equal(hasDiscordInvokePrefix(''), false);
});

// ── isDiscordMessageFromBot ─────────────────────────────────────────────────
test('isDiscordMessageFromBot: author.bot and webhook_id both count', () => {
  assert.equal(isDiscordMessageFromBot({ author: { bot: true } }), true);
  assert.equal(isDiscordMessageFromBot({ webhook_id: 'x' }), true);
  assert.equal(isDiscordMessageFromBot({ author: { bot: false } }), false);
  assert.equal(isDiscordMessageFromBot({}), false);
});

// ── normalizeDiscordAttachmentKind ──────────────────────────────────────────
test('normalizeDiscordAttachmentKind: mime → melo kind', () => {
  assert.equal(normalizeDiscordAttachmentKind('image/png'), 'image');
  assert.equal(normalizeDiscordAttachmentKind('video/mp4'), 'video');
  assert.equal(normalizeDiscordAttachmentKind('audio/ogg'), 'audio');
  assert.equal(normalizeDiscordAttachmentKind('application/pdf'), 'link');
  assert.equal(normalizeDiscordAttachmentKind(''), 'link');
});

// ── extractDiscordAttachments ───────────────────────────────────────────────
test('extractDiscordAttachments: image + doc with mime', () => {
  const msg = {
    attachments: [
      {
        url: 'https://cdn.discordapp.com/x/img.png',
        filename: 'img.png',
        content_type: 'image/png',
      },
      {
        url: 'https://cdn.discordapp.com/x/doc.pdf',
        filename: 'doc.pdf',
        content_type: 'application/pdf',
      },
    ],
  };
  const out = extractDiscordAttachments(msg);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'image');
  assert.equal(out[0].fileName, 'img.png');
  assert.equal(out[1].kind, 'link');
  assert.equal(out[1].mimeType, 'application/pdf');
});

test('extractDiscordAttachments: stickers become images', () => {
  const msg = {
    attachments: [],
    sticker_items: [{ id: '999', name: 'pepe' }],
  };
  const out = extractDiscordAttachments(msg);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'image');
  assert.match(out[0].url, /stickers\/999\.png$/);
});

test('extractDiscordAttachments: drops rows with no url', () => {
  const msg = {
    attachments: [{ filename: 'ghost.png', content_type: 'image/png' /* no url */ }],
  };
  assert.deepEqual(extractDiscordAttachments(msg), []);
});

// ── buildDiscordThreadKey ───────────────────────────────────────────────────
test('buildDiscordThreadKey: stable shape per guild+channel', () => {
  assert.equal(
    buildDiscordThreadKey('custom-agent-1', '111', '222'),
    'discord:custom-agent-1:111:222',
  );
  // DM: no guild → 'dm' sentinel
  assert.equal(
    buildDiscordThreadKey('custom-agent-1', '', '222'),
    'discord:custom-agent-1:dm:222',
  );
  // Parent/thread id appended
  assert.equal(
    buildDiscordThreadKey('main', '111', '222', '333'),
    'discord:main:111:222:333',
  );
});

// ── latestProcessableDiscordMessage ─────────────────────────────────────────
test('latestProcessableDiscordMessage: drops bot messages', async () => {
  const msg = { content: 'hi', author: { bot: true } };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out, null);
});

test('latestProcessableDiscordMessage: drops empty text with no attachments', async () => {
  const msg = { content: '', author: { id: 'u1', username: 'alice' }, attachments: [] };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out, null);
});

test('latestProcessableDiscordMessage: DM (no guild_id) → chatType=private', async () => {
  const msg = {
    id: '123',
    content: 'hello',
    channel_id: '500',
    author: { id: 'u1', username: 'alice', global_name: 'Alice' },
    timestamp: '2026-04-19T10:00:00Z',
    attachments: [],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.chatType, 'private');
  assert.equal(out.chatId, '500');
  assert.equal(out.text, 'hello');
  assert.equal(out.senderName, 'Alice alice');
  assert.equal(out.receivedAt, '2026-04-19T10:00:00Z');
});

test('latestProcessableDiscordMessage: guild message → chatType=group', async () => {
  const msg = {
    id: '456',
    content: 'yo',
    channel_id: '500',
    guild_id: '900',
    author: { id: 'u2', username: 'bob' },
    attachments: [],
    mentions: [{ id: 'bot1' }, { id: 'u3' }],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.chatType, 'group');
  assert.equal(out.guildId, '900');
  assert.deepEqual(out.mentionIds, ['bot1', 'u3']);
});

test('latestProcessableDiscordMessage: wasVoiceMessage=true when flags has IS_VOICE_MESSAGE (1<<13)', async () => {
  const msg = {
    id: 'v1',
    content: 'voice note',
    channel_id: '500',
    author: { id: 'u1', username: 'alice' },
    flags: 1 << 13, // 8192 — Discord's IS_VOICE_MESSAGE bit
    attachments: [],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.wasVoiceMessage, true);
});

test('latestProcessableDiscordMessage: wasVoiceMessage=true when an attachment has audio/* content_type', async () => {
  const msg = {
    id: 'v2',
    content: 'check this',
    channel_id: '500',
    author: { id: 'u1', username: 'alice' },
    flags: 0,
    attachments: [
      { id: 'a1', url: 'https://cdn.discord/a.mp3', content_type: 'audio/mpeg', filename: 'a.mp3' },
    ],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.wasVoiceMessage, true);
});

test('latestProcessableDiscordMessage: wasVoiceMessage=false for plain text', async () => {
  const msg = {
    id: 'n1',
    content: 'just words',
    channel_id: '500',
    author: { id: 'u1', username: 'alice' },
    flags: 0,
    attachments: [],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.wasVoiceMessage, false);
});

test('latestProcessableDiscordMessage: wasVoiceMessage=false for an image-only attachment', async () => {
  const msg = {
    id: 'i1',
    content: 'photo',
    channel_id: '500',
    author: { id: 'u1', username: 'alice' },
    flags: 0,
    attachments: [
      { id: 'a1', url: 'https://cdn.discord/a.png', content_type: 'image/png', filename: 'a.png' },
    ],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.wasVoiceMessage, false);
});

test('latestProcessableDiscordMessage: isReplyToBot from referenced_message', async () => {
  const msg = {
    id: '789',
    content: 'thanks!',
    channel_id: '500',
    author: { id: 'u2', username: 'bob' },
    referenced_message: {
      id: '700',
      content: 'here you go',
      author: { id: 'botX', bot: true },
    },
    attachments: [],
  };
  const out = await latestProcessableDiscordMessage(msg, {});
  assert.equal(out.isReplyToBot, true);
  assert.equal(out.repliedToMessageId, '700');
  assert.equal(out.repliedToText, 'here you go');
});

// ── collectDiscordBotAliases ────────────────────────────────────────────────
test('collectDiscordBotAliases: pulls botUsername, nicknames, agent name, and mention token', () => {
  const profile = { name: '金冬天' };
  const channel = { botUsername: 'MeloBot', nicknames: '冬天, 小金 ; melo-helper' };
  const aliases = collectDiscordBotAliases(profile, channel, '123456');
  // Case-folded, plus the <@id> mention tokens
  assert.ok(aliases.includes('melobot'));
  assert.ok(!aliases.includes('melo'));
  assert.ok(aliases.includes('金冬天'));
  assert.ok(aliases.includes('冬天'));
  assert.ok(aliases.includes('小金'));
  assert.ok(aliases.includes('melo-helper'));
  assert.ok(aliases.includes('<@123456>'));
  assert.ok(aliases.includes('<@!123456>'));
});

test('collectDiscordBotAliases: generic first words like "main" are filtered', () => {
  const profile = { name: 'Main agent' };
  const channel = { botUsername: '', nicknames: '' };
  const aliases = collectDiscordBotAliases(profile, channel, '');
  // 'main' should NOT be added as a first-word alias (too generic)
  assert.ok(!aliases.includes('main'));
  // Full name still in
  assert.ok(aliases.includes('main agent'));
});

// ── buildDiscordReplyScore ──────────────────────────────────────────────────
test('buildDiscordReplyScore: mention of bot id → totalScore >= mentionUsername weight', () => {
  const incoming = {
    text: 'hey <@bot1> can you help',
    senderId: 'u1',
    attachments: [],
    mentionIds: ['bot1'],
    isReplyToBot: false,
  };
  const profile = { name: 'Melo' };
  const channel = { botUsername: 'MeloBot', nicknames: '' };
  const { signals, totalScore } = buildDiscordReplyScore(
    incoming, channel, profile, { messages: [] }, 'bot1',
  );
  assert.equal(signals.mentionUsername, true);
  assert.ok(totalScore >= 0.9);
});

test('buildDiscordReplyScore: invoke prefix alone crosses reply threshold', () => {
  const incoming = {
    text: '/ask what is 2+2',
    senderId: 'u1',
    attachments: [],
    mentionIds: [],
    isReplyToBot: false,
  };
  const profile = { name: 'Melo' };
  const channel = { botUsername: '', nicknames: '' };
  const { signals, totalScore } = buildDiscordReplyScore(
    incoming, channel, profile, { messages: [] }, '',
  );
  assert.equal(signals.invokePrefix, true);
  assert.ok(totalScore >= 0.8);
});

test('buildDiscordReplyScore: nickname alias with no other signal → moderate score', () => {
  const incoming = {
    text: '冬天 今天天气怎么样',
    senderId: 'u1',
    attachments: [],
    mentionIds: [],
    isReplyToBot: false,
  };
  const profile = { name: '金冬天' };
  const channel = { botUsername: '', nicknames: '冬天' };
  const { signals, totalScore } = buildDiscordReplyScore(
    incoming, channel, profile, { messages: [] }, '',
  );
  assert.equal(signals.aliasMatch, true);
  // alias alone = 0.60; no synergy — passes reply threshold (0.55).
  assert.ok(totalScore >= 0.55);
});

test('buildDiscordReplyScore: off-topic group chatter → low score', () => {
  const incoming = {
    text: 'lol nice one',
    senderId: 'u1',
    attachments: [],
    mentionIds: [],
    isReplyToBot: false,
  };
  const profile = { name: 'Melo' };
  const channel = { botUsername: 'MeloBot', nicknames: '' };
  const { totalScore } = buildDiscordReplyScore(
    incoming, channel, profile, { messages: [] }, 'bot1',
  );
  // Should NOT trigger a reply — no signals match.
  assert.ok(totalScore < 0.30);
});

test('buildDiscordReplyScore: isReplyToBot wins over everything', () => {
  const incoming = {
    text: 'ok',
    senderId: 'u1',
    attachments: [],
    mentionIds: [],
    isReplyToBot: true,
  };
  const profile = { name: 'Melo' };
  const channel = { botUsername: 'MeloBot', nicknames: '' };
  const { signals, totalScore } = buildDiscordReplyScore(
    incoming, channel, profile, { messages: [] }, 'bot1',
  );
  assert.equal(signals.isReplyToBot, true);
  assert.equal(totalScore, 1.0);
});
