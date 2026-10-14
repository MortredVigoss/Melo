import { loadConfig, saveConfig, getResolvedConfig, withConfigLock } from '../../config.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { judgeCandidates, probeJudges, publicExtraFast } from '../../judge/fastJudge.js';

const scoped = work => currentRequestContext() ? work() : runWithRequestContext(createRequestContext(), work);
const probing = new Set();

export function saveExtraFast(patch) {
  return scoped(() => withConfigLock(async () => {
    const config = await loadConfig({ skipModelNormalize: true });
    if (typeof patch.enabled !== 'boolean' || !Number.isSafeInteger(patch.revision)) throw new Error('加速设置参数无效。');
    if (patch.revision !== (config.extraFast?.revision || 0)) throw new Error('加速设置已被更新，草稿保留；请刷新后重新编辑。');
    const extraFast = { enabled: patch.enabled, revision: patch.revision + 1, measurements: config.extraFast?.measurements || {} };
    await saveConfig({ ...config, extraFast, autosaveRevision: Math.max(Date.now(), (config.autosaveRevision || 0) + 1) });
    return publicExtraFast({ ...config, extraFast });
  }));
}

export function testExtraFast(options = {}) {
  return scoped(async () => {
    const context = currentRequestContext();
    const home = context.home;
    if (probing.has(home)) throw new Error('正在检测，请稍候刷新。');
    probing.add(home);
    try {
      const config = await getResolvedConfig({ skipModelNormalize: true });
      if (!config.extraFast?.enabled) throw new Error('请先开启并保存额外快速。');
      const measurements = await probeJudges(config, { ...options, home });
      return await withConfigLock(async () => {
        options.signal?.throwIfAborted();
        const current = await getResolvedConfig({ skipModelNormalize: true });
        if (!current.extraFast?.enabled || current.extraFast.revision !== config.extraFast.revision) return publicExtraFast(current);
        const valid = new Set(judgeCandidates(current).map(candidate => candidate.key));
        const merged = Object.fromEntries(Object.entries({ ...current.extraFast.measurements, ...measurements }).filter(([key]) => valid.has(key)));
        // Read the raw configuration to avoid persisting environment overrides.
        const raw = await loadConfig({ skipModelNormalize: true });
        const next = { ...raw, extraFast: { ...raw.extraFast, measurements: merged } };
        await saveConfig(next);
        return publicExtraFast({ ...current, extraFast: next.extraFast });
      });
    } finally { probing.delete(home); }
  });
}
