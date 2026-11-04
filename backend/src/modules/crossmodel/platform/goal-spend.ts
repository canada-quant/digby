/**
 * GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20) — per-goal spend
 * attribution (the prisma half; the pure ranking rules are goal-priority.ts).
 *
 * WHY: $4.1k/week of run_spend could not be tied to any goal — the run_spend
 * meta (loop-metrics.service recordRunSpend) carried model / seats / trigger,
 * never a goal, so "which goal is burning money without moving" had no answer.
 *
 * NOW:
 *  - STAMP: run-executor resolves the run's goal ONCE per run (resolveRunGoalId:
 *    the todo the lane is WORKING — its in-progress assigned todo, else the todo
 *    a lane-continuation wake names — else crossmodel_chats.charterGoalId, else
 *    the charter todo's goal) and passes it as AgentRunInput.goalId →
 *    MetricStamp.goalId → every run_spend / run_tokens row of the run (and the
 *    run's frontier-council rows) carries meta.goalId. Review fix 2026-10-20:
 *    the continuation starts the highest-SCORED todo, which can belong to
 *    another goal than the charter — stamping the charter credited goal A with
 *    goal B's work.
 *  - READ: a run_spend row counts toward a goal when its meta.goalId names it,
 *    or — an UNSTAMPED row (any producer: pre-stamp history, decision-gate
 *    rows, chat turns) — when its chat is chartered to the goal TODAY
 *    (charterGoalId, else the charter todo's goal) and the row is newer than the
 *    chat's last charter GOAL rebind (`charter_rebind` goalRebound — a rebind
 *    never drags the old goal's unstamped spend onto the new one). The stamp
 *    always wins over the fallback. The chat lookup is scoped to the goal's
 *    PROJECT (crossmodel_chats.projectId is indexed; charterGoalId is not —
 *    review fix 2026-10-20, the board reads this once per supervisor wake).
 *  - KNOWN vs ZERO: a goal's spend is KNOWN only when it is attributable — ≥ 1
 *    attributed row in the window, or ≥ 1 chat chartered to it. The boards
 *    render "7d $0.00" only for a KNOWN goal; an unattributable goal (no
 *    chartered lane, or past the per-read cap) gets no clause — never a false $0.
 *
 * Every read fails open (null — the board renders without the clause, the
 * stamp is simply absent). Kill switch GOAL_SPEND_ATTRIBUTION_DISABLED=1
 * (goal-priority.ts): no stamp, no read.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { goalSpendAttributionDisabled } from './goal-priority';

/** The trailing window the boards quote ("7d $…"). */
export const GOAL_SPEND_WINDOW_DAYS = 7;
/** Goals one spend read attributes (callers pass the ones they render first). */
export const GOAL_SPEND_MAX_GOALS = 60;

/** The lane-continuation wake (coding/lane-todos.ts laneTodoContinuationPrompt) — its marker + the `Todo: "<title>"` line. */
export const LANE_CONTINUATION_MARKER = 'this lane finished its run with';
const CONTINUATION_TODO_LINE_RE = /^\s*Todo:\s*"(.+)"\s*$/gm;

const normTitle = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The todo titles a lane-continuation wake names (none for any other message). Pure. */
export function continuationTodoTitles(message: unknown): string[] {
  const s = typeof message === 'string' ? message.slice(0, 20_000) : '';
  if (!s.includes(LANE_CONTINUATION_MARKER)) return [];
  return [...s.matchAll(CONTINUATION_TODO_LINE_RE)].map((m) => m[1]).filter(Boolean);
}

/**
 * The goal a lane run's spend is attributed to, in order: the lane's
 * IN-PROGRESS assigned todo (most recently updated) — the work it is doing;
 * else the pending assigned todo a lane-continuation wake (`message`) names —
 * the todo the harness just started; else the chat's charterGoalId; else its
 * charter todo's goal. Null for a chat with none of these (supervisors, plain
 * chats), when attribution is switched off, or on a read error. Never throws.
 */
export async function resolveRunGoalId(chatId: string | null | undefined, opts: { message?: unknown } = {}): Promise<string | null> {
  if (!chatId || goalSpendAttributionDisabled()) return null;
  try {
    const todos = ((await prisma.projectTodo.findMany({
      where: { assigneeChatId: chatId, status: { in: ['in_progress', 'pending'] } },
      select: { id: true, title: true, status: true, goalId: true },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    }).catch(() => [])) ?? []) as Array<{ id: string; title: string; status: string; goalId: string | null }>;
    const working = todos.find((t) => t.status === 'in_progress' && t.goalId);
    if (working?.goalId) return working.goalId;
    const named = continuationTodoTitles(opts.message).map(normTitle);
    if (named.length) {
      const started = todos.find((t) => t.status === 'pending' && t.goalId && named.includes(normTitle(t.title)));
      if (started?.goalId) return started.goalId;
    }
  } catch { /* fall through to the charter */ }
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { charterGoalId: true, charterTodoId: true } }) as { charterGoalId?: string | null; charterTodoId?: string | null } | null;
    if (!chat) return null;
    if (chat.charterGoalId) return chat.charterGoalId;
    if (!chat.charterTodoId) return null;
    const todo = await prisma.projectTodo.findUnique({ where: { id: chat.charterTodoId }, select: { goalId: true } }) as { goalId?: string | null } | null;
    return todo?.goalId ?? null;
  } catch {
    return null;
  }
}

/**
 * SQL predicate (loop_metrics alias `lm`) for "attributed to the goal ids in
 * parameter $<goalParam> (text[])": stamped meta.goalId; else an UNSTAMPED row
 * of a chat in the projects $<projectParam> (text[]) chartered to the goal
 * (charterGoalId, else the charter todo's goal) and newer than that chat's last
 * charter goal rebind. Exported so get_spend's goal scope and the board read
 * count the SAME rows. Uses its own aliases (gsc / gst / gsr) so a caller's
 * `c` / `t` joins never collide.
 */
export function goalSpendPredicate(goalParam: number, projectParam: number): string {
  const g = `$${goalParam}::text[]`;
  const p = `$${projectParam}::text[]`;
  return `(lm.meta->>'goalId' = ANY(${g}) OR (lm.meta->>'goalId' IS NULL`
    + ` AND lm."sessionId" IN (SELECT gsc.id FROM crossmodel_chats gsc LEFT JOIN project_todos gst ON gst.id = gsc."charterTodoId"`
    + ` WHERE gsc."projectId" = ANY(${p}) AND (gsc."charterGoalId" = ANY(${g}) OR (gsc."charterGoalId" IS NULL AND gst."goalId" = ANY(${g}))))`
    + ` AND NOT EXISTS (SELECT 1 FROM loop_metrics gsr WHERE gsr."sessionId" = lm."sessionId" AND gsr.kind = 'charter_rebind'`
    + ` AND gsr."createdAt" > lm."createdAt" AND gsr.meta->>'goalRebound' = 'true')))`;
}

export interface GoalSpendRow {
  usd: number;
  runs: number;
  /** Rows attributed by meta.goalId (the rest came through the charter fallback). */
  stampedRuns: number;
}

export interface GoalSpendRead {
  /** goalId → attributed spend over the window (only goals with ≥ 1 attributed row). */
  byGoal: Map<string, GoalSpendRow>;
  /**
   * The goals whose spend is KNOWN (queried AND attributable: ≥ 1 attributed
   * row, or ≥ 1 chat chartered to it). A known goal absent from `byGoal`
   * spent $0; a goal outside this set renders NO clause — never a false $0.
   */
  known: Set<string>;
}

/** The spend a board renders for one goal: its USD when known (0 = genuinely nothing), else null (no clause). Pure. */
export function knownGoalSpendUsd(read: GoalSpendRead | null | undefined, goalId: string): number | null {
  if (!read || !read.known.has(String(goalId))) return null;
  return read.byGoal.get(String(goalId))?.usd ?? 0;
}

/**
 * Spend over [since, now] for the first GOAL_SPEND_MAX_GOALS of `goalIds`
 * (callers pass the goals they render first), with the charter fallback scoped
 * to `projectIds` (the goals' projects — none ⇒ stamped rows only). NULL when
 * switched off or on a read error — the caller then renders no spend clause at
 * all. Never throws.
 */
export async function loadGoalSpend(goalIds: string[], since: Date, scope: { projectIds: string[] }): Promise<GoalSpendRead | null> {
  if (goalSpendAttributionDisabled()) return null;
  const ids = [...new Set((goalIds ?? []).filter(Boolean).map(String))].slice(0, GOAL_SPEND_MAX_GOALS);
  const projectIds = [...new Set((scope?.projectIds ?? []).filter(Boolean).map(String))];
  const out: GoalSpendRead = { byGoal: new Map(), known: new Set() };
  if (!ids.length) return out;
  try {
    const [rows, chartered] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COALESCE(lm.meta->>'goalId', c."charterGoalId", t."goalId") AS goal_id, COALESCE(SUM(lm.value),0)::float AS usd, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE lm.meta->>'goalId' IS NOT NULL)::int AS stamped
         FROM loop_metrics lm
         LEFT JOIN crossmodel_chats c ON c.id = lm."sessionId" AND lm.meta->>'goalId' IS NULL
         LEFT JOIN project_todos t ON t.id = c."charterTodoId" AND c."charterGoalId" IS NULL
         WHERE lm.kind = 'run_spend' AND lm."createdAt" >= $1 AND ${goalSpendPredicate(2, 3)}
         GROUP BY 1`,
        since, ids, projectIds,
      ) as Promise<Array<{ goal_id: string | null; usd: number; runs: number; stamped: number }>>,
      // Which goals have a chartered lane today (a known $0 vs an unknown) — best-effort: a failed read only
      // shrinks `known` to the goals with rows (never a false $0).
      (projectIds.length
        ? prisma.$queryRawUnsafe(
          `SELECT DISTINCT COALESCE(c."charterGoalId", t."goalId") AS goal_id
           FROM crossmodel_chats c LEFT JOIN project_todos t ON t.id = c."charterTodoId" AND c."charterGoalId" IS NULL
           WHERE c."projectId" = ANY($1::text[]) AND (c."charterGoalId" = ANY($2::text[]) OR (c."charterGoalId" IS NULL AND t."goalId" = ANY($2::text[])))`,
          projectIds, ids,
        ) as Promise<Array<{ goal_id: string | null }>>
        : Promise.resolve([] as Array<{ goal_id: string | null }>)).catch(() => [] as Array<{ goal_id: string | null }>),
    ]);
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.goal_id || !ids.includes(String(r.goal_id))) continue;
      out.byGoal.set(String(r.goal_id), { usd: Number(r.usd) || 0, runs: Number(r.runs) || 0, stampedRuns: Number(r.stamped) || 0 });
      out.known.add(String(r.goal_id));
    }
    for (const r of Array.isArray(chartered) ? chartered : []) {
      if (r?.goal_id && ids.includes(String(r.goal_id))) out.known.add(String(r.goal_id));
    }
    return out;
  } catch (err: any) {
    logger.warn(`goal-spend: per-goal spend read failed (boards render without it): ${err?.message ?? err}`, { source: 'goal-spend' });
    return null;
  }
}
