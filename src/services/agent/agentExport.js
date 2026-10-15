import { join, dirname } from 'node:path';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { createAgentMarkdownFileHelpers } from '../../persistence/agentMarkdownFiles.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';

const queues = new Map();
const revisions = new Map();
async function writeExport(path, content) {
  const parent = dirname(path);
  await mkdir(parent,{recursive:true,mode:0o700});
  const staging = await mkdtemp(join(parent,'.export-'));
  try {
    const temp = join(staging,'document');
    await writeFile(temp,content ? `${content}\n` : '',{mode:0o600});
    await rename(temp,path);
  } finally { await rm(staging,{recursive:true,force:true}); }
}
// Invoke only AFTER the state transaction committed. An export failure never
// changes the saved Agent or causes a successful save to be reported as failed.
export function exportCommittedAgent(state,{home,agentId,scope='global',projectId=null,write=writeExport}) {
  const profile = effectiveAgentProfile(state,agentId,scope==='project'?projectId:null);
  const paths = createAgentMarkdownFileHelpers({agentsDir:join(home,'desktop','agents')}).getAgentMarkdownPaths(agentId,{scope,projectId});
  const key = paths.dir;
  const revision = Number(state._revision)||0;
  const snapshot = {instructions:profile.instructions,identity:profile.identity,soul:profile.soulMd};
  const next = (queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
    if ((revisions.get(key)||-1)>revision) return;
    await write(join(paths.dir,'AGENT.md'),snapshot.instructions);
    await write(paths.identityPath,snapshot.identity);
    await write(paths.soulPath,snapshot.soul);
    revisions.set(key,revision);
  });
  queues.set(key,next);
  const cleanup=()=>{if(queues.get(key)===next)queues.delete(key);};
  next.then(cleanup,cleanup);
  return next;
}
