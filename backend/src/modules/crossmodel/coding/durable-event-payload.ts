/**
 * The payload a run event keeps OUTSIDE the live fan-out — the durable
 * agent_events log (run-executor's tap, 30-day retention) and the plain-chat
 * cross-instance Redis mirror (run-event-mirror, 500 entries × 2 h).
 *
 * Generated images (generate_image, 2026-09-24 review): the live `image`
 * event carries base64 `data` (0.7–1.7 MB for a 1024² PNG) so the attached
 * viewer renders instantly, PLUS the lazy `url` / `fileId` the persisted part
 * keeps. The bytes already live in generated_files, so the durable copies
 * drop `data` — a replay (attach, cross-instance tail, reload) renders from
 * `url` exactly like the persisted transcript part. Screenshots
 * (source 'browser' / 'computer') have no url at emit time and keep their
 * inline bytes, unchanged. A pure leaf — no imports.
 */

/** True for an `image` event whose bytes are recoverable from its lazy url. */
export function isUrlBackedGeneratedImage(type: string, data: any): boolean {
  return type === 'image'
    && !!data && typeof data === 'object'
    && data.source === 'generated'
    && typeof data.url === 'string' && data.url.length > 0;
}

/**
 * Slim `context` events in the durable copy (audit 2026-10-06 T9-3). The agent loop emits one `context` per turn
 * whose `sessionUsage` carries `seenRuns` — the usage store's idempotency ledger of up to 50 run ids (≈ 1.9 KB of a
 * ≈ 2.9 KB row on a mature lane), re-written every turn. No client reads it (the web meter reads the totals + `agents`
 * only; mobile ignores `context`), and a coding run's live viewer tails THIS durable copy from Postgres, so everything
 * the meter reads — `usage`, `sessionUsage` totals and both per-agent arrays — is kept. Kill switch
 * AGENT_EVENTS_CONTEXT_SLIM_DISABLED=1 persists the live payload byte-for-byte (read per call).
 */
export function contextSlimDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.AGENT_EVENTS_CONTEXT_SLIM_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** True for a `context` event whose sessionUsage carries the never-read `seenRuns` ledger. */
export function hasContextSeenRuns(type: string, data: any): boolean {
  return type === 'context'
    && !!data && typeof data === 'object'
    && !!data.sessionUsage && typeof data.sessionUsage === 'object'
    && Array.isArray(data.sessionUsage.seenRuns);
}

/** The event data to persist / mirror: identical to the live payload except that a url-backed generated image loses its base64 and a `context` event loses `sessionUsage.seenRuns`. */
export function durableEventData<T>(type: string, data: T): T {
  if (hasContextSeenRuns(type, data) && !contextSlimDisabled()) {
    const { seenRuns: _ledger, ...sessionUsage } = (data as any).sessionUsage;
    return { ...(data as any), sessionUsage } as T;
  }
  if (!isUrlBackedGeneratedImage(type, data)) return data;
  const { data: _bytes, ...rest } = data as any;
  return rest as T;
}
