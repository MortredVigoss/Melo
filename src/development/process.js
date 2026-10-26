import { spawn } from 'node:child_process';

export function command(file, args, { cwd, env, signal, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, onData } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Cancelled'));
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', bytes = 0, stopped = false, killTimer;
    const stop = () => {
      stopped = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { stop(); return; }
      output += chunk.toString();
      onData?.(chunk);
    };
    child.stdout.on('data', data); child.stderr.on('data', data);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => { cleanup(); resolve({ code, signal: exitSignal, output, stopped }); });
  });
}

export function requireSuccess(result) {
  if (result.code !== 0 || result.stopped) throw new Error(result.output.slice(-4000) || `Command failed (${result.code ?? result.signal})`);
  return result.output.trim();
}
