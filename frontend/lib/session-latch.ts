/**
 * Session-dead latch (autonomy loop #19, 2026-09-21). When the api client's
 * 401 → refresh dance fails DEFINITIVELY (the refresh itself answered 401/403:
 * the refresh token is gone), every poller in the app kept firing on its
 * interval with a token that could never work — one tab re-presented a
 * six-day-old token every ~38 s for hours. usePolling reads this latch and
 * skips scheduled ticks while the session is dead; the first authenticated
 * success (a new login, a manual action) clears it.
 */
let dead = false;

export function markSessionDead(): void { dead = true; }
export function markSessionAlive(): void { dead = false; }
export function isSessionDead(): boolean { return dead; }
/** Test seam. */
export function __resetSessionLatchForTest(): void { dead = false; }
