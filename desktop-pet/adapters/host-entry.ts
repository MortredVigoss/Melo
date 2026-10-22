import { join } from 'node:path';
import { apply } from '../upstream/src/host/index';
import { packageRoot, dshHomeDir } from '../upstream/src/host/helper-process';
import { createStandaloneContext, createStandaloneLogger, type RegisteredRoute } from '../upstream/src/standalone/context';
import { createRequestSecurity } from '../upstream/src/standalone/request-security';
import { listenStandaloneServer } from '../upstream/src/standalone/server';
import { writeStandaloneRuntime } from '../upstream/src/standalone/runtime-state';
import { createSkinStore } from './skin-store';

const logger = createStandaloneLogger();
const home = dshHomeDir();
const skins = createSkinStore(packageRoot, home, join(packageRoot, '..', 'skins', 'winter'));
const routes: RegisteredRoute[] = [];
const port = { value: 0 };
const security = createRequestSecurity();
const context = createStandaloneContext({ port: () => port.value, routes, logger, authenticatedUrl: security.authenticatedUrl });
context.ctx.meloSelectSkin = (skin: string) => skins.select(skin);
context.ctx.meloBridge = {
  async send(text: string) {
    const base = process.env.MELO_PET_CONTROL_URL;
    const token = process.env.MELO_PET_CONTROL_TOKEN;
    if (!base || !token) throw new Error('Melo 对话连接尚未启动');
    const response = await fetch(base + '/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ text }),
    });
    const result = await response.json() as any;
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Melo 对话请求失败');
    return result;
  },
};
let stop = () => {};
const server = await listenStandaloneServer({
  routes, port: 0, logger, security,
  status: () => ({ name: 'melo-desktop-pet-dsh', pid: process.pid, port: port.value, upstream: 'PC2005-cloud/dsh-pet', skin: skins.selected }),
  onShutdown: () => stop(),
});
port.value = server.port;
const release = writeStandaloneRuntime(home, { port: server.port, token: security.token, settingsUrl: security.authenticatedUrl('http://127.0.0.1:' + server.port), pluginRoot: packageRoot });
let stopping = false;
stop = () => {
  if (stopping) return;
  stopping = true;
  void context.dispose().finally(async () => { await server.close(); release(); process.exit(0); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
apply(context.ctx);
if (context.failures.length) throw new Error(context.failures.join('; '));
console.log('[melo-pet-host] ' + JSON.stringify({ event: 'ready', port: server.port, skin: skins.selected, packageRoot }));
