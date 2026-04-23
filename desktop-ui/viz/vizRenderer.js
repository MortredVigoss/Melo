// Viz renderer dispatcher.
//
// The backend attaches a validated `viz` field to assistant messages. On
// every DOM render we emit a mount-point shell for each such message:
//
//   <div class="viz-mount"
//        data-viz-mount
//        data-message-id="..."
//        data-viz-signature="..." />
//
// After the DOM is swapped, call `mountVizBlocks(rootEl, specsById)` to
// instantiate the matching renderer into each shell. Because the whole
// app does a full innerHTML replace on every render, we key each viz
// instance by a signature of the spec — if the signature is unchanged we
// *skip* the remount so slider state is preserved. If the signature
// changes (model issued a new viz), we dispose the old renderer and
// mount fresh.

import mountProjectile from './renderers/projectile.js';
import mountTree from './renderers/tree.js';
import mountPendulum from './renderers/pendulum.js';
import mountSpring from './renderers/spring.js';
import mountWave from './renderers/wave.js';
import mountFunctionPlot from './renderers/functionPlot.js';
import mountCircuitRc from './renderers/circuitRc.js';
import mountCircuitOhm from './renderers/circuitOhm.js';
import mountMolecule from './renderers/molecule.js';
import mountVectorField from './renderers/vectorField.js';
import mountGeometry from './renderers/geometry.js';
import mountReactionEnergy from './renderers/reactionEnergy.js';
import mountFlowchart from './renderers/flowchart.js';
import mountTimeline from './renderers/timeline.js';
// NOTE: globeFlight is LAZY-LOADED, not statically imported. It pulls in
// scene3d.js → `import 'three'`, which is resolved via the importmap to
// /vendor/three/*. If ANY of that fails at module-load time (missing vendor
// asset, botched importmap, CSP), a static import here would take down the
// ENTIRE app.js module tree and black-screen the whole UI. A dynamic
// import isolates that failure to just the globe-flight card while keeping
// the chat, sidebar, settings, etc. fully functional. See
// mountGlobeFlightLazy below.

// Mount wrapper that defers importing ./renderers/globeFlight.js (→
// scene3d.js → three.js) until the first globe-flight spec actually needs
// rendering. Returns synchronously so it fits the same
// `(host, viz) → handle` contract as the other renderers; the real mount
// happens on the microtask queue when the dynamic import resolves.
// Render a diagnostic failure card inside `host`. Shows a short human title
// ("3D visualization failed to load") + the actual error text and (when
// available) the import stage that failed. Without this, every globe-flight
// failure looks identical from the UI and we have no way to tell whether
// three.js itself is missing, the importmap didn't resolve, or the renderer
// module itself threw.
function _renderGlobeFlightError(host, stage, err) {
  host.classList.remove('viz-card-loading-3d');
  host.classList.add('viz-card-error');
  const msg = (err && (err.message || String(err))) || 'unknown error';
  const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
  host.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'viz-card-error-body';
  const title = document.createElement('div');
  title.className = 'viz-card-error-title';
  title.textContent = '3D visualization failed to load';
  const subtitle = document.createElement('div');
  subtitle.className = 'viz-card-error-subtitle';
  subtitle.textContent = stage ? `(${stage})` : '';
  const detail = document.createElement('pre');
  detail.className = 'viz-card-error-detail';
  detail.textContent = stack ? `${msg}\n${stack}` : msg;
  card.appendChild(title);
  if (subtitle.textContent) card.appendChild(subtitle);
  card.appendChild(detail);
  host.appendChild(card);
}

function mountGlobeFlightLazy(host, viz) {
  const state = { real: null, disposed: false };
  // Show a small "loading 3D scene…" placeholder so the card never looks
  // empty while three.js is fetched. Swallowed once the real mount runs.
  host.classList.add('viz-card', 'viz-card-scene3d', 'viz-card-loading-3d');
  host.textContent = 'Loading 3D scene…';

  // Pre-flight: probe each vendor asset the importmap resolves to. If any of
  // them 404 (missing node_modules/three in the shipped bundle, server
  // handler not wired, wrong path, etc.) the dynamic import below throws an
  // opaque "Failed to fetch dynamically imported module" message that
  // doesn't say which URL failed. The probe gives us the actual HTTP status
  // + URL so we can tell three.module.min.js apart from OrbitControls.js.
  //
  // NOTE: the server's /vendor/three/* handler is GET-only; we download the
  // whole file here. The browser caches it, so the subsequent `import()`
  // reuses the same bytes and doesn't pay a second round-trip.
  const _probeAsset = (path) =>
    fetch(path, { method: 'GET', cache: 'force-cache' })
      .then(r => ({ url: path, ok: r.ok, status: r.status }))
      .catch(err => ({ url: path, ok: false, status: 0, err: err?.message || String(err) }));

  Promise.all([
    _probeAsset('/vendor/three/three.module.min.js'),
    _probeAsset('/vendor/three/addons/controls/OrbitControls.js'),
  ])
    .then(checks => {
      if (state.disposed) return null;
      const missing = checks.filter(c => !c.ok);
      if (missing.length) {
        const detail = missing
          .map(c => `${c.status || 'n/a'} ${c.url}${c.err ? '  (' + c.err + ')' : ''}`)
          .join('\n');
        throw Object.assign(new Error(`three.js vendor assets not reachable:\n${detail}`), {
          _stage: 'vendor-assets',
        });
      }
      return import('./renderers/globeFlight.js');
    })
    .then(mod => {
      if (!mod || state.disposed) return;
      host.classList.remove('viz-card-loading-3d');
      host.textContent = '';
      try {
        const fn = mod && (mod.default || mod);
        state.real = typeof fn === 'function' ? fn(host, viz) : null;
        if (!state.real) {
          throw new Error('globeFlight.js did not export a mount function');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[viz] globe-flight mount failed:', err);
        _renderGlobeFlightError(host, 'mount', err);
      }
      // Tell the rest of the UI (specifically, the render()-time thread-
      // anchor logic in app.js) that this viz just finished hydrating and
      // its height may have changed. app.js listens for this and re-applies
      // its pending scroll anchor so the user doesn't get yanked to a
      // different message as the 3D scene finally lays out.
      host.dispatchEvent(
        new CustomEvent('melo:viz:hydrated', { bubbles: true, detail: { renderer: 'globe-flight' } }),
      );
    })
    .catch(err => {
      if (state.disposed) return;
      // eslint-disable-next-line no-console
      console.warn('[viz] globe-flight lazy import failed:', err);
      const stage = (err && err._stage) || 'import';
      _renderGlobeFlightError(host, stage, err);
      host.dispatchEvent(
        new CustomEvent('melo:viz:hydrated', {
          bubbles: true,
          detail: { renderer: 'globe-flight', error: true },
        }),
      );
    });
  return {
    dispose() {
      state.disposed = true;
      if (state.real && typeof state.real.dispose === 'function') {
        try {
          state.real.dispose();
        } catch {
          /* swallow */
        }
      }
    },
  };
}

// Registry keyed by renderer name — maps to a mount function. Keep this
// in lockstep with the backend allow-list in src/services/viz/vizSpec.js.
const RENDERERS = {
  // Physics / mechanics.
  projectile: mountProjectile,
  pendulum: mountPendulum,
  spring: mountSpring,
  wave: mountWave,
  // Electronics.
  'circuit-rc': mountCircuitRc,
  'circuit-ohm': mountCircuitOhm,
  // Math / geometry.
  'function-plot': mountFunctionPlot,
  'vector-field': mountVectorField,
  geometry: mountGeometry,
  // Chemistry.
  molecule: mountMolecule,
  'reaction-energy': mountReactionEnergy,
  // Diagrams.
  tree: mountTree,
  flowchart: mountFlowchart,
  timeline: mountTimeline,
  // 3D interactive scenes — drag to rotate, scroll to zoom, animated.
  // LAZY — the actual renderer module is only imported on first mount.
  'globe-flight': mountGlobeFlightLazy,
};

const instanceById = new Map();

function hashSignature(obj) {
  const json = safeStableStringify(obj);
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash) ^ json.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function safeStableStringify(value) {
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    return String(value);
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(value[k]);
        return acc;
      }, {});
  }
  return value;
}

export function computeVizSignature(viz) {
  if (!viz || typeof viz !== 'object') return '';
  return hashSignature(viz);
}

// Renderer families — used by CSS to reserve layout space BEFORE the mount
// function runs. Without this, a scene3d renderer pops from 0 to ~400px
// when it hydrates a tick later, which in a scrollable chat manifests as
// "scroll jumps back up to the height of the previous viz". Pre-reserving
// the slot keeps layout stable across the hydration microtask.
const SCENE3D_RENDERERS = new Set(['globe-flight']);

function rendererFamily(rendererName) {
  if (SCENE3D_RENDERERS.has(rendererName)) return 'scene3d';
  return 'flat';
}

export function renderVizMountHtml(messageId, viz) {
  if (!viz || !viz.renderer || !RENDERERS[viz.renderer]) return '';
  const signature = computeVizSignature(viz);
  const safeId = String(messageId || '').replace(/"/g, '');
  const safeRenderer = String(viz.renderer).replace(/[^a-z0-9-]/gi, '');
  const family = rendererFamily(viz.renderer);
  return `
    <div
      class="viz-mount"
      data-viz-mount
      data-message-id="${safeId}"
      data-viz-signature="${signature}"
      data-renderer="${safeRenderer}"
      data-renderer-family="${family}"
    ></div>
  `;
}

// Call this AFTER render() has written new HTML into the DOM. `specsById`
// is a Map or plain object mapping message id -> viz spec.
export function mountVizBlocks(rootEl, specsById) {
  if (!rootEl) return;
  const mounts = rootEl.querySelectorAll('.viz-mount[data-viz-mount]');
  const seen = new Set();

  mounts.forEach(host => {
    const messageId = host.dataset.messageId;
    const signature = host.dataset.vizSignature;
    if (!messageId || !signature) return;
    seen.add(messageId);

    const viz = getSpec(specsById, messageId);
    if (!viz) return;
    const renderer = RENDERERS[viz.renderer];
    if (!renderer) return;

    const existing = instanceById.get(messageId);
    if (existing && existing.signature === signature && existing.host === host) {
      // Same host + same signature → DOM wasn't torn down since last mount.
      // This path is rare because the top-level render() replaces innerHTML,
      // but it covers the partial-update path.
      return;
    }

    if (existing && existing.handle && typeof existing.handle.dispose === 'function') {
      try {
        existing.handle.dispose();
      } catch {
        /* renderer failed to dispose — keep going, we're remounting anyway */
      }
    }

    try {
      const handle = renderer(host, viz) || null;
      instanceById.set(messageId, { signature, host, handle });
    } catch (err) {
      // Never let a renderer bug take down the surrounding chat UI.
      // eslint-disable-next-line no-console
      console.warn('[viz] renderer failed:', err);
      host.classList.add('viz-card', 'viz-card-error');
      host.textContent = 'Visualization failed to load.';
    }
  });

  // GC entries whose mounts are gone (e.g. message deleted, switched chat).
  instanceById.forEach((entry, id) => {
    if (seen.has(id)) return;
    if (entry.handle && typeof entry.handle.dispose === 'function') {
      try {
        entry.handle.dispose();
      } catch {
        /* no-op */
      }
    }
    instanceById.delete(id);
  });
}

function getSpec(specsById, id) {
  if (!specsById) return null;
  if (specsById instanceof Map) return specsById.get(id) || null;
  return specsById[id] || null;
}

// Export the supported renderer set for UI code (e.g. the settings panel)
// that wants to know what Demon can currently render.
export function listSupportedRenderers() {
  return Object.keys(RENDERERS);
}
