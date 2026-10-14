// Accumulate Responses protocol items separately from display text. Do not
// parse or execute argument fragments, and do not expose encrypted reasoning.
export function createResponseItemCollector() {
  const items = new Map();
  const finished = new Set();
  let terminal = null;
  return {
    accept(event) {
      const index = event.output_index;
      if (['response.output_item.added', 'response.output_item.done'].includes(event.type) && Number.isInteger(index) && event.item) {
        items.set(index, { ...event.item });
        if (event.type.endsWith('.done')) finished.add(index);
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const item = items.get(index);
        if (item?.type === 'function_call' && !finished.has(index)) {
          item.arguments = (item.arguments || '') + String(event.delta || '');
          if (item.arguments.length > 256 * 1024) throw new Error('Function arguments exceed the response limit.');
        }
      }
      if (event.type === 'response.function_call_arguments.done') {
        const item = items.get(index);
        if (item?.type === 'function_call') item.arguments = event.arguments;
      }
      if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) terminal = event;
    },
    complete() {
      if (!terminal) throw new Error('Responses stream ended before completion; no function calls were executed.');
      const status = terminal.response?.status;
      if (terminal.type === 'response.incomplete' || status && status !== 'completed') {
        throw new Error(`Responses request incomplete (${status || 'incomplete'}); no function calls were executed.`);
      }
      const canonical = terminal.response?.output;
      if (!Array.isArray(canonical) && [...items.keys()].some(index => !finished.has(index))) {
        throw new Error('Responses stream contains unfinished output items.');
      }
      const output = Array.isArray(canonical) ? canonical : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      if (output.some(item => item?.type === 'function_call' && item.status && item.status !== 'completed')) {
        throw new Error('Responses contains an unfinished function call.');
      }
      return output;
    },
  };
}
