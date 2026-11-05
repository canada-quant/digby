/**
 * Ticket 36b8c979 — a server-side LIVENESS PROBE for the repo-scoped done-bar
 * (closure-evidence.ts / fix-state.ts), for evidence on repos that deploy
 * WITHOUT GitHub Actions and are NOT Digby boxes (the 2026-10-28 observed
 * shape: example-org/optcg → deckpose.com, total_count 0 Actions runs, no
 * .github/workflows, never a box_health row — the two existing deployed legs
 * (b-i isDeployRunGreen, b-ii isFixLivePerTelemetry) can never pass, so a
 * verified merged+live fix refuses fix_not_live forever).
 *
 * THE PATH: the close cites evidence.livenessProbe = { url, expect: [strings]
 * } — the LIVE SURFACE the fix ships on — and the GATE ITSELF re-fetches that
 * url server-side at resolve time and asserts every expected string appears
 * in the body. A lane-pasted curl output is never trusted: the fetch happens
 * HERE, at close time and again at every later reopen scan, so a stale probe
 * re-fires when the strings leave the surface (the same fail-closed direction
 * as every other leg).
 *
 * SSRF DISCIPLINE (the probe url is LANE-SUPPLIED — a ticket lane's own
 * input, which could otherwise point this server's fetch anywhere): https
 * scheme ONLY; no credentials in the url; the host must be a public,
 * dotted, non-localhost name (or a public IP literal); every DNS-resolved
 * address (A + AAAA) must be PUBLIC — loopback / RFC1918 / link-local /
 * CGNAT 100.64/10 / 0.x / IETF / multicast / IPv6 site-locals and ::1 are
 * REFUSED; redirects are followed MANUALLY with every hop re-validated the
 * same way (max 3 hops). Fail-closed everywhere: a malformed probe, a
 * validation refusal, a DNS error, a non-200 response or a MISSING expected
 * string is `live:false` with the reason — never an exception out, never a
 * partial-pass.
 *
 * This file is an IMPORT-FREE leaf (Node's URL + dns/promises only — no
 * prisma, no logger, nothing from the app): both the close gate
 * (closure-evidence.ts) and the resolver (fix-state.ts) consume its pure
 * predicates, and neither module's static graph grows. doFetch/doLookup are
 * injectable seams (the unit tests stub both; production uses the globals).
 *
 * Kill switch: FIX_STATE_LIVENESS_PROBE_DISABLED=1 makes fix-state.ts ignore
 * a recorded probe entirely (the pre-36b8c979 behavior — a recorded probe
 * then counts as absent, so the close re-refuses unless a run/telemetry leg
 * proves it).
 */

import { lookup as dnsLookupAll } from 'dns/promises';

/** The shape the close evidence carries (closure-evidence.ts CloseEvidence.livenessProbe). */
export interface LivenessProbeEvidence {
  /** The public live surface the fix ships on (https, public host). */
  url: string;
  /** EVERY string here must appear in the response body (case-sensitive, exact). */
  expect: string[];
}

export type LivenessProbeValidation =
  | { ok: true; url: URL; expect: string[] }
  | { ok: false; reason: 'invalid_url' | 'insecure_scheme' | 'credentials' | 'ssrf_host' | 'empty_expect' | 'invalid_expect'; message: string };

export type LivenessProbeResult =
  | { live: true; detail: string; status: number; finalUrl: string; hops: number }
  | { live: false; detail: string };

/** The DNS seam: every resolved address of a hostname (A + AAAA). */
export type DnsLookupAll = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

const PROBE_TIMEOUT_MS = 8_000; // the fix-state/closure-evidence network budget
const PROBE_MAX_REDIRECTS = 3; // every hop re-validated
const PROBE_BODY_CAP_BYTES = 2_000_000; // a landing page; well under any sane surface
const PROBE_MAX_HOPS = PROBE_MAX_REDIRECTS;

/** 1-4 digit octet, 0-255 — for the dotted-quad IP-literal detection. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/** An IPv4/IPv6 address an instance of this server must not be made to fetch. */
function isForbiddenIp(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF protocol + 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale et al.)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * The SSRF host predicate: TRUE = this host may be fetched. A name must be
 * dotted and not localhost/loopback-shaped; an IP literal must be public.
 * (A resolved NON-literal is re-checked per-address after DNS — see
 * assertResolvableAddresses.)
 */
export function isPublicHttpHost(hostname: string): boolean {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, ''); // FQDN trailing dot
  if (!h) return false;
  const v4 = parseIpv4(h);
  if (v4) return !isForbiddenIp(v4);
  if (h.startsWith('[') && h.endsWith(']')) return false; // bracketed v6 reaches here only un-normalized
  if (h.includes(':')) {
    // IPv6 literal (URL already lowercases and un-brackets hostname).
    if (h === '::1' || h === '::') return false;
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast,
    // ::ffff:<v4> mapped — parse the first hextet conservatively; anything
    // clearly local is refused, everything else falls through to DNS
    // re-validation where the resolved addresses are checked for real.
    const first = parseInt(h.split(':')[0], 16);
    if (Number.isFinite(first) && (first === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00)) return false;
    if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const v4m = parseIpv4(h.slice(7));
      return !!v4m && !isForbiddenIp(v4m);
    }
    // Not a recognized-local v6 → let DNS revalidation decide.
    return true;
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (!h.includes('.')) return false; // a bare internal name ('intranet') is never public
  return true;
}

/** Validate the probe's URL against the SSRF shape. Pure — no network. */
export function validateLivenessProbeUrl(rawUrl: string): LivenessProbeValidation {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { ok: false, reason: 'invalid_url', message: `livenessProbe.url "${String(rawUrl).slice(0, 120)}" is not a valid absolute URL.` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'insecure_scheme', message: `livenessProbe.url must be https (got "${url.protocol}") — the gate will not fetch plain http.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials', message: 'livenessProbe.url must not carry credentials (user:pass@host).' };
  }
  if (!isPublicHttpHost(url.hostname)) {
    return { ok: false, reason: 'ssrf_host', message: `livenessProbe.url host "${url.hostname}" is not a public host — the gate refuses loopback / private / link-local / non-dotted names (SSRF guard).` };
  }
  return { ok: true, url, expect: [] };
}

/** Validate a full probe (url + expected strings). Pure — no network. */
export function validateLivenessProbe(probe: unknown): LivenessProbeValidation {
  if (typeof probe !== 'object' || probe === null) {
    return { ok: false, reason: 'invalid_url', message: 'evidence.livenessProbe must be an object {url, expect:[...]}.' };
  }
  const p = probe as { url?: unknown; expect?: unknown };
  const urlCheck = validateLivenessProbeUrl(typeof p.url === 'string' ? p.url : '');
  if (!urlCheck.ok) return urlCheck;
  // A supplied expect member that is not a non-empty string REFUSES (the close
  // gate never silently drops junk from the evidence a lane cited) — only a
  // WHOLLY absent expect is treated as the empty shape.
  if (!Array.isArray(p.expect)) {
    return { ok: false, reason: 'empty_expect', message: 'evidence.livenessProbe.expect must be an array of strings that must appear on the live surface.' };
  }
  if (p.expect.some((s: unknown) => typeof s !== 'string' || s.length === 0)) {
    return { ok: false, reason: 'invalid_expect', message: 'every livenessProbe.expect member must be a non-empty string.' };
  }
  const expect = p.expect as string[];
  if (!expect.length) {
    return { ok: false, reason: 'empty_expect', message: 'evidence.livenessProbe.expect must list at least one non-empty string that must appear on the live surface.' };
  }
  if (expect.some((s) => s.length > 200)) {
    return { ok: false, reason: 'invalid_expect', message: 'every livenessProbe.expect string must be ≤200 chars.' };
  }
  return { ok: true, url: urlCheck.url, expect };
}

/**
 * The audit-note serialization (closure-evidence.ts writes this into the
 * `[machine-close evidence: …]` block; fix-state.ts parses it back). ONE
 * LINE: the block regex `[machine-close evidence: ([^\]]+)]` and the
 * `; `-joined member shapes must both hold. The expect strings are joined
 * with `|` inside double quotes; a probe whose expect string contains a
 * double quote or a pipe cannot be serialized and is rejected AT VALIDATION
 * TIME by the caller (serializeLivenessProbe returns null).
 */
export function serializeLivenessProbe(probe: LivenessProbeEvidence): string | null {
  const v = validateLivenessProbe(probe);
  if (!v.ok) return null;
  const cleaned = String(v.url.toString());
  if (cleaned.length > 400) return null;
  if (v.expect.some((s) => /["|]/.test(s))) return null;
  return `live-probe ${cleaned} (expects "${v.expect.join('|')}")`;
}

/** Parse the serialized note member back (the inverse — fix-state.ts). */
export function parseLivenessProbeFromNote(text: string): LivenessProbeEvidence | null {
  const m = /\blive-probe (\S+) \(expects "([^"]+)"\)/.exec(String(text ?? ''));
  if (!m) return null;
  const expect = m[2].split('|').filter(Boolean);
  if (!expect.length) return null;
  return { url: m[1], expect };
}

/**
 * THE PROBE ITSELF: validate → resolve every address public → fetch (manual
 * redirects, every hop re-validated) → assert EVERY expect string appears in
 * the body. Never throws; every failure is a `live:false` detail. doFetch /
 * doLookup injectable for tests; production passes nothing (globals).
 */
export async function probeLiveness(
  probe: LivenessProbeEvidence,
  opts: { doFetch?: typeof fetch; doLookup?: DnsLookupAll } = {},
): Promise<LivenessProbeResult> {
  const v = validateLivenessProbe(probe);
  if (!v.ok) return { live: false, detail: `livenessProbe refused (${v.reason}): ${v.message}` };

  const doLookup: DnsLookupAll =
    opts.doLookup ??
    (async (host: string, o: { all: true }) => dnsLookupAll(host, o));
  const doFetch = opts.doFetch ?? fetch;

  let currentUrl = v.url;
  let hops = 0;
  try {
    while (true) {
      // DNS re-validation: EVERY resolved address must be public (a public
      // name resolving to a private address is the classic rebinding /
      // split-horizon SSRF — fail closed on any single bad address).
      const addrs = (await doLookup(currentUrl.hostname, { all: true })) as Array<{ address: string; family: number }>;
      if (!Array.isArray(addrs) || !addrs.length) {
        return { live: false, detail: `livenessProbe failed: DNS returned no addresses for ${currentUrl.hostname}` };
      }
      for (const a of addrs) {
        if (a.family === 4) {
          const oct = parseIpv4(a.address);
          if (!oct || isForbiddenIp(oct)) {
            return { live: false, detail: `livenessProbe refused: ${currentUrl.hostname} resolves to a non-public address (${a.address}) — SSRF guard` };
          }
        } else if (!isPublicHttpHost(a.address)) {
          return { live: false, detail: `livenessProbe refused: ${currentUrl.hostname} resolves to a non-public address (${a.address}) — SSRF guard` };
        }
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      let res: Response;
      try {
        res = await doFetch(currentUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': 'digby-fix-state-liveness' },
          signal: ctrl.signal,
        }) as Response;
      } catch (err: any) {
        return { live: false, detail: `livenessProbe failed: fetch error (${String(err?.message ?? err).slice(0, 120)})` };
      } finally {
        clearTimeout(timer);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return { live: false, detail: `livenessProbe failed: ${res.status} redirect with no location header` };
        if (hops >= PROBE_MAX_HOPS) {
          return { live: false, detail: `livenessProbe refused: more than ${PROBE_MAX_HOPS} redirects` };
        }
        let next: URL;
        try {
          next = new URL(loc, currentUrl);
        } catch {
          return { live: false, detail: `livenessProbe failed: unparseable redirect location "${String(loc).slice(0, 120)}"` };
        }
        if (next.protocol !== 'https:') {
          return { live: false, detail: `livenessProbe refused: redirect leaves https (${next.protocol})` };
        }
        if (!isPublicHttpHost(next.hostname)) {
          return { live: false, detail: `livenessProbe refused: redirect host "${next.hostname}" is not a public host — SSRF guard` };
        }
        currentUrl = next;
        hops += 1;
        continue;
      }

      if (res.status !== 200) {
        return { live: false, detail: `livenessProbe failed: HTTP ${res.status} from ${currentUrl.toString()} (expected 200)` };
      }

      const body = await res.text().catch((err: any) => {
        throw new Error(`body read error (${String(err?.message ?? err).slice(0, 80)})`);
      });
      const capped = body.length > PROBE_BODY_CAP_BYTES ? body.slice(0, PROBE_BODY_CAP_BYTES) : body;
      const missing = v.expect.filter((s) => !capped.includes(s));
      if (missing.length) {
        return { live: false, detail: `livenessProbe failed: HTTP 200 from ${currentUrl.toString()} but ${missing.length}/${v.expect.length} expected string(s) missing: ${missing.map((s) => `"${s.slice(0, 60)}"`).join(', ')}` };
      }
      return {
        live: true,
        detail: `live-probe ${v.url.toString()} returned HTTP 200 with all ${v.expect.length} expected string(s)${hops ? ` (${hops} redirect hop(s) followed)` : ''}`,
        status: res.status,
        finalUrl: currentUrl.toString(),
        hops,
      };
    }
  } catch (err: any) {
    return { live: false, detail: `livenessProbe failed: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}
