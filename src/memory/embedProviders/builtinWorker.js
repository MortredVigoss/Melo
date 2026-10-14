import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';
env.allowRemoteModels=false;
// Inference is local-only even if a dependency attempts an implicit fetch.
globalThis.fetch=async()=>{throw new Error('Network is disabled in Melo local embeddings');};
env.useBrowserCache=false;
let extractor;
let queue=Promise.resolve();
parentPort.on('message',({id,text})=>{
  queue=queue.then(async()=>{
    try {
      extractor ||= await pipeline('feature-extraction',workerData.modelDir,{
        local_files_only:true,dtype:'q8',device:'cpu',
        session_options:{intraOpNumThreads:2,interOpNumThreads:1},
      });
      const output=await extractor(`query: ${text}`,{pooling:'mean',normalize:true,truncation:true,max_length:512});
      const native=output.data;
      if(native.length!==384 || ![...native].every(Number.isFinite)) throw new Error('Invalid built-in embedding');
      // Zero extension preserves every cosine distance exactly. The model ID
      // names this representation; old bge-m3 vectors are never compared to it.
      const vector=new Float32Array(1024);vector.set(native);
      parentPort.postMessage({id,vector},[vector.buffer]);
    }catch(error){parentPort.postMessage({id,error:error.message});}
  });
});
