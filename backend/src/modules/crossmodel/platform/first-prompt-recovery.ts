/**
 * Durable FIRST-PROMPT delivery for spawned coding sessions (nightly finding
 * 2026-08-28: three empty "Ticket batch" coding chats — 86243a27 (08-28),
 * dd259760 (08-27), 13e2cb78 (08-23) — all status 'ready', ZERO messages.
 * ticket-dispatch's trySpawnBatchSession had logged the spawn as successful,
 * so the batch silently never ran = lost work).
 *
 * THE BUG: startCodingSession's optional prompt was delivered ONLY by a
 * fire-and-forget in-memory poll (deliverPromptWhenReady, bounded ~5 min). A
 * process restart/deploy between session creation and workspace-ready — or
 * provisioning slower than 5 minutes — killed the promise; the prompt was
 * never persisted anywhere, so the chat sat ready-and-empty forever.
 *
 * THE FIX: the prompt is stashed in Redis at creation (Redis survives app
 * deploys — admin-redis-prod is not rebuilt by blue-green), and TWO paths
 * deliver it race-safely:
 *   1. the existing fast path (deliverPromptWhenReady) — instant in the
 *      common case, passing its in-memory prompt as the fallback for a
 *      failed stash;
 *   2. this sweeper (one per WEB instance, 60s — mirrors
 *      startChatOrphanSweeper) — catches sessions still ready+empty after a
 *      grace window.
 * Both paths funnel through deliverPendingFirstPrompt, which takes a
 * per-session Redis lock and re-reads the pending key inside the lock before
 * sending — fast path and sweeper can never double-deliver, and blue-green
 * overlap is structurally safe.
 *
 * ORIGIN THREADING (ticket 2e9e5264, 2026-09-14): the pre-fix delivery sent
 * the prompt with NO origin, so sendChatMessage defaulted it to 'user' and a
 * MACHINE-spawned session's (ticket-dispatch batch / start_coding_session
 * tool) first run was stamped origin 'user' — triggerKind 'user' in
 * run-executor, which bypassed every machine-run gate keyed on
 * machineTriggered (the zero-tool evidence gate, the outbound-claim audit)
 * and made fleet/journal telemetry count a machine turn as a HUMAN turn.
 * The author's origin now rides the stash: with an origin the payload is
 * JSON { prompt, origin }; without one it stays the legacy plain prompt
 * string (zero delta for the human-UI path, and pre-fix stashes still
 * deliver — read side accepts BOTH shapes).
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

const SOURCE = 'first-prompt-recovery';

/** Fleet origin of the first prompt's AUTHOR (ticket 2e9e5264): 'agent' for
 *  tool-spawned (start_coding_session) and dispatch-spawned (ticket batch)
 *  sessions; omitted for a human UI-created session (sendChatMessage then
 *  defaults 'user', the pre-fix behavior). Same shape as sendChatMessage's
 *  origin. `userTurnAt` (ISO; cohesive chat live fixes 2026-09-28,
 *  platform/human-spawn.ts) rides ONLY for a HUMAN-spawned child — the
 *  parent turn's anchor, so the child's first run is classified 'user'
 *  (never "unattended machine-triggered", never auto-denied); a machine
 *  spawn carries none and the first run stays unable to confirm pendings. */
export type FirstPromptOrigin = { kind: 'user' | 'agent' | 'webhook'; sourceChatId?: string; userTurnAt?: string };

/** Env-knob parse with a garbage clamp (orphan-recovery review-N5 idiom):
 *  Number('junk') is NaN and setInterval(NaN) is a ~1ms hot sweep. */
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const SWEEP_INTERVAL_MS = () => envMs('CODING_FIRST_PROMPT_SWEEP_INTERVAL_MS', 60_000);
/** A ready session younger than this is still the fast path's business. */
const EMPTY_GRACE_MS = () => envMs('CODING_FIRST_PROMPT_EMPTY_GRACE_MS', 3 * 60_000);
/** How long a stashed prompt survives waiting for delivery. */
const PENDING_TTL_MS = 24 * 60 * 60_000;
/** Per-session delivery lock (bounds duplicate delivery across instances). */
const LOCK_TTL_MS = 5 * 60_000;
const SWEEP_BATCH = 20;

const PENDING_KEY = (chatId: string) => `coding:first-prompt:pending:${chatId}`;
const LOCK_KEY = (chatId: string) => `coding:first-prompt:lock:${chatId}`;

/** Persist the first prompt at session creation. Never throws — a failed
 *  stash degrades to the pre-fix in-memory-only behavior (fast path still
 *  carries the prompt). Returns whether the stash LANDED: the caller passes
 *  its in-memory prompt as the delivery fallback ONLY on false — a stashed
 *  prompt that later reads null was already delivered (by us or the
 *  sweeper), and re-sending the in-memory copy would double-fire the
 *  session (adversarial-review F1: 'already' must be reachable on the fast
 *  path). */
export async function stashPendingFirstPrompt(chatId: string, prompt: string, origin?: FirstPromptOrigin): Promise<boolean> {
  try {
    // Payload shape (ticket 2e9e5264): WITH an origin the stash is JSON
    // { prompt, origin } so the author's provenance survives to whichever
    // path delivers it (the sweeper has no in-memory copy); WITHOUT one the
    // stash stays the legacy plain prompt string — zero delta for the
    // human-UI path. The read side (parsePendingFirstPrompt) accepts BOTH.
    const payload = origin ? JSON.stringify({ prompt, origin }) : prompt;
    await redisClient.set(PENDING_KEY(chatId), payload, { PX: PENDING_TTL_MS });
    return true;
  } catch (err: any) {
    logger.warn(`first-prompt: stash failed for ${chatId} (in-memory fast path still active): ${err?.message ?? err}`, { source: SOURCE });
    return false;
  }
}

/** Read BOTH stash payload shapes (ticket 2e9e5264): the post-fix JSON
 *  { prompt, origin } and the legacy plain prompt string. A raw string that
 *  fails JSON.parse — or parses to anything but the payload shape — is
 *  treated as a plain prompt, never dropped. An unrecognised/missing origin
 *  degrades to origin-less (sendChatMessage's 'user' default), never throws. */
function parsePendingFirstPrompt(raw: string): { prompt: string; origin?: FirstPromptOrigin } {
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string' && parsed.prompt) {
        const o = parsed.origin;
        const userTurnAt = typeof o?.userTurnAt === 'string' && Number.isFinite(Date.parse(o.userTurnAt)) ? o.userTurnAt : undefined;
        const origin: FirstPromptOrigin | undefined =
          o && typeof o === 'object' && (o.kind === 'user' || o.kind === 'agent' || o.kind === 'webhook')
            ? { kind: o.kind, ...(typeof o.sourceChatId === 'string' ? { sourceChatId: o.sourceChatId } : {}), ...(userTurnAt ? { userTurnAt } : {}) }
            : undefined;
        return { prompt: parsed.prompt, ...(origin ? { origin } : {}) };
      }
    } catch { /* not JSON — a legacy prompt that happens to start with '{' */ }
  }
  return { prompt: raw };
}

/** Best-effort clear (e.g. session archived before delivery). */
export async function clearPendingFirstPrompt(chatId: string): Promise<void> {
  await redisClient.del(PENDING_KEY(chatId)).catch(() => {});
}

/** f173/H3: the errorMessage prefix platform.service stamps on a PROVISIONING
 *  failure (platform.service.ts updateSessionState in provisionWorkspace's
 *  catch) — shared by construction so the sweeper's error-arm predicate can
 *  never silently drift from the producer's wording. */
export const PROVISIONING_FAILED_PREFIX = 'Workspace provisioning failed';

/** f173/H2: per-session re-fire marker for the sweeper's provisioning-error
 *  arm — at most one error-arm delivery attempt per session per TTL, so a
 *  PERMANENT provisioning failure (no repoUrl, missing token, project gone)
 *  does not burn a sendChatMessage attempt every 60s sweep forever. */
const REFIRE_KEY = (chatId: string) => `digby:coding:first-prompt:error-refire:${chatId}`;
const ERROR_REFIRE_TTL_MS = 6 * 60 * 60_000;

export type FirstPromptDelivery = 'delivered' | 'already' | 'moot' | 'locked';

/**
 * Race-safe delivery of the pending first prompt. Claims the per-session
 * lock, re-reads the pending key INSIDE the lock, then sends. `fallbackPrompt`
 * lets the fast path deliver its in-memory prompt when the stash failed;
 * `fallbackOrigin` (ticket 2e9e5264) is the fast path's in-memory AUTHOR
 * origin for that same case — the STASHED payload's origin always wins (it
 * is the author's stamp, race-safe across the sweeper, which carries no
 * in-memory origin). Absent both, sendChatMessage defaults origin 'user' —
 * the pre-fix behavior, kept for human-UI-created sessions. Outcomes:
 * 'delivered' (sent + pending cleared) | 'already' (nothing
 * pending, no fallback — someone else delivered) | 'moot' (409 — the session
 * has a run/first message; pending cleared) | 'locked' (another path holds
 * the delivery lock — it owns the send). A non-409 send error KEEPS the
 * pending key so the next sweep retries; the lock always releases.
 */
export async function deliverPendingFirstPrompt(
  chatId: string,
  userId: string,
  fallbackPrompt?: string,
  fallbackOrigin?: FirstPromptOrigin,
  opts?: { keepPendingOn409?: boolean },
): Promise<FirstPromptDelivery> {
  const claimed = await redisClient.set(LOCK_KEY(chatId), '1', { NX: true, PX: LOCK_TTL_MS }).catch(() => null);
  if (claimed !== 'OK') return 'locked';
  try {
    const pending = await redisClient.get(PENDING_KEY(chatId)).catch(() => null);
    const stashed = pending ? parsePendingFirstPrompt(pending) : null;
    const prompt = stashed?.prompt ?? fallbackPrompt;
    if (!prompt) return 'already';
    // The author's origin rides the send (ticket 2e9e5264): a machine-spawned
    // session's first run must be stamped 'agent', not default to 'user'.
    const origin = stashed?.origin ?? fallbackOrigin;
    // A HUMAN-spawned child (platform/human-spawn.ts) threads the parent
    // turn's anchor so the first run is user-anchored; the origin passed
    // down keeps sendChatMessage's shape (kind + sourceChatId only).
    const userTurnAt = origin?.userTurnAt && Number.isFinite(Date.parse(origin.userTurnAt)) ? new Date(origin.userTurnAt) : undefined;
    const sendOrigin = origin ? { kind: origin.kind, ...(origin.sourceChatId ? { sourceChatId: origin.sourceChatId } : {}) } : undefined;
    const { sendChatMessage } = await import('./platform.service');
    try {
      await sendChatMessage({ userId, chatId, content: prompt, ...(sendOrigin ? { origin: sendOrigin } : {}), ...(userTurnAt ? { userTurnAt } : {}) });
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.status === 409) {
        // f173/H1: for a session still in 'error' (the sweeper's
        // provisioning-error arm) a 409 means healUnrunnableSession refused —
        // NOT that the lane has a run — so clearing the pending key here
        // would silently DESTROY the prompt the arm exists to save. Keep it
        // and report 'locked' (the next sweep retries, bounded by the
        // error-arm re-fire marker). Ready-arm 'moot' semantics unchanged.
        if (opts?.keepPendingOn409) {
          logger.info(`first-prompt: delivery deferred for ${chatId} (409 under keepPendingOn409 — pending key kept for the next sweep)`, { source: SOURCE });
          return 'locked';
        }
        await redisClient.del(PENDING_KEY(chatId)).catch(() => {});
        logger.info(`first-prompt: delivery moot for ${chatId} (409 — session already has a run/first message)`, { source: SOURCE });
        return 'moot';
      }
      throw err;
    }
    await redisClient.del(PENDING_KEY(chatId)).catch(() => {});
    logger.info(`first-prompt: delivered pending first prompt to session ${chatId}`, { source: SOURCE });
    return 'delivered';
  } finally {
    await redisClient.del(LOCK_KEY(chatId)).catch(() => {});
  }
}

/**
 * One sweep pass: ready sessions older than the grace window with ZERO
 * coding messages and a stashed pending prompt get their first prompt
 * delivered — PLUS (f173, 2026-10-20 config-lock race) sessions wedged at
 * status 'error' by a failed PROVISIONING: prod session d66f78f9 sat 2h at
 * zero messages until a manual re-fire because the scan only ever saw
 * status 'ready' (deliverPromptWhenReady throws on 'error', and nothing
 * else re-fires a zero-message lane). Delivering the stashed prompt fires
 * a run whose re-provision self-heals through reattachWorktree
 * (run-executor). Sessions without a pending key are the norm (most
 * sessions are created promptless) and cost one Redis GET each.
 * Fail-closed on query error (the next tick retries). Kill switch
 * FIRST_PROMPT_ERROR_SWEEP_DISABLED=1 restores the ready-only scan.
 */
export async function sweepPendingFirstPrompts(): Promise<number> {
  const cutoff = new Date(Date.now() - EMPTY_GRACE_MS());
  const errorArmEnabled = process.env.FIRST_PROMPT_ERROR_SWEEP_DISABLED !== '1';
  const empties = await prisma.chatCodingState.findMany({
    where: {
      createdAt: { lt: cutoff },
      messages: { none: {} },
      OR: [
        { status: 'ready' },
        ...(errorArmEnabled ? [{ status: 'error', errorMessage: { startsWith: PROVISIONING_FAILED_PREFIX } }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, status: true },
    take: SWEEP_BATCH,
  }).catch((err: any) => {
    logger.warn(`first-prompt: sweep query failed (fail-closed, next tick retries): ${err?.message ?? err}`, { source: SOURCE });
    return [] as { id: string; userId: string; status: string }[];
  });
  let delivered = 0;
  for (const s of empties) {
    const pending = await redisClient.get(PENDING_KEY(s.id)).catch(() => null);
    if (!pending) continue;
    const isErrorArm = errorArmEnabled && s.status === 'error';
    if (isErrorArm) {
      // f173/H2: stamp the re-fire marker BEFORE attempting — a PERMANENT
      // provisioning failure otherwise burns a sendChatMessage attempt every
      // sweep. NX + TTL: at most one error-arm attempt per session per 6h;
      // a stamp-race loser simply waits for the next TTL window.
      const stamped = await redisClient.set(REFIRE_KEY(s.id), '1', { NX: true, PX: ERROR_REFIRE_TTL_MS }).catch(() => null);
      if (stamped !== 'OK') continue;
    }
    // f173/H1: the error arm keeps the pending key on a 409 (heal refused —
    // the lane has no run yet; clearing would destroy the prompt).
    const result = await deliverPendingFirstPrompt(s.id, s.userId, undefined, undefined, { keepPendingOn409: isErrorArm }).catch((err: any) => {
      logger.warn(`first-prompt: recovery send failed for ${s.id}: ${err?.message ?? err}`, { source: SOURCE });
      return 'locked' as const;
    });
    if (result === 'delivered') delivered += 1;
  }
  return delivered;
}

/** Per-web-instance sweeper (mirrors startChatOrphanSweeper): 60s cadence,
 *  unref'd timer. The worker process deliberately does NOT
 *  own this — first-prompt delivery belongs with web-side session creation. */
export function startFirstPromptRecoverySweeper(): void {
  const timer = setInterval(() => {
    void sweepPendingFirstPrompts().catch(() => {});
  }, SWEEP_INTERVAL_MS());
  timer.unref?.();
  logger.info(`first-prompt: recovery sweeper started (interval ${SWEEP_INTERVAL_MS()}ms, empty-grace ${EMPTY_GRACE_MS()}ms)`, { source: SOURCE });
}
