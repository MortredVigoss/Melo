import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAndroidTaskCollector } from './android-task-report.js';
import { fixtureEmulator } from './android-target.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tasks = {
  build: [':app:assembleDebug'],
  test: [':app:testDebugUnitTest'],
  check: [':app:testDebugUnitTest', ':app:lintDebug', ':app:assembleDebug', ':app:assembleRelease'],
  connected: [':app:connectedDebugAndroidTest'],
  release: [':app:assembleRelease'],
};
const selected = tasks[process.argv[2]];
if (!selected || process.argv.length !== 3) {
  console.error('Usage: node scripts/android.mjs build|test|check|connected|release');
  process.exit(2);
}
const env = { ...process.env };
// The WSL workspace may share one SDK across projects; Android Studio/local.properties
// and an explicitly selected SDK always take precedence.
const workspaceSdk = resolve(root, '..', '.android-sdk');
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT && !existsSync(resolve(root, 'android', 'local.properties')) && existsSync(workspaceSdk)) env.ANDROID_HOME = workspaceSdk;
const windows = process.platform === 'win32';
let server;
let reversePort;
let reportReversePort;
let reportCollector;
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
const adb = sdk ? resolve(sdk, 'platform-tools', windows ? 'adb.exe' : 'adb') : 'adb';
let status = 1;
const evaluationId = randomUUID();
try {
  if (process.argv[2] === 'connected') {
    const devices = spawnSync(adb, ['devices'], {env, encoding: 'utf8'});
    if (devices.status !== 0) throw new Error('Unable to inspect ADB targets; no runtime fixtures were launched.');
    env.ANDROID_SERIAL = fixtureEmulator(devices.stdout, env.ANDROID_SERIAL);
    const { createSyncServer } = await import('../mobile-sync/server.js');
    const scratch = resolve(root, '.tmp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(resolve(scratch, 'android-sync-fixture-'));
    server = createSyncServer({ token: 'android-instrumentation-fixture-token-only', directory });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    reversePort = `tcp:${server.address().port}`;
    const reverse = spawnSync(adb, ['reverse', reversePort, reversePort], { env, stdio: 'inherit' });
    if (reverse.status !== 0) throw new Error('ADB reverse failed; connect an Emulator and set ANDROID_SERIAL if needed.');
    reportCollector = await createAndroidTaskCollector(evaluationId);
    reportReversePort = `tcp:${reportCollector.port}`;
    const reportReverse = spawnSync(adb, ['reverse', reportReversePort, reportReversePort], { env, stdio: 'inherit' });
    if (reportReverse.status !== 0) throw new Error('ADB reverse for task report collection failed.');
    selected.push(`-Pandroid.testInstrumentationRunnerArguments.taskReportEndpoint=http://127.0.0.1:${reportCollector.port}/task-eval`);
    selected.push(`-Pandroid.testInstrumentationRunnerArguments.taskEvaluationId=${evaluationId}`);
    selected.push(`-Pandroid.testInstrumentationRunnerArguments.syncEndpoint=http://127.0.0.1:${server.address().port}/v1/sync`);
    console.log('Using the existing Node mobile-sync server with isolated local fixture storage.');
  }
  // Lint and R8 can otherwise compete for several GiB while an Emulator is running.
  const batches = process.argv[2] === 'check'
    ? [[':app:testDebugUnitTest'], [':app:lintDebug', ':app:assembleDebug'], [':app:assembleRelease']]
    : [selected];
  for (const batch of batches) {
    status = await new Promise((accept, reject) => {
      const child = spawn(windows ? 'gradlew.bat' : './gradlew', batch, {
        cwd: resolve(root, 'android'), env, stdio: 'inherit', shell: windows,
      });
      child.once('error', reject); child.once('exit', code => accept(code ?? 1));
    });
    if (status !== 0) break;
  }
  if (process.argv[2] === 'connected' && status === 0) {
    const report = reportCollector.read();
    await writeFile(resolve(root, '.tmp/agent-task-eval-android.json'), JSON.stringify(report, null, 2));
  }
} catch (error) {
  status = 1;
  console.error(error.message);
} finally {
  // The HTML report can omit instrumentation-process crash stacks. Capture
  // logs before the isolated fixture emulator is terminated; never physical targets.
  if (reversePort) {
    const log = spawnSync(adb, ['logcat', '-d', '-v', 'threadtime'], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    await writeFile(resolve(root, '.tmp/android-fixture-logcat.log'), log.stdout || log.stderr || '');
  }
  if (reportReversePort) spawnSync(adb, ['reverse', '--remove', reportReversePort], { env, stdio: 'inherit' });
  if (reportCollector) await reportCollector.close();
  if (reversePort) spawnSync(adb, ['reverse', '--remove', reversePort], { env, stdio: 'inherit' });
  if (server) await new Promise(accept => server.close(accept));
}
process.exitCode = status;
