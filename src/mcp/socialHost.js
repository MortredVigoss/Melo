import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { readFile, mkdir, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { socialSpec } from './socialPresets.js';

const digest = data => createHash('sha256').update(data).digest('hex');
export async function provisionSocial(id, cwd, signal) {
  const spec = socialSpec(id);
  const target = (process.platform === 'win32' ? 'windows' : process.platform) + '-' + (process.arch === 'x64' ? 'amd64' : process.arch) + (process.platform === 'win32' ? '.exe' : '');
  const hash = spec?.hashes[target];
  if (!hash) throw new Error(`No upstream binary for ${id} on ${target}.`);
  const name = spec.platform + '-mcp-' + target;
  const dir = join(cwd,'bin',spec.tag);
  const path = join(dir,name);
  await mkdir(dir,{recursive:true,mode:0o700});
  try {
    if (digest(await readFile(path)) !== hash) throw new Error('Installed MCP checksum mismatch: '+id);
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const resp = await fetch(`https://github.com/${spec.repo}/releases/download/${spec.tag}/${name}`, { signal });
    if (!resp.ok) throw new Error(`${id} download: HTTP ${resp.status}`);
    let size = 0;
    await pipeline(Readable.fromWeb(resp.body), async function*(source) { for await(const part of source) { size+=part.length; if(size>80*1024*1024) throw new Error('MCP download too large'); yield part; } },createWriteStream(tmp,{flags:'wx',mode:0o700}),{signal});
    if (digest(await readFile(tmp)) !== hash) throw new Error('MCP release checksum mismatch: '+id);
    await rename(tmp,path);
    return path;
  } finally { await rm(tmp,{force:true}); }
}
async function loopbackPort() {
  const sock = createServer();
  await new Promise((resolve,reject)=>sock.once('error',reject).listen(0,'127.0.0.1',resolve));
  const {port} = sock.address();
  await new Promise(resolve=>sock.close(resolve));
  return port;
}
function accepts(port) {
  return new Promise(resolve=>{ const s=connect(port,'127.0.0.1'); const done=ok=>{s.destroy();resolve(ok);};
    s.once('connect',()=>done(true)).once('error',()=>done(false)).setTimeout(250,()=>done(false)); });
}
export async function startSocialHost(id, cwd, {signal, onExit}) {
  // Never inherit provider keys or a user's personal browser/profile environment.
  const env = Object.fromEntries(['HOME','USERPROFILE','PATH','SystemRoot','TMPDIR','TEMP','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const spec = socialSpec(id);
  const deadline = AbortSignal.any([signal,AbortSignal.timeout(spec.platform==='xiaohongshu' ? 300000 : 90000)]);
  await mkdir(cwd,{recursive:true,mode:0o700});
  if(process.platform!=='win32') await chmod(cwd,0o700);
  const bin = await provisionSocial(id,cwd,deadline);
  const port = await loopbackPort();
  const token = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${port}/mcp`;
  deadline.throwIfAborted();
  // The supervisor also observes stdin EOF if Melo is killed without shutdown.
  const child = spawn(process.execPath,[fileURLToPath(new URL('./socialSupervisor.js',import.meta.url)),bin,'-port','127.0.0.1:'+port],{
    cwd,stdio:['pipe','ignore','ignore'],env:{...env, AUTH_TOKEN:token,
      COOKIES_PATH:join(cwd,'cookies.json'),DOUYIN_COOKIES_FILE:join(cwd,'cookies.json')}
  });
  let exited = false;
  const stop = () => { child.stdin?.end(); };
  child.stdin.on('error',()=>{});
  const end = () => { if(exited)return; exited=true; signal.removeEventListener('abort',stop); onExit(); };
  child.once('error',end).once('exit',end);
  signal.addEventListener('abort',stop,{once:true});
  try {
    while (!deadline.aborted) {
      deadline.throwIfAborted();
      if (exited) throw new Error(id+' service exited during startup');
      if (await accepts(port)) return {url,headers:{Authorization:'Bearer '+token},stop};
      await delay(250,undefined,{signal:deadline});
    }
    throw new Error(id+' did not open its local port');
  } catch(e) { stop(); throw e; }
}
