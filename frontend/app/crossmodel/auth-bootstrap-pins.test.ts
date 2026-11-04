/**
 * 2026-10-09 Windows-shell hang fix — /crossmodel auth bootstrap pins.
 *
 * Owner report: shell opens, spins forever. The web-side seam: a transient
 * /auth/me failure failed SOFT (keep the token, console.warn, render the
 * ANONYMOUS home — whose hero is a perpetually-spinning digbyspin.gif) with
 * no retry and no visible error. A signed-in user opening the app on a
 * resumed-from-sleep laptop / wedged proxy saw a signed-out-looking app
 * forever.
 *
 * page.tsx is a 5000-line client component with 40+ effects — a full render
 * is infeasible in node-env vitest (the repo's own c1-convergence-smoke
 * convention: SOURCE-LEVEL pins for mount/wiring, readFileSync + toContain,
 * anchored on stable identifiers, never line numbers).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PAGE = readFileSync(
  fileURLToPath(new URL('./page.tsx', import.meta.url)),
  'utf8',
);

describe('auth bootstrap (2026-10-09 hang fix)', () => {
  it('a non-auth /auth/me failure retries a bounded number of times before surfacing', () => {
    // 3 retries, 2s apart — bounded, not a silent one-shot fail-soft.
    expect(PAGE).toContain('authBootRetriedRef.current < 3');
    expect(PAGE).toContain('setTimeout(() => runAuthBootstrap(), 2000)');
  });

  it('a persisted non-auth failure sets a VISIBLE error state (never the silent anonymous look)', () => {
    expect(PAGE).toContain('setAuthBootFailed(true)');
    expect(PAGE).toContain('authBootFailed && (');
  });

  it('the banner says the session is saved and offers Retry', () => {
    expect(PAGE).toContain("Couldn&apos;t reach Digby — your session is saved");
    expect(PAGE).toContain('authBootRetriedRef.current = 0; runAuthBootstrap();');
  });

  it('a SUCCESS clears the error state (a later retry landing resets the banner)', () => {
    expect(PAGE).toContain('setAuthBootFailed(false)');
  });

  it('the definitive-401 contract is untouched (session expiry still signs out honestly)', () => {
    // 05303f58: only a surviving 401 ends the session — the toast + token
    // removal path must still exist verbatim.
    expect(PAGE).toContain("'Your session expired. Please sign back in.'");
    expect(PAGE).toContain('localStorage.removeItem(\'accessToken\')');
    expect(PAGE).toContain('isDefinitiveAuthFailure(err)');
  });
});
