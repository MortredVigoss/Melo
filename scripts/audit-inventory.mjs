#!/usr/bin/env node
// Rule-based repository audit (2026-10-26). The user asked why every audit
// finds "new" problems: hand-driven grep sweeps have no coverage measure and
// no closed rule list, so each pass samples differently. This script is the
// closed list: every rule below is applied to every production file in the
// roots, and the result is written as an inventory (counts, locations) plus a
// Markdown report. A later run with `--baseline <inventory.json>` reports only
// what is new, closed or unchanged per rule, so "audit" becomes a diff.
//
// Rules are mechanical and deliberately coarse: a hit is "needs a look", not
// "is a bug". Judgement items (unclear logic, UI consistency) live in the
// ledger (docs/audit/ledger.md), not here.
//
//   node scripts/audit-inventory.mjs [--out docs/audit] [--baseline <json>] [--json-only] [--check]
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const outDir = opt('--out', 'docs/audit');
const baselinePath = opt('--baseline', null);
const jsonOnly = args.includes('--json-only');
const check = args.includes('--check');
if (check && !baselinePath) throw new Error('--check requires --baseline');
// Local calendar date (the machine's zone), not UTC, so the file matches the day the audit was run.
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

// ─── Scope ───────────────────────────────────────────────────────────────────
const ROOTS = ['src', 'shared', 'desktop-ui', 'ios/Melo', 'desktop-app', 'scripts', 'mobile-sync'];
const EXT = /\.(?:[cm]?js|swift|css)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|\.tmp)(?:\/|$)|\.test\.js$|\.test\.mjs$|(?:^|\/)tests\//;
// Generated bundles and data files: scanned for nothing, listed as skipped.
const GENERATED = /^(?:ios\/Melo\/AgentCore\/agent-core\.js|ios\/Melo\/Scene\/scene\.js|shared\/agent\/loopContract\.js|desktop-ui\/translations\.js|ios\/native-translations\.js)$/;

async function walk(dir, out) {
  let entries;
  try { entries = await readdir(resolve(root, dir), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP.test(path + '/')) await walk(path, out); }
    else if (EXT.test(entry.name) && !SKIP.test(path)) out.push(path);
  }
  return out;
}

// ─── Rules ───────────────────────────────────────────────────────────────────
// id, title, severity (high: breaks across providers / languages / machines;
// medium: behaviour by hidden constant; info: metric to watch), files (regex
// on path), allow (regex on path: hits here are expected), pattern (regex per
// line; 'g' not needed), note.
const RULES = [
  { id: 'H1', title: '模型名正则 / 字面量决定能力或默认值', severity: 'high',
    files: /\.(?:js|swift)$/, allow: /^(?:src\/shared\/modelCatalog\.js|src\/shared\/llmProviders\.js|shared\/agent\/providerDefaults\.js|ios\/Melo\/LLMConnections\.swift|src\/providers\/codexModels\.js|ios\/Melo\/[^/]*Verification\.swift)$/,
    pattern: /(?:\/\^?(?:gpt|claude|gemini|llama|qwen|deepseek|o[134])[^/]*\/[gimsuy]*|['"](?:gpt-[0-9][\w.-]*|gpt-image[\w.-]*|claude-[\w.-]+|gemini-[\w.-]+|llama[\w.:-]*|whisper-[\w.-]+|speech-0\d[\w-]*|tts-1[\w-]*)['"])/,
    note: '能力标志应来自模型目录；默认名只留目录模块' },
  { id: 'H2', title: '用汉字 / CJK 正则判断语言或内容', severity: 'high',
    files: /\.js$/, allow: /^(?:shared\/agent\/(?:locale|completion)\.js|src\/services\/chat\/dynamicContext\.js|src\/services\/remote\/telegramAddressHelpers\.js|src\/shared\/(?:conversationTopics|executionScene)\.js|src\/search\/tokenizer\.js|src\/memory\/(?:conversationIndex|knowledgeIndex|store)\.js|src\/agents\/skillTokenize\.js|src\/tools\/builtins\/knowledgeTool\.js|src\/domain\/message\/messageBlocks\.js|desktop-ui\/features\/chat\/viewMessage\.js)$/,
    pattern: /\\u(?:4e00|4E00|3400)-\\u(?:9fff|9FFF)|\\p\{Script=Han\}|\[一-龥\]/,
    note: '语言选择应来自对话 / 界面 / Agent 设置；分词与索引模块例外' },
  { id: 'H3', title: '本机地址与端口字面量', severity: 'high',
    files: /\.(?:js|swift)$/, allow: /^(?:src\/config\.js|src\/shared\/localServices\.js|src\/shared\/llmProviders\.js|ios\/Melo\/LLMConnections\.swift|scripts\/verify-red-green\.js)$/,
    pattern: /(?:127\.0\.0\.1|localhost):\d{2,5}|\b(?:7860|11434|43127|43128|43212)\b/,
    note: '端口进 config 带默认；前端读配置 URL，不做端口正则' },
  { id: 'H4', title: '机器相关绝对路径', severity: 'high',
    files: /\.(?:js|mjs|swift|sh)$/, allow: /^$/,
    pattern: /\/Users\/[a-z]+\/|~\/Desktop\/|Desktop\/melo\//,
    note: '仓库里不出现用户目录' },
  { id: 'H5', title: '外部服务地址字面量', severity: 'info',
    files: /\.(?:js|swift)$/, allow: /^(?:src\/shared\/llmProviders\.js|ios\/Melo\/LLMConnections\.swift)$/,
    pattern: /https?:\/\/(?!(?:example\.com|www\.w3\.org|melo\.app|fixture|unconfigured))[A-Za-z0-9.-]+\.[a-z]{2,}/,
    note: '集成端点集中到目录 / 配置，便于换区与自建' },
  { id: 'H6', title: '内置 Agent id 写进逻辑', severity: 'medium',
    files: /^src\/.*\.js$/, allow: /^src\/domain\/agent\/agentLibrary\.js$/,
    pattern: /\[\s*'(?:main|research|builder|reviewer)'(?:\s*,\s*'(?:main|research|builder|reviewer)')+\s*\]|===\s*'(?:research|builder|reviewer)'|members:\s*\['(?:research|builder|reviewer)'/,
    note: 'owner / 团队预设应读 agentProfiles，不写死 id' },
  { id: 'H7', title: '服务端直发界面的中文事件名（无翻译行）', severity: 'high',
    files: /^src\/.*\.js$/, allow: /^$/,
    pattern: /name:\s*'[^']*[一-鿿][^']*'/, needsTranslationRow: true,
    note: '事件应发 id + 参数，由 UI 翻译；或至少补翻译行' },
  { id: 'H8', title: '服务端中文回复 / 错误文案', severity: 'medium',
    files: /^src\/.*\.js$/, allow: /^$/,
    pattern: /(?:reply|output|error|message)\s*[:=]\s*[`'"][^`'"]*[一-鿿]/, exclude: /execution_event|sseEmitter|name:/,
    note: '按对话语言选文案，不按"有没有汉字"' },
  { id: 'H9', title: '按用户消息脚本选回复语言', severity: 'high',
    files: /\.js$/, allow: /^$/,
    pattern: /cjkPattern\)\.test|zh\s*=\s*\/\[\\u3400-\\u9fff\]\/u\.test|\/\[\\u4E00-\\u9FFF[^\]]*\]\/\.test\(text\)\)\s*return\s*'zh'/,
    note: '同 H2，针对"中 / 英二选一"的落点' },
  { id: 'H10', title: '桌面 JS 里的原始色值', severity: 'medium',
    files: /^desktop-ui\/.*\.js$/, allow: /^desktop-ui\/(?:executionScene3D|neuralSatellite|neuralShell)\.js$/,
    pattern: /#[0-9a-fA-F]{6}\b/, note: '颜色进 tokens.css；3D / 卫星场景例外' },
  { id: 'H11', title: 'CSS 原始色值（tokens.css 之外）', severity: 'info',
    files: /^desktop-ui\/.*\.css$/, allow: /^desktop-ui\/tokens\.css$/,
    pattern: /#[0-9a-fA-F]{3,8}\b/, note: '主题换色会漏；逐步收进 tokens' },
  { id: 'H12', title: '原生对话框 alert / confirm / prompt', severity: 'medium',
    files: /^desktop-ui\/.*\.js$/, allow: /^$/,
    pattern: /\bwindow\.(?:alert|confirm|prompt)\(|(?<![\w.])(?:alert|confirm|prompt)\(/, note: '统一走应用内反馈' },
  { id: 'H13', title: '内联 style= 属性', severity: 'info',
    files: /^desktop-ui\/.*\.js$/, allow: /^$/,
    pattern: /\sstyle="/, note: '进 CSS 类' },
  { id: 'H14', title: 'CSS !important', severity: 'info',
    files: /^desktop-ui\/.*\.css$/, allow: /^$/, pattern: /!important/, note: '层叠顺序问题的症状' },
  { id: 'H15', title: 'escapeHtml / escape 重复定义', severity: 'medium',
    files: /^desktop-ui\/.*\.js$/, allow: /^desktop-ui\/i18n\.js$/,
    pattern: /^(?:export )?(?:const|function) escape(?:Html)?\b/, note: '一份共享 helper' },
  { id: 'H16', title: '只认 === \'1\' 的环境开关', severity: 'medium',
    files: /^(?:src|shared|desktop-ui)\/.*\.js$/, allow: /^$/,
    pattern: /MELO_[A-Z0-9_]+['"]?\s*\]?\s*===?\s*'1'/, needsDoc: true,
    note: '行为开关进 config + 设置页"高级"，debug 开关集中一份文档' },
  { id: 'H17', title: '问候 / 确认词表副本', severity: 'medium',
    files: /^(?:src|shared)\/.*\.js$/, allow: /^$/,
    pattern: /\^\(\?:(?:hi|ok|okay)\|/, note: '一份共享词表' },
  { id: 'H18', title: 'iOS 固定字号 / 原始色 / 绕过本地化的文本', severity: 'info',
    files: /^ios\/Melo\/.*\.swift$/, allow: /^ios\/Melo\/MeloTheme\.swift$/,
    pattern: /\.font\(\.system\(size:|Color\((?:hex|red):|Text\(verbatim:|Text\("\\\(/, note: '语义字号、色板、LocalizedStringKey' },
  { id: 'H19', title: '写死的语言默认值 zh-CN', severity: 'medium',
    files: /\.(?:js|swift)$/, allow: /^(?:src\/domain\/settings\/localPreferences\.js|src\/tools\/builtins\/translateTool\.js|src\/services\/export\/pdfEditSpec\.js|src\/tools\/builtins\/pdfTool\.js)$/,
    pattern: /(?:\?\?|\|\|)\s*['"]zh-(?:CN|Hans)['"]|\b(?:const|let|var)\s+\w+(?:\s*:\s*String)?\s*=\s*['"]zh-(?:CN|Hans)['"]|\b(?:language|locale|interfaceLanguage|voiceLanguage)\s*(?::\s*String)?\s*=\s*['"]zh-(?:CN|Hans)['"]|\?\s*value\s*:\s*['"]zh-(?:CN|Hans)['"]/, note: '默认语言跟系统 / 设置' },
  { id: 'H20', title: 'TODO / FIXME / HACK', severity: 'info',
    files: /\.(?:js|swift)$/, allow: /^$/, pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/, note: '' },
];

// Known findings from the 10-23 / 10-24 reports: a probe says whether each is
// still open. This is the ledger's machine-checkable half.
const LEDGER = [
  { id: 'L1', title: '额外快速（小模型猜标签）仍在代码里', file: 'src/judge/fastJudge.js', pattern: /./, open: 'exists' },
  { id: 'L2', title: 'HTTP 搜索路由把 web_search 设为必需工具', file: 'shared/agent/search.js', pattern: /requiredTools:\s*\['web_search'/ },
  { id: 'L3', title: '路由提示词硬写"先搜"', file: 'shared/agent/search.js', pattern: /Search public sources first/ },
  { id: 'L4', title: 'Hosted 搜索缺回执时替换模型回答', file: 'src/services/chat/execution/invokeModelNode.js', pattern: /本轮未收到可核对的 Search completed/ },
  { id: 'L5', title: '研究回执要求回复原样含来源 URL', file: 'shared/agent/completion.js', pattern: /String\(reply\)\.includes\(row\.url\)/ },
  { id: 'L6', title: '分类模型写死 gpt-4o-mini', file: 'src/retrieval/intentRouter.js', pattern: /gpt-4o-mini/ },
  { id: 'L7', title: '视觉能力按模型名正则', file: 'src/media/visionCapability.js', pattern: /^\s*\/\^gpt-4o\/i/m },
  { id: 'L8', title: '前端用 7860 端口正则判断自定义声音', file: 'desktop-ui/app.js', pattern: /127\\\.0\\\.0\\\.1:7860/ },
  { id: 'L9', title: '任务 owner 固定四个内置 id', file: 'src/domain/task/taskService.js', pattern: /TASK_OWNERS\s*=\s*\['main'/ },
  { id: 'L10', title: '渠道别名硬加 melo', file: 'src/services/remote/telegramAddressHelpers.js', pattern: /aliases\.add\('melo'\)/ },
  { id: 'L11', title: '英文硬编码的 window.prompt 附链接', file: 'desktop-ui/features/chat/controller.js', pattern: /window\.prompt\('Paste a link/ },
  { id: 'L12', title: '仓库里本机绝对路径（android-pet-assets）', file: 'scripts/android-pet-assets.js', pattern: /\/Users\/mortred/ },
  { id: 'L13', title: '同轮两份不同的问候词表（prepareNode 175 vs 415）', file: 'src/services/chat/execution/prepareNode.js', pattern: /\^\(\?:hi\|hello\|hey\|thanks\|thank you\|你好\|嗨\|谢谢\)/ },
  { id: 'L14', title: '空回复兜底只有英文', file: 'src/services/chat/execution/finalizeNode.js', pattern: /I wasn't able to generate a response/ },
  { id: 'L15', title: '预算用完模板只有中文', file: 'shared/protocol/agent-loop.json', pattern: /"replyTemplate":\s*"这轮对话已达到运行预算/ },
  { id: 'L16', title: '纠正事实主题只认三种', file: 'src/memory/factPolicy.js', pattern: /deployment\.port/ },
  { id: 'L17', title: '智能模式档位表存在（设计落地探针，open = 未落地）', file: 'desktop-ui/smartRouting.js', pattern: /./, open: 'missing' },
];

// ─── Scan ────────────────────────────────────────────────────────────────────
const files = [];
for (const dir of ROOTS) await walk(dir, files);
files.sort();
const sources = new Map();
for (const file of files) sources.set(file, await readFile(resolve(root, file), 'utf8'));
const translationKeys = new Set();
if (existsSync(resolve(root, 'desktop-ui/translations.js'))) {
  for (const match of (await readFile(resolve(root, 'desktop-ui/translations.js'), 'utf8')).matchAll(/^\["((?:[^"\\]|\\.)*)"/gm)) translationKeys.add(match[1]);
}
// Documentation text for the "documented flag" exemption: every Markdown file
// under docs/ plus the root instruction files (the production walker above
// only collects code, so docs need their own walk).
async function markdown(dir, out) {
  let entries;
  try { entries = await readdir(resolve(root, dir), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await markdown(path, out);
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}
const docText = await (async () => { const out = []; for (const f of await markdown('docs', [])) out.push(await readFile(resolve(root, f), 'utf8')); for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) if (existsSync(resolve(root, f))) out.push(await readFile(resolve(root, f), 'utf8')); return out.join('\n'); })();

const inventory = { version: 1, date: today, commit: await commit(), roots: ROOTS, filesScanned: files.length, skippedGenerated: files.filter(f => GENERATED.test(f)), rules: {}, ledger: [] };
for (const rule of RULES) {
  const hits = [];
  let scanned = 0;
  for (const [file, text] of sources) {
    if (!rule.files.test(file) || GENERATED.test(file)) continue;
    scanned++;
    if (rule.allow.test(file)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line) && rule.id !== 'H20') continue; // comments only count for TODO
      // Exempt individual status/backend/binary tokens, never an entire line:
      // a real model literal beside a status still needs review.
      const candidate = rule.id === 'H1'
        ? line.replace(/(['"])(?:whisper-(?:unavailable|error|cpp|cli)|llamacpp)\1/g, "''") : line;
      if (!rule.pattern.test(candidate)) continue;
      // The native shell cannot import JS configuration. Only its one numeric
      // default definition is allowed; duplicate initializers remain visible.
      if (rule.id === 'H3' && file === 'desktop-app/main.swift' && /^\s*\)\s*\?\?\s*43127\s*$/.test(line)) continue;
      if (rule.exclude && rule.exclude.test(line)) continue;
      if (rule.needsTranslationRow) { const name = line.match(/name:\s*'([^']*)'/)?.[1]; if (name && translationKeys.has(name)) continue; }
      if (rule.needsDoc) { const flag = line.match(/MELO_[A-Z0-9_]+/)?.[0]; if (flag && docText.includes(flag)) continue; }
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
  const byFile = {};
  for (const hit of hits) byFile[hit.file] = (byFile[hit.file] || 0) + 1;
  inventory.rules[rule.id] = { title: rule.title, severity: rule.severity, note: rule.note, scanned, count: hits.length, files: Object.keys(byFile).length, byFile, hits };
}
for (const item of LEDGER) {
  const path = resolve(root, item.file);
  const exists = existsSync(path);
  let open;
  if (item.open === 'exists') open = exists;
  else if (item.open === 'missing') open = !exists;
  else open = exists && item.pattern.test(await readFile(path, 'utf8'));
  inventory.ledger.push({ id: item.id, title: item.title, file: item.file, status: open ? 'open' : 'closed' });
}

// ─── Baseline diff ───────────────────────────────────────────────────────────
let diff = null;
if (baselinePath) {
  const baseline = JSON.parse(await readFile(resolve(root, baselinePath), 'utf8'));
  diff = { baseline: baseline.date, rules: {} };
  for (const id of Object.keys(inventory.rules)) {
    if (!Array.isArray(baseline.rules?.[id]?.hits)) throw new Error(`Baseline is missing rule ${id}`);
    // Multiset comparison catches a second copy of the same offending line.
    // Line numbers are excluded so unrelated edits do not create false growth.
    const counts = hits => {
      const result = new Map();
      for (const hit of hits) {
        const key = `${hit.file}:${hit.text}`;
        result.set(key, (result.get(key) || 0) + 1);
      }
      return result;
    };
    const before = counts(baseline.rules[id].hits);
    const after = counts(inventory.rules[id].hits);
    const added = [...after].reduce((n, [key, count]) => n + Math.max(0, count - (before.get(key) || 0)), 0);
    const closed = [...before].reduce((n, [key, count]) => n + Math.max(0, count - (after.get(key) || 0)), 0);
    diff.rules[id] = { new: added, closed, count: inventory.rules[id].count, baselineCount: baseline.rules[id].hits.length };
  }
}

if (check && Object.values(diff.rules).some(rule => rule.new > 0)) process.exitCode = 1;

// ─── Output ──────────────────────────────────────────────────────────────────
await mkdir(resolve(root, outDir), { recursive: true });
const inventoryPath = resolve(root, outDir, `inventory-${today}.json`);
if (check && baselinePath && inventoryPath === resolve(root, baselinePath)) throw new Error('--check output must not overwrite its baseline; use --out .tmp/audit');
await writeFile(inventoryPath, JSON.stringify(inventory, null, 1) + '\n');
if (diff) await writeFile(resolve(root, outDir, 'diff.json'), JSON.stringify(diff, null, 2) + '\n');
const severityOrder = { high: 0, medium: 1, info: 2 };
const rows = Object.entries(inventory.rules).sort((a, b) => severityOrder[a[1].severity] - severityOrder[b[1].severity] || b[1].count - a[1].count);
const lines = [`# 规则扫描清单 · ${today}`, '', `提交 \`${inventory.commit}\`；扫描 ${inventory.filesScanned} 个正式文件（${ROOTS.join('、')}，不含测试 / dist / node_modules），生成物按规则跳过：${inventory.skippedGenerated.join('、') || '无'}。每条规则对其范围内的全部文件逐行应用；"命中"表示需要看，不等于 bug。`, '',
  '| 规则 | 级别 | 命中 | 文件数 | 扫描文件 | 说明 |', '| --- | --- | --- | --- | --- | --- |'];
for (const [id, rule] of rows) lines.push(`| ${id} ${rule.title} | ${rule.severity} | ${rule.count}${diff ? ` (新 ${diff.rules[id].new} / 关 ${diff.rules[id].closed})` : ''} | ${rule.files} | ${rule.scanned} | ${rule.note} |`);
lines.push('', '## 已知问题台账（机器探针）', '', '| 编号 | 问题 | 位置 | 状态 |', '| --- | --- | --- | --- |');
for (const item of inventory.ledger) lines.push(`| ${item.id} | ${item.title} | \`${item.file}\` | ${item.status === 'open' ? '🔴 open' : '✅ closed'} |`);
lines.push('', '## 命中最多的文件（每条规则前 5）', '');
for (const [id, rule] of rows) {
  if (!rule.count) continue;
  const top = Object.entries(rule.byFile).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `\`${f}\` ${n}`).join('，');
  lines.push(`- **${id}**：${top}`);
}
lines.push('', '## 样例（每条规则前 3 处）', '');
for (const [id, rule] of rows) {
  if (!rule.count) continue;
  lines.push(`### ${id} ${rule.title}`);
  for (const hit of rule.hits.slice(0, 3)) lines.push(`- \`${hit.file}:${hit.line}\` ${hit.text.replace(/\|/g, '\\|')}`);
  lines.push('');
}
if (!jsonOnly) await writeFile(resolve(root, outDir, `report-${today}.md`), lines.join('\n') + '\n');
const summary = rows.map(([id, rule]) => `${id} ${rule.count}`).join(' · ');
console.log(`audit-inventory: ${inventory.filesScanned} files · ${summary}`);
console.log(`ledger: ${inventory.ledger.filter(i => i.status === 'open').length} open / ${inventory.ledger.length}`);
console.log(`→ ${join(outDir, `inventory-${today}.json`)}${jsonOnly ? '' : ` · ${join(outDir, `report-${today}.md`)}`}`);
if (diff) console.log(`diff vs ${diff.baseline}: ${Object.entries(diff.rules).map(([id, d]) => `${id} +${d.new}/-${d.closed}`).join(' ')}`);

async function commit() {
  try { const { execFileSync } = await import('node:child_process'); return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}
