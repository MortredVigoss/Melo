import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { signWorkspaceFileUrl } from '../web/urlSigning.js';

export async function saveImageArtifact(workspacePath, buffer, { prefix = 'image', signal } = {}) {
  signal?.throwIfAborted();
  const directory = join(workspacePath, 'generated');
  const png = await sharp(buffer, { limitInputPixels: 80_000_000 }).png().toBuffer();
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${prefix}-${randomUUID()}.png`);
  await writeFile(path, png, { mode: 0o600 });
  return { path, url: signWorkspaceFileUrl(path), buffer: png };
}
