// Archived channel integrations retain their existing explicit mention/score
// gates. Ambiguous group messages no longer make a hidden classifier request.
import { normalizeMessageAttachments } from '../../shared/helpers.js';

export async function classifyGroupMessageAddressal(incoming, recentChat, config, profile, { signal } = {}) {
  signal?.throwIfAborted();
  const text = String(incoming?.text || '').trim();
  return !text && normalizeMessageAttachments(incoming?.attachments).some(a => a.kind === 'audio');
}
