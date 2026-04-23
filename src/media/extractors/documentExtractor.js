const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function extractDocumentContent(attachment) {
  const isPdf =
    String(attachment?.mimeType || '').includes('pdf') ||
    /\.pdf(?:\?|$)/i.test(String(attachment?.url || ''));
  if (!isPdf) {
    return null;
  }

  try {
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PDF_BYTES) {
      return null;
    }

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
