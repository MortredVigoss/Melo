import { createOpenAICompatibleReply } from '../openai.js';

const UNCERTAINTY_PATTERN = /\[UNCERTAIN:\s*([^\]\n]{3,200})\]\s*$/i;
const FUZZY_UNCERTAINTY_PATTERNS = [
  /\b(?:(?:i am|i'?m) not (?:entirely|completely) sure|(?:i am|i'?m) not certain|not 100% sure|cannot confirm|unable to verify)\b/i,
  /\b(?:might be|may be|possibly|probably|i think|i believe)\b.{0,80}\b(?:but|however|though)\b/i,
  /(不太确定|不能完全确定|无法确认|不敢确定|我不太清楚|可能不准确|仅供参考)/,
];

const VERIFIER_SYSTEM_PROMPT = `You are a strict fact-checker reviewing an assistant's answer.

The assistant flagged a specific claim as uncertain. Your job:
1. Look at the context provided (memory notes, search results, project info, workspace files)
2. Decide one of:
   - VERIFIED: the uncertain claim is supported by context or is a widely-known fact
   - CORRECTED: you found evidence the claim is wrong; provide the correct version in one sentence
   - UNVERIFIED: you cannot confirm or deny from available information

Output format (strict):
- Line 1: exactly one of VERIFIED, CORRECTED, or UNVERIFIED
- Line 2 (only if CORRECTED): the corrected statement, one sentence, no preamble
- Be concise. No explanation beyond what is required.`;

export function buildUncertaintySignalingRules() {
  return [
    'Uncertainty signaling (for factual queries):',
    '- If you made any factual claim that you are not fully certain about (specific products, versions, dates, numbers, people, recent events), append as the VERY LAST line of your response:',
    '  [UNCERTAIN: <one short phrase describing what specifically you are unsure about>]',
    '- Only use this marker for real factual uncertainty, not for opinions, style choices, or well-established facts.',
    '- Do NOT add this marker inside your main answer text, only as the final line.',
    '- Do NOT use this marker if the entire answer is clearly speculative or creative.',
    '- Maximum one marker per response.',
  ].join('\n');
}

export function parseUncertaintyMarker(reply) {
  const text = String(reply || '');
  const match = text.match(UNCERTAINTY_PATTERN);
  if (match) {
    return {
      hasMarker: true,
      uncertainClaim: match[1].trim(),
      cleanReply: text.replace(UNCERTAINTY_PATTERN, '').trim(),
      source: 'explicit',
    };
  }

  for (const pattern of FUZZY_UNCERTAINTY_PATTERNS) {
    const fuzzyMatch = text.match(pattern);
    if (fuzzyMatch) {
      return {
        hasMarker: true,
        uncertainClaim: fuzzyMatch[0].trim().slice(0, 160),
        cleanReply: text.trim(),
        source: 'fuzzy',
      };
    }
  }

  return {
    hasMarker: false,
    uncertainClaim: '',
    cleanReply: text.trim(),
    source: 'none',
  };
}

export async function verifyUncertainClaim({
  userMessage,
  assistantReply,
  uncertainClaim,
  contextBlocks = [],
  config,
  model,
  signal,
}) {
  const contextText = contextBlocks.filter(Boolean).join('\n\n').slice(0, 6000);
  if (!contextText.trim()) {
    return {
      verdict: 'UNVERIFIED',
      correction: '',
      reason: 'no-context-available',
    };
  }

  try {
    const reply = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: process.env.MELO_VERIFIER_MODEL || model || 'gpt-4o-mini',
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Original question:\n${userMessage}` },
        { role: 'assistant', content: assistantReply },
        {
          role: 'user',
          content: [
            `The assistant flagged this claim as uncertain: "${uncertainClaim}"`,
            '',
            'Available context for verification:',
            contextText,
            '',
            'Is the assistant\'s answer correct on the uncertain point?',
          ].join('\n'),
        },
      ],
      signal,
      providerProfile: 'fast',
    });

    const text = String(reply || '').trim();
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const verdict = (lines[0] || 'UNVERIFIED').toUpperCase().replace(/[^A-Z]/g, '');

    if (verdict === 'CORRECTED') {
      return {
        verdict: 'CORRECTED',
        correction: lines.slice(1).join(' ').trim() || '',
        reason: 'context-contradicts',
      };
    }

    if (verdict === 'VERIFIED') {
      return {
        verdict: 'VERIFIED',
        correction: '',
        reason: 'context-supports',
      };
    }

    return {
      verdict: 'UNVERIFIED',
      correction: '',
      reason: 'insufficient-context',
    };
  } catch (error) {
    return {
      verdict: 'UNVERIFIED',
      correction: '',
      reason: `verification-failed: ${error.message || 'unknown'}`,
    };
  }
}

export function applyVerificationToReply(cleanReply, verification, { channelKind = 'desktop' } = {}) {
  const { verdict, correction } = verification || {};
  if (verdict === 'CORRECTED' && correction) {
    return `${cleanReply}\n\n— Self-check correction: ${correction}`;
  }
  // Skip the UNVERIFIED note on remote channels (Telegram/Discord) — it reads
  // as noise in a messaging context where the user cannot act on it easily.
  if (verdict === 'UNVERIFIED' && channelKind !== 'remote') {
    return `${cleanReply}\n\n(Note: I could not fully verify one part of this answer. Please double-check if this matters.)`;
  }
  return cleanReply;
}
