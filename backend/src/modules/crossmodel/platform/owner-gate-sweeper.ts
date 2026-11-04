/**
 * Owner-gate sweeper (ticket 356d21bb) — the BACKSTOP that closes every gate
 * an owner answer was supposed to resolve, when the inline fan-out missed it
 * (deploy mid-answer, a process crash between the flip and the fan-out, a
 * surface that predates the ticket, a cross-instance race).
 *
 * One pass, three best-effort actions (each batch-capped, each never throwing):
 *
 *   (a) Todos/goals parked 'blocked' with a gateQuestionId whose
 *       owner_questions row is ANSWERED → unblockOwnerGatedItems (the ONE
 *       choke point in goals.service — todo → pending + assignee woken,
 *       goal → active; blockedReason/blockKind/gateQuestionId clear together).
 *       DISMISSED rows never unblock anything (dismiss ≠ decision).
 *       fadc3563 (2026-10-04): a HOLD/negative answer ("Not yet — hold the
 *       store wave") keeps the gate CLOSED as the owner's hold — the choke
 *       point classifies (owner-hold-answer.ts), re-blocks blockKind 'owner'
 *       and wakes 'owner_hold'; the sweeper only carries provenance + counts
 *       (heldTodos/heldGoals in stats + telemetry).
 *   (b) OPEN owner_questions rows whose question is the SAME DECISION
 *       (isSameDecisionQuestion — the 992c8374 asymmetric matcher) as a
 *       recently-ANSWERED same-user row → auto-resolve through the canonical
 *       answerOwnerQuestion path (conditional flip, transcript note, chat
 *       wake, ledger, gate unblock, duplicate fan-out).
 *   (c) LIVE ask_user pendings (confirm:pending:* presence keys) OLDER than
 *       PENDING_ANSWER_MIN_AGE_MS whose question matches an answered
 *       owner_questions row on the same chat → stamp the durable record
 *       'answered' (first-writer-wins) and publishQuestionResolution with the
 *       recorded answer — the parked run's heartbeat/cancelPoll drains it.
 *       The age floor gives the owner time to answer for real before the
 *       sweeper self-answers from a stale duplicate.
 *
 * Kill switch: OWNER_GATE_SWEEPER_DISABLED=1 (the OWNER_ANSWER_DURABLE_WAKE_
 * DISABLED convention). Cadence: OWNER_GATE_SWEEP_MS (default 5 min). Every
 * acting pass telemeters loop_metrics kind 'owner_gate_sweep'.
 *
 * Lazy prisma/redis/logger + dynamic module imports throughout — the same
 * import-time discipline as owner-questions.ts (a static edge into
 * config/database or config/redis would pull config/env → process.exit into
 * every jest graph that reaches this module).
 */

type Prisma = typeof import('../../../config/database').default;
let _db: Prisma | null = null;
async function db(): Promise<Prisma> {
  if (!_db) _db = (await import('../../../config/database')).default;
  return _db;
}

async function redis(): Promise<any | null> {
  return (await import('../../../config/redis').catch(() => null))?.default ?? null;
}

async function logSweep(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* logging must never break the sweeper */ }
}

/** Cadence + batch knobs (env-overridable, NaN-guarded like the orphan sweeper). */
const envMs = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1_000 ? v : dflt;
};
const SWEEP_MS = () => envMs('OWNER_GATE_SWEEP_MS', 5 * 60 * 1000);
/** (c) — a live pending must be at least this old before the sweeper answers it. */
const PENDING_ANSWER_MIN_AGE_MS = () => envMs('OWNER_GATE_PENDING_MIN_AGE_MS', 15 * 60 * 1000);
/** (b) — how far back "recently answered" reaches for duplicate matching. */
const DUPLICATE_ANSWER_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Per-action batch caps — a pathological fleet never pins a sweep tick. */
const SCAN_BATCH = 100;
const ACT_BATCH = 25;

export interface OwnerGateSweepStats {
  unblockedTodos: number;
  unblockedGoals: number;
  heldTodos: number;
  heldGoals: number;
  dupesResolved: number;
  pendingsResolved: number;
  /** Todo 77c88942 item 2: credential-gated rows self-healed (receipt landed). */
  credentialGatesResolved: number;
  /** Ticket 9759bf5c: stored credentials that EXIST but were refused as
   *  evidence (predates the ask / AWS pair contradicts itself). The card stays
   *  OPEN for the owner — this counter is how the fleet sees the false green
   *  being withheld rather than stamped. */
  credentialGatesDeclined: number;
  scanned: { todos: number; goals: number; openRows: number; answeredRows: number; pendings: number };
}

/**
 * One sweep pass. Exported for tests + manual invocation; the interval wrapper
 * below never lets a throw escape (and neither does this — every action is
 * independently guarded).
 */
export async function sweepOwnerGatesOnce(now: Date = new Date()): Promise<OwnerGateSweepStats> {
  const stats: OwnerGateSweepStats = {
    unblockedTodos: 0, unblockedGoals: 0, heldTodos: 0, heldGoals: 0, dupesResolved: 0, pendingsResolved: 0,
    credentialGatesResolved: 0,
    credentialGatesDeclined: 0,
    scanned: { todos: 0, goals: 0, openRows: 0, answeredRows: 0, pendings: 0 },
  };

  // ── (a) todos/goals blocked on an ANSWERED gateQuestionId ─────────────────
  try {
    const prisma = await db();
    const [blockedTodos, blockedGoals] = await Promise.all([
      prisma.projectTodo.findMany({ where: { status: 'blocked', gateQuestionId: { not: null } }, take: SCAN_BATCH }),
      prisma.projectGoal.findMany({ where: { status: 'blocked', gateQuestionId: { not: null } }, take: SCAN_BATCH }),
    ]);
    stats.scanned.todos = blockedTodos.length;
    stats.scanned.goals = blockedGoals.length;
    const gateIds = [...new Set([...blockedTodos, ...blockedGoals].map((r: any) => r.gateQuestionId).filter(Boolean))] as string[];
    const gateRows = gateIds.length
      ? await prisma.ownerQuestion.findMany({ where: { id: { in: gateIds } }, take: SCAN_BATCH })
      : [];
    const answeredById = new Map<string, any>(gateRows.filter((r: any) => r.status === 'answered' && r.answer).map((r: any) => [r.id, r]));
    if (answeredById.size) {
      const { unblockOwnerGatedItems } = await import('./goals.service');
      const { isCounterQuestionRow } = await import('./owner-questions');
      for (const [questionId, row] of [...answeredById.entries()].slice(0, ACT_BATCH)) {
        try {
          // CanLaw 2026-09-15: an owner reply that was itself a question
          // releases the gate as the team's own (blocked, blockKind 'agent'),
          // never as "owner answered — START now".
          // fadc3563: a HOLD/negative answer keeps the gate closed as the
          // owner's hold (goals.service classifies + counts it) — the sweeper
          // just carries provenance and the acted count.
          const out = await unblockOwnerGatedItems({
            userId: row.userId, questionId, question: row.question, answer: row.answer,
            source: 'owner-gate sweeper', counterQuestion: isCounterQuestionRow(row),
            answeredBy: row.answeredBy === 'supervisor' ? 'supervisor' : row.answeredBy === 'default' ? 'default' : 'owner',
          });
          stats.unblockedTodos += out.todos;
          stats.unblockedGoals += out.goals;
          stats.heldTodos += out.heldTodos ?? 0;
          stats.heldGoals += out.heldGoals ?? 0;
        } catch (err: any) {
          void logSweep('warn', `owner-gate-sweeper: unblock failed for ${questionId}: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err: any) {
    void logSweep('warn', `owner-gate-sweeper: action (a) failed: ${err?.message ?? err}`);
  }

  // ── (b) OPEN duplicates of a recently-ANSWERED same-user decision ─────────
  try {
    const prisma = await db();
    const { isSameDecisionQuestion, answerOwnerQuestion, isCounterQuestionRow } = await import('./owner-questions');
    const answeredAll = await prisma.ownerQuestion.findMany({
      where: { status: 'answered', resolvedAt: { gte: new Date(now.getTime() - DUPLICATE_ANSWER_LOOKBACK_MS) } },
      orderBy: { createdAt: 'desc' },
      take: SCAN_BATCH,
    });
    // CanLaw 2026-09-15: a row the owner answered WITH A QUESTION is not a
    // decision that can resolve anything — least of all the RE-FILED question
    // (a superset of the same text) the lane was told to raise.
    const answered = answeredAll.filter((a: any) => !isCounterQuestionRow(a));
    const open = await prisma.ownerQuestion.findMany({ where: { status: 'open' }, take: SCAN_BATCH });
    stats.scanned.answeredRows = answered.length;
    stats.scanned.openRows = open.length;
    let acted = 0;
    for (const openRow of open) {
      if (acted >= ACT_BATCH) break;
      const dupe = answered.find(
        (a: any) => a.userId === openRow.userId && a.id !== openRow.id && a.answer && isSameDecisionQuestion(a.question, openRow.question),
      );
      if (!dupe || typeof dupe.answer !== 'string' || !dupe.answer) continue;
      try {
        // The canonical answer path: conditional flip + note + wake + ledger +
        // gate unblock + duplicate fan-out. 'not_open' = lost a race — fine.
        // Ticket 50bcd1e7 (review F1): this replay re-delivers an ALREADY
        // STORED answer (whose provenance is dupe.answeredBy) — it is never
        // fresh owner input, so the vault leg must see the row's true
        // provenance, never the 'owner' default. A 'default'/'supervisor'
        // stored answer now replays with its own provenance and is refused by
        // the vault leg (as designed); an owner answer replays as owner.
        // Ticket c1714329 (2026-10-21): replayed=true — the typed-gate
        // conversational wake must NOT fire on this replay (an owner-answered
        // row's text bounced onto a still-open typed-gated dupe would
        // otherwise re-wake the lane every 5-minute pass for 24h).
        const replayAnsweredBy = dupe.answeredBy === 'supervisor' ? 'supervisor' : dupe.answeredBy === 'default' ? 'default' : 'owner';
        const res = await answerOwnerQuestion(openRow.id, openRow.userId, dupe.answer, { answeredBy: replayAnsweredBy, replayed: true });
        if (res === 'ok') stats.dupesResolved += 1;
        acted += 1;
      } catch (err: any) {
        void logSweep('warn', `owner-gate-sweeper: dupe resolve failed for ${openRow.id}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    void logSweep('warn', `owner-gate-sweeper: action (b) failed: ${err?.message ?? err}`);
  }

  // ── (c) STALE live ask_user pendings matching an answered question ─────────
  try {
    const r = await redis();
    if (r) {
      const { isSameDecisionQuestion } = await import('./owner-questions');
      const prisma = await db();
      // Bounded SCAN over the presence keys (the fleet is small; two pages of
      // COUNT 100 is far past any real pending cardinality).
      const keys: string[] = [];
      let cursor = 0;
      for (let i = 0; i < 10; i++) {
        const page = await r.scan(cursor, { MATCH: 'confirm:pending:*', COUNT: 100 }).catch(() => null);
        if (!page) break;
        keys.push(...(page.keys ?? []));
        cursor = Number(page.cursor ?? 0);
        if (!cursor) break;
      }
      const values = keys.length ? await r.mGet(keys).catch(() => []) : [];
      const minAge = PENDING_ANSWER_MIN_AGE_MS();
      let acted = 0;
      for (let i = 0; i < keys.length && acted < ACT_BATCH; i++) {
        const raw = values[i];
        if (typeof raw !== 'string' || !raw) continue;
        let entry: any = null;
        try { entry = JSON.parse(raw); } catch { continue; }
        if (entry?.kind !== 'question' || typeof entry.id !== 'string' || typeof entry.question !== 'string') continue;
        const ts = Number(entry.ts) || 0;
        stats.scanned.pendings += 1;
        if (!ts || now.getTime() - ts < minAge) continue; // too fresh — the owner gets the floor first
        const chatId = keys[i].slice('confirm:pending:'.length);
        if (!chatId) continue;
        try {
          const answeredRows = await prisma.ownerQuestion.findMany({
            where: { chatId, status: 'answered' }, orderBy: { createdAt: 'desc' }, take: 25,
          });
          const match = answeredRows.find((a: any) => a.answer && isSameDecisionQuestion(a.question, entry.question));
          if (!match) continue;
          const answer = String(match.answer).slice(0, 8000);
          // Ticket 50bcd1e7 (review F1/N5): the re-delivered answer is
          // ALREADY-STORED text whose provenance is match.answeredBy — pass it
          // through so the vault leg refuses a non-owner replay.
          const replayAnsweredBy = match.answeredBy === 'supervisor' ? 'supervisor' : match.answeredBy === 'default' ? 'default' : 'owner';
          // Durable FIRST (first-writer-wins), then the mailbox the parked
          // run's heartbeat/cancelPoll drains, then the flag-row closure.
          const { markDurableResolved } = await import('../coding/pending-durable');
          await markDurableResolved('question', entry.id, 'answered', answer);
          const { publishQuestionResolution } = await import('../coding/session-run-lock');
          await publishQuestionResolution(chatId, entry.id, answer);
          const { resolveOwnerQuestionsForChatAnswer } = await import('./owner-questions');
          await resolveOwnerQuestionsForChatAnswer({ chatId, userId: match.userId, askedQuestion: entry.question, answer, answeredBy: replayAnsweredBy });
          stats.pendingsResolved += 1;
          acted += 1;
        } catch (err: any) {
          void logSweep('warn', `owner-gate-sweeper: pending resolve failed for ${entry.id}: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err: any) {
    void logSweep('warn', `owner-gate-sweeper: action (c) failed: ${err?.message ?? err}`);
  }

  // ── (d) Todo 77c88942 item 2: OPEN credential-gated rows whose envKey NOW has
  // a store_secret receipt (or store row) — self-heal the gate the moment the
  // credential actually lands. The owner pastes the key through store_secret
  // (never the answer box — that path records a mismatch and keeps the row
  // open), the receipt mints with ids {envKey}, and THIS arm resolves the row
  // through the canonical answer path (note + wake + ledger + gate fan-out)
  // without another owner action. Batch-capped, never throws.
  try {
    const prisma = await db();
    const gated = await prisma.ownerQuestion.findMany({
      where: { status: 'open', expectedAnswerType: { startsWith: 'credential:' } },
      take: SCAN_BATCH,
    });
    if (gated.length) {
      const { parseExpectedAnswerType, credentialLifted } = await import('./credential-gate');
      const { answerOwnerQuestion } = await import('./owner-questions');
      for (const row of gated.slice(0, ACT_BATCH)) {
        try {
          const expected = parseExpectedAnswerType(row.expectedAnswerType, row.question);
          if (expected.type !== 'credential' || !expected.envKey) continue;
          // Ticket 9759bf5c (2026-10-30): the envKey must be proved by a
          // credential NEWER than the ask. Before, any row that existed
          // answered the card — on two consecutive asks for a FRESH key (a
          // value known dead) the sweeper auto-answered within ~90 s on the
          // dead row it was asked to REPLACE, so the owner's inbox showed the
          // wall resolved and nobody acted. The question's own createdAt is
          // the bar; a decline leaves the card OPEN and counted.
          const lift = await credentialLifted(prisma, row.userId, expected.envKey, {
            notBefore: row.createdAt instanceof Date ? row.createdAt : null,
          });
          if (!lift.lifted) {
            if (lift.declinedBy) {
              // The stored value EXISTS and was REFUSED as evidence. Never
              // answer the card on it (that is the false green); leave it OPEN
              // for the owner and say so where the fleet reads it.
              stats.credentialGatesDeclined += 1;
              void logSweep('warn', `owner-gate-sweeper: credential gate ${row.id} left OPEN — the stored ${expected.envKey} is not evidence for this ask (${lift.declinedBy}; ticket 9759bf5c)`);
            }
            continue;
          }
          // The canonical path — the note names the envKey (never the value)
          // and what lifted it.
          // Ticket c54074df / 7caf07ed (2026-10-21): the sweep's auto-heal is a
          // MACHINE action and is stamped as one. The pre-fix call passed no
          // answeredBy option, so the 'owner' default recorded the canned
          // "credential … stored" text as the OWNER's answer on two incident
          // cards that the owner never touched — forensics read them back as
          // owner pastes that never happened. 'default' is the truthful
          // provenance (the preset/auto-sweep class: the answererNote and
          // wakeHeader render the auto-resolve wording, isCounterQuestionRow
          // already excludes it, and — decisive vs 'supervisor' — the
          // owner-only-class guard in answerOwnerQuestion refuses a supervisor
          // answer on credential-class rows outright). The credential-gate
          // text-never-resolves rule still governs: only a verified store
          // state (credentialLifted now slot-validates the row's value AND
          // requires it to be newer than this card) opens the gate, never
          // this text. Ticket 9759bf5c: the stamp now says WHICH bar was
          // cleared, so a later forensics read cannot mistake a genuine
          // post-ask landing for the old "the slot holds something" false
          // green that resolved two cards on a dead pair.
          const res = await answerOwnerQuestion(
            row.id, row.userId,
            `credential ${expected.envKey} stored (auto-heal: the gate sweeper verified the stored credential — ${lift.via === 'receipt' ? 'a store_secret receipt' : 'a slot-validated store row'} dated AFTER this card was filed — todo 77c88942; no new value was pasted through the answer box)`,
            { answeredBy: 'default', sweeperAutoHeal: true },
          );
          if (res === 'ok') stats.credentialGatesResolved += 1;
        } catch (err: any) {
          void logSweep('warn', `owner-gate-sweeper: credential-gate resolve failed for ${row.id}: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err: any) {
    void logSweep('warn', `owner-gate-sweeper: action (d) failed: ${err?.message ?? err}`);
  }

  const actedTotal = stats.unblockedTodos + stats.unblockedGoals + stats.heldTodos + stats.heldGoals + stats.dupesResolved + stats.pendingsResolved + stats.credentialGatesResolved;
  // Ticket 9759bf5c (review finding F1): a DECLINE is an OUTCOME, not a no-op.
  // Before this, a pass whose only event was a withheld false green emitted no
  // loop_metrics row at all (actedTotal stayed 0), so the very counter that
  // proves the fix is working — and the post-deploy metric read that closes
  // this ticket — could never see it. Declines are held-apart from actedTotal
  // (they must not inflate the "acted" value) but they DO open the emit gate.
  const declinedTotal = stats.credentialGatesDeclined;
  if (actedTotal > 0 || declinedTotal > 0) {
    try {
      const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('./loop-metrics.service');
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.OWNER_GATE_SWEEP,
        value: actedTotal,
        stamp: { profile: 'platform', triggerKind: 'schedule' },
        meta: {
          unblockedTodos: stats.unblockedTodos, unblockedGoals: stats.unblockedGoals,
          heldTodos: stats.heldTodos, heldGoals: stats.heldGoals,
          dupesResolved: stats.dupesResolved, pendingsResolved: stats.pendingsResolved,
          credentialGatesResolved: stats.credentialGatesResolved,
          credentialGatesDeclined: declinedTotal,
          scanned: stats.scanned,
        },
      });
    } catch { /* telemetry is fire-and-forget */ }
    void logSweep('info', `owner-gate-sweeper: acted on ${actedTotal} gate(s) — todos +${stats.unblockedTodos}, goals +${stats.unblockedGoals}, holds +${stats.heldTodos + stats.heldGoals}, dupes +${stats.dupesResolved}, pendings +${stats.pendingsResolved}${declinedTotal ? `, credential declines ${declinedTotal} (false green withheld)` : ''}`);
  }
  return stats;
}

let sweeperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Wire the backstop (server.ts, next to startChatOrphanSweeper). Per-web-
 * instance and blue-green safe: every write underneath is a conditional
 * one-shot flip (ownerQuestion.updateMany on status='open', todo/goal
 * updateMany on still-blocked-on-this-question), so two instances sweeping
 * concurrently converge instead of double-acting. Kill switch:
 * OWNER_GATE_SWEEPER_DISABLED=1.
 */
export function startOwnerGateSweeper(): void {
  if (process.env.OWNER_GATE_SWEEPER_DISABLED === '1') {
    void logSweep('info', 'owner-gate sweeper DISABLED (OWNER_GATE_SWEEPER_DISABLED=1)');
    return;
  }
  if (sweeperTimer) return; // double-start guard (tests, hot reload)
  sweeperTimer = setInterval(() => {
    void sweepOwnerGatesOnce().catch((err: any) => {
      void logSweep('warn', `owner-gate-sweeper: sweep failed: ${err?.message ?? err}`);
    });
  }, SWEEP_MS());
  sweeperTimer.unref?.();
  void logSweep('info', `owner-gate sweeper started (${Math.round(SWEEP_MS() / 1000)}s cadence, pending min-age ${Math.round(PENDING_ANSWER_MIN_AGE_MS() / 60000)}m)`);
}

/** Test hook: stop the interval. */
export function stopOwnerGateSweeper(): void {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = null;
}
