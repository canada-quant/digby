/**
 * Live cross-box worktree file read over Redis pub/sub (owner 2026-09-17 —
 * "how come I can't view this specific file because it's on a different
 * worktree? I'm confused").
 *
 * WHY: the coding worktrees live on ONE box (C — the coding box owns the
 * `crossmodel_coding_workspaces` volume). The web boxes (A/B) behind the ALB
 * serve the Files tab from the Redis SNAPSHOT that C publishes after each
 * terminal run (worktree-snapshot.service). That snapshot is bounded — at
 * most 256 KB of file CONTENT per session — so a file past the budget, a
 * binary-sniffed one, or one written after the last run LISTS but cannot open
 * ("This file isn't in the shared snapshot…"). The web boxes cannot read the
 * volume directly (B has no network path to C's docker proxy), but every box
 * shares the Redis on A — so the web backend ASKS over Redis and the worker
 * on the box that hosts the worktree answers.
 *
 * Protocol (fire-and-forget, one request → at most one useful reply):
 *   web  → PUBLISH  digby:worktree:read:req   {id, sessionId, rel, replyTo}
 *   host → PUBLISH  <replyTo>                 {id, ok, path, content} | {id, ok:false, status, error}
 * The requester waits REMOTE_READ_TIMEOUT_MS; a PUBLISH that reaches ZERO
 * subscribers resolves null immediately (no responder online — don't wait).
 * Only a worker with coding slots (CODING_WORKER_CONCURRENCY > 0) runs the
 * responder: box A's 0-slot cron-only worker still mounts a STALE pre-split
 * copy of the volume and must never answer with it. A responder that does
 * not host the requested worktree stays silent (another box may).
 *
 * SECURITY: ownership is enforced by the web handler BEFORE it asks
 * (resolveOwnedWorktree — the caller must own the session); the responder
 * re-applies the disk path's guards (resolveSafeWorktreePath realpath
 * containment, .git/node_modules bans, 256 KB cap, binary sniff) so a request
 * can never read outside that session's worktree. Requests carry only the
 * session id and a worktree-relative path — never an absolute path.
 *
 * op 'devc' (2026-10-13 — Account → Coding → Dev container): the same channel
 * carries the dev-container operations the web boxes cannot run (no Docker on
 * A/B since 2026-09-24): {devc: {userId, action, args?}} instead of a session
 * path. The responder hands it to dev-container-remote.handleDevcRequest,
 * which stays SILENT unless this process has Docker; ownership is the web
 * handler's (the userId is the authenticated caller's own). The reply carries
 * `devc` (the handler's JSON result) — never a credential.
 */

import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import logger from '../../../utils/logger';
import { worktreePath } from './workspace.service';

/** The app's Redis client, loaded lazily: config/redis validates the whole
 *  env at import time, and this module is reached from request handlers that
 *  many hermetic suites import without a Redis mock. */
async function appRedis(): Promise<PubSubClient> {
  const mod = await import('../../../config/redis');
  return mod.default as unknown as PubSubClient;
}

export const REMOTE_READ_REQUEST_CHANNEL = 'digby:worktree:read:req';
export const REMOTE_READ_REPLY_PREFIX = 'digby:worktree:read:reply:';
export const REMOTE_READ_TIMEOUT_MS = 8_000;
/** Concurrent reads one responder serves; excess requests time out honestly on the web side. */
export const REMOTE_READ_MAX_INFLIGHT = 8;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;

export type RemoteReadReply =
  | { id: string; ok: true; path: string; content: string; diff?: { status: string; diffStat: string; error?: string; head?: string | null; upstream?: string | null; ahead?: number | null; behind?: number | null } }
  /** op 'raw' (ticket 19fbd876): the file's real BYTES as base64 — the download path skips every text guard. */
  | { id: string; ok: true; path: string; content: ''; b64: string }
  | { id: string; ok: false; status: 400 | 404 | 413 | 415 | 500; error: string }
  /** op 'devc' (2026-10-13): the dev-container handler's JSON result. */
  | { id: string; ok: true; path: ''; content: ''; devc: unknown };

/** A dev-container operation for the box that has Docker (op 'devc'). */
export interface DevcWireRequest {
  userId: string;
  action: string;
  args?: Record<string, string>;
}

const DEVC_ACTION_RE = /^[a-z][a-z_]{2,39}$/;

/** Shape check for a devc payload off the wire. Pure. */
export function isDevcWire(v: any): v is DevcWireRequest {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.userId !== 'string' || !SESSION_ID_RE.test(v.userId)) return false;
  if (typeof v.action !== 'string' || !DEVC_ACTION_RE.test(v.action)) return false;
  if (v.args !== undefined) {
    if (!v.args || typeof v.args !== 'object' || Array.isArray(v.args)) return false;
    for (const [k, val] of Object.entries(v.args)) {
      if (!/^[a-zA-Z]{1,30}$/.test(k) || typeof val !== 'string' || val.length > 100) return false;
    }
  }
  return true;
}

export interface RemoteReadRequest {
  id: string;
  sessionId: string;
  rel: string;
  replyTo: string;
  /** 'diff' (T4b, 2026-09-24): answer `git status --porcelain` + `git diff --stat` of the worktree instead of a file (rel ignored).
   *  'raw' (ticket 19fbd876): answer the file's raw base64 bytes (download path — no binary sniff, no 256 KB cap; 16 MB cap instead). */
  op?: 'read' | 'diff' | 'raw' | 'devc';
  /** op 'devc' only (sessionId/rel are '' then). */
  devc?: DevcWireRequest;
}

/** The slice of the node-redis client this module uses — injectable for tests. */
export interface PubSubClient {
  duplicate: () => PubSubClient;
  connect: () => Promise<unknown>;
  quit?: () => Promise<unknown>;
  on?: (event: string, cb: (...a: any[]) => void) => unknown;
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string, listener: (message: string, channel: string) => void) => Promise<unknown>;
  unsubscribe?: (channel: string) => Promise<unknown>;
  pSubscribe: (pattern: string, listener: (message: string, channel: string) => void) => Promise<unknown>;
  pUnsubscribe?: (pattern: string) => Promise<unknown>;
}



// ── Requester (web boxes) ─────────────────────────────────────────────────────

export interface RemoteReader {
  request: (sessionId: string, rel: string, timeoutMs?: number, op?: 'read' | 'diff' | 'raw' | 'devc', devc?: DevcWireRequest) => Promise<RemoteReadReply | null>;
  close: () => Promise<void>;
}

/**
 * One reply subscription (pattern `digby:worktree:read:reply:*`) shared by
 * every in-flight request of this process; replies are matched by id.
 */
export function createRemoteReader(client: PubSubClient): RemoteReader {
  const pending = new Map<string, (r: RemoteReadReply) => void>();
  let subscriber: PubSubClient | null = null;
  let ready: Promise<void> | null = null;

  const ensureSubscriber = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      const sub = client.duplicate();
      sub.on?.('error', (err: any) => logger.warn(`worktree remote-read: reply subscriber error — ${err?.message ?? err}`));
      await sub.connect();
      await sub.pSubscribe(`${REMOTE_READ_REPLY_PREFIX}*`, (message: string) => {
        let parsed: any;
        try { parsed = JSON.parse(message); } catch { return; }
        const resolve = parsed && typeof parsed.id === 'string' ? pending.get(parsed.id) : undefined;
        if (resolve) resolve(parsed as RemoteReadReply);
      });
      subscriber = sub;
    })();
    ready.catch(() => { ready = null; subscriber = null; });
    return ready;
  };

  return {
    async request(sessionId, rel, timeoutMs = REMOTE_READ_TIMEOUT_MS, op = 'read', devc) {
      if (op === 'devc') {
        if (!isDevcWire(devc)) return null;
      } else if (!SESSION_ID_RE.test(sessionId) || typeof rel !== 'string') return null;
      try {
        await ensureSubscriber();
      } catch (err: any) {
        logger.warn(`worktree remote-read: reply subscription unavailable — ${err?.message ?? err}`);
        return null;
      }
      const id = randomUUID();
      // op rides the wire only when it differs from the default ('read');
      // 'diff' and 'raw' (ticket 19fbd876) are the two non-default ops.
      const req: RemoteReadRequest = op === 'devc'
        ? { id, sessionId: '', rel: '', replyTo: `${REMOTE_READ_REPLY_PREFIX}${id}`, op, devc }
        : { id, sessionId, rel, replyTo: `${REMOTE_READ_REPLY_PREFIX}${id}`, ...(op !== 'read' ? { op } : {}) };
      return new Promise<RemoteReadReply | null>((resolve) => {
        let done = false;
        const finish = (r: RemoteReadReply | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          pending.delete(id);
          resolve(r);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        pending.set(id, (r) => finish(r.id === id ? r : null));
        client.publish(REMOTE_READ_REQUEST_CHANNEL, JSON.stringify(req)).then(
          (receivers) => { if (!receivers) finish(null); }, // nobody hosts worktrees right now — don't wait out the timeout
          (err: any) => {
            logger.warn(`worktree remote-read: publish failed — ${err?.message ?? err}`);
            finish(null);
          },
        );
      });
    },
    async close() {
      const sub = subscriber;
      subscriber = null;
      ready = null;
      for (const resolve of pending.values()) resolve({ id: '', ok: false, status: 500, error: 'closed' });
      pending.clear();
      if (!sub) return;
      try { await sub.pUnsubscribe?.(`${REMOTE_READ_REPLY_PREFIX}*`); } catch { /* closing */ }
      try { await sub.quit?.(); } catch { /* closing */ }
    },
  };
}

let defaultReader: RemoteReader | null = null;

/** T4b: the changes view's diff from the box that hosts the worktree (op 'diff'). */
export async function requestRemoteWorktreeDiff(sessionId: string, timeoutMs = REMOTE_READ_TIMEOUT_MS): Promise<RemoteReadReply | null> {
  if (!defaultReader) {
    try {
      defaultReader = createRemoteReader(await appRedis());
    } catch (err: any) {
      logger.warn(`worktree remote-read: Redis client unavailable — ${err?.message ?? err}`);
      return null;
    }
  }
  return defaultReader.request(sessionId, '', timeoutMs, 'diff');
}

/**
 * Ticket 19fbd876: the file's RAW BYTES (base64) from the box that hosts the
 * worktree (op 'raw') — the download path. No text guards on the responder
 * side; the 16 MB cap keeps the base64 reply under Redis's pub/sub buffer
 * limit. The reply's `b64` decodes to the exact file bytes.
 */
export async function requestRemoteWorktreeRaw(sessionId: string, rel: string, timeoutMs = REMOTE_READ_TIMEOUT_MS): Promise<RemoteReadReply | null> {
  if (!defaultReader) {
    try {
      defaultReader = createRemoteReader(await appRedis());
    } catch (err: any) {
      logger.warn(`worktree remote-read: Redis client unavailable — ${err?.message ?? err}`);
      return null;
    }
  }
  return defaultReader.request(sessionId, rel, timeoutMs, 'raw');
}

/**
 * op 'devc' (2026-10-13): run a dev-container operation on the box that has
 * Docker. null = nobody answered (no responder online, timeout, or the
 * channel is switched off) — callers say so honestly, never "not running".
 */
export async function requestRemoteDevContainer(devc: DevcWireRequest, timeoutMs = REMOTE_READ_TIMEOUT_MS): Promise<unknown | null> {
  if (!defaultReader) {
    try {
      defaultReader = createRemoteReader(await appRedis());
    } catch (err: any) {
      logger.warn(`worktree remote-read: Redis client unavailable — ${err?.message ?? err}`);
      return null;
    }
  }
  const reply = await defaultReader.request('', '', timeoutMs, 'devc', devc);
  return reply && reply.ok && 'devc' in reply ? reply.devc : null;
}

/** Process-wide requester on the app's Redis client (lazy — plain web requests never pay for it). */
export async function requestRemoteWorktreeFile(sessionId: string, rel: string, timeoutMs = REMOTE_READ_TIMEOUT_MS): Promise<RemoteReadReply | null> {
  if (!defaultReader) {
    try {
      defaultReader = createRemoteReader(await appRedis());
    } catch (err: any) {
      logger.warn(`worktree remote-read: Redis client unavailable — ${err?.message ?? err}`);
      return null;
    }
  }
  return defaultReader.request(sessionId, rel, timeoutMs);
}

// ── Responder (the box that hosts worktrees) ──────────────────────────────────

export interface ResponderHandle {
  stop: () => Promise<void>;
}

/** Read one file for a request with exactly the web handler's disk-path guards. */
export async function readForReply(root: string, req: RemoteReadRequest): Promise<RemoteReadReply> {
  // Lazy import: worktree-files imports THIS module for the requester side —
  // a static import here would be a cycle.
  const wf = await import('./worktree-files');
  const { id } = req;
  if (req.op === 'diff') {
    // T4b (2026-09-24): the changes view's two git reads, answered by the
    // box that hosts the worktree (session-diff.ts is the requester).
    try {
      const { readWorktreeDiff } = await import('./session-diff');
      const diff = await readWorktreeDiff(root);
      return { id, ok: true, path: '', content: '', diff };
    } catch (err: any) {
      logger.warn(`worktree remote-read: diff failed for ${req.sessionId} — ${err?.message ?? err}`);
      return { id, ok: false, status: 500, error: 'Could not read the diff' };
    }
  }
  if (req.op === 'raw') {
    // Ticket 19fbd876: the DOWNLOAD path — real bytes, base64, no text
    // guards. Same path jail + a 16 MB cap (the base64 reply must stay under
    // Redis's pub/sub buffer limit); binary sniff and the 256 KB inline cap
    // deliberately do NOT apply (the download exists for binaries).
    try {
      const { abs, rel } = await wf.resolveSafeWorktreePath(root, req.rel);
      const st = await fs.stat(abs);
      if (st.isDirectory()) return { id, ok: false, status: 400, error: 'Path is a directory — use the tree endpoint.' };
      if (!st.isFile()) return { id, ok: false, status: 400, error: 'Not a regular file' };
      if (st.size > wf.MAX_RAW_BYTES) {
        return { id, ok: false, status: 413, error: `File is too large to download (${st.size} bytes — the limit is ${wf.MAX_RAW_BYTES} bytes / 16 MB).` };
      }
      const buf = await fs.readFile(abs);
      if (buf.length > wf.MAX_RAW_BYTES) {
        return { id, ok: false, status: 413, error: `File is too large to download (${buf.length} bytes — the limit is ${wf.MAX_RAW_BYTES} bytes / 16 MB).` };
      }
      return { id, ok: true, path: rel, content: '', b64: buf.toString('base64') };
    } catch (err: any) {
      if (err instanceof wf.WorktreeFilesError) {
        const status = err.statusCode === 404 ? 404 : 400;
        return { id, ok: false, status, error: err.message };
      }
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { id, ok: false, status: 404, error: 'Path not found in the worktree' };
      logger.warn(`worktree remote-read: raw read failed for ${req.sessionId}/${req.rel} — ${err?.message ?? err}`);
      return { id, ok: false, status: 500, error: 'Could not read the file' };
    }
  }
  try {
    const { abs, rel } = await wf.resolveSafeWorktreePath(root, req.rel);
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { id, ok: false, status: 400, error: 'Path is a directory — use the tree endpoint.' };
    if (!st.isFile()) return { id, ok: false, status: 400, error: 'Not a regular file' };
    if (st.size > wf.MAX_FILE_BYTES) {
      return { id, ok: false, status: 413, error: `File is too large to view inline (${st.size} bytes — the limit is ${wf.MAX_FILE_BYTES} bytes / 256 KB).` };
    }
    const buf = await fs.readFile(abs);
    if (buf.length > wf.MAX_FILE_BYTES) {
      return { id, ok: false, status: 413, error: `File is too large to view inline (${buf.length} bytes — the limit is ${wf.MAX_FILE_BYTES} bytes / 256 KB).` };
    }
    if (wf.isProbablyBinary(buf.subarray(0, wf.SNIFF_BYTES))) {
      return { id, ok: false, status: 415, error: 'Binary file — only UTF-8 text files can be viewed inline.' };
    }
    const content = buf.toString('utf8');
    if (content.includes('�')) {
      return { id, ok: false, status: 415, error: 'Binary file — only UTF-8 text files can be viewed inline.' };
    }
    return { id, ok: true, path: rel, content };
  } catch (err: any) {
    if (err instanceof wf.WorktreeFilesError) {
      const status = err.statusCode === 404 ? 404 : 400;
      return { id, ok: false, status, error: err.message };
    }
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { id, ok: false, status: 404, error: 'Path not found in the worktree' };
    logger.warn(`worktree remote-read: read failed for ${req.sessionId}/${req.rel} — ${err?.message ?? err}`);
    return { id, ok: false, status: 500, error: 'Could not read the file' };
  }
}

/**
 * Subscribe to read requests and answer the ones whose worktree is on THIS
 * box. Start only on a worker with coding slots (see the module header).
 */
export async function startWorktreeReadResponder(opts?: {
  client?: PubSubClient;
  /** Worktree root for a session id (default: the shared workspace layout). */
  resolveRoot?: (sessionId: string) => string;
  /** op 'devc' handler (default: dev-container-remote.handleDevcRequest). null = stay silent. */
  handleDevc?: (devc: DevcWireRequest, requestId: string) => Promise<unknown | null>;
}): Promise<ResponderHandle> {
  const client = opts?.client ?? await appRedis();
  const resolveRoot = opts?.resolveRoot ?? worktreePath;
  const handleDevc = opts?.handleDevc ?? (async (devc: DevcWireRequest, requestId: string) => {
    // Lazy: dev-container-remote imports this module for the requester side.
    const mod = await import('./dev-container-remote');
    return mod.handleDevcRequest(devc, requestId);
  });
  const sub = client.duplicate();
  sub.on?.('error', (err: any) => logger.warn(`worktree remote-read: request subscriber error — ${err?.message ?? err}`));
  await sub.connect();
  let inflight = 0;

  const answer = async (req: RemoteReadRequest) => {
    const root = resolveRoot(req.sessionId);
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) return; // not hosted here — stay silent, another box may answer
    const reply = await readForReply(root, req);
    await client.publish(req.replyTo, JSON.stringify(reply)).catch((err: any) => {
      logger.warn(`worktree remote-read: reply publish failed — ${err?.message ?? err}`);
    });
  };

  const answerDevc = async (req: RemoteReadRequest) => {
    const result = await handleDevc(req.devc as DevcWireRequest, req.id);
    if (result === null || result === undefined) return; // no Docker here — another box may answer
    const reply: RemoteReadReply = { id: req.id, ok: true, path: '', content: '', devc: result };
    await client.publish(req.replyTo, JSON.stringify(reply)).catch((err: any) => {
      logger.warn(`worktree remote-read: devc reply publish failed — ${err?.message ?? err}`);
    });
  };

  await sub.subscribe(REMOTE_READ_REQUEST_CHANNEL, (message: string) => {
    let req: any;
    try { req = JSON.parse(message); } catch { return; }
    if (req && req.op === 'devc') {
      if (typeof req.id !== 'string' || typeof req.replyTo !== 'string'
        || !req.replyTo.startsWith(REMOTE_READ_REPLY_PREFIX) || !isDevcWire(req.devc)) return;
      if (inflight >= REMOTE_READ_MAX_INFLIGHT) return; // overloaded — the requester times out honestly
      inflight++;
      void answerDevc(req as RemoteReadRequest)
        .catch((err: any) => logger.warn(`worktree remote-read: devc responder error — ${err?.message ?? err}`))
        .finally(() => { inflight--; });
      return;
    }
    if (!req || typeof req.id !== 'string' || typeof req.sessionId !== 'string'
      || typeof req.rel !== 'string' || typeof req.replyTo !== 'string') return;
    if (!SESSION_ID_RE.test(req.sessionId) || !req.replyTo.startsWith(REMOTE_READ_REPLY_PREFIX)) return;
    if (inflight >= REMOTE_READ_MAX_INFLIGHT) return; // overloaded — the requester times out honestly
    inflight++;
    void answer(req as RemoteReadRequest)
      .catch((err: any) => logger.warn(`worktree remote-read: responder error — ${err?.message ?? err}`))
      .finally(() => { inflight--; });
  });
  logger.info('worktree remote-read: responder listening (this box answers Files-tab reads for the worktrees it hosts)');

  return {
    async stop() {
      try { await sub.unsubscribe?.(REMOTE_READ_REQUEST_CHANNEL); } catch { /* closing */ }
      try { await sub.quit?.(); } catch { /* closing */ }
    },
  };
}
