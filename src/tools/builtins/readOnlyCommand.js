import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileReadTool } from './fileReadTool.js';
import { requestRead } from '../../safety/fileSafetyGate.js';
import { openParentDirFd, _raw as dirfd } from '../../safety/dirfdOps.js';
import { currentRequestContext } from '../../runtime/requestScope.js';
import { scopeAllowsTool } from '../../domain/agent/capabilityScope.js';

// These forms are implemented by existing read tools, not fed to a shell.
// All other argv, paths, expansions, redirects and compound commands retain
// the normal approval gate. File readers keep their sensitive-path/race checks.
export async function readOnlyCommand(command, cwd, context) {
  if (!command || /[\n\r`$|&;<>(){}\\*?]/u.test(command)) return null;
  const scope = currentRequestContext()?.capabilityScope;
  if (scope && !scopeAllowsTool(scope, 'file_read')) return null;
  let realCwd, root;
  try { realCwd = realpathSync(cwd); root = realpathSync(context.workspacePath); } catch { return null; }
  const inside = relative(root, realCwd);
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return null;
  if (/^ls(?: -(?:a|l|1|la|al|la1|al1))?$/u.test(command.trim())) {
    let fd;
    try {
      const approved = await requestRead({ path: realCwd, baseDir: root, workspacePath: root, chatId: context.chatId, signal: context.signal, sseEmitter: context.sseEmitter });
      context.signal?.throwIfAborted();
      fd = openParentDirFd(approved.resolvedTarget);
      const entries = dirfd.readdirAt(fd).filter(entry => !['.', '..'].includes(entry.name) && (command.includes('a') || !entry.name.startsWith('.')));
      const paths = entries.map(entry => entry.name + (entry.kind === 'dir' ? '/' : entry.kind === 'symlink' ? '@' : '')).sort().slice(0, 200);
      return { ok: true, output: '[Read-only workspace listing; paths only, no symlink targets followed]\n' + paths.join('\n'), meta: { count: paths.length, truncated: entries.length > paths.length } };
    } catch (error) {
      return { ok: false, output: error.message, error: error.code || 'READ_FAILED' };
    } finally { if (fd !== undefined) dirfd.closeFd(fd); }
  }
  const cat = /^cat\s+(?:--\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s'"~]+))$/u.exec(command.trim());
  if (cat) {
    const path = cat[1] || cat[2] || cat[3];
    if (path.startsWith('-') || path.includes('~')) return null;
    return fileReadTool.run({ path: resolve(realCwd, path) }, context);
  }
  return null;
}

