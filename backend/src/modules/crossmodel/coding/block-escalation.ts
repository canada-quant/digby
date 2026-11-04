/**
 * Open-ended block escalation (todo 27c215d6, framework audit 2026-10-15/16) —
 * the PURE leaf for a recurring schedule whose firings keep reporting the SAME
 * no-end-date blocker.
 *
 * WHY (baseline, VERIFIED on the One Piece TCG prod-watch): ~36 identical
 * no-op checks over 4 days against the suspended AWS account — every firing
 * re-derived "still blocked, nothing changed" and re-reported it at the full
 * cadence. PRODUCT_ALERT dedupe is (kind,subject) 24h, so an identical
 * finding re-fires daily forever; no streak counter, no escalation rung, no
 * cadence relief existed for a lane's OWN monitor (the stock-sweep backoff
 * only covers project-sweep prompts).
 *
 * BEHAVIOUR (all kill-switched, fail-open, NEVER auto-pauses — adoption-ladder
 * doctrine: "the harness never pauses a lane"; back the CADENCE off, never
 * stop the row):
 *   - at claim time (reconcileCadenceAtClaim, riding the SAME atomic claim
 *     write as the adaptive stretch), the chat's newest firing answers are
 *     fingerprinted; BLOCK_STREAK_TRIGGER consecutive near-identical
 *     blocked-no-end-date answers double the cadence (×2 per additional
 *     trigger), ceiling BLOCK_STREAK_MAX_INTERVAL_SEC (24 h). Never shrinks:
 *     a lane's own cadence has no harness-known default to reset to.
 *   - ONE owner question per schedule per 30 days, OPT-IN
 *     (BLOCK_STREAK_CARDS_ENABLED=1 — the STOPPED_SCHEDULE_CARDS observe-first
 *     pattern: the 2026-09-11 gate-flip doctrine ships sibling escalation
 *     cards dark until measured). Kill switch BLOCK_STREAK_BACKOFF_DISABLED=1
 *     reverts the whole leg (no backoff, no metric, no card).
 *
 * This module is DEPENDENCY-FREE (no prisma / redis / logger) so the fire path
 * and the tests share ONE set of semantics — the same contract as
 * schedule-cadence.ts. The token normalization + Jaccard similarity are the
 * attention-watchdog's proven primitives (STUCK_NOTE_SIMILARITY 0.85),
 * duplicated locally to keep this leaf import-free.
 */

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

// ── Kill switch + opt-in card ────────────────────────────────────────────────

/** Kill switch: BLOCK_STREAK_BACKOFF_DISABLED=1 reverts the whole leg (no backoff, no metric, no card). */
export function blockStreakBackoffDisabled(): boolean { return onFlag(process.env.BLOCK_STREAK_BACKOFF_DISABLED); }
/** Opt-in owner card (observe-first default): BLOCK_STREAK_CARDS_ENABLED=1 files the escalate-once question. */
export function blockStreakCardsEnabled(): boolean { return onFlag(process.env.BLOCK_STREAK_CARDS_ENABLED); }

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Consecutive near-identical blocked-no-end-date firing answers before the cadence doubles. */
export const BLOCK_STREAK_TRIGGER = 3;
/** Ceiling of the block-streak backoff (24 h — one check a day is enough for an open-ended blocker). */
export const BLOCK_STREAK_MAX_INTERVAL_SEC = 24 * 60 * 60;
/** Firing answers examined per claim (bounds the streak; 24 covers a day at the 24 h ceiling — review F6). */
export const BLOCK_STREAK_SCAN = 24;
/** Token-overlap (Jaccard) threshold for "near-identical" — the attention-watchdog's proven value. */
export const BLOCK_STREAK_SIMILARITY = 0.85;

// ── Detection lexicons (conservative by design — a healthy quiet monitor must NOT trip) ──

/**
 * The answer must name an EXPLICIT stall hold — a blocker OBJECT ("blocked
 * on/by X", "blocker", "on hold", "held by") or a blocked action ("cannot
 * deploy/proceed/provision", "unable to …"). Review F1 (2026-10-16): bare
 * state verbs (waiting for / awaiting / cannot / holding for / needs the
 * owner) are the ALL-CLEAR vocabulary too ("nothing needs the owner",
 * "awaiting CI", "cannot find anything to do") — under-detection is safe,
 * false escalation is the sin, so they stay OUT of the lexicon.
 */
const STRONG_BLOCKED_RE = /\b(blocked (?:on|by)|blocker\b|on hold\b|held by\b|cannot (?:proceed|deploy|provision|run|complete|continue)|unable to (?:deploy|provision|run|complete|continue))\b/i;
/**
 * A RESOLUTION marker — the note says the blocker LIFTED ("RESOLVED — the
 * suspension blocker is cleared"). A resolution answer can still contain the
 * word "blocker", so this escape runs before the strong match (review F1's
 * RESOLVED specimen).
 */
const RESOLVED_RE = /\b(resolved|cleared|unblocked|lifted|no longer (?:blocked|on hold)|recovered|succeeded)\b/i;
/**
 * An END-DATE / determinable-event marker — the answer names WHEN the block
 * lifts (infra blockers always carry expiresAt; "blocked until Friday" is a
 * dated hold). The todo scopes this to open-ended blockers: a dated hold has
 * its own clock and does not escalate here. MARKER WORDS ONLY — a bare date
 * is NOT an end date (a check's own "(2026-10-14)" timestamp would otherwise
 * read as a dated hold and scope every real re-report out).
 */
const HAS_END_DATE_RE = /\b(expir\w+|\beta\b|e\.t\.a|re-?opens?|tomorrow|tonight|eod|end of day|in \d+ (?:day|hour|minute|week)s?)\b/i;

/** True when one firing answer reads as "blocked on something, no end date in sight". Pure. */
export function isBlockedNoEndDateFinding(answer: string): boolean {
  const t = String(answer ?? '');
  if (!t.trim()) return false;
  if (RESOLVED_RE.test(t)) return false;
  if (HAS_END_DATE_RE.test(t)) return false;
  return STRONG_BLOCKED_RE.test(t);
}

// ── Normalization + similarity (attention-watchdog primitives, import-free) ──

/** Lowercase, ids/hex/digits and punctuation stripped — two re-reports differing only in ids/times compare equal. Pure. */
export function normalizeBlockTokens(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, ' ') // uuid/hash fragments before the digit strip
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard similarity on normalized token SETS. Pure. */
export function blockAnswerSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeBlockTokens(a));
  const tb = new Set(normalizeBlockTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

// ── Streak ───────────────────────────────────────────────────────────────────

/**
 * Consecutive near-identical blocked-no-end-date firing answers, counted from
 * the NEWEST. The newest answer must itself be a blocked finding (a resolved
 * lane never escalates); each older answer must also be a blocked finding AND
 * ≥ BLOCK_STREAK_SIMILARITY similar to the answer AFTER it (adjacent pairs —
 * the attention-watchdog's detectStuckNotes shape). Any healthy/noisy row
 * breaks the streak → under-detection, never false escalation. Pure.
 */
export function blockStreakCount(answersNewestFirst: string[]): number {
  if (!Array.isArray(answersNewestFirst) || answersNewestFirst.length === 0) return 0;
  const [newest, ...older] = answersNewestFirst;
  if (!isBlockedNoEndDateFinding(newest)) return 0;
  let streak = 1;
  let prev = newest;
  for (const a of older) {
    if (!isBlockedNoEndDateFinding(a)) break;
    if (blockAnswerSimilarity(prev, a) < BLOCK_STREAK_SIMILARITY) break;
    streak += 1;
    prev = a;
  }
  return streak;
}

// ── Backoff verdict ──────────────────────────────────────────────────────────

export type BlockStreakBackoff = { kind: 'backoff'; fromSec: number; toSec: number; streak: number };

/**
 * Cadence verdict for a stuck monitor at claim time: doubles per additional
 * BLOCK_STREAK_TRIGGER streak (3 → ×2, 6 → ×4, …) up to
 * BLOCK_STREAK_MAX_INTERVAL_SEC. No reset leg — a lane's own cadence has no
 * harness-known default to restore, and the adaptive-stretch doctrine already
 * says the harness never shrinks a cadence it touched. Pure.
 */
export function blockStreakBackoffFor(input: { intervalSec: number; streak: number }): BlockStreakBackoff | null {
  const cur = Math.round(input.intervalSec);
  if (!Number.isFinite(cur) || cur <= 0) return null;
  const doublings = Math.floor(input.streak / BLOCK_STREAK_TRIGGER);
  if (doublings <= 0) return null;
  const target = Math.min(cur * 2 ** doublings, BLOCK_STREAK_MAX_INTERVAL_SEC);
  return target > cur ? { kind: 'backoff', fromSec: cur, toSec: target, streak: input.streak } : null;
}

// ── Merge with the adaptive stretch ──────────────────────────────────────────

export interface CadenceIntervalCandidate { toSec: number }

/**
 * Both cadence verdicts lengthen the row; when they co-fire, the LARGER target
 * lands (the safe merge — the lane needs the greater relief). ONLY the
 * winner's verdict records telemetry — the loser is skipped entirely (never
 * shrunk, never re-reported); the written intervalSec is always the winner's.
 * Pure.
 */
export function mergeCadenceInterval(
  stretch: CadenceIntervalCandidate | null | undefined,
  blockBackoff: CadenceIntervalCandidate | null | undefined,
): CadenceIntervalCandidate | null {
  if (!stretch && !blockBackoff) return null;
  if (!stretch) return blockBackoff!;
  if (!blockBackoff) return stretch;
  return blockBackoff.toSec > stretch.toSec ? blockBackoff : stretch;
}

// ── [SCHEDULE STATE] line ────────────────────────────────────────────────────

/** The in-context line a backed-off stuck monitor sees on its next firing. Pure. */
export function blockStreakStateLine(b: BlockStreakBackoff): string {
  return `cadence stretched ${Math.round(b.fromSec / 60)}→${Math.round(b.toSec / 60)} min by the harness: the last ${b.streak} firings reported the SAME unresolved blocker with no end date — one check a day is enough for an open-ended block; escalate it (owner question / ticket) instead of re-reporting it`;
}
