/**
 * overlayCloser.test.js — the rule for what a link reader may press.
 *
 * The page it runs in carries the person's saved sign-in cookies. Before
 * 2026-11-14 the rule was a substring pattern ending in a bare `x`, matched
 * against text and class names alike: nearly every button qualified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isOverlayCloseControl, overlayCloserSource } from './overlayCloser.js';

const control = (overrides = {}) => ({
  tag: 'BUTTON', type: '', text: '', ariaLabel: '', title: '', className: '',
  width: 64, height: 32, inLink: false, inOverlay: false, ...overrides,
});

test('a control whose own label is a close or later phrase is pressed', () => {
  for (const text of ['关闭', '关闭登录', '暂不登录', '不登录', '稍后', '稍后再说', '取消', '跳过', 'Close', 'DISMISS', 'Later', 'Not now', 'Maybe later', 'No thanks', 'Skip', '  not   now  ']) {
    assert.equal(isOverlayCloseControl(control({ text })), true, text);
  }
  assert.equal(isOverlayCloseControl(control({ tag: 'DIV', ariaLabel: '关闭', width: 24, height: 24 })), true, 'announced name, nothing shown');
  assert.equal(isOverlayCloseControl(control({ tag: 'svg', title: 'Close', width: 20, height: 20 })), true, 'svg title');
  assert.equal(isOverlayCloseControl(control({ text: '×', ariaLabel: 'Close' })), true, 'a × announced as Close needs no overlay');
});

test('everything the old pattern pressed by accident is left alone', () => {
  const never = [
    // The bare `x` at the end of the old pattern, in text:
    { text: 'Next' }, { text: 'Explore' }, { text: 'Expand' }, { text: 'Export data' }, { text: 'Fix it' },
    // ...and in class names, which the old code matched as if they were text:
    { text: 'Like', className: 'flex px-4 max-w-xs' }, { text: '', ariaLabel: 'Like', className: 'flex items-center px-4' },
    { tag: 'svg', className: 'flex-shrink-0 box-border', width: 24, height: 24, inOverlay: true },
    // Phrases as substrings of something else:
    { text: '取消关注' }, { text: '稍后再看' }, { text: '跳过广告并购买' }, { text: 'Close friends' }, { text: 'Skip to checkout' },
    { text: 'Later this week' }, { text: '关闭评论区并举报' }, { ariaLabel: 'Close account' },
    // Account actions that merely look small or sit in an overlay:
    { text: '关注', inOverlay: true }, { text: 'Follow', inOverlay: true }, { text: '发送', inOverlay: true }, { text: 'Delete', inOverlay: true },
    { text: 'Buy now', className: 'close-deal', inOverlay: true },
  ];
  for (const overrides of never) assert.equal(isOverlayCloseControl(control(overrides)), false, JSON.stringify(overrides));
});

test('what is shown wins over what is announced, and a non-close name vetoes an icon', () => {
  assert.equal(isOverlayCloseControl(control({ text: 'Follow', ariaLabel: 'close' })), false);
  assert.equal(isOverlayCloseControl(control({ text: '', ariaLabel: 'Search', className: 'icon close', inOverlay: true })), false);
  assert.equal(isOverlayCloseControl(control({ text: '×', ariaLabel: 'Remove item', inOverlay: true })), false);
});

test('a lone × or x is a close mark only as a small control inside an overlay', () => {
  for (const text of ['×', '✕', '✖', 'x', 'X']) {
    assert.equal(isOverlayCloseControl(control({ text, width: 28, height: 28, inOverlay: true })), true, text);
    assert.equal(isOverlayCloseControl(control({ text, width: 28, height: 28, inOverlay: false })), false, `${text} in the page`);
    assert.equal(isOverlayCloseControl(control({ text, width: 200, height: 48, inOverlay: true })), false, `${text} on a large control`);
  }
});

test('an unlabelled icon needs an overlay, a small size and the class WORD close', () => {
  const icon = overrides => control({ tag: 'DIV', width: 24, height: 24, inOverlay: true, ...overrides });
  for (const className of ['close', 'btn-close', 'closeIcon', 'modal__close', 'login-close dy-account-close', 'icon icon_close']) {
    assert.equal(isOverlayCloseControl(icon({ className })), true, className);
  }
  for (const className of ['closed', 'disclose', 'closest-match', 'enclosed', 'flex', 'px-4', 'xclose2x', '']) {
    assert.equal(isOverlayCloseControl(icon({ className })), false, className);
  }
  assert.equal(isOverlayCloseControl(icon({ className: 'btn-close', inOverlay: false })), false, 'not in an overlay');
  assert.equal(isOverlayCloseControl(icon({ className: 'btn-close', width: 300, height: 300 })), false, 'not small');
});

test('links, inputs, form submits and oversized or invisible elements are never pressed', () => {
  assert.equal(isOverlayCloseControl(control({ text: 'Close', inLink: true })), false);
  assert.equal(isOverlayCloseControl(control({ tag: 'A', text: 'Close' })), false);
  assert.equal(isOverlayCloseControl(control({ tag: 'A', ariaLabel: 'X', width: 30, height: 30, inOverlay: true })), false, 'a site logo link named X');
  assert.equal(isOverlayCloseControl(control({ tag: 'INPUT', ariaLabel: 'close' })), false);
  assert.equal(isOverlayCloseControl(control({ text: 'Cancel', type: 'submit' })), false);
  assert.equal(isOverlayCloseControl(control({ text: '取消', type: 'submit' })), false);
  assert.equal(isOverlayCloseControl(control({ text: 'Close', width: 900, height: 600 })), false, 'a whole panel whose only text is Close');
  assert.equal(isOverlayCloseControl(control({ text: 'Close', width: 0, height: 0 })), false);
  assert.equal(isOverlayCloseControl(undefined), false);
});

test('the page script is built from the tested rule and both readers use it, with no copy of their own', async () => {
  const source = overlayCloserSource();
  assert.ok(source.startsWith('async () => {'));
  assert.ok(source.includes(isOverlayCloseControl.toString()), 'the injected rule is this exact function');
  assert.doesNotThrow(() => new Function(`return (${source})`));
  assert.match(overlayCloserSource({ rounds: 2, settleMs: 10 }), /round < 2;[\s\S]*sleep\(10\)/);

  const [reader, wrapper, external] = await Promise.all([
    readFile(new URL('../services/search/socialLinkReader.js', import.meta.url), 'utf8'),
    readFile(new URL('./camoufoxReader.py', import.meta.url), 'utf8'),
    readFile(new URL('./externalReaders.js', import.meta.url), 'utf8'),
  ]);
  assert.match(reader, /const closeOverlays = \$\{overlayCloserSource\(\)\};/);
  assert.match(external, /cookieStr,[\s\S]{0,260}overlayCloserSource\(\),/);
  for (const [name, text] of [['socialLinkReader.js', reader], ['camoufoxReader.py', wrapper]]) {
    assert.doesNotMatch(text, /closePattern|dispatchEvent|MouseEvent/, `${name} presses nothing by itself`);
  }
  assert.match(wrapper, /if overlay_script:\s+try:\s+page\.evaluate\(overlay_script\)/, 'the wrapper runs the script it is given, and only that');
});
