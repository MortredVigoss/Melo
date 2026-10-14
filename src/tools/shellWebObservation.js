import { JSDOM } from 'jsdom';
import { tokenize, splitCommands, hasUnbalancedQuotes } from '../safety/bashRiskParser.js';
import { sceneUrl } from '../shared/executionScene.js';

// Observation only: this module never runs a command or fetches a URL. Restrict
// request attribution to a literal, single curl call (optionally piped to head).
// URLs in echo, scripts, skipped branches, headers or local files are not visits.
export function shellRequest(command = '') {
  if (hasUnbalancedQuotes(command) || /[\n\r`$;<>]|&&|\|\|/.test(command)) return null;
  const segments = splitCommands(command);
  if (!segments.length || segments.length > 2 || segments.length === 2 && !/^head\s+(?:-c|-n)\s*\d+$/.test(segments[1])) return null;
  const words = tokenize(segments[0]);
  if (words.some(t => t.kind !== 'word') || !/^(?:\/usr\/bin\/)?curl$/.test(words[0]?.text)) return null;
  const flags = new Set(['--silent', '--show-error', '--location', '--fail', '--compressed', '--globoff']);
  const values = new Set(['--max-time', '--connect-timeout', '--user-agent', '-A', '--header', '-H']);
  const urls = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i].text;
    if (flags.has(word) || /^-[sSLfg]+$/.test(word)) continue;
    if (values.has(word)) { if (!words[++i]) return null; continue; }
    if (word === '--url') { if (!words[i + 1]) return null; urls.push(words[++i].text); continue; }
    if (word.startsWith('-')) return null;
    urls.push(word);
  }
  const url = urls.length === 1 && sceneUrl(urls[0]);
  if (!url || /[{}\[\]]/.test(urls[0])) return null;
  const parsed = new URL(url);
  if ([...parsed.searchParams.keys()].some(k => /token|password|secret|api.?key|signature/i.test(k))) return null;
  return { url, provider: parsed.hostname, query: parsed.searchParams.get('q') || parsed.searchParams.get('query') || '' };
}

function xmlText(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, key) => {
      if (key[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key.toLowerCase()] || whole;
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }).trim();
}
const tag = (xml, name) => xmlText(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]);

export function observeShellWeb(args = {}, result, { citationUrls = [] } = {}) {
  const request = shellRequest(args.command);
  if (args.command && !request) return null;
  const observation = request ? { module: 'search', provider: request.provider, requestUrl: request.url,
    query: request.query, input: request.query ? `查询：${request.query}\n${request.url}` : request.url, sources: [] } : null;
  if (!result?.ok || result.meta?.denied || result.meta?.aborted) return observation;
  const body = String(result.meta?.stdout ?? result.output ?? '').replace(/^stdout:\s*\n/, '').slice(0, 100000);
  // Only complete RSS item/link fields are accepted. A truncated URL is never
  // made clickable; legacy recovery can match a long prefix to ONE real final
  // citation, preserving the source title from the actual tool output.
  if (/^\s*(?:<\?xml[^>]*>\s*)?<rss\b/i.test(body)) {
    const channel = body.split(/<item\b/i)[0], channelUrl = sceneUrl(tag(channel, 'link'));
    if (!channelUrl) return observation;
    const parsed = new URL(channelUrl), query = parsed.searchParams.get('q') || request?.query || '';
    const provider = `${request?.provider || parsed.hostname} · RSS`;
    const sources = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap((match, rank) => {
      const url = sceneUrl(tag(match[1], 'link')); if (!url) return [];
      const snippet = tag(match[1], 'description');
      return [{ url, title: tag(match[1], 'title'), snippet, rank, query, provider, appeared: true, reading: snippet ? 'snippet' : 'unknown' }];
    });
    const tail = body.slice(body.lastIndexOf('<item>'));
    const prefix = tail.match(/<link>(https?:\/\/[^<\s]+)$/)?.[1];
    if (prefix?.length >= 64) {
      const matches = citationUrls.filter(url => url.startsWith(xmlText(prefix)));
      if (matches.length === 1) sources.push({ url: matches[0], title: tag(tail, 'title'), rank: sources.length,
        query, provider, appeared: true, reading: 'unknown', recovered: true });
    }
    return { ...observation, module: 'search', provider, query, sources,
      input: observation?.input || `返回检索结果：${query}`, resultSummary: `返回 ${sources.length} 条来源${/<\/rss>\s*$/i.test(body) ? '' : ' · 输出有截断'}` };
  }
  // A returned search HTML document is observable even in old records where
  // command input was discarded. It does not prove any result page was read.
  const googleResponse = /<title>Google Search<\/title>/i.test(body);
  if (!request && !googleResponse) return null;
  if (!/<(?:!doctype|html|title|body)\b/i.test(body)) return observation;
  const dom = new JSDOM(body); // scripts/resources are disabled by default
  try {
    const doc = dom.window.document;
    const searchService = googleResponse || request && /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/.test(new URL(request.url).hostname);
    const sources = [];
    if (searchService) {
      const selectors = googleResponse ? 'div.g' : 'li.b_algo';
      for (const [rank, item] of [...doc.querySelectorAll(selectors)].entries()) {
        const anchor = item.querySelector('h3')?.closest('a') || item.querySelector('h2 a');
        const url = sceneUrl(anchor?.getAttribute('href')); if (!url) continue;
        const snippet = item.querySelector('.VwiC3b, .b_caption p')?.textContent || '';
        sources.push({ url, title: anchor.textContent, snippet, rank, query: request?.query,
          provider: request?.provider || 'Google', appeared: true, reading: snippet ? 'snippet' : 'unknown' });
      }
    } else if (request) sources.push({ url: request.url, title: doc.title, provider: request.provider,
      accessed: true, reading: 'partial', characters: body.length });
    return { ...observation, module: 'search', provider: request?.provider || 'Google', sources,
      resultSummary: searchService ? sources.length ? `返回 ${sources.length} 条来源` : /enablejs|enable javascript|启用.*JavaScript/i.test(body)
        ? '返回 JavaScript 提示页 · 未取得搜索条目' : '返回搜索页面 · 未提取到条目' : '已返回部分页面内容' };
  } finally { dom.window.close(); }
}
