/**
 * device_location tool (desktop, 2026-10-22)
 *
 * The computer's current location from macOS Location Services, read by the
 * Melo desktop app shell (desktop-app/main.swift, native server on the
 * server port + 1, the same channel as native transcription). The phone has
 * its own location tool; this gives desktop Agents the same ability for
 * "near me", local weather, time zone and nearby places.
 *
 * Privacy: location is personal data, so like the clipboard every use asks
 * the user first (the phone keeps it off per Agent for the same reason), and
 * channels without an approval surface are refused. Coordinates are rounded
 * to two decimals (about 1 km) before they reach the model; macOS asks for its
 * own permission on first use.
 */

// Longer than the shell's own wait (15 s fix + 5 s place name), so a slow fix
// is reported by the shell as a timeout instead of being cut off here.
export const LOCATION_TIMEOUT_MS = 25_000;
const round = value => Math.round(Number(value) * 100) / 100;

export function formatLocation(value = {}) {
  const place = [value.city, value.region, value.country].filter(part => typeof part === 'string' && part.trim()).join(', ');
  const lines = [
    place ? `Location: ${place}` : 'Location: (no place name available)',
    `Approximate coordinates: ${round(value.latitude)}, ${round(value.longitude)} (rounded to about 1 km)`,
  ];
  if (Number.isFinite(Number(value.accuracy))) lines.push(`Reported accuracy: about ${Math.round(Number(value.accuracy))} m`);
  if (typeof value.timeZone === 'string' && value.timeZone) lines.push(`Time zone: ${value.timeZone}`);
  if (typeof value.timestamp === 'string' && value.timestamp) lines.push(`Measured at: ${value.timestamp}`);
  return lines.join('\n');
}

const FAILURES = {
  denied: ['LOCATION_DENIED', 'Location access is off for Melo. The user can allow it in System Settings → Privacy & Security → Location Services → Melo, then ask again.'],
  restricted: ['LOCATION_DENIED', 'Location access is restricted on this Mac.'],
  disabled: ['LOCATION_DISABLED', 'Location Services are turned off on this Mac (System Settings → Privacy & Security → Location Services).'],
  timeout: ['LOCATION_TIMEOUT', 'The Mac did not report a location in time. Ask the user for the city or area instead.'],
  unavailable: ['LOCATION_UNAVAILABLE', 'The Mac could not determine its location right now. Ask the user for the city or area instead.'],
};

export const deviceLocationTool = {
  id: 'device_location',
  name: 'Device Location',
  category: 'utility',
  description:
    "Get this computer's current approximate location (city, region, country, rounded coordinates, time zone) from macOS Location Services. " +
    "Use it when the user asks about something near them, local weather or local time without naming a place. " +
    'Each use asks the user for approval; if it is declined or access is off, say so and ask for the city instead.',
  capability: 'network',
  needsWorkspace: false,
  isConcurrencySafe: true,
  requiresPermission: true,
  parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  examples: [{}],

  async run(_args = {}, context = {}) {
    // Bind the port before any await (CLAUDE.md §6).
    const env = context.requestContext?.env || process.env;
    const port = Number(env.MELO_DESKTOP_PORT || 43127) + 1;
    const fetchImpl = context.fetchImpl || fetch;
    const timeout = AbortSignal.timeout(context.locationTimeoutMs ?? LOCATION_TIMEOUT_MS);
    const signal = AbortSignal.any([context.signal, timeout].filter(Boolean));
    let reply;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/location`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-melo-native': 'location' }, body: '{}', signal });
      reply = await response.json();
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      if (timeout.aborted) return { ok: false, error: FAILURES.timeout[0], output: FAILURES.timeout[1] };
      return { ok: false, error: 'DESKTOP_SHELL_UNAVAILABLE', output: 'Location needs the Melo desktop app (it reads macOS Location Services); it is not available here. Ask the user for the city or area instead.' };
    }
    if (reply?.ok === true && Number.isFinite(Number(reply.latitude)) && Number.isFinite(Number(reply.longitude))) {
      return {
        ok: true,
        output: formatLocation(reply),
        meta: { city: reply.city || '', region: reply.region || '', country: reply.country || '', latitude: round(reply.latitude), longitude: round(reply.longitude), timeZone: reply.timeZone || '' },
      };
    }
    const [error, output] = FAILURES[reply?.error] || FAILURES.unavailable;
    return { ok: false, error, output };
  },
};
