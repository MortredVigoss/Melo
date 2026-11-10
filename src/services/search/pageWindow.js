// The token-equivalent window rule lives in the shared core since 2026-11-10 so the
// phone hosts cut pages by the same rule (byte-for-byte port of windowChars).
export { PAGE_WINDOW_TOKENS, windowChars } from '../../../shared/agent/pageWindow.js';

export function pageWindow(content,offset,limit) {
  const start=Number.isSafeInteger(offset)&&offset>=0?offset:0;
  const end=Math.min(content.length,start+limit);
  const hasMore=end<content.length;
  const nextOffset=hasMore && end<=1000000 ? end : null;
  const truncated=start>0||hasMore;
  return {body:content.slice(start,end),nextOffset,truncated,suffix:nextOffset!==null?`\n\n[Content truncated at ${end} characters; continue with offset=${end}.]`:hasMore?'\n[Partial content: reader limit reached.]':''};
}
