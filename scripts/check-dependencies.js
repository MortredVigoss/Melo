import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function sourceGraph(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, {withFileTypes:true})) {
      const path = resolve(dir,entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(path);
    }
  }
  await walk(root);
  const available = new Set(files), graph = new Map();
  for (const path of files) {
    const source = await readFile(path,'utf8');
    const imports = [...source.matchAll(/^(?:import|export)\s+(?:[^;'"`]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm)];
    graph.set(path,imports.map(m=>resolve(dirname(path),m[1])).filter(p=>available.has(p)));
  }
  return graph;
}

export function findCycles(graph) {
  let serial=0;
  const index=new Map(),low=new Map(),stack=[],active=new Set(),cycles=[];
  function visit(node) {
    index.set(node,serial); low.set(node,serial++); stack.push(node); active.add(node);
    for(const next of graph.get(node)||[]) {
      if(!index.has(next)) {visit(next);low.set(node,Math.min(low.get(node),low.get(next)));}
      else if(active.has(next))low.set(node,Math.min(low.get(node),index.get(next)));
    }
    if(low.get(node)===index.get(node)) {
      const group=[]; let value;
      do{value=stack.pop();active.delete(value);group.push(value);}while(value!==node);
      if(group.length>1||(graph.get(node)||[]).includes(node))cycles.push(group.sort());
    }
  }
  for(const node of graph.keys())if(!index.has(node))visit(node);
  return cycles;
}

export async function checkDependencies(root=resolve('src')) {
  const graph=await sourceGraph(root), cycles=findCycles(graph);
  if(cycles.length)throw new Error('Static import cycles:\n'+cycles.map(group=>group.map(p=>relative(root,p)).join(' -> ')).join('\n'));
  checkLayerDirections(graph, root);
  // Configuration must stay independent of provider clients and execution.
  const seen=new Set();
  function dependencies(file){if(seen.has(file))return;seen.add(file);for(const next of graph.get(file)||[])dependencies(next);}
  dependencies(resolve(root,'config.js'));
  for(const file of seen)if(/(?:^|\/)(?:openai\.js|desktopStore\.js|chatExecutionRunner\.js|stateStore\.js)$/.test(file))throw new Error(`Configuration depends on execution: ${relative(root,file)}`);
  return {modules:graph.size,cycles:0};
}
export function checkLayerDirections(graph, root) {
  for (const [file, imports] of graph) {
    const source = relative(root,file);
    for (const dependency of imports) {
      const target = relative(root,dependency);
      if (source.startsWith('state/') && target.startsWith('services/')) throw Error(`Persistence depends on application service: ${source} -> ${target}`);
      if (source.startsWith('domain/') && /^(?:services\/|state\/|persistence\/|providers\/|openai\.js$|server\.js$)/.test(target)) throw Error(`Domain depends on runtime: ${source} -> ${target}`);
      // Transport is the outermost layer; business services never reach back into it.
      if (source.startsWith('services/') && target.startsWith('http/')) throw Error(`Service depends on transport: ${source} -> ${target}`);
    }
  }
  checkTransitiveLayers(graph, root);
}

// 2026-10-17 audit A-4: the direct-edge rules above were satisfied while the
// state layer still reached services/, providers/, tools/ and openai.js two
// or three hops away (state → memory → services/chat, media → services/search).
// The closure rule makes the boundary real: nothing reachable from state/,
// persistence/ or domain/ may be an application service, transport, provider
// client or tool implementation.
const LOWER_LAYERS = /^(?:state|persistence|domain)\//;
const UPPER_LAYERS = /^(?:services\/|http\/|providers\/|tools\/|openai\.js$|server\.js$|desktopStore\.js$)/;
export function checkTransitiveLayers(graph, root) {
  const memo = new Map();
  function reach(file, via = null, seen = new Set()) {
    if (seen.has(file)) return null;
    seen.add(file);
    const target = relative(root, file);
    if (via !== null && UPPER_LAYERS.test(target)) return [file];
    if (memo.has(file)) return memo.get(file);
    for (const next of graph.get(file) || []) {
      const chain = reach(next, file, seen);
      if (chain) { memo.set(file, [file, ...chain]); return memo.get(file); }
    }
    memo.set(file, null);
    return null;
  }
  for (const file of graph.keys()) {
    const source = relative(root, file);
    if (!LOWER_LAYERS.test(source)) continue;
    const chain = reach(file);
    if (chain) throw Error(`Lower layer reaches an upper layer transitively: ${chain.map(p => relative(root, p)).join(' -> ')}`);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkDependencies()));
}
