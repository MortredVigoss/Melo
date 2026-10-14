// Build-time asset preparation only. Runtime inference never downloads models.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const revision='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const root=resolve('assets/models/multilingual-e5-small');
const files={
  'config.json':['git','4104f38273cc595fd9500fd243124e9f6cf383dc'],
  'tokenizer_config.json':['git','059214673d9d6d2ee319411e2ffec8c024b816d5'],
  'special_tokens_map.json':['git','e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b'],
  'tokenizer.json':['sha256','0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
  'onnx/model_quantized.onnx':['sha256','f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'],
};
for(const [file,[kind,expected]] of Object.entries(files)) {
  const path=resolve(root,file);
  const digest=data=>kind==='git'?createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'):createHash('sha256').update(data).digest('hex');
  try { if(digest(await readFile(path))===expected) continue; }catch{}
  const response=await fetch(`https://huggingface.co/Xenova/multilingual-e5-small/resolve/${revision}/${file}`,{signal:AbortSignal.timeout(300000)});
  if(!response.ok) throw new Error(`Model asset ${file}: HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  if(digest(data)!==expected) throw new Error(`Model asset checksum mismatch: ${file}`);
  await mkdir(dirname(path),{recursive:true});await writeFile(path+'.partial',data);await rename(path+'.partial',path);
  console.log(`Verified ${file} (${data.length} bytes)`);
}
await writeFile(resolve(root,'melo-manifest.json'),JSON.stringify({model:'Xenova/multilingual-e5-small',revision,nativeDimensions:384,storageDimensions:1024,files},null,2));
