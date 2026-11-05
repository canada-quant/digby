/**
 * Attention watchdog (ticket 426bc9e7, owner-audit ask 2026-08-22): PUSH the
 * owner when the fleet needs a human, instead of the owner pull-pinging
 * "progress?" (~19 bare pings in 14 days, two 4am self-discovered outages).
 *
 * A 15-min durable-cron sweep (worker.ts `attention-watchdog`, aligned with
 * the deploy-healthcheck cadence) that detects, PER USER WITH A SUPERVISOR
 * CHAT (isSupervisor=true — the channel the notice posts into):
 *
 *   (a) chats ENTERING attention_needed —
 *       · ask_user questions + ask-only approvals (Redis `confirm:pending:*`
 *         via readConfirmPendingForChats — the same leg the sidebar poll reads)
 *       · staged PendingConfirmation cards (durable Postgres leg)
 *   (b) goals/todos BLOCKED for > 30 min (BLOCKED_MIN_AGE_MS).
 *   (c) tracked items that LEFT the pending set WITHOUT a resolution (ticket
 *       f789d84e — expired confirm cards leave no trace): a vanished
 *       confirmation whose row lapsed to 'expired' (a row still 'pending' —
 *       even past expiresAt — is a LIVE stale card since ticket 7705fec2 and
 *       never vanishes on a timer), or a vanished ask whose durable
 *       record (coding/pending-durable) says 'expired'. These post ONE
 *       "expired unresolved" line each — same dedupe discipline (state entry
 *       held, marked expiredMs, pruned only after the notice posts; quiet
 *       hours hold them for the morning flush). Fail-quiet: an exit with no
 *       durable proof of expiry is treated as resolved — the watchdog never
 *       fabricates an expiry claim.
 *
 * …and posts ONE consolidated, deduped assistant message into that user's
 * Fleet Supervisor thread. Dedupe + the 30-min rule ride a per-user Redis
 * hash (`attn-watchdog:state:{userId}`, field = item id, value = {firstSeenMs,
 * notified}): an item notifies ONCE; when it resolves (key gone / status
 * cleared) its state is pruned, so a LATER recurrence re-notifies. A blocked
 * item's clock seeds from its updatedAt at first observation (a goal blocked
 * 3h ago notifies on the first sweep after deploy; an edit does NOT reset the
 * clock afterward — the stored firstSeen wins).
 *
 * Quiet hours (23:00–07:00 in the user's memory-facts timezone, default
 * America/Vancouver): newly-qualified items are held — state still tracks
 * them, nothing posts — and the first sweep at/after 07:00 flushes ONE
 * consolidated notice with everything still pending. Items that resolve
 * overnight never notify. EXCEPTION (v1#15): OUTAGE-class detections
 * (overdue_cadence — the sweeper-stall signature) BYPASS quiet hours and
 * additionally push to the owner's Telegram (pushOutageToOwnerTelegram);
 * an unattended stalled sweeper overnight is exactly the failure the bypass
 * exists for.
 *
 * Project-supervisor preflight 2026-09-14: the supervisor NOTE SCAN (below)
 * also covers every isProjectSupervisor lane the user owns — classifier
 * metrics stamped with meta.projectId, streaks observed (one guard_strike
 * row) rather than nudged. The attention items themselves are unchanged.
 *
 * Visibility: the notice is a plain assistant message with metadata.origin
 * 'attention-watchdog' — deliberately NOT in fleet.service's MACHINE_ORIGINS
 * set, so it survives the supervisor thread's machine-noise filter (it IS the
 * interactive content the owner reads). It never fires an agent run, never
 * touches the user-turn-anchored confirmation gate.
 *
 * Failure posture: per-user try/catch isolation (one bad user can't kill the
 * sweep); Redis hiccups degrade to a skipped/duplicated notice, never a throw
 * into the cron loop. Kill-switch: ATTENTION_WATCHDOG_DISABLED=1 (the
 * PROJECT_DIGEST_DISABLED pattern).
 *
 * The sweep also carries the ZOMBIE MACHINE-RUN STOP (live incident
 * 2026-09-10) — see the section header above sweepZombieMachineRuns.
 */

import { createHash } from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { readConfirmPendingForChats } from '../confirm-pending';
import { loadDurablePending } from '../coding/pending-durable';
import { loadUserTimezone } from '../coding/datetime-context';
import { recordLoopMetric } from '../platform/loop-metrics.service';
// Supervisor OFF switch (owner 2026-09-26): the stuck-note nudge asks the
// supervisor to act — pointless while its switch is off, so it is skipped.
import { getFleetSupervisorEnabled, recordSupervisorSwitchSkip } from '../platform/supervisor-switch';
import { getMachineLockedChatIds, requestChatRunStop } from '../chat-agent/chat-busy';
import { isHarnessErrorNote } from '../coding/harness-error-notes';
import { supervisorReportUpIsAction } from '../coding/schedule-cadence';
import { archivedTargetRetireDisabled } from '../platform/archived-target-retire';
import { harnessNoteKind, stripHarnessNoopLines, supervisorHarnessReceiptsDisabled } from '../platform/harness-receipts';

// ── Tunables ──────────────────────────────────────────────────────────────────

/** A goal/todo must be continuously blocked this long before it notifies. */
export const BLOCKED_MIN_AGE_MS = 30 * 60 * 1000;
/** Quiet-hours window (local hour): [QUIET_START_HOUR, QUIET_END_HOUR). */
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 7;
/** Fallback tz when the user has no valid memory-facts timezone. */
export const DEFAULT_TZ = 'America/Vancouver';
/** Bound on supervisor chats swept per firing (pathology guard). */
export const MAX_USERS_PER_SWEEP = 200;
/** Items per notice before an overflow line takes over. */
export const MAX_NOTICE_ITEMS = 10;
/** State hash TTL — refreshed on every write; self-cleans dead users. */
const STATE_TTL_SEC = 30 * 86400;
const STATE_KEY = (userId: string) => `attn-watchdog:state:${userId}`;
/** Cadence-vanished snapshot (ticket bd954d27): one JSON blob per user holding
 *  the recurring schedules seen at the previous sweep ({id: {r: runsCount,
 *  s: sessionId, e: enabled}}). Rewritten every sweep; 7d TTL self-cleans. */
const SCHED_SNAP_TTL_SEC = 7 * 86400;
const SCHED_SNAP_KEY = (userId: string) => `attn-watchdog:schedsnap:${userId}`;
/** Supervisor stop-credit skew (ticket 7503189b): a supervisor report of a
 *  schedule's stop counts when posted at/after lastFiredAt minus this slack
 *  (lastFiredAt is app-clock, message createdAt is DB-clock — cross-clock skew). */
export const SUPERVISOR_STOP_CREDIT_SKEW_MS = 5 * 60 * 1000;
/** Cap on per-row supervisor-credit lookups per sweep — a pathology user with
 *  many stopped sessions degrades to the pre-fix cards, never to a slow sweep. */
const MAX_STOP_CREDIT_CHECKS_PER_SWEEP = 10;
/** Cancel-class phrasing marking a supervisor note as REPORTING the stop.
 *  Ground truth (ticket 7503189b): "851410b7 (scaffold, cancelled 12/48)". */
const STOP_REPORT_KEYWORD = /\b(?:cancel\w*|disabled|retired|stopped|deleted)\b/i;

// ── Supervisor note scan (2026-09-02 supervisor value upgrade) ────────────────
// Two duties over the supervisor chat's own recent machine-wake notes:
//   (1) HARNESS-written self-measurement: classify each newly persisted note
//       (classifySupervisorNote — supervisor.service owns the markers) into
//       supervisor_noop / supervisor_action / supervisor_note loop_metrics
//       rows, so "is the supervisor acting or looping?" is chartable. The
//       persist site itself (chat-agent finalize) is contended, so the scan
//       rides this sweep: a Redis cursor (newest classified note's createdAt)
//       makes it exactly-once-ish; a missing cursor only SEEDS — it never
//       backfills history (the cadence-vanished baseline pattern).
//   (2) STUCK-LOOP backstop: 3+ near-identical notes in a row (cheap
//       token-overlap similarity, no LLM — ids/digits normalized away so a
//       re-narration differing only in timestamps still matches; compliant
//       no-op one-liners are exempt — quiet is the contract, not a loop)
//       injects ONE '[WATCHDOG] …' nudge into the supervisor thread — the same
//       crossModelMessage channel the attention notices use, origin
//       'attention-watchdog' so it survives the machine-noise filter and the
//       supervisor's next wake reads it (its Wake economy rules make it
//       binding). Deduped by a fingerprint of the repeated content: the nudge
//       fires once per streak, re-arms when the streak breaks, and posts even
//       during quiet hours (it is machine-directed — overnight is exactly when
//       an unattended stuck loop burns wakes).

/** Supervisor machine-wake note origins (mirrors fleet.service MACHINE_ORIGINS).
 *  Watchdog notices ('attention-watchdog') and user-turn replies (no origin)
 *  are NOT wake notes and never enter the scan. */
const SUPERVISOR_NOTE_ORIGINS = new Set(['schedule', 'hook', 'machine', 'agent', 'webhook']);
/** Newest assistant rows fetched per sweep (bounds both duties; telemetry is
 *  lossy by design — a >15-note burst between sweeps loses the overflow). */
const NOTE_SCAN_FETCH = 15;
/** Consecutive near-identical notes that mean STUCK. */
export const STUCK_NOTE_COUNT = 3;
/** Token-overlap (Jaccard) threshold for "near-identical". */
export const STUCK_NOTE_SIMILARITY = 0.85;
const NOTE_CURSOR_TTL_SEC = 30 * 86400;
const NOTE_CURSOR_KEY = (userId: string) => `attn-watchdog:notecursor:${userId}`;
const STUCK_NUDGE_TTL_SEC = 7 * 86400;
const STUCK_NUDGE_KEY = (userId: string) => `attn-watchdog:stucknudge:${userId}`;
// Project-supervisor preflight 2026-09-14: the note scan now also runs over
// every isProjectSupervisor lane the user owns (review 2026-09-13: the scan
// read only the fleet chat, so a project supervisor's action/no-op ratio and
// stuck loops were invisible unless the fleet chat noticed). Per-CHAT keys —
// the fleet chat keeps its legacy per-user keys so its cursor/fingerprint
// state survives this deploy untouched. OBSERVE-ONLY on project lanes: the
// classifier rows carry meta.projectId, and a detected streak records ONE
// guard_strike {seam:'stuck_note_streak', outcome:'observed'} instead of
// posting the [WATCHDOG] nudge (no new machine-directed pressure on a lane).
export const PROJECT_NOTE_CURSOR_KEY = (userId: string, chatId: string) => `attn-watchdog:notecursor:${userId}:${chatId}`;
export const PROJECT_STUCK_KEY = (userId: string, chatId: string) => `attn-watchdog:stucknudge:${userId}:${chatId}`;
/** Bound on project-supervisor lanes scanned per user per sweep (pathology guard). */
export const MAX_PROJECT_SUPERVISORS_PER_USER = 50;
export const STUCK_NOTE_STREAK_SEAM = 'stuck_note_streak';

interface NoteScanOpts {
  /** Set for a project supervisor lane — stamps meta.projectId on every metric. */
  projectId?: string;
  /** false = observe-only streak handling (project lanes); the fleet chat keeps the nudge. */
  nudge: boolean;
  cursorKey: string;
  stuckKey: string;
}

/** The one-time nudge — '[WATCHDOG]' is a distinct namespace (guard-chrome
 *  redaction only strips the [HARNESS EVIDENCE GUARD —/[ACTION VERIFIER —
 *  banners, so this line reaches the model on its next wake). */
export const STUCK_NUDGE_TEXT =
  '[WATCHDOG] Your last 3 notes are near-identical — act or stand down. Per your Wake economy rules: ' +
  'take ONE corrective action on the stuck lane now (a specific steer, cancel_schedule, or a re-dispatch — cite its receipt id) ' +
  "or file ONE ticket (file_feedback) and reply with the single line 'STANDING DOWN: <lane> until state changes'. " +
  'Do not post this status again.';

/** Normalized token list for similarity: lowercase, ids/hex/digits and all
 *  punctuation (markdown pipes/dashes/emoji, timestamps) stripped — so two
 *  re-narrations differing only in ids, times, or table chrome compare equal.
 *  Pure — exported for tests. */
export function normalizeNoteTokens(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, ' ') // uuid/hash fragments before the digit strip
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard similarity on normalized token SETS (cheap, no LLM). Pure. */
export function noteSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeNoteTokens(a));
  const tb = new Set(normalizeNoteTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** True when the newest STUCK_NOTE_COUNT notes are pairwise-adjacent
 *  near-identical (each consecutive pair ≥ threshold). Pure — exported for tests. */
export function detectStuckNotes(notesNewestFirst: string[], threshold: number = STUCK_NOTE_SIMILARITY): boolean {
  if (!Array.isArray(notesNewestFirst) || notesNewestFirst.length < STUCK_NOTE_COUNT) return false;
  for (let i = 0; i + 1 < STUCK_NOTE_COUNT; i++) {
    if (noteSimilarity(notesNewestFirst[i], notesNewestFirst[i + 1]) < threshold) return false;
  }
  return true;
}

/** Streak fingerprint: hash of the newest note's normalized tokens — stable
 *  across id/timestamp churn, so one streak nudges exactly once. */
function noteFingerprint(content: string): string {
  return createHash('sha256').update(normalizeNoteTokens(content).join(' ')).digest('hex').slice(0, 24);
}

/**
 * wake-cadence-5: the platform tools whose ok:true receipt is LANE-FACING
 * WORK for a project supervisor (send_chat_message counts only when its
 * ids.chatId is NOT the Fleet Supervisor chat). Anything else in the wake
 * (reads, update_supervisor_state, a message to the Fleet Supervisor) is not
 * an action. Exported for tests.
 */
export const SUPERVISOR_LANE_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'start_coding_session', 'schedule_message', 'update_schedule', 'cancel_schedule',
  'pause_schedule', 'resume_schedule', 'stop_run', 'answer_chat_question', 'approve_request',
  'goal_create', 'goal_update', 'goal_premise_set', 'todo_create', 'todo_update',
  'dispatch_platform_task', 'file_feedback', 'update_feedback', 'send_to_instance',
]);

/**
 * PURE classifier over a wake's ok:true receipts: true iff ≥1 send_chat_message
 * targeted the Fleet Supervisor chat and NO other lane-facing action landed.
 * Exported for tests.
 */
export function receiptsAreReportUpOnly(
  receipts: Array<{ tool: string; ok: boolean; ids: any }>,
  fleetSupervisorChatId: string,
): boolean {
  let reportUps = 0;
  for (const r of receipts) {
    if (!r?.ok) continue;
    if (!SUPERVISOR_LANE_ACTION_TOOLS.has(String(r.tool))) continue;
    if (r.tool === 'send_chat_message' && String(r?.ids?.chatId ?? '') === fleetSupervisorChatId) { reportUps += 1; continue; }
    return false; // a real lane-facing action landed this wake
  }
  return reportUps >= 1;
}

/** The owner's Fleet Supervisor chat id (null when none / disabled / read error). */
async function resolveReportUpTarget(userId: string): Promise<string | null> {
  if (supervisorReportUpIsAction()) return null;
  try {
    const { findFleetSupervisorChat } = await import('../platform/supervisor.service');
    const fleet = await findFleetSupervisorChat(userId);
    return fleet?.id ?? null;
  } catch {
    return null;
  }
}

/** Receipts of one wake = the supervisor chat's ok:true receipts between the previous note and this one. Fail-open (false). */
async function isReportUpOnlyWake(supervisorChatId: string, fleetSupervisorChatId: string, prevNoteAt: Date | null, noteAt: Date): Promise<boolean> {
  try {
    const rows = await prisma.runToolReceipt.findMany({
      where: { chatId: supervisorChatId, ok: true, createdAt: { ...(prevNoteAt ? { gt: prevNoteAt } : {}), lte: noteAt } },
      select: { tool: true, ok: true, ids: true },
      take: 200,
    });
    return receiptsAreReportUpOnly((rows ?? []) as any, fleetSupervisorChatId);
  } catch {
    return false;
  }
}

async function scanSupervisorNotes(
  userId: string,
  supervisorChatId: string,
  // Project-supervisor preflight 2026-09-14: defaults = the fleet chat's
  // legacy behaviour byte-for-byte (per-user keys, nudge on, no projectId).
  opts: NoteScanOpts = { nudge: true, cursorKey: NOTE_CURSOR_KEY(userId), stuckKey: STUCK_NUDGE_KEY(userId) },
): Promise<void> {
  const projectMeta = opts.projectId ? { projectId: opts.projectId } : {};
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: supervisorChatId, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
    take: NOTE_SCAN_FETCH,
    select: { id: true, content: true, createdAt: true, metadata: true },
  });
  const notes = (rows ?? []).filter((r: any) => {
    if (!SUPERVISOR_NOTE_ORIGINS.has(String(r?.metadata?.origin ?? ''))) return false;
    // Ticket 08e58e1d: a provider-killed wake persists the harness's terminal
    // error envelope (the 429 "Sorry — I couldn't get an answer out this
    // time…" fallback) UNDER THE WAKE'S MACHINE ORIGIN — two dead wakes in a
    // row are byte-near-identical, so the stuck-note backstop was scoring the
    // platform's own error text as lane-authored notes and demanding the
    // supervisor act / stand down on text it never wrote. Harness error
    // envelopes are excluded from BOTH duties (classification telemetry + the
    // stuck backstop): the deterministic providerError marker first (stamped
    // at persist since this fix), then the envelope shapes themselves for
    // rows persisted before the marker existed.
    if (r?.metadata?.providerError) return false;
    if (isHarnessErrorNote(r?.content)) return false;
    return true;
  });
  if (notes.length === 0) return;

  // (1) Self-measurement — classify notes newer than the cursor, oldest first.
  try {
    const cursorRaw = await (redisClient as any).get(opts.cursorKey).catch(() => null);
    const cursorMs = Number(cursorRaw);
    if (cursorRaw != null && Number.isFinite(cursorMs)) {
      const { classifySupervisorNote } = await import('../platform/supervisor.service');
      const fresh = notes.filter((n: any) => n.createdAt.getTime() > cursorMs).reverse();
      // wake-cadence-5 (2026-09-27 tt-rd audit): a PROJECT supervisor wake
      // whose only receipted action was a send_chat_message to the Fleet
      // Supervisor is a REPORT-UP, not lane work — 259 of 306 messages went
      // up, 41 down, and every one counted as supervisor_action. The receipt
      // window is deterministic: this note's wake = receipts between the
      // previous note and this one. Resolved once per scan; fail-open (the
      // classic kind on any read error). SUPERVISOR_REPORT_UP_IS_ACTION=1
      // restores the old classification.
      const reportUpTarget = opts.projectId ? await resolveReportUpTarget(userId) : null;
      for (const n of fresh) {
        // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a note the
        // finalize stamped with the HARNESS count (metadata.harnessActions — the wake's
        // executed real mutating calls, report-ups split out) is classified from that
        // record, never from the model's markers; rows carry classifiedBy 'harness' so
        // the no-op / action trend's one-time break at deploy is visible. Older rows and
        // SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1 keep the marker regex below.
        const harnessKind = harnessNoteKind((n as any).metadata);
        let kind: string = harnessKind ?? classifySupervisorNote(n.content);
        let reportUp = harnessKind === 'supervisor_report_up';
        if (!harnessKind && kind === 'supervisor_action' && reportUpTarget) {
          const idx = notes.findIndex((x: any) => x.id === n.id);
          const prevAt: Date | null = idx >= 0 && idx + 1 < notes.length ? (notes[idx + 1] as any).createdAt : null;
          reportUp = await isReportUpOnlyWake(supervisorChatId, reportUpTarget, prevAt, n.createdAt);
          if (reportUp) kind = 'supervisor_report_up';
        }
        recordLoopMetric({
          kind,
          sessionId: supervisorChatId,
          // Project-supervisor preflight 2026-09-14: meta.projectId on project-lane rows.
          meta: { messageId: String(n.id).slice(0, 8), origin: String((n as any).metadata?.origin ?? ''), ...projectMeta, ...(reportUp ? { reportUp: true } : {}), ...(harnessKind ? { classifiedBy: 'harness', harnessActions: (n as any).metadata.harnessActions } : {}) },
        });
      }
    }
    // Seed/advance the cursor (a missing baseline never backfills history).
    await (redisClient as any)
      .set(opts.cursorKey, String(notes[0].createdAt.getTime()), { EX: NOTE_CURSOR_TTL_SEC })
      .catch(() => {});
  } catch (err: any) {
    logger.warn(`attention-watchdog: supervisor note classification failed (non-fatal): ${err?.message}`);
  }

  // (2) Stuck-loop backstop — one nudge per streak, re-armed when it breaks.
  // Compliant no-op one-liners are EXEMPT: under the Wake-economy contract,
  // repeated 'WAKE/SWEEP: no-op' lines are exactly what a quiet fleet should
  // produce — the disease this backstop breaks is repeated NARRATION (and
  // repeated identical action claims), never contract-compliant silence.
  try {
    if (notes.length < STUCK_NOTE_COUNT) return;
    // HARNESS-RECEIPTS (2026-10-20): the harness's zero-action lines ('WAKE: no-op
    // (harness: …' / 'Harness record: …' on a zero-call narration) are dropped before
    // the compare — they would otherwise exempt exactly the repeated narration this
    // exists to break. Review fix (same day): a wake the HARNESS recorded as acting
    // (metadata.harnessActions > 0) breaks the streak — the model's own differing
    // action lines used to keep acting wakes apart, and the harness's lines (tool
    // names + 8-char ids the tokenizer drops) cannot; repeated narration with zero
    // real actions is still the streak.
    const latestRows = notes.slice(0, STUCK_NOTE_COUNT);
    if (latestRows.some((n: any) => harnessNoteKind(n?.metadata) === 'supervisor_action')) {
      await (redisClient as any).del(opts.stuckKey).catch(() => {});
      return;
    }
    const ownWords = (c: string): string => (supervisorHarnessReceiptsDisabled() ? c : stripHarnessNoopLines(c));
    const latest = latestRows.map((n: any) => ownWords(String(n.content ?? '')));
    const { classifySupervisorNote } = await import('../platform/supervisor.service');
    if (classifySupervisorNote(latest[0]) === 'supervisor_noop') {
      await (redisClient as any).del(opts.stuckKey).catch(() => {});
      return;
    }
    if (detectStuckNotes(latest)) {
      const fingerprint = noteFingerprint(latest[0]);
      const already = await (redisClient as any).get(opts.stuckKey).catch(() => null);
      if (already === fingerprint) return; // this streak already got its one nudge / one metric
      if (opts.nudge && !(await getFleetSupervisorEnabled().catch(() => true))) {
        // Supervisor OFF switch: the streak is real but nothing can act on a
        // nudge; record the skip, keep the fingerprint so a re-enable does
        // not replay it.
        recordSupervisorSwitchSkip({ target: 'fleet', source: 'watchdog', chatId: supervisorChatId });
      } else if (opts.nudge) {
        await prisma.crossModelMessage.create({
          data: {
            chatId: supervisorChatId,
            role: 'assistant',
            content: STUCK_NUDGE_TEXT,
            metadata: { origin: 'attention-watchdog', kind: 'stuck-note-nudge' },
          },
        });
        logger.info('attention-watchdog: stuck-note nudge posted (3+ near-identical supervisor notes)', { userId });
      } else {
        // Project-supervisor preflight 2026-09-14: OBSERVE-ONLY on a project
        // lane — one guard_strike row per streak (outcome 'observed', the
        // gate-flip telemetry shape), no message, no pressure on the lane.
        recordLoopMetric({
          kind: 'guard_strike',
          sessionId: supervisorChatId,
          meta: { seam: STUCK_NOTE_STREAK_SEAM, outcome: 'observed', chatId: supervisorChatId, ...projectMeta },
        });
        logger.info('attention-watchdog: project-supervisor stuck-note streak observed (3+ near-identical notes; no nudge posted)', { userId, ...projectMeta });
      }
      await (redisClient as any).set(opts.stuckKey, fingerprint, { EX: STUCK_NUDGE_TTL_SEC }).catch(() => {});
    } else {
      // Streak broken — clear the fingerprint so a future re-stick re-nudges.
      await (redisClient as any).del(opts.stuckKey).catch(() => {});
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: stuck-note backstop failed (non-fatal): ${err?.message}`);
  }
}

// ── Shapes ────────────────────────────────────────────────────────────────────

type WatchItemKind = 'question' | 'approval' | 'confirmation' | 'blocked_goal' | 'blocked_todo' | 'cadence_stopped' | 'overdue_cadence' | 'cadence_vanished' | 'deaf_assignee' | 'orphaned_assignee' | 'stale_gate';

interface WatchItem {
  /** Dedupe key: ask:{chatId}:{entryId} | confirm:{pcId} | goal:{id} | todo:{id}. */
  id: string;
  kind: WatchItemKind;
  /** Chat title (attention kinds) or goal/todo title (blocked kinds). */
  title: string;
  /** The question/summary/blockedReason — what it's waiting on. */
  detail: string | null;
  /** Seed for the blocked-age clock + the "waiting …" label. */
  waitingSinceMs: number;
  /** Group heading (45a570e0): project name for blocked kinds (attention kinds
   *  group under their chat title — already `title`). */
  group?: string | null;
  /** Assignee chat title for blocked todos, when known. */
  assignee?: string | null;
}

interface ItemState {
  firstSeenMs: number;
  notified: 0 | 1;
  /** Snapshot for the expired-unresolved trace — the live item (and its title/
   *  detail) is gone by the time the expiry is reported. Written on observation;
   *  entries stored before this field shipped degrade to generic wording. */
  kind?: WatchItemKind;
  title?: string;
  detail?: string | null;
  /** Set when the item left the pending set WITHOUT a resolution; the entry is
   *  held (surviving quiet hours) until its 'expired unresolved' line posts,
   *  then pruned. */
  expiredMs?: number;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Human age label for the "waiting …" suffix: 42s→"1m", 95m→"2h", 50h→"2d". */
export function formatAge(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The user's local hour (0-23) in `tz` at `now`; Intl throws never escape. */
function localHour(now: Date, tz: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now);
    return parseInt(h, 10) % 24; // some ICU builds render midnight as "24"
  } catch {
    return new Date(now).getUTCHours(); // garbage tz → UTC hour (still bounded)
  }
}

/** True during 23:00–07:00 local. Pure — exported for tests. */
export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** "Sat 7:05 AM PDT" in the user's tz (user-FACING timestamp — never bare Zulu). */
function localStamp(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

/** Defensive parse of a state-hash value; garbage collapses to null (skipped). */
function parseState(raw: unknown): ItemState | null {
  try {
    const p = JSON.parse(String(raw));
    if (Number.isFinite(p?.firstSeenMs) && (p?.notified === 0 || p?.notified === 1)) {
      return {
        firstSeenMs: Number(p.firstSeenMs),
        notified: p.notified,
        ...(typeof p.kind === 'string' ? { kind: p.kind as WatchItemKind } : {}),
        ...(typeof p.title === 'string' ? { title: p.title } : {}),
        ...(typeof p.detail === 'string' ? { detail: p.detail } : {}),
        ...(Number.isFinite(p.expiredMs) ? { expiredMs: Number(p.expiredMs) } : {}),
      };
    }
  } catch { /* fall through */ }
  return null;
}

// ── Digest formatting (ticket 45a570e0: the owner found the wall-of-sentences
//    unreadable — "one block text"). Scannable lines: icon + age badge + the
//    short facts; grouping + counts live in the assembly below. ────────────────

const KIND_ICON: Record<WatchItemKind, string> = {
  question: '❓',
  approval: '🛂',
  confirmation: '✅',
  blocked_goal: '🚫',
  blocked_todo: '🚫',
  cadence_stopped: '⏸️',
  overdue_cadence: '⏰',
  cadence_vanished: '👻',
  deaf_assignee: '🔇',
  orphaned_assignee: '📦',
  stale_gate: '🔓',
};

/** Collapse whitespace and cap length with an ellipsis — one line stays one line.
 *  Array.from slices by code POINT, so an astral emoji at the cut can't split
 *  into a lone surrogate (review nit, PR #320). */
function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  const units = Array.from(t);
  return units.length <= max ? t : `${units.slice(0, max - 1).join('')}…`;
}

/**
 * Blocked-reason tail (45a570e0 §5): boilerplate dependency reasons
 * ("[deps] Waiting on 3 todos") collapse to a small tag; real reasons render
 * as a short quoted preview.
 */
function reasonTag(detail: string | null): string {
  if (!detail) return '';
  const d = detail.trim();
  if (!d) return '';
  if (/^\[deps\]/i.test(d)) return ' `[deps]`';
  return ` — “${truncate(d, 60)}”`;
}

/**
 * One scannable line per item (45a570e0 §4): state icon + age badge + short
 * title + optional assignee/reason — no sentences. Attention kinds render
 * under their chat's group heading (title = chat title), so the line carries
 * only WHAT is waiting; blocked kinds carry the truncated todo/goal title.
 */
function lineFor(item: WatchItem, ageMs: number): string {
  const age = formatAge(ageMs);
  const icon = KIND_ICON[item.kind];
  if (item.kind === 'blocked_goal' || item.kind === 'blocked_todo') {
    const noun = item.kind === 'blocked_goal' ? 'goal' : 'todo';
    const who = item.assignee ? ` · @${truncate(item.assignee, 24)}` : '';
    return `• ${icon} ${noun} · **${age}** — ${truncate(item.title, 80)}${reasonTag(item.detail)}${who}`;
  }
  if (item.kind === 'stale_gate') {
    const who = item.assignee ? ` · @${truncate(item.assignee, 24)}` : '';
    return `• ${icon} stale gate · **${age}** — ${truncate(item.title, 80)}: ${truncate(item.detail ?? 'parked on a resolved owner card', 140)}${who}`;
  }
  const what =
    item.kind === 'cadence_stopped' ? 'cadence stopped — confirm it was intentional or re-arm the schedule' :
    item.kind === 'overdue_cadence' ? 'schedule overdue — sweeper may be stuck' :
    item.kind === 'cadence_vanished' ? 'recurring schedule VANISHED without a cancel — check what deleted it' :
    item.kind === 'deaf_assignee' ? 'todo assignee is DEAF (no enabled schedule, silent past its deaf floor) — re-arm or re-dispatch' :
    item.kind === 'orphaned_assignee' ? 'todo assignee is ARCHIVED (orphaned — it will never run) — re-dispatch to a live lane or unassign' :
    item.kind === 'question' ? 'needs your answer' :
    item.kind === 'approval' ? 'needs an approve/deny' :
    'has a staged action to confirm';
  const d = item.detail?.trim();
  const detail = d ? `: “${truncate(d, 60)}”` : '';
  return `• ${icon} **${age}** — ${what}${detail}`;
}

/** Group-heading label: chat title (attention kinds) or project name (blocked). */
function groupOf(item: WatchItem): string {
  if (item.kind === 'blocked_goal' || item.kind === 'blocked_todo' || item.kind === 'stale_gate') return item.group ?? 'No project';
  return item.title;
}

/** Group rows by heading, preserving first-appearance order (Map semantics). */
function groupRows(rows: WatchItem[]): Map<string, WatchItem[]> {
  const byGroup = new Map<string, WatchItem[]>();
  for (const item of rows) {
    const g = groupOf(item);
    const arr = byGroup.get(g) ?? [];
    arr.push(item);
    byGroup.set(g, arr);
  }
  return byGroup;
}

/** One 'expired unresolved' line — the trace an expired card otherwise never leaves. */
function expiredBulletFor(st: ItemState): string {
  const noun =
    st.kind === 'question' ? 'question' :
    st.kind === 'approval' ? 'approval request' :
    st.kind === 'confirmation' ? 'staged action' : 'pending item';
  const title = st.title ?? 'A chat';
  const detail = st.detail ? `: “${truncate(st.detail, 60)}”` : '';
  return `• ⏳ **${truncate(title, 80)}** — a ${noun} EXPIRED unresolved${detail}. The card is gone; re-stage or re-ask in the chat if it still matters.`;
}

/**
 * Did a tracked item leave the pending set WITHOUT a resolution?
 *   confirm:{id} → the durable PendingConfirmation row: status 'expired'. A
 *   row still 'pending' — even past expiresAt — is a LIVE (stale) card since
 *   ticket 7705fec2 (owner decisions persist until answered), so it never
 *   leaves the gather and must NOT be flipped here; only the execute paths
 *   flip a stale row, when someone actually tries to run it.
 *   ask:{chatId}:{id} → the durable pending record (coding/pending-durable):
 *   status 'expired'. Missing/answered/denied records — and any lookup error —
 *   count as resolved (fail-quiet: never fabricate an expiry claim).
 */
async function vanishedUnresolved(id: string, _now: Date): Promise<boolean> {
  try {
    if (id.startsWith('confirm:')) {
      const pcId = id.slice('confirm:'.length);
      const row = await prisma.pendingConfirmation.findUnique({
        where: { id: pcId },
        select: { status: true, expiresAt: true },
      });
      return row?.status === 'expired';
    }
    if (id.startsWith('ask:')) {
      // ask:{chatId}:{entryId} — chatId is a UUID (no colons); the entry id may
      // belong to either registry, so try both kinds (ids never collide).
      const entryId = id.split(':').slice(2).join(':');
      if (!entryId) return false;
      const rec =
        (await loadDurablePending('question', entryId)) ??
        (await loadDurablePending('approval', entryId));
      return rec?.status === 'expired';
    }
  } catch { /* fail-quiet */ }
  return false;
}

/**
 * Supervisor stop-credit (ticket 7503189b): the watchdog's "cadence stopped —
 * intentional?" card fired ~10 min AFTER the Fleet Supervisor had already
 * reported that same intentional cancellation in the same thread ("851410b7
 * (scaffold, cancelled 12/48)"), so the owner got an ask the system had
 * already answered. Credit that report: an ASSISTANT message in the
 * supervisor thread, posted at/after the schedule's last firing (the stop
 * always follows it), citing the schedule id by its ≥8-char prefix (the
 * fleet's citation idiom) together with a cancel-class keyword. Assistant
 * role only: machine wake PROMPTS also carry the schedule_disabled payload,
 * but the owner reads the notes, not the prompts. Fail-quiet: any lookup
 * error lets the card fire (the pre-fix behaviour) — a duplicate card beats
 * a silenced one. The watchdog's own cards never cite the schedule id, so a
 * posted card can never self-suppress a later recurrence.
 */
export async function supervisorReportedScheduleStop(opts: {
  supervisorChatId: string;
  scheduleId: string;
  stoppedAfterMs: number;
}): Promise<boolean> {
  const prefix = opts.scheduleId.slice(0, 8);
  if (prefix.length < 8) return false; // cannot safely prefix-match a short id
  try {
    const rows = await prisma.crossModelMessage.findMany({
      where: {
        chatId: opts.supervisorChatId,
        role: 'assistant',
        createdAt: { gte: new Date(opts.stoppedAfterMs - SUPERVISOR_STOP_CREDIT_SKEW_MS) },
        content: { contains: prefix },
      },
      select: { content: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return (rows as any[]).some((r) => STOP_REPORT_KEYWORD.test(String(r?.content ?? '')));
  } catch (err: any) {
    logger.warn(`attention-watchdog: supervisor stop-credit check failed (card fires as before): ${err?.message}`);
    return false;
  }
}

/**
 * Owner Telegram push for OUTAGE-class detections (v1#15): reuses the exact
 * channel notify_user delivers on (telegram.service.sendMessage + the user's
 * TelegramLink). Returns true when the push landed; false (not linked, bot not
 * configured, send failure, import failure) means the supervisor-thread notice
 * is the only delivery — the caller says so in the report. Never throws.
 */
async function pushOutageToOwnerTelegram(userId: string, items: WatchItem[], tz: string, now: Date): Promise<boolean> {
  try {
    const tg: any = await import('../telegram/telegram.service');
    if (!tg?.isConfigured?.()) return false;
    const link = await (prisma as any).telegramLink.findUnique({ where: { userId }, select: { chatId: true } }).catch(() => null);
    if (!link?.chatId) return false;
    const lines = items.slice(0, 5).map((i) => `• ${truncate(i.title, 60)} — ${truncate(i.detail ?? 'schedule overdue', 110)}`);
    const text =
      `🚨 Digby outage watch (${localStamp(now, tz)}): the schedule sweeper looks STALLED — ${items.length} enabled schedule(s) are overdue far beyond their cadence:\n` +
      `${lines.join('\n')}${items.length > 5 ? `\n• …and ${items.length - 5} more` : ''}\n\n— Digby attention watchdog (outage class bypasses quiet hours)`;
    return (await tg.sendMessage(link.chatId, text)) === true;
  } catch (err: any) {
    logger.warn(`attention-watchdog: outage Telegram push failed (supervisor note is the only delivery): ${err?.message ?? err}`);
    return false;
  }
}

// ── Per-user sweep ────────────────────────────────────────────────────────────

async function sweepUser(userId: string, supervisorChatId: string, now: Date): Promise<void> {
  const nowMs = now.getTime();

  // Server-side hook heal (2026-08-24): ensureWildcardHook only ran from the
  // UI ensure path, so event-set heals (e.g. schedule_disabled) never reached
  // existing supervisors until someone opened the Management page. Ride the
  // 15-min sweep instead — idempotent and cheap. Best-effort.
  try {
    const { healSupervisorWildcardHook, healSupervisorStockPrompt } = await import('../platform/supervisor.service');
    await healSupervisorWildcardHook(supervisorChatId, userId);
    // Rollout watch 2026-09-15 (tick 12): the fleet's STOCK system prompt
    // heals on this sweep too — before, a doctrine change reached every
    // project supervisor within 15 min but the fleet only on a UI ensure.
    if (typeof healSupervisorStockPrompt === 'function' && await healSupervisorStockPrompt(supervisorChatId)) {
      logger.info(`attention-watchdog: fleet supervisor stock prompt healed to the current doctrine`, { userId });
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: supervisor hook heal failed (non-fatal): ${err?.message}`);
  }

  // Orphan wildcard-hook GC (ticket a507e650): the heal above only touches the
  // hook targeting the CURRENT supervisor — a STOCK wildcard left pointing at
  // a FORMER supervisor chat never heals, so it is disabled here (never
  // deleted; each disable is audited). The predicate is deliberately tight:
  // wildcard→any-target is a shipped user feature, so custom hooks are never
  // touched (see supervisor.service). Best-effort, same discipline.
  try {
    const { disableOrphanWildcardHooks } = await import('../platform/supervisor.service');
    const disabled = await disableOrphanWildcardHooks(userId);
    if (disabled > 0) {
      logger.info(`attention-watchdog: orphan wildcard-hook GC disabled ${disabled} hook(s)`, { userId });
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: orphan wildcard-hook GC failed (non-fatal): ${err?.message}`);
  }

  // Per-project supervisor lanes (2026-09-13): scaffold lanes for opted-in
  // projects, pause lanes whose project left eligibility, disable stale
  // chat-moved hooks, and GC detached lanes (project deleted) — all
  // idempotent, pause-never-delete. Fire-and-forget like the heals above: a
  // project-supervisor hiccup must never stall the watchdog sweep.
  try {
    const { healProjectSupervisors, gcDetachedProjectSupervisors } = await import('../platform/project-supervisor.service');
    await healProjectSupervisors(userId);
    const detached = await gcDetachedProjectSupervisors(userId);
    if (detached > 0) {
      logger.info(`attention-watchdog: project-supervisor GC detached ${detached} lane(s)`, { userId });
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: project-supervisor heal/GC failed (non-fatal): ${err?.message}`);
  }

  // Supervisor note scan (value telemetry + stuck-loop backstop) — see the
  // section header above. Best-effort, same isolation discipline as the heals.
  try {
    await scanSupervisorNotes(userId, supervisorChatId);
  } catch (err: any) {
    logger.warn(`attention-watchdog: supervisor note scan failed (non-fatal): ${err?.message}`);
  }

  // 1. Prior state (best-effort — a Redis hiccup degrades to "nothing tracked").
  const state = new Map<string, ItemState>();
  try {
    const raw = await (redisClient as any).hGetAll(STATE_KEY(userId));
    for (const [field, value] of Object.entries(raw ?? {})) {
      const parsed = parseState(value);
      if (parsed) state.set(field, parsed);
    }
  } catch (err) {
    logger.warn('attention-watchdog: state read failed; treating as empty', { userId, err: String(err) });
  }

  // 2. Gather current items. Archived chats never raise watchdog attention
  // (archive = de-clutter; direct user-action items live on VISIBLE chats).
  const chats = await prisma.crossModelChat.findMany({
    where: { userId, archivedAt: null },
    // Project-supervisor preflight 2026-09-14: isProjectSupervisor rides the
    // same read so the project-lane note scan below costs no extra query.
    select: { id: true, title: true, projectId: true, updatedAt: true, isProjectSupervisor: true, project: { select: { supervised: true } } },
  });
  const titleByChat = new Map(chats.map((c) => [c.id, c.title]));

  // Project-supervisor preflight 2026-09-14: the SAME note scan over every
  // project supervisor lane (per-chat cursor/fingerprint keys, meta.projectId
  // stamped, streaks observed — never nudged). Best-effort per lane; bounded.
  const projectSupervisorChats = chats
    .filter((c) => (c as any).isProjectSupervisor === true && !!c.projectId)
    .slice(0, MAX_PROJECT_SUPERVISORS_PER_USER);
  for (const lane of projectSupervisorChats) {
    try {
      await scanSupervisorNotes(userId, lane.id, {
        projectId: lane.projectId as string,
        nudge: false,
        cursorKey: PROJECT_NOTE_CURSOR_KEY(userId, lane.id),
        stuckKey: PROJECT_STUCK_KEY(userId, lane.id),
      });
    } catch (err: any) {
      logger.warn(`attention-watchdog: project-supervisor note scan failed for chat ${lane.id} (non-fatal): ${err?.message}`);
    }
  }
  const chatIds = chats.map((c) => c.id);
  // Supervision opt-out: chats under an UNSUPERVISED project are excluded from
  // the automatic watchdog surfaces below (blocked goals/todos, cadence items).
  // DIRECT user-action items (ask_user questions, staged confirmation cards)
  // are NEVER filtered — an opt-out must never hide a decision the user must
  // make. Ungrouped chats (no project row) are always supervised.
  const unsupervisedChatIds = new Set(
    chats.filter((c) => (c as any).project?.supervised === false).map((c) => c.id),
  );

  const items: WatchItem[] = [];

  // (a-i) Redis leg: ask_user questions + ask-only approvals.
  const pending = await readConfirmPendingForChats(chatIds).catch(() => new Map());
  // (a-ii) Durable leg: staged confirmation cards. The two legs' id namespaces
  // are disjoint today (approval/question ids vs cf_* — reviewer-verified), so
  // one underlying wait CAN list twice (a staged card + the model's ask_user
  // about it). That matches the sidebar confirmations poll's established
  // behavior (confirmations.controller merges both legs without dedupe).
  // No expiresAt cutoff (ticket 7705fec2): a pending card persists — stale or
  // not — until the owner answers/dismisses it, so it stays tracked here too.
  const staged = await prisma.pendingConfirmation.findMany({
    where: { userId, status: 'pending' },
    select: { id: true, chatId: true, tool: true, summary: true, createdAt: true },
  });

  for (const [chatId, entry] of pending) {
    items.push({
      id: `ask:${chatId}:${entry.id}`,
      kind: entry.kind === 'question' ? 'question' : 'approval',
      title: titleByChat.get(chatId) ?? 'A chat',
      detail: entry.kind === 'approval' && entry.tool ? `Allow ${entry.tool}?` : entry.question,
      waitingSinceMs: entry.ts > 0 ? entry.ts : nowMs,
    });
  }
  for (const s of staged) {
    items.push({
      id: `confirm:${s.id}`,
      kind: 'confirmation',
      title: titleByChat.get(s.chatId) ?? 'A chat',
      detail: s.summary || `Allow ${s.tool}?`,
      waitingSinceMs: s.createdAt.getTime(),
    });
  }

  // (b) Blocked goals/todos. Goals carry the project relation directly; todos
  // only have the denormalized projectId — one batched name lookup covers both
  // (45a570e0 §2: group the digest by project).
  const [blockedGoals, blockedTodos] = await Promise.all([
    prisma.projectGoal.findMany({
      where: { userId, status: 'blocked' },
      select: { id: true, title: true, blockedReason: true, blockKind: true, gateQuestionId: true, updatedAt: true, createdByChatId: true, projectId: true, project: { select: { name: true, supervised: true } } },
    }),
    prisma.projectTodo.findMany({
      where: { userId, status: 'blocked' },
      select: { id: true, title: true, blockedReason: true, blockKind: true, gateQuestionId: true, updatedAt: true, assigneeChatId: true, projectId: true },
    }),
  ]);
  // Owner-wait line integrity (remediation P2 N10): a blocked reason CLAIMING
  // an owner-wait must be backed by an OPEN owner_questions row (gateQuestionId
  // or an inline oq_ id) — unbacked claims are dropped from the notice and
  // counted (owner_wait_line_dropped). Fail-OPEN on probe errors.
  // STALE-GATE hardening (2026-09-12 spark-stall incident): a gate id that
  // resolves to an ANSWERED or DISMISSED row is no longer merely dropped with
  // the unbacked class — it is surfaced as its own stale_gate notice item
  // (work parked on a card the owner already resolved). The incident: the
  // dflash2 throughput comparison sat reported as "waiting on two inbox
  // cards" while BOTH cards were answered (one a full day earlier) and the
  // owner's inbox showed nothing spark-related; silent dropping kept the
  // parked work invisible on every surface.
  const verifyOwnerWait = await (async () => {
    try {
      const { OWNER_WAIT_CLAIM_RE, INLINE_OQ_ID_RE, isCounterQuestionRow } = await import('../platform/owner-questions');
      const probeIds = new Set<string>();
      for (const r of [...blockedGoals, ...blockedTodos] as any[]) {
        if (r.gateQuestionId) probeIds.add(String(r.gateQuestionId));
        const m = INLINE_OQ_ID_RE.exec(String(r.blockedReason ?? ''));
        if (m) probeIds.add(m[0]);
      }
      // Probe the gate rows at ANY status — the open/closed split happens in
      // code so answered/dismissed gates are distinguishable from missing ones.
      const gateRows = probeIds.size
        ? await prisma.ownerQuestion.findMany({
            where: { id: { in: [...probeIds] } },
            select: { id: true, status: true, answer: true, chosenOption: true, answeredBy: true },
          })
        : [];
      const openIds = new Set<string>();
      const staleById = new Map<string, { status: string; answer: string | null; counterQuestion: boolean }>();
      for (const row of (gateRows ?? []) as any[]) {
        // Prod rows always carry status; default 'open' keeps partial mocks and
        // legacy probe shapes on the old (keep) path.
        const st = String(row.status ?? 'open');
        if (st === 'open') openIds.add(row.id);
        else if (st === 'answered' || st === 'dismissed') {
          staleById.set(row.id, {
            status: st,
            answer: typeof row.answer === 'string' ? row.answer : null,
            // CanLaw 2026-09-15: a free-text owner reply that was itself a
            // question (no typed option, not a supervisor/default answer).
            counterQuestion: st === 'answered' && isCounterQuestionRow(row),
          });
        }
      }
      return (row: any, entity: 'goal' | 'todo'): { keep: boolean; oqId?: string; stale?: { oqId: string; status: string; answer: string | null; counterQuestion: boolean } } => {
        const reason = String(row.blockedReason ?? '');
        const claims = row.blockKind === 'owner' || OWNER_WAIT_CLAIM_RE.test(reason);
        if (!claims) return { keep: true };
        const inline = INLINE_OQ_ID_RE.exec(reason)?.[0];
        const oqId = (row.gateQuestionId && openIds.has(String(row.gateQuestionId)) ? String(row.gateQuestionId) : undefined)
          ?? (inline && openIds.has(inline) ? inline : undefined);
        if (oqId) return { keep: true, oqId };
        // Stale gate: an ANSWERED/DISMISSED gate row — surface, never drop.
        // CanLaw 2026-09-15: an answer that was itself a QUESTION is named as
        // such — the item must never read as "the owner ruled".
        for (const cand of [String(row.gateQuestionId ?? ''), inline ?? '']) {
          if (cand && staleById.has(cand)) {
            const hit = staleById.get(cand)!;
            recordLoopMetric({ kind: 'stale_gate', meta: { surface: 'attention_watchdog', entity, id: String(row.id ?? '').slice(0, 8), oqId: cand.slice(0, 11), oqStatus: hit.status } });
            return { keep: false, stale: { oqId: cand, status: hit.status, answer: hit.answer, counterQuestion: hit.counterQuestion } };
          }
        }
        recordLoopMetric({ kind: 'owner_wait_line_dropped', meta: { surface: 'attention_watchdog', id: String(row.id ?? '').slice(0, 8) } });
        // CanLaw 2026-09-15: the claim is TOLD to the lane that made it (and the
        // project's supervisor) — once per row per 24h — instead of only being
        // hidden from the owner. Fire-and-forget; the helper never throws.
        void import('../platform/goals.service')
          .then((m) => m.noteUnbackedOwnerWaitClaim({
            userId, entity, id: String(row.id ?? ''), title: String(row.title ?? ''), blockedReason: row.blockedReason ?? null,
            laneChatId: entity === 'todo' ? (row.assigneeChatId ?? null) : (row.createdByChatId ?? null),
            projectId: row.projectId ?? row.project?.id ?? null, surface: 'attention_watchdog',
          }))
          .catch(() => {});
        return { keep: false };
      };
    } catch (err: any) {
      logger.warn(`attention-watchdog: owner-wait verification failed open (non-fatal): ${err?.message}`);
      return (_row: any): { keep: boolean; oqId?: string; stale?: { oqId: string; status: string; answer: string | null; counterQuestion: boolean } } => ({ keep: true });
    }
  })();
  const todoProjectIds = [...new Set(blockedTodos.map((t: any) => t.projectId).filter(Boolean))];
  const todoProjects = todoProjectIds.length
    ? await prisma.crossModelProject.findMany({ where: { id: { in: todoProjectIds } }, select: { id: true, name: true, supervised: true } })
        .catch((err: any) => { logger.warn(`attention-watchdog: project-name lookup failed (groups degrade to 'No project'): ${err?.message}`); return []; })
    : [];
  const projectNameById = new Map((todoProjects as any[]).map((p) => [p.id, p.name]));
  const unsupervisedProjectIds = new Set((todoProjects as any[]).filter((p) => p.supervised === false).map((p) => p.id));
  for (const g of blockedGoals) {
    if ((g as any).project?.supervised === false) continue; // unsupervised project — opted out of watchdog alerts
    const vw = verifyOwnerWait(g, 'goal');
    if (vw.stale) {
      items.push({
        id: `stalegate:goal:${g.id}:${vw.stale.oqId}`,
        kind: 'stale_gate', title: g.title,
        detail: vw.stale.counterQuestion
          ? `on gate ${vw.stale.oqId.slice(0, 11)} the owner REPLIED WITH A QUESTION ("${truncate(vw.stale.answer ?? '', 80)}") — no decision was made; this goal is parked on a card that is not a ruling — answer the owner and unblock it`
          : `gate ${vw.stale.oqId.slice(0, 11)} was ${vw.stale.status === 'answered' ? `ANSWERED ("${truncate(vw.stale.answer ?? '', 80)}")` : 'DISMISSED'} — this goal is parked on a card the owner already resolved; unblock it`,
        waitingSinceMs: g.updatedAt.getTime(), group: (g as any).project?.name ?? null,
      });
      continue;
    }
    if (!vw.keep) continue; // N10: owner-wait claim with no open oq id — dropped + counted
    const detail = vw.oqId ? `${g.blockedReason ?? 'Awaiting owner decision'} [${vw.oqId.slice(0, 11)} open]` : g.blockedReason;
    items.push({ id: `goal:${g.id}`, kind: 'blocked_goal', title: g.title, detail, waitingSinceMs: g.updatedAt.getTime(), group: (g as any).project?.name ?? null });
  }
  for (const t of blockedTodos) {
    if ((t as any).projectId && unsupervisedProjectIds.has((t as any).projectId)) continue; // unsupervised project — opted out
    const vw = verifyOwnerWait(t, 'todo');
    if (vw.stale) {
      items.push({
        id: `stalegate:todo:${t.id}:${vw.stale.oqId}`,
        kind: 'stale_gate', title: t.title,
        detail: vw.stale.counterQuestion
          ? `on gate ${vw.stale.oqId.slice(0, 11)} the owner REPLIED WITH A QUESTION ("${truncate(vw.stale.answer ?? '', 80)}") — no decision was made; this todo is parked on a card that is not a ruling — answer the owner and unblock it`
          : `gate ${vw.stale.oqId.slice(0, 11)} was ${vw.stale.status === 'answered' ? `ANSWERED ("${truncate(vw.stale.answer ?? '', 80)}")` : 'DISMISSED'} — this todo is parked on a card the owner already resolved; unblock it`,
        waitingSinceMs: t.updatedAt.getTime(),
        group: projectNameById.get((t as any).projectId) ?? null,
        assignee: (t as any).assigneeChatId ? titleByChat.get((t as any).assigneeChatId) ?? null : null,
      });
      continue;
    }
    if (!vw.keep) continue; // N10: owner-wait claim with no open oq id — dropped + counted
    const detail = vw.oqId ? `${t.blockedReason ?? 'Awaiting owner decision'} [${vw.oqId.slice(0, 11)} open]` : t.blockedReason;
    items.push({
      id: `todo:${t.id}`, kind: 'blocked_todo', title: t.title, detail, waitingSinceMs: t.updatedAt.getTime(),
      group: projectNameById.get((t as any).projectId) ?? null,
      assignee: (t as any).assigneeChatId ? titleByChat.get((t as any).assigneeChatId) ?? null : null,
    });
  }

  // (c) CADENCE STOPPED (owner report 2026-08-24: the Tenstorrent R&D hourly
  // watch self-cancelled after a "plan complete" self-audit and the project sat
  // dormant all night with no nudge): a chat whose recurring schedules ALL
  // became disabled recently — after a real firing history — is a silently
  // stopped cadence the owner should get to confirm. Pure DB detection: a
  // recurring row with runsCount >= 3, enabled=false, lastFiredAt inside the
  // lookback window, on a chat with ZERO enabled rows left.
  try {
    const CADENCE_LOOKBACK_MS = 26 * 60 * 60 * 1000; // catch an overnight stop on the morning sweep
    const stopped = await prisma.chatSchedule.findMany({
      where: {
        userId, kind: 'recurring', enabled: false,
        runsCount: { gte: 3 },
        lastFiredAt: { gte: new Date(nowMs - CADENCE_LOOKBACK_MS) },
      },
      select: { id: true, sessionId: true, runsCount: true, lastFiredAt: true, lastStatus: true, maxRuns: true, cancelledBy: true },
    });
    if (stopped.length) {
      const bySession = new Map<string, (typeof stopped)[number]>();
      for (const s of stopped) {
        const prev = bySession.get(s.sessionId);
        // Ticket b101ad89: prefer a NON-parked row per chat — a genuine stop
        // (cancelled/paused/expired) on a chat that also carries a goal-gate
        // park must still surface; only a park-ONLY chat suppresses.
        if (!prev || (prev.lastStatus === 'parked:dormant' && s.lastStatus !== 'parked:dormant')) {
          bySession.set(s.sessionId, s);
        }
      }
      const stillActive = await prisma.chatSchedule.findMany({
        where: { sessionId: { in: [...bySession.keys()] }, enabled: true },
        select: { sessionId: true },
      });
      const activeSet = new Set(stillActive.map((r) => r.sessionId));

      // ── Healthy-lane suppression (ticket 2dc398fe, 2026-10-16) ──
      // The Schooltime Hue-backlog lane (chat 0037460b) had its recurring rows
      // (runs 4/4, machine-cancelled at their own maxRuns bound — a designed
      // lifecycle end, then deliberately replaced by one-shot probes) flagged
      // "stopped cadence — confirm it was intentional or re-arm" at 03:11Z AND
      // 04:11Z, while the chat was literally RUNNING at both firings. The card
      // re-asks a decision a healthy self-managing lane already made; the
      // 26h-lookback window re-asks it for a FULL DAY. A card is for a
      // genuinely-deaf lane; three healthy shapes must not card:
      //   (a) LANE RUNNING — a queued/running agent run is the lane working
      //       right now (same ruling as the deaf-assignee fix, audit 2026-10-06
      //       T3-9, StAnne f150100b flagged DEAF six times while executing).
      //   (b) DESIGNED EXHAUSTION — EVERY stopped recurring row on the chat is
      //       at runsCount === maxRuns (the run-cap disable path stamps
      //       lastStatus 'expired' and leaves cancelledBy NULL) or carries a
      //       deliberate machine-initiated disable (cancelledBy 'machine' —
      //       cancel_schedule from a run, the duplicate-sweep fold, the
      //       same-cadence supersede, or the required-probes gate pause; every
      //       stamping site also emits its own schedule_disabled hook, so the
      //       supervisor already sees each one). maxRuns is ALWAYS
      //       set on recurring rows (createSchedule), so a NULL maxRuns row is
      //       NOT provably-at-cap and keeps the card (fail-open, the b101ad89
      //       three-valued-logic trap). Lifetime expiry is a DIFFERENT stop:
      //       only an abandoned never-renewing lane reaches it (renewal is
      //       refused or the row is user-created) — it stays cardable.
      //   (c) REPLACED CADENCE — a newer ENABLED row on the same chat is the
      //       activeSet check above (any enabled row means the lane hears).
      // Suppression (b) is per-CHAT, not per-row: the per-chat pick keeps ONE
      // row, so judging the picked row alone would card a lane whose OTHER
      // stopped rows are all at-cap — every row on the chat must consent.
      // Kill switch WATCHDOG_CADENCE_STOP_FIX_DISABLED=1 restores the pre-fix
      // flagging. Fail-OPEN: a probe error keeps the card (the 7503189b
      // discipline — a duplicate card beats a silenced real stop).
      const cadenceStopFix = process.env.WATCHDOG_CADENCE_STOP_FIX_DISABLED !== '1';
      // (a) bulk liveness probe — one query for every candidate chat.
      const busyChatIds = new Set<string>();
      if (cadenceStopFix) {
        try {
          const busy: any[] = await (prisma.agentRun as any).findMany({
            where: { sessionId: { in: [...bySession.keys()] }, status: { in: ['queued', 'running'] } },
            select: { sessionId: true },
          });
          for (const r of busy ?? []) if (r?.sessionId) busyChatIds.add(String(r.sessionId));
        } catch (err: any) {
          logger.warn(`attention-watchdog: cadence-stop liveness probe failed (cards fire as before): ${err?.message}`);
        }
      }
      // (b) designed exhaustion, judged across EVERY stopped recurring row on
      // each candidate chat (a fresh full read per chat — the `stopped` query
      // above is a per-USER sample, not the chat's whole history).
      const exhaustedChatIds = new Set<string>();
      if (cadenceStopFix) {
        try {
          const allStopped = await prisma.chatSchedule.findMany({
            where: { sessionId: { in: [...bySession.keys()] }, kind: 'recurring', enabled: false, runsCount: { gte: 1 } },
            select: { sessionId: true, runsCount: true, maxRuns: true, cancelledBy: true, lastStatus: true },
          });
          const rowsBySession = new Map<string, any[]>();
          for (const r of allStopped ?? []) {
            if (!rowsBySession.has(r.sessionId)) rowsBySession.set(r.sessionId, []);
            rowsBySession.get(r.sessionId)!.push(r);
          }
          for (const [sessionId, rows] of rowsBySession) {
            // A row is at-cap when it burned exactly its own bound, or when the
            // disable was a machine cancel (an agent's deliberate cancel via
            // cancel_schedule — audited in its own run + the schedule_disabled
            // hook the supervisor already consumes). NULL maxRuns = unbounded
            // (legacy) — not provably at-cap, keeps the card.
            const everyRowDesigned = rows.length > 0 && rows.every((r: any) =>
              (r.cancelledBy === 'machine')
              || (typeof r.maxRuns === 'number' && r.runsCount === r.maxRuns));
            if (everyRowDesigned) exhaustedChatIds.add(sessionId);
          }
        } catch (err: any) {
          logger.warn(`attention-watchdog: cadence-stop exhaustion probe failed (cards fire as before): ${err?.message}`);
        }
      }
      let stopCreditChecks = 0;
      for (const [sessionId, row] of bySession) {
        if (activeSet.has(sessionId)) continue; // another cadence still runs this chat
        if (unsupervisedChatIds.has(sessionId)) continue; // unsupervised project — opted out
        // Healthy-lane suppression (ticket 2dc398fe): (a) the lane is working
        // RIGHT NOW — a queued/running agent run is not a stopped cadence; and
        // (b) every stopped recurring row on the chat ended at its own
        // designed bound (run cap exactly reached, or a machine cancel). Both
        // fail-OPEN: the sets stay empty on a probe error, so the card fires
        // exactly as before the fix.
        if (cadenceStopFix && busyChatIds.has(sessionId)) {
          logger.info('attention-watchdog: cadence-stopped card suppressed — lane has an active/queued run (2dc398fe)', { userId, scheduleId: row.id });
          continue;
        }
        if (cadenceStopFix && exhaustedChatIds.has(sessionId)) {
          logger.info('attention-watchdog: cadence-stopped card suppressed — every stopped row ended at its designed bound (2dc398fe)', { userId, scheduleId: row.id });
          continue;
        }
        // Platform-initiated park (ticket b101ad89): a goal-gate auto-park
        // (ticket b1d435fd — lastStatus 'parked:dormant') IS the owner's
        // standing zero-wake directive executing. The "intentional?" card
        // re-asks a decision the owner already made, and its re-arm action
        // would violate dormancy while the project stays dormant (the
        // fire-time gate would re-park on the very next tick). Suppress the
        // card entirely; the per-row ⏸️ auto-park notice (notifyDormancyParkOnce)
        // is the visibility record. Null-safe in JS on purpose — a Prisma
        // `{ not: … }` filter would drop legacy NULL-lastStatus rows
        // (three-valued SQL logic) and silently mute REAL stopped cadences;
        // here a NULL row keeps the card exactly as before this fix.
        if (row.lastStatus === 'parked:dormant') continue;

        // Supervisor stop-credit (ticket 7503189b): the supervisor's
        // schedule_disabled wake usually beats this card — its note reports
        // the same stop to the owner, with receipts, minutes earlier. Credit
        // that report and skip the duplicate ask (capped per sweep).
        if (stopCreditChecks < MAX_STOP_CREDIT_CHECKS_PER_SWEEP) {
          stopCreditChecks++;
          if (await supervisorReportedScheduleStop({
            supervisorChatId,
            scheduleId: row.id,
            stoppedAfterMs: row.lastFiredAt ? row.lastFiredAt.getTime() : nowMs,
          })) {
            logger.info('attention-watchdog: cadence-stopped card suppressed — supervisor already reported the stop', { userId, scheduleId: row.id });
            continue;
          }
        }
        items.push({
          id: `cadence:${row.id}`,
          kind: 'cadence_stopped',
          title: titleByChat.get(sessionId) ?? 'A coding chat',
          detail: `recurring schedule stopped after ${row.runsCount} runs — intentional?`,
          waitingSinceMs: row.lastFiredAt ? row.lastFiredAt.getTime() : nowMs,
        });
      }
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: cadence-stopped scan failed (non-fatal): ${err?.message}`);
  }

  // (d) OVERDUE CADENCE (overnight forensics 2026-08-24, fix 1): an ENABLED
  // recurring schedule whose nextRunAt sits in the past far beyond its own
  // cadence means the sweeper never claimed it — the sweeper-missed/stuck class
  // the (c) scan is blind to (that one only sees rows already DISABLED). A
  // healthy sweeper advances nextRunAt within ~60s of it coming due, so grace =
  // max(2×intervalSec, 30 min): one late tick is jitter, two full intervals is
  // a stall. The SQL filter uses the 30-min floor; the per-row interval grace
  // is applied in JS (intervalSec varies per row).
  try {
    const MIN_OVERDUE_GRACE_MS = 30 * 60 * 1000;
    const overdueCandidates = await prisma.chatSchedule.findMany({
      where: {
        userId, kind: 'recurring', enabled: true,
        nextRunAt: { lte: new Date(nowMs - MIN_OVERDUE_GRACE_MS) },
      },
      select: { id: true, sessionId: true, intervalSec: true, nextRunAt: true, runsCount: true },
    });
    for (const row of overdueCandidates) {
      if (unsupervisedChatIds.has(row.sessionId)) continue; // unsupervised project — opted out
      const overdueMs = nowMs - row.nextRunAt.getTime();
      const graceMs = Math.max(2 * (row.intervalSec ?? 0) * 1000, MIN_OVERDUE_GRACE_MS);
      if (overdueMs < graceMs) continue; // within grace — normal sweeper jitter
      items.push({
        id: `overdue:${row.id}`,
        kind: 'overdue_cadence',
        title: titleByChat.get(row.sessionId) ?? 'A coding chat',
        detail: `next run was due ${formatAge(overdueMs)} ago (every ${Math.max(1, Math.round((row.intervalSec ?? 0) / 60))}m, ${row.runsCount} runs so far)`,
        waitingSinceMs: row.nextRunAt.getTime(),
      });
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: overdue-cadence scan failed (non-fatal): ${err?.message}`);
  }

  // (e) CADENCE VANISHED (ticket bd954d27): a recurring schedule that was
  // present — ENABLED, with firing history — at the previous sweep and is now
  // ABSENT from the DB entirely (no row, no schedule_disabled event) was
  // hard-deleted by SOMETHING (a cascade, the supervisor dedupe, raw SQL).
  // The (c) cadence-stopped scan only sees DISABLED rows; this snapshot-diff
  // sees the silent killer without needing to know what it was. One Redis
  // JSON blob per user, rewritten every sweep; a missing baseline (first
  // sweep after a Redis flush/deploy) only writes — it never alerts.
  try {
    const rawSnap = await (redisClient as any).get(SCHED_SNAP_KEY(userId)).catch(() => null);
    let prev: Record<string, { r: number; s: string; e: boolean }> = {};
    try { prev = rawSnap ? JSON.parse(String(rawSnap)) : {}; } catch { prev = {}; }
    const current = await prisma.chatSchedule.findMany({
      where: { userId, kind: 'recurring' },
      select: { id: true, sessionId: true, enabled: true, runsCount: true },
    });
    const curIds = new Set((current ?? []).map((r: any) => r.id));
    const alertedNow = new Set<string>();
    if (rawSnap != null) {
      for (const [id, meta] of Object.entries(prev)) {
        if (curIds.has(id)) continue;
        // Only the ticket's class alerts: ENABLED at last sighting, with real
        // firing history. A row last seen DISABLED (later reaped by the 30d
        // terminal GC) already had its cancel/expiry event — never re-alert.
        if (!meta?.e || !(meta.r >= 1)) continue;
        if (unsupervisedChatIds.has(meta.s)) continue; // unsupervised project — opted out (also skips the carry below)
        logger.warn(`attention-watchdog: recurring schedule ${id} VANISHED for user ${String(userId ?? '').slice(0, 8)} (enabled, ${meta.r} runs at last sweep) — hard-deleted with no audit trail`);
        alertedNow.add(id);
        items.push({
          id: `vanished:${id}`,
          kind: 'cadence_vanished',
          title: titleByChat.get(meta.s) ?? 'A coding chat',
          detail: `recurring schedule vanished after ${meta.r} run${meta.r === 1 ? '' : 's'} — hard-deleted with no cancel/disable event; check what removed it`,
          // Re-detections (quiet-hours carry) keep the FIRST sighting so the
          // notice shows the true age, not the latest sweep.
          waitingSinceMs: state.get(`vanished:${id}`)?.firstSeenMs ?? nowMs,
        });
      }
    }
    const next: Record<string, { r: number; s: string; e: boolean }> = {};
    for (const r of current ?? []) next[r.id] = { r: r.runsCount ?? 0, s: r.sessionId, e: !!r.enabled };
    // Quiet-hours carry (review Finding 1, commit 5d327419): a vanish first
    // detected during quiet hours is HELD (notified=0) — but rewriting the
    // snapshot without the row meant the next sweep could no longer diff it,
    // and section 3 pruned the held notice as "resolved": the overnight-
    // incident class never posted. Carry the missing row forward until its
    // alert is DELIVERED: rows alerted this sweep (their state entry doesn't
    // exist until section 4 — after this scan) plus rows whose stored entry
    // is still unnotified. Once posted (notified=1) the carry stops; the row
    // drops from the next snapshot and the state prunes cleanly.
    if (rawSnap != null) {
      for (const [id, meta] of Object.entries(prev)) {
        if (curIds.has(id) || next[id]) continue;
        if (!meta?.e || !(meta.r >= 1)) continue;
        const pending = state.get(`vanished:${id}`);
        if (pending ? pending.notified === 0 : alertedNow.has(id)) next[id] = meta;
      }
    }
    await (redisClient as any).set(SCHED_SNAP_KEY(userId), JSON.stringify(next), { EX: SCHED_SNAP_TTL_SEC }).catch(() => {});
  } catch (err: any) {
    logger.warn(`attention-watchdog: cadence-vanished scan failed (non-fatal): ${err?.message}`);
  }

  // (f) DEAF ASSIGNEE (2026-08-30 Post-CPT incident): a live goal todo assigned
  // to a chat with NO enabled schedules and no machine activity beyond its
  // deaf floor will never be acted on — the lane's monitor was cancelled
  // during a daily-cap pause, the re-arm commitment lived only in the
  // supervisor's state doc (compacted away), and the P0 todo sat pending
  // while the CPT-completion trigger it watched for came and went. The (c)
  // cadence-stopped scan is blind to this: it needs a RECENTLY-disabled row
  // with firing history and never looks at todo assignments.
  //
  // P3 (v1#15 + pin 14d):
  //   - the deaf FLOOR is per-lane: max(2 × the lane's LAST known schedule
  //     interval, 30 min) — a 30-min-cadence lane is deaf after an hour, not
  //     after the old fixed 24h; a lane with no interval history keeps 24h.
  //   - the activity clock prefers the lane's last MACHINE run (agent_runs
  //     max createdAt) over chat.updatedAt — notices and user chatter bump
  //     updatedAt, masking a lane that cannot self-act.
  try {
    const DEAF_INACTIVE_DEFAULT_MS = 24 * 60 * 60 * 1000;
    const DEAF_FLOOR_MIN_MS = 30 * 60 * 1000;
    const assigned = await prisma.projectTodo.findMany({
      where: { userId, status: { in: ['pending', 'in_progress'] }, assigneeChatId: { not: null } },
      select: { id: true, title: true, status: true, assigneeChatId: true, updatedAt: true, goal: { select: { status: true } } },
    });
    // Todos under a closed goal are history, not work waiting to happen. The
    // status re-filter is deliberate: the DB where-clause already scopes it,
    // but unit-test mocks answer every findMany with the same rows regardless.
    const live = (assigned as any[]).filter((t) =>
      (t.status === 'pending' || t.status === 'in_progress') && t.goal?.status !== 'done' && t.goal?.status !== 'archived');
    if (live.length) {
      const assigneeIds = [...new Set(live.map((t) => t.assigneeChatId as string))];
      const enabledRows = await prisma.chatSchedule.findMany({
        where: { sessionId: { in: assigneeIds }, enabled: true },
        select: { sessionId: true },
      });
      const hearingSet = new Set(enabledRows.map((r) => r.sessionId));
      // Last MACHINE activity per assignee (one grouped read — "if cheap").
      const lastRunBySession = new Map<string, number>();
      try {
        const runMax: any[] = await (prisma.agentRun as any).groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: assigneeIds } },
          _max: { createdAt: true },
        });
        for (const r of runMax ?? []) {
          const ms = r?._max?.createdAt ? new Date(r._max.createdAt).getTime() : NaN;
          if (Number.isFinite(ms)) lastRunBySession.set(r.sessionId, ms);
        }
      } catch { /* fall back to chat.updatedAt below */ }
      // Last known interval per assignee (newest row of ANY enabled state —
      // deaf lanes have no enabled rows by definition).
      const lastIntervalBySession = new Map<string, number>();
      try {
        // audit 2026-10-06 T4-1 (fleet.md F3/F6): a one-shot's intervalSec is
        // not a cadence (a 900 s one-shot set a 30-min deaf floor).
        const recurringOnlyDeaf = !watchdogRecurringCadenceDisabled();
        const intervalRows: any[] = await prisma.chatSchedule.findMany({
          where: { sessionId: { in: assigneeIds }, intervalSec: { not: null }, ...(recurringOnlyDeaf ? { kind: 'recurring' } : {}) },
          select: { sessionId: true, intervalSec: true, ...(recurringOnlyDeaf ? { kind: true } : {}) },
          orderBy: { createdAt: 'desc' },
        });
        for (const r of intervalRows ?? []) {
          if (recurringOnlyDeaf && r.kind != null && r.kind !== 'recurring') continue;
          if (!lastIntervalBySession.has(r.sessionId) && typeof r.intervalSec === 'number') {
            lastIntervalBySession.set(r.sessionId, r.intervalSec);
          }
        }
      } catch { /* no history → default floor below */ }
      // audit 2026-10-06 T3-9 (fleet F6 — StAnne lane f150100b flagged DEAF
      // six times, once per todo, while its runs 7a5e8e7d / 462137dd were
      // executing): (1) an assignee with a QUEUED or RUNNING agent run is
      // working, not deaf — the max(createdAt) activity clock aged from the
      // run's START, so a 4-h run read as 4 h of silence; (2) ONE item per
      // lane (its waiting todos named in the detail), not one per todo.
      // Kill switch WATCHDOG_DEAF_LANE_FIX_DISABLED=1 restores both.
      const deafLaneFix = process.env.WATCHDOG_DEAF_LANE_FIX_DISABLED !== '1';
      const busySessions = new Set<string>();
      if (deafLaneFix) {
        try {
          const active: any[] = await (prisma.agentRun as any).findMany({
            where: { sessionId: { in: assigneeIds }, status: { in: ['queued', 'running'] } },
            select: { sessionId: true },
          });
          for (const r of active ?? []) if (r?.sessionId) busySessions.add(String(r.sessionId));
        } catch { /* fail toward the pre-fix flagging */ }
      }
      const deafByLane = new Map<string, { chat: any; lastActivityMs: number; titles: string[] }>();
      const chatById = new Map(chats.map((c) => [c.id, c]));
      // ARCHIVED-TARGET-RETIRE (e, 2026-10-20): an assignee that is ARCHIVED
      // (archivedAt stamped — absent from `chats` — or its coding satellite
      // parked 'archived') is ORPHANED, not deaf: it will never run, so the
      // item says so (one per lane) instead of being skipped as a "deleted
      // assignee" or nagged as deaf. archiveChat now unassigns at archive
      // time, so these are pre-fix rows and satellite-only archives. Kill
      // switch ARCHIVED_TARGET_RETIRE_DISABLED=1 restores the skip.
      const orphanedLanes = new Map<string, { title: string; sinceMs: number; titles: string[] }>();
      const archivedAssignees = new Map<string, { title: string; sinceMs: number | null }>();
      if (!archivedTargetRetireDisabled()) {
        try {
          const [stamped, parked]: [any[], any[]] = await Promise.all([
            (prisma.crossModelChat as any).findMany({
              where: { userId, id: { in: assigneeIds }, archivedAt: { not: null } },
              select: { id: true, title: true, archivedAt: true, project: { select: { supervised: true } } },
            }),
            (prisma as any).chatCodingState.findMany({
              where: { id: { in: assigneeIds }, status: 'archived' },
              select: { id: true, status: true, updatedAt: true },
            }),
          ]);
          // The predicates are re-checked in JS (the where-clause already
          // scopes them; a mock answering every findMany alike must not orphan
          // a live lane).
          for (const c of stamped ?? []) {
            if (!c?.archivedAt) continue;
            if (c?.project?.supervised === false) continue; // unsupervised project — opted out
            const at = c.archivedAt ? new Date(c.archivedAt).getTime() : NaN;
            archivedAssignees.set(String(c.id), { title: String(c.title ?? 'An archived chat'), sinceMs: Number.isFinite(at) ? at : null });
          }
          for (const p of parked ?? []) {
            const id = String(p?.id ?? '');
            if (!id || p?.status !== 'archived' || archivedAssignees.has(id)) continue;
            const visible = chatById.get(id);
            if (!visible || unsupervisedChatIds.has(id)) continue; // archivedAt-stamped rows are handled above
            const at = p.updatedAt ? new Date(p.updatedAt).getTime() : NaN;
            archivedAssignees.set(id, { title: String(visible.title ?? 'An archived session'), sinceMs: Number.isFinite(at) ? at : null });
          }
        } catch { /* fail toward the pre-fix behaviour (skip / deaf) */ }
      }
      for (const t of live) {
        const chatId = t.assigneeChatId as string;
        const orphan = archivedAssignees.get(chatId);
        if (orphan) {
          const lane = orphanedLanes.get(chatId);
          if (lane) lane.titles.push(t.title);
          else orphanedLanes.set(chatId, { title: orphan.title, sinceMs: orphan.sinceMs ?? (t.updatedAt?.getTime?.() ?? nowMs), titles: [t.title] });
          continue;
        }
        if (hearingSet.has(chatId)) continue; // an enabled cadence can pick the todo up
        if (unsupervisedChatIds.has(chatId)) continue; // unsupervised project — opted out
        if (busySessions.has(chatId)) continue; // T3-9: a run is in progress — the lane is working
        const chat = chatById.get(chatId);
        if (!chat) continue; // deleted assignee — orphaned todo, a different report
        const lastIntervalSec = lastIntervalBySession.get(chatId);
        const deafFloorMs = lastIntervalSec
          ? Math.max(2 * lastIntervalSec * 1000, DEAF_FLOOR_MIN_MS)
          : DEAF_INACTIVE_DEFAULT_MS;
        const machineMs = lastRunBySession.get(chatId);
        const lastActivityMs = machineMs
          ?? ((chat as any).updatedAt ? new Date((chat as any).updatedAt).getTime() : t.updatedAt?.getTime?.());
        if (lastActivityMs === undefined || !Number.isFinite(lastActivityMs) || nowMs - lastActivityMs < deafFloorMs) continue; // recently active (or undatable) — could be mid-work
        if (deafLaneFix) {
          const lane = deafByLane.get(chatId);
          if (lane) lane.titles.push(t.title);
          else deafByLane.set(chatId, { chat, lastActivityMs, titles: [t.title] });
          continue;
        }
        items.push({
          id: `deaf:${t.id}`,
          kind: 'deaf_assignee',
          title: chat.title,
          detail: `todo “${truncate(t.title, 60)}” waits here`,
          waitingSinceMs: lastActivityMs,
        });
      }
      for (const [chatId, lane] of orphanedLanes) {
        const n = lane.titles.length;
        items.push({
          id: `orphan:lane:${chatId}`,
          kind: 'orphaned_assignee',
          title: lane.title,
          detail: n === 1
            ? `todo “${truncate(lane.titles[0], 60)}” is assigned here`
            : `${n} todos are assigned here — “${truncate(lane.titles[0], 50)}” +${n - 1} more`,
          waitingSinceMs: lane.sinceMs,
        });
      }
      for (const [chatId, lane] of deafByLane) {
        const n = lane.titles.length;
        items.push({
          id: `deaf:lane:${chatId}`,
          kind: 'deaf_assignee',
          title: lane.chat.title,
          detail: n === 1
            ? `todo “${truncate(lane.titles[0], 60)}” waits here`
            : `${n} todos wait here — “${truncate(lane.titles[0], 50)}” +${n - 1} more`,
          waitingSinceMs: lane.lastActivityMs,
        });
      }
    }
  } catch (err: any) {
    logger.warn(`attention-watchdog: deaf-assignee scan failed (non-fatal): ${err?.message}`);
  }

  // 3. Classify state entries that left the pending set: a clean resolution is
  //    pruned silently (clearing the way for a recurrence to re-notify); an exit
  //    WITHOUT a resolution is held, marked expiredMs, until its 'expired
  //    unresolved' line posts (ticket f789d84e).
  const currentIds = new Set(items.map((i) => i.id));
  const pruned: string[] = [];
  for (const id of [...state.keys()]) {
    if (currentIds.has(id)) continue;
    const entry = state.get(id)!;
    if (entry.expiredMs) continue; // already marked — held for a (quiet-hours) flush
    if (await vanishedUnresolved(id, now)) {
      entry.expiredMs = nowMs;
    } else {
      pruned.push(id);
      state.delete(id);
    }
  }

  // 4. Qualify: attention kinds immediately; blocked kinds after 30 continuous min.
  //    firstSeen seeds from the item's own timestamp ONLY on first observation —
  //    afterwards the stored value wins (an edit can't reset the clock).
  const newlyQualified: WatchItem[] = [];
  for (const item of items) {
    let entry = state.get(item.id);
    if (!entry) {
      entry = { firstSeenMs: item.waitingSinceMs, notified: 0 };
      state.set(item.id, entry);
    }
    // Snapshot (and backfill for pre-snapshot entries) what the expiry trace
    // needs — the live item is gone by the time it reports.
    entry.kind = item.kind;
    entry.title = item.title;
    entry.detail = item.detail ? item.detail.slice(0, 160) : null;
    delete entry.expiredMs; // defensive — a live item is by definition not expired
    const isBlockedKind = item.kind === 'blocked_goal' || item.kind === 'blocked_todo';
    const qualified = !isBlockedKind || nowMs - entry.firstSeenMs >= BLOCKED_MIN_AGE_MS;
    if (qualified && entry.notified === 0) newlyQualified.push(item);
  }
  const expiredToReport = [...state.entries()].filter(([, e]) => e.expiredMs);

  // 5. Quiet hours: hold newly-qualified items (leave notified=0) until morning.
  const tz = (await loadUserTimezone(userId).catch(() => undefined)) ?? DEFAULT_TZ;
  // OUTAGE CLASS (v1#15 / spark G9 / CanLaw B13): a sweeper-stall detection
  // (overdue_cadence — an ENABLED schedule the sweeper never claimed) is an
  // infrastructure outage, not a "waiting on a human" state: it BYPASSES quiet
  // hours (overnight is exactly when a stalled sweeper burns the most) and
  // additionally pushes to the owner's Telegram (the notify_user channel).
  const outageItems = newlyQualified.filter((i) => i.kind === 'overdue_cadence');
  const quiet = isQuietHour(localHour(now, tz)) && outageItems.length === 0;

  let outageDeliveryNote = '';
  if (outageItems.length > 0) {
    const delivered = await pushOutageToOwnerTelegram(userId, outageItems, tz, now);
    outageDeliveryNote = delivered
      ? `🚨 ${outageItems.length} outage-class item(s) above were ALSO pushed to your Telegram (sweeper-stall class bypasses quiet hours).`
      : `🚨 ${outageItems.length} outage-class item(s) above could NOT be pushed to Telegram (not linked/configured) — this supervisor note is the only delivery; treat it as urgent.`;
  }

  if ((newlyQualified.length > 0 || expiredToReport.length > 0) && !quiet) {
    const shown = newlyQualified.slice(0, MAX_NOTICE_ITEMS);
    const overflow = newlyQualified.length - shown.length;
    const headline = newlyQualified.length > 0
      ? `🔔 **Attention watchdog** — ${newlyQualified.length} item${newlyQualified.length === 1 ? '' : 's'} need${newlyQualified.length === 1 ? 's' : ''} you (${localStamp(now, tz)})`
      : `🔔 **Attention watchdog** — ${expiredToReport.length} pending item${expiredToReport.length === 1 ? '' : 's'} expired unresolved (${localStamp(now, tz)})`;
    const lines = [headline];
    if (newlyQualified.length > 0) {
      // Counts-first summary line (45a570e0 §1): the whole fleet state at a glance.
      const counts: Partial<Record<WatchItemKind, number>> = {};
      for (const item of newlyQualified) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      const label = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
      const parts: string[] = [];
      if (counts.question) parts.push(label(counts.question, 'question'));
      if (counts.approval) parts.push(label(counts.approval, 'approval'));
      if (counts.confirmation) parts.push(label(counts.confirmation, 'staged action'));
      if (counts.blocked_todo) parts.push(label(counts.blocked_todo, 'blocked todo'));
      if (counts.blocked_goal) parts.push(label(counts.blocked_goal, 'blocked goal'));
      if (counts.stale_gate) parts.push(label(counts.stale_gate, 'stale gate (owner already answered)', 'stale gates (owner already answered)'));
      if (counts.cadence_stopped) parts.push(label(counts.cadence_stopped, 'stopped cadence', 'stopped cadences'));
      if (counts.overdue_cadence) parts.push(label(counts.overdue_cadence, 'overdue schedule'));
      if (counts.cadence_vanished) parts.push(label(counts.cadence_vanished, 'vanished schedule'));
      if (counts.deaf_assignee) parts.push(label(counts.deaf_assignee, 'deaf lane', 'deaf lanes'));
      if (counts.orphaned_assignee) parts.push(label(counts.orphaned_assignee, 'orphaned lane', 'orphaned lanes'));
      if (expiredToReport.length > 0) parts.push(label(expiredToReport.length, 'expired card'));
      const projects = new Set(
        newlyQualified.filter((i) => i.kind === 'blocked_goal' || i.kind === 'blocked_todo' || i.kind === 'stale_gate').map((i) => i.group).filter(Boolean),
      );
      lines.push(`${parts.join(' · ')}${projects.size > 0 ? ` — ${label(projects.size, 'project')} affected` : ''}`);

      // Grouped sections (45a570e0 §2): attention items under their chat
      // heading, blocked work under its project heading — nothing repeated.
      const attentionItems = shown.filter((i) => i.kind !== 'blocked_goal' && i.kind !== 'blocked_todo' && i.kind !== 'stale_gate');
      const blockedItems = shown.filter((i) => i.kind === 'blocked_goal' || i.kind === 'blocked_todo' || i.kind === 'stale_gate');
      const section = (title: string, rows: WatchItem[]) => {
        if (rows.length === 0) return;
        lines.push('', `**${title}** (${rows.length})`);
        for (const [group, groupItems] of groupRows(rows)) {
          lines.push(`_${truncate(group, 80)}_`);
          for (const item of groupItems) lines.push(lineFor(item, nowMs - item.waitingSinceMs));
        }
      };
      section('Chats waiting on you', attentionItems);
      section('Blocked work', [...blockedItems].sort((a, b) => groupOf(a).localeCompare(groupOf(b))));
      if (overflow > 0) lines.push(`• …and ${overflow} more — see the Management dashboard.`);
    }
    // Expired-unresolved traces (ticket f789d84e): the card vanished with no
    // decision — say so ONCE so supervisor/status notes stop citing it.
    if (expiredToReport.length > 0) {
      const expShown = expiredToReport.slice(0, MAX_NOTICE_ITEMS);
      lines.push('', `⏳ **Expired unresolved** — ${expiredToReport.length} card${expiredToReport.length === 1 ? '' : 's'} lapsed with no decision:`);
      lines.push(...expShown.map(([, st]) => expiredBulletFor(st)));
      if (expiredToReport.length > expShown.length) {
        lines.push(`• …and ${expiredToReport.length - expShown.length} more.`);
      }
    }
    if (outageDeliveryNote) lines.push('', outageDeliveryNote);
    lines.push('', '_Titles truncated — full text + drill-down in the Management dashboard. Deduped per item; held during quiet hours (11 PM–7 AM local; outage-class items bypass the hold). Resolved items drop off automatically._');
    await prisma.crossModelMessage.create({
      data: {
        chatId: supervisorChatId,
        role: 'assistant',
        content: lines.join('\n'),
        metadata: { origin: 'attention-watchdog' },
      },
    });
    for (const item of newlyQualified) {
      const entry = state.get(item.id);
      if (entry) entry.notified = 1;
    }
    // Expiry reported → the item's story is over; prune so a same-id ghost can
    // never re-report (same dedupe discipline as the pending notices).
    for (const [id] of expiredToReport) {
      state.delete(id);
      pruned.push(id);
    }
    logger.info('attention-watchdog: notice posted', { userId, items: newlyQualified.length, expired: expiredToReport.length, held: false });
  } else if (newlyQualified.length > 0 || expiredToReport.length > 0) {
    logger.info('attention-watchdog: quiet-hours hold', { userId, items: newlyQualified.length, expired: expiredToReport.length });
  }

  // 6. Persist state (best-effort: a failed write risks a duplicate notice next
  //    sweep, never a lost sweep).
  try {
    const key = STATE_KEY(userId);
    for (const [field, entry] of state) {
      await (redisClient as any).hSet(key, field, JSON.stringify(entry));
    }
    if (pruned.length > 0) await (redisClient as any).hDel(key, pruned);
    await (redisClient as any).expire(key, STATE_TTL_SEC);
  } catch (err) {
    logger.warn('attention-watchdog: state write failed (a duplicate notice is possible next sweep)', { userId, err: String(err) });
  }
}

// ── Zombie machine-run stop (live incident 2026-09-10) ───────────────────────
// The Fleet Supervisor chat sat silent ~10 hours behind a machine chat-run
// stuck inside one step: its cm:liverun lock was heartbeat-refreshed forever,
// every schedule firing busy-skipped, and NOTHING alarmed — the lane's only
// alarm (the supervisor itself) was the thing locked out. This sweep is the
// who-watches-the-watcher arm: a BOUNDED check over (a) supervisor chats and
// (b) lanes whose enabled schedules report heavy busy-skipping (the zombie's
// signature — due firings bouncing off a lock that never clears). A lane is a
// ZOMBIE only when BOTH hold: its live-run lock carries the MACHINE marker (a
// user-triggered run is NEVER stopped from here — fail-safe read), and its
// newest machine note/journal activity is older than ZOMBIE_SILENCE_MULTIPLIER
// × its shortest enabled schedule interval (no cadence → the 3h fallback).
// The remedy is the exact lever the manual incident fix used: the cross-process
// stop flag (requestChatRunStop) the run's own heartbeat polls — graceful
// cancel, honest finalize, lock released, the next firing gets the lane back.
// An NX Redis key dedupes the stop per chat per ZOMBIE_STOP_DEDUPE_SEC so the
// watchdog never machine-guns a legitimately long run; the key is released
// when the stop flag itself fails to land, so the next sweep retries.
// Telemetry: GUARD_STRIKE seam 'zombie_run_stop' — chartable beside every
// other seam (and same-seam-alarmable).

/** Enabled-schedule busy-skips that make a non-supervisor lane a candidate. */
export const ZOMBIE_BUSY_SKIPS_MIN = 10;
/** Silence threshold = this × the lane's shortest enabled cadence. */
export const ZOMBIE_SILENCE_MULTIPLIER = 3;
/** Silence threshold for a lane with no enabled cadence (supervisors qualify
 *  without one). */
export const ZOMBIE_SILENCE_FALLBACK_MS = 3 * 60 * 60 * 1000;
/** One stop per chat per this window (Redis SET NX). */
export const ZOMBIE_STOP_DEDUPE_SEC = 2 * 60 * 60;
const ZOMBIE_STOP_KEY = (chatId: string) => `attn-watchdog:zombiestop:${chatId}`;
/** Bound on busy-skip lanes examined per sweep (pathology guard). */
const MAX_ZOMBIE_LANES = 100;
/**
 * audit 2026-10-06 T4-1 (fleet.md F3): a lane's cadence is its RECURRING rows
 * only — in BOTH the zombie silence floor and the deaf-assignee floor. Kill
 * switch WATCHDOG_RECURRING_CADENCE_DISABLED=1 restores the any-kind read.
 * Read per call.
 */
export function watchdogRecurringCadenceDisabled(): boolean {
  return process.env.WATCHDOG_RECURRING_CADENCE_DISABLED === '1';
}

async function sweepZombieMachineRuns(supervisorChatIds: string[], now: Date): Promise<void> {
  const nowMs = now.getTime();

  // Candidates: every supervisor lane, plus busy-skip-heavy lanes. Bounded on
  // both sides (supervisors by MAX_USERS_PER_SWEEP upstream, lanes here).
  const candidates = new Set<string>(supervisorChatIds);
  try {
    const skipLanes: Array<{ sessionId: string }> = await (prisma as any).chatSchedule.findMany({
      where: { enabled: true, busySkips: { gte: ZOMBIE_BUSY_SKIPS_MIN } },
      select: { sessionId: true },
      take: MAX_ZOMBIE_LANES,
    });
    for (const r of skipLanes ?? []) candidates.add(r.sessionId);
  } catch { /* best-effort — supervisor lanes still get checked */ }
  if (candidates.size === 0) return;

  // Only MACHINE-locked lanes proceed: no lock, a user-triggered claim, or a
  // degraded Redis read all drop a lane here (fail-safe by construction).
  const locked = await getMachineLockedChatIds([...candidates]);
  if (locked.size === 0) return;

  // Shortest enabled cadence per locked lane — the lane's own expected pulse.
  // audit 2026-10-06 T4-1 (fleet.md F3): only RECURRING rows define a cadence.
  // A one-shot carries intervalSec too (the owner-answer retry arms
  // kind:'once', intervalSec:180 — schedule.service armOwnerAnswerRetry) and
  // shrank the Fleet's floor to 3×180 s = 9 min, so a live 18-min run was
  // stopped mid-answer. WATCHDOG_RECURRING_CADENCE_DISABLED=1 restores the
  // any-kind read.
  const recurringOnly = !watchdogRecurringCadenceDisabled();
  const shortestIntervalSec = new Map<string, number>();
  try {
    const rows = await prisma.chatSchedule.findMany({
      where: { sessionId: { in: [...locked] }, enabled: true, intervalSec: { not: null }, ...(recurringOnly ? { kind: 'recurring' } : {}) },
      select: { sessionId: true, intervalSec: true, ...(recurringOnly ? { kind: true } : {}) },
    });
    for (const r of rows ?? []) {
      if (recurringOnly && (r as any).kind != null && (r as any).kind !== 'recurring') continue;
      const cur = shortestIntervalSec.get(r.sessionId);
      if (typeof r.intervalSec === 'number' && (cur === undefined || r.intervalSec < cur)) {
        shortestIntervalSec.set(r.sessionId, r.intervalSec);
      }
    }
  } catch { /* no cadence history → the 3h fallback governs */ }

  for (const chatId of locked) {
    try {
      // Silence clock: newest machine-wake note OR run-journal entry, whichever
      // is fresher. NO activity record at all → skip — the watchdog never
      // fabricates a silence claim from absent evidence (fail-quiet, like the
      // expired-unresolved leg).
      let lastActivityMs: number | undefined;
      const rows = await prisma.crossModelMessage.findMany({
        where: { chatId, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        take: NOTE_SCAN_FETCH,
        select: { createdAt: true, metadata: true },
      });
      for (const r of rows ?? []) {
        if (SUPERVISOR_NOTE_ORIGINS.has(String((r as any)?.metadata?.origin ?? ''))) {
          lastActivityMs = r.createdAt.getTime();
          break; // desc order — the first machine row is the newest
        }
      }
      // RunJournalEntry is keyed by chatId (schema.prisma) — the old
      // `where: { sessionId }` was an unknown arg Prisma rejected, and the
      // swallowed catch made this freshness leg ALWAYS null (fixed 2026-09-11
      // with the gate-flip wave; the zombie stop itself is a keep).
      const journal = await (prisma as any).runJournalEntry
        ?.findFirst({ where: { chatId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
        .catch(() => null);
      const journalMs = journal?.createdAt ? new Date(journal.createdAt).getTime() : undefined;
      if (journalMs !== undefined && (lastActivityMs === undefined || journalMs > lastActivityMs)) {
        lastActivityMs = journalMs;
      }
      if (lastActivityMs === undefined) continue;

      const intervalSec = shortestIntervalSec.get(chatId);
      const silenceFloorMs = intervalSec
        ? ZOMBIE_SILENCE_MULTIPLIER * intervalSec * 1000
        : ZOMBIE_SILENCE_FALLBACK_MS;
      const silentMs = nowMs - lastActivityMs;
      if (silentMs < silenceFloorMs) continue; // still inside its expected pulse

      // NX dedupe FIRST — one stop per chat per window; an NX refusal (already
      // stopped inside the window) or a Redis outage skips honestly rather
      // than risking a repeat volley at a long-but-legitimate run.
      const nx = await (redisClient as any)
        .set(ZOMBIE_STOP_KEY(chatId), '1', { NX: true, EX: ZOMBIE_STOP_DEDUPE_SEC })
        .catch(() => null);
      if (nx !== 'OK') continue;

      const stopped = await requestChatRunStop(chatId);
      if (!stopped) {
        // The stop flag never landed — release the dedupe so the next sweep retries.
        await (redisClient as any).del(ZOMBIE_STOP_KEY(chatId)).catch(() => {});
        logger.warn(`attention-watchdog: zombie-run stop flag failed to land for chat ${chatId} — dedupe released, next sweep retries`);
        continue;
      }
      const silentMinutes = Math.round(silentMs / 60000);
      recordLoopMetric({
        kind: 'guard_strike', // LOOP_METRIC_KINDS.GUARD_STRIKE — literal like the other kinds this file records
        sessionId: chatId,
        meta: { seam: 'zombie_run_stop', chatId, silentMinutes, floorMinutes: Math.round(silenceFloorMs / 60000) },
      });
      logger.warn(
        `attention-watchdog: ZOMBIE machine run stopped on chat ${chatId} — machine live-run lock held with no machine note/journal activity for ${silentMinutes}m (floor ${Math.round(silenceFloorMs / 60000)}m); stop flag set, the run's heartbeat will cancel it`,
      );
    } catch (err: any) {
      logger.warn(`attention-watchdog: zombie check failed for chat ${chatId} (non-fatal): ${err?.message ?? err}`);
    }
  }
}

// ── Sweep entry (the worker's durable-cron handler) ───────────────────────────

export async function runAttentionWatchdogOnce(opts?: { now?: Date }): Promise<void> {
  const now = opts?.now ?? new Date();
  // (The same-seam fleet alarm that ran here was deleted in build 2026-10-08 S-2:
  // its owner push was the opt-in SEAM_ALARM_ENABLED, never forwarded to prod,
  // and its seam_alarm metric had no reader — simplify.md §1.2/§1.3.)
  // Containment ladder (remediation P8 item S7): per-lane strike-rate tier
  // TELEMETRY — one containment_ladder row per state transition. Gate flip
  // 2026-09-11 (owner: full steam): the action path (claims notice → cadence
  // halving → owner model-swap card) was REMOVED, no env re-arms it. Same
  // posture as the seam alarm: best-effort, never throws into the cron loop.
  try {
    const { sweepContainmentLadder } = await import('./containment-ladder.service');
    await sweepContainmentLadder({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: containment-ladder sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Watched resources (remediation P7 S1b): unobserved/ending external
  // resources alarm the owner (Telegram + supervisor note, deduped 6h per
  // resource). Same posture: best-effort, never throws into the cron loop.
  // Kill-switch: WATCHED_RESOURCE_SWEEP_DISABLED=1 (read inside the sweep).
  try {
    const { sweepWatchedResources } = await import('../platform/resources.service');
    await sweepWatchedResources({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: watched-resource sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Review 2026-09-13 issue 11: supervisor-first triage. Open owner questions
  // the Fleet Supervisor did not answer within the triage SLA SURFACE to the
  // owner here (triage 'supervisor' → 'surfaced' + the once-delayed Telegram
  // DM). Same owner-question escalation seam as the 72h re-push / default-
  // answer paths (project-digest pushBlockedItem) — the watchdog's ≤15-min
  // cadence bounds the surfacing latency. Best-effort; never throws into the
  // cron loop. Kill-switch for the routing itself: OWNER_QUESTION_TRIAGE_DISABLED=1.
  try {
    const { surfaceTriagedOwnerQuestions } = await import('../platform/owner-questions');
    await surfaceTriagedOwnerQuestions({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: owner-question triage surfacing failed (non-fatal): ${err?.message ?? err}`);
  }
  // OWNER-INTERRUPT-ECONOMY (supervisor SOTA round 3, 2026-10-20): (1) due
  // reversible recommended defaults auto-apply after 24 h (owner-only classes
  // never; each application queues its digest announcement), then (2) every
  // owner's due decision digest goes out — one DM batching the cards outside
  // the owner-only / urgent classes, no card held past 12 h from filing. Same
  // owner-question seam as the triage surfacing above (≤ 15-min cadence is the
  // digest's slack); bounded per pass inside each sweep; never throws into the
  // cron loop. Kill switches OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED=1 /
  // OWNER_DECISION_DIGEST_DISABLED=1 (read inside the sweeps; the digest
  // switch FLUSHES anything already queued instead of stranding it).
  try {
    const { sweepReversibleDefaults, sweepOwnerDecisionDigest } = await import('../platform/owner-interrupt-economy');
    await sweepReversibleDefaults({ now });
    await sweepOwnerDecisionDigest({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: owner-interrupt economy sweeps failed (non-fatal): ${err?.message ?? err}`);
  }
  // Infra env-red streak (ticket c12239c1): ≥3 environmental verify reds across
  // ≥2 sessions in 30 min (the 2026-09-09 fleet-wide OOM signature) ⇒ the
  // infra-actuation lever fires env_probe then dev_container_resize for each
  // implicated session owner — dry-run receipts unless INFRA_ACTIONS_ENABLED=1.
  // Same posture as the other sub-sweeps: best-effort, never throws into the
  // cron loop; kill-switch INFRA_SWEEP_DISABLED=1 (read inside the sweep).
  try {
    const { sweepEnvRedInfraStreak } = await import('./infra-actions.service');
    await sweepEnvRedInfraStreak({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: env-red infra sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // T2e starve notice (ticket 7ec6200b): ≥ VERIFY_STARVE_NOTICE_MIN starved
  // verify stages (verify_env_red + verify_pressure_deferred) in the last HOUR
  // ⇒ ONE notice into the Fleet Supervisor chat (Redis-NX deduped per hour).
  // The NOTICE arm of the env-red sweep above — always-on, no infra_action
  // receipts, same best-effort posture. Kill-switch INFRA_SWEEP_DISABLED=1.
  try {
    const { sweepVerifyStarveNotice } = await import('./infra-actions.service');
    await sweepVerifyStarveNotice({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: verify starve notice sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Follow-through detectors (owner 2026-09-16, framework item 3): a lane
  // diagnosed as stalled with no action toward it since ⇒ one [FOLLOW-THROUGH]
  // wake per lane per day; an "owner-gated" claim with no open owner question
  // for the chat/project ⇒ the question is filed for the owner and the
  // supervisor gets a notice naming the oq id. Same posture as the sweeps
  // above: best-effort, never throws; kill-switch FOLLOW_THROUGH_DISABLED=1.
  try {
    const { sweepFollowThrough } = await import('./follow-through.service');
    await sweepFollowThrough({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: follow-through sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Adoption ladder (tt-rd audit 2026-09-27, finding 3): a goal whose kpi:
  // premise has not moved toward its bar for K experiments / H hours on its
  // assignee lanes wakes the project supervisor ONCE per 24 h per goal with a
  // [NO-ADOPTION] block (re-plan or escalate — never a bounce or a card).
  // Same posture: best-effort, never throws; kill-switch ADOPTION_LADDER_DISABLED=1.
  try {
    const { sweepAdoptionLadder } = await import('../platform/adoption-ladder');
    await sweepAdoptionLadder({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: adoption-ladder sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Unplanned goals (architecture review #6 part 3, 2026-10-20): an ACTIVE goal
  // with zero open todos and no lane chartered to it that ran in the last 6 h
  // wakes the project supervisor ONCE per 24 h per goal with a [GOAL UNPLANNED]
  // block (plan the next todo, close with evidence, or block with a kind +
  // reason). Same posture: best-effort, never throws; kill-switch
  // GOAL_UNPLANNED_SIGNAL_DISABLED=1 (read inside the sweep).
  try {
    const { detectUnplannedGoals } = await import('./unplanned-goals.service');
    await detectUnplannedGoals({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: unplanned-goals sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Directive age (supervisor-directives-closure D2, 2026-09-27): owner
  // directives open ≥24h with NO evidence recorded ⇒ ONE [FOLLOW-THROUGH —
  // DIRECTIVE] wake per directive per day naming it; plus the daily
  // `directive_open_age` row per supervisor chat. Same posture: best-effort,
  // never throws; kill-switch DIRECTIVE_AGE_ALARM_DISABLED=1 (read inside).
  try {
    const { sweepDirectiveAge } = await import('../platform/directive-age.service');
    await sweepDirectiveAge({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: directive-age sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Infra watch (owner 2026-09-18 — "harden the fleet supervisor so it can
  // take over as the framework operator"): box disk/health, failed deploy
  // runs and the owner-click cost of staged cards become [INFRA ALERT] wakes
  // to the admin owner's Fleet Supervisor, each with a playbook and a verify
  // step. Same posture: best-effort, never throws; kill-switch INFRA_WATCH_DISABLED=1.
  try {
    const { sweepInfraWatch } = await import('./infra-watch.service');
    await sweepInfraWatch({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: infra-watch sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  // Product watch (2026-09-18): measured PRODUCT regressions from telemetry —
  // user-turn answers without follow-up chips per level — become
  // [PRODUCT ALERT] wakes with the numbers and the code path. Same posture;
  // kill-switch PRODUCT_WATCH_DISABLED=1.
  try {
    const { sweepProductWatch } = await import('./product-watch.service');
    await sweepProductWatch({ now });
  } catch (err: any) {
    logger.warn(`attention-watchdog: product-watch sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  const supervisors = await prisma.crossModelChat.findMany({
    where: { isSupervisor: true },
    select: { id: true, userId: true },
    take: MAX_USERS_PER_SWEEP,
  });
  for (const sup of supervisors) {
    try {
      await sweepUser(sup.userId, sup.id, now);
    } catch (err) {
      // Per-user isolation — one bad user must never kill the sweep.
      logger.error('attention-watchdog: user sweep failed', { userId: sup.userId, err: String(err) });
    }
  }
  // Who watches the watcher (live incident 2026-09-10): a zombie machine run
  // holding a supervisor lane's lock silences the lane's ONLY alarm — the
  // notices above post fine, but nothing answers. Bounded, best-effort, and
  // deliberately LAST: the notices never wait on it.
  try {
    await sweepZombieMachineRuns(supervisors.map((s) => s.id), now);
  } catch (err: any) {
    logger.warn(`attention-watchdog: zombie-run sweep failed (non-fatal): ${err?.message ?? err}`);
  }
}
