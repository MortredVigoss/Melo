// ─── Viz-spec service ────────────────────────────────────────────────────────
// Legacy Demon visualization protocol. New-request authoring is retired
// (user request, 2026-10-07); saved specs and their renderers remain readable.
// The chat runner uses enabled:false to strip unexpected trailers without
// creating a new visualization. Instruction builders remain for compatibility.
//
// Why this lives in its own service:
//   - The emit-side (system prompt) and the parse-side (strip trailer,
//     validate, attach to message) share the exact same list of supported
//     renderer keys and the same allow/deny content rules. Putting both in
//     one module keeps the two halves from drifting.
//   - The desktop UI's viz renderer (desktop-ui/viz/*) imports the same
//     renderer key list, so the frontend and backend agree on what keys are
//     legal without duplicating the catalog.
//
// Public surface:
//   - VIZ_RENDERER_KEYS                 — Set<string> of legal renderer keys
//   - listVizRendererKeys()             — array form, for UI / docs
//   - buildVizSpecInstructions(opts)    — system-prompt block (emit side)
//   - extractVizSpec(text)              — parse+validate trailer (parse side)
//
// Design notes:
//   - The trailer is a literal `<viz-spec>…</viz-spec>` block so it survives
//     markdown, fenced code, and the various strip passes in messageBlocks.js
//     without being mistaken for content.
//   - The JSON is parsed strictly (JSON.parse), so the model cannot inject
//     arbitrary JS — the frontend renderer ONLY receives structured data and
//     picks a PRE-BUILT renderer by `renderer` key. No eval, no template
//     injection.
//   - Remote channels (Telegram/Discord) are gated OFF — the instruction is
//     not injected, and even if a stray spec shows up in a remote reply we
//     strip it before forwarding. Desktop UI is the only surface that renders
//     visualizations.
//   - Content rules (the allow/deny list for when the model should emit a
//     spec) are intentionally embedded IN the system prompt, not enforced
//     server-side. Enforcing them server-side would require a second LLM
//     call per message; we lean on the prompt + a post-validate sanity
//     check instead.

export const VIZ_RENDERER_KEYS = new Set([
  // ── Physics / dynamics ─────────────────────────────────────────────────
  'projectile',      // 2D projectile motion: v0, theta, g → trajectory
  'pendulum',        // simple pendulum: length, amplitude, damping
  'wave',            // sinusoidal wave: amplitude, frequency, phase, speed
  'spring',          // spring-mass oscillator

  // ── Electrical ─────────────────────────────────────────────────────────
  'circuit-rc',      // RC circuit charge/discharge curves
  'circuit-ohm',     // Ohm's law: V / I / R slider interplay

  // ── Math / geometry ────────────────────────────────────────────────────
  'function-plot',   // f(x) plotter, user edits coefficients
  'vector-field',    // 2D vector field (u(x,y), v(x,y))
  'geometry',        // configurable geometric figure (triangle / circle etc)

  // ── Chemistry ──────────────────────────────────────────────────────────
  'molecule',        // 3dmol.js viewer with SMILES / PDB
  'reaction-energy', // activation energy diagram

  // ── Structural / planning ──────────────────────────────────────────────
  'tree',            // expandable hierarchy, used for plans / decision trees
  'flowchart',       // sequenced steps with arrows
  'timeline',        // ordered events along a time axis

  // ── 3D interactive scenes (Three.js, drag to rotate + zoom) ────────────
  'globe-flight',    // 3D globe with animated plane along a great-circle arc
]);

export function listVizRendererKeys() {
  return Array.from(VIZ_RENDERER_KEYS);
}

// Max bytes we are willing to parse from a trailer. A realistic spec is
// ~1-3 KB; 16 KB is a generous ceiling that caps the parser's attack
// surface in case a prompt-injection attack tries to stuff the trailer with
// a giant payload to slow us down or crash JSON.parse.
const MAX_VIZ_SPEC_BYTES = 16 * 1024;

// Hard cap on tree / flowchart node counts. Keeps a rogue plan from producing
// a 10,000-node SVG the frontend can't render.
const MAX_NODES = 64;

// The exact tag the model must emit. Chosen to be explicit, easy to grep,
// and unlikely to collide with anything the model naturally writes.
const VIZ_SPEC_PATTERN =
  /<viz-spec>\s*([\s\S]*?)\s*<\/viz-spec>/i;

// Matches `<viz-spec>…</viz-spec>` anywhere in the text, globally — used to
// strip stray copies (e.g. if the model echoed the tag inside an example
// block) before we persist the text.
const VIZ_SPEC_GLOBAL_PATTERN =
  /<viz-spec>[\s\S]*?<\/viz-spec>/gi;

/**
 * Produce the system-prompt section instructing the model to attach a
 * `<viz-spec>` trailer when — and only when — the answer benefits from an
 * interactive visualization.
 *
 * The instruction is skipped entirely when:
 *   - The user has not toggled Demon mode (enabled === false), OR
 *   - The reply will be delivered over a remote channel (Telegram/Discord),
 *     since those surfaces cannot render visualizations anyway.
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled]         Demon toggle (uiState.demonMode).
 * @param {boolean} [opts.isRemoteChannel] True for TG/Discord replies.
 * @returns {string}
 */
export function buildVizSpecInstructions({
  enabled = false,
  isRemoteChannel = false,
} = {}) {
  if (!enabled || isRemoteChannel) {
    return '';
  }

  const rendererList = listVizRendererKeys()
    .map(key => `  - "${key}"`)
    .join('\n');

  return [
    'Interactive visualization mode (Demon) is ENABLED for this reply.',
    '',
    'When — AND ONLY WHEN — your answer materially benefits from an',
    'interactive diagram, append exactly one `<viz-spec>…</viz-spec>` block',
    'at the very end of your reply, after all prose. The block must contain',
    'a single JSON object. Do not wrap it in a markdown code fence.',
    '',
    'Emit a viz-spec block when the answer is about:',
    '  - A physical / chemical / mathematical principle whose behaviour a',
    '    reader should understand by dragging a continuous parameter and',
    '    watching the diagram respond (e.g. projectile motion at different',
    '    angles, RC-circuit charging curves, a function plot whose shape',
    '    changes with a coefficient).',
    '  - A multi-step plan, design, algorithm, or decision process with 3 or',
    '    more distinct nodes that has a natural tree, flowchart, or timeline',
    '    structure.',
    '  - A flight, trip, or route between two points on Earth where seeing',
    '    the path on a rotatable 3D globe materially helps the reader — use',
    '    `renderer: "globe-flight"`. Typical triggers: airline-flight lookups,',
    '    great-circle route questions, "how far from X to Y", long-haul trip',
    '    planning.',
    '',
    'Do NOT emit a viz-spec block when the answer is:',
    '  - Trivial arithmetic, a closed-form fact lookup, a yes/no answer,',
    '    or a single-step calculation (e.g. "what is 1+1", "capital of France").',
    '  - Subjective discussion of news, politics, ethics, interpretation,',
    '    criticism, or anything whose content cannot be re-parameterized into',
    '    a structured interactive object.',
    '  - A short conversational turn, acknowledgement, clarification, or',
    '    small-talk reply.',
    '  - A pure code explanation that is already clearer as code than as a',
    '    visualization.',
    'If in doubt, OMIT the block — silence is better than a useless diagram.',
    '',
    'JSON shape contract (common fields):',
    '{',
    '  "kind":      "interactive" | "tree",',
    '  "renderer":  one of the renderer keys below,',
    '  "title":     short human-readable title,',
    '  "params":    array of {id, label, min, max, default, step?, unit?}',
    '               — sliders. Required for most interactive renderers.',
    '  "formula":   optional string, shown next to the diagram,',
    '  "nodes":     array of {id, label, children?:[ids], desc?}',
    '               (required when kind === "tree"; id must be unique; first',
    '               node is the root; also used by renderer:"flowchart").',
    '}',
    '',
    'Allowed renderer keys:',
    rendererList,
    '',
    'Per-renderer required fields (in ADDITION to the common fields):',
    '  - projectile / pendulum / spring / wave / circuit-rc / circuit-ohm /',
    '    reaction-energy: only `params`. Each param is a slider.',
    '  - function-plot:  `params` (coefficients) + optional `expression`',
    '                    (e.g. "a*sin(x) + b"; only [0-9a-zA-Z_+\\-*/().,\\s]',
    '                    characters, ≤200 chars; Math.* functions available).',
    '  - geometry:       `params` + `shape`: "triangle" | "circle".',
    '  - vector-field:   `params` + `fieldType`: one of "radial" | "swirl" |',
    '                    "saddle" | "sink" | "dipole".',
    '  - molecule:       `atoms`: [{id, element, x, y, charge?}] AND',
    '                    `bonds`: [{from, to, order?:1|2|3}]. Positions are',
    '                    2D layout coordinates in arbitrary units (the client',
    '                    normalizes them to fit the canvas). Include at least',
    '                    one atom. `params` is optional. Optional `smiles`.',
    '  - timeline:       `events`: [{date, title, note?}], up to 64 events.',
    '                    `params` is optional.',
    '  - tree / flowchart: `nodes` (see above), up to 64 nodes.',
    '  - globe-flight:   `origin`: {lat, lng, label?} AND `destination`:',
    '                    {lat, lng, label?}. Coordinates are decimal degrees',
    '                    (lat ∈ [-90, 90], lng ∈ [-180, 180]). Optional',
    '                    `flightNumber` (e.g. "UA837"), `subtitle` (e.g.',
    '                    "United 837 · 11h 05m"), `autoRotate` (boolean),',
    '                    `arcDuration` (seconds for the plane to traverse',
    '                    the arc, 2-60). `params` is optional — this',
    '                    renderer is driven by the geography, not sliders.',
    '                    The scene is true 3D: the user drags to rotate the',
    '                    globe and scrolls to zoom.',
    '',
    'Rules:',
    '  - Use only renderer keys from the list above — unknown keys will be',
    '    dropped by the client.',
    '  - `kind: "tree"` requires `nodes` (first = root, total ≤ 64 nodes).',
    '  - `molecule`, `timeline`, and `globe-flight` may be emitted without',
    '    `params` because their entire payload lives in the structured',
    '    fields (`atoms`/`bonds`, `events`, `origin`/`destination`); every',
    '    OTHER interactive renderer still needs at least one slider.',
    '  - The trailer must be a *single* `<viz-spec>` block at the very end;',
    '    never include multiple blocks or place one mid-reply.',
    '  - The JSON must be valid (strict JSON, double-quoted keys/strings).',
    '  - Do not output any chain-of-thought inside the block.',
    '',
    'Worked example — flight query ("What is flight UA837?"):',
    '<viz-spec>',
    '{"kind":"interactive","renderer":"globe-flight","title":"UA837 SFO → NRT",',
    ' "origin":{"lat":37.6189,"lng":-122.3750,"label":"SFO"},',
    ' "destination":{"lat":35.7647,"lng":140.3863,"label":"NRT"},',
    ' "flightNumber":"UA837","subtitle":"United 837 · 11h 05m",',
    ' "arcDuration":10}',
    '</viz-spec>',
    'Emit this exact shape (with real lat/lng for the airports involved)',
    'whenever the user asks about a specific flight, an airline route, the',
    'distance between two cities by air, or any other "point A to point B on',
    'the globe" question. Do NOT fall back to timeline or tree for these —',
    'globe-flight is the correct renderer.',
  ].join('\n');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ── Renderer-specific data pass-through ───────────────────────────────────
// A few renderers (molecule, function-plot, geometry, vector-field,
// timeline, reaction-energy) need structured data on the spec that is NOT
// a parameter slider — atoms/bonds, an expression, a shape enum, an event
// list, etc. Without a per-renderer allow-list the normalizer would strip
// those fields and the frontend would render an empty card.
//
// Each entry is a synchronous normalizer that returns a plain object
// containing only the fields that passed validation, or `null` if the
// spec is unusable without that data (e.g. a molecule with no atoms).
// Caps on array sizes are deliberate: an adversarial spec must not be
// able to force the frontend to render 10k atoms.

const MAX_MOLECULE_ATOMS = 120;
const MAX_MOLECULE_BONDS = 240;
const MAX_TIMELINE_EVENTS = 64;
const MAX_STRING_LEN = 200;

function normalizeMoleculeData(raw) {
  const atomsIn = Array.isArray(raw.atoms) ? raw.atoms : [];
  const bondsIn = Array.isArray(raw.bonds) ? raw.bonds : [];
  if (!atomsIn.length) return null;

  const idSet = new Set();
  const atoms = [];
  for (const a of atomsIn) {
    if (!isPlainObject(a)) continue;
    const id = typeof a.id === 'string' ? a.id.trim().slice(0, 32) : '';
    const element = typeof a.element === 'string' ? a.element.trim().slice(0, 4) : '';
    const x = Number(a.x);
    const y = Number(a.y);
    if (!id || !element || idSet.has(id)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    idSet.add(id);
    const atom = { id, element, x, y };
    if (a.charge != null) {
      const charge = String(a.charge).trim().slice(0, 4);
      if (charge) atom.charge = charge;
    }
    atoms.push(atom);
    if (atoms.length >= MAX_MOLECULE_ATOMS) break;
  }
  if (!atoms.length) return null;

  const bonds = [];
  for (const b of bondsIn) {
    if (!isPlainObject(b)) continue;
    const from = typeof b.from === 'string' ? b.from.trim() : '';
    const to = typeof b.to === 'string' ? b.to.trim() : '';
    if (!idSet.has(from) || !idSet.has(to) || from === to) continue;
    const order = Number(b.order);
    const bond = { from, to };
    if (order === 2 || order === 3) bond.order = order;
    bonds.push(bond);
    if (bonds.length >= MAX_MOLECULE_BONDS) break;
  }

  const data = { atoms, bonds };
  if (typeof raw.smiles === 'string' && raw.smiles.trim()) {
    data.smiles = raw.smiles.trim().slice(0, MAX_STRING_LEN);
  }
  return data;
}

const FUNCTION_PLOT_EXPR_PATTERN = /^[0-9a-zA-Z_+\-*/().,\s]+$/;

function normalizeFunctionPlotData(raw) {
  const expr = typeof raw.expression === 'string' ? raw.expression.trim() : '';
  if (!expr) return {}; // renderer has a default; params are the main input
  if (expr.length > MAX_STRING_LEN) return {};
  if (!FUNCTION_PLOT_EXPR_PATTERN.test(expr)) return {};
  return { expression: expr };
}

function normalizeGeometryData(raw) {
  const shape = raw.shape === 'circle' ? 'circle' : raw.shape === 'triangle' ? 'triangle' : null;
  return shape ? { shape } : {};
}

const ALLOWED_FIELD_TYPES = new Set(['radial', 'swirl', 'saddle', 'sink', 'dipole']);

function normalizeVectorFieldData(raw) {
  const fieldType = typeof raw.fieldType === 'string' ? raw.fieldType.trim() : '';
  return ALLOWED_FIELD_TYPES.has(fieldType) ? { fieldType } : {};
}

function normalizeTimelineData(raw) {
  const eventsIn = Array.isArray(raw.events) ? raw.events : [];
  if (!eventsIn.length) return null;
  const events = [];
  for (const e of eventsIn) {
    if (!isPlainObject(e)) continue;
    const date = typeof e.date === 'string' ? e.date.trim().slice(0, 40) : '';
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, MAX_STRING_LEN) : '';
    if (!date || !title) continue;
    const event = { date, title };
    if (typeof e.note === 'string' && e.note.trim()) {
      event.note = e.note.trim().slice(0, MAX_STRING_LEN);
    }
    events.push(event);
    if (events.length >= MAX_TIMELINE_EVENTS) break;
  }
  return events.length ? { events } : null;
}

// Reused helper for globe-flight + any future renderer needing a lat/lng pair.
function normalizeGeoPoint(p) {
  if (!isPlainObject(p)) return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const point = { lat, lng };
  if (typeof p.label === 'string' && p.label.trim()) {
    point.label = p.label.trim().slice(0, 32);
  }
  return point;
}

function normalizeGlobeFlightData(raw) {
  const origin = normalizeGeoPoint(raw.origin);
  const destination = normalizeGeoPoint(raw.destination);
  // A flight needs both endpoints — otherwise the renderer can't draw the arc.
  if (!origin || !destination) return null;
  const data = { origin, destination };
  if (typeof raw.flightNumber === 'string' && raw.flightNumber.trim()) {
    data.flightNumber = raw.flightNumber.trim().slice(0, 24);
  }
  if (typeof raw.subtitle === 'string' && raw.subtitle.trim()) {
    data.subtitle = raw.subtitle.trim().slice(0, MAX_STRING_LEN);
  }
  if (raw.autoRotate === true) data.autoRotate = true;
  const arcDuration = Number(raw.arcDuration);
  if (Number.isFinite(arcDuration) && arcDuration >= 2 && arcDuration <= 60) {
    data.arcDuration = arcDuration;
  }
  return data;
}

// `null` from a normalizer means "cannot render without this data, drop
// the whole spec". `{}` means "no extras needed, params-only".
const RENDERER_DATA_NORMALIZERS = {
  molecule: normalizeMoleculeData,
  'function-plot': normalizeFunctionPlotData,
  geometry: normalizeGeometryData,
  'vector-field': normalizeVectorFieldData,
  timeline: normalizeTimelineData,
  'globe-flight': normalizeGlobeFlightData,
};

// Renderers that do NOT need a params array — their entire input lives in
// the per-renderer `data` fields. Interactive-spec normalization must not
// drop them just because params is empty.
const PARAMLESS_RENDERERS = new Set(['molecule', 'timeline', 'globe-flight']);

function normalizeInteractiveSpec(raw) {
  const rawParams = Array.isArray(raw.params) ? raw.params : [];
  const params = rawParams
    .map(param => {
      if (!isPlainObject(param)) return null;
      const id = typeof param.id === 'string' ? param.id.trim() : '';
      const label = typeof param.label === 'string' ? param.label.trim() : '';
      const min = Number(param.min);
      const max = Number(param.max);
      const def = Number(param.default);
      if (!id || !label) return null;
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(def)) {
        return null;
      }
      if (min === max) return null;
      const step = Number.isFinite(Number(param.step)) ? Number(param.step) : null;
      const unit = typeof param.unit === 'string' ? param.unit.trim() : '';
      return {
        id,
        label,
        min,
        max,
        default: Math.min(Math.max(def, Math.min(min, max)), Math.max(min, max)),
        step,
        unit,
      };
    })
    .filter(Boolean);

  const renderer = raw.renderer;
  const dataNormalizer = RENDERER_DATA_NORMALIZERS[renderer];
  const rendererData = dataNormalizer ? dataNormalizer(raw) : {};
  // A normalizer returning `null` is a hard-fail (e.g. molecule with no atoms).
  if (rendererData === null) return null;

  // Params are optional only for renderers that carry their whole payload
  // in data fields (molecule, timeline). Everything else still needs at
  // least one slider.
  if (!params.length && !PARAMLESS_RENDERERS.has(renderer)) {
    return null;
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const formula = typeof raw.formula === 'string' ? raw.formula.trim() : '';

  return {
    kind: 'interactive',
    renderer,
    title,
    params,
    formula,
    ...rendererData,
  };
}

function normalizeTreeSpec(raw) {
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (!rawNodes.length || rawNodes.length > MAX_NODES) {
    return null;
  }

  const idSet = new Set();
  const nodes = [];
  for (const node of rawNodes) {
    if (!isPlainObject(node)) continue;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    const label = typeof node.label === 'string' ? node.label.trim() : '';
    if (!id || !label || idSet.has(id)) continue;
    idSet.add(id);
    const children = Array.isArray(node.children)
      ? node.children
          .map(childId => (typeof childId === 'string' ? childId.trim() : ''))
          .filter(Boolean)
      : [];
    const desc = typeof node.desc === 'string' ? node.desc.trim() : '';
    nodes.push({ id, label, children, desc });
  }

  if (!nodes.length) return null;

  // Drop child refs that point to ids we don't have. Keeps the renderer
  // from drawing dangling edges.
  const validIds = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    node.children = node.children.filter(childId => validIds.has(childId));
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const rootLabel = typeof raw.rootLabel === 'string' ? raw.rootLabel.trim() : '';

  return {
    kind: 'tree',
    renderer: raw.renderer,
    title: title || rootLabel,
    rootLabel,
    nodes,
  };
}

/**
 * Parse a `<viz-spec>…</viz-spec>` trailer out of a reply.
 *
 * Returns `{ text, viz }`:
 *   - `text` is the original input with every viz-spec tag stripped.
 *     Even if `viz` ends up null (bad JSON, unknown renderer, remote
 *     channel), the tag is still removed from `text` so the user never
 *     sees the raw `<viz-spec>…</viz-spec>` in their message history.
 *   - `viz` is a normalized spec object, or `null` if no valid spec was
 *     found. Structure:
 *         { kind: 'interactive', renderer, title, params, formula }
 *         { kind: 'tree',        renderer, title, rootLabel, nodes }
 *
 * When disabled or isRemoteChannel === true, only strip tags and return
 * `viz: null`; this also supports temporarily retired authoring.
 */
export function extractVizSpec(text = '', { isRemoteChannel = false, enabled = true } = {}) {
  const source = String(text || '');
  const match = source.match(VIZ_SPEC_PATTERN);
  const strippedText = source.replace(VIZ_SPEC_GLOBAL_PATTERN, '').trim();

  if (!enabled || isRemoteChannel || !match) {
    return { text: strippedText, viz: null };
  }

  const payload = match[1] || '';
  if (!payload.trim() || payload.length > MAX_VIZ_SPEC_BYTES) {
    return { text: strippedText, viz: null };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { text: strippedText, viz: null };
  }

  if (!isPlainObject(parsed)) {
    return { text: strippedText, viz: null };
  }

  const renderer = typeof parsed.renderer === 'string' ? parsed.renderer.trim() : '';
  if (!renderer || !VIZ_RENDERER_KEYS.has(renderer)) {
    return { text: strippedText, viz: null };
  }

  const kind = parsed.kind === 'tree' ? 'tree' : 'interactive';
  const viz =
    kind === 'tree'
      ? normalizeTreeSpec({ ...parsed, renderer })
      : normalizeInteractiveSpec({ ...parsed, renderer });

  return { text: strippedText, viz: viz || null };
}
