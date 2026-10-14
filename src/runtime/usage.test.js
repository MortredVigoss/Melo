import test from 'node:test';import assert from 'node:assert/strict';import {normalizeUsage,summarizeUsage,summarizePricedUsage} from './usage.js';
test('OpenAI inclusive cache counts and Anthropic exclusive cache counts normalize to the same total',()=>{
 const openai=normalizeUsage({input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:60,cache_write_tokens:10}});
 const anthropic=normalizeUsage({input_tokens:30,output_tokens:20,cache_read_input_tokens:60,cache_creation_input_tokens:10});assert.deepEqual(openai,anthropic);
 const summary=summarizeUsage([{usage:openai}],{input:1,output:2,cached:0.1,cacheWrite:1.25});assert.equal(summary.estimatedCost,(30+40+6+12.5)/1e6);
 assert.equal(normalizeUsage({input_tokens:3,output_tokens:2,input_tokens_details:{cached_tokens:-1}}),null);
});

test('mixed models keep their own rates and missing rates stay unknown', () => {
 const receipts = [{requestedModel:'a',usage:{input:100,output:0,cached:0,cacheWrite:0}}, {requestedModel:'b',usage:{input:100,output:0,cached:0,cacheWrite:0}}];
 const rates = {a:{input:1,output:1,cached:1,cacheWrite:1},b:{input:2,output:2,cached:2,cacheWrite:2}};
 assert.equal(summarizePricedUsage(receipts,rates).estimatedCost,0.0001+0.0002);
 assert.equal(summarizePricedUsage(receipts,{a:rates.a}).estimatedCost,null);
 assert.equal(summarizePricedUsage([{...receipts[0],simulated:true}],rates).estimatedCost,null);
});
