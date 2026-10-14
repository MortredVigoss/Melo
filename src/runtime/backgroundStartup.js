// Optional runtime warm-up must not delay the HTTP listener or resurrect a
// stopped runtime after the user closes the app during initialization.
export function startBackgroundRuntime(start, { onReady = () => {}, onError = () => {} } = {}) {
  let stopped = false, runtime = null;
  const ready = Promise.resolve().then(start).then(value => {
    runtime = value;
    if (stopped) runtime?.stop?.();
    else onReady(runtime);
    return runtime;
  }).catch(error => { if (!stopped) onError(error); return null; });
  return { ready, stop() { stopped = true; runtime?.stop?.(); } };
}
