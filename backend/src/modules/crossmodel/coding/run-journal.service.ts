/**
 * Digby Code — RUN JOURNAL (cross-run memory).
 *
 * The gap this closes: nothing carried what previous RUNS did/decided/learned
 * into the next run — subagents spawned with zero run history and scheduled
 * runs fired cold. This is the minimal foundation: a durable, per-chat,
 * APPEND-ONLY journal — one row per TERMINAL coding run, distilled by a cheap
 * utility-LLM consolidation call at run finalize (never mid-run, so budget
 * pressure can't skip it), and injected budgeted at run start.
 *
 * Write path: writeRunJournalEntryAsync — fire-and-forget from
 * run-executor.ts's finalize seam; every failure is caught + logged, the
 * finalize path never waits on it and never fails because of it. A SECOND
 * writer serves the CHAT side (ticket 9993f30c, 2026-10-18):
 * writeSupervisorTurnEntryAsync — one deterministic, no-LLM, receipt-backed
 * row per SUPERVISOR turn (Fleet + project supervisors run through the
 * chat-agent pipeline, not the run-executor), fire-and-forget from
 * chat-agent.service.ts's finalize cluster next to the wake-ledger hook.
 * Read path:  getRecentJournalEntries + formatJournalBlock — called from
 * agent.ts's memory assembly (profile.workspaceTools gate), which the
 * orchestrator AND every delegated worker share (workers re-run agentLoop
 * with the parent's sessionId via the input spread, so they inherit the
 * same journal block). A SECOND reader serves supervisor chats (same
 * ticket): buildSupervisorJournalBlock — the last 10 entries under 4000
 * chars, injected at BOTH supervisor prompt seams (the machine-wake
 * supervisorStateBlock in startDetachedChatRun, and the non-machine-wake
 * systemContext in chat-context.ts's loadChatContextNode).
 *
 * High-signal policy: junk inputs (nothing meaningful said or done) and
 * machine/hook no-op runs write nothing — the journal stays worth reading.
 */

import prisma from '../../../config/database';
import { utilityChat } from '../../../utils/utility-llm';
import logger from '../../../utils/logger';
import { trackBackground } from '../../../utils/background-tasks';
// N3 (2026-09-25): decision-gate purpose `coding_memory_fold`, journal leg —
// shadow by default (label = whether a journal row was actually written);
// act skips the 45 s distillation when the gate is confident the run is not
// journal-worthy. See coding-memory-fold-gate.ts.
import { codingMemoryFoldGateWaitsFirst, consultCodingMemoryFoldGate, labelCodingMemoryFold } from './coding-memory-fold-gate';

/** The fields read at run start (filesTouched stays in the DB, out of the prompt block). */
export interface RunJournalEntryShape {
  id: string;
  runId: string | null;
  triggerKind: string;
  goal: string;
  outcome: string;
  keyDecisions: string[];
  failures: string[];
  /** P6 (v1#36): 1-2 lines of concrete metrics/state the run OBSERVED — captured
   *  even on no-action machine runs so the journal carries a metric trajectory
   *  instead of skipping idle firings entirely. Null on pre-P6 rows. */
  observations: string | null;
  tokensUsed: number | null;
  createdAt: Date;
}

/** Hard cap for the injected [PREVIOUS RUNS IN THIS CHAT] block. */
export const JOURNAL_BLOCK_CAP = 2400;
/** Default number of entries injected at run start. */
export const JOURNAL_ENTRIES_N = 6;
/** MACHINE/schedule-triggered runs' deeper journal slice (P6 — spark G4b): their
 *  raw wake/report history is dieted to 2 pairs (run-executor v1#35), so the
 *  journal carries their cross-run memory — 10 rows / 4,000 chars. */
export const MACHINE_JOURNAL_ENTRIES_N = 10;
export const MACHINE_JOURNAL_BLOCK_CAP = 4000;

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as T; } catch { return fallback; }
}

function asStringList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, maxItems).map(x => x.trim().slice(0, maxLen));
}

/**
 * True when a machine/hook run's distilled outcome says nothing happened —
 * those runs would only add noise (the fleet wakes chats constantly), so they
 * never reach the journal. A run with decisions/files/failures DID do
 * something even when its outcome reads like a no-op, so those still record.
 */
function outcomeIndicatesNoop(outcome: string): boolean {
  const t = outcome.trim();
  if (!t) return true;
  return /\b(nothing|no[\s-]?op|no changes|no action (was )?taken|did not (do|make|change)|didn'?t (do|make|change)|no work|nothing to (do|report)|idle|without (making )?(any )?changes)\b/i.test(t);
}

/**
 * Fire-and-forget: distill one terminal run into ONE append-only journal row.
 * NEVER throws — a journal failure must not touch the run's finalize path.
 */
export function writeRunJournalEntryAsync(input: {
  chatId: string;
  runId?: string;
  triggerKind: string;
  userMessage: string;
  assistantFinal: string;
  toolsUsed: string[];
  tokensUsed?: number;
}): void {
  // audit 2026-10-08 W3-1: tracked so a draining worker awaits it before exit.
  void trackBackground((async () => {
    try {
      const userMsg = (input.userMessage || '').trim();
      const final = (input.assistantFinal || '').trim();
      // Junk guard: nothing meaningful was asked or produced — no junk entries.
      if (userMsg.length + final.length < 20) return;

      // N3: the journal leg of the fold gate (one noul, journal_worthy). Shadow:
      // started here and never awaited (it rides alongside the distillation;
      // the label lands via the promise). Act: awaited first (≤ 3 s, background
      // path) so a confidently unworthy run can skip the distillation.
      // Fail-open — a null gate ⇒ the distillation runs exactly as before.
      // Acting keys on the RESULT's mode inside the gate module (E2).
      const gateP = consultCodingMemoryFoldGate({
        legs: ['journal'], userMessage: userMsg, assistantSummary: final, toolsUsed: input.toolsUsed,
        sessionId: input.chatId, trigger: input.triggerKind,
      });
      if (codingMemoryFoldGateWaitsFirst() && (await gateP).skip.journal) {
        labelCodingMemoryFold(gateP, 'journal', 'skipped', input.chatId, `trigger=${input.triggerKind}`);
        return;
      }
      /** N3 label: what the leg measurably did (set on every exit below). */
      let journalOutcome: 'changed' | 'noop' | 'failed' = 'failed';
      const labelJournal = () => labelCodingMemoryFold(gateP, 'journal', journalOutcome, input.chatId, `trigger=${input.triggerKind}`);

      const prompt = `You maintain the RUN JOURNAL of an AI coding chat: one compact factual entry per run, so FUTURE runs in this chat know what earlier runs did, decided, and learned.

Distill the run below into JSON using ONLY these inputs — never invent facts, paths, or decisions that are not stated or directly implied by them.

Trigger: ${input.triggerKind}

Goal/user message:
${userMsg.slice(0, 800) || '(machine-triggered run — no user message)'}

The run's final output:
${final.slice(0, 1500) || '(no final output)'}

Tools exercised: ${input.toolsUsed.join(', ') || 'none'}

Return ONLY valid JSON:
{"goal": "≤1 line — what the run set out to do", "outcome": "≤2 lines — what actually happened (completed / failed / partial + the concrete result)", "keyDecisions": ["0-4 decisions or approaches the run chose"], "filesTouched": ["0-8 file paths explicitly named in the inputs"], "failures": ["0-3 things that failed or remain broken"], "observations": "0-2 lines — concrete metrics/state the run OBSERVED (counts, statuses, queue depths, versions), even when it took no action; empty string when none"}
Empty arrays are fine. Keep every string under 160 characters. Observations must be facts stated in the inputs — never invented.`;
      const raw = await utilityChat([{ role: 'user', content: prompt }], {
        maxTokens: 500, temperature: 0.2, timeout: 45000, retryNotFound: true,
      });
      const parsed = parseJson<{
        goal?: unknown; outcome?: unknown; keyDecisions?: unknown; filesTouched?: unknown; failures?: unknown; observations?: unknown;
      }>(raw, {});
      const goal = (typeof parsed.goal === 'string' ? parsed.goal : '').trim().slice(0, 500);
      const outcome = (typeof parsed.outcome === 'string' ? parsed.outcome : '').trim().slice(0, 1000);
      const keyDecisions = asStringList(parsed.keyDecisions, 4, 200);
      const filesTouched = asStringList(parsed.filesTouched, 8, 200);
      const failures = asStringList(parsed.failures, 3, 300);
      const observations = (typeof parsed.observations === 'string' ? parsed.observations : '').trim().slice(0, 400);
      // Distillation produced nothing usable → no row (also covers the
      // utilityChat '' failure path without a wasted insert).
      if (!goal && !outcome) {
        // N3 label: an empty raw answer is the utility failure path (unknown);
        // a non-empty answer that distilled to nothing is a noop.
        journalOutcome = raw.trim() ? 'noop' : 'failed';
        labelJournal();
        return;
      }
      // Machine/hook no-op runs are noise — keep the journal high-signal.
      // P6 (v1#36): an idle run that OBSERVED something (metrics, statuses) is
      // no longer skipped — the observation IS the signal (metric trajectory
      // across idle firings used to be invisible).
      if ((input.triggerKind === 'machine' || input.triggerKind === 'hook')
        && outcomeIndicatesNoop(outcome) && !keyDecisions.length && !filesTouched.length && !failures.length
        && !observations) {
        journalOutcome = 'noop';
        labelJournal();
        return;
      }

      await prisma.runJournalEntry.create({
        data: {
          chatId: input.chatId,
          runId: input.runId ?? null,
          triggerKind: input.triggerKind,
          goal,
          outcome,
          keyDecisions,
          filesTouched,
          failures,
          observations: observations || null,
          tokensUsed: input.tokensUsed ?? null,
        },
      });
      journalOutcome = 'changed';
      labelJournal();
    } catch (err: any) {
      logger.warn(`run-journal: write for chat ${input.chatId} failed (non-fatal): ${err.message}`);
    }
  })(), 'run-journal');
}

/**
 * Fire-and-forget DETERMINISTIC journal row for an evidence-guard verdict
 * (two-lane hardening, 2026-08-22). No LLM involved: the guard's structured
 * verdict is written verbatim into a harness-owned row. Rationale: sessions
 * have been caught FORGING the guard's answer-text footer (tickets dcc51edb /
 * 675c3eb9) — the journal is the one completion record a model cannot write,
 * so watchers and future runs check THIS, not the answer text. NEVER throws.
 */
export function writeGuardVerdictEntryAsync(input: {
  chatId: string;
  runId?: string;
  triggerKind: string;
  unprovenKinds: string[];
  fabricatedPrs: number[];
  refutedMergePrs: number[];
  futureDated?: string[];
  /** Forgery layer: the final answer carried harness-only markers (imitated guard output). */
  forgedFooter?: boolean;
  /** Guard 2b: claimed push shas that do not exist on origin (GitHub commits 404). */
  fabricatedShas?: string[];
  /** Guard 4 (ticket 7cb26cb0): quoted "verbatim output" blocks no tool result of the run produced. */
  fabricatedQuotes?: string[];
  /** Guard 5 (ticket 8e9d6496): claimed GitHub Actions run ids the API 404s on. */
  fabricatedDeployRuns?: string[];
  /** Guard 5: deploy-run success/completion claims GitHub Actions contradicts. */
  refutedDeployRuns?: string[];
  /** Guard 6 (ticket 8e9d6496): cited feedback-ticket ids with no row in the store. */
  fabricatedTicketIds?: string[];
  /** Guard 7 (ticket 938dac2e): cited project-board todo ids with no project_todos row. */
  fabricatedTodoIds?: string[];
  /** Guard 7 (ticket 938dac2e): cited owner-question ids (oq_…) with no owner_questions row. */
  fabricatedOwnerQuestionIds?: string[];
  /** Guard 8 (ticket cae70bfa): cited schedule ids with no coding_schedules row. */
  fabricatedScheduleIds?: string[];
  /** Claims-block lane (audit #6): typed ```claims entries with NO matching receipt in the run. */
  unverifiedBlockClaims?: string[];
  /** Guard 2b, finding A1 (2026-09-27): commit_local ("banked/committed <sha>") shas not on origin — local only, not pushed. */
  localOnlyShas?: string[];
}): void {
  void (async () => {
    try {
      const failures: string[] = [];
      // GUARD 4 exhibits FIRST (review round-8 F3): failures is capped at 4
      // below, and in a maximal all-lanes verdict the quoted-output exhibits —
      // the most actionable evidence for the next run's re-verification — were
      // the ones dropped.
      if (input.fabricatedQuotes?.length) failures.push(`quoted "verbatim output" no tool result of the run produced: ${input.fabricatedQuotes.map((q) => q.slice(0, 60)).join('; ')}`);
      if (input.unprovenKinds.length) failures.push(`zero-evidence completion claims: ${input.unprovenKinds.join(', ')}`);
      if (input.fabricatedPrs.length) failures.push(`fabricated PR claims (GitHub 404): ${input.fabricatedPrs.map((n) => `#${n}`).join(', ')}`);
      if (input.refutedMergePrs.length) failures.push(`merge claims refuted by GitHub (PR not merged): ${input.refutedMergePrs.map((n) => `#${n}`).join(', ')}`);
      if (input.fabricatedDeployRuns?.length) failures.push(`fabricated deploy-run claims (no such GitHub Actions run): ${input.fabricatedDeployRuns.join(', ')}`);
      if (input.refutedDeployRuns?.length) failures.push(`deploy-completion claims refuted by GitHub Actions: ${input.refutedDeployRuns.join(', ')}`);
      if (input.fabricatedTicketIds?.length) failures.push(`fabricated feedback-ticket ids (no such ticket): ${input.fabricatedTicketIds.join(', ')}`);
      if (input.fabricatedTodoIds?.length) failures.push(`fabricated todo ids (no such board todo): ${input.fabricatedTodoIds.join(', ')}`);
      if (input.fabricatedOwnerQuestionIds?.length) failures.push(`fabricated owner-question ids (no such oq_ row): ${input.fabricatedOwnerQuestionIds.join(', ')}`);
      if (input.fabricatedScheduleIds?.length) failures.push(`fabricated schedule ids (no such coding_schedules row): ${input.fabricatedScheduleIds.join(', ')}`);
      if (input.unverifiedBlockClaims?.length) failures.push(`typed claims-block entries with no matching receipt: ${input.unverifiedBlockClaims.join(', ')}`);
      if (input.futureDated?.length) failures.push(`future-dated observation claims: ${input.futureDated.join('; ')}`);
      if (input.forgedFooter) failures.push("forged harness markers in the final answer — the model imitated the guard's own verification footer/replacement banner");
      if (input.fabricatedShas?.length) failures.push(`fabricated push claims (no such commit on origin): ${input.fabricatedShas.map((s) => s.slice(0, 12)).join(', ')}`);
      if (input.localOnlyShas?.length) failures.push(`commit not on origin — local only, not pushed (banked/committed sha with no push): ${input.localOnlyShas.map((s) => s.slice(0, 12)).join(', ')}`);
      if (!failures.length) return;
      await prisma.runJournalEntry.create({
        data: {
          chatId: input.chatId,
          runId: input.runId ?? null,
          triggerKind: input.triggerKind,
          goal: 'HARNESS EVIDENCE GUARD — deterministic verdict (harness-written; answer-text footers can be forged, this row cannot)',
          outcome: `This ${input.triggerKind} run's final answer asserted completions its tool log does not support. Treat those claims as NOT DONE until re-verified with fresh tool evidence.`,
          keyDecisions: [],
          filesTouched: [],
          failures: failures.slice(0, 4),
          tokensUsed: null,
        },
      });
    } catch (err: any) {
      logger.warn(`run-journal: guard-verdict write for chat ${input.chatId} failed (non-fatal): ${err.message}`);
    }
  })();
}

/**
 * Fire-and-forget DETERMINISTIC journal row for an attempts-exhausted give-up
 * (overnight forensics fix 4 — runs e5c355ee/367514ab died with error
 * 'attempts exhausted' and no recorded cause, losing 3–5 h of work with no
 * trail). Same lane as writeGuardVerdictEntryAsync: no LLM, harness-written,
 * NEVER throws — future runs in this chat see WHY the platform abandoned the
 * run, not just that it did.
 */
export function writeAttemptsExhaustedEntryAsync(input: {
  chatId: string;
  runId?: string;
  triggerKind: string;
  attempts: number;
  /** The recorded attempt-failure cause chain (agent_runs.error stash), if any. */
  cause?: string;
}): void {
  void (async () => {
    try {
      const cause = (input.cause || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      await prisma.runJournalEntry.create({
        data: {
          chatId: input.chatId,
          runId: input.runId ?? null,
          triggerKind: input.triggerKind,
          goal: 'HARNESS RUN FORENSICS — the platform abandoned this run after exhausting its claim attempts (harness-written)',
          outcome: `Run failed permanently after ${input.attempts} claim attempt(s): ${cause
            ? `last recorded attempt failure — ${cause}`
            : 'no attempt recorded a terminal error (each worker died without reaching a finalizer)'}. Whatever it was mid-way through is NOT done unless a later run re-verifies it.`,
          keyDecisions: [],
          filesTouched: [],
          failures: [cause || 'attempts exhausted with no recorded cause'],
          tokensUsed: null,
        },
      });
    } catch (err: any) {
      logger.warn(`run-journal: attempts-exhausted write for chat ${input.chatId} failed (non-fatal): ${err.message}`);
    }
  })();
}

/**
 * Fire-and-forget DETERMINISTIC journal row for a machine firing that finished
 * WITHOUT its schedule's required probe receipts (remediation P7, spark G13).
 * Same lane as writeGuardVerdictEntryAsync: no LLM, harness-written, NEVER
 * throws — the next runs in this chat see that this firing's monitoring
 * claims were unverified ("(required probe missing: X)").
 */
export function writeProbeMissEntryAsync(input: {
  chatId: string;
  runId?: string;
  triggerKind: string;
  /** The missing probe labels (tool name, optionally with its argPattern). */
  missing: string[];
}): void {
  void (async () => {
    try {
      const label = (input.missing ?? []).join(', ').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!label) return;
      await prisma.runJournalEntry.create({
        data: {
          chatId: input.chatId,
          runId: input.runId ?? null,
          triggerKind: input.triggerKind,
          goal: 'HARNESS PROBE GATE — this machine firing lacked its schedule\'s required probe receipts (harness-written)',
          outcome: `This ${input.triggerKind} run finished WITHOUT the tool receipts its schedule requires (required probe missing: ${label}). Whatever it claims to have monitored/checked this firing is UNVERIFIED — the next firing must actually run the probes and cite their receipts.`,
          keyDecisions: [],
          filesTouched: [],
          failures: [`required probe missing: ${label}`],
          tokensUsed: null,
        },
      });
    } catch (err: any) {
      logger.warn(`run-journal: probe-miss write for chat ${input.chatId} failed (non-fatal): ${err.message}`);
    }
  })();
}

/** Newest-first journal rows for one chat. Read failures degrade to no block. */
export async function getRecentJournalEntries(chatId: string, n = JOURNAL_ENTRIES_N): Promise<RunJournalEntryShape[]> {
  try {
    return await prisma.runJournalEntry.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: n,
      select: {
        id: true, runId: true, triggerKind: true, goal: true, outcome: true,
        keyDecisions: true, failures: true, observations: true, tokensUsed: true, createdAt: true,
      },
    });
  } catch { return []; }
}

// ── Sub-sessions (2026-09-02): journal inheritance at spawn ──────────────────

/** Parent entries distilled into a child's first prompt. */
export const PARENT_CONTEXT_ENTRIES_N = 4;
/** Hard cap for the whole [PARENT SESSION CONTEXT] block (it rides the child's
 *  FIRST user message, so it must stay compact). */
export const PARENT_CONTEXT_BLOCK_CAP = 1500;

// The digest header + its strict stripper live in the zero-import LEAF
// parent-context-block.ts (ticket 161d39e9) so consumers that whole-module
// mock this service (prisma/LLM-backed writers) still get the real parser.
import { PARENT_CONTEXT_BLOCK_HEADER, stripParentContextBlock } from './parent-context-block';
export { PARENT_CONTEXT_BLOCK_HEADER, stripParentContextBlock };

/**
 * Sub-session journal inheritance (READ-ONLY spawn helper): distill the
 * PARENT chat's newest run-journal entries into a compact
 * [PARENT SESSION CONTEXT] block the spawner prepends to the child's first
 * prompt — the child starts warm (what the parent just did/decided/learned)
 * instead of cold. '' when the parent has no journal. Budgeting mirrors
 * formatJournalBlock: oldest entries drop WHOLE first; a single oversized
 * newest entry is then hard-trimmed so the block NEVER exceeds `cap`. Read
 * failures degrade to '' (getRecentJournalEntries never throws) — inheritance
 * must never fail a spawn.
 */
export async function buildParentContextBlock(
  parentChatId: string,
  n = PARENT_CONTEXT_ENTRIES_N,
  cap = PARENT_CONTEXT_BLOCK_CAP,
): Promise<string> {
  const entries = await getRecentJournalEntries(parentChatId, n);
  if (!entries.length) return '';
  const header = PARENT_CONTEXT_BLOCK_HEADER;
  const blocks: string[] = [];
  let total = header.length;
  for (const e of entries) {
    const when = e.createdAt.toISOString().slice(0, 10);
    const lines = [
      `- ${when}: ${e.goal.replace(/\s+/g, ' ').trim()} → ${e.outcome.replace(/\s+/g, ' ').trim()}`,
    ];
    if (e.keyDecisions.length) lines.push(`  Decisions: ${e.keyDecisions.join('; ')}`);
    if (e.failures.length) lines.push(`  Failures: ${e.failures.join('; ')}`);
    const block = lines.join('\n');
    // Always keep at least the newest entry; drop older ones whole.
    if (blocks.length && total + 1 + block.length > cap) break;
    blocks.push(block);
    total += 1 + block.length;
  }
  let out = `${header}\n${blocks.join('\n')}`;
  if (out.length > cap) out = `${out.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
  return out;
}

// ── Supervisor run journal (ticket 9993f30c, 2026-10-18) ─────────────────────
//
// The Fleet/Project Supervisor chats run through the CHAT-AGENT pipeline, not
// the coding run-executor — so writeRunJournalEntryAsync's one production
// caller never fired for them and a supervisor had NO cross-run journal: its
// only memory was its (compacted) transcript, which is how a 2026-10-16 1:56 PM
// note came to cite todo ids that never existed (28f3984f, 10747b65, 98b362b6)
// with nothing to check them against. Two functions close that gap:
//
// 1. writeSupervisorTurnEntryAsync — ONE deterministic (no-LLM,
//    harness-written) journal row per SUPERVISOR turn, written at the
//    chat-agent finalize seam. The row carries the turn's RECEIPT IDS (the
//    ok run_tool_receipts uuids — receipt-backed, per the ticket) plus any
//    ticket/goal/todo/schedule ids the receipts' envelopes name, so the next
//    turn can check a cited id against what a real tool call returned.
//    Same failure posture as the other harness writers: fire-and-forget,
//    NEVER throws, a failed write never touches the finalize path.
// 2. buildSupervisorJournalBlock — the last SUPERVISOR_JOURNAL_ENTRIES_N
//    entries (default 10) formatted under SUPERVISOR_JOURNAL_BLOCK_CAP
//    (default 4000) chars, injected into every supervisor turn (machine-wake
//    state block AND the human-turn chat context) so the supervisor READS
//    its own history instead of recalling it.

/** Supervisor journal slice: the ticket's spec — last 10 entries, 4k chars. */
export const SUPERVISOR_JOURNAL_ENTRIES_N = 10;
export const SUPERVISOR_JOURNAL_BLOCK_CAP = 4000;

// ── Compact supervisor journal (MIND-HYGIENE, 2026-10-20) ────────────────────
// The 4-line-per-entry block fit only 2–3 of its 10 rows in 4,000 chars, and
// most of those rows were no-op wakes journaled in full ("WAKE: no-op …" with
// the whole sweep prompt as the goal) — the block spent its budget restating
// that nothing happened. The compact block renders ONE line per real row,
// folds no-op turns into a "+N no-op" mark on the next real row, scans a
// deeper slice so 10 REAL rows can surface, and the writer records the
// receipts' entity ids under keyDecisions (they were filed under `failures`,
// which read as if every id were a failure). Kill switch
// SUPERVISOR_JOURNAL_COMPACT_DISABLED=1 restores the multi-line block and the
// old row shape.
/** Rows scanned for the compact block — no-op rows fold away, so the slice is deeper than the 10 rendered. */
export const SUPERVISOR_JOURNAL_SCAN_N = 40;
/** keyDecisions prefix of the receipt-id line (stable — the compact reader parses it). */
export const SUPERVISOR_RECEIPT_IDS_PREFIX = 'receipt ids (verified tool calls):';
/** Prefix of the entity-id line (keyDecisions on compact rows; `failures` on legacy rows). */
export const SUPERVISOR_ENTITY_IDS_PREFIX = 'entity ids named by receipts (PR/sha/schedule/ticket/goal):';
/** Receipt ids rendered per compact line (the rest are counted; get_run_receipts reads them all). */
const COMPACT_RECEIPTS_SHOWN = 3;
/** Entity ids rendered per compact line. */
const COMPACT_ENTITY_IDS_SHOWN = 6;
/** The machine no-op close (supervisor.service SUPERVISOR_NOOP_NOTE_RE, mirrored — this module stays service-free). */
const SUPERVISOR_NOOP_CLOSE_RE = /\b(?:SWEEP|WAKE):\s*no-op\b/i;

export function supervisorJournalCompactDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SUPERVISOR_JOURNAL_COMPACT_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const splitIdList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The receipt ids and entity ids a supervisor journal row carries (compact AND legacy shapes). Pure. */
export function supervisorJournalIds(e: Pick<RunJournalEntryShape, 'keyDecisions' | 'failures'>): { receiptIds: string[]; entityIds: string[]; failures: string[] } {
  const receiptIds: string[] = [];
  const entityIds: string[] = [];
  const failures: string[] = [];
  for (const k of e.keyDecisions ?? []) {
    if (k.startsWith(SUPERVISOR_RECEIPT_IDS_PREFIX)) receiptIds.push(...splitIdList(k.slice(SUPERVISOR_RECEIPT_IDS_PREFIX.length)));
    else if (k.startsWith(SUPERVISOR_ENTITY_IDS_PREFIX)) entityIds.push(...splitIdList(k.slice(SUPERVISOR_ENTITY_IDS_PREFIX.length)));
  }
  for (const f of e.failures ?? []) {
    // Legacy rows (pre-compact writer) filed the entity ids under `failures`.
    if (f.startsWith(SUPERVISOR_ENTITY_IDS_PREFIX)) entityIds.push(...splitIdList(f.slice(SUPERVISOR_ENTITY_IDS_PREFIX.length)));
    else failures.push(f);
  }
  return { receiptIds, entityIds, failures };
}

/**
 * A supervisor TURN row that did nothing: written by
 * writeSupervisorTurnEntryAsync, no receipt-backed call, no entity id, and
 * the note is the machine no-op close (or there was no note at all). A failed
 * turn ("Turn finalized EMPTY/failed") is NOT a no-op — it stays visible.
 * Harness rows (guard verdicts, forensics) are never no-ops. Pure.
 */
export function isNoopSupervisorJournalRow(e: RunJournalEntryShape): boolean {
  if (!/^SUPERVISOR TURN\b/.test(e.goal || '')) return false;
  const ids = supervisorJournalIds(e);
  if (ids.receiptIds.length || ids.entityIds.length || ids.failures.length) return false;
  const outcome = (e.outcome || '').trim();
  return outcome === '(no final note)' || SUPERVISOR_NOOP_CLOSE_RE.test(outcome);
}

const clipLine = (s: string, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const journalWhen = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/**
 * The compact supervisor journal block (MIND-HYGIENE): newest first, ONE line
 * per real row — when · trigger · goal → outcome · receipts · ids · observed —
 * with every no-op turn folded into "+N no-op" on the real row that came
 * AFTER it (the chronologically next one; no-ops newer than every real row
 * get one leading line). At most `n` real rows, under `cap` chars (the newest
 * line always renders; older lines drop whole). '' when empty. Pure.
 */
export function formatSupervisorJournalCompact(
  entriesNewestFirst: RunJournalEntryShape[],
  n: number = SUPERVISOR_JOURNAL_ENTRIES_N,
  cap: number = SUPERVISOR_JOURNAL_BLOCK_CAP,
): string {
  if (!entriesNewestFirst.length) return '';
  let leading = 0;
  let leadingNewest: Date | null = null;
  const reals: Array<{ e: RunJournalEntryShape; noopsBefore: number }> = [];
  for (const e of entriesNewestFirst) {
    if (isNoopSupervisorJournalRow(e)) {
      if (!reals.length) {
        leading += 1;
        if (!leadingNewest) leadingNewest = e.createdAt;
      } else {
        // Newest-first: a no-op AFTER a real row in this list ran BEFORE it.
        reals[reals.length - 1].noopsBefore += 1;
      }
      continue;
    }
    reals.push({ e, noopsBefore: 0 });
  }
  const header = '[PREVIOUS SUPERVISOR TURNS IN THIS CHAT — your own run journal, harness-written: one line per turn, newest first; no-op turns are folded into "+N no-op"; the receipt ids back each line (get_run_receipts reads them all)]';
  const lines: string[] = [];
  let total = header.length;
  const push = (line: string): boolean => {
    if (lines.length && total + 1 + line.length > cap) return false;
    lines.push(line);
    total += 1 + line.length;
    return true;
  };
  if (leading) push(`- +${leading} no-op turn${leading === 1 ? '' : 's'} since the newest line below (latest ${journalWhen(leadingNewest as Date)})`);
  for (const { e, noopsBefore } of reals.slice(0, Math.max(1, n))) {
    const ids = supervisorJournalIds(e);
    const goal = clipLine((e.goal || '').replace(/^SUPERVISOR TURN\s*(?:—\s*)?/, ''), 120);
    const bits = [`- ${journalWhen(e.createdAt)} · ${e.triggerKind}${e.runId ? ` · run ${e.runId}` : ''} · ${goal || '(no text)'} → ${clipLine(e.outcome, 260)}`];
    if (ids.receiptIds.length) {
      const more = ids.receiptIds.length - COMPACT_RECEIPTS_SHOWN;
      bits.push(`receipts: ${ids.receiptIds.slice(0, COMPACT_RECEIPTS_SHOWN).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    }
    if (ids.entityIds.length) bits.push(`ids: ${ids.entityIds.slice(0, COMPACT_ENTITY_IDS_SHOWN).join(', ')}${ids.entityIds.length > COMPACT_ENTITY_IDS_SHOWN ? ', …' : ''}`);
    if (ids.failures.length) bits.push(`failures: ${clipLine(ids.failures.join('; '), 200)}`);
    if (e.observations) bits.push(clipLine(e.observations, 120));
    if (noopsBefore) bits.push(`+${noopsBefore} no-op turn${noopsBefore === 1 ? '' : 's'} before it`);
    if (!push(bits.join(' · '))) break;
  }
  return lines.length ? `${header}\n${lines.join('\n')}` : '';
}

/**
 * Receipt-id envelope keys whose values are ids worth re-citing next turn.
 * The supervisor's core planning tools (goal_create / todo_create /
 * goal_update / goal_premise_set / todo_update — run-receipts.ts) mint
 * goalId / todoId; the publish family mints sha / branch / prNumber; the
 * wake family mints scheduleId / chatId / sessionId / ticketId; staged
 * calls mint confirmationId. Review MAJOR (88d85d8e): dropping goalId /
 * todoId would structurally lose the EXACT id class this ticket exists for
 * (a cited todo id would never appear in the journal — the 1:56 PM phantom
 * todo ids again).
 */
const SUPERVISOR_RECEIPT_ID_KEYS = [
  'goalId', 'todoId', 'prNumber', 'sha', 'branch',
  'scheduleId', 'ticketId', 'chatId', 'sessionId', 'confirmationId',
] as const;

/**
 * Fire-and-forget DETERMINISTIC journal row for one SUPERVISOR chat turn
 * (ticket 9993f30c). No LLM — the harness writes what it measured: the turn's
 * trigger, its receipt ids (the anti-confabulation evidence channel), the
 * entity ids those receipts name, tool usage and a compact outcome excerpt.
 * NEVER throws; every failure is caught + logged.
 */
export function writeSupervisorTurnEntryAsync(input: {
  chatId: string;
  triggerKind: string;
  /** The turn's wake/user message head (compact — the goal half of the row). */
  message: string;
  /** The turn's final note head (the outcome half of the row). */
  finalNote: string;
  /** The run's harness tool receipts (result.receipts — ok AND staged rows). */
  receipts?: Array<{ id: string; ok: boolean; tool: string; ids?: Record<string, unknown> }>;
  toolsUsed?: string[];
  tokensUsed?: number;
  /** True when the orchestrator finalized empty (a failed/degraded turn). */
  failed?: boolean;
  killEnv?: NodeJS.ProcessEnv;
}): void {
  void trackBackground((async () => {
    try {
      const env = input.killEnv ?? process.env;
      if (env.SUPERVISOR_RUN_JOURNAL_DISABLED === '1') return;

      const message = (input.message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const note = (input.finalNote || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      const okReceipts = (input.receipts ?? []).filter((r) => r && typeof r.id === 'string' && r.ok !== false);
      const tools = Array.from(new Set([...(input.toolsUsed ?? []), ...okReceipts.map((r) => r.tool).filter((t): t is string => typeof t === 'string')])).slice(0, 12);

      // Receipt-backed ids: the ok receipts' FULL uuids (review M2, 88d85d8e —
      // the formatJournalBlock convention: "full run id, never a prefix; an
      // 8-char citation dead-ended any tool lookup the lane tried against
      // it") + the entity ids their envelopes name.
      const receiptIds = okReceipts.slice(0, 10).map((r) => r.id);
      const entityIds: string[] = [];
      for (const r of okReceipts) {
        if (!r.ids) continue;
        for (const key of SUPERVISOR_RECEIPT_ID_KEYS) {
          const v = r.ids[key];
          if (v === undefined || v === null || v === '') continue;
          const s = String(v).trim();
          if (s && !entityIds.includes(s)) entityIds.push(s);
        }
      }

      // A turn with no message, no note and no receipts journaled nothing.
      if (!message && !note && !okReceipts.length) return;

      const outcome = input.failed
        ? `Turn finalized EMPTY/failed (orchestrator produced no answer). ${okReceipts.length} receipt-backed tool call(s) still executed.`
        : note || '(no final note)';

      // MIND-HYGIENE (2026-10-20): the entity ids ride keyDecisions beside the
      // receipt ids — under `failures` every id read as a failure. Kill switch
      // SUPERVISOR_JOURNAL_COMPACT_DISABLED=1 restores the legacy row shape.
      const receiptLine = receiptIds.length ? [`${SUPERVISOR_RECEIPT_IDS_PREFIX} ${receiptIds.join(', ')}`] : [];
      const entityLine = entityIds.length ? [`${SUPERVISOR_ENTITY_IDS_PREFIX} ${entityIds.slice(0, 10).join(', ')}`] : [];
      const compactRow = !supervisorJournalCompactDisabled(env);

      await prisma.runJournalEntry.create({
        data: {
          chatId: input.chatId,
          runId: null, // chat-agent turns create no agent_runs row (the id below is the persisted assistant row)
          triggerKind: input.triggerKind,
          goal: message
            ? `SUPERVISOR TURN — ${message}`
            : `SUPERVISOR TURN (${input.triggerKind}-triggered; no user/wake text)`,
          outcome,
          keyDecisions: compactRow ? [...receiptLine, ...entityLine] : receiptLine,
          filesTouched: [],
          failures: compactRow ? [] : entityLine,
          observations: `tools: ${tools.join(', ') || 'none'}${input.tokensUsed != null ? ` · ${input.tokensUsed} tok` : ''}`,
          tokensUsed: input.tokensUsed ?? null,
        },
      });
    } catch (err: any) {
      logger.warn(`run-journal: supervisor-turn write for chat ${input.chatId} failed (non-fatal): ${err.message}`);
    }
  })(), 'run-journal-supervisor');
}

/**
 * Build the supervisor's own journal block (READ path, ticket 9993f30c): the
 * chat's last SUPERVISOR_JOURNAL_ENTRIES_N journal rows, newest first, capped
 * at SUPERVISOR_JOURNAL_BLOCK_CAP. '' when the chat has no journal — a
 * supervisor's first journaled turn sees no block. Read failures degrade to ''
 * (getRecentJournalEntries never throws).
 */
export async function buildSupervisorJournalBlock(
  chatId: string,
  n: number = SUPERVISOR_JOURNAL_ENTRIES_N,
  cap: number = SUPERVISOR_JOURNAL_BLOCK_CAP,
): Promise<string> {
  // MIND-HYGIENE: the compact block scans a deeper slice (no-op rows fold
  // away) and renders one line per real row; the switch restores the
  // multi-line block below byte-for-byte.
  if (!supervisorJournalCompactDisabled()) {
    return formatSupervisorJournalCompact(await getRecentJournalEntries(chatId, Math.max(n, SUPERVISOR_JOURNAL_SCAN_N)), n, cap);
  }
  const entries = await getRecentJournalEntries(chatId, n);
  if (!entries.length) return '';
  const header = '[PREVIOUS SUPERVISOR TURNS IN THIS CHAT — your own run journal, harness-written; what earlier turns did and the receipt ids that back them; newest first]';
  const blocks: string[] = [];
  let total = header.length;
  for (const e of entries) {
    const when = e.createdAt.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    const lines = [
      `- ${when} · trigger=${e.triggerKind}`,
      `  Goal: ${e.goal.replace(/\s+/g, ' ').trim()}`,
      `  Outcome: ${e.outcome.replace(/\s+/g, ' ').trim()}`,
    ];
    if (e.keyDecisions.length) lines.push(`  ${e.keyDecisions.join('; ')}`);
    if (e.failures.length) lines.push(`  ${e.failures.join('; ')}`);
    if (e.observations) lines.push(`  Observed: ${e.observations.replace(/\s+/g, ' ').trim()}`);
    const block = lines.join('\n');
    // Same budgeting as formatJournalBlock: always keep at least the newest
    // entry; drop older ones WHOLE (never truncate mid-entry).
    if (blocks.length && total + 1 + block.length > cap) break;
    blocks.push(block);
    total += 1 + block.length;
  }
  return `${header}\n${blocks.join('\n')}`;
}

/**
 * Format journal rows (newest-first) into the system-prompt block. '' when
 * empty. Whole block hard-capped at ~`cap` chars (default JOURNAL_BLOCK_CAP;
 * machine-triggered runs pass MACHINE_JOURNAL_BLOCK_CAP — P6 spark G4b): when
 * over, the OLDEST entries are dropped mid-list — an entry is never truncated
 * mid-entry.
 */
export function formatJournalBlock(entries: RunJournalEntryShape[], cap: number = JOURNAL_BLOCK_CAP): string {
  if (!entries.length) return '';
  const header = '[PREVIOUS RUNS IN THIS CHAT — what earlier runs set out to do, decided, and learned; newest first]';
  const blocks: string[] = [];
  let total = header.length;
  for (const e of entries) {
    const when = e.createdAt.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    const lines = [
      // Full run id (never a prefix): an 8-char citation dead-ended any tool
      // lookup the lane tried against it (nightly-lane postmortem 2026-08-27).
      `- ${when} · trigger=${e.triggerKind}${e.tokensUsed != null ? ` · ${e.tokensUsed} tok` : ''}${e.runId ? ` · run ${e.runId}` : ''}`,
      `  Goal: ${e.goal.replace(/\s+/g, ' ').trim()}`,
      `  Outcome: ${e.outcome.replace(/\s+/g, ' ').trim()}`,
    ];
    if (e.keyDecisions.length) lines.push(`  Decisions: ${e.keyDecisions.join('; ')}`);
    if (e.failures.length) lines.push(`  Failures: ${e.failures.join('; ')}`);
    if (e.observations) lines.push(`  Observed: ${e.observations.replace(/\s+/g, ' ').trim()}`);
    const block = lines.join('\n');
    // Cap: always keep at least the newest entry; drop older ones whole.
    if (blocks.length && total + 1 + block.length > cap) break;
    blocks.push(block);
    total += 1 + block.length;
  }
  return `${header}\n${blocks.join('\n')}`;
}
