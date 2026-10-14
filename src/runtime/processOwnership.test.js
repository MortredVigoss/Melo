import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOwnedDaemonPids } from './processOwnership.js';

test('cleanup selects this run and dead owners, never another live Melo or legacy unowned sessions', () => {
  const table = [
    '101 501 /node /lib/cliDaemon.js melo-search-p80-1234abcd',
    '102 501 /node /lib/cliDaemon.js melo-search-p90-1234abcd',
    '103 501 /node /lib/cliDaemon.js melo-shared-p70-1234abcd',
    '104 501 /node /lib/cliDaemon.js melo-search',
    '105 502 /node /lib/cliDaemon.js melo-search-p80-1234abcd',
    '106 501 /node /other.js melo-search-p80-1234abcd',
  ].join('\n');
  const opts = { uid: 501, ownNames: new Set(['melo-search-p80-1234abcd']), isAlive: pid => pid !== 70 };
  assert.deepEqual(selectOwnedDaemonPids(table, opts), [101]);
  assert.deepEqual(selectOwnedDaemonPids(table, { ...opts, includeOrphans: true }), [101, 103]);
});
