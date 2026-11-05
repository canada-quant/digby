/**
 * MCP wire sessions for the Digby gateway (ticket 5f69fdc4).
 *
 * THE DEFECT THIS FIXES. `mcp-search.ts` posted each `tools/call` as a bare
 * one-shot HTTP request: no `initialize`, no `Mcp-Session-Id`. The gateway
 * (supergateway in front of `@brightdata/mcp`) was likewise running WITHOUT
 * `--stateful`, which means supergateway spawns a BRAND-NEW stdio child for
 * every POST ("One stateless POST: a server, transport and child of its own,
 * released once the response is over"). `@brightdata/mcp` keeps its browser in
 * a module-level singleton inside that child, so every tools/call got its OWN
 * fresh browser. Measured on prod (lane 0ef29d23, msg de554dcc):
 *
 *   01_navigate :: "Successfully navigated to https://quotes.toscrape.com/js/"
 *   02_snapshot :: "Page: about:blank"     <-- a different, fresh browser
 *   03_get_text :: null (60s SSE timeout)
 *   04_click_ref:: "Ref e12 not found in the current page snapshot"
 *
 * The fix has two halves that MUST ship together:
 *   - gateway: `supergateway --stateful` (mcp-gateway/entrypoint.sh) makes the
 *     transport hold one child per `Mcp-Session-Id` and echo the id on
 *     `initialize`;
 *   - client:  THIS module performs the `initialize` handshake, captures the
 *     id, and sends it (plus `MCP-Protocol-Version`) on every later request.
 *
 * Without the client half a stateful gateway answers 400 to every session-less
 * request — i.e. all web search and page reading would break, which is exactly
 * the regression the acceptance bar forbids (criterion 5: the working scrape
 * path must keep returning rendered content). Without the gateway half the id
 * is simply never issued and every call falls back to today's behaviour, so
 * the client change is safe to land first and harmless if the gateway has not
 * been rebuilt yet (`id: null` → no header → stateless gateway is content).
 *
 * SCOPING. Sessions are keyed, not global. Search/scrape share one default
 * session (they carry no state worth isolating, and one child is strictly
 * better than the per-POST churn that caused the OOM respawn storms); a
 * browser-agent run gets its OWN key so two concurrent runs never fight over
 * one page, and releases it on close so the browser dies with the run.
 *
 * EXPIRY. supergateway reaps a session after 30 min idle and answers 404
 * (`Session not found`) — the spec's re-initialize contract. `invalidate()` is
 * called on that 404 so the next call re-initializes; a client that replayed a
 * dead id forever is the exact bug supergateway 4.0.0 changed 400→404 to fix.
 */

import axios from 'axios';
import logger from '../../utils/logger';

/**
 * What we ASK for on initialize. supergateway's own default is 2024-11-05; a
 * newer value than the server supports is a 400, so stay on the conservative
 * default and echo back whatever the server negotiated.
 */
export const MCP_REQUEST_PROTOCOL_VERSION = '2024-11-05';

/** Cheap ceiling for the initialize handshake (it spawns a stdio child + CDP). */
const INIT_TIMEOUT_MS = 25_000;
/** Best-effort notification/DELETE — never worth blocking a tool call on. */
const NOTIFY_TIMEOUT_MS = 5_000;

export interface McpGatewayTarget {
  /** The gateway's streamable-HTTP endpoint, e.g. https://mcp.digby.ai/mcp */
  url: string;
  /** Shared gateway API key (X-API-Key). */
  token: string;
}

/** The session-scoped request headers a `tools/call` must carry. */
export interface McpSessionHeaders {
  'Mcp-Session-Id'?: string;
  'MCP-Protocol-Version'?: string;
}

interface SessionEntry {
  /** The `Mcp-Session-Id` issued by the gateway, or null on a stateless gateway. */
  id: string | null;
  /**
   * The mount this session was ESTABLISHED on (ticket 5f69fdc4 follow-up).
   *
   * The gateway exposes TWO supergateways: the shared stateless `/mcp` and the
   * stateful `/browser/mcp`. A browser run establishes on the stateful mount,
   * but `release()` used to be handed `mcpGatewayTarget()` — the STATELESS url —
   * so the DELETE was addressed to a gateway that never held the id. Because
   * `release()` accepts any status (`validateStatus: () => true`) that mismatch
   * logged a cheerful "released" while the stdio child — and with it the
   * BrightData browser — survived until the 30-min idle reaper. Measured on box
   * B: lifecycle target `https://mcp.digby.ai/mcp` vs browser target
   * `http://host.docker.internal:8200/browser/mcp`, with the gateway's child
   * count climbing across runs. A session must be torn down on the mount that
   * minted it, so the mount is recorded here at establishment.
   */
  url: string | null;
  /** Version the server negotiated; echoed as `MCP-Protocol-Version` when known. */
  protocolVersion: string | null;
  /** In-flight initialize — concurrent callers await ONE handshake, not N. */
  initInFlight: Promise<boolean> | null;
  lastUsedAt: number;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // Both MUST be listed — the MCP TypeScript SDK answers 406 otherwise.
    'Accept': 'application/json, text/event-stream',
    'X-API-Key': token,
  };
}

/** Header names are case-insensitive; axios lower-cases them. */
function headerOf(headers: any, name: string): string | null {
  if (!headers) return null;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === 'string' && direct) return direct;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase() && typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Read and discard a streamed/plain response body. The initialize answer's
 * BODY is not needed (the session id rides in the headers), but an unconsumed
 * socket leaks — and a leak in the gateway path is the class that used to
 * 502 every tool call. Tolerant by construction: any read failure is fine.
 */
function drain(data: any): void {
  try {
    if (data && typeof data.on === 'function') data.destroy?.();
    else if (data && typeof data.resume === 'function') data.resume();
  } catch { /* best-effort */ }
}

/**
 * Parse a JSON-RPC result out of an SSE-framed OR plain-JSON MCP body.
 * Mirrors the format-agnostic parsing the tool-call path already does
 * (mcp-search.ts callMcpToolOnce) — a streamable-HTTP server may answer either.
 */
function parseRpcResult(body: string): any {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  // Plain JSON first.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* not plain JSON — fall through to SSE */ }
  // SSE: `data: {...}` frames, blank-line dispatched; a harness may send several.
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !('method' in parsed)) return parsed;
    } catch { /* skip non-JSON frames */ }
  }
  return null;
}

export class McpSessionRegistry {
  private entries = new Map<string, SessionEntry>();

  /** Test/observability hook — the keys currently held. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  private entry(key: string): SessionEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { id: null, url: null, protocolVersion: null, initInFlight: null, lastUsedAt: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * Headers for a request on `key`, initializing the session if needed.
   * Returns an empty object on a stateless gateway (no id issued) — the caller
   * then behaves exactly as before this change.
   *
   * Never throws: a failed handshake must not fail the tool call. The call
   * proceeds session-less (which is today's behaviour) and the gateway tier's
   * own retry/health logic owns the outcome.
   */
  async headers(key: string, target: McpGatewayTarget): Promise<McpSessionHeaders> {
    const e = this.entry(key);
    if (!e.id) {
      const ok = await this.initialize(key, target);
      if (!ok) return {};
    }
    e.lastUsedAt = Date.now();
    const out: McpSessionHeaders = {};
    if (e.id) out['Mcp-Session-Id'] = e.id;
    if (e.protocolVersion) out['MCP-Protocol-Version'] = e.protocolVersion;
    return out;
  }

  /** True when a session id is currently held for `key`. */
  has(key: string): boolean {
    return !!this.entries.get(key)?.id;
  }

  /**
   * Drop the held id so the NEXT `headers()` re-initializes. Called on the
   * spec's 404 (`Session not found`) — a reaped, restarted or terminated
   * session — never on a 4xx that indicts the request itself.
   */
  invalidate(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.id = null;
    e.url = null;
    e.protocolVersion = null;
    e.initInFlight = null;
    logger.info(`MCP session ${key}: dropped (gateway no longer holds it) — the next call re-initializes`);
  }

  /**
   * The `initialize` handshake. Concurrent callers share ONE in-flight
   * promise: without that, N parallel tool calls would each spawn a stdio
   * child (N browsers) on a stateful gateway.
   */
  private initialize(key: string, target: McpGatewayTarget): Promise<boolean> {
    const e = this.entry(key);
    if (e.initInFlight) return e.initInFlight;
    const p = (async (): Promise<boolean> => {
      try {
        const resp = await axios.post(
          target.url,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: MCP_REQUEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'digby-backend', version: '1.0.0' },
            },
          },
          {
            headers: baseHeaders(target.token),
            timeout: INIT_TIMEOUT_MS,
            responseType: 'stream',
            // Truncated/odd bodies are fine; we only read headers. Accept any
            // status so a 4xx is inspected rather than thrown as a network error.
            validateStatus: () => true,
          },
        );

        const sid = headerOf(resp.headers, 'mcp-session-id');
        let negotiated: string | null = null;
        try {
          const body = await readStreamText(resp.data, INIT_TIMEOUT_MS);
          const parsed = parseRpcResult(body);
          const v = parsed?.result?.protocolVersion;
          if (typeof v === 'string' && v) negotiated = v;
          if (parsed?.error) {
            logger.warn(`MCP session ${key}: initialize answered a JSON-RPC error: ${String(parsed.error?.message || '').slice(0, 160)}`);
          }
        } catch { /* body is optional for our purposes */ }

        if (!sid) {
          // No id issued = the gateway is still stateless. That is NOT a
          // failure: every call keeps working exactly as it did before
          // --stateful, so this is an info line, not a warning. Cache the
          // negative briefly by leaving id null (each call re-probes; the
          // initialize is cheap and idempotent on a stateless gateway).
          logger.info(`MCP session ${key}: gateway issued no Mcp-Session-Id (stateless gateway — one-shot calls, no live browser between calls)`);
          e.protocolVersion = negotiated;
          return false;
        }

        e.id = sid;
        // Record the mount that MINTED this id — `release()` must DELETE here,
        // not on whatever url the caller happens to default to (see SessionEntry.url).
        e.url = target.url;
        e.protocolVersion = negotiated;
        logger.info(`MCP session ${key}: established (id ${sid.slice(0, 8)}…, protocol ${negotiated || 'unspecified'})`);

        // `notifications/initialized` completes the handshake (spec: the
        // client MUST send it before any other request). Best-effort.
        void this.notify(key, target, sid, negotiated).catch(() => {});
        return true;
      } catch (err: any) {
        logger.warn(`MCP session ${key}: initialize failed (${String(err?.message || err).slice(0, 160)}) — continuing session-less`);
        return false;
      } finally {
        e.initInFlight = null;
        e.lastUsedAt = Date.now();
      }
    })();
    e.initInFlight = p;
    return p;
  }

  private async notify(key: string, target: McpGatewayTarget, sid: string, proto: string | null): Promise<void> {
    void key;
    const headers: Record<string, string> = { ...baseHeaders(target.token), 'Mcp-Session-Id': sid };
    if (proto) headers['MCP-Protocol-Version'] = proto;
    const resp = await axios.post(
      target.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers, timeout: NOTIFY_TIMEOUT_MS, responseType: 'stream', validateStatus: () => true },
    );
    drain(resp.data);
  }

  /**
   * Terminate a session upstream (spec: `DELETE` + `Mcp-Session-Id`) and forget
   * it. supergateway stops that session's stdio child, which is what actually
   * closes the BrightData browser — so a browser-agent run's `close()` MUST
   * call this, or the cloud browser lingers until the idle reaper.
   * Best-effort: never throws.
   */
  async release(key: string, target: McpGatewayTarget): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    const sid = e.id;
    // The mount that MINTED this id wins over the caller's default target.
    // A stateful `/browser/mcp` session deleted on the stateless `/mcp` is
    // answered by a gateway that never held it (ticket 5f69fdc4 follow-up):
    // the child, and the BrightData browser behind it, survive.
    const url = e.url || target.url;
    const wrongMount = !!(e.url && target.url && e.url !== target.url);
    this.entries.delete(key);
    if (!sid) return;
    try {
      const headers: Record<string, string> = { ...baseHeaders(target.token), 'Mcp-Session-Id': sid };
      if (e.protocolVersion) headers['MCP-Protocol-Version'] = e.protocolVersion;
      const resp = await axios.delete(url, { headers, timeout: NOTIFY_TIMEOUT_MS, responseType: 'stream', validateStatus: () => true });
      drain(resp.data);
      // A non-2xx DELETE means the browser was NOT closed — say so, because the
      // old unconditional "released" line is what hid this mismatch in prod.
      const status = Number(resp.status || 0);
      if (status >= 200 && status < 300) {
        logger.info(`MCP session ${key}: released (id ${sid.slice(0, 8)}…)`);
        if (wrongMount) {
          logger.info(`MCP session ${key}: released on its minting mount ${url} (caller offered ${target.url})`);
        }
      } else {
        logger.warn(`MCP session ${key}: release answered HTTP ${status} on ${url} — the gateway may still hold the session (id ${sid.slice(0, 8)}…), its idle reaper will collect it`);
      }
    } catch (err: any) {
      logger.info(`MCP session ${key}: release failed (${String(err?.message || err).slice(0, 120)}) — the gateway's idle reaper owns it`);
    }
  }
}

/** Read a streamed-or-plain axios body as text, bounded by `timeoutMs`. */
function readStreamText(data: any, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    if (data == null) { resolve(''); return; }
    if (typeof data === 'string') { resolve(data); return; }
    if (typeof data.on !== 'function') {
      try { resolve(JSON.stringify(data)); } catch { resolve(''); }
      return;
    }
    let out = '';
    let done = false;
    const finish = (v: string) => { if (done) return; done = true; clearTimeout(timer); try { data.destroy?.(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => finish(out), Math.max(1, timeoutMs));
    (timer as any).unref?.();
    data.on('data', (c: Buffer) => { out += c.toString(); if (out.length > 200_000) finish(out); });
    data.on('end', () => finish(out));
    data.on('error', () => finish(out));
  });
}

/** Process-wide session registry (one per backend/worker process). */
export const mcpSessions = new McpSessionRegistry();

/**
 * Session key for search/scrape — shared, stateless-in-practice, and one child
 * is strictly better than the per-POST churn.
 */
export const DEFAULT_MCP_SESSION_KEY = 'digby:web';

/**
 * A private, per-run key for a browser-agent session (ticket 5f69fdc4).
 * One driver instance = one gateway session = one BrightData browser.
 */
export function browserMcpSessionKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `digby:browser:${process.pid}:${Date.now().toString(36)}:${rand}`;
}