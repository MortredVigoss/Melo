/**
 * Factory + router for MemoryProvider instances.
 *
 * Primary selection env var:   MELO_MEMORY_PROVIDER = sqlite-vec | chroma | lancedb | http-proxy
 * Shadow (dual-write) env var: MELO_MEMORY_SHADOW   = <same enum>
 * Namespace routing env var:   MELO_MEMORY_ROUTING  = 'chat:*=sqlite-vec;skill:*=chroma'
 *
 * The router wraps the primary provider so that:
 *   • writes fan out to primary + shadow (if configured)
 *   • reads always go to the primary (shadow is write-only by design — it's
 *     for migration validation, not live traffic)
 *   • per-namespace routes override the global primary for that prefix
 */

import { SqliteVecProvider } from './SqliteVecProvider.js';
import { ChromaProvider } from './ChromaProvider.js';
import { LanceDbProvider, isLanceAvailable } from './LanceDbProvider.js';
import { HttpProxyProvider } from './HttpProxyProvider.js';
import { ensureProviderShape } from './MemoryProvider.js';

const REGISTRY = new Map();

export function registerProvider(name, factory) {
  REGISTRY.set(name, factory);
}

/** Built-in registrations. */
registerProvider('sqlite-vec', () => new SqliteVecProvider());
registerProvider('chroma', () => new ChromaProvider());
registerProvider('lancedb', async () => {
  if (!(await isLanceAvailable())) return null;
  return new LanceDbProvider();
});
registerProvider('http-proxy', () => {
  try { return new HttpProxyProvider(); } catch { return null; }
});

/**
 * Resolve one provider by name.  Async to accommodate LanceDB's dynamic
 * import.
 */
export async function createProvider(name) {
  const label = String(name || '').trim().toLowerCase() || 'sqlite-vec';
  const factory = REGISTRY.get(label);
  if (!factory) throw new Error(`Unknown memory provider: ${label}`);
  const provider = await factory();
  if (!provider) return null;
  return ensureProviderShape(provider);
}

/**
 * Parse "chat:*=sqlite-vec;skill:*=chroma" into
 *   [{ prefix: 'chat:', provider: 'sqlite-vec' }, { prefix: 'skill:', provider: 'chroma' }]
 */
export function parseRouting(raw = '') {
  const out = [];
  for (const clause of String(raw || '').split(';')) {
    const [pat, prov] = clause.split('=').map(s => s?.trim() || '');
    if (!pat || !prov) continue;
    const prefix = pat.endsWith(':*') ? pat.slice(0, -1) : pat.endsWith('*') ? pat.slice(0, -1) : pat;
    out.push({ prefix, provider: prov });
  }
  return out;
}

/**
 * Router wrapping a primary provider.  Optional shadow writes + per-namespace
 * routing.
 */
class RouterProvider {
  static get providerName() { return 'router'; }

  constructor({ primary, shadow = null, routes = [] }) {
    this.primary = primary;
    this.shadow = shadow;
    this.routes = routes;  // [{prefix, provider: ProviderInstance}]
  }

  _route(namespace) {
    if (!namespace) return this.primary;
    for (const { prefix, provider } of this.routes) {
      if (String(namespace).startsWith(prefix)) return provider;
    }
    return this.primary;
  }

  async upsert(entry) {
    const target = this._route(entry?.namespace);
    await target.upsert(entry);
    if (this.shadow && target !== this.shadow) {
      try { await this.shadow.upsert(entry); } catch {}
    }
  }

  async replaceAll(entries) {
    const byProv = new Map();
    for (const e of entries) {
      const p = this._route(e?.namespace);
      if (!byProv.has(p)) byProv.set(p, []);
      byProv.get(p).push(e);
    }
    for (const [prov, list] of byProv) {
      // eslint-disable-next-line no-await-in-loop
      await prov.replaceAll(list);
    }
    if (this.shadow) {
      try { await this.shadow.replaceAll(entries); } catch {}
    }
  }

  async search(opts = {}) {
    const ns = opts.namespaces?.[0];
    const target = ns ? this._route(ns) : this.primary;
    return target.search(opts);
  }

  async searchTiered(opts = {}) {
    const ns = opts.namespaces?.[0];
    const target = ns ? this._route(ns) : this.primary;
    return target.searchTiered(opts);
  }

  async stats() {
    const primary = await this.primary.stats();
    const routeStats = {};
    for (const { prefix, provider } of this.routes) {
      try { routeStats[prefix] = await provider.stats(); } catch {}
    }
    const shadow = this.shadow ? await this.shadow.stats().catch(() => null) : null;
    return { ...primary, routes: routeStats, shadow };
  }

  /**
   * Union of all provider attic-reassess candidates.  A row can only live on
   * one backend (the router chose it at `upsert` time), so id collisions are
   * unlikely — but we dedupe by id just in case, preferring the route-hit
   * provider over primary over shadow (shadow is write-only, but we still
   * accept rows only it has so shadow's attic tiers do not go stale).
   */
  async listForReassess(opts) {
    const seen = new Map();
    const sources = [this.primary, ...this.routes.map(r => r.provider)];
    if (this.shadow) sources.push(this.shadow);
    for (const src of sources) {
      let rows = [];
      try { rows = (await src.listForReassess(opts)) || []; } catch { rows = []; }
      for (const r of rows) {
        if (!r?.id) continue;
        if (!seen.has(r.id)) seen.set(r.id, r);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Fan attic-level updates out to every provider.  Each backend no-ops for
   * ids it does not own, so broadcasting is safe and saves us from bookkeeping
   * "which row is where".  We sum the affected counts for stats.
   */
  async setAtticLevels(updates) {
    const targets = [this.primary, ...this.routes.map(r => r.provider)];
    if (this.shadow) targets.push(this.shadow);
    let total = 0;
    for (const t of targets) {
      try { total += Number((await t.setAtticLevels(updates)) || 0); } catch {}
    }
    return total;
  }

  /**
   * Recall-hits are per-row audit events.  Broadcasting them would insert
   * orphan rows into shadow/route `memory_hits` tables (each provider keeps
   * its own hit log).  The invariant we want is "hit is written to the
   * backend that owns the row"; since recall paths already call the owning
   * provider's recordHit internally, the router-level entrypoint only needs
   * to forward to the namespace's route (or primary by default).
   */
  async recordHit(hit) {
    const ns = hit?.namespace;
    const target = ns ? this._route(ns) : this.primary;
    return target.recordHit?.(hit);
  }
  async close() {
    await this.primary.close?.();
    if (this.shadow) await this.shadow.close?.();
    for (const r of this.routes) await r.provider.close?.();
  }
}

/**
 * Build the runtime provider stack from env.  Call this once at boot; cache
 * the result.
 */
export async function buildProviderFromEnv() {
  const primaryName = (process.env.MELO_MEMORY_PROVIDER || 'sqlite-vec').trim();
  const shadowName = (process.env.MELO_MEMORY_SHADOW || '').trim();
  const routingRaw = (process.env.MELO_MEMORY_ROUTING || '').trim();

  const primary = (await createProvider(primaryName)) || (await createProvider('sqlite-vec'));

  let shadow = null;
  if (shadowName && shadowName !== primaryName) {
    try { shadow = await createProvider(shadowName); } catch {}
  }

  const routes = [];
  if (routingRaw) {
    for (const { prefix, provider } of parseRouting(routingRaw)) {
      try {
        const inst = await createProvider(provider);
        if (inst) routes.push({ prefix, provider: inst });
      } catch {
        // bad route spec — ignore
      }
    }
  }

  if (!shadow && !routes.length) return primary;  // trivial case, no router needed
  return new RouterProvider({ primary, shadow, routes });
}

// Singleton helpers for app-wide use.
let _singleton = null;
export async function getMemoryProvider() {
  if (_singleton) return _singleton;
  _singleton = await buildProviderFromEnv();
  return _singleton;
}
export function _resetProviderForTests() { _singleton = null; }

export { RouterProvider };
