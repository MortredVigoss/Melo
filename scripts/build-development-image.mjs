import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { command, requireSuccess } from '../src/development/process.js';

const root = fileURLToPath(new URL('../', import.meta.url)), env = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), 'melo-development-image-'));
try {
  // Explicit allowlist: no .git, .tmp, account/config directory or host cache
  // can enter the Docker build context, even when building Melo itself.
  for (const file of ['package.json', 'package-lock.json', 'binding.gyp', 'native']) await cp(join(root, file), join(directory, file), { recursive: true });
  await cp(join(root, 'scripts/development.Dockerfile'), join(directory, 'Dockerfile'));
  // The lock hash is stamped on the image so a job can refuse a baseline whose
  // dependencies differ from what `npm ci` froze here (review finding 2).
  const lockHash = createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex');
  requireSuccess(await command('docker', ['build', '--tag', 'melo-development:local', '--label', `melo.lock-sha256=${lockHash}`, directory], { env, timeoutMs: 1800000, maxBytes: 16 * 1024 * 1024, onData: chunk => process.stdout.write(chunk) }));
  console.log(`melo-development:local built with melo.lock-sha256=${lockHash}`);
} finally { await rm(directory, { recursive: true, force: true }); }
