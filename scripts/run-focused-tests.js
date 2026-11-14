// The focused `npm run test:*` commands:
//   node scripts/run-focused-tests.js <test files or globs…>
//   node scripts/run-focused-tests.js --list <test files or globs…>
//
// They used to be bare `node --test …`. A bare run uses whatever MELO_HOME the
// shell carries: twice (2026-11-07, 2026-11-10) one wrote fixtures into the
// real data directory and removed every conversation. A guard was added after
// that. What stayed is that these commands went around the gate: no pool, no
// per-file timeout, no order by cost, and nothing noticed when a file they
// named was deleted (two of them named such files on 2026-11-14).
//
// Now each command runs its files through the gate's own pool
// (scripts/run-test-pool.js) in a Melo home made for the run and removed after
// it. A pattern that matches no file is an error.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.tmp']);
const HAS_WILDCARD = /[*?]/;
const posix = path => path.split(sep).join('/');

// `**/` any number of directories, `*` and `?` inside one path segment.
function patternToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { source += '(?:[^/]+/)*'; i += 2; } else { source += '.*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

async function walk(directory, visit) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name), visit); }
    else if (entry.isFile()) visit(join(directory, entry.name));
  }
}

// Absolute paths of the files one pattern names.
async function matchesOf(pattern, root) {
  if (!HAS_WILDCARD.test(pattern)) {
    const path = resolve(root, pattern);
    return await stat(path).then(info => info.isFile(), () => false) ? [path] : [];
  }
  const absolute = posix(resolve(root, pattern));
  const fixed = absolute.slice(0, absolute.search(HAS_WILDCARD)).replace(/[^/]*$/, '');
  const matcher = patternToRegExp(absolute), matches = [];
  await walk(resolve(fixed), path => { if (matcher.test(posix(path))) matches.push(path); });
  return matches;
}

/**
 * The files the patterns name: sorted, each once, relative to `root` when
 * they are inside it. Throws when a pattern matches nothing.
 */
export async function expandPatterns(patterns, root = process.cwd()) {
  const found = new Set(), empty = [];
  for (const pattern of patterns) {
    const matches = await matchesOf(pattern, root);
    if (!matches.length) empty.push(pattern);
    for (const path of matches) {
      const inside = relative(root, path);
      found.add(inside && !inside.startsWith('..') && !isAbsolute(inside) ? posix(inside) : path);
    }
  }
  if (empty.length) throw new Error(`No test file matches: ${empty.join(', ')}`);
  return [...found].sort();
}

async function main(argv) {
  const list = argv.includes('--list');
  const patterns = argv.filter(value => value !== '--list');
  if (!patterns.length || patterns.some(value => value.startsWith('--'))) throw new Error('Usage: run-focused-tests.js [--list] <test files or globs…>');
  const files = await expandPatterns(patterns);
  if (list) { console.log(JSON.stringify(files, null, 2)); return 0; }
  const capturedEnv = { ...process.env };
  const pool = fileURLToPath(new URL('./run-test-pool.js', import.meta.url));
  const home = await mkdtemp(join(tmpdir(), 'melo-focused-tests-'));
  try {
    console.log(`Running ${files.length} test file(s) in an isolated Melo home`);
    const child = spawn(process.execPath, [pool, ...files], { stdio: 'inherit', env: { ...capturedEnv, MELO_HOME: home, MELO_TEST_MODE: '1' } });
    return await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', code => accept(code ?? 1)); });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}
