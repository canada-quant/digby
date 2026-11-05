/**
 * ALP-1 — OBSERVE-ONLY interaction-level attribution for ADJUDICATION
 * REPRODUCTION PROBES (backlog `docs/FRAMEWORK_BACKLOG.md` §ALP-1, tickets
 * 921013a5 → d8395cca).
 *
 * THE DEFECT THIS NAMES. A lane dispatched to adjudicate a tool-failure-streak
 * ticket faithfully re-executes the failing calls from the ticket's own "Call
 * args" block — and those probes reliably reach the same breaker, which files
 * generation N+1 of the same class. Observed twice in one night: `921013a5`
 * was filed by session c0e22e36, dispatched as a ticket LANE to session
 * 350827a9 at 2026-11-05T00:18:33Z, and 70 minutes later THAT session filed
 * `d8395cca` off its own reproduction probes (`a930d169` / `7e987035` are the
 * ghost ids quoted in `921013a5`'s args block). Faithfully reproducing a
 * streak's recorded probes IS the streak.
 *
 * WHY THE TWO EXISTING DEDUPE AXES CANNOT SEE IT (read from the rows, not
 * inferred): (a) `d8395cca`'s context carries neither `family` nor
 * `breakerClassKey`, and `feedback/breaker-class-key.ts` returns null for a
 * plain 'failure' trip BY DESIGN, so the af4ef7c7 adjudicated-class attach
 * never runs; (b) even a fully stamped successor would only have lost its
 * second LANE under TFD-1's dispatch gate — the ticket ROW, the occurrences
 * bump and the next generation all still land.
 *
 * WHAT THIS MODULE SHIPS — AND WHAT IT DELIBERATELY DOES NOT.
 *   SHIPS: attribution. A trip raised by a session that the dispatcher has
 *   bound to a ticket (`context.dispatchMode==='ticket_lane'` +
 *   `context.dispatchedTo===sessionId`) is stamped `reproOf=<ticket id>` on
 *   the FILED ROW's context and on ONE observe-only loop_metrics row, so the
 *   fleet can finally count "how many breaker tickets are adjudication
 *   probes" instead of guessing.
 *   DOES NOT SHIP: any suppression, any exemption, any count change.
 *   `looksLikeToolFailure` classification is untouched, the streak counter is
 *   untouched, and NOTHING in the trip path reads this module. A tagged probe
 *   trips, counts and is withheld exactly as an untagged one does — the only
 *   difference is a context field and a telemetry row written AFTER the count
 *   already decided. That asymmetry is the whole point: a lane investigating a
 *   refusal must not make the refusal invisible.
 *
 * WHY `dispatchedTo` IS THE CARRIER (interaction-level, not model-declared).
 * The stamp is written by the DISPATCHER with the ticket row in hand, so it is
 * deterministic and un-forgeable by the lane: the lane cannot declare itself a
 * probe, and a genuinely stuck lane that merely CLAIMS to be adjudicating
 * something inherits nothing. The backlog's `reproOf:<ticket id>` example names
 * the field this writes; the SOURCE is the dispatch binding, because a
 * self-reported tag ("I am adjudicating ticket X") is exactly the guess this
 * item must not depend on. The ticket id therefore comes from a real
 * `user_feature_requests` row — never from text — so it can never be a
 * fabricated id.
 *
 * THE SAFETY RULE (breaker-class-key.ts, read first, applied here). A key that
 * could collapse distinct classes is never built; a tag that could make a real
 * refusal invisible is never written. This module writes ATTRIBUTION, never a
 * verdict, and it is read by nothing on the decision path.
 *
 * FAIL-OPEN EVERYWHERE. Every read is wrapped: an unreadable/partial Prisma
 * double, a DB hiccup, a missing row or a malformed context leaves the filing
 * byte-identical to today. `REPRO_ATTRIBUTION_DISABLED=1` (read AT CALL TIME,
 * never at import) restores the exact pre-change filing: no read, no field, no
 * metric row.
 *
 * NO REFUSAL-PATH EXEMPTION IS PROPOSED HERE, and none may be added later: that
 * class was refuted on d53eed71 by the pinned loopjacking/staged-args
 * invariants (`confirmation-loopjacking.cd366b85.test.ts`, `platform-tools.ts`
 * "the swapped args are ignored entirely; only the staged args execute") and by
 * the distinct-contexts argument — silencing a real refusal is the same class
 * of defect as letting swapped args execute.
 */

import prisma from '../../../config/database';
import { CLOSED_TICKET_STATUSES } from '../feedback/ticket-status';

/** Context field carrying the adjudicated ticket id on a filed breaker row. */
export const REPRO_OF_FIELD = 'reproOf';
/** Context field naming WHERE the attribution came from (never model text). */
export const REPRO_EVIDENCE_FIELD = 'reproOfEvidence';
/** The only attribution source shipped: the dispatcher's lane binding. */
export const REPRO_EVIDENCE_DISPATCH_LANE = 'dispatched_ticket_lane';

/**
 * The kill switch, read AT CALL TIME (never captured at import — an operator
 * must be able to restore the pre-change filing from box env without a deploy,
 * and a module-scope const would bake the boot-time value into a long-lived
 * worker). `=1` ⇒ the filer performs no read, writes no field and emits no row.
 */
export function reproAttributionDisabled(): boolean {
  return process.env.REPRO_ATTRIBUTION_DISABLED === '1';
}

/** An attribution result. `reproOf` is the ADJUDICATED ticket id. */
export interface ReproAttribution {
  reproOf: string;
  evidence: typeof REPRO_EVIDENCE_DISPATCH_LANE;
}

/** Ticket ids are 8–40 hex in this store (lanes cite the 8-char prefix). Pure. */
const TICKET_ID_RE = /^[0-9a-f]{8,40}$/i;

/** Pure: is this string shaped like a ticket id we would accept from a row? */
export function isTicketIdShaped(v: unknown): v is string {
  return typeof v === 'string' && TICKET_ID_RE.test(v.trim());
}

/**
 * Pure: fold a `findFirst` row (the dispatcher's lane binding) into an
 * attribution, or null. Kept pure and exported so the tests can pin the
 * acceptance rule WITHOUT a DB double — the rule is the contract, the read is
 * plumbing.
 *
 * Rejects: a missing row, a row without a shaped id, a row not in
 * `ticket_lane` mode (a legacy stamp that never named a lane is not an
 * adjudication), and a row whose dispatchMode is anything else.
 */
export function reproFromDispatchedRow(row: { id?: unknown; context?: unknown } | null | undefined): ReproAttribution | null {
  if (!row) return null;
  const ctx = (row.context ?? {}) as Record<string, unknown>;
  if (ctx.dispatchMode !== 'ticket_lane') return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!isTicketIdShaped(id)) return null;
  return { reproOf: id, evidence: REPRO_EVIDENCE_DISPATCH_LANE };
}

/**
 * Resolve the repro attribution for a session — OBSERVE-ONLY, FAIL-OPEN.
 *
 * ONE prefix-exact JSON-path read (`context.dispatchedTo`), the same lookup
 * shape `coding/self-merge.service.ts isDispatchedTicketLane` already uses, so
 * there is no new query pattern in the codebase. Closed tickets are excluded:
 * a lane still holding a binding to a ticket that has since closed is not
 * adjudicating it any more, and attributing fresh trips to a finished ticket
 * would be a lie in the other direction.
 *
 * Never throws. Any failure (disabled switch, read error, partial double,
 * malformed row) returns null AND the caller files exactly as today.
 */
export async function resolveReproAttribution(sessionId: string): Promise<ReproAttribution | null> {
  if (reproAttributionDisabled()) return null;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  try {
    // `findFirst` is typeof-guarded: the many reflection.* suites hand-mock
    // prisma and must not TypeError on a model they never declared (same
    // fail-open shape as a read error — null, byte-identical filing).
    const findFirst = (prisma as any)?.userFeatureRequest?.findFirst;
    if (typeof findFirst !== 'function') return null;
    const row = await findFirst({
      where: {
        context: { path: ['dispatchedTo'], equals: sessionId },
        status: { notIn: [...CLOSED_TICKET_STATUSES] },
      },
      select: { id: true, context: true },
    });
    return reproFromDispatchedRow(row);
  } catch {
    return null;
  }
}

/**
 * Pure: the context fields to merge onto a filed row. Empty object when there
 * is no attribution, so an untagged filing spreads `{}` and its context stays
 * byte-identical to today (pinned by a test).
 */
export function reproContextFields(a: ReproAttribution | null): Record<string, string> {
  if (!a) return {};
  return { [REPRO_OF_FIELD]: a.reproOf, [REPRO_EVIDENCE_FIELD]: a.evidence };
}

/** Pure: the observe-only metric meta for an attribution, or null. */
export function reproMetricMeta(
  a: ReproAttribution | null,
  ev: { sessionId: string; runId?: string | null; tool: string; shape?: string | null },
): Record<string, unknown> | null {
  if (!a) return null;
  return {
    sessionId: ev.sessionId,
    ...(ev.runId ? { runId: ev.runId } : {}),
    tool: ev.tool,
    shape: ev.shape ?? 'failure',
    reproOf: a.reproOf,
    reproEvidence: a.evidence,
  };
}