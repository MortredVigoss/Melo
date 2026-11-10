import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoal, goalCandidate, goalReviewRequest, reviewGoal, goalSnapshot, goalOperation, evidenceExcerpt, candidateAnchors, GOAL_LIMITS } from './goal.js';
import { completionObservation } from './completion.js';

// 2026-11-10 latency audit L3. The completion check used to read the first
// 2 000 characters of every observation. A forecast file whose Melbourne
// section starts 9 000 characters in was therefore "not in the evidence", the
// answer built on it was sent back for another round, and the member ran out
// of rounds. The check now reads the passages closest to the candidate.

const filler = city => `<area description="${city}"><forecast-period index="1"><text type="precis">Sunny.</text><element type="air_temperature_maximum">31</element></forecast-period></area>\n`;
const melbourne = '<area description="Melbourne" aac="VIC_PT042"><forecast-period index="1" start-time-local="2026-11-11T00:00:00+11:00"><element type="air_temperature_minimum" units="Celsius">15</element><element type="air_temperature_maximum" units="Celsius">19</element><text type="precis">Partly cloudy.</text><text type="probability_of_precipitation">10%</text></forecast-period></area>\n';
// Other districts first: the Melbourne section starts well past the old 2 000-character prefix.
const forecastFile = Array.from({ length: 60 }, (_, index) => filler('District ' + index)).join('') + melbourne + Array.from({ length: 20 }, (_, index) => filler('Region ' + index)).join('');
const read = completionObservation({ id: 'read', name: 'fetch_url', ok: true, executed: true, output: forecastFile + '\n\n[source: https://fixture.invalid/IDV10450.xml] [via: direct]', data: { url: 'https://fixture.invalid/IDV10450.xml', text: forecastFile } });
const reply = '墨尔本明天（11月11日）最低 15°C，最高 19°C，Partly cloudy，降雨概率 10%。来源：https://fixture.invalid/IDV10450.xml';
const checking = (extra = {}) => goalCandidate(startGoal('明天墨尔本天气多少'), { reply, observations: read, tools: ['fetch_url'], research: true, roundsLeft: 4, ...extra });
const visible = state => JSON.parse(goalReviewRequest(state, read).messages[0].content);

test('the check reads the passage the answer relies on, not the head of the page', () => {
  assert.equal(forecastFile.indexOf('Melbourne') > 9000, true, 'the fixture really places the section past the old prefix');
  const payload = visible(checking());
  const source = payload.observations.find(row => row.id === 'read:source:0');
  assert.match(source.text, /air_temperature_minimum" units="Celsius">15</);
  assert.match(source.text, /air_temperature_maximum" units="Celsius">19</);
  assert.match(source.text, /Partly cloudy/);
  assert.equal(source.excerpted, true);
  assert.equal(source.truncated, true);
  assert.equal(source.text.length <= 6000, true);
  assert.equal(payload.observations.reduce((sum, row) => sum + row.text.length, 0) <= GOAL_LIMITS.evidenceChars, true);
  // The same inputs select the same text: reviewGoal recomputes it to validate evidence IDs.
  assert.deepEqual(visible(checking()), payload);
});

test('a verdict that cites the excerpted source is accepted', () => {
  const decided = reviewGoal(checking(), JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'fulfilled', reason: 'ok', nextStep: '',
    requirements: [{ text: '明天墨尔本气温', kind: 'external_fact', status: 'met', evidenceIds: ['read:source:0'] }] }), read);
  assert.equal(decided.decision, 'complete');
  assert.equal(decided.reason, 'GOAL_DELIVERY_SUPPORTED');
});

test('excerpts: short text is whole, text without shared terms keeps its head, the limit is never exceeded', () => {
  assert.deepEqual(evidenceExcerpt('short text', 2000, candidateAnchors('anything')), { text: 'short text', excerpted: false });
  const long = 'lorem ipsum dolor sit amet '.repeat(400);
  const head = evidenceExcerpt(long, 2000, candidateAnchors('完全无关的回答 12345'));
  assert.deepEqual(head, { text: long.slice(0, 2000), excerpted: false });
  assert.deepEqual(evidenceExcerpt(long, 2000, new Set()), head);
  const body = 'x'.repeat(4200) + ' the launch is on 2027-03-14 at Kourou ' + 'y'.repeat(4000);
  const picked = evidenceExcerpt(body, 1200, candidateAnchors('Launch date 2027-03-14, Kourou.'));
  assert.equal(picked.excerpted, true);
  assert.match(picked.text, /2027-03-14 at Kourou/);
  assert.equal(picked.text.length <= 1200, true);
  // What is left of the allowance goes to the head of the text.
  assert.equal(picked.text.startsWith('x'.repeat(100)), true);
  assert.equal(evidenceExcerpt(body, 300, candidateAnchors('2027-03-14')).text.length <= 300, true);
  assert.deepEqual(evidenceExcerpt(body, 0, candidateAnchors('2027-03-14')), { text: '', excerpted: false });
});

test('few observations share the whole allowance; many keep at least the old share until it runs out', () => {
  const page = index => completionObservation({ id: 'p' + index, name: 'calendar_list_events', ok: true, executed: true, output: ('entry ' + index + ' ').repeat(900) });
  const sizes = count => {
    const observations = Array.from({ length: count }, (_, index) => page(index)).flat();
    const state = goalCandidate(startGoal('列出我的日程'), { reply: '日程如下。', observations, tools: ['calendar_list_events'], roundsLeft: 4 });
    return JSON.parse(goalReviewRequest(state, observations).messages[0].content).observations.map(row => row.text.length);
  };
  assert.deepEqual(sizes(2), [4000, 4000], 'two tool rows are shown in full (tool rows hold 4 000 characters)');
  const many = sizes(12);
  assert.equal(many.reduce((sum, size) => sum + size, 0) <= GOAL_LIMITS.evidenceChars, true);
  assert.equal(many.at(-1) >= 2000, true, 'the newest observation keeps at least the old share');
  assert.equal(many[0], 0, 'the oldest are dropped once the allowance is used');
});

test('the reply stays compact and excerpts are explained to the checker', () => {
  const prompt = goalReviewRequest(checking(), read).systemPrompt;
  assert.match(prompt, /one short sentence in the user's language/);
  assert.match(prompt, /Keep the JSON compact/);
  assert.match(prompt, /marked excerpted/);
  assert.doesNotMatch(prompt, /uncertainClaim/, 'no claim rules without a flagged claim');
});

// The claim an answer flags as uncertain is judged by the same check.
const verdict = claim => JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'fulfilled', reason: 'ok', nextStep: '',
  requirements: [{ text: '明天墨尔本气温', kind: 'external_fact', status: 'met', evidenceIds: ['read:source:0'] }], ...(claim === undefined ? {} : { claim }) });
const flagged = () => checking({ uncertainClaim: '降雨概率 10%' });

test('a flagged claim travels to the check and its verdict needs a real quote from real evidence', () => {
  const state = flagged();
  assert.equal(state.uncertainClaim, '降雨概率 10%');
  const request = goalReviewRequest(state, read);
  assert.match(request.systemPrompt, /uncertainClaim/);
  assert.equal(JSON.parse(request.messages[0].content).uncertainClaim, '降雨概率 10%');
  const verified = reviewGoal(state, verdict({ verdict: 'VERIFIED', evidenceId: 'read:source:0', evidenceQuote: 'probability_of_precipitation">10%' }), read);
  assert.equal(verified.decision, 'complete');
  assert.deepEqual(verified.claimReview, { claim: '降雨概率 10%', verdict: 'VERIFIED', originalClaim: '', correction: '', evidenceId: 'read:source:0' });
  assert.deepEqual(goalOperation({ action: 'claimReview', state: verified }), verified.claimReview);
  // An invented quote, an invented ID, a quote that is too short or a verdict without evidence is unverified.
  for (const claim of [{ verdict: 'VERIFIED', evidenceId: 'read:source:0', evidenceQuote: 'chance of rain 10 percent' }, { verdict: 'VERIFIED', evidenceId: 'invented', evidenceQuote: '10%' },
    { verdict: 'VERIFIED', evidenceId: 'read:source:0', evidenceQuote: '1' }, { verdict: 'VERIFIED' }, { verdict: 'UNVERIFIED' }]) {
    assert.equal(reviewGoal(state, verdict(claim), read).claimReview.verdict, 'UNVERIFIED', JSON.stringify(claim));
  }
  // A check that did not judge the claim leaves no verdict: the host then runs its own verifier.
  for (const claim of ['VERIFIED', null, undefined, [], { verdict: 'MAYBE' }, { evidenceId: 'read:source:0' }]) {
    const reviewed = reviewGoal(state, verdict(claim), read);
    assert.equal(reviewed.decision, 'complete');
    assert.equal(reviewed.claimReview, undefined, JSON.stringify(claim));
    assert.equal(goalOperation({ action: 'claimReview', state: reviewed }), null);
  }
});

test('a correction must replace a sentence that is really in the candidate', () => {
  const state = flagged();
  const corrected = reviewGoal(state, verdict({ verdict: 'CORRECTED', evidenceId: 'read:source:0', evidenceQuote: 'probability_of_precipitation">10%', originalClaim: '降雨概率 10%', correction: '降雨概率为 10%' }), read);
  assert.deepEqual(corrected.claimReview, { claim: '降雨概率 10%', verdict: 'CORRECTED', originalClaim: '降雨概率 10%', correction: '降雨概率为 10%', evidenceId: 'read:source:0' });
  const foreign = reviewGoal(state, verdict({ verdict: 'CORRECTED', evidenceId: 'read:source:0', evidenceQuote: 'probability_of_precipitation">10%', originalClaim: '不在回答里的句子', correction: 'x' }), read);
  assert.equal(foreign.claimReview.verdict, 'UNVERIFIED');
});

test('the claim belongs to one candidate and never enters the persisted task', () => {
  const reviewed = reviewGoal(flagged(), verdict({ verdict: 'VERIFIED', evidenceId: 'read:source:0', evidenceQuote: 'Partly cloudy' }), read);
  assert.equal('claimReview' in goalSnapshot(reviewed), false);
  assert.equal('uncertainClaim' in goalSnapshot(reviewed), false);
  const next = goalCandidate(reviewed, { reply, observations: read, tools: ['fetch_url'], research: true, roundsLeft: 3 });
  assert.equal(next.uncertainClaim, undefined);
  assert.equal(next.claimReview, undefined);
  // Without executed observations there is nothing to judge the claim against: the host keeps its own verifier.
  const bare = goalCandidate(startGoal('明天墨尔本天气多少'), { reply, observations: [], tools: ['fetch_url'], research: true, roundsLeft: 4, uncertainClaim: '降雨概率 10%' });
  assert.equal(bare.uncertainClaim, undefined);
  assert.equal(goalOperation({ action: 'claimReview', state: bare }), null);
  // A check that asks for more work leaves no verdict behind.
  const more = reviewGoal(flagged(), JSON.stringify({ decision: 'continue', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'lookup_missing', reason: 'x', nextStep: 'read more',
    requirements: [{ text: 't', kind: 'external_fact', status: 'missing', evidenceIds: [] }], claim: { verdict: 'VERIFIED', evidenceId: 'read:source:0', evidenceQuote: 'Partly cloudy' } }), read);
  assert.equal(more.decision, 'continue');
  assert.equal(more.claimReview, undefined);
});

// 2026-11-10 agent audit. A page window is up to 20 000 characters, but a source row kept 16 000:
// a fact read in the last fifth of a full window was invisible to the completion check, which then
// reported it as missing and sent the answer back.
test('a fact near the end of a full page window is still evidence for the check', async () => {
  const { SOURCE_TEXT_CHARS } = await import('./completion.js');
  const { PAGE_WINDOW_CHARS } = await import('./pageWindow.js');
  const fact = ' The ferry to Bruny Island leaves at 09:35 from Kettering. ';
  const window = ('timetable notes and general travel advice ').repeat(600).slice(0, 18600) + fact;
  const page = (window + 'closing remarks '.repeat(200)).slice(0, PAGE_WINDOW_CHARS);
  assert.equal(page.indexOf('09:35') > 16000 && page.length === PAGE_WINDOW_CHARS, true, 'the fact really sits past the old row limit, inside one window');
  // The desktop reader appends its continuation line to the window; the row holds both.
  const desktopText = page + '\n\n[Content truncated at 20000 characters; continue with offset=20000.]';
  assert.equal(desktopText.length <= SOURCE_TEXT_CHARS, true);
  for (const text of [page, desktopText]) {
    const observations = completionObservation({ id: 'ferry', name: 'fetch_url', ok: true, executed: true, output: text.slice(0, 200), data: { url: 'https://fixture.invalid/ferry', text, truncated: true } });
    const source = observations.find(row => row.id === 'ferry:source:0');
    assert.equal(source.text.includes('09:35'), true, 'the row keeps the whole window');
    assert.equal(source.text.length, text.length);
    const answer = 'The ferry to Bruny Island leaves Kettering at 09:35. Source: https://fixture.invalid/ferry';
    const state = goalCandidate(startGoal('When does the Bruny Island ferry leave Kettering?'), { reply: answer, observations, tools: ['fetch_url'], research: true, roundsLeft: 4 });
    const shown = JSON.parse(goalReviewRequest(state, observations).messages[0].content).observations.find(row => row.id === 'ferry:source:0');
    assert.match(shown.text, /leaves at 09:35 from Kettering/, 'the check is shown the passage the answer relies on');
    const decided = reviewGoal(state, JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'fulfilled', reason: 'ok', nextStep: '',
      requirements: [{ text: 'departure time', kind: 'external_fact', status: 'met', evidenceIds: ['ferry:source:0'] }] }), observations);
    assert.equal(decided.decision, 'complete');
  }
  // Text beyond one window plus its continuation line is still bounded.
  const huge = completionObservation({ id: 'big', name: 'fetch_url', ok: true, executed: true, output: 'x', data: { url: 'https://fixture.invalid/big', text: 'z'.repeat(SOURCE_TEXT_CHARS + 500) } }).find(row => row.type === 'source');
  assert.deepEqual([huge.text.length, huge.truncated, huge.reading], [SOURCE_TEXT_CHARS, true, 'partial']);
});
