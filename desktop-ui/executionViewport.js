export const OVERVIEW_ZOOM = 1;
export const DETAIL_ZOOM = 1.65;
export const MIN_ZOOM = .65;
export const MAX_ZOOM = 2.6;
export const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(value) ? value : OVERVIEW_ZOOM));
export const wideViewport = zoom => zoom < 1.22;

// At overview scale the camera fits every cluster, including its depth and halo.
// Pulling back from a selection also recenters, rather than leaving the other
// four clusters outside a camera still aimed at the selected module.
export function executionCameraFrame(definitions, aspect, focus, zoom = 1) {
  const tangent = Math.tan(46 * Math.PI / 360);
  const fit = Math.max(700, ...definitions.map(({ position: [x, y, z] }) =>
    z + Math.max((Math.abs(x) + 112) / (tangent * Math.max(.25, aspect) * .86), (Math.abs(y) + 112) / (tangent * .72))));
  const module = definitions.find(item => item.id === focus);
  const weight = module ? Math.max(0, Math.min(1, (zoom - 1) / (DETAIL_ZOOM - 1))) : 0;
  const aim = (module?.position || [0, 0, 0]).map(value => value * weight);
  return { aim, position: [aim[0], aim[1], aim[2] + fit / clampZoom(zoom)] };
}

// Bound to the scene only. Scrollable result/inspection surfaces and the rest
// of the chat retain their normal scrolling behavior.
export function bindExecutionZoom(stage, { getZoom, setZoom, overview }) {
  const excluded = target => target?.closest?.('.execution-inspector,.execution-candidates,.execution-search-trail,input,textarea,select,[contenteditable="true"]');
  let gestureBase = null;
  const wheel = event => {
    if (excluded(event.target) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const viewport = stage.closest('.execution-panel-viewport');
    // On result cards, ordinary scrolling reads an oversized scene. Pinching
    // and the open neural field still control the camera.
    if (!event.ctrlKey && event.target?.closest?.('.execution-source') && viewport?.scrollHeight > viewport?.clientHeight) return;
    event.preventDefault();
    if (gestureBase !== null) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight || 300 : 1;
    const delta = Math.max(-160, Math.min(160, event.deltaY * unit));
    setZoom(clampZoom(getZoom() * Math.exp(-delta * (event.ctrlKey ? .009 : .0025))));
  };
  const gestureStart = event => {
    if (excluded(event.target)) return;
    event.preventDefault(); gestureBase = getZoom();
  };
  const gestureChange = event => {
    if (gestureBase === null) return;
    event.preventDefault();
    if (Number.isFinite(event.scale) && event.scale > 0) setZoom(clampZoom(gestureBase * event.scale));
  };
  const gestureEnd = event => { if (gestureBase !== null) event.preventDefault(); gestureBase = null; };
  const key = event => {
    if (event.target !== stage || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['+', '=', '-', '_', '0', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '0' || event.key === 'Home') overview();
    else setZoom(clampZoom(getZoom() * (['+', '='].includes(event.key) ? 1.18 : 1 / 1.18)));
  };
  const bindings = [['wheel', wheel], ['gesturestart', gestureStart], ['gesturechange', gestureChange], ['gestureend', gestureEnd], ['keydown', key]];
  bindings.forEach(([name, fn]) => stage.addEventListener(name, fn, { passive: false }));
  return () => bindings.forEach(([name, fn]) => stage.removeEventListener(name, fn));
}
