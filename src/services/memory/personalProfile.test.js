import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../memory/store.js';
import { reconcileChatFacts, editMemoryFact } from '../../memory/factRecords.js';
import { listPersonalProfile, renderPersonalProfile, PROFILE_CATEGORIES } from './personalProfile.js';

let home, previous;
test.beforeEach(async () => { previous=process.env.MELO_HOME; home=await mkdtemp(join(tmpdir(),'melo-profile-')); process.env.MELO_HOME=home; store._resetStoreForTests(); });
test.afterEach(async () => { store._resetStoreForTests(); if(previous===undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME=previous; await rm(home,{recursive:true,force:true}); });

const row = (id, text, category, { updatedAt='2026-10-01T00:00:00.000Z', subjectKey=null, scope='personal', audience='local', validTo=null } = {}) =>
  ({ id, kind:'session-fact', namespace:'user:local', text, updatedAt, metadata:{ scope, audience, category, subjectKey, validTo } });

test('renderPersonalProfile orders correction > identity > user_preference, keeps one row per subjectKey and caps rows/tokens', () => {
  const rows = [
    row('p1','User prefers terse replies','user_preference'),
    row('i1','Name: Ming','identity'),
    row('c-old','Reply in English','correction',{subjectKey:'reply.language',updatedAt:'2026-01-01T00:00:00.000Z'}),
    row('c-new','Reply in Chinese','correction',{subjectKey:'reply.language',updatedAt:'2026-10-02T00:00:00.000Z'}),
    row('d1','Decided something','decision'),
    row('x1','Expired','correction',{validTo:'2020-01-01T00:00:00.000Z'}),
    row('r1','Remote fact','correction',{audience:'remote'}),
    row('ch','Chat fact','correction',{scope:'chat'}),
  ];
  const { text, rows: rendered } = renderPersonalProfile(rows);
  assert.deepEqual(rendered.map(r=>r.id),['c-new','i1','p1']);
  assert.match(text,/- \[correction\] Reply in Chinese\n- \[identity\] Name: Ming\n- \[user_preference\] User prefers terse replies/);
  assert.match(text,/project memory book[^\n]*wins/);
  for (const r of rendered) assert.ok(text.includes(r.renderedText));
  assert.equal(renderPersonalProfile([]).text,'');
  const many = Array.from({length:20},(_,i)=>row(`m${i}`,`Preference number ${i}`,'user_preference',{updatedAt:`2026-10-${String(i+1).padStart(2,'0')}T00:00:00.000Z`}));
  assert.equal(renderPersonalProfile(many).rows.length,15);
  assert.equal(renderPersonalProfile(many,{maxRows:3}).rows.length,3);
  assert.ok(renderPersonalProfile(many,{maxTokens:60}).rows.length < 15);
});

test('listPersonalProfile reads only rows the user promoted to personal with a profile category', () => {
  const chat = { id:'c1', title:'chat', source:'desktop', messages:[], sessionMemory:[
    {fact:'User prefers dark mode',category:'user_preference'},
    {fact:'Deploy decision',category:'decision'},
    {fact:'Name: Ming',category:'identity'},
  ] };
  reconcileChatFacts(chat,'main');
  assert.deepEqual(listPersonalProfile(),[]);
  const rows=[...store.iterateMemoryRecords({chatId:'c1'})];
  editMemoryFact(rows.find(r=>r.text==='User prefers dark mode').id,{scope:'personal'});
  editMemoryFact(rows.find(r=>r.text==='Name: Ming').id,{scope:'personal'});
  const decision=editMemoryFact(rows.find(r=>r.text==='Deploy decision').id,{scope:'personal'});
  assert.equal(decision.metadata.category,'user_preference', 'non-profile categories are coerced to user_preference');
  const profile=listPersonalProfile();
  assert.deepEqual(profile.map(r=>r.text).sort(),['Deploy decision','Name: Ming','User prefers dark mode']);
  assert.ok(profile.every(r=>PROFILE_CATEGORIES.includes(r.metadata.category) && r.namespace==='user:local'));
  editMemoryFact(profile.find(r=>r.text==='Name: Ming').id,{forgotten:true});
  assert.deepEqual(listPersonalProfile().map(r=>r.text).sort(),['Deploy decision','User prefers dark mode']);
  assert.match(renderPersonalProfile(listPersonalProfile()).text,/- \[user_preference\] User prefers dark mode/);
});
