import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// SQLite supplies a process-owned OS lock, including crash recovery. Keep
// the legacy PID file so a running older Melo still excludes this version.
export async function acquireServerHomeLock(home) {
  await mkdir(home, { recursive: true });
  const pidPath = join(home, 'melo-desktop-server.lock');
  const readPid = async () => Number.parseInt(await readFile(pidPath, 'utf8').catch(() => ''), 10) || null;
  let db;
  try {
    db = new DatabaseSync(join(home, 'melo-desktop-server-lock.sqlite'));
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    if (error.errcode !== 5 && error.errcode !== 6) throw error;
    return { acquired: false, holderPid: await readPid() };
  }
  try {
    const existingPid = await readPid();
    if (existingPid && existingPid !== process.pid) {
      let alive = true;
      try { process.kill(existingPid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) { db.close(); return { acquired: false, holderPid: existingPid }; }
    }
    await writeFile(pidPath, String(process.pid));
    let released = false;
    return {
      acquired: true,
      async release() {
        if (released) return;
        released = true;
        try { if (await readPid() === process.pid) await unlink(pidPath); }
        finally { db.close(); }
      },
    };
  } catch (error) { db.close(); throw error; }
}
