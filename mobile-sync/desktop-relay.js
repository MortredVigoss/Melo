import { requireDeletionAcknowledgement } from './protocol.js';
// Runs alongside the desktop server. All local writes go through its transaction queue.
const endpoint = new URL(process.env.MELO_SYNC_URL || '');
if (endpoint.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname)) throw new Error('Sync requires HTTPS');
const token = process.env.MELO_SYNC_TOKEN || '';
if (token.length < 32) throw new Error('Missing sync token');
const local = `http://127.0.0.1:${Number(process.env.MELO_DESKTOP_PORT || 43127)}/api/mobile-sync`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function exchange(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`Sync request returned ${response.status}`);
  return response.json();
}
async function sync() {
  try {
    const outgoing = await exchange(local);
    const remote = await exchange(endpoint, outgoing);
    requireDeletionAcknowledgement(outgoing, remote);
    await exchange(local, remote);
    try {
      const settingsLocal=local.replace('/api/mobile-sync','/api/agent-settings-sync');
      const settingsRemote=new URL(endpoint);settingsRemote.pathname=settingsRemote.pathname.replace(/\/sync$/, '/agent-settings');
      const caps=await exchange(settingsLocal);
      const remoteCaps=await exchange(settingsRemote,caps);
      await exchange(settingsLocal,remoteCaps);
    }catch(error){console.error('Chat synced; Agent settings pending: '+error.message);}
    try {
      const memoryLocal=local.replace('/api/mobile-sync','/api/project-memory-sync');
      const memoryRemote=new URL(endpoint);memoryRemote.pathname=memoryRemote.pathname.replace(/\/sync$/, '/project-memory');
      const outgoingMemory=await exchange(memoryLocal);
      await exchange(memoryLocal,await exchange(memoryRemote,outgoingMemory));
    }catch(error){console.error('Chat synced; Project memory pending: '+error.message);}
    console.log(outgoing.workspace && remote.workspace ? 'Chat and context sync complete' : 'Chat text synced; update both sync endpoints to support roles, models, knowledge and execution sources');
  }
  catch (error) { console.error(error.message); }
}
await sync();
if (!process.argv.includes('--once')) {
  // Serial polling; never overlap an in-flight round trip.
  for (;;) { await new Promise(resolve => setTimeout(resolve, 15000)); await sync(); }
}
