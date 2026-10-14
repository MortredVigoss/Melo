import { notifyMemoryIndexRepaired } from './store.js';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getMeloHome } from '../config.js';
import { getEmbeddingProvider } from './embedProviders/createEmbeddingProvider.js';
import { EMBEDDING_DIMS } from './embeddings.js';

const active = new Set();
const hash = text => createHash('sha1').update(text).digest('hex');
const validVector = vector => vector?.length === EMBEDDING_DIMS && [...vector].every(Number.isFinite) && [...vector].some(n => n !== 0);
function openStage(home) {
  mkdirSync(join(home, 'desktop'), { recursive: true });
  const db = new DatabaseSync(join(home, 'desktop', 'memory-repair.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS staged (id TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
  return db;
}
export function memoryRepairStatus(home = getMeloHome()) {
  if (!existsSync(join(home, 'desktop', 'memory-repair.sqlite'))) return null;
  const db = new DatabaseSync(join(home, 'desktop', 'memory-repair.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT data FROM job WHERE id=1').get()?.data || 'null'); }
  finally { db.close(); }
}

// Each request performs a bounded batch. Staged vectors survive a process exit;
// the active index is changed only inside the final verified transaction.
export async function repairMemoryBatch({ home = getMeloHome(), providerPromise = getEmbeddingProvider(), batchSize = 5 } = {}) {
  if (active.has(home)) throw new Error('记忆修复正在进行，请等待当前批次完成。');
  active.add(home);
  let stage, source;
  const report = { status: 'paused', completed: 0, total: 0, updatedAt: new Date().toISOString() };
  const save = () => stage.prepare('INSERT OR REPLACE INTO job VALUES(1, ?)').run(JSON.stringify(report));
  try {
    stage = openStage(home);
    const provider = await providerPromise;
    if (!provider) throw new Error('嵌入服务未连接。文字记忆与旧索引已保留，仍可使用关键词检索。');
    report.model = String(provider.modelId || '');
    if (!report.model || provider.dims !== EMBEDDING_DIMS) throw new Error(`嵌入模型维度必须为 ${EMBEDDING_DIMS}；当前为 ${provider.dims ?? '未知'}。`);
    source = new DatabaseSync(join(home, 'desktop', 'store.sqlite'), { allowExtension: true });
    source.exec('PRAGMA busy_timeout=5000');
    const rows = source.prepare('SELECT id, search_text FROM memories ORDER BY id').all();
    report.total = rows.length;
    const lookup = stage.prepare('SELECT * FROM staged WHERE id=? AND text=? AND model=?');
    const pending = rows.filter(row => !lookup.get(row.id, row.search_text, report.model));
    report.completed = rows.length - pending.length;
    for (const row of pending.slice(0, Math.max(1, Math.min(20, Number(batchSize) || 5)))) {
      const vector = await (provider.probe || provider.embed).call(provider,row.search_text);
      if (!validVector(vector) || (provider.observedDims != null && provider.observedDims !== EMBEDDING_DIMS)) throw new Error('嵌入请求失败或返回无效向量。已完成批次保留，可以继续。');
      stage.prepare('INSERT OR REPLACE INTO staged VALUES(?, ?, ?, ?)').run(row.id, row.search_text, report.model, Buffer.from(new Float32Array(vector).buffer));
      report.completed++;
      save();
    }
    if (report.completed === report.total) {
      source.loadExtension(createRequire(import.meta.url)('sqlite-vec').getLoadablePath());
      source.exec('BEGIN IMMEDIATE');
      try {
        const current = source.prepare('SELECT id, search_text FROM memories ORDER BY id').all();
        const vectors = current.map(row => ({ ...row, staged: lookup.get(row.id, row.search_text, report.model) }));
        if (vectors.some(row => !row.staged)) {
          source.exec('ROLLBACK');
          report.status = 'paused'; report.note = '修复期间有新记忆，继续即可补齐。';
        } else {
          source.exec(`DROP TABLE IF EXISTS vec_memories;
            CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIMS}]);`);
          for (const row of vectors) {
            const vector = row.staged.embedding;
            source.prepare('UPDATE memories SET embedding=? WHERE id=?').run(vector, row.id);
            source.prepare('INSERT INTO vec_memories VALUES(?, ?)').run(row.id, vector);
            source.prepare('INSERT OR REPLACE INTO embedding_cache VALUES(?, ?, ?, ?)').run(hash(row.search_text), report.model, vector, report.updatedAt);
          }
          if (source.prepare('SELECT COUNT(*) AS n FROM vec_memories').get().n !== vectors.length) throw new Error('索引数量验证失败。');
          // Verify the actual ANN query on fixed samples before publishing.
          for (const row of vectors.slice(0, 3)) {
            const match = source.prepare('SELECT distance FROM vec_memories WHERE embedding MATCH ? AND k=1').get(row.staged.embedding);
            if (!match || match.distance > 0.001) throw new Error('索引检索验证失败。');
          }
          const meta = source.prepare('INSERT OR REPLACE INTO _meta VALUES(?, ?)');
          meta.run('embedding_dims', String(EMBEDDING_DIMS)); meta.run('embedding_model_id', report.model);
          meta.run('embedding_repair_required', '0');
          source.exec('COMMIT');
          notifyMemoryIndexRepaired(home);
          report.status = 'complete'; report.completed = report.total = vectors.length;
          report.note = '新索引已通过数量与样本检索验证，文字记忆保留。';
        }
      } catch (error) { try { source.exec('ROLLBACK'); } catch {} throw error; }
    }
    save();
    return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    if (stage) save();
    return report;
  } finally { source?.close(); stage?.close(); active.delete(home); }
}

export async function diagnoseMemory(snapshot, providerPromise = getEmbeddingProvider()) {
  const provider = await providerPromise;
  let available = false;
  try { available = !!provider && validVector(await (provider.probe || provider.embed).call(provider,'Melo 记忆连接检查')); } catch {}
  const dims = provider?.observedDims ?? provider?.dims;
  const issues = [];
  if (!available) issues.push({ code: 'offline', message: '嵌入服务未响应；当前使用关键词检索。' });
  if (provider && dims !== EMBEDDING_DIMS) issues.push({ code: 'dimensions', message: `模型报告 ${dims} 维，索引需要 ${EMBEDDING_DIMS} 维。` });
  if (snapshot.embedding.storedModelId && provider && snapshot.embedding.storedModelId !== provider.modelId) issues.push({ code: 'model_changed', message: '嵌入模型已变化，需要安全重建索引。' });
  if ((snapshot.counts.vecMemories || 0) < (snapshot.counts.memories || 0)) issues.push({ code: 'missing_index', message: '部分记忆尚未建立语义索引。' });
  available = available && dims === EMBEDDING_DIMS;
  return { available, model: provider?.modelId || null, dims: dims || null, issues, checkedAt: new Date().toISOString() };
}
