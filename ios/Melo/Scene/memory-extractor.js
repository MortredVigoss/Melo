/**
 * Rule-based fact extractor — the offline fallback for sessionMemory's LLM
 * call.  Covers the same 5 categories and returns the same shape
 * ({ fact, category }) so the merge path in sessionMemory.js is unchanged.
 *
 * When the local LLM is also available the caller is expected to:
 *   1. Run both the LLM extractor and this one.
 *   2. Merge results.
 *   3. Let mergeMemoryFacts's dedupe drop the overlap.
 *
 * Categories produced:
 *   - user_preference   : "I prefer X", "I like Y", "喜欢 Z"
 *   - decision          : "we decided X", "定了 X", "就这样"
 *   - correction        : "actually X", "其实 X", "不是 X 是 Y"
 *   - technical_detail  : version numbers, package names, shell commands
 *   - project_context   : deadline/person/verb combinations
 *
 * The rules lean conservative — we'd rather miss a fact than add a hallucinated
 * one, since session memory is injected straight into every subsequent prompt.
 */

const MAX_FACTS_PER_CALL = 12;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract rule-based facts from a recent-exchanges message array.
 *
 * @param {Array<{role, content}>} messages
 * @returns {Array<{fact: string, category: string}>}
 */
function extractFactsRuleBased(messages = []) {
  const facts = [];
  const seen = new Set();

  for (const message of [...messages].reverse()) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = flattenContent(message.content);
    if (!text.trim()) continue;

    for (const sentence of splitSentences(text).reverse()) {
      if (facts.length >= MAX_FACTS_PER_CALL) break;
      const extracted = extractFromSentence(sentence, message.role);
      for (const fact of extracted) {
        const key = `${fact.category}:${fact.fact.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ ...fact, sourceMessageId: message.id || null, sourceRole: message.role, sourceSenderId: message.senderId || null, sourceText: sentence.slice(0, 400) });
        if (facts.length >= MAX_FACTS_PER_CALL) break;
      }
    }
  }

  return facts.reverse();
}

// ─── Sentence-level extraction ──────────────────────────────────────────────

function extractFromSentence(sentence, role) {
  const out = [];
  const trimmed = sentence.trim();
  if (!trimmed) return out;

  // Only user turns yield "user preference" / "decision" / "correction".  An
  // assistant turn parroting "I prefer X" is not a user statement.
  if (role === 'user') {
    pushIfFound(out, matchUserPreference(trimmed));
    pushIfFound(out, matchDecision(trimmed));
    pushIfFound(out, matchCorrection(trimmed));
    pushIfFound(out, matchProjectContext(trimmed));
  }

  // Technical details can come from either side — e.g. the assistant states
  // "this project uses Node 20".
  pushIfFound(out, matchTechnicalDetail(trimmed));

  return out;
}

function pushIfFound(target, fact) {
  if (fact) target.push(fact);
}

// ─── Category matchers ──────────────────────────────────────────────────────

function matchUserPreference(text) {
  // English
  let m =
    text.match(/\bi (?:prefer|like|love|hate|avoid)\s+(.{3,60}?)[.!?$]/i) ||
    text.match(/^i (?:prefer|like|love|hate|avoid)\s+(.{3,60})$/i);
  if (m?.[1]) {
    const verb = text.match(/\bi (prefer|like|love|hate|avoid)\b/i)?.[1]?.toLowerCase();
    return {
      fact: `User ${verb || 'prefers'} ${truncate(m[1].trim(), 60)}`,
      category: 'user_preference',
    };
  }
  // Chinese
  m =
    text.match(/我(更喜欢|比较喜欢|不喜欢|喜欢|偏好|讨厌)([^，。！？,.!?]{2,30})/u);
  if (m?.[1]) {
    return {
      fact: `User ${['不喜欢', '讨厌'].includes(m[1]) ? 'dislikes' : 'prefers'} ${truncate(m[2].trim(), 60)}`,
      category: 'user_preference',
    };
  }
  return null;
}

function matchDecision(text) {
  // English
  let m =
    text.match(/\b(?:we|i) (?:decided|chose|went with)\s+(.{3,80}?)[.!?$]/i) ||
    text.match(/\b(?:let'?s|we'?ll)\s+(go with|use|pick)\s+(.{3,60})[.!?$]/i);
  if (m) {
    const picked = (m[2] || m[1] || '').trim();
    if (picked.length >= 3) {
      return {
        fact: `Decision: ${truncate(picked, 80)}`,
        category: 'decision',
      };
    }
  }
  // Chinese
  m =
    text.match(/(?:我们)?(?:决定|敲定|定了|就用|就这样|就选)([^，。！？,.!?]{2,40})/u);
  if (m?.[1]) {
    return {
      fact: `Decision: ${truncate(m[1].trim(), 80)}`,
      category: 'decision',
    };
  }
  return null;
}

function matchCorrection(text) {
  // English — phrases that flag "I was wrong earlier"
  let m =
    text.match(/\b(?:actually|wait,|correction,|sorry,)\s+(.{5,90}?)[.!?$]/i) ||
    text.match(/\bnot\s+(.{1,30})\s*,\s*(?:it'?s|it is)\s+(.{1,40})[.!?$]/i);
  if (m) {
    const body = (m[2] ? `not ${m[1]}, it is ${m[2]}` : m[1]).trim();
    if (body.length >= 5) {
      return {
        fact: `Correction: ${truncate(body, 90)}`,
        category: 'correction',
      };
    }
  }
  // Chinese
  m =
    text.match(/(?:其实|不对|不是这样|不应该)[，,：:\s]*([^，。！？,.!?]{3,50})/u);
  if (m?.[1]) {
    return {
      fact: `Correction: ${truncate(m[1].trim(), 90)}`,
      category: 'correction',
    };
  }
  return null;
}

function matchTechnicalDetail(text) {
  // Version strings: "Node v20.3", "Python 3.11", "typescript@5.4".
  const versionMatch = text.match(
    /\b([A-Za-z][\w.-]{1,24})\s*(?:v(?:er(?:sion)?)?\s*)?[v=@]?\s*(\d+(?:\.\d+){1,3})\b/,
  );
  if (versionMatch) {
    return {
      fact: `Uses ${versionMatch[1]} ${versionMatch[2]}`,
      category: 'technical_detail',
    };
  }
  // Package install commands: "npm i react", "pnpm add @scope/pkg", "pip install pandas".
  const cmdMatch = text.match(
    /\b(npm|pnpm|yarn|bun|pip|cargo|go)\s+(?:i|install|add)\s+([@\w./-]{2,40})/i,
  );
  if (cmdMatch) {
    return {
      fact: `Project uses ${cmdMatch[2]} via ${cmdMatch[1]}`,
      category: 'technical_detail',
    };
  }
  // Shell invocations (crude): "run `some cmd`"
  const shellMatch = text.match(/`([a-z][\w\s./-]{3,40})`/);
  if (shellMatch && /\b(run|exec|build|deploy|test|migrate)\b/i.test(text)) {
    return {
      fact: `Relevant command: ${shellMatch[1]}`,
      category: 'technical_detail',
    };
  }
  return null;
}

function matchProjectContext(text) {
  // "by Friday Alice will …" / "due next Monday"
  const deadlineMatch =
    text.match(/\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i) ||
    text.match(/\b(?:due|deadline)\s+(?:is\s+)?([\w -]{3,30})\b/i) ||
    text.match(/(?:周一|周二|周三|周四|周五|周六|周日|截止|deadline)/u);
  if (deadlineMatch) {
    return {
      fact: `Deadline mentioned: ${truncate(deadlineMatch[0], 60)}`,
      category: 'project_context',
    };
  }
  // Named person + verb: "Alice will review", "John is blocking".
  const personMatch = text.match(
    /\b([A-Z][a-z]{2,15})\s+(?:will|is going to|is|handles|owns)\s+(.{3,40}?)[.!?$]/,
  );
  if (personMatch) {
    return {
      fact: `${personMatch[1]} ${personMatch[2].trim()}`,
      category: 'project_context',
    };
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function splitSentences(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/[\n。！？!?]+/g)
    .map(s => s.trim())
    .filter(s => s.length >= 4);
}

function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p?.type === 'text')
      .map(p => p.text || '')
      .join('\n');
  }
  return '';
}
