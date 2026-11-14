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
        raise SystemExit("usage: camoufoxReader.py <url> [max_chars] [cookies] [overlay_script]")

    url = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 20000
    cookie_header = sys.argv[3] if len(sys.argv) > 3 else ""
    overlay_script = sys.argv[4] if len(sys.argv) > 4 else ""

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

        # Close login / app-prompt overlays. The script comes from the caller
        # (src/web/overlayCloser.js): this page carries the person's sign-in
        # cookies, so what may be pressed is decided by one tested rule, not by a
        # second copy here. Without it nothing is pressed.
        if overlay_script:
            try:
                page.evaluate(overlay_script)
            except Exception:
                pass

        page.evaluate("""async () => {
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
