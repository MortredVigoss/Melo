import { combineSignals } from '../common.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function extractDocumentContent(attachment, { signal } = {}) {
  if (signal?.aborted) return null;

  const isPdf =
    String(attachment?.mimeType || '').includes('pdf') ||
    /\.pdf(?:\?|$)/i.test(String(attachment?.url || ''));
  if (!isPdf) {
    return null;
  }

  try {
    // Combine the orchestrator's external signal with the internal 30s
    // download timeout so an outer abort cancels the fetch mid-flight.
    const response = await fetch(attachment.url, {
      signal: combineSignals(signal, 30000),
    });
    if (!response.ok) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PDF_BYTES) {
      return null;
    }
    if (signal?.aborted) return null;

    // pdf-parse is synchronous-ish CPU work; we can't cancel it mid-parse
    // but the pre-parse signal check above bails before paying the cost.
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(buffer);
    const text = String(data?.text || '').trim();
    if (!text) {
      return null;
    }

    return {
      kind: 'article',
      text: text.slice(0, 12000),
      metadata: {
        source: 'pdf-parse',
        pages: data.numpages || 0,
        title: data.info?.Title || '',
        author: data.info?.Author || '',
        fileName: attachment.fileName || '',
        url: attachment.url,
      },
    };
  } catch {
    return null;
  }
}
