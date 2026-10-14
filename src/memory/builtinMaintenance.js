import { repairMemoryBatch } from './repair.js';
import { collectMemoryStatus } from './status.js';
import { requestEnvironment, runWithRequestContext } from '../runtime/requestScope.js';
import { getMeloHome } from '../config.js';

// A verified staged rebuild runs in bounded batches while chat remains usable.
export function startBuiltinMaintenance(provider,{log=()=>{}}={}) {
  const home=getMeloHome(),env={...requestEnvironment()};
  let stopped=false;
  const done=runWithRequestContext({env},async()=>{
    const status=collectMemoryStatus({meloHome:home});
    if (!status.store.exists || !provider?.modelId?.startsWith('melo:') || env.MELO_MEMORY_AUTOREPAIR==='0') return;
    if(status.embedding.storedModelId===provider.modelId && status.counts.memories===status.counts.vecMemories && status.meta?.embedding_repair_required!=='1') return;
    while(!stopped){
      const result=await repairMemoryBatch({home,providerPromise:provider,batchSize:20});
      if(result.status!=='paused'){log(`[memory.builtin] ${result.status} ${result.completed}/${result.total}`);break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }).catch(error=>log(`[memory.builtin] rebuild deferred: ${error.message}`));
  return {done,stop(){stopped=true;}};
}
