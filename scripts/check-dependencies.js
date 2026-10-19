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
  checkBootstrapBoundary(graph, root);
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

// 2026-10-19 architecture plan P1: business operations return commit receipts;
// the whole-page desktop query (bootstrap) is assembled by transport
// (src/http/bootstrapAfterCommit.js) for legacy responses.
export const BOOTSTRAP_MODULE = 'services/desktop/bootstrap.js';
// Migrated modules must not reach the bootstrap directly or through any import
// chain, including the desktopStore.js compatibility facade.
export const BOOTSTRAP_FREE_MODULES = Object.freeze([
  'services/project/projectMutations.js',
  'services/agent/agentMutations.js',
  'services/agent/channelConnection.js', // returns updateAgentProfile's receipt
  'state/commitReceipt.js',
]);
// Composition roots and transport may build the page query.
const BOOTSTRAP_COMPOSERS = /^(?:http\/|services\/desktop\/|desktopStore\.js$|server\.js$|index\.js$)/;
// Legacy exception list: business modules that still import the bootstrap
// directly and still return it from their commands. It may only shrink: a new
// direct importer fails the check, and an entry that stops importing the
// bootstrap must be deleted here (scripts/check-dependencies.test.js pins the
// maximum length).
export const BOOTSTRAP_LEGACY_IMPORTERS = Object.freeze([
  'services/approval/approvalMutations.js', // approval create/reject/execute
  'services/chat/chatMutations.js', // chat create/update/delete
  'services/chat/sendChatMessage.js', // chat reply payload embeds the bootstrap
  'services/connector/externalConnectorMutations.js', // external connector commands
  'services/settings/desktopSettings.js', // desktop settings, connector toggles, launch state
  'services/settings/localProfile.js', // local profile save
  'services/settings/modelSettings.js', // model config and catalog refresh
  'services/skill/skillMutations.js', // skill commands
  'services/task/prepareTaskExecution.js', // task run preparation
  'services/task/taskMutations.js', // task commands
  'services/workspace/workspaceMutations.js', // workspace files, artifacts, local commands
]);

export function checkBootstrapBoundary(graph, root, { migrated = BOOTSTRAP_FREE_MODULES, legacy = BOOTSTRAP_LEGACY_IMPORTERS } = {}) {
  const bootstrap = resolve(root, BOOTSTRAP_MODULE);
  const name = file => relative(root, file);
  for (const entry of migrated) {
    if (legacy.includes(entry)) throw Error(`Bootstrap boundary: ${entry} is listed as migrated and as a legacy exception.`);
    const start = resolve(root, entry);
    if (!graph.has(start)) throw Error(`Bootstrap boundary: migrated module ${entry} no longer exists; update BOOTSTRAP_FREE_MODULES.`);
    const previous = new Map([[start, null]]), queue = [start];
    while (queue.length && !previous.has(bootstrap)) {
      const file = queue.shift();
      for (const next of graph.get(file) || []) if (!previous.has(next)) { previous.set(next, file); queue.push(next); }
    }
    if (!previous.has(bootstrap)) continue;
    const chain = [];
    for (let file = bootstrap; file; file = previous.get(file)) chain.unshift(name(file));
    throw Error(`Migrated module reaches the desktop bootstrap: ${chain.join(' -> ')}. Return a commit receipt and let src/http build the bootstrap (docs/backend-architecture.md).`);
  }
  const importers = new Set([...graph].filter(([, imports]) => imports.includes(bootstrap)).map(([file]) => name(file)));
  for (const source of [...importers].sort()) {
    if (BOOTSTRAP_COMPOSERS.test(source) || legacy.includes(source)) continue;
    throw Error(`New business module imports the desktop bootstrap: ${source} -> ${BOOTSTRAP_MODULE}. Return a commit receipt; the legacy exception list may only shrink.`);
  }
  for (const entry of legacy) {
    if (!importers.has(entry)) throw Error(`Bootstrap exception list is stale: ${entry} no longer imports ${BOOTSTRAP_MODULE}; remove it from BOOTSTRAP_LEGACY_IMPORTERS.`);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkDependencies()));
}
