/**
 * Cross-instance SSE mirror for PLAIN-chat agent runs.
 *
 * A detached chat run's events live in the in-process registry
 * (coding/live-runs.ts) of whichever blue/green instance executes it — the ALB
 * has no stickiness, so a reload / second tab / mobile-return served by the
 * OTHER instance found no local run and was told complete{interrupted:true}
 * while the run still streamed (and the chat list simultaneously said
 * "running" via isChatBusy). Workspace-state chats already re-attach anywhere
 * through the durable agent_events log; this module gives plain chats the
 * lighter equivalent: a capped Redis list of the run's events.
 *
 * Producer (startDetachedChatRun, chatId-keyed runs only): DEL the list on run
 * start (a new run must never replay the previous run's events), then mirror
 * every pushRunEvent via the run's event tap — RPUSH JSON({type,data,seq}) +
 * LTRIM to the newest MIRROR_MAX + EXPIRE, refreshed per push. The terminal
 * event (complete/error) rides the same path; consumers stop on it.
 *
 * Consumer (attachRemoteChatRun — the unified GET /chats/:id/stream, on a
 * LOCAL registry miss for a busy plain chat): replay the list, then poll for
 * new entries until the terminal marker, run end (isChatBusy false → an honest
 * interrupted only when no terminal marker ever arrived), or client
 * disconnect. The LOCAL attach path is untouched — the list is only ever
 * consumed cross-instance, so events are never double-sent to a local viewer.
 *
 * Best-effort discipline (mirrors chat-busy): a Redis hiccup degrades the
 * mirror to "nothing new this beat" and the viewer falls back to the old
 * behavior at run end — never a thrown 500 in the run's event path.
 *
 * Stream drops (2026-10-20, owner "why does connection drop?"):
 *   - the mirror id is a chat id OR `guestMirrorId(sid)` (`session:<sid>`) — a
 *     GUEST run is mirrored under its session too, so the guest attach
 *     (GET /session/:sessionId/stream) can tail it from the other box
 *     (GUEST_STREAM_ATTACH_DISABLED=1 — chat-agent.service wires no guest tap);
 *   - the tap COALESCES consecutive `chunk` deltas into one entry (≤ 250 ms /
 *     16k chars per entry, flushed before any other event so ordering holds)
 *     and the window holds MIRROR_MAX_EVENTS_COALESCED, so a long answer fits
 *     and a cross-box reattach replays the identical text instead of the tail
 *     plus "Earlier live output was truncated" (RUN_MIRROR_COALESCE_DISABLED=1
 *     restores one entry per delta and the 500-entry window byte-for-byte);
 *   - the attach reports a viewer that left before the terminal (`onDrop`) and
 *     what its replay held (`onReplay`) — the controller turns both into
 *     loop_metrics (sse_viewer_drop / sse_reattach).
 */

import { randomUUID } from 'crypto';
import redisClient from '../../../config/redis';
import { openSSEStream, type RunEvent } from '../coding/live-runs';
import { durableEventData } from '../coding/durable-event-payload';
import { isChatBusy } from './chat-busy';

const EVENTS_KEY = (chatId: string) => `cm:runevents:${chatId}`;

/** The mirror id of a GUEST (anonymous session) run — `cm:runevents:session:<sid>`.
 *  Never collides with a chat's (a chat id is a bare uuid). */
export function guestMirrorId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Newest events kept — enough to replay a run's visible tail; the in-process
 *  ring buffer (and the persisted assistant row) remain the full record.
 *  The pre-2026-10-20 window (one entry per text delta), kept under
 *  RUN_MIRROR_COALESCE_DISABLED=1. */
export const MIRROR_MAX_EVENTS = 500;
/** The window with chunk coalescing on: a delta run is ONE entry, so the cap
 *  now counts tool / progress / chunk-burst entries, not tokens. */
export const MIRROR_MAX_EVENTS_COALESCED = 2_000;
/** Chunk coalescing: flush a merged `chunk` entry after this long… */
export const MIRROR_COALESCE_MAX_MS = 250;
/** …or once its text reaches this many chars (bounds one Redis entry). */
export const MIRROR_COALESCE_MAX_CHARS = 16_000;
/** After the first replay a poll reads only the newest entries (the whole
 *  window again only when a gap says it might have missed some). */
export const MIRROR_TAIL_READ = 256;

/** RUN_MIRROR_COALESCE_DISABLED=1 — one mirror entry per delta + the 500 window + whole-window polls (pre-2026-10-20). */
export function mirrorCoalesceDisabled(): boolean {
  return process.env.RUN_MIRROR_COALESCE_DISABLED === '1';
}

/** The live window size (switch-dependent). */
export function mirrorMaxEvents(): number {
  return mirrorCoalesceDisabled() ? MIRROR_MAX_EVENTS : MIRROR_MAX_EVENTS_COALESCED;
}
/** Comfortably outlives any chat run (council backstops top out at 40 min). */
export const MIRROR_TTL_SEC = 2 * 60 * 60;
/** Poll cadence for new entries while tailing cross-instance. */
export const MIRROR_POLL_MS = 500;
/** isChatBusy hits Redis + the DB — recheck at most this often while quiet. */
const BUSY_RECHECK_MS = 2_000;

const TERMINAL_TYPES = new Set(['complete', 'error']);

export interface MirroredRunEvent {
  type: string;
  data: any;
  seq: number;
  /** Server wall-clock of the event (live-runs pushRunEvent stamp, 2026-09-08) — rides every replayed frame. */
  ts?: string;
  /** Run-generation marker (stamped per tap) — seqs restart at 1 when a queue
   *  drain starts the next run, so seq alone can't tell generations apart. */
  run?: string;
  /** A COALESCED chunk entry: the seq of its first delta (`seq` is the last). */
  seqFrom?: number;
}

/** Drop the previous run's mirror (called by startDetachedChatRun BEFORE the
 *  new run's tap is wired, so a fresh run never replays stale events). */
export async function clearRunEventMirror(chatId: string): Promise<void> {
  // Fully guarded (2026-10-20): guest runs now clear a mirror too, and a run
  // start must never fail on the mirror — not even on a synchronous throw.
  try { await redisClient.del(EVENTS_KEY(chatId)); } catch { /* best-effort */ }
}

/**
 * Mirror one run event (wired as the live-run tap — called synchronously in
 * the run's event path, so this is strictly fire-and-forget). Commands are
 * issued in event order on the shared client, so the list stays ordered.
 */
export function mirrorChatRunEvent(chatId: string, runMarker: string, e: RunEvent): void {
  try {
    const key = EVENTS_KEY(chatId);
    void redisClient
      // ts (2026-09-08): the event's server wall-clock rides the mirror so a
      // cross-instance attach/replay stamps parts with when they happened —
      // post-deploy verification found this the one frame path still without it.
      // Generated images (2026-09-24 review): url + fileId only — never the
      // base64 the live frame carries (the bytes live in generated_files).
      .rPush(key, JSON.stringify({ type: e.type, data: durableEventData(e.type, e.data), seq: e.seq ?? 0, run: runMarker, ...(e.ts ? { ts: e.ts } : {}), ...(typeof (e as MirroredRunEvent).seqFrom === 'number' ? { seqFrom: (e as MirroredRunEvent).seqFrom } : {}) }))
      .then(() => Promise.all([
        redisClient.lTrim(key, -mirrorMaxEvents(), -1),
        redisClient.expire(key, MIRROR_TTL_SEC),
      ]))
      .catch(() => { /* best-effort — a mirror miss must never break the run */ });
  } catch { /* same: the tap must never throw into pushRunEvent */ }
}

/** The tap startDetachedChatRun wires for a chat run — one fresh generation
 *  marker per run, so cross-instance viewers can tell a drain-started
 *  follow-up run apart from the one they were tailing. */
export function chatRunMirrorTap(chatId: string): (e: RunEvent) => void {
  const runMarker = randomUUID().slice(0, 8);
  const write = (e: RunEvent) => mirrorChatRunEvent(chatId, runMarker, e);
  if (mirrorCoalesceDisabled()) return write;
  return createChunkCoalescer(write);
}

/** A plain text delta (`{ content: string }` and nothing else) — the only shape merged. */
function isCoalescableChunk(e: RunEvent): boolean {
  if (e.type !== 'chunk' || !e.data || typeof e.data !== 'object') return false;
  const keys = Object.keys(e.data);
  return keys.length === 1 && keys[0] === 'content' && typeof e.data.content === 'string';
}

/**
 * Merge consecutive `chunk` deltas into ONE mirror entry (2026-10-20): the
 * producer emits one chunk per text delta, so a long answer alone used to
 * overflow the window and a cross-box reattach replayed only its tail. The
 * merged entry carries the concatenated text (identical bytes), the LAST
 * delta's seq (consumers dedupe on `seq <= lastSeq` — still monotonic), the
 * FIRST delta's seq as `seqFrom` (the truncation check) and the first delta's
 * ts. Any other event flushes the pending merge FIRST, so the list keeps the
 * run's order; a timer flushes a quiet tail (≤ MIRROR_COALESCE_MAX_MS) so a
 * cross-box viewer never waits on the next event. Never throws.
 */
export function createChunkCoalescer(
  write: (e: RunEvent) => void,
  opts: { maxMs?: number; maxChars?: number } = {},
): (e: RunEvent) => void {
  const maxMs = opts.maxMs ?? MIRROR_COALESCE_MAX_MS;
  const maxChars = opts.maxChars ?? MIRROR_COALESCE_MAX_CHARS;
  let pending: (RunEvent & { seqFrom?: number }) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushPending = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const e = pending;
    pending = null;
    try { write(e); } catch { /* the mirror is best-effort */ }
  };
  return (e: RunEvent) => {
    try {
      if (!isCoalescableChunk(e)) {
        flushPending();
        write(e);
        return;
      }
      if (pending) {
        pending = { ...pending, data: { content: `${pending.data.content}${e.data.content}` }, seq: e.seq };
      } else {
        pending = { type: 'chunk', data: { content: e.data.content }, seq: e.seq, seqFrom: e.seq, ...(e.ts ? { ts: e.ts } : {}) };
      }
      if (String(pending.data.content).length >= maxChars) { flushPending(); return; }
      if (!timer) {
        timer = setTimeout(flushPending, maxMs);
        (timer as any).unref?.();
      }
    } catch { /* the tap must never throw into pushRunEvent */ }
  };
}

/** The whole mirrored window, oldest first (malformed entries skipped). */
export async function readMirroredEvents(chatId: string): Promise<MirroredRunEvent[]> {
  return parseMirrorEntries(await redisClient.lRange(EVENTS_KEY(chatId), 0, -1));
}

/** The newest `n` mirrored entries, oldest first (malformed entries skipped). */
export async function readMirroredTail(chatId: string, n: number): Promise<MirroredRunEvent[]> {
  return parseMirrorEntries(await redisClient.lRange(EVENTS_KEY(chatId), -n, -1));
}

function parseMirrorEntries(raw: string[]): MirroredRunEvent[] {
  const events: MirroredRunEvent[] = [];
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry);
      if (parsed && typeof parsed.type === 'string' && typeof parsed.seq === 'number') events.push(parsed);
    } catch { /* skip a malformed entry rather than poisoning the replay */ }
  }
  return events;
}

/** The first seq an entry covers (a coalesced chunk spans seqFrom..seq). */
const firstSeqOf = (e: MirroredRunEvent): number => (typeof e.seqFrom === 'number' ? e.seqFrom : e.seq);

/**
 * Post-run remote replay: the run finished on the OTHER instance moments ago
 * (local FINISHED_RETENTION_MS replay only helps the executing instance), but
 * the mirror (TTL 2h) still holds the full window incl. the terminal. Replay
 * it instead of an interrupted lie. Returns false (nothing written) when the
 * mirror is empty or holds no terminal — the caller falls back to its honest
 * interrupted.
 */
export async function replayFinishedRemoteRun(res: SSEResponse, chatId: string): Promise<boolean> {
  // Only the just-finished race window (client checked busy=true, run finished
  // before its SSE landed) gets a replay — a stale attach hours later must
  // still no-op, or it would rebuild a message the client already has. The
  // TTL is refreshed on every push, so remaining TTL dates the last event.
  const RECENT_FINISH_MS = 60_000;
  const ttlMs = await redisClient.pTTL(EVENTS_KEY(chatId)).catch(() => -1);
  if (ttlMs < MIRROR_TTL_SEC * 1000 - RECENT_FINISH_MS) return false;
  const events = await readMirroredEvents(chatId).catch(() => [] as MirroredRunEvent[]);
  if (!events.some(e => TERMINAL_TYPES.has(e.type))) return false;
  const heartbeat = openSSEStream(res);
  try {
    // Replay only the LAST generation in the window (a drain-started follow-up
    // DELs first, so in practice one generation — belt and suspenders).
    const lastGen = events[events.length - 1]?.run ?? null;
    for (const e of events) {
      if (res.writableEnded) break;
      if ((e.run ?? null) !== lastGen) continue;
      try { res.write(`data: ${JSON.stringify({ type: e.type, data: e.data, ...(e.ts ? { ts: e.ts } : {}) })}\n\n`); } catch { break; }
      if (TERMINAL_TYPES.has(e.type)) break;
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
  return true;
}

/** Minimal Express-compatible surfaces (structural — keeps this testable
 *  without express, matching live-runs' SSE helpers). */
interface SSERequest { on(event: 'close', cb: () => void): void }
interface SSEResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  writableEnded: boolean;
}

/** What a cross-instance attach's first replay held (sse_reattach telemetry). */
export interface RemoteReplayInfo { events: number; truncated: boolean }
/** A viewer that left before the terminal (sse_viewer_drop telemetry). */
export interface RemoteDropInfo { eventsWritten: number; elapsedMs: number }

/**
 * Cross-instance attach: SSE-stream a busy plain chat's mirrored run events.
 * Replays the list, then polls for new entries (seq-deduped — LTRIM shifts
 * list indices, so an index cursor would starve once the list saturates; the
 * bounded whole-window read + monotonic-seq filter is trim-proof). Ends on
 * the terminal marker, on run end without one (honest interrupted), or on
 * viewer disconnect. Never cancels the run (runs are detached).
 *
 * `chatId` is the MIRROR id: a chat id, or guestMirrorId(sid) for a guest
 * session — whose liveness is not chat-busy, so the guest attach passes its
 * own `isBusy` (default: isChatBusy(chatId)). `onReplay` fires once with the
 * first batch's shape; `onDrop` fires when the VIEWER leaves before any
 * terminal was written (never on our own end). With coalescing on (the
 * default), polls after the first replay read only the newest
 * MIRROR_TAIL_READ entries and fall back to the whole window on a seq gap.
 */
export function attachRemoteChatRun(opts: {
  req: SSERequest;
  res: SSEResponse;
  chatId: string;
  isBusy?: () => Promise<boolean>;
  onReplay?: (info: RemoteReplayInfo) => void;
  onDrop?: (info: RemoteDropInfo) => void;
}): void {
  const { req, res, chatId } = opts;
  const isBusy = opts.isBusy ?? (() => isChatBusy(chatId));
  const heartbeat = openSSEStream(res); // 20s keepalive comments (shared SSE pattern)
  const openedAt = Date.now();
  let ended = false;
  let polling = false;
  let lastSeq = 0;
  let written = 0;
  let lastRunMarker: string | null = null;
  // The caller (streamChatRun) checked isChatBusy immediately before attaching
  // — skip an instant recheck on the first quiet poll.
  let lastBusyCheckAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const end = () => {
    if (ended) return;
    ended = true;
    if (timer) clearInterval(timer);
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  req.on('close', () => {
    // A close we did not cause (no terminal / hand-off written, the response
    // still open) is the VIEWER leaving mid-run — report it, then clean up.
    if (!ended && !res.writableEnded && opts.onDrop) {
      try { opts.onDrop({ eventsWritten: written, elapsedMs: Date.now() - openedAt }); } catch { /* telemetry never breaks the attach */ }
    }
    end();
  });

  const writeEvent = (type: string, data: any, ts?: string) => {
    try { if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ type, data, ...(ts ? { ts } : {}) })}\n\n`); written++; } } catch { /* viewer gone */ }
  };

  /** Emit every unseen event; returns what the sweep saw. */
  const writeBatch = (events: MirroredRunEvent[]): { arrived: number; terminal: boolean } => {
    let arrived = 0;
    for (const e of events) {
      if (ended || res.writableEnded) break;
      // A drain-started follow-up run re-begins at seq 1 after the DEL — its
      // fresh generation marker appears mid-tail. If we were already tailing a
      // PREVIOUS generation, that run's terminal was eaten by the follow-up's
      // DEL (it can start within ~100ms of the finally): finalize the viewer's
      // message with a synthesized complete and end this attach — the message
      // is fully persisted, and the client's normal busy logic re-attaches to
      // the new run on its own (review 2026-08-16). A first batch (marker
      // still null) just adopts the generation and resets the cursor.
      if ((e.run ?? null) !== lastRunMarker) {
        if (lastRunMarker !== null) {
          writeEvent('complete', { handedOff: true });
          return { arrived, terminal: true };
        }
        lastRunMarker = e.run ?? null;
        lastSeq = 0;
      }
      if (e.seq <= lastSeq) continue;
      writeEvent(e.type, e.data, e.ts);
      lastSeq = e.seq;
      arrived++;
      if (TERMINAL_TYPES.has(e.type)) return { arrived, terminal: true };
    }
    return { arrived, terminal: false };
  };

  let firstBatch = true;
  /**
   * The poll's read: the whole window for the first replay (and always under
   * RUN_MIRROR_COALESCE_DISABLED=1 — the pre-2026-10-20 read); afterwards only
   * the newest MIRROR_TAIL_READ entries (the 2 000-entry window would be a
   * multi-MB read twice a second), unless that tail is FULL and starts past
   * the cursor (lastSeq + 1) in the generation being tailed — then events may
   * have slipped past it, so the whole window is read instead.
   */
  const readWindow = async (): Promise<MirroredRunEvent[]> => {
    if (firstBatch || mirrorCoalesceDisabled()) return readMirroredEvents(chatId);
    const tail = await readMirroredTail(chatId, MIRROR_TAIL_READ);
    const head = tail[0];
    if (tail.length >= MIRROR_TAIL_READ && head && (head.run ?? null) === lastRunMarker && firstSeqOf(head) > lastSeq + 1) {
      return readMirroredEvents(chatId);
    }
    return tail;
  };

  const poll = async () => {
    if (ended || res.writableEnded || polling) return;
    polling = true;
    try {
      const events = await readWindow().catch(() => [] as MirroredRunEvent[]);
      // Replay truncation notice (parity with the local ring buffer's, which
      // announces dropped events on attach): a saturated window whose first
      // entry is past seq 1 lost its head to LTRIM — say so instead of
      // silently replaying only the tail (review 2026-08-16).
      if (firstBatch && events.length > 0) {
        firstBatch = false;
        const truncated = events.length >= mirrorMaxEvents() && firstSeqOf(events[0]) > 1;
        if (truncated) {
          writeEvent('progress', { message: 'Earlier live output was truncated (the full transcript is saved to the chat).', stage: 'truncated' });
        }
        if (opts.onReplay) { try { opts.onReplay({ events: events.length, truncated }); } catch { /* telemetry never breaks the attach */ } }
      }
      const { arrived, terminal } = writeBatch(events);
      if (terminal) { end(); return; }
      if (arrived || Date.now() - lastBusyCheckAt < BUSY_RECHECK_MS) return;
      lastBusyCheckAt = Date.now();
      if (await isBusy()) return;
      // Run over: one final sweep for a terminal that landed between the read
      // and the busy check; only a run that truly ended without one (crash /
      // pre-mirror instance) gets the honest interrupted.
      const finalSweep = writeBatch(await readMirroredEvents(chatId).catch(() => []));
      if (!finalSweep.terminal) writeEvent('complete', { interrupted: true });
      end();
    } finally {
      polling = false;
    }
  };
  timer = setInterval(() => { void poll(); }, MIRROR_POLL_MS);
  void poll(); // don't sit out the first interval — the replay should be immediate
}
