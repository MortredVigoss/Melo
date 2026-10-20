// Public recommendations need fresh evidence; mentioning a venue alone does
// not authorize a lookup. Input is the quote-masked current user instruction.
// App/phone tasks stay with their explicitly requested host, never a search
// fallback that takes over a device. Mirrors the mobile planner's boundaries.
const APP_SEARCH = /(?:在|用|使用|打开)\s*(?:小红书|微信|抖音|美团|大众点评|Google Maps|谷歌地图|(?:这个|该)\s*App)[^。！？\n]{0,50}(?:搜|找|查|推荐)|\b(?:search|find|look up).{0,50}\b(?:in|on|using)\s+(?:the\s+)?(?:app|wechat|xiaohongshu|tiktok|google maps)\b/iu;
const EXPLANATION = /(?:为什么|为何).{0,40}(?:没有|没|未|不|调用)|(?:如何|怎么).{0,12}(?:实现|设计)|(?:解释|分析).{0,24}(?:流程|功能|实现)|\b(?:why (?:did|didn't|did not)|how (?:does|would).{0,40}(?:work|implement)|what does .{0,24} mean)\b/iu;
const WRITING = /(?:翻译|润色|改写|编写|写一|虚构|小说|算法)|\b(?:translate|rewrite|proofread|fictional|algorithm|implement|write)\b/iu;
const PUBLIC_SUBJECT = /餐厅|餐馆|饭店|吃饭|好吃|咖啡|早午餐|酒店|住宿|景点|好玩|旅游|游玩|笔记本|手机|相机|耳机|餐饮|\b(?:brunch|restaurants?|caf[eé]s?|hotels?|accommodation|places? to (?:eat|visit|stay)|laptops?|headphones?|cameras?)\b/iu;
const RECOMMEND = /推荐|有什么|有啥|哪些|哪家|哪间|哪个好|哪款|哪里|附近|值得|适合|去哪|\b(?:recommend|recommendations?|best|good|where|which|nearby|suggest|suggestions?|any)\b/iu;
const NEW_ACTION = /(?:^|[。！？;；\n])\s*(?:现在|这次|请|帮我|please|now).{0,60}(?:搜索|查找|推荐|\bsearch\b|\brecommend\b)/iu;

export function publicLookupIntent(instruction = '') {
  if (APP_SEARCH.test(instruction)) return 'app';
  if (!NEW_ACTION.test(instruction) && (EXPLANATION.test(instruction) || WRITING.test(instruction))) return 'text';
  return PUBLIC_SUBJECT.test(instruction) && RECOMMEND.test(instruction) ? 'recommendation' : null;
}

export function publicLookupFollowUp(instruction = '') {
  return instruction.length <= 120 && /^(?:那|这家|那家|它|他们|第[一二三四五六七八九十\d]+家|what about|how about|and (?:the|near)|does (?:it|that)|that one|the (?:first|second|third) one)/iu.test(instruction.trim());
}
