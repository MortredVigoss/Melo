// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectMemoryBook, groupBookRecords } from './viewProjectBook.js';

const project = { id: 'P', name: 'Proj' };
const records = [
  { id: 'a', text: '<script>attack</script>', section: 'decision', bookStatus: 'auto', status: 'active', sourceChatId: 'c1', sourceTitle: 'chat' },
  { id: 'b', text: 'Confirmed rule', section: 'convention', bookStatus: 'confirmed', status: 'active', sourceChatId: 'c2', sourceTitle: 'chat' },
  { id: 'c', text: 'Hand written', section: 'goal', bookStatus: 'user', status: 'active', sourceChatId: null, sourceTitle: '项目页手写' },
  { id: 'd', text: 'Stopped', section: 'todo', bookStatus: 'auto', status: 'forgotten', sourceChatId: 'c1', sourceTitle: 'chat' },
  { id: 'e', text: 'Old', section: 'todo', bookStatus: 'auto', status: 'historical', sourceChatId: 'c1', sourceTitle: 'chat' },
  { id: 'f', text: 'Conflict', section: 'weird', bookStatus: 'auto', status: 'active', needsConfirmation: true, sourceChatId: 'c1', sourceTitle: 'chat' },
];

test('groupBookRecords keeps section order, drops historical rows and routes unknown sections to progress', () => {
  const groups = groupBookRecords(records);
  assert.deepEqual(groups.map(([section]) => section), ['goal', 'convention', 'decision', 'progress', 'todo']);
  assert.deepEqual(groups.find(([s]) => s === 'progress')[1].map(r => r.id), ['f']);
  assert.ok(!groups.flatMap(([, rows]) => rows).some(r => r.id === 'e'));
});

test('renderProjectMemoryBook escapes text, shows status badges and the right actions per row', () => {
  const html = renderProjectMemoryBook(project, { records });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;attack/);
  assert.match(html, /data-project-book="P"/);
  assert.match(html, /待确认/);
  assert.match(html, />已确认</); assert.match(html, />手写</); assert.match(html, />auto</);
  // auto rows can be confirmed; confirmed / user rows cannot
  assert.match(html, /data-action="project-book-confirm" data-id="a"/);
  assert.doesNotMatch(html, /data-action="project-book-confirm" data-id="b"/);
  assert.doesNotMatch(html, /data-action="project-book-confirm" data-id="c"/);
  // section select for active rows, forget / restore buttons
  assert.match(html, /data-book-section-select="project-book-section-a"/);
  assert.match(html, /data-action="project-book-forget" data-id="a"/);
  assert.match(html, /data-action="project-book-restore" data-id="d"/);
  assert.doesNotMatch(html, /data-book-section-select="project-book-section-d"/);
  // source chat button for extracted rows, label for hand-written ones
  assert.match(html, /data-action="open-chat" data-chat-id="c1"/);
  assert.match(html, /项目页手写/);
  // hand-write form
  assert.match(html, /data-form="project-book-create" data-project-id="P"/);
  assert.match(html, /id="project-book-create-section"/);
  assert.match(html, /<option value="convention" selected>/);
});

test('renderProjectMemoryBook handles loading, empty and busy states', () => {
  assert.match(renderProjectMemoryBook(project, null), /正在读取记忆本/);
  assert.match(renderProjectMemoryBook(project, { records: [] }), /还没有记忆本内容/);
  const busy = renderProjectMemoryBook(project, { records }, { busy: true, feedback: '已确认', draft: { text: 'draft text', section: 'todo' } });
  assert.match(busy, /data-action="project-book-confirm" data-id="a" disabled/);
  assert.match(busy, /✓ 已确认/);
  assert.match(busy, /draft text/);
  assert.match(busy, /<option value="todo" selected>/);
  assert.equal(renderProjectMemoryBook(null, { records }), '');
});
