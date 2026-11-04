/**
 * Digby Edge (Phase 3) — RELAY CORE (cloud side).
 *
 * The relay holds every edge WebSocket tunnel in process memory. That is the
 * deliberate, documented exception to the "no module-memory cross-request
 * state" rule: a tunnel socket is process-pinned by nature. Self-host runs one
 * `relay` service; prod runs one per box per color, and the owning relay
 * advertises itself in Redis (`inst:socket:<id>`) so a peer relay forwards
 * box-to-box when the tunnel lives elsewhere (see forwardToPeerIfNeeded).
 * Cross-process liveness (the web app's GET /instances `online` flag) goes
 * through Redis presence keys, NOT this map.
 *
 * Two surfaces:
 *   1. WS tunnel endpoint — edges dial OUT to it (works behind NAT/CGNAT; no
 *      inbound connectivity to the edge ever). Auth = `Authorization: Bearer
 *      dgi_…` → sha256 → connected_instances lookup → timingSafeEqual, uniform
 *      401 on any failure (incl. status='revoked').
 *   2. HTTP proxy — the cloud admin's requests are authenticated (JWT via
 *      Bearer header or cm_access cookie), ADMIN + ownership checked, then
 *      forwarded down the tunnel as protocol frames and the edge's response
 *      streamed back (SSE must stream, not buffer).
 *
 * Tunnel protocol v1 (JSON frames over the one WS, `{ v: 1, type, streamId? }`):
 *   open  { streamId, method, path, headers, body? }   relay → edge (body base64)
 *   head  { streamId, status, headers }                edge → relay, response head
 *   data  { streamId, chunk }                          edge → relay (chunk base64)
 *   end   { streamId, status, headers }                edge → relay, completion
 *   error { streamId?, message }                       either direction
 *   ping {} / pong {}                                  edge ↔ relay keepalive
 *   paired { instanceId, token }                       relay → edge, ONCE: device-
 *                                        activation first contact (`dgp_` bearer)
 *                                        mints the row; this frame hands the edge
 *                                        its real dgi_ token before normal flow
 *
 * `head` carries the response status+headers AS SOON AS the edge's local REST
 * API produces them — the spec'd `end`-only head could not stream SSE (data
 * frames would precede any knowledge of status/content-type). The edge client
 * always sends `head` before the first `data`; `end` repeats status+headers so
 * a peer that never sent `head` still completes correctly (the relay commits
 * the outgoing response from `end` in that case, and only buffers nothing).
 * Unknown frame types/streamIds get an `error` frame — never a crash.
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import prisma from '../config/database';
import redisClient from '../config/redis';
import logger from '../utils/logger';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import {
  resolveInstanceByToken, mintInstanceFromPairClaim, PRESENCE_KEY_PREFIX,
} from '../modules/crossmodel/instances/instances.service';

export const TUNNEL_PATH = '/api/crossmodel/instances/tunnel';
export const PROXY_PATH_RE = /^\/api\/crossmodel\/instances\/([^/]+)\/proxy(\/[^?]*)?$/;
// Digby Edge (Phase 5): cloud→edge messaging sugar — POST a message into one
// chat on the edge without constructing a proxy path. Group 1 = instanceId,
// group 2 = chatId.
export const MESSAGES_PATH_RE = /^\/api\/crossmodel\/instances\/([^/]+)\/chats\/([^/]+)\/messages$/;
export const MAX_STREAMS_PER_INSTANCE = 64;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — proxied request bodies are read fully
const PRESENCE_TTL_SECONDS = 90;           // refreshed on every client ping (30s cadence)

/**
 * Multi-box prod (2026-08-31): a relay runs per box (per color), but a tunnel
 * socket lives in exactly ONE of them. The owning relay publishes its
 * advertise address here (`inst:socket:<id>`) so a peer relay that receives a
 * proxy/messages request for a tunnel it doesn't hold can forward the request
 * box-to-box (SG-gated 4301/4302, same posture as the docker-socket-proxy).
 * The `x-relay-forward: 1` marker is a LOOP GUARD only (a forwarded request is
 * never re-forwarded) — it grants nothing: the peer re-runs the full caller
 * auth (JWT + ADMIN + ownership) itself. nginx strips the header from external
 * callers as belt-and-braces.
 */
export const SOCKET_KEY_PREFIX = 'inst:socket:';
export const FORWARD_HEADER = 'x-relay-forward';

/** Hop-by-hop headers stripped from response heads passing through the tunnel. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

/** Request headers never forwarded down the tunnel (body travels in the frame). */
const STRIP_REQUEST_HEADERS = new Set([...HOP_BY_HOP, 'content-length']);

export interface InstanceRow {
  id: string;
  ownerUserId: string;
  name: string;
  status: string;
  protocolVersion: number;
}

/** Result of tunnel upgrade auth — see authenticateTunnelRequest. */
export interface TunnelAuthResult {
  instance: InstanceRow;
  /** Device activation only: the minted dgi_ token for the `paired` frame. */
  pairedToken?: string;
}

/** The ws.WebSocket subset the core uses — structural so tests inject fakes. */
export interface TunnelSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

interface ProxyStream {
  res: ServerResponse;
  headersSent: boolean;
  done: boolean;
}

export interface RelayDeps {
  db: any;
  redis: any;
  verifyToken: (token: string) => TokenPayload;
  resolveToken: (token: string) => Promise<InstanceRow | null>;
  /**
   * Device activation: consume a `dgp_` bearer token's cloud-side Redis claim
   * (atomic GETDEL) and mint the connected_instances row. Null for
   * unknown/expired/consumed codes — the caller answers the uniform 401.
   */
  claimPair: (token: string, name?: string) => Promise<{ instance: InstanceRow; token: string } | null>;
  /** Peer-forward transport (defaults to http.request) — test seam. */
  httpRequest: typeof http.request;
}

const defaultDeps = (): RelayDeps => ({
  db: prisma,
  redis: redisClient,
  verifyToken: verifyAccessToken,
  resolveToken: resolveInstanceByToken as RelayDeps['resolveToken'],
  claimPair: mintInstanceFromPairClaim as RelayDeps['claimPair'],
  httpRequest: http.request,
});

function sendFrame(socket: TunnelSocket, frame: Record<string, any>): void {
  try { socket.send(JSON.stringify({ v: 1, ...frame })); } catch { /* socket dying */ }
}

function stripHeaders(headers: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** One edge's live tunnel: the socket plus its in-flight proxied streams. */
export class InstanceConnection {
  readonly streams = new Map<string, ProxyStream>();
  private counter = 0;

  constructor(
    readonly instance: InstanceRow,
    private readonly socket: TunnelSocket,
    private readonly core: RelayCore,
  ) {}

  handleMessage(raw: any): void {
    let frame: any;
    try { frame = JSON.parse(raw.toString()); } catch {
      sendFrame(this.socket, { type: 'error', message: 'invalid frame: not JSON' });
      return;
    }
    if (!frame || frame.v !== 1 || typeof frame.type !== 'string') {
      sendFrame(this.socket, { type: 'error', message: 'invalid frame: expected { v: 1, type }' });
      return;
    }
    switch (frame.type) {
      case 'ping': return void this.onPing();
      case 'pong': return; // edges may answer relay pings; nothing to do
      case 'head': return this.onHead(frame);
      case 'data': return this.onData(frame);
      case 'end': return this.onEnd(frame);
      case 'error': return this.onErrorFrame(frame);
      default:
        sendFrame(this.socket, {
          type: 'error',
          streamId: typeof frame.streamId === 'string' ? frame.streamId : undefined,
          message: `unknown frame type "${frame.type}"`,
        });
    }
  }

  /** Client keepalive: refresh presence + socket ownership + re-check revoked. */
  private async onPing(): Promise<void> {
    sendFrame(this.socket, { type: 'pong' });
    try {
      await this.core.deps.redis.setEx(
        `${PRESENCE_KEY_PREFIX}${this.instance.id}`, PRESENCE_TTL_SECONDS, String(Date.now()));
      await this.core.deps.redis.setEx(
        `${SOCKET_KEY_PREFIX}${this.instance.id}`, PRESENCE_TTL_SECONDS, this.core.myAdvertiseAddr());
      const row = await this.core.deps.db.connectedInstance.findUnique({
        where: { id: this.instance.id }, select: { status: true },
      });
      if (!row || row.status === 'revoked') {
        logger.info(`relay: instance ${this.instance.id.slice(0, 8)} revoked — hard-closing tunnel`);
        this.socket.close(4403, 'revoked');
      }
    } catch (err: any) {
      logger.warn(`relay: presence/revoke check failed for ${this.instance.id.slice(0, 8)}: ${err?.message}`);
    }
  }

  private streamFor(frame: any): ProxyStream | null {
    const stream = typeof frame.streamId === 'string' ? this.streams.get(frame.streamId) : undefined;
    if (!stream) {
      sendFrame(this.socket, {
        type: 'error',
        streamId: typeof frame.streamId === 'string' ? frame.streamId : undefined,
        message: 'unknown streamId',
      });
      return null;
    }
    return stream;
  }

  private commitHead(stream: ProxyStream, status: number, headers: Record<string, any>): void {
    if (stream.headersSent || stream.done) return;
    stream.headersSent = true;
    try {
      stream.res.writeHead(Number.isInteger(status) ? status : 200, stripHeaders(headers));
    } catch { /* client already gone */ }
  }

  private onHead(frame: any): void {
    const stream = this.streamFor(frame);
    if (stream) this.commitHead(stream, frame.status, frame.headers || {});
  }

  private onData(frame: any): void {
    const stream = this.streamFor(frame);
    if (!stream || stream.done) return;
    // A peer that never sends `head` still streams: commit a provisional head
    // so chunks flow. Our edge client always sends `head` first, so this only
    // guards foreign/buggy peers.
    if (!stream.headersSent) this.commitHead(stream, 200, { 'content-type': 'application/octet-stream' });
    try { stream.res.write(Buffer.from(String(frame.chunk || ''), 'base64')); } catch { /* client gone */ }
  }

  private onEnd(frame: any): void {
    const stream = this.streamFor(frame);
    if (!stream) return;
    this.commitHead(stream, frame.status, frame.headers || {});
    this.finishStream(frame.streamId, stream);
  }

  private onErrorFrame(frame: any): void {
    const stream = typeof frame.streamId === 'string' ? this.streams.get(frame.streamId) : undefined;
    if (!stream) return; // error about an unknown stream: nothing to clean up
    if (!stream.headersSent) {
      this.commitHead(stream, 502, { 'content-type': 'application/json' });
      try { stream.res.write(JSON.stringify({ error: String(frame.message || 'edge error') })); } catch { /* gone */ }
    }
    this.finishStream(frame.streamId, stream);
  }

  private finishStream(streamId: string, stream: ProxyStream): void {
    stream.done = true;
    this.streams.delete(streamId);
    try { stream.res.end(); } catch { /* client gone */ }
  }

  /**
   * Open a proxied stream for an HTTP request/response pair. Returns null at
   * the per-instance cap (the proxy handler turns that into a 503). The
   * request body (if any) is already fully read and travels base64 in `open`.
   */
  openStream(res: ServerResponse, method: string, path: string, headers: Record<string, string>, body: Buffer): string | null {
    if (this.streams.size >= MAX_STREAMS_PER_INSTANCE) return null;
    const streamId = `${this.instance.id}:${++this.counter}`;
    const stream: ProxyStream = { res, headersSent: false, done: false };
    this.streams.set(streamId, stream);
    // Client disconnected mid-stream: tell the edge to abort the local request.
    res.on('close', () => {
      if (!stream.done && this.streams.delete(streamId)) {
        stream.done = true;
        sendFrame(this.socket, { type: 'error', streamId, message: 'client disconnected' });
      }
    });
    sendFrame(this.socket, {
      type: 'open', streamId, method, path, headers,
      ...(body.length ? { body: body.toString('base64') } : {}),
    });
    return streamId;
  }

  /** Socket closed: fail every in-flight stream and deregister. */
  handleClose(): void {
    for (const [streamId, stream] of this.streams) {
      if (!stream.headersSent) {
        this.commitHead(stream, 502, { 'content-type': 'application/json' });
        try { stream.res.write(JSON.stringify({ error: 'instance offline' })); } catch { /* gone */ }
      }
      stream.done = true;
      try { stream.res.end(); } catch { /* gone */ }
      this.streams.delete(streamId);
    }
  }
}

export class RelayCore {
  readonly deps: RelayDeps;
  /** instanceId → live tunnel. Process-pinned by design (see header). */
  readonly connections = new Map<string, InstanceConnection>();

  constructor(deps?: Partial<RelayDeps>) {
    this.deps = { ...defaultDeps(), ...(deps || {}) };
  }

  handleHealth(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
  }

  /**
   * The address peer relays use to forward requests to THIS relay.
   * RELAY_ADVERTISE_ADDR wins outright (e.g. "10.0.0.22:4301"); else
   * RELAY_BOX_IP + RELAY_PUBLIC_PORT (prod boxes set these via the box-local
   * env-override channel); single-box default 127.0.0.1:<RELAY_PORT> — where
   * peer forwarding can never trigger because every tunnel is local.
   */
  myAdvertiseAddr(): string {
    if (process.env.RELAY_ADVERTISE_ADDR) return process.env.RELAY_ADVERTISE_ADDR;
    const ip = process.env.RELAY_BOX_IP || '127.0.0.1';
    const port = process.env.RELAY_PUBLIC_PORT || process.env.RELAY_PORT || '4100';
    return `${ip}:${port}`;
  }

  /**
   * No local tunnel for this instance — maybe a peer relay (other box/color)
   * holds it. Returns true when the request was forwarded (or is being
   * answered by the forwarder). Never re-forwards a forwarded request (loop
   * guard); a stale self-addressed key is treated as offline.
   */
  private async forwardToPeerIfNeeded(
    instanceId: string, req: IncomingMessage, res: ServerResponse, body: Buffer,
    json: (status: number, body: Record<string, any>) => void,
  ): Promise<boolean> {
    if (req.headers[FORWARD_HEADER]) return false; // already forwarded — loop guard
    let owner: string | null = null;
    try { owner = await this.deps.redis.get(`${SOCKET_KEY_PREFIX}${instanceId}`); } catch { /* fall through to offline */ }
    if (!owner || owner === this.myAdvertiseAddr()) return false;

    logger.info(`relay: forwarding ${req.method} ${req.url} for ${instanceId.slice(0, 8)} to peer ${owner}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(key) || key === FORWARD_HEADER || v === undefined) continue;
      headers[key] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    headers[FORWARD_HEADER] = '1';
    if (body.length) headers['content-length'] = String(body.length);

    const peerReq = this.deps.httpRequest(
      `http://${owner}${req.url}`, { method: req.method, headers, timeout: 300_000 },
      (peerRes) => {
        try {
          res.writeHead(peerRes.statusCode || 502, stripHeaders(peerRes.headers));
          peerRes.pipe(res);
        } catch { /* client gone */ }
      },
    );
    peerReq.on('timeout', () => peerReq.destroy(new Error('peer timeout')));
    peerReq.on('error', (err: any) => {
      logger.warn(`relay: peer forward to ${owner} failed: ${err?.message}`);
      if (!res.headersSent) json(502, { error: 'instance offline' });
      else try { res.end(); } catch { /* gone */ }
    });
    peerReq.end(body.length ? body : undefined);
    return true;
  }

  /**
   * Tunnel upgrade auth. Two token families:
   *   - `dgi_…` — an established edge tunnel token → its instance row.
   *   - `dgp_<code>` — device-activation first contact: consume the cloud-side
   *     Redis claim (`inst:pairclaim:<sha256>`, parked by POST
   *     /instances/pair/redeem) atomically and MINT the instance row on the
   *     spot; `pairedToken` is the real dgi_ token the relay must send back in
   *     a `paired` frame BEFORE normal frame flow (handleTunnelUpgrade).
   * EVERY failure — unknown token, revoked, expired/consumed claim, malformed
   * — returns the same null (the caller's 401 enumerates nothing). `name` is
   * the edge's self-reported ?name= WS query param (used only on minting).
   */
  async authenticateTunnelRequest(
    authHeader: string | undefined,
    name?: string,
  ): Promise<TunnelAuthResult | null> {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return null;
    if (token.startsWith('dgp_')) {
      const minted = await this.deps.claimPair(token, name);
      if (!minted) return null;
      return { instance: minted.instance, pairedToken: minted.token };
    }
    const instance = await this.deps.resolveToken(token);
    if (!instance || instance.status === 'revoked') return null;
    return { instance };
  }

  /**
   * Complete an authenticated upgrade: for a device-activation first contact,
   * the `paired` frame goes down the socket BEFORE anything else (the edge is
   * waiting on it to store its token and switch to live-tunnel mode), then
   * the connection attaches as usual.
   */
  handleTunnelUpgrade(auth: TunnelAuthResult, socket: TunnelSocket): InstanceConnection {
    if (auth.pairedToken) {
      sendFrame(socket, { type: 'paired', instanceId: auth.instance.id, token: auth.pairedToken });
    }
    return this.attachConnection(auth.instance, socket);
  }

  /** Attach an authenticated WS: register, mark online, wire frame handling. */
  attachConnection(instance: InstanceRow, socket: TunnelSocket): InstanceConnection {
    // One tunnel per instance: a reconnect replaces the stale socket.
    const existing = this.connections.get(instance.id);
    if (existing) {
      try { (existing as any).socket.close(4000, 'replaced'); } catch { /* already dead */ }
      existing.handleClose();
    }
    const conn = new InstanceConnection(instance, socket, this);
    this.connections.set(instance.id, conn);

    const now = new Date();
    void Promise.all([
      this.deps.db.connectedInstance.update({
        where: { id: instance.id }, data: { status: 'online', lastSeenAt: now },
      }),
      this.deps.redis.setEx(`${PRESENCE_KEY_PREFIX}${instance.id}`, PRESENCE_TTL_SECONDS, String(now.getTime())),
      this.deps.redis.setEx(`${SOCKET_KEY_PREFIX}${instance.id}`, PRESENCE_TTL_SECONDS, this.myAdvertiseAddr()),
    ]).catch((err: any) => logger.warn(`relay: online-mark failed for ${instance.id.slice(0, 8)}: ${err?.message}`));

    socket.on('message', (raw: any) => {
      try { conn.handleMessage(raw); } catch (err: any) {
        // Frame handling must NEVER take the relay down.
        logger.error(`relay: frame handler threw for ${instance.id.slice(0, 8)}: ${err?.message}`);
      }
    });
    socket.on('close', () => void this.detachConnection(instance.id, conn));
    socket.on('error', () => { /* close follows */ });
    logger.info(`relay: tunnel up for instance ${instance.id.slice(0, 8)} (${instance.name})`);
    return conn;
  }

  private async detachConnection(instanceId: string, conn: InstanceConnection): Promise<void> {
    if (this.connections.get(instanceId) !== conn) return; // replaced by a newer socket
    this.connections.delete(instanceId);
    conn.handleClose();
    try {
      await this.deps.redis.del(`${PRESENCE_KEY_PREFIX}${instanceId}`);
      await this.deps.redis.del(`${SOCKET_KEY_PREFIX}${instanceId}`);
      const row = await this.deps.db.connectedInstance.findUnique({ where: { id: instanceId }, select: { status: true } });
      if (row && row.status !== 'revoked') {
        await this.deps.db.connectedInstance.update({ where: { id: instanceId }, data: { status: 'offline' } });
      }
    } catch (err: any) {
      logger.warn(`relay: offline-mark failed for ${instanceId.slice(0, 8)}: ${err?.message}`);
    }
    logger.info(`relay: tunnel down for instance ${instanceId.slice(0, 8)}`);
  }

  /** Read a proxy request body fully, capped at MAX_BODY_BYTES. */
  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private proxyAuthToken(req: IncomingMessage): string {
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Bearer ')) return authz.slice(7);
    const cookie = req.headers.cookie || '';
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'cm_access') return decodeURIComponent(rest.join('='));
    }
    return '';
  }

  /**
   * HTTP proxy: /api/crossmodel/instances/:instanceId/proxy/<path> → down the
   * tunnel. Caller must be an ADMIN JWT (Bearer or cm_access cookie) who OWNS
   * the instance row: bad/absent token → 401, non-admin → 403, unknown or
   * foreign instance → 404 (no cross-owner enumeration), offline → 502.
   */
  async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: Record<string, any>) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const u = new URL(req.url || '/', 'http://relay');
      const m = PROXY_PATH_RE.exec(u.pathname);
      if (!m) return json(404, { error: 'Not found' });
      const instanceId = m[1];
      const edgePath = (m[2] || '/') + u.search;

      const token = this.proxyAuthToken(req);
      if (!token) return json(401, { error: 'No token provided' });
      let payload: TokenPayload;
      try { payload = this.deps.verifyToken(token); } catch {
        return json(401, { error: 'Invalid or expired token' });
      }
      if (payload.role !== 'ADMIN') return json(403, { error: 'Forbidden: admin access required' });

      const instance = await this.deps.db.connectedInstance.findUnique({ where: { id: instanceId } });
      if (!instance || instance.ownerUserId !== payload.userId) {
        return json(404, { error: 'Instance not found' });
      }

      let body: Buffer;
      try { body = await this.readBody(req); } catch {
        return json(413, { error: 'Request body too large (max 1 MB)' });
      }

      const conn = this.connections.get(instanceId);
      if (!conn) {
        // Multi-box: a peer relay may hold the tunnel — forward box-to-box.
        if (await this.forwardToPeerIfNeeded(instanceId, req, res, body, json)) return;
        return json(502, { error: 'instance offline' });
      }

      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (STRIP_REQUEST_HEADERS.has(key) || v === undefined) continue;
        fwdHeaders[key] = Array.isArray(v) ? v.join(', ') : String(v);
      }

      const streamId = conn.openStream(res, req.method || 'GET', edgePath, fwdHeaders, body);
      if (!streamId) return json(503, { error: 'Too many concurrent streams for this instance' });
    } catch (err: any) {
      logger.error(`relay: proxy handler error: ${err?.message}`);
      json(500, { error: 'Proxy error' });
    }
  }

  /**
   * Cloud→edge messaging (Phase 5): POST
   * /api/crossmodel/instances/:instanceId/chats/:chatId/messages with
   * { message, sourceLabel?, depth? }. Same caller auth as the proxy (ADMIN
   * JWT/cookie + ownership; uniform 404 on foreign/unknown), then forwards
   * down the tunnel as an open frame to POST /crossmodel/cloud-link/receive
   * with the JSON body (chatId injected from the URL). The edge's response
   * streams straight back — its status + JSON body (the delivery payload on
   * 2xx, the edge's own error status/body otherwise); offline → 502.
   */
  async handleMessagesRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: Record<string, any>) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const u = new URL(req.url || '/', 'http://relay');
      const m = MESSAGES_PATH_RE.exec(u.pathname);
      if (!m) return json(404, { error: 'Not found' });
      const [, instanceId, chatId] = m;
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

      const token = this.proxyAuthToken(req);
      if (!token) return json(401, { error: 'No token provided' });
      let payload: TokenPayload;
      try { payload = this.deps.verifyToken(token); } catch {
        return json(401, { error: 'Invalid or expired token' });
      }
      if (payload.role !== 'ADMIN') return json(403, { error: 'Forbidden: admin access required' });

      const instance = await this.deps.db.connectedInstance.findUnique({ where: { id: instanceId } });
      if (!instance || instance.ownerUserId !== payload.userId) {
        return json(404, { error: 'Instance not found' });
      }

      let raw: Buffer;
      try { raw = await this.readBody(req); } catch {
        return json(413, { error: 'Request body too large (max 1 MB)' });
      }
      let input: any;
      try { input = JSON.parse(raw.toString('utf8') || '{}'); } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const message = typeof input?.message === 'string' ? input.message.trim() : '';
      if (!message) return json(400, { error: 'message is required' });
      if (input.sourceLabel !== undefined && typeof input.sourceLabel !== 'string') {
        return json(400, { error: 'sourceLabel must be a string' });
      }
      if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 10)) {
        return json(400, { error: 'depth must be an integer between 0 and 10' });
      }

      const conn = this.connections.get(instanceId);
      if (!conn) {
        // Multi-box: a peer relay may hold the tunnel — forward the ORIGINAL
        // request box-to-box (the peer re-runs auth + validation + rebuilds
        // the edge frame itself).
        if (await this.forwardToPeerIfNeeded(instanceId, req, res, raw, json)) return;
        return json(502, { error: 'instance offline' });
      }

      // The edge tunnel client strips any incoming authorization/cookie and
      // injects its own 60s local JWT + x-cloud-relay: 1 — forward only the
      // content type.
      const edgeBody = Buffer.from(JSON.stringify({
        chatId,
        message,
        ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
      }));
      const streamId = conn.openStream(res, 'POST', '/crossmodel/cloud-link/receive', {
        'content-type': 'application/json',
      }, edgeBody);
      if (!streamId) return json(503, { error: 'Too many concurrent streams for this instance' });
    } catch (err: any) {
      logger.error(`relay: messages handler error: ${err?.message}`);
      json(500, { error: 'Proxy error' });
    }
  }
}
