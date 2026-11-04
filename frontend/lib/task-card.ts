/**
 * Inline task card — the client half of the SHARED task contract (cohesive
 * chat, 2026-09-28; backend twin: chat-agent/task-events.ts).
 *
 * Every human ask is ONE task with ONE lifecycle, visible in the chat it was
 * asked in: quick ⇒ the inline answer; longer than a turn ⇒ the answer says it
 * is working and ONE card under it shows progress while the run continues in
 * the background on the SAME chat; needs a workspace ⇒ a sub-session is
 * spawned as an implementation detail and its progress rides the SAME card;
 * recurring ⇒ same chat, same card. The card is never model prose: it renders
 * ONLY the harness's `task` SSE events (live) and the `task` transcript part
 * they persist (reload / guest resume).
 *
 * Wire shape (event type `task`, also the `task` field of a `task` part):
 *   { taskId, chatId, childChatId?, kind: continuation|session|schedule,
 *     status: running|done|failed|waiting_user, title, steps:{done,total},
 *     receipts:{ok,total}, spendUsd, startedAt, updatedAt, etaText?,
 *     resultMessageId?, artifacts:[{name,bytes?,url?,kind:file|pr|canvas}], note? }
 *
 * Fail-open by construction: a malformed payload is dropped (never thrown), a
 * legacy backend emits nothing and the chat renders exactly as before.
 * Staged-confirmation cards are never hidden by this module — a staged card
 * always needs its click.
 */

import type { MessagePart } from '@/lib/api/coding';

export const TASK_EVENT_TYPE = 'task';
export const TASK_PART_TYPE = 'task';

export type TaskKind = 'continuation' | 'session' | 'schedule';
export type TaskStatus = 'running' | 'done' | 'failed' | 'waiting_user';
export type TaskArtifactKind = 'file' | 'pr' | 'canvas';

export interface TaskArtifact {
  name: string;
  bytes?: number;
  url?: string;
  kind: TaskArtifactKind;
}

export interface TaskEventPayload {
  taskId: string;
  chatId: string;
  childChatId?: string;
  kind: TaskKind;
  status: TaskStatus;
  title: string;
  steps: { done: number; total: number };
  receipts: { ok: number; total: number };
  spendUsd: number;
  startedAt: string;
  updatedAt: string;
  etaText?: string;
  resultMessageId?: string;
  artifacts: TaskArtifact[];
  note?: string;
}

const KINDS: readonly TaskKind[] = ['continuation', 'session', 'schedule'];
const STATUSES: readonly TaskStatus[] = ['running', 'done', 'failed', 'waiting_user'];
const ARTIFACT_KINDS: readonly TaskArtifactKind[] = ['file', 'pr', 'canvas'];

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const nonNeg = (v: unknown): number => Math.max(0, Math.floor(num(v)));
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Parse one `task` payload; null for anything malformed (dropped, never thrown). Mirrors the backend parser. */
export function parseTaskEvent(raw: unknown): TaskEventPayload | null {
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
  const out: TaskEventPayload = {
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

/** True for a transcript part that carries a task card. */
export function isTaskPart(p: MessagePart | null | undefined): p is MessagePart & { task: TaskEventPayload } {
  return !!p && p.type === TASK_PART_TYPE && !!p.task && typeof p.task === 'object' && typeof (p.task as any).taskId === 'string';
}

/** The task a part carries, parsed — null for anything else. */
export function taskOfPart(p: MessagePart | null | undefined): TaskEventPayload | null {
  return isTaskPart(p) ? parseTaskEvent(p.task) : null;
}

const isTerminal = (s: TaskStatus) => s === 'done' || s === 'failed';

/**
 * The card state machine. The server's events are the truth, so a valid
 * payload replaces the previous one — with ONE guard: a TERMINAL state (done /
 * failed) never regresses to running / waiting_user from a replayed or
 * out-of-order frame that is not newer (by updatedAt). A malformed payload
 * keeps the previous state.
 */
export function reduceTaskState(prev: TaskEventPayload | undefined, raw: unknown): TaskEventPayload | undefined {
  const next = parseTaskEvent(raw);
  if (!next) return prev;
  if (!prev || prev.taskId !== next.taskId) return next;
  if (isTerminal(prev.status) && !isTerminal(next.status)) {
    const p = Date.parse(prev.updatedAt);
    const n = Date.parse(next.updatedAt);
    if (!(Number.isFinite(p) && Number.isFinite(n) && n > p)) return prev;
  }
  return next;
}

/** Every task card a message carries (parsed), in part order. */
export function tasksOfMessage(parts: MessagePart[] | undefined): TaskEventPayload[] {
  if (!Array.isArray(parts)) return [];
  const out: TaskEventPayload[] = [];
  for (const p of parts) { const t = taskOfPart(p); if (t) out.push(t); }
  return out;
}

/** True when any row of the transcript carries a card for this taskId. */
export function messagesHaveTask(messages: ReadonlyArray<{ parts?: MessagePart[] }>, taskId: string): boolean {
  return messages.some(m => Array.isArray(m.parts) && m.parts.some(p => isTaskPart(p) && p.task.taskId === taskId));
}

/**
 * Apply a task event to the rows that already carry its card (ONE card per
 * task: the live stream must update the persisted row's card, never add a
 * second one under the streaming bubble). Returns the same array when no row
 * carries the task. Rows are replaced immutably (React state).
 */
export function applyTaskToMessages<T extends { parts?: MessagePart[] }>(messages: T[], raw: unknown): T[] {
  const next = parseTaskEvent(raw);
  if (!next) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.parts)) return m;
    const i = m.parts.findIndex(p => isTaskPart(p) && p.task.taskId === next.taskId);
    if (i < 0) return m;
    const reduced = reduceTaskState(taskOfPart(m.parts[i]) ?? undefined, next);
    if (!reduced || reduced === taskOfPart(m.parts[i])) return m;
    const parts = m.parts.slice();
    parts[i] = { ...parts[i], task: reduced };
    changed = true;
    return { ...m, parts };
  });
  return changed ? out : messages;
}

/** A card that still needs the harness (a poll / attach keeps it honest). */
export function taskPending(t: TaskEventPayload | null | undefined): boolean {
  return !!t && (t.status === 'running' || t.status === 'waiting_user');
}

/** The transcript's pending cards (newest row first) — what a reload must keep polling. */
export function pendingTasksOf(messages: ReadonlyArray<{ parts?: MessagePart[] }>): TaskEventPayload[] {
  const out: TaskEventPayload[] = [];
  for (let i = messages.length - 1; i >= 0; i--) for (const t of tasksOfMessage(messages[i].parts)) if (taskPending(t)) out.push(t);
  return out;
}

/**
 * The sub-session view's RESULT section source: the newest assistant row's
 * task card that is settled (done / failed) — or, absent a card, a settled
 * task the row's metadata carries (`metadata.task`, the hand-off branch's
 * seat). Null while the run is still working or nothing was handed back.
 */
export function findSessionResult(messages: ReadonlyArray<{ role: string; parts?: MessagePart[]; plainMeta?: { task?: unknown } }>): TaskEventPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const fromParts = tasksOfMessage(m.parts).filter(t => isTerminal(t.status));
    if (fromParts.length) return fromParts[fromParts.length - 1];
    const fromMeta = parseTaskEvent(m.plainMeta?.task);
    if (fromMeta && isTerminal(fromMeta.status)) return fromMeta;
  }
  return null;
}

/**
 * Map a CHILD session's own status (the existing live-run status feed:
 * `codingApi.getSession(childChatId).status`) onto the parent's card — the
 * SAME card, never a second widget. Only what the session status proves:
 * 'error' ⇒ failed (with the session's error text as the note); a settled
 * card is never re-opened; 'running' / 'ready' leave the card as the harness
 * last reported it (the hand-off decides when a task is done — the view
 * never invents "done" from a session going idle).
 */
export function mergeChildSessionIntoTask(task: TaskEventPayload, session: { status?: string; errorMessage?: string | null; updatedAt?: string } | null | undefined): TaskEventPayload {
  if (!session || isTerminal(task.status)) return task;
  if (session.status === 'error') {
    return {
      ...task,
      status: 'failed',
      updatedAt: session.updatedAt || new Date().toISOString(),
      note: session.errorMessage?.trim() || task.note,
    };
  }
  return task;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  continuation: 'Continuing',
  session: 'Sub-session',
  schedule: 'Scheduled',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  waiting_user: 'Waiting for you',
};

export const OPEN_RESULT_LABEL = 'Open result';
export const REPLY_BELOW_LABEL = 'Reply below';
export const OPEN_SESSION_LABEL = 'Open session';
export const RESULT_SECTION_LABEL = 'Result';

/** "$0.12" / "$1.20" — cents up to $10, then one decimal. Empty for zero / invalid. */
export function formatSpend(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

/** "12s" / "3m 05s" / "1h 02m" from a millisecond span. */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "1.2 MB" / "348 KB" / "512 B". */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
