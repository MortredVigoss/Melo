import { AGENT_LOOP_CONTRACT } from './loopContract.js';
// Versioned, portable policy. Hosts supply observations and resource use; model
// proposals never become execution evidence, permissions or extra budget.
export const TASK_EVALUATION_POLICY = Object.freeze({
  version: 1, maxCandidates: 200, maxUpdates: 64, maxInvalidUpdates: 3, maxFields: 16,
  primaryCount: 3, alternatives: 5, primaryScore: 75, alternativeScore: 60, evidenceScore: 20,
  checkpoint: { milliseconds: 180000, calls: 20 },
  member: { initialRounds: 4, increment: 2, maxRounds: 12, calls: 8, milliseconds: 90000, deliveryReserveMs: AGENT_LOOP_CONTRACT.delivery.deadlineMs,
    inputTokens: 120000, leadInputReserve: 60000, minimumInput: 20000, parallel: 3 },
  modes: { quick: { minimum: 3, maximum: 5, initial: 8 }, standard: { minimum: 5, maximum: 10, initial: 12 }, deep: { minimum: 8, maximum: 15, initial: 20 } },
  batch: { additional: 5, explicitAdditional: 10, minimumInspected: 5, lowYield: 0.2, consecutive: 2 },
  fields: { events: ['name','startsAt','place','participation'], products: ['name','model','region','price','currency','availability'], other: ['name'] },
});
export const TASK_PROGRESS_NAME = 'task_progress';
const str = (v, max = 600) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const list = v => Array.isArray(v) ? v : [];
const normalize = v => String(v ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const fail = message => { throw new Error(message); };
const integer = (v, low, high) => Number.isInteger(v) && v >= low && v <= high;
const ruleOps = ['eq','includes','gte','lte','after','before'];
const readObservation = row => row && row.ok === true && row.executed === true && row.type !== 'handoff' &&
  !['snippet','unknown','provider','unavailable','blocked','metadata'].includes(row.reading) &&
  !['web_search','native_web_search'].includes(row.name) && str(row.text || row.output, 200000);

export const TASK_PROGRESS_DEFINITION = Object.freeze({ name: TASK_PROGRESS_NAME,
  description: `Track multi-item discovery/recommendation tasks using the original user's goal. Call alone. First action=contract; later batch after real reads, never count search hits or specialist prose. Simple facts/calculations/actions need no entity quota. data is JSON: contract {category:events|products|other,unit,mode:quick|standard|deep,explicitCount?:{value,quote},requiredFields?:[],constraints?:[{field,op:eq|includes|gte|lte|after|before,value,quote}],coverage?:[]}. Quotes must be exact user text; explicit counts/constraints cannot be lowered. Include every user condition; resolve relative dates/timezone with authorized context. Events require public participation, actual local date/place; products require model/region/price/currency/availability. batch {items:[{fields:{name:{value,evidence:[{id,quote}]},...},match:0..40,diversity:0..10,reason,tags:[],conflicts:[],excludeReason?}],gaps:[],adjustment?:{reason,evidence:[{id,quote}]}}. Prefer one item.evidence=[{id,quote}] with the full source row supporting its fields; fields can be primitive values to avoid repeating that quote. Otherwise use per-field {value,evidence}. Quote actual executed observation text supporting each field. coverage contains optional short category tags (such as outdoor or music), never full instructions; every coverage tag must appear in candidate.tags when fulfilled. Use ISO offset dates, comparable numeric price, participation=public and availability=available only when source supports it. Same event/model is one entity, even across URLs. Host returns counts, score reasons, missing fields, next batch and stop advice. Score cannot override hard conditions. At final delivery, present 3 primary options with reasons and 2–5 eligible title/link alternatives unless the user asks otherwise. Explicit counts are mandatory; insufficient results must be partial. Use returned evidence IDs in final checks.`,
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['contract','batch','status'] }, data: { type: 'string', description: 'JSON object for the selected action; {} for status.' } }, required: ['action','data'], additionalProperties: false },
});

function contractFor(raw, goal, revision) {
  const p = TASK_EVALUATION_POLICY;
  if (!raw || !Object.hasOwn(p.fields, raw.category)) fail('Specify category events, products or other.');
  const mode = Object.hasOwn(p.modes, raw.mode) ? raw.mode : 'standard';
  const explicit = raw.explicitCount;
  if (explicit && /\d/.test(str(explicit.quote)) && !str(explicit.quote).match(/\d+/g)?.includes(String(explicit.value))) fail('Explicit quantity differs from the quoted number.');
  if (explicit && (!integer(explicit.value, 1, p.maxCandidates) || !str(explicit.quote) || !goal.includes(explicit.quote))) fail('Explicit quantity needs the original user quote and a supported count. Never invent a user requirement.');
  const constraints = list(raw.constraints).map(rule => {
    if (!rule || !str(rule.field, 60) || !ruleOps.includes(rule.op) || !str(rule.quote) || !goal.includes(rule.quote) || !['string','number'].includes(typeof rule.value)) fail('Each hard constraint needs field/operator/value and an exact user quote.');
    return { field: str(rule.field, 60), op: rule.op, value: typeof rule.value === 'number' ? rule.value : str(rule.value), quote: str(rule.quote) };
  });
  if (constraints.length > p.maxFields) fail('Too many constraints; split this task without dropping requirements.');
  if (list(raw.coverage).some(tag => !str(tag) || String(tag).length > 32)) fail('coverage must contain short category tags (at most 32 characters), not full requirements. Put hard requirements in constraints.');
  const requiredFields = [...new Set([...p.fields[raw.category], ...list(raw.requiredFields).map(x => str(x,60)), ...constraints.map(r => r.field)])].filter(Boolean);
  if (requiredFields.length > p.maxFields) fail('Too many required fields.');
  return { version: p.version, revision, category: raw.category, unit: str(raw.unit,120) || raw.category, mode,
    explicitCount: explicit ? { value: explicit.value, quote: str(explicit.quote) } : null, constraints, requiredFields,
    coverage: [...new Set(list(raw.coverage).map(x => str(x,120)).filter(Boolean))].slice(0,12),
    target: explicit ? { minimum: explicit.value, maximum: explicit.value, initial: Math.min(p.maxCandidates, Math.ceil(explicit.value * 1.5)) } : { ...p.modes[mode] } };
}

function cited(field, observations) {
  if (!field || !['string','number','boolean'].includes(typeof field.value) || !String(field.value).trim() || String(field.value).length > 600) return null;
  const evidence = list(field.evidence).slice(0,2).map(ref => {
    const row = observations.find(o => o.id === ref?.id);
    const quote = str(ref?.quote,400);
    if (!readObservation(row) || !quote || quote.length < 8 && !normalize(quote).includes(normalize(field.value)) || !String(row.text || row.output).includes(quote)) return null;
    return { id: row.id, quote, ...(row.url ? { url: row.url } : {}) };
  }).filter(Boolean);
  return { value: field.value, evidence, verified: evidence.length > 0 };
}
function matches(actual, rule) {
  if (rule.op === 'eq') return normalize(actual) === normalize(rule.value);
  if (rule.op === 'includes') return normalize(actual).includes(normalize(rule.value));
  if (['gte','lte'].includes(rule.op)) return typeof actual === 'number' && typeof rule.value === 'number' && Number.isFinite(actual) && (rule.op === 'gte' ? actual >= rule.value : actual <= rule.value);
  const a = Date.parse(actual), b = Date.parse(rule.value);
  return Number.isFinite(a) && Number.isFinite(b) && (rule.op === 'after' ? a >= b : a <= b);
}
function entityKey(fields, category) {
  const names = category === 'events' ? ['name','startsAt','place'] : category === 'products' ? ['model'] : ['name'];
  return names.map(name => normalize(fields[name]?.value)).join('|');
}
function qualify(row, contract) {
  const missing = contract.requiredFields.filter(key => !row.fields[key]?.verified);
  const failed = contract.constraints.filter(rule => row.fields[rule.field]?.verified && !matches(row.fields[rule.field].value, rule)).map(rule => rule.field + ': ' + rule.op + ' ' + rule.value);
  if (contract.category === 'events') {
    if (row.fields.startsAt?.verified && (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(String(row.fields.startsAt.value)) || !Number.isFinite(Date.parse(row.fields.startsAt.value)))) failed.push('startsAt requires a local ISO date with timezone');
    if (row.fields.participation?.verified && row.fields.participation.value !== 'public') failed.push('public participation not established');
  }
  if (contract.category === 'products' && row.fields.availability?.verified && row.fields.availability.value !== 'available') failed.push('availability not established');
  const eligible = !missing.length && !failed.length && !row.conflicts.length && !row.excludeReason;
  const evidence = eligible ? 30 : 0, actionable = eligible ? 20 : 0;
  const score = { match: row.match, evidence, actionable, diversity: row.diversity, total: row.match + evidence + actionable + row.diversity, reason: row.reason };
  return { ...row, missing, failed, eligible, score, status: row.excludeReason || failed.length ? 'excluded' : eligible ? 'verified' : Object.values(row.fields).some(field => field.verified) ? 'read' : 'discovered' };
}

export function taskEvaluationSummary(state) {
  if (!state?.contract) return null;
  const p = TASK_EVALUATION_POLICY, rows = state.items || [];
  const qualified = rows.filter(row => row.eligible);
  const ranked = qualified.slice().sort((a,b) => b.score.total - a.score.total || a.key.localeCompare(b.key));
  const primary = ranked.filter(row => row.score.total >= p.primaryScore && row.score.evidence >= p.evidenceScore).slice(0,p.primaryCount);
  const alternatives = ranked.filter(row => !primary.includes(row) && row.score.total >= p.alternativeScore).slice(0,p.alternatives);
  const uncovered = state.contract.coverage.filter(tag => !qualified.some(row => row.tags.includes(tag)));
  const recent = state.batches.slice(-p.batch.consecutive);
  const diminishing = recent.length === p.batch.consecutive && recent.every(row => row.inspected >= p.batch.minimumInspected && row.newQualified / row.inspected < p.batch.lowYield);
  const missingCount = Math.max(0, state.contract.target.minimum - qualified.length);
  const adjusted = !state.contract.explicitCount && qualified.length > 0 && diminishing && !!state.adjustment?.evidence?.length;
  const gaps = [...(state.gaps || []), ...uncovered.map(tag => 'Coverage: ' + tag)];
  const sufficient = !state.stale && (!missingCount || adjusted) && primary.length > 0 && !gaps.length;
  return { version: p.version, discovered: rows.length, read: rows.filter(row => row.status !== 'discovered').length,
    verified: qualified.length, recommended: primary.length, alternatives: alternatives.length,
    explicitTarget: state.contract.explicitCount?.value || null, target: state.contract.target,
    primary: primary.map(row => row.key), alternativeKeys: alternatives.map(row => row.key),
    gaps: [...gaps, ...(missingCount && !adjusted ? [`${qualified.length}/${state.contract.target.minimum} eligible entities; ${missingCount} still missing.`] : []), ...(state.stale ? ['User amendments require a revised contract and revalidation.'] : [])],
    stop: sufficient ? 'ready_for_review' : 'continue', diminishing, adjusted,
    nextBatch: sufficient ? 0 : state.contract.explicitCount ? p.batch.explicitAdditional : p.batch.additional,
    checkpoint: state.checkpoint === true, resourceUse: state.resourceUse || {},
  };
}

export function updateTaskEvaluation(previous, args, { goal = '', revision = 1, observations = [], resourceUse = {}, mode = 'standard' } = {}) {
  const p = TASK_EVALUATION_POLICY;
  const before = previous || { version: p.version, updates: 0, items: [], batches: [], gaps: [] };
  try {
    if (before.closed || before.updates >= p.maxUpdates) fail('Progress update limit reached. Deliver existing results with honest gaps.');
    if (!args || !['contract','batch','status'].includes(args.action)) fail('Unknown task progress action.');
    let data; try { data = typeof args.data === 'string' ? JSON.parse(args.data) : args.data; } catch { fail('data must be a JSON object.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('data must be a JSON object.');
    let state = { ...before, updates: before.updates + 1, invalidUpdates: 0, closed: before.updates + 1 >= p.maxUpdates, error: null, resourceUse,
      checkpoint: Number(resourceUse.elapsedMs) >= p.checkpoint.milliseconds || Number(resourceUse.toolCalls) >= p.checkpoint.calls };
    if (args.action === 'contract') {
      if (before.contract && before.contract.revision === revision) fail('Contract is frozen for this user revision. Never lower the user goal.');
      state.contract = contractFor({ ...data, mode }, goal, revision); state.stale = false; state.gaps = []; state.batches = []; state.adjustment = null;
      state.items = before.items.map(row => qualify(row, state.contract));
    } else if (args.action === 'batch') {
      if (!state.contract || state.contract.revision !== revision || state.stale) fail('Initialize or revise the contract before recording a batch.');
      const rows = state.items.map(row => ({ ...row })), inspected = new Set(), newlyQualified = new Set();
      if (!Array.isArray(data.items) || data.items.length > 30) fail('Submit at most 30 entity candidates per batch.');
      for (const raw of data.items) {
        if (!raw || !raw.fields || typeof raw.fields !== 'object') fail('Each candidate needs fields with cited values.');
        const fields = Object.fromEntries(Object.entries(raw.fields).slice(0,p.maxFields).map(([name,field]) => [str(name,60),cited(field && typeof field === 'object' ? { ...field, evidence: field.evidence || raw.evidence } : { value: field, evidence: raw.evidence },observations)]).filter(([name,field]) => name && field));
        if (!str(String(fields.name?.value || ''))) fail('Candidate name is required.');
        const key = entityKey(fields, state.contract.category);
        if (!key.replace(/\|/g,'')) fail('Entity identity is required.');
        const oldIndex = rows.findIndex(row => row.key === key), old = rows[oldIndex];
        // Different merchants/pages merge into the same entity. Conflicts remain
        // pending until the coordinator cites a new consistent set of fields.
        const row = qualify({ key, fields: { ...(old?.fields || {}), ...fields }, match: integer(raw.match,0,40) ? raw.match : 0,
          diversity: integer(raw.diversity,0,10) ? raw.diversity : 0, reason: str(raw.reason),
          tags: list(raw.tags).map(x => str(x,120)).slice(0,12), conflicts: list(raw.conflicts).map(x=>str(x)).slice(0,12), excludeReason: str(raw.excludeReason) }, state.contract);
        if (!row.reason) { row.match = 0; row.diversity = 0; row.score.match = 0; row.score.diversity = 0; row.score.total = row.score.evidence + row.score.actionable; }
        if (!old && rows.length >= p.maxCandidates) fail('Candidate ledger is full. Deliver current scope or split the task.');
        if (oldIndex >= 0) rows[oldIndex] = row; else rows.push(row);
        // Only newly read entities count as a batch sample. Failed, snippet-only
        // and repeated reads cannot manufacture diminishing returns.
        if (!old && Object.values(row.fields).some(field => field.verified)) inspected.add(key);
        if (row.eligible && !old?.eligible) newlyQualified.add(key);
      }
      state.items = rows;
      state.batches = [...state.batches, { inspected: inspected.size, newQualified: newlyQualified.size }].slice(-20);
      state.gaps = list(data.gaps).map(x=>str(x)).filter(Boolean).slice(0,16);
      const adjustment = data.adjustment;
      if (adjustment) {
        const evidence = cited({ value: str(adjustment.reason), evidence: adjustment.evidence },observations);
        state.adjustment = evidence?.verified && str(adjustment.reason) ? { reason: str(adjustment.reason), evidence: evidence.evidence } : null;
      }
    }
    state.availableEvidence = observations.filter(row => readObservation(row)).slice(-32).map(row => ({ id:row.id, name:row.name, url:row.url, text:str(row.text || row.output,1200) }));
    state.summary = taskEvaluationSummary(state);
    return state;
  } catch (error) {
    return { ...before, updates: before.updates + 1, invalidUpdates: (before.invalidUpdates || 0) + 1, closed: before.updates + 1 >= p.maxUpdates || (before.invalidUpdates || 0) + 1 >= p.maxInvalidUpdates, error: str(error.message), summary: taskEvaluationSummary(before) };
  }
}

export function taskProgressResult(state) {
  return { ok: !state?.error, closed: state?.closed === true, error: state?.error || null, availableEvidence: state?.availableEvidence || [], contract: state?.contract, summary: taskEvaluationSummary(state),
    candidates: list(state?.items).map(row => ({ key:row.key, name:row.fields.name?.value, status:row.status, score:row.score, missing:row.missing, failed:row.failed, conflicts:row.conflicts, excludeReason:row.excludeReason,
      evidenceIds: [...new Set(Object.values(row.fields).flatMap(field=>field.evidence.map(ref=>ref.id)))] })),
    note: 'Scores rank eligible candidates; they are not probabilities. Final independent review must check source meaning and every original user requirement.' };
}

export function taskEvaluationOperation(input) {
  if (input.action === 'allocation') {
    const budget = input.budget, p = TASK_EVALUATION_POLICY.member;
    const remaining = budget ? Math.max(0,budget.maxInputTokens - (budget.used?.inputTokens || 0) - (budget.delivery?.inputTokens || 0) - (budget.pendingInput || 0) - p.leadInputReserve) : p.inputTokens;
    return { allowed: remaining >= p.minimumInput, maxInputTokens: Math.min(p.inputTokens,remaining), maxToolCalls: p.calls, deadlineMs: p.milliseconds + p.deliveryReserveMs };
  }
  if (input.action === 'presentation') return taskProgressPresentation(input.result,input.locale);
  if (input.action === 'definition') return TASK_PROGRESS_DEFINITION;
  if (input.action === 'policy') return TASK_EVALUATION_POLICY;
  if (input.action === 'result') return taskProgressResult(input.state);
  return updateTaskEvaluation(input.state,input.args,input.context);
}

export function taskProgressPresentation(result, locale = 'en') {
  const lang = String(locale).split(/[-_]/)[0];
  const words = ({ zh:['任务评估','发现','已核实','主推','备选','待补充','评分','缺少'], en:['Task evaluation','Discovered','Verified','Recommended','Alternatives','Gaps','Score','Missing'], ja:['タスク評価','発見','確認済み','おすすめ','候補','未解決','評価','不足'], ko:['작업 평가','발견','확인','추천','대안','미해결','점수','누락'], es:['Evaluación','Encontrados','Verificados','Recomendados','Alternativas','Pendiente','Puntuación','Falta'] })[lang] || ['Task evaluation','Discovered','Verified','Recommended','Alternatives','Gaps','Score','Missing'];
  const s = result?.summary;
  const count = s ? `${words[1]} ${s.discovered} · ${words[2]} ${s.verified}${s.explicitTarget ? '/' + s.explicitTarget : ''} · ${words[3]} ${s.recommended} · ${words[4]} ${s.alternatives}` : '';
  const rows = list(result?.candidates).slice(0,30).map(row => `${row.name}: ${words[6]} ${row.score.total}/100 · ${row.score.reason || ''}${row.missing.length ? ' · ' + words[7] + ': ' + row.missing.join(', ') : ''}${row.failed.length || row.conflicts.length || row.excludeReason ? ' · ' + [...row.failed,...row.conflicts,row.excludeReason].filter(Boolean).join('; ') : ''}`);
  return { name: words[0], output: [count,result?.error,...rows,...(s?.gaps?.length ? [words[5] + ': ' + s.gaps.join('; ')] : [])].filter(Boolean).join('\n') };
}
