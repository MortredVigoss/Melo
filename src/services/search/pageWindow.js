export function pageWindow(content,offset,limit) {
  const start=Number.isSafeInteger(offset)&&offset>=0?offset:0;
  const end=Math.min(content.length,start+limit);
  const hasMore=end<content.length;
  const nextOffset=hasMore && end<=1000000 ? end : null;
  const truncated=start>0||hasMore;
  return {body:content.slice(start,end),nextOffset,truncated,suffix:nextOffset!==null?`\n\n[Content truncated at ${end} characters; continue with offset=${end}.]`:hasMore?'\n[Partial content: reader limit reached.]':''};
}
