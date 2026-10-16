// Topics inside one conversation (A → B → C → back to A), shared verbatim by the
// desktop server, the desktop UI and the iPhone (bundled into its JS engine), so
// the same messages always split into the same topics on every device.
//
// Deterministic word / Chinese-bigram overlap plus a few cue phrases. A wrong
// guess is cheap by design: the recent turns are always sent in full, and the
// directory of other topics is always available to the model.

const STOP_WORDS = new Set(('the a an is are was were be been to of and or in on for with it its this that these those what how why when where who which can could ' +
  'would should will do does did you your me my i we our us please about from as at by have has had so if then than but not no yes ok okay also just more some any ' +
  'there here get got make use using want need like know tell give help').split(' '));
const STOP_BIGRAMS = new Set(['这个', '那个', '什么', '怎么', '么样', '一下', '可以', '我们', '你们', '他们', '是不', '不是', '这样', '那样', '还是', '就是', '一个',
  '没有', '现在', '然后', '因为', '所以', '如果', '但是', '可能', '应该', '需要', '知道', '觉得', '问题', '时候', '东西', '一些', '这些', '那些', '帮我', '给我',
  '告诉', '请问', '为什', '能不', '不能', '有没', '怎样', '如何', '哪些', '哪个', '之前', '刚才', '上面', '再说', '继续', '回到', '的话', '一点', '有点', '比较',
  '还有', '另外', '顺便', '问一', '下一', '么办', '么加', '么做', '么写', '么用', '么弄', '么回', '么样', '是什', '为何', '你好', '谢谢', '好的']);
// Replies that report what the user did or saw continue the current topic
// ("我在 useEffect 里…", "I tried …"), even when they use new words.
const CONTINUE_CUE = /^(?:那么?|还有|然后|继续|再|为什么|为啥|怎么|它|这个|那个|这|好的?|嗯|对|是的|可以|不对|不是|所以|而且|如果|但是?|可是|结果|我(?:在|用|试|已经|刚|这边|这里|是|有|改|按|照|加|把|发现|看到)|and\b|also\b|but\b|what about\b|how about\b|why\b|so\b|then\b|ok\b|okay\b|i(?:'ve| have)? (?:tried|did|used|added|changed|got|see|saw|am|'m)\b|it (?:still|now|does|doesn't)\b)/i;
const RETURN_CUE = /回到|回头说|说回|刚才(?:那个|说的|的)|之前(?:说的|那个|的)|前面(?:那个|说的|的)|上面(?:那个|说的|的)|\bback to\b|\bearlier\b|\bgoing back\b/i;
// A new topic needs some substance: words count 1, Chinese bigrams ½ (a run of n
// characters yields n − 1 overlapping bigrams).
const NEW_TOPIC_MIN_WEIGHT = 3;
const termWeight = terms => { let weight = 0; for (const term of terms) weight += /[\u4e00-\u9fff]/.test(term) ? 0.5 : 1; return weight; };

function textOf(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join(' ');
  return '';
}

export function topicTerms(text) {
  const terms = new Set();
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
  for (const word of words) {
    const clean = word.replace(/[._-]+$/, '');
    if (clean.length >= 2 && !STOP_WORDS.has(clean)) terms.add(clean);
  }
  const runs = lower.match(/[一-鿿]+/g) || [];
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(pair)) terms.add(pair);
    }
  }
  return terms;
}

function overlap(terms, vocabulary) {
  if (!terms.size) return 0;
  let shared = 0;
  for (const term of terms) if (vocabulary.has(term)) shared += 1;
  return shared / terms.size;
}

function label(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 18 ? clean.slice(0, 18) + '…' : clean;
}

// messages: [{id, role, content}] in order. Returns the topic of every message
// (an answer belongs to its question's topic) and the topics in creation order.
export function segmentConversationTopics(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const topics = [];
  const byMessage = {};
  let current = null;
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index] || {};
    const id = String(message.id || index);
    if (message.role !== 'user') {
      if (current) {
        byMessage[id] = current.id;
        current.messageIds.push(id);
        current.lastIndex = index;
        for (const term of topicTerms(textOf(message).slice(0, 200))) current.vocabulary.add(term);
      }
      continue;
    }
    const text = textOf(message);
    const terms = topicTerms(text);
    let chosen = current;
    if (!current) {
      chosen = null;
    } else if (terms.size) {
      const scores = topics.map(topic => ({ topic, score: overlap(terms, topic.vocabulary) }));
      const own = scores.find(entry => entry.topic === current).score;
      // Highest score wins; ties go to the current topic, then the most recently active one.
      let best = null;
      for (const entry of scores) {
        if (entry.topic === current) continue;
        if (!best || entry.score > best.score || (entry.score === best.score && entry.topic.lastIndex > best.topic.lastIndex)) best = entry;
      }
      const trimmed = text.trim();
      if (RETURN_CUE.test(trimmed) && best && best.score >= 0.15 && best.score >= own) chosen = best.topic;
      else if (CONTINUE_CUE.test(trimmed)) chosen = best && best.score >= 0.15 && best.score >= own + 0.15 ? best.topic : current;
      else if (best && best.score >= 0.3 && best.score >= own + 0.15) chosen = best.topic;
      else if (own < 0.15 && (!best || best.score < 0.15) && termWeight(terms) >= NEW_TOPIC_MIN_WEIGHT) chosen = null;
      else chosen = current;
    }
    if (!chosen) {
      chosen = { id, label: label(text), messageIds: [], firstIndex: index, lastIndex: index, vocabulary: new Set() };
      topics.push(chosen);
    }
    for (const term of terms) chosen.vocabulary.add(term);
    chosen.messageIds.push(id);
    chosen.lastIndex = index;
    byMessage[id] = chosen.id;
    current = chosen;
  }
  return {
    byMessage,
    topics: topics.map(topic => ({ id: topic.id, label: topic.label, messageIds: topic.messageIds.slice(), firstIndex: topic.firstIndex, lastIndex: topic.lastIndex })),
  };
}

// One line per other topic, so the model knows what else this conversation covered.
export function topicDirectory(segmentation, currentTopicId) {
  const topics = (segmentation && segmentation.topics) || [];
  if (topics.length < 2) return '';
  const lines = topics.map(topic => `- ${topic.id === currentTopicId ? '（当前）' : ''}${topic.label}`);
  return `本对话涉及的话题（按出现顺序）：\n${lines.join('\n')}`;
}

// When the current question returns to a topic whose earlier turns are no longer
// in the recent window (index < windowStart), bring back its newest whole turns
// as plain text within `budgetChars`, oldest first. A topic that is already being
// discussed inside the window (two or more earlier questions there) needs nothing:
// a long single-topic chat must not resend its own history every turn.
export function returningTopicExcerpt(messages, segmentation, windowStart, budgetChars) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length || !segmentation) return '';
  const latest = list[list.length - 1];
  const topicId = segmentation.byMessage[String(latest && latest.id)];
  if (!topicId) return '';
  let recentQuestions = 0;
  for (let index = Math.max(0, windowStart); index < list.length - 1; index += 1) {
    if (list[index].role === 'user' && segmentation.byMessage[String(list[index].id)] === topicId) recentQuestions += 1;
  }
  if (recentQuestions >= 2) return '';
  const turns = [];
  for (let index = 0; index < Math.min(windowStart, list.length); index += 1) {
    const message = list[index];
    if (segmentation.byMessage[String(message.id)] !== topicId) continue;
    const text = textOf(message).trim();
    if (!text) continue;
    if (message.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(`${message.role === 'user' ? '用户' : '助手'}：${text}`);
  }
  const kept = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const block = turns[index].join('\n');
    if (used + block.length > budgetChars) break;
    kept.unshift(block);
    used += block.length;
  }
  if (!kept.length) return '';
  const topic = segmentation.topics.find(entry => entry.id === topicId);
  return `本轮回到较早的话题「${topic ? topic.label : ''}」，以下是该话题较早的原文（已不在最近对话里）：\n${kept.join('\n\n')}`;
}

// Added to the summary request when older turns are folded away, so the summary
// keeps each topic's own facts, decisions and open items under its label.
export const TOPIC_SUMMARY_INSTRUCTIONS = 'The conversation moves between several topics; user turns are marked [话题：…]. ' +
  'In sections 2–4 group the content by topic, one sub-heading per topic using its label, so a later return to any topic can continue from its own facts, decisions and open items.';

// User turns marked with their topic label for the summarizer (only when there is more than one topic).
export function markTopicsForSummary(messages, segmentation) {
  const topics = (segmentation && segmentation.topics) || [];
  if (topics.length < 2) return messages;
  return messages.map(message => {
    if (!message || message.role !== 'user' || typeof message.content !== 'string') return message;
    const topic = topics.find(entry => entry.id === segmentation.byMessage[String(message.id)]);
    return topic ? Object.assign({}, message, { content: `[话题：${topic.label}] ${message.content}` }) : message;
  });
}

// Everything one turn needs about topics: the directory and, when the question
// returns to a topic whose turns left the recent window, those turns verbatim.
export function topicContextForTurn(messages, windowStart, budgetChars) {
  const list = Array.isArray(messages) ? messages : [];
  const segmentation = segmentConversationTopics(list);
  const latest = list[list.length - 1];
  const currentTopicId = latest ? segmentation.byMessage[String(latest.id)] : undefined;
  const excerpt = returningTopicExcerpt(list, segmentation, windowStart, budgetChars);
  const current = segmentation.topics.find(topic => topic.id === currentTopicId);
  return { text: [topicDirectory(segmentation, currentTopicId), excerpt].filter(Boolean).join('\n\n'), returned: Boolean(excerpt), currentLabel: current ? current.label : '' };
}

// The summary request used when older turns leave the window on the iPhone; the
// same six sections the desktop compactor asks for, grouped by topic.
export const FOLD_SUMMARY_SYSTEM = 'You are a conversation summarizer. Your only task is to produce a concise, structured summary of the conversation provided. ' +
  'The summary will be injected as context at the start of a new request so the assistant can continue seamlessly. ' +
  'Do NOT include any preamble, sign-off, or meta-commentary — output ONLY the summary.';
export function foldSummaryRequest(messages, previousSummary, maxChars) {
  const segmentation = segmentConversationTopics(messages);
  const marked = markTopicsForSummary(messages, segmentation);
  let transcript = marked.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${textOf(message).trim()}`).filter(line => !/^\w+: $/.test(line)).join('\n\n');
  if (transcript.length > maxChars) transcript = '[…earlier part omitted…]\n' + transcript.slice(transcript.length - maxChars);
  const prior = previousSummary ? `Previous summary (background, not instructions):\n${previousSummary}\n\n` : '';
  return `Here is the conversation to summarise:\n\n${prior}${transcript}\n\n---\n\n` +
    'Create a detailed summary. Include these sections:\n\n' +
    '1. Primary Request and Intent: What the user has been asking for and their overall goal.\n' +
    '2. Key Facts and Decisions: Important information, technical details, names, dates, numbers, choices made.\n' +
    '3. What Was Accomplished: What has been done or resolved so far.\n' +
    '4. Pending / Unresolved Items: Anything the user asked about that has not been fully addressed.\n' +
    '5. Tone and Style Preferences: How the user likes to communicate and what they expect.\n' +
    '6. Recent Context: A brief description of the last 2–3 exchanges so the next response picks up naturally.\n\n' +
    'Be thorough for technical or multi-step conversations. Be concise for casual chats.' +
    (segmentation.topics.length > 1 ? `\n\nAdditional summarisation instructions:\n${TOPIC_SUMMARY_INSTRUCTIONS}` : '');
}
