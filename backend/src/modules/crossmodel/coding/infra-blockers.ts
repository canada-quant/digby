/**
 * infra-blockers.ts — the fleet-wide INFRA-BLOCKER registry's pure leaf
 * (feedback 2b45941b).
 *
 * The failure (observed 2026-09-18 ~05:45Z, prod disk-full deploy blocker
 * 09d84d7d): backstop schedules carrying merge→deploy→evidence-close runbooks
 * were armed BEFORE the fleet-wide blocker emerged, so their stored prompts
 * still ordered the lane to trigger and watch a deploy. One lane had been
 * individually steered disk-aware; a second live backstop had not, and would
 * have fired a deploy into the same wall (wasted failed Actions cycle + alert
 * noise). Patching backstop-by-backstop with per-lane steers does not scale.
 *
 * The contract: a small fleet-wide REGISTRY (Redis hash — see
 * infra-blockers.service.ts) holds the active infrastructure blockers; at FIRE
 * time the machine-wake seams (fireScheduleTarget AND queueContinuationRun —
 * the same two seams the terminal-stop contract decorates) append an advisory
 * [FLEET INFRA BLOCKER] block to any firing whose prompt looks like a
 * deploy/merge/publish runbook. ADVISORY ONLY — never a skip: a preflight
 * skip would silence lanes whose deploy target is not the blocked surface
 * (and the watch's other open criteria must still run — same doctrine as
 * terminal-stop). Fail-open: a registry hiccup never drops or delays a firing.
 *
 * Pure leaf (no imports) so it is unit-testable without the prisma/redis
 * graph — the store wiring lives in infra-blockers.service.ts. Same
 * discipline as terminal-stop.ts / agent-send-header.ts / machine-wake.ts.
 */

/** Position-0 literal the injected block starts with. */
export const INFRA_BLOCKER_NOTICE_PREFIX = '[FLEET INFRA BLOCKER';

/** Most blockers listed in one notice (overflow is counted, not named). */
export const MAX_LISTED_BLOCKERS = 5;

/** Default registry-entry lifetime: an incident is hours, sometimes a day. A
 *  blocker nobody clears must not annotate forever — re-register if it
 *  genuinely outlives the TTL. */
export const DEFAULT_BLOCKER_TTL_HOURS = 24;
/** Hard cap on caller-supplied TTLs (7 days). */
export const MAX_BLOCKER_TTL_HOURS = 24 * 7;

const LABEL_MAX = 120;
/** The rendered scope IS the hold boundary (b8028af7) — never clip it below
 *  what registration accepts (infra-blockers.service.ts slices detail to 500):
 *  a surface named past the cut degrades to "cannot tell" ⇒ fail-closed
 *  blanket hold, the over-hold this fix exists to prevent. */
const DETAIL_MAX = 500;

/** One fleet-wide infrastructure blocker (one incident = one entry). */
export interface InfraBlocker {
  /** Stable id ('ib_' + 8 hex when minted by the service). */
  id: string;
  /** One-line incident name, e.g. 'prod worker-box disk full (ticket 09d84d7d)'. */
  label: string;
  /** What is blocked + how to re-verify, e.g. 'every deploy aborts pre-build; re-check the latest Deploy to AWS EC2 run'. */
  detail?: string | null;
  /** ISO registration time. */
  registeredAt: string;
  /** Who registered it (chat id / 'ops' / ...), for attribution. */
  registeredBy?: string | null;
  /** ISO auto-expiry; null = expires at DEFAULT_BLOCKER_TTL_HOURS from registeredAt (the service always stamps one). */
  expiresAt?: string | null;
}

/**
 * Does this firing's prompt read like a deploy/merge/publish runbook? The
 * annotation is gated on this so unrelated firings (nightly digests, probe
 * watches, goal sweeps) never carry the block. Inclusive on purpose: a false
 * positive costs one advisory paragraph; a false negative recreates the
 * 2026-09-18 incident (a deploy-wait backstop firing blind into the wall).
 * Deliberately NOT matching the bare word 'build' (too common in feature
 * runbooks) — deploy runbooks all name deploy/merge/publish/release/dmg or
 * the Actions deploy pipeline itself.
 */
const DEPLOY_RUNBOOK_RE = /\b(deploys?|deployment|re-?deploy|merge[- ]?to[- ]?main|merging|merges?\b.{0,24}\bmain\b|publishe?s?|publishing|releases?|releasing|notari[sz]|dmg\b|ship(?:s|ping)?\b|rollbacks?|evidence-close|post-deploy|deploy-verify|gh\s+run|actions\s+run|workflow\s+run|blue[- ]?green)/i;

export function isDeployRunbookPrompt(prompt: string): boolean {
  if (typeof prompt !== 'string' || !prompt) return false;
  return DEPLOY_RUNBOOK_RE.test(prompt);
}

/** True when the entry's expiry is at/before `now` (malformed expiry = treat
 *  as expired — a corrupt row must not annotate forever). */
export function blockerExpired(b: InfraBlocker, now: Date): boolean {
  if (!b.expiresAt) return false;
  const t = new Date(b.expiresAt).getTime();
  if (Number.isNaN(t)) return true;
  return t <= now.getTime();
}

/** One-line, bracket-safe rendering (titles/details are agent-authored —
 *  inner ']'/newlines would corrupt the bracketed block). */
function safe(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\r\n\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isoOrUnknown(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString();
}

/**
 * Render the [FLEET INFRA BLOCKER] block for the fire-time seams. Deterministic
 * text: name each active blocker's registered SCOPE as the hold matcher, order
 * the lane to re-verify with a FRESH probe only the blockers whose scope its
 * step touches, and hold (not fire into the wall) only the steps that touch a
 * still-active blocker's surface. The blanket hold survives as the FAIL-CLOSED
 * fallback: a blocker with no usable scope, or one the lane cannot tell
 * whether its step touches, holds the whole deploy/merge/publish class — a
 * lane must never guess "not me" into a wall (feedback b8028af7: the previous
 * blanket sentence held CI-green merges under a box-only seal). Advisory by
 * design — the block itself says so, so a lane never reads it as a skip
 * directive (its other open criteria still run).
 */
export function buildInfraBlockerNotice(blockers: InfraBlocker[], now: Date): string {
  const listed = blockers.slice(0, MAX_LISTED_BLOCKERS);
  const items = listed.map((b) => {
    const label = safe(b.label, LABEL_MAX);
    const detail = safe(b.detail, DETAIL_MAX);
    const bits: string[] = [`HOLD steps matching: ${label || b.id}`];
    if (detail) bits.push(`scope: ${detail}`);
    bits.push(`id ${b.id}`);
    bits.push(`registered ${isoOrUnknown(b.registeredAt)}${b.registeredBy ? ` by ${safe(b.registeredBy, 40)}` : ''}`);
    bits.push(`auto-expires ${isoOrUnknown(b.expiresAt)}`);
    return `- ${bits.join(' · ')}`;
  });
  const more = blockers.length > listed.length ? `\n- …and ${blockers.length - listed.length} more (list_infra_blockers shows all)` : '';
  return (
    `${INFRA_BLOCKER_NOTICE_PREFIX} ACTIVE — harness-checked at fire time ${now.toISOString()}] ` +
    `${blockers.length} fleet-wide infrastructure blocker${blockers.length === 1 ? '' : 's'} registered:\n` +
    items.join('\n') + more + `\n` +
    `Each blocker's registered scope above is the HOLD boundary. Before a deploy / merge-to-main / publish / release-build step this firing, check the step's surface against every blocker's scope, and re-verify with a FRESH probe (the surface its scope names, or list_infra_blockers for the live registry) only the blockers whose scope that surface touches. ` +
    `A blocker still active on a surface your step touches: HOLD that step — do not fire work into the wall — and report the hold. ` +
    `A blocker whose scope does NOT name your step's surface does not hold that step: proceed and say so. ` +
    `Fallback (fail-closed): a blocker with no usable scope above, or one where you cannot tell whether your step touches its surface — treat it as blocking the whole deploy/merge/publish class and HOLD under it, reporting the uncertainty. ` +
    `Advisory only, never a skip: your other open criteria still run. ` +
    `(Entries auto-expire; a cleared-but-still-listed blocker is cleared by the Fleet Supervisor — report staleness, do not re-register duplicates.)`
  );
}
