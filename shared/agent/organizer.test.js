import test from 'node:test';
import assert from 'node:assert/strict';
import { organizerCommand, organizerInitial, ORGANIZER_TOOLS } from './organizer.js';
import { evaluate } from './index.js';
import { toolEffect } from './toolEffects.js';
const now = Date.parse('2026-10-26T12:00:00Z');
const command = (state, name, args, requestId = 'op', id = 'todo1') => organizerCommand({ state, name, arguments: args, now, requestId, id });
test('create, repeat request, complete, reopen and delete share stable state', () => {
  const first = command(organizerInitial(), 'todo_create', { title: 'Read', due: '2026-10-27T09:00:00+11:00', remindAt: '2026-10-27T08:50:00+11:00', reminderMode: 'alarm' });
  assert.equal(first.state.todos[0].dueAt, Date.parse('2026-10-26T22:00Z'));
  const repeat = command(first.state, 'todo_create', { title: 'Read', due: '2026-10-27T09:00:00+11:00', remindAt: '2026-10-27T08:50:00+11:00', reminderMode: 'alarm' });
  assert.equal(repeat.state.todos.length, 1); assert.equal(repeat.result.replayed, true);
  assert.throws(() => command(first.state, 'todo_create', {title: 'Other'}), /reused/);
  const done = command(first.state, 'todo_complete', {id:'todo1'}, 'done');
  assert.equal(done.state.todos[0].completed, true);
  const reopen = command(done.state, 'todo_complete', {id:'todo1', completed:false}, 'reopen');
  assert.equal(reopen.state.todos[0].completed, false);
  assert.equal(command(reopen.state, 'todo_delete', {id:'todo1'}, 'delete').state.todos.length, 0);
});
test('invalid input never mutates state and external events cannot be overwritten', () => {
  const state = organizerInitial();
  for (const args of [{title:''}, {title:'a', extra:1}, {title:'a', due:'tomorrow'}, {title:'a', reminderMode:'silent'}]) assert.throws(() => command(state,'todo_create',args));
  assert.deepEqual(state,organizerInitial());
  assert.throws(()=>command(state,'calendar_update_event',{id:'system:42',title:'overwrite'}), /read-only/);
  assert.throws(()=>command(state,'calendar_create_event',{title:'event',start:'2026-10-27T10:00Z',end:'2026-10-27T09:00Z'}),/follow/);
});
test('update preserves unspecified fields and allows clearing dates', () => {
  const state=command(organizerInitial(),'todo_create',{title:'a',notes:'keep',due:'2026-10-28T10:00Z'}).state;
  const updated=command(state,'todo_update',{id:'todo1',title:'b',due:''},'update');
  assert.equal(updated.state.todos[0].notes,'keep'); assert.equal(updated.state.todos[0].dueAt,null);
  assert.equal(updated.state.todos[0].revision,2);
});
test('query range and effects are shared across hosts', () => {
  assert.equal(toolEffect('calendar_list_events'),'read');assert.equal(toolEffect('todo_create'),'write');assert.equal(toolEffect('todo_list'),'read');
  assert.equal(new Set(ORGANIZER_TOOLS.map(row=>row.name)).size,9);
  assert.throws(()=>command(organizerInitial(),'calendar_list_events',{start:'2026-10-27T10:00Z',end:'2026-10-26T09:00Z'}));
  assert.equal(evaluate({version:1,op:'organizer',command:{state:organizerInitial(),name:'todo_create',arguments:{title:'bridge'},id:'bridge',now}}).value.state.todos[0].title,'bridge');
});
