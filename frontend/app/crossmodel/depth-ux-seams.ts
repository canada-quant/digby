/**
 * Depth UX seams — the view logic CodeSessionView used to hold inline, pulled
 * out as pure node-testable functions (audit finding sse-ui-restore-14,
 * 2026-09-26: the "wiring" suites were source-text pins, so four seam defects
 * rode through green CI). Each function is the ONE place the view reads for
 * that decision; the view stays a thin caller and the suites here exercise
 * the behaviour, not the source text.
 *
 *   · escalationRefusalPlan / applyEscalationRefusal — an `error` frame that
 *     carries a Dig-deeper refusal code (the controller refuses BEFORE any row
 *     persists: ESCALATION_BUSY / _NOT_FOUND / _NO_CHAT / _NO_QUESTION /
 *     _EXHAUSTED, _QUOTA / RATE_LIMIT_DEEP_RESEARCH, DIG_DEEPER_DISABLED, SIGNIN_DEEPER;
 *     DEPTH_BUDGET_EXCEEDED is a LEGACY code the server no longer emits since
 *     2026-09-27 — no cost cap — kept in the terminal list for tolerance)
 *     retracts the optimistic "Dig deeper" echo so countSpentEscalations no
 *     longer counts a rung that never ran (the chip came back as the NEXT rung
 *     or vanished); a terminal refusal also strips the parent's server chip so
 *     the control never re-offers a rung the server just refused.
 *   · pendingRowsToPoll — every young 'checking' row the revision poll can
 *     still observe (the newest REVISION_POLL_PAGE rows), not just the last
 *     assistant row; a pending row the poll can never see settles honestly.
 *   · chipAnchorId — the assistant row that carries the follow-up / Dig-deeper
 *     controls: the latest answer that is NOT a check addendum (a late
 *     correction footnote posted under a newer turn — late-crosscheck.ts
 *     `kind:'check_addendum'`). A "Deeper findings" row anchors itself: the
 *     server pins the original message's next-rung chip on it.
 *   · guestHydratedRow — the assistant row a reopened guest session hydrates
 *     from GET /session/:id/state, carrying the server's `signin_deeper` chip
 *     when the state returns one (the streaming tab showed it; the reload
 *     used to lose it).
 *   · composerRunAffordance — the composer's run chrome (Stop, the queue /
 *     steer submit variant, the "Stop ends it." note) keys on a LIVE
 *     CONNECTION in this tab, never on the bare running flag: a polled resume
 *     (guest-resume.ts, `source:'poll'`) has nothing to stop and nothing to
 *     queue behind (owner, prod 2026-09-27: the reopened guest chat showed the
 *     calm resume line AND the red Stop + "Digby is replying" footer).
 */

import type { CodingMessage, PlainMessageMeta } from '@/lib/api/coding';
import { parseChips, type DepthChip } from '@/lib/depth-ux';
import { REVISION_POLL_PAGE, markCheckInterrupted, plainRevisionPending } from './plain-session';

// ── 1. escalation refusal ────────────────────────────────────────────────────

/** The controller's refusal codes (crossmodel.controller.ts refuseEscalation +
 *  the ESCALATION_BUSY branch of queueBusyMessage). RETRYABLE: the same tap can
 *  succeed later — the chip comes back as it was. TERMINAL: the server will
 *  refuse the same rung again — the parent's chip is stripped. */
export const ESCALATION_REFUSAL_RETRYABLE = ['ESCALATION_BUSY', 'ESCALATION_NOT_FOUND', 'ESCALATION_NO_CHAT', 'ESCALATION_NO_QUESTION'] as const;
export const ESCALATION_REFUSAL_TERMINAL = ['ESCALATION_EXHAUSTED', 'ESCALATION_QUOTA', 'RATE_LIMIT_DEEP_RESEARCH', 'DEPTH_BUDGET_EXCEEDED', 'DIG_DEEPER_DISABLED', 'SIGNIN_DEEPER'] as const;

export type EscalationRefusalCode = (typeof ESCALATION_REFUSAL_RETRYABLE)[number] | (typeof ESCALATION_REFUSAL_TERMINAL)[number];

export interface EscalationRefusalPlan {
  code: EscalationRefusalCode;
  /** The optimistic "Dig deeper" echo is retracted (nothing persisted server-side). */
  removeEcho: true;
  /** True ⇒ the parent's server chip renders again exactly as before the tap;
   *  false ⇒ the parent's chips are stripped (the rung is not available). */
  restoreChip: boolean;
  /** The server's own sentence — shown as a calm message, never "Agent error:". */
  message: string;
}

/** Classify an `error` frame payload: a refusal plan for a Dig-deeper refusal
 *  code, null for every other error (the view keeps today's handling). */
export function escalationRefusalPlan(data: unknown): EscalationRefusalPlan | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const code = typeof d.code === 'string' ? d.code : '';
  const retryable = (ESCALATION_REFUSAL_RETRYABLE as readonly string[]).includes(code);
  const terminal = (ESCALATION_REFUSAL_TERMINAL as readonly string[]).includes(code);
  if (!retryable && !terminal) return null;
  const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim() : 'Dig deeper could not run this time.';
  return { code: code as EscalationRefusalCode, removeEcho: true, restoreChip: retryable, message };
}

export interface InFlightEscalation { echoId: string; escalationOf: string }

/** Apply a refusal to the transcript: drop the echo row; on a terminal refusal
 *  strip the parent's chips. Every other row keeps its identity (no churn). */
export function applyEscalationRefusal(rows: CodingMessage[], inflight: InFlightEscalation, plan: EscalationRefusalPlan): CodingMessage[] {
  let changed = false;
  const out: CodingMessage[] = [];
  for (const m of rows) {
    if (m.id === inflight.echoId && m.role === 'user' && m.plainMeta?.escalationOf === inflight.escalationOf) { changed = true; continue; }
    if (!plan.restoreChip && m.id === inflight.escalationOf && m.role === 'assistant' && m.plainMeta?.chips?.length) {
      const { chips: _chips, ...rest } = m.plainMeta;
      out.push({ ...m, plainMeta: rest });
      changed = true;
      continue;
    }
    out.push(m);
  }
  return changed ? out : rows;
}

// ── 2. pending rows to poll ──────────────────────────────────────────────────

export interface PendingRowsPlan {
  /** Young pending assistant rows the revision poll can observe — poll each (once per id). */
  poll: CodingMessage[];
  /** Pending rows outside the poll's page: nothing in this tab can update
   *  them, so the caller settles their pill to "Check didn't finish". */
  unreachable: CodingMessage[];
}

/**
 * Which rows of a transcript still await their check. The revision poll reads
 * the newest REVISION_POLL_PAGE rows of the chat (pollPlainRevision), so only
 * a pending row inside that window can ever settle from this tab. Rows outside
 * it are reported `unreachable`.
 */
export function pendingRowsToPoll(rows: CodingMessage[], opts: { pageSize?: number } = {}): PendingRowsPlan {
  const pageSize = opts.pageSize ?? REVISION_POLL_PAGE;
  const windowStart = Math.max(0, rows.length - pageSize);
  const poll: CodingMessage[] = [];
  const unreachable: CodingMessage[] = [];
  rows.forEach((m, i) => {
    if (m.role !== 'assistant' || !plainRevisionPending(m.plainMeta)) return;
    (i >= windowStart ? poll : unreachable).push(m);
  });
  return { poll, unreachable };
}

/** The rows with every `ids` member's check settled to interrupted (identity kept elsewhere). */
export function settleRowsInterrupted(rows: CodingMessage[], ids: Iterable<string>): CodingMessage[] {
  const set = new Set(ids);
  if (!set.size) return rows;
  let changed = false;
  const out = rows.map((m) => {
    if (!set.has(m.id) || !plainRevisionPending(m.plainMeta)) return m;
    changed = true;
    return { ...m, plainMeta: markCheckInterrupted(m.plainMeta) };
  });
  return changed ? out : rows;
}

// ── 3. chip anchor ───────────────────────────────────────────────────────────

/** late-crosscheck.ts CHECK_ADDENDUM_KIND — a correction footnote posted under a
 *  newer turn; it carries no chips and is not "the latest answer". */
export const CHECK_ADDENDUM_KIND = 'check_addendum';
/** chat-agent.service.ts DEEPER_FINDINGS_KIND — a Dig-deeper result row. It
 *  anchors itself: the server pins the original message's next-rung chip on it
 *  (or none, when the ladder is exhausted). */
export const DEEPER_FINDINGS_KIND = 'deeper_findings';

export function isCheckAddendumRow(m: Pick<CodingMessage, 'role' | 'plainMeta'>): boolean {
  return m.role === 'assistant' && m.plainMeta?.kind === CHECK_ADDENDUM_KIND;
}

/**
 * The id of the assistant row that carries the follow-up chips and the ONE
 * Dig-deeper control: the latest answer, skipping check addenda.
 */
export function chipAnchorId(history: ReadonlyArray<Pick<CodingMessage, 'id' | 'role' | 'plainMeta'>>): string | undefined {
  for (let k = history.length - 1; k >= 0; k--) {
    const m = history[k];
    if (m.role !== 'assistant') continue;
    if (isCheckAddendumRow(m)) continue;
    return m.id;
  }
  return undefined;
}

// ── 4. guest hydration ───────────────────────────────────────────────────────

/**
 * The assistant row a reopened guest session appends for an answer hydrated
 * from the session state. `chips` is whatever the state carried for that
 * message (the endpoint attaches the guest's sign-in affordance to its last
 * assistant message); malformed chips are dropped by parseChips.
 */
export function guestHydratedRow(content: string, chips?: unknown, opts: { id?: string; createdAt?: string } = {}): CodingMessage {
  const parsed: DepthChip[] = parseChips(chips);
  const plainMeta: PlainMessageMeta | undefined = parsed.length ? { chips: parsed } : undefined;
  return {
    id: opts.id ?? `a-${Date.now()}`,
    role: 'assistant',
    content,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(plainMeta ? { plainMeta } : {}),
  };
}

// ── 5. composer run affordance ───────────────────────────────────────────────

/** Where the view's `running` flag comes from. 'stream' (the default — every
 *  connectStream / attach path leaves it unset) = a live SSE stream is, or is
 *  being, attached in THIS tab. 'poll' = the run is known live somewhere but
 *  nothing is attached here (guest-resume.ts polls GET /session/:id/state):
 *  Stop has nothing to stop, and a send cannot ride the stream's busy-queue. */
export type LiveRunSource = 'stream' | 'poll';

export interface ComposerRunAffordanceInput {
  running: boolean;
  source?: LiveRunSource;
  plain: boolean;
  /** null for a chatless (guest) session — no server busy-queue exists, so a
   *  mid-run send is held (canSubmit false, "Wait for this answer…"). */
  chatId: string | null;
  /** Coding sessions only: the satellite session's status (ready / running /
   *  provisioning / error / archived). Undefined while no session is loaded. */
  sessionStatus?: string | null;
}

export interface ComposerRunAffordance {
  /** The streaming chrome — Stop button, queue / steer submit variant,
   *  "Stop ends it." — ONLY while a live stream is attached in this tab. */
  streaming: boolean;
  /** A run is live somewhere but nothing is attached here (a polled resume). */
  polled: boolean;
  /** The ONE status line under the pill (owner 2026-09-17), or null. */
  note: string | null;
}

/** Every footer sentence, one place, one voice (c1-convergence-smoke pins). */
export const RUN_NOTE = {
  plainStreaming: 'Digby is replying — your message queues and sends next. Stop ends it.',
  codeStreaming: 'Digby is working — your message steers this run live. Stop ends it.',
  /** Polled resume with a chat row: send() rides the server busy-queue. */
  polledQueue: 'Still working on this — you can keep typing; your message sends when it’s done.',
  /** Polled resume without a chat row (guest): the send is held until the answer lands. */
  polledWait: 'Still working on this — you can keep typing; send it once the answer lands.',
  codeAttaching: 'Run in progress — attaching… your message steers it.',
  codeError: 'Workspace setup hit an error — send a message to retry.',
  codeProvisioning: 'Setting up the workspace — you can type; it sends when ready.',
} as const;

/**
 * The composer's run chrome for one render. `streaming` is true only when a
 * live connection backs the running flag; a polled resume renders a neutral
 * hint and no Stop.
 */
export function composerRunAffordance(input: ComposerRunAffordanceInput): ComposerRunAffordance {
  const polled = input.running && input.source === 'poll';
  const streaming = input.running && !polled;
  let note: string | null = null;
  if (streaming) note = input.plain ? RUN_NOTE.plainStreaming : RUN_NOTE.codeStreaming;
  else if (polled) note = input.chatId ? RUN_NOTE.polledQueue : RUN_NOTE.polledWait;
  else if (!input.plain && input.sessionStatus && input.sessionStatus !== 'ready') {
    note = input.sessionStatus === 'running' ? RUN_NOTE.codeAttaching
      : input.sessionStatus === 'error' ? RUN_NOTE.codeError
      : RUN_NOTE.codeProvisioning;
  }
  return { streaming, polled, note };
}
