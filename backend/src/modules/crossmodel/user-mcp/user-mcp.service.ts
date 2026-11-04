/**
 * User-added MCP servers (ticket e294f9a4, owner 2026-10-05: "add ability for
 * users to add their own mcp integration and it is all fully self enhancing
 * and self integrated and healing / testing / port over most common mcp base
 * quick start templates").
 *
 * What a user gets (Account → Integrations → MCP servers):
 *   - ADD a remote MCP server (Streamable HTTP or SSE URL + optional auth
 *     header / token, both encrypted at rest — user-mcp.store.ts), from scratch
 *     or from a quick-start TEMPLATE (user-mcp-templates.ts);
 *   - TEST = a live initialize + tools/list probe with an honest error
 *     (mcp-client.ts) — run automatically on save, so a saved server is
 *     integrated at once ("self-integrating"): its tools are cached and
 *     offered from the next turn;
 *   - HEALTH ("self-healing"): the `user-mcp-health` worker cron re-probes
 *     every enabled server when due — healthy every USER_MCP_HEALTH_INTERVAL_MIN
 *     (30), after a failure on an exponential backoff (5 min → 6 h); 1–2
 *     failures = degraded (tools still offered, flagged), ≥ 3 or an auth
 *     failure = unhealthy (tools omitted with ONE status line); the next good
 *     probe or call heals it and re-syncs the tool list (tools the server
 *     added / removed appear / vanish by themselves). A failed CALL feeds the
 *     same state (and pulls the next probe to ≤ 1 min); a tool's own isError
 *     never counts against the server;
 *   - TOOLS: every enabled, offered server's tools reach that user's chats and
 *     lanes as `mcp_<slug>_<tool>` (loadUserMcpRunTools — the agent loop wires
 *     the schemas, a doctrine block and the executor; bounded per server and in
 *     total; the progressive-disclosure group `connector_mcp`). Unattended
 *     (machine) runs only see READ-ONLY tools unless the user allowed changes
 *     on scheduled runs for that server. Every call is telemetered
 *     (loop_metrics `user_mcp_call`; status transitions `user_mcp_health`).
 *
 * Kill switch USER_MCP_DISABLED=1: the routes answer 404, no run offers the
 * tools, the cron is a no-op. Stored rows are untouched.
 *
 * v2 (documented, not built): MCP OAuth sign-in (PRM discovery + dynamic
 * client registration + PKCE — Notion / Sentry / Square / Asana are OAuth-only),
 * prompts/resources, server→client sampling/elicitation, per-tool usage-ranked
 * preloading, and the model proposing a server from the template catalog.
 */

import { randomUUID } from 'crypto';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { assertUserMcpUrl, McpUrlError, redactMcpUrl } from './url-guard';
import { connectMcp, probeMcpServer, McpClientError, toMcpClientError, type McpConnection, type McpProbeResult, type McpTransportPref } from './mcp-client';
import {
  type CachedMcpTool, type DoctrineServer, type McpErrorClassLite, type McpHealthStatus,
  buildUserMcpDoctrine, callTimeoutMs, exposedToolNames, formatCallContent, functionSchemaFor,
  maxServersPerUser, maxToolsPerServer, maxToolsTotal, nextHealth, offersTools, probeTimeoutMs,
  scrubSecrets, toCachedTool, uniqueSlug, userMcpDisabled,
} from './user-mcp-tools';
import {
  type StoredMcpHealth, type StoredMcpServer,
  deleteServerRows, emptyHealth, encryptSecret, getHealth, getServer, listAllHealth, listAllServers,
  listUserHealth, listUserServers, mergeHealth, putServer, resetHealth, rowKey, tryDecrypt,
} from './user-mcp.store';
import { templateById } from './user-mcp-templates';

// ── View models ──────────────────────────────────────────────────────────────

export interface UserMcpToolView {
  name: string;
  exposedName: string;
  title?: string;
  description: string;
  readOnly: boolean;
  /** annotation = the server said so; name = inferred from a read-verb name (no readOnlyHint sent). */
  readOnlySource?: 'annotation' | 'name';
  destructive: boolean;
  enabled: boolean;
}

export interface UserMcpServerView {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: McpTransportPref;
  authHeader: string;
  hasAuth: boolean;
  authPreview: string | null;
  /** The stored secret no longer decrypts (JWT_SECRET rotated) — re-enter it. */
  authUnreadable: boolean;
  enabled: boolean;
  machineWrites: boolean;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
  health: Omit<StoredMcpHealth, 'tools'>;
  tools: UserMcpToolView[];
}

export interface UserMcpProbeView {
  ok: boolean;
  latencyMs: number;
  transport: string | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  toolCount: number;
  tools: Array<{ name: string; readOnly: boolean; description: string }>;
  truncated: boolean;
  error?: string;
  errorClass?: string;
  /** The server asked for OAuth sign-in (v2) — the UI explains the token alternative. */
  oauth?: boolean;
}

function toView(s: StoredMcpServer, h: StoredMcpHealth): UserMcpServerView {
  const { tools, ...health } = h;
  const names = exposedToolNames(s.slug, tools.map((t) => t.name));
  const disabled = new Set(s.disabledTools ?? []);
  return {
    id: s.id, name: s.name, slug: s.slug, url: s.urlDisplay, transport: s.transport,
    authHeader: s.authHeader, hasAuth: !!s.authEnc, authPreview: s.authPreview,
    authUnreadable: !!s.authEnc && tryDecrypt(s.authEnc) === null,
    enabled: s.enabled, machineWrites: !!s.machineWrites, templateId: s.templateId,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    health,
    tools: tools.map((t, i) => ({
      name: t.name, exposedName: names[i]?.exposed ?? '', ...(t.title ? { title: t.title } : {}),
      description: t.description, readOnly: t.readOnly, ...(t.readOnlySource ? { readOnlySource: t.readOnlySource } : {}), destructive: t.destructive, enabled: !disabled.has(t.name),
    })),
  };
}

function probeView(p: McpProbeResult, secrets: Array<string | null>): UserMcpProbeView {
  const tools = (p.tools ?? []).map((t) => toCachedTool(t));
  return {
    ok: p.ok,
    latencyMs: p.latencyMs,
    transport: p.info?.transport ?? null,
    serverName: p.info?.serverName ?? null,
    serverVersion: p.info?.serverVersion ?? null,
    protocolVersion: p.info?.protocolVersion ?? null,
    toolCount: tools.length,
    tools: tools.slice(0, 200).map((t) => ({ name: t.name, readOnly: t.readOnly, description: t.description.slice(0, 200) })),
    truncated: !!p.truncated,
    ...(p.error ? { error: scrubSecrets(p.error, secrets) } : {}),
    ...(p.errorClass ? { errorClass: p.errorClass } : {}),
    ...(p.oauth ? { oauth: true } : {}),
  };
}

// ── Input normalization ──────────────────────────────────────────────────────

export interface UserMcpServerInput {
  name?: string;
  url?: string;
  transport?: McpTransportPref;
  authHeader?: string;
  /** Full header value; '' clears; undefined keeps (update). */
  authValue?: string;
  enabled?: boolean;
  machineWrites?: boolean;
  disabledTools?: string[];
  templateId?: string | null;
}

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'upgrade', 'te', 'trailer', 'keep-alive', 'cookie', 'proxy-authorization', 'user-agent']);

function bad(msg: string): AppError { return new AppError(400, msg); }

function normalizeName(raw: unknown): string {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw bad('Give the server a name.');
  if (n.length > 60) throw bad('Name is too long (max 60 characters).');
  return n;
}

function normalizeUrl(raw: unknown): URL {
  try { return assertUserMcpUrl(String(raw ?? '')); } catch (err) {
    throw bad(err instanceof McpUrlError ? err.message : 'Invalid URL.');
  }
}

function normalizeTransport(raw: unknown): McpTransportPref {
  return raw === 'streamable_http' || raw === 'sse' ? raw : 'auto';
}

function normalizeHeaderName(raw: unknown): string {
  const h = String(raw ?? '').trim();
  if (!h) return '';
  if (!HEADER_NAME_RE.test(h)) throw bad('The auth header name may only use letters, digits and dashes.');
  if (RESERVED_HEADERS.has(h.toLowerCase())) throw bad(`"${h}" is reserved by the MCP protocol — use Authorization or the vendor's API-key header.`);
  return h;
}

/** Authorization + a bare token ⇒ "Bearer <token>" (the near-universal MCP scheme). */
export function normalizeAuthValue(headerName: string, raw: string): string {
  const v = String(raw ?? '').trim();
  if (/[\r\n]/.test(v)) throw bad('The token must be a single line.');
  if (v.length > 8_192) throw bad('The token is too long (max 8,192 characters).');
  if (v && headerName.toLowerCase() === 'authorization' && !/\s/.test(v)) return `Bearer ${v}`;
  return v;
}

function previewOf(value: string): string | null {
  const bare = value.replace(/^(?:bearer|basic|token)\s+/i, '');
  return bare.length >= 8 ? `••••${bare.slice(-4)}` : bare ? '••••' : null;
}

// ── Probe + health recording ─────────────────────────────────────────────────

/** In-process probe limiter: a Test button must not turn the backend into a request cannon. */
const probeBudget = new Map<string, number[]>();
const PROBE_WINDOW_MS = 10 * 60_000;
const PROBES_PER_WINDOW = 30;
function takeProbeSlot(userId: string): boolean {
  const now = Date.now();
  const arr = (probeBudget.get(userId) ?? []).filter((t) => now - t < PROBE_WINDOW_MS);
  if (arr.length >= PROBES_PER_WINDOW) { probeBudget.set(userId, arr); return false; }
  arr.push(now);
  probeBudget.set(userId, arr);
  return true;
}
/** Test seam. */
export function _resetProbeBudget(): void { probeBudget.clear(); }

interface Secrets { url: string; authValue: string | null }

function secretsOf(s: StoredMcpServer): Secrets | { error: string } {
  const url = tryDecrypt(s.urlEnc);
  if (!url) return { error: 'The stored URL no longer decrypts (the server secret rotated) — edit the server and re-enter its URL.' };
  if (s.authEnc) {
    const authValue = tryDecrypt(s.authEnc);
    if (authValue === null) return { error: 'The stored token no longer decrypts (the server secret rotated) — edit the server and re-enter the token.' };
    return { url, authValue };
  }
  return { url, authValue: null };
}

function headersFor(s: StoredMcpServer, sec: Secrets): Record<string, string> {
  return s.authHeader && sec.authValue ? { [s.authHeader]: sec.authValue } : {};
}

function recordHealthTransition(s: StoredMcpServer, from: McpHealthStatus, to: McpHealthStatus, source: 'probe' | 'call', errorClass: string | null): void {
  if (from === to) return;
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.USER_MCP_HEALTH,
      meta: { serverId: s.id, userId: s.userId, slug: s.slug, from, to, source, errorClass, recovered: to === 'healthy' && (from === 'unhealthy' || from === 'degraded') },
    });
  } catch { /* telemetry never breaks the probe */ }
  logger.info(`user-mcp: server ${s.slug} (${s.id.slice(0, 8)}, user ${s.userId.slice(0, 8)}) ${from} → ${to} (${source}${errorClass ? `, ${errorClass}` : ''})`);
}

/** Run one live probe for a stored server and record the outcome (health + tool cache). Never throws. */
export async function probeAndRecord(s: StoredMcpServer): Promise<UserMcpProbeView> {
  const source = 'probe' as const;
  const prev = await getHealth(s.userId, s.id).catch(() => null);
  const sec = secretsOf(s);
  let result: McpProbeResult;
  let secrets: Array<string | null> = [];
  if ('error' in sec) {
    result = { ok: false, latencyMs: 0, error: sec.error, errorClass: 'protocol' };
  } else {
    secrets = [sec.authValue, sec.url];
    result = await probeMcpServer({ url: sec.url, transport: s.transport, headers: headersFor(s, sec) }, { timeoutMs: probeTimeoutMs() });
  }
  const view = probeView(result, secrets);
  const now = Date.now();
  const base = prev ?? null;
  const counters = nextHealth({
    status: base?.status ?? 'unknown', consecutiveFailures: base?.consecutiveFailures ?? 0,
    lastError: base?.lastError ?? null, lastErrorClass: base?.lastErrorClass ?? null,
    lastCheckAt: base?.lastCheckAt ?? null, lastOkAt: base?.lastOkAt ?? null, nextCheckAt: base?.nextCheckAt ?? null,
  }, { ok: result.ok, at: now, source, error: view.error, errorClass: (('error' in sec) ? 'config' : (view.errorClass as McpErrorClassLite | undefined)) });
  const patch: Partial<StoredMcpHealth> = { ...counters, lastLatencyMs: result.latencyMs };
  if (result.ok) {
    const tools = (result.tools ?? []).map((t) => toCachedTool(t));
    const prevNames = new Set((base?.tools ?? []).map((t) => t.name));
    const nextNames = new Set(tools.map((t) => t.name));
    const added = [...nextNames].filter((n) => !prevNames.has(n)).length;
    const removed = [...prevNames].filter((n) => !nextNames.has(n)).length;
    Object.assign(patch, {
      tools, toolsAt: new Date(now).toISOString(), toolsTruncated: !!result.truncated,
      transport: result.info?.transport ?? null,
      serverName: result.info?.serverName ?? null, serverVersion: result.info?.serverVersion ?? null,
      protocolVersion: result.info?.protocolVersion ?? null,
    });
    if (base && base.toolsAt && (added || removed)) {
      logger.info(`user-mcp: server ${s.slug} (${s.id.slice(0, 8)}) tool list re-synced (+${added} / -${removed})`);
    }
  }
  try {
    await mergeHealth(s.userId, s.id, patch);
  } catch (err: any) {
    logger.warn(`user-mcp: recording probe health for ${s.id.slice(0, 8)} failed (non-fatal): ${err?.message || err}`);
  }
  recordHealthTransition(s, base?.status ?? 'unknown', counters.status, 'probe', counters.lastErrorClass);
  return view;
}

/** A tools/call outcome feeds the health state (transport failures only — never a tool's own isError). */
async function recordCallOutcome(s: StoredMcpServer, ok: boolean, error?: string, errorClass?: McpErrorClassLite): Promise<void> {
  try {
    const prev = await getHealth(s.userId, s.id);
    const counters = nextHealth(prev, { ok, at: Date.now(), source: 'call', error, errorClass });
    await mergeHealth(s.userId, s.id, {
      ...counters,
      callsOk: prev.callsOk + (ok ? 1 : 0),
      callsFailed: prev.callsFailed + (ok ? 0 : 1),
      lastCallAt: new Date().toISOString(),
    });
    recordHealthTransition(s, prev.status, counters.status, 'call', counters.lastErrorClass);
  } catch (err: any) {
    logger.warn(`user-mcp: recording a call outcome for ${s.id.slice(0, 8)} failed (non-fatal): ${err?.message || err}`);
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function assertEnabled(): void {
  if (userMcpDisabled()) throw new AppError(404, 'MCP servers are switched off on this instance.');
}

export async function listServers(userId: string): Promise<UserMcpServerView[]> {
  assertEnabled();
  const [servers, health] = await Promise.all([listUserServers(userId), listUserHealth(userId)]);
  return servers.map((s) => toView(s, health.get(s.id) ?? emptyHealth()));
}

export async function createServer(userId: string, input: UserMcpServerInput): Promise<{ server: UserMcpServerView; probe: UserMcpProbeView | null }> {
  assertEnabled();
  const existing = await listUserServers(userId);
  if (existing.length >= maxServersPerUser()) throw bad(`You can add up to ${maxServersPerUser()} MCP servers — remove one first.`);
  const name = normalizeName(input.name);
  const url = normalizeUrl(input.url);
  const authHeader = normalizeHeaderName(input.authHeader ?? (input.authValue ? 'Authorization' : ''));
  const authValue = authHeader ? normalizeAuthValue(authHeader, input.authValue ?? '') : '';
  if (authHeader && !authValue && input.authValue !== undefined && input.authValue !== '') throw bad('The token is empty.');
  const now = new Date().toISOString();
  const template = templateById(input.templateId ?? null);
  const s: StoredMcpServer = {
    id: randomUUID(),
    userId,
    name,
    slug: uniqueSlug(name, existing.map((e) => e.slug)),
    urlEnc: encryptSecret(url.toString()),
    urlDisplay: redactMcpUrl(url.toString()),
    transport: normalizeTransport(input.transport),
    authHeader: authValue ? authHeader : '',
    authEnc: authValue ? encryptSecret(authValue) : null,
    authPreview: authValue ? previewOf(authValue) : null,
    enabled: input.enabled !== false,
    machineWrites: input.machineWrites === true,
    disabledTools: [],
    templateId: template?.id ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await putServer(s);
  await resetHealth(userId, s.id);
  logger.info(`user-mcp: user ${userId.slice(0, 8)} added server ${s.slug} (${s.urlDisplay}, auth=${s.authEnc ? 'set' : 'none'})`);
  // Self-integrating: probe at once so the tools are cached before the next turn.
  const probe = s.enabled && takeProbeSlot(userId) ? await probeAndRecord(s) : null;
  const health = await getHealth(userId, s.id).catch(() => emptyHealth());
  return { server: toView(s, health), probe };
}

export async function updateServer(userId: string, serverId: string, patch: UserMcpServerInput): Promise<{ server: UserMcpServerView; probe: UserMcpProbeView | null } | null> {
  assertEnabled();
  const s = await getServer(userId, serverId);
  if (!s) return null;
  let reprobe = false;
  const next: StoredMcpServer = { ...s };
  if (patch.name !== undefined) {
    next.name = normalizeName(patch.name);
    // The slug (and so every exposed tool name) is STABLE across renames — a rename must not re-key tools mid-conversation.
  }
  if (patch.url !== undefined) {
    const url = normalizeUrl(patch.url);
    next.urlEnc = encryptSecret(url.toString());
    next.urlDisplay = redactMcpUrl(url.toString());
    reprobe = true;
  }
  if (patch.transport !== undefined) { next.transport = normalizeTransport(patch.transport); reprobe = true; }
  if (patch.authHeader !== undefined || patch.authValue !== undefined) {
    const header = patch.authHeader !== undefined ? normalizeHeaderName(patch.authHeader) : s.authHeader;
    if (patch.authValue !== undefined) {
      const value = header ? normalizeAuthValue(header, patch.authValue) : '';
      next.authHeader = value ? header : '';
      next.authEnc = value ? encryptSecret(value) : null;
      next.authPreview = value ? previewOf(value) : null;
    } else if (!header) {
      next.authHeader = ''; next.authEnc = null; next.authPreview = null;
    } else {
      next.authHeader = header; // renamed header, same token
    }
    reprobe = true;
  }
  if (patch.enabled !== undefined) { if (patch.enabled && !s.enabled) reprobe = true; next.enabled = !!patch.enabled; }
  if (patch.machineWrites !== undefined) next.machineWrites = !!patch.machineWrites;
  if (patch.disabledTools !== undefined) {
    next.disabledTools = [...new Set((patch.disabledTools ?? []).map((t) => String(t)).filter(Boolean))].slice(0, 500);
  }
  next.updatedAt = new Date().toISOString();
  await putServer(next);
  // A changed URL / transport / token is a NEW connection: forget the old verdict, probe fresh.
  if (reprobe && (patch.url !== undefined || patch.transport !== undefined || patch.authValue !== undefined || patch.authHeader !== undefined)) {
    await resetHealth(userId, serverId).catch(() => { /* the probe below rewrites it */ });
  }
  const probe = reprobe && next.enabled && takeProbeSlot(userId) ? await probeAndRecord(next) : null;
  const health = await getHealth(userId, serverId).catch(() => emptyHealth());
  return { server: toView(next, health), probe };
}

export async function deleteServer(userId: string, serverId: string): Promise<boolean> {
  assertEnabled();
  const s = await getServer(userId, serverId);
  if (!s) return false;
  await deleteServerRows(userId, serverId);
  logger.info(`user-mcp: user ${userId.slice(0, 8)} removed server ${s.slug}`);
  return true;
}

/** "Test" on a saved server: a live probe that also records health + refreshes the tool cache. */
export async function testServer(userId: string, serverId: string): Promise<{ server: UserMcpServerView; probe: UserMcpProbeView } | null> {
  assertEnabled();
  const s = await getServer(userId, serverId);
  if (!s) return null;
  if (!takeProbeSlot(userId)) throw new AppError(429, 'Too many connection tests — wait a few minutes.');
  const probe = await probeAndRecord(s);
  const health = await getHealth(userId, serverId).catch(() => emptyHealth());
  return { server: toView(s, health), probe };
}

/** "Test connection" in the Add form — nothing is stored. */
export async function testDraft(userId: string, input: UserMcpServerInput): Promise<UserMcpProbeView> {
  assertEnabled();
  const url = normalizeUrl(input.url);
  const authHeader = normalizeHeaderName(input.authHeader ?? (input.authValue ? 'Authorization' : ''));
  const authValue = authHeader ? normalizeAuthValue(authHeader, input.authValue ?? '') : '';
  if (!takeProbeSlot(userId)) throw new AppError(429, 'Too many connection tests — wait a few minutes.');
  const result = await probeMcpServer({
    url: url.toString(), transport: normalizeTransport(input.transport),
    headers: authHeader && authValue ? { [authHeader]: authValue } : {},
  }, { timeoutMs: probeTimeoutMs() });
  return probeView(result, [authValue || null, url.toString()]);
}

// ── Health sweep (worker cron `user-mcp-health`) ─────────────────────────────

export const USER_MCP_HEALTH_JOB_ID = 'user-mcp-health';
export const USER_MCP_HEALTH_INTERVAL_SEC = 300;
const SWEEP_MAX_PER_TICK = 50;
const SWEEP_CONCURRENCY = 4;

/** Probe every enabled server whose nextCheckAt is due. Never throws; returns a ≤200-char summary. */
export async function runUserMcpHealthSweepOnce(now = Date.now()): Promise<string> {
  if (userMcpDisabled()) return 'disabled (USER_MCP_DISABLED=1)';
  const t0 = Date.now();
  try {
    const [servers, health] = await Promise.all([listAllServers(), listAllHealth()]);
    const due = servers
      .filter((s) => s.enabled)
      .map((s) => ({ s, h: health.get(rowKey(s.userId, s.id)) }))
      .filter(({ h }) => !h?.nextCheckAt || Date.parse(h.nextCheckAt) <= now)
      .sort((a, b) => (Date.parse(a.h?.nextCheckAt ?? '') || 0) - (Date.parse(b.h?.nextCheckAt ?? '') || 0))
      .slice(0, SWEEP_MAX_PER_TICK);
    const tally = { healthy: 0, degraded: 0, unhealthy: 0, recovered: 0 };
    let idx = 0;
    const worker = async () => {
      while (idx < due.length) {
        const { s, h } = due[idx++];
        const before = h?.status ?? 'unknown';
        const view = await probeAndRecord(s).catch(() => null);
        if (!view) continue;
        const after = (await getHealth(s.userId, s.id).catch(() => null))?.status ?? (view.ok ? 'healthy' : 'degraded');
        if (after === 'healthy') tally.healthy++; else if (after === 'degraded') tally.degraded++; else tally.unhealthy++;
        if (after === 'healthy' && (before === 'unhealthy' || before === 'degraded')) tally.recovered++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, worker));
    return `servers ${servers.length}, checked ${due.length}, healthy ${tally.healthy}, degraded ${tally.degraded}, unhealthy ${tally.unhealthy}, recovered ${tally.recovered}, ${Date.now() - t0} ms`.slice(0, 200);
  } catch (err: any) {
    logger.warn(`user-mcp-health: sweep failed (non-fatal): ${err?.message || err}`);
    return `failed: ${String(err?.message || err).slice(0, 160)}`;
  }
}

// ── Run tools (the agent loop's seam) ────────────────────────────────────────

export interface UserMcpCallContext {
  userTurnAt?: Date;
  machineTriggered?: boolean;
  sessionId?: string;
  runId?: string | null;
}

export interface UserMcpRunTools {
  /** Function schemas to append to the run's tool list. */
  schemas: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  names: ReadonlySet<string>;
  /** System-prompt block (empty when the user has no enabled server). */
  doctrine: string;
  /** One progress line per server whose tools are omitted / flaky this run. */
  statusLines: string[];
  /** Lower-cased server names + slugs (the tool-group preload hint). */
  serverHints: string[];
  toolCount: number;
  /** false = the tool changes data (the session permission mode applies to it); undefined = not on this run. */
  isReadOnly(name: string): boolean | undefined;
  execute(name: string, args: unknown, ctx: UserMcpCallContext): Promise<string>;
}

interface RunEntry { server: StoredMcpServer; tool: CachedMcpTool; transport: McpTransportPref }

const RUN_LOAD_TIMEOUT_MS = 2_500;
const RUN_FAILURES_BEFORE_SHORT_CIRCUIT = 2;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    (t as any).unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function relAge(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `; last checked ${m} min ago` : `; last checked ${Math.round(m / 60)} h ago`;
}

/**
 * The user's MCP tools for ONE run: schemas + doctrine + executor. Reads only
 * the stored rows (no network) and is bounded by RUN_LOAD_TIMEOUT_MS — a slow
 * store means the run simply has no MCP tools. Never throws; null when the
 * feature is off, the user is anonymous or has no enabled server.
 */
export async function loadUserMcpRunTools(userId: string | null | undefined, opts: { machine: boolean; groupsHint?: boolean }): Promise<UserMcpRunTools | null> {
  if (userMcpDisabled() || !userId || userId === 'anonymous') return null;
  let loaded: [StoredMcpServer[], Map<string, StoredMcpHealth>] | 'timeout';
  try {
    loaded = await withTimeout(Promise.all([listUserServers(userId), listUserHealth(userId)]), RUN_LOAD_TIMEOUT_MS);
  } catch (err: any) {
    logger.warn(`user-mcp: loading run tools for ${userId.slice(0, 8)} failed (run continues without them): ${err?.message || err}`);
    return null;
  }
  if (loaded === 'timeout') {
    logger.warn(`user-mcp: loading run tools for ${userId.slice(0, 8)} exceeded ${RUN_LOAD_TIMEOUT_MS} ms — run continues without them`);
    return null;
  }
  const [servers, health] = loaded;
  const enabled = servers.filter((s) => s.enabled);
  if (!enabled.length) return null;

  const now = Date.now();
  const perServer = maxToolsPerServer();
  let budget = maxToolsTotal();
  const map = new Map<string, RunEntry>();
  const schemas: UserMcpRunTools['schemas'] = [];
  const doctrine: DoctrineServer[] = [];
  const statusLines: string[] = [];
  const hints: string[] = [];

  for (const s of [...enabled].sort((a, b) => a.name.localeCompare(b.name))) {
    const h = health.get(s.id) ?? emptyHealth();
    hints.push(s.name.toLowerCase(), s.slug);
    if (!offersTools(h.status)) {
      const why = h.status === 'unknown'
        ? 'not connected yet (no successful test)'
        : `UNHEALTHY (${h.lastErrorClass ?? 'error'}: ${String(h.lastError ?? 'no answer').slice(0, 120)}${relAge(h.lastCheckAt, now)})`;
      doctrine.push({ name: s.name, slug: s.slug, status: h.status, toolNames: [], omittedReason: why });
      statusLines.push(`MCP server "${s.name}" is ${why} — its tools are omitted this run; Digby re-checks it automatically.`);
      continue;
    }
    const disabled = new Set(s.disabledTools ?? []);
    let tools = h.tools.filter((t) => !disabled.has(t.name));
    let hiddenWrites = 0;
    if (opts.machine && !s.machineWrites) {
      const ro = tools.filter((t) => t.readOnly);
      hiddenWrites = tools.length - ro.length;
      tools = ro;
    }
    tools = tools.slice(0, Math.max(0, Math.min(perServer, budget)));
    budget -= tools.length;
    if (!tools.length) {
      if (h.tools.length) doctrine.push({ name: s.name, slug: s.slug, status: h.status, toolNames: [], omittedReason: hiddenWrites ? 'no read-only tools (its tools change data — withheld on this unattended run)' : 'no tools enabled' });
      continue;
    }
    const names = exposedToolNames(s.slug, tools.map((t) => t.name));
    const transport: McpTransportPref = h.transport ?? s.transport;
    tools.forEach((t, i) => {
      const exposed = names[i].exposed;
      map.set(exposed, { server: s, tool: t, transport });
      schemas.push(functionSchemaFor(exposed, s.name, t));
    });
    doctrine.push({ name: s.name, slug: s.slug, status: h.status, toolNames: names.map((n) => n.exposed), hiddenWrites });
    if (h.status === 'degraded') statusLines.push(`MCP server "${s.name}" is flaky (${h.consecutiveFailures} recent failure(s): ${String(h.lastError ?? '').slice(0, 100)}) — its tools are offered; a failure will be reported, not retried.`);
  }

  // Per-run connection cache (Streamable HTTP only — an SSE session holds a socket open, so it opens per call).
  const conns = new Map<string, Promise<McpConnection>>();
  const runFailures = new Map<string, number>();

  async function execute(name: string, args: unknown, ctx: UserMcpCallContext): Promise<string> {
    const entry = map.get(name);
    if (!entry) {
      return JSON.stringify({ ok: false, tool: name, reason: 'not_available', message: `MCP tool ${name} is not available on this run (the server is disabled, unhealthy, removed, or the tool is switched off). Account → Integrations → MCP servers shows its state.` });
    }
    const { server: s, tool } = entry;
    const machine = ctx.machineTriggered === true || !ctx.userTurnAt;
    if (machine && !tool.readOnly && !s.machineWrites) {
      return JSON.stringify({ ok: false, tool: name, reason: 'machine_run', message: `NOT RUN: ${tool.name} on "${s.name}" can change data, and this is an unattended run. It needs a turn where the user asked for it (or the user allows changes on scheduled runs for this server). Put the proposed change in your answer instead.` });
    }
    if ((runFailures.get(s.id) ?? 0) >= RUN_FAILURES_BEFORE_SHORT_CIRCUIT) {
      return `MCP SERVER UNAVAILABLE — "${s.name}" failed ${runFailures.get(s.id)} times this run; not calling it again. Tell the user if it matters and continue.`;
    }
    const sec = secretsOf(s);
    if ('error' in sec) return `MCP SERVER UNAVAILABLE — "${s.name}": ${sec.error}`;
    const secrets = [sec.authValue, sec.url];
    const callArgs = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const t0 = Date.now();
    const telemetry = (ok: boolean, errorClass: string | null) => {
      try {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.USER_MCP_CALL,
          sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
          value: Date.now() - t0, unit: 'ms',
          meta: { serverId: s.id, slug: s.slug, tool: tool.name, ok, errorClass, machine, readOnly: tool.readOnly },
        });
      } catch { /* never breaks the call */ }
    };
    const sse = entry.transport === 'sse';
    try {
      let conn: McpConnection;
      if (sse) {
        conn = await connectMcp({ url: sec.url, transport: 'sse', headers: headersFor(s, sec) }, { timeoutMs: probeTimeoutMs() });
      } else {
        let p = conns.get(s.id);
        if (!p) {
          p = connectMcp({ url: sec.url, transport: entry.transport, headers: headersFor(s, sec) }, { timeoutMs: probeTimeoutMs() });
          conns.set(s.id, p);
          p.catch(() => conns.delete(s.id));
        }
        conn = await p;
      }
      let result;
      try {
        result = await conn.callTool(tool.name, callArgs, { timeoutMs: callTimeoutMs() });
      } finally {
        if (sse) await conn.close().catch(() => { /* best-effort */ });
      }
      runFailures.delete(s.id);
      // The server answered: transport-healthy whatever the tool said.
      void recordCallOutcome(s, true);
      const body = scrubSecrets(formatCallContent(result), secrets);
      if (result.isError) {
        telemetry(false, 'tool_error');
        return `[MCP · ${s.name} · ${tool.name} — the TOOL reported an error]\n${body}`;
      }
      telemetry(true, null);
      return `[MCP · ${s.name} · ${tool.name}]\n${body}`;
    } catch (err) {
      const e = err instanceof McpClientError ? err : toMcpClientError(err);
      conns.delete(s.id);
      // A JSON-RPC error on tools/call (unknown tool, invalid params) is the server ANSWERING — not a health failure.
      if (e.kind === 'rpc') {
        void recordCallOutcome(s, true);
        telemetry(false, 'rpc');
        return `[MCP · ${s.name} · ${tool.name} — the server rejected the call]\n${scrubSecrets(e.message, secrets)}`;
      }
      runFailures.set(s.id, (runFailures.get(s.id) ?? 0) + 1);
      void recordCallOutcome(s, false, scrubSecrets(e.message, secrets), e.kind as McpErrorClassLite);
      telemetry(false, e.kind);
      return `MCP SERVER UNAVAILABLE — "${s.name}" did not answer ${tool.name}: ${scrubSecrets(e.message, secrets)}. Do not retry this turn; tell the user if it matters and continue.`;
    }
  }

  const machine = opts.machine;
  return {
    schemas,
    names: new Set(map.keys()),
    doctrine: buildUserMcpDoctrine(doctrine, { machine, groupsHint: opts.groupsHint !== false }),
    statusLines,
    serverHints: [...new Set(hints.filter((h) => h.length >= 3))],
    toolCount: schemas.length,
    isReadOnly: (name: string) => { const e = map.get(name); return e ? e.tool.readOnly : undefined; },
    execute,
  };
}
