// Pure URL-routing decision shared by every chat click entry point that
// can reach an outbound link (anchor tags, data-external-url cards, etc).
//
// Returning a tagged decision lets the caller stay declarative:
//   - 'same-origin' → preventDefault + location.assign (force same-window
//     navigation; window.open / target="_blank" is a no-op in WKWebView
//     because main.swift has no WKUIDelegate.createWebViewWith handler).
//   - 'external'    → preventDefault + native openExternalUrl (system
//     browser via NSWorkspace.shared.open).
//   - 'invalid'     → caller decides: anchor branch falls through to the
//     browser default (e.g. href="#anchor"), card branch should surface
//     "could not open this link" since the data attribute is malformed.

export function routeHttpUrlClick(hrefRaw, currentOrigin) {
  const href = String(hrefRaw || '').trim();
  if (!/^https?:\/\//i.test(href)) {
    return { kind: 'invalid' };
  }

  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return { kind: 'invalid' };
  }

  if (parsed.origin === currentOrigin) {
    return { kind: 'same-origin', href: parsed.href };
  }

  return { kind: 'external', href: parsed.href };
}
