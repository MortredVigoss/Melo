import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThreadContext,
  renderThreadMemorySnapshot,
} from './threadContext.js';

function msg(role, content, id) {
  return { id, role, content };
}

test('thread context suppresses assistant provider and social-link diagnostics', () => {
  const context = buildThreadContext({
    chat: {
      title: 'Douyin retry',
      messages: [
        msg('user', '重新看这个抖音链接 https://v.douyin.com/abc/', 'u1'),
        msg(
          'assistant',
          '这个结果很明确。抖音链接需要 fresh cookies，当前抓取环境没有临时访问凭证。',
          'a1',
        ),
        msg(
          'assistant',
          'Codex blocked this request because the current thread context looked cybersecurity-sensitive.',
          'a2',
        ),
        msg('user', '重新再看一下说了什么', 'u2'),
      ],
    },
    latestUserMessage: '重新再看一下说了什么',
  });

  const rendered = renderThreadMemorySnapshot(context);
  assert.match(rendered, /重新再看一下说了什么/);
  assert.doesNotMatch(rendered, /fresh cookies/i);
  assert.doesNotMatch(rendered, /临时访问凭证/);
  assert.doesNotMatch(rendered, /cybersecurity/i);
  assert.doesNotMatch(rendered, /Codex blocked/i);
});
