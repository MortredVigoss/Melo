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
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;           // this-net, private, loopback
  if (a === 169 && b === 254) return true;                     // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 100 && b >= 64 && b <= 127) return true;           // carrier-grade NAT
  if (a >= 224) return true;                                   // multicast / reserved / broadcast
  return false;
}

function isPrivateIpv6(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
  if (bare === '::' || bare === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;            // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;            // unique local fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(bare)) return true;               // multicast
  // IPv4-mapped: dotted (`::ffff:127.0.0.1`) or, as the URL parser
  // normalises it, hex (`::ffff:7f00:1`).
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (mappedDotted) { const parts = parseIpv4(mappedDotted[1]); return !parts || isPrivateIpv4(parts); }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16), low = parseInt(mappedHex[2], 16);
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
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
