/**
 * Harness-rendered receipts (supervisor SOTA round 3, HARNESS-RECEIPTS-AND-CLAIMS,
 * 2026-10-20) — what each supervisor wake DID, stated from the harness record,
 * never from the model's own "ACTIONS TAKEN" text.
 *
 * WHY: the owner-facing record of what a supervisor did was model-typed. The
 * wake-close contract (core-doctrine coreWakeCloseContract) made the model
 * hand-copy each action's receipt id under an 'ACTIONS TAKEN' header; the
 * classifier (supervisor.service classifySupervisorNote) read that header with
 * a regex; and four receipt passes at the chat finalize then rewrote the ids
 * the model copied wrong after the fact (the follow-through grounding and the
 * receipt/tool TRIPLE check in chat-agent.service). Wrong-tool citations kept
 * rising (receipt_tool_mismatch 106 → 201 rows/day) while the true list of a
 * wake's actions already sat in the transcript (decision-outcome-labels
 * realActionToolNames — mutating platform calls minus housekeeping and
 * self-sends) and in the run's receipt collector.
 *
 * WHAT THIS LEAF DOES (pure, no I/O, never throws):
 *  - harnessReceiptsView — the wake's REAL mutating calls (the caller passes
 *    decision-outcome-labels isRealActionTool as `isAction`, so the vocabulary
 *    is that one list), paired with their tool results and receipts: executed
 *    vs staged / refused, the target id and the receipt id (8-char prefix).
 *    A send to the owner's Fleet Supervisor chat from a project supervisor is
 *    a REPORT-UP, kept apart (the doctrine's third close shape).
 *  - stripModelActionsBlock — removes a model-typed ACTIONS TAKEN block in the
 *    doctrine shape ONLY (the header, its same-line item, its contiguous
 *    bullet lines — or ONE item line under a bare header; never across a
 *    blank line, never a line carrying an owner cue) and any copy of a
 *    harness line the model typed itself (it reads earlier harness blocks in
 *    its own history; a copy is a forgery of the harness record).
 *  - applyHarnessReceipts — appends the harness block: 'ACTIONS TAKEN
 *    (harness):' with one line per executed call (tool → target · receipt
 *    id8), a report-up line, a not-executed line, or — with zero calls — the
 *    single 'WAKE: no-op (harness: 0 lane actions)' line (never when the
 *    note already carries a no-op marker, the 'WAKE: reported' shape, or is
 *    the answer to an owner ask: those get the neutral 'Harness record:' line).
 *  - harnessNoteKind / harnessLineKind — the classification the harness count
 *    implies (persisted as metadata.harnessActions); the attention watchdog,
 *    the supervisor_turn_noop facts and classifySupervisorNote prefer it over
 *    the marker regex.
 *  - stripHarnessNoopLines / isHarnessAppendixBlock / stripTrailingHarnessAppendix
 *    / harnessActionLineCount — the readers' views of a persisted note (the
 *    stuck-note backstop, the guard-chrome tail walk's transparency, the owner
 *    briefing, the project status card count).
 *  - stripTrailingNoopCloseLine / stripTrailingNoopCloseLineFromParts — the
 *    model's trailing 'WAKE: no-op …' close removed from an answer-first
 *    follow-through round (2026-10-22: the round finishes the owner's answer,
 *    never a wake), so it gets the neutral 'Harness record:' line; a close
 *    that carries a reason keeps the reason as plain text, a note that is
 *    only the close is never stripped (review fix 2026-10-22), harness
 *    trailers after it are skipped (isHarnessTrailerBlock).
 *
 * The model still writes WHAT MOVED and WHY; the harness writes the receipts.
 * Nothing here blocks, bounces or refuses a wake — it rewrites only the
 * model's own receipt block and appends the harness record (gate-flip
 * doctrine 2026-09-11: never a gate on a lane's own work).
 *
 * Kill switch SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1: no strip, no append, no
 * metadata, the classifiers read the markers only and the wake-close doctrine
 * is the model-typed contract byte-for-byte.
 *
 * Import discipline: only the import-free executed-actions leaf (its envelope
 * parser), so this module is unit-testable without config / prisma.
 */

import { parseResult } from './executed-actions';

// ── Identity ────────────────────────────────────────────────────────────────

/** The harness block header (a model-typed copy is stripped at finalize). Starts with 'ACTIONS TAKEN' so every marker reader still files the wake as an action. */
export const HARNESS_ACTIONS_HEADER = 'ACTIONS TAKEN (harness):';
/**
 * The zero-call close — matches the no-op marker regex (supervisor.service SUPERVISOR_NOOP_NOTE_RE).
 * Worded from the vocabulary actually counted (review fix 2026-10-20): "lane actions" = isRealActionTool
 * calls — mutating platform tools MINUS housekeeping (archive_chat, update_supervisor_state, remember_fact
 * …) — so a wake that only archived lanes never reads "0 mutating calls" under its own true prose.
 */
export const HARNESS_NOOP_LINE = 'WAKE: no-op (harness: 0 lane actions)';
/** Prefix of every harness no-op line (the variant names attempted-but-not-executed calls). */
export const HARNESS_NOOP_PREFIX = 'WAKE: no-op (harness:';
/** Prefix of the harness's reported close (a report-up was the wake's only executed send). Matches SUPERVISOR_REPORTED_NOTE_RE. */
export const HARNESS_REPORTED_PREFIX = 'WAKE: reported (harness:';
/** Prefix of the report-up line under a note that already carries the reported shape / beside lane actions. */
export const HARNESS_REPORT_UP_PREFIX = 'Reported up (harness):';
/** Prefix of the attempted-but-not-executed line (staged on a card / refused / failed). */
export const HARNESS_NOT_EXECUTED_PREFIX = 'Not executed (harness):';
/** The neutral zero-call line (owner-ask answers, a reported-shape note with no send): matches NO marker regex. */
export const HARNESS_RECORD_ZERO_LINE = 'Harness record: 0 lane actions this wake.';
/** Prefix of the neutral record line. */
export const HARNESS_RECORD_PREFIX = 'Harness record:';
/** Action lines rendered before the "+N more" tail. */
export const HARNESS_MAX_ACTION_LINES = 10;
/** Not-executed / report-up entries rendered per line. */
const MAX_INLINE_ENTRIES = 4;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1|true|on — the whole feature off (read per call). */
export function supervisorHarnessReceiptsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED);
}

/**
 * SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED=1|true|on (ticket 0c647003, 2026-10-24) — the
 * kill switch for the FORGED-CHROME STRIP on the OWNER turns of a supervisor chat.
 * Default OFF (the strip runs): an owner turn on a supervisor chat loses only the
 * harness-impersonating chrome it typed (stripForgedHarnessChrome — a '(harness)'
 * decorated block header with its items, and forged harness lines); NOTHING is ever
 * appended (the owner-answer-first / follow-through contracts pin the reply's bytes),
 * and the model's plain ACTIONS TAKEN self-report is kept (2026-10-20 pin).
 * =1 restores the pre-ticket owner-turn passthrough byte-for-byte (the machine-wake
 * seams keep SUPERVISOR_HARNESS_RECEIPTS_DISABLED). Read per call.
 */
export function supervisorOwnerTurnReceiptsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED);
}


// ── The harness record of a wake ────────────────────────────────────────────

export interface HarnessActionCall {
  tool: string;
  /** "chat 1a2b3c4d" / "todo 9c8d7e6f" / "PR #12" — null when neither args nor ids name one. */
  target: string | null;
  /** The harness receipt id, 8-char prefix — null when the tool mints none. */
  receiptId: string | null;
  executed: boolean;
  /** Parked on a confirmation card (not executed). */
  staged: boolean;
  /** A project supervisor's send to the owner's Fleet Supervisor chat. */
  reportUp: boolean;
}

export interface HarnessReceiptsView {
  /** Executed real actions (report-ups excluded). */
  actions: HarnessActionCall[];
  /** Executed report-ups. */
  reportUps: HarnessActionCall[];
  /** Real-action calls that did not execute (staged / refused / failed / never answered). */
  notExecuted: HarnessActionCall[];
}

export interface HarnessRunInput {
  /** The run's transcript parts (coding/agent.ts MessagePart log — tool_call {name,args} then tool_result {name,result}). */
  parts: unknown;
  /** The run's receipt collector (coding/run-receipts ToolReceipt[]). */
  receipts?: unknown;
  /** The run's own chat — a send_chat_message to it is a self-send, never an action. */
  sessionId?: string | null;
  /** The owner's Fleet Supervisor chat when this is a project supervisor (null ⇒ no report-up split). */
  reportUpTargetChatId?: string | null;
  /** THE action vocabulary — decision-outcome-labels isRealActionTool (mutating platform tools minus housekeeping). */
  isAction: (tool: string) => boolean;
}

interface ReceiptLike { id: string; tool: string; ok: boolean; ids: Record<string, unknown> }

/** Ordered (key, label) pairs a target is read from — the result's ids first, then the call's args. */
const TARGET_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['prNumber', 'PR'], ['sessionId', 'session'], ['chatId', 'chat'], ['scheduleId', 'schedule'],
  ['todoId', 'todo'], ['goalId', 'goal'], ['ticketId', 'ticket'], ['feedbackId', 'ticket'],
  ['questionId', 'question'], ['hookId', 'hook'], ['projectId', 'project'],
];
/** The id key that names a tool's own object — read before the generic order (a todo_create result also names its assignee chat). */
const PREFERRED_KEY: Readonly<Record<string, readonly [string, string]>> = {
  todo_create: ['todoId', 'todo'], todo_update: ['todoId', 'todo'],
  goal_create: ['goalId', 'goal'], goal_update: ['goalId', 'goal'], goal_premise_set: ['goalId', 'goal'],
  schedule_message: ['scheduleId', 'schedule'], update_schedule: ['scheduleId', 'schedule'], cancel_schedule: ['scheduleId', 'schedule'],
  pause_schedule: ['scheduleId', 'schedule'], resume_schedule: ['scheduleId', 'schedule'],
  file_feedback: ['ticketId', 'ticket'], update_feedback: ['ticketId', 'ticket'], triage_ticket: ['ticketId', 'ticket'],
  start_coding_session: ['sessionId', 'session'], send_chat_message: ['chatId', 'chat'], dispatch_platform_task: ['chatId', 'chat'],
  flag_owner_question: ['questionId', 'question'], hook_subscribe: ['hookId', 'hook'], hook_update: ['hookId', 'hook'], hook_unsubscribe: ['hookId', 'hook'],
};
/** Per-tool label for a bare `id` arg (todo_update {id}, goal_update {id}, update_schedule {id} …). */
const BARE_ID_LABEL: Readonly<Record<string, string>> = {
  todo_update: 'todo', goal_update: 'goal', goal_premise_set: 'goal', update_schedule: 'schedule', cancel_schedule: 'schedule',
  pause_schedule: 'schedule', resume_schedule: 'schedule', update_feedback: 'ticket', triage_ticket: 'ticket',
  hook_update: 'hook', hook_unsubscribe: 'hook', move_chat: 'chat', update_project: 'project',
};
/** Prose a non-envelope tool answers when it did NOT execute. */
const NOT_EXECUTED_PROSE_RE = /^(?:Tool \S+ failed:|Tool "\S+" exceeded \d+s and was aborted\.|Error\b|\[(?:TOOL )?ERROR|[a-z_]+ requires |[a-z_]+ takes .+ not both\.|Ambiguous \S+ id prefix )|\bis restricted to admin users\b/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An id rendered for a line: uuid / hex ⇒ 8-char prefix; anything else ⇒ a short sanitized token. */
function renderId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^[0-9a-f]{8}(?:-?[0-9a-f]{4}){0,4}/i.test(s)) return s.slice(0, 8);
  const clean = s.replace(/[^\w#.:/@-]+/g, '_').replace(/^_+|_+$/g, '');
  return clean ? clean.slice(0, 24) : null;
}

function targetOf(tool: string, ids: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const pref = PREFERRED_KEY[tool];
  if (pref) {
    for (const src of [ids, args]) {
      const id = renderId(src[pref[0]]);
      if (id) return `${pref[1]} ${id}`;
    }
    const bare = renderId(args.id);
    if (bare && BARE_ID_LABEL[tool]) return `${BARE_ID_LABEL[tool]} ${bare}`;
  }
  for (const src of [ids, args]) {
    for (const [key, label] of TARGET_KEYS) {
      const id = renderId(src[key]);
      if (!id) continue;
      return label === 'PR' ? `PR #${id.replace(/^#/, '')}` : `${label} ${id}`;
    }
  }
  const bare = renderId(args.id);
  return bare && BARE_ID_LABEL[tool] ? `${BARE_ID_LABEL[tool]} ${bare}` : null;
}

function receiptsOf(receipts: unknown): ReceiptLike[] {
  if (!Array.isArray(receipts)) return [];
  const out: ReceiptLike[] = [];
  for (const r of receipts) {
    if (!isObj(r) || typeof r.tool !== 'string') continue;
    out.push({ id: String(r.id ?? ''), tool: r.tool, ok: r.ok === true, ids: isObj(r.ids) ? r.ids : {} });
  }
  return out;
}

/**
 * The wake's real mutating calls, from the transcript + receipts. Each call is
 * paired with the next tool_result of the same name (the agent loop records
 * parts in call order) and with its receipt (the envelope's receiptId when the
 * result carries one, else the next unused receipt of the same tool). Pure;
 * never throws (an unreadable input ⇒ an empty view).
 */
export function harnessReceiptsView(input: HarnessRunInput): HarnessReceiptsView {
  const view: HarnessReceiptsView = { actions: [], reportUps: [], notExecuted: [] };
  try {
    if (!Array.isArray(input.parts)) return view;
    const calls: Array<{ tool: string; args: Record<string, unknown>; result: string | null; self: boolean; reportUp: boolean }> = [];
    const pending = new Map<string, number[]>();
    for (const p of input.parts as unknown[]) {
      if (!isObj(p) || typeof p.name !== 'string' || !p.name) continue;
      if (p.type === 'tool_call' && input.isAction(p.name)) {
        const args = isObj(p.args) ? p.args : {};
        const to = p.name === 'send_chat_message' ? String(args.chatId ?? '') : '';
        const idx = calls.push({
          tool: p.name, args, result: null,
          self: !!to && !!input.sessionId && to === input.sessionId,
          reportUp: !!to && !!input.reportUpTargetChatId && to === input.reportUpTargetChatId,
        }) - 1;
        const q = pending.get(p.name) ?? [];
        q.push(idx);
        pending.set(p.name, q);
      } else if (p.type === 'tool_result') {
        const q = pending.get(p.name);
        if (q?.length) calls[q.shift() as number].result = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '');
      }
    }
    const receipts = receiptsOf(input.receipts);
    const used = new Set<number>();
    const takeReceipt = (tool: string, envelopeId: string | null): ReceiptLike | null => {
      if (envelopeId) {
        const i = receipts.findIndex((r, k) => !used.has(k) && r.id && (r.id === envelopeId || r.id.startsWith(envelopeId) || envelopeId.startsWith(r.id)));
        if (i >= 0) { used.add(i); return receipts[i]; }
        return null;
      }
      const i = receipts.findIndex((r, k) => !used.has(k) && r.tool === tool);
      if (i >= 0) { used.add(i); return receipts[i]; }
      return null;
    };
    for (const c of calls) {
      const text = (c.result ?? '').trim();
      // The platform envelope ({ok, ids, receiptId} / {needsConfirmation}) is the call's own verdict; a JSON
      // payload without a boolean ok is not an envelope (an {error} body is a refusal); a truncated display
      // result fails the parse and falls back to the receipt.
      let envelope: { ok: boolean; staged: boolean; ids: Record<string, string> } | null = null;
      let jsonRefusal = false;
      // A goal_update whose only field was a refused ranking write (rankingApplied:false + changed:false —
      // goals.service updateGoal, interaction fix 2026-10-20) changed nothing: not executed, whatever the receipt.
      let rankingNoop = false;
      if (text.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isObj(parsed) && (typeof parsed.ok === 'boolean' || parsed.needsConfirmation === true)) envelope = parseResult(c.tool, text);
          else if (isObj(parsed) && parsed.error !== undefined) jsonRefusal = true;
          else if (c.tool === 'goal_update' && isObj(parsed) && parsed.rankingApplied === false && parsed.changed === false) rankingNoop = true;
        } catch { envelope = null; }
      }
      const receipt = takeReceipt(c.tool, envelope?.ids.receiptId ?? null);
      if (c.self) continue; // a self-send is never an action (realActionToolNames parity)
      let executed: boolean;
      let staged = false;
      if (envelope) { executed = envelope.ok; staged = envelope.staged; }
      else if (receipt) { executed = receipt.ok; staged = receipt.ids.staged === true; }
      else if (c.result === null) executed = false; // the call never answered
      else executed = !jsonRefusal && !NOT_EXECUTED_PROSE_RE.test(text);
      if (receipt && receipt.ids.staged === true) { executed = false; staged = true; }
      if (rankingNoop) executed = false;
      const ids: Record<string, unknown> = { ...(receipt?.ids ?? {}), ...(envelope?.ids ?? {}) };
      const receiptId = renderId(envelope?.ids.receiptId) ?? (receipt?.id ? renderId(receipt.id) : null);
      const call: HarnessActionCall = { tool: c.tool, target: targetOf(c.tool, ids, c.args), receiptId, executed, staged, reportUp: c.reportUp };
      if (!executed) view.notExecuted.push(call);
      else if (c.reportUp) view.reportUps.push(call);
      else view.actions.push(call);
    }
  } catch { /* the record is best-effort — an empty view never blocks a wake */ }
  return view;
}

// ── Stripping the model-typed block ─────────────────────────────────────────

/** 'ACTIONS TAKEN' (the doctrine literal, upper case) opening a line — plain, bold or as a heading; never
 *  "ACTIONS TAKEN BY / FOR / ON / IN …" (a report of someone else's actions). */
const UPPER_HEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*ACTIONS?[ \t]+TAKEN\b(?![ \t]+(?:BY|FOR|ON|IN)\b)/;
/** A DECORATED 'Actions taken' header in any case — a heading or a bold label standing ALONE on its line, with
 *  at most a count / '(harness)' (a labelled "**Actions taken by the CanLaw lane:**" reports a lane — never matched). */
const DECORATED_HEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+|\*\*|__)[ \t]*Actions?[ \t]+taken[ \t]*(?:\([ \t]*(?:\d+|harness)[ \t]*\))?[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i;
/** A plain 'Actions taken:' label line (nothing after the colon). */
const LABEL_HEADER_RE = /^[ \t]*Actions?[ \t]+taken[ \t]*(?:\([^)\n]*\))?[ \t]*:[ \t]*$/i;
/** The receipt-count paraphrase on a line of its own ('**Actions (2, with receipts):**'). */
const COUNT_HEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*Actions[ \t]*\([ \t]*\d+[^)\n]*\)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i;
/** A bullet / numbered item line. */
const BULLET_RE = /^[ \t]*(?:[-*•+]|\d+[.)])[ \t]+\S/;
/** Lines that end a block: a close marker, a Receipts line, a heading, a bold label. */
const STOP_RE = /^[ \t]*(?:(?:\*\*|__)?(?:SWEEP|WAKE):|(?:\*\*|__)?Receipts?\b|#{1,6}[ \t]|(?:\*\*|__)[^*_\n]+(?:\*\*|__)[ \t]*:?[ \t]*$)/i;
/** A harness-only line the model copied (forged) — stripped wherever it stands ('mutating call' kept for notes persisted before the 2026-10-20 rewording). */
const FORGED_HARNESS_LINE_RE = /^[ \t]*(?:[-*•][ \t]+)?(?:\*\*|__)?[ \t]*(?:WAKE:[ \t]*no-op[ \t]*\(harness:|WAKE:[ \t]*reported[ \t]*\(harness:|Reported up \(harness\):|Not executed \(harness\):|Harness record:[ \t]*\d+ (?:mutating call|lane action))/i;
/**
 * An owner-facing line (review fix 2026-10-20 — fail toward delivery): one is
 * NEVER part of a stripped block, and it ends the block. The model's block can
 * sit right above an escalation ("OWNER QUESTION: approve the move?", "Needs
 * you: approve spend …") — losing that line loses the owner's question. A line
 * is owner-facing when it OPENS (after any bullet / bold) with an owner cue
 * (owner, needs you, question, approve / approval, decision, decide, blocking,
 * action required), asks for the owner anywhere ("needs your", "awaiting
 * your", "your yes / approval / decision / call / go-ahead / sign-off /
 * wording / input / answer") or asks a question ('?'). An action line that
 * merely NAMES the owner ("- answered owner (receipt …)") is still the
 * model's receipt line — it goes with the block.
 */
const OWNER_CUE_RE = /^[ \t]*(?:(?:[-*•+]|\d+[.)])[ \t]+)?(?:\*\*|__)?[ \t]*(?:owner\b|needs?[ \t]+(?:you|your)\b|questions?\b|approv|decisions?\b|decide\b|blocking\b|action[ \t]+required\b)|\b(?:needs?|awaiting|waiting[ \t]+(?:on|for))[ \t]+(?:you|your)\b|\byour[ \t]+(?:yes|approval|decision|call|go-ahead|sign-off|wording|input|answer)\b|\?/i;
/** The decoration a BARE header may carry after its words (a count / '(harness)' / '(last 24h)', a bold close, a colon or dash). */
const BARE_HEADER_TAIL_RE = /^[ \t]*(?:\([^)\n]*\))?[ \t]*(?:\*\*|__)?[ \t]*[:—–-]?[ \t]*(?:\*\*|__)?[ \t]*$/;
/** An indented continuation of the bullet above it (wrapped item text). */
const CONTINUATION_RE = /^(?: {2,}|\t)[ \t]*\S/;

function isHeaderLine(line: string): boolean {
  return UPPER_HEADER_RE.test(line) || DECORATED_HEADER_RE.test(line) || LABEL_HEADER_RE.test(line) || COUNT_HEADER_RE.test(line);
}

/** A header with NO same-line item ('ACTIONS TAKEN' / '**ACTIONS TAKEN (2):**' / 'Actions taken:'). Pure. */
function isBareHeaderLine(line: string): boolean {
  if (DECORATED_HEADER_RE.test(line) || LABEL_HEADER_RE.test(line) || COUNT_HEADER_RE.test(line)) return true;
  const m = line.match(UPPER_HEADER_RE);
  return !!m && BARE_HEADER_TAIL_RE.test(line.slice((m.index ?? 0) + m[0].length));
}

/**
 * Remove every model-typed ACTIONS TAKEN block and every copied harness line.
 * The block is the doctrine shape ONLY (review fix 2026-10-20 — the first cut
 * ate owner-facing lines beside it): the header line (with any same-line
 * item), then its CONTIGUOUS bullet lines (an indented continuation of a
 * bullet rides with it) — or, under a BARE header, at most ONE un-bulleted
 * item line. The block never continues across a blank line (one exception:
 * the blank the markdown repair puts between a BARE header and its first
 * bullet); it ends at a close marker / Receipts line / heading / bold label /
 * another header, and at (never taking) an owner-facing line (OWNER_CUE_RE);
 * a header line that is itself owner-facing is no block at all (kept, with
 * everything under it).
 * Blockquoted lines ('> …', the guard wrappers' audit quotes) are never
 * touched. Returns the text unchanged (same string) when nothing matched.
 * Pure.
 */
export function stripModelActionsBlock(text: string): { text: string; strippedLines: number; forgedLines: number } {
  const src = String(text ?? '');
  if (!src) return { text: src, strippedLines: 0, forgedLines: 0 };
  const lines = src.split('\n');
  const keep: string[] = [];
  let stripped = 0;
  let forged = 0; // of `stripped`: model-typed copies of the harness's own lines (not an ACTIONS TAKEN block)
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FORGED_HARNESS_LINE_RE.test(line)) { stripped += 1; forged += 1; i += 1; continue; }
    if (!isHeaderLine(line) || OWNER_CUE_RE.test(line)) { keep.push(line); i += 1; continue; }
    const bare = isBareHeaderLine(line);
    stripped += 1;
    i += 1;
    let bullets = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // The ONE gap allowed: blank line(s) directly under a BARE header, before its first item, when a bullet
        // follows — the shape the markdown repair gives the doctrine block (normalizeAssistantMarkdown inserts
        // a blank before a list). Never between items, never before an un-bulleted line.
        if (bare && bullets === 0) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          const next = j < lines.length ? lines[j] : '';
          if (next && BULLET_RE.test(next) && !STOP_RE.test(next) && !isHeaderLine(next) && !OWNER_CUE_RE.test(next)) { stripped += j - i; i = j; continue; }
        }
        break; // otherwise never across a blank line
      }
      if (STOP_RE.test(l) || isHeaderLine(l) || OWNER_CUE_RE.test(l)) break;
      if (BULLET_RE.test(l)) { bullets += 1; stripped += 1; i += 1; continue; }
      if (bullets > 0 && CONTINUATION_RE.test(l)) { stripped += 1; i += 1; continue; }
      // ONE un-bulleted item line directly under a BARE header — then the block ends.
      if (bare && bullets === 0) { stripped += 1; i += 1; }
      break;
    }
  }
  if (!stripped) return { text: src, strippedLines: 0, forgedLines: 0 };
  const out = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  return { text: out, strippedLines: stripped, forgedLines: forged };
}

/** stripModelActionsBlock over a run's MODEL text parts (guard-marker / struck parts untouched). Same array when nothing changed. Pure. */
export function stripModelActionsBlockFromParts<T>(parts: T[]): { parts: T[]; strippedLines: number } {
  if (!Array.isArray(parts)) return { parts, strippedLines: 0 };
  let total = 0;
  const out = parts.map((p) => {
    const q = p as unknown as Record<string, unknown>;
    if (!isObj(q) || q.type !== 'text' || typeof q.text !== 'string' || q.marker === 'guard' || q.struck === true) return p;
    const s = stripModelActionsBlock(q.text);
    if (!s.strippedLines) return p;
    total += s.strippedLines;
    return { ...q, text: s.text } as unknown as T;
  });
  return total ? { parts: out, strippedLines: total } : { parts, strippedLines: 0 };
}

/**
 * Ticket 0c647003 (2026-10-24) — strip FORGED HARNESS CHROME ONLY, from a supervisor
 * chat's OWNER-turn reply. Narrower than stripModelActionsBlock by design: that leaf
 * (the machine-wake phase 1) removes the model's whole ACTIONS TAKEN self-report and
 * phase 2 re-appends the truthful harness record; an owner-turn reply must be
 * rewritten as little as possible (the owner-answer-first / follow-through contracts
 * pin its bytes), so this leaf removes ONLY what the model can never legitimately
 * type — the harness's own chrome: (a) a header line that carries the '(harness)'
 * decoration ('ACTIONS TAKEN (harness):' / '**Actions taken (harness):**' — the
 * harness's own header shape) with its contiguous block, walked with exactly
 * stripModelActionsBlock's rules (bullets, continuations, the one bare-header item,
 * never across a blank line, never an owner-facing line), and (b) a forged harness
 * line wherever it stands (FORGED_HARNESS_LINE_RE — 'Reported up (harness): ...',
 * 'Harness record: N lane actions ...', the harness's 'WAKE: no-op (harness:' close).
 * The model's PLAIN 'ACTIONS TAKEN' self-report (no decoration) is KEPT — a human
 * turn on a supervisor chat keeps it by the 2026-10-20 pin, and an owner-turn reply
 * may honestly report its own work in its own words. Nothing is ever appended.
 * Returns strippedLines=0 (same string) when the reply carries no forged chrome. Pure.
 */
const HARNESS_DECORATION_RE = /\(\s*harness\s*\)/i;

/** A header line (any of the four header shapes) whose OWN line carries the '(harness)' decoration. */
function isHarnessDecoratedHeaderLine(line: string): boolean {
  return isHeaderLine(line) && !OWNER_CUE_RE.test(line) && HARNESS_DECORATION_RE.test(line);
}

export function stripForgedHarnessChrome(text: string): { text: string; strippedLines: number; blockLines: number; forgedLines: number } {
  const src = String(text ?? '');
  if (!src) return { text: src, strippedLines: 0, blockLines: 0, forgedLines: 0 };
  const lines = src.split('\n');
  const keep: string[] = [];
  let stripped = 0;
  let blocks = 0;
  let forged = 0;
  // Review fix 4 (ticket 0c647003): quotation / code-fence guards — the reply is the MODEL's own
  // text, and a supervisor answering the owner ABOUT the harness legitimately QUOTES its lines
  // ('The previous wake recorded:\nWAKE: no-op (harness: 0 lane actions)' as a teaching example,
  // or a fenced sample). Fenced lines (``` / ~~~) and block-quoted lines ('> …') are never
  // stripped by this leaf, and a forged-looking standalone line directly under a line that
  // ANNOUNCES a quotation (a colon-terminated sentence ending in a quote-cue verb: 'recorded',
  // 'said', 'wrote', 'logged', 'closed', 'echoed', 'printed') is the quote's body — kept.
  // Mid-line quoting is already safe (FORGED_HARNESS_LINE_RE is line-anchored). The incident's
  // notes carry none of these shapes (the chrome stands undecorated by quotes or fences).
  const fenceAt: boolean[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(l)) inFence = !inFence;
    fenceAt.push(inFence);
  }
  const isQuotedLine = (l: string) => /^\s*>/.test(l);
  const announcesQuote = (prev: string | undefined) =>
    !!prev && /(?:recorded|said|wrote|logged|closed|echoed|printed|noted)\s*[:\"'']?\s*$/.test(prev.replace(/\*\*|__/g, ''));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenceAt[i] || isQuotedLine(line)) { keep.push(line); i += 1; continue; }
    if (FORGED_HARNESS_LINE_RE.test(line)) {
      if (announcesQuote(keep[keep.length - 1])) { keep.push(line); i += 1; continue; }
      stripped += 1; forged += 1; i += 1; continue;
    }
    if (!isHarnessDecoratedHeaderLine(line)) { keep.push(line); i += 1; continue; }
    const bare = isBareHeaderLine(line);
    stripped += 1;
    blocks += 1;
    i += 1;
    let bullets = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        if (bare && bullets === 0) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          const next = j < lines.length ? lines[j] : '';
          if (next && BULLET_RE.test(next) && !STOP_RE.test(next) && !isHeaderLine(next) && !OWNER_CUE_RE.test(next)) { stripped += j - i; i = j; continue; }
        }
        break;
      }
      if (STOP_RE.test(l) || isHeaderLine(l) || OWNER_CUE_RE.test(l)) break;
      if (BULLET_RE.test(l)) { bullets += 1; stripped += 1; i += 1; continue; }
      if (bullets > 0 && CONTINUATION_RE.test(l)) { stripped += 1; i += 1; continue; }
      if (bare && bullets === 0) { stripped += 1; i += 1; }
      break;
    }
  }
  if (!stripped) return { text: src, strippedLines: 0, blockLines: 0, forgedLines: 0 };
  const out = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  return { text: out, strippedLines: stripped, blockLines: blocks, forgedLines: forged };
}

/** stripForgedHarnessChrome over a run's MODEL text parts (guard-marker / struck parts untouched). Same array when nothing changed. Pure. */
export function stripForgedHarnessChromeFromParts<T>(parts: T[]): { parts: T[]; strippedLines: number; blockLines: number; forgedLines: number } {
  if (!Array.isArray(parts)) return { parts, strippedLines: 0, blockLines: 0, forgedLines: 0 };
  let total = 0;
  let blocks = 0;
  let forged = 0;
  const out = parts.map((p) => {
    const q = p as unknown as Record<string, unknown>;
    if (!isObj(q) || q.type !== 'text' || typeof q.text !== 'string' || q.marker === 'guard' || q.struck === true) return p;
    const s = stripForgedHarnessChrome(q.text);
    if (!s.strippedLines) return p;
    total += s.strippedLines;
    blocks += s.blockLines;
    forged += s.forgedLines;
    return { ...q, text: s.text } as unknown as T;
  });
  return total ? { parts: out, strippedLines: total, blockLines: blocks, forgedLines: forged } : { parts, strippedLines: 0, blockLines: 0, forgedLines: 0 };
}

/**
 * A MODEL-typed wake / sweep no-op close line — the core wake.close shape
 * ('WAKE: no-op — nothing moved …') at a line's start after markdown chrome:
 * heading hashes, quote marks, a bullet / number, emphasis. A sentence that
 * QUOTES the marker mid-line is never one, and neither is the harness's own
 * 'WAKE: no-op (harness: …' line (phase 2 owns those). Group 1 = the chrome,
 * group 2 = an emphasis opened before the marker.
 */
const MODEL_NOOP_CLOSE_LINE_RE = /^([ \t]*(?:(?:#{1,6}[ \t]*|>[ \t]*|[-*•+][ \t]+|\d+[.)][ \t]+))*)(\*\*|__|\*|_)?[ \t]*(?:SWEEP|WAKE)[ \t]*:[ \t]*(?:\*\*|__|\*|_)?[ \t]*no-op(?![A-Za-z0-9-])(?![ \t]*(?:\*\*|__|\*|_)?[ \t]*\(harness:)/i;

/**
 * The close's own boilerplate — what the core wake.close shape says after the
 * marker ('nothing moved <where> since the previous wake', 'nothing to do',
 * 'no lane action', 'ledger unchanged', 'idle since …'). It carries no reason
 * of its own. The where / since clauses never cross a separator (; — –, a
 * sentence end, a spaced hyphen), so a reason after one is never swallowed.
 */
const NOOP_CLAUSE_CHAR = String.raw`(?:(?![.!?](?:\s|$)|[ \t]-[ \t])[^;—–\n])`;
const NOOP_BOILERPLATE = String.raw`(?:nothing(?:[ \t]+(?:has|have|new|else|further|more|at[ \t]+all))*(?:[ \t]+(?:moved|changed|happened|new|to[ \t]+(?:do|report|steer|add|act[ \t]+on)))?|no[ \t]+(?:changes?|movement|progress|news|new[ \t]+\w+|(?:lane[ \t]+)?actions?(?:[ \t]+(?:needed|taken|required))?)|all[ \t]+quiet|idle|(?:[\w-]+[ \t]+){0,2}unchanged)(?:[ \t]+this[ \t]+(?:wake|sweep|round|turn))?(?:[ \t]+(?:in|on|for|across|with|at)[ \t]+${NOOP_CLAUSE_CHAR}{1,80}?)?(?:[ \t]+since[ \t]+${NOOP_CLAUSE_CHAR}{1,60}?)?`;
/** The rest of a close line is ONLY boilerplate (a bare close) — a trailing separator (; , : — – -) included. */
const PURE_NOOP_BOILERPLATE_RE = new RegExp(String.raw`^(?:${NOOP_BOILERPLATE})[\s.!)*_;,:—–-]*$`, 'i');
/** Boilerplate leading a reason, up to the strong separator after it ('nothing moved since your answer; <reason>'). */
const LEAD_NOOP_BOILERPLATE_RE = new RegExp(String.raw`^(?:${NOOP_BOILERPLATE})[ \t]*(?:[;—–]|\.(?=\s)|[ \t]-[ \t])[\s*_]*(?=\S)`, 'i');
/** A 'Receipts:' line of the model's own close (plain, bulleted or bold). */
const RECEIPTS_LINE_RE = /^[ \t]*(?:[-*•+][ \t]+)?(?:\*\*|__)?[ \t]*Receipts?\b/i;
/** The value of a Receipts line that names nothing ('none', 'n/a', '—', '0' …). */
const EMPTY_RECEIPTS_VALUE_RE = /^(?:none|n\/?a|nil|null|nothing|0|no[ \t]+receipts?|\(none\))?(?:[ \t]+this[ \t]+(?:wake|sweep|round|turn))?[\s.*_)]*$/i;

function isEmptyReceiptsLine(line: string): boolean {
  const value = line.replace(RECEIPTS_LINE_RE, '').replace(/^[\s*_:—–-]*/, '');
  return EMPTY_RECEIPTS_VALUE_RE.test(value);
}

/** Drop a trailing emphasis / bracket the marker's chrome opened and the reason no longer pairs. */
function trimUnbalancedTail(text: string): string {
  let t = text.replace(/\s+$/, '');
  for (let guard = 0; guard < 6; guard += 1) {
    const before = t;
    for (const tok of ['**', '__', '*', '_', '`']) {
      if (t.endsWith(tok) && t.split(tok).length % 2 === 0) { t = t.slice(0, -tok.length).replace(/\s+$/, ''); break; }
    }
    if (t.endsWith(')') && (t.match(/\)/g) ?? []).length > (t.match(/\(/g) ?? []).length) t = t.slice(0, -1).replace(/\s+$/, '');
    if (t.endsWith(']') && (t.match(/\]/g) ?? []).length > (t.match(/\[/g) ?? []).length) t = t.slice(0, -1).replace(/\s+$/, '');
    if (t === before) break;
  }
  return t;
}

/**
 * Read one line as the model's no-op close: null when it is not one;
 * `replacement` null for a BARE close (the marker and its boilerplate only —
 * the line goes), else the line rewritten as its plain reason (the marker,
 * its dash and boilerplate gone; a list item / quote keeps its chrome, a
 * heading drops it; the first word capitalized). Pure.
 */
function parseNoopCloseLine(line: string): { replacement: string | null } | null {
  const m = MODEL_NOOP_CLOSE_LINE_RE.exec(line);
  if (!m) return null;
  const rest = trimUnbalancedTail(line.slice(m[0].length).replace(/^[\s*_`—–:;,.([-]+/, ''));
  // The boilerplate is read without bold markup ('**nothing moved** since …').
  const plain = rest.replace(/\*\*|__/g, '');
  if (!/[A-Za-z0-9]/.test(rest) || PURE_NOOP_BOILERPLATE_RE.test(plain)) return { replacement: null };
  // Every leading boilerplate clause goes ('nothing moved since your answer; no lane action; <reason>') — re-review
  // fix 2026-10-23: one strip kept a chained close's second clause as its "reason".
  let left = plain;
  let led = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const lead = LEAD_NOOP_BOILERPLATE_RE.exec(left);
    if (!lead) break;
    left = left.slice(lead[0].length);
    led = true;
  }
  let reason = trimUnbalancedTail(led ? left : rest);
  // A leftover that is itself boilerplate is no reason: the close is bare.
  if (!/[A-Za-z0-9]/.test(reason) || PURE_NOOP_BOILERPLATE_RE.test(reason.replace(/\*\*|__/g, '').replace(/[\s;,:—–-]+$/, ''))) return { replacement: null };
  if (/^[a-z]+(?=[ \t])/.test(reason)) reason = reason[0].toUpperCase() + reason.slice(1);
  const chrome = (m[1] ?? '').replace(/#{1,6}[ \t]*/g, '');
  return { replacement: `${chrome}${reason}` };
}

/**
 * Does this block (a paragraph) open with a line the harness appends to a
 * note BEFORE the follow-through strip — the action verifier's observe-only
 * annotations (struck-note repeat, computer_task claims, unverified-claims
 * footnote), the claims-lane notes ('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK
 * …]'), the deferred-action note ('[harness — …]'), the verification footers /
 * unfinished-work note, or a harness appendix line? The no-op close walk skips
 * these (kept, re-attached in place). Pure.
 */
export function isHarnessTrailerBlock(block: string): boolean {
  const first = String(block ?? '').trimStart().split('\n', 1)[0] ?? '';
  return /^\[(?:ACTION VERIFIER\b|harness\b)/i.test(first) || first.startsWith('🔍 Harness') || first.startsWith('⏳ HARNESS NOTE:') || isHarnessAppendixBlock(first);
}

/** One line the follow-through strip changed: the exact original line and what replaced it (null = removed). */
export interface NoopCloseEdit {
  kind: 'marker' | 'receipts';
  line: string;
  replacement: string | null;
}

export interface NoopCloseStrip {
  text: string;
  /** Close (marker) lines removed or rewritten. */
  strippedLines: number;
  /** Of strippedLines: closes rewritten as their plain reason (kept, not removed). */
  reasonLines: number;
  /** The exact line edits, bottom-up — stripTrailingNoopCloseLineFromParts locates the same lines in the parts. */
  edits: NoopCloseEdit[];
}

/**
 * Remove the model's TRAILING 'WAKE: no-op …' close from an answer-first
 * follow-through round (follow-through minors, 2026-10-22: the round finishes
 * the OWNER's answer, never a wake, but every supervisor prompt carries the
 * core wake.close rule, so a round could still close with 'WAKE: no-op —
 * nothing moved'; the owner read it at the end of their answer and
 * applyHarnessReceipts filed the round 'noop_present'). The chat-agent
 * finalize (followThroughQuietZero only) strips it so the round gets mode
 * 'record' — the neutral 'Harness record:' line.
 *
 * The close is the last model line once the walk sets aside trailing HARNESS
 * trailers (isHarnessTrailerBlock — appended before the strip, kept in place)
 * and the close's own 'Receipts:' line(s) under it; heading / quote / bullet /
 * emphasis chrome allowed. A BARE close (marker + its boilerplate) is removed,
 * with an empty Receipts line under it; a close that carries a REASON keeps the
 * reason as plain text — only the marker and its boilerplate go (review fix,
 * 2026-10-22: the first cut dropped the reason prose with the marker). Stacked
 * closes are removed bottom-up. NEVER strips a note to nothing: a note that
 * was only the close (and Receipts lines) is returned unchanged — the row then
 * stays a no-op reply, so the owner ask stays open (review fix: a round reduced
 * to the bare record line closed the ask on a content-free bubble). The input
 * unchanged (same string) when nothing applies. Pure.
 */
export function stripTrailingNoopCloseLine(text: string): NoopCloseStrip {
  const src = String(text ?? '');
  const none: NoopCloseStrip = { text: src, strippedLines: 0, reasonLines: 0, edits: [] };
  const lines = src.replace(/\s+$/, '').split('\n');
  // 1. Harness trailers at the end (whole paragraphs) — set aside, re-attached after the model's words.
  let end = lines.length;
  for (;;) {
    let j = end - 1;
    while (j >= 0 && !lines[j].trim()) j -= 1;
    if (j < 0) break;
    let s = j;
    while (s > 0 && lines[s - 1].trim()) s -= 1;
    if (!isHarnessTrailerBlock(lines.slice(s, j + 1).join('\n'))) break;
    end = s;
  }
  const body = lines.slice(0, end);
  const trailer = lines.slice(end).join('\n').trim();
  // 2. The close: the last line above any Receipts line(s) of the same paragraph.
  const edits: NoopCloseEdit[] = [];
  let stripped = 0;
  let reasons = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let k = body.length - 1;
    const receipts: number[] = [];
    while (k >= 0 && body[k].trim() && RECEIPTS_LINE_RE.test(body[k])) { receipts.push(k); k -= 1; }
    if (k < 0 || !body[k].trim()) break;
    const parsed = parseNoopCloseLine(body[k]);
    if (!parsed) break;
    edits.push({ kind: 'marker', line: body[k], replacement: parsed.replacement });
    for (const r of receipts) { // descending — splicing keeps k and the remaining indexes valid
      if (!isEmptyReceiptsLine(body[r])) continue;
      edits.push({ kind: 'receipts', line: body[r], replacement: null });
      body.splice(r, 1);
    }
    stripped += 1;
    if (parsed.replacement !== null) { body[k] = parsed.replacement; reasons += 1; break; }
    body.splice(k, 1);
  }
  if (!stripped) return none;
  // 3. Never to nothing: the model's own words must remain (a Receipts line alone is no answer).
  if (!body.some((l) => l.trim() && !RECEIPTS_LINE_RE.test(l))) return none;
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const head = body.join('\n').replace(/\s+$/, '');
  return { text: trailer ? `${head}\n\n${trailer}` : head, strippedLines: stripped, reasonLines: reasons, edits };
}

/** Apply one edit to the LAST line of `text` equal to it (trimmed); null when the line is not there. Pure. */
function applyLineEdit(text: string, edit: NoopCloseEdit): string | null {
  const ls = text.split('\n');
  const target = edit.line.trim();
  for (let k = ls.length - 1; k >= 0; k -= 1) {
    if (ls[k].trim() !== target) continue;
    if (edit.replacement !== null) {
      ls[k] = edit.replacement;
      return ls.join('\n');
    }
    ls.splice(k, 1);
    if (k >= ls.length) {
      while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
    } else if (k > 0 && !ls[k - 1].trim() && !ls[k].trim()) {
      ls.splice(k, 1); // no double blank where the line was
    }
    return ls.join('\n');
  }
  return null;
}

const FOLLOWUPS_BLOCK_RE = /\[FOLLOWUPS\][\s\S]*?(?:\[\/FOLLOWUPS\]|$)/gi;

/**
 * stripTrailingNoopCloseLine over the run's MODEL text parts. With `edits` (the
 * content strip's own — the chat-agent finalize passes them) the SAME lines
 * are located in the parts, newest part first, whatever part they sit in (a
 * claims-lane notes part / annotation part / a later tool round after it never
 * hides them — review fix 2026-10-22: the last-part walk missed and the stored
 * parts, which the transcript renders, kept the line the content had dropped).
 * Without edits, or when an edit cannot be located (the content went through
 * the markdown repair, the parts are the raw stream), they are derived from
 * the TRAILING model text parts: the walk back skips reasoning, blank text and
 * harness trailer parts and stops at a tool / guard-marker / struck part; a
 * raw [FOLLOWUPS] block is set aside for the derivation and kept in the part.
 * Guard-marker / struck / trailer parts never take an edit. Same array when
 * nothing changed. Pure.
 */
export function stripTrailingNoopCloseLineFromParts<T>(parts: T[], edits?: ReadonlyArray<NoopCloseEdit>): { parts: T[]; strippedLines: number } {
  if (!Array.isArray(parts)) return { parts, strippedLines: 0 };
  const editable = (q: Record<string, unknown>): boolean =>
    q.type === 'text' && typeof q.text === 'string' && q.marker !== 'guard' && q.struck !== true && !isHarnessTrailerBlock(q.text);
  const apply = (list: ReadonlyArray<NoopCloseEdit>, scope: number[]): { parts: T[]; strippedLines: number } | null => {
    const out = parts.slice();
    let markers = 0;
    for (const e of list) {
      let hit = false;
      for (const i of scope) {
        const q = out[i] as unknown as Record<string, unknown>;
        const next = applyLineEdit(String(q.text), e);
        if (next === null) continue;
        out[i] = { ...q, text: next } as unknown as T;
        hit = true;
        break;
      }
      if (!hit) return null;
      if (e.kind === 'marker') markers += 1;
    }
    return { parts: out, strippedLines: markers };
  };
  // Located: every editable text part, newest first.
  if (edits?.length) {
    const all: number[] = [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const q = parts[i] as unknown as Record<string, unknown>;
      if (isObj(q) && editable(q)) all.push(i);
    }
    const located = apply(edits, all);
    if (located) return located;
  }
  // Derived: the trailing model text parts.
  const tail: number[] = [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const q = parts[i] as unknown as Record<string, unknown>;
    if (!isObj(q) || q.type === 'reasoning') continue;
    if (q.type !== 'text' || typeof q.text !== 'string' || q.marker === 'guard' || q.struck === true) break;
    if (!q.text.trim() || isHarnessTrailerBlock(q.text)) continue;
    tail.push(i);
  }
  if (!tail.length) return { parts, strippedLines: 0 };
  const joined = tail.slice().reverse().map((i) => String((parts[i] as unknown as Record<string, unknown>).text).replace(FOLLOWUPS_BLOCK_RE, '')).join('\n\n');
  const derived = stripTrailingNoopCloseLine(joined).edits;
  if (!derived.length) return { parts, strippedLines: 0 };
  return apply(derived, tail) ?? { parts, strippedLines: 0 };
}

/**
 * Remove ONLY the harness's zero-action lines ('WAKE: no-op (harness: …' and
 * 'Harness record: …') — the stuck-note backstop's view of a note. Those
 * lines would otherwise exempt (as a no-op close) or pad exactly the repeated
 * narration the backstop exists to break; every other harness line (the
 * ACTIONS TAKEN (harness) block, report-up / not-executed lines) stays, as
 * the model's own action lines did before 2026-10-20 (review fix: stripping
 * the whole appendix removed the evidence that acting wakes differed). Pure.
 */
export function stripHarnessNoopLines(text: string): string {
  const src = String(text ?? '');
  if (!src.includes(HARNESS_NOOP_PREFIX) && !src.includes(HARNESS_RECORD_PREFIX)) return src;
  const keep = src.split('\n').filter((l) => !l.startsWith(HARNESS_NOOP_PREFIX) && !l.startsWith(HARNESS_RECORD_PREFIX));
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/**
 * Does this block (one paragraph, no blank lines inside) open with a line the
 * harness appends to a supervisor note? guard-chrome-redact treats such a
 * trailing block as TRANSPARENT (kept, the chrome before it still stripped) —
 * the appendix lands AFTER every annotate-lane trailer. Pure.
 */
export function isHarnessAppendixBlock(block: string): boolean {
  const first = String(block ?? '').split('\n', 1)[0] ?? '';
  return first.startsWith(HARNESS_ACTIONS_HEADER) || first.startsWith(HARNESS_NOOP_PREFIX) || first.startsWith(HARNESS_REPORTED_PREFIX)
    || first.startsWith(HARNESS_REPORT_UP_PREFIX) || first.startsWith(HARNESS_NOT_EXECUTED_PREFIX) || first.startsWith(HARNESS_RECORD_PREFIX);
}

/**
 * The note without its trailing harness appendix — the owner briefing's view (review fix 2026-10-20): the
 * briefing reads the MODEL's words, so the harness no-op line never parses as the model's own 'WAKE: no-op'
 * (a free-form or read-only note briefed as "Nothing new", or skipped on project scope) and the
 * unverified-only check sees no leftover harness text. The finalize appends the appendix as ONE paragraph,
 * last; the model's own copies of its lines are stripped there, so a trailing appendix block is the
 * harness's. Never strips a note to nothing — a note that is only the harness record IS the record. The
 * input unchanged (same string) when its tail is not an appendix block. Pure.
 */
export function stripTrailingHarnessAppendix(text: string): string {
  const src = String(text ?? '');
  const split = splitTrailingHarnessAppendix(src);
  return split.appendix && split.head.trim() ? split.head : src;
}

/**
 * The note split into what precedes its trailing harness appendix paragraph and that paragraph ('' when the
 * tail is not one; head is then the input unchanged). The persisted-row builder uses it to keep the appendix
 * LAST when it adds carried-forward blocks (review fix 2026-10-20). Pure.
 */
export function splitTrailingHarnessAppendix(text: string): { head: string; appendix: string } {
  const src = String(text ?? '');
  const trimmed = src.replace(/\s+$/, '');
  const sep = trimmed.lastIndexOf('\n\n');
  if (sep === -1 || !isHarnessAppendixBlock(trimmed.slice(sep + 2))) return { head: src, appendix: '' };
  return { head: trimmed.slice(0, sep).replace(/\s+$/, ''), appendix: trimmed.slice(sep + 2) };
}

/** The executed-action count a persisted note's harness block states ('- +N more' tail included); 0 without the block. Pure. */
export function harnessActionLineCount(content: string): number {
  const lines = String(content ?? '').split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(HARNESS_ACTIONS_HEADER));
  if (at < 0) return 0;
  let n = 0;
  for (const raw of lines.slice(at + 1)) {
    const l = raw.trim();
    if (!l.startsWith('- ')) break;
    const more = l.match(/^- \+(\d+) more\b/);
    n += more ? Number(more[1]) : 1;
  }
  return n;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** One action line: "- send_chat_message → chat 1a2b3c4d · receipt 5e6f7a8b". */
export function renderHarnessActionLine(c: HarnessActionCall): string {
  return `- ${c.tool}${c.target ? ` → ${c.target}` : ''} · ${c.receiptId ? `receipt ${c.receiptId}` : 'receipt n/a'}`;
}

const inlineEntry = (c: HarnessActionCall): string => `${c.tool}${c.target ? ` → ${c.target}` : ''}${c.receiptId ? ` · receipt ${c.receiptId}` : ''}`;

const inlineList = (cs: HarnessActionCall[], render: (c: HarnessActionCall) => string): string =>
  cs.slice(0, MAX_INLINE_ENTRIES).map(render).join('; ') + (cs.length > MAX_INLINE_ENTRIES ? `; +${cs.length - MAX_INLINE_ENTRIES} more` : '');

/** Marker regexes (mirrors of supervisor.service — this leaf stays import-free). */
const NOOP_MARKER_RE = /\b(?:SWEEP|WAKE):\s*no-op\b/i;
const REPORTED_MARKER_RE = /\b(?:SWEEP|WAKE):\s*reported\b/i;

/** actions — executed calls listed; reported — report-up only; noop — the zero-call line appended;
 *  noop_present — the note already carries a no-op marker; record — the neutral zero-call line. */
export type HarnessReceiptsMode = 'actions' | 'reported' | 'noop' | 'noop_present' | 'record';

export interface HarnessReceiptsApplied {
  text: string;
  /** What was appended ('' when nothing). */
  appendix: string;
  mode: HarnessReceiptsMode;
  /** Executed real actions (report-ups excluded) — persisted as metadata.harnessActions. */
  harnessActions: number;
  reportUps: number;
  notExecuted: number;
}

/**
 * Append the harness record to a wake note whose model-typed block was
 * already stripped (stripModelActionsBlock). `quietZero` — the wake answers an
 * owner ask (or is the answer-first follow-through of the owner's own turn —
 * chat-agent followThroughQuietZero): zero calls render the neutral record
 * line, never the no-op marker (a no-op close would read as "the ask was
 * ignored"). Pure.
 */
export function applyHarnessReceipts(note: string, view: HarnessReceiptsView, opts: { quietZero?: boolean } = {}): HarnessReceiptsApplied {
  const base = String(note ?? '').replace(/\s+$/, '');
  const lines: string[] = [];
  let mode: HarnessReceiptsMode;
  if (view.actions.length) {
    mode = 'actions';
    lines.push(HARNESS_ACTIONS_HEADER, ...view.actions.slice(0, HARNESS_MAX_ACTION_LINES).map(renderHarnessActionLine));
    if (view.actions.length > HARNESS_MAX_ACTION_LINES) lines.push(`- +${view.actions.length - HARNESS_MAX_ACTION_LINES} more (get_run_receipts lists every receipt)`);
    if (view.reportUps.length) lines.push(`${HARNESS_REPORT_UP_PREFIX} ${inlineList(view.reportUps, inlineEntry)}`);
  } else if (view.reportUps.length) {
    mode = 'reported';
    lines.push(REPORTED_MARKER_RE.test(base) && !NOOP_MARKER_RE.test(base)
      ? `${HARNESS_REPORT_UP_PREFIX} ${inlineList(view.reportUps, inlineEntry)}`
      : `${HARNESS_REPORTED_PREFIX} 0 lane actions; ${view.reportUps.length} report-up${view.reportUps.length === 1 ? '' : 's'} to the Fleet Supervisor — ${inlineList(view.reportUps, inlineEntry)})`);
  } else if (NOOP_MARKER_RE.test(base)) {
    mode = 'noop_present';
  } else if (opts.quietZero || REPORTED_MARKER_RE.test(base)) {
    mode = 'record';
    lines.push(HARNESS_RECORD_ZERO_LINE);
  } else {
    mode = 'noop';
    lines.push(view.notExecuted.length ? `${HARNESS_NOOP_PREFIX} 0 lane actions executed)` : HARNESS_NOOP_LINE);
  }
  if (view.notExecuted.length) {
    lines.push(`${HARNESS_NOT_EXECUTED_PREFIX} ${inlineList(view.notExecuted, (c) => `${c.tool}${c.target ? ` → ${c.target}` : ''} (${c.staged ? 'staged on a confirmation card' : 'refused or failed'})`)}`);
  }
  const appendix = lines.join('\n');
  const text = appendix ? (base ? `${base}\n\n${appendix}` : appendix) : base;
  return { text, appendix, mode, harnessActions: view.actions.length, reportUps: view.reportUps.length, notExecuted: view.notExecuted.length };
}

/** The bounded metadata stamp the persisted note carries (metadata.harnessReceipts). Pure. */
export function harnessReceiptsMeta(a: HarnessReceiptsApplied, modelBlockLines: number): Record<string, unknown> {
  return { v: 1, mode: a.mode, reportUps: a.reportUps, notExecuted: a.notExecuted, modelBlockLines };
}

// ── Classification from the harness record ──────────────────────────────────

export type HarnessNoteKind = 'supervisor_noop' | 'supervisor_action' | 'supervisor_note' | 'supervisor_report_up';

/**
 * The note kind the harness record implies, from a persisted note's metadata
 * (metadata.harnessActions + metadata.harnessReceipts.mode). null when the
 * note carries no harness count (an older row, a human turn, the kill switch)
 * — the caller then reads the markers as before. Pure.
 */
export function harnessNoteKind(metadata: unknown, env: NodeJS.ProcessEnv = process.env): HarnessNoteKind | null {
  if (supervisorHarnessReceiptsDisabled(env) || !isObj(metadata)) return null;
  const n = metadata.harnessActions;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n > 0) return 'supervisor_action';
  const hr = isObj(metadata.harnessReceipts) ? metadata.harnessReceipts : {};
  if (typeof hr.reportUps === 'number' && hr.reportUps > 0) return 'supervisor_report_up';
  if (hr.mode === 'record') return 'supervisor_note';
  return 'supervisor_noop';
}

/**
 * SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1|true|on — the follow-through
 * wave's kill switch (chat-agent/owner-answer-first.ts followThroughQuietZeroDisabled
 * is the same parse; read here too so this leaf stays import-free). Under it
 * harnessLineKind no longer reads the neutral 'Harness record:' line (the
 * pre-2026-10-22 content classification, byte-for-byte). Read per call.
 */
function recordLineKindDisabled(env: NodeJS.ProcessEnv): boolean {
  return onFlag(env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED);
}

/**
 * The kind a HARNESS line in a note's content implies (content-only readers:
 * classifySupervisorNote). The harness block wins over the model's own
 * markers — the model's copies are stripped at finalize, so a harness line in
 * a persisted note is the harness's. null when no harness line. Pure.
 *
 * The neutral 'Harness record:' line (follow-through minors, 2026-10-22) is
 * appended ONLY in mode 'record' — an owner-ask answer, an answer-first
 * follow-through round of the owner's own turn, a 'WAKE: reported'-shaped
 * note with no send — so it reads 'supervisor_note', exactly as
 * harnessNoteKind reads that mode from the metadata. Before this the line
 * carried no '(harness' token, the classifier fell through to its ≤200-char
 * rule and a short follow-through result read as a 'supervisor_noop' (fed to
 * the sweep_triage gate as previous_sweep_note.class). A genuine no-op wake
 * never carries it: mode 'noop' appends the 'WAKE: no-op (harness: …' line and
 * mode 'noop_present' appends nothing (the model's own marker classifies).
 * Kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1 (recordLineKindDisabled).
 */
export function harnessLineKind(content: string, env: NodeJS.ProcessEnv = process.env): 'supervisor_noop' | 'supervisor_action' | 'supervisor_note' | null {
  if (supervisorHarnessReceiptsDisabled(env)) return null;
  const text = String(content ?? '');
  const readRecord = !recordLineKindDisabled(env);
  if (!text.includes('(harness') && !(readRecord && text.includes(HARNESS_RECORD_PREFIX))) return null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith(HARNESS_ACTIONS_HEADER)) return 'supervisor_action';
  }
  for (const raw of text.split('\n')) {
    if (raw.startsWith(HARNESS_REPORTED_PREFIX)) return 'supervisor_note';
    if (raw.startsWith(HARNESS_NOOP_PREFIX)) return 'supervisor_noop';
    if (readRecord && raw.startsWith(HARNESS_RECORD_PREFIX)) return 'supervisor_note';
  }
  return null;
}

/** The empty-completion retry's close clause (chat-agent.service) — the doctrine variant in force. Pure. */
export function wakeNoteRetryCloseClause(env: NodeJS.ProcessEnv = process.env): string {
  return supervisorHarnessReceiptsDisabled(env)
    ? 'close with the ACTIONS TAKEN or WAKE: no-op line the doctrine requires'
    : 'say what moved and why, or close with the WAKE: no-op line the doctrine requires (the harness appends the receipts)';
}
