/**
 * overlayCloser.browser.test.js — the page script in a real page.
 *
 * The rule itself is covered without a browser (overlayCloser.test.js). This
 * checks what only a real page can: that the script finds the close controls
 * of an overlay through layout (size, fixed positioning, visible text), and
 * that on a page full of ordinary signed-in controls it presses nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

import { launchTestChrome } from '../testSupport/testChrome.js';
import { overlayCloserSource } from './overlayCloser.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 14px sans-serif; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #eee; }
  main { padding: 64px 16px; }
  button, [role=button] { min-width: 60px; height: 32px; margin: 4px; }
  .modal { position: fixed; inset: 80px 200px auto 200px; height: 260px; background: #fff; border: 1px solid #999; }
  .icon { display: inline-block; width: 24px; height: 24px; background: #ccc; }
  .flex { display: flex; } .px-4 { padding: 0 16px; }
  .hidden { display: none; }
</style></head><body>
  <header>
    <a id="logo" href="#home" aria-label="X" style="display:inline-block;width:32px;height:32px">X</a>
    <button id="search" aria-label="Search" class="icon"></button>
  </header>
  <main>
    <button id="next">Next</button>
    <button id="explore">Explore</button>
    <button id="unfollow">取消关注</button>
    <button id="watch-later">稍后再看</button>
    <button id="like" class="flex px-4">Like</button>
    <div id="follow" role="button" class="flex px-4">关注</div>
    <svg id="plain-svg" class="flex" width="24" height="24"><rect width="24" height="24"/></svg>
    <span id="page-x" class="icon tag-close">x</span>
    <form><button id="submit" type="submit">取消</button></form>
    <button id="buy" class="close-deal">Buy now</button>
    <button id="invisible-close" class="hidden">关闭</button>
  </main>
  <div class="modal" role="dialog">
    <div id="modal-icon" class="icon login__close"><svg id="modal-icon-svg" class="close-svg" width="16" height="16"><rect width="16" height="16"/></svg></div>
    <span id="modal-x" class="icon popup-close">×</span>
    <button id="modal-later">稍后再说</button>
    <button id="modal-login">登录</button>
    <button id="modal-agree" class="flex px-4">同意并继续</button>
  </div>
</body></html>`;

async function pressedBy(browser, html, options) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent(html);
    await page.evaluate(() => {
      window.pressed = [];
      document.addEventListener('click', event => {
        event.preventDefault();
        // The element the click was dispatched on, not what it bubbled to.
        window.pressed.push(event.target.id || event.target.tagName);
      }, true);
    });
    const count = await page.evaluate(`(${overlayCloserSource(options)})()`);
    return { count, pressed: await page.evaluate(() => window.pressed) };
  } finally { await page.close(); }
}

test('in a real page only the close controls of an overlay are pressed, each once; a page without one is left untouched', { timeout: 60000 }, async t => {
  const browser = await launchTestChrome(chromium);
  t.after(() => browser.close());

  const { count, pressed } = await pressedBy(browser, PAGE, { rounds: 3, settleMs: 20 });
  // The icon and the svg inside it are one control: pressed once, whichever is met first.
  const icon = pressed.filter(id => id === 'modal-icon' || id === 'modal-icon-svg');
  assert.equal(icon.length, 1, `the modal close icon is pressed exactly once: ${pressed.join(', ')}`);
  assert.deepEqual(pressed.filter(id => !icon.includes(id)).sort(), ['modal-later', 'modal-x']);
  assert.equal(count, 3);
  assert.equal(new Set(pressed).size, pressed.length, 'nothing is pressed twice across rounds');

  // The same page without the overlay: the fixed header, the "x" chip, 取消关注, 稍后再看, Next... all stay untouched.
  const plain = await pressedBy(browser, PAGE.replace(/<div class="modal"[\s\S]*<\/div>\s*<\/body>/, '</body>'), { rounds: 2, settleMs: 10 });
  assert.equal(plain.count, 0);
  assert.deepEqual(plain.pressed, []);
});
