/**
 * Project-digest freshness (feedback f3256715 — dashboard "Project Progress"
 * cried wolf: a blocked, quiet project showed "updated 2d ago · stale / the
 * hourly digest pipeline may be behind" while the pipeline was healthy).
 *
 * Root cause: the stale badge keyed off `generatedAt`, which BY DESIGN only
 * advances when the digest CONTENT is rewritten (project-digest.service.ts's
 * signature-skip stamps stats.generatedAt solely on a content rewrite). A
 * quiet bucket whose inputs don't change keeps the same signature for days —
 * its summary text is honestly 2d old, but the sweep still TOUCHES the row
 * hourly (`updatedAt` moves), which is the pipeline-liveness signal.
 *
 * So: staleness = pipeline liveness = `updatedAt`. `generatedAt` remains the
 * honest "when this text was written" display timestamp. Fallback to
 * `generatedAt` covers deploy skew (an old backend row without updatedAt).
 */

/** updatedAt older than this → the hourly digest sweep is genuinely behind. */
export const DIGEST_STALE_MS = 2.5 * 60 * 60 * 1000;

export interface DigestFreshnessRow {
  /** Pipeline liveness: touched hourly even when the content is unchanged. */
  updatedAt?: string;
  /** Content age: only advances when the summary text is rewritten. */
  generatedAt?: string;
}

/** True when the digest PIPELINE is behind — never because the content is old. */
export function isDigestStale(digest: DigestFreshnessRow, nowMs: number = Date.now()): boolean {
  const stamp = digest.updatedAt ?? digest.generatedAt;
  if (!stamp) return false; // nothing to judge — don't cry wolf
  const at = new Date(stamp).getTime();
  if (Number.isNaN(at)) return false;
  return nowMs - at > DIGEST_STALE_MS;
}
