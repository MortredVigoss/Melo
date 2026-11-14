/**
 * overlayCloser.js
 *
 * Closing a login / "open in app" overlay in a page that was opened only to
 * READ a link. The page carries the person's saved sign-in cookies, so the one
 * thing this code must never do is press a control that acts on their account.
 *
 * Until 2026-11-14 two copies of this logic (socialLinkReader.js and
 * camoufoxReader.py) tested every visible button, role=button and svg against
 * a pattern that ended in a bare `x` and was applied to the element's text
 * AND its class attribute as a substring. "Next", "Explore", a class of
 * `flex` or `px-4`, "取消关注", "稍后再看" all matched and were clicked.
 *
 * Now there is one rule, written as a plain function so it can be tested
 * without a browser, and one script built from it that both readers run:
 *   - a control is pressed only when its OWN label, as a whole, is a
 *     close / later phrase, or it is a small unlabelled icon inside an
 *     overlay whose class carries the word `close`;
 *   - a class name is never matched as text, and nothing matches by substring;
 *   - links, form submits and inputs are never pressed;
 *   - each control is pressed at most once (an icon and the button around it count as one).
 */

/**
 * @param {{ ariaLabel?: string, title?: string, text?: string, className?: string,
 *           tag?: string, type?: string, width?: number, height?: number,
 *           inLink?: boolean, inOverlay?: boolean }} control
 * @returns {boolean}
 */
export function isOverlayCloseControl(control) {
  // Everything this function needs is inside it: its source text is injected into the page.
  const PHRASES = [
    '关闭', '关闭登录', '关闭弹窗', '暂不登录', '不登录', '稍后', '稍后再说', '以后再说', '取消', '跳过',
    'close', 'dismiss', 'later', 'not now', 'maybe later', 'no thanks', 'skip',
  ];
  const SYMBOLS = ['×', '✕', '✖', 'x'];
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const tag = clean(control?.tag);
  const type = clean(control?.type);
  if (control?.inLink || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return false;
  if (type === 'submit') return false;

  const width = Number(control?.width) || 0;
  const height = Number(control?.height) || 0;
  if (width <= 0 || height <= 0) return false;
  const small = width <= 80 && height <= 80;

  const isPhrase = value => PHRASES.includes(value);
  const isSymbol = value => SYMBOLS.includes(value);
  const text = clean(control?.text);
  const announced = [clean(control?.ariaLabel), clean(control?.title)].filter(Boolean);
  const buttonSized = width <= 400 && height <= 120;

  // What is SHOWN decides first: "Follow" announced as "close" is still a Follow button.
  if (text && !isSymbol(text)) return isPhrase(text) && buttonSized;
  // It shows nothing, or only a × mark: the announced name decides when there is one.
  if (announced.some(isPhrase)) return buttonSized;
  if (announced.some(value => !isSymbol(value))) return false;        // announced as something else
  // A lone × / x is a close mark only as a small control floating over the page.
  if (text || announced.length) return small && Boolean(control?.inOverlay);

  // Nothing shown and nothing announced: an icon. Only inside an overlay, only
  // when small, and only when one of its class WORDS is exactly `close`
  // (`btn-close`, `closeIcon`, `modal__close`; not `closed`, `disclose`, `closest`).
  if (!small || !control?.inOverlay) return false;
  const words = String(control?.className || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.includes('close');
}

/**
 * Source of an async function expression for `page.evaluate` / a Playwright
 * `eval`: presses the close controls of the page it runs in, in up to `rounds`
 * passes (overlays often appear one after another), and resolves to how many
 * controls it pressed.
 */
export function overlayCloserSource({ rounds = 4, settleMs = 550 } = {}) {
  return `async () => {
    const isOverlayCloseControl = ${isOverlayCloseControl.toString()};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.05;
    };
    const inOverlay = el => {
      for (let node = el, depth = 0; node && node !== document.documentElement && depth < 16; node = node.parentElement, depth += 1) {
        if (node.getAttribute?.('role') === 'dialog' || node.getAttribute?.('aria-modal') === 'true') return true;
        if (getComputedStyle(node).position === 'fixed') return true;
      }
      return false;
    };
    const describe = el => {
      const rect = el.getBoundingClientRect();
      const svgTitle = el.tagName?.toLowerCase() === 'svg' ? (el.querySelector?.('title')?.textContent || '') : '';
      return {
        tag: el.tagName || '',
        type: el.getAttribute?.('type') || '',
        text: el.innerText || '',
        ariaLabel: el.getAttribute?.('aria-label') || '',
        title: el.getAttribute?.('title') || svgTitle,
        className: el.getAttribute?.('class') || '',
        width: rect.width,
        height: rect.height,
        inLink: Boolean(el.closest?.('a[href]')),
        inOverlay: inOverlay(el),
      };
    };
    const pressed = [];
    let count = 0;
    for (let round = 0; round < ${Number(rounds) || 0}; round += 1) {
      let candidates = [];
      try {
        candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [class*="close" i]'));
      } catch {}
      for (const el of candidates) {
        // Once per control: an icon and the button around it are the same control.
        if (pressed.some(done => done === el || done.contains(el) || el.contains(done)) || !visible(el)) continue;
        let close = false;
        try { close = isOverlayCloseControl(describe(el)); } catch {}
        if (!close) continue;
        pressed.push(el);
        try {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          count += 1;
        } catch {}
      }
      await sleep(${Number(settleMs) || 0});
    }
    return count;
  }`;
}
