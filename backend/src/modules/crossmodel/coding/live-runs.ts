/**
 * Digby Code — in-memory live-run registry.
 *
 * A coding run is DECOUPLED from the SSE HTTP request that started it: the agent
 * writes events here (an ordered buffer + a fan-out to subscribers), and one or
 * more HTTP responses subscribe. This lets a client that navigated away and came
 * back RE-ATTACH to an in-progress run and replay everything it missed — instead
 * of seeing a blank session while the agent churns on server-side.
 *
 * Process-local by design: a blue-green deploy / restart kills the agent (it dies
 * with the container) and drops the registry. Such a run becomes "orphaned" — the
 * session row is left status='running' with no entry here. The stream controller
 * detects that on attach and resets the session to 'ready' so it isn't stuck blank.
 */

import { ChatImage, MAX_IMAGES } from './chat-images';
import { withholdFromClient } from './reasoning-wire';

export interface RunEvent {
  type: string;
  data: any;
  seq?: number;
  /**
   * Server wall-clock ISO stamp at push time (2026-09-08). Frames carry it so
   * a client that ATTACHES mid-run (or replays a finished run) can stamp the
   * replayed parts with when they actually happened — the client used to stamp
   * every replayed part at ingest, so an attach at 7:28 showed "7:28 AM" on
   * every block of a run that started at 7:19.
   */
  ts?: string;
}
type Subscriber = (e: RunEvent) => void;

interface LiveRun {
  sessionId: string;
  events: RunEvent[];          // ring buffer (bounded) for replay on (re)attach
  subscribers: Set<Subscriber>;
  done: boolean;
  cancelled: boolean;          // user pressed Stop → agent loop should bail out
  shutdownInterrupted: boolean; // SIGTERM interrupt → finalizer maps to resumable 'interrupted' (Phase 1)
  drainYieldRequested: boolean; // draining worker asked this run to hand off at its next step boundary
  seq: number;                 // monotonic event counter — the durable agent_events seq (Phase 1)
  tap?: (e: RunEvent) => void; // durable event-log appender, wired by the stream controller (Phase 1)
  startedAt: number;
  truncated: boolean;          // did the ring buffer drop earlier events?
  steer: Array<{ text: string; images?: ChatImage[] }>; // STEER queue: user messages injected mid-run (drained between steps)
  /**
   * Wall-clock (ms epoch) of the run's most recent TOOL event (WI-G, 2026-09-25):
   * the deploy drain reads it through /drain-status to tell a run that is still
   * PROGRESSING (a supervisor wake mid-tool-loop) from one that is wedged, so the
   * bounded retiring-budget extension only ever waits for runs doing work. Null
   * until the first tool event. Fed by pushRunEvent — the coding loop's raw
   * 'tool_call' / 'tool_result' events and the chat adapter's 'agent-activity'
   * {kind:'tool'|'tool_done'} mirror of the same.
   */
  lastToolAt: number | null;
  /**
   * Wall-clock (ms epoch) of the run's most recent producer-noted PROGRESS beat (noteRunProgress — deep research
   * without a wall clock, 2026-10-20): a research council notes every real model / tool event of its lead and team,
   * so the drain can tell a council that is still working from a stalled one. Null until the first beat.
   */
  lastProgressAt: number | null;
  /** Producer-stamped facts about the run (setRunMeta) — what /drain-status reports per run. */
  meta: LiveRunMeta;
}

/**
 * What a producer knows about its own run and the drain wants to see
 * (WI-G): the chat id (when durable), whether it is machine-triggered, and
 * whether it is a supervisor-class wake (the 8–16 min glm-5.3 reasoning-max
 * runs that outlive a fixed drain budget). All optional — a run stamped
 * nothing reports nothing (the pre-WI-G shape).
 */
export interface LiveRunMeta {
  chatId?: string;
  machineTriggered?: boolean;
  isSupervisorWake?: boolean;
  /** A deep-research council run (L3 preset, research lane or the Dig-deeper research rung) running WITHOUT a wall
   *  clock (2026-10-20) — the drain may extend the retiring budget for it while it progresses (drain-status.ts). */
  isResearchCouncil?: boolean;
  /** A Dig-deeper rung run (audit 2026-09-26 routing-unify-4): the message it deepens + the rung — the SIGTERM ritual requeues it as an ESCALATION, never a plain re-ask. */
  escalation?: { ofMessageId: string; rung: 'verify' | 'research' };
  /**
   * A turn-continuation round (cohesive-chat wave 2026-09-28, review fix 3):
   * the stash it runs under + the round prompt + the level, so the SIGTERM
   * ritual can requeue the ROUND (chat-agent/turn-continuation.ts
   * ContinuationRun — typed loosely here so this registry stays a leaf).
   */
  continuation?: { stash: { taskId: string; round: number; maxRounds: number; reason: string; ofMessageId: string; askMessageId?: string; startedAt: string; askText: string }; prompt: string; mode: string };
}

/** One active run as /drain-status reports it (WI-G). */
export interface LiveRunDetail extends LiveRunMeta {
  runId: string;
  startedAt: number;
  lastToolAt: number | null;
  lastProgressAt: number | null;
}

const runs = new Map<string, LiveRun>();
const MAX_EVENTS = 20_000;            // ring-buffer cap so a runaway run can't grow unbounded (raised with the 200-step budget so long runs replay fully on re-attach)
const FINISHED_RETENTION_MS = 30_000; // keep a finished run briefly so a late attach still replays 'complete'

/** True while an agent is actively producing events for this session. */
export function isRunActive(sessionId: string): boolean {
  const r = runs.get(sessionId);
  return !!r && !r.done;
}

/** Session ids with an ACTIVE (not finished) run on this instance — shutdown finalization sweep. */
export function listActiveRunIds(): string[] {
  return [...runs.values()].filter(r => !r.done).map(r => r.sessionId);
}

/** True if a run entry exists at all (active OR recently-finished within the retention window). */
export function runExists(sessionId: string): boolean {
  return runs.has(sessionId);
}

/** Reserve a fresh run slot (call synchronously before any await to avoid a double-start race). */
export function startLiveRun(sessionId: string): void {
  runs.set(sessionId, { sessionId, events: [], subscribers: new Set(), done: false, cancelled: false, shutdownInterrupted: false, drainYieldRequested: false, seq: 0, startedAt: Date.now(), truncated: false, steer: [], lastToolAt: null, lastProgressAt: null, meta: {} });
}

/**
 * ATOMIC check-and-reserve: reserve the slot ONLY if this session has no active
 * run, synchronously (no await between the check and the set). Returns false if a
 * run is already active. Callers must reserve here BEFORE any await so two
 * concurrent starts can't both pass an isRunActive() check and then both reserve
 * (single-process TOCTOU). Release with endLiveRun() if a later pre-flight fails.
 */
export function tryStartLiveRun(sessionId: string): boolean {
  const existing = runs.get(sessionId);
  if (existing && !existing.done) return false;
  startLiveRun(sessionId);
  return true;
}

/**
 * STEER: queue a user message into an ACTIVE run — the agent picks it up
 * between steps (via drainSteer, wired as the coding run's injectSystem). This
 * is how a user redirects / adds to a long run without waiting for it to finish
 * or starting a second run. Returns false if there's no active run to steer.
 */
export function pushSteer(sessionId: string, message: string, images?: ChatImage[]): boolean {
  const run = runs.get(sessionId);
  if (!run || run.done) return false;
  const m = String(message || '').trim();
  if (!m && !images?.length) return false;
  if (run.steer.length >= 20) run.steer.shift(); // bound the queue; keep the most recent
  run.steer.push(images?.length ? { text: m, images } : { text: m });
  return true;
}

/**
 * Drain all queued steer messages for a run (called once per top-level step).
 * Texts join with '\n\n'; images concatenate, capped at MAX_IMAGES (a note is
 * appended to the text when the cap drops any).
 */
export function drainSteer(sessionId: string): { text: string; images: ChatImage[] } | null {
  const run = runs.get(sessionId);
  if (!run || !run.steer.length) return null;
  const batch = run.steer.splice(0, run.steer.length);
  const images = batch.flatMap(b => b.images ?? []);
  let text = batch.map(b => b.text).filter(Boolean).join('\n\n');
  if (images.length > MAX_IMAGES) {
    const dropped = images.length - MAX_IMAGES;
    images.splice(MAX_IMAGES);
    text = `${text}${text ? '\n\n' : ''}[${dropped} attached image(s) dropped — a steer carries at most ${MAX_IMAGES}]`;
  }
  return { text, images };
}

/** When the run started (ms epoch), or null. Lets the client show an honest elapsed timer on (re)attach. */
export function runStartedAt(sessionId: string): number | null {
  return runs.get(sessionId)?.startedAt ?? null;
}

/** Stamp producer-known facts on an ACTIVE run (merge; unknown key = no-op). WI-G. */
export function setRunMeta(sessionId: string, meta: LiveRunMeta): void {
  const run = runs.get(sessionId);
  if (!run || run.done) return;
  run.meta = { ...run.meta, ...meta };
}

/** The producer-stamped facts for a run (empty object when unknown / unstamped). WI-G. */
export function getRunMeta(sessionId: string): LiveRunMeta {
  return runs.get(sessionId)?.meta ?? {};
}

/** Wall-clock of the run's most recent tool event, or null (no tool event yet / unknown run). WI-G. */
export function runLastToolAt(sessionId: string): number | null {
  return runs.get(sessionId)?.lastToolAt ?? null;
}

/** Note a PROGRESS beat on an ACTIVE run (cheap — called per model event; unknown / finished run = no-op). 2026-10-20. */
export function noteRunProgress(sessionId: string, at: number = Date.now()): void {
  const run = runs.get(sessionId);
  if (run && !run.done) run.lastProgressAt = at;
}

/** Wall-clock of the run's most recent progress beat, or null. 2026-10-20. */
export function runLastProgressAt(sessionId: string): number | null {
  return runs.get(sessionId)?.lastProgressAt ?? null;
}

/**
 * Every ACTIVE run with its timing + stamped facts — the /drain-status
 * per-run detail the deploy script reads (WI-G). Synchronous registry read,
 * like listActiveRunIds.
 */
export function listActiveRunDetails(): LiveRunDetail[] {
  return [...runs.values()]
    .filter((r) => !r.done)
    .map((r) => ({ runId: r.sessionId, startedAt: r.startedAt, lastToolAt: r.lastToolAt, lastProgressAt: r.lastProgressAt, ...r.meta }));
}

/** Is this event a tool call/result in either the raw coding shape or the chat adapter's mirror? (WI-G) */
function isToolActivityEvent(type: string, data: any): boolean {
  if (type === 'tool_call' || type === 'tool_result') return true;
  if (type === 'agent-activity') {
    const kind = data?.kind;
    return kind === 'tool' || kind === 'tool_done';
  }
  return false;
}

/** Request cancellation of a run; the agent loop checks isRunCancelled() and bails. */
export function cancelRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (run) run.cancelled = true;
}

/** True if Stop was pressed for this run. */
export function isRunCancelled(sessionId: string): boolean {
  return !!runs.get(sessionId)?.cancelled;
}

/** Wire the durable event-log appender for a run (stream controller, Phase 1). */
export function setRunEventTap(sessionId: string, tap: (e: RunEvent) => void): void {
  const run = runs.get(sessionId);
  if (run) run.tap = tap;
}

/** Continue the durable seq after a resume (Phase 1) so the (runId, seq) log stays monotonic. */
export function primeRunSeq(sessionId: string, base: number): void {
  const run = runs.get(sessionId);
  if (run) run.seq = Math.max(run.seq, base);
}

/** Mark a run interrupted by SHUTDOWN (not user Stop) — the finalizer maps this
 * to a resumable 'interrupted' status instead of terminal 'cancelled' (Phase 1). */
export function markRunShutdownInterrupted(sessionId: string): void {
  const run = runs.get(sessionId);
  if (run) run.shutdownInterrupted = true;
}

/**
 * Soft drain yield (2026-10-19): a draining worker asks a long run to hand off
 * to the live worker. The agent loop honours it only at the TOP of a step —
 * after the previous turn's tools finished, before the next model call — and
 * then takes the same path as the hard drain bound: shutdown-interrupted
 * (checkpoint retained) + cancelled, so the live worker resumes it.
 */
export function requestDrainYield(sessionId: string): void {
  const run = runs.get(sessionId);
  if (run && !run.done) run.drainYieldRequested = true;
}

export function isDrainYieldRequested(sessionId: string): boolean {
  return !!runs.get(sessionId)?.drainYieldRequested;
}

/** True if this run's cancel came from server shutdown (SIGTERM), not user Stop. */
export function isRunShutdownInterrupted(sessionId: string): boolean {
  return !!runs.get(sessionId)?.shutdownInterrupted;
}

/** Append an event to the buffer and fan it out to current subscribers. */
export function pushRunEvent(sessionId: string, type: string, data: any): void {
  const run = runs.get(sessionId);
  if (!run) return;
  pushToRun(run, type, data);
}

function pushToRun(run: LiveRun, type: string, data: any): void {
  // Thinking stays on the server (2026-10-04, reasoning-wire.ts): a reasoning event never enters the buffer, the
  // subscribers, the agent_events tap or the Redis mirror. HIDE_REASONING_DISABLED=1 restores it.
  if (withholdFromClient(type, data)) return;
  const e: RunEvent = { type, data, ts: new Date().toISOString() };
  e.seq = ++run.seq;
  if (isToolActivityEvent(type, data)) run.lastToolAt = Date.now();
  // Durable event log (Phase 1): the tap appends to agent_events — wired by the
  // stream controller so this module stays dependency-free.
  if (run.tap) { try { run.tap(e); } catch { /* a broken tap must not break the run */ } }
  // Ring buffer: drop the OLDEST event when full (not the newest). A reattaching
  // client then replays the most-recent window + live tail instead of the run's
  // beginning then a silent gap to live. Terminal events are pushed last, so they
  // are never the one dropped while newer events exist.
  run.events.push(e);
  if (run.events.length > MAX_EVENTS) { run.events.shift(); run.truncated = true; }
  for (const sub of run.subscribers) {
    try { sub(e); } catch { /* a dead writer must not break the run */ }
  }
}

/** A handle on ONE run — see bindLiveRun. */
export interface BoundLiveRun {
  /** pushRunEvent onto the bound run; dropped once it finished or a newer run took its key. */
  push(type: string, data: any): void;
  /** The bound run's own Stop flag (a newer run's Stop never reads as this one's). */
  isCancelled(): boolean;
  /** noteRunProgress onto the bound run; dropped once it finished or a newer run took its key. */
  noteProgress(at?: number): void;
  /** True while the bound run is active AND still the one registered under its key. */
  isCurrent(): boolean;
}

/**
 * Bind to the run CURRENTLY registered under `sessionId` (integration review 2026-10-20). Every call acts on THAT
 * run only, and pushes / progress beats go silent once it has finished or a newer run replaced it under the same
 * key. A detached chat run used to write by KEY, so its late producers — a deep-research colleague the council gave
 * up on, which keeps running with no wall clock — landed in the NEXT run on the chat: its buffer, its subscribers,
 * its Redis mirror tap (a cross-box tail then saw a foreign generation marker and ended early), its drain progress
 * beat; and that run's Stop cancelled the straggler. After the run finished nothing can see a push anyway (its
 * subscribers are cleared; a replay stops at the terminal event), so dropping post-terminal pushes loses nothing.
 * No run under the key ⇒ an inert handle.
 */
export function bindLiveRun(sessionId: string): BoundLiveRun {
  const run = runs.get(sessionId);
  const current = (): boolean => !!run && !run.done && runs.get(sessionId) === run;
  return {
    push: (type, data) => { if (run && current()) pushToRun(run, type, data); },
    isCancelled: () => !!run?.cancelled,
    noteProgress: (at = Date.now()) => { if (run && current()) run.lastProgressAt = at; },
    isCurrent: current,
  };
}

/**
 * Subscribe an emitter to a run. Immediately replays the buffered events (so a
 * re-attaching client is caught up), then streams new ones. Returns an
 * unsubscribe fn, or null if there is no run for this session.
 */
export function subscribeRun(sessionId: string, emit: Subscriber): (() => void) | null {
  const run = runs.get(sessionId);
  if (!run) return null;
  if (run.truncated) {
    try { emit({ type: 'progress', data: { message: 'Earlier live output was truncated (the full transcript is saved to the session).', stage: 'truncated' } }); } catch { /* ignore */ }
  }
  for (const e of run.events) {
    try { emit(e); } catch { /* ignore */ }
  }
  if (run.done) return () => {}; // buffer already contains the terminal event; nothing more will come
  run.subscribers.add(emit);
  return () => { run.subscribers.delete(emit); };
}

/** Mark a run finished; drop subscribers and evict after a short retention window. */
export function endLiveRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run) return;
  run.done = true;
  run.subscribers.clear();
  setTimeout(() => { if (runs.get(sessionId) === run) runs.delete(sessionId); }, FINISHED_RETENTION_MS);
}

// ── P4: unified per-chat run keys + shared SSE attach ─────────────────────────

/**
 * The live-run key forms a chat can have. Post-One-Digby a coding session's id
 * IS the chat id, so the two pipelines already register under the two forms:
 *   - chat runs   (chat-agent.service) register under `chat:${chatId}`
 *   - coding runs (coding-stream.controller) register under the bare chatId
 * The unified stream endpoint (GET /chats/:id/stream) resolves BOTH forms so a
 * viewer attaches to the active run regardless of pipeline — no dual-key
 * registration needed (producers stay exactly as they are).
 */
export function chatRunKeys(chatId: string): string[] {
  return [`chat:${chatId}`, chatId];
}

/**
 * Resolve the key that actually holds a run for this chat: an ACTIVE run wins
 * (either form); otherwise a recently-finished (retained) run so a late attach
 * still replays its terminal event; otherwise null (nothing to attach to).
 */
export function findLiveRunKey(chatId: string): string | null {
  for (const k of chatRunKeys(chatId)) if (isRunActive(k)) return k;
  for (const k of chatRunKeys(chatId)) if (runExists(k)) return k;
  return null;
}

/**
 * Minimal response surface the SSE helpers need (Express Response-compatible).
 * Typed loosely so the helpers live here without an express import cycle.
 */
interface SSEResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  writableEnded: boolean;
}

/**
 * Open an SSE response + a 20s comment heartbeat (the pattern both attach
 * endpoints used inline). Returns the heartbeat interval — the caller clears
 * it (or uses attachRunToResponse, which owns the whole lifecycle).
 */
export function openSSEStream(res: SSEResponse): ReturnType<typeof setInterval> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return setInterval(() => { if (!res.writableEnded) { try { res.write(': hb\n\n'); } catch { /* viewer gone */ } } }, 20_000);
}

/**
 * Write one terminal event, stop the heartbeat, and end the response — the
 * "nothing to attach to" path both attach endpoints shared (a client that
 * gets `complete{interrupted:true}` reloads messages instead of waiting).
 */
export function endSSEWithEvent(res: SSEResponse, heartbeat: ReturnType<typeof setInterval>, type: string, data: any): void {
  try { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch { /* viewer gone */ }
  clearInterval(heartbeat);
  if (!res.writableEnded) res.end();
}

/**
 * THE shared attach: replay the run's buffered events then live-forward until
 * a terminal event or viewer disconnect. Owns the SSE headers, heartbeat,
 * unsubscribe, and cleanup. `onClose` lets the caller hook the viewer
 * disconnect (e.g. to clear its own timer) — the RUN is never cancelled by a
 * disconnect (runs are detached; stopping is an explicit endpoint action).
 */
export function attachRunToResponse(opts: {
  req: { on(event: 'close', cb: () => void): void };
  res: SSEResponse;
  runKey: string;
  onClose?: () => void;
  /**
   * Stream drops (2026-10-20): fired when the VIEWER leaves while the run is
   * still active and no terminal was written to it (never on our own end) —
   * the controller records loop_metrics sse_viewer_drop. Leaf-safe: a plain
   * callback, no telemetry import here.
   */
  onDrop?: (info: { eventsWritten: number; elapsedMs: number }) => void;
}): void {
  const { req, res, runKey, onClose } = opts;
  const heartbeat = openSSEStream(res);
  const openedAt = Date.now();
  let ended = false;
  let written = 0;
  let unsub: (() => void) | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    unsub?.();
    if (!res.writableEnded) res.end();
  };
  const emit = (e: RunEvent) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify({ type: e.type, data: e.data, ...(e.ts ? { ts: e.ts } : {}) })}\n\n`); written++; } catch { /* viewer gone */ }
    if (e.type === 'complete' || e.type === 'error') end();
  };
  unsub = subscribeRun(runKey, emit);
  if (!unsub) { endSSEWithEvent(res, heartbeat, 'complete', { interrupted: true }); return; } // run vanished mid-attach
  req.on('close', () => {
    if (opts.onDrop && !ended && !res.writableEnded && isRunActive(runKey)) {
      try { opts.onDrop({ eventsWritten: written, elapsedMs: Date.now() - openedAt }); } catch { /* telemetry never breaks the attach */ }
    }
    onClose?.();
    end();
  });
}

/** Did this run's ring buffer drop its head (a reattach replays only the tail)? 2026-10-20 sse_reattach. */
export function isRunTruncated(sessionId: string): boolean {
  return !!runs.get(sessionId)?.truncated;
}
