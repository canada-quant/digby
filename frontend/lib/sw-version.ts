/**
 * Service-worker version rules for the silent auto-reload (UpdateNotification).
 *
 * Owner recording 2026-10-07 ("weird macOS keeps refreshing bug"): during a
 * blue-green rollout the ALB serves /sw.js from the new box AND the old box.
 * The updater reloaded whenever the incoming worker's version merely DIFFERED
 * from the stored one and then stored whatever it saw — so v404 ↔ v405
 * ping-ponged: every page load fetched the other box's sw.js, saw a
 * "different" version and reloaded ~1 s later (the page flashed the guest home
 * before /auth/me answered, every ~2.5 s, for the whole rollout).
 *
 * Rules: reload only for a STRICTLY NEWER version, never store a lower one,
 * and never auto-reload twice within SW_RELOAD_MIN_GAP_MS.
 */

export const SW_VERSION_KEY = 'digby_sw_version';
export const SW_RELOAD_AT_KEY = 'digby_sw_reload_at';
/** Two automatic update reloads closer than this are a loop — the second is skipped. */
export const SW_RELOAD_MIN_GAP_MS = 120_000;

/** 'digby-v405' → 405; anything unparseable → null. */
export function parseSwVersion(v: string | null | undefined): number | null {
  const m = /^digby-v(\d+)$/.exec((v ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** The version to remember: the higher of the two — a stale box's older sw.js never lowers it. */
export function versionToStore(lastKnown: string | null, incoming: string): string {
  const a = parseSwVersion(lastKnown);
  const b = parseSwVersion(incoming);
  if (b === null) return lastKnown ?? incoming;
  if (a === null) return incoming;
  return b > a ? incoming : (lastKnown as string);
}

/**
 * Reload for `incoming`? Only when it is strictly newer than what this browser
 * last ran, the page is not mid-reload ('reloading' sentinel), and no automatic
 * update reload happened in the last SW_RELOAD_MIN_GAP_MS.
 */
export function shouldReloadForSwVersion(args: {
  lastKnown: string | null;
  incoming: string;
  lastReloadAt: number | null;
  now: number;
}): boolean {
  const { lastKnown, incoming, lastReloadAt, now } = args;
  if (!lastKnown || lastKnown === 'reloading') return false;
  const a = parseSwVersion(lastKnown);
  const b = parseSwVersion(incoming);
  if (a === null || b === null || b <= a) return false;
  if (lastReloadAt !== null && Number.isFinite(lastReloadAt) && now - lastReloadAt < SW_RELOAD_MIN_GAP_MS) return false;
  return true;
}
