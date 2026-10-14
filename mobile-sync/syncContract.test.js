import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { syncSchema } from './syncContract.generated.js';
import { validateSchema } from './schemaValidator.js';
import { validateWorkspace } from './workspaceProtocol.js';
import { validateSnapshot } from './protocol.js';
import { validateTaskSync } from './taskProtocol.js';
const fixtures=JSON.parse(await readFile(new URL('../shared/protocol/fixtures.json',import.meta.url),'utf8'));
function expand(v) {
  if(v?.$repeat)return v.$repeat.text.repeat(v.$repeat.count);
  if(Array.isArray(v))return v.map(expand);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)]));
  return v;
}
for(const fixture of fixtures)test(`shared wire contract: ${fixture.name}`,()=>{
  const input=expand(fixture.input);
  const validate=()=>{
    validateSchema(input,syncSchema.$defs[fixture.definition],syncSchema);
    ({workspace:validateWorkspace,snapshot:validateSnapshot,taskSync:validateTaskSync})[fixture.definition]?.(input);
  };
  if(fixture.valid)assert.doesNotThrow(validate);else assert.throws(validate);
});
