// Pure attachment-list rendering shared by the thread-context writer
// (memory/) and the model message builder (services/chat). Lives in domain/
// so memory/ and state/ do not depend on services/ (2026-10-17 audit A-4).
import { titleCase } from '../../shared/helpers.js';

export function summarizeAttachmentsForPrompt(attachments = []) {
  if (!attachments.length) return '';
  return attachments
    .map(attachment => {
      const label =
        attachment.title ||
        attachment.fileName ||
        `${titleCase(attachment.kind)} attachment`;
      const printableUrl =
        attachment.url && !attachment.url.startsWith('data:')
          ? ` (${attachment.url})`
          : '';
      return `- ${titleCase(attachment.kind)}: ${label}${printableUrl}`;
    })
    .join('\n');
}
