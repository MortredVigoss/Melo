/**
 * clipboard tool
 *
 * Read/write system clipboard via pbcopy/pbpaste (macOS).
 * Falls back to xclip/xsel on Linux.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CLIPBOARD = 100_000; // 100KB safety limit

function getPlatformCommands() {
  if (process.platform === 'darwin') {
    return { read: ['pbpaste', []], write: ['pbcopy', []] };
  }
  // Linux: try xclip first, then xsel
  return { read: ['xclip', ['-selection', 'clipboard', '-o']], write: ['xclip', ['-selection', 'clipboard']] };
}

async function readClipboard() {
  const { read } = getPlatformCommands();
  try {
    const { stdout } = await execFileAsync(read[0], read[1], { timeout: 5000, maxBuffer: MAX_CLIPBOARD });
    return stdout || '';
  } catch (err) {
    // Try xsel as fallback on Linux
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execFileAsync('xsel', ['--clipboard', '--output'], { timeout: 5000 });
        return stdout || '';
      } catch {}
    }
    throw new Error(`Cannot read clipboard: ${err.message}`);
  }
}

async function writeClipboard(text) {
  const { write } = getPlatformCommands();
  try {
    const child = require('node:child_process').spawn(write[0], write[1], { timeout: 5000 });
    child.stdin.write(text);
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
      child.on('error', reject);
    });
    return text.length;
  } catch (err) {
    throw new Error(`Cannot write clipboard: ${err.message}`);
  }
}

export const clipboardTool = {
  id: 'clipboard',
  name: 'Clipboard',
  description:
    'Read from or write to the system clipboard. ' +
    'Read: get current clipboard text content. ' +
    'Write: copy text to clipboard so user can paste it.',
  category: 'utility',
  isConcurrencySafe: false,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write'],
        description: '"read" to get clipboard content, "write" to set it.',
      },
      content: {
        type: 'string',
        description: 'For write: the text to copy to clipboard.',
      },
    },
    required: ['action'],
  },

  async run({ action, content }) {
    if (action === 'read') {
      try {
        const text = await readClipboard();
        if (!text) return { ok: true, output: '(clipboard is empty)', meta: { length: 0 } };
        const display = text.length > 2000 ? text.slice(0, 2000) + `\n...(truncated, total ${text.length} chars)` : text;
        return { ok: true, output: display, meta: { length: text.length } };
      } catch (e) {
        return { ok: false, output: e.message, error: 'READ_FAILED' };
      }
    }

    if (action === 'write') {
      if (!content) return { ok: false, output: 'Missing "content" for write.', error: 'INVALID_PARAMS' };
      if (content.length > MAX_CLIPBOARD) {
        return { ok: false, output: `Content too large (${content.length} chars, max ${MAX_CLIPBOARD})`, error: 'TOO_LARGE' };
      }
      try {
        const len = await writeClipboard(content);
        return { ok: true, output: `Copied to clipboard (${len} chars)`, meta: { length: len } };
      } catch (e) {
        return { ok: false, output: e.message, error: 'WRITE_FAILED' };
      }
    }

    return { ok: false, output: `Unknown action "${action}".`, error: 'INVALID_ACTION' };
  },
};
