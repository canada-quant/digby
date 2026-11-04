/**
 * SYSTEM-FIRST message normalization for strict OpenAI-compatible backends
 * (ticket 68167bbf, 2026-10-28).
 *
 * THE INCIDENT: coding-agent turns routed to `tt-qwen3.8-flash-next` (vLLM on
 * the Tenstorrent Quietbox) failed DETERMINISTICALLY every turn from at least
 * 2026-10-28T18:28Z with
 *   litellm.BadRequestError: OpenAIException - messages[2].role is system; the
 *   system message must be first
 * followed by "No fallback model group found". The platform's own 400
 * fingerprint named the shape: `system:53440 user:2407 system:265` — THREE
 * messages with a TRAILING 265-char system message after the user turn.
 *
 * That 265 chars is exactly the agent loop's per-turn `[HARNESS CLOCK]` note
 * (`buildCodingClockNote` — 265 chars for a UTC+tz rendering), pushed before
 * every model call and spliced out after (agent.ts, the transient-notes
 * pattern: clock / plan reminder / evidence ledger / tool-group + tool-trim
 * notices). On Moonshot / ZAI / DeepSeek a trailing system note is fine and is
 * deliberately the MOST RECENT context; on a strict OpenAI-compatible
 * deployment (vLLM's chat template) it is a hard 400.
 *
 * WHY THE STORM: that 400 matched no deterministic fingerprint
 * (seat-invalid-request.ts recognises tools/effort/param/model/context), so it
 * fell to the loop's SPURIOUS-in-budget-400 lane (ticket 4251dcb3): 3 backoffs
 * of the IDENTICAL payload + 2 context shrinks, then "5 retries" and an
 * aborted turn — every single turn, forever, because nothing in that budget
 * can change the ORDER of the messages.
 *
 * THE FIX (two halves, both here):
 *   1. `hoistSystemMessages` — merge EVERY system message into ONE leading
 *      system message (content preserved in document order, so the per-turn
 *      note ends the system block, immediately before the user turns: recency
 *      is kept as far as a system-first backend allows).
 *   2. a per-(endpoint, model) LEARNED latch — a backend proves it is strict
 *      by rejecting once; from then on this process normalizes BEFORE dispatch
 *      so no later turn pays the rejection (`latchSystemFirst`). Nothing is
 *      assumed about a backend that never rejects: Moonshot prefix-caching
 *      depends on a byte-stable leading system block, and hoisting a per-turn
 *      clock note into it would change the prefix every turn and destroy the
 *      cache hit rate (K3 coding runs re-ship a ~53k prefix per turn) — so the
 *      normalization is NEVER applied speculatively to a backend that has not
 *      asked for it.
 *
 * Kill switch: SYSTEM_FIRST_NORMALIZE_DISABLED=1 (normalization off; the
 * rejection classifier still runs so the loop can fail fast instead of
 * storming — see agent.ts's deterministic-400 lane).
 *
 * ── DURABILITY (ticket 5809b75f, 2026-10-29): THE LATCH USED TO DIE WITH THE
 * PROCESS. The +24h did-it-work re-measure for 68167bbf found the storm gone
 * but 16 fresh rows on the runModelTurn surface, EVERY ONE of them
 * `system_first_replay` / `outcome:'rejected_latched'` (loop_metrics, verbatim
 * `{"spec":"llm-cql:tt-qwen3.8-flash-next","outcome":"rejected_latched",
 * "systemCount":2}`) and ZERO `lane:'message_order'` give-up rows. That pair of
 * facts is decisive: the hoist REPAIRED every turn (the fix worked), but each
 * process PAID one rejection to re-learn what a previous process already knew,
 * because `strictSeats` is an in-memory Set. This fleet deploys continuously
 * (measured: 93 successful deploy waves in 24h), so "once per process" was
 * really "once per wave" — a steady drip of warn rows that a sweep reads as a
 * regression. The latch is now mirrored to Redis (best-effort, fail-open) and
 * hydrated once per process, so a restart INHERITS the seat's strictness
 * instead of buying it again with a live 400.
 *
 * Best-effort by construction: no Redis, a Redis error, or a jest worker leaves
 * the in-memory behaviour EXACTLY as it was before this change (the process
 * just pays its one rejection like it used to). Nothing here can fail a turn.
 *
 * Leaf discipline: the only static import is still the shared content-parts
 * helper; the Redis client is reached through a LAZY require (the
 * batch-train.service precedent) because config/redis validates env at load
 * time and calls process.exit(1) on a ZodError — which would kill a jest
 * worker outright.
 */

import { toParts } from './chat-images';

/**
 * A provider body naming the system-message ORDER as the problem. Deliberately
 * narrow: it must name a system message AND its position/firstness, so genuine
 * content / size / capability rejections never match.
 *
 * Real shapes (verbatim):
 *   vLLM / LiteLLM: "messages[2].role is system; the system message must be first"
 *   OpenAI TGI   : "System message must be at the beginning of the conversation"
 *   llama.cpp    : "system prompt must be the first message"
 */
export const SYSTEM_ORDER_REJECTION_RE = new RegExp(
  [
    // "messages[2].role is system" — the exact incident phrasing.
    String.raw`messages?\[\d+\]\.role\s+is\s+system`,
    // "the system message must be first" / "must be at the beginning".
    String.raw`system\s*(?:message|prompt|role)[^.]{0,120}?(?:must|should|has to|needs to)\s+be\s+(?:the\s+)?(?:first|at\s+the\s+(?:beginning|start|top)|before)`,
    // "system prompt must be the first message" (llama.cpp wording).
    String.raw`system\s*(?:message|prompt)[^.]{0,80}?(?:is|must\s+be)\s+(?:the\s+)?first`,
    // "only one system message is allowed" / "multiple system messages".
    String.raw`(?:only\s+one|multiple|more\s+than\s+one)\s+system\s*(?:messages?|prompts?)|system\s*(?:messages?|prompts?)[^.]{0,60}?(?:only\s+allowed|not\s+allowed|must\s+be\s+(?:first|merged))`,
  ].join('|'),
  'i',
);

/** True when a provider body names the system-message ORDER as the rejection cause. */
export function isSystemOrderRejection(text: string | undefined | null): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return SYSTEM_ORDER_REJECTION_RE.test(t);
}

export function systemFirstNormalizeDisabled(): boolean {
  const v = String(process.env.SYSTEM_FIRST_NORMALIZE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ── Learned strictness latch — DURABLE since ticket 5809b75f ─────────────────
// The same doctrine as the cache-params / reasoning-replay / thinking-off /
// output-cap latches: a provider that rejects a shape has taught us something
// durable about THIS (endpoint, model) pair, so never pay it twice. Unlike the
// others, this one is MIRRORED TO REDIS: "once per process" is really "once per
// deploy wave" in a fleet that shipped ~93 successful waves in 24h (measured
// 2026-10-29), so every restart re-bought the same lesson with a live 400 —
// the steady drip this ticket exists for.
const strictSeats = new Set<string>();

/** Redis SET of `systemFirstKey` values for seats that REQUIRE system-first. */
const LATCH_REDIS_KEY = 'cm:system-first:strict';
/** A latch should outlive many deploys. NOTE the TTL is on the SHARED set, not
 *  per seat: any seat's latch refreshes it for all of them, so the set lapses
 *  only when NO seat is latched for this long (not "this seat went quiet").
 *  There is deliberately no removal path — an incorrectly-latched seat is
 *  re-probed by `redis-cli SREM cm:system-first:strict <url|model>`, or the
 *  whole class by SYSTEM_FIRST_NORMALIZE_DISABLED=1 (box env, no deploy). */
const LATCH_TTL_SEC = 90 * 24 * 60 * 60;

/**
 * Lazy redis accessor — NEVER require config/redis inside a jest worker: its
 * top-level env validation calls process.exit(1) on a ZodError, which cannot be
 * caught and kills the worker (batch-train.service's recorded precedent).
 * Returns null there, so every caller fails open to the in-memory behaviour.
 */
let testRedis: any | null | undefined;

/**
 * Test seam: inject a fake client so the durable path is testable at all —
 * `JEST_WORKER_ID` (below) deliberately makes the real accessor return null
 * inside jest. Pass `null` to simulate "no redis", `undefined` to restore.
 */
export function __setSystemFirstRedisForTests(r: any | null | undefined): void {
  testRedis = r;
  hydration = null;
}

function lazyRedis(): any | null {
  if (testRedis !== undefined) return testRedis;
  if (process.env.JEST_WORKER_ID) return null;
  // Guard BEFORE the require, the view-mode.ts:28 precedent: config/redis
  // validates env at load time and process.exit(1)s on a ZodError, which no
  // try/catch can intercept — an out-of-band entrypoint with a partial env
  // would hard-exit just by importing this module.
  if (!process.env.REDIS_URL) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../config/redis');
    return mod?.default ?? mod ?? null;
  } catch { return null; }
}

let hydration: Promise<void> | null = null;

/** Bound on how long the durable read may delay a turn. node-redis QUEUES
 *  commands while its socket is down, so an unreachable Redis would otherwise
 *  put a connect timeout in front of the first turn of every process — the
 *  latch is an optimisation and must never cost a turn more than this. */
const HYDRATE_TIMEOUT_MS = 750;

/**
 * Hydrate the durable latch into this process ONCE (idempotent). Never throws
 * and never blocks a turn on a Redis failure — a miss just means this process
 * pays its one rejection, i.e. exactly the pre-5809b75f behaviour.
 */
export function ensureSystemFirstLatchHydrated(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const redis = lazyRedis();
      // No client (no REDIS_URL, a jest worker, or a failed require) — clear the
      // memo so a LATER turn retries once one exists.
      if (!redis) { hydration = null; return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const members: unknown = await Promise.race([
        (redis as any).sMembers(LATCH_REDIS_KEY),
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), HYDRATE_TIMEOUT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      // A TIMEOUT also lands here (race resolves undefined — it is not a throw),
      // so the miss must be detected by SHAPE, not only by catch: node-redis
      // QUEUES commands while its socket is down, so a read issued during a
      // reconnect never settles and always loses the race. Memoizing that would
      // leave the process permanently pre-fix — the exact bug this ticket
      // fixes (reviewer B1, PR #2099).
      if (!Array.isArray(members)) { hydration = null; return; }
      for (const m of members) if (typeof m === 'string' && m) strictSeats.add(m);
    } catch {
      // Fail open — in-memory only. Clear the memo so a LATER turn retries.
      hydration = null;
    }
  })();
  return hydration;
}

/** Stable key for a (endpoint, model) pair — the seat, not the run. */
export function systemFirstKey(provider: { url?: string; model?: string } | null | undefined): string {
  const url = String(provider?.url ?? '').trim();
  const model = String(provider?.model ?? '').trim();
  if (!url && !model) return '';
  return `${url}|${model}`;
}

/** Has this (endpoint, model) already rejected the request for message ORDER? */
export function systemFirstLatched(provider: { url?: string; model?: string } | null | undefined): boolean {
  const key = systemFirstKey(provider);
  return key !== '' && strictSeats.has(key);
}

/**
 * Does this seat belong to a CUSTOM ENDPOINT (a self-hosted / LiteLLM fronted
 * deployment)? Those are the backends whose strictness is a real, durable
 * property, so only they are mirrored to Redis.
 *
 * WHY SCOPED (review N1, PR #2099): the rejection classifier is deliberately
 * broad, and a mis-classified 400 used to cost one process. Mirroring EVERY
 * seat would turn a single mis-fire into a 90-day FLEET-WIDE normalization for
 * a frontier provider — and hoisting a per-turn clock note into the leading
 * system block destroys Moonshot prefix caching (the very reason normalization
 * is not speculative, coding-model.ts:1519). Built-ins therefore keep the
 * in-memory latch they always had: a mis-fire dies with the process.
 */
function isCustomEndpointSeat(provider: { label?: string } | null | undefined): boolean {
  return String(provider?.label ?? '').endsWith('(custom endpoint)');
}

/** Record that this (endpoint, model) requires a leading-only system message. */
export function latchSystemFirst(provider: { url?: string; model?: string; label?: string } | null | undefined): boolean {
  const key = systemFirstKey(provider);
  if (!key) return false;
  const wasNew = !strictSeats.has(key);
  strictSeats.add(key);
  // Mirror to Redis so the NEXT process inherits this instead of re-buying the
  // 400 (ticket 5809b75f). Fire-and-forget: a redis failure must never touch
  // the turn, and the in-memory latch already holds for this process.
  if (isCustomEndpointSeat(provider)) {
    try {
      const redis = lazyRedis();
      if (redis) {
        void (async () => {
          try {
            await (redis as any).sAdd(LATCH_REDIS_KEY, key);
            await (redis as any).expire(LATCH_REDIS_KEY, LATCH_TTL_SEC);
          } catch { /* best-effort mirror */ }
        })();
      }
    } catch { /* no redis — in-memory only */ }
  }
  return wasNew;
}

/** Test hook — clears the process-wide strictness latch (and the hydration
 *  memo, so a test can simulate a FRESH process re-learning from Redis). */
export function __resetSystemFirstLatchForTests(): void {
  strictSeats.clear();
  hydration = null;
}

export interface HoistResult {
  messages: any[];
  /** False ⇒ the input already had at most one system message and it led. */
  changed: boolean;
  /** How many system messages were folded into the leading one (>1 means merged). */
  systemCount: number;
}

/**
 * Merge EVERY `role:'system'` message into ONE leading system message.
 *
 * Content is preserved in DOCUMENT ORDER and joined with a blank line, so the
 * last-pushed per-turn note (the harness clock) ends the system block — as
 * close to "most recent" as a system-first backend permits. All-string traffic
 * collapses back to a plain string (ZAI/GLM rejects array content, error
 * 1214); a non-text part (never produced by the harness notes, but possible
 * from a caller) keeps the merged content as a parts array.
 *
 * Everything that is not a system message keeps its relative order, so tool
 * linkage (assistant tool_calls → tool results) is untouched. Pure: the input
 * array and its messages are never mutated.
 */
export function hoistSystemMessages(messages: any[]): HoistResult {
  const input = Array.isArray(messages) ? messages : [];
  const systems: any[] = [];
  const rest: any[] = [];
  for (const m of input) {
    if (m && typeof m === 'object' && (m as any).role === 'system') systems.push(m);
    else rest.push(m);
  }
  const systemCount = systems.length;
  const alreadyFirstish = systemCount === 1 && input[0] && (input[0] as any).role === 'system';
  if (alreadyFirstish) return { messages: input, changed: false, systemCount };
  if (systemCount === 0) return { messages: input, changed: false, systemCount: 0 };

  // Collect every part, in document order.
  const parts: Array<{ type: string; [k: string]: any }> = [];
  for (const s of systems) parts.push(...toParts((s as any).content));
  const allText = parts.every((p) => p && p.type === 'text');
  const content = allText
    ? parts.map((p) => String(p.text ?? '')).filter((t) => t.trim() !== '').join('\n\n')
    : parts;

  // A merged block with nothing usable in it is worth nothing to the model —
  // but dropping it would change semantics, so keep it verbatim as one message.
  const leading: any = { role: 'system', content: allText && content === '' ? '' : content };
  return {
    messages: [leading, ...rest],
    changed: true,
    systemCount,
  };
}