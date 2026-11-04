// Portable personal-organizer contract. Hosts provide storage, clock, IDs and OS effects.
const str = (max, extra = {}) => ({ type: 'string', maxLength: max, ...extra });
const id = str(256, { minLength: 1 });
const fields = { title: str(300, { minLength: 1 }), notes: str(4000), reminderMode: { type: 'string', enum: ['notification', 'alarm'] }, remindAt: str(64, { description: 'ISO datetime with explicit UTC offset; empty clears the reminder.' }) };
const todo = { ...fields, due: str(64, { description: 'ISO datetime with explicit offset; empty clears due date.' }) };
const event = { ...fields, start: str(64, { minLength: 1 }), end: str(64, { minLength: 1 }), timeZone: str(100), allDay: { type: 'boolean' }, location: str(1000), repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] }, repeatUntil: str(64) };
const spec = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', additionalProperties: false, properties, required } });
export const ORGANIZER_TOOLS = [
  spec('todo_list', 'List this device’s Melo personal todos. This is not the agent run/task history.', { query: str(300), completed: { type: 'boolean' } }),
  spec('todo_create', 'Create a Melo todo and optionally schedule a reminder. Report the actual reminder permission/scheduling status from the receipt.', todo, ['title']),
  spec('todo_update', 'Edit an existing Melo todo by its returned ID; preserve unspecified fields.', { id, ...todo }, ['id']),
  spec('todo_complete', 'Complete or reopen a Melo todo. Completing cancels its reminders.', { id, completed: { type: 'boolean' } }, ['id']),
  spec('todo_delete', 'Delete a Melo todo and cancel its reminders.', { id }, ['id']),
  spec('calendar_list_events', 'Read Melo and selected authorized system/ICS calendars in a bounded date range. External calendars are read-only. Returned source errors and freshness are part of the evidence.', { start: str(64, { minLength: 1 }), end: str(64, { minLength: 1 }), query: str(300) }, ['start', 'end']),
  spec('calendar_create_event', 'Create an event in the Melo calendar. ISO start/end need explicit offsets; all-day boundaries are in timeZone, end exclusive.', event, ['title', 'start', 'end']),
  spec('calendar_update_event', 'Edit an existing Melo event series by ID. External system/ICS entries are read-only; never silently copy them.', { id, ...event }, ['id']),
  spec('calendar_delete_event', 'Delete a Melo event series and cancel reminders. Cannot delete remote system/ICS events.', { id }, ['id']),
];

export function organizerEffect(name) { return ORGANIZER_TOOLS.some(tool => tool.name === name) ? name.endsWith('_list') || name === 'calendar_list_events' ? 'read' : 'write' : null; }
function fail(message, code = 'INVALID_ORGANIZER_ARGUMENTS') { throw Object.assign(new Error(message), { code }); }
export function validateOrganizerTool(name, args) {
  const schema = ORGANIZER_TOOLS.find(tool => tool.name === name)?.parameters;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) fail('Unknown organizer command.');
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key))) fail('Missing or unknown organizer field.');
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || value.length > rule.maxLength || (rule.minLength && !value.trim()))) fail('Invalid ' + key);
    if (rule.type === 'boolean' && typeof value !== 'boolean' || rule.enum && !rule.enum.includes(value)) fail('Invalid ' + key);
  }
  return args;
}
function timestamp(value) {
  if (value === '' || value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) fail('Datetime needs an explicit UTC offset.');
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/u);
  const [, year, month, day, hour, minute, second = '0'] = parts.map(part => part == null ? part : Number(part));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) fail('Invalid calendar date.');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail('Invalid datetime.');
  return time;
}
export function organizerInitial() { return { version: 1, todos: [], events: [], receipts: [] }; }
export function organizerCommand({ state = organizerInitial(), name, arguments: args = {}, now, id: recordId, requestId = '' }) {
  validateOrganizerTool(name, args);
  if (state.version !== 1 || !Array.isArray(state.todos) || !Array.isArray(state.events)) fail('Unsupported organizer state.', 'ORGANIZER_VERSION');
  if (!Number.isSafeInteger(now)) fail('Host clock required.');
  const fingerprint = JSON.stringify([name, Object.keys(args).sort().map(key => [key, args[key]])]);
  const prior = requestId && state.receipts?.find(row => row.requestId === requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail('Request ID reused with different input.', 'IDEMPOTENCY_CONFLICT');
    return { state, result: { ...prior.result, replayed: true }, changed: false };
  }
  if (name === 'todo_list') {
    const query = (args.query || '').toLowerCase();
    return { state, changed: false, result: { ok: true, todos: state.todos.filter(row => (args.completed == null || row.completed === args.completed) && (!query || (row.title + ' ' + row.notes).toLowerCase().includes(query))) } };
  }
  if (name === 'calendar_list_events') {
    const start = timestamp(args.start), end = timestamp(args.end);
    if (start == null || end == null || end <= start || end - start > 366 * 86400000) fail('Calendar range must be positive and at most 366 days.');
    return { state, changed: false, result: { ok: true, start, end, query: args.query || '' } };
  }
  const isTodo = name.startsWith('todo_'), key = isTodo ? 'todos' : 'events';
  const creation = name.endsWith('_create') || name.endsWith('_create_event');
  const existing = !creation && state[key].find(row => row.id === args.id);
  if (!creation && !existing) fail('Melo item not found; system/ICS items are read-only.', 'ORGANIZER_NOT_FOUND');
  if (creation && (!recordId || state.todos.some(row => row.id === recordId) || state.events.some(row => row.id === recordId))) fail('Unique Host ID required.');
  if (creation && state[key].length >= 10000) fail('Organizer capacity reached.', 'ORGANIZER_LIMIT');
  let row = existing || { id: recordId, title: '', notes: '', reminderMode: 'notification', remindAt: null, revision: 0, createdAt: now, ...(isTodo ? { dueAt: null, completed: false } : { startAt: now, endAt: now, timeZone: 'UTC', allDay: false, location: '', repeat: 'none', repeatUntil: null }) };
  row = { ...row, revision: row.revision + 1, updatedAt: now };
  for (const field of ['title', 'notes', 'reminderMode', ...(isTodo ? [] : ['timeZone', 'allDay', 'location', 'repeat'])]) if (Object.hasOwn(args, field)) row[field] = typeof args[field] === 'string' ? args[field].trim() : args[field];
  for (const [input, output] of [['remindAt', 'remindAt'], ...(isTodo ? [['due', 'dueAt']] : [['start', 'startAt'], ['end', 'endAt'], ['repeatUntil', 'repeatUntil']])]) if (Object.hasOwn(args, input)) row[output] = timestamp(args[input]);
  if (isTodo && name === 'todo_complete') row.completed = args.completed !== false;
  if (!isTodo && (row.endAt == null || row.startAt == null || row.endAt <= row.startAt)) fail('Event end must follow start.');
  if (!isTodo && (!row.timeZone || row.timeZone.length > 100)) fail('Event timezone required.');
  if (!isTodo && row.remindAt != null && row.startAt - row.remindAt > 30 * 86400000) fail('Reminder lead time must be at most 30 days.');
  if (!isTodo && row.repeatUntil != null && row.repeatUntil < row.startAt) fail('Repeat end precedes event.');
  if (!isTodo && row.remindAt != null && row.remindAt > row.startAt) fail('Event reminder must be at or before start.');
  const deleting = name === 'todo_delete' || name === 'calendar_delete_event';
  const records = state[key].filter(item => item.id !== row.id);
  if (!deleting) records.push(row);
  const result = { ok: true, id: row.id, deleted: deleting, ...(deleting ? {} : { item: row }) };
  const next = { ...state, [key]: records, receipts: [...(state.receipts || []), ...(requestId ? [{ requestId, fingerprint, result }] : [])].slice(-200) };
  return { state: next, result, changed: true };
}
