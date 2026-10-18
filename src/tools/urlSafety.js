// Public-URL guard for tools that drive a local browser at a user-supplied
// address (web_screenshot). A rendering browser follows the URL with the
// machine's own network position, so the hostname must not point back at the
// machine, the LAN or a cloud metadata endpoint. Hostname-level only — no DNS
// resolution — so a public name resolving to a private address is not caught
// here; the browser tiers run with the user's own network anyway.
// Pure module: no imports.

const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => part >= 0 && part <= 255) ? parts : null;
}

function isPrivateIpv4(parts) {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;           // this-net, private, loopback
  if (a === 169 && b === 254) return true;                     // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking 198.18.0.0/15 (bug audit T16)
  if (a === 198 && b === 51 && c === 100) return true;         // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;          // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true;           // carrier-grade NAT
  if (a >= 224) return true;                                   // multicast / reserved / broadcast
  return false;
}

/**
 * Expand an IPv6 literal (with or without brackets / zone id, optionally with
 * a trailing dotted IPv4) into eight 16-bit groups. Returns null when the
 * text is not a well-formed address.
 */
function parseIpv6(host) {
  let bare = String(host).replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(bare) || bare.indexOf(':::') >= 0) return null;
  const dotted = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (dotted) {
    const parts = parseIpv4(dotted[1]);
    if (!parts) return null;
    const tail = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    bare = bare.slice(0, bare.length - dotted[1].length) + tail;
  }
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const toGroups = text => (text ? text.split(':') : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > (halves.length === 2 ? 7 : 8)) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const values = groups.map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
}

const ipv4FromGroups = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

function isPrivateIpv6(host) {
  const groups = parseIpv6(host);
  if (!groups) return true;                                    // unparseable literal: fail closed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeroPrefix = count => groups.slice(0, count).every(group => group === 0);
  if (zeroPrefix(8)) return true;                              // ::
  if ((g0 & 0xffc0) === 0xfe80) return true;                   // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true;                   // site-local fec0::/10 (deprecated)
  if ((g0 & 0xfe00) === 0xfc00) return true;                   // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true;                   // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true;             // documentation
  // IPv4 embedded forms (bug audit T16): the address is private iff the
  // embedded IPv4 is. Covers `::1` / `::a.b.c.d` (IPv4-compatible),
  // `::ffff:a.b.c.d` / `::ffff:7f00:1` (mapped), `::ffff:0:a.b.c.d`
  // (translated), `64:ff9b::a.b.c.d` (NAT64) and `2002:7f00:1::` (6to4).
  if (zeroPrefix(6)) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  if (zeroPrefix(5) && g5 === 0xffff) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  if (zeroPrefix(4) && g4 === 0xffff && g5 === 0) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;   // local-use NAT64 64:ff9b:1::/48
  if (g0 === 0x2002) return isPrivateIpv4(ipv4FromGroups(g1, g2));
  return false;
}

/**
 * Hostname check shared by the URL guard: true for loopback, private, link-local,
 * multicast ranges, `localhost` style names and single-label / `.local` names.
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (LOCAL_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host.startsWith('[') || host.includes(':')) return isPrivateIpv6(host);
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true; // numeric shorthand (2130706433, 0x7f000001)
  return !host.includes('.');                                           // bare intranet names
}

/**
 * Validate a user-supplied address for a local-browser tool.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function isPublicHttpUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, reason: 'Missing url.' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, reason: `Not a valid URL: ${text.slice(0, 200)}` }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'URL must start with http:// or https://.' };
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed.' };
  if (isPrivateHostname(url.hostname)) return { ok: false, reason: `Host ${url.hostname} is local or private; only public web pages can be rendered.` };
  return { ok: true, url: url.href };
}
