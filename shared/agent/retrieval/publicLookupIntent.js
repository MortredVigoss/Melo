import { getRequestNetworkPolicy } from './requestPolicy.js';
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

// Routing hints describe an explicit public-information need, never a tool
// permission or proof that a source was read. Unknown wording keeps the
// authorized catalog; the model may discover a lookup need after other tools.
const PUBLIC_LOOKUP = /(?:搜索|搜一下|查找|查询|找一下|深度调研|多来源|交叉核对|天气|气温|几度|下雨|票价|航班|机票|股价|汇率|营业时间|开放时间|多少钱|报价)|(?:最新|当前|今天|明天).{0,12}(?:新闻|消息|价格|行情|温度)|(?:^|[\s，,。.!！？?；;：:]|请|帮我|帮忙|麻烦|顺便|再|去)(?:查一?下|查|搜)|\b(?:search|look up|find|google|weather|forecast|flight|flights|stock price|exchange rate|opening hours|deep research|compare sources|multiple sources|current|latest)\b|天気|날씨|오늘.*뉴스|(?:clima|pronóstico|noticias actuales)/iu;
const LOOKUP_SLOT = /^(?:(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]?|(?:下|这|本)周[一二三四五六日天]|(?:就|只有|一共)?\s*(?:\d+|[一二三四五六七八九十两])\s*(?:个)?(?:人|位|成人)|(?:没(?:有)?|不带|无|不用|不要)(?:托运|随身)?(?:行李|托运)|(?:\d{4}年|今年|明年|后年)(?:[，,\s]*(?:肯定|当然)?默认(?:是|按)?今年)?|(?:早上|上午|下午|晚上|早去晚回)|(?:经济舱|商务舱)|(?:\d+\s*(?:adults?|people)|no\s+(?:checked\s+)?(?:bags?|luggage)))[\s。.!！]*$/iu;
const LOOKUP_ACK = /^(?:ok|okay|yes|sure|continue|go ahead|好|好的|继续)[\s!.?。！？]*$/iu;

export function publicLookupRequest(text = '', messages = [], triggers = []) {
  const direct = value => {
    const policy = getRequestNetworkPolicy(value);
    if (policy.searchForbidden || policy.localSearch) return false;
    const intent = publicLookupIntent(policy.instruction);
    if (intent === 'app' || intent === 'text') return false;
    if (intent === 'recommendation' || PUBLIC_LOOKUP.test(policy.instruction)) return true;
    // Saved custom patterns remain advisory; weights no longer force a route
    // or change completion status. Invalid configuration cannot stop a turn.
    return (Array.isArray(triggers) ? triggers : []).some(entry => {
      try { return typeof entry?.pattern === 'string' && new RegExp(entry.pattern, entry.flags || 'iu').test(policy.instruction); }
      catch { return false; }
    });
  };
  const policy = getRequestNetworkPolicy(text);
  if (policy.searchForbidden || policy.localSearch) return false;
  if (direct(text)) return true;
  const follows = value => LOOKUP_SLOT.test(value.trim()) || LOOKUP_ACK.test(value.trim()) || publicLookupFollowUp(value);
  if (!follows(policy.instruction)) return false;
  const previous = messages.filter(row => row?.role === 'user' && typeof row.content === 'string').map(row => row.content);
  if (previous.at(-1) === text) previous.pop();
  for (const prior of previous.slice(-8).reverse()) {
    const restriction = getRequestNetworkPolicy(prior);
    if (restriction.searchForbidden || restriction.localSearch) break;
    if (direct(prior)) return true;
    if (!follows(restriction.instruction)) break;
  }
  return false;
}
