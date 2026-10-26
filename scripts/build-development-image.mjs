import { mkdtemp, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { command, requireSuccess } from '../src/development/process.js';

const root = fileURLToPath(new URL('../', import.meta.url)), env = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), 'melo-development-image-'));
try {
  // Explicit allowlist: no .git, .tmp, account/config directory or host cache
  // can enter the Docker build context, even when building Melo itself.
  for (const file of ['package.json', 'package-lock.json', 'binding.gyp', 'native']) await cp(join(root, file), join(directory, file), { recursive: true });
  await cp(join(root, 'scripts/development.Dockerfile'), join(directory, 'Dockerfile'));
  requireSuccess(await command('docker', ['build', '--tag', 'melo-development:local', directory], { env, timeoutMs: 1800000, maxBytes: 16 * 1024 * 1024, onData: chunk => process.stdout.write(chunk) }));
} finally { await rm(directory, { recursive: true, force: true }); }
