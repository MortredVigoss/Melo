/**
 * Describe what the video extractor actually produced for this attachment.
 *
 * The promise on the composer button is "transcript + keyframes", but
 * `videoExtractor.js` can return any combination — full transcript +
 * keyframes (the happy path), keyframes-only (audio failed), or null
 * (both failed and we never created an extractedMedia entry at all).
 * Reading `message.extractedMedia[]` for the matching attachment lets the
 * UI show what really got attached instead of repeating the marketing
 * blurb on every card.
 */
export function describeVideoExtractionStatus(message, attachment) {
  const entries = Array.isArray(message?.extractedMedia) ? message.extractedMedia : [];
  const entry = entries.find(e => e?.attachmentId && attachment?.id && e.attachmentId === attachment.id);
  if (!entry) {
    // No matching entry: either still processing (sync extraction usually
    // means the message wouldn't have been rendered yet) or both audio +
    // keyframes failed and we shipped nothing.
    return 'extraction unavailable';
  }
  const source = entry?.metadata?.source || '';
  const keyframes = Array.isArray(entry?.metadata?.keyframes) ? entry.metadata.keyframes : [];
  const frameCount = keyframes.length;
  if (source === 'video-keyframes-only') {
    return frameCount
      ? `keyframes ✓ (${frameCount}) · no audio transcript`
      : 'no audio transcript';
  }
  if (source === 'video-audio-transcript') {
    return frameCount
      ? `transcript ✓ · keyframes ✓ (${frameCount})`
      : 'transcript ✓';
  }
  // Other sources (e.g. user voice transcript injected as extractedMedia)
  // arrived for this attachment id — treat as transcript only.
  return frameCount ? `transcript ✓ · keyframes ✓ (${frameCount})` : 'transcript ✓';
}
