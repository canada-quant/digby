/**
 * Run/attention/schedule CONTROL tools (agent capability gap audit P0, owner
 * 2026-09-24 "make sure the main digby review agent is implementing all of
 * this autonomously"):
 *
 *   stop_run             {chatId, reason?}                 — stop a chat's active run
 *   answer_chat_question {chatId, questionId, answer}      — answer an ask_user wait
 *   approve_request      {chatId, approvalId, decision}    — decide a permission request
 *   pause_schedule       {id}                              — enabled:false (kept, resumable)
 *   resume_schedule      {id}                              — enabled:true  (cadence re-armed)
 *
 * All five are CONSEQUENTIAL and TARGET-SCOPED exactly like send_chat_message
 * (platform-tools.ts CONSEQUENTIAL_PLATFORM_TOOLS / TARGET_SCOPED_*; autonomy
 * .service AUTO_MODE_TARGET_SCOPED_TOOLS / PARENT_IMPLICIT_TOOLS /
 * AUTONOMY_GRANTABLE_TOOLS): a lane's own chat and first-degree children
 * resolve without a card, a supervisor seat is pre-granted, anything else
 * stages a user-turn confirmation. approve_request additionally REFUSES, in a
 * machine-triggered run, to decide an approval whose tool is ASK-ONLY
 * (delete_chat / delete_project) or whose tool cannot be read from the durable
 * record — humans decide destructive requests, always.
 *
 * Every executor delegates to the SAME service functions the UI/REST twins
 * use (stopAgentRun / stopRun / postChatQuestion / postQuestion /
 * postApproval / setChatScheduleEnabled), so the tool can never do what the
 * button cannot. Heavy modules ride DYNAMIC imports (this module must stay
 * import-light — platform-tools.ts imports it statically).
 */

import { PLATFORM_ASK_ONLY_TOOLS } from './platform-tool-names';

export const CONTROL_TOOL_NAMES = ['stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule'] as const;
export type ControlToolName = (typeof CONTROL_TOOL_NAMES)[number];
export const isControlTool = (name: string): name is ControlToolName => (CONTROL_TOOL_NAMES as readonly string[]).includes(name);

const CONFIRMATION_ID_PROP = {
  confirmationId: { type: 'string', description: 'Omit on the first call. If the call returns needsConfirmation with a confirmationId, re-call with just this confirmationId after the user confirms in a NEW message.' },
};

export const CONTROL_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'stop_run',
      description: "STOP the run currently executing in one of the user's chats — the same hard stop as the Stop button: a coding session's active run finalizes 'cancelled' after its next cancel poll (a still-queued run is cancelled right after its claim); a plain chat's detached run is cancelled and any ask_user it was parked on is released. Returns {stopping:true, runId?} when a stop was requested, {stopping:false} when nothing was running (the chat is idle — say so, do not report a cancellation). Use it when a lane is looping, working the wrong thing, or must stand down NOW; to merely redirect a worker, send_chat_message (a steer lands between steps) is gentler. Machine-triggered runs may stop their OWN chat and first-degree child sessions without confirmation; supervisor seats are pre-granted; other targets stage a confirmation.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'The chat whose active run to stop (full id or a unique ≥8-char prefix of one of your chats).' },
          reason: { type: 'string', description: 'One line for the audit trail and the stopped chat\'s transcript note.' },
          ...CONFIRMATION_ID_PROP,
        },
        required: ['chatId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'answer_chat_question',
      description: "Answer an ask_user question a chat's run is BLOCKED on (get_chat_status → attention.pendingQuestions lists the ids; the hook event attention_needed carries them too) — exactly like typing the answer into that chat's question card. The delivered answer is stamped as coming from THIS chat (an agent acting under the owner's standing directives), never as the owner's own words, so the waiting run can weigh it. Returns {ok:true} once the answer is delivered to the live wait (or recorded for a restarted run to replay), {ok:false, reason} when the id is unknown, expired or already answered. Prefer this over a send_chat_message when the run is parked on a question: a message queues BEHIND the wait; an answer releases it. Same target scoping as send_chat_message.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'The chat whose run asked the question.' },
          questionId: { type: 'string', description: 'The pending question id from get_chat_status.attention.pendingQuestions or the attention_needed event.' },
          answer: { type: 'string', description: 'The answer text (≤ 8000 chars).' },
          ...CONFIRMATION_ID_PROP,
        },
        required: ['chatId', 'questionId', 'answer'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'approve_request',
      description: "Decide a PERMISSION REQUEST a coding session's run is blocked on (get_chat_status → attention.pendingApprovals lists the ids): decision 'allow' runs that ONE tool call, 'deny' refuses it — agents may never answer 'always'. HARD RULE: a machine-triggered run (no user present) may NOT approve a request for a destructive ask-only tool (delete_chat / delete_project) or one whose tool cannot be read — those wait for a human; the call is refused with reason 'human_only'. Returns {ok:true, decision} once delivered, {ok:false, reason} when unknown/expired/already decided. Same target scoping as send_chat_message.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'The chat whose run raised the request.' },
          approvalId: { type: 'string', description: 'The pending approval id from get_chat_status.attention.pendingApprovals.' },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          reason: { type: 'string', description: 'One line for the audit trail.' },
          ...CONFIRMATION_ID_PROP,
        },
        required: ['chatId', 'approvalId', 'decision'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pause_schedule',
      description: "PAUSE one of the user's schedules (enabled:false) — it keeps its prompt, cadence and run history and can be resumed later with resume_schedule; cancel_schedule is the permanent retire. Pause ≠ cancel: pause a lane's cadence while its work is blocked or under review, cancel it when the work is finished. The id may be the full id OR a unique ≥8-char prefix. Machine-triggered runs may pause schedules in their own scope (own chat / first-degree children / same-owner fleet sibling) without confirmation. Returns the schedule view and whether anything changed.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Schedule id (from list_schedules / schedule_get).' },
          reason: { type: 'string', description: 'One line for the audit trail.' },
          ...CONFIRMATION_ID_PROP,
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resume_schedule',
      description: "RESUME a paused/cancelled schedule (enabled:true): the next firing is recomputed from now, busy-skip streaks reset. Refused honestly when the row already completed its runs (create a new schedule instead), when the chat already has the maximum active schedules, or when a goal-gate auto-parked row's project is still dormant (it re-arms itself once live work reappears). The id may be the full id OR a unique ≥8-char prefix. Same scoping as pause_schedule.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Schedule id (from list_schedules / schedule_get).' },
          reason: { type: 'string', description: 'One line for the audit trail.' },
          ...CONFIRMATION_ID_PROP,
        },
        required: ['id'],
      },
    },
  },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null };
type Envelope = { ok: boolean; tool: ControlToolName; ids: Record<string, string | null | undefined>; [k: string]: unknown };
const out = (e: Envelope): string => JSON.stringify(e, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);

/** Answer/decision provenance stamp: the waiting run must never read an agent's words as the owner's. */
export function agentAnswerStamp(callerChatId: string, userTurnAt?: Date | null): string {
  return `[Answered by chat ${short(callerChatId)} — a Digby agent acting under the owner's standing directives${userTurnAt ? ', from a user-anchored turn' : ', in an unattended machine run'}; not the owner's own words]`;
}

async function db(): Promise<any> { return (await import('../../../config/database')).default; }

/** Resolve a chat id (or unique own-scoped prefix) the acting user OWNS; null when not owned/unknown. */
async function ownedChat(platform: any, userId: string, raw: string): Promise<{ id: string; coding: boolean } | null> {
  const id = typeof platform?.resolveOwnedChatIdPrefix === 'function'
    ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw)
    : raw;
  if (!id) return null;
  const prisma = await db();
  const chat = await prisma.crossModelChat.findUnique({ where: { id }, select: { id: true, userId: true, codingState: { select: { id: true } } } }).catch(() => null);
  if (!chat || chat.userId !== userId) return null;
  return { id: chat.id, coding: !!chat.codingState };
}

/**
 * stop_run on an IDLE target (peer verification 2026-09-25): the consequential
 * gate ran before the executor's idle short-circuit, so a machine caller was
 * handed a confirmation card for a run that did not exist. Probe the target's
 * run state first; an idle target returns the executor's own "nothing to
 * cancel" envelope without staging anything. Null = a run IS active (or the
 * target could not be resolved) → the normal gated path decides.
 */
export async function stopRunIdleShortCircuit(ctx: Ctx, args: any, deps: { platform: any }): Promise<string | null> {
  try {
    const raw = String(args?.chatId || '').trim();
    if (!raw) return null;
    const chat = await ownedChat(deps.platform, ctx.userId, raw);
    if (!chat) return null;
    if (chat.coding) {
      const { getActiveRunForSession } = await import('../coding/run-state');
      const active = await getActiveRunForSession(chat.id).catch(() => undefined);
      if (active === undefined) return null;
      if (!active) return out({ ok: true, tool: 'stop_run', ids: { chatId: chat.id }, stopping: false, message: 'No active or queued run in that coding session — it is idle. Nothing was cancelled.' });
      return null;
    }
    const { chatRunKey } = await import('../chat-agent/chat-agent.service');
    const { isRunActive } = await import('../coding/live-runs');
    if (isRunActive(chatRunKey(chat.id))) return null;
    const { hasRemoteChatRun } = await import('../chat-agent/chat-busy');
    if (await hasRemoteChatRun(chat.id)) return null;
    return out({ ok: true, tool: 'stop_run', ids: { chatId: chat.id }, stopping: false, message: `Chat ${short(chat.id)} has no run in progress — nothing to stop.` });
  } catch {
    return null;
  }
}

/** The owner-scoped schedule row a pause/resume call targets, or null (unknown / not owned / unresolved). */
async function ownedScheduleState(userId: string, raw: string): Promise<{ id: string; sessionId: string; enabled: boolean; nextRunAt: string | null; lastStatus: string | null } | null> {
  if (!raw) return null;
  const { resolveScheduleIdForUser } = await import('../coding/schedule.service');
  const scheduleId = await resolveScheduleIdForUser(userId, raw).catch(() => null);
  if (!scheduleId) return null;
  const prisma = await db();
  const row = await prisma.chatSchedule.findUnique({
    where: { id: scheduleId },
    select: { id: true, sessionId: true, userId: true, enabled: true, nextRunAt: true, lastStatus: true },
  }).catch(() => null);
  if (!row || row.userId !== userId || typeof row.enabled !== 'boolean') return null;
  const next = row.nextRunAt instanceof Date ? row.nextRunAt.toISOString() : (row.nextRunAt ? String(row.nextRunAt) : null);
  return { id: row.id, sessionId: row.sessionId, enabled: row.enabled, nextRunAt: next, lastStatus: row.lastStatus ?? null };
}

/**
 * pause_schedule / resume_schedule on a schedule ALREADY in the requested
 * state (WI-J, 2026-09-25 — the stop_run idle pattern above): the executed
 * path answers "was already paused/enabled — nothing changed", so a card for
 * it is a doomed no-op the owner would click into nothing. Answer that
 * envelope BEFORE the gate, without staging. Null = a real state change is
 * requested (or the target could not be resolved) → the gated path decides.
 * Skipped when a confirmationId rides the call (the confirm path must consume
 * its card).
 */
export async function scheduleToggleMootShortCircuit(ctx: Ctx, name: 'pause_schedule' | 'resume_schedule', args: any): Promise<string | null> {
  try {
    if (typeof args?.confirmationId === 'string' && args.confirmationId) return null;
    const s = await ownedScheduleState(ctx.userId, String(args?.id || '').trim());
    if (!s) return null;
    const enabled = name === 'resume_schedule';
    if (s.enabled !== enabled) return null;
    // ids carry the schedule only (review 2026-09-25): pause/resume mint an
    // ok:true receipt, and follow-through's actedTowardLane counts ANY ok
    // receipt whose ids name the lane as "acted toward it" — a no-op must not
    // earn that. The lane id rides top-level for the model's information.
    return out({ ok: true, tool: name, ids: { scheduleId: s.id }, chatId: s.sessionId, changed: false, enabled, nextRunAt: s.nextRunAt, lastStatus: s.lastStatus, message: `Schedule ${short(s.id)} was already ${enabled ? 'enabled' : 'paused'} — nothing changed${enabled && s.nextRunAt ? ` (next firing ${s.nextRunAt})` : ''}. No confirmation card was staged.` });
  } catch {
    return null;
  }
}

/**
 * What is TRUE RIGHT NOW about a control tool's target, for the staged
 * confirmation envelope (WI-J, 2026-09-25): a staged pause_schedule used to
 * hand the model `pause_schedule({"id":…})` with nothing saying the schedule
 * remains ENABLED and when it next fires, so a lane could narrate the pause
 * as done. Returns { currentState, note } — the note is one sentence the gate
 * prepends to the envelope's instructions — or null when the target cannot be
 * read (the envelope then carries no state, exactly as before). Never throws.
 */
export async function describeControlTargetState(ctx: Ctx, name: string, args: any, deps: { platform: any }): Promise<{ currentState: Record<string, unknown>; note: string } | null> {
  try {
    if (name === 'pause_schedule' || name === 'resume_schedule') {
      const s = await ownedScheduleState(ctx.userId, String(args?.id || '').trim());
      if (!s) return null;
      const currentState = { scheduleId: s.id, chatId: s.sessionId, enabled: s.enabled, nextRunAt: s.nextRunAt, lastStatus: s.lastStatus };
      const note = s.enabled
        ? `Nothing has changed yet: schedule ${short(s.id)} remains ENABLED and will fire at ${s.nextRunAt ?? 'its next due time'} until the card is confirmed.`
        : `Nothing has changed yet: schedule ${short(s.id)} remains PAUSED (enabled:false) and will not fire until the card is confirmed.`;
      return { currentState, note };
    }
    if (name === 'stop_run') {
      const chat = await ownedChat(deps.platform, ctx.userId, String(args?.chatId || '').trim());
      if (!chat) return null;
      let runId: string | null = null;
      let running = false;
      if (chat.coding) {
        const { getActiveRunForSession } = await import('../coding/run-state');
        const active: any = await getActiveRunForSession(chat.id).catch(() => null);
        running = !!active;
        runId = active?.id ?? null;
      } else {
        const { chatRunKey } = await import('../chat-agent/chat-agent.service');
        const { isRunActive } = await import('../coding/live-runs');
        running = isRunActive(chatRunKey(chat.id));
        if (!running) {
          const { hasRemoteChatRun } = await import('../chat-agent/chat-busy');
          running = await hasRemoteChatRun(chat.id);
        }
      }
      const currentState = { chatId: chat.id, running, ...(runId ? { runId } : {}) };
      const note = running
        ? `Nothing has changed yet: the run in chat ${short(chat.id)}${runId ? ` (run ${short(runId)})` : ''} is STILL EXECUTING until the card is confirmed.`
        : `Nothing has changed yet: chat ${short(chat.id)} shows no active run right now — confirming this card will stop whatever is running at that moment, if anything.`;
      return { currentState, note };
    }
    if (name === 'answer_chat_question' || name === 'approve_request') {
      const chat = await ownedChat(deps.platform, ctx.userId, String(args?.chatId || '').trim());
      if (!chat) return null;
      const what = name === 'answer_chat_question' ? `question ${short(String(args?.questionId || ''))}` : `request ${short(String(args?.approvalId || ''))}`;
      return {
        currentState: { chatId: chat.id, ...(name === 'answer_chat_question' ? { questionId: args?.questionId ?? null } : { approvalId: args?.approvalId ?? null, decision: args?.decision ?? null }) },
        note: `Nothing has changed yet: ${what} in chat ${short(chat.id)} is STILL WAITING — the run stays blocked until the card is confirmed.`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function executeControlTool(ctx: Ctx, name: ControlToolName, args: any, deps: { platform: any }): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  switch (name) {
    case 'stop_run': {
      const raw = String(args?.chatId || '').trim();
      if (!raw) return out({ ok: false, tool: name, ids: {}, reason: 'invalid', message: 'chatId is required.' });
      const chat = await ownedChat(platform, userId, raw);
      if (!chat) return out({ ok: false, tool: name, ids: { chatId: raw }, reason: 'not_found', message: 'No chat of yours matches that id (full id or a unique ≥8-char prefix). list_chats shows the ids.' });
      const reason = typeof args?.reason === 'string' ? args.reason.slice(0, 300) : '';
      if (chat.coding) {
        const { getActiveRunForSession } = await import('../coding/run-state');
        const { requestRunCancel } = await import('../coding/session-run-lock');
        // STOP MEANS STOP (2026-09-29, continuation-guard.ts): queued harness
        // continuations are cancelled FIRST (same order as the Stop button),
        // so a stop never leaves a follow-up behind to restart the lane.
        const { cancelQueuedContinuations } = await import('../coding/continuation-guard');
        const cancelledContinuations = (await cancelQueuedContinuations(chat.id, `continuation cancelled: stop_run from chat ${short(ctx.sessionId)}`)).length;
        const active = await getActiveRunForSession(chat.id).catch(() => null);
        if (!active) return out({ ok: true, tool: name, ids: { chatId: chat.id }, stopping: false, ...(cancelledContinuations ? { cancelledContinuations } : {}), message: cancelledContinuations ? `No run was executing in that coding session; ${cancelledContinuations} queued continuation run(s) were cancelled.` : 'No active or queued run in that coding session — it is idle. Nothing was cancelled.' });
        // ALARM-CAUSE-AWARE (2026-10-20): the requester rides cancel-actor:<runId> so the run's
        // run_failed names who stopped it (a quiet row; the requester is never woken by its own stop).
        await requestRunCancel(chat.id, { runId: (active as any).id ?? null, actorChatId: ctx.sessionId ?? null });
        await note(chat.id, userId, `Stop requested by chat ${short(ctx.sessionId)}${reason ? ` — ${reason}` : ''} (stop_run).`);
        return out({ ok: true, tool: name, ids: { chatId: chat.id, runId: (active as any).id ?? null }, stopping: true, message: `Stop requested for run ${short((active as any).id ?? '')} in ${short(chat.id)}: it finalizes 'cancelled' at its next cancel poll (≤ 2 s; a queued run right after its claim). Confirm with get_chat_status.` });
      }
      const { chatRunKey } = await import('../chat-agent/chat-agent.service');
      const { isRunActive, cancelRun } = await import('../coding/live-runs');
      const key = chatRunKey(chat.id);
      if (isRunActive(key)) {
        cancelRun(key);
        const { resolvePendingForSession } = await import('../coding/question-registry');
        resolvePendingForSession(chat.id);
        await note(chat.id, userId, `Stop requested by chat ${short(ctx.sessionId)}${reason ? ` — ${reason}` : ''} (stop_run).`);
        return out({ ok: true, tool: name, ids: { chatId: chat.id }, stopping: true, message: `Stopping the run in chat ${short(chat.id)} (it was executing here; any pending question was released).` });
      }
      const { hasRemoteChatRun, requestChatRunStop } = await import('../chat-agent/chat-busy');
      if (await hasRemoteChatRun(chat.id)) {
        const landed = await requestChatRunStop(chat.id);
        if (landed) await note(chat.id, userId, `Stop requested by chat ${short(ctx.sessionId)}${reason ? ` — ${reason}` : ''} (stop_run).`);
        return out({ ok: landed, tool: name, ids: { chatId: chat.id }, stopping: landed, message: landed ? `Stop requested for chat ${short(chat.id)}: its run executes on the peer instance and stops at its next heartbeat poll.` : 'Could not leave the stop request (Redis) — retry once.' });
      }
      return out({ ok: true, tool: name, ids: { chatId: chat.id }, stopping: false, message: 'No run is active in that chat — it is idle. Nothing was cancelled.' });
    }

    case 'answer_chat_question': {
      const raw = String(args?.chatId || '').trim();
      const questionId = String(args?.questionId || '').trim();
      const answerRaw = typeof args?.answer === 'string' ? args.answer.trim() : '';
      if (!raw || !questionId || !answerRaw) return out({ ok: false, tool: name, ids: { chatId: raw, questionId }, reason: 'invalid', message: 'chatId, questionId and a non-empty answer are required.' });
      const chat = await ownedChat(platform, userId, raw);
      if (!chat) return out({ ok: false, tool: name, ids: { chatId: raw, questionId }, reason: 'not_found', message: 'No chat of yours matches that id.' });
      const answer = `${agentAnswerStamp(ctx.sessionId, ctx.userTurnAt)}\n${answerRaw}`.slice(0, 8000);
      const lock = await import('../coding/session-run-lock');
      const pendingSession = await lock.getQuestionPendingSession(questionId).catch(() => null);
      if (pendingSession) {
        if (pendingSession !== chat.id) return out({ ok: false, tool: name, ids: { chatId: chat.id, questionId }, reason: 'wrong_chat', message: 'That question belongs to a different chat.' });
        await lock.publishQuestionResolution(chat.id, questionId, answer);
        await afterQuestionAnswered(chat, userId, questionId, answer);
        return out({ ok: true, tool: name, ids: { chatId: chat.id, questionId }, delivered: 'live', message: `Answer delivered to the waiting run in ${short(chat.id)} (stamped as from chat ${short(ctx.sessionId)}).` });
      }
      if (!chat.coding) {
        // Plain chat run executing in THIS process: the local registry.
        const { questionSession, resolveAnswer } = await import('../coding/question-registry');
        if (questionSession(questionId) === chat.id) {
          if (!resolveAnswer(questionId, answer)) return out({ ok: false, tool: name, ids: { chatId: chat.id, questionId }, reason: 'unknown_or_expired', message: 'That question is no longer waiting (expired or already answered).' });
          await afterQuestionAnswered(chat, userId, questionId, answer);
          return out({ ok: true, tool: name, ids: { chatId: chat.id, questionId }, delivered: 'live', message: `Answer delivered to the waiting run in ${short(chat.id)}.` });
        }
      }
      // Durable fallback (worker restart / deploy / expired wait) — same as the REST twin.
      const durable = await import('../coding/pending-durable');
      const rec = await durable.loadDurablePending('question', questionId).catch(() => null);
      if (!rec || rec.sessionId !== chat.id) return out({ ok: false, tool: name, ids: { chatId: chat.id, questionId }, reason: 'unknown_or_expired', message: 'No pending question with that id on that chat (unknown, expired, or answered earlier). get_chat_status shows the live ids.' });
      if (rec.status === 'answered') return out({ ok: true, tool: name, ids: { chatId: chat.id, questionId }, delivered: 'already', message: 'That question was already answered — nothing to do.' });
      if (rec.status !== 'pending') return out({ ok: false, tool: name, ids: { chatId: chat.id, questionId }, reason: 'unknown_or_expired', message: 'That question expired before it was answered.' });
      await durable.markDurableResolved('question', questionId, 'answered', answer);
      const currentId = rec.fingerprint ? await durable.currentIdForFingerprint('question', rec.sessionId, rec.fingerprint).catch(() => null) : null;
      await lock.publishQuestionResolution(rec.sessionId, currentId ?? questionId, answer);
      await afterQuestionAnswered(chat, userId, currentId ?? questionId, answer);
      return out({ ok: true, tool: name, ids: { chatId: chat.id, questionId: currentId ?? questionId }, delivered: 'recorded', message: 'Answer recorded for the run (its live wait was gone — a restarted run re-asking the same question replays it).' });
    }

    case 'approve_request': {
      const raw = String(args?.chatId || '').trim();
      const approvalId = String(args?.approvalId || '').trim();
      const decision = String(args?.decision || '').trim();
      if (!raw || !approvalId) return out({ ok: false, tool: name, ids: { chatId: raw, approvalId }, reason: 'invalid', message: 'chatId and approvalId are required.' });
      if (decision !== 'allow' && decision !== 'deny') return out({ ok: false, tool: name, ids: { chatId: raw, approvalId }, reason: 'invalid', message: "decision must be 'allow' or 'deny' — agents may never grant 'always'." });
      const chat = await ownedChat(platform, userId, raw);
      if (!chat) return out({ ok: false, tool: name, ids: { chatId: raw, approvalId }, reason: 'not_found', message: 'No chat of yours matches that id.' });
      const durable = await import('../coding/pending-durable');
      const rec = await durable.loadDurablePending('approval', approvalId).catch(() => null);
      const tool = typeof rec?.tool === 'string' ? rec.tool : null;
      // HARD RULE: destructive/ask-only approvals — and approvals whose tool is
      // unreadable — are decided by humans only. A machine run may not launder
      // a delete through this tool. (User-anchored runs act as the user.)
      if (!ctx.userTurnAt && (!tool || (PLATFORM_ASK_ONLY_TOOLS as readonly string[]).includes(tool))) {
        return out({ ok: false, tool: name, ids: { chatId: chat.id, approvalId }, reason: 'human_only', pendingTool: tool, message: tool ? `Request ${short(approvalId)} is for ${tool}, a destructive ask-only tool — only a human may approve it. Leave it for the owner (flag_owner_question if it blocks work).` : `Request ${short(approvalId)}'s tool could not be read from its record — a machine run may not decide it. Leave it for the owner.` });
      }
      const lock = await import('../coding/session-run-lock');
      const pendingSession = await lock.getApprovalPendingSession(approvalId).catch(() => null);
      if (pendingSession) {
        if (pendingSession !== chat.id) return out({ ok: false, tool: name, ids: { chatId: chat.id, approvalId }, reason: 'wrong_chat', message: 'That request belongs to a different chat.' });
        await lock.publishApprovalResolution(chat.id, approvalId, decision as 'allow' | 'deny');
        await note(chat.id, userId, `Permission request ${short(approvalId)}${tool ? ` (${tool})` : ''} ${decision === 'allow' ? 'ALLOWED' : 'DENIED'} by chat ${short(ctx.sessionId)}${typeof args?.reason === 'string' && args.reason ? ` — ${String(args.reason).slice(0, 300)}` : ''} (approve_request).`);
        return out({ ok: true, tool: name, ids: { chatId: chat.id, approvalId }, decision, pendingTool: tool, delivered: 'live', message: `Decision '${decision}' delivered to the waiting run in ${short(chat.id)}.` });
      }
      if (!rec || rec.sessionId !== chat.id) return out({ ok: false, tool: name, ids: { chatId: chat.id, approvalId }, reason: 'unknown_or_expired', message: 'No pending request with that id on that chat (unknown, expired, or decided earlier).' });
      if (rec.status === 'answered' || rec.status === 'denied') return out({ ok: true, tool: name, ids: { chatId: chat.id, approvalId }, decision: rec.resolution ?? null, delivered: 'already', message: 'That request was already decided — nothing to do.' });
      if (rec.status !== 'pending') return out({ ok: false, tool: name, ids: { chatId: chat.id, approvalId }, reason: 'unknown_or_expired', message: 'That request expired before it was decided (the run treated it as denied).' });
      await durable.markDurableResolved('approval', approvalId, decision === 'deny' ? 'denied' : 'answered', decision);
      const currentId = rec.fingerprint ? await durable.currentIdForFingerprint('approval', rec.sessionId, rec.fingerprint).catch(() => null) : null;
      await lock.publishApprovalResolution(rec.sessionId, currentId ?? approvalId, decision as 'allow' | 'deny');
      return out({ ok: true, tool: name, ids: { chatId: chat.id, approvalId: currentId ?? approvalId }, decision, pendingTool: tool, delivered: 'recorded', message: 'Decision recorded (the live wait was gone — a restarted run re-asking the same call replays it).' });
    }

    case 'pause_schedule':
    case 'resume_schedule': {
      const enabled = name === 'resume_schedule';
      const raw = String(args?.id || '').trim();
      if (!raw) return out({ ok: false, tool: name, ids: {}, reason: 'invalid', message: 'id is required (list_schedules shows them).' });
      const { resolveScheduleIdForUser } = await import('../coding/schedule.service');
      const scheduleId = await resolveScheduleIdForUser(userId, raw).catch(() => null);
      if (!scheduleId) return out({ ok: false, tool: name, ids: { scheduleId: raw }, reason: 'not_found', message: 'No schedule of yours matches that id (full id or a unique ≥8-char prefix).' });
      const prisma = await db();
      const row = await prisma.chatSchedule.findUnique({ where: { id: scheduleId }, select: { id: true, sessionId: true, userId: true } }).catch(() => null);
      if (!row || row.userId !== userId) return out({ ok: false, tool: name, ids: { scheduleId }, reason: 'not_found', message: 'No schedule of yours matches that id.' });
      try {
        // audit 2026-10-06 T4-2: the pausing run's chat rides schedule_disabled as actorChatId.
        const r = await platform.setChatScheduleEnabled({ userId, chatId: row.sessionId, scheduleId, enabled, ...(ctx.sessionId ? { actorChatId: ctx.sessionId } : {}) });
        const s: any = r?.schedule ?? {};
        // changed:false → ids omit the lane (same rule as the moot short-circuit
        // above: a no-op receipt must not read as "acted toward the lane").
        return out({ ok: true, tool: name, ids: { scheduleId, ...(r?.changed ? { chatId: row.sessionId } : {}) }, chatId: row.sessionId, changed: !!r?.changed, enabled, nextRunAt: s.nextRunAt ?? null, lastStatus: s.lastStatus ?? null, message: r?.changed ? (enabled ? `Schedule ${short(scheduleId)} resumed — next firing ${s.nextRunAt ?? 'recomputed from now'}.` : `Schedule ${short(scheduleId)} paused — resumable with resume_schedule; cancel_schedule retires it for good.`) : `Schedule ${short(scheduleId)} was already ${enabled ? 'enabled' : 'paused'} — nothing changed.` });
      } catch (err: any) {
        const status = Number(err?.statusCode ?? 0);
        return out({ ok: false, tool: name, ids: { scheduleId, chatId: row.sessionId }, reason: status === 404 ? 'not_found' : 'refused', message: String(err?.message || err) });
      }
    }
  }
}

/** Transcript note in the TARGET chat so the stop/decision is visible where it happened (best-effort). */
async function note(chatId: string, userId: string, text: string): Promise<void> {
  try {
    const prisma = await db();
    await prisma.crossModelMessage.create({ data: { chatId, role: 'assistant', content: text, metadata: { kind: 'control_note', origin: 'agent' } } });
  } catch { /* best-effort */ }
}

async function afterQuestionAnswered(chat: { id: string; coding: boolean }, userId: string, _questionId: string, answer: string): Promise<void> {
  // Decision-card coherence (ticket 992c8374 twin): a question answered here
  // must also close the matching flagged owner question, or the fleet
  // attention block re-lists it forever. Best-effort, same helper the REST
  // plain-chat path uses (askedQuestion unknown here → text match only).
  try {
    const { resolveOwnerQuestionsForChatAnswer } = await import('./owner-questions');
    await resolveOwnerQuestionsForChatAnswer({ chatId: chat.id, userId, askedQuestion: '', answer });
  } catch { /* best-effort */ }
}
