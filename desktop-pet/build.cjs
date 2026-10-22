const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const root = __dirname;
const upstream = path.join(root, 'upstream');
const alias = Object.fromEntries(['home-paths', 'credentials', 'llm'].map(name => ['@deepseek-ai/dsh-' + name, path.join(upstream, 'src/standalone/shims/dsh-' + name + '.ts')]));
async function build() {
  fs.mkdirSync(path.join(upstream, 'lib'), { recursive: true });
  await esbuild.build({ entryPoints: [path.join(root, 'adapters/host-entry.ts')], outfile: path.join(upstream, 'lib/melo-host.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', alias });
  await esbuild.build({ entryPoints: [path.join(upstream, 'src/shared/index.ts')], outfile: path.join(upstream, 'runtime/electron-helper/shared-core.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'PetShared', target: 'es2022' });
  await esbuild.build({ entryPoints: [path.join(root, 'adapters/skin-store.ts')], outfile: path.join(root, 'adapters/skin-store.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', alias });
  console.log('Original DSH host and shared renderer built.');
}
build().catch(e => { console.error(e); process.exit(1); });
