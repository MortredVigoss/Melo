import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../memory/store.js';
import { reconcileChatFacts, reconcileLegacyFacts, editMemoryFact } from '../../memory/factRecords.js';
import { memoryFacts, projectMemoryBook, createProjectMemoryBookEntry } from '../memory/memoryManagement.js';
import { saveState } from '../../state/stateStore.js';
import {
  renderProjectBook, planBookSupersession, sectionForCategory, listProjectBook, upsertProjectBookRow, createUserBookRow,
  BOOK_SECTIONS, bookStatusOf,
} from './projectMemoryBook.js';

let home, previous;
test.beforeEach(async () => { previous=process.env.MELO_HOME; home=await mkdtemp(join(tmpdir(),'melo-book-')); process.env.MELO_HOME=home; store._resetStoreForTests(); });
test.afterEach(async () => { store._resetStoreForTests(); if(previous===undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME=previous; await rm(home,{recursive:true,force:true}); });

const row = (id, text, { status='auto', section, category='decision', updatedAt='2026-10-01T00:00:00.000Z', subjectKey=null, needsConfirmation=false, validTo=null, forgotten=false } = {}) => ({
  id, kind:'session-fact', namespace:'project:P', text, updatedAt, createdAt:updatedAt,
  metadata:{ scope:'project', audience:'local', projectId:'P', category, bookStatus:status, section, subjectKey, needsConfirmation, validTo, forgotten },
});

test('sectionForCategory maps the auto categories and falls back to progress', () => {
  assert.equal(sectionForCategory('decision'),'decision');
  assert.equal(sectionForCategory('project_context'),'goal');
  assert.equal(sectionForCategory('technical_detail'),'convention');
  assert.equal(sectionForCategory('nonsense'),'progress');
  assert.deepEqual([...BOOK_SECTIONS],['goal','convention','decision','progress','todo','file']);
});

test('renderProjectBook groups by section, orders user > confirmed > auto then newest, and marks auto / 待确认 rows', () => {
  const { text, rows } = renderProjectBook([
    row('a1','auto old decision',{updatedAt:'2026-09-01T00:00:00.000Z'}),
    row('a2','auto new decision',{updatedAt:'2026-10-02T00:00:00.000Z'}),
    row('c1','confirmed decision',{status:'confirmed',updatedAt:'2026-08-01T00:00:00.000Z'}),
    row('u1','hand-written goal',{status:'user',section:'goal'}),
    row('n1','conflicting auto',{needsConfirmation:true,updatedAt:'2026-10-03T00:00:00.000Z'}),
    row('x1','retired',{validTo:'2020-01-01T00:00:00.000Z'}),
    row('f1','forgotten',{forgotten:true}),
  ]);
  const lines = text.split('\n');
  const at = needle => lines.findIndex(line => line.includes(needle));
  assert.ok(at('### 目标 (goal)') < at('hand-written goal'));
  assert.ok(at('hand-written goal') < at('### 决定 (decision)'));
  assert.ok(at('- confirmed decision') < at('- [auto][待确认] conflicting auto'));
  assert.ok(at('- [auto][待确认] conflicting auto') < at('- [auto] auto new decision'));
  assert.ok(at('- [auto] auto new decision') < at('- [auto] auto old decision'));
  assert.equal(at('retired'),-1); assert.equal(at('forgotten'),-1);
  assert.equal(rows.length,5);
  for (const r of rows) assert.ok(text.includes(r.renderedText), r.renderedText);
  assert.equal(renderProjectBook([]).text,'');
});

test('renderProjectBook overflow drops auto technical_detail/file rows first, then other auto rows, never hand-written rows', () => {
  const filler = 'x'.repeat(200);
  const rows = [
    row('u','user '+filler,{status:'user'}),
    row('c','confirmed '+filler,{status:'confirmed'}),
    row('t','tech '+filler,{category:'technical_detail',updatedAt:'2026-10-05T00:00:00.000Z'}),
    row('f','file '+filler,{section:'file',updatedAt:'2026-10-06T00:00:00.000Z'}),
    row('a','plain auto '+filler,{updatedAt:'2026-01-01T00:00:00.000Z'}),
  ];
  const full = renderProjectBook(rows,{maxTokens:100000});
  assert.equal(full.rows.length,5);
  const tight = renderProjectBook(rows,{maxTokens:150});
  const ids = tight.rows.map(r=>r.id);
  assert.ok(ids.includes('u'));
  assert.ok(!ids.includes('t') && !ids.includes('f'), `tech/file rows go first: ${ids}`);
  if (ids.length>1) assert.ok(ids.includes('c'),'confirmed survives auto rows');
});

test('renderProjectBook dedupes the same statement, keeping the higher status', () => {
  const { rows } = renderProjectBook([row('a','Use pnpm'), row('c','use  PNPM',{status:'confirmed'})]);
  assert.deepEqual(rows.map(r=>r.id),['c']);
});

test('planBookSupersession: same subjectKey retires an auto row; user/confirmed rows are never auto-superseded; same text is a duplicate', () => {
  const existing = [
    row('old-auto','Port is 8080',{subjectKey:'deploy.port'}),
    row('confirmed','Deadline Friday',{status:'confirmed',subjectKey:'deadline'}),
    row('gone','Port was 7000',{subjectKey:'deploy.port',validTo:'2020-01-01T00:00:00.000Z'}),
  ];
  const a = planBookSupersession(existing,row('new','Port is 9000',{subjectKey:'deploy.port'}));
  assert.deepEqual(a.retire.map(r=>r.id),['old-auto']); assert.equal(a.needsConfirmation,false);
  assert.equal(a.retire[0].supersededByFact,'Port is 9000'); assert.equal(a.retire[0].supersededById,'new');
  const b = planBookSupersession(existing,row('new2','Deadline Monday',{subjectKey:'deadline'}));
  assert.deepEqual(b.retire,[]); assert.equal(b.needsConfirmation,true);
  const c = planBookSupersession(existing,row('new3','Deadline Monday',{status:'user',subjectKey:'deadline'}));
  assert.deepEqual(c.retire.map(r=>r.id),['confirmed']); assert.equal(c.needsConfirmation,false);
  const d = planBookSupersession(existing,row('new4','port is 8080'));
  assert.equal(d.duplicateOf?.id,'old-auto');
});

test('reconcileChatFacts writes [auto] book rows for decision/project_context facts of a local project chat only', () => {
  const chat = { id:'c1', title:'chat one', projectId:'P', source:'desktop', messages:[{id:'m1',role:'user',content:'我们决定用 pnpm'}],
    sessionMemory:[
      {fact:'Project uses pnpm',category:'decision',sourceMessageId:'m1',subjectKey:'package.manager'},
      {fact:'Project is a desktop app',category:'project_context',sourceMessageId:'m1'},
      {fact:'User prefers short answers',category:'user_preference',sourceMessageId:'m1'},
    ] };
  reconcileChatFacts(chat,'main');
  const book = listProjectBook('P');
  assert.deepEqual(book.map(r=>r.text).sort(),['Project is a desktop app','Project uses pnpm']);
  for (const r of book) {
    assert.ok(r.id.startsWith('book:promoted:'));
    assert.equal(r.namespace,'project:P'); assert.equal(r.metadata.scope,'project'); assert.equal(r.metadata.audience,'local');
    assert.equal(r.metadata.bookStatus,'auto'); assert.equal(r.metadata.sourceChatId,'c1'); assert.equal(r.metadata.sourceMessageId,'m1');
  }
  assert.equal(book.find(r=>r.text==='Project uses pnpm').metadata.section,'decision');
  assert.equal(book.find(r=>r.text==='Project is a desktop app').metadata.section,'goal');
  // chat rows stay chat-scoped (the auto-fact contract is otherwise unchanged)
  const chatRows=[...store.iterateMemoryRecords({chatId:'c1'})].filter(r=>!r.id.startsWith('book:'));
  assert.ok(chatRows.every(r=>r.metadata.scope==='chat' && r.namespace==='chat:c1'));
  // replay is idempotent
  reconcileChatFacts(chat,'main');
  assert.equal(listProjectBook('P').length,2);
  // a remote chat of the same project never writes to the book
  reconcileChatFacts({ id:'tg', projectId:'P', source:'telegram', messages:[], sessionMemory:[{fact:'Remote decision',category:'decision'}] },'main');
  assert.equal(listProjectBook('P').length,2);
  // a chat without a project never writes to the book
  reconcileChatFacts({ id:'c2', source:'desktop', messages:[], sessionMemory:[{fact:'Loose decision',category:'decision'}] },'main');
  assert.equal(listProjectBook('P').length,2);
  // rendered text carries the [auto] marker
  assert.match(renderProjectBook(listProjectBook('P')).text,/- \[auto\] Project uses pnpm/);
});

test('a newer auto fact on the same subject supersedes the older auto book row; a confirmed row makes it 待确认', () => {
  reconcileChatFacts({ id:'c1', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 8080',category:'decision',subjectKey:'deploy.port'}] },'main');
  reconcileChatFacts({ id:'c2', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 9000',category:'decision',subjectKey:'deploy.port'}] },'main');
  let active = listProjectBook('P');
  assert.deepEqual(active.map(r=>r.text),['Port is 9000']);
  const retired = listProjectBook('P',{includeInactive:true}).find(r=>r.text==='Port is 8080');
  assert.ok(retired.metadata.validTo); assert.equal(retired.metadata.supersededByFact,'Port is 9000');
  editMemoryFact(active[0].id,{bookStatus:'confirmed'});
  assert.equal(bookStatusOf(store.getMemoriesByIds([active[0].id])[0]),'confirmed');
  reconcileChatFacts({ id:'c3', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 7777',category:'decision',subjectKey:'deploy.port'}] },'main');
  active = listProjectBook('P');
  assert.deepEqual(active.map(r=>r.text).sort(),['Port is 7777','Port is 9000']);
  const flagged = active.find(r=>r.text==='Port is 7777');
  assert.equal(flagged.metadata.needsConfirmation,true);
  assert.match(renderProjectBook(active).text,/\[auto\]\[待确认\] Port is 7777/);
  assert.match(renderProjectBook(active).text,/- Port is 9000/);
  // the same statement from yet another chat is not duplicated
  reconcileChatFacts({ id:'c4', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'port is 9000',category:'decision'}] },'main');
  assert.equal(listProjectBook('P').length,2);
});

test('manual promotion to project confirms the row; personal coerces the category; forgotten auto rows stay out', async () => {
  const chat = { id:'c1', title:'chat', projectId:'P', source:'desktop', messages:[], sessionMemory:[
    {fact:'Repo uses ESLint flat config',category:'technical_detail'},
    {fact:'Deploy decision',category:'decision'},
  ] };
  reconcileChatFacts(chat,'main');
  const tech=[...store.iterateMemoryRecords({chatId:'c1'})].find(r=>r.text==='Repo uses ESLint flat config');
  const promoted=editMemoryFact(tech.id,{scope:'project'});
  assert.equal(promoted.metadata.bookStatus,'confirmed'); assert.equal(promoted.metadata.section,'convention'); assert.equal(promoted.namespace,'project:P');
  assert.equal(editMemoryFact(tech.id,{section:'file'}).metadata.section,'file');
  assert.throws(()=>editMemoryFact(tech.id,{section:'nope'}),/分节/);
  assert.throws(()=>editMemoryFact(tech.id,{bookStatus:'user'}),/已确认/);
  const book=renderProjectBook(listProjectBook('P'));
  assert.match(book.text,/### 文件 \(file\)\n- Repo uses ESLint flat config/);
  assert.match(book.text,/- \[auto\] Deploy decision/);
  const auto=listProjectBook('P').find(r=>r.text==='Deploy decision');
  editMemoryFact(auto.id,{forgotten:true});
  assert.doesNotMatch(renderProjectBook(listProjectBook('P')).text,/Deploy decision/);
  const personal=editMemoryFact(tech.id,{scope:'personal'});
  assert.equal(personal.metadata.category,'user_preference'); assert.equal(personal.metadata.bookStatus,undefined); assert.equal(personal.namespace,'user:local');
  await saveState({projects:[{id:'P',name:'P'}],chats:[chat],settings:{}});
  const facts=await memoryFacts({});
  const projected=facts.records.find(r=>r.id===tech.id);
  assert.ok('section' in projected && 'bookStatus' in projected);
});

test('hand-written rows and the management projection', async () => {
  await saveState({projects:[{id:'P',name:'P'}],chats:[],settings:{}});
  const created=await createProjectMemoryBookEntry({projectId:'P',text:'  接口统一 snake_case ',section:'convention'});
  // Bug audit M6: the route validates the project and the section before writing.
  await assert.rejects(createProjectMemoryBookEntry({projectId:'missing',text:'x'}),/项目不存在/);
  await assert.rejects(createProjectMemoryBookEntry({projectId:'P',text:'x',section:'nope'}),/分节无效/);
  assert.equal(created.bookStatus,'user'); assert.equal(created.section,'convention'); assert.equal(created.text,'接口统一 snake_case');
  assert.throws(()=>createUserBookRow({projectId:'P',text:'接口统一 snake_case'}),/同样/);
  assert.throws(()=>createUserBookRow({projectId:'P',text:''}),/1–2000/);
  const book=await projectMemoryBook({projectId:'P'});
  assert.equal(book.records.length,1); assert.equal(book.records[0].bookStatus,'user'); assert.equal(book.records[0].sourceTitle,'项目页手写');
  await assert.rejects(projectMemoryBook({projectId:'missing'}),/项目不存在/);
  // user rows survive a snapshot rebuild like promoted rows do
  store.replaceMemories([]);
  assert.equal(listProjectBook('P').length,1);
  // ...and the startup legacy reconcile does not quarantine them for lacking a source chat
  reconcileLegacyFacts({projects:[{id:'P'}],chats:[]});
  assert.equal(listProjectBook('P').length,1);
  // user row supersedes an auto row on the same subject
  upsertProjectBookRow({id:'book:auto-x',text:'Timeout 30s',metadata:{projectId:'P',category:'decision',subjectKey:'timeout',bookStatus:'auto',audience:'local'}});
  upsertProjectBookRow({id:'book:user-y',text:'Timeout 60s',metadata:{projectId:'P',category:'decision',subjectKey:'timeout',bookStatus:'user',audience:'local'}});
  assert.deepEqual(listProjectBook('P').map(r=>r.text).sort(),['Timeout 60s','接口统一 snake_case']);
  reconcileLegacyFacts({projects:[],chats:[]});
  assert.equal(listProjectBook('P').length,0,'a deleted project quarantines its hand-written rows');
});

// ─── Bug audit 2026-10-18, section 3 (memory line) ─────────────────────────

test('M1: a hand-written row moved to personal scope survives the startup legacy reconcile and reaches the profile; 仅原对话 is rejected', async () => {
  await saveState({projects:[{id:'P',name:'P'}],chats:[],settings:{}});
  const created=await createProjectMemoryBookEntry({projectId:'P',text:'我偏好简短回答',section:'convention'});
  const personal=editMemoryFact(created.id,{scope:'personal'});
  assert.equal(personal.metadata.bookStatus,undefined); assert.equal(personal.metadata.origin,'project'); assert.equal(personal.namespace,'user:local');
  reconcileLegacyFacts({projects:[{id:'P'}],chats:[]});
  const after=store.getMemoriesByIds([created.id])[0];
  assert.equal(after.metadata.quarantined,undefined,'not quarantined for lacking a source chat');
  assert.equal(after.metadata.sourceDeleted,undefined);
  const { listPersonalProfile, renderPersonalProfile } = await import('../memory/personalProfile.js');
  assert.match(renderPersonalProfile(listPersonalProfile()).text,/我偏好简短回答/);
  // even when the project is gone: the row no longer belongs to the book
  reconcileLegacyFacts({projects:[],chats:[]});
  assert.equal(store.getMemoriesByIds([created.id])[0].metadata.quarantined,undefined);
  assert.throws(()=>editMemoryFact(created.id,{scope:'chat'}),/没有原对话/);
  // moving back to the project restores the hand-written status
  const back=editMemoryFact(created.id,{scope:'project'});
  assert.equal(back.metadata.bookStatus,'user');
  assert.equal((await memoryFacts({})).records.find(r=>r.id===created.id).sourceChatId,null);
});

test('M3: one oversized row is truncated to the budget instead of emptying the book; new hand-written / promoted rows are capped at 600 chars', async () => {
  const giant=row('g','巨'.repeat(1930),{status:'user',section:'goal'});
  const others=[row('a','auto decision'),row('c','confirmed convention',{status:'confirmed',section:'convention'})];
  const { text, rows } = renderProjectBook([giant,...others],{maxTokens:2000});
  assert.ok(text,'book is not empty');
  assert.match(text,/auto decision/); assert.match(text,/confirmed convention/);
  const rendered=rows.find(r=>r.id==='g');
  assert.ok(rendered && rendered.text.endsWith('…') && rendered.text.length<giant.text.length,'giant row rendered truncated');
  assert.ok(rows.length===3);
  await saveState({projects:[{id:'P',name:'P'}],chats:[],settings:{}});
  await assert.rejects(createProjectMemoryBookEntry({projectId:'P',text:'x'.repeat(601)}),/600/);
  const chat={ id:'c1', title:'chat', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'L'.repeat(700),category:'technical_detail'}] };
  reconcileChatFacts(chat,'main');
  const long=[...store.iterateMemoryRecords({chatId:'c1'})][0];
  assert.throws(()=>editMemoryFact(long.id,{scope:'project'}),/600/);
  assert.doesNotThrow(()=>editMemoryFact(long.id,{pinned:true}),'other edits of a long chat row still work');
});

test('M4: promoting a chat fact whose auto mirror exists confirms the mirror — a single project record, supersession applied', () => {
  const chat={ id:'c1', title:'chat', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 8080',category:'decision',subjectKey:'deploy.port'}] };
  reconcileChatFacts(chat,'main');
  reconcileChatFacts({ id:'c2', title:'two', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 9000',category:'decision',subjectKey:'deploy.port'}] },'main');
  const fact=[...store.iterateMemoryRecords({chatId:'c1'})].find(r=>!r.id.startsWith('book:'));
  const twinBefore=store.getMemoriesByIds([`book:${fact.id}`])[0];
  assert.ok(twinBefore.metadata.validTo,'c1 mirror was superseded by the newer c2 decision');
  const result=editMemoryFact(fact.id,{scope:'project'});
  assert.equal(result.id,`book:${fact.id}`); assert.equal(result.metadata.bookStatus,'confirmed'); assert.equal(result.metadata.needsConfirmation,false);
  const chatRow=store.getMemoriesByIds([fact.id])[0];
  assert.equal(chatRow.metadata.scope,'chat'); assert.equal(chatRow.namespace,'chat:c1'); assert.equal(chatRow.metadata.bookStatus,undefined);
  const project=listProjectBook('P',{includeInactive:true}).filter(r=>r.text==='Port is 8080');
  assert.equal(project.length,1,'exactly one project record for the statement');
  assert.equal(store.getMemoriesByIds([`book:${fact.id}`])[0].metadata.validTo,null,'the confirmed mirror is active again');
  // supersession: the user's confirmation retires the other row on the same subject
  const other=listProjectBook('P',{includeInactive:true}).find(r=>r.text==='Port is 9000');
  assert.ok(other.metadata.validTo); assert.equal(other.metadata.supersededById,`book:${fact.id}`);
  assert.deepEqual(listProjectBook('P').map(r=>r.text),['Port is 8080']);
  // confirming an auto row directly also applies supersession
  reconcileChatFacts({ id:'c3', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 7777',category:'decision',subjectKey:'deploy.port'}] },'main');
  const flagged=listProjectBook('P').find(r=>r.text==='Port is 7777');
  assert.equal(flagged.metadata.needsConfirmation,true);
  editMemoryFact(flagged.id,{bookStatus:'confirmed'});
  assert.deepEqual(listProjectBook('P').map(r=>r.text),['Port is 7777']);
});

test('M5: an unchanged legacy category saves; M11: 恢复使用 does not resurrect a superseded row', () => {
  reconcileChatFacts({ id:'c1', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Loose note'}] },'main');
  const loose=[...store.iterateMemoryRecords({chatId:'c1'})][0];
  assert.equal(loose.metadata.category,'general');
  assert.doesNotThrow(()=>editMemoryFact(loose.id,{text:'Loose note edited',category:'general',pinned:true}));
  assert.equal(store.getMemoriesByIds([loose.id])[0].metadata.category,'general');
  assert.throws(()=>editMemoryFact(loose.id,{category:'nonsense'}),/类别无效/);
  assert.equal(editMemoryFact(loose.id,{category:'decision'}).metadata.category,'decision');
  // M11
  reconcileChatFacts({ id:'c2', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 8080',category:'decision',subjectKey:'deploy.port'}] },'main');
  reconcileChatFacts({ id:'c3', projectId:'P', source:'desktop', messages:[], sessionMemory:[{fact:'Port is 9000',category:'decision',subjectKey:'deploy.port'}] },'main');
  const superseded=listProjectBook('P',{includeInactive:true}).find(r=>r.text==='Port is 8080');
  const supersededAt=superseded.metadata.validTo; assert.ok(supersededAt);
  editMemoryFact(superseded.id,{forgotten:true});
  const restored=editMemoryFact(superseded.id,{forgotten:false});
  assert.equal(restored.metadata.forgotten,false);
  assert.equal(restored.metadata.validTo,supersededAt,'validTo written by the supersession is kept');
  assert.deepEqual(listProjectBook('P').map(r=>r.text),['Port is 9000']);
  // a plain forgotten row still comes back active
  const active=listProjectBook('P').find(r=>r.text==='Port is 9000');
  editMemoryFact(active.id,{forgotten:true});
  assert.equal(editMemoryFact(active.id,{forgotten:false}).metadata.validTo,null);
});

test('M12: the auto mirror follows the chat into a project and across projects', () => {
  const chat={ id:'c1', title:'chat', source:'desktop', messages:[], sessionMemory:[{fact:'Project uses pnpm',category:'decision',subjectKey:'package.manager'}] };
  reconcileChatFacts(chat,'main');
  assert.equal(listProjectBook('P').length,0);
  chat.projectId='P';
  reconcileChatFacts(chat,'main');
  assert.deepEqual(listProjectBook('P').map(r=>r.text),['Project uses pnpm'],'mirror written once the chat joins a project');
  chat.projectId='Q';
  reconcileChatFacts(chat,'main');
  assert.equal(listProjectBook('P').length,0,'moved out of the old project');
  assert.deepEqual(listProjectBook('Q').map(r=>r.text),['Project uses pnpm']);
  const moved=listProjectBook('Q')[0];
  assert.equal(moved.namespace,'project:Q'); assert.equal(moved.metadata.projectId,'Q'); assert.equal(moved.metadata.bookStatus,'auto');
  // a mirror the user stopped stays where it was
  editMemoryFact(moved.id,{forgotten:true});
  chat.projectId='P';
  reconcileChatFacts(chat,'main');
  assert.equal(listProjectBook('P').length,0);
  assert.equal(store.getMemoriesByIds([moved.id])[0].metadata.projectId,'Q');
});
