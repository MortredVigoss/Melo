// Command line for the weighted test pool: `node scripts/run-test-pool.js <test files…>`.
// Prints every file's TAP output, one `# file-time` line per file and the summed
// counts; exits 1 when any file failed. Durations of an earlier run, when the
// gate saved them, only decide the order.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runTestPool } from './test-pool.js';

const root = process.cwd(), env = { ...process.env };
const files = process.argv.slice(2);
if (!files.length || files.some(file => file.startsWith('--'))) throw new Error('Usage: run-test-pool.js <test files…>');
// Compiled code of unchanged modules is reused between the hundreds of test
// processes; the cache is keyed by content, so an edited file is compiled again.
if (!env.NODE_COMPILE_CACHE && env.MELO_TEST_NO_COMPILE_CACHE !== '1') env.NODE_COMPILE_CACHE = resolve(root, '.tmp/node-compile-cache');
const times = await readFile(resolve(root, '.tmp/test-runs/file-times.json'), 'utf8').then(JSON.parse, () => ({}));
const { code } = await runTestPool({ root, files, env, times });
process.exitCode = code;
