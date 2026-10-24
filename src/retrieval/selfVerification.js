import { PROVIDER_DEFAULTS } from '../shared/modelCatalog.js';
import { createOpenAICompatibleReply } from '../openai.js';
import { buildVerificationEvidence, isSupportedVerification } from './verificationEvidence.js';
import { AGENT_LOOP_CONTRACT, contractRegExp, fillTemplate } from '../runtime/agentLoopContract.js';

// Marker syntax, signaling rules, verifier prompt and the unverified note are
// shared with the iPhone finalize step (shared/protocol/agent-loop.json).
const UNCERTAINTY = AGENT_LOOP_CONTRACT.uncertainty;
const UNCERTAINTY_PATTERN = contractRegExp(UNCERTAINTY.marker);
const FUZZY_UNCERTAINTY_PATTERNS = UNCERTAINTY.fuzzy.map(entry => contractRegExp(entry));
const CJK_PATTERN = contractRegExp(AGENT_LOOP_CONTRACT.cjkPattern);

const VERIFIER_SYSTEM_PROMPT = UNCERTAINTY.verifierSystemPrompt;

export function buildUncertaintySignalingRules() {
  return UNCERTAINTY.rules.join('\n');
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
        uncertainClaim: fuzzyMatch[0].trim().slice(0, UNCERTAINTY.fuzzyClaimMaxChars),
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
  toolEvidence = [],
  config,
  model,
  signal,
  _createReply = createOpenAICompatibleReply,
}) {
  const evidence = buildVerificationEvidence(contextBlocks, toolEvidence);
  if (!evidence.some(entry => entry.ok && entry.text.trim())) {
    return {
      verdict: 'UNVERIFIED',
      correction: '',
      reason: 'no-context-available',
    };
  }

  try {
    const reply = await _createReply({
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: model || config.model || PROVIDER_DEFAULTS.auxiliary.verifier,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: fillTemplate(UNCERTAINTY.questionTemplate, { question: userMessage }) },
        { role: 'assistant', content: assistantReply },
        {
          role: 'user',
          content: [
            fillTemplate(UNCERTAINTY.claimTemplate, { claim: uncertainClaim }),
            '',
            UNCERTAINTY.contextHeading,
            JSON.stringify(evidence),
            '',
            UNCERTAINTY.closingQuestion,
          ].join('\n'),
        },
      ],
      signal,
      providerProfile: 'fast',
      nativeWebSearchEnabled: false,
    });

    const text = String(reply || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let payload;
    try { payload = JSON.parse(text); } catch { payload = {}; }
    const verdict = payload?.verdict;
    const supported = isSupportedVerification(payload || {}, evidence);
    const originalClaim = typeof payload?.originalClaim === 'string' ? payload.originalClaim.trim() : '';
    const correction = typeof payload?.correction === 'string' ? payload.correction.trim() : '';

    if (verdict === 'CORRECTED' && supported && originalClaim && correction && assistantReply.includes(originalClaim)) {
      return {
        verdict: 'CORRECTED',
        correction,
        originalClaim,
        evidenceId: payload.evidenceId,
        reason: 'context-contradicts',
      };
    }

    if (verdict === 'VERIFIED' && supported) {
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
    if (signal?.aborted) throw signal.reason || error;
    return {
      verdict: 'UNVERIFIED',
      correction: '',
      reason: `verification-failed: ${error.message || 'unknown'}`,
    };
  }
}

export function applyVerificationToReply(cleanReply, verification, { channelKind = 'desktop' } = {}) {
  const { verdict, correction, originalClaim } = verification || {};
  if (verdict === 'CORRECTED' && correction && originalClaim && cleanReply.includes(originalClaim)) {
    return cleanReply.split(originalClaim).join(correction);
  }
  if (verdict === 'UNVERIFIED' || verdict === 'CORRECTED') {
    const note = CJK_PATTERN.test(cleanReply) ? UNCERTAINTY.unverifiedNote.zh : UNCERTAINTY.unverifiedNote.en;
    return `${cleanReply}\n\n${note}`;
  }
  return cleanReply;
}
