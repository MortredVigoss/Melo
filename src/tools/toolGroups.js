// Stable tool sets per chat (2026-10-17 design audit T1 / option A2).
//
// Before: the tool array sent to the model changed from turn to turn — the
// search router added or removed web_search / fetch_url / browser_* per
// message, and Codex native tools were inserted at the head of the array.
// Tool definitions sit inside the provider's cached prefix, so a routing
// difference between two adjacent turns dropped ~8–13k tokens of
// definitions plus the whole history out of the cache.
//
// Now: tools are split into a CORE set (always present for an agent whose
// capabilities allow them) and a few EXTENSION groups that are large or
// rarely needed. An extension group is activated by a per-turn hint (an
// attachment type, a keyword, the search route) and, once activated, stays
// active for the rest of the chat (`chat.toolGroupsActivated`, persisted) so
// the array only ever grows within a conversation. Search routing itself is
// expressed only in the prompt text, never by adding/removing definitions.
// Pure module.

export const TOOL_GROUP_IDS = Object.freeze(['browser', 'documents', 'media']);

export function toolGroupOf(toolId) {
  const id = String(toolId || '');
  if (/^browser_/.test(id)) return 'browser';
  if (id === 'pdf' || id === 'xlsx') return 'documents';
  if (id === 'image' || id === 'media_info' || id === 'media_api') return 'media';
  return 'core';
}

const DOCUMENT_HINT = /\b(pdf|xlsx?|csv|excel|spreadsheet|workbook|docx?|report)\b|表格|电子表格|工作簿|文档|文件|报告|pdf文件|做成\s*pdf|导出/i;
const MEDIA_HINT = /\b(image|picture|photo|video|audio|mp3|mp4|wav|png|jpe?g|gif|ocr|screenshot|draw|paint|render|preview)\b|图片|图像|照片|画(一|张|个|幅)|生成.{0,4}图|做.{0,4}图|视频|音频|配图|截图|预览|看一下|放大|缩略|识别|海报|插画|头像|壁纸|logo/i;
const BROWSER_HINT = /\b(browser|click|login|log in|sign in|scroll|screenshot of the page|fill (in|out) the form)\b|浏览器|点击|登录|打开网页|网页上|页面上|填表|滚动页面/i;

function attachmentKinds(attachments = []) {
  const kinds = new Set();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const kind = String(attachment?.kind || '').toLowerCase();
    const name = String(attachment?.fileName || attachment?.title || attachment?.url || '').toLowerCase();
    if (['image', 'audio', 'video'].includes(kind) || /\.(png|jpe?g|gif|webp|heic|mp3|m4a|wav|mp4|mov)(\?|$)/.test(name)) kinds.add('media');
    if (kind === 'document' || /\.(pdf|xlsx?|csv)(\?|$)/.test(name)) kinds.add('documents');
  }
  return kinds;
}

/**
 * Groups this turn asks for. Browser needs the CDP flag like before; the
 * search route still decides whether the browser is the right reader.
 */
export function wantedToolGroups({ text = '', attachments = [], history = [], searchPlan = null, hasImageIntent = false, env = {} } = {}) {
  const wanted = new Set(attachmentKinds(attachments));
  const message = String(text || '');
  if (DOCUMENT_HINT.test(message)) wanted.add('documents');
  if (hasImageIntent || MEDIA_HINT.test(message)) wanted.add('media');
  // Browser tools keep the pre-A2 semantics: whenever the user has opted in
  // with MELO_CDP_ENABLED=1 they are available from the first turn (the old
  // router exposed them unconditionally under that flag), unless the user
  // turned networking off for this turn. Gating them on a keyword hint made
  // "截图这个网页" style requests miss the tools (2026-10-18 report).
  const browserAllowed = env.MELO_CDP_ENABLED === '1' && !['user-disabled-network'].includes(searchPlan?.reason);
  if (browserAllowed) wanted.add('browser');
  // A chat that already carries images or documents keeps those groups even
  // when the current message does not name them ("放大看一下", "再导出一次").
  for (const kind of attachmentKinds(history.flatMap(message => message?.attachments || []))) wanted.add(kind);
  return wanted;
}

/** Union of already-activated groups and this turn's wants; only grows. */
export function nextActivatedGroups(activated = [], wanted = new Set()) {
  const next = new Set((Array.isArray(activated) ? activated : []).filter(id => TOOL_GROUP_IDS.includes(id)));
  for (const id of wanted) if (TOOL_GROUP_IDS.includes(id)) next.add(id);
  return [...next].sort();
}

/** Core tools plus activated extension groups, original order preserved. */
export function selectStableTools(tools = [], activatedGroups = []) {
  const active = new Set(activatedGroups);
  return (Array.isArray(tools) ? tools : []).filter(tool => {
    const group = toolGroupOf(tool?.id);
    return group === 'core' || active.has(group);
  });
}
