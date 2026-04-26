// Vision-debug formatter — sub-phase 7d-5β of the desktopStore
// decomposition. Pure leaf: render a single model-facing message into a
// one-line debug string for the vision-debug stdout dump. Byte-for-byte
// port from desktopStore.js (CLAUDE.md §5).

export function formatModelMessageForVisionDebug(message, index) {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return `[vision-debug] msg[${index}] role=${message?.role || 'unknown'}: [plain: ${String(content || '').slice(0, 80)}]`;
  }

  const parts = content.map(part => {
    if (part?.type === 'image_url') {
      return `[image_url: ${String(part?.image_url?.url || '').slice(0, 40)}...]`;
    }
    if (part?.type === 'audio_attachment') {
      return `[audio_attachment: ${String(part?.audio_attachment?.url || '').slice(0, 40)}...]`;
    }
    if (part?.type === 'video_attachment') {
      return `[video_attachment: ${String(part?.video_attachment?.url || '').slice(0, 40)}...]`;
    }
    if (part?.type === 'text') {
      return `[text: ${String(part?.text || '').slice(0, 60)}]`;
    }
    return `[${String(part?.type || 'unknown')}]`;
  }).join(' + ');

  return `[vision-debug] msg[${index}] role=${message?.role || 'unknown'}: ${parts}`;
}
