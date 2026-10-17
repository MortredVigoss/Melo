import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getMeloHome, getResolvedConfig } from '../../config.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { exportMobileSnapshot, importMobileSnapshot, preloadMobileScenes } from '../remote/mobileSync.js';
import { refreshPortableWorkspace, pendingPersonaRecords } from '../chat/portableWorkspace.js';
import { validateSnapshot } from '../../../mobile-sync/protocol.js';
import { persistPortableFiles } from '../remote/mobileSync.js';
import { createAgentMarkdownFileHelpers } from '../../persistence/agentMarkdownFiles.js';

export function validateLocalArchive(value) {
  if (value?.format !== 'melo-portable-workspace' || value.version !== 1) throw new Error('请选择 Melo 导出的可迁移资料文件。');
  const snapshot = validateSnapshot(value.snapshot);
  return { snapshot, summary: { chats:snapshot.chats.length, messages:snapshot.chats.reduce((n,c)=>n+c.messages.length,0), records:snapshot.workspace?.records?.length || 0 } };
}
export async function exportLocalArchive() {
  const home = getMeloHome();
  const [state, config] = await Promise.all([loadState({home}),getResolvedConfig()]);
  const prepared = await preloadMobileScenes(state,home);
  const scenes = new Map([...prepared.values()].map(e=>[e.scene.runId,e.scene]));
  refreshPortableWorkspace(state,{config,scenes});
  if (pendingPersonaRecords(state).length) throw new Error('部分人设暂不能完整导出为兼容资料，请先单独导出 Agent Markdown。');
  return {format:'melo-portable-workspace',version:1,exportedAt:new Date().toISOString(),snapshot:exportMobileSnapshot(state,{workspace:true})};
}
export async function importLocalArchive(value) {
  const home = getMeloHome();
  const {snapshot,summary} = validateLocalArchive(value);
  const config = await getResolvedConfig();
  const getPaths = createAgentMarkdownFileHelpers({agentsDir:join(home,'desktop','agents')}).getAgentMarkdownPaths;
  await updateStateAtomically(async state=>{
    // Capture any local edits first, so conflict versions survive the merge.
    refreshPortableWorkspace(state,{config});
    importMobileSnapshot(state,snapshot,{config,home});
    await persistPortableFiles(state,getPaths);
    return state;
  },{home});
  return summary;
}
export async function extractionCache({clear=false,home=getMeloHome()}={}) {
  const directory=join(home,'media-cache');
  const result={files:0,bytes:0,removed:0};
  async function entries(path){try {return (await lstat(path)).isDirectory()?await readdir(path):[];}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  for(const shard of await entries(directory)) {
    if(!/^[a-f0-9]{2}$/.test(shard))continue;
    const path=join(directory,shard);
    for(const file of await entries(path)) {
      if(!/^[a-f0-9]{62}\.json$/.test(file))continue;
      const target=join(path,file);
      try {
        const info=await lstat(target);if(!info.isFile())continue;
        result.files++;result.bytes+=info.size;
        if(clear){await unlink(target);result.removed++;}
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }
  return result;
}
