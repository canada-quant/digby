/**
 * Digby Code — SESSION HISTORY SYNC (durable cron).
 *
 * The gap this closes: a coding session's DURABLE records (run journal,
 * transcript) live only in Postgres, and the session's git artifacts never
 * leave the host — checkpoints/journal are DB rows, worktree stash snapshots
 * (refs/digby-wip/*) and reaper WIP commits are mirror-LOCAL and never pushed.
 * A host/volume loss therefore erases the session's narrative even when the
 * project's origin repo survives. This sweep renders each live session's
 * history into a deterministic HISTORY.md and pushes it to origin every 10
 * minutes.
 *
 * ONE BRANCH PER REPO (owner 2026-09-14: "it seems the framework isnt
 * automatically deleting branches after they are merged … looking like
 * session history" — 87 of 126 remote branches were per-session
 * digby/session-history/<sessionId> mirrors that were never pruned). All
 * sessions' files now live on a SINGLE branch `digby/session-history` as
 * `sessions/<sessionId>/HISTORY.md` — one tree, one commit per pass per repo
 * when anything changed. A session drops OUT of the tree (its file is
 * removed) as soon as it stops being live — its chat archived, or its
 * worktree gone (the reaper nulls worktreePath) — so the branch is the
 * history of LIVE sessions only. The DB rows (coding_messages, run journal)
 * remain the durable record of every session, live or not; the branch is a
 * host-loss mirror of the live ones, not an archive.
 *
 * MIGRATION (same sweep): the legacy per-session branches are superseded by
 * the consolidated file. Git refuses a ref `x` while any ref `x/<y>` exists
 * (directory/file conflict — in the mirror AND on GitHub), so on a repo's
 * first consolidated pass the legacy refs are deleted FIRST: the mirror-local
 * `refs/heads/digby/session-history/<id>` refs before the local update-ref,
 * the origin ones (`ls-remote` → batched `push --delete`, best-effort, counts
 * logged) before the consolidated push. Once both succeed the repo is
 * remembered for the life of the process — no ls-remote every pass.
 *
 * HOW (all git PLUMBING in the bare mirror — the worktree is NEVER touched,
 * no checkout, no index.lock contention with a running agent):
 *   1. Enumerate live coding chats (worktree present, status != provisioning,
 *      chat not archived), skipping blank/plain-provider projects exactly like
 *      reapIdleWorktrees (they have no mirror). Group by project (= mirror).
 *   2. Per session, build a deterministic HISTORY.md (NO timestamps in the
 *      file — byte stability lets us skip unchanged content): header + compact
 *      run journal (buildParentContextBlock format) + last 20 transcript
 *      lines, hard-capped at ~20 KB (oldest transcript lines dropped first).
 *   3. hash-object -w each file; compare against the blob the branch tip holds
 *      at sessions/<id>/HISTORY.md (ONE ls-tree per repo). Nothing changed and
 *      nothing to prune ⇒ SKIP (no commit, no push). Otherwise read-tree/
 *      update-index/write-tree/commit-tree/update-ref against a TEMP
 *      GIT_INDEX_FILE (the snapshotWorktreeGitState pattern) and push.
 *      update-ref's old-value guard makes a lost race fail safe; a
 *      non-fast-forward push triggers ONE fetch + rebuild-on-remote-tip +
 *      retry; a second failure rolls the local ref back to the previous tip
 *      (so the next pass does not read the unpushed commit as "unchanged")
 *      and the repo's changed sessions are counted failed — the next pass
 *      self-heals.
 *
 * Robustness: per-session try/catch (one bad render never aborts the repo —
 * its previous file stays in the tree), per-repo try/catch (one bad mirror
 * never aborts the pass), and the sweep itself NEVER throws — it returns a
 * ≤200-char summary string (the cron loop marks jobs failed on throw; a
 * summary is more useful).
 *
 * Kill-switches: SESSION_HISTORY_SYNC_DISABLED=1 (handler side, worker.ts —
 * the MEMORY_DREAM_DISABLED / PROJECT_DIGEST_DISABLED pattern) stops the
 * sweep; SESSION_HISTORY_SINGLE_BRANCH_DISABLED=1 restores the legacy
 * per-session branches (digby/session-history/<sessionId>, no pruning, no
 * migration — the fleet branch janitor also stops treating them as legacy).
 * The quarantine WINDOW itself is durable — a Redis key per project (SET NX EX
 * of the retry window) so worker reboots (every deploy) do not reset it
 * (ticket b6477bc7); a Redis outage degrades to the pre-fix per-process
 * window.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { git, repoMirrorPath, authedUrl } from './workspace.service';
import { assertRepoTargetAllowed, IsolationBoundaryError } from '../platform/instance-targets';
import { getValidToken } from '../github/token-manager';
import { getRecentJournalEntries } from './run-journal.service';
import { redactUrlCredentials } from '../../../utils/redact-credentials';
import { pickTranscriptSource } from './transcript-source';

/** Cron cadence — mirrored by the CRON_JOBS entry in worker.ts. */
export const SESSION_HISTORY_SYNC_INTERVAL_SEC = 600;

/** The ONE branch every live session's history lives on (default mode). */
export const SESSION_HISTORY_BRANCH = 'digby/session-history';
export const SESSION_HISTORY_REF = `refs/heads/${SESSION_HISTORY_BRANCH}`;
/** Legacy per-session branch prefix (pre-2026-09-14) — superseded by the
 *  consolidated branch; the branch janitor deletes these on origin too. */
export const LEGACY_SESSION_HISTORY_PREFIX = 'digby/session-history/';
const LEGACY_SESSION_HISTORY_REF_PREFIX = `refs/heads/${LEGACY_SESSION_HISTORY_PREFIX}`;
/** A legacy per-session ref on origin (exactly one path segment after the prefix). */
const LEGACY_REMOTE_REF_RE = /^refs\/heads\/digby\/session-history\/[^/]+$/;
/** Kill switch env (read per call): =1 restores per-session branches. */
export const SESSION_HISTORY_SINGLE_BRANCH_DISABLED_ENV = 'SESSION_HISTORY_SINGLE_BRANCH_DISABLED';
/** How long a quarantined repo is skipped before it gets ONE fresh attempt
 *  (the credential may have been fixed or the project re-pointed). */
export const SESSION_HISTORY_PUSH_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * DISABLE-ON-TERMINAL-AUTH (ticket 5eb035d6, owner decision oq_fd533d0a
 * 2026-10-16 "STOP THE JOB"): the Redis quarantine above (b6477bc7) stops
 * the push RETRIES per 6h window, but a project whose credential is
 * permanently dead still re-attempts (and re-warns) once per window forever
 * — prod 52ad1f73 kept pushing against a repo that no longer accepts it
 * long after the project left the owner's account. A DURABLE
 * consecutive-refusal streak in Redis is the actual stop: once a repo's push
 * has been refused with terminal auth SESSION_HISTORY_AUTH_DISABLE_THRESHOLD
 * times IN A ROW (one INCR per refusing pass, shared by EVERY process), the
 * repo's history sync is DISABLED — skipped silently except for ONE info log
 * at the threshold crossing, and even the per-window quarantine WARN is
 * suppressed from then on (the ticket's acceptance: the warn class stops
 * appearing) — and re-probed at most once per SESSION_HISTORY_AUTH_REPROBE_SEC
 * via a single-flight SETNX lock (self-rearming TTL), so a fixed credential
 * or re-pointed project self-heals. ANY landed push clears the streak (the
 * disable never outlives a success). A Redis outage FAILS OPEN (the
 * quarantine contract above keeps running). Kill switch:
 * SESSION_HISTORY_SYNC_AUTH_DISABLE_DISABLED=1.
 */
export const SESSION_HISTORY_AUTH_DISABLE_ENV = 'SESSION_HISTORY_SYNC_AUTH_DISABLE_DISABLED';
/** Consecutive terminal-auth refusals before a repo's sync is disabled
 *  (durable, Redis-backed — survives restarts and spans worker processes). */
export const SESSION_HISTORY_AUTH_DISABLE_THRESHOLD = 3;
/** How long a disabled repo is skipped between fresh re-probe pushes (the
 *  SETNX lock's TTL — self-rearming, single-flight across processes). */
export const SESSION_HISTORY_AUTH_REPROBE_SEC = 24 * 60 * 60;
/** Redis key namespace (streak counter + re-probe lock). */
const AUTH_DISABLE_KEY_PREFIX = 'session-history:auth-disable';

/** Kill switch (read per call): =1 restores the quarantine-only behavior
 *  (per-window warn + re-attempt, no durable disable). */
export function sessionHistoryAuthDisableEnabled(): boolean {
  return process.env[SESSION_HISTORY_AUTH_DISABLE_ENV] !== '1';
}

/** Redis key of a repo's durable refusal streak. */
function authDisableKey(projectId: string): string {
  return `${AUTH_DISABLE_KEY_PREFIX}:${projectId}`;
}

/** Redis key of the single-flight daily re-probe lock. */
function authReprobeKey(projectId: string): string {
  return `${AUTH_DISABLE_KEY_PREFIX}:reprobe:${projectId}`;
}

/** One auth-disable Redis op through the module's SHARED Redis seam and
 *  per-op timeout (the b6477bc7 machinery): a Redis outage — rejecting OR
 *  queued on a dead socket — degrades to the fallback (fail-open), never a
 *  throw and never a stalled sweep. */
async function authDisableRedis<T>(op: (client: typeof redisClient) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await withQuarantineTimeout(op(__pushQuarantineRedisClient.current));
  } catch { return fallback; }
}

/** The durable streak count (0 when absent); null on ANY Redis failure
 *  (fail-open: treat as not disabled). */
async function readAuthDisableCount(projectId: string): Promise<number | null> {
  const raw = await authDisableRedis(c => c.get(authDisableKey(projectId)), null);
  if (raw === null || raw === undefined) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Record one terminal-auth refusal: an ATOMIC INCR (no read-modify-write —
 * concurrent worker passes each count exactly once). Returns the new count,
 * or null on any Redis failure (fail-open: the caller keeps the
 * quarantine-only contract). No TTL — the streak is unbounded in time by
 * design; only a landed push or the kill switch clears it.
 */
async function bumpAuthDisableCount(projectId: string): Promise<number | null> {
  return authDisableRedis(c => c.incr(authDisableKey(projectId)), null);
}

/**
 * True while the repo's history sync is DISABLED by the durable streak. A
 * disabled repo gets ONE fresh re-probe push per SESSION_HISTORY_AUTH_REPROBE_SEC:
 * the SETNX lock (EX = the full period) makes the attempt single-flight
 * across processes AND self-rearming — a claimed lock expires exactly one
 * period after the attempt, so a refused re-probe re-closes the window with
 * no bookkeeping. Claimants return false (not disabled — this pass pushes).
 */
async function isAuthDisabled(projectId: string): Promise<boolean> {
  if (!sessionHistoryAuthDisableEnabled()) return false;
  const count = await readAuthDisableCount(projectId);
  if (count === null || count < SESSION_HISTORY_AUTH_DISABLE_THRESHOLD) return false;
  const claimed = await authDisableRedis(
    c => c.set(authReprobeKey(projectId), '1', { NX: true, EX: SESSION_HISTORY_AUTH_REPROBE_SEC }),
    null,
  );
  // A Redis failure here keeps the repo disabled — failing open would fan
  // one re-probe into one per process.
  return claimed === null; // null = the window is held (another pass or a live claim)
}

/** ANY landed push: the credential works — forget the durable streak and lock. */
async function clearAuthDisable(projectId: string): Promise<void> {
  await authDisableRedis(c => c.del([authDisableKey(projectId), authReprobeKey(projectId)]), 0);
}

/**
 * Record one terminal-auth refusal on the durable streak. Returns TRUE when
 * the repo's sync is DISABLED by the streak (at or past the threshold) — the
 * caller uses that to SILENCE the quarantine warn: once the durable disable
 * governs the repo, re-probe refusals must not resurrect the warn class the
 * owner ordered stopped (ticket 5eb035d6 acceptance), so the crossing info
 * (logged EXACTLY ONCE, at count === threshold) is the repo's last word.
 * The crossing also ARMS the re-probe lock for a full period, so the silence
 * starts with the very next pass.
 */
async function noteAuthRefused(projectId: string): Promise<boolean> {
  if (!sessionHistoryAuthDisableEnabled()) return false;
  const count = await bumpAuthDisableCount(projectId);
  if (count === null) return false;
  if (count === SESSION_HISTORY_AUTH_DISABLE_THRESHOLD) {
    await authDisableRedis(
      c => c.set(authReprobeKey(projectId), '1', { NX: true, EX: SESSION_HISTORY_AUTH_REPROBE_SEC }),
      null,
    );
    logger.info(`session history sync: project ${projectId} — push refused with terminal auth ${count} consecutive cycles; history sync DISABLED for it (one re-probe per ${Math.round(SESSION_HISTORY_AUTH_REPROBE_SEC / 3600)}h, a landed push resumes it; ticket 5eb035d6)`);
  }
  return count >= SESSION_HISTORY_AUTH_DISABLE_THRESHOLD;
}

/** The file this sweep owns per session. */
const HISTORY_FILE = 'HISTORY.md';
/** Hard cap for the rendered file; oldest transcript lines drop first. */
const HISTORY_CAP_BYTES = 20 * 1024;
/** Transcript/journal budgets per session per pass. */
const TRANSCRIPT_TAKE = 20;
const TRANSCRIPT_LINE_CAP = 500;
const JOURNAL_TAKE = 6;
/** Max sessions per pass (oldest-updated first — the stalest sync first).
 *  Pruning is only safe when the pass saw the WHOLE live set, i.e. fewer
 *  rows than this cap came back. */
export const SESSION_TAKE = 500;
/** Legacy origin branches deleted per `push --delete` batch. */
const LEGACY_DELETE_BATCH = 25;

type SessionRow = Prisma.ChatCodingStateGetPayload<{ include: { project: true } }>;

/** True unless SESSION_HISTORY_SINGLE_BRANCH_DISABLED=1 (read per call). */
export function sessionHistorySingleBranchEnabled(): boolean {
  return process.env[SESSION_HISTORY_SINGLE_BRANCH_DISABLED_ENV] !== '1';
}

/**
 * A push failure that can NEVER succeed on retry as-is: git's terminal auth
 * refusal. Prod (FO firing 106, 2026-10-09): project 52ad1f73's origin is
 * octocat/Hello-World (a repo the owner's token cannot write), and the sweep
 * logged "Command failed: git push … remote: No anonymous write access." /
 * "Authentication failed for 'https://github.com/octocat/Hello-World.git/'"
 * EVERY 10-minute pass for 2+ days (89 rows/7d) — retried forever because the
 * catch-all counted it failed with "next pass retries". Transient classes
 * (non-fast-forward, 5xx, timeouts, connection resets) stay out: they either
 * succeed or fail differently, and the fetch+retry path owns them.
 */
export function isPermanentPushAuthError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /No anonymous write access|Authentication failed|does not appear to be a git repository|Repository not found|READONLY|not authorized to/i.test(msg);
}

/** Quarantine rows live in Redis (one key per project) with a TTL of the
 *  retry window, so the state SURVIVES the worker reboots that every deploy
 *  causes — the same terminal-auth refusal must not re-warn on every boot
 *  (ticket b6477bc7: prod 52ad1f73 warned at 09:36/10:37/12:17/12:58/13:08
 *  on 2026-10-16, each repeat one worker boot, while the log text promised
 *  "quarantined for 6h"). Redis is the only durable store the worker cron
 *  already shares with the API process; every Redis op is raced against a
 *  short timeout and caught — a Redis outage (whether the op rejects or, the
 *  real mid-life shape, node-redis silently QUEUES it on the still-open
 *  socket) degrades to the pre-fix per-process behavior (warn once per boot),
 *  never to a throw or a stalled sweep, and the cron summary contract (never
 *  throws) holds. */
const PUSH_QUARANTINE_KEY_PREFIX = 'session-history:push-quarantine:';

/** Test seam: overwrite the Redis client the quarantine bookkeeping uses.
 *  Prod code never calls it — the module reads the shared default client. */
export const __pushQuarantineRedisClient: { current: typeof redisClient } = { current: redisClient };

/** Test seam: the per-op timeout below, overridable for fast tests. */
export const __pushQuarantineRedisTimeoutMs: { current: number } = { current: 1_500 };

/** Upper-bound ONE quarantine Redis op. node-redis does NOT reject on a
 *  dropped connection: with the default reconnect strategy the client stays
 *  open and every command QUEUES (the offline queue — @redis/client rejects
 *  only on a closed socket or disableOfflineQueue, neither of which
 *  backend/src/config/redis.ts sets), so a mid-life outage would otherwise
 *  leave this op — and the serial cron loop behind it — PENDING until Redis
 *  returns. Racing a short timeout makes the catch/fallback paths engage;
 *  the losing command stays handled (Promise.race attached to it), so its
 *  eventual settle/reject after flush is silently discarded. */
async function withQuarantineTimeout<T>(op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('push-quarantine redis op timed out')), __pushQuarantineRedisTimeoutMs.current);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Claim the quarantine window for a repo in Redis: NX so only ONE writer
 *  (worker process, box) warns for a given window, EX so the window expires
 *  on its own — no sweeper needed. The value is the start instant (ISO) for
 *  diagnostics. True when THIS call is the first refusal of the window (the
 *  one that warns); false when the window was already claimed.
 *
 *  REDIS UNREACHABLE: fall back to a per-process window (the pre-fix
 *  behavior — same window length) so an outage never regresses to the
 *  FO-firing-106 storm class of one warn per pass; the repo is still
 *  attempted (see isPushQuarantined's fail-open). */
const pushQuarantinedFallback = new Map<string, number>();
async function claimPushQuarantine(projectId: string): Promise<boolean> {
  try {
    const claimed = await withQuarantineTimeout(__pushQuarantineRedisClient.current.set(
      `${PUSH_QUARANTINE_KEY_PREFIX}${projectId}`,
      new Date().toISOString(),
      { NX: true, EX: Math.max(1, Math.floor(SESSION_HISTORY_PUSH_RETRY_MS / 1000)) },
    ));
    return claimed === 'OK';
  } catch {
    const since = pushQuarantinedFallback.get(projectId);
    if (since !== undefined && Date.now() - since < SESSION_HISTORY_PUSH_RETRY_MS) return false;
    pushQuarantinedFallback.set(projectId, Date.now());
    return true;
  }
}

/** True while the repo is inside an UNEXPIRED quarantine window. A Redis
 *  error falls back to the per-process window above — during a total outage
 *  the observable behavior is exactly the pre-fix one (this process skips
 *  the repo for the window; a window claimed in Redis before the outage is
 *  invisible, so the repo is attempted once and re-claimed locally). */
async function isPushQuarantined(projectId: string): Promise<boolean> {
  try {
    return !!(await withQuarantineTimeout(__pushQuarantineRedisClient.current.get(`${PUSH_QUARANTINE_KEY_PREFIX}${projectId}`)));
  } catch {
    const since = pushQuarantinedFallback.get(projectId);
    return since !== undefined && Date.now() - since < SESSION_HISTORY_PUSH_RETRY_MS;
  }
}

/** Forget a repo's quarantine window early — the proof the credential works
 *  again is a landed push (called on r.synced > 0). Best-effort: a failed DEL
 *  just leaves the window to expire on its own (both stores). */
async function clearPushQuarantine(projectId: string): Promise<void> {
  pushQuarantinedFallback.delete(projectId);
  try {
    await withQuarantineTimeout(__pushQuarantineRedisClient.current.del(`${PUSH_QUARANTINE_KEY_PREFIX}${projectId}`));
  } catch { /* best-effort — the TTL expires the Redis window anyway */ }
}

/** Test seam: forget the module's per-process memos (legacy-migrated,
 *  no-mirror warned, and the push-quarantine OUTAGE fallback — the REDIS
 *  quarantine itself lives in the server, so tests reset that through
 *  __pushQuarantineRedisClient / their own mock store, not here). */
export function __resetSessionHistorySyncForTest(): void {
  legacyMigrated.clear();
  noMirrorWarned.clear();
  pushQuarantinedFallback.clear();
  archivedProjectNoted.clear();
}

/** Tree path of a session's file on the consolidated branch. */
export function sessionHistoryPath(sessionId: string): string {
  return `sessions/${sessionId}/${HISTORY_FILE}`;
}

/** Inverse of sessionHistoryPath — null for any other tree path. */
function sessionIdFromPath(treePath: string): string | null {
  const m = treePath.match(/^sessions\/([^/]+)\/HISTORY\.md$/);
  return m ? m[1] : null;
}

/** LEGACY: the branch (and full ref) a session's history lives on. */
function legacyHistoryRef(sessionId: string): string {
  return `${LEGACY_SESSION_HISTORY_REF_PREFIX}${sessionId}`;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** execFile errors embed the full argv — with an authed remote that means the
 *  token. Every remote-touching git call goes through a wrapper using this so
 *  no error object carrying credentials can ever reach a logger. */
/** T7 (2026-09-28): the shared URL-credential mask (utils/redact-credentials) — one helper for every git error path. */
const redact = (v: unknown) => redactUrlCredentials(v);

/**
 * The documented auto-commit message format: `history: auto-sync <ISO-8601
 * UTC second>` (e.g. `history: auto-sync 2026-09-02T20:30:00Z`). Fresh per
 * commit — it is the commit's timestamp, not file content.
 */
function historyCommitMessage(): string {
  return `history: auto-sync ${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * Render the deterministic HISTORY.md. NO timestamps inside the file: byte
 * stability across passes is what lets the unchanged-blob check skip a
 * no-op commit+push. Journal entries use the compact buildParentContextBlock
 * shape (goal → outcome, Decisions/Failures sub-lines) minus its date prefix;
 * transcript lines render oldest→newest as `role: content` (whitespace
 * collapsed, hard-truncated). Over the cap? Oldest transcript lines drop
 * whole first; a still-oversized file is hard-truncated last.
 */
async function buildHistoryMarkdown(s: SessionRow): Promise<string> {
  const header = [
    `# Session History — ${collapse(s.title || 'Untitled session')}`,
    '',
    `- Session id: ${s.id}`,
    `- Branch: ${s.branch}`,
    `- Status: ${s.status}`,
    `- Project: ${collapse(s.project?.name ?? '')}`,
  ];

  const entries = await getRecentJournalEntries(s.id, JOURNAL_TAKE);
  const journalLines: string[] = [];
  for (const e of entries) {
    journalLines.push(`- ${collapse(e.goal)} → ${collapse(e.outcome)}`);
    if (e.keyDecisions.length) journalLines.push(`  Decisions: ${e.keyDecisions.join('; ')}`);
    if (e.failures.length) journalLines.push(`  Failures: ${e.failures.join('; ')}`);
  }

  // MERGE-1 slice 1: read the transcript through the read-switch, not coding_messages
  // directly — a mirror-only chat's markdown transcript was silently empty here.
  const msgSource = await pickTranscriptSource(s.id);
  const messages = msgSource === 'legacy'
    ? await prisma.codingMessage.findMany({
        where: { chatId: s.id },
        orderBy: { createdAt: 'desc' },
        take: TRANSCRIPT_TAKE,
        select: { role: true, content: true },
      })
    : await prisma.crossModelMessage.findMany({
        where: { chatId: s.id },
        orderBy: { createdAt: 'desc' },
        take: TRANSCRIPT_TAKE,
        select: { role: true, content: true },
      });
  let transcriptLines = messages.reverse().map(m => {
    const c = collapse(m.content);
    return `${m.role}: ${c.length > TRANSCRIPT_LINE_CAP ? `${c.slice(0, TRANSCRIPT_LINE_CAP - 1)}…` : c}`;
  });

  const assemble = (tLines: string[]): string => `${[
    ...header, '',
    '## Run journal (newest first)', '',
    ...(journalLines.length ? journalLines : ['(no journal entries yet)']), '',
    '## Recent transcript (oldest first)', '',
    ...(tLines.length ? tLines : ['(no messages yet)']),
  ].join('\n')}\n`;

  let out = assemble(transcriptLines);
  while (out.length > HISTORY_CAP_BYTES && transcriptLines.length) {
    transcriptLines = transcriptLines.slice(1); // drop the OLDEST line first
    out = assemble(transcriptLines);
  }
  if (out.length > HISTORY_CAP_BYTES) out = `${out.slice(0, HISTORY_CAP_BYTES - 1)}…`;
  return out;
}

/** rev-parse --verify that degrades to null when the ref/path is absent. */
async function resolveSha(mirror: string, spec: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', spec], mirror)).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Push target: mirrors persist a TOKENLESS origin by convention
 * (workspace.service strips credentials after every fetch), so a bare
 * `push origin` can NEVER authenticate against a private GitHub repo — 4/25
 * sessions failed exactly this way on box C (watch pass #3, 2026-09-08:
 * "remote: Repository not found / Authentication failed"). GitHub projects
 * push to a per-operation authed URL built from a FRESH token (the
 * ensureRepoMirror pattern — never persisted); other providers keep the
 * stored remote. A null token falls back to the plain URL and fails exactly
 * as before (counted, retried next pass).
 */
async function pushRemoteFor(project: SessionRow['project'] | null | undefined): Promise<string> {
  // Isolation boundary (ticket c75b5f34, review F2): a NON-prod instance
  // never pushes (or --delete-sweeps) session history onto the PRODUCTION
  // repo, even when a project row points there and the owner's token could.
  // Throws IsolationBoundaryError — the sweep's catches count it as
  // pushDenied (terminal, quarantined like auth refusals), never as a
  // retried-forever failure. Prod is a no-op.
  assertRepoTargetAllowed(String(project?.repoUrl ?? '') || 'origin');
  return project?.repoProvider === 'github' && project.repoUrl
    ? authedUrl(project.repoUrl, await getValidToken(project.userId))
    : 'origin';
}

/** Remote-touching git in `mirror` with the credential-redacting error wrapper. */
function remoteGitFor(mirror: string) {
  return async (args: string[]): Promise<string> => {
    try { return (await git(args, mirror, 120_000)).stdout; }
    catch (err: any) { throw new Error(redact(err?.message ?? err)); }
  };
}

/* ====================================================================
 * Consolidated single branch (default)
 * ==================================================================== */

/** Repos whose legacy per-session refs are gone (local + origin) — process
 *  memory only; a restart re-checks once, cheaply. */
const legacyMigrated = new Set<string>();

/** Repos whose mirror directory is GONE on this box (hardening loop 2026-09-24):
 *  `spawn git ENOENT` is Node's shape for a missing cwd. Prod: three dead
 *  blank-provider sessions whose stale worktreePath survived the cross-box
 *  fix produced 3 warns every 10-minute pass, forever, counted as "failed".
 *  A missing mirror is a SKIP (nothing to sync, nothing to retry) — warned
 *  ONCE per repo per process; the reaper/next provisioning owns the row. */
const noMirrorWarned = new Set<string>();
export function isMissingRepoError(err: unknown): boolean {
  const e = err as { code?: string; message?: unknown } | null;
  if (e?.code === 'ENOENT') return true;
  return /spawn git ENOENT|ENOENT: no such file or directory/.test(String(e?.message ?? err ?? ''));
}
function noteMirrorMissing(projectId: string, mirror: string, sessions: number): void {
  if (noMirrorWarned.has(projectId)) return;
  noMirrorWarned.add(projectId);
  logger.warn(`session history sync: project ${projectId} — mirror missing on disk (${mirror}); skipping its ${sessions} session(s) until it is provisioned again (warned once per process)`);
}

/** Projects already noted as archived-for-sync this process (info once). */
const archivedProjectNoted = new Set<string>();

/** A project row as the sweep sees it (the include: { project: true } shape). */
type ProjectRow = NonNullable<SessionRow['project']>;

/** The ancestor project ids a materialized /root/.../self path encodes
 *  (path segments; empty for legacy/stale paths). */
function ancestorIdsFromPath(path: string | null | undefined): string[] {
  if (!path) return [];
  return path.split('/').filter(Boolean);
}

/**
 * STOP FOR GONE/ARCHIVED PROJECTS (ticket 5eb035d6, owner decision
 * oq_fd533d0a 2026-10-16 "STOP THE JOB"): a sync target's project can leave
 * the owner's account WITHOUT its sessions leaving the enumeration. A
 * DELETED project cascades its coding_states away (FK onDelete:Cascade), but
 * an ARCHIVED project — or any project nested under an archived folder —
 * keeps every chat row: archiving stamps ONLY the folder's own row, its
 * chats' archivedAt stay null, and the sweep's enumeration filter never
 * looked at the project at all (prod 52ad1f73: gone from every listing,
 * still pushed every 10-min cycle against a repo that refuses it). Such a
 * project is dead to sync: skip it every pass — its last-pushed HISTORY.md
 * files simply stay as-is on the consolidated branch (the backup keeps what
 * it has; pruning is per-repo inside syncRepoHistory, which a skipped
 * project never reaches) — with ONE info log per project per process
 * (mirroring noMirrorWarned: never a warn, never a loop). Derived state,
 * nothing persisted: restoring the project (archive_project
 * archivedAt:false) resumes sync on the next pass.
 */
async function dropSessionsUnderArchivedProjects(eligible: SessionRow[]): Promise<SessionRow[]> {
  if (!eligible.length) return eligible;
  // Own-row archive stamp (synchronous) + the set of parented projects whose
  // ANCESTORS need one batched lookup (path segments + the direct parentId,
  // so a stale materialized path cannot hide a just-archived parent).
  const kept: SessionRow[] = [];
  const parentedIds = new Set<string>();
  for (const s of eligible) {
    const p = s.project;
    if (!p || p.archivedAt) { noteProjectArchivedForSync(p ?? null, s.projectId); continue; }
    if (p.parentId) parentedIds.add(p.id);
    kept.push(s);
  }
  if (!parentedIds.size) return kept;
  const ancestorIdsOf = new Map<string, string[]>();
  for (const s of kept) {
    const p = s.project!;
    if (!parentedIds.has(p.id)) continue;
    ancestorIdsOf.set(p.id, [...new Set([...ancestorIdsFromPath(p.path), p.parentId!])]);
  }
  const allAncestors = [...new Set([...ancestorIdsOf.values()].flat())];
  let archivedAncestors = new Set<string>();
  try {
    const rows = await prisma.crossModelProject.findMany({
      where: { id: { in: allAncestors } },
      select: { id: true, archivedAt: true },
    });
    archivedAncestors = new Set(rows.filter(r => r.archivedAt).map(r => r.id));
  } catch {
    // DB hiccup: fail safe for DATA (keep syncing this pass; the next pass
    // re-checks) — the alternative would stop sync on a transient outage.
    return kept;
  }
  if (!archivedAncestors.size) return kept;
  const dead: SessionRow[] = [];
  const final: SessionRow[] = [];
  for (const s of kept) {
    const anc = ancestorIdsOf.get(s.project!.id);
    if (anc?.some(a => archivedAncestors.has(a))) dead.push(s);
    else final.push(s);
  }
  for (const s of dead) noteProjectArchivedForSync(s.project!, s.projectId);
  return final;
}

/** Info-log a sync target whose project is gone/archived — ONCE per process. */
function noteProjectArchivedForSync(project: ProjectRow | null, projectId: string): void {
  if (archivedProjectNoted.has(projectId)) return;
  archivedProjectNoted.add(projectId);
  const name = project?.name ? ` ("${project.name}")` : '';
  logger.info(`session history sync: project ${projectId}${name} is no longer in the owner's account (deleted or archived) — its history sync is stopped; restoring the project resumes it (info once per process)`);
}

interface RepoSyncResult {
  synced: number;
  unchanged: number;
  failed: number;
  /** Sessions skipped because the repo mirror does not exist on this box. */
  noMirror: number;
  /** Sessions skipped this pass because the repo's push is quarantined
   *  (terminal auth refusal — see notePushQuarantined). */
  pushDenied: number;
  pruned: number;
  legacyDeleted: number;
}

/** Quarantine bookkeeping shared by both modes. Resolves to true when this
 *  call is the FIRST permanent refusal of the current quarantine window (the
 *  one that warns) — in Redis terms, when THIS process won the NX claim;
 *  false when the window was already claimed (by this or a previous boot,
 *  this or another box). */
async function notePushQuarantined(projectId: string, err: unknown): Promise<boolean> {
  const claimed = await claimPushQuarantine(projectId);
  if (!claimed) return false;
  logger.warn(`session history sync: project ${projectId} — push refused permanently (terminal auth; quarantined for ${Math.round(SESSION_HISTORY_PUSH_RETRY_MS / 3_600_000)}h, one fresh attempt after): ${redact(String((err as { message?: unknown })?.message ?? err))}`);
  return true;
}

/**
 * Build `tree + commit` over `parent` (null = root commit) for the
 * consolidated branch using a TEMP index: the parent's tree, plus each
 * updated session blob at sessions/<id>/HISTORY.md, minus each pruned
 * session's file. The real index is never read, modified, or locked.
 * Returns the commit sha; the caller owns the update-ref.
 */
async function buildConsolidatedCommit(
  mirror: string,
  parent: string | null,
  updates: ReadonlyMap<string, string>,
  removals: readonly string[],
  indexPath: string,
  message: string,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexPath };
  await git(parent ? ['read-tree', `${parent}^{tree}`] : ['read-tree', '--empty'], mirror, 120_000, env);
  for (const [sessionId, blobSha] of updates) {
    await git(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${sessionHistoryPath(sessionId)}`], mirror, 120_000, env);
  }
  // `update-index --force-remove <path>` calls setup_work_tree() for a path
  // argument (unlike --cacheinfo, which is option-only) and dies with "this
  // operation must be run in a work tree" in the bare mirror — verified on git
  // 2.50 (adversarial review 2026-09-14). Pointing GIT_WORK_TREE at the temp
  // dir satisfies it for existing AND absent paths; nothing is read from it.
  const removeEnv = { ...env, GIT_WORK_TREE: path.dirname(indexPath) };
  for (const sessionId of removals) {
    await git(['update-index', '--force-remove', sessionHistoryPath(sessionId)], mirror, 120_000, removeEnv);
  }
  const treeSha = (await git(['write-tree'], mirror, 120_000, env)).stdout.trim();
  const commitArgs = ['commit-tree', treeSha, ...(parent ? ['-p', parent] : []), '-m', message];
  return (await git(commitArgs, mirror)).stdout.trim();
}

/** sessionId → blob sha for every sessions/<id>/HISTORY.md at `tip`. */
async function readTreeEntries(mirror: string, tip: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { stdout } = await git(['ls-tree', '-r', tip], mirror);
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\d{6} blob (\S+)\t(.+)$/);
    if (!m) continue;
    const sessionId = sessionIdFromPath(m[2]);
    if (sessionId) out.set(sessionId, m[1]);
  }
  return out;
}

/**
 * Delete the mirror-LOCAL legacy refs (refs/heads/digby/session-history/<id>).
 * Required before the consolidated ref can be created (D/F conflict). Returns
 * true when none remain.
 */
async function deleteLocalLegacyRefs(mirror: string): Promise<boolean> {
  const { stdout } = await git(['for-each-ref', '--format=%(refname)', LEGACY_SESSION_HISTORY_REF_PREFIX], mirror);
  const refs = stdout.split('\n').map(l => l.trim()).filter(r => r.startsWith(LEGACY_SESSION_HISTORY_REF_PREFIX));
  let ok = true;
  for (const ref of refs) {
    try { await git(['update-ref', '-d', ref], mirror); }
    catch (err: any) { ok = false; logger.warn(`session history sync: could not delete local legacy ref ${ref}: ${err?.message ?? err}`); }
  }
  return ok;
}

/**
 * Delete the ORIGIN legacy branches (best-effort, batched). Required before
 * the consolidated branch can be pushed (D/F conflict on the remote). Returns
 * { deleted, ok } — ok=false means some batch failed and the repo must be
 * re-checked next pass.
 */
async function deleteRemoteLegacyBranches(
  remoteGit: (args: string[]) => Promise<string>,
  remote: string,
  projectId: string,
): Promise<{ deleted: number; ok: boolean }> {
  let listing: string;
  try {
    listing = await remoteGit(['ls-remote', '--heads', remote, `${LEGACY_SESSION_HISTORY_REF_PREFIX}*`]);
  } catch (err: any) {
    logger.warn(`session history sync: project ${projectId} — ls-remote for legacy branches failed (retried next pass): ${err?.message ?? err}`);
    return { deleted: 0, ok: false };
  }
  const refs: string[] = [];
  for (const line of listing.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    // Only the per-session shape — never the consolidated branch itself.
    if (ref && LEGACY_REMOTE_REF_RE.test(ref)) refs.push(ref);
  }
  if (refs.length === 0) return { deleted: 0, ok: true };
  let deleted = 0;
  let ok = true;
  for (let i = 0; i < refs.length; i += LEGACY_DELETE_BATCH) {
    const batch = refs.slice(i, i + LEGACY_DELETE_BATCH);
    try {
      await remoteGit(['push', remote, '--delete', ...batch]);
      deleted += batch.length;
    } catch (err: any) {
      ok = false;
      logger.warn(`session history sync: project ${projectId} — deleting ${batch.length} legacy branch(es) on origin failed (retried next pass): ${err?.message ?? err}`);
    }
  }
  logger.info(`session history sync: project ${projectId} — deleted ${deleted} of ${refs.length} legacy per-session history branch(es) on origin (superseded by ${SESSION_HISTORY_BRANCH})`);
  return { deleted, ok };
}

/**
 * Sync ONE repo (= one mirror): render every live session, commit the changed
 * files + prune the dead ones onto the consolidated branch, push once. NEVER
 * throws — a repo-level failure counts every non-unchanged session as failed.
 */
async function syncRepoHistory(projectId: string, sessions: SessionRow[], pruneSafe: boolean): Promise<RepoSyncResult> {
  const result: RepoSyncResult = { synced: 0, unchanged: 0, failed: 0, noMirror: 0, pushDenied: 0, pruned: 0, legacyDeleted: 0 };
  const mirror = repoMirrorPath(projectId);
  const project = sessions[0]?.project;
  let tmpDir: string | null = null;
  const updates = new Map<string, string>(); // sessionId → new blob sha
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-history-'));
    const parent = await resolveSha(mirror, SESSION_HISTORY_REF);
    const existing = parent ? await readTreeEntries(mirror, parent) : new Map<string, string>();

    const live = new Set<string>();
    for (const s of sessions) {
      live.add(s.id);
      try {
        const content = await buildHistoryMarkdown(s);
        const contentPath = path.join(tmpDir, `${s.id}.md`);
        await fs.writeFile(contentPath, content, 'utf8');
        const blobSha = (await git(['hash-object', '-w', '--no-filters', contentPath], mirror)).stdout.trim();
        if (existing.get(s.id) === blobSha) { result.unchanged++; continue; }
        updates.set(s.id, blobSha);
      } catch (err: any) {
        if (isMissingRepoError(err)) {
          // The whole repo is gone from this box — nothing per-session to retry.
          result.noMirror = sessions.length - result.unchanged;
          result.failed = 0;
          noteMirrorMissing(projectId, mirror, result.noMirror);
          return result;
        }
        // A failed render keeps the session's PREVIOUS file in the tree.
        result.failed++;
        logger.warn(`session history sync: session ${s.id} failed (next pass retries): ${err?.message ?? err}`);
      }
    }
    // Prune: sessions in the tree that are no longer live. Only when this
    // pass saw the whole live set — a capped enumeration must never prune.
    const removals = pruneSafe ? [...existing.keys()].filter(id => !live.has(id)) : [];
    if (updates.size === 0 && removals.length === 0) return result;

    const indexPath = path.join(tmpDir, 'index');
    const commitSha = await buildConsolidatedCommit(mirror, parent, updates, removals, indexPath, historyCommitMessage());

    // Legacy refs conflict with the consolidated ref (git D/F rule): clear
    // the mirror-local ones BEFORE update-ref, the origin ones BEFORE push.
    const migrate = !legacyMigrated.has(projectId);
    const localOk = migrate ? await deleteLocalLegacyRefs(mirror) : true;
    // The old-value guard makes a lost race fail safe (throws → counted
    // failed this pass; the next pass re-reads the tip and self-heals).
    await git(['update-ref', SESSION_HISTORY_REF, commitSha, parent ?? ''], mirror);
    let localTip = commitSha;

    const remote = await pushRemoteFor(project);
    const remoteGit = remoteGitFor(mirror);
    if (migrate) {
      const r = await deleteRemoteLegacyBranches(remoteGit, remote, projectId);
      result.legacyDeleted = r.deleted;
      if (localOk && r.ok) legacyMigrated.add(projectId);
    }

    try {
      try {
        await remoteGit(['push', remote, SESSION_HISTORY_REF]);
      } catch (firstPushErr: any) {
        // Non-fast-forward (another worker/host pushed first) or a transient
        // failure: fetch the remote tip (best-effort — FETCH_HEAD holds it
        // regardless of the demoted mirror refspec), rebuild the SAME updates
        // on top of it, and retry the push ONCE. A second failure propagates.
        // Only rebuild when the fetch actually resolved this ref — in a
        // --mirror clone FETCH_HEAD otherwise still holds main's tip from the
        // last ensureRepoMirror fetch, and a rebuild on it would import main's
        // whole tree into the history branch (review 2026-09-14).
        const fetched = await remoteGit(['fetch', remote, SESSION_HISTORY_REF]).then(() => true).catch(() => false);
        const remoteTip = fetched ? await resolveSha(mirror, 'FETCH_HEAD') : null;
        if (remoteTip && remoteTip !== commitSha) {
          const rebased = await buildConsolidatedCommit(mirror, remoteTip, updates, removals, indexPath, historyCommitMessage());
          await git(['update-ref', SESSION_HISTORY_REF, rebased, localTip], mirror);
          localTip = rebased;
        }
        await remoteGit(['push', remote, SESSION_HISTORY_REF]);
        logger.warn(`session history sync: push for project ${projectId} needed a retry (${firstPushErr?.message ?? firstPushErr})`);
      }
    } catch (pushErr) {
      // Both pushes failed: roll the local ref back to what origin holds, or
      // the next pass would compare against an unpushed tip, read every
      // session as "unchanged", and never push again.
      try {
        if (parent) await git(['update-ref', SESSION_HISTORY_REF, parent, localTip], mirror);
        else await git(['update-ref', '-d', SESSION_HISTORY_REF, localTip], mirror);
      } catch { /* best-effort rollback */ }
      throw pushErr;
    }
    result.synced = updates.size;
    result.pruned = removals.length;
    return result;
  } catch (err: any) {
    result.synced = 0;
    result.pruned = 0;
    if (isMissingRepoError(err)) {
      result.failed = 0;
      result.noMirror = sessions.length - result.unchanged;
      noteMirrorMissing(projectId, mirror, result.noMirror);
      return result;
    }
    // A TERMINAL auth refusal can never succeed on retry: quarantine the
    // repo (one warn, skipped until SESSION_HISTORY_PUSH_RETRY_MS passes)
    // instead of logging "next pass retries" every 10 minutes forever —
    // prod 52ad1f73/octocat-Hello-World ran exactly that storm for 2+ days
    // (89 rows/7d, FO firing 106). The window lives in REDIS so worker
    // reboots (every deploy) do not reset it (ticket b6477bc7). Transient
    // failures keep the old contract. The isolation-boundary refusal
    // (c75b5f34 review F2) is terminal the same way — a prod target on a
    // non-prod instance can never succeed on retry.
    if (err instanceof IsolationBoundaryError || isPermanentPushAuthError(err)) {
      // DURABLE streak (ticket 5eb035d6): 3 consecutive refusals STOP the
      // job (owner oq_fd533d0a) — one info log at the crossing, silent skip
      // after, one re-probe per day, cleared by any landed push. Once the
      // durable disable governs (noteAuthRefused TRUE) the quarantine warn
      // is suppressed too: a per-window warn on every daily re-probe is
      // exactly the loop the owner ordered stopped.
      if (!(await noteAuthRefused(projectId))) await notePushQuarantined(projectId, err);
      result.failed = 0;
      result.pushDenied = sessions.length - result.unchanged;
      return result;
    }
    // Repo-level failure: every session that was not confirmed unchanged
    // did not land this pass.
    result.failed = sessions.length - result.unchanged;
    logger.warn(`session history sync: project ${projectId} failed (${sessions.length} session(s); next pass retries): ${redact(err?.message ?? err)}`);
    return result;
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ====================================================================
 * LEGACY per-session branches (SESSION_HISTORY_SINGLE_BRANCH_DISABLED=1)
 * ==================================================================== */

/**
 * Build `tree + commit` for one HISTORY.md blob at the tree root over
 * `parent` (null = root commit) using a TEMP index. Returns the commit sha;
 * the caller owns the update-ref.
 */
async function buildLegacyTreeAndCommit(
  mirror: string,
  blobSha: string,
  parent: string | null,
  indexPath: string,
  message: string,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexPath };
  await git(parent ? ['read-tree', `${parent}^{tree}`] : ['read-tree', '--empty'], mirror, 120_000, env);
  await git(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${HISTORY_FILE}`], mirror, 120_000, env);
  const treeSha = (await git(['write-tree'], mirror, 120_000, env)).stdout.trim();
  const commitArgs = ['commit-tree', treeSha, ...(parent ? ['-p', parent] : []), '-m', message];
  return (await git(commitArgs, mirror)).stdout.trim();
}

/**
 * LEGACY: sync ONE session onto its own digby/session-history/<sessionId>
 * branch. Returns 'unchanged' when the branch tip already holds the same
 * blob (no commit, no push). Throws on failure — the sweep's per-session
 * catch counts it.
 */
async function syncSessionHistoryLegacy(s: SessionRow): Promise<'synced' | 'unchanged'> {
  const mirror = repoMirrorPath(s.projectId);
  const ref = legacyHistoryRef(s.id);
  const content = await buildHistoryMarkdown(s);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-history-'));
  try {
    const contentPath = path.join(tmpDir, HISTORY_FILE);
    const indexPath = path.join(tmpDir, 'index');
    await fs.writeFile(contentPath, content, 'utf8');

    const parent = await resolveSha(mirror, ref);
    const blobSha = (await git(['hash-object', '-w', '--no-filters', contentPath], mirror)).stdout.trim();

    if (parent) {
      // rev-parse <tip>:HISTORY.md throws when the path is absent → null.
      let oldBlob: string | null = null;
      try {
        oldBlob = (await git(['rev-parse', `${parent}:${HISTORY_FILE}`], mirror)).stdout.trim() || null;
      } catch { oldBlob = null; }
      if (oldBlob === blobSha) return 'unchanged';
    }

    const commitSha = await buildLegacyTreeAndCommit(mirror, blobSha, parent, indexPath, historyCommitMessage());
    await git(['update-ref', ref, commitSha, parent ?? ''], mirror);

    const remote = await pushRemoteFor(s.project);
    const remoteGit = remoteGitFor(mirror);
    try {
      await remoteGit(['push', remote, ref]);
    } catch (firstPushErr: any) {
      const fetched = await remoteGit(['fetch', remote, ref]).then(() => true).catch(() => false);
      const remoteTip = fetched ? await resolveSha(mirror, 'FETCH_HEAD') : null;
      if (remoteTip && remoteTip !== commitSha) {
        const rebased = await buildLegacyTreeAndCommit(mirror, blobSha, remoteTip, indexPath, historyCommitMessage());
        await git(['update-ref', ref, rebased, commitSha], mirror);
      }
      await remoteGit(['push', remote, ref]);
      logger.warn(`session history sync: push for session ${s.id} needed a retry (${firstPushErr?.message ?? firstPushErr})`);
    }
    return 'synced';
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ====================================================================
 * The sweep
 * ==================================================================== */

/**
 * ONE history-sync pass (durable cron, every SESSION_HISTORY_SYNC_INTERVAL_SEC).
 * NEVER throws — returns a ≤200-char summary for finishCronJob
 * (e.g. `synced 3, unchanged 40, failed 1 of 44, pruned 2, legacy deleted 87`).
 */
export async function runSessionHistorySyncOnce(): Promise<string> {
  let sessions: SessionRow[];
  try {
    sessions = await prisma.chatCodingState.findMany({
      // Live = worktree present, past provisioning, chat not archived. An
      // archived chat or a reaped worktree (nulled path) drops out here and
      // its file is pruned from the consolidated tree on this pass.
      where: { worktreePath: { not: null }, status: { not: 'provisioning' }, chat: { archivedAt: null } },
      include: { project: true },
      orderBy: { updatedAt: 'asc' },
      take: SESSION_TAKE,
    });
  } catch (err: any) {
    logger.warn(`session history sync: enumeration failed (next pass retries): ${err?.message ?? err}`);
    return `enumeration failed: ${String(err?.message ?? err)}`.slice(0, 200);
  }

  // Mirror reapIdleWorktrees' exact guard: blank/plain-provider projects have
  // no mirror (their standalone repo IS the worktree) — never sync. A 'local'
  // project has a mirror but it is born ORIGIN-LESS by design (ensureProvisioned
  // inits + seeds a Digby-owned bare repo on the same volume; workspace.service
  // never adds a remote), so pushing session history has no destination — the
  // DB rows are the durable record. Pre-fix (FO firing 22, 2026-09-25) these
  // fell through to pushRemoteFor's bare 'origin' and failed EVERY 10-minute
  // pass forever — prod 922fd3ad 01:42–02:03Z: "fatal: 'origin' does not
  // appear to be a git repository", counted failed with "next pass retries",
  // invisible to the noMirror skip because the mirror WAS present. A provider
  // flip to github/git (configureWorkspace) re-enables sync on the next pass.
  const eligible: SessionRow[] = [];
  let skipped = 0;
  for (const s of sessions) {
    // A session whose project row is GONE (dangling include — a project
    // DELETE normally cascades its coding_states away with it, so this is
    // the stale/dangling shape) is dead to sync BEFORE the provider filter:
    // ticket 5eb035d6's acceptance is "remove a project row → next pass
    // skips it with ONE info log, no warn". It flows into
    // dropSessionsUnderArchivedProjects, which notes it once per process.
    if (!s.project) { eligible.push(s); continue; }
    const provider = s.project.repoProvider;
    if (provider === 'blank' || !provider) { skipped++; continue; }
    if (provider === 'local') { skipped++; continue; }
    eligible.push(s);
  }
  // STOP FOR GONE/ARCHIVED PROJECTS (ticket 5eb035d6) — see
  // dropSessionsUnderArchivedProjects. Runs AFTER the provider filter so a
  // plain project's sessions are counted 'skipped' exactly as before.
  const live = await dropSessionsUnderArchivedProjects(eligible);
  const archivedProject = eligible.length - live.length;

  let synced = 0;
  let unchanged = 0;
  let failed = 0;
  let noMirror = 0;
  let pushDenied = 0;
  let pruned = 0;
  let legacyDeleted = 0;

  if (!sessionHistorySingleBranchEnabled()) {
    for (const s of live) {
      // Quarantine is per-REPO: skip every session of an auth-refused project
      // (the legacy mode pushes per-session refs, but the refusal is the
      // repo's credential, not the ref's). The DURABLE auth-disable streak
      // (ticket 5eb035d6) sits above it: N consecutive refusals stop the job
      // until the daily re-probe.
      if (await isAuthDisabled(s.projectId)) { pushDenied++; continue; }
      if (await isPushQuarantined(s.projectId)) { pushDenied++; continue; }
      try {
        if ((await syncSessionHistoryLegacy(s)) === 'synced') {
          synced++;
          // A landed push proves the credential works — clear BOTH the
          // quarantine and the durable streak (review F1: the legacy path
          // clears symmetrically with the consolidated path below).
          await clearPushQuarantine(s.projectId);
          await clearAuthDisable(s.projectId);
        } else unchanged++;
      } catch (err: any) {
        if (err instanceof IsolationBoundaryError || isPermanentPushAuthError(err)) {
          // See the consolidated path: once the durable disable governs
          // (noteAuthRefused TRUE) the warn is suppressed — the ticket's
          // acceptance is that the warn class stops appearing.
          if (!(await noteAuthRefused(s.projectId))) await notePushQuarantined(s.projectId, err);
          pushDenied++; continue;
        }
        failed++;
        logger.warn(`session history sync: session ${s.id} failed (next pass retries): ${err?.message ?? err}`);
      }
    }
  } else {
    const groups = new Map<string, SessionRow[]>();
    for (const s of live) {
      const g = groups.get(s.projectId);
      if (g) g.push(s); else groups.set(s.projectId, [s]);
    }
    // A capped enumeration did not see every live session — pruning on a
    // partial view would delete live files; skip pruning this pass.
    const pruneSafe = sessions.length < SESSION_TAKE;
    if (!pruneSafe) logger.warn(`session history sync: enumeration hit the ${SESSION_TAKE}-session cap — pruning skipped this pass`);
    for (const [projectId, group] of groups) {
      // DURABLE auth-disable streak (ticket 5eb035d6): N consecutive
      // terminal-auth refusals ⇒ the repo's sync is STOPPED (one info log at
      // the crossing, silent skip after) until the daily re-probe. This is
      // the owner's oq_fd533d0a "STOP THE JOB": no per-window warn loop.
      if (await isAuthDisabled(projectId)) { pushDenied += group.length; continue; }
      if (await isPushQuarantined(projectId)) { pushDenied += group.length; continue; }
      const r = await syncRepoHistory(projectId, group, pruneSafe);
      synced += r.synced;
      unchanged += r.unchanged;
      failed += r.failed;
      noMirror += r.noMirror;
      pushDenied += r.pushDenied;
      pruned += r.pruned;
      legacyDeleted += r.legacyDeleted;
      // ANY landed push — updates or prune-only — is proof the credential
      // works again: forget the quarantine window AND the durable streak
      // (review F4: keying off synced>0 alone left a prune-only landing or
      // a quiescent repo disabled another 24h).
      if (r.synced > 0 || r.pruned > 0 || r.legacyDeleted > 0) {
        await clearPushQuarantine(projectId);
        await clearAuthDisable(projectId);
      }
    }
  }

  const summary = `synced ${synced}, unchanged ${unchanged}, failed ${failed} of ${synced + unchanged + failed}`
    + (pruned ? `, pruned ${pruned}` : '')
    + (legacyDeleted ? `, legacy deleted ${legacyDeleted}` : '')
    + (skipped ? `, skipped ${skipped}` : '')
    + (archivedProject ? `, project gone ${archivedProject}` : '')
    + (noMirror ? `, no mirror ${noMirror}` : '')
    + (pushDenied ? `, push denied ${pushDenied}` : '');
  logger.info(`session history sync: ${summary}`);
  return summary.slice(0, 200);
}
