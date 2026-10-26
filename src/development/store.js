import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const jobID = value => {
  if (!/^dev_[a-f0-9-]{36}$/.test(value || '')) throw new Error('Invalid development job ID');
  return value;
};
export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
export function createJobStore(home) {
  const root = join(home, 'development');
  const directory = id => join(root, jobID(id));
  const read = async id => JSON.parse(await readFile(join(directory(id), 'job.json'), 'utf8'));
  return {
    root, directory, read,
    async list() {
      const names = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const rows = [];
      for (const name of names.filter(name => /^dev_[a-f0-9-]{36}$/.test(name))) {
        try { rows.push(await read(name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(job) {
      job.revision = (job.revision || 0) + 1;
      job.updatedAt = new Date().toISOString();
      await mkdir(directory(job.id), { recursive: true, mode: 0o700 });
      await atomicJSON(join(directory(job.id), 'job.json'), job);
      return job;
    },
    async lock(id, action) {
      const path = join(directory(id), 'lock');
      try { await mkdir(path); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Development job is already active. Recover an interrupted job before continuing.'); throw error; }
      try { await atomicJSON(join(path, 'owner.json'), { pid: process.pid }); return await action(); }
      finally { await rm(path, { recursive: true, force: true }); }
    },
    async recoverLock(id) {
      const path = join(directory(id), 'lock');
      const owner = await readFile(join(path, 'owner.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!owner) {
        // An owner file may still be publishing. Never remove a newly acquired
        // lease simply because the second filesystem write is not visible yet.
        const exists = await readdir(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (exists) throw new Error('Job lease is incomplete; inspect it before recovery');
        return;
      }
      if (owner) {
        try { process.kill(owner.pid, 0); throw new Error('The job controller is still running'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(path, { recursive: true, force: true });
    },
  };
}
