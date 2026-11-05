/**
 * Generic MCP client for USER-ADDED MCP servers (ticket e294f9a4, 2026-10-06).
 *
 * The first-party connectors (slack-mcp, asana-mcp, the BrightData gateway)
 * each hand-roll ONE tools/call against ONE known container. A user-added
 * server is arbitrary, so this client speaks the protocol properly:
 *
 *   initialize → notifications/initialized → tools/list (paginated) → tools/call
 *
 * over either transport the spec defines for remote servers:
 *   - Streamable HTTP (2025-03-26+): POST every JSON-RPC message to ONE URL;
 *     the answer is `application/json` or a `text/event-stream` carrying the
 *     response; the server may assign an `Mcp-Session-Id` on initialize (sent
 *     back on every later request; a 404 on a session'd request = expired ⇒
 *     re-initialize once); `MCP-Protocol-Version` rides every request after
 *     initialize.
 *   - HTTP+SSE (2024-11-05, "legacy SSE"): GET the SSE URL, read the
 *     `endpoint` event, POST messages there, read responses off the stream.
 *   - 'auto' (the default): Streamable HTTP first; a 404 / 405 / 406 / 415 or
 *     a non-MCP content type falls back to SSE (the spec's own
 *     backwards-compatibility recipe). A URL ending in /sse tries SSE first.
 *
 * Every request goes through url-guard (https only, public hosts only, the
 * DNS answer checked at CONNECT time), never follows a redirect, is bounded by
 * a per-operation deadline and a body cap, and NEVER echoes header values in
 * an error. Errors are McpClientError with a `kind` the health state machine
 * and the UI read (auth / not_found / timeout / network / protocol / http /
 * blocked_url / too_large / rpc).
 *
 * Server→client REQUESTS that arrive on a stream (ping, sampling, elicitation,
 * roots) are answered — ping with {}, everything else with -32601 — so a
 * server never hangs waiting on us. No env reads except through url-guard.
 */

import http from 'http';
import https from 'https';
import { assertUserMcpUrl, guardedLookup, McpUrlError } from './url-guard';

export type McpTransport = 'streamable_http' | 'sse';
export type McpTransportPref = McpTransport | 'auto';
export type McpErrorClass = 'auth' | 'not_found' | 'timeout' | 'network' | 'protocol' | 'http' | 'blocked_url' | 'too_large' | 'rpc';

/** The protocol version Digby asks for; the server answers with the one it speaks (accepted leniently). */
export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = { name: 'digby', title: 'Digby', version: '1.0.0' };
/** JSON / single-SSE-event body cap. */
export const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** tools/list pagination bounds. */
export const MCP_MAX_LIST_PAGES = 10;
export const MCP_MAX_LISTED_TOOLS = 500;

export class McpClientError extends Error {
  constructor(
    public readonly kind: McpErrorClass,
    message: string,
    public readonly status?: number,
    /** RPC error code (kind 'rpc'), or true when a 401 named an OAuth resource (kind 'auth'). */
    public readonly extra?: { rpcCode?: number; oauth?: boolean; sessionExpired?: boolean },
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpServerTarget {
  url: string;
  transport: McpTransportPref;
  /** Extra request headers (the user's auth header). Values are never echoed in errors. */
  headers?: Record<string, string>;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  content?: Array<Record<string, any>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpSessionInfo {
  transport: McpTransport;
  protocolVersion: string;
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  hasTools: boolean;
}

export interface McpConnection {
  info: McpSessionInfo;
  listTools(opts?: { timeoutMs?: number }): Promise<{ tools: McpToolDef[]; truncated: boolean }>;
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<McpCallResult>;
  close(): Promise<void>;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  res: http.IncomingMessage;
}

const FORBIDDEN_EXTRA_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization',
]);

function safeExtraHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const name = String(k || '').trim();
    if (!name || FORBIDDEN_EXTRA_HEADERS.has(name.toLowerCase())) continue;
    if (/[\r\n]/.test(String(v))) continue;
    out[name] = String(v);
  }
  return out;
}

function netErrorToMcp(err: any): McpClientError {
  if (err instanceof McpClientError) return err;
  if (err instanceof McpUrlError) return new McpClientError('blocked_url', err.message);
  const code = String(err?.code || '');
  if (code === 'EMCPBLOCKED') return new McpClientError('blocked_url', String(err.message || 'refused: private address'));
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new McpClientError('network', 'could not resolve the server host name (DNS lookup failed)');
  if (code === 'ECONNREFUSED') return new McpClientError('network', 'connection refused — nothing is listening at that address');
  if (code === 'ECONNRESET' || code === 'EPIPE') return new McpClientError('network', 'the server closed the connection');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new McpClientError('timeout', 'the server did not answer in time');
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(String(err?.message || ''))) return new McpClientError('network', `TLS error (${code || 'certificate'}) — the server's HTTPS certificate is not valid`);
  return new McpClientError('network', String(err?.message || err || 'network error').slice(0, 200));
}

/** One HTTP request; resolves on response headers. The caller owns `res` (must consume or destroy it). */
function sendRequest(url: URL, init: { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: string; deadline: number }): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const remaining = init.deadline - Date.now();
    if (remaining <= 0) { reject(new McpClientError('timeout', 'the server did not answer in time')); return; }
    const mod = url.protocol === 'https:' ? https : http;
    let settled = false;
    const headers: Record<string, string> = { 'user-agent': 'Digby-MCP/1.0 (+https://digby.ai)', ...init.headers };
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    let req: http.ClientRequest;
    try {
      req = mod.request(url, { method: init.method, headers, lookup: guardedLookup as any, agent: false });
    } catch (err) {
      reject(netErrorToMcp(err));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new McpClientError('timeout', 'the server did not answer in time'));
    }, remaining);
    (timer as any).unref?.();
    req.on('response', (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(netErrorToMcp(err));
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Read a whole body (bounded by bytes and the deadline). */
function readBody(res: http.IncomingMessage, deadline: number, maxBytes = MCP_MAX_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (err: Error | null, text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { res.destroy(); reject(err); } else resolve(text ?? '');
    };
    const timer = setTimeout(() => finish(new McpClientError('timeout', 'the server did not finish its answer in time')), Math.max(1, deadline - Date.now()));
    (timer as any).unref?.();
    res.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { finish(new McpClientError('too_large', `the server's answer exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`)); return; }
      chunks.push(c);
    });
    res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    res.on('error', (e) => finish(netErrorToMcp(e)));
    res.on('aborted', () => finish(new McpClientError('network', 'the server aborted its answer')));
  });
}

export interface SseEvent { event: string; data: string; id?: string }

/**
 * Incremental SSE parser (spec: lines; `event:` / `data:` / `id:`; a blank line
 * dispatches; multi-line data joins with \n; `:` comments ignored). Pure.
 */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private size = 0;
  constructor(private readonly maxEventBytes = MCP_MAX_BODY_BYTES) {}

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\n|\r/);
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sepLen);
      if (line === '') {
        if (this.data.length || this.event) out.push({ event: this.event || 'message', data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) });
        this.event = ''; this.data = []; this.size = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') {
        this.size += value.length;
        if (this.size > this.maxEventBytes) throw new McpClientError('too_large', 'an event from the server exceeded the size cap');
        this.data.push(value);
      } else if (field === 'id') this.id = value;
    }
    if (this.buf.length > this.maxEventBytes) throw new McpClientError('too_large', 'an event from the server exceeded the size cap');
    return out;
  }
}

function contentTypeOf(headers: http.IncomingHttpHeaders): string {
  return String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function headerOf(headers: http.IncomingHttpHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

async function errorForStatus(r: RawResponse, deadline: number, opts: { sessionSent: boolean }): Promise<McpClientError> {
  let excerpt = '';
  try { excerpt = (await readBody(r.res, Math.min(deadline, Date.now() + 3_000), 64 * 1024)).replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* body is best-effort */ }
  const s = r.status;
  if (s === 401 || s === 403) {
    const www = headerOf(r.headers, 'www-authenticate') || '';
    const oauth = /resource_metadata|bearer/i.test(www) && s === 401;
    const msg = s === 401
      ? (oauth
        ? 'HTTP 401 — the server wants a sign-in token. Paste a personal access token / API key in the auth field if this server accepts one (OAuth sign-in is not supported yet).'
        : 'HTTP 401 — the server rejected the credentials (missing or wrong token).')
      : 'HTTP 403 — the token was accepted but lacks permission for this server.';
    return new McpClientError('auth', excerpt ? `${msg} Server said: ${excerpt}` : msg, s, { oauth });
  }
  if (s === 404) {
    return opts.sessionSent
      ? new McpClientError('not_found', 'the server forgot this session (HTTP 404)', s, { sessionExpired: true })
      : new McpClientError('not_found', 'HTTP 404 — no MCP endpoint at this URL (check the path, e.g. /mcp or /sse).', s);
  }
  if (s >= 300 && s < 400) {
    const loc = headerOf(r.headers, 'location');
    let where = '';
    try { if (loc) { const u = new URL(loc, 'https://x.invalid'); where = u.host === 'x.invalid' ? ` to ${u.pathname}` : ` to ${u.origin}${u.pathname}`; } } catch { /* ignore */ }
    return new McpClientError('http', `HTTP ${s} — the server redirected${where}; use the final URL directly (redirects are not followed).`, s);
  }
  if (s === 429) return new McpClientError('http', `HTTP 429 — the server is rate-limiting requests.${excerpt ? ` ${excerpt}` : ''}`, s);
  return new McpClientError('http', `HTTP ${s}${excerpt ? ` — ${excerpt}` : ''}`, s);
}

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: unknown } }

function rpcResultOrThrow(msg: JsonRpcMessage): any {
  if (msg.error) {
    const code = typeof msg.error.code === 'number' ? msg.error.code : undefined;
    throw new McpClientError('rpc', `the server answered an error${code !== undefined ? ` ${code}` : ''}: ${String(msg.error.message || 'unknown error').slice(0, 300)}`, undefined, { rpcCode: code });
  }
  return msg.result;
}

function asMessages(parsed: unknown): JsonRpcMessage[] {
  if (Array.isArray(parsed)) return parsed.filter((m) => m && typeof m === 'object') as JsonRpcMessage[];
  return parsed && typeof parsed === 'object' ? [parsed as JsonRpcMessage] : [];
}

/** The answer we owe a server→client request (ping → {}, everything else → method not found). */
function replyForServerRequest(m: JsonRpcMessage): JsonRpcMessage {
  if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} };
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Digby does not support ${String(m.method)}` } };
}

function isServerRequest(m: JsonRpcMessage): boolean {
  return typeof m.method === 'string' && m.id !== undefined && m.id !== null;
}

// ── Streamable HTTP ─────────────────────────────────────────────────────────

class StreamableHttpSession {
  sessionId: string | null = null;
  protocolVersion: string | null = null;
  private nextId = 1;
  constructor(private readonly url: URL, private readonly extra: Record<string, string>) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.extra,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  /** Fire-and-forget POST (notifications, our replies to server requests). */
  async notify(msg: JsonRpcMessage, deadline: number): Promise<void> {
    try {
      const r = await sendRequest(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg), deadline });
      r.res.resume();
      r.res.on('error', () => { /* ignore */ });
    } catch { /* a notification failure is not the operation's failure */ }
  }

  async request(method: string, params: unknown, deadline: number): Promise<any> {
    const id = this.nextId++;
    const sessionSent = !!this.sessionId;
    const r = await sendRequest(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), deadline });
    if (r.status < 200 || r.status >= 300) throw await errorForStatus(r, deadline, { sessionSent });
    const sid = headerOf(r.headers, 'mcp-session-id');
    if (sid && method === 'initialize') this.sessionId = sid;
    const ct = contentTypeOf(r.headers);
    if (r.status === 202 || r.status === 204) {
      r.res.resume();
      throw new McpClientError('protocol', `the server accepted "${method}" (HTTP ${r.status}) but sent no answer`);
    }
    if (ct === 'application/json') {
      const text = await readBody(r.res, deadline);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new McpClientError('protocol', `the server answered "${method}" with invalid JSON`); }
      const hit = asMessages(parsed).find((m) => m.id === id);
      if (!hit) throw new McpClientError('protocol', `the server's JSON answer to "${method}" carried no matching response`);
      return rpcResultOrThrow(hit);
    }
    if (ct === 'text/event-stream') return this.readStreamFor(r.res, id, method, deadline);
    r.res.resume();
    throw new McpClientError('protocol', `the server answered "${method}" with content type "${ct || 'none'}" — not an MCP endpoint`, r.status);
  }

  private readStreamFor(res: http.IncomingMessage, id: number, method: string, deadline: number): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const parser = new SseParser();
      let done = false;
      const finish = (err: Error | null, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new McpClientError('timeout', `the server did not answer "${method}" in time`)), Math.max(1, deadline - Date.now()));
      (timer as any).unref?.();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (done) return;
        let events: SseEvent[];
        try { events = parser.push(chunk); } catch (e) { finish(e as Error); return; }
        for (const ev of events) {
          if (ev.event !== 'message' || !ev.data.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(ev.data); } catch { continue; }
          for (const m of asMessages(parsed)) {
            if (isServerRequest(m)) { void this.notify(replyForServerRequest(m), Date.now() + 5_000); continue; }
            if (m.id === id && (m.result !== undefined || m.error)) {
              try { finish(null, rpcResultOrThrow(m)); } catch (e) { finish(e as Error); }
              return;
            }
          }
        }
      });
      res.on('end', () => finish(new McpClientError('protocol', `the server closed the stream without answering "${method}"`)));
      res.on('error', (e) => finish(netErrorToMcp(e)));
    });
  }

  async terminate(deadline: number): Promise<void> {
    if (!this.sessionId) return;
    try {
      const r = await sendRequest(this.url, { method: 'DELETE', headers: this.headers(), deadline });
      r.res.resume();
      r.res.on('error', () => { /* ignore */ });
    } catch { /* best-effort */ }
  }
}

// ── Legacy HTTP+SSE ──────────────────────────────────────────────────────────

class LegacySseSession {
  private nextId = 1;
  private endpoint: URL | null = null;
  private res: http.IncomingMessage | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  private closeError: Error | null = null;
  constructor(private readonly url: URL, private readonly extra: Record<string, string>) {}

  async open(deadline: number): Promise<void> {
    const r = await sendRequest(this.url, { method: 'GET', headers: { accept: 'text/event-stream', ...this.extra }, deadline });
    if (r.status < 200 || r.status >= 300) throw await errorForStatus(r, deadline, { sessionSent: false });
    const ct = contentTypeOf(r.headers);
    if (ct !== 'text/event-stream') {
      r.res.resume();
      throw new McpClientError('protocol', `GET answered content type "${ct || 'none'}" — not an MCP SSE endpoint`, r.status);
    }
    this.res = r.res;
    const parser = new SseParser();
    await new Promise<void>((resolve, reject) => {
      let gotEndpoint = false;
      const timer = setTimeout(() => {
        if (!gotEndpoint) { this.fail(new McpClientError('timeout', 'the SSE server never announced its message endpoint')); reject(this.closeError); }
      }, Math.max(1, deadline - Date.now()));
      (timer as any).unref?.();
      r.res.setEncoding('utf8');
      r.res.on('data', (chunk: string) => {
        let events: SseEvent[];
        try { events = parser.push(chunk); } catch (e) { this.fail(e as Error); if (!gotEndpoint) { clearTimeout(timer); reject(e); } return; }
        for (const ev of events) {
          if (ev.event === 'endpoint') {
            if (gotEndpoint) continue;
            let ep: URL;
            try { ep = new URL(ev.data.trim(), this.url); } catch { this.fail(new McpClientError('protocol', 'the SSE server announced an invalid endpoint')); clearTimeout(timer); reject(this.closeError); return; }
            if (ep.origin !== this.url.origin) { this.fail(new McpClientError('protocol', 'the SSE server announced an endpoint on a different host — refused')); clearTimeout(timer); reject(this.closeError); return; }
            this.endpoint = ep;
            gotEndpoint = true;
            clearTimeout(timer);
            resolve();
            continue;
          }
          if (ev.event !== 'message' || !ev.data.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(ev.data); } catch { continue; }
          for (const m of asMessages(parsed)) this.dispatch(m);
        }
      });
      r.res.on('end', () => { this.fail(new McpClientError('protocol', 'the SSE server closed the stream')); if (!gotEndpoint) { clearTimeout(timer); reject(this.closeError); } });
      r.res.on('error', (e) => { this.fail(netErrorToMcp(e)); if (!gotEndpoint) { clearTimeout(timer); reject(this.closeError); } });
    });
  }

  private dispatch(m: JsonRpcMessage): void {
    if (isServerRequest(m)) { void this.post(replyForServerRequest(m), Date.now() + 5_000).catch(() => { /* ignore */ }); return; }
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    try { p.resolve(rpcResultOrThrow(m)); } catch (e) { p.reject(e as Error); }
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.res?.destroy();
  }

  private async post(msg: JsonRpcMessage, deadline: number): Promise<RawResponse> {
    if (!this.endpoint) throw new McpClientError('protocol', 'SSE session is not open');
    const r = await sendRequest(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.extra }, body: JSON.stringify(msg), deadline });
    return r;
  }

  async notify(msg: JsonRpcMessage, deadline: number): Promise<void> {
    try { const r = await this.post(msg, deadline); r.res.resume(); r.res.on('error', () => { /* ignore */ }); } catch { /* ignore */ }
  }

  async request(method: string, params: unknown, deadline: number): Promise<any> {
    if (this.closed) throw this.closeError ?? new McpClientError('protocol', 'SSE session closed');
    const id = this.nextId++;
    const answer = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    answer.catch(() => { /* surfaced below */ });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpClientError('timeout', `the server did not answer "${method}" in time`)), Math.max(1, deadline - Date.now()));
      (timer as any).unref?.();
    });
    try {
      const r = await this.post({ jsonrpc: '2.0', id, method, params }, deadline);
      if (r.status < 200 || r.status >= 300) {
        this.pending.delete(id);
        throw await errorForStatus(r, deadline, { sessionSent: false });
      }
      // Some servers answer inline instead of on the stream.
      if (contentTypeOf(r.headers) === 'application/json') {
        const text = await readBody(r.res, deadline).catch(() => '');
        try {
          const hit = asMessages(JSON.parse(text)).find((m) => m.id === id && (m.result !== undefined || m.error));
          if (hit) { this.pending.delete(id); return rpcResultOrThrow(hit); }
        } catch (e) { if (e instanceof McpClientError) throw e; }
      } else {
        r.res.resume();
        r.res.on('error', () => { /* ignore */ });
      }
      return await Promise.race([answer, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  async terminate(): Promise<void> {
    this.fail(new McpClientError('protocol', 'session closed'));
  }
}

// ── Connection ───────────────────────────────────────────────────────────────

type AnySession = StreamableHttpSession | LegacySseSession;

async function handshake(session: AnySession, transport: McpTransport, deadline: number): Promise<McpSessionInfo> {
  const result = await session.request('initialize', {
    protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: MCP_CLIENT_INFO,
  }, deadline);
  if (!result || typeof result !== 'object' || typeof (result as any).protocolVersion !== 'string') {
    throw new McpClientError('protocol', 'the server\'s initialize answer is not an MCP InitializeResult');
  }
  const r = result as { protocolVersion: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string }; instructions?: string };
  if (session instanceof StreamableHttpSession) session.protocolVersion = r.protocolVersion;
  await session.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, Math.min(deadline, Date.now() + 5_000));
  return {
    transport,
    protocolVersion: r.protocolVersion,
    serverName: typeof r.serverInfo?.name === 'string' ? r.serverInfo.name.slice(0, 120) : null,
    serverVersion: typeof r.serverInfo?.version === 'string' ? r.serverInfo.version.slice(0, 60) : null,
    instructions: typeof r.instructions === 'string' ? r.instructions.slice(0, 2000) : null,
    hasTools: !!(r.capabilities && typeof r.capabilities === 'object' && 'tools' in r.capabilities),
  };
}

/** A 4xx / content-type answer on the Streamable HTTP POST that means "try legacy SSE" (spec back-compat recipe). */
function shouldFallBackToSse(err: unknown): boolean {
  if (!(err instanceof McpClientError)) return false;
  if (err.kind === 'not_found') return true;
  if (err.kind === 'http' && (err.status === 405 || err.status === 406 || err.status === 415 || err.status === 400)) return true;
  if (err.kind === 'protocol' && /content type|no answer/i.test(err.message)) return true;
  return false;
}

/**
 * Open a connection: validate the URL, pick / detect the transport, run the
 * initialize handshake. `timeoutMs` bounds the whole handshake.
 */
export async function connectMcp(target: McpServerTarget, opts: { timeoutMs: number }): Promise<McpConnection> {
  let url: URL;
  try { url = assertUserMcpUrl(target.url); } catch (err) { throw netErrorToMcp(err); }
  const extra = safeExtraHeaders(target.headers);
  const deadline = Date.now() + Math.max(500, opts.timeoutMs);
  const order: McpTransport[] = target.transport === 'sse'
    ? ['sse']
    : target.transport === 'streamable_http'
      ? ['streamable_http']
      : /\/sse\/?$/i.test(url.pathname) ? ['sse', 'streamable_http'] : ['streamable_http', 'sse'];
  let lastErr: unknown = null;
  let firstErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const transport = order[i];
    const session: AnySession = transport === 'sse' ? new LegacySseSession(url, extra) : new StreamableHttpSession(url, extra);
    try {
      if (session instanceof LegacySseSession) await session.open(deadline);
      const info = await handshake(session, transport, deadline);
      return makeConnection(session, info, url, extra);
    } catch (err) {
      if (i === 0) firstErr = err;
      lastErr = err;
      if (session instanceof LegacySseSession) await session.terminate();
      const more = i < order.length - 1;
      if (!more) break;
      // Only a "wrong transport" answer falls through; auth / timeout / network do not.
      if (transport === 'streamable_http' && !shouldFallBackToSse(err)) break;
      if (transport === 'sse' && !(err instanceof McpClientError && (err.kind === 'not_found' || err.kind === 'protocol' || (err.kind === 'http' && err.status !== 429)))) break;
    }
  }
  // Both transports failed: report the more INFORMATIVE one. A fallback that
  // only says "wrong transport here" (404 / 405 / not an SSE stream) hides the
  // first attempt's real answer (e.g. a 400 with the server's reason).
  if (firstErr && lastErr !== firstErr && isWrongTransportAnswer(lastErr) && !isWrongTransportAnswer(firstErr)) throw netErrorToMcp(firstErr);
  throw netErrorToMcp(lastErr);
}

function isWrongTransportAnswer(err: unknown): boolean {
  if (!(err instanceof McpClientError)) return false;
  return err.kind === 'not_found'
    || (err.kind === 'http' && (err.status === 405 || err.status === 406 || err.status === 415))
    || (err.kind === 'protocol' && /content type/i.test(err.message));
}

function makeConnection(initial: AnySession, info: McpSessionInfo, url: URL, extra: Record<string, string>): McpConnection {
  let session = initial;
  const DEFAULT_OP_MS = 30_000;
  /** Streamable HTTP: an expired session (404 on a session'd request) re-initializes ONCE and retries. */
  const withSession = async <T>(op: (s: AnySession, deadline: number) => Promise<T>, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    try {
      return await op(session, deadline);
    } catch (err) {
      if (session instanceof StreamableHttpSession && err instanceof McpClientError && err.extra?.sessionExpired) {
        const fresh = new StreamableHttpSession(url, extra);
        await handshake(fresh, 'streamable_http', deadline);
        session = fresh;
        return op(session, deadline);
      }
      throw err;
    }
  };
  return {
    info,
    async listTools(opts) {
      return withSession(async (s, deadline) => {
        const tools: McpToolDef[] = [];
        let cursor: string | undefined;
        let truncated = false;
        for (let page = 0; page < MCP_MAX_LIST_PAGES; page++) {
          let result: any;
          try {
            result = await s.request('tools/list', cursor ? { cursor } : {}, deadline);
          } catch (err) {
            // A server without the tools capability answers "method not found" — that is zero tools, not a failure.
            if (page === 0 && err instanceof McpClientError && err.kind === 'rpc' && err.extra?.rpcCode === -32601) return { tools: [], truncated: false };
            throw err;
          }
          const list = Array.isArray(result?.tools) ? result.tools : null;
          if (!list) throw new McpClientError('protocol', 'tools/list answered without a tools array');
          for (const t of list) {
            if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name.trim()) continue;
            if (tools.length >= MCP_MAX_LISTED_TOOLS) { truncated = true; break; }
            tools.push({
              name: t.name,
              ...(typeof t.title === 'string' ? { title: t.title } : {}),
              ...(typeof t.description === 'string' ? { description: t.description } : {}),
              ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema } : {}),
              ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
            });
          }
          cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor || truncated) break;
          if (page === MCP_MAX_LIST_PAGES - 1) truncated = true;
        }
        return { tools, truncated };
      }, opts?.timeoutMs ?? DEFAULT_OP_MS);
    },
    async callTool(name, args, opts) {
      return withSession(async (s, deadline) => {
        const result = await s.request('tools/call', { name, arguments: args ?? {} }, deadline);
        if (!result || typeof result !== 'object') throw new McpClientError('protocol', 'tools/call answered without a result object');
        return result as McpCallResult;
      }, opts?.timeoutMs ?? DEFAULT_OP_MS);
    },
    async close() {
      if (session instanceof StreamableHttpSession) await session.terminate(Date.now() + 3_000);
      else await session.terminate();
    },
  };
}

export interface McpProbeResult {
  ok: boolean;
  latencyMs: number;
  info?: McpSessionInfo;
  tools?: McpToolDef[];
  truncated?: boolean;
  error?: string;
  errorClass?: McpErrorClass;
  oauth?: boolean;
}

/** The live "Test": initialize + tools/list with an honest error. Never throws. */
export async function probeMcpServer(target: McpServerTarget, opts: { timeoutMs: number }): Promise<McpProbeResult> {
  const t0 = Date.now();
  let conn: McpConnection | null = null;
  try {
    conn = await connectMcp(target, opts);
    const remaining = Math.max(1_000, opts.timeoutMs - (Date.now() - t0));
    const { tools, truncated } = await conn.listTools({ timeoutMs: remaining });
    return { ok: true, latencyMs: Date.now() - t0, info: conn.info, tools, truncated };
  } catch (err) {
    const e = netErrorToMcp(err);
    return { ok: false, latencyMs: Date.now() - t0, error: e.message, errorClass: e.kind, ...(e.extra?.oauth ? { oauth: true } : {}) };
  } finally {
    if (conn) await conn.close().catch(() => { /* best-effort */ });
  }
}

export { netErrorToMcp as toMcpClientError };
