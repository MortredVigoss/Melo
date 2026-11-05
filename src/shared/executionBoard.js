// Task-space board projections (plan C, 2026-11-05). Read-only views over a
// recorded scene for the 3D space and the board below it, shared by desktop,
// iPhone and Android. Nothing here creates a member, a stage, a score or
// progress the scene did not record; every row points back to its record.
import { MEMBER_ROLES, TERMINAL_SCENE_STATUSES, sceneFinished } from './executionScene.js';
import { normalizeEvaluationSnapshot, taskEvaluationSnapshot } from '../../shared/agent/taskEvaluation.js';

// Where a member normally works when no running operation says otherwise.
export const MEMBER_ROLE_MODULE = Object.freeze({ research: 'search', lookup: 'files', calculate: 'compute', execute: 'tools' });
// Scenes recorded before stages carried a role only have the display label.
const LEGACY_ROLE_LABELS = Object.freeze({ '检索成员': 'research', '计算成员': 'calculate', '资料读取成员': 'lookup', '执行成员': 'execute' });
export const BOARD_LOG_LIMIT = 60;
const QUALIFIED_TIERS = ['primary', 'alternative', 'eligible'];
const memberIndex = id => { const match = /^internal:(\d{1,3})$/.exec(String(id)); return match ? Number(match[1]) : null; };
const jobIndex = id => { const match = /^job-(\d{1,3})[:#]/.exec(String(id)); return match ? Number(match[1]) : null; };
const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };

export function memberRole(stage) {
  if (MEMBER_ROLES.includes(stage?.role)) return stage.role;
  return LEGACY_ROLE_LABELS[String(stage?.name || '').trim()] || null;
}

// One entry per recorded internal assignment, in assignment order.
export function sceneMembers(scene) {
  const finished = sceneFinished(scene), operations = scene?.operations || [], pipeline = scene?.pipeline || [];
  return pipeline.map(stage => ({ stage, index: memberIndex(stage.id) })).filter(row => row.index !== null).sort((a, b) => a.index - b.index).map(({ stage, index }) => {
    const role = memberRole(stage);
    const own = operations.filter(op => jobIndex(op.id) === index);
    const active = finished ? null : own.filter(op => op.status === 'running').at(-1) || null;
    const running = !finished && stage.status === 'running';
    const approval = pipeline.find(row => row.id === `routing:approval:${index}`) || null;
    return { id: stage.id, index, role, label: stage.name || '', task: stage.input || '', report: stage.output || '', status: stage.status, running,
      model: stage.model || null, rounds: Number.isInteger(stage.limits?.rounds) ? stage.limits.rounds : null,
      operations: own.map(op => op.id), calls: own.length, activeOperation: active?.id || null,
      // A running member without an attributed running call stays at its role's home module.
      currentModule: active?.module || (running ? MEMBER_ROLE_MODULE[role] || 'compute' : null),
      approval: approval ? { id: approval.id, status: approval.status } : null,
      startedAt: stage.startedAt || null, finishedAt: stage.finishedAt || null };
  });
}

function evaluationFromCompletion(scene) {
  const state = scene?.completion?.task?.evaluation;
  if (!state?.contract) return null;
  try { return normalizeEvaluationSnapshot(taskEvaluationSnapshot(state)); } catch { return null; }
}
export const topQualifiedScore = snapshot => {
  const scores = (snapshot?.candidates || []).filter(row => QUALIFIED_TIERS.includes(row.tier)).map(row => row.total);
  return scores.length ? Math.max(...scores) : null;
};

// Latest live snapshot first; a finished scene without one (recorded before
// plan C, or synced from a device whose frozen v1 projection omits it) falls
// back to the evaluation state in its completion receipt.
export function sceneEvaluation(scene) {
  const stages = (scene?.pipeline || []).filter(stage => /^task-evaluation:/.test(stage.id));
  const live = stages.map(stage => ({ id: stage.id, snapshot: normalizeEvaluationSnapshot(stage.evaluation) })).filter(row => row.snapshot);
  const series = live.map(({ id, snapshot }) => ({ id, update: snapshot.update, top: topQualifiedScore(snapshot), verified: snapshot.summary?.verified ?? 0 }));
  if (live.length) return { snapshot: live.at(-1).snapshot, stageId: live.at(-1).id, source: 'live', updates: stages.length, series };
  const completed = evaluationFromCompletion(scene);
  if (completed) return { snapshot: completed, stageId: stages.at(-1)?.id || null, source: 'completion', updates: stages.length, series: [] };
  return { snapshot: null, stageId: stages.at(-1)?.id || null, source: stages.length ? 'text' : null, updates: stages.length, series: [] };
}

// Candidates that appeared or moved to a better tier between two snapshots;
// the board animates only these, never invented movement.
export function evaluationChanges(previous, next) {
  if (!next) return [];
  const before = new Map((previous?.candidates || []).map(row => [row.key, row]));
  const rank = tier => ['excluded', 'pending', 'eligible', 'alternative', 'primary'].indexOf(tier);
  return (next.candidates || []).filter(row => !before.has(row.key) || rank(row.tier) > rank(before.get(row.key).tier))
    .map(row => ({ key: row.key, name: row.name, tier: row.tier, total: row.total, fresh: !before.has(row.key) }));
}

const PHASES = ['contract', 'dispatch', 'approval', 'evaluate', 'review', 'deliver'];
function aggregateStatus(rows) {
  if (rows.some(row => row.status === 'running')) return 'running';
  if (rows.some(row => row.status === 'waiting' || row.status === 'queued')) return 'waiting';
  const last = rows.at(-1)?.status;
  return TERMINAL_SCENE_STATUSES.includes(last) ? last : last || 'queued';
}
// Phases that actually happened, in the order they first happened.
export function sceneStageRail(scene) {
  const pipeline = scene?.pipeline || [], rows = [];
  const add = (key, stages, extra = {}) => {
    if (!stages.length) return;
    const first = Math.min(...stages.map(stage => time(stage.startedAt) ?? time(stage.finishedAt) ?? Infinity));
    rows.push({ key, count: stages.length, status: aggregateStatus(stages), stageId: stages.at(-1).id, first, ...extra });
  };
  const evaluations = pipeline.filter(stage => /^task-evaluation:/.test(stage.id));
  const contracts = evaluations.filter(stage => stage.evaluation?.contract);
  const revisions = [...new Set(contracts.map(stage => stage.evaluation.contract.revision))];
  if (contracts.length) add('contract', [contracts[0]], { revision: revisions.at(-1), revisions: revisions.length });
  else if (scene?.completion?.task?.evaluation?.contract) rows.push({ key: 'contract', count: 1, status: 'completed', stageId: evaluations[0]?.id || null, first: time(evaluations[0]?.startedAt) ?? -Infinity, revision: scene.completion.task.evaluation.contract.revision, revisions: 1 });
  add('dispatch', pipeline.filter(stage => memberIndex(stage.id) !== null));
  add('approval', pipeline.filter(stage => /^routing:approval:/.test(stage.id)));
  add('evaluate', evaluations);
  add('review', pipeline.filter(stage => /^goal-check:/.test(stage.id)));
  const stops = pipeline.filter(stage => ['budget:exhausted', 'core:stop', 'limit:delivery'].includes(stage.id));
  if (sceneFinished(scene)) rows.push({ key: 'deliver', count: 1, status: scene.status, outcome: scene.taskOutcome || scene.completion?.outcome || scene.status,
    stageId: stops.at(-1)?.id || null, stopped: stops.length > 0, first: Infinity });
  else if (stops.length) add('deliver', stops, { stopped: true, first: Infinity });
  rows.sort((a, b) => (a.key === 'deliver') - (b.key === 'deliver') || a.first - b.first || PHASES.indexOf(a.key) - PHASES.indexOf(b.key));
  const current = rows.findLast(row => row.status === 'running') || rows.at(-1) || null;
  return rows.map(({ first, ...row }) => ({ ...row, current: row === current || row.key === current?.key }));
}

const VERBS = [
  [/^(web_search|native_web_search)$/, 'search'],
  [/^(fetch_url|open_url|web_screenshot|browser_open|browser_snapshot)$|read_post|get_feed_detail|get_video_detail|get_video_comments/, 'read'],
  [/^calculator$/, 'compute'],
  [/^(file_read|glob|grep|read_history|search_history|todo_list|calendar_list_events|reminders_list|contacts_search|location_current|knowledge)$/, 'lookup'],
  [/^(file_write|file_edit|file_move|file_mkdir|file_delete|calendar_create_event|reminders_create|reminders_complete|todo_create|todo_complete)$/, 'write'],
  [/search_posts|search_feeds|search_videos/, 'search'],
];
export const operationVerb = op => VERBS.find(([pattern]) => pattern.test(String(op?.name || '')))?.[1] || 'call';

// Newest first. One row per recorded operation and per member assignment,
// evaluation update, approval, review and stop; model requests stay in the
// existing delivery records rather than flooding the log.
export function sceneLog(scene, { limit = BOARD_LOG_LIMIT } = {}) {
  if (!scene) return [];
  const start = time(scene.startedAt);
  const members = new Map(sceneMembers(scene).map(member => [member.index, member]));
  const rows = [];
  const push = (row, order) => rows.push({ ...row, order, at: row.at || null, offsetMs: start !== null && time(row.at) !== null ? Math.max(0, time(row.at) - start) : null });
  (scene.operations || []).forEach((op, i) => {
    const member = members.get(jobIndex(op.id));
    push({ id: op.id, verb: operationVerb(op), actor: member ? { role: member.role, label: member.label, index: member.index } : { role: 'lead' },
      detail: op.query || op.expression || op.input || op.resultSummary || op.name || '', name: op.name || '', status: op.status, at: op.startedAt || op.finishedAt }, 1000 + i);
  });
  (scene.pipeline || []).forEach((stage, i) => {
    const index = memberIndex(stage.id), order = 2000 + i * 2;
    if (index !== null) {
      const member = members.get(index), actor = { role: member?.role || null, label: stage.name, index };
      push({ id: stage.id, verb: 'dispatch', actor: { role: 'lead' }, target: actor, detail: stage.input || '', status: stage.status === 'running' ? 'running' : 'completed', at: stage.startedAt || stage.finishedAt }, order);
      if (stage.status !== 'running' && stage.finishedAt) push({ id: stage.id, verb: 'handoff', actor, detail: stage.output || '', status: stage.status, at: stage.finishedAt }, order + 1);
      return;
    }
    const approval = /^routing:approval:(\d+)$/.exec(stage.id);
    if (approval) { const member = members.get(Number(approval[1])); push({ id: stage.id, verb: 'approval', actor: { role: 'lead' }, target: member ? { role: member.role, label: member.label, index: member.index } : null, detail: stage.output || '', status: stage.status, at: stage.finishedAt || stage.startedAt }, order); return; }
    if (/^task-evaluation:/.test(stage.id)) {
      const snapshot = normalizeEvaluationSnapshot(stage.evaluation);
      push({ id: stage.id, verb: 'evaluate', actor: { role: 'lead' }, summary: snapshot?.summary || null, detail: snapshot ? '' : String(stage.output || '').split('\n')[0], status: stage.status, at: stage.finishedAt || stage.startedAt }, order); return;
    }
    if (/^goal-check:/.test(stage.id)) { push({ id: stage.id, verb: 'review', actor: { role: 'lead' }, detail: stage.output || '', status: stage.status, at: stage.finishedAt || stage.startedAt }, order); return; }
    if (['budget:exhausted', 'core:stop', 'limit:delivery'].includes(stage.id)) push({ id: stage.id, verb: stage.id === 'limit:delivery' ? 'deliver' : 'stop', actor: { role: 'lead' }, detail: stage.output || '', status: stage.status, at: stage.finishedAt || stage.startedAt }, order);
  });
  if (sceneFinished(scene)) push({ id: 'scene:finish', verb: 'deliver', actor: { role: 'lead' }, detail: '', outcome: scene.taskOutcome || scene.completion?.outcome || scene.status, status: scene.status, at: scene.finishedAt }, 9000);
  return rows.sort((a, b) => (time(b.at) ?? -1) - (time(a.at) ?? -1) || b.order - a.order).slice(0, limit).map(({ order, ...row }) => row);
}

// Resource ledger: what was actually used, plus the soft checkpoint from the
// evaluation policy when one exists. `now` keeps the function pure.
export function sceneResources(scene, { now = null, snapshot = null } = {}) {
  const usage = (scene?.pipeline || []).reduce((sum, stage) => ({ input: sum.input + (Number(stage.api?.usage?.input) || 0), output: sum.output + (Number(stage.api?.usage?.output) || 0) }), { input: 0, output: 0 });
  const start = time(scene?.startedAt), end = time(scene?.finishedAt) ?? (Number.isFinite(now) ? now : null);
  return { toolCalls: (scene?.operations || []).length, inputTokens: usage.input, outputTokens: usage.output,
    elapsedMs: start !== null && end !== null ? Math.max(0, end - start) : null,
    checkpoint: snapshot?.policy?.checkpoint || null, reported: snapshot?.resource || null };
}

// The board appears only when the router or the evaluator actually ran.
export const sceneHasBoard = scene => (scene?.pipeline || []).some(stage => memberIndex(stage.id) !== null || /^task-evaluation:/.test(stage.id)) || !!scene?.completion?.task?.evaluation?.contract;
