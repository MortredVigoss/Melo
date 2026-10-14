import { imageSettings, imageConnection, visionConnection } from '../../images/imageSettings.js';
// Architecture migration: byte-for-byte command port.
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { DEFAULT_CONFIG, DEFAULT_MODEL_CATALOGS, loadConfig, normalizeModelCatalogs, saveConfig, withConfigLock } from '../../config.js';
import { discoverAvailableModels } from '../../openai.js';

export async function updateModelConfig(patch = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateModelConfig(...arguments));
  // Serialize the entire read-modify-write through the shared config
  // queue: without atomicity, two concurrent autosaves can both load
  // the same baseline `autosaveRevision`, both pass the revision
  // gate below, and the slower POST overwrites the faster one when
  // it finally reaches saveConfig — exactly the race the gate was
  // meant to close. (Codex C 第十二轮 audit 2026-04-28.)
  return withConfigLock(async () => {
    return updateModelConfigInner(patch);
  });
}

async function updateModelConfigInner(patch = {}) {
  const current = await loadConfig();

  // ── Autosave revision gate (Codex audit 2026-04-28) ──────────────────────
  // The connector form's 3-second idle autosave can race itself: an older
  // inflight POST 仍在 server 处理时，更新的 pending body 已经被 client
  // beacon 发出。sendBeacon doesn't guarantee delivery order, so without
  // server-side ordering the older inflight body could land last and
  // clobber the newer one. Solution: every autosave/flush attaches a
  // monotonic `_autosaveRevision` (Date.now() on the client). Server
  // refuses to apply a patch whose revision is <= the saved revision,
  // returning the current bootstrap unchanged. Explicit Save (and any
  // legacy caller) sends NO `_autosaveRevision` and is treated as a
  // force-write — it always applies and bumps the saved revision to
  // max(current, Date.now()), invalidating every autosave revision
  // older than that.
  const incomingRevision =
    typeof patch._autosaveRevision === 'number' && Number.isFinite(patch._autosaveRevision)
      ? patch._autosaveRevision
      : null;
  const currentRevision =
    typeof current.autosaveRevision === 'number' && Number.isFinite(current.autosaveRevision)
      ? current.autosaveRevision
      : 0;
  if (incomingRevision !== null && incomingRevision <= currentRevision) {
    // Stale autosave — older inflight body losing the race against a
    // newer pending body that already landed. Keep saved state, return
    // unchanged bootstrap so the client's applyBootstrap reads the
    // newer state.
    return getDesktopBootstrap();
  }
  // The "force write" path (explicit Save without _autosaveRevision)
  // bumps revision to current wall-clock so that any autosave still
  // in-flight with a smaller Date.now() is automatically rejected
  // when it lands.
  const nextAutosaveRevision = incomingRevision !== null
    ? incomingRevision
    : Math.max(currentRevision, Date.now());

  // Protect secret-like settings: a blank string on the inbound patch must be
  // interpreted as "user didn't provide this field" rather than "user wants
  // this cleared". The old behaviour silently wiped apiKey / baseUrl / TTS
  // credentials any time the UI posted a partial form (e.g. MiniMax voice
  // toggle). Explicit clearing still works by passing the authMode that
  // implies the clear (e.g. authMode='codex' clears apiKey). See
  // feedback_preserve_user_config.md.
  const keepIfBlank = (patchVal, currentVal) =>
    typeof patchVal === 'string' && patchVal.trim()
      ? patchVal
      : currentVal;

  const safePatch = { ...patch };
  if ('imageSettings' in safePatch) {
    if (!safePatch.imageSettings || typeof safePatch.imageSettings !== 'object' || Array.isArray(safePatch.imageSettings)) throw new Error('图片设置无效。');
    const settings=imageSettings({...current,imageSettings:safePatch.imageSettings});
    if (!['codex-oauth','openai-api','sdcpp','minimax'].includes(settings.engine) || [settings.model,settings.codexModel].some(m=>typeof m!=='string' || m.length>200 || /[\r\n\0]/.test(m))) throw new Error('生图引擎或模型 ID 无效。');
    imageConnection(current,settings);
    visionConnection({...current,imageSettings:settings});
    safePatch.imageSettings=settings;
  }
  // `_autosaveRevision` is metadata, not a config field — strip before merge
  // so it doesn't end up persisted twice (once as config field, once via
  // the explicit autosaveRevision below).
  delete safePatch._autosaveRevision;
  // Fields that fall under the "preserve when blank" rule
  // (feedback_preserve_user_config.md). Most are credentials, but
  // minimaxVoiceId joins the list because the TTS panel's
  // `activate-minimax-voice` action POSTs the resolved voice id —
  // when no agent / cached voice is available, we used to send '' and
  // wipe the connector's saved Default Voice ID. Empty here = "no
  // change", so the user clears via a different code path (e.g. typing
  // a different value, or a future explicit Clear button).
  const SECRET_LIKE_CONFIG_KEYS = [
    'apiKey',
    'baseUrl',
    'whisperApiKey',
    'whisperBaseUrl',
    'minimaxApiKey',
    'minimaxGroupId',
    'minimaxBaseUrl',
    'minimaxVoiceId',
    'ttsApiKey',
    'ttsBaseUrl',
    'elevenLabsApiKey',
  ];
  for (const key of SECRET_LIKE_CONFIG_KEYS) {
    if (!(key in safePatch)) continue;
    const v = safePatch[key];
    if (typeof v !== 'string' || !v.trim()) {
      delete safePatch[key];
    }
  }

  const leavesConnection = ['authMode', 'baseUrl', 'apiKey', 'apiProtocol'].some(key => key in safePatch && safePatch[key] !== current[key]);
  if (!leavesConnection && 'model' in safePatch && current.activeLlmProfileId) {
    const id = current.activeLlmProfileId;
    const profile = current.llmProfiles?.[id];
    if (profile) {
      const model = String(safePatch.model || '').trim();
      if (!model || model.length > 200 || /[\r\n\0]/.test(model)) throw new Error('模型 ID 无效。');
      safePatch.model = model;
      safePatch.llmProfiles = { ...current.llmProfiles, [id]: { ...profile, model,
        revision: (profile.revision || 0) + 1, test: model === profile.model ? profile.test : null, visionTest: model === profile.model ? profile.visionTest : null } };
    }
  }
  await saveConfig({
    ...current,
    ...safePatch,
    ...(leavesConnection ? { activeLlmProfileId: '', apiProtocol: safePatch.apiProtocol || 'chat-completions' } : {}),
    modelCatalogs: normalizeModelCatalogs(safePatch.modelCatalogs || current.modelCatalogs || DEFAULT_MODEL_CATALOGS),
    apiKey:
      patch.authMode === 'codex'
        ? ''
        : keepIfBlank(safePatch.apiKey, current.apiKey),
    // Preserve existing whisper key when blank string is submitted (user left field empty)
    whisperApiKey: keepIfBlank(patch.whisperApiKey, current.whisperApiKey),
    whisperBaseUrl:
      typeof patch.whisperBaseUrl === 'string' && patch.whisperBaseUrl.trim()
        ? patch.whisperBaseUrl.trim()
        : current.whisperBaseUrl,
    autosaveRevision: nextAutosaveRevision,
  });
  return getDesktopBootstrap();
}

export async function refreshModelCatalog(patch = {}, options = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => refreshModelCatalog(...arguments));
  // catalog-only contract: every read on this path uses
  // skipModelNormalize so an out-of-catalog saved model isn't
  // pre-folded the moment we touch disk. Codex audit 2026-04-29.
  const initialConfig = await loadConfig({ skipModelNormalize: true });
  const authMode =
    typeof patch.authMode === 'string' &&
    ['local', 'api-key', 'codex'].includes(patch.authMode.trim())
      ? patch.authMode.trim()
      : initialConfig.authMode || DEFAULT_CONFIG.authMode;
  const baseUrl =
    typeof patch.baseUrl === 'string' && patch.baseUrl.trim()
      ? patch.baseUrl.trim()
      : initialConfig.baseUrl || DEFAULT_CONFIG.baseUrl;
  const model =
    typeof patch.model === 'string' && patch.model.trim()
      ? patch.model.trim()
      : initialConfig.model || DEFAULT_CONFIG.model;
  const apiKey =
    typeof patch.apiKey === 'string' && patch.apiKey.trim()
      ? patch.apiKey.trim()
      : initialConfig.apiKey || '';

  // Network call OUTSIDE the lock — concurrent writers stay unblocked.
  // `_discoverFn` is a test seam (default: real discoverAvailableModels)
  // so a concurrent regression test can simulate a 100ms discovery
  // window during which an interleaved updateModelConfig writes new
  // form fields, and assert refresh does NOT roll those back.
  const discoverFn = typeof options._discoverFn === 'function'
    ? options._discoverFn
    : discoverAvailableModels;
  const discovered = await discoverFn({
    authMode,
    apiProtocol: patch.apiProtocol || initialConfig.apiProtocol,
    apiKey,
    baseUrl,
    model,
  });

  // Atomic catalog patch: re-read inside the lock so any
  // updateModelConfig that landed during discovery is preserved in
  // full. We touch ONLY the modelCatalogs map for the resolved
  // authMode; everything else (authMode itself, baseUrl, model,
  // apiKey, systemPrompt, autosaveRevision, …) flows through from
  // the freshly-reloaded current state untouched.
  //
  // `skipModelNormalize: true` is the missing piece of the
  // catalog-only contract — without it, normalizeConfigShape's
  // resolveModelForAuthMode would silently fold the saved model
  // to catalog[0] whenever the user's saved model isn't in the
  // freshly-discovered catalog. That side-effect would write to
  // the model field on a "Read available models" click, which is
  // exactly what the catalog-only contract forbids. Codex audit
  // 2026-04-29.
  return withConfigLock(async () => {
    // Same catalog-only opt-out for the lock-inner re-read: a previous
    // refresh that wrote an out-of-catalog model to disk must not be
    // pre-folded by this read, otherwise we'd then save the folded
    // value and the user's saved choice would die on the second
    // refresh cycle even though the first one preserved it.
    const current = await loadConfig({ skipModelNormalize: true });
    await saveConfig(
      {
        ...current,
        modelCatalogs: {
          ...normalizeModelCatalogs(current.modelCatalogs || DEFAULT_MODEL_CATALOGS),
          [authMode]: discovered,
        },
      },
      { skipModelNormalize: true },
    );
    // Forward the catalog-only opt-out to the bootstrap response so
    // the API/UI surface doesn't undo the protection by re-folding
    // the model through `getResolvedConfig` → `resolveModelForAuthMode`.
    // Codex audit 2026-04-29: without this, the wire returns the
    // folded model even though disk holds the saved one.
    return getDesktopBootstrap('', { skipModelNormalize: true });
  });
}
