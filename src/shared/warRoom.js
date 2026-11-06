// War-room projections (layout A, 2026-11-06). Read-only views over a
// recorded scene for the full-screen task space, shared by desktop, iPhone
// and Android: where each spider is, what every number on screen counts, the
// chip a finished call turns into, and the delivery gate. Every number shown
// is the length (or the sum) of a list of records `traceList` can show;
// nothing here invents a step, a region, a candidate or a score.
import { EXECUTION_MODULES, moduleActivity, rankSceneSources, sceneFinished, sourceReadingLabel } from './executionScene.js';
import { sceneMembers, sceneEvaluation, sceneResources, operationVerb, usageStages } from './executionBoard.js';

const JOB = /^job-(\d{1,3})[:#]/;
const QUALIFIED = ['primary', 'alternative', 'eligible'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

// Tool calls by region. Each recorded operation carries exactly one region,
// so the five regions add up to the run's total tool calls.
export const regionCalls = (scene, id) => (scene?.operations || []).filter(op => op.module === id);

export function regionSummary(scene) {
  return EXECUTION_MODULES.map(module => {
    const activity = moduleActivity(scene, module.id), calls = regionCalls(scene, module.id);
    return { id: module.id, status: activity.status, running: activity.running.length,
      calls: calls.length, records: activity.operations.length - calls.length,
      sources: module.id === 'search' ? (scene?.sources || []).length : 0 };
  });
}

// Who is out in the space. A member's spider exists while its assignment
// runs; it stands where its running call is, else where its last call was,
// and on the core's surface before its first call (`module: null`). The
// lead's own calls (not made inside a member job) get a spider of their own.
export function sceneActors(scene) {
  const finished = sceneFinished(scene), operations = scene?.operations || [];
  const actors = sceneMembers(scene).map(member => {
    const own = operations.filter(op => member.operations.includes(op.id));
    const active = finished ? null : own.filter(op => op.status === 'running').at(-1) || null;
    return { id: `member:${member.index}`, kind: 'member', index: member.index, role: member.role, label: member.label,
      out: member.running, module: active?.module || own.at(-1)?.module || null, operation: active?.id || null, operations: own.map(op => op.id) };
  });
  const lead = operations.filter(op => !JOB.test(op.id)), active = finished ? null : lead.filter(op => op.status === 'running').at(-1) || null;
  actors.push({ id: 'lead', kind: 'lead', index: null, role: 'lead', label: '', out: !!active, module: active?.module || lead.at(-1)?.module || null,
    operation: active?.id || null, operations: lead.map(op => op.id) });
  return actors;
}
export const operationActor = (scene, id) => sceneActors(scene).find(actor => actor.operations.includes(id)) || null;

// What a finished call hands over: the verb and the shortest faithful name of
// what it touched (a host for a page, the query for a search, a file name, the
// expression, else the tool's own name).
function host(text) { const match = /https?:\/\/[^\s"'<>]+/i.exec(text); try { return match ? new URL(match[0]).hostname.replace(/^www\./, '') : ''; } catch { return ''; } }
function baseName(text) { const match = /(?:^|[\s"'(])((?:~|\.{0,2})?\/[^\s"')]+|[\w.-]+\.[a-z0-9]{1,6})(?=$|[\s"')])/i.exec(text); return match ? match[1].split('/').filter(Boolean).at(-1) : ''; }
export function operationChip(op) {
  const verb = operationVerb(op), input = String(op?.input || ''), failed = ['failed', 'cancelled', 'interrupted'].includes(op?.status);
  let text = '';
  if (verb === 'read') text = host(op?.requestUrl || '') || host(input) || host(op?.resultSummary || '');
  else if (verb === 'search') text = op?.query || input;
  else if (verb === 'compute') text = op?.expression || input;
  else if (verb === 'lookup' || verb === 'write') text = baseName(op?.change?.path || '') || baseName(input) || input;
  if (!text) text = op?.name || '';
  return { verb, text: clip(text, 40), failed, status: op?.status || 'queued' };
}

// The delivery gate: four rows read straight from the evaluation snapshot;
// whether the gate is open is the evaluator's own `stop`, not recomputed.
export function deliveryGate(snapshot) {
  if (!snapshot?.contract) return null;
  const summary = snapshot.summary || {}, contract = snapshot.contract, candidates = snapshot.candidates || [];
  const explicit = Number.isInteger(contract.explicit?.value) ? contract.explicit.value : null, minimum = Number.isInteger(contract.target?.minimum) ? contract.target.minimum : null;
  const need = explicit ?? minimum ?? 1, qualified = candidates.filter(row => QUALIFIED.includes(row.tier)).length;
  const primary = candidates.filter(row => row.tier === 'primary').length, coverage = contract.coverage || [], covered = coverage.filter(row => row.covered).length, gaps = summary.gaps || [];
  const rows = [
    { key: 'count', value: `${qualified} / ${need}`, met: qualified >= need },
    { key: 'primary', value: String(primary), met: primary > 0 },
    { key: 'coverage', value: `${covered} / ${coverage.length}`, met: covered === coverage.length },
    { key: 'gaps', value: String(gaps.length), met: gaps.length === 0 },
  ];
  return { rows, met: rows.filter(row => row.met).length, open: summary.stop === 'ready_for_review', stop: summary.stop || null, nextBatch: summary.nextBatch ?? null };
}

// What a number on screen counts. `count` is the number displayed and always
// equals `rows.length`, except the token trace, whose `total` is the sum of
// the rows it lists. Rows point back to records: an operation or stage id
// (opens the execution detail), a source URL, or a candidate key.
const operationRow = (op, scene) => {
  const actor = operationActor(scene, op.id);
  return { kind: 'operation', id: op.id, verb: operationVerb(op), module: op.module, name: op.name || '', status: op.status, actor: actor ? { kind: actor.kind, role: actor.role, index: actor.index } : null,
    text: clip(op.query || op.expression || op.input || op.resultSummary || op.name || '', 160), at: op.startedAt || op.finishedAt || null };
};
const stageRow = stage => ({ kind: 'stage', id: stage.id, module: stage.module || 'create', name: stage.name || '', status: stage.status, text: clip(stage.output || stage.input || '', 160), at: stage.startedAt || stage.finishedAt || null,
  tokens: Number(stage.api?.usage?.input) || 0 });
const candidateRow = row => ({ kind: 'candidate', id: row.key, name: row.name, tier: row.tier, total: row.total, fields: row.fields || {}, reason: row.excludeReason || row.reason || '' });
export function traceList(scene, key, { snapshot = sceneEvaluation(scene).snapshot, now = null } = {}) {
  const [kind, arg = ''] = String(key).split(':'), operations = scene?.operations || [], pipeline = scene?.pipeline || [];
  const done = rows => ({ key, kind, arg, count: rows.length, rows });
  if (kind === 'calls') return done(operations.map(op => operationRow(op, scene)));
  if (kind === 'region' && EXECUTION_MODULES.some(m => m.id === arg)) {
    const calls = regionCalls(scene, arg).map(op => operationRow(op, scene)), stages = pipeline.filter(stage => (stage.module || 'create') === arg).map(stageRow);
    return { ...done([...calls, ...stages]), calls: calls.length, records: stages.length };
  }
  if (kind === 'sources') return done(rankSceneSources(scene).map(source => ({ kind: 'source', id: source.id, url: source.citationUrl || source.url, title: source.titleProvided ? source.title : '', cited: !!source.cited, reading: sourceReadingLabel(source) })));
  if (kind === 'tokens') { const rows = usageStages(scene).filter(stage => Number(stage.api.usage.input) > 0).map(stageRow); return { ...done(rows), total: rows.reduce((sum, row) => sum + row.tokens, 0) }; }
  if (kind === 'member') { const member = sceneMembers(scene).find(row => String(row.index) === arg); return done(member ? operations.filter(op => member.operations.includes(op.id)).map(op => operationRow(op, scene)) : []); }
  if (kind === 'time') {
    const rows = [], start = time(scene?.startedAt), resources = sceneResources(scene, { now });
    const add = (id, label, at) => { if (at) rows.push({ kind: 'moment', id, label, at, offsetMs: start !== null && time(at) !== null ? Math.max(0, time(at) - start) : null }); };
    add('start', 'start', scene?.startedAt);
    const firstCall = operations.map(op => op.startedAt).filter(Boolean).sort()[0]; add('first-call', 'first-call', firstCall);
    const lastCall = operations.map(op => op.finishedAt).filter(Boolean).sort().at(-1); add('last-call', 'last-call', lastCall);
    add('finish', 'finish', scene?.finishedAt);
    return { ...done(rows), elapsedMs: resources.elapsedMs };
  }
  if (kind === 'candidates') {
    const all = snapshot?.candidates || [];
    const rows = arg === 'qualified' ? all.filter(row => QUALIFIED.includes(row.tier)) : arg === 'excluded' ? all.filter(row => row.tier === 'excluded') : arg === 'top' ? all.filter(row => QUALIFIED.includes(row.tier)).sort((a, b) => b.total - a.total).slice(0, 1) : all;
    return done(rows.map(candidateRow));
  }
  if (kind === 'gate') {
    const all = snapshot?.candidates || [], contract = snapshot?.contract;
    if (arg === 'count') return done(all.filter(row => QUALIFIED.includes(row.tier)).map(candidateRow));
    if (arg === 'primary') return done(all.filter(row => row.tier === 'primary').map(candidateRow));
    if (arg === 'coverage') return done((contract?.coverage || []).map(row => ({ kind: 'coverage', id: row.tag, tag: row.tag, covered: !!row.covered })));
    if (arg === 'gaps') return done((snapshot?.summary?.gaps || []).map((text, i) => ({ kind: 'gap', id: `gap-${i}`, text })));
  }
  if (kind === 'field') return done((snapshot?.candidates || []).filter(row => row.fields && arg in row.fields).map(candidateRow));
  if (kind === 'candidate') return done((snapshot?.candidates || []).filter(row => row.key === arg).map(candidateRow));
  if (kind === 'checkpoint') {
    const policy = snapshot?.policy || {}, rows = [];
    if (Number.isFinite(policy.checkpoint?.milliseconds)) rows.push({ kind: 'policy', id: 'milliseconds', value: policy.checkpoint.milliseconds });
    if (Number.isFinite(policy.checkpoint?.calls)) rows.push({ kind: 'policy', id: 'calls', value: policy.checkpoint.calls });
    if (Number.isFinite(policy.memberCalls)) rows.push({ kind: 'policy', id: 'memberCalls', value: policy.memberCalls });
    return done(rows);
  }
  return done([]);
}

// When the war room opens by itself: the run in this chat is live and has
// done something observable (a tool call, an assignment, an evaluation). A
// plain chat reply never opens it.
export const sceneHasExecution = scene => !!scene && ((scene.operations || []).length > 0 || (scene.pipeline || []).some(stage => /^internal:\d|^task-evaluation:/.test(stage.id)));
// The run is waiting on the user: a call held for permission, or an
// assignment awaiting approval. The war room never covers that prompt.
export const sceneNeedsUser = scene => !!scene && !sceneFinished(scene) && ((scene.operations || []).some(op => op.status === 'waiting')
  || (scene.pipeline || []).some(stage => /^routing:approval:/.test(stage.id) && ['waiting', 'running', 'queued'].includes(stage.status)));
export const shouldAutoOpen = (scene, { opened = false, dismissed = false, autoOpened = false } = {}) => !!scene && !sceneFinished(scene) && !opened && !dismissed && !autoOpened && sceneHasExecution(scene) && !sceneNeedsUser(scene);
export const finishedOperations = scene => (scene?.operations || []).filter(op => TERMINAL.includes(op.status)).map(op => op.id);
