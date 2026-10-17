import test from 'node:test';
import assert from 'node:assert/strict';
import { videoExtraction, videoKnowledgeNote } from './videoKnowledge.js';

test('a processed video becomes a knowledge note with frame times and the transcript', () => {
  const attachment = { id: 'v1', title: '课程.mp4' };
  const message = { extractedMedia: [{ attachmentId: 'other', metadata: { originalKind: 'video' } }, { attachmentId: 'v1', text: '大家好，今天讲排序。', metadata: { originalKind: 'video', source: 'whisper-cpp', keyframeTimes: [0, 75, 150] } }] };
  const entry = videoExtraction(message, attachment);
  assert.equal(entry.text, '大家好，今天讲排序。');
  const note = videoKnowledgeNote(attachment, entry);
  assert.equal(note.title, '视频：课程.mp4');
  assert.match(note.content, /时间点 00:00、01:15、02:30/);
  assert.match(note.content, /## 文字稿\n\n大家好，今天讲排序。/);
  const silent = videoKnowledgeNote(attachment, { text: 'placeholder', metadata: { source: 'video-keyframes-only', keyframeTimes: [0] } });
  assert.match(silent.content, /没有可识别的语音/);
  assert.equal(videoExtraction({ extractedMedia: [] }, attachment), null);
});
