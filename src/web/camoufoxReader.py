#!/usr/bin/env python3
import json
import sys


def parse_cookie_header(cookie_header):
    cookies = []
    for part in (cookie_header or "").split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        if not name:
            continue
        cookies.append({
            "name": name,
            "value": value.strip(),
            "url": sys.argv[1],
        })
    return cookies


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: camoufoxReader.py <url> [max_chars] [cookies]")

    url = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 20000
    cookie_header = sys.argv[3] if len(sys.argv) > 3 else ""

    from camoufox.sync_api import Camoufox

    with Camoufox(headless=True) as browser:
        page = browser.new_page()
        cookies = parse_cookie_header(cookie_header)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass

        page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Close common login/app overlays without clicking arbitrary CTA buttons.
        page.evaluate("""async () => {
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const visible = el => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              Number(style.opacity || 1) > 0.05;
          };
          const textOf = el => [
            el.innerText || '',
            el.textContent || '',
            el.getAttribute?.('aria-label') || '',
            el.getAttribute?.('title') || '',
            el.getAttribute?.('class') || '',
          ].filter(Boolean).join(' ').trim();
          const closePattern = /(关闭|关闭登录|暂不登录|稍后|稍后再说|取消|不登录|跳过|close|dismiss|later|not now|skip|×|✕|x)/i;
          const selectors = [
            '[aria-label*="关闭"]',
            '[aria-label*="close" i]',
            '[title*="关闭"]',
            '[title*="close" i]',
            '[class*="close" i]',
            '[class*="modal" i] button',
            '[class*="login" i] button',
            '[role="button"]',
            'button',
            'svg',
          ];
          for (let round = 0; round < 4; round += 1) {
            const candidates = new Set();
            for (const selector of selectors) {
              try {
                document.querySelectorAll(selector).forEach(el => candidates.add(el));
              } catch {}
            }
            for (const el of candidates) {
              if (!visible(el)) continue;
              const label = textOf(el);
              const rect = el.getBoundingClientRect();
              const looksLikeCornerX =
                rect.width <= 80 && rect.height <= 80 &&
                (label === '×' || label === 'x' || label === 'X' || /close|关闭/i.test(label)) &&
                (rect.right > window.innerWidth * 0.45 || rect.top < window.innerHeight * 0.45);
              if (!closePattern.test(label) && !looksLikeCornerX) continue;
              try {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              } catch {}
            }
            await sleep(550);
          }
          for (const video of Array.from(document.querySelectorAll('video')).slice(0, 3)) {
            try {
              video.muted = true;
              video.play?.().catch?.(() => {});
            } catch {}
          }
          await sleep(1200);
        }""")

        title = ""
        body = ""
        try:
            title = page.title() or ""
        except Exception:
            title = ""
        try:
            body = page.locator("body").inner_text(timeout=5000) or ""
        except Exception:
            body = ""

        text = "\n\n".join(part.strip() for part in [title, body] if part and part.strip())
        print(json.dumps({
            "method": "camoufox",
            "url": page.url,
            "content": text[:max_chars],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
