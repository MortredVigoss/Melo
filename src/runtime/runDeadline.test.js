import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeadline } from './runDeadline.js';
import { createRunBudget, extendBudget } from './runBudget.js';

test('hard timeout follows a classified extension once without resetting elapsed time', () => {
  let now=0, pending, delay, cleared=0, executed=0;
  const budget=createRunBudget({now:()=>now,overrides:{deadlineMs:30}});
  const deadline=runDeadline(budget,{maxMs:45,now:()=>now,setTimer:(callback,ms)=>{pending=callback;delay=ms;return 1;},clearTimer:()=>cleared++});
  assert.equal(delay,30);
  now=3;extendBudget(budget,{deadlineMs:42});
  now=30;pending();assert.equal(deadline.signal.aborted,false);assert.equal(delay,15);
  now=45;pending();if(!deadline.signal.aborted)executed++;
  assert.equal(executed,0);assert.equal(deadline.signal.reason.name,'TimeoutError');
  deadline.dispose();assert.equal(cleared,1);
});
test('explicit shorter cap and unextended run still stop at their original deadline', () => {
  for(const cap of [5,45]) {
    let now=0,pending;
    const budget=createRunBudget({now:()=>now,overrides:{deadlineMs:30}});
    const deadline=runDeadline(budget,{maxMs:cap,now:()=>now,setTimer:callback=>{pending=callback;return 1;},clearTimer:()=>{}});
    now=Math.min(30,cap);pending();assert.equal(deadline.signal.aborted,true);
  }
});
