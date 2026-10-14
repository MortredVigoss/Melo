import test from 'node:test';
import { generateSyncContract } from './generate-sync-contract.js';
test('JS and Swift generated protocol match the one checked-in schema', async()=>{
  await generateSyncContract({check:true});
});
