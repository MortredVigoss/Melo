import { mkdir, appendFile, readFile, readdir, lstat, readlink, rename, rm, chmod, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { command, requireSuccess } from './process.js';
import { atomicJSON } from './store.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function commandArguments(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0') || arg.length > 16000)) throw new Error('Command must be an argument array');
  return [...value];
}
export function dockerArguments({ name, image, writable = true, uid = 1000, gid = 1000 }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^melo-dev-[a-f0-9-]+$/.test(name) || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) throw new Error('Invalid isolated runner binding');
  const setup = 'set -e; mkdir -p /tmp/home /tmp/melo-home; cd /workspace/source; '
    + 'if [ -d /workspace/repository.git ]; then git --git-dir=/workspace/repository.git config core.bare false; git --git-dir=/workspace/repository.git config core.worktree /workspace/source; printf "gitdir: /workspace/repository.git\\n" > .git; fi; '
    + 'for item in node_modules build; do if [ -d "/opt/melo/$item" ] && [ ! -e "$item" ]; then ln -s "/opt/melo/$item" "$item"; fi; done; exec "$@"';
  return ['create', '--name', name, '--label', 'melo.development=1', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--user', `${uid}:${gid}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777', '--mount', `type=volume,source=${name},target=/workspace${writable ? '' : ',readonly'}`, '--workdir', '/workspace', '--env', 'HOME=/tmp/home', '--env', 'MELO_HOME=/tmp/melo-home', '--env', 'MELO_TEST_MODE=1', '--env', 'MELO_TEST_CHROME=/usr/bin/chromium', '--env', 'CI=1', '--env', 'MELO_TEST_NESTED=1', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_CONFIG_GLOBAL=/dev/null', '--entrypoint', '/bin/sh', image, '-c', setup, '--'];
}
export async function validateWorkerTree(root) {
  let count = 0, bytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100000 || entry.name === '.git') throw new Error('Invalid worker output tree');
      const path = join(directory, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path), resolved = relative(root, resolve(directory, target));
        if (isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) throw new Error('Worker output contains an escaping symbolic link');
      } else if (info.isDirectory()) await visit(path);
      else if (info.isFile()) { bytes += info.size; if (bytes > 512 * 1024 * 1024) throw new Error('Worker output exceeds 512 MiB'); }
      else throw new Error('Worker output contains a special file');
    }
  }
  await visit(root);
}
export function createContainerRunner({ env, directory, executable = 'docker' }) {
  // Docker's host connection is used by the controller only, never mounted or
  // exposed to a worker. Inherit only transport selection, not API credentials.
  const hostEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].filter(key => env[key]).map(key => [key, env[key]]));
  const invoke = (args, options) => command(executable, args, { env: hostEnv, ...options });
  const absent = result => /No such (?:object|container|volume)/i.test(result.output);
  const ensureStopped = async name => {
    const found = await invoke(['inspect', '--format', '{{json .State}}', name]);
    if (found.code !== 0) { if (absent(found)) return; requireSuccess(found); }
    if (JSON.parse(found.output).Running) requireSuccess(await invoke(['kill', name]));
  };
  return {
    async image(reference = 'node:22-bookworm') {
      if (typeof reference !== 'string' || reference.startsWith('-') || reference.length > 250) throw new Error('Invalid container image');
      return requireSuccess(await invoke(['image', 'inspect', '--format', '{{.Id}}', reference]));
    },
    // Labels stamped by scripts/build-development-image.mjs; an image without
    // them (e.g. a plain node image) returns {} and the service records a warning.
    async labels(reference) {
      if (typeof reference !== 'string' || reference.startsWith('-') || reference.length > 250) throw new Error('Invalid container image');
      const raw = requireSuccess(await invoke(['image', 'inspect', '--format', '{{json .Config.Labels}}', reference]));
      const labels = raw && raw !== 'null' ? JSON.parse(raw) : {};
      return labels && typeof labels === 'object' ? labels : {};
    },
    async stop(name) {
      if (!/^melo-dev-[a-f0-9-]+$/.test(name)) throw new Error('Invalid container identity');
      // Killing the container terminates descendants even if the docker CLI
      // has disconnected. Never report cancellation based only on CLI exit.
      const removed = await invoke(['rm', '--force', name]);
      if (removed.code !== 0 && !absent(removed)) requireSuccess(removed);
      const remaining = await invoke(['container', 'inspect', name]);
      if (remaining.code === 0 || !absent(remaining)) throw new Error('Cannot confirm container cleanup');
      const volume = await invoke(['volume', 'rm', name]);
      if (volume.code !== 0 && !absent(volume)) requireSuccess(volume);
    },
    async run({ image, workspace, gitDir, argv, signal, timeoutMs = 600000, writable = true, onStart }) {
      argv = commandArguments(argv);
      const id = randomUUID(), name = `melo-dev-${id}`;
      const path = join(directory, 'runs');
      await mkdir(path, { recursive: true, mode: 0o700 });
      const logPath = join(path, `${id}.log`), receiptPath = join(path, `${id}.json`);
      const receipt = { id, name, argv, image, startedAt: new Date().toISOString(), status: 'starting' };
      await atomicJSON(receiptPath, receipt);
      if (signal?.aborted) throw signal.reason || new Error('Cancelled');
      let abortCleanup = Promise.resolve();
      const cancel = () => { abortCleanup = ensureStopped(name); abortCleanup.catch(() => {}); };
      let writes = Promise.resolve();
      try {
        await validateWorkerTree(workspace);
        requireSuccess(await invoke([...dockerArguments({ name, image, writable, uid: process.getuid?.() || 1000, gid: process.getgid?.() || 1000 }), ...argv]));
        // Transfer through the Docker API, not a host bind mount. This also
        // works when a remote/VM engine cannot see the controller's filesystem.
        requireSuccess(await invoke(['cp', '--archive', workspace, `${name}:/workspace/source`], { timeoutMs: 120000 }));
        if (gitDir) requireSuccess(await invoke(['cp', '--archive', gitDir, `${name}:/workspace/repository.git`], { timeoutMs: 120000 }));
        receipt.status = 'running'; await atomicJSON(receiptPath, receipt); await onStart?.(receipt);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) throw signal.reason || new Error('Cancelled');
        const result = await invoke(['start', '--attach', name], { signal, timeoutMs: Math.max(1000, Math.min(86400000, timeoutMs)), maxBytes: 5 * 1024 * 1024,
          onData: chunk => { writes = writes.then(() => appendFile(logPath, chunk, { mode: 0o600 })); writes.catch(() => {}); } });
        await writes;
        await abortCleanup;
        await ensureStopped(name);
        const exit = await invoke(['inspect', '--format', '{{json .State}}', name]);
        const state = exit.code === 0 ? JSON.parse(exit.output) : null;
        receipt.exitCode = state?.ExitCode ?? null;
        receipt.status = signal?.aborted ? 'cancelled' : result.stopped ? 'timed_out' : state?.Status === 'exited' && state.ExitCode === 0 ? 'passed' : 'failed';
        if (writable && state?.Status === 'exited' && !signal?.aborted && !result.stopped) {
          const stage = join(directory, `output-${id}`), previous = join(directory, `previous-${id}`);
          await mkdir(stage, { mode: 0o700 });
          // No running worker can race extraction. The destination is new and
          // empty; validate the whole tree before replacing candidate files.
          requireSuccess(await invoke(['cp', '--archive', `${name}:/workspace/source/.`, stage], { timeoutMs: 120000 }));
          if (gitDir) {
            const marker = await readFile(join(stage, '.git'), 'utf8');
            if (marker !== 'gitdir: /workspace/repository.git\n') throw new Error('Worker changed the managed Git binding');
            await unlink(join(stage, '.git'));
          }
          // These links refer to immutable dependencies inside the image,
          // never host paths. They are not candidate changes or exported data.
          for (const item of ['node_modules', 'build']) {
            const link = join(stage, item), target = await readlink(link).catch(() => null);
            if (target === `/opt/melo/${item}`) await unlink(link);
          }
          await validateWorkerTree(stage); await chmod(stage, 0o700);
          await rename(workspace, previous);
          try { await rename(stage, workspace); } catch (error) { await rename(previous, workspace); throw error; }
          await rm(previous, { recursive: true, force: true });
        }
      } catch (error) { receipt.status = signal?.aborted ? 'cancelled' : 'failed'; receipt.error = error.message; }
      finally {
        signal?.removeEventListener('abort', cancel);
        try { await abortCleanup; } catch (error) { receipt.cleanupWarning = error.message; }
        try { await this.stop(name); }
        catch (error) { receipt.status = 'cleanup_failed'; receipt.error = error.message; }
        await rm(join(directory, `output-${id}`), { recursive: true, force: true });
        receipt.finishedAt = new Date().toISOString();
        receipt.logHash = digest(await readFile(logPath).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }));
        await atomicJSON(receiptPath, receipt);
      }
      return receipt;
    },
  };
}
