/**
 * Session status cards — the per-SESSION sibling of fleet/project-status.service
 * (owner ask 2026-09-15: "i love this visual… could we possibly add something like
 * this for session level as well").
 *
 * DETERMINISTIC — NO LLM. Once an hour, every coding session that RAN in the
 * last hour gets one plain-language card in its own chat: where its plan stands,
 * what its runs finished, what is blocked, what is next. Built from the ledger
 * only — agent_runs, the session plan (context store), tool receipts, enabled
 * schedules, pending approvals/questions, open owner questions, the verify
 * state and the session usage meter — and rendered with the SAME wording rules,
 * scrubber and body shape as the project card (helpers imported from
 * project-status.service, never re-implemented).
 *
 * Differences from the project card, on purpose:
 *   - Written with appendCodingMessage (coding_messages + the crossmodel_messages
 *     mirror in one transaction) — a coding session's transcript is dual-written
 *     and a mirror-only row would vanish on the legacy read path.
 *   - NO "no change in the last hour" stub: a session chat is the lane's own
 *     workspace; an hourly stub there is exactly the noise the owner asked us to
 *     remove. Unchanged status ⇒ nothing is written (the gate still records it).
 *   - Only sessions with ≥1 run touching the window are candidates; idle
 *     sessions are silent.
 *   - Volatile facts (a run currently in flight, spend) ride the contract for the
 *     UI but are EXCLUDED from the change hash, so they never force a card.
 *
 * Wording: "waiting on you" / "needs you" only for things that actually wait on
 * the owner (pending approvals/questions, open owner questions) — a failed run or
 * a blocked plan step is "blocked", never an owner ask (owner confusion
 * 2026-09-15). Clocks are relative ("in about 25 minutes") so nothing needs
 * localizing and nothing is stripped.
 *
 * Kill switch: SESSION_STATUS_UPDATES_DISABLED=1 (read per call; the worker
 * handler checks it too).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { plain, plural, renderSection, hashStatusObject, clipText } from '../fleet/project-status.service';
import { appendCodingMessage } from './coding-data.service';
import { getPlan } from './plan.service';
import { getRecentChatReceipts } from './run-receipts.service';
import { loadSessionUsage } from './usage-store';
import { getVerifyState, getVerifyAbsent } from './verify-state';
import { getPendingAttentionMap } from './session-run-lock';
import { latestDeliverableHandoff, describeHandoff } from './deliverable-handoff';
import { readUnpushedStamp, unpushedCommitsNoteDisabled } from './unpushed-commits';

// ── Contract constants ───────────────────────────────────────────────────────

export const SESSION_STATUS_ORIGIN = 'session_status';
/** One card per session per hour at most. */
export const SESSION_STATUS_INTERVAL_MS = 60 * 60 * 1000;
/** A very old previous card (worker outage) clamps the window to 24h. */
export const SESSION_STATUS_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SESSION_STATUS_BODY_MAX_CHARS = 900;
export const SESSION_STATUS_MAX_ITEMS = 4;
export const MAX_SESSIONS_PER_SWEEP = 200;
export const SESSION_STATUS_DISABLED_ENV = 'SESSION_STATUS_UPDATES_DISABLED';

export function sessionStatusUpdatesDisabled(): boolean {
  return process.env[SESSION_STATUS_DISABLED_ENV] === '1';
}

// ── Contract shapes (SHARED with frontend/lib/machine-wake.ts) ──────────────

export interface SessionStatus {
  sessionTitle: string;
  projectName: string | null;
  headline: string;
  workingOn: string[];
  doneSince: string[];
  blocked: string[];
  next: string[];
  /** Plan progress; null when the session has no plan recorded. */
  plan: { done: number; total: number; blocked: number } | null;
  /** Runs touching the window by terminal state, plus what is in flight right now. */
  runs: { completed: number; failed: number; running: number };
  /** Pull requests this session opened / merged in the window (from receipts), and how many of
   *  the opened ones were docs-only (every changed file markdown — the open_pull_request receipt's
   *  filesOnlyMd flag, tt-rd audit 2026-09-27: a results-log append is a RECORD, not movement). */
  prs: { opened: number; merged: number; docsOnly: number };
  /** Things that actually wait on the owner: pending approvals + questions + open owner questions. */
  ownerItems: number;
  /** Whole-session spend so far (USD), from the usage meter; null when unknown. */
  spendUsd: number | null;
  /** Deliverable hand-off (cohesive chat wave, 2026-09-27): the newest result
   *  this session handed back (files / PRs / canvases + where), when it landed
   *  inside the window. Absent when none. The same facts ride `doneSince`. */
  result?: { files: number; prs: number; canvases: number; target: 'parent' | 'self'; line: string };
}

export interface SessionStatusMetadata {
  origin: typeof SESSION_STATUS_ORIGIN;
  kind: typeof SESSION_STATUS_ORIGIN;
  generatedAt: string;
  since: string;
  status: SessionStatus;
  statusHash: string;
  unchanged: false;
}

export interface RenderedSessionStatus {
  status: SessionStatus;
  body: string;
  /** Hash of the session's STATE only (see sessionStateKey) — the no-change gate. */
  hash: string;
}

export interface SessionStatusSweepResult {
  candidates: number;
  emitted: number;
  gated: number;
  unchanged: number;
  /** A run was in flight — the card waits for a settled state (next sweep). */
  busy: number;
  idle: number;
  failed: number;
}

// ── Pure renderers (exported for tests) ─────────────────────────────────────

/** "in about 25 minutes" / "in about 2 hours" / "any moment now" — relative, so no clock is ever printed. */
export function relativeSoon(targetMs: number, nowMs: number): string {
  const diffMin = Math.round((targetMs - nowMs) / 60_000);
  if (diffMin <= 1) return 'any moment now';
  if (diffMin < 90) return `in about ${plural(diffMin, 'minute')}`;
  const hours = Math.round(diffMin / 60);
  if (hours < 36) return `in about ${plural(hours, 'hour')}`;
  return `in about ${plural(Math.round(hours / 24), 'day')}`;
}

/** The in-flight placeholder and the relative-clock line are window facts, not state. */
const RUN_IN_PROGRESS_LINE = 'A run is in progress';
/** A4 (2026-09-27): the honest line for a session whose project has no verify chain. */
export const VERIFY_ABSENT_LINE = "No verify chain — every \"verified\" is the lane's own probe (add .digby/config.json typecheck/lint/test commands)";
/**
 * audit 2026-10-06 T8-5 (litellm F10): a missing verify chain is NOT a block — it listed under **Blocked** on every
 * card though nothing was stuck. The card now says it under **Next**, as the action it is, in "Unverified" words.
 * VERIFY_ABSENT_NOT_BLOCKED_DISABLED=1 restores VERIFY_ABSENT_LINE under Blocked.
 */
export const VERIFY_UNVERIFIED_LINE = "Unverified (no verify chain): add .digby/config.json typecheck/lint/test commands — until then every \"verified\" is the lane's own probe";
export function verifyAbsentNotBlockedDisabled(): boolean {
  return process.env.VERIFY_ABSENT_NOT_BLOCKED_DISABLED === '1';
}
const NEXT_RUN_PREFIX = 'Next scheduled run ';

/**
 * The STATE the no-change gate compares (review 2026-09-15, three lenses): the
 * plan position, blocked steps and the last failure, pending owner items, the
 * next step, and whether a PR was opened since the last card. Window
 * arithmetic — how many runs finished, a run in flight, the minutes until the
 * next schedule fire, spend — is excluded by construction, so a steady
 * scheduled lane whose state has not moved gets NO card, however many runs it
 * completed. (The first draft hashed the counts; a 15-min lane would have
 * alternated "4 runs" / "5 runs" cards every hour.)
 */
export function sessionStateKey(status: SessionStatus): Record<string, unknown> {
  return {
    sessionTitle: status.sessionTitle,
    projectName: status.projectName,
    plan: status.plan,
    workingOn: status.workingOn.filter((l) => l !== RUN_IN_PROGRESS_LINE),
    blocked: status.blocked,
    next: status.next.filter((l) => !l.startsWith(NEXT_RUN_PREFIX)),
    ownerItems: status.ownerItems,
    prOpened: status.prs.opened > 0,
    prMerged: status.prs.merged > 0,
    hadFailure: status.runs.failed > 0,
  };
}

export function hashSessionStatus(status: SessionStatus): string {
  return hashStatusObject(sessionStateKey(status));
}

export function buildSessionHeadline(input: {
  sessionTitle: string;
  plan: SessionStatus['plan'];
  currentStepIndex: number | null;
  runs: SessionStatus['runs'];
  ownerItems: number;
}): string {
  const { plan, runs, ownerItems } = input;
  let planPart: string;
  if (!plan || plan.total === 0) planPart = 'no plan recorded';
  else if (plan.done >= plan.total) planPart = `all ${plural(plan.total, 'step')} done`;
  else if (input.currentStepIndex !== null) planPart = `on step ${input.currentStepIndex + 1} of ${plan.total}`;
  else planPart = `${plan.done} of ${plural(plan.total, 'step')} done`;
  // Counts are "since the last update" (the window is the gap between cards,
  // clamped to 24h) — never "in the last hour", which was false after a gap.
  const runBits: string[] = [];
  if (runs.completed > 0) runBits.push(`${plural(runs.completed, 'run')} finished`);
  if (runs.failed > 0) runBits.push(`${plural(runs.failed, 'run')} hit an error`);
  if (runs.running > 0) runBits.push(runs.running === 1 ? 'one running now' : `${runs.running} running now`);
  const runsPart = runBits.length ? runBits.join(', ') : 'no runs finished since the last update';
  const ownerPart = ownerItems > 0 ? `; ${plural(ownerItems, 'item')} waiting on you` : '';
  return `${plain(input.sessionTitle, 60)}: ${planPart}; ${runsPart}${ownerPart}`;
}

/** Markdown body — same shape as the project card; shrink-to-fit 4→3→2→1, then hard clip. */
export function buildSessionStatusBody(status: SessionStatus): string {
  const compose = (max: number): string => {
    const parts = [
      `**${status.headline}**`,
      renderSection('Working on', status.workingOn, max),
      renderSection('Done since the last update', status.doneSince, max),
      renderSection(status.ownerItems > 0 ? 'Blocked or needs you' : 'Blocked', status.blocked, max),
      renderSection('Next', status.next, max),
    ].filter(Boolean);
    return parts.join('\n\n');
  };
  for (const max of [SESSION_STATUS_MAX_ITEMS, 3, 2, 1]) {
    const body = compose(max);
    if (Array.from(body).length <= SESSION_STATUS_BODY_MAX_CHARS) return body;
  }
  return clipText(compose(1), SESSION_STATUS_BODY_MAX_CHARS);
}

// ── Ledger → status ──────────────────────────────────────────────────────────

interface RunRow { sessionId: string; status: string; error: string | null; startedAt: Date | null; finishedAt: Date | null }
interface ScheduleRow { sessionId: string; nextRunAt: Date | string | null }

/**
 * Render ONE session's status from already-fetched window facts plus its own
 * store reads. Pure apart from the reads; never throws (a failed read degrades
 * that fact to "unknown", the card still renders).
 */
export async function renderSessionStatus(input: {
  chatId: string;
  sessionTitle: string;
  projectName: string | null;
  runs: RunRow[];
  schedules: ScheduleRow[];
  attention: { approvals: string[]; questions: string[] } | undefined;
  since: Date;
  now?: Date;
}): Promise<RenderedSessionStatus> {
  const now = input.now ?? new Date();
  const sinceMs = input.since.getTime();

  const [plan, receipts, usage, verify, openOwnerQuestions, verifyAbsent, handoff] = await Promise.all([
    getPlan(input.chatId),
    getRecentChatReceipts(input.chatId, Math.max(60_000, now.getTime() - sinceMs)),
    loadSessionUsage(input.chatId),
    getVerifyState(input.chatId),
    prisma.ownerQuestion.count({ where: { chatId: input.chatId, status: 'open' } }).catch(() => 0),
    // A4 (2026-09-27): the "no verify chain" marker — state, not an event, so
    // the card says it on every render until a chain exists and runs.
    getVerifyAbsent(input.chatId).catch(() => null),
    // Deliverable hand-off record (cohesive chat wave): the Result line.
    latestDeliverableHandoff(input.chatId).catch(() => null),
  ]);
  // audit 2026-10-06 T7-8 (unpushed-commits.ts): the run-end stamp of commits
  // no remote-tracking ref contains — "Made 1 commit" never again hides that
  // the commit is local only. UNPUSHED_COMMITS_NOTE_DISABLED=1 ⇒ not read.
  const unpushedStamp = unpushedCommitsNoteDisabled() ? null : await readUnpushedStamp(input.chatId).catch(() => null);
  const unpushed = unpushedStamp && Number.isFinite(unpushedStamp.count) && unpushedStamp.count > 0 ? unpushedStamp.count : 0;

  // Runs by terminal state in the window; running = in flight right now.
  const runs = { completed: 0, failed: 0, running: 0 };
  const failures: string[] = [];
  for (const r of input.runs) {
    if (r.status === 'running') runs.running++;
    else if (r.status === 'completed') runs.completed++;
    else if (r.status === 'failed' || r.status === 'interrupted') {
      runs.failed++;
      if (r.error) failures.push(r.error);
    }
  }

  // Plan: current step, next pending step, counts.
  const steps = plan?.steps ?? [];
  const planCounts = steps.length
    ? { done: steps.filter((s) => s.status === 'completed').length, total: steps.length, blocked: steps.filter((s) => s.status === 'blocked').length }
    : null;
  const currentIdx = steps.findIndex((s) => s.status === 'in_progress');
  const current = currentIdx >= 0 ? steps[currentIdx] : null;
  const nextPending = steps.find((s) => s.status === 'pending');
  const blockedSteps = steps.filter((s) => s.status === 'blocked');

  // Receipts → plain accomplishments (counts, never ids).
  const byTool = new Map<string, number>();
  for (const r of receipts) byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1);
  const prsOpened = byTool.get('open_pull_request') ?? 0;
  const prsMerged = byTool.get('merge_pull_request') ?? 0;
  const prsDocsOnly = receipts.filter((r) => r.tool === 'open_pull_request' && (r.ids as any)?.filesOnlyMd === true).length;
  const commits = byTool.get('git_commit') ?? 0;
  const pushes = byTool.get('git_push') ?? 0;
  const tickets = byTool.get('file_feedback') ?? 0;
  const messages = byTool.get('send_chat_message') ?? 0;
  const verifies = receipts.filter((r) => r.tool === 'verify');
  const verifyPassed = verifies.filter((r) => (r.ids as any)?.passed === true).length;
  // Only a receipt that names a FAILING STAGE is a failure — run-receipts also
  // stamps passed:false for "no verify chain configured" / UNVERIFIED (missing
  // tool), which are not failures (review 2026-09-15).
  const verifyFailed = verifies.filter((r) => (r.ids as any)?.passed !== true && typeof (r.ids as any)?.failedStage === 'string' && (r.ids as any).failedStage).length;

  // Owner-actionable items only.
  const approvals = input.attention?.approvals.length ?? 0;
  const questions = input.attention?.questions.length ?? 0;
  const ownerItems = approvals + questions + openOwnerQuestions;

  const workingOn: string[] = [];
  if (current) workingOn.push(current.note ? `${plain(current.text, 60)} — ${plain(current.note, 60)}` : plain(current.text));
  else if (runs.running > 0) workingOn.push(RUN_IN_PROGRESS_LINE);
  else if (plan?.goal && planCounts && planCounts.done < planCounts.total) workingOn.push(plain(plan.goal));

  const doneSince: string[] = [];
  if (runs.completed > 0) doneSince.push(`${plural(runs.completed, 'run')} finished`);
  if (prsOpened > 0) doneSince.push(`Opened ${plural(prsOpened, 'pull request')}${prsDocsOnly > 0 ? ` (${prsDocsOnly === prsOpened ? 'all' : prsDocsOnly} docs-only)` : ''}`);
  if (prsMerged > 0) doneSince.push(`Merged ${plural(prsMerged, 'pull request')}`);
  if (commits > 0 || pushes > 0) {
    doneSince.push(unpushed > 0 && commits > 0
      ? `Made ${plural(commits, 'commit')} — ${plural(unpushed, 'local commit')} NOT pushed`
      : `${commits > 0 ? `Made ${plural(commits, 'commit')}` : 'Pushed changes'}${commits > 0 && pushes > 0 ? ' and pushed them' : ''}`);
  }
  if (verifyPassed > 0) doneSince.push(verifyPassed === 1 ? 'Verification passed' : `Verification passed ${verifyPassed} times`);
  if (tickets > 0) doneSince.push(`Filed ${plural(tickets, 'ticket')}`);
  if (messages > 0) doneSince.push(`Sent ${plural(messages, 'message')} to other lanes`);
  // Result (deliverable hand-off): the files / PRs / canvases this session
  // handed back inside the window, and where they landed — the same line the
  // parent chat's result message carries, so the child's card is never dry.
  const handoffInWindow = handoff && Number.isFinite(Date.parse(handoff.postedAt)) && Date.parse(handoff.postedAt) >= sinceMs ? handoff : null;
  const resultLine = handoffInWindow ? describeHandoff(handoffInWindow) : null;
  if (resultLine) doneSince.push(resultLine);

  const blocked: string[] = [];
  for (const s of blockedSteps) blocked.push(`Step blocked: ${s.note ? `${plain(s.text, 60)} — ${plain(s.note, 60)}` : plain(s.text)}`);
  // Count-free on purpose (the Runs counter carries the number): the LAST error
  // text is state; how many times it happened this window is not.
  if (runs.failed > 0) blocked.push(failures.length ? `A run hit an error: ${plain(failures[failures.length - 1], 70)}` : 'A run hit an error');
  if (verifyFailed > 0) blocked.push(`Verification failed ${verifyFailed === 1 ? 'once' : `${verifyFailed} times`}`);
  else if (verify && !verify.passed && !verify.environmental && Date.parse(verify.at) >= sinceMs) blocked.push(`Verification is failing${verify.failedStage ? ` at ${plain(verify.failedStage, 30)}` : ''}`);
  // A4 (2026-09-27 spark-cluster audit): a project without a verify chain never
  // verifies anything — the harness auto-verify skips and the lane's `verify`
  // call answers "no chain". Say so on the card (the marker outlives the
  // window on purpose; a real chain run later writes `state`, which wins here).
  const verifyChainAbsent = !!verifyAbsent && !(verify && Date.parse(verify.at) > Date.parse(verifyAbsent.at));
  const verifyAbsentInNext = verifyChainAbsent && !verifyAbsentNotBlockedDisabled();
  if (verifyChainAbsent && !verifyAbsentInNext) blocked.push(VERIFY_ABSENT_LINE);
  if (approvals > 0) blocked.push(`${plural(approvals, 'action is', 'actions are')} waiting for your approval`);
  if (questions > 0) blocked.push(`${plural(questions, 'question is', 'questions are')} waiting for your answer`);
  if (openOwnerQuestions > 0) blocked.push(`${plural(openOwnerQuestions, 'decision is', 'decisions are')} waiting on you in the inbox`);

  const next: string[] = [];
  // T7-8: local-only commits are the first thing to finish (state — it rides the change hash).
  if (unpushed > 0) next.push(`Push ${plural(unpushed, 'local commit')} — not on origin yet`);
  if (nextPending) next.push(plain(nextPending.text));
  const nextFire = input.schedules
    .map((s) => (s.nextRunAt ? new Date(s.nextRunAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t) && t > now.getTime())
    .sort((a, b) => a - b)[0];
  if (nextFire !== undefined) next.push(`${NEXT_RUN_PREFIX}${relativeSoon(nextFire, now.getTime())}`);
  if (verifyAbsentInNext) next.push(VERIFY_UNVERIFIED_LINE);

  const status: SessionStatus = {
    sessionTitle: plain(input.sessionTitle, 60),
    projectName: input.projectName ? plain(input.projectName, 60) : null,
    headline: '',
    workingOn, doneSince, blocked, next,
    plan: planCounts,
    runs,
    prs: { opened: prsOpened, merged: prsMerged, docsOnly: prsDocsOnly },
    ownerItems,
    spendUsd: usage && typeof usage.costUsd === 'number' && usage.costUsd > 0 ? Math.round(usage.costUsd * 100) / 100 : null,
    ...(handoffInWindow && resultLine
      ? { result: { files: handoffInWindow.files, prs: handoffInWindow.prs, canvases: handoffInWindow.canvases, target: handoffInWindow.parentChatId ? 'parent' as const : 'self' as const, line: resultLine } }
      : {}),
  };
  status.headline = buildSessionHeadline({ sessionTitle: input.sessionTitle, plan: planCounts, currentStepIndex: currentIdx >= 0 ? currentIdx : null, runs, ownerItems });
  return { status, body: buildSessionStatusBody(status), hash: hashSessionStatus(status) };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/**
 * Newest session-status row in a session chat (the 60-min gate + hash source).
 *
 * MERGE-1 is complete (2026-11-04): `crossmodel_messages` is the ONLY transcript
 * table, read unconditionally. The former read-switch (and the flag mismatch it
 * fixed — dual-write governed WRITES while the read switch governed READS, so
 * under TRANSCRIPT_READ=legacy this card came from the mirror while every other
 * read came from the legacy table) has no lever left to express.
 */
async function latestSessionStatusRow(chatId: string): Promise<{ createdAt: Date; metadata: any } | null> {
  const where = { chatId, role: 'assistant', metadata: { path: ['origin'], equals: SESSION_STATUS_ORIGIN } } as const;
  const args = { where, orderBy: { createdAt: 'desc' as const }, select: { createdAt: true, metadata: true } };
  const row = await prisma.crossModelMessage.findFirst(args as any);
  return (row as any) ?? null;
}

/**
 * The hourly sweep: for every live coding session that ran in the last hour,
 * emit a card when the previous one is ≥ 60 min old (or absent) AND the status
 * changed. Never throws; per-session failures are isolated.
 */
export async function emitSessionStatusUpdates(opts?: { now?: Date }): Promise<SessionStatusSweepResult> {
  const result: SessionStatusSweepResult = { candidates: 0, emitted: 0, gated: 0, unchanged: 0, busy: 0, idle: 0, failed: 0 };
  if (sessionStatusUpdatesDisabled()) return result;
  const now = opts?.now ?? new Date();
  const windowStart = new Date(now.getTime() - SESSION_STATUS_INTERVAL_MS);

  let sessions: Array<{ id: string; title: string | null; userId: string; projectId: string | null; project: { name: string } | null }>;
  try {
    sessions = await prisma.crossModelChat.findMany({
      where: {
        archivedAt: null,
        isSupervisor: false,
        isProjectSupervisor: false,
        updatedAt: { gte: windowStart },
        codingState: { is: { status: { not: 'archived' } } },
      },
      select: { id: true, title: true, userId: true, projectId: true, project: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: MAX_SESSIONS_PER_SWEEP,
    }) as any;
  } catch (err: any) {
    logger.warn(`session-status: session discovery failed — skipping sweep: ${err?.message ?? err}`);
    return result;
  }
  if (sessions.length === 0) return result;
  const ids = sessions.map((s) => s.id);

  // Batched window facts (one query each), then ONE Redis attention scan.
  let runsBySession = new Map<string, RunRow[]>();
  let schedulesBySession = new Map<string, ScheduleRow[]>();
  let attention = new Map<string, { approvals: string[]; questions: string[] }>();
  try {
    const [runRows, schedRows, att] = await Promise.all([
      prisma.agentRun.findMany({
        where: {
          sessionId: { in: ids },
          OR: [{ finishedAt: { gte: new Date(now.getTime() - SESSION_STATUS_MAX_WINDOW_MS) } }, { startedAt: { gte: new Date(now.getTime() - SESSION_STATUS_MAX_WINDOW_MS) } }, { status: 'running' }],
        },
        select: { sessionId: true, status: true, error: true, startedAt: true, finishedAt: true },
      }) as Promise<RunRow[]>,
      prisma.chatSchedule.findMany({
        where: { sessionId: { in: ids }, enabled: true },
        select: { sessionId: true, nextRunAt: true },
      }) as Promise<ScheduleRow[]>,
      getPendingAttentionMap(),
    ]);
    for (const r of runRows) { const list = runsBySession.get(r.sessionId) ?? []; list.push(r); runsBySession.set(r.sessionId, list); }
    for (const s of schedRows) { const list = schedulesBySession.get(s.sessionId) ?? []; list.push(s); schedulesBySession.set(s.sessionId, list); }
    attention = att;
  } catch (err: any) {
    logger.warn(`session-status: window facts failed — skipping sweep: ${err?.message ?? err}`);
    runsBySession = new Map(); schedulesBySession = new Map();
    return result;
  }

  for (const s of sessions) {
    try {
      const allRuns = runsBySession.get(s.id) ?? [];
      // Candidate only when a run TOUCHED the last hour (or is in flight).
      const touched = allRuns.some((r) =>
        r.status === 'running'
        || (r.finishedAt && r.finishedAt.getTime() >= windowStart.getTime())
        || (r.startedAt && r.startedAt.getTime() >= windowStart.getTime()));
      if (!touched) { result.idle++; continue; }
      result.candidates++;
      // A run in flight: wait for a settled state (review 2026-09-15) — the
      // card would otherwise land mid-run, split that run's accordion in the
      // transcript, and describe a moving target ("one running now").
      if (allRuns.some((r) => r.status === 'running')) { result.busy++; continue; }

      const prev = await latestSessionStatusRow(s.id);
      if (prev && now.getTime() - prev.createdAt.getTime() < SESSION_STATUS_INTERVAL_MS) { result.gated++; continue; }
      const since = prev
        ? new Date(Math.max(prev.createdAt.getTime(), now.getTime() - SESSION_STATUS_MAX_WINDOW_MS))
        : windowStart;
      const windowRuns = allRuns.filter((r) =>
        r.status === 'running'
        || (r.finishedAt && r.finishedAt.getTime() >= since.getTime())
        || (r.startedAt && r.startedAt.getTime() >= since.getTime()));

      const rendered = await renderSessionStatus({
        chatId: s.id,
        sessionTitle: s.title || 'Coding session',
        projectName: s.project?.name ?? null,
        runs: windowRuns,
        schedules: schedulesBySession.get(s.id) ?? [],
        attention: attention.get(s.id),
        since,
        now,
      });
      if (prev?.metadata?.statusHash && prev.metadata.statusHash === rendered.hash) { result.unchanged++; continue; }

      const metadata: SessionStatusMetadata = {
        origin: SESSION_STATUS_ORIGIN,
        kind: SESSION_STATUS_ORIGIN,
        generatedAt: now.toISOString(),
        since: since.toISOString(),
        status: rendered.status,
        statusHash: rendered.hash,
        unchanged: false,
      };
      // No sidebar bump (unlike the project card): the card lives in the
      // session's own chat and must not reorder the owner's session list or
      // re-arm "new response" hourly (review 2026-09-15).
      await appendCodingMessage({ chatId: s.id, role: 'assistant', content: rendered.body, metadata });
      result.emitted++;
    } catch (err: any) {
      result.failed++;
      logger.warn(`session-status: card for session ${s.id.slice(0, 8)} failed: ${err?.message ?? err}`);
    }
  }
  return result;
}

/** Cron entry point (worker.ts 'session-status'): never throws. */
export async function runSessionStatusOnce(): Promise<void> {
  try {
    const r = await emitSessionStatusUpdates();
    if (r.candidates > 0 || r.failed > 0) {
      logger.info(`session-status: candidates ${r.candidates}, emitted ${r.emitted}, gated ${r.gated}, unchanged ${r.unchanged}, busy ${r.busy}, idle ${r.idle}, failed ${r.failed}`);
    }
  } catch (err: any) {
    logger.warn(`session-status: sweep failed: ${err?.message ?? err}`);
  }
}

/** Read side: the newest card for one session (REST consumers), or null. */
export async function getLatestSessionStatus(chatId: string): Promise<{ createdAt: string; body: string; status: SessionStatus; generatedAt: string } | null> {
  const row = await prisma.crossModelMessage.findFirst({
    where: { chatId, role: 'assistant', metadata: { path: ['origin'], equals: SESSION_STATUS_ORIGIN } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, content: true, metadata: true },
  });
  if (!row) return null;
  const md = (row.metadata ?? {}) as any;
  return { createdAt: row.createdAt.toISOString(), body: row.content, status: md.status as SessionStatus, generatedAt: md.generatedAt ?? row.createdAt.toISOString() };
}
