import { execFileSync } from 'node:child_process';

// Scope by verified boundaries, not a speculative JS import graph: server
// registration, generated assets and source-reading tests have implicit edges.
export function planTests(changed, files) {
  const paths = [...new Set(changed)].sort();
  const docsOnly = path => /^docs\/.*\.md$/.test(path) || ['README.md','PROGRESS.md','CLAUDE.md','EVALUATION.md','MELO_OVERVIEW.md'].includes(path);
  const code = paths.filter(path => !docsOnly(path));
  const testsOnly = code.length > 0 && code.every(path => path.endsWith('.test.js'));
  const ui = code.some(path => path.startsWith('desktop-ui/'));
  const ios = code.some(path => path.startsWith('ios/'));
  const android = code.some(path => /^(android\/|scripts\/android(?:\.mjs|-target(?:\.test)?\.js)$|shared\/protocol\/|ios\/Melo\/Scene\/|\.github\/workflows\/android\.yml$)/.test(path));
  const scoped = code.every(path => /^(desktop-ui|ios\/(Melo|Tests)|android)\//.test(path));
  const fullUnit = code.length > 0 && !testsOnly && !scoped;
  const selected = fullUnit ? files : testsOnly ? files.filter(path => code.includes(path)) :
    files.filter(path => ui && path.startsWith('desktop-ui/') || (ui || ios) && path.startsWith('ios/Tests/'));
  // A deleted/renamed test must not turn a test-only change into a green no-op.
  const deletedTest = testsOnly && code.some(path => !files.includes(path));
  return {
    changed: paths,
    files: deletedTest ? files : selected,
    fullUnit: fullUnit || deletedTest,
    reason: deletedTest ? '测试删除或发现规则变化，回退全部 JS 测试' : fullUnit ? '涉及后端、协议或构建边界，运行全部 JS 测试' : testsOnly ? '仅测试文件变化，运行改动的测试' : code.length ? '界面 / iOS 边界，运行整个相关测试组' : '仅文档变化，无运行时代码改动',
    browsers: !testsOnly && (fullUnit || ui),
    ios: !testsOnly && (fullUnit || ui || ios),
    swift: !testsOnly && (fullUnit || ios),
    android,
    syntax: fullUnit ? null : code.filter(path => /\.[cm]?js$/.test(path) && !path.endsWith('.test.js')),
  };
}

export function changedPaths(root, base) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe']});
  const split = text => text.split('\0').filter(Boolean);
  const untracked = split(git(['ls-files', '--others', '--exclude-standard', '-z']));
  const pending = split(git(['diff', '--no-renames', '--name-only', '-z', base || 'HEAD', '--']));
  if (base || pending.length || untracked.length) return {base: base || 'HEAD (工作树)', paths: [...pending, ...untracked]};
  // A clean checkout still checks the latest commit rather than reporting zero.
  return {base: 'HEAD^ (最近提交)', paths: split(git(['diff', '--no-renames', '--name-only', '-z', 'HEAD^', 'HEAD', '--']))};
}

export function currentTestPlan(root, files, base) {
  try {
    const changes = changedPaths(root, base);
    return {...planTests(changes.paths, files), base: changes.base};
  } catch (error) {
    if (base) throw error; // A typo in an explicit base must not be ignored.
    return {...planTests(['package.json'], files), base: '无法确定 Git 范围', reason: 'Git 范围不可用，回退完整日常检查'};
  }
}
