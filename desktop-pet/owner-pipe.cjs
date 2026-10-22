'use strict';
// Melo starts the pet with a pipe on stdin whose only write end it holds
// (close-on-exec, like the pipe it gives its own server). A normal quit stops
// the pet through /quit first; when Melo is killed or crashes, the kernel closes
// the pipe and the pet stops on EOF instead of lingering until the next launch.
function watchOwnerPipe(stdin, env, onClosed) {
  if (!stdin || env.MELO_PET_OWNER_PIPE !== '1') return false;
  let fired = false;
  const once = () => { if (!fired) { fired = true; onClosed(); } };
  stdin.on('end', once);
  stdin.on('close', once);
  stdin.on('error', once);
  stdin.resume();
  return true;
}

module.exports = { watchOwnerPipe };
