/**
 * G-6 audit (2026-05-11): cross-MELO_HOME isolation for conversationIndex
 * FTS db handle.  conversationIndex.js opens the same `desktop/search.sqlite`
 * file webSearchTool's cache db opens (disjoint tables — `messages_fts` here
 * vs `web_search_cache` / `url_content_cache` there).  Pre-fix
 * `SEARCH_DB_PATH` was a module-load `const` so the path was frozen at
 * first import — multi-profile / per-test MELO_HOME switching would write
 * to the WRONG home file.
 *
 * Real-behavior assertions (lessons-learned #2):
 *   - `indexMessage` under home A lands rows in home A's db file
 *   - flip MELO_HOME to B → next `indexMessage` lands in B's db file
 *   - home A's file untouched (handle bounce ≠ delete)
 *   - `searchHistory` after flip queries home B's index (not home A's)
 *   - source-level guard against re-introducing module-load const
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  indexMessage,
  searchHistory,
  _resetConversationIndexForTests,
} from './conversationIndex.js';

let _homeA = null;
let _homeB = null;
let _prevHome;

test.beforeEach(() => {
  _prevHome = process.env.MELO_HOME;
  _homeA = mkdtempSync(join(tmpdir(), 'melo-ci-cross-A-'));
  _homeB = mkdtempSync(join(tmpdir(), 'melo-ci-cross-B-'));
  process.env.MELO_HOME = _homeA;
  _resetConversationIndexForTests();
});

test.afterEach(() => {
  _resetConversationIndexForTests();
  try { rmSync(_homeA, { recursive: true, force: true }); } catch {}
  try { rmSync(_homeB, { recursive: true, force: true }); } catch {}
  _homeA = null;
  _homeB = null;
  if (_prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = _prevHome;
});

test('indexMessage under home A lands in homeA/desktop/search.sqlite (not homeB)', () => {
  indexMessage('chat-A', 'Chat A', {
    id: 'msg-A-1',
    role: 'user',
    content: 'hello from home A',
    createdAt: '2026-05-11T00:00:00Z',
  });
  const pathA = join(_homeA, 'desktop', 'search.sqlite');
  const pathB = join(_homeB, 'desktop', 'search.sqlite');
  assert.ok(existsSync(pathA), `home A db must exist at ${pathA}`);
  assert.equal(existsSync(pathB), false, 'home B db must NOT exist before flip');

  // Sanity: searchHistory finds the row.
  const hits = searchHistory('hello', { limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, 'msg-A-1');
});

test('flip MELO_HOME to B → next indexMessage routes to homeB/desktop/search.sqlite (handle auto-reopens)', () => {
  // Use FULLY DISJOINT tokens between A and B payloads so an FTS query
  // for one token can't accidentally hit the other home's row.
  const aToken = `alphaToken${Date.now()}A`;
  const bToken = `betaToken${Date.now()}B`;

  // (1) Seed under A.
  indexMessage('chat-A', 'Chat A', {
    id: 'msg-A-only', role: 'user', content: aToken, createdAt: '2026-05-11T00:00:00Z',
  });
  assert.ok(existsSync(join(_homeA, 'desktop', 'search.sqlite')));

  // (2) Flip MELO_HOME to B.  No reset hook called — we're testing
  //     getDb's auto-reopen-on-path-change branch.
  process.env.MELO_HOME = _homeB;

  indexMessage('chat-B', 'Chat B', {
    id: 'msg-B-only', role: 'user', content: bToken, createdAt: '2026-05-11T00:00:00Z',
  });
  const pathB = join(_homeB, 'desktop', 'search.sqlite');
  assert.ok(existsSync(pathB), `after flip, home B db must exist at ${pathB}`);

  // (3) Home A's file untouched — handle bounce did not delete it.
  assert.ok(existsSync(join(_homeA, 'desktop', 'search.sqlite')),
    'home A db must remain — flip swaps handle, not wipes old file');

  // (4) searchHistory now queries home B's index — must find the B
  //     payload but NOT the A token (cross-home isolation honored).
  const hitsForB = searchHistory(bToken, { limit: 10 });
  assert.equal(hitsForB.length, 1);
  assert.equal(hitsForB[0].messageId, 'msg-B-only');

  const hitsForA = searchHistory(aToken, { limit: 10 });
  assert.equal(hitsForA.length, 0,
    `home B index should NOT see home A token "${aToken}" — that would be the §6 regression we are guarding`);
});

test('_resetConversationIndexForTests: idempotent + safe with no open handle', () => {
  assert.doesNotThrow(() => _resetConversationIndexForTests());
  assert.doesNotThrow(() => _resetConversationIndexForTests());
});

test('source-level guard: conversationIndex.js does NOT re-introduce module-load `const SEARCH_DB_PATH = join(getMeloHome()…)`', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname: pd } = await import('node:path');
  const here = pd(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'conversationIndex.js'), 'utf8');
  assert.equal(
    /const\s+SEARCH_DB_PATH\s*=\s*join\(\s*getMeloHome\(\)/.test(source),
    false,
    'SEARCH_DB_PATH must not be a module-load-time const (CLAUDE.md §6)',
  );
  // Should be a function instead.
  assert.match(
    source,
    /function\s+searchDbPath\s*\(\)\s*\{[\s\S]*?return\s+join\(\s*getMeloHome\(\)/,
    'searchDbPath should be a call-time function',
  );
});
