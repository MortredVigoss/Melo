// Derived local knowledge index. Explicit home + allowed document IDs are part
// of every operation; no singleton database or cross-chat directory index.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BuiltinEmbedProvider} from './embedProviders/BuiltinEmbedProvider.js';
import {cosineSimilarity} from './embeddings.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
const tokens=text=>String(text).toLowerCase().match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[\p{L}\p{N}_]{2,}/gu)||[];
function open(home) {
 if(!home)throw new Error('Knowledge index needs a bound home');
 mkdirSync(join(home,'desktop'),{recursive:true});
 const db=new DatabaseSync(join(home,'desktop','store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (namespace TEXT,id TEXT,revision TEXT,title TEXT,PRIMARY KEY(namespace,id));
 CREATE TABLE IF NOT EXISTS knowledge_chunks (key TEXT PRIMARY KEY,namespace TEXT,document_id TEXT,start INTEGER,end INTEGER,text TEXT,vector TEXT,model TEXT);
 CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_chunks(namespace,document_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(key UNINDEXED,terms);`);
 return db;
}
export function knowledgeChunks(text,size=1200,overlap=150) {
 const chunks=[];for(let start=0;start<text.length;start+=size-overlap){let end=Math.min(text.length,start+size);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;chunks.push({start,end,text:text.slice(start,end)});if(end===text.length)break;}
 return chunks;
}
export function indexKnowledgeDocuments({home,namespace='knowledge',documents}) {
 const db=open(home);
 try {db.exec('BEGIN IMMEDIATE');
  for(const doc of documents){const revision=hash(doc.content),old=db.prepare('SELECT revision,title FROM knowledge_documents WHERE namespace=? AND id=?').get(namespace,doc.id);
   if(old?.revision===revision&&old?.title===doc.title)continue;
   db.prepare('DELETE FROM knowledge_fts WHERE key IN (SELECT key FROM knowledge_chunks WHERE namespace=? AND document_id=?)').run(namespace,doc.id);
   db.prepare('DELETE FROM knowledge_chunks WHERE namespace=? AND document_id=?').run(namespace,doc.id);
   db.prepare('INSERT OR REPLACE INTO knowledge_documents VALUES(?,?,?,?)').run(namespace,doc.id,revision,doc.title || doc.id);
   for(const chunk of knowledgeChunks(doc.content)){const key=hash(JSON.stringify([namespace,doc.id,revision,chunk.start]));db.prepare('INSERT INTO knowledge_chunks VALUES(?,?,?,?,?,?,NULL,NULL)').run(key,namespace,doc.id,chunk.start,chunk.end,chunk.text);db.prepare('INSERT INTO knowledge_fts(key,terms) VALUES(?,?)').run(key,tokens(doc.title+' '+chunk.text).join(' '));}
  }db.exec('COMMIT');
 } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export async function searchKnowledge({home,namespace='knowledge',documents,query,limit=8,signal,provider=new BuiltinEmbedProvider()}) {
 const boundHome=home, allowed=[...new Set(documents.map(d=>d.id))];if(!allowed.length)return [];
 indexKnowledgeDocuments({home:boundHome,namespace,documents});
 const db=open(boundHome);let rows, lexical=[];
 try {
  const marks=allowed.map(()=>'?').join(',');
  rows=db.prepare(`SELECT c.*,d.title FROM knowledge_chunks c JOIN knowledge_documents d ON c.namespace=d.namespace AND c.document_id=d.id WHERE c.namespace=? AND c.document_id IN (${marks})`).all(namespace,...allowed);
  const terms=[...new Set(tokens(query))].slice(0,40).map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
  if(terms)lexical=db.prepare(`SELECT c.key,bm25(knowledge_fts) AS score FROM knowledge_fts JOIN knowledge_chunks c ON knowledge_fts.key=c.key WHERE knowledge_fts MATCH ? AND c.namespace=? AND c.document_id IN (${marks}) ORDER BY score LIMIT 40`).all(terms,namespace,...allowed);
 }finally{db.close();}
 const rank=new Map(lexical.map((r,i)=>[r.key,1/(i+1)]));
 // Local model only. Bound incremental inference to the lexical shortlist;
 // previously cached vectors also participate, without re-embedding unchanged text.
 let queryVector=null, model=provider.modelId;
 const deadline=Date.now()+2000;
 async function boundedEmbed(text) {
  if(signal?.aborted||Date.now()>=deadline)return null;
  let timer;try{return await Promise.race([provider.embed(text).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}
 }
 if(!signal?.aborted&&await provider.isAvailable())queryVector=await boundedEmbed(query);
 const candidates=[...rows].sort((a,b)=>(rank.get(b.key)||0)-(rank.get(a.key)||0)).slice(0,16);
 if(queryVector) for(const row of candidates) {
  if(signal?.aborted||Date.now()>=deadline)break;
  if(row.vector&&row.model===model)continue;
  const vector=await boundedEmbed(row.text);if(!vector)continue;
  const serialized=JSON.stringify(Array.from(vector));row.vector=serialized;row.model=model;
  const write=open(boundHome);try{write.prepare('UPDATE knowledge_chunks SET vector=?,model=? WHERE key=?').run(serialized,model,row.key);}finally{write.close();}
 }
 const results=rows.map(row=>{let semantic=0;if(queryVector&&row.vector&&row.model===model){try{semantic=Math.max(0,cosineSimilarity(queryVector,JSON.parse(row.vector)));}catch{}}
  return {documentId:row.document_id,title:row.title,start:row.start,end:row.end,text:row.text,score:(rank.get(row.key)||0)+semantic,semantic:!!queryVector&&!!row.vector&&row.model===model};
 }).sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.start-b.start);
 const selected=[];for(const row of results){if(selected.some(s=>s.documentId===row.documentId&&Math.abs(s.start-row.start)<1000))continue;selected.push(row);if(selected.length>=Math.max(1,Math.min(20,limit)))break;}
 return selected;
}
export function pruneKnowledgeIndex({home,namespace='knowledge',keepIds=[]}) {
 const db=open(home);try{db.exec('BEGIN IMMEDIATE');const keep=new Set(keepIds);for(const row of db.prepare('SELECT id FROM knowledge_documents WHERE namespace=?').all(namespace))if(!keep.has(row.id)){db.prepare('DELETE FROM knowledge_fts WHERE key IN (SELECT key FROM knowledge_chunks WHERE namespace=? AND document_id=?)').run(namespace,row.id);db.prepare('DELETE FROM knowledge_chunks WHERE namespace=? AND document_id=?').run(namespace,row.id);db.prepare('DELETE FROM knowledge_documents WHERE namespace=? AND id=?').run(namespace,row.id);}db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
