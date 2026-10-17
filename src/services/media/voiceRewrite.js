// ─── Voice rewrite service ───────────────────────────────────────────────────
// Converts a written assistant reply into something that sounds natural when
// read aloud by TTS for remote channels (Telegram / Discord voice replies).
//
// Two-phase pipeline:
//   Phase 1 — extractVoiceSummary()
//     Pure, rule-based. Strips markdown/code/tables/URLs, splits into
//     sentences, scores each sentence (conclusion markers / data / position
//     boost, process markers penalty), picks top sentences within a length
//     budget, returns them in original order. Cheap, no API call.
//
//   Phase 2 — rewriteForVoice()
//     If the agent has a `voicePersonality` string, runs a small LLM pass
//     to inject that persona's tone into the Phase-1 summary. Uses the
//     fast provider profile. Falls back to the Phase-1 extraction on any
//     error or empty reply.
//
// This module used to inject Korean 语气词 (네/요/맞아요/…) into the rewritten
// text so the 金冬天 MiniMax custom voice would sound "bilingual" when read
// aloud. That hack has been pulled — the Chinese-trained custom voice reads
// mixed-in Korean poorly. Until we pair it with a real Korean TTS, the
// rewriter keeps the output pure Chinese and the TTS layer additionally
// strips any stray Korean (see `stripKoreanForMinimax` in ../../tts.js).
//
// Extracted from desktopStore.js in the Phase 2 refactor (see
// _refactor-backup/REFACTOR_PLAN.md).

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { getMeloHome } from '../../config.js';
import { createOpenAICompatibleReply } from '../../openai.js';

// G-6 #4 (audit 2026-05-11): DESKTOP_DIR + VOICE_DEBUG_LOG_PATH were
// module-load `const` — CLAUDE.md §6 violation.  Old comment claimed
// "MELO_HOME must be set before first import in any test that cares
// about isolation" which is exactly the workaround pattern §6 deprecates.
// Per-call resolution + per-path dir-ready map removes the freeze.
const VOICE_DEBUG_LOG_MAX_BYTES = 256 * 1024;
const _voiceDebugDirReady = new Map(); // desktopDir → true once mkdir succeeded

function voiceDebugLogPath() {
  return join(getMeloHome(), 'desktop', 'voice-debug.log');
}

function nowIso() {
  return new Date().toISOString();
}

export function writeVoiceDebugLine(line) {
  // §6 capture-at-entry: resolve once per call.  Sync writes follow,
  // so no async-boundary risk, but a runtime/test MELO_HOME flip will
  // now correctly route to the new home.
  const logPath = voiceDebugLogPath();
  const desktopDir = dirname(logPath);
  try {
    if (!_voiceDebugDirReady.get(desktopDir)) {
      mkdirSync(desktopDir, { recursive: true });
      _voiceDebugDirReady.set(desktopDir, true);
    }
    try {
      const info = statSync(logPath);
      if (info.size > VOICE_DEBUG_LOG_MAX_BYTES) {
        renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // File doesn't exist yet — first write will create it.
    }
    appendFileSync(logPath, `${nowIso()} ${line}\n`, 'utf8');
  } catch {
    // Never let logging errors bubble into the rewrite path.
  }
}

/**
 * Phase 1: Rule-based extraction.
 *   1. Strip markdown/code/tables/URLs
 *   2. Split into sentences
 *   3. Score each sentence (conclusion markers get high score, process/reasoning gets low)
 *   4. Pick top-scored sentences up to a length budget
 *   5. Return in original order
 */
export function extractVoiceSummary(text) {
  // Step 1: strip non-voice content
  let clean = text
    .replace(/```[\s\S]*?```/g, '')                       // code blocks
    .replace(/`[^`]+`/g, '')                               // inline code
    .replace(/!?\[[^\]]*\]\([^)]+\)/g, '')                 // links/images
    .replace(/https?:\/\/\S+/g, '')                        // bare URLs
    .replace(/^\|.*\|$/gm, '')                             // table rows
    .replace(/^[-=|:]+$/gm, '')                            // table separators
    .replace(/^#{1,6}\s+/gm, '')                           // heading markers
    .replace(/^[\s]*[-*+]\s+/gm, '')                       // list bullets
    .replace(/^\d+\.\s+/gm, '')                            // numbered list
    .replace(/[*_~]{1,3}/g, '')                            // bold/italic/strike
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!clean || clean.length < 20) return text.slice(0, 300);

  // Step 2: split into sentences
  const sentences = clean
    .split(/(?<=[。！？.!?\n])\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 4);

  if (sentences.length <= 3) return clean.slice(0, 500);

  // Step 3: score sentences
  // Conclusion / result markers → high score
  const conclusionRe = /(?:所以|因此|总之|综上|总结|结论|建议|答案|结果|最终|关键是|简单来说|一句话|底线|in short|therefore|so,?\s|in conclusion|the answer|result|recommend|takeaway|tl;?dr|key point|bottom line)/i;
  // Data / numbers → medium-high score (temperatures, prices, dates, percentages)
  const dataRe = /\d+[°℃%￥$€£件个万亿千百]+|\d{4}[-/]\d{1,2}|\d+\.\d+/;
  // Process / reasoning markers → low score
  const processRe = /(?:首先|其次|第[一二三四五六七八九十]|然后|接下来|让我|分析一下|考虑到|原因是|因为|由于|需要注意|值得一提|另外|此外|补充|first|second|third|let me|the reason|because|note that|additionally|furthermore|moreover|step \d)/i;

  const scored = sentences.map((s, i) => {
    let score = 0;
    // Position bias: last 30% of sentences more likely to be conclusions
    if (i >= sentences.length * 0.7) score += 2;
    // First sentence often has the direct answer
    if (i === 0) score += 1;
    if (conclusionRe.test(s)) score += 3;
    if (dataRe.test(s)) score += 2;
    if (processRe.test(s)) score -= 2;
    // Short sentences are often key takeaways
    if (s.length < 40) score += 1;
    // Long sentences are often explanations
    if (s.length > 120) score -= 1;
    return { s, i, score };
  });

  // Step 4: pick top sentences within budget
  const budget = Math.min(500, Math.max(80, Math.floor(clean.length * 0.35)));
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked = [];
  let len = 0;
  for (const item of sorted) {
    if (len + item.s.length > budget && picked.length >= 1) break;
    picked.push(item);
    len += item.s.length;
  }

  // Step 5: return in original order
  picked.sort((a, b) => a.i - b.i);
  return picked.map(p => p.s).join(' ');
}

/**
 * Phase 2: Persona-flavored voice rewrite.
 *
 * @param {string} text — the original assistant reply (may be long markdown)
 * @param {Object} config — model config (authMode / apiKey / baseUrl / model)
 * @param {string} [voicePersonality] — persona prompt; if empty, skips LLM
 * @param {string} [senderName] — for debug log only, not sent to the model
 * @returns {Promise<string>} text suitable for TTS
 */
export async function rewriteForVoice(text, config, voicePersonality = '', senderName = '') {
  if (!text || text.length < 30) return text;

  // Phase 1: rule-based extraction (instant, no API call)
  const extracted = extractVoiceSummary(text);

  // No personality → rule-based result is enough, skip LLM call entirely
  if (!voicePersonality) return extracted;

  // Phase 1.5: pre-clean for voice — strip @mentions, they'll be replaced by
  // personality opener.
  let cleaned = extracted.replace(/@[\w\u4e00-\u9fff]+/g, '').replace(/^\s*[，,\s]+/, '').trim();

  // Phase 2: LLM personality injection on the already-compressed text (fast,
  // short input).
  try {
    // Language rule is personality-driven, not globally Chinese.
    // Some personalities are English-only (e.g. 懂王), some are Korean-flavored
    // (金冬天), most are Chinese.  We let the personality dictate the output
    // language and only forbid *mixing* — i.e. a Chinese persona shouldn't
    // smuggle in English/Korean words, and an English persona shouldn't fall
    // back to Chinese.
    const systemPrompt = [
      voicePersonality,
      '',
      '--- VOICE REWRITE TASK ---',
      'You are rewriting the "user-provided summary" below in the speaking style of the persona defined above.',
      'This is a spoken reply — it should sound like this persona is talking out loud, not reading a written answer.',
      '',
      'Hard rules:',
      '1. Output language is determined by the persona definition above. ' +
        'If the persona speaks only English → reply in English only (no Chinese). ' +
        'If the persona speaks Chinese → reply in natural spoken Chinese and do not slip in English/Korean/Japanese words. ' +
        'If the persona uses a specific style (a dialect, a fixed set of catchphrases, etc.) → follow that style exactly, but never add words from a language the persona does not speak.',
      '2. Do NOT re-summarize or compress the input further — it is already condensed. Your job is only to restyle it into the persona\'s spoken voice.',
      '3. Remove all @mentions. No markdown, no emoji spam, no bullet lists.',
      '4. Output only the rewritten text — no explanations, no prefixes, no suffixes.',
    ].join('\n');
    let voiceText = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      systemPrompt,
      messages: [{ role: 'user', content: cleaned }],
      providerProfile: 'fast',
    });
    if (typeof voiceText === 'string' && voiceText.trim()) {
      // Post-process: strip @mentions only. Language policy lives in the
      // persona text (the 金冬天 persona is Chinese-only since 2026-10-17 —
      // the MiniMax custom voice reads mixed-in Korean badly). We do not strip
      // scripts here because other TTS engines can read them; the MiniMax
      // path additionally applies stripKoreanForMinimax in ../../tts.js as a
      // safety net.
      voiceText = voiceText
        .replace(/@[\w\u4e00-\u9fff]+/g, '')
        .replace(/^\s*[，,\s]+/, '')
        .trim();

      writeVoiceDebugLine(
        `[voice-rewrite] ok senderName="${senderName || ''}" ` +
          `inLen=${text.length} extractedLen=${extracted.length} ` +
          `cleanedLen=${cleaned.length} outLen=${voiceText.length} ` +
          `in="${cleaned.slice(0, 120).replace(/\n/g, ' ')}" ` +
          `out="${voiceText.slice(0, 180).replace(/\n/g, ' ')}"`,
      );
      return voiceText;
    }
    writeVoiceDebugLine(
      `[voice-rewrite] empty-reply senderName="${senderName || ''}" ` +
        `inLen=${text.length} cleanedLen=${cleaned.length} — falling back to Phase 1`,
    );
    return cleaned;
  } catch (err) {
    writeVoiceDebugLine(
      `[voice-rewrite] error senderName="${senderName || ''}" ` +
        `inLen=${text.length} message=${(err?.message || String(err)).slice(0, 200)}`,
    );
    return cleaned;
  }
}
