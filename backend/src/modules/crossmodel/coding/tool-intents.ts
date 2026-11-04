/**
 * Tool-intent journal — PENDING receipts + idempotency keys
 * (build 2026-10-08 D-2; architecture.md item C, stage 1 "Shadow").
 *
 * WHY. A RESUMED coding run (the checkpoint rewind discards the in-flight
 * turn — run-executor HARNESS_NOTICE: "its calls may or may not have
 * executed") and a REQUEUED chat turn (the deploy ritual, an orphan re-fire,
 * the empty-completion / seat-fallback retry inside one turn) re-issue
 * side-effecting calls whose earlier attempt may already have applied them.
 * Receipts record only what FINISHED; nothing records a call that STARTED and
 * never settled, and nothing ties a re-issued call to its earlier twin. The
 * 14-day audit found ≤ 5 exact duplicate side effects, but start_coding_session
 * / send_chat_message / todo_create / notify_user / file_feedback carry no
 * idempotency key at all on machine turns.
 *
 * WHAT (the stage-1 shadow journal — the DL-2 ACT step below is what skips):
 *   begin()  — called by the agent loop right BEFORE a side-effecting tool
 *              runs. The call's idempotency key is computed SYNCHRONOUSLY and a
 *              `pending` row is issued (fire-and-forget: the tool never waits
 *              on the DB). In the background the journal looks for an EARLIER
 *              ATTEMPT's row with the same key and records what act mode WOULD
 *              do (wouldReconcile):
 *                skip_applied          — it already happened: act returns the
 *                                        earlier receipt instead of re-running;
 *                reconcile_lookup      — it was in flight when the attempt died:
 *                                        act reads the effect back (child chat
 *                                        by key, PR by head, schedule row …);
 *                unknown_never_resend  — an AT-MOST-ONCE tool (notify_user,
 *                                        email, instance sends — no read-back
 *                                        exists): act never resends it.
 *              A prior row that FAILED / was STAGED never reconciles (re-running
 *              it is right).
 *   finish() — settles the row: applied | failed | staged | replayed (the
 *              harness's own idempotent-skip / work-tool replay answered) |
 *              unknown (the loop's hard timeout fired — the effect may still
 *              land). A key that had an APPLIED twin and applies AGAIN is the
 *              `executed_twice` row — the act bar is 0 of them.
 *
 * KEY = sha256(scope, tool, canonical args (receipts' inputHash), slot):
 *   scope  run:<agent_runs.id>         worker runs — every attempt shares the row;
 *          chat:<chatId>:<anchor>      chat turns — anchor = the user / wake row
 *                                      the turn answers (stable across a deploy
 *                                      requeue / orphan re-fire), a Dig-deeper
 *                                      rung or a continuation round;
 *          attempt:<attemptId>         nothing stable — never matches another attempt.
 *   slot   `<step>:<n>` on run scopes  (a checkpoint resume re-enters the SAME step),
 *          `<n>` on chat scopes        (a requeued turn restarts from step 0);
 *          n = identical (tool, args) calls this attempt already made in the slot.
 * The key rides the tool's ctx (ToolContext.intentKey) so the delegation
 * ledger can stamp the task the call created (platform/delegation-tasks.ts —
 * stage 3 "create-idempotency" reads it).
 *
 * Telemetry: loop_metrics `tool_intent` { phase: would_reconcile |
 * executed_twice } here; the nightly delegation-reconcile cron adds phase
 * `daily` (states, orphaned pendings, keys executed twice) and prunes rows
 * older than 30 days. Kill switch TOOL_INTENT_JOURNAL_DISABLED=1 (no rows, no
 * key on the ctx — the loop is byte-identical to before).
 *
 * ACT (build 2026-10-11 DL-2 — owner "turn everything remaining on"; the
 * shadow bar read 0 executed_twice keys / 0 would-reconcile verdicts over
 * 10-09..10-10): act() runs between begin() and the tool, and only when the
 * key already has a row from an EARLIER attempt:
 *   prior APPLIED (same key ⇒ same scope + tool + input hash + slot)
 *       → the call is NOT re-run: the result says "already applied at <time>
 *         — receipt <id>; not re-run" and the row settles `replayed`.
 *         git_push additionally needs its earlier receipt's sha to BE the
 *         worktree HEAD (new commits ⇒ a real push); open_pull_request is
 *         left to its handler's own receipt-backed PR re-read.
 *   prior IN FLIGHT (pending / unknown) on an AT-MOST-ONCE tool
 *       → NOT resent; the result says to verify first; settles `withheld`
 *         (a repeat call in this attempt is a new slot and IS sent).
 *   prior IN FLIGHT on a lookup tool → the lookup: the delegation ledger's
 *       task carrying this key proves a spawn / ask applied (skip); git_push /
 *       PR / merge handlers read their own receipts; no lookup ⇒ run as today.
 *   prior FAILED / STAGED / REPLAYED, a different input hash, no key, an
 *       attempt-only scope, a lookup that times out or errors ⇒ run as today.
 * Every decision with a prior twin records loop_metrics tool_intent phase
 * `act` {decision, priorIntentId, receiptId…} — the weekly 20-sample check of
 * "0 false skips" reads those rows. Switch TOOL_INTENT_ACT_DISABLED=1 restores
 * the shadow journal byte-for-byte (act() answers "run" without waiting).
 */

import { createHash, randomUUID } from 'crypto';
import prisma from '../../../config/database';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { extractReceipt, receiptInputHash, RECEIPT_TOOLS, type ToolReceipt } from './run-receipts';

export function toolIntentJournalDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.TOOL_INTENT_JOURNAL_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** build 2026-10-11 DL-2: the act switch (default ON — the journal skips an already-applied side effect on a re-run). */
export function toolIntentActDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.TOOL_INTENT_ACT_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type IntentReconcileClass = 'lookup' | 'at_most_once';
/** `withheld` (DL-2 act): an at-most-once call NOT resent because an earlier attempt's outcome is unknown. */
export type IntentState = 'pending' | 'applied' | 'failed' | 'staged' | 'replayed' | 'unknown' | 'withheld';
export type WouldReconcile = 'skip_applied' | 'reconcile_lookup' | 'unknown_never_resend';
export type IntentScopeKind = 'run' | 'chat_turn' | 'attempt';

/**
 * The side-effecting tools the journal covers (the report's C1 list + the
 * schedule arms the plan names). `lookup` = the effect can be read back
 * (child chat by parent + key, target message, PR by head, schedule / todo /
 * goal / ticket row); `at_most_once` = no read-back exists (a Telegram push,
 * an email, a paired-instance send) — act mode marks it `unknown`, never resends.
 */
export const INTENT_JOURNAL_TOOLS: Readonly<Record<string, IntentReconcileClass>> = Object.freeze({
  git_push: 'lookup',
  open_pull_request: 'lookup',
  merge_pull_request: 'lookup',
  send_chat_message: 'lookup',
  start_coding_session: 'lookup',
  dispatch_platform_task: 'lookup',
  file_feedback: 'lookup',
  schedule_message: 'lookup',
  schedule_self: 'lookup',
  update_schedule: 'lookup',
  cancel_schedule: 'lookup',
  pause_schedule: 'lookup',
  resume_schedule: 'lookup',
  todo_create: 'lookup',
  goal_create: 'lookup',
  notify_user: 'at_most_once',
  send_email_as_digby: 'at_most_once',
  send_to_instance: 'at_most_once',
});

export function isIntentJournalTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTENT_JOURNAL_TOOLS, tool);
}

/** Sessions with no durable chat row never resume or requeue — the journal stays off for them. */
function journalSessionEligible(sessionId: string): boolean {
  return !!sessionId && !sessionId.startsWith('anon-') && !sessionId.startsWith('chatless-');
}

/** Pure: the attempt-independent scope of one agent-loop attempt. */
export function intentScopeFor(o: { sessionId: string; runId?: string | null; anchor?: string | null; attemptId: string }): { scope: string; kind: IntentScopeKind } {
  if (o.runId) return { scope: `run:${o.runId}`, kind: 'run' };
  const anchor = typeof o.anchor === 'string' ? o.anchor.trim() : '';
  if (anchor) return { scope: `chat:${o.sessionId}:${anchor.slice(0, 120)}`, kind: 'chat_turn' };
  return { scope: `attempt:${o.attemptId}`, kind: 'attempt' };
}

/** Pure: the idempotency key (40 hex). */
export function intentIdemKey(scope: string, tool: string, inputHash: string, slot: string): string {
  return createHash('sha256').update(`${scope}\n${tool}\n${inputHash}\n${slot}`, 'utf8').digest('hex').slice(0, 40);
}

/**
 * Pure: what act mode WOULD do with a call whose key already has a row from an
 * EARLIER attempt. null = nothing (no twin, or the twin failed / was staged /
 * was itself a replay — re-running is right).
 */
export function wouldReconcileVerdict(prior: { state: string } | null | undefined, cls: IntentReconcileClass): WouldReconcile | null {
  if (!prior) return null;
  if (prior.state === 'applied') return 'skip_applied';
  // `withheld` (an earlier attempt already declined to resend) keeps the outcome unknown — still never resent.
  if (prior.state === 'pending' || prior.state === 'unknown' || prior.state === 'withheld') return cls === 'at_most_once' ? 'unknown_never_resend' : 'reconcile_lookup';
  return null;
}

const HARD_TIMEOUT_RE = /^Tool "[^"]+" exceeded \d+s and was aborted\./;
const REPLAY_PROSE_RE = /no duplicate was created|is ALREADY merged|^\[idempotent skip\]/i;

/**
 * Pure: settle a call's state from its raw result. `failureShaped` is the
 * loop's own failure verdict (learnings-index looksLikeToolFailure) for the
 * tools whose result has no receipt shape.
 */
export function classifyIntentOutcome(tool: string, args: unknown, result: unknown, failureShaped = false): IntentState {
  const text = String(result ?? '');
  const head = text.trimStart();
  if (head.startsWith('[idempotent skip]')) return 'replayed';
  if (HARD_TIMEOUT_RE.test(head)) return 'unknown';
  if (head.startsWith('{')) {
    try {
      const parsed = JSON.parse(head);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.needsConfirmation === true) return 'staged';
        if (parsed.deduplicated) return 'replayed';
        if (typeof parsed.ok === 'boolean' && !RECEIPT_TOOLS.has(tool)) return parsed.ok ? 'applied' : 'failed';
      }
    } catch { /* prose / clipped — fall through */ }
  }
  if (RECEIPT_TOOLS.has(tool)) {
    const draft = extractReceipt(tool, args, text, new Date());
    if (draft) {
      if ((draft.ids as Record<string, unknown>)?.staged === true) return 'staged';
      if (draft.ok) return 'applied';
      return REPLAY_PROSE_RE.test(head) ? 'replayed' : 'failed';
    }
  }
  if (REPLAY_PROSE_RE.test(head)) return 'replayed';
  return failureShaped ? 'failed' : 'applied';
}

/** An earlier attempt's row for the same key (findPrior). receiptId / inputHash / completedAt ride for act (DL-2). */
export interface PriorIntent {
  id: string;
  state: string;
  createdAt: Date;
  receiptId?: string | null;
  inputHash?: string | null;
  completedAt?: Date | null;
}

/** One begun call. `ready` resolves to the prior-attempt verdict once the background write + lookup settle. */
export interface IntentHandle {
  id: string;
  idemKey: string;
  tool: string;
  args: unknown;
  slot: string;
  /** receipts' canonical input hash of the args (DL-2: act never skips across a different hash). */
  inputHash: string;
  reconcileClass: IntentReconcileClass;
  ready: Promise<{ priorState: string | null; verdict: WouldReconcile | null; prior?: PriorIntent | null }>;
}

/**
 * build 2026-10-11 DL-2 — what act() decided for one call. `skip` = the tool does
 * NOT run: `result` is the model-facing answer, `settleAs` the row's state and
 * `carriedReceipt` the earlier attempt's receipt (the run's evidence for it).
 */
export type IntentActDecision =
  | 'skip_applied'          // an earlier attempt applied this exact call — its receipt answers
  | 'skip_reconciled'       // an earlier attempt was in flight; the ledger lookup found the effect
  | 'withheld'              // at-most-once, earlier outcome unknown — not resent
  | 'run_no_prior'          // nothing to reconcile (the common case — never recorded)
  | 'run_prior_not_applied' // the twin failed / was staged / was a replay — re-running is right
  | 'run_input_mismatch'    // defensive: a twin with a different input hash never skips
  | 'run_receipt_not_ok'    // the twin's receipt says it did not execute
  | 'run_precondition'      // git_push: the worktree HEAD is not the sha the earlier push carried
  | 'run_handler_lookup'    // the handler re-reads its own receipts / the PR (git_push, PRs, merges)
  | 'run_lookup_miss'       // the ledger lookup found no effect
  | 'run_no_lookup'         // no read-back exists for this tool — run as today
  | 'run_lookup_timeout'    // the journal lookup did not answer in time — run as today
  | 'run_off';              // act switched off / no handle / attempt-only scope

export interface IntentActOutcome {
  skip: boolean;
  decision: IntentActDecision;
  result?: string;
  settleAs?: IntentState;
  carriedReceipt?: ToolReceipt | null;
}

/** How long act() waits for the journal's insert + twin lookup before running the tool as today. */
export const INTENT_ACT_WAIT_MS = 2_000;

/** Lookup tools whose HANDLER already reads its own receipts back (run-idempotency.ts / the merge's "ALREADY merged"). */
const HANDLER_LOOKUP_TOOLS: ReadonlySet<string> = new Set(['git_push', 'open_pull_request', 'merge_pull_request']);
/** Lookup tools whose effect the delegation ledger records under the call's key (ToolContext.intentKey → delegation_tasks.idempotencyKey). */
export const LEDGER_LOOKUP_TOOLS: ReadonlySet<string> = new Set(['start_coding_session', 'send_chat_message', 'dispatch_platform_task']);
/** Where to verify an at-most-once side effect before retrying it (no read tool exists for these). */
const AT_MOST_ONCE_VERIFY: Readonly<Record<string, string>> = Object.freeze({
  notify_user: 'the user (a Telegram push has no read-back; notify_user itself refuses a near-duplicate of a push that already landed)',
  send_email_as_digby: 'the recipient (a sent email has no read-back here)',
  send_to_instance: "the paired instance's chat (no read tool reaches it from here)",
});

/**
 * Pure: the twin act should judge among an EARLIER attempt's rows for one key
 * (newest first). An APPLIED row wins — a later attempt that replayed or was
 * withheld must never hide the application (a third attempt would otherwise
 * re-run it); else the newest row.
 */
export function choosePriorIntent<T extends { state: string }>(rows: readonly T[] | null | undefined): T | null {
  if (!rows?.length) return null;
  return rows.find((r) => r.state === 'applied') ?? rows[0];
}

const iso = (d: unknown): string => {
  try { const t = new Date(d as any); return Number.isFinite(t.getTime()) ? t.toISOString() : String(d ?? ''); } catch { return String(d ?? ''); }
};

/** Pure: compact scalar receipt ids for the skip answer (≤ 300 chars). */
function receiptIdsLine(receipt: ToolReceipt | null | undefined): string {
  const ids = receipt?.ids && typeof receipt.ids === 'object' ? receipt.ids : null;
  if (!ids) return '';
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ids)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    keep[k] = v;
  }
  const j = JSON.stringify(keep);
  return j === '{}' ? '' : ` ids ${j.length > 300 ? `${j.slice(0, 297)}…` : j}.`;
}

/** Pure: the answer for a call whose earlier attempt already applied (DL-2). Starts with `[idempotent skip]` (a replay everywhere it is read). */
export function renderSkipApplied(tool: string, prior: PriorIntent, receipt: ToolReceipt | null | undefined): string {
  const at = iso(prior.completedAt ?? prior.createdAt);
  // Cite only a receipt row that was read back (an id the guard cannot resolve would read as a phantom).
  const rid = receipt?.id ?? null;
  const ref = rid ? `receipt ${rid}` : prior.receiptId ? 'its receipt could not be read back' : 'no receipt recorded';
  return `[idempotent skip] ${tool} already applied at ${at} — ${ref}; not re-run.` +
    `${receiptIdsLine(receipt)} An earlier attempt of this same turn made this exact call (same arguments) and it succeeded, so it was not executed again. ` +
    'Treat it as done and cite that receipt; a genuinely NEW call needs different arguments.';
}

/** Pure: the answer for an in-flight call the delegation ledger proves applied (DL-2). */
export function renderSkipReconciled(tool: string, prior: PriorIntent, task: { id: string; kind?: string | null; state?: string | null; childChatId?: string | null }): string {
  return `[idempotent skip] ${tool} already applied — an earlier attempt of this same turn (started ${iso(prior.createdAt)}) made this exact call and its delegation task ${task.id}` +
    `${task.childChatId ? ` (chat ${task.childChatId})` : ''} exists${task.state ? ` (state ${task.state})` : ''}; not re-run. Follow it with task_get ${task.id}.`;
}

/** Pure: the answer for an at-most-once call NOT resent (DL-2). */
export function renderWithheld(tool: string, prior: PriorIntent): string {
  const where = AT_MOST_ONCE_VERIFY[tool] ?? 'its recipient';
  return `[intent withheld] ${tool} NOT re-sent: an earlier attempt of this same turn made this exact call at ${iso(prior.createdAt)} and may already have applied it — its outcome is unknown and ${tool} cannot be undone. ` +
    `Verify with ${where} before retrying; only if it did not arrive, call ${tool} again (a repeat call in this run is sent).`;
}

export interface IntentJournal {
  readonly enabled: boolean;
  readonly attemptId: string;
  readonly scope: string;
  readonly scopeKind: IntentScopeKind;
  /** SYNCHRONOUS: the key + handle for a side-effecting call (null for every other tool / when off). */
  begin(tool: string, args: unknown, step: number): IntentHandle | null;
  /** Settle a begun call (fire-and-forget). `state` overrides the classification (DL-2: a skipped / withheld call). */
  finish(handle: IntentHandle | null, result: unknown, opts?: { receiptId?: string | null; failureShaped?: boolean; state?: IntentState }): void;
  /**
   * build 2026-10-11 DL-2 — ACT: decide whether a begun call RUNS. Awaits the
   * twin lookup (≤ INTENT_ACT_WAIT_MS) only when act is on and the scope can
   * have an earlier attempt. Never throws; every doubt runs the tool as today.
   */
  act(handle: IntentHandle | null, opts?: { worktree?: string | null; waitMs?: number }): Promise<IntentActOutcome>;
}

/** The DB seam (injected in tests). Every method may reject — the journal swallows it. */
export interface IntentJournalDeps {
  insert(row: {
    id: string; idemKey: string; scope: string; attemptId: string; chatId: string; runId: string | null;
    tool: string; inputHash: string; slot: string; step: number | null; reconcileClass: IntentReconcileClass;
  }): Promise<unknown>;
  findPrior(idemKey: string, attemptId: string): Promise<PriorIntent | null>;
  stampPrior(id: string, priorIntentId: string, verdict: WouldReconcile): Promise<unknown>;
  settle(id: string, patch: { state: IntentState; receiptId: string | null; completedAt: Date }): Promise<unknown>;
  metric(meta: Record<string, unknown>, sessionId: string, runId: string | null): void;
  now(): number;
  /** DL-2 act: the earlier attempt's receipt (run_tool_receipts by id), or null. */
  loadReceipt(id: string): Promise<ToolReceipt | null>;
  /** DL-2 act: the delegation task an earlier attempt's call created under this key, or null. */
  findTaskByKey(idemKey: string): Promise<{ id: string; kind?: string | null; state?: string | null; childChatId?: string | null } | null>;
  /** DL-2 act: the worktree's HEAD sha + branch (git_push's skip precondition). */
  headOf(worktree: string): Promise<{ sha: string | null; branch: string | null }>;
}

// Prisma access stays untyped on purpose: the delegate exists once the build
// runs `prisma generate` against the new model; a client without it (a test
// double) rejects and the journal swallows it.
const toolIntentDb = (): any => (prisma as any).toolIntent;

export const defaultIntentJournalDeps: IntentJournalDeps = {
  insert: (row) => toolIntentDb().create({ data: { ...row, state: 'pending' } }),
  // DL-2: an APPLIED twin wins over a later replay / withheld row (choosePriorIntent).
  findPrior: async (idemKey, attemptId) => choosePriorIntent<PriorIntent>(await toolIntentDb().findMany({
    where: { idemKey, attemptId: { not: attemptId } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, state: true, createdAt: true, receiptId: true, inputHash: true, completedAt: true },
  })),
  stampPrior: (id, priorIntentId, verdict) => toolIntentDb().update({ where: { id }, data: { priorIntentId, wouldReconcile: verdict } }),
  settle: (id, patch) => toolIntentDb().update({ where: { id }, data: patch }),
  metric: (meta, sessionId, runId) => recordLoopMetric({ kind: LOOP_METRIC_KINDS.TOOL_INTENT, sessionId, ...(runId ? { runId } : {}), meta }),
  now: () => Date.now(),
  loadReceipt: async (id) => {
    const { getRunReceiptById } = await import('./run-receipts.service');
    return getRunReceiptById(id);
  },
  findTaskByKey: (idemKey) => (prisma as any).delegationTask.findFirst({
    where: { idempotencyKey: idemKey },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, state: true, childChatId: true },
  }),
  headOf: async (worktree) => {
    const { git } = await import('./workspace.service');
    const sha = (await git(['rev-parse', 'HEAD'], worktree, 15_000)).stdout.trim() || null;
    const name = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree, 15_000).catch(() => ({ stdout: '' }))).stdout.trim();
    return { sha, branch: name && name !== 'HEAD' ? name : null };
  },
};

const NOOP_JOURNAL: Omit<IntentJournal, 'attemptId' | 'scope' | 'scopeKind'> = {
  enabled: false,
  begin: () => null,
  finish: () => undefined,
  act: async () => ({ skip: false, decision: 'run_off' }),
};

/**
 * One journal per agent-loop ATTEMPT (one runCodingAgent call). Workers share
 * it through the input spread (their calls are part of the same attempt).
 * Returns an inert journal when the switch is off or the session has no
 * durable chat (guests / chatless sends).
 */
export function createIntentJournal(o: {
  sessionId: string;
  runId?: string | null;
  anchor?: string | null;
  deps?: Partial<IntentJournalDeps>;
}): IntentJournal {
  const attemptId = randomUUID();
  const { scope, kind } = intentScopeFor({ sessionId: o.sessionId, runId: o.runId ?? null, anchor: o.anchor ?? null, attemptId });
  if (toolIntentJournalDisabled() || !journalSessionEligible(o.sessionId)) {
    return { ...NOOP_JOURNAL, attemptId, scope, scopeKind: kind };
  }
  const deps: IntentJournalDeps = { ...defaultIntentJournalDeps, ...(o.deps ?? {}) };
  const counts = new Map<string, number>();
  const runId = o.runId ?? null;
  const metric = (meta: Record<string, unknown>): void => {
    try { deps.metric({ scopeKind: kind, ...meta }, o.sessionId, runId); } catch { /* telemetry never breaks a dispatch */ }
  };

  const begin = (tool: string, args: unknown, step: number): IntentHandle | null => {
    try {
      if (!isIntentJournalTool(tool)) return null;
      const reconcileClass = INTENT_JOURNAL_TOOLS[tool];
      const inputHash = receiptInputHash(args ?? {});
      const stepKey = kind === 'run' && Number.isFinite(step) ? String(step) : '';
      const counterKey = `${tool}\n${inputHash}\n${stepKey}`;
      const n = counts.get(counterKey) ?? 0;
      counts.set(counterKey, n + 1);
      const slot = stepKey ? `${stepKey}:${n}` : String(n);
      const idemKey = intentIdemKey(scope, tool, inputHash, slot);
      const id = randomUUID();
      const issuedAt = deps.now();
      // The pending row is ISSUED here, synchronously, before the caller runs
      // the tool (a Prisma query starts when `.then` is called — chained at
      // once below); the caller never awaits it.
      let inserted: Promise<unknown>;
      try {
        const q: any = deps.insert({
          id, idemKey, scope, attemptId, chatId: o.sessionId, runId, tool, inputHash, slot,
          step: Number.isFinite(step) ? step : null, reconcileClass,
        });
        inserted = q && typeof q.then === 'function' ? Promise.resolve(q.then((v: unknown) => v)) : Promise.resolve(q);
      } catch (err) {
        inserted = Promise.reject(err);
      }
      const ready = inserted
        .then(() => (kind === 'attempt' ? null : deps.findPrior(idemKey, attemptId)))
        .then(async (prior) => {
          const verdict = wouldReconcileVerdict(prior, reconcileClass);
          if (prior && verdict) {
            await deps.stampPrior(id, prior.id, verdict).catch(() => undefined);
            metric({
              phase: 'would_reconcile', tool, verdict, priorState: prior.state, slot,
              priorAgeMs: Math.max(0, issuedAt - new Date(prior.createdAt).getTime()),
              idemKey: idemKey.slice(0, 12),
            });
          }
          return { priorState: prior?.state ?? null, verdict, prior: prior ?? null };
        })
        .catch(() => ({ priorState: null, verdict: null, prior: null }));
      return { id, idemKey, tool, args, slot, inputHash, reconcileClass, ready };
    } catch {
      return null;
    }
  };

  const finish = (handle: IntentHandle | null, result: unknown, fopts: { receiptId?: string | null; failureShaped?: boolean; state?: IntentState } = {}): void => {
    if (!handle) return;
    let state: IntentState;
    if (fopts.state) state = fopts.state;
    else {
      try { state = classifyIntentOutcome(handle.tool, handle.args, result, fopts.failureShaped === true); } catch { state = 'unknown'; }
    }
    void handle.ready
      .then(async ({ priorState, verdict }) => {
        await deps.settle(handle.id, { state, receiptId: fopts.receiptId ?? null, completedAt: new Date(deps.now()) }).catch(() => undefined);
        // The act bar: an already-APPLIED key applied again (what act's skip would have prevented).
        if (priorState === 'applied' && state === 'applied') {
          metric({ phase: 'executed_twice', tool: handle.tool, verdict, slot: handle.slot, idemKey: handle.idemKey.slice(0, 12) });
        }
      })
      .catch(() => undefined);
  };

  // ── ACT (build 2026-10-11 DL-2) — see the module header ────────────────────
  const act = async (handle: IntentHandle | null, aopts: { worktree?: string | null; waitMs?: number } = {}): Promise<IntentActOutcome> => {
    if (!handle || kind === 'attempt' || toolIntentActDisabled()) return { skip: false, decision: 'run_off' };
    const tool = handle.tool;
    const base: Record<string, unknown> = { phase: 'act', tool, slot: handle.slot, idemKey: handle.idemKey.slice(0, 12), intentId: handle.id };
    const run = (decision: IntentActDecision, extra: Record<string, unknown> = {}): IntentActOutcome => {
      metric({ ...base, decision, ...extra });
      return { skip: false, decision };
    };
    try {
      const TIMEOUT = Symbol('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        handle.ready,
        new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, aopts.waitMs ?? INTENT_ACT_WAIT_MS)); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (settled === TIMEOUT) return run('run_lookup_timeout');
      const prior = settled.prior ?? null;
      if (!prior) return { skip: false, decision: 'run_no_prior' };
      Object.assign(base, {
        priorIntentId: prior.id, priorState: prior.state,
        priorAgeMs: Math.max(0, deps.now() - new Date(prior.createdAt).getTime()),
      });
      if (prior.inputHash && prior.inputHash !== handle.inputHash) return run('run_input_mismatch');
      const verdict = settled.verdict;
      if (!verdict) return run('run_prior_not_applied');
      if (verdict === 'unknown_never_resend') {
        metric({ ...base, decision: 'withheld' });
        return { skip: true, decision: 'withheld', result: renderWithheld(tool, prior), settleAs: 'withheld' };
      }
      if (verdict === 'skip_applied') {
        // open_pull_request: the handler re-reads the PR's head against the checkout — more precise than a key match.
        if (tool === 'open_pull_request') return run('run_handler_lookup');
        const receipt = prior.receiptId ? await deps.loadReceipt(prior.receiptId).catch(() => null) : null;
        if (receipt && receipt.ok === false) return run('run_receipt_not_ok', { receiptId: receipt.id });
        if (tool === 'git_push') {
          // A push is state-bound: same args, but new commits since ⇒ a real push. Skip only at the SAME sha (+ branch).
          const sha = typeof receipt?.ids?.sha === 'string' ? receipt.ids.sha : '';
          const branch = typeof receipt?.ids?.branch === 'string' ? receipt.ids.branch : '';
          if (!sha || !aopts.worktree) return run('run_precondition', { why: !sha ? 'no_receipt_sha' : 'no_worktree' });
          const head = await deps.headOf(aopts.worktree).catch(() => null);
          if (!head?.sha) return run('run_precondition', { why: 'head_unreadable' });
          const shaMatch = head.sha === sha || (sha.length >= 7 && head.sha.startsWith(sha));
          if (!shaMatch || (branch && head.branch && head.branch !== branch)) return run('run_precondition', { why: 'head_moved' });
        }
        metric({ ...base, decision: 'skip_applied', receiptId: receipt?.id ?? prior.receiptId ?? null, receiptRead: !!receipt });
        return { skip: true, decision: 'skip_applied', result: renderSkipApplied(tool, prior, receipt), settleAs: 'replayed', carriedReceipt: receipt };
      }
      // reconcile_lookup — the earlier attempt was in flight when it died.
      if (HANDLER_LOOKUP_TOOLS.has(tool)) return run('run_handler_lookup');
      if (LEDGER_LOOKUP_TOOLS.has(tool)) {
        const task = await deps.findTaskByKey(handle.idemKey).catch(() => null);
        if (!task?.id) return run('run_lookup_miss');
        metric({ ...base, decision: 'skip_reconciled', taskId: task.id });
        return { skip: true, decision: 'skip_reconciled', result: renderSkipReconciled(tool, prior, task), settleAs: 'replayed' };
      }
      return run('run_no_lookup');
    } catch {
      return { skip: false, decision: 'run_no_prior' };
    }
  };

  return { enabled: true, attemptId, scope, scopeKind: kind, begin, finish, act };
}

export interface ToolIntentSummary {
  hours: number;
  total: number;
  byState: Record<string, number>;
  byVerdict: Record<string, number>;
  byTool: Record<string, number>;
  orphanPending: number;
}

/** Read path (admin view): the journal over the last `hours`. Never throws (zeros on any failure). */
export async function summarizeToolIntents(hours = 24): Promise<ToolIntentSummary> {
  const h = Math.min(24 * 30, Math.max(1, Number(hours) || 24));
  const out: ToolIntentSummary = { hours: h, total: 0, byState: {}, byVerdict: {}, byTool: {}, orphanPending: 0 };
  try {
    const since = new Date(Date.now() - h * 3_600_000);
    const states: Array<{ state: string; _count: { _all: number } }> = await toolIntentDb().groupBy({ by: ['state'], where: { createdAt: { gte: since } }, _count: { _all: true } });
    for (const s of states) { out.byState[s.state] = Number(s._count?._all ?? 0); out.total += out.byState[s.state]; }
    const verdicts: Array<{ wouldReconcile: string | null; _count: { _all: number } }> = await toolIntentDb().groupBy({
      by: ['wouldReconcile'], where: { createdAt: { gte: since }, wouldReconcile: { not: null } }, _count: { _all: true },
    });
    for (const v of verdicts) out.byVerdict[String(v.wouldReconcile)] = Number(v._count?._all ?? 0);
    const tools: Array<{ tool: string; _count: { _all: number } }> = await toolIntentDb().groupBy({ by: ['tool'], where: { createdAt: { gte: since } }, _count: { _all: true } });
    for (const t of tools) out.byTool[t.tool] = Number(t._count?._all ?? 0);
    out.orphanPending = await toolIntentDb().count({ where: { state: 'pending', createdAt: { gte: since, lt: new Date(Date.now() - 3_600_000) } } });
  } catch { /* zeros */ }
  return out;
}
