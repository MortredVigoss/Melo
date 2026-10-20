// Independent, explicit expectations. A golden event transcript alone cannot
// turn a changed behavior into a passing task; these assertions must also hold.
export function scoreTaskReplay(result, expected) {
  const failures = [];
  const check = (name, actual, wanted) => { if (wanted === undefined || JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(name); };
  check('route', result.route, expected.route);
  check('outcome', result.completion.outcome, expected.outcome);
  check('reason', result.completion.reason, expected.reason);
  for (const key of ['executedTools', 'rejected', 'protocolErrors', 'modelCalls', 'attemptedCalls', 'maxRepeat', 'readSources', 'fixtureInputTokens', 'fixtureOutputTokens', 'simulatedElapsedMs']) check(key, result.metrics[key], expected[key]);
  const terminals = result.events.filter(event => event.kind === 'terminal');
  if (terminals.length !== 1 || terminals[0].outcome !== result.completion.outcome) failures.push('terminal-event');
  if (new Set(result.events.map(event => event.eventId)).size !== result.events.length) failures.push('event-identity');
  const receipts = result.events.filter(event => event.kind === 'tool' && event.phase === 'result');
  check('executed-event-count', receipts.filter(event => event.resultState !== 'not_executed').length, result.metrics.executedTools.length);
  check('refused-event-count', receipts.filter(event => event.resultState === 'not_executed').length, result.metrics.rejected.length);
  return { passed: failures.length === 0, failures };
}
