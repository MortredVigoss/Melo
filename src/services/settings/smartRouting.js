import { loadConfig, saveConfig, getResolvedConfig, withConfigLock } from '../../config.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { publicSmartRouting, routingCandidates } from '../modelRouting/routing.js';
const scoped = work => currentRequestContext() ? work() : runWithRequestContext(createRequestContext(), work);
export function saveSmartRouting(patch) {
  return scoped(() => withConfigLock(async () => {
    const config = await loadConfig({ skipModelNormalize: true });
    if (!Number.isSafeInteger(patch.revision) || patch.revision !== (config.smartRouting?.revision || 0)) throw new Error('智能模式设置已被更新，草稿保留；请载入最新版本。');
    if (!['fixed','smart'].includes(patch.defaultMode) || !['cost','balanced','quality'].includes(patch.preference) || typeof patch.allowCrossConnection !== 'boolean' || typeof patch.allowEscalation !== 'boolean') throw new Error('智能模式设置无效。');
    const resolved = await getResolvedConfig({ skipModelNormalize: true });
    const candidates = routingCandidates(resolved);
    const tiers = {};
    for (const tier of ['light','standard','strong']) {
      const entries = patch.tiers?.[tier];
      if (!Array.isArray(entries) || entries.length > 30) throw new Error('模型档位无效。');
      tiers[tier] = entries.map(entry => {
        if (!candidates.some(c => c.connectionId === entry.connectionId && c.model === entry.model)) throw new Error('模型目录已改变，请重新选择。');
        return { connectionId: entry.connectionId, model: entry.model, vision: entry.vision === true };
      });
    }
    const smartRouting = { revision: patch.revision + 1, defaultMode: patch.defaultMode, preference: patch.preference, allowCrossConnection: patch.allowCrossConnection, allowEscalation: patch.allowEscalation, tiers };
    await saveConfig({ ...config, smartRouting, autosaveRevision: Math.max(Date.now(), (config.autosaveRevision || 0) + 1) });
    return publicSmartRouting({ ...resolved, smartRouting });
  }));
}
