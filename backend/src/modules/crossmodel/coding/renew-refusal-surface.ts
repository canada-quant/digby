/**
 * Owner-visible surface for refused self-renewals (review-fixer 2026-09-27,
 * finding B2 follow-up).
 *
 * A machine/system watch whose renewOnExhaustion successor the governor
 * REFUSED (`schedule.service.ts renewalGovernor` — generation cap, or the
 * open-anchor rule under RENEW_ANCHOR_CHECK_ENFORCE=1) stops with a 🛑 note
 * in ITS OWN chat and a `schedule_disabled` event. Neither reaches the owner
 * when nobody consumes the alarm: the SA0906 stopped-schedule re-check files
 * nothing on a project with no active/blocked goal (which is, by
 * construction, every `no_anchor` refusal), its card path is observe-only,
 * and with a supervisor tier switched OFF the hook row is skipped and never
 * replayed. This leaf counts the `schedule_renew_refused` rows in a window —
 * scoped to ONE project (status card / board digest) or ONE owner (the
 * briefing) — and renders ONE harness line so a deaf lane is seen even when
 * no supervisor decides. Observed-only rows (the anchor in its default
 * observe mode — the successor still armed) are counted separately and never
 * called "stopped".
 *
 * Never throws; null when nothing to say.
 */
import prisma from '../../../config/database';
import { LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

/** Bound on rows read per window — refusals are rare; this is a safety cap. */
export const RENEW_REFUSAL_SURFACE_MAX_ROWS = 500;
export const RENEW_REFUSAL_SURFACE_DEFAULT_HOURS = 24;
/** Prefix of the board-digest line (pinned by the surface test). */
export const RENEW_REFUSAL_BOARD_PREFIX = '[SELF-ARMED WATCHES STOPPED — harness-measured]';

export type RenewRefusalScope = { scope: 'project'; projectId: string } | { scope: 'user'; userId: string };

export interface RenewRefusalSummary {
  hours: number;
  /** Refusals that STOPPED a chain (outcome 'refused' or the pre-fixer rows with no outcome). */
  refused: number;
  /** Observe-only anchor misses — the successor still armed. */
  observed: number;
  /** Refused counts by kind. */
  byKind: Record<string, number>;
  /** Distinct chat ids (short) of the refused rows, newest first, capped. */
  chatIds: string[];
  /** The harness line; null when refused + observed are both 0. */
  line: string | null;
}

interface RefusalRow { sessionId: string | null; meta: unknown; createdAt?: Date }

/** Pure: fold rows (already scoped to the caller's chats) into the summary. Exported for tests. */
export function summarizeRenewRefusals(rows: RefusalRow[], hours: number): RenewRefusalSummary {
  let refused = 0;
  let observed = 0;
  const byKind: Record<string, number> = {};
  const chats: string[] = [];
  for (const r of rows) {
    const m = (r?.meta ?? {}) as Record<string, unknown>;
    if (m.outcome === 'observed') { observed += 1; continue; }
    refused += 1;
    const kind = typeof m.kind === 'string' && m.kind ? m.kind : 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (r.sessionId && !chats.includes(r.sessionId)) chats.push(r.sessionId);
  }
  const chatIds = chats.slice(0, 6).map((id) => id.slice(0, 8));
  let line: string | null = null;
  if (refused > 0 || observed > 0) {
    const parts: string[] = [];
    if (refused > 0) {
      const kinds = Object.entries(byKind).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ');
      parts.push(`Self-armed watches stopped (last ${hours} h, harness-measured): ${refused} — ${kinds}${chatIds.length ? ` — chat${chatIds.length > 1 ? 's' : ''} ${chatIds.join(', ')}${chats.length > chatIds.length ? ` +${chats.length - chatIds.length} more` : ''}` : ''}. The framework never re-arms a refused chain; arm a fresh schedule_self / schedule_message on the lane if the loop still matters.`);
    }
    if (observed > 0) {
      parts.push(`${refused > 0 ? 'Also observed' : 'Self-armed watches observed'} (last ${hours} h): ${observed} renewal${observed === 1 ? '' : 's'} with no open anchor still armed (observe-only; RENEW_ANCHOR_CHECK_ENFORCE=1 would have stopped ${observed === 1 ? 'it' : 'them'}).`);
    }
    line = parts.join(' ');
  }
  return { hours, refused, observed, byKind, chatIds, line };
}

/**
 * Count the window's `schedule_renew_refused` rows for one project or one
 * owner. Reads the (rare) metric rows first, then keeps only those whose
 * chat belongs to the scope — never a chat listing per owner. Never throws.
 */
export async function getRenewRefusalSummary(scope: RenewRefusalScope, hours: number = RENEW_REFUSAL_SURFACE_DEFAULT_HOURS): Promise<RenewRefusalSummary> {
  const empty: RenewRefusalSummary = { hours, refused: 0, observed: 0, byKind: {}, chatIds: [], line: null };
  try {
    const h = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : RENEW_REFUSAL_SURFACE_DEFAULT_HOURS;
    const since = new Date(Date.now() - h * 3_600_000);
    const rows: RefusalRow[] = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SCHEDULE_RENEW_REFUSED, createdAt: { gte: since } },
      select: { sessionId: true, meta: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: RENEW_REFUSAL_SURFACE_MAX_ROWS,
    });
    if (rows.length === 0) return { ...empty, hours: h };
    const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter((id): id is string => !!id))];
    if (sessionIds.length === 0) return { ...empty, hours: h };
    const chats: Array<{ id: string }> = await prisma.crossModelChat.findMany({
      where: {
        id: { in: sessionIds },
        ...(scope.scope === 'project' ? { projectId: scope.projectId } : { userId: scope.userId }),
      },
      select: { id: true },
    });
    const inScope = new Set(chats.map((c) => c.id));
    return summarizeRenewRefusals(rows.filter((r) => r.sessionId && inScope.has(r.sessionId)), h);
  } catch {
    return empty;
  }
}

/** The one-line surface, or null. Never throws. */
export async function renewRefusalLine(scope: RenewRefusalScope, hours?: number): Promise<string | null> {
  try {
    return (await getRenewRefusalSummary(scope, hours)).line;
  } catch {
    return null;
  }
}

/** The board-digest flavour (prefixed) — null when nothing to say. Never throws. */
export async function renewRefusalBoardLine(scope: RenewRefusalScope, hours?: number): Promise<string | null> {
  const line = await renewRefusalLine(scope, hours);
  return line ? `${RENEW_REFUSAL_BOARD_PREFIX} ${line}` : null;
}
