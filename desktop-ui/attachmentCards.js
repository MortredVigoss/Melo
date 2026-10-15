import { t, ui } from './i18n.js';
export function renderAttachmentCards(message, { escapeHtml, truncate, icon, attachmentLabel, isPdfAttachment, describeAudioExtractionStatus, describeVideoExtractionStatus, extractTextUrls = () => [] }) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) {
    return '';
  }

  const extractedMedia = Array.isArray(message?.extractedMedia) ? message.extractedMedia : [];
  const compactPreviewText = value =>
    String(value || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line =>
        line &&
        !/^source:\s*/i.test(line) &&
        !/^\[note:/i.test(line) &&
        !/^preview image:\s*/i.test(line),
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  const previewForAttachment = attachment => {
    const url = String(attachment?.url || '').trim();
    return extractedMedia.find(entry => {
      if (!entry || typeof entry !== 'object') return false;
      if (attachment?.id && entry.attachmentId === attachment.id) return true;
      const meta = entry.metadata || {};
      return [meta.url, meta.originalUrl].some(candidate => String(candidate || '').trim() === url);
    }) || null;
  };

  const renderLinkAttachmentCard = attachment => {
    // Repair old auto-promoted Markdown URLs at render time without rewriting
    // saved messages or altering arbitrary URLs that contain parentheses.
    const rawUrl = String(attachment.url || '');
    const content = String(message.content || '');
    const originalUrl = extractTextUrls(content).find(url => rawUrl.startsWith(`${url})`) && content.includes(`](${url})`));
    if (originalUrl) {
      attachment = { ...attachment, url: originalUrl, title: attachment.title === rawUrl.replace(/^https?:\/\//i, '').slice(0, 120) ? originalUrl.replace(/^https?:\/\//i, '') : attachment.title };
    }
    const preview = previewForAttachment(attachment);
    const meta = preview?.metadata || {};
    const title = meta.title || attachmentLabel(attachment);
    const body = preview?.text
      ? compactPreviewText(preview.text)
      : '';
    const previewText = body || 'Readable preview extracted. Click to open the original page.';
    const imageUrl = /^https?:\/\//i.test(String(meta.previewImage || ''))
      ? String(meta.previewImage)
      : '';
    const source = String(meta.source || '').toLowerCase();
    const previewStatus = (() => {
      if (!preview) return 'Link only';
      if (meta.directMediaExtractionSucceeded) return 'Deep media parsed';
      if (meta.directMediaExtractionAttempted) return 'Preview read · media parse unavailable';
      if (source === 'pdf-parse') return 'PDF text extracted';
      if (source === 'readability') return 'Article text extracted';
      if (source.includes('yt-dlp')) return 'Video metadata extracted';
      if (source.includes('browser:')) return 'Browser preview extracted';
      if (source.includes('douyin-ssr')) return 'Share preview + page text';
      if (source.includes('share-preview')) return 'Share preview extracted';
      if (source.includes('opengraph')) return 'OpenGraph preview extracted';
      return 'Preview extracted';
    })();
    const metaLine = [meta.author, meta.siteName, previewStatus].filter(Boolean).join(' · ');
    const cardIcon = isPdfAttachment(attachment) ? icon.file : icon.link;
    const canOpenOriginal = /^https?:\/\//i.test(String(attachment.url || ''));
    const cardOpenAttrs = canOpenOriginal
      ? ` data-external-url="${escapeHtml(attachment.url)}" role="link" tabindex="0"`
      : '';
    const cardAction = canOpenOriginal
      ? 'Click to open in browser'
      : 'Attached locally';
    const unavailableText = canOpenOriginal
      ? 'Melo has not extracted readable text for this link yet. Click to open it in your browser.'
      : 'Melo has this local attachment, but no readable text was extracted yet.';

    return ui`
      <div class="message-attachment-card link-card" data-copyable-surface${cardOpenAttrs}>
        <div class="link-card-main">
          <span class="chip-icon">${cardIcon}</span>
          <span>
            <strong>${escapeHtml(title)}</strong>
            <span class="link-card-url">${escapeHtml(attachment.url)}</span>
          </span>
        </div>
        ${renderCopyLinkButton(attachment.url, escapeHtml)}
        ${preview ? ui`
          <div class="link-preview">
            ${imageUrl ? ui`<img class="link-preview-image" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />` : ''}
            <div class="link-preview-copy">
              ${metaLine ? ui`<div class="link-preview-meta">${escapeHtml(metaLine)}</div>` : ''}
              <div class="link-preview-text">${escapeHtml(truncate(previewText, 360))}</div>
              <div class="link-preview-action">${escapeHtml(cardAction)}</div>
            </div>
          </div>
        ` : ui`
          <div class="link-preview is-empty">
            <div class="link-preview-copy">
              <div class="link-preview-meta">${escapeHtml(previewStatus)}</div>
              <div class="link-preview-text">${escapeHtml(unavailableText)}</div>
            </div>
          </div>
        `}
      </div>
    `;
  };

  const isPlayableVideoUrl = url =>
    /^(data:video\/|https?:\/\/.+\.(?:mp4|mov|webm|m4v|mkv)(?:\?|$))/i.test(String(url || ''));

  const isSocialPreviewUrl = url => {
    try {
      const host = new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
      return [
        'douyin.com',
        'v.douyin.com',
        'iesdouyin.com',
        'xiaohongshu.com',
        'xhslink.com',
      ].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    } catch {
      return false;
    }
  };

  return ui`
    <div class="message-attachments">
      ${attachments
        .map(attachment => {
          if (attachment.kind === 'image') {
            return ui`
              <figure class="message-attachment-card media-card image-card">
                <img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachmentLabel(attachment))}" class="message-image" />
                <figcaption>${escapeHtml(attachmentLabel(attachment))}</figcaption>
              </figure>
            `;
          }

          if (attachment.kind === 'video') {
            if (!isPlayableVideoUrl(attachment.url) || isSocialPreviewUrl(attachment.url)) {
              return renderLinkAttachmentCard(attachment);
            }
            const status = describeVideoExtractionStatus(message, attachment);
            return ui`
              <div class="message-attachment-card media-card">
                <video class="message-video" controls src="${escapeHtml(attachment.url)}"></video>
                <div class="media-caption">
                  ${escapeHtml(attachmentLabel(attachment))}
                  <span class="media-caption-hint">${escapeHtml(status)}</span>
                </div>
              </div>
            `;
          }

          if (attachment.kind === 'audio') {
            const status = describeAudioExtractionStatus(message, attachment);
            return ui`
              <div class="message-attachment-card audio-card" data-audio-url="${escapeHtml(attachment.url)}">
                <div class="audio-card-title">
                  <span class="chip-icon">${icon.audio}</span>
                  ${escapeHtml(attachmentLabel(attachment))}
                  <span class="media-caption-hint">${escapeHtml(status)}</span>
                </div>
                <audio class="message-audio" controls src="${escapeHtml(attachment.url)}"></audio>
              </div>
            `;
          }

          return renderLinkAttachmentCard(attachment);
        })
        .join('')}
    </div>
  `;
}
import { renderCopyLinkButton } from './linkActions.js';
