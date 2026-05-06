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
          'Could not read this social-link URL: https://v.douyin.com/abc/. ' +
          "Add the host's cookie string under Customize → Safety → Web-fetch cookies.",
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
  assert.doesNotMatch(rendered, /Could not read this social-link URL/);
  assert.doesNotMatch(rendered, /Web-fetch cookies/);
  assert.doesNotMatch(rendered, /cybersecurity/i);
  assert.doesNotMatch(rendered, /Codex blocked/i);
});

test('thread context preserves normal assistant explanations about cookies', () => {
  // Negative case: a legitimate assistant answer that happens to discuss
  // cookies (e.g. teaching a user about web fundamentals) must NOT be
  // suppressed — only the social-link extractor's failure diagnostics are.
  const context = buildThreadContext({
    chat: {
      title: 'How does the web work',
      messages: [
        msg('user', '解释一下 session cookies 是怎么工作的', 'u1'),
        msg(
          'assistant',
          'Session cookies 是浏览器保存的 key-value 对，服务器用 Set-Cookie header 写入，' +
          '后续请求自动带回。它们在浏览器关闭时被清空，用于追踪登录状态等。',
          'a1',
        ),
        msg('user', '那 browser cookies 跟它有什么不同', 'u2'),
        msg(
          'assistant',
          'Browser cookies 是统称，包含 session cookies 和 persistent cookies 两类。',
          'a2',
        ),
        msg('user', '再详细说一下 persistent 那种', 'u3'),
      ],
    },
    latestUserMessage: '再详细说一下 persistent 那种',
  });

  const rendered = renderThreadMemorySnapshot(context);
  assert.match(rendered, /Session cookies 是浏览器/);
  assert.match(rendered, /Browser cookies 是统称/);
});
