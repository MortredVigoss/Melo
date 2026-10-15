// Derived local knowledge index. All writes belong to source updates or
// background embedding; prompt retrieval only opens a read-only connection.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BuiltinEmbedProvider} from './embedProviders/BuiltinEmbedProvider.js';
import {cosineSimilarity} from './embeddings.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
const tokens=text=>String(text).toLowerCase().match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[\p{L}\p{N}_]{2,}/gu)||[];
function databasePath(home) {
 if(!home)throw new Error('Knowledge index needs a bound home');
 return join(home,'desktop','store.sqlite');
}
function open(home,{readOnly=false}={}) {
 const path=databasePath(home);
 if(readOnly&&!existsSync(path))return null;
 if(!readOnly)mkdirSync(join(home,'desktop'),{recursive:true});
 const db=new DatabaseSync(path,{readOnly});
 db.exec(`PRAGMA busy_timeout=${readOnly?50:5000}`);
 if(!readOnly)db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (namespace TEXT,id TEXT,revision TEXT,title TEXT,PRIMARY KEY(namespace,id));
 CREATE TABLE IF NOT EXISTS knowledge_chunks (key TEXT PRIMARY KEY,namespace TEXT,document_id TEXT,start INTEGER,end INTEGER,text TEXT,vector TEXT,model TEXT);
 CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_chunks(namespace,document_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(key UNINDEXED,terms);`);
 return db;
}
export function knowledgeChunks(text,size=1200,overlap=150) {
 const chunks=[];for(let start=0;start<text.length;start+=size-overlap){let end=Math.min(text.length,start+size);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;chunks.push({start,end,text:text.slice(start,end)});if(end===text.length)break;}
 return chunks;
}
function removeDocument(db,namespace,id) {
 db.prepare('DELETE FROM knowledge_fts WHERE key IN (SELECT key FROM knowledge_chunks WHERE namespace=? AND document_id=?)').run(namespace,id);
 db.prepare('DELETE FROM knowledge_chunks WHERE namespace=? AND document_id=?').run(namespace,id);
 db.prepare('DELETE FROM knowledge_documents WHERE namespace=? AND id=?').run(namespace,id);
}
export function indexKnowledgeDocuments({home,namespace='knowledge',documents,prune=false}) {
 if(!documents.length&&!existsSync(databasePath(home)))return false;
 const db=open(home);
 try {
  const old=new Map(db.prepare('SELECT id,revision,title FROM knowledge_documents WHERE namespace=?').all(namespace).map(row=>[row.id,row]));
  const changes=documents.map(doc=>({...doc,revision:hash(doc.content)})).filter(doc=>old.get(doc.id)?.revision!==doc.revision||old.get(doc.id)?.title!==(doc.title||doc.id));
  const ids=new Set(documents.map(d=>d.id)),removed=prune?[...old.keys()].filter(id=>!ids.has(id)):[];
  if(!changes.length&&!removed.length)return false;
  db.exec('BEGIN IMMEDIATE');
  for(const id of removed)removeDocument(db,namespace,id);
  for(const doc of changes){
   removeDocument(db,namespace,doc.id);
   db.prepare('INSERT INTO knowledge_documents VALUES(?,?,?,?)').run(namespace,doc.id,doc.revision,doc.title||doc.id);
   for(const chunk of knowledgeChunks(doc.content)){
    const key=hash(JSON.stringify([namespace,doc.id,doc.revision,chunk.start]));
    db.prepare('INSERT INTO knowledge_chunks VALUES(?,?,?,?,?,?,NULL,NULL)').run(key,namespace,doc.id,chunk.start,chunk.end,chunk.text);
    db.prepare('INSERT INTO knowledge_fts(key,terms) VALUES(?,?)').run(key,tokens((doc.title||doc.id)+' '+chunk.text).join(' '));
   }
  }
  db.exec('COMMIT');return true;
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export function pruneKnowledgeIndex({home,namespace='knowledge',keepIds=[]}) {
 if(!existsSync(databasePath(home)))return;
 const db=open(home);
 try {
  const keep=new Set(keepIds),removed=db.prepare('SELECT id FROM knowledge_documents WHERE namespace=?').all(namespace).filter(row=>!keep.has(row.id));
  if(!removed.length)return;
  db.exec('BEGIN IMMEDIATE');for(const row of removed)removeDocument(db,namespace,row.id);db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
// Coalesce embedding work per captured home/namespace. Only immutable chunk
// keys are updated, so an edit/delete during inference cannot restore old text.
const warmJobs=new Map();
export function warmKnowledgeIndex({home,namespace='knowledge',provider=new BuiltinEmbedProvider()}) {
 const key=JSON.stringify([home,namespace,provider.modelId]);
 if(warmJobs.has(key))return warmJobs.get(key);
 const job=(async()=>{
  if(!await provider.isAvailable()||!existsSync(databasePath(home)))return;
  while(true){
   const read=open(home,{readOnly:true});let rows;
   try {rows=read.prepare('SELECT key,text FROM knowledge_chunks WHERE namespace=? AND (vector IS NULL OR model IS NULL OR model!=?) LIMIT 16').all(namespace,provider.modelId);}finally{read.close();}
   if(!rows.length)return;
   const vectors=await Promise.all(rows.map(async row=>({key:row.key,vector:await provider.embed(row.text).catch(()=>null)})));
   const ready=vectors.filter(row=>row.vector);if(!ready.length)return;
   const db=open(home);
   try {db.exec('BEGIN IMMEDIATE');for(const row of ready)db.prepare('UPDATE knowledge_chunks SET vector=?,model=? WHERE key=?').run(JSON.stringify(Array.from(row.vector)),provider.modelId,row.key);db.exec('COMMIT');}
   catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
   if(ready.length<rows.length)return;
  }
 })().finally(()=>warmJobs.delete(key));
 warmJobs.set(key,job);return job;
}
const queryVectors=new Map();
async function queryVector({home,query,provider,signal,timeoutMs}) {
 if(signal?.aborted)return null;
 const key=JSON.stringify([home,provider.modelId,query]);
 let job=queryVectors.get(key);
 if(!job){
  job=Promise.resolve().then(async()=>await provider.isAvailable()?provider.embed(query):null).catch(()=>null);
  queryVectors.set(key,job);while(queryVectors.size>64)queryVectors.delete(queryVectors.keys().next().value);
  job.then(vector=>{if(!vector&&queryVectors.get(key)===job)queryVectors.delete(key);});
 }
 let timer,abort;
 try {return await Promise.race([job,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,Math.min(100,timeoutMs)));abort=()=>resolve(null);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)resolve(null);})]);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function searchKnowledge({home,namespace='knowledge',documents,query,limit=8,signal,provider=new BuiltinEmbedProvider(),queryTimeoutMs=75}) {
 const allowed=new Map(documents.map(d=>[d.id,d]));if(!allowed.size)return [];
 const rows=[];let lexical=[];
 let db;
 try {
  db=open(home,{readOnly:true});
  if(db){
   const marks=[...allowed].map(()=>'?').join(',');
   const stored=db.prepare(`SELECT c.*,d.title,d.revision FROM knowledge_chunks c JOIN knowledge_documents d ON c.namespace=d.namespace AND c.document_id=d.id WHERE c.namespace=? AND c.document_id IN (${marks})`).all(namespace,...allowed.keys());
   const revisions=new Map(documents.map(d=>[d.id,hash(d.content)]));
   rows.push(...stored.filter(row=>row.revision===revisions.get(row.document_id)&&row.title===(allowed.get(row.document_id).title||row.document_id)));
   const terms=[...new Set(tokens(query))].slice(0,40).map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
   if(terms)lexical=db.prepare(`SELECT c.key,bm25(knowledge_fts) AS score FROM knowledge_fts JOIN knowledge_chunks c ON knowledge_fts.key=c.key WHERE knowledge_fts MATCH ? AND c.namespace=? AND c.document_id IN (${marks}) ORDER BY score LIMIT 40`).all(terms,namespace,...allowed.keys());
  }
 }catch{/* Missing or busy derived index: use the current selected source text. */}finally{db?.close();}
 const indexed=new Set(rows.map(r=>r.document_id));
 for(const doc of documents)if(!indexed.has(doc.id))for(const chunk of knowledgeChunks(doc.content))rows.push({...chunk,key:hash(JSON.stringify([namespace,doc.id,hash(doc.content),chunk.start])),document_id:doc.id,title:doc.title||doc.id});
 const terms=new Set(tokens(query)),rank=new Map(lexical.map((r,i)=>[r.key,1/(i+1)]));
 for(const row of rows)if(!rank.has(row.key))rank.set(row.key,tokens(row.title+' '+row.text).filter(t=>terms.has(t)).length/Math.max(1,tokens(row.text).length));
 const hasVectors=rows.some(row=>row.vector&&row.model===provider.modelId);
 const vector=hasVectors?await queryVector({home,query,provider,signal,timeoutMs:queryTimeoutMs}):null;
 const results=rows.map(row=>{
  let semantic=0,used=false;
  if(vector&&row.vector&&row.model===provider.modelId){try{semantic=Math.max(0,cosineSimilarity(vector,JSON.parse(row.vector)));used=true;}catch{}}
  return {documentId:row.document_id,title:row.title,start:row.start,end:row.end,text:row.text,score:(rank.get(row.key)||0)+semantic,semantic:used};
 }).sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.start-b.start);
 const selected=[];for(const row of results){if(selected.some(s=>s.documentId===row.documentId&&Math.abs(s.start-row.start)<1000))continue;selected.push(row);if(selected.length>=Math.max(1,Math.min(20,limit)))break;}
 return selected;
}
