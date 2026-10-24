import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function buildLaunchScreen(outputPath) {
  const [css, js, tokens] = await Promise.all([
    readFile(new URL('../desktop-ui/launchScreen.css', import.meta.url), 'utf8'),
    readFile(new URL('../desktop-ui/launchScreen.js', import.meta.url), 'utf8'),
    readFile(new URL('../desktop-ui/tokens.css', import.meta.url), 'utf8'),
  ]);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Melo</title><style>${tokens}\n${css}</style></head><body data-native-launch="true"><div id="app"></div><script type="application/json" id="melo-launch-state">__MELO_LAUNCH_STATE__</script><script>${js}</script></body></html>`;
  await writeFile(outputPath, html);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Provide the bundled launch HTML output path.');
  await buildLaunchScreen(resolve(process.argv[2]));
}
