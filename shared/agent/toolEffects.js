import { organizerEffect } from './organizer.js';
// Completion/replay semantics only. These declarations NEVER grant permission.
// Unknown extensions remain conservative; concurrency is not a read-only claim.
const READ = new Set(['file_read', 'glob', 'grep', 'read_history', 'search_history', 'web_search', 'fetch_url', 'open_url', 'web_screenshot', 'media_info', 'browser_snapshot', 'browser_read', 'browser_screenshot', 'calendar_list_events', 'reminders_list', 'contacts_search', 'contacts_get', 'location_get', 'get_location', 'location_current']);
const COMPUTE = new Set(['calculator', 'translate', 'melo_escalate']);
const WRITE = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_mkdir', 'xlsx', 'calendar_create_event', 'reminders_create', 'reminders_complete', 'phone_use']);

export function toolEffect(name, args = {}, declaration = {}) {
  if (['read', 'compute', 'write'].includes(declaration.effect)) return declaration.effect;
  if (organizerEffect(name)) return organizerEffect(name);
  if (READ.has(name)) return 'read';
  if (COMPUTE.has(name)) return 'compute';
  if (WRITE.has(name)) return 'write';
  if (name === 'pdf') return args.action === 'read' ? 'read' : 'write';
  if (name === 'image') return ['ocr', 'info', 'analyze'].includes(args.action) ? 'read' : 'write';
  if (name === 'knowledge') return ['search', 'status'].includes(args.action) ? 'read' : 'write';
  // An MCP read-only annotation is useful for presentation, not authority.
  if (declaration.readOnly === true) return 'read';
  return 'unknown';
}
