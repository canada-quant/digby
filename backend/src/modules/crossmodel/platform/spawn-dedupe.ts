/**
 * Spawn identity + dedupe policy for `start_coding_session` (ticket d1120ffc,
 * 2026-11-02 — "a single start_coding_session triple-fires into duplicate
 * lanes").
 *
 * THE REPORTED SHAPE. ONE dispatch produced three lanes: the chartered lane
 * plus a duplicate with its own branch, own worktree and its own plan — a whole
 * model run and a share of the project's spend burned on a lane nobody asked
 * for. The reporter's own summary of the cause is the design brief:
 *
 *   "An agent that retries a spawn on timeout will multiply lanes; the dedupe
 *    key appears to be absent for the spawn path."
 *
 * And it was: every existing guard on this path is a VOLUME bound (the 8/h
 * per-parent cap, the project-supervisor storm breaker, the concurrency
 * ceiling). None of them asks "is this the SAME spawn I already made?". The
 * topology pre-check (platform/session-topology.ts R1) asks a related question
 * but on the goal→lane index and it ships OBSERVE-ONLY by default, so it can
 * only advise.
 *
 * WHAT THIS IS. A deterministic IDENTITY for a spawn request — caller chat +
 * project + charter (goalId / todoId) + title + a digest of the brief — so two
 * calls that mean the same thing produce the same key, and a short-lived
 * CLAIM on that key makes the second one return the FIRST lane instead of
 * creating another. Identity, not similarity: a different goal, todo, title or
 * brief is a different key and spawns as before. This leaf is PURE (no imports
 * at all) and holds the policy; the claim/lookup wiring lives in
 * platform-tools.ts, which already owns the dynamic-import discipline for
 * prisma and redis.
 *
 * WHY A SHORT WINDOW (default 60 s). The failure being fixed is a RETRY —
 * a timeout, a requeue, a double-fired turn — not "the same work next week".
 * A lane that legitimately needs a second worker for the same goal hours later
 * must not be silently starved by a stale key, so the claim expires.
 *
 * WHY REDIS. The duplicate can come from a DIFFERENT process than the original
 * (a deploy requeue, or the same chat woken on another box), so an in-process
 * map would miss exactly the reported case. Redis is already the shared store
 * this codebase uses for cross-box claims (worker slots, storm windows,
 * notify dedupe) and `platform-tools.ts` already dynamic-imports it elsewhere.
 *
 * OPERATOR CONTROL. `DIGBY_SPAWN_DEDUPE_WINDOW_SEC` sets the window; `0` (or an
 * unparseable value below zero) turns dedupe OFF and restores today's
 * spawn-always behaviour without a deploy. Deliberately NOT a `*_DISABLED`
 * switch: this is a tunable duration, not a release gate, and a new switch row
 * needs a ledger justification (RSW-1). Precedent: DIGBY_MAX_CHILD_SPAWNS_PER_HOUR.
 */

import { createHash } from 'crypto';

/** Default claim window: a retry / double-fire / requeue lands well inside it. */
export const SPAWN_DEDUPE_DEFAULT_WINDOW_SEC = 60;
/** An operator cannot pin a claim so long that legitimate follow-on work starves. */
export const SPAWN_DEDUPE_MAX_WINDOW_SEC = 600;
/** The in-flight sentinel a claim holds until its lane id is known. */
export const SPAWN_DEDUPE_PENDING = 'pending';
/** Grace after which a still-`pending` claim is treated as abandoned by a dead caller. */
export const SPAWN_DEDUPE_STALE_GRACE_MS = 5_000;

/**
 * A pending claim's value: `pending:<epochMs>`. The timestamp rides the VALUE so
 * a claim's age is readable in every store — including Redis, where a TTL says
 * only how long is LEFT and never when the claim was taken (see
 * spawn-claim-store.ts ageSec). Pure.
 */
export function pendingClaimValue(nowMs: number = Date.now()): string {
  return `${SPAWN_DEDUPE_PENDING}:${Math.max(0, Math.floor(nowMs))}`;
}

/**
 * How long a claim has been held, from its VALUE — null when it does not carry a
 * readable stamp (a bare legacy `pending`, or a lane id). Pure.
 */
export function claimAgeMs(value: unknown, nowMs: number = Date.now()): number | null {
  const v = typeof value === 'string' ? value : '';
  if (!v.startsWith(`${SPAWN_DEDUPE_PENDING}:`)) return null;
  const stamp = Number(v.slice(SPAWN_DEDUPE_PENDING.length + 1));
  if (!Number.isFinite(stamp) || stamp <= 0) return null;
  return Math.max(0, nowMs - stamp);
}

/**
 * Is a still-`pending` claim ABANDONED? True only when its age is past the grace
 * window — which is the honest repair for the review's B3: a caller that died
 * (or whose lane-id write failed) would otherwise leave every identical spawn
 * from that chat refused for the whole window, pointing at a lane that was never
 * created. An unreadable age is NOT abandoned (fail-closed: keep refusing rather
 * than risk the double spawn this whole seam exists to prevent). Pure.
 */
export function isAbandonedPendingClaim(value: unknown, nowMs: number = Date.now()): boolean {
  if (!isPendingClaim(value)) return false;
  const age = claimAgeMs(value, nowMs);
  return age !== null && age >= SPAWN_DEDUPE_STALE_GRACE_MS;
}

/** Is this claim value the in-flight sentinel (any vintage)? Pure. */
export function isPendingClaim(value: unknown): boolean {
  const v = typeof value === 'string' ? value.trim() : '';
  return v === SPAWN_DEDUPE_PENDING || v.startsWith(`${SPAWN_DEDUPE_PENDING}:`);
}

/**
 * The dedupe window in ms. Unset → 60 s. `0` (or negative / NaN) → 0, which
 * means dedupe is OFF. Anything above the cap is clamped. Pure.
 */
export function spawnDedupeWindowMs(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const raw = String((env as Record<string, string | undefined>).DIGBY_SPAWN_DEDUPE_WINDOW_SEC ?? '').trim();
  if (!raw) return SPAWN_DEDUPE_DEFAULT_WINDOW_SEC * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(SPAWN_DEDUPE_MAX_WINDOW_SEC, Math.floor(n)) * 1000;
}

/** Everything that makes two spawn calls "the same spawn". */
export interface SpawnIdentity {
  /** The chat that called the tool — two DIFFERENT callers are never the same spawn. */
  callerChatId?: string | null;
  /** The project the lane lands in. */
  projectId?: string | null;
  /** The charter the lane is bound to (either half). */
  goalId?: string | null;
  todoId?: string | null;
  /** The deliverable title, when one was supplied. */
  title?: string | null;
  /** The first-prompt brief — digested, never stored. */
  prompt?: string | null;
}

/**
 * The claim key: `digby:spawn:dedupe:<40 hex>`. null when the call states NO
 * distinguishing intent — and that null is a deliberate safety rule, not a
 * gap: a spawn with no title, no charter and no brief has nothing saying two
 * calls mean the SAME work, so merging them would silently swallow a legitimate
 * second blank lane ("create an idle session, I'll brief it in a moment"). The
 * ticket's own key spec is "same goalId/todoId/title within a short window",
 * i.e. a STATED identity — so dedupe requires one of those three (or a brief,
 * which is even stronger evidence of intent). Also null without a caller chat:
 * an ungrouped caller has no "same chat" to retry from, and keying on the
 * payload alone would merge two unrelated users' identical titles. Pure.
 */
export function spawnDedupeKey(input: SpawnIdentity): string | null {
  const caller = String(input.callerChatId ?? '').trim();
  if (!caller) return null;
  const norm = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const title = norm(input.title);
  const prompt = norm(input.prompt);
  const goalId = norm(input.goalId);
  const todoId = norm(input.todoId);
  // No stated intent ⇒ no identity ⇒ no dedupe (see above).
  if (!title && !prompt && !goalId && !todoId) return null;
  const parts = [
    `caller:${caller}`,
    `project:${norm(input.projectId)}`,
    `goal:${goalId}`,
    `todo:${todoId}`,
    `title:${title}`,
    // The brief is digested so a 10 KB prompt never becomes a 10 KB Redis key,
    // and so two different briefs under one title are correctly DIFFERENT work.
    `prompt:${prompt ? createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16) : ''}`,
  ];
  const digest = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 40);
  return `digby:spawn:dedupe:${digest}`;
}

/** Is this claim value a lane id (as opposed to the in-flight sentinel)? Pure. */
export function isSpawnClaimLaneId(value: unknown): value is string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || isPendingClaim(v)) return false;
  return true;
}

/**
 * The model-facing answer when a spawn was NOT created because an identical one
 * already landed. Shaped exactly like `toolResultEnvelope` (ok / tool / ids /
 * message) PLUS the `deduplicated: true` flag the tool-intent journal already
 * reads as a REPLAY (coding/tool-intents.ts classifyIntentOutcome), so the
 * second call settles `replayed` and is never counted as an executed action.
 * `ageSec` is reported when known so the caller can judge whether it is looking
 * at its own retry or at older work. Pure.
 */
export function renderSpawnReplay(o: {
  sessionId: string;
  projectId?: string | null;
  title?: string | null;
  ageSec?: number | null;
}): string {
  const age = typeof o.ageSec === 'number' && Number.isFinite(o.ageSec) && o.ageSec >= 0
    ? ` ${Math.round(o.ageSec)} s ago`
    : ' moments ago';
  const name = o.title ? ` "${o.title}"` : '';
  return JSON.stringify({
    ok: true,
    tool: 'start_coding_session',
    deduplicated: true,
    ids: { sessionId: o.sessionId, ...(o.projectId ? { projectId: o.projectId } : {}) },
    message: `No new session was created — an IDENTICAL start_coding_session from this chat already opened lane ${o.sessionId}${name}${age} `
      + '(same caller chat, project, charter goal/todo, title and brief). Reusing that lane instead of burning a second worktree and run. '
      + `Steer it with send_chat_message(chatId:"${o.sessionId}", ...), watch it with get_chat_status(chatId:"${o.sessionId}"), `
      + 'or — if you genuinely need a SECOND lane for different work — change the title or the brief (or the charter) and re-issue: '
      + 'a different identity is a different spawn and is never deduplicated.',
  });
}