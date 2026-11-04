import { spawn } from 'node:child_process';
// Internal entry point. MCP children do not themselves monitor stdin on HTTP.
if(process.platform!=='win32') process.umask(0o077);
const child = spawn(process.argv[2], process.argv.slice(3), {stdio:'ignore',env:process.env});
let timer;
function stop() {
  if(timer) return;
  child.kill('SIGTERM');
  timer=setTimeout(()=>child.kill('SIGKILL'),1800); timer.unref();
}
process.stdin.on('end',stop).on('error',stop).resume();
process.on('SIGTERM',stop).on('SIGINT',stop);
child.on('error',()=>process.exit(1)).on('exit',code=>process.exit(code ?? 1));
