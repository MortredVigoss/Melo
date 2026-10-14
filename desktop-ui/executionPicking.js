import { Raycaster, Sphere, Vector2, Vector3 } from 'three';

// Pick the volume occupied by a neural cluster, including the gaps between its
// thin lines. Resolve overlapping regions by actual camera depth.
export function createExecutionPicker(camera, regions) {
  const raycaster = new Raycaster(), pointer = new Vector2(), sphere = new Sphere(), hit = new Vector3();
  return (x, y, width, height) => {
    if (!width || !height || x < 0 || y < 0 || x > width || y > height) return null;
    pointer.set(x / width * 2 - 1, 1 - y / height * 2);
    raycaster.setFromCamera(pointer, camera);
    let selected = null, nearest = Infinity;
    for (const region of regions) {
      if (region.visible && !region.visible()) continue;
      sphere.set(region.center, region.radius);
      if (!raycaster.ray.intersectSphere(sphere, hit)) continue;
      const distance = hit.distanceTo(raycaster.ray.origin);
      if (distance < nearest) { nearest = distance; selected = region.id; }
    }
    return selected;
  };
}

export function bindExecutionPicking(canvas, { pick, enabled, onSelect, onHover }) {
  let pressed = null;
  const regionAt = event => {
    if (!enabled()) return null;
    const bounds = canvas.getBoundingClientRect();
    return pick(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
  };
  const hover = id => { canvas.style.cursor = id ? 'pointer' : ''; onHover?.(id); };
  const move = event => {
    if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 6) pressed.moved = true;
    hover(regionAt(event));
  };
  const down = event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    pressed = { id: regionAt(event), x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: false };
  };
  const up = event => {
    const start = pressed; pressed = null;
    if (!start?.id || start.moved || event.button !== 0 || start.pointer !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6 && regionAt(event) === start.id) onSelect?.(start.id);
  };
  const cancel = () => { pressed = null; hover(null); };
  const bindings = [['pointermove', move], ['pointerdown', down], ['pointerup', up], ['pointerleave', cancel], ['pointercancel', cancel], ['wheel', cancel], ['gesturestart', cancel]];
  bindings.forEach(([name, fn]) => canvas.addEventListener(name, fn, { passive: true }));
  return () => { cancel(); bindings.forEach(([name, fn]) => canvas.removeEventListener(name, fn)); };
}
