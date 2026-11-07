import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { errorHandler, notFound } from './middleware/error-handler';
import { authenticate } from './middleware/auth';
import { RedisRateLimitStore } from './middleware/redis-rate-limit-store';
import { openApiJsonRouter, apiDocsRouter } from './modules/openapi/api-docs';
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import aiChatRoutes from './modules/ai-chat/ai-chat.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';
import crossmodelRoutes from './modules/crossmodel/crossmodel.routes';
import crossmodelOpenRoutes from './modules/crossmodel/crossmodel-open.routes';
import publicShareRoutes from './modules/crossmodel/public-share.routes';
import projectsRoutes from './modules/crossmodel/projects.routes';
import childrenRoutes from './modules/crossmodel/children.routes';
import sharingRoutes from './modules/crossmodel/sharing.routes';
import documentsRoutes from './modules/crossmodel/documents.routes';
import generatedFilesRoutes from './modules/crossmodel/generated-files.routes';
import chatFilesRoutes from './modules/crossmodel/chat-files.routes';
import generatedFilesPublicRoutes from './modules/crossmodel/generated-files-public.routes';
import canvasRoutes from './modules/crossmodel/canvas.routes';
import codingRoutes from './modules/crossmodel/coding/coding.routes';
import codingPublicRoutes from './modules/crossmodel/coding/coding-public.routes';
import platformRoutes from './modules/crossmodel/platform/platform.routes';
import fleetRoutes from './modules/crossmodel/fleet/fleet.routes';
import modelEndpointsRoutes from './modules/crossmodel/model-endpoints/model-endpoints.routes';
import { listActiveRunIds } from './modules/crossmodel/coding/live-runs';
import { buildRevision } from './modules/crossmodel/platform/build-revision';
import { isProdInstance } from './modules/crossmodel/platform/instance-targets';
import logger from './utils/logger';
import { isRetiring, markRetiring, retiringSinceIso } from './modules/crossmodel/coding/retiring';
import { buildDrainStatus } from './modules/crossmodel/chat-agent/drain-status';
import instancesRoutes, { instancesOpenRoutes } from './modules/crossmodel/instances/instances.routes';
import cloudLinkRoutes from './modules/crossmodel/cloud-link/cloud-link.routes';
import { webhookAuthedRoutes } from './modules/crossmodel/webhook.routes';
import { pushRoutes } from './modules/crossmodel/push/push.routes';
import { reportsRoutes } from './modules/crossmodel/reports/reports.routes';
import { WEBHOOK_FIRE_PATH_RE, webhookFireLimiterKey } from './modules/crossmodel/webhook.service';
import { CLOUD_LINK_RECEIVE_PATH_RE, cloudLinkReceiveLimiterKey } from './modules/crossmodel/cloud-link/cloud-link.service';
import { INSTANCE_PAIR_PATH_RE } from './modules/crossmodel/instances/instances.service';
import { visitorAdminRoutes } from './modules/crossmodel/visitors/visitor.routes';
import { orgAdminRoutes } from './modules/crossmodel/org/org-admin.routes';
import { orgMembersRoutes } from './modules/crossmodel/org/org-members.routes';
import { brandingPackPublicRoutes, brandingPackAdminRoutes } from './modules/crossmodel/branding/branding-pack.routes';
import { clientIpForHash } from './modules/crossmodel/visitors/visitor.service';
import { hashIp } from './modules/crossmodel/visitors/ip-hash';
import { streamLimiterSkip, uploadLimiterSkip, guestStreamAttachLimiterSkip, guestStreamAttachLimiterKey } from './middleware/rate-limit-paths';
import { API_PREFIXES, mountApi } from './api-prefixes';
import { env } from './config/env';
import prisma from './config/database';
import redisClient from './config/redis';
import { configurePasswordChangeCutoffStore } from './modules/auth/password-change-cutoff';

const app: Express = express();

// Change-password (2026-10-12): the auth middlewares reject access tokens
// issued before a user's last password change. The cutoff lives in the shared
// Redis; injected here so the middleware never imports config/redis itself.
configurePasswordChangeCutoffStore(redisClient);

// Trust Cloudflare Tunnel proxy — allows correct IP from X-Forwarded-For
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// and blocks ALL requests reaching the backend through Cloudflare.
app.set('trust proxy', 1);
// Express 5 flips the default query parser from 'extended' (qs) to 'simple'
// (node:querystring — no nested/array params). Pin 'extended' to preserve the
// Express 4 parsing behavior exactly across every route.
app.set('query parser', 'extended');

// Middleware
app.use(helmet());
// Support comma-separated origins in FRONTEND_URL for multiple access points
const corsOrigins = env.NODE_ENV === 'production'
  ? (process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
      : ['http://localhost:8247'])
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8247'];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
// 75 MB: fits the largest allowed upload (50 MB file → ~67 MB base64 in the JSON
// body) with headroom, while capping the in-memory body an anonymous caller can
// force us to buffer (was 300 MB — a memory-DoS vector). All text endpoints are
// KB-scale. (2026-07-21 pre-launch audit)
app.use(express.json({ limit: '75mb' }));
app.use(express.urlencoded({ extended: true, limit: '75mb' }));
// Express 5 / body-parser 2: req.body is UNDEFINED (not {}) when no parser
// matched. ~25 handlers destructure req.body unguarded and would TypeError→500
// on bodiless/wrong-content-type POSTs where Express 4 gave a clean 400.
// Restore the v4 invariant once, centrally.
app.use(((req, _res, next) => { req.body ??= {}; next(); }) as express.RequestHandler);
app.use(cookieParser());

// Health check helper — checks DB and Redis connectivity
const checkDbConnectivity = async (): Promise<'connected' | 'error'> => {
  try {
    const result = await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB timeout')), 3000)
      ),
    ]);
    return 'connected';
  } catch {
    return 'error';
  }
};

const checkRedisConnectivity = async (): Promise<'connected' | 'error'> => {
  try {
    await redisClient.ping();
    return 'connected';
  } catch {
    return 'error';
  }
};

const buildHealthResponse = async () => {
  const [dbStatus, redisStatus] = await Promise.all([
    checkDbConnectivity(),
    checkRedisConnectivity(),
  ]);
  const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';
  // inflightRuns (2026-09-11): detached CHAT runs (supervisor wakes, owner
  // questions, chat-surface lanes) live in THIS process and die with it — the
  // blue-green deploy reads this on the OLD color and waits for 0 before
  // stopping it (deploy-blue-green.sh drain). Registry read is synchronous.
  let inflightRuns = 0;
  try { inflightRuns = listActiveRunIds().length; } catch { /* health must never fail on the registry */ }
  return {
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    db: dbStatus,
    redis: redisStatus,
    uptime: process.uptime(),
    inflightRuns,
    // Source revision this container was BUILT from (ticket b37bf85f) — the
    // answer to "is this instance up to date?" without a host-side git read.
    // Read from DEPLOY_SHA, so the worker and relay containers (same image,
    // same build arg) report the identical value. null = this build carries no
    // revision (an unstamped local build), stated honestly rather than guessed.
    revision: buildRevision(),
    httpStatus: isHealthy ? 200 : 503,
  };
};

/**
 * The public health payload (ticket b37bf85f).
 *
 * `revision` — the commit this container was BUILT from — is the self-host
 * operator's answer to "is this instance up to date?", and it is reported on
 * NON-production instances only. Digby's public production endpoint keeps its
 * existing payload byte-for-byte: the production boxes' sha is already on the
 * authenticated fleet surfaces, and this endpoint is unauthenticated, so there
 * is nothing to gain by publishing it here and something to lose.
 */
const healthPayload = (health: Awaited<ReturnType<typeof buildHealthResponse>>) => ({
  status: health.status,
  timestamp: health.timestamp,
  db: health.db,
  redis: health.redis,
  uptime: health.uptime,
  inflightRuns: health.inflightRuns,
  ...(isProdInstance() ? {} : { revision: health.revision, apiPrefixes: API_PREFIXES }),
});

// Health check (both paths — /health for direct backend access, /api/health for frontend proxy)
app.get('/health', async (req, res) => {
  const health = await buildHealthResponse();
  res.status(health.httpStatus).json(healthPayload(health));
});
app.get('/api/health', async (req, res) => {
  const health = await buildHealthResponse();
  res.status(health.httpStatus).json(healthPayload(health));
});

// Drain status (feedback 56159c5a): the blue-green deploy script polls the OLD
// color's backend on its localhost-bound port during the post-flip drain
// window and waits (bounded) for its in-flight detached chat runs to finish
// before teardown. Unauthenticated like /health — the payload is a bare count
// and the container port publishes to 127.0.0.1 only (docker-compose.app.yml),
// never proxied by nginx. Counts only chat:* live-run keys: the web process
// owns detached chat runs (coding runs execute in the worker tier).
// `activeRuns` also counts in-flight LATE cross-check reconciles (2026-09-18):
// the run has already finished and released its slot, but the detached
// reconcile still has a message to revise — tearing the colour down mid-wait
// left rows `pendingCrossCheck: true` forever. Broken out as `chatRuns` /
// `lateCrossChecks` for the deploy log.
// WI-G (2026-09-25): the payload also carries PER-RUN detail — `runs[]` of
// {runId, chatId, startedAt, isSupervisorWake, lastToolAt, …} — and ONE
// aggregate the script can grep, `extensionEligible`: true only while this
// process is retiring AND every remaining chat run is a supervisor-class wake
// still making tool calls (chat-agent/drain-status.ts). The script's bounded
// one-time retiring-budget extension keys on that flag (default OFF there).
app.get('/drain-status', (req, res) => {
  res.json(buildDrainStatus());
});
// Retire (2026-09-18 — the deploy-replay tax, coding/retiring.ts): the deploy
// script POSTs here the moment the drain begins so this OLD colour stops
// STARTING machine-triggered chat runs (they park/queue for the new colour)
// and the drain can actually converge on the runs already in flight. Same
// posture as the GET above — localhost-bound container port, never proxied
// by nginx; idempotent; the flag is process-local and dies with the process.
app.post('/drain-status/retire', (req, res) => {
  const since = markRetiring();
  const chatRuns = listActiveRunIds().filter((k) => k.startsWith('chat:')).length;
  logger.info(`drain: this process is now RETIRING (since ${since.toISOString()}) — ${chatRuns} chat run(s) in flight will finish; no new machine runs start here`);
  res.json({ retiring: true, retiringSince: since.toISOString(), activeRuns: chatRuns });
});

// API Documentation — the GENERATED spec (scripts/generate-openapi.ts; drift
// guard: src/modules/openapi/openapi.test.ts). Public, route metadata only.
app.use('/api', openApiJsonRouter); // GET /api/openapi.json
app.use('/api-docs', apiDocsRouter); // Swagger UI (scoped CSP exception inside; dev/self-host)
app.use('/api/docs', apiDocsRouter); // same UI under /api/* so prod nginx routes it to the backend

// ── Rate Limiting ───────────────────────────────────────────────────────────
// All limiters count in shared Redis (RedisRateLimitStore, fail-open): the
// default MemoryStore is per-process, so blue+green doubled every limit and
// each deploy reset the counters — the auth brute-force guard included.
// The stream endpoint hits 4 paid AI APIs per request — protect against abuse
const streamRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 25,                   // 25 queries per 10 minutes per IP
  message: { error: 'Too many queries. Please wait a moment before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:stream:'),
  // Only apply to /stream. The old `?testBypass=true` escape was publicly
  // discoverable → anyone could bypass the limiter and abuse the paid AI APIs
  // (2026-07-21 pre-launch audit). Removed entirely. The matcher also covers
  // /stream/ and /STREAM, which the router routes to the same handler
  // (middleware/rate-limit-paths.ts, 2026-10-20 — an exact match was a bypass).
  skip: streamLimiterSkip,
});
mountApi(app, '', streamRateLimit);

// Upload rate limiting (memory-DoS protection). /upload is optionalAuthenticate
// (anonymous attachments are a supported UX) and buffers each file in memory,
// so an unauthenticated flood of large uploads could OOM the backend. Cap per-IP
// upload frequency; the multer fileSize limit caps each file's size. (2026-07-21)
const uploadRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30,                   // 30 uploads per 10 minutes per IP
  message: { error: 'Too many file uploads. Please wait a moment before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: uploadLimiterSkip, // /upload, /upload/ and /UPLOAD (middleware/rate-limit-paths.ts)
  store: new RedisRateLimitStore('rl:upload:'),
});
mountApi(app, '', uploadRateLimit);

// Guest stream reattach (stream drops, 2026-10-20): GET /session/:sessionId/stream
// is OPEN (an anonymous EventSource) and holds a long-lived response, so cap
// connects per CLIENT. A reconnecting tab backs off 1/2/4/8/16 s then every 15 s
// (≤ ~45 per 10 min); 300 leaves room for several guests behind one NAT after a
// deploy cut every stream at once. Path-scoped like the limiters above — the
// matcher covers the trailing-slash / letter-case forms the router also routes —
// and keyed on the hashed hops-anchored client ip (the visit-events rule), never
// req.ip: that is the ALB node, so every guest on a node shared one bucket and one
// client could drain it for all of them (review 2026-10-20). The GLOBAL ceiling
// bounds a rotating X-Forwarded-For where QUOTA_TRUSTED_PROXY_HOPS is unset.
const guestStreamAttachClientRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 300,                  // 300 reattaches per 10 minutes per client
  message: { error: 'Too many reconnects. Please wait a moment and reload.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => guestStreamAttachLimiterKey(req as any),
  skip: guestStreamAttachLimiterSkip,
  store: new RedisRateLimitStore('rl:gattach:'),
});
const guestStreamAttachGlobalRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20_000,               // all clients together
  message: { error: 'Too many reconnects. Please wait a moment and reload.' },
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => 'global',
  skip: guestStreamAttachLimiterSkip,
  store: new RedisRateLimitStore('rl:gattachall:'),
});
mountApi(app, '', guestStreamAttachClientRateLimit, guestStreamAttachGlobalRateLimit);

// Auth endpoint rate limiting (brute-force protection)
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 login/register attempts per 15 minutes
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:auth:'),
});
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/register', authRateLimit);
// Change-password re-auths with the current password: a stolen access token
// must not buy unlimited guesses at it (2026-10-12; same bucket per IP).
app.use('/api/auth/change-password', authRateLimit);

// Per-chat webhook fire rate limiting (2026-08-23): POST /webhooks/:chatId/fire
// is public (per-chat `dgw_` bearer token, not a session JWT) and every fire can
// start a paid AI run — cap per CHAT+IP (chatId parsed from the path; route
// params are not populated at this mount point) so one noisy monitor can't burn
// the owner's run budget and online token-guessing stays throttled per source.
// 30/5min leaves a 5-min health probe huge headroom. The skip predicate means
// the keyGenerator only ever sees fire paths.
const webhookFireRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,                  // 30 fires per 5 minutes per chat
  message: { error: 'Too many webhook fires for this chat — slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:webhook:'),
  // Key = chatId + caller IP (webhookFireLimiterKey, hardening round 2):
  // keying by chatId alone counted pre-auth 401s into ONE shared bucket, so
  // anyone who knew a chatId could lock out that chat's legitimate webhook.
  // The IP suffix keeps per-chat fairness per caller while an attacker only
  // exhausts their own bucket. WEBHOOK_FIRE_PATH_RE is case-insensitive +
  // tolerates a trailing slash so it covers exactly the paths Express's
  // default router also matches (see webhook.service.ts — an exact-match
  // regex here was a limiter bypass).
  keyGenerator: (req) => webhookFireLimiterKey(req.path, req.ip),
  skip: (req) => !WEBHOOK_FIRE_PATH_RE.test(req.path),
});
mountApi(app, '', webhookFireRateLimit);

// Cloud→edge receive rate limiting (Digby Edge Phase 5): POST
// /cloud-link/receive is tunnel-only (JWT + ADMIN + x-cloud-relay header)
// and every accepted call can start a paid AI run on the edge — cap per
// TARGET CHAT+IP (chatId read from the parsed body; express.json ran above)
// so one noisy cloud-side integration can't burn the edge owner's run budget.
// 30/5min mirrors the webhook fire limiter.
const cloudLinkReceiveRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,                  // 30 receives per 5 minutes per chat
  message: { error: 'Too many cloud messages for this chat — slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:cloudlink:'),
  keyGenerator: (req) => cloudLinkReceiveLimiterKey(req.body?.chatId, req.ip),
  skip: (req) => req.method !== 'POST' || !CLOUD_LINK_RECEIVE_PATH_RE.test(req.path),
});
mountApi(app, '', cloudLinkReceiveRateLimit);

// Instance pairing (Digby Edge Phase 3): POST /instances/pair/complete is OPEN
// (self-authenticating via the single-use code — the pairing edge holds no JWT)
// and every complete consumes a code or fails with a uniform 401; POST
// /instances/pair/redeem (device activation, JWT+ADMIN) parks a claim from the
// same 8-char code namespace. Tight per-IP cap on BOTH so online code-guessing
// stays throttled (8-char codes, 10-min TTL).
const instancePairRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,                   // 20 completes/redeems per 10 minutes per IP
  message: { error: 'Too many pairing attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:instpair:'),
  skip: (req) => !INSTANCE_PAIR_PATH_RE.test(req.path),
});
mountApi(app, '', instancePairRateLimit);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/ai-chats', aiChatRoutes);
app.use('/api/analytics', analyticsRoutes);

// First-party visitor analytics (owner 2026-10-07): POST /visit-events is OPEN (anonymous visitors) and every call
// writes rows — cap it per CLIENT (the hashed client ip, never the raw ip as a Redis key; the same trust rule as the
// guest quota key, QUOTA_TRUSTED_PROXY_HOPS) and with a GLOBAL ceiling, so a rotating X-Forwarded-For cannot fill
// the table. A capped beacon just loses page views — nothing user-facing depends on it.
const visitEventsClientRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 240,                  // 240 batches per 10 minutes per client (a batch carries ≤ 50 events)
  message: { error: 'Too many analytics events.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:visit:'),
  keyGenerator: (req) => `c:${hashIp(clientIpForHash(req as any)) ?? 'noip'}`,
  skip: (req) => req.path !== '/visit-events',
});
const visitEventsGlobalRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20_000,               // all clients together
  message: { error: 'Too many analytics events.' },
  standardHeaders: false,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:visitall:'),
  keyGenerator: () => 'global',
  skip: (req) => req.path !== '/visit-events',
});
mountApi(app, '', visitEventsClientRateLimit, visitEventsGlobalRateLimit);

// Client error ingest (ticket d4e643a5, 2026-11-06): POST /client-error is OPEN (a crashing tab may be signed
// out). Same two-budget shape as /visit-events — per CLIENT (hashed hops-anchored ip + CA ip, the visit-events
// rule; never the raw ip as a Redis key, and never express-rate-limit's req.ip, the ALB node) plus a GLOBAL
// ceiling — so a client rotating its reported URL/build sha cannot fill app_error_logs. The controller ALSO
// signature-throttles (one row per signature per 5 min), so this is the outer bound only.
const clientErrorClientRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 60,                   // 60 client-error reports per 10 minutes per client
  message: { error: 'Too many error reports.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:clienterr:'),
  keyGenerator: (req) => `c:${hashIp(clientIpForHash(req as any)) ?? 'noip'}`,
  skip: (req) => req.path !== '/client-error',
});
const clientErrorGlobalRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5_000,                // all clients together (a fleet-wide breakage is still bounded)
  message: { error: 'Too many error reports.' },
  standardHeaders: false,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:clienterrall:'),
  keyGenerator: () => 'global',
  skip: (req) => req.path !== '/client-error',
});
mountApi(app, '', clientErrorClientRateLimit, clientErrorGlobalRateLimit);

// ── /api/crossmodel mount order — the ordering contract ──────────────────────
// Every mount below goes through `mountApi` (api-prefixes.ts), which mounts the
// SAME stack at /api/crossmodel AND /api/digby — the additive dual-serve window
// of the leg (b) rename (docs/LEG_B_CROSSMODEL_RENAME_PLAN.md §3). Never write
// `app.use('/api/crossmodel', …)` here again: a router mounted on one prefix and
// not the other is a silent 404 for the other URL shape, and the structural test
// in api-prefixes.test.ts fails on exactly that.
//
// ONE app-level authenticate guard verifies each request exactly once. It
// replaced the per-router `router.use(authenticate)` that re-verified the JWT
// on every fall-through router (8x for /coding/*) — the stacked-middleware
// footgun behind the 2026-07-23 duplicate-cm_access-cookie nginx 502.
//
//   1. OPEN routers first. They must NEVER add `router.use(authenticate)` (or
//      any middleware that can end a request): non-matching requests must fall
//      through cleanly to the guard. Anonymous-capable routes carry per-route
//      optionalAuthenticate (SSE/EventSource endpoints authenticate via the
//      cm_access cookie or ?token= and self-check req.user?.id → 401); the
//      integration sub-routers (google, github, x, xero, slack, asana, plaid,
//      imessage, telegram) self-authenticate PER-ROUTE inside the open router,
//      so their per-route auth still runs exactly once.
//   2. The single guard.
//   3. AUTHED routers after it. New authenticated routers mount here, with NO
//      internal authenticate; rejectChild stays (it reads the guard's req.user).
// The two prefixes interleave in this list, which is harmless: a request carries
// exactly one prefix, so each prefix sees its own mounts in the same order.
mountApi(app, '', publicShareRoutes); // public share links — no auth at all
mountApi(app, '', codingPublicRoutes); // Digby Code SSE/preview (query-token) — optionalAuthenticate + handler self-check
mountApi(app, '', generatedFilesPublicRoutes); // generated-file download (query-token — chat markdown links send no Authorization header)
mountApi(app, '', crossmodelOpenRoutes); // stream/upload/feedback/OAuth/webhooks — open posture
// Phase 2 Cloud brandings packs (todo 61dc8aaf) — PUBLIC half: every visitor,
// logged out included, must see an active seasonal skin, so the active-pack read
// and its asset bytes sit BEFORE the guard. Both routes are read-only and can
// only reach the ONE pack with status='active'.
mountApi(app, '', brandingPackPublicRoutes);
mountApi(app, '', instancesOpenRoutes); // Digby Edge Phase 3 — instance pair/complete + self-revoke (self-authenticating, uniform 401)
// P3 — external platform API + scoped agent tokens. Path-scoped mount in the
// OPEN section: the router self-authenticates per-route (user JWT OR scoped
// dgt_ agent token — see middleware/agent-auth.ts), so the single guard
// (user-JWT-only) never sees — and never rejects — an agent token.
mountApi(app, '/platform', platformRoutes);
mountApi(app, '', authenticate); // ── THE single guard ──
mountApi(app, '', crossmodelRoutes);
mountApi(app, '', childrenRoutes); // Digby Kids — parent manages child sub-accounts
mountApi(app, '', projectsRoutes);
mountApi(app, '', sharingRoutes);
mountApi(app, '', documentsRoutes);
mountApi(app, '', generatedFilesRoutes); // agent-generated files (list/delete + Bearer download)
mountApi(app, '', chatFilesRoutes); // persistent per-chat uploads (list/download/inline)
mountApi(app, '', canvasRoutes);
mountApi(app, '', codingRoutes); // Digby Code — agentic coding tab
mountApi(app, '', fleetRoutes); // Fleet Management — supervisor settings/overview/thread/queue/log
mountApi(app, '', modelEndpointsRoutes); // Digby Edge — admin custom model endpoint registry
mountApi(app, '', instancesRoutes); // Digby Edge Phase 3 — cloud-side instance pairing management (ADMIN)
mountApi(app, '', cloudLinkRoutes); // Digby Edge Phase 3 — edge-side cloud link (ADMIN)
mountApi(app, '/push', pushRoutes); // mobile push-token registration (M1) — behind the guard; rejectChild (Digby Kids never push)
mountApi(app, '/reports', reportsRoutes); // content reports (M2-prep 1.2/1.4) — behind the guard; rejectChild; GET+review are admin-gated
mountApi(app, '', webhookAuthedRoutes); // per-chat webhook token lifecycle (owner-only); the OPEN fire router lives in crossmodel-open.routes.ts
mountApi(app, '', visitorAdminRoutes); // first-party visitor analytics — Account → Admin → Users & traffic (admin-gated per handler); the OPEN POST /visit-events lives in crossmodel-open.routes.ts
mountApi(app, '', orgAdminRoutes); // Phase 2 Cloud — tenant abuse kill switch + free-tier daily limit (admin-gated per handler)
// Phase 3 Enterprise RBAC (todo c45f065e) — ORG-SCOPED, not instance-admin: every
// handler is gated on the caller's `memberships.role` for the `:orgId` in its own
// path (org-access.ts), so these reach one workspace each, never the whole deployment.
mountApi(app, '', orgMembersRoutes);
// Phase 2 Cloud branding packs (todo 61dc8aaf) — ADMIN half: upload → validate →
// preview → activate → rollback. Behind the guard AND gated per handler on
// isAdminViewer (the owner-email fallback never applies on a self-host instance).
mountApi(app, '', brandingPackAdminRoutes);

// 404 handler
app.use(notFound);

// Error handler (must be last)
app.use(errorHandler);

export default app;