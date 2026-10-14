import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getMeloHome } from '../config.js';
import { currentRequestContext } from '../runtime/requestScope.js';
export function recordPermission({ operation, decision, reason, ruleId = null, path = null }, context = currentRequestContext()) {
  const home = context?.home || getMeloHome();
  let db;
  try {
    mkdirSync(join(home,'desktop'),{recursive:true});
    db=new DatabaseSync(join(home,'desktop','permission-audit.sqlite'));
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    db.prepare('INSERT INTO audit(data) VALUES(?)').run(JSON.stringify({ operation, decision, reason, ruleId, path, role:context?.permissionScope?.role || null, project:context?.permissionScope?.project || null, workspace:context?.permissionScope?.workspace?.path || null, chatId:context?.chatId || null, at:new Date().toISOString() }));
    db.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)');
  } catch (error) { console.warn('Permission audit unavailable:',error.code || 'storage error'); }
  finally { db?.close(); }
}
export function listPermissionAudit(home = getMeloHome()) {
  const path=join(home,'desktop','permission-audit.sqlite'); if(!existsSync(path)) return [];
  const db=new DatabaseSync(path,{readOnly:true});
  try { return db.prepare('SELECT data FROM audit ORDER BY id DESC LIMIT 200').all().map(r=>JSON.parse(r.data)); } finally { db.close(); }
}
