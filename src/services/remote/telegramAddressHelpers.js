// ─── Telegram address / alias helpers ────────────────────────────────────────
// Pure string helpers used by the Telegram routing layer to decide whether an
// incoming group-chat message is "addressing" the bot. No state, no I/O.
//
// This module owns:
//   - stripTelegramBotMention — strip "@botUsername" from a text
//   - hasTelegramInvokePrefix — detect leading "/ask", "/melo", "melo:" etc.
//   - escapeTelegramAliasRegex — safe regex escape for alias strings
//   - collectTelegramBotAliases — build the set of names the bot answers to
//     (agent name + botUsername + user-configured nicknames + "melo")
//   - containsTelegramBotAlias — word-boundary-aware alias lookup with a
//     dedicated CJK substring path
//
// Extracted from desktopStore.js in the Phase 5b refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state deps, no
// imports from desktopStore.

export function stripTelegramBotMention(text = '', botUsername = '') {
  const normalizedUsername = String(botUsername || '').trim();
  if (!normalizedUsername) {
    return String(text || '').trim();
  }

  const mentionPattern = new RegExp(`@${normalizedUsername}\\b`, 'gi');
  return String(text || '')
    .replace(mentionPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasTelegramInvokePrefix(text = '') {
  return /^(?:\/(?:ask|melo)\b|melo[:,，\s])/i.test(String(text || '').trim());
}

export function escapeTelegramAliasRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectTelegramBotAliases(profile, telegramChannel) {
  const aliases = new Set();
  const botUsername = String(telegramChannel?.botUsername || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (botUsername) {
    aliases.add(botUsername);
  }

  const agentName = String(profile?.name || '').trim().toLowerCase();
  if (agentName) {
    aliases.add(agentName);
    const firstWord = agentName.split(/\s+/)[0];
    if (
      firstWord &&
      firstWord.length >= 2 &&
      !['main', 'agent', 'research', 'builder', 'reviewer', 'custom'].includes(firstWord)
    ) {
      aliases.add(firstWord);
    }
  }

  aliases.add('melo');

  const nicknames = String(telegramChannel?.nicknames || '')
    .split(/[,，;；]/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  for (const nickname of nicknames) {
    aliases.add(nickname);
  }

  return [...aliases];
}

export function containsTelegramBotAlias(lowerText = '', alias = '') {
  const normalizedText = String(lowerText || '');
  const normalizedAlias = String(alias || '').trim().toLowerCase();
  if (!normalizedText || !normalizedAlias || normalizedAlias.length < 2) {
    return false;
  }

  if (/^[\u4e00-\u9fff]+$/.test(normalizedAlias)) {
    return normalizedText.includes(normalizedAlias);
  }

  const pattern = new RegExp(
    `(?:^|[^a-z0-9])${escapeTelegramAliasRegex(normalizedAlias)}(?:[^a-z0-9]|$)`,
    'i',
  );
  return pattern.test(normalizedText);
}
