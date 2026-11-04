/**
 * 2026-10-09 Windows-shell hang fix — the api client's default timeout.
 *
 * Owner report: the Windows shell (a WebView2 host around /crossmodel) "just
 * spins forever" after install+login. Root cause class on the web side: axios
 * has NO default timeout, so a request whose connection is established but
 * whose response never arrives NEVER rejects — every startup fetch that clears
 * its loading state in .then/.finally (sidebar chats skeleton, folders
 * skeleton, news spinner, /auth/me gate) hung forever when the backend or the
 * Next proxy stalled. This suite pins the seam at the source level:
 *
 *   • the shared axios instance is created WITH a finite `timeout`
 *   • the raw axios refresh POST (the one call that bypassed the instance
 *     default) carries its own explicit timeout
 *   • the 401→refresh interceptor still runs after the change (the pre-existing
 *     contract from 05303f58 / loop #19 is untouched)
 *
 * The axios.create idiom here is the repo's source-pin convention for code that
 * needs a browser (localStorage) to import cleanly (same class as the windows
 * feed pins: the C# shell pins live in app/windows-feed-pins.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SRC = readFileSync(
  fileURLToPath(new URL('./api-client.ts', import.meta.url)),
  'utf8',
);

describe('api client default timeout (2026-10-09 hang fix)', () => {
  it('the shared instance is created with a finite timeout (never an unbounded request)', () => {
    // axios.create({...}) must include `timeout:` — the whole fix. A request
    // that hangs at the TCP layer now rejects with ECONNABORTED after the
    // bound instead of pending forever.
    const createBlock = SRC.match(/axios\.create\(\{[\s\S]*?\}\)/);
    expect(createBlock).not.toBeNull();
    expect(createBlock![0]).toMatch(/timeout:\s*API_TIMEOUT_MS/);
  });

  it('the timeout constant is exported and generous (≥ 30s — bounded, not racing healthy requests)', () => {
    // 45_000 is a numeric separator, not digits — strip them before parsing.
    const m = SRC.match(/export const API_TIMEOUT_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    expect(ms).toBeGreaterThanOrEqual(30_000);
    expect(ms).toBeLessThanOrEqual(120_000);
  });

  it('the raw refresh POST carries its own explicit timeout (it bypasses the instance default)', () => {
    // The 401 interceptor posts /auth/refresh with a BARE axios import — that
    // call never saw the instance timeout. Pin that it has one now.
    const refreshCall = SRC.match(/axios\.post\(\s*'\/api\/auth\/refresh'[\s\S]*?\)\;/);
    expect(refreshCall).not.toBeNull();
    expect(refreshCall![0]).toMatch(/timeout:\s*15_000/);
  });

  it('the isDefinitiveAuthFailure contract is untouched (a timeout is NOT a session expiry)', () => {
    // 05303f58: only a surviving 401 ends the session. A timeout rejection
    // (ECONNABORTED, no response) must keep failing soft — the predicate must
    // still key on response.status === 401 only.
    expect(SRC).toMatch(
      /export function isDefinitiveAuthFailure\(err: unknown\): boolean \{\s*return \(err as \{ response\?: \{ status\?: number \} \} \| null\)\?\.response\?\.status === 401;\s*\}/,
    );
  });
});
