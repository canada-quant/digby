/**
 * CREDENTIAL PROXY — raw platform OAuth tokens never enter the session shell
 * (build 2026-10-08 ISO-3; the isolation.md deep dive, "credentials leave the
 * sandbox": Anthropic Managed Agents' git-remote + vault-proxy pattern, Codex's
 * "secrets are removed before the agent phase").
 *
 * Today every coding shell gets the user's REAL tokens as env vars on every
 * command: GITHUB_TOKEN / GH_TOKEN (GitHub OAuth tokens never expire), the
 * Google access token, the Slack user token, the Asana token — one
 * prompt-injected `env | curl …` away from exfiltration. With the switch on for
 * a user, a shell-capable run instead gets a short-lived, session-bound
 * CAPABILITY and git is pointed at Digby's proxy:
 *
 *   GIT_CONFIG  url.<base>/git/github.com/.insteadOf = https://github.com/
 *               http.<base>/.extraHeader              = X-Digby-Cap: <cap>
 *   env         DIGBY_CREDENTIAL_PROXY       = <base>          (for curl)
 *               DIGBY_CREDENTIAL_PROXY_TOKEN = <cap>
 *
 * `git fetch/pull/push https://github.com/o/r` then goes to
 * <base>/git/github.com/o/r/… — the backend verifies the capability (HMAC,
 * expiry, session alive and owned by that user), injects the user's real token
 * UPSTREAM and streams the smart-HTTP exchange through. REST calls go through
 * <base>/api/{github|google|slack|asana}/… the same way. The raw token never
 * reaches the sandbox; a stolen capability is bounded by its TTL, its session
 * (archive = revoke) and the proxy's route allowlist (git smart-HTTP to
 * github.com; the four provider API hosts — never arbitrary upstreams).
 *
 * Scope of THIS stage: the platform-managed OAuth tokens. User-managed
 * credentials (Settings / store_secret — AWS, Cloudflare, …) stay injected as
 * today (they are the user's explicit choice for the shell; AWS SigV4 cannot
 * be proxied by header injection) and are COUNTED in the telemetry.
 *
 * The gh CLI (build 2026-10-11 ISO-GH): proxy mode used to leave gh with no
 * token — 13 of the owner's last 37 lane runs used gh (pr / run / api / issue /
 * repo / workflow), the last blocker to the proxy for everyone. gh now goes
 * through the same proxy with NO raw token in the shell: a small KIT (a gh
 * wrapper, a git shim, a forwarder) is delivered in the env and materialized
 * by the run's shell prefix; gh's documented `http_unix_socket` config sends
 * every gh HTTP request in plaintext to the forwarder on a unix socket, gh
 * sends the run's CAPABILITY as its token, and the forwarder re-sends
 * api.github.com requests (REST + /graphql) to <base>/api/github/… with the
 * capability in X-Digby-Cap. See ghForwarderJs() for the routing rules and
 * ghGitShimSh() for why gh needs its own view of `git remote -v`.
 *
 * Switch CODING_CREDENTIAL_PROXY (off | 1 | comma-list of user ids / ≥8-char
 * prefixes — the canary). FAIL-TO-DIRECT: no https public base URL, no signing
 * key, or the proxy's own /health not answering from this process ⇒ today's
 * direct injection for that run, one telemetry row saying why.
 *
 * Base URL: FRONTEND_URL's first entry + /api/crossmodel/coding/cred-proxy
 * (prod nginx routes /api/* to the backend; sandboxes reach it over the
 * internet like any other HTTPS host). No new env var.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import type { Request, Response } from 'express';
import { userSwitchSetting, userSwitchAppliesTo } from './workspace-layout';

export const CREDENTIAL_PROXY_ENV = 'CODING_CREDENTIAL_PROXY';
export const CAP_HEADER = 'x-digby-cap';
/** Set by the gh forwarder (build 2026-10-11 ISO-GH) so a row can say the request came from gh. Never forwarded upstream. */
export const CLIENT_HEADER = 'x-digby-client';
export const PROXY_ROUTE_PREFIX = '/coding/cred-proxy';
const PROXY_PUBLIC_PATH = `/api/crossmodel${PROXY_ROUTE_PREFIX}`;
/** Capability lifetime — a run's credential env is gathered once per run (p90 run ≈ 200 min). */
export const CAP_TTL_MS = 12 * 3600 * 1000;
const CAP_PREFIX = 'dcp1';

/** The platform-managed raw credentials the proxy replaces (the "0 raw credentials" bar counts these). */
export const PLATFORM_RAW_CRED_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_ACCESS_TOKEN', 'SLACK_TOKEN', 'SLACK_USER_TOKEN', 'ASANA_ACCESS_TOKEN'] as const;
/** The gh kit's env keys (build 2026-10-11 ISO-GH) — static code + a path, never a secret. */
export const GH_KIT_ENV_KEYS = ['DIGBY_GH_KIT_DIR', 'DIGBY_GH_KIT_GH', 'DIGBY_GH_KIT_GIT', 'DIGBY_GH_KIT_FW'] as const;
/** Proxy-mode env keys whose values are NOT secrets (kept out of the shell-output scrubber). */
const PROXY_NON_SECRET_KEYS = new Set<string>(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_TERMINAL_PROMPT', 'DIGBY_CREDENTIAL_PROXY', 'DIGBY_CREDENTIAL_PROXY_APIS', ...GH_KIT_ENV_KEYS]);

export function credentialProxyEnabledFor(userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return userSwitchAppliesTo(CREDENTIAL_PROXY_ENV, userId, env);
}
export function credentialProxySwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return userSwitchSetting(CREDENTIAL_PROXY_ENV, env).mode !== 'off';
}

/** `https://<host>/api/crossmodel/coding/cred-proxy` from FRONTEND_URL[0], or null (not https / unset). Pure. */
export function credentialProxyBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const first = String(env.FRONTEND_URL ?? '').split(',')[0].trim();
  if (!first) return null;
  try {
    const u = new URL(first);
    if (u.protocol !== 'https:') return null;
    return `${u.origin}${PROXY_PUBLIC_PATH}`;
  } catch { return null; }
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface CapabilityClaims { sessionId: string; userId: string; githubLabel: string | null; exp: number }

/** HMAC key derived from JWT_SECRET (no new deployment secret — same pattern as credentials.service). */
function capKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = String(env.JWT_SECRET ?? '');
  if (secret.length < 16) return null;
  return createHmac('sha256', secret).update('digby-credential-proxy-v1').digest();
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Mint a session-bound capability (null when no signing key). Pure apart from env. */
export function mintCapability(c: { sessionId: string; userId: string; githubLabel?: string | null }, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const key = capKey(env);
  if (!key || !c.sessionId || !c.userId) return null;
  const payload = b64u(JSON.stringify({ s: c.sessionId, u: c.userId, l: c.githubLabel ?? null, e: now + CAP_TTL_MS }));
  const sig = b64u(createHmac('sha256', key).update(`${CAP_PREFIX}.${payload}`).digest());
  return `${CAP_PREFIX}.${payload}.${sig}`;
}

/** Verify a capability (signature, shape, expiry). null on ANY problem. */
export function verifyCapability(cap: string | null | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): CapabilityClaims | null {
  try {
    const key = capKey(env);
    if (!key || !cap) return null;
    const parts = String(cap).trim().split('.');
    if (parts.length !== 3 || parts[0] !== CAP_PREFIX) return null;
    const want = createHmac('sha256', key).update(`${CAP_PREFIX}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const j = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof j?.s !== 'string' || typeof j?.u !== 'string' || typeof j?.e !== 'number') return null;
    if (j.e <= now) return null;
    return { sessionId: j.s, userId: j.u, githubLabel: typeof j.l === 'string' ? j.l : null, exp: j.e };
  } catch { return null; }
}

// ── The shell env ────────────────────────────────────────────────────────────

/** The proxy-mode git/env block (replaces the raw platform tokens). Pure. */
export function buildProxyEnv(base: string, cap: string, apis: string[]): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${base}/git/github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_CONFIG_KEY_1: `http.${base}/.extraHeader`,
    GIT_CONFIG_VALUE_1: `X-Digby-Cap: ${cap}`,
    GIT_TERMINAL_PROMPT: '0',
    DIGBY_CREDENTIAL_PROXY: base,
    DIGBY_CREDENTIAL_PROXY_TOKEN: cap,
    DIGBY_CREDENTIAL_PROXY_APIS: apis.join(','),
  };
}

/**
 * The values the shell-output scrubber must mask. Direct mode: every value ≥ 8
 * chars (today's rule, unchanged). Proxy mode: the same minus the NON-secret
 * proxy keys — masking `https://github.com/` or the proxy URL would mangle
 * ordinary git output; the capability itself stays masked.
 */
export function credentialScrubValues(env: Record<string, string>): string[] {
  const proxy = typeof env.DIGBY_CREDENTIAL_PROXY_TOKEN === 'string';
  return Object.entries(env)
    .filter(([k, v]) => typeof v === 'string' && v.length >= 8 && !(proxy && PROXY_NON_SECRET_KEYS.has(k)))
    .map(([, v]) => v);
}

/** Count the platform raw credentials present in a shell env (the deciding metric's numerator). Pure. */
export function countRawPlatformCreds(env: Record<string, string>): number {
  return PLATFORM_RAW_CRED_KEYS.filter((k) => typeof env[k] === 'string' && env[k].length > 0).length;
}

// ── Reachability (fail-to-direct) ────────────────────────────────────────────

const reachMemo = new Map<string, { at: number; ok: boolean }>();
const REACH_TTL_MS = 5 * 60_000;
/** Test seam. */
export function __resetCredentialProxyMemoForTest(): void { reachMemo.clear(); }

/** Does the proxy answer at `<base>/health` from this process? (5-min memo, 3 s timeout.) Never throws. */
export async function credentialProxyReachable(base: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const hit = reachMemo.get(base);
  if (hit && Date.now() - hit.at < REACH_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    try {
      const r = await fetchImpl(`${base}/health`, { signal: ctrl.signal });
      ok = r.ok && /"credentialProxy"\s*:\s*true/.test(await r.text());
    } finally { clearTimeout(t); }
  } catch { ok = false; }
  reachMemo.set(base, { at: Date.now(), ok });
  return ok;
}

export type ProxyEnvDecision =
  | { mode: 'proxy'; base: string; cap: string }
  | { mode: 'direct'; reason: string }
  | { mode: 'fail_to_direct'; reason: string };

/**
 * Should THIS run's shell get the proxy env? direct when the switch does not
 * apply; fail_to_direct (with the reason) when it applies but the proxy cannot
 * serve this run. Never throws.
 */
export async function decideProxyEnv(
  a: { userId: string; sessionId: string; githubLabel?: string | null },
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<ProxyEnvDecision> {
  const env = deps.env ?? process.env;
  if (!credentialProxyEnabledFor(a.userId, env)) return { mode: 'direct', reason: 'switch' };
  const base = credentialProxyBaseUrl(env);
  if (!base) return { mode: 'fail_to_direct', reason: 'no_https_base_url' };
  const cap = mintCapability({ sessionId: a.sessionId, userId: a.userId, githubLabel: a.githubLabel ?? null }, Date.now(), env);
  if (!cap) return { mode: 'fail_to_direct', reason: 'no_signing_key' };
  if (!(await credentialProxyReachable(base, deps.fetchImpl))) return { mode: 'fail_to_direct', reason: 'proxy_unreachable' };
  return { mode: 'proxy', base, cap };
}

/** Telemetry: one `credential_proxy` row. Never throws. */
export function recordCredentialProxyMetric(meta: Record<string, unknown>, sessionId?: string): void {
  void import('../platform/loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.CREDENTIAL_PROXY, sessionId, meta }))
    .catch(() => {});
}

// ── The proxy endpoint ───────────────────────────────────────────────────────

export type ProxyProvider = 'github' | 'google' | 'slack' | 'asana';

export interface ProxyDeps {
  fetchImpl: typeof fetch;
  /** the session row the capability names (null = gone) */
  loadSession: (sessionId: string) => Promise<{ userId: string; status: string } | null>;
  /** the user's raw token for a provider (null = not connected) */
  tokenFor: (provider: ProxyProvider, userId: string, githubLabel: string | null) => Promise<string | null>;
  record: (meta: Record<string, unknown>, sessionId?: string) => void;
}

async function defaultLoadSession(sessionId: string): Promise<{ userId: string; status: string } | null> {
  const prisma = (await import('../../../config/database')).default as any;
  const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true, status: true } });
  return row ? { userId: row.userId, status: row.status } : null;
}

async function defaultTokenFor(provider: ProxyProvider, userId: string, githubLabel: string | null): Promise<string | null> {
  if (provider === 'github') return (await import('../github/token-manager')).getValidToken(userId, githubLabel || undefined);
  if (provider === 'google') return (await import('../google/token-manager')).getValidToken(userId);
  if (provider === 'slack') return (await import('../slack/token-manager')).getValidToken(userId);
  return (await import('../asana/token-manager')).getValidToken(userId);
}

const defaultDeps = (): ProxyDeps => ({
  fetchImpl: fetch,
  loadSession: defaultLoadSession,
  tokenFor: defaultTokenFor,
  record: recordCredentialProxyMetric,
});

/** git smart-HTTP paths the proxy forwards — nothing else on github.com. */
const GIT_PATH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
const GOOGLE_HOST_RE = /^[a-z0-9-]+\.googleapis\.com$/;
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'cookie', CAP_HEADER, CLIENT_HEADER, 'x-real-ip', 'content-length', 'accept-encoding', 'origin', 'referer', 'forwarded']);
const RESP_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'content-length']);

function splatParts(req: Request): string[] {
  const raw = (req.params as any)?.splat;
  const arr: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('/') : [];
  return arr.map((s) => String(s)).filter((s) => s.length > 0);
}

/** Re-encode a decoded path segment (keeps the `:` / `@` / `,` Google + GitHub paths use). */
function encSeg(s: string): string {
  return encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@').replace(/%2C/gi, ',');
}

function searchOf(req: Request): string {
  const u = String(req.originalUrl || req.url || '');
  const i = u.indexOf('?');
  return i >= 0 ? u.slice(i) : '';
}

/**
 * Resolve the upstream for a proxied request, or an error. Pure (exported for tests).
 *   git → https://github.com/<owner>/<repo>[.git]/(info/refs|git-upload-pack|git-receive-pack)
 *   api → api.github.com | <x>.googleapis.com | slack.com/api | app.asana.com/api/1.0
 */
export function resolveUpstream(kind: 'git' | 'api', provider: string | undefined, parts: string[], search: string):
  { url: string; provider: ProxyProvider; op: 'info_refs' | 'fetch' | 'push' | 'api' | 'graphql'; auth: 'basic' | 'bearer' } | { error: string } {
  if (parts.some((p) => p === '.' || p === '..' || p.includes('\\'))) return { error: 'bad path' };
  if (kind === 'git') {
    if (parts[0] !== 'github.com') return { error: 'only github.com is proxied for git' };
    const rest = parts.slice(1).join('/');
    if (!GIT_PATH_RE.test(rest)) return { error: 'only git smart-HTTP paths are proxied' };
    const op = rest.endsWith('/git-receive-pack') ? 'push' : rest.endsWith('/git-upload-pack') ? 'fetch' : 'info_refs';
    if (op === 'info_refs' && !/[?&]service=git-(?:upload|receive)-pack(?:&|$)/.test(search)) return { error: 'info/refs needs ?service=' };
    return { url: `https://github.com/${parts.slice(1).map(encSeg).join('/')}${search}`, provider: 'github', op, auth: 'basic' };
  }
  const tail = (from: number) => parts.slice(from).map(encSeg).join('/');
  switch (provider) {
    // build 2026-10-11 ISO-GH: api.github.com/graphql is its own op in the telemetry (gh's pr / issue / repo commands are GraphQL).
    case 'github': return { url: `https://api.github.com/${tail(0)}${search}`, provider: 'github', op: parts.length === 1 && parts[0] === 'graphql' ? 'graphql' : 'api', auth: 'bearer' };
    case 'google':
      if (!GOOGLE_HOST_RE.test(parts[0] || '')) return { error: 'google API host must be <service>.googleapis.com' };
      return { url: `https://${parts[0]}/${tail(1)}${search}`, provider: 'google', op: 'api', auth: 'bearer' };
    case 'slack': return { url: `https://slack.com/api/${tail(0)}${search}`, provider: 'slack', op: 'api', auth: 'bearer' };
    case 'asana': return { url: `https://app.asana.com/api/1.0/${tail(0)}${search}`, provider: 'asana', op: 'api', auth: 'bearer' };
    default: return { error: 'unknown provider (github | google | slack | asana)' };
  }
}

/** 'gh' when the gh forwarder sent the request (its tag header, else gh's own User-Agent). */
function clientOf(req: Request): 'gh' | null {
  const tag = req.headers[CLIENT_HEADER];
  if (String(Array.isArray(tag) ? tag[0] : tag ?? '').trim().toLowerCase() === 'gh') return 'gh';
  return /^GitHub CLI\b/.test(String(req.headers['user-agent'] || '')) ? 'gh' : null;
}

function capFrom(req: Request): string | null {
  const h = req.headers[CAP_HEADER];
  const v = Array.isArray(h) ? h[0] : h;
  if (v) return String(v).trim();
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(dcp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

/** The request body to forward: re-serialized when express already parsed it, else streamed. */
function bodyFor(req: Request): { body?: any; duplex?: 'half' } {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return {};
  // body-parser v2 (express 5) leaves no `_body` flag — a stream it already
  // read is simply ENDED; git's pack bodies (application/x-git-*) never are.
  if ((req as any)._body === true || req.readableEnded) {
    const ct = String(req.headers['content-type'] || '');
    if (/application\/x-www-form-urlencoded/i.test(ct)) return { body: new URLSearchParams(req.body as any).toString() };
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return { body: req.body };
    return { body: JSON.stringify(req.body ?? {}) };
  }
  return { body: Readable.toWeb(req) as any, duplex: 'half' };
}

/**
 * The proxy handler (express). Uniform 401 for every capability problem; 403
 * when the provider is not connected; 400 for a path outside the allowlist;
 * 502 when the upstream cannot be reached. Telemetry: one `credential_proxy`
 * request row per pack op / API call / failure (a successful info/refs is the
 * pack op's preamble — not counted twice).
 */
export async function handleCredentialProxy(kind: 'git' | 'api', req: Request, res: Response, deps: ProxyDeps = defaultDeps()): Promise<void> {
  const t0 = Date.now();
  const claims = verifyCapability(capFrom(req));
  if (!claims) { res.status(401).json({ error: 'invalid or expired Digby credential-proxy capability' }); return; }
  const session = await deps.loadSession(claims.sessionId).catch(() => null);
  if (!session || session.userId !== claims.userId || session.status === 'archived') {
    res.status(401).json({ error: 'invalid or expired Digby credential-proxy capability' });
    return;
  }
  const up = resolveUpstream(kind, (req.params as any)?.provider, splatParts(req), searchOf(req));
  // build 2026-10-11 ISO-GH: the gh forwarder tags its requests — rows say `client: 'gh'`.
  const client = clientOf(req);
  const tag = client ? { client } : {};
  if ('error' in up) {
    deps.record({ phase: 'request', kind, op: 'refused', status: 400, ok: false, reason: up.error, ...tag }, claims.sessionId);
    res.status(400).json({ error: up.error });
    return;
  }
  const token = await deps.tokenFor(up.provider, claims.userId, claims.githubLabel).catch(() => null);
  // ISO canary fix (2026-10-09): git to github.com with no connected account goes upstream
  // ANONYMOUSLY — what direct mode does (no token in the shell, git fetches a public repo; GitHub
  // itself refuses a private one). The prod canary's first fetch (test account, public repo) 403'd
  // here. REST calls and the other providers keep the 403. Sandbox auth headers are never forwarded
  // (HOP_BY_HOP drops authorization + the capability header). Kill switch
  // CREDENTIAL_PROXY_ANON_GIT_DISABLED=1 restores the 403.
  const anonymousGit = !token && kind === 'git' && up.provider === 'github' && process.env.CREDENTIAL_PROXY_ANON_GIT_DISABLED !== '1';
  if (!token && !anonymousGit) {
    deps.record({ phase: 'request', provider: up.provider, op: up.op, status: 403, ok: false, reason: 'not_connected', ...tag }, claims.sessionId);
    res.status(403).json({ error: `no ${up.provider} account is connected for this user — connect it in Account → Integrations` });
    return;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith('x-forwarded-') || v === undefined) continue;
    headers[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  headers['accept-encoding'] = 'identity';
  if (token) {
    headers.authorization = up.auth === 'basic'
      ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
      : `Bearer ${token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), up.op === 'api' || up.op === 'graphql' ? 120_000 : 600_000);
  // The CLIENT went away mid-exchange → stop the upstream too. (res 'close',
  // not req 'close': an IncomingMessage closes once its body is consumed.)
  const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
  res.on('close', onClose);
  let done = false;
  const finish = (status: number, extra: Record<string, unknown> = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    res.off('close', onClose);
    const ok = status > 0 && status < 400;
    if (up.op !== 'info_refs' || !ok) {
      deps.record({ phase: 'request', provider: up.provider, op: up.op, status, ok, ms: Date.now() - t0, ...(anonymousGit ? { anonymous: true } : {}), ...tag, ...extra }, claims.sessionId);
    }
  };
  let upstream: globalThis.Response;
  try {
    upstream = await deps.fetchImpl(up.url, { method: req.method, headers, redirect: 'manual', signal: ctrl.signal, ...bodyFor(req) } as any);
  } catch (err: any) {
    finish(502, { reason: String(err?.name === 'AbortError' ? 'timeout_or_client_gone' : 'upstream_unreachable') });
    if (!res.headersSent) res.status(502).json({ error: 'upstream unreachable through the Digby credential proxy' });
    return;
  }
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => { if (!RESP_DROP.has(key.toLowerCase())) res.setHeader(key, value); });
  if (!upstream.body || req.method === 'HEAD') { res.end(); finish(upstream.status); return; }
  const stream = Readable.fromWeb(upstream.body as any);
  stream.on('error', () => { finish(upstream.status, { reason: 'stream_error' }); res.destroy(); });
  stream.on('end', () => finish(upstream.status));
  stream.pipe(res);
}

/** GET <prefix>/health — the fail-to-direct probe target (no capability, no secrets). */
export function credentialProxyHealth(_req: Request, res: Response): void {
  res.json({ ok: true, credentialProxy: true });
}

// ── gh through the proxy (build 2026-10-11 ISO-GH) ───────────────────────────
//
// gh has no token in proxy mode, and gh resolves its repository from git
// remotes — which the url.insteadOf rewrite shows as the proxy URL. The KIT
// below fixes both without a raw token in the shell, a new host, DNS or TLS:
//
//   <kit>/gh          sh wrapper, first on PATH (the shell prefix puts it there).
//                     Proxy mode and no GitHub credential of the lane's own
//                     (GH_TOKEN / GITHUB_TOKEN / GH_HOST / GH_CONFIG_DIR) → starts
//                     the forwarder if it is not running, then runs the REAL gh
//                     with GH_CONFIG_DIR=<kit>/config (config.yml:
//                     http_unix_socket: <kit>/fw.sock), GH_TOKEN=<the run's
//                     capability> and <kit>/git first on PATH. Anything else →
//                     the real gh untouched.
//   <kit>/git/git     git shim gh's own git calls see: `git remote -v` runs
//                     without the env-injected git config (so gh sees
//                     https://github.com/<o>/<r> and resolves the repo); every
//                     other git command — fetch / push included — is the real
//                     git with the proxy rewrite intact.
//   <kit>/fw.js       node forwarder on <kit>/fw.sock (one per container, holds
//                     no secret: the capability rides each request as gh's token).
//
// gh's http_unix_socket dials the socket for http AND https URLs and speaks
// plain HTTP/1.1 with the original Host header, so the forwarder sees
// `Host: api.github.com` + `Authorization: token dcp1…`. Delivery: the files
// ride the run's credential env (DIGBY_GH_KIT_*; non-secret) and the shell
// prefix writes them under /tmp/digby-proc (container-local, kept by the
// disk-pressure /tmp wipe) the first time, then unsets the env copies. One
// versioned directory per kit content + base, so a deploy never runs a stale
// wrapper. Switch: CREDENTIAL_PROXY_GH_DISABLED=1 → no kit (gh unauthenticated
// in proxy mode, the pre-ISO-GH behaviour).

/** Where the kit is materialized inside the sandbox (container-local /tmp; /tmp/digby-proc survives the pressure wipe). */
export const GH_KIT_ROOT = '/tmp/digby-proc/gh-proxy';

/** Is the gh kit on? (The credential proxy itself is CODING_CREDENTIAL_PROXY.) */
export function ghKitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREDENTIAL_PROXY_GH_DISABLED !== '1';
}

/**
 * The forwarder (node, core modules only). gh → unix socket → here:
 *   Host api.github.com + capability token → <base>/api/github<path> with
 *     X-Digby-Cap (REST and /graphql alike — the proxy's github allowlist);
 *   Host uploads.github.com + capability → 501 (not on the proxy allowlist);
 *   any other host (redirect targets: run logs, release assets — gh never
 *     sends its token across a host change) → that host directly over HTTPS,
 *     a capability-shaped Authorization stripped.
 * The capability is never sent anywhere but the Digby proxy. Single instance
 * per socket (a live one answers the connect probe → the newcomer exits);
 * exits after 15 idle minutes; `module.exports = { route }` for the tests.
 * STYLE: embedded in String.raw — no backticks, no dollar-brace.
 */
export function ghForwarderJs(): string {
  return String.raw`'use strict';
// build 2026-10-11 ISO-GH — the Digby credential-proxy forwarder for the gh CLI. GENERATED by the
// Digby backend (credential-proxy.ts ghForwarderJs). No secret lives in this file or this process:
// gh sends the run's session capability as its token, so every request carries its own.
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');

const CAP_RE = /^(?:token|bearer)\s+(dcp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host']);

function headersWithout(h, drop) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    const l = k.toLowerCase();
    if (HOP.has(l) || (drop && drop.indexOf(l) >= 0)) continue;
    out[l] = h[k];
  }
  return out;
}

/** Where one gh request goes. Pure. */
function route(base, host, url, headers) {
  const rawHost = String(host || '').trim().toLowerCase();
  const h = rawHost.replace(/:\d+$/, '');
  const m = CAP_RE.exec(String((headers && headers.authorization) || ''));
  const u = String(url || '/');
  const path = u.charAt(0) === '/' ? u : '/' + u;
  if (h === 'api.github.com' && m) {
    const out = headersWithout(headers, ['authorization']);
    out['x-digby-cap'] = m[1];
    out['x-digby-client'] = 'gh';
    return { kind: 'proxy', url: String(base).replace(/\/+$/, '') + '/api/github' + path, headers: out };
  }
  if (h === 'uploads.github.com' && m) {
    return { kind: 'refuse', status: 501, message: 'uploads.github.com (release asset uploads) is not available through the Digby credential proxy - publish with the git_push / open_pull_request tools, or attach assets outside the sandbox' };
  }
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return { kind: 'refuse', status: 400, message: 'bad Host header' };
  return { kind: 'direct', url: 'https://' + rawHost + path, headers: headersWithout(headers, m ? ['authorization'] : []) };
}

function reply(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: message }));
}

function main(sock, pidFile, base) {
  // A unix socket path is capped at 108 bytes; past it some libuv builds bind a TRUNCATED path the
  // wrapper never finds. The kit's own path is 43 bytes — refuse anything near the cap loudly.
  if (!sock || Buffer.byteLength(sock) > 100) { process.stderr.write('digby gh forwarder: socket path too long\n'); process.exit(1); }
  const idleMs = Number(process.env.DIGBY_GH_FW_IDLE_MS) > 0 ? Number(process.env.DIGBY_GH_FW_IDLE_MS) : 15 * 60 * 1000;
  let inflight = 0;
  let last = Date.now();
  const server = http.createServer(function (req, res) {
    inflight += 1; last = Date.now();
    let counted = true;
    res.on('close', function () { if (counted) { counted = false; inflight -= 1; last = Date.now(); } });
    const r = route(base, req.headers.host, req.url, req.headers);
    if (r.kind === 'refuse') { req.resume(); reply(res, r.status, r.message); return; }
    let target;
    try { target = new URL(r.url); } catch (e) { req.resume(); reply(res, 400, 'bad request URL'); return; }
    const mod = target.protocol === 'http:' ? http : https;
    const up = mod.request(target, { method: req.method, headers: r.headers }, function (ur) {
      res.writeHead(ur.statusCode || 502, headersWithout(ur.headers, []));
      ur.on('error', function () { res.destroy(); });
      ur.pipe(res);
    });
    up.setTimeout(10 * 60 * 1000, function () { up.destroy(new Error('timeout')); });
    up.on('error', function (e) {
      const code = (e && (e.code || e.message)) || 'error';
      process.stderr.write('digby gh forwarder: ' + r.kind + ' request failed: ' + code + '\n');
      reply(res, 502, r.kind === 'proxy' ? 'the Digby credential proxy could not be reached from this sandbox (' + code + ')' : 'upstream unreachable (' + code + ')');
    });
    req.on('error', function () { up.destroy(); });
    req.pipe(up);
  });
  const shutdown = function () {
    try {
      if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) { fs.unlinkSync(pidFile); fs.unlinkSync(sock); }
    } catch (e) { /* not ours any more */ }
    process.exit(0);
  };
  server.on('error', function (e) { process.stderr.write('digby gh forwarder: cannot listen (' + ((e && e.code) || 'error') + ')\n'); process.exit(1); });
  const probe = net.connect(sock);
  probe.on('connect', function () { probe.destroy(); process.exit(0); }); // a live forwarder already owns the socket
  probe.on('error', function () {
    try { fs.unlinkSync(sock); } catch (e) { /* no stale socket */ }
    server.listen(sock, function () {
      try { fs.chmodSync(sock, 0o600); } catch (e) { /* best effort */ }
      fs.writeFileSync(pidFile, String(process.pid));
    });
  });
  setInterval(function () { if (inflight <= 0 && Date.now() - last > idleMs) shutdown(); }, Math.min(30000, idleMs)).unref();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', function () { /* detached: ignore the exec session ending */ });
}

if (require.main === module) main(process.argv[2], process.argv[3], process.argv[4]);
else module.exports = { route: route, headersWithout: headersWithout };
`;
}

/**
 * The gh wrapper (POSIX sh — gh is run from bash, sh, make and node alike).
 * The lane's OWN GitHub setup always wins: GH_TOKEN / GITHUB_TOKEN /
 * GH_ENTERPRISE_TOKEN / GH_HOST / GH_CONFIG_DIR set, or no capability in the
 * env (direct mode / fail-to-direct) ⇒ the real gh, untouched. A forwarder
 * that cannot start (no node) ⇒ the real gh unauthenticated, with one stderr
 * line — today's proxy-mode behaviour, never worse.
 * STYLE: embedded in String.raw — no backticks, no dollar-brace.
 */
export function ghWrapperSh(): string {
  return String.raw`#!/bin/sh
# build 2026-10-11 ISO-GH — gh through the Digby credential proxy. GENERATED by the Digby backend
# (credential-proxy.ts ghWrapperSh); no secret in this file.
k=$(dirname -- "$0")
r=
o=$IFS; IFS=:
for p in $PATH; do
  [ "$p" = "$k" ] && continue
  if [ -n "$p" ] && [ -x "$p/gh" ] && [ ! -d "$p/gh" ]; then r=$p/gh; break; fi
done
IFS=$o
if [ -z "$r" ]; then echo "gh: the GitHub CLI is not installed in this sandbox" >&2; exit 127; fi
c=$DIGBY_CREDENTIAL_PROXY_TOKEN
b=$DIGBY_CREDENTIAL_PROXY
if [ -z "$c" ] || [ -z "$b" ] || [ -n "$GH_TOKEN$GITHUB_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_ENTERPRISE_TOKEN$GH_HOST$GH_CONFIG_DIR" ]; then exec "$r" "$@"; fi
s=$k/fw.sock
alive() {
  q=$(cat "$k/fw.pid" 2>/dev/null) || return 1
  [ -n "$q" ] && [ -S "$s" ] || return 1
  if [ -r "/proc/$q/cmdline" ]; then grep -q fw.js "/proc/$q/cmdline" 2>/dev/null; else kill -0 "$q" 2>/dev/null; fi
}
if ! alive && command -v node >/dev/null 2>&1; then
  if command -v setsid >/dev/null 2>&1; then S=setsid; else S=; fi
  ( cd / && $S node "$k/fw.js" "$s" "$k/fw.pid" "$b" </dev/null >>"$k/fw.log" 2>&1 & )
  i=0
  while [ "$i" -lt 60 ] && ! alive; do sleep 0.05 2>/dev/null || sleep 1; i=$((i+1)); done
fi
if alive; then
  GH_CONFIG_DIR=$k/config
  GH_TOKEN=$c
  PATH=$k/git:$PATH
  export GH_CONFIG_DIR GH_TOKEN PATH
  exec "$r" "$@"
fi
echo "gh: the Digby credential-proxy forwarder did not start (see $k/fw.log) - gh runs unauthenticated" >&2
exec "$r" "$@"
`;
}

/**
 * The git shim gh sees. gh resolves the repository from `git remote -v`, and
 * git prints remote URLs AFTER url.insteadOf — in proxy mode that is
 * https://<digby>/api/crossmodel/coding/cred-proxy/git/github.com/<o>/<r>,
 * which gh cannot parse ("none of the git remotes … point to a known GitHub
 * host"). That one listing runs without the env-injected git config; every
 * other command (gh pr checkout's fetch, gh pr create's push) keeps it.
 * STYLE: embedded in String.raw — no backticks, no dollar-brace.
 */
export function ghGitShimSh(): string {
  return String.raw`#!/bin/sh
# build 2026-10-11 ISO-GH — git as the gh CLI sees it. GENERATED by the Digby backend
# (credential-proxy.ts ghGitShimSh): only "git remote -v" runs without the credential proxy's
# env-injected git config (so gh reads https://github.com/<owner>/<repo>); everything else is real git.
d=$(dirname -- "$0")
r=
o=$IFS; IFS=:
for p in $PATH; do
  [ "$p" = "$d" ] && continue
  if [ -n "$p" ] && [ -x "$p/git" ] && [ ! -d "$p/git" ]; then r=$p/git; break; fi
done
IFS=$o
if [ -z "$r" ]; then echo "git: not found" >&2; exit 127; fi
if [ "$#" -eq 2 ] && [ "$1" = remote ] && [ "$2" = -v ]; then exec env -u GIT_CONFIG_COUNT "$r" remote -v; fi
exec "$r" "$@"
`;
}

/** Version of a kit: its three files + the base it forwards to (a new deploy or base ⇒ a new directory). Pure. */
export function ghKitVersion(base: string): string {
  return createHash('sha256').update(`${ghForwarderJs()}\0${ghWrapperSh()}\0${ghGitShimSh()}\0${base}`).digest('hex').slice(0, 12);
}

/** The kit's env block for a proxy-mode shell (non-secret: code + a path). Pure. */
export function buildGhKitEnv(base: string, root: string = GH_KIT_ROOT): Record<string, string> {
  return {
    DIGBY_GH_KIT_DIR: `${root.replace(/\/+$/, '')}/${ghKitVersion(base)}`,
    DIGBY_GH_KIT_GH: ghWrapperSh(),
    DIGBY_GH_KIT_GIT: ghGitShimSh(),
    DIGBY_GH_KIT_FW: ghForwarderJs(),
  };
}

/**
 * The shell-prefix fragment that materializes the kit (once per container +
 * kit version, atomic tmp+mv writes, the wrapper last as the "complete" mark),
 * puts <kit> first on PATH and unsets the env copies before the user command.
 * '' when the env carries no kit — the prefix is then byte-identical. Never
 * fails the command (every step is guarded; the function always returns 0).
 */
export function ghProxyShellPrefix(env: Record<string, string> | null | undefined): string {
  if (!env || typeof env.DIGBY_GH_KIT_DIR !== 'string' || !env.DIGBY_GH_KIT_DIR) return '';
  return [
    '__digby_gh_kit() {',
    ' local k="${DIGBY_GH_KIT_DIR:-}";',
    ' [ -n "$k" ] || return 0;',
    ' if [ ! -x "$k/gh" ]; then (',
    ' umask 077 && mkdir -p "$k/git" "$k/config"',
    ' && printf \'%s\' "$DIGBY_GH_KIT_FW" > "$k/.fw.$$" && mv -f "$k/.fw.$$" "$k/fw.js"',
    ' && printf \'version: "1"\\ngit_protocol: https\\nhttp_unix_socket: %s\\n\' "$k/fw.sock" > "$k/config/.c.$$" && mv -f "$k/config/.c.$$" "$k/config/config.yml"',
    ' && printf \'%s\' "$DIGBY_GH_KIT_GIT" > "$k/git/.g.$$" && chmod 700 "$k/git/.g.$$" && mv -f "$k/git/.g.$$" "$k/git/git"',
    ' && printf \'%s\' "$DIGBY_GH_KIT_GH" > "$k/.gh.$$" && chmod 700 "$k/.gh.$$" && mv -f "$k/.gh.$$" "$k/gh"',
    ' ) >/dev/null 2>&1; fi;',
    ' [ -x "$k/gh" ] && export PATH="$k:$PATH";',
    ' return 0;',
    ' };',
    ' __digby_gh_kit; unset -f __digby_gh_kit; unset DIGBY_GH_KIT_DIR DIGBY_GH_KIT_GH DIGBY_GH_KIT_GIT DIGBY_GH_KIT_FW; ',
  ].join('');
}
