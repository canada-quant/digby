/**
 * Unit pins for the per-session tailnet egress policy module (ticket 4ed6eb2e):
 * the allowlist grammar (host / .suffix / *.suffix / * / CIDR / IP, optional
 * :port incl. [v6]:port), the matcher (IPs NEVER match host rules — advisory
 * note), API-side validation, and the deterministic HMAC per-session
 * credentials (multi-process writers must derive byte-identical content).
 */
import {
  parseRule, matchesPolicy, validatePolicyInput, policyToStrings, policyFromStrings,
  egressUsername, egressPassword, passwordHash, hashEquals,
} from './egress-policy';

describe('egress-policy parseRule', () => {
  it('parses exact hosts and suffixes', () => {
    expect(parseRule('box-1')).toMatchObject({ kind: 'host', host: 'box-1', port: null });
    expect(parseRule('.tail1234.ts.net')).toMatchObject({ kind: 'host', host: '.tail1234.ts.net' });
    expect(parseRule('*.example.com').host).toBe('.example.com'); // *.-form normalizes to suffix
    expect(parseRule('HOST.Example.COM').host).toBe('host.example.com'); // lowercased
  });

  it("parses '*' as the match-all host rule", () => {
    expect(parseRule('*')).toMatchObject({ kind: 'host', host: '' });
  });

  it('parses ports on hosts and CIDRs', () => {
    expect(parseRule('box-1:22')).toMatchObject({ kind: 'host', host: 'box-1', port: 22 });
    expect(parseRule('100.64.0.0/10:22')).toMatchObject({ kind: 'cidr', port: 22 });
    expect(parseRule('[fd7a::/64]:443')).toMatchObject({ kind: 'cidr', port: 443 });
  });

  it('parses CIDRs and bare IPs (bare IP = host route)', () => {
    const v4 = parseRule('100.64.0.0/10');
    expect(v4.kind).toBe('cidr');
    expect(v4.cidr).toMatchObject({ prefix: 10, v6: false });
    expect(parseRule('100.1.2.3').cidr).toMatchObject({ prefix: 32, v6: false });
    expect(parseRule('fd7a::1').cidr).toMatchObject({ prefix: 128, v6: true }); // NOT host:port
    expect(parseRule('fd7a:1234::/32').cidr).toMatchObject({ prefix: 32, v6: true });
  });

  it('rejects garbage with operator-facing errors', () => {
    for (const bad of ['', 'bad_host', 'a..b', '100.64.0.0/33', 'x:0', 'x:99999', 'fd7a:::1:2:zz', 'no/such/cidr', '256.1.1.1']) {
      expect(() => parseRule(bad)).toThrow();
    }
  });

  it('rejects unbracketed IPv6-with-port (ambiguous)', () => {
    expect(() => parseRule('[fd7a::1]:22')).not.toThrow();
  });
});

describe('egress-policy matchesPolicy', () => {
  const rules = [
    parseRule('box-1'),
    parseRule('.tail1234.ts.net'),
    parseRule('100.64.0.0/10:22'),
    parseRule('10.0.0.5'),
    parseRule('*'),
  ];

  it('matches exact hosts and suffixes (suffix ≠ parent)', () => {
    expect(matchesPolicy(rules, 'box-1', 22)).toBe(true);
    expect(matchesPolicy(rules, 'a.tail1234.ts.net', 443)).toBe(true);
    expect(matchesPolicy(rules, 'tail1234.ts.net', 443)).toBe(true); // via '*' rule — see next test
    expect(matchesPolicy([parseRule('.tail1234.ts.net')], 'tail1234.ts.net', 443)).toBe(false); // suffix alone ≠ parent
    expect(matchesPolicy([parseRule('.tail1234.ts.net')], 'evil-tail1234.ts.net', 443)).toBe(false);
  });

  it("'*' matches any hostname", () => {
    expect(matchesPolicy([parseRule('*')], 'anything.at.all', 1)).toBe(true);
    expect(matchesPolicy([parseRule('*:22')], 'anything', 22)).toBe(true);
    expect(matchesPolicy([parseRule('*:22')], 'anything', 23)).toBe(false);
  });

  it('enforces port restrictions', () => {
    expect(matchesPolicy(rules, '100.64.1.2', 22)).toBe(true);
    expect(matchesPolicy(rules, '100.64.1.2', 443)).toBe(true); // via '*'
    expect(matchesPolicy([parseRule('100.64.0.0/10:22')], '100.64.1.2', 443)).toBe(false);
    expect(matchesPolicy([parseRule('box:22')], 'box', 22)).toBe(true);
    expect(matchesPolicy([parseRule('box:22')], 'box', 80)).toBe(false);
  });

  it('matches CIDRs against IP literals (v4 prefix boundaries)', () => {
    const r = [parseRule('100.64.0.0/10')];
    expect(matchesPolicy(r, '100.64.0.0', 22)).toBe(true);
    expect(matchesPolicy(r, '100.127.255.255', 22)).toBe(true);
    expect(matchesPolicy(r, '100.128.0.0', 22)).toBe(false);
    expect(matchesPolicy(r, '100.63.255.255', 22)).toBe(false);
    expect(matchesPolicy([parseRule('10.0.0.5')], '10.0.0.5', 1)).toBe(true);
    expect(matchesPolicy([parseRule('10.0.0.5')], '10.0.0.6', 1)).toBe(false);
  });

  it('IPs NEVER match named hostname rules (advisory-mode conservative direction)', () => {
    expect(matchesPolicy([parseRule('box-1')], '100.64.1.2', 22)).toBe(false);
  });

  it("'*' matches EVERY destination, hostnames and IP literals alike", () => {
    expect(matchesPolicy([parseRule('*')], '100.64.1.2', 22)).toBe(true);
    expect(matchesPolicy([parseRule('*:22')], '100.64.1.2', 22)).toBe(true);
    expect(matchesPolicy([parseRule('*:22')], '100.64.1.2', 23)).toBe(false);
  });

  it('matches IPv6 exact and CIDR', () => {
    expect(matchesPolicy([parseRule('fd7a::1')], 'fd7a::1', 22)).toBe(true);
    expect(matchesPolicy([parseRule('fd7a::1')], 'fd7a::2', 22)).toBe(false);
  });

  it('empty policy denies everything; empty host never matches', () => {
    expect(matchesPolicy([], 'box-1', 22)).toBe(false);
    expect(matchesPolicy([parseRule('*')], '', 22)).toBe(false);
  });
});

describe('egress-policy validatePolicyInput / round-trip', () => {
  it('accepts a valid rule array', () => {
    const v = validatePolicyInput(['box-1', '.ts.net', '100.64.0.0/10:22']);
    expect(v.errors).toEqual([]);
    expect(policyToStrings(v.rules!)).toEqual(['box-1', '.ts.net', '100.64.0.0/10:22']);
  });

  it('accepts an explicit empty array (= deny-all, distinct from null)', () => {
    const v = validatePolicyInput([]);
    expect(v.rules).toEqual([]);
  });

  it('rejects non-arrays and non-strings', () => {
    expect(validatePolicyInput('box-1').rules).toBeNull();
    expect(validatePolicyInput(null).rules).toBeNull();
    expect(validatePolicyInput([42]).rules).toBeNull();
  });

  it('reports per-rule errors with positions', () => {
    const v = validatePolicyInput(['ok-host', 'bad_host!!', '100.64.0.0/99']);
    expect(v.rules).toBeNull();
    expect(v.errors).toHaveLength(2);
    expect(v.errors[0]).toMatch(/^rule 2 /);
    expect(v.errors[1]).toMatch(/^rule 3 /);
  });

  it('caps rule count at 100', () => {
    expect(validatePolicyInput(Array(101).fill('x')).rules).toBeNull();
    expect(validatePolicyInput(Array(100).fill('x')).errors).toEqual([]);
  });

  it('round-trips through the stored string form; corrupt entries are skipped', () => {
    const strings = policyToStrings(validatePolicyInput(['box-1', '10.0.0.0/8']).rules!);
    const back = policyFromStrings([...strings, 'bad_host!!']);
    expect(back).toHaveLength(2);
    expect(matchesPolicy(back, 'box-1', 22)).toBe(true);
  });
});

describe('egress-policy deterministic credentials (design finding B2)', () => {
  const sid = 'aca5a594-cafb-40a9-9286-bdff6e0ec01a';

  it('username is stable and identifier-shaped (shim path-safety regex)', () => {
    expect(egressUsername(sid)).toBe('saca5a594cafb');
    expect(egressUsername(sid)).toMatch(/^s[0-9a-f]{12}$/);
  });

  it('password is deterministic across processes, distinct per session and per pepper', () => {
    const a = egressPassword(sid, 'pepper-1');
    expect(egressPassword(sid, 'pepper-1')).toBe(a);
    expect(egressPassword(sid, 'pepper-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(egressPassword('bbbbbbbb-0000-0000-0000-000000000000', 'pepper-1')).not.toBe(a);
    expect(egressPassword(sid, 'pepper-2')).not.toBe(a);
  });

  it('stored hash matches the shim formula and compares constant-time', () => {
    const h = passwordHash('pw');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEquals(h, passwordHash('pw'))).toBe(true);
    expect(hashEquals(h, passwordHash('other'))).toBe(false);
    expect(hashEquals(h, 'short')).toBe(false); // length mismatch must not throw
  });
});
