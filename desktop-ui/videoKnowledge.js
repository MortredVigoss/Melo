// A processed video becomes a reusable knowledge note: what was seen (frame
// time points) and what was said (transcript), so any Agent can study it later.
const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function videoExtraction(message, attachment) {
  const media = Array.isArray(message?.extractedMedia) ? message.extractedMedia : [];
  return media.find(entry => entry?.attachmentId === attachment?.id && entry?.metadata?.originalKind === 'video') || null;
}

export function videoKnowledgeNote(attachment, entry) {
  const name = attachment?.title || attachment?.fileName || '视频';
  const meta = entry?.metadata || {};
  const times = Array.isArray(meta.keyframeTimes) ? meta.keyframeTimes : [];
  const transcript = String(entry?.text || '').trim();
  const lines = [`# 视频资料：${name}`, ''];
  if (times.length) lines.push(`- 关键画面：${times.length} 张，时间点 ${times.map(clock).join('、')}`);
  lines.push(`- 文字稿来源：${meta.source === 'video-keyframes-only' ? '无可识别语音' : '视频语音转写'}`, '');
  lines.push('## 文字稿', '', meta.source === 'video-keyframes-only' || !transcript ? '（这段视频没有可识别的语音。）' : transcript);
  return { title: `视频：${name}`.slice(0, 120), content: lines.join('\n'), kind: 'note', language: 'markdown' };
}
