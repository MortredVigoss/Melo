export function createScrollPreservation({ document, HTMLElement, HTMLTextAreaElement, HTMLFormElement }) {
const _PRESERVED_SCROLL_SELECTORS = [
  '.customize-pane',
  '.search-panel-body',
  '.search-results-stream',
  '.agent-list-pane',
  '.agent-detail-column',
];

function captureScrollPositions() {
  const map = new Map();
  _PRESERVED_SCROLL_SELECTORS.forEach(selector => {
    document.querySelectorAll(selector).forEach((el, index) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.scrollTop > 0) {
        map.set(`${selector}::${index}`, el.scrollTop);
      }
    });
  });
  return map;
}

function restoreScrollPositions(map) {
  if (!map || map.size === 0) return;
  map.forEach((scrollTop, key) => {
    const [selector, indexStr] = key.split('::');
    const elements = document.querySelectorAll(selector);
    const target = elements[Number(indexStr)];
    if (target instanceof HTMLElement) {
      target.scrollTop = scrollTop;
    }
  });
}

// ── Named textarea scroll preservation ───────────────────────────────────────
// captureFocusedInputState only saves scrollTop for the ACTIVELY focused
// element. But users also scroll around textareas they haven't clicked into —
// e.g. reading the Voice personality text, the system prompt, the connector
// description — and a background render that fires while their cursor is
// outside the textarea (3s autosave resolving, 4s runtime poll, toast timer,
// etc.) used to yank the textarea's scrollTop back to 0, because
// app.innerHTML swap creates a brand-new DOM node with no scroll history.
//
// This pair covers ALL <textarea name="..."> elements inside <form id="...">,
// keyed by (formId, name) — the same stable identity pair we use for focus
// restore. Inputs (type=text etc.) don't have a visible scrollTop so they're
// skipped. The agent-content-editor textarea (IDENTITY.md) also has its own
// dedicated capture via captureAgentEditorState; this generic path is a
// cheap safety net that catches every OTHER named textarea in the app.
function captureFormTextareaScrolls() {
  const map = new Map();
  document.querySelectorAll('form[id] textarea[name]').forEach(el => {
    if (!(el instanceof HTMLTextAreaElement)) return;
    if (el.scrollTop <= 0) return;
    const form = el.form;
    if (!form || !form.id || !el.name) return;
    map.set(`${form.id}::${el.name}`, el.scrollTop);
  });
  return map;
}

function restoreFormTextareaScrolls(map) {
  if (!map || map.size === 0) return;
  map.forEach((scrollTop, key) => {
    const sep = key.indexOf('::');
    if (sep < 0) return;
    const formId = key.slice(0, sep);
    const name = key.slice(sep + 2);
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLTextAreaElement) {
      el.scrollTop = scrollTop;
    }
  });
}

// ── Thread anchor: scroll preservation that survives async viz hydration ──
// Why this exists: render() saves scrollTop before the innerHTML swap and
// restores it afterward. That's fine for simple text content, but Demon viz
// cards hydrate asynchronously — scene3d canvases mount on the microtask
// queue (or later, for the lazy globe-flight), and when they take a layout
// slot the content ABOVE the user's viewport grows by hundreds of pixels.
// The restored scrollTop is then pointing at the wrong content. The user
// sees their scroll "jump" to a different viz card.
//
// Capturing an anchor by DOM element (message-id) instead of scrollTop
// lets us correct for layout shift after the async hydration completes.

// Snapshot the anchor: whatever .message article is closest to (but not
// past) the top of the viewport, its messageId, and its y-offset within
// the viewport. We also record the autoFollow flag — if the user was
// pinned to the bottom we should stay pinned, not anchor.
function captureThreadAnchor(scroller) {
  if (!(scroller instanceof HTMLElement)) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  // Auto-follow threshold — if the user is within 24px of the bottom, skip
  // anchoring entirely. syncThreadViewport already handles that case.
  const distanceFromBottom =
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (distanceFromBottom < 24) return null;
  const messages = scroller.querySelectorAll('.message[data-message-id]');
  let bestId = null;
  let bestOffsetFromScrollerTop = Infinity;
  for (const el of messages) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    // Distance from scroller-top to message-top (negative if above viewport).
    const delta = r.top - scrollerRect.top;
    // Prefer the first message whose TOP is at or below the scroller top
    // (i.e. the first one partially visible). If none exist (user is above
    // the first message), fall back to the message with the smallest
    // positive delta that we've seen.
    if (delta >= 0 && delta < bestOffsetFromScrollerTop) {
      bestId = el.dataset.messageId;
      bestOffsetFromScrollerTop = delta;
      break;
    }
  }
  if (!bestId) return null;
  return { messageId: bestId, viewportOffset: bestOffsetFromScrollerTop };
}

// Restore by anchor: find the element with the same messageId, measure its
// new y-offset, and shift scrollTop so the element is back at the original
// viewport offset. Idempotent — can be called multiple times as async viz
// cards hydrate and re-grow the layout.
function restoreThreadAnchor(anchor) {
  if (!anchor || !anchor.messageId) return false;
  const scroller = document.querySelector('.thread-scroll-region');
  if (!(scroller instanceof HTMLElement)) return false;
  const el = scroller.querySelector(
    `.message[data-message-id="${String(anchor.messageId).replace(/"/g, '')}"]`,
  );
  if (!(el instanceof HTMLElement)) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const currentOffset = elRect.top - scrollerRect.top;
  const correction = currentOffset - anchor.viewportOffset;
  // Small delta — don't bother; also avoids thrashing when we're already stable.
  if (Math.abs(correction) < 1) return true;
  scroller.scrollTop += correction;
  return true;
}

return { captureScrollPositions, restoreScrollPositions, captureFormTextareaScrolls, restoreFormTextareaScrolls, captureThreadAnchor, restoreThreadAnchor };
}
