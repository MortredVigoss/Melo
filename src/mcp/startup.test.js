import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initMcpServers } from './init.js';

const freeFlags = ['enablePlaywrightMcp', 'enableAntvChartMcp', 'enableMarkdown2PdfMcp', 'enableMermaidMcp'];

// Real cold processes ensure a reload cannot accidentally reuse a migrated cache.
async function inHome(config, fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-mcp-startup-'));
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const load = (patch) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { loadConfig, saveConfig } from ${JSON.stringify(new URL('../config.js', import.meta.url).href)};
    const config = await loadConfig();
    console.log(JSON.stringify(${patch ? `await saveConfig({...config, ...${JSON.stringify(patch)}})` : 'config'}));
  `], { env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1' }, encoding: 'utf8' }));
  try { await fn(load, home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('fresh installs start only the four no-fee built-in presets without a consent step', async () => {
  await inHome(null, async load => {
    const config = load();
    for (const flag of freeFlags) assert.equal(config[flag], true, flag);
    assert.equal(config.enableBrowserlessMcp, false);
    assert.equal(config.productivityMcpsConsented, true);
    let calls = 0;
    await initMcpServers({ getConfig: async () => config, bootstrap: async (servers, flags) => {
      calls++;
      assert.deepEqual(servers, {});
      for (const flag of freeFlags) assert.equal(flags[flag], true, flag);
      assert.equal(flags.enableBrowserlessMcp, false);
      return {};
    }, log: () => {} });
    assert.equal(calls, 1, 'defaults must reach runtime initialization');
  });
});

test('unfinished legacy prompt migrates; later explicit disable survives save and cold restart', async () => {
  await inHome({ productivityMcpsConsented: false, enablePlaywrightMcp: false,
    enableAntvChartMcp: false, enableMarkdown2PdfMcp: false, enableMermaidMcp: false,
    apiKey: 'fixture-key', imageSettings: { quality: 'high' },
    mcpServers: { custom: { command: 'fixture', disabled: true } },
  }, async (load, home) => {
    const config = load();
    for (const flag of freeFlags.slice(1)) assert.equal(config[flag], true, flag);
    assert.equal(config.enablePlaywrightMcp, false, 'prior browser choice is preserved');
    assert.equal(config.productivityMcpsConsented, true);
    load({ enableMermaidMcp: false });
    const restarted = load();
    assert.equal(restarted.enableMermaidMcp, false);
    assert.equal(restarted.enableAntvChartMcp, true);
    assert.equal(restarted.apiKey, 'fixture-key');
    assert.deepEqual(restarted.imageSettings, { quality: 'high' });
    assert.deepEqual(restarted.mcpServers, { custom: { command: 'fixture', disabled: true } });
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).productivityMcpsConsented, true);
  });
});

test('completed legacy choice and explicit disabled flags remain off', async () => {
  for (const extra of [{ productivityMcpsConsented: true }, {}]) {
    await inHome({ ...extra, ...Object.fromEntries(freeFlags.map(flag => [flag, false])) }, async load => {
      const config = load();
      for (const flag of freeFlags) assert.equal(config[flag], false, flag);
      assert.equal(config.productivityMcpsConsented, true);
    });
  }
});

test('test mode never launches npm servers implicitly', async () => {
  const original = process.env.MELO_TEST_MODE;
  process.env.MELO_TEST_MODE = '1';
  let reads = 0;
  try {
    // Fail before any real bootstrap could spawn. The counter proves the boundary.
    assert.deepEqual(await initMcpServers({ getConfig: async () => { reads++; throw new Error('must not read'); }, log: () => {} }), {});
    assert.equal(reads, 0);
  } finally {
    if (original === undefined) delete process.env.MELO_TEST_MODE;
    else process.env.MELO_TEST_MODE = original;
  }
});

test('native launches with a minimal PATH can start MCPs using the running Node installation', () => {
  const fixture = `
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.id) console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,
        result:request.method==='tools/list'?{tools:[{name:'fixture'}]}:{capabilities:{}}}));
    });
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {McpStdioClient} from ${JSON.stringify(new URL('./client.js', import.meta.url).href)};
    const client=new McpStdioClient({command:'node',args:['--input-type=module','-e',${JSON.stringify(fixture)}]});
    try { await client.connect(); console.log(JSON.stringify(await client.listTools())); }
    finally { client.disconnect(); }
  `], { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(result), [{ name: 'fixture' }]);
});
