import { createNeuralScene } from './desktop-ui/neuralScene3D.js';
import { mobileNetwork, moduleIDs } from './neuralLayout.js';

const host = document.getElementById('neural');
const post = value => window.__meloNeuralPost?.(value);
let payload = {}, scene, disposed = false, lastTap = null;
let core = null, compact = null, flight = null;
const network = () => {
  const value = mobileNetwork(payload, host.clientWidth, host.clientHeight);
  const next = !!payload.compact;
  if (compact !== next && core) flight = {from: core, start: performance.now()};
  compact = next;
  if (payload.still || matchMedia('(prefers-reduced-motion: reduce)').matches) flight = null;
  if (flight) {
    const t = Math.min(1, (performance.now() - flight.start) / 450);
    const ease = 1 - Math.pow(1-t,3);
    value.core = flight.from.map((p,i) => p + (value.core[i]-p)*ease);
    if (t === 1) flight = null;
  }
  core = value.core;
  return value;
};
window.meloNeuralReceive = value => {
  payload = value || {};
  scene?.setStill(!!payload.still);
  scene?.setRoutes([]);
  if (scene && payload.tap && payload.tap.id !== lastTap && !payload.compact) {
    lastTap = payload.tap.id;
    const index = scene.pickCore(payload.tap.x, payload.tap.y);
    if (index >= 0 && index < moduleIDs.length) post({ type: 'select', id: moduleIDs[index] });
  }
  host.dataset.layout = payload.compact ? 'compact' : 'overview';
  host.dataset.ports = JSON.stringify(network().ports);
};
window.meloNeuralDispose = () => { disposed = true; scene?.dispose(); };
window.addEventListener('pagehide', () => scene?.setStill(true));
window.addEventListener('pageshow', () => scene?.setStill(!!payload.still));
createNeuralScene(host).then(value => {
  if (disposed) { value.dispose(); return; }
  scene = value;
  scene.setRouteProvider(network);
  scene.setStill(!!payload.still);
  scene.setRoutes([]);
  post({ type: 'ready' });
  let attempts = 0;
  function verify() {
    if (disposed) return;
    const canvas = host.querySelector('canvas');
    if (canvas?.dataset.coreRegions && Number(canvas.dataset.connections) === 5) {
      post({ type: 'rendered', renderer: host.dataset.renderer, engine: canvas.dataset.engine || 'canvas' });
    } else if (++attempts < 120) requestAnimationFrame(verify);
    else post({ type: 'renderError' });
  }
  requestAnimationFrame(verify);
}).catch(() => post({ type: 'renderError' }));
