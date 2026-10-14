import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePostTurnTask, drainPostTurnTasks } from './postTurnTasks.js';
test('teardown waits for nested work while unrelated homes remain independent', async () => {
  let release, done = false;
  schedulePostTurnTask('/tmp/post-turn-a', async () => {
    await new Promise(resolve => { release = resolve; });
    schedulePostTurnTask('/tmp/post-turn-a', async () => { done = true; });
  });
  await drainPostTurnTasks('/tmp/post-turn-b');
  await assert.rejects(drainPostTurnTasks('/tmp/post-turn-a',{timeoutMs:10}),{code:'POST_TURN_PENDING'});
  release(); await drainPostTurnTasks('/tmp/post-turn-a'); assert.equal(done,true);
});
