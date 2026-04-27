import { fetchBuffer } from '../common.js';

const OCR_LANGS = 'eng+chi_sim+chi_tra+jpn+kor';
const OCR_MAX_CHARS = 4000;
const MIN_OCR_BYTES = 1024;

export async function extractImageContent(attachment, { modelSupportsVision = false, signal } = {}) {
  if (modelSupportsVision) {
    return null;
  }
  if (signal?.aborted) return null;

  try {
    let buffer = null;

    if (String(attachment?.url || '').startsWith('data:')) {
      const base64 = String(attachment?.url || '').split(',')[1] || '';
      buffer = base64 ? Buffer.from(base64, 'base64') : null;
    } else if (attachment?.url) {
      const fetched = await fetchBuffer(attachment.url, { timeoutMs: 20000, signal });
      buffer = fetched?.buffer || null;
    }

    if (!buffer || buffer.length < MIN_OCR_BYTES) {
      return null;
    }
    if (signal?.aborted) return null;

    // Run OCR via a Tesseract worker so an external abort can `terminate()`
    // mid-recognition. The simpler `Tesseract.recognize()` API doesn't
    // accept a signal, so a hung OCR pass would otherwise pin a CPU core
    // for ~5-30s after the orchestrator already returned (Codex B finding).
    const data = await runOcrWithAbort(buffer, signal);
    const text = String(data?.text || '').trim();
    if (!text) {
      return null;
    }

    return {
      kind: 'caption',
      text: text.slice(0, OCR_MAX_CHARS),
      metadata: {
        source: 'tesseract-ocr',
        confidence: data?.confidence || 0,
        url: attachment?.url || '',
        fileName: attachment?.fileName || '',
      },
    };
  } catch {
    return null;
  }
}

async function runOcrWithAbort(buffer, signal) {
  const { default: Tesseract } = await import('tesseract.js');
  if (signal?.aborted) return null;

  // Tesseract.createWorker returns a Promise that we can't cancel mid-flight
  // (no abort hook in the library). On a cold cache, language-data download
  // takes 5-30s — that time is unavoidable. What we CAN do is register an
  // abort listener BEFORE invoking createWorker so an abort firing during
  // worker initialization gets recorded and the freshly-created worker is
  // terminated the instant it resolves, instead of running a full
  // recognition pass first. This bounds the post-abort resource leak to
  // "createWorker remaining time", not "createWorker + full recognize".
  let workerRef = null;
  let abortFired = false;
  let onAbort = null;
  if (signal) {
    onAbort = () => {
      abortFired = true;
      // If the worker exists, terminate immediately. If it doesn't yet
      // (still inside createWorker's promise), the post-create check
      // below will catch the flag and terminate.
      if (workerRef) {
        try { workerRef.terminate(); } catch {}
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const worker = await Tesseract.createWorker(OCR_LANGS, 1, { logger: () => {} });
    workerRef = worker;

    // Abort fired during createWorker — terminate now, return null.
    if (abortFired || signal?.aborted) {
      try { worker.terminate(); } catch {}
      return null;
    }

    const { data } = await worker.recognize(buffer);
    if (abortFired) {
      // recognize completed but abort fired during; terminate already
      // triggered via onAbort, but ensure cleanup.
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
    // Final cleanup — terminate if still alive (natural completion path
    // or abort-after-recognize path).
    if (workerRef) {
      try { await workerRef.terminate(); } catch {}
    }
  }
}
