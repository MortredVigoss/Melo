import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { requestEnvironment } from '../../runtime/requestScope.js';

export const BUILTIN_MODEL_ID='melo:multilingual-e5-small:761b726d:q8:query:pad1024';
const workers=new Map();
export class BuiltinEmbedProvider {
  constructor({modelDir=requestEnvironment().MELO_EMBED_MODEL_DIR || fileURLToPath(new URL('../../../assets/models/multilingual-e5-small',import.meta.url))}={}) {this.modelDir=modelDir;}
  get modelId(){return BUILTIN_MODEL_ID;}
  get dims(){return 1024;}
  get nativeDims(){return 384;}
  async isAvailable(){return ['melo-manifest.json','tokenizer.json','onnx/model_quantized.onnx'].every(f=>existsSync(join(this.modelDir,f)));}
  async embed(text){
    const input=String(text || '').trim().slice(0,8192);if(!input || !await this.isAvailable()) return null;
    let state=workers.get(this.modelDir);
    if(!state){
      const worker=new Worker(new URL('./builtinWorker.js',import.meta.url),{workerData:{modelDir:this.modelDir},execArgv:[]});
      state={worker,pending:new Map(),next:0};workers.set(this.modelDir,state);worker.unref();
      const fail=()=>{for(const item of state.pending.values()){clearTimeout(item.timer);item.resolve(null);}state.pending.clear();if(workers.get(this.modelDir)===state)workers.delete(this.modelDir);};
      worker.on('error',fail);worker.on('exit',fail);
      worker.on('message',message=>{const item=state.pending.get(message.id);if(!item)return;clearTimeout(item.timer);state.pending.delete(message.id);item.resolve(message.error?null:message.vector);if(!state.pending.size && !state.stopping)worker.unref();});
    }
    if(state.pending.size>=100) return null;
    const id=++state.next;state.worker.ref();
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{state.pending.delete(id);resolve(null);if(!state.pending.size && !state.stopping)state.worker.unref();},60000);
      state.pending.set(id,{resolve,timer});state.worker.postMessage({id,text:input});
    });
  }
}
export async function stopBuiltinEmbeddings() {
  const stopping=[...workers.entries()];
  for (const [path,state] of stopping) {
    if(workers.get(path)===state)workers.delete(path);
    state.stopping=true;state.worker.ref();
  }
  await Promise.all(stopping.map(([,state])=>new Promise(resolve=>{
    // Let queued inference finish and release native ONNX sessions before the
    // worker exits. Force termination is only a bounded last resort.
    const timer=setTimeout(()=>{void state.worker.terminate();},5000);
    state.worker.once('exit',()=>{clearTimeout(timer);resolve();});
    state.worker.postMessage({shutdown:true});
  })));
}
