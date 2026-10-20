import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { impactedPlan } from './test-impact.js';

// Explanation-only files registered one by one. 2026-10-19 (architecture plan
// P0) grep: no src/, desktop-ui/, desktop-app/, ios/Melo/, mobile-sync/ or
// build script reads, imports or bundles these paths. Markdown that runtime
// code or tests read (skills, personas, fixtures, anything bundled into an
// app) must never be added here; it stays a code change.
export const DOC_ONLY_FILES = Object.freeze(['README.md','PROGRESS.md','CLAUDE.md','EVALUATION.md','MELO_OVERVIEW.md','AGENTS.md','CHANGELOG.md','ios/README.md','ios/VERIFICATION.md','desktop-ui/features/README.md']);
export const isDocOnly = path => /^docs\/.*\.md$/.test(path) || /^docs\/handoffs\//.test(path) || DOC_ONLY_FILES.includes(path);

// The pure selection function also serves scope and fixture tests. Without a
// verified dependency context, runtime changes conservatively expand the gate.
export function planTests(changed, files, impact = null) {
  const paths = [...new Set(changed)].sort();
  const code = paths.filter(path => !isDocOnly(path));
  const testsOnly = code.length > 0 && code.every(path => path.endsWith('.test.js'));
  const deletedTest = testsOnly && code.some(path => !files.includes(path));
  const androidPath = path => /^(android\/|scripts\/android(?:\.mjs|-target(?:\.test)?\.js)$|\.github\/workflows\/android\.yml$)/.test(path);
  const android = code.some(path => androidPath(path) || /^(shared\/(agent|protocol)\/|ios\/Melo\/Scene\/|src\/shared\/(replyDocument|sessionEvents)\.js$)/.test(path));
  const androidOnly = code.length > 0 && code.every(androidPath);
  let plan;
  if (androidOnly) {
    plan = {files:files.filter(path => /^scripts\/android.*\.test\.js$/.test(path)), fullUnit:false, reason:'Android 本机 Gate 与构建脚本回归', reasons:[], browsers:false, ios:false, swift:false, renderer:false, swiftSuites:[], preflightTests:[]};
  } else if (!code.length) {
    plan = {files:[], fullUnit:false, reason:'仅文档变化，无运行时代码改动；只检查改动文档的相对链接', reasons:[], browsers:false, ios:false, swift:false, renderer:false, swiftSuites:[], preflightTests:[]};
  } else if (testsOnly && !deletedTest) {
    plan = {files:files.filter(path => code.includes(path)), fullUnit:false, reason:'仅测试文件变化，运行改动的测试', reasons:[], browsers:false, ios:false, swift:false, renderer:false, swiftSuites:[], preflightTests:[]};
  } else {
    plan = impactedPlan(code, files, impact);
  }
  return {...plan, android, changed:paths, docs:paths.filter(path=>isDocOnly(path)&&path.endsWith('.md')),
    syntax:plan.fullUnit ? null : code.filter(path=>/\.[cm]?js$/.test(path))};
}

export function changedPaths(root, base) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe']});
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(root)) throw Error('Test root is not the Git worktree root');
  const split = text => text.split('\0').filter(Boolean);
  const untracked = split(git(['ls-files', '--others', '--exclude-standard', '-z']));
  const pending = split(git(['diff', '--no-renames', '--name-only', '-z', base || 'HEAD', '--']));
  if (base || pending.length || untracked.length) return {base: base || 'HEAD (工作树)', paths: [...pending, ...untracked]};
  // A clean checkout still checks the latest commit rather than reporting zero.
  return {base: 'HEAD^ (最近提交)', paths: split(git(['diff', '--no-renames', '--name-only', '-z', 'HEAD^', 'HEAD', '--']))};
}

export function currentTestPlan(root, files, base, impact = null) {
  try {
    const changes = changedPaths(root, base);
    return {...planTests(changes.paths, files, impact), base: changes.base};
  } catch (error) {
    if (base) throw error; // A typo in an explicit base must not be ignored.
    return {...planTests(['package.json'], files), base: '无法确定 Git 范围', reason: 'Git 范围不可用，回退完整日常检查'};
  }
}
