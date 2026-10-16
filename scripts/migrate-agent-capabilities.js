// Run only with explicit user authorization. The product server must be stopped
// or this command must execute within its owner process; never race another writer.
import {mkdir,writeFile,copyFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {acquireServerHomeLock} from '../src/runtime/serverLock.js';
import {randomUUID} from 'node:crypto';
import {updateStateAtomically} from '../src/state/stateStore.js';
import {migrateAllCapabilities} from '../src/services/agent/capabilityMigration.js';
import {bootstrapBuiltinTools} from '../src/tools/registry.js';
import {serializeAgentState} from '../src/domain/agent/agentState.js';
const homeArg=process.argv.indexOf('--home');
if (homeArg<0||!process.argv[homeArg+1]||!process.argv.includes('--user-authorized')) throw new Error('Pass --home <actual Melo home> --user-authorized after stopping its server.');
const home=resolve(process.argv[homeArg+1]);
const backup=join(home,'desktop','backups','agent-capabilities-'+Date.now()+'-'+randomUUID());
const lock=await acquireServerHomeLock(home);
if(!lock.acquired)throw new Error("Stop the Melo server before migration; another process owns this home.");
bootstrapBuiltinTools();
let report=[];
try {
await mkdir(backup,{recursive:true,mode:0o700});
await copyFile(join(home,"desktop","state.json"),join(backup,"state.before.json"));
await chmod(join(backup,"state.before.json"),0o600);
await updateStateAtomically(async state=>{
 await mkdir(backup,{recursive:true,mode:0o700});
 await writeFile(join(backup,'agent-state.json'),JSON.stringify(serializeAgentState(state),null,2),{mode:0o600,flag:'wx'});
 report=migrateAllCapabilities(state);
 // The full report lives beside the backup; state keeps only a pointer so
 // every later state write does not carry a one-off migration record.
 await writeFile(join(backup,'report.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
 state.agentCapabilityMigration={at:new Date().toISOString(),backup,count:report.length};
 return state;
},{home});
}finally{await lock.release();}
process.stdout.write(JSON.stringify({home,backup,migrated:report.map(({scope,projectId,id,lostTools,lostActions})=>({scope,projectId,id,lostTools,lostActions}))},null,2)+'\n');
