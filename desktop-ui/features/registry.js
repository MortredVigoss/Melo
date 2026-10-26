// Feature action registry (architecture plan §3.2 / P2, 2026-10-19).
//
// desktop-ui/app.js keeps one click switch and one submit switch for shell
// actions. A feature module registers its `data-action` (click) and
// `data-form` (submit) names here instead of adding `case` branches; app.js
// asks the registry first, inside the same try/catch, so errors still reach
// notify and form edit tickets still finish. Names stay exactly as
// rendered in the DOM. Registering a name twice is a programming error.
//
// Callers check has() synchronously and await dispatch() only for a
// registered name. An unconditional `await dispatch()` would defer every
// shell action by a microtask — past the submit listener's queued render(),
// so the Agent form was read after it had been rebuilt (caught by
// agentSettings.browser.test.js).
export function createActionRegistry(kind = 'action') {
  const handlers = new Map();
  return {
    register(table, owner = 'feature') {
      for (const [name, handler] of Object.entries(table)) {
        if (typeof handler !== 'function') throw new TypeError(`${kind} "${name}" (${owner}) needs a handler function`);
        if (handlers.has(name)) throw new Error(`${kind} "${name}" is already registered by ${handlers.get(name).owner}`);
        handlers.set(name, { handler, owner });
      }
    },
    has: name => handlers.has(name),
    names: () => [...handlers.keys()],
    owner: name => handlers.get(name)?.owner || null,
    // Resolves true when a feature handled `name`; false lets the caller fall
    // through to its own switch.
    async dispatch(name, payload) {
      const entry = handlers.get(name);
      if (!entry) return false;
      await entry.handler(payload);
      return true;
    },
  };
}
