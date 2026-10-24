// Compact view of a `node --test` TAP log (2026-10-24 test-cost work). Pure:
// no IO. The daily runner feeds the JS stage log through here so an agent reads
// counts, failing names and one error line instead of thousands of passing
// assertions, and so a load-only failure can be told from a real one.
//
// A failure is "timeout class" when Node reports testTimeoutFailure, when the
// error text names a timeout, or when the rejection fired from a timer in the
// test itself (the browser tests' 15 s server-startup guard rejects that way
// with an empty error). Cancellations caused by a timed-out parent are derived,
// not failures of their own. Nothing here changes a verdict: the runner only
// uses the classification to decide whether one isolated rerun is allowed.
const TIMEOUT_TEXT = /timed out|timeout|ETIMEDOUT|TimeoutError|startup/i;

export function parseTapSummary(text = '') {
  const lines = String(text || '').split(/\r?\n/);
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const count = line.match(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
    if (count) { counts[count[1]] = Number(count[2]); continue; }
    const failed = line.match(/^(\s*)not ok \d+ - (.*)$/);
    if (!failed) continue;
    const indent = failed[1].length;
    const failure = { name: failed[2].trim(), file: '', line: null, failureType: '', error: '', stack: '', nested: indent > 0 };
    // The YAML block follows until the closing `...` at the same indentation.
    let j = i + 1;
    if (/^\s*---\s*$/.test(lines[j] || '')) {
      for (j++; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
        const body = lines[j].trim();
        let match;
        if ((match = body.match(/^location: '(.+):(\d+):\d+'$/))) { failure.file = match[1]; failure.line = Number(match[2]); }
        else if ((match = body.match(/^failureType: '([^']*)'$/))) failure.failureType = match[1];
        else if ((match = body.match(/^error: '(.*)'$/))) failure.error = match[1];
        else if (/^error: \|-?$/.test(body)) {
          const block = [];
          for (let k = j + 1; k < lines.length && /^\s{4,}/.test(lines[k]) && !/^\s*(code|stack|name|expected|actual|operator|duration_ms|type|location|failureType):/.test(lines[k].trim()); k++) block.push(lines[k].trim());
          failure.error = block.find(Boolean) || '';
        }
        else if (/^stack: \|-?$/.test(body)) failure.stack = (lines[j + 1] || '').trim();
      }
    }
    if (!failure.file && /\.test\.js$/.test(failure.name)) failure.file = failure.name;
    failures.push(failure);
  }
  return { ...counts, failures };
}

export function isTimeoutClass(failure) {
  if (!failure) return false;
  if (failure.failureType === 'testTimeoutFailure') return true;
  if (failure.failureType === 'cancelledByParent') return false;
  if (TIMEOUT_TEXT.test(failure.error || '')) return true;
  return /^Timeout\.<anonymous>/.test(failure.stack || '');
}

// Files to rerun in isolation, or null when any failure is a real one.
// `root` turns the absolute `location:` paths back into repository paths.
export function isolatedRerunFiles(summary, root = '') {
  const real = summary.failures.filter(failure => failure.failureType !== 'cancelledByParent');
  if (!real.length || !real.every(isTimeoutClass)) return null;
  const prefix = root ? String(root).replace(/\/+$/, '') + '/' : '';
  const files = new Set();
  for (const failure of summary.failures) {
    const file = failure.file.startsWith(prefix) && prefix ? failure.file.slice(prefix.length) : failure.file;
    if (/\.test\.js$/.test(file)) files.add(file);
  }
  return files.size ? [...files].sort() : null;
}

// One line per failure for the terminal and summary.json.
export function describeFailures(summary, root = '', limit = 12) {
  const prefix = root ? String(root).replace(/\/+$/, '') + '/' : '';
  return summary.failures.slice(0, limit).map(failure => {
    const file = prefix && failure.file.startsWith(prefix) ? failure.file.slice(prefix.length) : failure.file;
    const where = file ? ` [${file}${failure.line ? ':' + failure.line : ''}]` : '';
    const kind = failure.failureType === 'cancelledByParent' ? 'cancelled' : isTimeoutClass(failure) ? 'timeout' : 'failed';
    return `${kind}${where} ${failure.name}${failure.error ? ' — ' + failure.error.slice(0, 160) : ''}`;
  });
}
