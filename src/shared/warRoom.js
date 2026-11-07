// War-room projections (layout A, 2026-11-06). Read-only views over a
// recorded scene for the full-screen task space, shared by desktop, iPhone
// and Android: where each spider is, what every number on screen counts, the
// chip a finished call turns into, and the delivery gate. Every number shown
// is the length (or the sum) of a list of records `traceList` can show;
// nothing here invents a step, a region, a candidate or a score.
import { EXECUTION_MODULES, moduleActivity, rankSceneSources, sceneFinished, sourceReadingLabel } from './executionScene.js';
import { sceneMembers, sceneEvaluation, sceneGoalReview, sceneResources, operationVerb, usageStages, jobIndex } from './executionBoard.js';

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
// and on the core's surface before its first call (`module: null`). The lead
// routes, assigns, evaluates and reports: it never leaves the core. Its own
// calls (not made inside a member job) are listed for tracing, and `out` stays
// false so no spider walks for them.
export function sceneActors(scene) {
  const finished = sceneFinished(scene), operations = scene?.operations || [];
  const actors = sceneMembers(scene).map(member => {
    const own = operations.filter(op => member.operations.includes(op.id));
    const active = finished ? null : own.filter(op => op.status === 'running').at(-1) || null;
    return { id: `member:${member.index}`, kind: 'member', index: member.index, role: member.role, label: member.label,
      out: member.running, module: active?.module || own.at(-1)?.module || null, operation: active?.id || null, operations: own.map(op => op.id) };
  });
  const lead = operations.filter(op => jobIndex(op.id) === null), active = finished ? null : lead.filter(op => op.status === 'running').at(-1) || null;
  actors.push({ id: 'lead', kind: 'lead', index: null, role: 'lead', label: '', out: false, module: active?.module || lead.at(-1)?.module || null,
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
// Counts come from the evaluator's own totals: the snapshot carries at most
// 24 candidates and 4 gaps, and counting those rows would undercount.
const total = (value, rows) => Number.isInteger(value) && value >= rows ? value : rows;
export function deliveryGate(snapshot) {
  if (!snapshot?.contract) return null;
  const summary = snapshot.summary || {}, contract = snapshot.contract, candidates = snapshot.candidates || [];
  const explicit = Number.isInteger(contract.explicit?.value) ? contract.explicit.value : null, minimum = Number.isInteger(contract.target?.minimum) ? contract.target.minimum : null;
  const need = explicit ?? minimum ?? 1, qualified = total(summary.verified, candidates.filter(row => QUALIFIED.includes(row.tier)).length);
  const primary = total(summary.recommended, candidates.filter(row => row.tier === 'primary').length), coverage = contract.coverage || [], covered = coverage.filter(row => row.covered).length;
  const gaps = total(summary.gapCount, (summary.gaps || []).length);
  const rows = [
    { key: 'count', value: `${qualified} / ${need}`, met: qualified >= need },
    { key: 'primary', value: String(primary), met: primary > 0 },
    { key: 'coverage', value: `${covered} / ${coverage.length}`, met: covered === coverage.length },
    { key: 'gaps', value: String(gaps), met: gaps === 0 },
  ];
  return { rows, met: rows.filter(row => row.met).length, open: summary.stop === 'ready_for_review', stop: summary.stop || null, nextBatch: summary.nextBatch ?? null };
}

// The delivery gate of a task without a contract (review 2026-11-07): each
// requirement the latest check judged, read straight from that check. The
// gate is open only when the checker itself passed the answer.
export function goalGate(goal = null) {
  const review = goal?.review;
  if (!review) return null;
  const tally = goal.tally || { total: 0, met: 0, missing: 0, unavailable: 0, evidence: 0, passed: false };
  return { rows: review.requirements.map((row, i) => ({ key: `req-${i}`, status: row.status, kind: row.kind, met: row.status === 'met', evidence: row.evidenceIds.length })),
    met: tally.met, total: tally.total, missing: tally.missing, unavailable: tally.unavailable, evidence: tally.evidence, open: tally.passed,
    decision: review.decision, reason: review.reason, checks: goal.checks, corrections: review.corrections, correctionLimit: review.correctionLimit };
}

// What a number on screen counts. `count` is the number displayed and equals
// `rows.length + omitted`: rows are every record the scene holds; `omitted`
// counts the ones the evaluator totalled but the snapshot did not carry
// (it keeps at most 24 candidates and 4 gaps). The token trace's `total` is
// the sum of the rows it lists. Rows point back to records: an operation or
// stage id (opens the execution detail), a source URL, or a candidate key.
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
  const done = rows => ({ key, kind, arg, count: rows.length, rows, omitted: 0 });
  // Rows the snapshot carries, counted against the evaluator's own total.
  const counted = (rows, all) => { const count = total(all, rows.length); return { key, kind, arg, count, rows, omitted: count - rows.length }; };
  const summary = snapshot?.summary || {}, listed = (snapshot?.candidates || []).length, everyone = listed + (Number.isInteger(summary.omitted) ? summary.omitted : 0);
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
    if (arg === 'top') return done(all.filter(row => QUALIFIED.includes(row.tier)).sort((a, b) => b.total - a.total).slice(0, 1).map(candidateRow));
    if (arg === 'qualified') return counted(all.filter(row => QUALIFIED.includes(row.tier)).map(candidateRow), summary.verified);
    if (arg === 'excluded') return counted(all.filter(row => row.tier === 'excluded').map(candidateRow), summary.excluded);
    return counted(all.map(candidateRow), everyone);
  }
  if (kind === 'gate') {
    const all = snapshot?.candidates || [], contract = snapshot?.contract;
    if (arg === 'count') return counted(all.filter(row => QUALIFIED.includes(row.tier)).map(candidateRow), summary.verified);
    if (arg === 'primary') return counted(all.filter(row => row.tier === 'primary').map(candidateRow), summary.recommended);
    if (arg === 'coverage') return done((contract?.coverage || []).map(row => ({ kind: 'coverage', id: row.tag, tag: row.tag, covered: !!row.covered })));
    if (arg === 'gaps') return counted((summary.gaps || []).map((text, i) => ({ kind: 'gap', id: `gap-${i}`, text })), summary.gapCount);
  }
  // The delivery check: its requirements, those in one state, one
  // requirement's cited evidence (a recorded call when the id matches one),
  // or the check records themselves.
  if (kind === 'review') {
    const goal = sceneGoalReview(scene), requirements = goal.review?.requirements || [];
    const requirementRow = (row, i) => ({ kind: 'requirement', id: `req-${i}`, text: row.text, requirementKind: row.kind, status: row.status, evidence: row.evidenceIds.length });
    if (arg === 'checks') return done(pipeline.filter(stage => /^goal-check:/.test(stage.id)).map(stageRow));
    if (['met', 'missing', 'unavailable'].includes(arg)) return done(requirements.map(requirementRow).filter(row => row.status === arg));
    if (arg === 'requirements') return counted(requirements.map(requirementRow), requirements.length + (goal.review?.omitted || 0));
    const match = /^req-(\d{1,2})$/.exec(arg), row = match ? requirements[Number(match[1])] : null;
    if (row) return done(row.evidenceIds.map(id => {
      // A recorded call with exactly this id wins; a host-prefixed id
      // (job-1:call-1 for call-1) counts only when it is the only one.
      const exact = operations.find(item => item.id === id), prefixed = exact ? [] : operations.filter(item => String(item.id).endsWith(':' + id));
      const op = exact || (prefixed.length === 1 ? prefixed[0] : null);
      return op ? operationRow(op, scene) : { kind: 'evidence', id, text: id };
    }));
    return done([]);
  }
  // A field: the candidates its coverage share is taken over (see fieldCoverage).
  if (kind === 'field') { const cover = fieldCoverage(snapshot, arg); return { ...done(cover.rows.map(candidateRow)), verified: cover.verified, outside: cover.outside }; }
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

// A required field's coverage: of the candidates still in play (not
// excluded) that the snapshot carries, the share with that field verified.
// Qualified candidates alone would always read 100% (qualifying needs every
// field verified). Candidates the snapshot did not carry are `outside` the
// share and said so; nothing is assumed about them.
export function fieldCoverage(snapshot, field) {
  const rows = (snapshot?.candidates || []).filter(row => row.tier !== 'excluded' && row.fields && field in row.fields);
  const verified = rows.filter(row => row.fields[field] === 'verified').length;
  return { field, rows, verified, total: rows.length, share: rows.length ? verified / rows.length : 0, outside: Number.isInteger(snapshot?.summary?.omitted) ? snapshot.summary.omitted : 0 };
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

// Where delivery stands, from the record alone. While the run is live: the
// evaluator's stop and the latest delivery check. Once it ends, one reading
// for all three hosts, whose records differ:
//   desktop  status = how the run ended; completion = the reply's receipt
//            (a run whose request failed has no receipt);
//   iPhone   status = how the run ended; a failed or cancelled run gets a
//            receipt written for it (reason REQUEST_FAILED / CANCELLED);
//   Android  the portable reducer keeps the task result in taskOutcome and
//            sets status 'failed' for every result but completed, cancelled
//            and interrupted; a failed request's reason is REQUEST_FAILED
//            or a MODEL_* code.
// So: cancelled and interrupted are read first; a run is "failed" only when
// it has no task result or its receipt's reason is the failed request
// itself; otherwise the receipt's outcome decides, and only a completed run
// whose receipt says completed reads as delivered (verified only when the
// goal state is verified or supported).
export const DELIVERY_STATES = Object.freeze(['continue', 'ready', 'checking', 'check-failed', 'delivered-verified', 'delivered', 'delivered-unverified', 'partial', 'needs-user', 'budget', 'blocked', 'cancelled', 'failed', 'interrupted', 'ended']);
const REQUEST_FAILURE = /^(REQUEST_FAILED|PROVIDER_ERROR|MODEL_[A-Z_]+)$/;
export function deliveryStatus(scene, snapshot = sceneEvaluation(scene).snapshot) {
  const check = (scene?.pipeline || []).filter(stage => /^goal-check:/.test(stage.id)).at(-1) || null;
  if (!sceneFinished(scene)) {
    if (check?.status === 'running') return 'checking';
    if (!deliveryGate(snapshot)?.open) return 'continue';
    return check?.status === 'failed' ? 'check-failed' : 'ready';
  }
  const receipt = scene.completion || null, kept = scene.taskOutcome && scene.taskOutcome !== 'running' ? scene.taskOutcome : null, outcome = receipt?.outcome || kept;
  if (scene.status === 'cancelled' || outcome === 'cancelled') return 'cancelled';
  if (scene.status === 'interrupted' || outcome === 'interrupted') return 'interrupted';
  if (scene.status === 'failed' && (!outcome || outcome === 'failed' || REQUEST_FAILURE.test(String(receipt?.reason || scene.stopReason || '')))) return 'failed';
  if (!outcome) return 'ended';
  if (outcome === 'completed') return scene.status !== 'completed' ? 'failed' : ['verified', 'supported'].includes(receipt?.goalState) ? 'delivered-verified' : receipt?.goalState === 'not_applicable' ? 'delivered' : 'delivered-unverified';
  return { unverified: 'delivered-unverified', partial: 'partial', needs_user: 'needs-user', budget_exhausted: 'budget' }[outcome] || 'blocked';
}
