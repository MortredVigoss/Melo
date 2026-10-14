// URLs pasted into prose stop at quotation marks and CJK sentence delimiters.
// Percent-encoded punctuation remains part of the URL.
export function extractTextUrls(text = '') {
  const matches = String(text).match(/https?:\/\/[^\s<>"'`，。！？；：“”‘’「」《》【】]+/giu) || [];
  return [...new Set(matches.map(value => {
    // The first unmatched closer ends prose/Markdown, even when text follows
    // immediately: [查看](https://example.com?q=1)查看. Balanced URL brackets
    // (Wikipedia paths, IPv6 hosts) remain intact.
    let url = value;
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      let depth = 0;
      for (let i = 0; i < url.length; i += 1) {
        if (url[i] === open) depth += 1;
        if (url[i] === close && --depth < 0) { url = url.slice(0, i); break; }
      }
    }
    return url.replace(/[.,!?;:]+$/u, '');
  }))];
}
