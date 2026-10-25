import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The audit inventory is only trustworthy if its rules are pinned: a fixture tree
// with known hits must produce known counts, allowlisted files must not count,
// translation rows and docs must exempt what they cover, ledger probes must flip,
// and the baseline diff must report new / closed hits by location.
const script = fileURLToPath(new URL('./audit-inventory.mjs', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'melo-audit-inventory-'));
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  await put('src/services/chat/example.js', [
    "const model = 'gpt-4.1-mini';",                       // H1
    "if (/[\\u4e00-\\u9fff]/.test(text)) lang = 'zh';",    // H2
    "fetch('http://127.0.0.1:7860/health');",             // H3
    "emit({ kind: 'pipeline', name: '意图判断', status: 'completed' });", // H7 (has a row)
    "emit({ kind: 'pipeline', name: '没有翻译的事件', status: 'completed' });", // H7 (no row)
    "return { ok: false, output: '此操作需要明确的工作目录。' };", // H8
    "if (env.MELO_DOCUMENTED_FLAG === '1') x();",           // H16 documented
    "if (env.MELO_SECRET_FLAG === '1') y();",               // H16 undocumented
    "// TODO: a comment with gpt-4o inside must only count for H20",
  ].join('\n'));
  await put('src/shared/modelCatalog.js', "export const DEFAULT = 'gpt-4.1-mini'; // allowlisted for H1");
  await put('src/services/chat/example.test.js', "const model = 'gpt-4.1-mini'; // tests are never scanned");
  await put('desktop-ui/panel.js', ['const color = "#edb866";', 'window.alert("hi");', '<div style="color:red">'].join('\n'));
  await put('desktop-ui/tokens.css', '--a: #ffffff;');
  await put('desktop-ui/panel.css', '.a { color: #000000 !important; }');
  await put('desktop-ui/translations.js', '["意图判断","Intent","意図","의도","Intención"],\n');
  await put('ios/Melo/View.swift', 'Text(verbatim: name)\n    .font(.system(size: 13))');
  await put('scripts/tool.js', "const DEFAULT_SOURCE = '/Users/someone/project';");
  await put('docs/flags.md', 'MELO_DOCUMENTED_FLAG turns on the thing.');
  await put('shared/agent/completion.js', "if (String(reply).includes(row.url)) ok();");
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const run = (root, ...flags) => execFileSync(process.execPath, [script, '--out', 'audit-out', ...flags], { cwd: root, encoding: 'utf8' });
const latest = async root => { const files = (await readdir(join(root, 'audit-out'))).filter(f => f.startsWith('inventory-')).sort(); return JSON.parse(await readFile(join(root, 'audit-out', files.at(-1)), 'utf8')); };

test('rules count known hits, honour allowlists, translation rows, docs and comments', async () => {
  const root = await fixture();
  try {
    const output = run(root);
    assert.match(output, /audit-inventory: \d+ files/);
    const inv = await latest(root);
    const count = id => inv.rules[id].count;
    assert.equal(count('H1'), 1, 'catalog module is allowlisted and tests are skipped');
    assert.equal(count('H2'), 1);
    assert.equal(count('H3'), 1);
    assert.equal(count('H7'), 1, 'the event name with a translation row is exempt');
    assert.equal(inv.rules.H7.hits[0].text.includes('没有翻译的事件'), true);
    assert.equal(count('H8'), 1);
    assert.equal(count('H16'), 1, 'a flag mentioned in docs is exempt');
    assert.equal(inv.rules.H16.hits[0].text.includes('MELO_SECRET_FLAG'), true);
    assert.equal(count('H10'), 1); assert.equal(count('H12'), 1); assert.equal(count('H13'), 1);
    assert.equal(count('H11'), 1, 'tokens.css is allowlisted'); assert.equal(count('H14'), 1);
    assert.equal(count('H18'), 2); assert.equal(count('H4'), 1);
    assert.equal(count('H20'), 1, 'the TODO comment counts once, and only for H20');
    assert.equal(inv.filesScanned, 9, 'tests and docs are not production files (the generated translations file is listed but skipped per rule)');
    const ledger = Object.fromEntries(inv.ledger.map(item => [item.id, item.status]));
    assert.equal(ledger.L5, 'open', 'the URL-in-reply probe sees the fixture line');
    assert.equal(ledger.L1, 'closed', 'a missing file closes an existence probe');
    assert.equal(ledger.L17, 'open', 'a missing design module keeps the landing probe open');
    const report = await readFile(join(root, 'audit-out', `report-${inv.date}.md`), 'utf8');
    assert.match(report, /\| H1 /); assert.match(report, /L5 .*open/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('baseline diff reports new and closed hits by location, not by count', async () => {
  const root = await fixture();
  try {
    run(root);
    const first = (await readdir(join(root, 'audit-out'))).find(f => f.startsWith('inventory-'));
    // Fix one hit and add another: the count stays the same, the diff must not.
    const file = join(root, 'src/services/chat/example.js');
    const text = (await readFile(file, 'utf8')).replace("fetch('http://127.0.0.1:7860/health');", "fetch(config.voiceHealthUrl);") + "\nconst again = 'http://localhost:11434/v1';\n";
    await writeFile(file, text);
    const output = run(root, '--baseline', join('audit-out', first), '--json-only');
    assert.match(output, /H3 \+1\/-1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
