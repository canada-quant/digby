/**
 * Ticket 05303f58 (BUG 1) — isDefinitiveAuthFailure gates the token-delete +
 * /login bounce on a REAL session expiry. The api client's response
 * interceptor already runs 401 → refresh → retry, so a rejection reaching a
 * page is either a surviving 401 (refresh genuinely failed — session over) or
 * a non-auth failure (network drop, 5xx, aborted request) where the token must
 * be KEPT and the page fails soft. The catch-all pages used to bounce signed-in
 * users to /login over a transient blip.
 */

import { describe, expect, it } from 'vitest';
import { isDefinitiveAuthFailure } from './api-client';

describe('isDefinitiveAuthFailure (05303f58)', () => {
  it('a surviving 401 (refresh already failed) IS a definitive auth failure', () => {
    expect(isDefinitiveAuthFailure({ response: { status: 401 } })).toBe(true);
  });

  it('a 5xx server error is NOT — keep the token, fail soft', () => {
    expect(isDefinitiveAuthFailure({ response: { status: 500 } })).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { status: 502 } })).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { status: 503 } })).toBe(false);
  });

  it('a non-401 4xx is NOT an expired session', () => {
    expect(isDefinitiveAuthFailure({ response: { status: 403 } })).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { status: 404 } })).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { status: 409 } })).toBe(false);
  });

  it('a network error (no response at all) is NOT — the blip that bounced users', () => {
    expect(isDefinitiveAuthFailure(new Error('Network Error'))).toBe(false);
    expect(isDefinitiveAuthFailure({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' })).toBe(false);
    expect(isDefinitiveAuthFailure({ request: {}, message: 'Network Error' })).toBe(false);
  });

  it('null/undefined/garbage rejections are NOT', () => {
    expect(isDefinitiveAuthFailure(null)).toBe(false);
    expect(isDefinitiveAuthFailure(undefined)).toBe(false);
    expect(isDefinitiveAuthFailure('unauthorized')).toBe(false);
    expect(isDefinitiveAuthFailure({})).toBe(false);
    expect(isDefinitiveAuthFailure({ response: {} })).toBe(false);
  });
});
