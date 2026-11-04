/**
 * PER-SESSION TAILNET EGRESS POLICY (ticket 4ed6eb2e — Part 3(b) of
 * docs/TAILNET_DEV_CONTAINER_FOLLOWUPS.md: app-level scoping over the shared
 * per-user tailnet node).
 *
 * Pure module (no I/O): the allowlist matcher shared by the backend (config
 * validation in the API) and the in-container SOCKS5 shim (egressProxyJs in
 * dev-container.service.ts), plus the DETERMINISTIC per-session credential
 * derivation (adversarial-design finding: random per-process secrets race
 * last-writer-wins across the worker + API processes, so credentials are
 * HMAC-derived from a shared pepper — CODING_EGRESS_SECRET — and every
 * process computes byte-identical policy files).
 *
 * Policy model (all optional; resolution inside the shim):
 *   session override (ChatCodingState.tailnetEgressAllow)
 *     ?? user default (UserPreferences.devContainerEgressAllow)
 *       ?? ALLOW-ALL  (v1 reachability preserved — degrade-never-break)
 * A rule is a host suffix, exact host, or CIDR, with an optional :port
 * (`box-1`, `.tail1234.ts.net`, `100.64.0.0/10:22`, `[fd7a::/64]:443`).
 * An EXPLICIT empty list = deny-all (a configured posture, not a missing one).
 *
 * ADVISORY BY DESIGN: enforcement lives in the app-layer shim the sanctioned
 * helpers/env point at. A process inside the container that deliberately
 * hunts the undocumented upstream port can still bypass it (one netns, one
 * uid — tailscaled listeners are TCP-only, verified against tailscale
 * v1.102.3 cmd/tailscaled/proxy.go: net.Listen("tcp", …) unconditionally).
 * True network enforcement needs per-session tagged nodes (Part 3(a),
 * deferred) or a sidecar netns — out of scope here.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export interface EgressRule {
  /** Normalized rule text as entered (lowercased host / canonical-ish CIDR + :port). */
  raw: string;
  /** 'host' = exact or suffix hostname; 'cidr' = IP range. */
  kind: 'host' | 'cidr';
  /** kind 'host': lowercase hostname or suffix (leading '.' = suffix match). */
  host?: string;
  /** kind 'cidr': network address bytes + prefix length (v4: 4 bytes, v6: 16). */
  cidr?: { bytes: Buffer; prefix: number; v6: boolean };
  /** Port restriction (null = any port). */
  port: number | null;
}

export type EgressPolicy = EgressRule[];

/** Result of validating operator-entered policy text (API + status surface). */
export interface PolicyParse {
  rules: EgressPolicy | null; // null = invalid input (errors set)
  errors: string[];
}

const MAX_RULES = 100;
const MAX_RULE_LEN = 253 + 10; // DNS-max host + port decoration

/** Parse an IPv4 address to its 4 bytes, or null. Rejects non-strict forms. */
function ipv4Bytes(ip: string): Buffer | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = Buffer.alloc(4);
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255 || String(n) !== m[i]) return null; // no octal/empty quirks
    b[i - 1] = n;
  }
  return b;
}

/**
 * Parse an IPv6 address to 16 bytes. Small canonical parser (no dep): handles
 * '::' compression and embedded trailing IPv4. Returns null on anything odd.
 */
export function ipv6Bytes(ip: string): Buffer | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase();
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → expand to two hex groups.
  const v4 = ipv4Bytes(s.split(':').pop() || '');
  if (v4 && s.includes('.')) {
    const tail = `${v4[0].toString(16).padStart(2, '0')}${v4[1].toString(16).padStart(2, '0')}:${v4[2].toString(16).padStart(2, '0')}${v4[3].toString(16).padStart(2, '0')}`;
    s = `${s.slice(0, s.lastIndexOf(':'))}:${tail}`;
  }
  const dc = s.indexOf('::');
  let head: string[];
  let tailParts: string[] = [];
  if (dc >= 0) {
    head = s.slice(0, dc).split(':').filter(Boolean);
    tailParts = s.slice(dc + 2).split(':').filter(Boolean);
    if (s.indexOf('::', dc + 1) >= 0) return null; // two compressions
  } else {
    head = s.split(':');
  }
  const missing = 8 - head.length - tailParts.length;
  if (missing < 0 || (dc < 0 && missing !== 0) || head.length + tailParts.length > 8) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tailParts];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return out;
}

/** bytes ⊆ network(bytes,prefix)? */
function cidrContains(network: Buffer, prefix: number, addr: Buffer): boolean {
  if (network.length !== addr.length) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (network[i] !== addr[i]) return false;
  const rem = prefix % 8;
  if (rem === 0) return true;
  if (full >= addr.length) return false;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (network[full] & mask) === (addr[full] & mask);
}

/**
 * Parse ONE rule string. Throws Error with an operator-facing message on
 * invalid input (callers collect per-rule errors).
 */
export function parseRule(input: string): EgressRule {
  const raw0 = input.trim();
  if (!raw0) throw new Error('empty rule');
  if (raw0.length > MAX_RULE_LEN) throw new Error(`rule too long (>${MAX_RULE_LEN} chars)`);

  // Split an optional :port suffix. Order matters: try the WHOLE body as an
  // IP/CIDR first so a plain IPv6 address ending in a number ('fd7a::1') is
  // never mistaken for host:port. Bracketed '[…]:port' is the only way to
  // attach a port to an IPv6 rule.
  let body = raw0;
  let port: number | null = null;
  const bracketPort = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(body);
  if (bracketPort) {
    body = bracketPort[1];
    if (bracketPort[2] !== undefined) port = Number(bracketPort[2]);
  } else if ((body.match(/:/g) || []).length === 1) {
    // Single colon → host-or-IPv4[:port] forms only (multi-colon = IPv6, below).
    const m = /^(.*):(\d{1,5})$/.exec(body);
    if (m) { body = m[1]; port = Number(m[2]); }
  } else if (body.includes(':') && !ipv6Bytes(body.split('/')[0])) {
    throw new Error('IPv6 rules with a port need brackets: [addr[/prefix]]:port');
  }
  if (port !== null && (port < 1 || port > 65535)) throw new Error(`bad port in "${raw0}" (1-65535)`);

  // CIDR?
  const slash = body.lastIndexOf('/');
  if (slash >= 0) {
    const addr = body.slice(0, slash);
    const prefixStr = body.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixStr)) throw new Error(`bad CIDR prefix in "${raw0}"`);
    const prefix = Number(prefixStr);
    const v4 = ipv4Bytes(addr);
    if (v4) {
      if (prefix > 32) throw new Error(`IPv4 CIDR prefix /${prefix} > 32 in "${raw0}"`);
      return { raw: raw0, kind: 'cidr', cidr: { bytes: v4, prefix, v6: false }, port };
    }
    const v6 = ipv6Bytes(addr);
    if (v6) {
      if (prefix > 128) throw new Error(`IPv6 CIDR prefix /${prefix} > 128 in "${raw0}"`);
      return { raw: raw0, kind: 'cidr', cidr: { bytes: v6, prefix, v6: true }, port };
    }
    throw new Error(`bad CIDR address in "${raw0}"`);
  }

  // A bare IP literal is a /32 or /128 CIDR.
  const v4 = ipv4Bytes(body);
  if (v4) return { raw: raw0, kind: 'cidr', cidr: { bytes: v4, prefix: 32, v6: false }, port };
  const v6 = ipv6Bytes(body);
  if (v6) return { raw: raw0, kind: 'cidr', cidr: { bytes: v6, prefix: 128, v6: true }, port };
  // Numeric-dotted text that FAILED IPv4 parsing ('256.1.1.1', '1.2.3.4.5') is
  // never a real hostname — reject it instead of silently storing a rule that
  // matches nothing (operator typo'd an IP).
  if (/^\d+(\.\d+)+$/.test(body)) throw new Error(`bad IPv4 address "${raw0}"`);

  // Hostname (exact or leading-dot suffix). '*' alone = match-all rule
  // (hostnames AND IP literals — the only host rule that matches IPs).
  let host = body.toLowerCase();
  if (host === '*') return { raw: raw0, kind: 'host', host: '', port }; // '' suffix matches everything
  if (host.startsWith('*.')) host = host.slice(1); // '*.example.com' → '.example.com'
  if (!/^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) {
    throw new Error(`bad host rule "${raw0}" (want host, .suffix, CIDR, or *)`);
  }
  return { raw: raw0, kind: 'host', host, port };
}

/**
 * Validate operator-entered policy text: a JSON array of strings (the stored
 * form) or a plain string[] already parsed. Returns rules or errors.
 */
export function validatePolicyInput(value: unknown): PolicyParse {
  if (value === null || value === undefined) return { rules: null, errors: ['policy must be an array of rule strings (or null to clear)'] };
  if (!Array.isArray(value)) return { rules: null, errors: ['policy must be an array of rule strings'] };
  if (value.length > MAX_RULES) return { rules: null, errors: [`too many rules (${value.length} > ${MAX_RULES})`] };
  const rules: EgressPolicy = [];
  const errors: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== 'string') { errors.push(`rule ${i + 1}: not a string`); return; }
    try { rules.push(parseRule(entry)); } catch (err: any) { errors.push(`rule ${i + 1} ("${String(entry).slice(0, 40)}"): ${err.message}`); }
  });
  return errors.length ? { rules: null, errors } : { rules, errors: [] };
}

/**
 * Normalize a validated policy to its STORED form: the canonical rule strings
 * (the shim re-parses them with parseRule on every connection — cheap, and it
 * means the in-container file holds human-auditable text, never secrets).
 */
export function policyToStrings(rules: EgressPolicy): string[] {
  return rules.map(r => r.raw);
}

/** Re-parse the stored string[] form (shim path). Invalid entries are SKIPPED
 *  (never fail open on a corrupt entry — but a corrupt entry can't exist if it
 *  went through validatePolicyInput; defense in depth). */
export function policyFromStrings(strings: string[]): EgressPolicy {
  const out: EgressPolicy = [];
  for (const s of strings) {
    try { out.push(parseRule(s)); } catch { /* skip corrupt entry */ }
  }
  return out;
}

/**
 * Does (host, port) satisfy the policy? `host` is the CONNECT destination as
 * given by the client: a hostname (matched against host rules) or an IP
 * literal (matched against CIDR rules — an IP NEVER matches a hostname rule;
 * advisory-mode note: a client that pre-resolves a name to an IP only gets
 * CIDR-based grants, which is the conservative direction).
 */
export function matchesPolicy(rules: EgressPolicy, host: string, port: number): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  const v4 = ipv4Bytes(h);
  const v6 = v4 ? null : ipv6Bytes(h);
  const ipBytes = v4 || v6;
  for (const r of rules) {
    if (r.port !== null && r.port !== port) continue;
    if (r.kind === 'host') {
      const suffix = r.host || '';
      if (suffix === '') return true; // '*' matches EVERY destination (hosts + IPs)
      if (ipBytes) continue; // named host rules never match IP literals
      if (suffix.startsWith('.')) {
        if (h.endsWith(suffix) && h.length > suffix.length) return true;
      } else if (h === suffix) return true;
    } else if (r.cidr && ipBytes) {
      if (r.cidr.v6 === (ipBytes.length === 16) && cidrContains(r.cidr.bytes, r.cidr.prefix, ipBytes)) return true;
    }
  }
  return false;
}

// ── Deterministic per-session proxy credentials (design finding B2) ─────────

/** The shared pepper: identical in backend + worker via the deploy-managed env. */
export function egressSecret(): string | null {
  const v = process.env.CODING_EGRESS_SECRET;
  return v && v.trim() ? v.trim() : null;
}

/** SOCKS5 username for a session (stable, identifier-shaped, loggable). */
export function egressUsername(sessionId: string): string {
  return `s${sessionId.replace(/-/g, '').slice(0, 12)}`;
}

/** SOCKS5 password = HMAC_SHA256(pepper, "egress:"+sessionId) — deterministic
 *  across processes, so concurrent policy-file writers never race (B2). */
export function egressPassword(sessionId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`egress:${sessionId}`).digest('hex');
}

/** sha256 hex of a password — what the in-container cred file stores (never
 *  the password itself; the container root is trusted, but the file is
 *  defense-in-depth against accidental world-readable leftovers). */
export function passwordHash(password: string): string {
  return createHmac('sha256', 'digby-egress-store').update(password).digest('hex');
}

/** Constant-time compare of two hex digests (shim auth path). */
export function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
