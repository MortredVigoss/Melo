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

  // createWorker returns a worker we can `.terminate()` to kill an
  // in-flight recognition. The 4th arg's logger no-ops the loud progress
  // events Tesseract emits.
  const worker = await Tesseract.createWorker(OCR_LANGS, 1, { logger: () => {} });
  let terminated = false;
  const terminateOnce = async () => {
    if (terminated) return;
    terminated = true;
    try { await worker.terminate(); } catch {}
  };

  if (signal?.aborted) {
    await terminateOnce();
    return null;
  }
  let onAbort = null;
  if (signal) {
    onAbort = () => { terminateOnce(); };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const { data } = await worker.recognize(buffer);
    return data;
  } catch {
    return null;
  } finally {
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
    if (!terminated) {
      // Natural completion — clean up worker.
      await terminateOnce();
    }
  }
}
