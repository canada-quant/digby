/**
 * User-added MCP servers (ticket e294f9a4) — the URL trust boundary.
 *
 * A user-supplied MCP URL is fetched FROM THE BACKEND, so it is an SSRF
 * surface: without a guard a user could point Digby at the instance's own
 * private network (the MCP sidecars, Redis, the EC2 metadata service, the
 * admin API on loopback). Rules (same ranges as premise-register.ts
 * isBlockedAddress — kept as a pure leaf here so the MCP client imports no
 * prisma / redis):
 *
 *   - https only (http allowed only under USER_MCP_ALLOW_HTTP=1 — a self-hosted
 *     edge instance talking to a LAN server);
 *   - no credentials in the authority (user:pass@host);
 *   - the hostname is not a local / internal name;
 *   - EVERY address the hostname resolves to is public — checked at CONNECT
 *     time through `guardedLookup` (the http(s) request's own `lookup`), so a
 *     DNS-rebinding answer that flips to 10.x between "validate" and "connect"
 *     is refused too; an IP-literal host (which skips lookup) is checked up
 *     front by `assertUserMcpUrl`.
 *
 * USER_MCP_ALLOW_PRIVATE_HOSTS=1 lifts the address / hostname rules (edge
 * instances whose MCP servers live on the LAN; the jest suites).
 *
 * Pure: imports only node:dns. No env reads outside the two switch helpers.
 */

import dns from 'dns';

export function userMcpAllowPrivateHosts(): boolean {
  return process.env.USER_MCP_ALLOW_PRIVATE_HOSTS === '1';
}
export function userMcpAllowHttp(): boolean {
  return process.env.USER_MCP_ALLOW_HTTP === '1';
}

/** Private / loopback / link-local / CGNAT / unspecified / multicast / metadata ranges. */
export function isBlockedMcpAddress(ip: string): boolean {
  const raw = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const v4 = raw.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (tailnets live here)
    if (a === 192 && b === 0 && Number(v4[3]) === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                          // multicast + reserved + broadcast
    return false;
  }
  const v6 = raw.toLowerCase();
  if (!v6.includes(':')) return false;
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;      // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;      // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/.test(v6)) return true;         // multicast
  if (v6.startsWith('::ffff:')) return true;           // v4-mapped that did not parse above
  if (v6.startsWith('64:ff9b:')) return true;          // NAT64 can reach v4 private space
  return false;
}

export function isBlockedMcpHostname(host: string): boolean {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.lan') || h.endsWith('.home.arpa') || h === 'metadata.google.internal' || h === 'metadata'
    // docker-compose service names (no dot) resolve to the instance's own containers
    || !h.includes('.');
}

export class McpUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'McpUrlError'; }
}

/**
 * Validate a user-supplied MCP URL (shape + host policy). Throws McpUrlError
 * with a user-facing reason; returns the parsed URL.
 */
export function assertUserMcpUrl(raw: string): URL {
  const s = String(raw ?? '').trim();
  if (!s) throw new McpUrlError('A server URL is required.');
  if (s.length > 2048) throw new McpUrlError('The URL is too long (max 2,048 characters).');
  let url: URL;
  try { url = new URL(s); } catch { throw new McpUrlError('That is not a valid URL.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && userMcpAllowHttp())) {
    throw new McpUrlError(url.protocol === 'http:'
      ? 'Use an https:// URL — plain http is refused (the token would travel unencrypted).'
      : `Unsupported URL scheme "${url.protocol}" — use https://.`);
  }
  if (url.username || url.password) throw new McpUrlError('Put credentials in the auth header field, not in the URL (user:pass@host is refused).');
  if (userMcpAllowPrivateHosts()) return url;
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
  if (isIpLiteral) {
    if (isBlockedMcpAddress(bare)) throw new McpUrlError(`${bare} is a private / internal address — Digby only connects to public MCP servers.`);
    return url;
  }
  if (isBlockedMcpHostname(bare)) throw new McpUrlError(`"${bare}" is a local / internal host name — Digby only connects to public MCP servers.`);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * A `lookup` for http(s).request that refuses private answers at CONNECT time
 * (DNS-rebinding safe). Handles both the single-address and the `all: true`
 * call shapes Node uses (autoSelectFamily asks for all).
 */
export function guardedLookup(hostname: string, options: any, callback: LookupCallback): void {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) { callback(err); return; }
    const list = (Array.isArray(addresses) ? addresses : []) as dns.LookupAddress[];
    if (!list.length) { callback(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' })); return; }
    if (!userMcpAllowPrivateHosts()) {
      const bad = list.find((a) => isBlockedMcpAddress(a.address));
      if (bad) {
        callback(Object.assign(new Error(`${hostname} resolves to a private / internal address — refused`), { code: 'EMCPBLOCKED' }));
        return;
      }
    }
    if (opts.all) { callback(null, list); return; }
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * A display form of a stored URL that never shows an embedded secret: query
 * values are masked and any path segment that looks like a token (≥ 16 chars
 * of mixed letters/digits, or a long hex/base64 run) is replaced by "••••".
 * Zapier-style per-user URLs carry the secret in the path.
 */
export function redactMcpUrl(raw: string): string {
  let url: URL;
  try { url = new URL(String(raw ?? '')); } catch { return ''; }
  const segs = url.pathname.split('/').map((seg) => {
    if (!seg) return seg;
    const tokenLike = seg.length >= 16 && /[a-z]/i.test(seg) && /\d/.test(seg);
    const longOpaque = seg.length >= 24 && /^[A-Za-z0-9_\-.~%+=]+$/.test(seg) && !/^[a-z]+(?:-[a-z]+)*$/.test(seg);
    return tokenLike || longOpaque ? '••••' : seg;
  });
  const params = [...url.searchParams.keys()];
  const query = params.length ? `?${params.map((k) => `${encodeURIComponent(k)}=••••`).join('&')}` : '';
  return `${url.protocol}//${url.host}${segs.join('/')}${query}`;
}
