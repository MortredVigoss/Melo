import { isAbsolute, resolve } from 'node:path';

export function sanitizeWorkspacePath(rawPath, fallbackRoot) {
  if (!rawPath || typeof rawPath !== 'string') {
    return fallbackRoot;
  }

  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(fallbackRoot, rawPath);
}

