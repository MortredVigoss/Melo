// Missing usage and missing prices stay unknown; token counts are never inferred from text.
export function normalizeUsage(raw) {
  if(!raw) return null;
  let input=raw.input_tokens ?? raw.prompt_tokens;
  const output=raw.output_tokens ?? raw.completion_tokens;
  if ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw) input += (raw.cache_read_input_tokens || 0) + (raw.cache_creation_input_tokens || 0);
  if(!Number.isFinite(input) || !Number.isFinite(output) || input<0 || output<0) return null;
  const usage = {input,output,cached:raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,cacheWrite:raw.input_tokens_details?.cache_write_tokens ?? raw.cache_creation_input_tokens ?? 0};
  return Object.values(usage).every(n=>Number.isFinite(n) && n>=0) && usage.input>=usage.cached+usage.cacheWrite ? usage : null;
}
export function summarizeUsage(receipts=[], rates=null) {
  const known=receipts.filter(r=>r.usage && !r.simulated), unknown=receipts.length-known.length;
  const total=known.reduce((s,r)=>({input:s.input+r.usage.input,output:s.output+r.usage.output,cached:s.cached+r.usage.cached,cacheWrite:s.cacheWrite+r.usage.cacheWrite}),{input:0,output:0,cached:0,cacheWrite:0});
  const validRate=value=>typeof value==='number' && Number.isFinite(value) && value>=0;
  let estimatedCost=null;
  if(receipts.length && !unknown && rates && ['input','output','cached','cacheWrite'].every(k=>validRate(rates[k])) && total.input>=total.cached+total.cacheWrite) estimatedCost=((total.input-total.cached-total.cacheWrite)*rates.input+total.output*rates.output+total.cached*rates.cached+total.cacheWrite*rates.cacheWrite)/1e6;
  return {...total,requests:receipts.length,unknown,estimatedCost,currency:'USD',pricingSource:estimatedCost===null ? null : '用户填写的每百万 token 单价'};
}

// Preserve each request's model price, including verifier or role model changes.
export function summarizePricedUsage(receipts = [], modelPricing = {}) {
  const total = summarizeUsage(receipts);
  const costs = receipts.map(receipt => summarizeUsage([receipt], modelPricing?.[receipt.requestedModel]).estimatedCost);
  if (costs.length && costs.every(cost => cost !== null)) {
    total.estimatedCost = costs.reduce((sum, cost) => sum + cost, 0);
    total.pricingSource = '用户填写的每百万 token 单价';
  }
  return total;
}
