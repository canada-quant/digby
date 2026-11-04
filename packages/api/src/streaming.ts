/**
 * SSE streaming for @digby/api (M0 — roadmap §3.4).
 *
 * The mobile client cannot use EventSource with auth headers, so it streams
 * the SAME SSE endpoints the web client uses via an injectable streaming fetch
 * (expo/fetch on mobile — WinterCG-compliant with `resp.body.getReader()`):
 *
 *   SEND a message:   POST /api/crossmodel/stream/register (Bearer)
 *                     → { streamToken }
 *                     GET  /api/crossmodel/stream?streamToken=… (Bearer)
 *   ATTACH to a run:  GET  /api/crossmodel/chats/:id/stream (Bearer)
 *
 * Both stream routes authenticate via optionalAuthenticate, which checks
 * `Authorization: Bearer` FIRST (middleware/auth.ts) — pinned by
 * route-posture.test.ts (mobile Bearer-on-SSE describe block).
 *
 * Frame grammar (identical to the web client's EventSource handling in
 * CodeSessionView.tsx / page.tsx):
 *   data: {"type":"chunk","data":{"content":"…"}}\n\n
 *   : hb\n\n                                        (heartbeat comment)
 *   id: <runId>:<seq>\ndata: {…}\n\n                 (coding frames — resume cursor)
 *
 * The parser below is a pure function over bytes→events so it is unit-testable
 * without a server (see smoke.ts §streaming).
 */

import type { DigbyApiClient, FetchLike, FetchResponse, StreamReader } from './client';
import { ApiError } from './client';

export type { StreamReader };

// ── Event vocabulary (backend chat-agent/sse-adapter.ts + coding streams) ───

/** Text deltas of the assistant answer. */
export interface SseChunkEvent { type: 'chunk'; data: { content: string } }
/** Progress/status lines ("Digby is searching…"). */
export interface SseProgressEvent { type: 'progress'; data: { message: string; stage: string } }
/** Model card (seat label + draft summary) at subagent end. */
export interface SseModelResponseEvent {
  type: 'model-response';
  data: { model: string; response: string; time: number; persona: string; modelUsed: string; webSearchUsed: boolean; error?: string };
}
/** A new/existing chat title — the ONLY event that reveals a chatless send's chatId. */
export interface SseChatTitleEvent { type: 'chat-title'; data: { chatId: string; title: string } }
/** Terminal success. */
export interface SseCompleteEvent {
  type: 'complete';
  data: {
    finalText?: string;
    models?: unknown[];
    synthesisTime?: number;
    totalTime?: number;
    sources?: unknown[];
    followUps?: string[];
    autoTitle?: string;
    engine?: string;
    sessionId?: string | null;
    messageId?: string;
    pendingCrossCheck?: boolean;
    [k: string]: unknown;
  };
}
/** Terminal failure. */
export interface SseErrorEvent { type: 'error'; data: { message: string } }
/** Coding-run init (mode/engine metadata). */
export interface SseInitEvent { type: 'init'; data: { mode?: string; engine?: string; webSearch?: boolean } }
/** Replay backlog marker (coding attach). */
export interface SseReplayEndEvent { type: 'replay_end'; data: { throughSeq: string | number } }
/** Reasoning deltas (agent activity). */
export interface SseThinkingSummaryEvent { type: 'thinking-summary'; data: { summary: string } }
/** Tool/agent activity rows. */
export interface SseAgentActivityEvent {
  type: 'agent-activity';
  data: { kind: string; label: string; delta?: string; name?: string; detail?: string; size?: number; time?: number };
}

/** The union the mobile client renders. Unknown types stay raw (forward-compat). */
export type SseEvent =
  | SseChunkEvent | SseProgressEvent | SseModelResponseEvent | SseChatTitleEvent
  | SseCompleteEvent | SseErrorEvent | SseInitEvent | SseReplayEndEvent
  | SseThinkingSummaryEvent | SseAgentActivityEvent
  | { type: string; data?: unknown; raw: string };

// ── Frame parser (pure — unit-testable) ─────────────────────────────────────

export interface ParsedFrame {
  /** `data` payload parsed from JSON (unknown types keep `raw`). */
  event: SseEvent;
  /** The `id:` line, when present (coding resume cursor `<runId>:<seq>`). */
  id?: string;
}

/**
 * Incremental SSE frame parser. Feed it decoded text chunks; it buffers until
 * a complete `\n\n`-terminated frame arrives. Handles: `data:` lines (multi-
 * line concatenated per the SSE spec), `id:` lines, `: comment` heartbeats
 * (ignored), and `\r\n` line endings.
 */
export class SseParser {
  private buffer = '';

  /** Feed a decoded text chunk; returns the complete frames it completed. */
  push(text: string): ParsedFrame[] {
    // Normalize \r\n → \n up front: a CRLF-terminated frame ends \r\n\r\n,
    // which contains no bare \n\n — without normalization CRLF frames never
    // emit (caught by the smoke test's CRLF case).
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const frames: ParsedFrame[] = [];
    // Per the SSE spec the event terminator is a blank line.
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const frame = this.parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private parseFrame(raw: string): ParsedFrame | null {
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue; // blank/comment
      if (line.startsWith('data:')) {
        // Spec: a single leading space after the colon is stripped.
        const v = line.slice(5);
        dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
      } else if (line.startsWith('id:')) {
        const v = line.slice(3);
        id = v.startsWith(' ') ? v.slice(1) : v;
      }
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    let event: SseEvent;
    try {
      const parsed = JSON.parse(data) as { type?: string; data?: unknown };
      event = { type: String(parsed?.type ?? ''), data: parsed?.data, ...(id ? {} : {}) } as SseEvent;
    } catch {
      event = { type: 'raw', raw: data };
    }
    return { event, id };
  }
}

// ── Streaming connection (transport-bound half) ─────────────────────────────

/** What the caller controls (abort + event sink). */
export interface StreamHandlers {
  onEvent(ev: SseEvent, frameId?: string): void;
  /** Cancellation. Call `dispose()` and the reader is cancelled + aborted. */
  signal?: { aborted: boolean; addEventListener?(t: 'abort', cb: () => void): void };
}

export interface StreamHandle {
  /** Resolves when the stream ends (terminal event, error, or abort). */
  done: Promise<void>;
  /** Tear down the connection (viewer-only disconnect; never cancels the run). */
  dispose(): void;
}

/** Byte-level fallback for hosts with no TextDecoder (latin-1 — degraded, see note). */
function byteFallback(v: Uint8Array): string {
  // NOTE: no TextDecoder host — this cannot bridge a UTF-8 sequence split
  // across reads. Every supported host (expo/RN, Node 18+, browsers) has
  // TextDecoder, so this is a last-resort degradation, not a supported path.
  let s = '';
  for (const b of v) s += String.fromCharCode(b);
  return s;
}

/**
 * Open a Bearer-authenticated SSE connection and pump events to `handlers`.
 * Works with any FetchLike whose responses expose `body.getReader()`
 * (expo/fetch, native fetch, undici). Non-2xx → ApiError (no retry loop —
 * a stream that 401s mid-conversation is surfaced to the caller, who can
 * refresh + reopen).
 */
export async function openStream(
  client: DigbyApiClient,
  path: string,
  handlers: StreamHandlers,
  opts?: { headers?: Record<string, string> }
): Promise<StreamHandle> {
  const { baseUrl, doFetch } = client.transport;
  const token = await client.freshAccessToken();
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...opts?.headers,
  };

  // ONE decoder per CONNECTION with {stream:true}: a multi-byte UTF-8 char
  // split across two reads stays pending in the decoder until its tail bytes
  // arrive (a fresh decoder per chunk would emit U+FFFD twice — review B1).
  const TD = (globalThis as unknown as {
    TextDecoder?: new (enc: string) => { decode(u?: Uint8Array, o?: { stream?: boolean }): string };
  }).TextDecoder;
  const decoder = TD ? new TD('utf-8') : undefined;

  let disposed = false;
  let reader: StreamReader | undefined;

  const done = (async () => {
    let res: FetchResponse;
    try {
      res = await doFetch(`${baseUrl}${path}`, { headers });
    } catch (err) {
      if (!disposed) handlers.onEvent({ type: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (!disposed) handlers.onEvent({ type: 'error', data: { message: text || `Stream failed with status ${res.status}` } });
      return;
    }
    if (!res.body?.getReader) {
      if (!disposed) handlers.onEvent({ type: 'error', data: { message: 'Transport does not support streaming responses (body.getReader missing)' } });
      return;
    }
    const parser = new SseParser();
    reader = res.body.getReader();
    try {
      for (;;) {
        const { done: rdDone, value } = await reader.read();
        if (rdDone || disposed || value == null) break;
        const text =
          typeof value === 'string'
            ? value
            : decoder
              ? decoder.decode(value, { stream: true })
              : byteFallback(value);
        for (const f of parser.push(text)) {
          handlers.onEvent(f.event, f.id);
        }
      }
      // End of stream: flush any UTF-8 tail still pending in the decoder (a
      // stream truncated mid-char yields U+FFFD here — the correct outcome).
      if (decoder && !disposed) {
        const tail = decoder.decode();
        if (tail) for (const f of parser.push(tail)) handlers.onEvent(f.event, f.id);
      }
    } catch (err) {
      // A dropped connection ends the stream; the RUN survives server-side
      // (detached runs) — the caller re-attaches via chatStream().
      if (!disposed) handlers.onEvent({ type: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
    } finally {
      try { await reader.cancel?.(); } catch { /* already closed */ }
    }
  })();

  return {
    done,
    dispose(): void {
      disposed = true;
      try { reader?.cancel?.(); } catch { /* already closed */ }
    },
  };
}

// ── Typed streaming endpoints ───────────────────────────────────────────────

export interface SendMessageParams {
  message: string;
  chatId?: string;
  mode?: 'single_thinking' | 'thinking' | 'deep_research' | 'auto';
  uploadIds?: string[];
}

export interface SendMessageResult {
  stream: StreamHandle;
  /** The chat id, once known (from a `chat-title` event — chatless first sends). */
  chatId: Promise<string | undefined>;
}

/**
 * Send a message and stream the response (the mobile twin of the web client's
 * register→EventSource flow). Uses the two-phase register (works for any
 * message length, keeps the SSE URL tiny) with the Bearer token on BOTH legs
 * — the register's ownership check binds the streamToken to this user.
 */
export async function sendMessageStream(
  client: DigbyApiClient,
  params: SendMessageParams,
  onEvent: (ev: SseEvent) => void
): Promise<SendMessageResult> {
  // 1. Register (Bearer) — the register response carries NO auth-refresh loop;
  //    a 401 here means the caller should refresh+retry.
  const { baseUrl, doFetch } = client.transport;
  const token = await client.freshAccessToken();
  const regHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const body: Record<string, unknown> = { message: params.message, mode: params.mode ?? 'single_thinking' };
  if (params.chatId) body.chatId = params.chatId;
  if (params.uploadIds?.length) body.uploadId = params.uploadIds;

  const regRes = await doFetch(`${baseUrl}/api/crossmodel/stream/register`, {
    method: 'POST',
    headers: regHeaders,
    body: JSON.stringify(body),
  });
  if (!regRes.ok) {
    const text = await regRes.text().catch(() => '');
    throw new ApiError(regRes.status, text || `Register failed with status ${regRes.status}`, '/api/crossmodel/stream/register');
  }
  const regJson = (await regRes.json()) as { streamToken?: string };
  if (!regJson.streamToken) throw new ApiError(500, 'Register response missing streamToken', '/api/crossmodel/stream/register');

  // 2. Stream (Bearer) — the register's ownership check requires the SAME
  //    authenticated identity on both legs.
  let resolveChatId: (id: string | undefined) => void;
  const chatId = new Promise<string | undefined>((r) => { resolveChatId = r; });
  let chatIdResolved = false;

  const stream = await openStream(
    client,
    `/api/crossmodel/stream?streamToken=${encodeURIComponent(regJson.streamToken)}`,
    {
      onEvent: (ev, frameId) => {
        if (ev.type === 'chat-title' && !chatIdResolved) {
          chatIdResolved = true;
          resolveChatId?.((ev as SseChatTitleEvent).data.chatId);
        }
        onEvent(ev);
      },
    }
  );
  void stream.done.then(() => { if (!chatIdResolved) resolveChatId?.(undefined); });
  return { stream, chatId };
}

/**
 * Attach to a chat's ACTIVE run (viewer — a disconnect never cancels the run).
 * The mobile app uses this on app foreground / screen focus to resume a live
 * turn (roadmap §3.2 item 3: close on background, re-open on foreground).
 */
export function attachChatStream(
  client: DigbyApiClient,
  chatId: string,
  onEvent: (ev: SseEvent) => void
): Promise<StreamHandle> {
  return openStream(client, `/api/crossmodel/chats/${encodeURIComponent(chatId)}/stream`, { onEvent });
}

/**
 * Upload an image (base64 JSON — the browser path's exact body shape) through
 * the existing open /upload endpoint. Returns the uploadId the stream
 * registration accepts as `uploadId: [ … ]`.
 */
export async function uploadImage(
  client: DigbyApiClient,
  image: { filename: string; mimeType: string; base64: string }
): Promise<{ uploadId: string; type: string; filename: string; preview?: string; documentId?: string }> {
  const { baseUrl, doFetch } = client.transport;
  const token = await client.freshAccessToken();
  const res = await doFetch(`${baseUrl}/api/crossmodel/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(image),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `Upload failed with status ${res.status}`, '/api/crossmodel/upload');
  }
  return (await res.json()) as { uploadId: string; type: string; filename: string; preview?: string; documentId?: string };
}
