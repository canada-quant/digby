/**
 * Per-fingerprint ADJUDICATION SUPPRESSION for the log-signal sweep
 * (ticket 0ef6794e, 2026-10-26) — the evidence-gated cousin of the
 * adjudicated-class absorption at the INSERT path (feedback.service,
 * tickets be06c812/6df5fc61), lifted to the FILING decision itself.
 *
 * PROBLEM (observed by the filing lane, 2026-10-26T02:11Z): the sweep
 * dedupes only one-ticket-per-fingerprint-per-ISO-week, and feedback's
 * insert path absorbs a same-type filing onto a closed ADJUDICATED row
 * (occurrences/sightings trail, no status flip, no dispatch). That
 * absorption already stops the REOPEN — but the sweep still files every
 * week, the weekly BUMP still counts as "actionable" and wakes the
 * Fleet Supervisor, and once the 90-day exact-title dedup window rolls
 * past the last closed row a NEW dispatchable row files. Adjudicating a
 * class "designed" once per week, for as long as the owner-side
 * condition persists, is re-litigation, not triage.
 *
 * THIS LEAF answers ONE question, pure, before the sweep spends any
 * filing budget: has THIS fingerprint's class been adjudicated designed
 * ENOUGH (≥ LOG_SIGNAL_ADJUDICATION_MIN_CYCLES independent adjudication
 * cycles), WITH EVIDENCE (a machine-close evidence block whose replay
 * pin cites the row's own id and was VERIFIED at close time), and
 * WITHOUT the recurrence being at an epidemic level (a re-open bar the
 * row itself recorded, or ≥3× the loudest baseline the row recorded)?
 * Then the sweep skips the ticket filing for that fingerprint — the
 * loop-metric row, the wake's signal line and the fingerprint's future
 * rows all keep recording, so a genuine level/baseline breach still
 * surfaces.
 *
 * GATES (every one must hold — a lazy close can never silence a real
 * defect class):
 *   1. VERDICT — the row's recorded close classifies as an adjudicated
 *      designed class: `classifyFamilyClose(row) ∈ {false_positive,
 *      sibling}` (ticket-family.ts — adjudicatedClass stamp OR a
 *      positive verdict phrase, negation-aware; a duplicateOf link).
 *      A `true_defect` or `unknown` close NEVER suppresses.
 *   2. EVIDENCE — the adminNote carries a machine-close evidence block
 *      (`[machine-close evidence: …]`, closure-evidence.ts's stamp
 *      shape) with a replay-pin segment that names a replay test path,
 *      carries the platform's VERIFIED spelling (minted only after the
 *      fs + origin/main cross-check at close time), and cites the ROW's
 *      OWN 8-char id prefix — an id-named pin. A verdict without a
 *      pin, a pin the platform did not verify, a pin for a DIFFERENT
 *      ticket id: NEVER suppresses — the verdict's replay case is
 *      unproven. (The gate deliberately re-derives from the close-time
 *      stamp instead of re-stat'ing the file hourly: the backend
 *      process runs from the deployed image, not a repo checkout —
 *      closure-evidence itself records "existence not checkable
 *      server-side".)
 *   3. CYCLES — the row has survived ≥ MIN_CYCLES (2) adjudication
 *      cycles: its own close (1) plus POST-CLOSE witnesses only — a
 *      recurrence that re-adjudicated (context.reopenCount) or the
 *      absorption path recorded as a standing-class sighting
 *      (duplicateSuppressedBy:'adjudicated-class' entries in
 *      context.sightings). A while-OPEN occurrences bump is NOT a
 *      witness (fc1fd22f: occurrences 2 from the same week's day-2
 *      pass, before any close) — one adjudication must not arm
 *      suppression.
 *   4. NOT EPIDEMIC — the recurrence is inside every re-open bar the
 *      row recorded: the STRUCTURAL bar (context.reopenBar, stamped by
 *      the absorption/breach arms) and the PROSE bar (the verdict's
 *      own re-open phrase, parseAdjudicatedReopenBar), and the new
 *      sighting's count is < SURGE_MULTIPLE (3) × the loudest BASELINE
 *      the row recorded (context.count at filing or
 *      context.acceptanceMetricBaseline.baseline). No bar and no
 *      baseline → the carve-outs are OFF and suppression holds — but a
 *      count at 3× any recorded baseline is an epidemic by the
 *      class's own history, whatever the verdict says.
 *
 * FAIL DIRECTION: every lookup/parse failure (DB error, unparsable
 * note, missing pin, ambiguous history) returns NOT-suppressed — the
 * sweep files exactly as it did before this leaf existed. Suppression
 * is an optimization of adjudicated classes' weekly churn, never a
 * recall risk.
 *
 * Kill switch: LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED=1 (restores
 * the pre-0ef6794e filing behavior byte-for-byte — the sweep files
 * every ISO week again).
 *
 * Import-graph discipline: this leaf imports ONLY prisma (config/
 * database — the same seam the sweep itself uses) and the import-free
 * leaves ticket-status / ticket-family (the same pair feedback.service
 * already trusts across the module line). No logger, no redis.
 */
import prisma from '../../../config/database';
import { CLOSED_TICKET_STATUSES } from '../feedback/ticket-status';
import { classifyFamilyClose, parseAdjudicatedReopenBar } from '../feedback/ticket-family';

/** Minimum INDEPENDENT adjudication cycles before suppression arms (ticket 0ef6794e: "2 is a sane bar"). */
export const LOG_SIGNAL_ADJUDICATION_MIN_CYCLES = 2;

/** A recurrence at ≥ this multiple of the loudest recorded baseline is an EPIDEMIC — suppression never holds. */
export const LOG_SIGNAL_SURGE_MULTIPLE = 3;

export const LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV = 'LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED';

export function logSignalAdjudicatedSuppressionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV] ?? '').trim() === '1';
}

/**
 * Kill switch for the DESIGNED-ALARM filing stop (ticket 35cd91a7, 2026-11-06).
 *
 * Separate from the adjudication switch above on purpose: that one gates the
 * EVIDENCE-based per-fingerprint suppression (a close verdict), which is a
 * different mechanism from "the platform declares this class an instrument, so
 * it never files". An operator must be able to restore filing for declared
 * instruments without also re-arming every adjudicated class.
 */
export const LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED_ENV = 'LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED';

export function logSignalDesignedAlarmFilingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED_ENV] ?? '').trim() === '1';
}

/** The minimal closed-row shape the gate reads. */
export interface AdjudicationRow {
  id: string;
  title: string;
  status: string;
  adminNote: string | null;
  context: unknown;
}

const asCtx = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A machine-close evidence block (closure-evidence.ts:533's stamp shape), with its full inner text. */
const MACHINE_CLOSE_BLOCK_RE = /\[machine-close evidence: ([^\]]+)\]/g;

/** A repo-relative replay-test path token. */
const REPLAY_PATH_RE = /[\w./-]+\.(?:ts|tsx|js|py)\b/;

/**
 * The replay pin an adminNote's machine-close evidence block recorded for a
 * ticket, if it is one this row's own verdict can vouch for. Pure. Null when
 * no pin vouches. THREE conditions on the SEMICOLON-DELIMITED SEGMENT that
 * names the path (the block is noteParts.join('; ') — one part per evidence
 * member):
 *   - the segment names a repo-relative replay-test path;
 *   - the segment carries the platform's VERIFIED spelling — "(verified:
 *     exists + cites …" or "(verified via origin/main: …" — the stamp
 *     closure-evidence mints ONLY after its fs + origin/main cross-check at
 *     close time. A bare "replay test x.ts" mention with no verified stamp
 *     is a lane's say-so, not evidence, and never vouches;
 *   - the segment cites the ROW'S OWN 8-char id prefix — an id-named pin
 *     (the same prefix closure-evidence required at close time). A pin
 *     segment naming only OTHER tickets' ids does not vouch for this row.
 */
export function rowReplayPin(row: Pick<AdjudicationRow, 'id' | 'adminNote'>): string | null {
  const prefix = String(row.id ?? '').slice(0, 8);
  if (!prefix) return null;
  const note = String(row.adminNote ?? '');
  let m: RegExpExecArray | null;
  MACHINE_CLOSE_BLOCK_RE.lastIndex = 0;
  while ((m = MACHINE_CLOSE_BLOCK_RE.exec(note)) !== null) {
    const block = m[1];
    // One segment per evidence member; the pin's prefix sits INSIDE the
    // segment with its path (never elsewhere in the block).
    for (const segment of block.split(';')) {
      const path = REPLAY_PATH_RE.exec(segment)?.[0];
      if (!path) continue;
      if (!/verified/i.test(segment)) continue;
      if (!segment.includes(prefix)) continue;
      return path;
    }
  }
  return null;
}

/**
 * The loudest BASELINE the row recorded — context.count at filing (the
 * sighting's 24h row count) or context.acceptanceMetricBaseline.baseline.
 * Zero/null when the row recorded neither. Pure.
 */
export function rowBaseline(row: Pick<AdjudicationRow, 'context'>): number | null {
  const ctx = asCtx(row.context);
  const candidates: number[] = [];
  if (typeof ctx.count === 'number' && Number.isFinite(ctx.count) && ctx.count > 0) candidates.push(ctx.count);
  const amb = ctx.acceptanceMetricBaseline;
  if (amb && typeof amb === 'object' && !Array.isArray(amb)) {
    const b = (amb as Record<string, unknown>).baseline;
    if (typeof b === 'number' && Number.isFinite(b) && b > 0) candidates.push(b);
  }
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * How many INDEPENDENT adjudication cycles the row survived: its own close
 * (1) + POST-CLOSE witnesses only — a recurrence that re-adjudicated
 * (context.reopenCount, stamped by the absorption pass when a new filing
 * re-opens the closed row) + absorbed standing-class sightings
 * (duplicateSuppressedBy === 'adjudicated-class' in context.sightings,
 * stamped by the insert-path absorption when the weekly re-file landed on
 * the closed row). A while-OPEN occurrences bump (fc1fd22f: occurrences 2
 * from the SAME week's day-2 pass, before any close) is NOT a witness —
 * one adjudication must not arm suppression. Pure.
 */
export function rowAdjudicationCycles(row: Pick<AdjudicationRow, 'context'>): number {
  const ctx = asCtx(row.context);
  let cycles = 1; // the row's own close
  if (typeof ctx.reopenCount === 'number' && Number.isFinite(ctx.reopenCount) && ctx.reopenCount > 0) cycles += ctx.reopenCount;
  const sightings = Array.isArray(ctx.sightings) ? ctx.sightings : [];
  for (const s of sightings) {
    if (s && typeof s === 'object' && (s as Record<string, unknown>).duplicateSuppressedBy === 'adjudicated-class') cycles++;
  }
  return cycles;
}

/** The suppression decision and WHY (telemetry + tests). */
export interface AdjudicationVerdict {
  suppressed: boolean;
  /** The standing closed row the decision read (null: no candidate found). */
  ticketId: string | null;
  fingerprintHash: string | null;
  cycles: number | null;
  baseline: number | null;
  bar: number | null;
  pin: string | null;
}

const NOT_SUPPRESSED: AdjudicationVerdict = { suppressed: false, ticketId: null, fingerprintHash: null, cycles: null, baseline: null, bar: null, pin: null };

/**
 * Load the standing closed row for one fingerprint title. ONE bounded read
 * (exact title equality, closed statuses, newest first, take 5 — the newest
 * winning row is the verdict to trust). Fails open (null) on any DB error,
 * so a read failure never blocks filing.
 */
export async function loadAdjudicationCandidate(title: string): Promise<AdjudicationRow | null> {
  try {
    const rows = await (prisma as any).userFeatureRequest.findMany({
      where: {
        title,
        source: 'agent',
        status: { in: [...CLOSED_TICKET_STATUSES] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, title: true, status: true, adminNote: true, context: true },
    });
    return (rows as AdjudicationRow[])[0] ?? null;
  } catch {
    return null; // fail-open: a DB error never suppresses (and never blocks filing)
  }
}

/**
 * THE GATE (pure). Should the sweep SUPPRESS this fingerprint's ticket
 * filing? See the module doc for the four gates. A null row never
 * suppresses.
 */
export function adjudicationSuppresses(row: AdjudicationRow | null, sightingCount: number): AdjudicationVerdict {
  if (!row) return { ...NOT_SUPPRESSED };
  const out: AdjudicationVerdict = {
    suppressed: false,
    ticketId: row.id,
    fingerprintHash: (asCtx(row.context).fingerprintHash as string) ?? null,
    cycles: rowAdjudicationCycles(row),
    baseline: rowBaseline(row),
    bar: parseAdjudicatedReopenBar(row),
    pin: rowReplayPin(row),
  };
  // Gate 1 — verdict.
  const closeClass = classifyFamilyClose(row);
  if (closeClass !== 'false_positive' && closeClass !== 'sibling') return out;
  // Gate 2 — evidence (a verified, id-named pin).
  if (!out.pin) return out;
  // Gate 3 — cycles.
  if ((out.cycles ?? 0) < LOG_SIGNAL_ADJUDICATION_MIN_CYCLES) return out;
  // Gate 4 — not epidemic: no recorded bar breached, no baseline surge.
  if (out.bar !== null && Number.isFinite(sightingCount) && sightingCount > out.bar) return out;
  if (out.baseline !== null && Number.isFinite(sightingCount) && sightingCount >= out.baseline * LOG_SIGNAL_SURGE_MULTIPLE) return out;
  out.suppressed = true;
  return out;
}

/**
 * The sweep's single entry point (async wrapper): load the standing row,
 * gate it, decide. Fails OPEN — every failure inside returns
 * not-suppressed (the read's own catch returns null; the gate is pure).
 */
export async function shouldSuppressFingerprintFiling(
  args: { title: string; sightingCount: number },
  deps: { loadRow?: typeof loadAdjudicationCandidate } = {},
): Promise<AdjudicationVerdict> {
  const row = await (deps.loadRow ?? loadAdjudicationCandidate)(args.title);
  return adjudicationSuppresses(row, args.sightingCount);
}
