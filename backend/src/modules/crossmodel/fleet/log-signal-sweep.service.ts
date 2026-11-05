/**
 * Log-signal sweep (ticket 8a66441e, 2026-10-16) — the hourly read of
 * app_error_logs that closes the "logs screaming for hours, nobody listening"
 * gap. PrismaErrorTransport (utils/logger.ts) persists every warn + error to
 * app_error_logs, but nothing read that table on a schedule: get_fleet_telemetry
 * view 'errors' only runs when called, the nightly charter's Stream 1 reads
 * chats, and no cron watched cron_jobs.lastStatus. The motivating specimen:
 * session-history-sync's "push refused permanently (terminal auth; quarantined
 * for 6h, one fresh attempt after)" warn repeated ~40 min apart across FIVE
 * worker boots — the 6h quarantine promise lived in process memory and every
 * deploy reset it — and the only reason anyone noticed was an agent that
 * happened to grep the worker logs by hand (companion ticket: session-history
 * push quarantine resets on every deploy).
 *
 * WHAT THE SWEEP DOES (hourly, `log-signal-sweep` cron — worker.ts):
 *   1. Reads the last 24 h of warn/error rows from app_error_logs (newest
 *      LOG_SIGNAL_ROWS_CAP, reversed to chronological).
 *   2. Groups them by NORMALIZED message (ids/uuids/hex/timestamps/numbers
 *      stripped, lowercase, capped) — the fingerprint.
 *   3. Fires a signal when either rule matches:
 *        RULE 1 (recurrence) — the fingerprint recurs across ≥ RULE1_MIN_HOURS
 *          distinct UTC hours, OR across ≥ RULE1_MIN_BOOT_EPISODES boot
 *          episodes. "Boot episode" is a HEURISTIC PROXY for a worker boot:
 *          occurrences of the same fingerprint split into clusters separated
 *          by > BOOT_EPISODE_GAP_MS of silence (5 min). app_error_logs carries
 *          no worker-boot registry, and in-memory suppression state (the
 *          quarantine map, cooldown stamps, once-per maps) dies with the
 *          process — so a suppressed-once warn that reappears after a quiet
 *          gap is exactly the once-per-boot shape. A warn that fires steadily
 *          has no gaps but crosses 3 distinct hours instead; the two legs
 *          complement. False positives are possible (two natural clusters
 *          6 min apart) and acceptable at ≥3 episodes.
 *        RULE 2 (broken suppression promise) — the RAW message carries a
 *          suppression promise (quarantin… | back(ing) off | suppress… | once
 *          per | cooldown) yet the fingerprint repeated INSIDE the promised
 *          window. The window is parsed from the raw text when a duration sits
 *          in the SAME CLAUSE as the promise token ("quarantined for 6h" → 6 h):
 *          rule 2 fires when ≥ RULE2_MIN_REPEATS occurrences sit closer together
 *          than that window. A duration in another clause is NOT the promise's
 *          window (6384c6a7: "once per cause per process" harvested a 8000 ms
 *          embed TIMEOUT budget and claimed a 0-min promise — parsePromisedWindow-
 *          Ms reads only the promise's own clause, ±PROMISE_ADJACENCY_CHARS).
 *          A SCOPE-qualified promise (`once per process|worker|instance|boot|
 *          container|pod`) is not a time promise at all — it is honoured across
 *          processes by construction, so detectSuppressionPromise returns null
 *          for it and rule 1's cross-hour recurrence is the honest signal.
 *          When no duration is parseable the promise is implicit, so ≥
 *          RULE2_MIN_REPEATS_UNPARSED occurrences (3) fire instead — never 2,
 *          because a per-session / per-chat suppression promise legitimately
 *          logs once per subject and ids are stripped from the fingerprint.
 *   4. Files ONE ticket per fingerprint per ISO week through the SAME insert
 *      path the file_feedback tool uses (feedback.fileFeedbackTicket — its
 *      caps + dedup apply), capped at LOG_SIGNAL_TICKETS_PER_PASS per sweep
 *      (loudest first) AND at LOG_SIGNAL_TICKETS_PER_DAY NEW filings per UTC
 *      day across ALL workers (aad94ed4: per-pass 3 × hourly = up to 72 new
 *      rows/day; the day budget is a Redis INCR-first reservation on
 *      `log-signal-sweep:filed:<YYYY-MM-DD>`, 26 h TTL — a capped pass
 *      releases its week claim, defers the remaining fingerprints to the next
 *      day, and stamps loop_metrics meta capped:true). DEDUP BUMPS are
 *      budget-exempt (recurrence evidence on a standing ticket must keep
 *      flowing at cap): the filing peeks feedback's live exact-title pass
 *      first — the common bump shape — and the insert result refunds a
 *      reserved slot when the truth turns out to be a bump (below cap the
 *      rarer dedup shapes are refunded the same way; at cap they defer, see
 *      isLikelyDedupBump). Dedupe is TWO layers: a Redis NX week key
 *      (`log-signal-sweep:ticket:<week>:<fpHash>`, card-ticket pattern) so a
 *      later sweep in the same week doesn't even attempt the insert, and a
 *      STABLE title (`log-signal: <fingerprint>` — counts live in the
 *      description, never the title) so feedback's 90-day exact-title pass
 *      bumps the EXISTING ticket's occurrences in a later week instead of
 *      filing a new row — a standing error class (e.g. the CQL revoked-key
 *      401s, n≈55/day) gets ONE durable row whose occurrences count its
 *      recurrence, not a weekly ticket mill. The filing's context.sessionId
 *      is PER FINGERPRINT (`log-signal-sweep:<fpHash>`) — feedback's
 *      same-session 24 h fuzzy title pass would otherwise merge two
 *      fingerprints' filings (the infra-watch card-ticket lesson).
 *   5. Delivers ONE [INFRA ALERT — recurring log signals] wake per day to the
 *      admin owner's Fleet Supervisor chats, but ONLY when the pass has
 *      something actionable to cite: a ticket FILED or BUMPED this pass (an
 *      already-week-cached ticket cited without a new filing/bump does NOT
 *      qualify — standing classes stay quiet between weekly bumps), or a
 *      spike with tickets disabled. The wake always carries ticket ids.
 *      Delivery reuses infra-watch's deliver() (Redis dedupe, supervisor-OFF
 *      switch, loop_metrics row), so this module inherits those semantics.
 *
 * Telemetry: one loop_metrics row per pass (kind log_signal_sweep, counters in
 * meta) plus one row per wake DELIVERY ATTEMPT (same kind, kind:'log_signal'
 * meta — a failed enqueue carries meta.outcome='enqueue_failed', 6d19f11f) —
 * verify movement with get_fleet_telemetry view 'metrics' kind 'log_signal_sweep'.
 *
 * Kill switches: LOG_SIGNAL_SWEEP_DISABLED=1 (whole sweep — tickets AND wake),
 * LOG_SIGNAL_SWEEP_TICKETS_DISABLED=1 (tickets only; the wake still fires on
 * spikes), LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED=1 (0ef6794e: the
 * per-fingerprint adjudication gate only — restores the weekly filing of
 * evidence-gated adjudicated-designed classes byte-for-byte). Ticket-volume
 * knob: LOG_SIGNAL_TICKETS_PER_DAY (default 5) caps NEW filings per UTC day
 * across all workers (aad94ed4) — bumps stay exempt.
 * DB + Redis only, never the workspaces volume — safe on every
 * worker including the 0-slot cron-only box.
 */
import crypto from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { adminFleetSupervisors, deliver } from './infra-watch.service';
import type { FleetSupervisorRow } from './infra-watch.service';
import { LOOP_METRIC_KINDS, recordLoopMetric } from '../platform/loop-metrics.service';
import { reserveDayFilingSlot } from './day-filing-budget';
// Per-fingerprint adjudication suppression (ticket 0ef6794e): the evidence
// gate that stops the sweep re-filing a fingerprint whose class TWO
// adjudication cycles closed as designed WITH a verified id-named replay
// pin (unless the recurrence breaches the verdict's own re-open bar or
// surges past 3x its recorded baseline). Leaf: prisma + fs/path + the
// ticket-status/ticket-family leaves — no logger/redis/env chain, so the
// static import keeps this module's import graph shape.
import { logSignalAdjudicatedSuppressionDisabled, shouldSuppressFingerprintFiling } from './log-signal-adjudication';
// Secret-shape redaction (ticket 885614de): the shared LEAF pattern set
// (platform/secret-scan.ts — provider tokens sk-/xai-/o1_/hf_/xox/AKIA/AIza/
// Z.ai/cf_/tskey-, labelled assignments, password labels). The sweep's rows
// are only scrubbed for the URL-userinfo shape at write time
// (utils/logger.ts scrubCredentials → redact-credentials.ts), so a provider
// key an error line happened to quote would ride the fingerprint, the
// description's raw excerpt and the INFRA ALERT wake verbatim. secret-scan
// is an import-free leaf — safe here (no env-validating chain).
import { redactSecrets } from '../platform/secret-scan';
// Import-free leaf (ticket 6665fff6): the peek (via feedback.service's
// wouldExactTitleDedupBump) and the insert path both dynamically import
// feedback.service at use time, so nothing here drags its env-validating
// chain into this module's static import graph.
// ACCEPTANCE-METRIC-BASELINE (2026-10-20): the default acceptance metric a
// log-signal ticket carries (prisma-free leaf — pure builders only).
import { AUTOFILER_DEFAULT_METRIC_SOURCE, autofilerDefaultMetricDisabled, logSignalDefaultMetric, designedAlarmOfFingerprint } from '../feedback/acceptance-metric-defaults';

const SOURCE = 'log-signal-sweep';

/**
 * The most rows a fixed class may still log in 24 h without re-firing THIS
 * sweep (review 2026-10-20 — a flat "0 rows" reopened fixes that cut a warn
 * from ~40/h to 2/day, below the sweep's own alert line). Rows bound distinct
 * hours and boot episodes, so ≤ min(RULE1_MIN_HOURS, RULE1_MIN_BOOT_EPISODES)
 * − 1 rows can never trip rule 1; a message carrying a suppression promise
 * can also trip rule 2 at RULE2_MIN_REPEATS (a parsed window — counted
 * conservatively, as if every repeat sat inside it) or
 * RULE2_MIN_REPEATS_UNPARSED, so its target is one less than the lowest of
 * them. Pure.
 */
export function logSignalQuietTarget(signal: { exampleMessage?: string | null; fingerprint?: string | null }): number {
  // The RAW example parses a stated window ("quarantined for 6h"); the
  // normalized fingerprint still carries the promise words when it is absent.
  const msg = String(signal.exampleMessage ?? signal.fingerprint ?? '');
  const rule1Floor = Math.min(RULE1_MIN_HOURS, RULE1_MIN_BOOT_EPISODES);
  if (msg && detectSuppressionPromise(msg)) {
    const rule2Floor = parsePromisedWindowMs(msg) !== null ? RULE2_MIN_REPEATS : RULE2_MIN_REPEATS_UNPARSED;
    return Math.max(0, Math.min(rule1Floor, rule2Floor) - 1);
  }
  return Math.max(0, rule1Floor - 1);
}

/**
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20): the filing-context keys of a
 * log-signal ticket's DEFAULT acceptance metric — "the fingerprint's stable
 * literal fragment stays at or below logSignalQuietTarget app_error_logs rows
 * for 24 h after the fix" (the sweep's own "the class stops recurring" line —
 * below its re-fire threshold), narrowed to the signal's single level /
 * source. Empty when the fingerprint has no stable fragment (≥ 16 literal
 * chars) or AUTOFILER_DEFAULT_METRIC_DISABLED=1. feedback.service's baseline
 * gate then keeps it only when the pre-fix window counted MORE rows than the
 * target (a signal that fired always did). Pure.
 */
export function logSignalMetricContext(signal: { fingerprint: string; levels?: readonly string[]; sources?: readonly string[]; exampleMessage?: string | null }, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (autofilerDefaultMetricDisabled(env)) return {};
  // TICKET 1425001e (2026-11-01): a DESIGNED-ALARM class gets NO volume default.
  // Its warn fires by design, so a `<=` bar counts the alarm rather than the
  // defect — and because `certainEarlyVerdict` rules a breach as certain, the
  // verifier would REOPEN a correct fix on its next tick (ticket 8b62e61e: 28
  // rows measured against a bar of 2, at an emit site its diff never touched).
  // FLAG, do not silently drop: `acceptanceMetricMissing` is what puts the row
  // on the done-bar board line, so the absence is visible and a lane knows to
  // attach its own behavioural criterion instead of inheriting a false one.
  const designed = designedAlarmOfFingerprint(signal.fingerprint);
  if (designed) return { acceptanceMetricMissing: true, acceptanceMetricDesignedAlarm: designed.id };
  // RAW-ANCHOR (ac626e4f/658ecf0e family 2026-10-21): the exampleMessage is
  // passed through so the default metric's fragment is verified against (or
  // re-derived from) the RAW row text — a whitespace-collapsed fingerprint
  // fragment can otherwise match zero raw rows (vacuous metric).
  const metric = logSignalDefaultMetric({ fingerprint: redactSweepSignal(signal.fingerprint), levels: signal.levels, sources: signal.sources, quietTarget: logSignalQuietTarget(signal), exampleMessage: signal.exampleMessage ? redactSweepSignal(signal.exampleMessage) : null });
  return metric ? { acceptanceMetric: metric, acceptanceMetricSource: AUTOFILER_DEFAULT_METRIC_SOURCE } : {};
}

/** Source stamps the sweep must NEVER read back as its own input (ticket
 *  7b2990fa): this module's own failure warns — `ticket not filed (…)` /
 *  `ticket filing failed (non-fatal)` / `alert wake failed (non-fatal)` /
 *  `sweep failed (non-fatal)` / the dedup-onto-a-different-row warn, all the
 *  `logger.warn(…, { source: SOURCE })` sites in this file — persist to
 *  app_error_logs with that source stamp via PrismaErrorTransport
 *  (utils/logger.ts, where context.source wins over the stack-derived one).
 *  Without the fetchWindowRows exclusion a multi-hour Redis/DB outage makes
 *  each NEXT pass fingerprint the sweep's own outage warns alongside any real
 *  signal and ticket them ("the watchdog's own barking"). Bounded (≤4
 *  warns/pass, 1 ticket/fingerprint/week — the #1620 review's N6 trace) but
 *  wrong, and now pinned by test. A LIST so further platform-cron stamps can
 *  join; deliberately EXCLUDES nothing else — another cron's warns (e.g.
 *  infra-watch's) are real signals about THAT cron, not self-reference, and
 *  must stay sweepable. */
export const LOG_SIGNAL_SELF_EXCLUDE_SOURCES: readonly string[] = [SOURCE];

export const LOG_SIGNAL_SWEEP_DISABLED_ENV = 'LOG_SIGNAL_SWEEP_DISABLED';
/** 0ef6794e: the per-fingerprint adjudication-suppression kill switch, re-exported for the suite (the *_ENV convention). */
export { LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV } from './log-signal-adjudication';
export const LOG_SIGNAL_SWEEP_TICKETS_DISABLED_ENV = 'LOG_SIGNAL_SWEEP_TICKETS_DISABLED';
/** Kill switch for the sweep's secret redaction (ticket 885614de): '1' restores
 *  the pre-fix verbatim fingerprints/excerpts. Fail-safe direction: OFF only
 *  on a deliberate operator decision, never on an error (redactSecrets itself
 *  never throws — it returns the input on any failure). */
export const LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV = 'LOG_SIGNAL_SECRET_REDACT_DISABLED';
/** The lookback window (ticket: "rows from the last 24h"). */
export const LOG_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Newest rows read per pass (a guardrail, not a completeness claim — see the docblock). */
export const LOG_SIGNAL_ROWS_CAP = 3000;
/** Fingerprint (and title) length cap — short enough that `log-signal: <fp>` stays under the 140-char title max. */
export const FINGERPRINT_MAX_LEN = 120;

export const RULE1_MIN_HOURS = 3;
export const RULE1_MIN_BOOT_EPISODES = 3;
export const RULE2_MIN_REPEATS = 2;
export const RULE2_MIN_REPEATS_UNPARSED = 3;
/** Silence between occurrence clusters of one fingerprint that starts a new (boot) episode. */
export const BOOT_EPISODE_GAP_MS = 5 * 60 * 1000;
/** A fingerprint at/above this count in the window is a spike (wake-worthy when tickets are disabled). */
export const LOG_SIGNAL_SPIKE_MIN = 10;
/** Max NEW tickets filed per pass (d6fdc1df) — loudest fingerprint first. A
 *  signal already ticketed this ISO week (week key cites it) is skipped
 *  WITHOUT consuming this budget, so the walk continues down the list until
 *  this many NEW tickets have landed; the rest return next hour. */
export const LOG_SIGNAL_TICKETS_PER_PASS = 3;
/** Redis week-key TTL — outlives the ISO week so a straggler sweep can never double-file. */
export const LOG_SIGNAL_TICKET_TTL_SEC = 8 * 24 * 3600;
/** Redis claim TTL while a filing is IN FLIGHT — short, so a worker crash mid-filing releases the claim and the NEXT hourly sweep retries (a long claim would silence the fingerprint for the whole week). */
export const LOG_SIGNAL_TICKET_CLAIM_TTL_SEC = 600;
/** Max NEW tickets per UTC day (aad94ed4) — PER_PASS=3 × an hourly cron was up
 *  72 new rows/day. An INCR-first Redis reservation on a day-named counter,
 *  shared by EVERY worker, bounds it. Dedup BUMPS of standing tickets are
 *  budget-exempt (recurrence evidence must keep flowing at cap). Override: LOG_SIGNAL_TICKETS_PER_DAY (0 = no new filings today, bumps still work). */
export const LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT = 5;
export const LOG_SIGNAL_TICKETS_PER_DAY_ENV = 'LOG_SIGNAL_TICKETS_PER_DAY';
/** Day counter TTL — outlives the UTC day; pure GC, because the key is DAY-NAMED
 *  (an immortal-counter wedge caps one day forever, never the sweep: the next
 *  UTC day is a fresh key — the schedule.service P3 lesson cannot bite here). */
export const LOG_SIGNAL_FILED_TTL_SEC = 26 * 3600;
/** Redis key of the UTC-day NEW-filing counter (aad94ed4). */
export const LOG_SIGNAL_FILED_KEY = (day: string) => `${SOURCE}:filed:${day}`;
/** Daily new-ticket budget: LOG_SIGNAL_TICKETS_PER_DAY env, default 5 (aad94ed4). */
export function logSignalTicketsPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] ?? ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT;
}
/** One wake per UTC day, matching the infra-watch card-cost cadence. */
export const LOG_SIGNAL_ALERT_DEDUPE_SEC = 24 * 3600;

/** Rule 2's text detector — the words a log line uses to PROMISE it will not repeat. */
export const SUPPRESSION_PROMISE_RE = /\b(quarantin\w*|back(?:ing)?[\s-]*off|suppress\w*|once\s+per|cooldown)\b/i;
/** Duration tokens in a raw message ("for 6h", "90 s", "once per hour") — longest unit spellings first. */
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/gi;

export function logSignalSweepDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOG_SIGNAL_SWEEP_DISABLED_ENV] === '1';
}
export function logSignalTicketsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOG_SIGNAL_SWEEP_TICKETS_DISABLED_ENV] === '1';
}

/** Stable per-fingerprint id for Redis keys and the filing's context.sessionId. */
export function fingerprintHash(fingerprint: string): string {
  return crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16);
}

/**
 * Round 2 (885614de, cross-family review finding 1): the shared SECRET_PATTERNS
 * set is PREFIX/LABEL-based, so the ticket's ONE named shape — a bare
 * base64url/JWT-style token with no provider prefix and no `key=` label —
 * survives it verbatim (measured: `redactSecrets('jwt eyJhbGci…')` → hits: [],
 * token intact; same for `Authorization: Bearer dGhpc…`). These sweep-LOCAL
 * structural patterns close that class at the sweep seam only — deliberately
 * NOT in secret-scan's SECRET_PATTERNS, which also feeds the commit-time
 * secret GATE (a bare-base64 rule there could block legitimate commits).
 *  - JWT: two/three dot-separated base64url segments starting `eyJ` (base64
 *    of `{"` — every JWT header seen in the wild starts with it; a PROXY for
 *    "decodable JSON header", not a decode).
 *  - CUE tier (24-39 chars): a base64 run with a credential cue (bearer|token|
 *    authorization|api[_ -]?key|secret|password|credential) within 32 chars
 *    BEFORE OR AFTER it — real log lines put the label on either side
 *    (`Bearer <tok>` and `"<tok>" is not a valid token`).
 *  - BARE tier (≥40 chars): a base64 run with no cue needed.
 *  - Both tiers run in BOTH charsets: base64url (- _) and STANDARD base64
 *    (+ /) — ~75% of standard-base64 bodies contain a + or / and would
 *    otherwise leak head/tail fragments around every separator.
 * Entropy gate (every tier): upper AND lower AND digit, OR ≥24 consecutive
 * hex chars (a 64-char signing key is single-class hex — the mixed-case
 * branch alone would miss it). Lowercase-only run ids, pure-prose slugs and
 * CamelCase class names without digits stay intact. The gate is what
 * protects prose near the cue words — a lowercase run id next to
 * "credentials" has no mixed-case/hex signal and never matches.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?\b/g;
const CRED_CUE_RE = /\b(bearer|token|authorization|api[_ -]?key|secret|password|passwd|credential|auth)\b/i;
const B64URL_RE = /[A-Za-z0-9_-]{24,}/g;
const B64_CLASSIC_RE = /[A-Za-z0-9+/]{24,}/g;
const HEX_RUN_RE = /^[0-9a-fA-F]{24,}$/;

/** The entropy gate: a mixed-case+digit run (a random base64 body), or a
 *  ≥24-char pure-hex run (a signing key / hex opaque token). */
function isSecretShapedRun(m: string): boolean {
  if (HEX_RUN_RE.test(m)) return true;
  return /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m);
}

function redactSweepStructural(text: string): string {
  // JWT first (its segments are also base64url runs — one span, not three).
  let out = text.replace(JWT_RE, () => SWEEP_REDACTED_NOTE);
  // CLASSIC pass first: its charset has no `-`/`_`, so running the url pass
  // first would FRAGMENT a standard-base64 run at every +/ separator, redact
  // only the big middle, and leave head/tail fragments standing (review F1
  // probe caught exactly that). Whole classic runs must match before the url
  // pass can split them; url-shaped runs (- _) are untouched by this pass.
  for (const re of [B64_CLASSIC_RE, B64URL_RE]) {
    out = out.replace(re, (m: string, offset: number, whole: string) => {
      if (m.length < 24) return m;
      if (!isSecretShapedRun(m)) return m;
      if (m.length >= 40) return SWEEP_REDACTED_NOTE;
      return credCueNear(whole, offset, m.length) ? SWEEP_REDACTED_NOTE : m;
    });
  }
  return out;
}

/** A credential cue within 32 chars BEFORE OR AFTER the candidate span — the
 *  introducing position (`Authorization: Bearer <tok>`) and the trailing label
 *  (`"<tok>" is not a valid token`) both count. */
function credCueNear(whole: string, offset: number, length: number): boolean {
  const before = whole.slice(Math.max(0, offset - 32), offset);
  const after = whole.slice(offset + length, offset + length + 32);
  return CRED_CUE_RE.test(before) || CRED_CUE_RE.test(after);
}

/**
 * Ticket 885614de — the sweep's secret-shape choke. The rows the sweep reads
 * were scrubbed at WRITE time only for the URL-userinfo shape (utils/logger.ts
 * scrubCredentials → redact-credentials.ts); every provider shape the shared
 * SECRET_PATTERNS set knows (sk-/xai-/o1_/hf_/xox/AKIA/AIza/Z.ai/cf_/tskey-…)
 * sits RAW in app_error_logs. Applied at the sweep's egress surfaces (every
 * fingerprint render, the description's raw excerpt, the wake prompt) a
 * credential an error line quoted can no longer ride a ticket
 * title/description or a Fleet Supervisor wake. Round 2 adds the sweep-local
 * structural layer for the base64url/JWT class the prefix-based shared set
 * cannot see. Fail-SAFE: the kill switch restores the verbatim behaviour
 * (LOG_SIGNAL_SECRET_REDACT_DISABLED=1); the local try/catch fails open.
 */
export const SWEEP_REDACTED_NOTE = '[REDACTED: looked like a credential]';

export function redactSweepSignal(text: string): string {
  try {
    if (process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV] === '1') return String(text ?? '');
    return redactSweepStructural(redactSecrets(String(text ?? '')).text);
  } catch {
    return String(text ?? '');
  }
}

/**
 * Normalize a log message into its fingerprint: strip ANSI, uuids, long hex
 * ids, timestamps and numbers (ids/counts vary per occurrence — the CLASS must
 * not), collapse whitespace, lowercase, cap. Order matters: uuids before hex
 * before timestamps before bare numbers, or the earlier passes would mangle
 * what the later ones look for. SECRET redaction runs FIRST (885614de): the
 * id/number/hex passes are digit-shape-based and would leave a TOKEN BODY
 * standing around them (the prefix or the alphanumeric body survives as a
 * partial secret in every title, description, wake and week-key hash) —
 * redacting the WHOLE token first keeps the class prose and one class still
 * lands on one fingerprint. A rotating token even IMPROVES grouping: pre-fix
 * each rotation minted a distinct fingerprint that could never reach a rule's
 * recurrence bar.
 */
export function normalizeLogMessage(raw: string): string {
  return redactSweepSignal(String(raw ?? ''))
    .replace(/\u001b\[\d+m/g, '') // ANSI colour codes (the transport strips them; be safe)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:]+(?:\.\d+)?)?Z?\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/g, '<time>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, FINGERPRINT_MAX_LEN);
}

/**
 * ADJACENCY (ticket 6384c6a7, 2026-11-03) — a duration only counts as a
 * promise's window when it sits in the promise's OWN clause.
 *
 * Pre-fix `parsePromisedWindowMs` took the LARGEST duration ANYWHERE in the raw
 * message and the sweep filed it as the promise ("once per" + a 8000 ms embed
 * TIMEOUT budget ⇒ "promised once per 0 min"). The motivating prod row:
 *
 *   unified-memory: embed failed, 10/10 row(s) stored keyword-only — timeout
 *   (embed attempt timeout after 8000ms (batch 1/1, 2 attempt(s))); rows=10
 *   maxChars=3500 source=orchestrator scope=session; per-row retry not
 *   attempted (logged once per cause per process; counted as
 *   unified_memory_embed_failed)
 *
 * The only duration there is the embed CLIENT's timeout budget, ~120 chars from
 * the `once per` token and in a different clause; the promise itself is
 * SCOPE-qualified (`once per cause per process`), not a time window at all.
 *
 * The rule, documented exactly: for every promise-token match, scan
 * PROMISE_ADJACENCY_CHARS on EACH side of the token, truncate that span at the
 * nearest CLAUSE TERMINATOR (`;` `(` `)` `[` `]` `—` `–` newline), and read
 * DURATION_RE only inside what remains. The window is therefore "the promise's
 * own clause, at most ±80 chars of it" — a timeout budget in a parenthetical, a
 * retry budget after a `;`, or a duration in another sentence is not adjacent
 * and cannot be harvested. The LARGEST ADJACENT duration wins (two promises may
 * each name a window: "retry in 30s, full cooldown 10 minutes" ⇒ 10 min).
 */
export const PROMISE_ADJACENCY_CHARS = 80;
/** Clause terminators that end a promise's own clause (never `,` or `:` — real
 *  lines hyphenate/colon after the promise token: "backoff: retry in 90s"). */
const PROMISE_CLAUSE_END_RE = /[;()[\]\u2013\u2014\n]/;
/**
 * SCOPE-qualified promise (ticket 6384c6a7) — `once per process|worker|
 * instance|boot|container|pod` promises once per PROCESS, which is honoured by
 * construction across processes: N rows in a fleet-wide 24 h window are N
 * processes, not a broken promise, so rule 2 can never falsify it. The honest
 * signal for that class is rule 1's cross-hour recurrence (which still fires).
 *
 * Deliberately NARROW: `per session|chat|subject|browser|key` are NOT here. A
 * once-per-SUBJECT promise legitimately logs once per subject, and ids are
 * stripped from the fingerprint, so those keep the 3-repeat unparsed branch
 * described in the module doc (lines 33-43) rather than being nulled.
 */
const PROMISE_SCOPE_QUALIFIER_RE = /\bper\s+(?:process|worker|instance|boot|container|pod)\b/i;
/** The same scope words when the promise token itself ate the `per` — the
 *  `once per` promise IS the first `per`, so `once per process` leaves only
 *  ` process` in the after-clause and the pattern above cannot see it. */
const PROMISE_SCOPE_TAIL_RE = /^\s*(?:process|worker|instance|boot|container|pod)\b/i;

/** Every promise-token match in the raw text, as a global clone (the exported
 *  RE is non-global so callers may `.test` it without residue). */
function suppressionPromiseMatches(raw: string): Array<{ phrase: string; index: number; end: number }> {
  const text = String(raw ?? '');
  const re = new RegExp(SUPPRESSION_PROMISE_RE.source, 'gi');
  const out: Array<{ phrase: string; index: number; end: number }> = [];
  for (const m of text.matchAll(re)) {
    out.push({ phrase: m[0].toLowerCase(), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * Drop a PARTIAL token left by the adjacency slice (adversarial review
 * 2026-11-03, NIT-5). The slice is a raw character cut, so it can land inside a
 * duration token and change its MEANING: `'…' + ' '.repeat(76) + '300ms'` cut
 * at 80 chars leaves `300m`, which DURATION_RE reads as 300 MINUTES — a 1000×
 * magnified window that would convict a gap nothing promised. Trimming to a
 * whitespace boundary removes the fragment. Only when the slice truncated.
 */
function trimPartialToken(slice: string, truncatedAtStart: boolean, truncatedAtEnd: boolean): string {
  let out = slice;
  if (truncatedAtStart) {
    const ws = out.search(/\s/);
    out = ws === -1 ? out : out.slice(ws + 1);
  }
  if (truncatedAtEnd) {
    const m = /\S+$/.exec(out);
    if (m) out = out.slice(0, m.index);
  }
  return out;
}

/** The promise token's own clause AFTER it — ≤ PROMISE_ADJACENCY_CHARS, cut at the first terminator. */
function promiseClauseAfter(text: string, from: number): string {
  const end = Math.min(text.length, from + PROMISE_ADJACENCY_CHARS);
  const tail = text.slice(from, end);
  const cut = tail.search(PROMISE_CLAUSE_END_RE);
  if (cut !== -1) return tail.slice(0, cut);
  return trimPartialToken(tail, false, end < text.length);
}

/** The promise token's own clause BEFORE it — ≤ PROMISE_ADJACENCY_CHARS, cut at the last terminator. */
function promiseClauseBefore(text: string, to: number): string {
  const start = Math.max(0, to - PROMISE_ADJACENCY_CHARS);
  const head = text.slice(start, to);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (PROMISE_CLAUSE_END_RE.test(head[i])) { cut = i; break; }
  }
  if (cut !== -1) return head.slice(cut + 1);
  return trimPartialToken(head, start > 0, false);
}

/**
 * A promise that promises per PROCESS/BOOT rather than per TIME WINDOW (see
 * PROMISE_SCOPE_QUALIFIER_RE).
 *
 * TWO conditions, and the SECOND is what keeps this honest (adversarial review
 * 2026-11-03, BLOCKER): the promise's own clause must state NO duration.
 * Without it, `quarantined for 6h, one fresh attempt per process after` matched
 * the unrelated `per process` retry clause and nulled a genuine 6 h promise —
 * silently switching rule 2 off for the repo's own session-history quarantine
 * warn (session-history-sync ends "…quarantined for Nh, one fresh attempt
 * after)"). A promise that STATES its window is a time promise, and a scope
 * word elsewhere in the clause cannot rescue it from being policed.
 *
 * The TAIL form only applies when the promise token itself ENDS in `per`
 * (`once per process` — the token ate the preposition), so an unrelated noun
 * after a `suppressed`/`cooldown` token can never be mistaken for a scope.
 */
function isScopeQualifiedPromise(text: string, token: { phrase: string; index: number; end: number }): boolean {
  const before = promiseClauseBefore(text, token.index);
  const after = promiseClauseAfter(text, token.end);
  // A stated window in the promise's OWN clause wins over any scope word.
  if ([before, after].some((c) => [...c.matchAll(DURATION_RE)].length > 0)) return false;
  if (PROMISE_SCOPE_QUALIFIER_RE.test(after)) return true;
  return /\bper$/.test(token.phrase) && PROMISE_SCOPE_TAIL_RE.test(after);
}

/** The suppression promise a raw message makes, if any (lowercased match), else null.
 *  A scope-qualified promise (per process/worker/boot…) returns null: it is not a
 *  time promise, so rule 2 must not be applied to it (rule 1 recurrence still is). */
export function detectSuppressionPromise(raw: string): string | null {
  const text = String(raw ?? '');
  for (const m of suppressionPromiseMatches(text)) {
    if (isScopeQualifiedPromise(text, m)) continue;
    return m.phrase;
  }
  return null;
}

/** Parse the LARGEST duration ADJACENT to a (time) promise token, in ms — the
 *  "promised window" for Rule 2. Null when no promise names a duration, or when
 *  every promise in the message is scope-qualified (see PROMISE_SCOPE_QUALIFIER_RE). */
export function parsePromisedWindowMs(raw: string): number | null {
  const text = String(raw ?? '');
  const toMs = (n: number, unit: string): number => {
    const u = unit.toLowerCase();
    if (u.startsWith('mil') || u === 'ms') return n;
    if (u.startsWith('s')) return n * 1000;
    if (u.startsWith('m')) return n * 60_000;
    if (u.startsWith('h')) return n * 3_600_000;
    if (u.startsWith('d')) return n * 86_400_000;
    if (u.startsWith('w')) return n * 604_800_000;
    return n;
  };
  const windows: string[] = [];
  for (const m of suppressionPromiseMatches(text)) {
    if (isScopeQualifiedPromise(text, m)) continue;
    windows.push(promiseClauseBefore(text, m.index), promiseClauseAfter(text, m.end));
  }
  if (!windows.length) return null;
  const found = windows.flatMap((w) => [...w.matchAll(DURATION_RE)].map((d) => toMs(Number(d[1]), d[2])));
  return found.length ? Math.max(...found) : null;
}

/** One app_error_logs row as the sweep reads it. */
export interface LogSignalRow {
  level: string;
  message: string;
  source?: string | null;
  createdAt: Date | string;
  /** app_error_logs.context — read only for its `logClass` tag. */
  context?: unknown;
}

/**
 * The log taxonomy (utils/log-level.ts, 2026-10-18): a row tagged
 * logClass 'handled' (an expected outcome) or 'external' (a dependency we do
 * not control is degraded) is not an internal fault and never becomes a
 * ticket. 'handled' normally logs at info and never reaches the table; the
 * check also covers a handled row written at warn. Pure.
 */
export function isNonFaultLogRow(row: Pick<LogSignalRow, 'context'>): boolean {
  const ctx = row.context;
  if (!ctx || typeof ctx !== 'object') return false;
  const cls = (ctx as Record<string, unknown>).logClass;
  return cls === 'handled' || cls === 'external';
}

/** A fingerprint's aggregate over the window. */
export interface LogFingerprint {
  fingerprint: string;
  count: number;
  /** Distinct UTC hours (YYYY-MM-DDTHH) with at least one occurrence. */
  hours: number;
  /** Occurrence clusters separated by > BOOT_EPISODE_GAP_MS of silence — the worker-boot proxy. */
  episodes: number;
  firstAt: number;
  lastAt: number;
  /** Smallest gap between consecutive occurrences, ms — null when count < 2. */
  minGapMs: number | null;
  levels: string[];
  sources: string[];
  /** Raw message of the NEWEST row (promise + duration parsing read this). */
  exampleMessage: string;
}

const ts = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/**
 * Group rows by fingerprint and compute each group's recurrence shape. Pure;
 * rows may arrive in any order (they are sorted internally).
 */
export function summarizeLogFingerprints(rows: ReadonlyArray<LogSignalRow>, gapMs: number = BOOT_EPISODE_GAP_MS): LogFingerprint[] {
  const groups = new Map<string, { times: number[]; levels: Set<string>; sources: Set<string>; newestAt: number; newestRaw: string }>();
  for (const r of rows) {
    const t = ts(r.createdAt);
    if (!Number.isFinite(t)) continue; // undateable row — skip, never throw
    const fp = normalizeLogMessage(r.message);
    if (!fp) continue;
    const g = groups.get(fp) ?? { times: [], levels: new Set<string>(), sources: new Set<string>(), newestAt: -Infinity, newestRaw: '' };
    g.times.push(t);
    if (r.level) g.levels.add(String(r.level));
    if (r.source) g.sources.add(String(r.source));
    // Track the NEWEST row's RAW message in the same pass (its numbers stay
    // intact for Rule 2's promise + duration parsing) — no second scan.
    if (t >= g.newestAt) { g.newestAt = t; g.newestRaw = String(r.message); }
    groups.set(fp, g);
  }
  const out: LogFingerprint[] = [];
  for (const [fingerprint, g] of groups) {
    const times = g.times.sort((a, b) => a - b);
    const hours = new Set(times.map((t) => new Date(t).toISOString().slice(0, 13))).size;
    let episodes = times.length ? 1 : 0;
    let minGapMs: number | null = null;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > gapMs) episodes++;
      if (minGapMs === null || gap < minGapMs) minGapMs = gap;
    }
    out.push({
      fingerprint,
      count: times.length,
      hours,
      episodes,
      firstAt: times[0],
      lastAt: times[times.length - 1],
      minGapMs,
      levels: [...g.levels],
      sources: [...g.sources],
      exampleMessage: g.newestRaw,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export type LogSignalRule = 'rule1-hours' | 'rule1-boots' | 'rule2-suppression';

/** A fingerprint that fired a rule — what the ticket + wake describe. */
export interface RecurringLogSignal extends LogFingerprint {
  rule: LogSignalRule;
  /** Rule 2 only: the promise phrase found in the raw message. */
  promise: string | null;
  /** Rule 2 only: the parsed promised window (ms), null when unparseable. */
  promisedWindowMs: number | null;
}

/**
 * Pure classification. Rule precedence per fingerprint: rule 2 (a broken
 * promise is the sharpest signal) > rule1-hours > rule1-boots.
 */
export function classifyRecurringLogSignals(
  fps: ReadonlyArray<LogFingerprint>,
  opts: { minHours?: number; minBootEpisodes?: number; minRepeats?: number; minRepeatsUnparsed?: number } = {},
): RecurringLogSignal[] {
  const minHours = opts.minHours ?? RULE1_MIN_HOURS;
  const minBoots = opts.minBootEpisodes ?? RULE1_MIN_BOOT_EPISODES;
  const minRepeats = opts.minRepeats ?? RULE2_MIN_REPEATS;
  const minRepeatsUnparsed = opts.minRepeatsUnparsed ?? RULE2_MIN_REPEATS_UNPARSED;
  const out: RecurringLogSignal[] = [];
  for (const fp of fps) {
    const promise = detectSuppressionPromise(fp.exampleMessage);
    if (promise) {
      const windowMs = parsePromisedWindowMs(fp.exampleMessage);
      const fired = windowMs !== null
        ? fp.count >= minRepeats && fp.minGapMs !== null && fp.minGapMs < windowMs
        : fp.count >= minRepeatsUnparsed;
      if (fired) {
        out.push({ ...fp, rule: 'rule2-suppression', promise, promisedWindowMs: windowMs });
        continue;
      }
    }
    if (fp.hours >= minHours) {
      out.push({ ...fp, rule: 'rule1-hours', promise: null, promisedWindowMs: null });
      continue;
    }
    if (fp.episodes >= minBoots) {
      out.push({ ...fp, rule: 'rule1-boots', promise: null, promisedWindowMs: null });
    }
  }
  return out;
}

// ── Tickets (card-ticket pattern: Redis NX week key + stable title) ──────────

export interface LogSignalTicket { fingerprint: string; fingerprintHash: string; ticketId: string; filed: boolean; deduped?: boolean }

/** The insert seam — the SAME path the file_feedback tool uses (caps + dedup apply). */
export type FileLogSignalTicket = (opts: { userId: string | null; title: string; description: string; context: Record<string, unknown> }) => Promise<{ id: string; deduped?: boolean } | null>;

/** The per-fingerprint session id — feedback's fuzzy pass keys on context.sessionId, so fingerprints must never share one. */
export const logSignalTicketSessionId = (fpHash: string) => `${SOURCE}:${fpHash}`;

/** STABLE per fingerprint (counts live in the description — a moving title would defeat the 90-day exact dedup).
 *  Round-2 belt (885614de review finding 7): the title renders the fingerprint
 *  through redactSweepSignal too — ingress already redacts, but a hand-built or
 *  kill-switch-bypassed fingerprint must still never leak at the title seam. */
export function logSignalTicketTitle(fingerprint: string): string {
  return `log-signal: ${redactSweepSignal(fingerprint)}`.slice(0, 140);
}

const TICKET_KEY = (week: string, fpHash: string) => `${SOURCE}:ticket:${week}:${fpHash}`;
/** ISO week key, same shape as infra-watch's isoWeekKey. */
export function isoWeekKeyOf(d: Date): string {
  const dayMs = 86_400_000;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7)); // this week's Thursday
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / dayMs + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Daily-cap bump-peek (aad94ed4): would fileFeedbackTicket's live exact-title
 * pass BUMP a standing open agent ticket with this title (source='agent',
 * OPEN_TICKET_STATUSES, 90-day window — the same candidate shape)?
 * A bump is recurrence evidence on an EXISTING row, so it is budget-exempt:
 * at cap the sweep still bumps, only NEW filings defer to the next day.
 * 586ebe71: the peek delegates to feedback.service's wouldExactTitleDedupBump
 * — the REAL exact pass's scan shape (unbounded over the 90-day window,
 * prefiltered). A peek that scans a different window than the pass it models
 * drifts under volume exactly like the erosion that ticket fixes: at cap it
 * would defer a bump the real pass would have made, pausing recurrence
 * evidence on a standing class.
 * SCOPE (adversarial review finding 3): this peek models ONLY the exact-title
 * pass — the common bump shape. The rarer dedup shapes (closed-ticket reopen,
 * cross-source link, incident-twin, adjudicated class) are NOT peeked: BELOW
 * cap the insert path catches them and the slot refund makes them budget-free
 * too; AT cap they never reach the insert (the cap branch continues first), so
 * they DEFER to the next pass/day — recurrence evidence on them pauses for a
 * day at worst, it is never lost. Fails OPEN (a DB/Redis error ⇒
 * "not a bump"): the reservation + refund around the insert stays the source
 * of truth, so a peek failure can only cause a momentary over-reservation
 * that is refunded, never a lost bump.
 */
async function isLikelyDedupBump(title: string): Promise<boolean> {
  try {
    const { wouldExactTitleDedupBump } = await import('../feedback/feedback.service');
    return await wouldExactTitleDedupBump({ title, type: 'bug_report' });
  } catch {
    return false;
  }
}

const defaultFileLogSignalTicket: FileLogSignalTicket = async (opts) => {
  // Dynamic import per the import-graph discipline (feedback.service is a
  // heavy module the platform-tools suites mock at the boundary).
  const { fileFeedbackTicket, normalizeFeedbackTitle } = await import('../feedback/feedback.service');
  const r = await fileFeedbackTicket({ userId: opts.userId, type: 'bug_report', title: opts.title, description: opts.description, priority: 2, area: 'framework', context: opts.context });
  if ('error' in r) {
    logger.warn(`${SOURCE}: ticket not filed (${r.error}): ${r.message}`, { source: SOURCE });
    return null;
  }
  const id = r.ticket?.id ? String(r.ticket.id) : '';
  if (!id) return null;
  const deduped = 'deduped' in r && r.deduped === true;
  if (deduped) {
    // A dedup hit is only THIS fingerprint's ticket when the row it landed on
    // is OUR dispatchable row: either the exact/reopen/fuzzy/adjudicated bump
    // (the row's title agrees with the fingerprint's stable title), or — for
    // a LINKED-DUPLICATE result (context.duplicateOf — cross-source /
    // incident-twin) — never: a linked row is status 'done', autoDispatch
    // false, a RECORD of another ticket, so caching its id would point the
    // week key at a row that never dispatches (ticket beb1788b — the
    // cross-source park carried the sweep's OWN title, so title agreement
    // alone could not catch it; feedback's system-filing guard now prevents
    // the park, this belt keeps the week cache honest if a future dedup
    // shape re-opens the hole).
    const got = normalizeFeedbackTitle(String(r.ticket?.title ?? ''));
    const ctx = (r.ticket?.context && typeof r.ticket.context === 'object' && !Array.isArray(r.ticket.context)
      ? r.ticket.context
      : {}) as Record<string, unknown>;
    const linkedDup = typeof ctx.duplicateOf === 'string' && ctx.duplicateOf.length > 0;
    if (linkedDup || got !== normalizeFeedbackTitle(opts.title)) {
      logger.warn(`${SOURCE}: ticket for ${opts.context?.fingerprintHash ?? '?'} deduped onto a ${linkedDup ? 'LINKED duplicate' : 'DIFFERENT title'}${linkedDup ? '' : ' row'} (${id.slice(0, 8)}) — not cached`, { source: SOURCE });
      return null;
    }
  }
  return { id, deduped };
};

export function logSignalTicketDescription(s: RecurringLogSignal, now: Date): string {
  const first = new Date(s.firstAt).toISOString();
  const last = new Date(s.lastAt).toISOString();
  const ruleLine = s.rule === 'rule2-suppression'
    ? `RULE 2 — broken suppression promise: the message promises "${s.promise}"${s.promisedWindowMs ? ` for ${Math.round(s.promisedWindowMs / 60000)} min` : ' (no explicit window parsed)'} yet ${s.count} occurrences landed${s.minGapMs !== null ? ` as close as ${Math.round(s.minGapMs / 60000)} min apart` : ''} inside the last 24 h.`
    : s.rule === 'rule1-hours'
      ? `RULE 1 — recurrence across ${s.hours} distinct hours (${s.count} rows in 24 h).`
      : `RULE 1 — recurrence across ${s.episodes} boot episodes (silence-separated clusters; ${s.count} rows in 24 h) — the once-per-worker-boot shape.`;
  return [
    `Fingerprint (normalized message): ${redactSweepSignal(s.fingerprint)}`,
    ruleLine,
    `Window: rows between ${first} and ${last}; levels ${s.levels.join('/') || '?'}; sources ${s.sources.slice(0, 4).join(', ') || 'unknown'}.`,
    `Example raw message (newest row, URL credentials scrubbed at write time, secret shapes redacted at sweep time — ticket 885614de):\n---\n${redactSweepSignal(s.exampleMessage).slice(0, 600)}\n---`,
    `Read the rows yourself: get_fleet_telemetry view 'errors' (hours 24, search a stable fragment of the fingerprint) or SELECT from app_error_logs WHERE message ILIKE '%<fragment>%' AND "createdAt" > now() - interval '24 hours'.`,
    'Fix shape: find the emitting site (grep the repo for a stable fragment), decide whether the recurrence is a defect (suppression state lost on deploy/restart, a retry storm, a standing failure class) or designed observability — if designed, silence this sweep via the LOG_SIGNAL_SWEEP_DISABLED / LOG_SIGNAL_SWEEP_TICKETS_DISABLED kill switches or fix the source; verify the class stops recurring (view \'metrics\' kind log_signal_sweep, or the fingerprint absent from the next day\'s alert).',
    `Auto-filed by the hourly log-signal-sweep cron (ticket 8a66441e). One ticket per fingerprint per ISO week; kill switches LOG_SIGNAL_SWEEP_DISABLED=1 (whole sweep) and LOG_SIGNAL_SWEEP_TICKETS_DISABLED=1 (tickets only). Filed ${now.toISOString()}.`,
  ].join('\n\n');
}

// ── Wake ─────────────────────────────────────────────────────────────────────

const hhmmz = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

export function renderLogSignalAlert(signals: ReadonlyArray<RecurringLogSignal>, tickets: ReadonlyArray<LogSignalTicket>, now: Date): string {
  const top = signals.slice(0, 5).map((s) => {
    const t = tickets.find((x) => x.fingerprintHash === fingerprintHash(s.fingerprint));
    const why = s.rule === 'rule2-suppression' ? `broken ${s.promise} promise` : s.rule === 'rule1-hours' ? `${s.hours} distinct hours` : `${s.episodes} boot episodes`;
    return `· ${redactSweepSignal(s.fingerprint).slice(0, 90)} — ${s.count}×/24h (${why})${t ? ` → ticket ${t.ticketId}${t.filed ? '' : ' (existing ticket, sighting recorded)'}` : ''}`;
  }).join('\n');
  return `[INFRA ALERT — recurring log signals] The hourly log-signal-sweep found ${signals.length} recurring warn/error fingerprint(s) in app_error_logs over the last 24 h as of ${hhmmz(now)}:\n${top}\nA recurring fingerprint is durable state misbehaving (suppression lost on deploy, a retry storm, a standing failure class) — the motivating case was a "quarantined for 6h" warn repeating every ~40 min across five worker boots. Playbook: read the rows (get_fleet_telemetry view 'errors' hours 24 with a fingerprint fragment in search), dispatch ONE lane per ticket id above through ticket-drain as with any framework ticket, and verify with get_fleet_telemetry view 'metrics' kind 'log_signal_sweep' that the class stops recurring the next day. Do not re-file tickets the sweep already cites.`;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface LogSignalSweepDeps {
  now?: Date;
  /** Wake seam (default: platform/hooks.service enqueueDirectWake). */
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
  /** Rows seam (default: prisma appErrorLog, newest LOG_SIGNAL_ROWS_CAP of the window, chronological). */
  fetchRows?: () => Promise<LogSignalRow[]>;
  /** Ticket insert seam (default: feedback.fileFeedbackTicket). */
  fileTicket?: FileLogSignalTicket;
  minHours?: number;
  minBootEpisodes?: number;
  spikeMin?: number;
  ticketsPerPass?: number;
  /** Daily NEW-filing budget override (aad94ed4) — default: the LOG_SIGNAL_TICKETS_PER_DAY env, else 5. */
  ticketsPerDay?: number;
}

export interface LogSignalSweepResult {
  rows: number;
  fingerprints: number;
  signals: number;
  ticketsFiled: number;
  ticketsBumped: number;
  /** Fingerprints whose filing the adjudication gate suppressed this pass (0ef6794e). */
  adjudicatedSuppressed: number;
  alerts: number;
  disabled?: boolean;
}

async function fetchWindowRows(now: Date): Promise<LogSignalRow[]> {
  // No .catch: a DB failure must surface in cron_jobs.lastStatus (the sweep's
  // own outer catch formats it) — swallowing it here would hide outages.
  // 7b2990fa SELF-EXCLUSION: this module's own failure warns persist to
  // app_error_logs stamped source='log-signal-sweep' (PrismaErrorTransport
  // honors logger's { source: SOURCE } meta) and would re-enter the NEXT
  // pass's input — after a multi-hour Redis outage the sweep would
  // fingerprint and ticket its own outage warns. Excluded at FETCH, the
  // earliest seam, so self rows never reach fingerprinting, ticket budget or
  // the wake. Prisma's notIn uses SQL NOT-IN three-valued logic and EXCLUDES
  // NULL sources (github.com/prisma/prisma#27622 — verified empirically by
  // this suite's mock), and source is NULL for most of the table (stackless
  // rows, transports without a source context), so a bare notIn would
  // silently blind the sweep to unattributed warns. The repo's established
  // null-keeping shape (ops-tools.ts, archive-scope.ts): OR the null branch
  // back in. Only spread when the exclusion list is non-empty — empty keeps
  // the pre-7b2990fa query exactly.
  const rows = (await (prisma as any).appErrorLog.findMany({
    where: {
      level: { in: ['warn', 'error'] },
      createdAt: { gte: new Date(now.getTime() - LOG_SIGNAL_WINDOW_MS) },
      ...(LOG_SIGNAL_SELF_EXCLUDE_SOURCES.length
        ? { OR: [{ source: null }, { source: { notIn: [...LOG_SIGNAL_SELF_EXCLUDE_SOURCES] } }] }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: LOG_SIGNAL_ROWS_CAP,
    select: { level: true, message: true, source: true, createdAt: true, context: true },
  })) as LogSignalRow[];
  // Newest N read (desc) → chronological for the gap/episode math.
  return rows.slice().reverse();
}

/**
 * One sweep. Never throws — a failure logs one warn and returns a summary
 * string for cron_jobs.lastStatus (finishCronJob truncates to 200 chars).
 */
export async function runLogSignalSweepOnce(deps: LogSignalSweepDeps = {}): Promise<string> {
  if (logSignalSweepDisabled()) return 'disabled (LOG_SIGNAL_SWEEP_DISABLED=1)';
  const now = deps.now ?? new Date();
  const counters: LogSignalSweepResult = { rows: 0, fingerprints: 0, signals: 0, ticketsFiled: 0, ticketsBumped: 0, adjudicatedSuppressed: 0, alerts: 0 };
  try {
    const fetched = await (deps.fetchRows ?? (() => fetchWindowRows(now)))();
    const rows = fetched.filter(r => !isNonFaultLogRow(r));
    counters.rows = rows.length;
    const fps = summarizeLogFingerprints(rows);
    counters.fingerprints = fps.length;
    const signals = classifyRecurringLogSignals(fps, { minHours: deps.minHours, minBootEpisodes: deps.minBootEpisodes });
    counters.signals = signals.length;

    // Tickets — one per fingerprint per ISO week, loudest first, capped at
    // LOG_SIGNAL_TICKETS_PER_PASS NEW filings per pass AND (aad94ed4) at
    // LOG_SIGNAL_TICKETS_PER_DAY NEW filings per UTC day: the per-pass cap
    // alone × an hourly cron was up to 72 new rows/day. The day budget is a
    // Redis INCR-first reservation shared by EVERY worker; a dedup BUMP
    // (recurrence evidence on a standing ticket) is budget-exempt — the peek
    // decides, and the insert path re-derives the truth (a refund corrects
    // any peek race). Fingerprints the day budget defers are NOT lost: the week
    // key is unclaimed, so the next hourly pass (or the next day) retries them.
    // d6fdc1df: the walk is no longer a fixed slice(0, perPass) — the loudest
    // signals are usually ALREADY ticketed (the week key cites them without
    // filing), so a fixed slice filed nothing all day while fresh classes sat
    // below it. The walk now skips cited/bumped/capped signals without burning
    // the per-pass budget and stops once perPass NEW tickets have filed; only
    // a NEW filing (counters.ticketsFiled) consumes it.
    const tickets: LogSignalTicket[] = [];
    let dayBudgetCapped = false;
    // 0ef6794e: per-fingerprint adjudication suppression — suppressed
    // fingerprints (evidence-gated designed classes) are skipped WITHOUT
    // spending per-pass/day budget, exactly like a cited week key; the count
    // rides counters.adjudicatedSuppressed into the pass telemetry.

    // Captured ONCE (adversarial review finding): the meta/summary below must
    // stamp the cap THIS pass enforced (deps override included), not a fresh
    // env read that could diverge from the decision mid-pass.
    const perDay = deps.ticketsPerDay ?? logSignalTicketsPerDay();
    const perPass = Math.max(1, deps.ticketsPerPass ?? LOG_SIGNAL_TICKETS_PER_PASS);
    if (signals.length && !logSignalTicketsDisabled()) {
      const week = isoWeekKeyOf(now);
      const day = now.toISOString().slice(0, 10);
      const filedKey = LOG_SIGNAL_FILED_KEY(day);
      const fileTicket = deps.fileTicket ?? defaultFileLogSignalTicket;
      const targets = await adminFleetSupervisors().catch(() => [] as FleetSupervisorRow[]);
      const userId = targets[0]?.userId ?? null; // infra is single-tenant; anonymous is allowed by the schema
      for (const s of signals) {
        // d6fdc1df: the per-pass budget counts NEW filings only — a cited
        // (week-key) signal, a BUMP, a deferred-by-day-cap signal or a failed
        // insert consumes nothing, so the walk keeps descending the list
        // instead of stopping at a fixed slice of already-ticketed loudest
        // signals.
        if (counters.ticketsFiled >= perPass) break;
        const fpHash = fingerprintHash(s.fingerprint);
        const key = TICKET_KEY(week, fpHash);
        let reserved = false; // hoisted for the catch below (throw-path refund, review finding)
        try {
          // Claim the week with a SHORT TTL: the claim only guards the in-flight
          // insert. If the worker dies between claim and insert the claim expires
          // within minutes and the next hourly sweep retries — a long claim would
          // silence the fingerprint for the rest of the week. The ticket ID is
          // then written under the same key with the full week TTL.
          const claimed = await (redisClient as any).set(key, 'filing', { NX: true, EX: LOG_SIGNAL_TICKET_CLAIM_TTL_SEC });
          if (claimed !== 'OK') {
            const existing = String((await (redisClient as any).get(key).catch(() => '')) || '');
            if (existing && existing !== 'filing') tickets.push({ fingerprint: s.fingerprint, fingerprintHash: fpHash, ticketId: existing, filed: false });
            continue;
          }
          // PER-FINGERPRINT ADJUDICATION SUPPRESSION (ticket 0ef6794e): before
          // spending ANY filing budget, ask the evidence gate whether this
          // fingerprint's class has already been adjudicated designed ≥2
          // cycles with a verified id-named replay pin — and the recurrence
          // is inside the verdict's own re-open bar and below the 3x-baseline
          // surge line. Suppressed ⇒ release the week claim (the NEXT pass
          // re-asks the gate; suppression is re-derived from the row every
          // hour, never cached in Redis) and continue: no insert, no budget,
          // no wake. The loop-metric row, the signal's future app_error_logs
          // rows and every other fingerprint keep recording — only the
          // weekly ticket churn stops. Fail direction: the gate reads ONE
          // row and every parse/DB failure inside it returns not-suppressed,
          // so filing behaves exactly as before.
          const adjudication = logSignalAdjudicatedSuppressionDisabled()
            ? null
            : await shouldSuppressFingerprintFiling({ title: logSignalTicketTitle(s.fingerprint), sightingCount: s.count });
          if (adjudication?.suppressed) {
            await (redisClient as any).del(key).catch(() => {});
            counters.adjudicatedSuppressed++;
            continue;
          }
          // Daily budget (aad94ed4): a dedup BUMP needs no budget (recurrence
          // evidence on a standing ticket must keep flowing at cap), so peek
          // first; otherwise reserve a slot INCR-first. When the day is spent,
          // refund the over-cap INCR, release the week claim (deferring THIS
          // fingerprint to the next day, NOT the whole week) and CONTINUE — a
          // later signal in this pass may still be a budget-exempt bump.
          if (!await isLikelyDedupBump(logSignalTicketTitle(s.fingerprint))) {
            // Shared INCR-first reservation (day-filing-budget.ts — the same
            // shape framework-signal-sweep uses since 2026-10-20).
            const slot = await reserveDayFilingSlot(redisClient as any, filedKey, perDay, LOG_SIGNAL_FILED_TTL_SEC);
            if (slot === 'capped') {
              await (redisClient as any).del(key).catch(() => {}); // release the claim — retry next day/pass
              dayBudgetCapped = true;
              continue; // NEW filings defer; later bumps still flow this pass
            }
            reserved = slot === 'reserved';
            // 'unknown' (Redis down): the day budget is unknowable — fail
            // OPEN (feedback's own caps still bound the insert; the next pass
            // re-counts). No phantom reservation, so nothing to refund below.
          }
          const ticket = await fileTicket({
            userId,
            title: logSignalTicketTitle(s.fingerprint),
            description: logSignalTicketDescription(s, now),
            context: { sessionId: logSignalTicketSessionId(fpHash), surface: 'system', origin: SOURCE, about: 'digby_platform', fingerprintHash: fpHash, rule: s.rule, count: s.count, week, day: now.toISOString().slice(0, 10), ...logSignalMetricContext(s) },
          });
          if (!ticket) {
            await (redisClient as any).del(key).catch(() => {}); // let the next sweep retry the filing
            if (reserved) await (redisClient as any).decr(filedKey).catch(() => {}); // a failed insert must not burn the day budget
            continue;
          }
          // Truth from the insert path (aad94ed4): a deduped result is a BUMP,
          // not a new filing — refund the slot the peek reserved. (When the
          // peek already exempted the bump, reserved is false: an unguarded
          // decr here would UNDERCOUNT the day — the peek-miss race is the
          // only shape that reserved and then bumped.) A queued row IS a new
          // filing (feedback stored a new ticket, rate-cap-held): the slot
          // stands. Both land in the tickets[] wake payload as before.
          if (ticket.deduped && reserved) await (redisClient as any).decr(filedKey).catch(() => {});
          await (redisClient as any).set(key, ticket.id, { EX: LOG_SIGNAL_TICKET_TTL_SEC }).catch(() => {});
          tickets.push({ fingerprint: s.fingerprint, fingerprintHash: fpHash, ticketId: ticket.id, filed: !ticket.deduped, ...(ticket.deduped ? { deduped: true } : {}) });
          if (ticket.deduped) counters.ticketsBumped++; else counters.ticketsFiled++;
        } catch (err: any) {
          // Throw-path refund (adversarial review finding, empirically confirmed
          // by its probe: counter read "1" after a throw with 0 tickets filed):
          // an insert that THROWS after a reservation burned a day slot and
          // stranded the week claim until its TTL. Same refund + release shape
          // as the null-return path above — a transient DB failure between INCR
          // and insert can only defer this fingerprint to the next pass, never
          // under-file the rest of the day.
          if (reserved) await (redisClient as any).decr(filedKey).catch(() => {});
          await (redisClient as any).del(key).catch(() => {}); // release the claim — the next sweep retries
          logger.warn(`${SOURCE}: ticket filing failed for ${fpHash} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
        }
      }
    }

    // Wake — one per UTC day, only when there is something actionable to cite:
    // a ticket FILED or BUMPED this pass (merely citing a week-key-cached
    // ticket is NOT actionable — otherwise every standing class would wake the
    // supervisor daily; finding N1 of the adversarial review), or a pure spike
    // when tickets are off.
    const spikeMin = deps.spikeMin ?? LOG_SIGNAL_SPIKE_MIN;
    const actionable = tickets.some((t) => t.filed || t.deduped) || (logSignalTicketsDisabled() && signals.some((s) => s.count >= spikeMin));
    if (actionable) {
      try {
        const targets = await adminFleetSupervisors();
        if (targets.length) {
          const wake = deps.enqueueDirectWake ?? (async (o: Parameters<NonNullable<LogSignalSweepDeps['enqueueDirectWake']>>[0]) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
          const day = now.toISOString().slice(0, 10);
          counters.alerts = await deliver(targets, `${SOURCE}:alert:${day}`, LOG_SIGNAL_ALERT_DEDUPE_SEC, renderLogSignalAlert(signals, tickets, now), { kind: 'log_signal', signals: signals.length, top: signals.slice(0, 3).map((s) => ({ fingerprint: redactSweepSignal(s.fingerprint).slice(0, 90), rule: s.rule, count: s.count })), tickets: tickets.map((t) => ({ fingerprintHash: t.fingerprintHash, ticketId: t.ticketId, filed: t.filed })) }, wake, LOOP_METRIC_KINDS.LOG_SIGNAL_SWEEP);
        }
      } catch (err: any) {
        logger.warn(`${SOURCE}: alert wake failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
      }
    }

    try {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.LOG_SIGNAL_SWEEP,
        value: counters.signals,
        unit: 'signals',
        meta: {
          rows: counters.rows, fingerprints: counters.fingerprints, signals: counters.signals,
          ticketsFiled: counters.ticketsFiled, ticketsBumped: counters.ticketsBumped, alerts: counters.alerts,
          // 0ef6794e: fingerprints whose weekly filing the evidence-gated
          // adjudication gate suppressed this pass — the observable signal in
          // view 'metrics' kind log_signal_sweep that adjudicated designed
          // classes are no longer re-litigated weekly.
          adjudicatedSuppressed: counters.adjudicatedSuppressed,
          windowH: Math.round(LOG_SIGNAL_WINDOW_MS / 3_600_000),
          // aad94ed4: the daily NEW-filing budget stopped this pass from filing
          // (remaining fingerprints defer to the next pass/day) — the cap's
          // observable signal in view 'metrics' kind log_signal_sweep.
          ...(dayBudgetCapped ? { capped: true, dayCap: perDay } : {}),
        },
      });
    } catch { /* telemetry never blocks the sweep */ }

    const summary = `rows ${counters.rows}, fingerprints ${counters.fingerprints}, signals ${counters.signals}, tickets filed ${counters.ticketsFiled} bumped ${counters.ticketsBumped}, adjudicated suppressed ${counters.adjudicatedSuppressed}, alert ${counters.alerts ? 'sent' : 'no'}${dayBudgetCapped ? `, day cap hit (${perDay}/day)` : ''}`;
    logger.info(`${SOURCE}: ${summary}`, { source: SOURCE });
    return summary;
  } catch (err: any) {
    logger.warn(`${SOURCE}: sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return `error: ${String(err?.message ?? err).slice(0, 160)}`;
  }
}
