/**
 * Task events — the ONE lifecycle surface for a human ask that outlives its
 * turn (cohesive-chat wave, 2026-09-28). Every long-running branch of the
 * chat harness (turn continuation, an auto-spawned sub-session, a recurring
 * schedule, the deliverable hand-off) reports through this module and the
 * frontend renders exactly this shape as the inline task card:
 *
 *   SSE event type "task" with data = TaskEvent — emitted on the PARENT chat's
 *   live run (the viewer's stream) — AND persisted as a message-part
 *   ({ type: 'task', task: TaskEvent }) on the chat row the ask was answered
 *   in, mirrored on that row's metadata.task, so a reload shows the card.
 *
 * Contract (shared by branches A–E; the frontend's plain-session.ts maps the
 * `task` event, lib/task-card.ts parses it and code-transcript.tsx renders
 * the part):
 *   { taskId, chatId, childChatId?, kind: 'continuation'|'session'|'schedule',
 *     status: 'running'|'done'|'failed'|'waiting_user', title,
 *     steps:{done,total}, receipts:{ok,total}, spendUsd, startedAt, updatedAt,
 *     etaText?, resultMessageId?, artifacts:[{name,bytes,url,kind}], note? }
 *
 * Merged module (cohesive/integration): branch B's types + buildTaskEvent,
 * branch D's parser, kill switch and row lookup (the anchor is `messageId` or
 * a row that ALREADY carries the task — never the chat's newest row).
 *
 * Both helpers are fail-safe: emit is a no-op without a live run for the chat
 * (the persisted card is the durable copy), persist swallows every error and
 * answers null — a task card must never fail the run it describes.
 *
 * RSW-1 delete-with-ledger 2026-11-02 (goal 393f731e, cluster 35): the
 * TASK_CARD_DISABLED kill switch is GONE — every card is always on. Its OFF
 * half was never reachable by any build (NF_INERT: 0 hits across every
 * docker-compose file and both Dockerfiles, no bracket access, no `on(k)`
 * closure), so the enabled branch was the only one that ever shipped and
 * inlining it leaves production byte-identical.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { findLiveRunKey, pushRunEvent } from '../coding/live-runs';
import { upsertTaskPart, isTaskPart } from '../coding/transcript-parts';
import { taskIdForSession } from './task-ids';
import { noteTaskCardLifecycle } from '../platform/delegation-tasks'; // build 2026-10-08 D-1 (SHADOW ledger)

export type TaskKind = 'continuation' | 'session' | 'schedule';
export type TaskStatus = 'running' | 'done' | 'failed' | 'waiting_user';
export type TaskArtifactKind = 'file' | 'pr' | 'canvas';

export interface TaskArtifact {
  name: string;
  bytes?: number;
  url?: string;
  kind: TaskArtifactKind;
}

export interface TaskEvent {
  taskId: string;
  chatId: string;
  /** The sub-session / child chat carrying the work (kind 'session'). */
  childChatId?: string;
  kind: TaskKind;
  status: TaskStatus;
  title: string;
  steps: { done: number; total: number };
  receipts: { ok: number; total: number };
  spendUsd: number;
  startedAt: string;
  updatedAt: string;
  /** Harness-measured ETA text (never a model-typed number). */
  etaText?: string;
  /** The assistant row that carries the result (status 'done'). */
  resultMessageId?: string;
  artifacts: TaskArtifact[];
  /** One plain line: what the card should say beside the status — for 'waiting_user' the question. */
  note?: string;
}

/** Alias kept for the hand-off / task-card callers (branches C + D name the payload this way). */
export type TaskEventPayload = TaskEvent;

/** The SSE event type every task lifecycle update rides. */
export const TASK_EVENT_TYPE = 'task';
/** The transcript part type the card persists as ({ type: 'task', task }). */
export const TASK_PART_TYPE = 'task';

const KINDS: readonly TaskKind[] = ['continuation', 'session', 'schedule'];
const STATUSES: readonly TaskStatus[] = ['running', 'done', 'failed', 'waiting_user'];
const ARTIFACT_KINDS: readonly TaskArtifactKind[] = ['file', 'pr', 'canvas'];

/** Rows scanned (newest first) for the assistant row that already carries a task card. */
const TASK_ROW_SCAN = 20;

// ── Hand-off polish (2026-09-28, audit CT-2 / E17) ──────────────────────────
// The spawn turn always ends after a successful start_coding_session and the
// finalize always checks whether the hand-off already posted the result. The
// SPAWN_ENDS_TURN_DISABLED / SESSION_CARD_HANDOFF_CHECK_DISABLED release
// switches were removed 2026-10-30 (RSW-1 cohort delete — always-on is the
// shipped behaviour).

/**
 * The tools-off FINAL-TURN notice the chat harness hands the agent loop once
 * a human turn STARTED a sub-session (coding/agent.ts endTurnAfterToolRound):
 * the answer says the work started and that the card + the Result row report
 * back — never a poll, a re-read or a re-narration of the hand-off.
 */
export function spawnEndTurnNotice(title: string | null | undefined): string {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || SESSION_TASK_TITLE_FALLBACK;
  return `[HARNESS NOTICE — not typed by the user] The sub-session "${t}" is running now and tool calls are no longer available on this turn. Write your final answer in a few sentences: say the work has started, that the task card in this chat tracks it, and that the result (files, links) is posted here by itself when it lands. Do not poll, wait for, or re-read the session; do not narrate a click, a card to confirm, or a worktree; do not repeat the tool result.`;
}

/**
 * Whether the finalize may persist the spawn-time RUNNING card for a session
 * (audit CT-2 b): a hand-off record that ALREADY posted the result on THIS
 * chat means the done card exists (on the answer row it flipped, or on the
 * result row) — a running card on a newer row would regress it. Pure.
 */
export function spawnCardStillOwed(latest: { resultMessageId?: string | null; targetChatId?: string | null; postedAt?: string | null } | null | undefined, chatId: string): boolean {
  if (!latest || typeof latest !== 'object') return true;
  if (!latest.resultMessageId && !latest.postedAt) return true;
  return latest.targetChatId !== chatId;
}

export { taskIdForSession, sessionIdOfTaskId } from './task-ids';

export const SESSION_TASK_TITLE_FALLBACK = 'Coding session';

export interface SpawnedSession {
  sessionId: string;
  title: string;
}

/**
 * The sub-sessions THIS run spawned: every `start_coding_session` tool result
 * in the transcript parts whose envelope is ok:true with ids.sessionId (a
 * staged card answers ok:false {staged:true} and is never a spawn). Tolerant
 * of a display-clipped result (the ids ride the head of the envelope).
 */
export function spawnedSessionsInParts(parts: unknown): SpawnedSession[] {
  if (!Array.isArray(parts)) return [];
  const out: SpawnedSession[] = [];
  const seen = new Set<string>();
  for (const p of parts as Array<Record<string, unknown>>) {
    if (!p || p.type !== 'tool_result' || p.name !== 'start_coding_session') continue;
    const raw = typeof p.result === 'string' ? p.result.trimStart() : '';
    if (!raw.startsWith('{')) continue;
    let sessionId: string | undefined;
    let message = '';
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.ok !== true) continue;
      // audit 2026-10-06 T5-2: a session created IDLE (ids.firstPrompt 'none') has no run — no running card.
      if (parsed?.ids?.firstPrompt === 'none') continue;
      sessionId = str(parsed?.ids?.sessionId);
      message = typeof parsed.message === 'string' ? parsed.message : '';
    } catch {
      // Clipped envelope: read the ids head + the message start leniently.
      if (!/"ok":\s*true/.test(raw) || /"firstPrompt":\s*"none"/.test(raw)) continue;
      sessionId = /"sessionId":\s*"([^"]+)"/.exec(raw)?.[1];
      message = /"message":\s*"((?:[^"\\]|\\.)*)/.exec(raw)?.[1] ?? '';
    }
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const title = /Started coding session \S+ "([^"]{1,160})"/.exec(message)?.[1]?.trim();
    out.push({ sessionId, title: title || SESSION_TASK_TITLE_FALLBACK });
  }
  return out;
}

/** The running card a spawn puts on the chat that asked (kind 'session'). */
export function buildSessionTaskEvent(input: { chatId: string; sessionId: string; title?: string | null; startedAt?: string }): TaskEvent {
  return buildTaskEvent({
    taskId: taskIdForSession(input.sessionId),
    chatId: input.chatId,
    childChatId: input.sessionId,
    kind: 'session',
    status: 'running',
    title: (input.title && input.title.trim()) || SESSION_TASK_TITLE_FALLBACK,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    note: 'Working in a sub-session — the result is posted here when it lands.',
  });
}

/**
 * Fill a TaskEvent's defaults from a partial (counts 0, artifacts [], clocks
 * now). `updatedAt` is always restamped; `startedAt` keeps a given value.
 */
export function buildTaskEvent(partial: Partial<TaskEvent> & Pick<TaskEvent, 'taskId' | 'chatId' | 'kind' | 'status' | 'title'>): TaskEvent {
  const now = new Date().toISOString();
  return {
    steps: { done: 0, total: 0 },
    receipts: { ok: 0, total: 0 },
    spendUsd: 0,
    artifacts: [],
    startedAt: now,
    ...partial,
    updatedAt: now,
  };
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const nonNeg = (v: unknown): number => Math.max(0, Math.floor(num(v)));
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Parse one task payload; null for anything malformed (dropped, never thrown).
 * Numbers are clamped to non-negative integers (spend keeps cents), artifacts
 * without a name or with an unknown kind are dropped, and `updatedAt` /
 * `startedAt` default to now when absent so a card always carries a clock.
 * Backend twin of frontend/lib/task-card.ts parseTaskEvent.
 */
export function parseTaskEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const taskId = str(r.taskId);
  const chatId = str(r.chatId);
  if (!taskId || !chatId) return null;
  if (typeof r.kind !== 'string' || !(KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.status !== 'string' || !(STATUSES as readonly string[]).includes(r.status)) return null;
  const steps = (r.steps && typeof r.steps === 'object' ? r.steps : {}) as Record<string, unknown>;
  const receipts = (r.receipts && typeof r.receipts === 'object' ? r.receipts : {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const artifacts: TaskArtifact[] = (Array.isArray(r.artifacts) ? r.artifacts : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      name: str(a.name) ?? '',
      kind: (typeof a.kind === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(a.kind) ? a.kind : 'file') as TaskArtifactKind,
      ...(typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? { bytes: Math.max(0, Math.floor(a.bytes)) } : {}),
      ...(str(a.url) ? { url: a.url as string } : {}),
    }))
    .filter((a) => a.name);
  const out: TaskEvent = {
    taskId,
    chatId,
    kind: r.kind as TaskKind,
    status: r.status as TaskStatus,
    title: str(r.title) ?? 'Task',
    steps: { done: nonNeg(steps.done), total: nonNeg(steps.total) },
    receipts: { ok: nonNeg(receipts.ok), total: nonNeg(receipts.total) },
    spendUsd: Math.max(0, num(r.spendUsd)),
    startedAt: str(r.startedAt) ?? now,
    updatedAt: str(r.updatedAt) ?? now,
    artifacts,
  };
  if (str(r.childChatId)) out.childChatId = r.childChatId as string;
  if (str(r.etaText)) out.etaText = r.etaText as string;
  if (str(r.resultMessageId)) out.resultMessageId = r.resultMessageId as string;
  if (str(r.note)) out.note = r.note as string;
  return out;
}

/**
 * Emit ONE `task` event on the parent chat's live stream. Resolves the chat's
 * live-run key (either registration form — a plain chat run or a coding run)
 * and pushes through the run registry, so the attach replay, the Redis mirror
 * and the durable log carry the frame like any other. Returns false (never a
 * throw) when the payload is malformed or no run is live for the chat — the
 * persisted card is the durable copy.
 */
export function emitTaskEvent(chatId: string, payload: TaskEvent): boolean {
  const parsed = parseTaskEvent({ ...payload, chatId: payload?.chatId || chatId });
  if (!parsed) return false;
  try {
    const key = findLiveRunKey(chatId);
    if (!key) return false;
    pushRunEvent(key, TASK_EVENT_TYPE, parsed);
    return true;
  } catch (err: any) {
    logger.warn(`task-events: emit failed for ${chatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: 'task-events' });
    return false;
  }
}

/** True when the row carries this task as a rendered `task` PART. */
function rowCarriesTaskPart(row: { parts: unknown }, taskId: string): boolean {
  return Array.isArray(row.parts) && (row.parts as any[]).some(p => isTaskPart(p) && (p.task as any).taskId === taskId);
}

/** True when an assistant row already carries this task — as a `task` part or as the compact `metadata.task` mirror. */
function rowCarriesTask(row: { parts: unknown; metadata?: unknown }, taskId: string): boolean {
  if (rowCarriesTaskPart(row, taskId)) return true;
  const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, any>) : null;
  return !!meta && !!meta.task && typeof meta.task === 'object' && meta.task.taskId === taskId;
}

/** The compact card copy stamped on metadata.task (the row's own summary). */
function metadataTask(payload: TaskEvent): Record<string, unknown> {
  return {
    taskId: payload.taskId, kind: payload.kind, status: payload.status, title: payload.title,
    ...(payload.childChatId ? { childChatId: payload.childChatId } : {}),
    ...(payload.resultMessageId ? { resultMessageId: payload.resultMessageId } : {}),
    updatedAt: payload.updatedAt,
  };
}

/**
 * Persist (upsert) the task card on a chat row as a { type: 'task', task }
 * part — replacing an earlier part with the same taskId, else appending —
 * and mirror the compact copy on metadata.task. Target row: `opts.messageId`
 * (must be an assistant row of THIS chat), else the newest assistant row (of
 * the last TASK_ROW_SCAN) that ALREADY carries this taskId (as a part or as
 * metadata.task), else nothing — the helper NEVER invents a row: a task's
 * first persist lands after the turn that started it finalizes, so "the
 * newest assistant row" is the wrong row whenever the user has sent another
 * message since. The caller passes the anchor row id on the first persist.
 * A row with no parts is seeded with its content as the one text part so the
 * transcript keeps rendering the answer beside the card. Returns the row id
 * it wrote, or null (malformed, no row, DB failure). Never throws.
 */
export async function persistTaskCard(chatId: string, payload: TaskEvent, opts: { messageId?: string; preferCarrier?: boolean } = {}): Promise<string | null> {
  // build 2026-10-08 D-1: every card state passes here — the delegation ledger mirrors it (SHADOW; fire-and-forget,
  // before the card write: the lifecycle happened whether or not a card renders).
  noteTaskCardLifecycle(chatId, payload);
  const parsed = parseTaskEvent({ ...payload, chatId: payload?.chatId || chatId });
  if (!parsed) return null;
  try {
    let row: { id: string; content: string; parts: unknown; metadata?: unknown } | null = null;
    const carrier = async () => {
      const rows = await prisma.crossModelMessage.findMany({
        where: { chatId, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        take: TASK_ROW_SCAN,
        select: { id: true, content: true, parts: true, metadata: true },
      });
      // A row carrying the CARD PART wins over one carrying only the compact
      // metadata mirror: the hand-off's result row stamps metadata.task with
      // the same taskId (the sub-session view's Result seat), and the done
      // card must flip the answer row's rendered card, not land beside it.
      return rows.find(r => rowCarriesTaskPart(r, parsed.taskId)) ?? rows.find(r => rowCarriesTask(r, parsed.taskId)) ?? null;
    };
    // preferCarrier (the hand-off's done card): the row that ALREADY carries the
    // running card wins over the named row, so ONE card moves running → done
    // and the named row (the result message) is the fallback anchor.
    if (opts.preferCarrier) row = await carrier();
    if (!row && opts.messageId) {
      row = await prisma.crossModelMessage.findFirst({ where: { id: opts.messageId, chatId, role: 'assistant' }, select: { id: true, content: true, parts: true, metadata: true } });
    }
    if (!row && !opts.preferCarrier) row = await carrier();
    if (!row) {
      logger.warn(`task-events: no assistant row carries task ${parsed.taskId.slice(0, 24)} in chat ${chatId.slice(0, 8)}${opts.messageId ? ` (messageId ${opts.messageId} is not an assistant row of this chat)` : ' and no messageId was given'} — card not persisted (never invents a row)`, { source: 'task-events' });
      return null;
    }
    const parts: any[] = Array.isArray(row.parts) && (row.parts as any[]).length
      ? (row.parts as any[]).slice()
      : (row.content && row.content.trim() ? [{ type: 'text', text: row.content }] : []);
    upsertTaskPart(parts, parsed);
    const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {};
    await prisma.crossModelMessage.update({
      where: { id: row.id },
      data: { parts: parts as unknown as object[], metadata: { ...meta, task: metadataTask(parsed) } as object },
    });
    return row.id;
  } catch (err: any) {
    logger.warn(`task-events: persist failed for ${chatId.slice(0, 8)} / ${String(payload?.taskId ?? '').slice(0, 24)} (non-fatal): ${err?.message ?? err}`, { source: 'task-events' });
    return null;
  }
}
