/**
 * knowledge tool
 *
 * Local document knowledge base with TF-IDF style search.
 * Index local files (txt, md, pdf, json, csv) into an in-memory searchable store.
 * No external APIs — pure local text matching with relevance scoring.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, extname, basename, relative } from 'node:path';

import { requestRead } from '../../safety/fileSafetyGate.js';
import { gatedReadIntoBuffer } from '../../safety/gatedRead.js';
import { classifyPath, PATH_CATEGORY } from '../../safety/sensitivePaths.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
const MAX_FILES = 500;
const MAX_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

// In-memory index: { chunks: [{ file, text, tokens }], idf: Map }
let _index = { chunks: [], idf: new Map(), indexed: 0, dirs: [] };

// ─── Tokenizer (CJK-aware) ──────────────────────────────────────────────────

function tokenize(text) {
  const lower = text.toLowerCase();
  // Split on whitespace/punctuation, keep CJK characters as individual tokens
  const words = lower.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]|[a-z0-9_]{2,}/g) || [];
  return words;
}

function computeTF(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [k, v] of tf) tf.set(k, v / tokens.length);
  return tf;
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkText(text, maxLen = MAX_CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxLen, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start + overlap >= text.length) break;
  }
  return chunks;
}

// ─── File reading ────────────────────────────────────────────────────────────

const SUPPORTED_EXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.js', '.ts', '.py', '.java', '.go', '.rs', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.sql', '.r', '.rb', '.php', '.swift', '.kt']);

// Phase 2C (2026-05-04): readTextFromBuffer dispatches by extension —
// pdf-parse takes a Buffer directly, text files just utf8-decode the
// buffer. Caller (indexDirectory) gets each file's bytes via the
// gate's atomicOpenLeaf path so no library re-opens by path.
async function readTextFromBuffer(buffer, ext) {
  if (ext === '.pdf') {
    try {
      const { default: pdfParse } = await import('pdf-parse');
      const data = await pdfParse(buffer);
      return String(data?.text || '').trim();
    } catch {
      return '';
    }
  }
  if (!SUPPORTED_EXT.has(ext)) return '';
  try {
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function isSensitiveSubtree(absPath) {
  const cat = classifyPath(absPath);
  return cat === PATH_CATEGORY.SYSTEM
      || cat === PATH_CATEGORY.CREDENTIAL
      || cat === PATH_CATEGORY.MELO_INTERNAL;
}

// Phase 2C (2026-05-04): walker also skips sensitive subtrees so
// indexing a benign base never silently slurps ~/.ssh into the
// in-memory index. We don't have a context here for filterSensitive
// tunneling, so the policy is "always skip" — if the user explicitly
// indexed a sensitive base they'd hit a sensitive-prompt loop anyway.
async function walkDir(dir, files = [], depth = 0, skipped = { sensitive: 0 }) {
  if (depth > 5 || files.length >= MAX_FILES) return files;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = resolve(dir, entry.name);
      if (isSensitiveSubtree(full)) {
        skipped.sensitive++;
        continue;
      }
      if (entry.isDirectory()) {
        await walkDir(full, files, depth + 1, skipped);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          if (s.size <= MAX_FILE_SIZE) files.push(full);
        } catch {}
      }
    }
  } catch {}
  return files;
}

// ─── Indexing ────────────────────────────────────────────────────────────────

async function indexDirectory(dir, ctx = {}) {
  const absDir = resolve(dir);

  // Phase 2C (2026-05-04): gate the base directory read. Workspace-
  // internal silent; outside-benign prompts once + grants dir scope
  // for the subtree (so per-file gatedReadIntoBuffer below stays
  // silent). Sensitive base prompts per-call (which is unusable for
  // a 500-file index, but that's the right behavior — user shouldn't
  // index ~/.ssh).
  try {
    await requestRead({
      path: absDir,
      chatId: ctx.chatId,
      sseEmitter: ctx.sseEmitter,
      signal: ctx.signal,
      workspacePath: ctx.workspacePath,
      baseDir: ctx.workspacePath,
    });
  } catch (err) {
    const denied = err?.code === 'FILE_SAFETY_DENIED';
    const e = new Error(err?.message || 'gate denied');
    e.code = denied ? 'DENIED' : 'GATE_ERROR';
    throw e;
  }

  const skipped = { sensitive: 0 };
  const files = await walkDir(absDir, [], 0, skipped);
  const chunks = [];

  for (const filePath of files) {
    // Phase 2C: each file read goes through the gate. The dir-grant
    // from the base approval makes this silent for the typical case
    // (workspace base or user-granted external dir).
    const gated = await gatedReadIntoBuffer(filePath, ctx, {
      maxBytes: MAX_FILE_SIZE,
      toolName: 'knowledge:index',
    });
    if (!gated.ok) continue;  // skip files that the gate denied / can't read

    const ext = extname(filePath).toLowerCase();
    const text = await readTextFromBuffer(gated.buffer, ext);
    if (!text || text.length < 20) continue;
    const textChunks = chunkText(text);
    for (const chunk of textChunks) {
      const tokens = tokenize(chunk);
      if (tokens.length < 3) continue;
      chunks.push({
        file: relative(absDir, filePath) || basename(filePath),
        absPath: filePath,
        text: chunk,
        tokens,
        tf: computeTF(tokens),
      });
    }
  }

  // Compute IDF
  const idf = new Map();
  const N = chunks.length || 1;
  const docFreq = new Map();
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens);
    for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(N / df));
  }

  _index = { chunks, idf, indexed: files.length, dirs: [absDir] };
  return { files: files.length, chunks: chunks.length, skippedSensitive: skipped.sensitive };
}

// ─── Search ──────────────────────────────────────────────────────────────────

function search(query, topK = 5) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !_index.chunks.length) return [];

  const scored = _index.chunks.map(chunk => {
    let score = 0;
    for (const qt of queryTokens) {
      const tf = chunk.tf.get(qt) || 0;
      const idf = _index.idf.get(qt) || 0;
      score += tf * idf;
    }
    return { ...chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0);
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const knowledgeTool = {
  id: 'knowledge',
  name: 'Knowledge',
  description:
    'Local document knowledge base. ' +
    'Index: scan a directory and build searchable index of text files (txt, md, pdf, json, code files). ' +
    'Search: find most relevant document chunks matching a query using TF-IDF scoring. ' +
    'Status: show current index stats.',
  category: 'utility',
  isConcurrencySafe: true,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['index', 'search', 'status'],
        description: '"index" to build/rebuild, "search" to query, "status" for stats.',
      },
      path: {
        type: 'string',
        description: 'For index: directory path to scan.',
      },
      query: {
        type: 'string',
        description: 'For search: the search query.',
      },
      top_k: {
        type: 'number',
        description: 'For search: max results to return (default: 5).',
      },
    },
    required: ['action'],
  },

  async run(args = {}, context = {}) {
    const { action, path, query, top_k = 5 } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;
    if (action === 'index') {
      if (!path) return { ok: false, output: 'Missing "path" (directory to index).', error: 'INVALID_PARAMS' };
      try {
        const result = await indexDirectory(path, { workspacePath, sseEmitter, signal, chatId });
        const skipNote = result.skippedSensitive > 0
          ? ` (${result.skippedSensitive} sensitive subtree entries skipped)`
          : '';
        return {
          ok: true,
          output: `Indexed ${result.files} files → ${result.chunks} searchable chunks${skipNote}`,
          meta: result,
        };
      } catch (e) {
        return { ok: false, output: `Index failed: ${e.message}`, error: e.code || 'INDEX_FAILED' };
      }
    }

    if (action === 'search') {
      if (!query) return { ok: false, output: 'Missing "query".', error: 'INVALID_PARAMS' };
      if (!_index.chunks.length) {
        return { ok: false, output: 'No documents indexed yet. Run with action="index" first.', error: 'NO_INDEX' };
      }
      const results = search(query, top_k);
      if (!results.length) return { ok: true, output: 'No relevant results found.', meta: { count: 0 } };

      const formatted = results.map((r, i) => {
        const preview = r.text.slice(0, 300).replace(/\n+/g, ' ');
        return `**${i + 1}. ${r.file}** (score: ${r.score.toFixed(3)})\n${preview}${r.text.length > 300 ? '...' : ''}`;
      }).join('\n\n');
      return {
        ok: true,
        output: `Found ${results.length} results:\n\n${formatted}`,
        meta: { count: results.length, files: results.map(r => r.absPath) },
      };
    }

    if (action === 'status') {
      if (!_index.chunks.length) {
        return { ok: true, output: 'Knowledge base is empty. Use action="index" to scan a directory.' };
      }
      return {
        ok: true,
        output: `**Knowledge base:**\n- Directories: ${_index.dirs.join(', ')}\n- Files indexed: ${_index.indexed}\n- Chunks: ${_index.chunks.length}\n- Vocabulary: ${_index.idf.size} terms`,
        meta: { files: _index.indexed, chunks: _index.chunks.length, terms: _index.idf.size },
      };
    }

    return { ok: false, output: `Unknown action "${action}".`, error: 'INVALID_ACTION' };
  },
};
