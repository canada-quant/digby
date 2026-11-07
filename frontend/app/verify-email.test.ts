/**
 * /verify-email page pin (Phase 2 Cloud, todo ea95fa0b item 3).
 *
 * The gap this closes: email-verification.service.ts has minted
 * `<publicUrl>/verify-email?token=…` since the leg-1 merge, but the frontend had
 * NO such route — every verification email we sent delivered the user to a 404.
 * The token machinery was complete and unreachable.
 *
 * What is pinned (source pins — the page is a client component and this suite
 * does not mount it):
 *  - the route file exists where Next will serve /verify-email;
 *  - it reads `token` from the query string and POSTs it to the API;
 *  - the POST is guarded by a ref keyed on the token, because the token is
 *    SINGLE-USE: a re-render or React's dev double-invoke would otherwise
 *    consume it twice and report "already used" on the link that just worked;
 *  - the server's own refusal text is surfaced rather than replaced, since
 *    invalid / used / expired imply different next steps;
 *  - useSearchParams sits inside a Suspense boundary (App Router requirement);
 *  - the API client exposes both verification calls, and resend reports
 *    `mailed: false` honestly instead of claiming an email arrived.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const readSrc = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

const PAGE_PATH = join(__dirname, 'verify-email/page.tsx');
const PAGE = readSrc('./verify-email/page.tsx');
const AUTH = readSrc('../lib/auth.ts');

describe('/verify-email route exists', () => {
  it('has a page component at app/verify-email/page.tsx', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
    expect(PAGE).toContain('export default function VerifyEmailPage');
  });

  it('wraps useSearchParams in Suspense (App Router requirement)', () => {
    expect(PAGE).toContain("from 'react'");
    expect(PAGE).toMatch(/<Suspense[\s\S]*?<VerifyEmailInner/);
    expect(PAGE).toMatch(/searchParams\.get\('token'\)/);
  });
});

describe('the emailed token is actually consumed — exactly once', () => {
  it('POSTs the token through the API client', () => {
    expect(PAGE).toContain('authApi.verifyEmail(token)');
    expect(AUTH).toMatch(/async verifyEmail\(token: string\)/);
    expect(AUTH).toContain("post('/auth/verify-email'");
  });

  it('guards against a second attempt on the same single-use token', () => {
    // A useEffect without this guard burns the token, then reports "already
    // used" on a link that had just succeeded. The guard caches the in-flight
    // PROMISE rather than a "did I start" flag: under reactStrictMode the effect
    // runs mount→unmount→mount, and a flag would leave the UI stuck on
    // "Verifying…" forever with no error (review finding, 2026-11-06).
    expect(PAGE).toMatch(/attempt\s*=\s*useRef<\{\s*token: string; promise:/);
    expect(PAGE).toMatch(/if \(attempt\.current\?\.token !== token\)/);
    expect(PAGE).toMatch(/attempt\.current = \{ token, promise: authApi\.verifyEmail\(token\) \}/);
    // The remount consumes the SAME promise, so it renders the real outcome.
    expect(PAGE).toMatch(/const promise = attempt\.current\.promise;/);
  });

  it('reports a missing token as an error instead of calling with an empty string', () => {
    expect(PAGE).toMatch(/if \(!token\)[\s\S]{0,200}missing/i);
  });
});

describe('failure copy is the server\u2019s, not invented', () => {
  it('prefers the API error body over a generic message', () => {
    expect(PAGE).toMatch(/error\?\.response\?\.data\?\.error/);
  });

  it('offers resend and reports mailed:false honestly (SMTP down / signed out)', () => {
    expect(PAGE).toContain('authApi.resendVerification()');
    expect(PAGE).toMatch(/resent\.mailed/);
    expect(AUTH).toContain("post('/auth/resend-verification'");
    expect(AUTH).toMatch(/mailed: boolean/);
    // A 401 means "sign in first" — not a generic failure.
    expect(PAGE).toMatch(/status === 401/);
  });
});