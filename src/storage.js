import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function atomicWriteJson(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await writeFile(tempPath, body, 'utf8');
  await rename(tempPath, filePath);
}
