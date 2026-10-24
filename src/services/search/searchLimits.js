import { AsyncLocalStorage } from 'node:async_hooks';
import { currentRequestContext } from '../../runtime/requestScope.js';
const scope = new AsyncLocalStorage();
// Operational overrides live under config.operationalLimits.search. Safety
// ceilings remain enforced even when a settings file contains invalid values.
export const SEARCH_LIMIT_DEFAULTS = Object.freeze({
  maxResults: 8, timeoutMs: 25000, contentTimeoutMs: 14000, contentMaxChars: 6000,
  fetchTimeoutMs: 30000, fetchMaxChars: 20000, browserTimeoutMs: 20000,
  cacheTtlMs: 7200000, freshCacheTtlMs: 900000, urlCacheTtlMs: 7200000, staleMaxMs: 86400000,
});
const ranges = {maxResults:[1,8],timeoutMs:[3000,120000],contentTimeoutMs:[3000,120000],contentMaxChars:[1000,50000],fetchTimeoutMs:[3000,120000],fetchMaxChars:[1000,100000],browserTimeoutMs:[3000,120000],cacheTtlMs:[0,86400000],freshCacheTtlMs:[0,3600000],urlCacheTtlMs:[0,86400000],staleMaxMs:[0,604800000]};
export function normalizeSearchLimits(config = {}) {
  const values = {...config.operationalLimits?.search};
  const search = config.agentRuntime?.search || {};
  for (const key of ['maxResults','timeoutMs']) if (search[key] !== undefined) values[key] = search[key];
  return Object.freeze(Object.fromEntries(Object.entries(SEARCH_LIMIT_DEFAULTS).map(([key, fallback]) => {
    const value = Number(values[key]), [min,max] = ranges[key];
    return [key, values[key] == null || !Number.isFinite(value) ? fallback : Math.min(max,Math.max(min,Math.floor(value)))];
  })));
}
export function searchLimits() { return scope.getStore() || SEARCH_LIMIT_DEFAULTS; }
export function withSearchLimits(config, work) { return scope.run(normalizeSearchLimits(config), work); }
export function scopedSearchRun(run) {
  return function(args, options = {}) {
    const config = options.config || options.requestContext?.config || currentRequestContext()?.config || {};
    return withSearchLimits(config, () => run.call(this, args, options));
  };
}
