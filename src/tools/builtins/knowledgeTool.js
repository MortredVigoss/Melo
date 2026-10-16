/**
 * knowledge tool
 *
 * Local document knowledge base with TF-IDF style search.
 * Index local files (txt, md, pdf, json, csv) into an in-memory searchable store.
 * No external APIs — pure local text matching with relevance scoring.
 */

import { resolve, extname, basename, relative, join } from 'node:path';
import { fstatSync, readSync } from 'node:fs';

import { AsyncLocalStorage } from 'node:async_hooks';
import { getMeloHome } from '../../config.js';
import { loadState } from '../../state/stateStore.js';
import { selectedKnowledge } from '../../services/chat/knowledgeContext.js';
import { searchKnowledge,pruneKnowledgeIndex,indexKnowledgeDocuments,warmKnowledgeIndex } from '../../memory/knowledgeIndex.js';
import { requestRead } from '../../safety/fileSafetyGate.js';
import { classifyPath, PATH_CATEGORY } from '../../safety/sensitivePaths.js';
import {
  openParentDirFd,
  atomicOpenLeaf,
  splitParentLeaf,
  _raw as dirfdRaw,
  C as DC,
} from '../../safety/dirfdOps.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
const MAX_FILES = 500;
const MAX_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

// In-memory index: { chunks: [{ file, text, tokens }], idf: Map }
const indexes=new Map(), activeIndex=new AsyncLocalStorage();
const emptyIndex=()=>({chunks:[],idf:new Map(),indexed:0,dirs:[],documents:[]});
function scope(context){return JSON.stringify([context.meloHome,context.chatId||'',context.workspacePath||'']);}

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

// Phase 2C follow-up #2 (2026-05-04): dirfd-bound walker. Mirrors
// glob/grep — base requestRead is the single approval gate; subtree
// walk uses readdirAt + openat-children so no path-swap can escape
// the approved subtree. Per-file reads use atomicOpenLeaf directly
// (no per-file prompt — would be 500x unusable for index).
async function walkDirfdCollect(parentFd, parentRelDir, baseDir, files, depth, maxFiles, skipped) {
  if (depth > 5 || files.length >= maxFiles) return;
  let entries;
  try { entries = dirfdRaw.readdirAt(parentFd); }
  catch { return; }
  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = parentRelDir
      ? join(baseDir, parentRelDir, entry.name)
      : join(baseDir, entry.name);
    if (isSensitiveSubtree(full)) {
      skipped.sensitive++;
      continue;
    }
    let kind = entry.kind;
    if (kind === 'unknown') {
      try {
        const st = dirfdRaw.fstatat(parentFd, entry.name, DC.AT_SYMLINK_NOFOLLOW);
        if (st.isDir) kind = 'dir';
        else if (st.isFile) kind = 'file';
        else kind = 'other';
      } catch { continue; }
    }
    const relPath = parentRelDir ? `${parentRelDir}/${entry.name}` : entry.name;
    if (kind === 'dir') {
      let childFd = -1;
      try {
        childFd = dirfdRaw.openat(parentFd, entry.name, DC.O_RDONLY | DC.O_DIRECTORY | DC.O_NOFOLLOW);
      } catch { continue; }
      try { await walkDirfdCollect(childFd, relPath, baseDir, files, depth + 1, maxFiles, skipped); }
      finally { try { dirfdRaw.closeFd(childFd); } catch {} }
    } else if (kind === 'file') {
      // Defer size check to the per-file open — the walker stays
      // dirfd-only.
      files.push(full);
    }
  }
}

function readBufferFromFd(fd, maxBytes) {
  const st = fstatSync(fd);
  if (st.size > maxBytes) return null;
  if (st.size === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(st.size);
  let total = 0;
  while (total < st.size) {
    const n = readSync(fd, buf, total, st.size - total, total);
    if (n === 0) break;
    total += n;
  }
  return buf.subarray(0, total);
}

async function readFileSafe(absPath, maxBytes) {
  // atomicOpenLeaf with O_NONBLOCK guards against FIFO/special leaves.
  // The walker already filtered sensitive subtrees + dir entries, so
  // this only sees regular-file paths the user's base approval covers.
  const [parent, leaf] = splitParentLeaf(absPath);
  let openLeaf;
  try { openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY | DC.O_NONBLOCK); }
  catch { return null; }
  try {
    if ((openLeaf.leafStat.mode & 0o170000) !== 0o100000) return null;
    return readBufferFromFd(openLeaf.leafFd, maxBytes);
  } finally { openLeaf.closeLeaf(); }
}

// ─── Indexing ────────────────────────────────────────────────────────────────

async function indexDirectory(dir, ctx = {}) {
  const absDir = resolve(dir);

  // Phase 2C follow-up #2 (2026-05-04, post-Codex 🟡): a single
  // base-dir requestRead is the entire approval gate for an index
  // op. Workspace-internal silent; outside-benign prompts once;
  // sensitive prompts per-call (and would loop — by design: user
  // shouldn't index ~/.ssh / $MELO_HOME).
  //
  // Subtree files DO NOT prompt individually — that would be 500
  // prompts for one index call, matching grep/glob's "single base
  // approval covers the walk" model. The walker is dirfd-bound
  // (readdirAt + openat children with O_DIRECTORY|O_NOFOLLOW), so
  // no path-swap can escape the approved subtree, and per-file
  // open uses atomicOpenLeaf with O_NOFOLLOW + O_NONBLOCK +
  // S_ISREG so a leaf swapped to symlink/FIFO is silently skipped.
  let approvedReal;
  try {
    // Phase 2C follow-up #4 (Codex 🟠): bypassGrants:true so the
    // gate's default 'dir' scope (which grants parentDir(realPath))
    // doesn't over-grant — index of /tmp/myproj must NOT silently
    // authorise reads of /tmp/sibling-dir/*. Every index call
    // re-prompts for non-workspace bases; workspace bases stay
    // silent (lexicalInWs && realInWs short-circuit fires before
    // bypassGrants is consulted).
    const r = await requestRead({
      path: absDir,
      chatId: ctx.chatId,
      sseEmitter: ctx.sseEmitter,
      signal: ctx.signal,
      workspacePath: ctx.workspacePath,
      baseDir: ctx.workspacePath,
      bypassGrants: true,
    });
    approvedReal = r.resolvedTarget;
  } catch (err) {
    const denied = err?.code === 'FILE_SAFETY_DENIED';
    const e = new Error(err?.message || 'gate denied');
    e.code = denied ? 'DENIED' : 'GATE_ERROR';
    throw e;
  }

  // Open the approved real base as a dirfd and walk via readdirAt.
  let baseFd;
  try { baseFd = openParentDirFd(approvedReal); }
  catch (err) {
    const e = new Error(`Cannot open approved base ${approvedReal}: ${err.message}`);
    e.code = err.code || 'INDEX_FAILED';
    throw e;
  }

  const skipped = { sensitive: 0 };
  const files = [];
  try {
    await walkDirfdCollect(baseFd, '', approvedReal, files, 0, MAX_FILES, skipped);
  } finally { try { dirfdRaw.closeFd(baseFd); } catch {} }

  const chunks = [], documents=[];let textBytes=0;
  for (const filePath of files) {
    const buffer = await readFileSafe(filePath, MAX_FILE_SIZE);
    if (!buffer) continue;  // skip oversize / non-regular / open-failed
    const ext = extname(filePath).toLowerCase();
    const text = await readTextFromBuffer(buffer, ext);
    if (!text || text.length < 20) continue;
    const size=Buffer.byteLength(text);if(textBytes+size>8*1024*1024)break;textBytes+=size;
    documents.push({id:filePath,title:relative(approvedReal,filePath)||basename(filePath),content:text});
    const textChunks = chunkText(text);
    for (const chunk of textChunks) {
      const tokens = tokenize(chunk);
      if (tokens.length < 3) continue;
      chunks.push({
        file: relative(approvedReal, filePath) || basename(filePath),
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

  const key=activeIndex.getStore();
  indexes.delete(key);indexes.set(key, { chunks, idf, indexed: documents.length, dirs: [approvedReal], documents });
  const home=JSON.parse(key)[0];
  indexKnowledgeDocuments({home,namespace:'files:'+key,documents,prune:true});
  void warmKnowledgeIndex({home,namespace:'files:'+key}).catch(()=>{});
  while(indexes.size>4){const oldest=indexes.keys().next().value;indexes.delete(oldest);pruneKnowledgeIndex({home:JSON.parse(oldest)[0],namespace:'files:'+oldest,keepIds:[]});}
  return { files: files.length, chunks: chunks.length, skippedSensitive: skipped.sensitive };
}

// ─── Search ──────────────────────────────────────────────────────────────────

function search(query, topK = 5) {
  const _index=indexes.get(activeIndex.getStore())||emptyIndex();
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
    'Search: find most relevant document chunks matching a query using scoped full-text and local vector retrieval. ' +
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
  examples: [
    { action: 'index', path: '~/Documents' },
    { action: 'search', query: 'expense reimbursement policy', top_k: 5 },
    { action: 'status' },
  ],

  async run(args = {}, context = {}) {
    const bound={...context,meloHome:context.meloHome||getMeloHome()};
    const key=scope(bound);
    return activeIndex.run(key,()=>runKnowledge(args,bound));
  },
};
async function runKnowledge(args = {}, context = {}) {
    const _index=context.capabilities?.readFiles===false?emptyIndex():indexes.get(activeIndex.getStore())||emptyIndex();
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
          output: `Indexed ${result.files} files → ${result.chunks} searchable chunks${skipNote}. Local index is limited to 500 files / 8 MiB of text per scope.`,
          meta: result,
        };
      } catch (e) {
        return { ok: false, output: `Index failed: ${e.message}`, error: e.code || 'INDEX_FAILED' };
      }
    }

    if (action === 'search') {
      if (!query) return { ok: false, output: 'Missing "query".', error: 'INVALID_PARAMS' };
      const state=await loadState({home:context.meloHome});
      const chat=state.chats?.find(c=>c.id===chatId);
      const saved=chat?selectedKnowledge(state,chat):[];
      const local=context.capabilities?.readFiles===false?[]:_index.documents;
      if (!local.length&&!saved.length) {
        return { ok: false, output: 'No documents indexed yet. Run with action="index" first.', error: 'NO_INDEX' };
      }
      const [fileRows,savedRows]=await Promise.all([
        searchKnowledge({home:context.meloHome,namespace:'files:'+activeIndex.getStore(),documents:local,query,limit:top_k,signal}),
        searchKnowledge({home:context.meloHome,documents:saved,query,limit:top_k,signal}),
      ]);
      const results=[...fileRows,...savedRows].sort((a,b)=>b.score-a.score).slice(0,Math.max(1,Math.min(20,top_k))).map(r=>({...r,file:r.title,absPath:r.documentId}));
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
}
