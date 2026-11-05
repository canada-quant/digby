/**
 * Ticket 36b8c979 — the liveness-probe leaf (the deployed leg's third path).
 *
 * The 2026-10-28 observed shape (family lane 3548ec41, ticket 4e818bb9):
 * example-org/optcg deploys manually — repos/example-org/optcg/actions/runs →
 * total_count 0, no .github/workflows, and deckpose.com is not a Digby box so
 * no box_health row will ever carry an optcg sha. Both existing deployed legs
 * can never pass, so a verified merged+live fix refused fix_not_live forever.
 *
 * THE FIX under test here, unit-level: the probe leaf's validators (https
 * only, public hosts only, credential-free, every expect member a non-empty
 * string), its note serialization round-trip, and probeLiveness itself —
 * server-side fetch with SSRF guards (DNS re-validation per address, manual
 * redirects re-validated per hop), asserting EVERY expect string, failing
 * CLOSED on every refusal/error/missing string. Fetch + DNS are injected —
 * no network in these tests, no mocks of app modules (the leaf imports
 * nothing from the app).
 */

import {
  isPublicHttpHost,
  validateLivenessProbe,
  validateLivenessProbeUrl,
  serializeLivenessProbe,
  parseLivenessProbeFromNote,
  probeLiveness,
} from './liveness-probe';

const PUBLIC_IP = '76.76.21.21'; // deckpose.com's Vercel edge — a public address

/** A response factory covering both consumers: ghGet (json) and probeLiveness (text/headers). */
const res = (status: number, body: any, headers: Record<string, string> = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[String(k).toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  }) as any;

const lookup = (map: Record<string, Array<{ address: string; family: number }>>) =>
  (jest.fn(async (host: string) => {
    const v = map[host];
    if (!v) throw new Error(`lookup ${host}: not found`);
    return v;
  }) as unknown) as typeof import('dns').promises.lookup;

describe('validateLivenessProbeUrl — the SSRF shape (https, public, credential-free)', () => {
  it('accepts a plain public https url and normalizes a trailing-dot FQDN', () => {
    expect(validateLivenessProbeUrl('https://deckpose.com/')).toMatchObject({ ok: true });
    expect(validateLivenessProbeUrl('https://deckpose.com./decks')!.ok).toBe(true);
    expect(validateLivenessProbeUrl(`https://${PUBLIC_IP}/health`)!.ok).toBe(true);
  });

  it('refuses non-https schemes and credentials', () => {
    expect(validateLivenessProbeUrl('http://deckpose.com/')).toMatchObject({ ok: false, reason: 'insecure_scheme' });
    expect(validateLivenessProbeUrl('ftp://deckpose.com/')).toMatchObject({ ok: false, reason: 'insecure_scheme' });
    expect(validateLivenessProbeUrl('https://user:pass@deckpose.com/')).toMatchObject({ ok: false, reason: 'credentials' });
    expect(validateLivenessProbeUrl('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('refuses loopback / private / link-local / CGNAT / this-network / multicast IP literals (SSRF)', () => {
    for (const host of ['127.0.0.1', '10.0.0.4', '172.16.0.9', '192.168.1.4', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '239.1.1.1', '224.0.0.1']) {
      expect(validateLivenessProbeUrl(`https://${host}/`)).toMatchObject({ ok: false, reason: 'ssrf_host' });
    }
  });

  it('refuses IPv6 locals and non-dotted / internal-suffix names', () => {
    // Bare (unbracketed) IPv6 literals are not even URL-parseable hosts —
    // they refuse at the parse gate (invalid_url); the fail-closed outcome
    // is what matters, not which gate refuses.
    for (const host of ['::1', 'fe80::1', 'fd00::1', 'ff02::1']) {
      expect(validateLivenessProbeUrl(`https://${host}/`)!.ok).toBe(false);
    }
    for (const host of ['localhost', 'intranet', 'box.localhost', 'printer.local', 'host.internal']) {
      expect(validateLivenessProbeUrl(`https://${host}/`)).toMatchObject({ ok: false, reason: 'ssrf_host' });
    }
    // A bracketed v6 literal never normalizes through the validator.
    expect(validateLivenessProbeUrl('https://[::1]/')).toMatchObject({ ok: false, reason: 'ssrf_host' });
  });

  it('isPublicHttpHost mirrors the validator for the redirect-hop checks', () => {
    expect(isPublicHttpHost('deckpose.com')).toBe(true);
    expect(isPublicHttpHost('127.0.0.1')).toBe(false);
    expect(isPublicHttpHost('metadata.google.internal')).toBe(false);
  });
});

describe('validateLivenessProbe — the full shape', () => {
  it('requires an object, an https public url, and non-empty string expect members', () => {
    expect(validateLivenessProbe(null)).toMatchObject({ ok: false });
    expect(validateLivenessProbe('https://deckpose.com/')).toMatchObject({ ok: false });
    expect(validateLivenessProbe({ url: 'http://deckpose.com/', expect: ['x'] })).toMatchObject({ ok: false, reason: 'insecure_scheme' });
    expect(validateLivenessProbe({ url: 'https://deckpose.com/' })).toMatchObject({ ok: false, reason: 'empty_expect' });
    expect(validateLivenessProbe({ url: 'https://deckpose.com/', expect: [] })).toMatchObject({ ok: false, reason: 'empty_expect' });
    expect(validateLivenessProbe({ url: 'https://deckpose.com/', expect: ['ok', ''] })).toMatchObject({ ok: false, reason: 'invalid_expect' });
    expect(validateLivenessProbe({ url: 'https://deckpose.com/', expect: ['ok', 7] })).toMatchObject({ ok: false, reason: 'invalid_expect' });
    expect(validateLivenessProbe({ url: 'https://deckpose.com/', expect: ['Save to My Decks'] })).toMatchObject({ ok: true, expect: ['Save to My Decks'] });
  });
});

describe('note serialization round-trip (the audit-note member)', () => {
  it('serializes to ONE line and parses back exactly', () => {
    const s = serializeLivenessProbe({ url: 'https://deckpose.com/', expect: ['Save to My Decks', 'Copy decklist'] });
    expect(s).toBe('live-probe https://deckpose.com/ (expects "Save to My Decks|Copy decklist")');
    expect(parseLivenessProbeFromNote(`commit 23fb3716 (format-verified); repo example-org/optcg; ${s}`)).toEqual({
      url: 'https://deckpose.com/',
      expect: ['Save to My Decks', 'Copy decklist'],
    });
    expect(parseLivenessProbeFromNote('no probe here')).toBeNull();
  });

  it('refuses to serialize an expect string carrying a quote or pipe, or an oversized url', () => {
    expect(serializeLivenessProbe({ url: 'https://deckpose.com/', expect: ['say "hi"'] })).toBeNull();
    expect(serializeLivenessProbe({ url: 'https://deckpose.com/', expect: ['a|b'] })).toBeNull();
    expect(serializeLivenessProbe({ url: `https://deckpose.com/${'x'.repeat(500)}`, expect: ['x'] })).toBeNull();
  });
});

describe('probeLiveness — the server-side fetch (SSRF guards, fail-closed)', () => {
  const okProbe = { url: 'https://deckpose.com/', expect: ['Save to My Decks', 'Copy decklist'] };
  const dnsPublic = lookup({ 'deckpose.com': [{ address: PUBLIC_IP, family: 4 }] });

  it('LIVE: 200 body carrying every expected string (the 4e818bb9 replay, leaf-level)', async () => {
    const doFetch = jest.fn(async () => res(200, '<html>Save to My Decks — Copy decklist — Edit deck</html>')) as any;
    const out = await probeLiveness(okProbe, { doFetch, doLookup: dnsPublic });
    expect(out).toMatchObject({ live: true, status: 200 });
    expect(out.live && out.detail).toContain('all 2 expected string(s)');
    expect(doFetch.mock.calls[0][1].redirect).toBe('manual'); // never a blind auto-redirect
  });

  it('FAIL-CLOSED: a missing expected string refuses with the missing list', async () => {
    const doFetch = jest.fn(async () => res(200, '<html>Save to My Decks only</html>')) as any;
    const out = await probeLiveness(okProbe, { doFetch, doLookup: dnsPublic });
    expect(out.live).toBe(false);
    expect(out.live === false && out.detail).toContain('1/2 expected string(s) missing');
  });

  it('FAIL-CLOSED: non-200, fetch error, DNS empty and DNS-to-private all refuse', async () => {
    expect((await probeLiveness(okProbe, { doFetch: jest.fn(async () => res(500, 'err')) as any, doLookup: dnsPublic })).live).toBe(false);
    const doFetchErr = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as any;
    const outErr = await probeLiveness(okProbe, { doFetch: doFetchErr, doLookup: dnsPublic });
    expect(outErr.live).toBe(false);
    expect(outErr.live === false && outErr.detail).toContain('fetch error');
    const outEmpty = await probeLiveness(okProbe, { doFetch: jest.fn(async () => res(200, 'x')) as any, doLookup: lookup({ 'deckpose.com': [] }) });
    expect(outEmpty.live).toBe(false);
    const outPrivate = await probeLiveness(okProbe, { doFetch: jest.fn(async () => res(200, 'x')) as any, doLookup: lookup({ 'deckpose.com': [{ address: '10.1.2.3', family: 4 }] }) });
    expect(outPrivate.live).toBe(false);
    expect(outPrivate.live === false && outPrivate.detail).toContain('non-public address (10.1.2.3)');
  });

  it('FAIL-CLOSED: a malformed probe refuses before any network call', async () => {
    const doFetch = jest.fn(async () => res(200, 'x')) as any;
    const out = await probeLiveness({ url: 'http://127.0.0.1:8080/', expect: ['x'] }, { doFetch, doLookup: dnsPublic });
    expect(out.live).toBe(false);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('redirects are followed manually with every hop re-validated (https + public host, ≤3 hops)', async () => {
    const doFetch = jest.fn(async (url: any) => {
      const s = String(url);
      if (s === 'https://deckpose.com/') return res(302, null, { location: 'https://www.deckpose.com/home' });
      return res(200, 'Save to My Decks — Copy decklist');
    }) as any;
    const out = await probeLiveness(okProbe, { doFetch, doLookup: lookup({ 'deckpose.com': [{ address: PUBLIC_IP, family: 4 }], 'www.deckpose.com': [{ address: PUBLIC_IP, family: 4 }] }) });
    expect(out).toMatchObject({ live: true, hops: 1 });
  });

  it('FAIL-CLOSED: a redirect to http, to a private host, or past 3 hops refuses', async () => {
    const toHttp = await probeLiveness(okProbe, {
      doFetch: jest.fn(async () => res(302, null, { location: 'http://deckpose.com/home' })) as any,
      doLookup: dnsPublic,
    });
    expect(toHttp.live === false && toHttp.detail).toContain('leaves https');

    const toPrivate = await probeLiveness(okProbe, {
      doFetch: jest.fn(async () => res(302, null, { location: 'https://169.254.169.254/latest/meta-data/' })) as any,
      doLookup: dnsPublic,
    });
    expect(toPrivate.live).toBe(false);

    const doFetch = jest.fn(async () => res(302, null, { location: 'https://deckpose.com/next' })) as any;
    const tooMany = await probeLiveness(okProbe, { doFetch, doLookup: dnsPublic });
    expect(tooMany.live === false && tooMany.detail).toContain('more than 3 redirects');
  });
});
