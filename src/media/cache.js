import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getMeloHome } from '../config.js';

const CACHE_DIR = join(getMeloHome(), 'media-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;

function cacheKeyToPath(key) {
  const hash = createHash('sha256').update(String(key || '')).digest('hex');
  return join(CACHE_DIR, hash.slice(0, 2), `${hash.slice(2)}.json`);
}

export async function getCachedExtraction(key) {
  try {
    const filePath = cacheKeyToPath(key);
    const details = await stat(filePath);
    if (Date.now() - details.mtimeMs > CACHE_TTL_MS) {
      return null;
    }

    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedExtraction(key, value) {
  try {
    const filePath = cacheKeyToPath(key);
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_CACHE_ENTRY_BYTES) {
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, payload, 'utf8');
  } catch {
    // Cache misses should not block chat flow.
  }
}
