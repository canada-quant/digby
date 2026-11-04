/**
 * Spend cap — the ONE cost cap in the framework: ProjectSettings.spendCapUsdPerDay,
 * set by a user on a project (update_project / the project settings UI;
 * folder-inherited). Owner directive 2026-09-27 (verbatim): "there should be no
 * cost caps anywhere in the framework at all unless set by a user at the
 * project settings level."
 *
 * What this module DELETED on 2026-09-27 (ticket 1769c8d1 — a hidden $12/day
 * per-CHAT cap, written by an automated audit redirect and not by the owner,
 * skipped the spark-cluster project supervisor's firings as `skipped:spend_cap`):
 *   - the CHAT-level cap (context-store row [chatId,'settings'] spendCapUsdPerDay,
 *     getChatSpendCap / setChatSpendCap): a leftover row is IGNORED — nothing
 *     reads it, nothing can write it;
 *   - the global env default SPEND_CAP_USD_PER_LANE_DAY: no longer read;
 *   - the 'chat' / 'global' verdict scopes.
 *
 * Storage: the project cap lives in ProjectSettings ([projectId, 'settings'] /
 * 'state' — the codingModel pattern; folder-inherited reads through the light
 * folder-inheritance leaf).
 *
 * DEFAULT IS NO CAP: with no project cap, checkSpendCap always returns null
 * BEFORE ever reading the spend ledger — nothing skips, refuses, throttles or
 * stages a card on cost. Kill-switch: SPEND_CAP_DISABLED=1 disables even a set
 * project cap (read per call so ops can flip it live).
 *
 * Spend source: loop_metrics `run_spend` rows (P0) — value = USD, sessionId =
 * the chat. Project spend = SUM over run_spend rows whose session's
 * crossmodel_chats.projectId matches (ONE grouped raw query). Cached 5 min per
 * chat in Redis so the minute-cadence sweeper never hammers the metrics table.
 * An explicit project cap binds on ALL-profile spend (the owner set that cap
 * knowingly on that scope). The coding-only slice is still computed and
 * returned by trailingSpend24h for readouts, but no cap binds on it any more.
 *
 * Enforcement lives in the schedule sweeper (schedule.service sweepTickBody):
 * an over-cap chat's due firing is SKIPPED (lastStatus 'skipped:spend_cap',
 * hook event schedule_cap_skipped kind:'spend'); the lane learns via the
 * spend-skip notice counter below (the P3 cap-skip channel, parallel key so
 * the message stays honest about WHY), and the owner gets ONE decision card
 * per chat per 7d proposing raise-or-keep — ONLY for a project cap the owner
 * set (the only cap that exists).
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

// ── Kill switch ──────────────────────────────────────────────────────────────

export function spendCapDisabled(): boolean {
  const v = String(process.env.SPEND_CAP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function normalizeCap(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : null;
}

// ── The ONE cap resolver: the PROJECT cap, or nothing ────────────────────────

export interface LaneSpendCap {
  /** the project's user-set spendCapUsdPerDay (folder-inherited); null = no cap anywhere */
  spendCapUsdPerDay: number | null;
  /** 'project' when a project cap binds this chat; null = no cap */
  spendCapSource: 'project' | null;
  /** the project the cap was read from (absent when the chat has no project) */
  projectId?: string | null;
}

const NO_CAP: LaneSpendCap = { spendCapUsdPerDay: null, spendCapSource: null };

/**
 * Resolve the spend cap that governs this chat's machine firings — the
 * user-set PROJECT cap (ProjectSettings.spendCapUsdPerDay, folder-inherited)
 * or nothing. Read by checkSpendCap, get_spend (chat scope), get_chat_autonomy
 * and machine-caps, so every surface names the same cap. A leftover chat-level
 * settings row, any env variable and any default are NEVER consulted: with no
 * project cap this returns {null, null}. Never throws; respects the kill-switch.
 */
export async function getLaneSpendCap(chatId: string): Promise<LaneSpendCap> {
  try {
    if (spendCapDisabled()) return { ...NO_CAP };
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { projectId: true } });
    const projectId: string | null = chat?.projectId ?? null;
    if (!projectId) return { ...NO_CAP, projectId: null };
    // Deliberately folder-inheritance (the light leaf), NOT memory.graph's
    // getProjectSettings — that module statically imports context.service's
    // heavy chain, which must never load into the sweeper's jest graphs.
    const { getMergedProjectStoreState } = await import('../platform/folder-inheritance');
    const settings = await getMergedProjectStoreState<{ spendCapUsdPerDay?: number }>(projectId, 'settings');
    const cap = normalizeCap(settings?.spendCapUsdPerDay);
    return cap === null ? { ...NO_CAP, projectId } : { spendCapUsdPerDay: cap, spendCapSource: 'project', projectId };
  } catch {
    return { ...NO_CAP }; // a read hiccup must never invent a cap
  }
}

// ── Trailing-24h spend (one grouped query, 5-min Redis cache per chat) ───────

export const SPEND_CACHE_TTL_SEC = 5 * 60;
export const SPEND_CACHE_KEY = (chatId: string) => `coding:spendcap:24h:${chatId}`;

export interface TrailingSpend {
  /** all-profile spend on the chat's own run_spend rows */
  chatUsd: number;
  /** null when the chat has no project (nothing to sum against). */
  projectUsd: number | null;
  projectId: string | null;
  /**
   * The CODING-profile slice of the same sums (meta.profile = 'coding',
   * pre-stamp rows counted as coding) — a readout figure only; no cap binds
   * on it since 2026-09-27.
   */
  chatCodingUsd: number;
  projectCodingUsd: number | null;
}

/** Cache rows written before the profile split lack the coding slice → treat as a miss. */
function isTrailingSpend(p: unknown): p is TrailingSpend {
  const o = p as Record<string, unknown> | null;
  return !!o && typeof o.chatUsd === 'number' && typeof o.chatCodingUsd === 'number';
}

/**
 * Trailing-24h run_spend for the chat AND its project, from loop_metrics.
 * ONE grouped raw query; cached per chat for 5 min (SPEND_CACHE_TTL_SEC) —
 * a stale-by-minutes read is fine for a daily cap. Fail-open: any error
 * returns zeros (an unreadable ledger must never freeze the fleet).
 */
export async function trailingSpend24h(chatId: string, opts?: { now?: Date }): Promise<TrailingSpend> {
  try {
    const cached = await redisClient.get(SPEND_CACHE_KEY(chatId)).catch(() => null);
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (isTrailingSpend(p)) return p;
      } catch { /* fall through to a fresh read */ }
    }
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { projectId: true } });
    const projectId: string | null = chat?.projectId ?? null;
    const since = new Date((opts?.now ?? new Date()).getTime() - 24 * 3600_000);
    let chatUsd = 0;
    let projectUsd: number | null = null;
    let chatCodingUsd = 0;
    let projectCodingUsd: number | null = null;
    if (projectId) {
      const rows = await prisma.$queryRaw<Array<{ chat_usd: number | null; project_usd: number | null; chat_coding_usd: number | null; project_coding_usd: number | null }>>`
        SELECT COALESCE(SUM(CASE WHEN lm."sessionId" = ${chatId} THEN lm."value" END), 0)::float AS chat_usd,
               COALESCE(SUM(lm."value"), 0)::float                                               AS project_usd,
               COALESCE(SUM(CASE WHEN lm."sessionId" = ${chatId}
                                  AND COALESCE(lm."meta"->>'profile', 'coding') = 'coding' THEN lm."value" END), 0)::float AS chat_coding_usd,
               COALESCE(SUM(CASE WHEN COALESCE(lm."meta"->>'profile', 'coding') = 'coding' THEN lm."value" END), 0)::float AS project_coding_usd
        FROM "loop_metrics" lm
        JOIN "crossmodel_chats" c ON c."id" = lm."sessionId"
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since}
          AND (c."projectId" = ${projectId} OR lm."sessionId" = ${chatId})`;
      chatUsd = Number(rows?.[0]?.chat_usd) || 0;
      projectUsd = Number(rows?.[0]?.project_usd) || 0;
      chatCodingUsd = Number(rows?.[0]?.chat_coding_usd) || 0;
      projectCodingUsd = Number(rows?.[0]?.project_coding_usd) || 0;
    } else {
      const rows = await prisma.$queryRaw<Array<{ chat_usd: number | null; chat_coding_usd: number | null }>>`
        SELECT COALESCE(SUM(lm."value"), 0)::float AS chat_usd,
               COALESCE(SUM(CASE WHEN COALESCE(lm."meta"->>'profile', 'coding') = 'coding' THEN lm."value" END), 0)::float AS chat_coding_usd
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."sessionId" = ${chatId} AND lm."createdAt" >= ${since}`;
      chatUsd = Number(rows?.[0]?.chat_usd) || 0;
      chatCodingUsd = Number(rows?.[0]?.chat_coding_usd) || 0;
    }
    const out: TrailingSpend = { chatUsd, projectUsd, projectId, chatCodingUsd, projectCodingUsd };
    await redisClient.set(SPEND_CACHE_KEY(chatId), JSON.stringify(out), { EX: SPEND_CACHE_TTL_SEC }).catch(() => {});
    return out;
  } catch (err: any) {
    logger.warn(`spend-cap: trailing spend read failed for ${chatId} (fail-open, no cap applied): ${err?.message ?? err}`);
    return { chatUsd: 0, projectUsd: null, projectId: null, chatCodingUsd: 0, projectCodingUsd: null };
  }
}

/**
 * Trailing-24h run_spend for ONE PROJECT (every chat filed in it) — the
 * get_project read-back's `projectSpend24h` (WI-O #7, 2026-09-25). Same
 * loop_metrics join as trailingSpend24h restricted to c."projectId"; also
 * counts the finalized runs (run_spend rows) so the figure is attributable.
 * Cached per project for SPEND_CACHE_TTL_SEC like the chat read. Returns
 * null on ANY error (a read-back must say "unknown", never "$0").
 */
export async function trailingProjectSpend24h(projectId: string, opts?: { now?: Date }): Promise<{ usd: number; runs: number } | null> {
  const key = `${SPEND_CACHE_KEY(projectId)}:project`;
  try {
    const cached = await redisClient.get(key).catch(() => null);
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (p && typeof p.usd === 'number' && typeof p.runs === 'number') return p;
      } catch { /* fall through to a fresh read */ }
    }
    const since = new Date((opts?.now ?? new Date()).getTime() - 24 * 3600_000);
    const rows = await prisma.$queryRaw<Array<{ usd: number | null; runs: number | null }>>`
      SELECT COALESCE(SUM(lm."value"), 0)::float AS usd, COUNT(*)::int AS runs
      FROM "loop_metrics" lm
      JOIN "crossmodel_chats" c ON c."id" = lm."sessionId"
      WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} AND c."projectId" = ${projectId}`;
    const out = { usd: Number(rows?.[0]?.usd) || 0, runs: Number(rows?.[0]?.runs) || 0 };
    await redisClient.set(key, JSON.stringify(out), { EX: SPEND_CACHE_TTL_SEC }).catch(() => {});
    return out;
  } catch (err: any) {
    logger.warn(`spend-cap: trailing project spend read failed for ${projectId} (reported as unknown): ${err?.message ?? err}`);
    return null;
  }
}

// ── The check the sweeper calls at fire time ─────────────────────────────────

export interface SpendCapVerdict {
  /** the only scope that exists since 2026-09-27 */
  scope: 'project';
  capUsd: number;
  spentUsd: number;
}

/**
 * Is this chat's next machine firing over its PROJECT spend cap? null = under
 * the cap, or no cap is set (the default). NEVER throws; every failure fails
 * OPEN (no cap). With no project cap the ledger is never read.
 */
export async function checkSpendCap(chatId: string): Promise<SpendCapVerdict | null> {
  try {
    if (spendCapDisabled()) return null;
    const lane = await getLaneSpendCap(chatId);
    if (lane.spendCapUsdPerDay === null) return null; // nobody opted in — the default
    const spend = await trailingSpend24h(chatId);
    if (spend.projectUsd !== null && spend.projectUsd > lane.spendCapUsdPerDay) {
      const verdict: SpendCapVerdict = { scope: 'project', capUsd: lane.spendCapUsdPerDay, spentUsd: round2(spend.projectUsd) };
      await parkSpendCapVerdictDetail(chatId, verdict).catch(() => {});
      return verdict;
    }
    return null;
  } catch (err: any) {
    logger.warn(`spend-cap: check failed for ${chatId} (fail-open): ${err?.message ?? err}`);
    return null;
  }
}

// ── Skip-notice cap detail (ticket 1769c8d1, 2026-09-27) ──────────────────────

/** Redis parking for the LAST spend-cap verdict — the sweeper parks it at skip
 *  time so the run-start notice can name the cap ($ figure + where it lives).
 *  24h TTL to mirror the rolling window the verdict describes. Best-effort. */
export const SPEND_CAP_VERDICT_KEY = (chatId: string) => `coding:spendcap:verdict:${chatId}`;
const SPEND_CAP_VERDICT_TTL_SEC = 24 * 3600;

async function parkSpendCapVerdictDetail(chatId: string, verdict: SpendCapVerdict): Promise<void> {
  await redisClient.set(
    SPEND_CAP_VERDICT_KEY(chatId),
    JSON.stringify({ scope: verdict.scope, capUsd: verdict.capUsd, spentUsd: verdict.spentUsd, at: new Date().toISOString() }),
    { EX: SPEND_CAP_VERDICT_TTL_SEC },
  );
}

/** Read + KEEP the parked verdict (kept, not consumed: every skipped-firings
 *  notice in the window describes the same cap; a later run may skip again).
 *  A parked verdict with a retired scope ('chat' / 'global' — pre-2026-09-27)
 *  is discarded: no such cap exists any more. Never throws. */
export async function readParkedSpendCapVerdict(chatId: string): Promise<SpendCapVerdict & { at: string } | null> {
  try {
    const raw = await redisClient.get(SPEND_CAP_VERDICT_KEY(chatId));
    if (!raw) return null;
    const v = JSON.parse(raw) as SpendCapVerdict & { at: string };
    if (v?.scope !== 'project') return null;
    return typeof v.capUsd === 'number' && Number.isFinite(v.capUsd) ? v : null;
  } catch {
    return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Lane notice (the P3 cap-skip channel, parallel key so the reason is honest) ──

const SPEND_SKIP_TTL_SEC = 36 * 60 * 60; // outlives the 24h window it describes
export const SPEND_SKIP_KEY = (chatId: string) => `coding:sched:spendskip:${chatId}`;

/** Count one spend-cap skip so the chat's next run learns why it went quiet. */
export async function recordSpendCapSkip(chatId: string): Promise<void> {
  try {
    const n = await redisClient.incr(SPEND_SKIP_KEY(chatId));
    if (n === 1) await redisClient.expire(SPEND_SKIP_KEY(chatId), SPEND_SKIP_TTL_SEC).catch(() => {});
  } catch { /* best-effort — lastStatus + the hook event remain */ }
}

/** Atomic read+clear (GETDEL) — the run-start consumption, like consumeCapSkipNotice. */
export async function consumeSpendCapSkipNotice(chatId: string): Promise<number> {
  try {
    const raw = await redisClient.getDel(SPEND_SKIP_KEY(chatId));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/** Put a consumed count BACK when the run never started (mirrors restoreCapSkipNotice). */
export async function restoreSpendCapSkipNotice(chatId: string, count: number): Promise<void> {
  if (!Number.isFinite(count) || count <= 0) return;
  try {
    await redisClient.incrBy(SPEND_SKIP_KEY(chatId), Math.round(count));
    await redisClient.expire(SPEND_SKIP_KEY(chatId), SPEND_SKIP_TTL_SEC).catch(() => {});
  } catch { /* best-effort */ }
}

/** The one-line notice text (shared by the executor + the plain-chat wake).
 *  With a parked verdict (readParkedSpendCapVerdict) it NAMES the cap — the
 *  $ figure and where it lives (the project's settings) — so a capped lane
 *  learns the governing cap in the notice itself. */
export function spendSkipNoticeText(count: number, verdict?: SpendCapVerdict | null): string {
  const base = `${count} scheduled firing(s) were skipped since this chat's last machine run because the PROJECT's trailing-24h SPEND is over the project spend cap`;
  if (verdict) {
    return `${base}: $${verdict.spentUsd} over the project cap $${verdict.capUsd}/day — the cap is the PROJECT's spendCapUsdPerDay (project settings, set by the owner; raise or clear it via update_project). This is the only cost cap in the framework. The cap window is rolling 24h — firings resume as spend ages out. If the cap is too tight, ask the owner to raise it.`;
  }
  return `${base} (project settings spendCapUsdPerDay — the only cost cap in the framework). The cap window is rolling 24h — firings resume as spend ages out. If the cap is too tight, ask the owner to raise it via update_project.`;
}

// ── Owner decision card (ONE per chat per 7d, Redis NX) — project cap only ───

export const SPEND_CAP_CARD_KEY = (chatId: string) => `coding:spendcap:card:${chatId}`;
const SPEND_CAP_CARD_DEDUPE_SEC = 7 * 24 * 3600;

/** 1769c8d1: release a wrongly-held 7d window. Best-effort in its own try —
 *  even a Redis client without del must never throw into the sweeper. */
async function releaseCardWindow(chatId: string): Promise<void> {
  try {
    await redisClient.del(SPEND_CAP_CARD_KEY(chatId));
  } catch { /* best-effort — the key's 7d EX is the worst case */ }
}

/**
 * File ONE owner decision card per chat per 7d proposing raise-or-keep — for
 * a PROJECT cap the owner set (the only cap that exists; any other verdict
 * shape is ignored, never a card). NX is the dedupe; flagOwnerQuestion's own
 * exact-question dedupe backstops a race. Best-effort: never throws into the
 * sweeper.
 *
 * Ticket 1769c8d1 (2026-09-27): the NX claim is RELEASED when flagOwnerQuestion
 * did not actually file a card (refusal or throw) — a refusal must cost one
 * skip's retry, not 7 days of card-silent skips.
 */
export async function maybeAskSpendCapQuestion(
  chatId: string,
  userId: string,
  verdict: SpendCapVerdict,
): Promise<void> {
  if (verdict?.scope !== 'project') return; // no other cap exists — never a card on one
  try {
    const claimed = await redisClient
      .set(SPEND_CAP_CARD_KEY(chatId), new Date().toISOString(), { NX: true, EX: SPEND_CAP_CARD_DEDUPE_SEC })
      .catch(() => null);
    if (claimed !== 'OK') return; // already asked inside the window
    const { flagOwnerQuestion } = await import('../platform/owner-questions');
    const filed = await flagOwnerQuestion({
      chatId,
      userId,
      question: `Chat ${chatId.slice(0, 8)} is skipping scheduled firings on its PROJECT spend cap: trailing-24h project spend $${verdict.spentUsd} vs the $${verdict.capUsd}/day cap you set. Raise the cap or keep it?`,
      context:
        `Scheduled machine firings on this chat are being skipped with lastStatus 'skipped:spend_cap' while its project's trailing-24h ` +
        `run spend stays over the cap. Keeping the cap is safe (work resumes as spend ages out of the rolling window); raising it ` +
        `lets the lane keep its cadence at a higher burn. The cap lives in the project's settings (spendCapUsdPerDay — update_project ` +
        `or the project page); it is the only cost cap in the framework.`,
      options: [
        { id: 'raise', label: 'Raise the cap', consequence: 'tell the lane the new $/day figure to carry to you for the settings change' },
        { id: 'keep', label: 'Keep the cap (firings resume as spend ages out)', consequence: 'the lane stays throttled to the current $/day' },
      ],
      machineTriggered: true,
    });
    if (!(filed && (filed.kind === 'created' || filed.kind === 'deduped'))) {
      await releaseCardWindow(chatId);
      logger.warn(`spend-cap: owner card for ${chatId} not filed (${(filed as any)?.kind ?? 'no-result'}) — 7d window released, retried on the next skip`);
    }
  } catch (err: any) {
    await releaseCardWindow(chatId);
    logger.warn(`spend-cap: owner card failed for ${chatId} (non-fatal, 7d window released): ${err?.message ?? err}`);
  }
}
