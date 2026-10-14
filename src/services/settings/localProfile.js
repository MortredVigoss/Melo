import { normalizeAgentAvatar } from '../agent/agentAvatar.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext, currentRequestContext } from '../../runtime/requestScope.js';
import { normalizeLocalPreferences, validateLocalPreferencePatch } from '../../domain/settings/localPreferences.js';

export async function updateLocalProfile(body = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateLocalProfile(body));
  const patch = {};
  if (Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || [...body.name.trim()].length > 40 || /[\u0000-\u001f\u007f]/.test(body.name)) throw new Error('昵称请输入 1–40 个字符。');
    patch.name = body.name.trim();
  }
  if (Object.hasOwn(body, 'avatarData')) patch.avatarData = await normalizeAgentAvatar(body.avatarData);
  const prefs = body.preferences === undefined ? null : validateLocalPreferencePatch(body.preferences);
  await updateStateAtomically(state => {
    state.settings.localProfile = { ...state.settings.localProfile, ...patch };
    if (prefs) state.settings.localPreferences = normalizeLocalPreferences({ ...state.settings.localPreferences, ...prefs });
    return state;
  });
  return getDesktopBootstrap();
}
