import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Bound diagnostic logs without truncating or deleting existing evidence.
// This helper is never used for memory diaries or user-authored files.
export function appendBoundedLog(filePath, text, { maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const payload = String(text);
    let size = 0;
    try {
      const info = lstatSync(filePath);
      if (!info.isFile()) return false;
      size = info.size;
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    if (size + Buffer.byteLength(payload) > maxBytes) return false;
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, payload, 'utf8');
    return true;
  } catch { return false; }
}
