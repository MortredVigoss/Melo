import test from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinEmbedProvider,stopBuiltinEmbeddings } from './BuiltinEmbedProvider.js';
import { getEmbeddingProvider,REGISTRY,_resetEmbeddingProviderForTests } from './createEmbeddingProvider.js';

test('missing built-in assets report unavailable instead of using another service',async()=>{
  const provider=new BuiltinEmbedProvider({modelDir:'/nonexistent/melo-model'});
  assert.equal(await provider.isAvailable(),false);assert.equal(await provider.embed('memory'),null);
});
test('default retrieval never probes external software or cloud fallback',async()=>{
  const savedEnv={...process.env};
  const savedFactories=new Map(REGISTRY);
  let externalCalls=0;
  try {
    delete process.env.MELO_EMBED_PROVIDER;
    process.env.MELO_EMBED_MODEL_DIR='/nonexistent/melo-model';
    for(const name of ['ollama','openai','http']) REGISTRY.set(name,()=>{externalCalls++;return {isAvailable:async()=>true};});
    _resetEmbeddingProviderForTests();
    assert.equal(await getEmbeddingProvider(),null);
    assert.equal(externalCalls,0);
  }finally{
    for(const name of ['MELO_EMBED_PROVIDER','MELO_EMBED_MODEL_DIR']) {
      if(savedEnv[name]===undefined) delete process.env[name]; else process.env[name]=savedEnv[name];
    }
    for(const [name,factory] of savedFactories) REGISTRY.set(name,factory);
    _resetEmbeddingProviderForTests();
  }
});
test('bundled model performs real Chinese semantic retrieval without network',async t=>{
  const provider=new BuiltinEmbedProvider();
  if(!await provider.isAvailable()){t.skip('Run the build-time prepare-memory-model script first');return;}
  try {
    const q=await provider.embed('用户喜欢什么饮料？');
    const relevant=await provider.embed('我更喜欢喝茶，不喜欢咖啡。');
    const unrelated=await provider.embed('项目使用 TypeScript，部署在本地。');
    assert.equal(q.length,1024);assert.ok([...q.slice(384)].every(n=>n===0));
    const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
    assert.ok(dot(q,relevant)>dot(q,unrelated)+0.03);
  }finally{await stopBuiltinEmbeddings();}
});
