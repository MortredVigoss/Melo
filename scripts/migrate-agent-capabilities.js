// Run only with explicit user authorization. The product server must be stopped
// or this command must execute within its owner process; never race another writer.
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {updateStateAtomically} from '../src/state/stateStore.js';
import {migrateAllCapabilities} from '../src/services/agent/capabilityMigration.js';
import {serializeAgentState} from '../src/domain/agent/agentState.js';
const homeArg=process.argv.indexOf('--home');
if (homeArg<0||!process.argv[homeArg+1]||!process.argv.includes('--user-authorized')) throw new Error('Pass --home <actual Melo home> --user-authorized after stopping its server.');
const home=resolve(process.argv[homeArg+1]);
const backup=join(home,'desktop','backups','agent-capabilities-'+Date.now()+'-'+randomUUID());
let report=[];
await updateStateAtomically(async state=>{
 await mkdir(backup,{recursive:true,mode:0o700});
 await writeFile(join(backup,'agent-state.json'),JSON.stringify(serializeAgentState(state),null,2),{mode:0o600,flag:'wx'});
 report=migrateAllCapabilities(state);
 state.agentCapabilityMigration={at:new Date().toISOString(),backup,report};
 return state;
},{home});
process.stdout.write(JSON.stringify({home,backup,migrated:report.map(({scope,projectId,id,lostTools,lostActions})=>({scope,projectId,id,lostTools,lostActions}))},null,2)+'\n');
