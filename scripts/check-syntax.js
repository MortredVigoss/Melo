import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = process.cwd();
const TARGET_DIRS = ['src', 'scripts', 'desktop-ui', 'shared/agent'];

async function collectJavaScriptFiles(dirPath) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const allFiles = [];

  if (process.argv[2] === '--files') {
    for (const file of process.argv.slice(3)) {
      const path = join(ROOT, file);
      try { if ((await stat(path)).isFile()) allFiles.push(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else for (const targetDir of TARGET_DIRS) {
    allFiles.push(...(await collectJavaScriptFiles(join(ROOT, targetDir))));
  }

  allFiles.sort();

  let index = 0;
  const errors = [];
  async function worker() {
    while (index < allFiles.length) {
      const path = allFiles[index++];
      try { await run(process.execPath, ['--check', path]); }
      catch (error) { errors.push(`${relative(ROOT, path)}\n${error.stderr || error.message}`); }
    }
  }
  await Promise.all(Array.from({length: 4}, worker));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Syntax checked ${allFiles.length} files (4 workers)`);
}

main().catch(error => {
  process.stderr.write(`${error.stderr || error.stdout || error.message}\n`);
  process.exit(1);
});
