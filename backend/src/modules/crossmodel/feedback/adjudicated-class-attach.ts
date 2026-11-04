/**
 * af4ef7c7 — attach a same-class sighting to an already-ADJUDICATED closed
 * ticket row, keyed on a STRUCTURAL class key.
 *
 * WHY THIS IS A SEPARATE LEAF MODULE (measured, this run). The raw-write filer
 * (`coding/reflection.ts`) must consult this arm, but it must NOT import
 * `feedback.service.ts`: that module's graph reaches `config/env`, whose
 * parseEnv() calls `process.exit(1)` on a bare Jest worker — an UNCATCHABLE
 * process kill, not a throw that try/catch can save. Wiring the helper through
 * feedback.service broke 5 `reflection.*` suites with "Jest worker encountered
 * N child process exceptions". So the arm lives here, importing only modules
 * whose graphs never reach config/env, and feedback.service.ts re-exports it.
 *
 * WHY A SEPARATE ARM AT ALL. Every dedupe pass lives INSIDE
 * `fileFeedbackTicket`, and the harness filer writes its breaker ticket with a
 * raw `prisma.userFeatureRequest.create` (its create block carried no context
 * at all on main), so those rows never entered the dedupe chain. Stamping a key
 * at that create site alone would have been inert. Routing the filer through
 * fileFeedbackTicket instead would put harness breaker tickets under its rate
 * caps (20/session/hour, 300/day global) and its cross-source linking — the
 * wrong blast radius for a self-healing detector.
 *
 * NO TITLE PREFILTER. The lookup is a direct JSON-path equality on the stamp.
 * The legacy scan prefilters on `title CONTAINS <token>`, which for a breaker
 * title is usually the mutable chat-title word — exactly how the class went
 * unseen. And no title-derived key is computed here at all (see
 * ./breaker-class-key.ts for why that approach was refuted).
 *
 * Fail-open: any error returns null and the caller files normally. Attaching
 * must never be able to block a ticket.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { Prisma } from '@prisma/client';
import { closedTicketStatusesForQuery } from './ticket-status';
import { fitBumpedDescription } from './sighting-fit';
import { BREAKER_CLASS_KEY_FIELD } from './breaker-class-key';
import { parseAdjudicatedReopenBar } from './ticket-family';

/** Last N sightings kept in the dedup trail (mirrors feedback.service). */
const SIGHTINGS_KEPT = 5;
/** Same 90-day dedup window as the title-keyed adjudicated pass. */
const DEDUP_WINDOW_MS = 90 * 24 * 3600_000;

function asContextObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The SAME adjudication test the title arm uses (feedback.service's
 * isAdjudicatedTicketRow): a stamped context.adjudicatedClass, or an adminNote
 * carrying the model-behavior / guard-correct verdict with no negator. A closed
 * row with a key but NO recorded verdict is not an adjudication and must not
 * absorb a sighting.
 */
export function isAdjudicatedRow(row: { context?: unknown; adminNote?: string | null }): boolean {
  if (asContextObject(row.context).adjudicatedClass === true) return true;
  const note = String(row.adminNote ?? '');
  const ADJUDICATED_VERDICT_RE = /\b(?:model behavior\b|guard(?:s)? (?:was |were |fired |is |are )?correct\b|no(?:-| )deterministic framework defect\b|no framework defect\b)/gi;
  const NEGATOR_RE = /\b(?:not|never|nor|isn'?t|wasn'?t|ain'?t|zero)\b[^a-z0-9]{0,3}$/i;
  let m: RegExpExecArray | null;
  while ((m = ADJUDICATED_VERDICT_RE.exec(note)) !== null) {
    const window = note.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATOR_RE.test(window)) return true;
  }
  return false;
}

export async function bumpAdjudicatedClassSighting(args: {
  classKey: string;
  type: string;
  description: string;
  context: Record<string, unknown>;
}): Promise<{ ticket: any; attached: string } | null> {
  const classKey = String(args.classKey ?? '').trim();
  if (!classKey) return null;
  // The SAME env escape hatch the title-keyed adjudicated passes honour
  // (feedback.service.ts), and the reason is the one this arm's existence
  // depends on: if a key ever DOES merge two distinct classes in production,
  // the owner must be able to stop it with an env change on the box, not a
  // code deploy. An attach arm outside its own kill switch is unrevertable
  // in an incident — adversarial review F1, blocking.
  if (process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED === '1') return null;
  try {
    const candidates = await prisma.userFeatureRequest.findMany({
      where: {
        source: { in: ['agent', 'agent-harness'] },
        status: { in: closedTicketStatusesForQuery() },
        createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
        context: { path: [BREAKER_CLASS_KEY_FIELD], equals: classKey },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 5,
    });
    const match = (candidates as any[]).find((c) =>
      !asContextObject(c.context).duplicateOf && isAdjudicatedRow(c));
    if (!match) return null;
    // Adversarial review F2 (blocking): an adjudication that accepts a standing
    // class carries a RE-OPEN BAR — the condition on which the verdict itself
    // demands re-examination (docs/FRAMEWORK_LESSONS.md: absorbing sightings of
    // a barred class turns an over-eager reopen loop into a permanently SILENT
    // class). The sibling title pass honours it; this arm must not be an
    // unrevertable bypass of it. A breaker sighting carries no 24h `count`, so
    // it can never EVALUATE the bar — and a sighting that cannot evaluate the
    // bar must FILE, not be absorbed.
    if (parseAdjudicatedReopenBar(match) !== null) return null;
    const prevCtx = asContextObject(match.context);
    const occurrences = (typeof prevCtx.occurrences === 'number' ? prevCtx.occurrences : 1) + 1;
    const sighting: Record<string, unknown> = {};
    for (const k of ['sessionId', 'role', 'filedAt', 'about'] as const) {
      if (args.context[k]) sighting[k] = args.context[k];
    }
    sighting.duplicateSuppressedBy = 'adjudicated-class';
    const prevSightings = Array.isArray(prevCtx.sightings) ? prevCtx.sightings : [];
    const sightings = [...prevSightings, sighting].slice(-SIGHTINGS_KEPT);
    // The incoming description IS the bump text: this filer packs no
    // screenshots (feedback.service's descriptionForBump closure exists only to
    // re-point `[screenshot N]` lines at an EXISTING ticket's dir).
    const bumped = await prisma.userFeatureRequest.update({
      where: { id: match.id },
      data: {
        description: fitBumpedDescription(match.description, `${occurrences} (adjudicated class — model behavior, guard correct; suppressed, no dispatch) ---\n${args.description.trim()}`),
        context: { ...prevCtx, occurrences, sightings, lastSeen: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    logger.info(`feedback: adjudicated-class dedupe (${BREAKER_CLASS_KEY_FIELD}=${classKey}) — sighting merged into ${match.id} (occurrences=${occurrences}); no new ticket, no dispatch`);
    // Telemetry is lazy-imported: loop-metrics must never be able to make this
    // leaf's import graph heavier than the attach itself.
    void import('../platform/loop-metrics.service').then((m) => m.recordLoopMetric({
      kind: 'feedback_adjudicated_class_dedupe',
      sessionId: typeof args.context.sessionId === 'string' ? args.context.sessionId : undefined,
      value: 1,
      meta: { ticketId: match.id, occurrences, filedType: args.type, ticketType: match.type, by: BREAKER_CLASS_KEY_FIELD },
    })).catch(() => undefined);
    return { ticket: bumped, attached: match.id };
  } catch (err: any) {
    logger.warn(`feedback: class-key attach failed (fail-open to normal filing): ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }
}