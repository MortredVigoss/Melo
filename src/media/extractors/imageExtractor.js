import { fetchBuffer } from '../common.js';

const OCR_LANGS = 'eng+chi_sim+chi_tra+jpn+kor';
const OCR_MAX_CHARS = 4000;
const MIN_OCR_BYTES = 1024;

export async function extractImageContent(attachment, { modelSupportsVision = false } = {}) {
  if (modelSupportsVision) {
    return null;
  }

  try {
    let buffer = null;

    if (String(attachment?.url || '').startsWith('data:')) {
      const base64 = String(attachment?.url || '').split(',')[1] || '';
      buffer = base64 ? Buffer.from(base64, 'base64') : null;
    } else if (attachment?.url) {
      const fetched = await fetchBuffer(attachment.url, { timeoutMs: 20000 });
      buffer = fetched?.buffer || null;
    }

    if (!buffer || buffer.length < MIN_OCR_BYTES) {
      return null;
    }

    const { default: Tesseract } = await import('tesseract.js');
    const { data } = await Tesseract.recognize(buffer, OCR_LANGS, {
      logger: () => {},
    });
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
