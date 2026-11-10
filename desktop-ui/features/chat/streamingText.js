// What the streaming bubble shows of the text received so far. Directives
// meant for the host never reach the screen: tool-call blocks, the viz
// trailer, and the uncertainty marker the model puts on its own last line
// (`[UNCERTAIN: …]`, shared/protocol/agent-loop.json `uncertainty.marker`).
// The finished reply never contains the marker, but while the reply streamed
// it stayed on screen until the final text replaced the bubble (agent audit
// 2026-11-10). One function for the first paint and the in-place update, so
// the two can never strip differently.
import { AGENT_LOOP_CONTRACT, contractRegExp } from '../../../shared/agent/loopContract.js';

const UNCERTAINTY = contractRegExp(AGENT_LOOP_CONTRACT.uncertainty.marker);
const MARKER_START = '[UNCERTAIN:';

export function streamingDisplayText(text) {
  let shown = String(text || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '')
    .replace(/<viz-spec>[\s\S]*$/i, '')
    .trim();
  shown = shown.replace(UNCERTAINTY, '').trimEnd();
  // The marker while it is still being written: a last line that begins one and is not closed yet.
  const lastLine = shown.slice(shown.lastIndexOf('\n') + 1), upper = lastLine.toUpperCase();
  if (upper.startsWith('[') && (MARKER_START.startsWith(upper) || upper.startsWith(MARKER_START) && !lastLine.includes(']'))) {
    shown = shown.slice(0, shown.length - lastLine.length).trimEnd();
  }
  return shown;
}
