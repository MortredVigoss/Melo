import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeApproval } from './approvalMutations.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';

test('an approval is claimed once, concurrent settings survive, and completed approval retries do not rerun effects', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-approval-once-'));
  process.env.MELO_HOME = home;
  let hits = 0;
  let started;
  let finish;
  const entered = new Promise(resolve => { started = resolve; });
  const fixture = createServer((_req, res) => {
    hits += 1;
    finish = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ output: 'Once' })); };
    started();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fixture.closeAllConnections(); fixture.close(); await rm(home, { recursive: true, force: true }); });
  await updateStateAtomically(s => {
    s.externalConnectors = [{ id: 'local-fixture', name: 'Local', endpoint: `http://127.0.0.1:${fixture.address().port}` }];
    s.approvals = [{ id: 'only-once', kind: 'external-tool', status: 'pending', payload: { connectorId: 'local-fixture', toolName: 'write' } }];
  });
  const executing = executeApproval('only-once');
  await entered;
  await assert.rejects(executeApproval('only-once'), { code: 'APPROVAL_NOT_PENDING' });
  await updateStateAtomically(s => { s.settings.duringApproval = 'retained'; });
  finish();
  await executing;
  assert.equal((await executeApproval('only-once')).replayed, true);
  assert.equal(hits, 1);
  const state = await loadState();
  assert.equal(state.settings.duringApproval, 'retained');
  assert.equal(state.approvals[0].status, 'approved');
});

test('unresolved approvals survive large completed history',async()=>{
 const {normalizeApprovals}=await import('./approvalService.js');
 const pending=Array.from({length:30},(_,i)=>({id:`pending-${i}`,status:'pending',updatedAt:'2025-01-01T00:00:00Z'}));
 const completed=Array.from({length:30},(_,i)=>({id:`done-${i}`,status:'approved',updatedAt:'2026-01-01T00:00:00Z'}));
 const kept=normalizeApprovals([...pending,...completed]);assert.equal(kept.filter(r=>r.status==='pending').length,30);assert.equal(kept.filter(r=>r.status==='approved').length,24);
});

test('interrupted approval is recoverable for review but never automatically re-executable',async t=>{
 const {recoverApprovalRuns}=await import('./approvalService.js');const {rejectApproval}=await import('./approvalMutations.js');
 const home=await mkdtemp(join(tmpdir(),'melo-approval-recovery-'));process.env.MELO_HOME=home;t.after(()=>rm(home,{recursive:true,force:true}));
 await updateStateAtomically(s=>{s.approvals=[{id:'interrupted',kind:'command',status:'running',payload:{command:'must not run'}}];});
 await updateStateAtomically(recoverApprovalRuns);await assert.rejects(executeApproval('interrupted'),{code:'APPROVAL_NOT_PENDING'});
 assert.equal((await loadState()).approvals[0].status,'uncertain');await rejectApproval('interrupted');
 const state=await loadState();assert.equal(state.approvals[0].status,'rejected');assert.match(state.approvals[0].resultSummary,/不代表已撤销/);assert.equal(state.commandRuns.length,0);
});
