/**
 * Memory lifecycle helpers.
 *
 * Melo stores memories as append/audit-friendly rows.  This module adds a
 * lightweight continuity layer on top of those rows without changing the DB
 * schema: each row gets lifecycle metadata describing what kind of memory it
 * is, which anchor facts it depends on, and whether it is current, historical,
 * or needs confirmation.
 *
 * The important distinction is:
 *   - anchor facts: home/work location, commute mode, work start time
 *   - dependent facts: alarms, commute duration, morning coffee routines
 *
 * When an anchor changes, dependent facts are not deleted.  They are marked
 * needs_confirmation so the prompt can say "this may be from before you moved"
 * instead of confidently reusing a stale routine.
 */

const LIFECYCLE_VERSION = 1;

export const MEMORY_STATUS = Object.freeze({
  CURRENT: 'current',
  HISTORICAL: 'historical',
  NEEDS_CONFIRMATION: 'needs_confirmation',
});

export const MEMORY_TYPE = Object.freeze({
  IDENTITY: 'identity',
  PREFERENCE: 'preference',
  ROUTINE: 'routine',
  LOCATION: 'location',
  PLAN: 'plan',
  DERIVED: 'derived',
  HISTORICAL: 'historical',
  CONTENT: 'content',
});

const ANCHOR_FACT_KEYS = new Set([
  'home_location',
  'work_location',
  'commute_mode',
  'work_start_time',
]);

const SINGLE_CURRENT_FACT_KEYS = new Set([
  ...ANCHOR_FACT_KEYS,
  'commute_duration',
  'morning_alarm',
]);

const DEPENDENCIES_BY_FACT_KEY = Object.freeze({
  commute_duration: ['home_location', 'work_location', 'commute_mode'],
  morning_alarm: ['home_location', 'work_location', 'commute_duration', 'work_start_time'],
  morning_coffee: ['home_location', 'work_location', 'commute_route'],
  morning_routine: ['home_location', 'work_location', 'commute_mode', 'work_start_time'],
});

const HISTORICAL_PATTERN =
  /\b(?:used to|previously|formerly|old|before i moved)\b|(?:以前|之前|过去|曾经|原来|搬家前|之前住|以前住)/i;

const CHANGE_PATTERNS_BY_FACT_KEY = Object.freeze({
  home_location:
    /\b(?:moved|relocated|now live|new home|changed address)\b|(?:搬家|搬到|搬去了|搬来|新家|现在住|换住处)/i,
  work_location:
    /\b(?:now work|changed jobs|new office|new workplace)\b|(?:换工作|新公司|现在在.{0,30}(?:上班|工作)|新的?办公室|上班地点变了)/i,
  commute_mode:
    /\b(?:now drive|now take|changed commute)\b|(?:现在(?:开车|坐车|坐地铁|坐火车)|通勤方式变了)/i,
  work_start_time:
    /\b(?:now start work|changed start time)\b|(?:现在.{0,12}上班|上班时间变了|改成.{0,12}上班)/i,
});

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function comparableText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function entryText(entry = {}) {
  return normalizeText([
    entry.text,
    entry.searchText,
    entry.metadata?.sourceText,
  ].filter(Boolean).join('\n'));
}

function entryTimestamp(entry = {}) {
  const candidates = [
    entry.updatedAt,
    entry.createdAt,
    entry.metadata?.updatedAt,
    entry.metadata?.validFrom,
  ];
  for (const value of candidates) {
    const ts = Date.parse(value || '');
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function isHistoricalText(text = '') {
  return HISTORICAL_PATTERN.test(text);
}

function hasChangeSignal(factKey, text = '') {
  const pattern = CHANGE_PATTERNS_BY_FACT_KEY[factKey];
  return Boolean(pattern && pattern.test(text));
}

function inferFactKey(text = '', metadata = {}) {
  const explicit = String(metadata.factKey || metadata.topic || metadata.subject || '').trim();
  if (explicit) return explicit;

  const normalized = normalizeText(text);

  if (/\b(?:alarm|wake up|wakeup)\b|(?:闹钟|起床)/i.test(normalized)) {
    return 'morning_alarm';
  }

  if (/\b(?:coffee|cafe|latte|flat white|puzzle)\b|(?:咖啡|早咖|早餐)/i.test(normalized)) {
    return 'morning_coffee';
  }

  if (
    (/\b(?:commute|drive|driving|walk|train|tram|bus)\b/i.test(normalized) ||
      /(?:通勤|开车|坐车|坐地铁|坐火车|步行)/i.test(normalized)) &&
    /(?:\b\d+\s*(?:min|mins|minutes|hour|hours)\b|\d+\s*(?:分钟|小时))/i.test(normalized)
  ) {
    return 'commute_duration';
  }

  if (
    /\b(?:i (?:now )?live in|i'?m based in|my home is|my address is|new home|moved|relocated)\b/i.test(normalized) ||
    /(?:我(?:现在)?住在|我家在|住址|搬家|搬到|搬去了|搬来|新家|换住处)/i.test(normalized)
  ) {
    return 'home_location';
  }

  if (
    /\b(?:i (?:now )?work (?:at|in|near)|my office is|workplace|work location|changed jobs|new office)\b/i.test(normalized) ||
    /(?:我(?:现在)?在.{0,30}(?:上班|工作)|公司在|办公室在|工作地点|换工作|新公司|上班地点)/i.test(normalized)
  ) {
    return 'work_location';
  }

  if (/\b(?:start work|work starts)\b|(?:上班时间|几点上班|开始上班)/i.test(normalized)) {
    return 'work_start_time';
  }

  if (/\b(?:prefer|like|love|hate|avoid)\b|(?:喜欢|偏好|更喜欢|讨厌|不喜欢)/i.test(normalized)) {
    return 'preference';
  }

  return '';
}

function inferMemoryType({ factKey = '', kind = '', category = '', text = '' } = {}) {
  const normalizedKind = String(kind || '').toLowerCase();
  const normalizedCategory = String(category || '').toLowerCase();
  if (normalizedKind === 'identity' || normalizedCategory === 'identity') return MEMORY_TYPE.IDENTITY;
  if (normalizedCategory === 'user_preference' || normalizedCategory === 'preference' || factKey === 'preference') {
    return MEMORY_TYPE.PREFERENCE;
  }
  if (factKey === 'home_location' || factKey === 'work_location') return MEMORY_TYPE.LOCATION;
  if (factKey === 'morning_alarm' || factKey === 'morning_coffee' || factKey === 'morning_routine') {
    return MEMORY_TYPE.ROUTINE;
  }
  if (factKey === 'commute_duration') return MEMORY_TYPE.DERIVED;
  if (normalizedCategory === 'decision') return 'decision';
  if (normalizedCategory === 'correction' || normalizedKind === 'verification-correction') return 'correction';
  if (isHistoricalText(text)) return MEMORY_TYPE.HISTORICAL;
  return MEMORY_TYPE.CONTENT;
}

function defaultConfidence(kind = '', memoryType = '') {
  if (kind === 'fact' || kind === 'session-fact' || kind === 'identity') return 0.82;
  if (memoryType === MEMORY_TYPE.ROUTINE || memoryType === MEMORY_TYPE.DERIVED) return 0.68;
  return 0.6;
}

export function decorateMemoryEntry(entry = {}) {
  const text = entryText(entry);
  const metadata = { ...(entry.metadata || {}) };
  const factKey = inferFactKey(text, metadata);
  const category = metadata.category || '';
  const memoryType = inferMemoryType({
    factKey,
    kind: entry.kind,
    category,
    text,
  });
  const dependsOn = Array.isArray(metadata.dependsOn)
    ? metadata.dependsOn.map(value => String(value || '').trim()).filter(Boolean)
    : DEPENDENCIES_BY_FACT_KEY[factKey] || [];
  const historical = isHistoricalText(text);
  const status = metadata.status || (historical ? MEMORY_STATUS.HISTORICAL : MEMORY_STATUS.CURRENT);

  return {
    ...entry,
    metadata: {
      ...metadata,
      lifecycleVersion: LIFECYCLE_VERSION,
      memoryType,
      status,
      factKey: factKey || metadata.factKey || '',
      dependsOn,
      confidence: Number.isFinite(Number(metadata.confidence))
        ? Number(metadata.confidence)
        : defaultConfidence(entry.kind, memoryType),
      validFrom: metadata.validFrom || entry.createdAt || entry.updatedAt || new Date().toISOString(),
      changeSignal: Boolean(metadata.changeSignal || (factKey && hasChangeSignal(factKey, text))),
      comparableValue: metadata.comparableValue || comparableText(text).slice(0, 240),
    },
  };
}

function newerFirst(a, b) {
  const ts = entryTimestamp(b) - entryTimestamp(a);
  if (ts !== 0) return ts;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function markHistorical(entry, winner, reason = 'newer-current-fact') {
  if (entry.metadata?.status === MEMORY_STATUS.HISTORICAL) return entry;
  return {
    ...entry,
    metadata: {
      ...(entry.metadata || {}),
      status: MEMORY_STATUS.HISTORICAL,
      validTo: entry.metadata?.validTo || winner?.updatedAt || winner?.createdAt || new Date().toISOString(),
      supersededBy: winner?.id || null,
      supersededReason: reason,
    },
  };
}

function markNeedsConfirmation(entry, changedFactKey, anchorEntry) {
  if (entry.metadata?.status === MEMORY_STATUS.HISTORICAL) return entry;
  if (entry.metadata?.status === MEMORY_STATUS.NEEDS_CONFIRMATION) return entry;
  return {
    ...entry,
    metadata: {
      ...(entry.metadata || {}),
      status: MEMORY_STATUS.NEEDS_CONFIRMATION,
      confidence: Math.min(0.45, Number(entry.metadata?.confidence) || 0.45),
      staleBecause: {
        changedFactKey,
        changedAt: anchorEntry?.updatedAt || anchorEntry?.createdAt || new Date().toISOString(),
        anchorId: anchorEntry?.id || null,
      },
    },
  };
}

/**
 * Annotate a full snapshot of memory entries with continuity metadata.
 *
 * This function is intentionally conservative.  It does not delete rows.  It
 * only marks older anchor facts as historical and marks dependent routines as
 * needing confirmation when a newer anchor fact changes.
 */
export function applyMemoryContinuity(entries = []) {
  const annotated = entries.map(entry => decorateMemoryEntry(entry));
  const byNamespace = new Map();

  for (const entry of annotated) {
    const namespace = String(entry.namespace || '').trim();
    if (!namespace) continue;
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push(entry);
  }

  const changedAnchorsByNamespace = new Map();
  const byId = new Map(annotated.map(entry => [entry.id, entry]));

  for (const [namespace, rows] of byNamespace) {
    const byFactKey = new Map();
    for (const row of rows) {
      const key = row.metadata?.factKey;
      if (!key || !SINGLE_CURRENT_FACT_KEYS.has(key)) continue;
      if (row.metadata?.status === MEMORY_STATUS.HISTORICAL) continue;
      if (!byFactKey.has(key)) byFactKey.set(key, []);
      byFactKey.get(key).push(row);
    }

    const changedAnchors = new Map();
    for (const [factKey, group] of byFactKey) {
      const sorted = [...group].sort(newerFirst);
      const winner = sorted[0];
      const hasDifferentValues = new Set(
        sorted.map(row => row.metadata?.comparableValue || comparableText(row.text)),
      ).size > 1;
      const hasExplicitChange = sorted.some(row => row.metadata?.changeSignal);

      if (sorted.length > 1 && hasDifferentValues) {
        for (let i = 1; i < sorted.length; i += 1) {
          byId.set(sorted[i].id, markHistorical(byId.get(sorted[i].id), winner));
        }
      }

      if (ANCHOR_FACT_KEYS.has(factKey) && (hasExplicitChange || (sorted.length > 1 && hasDifferentValues))) {
        changedAnchors.set(factKey, winner);
      }
    }

    if (changedAnchors.size) {
      changedAnchorsByNamespace.set(namespace, changedAnchors);
    }
  }

  for (const [namespace, rows] of byNamespace) {
    const changedAnchors = changedAnchorsByNamespace.get(namespace);
    if (!changedAnchors?.size) continue;

    for (const row of rows) {
      const current = byId.get(row.id) || row;
      const deps = Array.isArray(current.metadata?.dependsOn) ? current.metadata.dependsOn : [];
      if (!deps.length) continue;

      for (const [changedFactKey, anchorEntry] of changedAnchors) {
        if (!deps.includes(changedFactKey)) continue;
        if (current.id === anchorEntry?.id) continue;
        if (entryTimestamp(current) >= entryTimestamp(anchorEntry)) continue;
        byId.set(current.id, markNeedsConfirmation(current, changedFactKey, anchorEntry));
        break;
      }
    }
  }

  return annotated.map(entry => byId.get(entry.id) || entry);
}

export const MEMORY_LIFECYCLE_CONFIG = Object.freeze({
  LIFECYCLE_VERSION,
  ANCHOR_FACT_KEYS: [...ANCHOR_FACT_KEYS],
  SINGLE_CURRENT_FACT_KEYS: [...SINGLE_CURRENT_FACT_KEYS],
});
