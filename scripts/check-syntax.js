import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = process.cwd();
const TARGET_DIRS = ['src', 'scripts', 'desktop-ui'];

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

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const allFiles = [];

  for (const targetDir of TARGET_DIRS) {
    allFiles.push(...(await collectJavaScriptFiles(join(ROOT, targetDir))));
  }

  allFiles.sort();

  for (const filePath of allFiles) {
    const displayPath = relative(ROOT, filePath) || filePath;
    process.stdout.write(`Checking ${displayPath}\n`);
    await run(process.execPath, ['--check', filePath]);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stderr || error.stdout || error.message}\n`);
  process.exit(1);
});
