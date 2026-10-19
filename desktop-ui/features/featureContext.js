// Narrow feature context (architecture plan §3.2, P2 2026-10-19).
//
// A feature module receives only the data accessors and callbacks it needs,
// by name; it never gets app.js's uiState. Shared page data (the bootstrap)
// is reached through read-only accessors such as getBootstrap() or
// activeProject(). features/README.md lists what each feature still shares.
export function checkFeatureContext(feature, context, required) {
  if (!context || typeof context !== 'object') throw new TypeError(`${feature}: a context object is required`);
  if (Object.hasOwn(context, 'uiState')) throw new TypeError(`${feature}: pass named accessors and callbacks, not uiState`);
  const missing = required.filter(name => context[name] === undefined);
  if (missing.length) throw new TypeError(`${feature}: missing context ${missing.join(', ')}`);
  return context;
}
