import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compare against the target revision as well as the checked-in baseline.
// Updating a baseline in the same PR must not bless newly introduced findings.
export async function checkAudit(root, eventName, event) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const latest = paths => {
    const path = paths.filter(path => /^docs\/audit\/inventory-\d{4}-\d{2}-\d{2}\.json$/.test(path)).sort().at(-1);
    if (!path) throw new Error('Audit baseline is missing');
    return path;
  };
  const baseline = latest((await readdir(resolve(root, 'docs/audit'))).map(name => `docs/audit/${name}`));
  const output = resolve(root, '.tmp/ci/audit');
  await mkdir(output, { recursive: true });
  const compare = path => execFileSync(process.execPath,
    ['scripts/audit-inventory.mjs', '--baseline', path, '--check', '--out', output],
    { cwd: root, stdio: 'inherit' });
  compare(baseline);
  if (eventName === 'workflow_dispatch') return;
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  if (!/^[a-f0-9]{40}$/i.test(base || '') || /^0+$/.test(base)) throw new Error('Audit requires an existing base revision');
  const revision = eventName === 'pull_request' ? git(['merge-base', base, 'HEAD']) : base;
  const previousPath = latest(git(['ls-tree', '-r', '--name-only', revision, '--', 'docs/audit']).split('\n'));
  const previous = resolve(output, 'previous-baseline.json');
  await writeFile(previous, git(['show', `${revision}:${previousPath}`]) + '\n');
  compare(previous);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = { ...process.env };
  checkAudit(process.cwd(), env.GITHUB_EVENT_NAME, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
