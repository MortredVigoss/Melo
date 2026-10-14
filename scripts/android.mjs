import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
const adb = sdk ? resolve(sdk, 'platform-tools', windows ? 'adb.exe' : 'adb') : 'adb';
let status = 1;
try {
  if (process.argv[2] === 'connected') {
    const { createSyncServer } = await import('../mobile-sync/server.js');
    const scratch = resolve(root, '.tmp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(resolve(scratch, 'android-sync-fixture-'));
    server = createSyncServer({ token: 'android-instrumentation-fixture-token-only', directory });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    reversePort = `tcp:${server.address().port}`;
    const reverse = spawnSync(adb, ['reverse', reversePort, reversePort], { env, stdio: 'inherit' });
    if (reverse.status !== 0) throw new Error('ADB reverse failed; connect an Emulator and set ANDROID_SERIAL if needed.');
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
} catch (error) {
  console.error(error.message);
} finally {
  if (reversePort) spawnSync(adb, ['reverse', '--remove', reversePort], { env, stdio: 'inherit' });
  if (server) await new Promise(accept => server.close(accept));
}
process.exitCode = status;
