// Generates architecture/modules.json (architecture plan P0): per feature, the
// public entry modules, direct dependencies on other features, HTTP routes,
// desktop UI files, iPhone counterparts, shared contracts, tests and implicit
// dependencies. Inputs:
//   - the static import graph of scripts/check-dependencies.js (sourceGraph,
//     one call per source root; dynamic import() and packages excluded);
//   - the route registries in src/server.js and src/http/*.js;
//   - the hand-written architecture/module-annotations.json (ownership globs
//     and the edges no import shows: generators, native bridges, served
//     modules, source-reading tests, desktop↔iPhone counterparts).
// `--check` fails when the committed map is stale. scripts/scope.js and
// scripts/boundary-report.js reuse the exported helpers.
import { readFile, writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceGraph } from './check-dependencies.js';
import { discoverTests, TEST_ROOTS } from './test-discovery.js';

export const MAP_PATH = 'architecture/modules.json';
export const ANNOTATIONS_PATH = 'architecture/module-annotations.json';
export const GRAPH_ROOTS = ['src', 'desktop-ui', 'mobile-sync', 'shared'];
// Native sources; Linux test copies leave them out, so a map built without
// them is partial and may not be written or used for --check.
export const PLATFORM_ROOTS = ['ios', 'desktop-app'];
// Same pattern as sourceGraph() in check-dependencies.js. sourceGraph only
// resolves imports inside the one root it walks; this pattern adds the
// cross-root edges (mobile-sync → src, shared → src, desktop-ui → the
// /shared/*.js modules that src/server.js serves from backend sources).
const IMPORT = /^(?:import|export)\s+(?:[^;'"`]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm;
const SOURCE_READ = /readFile(?:Sync)?\(\s*(?:new URL\(|join\(|resolve\()?[^)]*\.(?:js|mjs|css|html|swift|py)['"]/;

const posix = path => path.split(sep).join('/');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const sorted = values => [...new Set(values)].sort();
const isGlob = pattern => /[*?{]/.test(pattern);

export function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]*)\}/);
  if (!match) return [pattern];
  return match[1].split(',').flatMap(option => expandBraces(pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length)));
}

export function globRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path, glob) {
  return expandBraces(glob).some(pattern => globRegExp(pattern).test(path));
}

// Exact paths beat globs; among globs the longer literal prefix wins.
export function compileOwnership(features) {
  const rules = [];
  for (const [feature, entry] of Object.entries(features)) {
    for (const glob of entry.owns) for (const pattern of expandBraces(glob)) {
      const wildcard = pattern.search(/[*?]/);
      rules.push({ feature, pattern, regex: globRegExp(pattern), specificity: wildcard < 0 ? 10000 + pattern.length : wildcard });
    }
  }
  return rules;
}

// A test belongs to the module it tests: a.b.test.js → a.b.js → a.js.
export function ownershipCandidates(path) {
  if (!path.endsWith('.test.js')) return [path];
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const parts = path.slice(dir.length, -'.test.js'.length).split('.');
  const candidates = [path];
  for (let count = parts.length; count >= 1; count -= 1) candidates.push(`${dir}${parts.slice(0, count).join('.')}.js`);
  return candidates;
}

export function ownerOf(path, rules) {
  let best = null;
  for (const candidate of ownershipCandidates(path)) {
    let local = null;
    for (const rule of rules) {
      if (!rule.regex.test(candidate)) continue;
      if (!local || rule.specificity > local.specificity) local = { ...rule, ties: [] };
      else if (rule.specificity === local.specificity && rule.feature !== local.feature) local.ties.push(rule.feature);
    }
    if (local && (!best || local.specificity > best.specificity)) best = local;
  }
  return best ? { feature: best.feature, pattern: best.pattern, ties: sorted(best.ties) } : null;
}

export async function loadAnnotations(root = process.cwd()) {
  return JSON.parse(await readFile(resolve(root, ANNOTATIONS_PATH), 'utf8'));
}

async function listFiles(root, dir, keep) {
  const out = [];
  async function walk(path) {
    let entries;
    try { entries = await readdir(resolve(root, path), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (keep(child)) out.push(child);
    }
  }
  await walk(dir);
  return out.sort();
}

export function servedModules(annotations) {
  const served = {};
  for (const entry of annotations.implicit || []) if (entry.kind === 'served-module') Object.assign(served, entry.served);
  return served;
}

// relative path → sorted relative imports, across all graph roots.
export async function buildGraph(root = process.cwd(), annotations = null) {
  const served = servedModules(annotations || await loadAnnotations(root));
  const graph = new Map();
  for (const dir of GRAPH_ROOTS) {
    if (!await exists(resolve(root, dir))) continue;
    for (const [file, imports] of await sourceGraph(resolve(root, dir))) {
      graph.set(posix(relative(root, file)), new Set(imports.map(path => posix(relative(root, path)))));
    }
  }
  for (const [file, imports] of graph) {
    const text = await readFile(resolve(root, file), 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1];
      const target = specifier.startsWith('.') ? posix(relative(root, resolve(root, dirname(file), specifier))) : served[specifier];
      if (target && graph.has(target)) imports.add(target);
    }
  }
  return new Map([...graph].sort(([a], [b]) => a.localeCompare(b)).map(([file, imports]) => [file, [...imports].sort()]));
}

export function reverseGraph(graph) {
  const reverse = new Map([...graph.keys()].map(file => [file, []]));
  for (const [file, imports] of graph) for (const target of imports) reverse.get(target)?.push(file);
  for (const list of reverse.values()) list.sort();
  return reverse;
}

export function reach(graph, start) {
  const seen = new Set();
  const stack = [...start];
  while (stack.length) {
    const file = stack.pop();
    for (const next of graph.get(file) || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  for (const file of start) seen.delete(file);
  return [...seen].sort();
}

export async function routeInventory(root = process.cwd()) {
  const httpDir = resolve(root, 'src/http');
  const files = ['src/server.js', ...(await readdir(httpDir)).filter(name => name.endsWith('.js') && !name.endsWith('.test.js')).sort().map(name => `src/http/${name}`)];
  const routes = new Map();
  const texts = await Promise.all(files.map(file => readFile(resolve(root, file), 'utf8')));
  files.forEach((file, index) => {
    const declaration = /\{\s*method:\s*['"]([A-Z]+)['"]\s*,\s*(?:paths:\s*\[([^\]]*)\]|path:\s*['"]([^'"]+)['"]|id:\s*['"]([^'"]+)['"])[\s\S]{0,600}?auth:\s*['"]([\w-]+)['"]/g;
    for (const match of texts[index].matchAll(declaration)) {
      const paths = match[2] ? [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]) : [match[3] || match[4].replace(/^[A-Z]+\s+/, '')];
      for (const path of paths) routes.set(`${match[1]} ${path}`, { method: match[1], path, auth: match[5], file });
    }
  });
  // Hand-written dispatchers (url.pathname === …, [...].includes(url.pathname)) when not registered above.
  // Matcher ids such as '/api/files/signed*' already cover their literal path.
  const declared = new Set([...routes.values()].flatMap(route => [route.path, route.path.replace(/\*.*$|\/:.*$/, '')]));
  files.forEach((file, index) => {
    const literals = [
      ...[...texts[index].matchAll(/pathname\s*===\s*['"](\/api\/[^'"]+)['"](?:\s*&&\s*request\.method\s*===\s*['"]([A-Z]+)['"])?/g)].map(match => [match[1], match[2] || '*']),
      ...[...texts[index].matchAll(/\[([^\]]*)\]\.includes\(url\.pathname\)/g)].flatMap(match => [...match[1].matchAll(/['"](\/api\/[^'"]+)['"]/g)].map(item => [item[1], '*'])),
    ];
    for (const [path, method] of literals) if (!declared.has(path)) { declared.add(path); routes.set(`${method} ${path}`, { method, path, auth: null, file }); }
  });
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function routeOwner(path, features) {
  let best = null;
  for (const [feature, entry] of Object.entries(features)) {
    for (const prefix of entry.routes || []) if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { feature, prefix };
  }
  return best?.feature || null;
}

function implicitPaths(entry) {
  const lists = [entry.generator, entry.check, entry.inputs, entry.outputs, entry.from, entry.to, entry.reads, entry.tests, entry.served && Object.values(entry.served)];
  return lists.flat().filter(value => typeof value === 'string' && value !== 'parse' && !value.startsWith('npm ') && !value.startsWith('node '));
}

async function parsedInputs(root, generator) {
  try {
    const text = await readFile(resolve(root, generator), 'utf8');
    return sorted([...text.matchAll(/['"]((?:desktop-ui|src|ios|shared|mobile-sync)\/[^'"\s]+\.[a-z]+)['"]/g)].map(match => match[1]));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Builds the map in memory. `partial` is true when ios/ or desktop-app/ is
// missing; such a map is fine for reports but must not be committed.
export async function buildModuleMap(root = process.cwd()) {
  const annotations = await loadAnnotations(root);
  const { features } = annotations;
  const rules = compileOwnership(features);
  const absentRoots = [];
  for (const dir of PLATFORM_ROOTS) if (!await exists(resolve(root, dir))) absentRoots.push(dir);
  const underAbsent = path => absentRoots.some(dir => path === dir || path.startsWith(`${dir}/`));
  const problems = [];
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

  const graph = await buildGraph(root, annotations);
  const reverse = reverseGraph(graph);
  const routes = await routeInventory(root);
  const desktopUi = await listFiles(root, 'desktop-ui', path => /\.(?:js|css|html)$/.test(path) && !path.endsWith('.test.js'));
  const desktopNative = await listFiles(root, 'desktop-app', path => path.endsWith('.swift'));
  const swift = await listFiles(root, 'ios/Melo', path => path.endsWith('.swift'));
  const swiftTests = await listFiles(root, 'ios/Tests', path => path.endsWith('.swift') && !path.endsWith('/main.swift') && !path.includes('/Fixtures/'));
  const testRoots = [];
  for (const dir of TEST_ROOTS) if (await exists(resolve(root, dir))) testRoots.push(dir);
  const jsTests = await discoverTests(root, testRoots);

  const owners = new Map();
  const own = path => {
    if (!owners.has(path)) {
      const owner = ownerOf(path, rules);
      if (owner?.ties.length) problems.push(`ambiguous ownership: ${path} → ${[owner.feature, ...owner.ties].join(' / ')} (${owner.pattern})`);
      owners.set(path, owner?.feature || null);
    }
    return owners.get(path);
  };
  const unowned = [...graph.keys(), ...desktopUi, ...desktopNative, ...swift, ...swiftTests, ...jsTests].filter(path => !own(path));

  const result = {};
  for (const [id, entry] of Object.entries(features)) {
    result[id] = { title: entry.title, kind: entry.kind || 'feature', owns: entry.owns, modules: {}, entryModules: [], dependsOn: {}, usedBy: {}, httpRoutes: [], desktopUi: [], iphone: { owned: [], counterparts: [] }, sharedContracts: [], tests: { groups: [], js: [], swift: [] }, implicit: [], notes: entry.notes || [] };
    for (const group of entry.testGroups || []) {
      if (!pkg.scripts?.[group]) problems.push(`feature ${id}: unknown npm test group ${group}`);
      result[id].tests.groups.push(`npm run ${group}`);
    }
  }
  const count = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
  for (const [file, imports] of graph) {
    const from = own(file);
    if (!from) continue;
    count(result[from].modules, file.split('/')[0]);
    for (const target of imports) {
      const to = own(target);
      if (to && to !== from) { count(result[from].dependsOn, to); count(result[to].usedBy, from); }
    }
    const importedBy = sorted(reverse.get(file).map(own).filter(owner => owner && owner !== from));
    if (importedBy.length) result[from].entryModules.push({ module: file, importedBy });
  }
  for (const route of routes) {
    const feature = routeOwner(route.path, features);
    route.feature = feature;
    if (feature) result[feature].httpRoutes.push(`${route.method} ${route.path} ← ${route.file}`);
  }
  for (const file of desktopUi) result[own(file)]?.desktopUi.push(file);
  for (const file of desktopNative) result[own(file)]?.desktopUi.push(file);
  for (const file of swift) result[own(file)]?.iphone.owned.push(file);
  for (const file of swiftTests) result[own(file)]?.tests.swift.push(file);
  for (const file of jsTests) result[own(file)]?.tests.js.push(file);

  const checkPaths = (label, paths) => {
    for (const path of paths) {
      if (isGlob(path) || underAbsent(path) || path === MAP_PATH) continue;
      if (!graph.has(path) && !desktopUi.includes(path) && !jsTests.includes(path) && !swift.includes(path) && !swiftTests.includes(path)) checkLater.push([label, path]);
    }
  };
  const checkLater = [];

  const counterparts = (annotations.counterparts || []).map(entry => {
    if (!result[entry.feature]) problems.push(`counterpart for unknown feature ${entry.feature}`);
    checkPaths(`counterpart ${entry.feature}`, [...entry.desktop, ...entry.iphone]);
    for (const file of entry.iphone) if (result[entry.feature] && !result[entry.feature].iphone.counterparts.includes(file)) result[entry.feature].iphone.counterparts.push(file);
    return { ...entry, desktopFeatures: sorted(entry.desktop.map(own).filter(Boolean)) };
  });

  const contracts = (annotations.sharedContracts || []).map(entry => {
    checkPaths(`contract ${entry.id}`, [entry.path, entry.generator, ...entry.desktop, ...entry.iphone, ...entry.tests].filter(Boolean));
    const readers = new Set(entry.desktop);
    const desktopConsumers = sorted(entry.desktop.flatMap(file => reverse.get(file) || []).filter(file => !readers.has(file)));
    const featuresOf = sorted([entry.path, ...entry.desktop, ...entry.iphone, ...desktopConsumers].map(own).filter(Boolean));
    for (const feature of featuresOf) result[feature].sharedContracts.push(entry.id);
    return { ...entry, desktopConsumers, features: featuresOf };
  });
  for (const entry of counterparts) if (entry.contract && result[entry.feature] && !result[entry.feature].sharedContracts.includes(entry.contract)) result[entry.feature].sharedContracts.push(entry.contract);

  const served = servedModules(annotations);
  const routePaths = new Set(routes.filter(route => route.method === 'GET').map(route => route.path));
  for (const [url, target] of Object.entries(served)) {
    if (!routePaths.has(url)) problems.push(`served module ${url} is not a GET route in src/server.js`);
    if (!graph.has(target)) problems.push(`served module ${url} → missing ${target}`);
  }
  const annotatedReaders = new Set();
  const implicit = [];
  for (const entry of annotations.implicit || []) {
    const resolved = { ...entry };
    if (entry.pairs) { resolved.tests = Object.keys(entry.pairs).sort(); resolved.reads = sorted(Object.values(entry.pairs).flat()); }
    if (entry.inputs === 'parse') resolved.inputs = await parsedInputs(root, entry.generator);
    if (entry.kind === 'served-module') {
      // The page modules that actually import each served URL (graph edge added in buildGraph).
      resolved.links = Object.entries(entry.served).map(([url, target]) => ({ url, target, importers: (reverse.get(target) || []).filter(file => file.startsWith('desktop-ui/')) }));
      resolved.from = sorted(resolved.links.flatMap(link => link.importers));
    }
    if (entry.kind === 'source-reading-test') for (const test of resolved.tests) annotatedReaders.add(test);
    const paths = implicitPaths(resolved);
    checkPaths(`implicit ${entry.id}`, paths);
    resolved.features = sorted(paths.filter(path => !isGlob(path)).map(own).filter(Boolean));
    for (const feature of resolved.features) result[feature].implicit.push(entry.id);
    implicit.push(resolved);
  }
  for (const [label, path] of checkLater) if (!await exists(resolve(root, path))) problems.push(`${label}: missing ${path}`);

  const detectedReaders = [];
  for (const test of jsTests) if (SOURCE_READ.test(await readFile(resolve(root, test), 'utf8'))) detectedReaders.push(test);

  for (const feature of Object.values(result)) {
    feature.sharedContracts = sorted(feature.sharedContracts);
    feature.implicit = sorted(feature.implicit);
    feature.iphone.counterparts = sorted(feature.iphone.counterparts.filter(file => !feature.iphone.owned.includes(file)));
    feature.dependsOn = Object.fromEntries(Object.entries(feature.dependsOn).sort(([a], [b]) => a.localeCompare(b)));
    feature.usedBy = Object.fromEntries(Object.entries(feature.usedBy).sort(([a], [b]) => a.localeCompare(b)));
    feature.modules = Object.fromEntries(Object.entries(feature.modules).sort(([a], [b]) => a.localeCompare(b)));
  }
  const unassignedRoutes = routes.filter(route => !route.feature).map(route => `${route.method} ${route.path}`);
  return {
    partial: absentRoots.length > 0,
    absentRoots,
    problems,
    graph,
    owners,
    rules,
    map: {
      $comment: 'Generated by scripts/generate-module-map.js from the static import graph (scripts/check-dependencies.js sourceGraph), the route registries (src/server.js, src/http/*.js) and architecture/module-annotations.json. Do not edit; run npm run generate:module-map. npm run scope -- <files> reads it as a report only.',
      summary: {
        features: Object.keys(features).filter(id => (features[id].kind || 'feature') === 'feature'),
        supportAreas: Object.keys(features).filter(id => features[id].kind === 'support'),
        graph: { modules: graph.size, edges: [...graph.values()].reduce((sum, list) => sum + list.length, 0), roots: GRAPH_ROOTS, note: '静态 import/re-export，含 desktop-ui 对 /shared/*.js 的服务映射；不含动态 import 与外部包' },
        routes: routes.length,
        unassignedRoutes,
        unownedFiles: unowned,
        sourceReadingTests: { detected: detectedReaders.length, unannotated: detectedReaders.filter(test => !annotatedReaders.has(test)) },
      },
      features: result,
      counterparts,
      sharedContracts: contracts,
      implicit,
    },
  };
}

export async function generateModuleMap({ check = false, root = process.cwd() } = {}) {
  const built = await buildModuleMap(root);
  if (built.problems.length) throw new Error(`module annotations are stale:\n${built.problems.join('\n')}`);
  if (built.partial) throw new Error(`${built.absentRoots.join(', ')} missing; a partial module map cannot be written or checked`);
  const text = `${JSON.stringify(built.map, null, 2)}\n`;
  const path = resolve(root, MAP_PATH);
  if (check) {
    let current = '';
    try { current = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== text) {
      let changed = ['(new file)'];
      try {
        const old = JSON.parse(current);
        changed = [...new Set([...Object.keys(old.features || {}), ...Object.keys(built.map.features)])].filter(id => JSON.stringify(old.features?.[id]) !== JSON.stringify(built.map.features[id]));
        for (const key of ['summary', 'counterparts', 'sharedContracts', 'implicit']) if (JSON.stringify(old[key]) !== JSON.stringify(built.map[key])) changed.push(key);
      } catch { /* unreadable old map */ }
      throw new Error(`${MAP_PATH} is stale (${changed.join(', ')}); run npm run generate:module-map`);
    }
  } else if ((await readFile(path, 'utf8').catch(() => '')) !== text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return built;
}

export async function platformSourcesAvailable(root = process.cwd()) {
  for (const dir of PLATFORM_ROOTS) if (!await exists(resolve(root, dir))) return false;
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await generateModuleMap({ check: process.argv.includes('--check') });
  const { summary } = built.map;
  console.log(`module map: ${summary.features.length} features + ${summary.supportAreas.length} support areas, ${summary.graph.modules} modules / ${summary.graph.edges} edges, ${summary.routes} routes${process.argv.includes('--check') ? ' — up to date' : ` → ${MAP_PATH}`}`);
  if (summary.unassignedRoutes.length) console.log(`unassigned routes: ${summary.unassignedRoutes.join(', ')}`);
  if (summary.unownedFiles.length) console.log(`unowned files: ${summary.unownedFiles.join(', ')}`);
}
