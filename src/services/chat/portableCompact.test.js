// 2026-10-18 audit L9: the phone receives a ledger rendered within its byte
// limit with the newest card intact, and an incoming compact never replaces
// cards the desktop already holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCompact, applyCompact, renderPhoneLedger } from './portableWorkspace.js';
import { appendCompactCard, ledgerCards } from '../../memory/compactLedger.js';
import { portableCompact, COMPACT_SUMMARY_LIMIT, COMPACT_CARD_SUMMARY_LIMIT } from '../../../mobile-sync/workspaceProtocol.js';

const T = '2026-10-18T00:00:00.000Z';
function longChat(cards = 12, size = 900) {
  const messages = Array.from({ length: cards * 4 + 4 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, createdAt: T }));
  const chat = { id: 'long', title: 'long', agentId: 'main', messages, compactedAt: T };
  for (let index = 0; index < cards; index += 1) {
    const slice = messages.slice(index * 4, index * 4 + 4);
    appendCompactCard(chat, { messages: slice, boundaryId: slice.at(-1).id, compactedCount: index * 4 + 4 }, { summary: `# 话题${index}\n决定 ${index} 端口 ${5000 + index} ${'细节'.repeat(size)}`, source: 'cloud', now: new Date(T) });
  }
  return chat;
}

test('the phone summary fits COMPACT_SUMMARY_LIMIT bytes, keeps the newest card in full and collapses the oldest first', () => {
  const chat = longChat();
  assert.ok(Buffer.byteLength(chat.compactSummary, 'utf8') > COMPACT_SUMMARY_LIMIT, 'desktop rendering is far over the phone limit');
  const compact = exportCompact(chat);
  assert.ok(compact, 'export succeeds');
  assert.ok(Buffer.byteLength(compact.summary, 'utf8') <= COMPACT_SUMMARY_LIMIT, `bytes ${Buffer.byteLength(compact.summary, 'utf8')}`);
  assert.match(compact.summary, /## 话题11/, 'newest card in full');
  assert.match(compact.summary, /端口 5011/);
  assert.match(compact.summary, /- 话题0（消息 #m0 … #m3/, 'oldest card collapsed to a title line');
  assert.doesNotThrow(() => portableCompact(compact), 'wire-valid without schema changes');
  assert.equal(compact.cards.length, 12);
  assert.equal(compact.cards.at(-1).id, chat.compactCards.at(-1).id);
  assert.ok(compact.cards.every(card => card.summary.length <= COMPACT_CARD_SUMMARY_LIMIT));
  // Small renderings travel byte-identical.
  const small = longChat(2, 20);
  assert.equal(exportCompact(small).summary, small.compactSummary);
  // A single oversized card is clipped on a character boundary, never mid surrogate.
  const emoji = renderPhoneLedger([{ id: 'x', summary: '😀'.repeat(5000), source: 'cloud' }], { maxBytes: 4001 });
  assert.ok(Buffer.byteLength(emoji, 'utf8') <= 4001);
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(emoji, 'utf8')));
});

test('applyCompact keeps cards the desktop already holds and appends only new ids', () => {
  const desktop = longChat(3, 50);
  const local = ledgerCards(desktop);
  const incoming = {
    boundaryMessageId: desktop.messages[15].id, compactedCount: 16, source: 'cloud', at: '2026-10-19T00:00:00.000Z',
    summary: 'phone rendering',
    cards: [
      { ...local[0], summary: 'clipped on the phone' },
      { ...local[1] },
      { ...local[2], summary: 'also clipped' },
      { id: 'card-4-phone', title: '手机上的新卡', summary: '手机本地摘要', fromMessageId: desktop.messages[12].id, toMessageId: desktop.messages[15].id, messageCount: 4, at: '2026-10-19T00:00:00.000Z', source: 'local' },
    ],
  };
  assert.equal(applyCompact(desktop, incoming), true);
  const merged = ledgerCards(desktop);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].summary, local[0].summary, 'local text wins over the clipped wire copy');
  assert.equal(merged[2].summary, local[2].summary);
  assert.equal(merged[3].id, 'card-4-phone', 'the new card is appended');
  assert.equal(desktop.compactedMessageCount, 16);
  assert.match(desktop.compactSummary, /手机上的新卡/, 'the summary is re-rendered from the merged ledger');
  assert.match(desktop.compactSummary, new RegExp(local[0].summary.slice(0, 12)));
  // Identical cards → the incoming summary is taken as-is (no needless re-render).
  const twin = longChat(2, 20);
  const same = { boundaryMessageId: twin.messages[7].id, compactedCount: 8, source: 'cloud', at: T, summary: 'same cards', cards: ledgerCards(twin) };
  assert.equal(applyCompact(twin, same), false, 'equal count and equal at: nothing advances');
  const later = { ...same, compactedCount: 8, at: '2026-10-20T00:00:00.000Z' };
  assert.equal(applyCompact(twin, later), true);
  assert.equal(twin.compactSummary, 'same cards');
});
