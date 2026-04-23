// Horizontal timeline renderer.
// Spec: events: [{ date: string|number, label: string, note?: string }]
// The renderer sorts events chronologically, lays them out proportionally
// across a fixed-width track, and staggers label boxes above/below the
// axis to avoid overlap.
import { escapeAttr, renderCardFooter, renderCardHeader } from '../vizCommon.js';

const TRACK_W = 680;
const ROW_H = 320;
const TRACK_Y = ROW_H / 2;
const PADDING_X = 40;
const LABEL_GAP = 48;
const LABEL_BOX_W = 120;

function parseDate(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d === 'string') {
    const n = Date.parse(d);
    if (Number.isFinite(n)) return n;
    const asNum = Number(d);
    if (Number.isFinite(asNum)) return asNum;
  }
  return null;
}

export default function mountTimeline(host, spec) {
  const rawEvents = Array.isArray(spec.events) ? spec.events : [];
  const events = rawEvents
    .map(e => ({
      ...e,
      sortKey: parseDate(e.date),
    }))
    .filter(e => e.sortKey !== null)
    .sort((a, b) => a.sortKey - b.sortKey);

  const minKey = events[0]?.sortKey ?? 0;
  const maxKey = events[events.length - 1]?.sortKey ?? 1;
  const span = Math.max(maxKey - minKey, 1);
  const plotW = TRACK_W - PADDING_X * 2;

  events.forEach((e, i) => {
    e.px = PADDING_X + ((e.sortKey - minKey) / span) * plotW;
    e.side = i % 2 === 0 ? 'above' : 'below';
    e.originalIndex = i;
  });

  const markers = events
    .map(
      e => `
        <line
          class="viz-timeline-tick"
          x1="${e.px}"
          y1="${TRACK_Y - 8}"
          x2="${e.px}"
          y2="${TRACK_Y + 8}"
        />
        <circle class="viz-timeline-dot" cx="${e.px}" cy="${TRACK_Y}" r="5" />
      `,
    )
    .join('');

  const labels = events
    .map(e => {
      const labelY = e.side === 'above' ? TRACK_Y - LABEL_GAP : TRACK_Y + LABEL_GAP;
      const anchorY = e.side === 'above' ? TRACK_Y - 8 : TRACK_Y + 8;
      return `
        <g class="viz-timeline-label">
          <line x1="${e.px}" y1="${anchorY}" x2="${e.px}" y2="${labelY + (e.side === 'above' ? 16 : -16)}" class="viz-timeline-leader" />
          <foreignObject
            x="${e.px - LABEL_BOX_W / 2}"
            y="${e.side === 'above' ? labelY - 50 : labelY}"
            width="${LABEL_BOX_W}"
            height="80">
            <div xmlns="http://www.w3.org/1999/xhtml" class="viz-timeline-card">
              <div class="viz-timeline-date">${escapeAttr(e.date)}</div>
              <div class="viz-timeline-title">${escapeAttr(e.label)}</div>
              ${e.note ? `<div class="viz-timeline-note">${escapeAttr(e.note)}</div>` : ''}
            </div>
          </foreignObject>
        </g>
      `;
    })
    .join('');

  host.classList.add('viz-card', 'viz-timeline-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <div class="viz-timeline-scroll">
      <svg viewBox="0 0 ${TRACK_W} ${ROW_H}" class="viz-timeline-svg">
        <line
          class="viz-timeline-track"
          x1="${PADDING_X}" y1="${TRACK_Y}"
          x2="${TRACK_W - PADDING_X}" y2="${TRACK_Y}"
        />
        ${markers}
        ${labels}
      </svg>
    </div>
    ${renderCardFooter(spec)}
  `;
  return { dispose() {} };
}
