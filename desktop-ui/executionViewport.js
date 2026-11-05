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

// Task-space views (plan C, 2026-11-05). `global` keeps the overview fit with
// an optional slow sway, `follow` chases one actor, `free` is user orbit. At
// yaw = pitch = 0 every mode reproduces executionCameraFrame exactly.
export const VIEW_MODES = Object.freeze(['global', 'follow', 'free']);
export const PITCH_LIMIT = Math.PI / 3;
export const ROTATE_STEP = Math.PI / 12;
export const FOLLOW_PITCH = .22;
export const clampPitch = value => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Number.isFinite(value) ? value : 0));
export const wrapYaw = value => { const y = Number.isFinite(value) ? value : 0; return ((y + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; };
export const viewMode = value => VIEW_MODES.includes(value) ? value : 'global';
// Unit vectors of a camera orbiting at (yaw, pitch): f points from the aim to
// the camera, r to screen right, u to screen up.
export function orbitBasis(yaw = 0, pitch = 0) {
  const p = clampPitch(pitch), f = [Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p)];
  const length = Math.hypot(f[2], f[0]) || 1, r = [f[2] / length, 0, -f[0] / length];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return { f, r, u };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// The same fit rule as executionCameraFrame, measured in the rotated camera
// space so every cluster and its halo stays in view from any angle.
export function orbitFit(definitions, aspect, yaw = 0, pitch = 0, aim = [0, 0, 0]) {
  const tangent = Math.tan(46 * Math.PI / 360), { f, r, u } = orbitBasis(yaw, pitch);
  return Math.max(700, ...definitions.map(({ position }) => {
    const p = [position[0] - aim[0], position[1] - aim[1], position[2] - aim[2]];
    return dot(p, f) + Math.max((Math.abs(dot(p, r)) + 112) / (tangent * Math.max(.25, aspect) * .86), (Math.abs(dot(p, u)) + 112) / (tangent * .72));
  }));
}
export function orbitPosition(aim, distance, yaw = 0, pitch = 0) {
  const { f } = orbitBasis(yaw, pitch);
  return [aim[0] + f[0] * distance, aim[1] + f[1] * distance, aim[2] + f[2] * distance];
}
// Detail cards sit on a plane facing the camera, so a zoomed-in focus always
// looks straight on and ignores rotation until the viewer pulls back.
export function executionViewFrame(definitions, aspect, { focus = null, zoom = 1, mode = 'global', yaw = 0, pitch = 0, follow = null } = {}) {
  const base = executionCameraFrame(definitions, aspect, focus, zoom);
  if (focus && !wideViewport(zoom)) return { ...base, yaw: 0, pitch: 0, locked: true };
  const z = clampZoom(zoom), p = clampPitch(pitch), y = wrapYaw(yaw);
  if (viewMode(mode) === 'follow' && Array.isArray(follow) && follow.every(Number.isFinite)) {
    const distance = Math.max(220, orbitFit(definitions, aspect, 0, 0) * .42) / z;
    return { aim: follow.slice(), position: orbitPosition(follow, distance, y, p), yaw: y, pitch: p, locked: false };
  }
  if (!y && !p) return { ...base, yaw: 0, pitch: 0, locked: false };
  // Same aim as the frontal frame; the fit is re-measured in the rotated basis.
  return { aim: base.aim, position: orbitPosition(base.aim, orbitFit(definitions, aspect, y, p, base.aim) / z, y, p), yaw: y, pitch: p, locked: false };
}
// Gentle sway for the global view; amplitude stays well inside the fit.
export const globalSway = seconds => ({ yaw: Math.sin(seconds * .055) * .38, pitch: Math.sin(seconds * .031) * .07 });

// Pointer orbit on the scene canvas. A drag past the threshold rotates and is
// reported so the panel can switch follow to free; a click below it is left
// to the picker. Touch keeps vertical page scroll (touch-action: pan-y).
export function bindExecutionOrbit(canvas, { enabled, onRotate, onDragStart, onDragEnd, threshold = 5 }) {
  let pressed = null;
  const down = event => {
    if (event.button !== 0 || event.isPrimary === false || !enabled()) return;
    pressed = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, pointer: event.pointerId, dragging: false };
  };
  const move = event => {
    if (!pressed || event.pointerId !== pressed.pointer) return;
    if (!pressed.dragging && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > threshold) {
      pressed.dragging = true; canvas.dataset.dragging = 'true';
      try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Capture is an enhancement only. */ }
      onDragStart?.();
    }
    if (!pressed.dragging) return;
    const width = canvas.clientWidth || 600, height = canvas.clientHeight || 400;
    onRotate?.(-(event.clientX - pressed.lastX) / width * Math.PI * .8, (event.clientY - pressed.lastY) / height * Math.PI * .6);
    pressed.lastX = event.clientX; pressed.lastY = event.clientY;
  };
  const end = event => {
    if (!pressed || event && event.pointerId !== undefined && event.pointerId !== pressed.pointer) return;
    const dragged = pressed.dragging; pressed = null; delete canvas.dataset.dragging;
    if (dragged) onDragEnd?.();
  };
  const bindings = [['pointerdown', down], ['pointermove', move], ['pointerup', end], ['pointercancel', end], ['lostpointercapture', end]];
  bindings.forEach(([name, fn]) => canvas.addEventListener(name, fn, { passive: true }));
  canvas.style.touchAction = 'pan-y';
  return () => { bindings.forEach(([name, fn]) => canvas.removeEventListener(name, fn)); };
}

// Bound to the scene only. Scrollable result/inspection surfaces and the rest
// of the chat retain their normal scrolling behavior.
export function bindExecutionZoom(stage, { getZoom, setZoom, overview, rotate = null }) {
  const excluded = target => target?.closest?.('.execution-inspector,.execution-candidates,.execution-search-trail,.execution-reasoning-records,.execution-outcomes,input,textarea,select,[contenteditable="true"]');
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
    // Arrow keys orbit when the panel allows rotation (not in a locked detail).
    const arrow = { ArrowLeft: [-ROTATE_STEP, 0], ArrowRight: [ROTATE_STEP, 0], ArrowUp: [0, ROTATE_STEP], ArrowDown: [0, -ROTATE_STEP] }[event.key];
    if (arrow && rotate && rotate(arrow[0], arrow[1]) !== false) { event.preventDefault(); return; }
    if (!['+', '=', '-', '_', '0', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '0' || event.key === 'Home') overview();
    else setZoom(clampZoom(getZoom() * (['+', '='].includes(event.key) ? 1.18 : 1 / 1.18)));
  };
  const bindings = [['wheel', wheel], ['gesturestart', gestureStart], ['gesturechange', gestureChange], ['gestureend', gestureEnd], ['keydown', key]];
  bindings.forEach(([name, fn]) => stage.addEventListener(name, fn, { passive: false }));
  return () => bindings.forEach(([name, fn]) => stage.removeEventListener(name, fn));
}
