// The desktop window owns its server through a pipe on stdin. It never writes
// to it; the kernel closes it when the window process ends for any reason,
// SIGKILL and crashes included, which no signal handler can report. Only the
// window sets the flag, so a server started from a terminal keeps its TTY.
export const DESKTOP_OWNER_PIPE_ENV = 'MELO_DESKTOP_OWNER_PIPE';

export function stopWhenDesktopOwnerExits({ onOwnerGone, env = process.env, input = process.stdin }) {
  if (env[DESKTOP_OWNER_PIPE_ENV] !== '1') return false;
  // The server's own children (tools, browsers, MCP servers) are not owned by the window.
  delete env[DESKTOP_OWNER_PIPE_ENV];
  let gone = false;
  const ownerGone = () => {
    if (gone) return;
    gone = true;
    onOwnerGone();
  };
  input.on('data', () => {});
  input.once('end', ownerGone);
  input.once('error', ownerGone);
  input.resume();
  return true;
}
