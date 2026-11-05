/**
 * utils/redact-credentials (backlog audit T7, 2026-09-28) — the URL-userinfo
 * mask that keeps a git argv echo (`https://x-access-token:<token>@…`) out of
 * app_error_logs. FAKE tokens only.
 */
import {
  redactUrlCredentials,
  redactUrlCredentialsDeep,
  redactGitError,
  hasUrlCredentials,
  CREDENTIAL_MASK,
} from './redact-credentials';

const FAKE_GHO = 'gho_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake1234';
const AUTHED = `https://x-access-token:${FAKE_GHO}@github.com/example-org/repo`;
const GIT_MSG = `Command failed: git remote set-url origin ${AUTHED}\nerror: No such remote 'origin'`;

describe('redactUrlCredentials', () => {
  it('masks x-access-token userinfo in a URL and keeps the host + path', () => {
    const out = redactUrlCredentials(GIT_MSG);
    expect(out).not.toContain(FAKE_GHO);
    expect(out).toContain(`https://${CREDENTIAL_MASK}@github.com/example-org/repo`);
    expect(out).toContain("error: No such remote 'origin'");
  });

  it('masks user:pass and bare-token userinfo shapes', () => {
    expect(redactUrlCredentials('fatal: unable to access https://alice:s3cretPW@example.com/x')).toBe('fatal: unable to access https://***@example.com/x');
    expect(redactUrlCredentials(`push to https://${FAKE_GHO}@github.com/a/b`)).toBe('push to https://***@github.com/a/b');
    expect(redactUrlCredentials(`x-access-token:${FAKE_GHO}@github.com`)).toBe('x-access-token:***@github.com');
    expect(redactUrlCredentials(`oauth2:${FAKE_GHO}@gitlab.com`)).toBe('oauth2:***@gitlab.com');
  });

  // d6110694: a bare GitHub token OUTSIDE any URL (git argv echo / stderr
  // prose — `remote set-url origin ghp_…`) must not survive either.
  it('masks bare gho_/ghp_/ghs_/ghu_/ghr_/github_pat_ tokens anywhere in text', () => {
    const body = 'FAKEfakeFAKEfakeFAKEfakeFAKEfake1234';
    for (const p of ['gho', 'ghp', 'ghs', 'ghu', 'ghr']) {
      const t = `${p}_${body}`;
      expect(redactUrlCredentials(`argv echo: ${t}`)).toBe(`argv echo: ${p}_***`);
      expect(hasUrlCredentials(`argv echo: ${t}`)).toBe(true);
    }
    const pat = `github_pat_${body}`;
    expect(redactUrlCredentials(`fine-grained: ${pat}`)).toBe('fine-grained: github_pat_***');
  });

  it('token masking is idempotent and leaves token-shaped false positives (shas, short bodies) alone', () => {
    const once = redactUrlCredentials(`token ghp_${'FAKEfakeFAKEfakeFAKEfake1234'}`);
    expect(once).toBe('token ghp_***');
    expect(redactUrlCredentials(once)).toBe(once);
    expect(hasUrlCredentials(once)).toBe(false);
    // A 40-hex sha has no prefix; an 8-char body is under the ≥8 … wait —
    // {8,} means 8+ IS matched; use 7 for the floor probe.
    expect(redactUrlCredentials('commit abc1234_')).toBe('commit abc1234_');
    expect(redactUrlCredentials('sha 1234567890abcdef1234567890abcdef12345678')).toBe('sha 1234567890abcdef1234567890abcdef12345678');
    // not_ a token prefix.
    expect(redactUrlCredentials('ref gha_shortbody123456')).toBe('ref gha_shortbody123456');
  });

  it('leaves credential-free text byte-for-byte (incl. emails and plain URLs)', () => {
    for (const s of ['https://github.com/a/b.git', 'mail paul@example.com about it', 'git@github.com:a/b.git', '', 'no urls here']) {
      expect(redactUrlCredentials(s)).toBe(s);
      expect(hasUrlCredentials(s)).toBe(false);
    }
  });

  it('is idempotent — the mask itself is never read as a credential', () => {
    const once = redactUrlCredentials(GIT_MSG);
    expect(hasUrlCredentials(once)).toBe(false);
    expect(redactUrlCredentials(once)).toBe(once);
    expect(hasUrlCredentials('x-access-token:***@github.com')).toBe(false);
  });

  it('stringifies non-strings and never throws', () => {
    expect(redactUrlCredentials(null)).toBe('');
    expect(redactUrlCredentials(undefined)).toBe('');
    expect(redactUrlCredentials(42)).toBe('42');
  });
});

describe('redactUrlCredentialsDeep', () => {
  it('walks string leaves of objects / arrays; untouched input returns by identity', () => {
    const clean = { a: 'x', b: ['y', { c: 'z' }] };
    expect(redactUrlCredentialsDeep(clean)).toBe(clean);
    const dirty = { msg: GIT_MSG, nested: [{ url: AUTHED }], n: 1, d: new Date(0) };
    const out = redactUrlCredentialsDeep(dirty);
    expect(out).not.toBe(dirty);
    expect(JSON.stringify(out)).not.toContain(FAKE_GHO);
    expect(out.n).toBe(1);
    expect(out.d).toBe(dirty.d); // class instances pass through
    expect(dirty.msg).toContain(FAKE_GHO); // input not mutated
  });
});

describe('redactGitError', () => {
  const makeErr = () => {
    const err: any = new Error(GIT_MSG);
    err.code = 128;
    err.killed = false;
    err.cmd = `git remote set-url origin ${AUTHED}`;
    err.stderr = `fatal: could not read from ${AUTHED}`;
    err.stdout = '';
    return err;
  };

  it('scrubs message / stack / cmd / stderr in place and keeps code + identity', () => {
    const err = makeErr();
    const out = redactGitError(err);
    expect(out).toBe(err);
    expect(err.message).not.toContain(FAKE_GHO);
    expect(err.message).toContain("No such remote 'origin'");
    expect(err.stack).not.toContain(FAKE_GHO);
    expect(err.cmd).not.toContain(FAKE_GHO);
    expect(err.stderr).not.toContain(FAKE_GHO);
    expect(err.code).toBe(128);
    expect(err.killed).toBe(false);
    expect(err instanceof Error).toBe(true);
  });

  it('passes non-objects and clean errors through untouched', () => {
    expect(redactGitError(null)).toBeNull();
    expect(redactGitError('str')).toBe('str');
    const clean = new Error('plain failure');
    expect(redactGitError(clean).message).toBe('plain failure');
  });
});
