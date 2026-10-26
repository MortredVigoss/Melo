export function verificationMode(argv) {
  if (argv.some(arg => arg !== '--release') || argv.length > 1) throw new Error('Usage: verify-red-green.js [--release]');
  return argv.includes('--release') ? 'release' : 'verify';
}
export async function releaseOnly(mode, results, action) {
  if (mode !== 'release') return false;
  if (results.some(result => result.status !== 'GREEN')) throw new Error('Release installation requires every preceding check to be GREEN');
  await action();
  return true;
}
