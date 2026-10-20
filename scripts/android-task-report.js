import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// AGP copies additional instrumentation outputs before uninstalling fixture APKs.
// A per-run ID excludes stale files from previous connected-test invocations.
export async function readAndroidTaskReport(root, evaluationId) {
  const found = [];
  async function visit(directory, depth = 0) {
    if (depth > 12) throw Error('Unexpected Android test output nesting.');
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, row.name);
      if (row.isDirectory()) await visit(path, depth + 1);
      else if (row.isFile() && row.name === 'agent-task-eval-android.json') {
        const text = await readFile(path, 'utf8');
        if (text.length > 2_000_000) throw Error('Oversized Android task evaluation report.');
        const report = JSON.parse(text);
        if (report.evaluationId === evaluationId) found.push(report);
      }
    }
  }
  await visit(root);
  if (found.length !== 1 || found[0].version !== 1 || found[0].host !== 'Android-JavaScriptSandbox' || found[0].report?.passed !== true) throw Error('A unique passing report from this emulator run is required.');
  return found[0];
}
