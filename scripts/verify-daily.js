import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRunnableTests } from './test-discovery.js';
import { currentTestPlan } from './test-plan.js';

const env = {...process.env};
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
if (baseIndex >= 0 && !args[baseIndex + 1]) throw new Error('--base requires a Git ref');
const {files, excluded} = await discoverRunnableTests();
const plan = currentTestPlan(process.cwd(), files, baseIndex >= 0 ? args[baseIndex + 1] : undefined);
console.log(`日常回归：${plan.files.length}/${files.length} 个 JS 测试文件；${plan.base}；${plan.reason}`);
if (args.includes('--plan')) {
  console.log(JSON.stringify({...plan, excluded}, null, 2));
} else {
  const home = await mkdtemp(join(tmpdir(), 'melo-daily-'));
  const started = Date.now();
  async function run(label, command, argv) {
    const start = Date.now();
    console.log(`▶ ${label}`);
    const child = spawn(command, argv, {stdio: 'inherit', env: {...env, MELO_HOME: home, MELO_TEST_MODE: '1'}});
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    if (code) throw new Error(`${label} failed (${code})`);
    console.log(`✓ ${label} ${(Date.now() - start) / 1000}s`);
  }
  try {
    for (const [path, entry] of Object.entries(excluded)) console.log(`QUARANTINED ${path}: ${entry.reason} (expires ${entry.expires})`);
    if (plan.files.length) await run('JS 回归', process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=120000', ...plan.files]);
    if (plan.syntax === null || plan.syntax.length) await run('语法检查', process.execPath, ['scripts/check-syntax.js', ...(plan.syntax === null ? [] : ['--files', ...plan.syntax])]);
    if (plan.browsers) {
      await run('设置浏览器验收', process.execPath, ['scripts/verify-settings-design.mjs']);
      await run('加速设置浏览器验收', process.execPath, ['scripts/verify-extra-fast.mjs']);
    }
    if (plan.ios) await run('iOS 协议与共用渲染', 'python3', ['ios/scripts/test.py', ...(plan.swift ? [] : ['--renderer-only'])]);
    console.log(`日常选定范围通过 (${((Date.now() - started) / 1000).toFixed(1)}s)。发布前运行 npm run test:full，包含全部测试及打包、安装、启动验收。`);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  } finally {
    await rm(home, {recursive: true, force: true});
  }
}
