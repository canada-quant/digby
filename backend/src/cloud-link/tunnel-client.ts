/**
 * Digby Edge (Phase 3) — EDGE-side tunnel client.
 *
 * Started from the web backend boot (server.ts) when this instance has a
 * cloud_link row with state='linked' AND CLOUD_LINK_DISABLED is unset. Dials
 * OUT to the cloud's relay (<cloudUrl>/api/crossmodel/instances/tunnel,
 * http→ws / https→wss) with the decrypted `dgi_` token and holds the
 * connection — the cloud then proxies API/SSE requests down to this
 * instance's own REST API. No inbound connectivity to the edge is ever
 * needed (NAT/CGNAT-safe).
 *
 * Behavior contract:
 *  - Reconnect forever with exponential backoff (1s → 60s cap) + jitter.
 *  - A 401/403 (upgrade rejection or relay close code 4401/4403) means the
 *    token was rejected: set state='error' + lastError='token rejected —
 *    re-pair' and STOP retrying (an admin must re-pair).
 *  - PENDING-PAIR MODE (device activation): when this instance minted the
 *    code itself (POST /cloud-link/code/start), the client dials with
 *    `Authorization: Bearer dgp_<code>` + `?name=` every ~3s instead. A 401
 *    there just means the cloud admin hasn't redeemed the code yet — keep
 *    dialing until the code's TTL lapses (then state='error',
 *    lastError='pairing code expired — generate a new one'). When the relay
 *    consumes the claim it answers with a `paired` frame carrying the real
 *    dgi_ token: the client encrypts+stores it on the pending link row
 *    (state='linked') and CONTINUES on the same socket as the live tunnel.
 *  - Sends a protocol `ping` every 30s (the relay refreshes presence and
 *    re-checks revocation on each one).
 *  - On `open`: dispatch to http://127.0.0.1:<PORT||4000>/api<path>. The
 *    incoming authorization/cookie headers are STRIPPED (the cloud caller's
 *    JWT must never reach the edge's API); two headers are injected instead:
 *    a short-lived (60s) locally-signed JWT for the pairedByUserId admin and
 *    `x-cloud-relay: 1`. Response chunks stream back as `data` frames as they
 *    arrive (SSE must not buffer), preceded by a `head` frame (see the
 *    protocol note in relay/relay-core.ts) and closed by `end`; failures send
 *    `error`. A WS close mid-stream destroys the local request.
 */

import http from 'http';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { env } from '../config/env';
import logger from '../utils/logger';
import { decryptValue, encryptValue } from '../modules/crossmodel/coding/credentials.service';
import { TUNNEL_PATH } from '../relay/relay-core';

const PING_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** Pending-pair redial cadence: fast enough that a freshly redeemed code lands almost immediately. */
const PENDING_RETRY_MS = 3_000;
/** Headers from the cloud caller that must NEVER reach the edge's own API. */
const STRIP_INCOMING = new Set(['authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding']);

interface CloudLinkRow {
  id: string;
  cloudUrl: string;
  tokenEnc: string;
  instanceName: string;
  pairedByUserId: string;
  state: string;
}

export class CloudLinkTunnel {
  private ws: WebSocket | null = null;
  private link: CloudLinkRow | null = null;
  private signer: { userId: string; email: string; role: string } | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private activeRequests = new Map<string, http.ClientRequest>();
  /** Device-activation mode: set between code/start and the `paired` frame. */
  private pendingCode: string | null = null;
  private pendingExpiresAt = 0;
  connected = false;

  /** Load the linked row and connect. No-op when unpaired/disabled. */
  async start(): Promise<void> {
    if (process.env.CLOUD_LINK_DISABLED) return;
    const link = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!link || link.state !== 'linked') return;
    this.link = link;
    const user = await prisma.user.findUnique({
      where: { id: link.pairedByUserId }, select: { id: true, email: true, role: true },
    });
    if (!user) {
      await this.markError('pairing admin no longer exists — re-pair');
      return;
    }
    this.signer = { userId: user.id, email: user.email, role: user.role };
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Re-read the row (post re-pair) and (re)start. */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  /**
   * Pending-pair mode (device activation): the cloud_link row already exists
   * with state='pending' (no token yet); dial the cloud's tunnel endpoint
   * with `Bearer dgp_<code>` every ~3s until the relay answers with a
   * `paired` frame or the code's TTL lapses. No-op when disabled/unmatched.
   */
  async startPendingPairing(code: string, expiresAtMs: number): Promise<void> {
    if (process.env.CLOUD_LINK_DISABLED) return;
    const link = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!link || link.state !== 'pending') return;
    const user = await prisma.user.findUnique({
      where: { id: link.pairedByUserId }, select: { id: true, email: true, role: true },
    });
    if (!user) {
      await this.markError('pairing admin no longer exists — re-pair');
      return;
    }
    this.link = link;
    this.signer = { userId: user.id, email: user.email, role: user.role };
    this.pendingCode = code;
    this.pendingExpiresAt = expiresAtMs;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.pendingCode = null;
    this.pendingExpiresAt = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    for (const req of this.activeRequests.values()) req.destroy();
    this.activeRequests.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already dead */ }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private tunnelUrl(): string {
    const base = (this.link!.cloudUrl || '').replace(/\/+$/, '');
    const url = `${base.replace(/^http/, 'ws')}${TUNNEL_PATH}`;
    // Device activation carries the instance name as a query param — the
    // relay uses it when minting the connected_instances row.
    return this.pendingCode ? `${url}?name=${encodeURIComponent(this.link!.instanceName)}` : url;
  }

  private connect(): void {
    if (this.stopped || !this.link) return;
    let token: string;
    if (this.pendingCode) {
      token = `dgp_${this.pendingCode}`;
    } else {
      try {
        token = decryptValue(this.link.tokenEnc);
      } catch {
        void this.markError('stored token no longer decrypts (JWT_SECRET drift?) — re-pair');
        return;
      }
    }
    logger.info(`cloud-link: dialing ${this.tunnelUrl()} as "${this.link.instanceName}"${this.pendingCode ? ' (pending pair)' : ''}`);
    const ws = new WebSocket(this.tunnelUrl(), {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: 4 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.pendingCode) {
        // The relay only upgrades a dgp_ dial after consuming the claim — the
        // `paired` frame arrives next. Not a live tunnel yet.
        logger.info('cloud-link: dial accepted — waiting for the paired frame');
        return;
      }
      this.connected = true;
      this.attempt = 0;
      logger.info('cloud-link: tunnel connected');
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
    });

    ws.on('message', (raw) => {
      try { this.handleFrame(JSON.parse(raw.toString())); } catch (err: any) {
        logger.warn(`cloud-link: bad frame from relay: ${err?.message}`);
      }
    });

    // Upgrade REJECTED with an HTTP status (relay answers 401 before the WS
    // handshake completes) — ws surfaces it as 'unexpected-response'.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode || 0;
      res.resume();
      if (this.pendingCode) {
        // Expected until the cloud admin redeems the code — keep dialing.
        this.schedulePendingRetry();
        return;
      }
      if (status === 401 || status === 403) {
        void this.markError('token rejected — re-pair');
      }
    });

    ws.on('error', (err) => {
      logger.warn(`cloud-link: socket error: ${err?.message}`);
    });

    ws.on('close', (code) => {
      this.connected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      // Relay-side abort: a close mid-stream kills every in-flight local request.
      for (const req of this.activeRequests.values()) req.destroy();
      this.activeRequests.clear();
      if (this.stopped) return;
      if (this.pendingCode) {
        this.schedulePendingRetry();
        return;
      }
      if (code === 4401 || code === 4403) {
        void this.markError('token rejected — re-pair');
        return;
      }
      this.scheduleReconnect();
    });
  }

  /**
   * Pending-pair redial: every ~3s until the code's TTL lapses, then
   * state='error' with a clear re-generate message (no more retries until an
   * admin starts a new code).
   */
  private schedulePendingRetry(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (Date.now() >= this.pendingExpiresAt) {
      void this.markError('pairing code expired — generate a new one');
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (Date.now() >= this.pendingExpiresAt) {
        void this.markError('pairing code expired — generate a new one');
        return;
      }
      this.connect();
    }, PENDING_RETRY_MS + Math.floor(Math.random() * 500));
  }

  /**
   * `paired` frame from the relay: encrypt+store the minted dgi_ token on the
   * pending link row (state='linked'), then CONTINUE on this same socket as
   * the live tunnel — no disconnect, no redial.
   */
  private async finalizePairing(frame: any): Promise<void> {
    if (!this.pendingCode || !this.link) return;
    const token = typeof frame.token === 'string' ? frame.token : '';
    if (!token.startsWith('dgi_')) {
      await this.markError('cloud sent a malformed paired frame — re-pair');
      return;
    }
    try {
      const tokenEnc = encryptValue(token);
      await prisma.cloudLink.update({
        where: { id: this.link.id },
        data: { tokenEnc, state: 'linked', lastError: null },
      });
      this.link = { ...this.link, tokenEnc, state: 'linked' };
    } catch (err: any) {
      await this.markError(`failed to store the paired token (${err?.message || 'db error'}) — re-pair`);
      return;
    }
    this.pendingCode = null;
    this.pendingExpiresAt = 0;
    this.connected = true;
    this.attempt = 0;
    logger.info(`cloud-link: paired via device code (instance ${String(frame.instanceId || '').slice(0, 8)}) — tunnel live`);
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = exp + Math.floor(Math.random() * exp * 0.25); // +0–25% jitter
    this.attempt += 1;
    logger.info(`cloud-link: reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async markError(lastError: string): Promise<void> {
    logger.warn(`cloud-link: ${lastError}`);
    this.stop(); // no more retries until an admin re-pairs
    try {
      if (this.link) {
        await prisma.cloudLink.update({
          where: { id: this.link.id },
          data: { state: 'error', lastError },
        });
      }
    } catch (err: any) {
      logger.warn(`cloud-link: failed to persist error state: ${err?.message}`);
    }
  }

  private send(frame: Record<string, any>): void {
    try { this.ws?.send(JSON.stringify({ v: 1, ...frame })); } catch { /* socket dying */ }
  }

  private handleFrame(frame: any): void {
    if (!frame || frame.v !== 1 || typeof frame.type !== 'string') return;
    switch (frame.type) {
      case 'open': return this.dispatchOpen(frame);
      case 'paired': return void this.finalizePairing(frame);
      case 'ping': return this.send({ type: 'pong' });
      case 'pong': return;
      case 'error': {
        // Relay aborted a stream (e.g. the cloud caller disconnected).
        const req = typeof frame.streamId === 'string' ? this.activeRequests.get(frame.streamId) : undefined;
        if (req) {
          this.activeRequests.delete(frame.streamId);
          req.destroy();
        }
        return;
      }
      default:
        logger.warn(`cloud-link: unknown frame type "${frame.type}" from relay`);
    }
  }

  /** 60s locally-signed JWT for the pairing admin — the edge's API sees a normal request. */
  private signLocalJwt(): string {
    const s = this.signer!;
    return jwt.sign({ userId: s.userId, email: s.email, role: s.role }, env.JWT_SECRET, { expiresIn: 60 });
  }

  /** open frame → local REST dispatch → head/data/end frames back. */
  private dispatchOpen(frame: any): void {
    const streamId = String(frame.streamId || '');
    if (!streamId || !this.link) return;
    const path = `/api${typeof frame.path === 'string' && frame.path.startsWith('/') ? frame.path : '/'}`;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers || {})) {
      if (!STRIP_INCOMING.has(k.toLowerCase())) headers[k] = String(v);
    }
    headers.authorization = `Bearer ${this.signLocalJwt()}`;
    headers['x-cloud-relay'] = '1';

    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT || '4000', 10),
      method: frame.method || 'GET',
      path,
      headers,
    }, (res) => {
      const status = res.statusCode || 502;
      const resHeaders = res.headers as Record<string, any>;
      // head FIRST so the relay can commit status/content-type before any
      // chunk (SSE streams, never buffers); end repeats them per protocol.
      this.send({ type: 'head', streamId, status, headers: resHeaders });
      res.on('data', (chunk: Buffer) => {
        this.send({ type: 'data', streamId, chunk: chunk.toString('base64') });
      });
      res.on('end', () => {
        this.activeRequests.delete(streamId);
        this.send({ type: 'end', streamId, status, headers: resHeaders });
      });
      res.on('error', (err) => {
        this.activeRequests.delete(streamId);
        this.send({ type: 'error', streamId, message: err?.message || 'local response error' });
      });
    });

    req.on('error', (err) => {
      if (this.activeRequests.delete(streamId)) {
        this.send({ type: 'error', streamId, message: err?.message || 'local request failed' });
      }
    });

    this.activeRequests.set(streamId, req);
    if (typeof frame.body === 'string' && frame.body) req.write(Buffer.from(frame.body, 'base64'));
    req.end();
  }
}

/** Process-wide singleton — the web process holds at most one tunnel. */
export const cloudLinkTunnel = new CloudLinkTunnel();

/** server.ts boot hook: start the tunnel when this instance is a linked edge. */
export async function startCloudLinkTunnelIfLinked(): Promise<void> {
  await cloudLinkTunnel.start();
}
