// Only the provider's public summary channel. Canonical done/items replace
// their own part instead of duplicating deltas or dropping later parts.
export function createReasoningSummaryCollector() {
  const items = new Map();
  let previous = '', truncated = false, retained = 0, previousTruncated = false;
  function itemFor(id, index) {
    const key = id || `index:${index ?? 0}`;
    if (!items.has(key) && items.size < 64) items.set(key, { index: index ?? items.size, parts: new Map() });
    return items.get(key);
  }
  function update(item, index, text, append = false, done = false, sequence) {
    if (!item || !Number.isInteger(index) || index < 0 || index >= 64 || typeof text !== 'string') return;
    const part = item.parts.get(index) || { text: '', done: false };
    if (append && part.done) return;
    if (append && Number.isInteger(sequence) && sequence <= (part.sequence ?? -1)) return;
    const next = append ? part.text + text : text;
    const available = 24000 - retained + part.text.length;
    truncated ||= next.length > available;
    const saved = next.slice(0, available);
    retained += saved.length - part.text.length;
    item.parts.set(index, { text: saved, done: done || part.done, sequence: sequence ?? part.sequence });
  }
  function acceptItem(item, index) {
    if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) return;
    const target = itemFor(item.id, index);
    item.summary.slice(0, 64).forEach((part, i) => {
      if (part.type === 'summary_text') update(target, i, part.text, false, true);
    });
  }
  return { accept(event) {
    if (/^response\.reasoning_summary_text\.(delta|done)$/.test(event.type)) {
      update(itemFor(event.item_id, event.output_index), event.summary_index ?? 0,
        event.type.endsWith('.delta') ? event.delta : event.text, event.type.endsWith('.delta'), event.type.endsWith('.done'), event.sequence_number);
    } else if (event.type === 'response.reasoning_summary_part.done' && event.part?.type === 'summary_text') {
      update(itemFor(event.item_id, event.output_index), event.summary_index ?? 0, event.part.text, false, true);
    } else if (event.type === 'response.output_item.done') acceptItem(event.item, event.output_index);
    else if (['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(event.type)) {
      (event.response?.output || []).forEach(acceptItem);
    }
    const parts = [...items.values()].sort((a, b) => a.index - b.index)
      .flatMap(item => [...item.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part.text)).filter(Boolean);
    const full = parts.join('\n\n'), text = full.slice(0, 24000);
    truncated ||= full.length > 24000;
    if (!text || text === previous && truncated === previousTruncated) return null;
    previous = text; previousTruncated = truncated;
    return { text, eventType: 'response.reasoning_summary_text.delta', parts: parts.length, truncated };
  } };
}
