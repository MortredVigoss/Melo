// Build the [{role, content}] context array the agent matcher consumes
// from a chat's recent messages. Sub-phase 7d-5β of the desktopStore
// decomposition: pure leaf with zero desktopStore-local dependencies, so
// it ports as a byte-for-byte copy of the original definition (CLAUDE.md
// §5).

// Build a [{role, content}] array for the matcher from the chat's recent
// messages. We only need the last 3 user-facing turns; the matcher
// weights them newest → oldest (1.0 / 0.6 / 0.3). Falls back to the plain
// latest user message string if the chat shape is unusual.
export function buildMatcherContextFromChat(chat, latestUserMessage) {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : [];
  if (msgs.length === 0) return latestUserMessage || '';
  // Walk from newest backwards, skipping system / empty messages, keeping
  // up to 3 messages. Return oldest-first (matcher reverses internally).
  const picked = [];
  for (let i = msgs.length - 1; i >= 0 && picked.length < 3; i -= 1) {
    const m = msgs[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = typeof m.text === 'string'
      ? m.text
      : typeof m.content === 'string'
        ? m.content
        : '';
    if (!text.trim()) continue;
    picked.unshift({ role: m.role, content: text });
  }
  if (picked.length === 0) return latestUserMessage || '';
  // Ensure the very latest user message is present at the tail even if
  // it hadn't been persisted onto chat.messages yet.
  if (latestUserMessage) {
    const last = picked[picked.length - 1];
    if (!last || last.role !== 'user' || last.content !== latestUserMessage) {
      picked.push({ role: 'user', content: latestUserMessage });
      // Trim back to 3.
      while (picked.length > 3) picked.shift();
    }
  }
  return picked;
}
