// What the running reply is doing right now, shown inside the chat (the side
// panel keeps the full record). Same rules as RunProgress.steps on the phone:
// only real scene steps, running ones always kept, finished ones trimmed.
// Tool labels live in ../../executionText.js (one table for the steps, the
// pills, the task space and the execution detail). Add a label there when
// registering a tool the user sees.
import { TOOL_NAMES } from '../../executionText.js';
const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 90);

export function stepState(status) {
  if (['completed', 'done', 'succeeded'].includes(status)) return 'done';
  if (['failed', 'cancelled', 'error', 'interrupted'].includes(status)) return 'failed';
  return 'running';
}

// `text` is how the caller names things in the interface language
// (executionText.js: stageName, stageOutput, toolName, callOutcome). The scene
// keeps an English fallback of a stage's name and output next to its message
// id, and a stop stage's output is a reason code: printed as recorded, a
// Chinese interface showed "Checking task delivery" and "REPEATED_TOOL_FAILURE"
// (agent audit 2026-11-10). Without `text` the recorded values are used.
export function sceneSteps(scene, limit = 6, text = {}) {
  if (!scene) return [];
  const steps = [];
  const stageTitle = stage => text.stageName?.(stage) || stage.name || stage.id;
  const stageDetail = stage => (text.stageOutput ? text.stageOutput(stage) : stage.output) || stage.input;
  const toolTitle = op => text.toolName ? text.toolName(op.name) : TOOL_NAMES[op.name] || op.name || '工具';
  for (const stage of scene.pipeline || []) {
    const detail = stage.channel === 'reasoning-summary' ? oneLine(String(stage.output || '').split('\n').filter(Boolean).at(-1)) : oneLine(stageDetail(stage));
    // Bug audit U5: a stage that only ever reported `completed` has no
    // startedAt; fall back to its finish time so the list keeps its order.
    steps.push({ id: `stage:${stage.id}`, title: stageTitle(stage), detail, state: stepState(stage.status), at: stage.startedAt || stage.finishedAt || stage.at || '' });
  }
  for (const op of scene.operations || []) {
    // A call that was refused or never ran says so before what it was asked to do.
    const detail = oneLine([text.callOutcome?.(op), op.change?.path || op.command || op.query || op.input || op.resultSummary].filter(Boolean).join(' · '));
    steps.push({ id: `op:${op.id}`, title: toolTitle(op), detail, state: stepState(op.status), at: op.startedAt || op.finishedAt || op.at || '' });
  }
  const ordered = steps.every(step => step.at) ? [...steps].sort((a, b) => a.at.localeCompare(b.at)) : steps;
  if (ordered.length <= limit) return ordered;
  const running = new Set(ordered.filter(step => step.state === 'running').map(step => step.id));
  const finished = new Set(ordered.filter(step => step.state !== 'running').slice(-Math.max(0, limit - running.size)).map(step => step.id));
  return ordered.filter(step => running.has(step.id) || finished.has(step.id));
}

export function renderRunSteps(steps, escapeHtml, translate = text => text) {
  if (!steps.length) return '';
  const icon = { running: '<span class="run-step-spinner" aria-hidden="true"></span>', done: '✓', failed: '✕' };
  return `<ol class="run-steps" aria-label="${escapeHtml(translate('正在进行的步骤'))}">${steps.map(step => `<li class="run-step is-${step.state}"><span class="run-step-icon">${icon[step.state]}</span><span class="run-step-title">${escapeHtml(translate(step.title))}</span>${step.detail ? `<span class="run-step-detail">${escapeHtml(step.detail)}</span>` : ''}</li>`).join('')}</ol>`;
}
