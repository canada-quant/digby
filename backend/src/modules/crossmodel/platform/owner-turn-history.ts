/**
 * Supervisor OWNER-turn context (FS context map 2026-10-22, ranked gaps #1 and
 * #3; owner: "it still feels the fleet supervisor doesnt fully have the
 * context and memory of everything"). Pure leaf: no prisma, no I/O — the two
 * transcript reads live in ./owner-turn-history.loader.ts.
 *
 * Why: an owner turn on a supervisor chat read the last 8 transcript rows
 * whatever their origin (chat-agent.service `slice(-8)`). The Fleet
 * Supervisor's chat takes ~6.5 rows an hour (wakes, agent relays, its own
 * notes), so 8 rows covered roughly the last 75 minutes: an instruction from
 * 3 h ago was gone. Most of the slots that remained were old BAKED wake
 * prompts (preamble + [SUPERVISOR STATE] + [BOARD] + event — 13–22k chars
 * each, unclipped, every one a stale snapshot saying "no user is on this
 * turn"). Machine wakes already elided those prompts
 * (wake-material-rule selectWakeContinuityHistory); owner turns never did.
 *
 *  - selectOwnerTurnHistory: the owner turn's transcript history chosen BY
 *    ORIGIN from a deep window — every owner turn (owner words + the reply),
 *    the newest few machine-turn notes (prompt elided to a stub), the newest
 *    two agent relays (clipped), harness snapshot rows dropped, the whole
 *    thing char-bounded.
 *  - ownerThreadEntriesFromRows + renderOwnerThreadBlock: the compact
 *    [OWNER THREAD — last 48 h] system block — every owner-typed message of
 *    the last two days with the head of the reply that followed, so a
 *    decision from this morning or yesterday is in front of the model even
 *    when the history window no longer reaches it.
 *
 * Kill switches: SUPERVISOR_OWNER_HISTORY_V2_DISABLED=1 (the 8-row slice, no
 * thread block) and SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED=1 (no
 * [SINCE YOUR LAST NOTE] diff, no PROJECT STATUS age stamps — the
 * chat-agent seam reads it).
 *
 * Review fixes (2026-10-23):
 *  - SECRETS: every row text that enters the history or the thread block runs
 *    through the platform redactor (secret-scan redactInboundSecrets — the
 *    one the chat-read tools apply on machine reads) BEFORE any clip, so a
 *    credential the owner pasted rides neither (the 48 h thread had turned a
 *    ~75 min exposure into two days). The current turn's own message is not
 *    in these rows — it stays verbatim (store_secret lifts it from there).
 *  - PAIRING: a turn is opened by user rows of ONE provenance (owner / relay /
 *    machine) — a different provenance always opens a new turn — and an
 *    assistant row joins the newest turn of ITS side (owner-side: no machine
 *    origin; relay-side: origin 'agent'; machine-side: any other origin or a
 *    preempted wake). Only model-written rows (the finalize stamp, not a
 *    provider-error envelope / harness error note) are kept; every other
 *    assistant row is harness chrome — dropped, but it still CLOSES the open
 *    turn so the next row never merges into it. The thread's reply head is
 *    the first row of the owner's own turn that fleet/supervisor-reply-row
 *    isSupervisorReplyRow accepts (the ONE "is this the supervisor's reply"
 *    predicate) — never an origin-less harness notice, never a preempted
 *    wake's partial note (that is its own machine turn, prompt stubbed).
 *  - The [OWNER THREAD] shrink ladder is linear (per-line lengths kept and
 *    adjusted; it was quadratic — ~19 s on the event loop at 1,500 entries).
 *
 * Round-3 review (2026-10-23):
 *  - A preempted ORIGIN-LESS row is a turn-continuation round: it joins the
 *    newest owner turn (marked partial), never an earlier wake's turn.
 *  - Origin-less unstamped harness NOTICES (hook delivery died, a schedule
 *    stopped / parked, the daily-cap pause, a failed follow-through round)
 *    land in the supervisor's own chat, which the ledger diff never reads —
 *    the newest OWNER_TURN_NOTICES ride the history as one redacted line
 *    each, in position, never paired with an owner row.
 */

import { isMachineUserRow } from './wake-material-rule';
import { redactInboundHead, redactInboundSecrets } from './secret-scan';
import { hasFinalizeStamp, isSupervisorReplyRow, MACHINE_NOTE_KINDS } from '../fleet/supervisor-reply-row';
import { isHarnessErrorNote } from '../coding/harness-error-notes';

// ── Switches ────────────────────────────────────────────────────────────────

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** SUPERVISOR_OWNER_HISTORY_V2_DISABLED=1 — owner turns read the origin-blind last-8-rows slice again and get no [OWNER THREAD] block. */
export function ownerHistoryV2Disabled(): boolean {
  return onFlag(process.env.SUPERVISOR_OWNER_HISTORY_V2_DISABLED);
}

/** SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED=1 — owner turns get no [SINCE YOUR LAST NOTE] diff and the PROJECT STATUS lines carry no age stamp. */
export function ownerLedgerDiffDisabled(): boolean {
  return onFlag(process.env.SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED);
}

// ── Shapes + bounds ─────────────────────────────────────────────────────────

/** One transcript row as the loader reads it (metadata fields flattened). */
export interface OwnerTurnRow {
  id?: string;
  role: string;
  content: string;
  /** metadata.origin — unset / 'user' on owner rows and their replies. */
  origin?: string | null;
  /** metadata.kind — harness rows (status cards, briefings, acks) carry one. */
  kind?: string | null;
  /** metadata.machineMessage — a machine wake's PRE-preamble text (its trigger). */
  machineMessage?: string | null;
  createdAt?: Date | string | null;
  /**
   * A whitelisted projection of metadata (the loader's jsonb_build_object: engine, models, ownerAskReply,
   * providerError, preempted, ownerAnswerFirst, task.status) — the reply predicate
   * (fleet/supervisor-reply-row) and the side of an assistant row read it. Absent ⇒ no finalize stamp ⇒ harness.
   */
  meta?: Record<string, unknown> | null;
}

export interface ConversationRow { role: 'user' | 'assistant'; content: string }

/** Newest transcript rows the loader reads for the history (~12 h of the Fleet Supervisor's chat). */
export const OWNER_HISTORY_FETCH_ROWS = 80;
/** Rows the 48 h thread read may return (newest first) — a pathology bound, ~5 days of today's volume. */
export const OWNER_THREAD_FETCH_ROWS = 1500;
export const OWNER_ROW_MAX_CHARS = 4000;
export const OWNER_REPLY_MAX_CHARS = 4000;
/** The supervisor's own notes on machine turns (continuity: what it did since). */
export const OWNER_TURN_NOTE_MAX_CHARS = 3000;
export const OWNER_TURN_NOTES = 2;
export const OWNER_TURN_RELAYS = 2;
export const OWNER_TURN_RELAY_MAX_CHARS = 1500;
export const OWNER_TURN_TRIGGER_MAX_CHARS = 600;
/** Whole-history bound (parity with the machine-wake window's 48k budget). */
export const OWNER_HISTORY_CHAR_BUDGET = 48000;
/**
 * Each read behind an owner turn (the transcript rows, the ledger diff) is bounded to this — measured from
 * the read's START, but only once the turn ASKS for it (startOwnerTurnRead): the effective bound is
 * max(this, the moment the turn first needs the value), and the turn first needs it after the context build
 * and the state reads. Past it the turn runs without that block (review 2026-10-23 item 2: the reads start
 * before the context build and never sit serially on the run's critical path; re-review: a read slower than
 * this but faster than the context build is never dropped for nothing).
 */
export const OWNER_TURN_READ_BOUND_MS = 1500;
/**
 * The inner deadline each owner-turn read carries itself (the loader's race, the ledger diff's withTimeout) —
 * a pathology ceiling well past the context build's own worst case (its learnings lookup alone is 10 s), so
 * it never cuts a read the turn would still have waited for; it only lets an abandoned read settle.
 * startOwnerTurnRead's bound is the one that decides.
 */
export const OWNER_TURN_READ_CEILING_MS = 15_000;
/** Redaction runs on a window this much wider than the clip (to the end of the token on its edge), so a credential straddling the clip is redacted whole. */
const REDACT_MARGIN = 512;
const REDACT_MAX_WINDOW = 16384;
/** An owner turn whose run left no reply of its own (an error envelope, nothing persisted) — said, never invented. */
export const OWNER_TURN_NO_REPLY = '[no reply of yours is recorded for this owner message]';
/** Prefix on a machine wake's note that an owner message preempted. */
export const OWNER_TURN_PREEMPTED_NOTE = '[partial note — this wake was preempted by the owner\'s message] ';
/** Prefix on an owner turn's follow-through round (turn continuation) that the owner's NEXT message preempted (round-3 review). */
export const OWNER_TURN_PREEMPTED_FOLLOW_THROUGH = '[partial follow-through — preempted by the owner\'s next message before it finished] ';
/**
 * Round-3 review (2026-10-23): origin-less harness notices (no finalize stamp — hook delivery died, a schedule
 * stopped / parked, the daily-cap pause, a failed follow-through round) land in the supervisor's OWN chat, which
 * the ledger diff never reads (its scope excludes the supervisor chat; hook deaths and cap pauses have no section
 * at all). The newest OWNER_TURN_NOTICES ride the history as one line each, in position, never as a reply.
 */
export const OWNER_TURN_NOTICES = 3;
export const OWNER_TURN_NOTICE_MAX_CHARS = 280;
export const OWNER_TURN_NOTICE_PREFIX = '[harness notice';
/** The turn-continuation result kind (chat-agent/turn-continuation CONTINUATION_RESULT_KIND — mirrored like fleet/supervisor-reply-row, so the leaf stays import-light). */
const CONTINUATION_RESULT_KIND = 'continuation_result';

export const OWNER_THREAD_WINDOW_MS = 48 * 60 * 60 * 1000;
export const OWNER_THREAD_ROW_MAX_CHARS = 600;
export const OWNER_THREAD_REPLY_MAX_CHARS = 300;
export const OWNER_THREAD_MAX_CHARS = 6000;
export const OWNER_THREAD_HEADING = '[OWNER THREAD — last 48 h';

/** A machine wake's stored prompt, as an owner turn sees it. */
export const OWNER_TURN_ELIDED_WAKE =
  '[earlier machine wake — its baked prompt (preamble + the state snapshot of that time) is elided; the live state is in your system context and get_chat_messages reads the row in full]';

/** Harness-written assistant rows (status cards, briefings, acks) — snapshots, never a reply. Same sets as supervisor-wake-ledger. */
const HARNESS_ASSISTANT_KINDS = new Set(['project_status', 'owner_briefing', 'watched-resource', 'report_up_ack', 'material_gate_ack']);
const HARNESS_ASSISTANT_ORIGINS = new Set(['project_status', 'attention-watchdog', 'owner-inbox', 'report-up-ack', 'material-gate-ack']);
const AGENT_TEXT_RE = /^\s*\[(AGENT-SENT MESSAGE|\d+ agent messages? arrived)/i;
const PENDING_NOTE_MARKER = "[System note — action awaiting the user's confirmation";

/** How a bounded owner-turn read ended: resolved (value may be null), the bound passed, or it rejected. */
export type OwnerTurnReadOutcome = 'pending' | 'ok' | 'timeout' | 'error';

export interface OwnerTurnRead<T> {
  /**
   * The read's value, or null once the bound passed or the read rejected — never a throw. Waits at most
   * until max(start + ms, the moment value() is first called): a read that settles while the turn is busy
   * elsewhere (the context build, the state reads) is always kept, and a read still pending once the turn
   * needs it and the bound has passed is dropped AT ONCE. Memoised — every call gets the first answer.
   */
  value(): Promise<T | null>;
  /** After value() settled: how. 'pending' until then. */
  readonly outcome: OwnerTurnReadOutcome;
  /** ms from the read's start to its settling (ok / error) or to giving up on it (timeout); null while pending. */
  readonly waitedMs: number | null;
  /** ms from the read's start to the first value() call — the effective bound is max(ms, this). */
  readonly askedAtMs: number | null;
  /** outcome 'ok' and the read answered null / undefined (the reader's own fail-open, or its normal "nothing"). */
  readonly answeredNull: boolean;
}

/**
 * Start bounding an owner-turn read (re-review 2026-10-23: the fixed timer the review shipped started with the
 * read, before buildChatQueryContext — a 3 s context build dropped a 2 s read at 1.5 s, the turn fell back to
 * the 8-row slice, and waiting would not have delayed the run start at all). The bound is now armed LAZILY at
 * the first value() call with what is left of `ms`, so it is max(`ms`, the time until the turn first needs
 * the value) — never shorter than the reviewer's max(1.5 s, the context build), since the turn asks only
 * after the build resolves. The timer is cleared on settle and unref'd; a rejection is observed here (never
 * an unhandled rejection), whether or not value() is ever called.
 */
export function startOwnerTurnRead<T>(p: Promise<T>, ms: number, clock: () => number = Date.now): OwnerTurnRead<T> {
  const startedAt = clock();
  type Settled = { ok: true; v: T } | { ok: false };
  let settled: Settled | null = null;
  let settledAt = startedAt;
  const settledP: Promise<void> = Promise.resolve(p).then(
    (v) => { settled = { ok: true, v }; settledAt = clock(); },
    () => { settled = { ok: false }; settledAt = clock(); },
  );
  let memo: Promise<T | null> | null = null;
  const read: { outcome: OwnerTurnReadOutcome; waitedMs: number | null; askedAtMs: number | null; answeredNull: boolean; value: () => Promise<T | null> } = {
    outcome: 'pending',
    waitedMs: null,
    askedAtMs: null,
    answeredNull: false,
    value: () => {
      if (memo) return memo;
      const askedAt = clock() - startedAt;
      read.askedAtMs = askedAt;
      memo = new Promise<T | null>((resolve) => {
        let done = false;
        // A zero remainder still waits one macrotask: a read that already settled is observed first
        // (microtasks run before timers), never misreported as a timeout.
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          read.outcome = 'timeout';
          read.waitedMs = clock() - startedAt;
          resolve(null);
        }, Math.max(0, ms - askedAt));
        (timer as any).unref?.();
        void settledP.then(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const s = settled as Settled | null;
          read.waitedMs = settledAt - startedAt;
          if (s && s.ok) { read.outcome = 'ok'; read.answeredNull = s.v == null; resolve(s.v ?? null); } else { read.outcome = 'error'; resolve(null); }
        });
      });
      return memo;
    },
  };
  return read;
}

/**
 * The fail-open telemetry for one owner-turn read (re-review 2026-10-23: a dropped read recorded nothing and
 * logged nothing, so how often v2 fails open in prod was invisible). Null when the read delivered a value —
 * an empty one included (an empty diff is an answer) — or was never asked for, or answered null where null is
 * a legitimate answer (`nullIsFailure` false: the ledger diff is off on this process). Pure.
 */
export function ownerTurnReadFailOpen(
  which: 'rows' | 'ledger',
  read: Pick<OwnerTurnRead<unknown>, 'outcome' | 'waitedMs' | 'askedAtMs' | 'answeredNull'>,
  opts: { nullIsFailure: boolean; boundMs?: number },
): { which: 'rows' | 'ledger'; failedOpen: true; timedOut: boolean; reason: 'timeout' | 'error' | 'null'; waitedMs: number | null; askedAtMs: number | null; boundMs: number } | null {
  if (read.outcome === 'pending') return null;
  let reason: 'timeout' | 'error' | 'null' | null = null;
  if (read.outcome === 'timeout') reason = 'timeout';
  else if (read.outcome === 'error') reason = 'error';
  else if (read.answeredNull && opts.nullIsFailure) reason = 'null';
  if (!reason) return null;
  return {
    which, failedOpen: true, timedOut: reason === 'timeout', reason,
    waitedMs: read.waitedMs, askedAtMs: read.askedAtMs, boundMs: opts.boundMs ?? OWNER_TURN_READ_BOUND_MS,
  };
}

// ── Classification ──────────────────────────────────────────────────────────

export type OwnerTurnRowClass = 'owner' | 'agent' | 'machine';

/** A user-role row's provenance: owner-typed, an agent relay, or other machine traffic (wake prompt, harness banner). Pure. */
export function classifyOwnerTurnUserRow(row: Pick<OwnerTurnRow, 'content' | 'origin'>): OwnerTurnRowClass {
  const origin = row.origin ?? null;
  const content = String(row.content ?? '');
  if (origin === 'agent') return 'agent';
  if (origin && origin !== 'user') return 'machine';
  if (AGENT_TEXT_RE.test(content)) return 'agent';
  return isMachineUserRow(content) ? 'machine' : 'owner';
}

/** An owner-typed transcript row (origin unset / 'user', not machine-authored text). Pure. */
export function isOwnerTypedRow(row: OwnerTurnRow): boolean {
  return row.role === 'user' && classifyOwnerTurnUserRow(row) === 'owner';
}

/** A harness-written assistant row (never a reply the supervisor wrote). Pure. */
export function isHarnessAssistantRow(row: Pick<OwnerTurnRow, 'role' | 'origin' | 'kind'>): boolean {
  if (row.role !== 'assistant') return false;
  return (!!row.kind && HARNESS_ASSISTANT_KINDS.has(row.kind)) || (!!row.origin && HARNESS_ASSISTANT_ORIGINS.has(row.origin));
}

const clipKeep = (v: unknown, n: number): string => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)} …[clipped]` : s;
};
const clipLine = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
};
const toMs = (d: unknown): number => (d instanceof Date ? d.getTime() : Date.parse(String(d ?? '')));

/**
 * Redact, THEN clip (review 2026-10-23 item 1). The redactor sees the clip window plus REDACT_MARGIN, extended
 * to the end of the token sitting on that edge (≤ REDACT_MAX_WINDOW), so a credential that straddles the clip
 * — a long JWT included — is matched whole instead of leaving its head on screen. Pure apart from the
 * redactor's own switch read; never throws (redactInboundSecrets is total).
 */
export function redactClip(v: unknown, n: number): string {
  const { text: red, cut } = redactInboundHead(v, n, { margin: REDACT_MARGIN, maxWindow: REDACT_MAX_WINDOW });
  if (red.length > n) return `${red.slice(0, n)} …[clipped]`;
  return cut ? `${red} …[clipped]` : red;
}

/**
 * The pending-confirmation protocol note the legacy loader appends to the last
 * assistant row (context.service loadChatContext) — carried onto the v2
 * history so a "confirm" reply still completes the staged action. '' when none. Pure.
 */
export function pendingConfirmationNoteFrom(history: ReadonlyArray<{ role: string; content: string }>): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role !== 'assistant') continue;
    const s = String(history[i].content ?? '');
    const at = s.lastIndexOf(PENDING_NOTE_MARKER);
    return at >= 0 ? s.slice(at) : '';
  }
  return '';
}

function wakeStub(users: OwnerTurnRow[]): string {
  const trigger = users.map((u) => String(u.machineMessage ?? '').trim()).filter(Boolean).pop();
  if (!trigger) return OWNER_TURN_ELIDED_WAKE;
  return `${OWNER_TURN_ELIDED_WAKE.slice(0, -1)}; its trigger was: ${clipLine(redactInboundSecrets(trigger), OWNER_TURN_TRIGGER_MAX_CHARS)}]`;
}

// ── Turns (review 2026-10-23 item 3) ────────────────────────────────────────

/** The metadata the predicates read: the loader's projection with the flattened origin / kind on top. */
function metaOf(r: OwnerTurnRow): Record<string, unknown> {
  const m = r.meta && typeof r.meta === 'object' ? r.meta : {};
  return { ...m, origin: r.origin ?? (m as any).origin ?? null, kind: r.kind ?? (m as any).kind ?? null };
}

type Side = 'owner' | 'agent' | 'machine';
type AssistantSide = Side | 'harness';

/**
 * Which turn an assistant row belongs to. 'harness' = never the supervisor's own words: a harness kind / origin
 * (status card, briefing, ack), no finalize stamp (origin-less harness notices — schedule stopped, hook delivery
 * failed — carry no metadata at all), a provider-error envelope or a harness error note. Otherwise by origin:
 * 'agent' ⇒ the relay side, no origin / 'user' ⇒ the owner side, anything else ⇒ the machine side; a row marked
 * preempted (only machine runs are) is machine-side whatever its origin. Pure.
 */
function assistantSide(r: OwnerTurnRow): AssistantSide {
  if (isHarnessAssistantRow(r)) return 'harness';
  const m = metaOf(r);
  if (!hasFinalizeStamp(m) || m.providerError || isHarnessErrorNote(String(r.content ?? ''))) return 'harness';
  const origin = m.origin;
  if (origin === 'agent') return 'agent';
  if (origin && origin !== 'user') return 'machine';
  // Round-3 review (2026-10-23): an origin-less preempted row is a turn-continuation round (continuations drop
  // their origin and persist no user row) — the follow-through of the newest OWNER turn, never an earlier wake's
  // partial (isSupervisorReplyRow still refuses it as the reply). Any other origin-less preempted row stays machine.
  return m.preempted === true && m.kind !== CONTINUATION_RESULT_KIND ? 'machine' : 'owner';
}

/**
 * A harness row worth one line on an owner turn (round-3 review): an assistant row the harness posted with NO
 * origin and NO finalize stamp (hook delivery died, a schedule stopped / parked, the daily-cap pause, a failed
 * follow-through round). Status cards / briefings / acks (a harness kind or origin) stay snapshots — dropped. Pure.
 */
function isHarnessNotice(r: OwnerTurnRow): boolean {
  if (r.role !== 'assistant' || isHarnessAssistantRow(r)) return false;
  const m = metaOf(r);
  if (hasFinalizeStamp(m) || m.providerError) return false;
  if (m.origin && m.origin !== 'user') return false;
  if (typeof m.kind === 'string' && MACHINE_NOTE_KINDS.has(m.kind)) return false; // a status card, never a notice
  return String(r.content ?? '').trim().length > 0;
}

/** One redacted line for a harness notice: when, who wrote it (never the supervisor), its first ~280 chars. Pure. */
function noticeLine(r: OwnerTurnRow): string {
  const ms = toMs(r.createdAt);
  const when = Number.isFinite(ms) ? ` ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
  const { text, cut } = redactInboundHead(r.content, OWNER_TURN_NOTICE_MAX_CHARS);
  const body = clipLine(text, OWNER_TURN_NOTICE_MAX_CHARS);
  return `${OWNER_TURN_NOTICE_PREFIX}${when} — posted by the harness, not written by you and not a reply to the owner] ${body}${cut && !body.endsWith('…') ? '…' : ''}`;
}

type TurnClass = Side | 'orphan' | 'notice';
interface Turn { users: OwnerTurnRow[]; assistants: OwnerTurnRow[]; cls: TurnClass; closed: boolean; out: ConversationRow[]; chars: number }

/**
 * Chronological rows → turns. A user row joins the open turn only when it has the SAME provenance and nothing
 * answered or closed that turn yet (two owner lines before one reply stay one exchange; a wake never folds into
 * a relay). A model-written assistant row joins the newest turn of its side; harness rows close the newest turn —
 * a harness NOTICE (isHarnessNotice) becomes its own 'notice' pseudo-turn in position (no user row, never a side
 * any assistant row joins), every other harness row is counted and dropped. Pure; linear apart from the side
 * lookup (newest-first, short in practice).
 */
function segmentTurns(rows: ReadonlyArray<OwnerTurnRow>): { turns: Turn[]; harnessRowsDropped: number } {
  const turns: Turn[] = [];
  let harnessRowsDropped = 0;
  const newTurn = (cls: TurnClass): Turn => ({ users: [], assistants: [], cls, closed: false, out: [], chars: 0 });
  for (const r of rows) {
    if (r?.role === 'user') {
      const cls = classifyOwnerTurnUserRow(r);
      const last = turns[turns.length - 1];
      if (last && last.cls === cls && !last.closed && last.assistants.length === 0) last.users.push(r);
      else { const t = newTurn(cls); t.users.push(r); turns.push(t); }
    } else if (r?.role === 'assistant') {
      const side = assistantSide(r);
      if (side === 'harness') {
        const last = turns[turns.length - 1];
        if (last) last.closed = true;
        if (isHarnessNotice(r)) { const t = newTurn('notice'); t.assistants.push(r); t.closed = true; turns.push(t); } else harnessRowsDropped += 1;
        continue;
      }
      let target: Turn | undefined;
      for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i].cls === side) { target = turns[i]; break; }
      if (!target) { target = newTurn('orphan'); turns.push(target); }
      target.assistants.push(r);
    }
  }
  return { turns, harnessRowsDropped };
}

// ── The owner-turn history ──────────────────────────────────────────────────

export interface OwnerTurnHistoryStats {
  rows: number;
  turns: number;
  ownerTurns: number;
  ownerTurnsKept: number;
  wakeTurns: number;
  wakeNotesKept: number;
  relayTurns: number;
  relaysKept: number;
  /** Harness notices kept as one-line entries (round-3 review; the rest are counted in harnessRowsDropped). */
  noticesKept: number;
  harnessRowsDropped: number;
  droppedForBudget: number;
  chars: number;
}

export interface OwnerTurnHistory {
  history: ConversationRow[];
  /** Ids of the owner rows the history carries verbatim (the thread block shortens those). */
  ownerRowIds: string[];
  stats: OwnerTurnHistoryStats;
}

/**
 * The owner turn's history over a chronological window of transcript rows:
 * every owner turn (owner rows clipped to OWNER_ROW_MAX_CHARS, its own replies
 * to OWNER_REPLY_MAX_CHARS — OWNER_TURN_NO_REPLY when its run left none), the
 * newest `notes` machine turns that carry a note (prompt → OWNER_TURN_ELIDED_WAKE
 * stub, naming the trigger when the row kept one; note clipped, a preempted
 * wake's partial marked), the newest `relays` answered agent relays (both
 * sides clipped to OWNER_TURN_RELAY_MAX_CHARS), the newest `notices` harness
 * notices as one line each in position (round-3 review — never paired with an
 * owner row: every kept owner turn already ends in its reply or
 * OWNER_TURN_NO_REPLY); every other harness row is dropped. A preempted
 * follow-through round stays in its owner exchange, marked partial. Every
 * text is redacted before it is clipped. Over the char budget, relays and
 * notices go first, then machine notes, then the oldest owner turns — a final
 * pass bounds the total whatever the input. Pure.
 */
export function selectOwnerTurnHistory(
  rows: ReadonlyArray<OwnerTurnRow>,
  opts: { charBudget?: number; notes?: number; relays?: number; notices?: number; pendingNote?: string } = {},
): OwnerTurnHistory {
  const notesMax = Math.max(0, opts.notes ?? OWNER_TURN_NOTES);
  const relaysMax = Math.max(0, opts.relays ?? OWNER_TURN_RELAYS);
  const noticesMax = Math.max(0, opts.notices ?? OWNER_TURN_NOTICES);
  const pendingNote = String(opts.pendingNote ?? '');
  const budget = Math.max(1000, (opts.charBudget ?? OWNER_HISTORY_CHAR_BUDGET) - pendingNote.length);
  const { turns, harnessRowsDropped } = segmentTurns(rows);
  const noticeTurns = turns.filter((t) => t.cls === 'notice').length;
  const stats: OwnerTurnHistoryStats = {
    rows: rows.length, turns: turns.length - noticeTurns, ownerTurns: 0, ownerTurnsKept: 0, wakeTurns: 0, wakeNotesKept: 0,
    relayTurns: 0, relaysKept: 0, noticesKept: 0, harnessRowsDropped, droppedForBudget: 0, chars: 0,
  };
  stats.ownerTurns = turns.filter((t) => t.cls === 'owner').length;
  stats.wakeTurns = turns.filter((t) => t.cls === 'machine').length;
  stats.relayTurns = turns.filter((t) => t.cls === 'agent').length;

  const keep = new Set<number>();
  turns.forEach((t, i) => { if (t.cls === 'owner') keep.add(i); });
  let notes = 0;
  let relays = 0;
  let notices = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (!t.assistants.length) continue;
    if ((t.cls === 'machine' || t.cls === 'orphan') && notes < notesMax) { keep.add(i); notes += 1; }
    else if (t.cls === 'agent' && relays < relaysMax) { keep.add(i); relays += 1; }
    else if (t.cls === 'notice' && notices < noticesMax) { keep.add(i); notices += 1; }
  }

  for (const i of keep) {
    const t = turns[i];
    const out: ConversationRow[] = [];
    if (t.cls === 'owner') {
      out.push({ role: 'user', content: t.users.map((u) => redactClip(u.content, OWNER_ROW_MAX_CHARS)).join('\n\n') });
      if (t.assistants.length) {
        for (const a of t.assistants) {
          // Round-3 review: a follow-through round the owner's next message preempted is said to be partial.
          const preempted = metaOf(a).preempted === true;
          out.push({ role: 'assistant', content: `${preempted ? OWNER_TURN_PREEMPTED_FOLLOW_THROUGH : ''}${redactClip(a.content, OWNER_REPLY_MAX_CHARS)}` });
        }
      } else out.push({ role: 'assistant', content: OWNER_TURN_NO_REPLY });
    } else if (t.cls === 'notice') {
      out.push({ role: 'assistant', content: noticeLine(t.assistants[0]) });
    } else if (t.cls === 'agent') {
      out.push({ role: 'user', content: t.users.map((u) => redactClip(u.content, OWNER_TURN_RELAY_MAX_CHARS)).join('\n\n') });
      for (const a of t.assistants) out.push({ role: 'assistant', content: redactClip(a.content, OWNER_TURN_RELAY_MAX_CHARS) });
    } else {
      if (t.users.length) out.push({ role: 'user', content: wakeStub(t.users) });
      for (const a of t.assistants) {
        const preempted = metaOf(a).preempted === true;
        out.push({ role: 'assistant', content: `${preempted ? OWNER_TURN_PREEMPTED_NOTE : ''}${redactClip(a.content, OWNER_TURN_NOTE_MAX_CHARS)}` });
      }
    }
    t.out = out;
    t.chars = out.reduce((n, m) => n + m.content.length, 0);
  }

  // Over budget: relays and notices first, then machine notes, then the oldest owner turns (never the last turn standing).
  const prio = (c: TurnClass): number => (c === 'agent' || c === 'notice' ? 0 : c === 'owner' ? 2 : 1);
  let total = [...keep].reduce((n, i) => n + turns[i].chars, 0);
  const dropOrder = [...keep].sort((a, b) => prio(turns[a].cls) - prio(turns[b].cls) || a - b);
  for (const i of dropOrder) {
    if (total <= budget || keep.size <= 1) break;
    keep.delete(i);
    total -= turns[i].chars;
    stats.droppedForBudget += 1;
  }

  const kept = [...keep].sort((a, b) => a - b);
  const history: ConversationRow[] = kept.flatMap((i) => turns[i].out);
  const ownerRowIds = kept.flatMap((i) => (turns[i].cls === 'owner' ? turns[i].users.filter((u) => u.id).map((u) => String(u.id)) : []));
  // Final bound (pathological input: one turn bigger than the whole budget).
  while (total > budget && history.length > 1) total -= history.shift()!.content.length;
  if (total > budget && history.length === 1) {
    history[0] = { ...history[0], content: clipKeep(history[0].content, Math.max(0, budget - 20)) };
    total = history[0].content.length;
  }
  if (pendingNote) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role !== 'assistant') continue;
      if (!history[i].content.includes(PENDING_NOTE_MARKER)) { history[i] = { ...history[i], content: `${history[i].content}\n\n${pendingNote}` }; total += pendingNote.length + 2; }
      break;
    }
  }
  stats.ownerTurnsKept = kept.filter((i) => turns[i].cls === 'owner').length;
  stats.wakeNotesKept = kept.filter((i) => turns[i].cls === 'machine' || turns[i].cls === 'orphan').length;
  stats.relaysKept = kept.filter((i) => turns[i].cls === 'agent').length;
  stats.noticesKept = kept.filter((i) => turns[i].cls === 'notice').length;
  stats.harnessRowsDropped = harnessRowsDropped + (noticeTurns - stats.noticesKept);
  stats.chars = total;
  return { history, ownerRowIds, stats };
}

// ── [OWNER THREAD — last 48 h] ──────────────────────────────────────────────

export interface OwnerThreadEntry {
  id?: string;
  at: string;
  text: string;
  reply: string | null;
  /** An earlier owner line of an exchange the supervisor answered once, after the later line. */
  withNext?: boolean;
}

/**
 * Every owner-typed row of the window (chronological rows in, oldest first
 * out), each paired with ITS reply: the first row of the owner's own turn
 * that isSupervisorReplyRow accepts (an origin-less harness notice, an error
 * envelope, a bare no-op close or a preempted wake's partial never is). Two
 * owner lines before one reply: the reply pairs with the later line, the
 * earlier carries `withNext`. Text and reply are redacted. Pure.
 */
export function ownerThreadEntriesFromRows(rows: ReadonlyArray<OwnerTurnRow>, now: Date, windowMs: number = OWNER_THREAD_WINDOW_MS): OwnerThreadEntry[] {
  const floor = now.getTime() - windowMs;
  const out: OwnerThreadEntry[] = [];
  for (const t of segmentTurns(rows).turns) {
    if (t.cls !== 'owner') continue;
    const replyRow = t.assistants.find((a) => isSupervisorReplyRow({ content: a.content, metadata: metaOf(a) }));
    const reply = replyRow ? redactInboundSecrets(String(replyRow.content ?? '')) : null;
    t.users.forEach((r, k) => {
      const ms = toMs(r.createdAt);
      if (!Number.isFinite(ms) || ms < floor) return;
      const last = k === t.users.length - 1;
      out.push({
        ...(r.id ? { id: String(r.id) } : {}),
        at: new Date(ms).toISOString(),
        text: redactInboundSecrets(String(r.content ?? '')),
        reply: last ? reply : null,
        ...(!last && reply ? { withNext: true } : {}),
      });
    });
  }
  return out;
}

function ageOf(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The compact [OWNER THREAD — last 48 h] block (≤ maxChars, '' when the
 * window holds no owner message). Owner words win the space: over budget, the
 * entries the history already carries verbatim shrink first, then older reply
 * heads and owner lines shrink, then replies go, and only then are the oldest
 * entries dropped (counted in one line). Newest last. Linear in the entry
 * count (review 2026-10-23 item 5): each line's length is kept and adjusted
 * on reshape — never a full re-render per probe. Pure.
 */
export function renderOwnerThreadBlock(
  entries: ReadonlyArray<OwnerThreadEntry>,
  now: Date,
  opts: { maxChars?: number; inHistoryIds?: ReadonlySet<string> | ReadonlyArray<string> } = {},
): string {
  const n = entries.length;
  if (!n) return '';
  const maxChars = opts.maxChars ?? OWNER_THREAD_MAX_CHARS;
  const inHistory = new Set(opts.inHistoryIds ?? []);
  const header = `${OWNER_THREAD_HEADING}: every message the owner typed in this chat, oldest first (newest last), each with the head of the reply that followed. Harness-built from the transcript — the owner's own words. Your transcript history keeps owner turns, your latest notes and the newest agent relays (wake prompts elided); get_chat_messages reads any row in full.]`;
  type Shape = { owner: number; reply: number; mark: boolean };
  const shapes: Shape[] = entries.map(() => ({ owner: OWNER_THREAD_ROW_MAX_CHARS, reply: OWNER_THREAD_REPLY_MAX_CHARS, mark: false }));
  // Whitespace-collapsed once per entry (clipLine on every probe re-scanned the full text).
  const norm = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
  const texts = entries.map((e) => norm(e.text));
  const replies = entries.map((e) => (e.reply ? norm(e.reply) : ''));
  const clipN = (s: string, k: number): string => (s.length > k ? `${s.slice(0, Math.max(0, k - 1))}…` : s);
  const stamps = entries.map((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) ? `${e.at.slice(5, 10)} ${e.at.slice(11, 16)}Z (${ageOf(now.getTime() - t)} ago)` : '?';
  });
  const line = (i: number): string => {
    const s = shapes[i];
    const e = entries[i];
    const reply = s.reply <= 0 ? '' : `\n  ↳ you: ${e.reply ? `"${clipN(replies[i], s.reply)}"` : e.withNext ? '(answered with the next message)' : '(no reply recorded)'}`;
    return `- ${stamps[i]} OWNER: "${clipN(texts[i], s.owner)}"${s.mark ? ' (verbatim in your history)' : ''}${reply}`;
  };
  const lens = new Array<number>(n);
  let total = header.length;
  for (let i = 0; i < n; i += 1) { lens[i] = line(i).length; total += 1 + lens[i]; }
  const reshape = (i: number): void => { const l = line(i).length; total += l - lens[i]; lens[i] = l; };
  // Shrink ladder (each step only while still over budget).
  const isOld = (i: number): boolean => !inHistory.has(String(entries[i].id ?? '')) && i < n - 1;
  const steps: Array<(i: number) => boolean> = [
    (i) => { if (!inHistory.has(String(entries[i].id ?? ''))) return false; shapes[i] = { owner: 160, reply: 0, mark: true }; return true; },
    (i) => { if (!isOld(i)) return false; shapes[i].reply = Math.min(shapes[i].reply, 120); return true; },
    (i) => { if (!isOld(i)) return false; shapes[i].owner = Math.min(shapes[i].owner, 300); return true; },
    (i) => { if (!isOld(i)) return false; shapes[i].reply = 0; return true; },
  ];
  for (const step of steps) {
    if (total <= maxChars) break;
    for (let i = 0; i < n && total > maxChars; i += 1) if (step(i)) reshape(i);
  }
  let from = 0;
  let size = total; // header + the lines from `from` on
  const omitted = (k: number): string => `(${k} older owner message(s) in the last 48 h not shown — get_chat_messages reads them.)`;
  while (from < n - 1 && size + (from ? omitted(from).length + 1 : 0) > maxChars) { size -= 1 + lens[from]; from += 1; }
  const lines: string[] = [];
  for (let i = from; i < n; i += 1) lines.push(line(i));
  let block = [header, ...(from ? [omitted(from)] : []), ...lines].join('\n');
  if (block.length > maxChars) block = `${block.slice(0, maxChars - 1)}…`;
  return block;
}
