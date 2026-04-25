// System-prompt assembly — extracted from desktopStore in Phase 7d-2.
//
// Per CLAUDE.md §4 ("抽服务 = byte-for-byte 移植"), every function below is
// a verbatim port of its desktopStore original — no renames, no
// simplifications, no logic edits. The only changes are import paths and
// the addition of `export` keywords. Any cleanup happens in a separate,
// post-port commit with its own tests.
//
// The set of helpers in this module forms the "static + per-turn rules"
// half of system prompt construction:
//
//   summarizeAgentPrompt           — agent profile → prompt summary text
//   buildConversationFormattingRules — global formatting rules (no markdown
//                                       flair, no repeats, etc.)
//   buildOutputHardConstraints     — final output hard-cap rules
//                                       (remote-channel-aware)
//   detectInputLanguage            — BCP-47 dominant-language sniffer
//   buildLanguageConstraint        — turns the sniffer's verdict into a
//                                       MANDATORY language-lock rule
//   buildReActSystemPrompt         — the entry point — combines all of
//                                       the above plus injected blocks
//                                       (memory, tools, viz, citations…)

import { intentRequiresVerification } from '../../retrieval/intentRouter.js';
import { buildUncertaintySignalingRules } from '../../retrieval/selfVerification.js';
import { buildReActOperatingInstructions } from '../../prompts.js';
import { DEFAULT_CONFIG } from '../../config.js';
import {
  moodOptionById,
} from '../agent/agentLibrary.js';
import {
  summarizeAgentTools,
} from '../agent/agentTools.js';
import {
  normalizeAgentChannels,
} from '../agent/agentChannels.js';

export function summarizeAgentPrompt(profile) {
  const mood = moodOptionById(profile.mood);
  const toolSummary = summarizeAgentTools(profile.tools)
    .map(tool => tool.label)
    .join(', ');
  const channelSummary = Object.values(normalizeAgentChannels(profile.channels))
    .filter(channel => channel.enabled)
    .map(channel =>
      channel.id === 'telegram'
        ? `Telegram(bot linked${channel.chatId ? `, default chat ${channel.chatId}` : ''})`
        : `Discord(channel ${channel.channelId || channel.guildId || 'not set'})`,
    )
    .join(', ');
  return [
    profile.rolePrompt,
    `IDENTITY.md:\n${profile.identity || profile.identify}`,
    `SOUL.md:\n${profile.soulMd}`,
    profile.systemPrompt ? `Agent system prompt:\n${profile.systemPrompt}` : '',
    toolSummary ? `Enabled agent tools: ${toolSummary}` : '',
    channelSummary ? `Linked channels: ${channelSummary}` : '',
    `Current mood (${mood.label}): ${mood.prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildConversationFormattingRules() {
  return [
    'Conversation formatting rules:',
    '- In normal chat, reply in natural plain text.',
    '- Do not use decorative markdown emphasis such as *...*, **...**, _..._, or heading markers unless the user explicitly asks for markdown formatting.',
    '- Avoid markdown list syntax, quote syntax, and section headings in casual replies unless structure is genuinely necessary.',
    '- Prefer natural sentences and short paragraphs over markdown-styled formatting.',
    '- Use formatting only when it materially improves clarity for code blocks, tables, explicit lists, or links.',
    '- Avoid decorative symbols and unnecessary markdown flair in casual replies.',
    // No-repeat rule — anchor point. The model has a tendency to present the
    // same information twice (e.g. "先说 X → 再说 Y" in the first half, then
    // "关于 X 再说一次 → Y 的清单" in the second half), producing replies that
    // feel like two near-identical answers glued together. Once a point has
    // been made, the model must move on — no re-listing, no "顺手再给你一个
    // 简版清单", no "一句话总结" that re-enumerates items already covered.
    '- Cover each point exactly once. If you have already answered something, do NOT restate it under a new heading, a "简版清单", or a "一句话总结" that re-lists items already given.',
    '- Never split a single answer into two passes over the same topics (e.g. a first pass of detailed explanation followed by a second pass of "清单/总结" covering the same items). Pick one shape and stop.',
    '- A closing line is fine ("要不要我再帮你查 X"), but it must not re-enumerate anything from earlier in the same reply.',
  ].join('\n');
}

export function buildOutputHardConstraints({ isRemoteChannel = false } = {}) {
  return [
    'Final output hard constraints (highest priority, overrides any stylistic instinct above):',
    '- Do NOT use markdown emphasis characters for styling: no **, no *, no __, no _, no ##, no ###, and no backticks for emphasis.',
    '- Do NOT use markdown headings (#, ##, ###, ####) anywhere in normal replies.',
    '- Do NOT use markdown blockquotes (>) or horizontal rules (---).',
    '- For emphasis, rely on word choice and sentence structure, not punctuation decoration.',
    '- The only place backticks and code fences are allowed is inside actual code blocks for actual code or command examples.',
    '- If you feel the urge to write "**important**" or "### Summary", stop and rewrite that sentence in plain prose instead.',
    isRemoteChannel
      ? '- This reply will be delivered through a plain-text messaging channel. Decorative markdown will appear as broken literal characters.'
      : '',
    // Remote-channel length + no-repeat cap. Telegram/Discord replies regularly
    // ballooned to 1500–2000 Chinese chars where the second half was a lightly
    // reworded restatement of the first half (e.g. "先说时间/装备 … 再说什么时候/简版清单").
    // Hard-cap length and explicitly forbid the second-pass restatement shape
    // so the model is forced to stop after the primary answer.
    isRemoteChannel
      ? '- Keep remote-channel replies tight: aim for under ~600 Chinese characters (or ~400 English words) for normal questions. If the answer genuinely needs more, still write it once — never as a primary explanation followed by a summary/清单/总结 that re-covers the same items.'
      : '',
    isRemoteChannel
      ? '- If you catch yourself writing "再说一次", "再给你一个简版", "顺手给你一个清单", "一句话总结" where those would repeat items already above, delete that section and end the reply instead.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Detect the dominant single language in a text string.
 * Returns a BCP-47 language tag, or null when the text is mixed / too short
 * to make a confident call.
 */
export function detectInputLanguage(text = '') {
  // Strip @mentions so bot names (Latin chars) don't skew detection
  const str = String(text).replace(/@\w+/g, '').replace(/\s+/g, '');
  if (str.length < 4) return null;

  const total = str.length;
  const cjk     = (str.match(/[一-鿿㐀-䶿豈-﫿]/g) || []).length;
  const kana    = (str.match(/[぀-ゟ゠-ヿ]/g) || []).length;
  const korean  = (str.match(/[가-힯ᄀ-ᇿ㄰-㆏]/g) || []).length;
  const arabic  = (str.match(/[؀-ۿ]/g) || []).length;
  const cyril   = (str.match(/[Ѐ-ӿ]/g) || []).length;
  const latin   = (str.match(/[A-Za-z]/g) || []).length;

  const nonLatin = cjk + kana + korean + arabic + cyril;
  const T = 0.25; // threshold: >25% of chars belong to a script → that's the language

  // Japanese: has kana, or large kana share among CJK
  if (kana / total > T || (kana > 4 && (cjk + kana) / total > T)) return 'ja';
  // Korean
  if (korean / total > T) return 'ko';
  // Chinese (CJK without significant kana)
  if (cjk / total > T) return 'zh';
  // Arabic
  if (arabic / total > T) return 'ar';
  // Cyrillic (Russian etc.)
  if (cyril / total > T) return 'ru';
  // Clear Latin / English: at least 70% Latin chars with no other script
  if (latin / total > 0.7 && nonLatin === 0) return 'en';

  return null; // mixed or indeterminate — no constraint
}

export function buildLanguageConstraint(text = '') {
  const lang = detectInputLanguage(text);
  if (!lang) return '';

  const LABELS = {
    zh: 'Chinese (中文)',
    ja: 'Japanese (日本語)',
    ko: 'Korean (한국어)',
    ar: 'Arabic (العربية)',
    ru: 'Russian (Русский)',
    en: 'English',
  };
  const label = LABELS[lang];
  if (!label) return '';

  return (
    `[LANGUAGE RULE — MANDATORY, NO EXCEPTIONS]\n` +
    `The user's message is in ${label}.\n` +
    `You MUST reply ENTIRELY in ${label} from the first word to the last word.\n` +
    `Every sentence, every paragraph, every section must be in ${label}.\n` +
    `Do NOT switch languages mid-reply. Do NOT mix languages. Do NOT start in one language and switch to another.\n` +
    `If you need to reference English terms (e.g. API names, technical jargon), keep the surrounding sentence in ${label}.`
  );
}

export function buildReActSystemPrompt({
  config,
  profile,
  modePrompt = '',
  projectContext = '',
  connectorPrompts = '',
  skillsPrompts = '',
  dynamicContext = '',
  memoryContext = '',
  channelPrompt = '',
  toolRoutingPrompt = '',
  compactContext = '',
  toolsPrompt = '',
  sessionMemoryBlock = '',
  languageConstraint = '',
  vizInstructions = '',
  citationInstructions = '',
  kind = 'chat',
  isRemoteChannel = false,
  intent = 'factual',
}) {
  const uncertaintyRules = intentRequiresVerification(intent)
    ? buildUncertaintySignalingRules()
    : '';

  return [
    config.systemPrompt || DEFAULT_CONFIG.systemPrompt,
    buildConversationFormattingRules(),
    buildReActOperatingInstructions({ kind }),
    summarizeAgentPrompt(profile),
    modePrompt,
    // Compact summary comes early so the model sees it before any injected
    // context blocks. It provides the background for all subsequent turns.
    compactContext,
    // Session memory (extracted facts) — injected after compact to fill in
    // any gaps the compact may have elided.
    sessionMemoryBlock,
    projectContext,
    channelPrompt,
    memoryContext,
    toolRoutingPrompt,
    connectorPrompts,
    skillsPrompts,
    dynamicContext,
    // Tools section injected after context so the model has full background
    // before seeing tool definitions.
    toolsPrompt,
    uncertaintyRules,
    languageConstraint,
    // Demon visualization mode — trailing `<viz-spec>` emission rules. Empty
    // string when the toggle is off or the channel is remote (TG/DC never
    // renders visualizations).
    vizInstructions,
    // Source citation pins (inline `<cite>` tags that the desktop UI turns
    // into pills linking into a side-drawer source viewer). Empty string
    // when Demon is off, the channel is remote, or the project has no
    // workspace files to cite.
    citationInstructions,
    buildOutputHardConstraints({ isRemoteChannel }),
  ]
    .filter(Boolean)
    .join('\n\n');
}
