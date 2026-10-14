import { getMeloHome } from '../../config.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
// This is a receipt, not a cache. Separate intentional calls from retransmission.
// Plain read probes can always rerun; this does not bypass their permission gate.
function repeatableRead(tool, args) {
  return tool.id === 'bash' && /^(?:cat|ls|pwd|whoami)(?:[ \t]+[A-Za-z0-9_./*?=+,:@%~-]+)*[ \t]*$/.test(args.command || '');
}
export function reserveTaskOperation({ home, taskId, tool, args, workspacePath, invocationId }) {
  if (!taskId || tool.isConcurrencySafe || tool.category === 'agent' || tool.id === 'agent') return null;
  if (tool.requiresPermission === false && tool.id !== 'bash') return null;
  if (repeatableRead(tool, args)) return null;
  const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const fingerprint = hash([taskId, tool.id, workspacePath || '', args]);
  const key = invocationId ? hash([fingerprint, invocationId]) : fingerprint;
  mkdirSync(join(home, 'desktop'), { recursive: true });
  const db = new DatabaseSync(join(home, 'desktop', 'task-operations.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, result TEXT)');
    for (const column of ['taskId', 'toolId', 'fingerprint']) {
      if (!db.prepare('PRAGMA table_info(operations)').all().some(c => c.name === column)) db.exec(`ALTER TABLE operations ADD COLUMN ${column} TEXT`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS operations_fingerprint ON operations(fingerprint)');
    db.exec('BEGIN IMMEDIATE');
    // Old receipts used the fingerprint as their primary key. Unknown effects
    // remain guarded across turns, even when the model assigns a new call id.
    const previous = db.prepare('SELECT result FROM operations WHERE key=? OR (result IS NULL AND (fingerprint=? OR key=?)) ORDER BY result IS NULL DESC LIMIT 1').get(key, fingerprint, fingerprint);
    if (previous) {
      db.exec('COMMIT');
      db.close();
      const result = previous.result && JSON.parse(previous.result);
      return { result: result ? { ...result, output: '复用同一次调用的执行记录；当前效果仍需核对。\n' + (result.output || ''), meta: { ...result.meta, replayed: true } }
        : { ok: false, error: 'OPERATION_UNCERTAIN', output: '此操作已有结果不明的执行记录。请检查实际效果；为避免重复副作用，本次未自动重试。' } };
    }
    db.prepare('INSERT INTO operations(key,result,taskId,toolId,fingerprint) VALUES(?,NULL,?,?,?)').run(key, taskId, tool.id, fingerprint);
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  let finished = false;
  return { finish(result) {
    if (finished) return;
    finished = true;
    try {
      if (result.meta?.executionStarted === false || result.meta?.denied) {
        db.prepare('DELETE FROM operations WHERE key=?').run(key);
      } else if (result.ok || (tool.id === 'bash' && Number.isInteger(result.meta?.exitCode) && !result.meta?.aborted)) {
        // A known nonzero exit is a result, not an unknown interruption. A new
        // approved invocation may retry; exact retransmissions get this receipt.
        db.prepare('UPDATE operations SET result=? WHERE key=?').run(JSON.stringify({ ...result, output: String(result.output || '').slice(0, 12000) }), key);
      }
    } finally { db.close(); }
  } };
}

export function listTaskOperations(taskId, home = getMeloHome()) {
  const path=join(home,'desktop','task-operations.sqlite');if(!existsSync(path)) return [];
  const db=new DatabaseSync(path);
  try { if(!db.prepare('PRAGMA table_info(operations)').all().some(c=>c.name==='taskId')) return []; return db.prepare('SELECT key,toolId,result IS NULL AS uncertain FROM operations WHERE taskId=?').all(taskId); } finally { db.close(); }
}
export function releaseTaskOperation(taskId,key,home=getMeloHome()) {
  const path=join(home,'desktop','task-operations.sqlite');if(!existsSync(path)) throw new Error('找不到操作记录。');
  const db=new DatabaseSync(path);
  try { const changed=db.prepare('DELETE FROM operations WHERE key=? AND taskId=? AND result IS NULL').run(key,taskId);if(!changed.changes) throw new Error('操作已确认或不存在。');return {ok:true}; } finally {db.close();}
}
