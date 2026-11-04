/**
 * DERAIL-RESCUE CONTINUATION WAKE (ticket ff1fa1b5, 2026-09-20).
 *
 * THE GAP: the 0a3694f7 loop-containment (ticket 54a172ac) reliably stops a
 * derailing run from touching state, and the 431518a2 re-anchor injects ONE
 * correct intended-tool steer mid-run — but n=3 same-day runs showed the
 * steer does not RESCUE the run: the decoder re-locks, the breaker ladder
 * (withhold → perma → terminal) ends the run with "The next scheduled firing
 * starts fresh", and the intended work is never done. For lanes without an
 * imminent firing — or any lane, since the next firing starts BLIND — the
 * honest terminal note converts into a burned run, not completed work. The
 * one observed recovery was MANUAL: a supervisor steer plus a fresh run
 * (nightly-engineer lane b92ef13f, adjudication delivered only at 18:31Z).
 *
 * THE FIX (the ticket's option (b) — option (a), a one-tap confirm, is
 * rejected: machine runs can never confirm staged actions, and a mid-run
 * injection still fights the locked decoder; the fresh run is what recovers):
 * when a MACHINE run hits the terminal derail state (agent.ts ended_run),
 * enqueue ONE durable continuation wake to the SAME chat whose prompt carries
 * the intended next step VERBATIM (the intended tool when the derail detector
 * named one), the grounding rules that killed the old run, and the goal
 * context — the fresh run starts with a clean decoder and the firing-start
 * tool-discipline preamble at full strength. The wake rides the hook outbox
 * (enqueueDirectWake → the chat's system:direct-wake todo_wake self-hook):
 * durable across deploys, busy-parked (alarm-class, attempts frozen),
 * cap-bypassed, and EXEMPT from the 57154856 retired-target auto-pause
 * (system:* hooks) — a derailed lane may own no todos and must still be
 * rescued.
 *
 * BOUNDS (a rescue must never become the loop it replaces):
 *   - MACHINE runs only (input.userTurnAt set ⇒ the human can steer — skip);
 *   - per-chat budget: at most DERAIL_RESCUE_MAX_PER_DAY (default 2) rescues
 *     per 24 h sliding window (Redis counter) — a chain of derailing rescues
 *     dies after two, and the breaker path stays terminal exactly as before.
 *
 * Best-effort: never throws into the agent loop. Telemetry rides the caller's
 * guard_strike seam 'tool_derail_rescue' (derail-class forensics stay on
 * kind=guard_strike with meta.seam — the 13b2f286 adjudication doctrine).
 */

import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

const SOURCE = 'derail-rescue';
export const DERAIL_RESCUE_TTL_SEC = 24 * 3600;
const BUDGET_KEY = (chatId: string) => `derail-rescue:${chatId}`;
const id8 = (s: unknown): string => String(s ?? '').slice(0, 8);

export function derailRescueMaxPerDay(): number {
  const n = Number(process.env.DERAIL_RESCUE_MAX_PER_DAY ?? 2);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

export interface DerailRescueInput {
  sessionId: string;          // the chat whose run just hit the terminal derail state
  runId?: string;
  tools: string[];            // the looping tool(s) the breaker tripped on
  intended: string | null;    // the tool the derail detector says the model MEANT
  trips: number;              // total derail episodes in the ended run
  goalHint: string | null;    // the ended run's firing message (truncated into the brief)
  userTurnAt?: Date;          // presence ⇒ user-anchored run — the human can steer
}

export function renderDerailRescueWake(input: DerailRescueInput, count: number, max: number): string {
  const tools = input.tools.length ? input.tools.join(', ') : 'unknown';
  const intendedLine = input.intended
    ? `Evidence from that run says it was trying to call ${input.intended} when it derailed — that call never executed.`
    : 'The looping calls never executed.';
  const firstAction = input.intended
    ? `FIRST ACTION: make the ${input.intended} call the previous run could not — with its real, freshly-grounded parameters.`
    : 'FIRST ACTION: redo the blocked step with the correct tool from your ACTUAL offered tool list (never a narrated or remembered name).';
  const goal = String(input.goalHint ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    `[DERAIL RESCUE — harness continuation, not typed by the user] Your previous run${input.runId ? ` ${id8(input.runId)}` : ''} was ENDED by the derail breaker after ${input.trips} wrong-tool episode(s) (looping tool(s): ${tools}). Containment stopped the damage, but the run's work was NOT done. ${intendedLine}`,
    `Resume the work NOW, in this fresh run:`,
    `1. RE-GROUND: every entity id (file / ticket / todo / schedule / chat) must come from a REAL tool result in THIS run — list_files, todo_list, get_feedback, list_schedules, … — never from memory, narration, or invention. Placeholder-id emission is exactly what killed the last run.`,
    `2. ${firstAction}`,
    `3. Then continue the plan normally — the plan board and worktree are exactly where the ended run left them.`,
    goal ? `Goal context from the ended run: "${goal}"` : null,
    count >= max
      ? `This is derail-rescue continuation #${count} of at most ${max} for this chat in 24 h — the budget is now SPENT: if this run also derails to terminal, NO further automatic continuation fires (the breaker ends it and a supervisor must steer).`
      : `This is derail-rescue continuation #${count} of at most ${max} for this chat in 24 h — if this run also derails to terminal, the harness may fire one more continuation (${max - count} left in the 24 h budget), each still ended by the breaker before it can touch state.`,
  ].filter((l): l is string => Boolean(l)).join('\n');
}

/**
 * Enqueue the continuation wake for a run that just hit the terminal derail
 * state. Returns what happened (the caller records telemetry + transcript
 * parts); { rescued:false } on every skip path — never throws.
 */
export async function enqueueDerailRescue(input: DerailRescueInput): Promise<{ rescued: boolean; reason: string; count?: number; max?: number }> {
  if (input.userTurnAt) return { rescued: false, reason: 'user_run' };
  const max = derailRescueMaxPerDay();
  if (max <= 0) return { rescued: false, reason: 'disabled' };
  try {
    const key = BUDGET_KEY(input.sessionId);
    const used = Number(await (redisClient as any).get(key).catch(() => null)) || 0;
    if (used >= max) {
      logger.info(`${SOURCE}: chat ${id8(input.sessionId)} at the ${max}/24h rescue budget — terminal end stands (no continuation)`, { source: SOURCE });
      return { rescued: false, reason: 'budget' };
    }
    const count = used + 1;
    const { enqueueDirectWake } = await import('../platform/hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: input.sessionId,
      prompt: renderDerailRescueWake(input, count, max),
      meta: {
        origin: SOURCE, kind: 'derail_rescue',
        runId: input.runId ?? null, intended: input.intended, tools: input.tools,
        trips: input.trips, rescueCount: count, rescueMax: max,
      },
    });
    if (!res?.ok) return { rescued: false, reason: `wake_failed:${res?.error ?? 'unknown'}` };
    // Budget stamps only on a REAL enqueue — a failed wake must not burn one
    // of the day's two continuations.
    await (redisClient as any).set(key, String(count), { EX: DERAIL_RESCUE_TTL_SEC }).catch(() => {});
    logger.info(
      `${SOURCE}: chat ${id8(input.sessionId)} run ${id8(input.runId)} derailed to terminal — continuation #${count}/${max} enqueued${input.intended ? ` (intended ${input.intended})` : ''}`,
      { source: SOURCE },
    );
    return { rescued: true, reason: 'woken', count, max };
  } catch (err: any) {
    logger.warn(`${SOURCE}: rescue failed for ${id8(input.sessionId)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return { rescued: false, reason: 'error' };
  }
}
