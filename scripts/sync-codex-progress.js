import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROGRESS_PATH = join(ROOT, 'PROGRESS.md');
const CODEX_PATH = join(ROOT, 'codex.md');

async function runGit(args) {
  try {
    const { stdout } = await execFile('git', args, { cwd: ROOT });
    return stdout.trim();
  } catch {
    return '';
  }
}

function bulletBlock(text, fallback = '- 无') {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return fallback;
  }

  return lines.map(line => `- ${line}`).join('\n');
}

function melbourneTimestamp() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

async function main() {
  const [progress, branch, status, commits] = await Promise.all([
    readFile(PROGRESS_PATH, 'utf8'),
    runGit(['branch', '--show-current']),
    runGit(['status', '--short', '--branch']),
    runGit(['log', '--oneline', '-8']),
  ]);

  const body = [
    '# Codex 进度快照',
    '',
    '> 本文件由 `npm run progress:codex` 自动生成，给 Claude / Codex 快速接续用。',
    '> 原始时间线仍以 `PROGRESS.md` 为准；需要更新进度时先写 `PROGRESS.md`，再同步本文件。',
    '',
    '## 当前状态',
    '',
    `- 更新时间：${melbourneTimestamp()} Australia/Melbourne`,
    `- 当前分支：${branch || 'unknown'}`,
    '',
    '## 工作区状态',
    '',
    '```text',
    status || 'No git status available.',
    '```',
    '',
    '## 最近提交',
    '',
    bulletBlock(commits, '- 暂无提交记录'),
    '',
    '## 完整进度时间线',
    '',
    progress.trimEnd(),
    '',
  ].join('\n');

  await writeFile(CODEX_PATH, `${body}\n`, 'utf8');
  process.stdout.write(`Synced ${CODEX_PATH}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
