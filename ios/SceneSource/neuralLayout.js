// The native navigation owns layout. The desktop renderer owns all topology/motion.
export const moduleIDs = [1, 4, 2, 5, 3];
export function mobileNetwork(value, width, height) {
  const compact = !!value.compact;
  const frames = value.frames || {};
  const valid = moduleIDs.every(id => {
    const f = frames[id];
    return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0 &&
      f.x >= 0 && f.y >= 0 && f.x + f.width <= width + 1 && f.y + f.height <= height + 1 &&
      (compact ? f.height <= 32 : f.height >= 48);
  });
  const active = moduleIDs.indexOf(value.selected);
  const hover = moduleIDs.indexOf(value.hover);
  return {
    ports: valid ? moduleIDs.map(id => [frames[id].x + frames[id].width / 2, frames[id].y + frames[id].height / 2]) : [],
    portRadii: valid ? moduleIDs.map(id => Math.min(frames[id].width, frames[id].height) * .48 * (compact && id === (hover >= 0 ? value.hover : value.selected) ? 1.04 : 1)) : [],
    core: compact ? [width - 54, 44] : [width * .48, height * .44],
    active, focus: hover >= 0 ? hover : compact ? active : -1, hoverFocus: hover,
    working: !!value.transmitting, busy: !!value.transmitting,
    stationaryNavigation: compact,
    stage: compact ? 'detail' : 'overview', permission: false, flight: false,
    routes: [], output: null, branch: '',
  };
}
