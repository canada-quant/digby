/**
 * Typed `finish_run` — the SHADOW stage (build 2026-10-08 F-1; design: the
 * 2026-10-08 finish-run deep dive, "Option C, staged", Stage 1).
 *
 * WHY: a machine run's "what I did" lives in prose today, and ~13.6k lines of
 * miners guess at it after the fact (evidence guard ≈ 29 % precise, the clock
 * lane ≈ 3 %, numeric_provenance ≈ 9 %). The typed path already half-works —
 * 27 % of coding finals carry the optional ```claims fence and 71 % of those
 * verify — but supervisors never use it (0 of 1,957 notes) and every
 * unverified fence entry hand-checked was a TRUE claim the fence ontology
 * rejected (a merged-only PR typed `pr`, a PR opened in the previous run, a
 * schedule arm typed `dispatch`, an email typed `message_sent`).
 *
 * WHAT THIS STAGE DOES (and nothing more):
 *  - OFFERS a typed `finish_run({status, summary, claims[{type, ref, scope?,
 *    note?}], open_items[{text, kind?, ref?}]})` tool to top-level MACHINE runs
 *    of coding lanes and supervisors (finishRunEligible). The tool answers a
 *    fixed acknowledgement (FINISH_RUN_ACK) that echoes nothing the model
 *    wrote — it can never launder a quote or an id into a tool-output haystack.
 *  - VERIFIES every claim against the harness's own receipts with an ontology
 *    typed for the REAL receipt shapes (verifyFinishClaims): a merged-only PR
 *    is a pr_opened too, an earlier run of this chat is `session` scope
 *    (≤ 24 h, marked carried), a lane receipt printed by get_run_receipts this
 *    run is `relayed`, schedule arms / emails / file paths have their own types.
 *  - NUDGES once (agent.ts, post-loop) when a run ends without the call, with a
 *    single isolated model turn whose output is NEVER delivered; still missing
 *    ⇒ an AUTO-FINISH built from receipts only (autoFinishClaims), never from
 *    prose.
 *  - RECORDS one `finish_run` loop_metrics row per eligible run (finishRunMeta)
 *    and, at the finalize seams, one `finish_run_agreement` row comparing it with
 *    what the old prose detectors said about the SAME final
 *    (finishRunAgreementMeta).
 *
 * WHAT IT NEVER DOES: block, rewrite, bounce, or edit the delivered answer /
 * an owner note; delete or demote any old detector. (Stage 1 never told the
 * model which claims failed; stage 2 — FA-3 below — does, in-loop only.)
 *
 * Kill switch: FINISH_RUN_DISABLED=1 (no tool, no nudge, no rows — byte-
 * identical to before); FINISH_RUN_ACT=off keeps the shadow stage (the fixed
 * ACK, no in-loop error). DEPENDENCY-FREE leaf (run-receipts discipline): no
 * prisma, no logger, no config; pure and deterministic; never throws.
 *
 * build 2026-10-09 FR (claim-checker gaps, still SHADOW — nothing is blocked,
 * rewritten or bounced). The 2026-10-09 00:00–24:00Z replay of every rejected
 * claim (179 on 114 of 362 finishes) found most rejections were the checker's
 * gaps, not unbacked claims:
 *  - wrong_type (the ref IS a real receipt of another type) ⇒ a TYPE REPAIR:
 *    the finish stays valid, `repairs[]` carries {from, to, ref, reason:
 *    'wrong_type'} so the doctrine can be tuned. Suggestions are REF-BOUND
 *    only (the descriptive "verify <anything> + a passed verify" rule never
 *    suggests), mutation types are tried before verify, and a mutation claim
 *    whose ref this run only READ is `observed_only` — still rejected.
 *  - `state_update` (new type): supervisor-state saves, archives, owner
 *    questions, cards, stopped runs, watched resources — tools that mint no
 *    receipt or a receipt with empty ids (update_supervisor_state,
 *    archive_chat, flag_owner_question, …) are read on the executed tier.
 *  - decorated refs ("ec533e98 (f108 state …)", "goal <uuid>", "PR #19 o/r",
 *    "branch@sha") are matched on the id tokens inside them.
 *  - notify_user is a message_sent; schedule_self a schedule_armed; a raw-shell
 *    `git commit` / `git push` (run_command) proves the shas git printed.
 *  - an observation read (get_chat_status / goal_get / list_* …) proves a
 *    `verify` of the id it was called with (the in-memory receipt heads).
 *
 * build 2026-10-11 FA (supervisor "verify of something I read" + stage 2 act):
 *  - FA-1 the READ INDEX (FinishReadIndex): every READ tool this run called (the platform read set, the
 *    observation set, connector reads — isFinishReadTool) feeds a bounded index of the ids its ARGUMENTS
 *    carried and the ids its RESULT returned (uuids, oq_/cf_ ids, digit-bearing hex — 8-hex prefix-tolerant —
 *    PR numbers, CI run ids). A `verify` claim is backed when its ref (or an id token inside it) is in that
 *    index as it stood at the call, or names a read tool this run called / a decision purpose the
 *    decision-status read returned. Measured 2026-10-10..11: 83 of the 117 rejected supervisor verify claims
 *    were ids the supervisor HAD read (get_chat_messages / list_owner_questions / get_fleet_telemetry /
 *    github_list_prs results) but the 200-char receipt heads never carried. Anything never seen this run
 *    (an id the wake prompt or the injected state carried, an id only written into a state save) stays
 *    rejected; a mutation claim on an id only READ is `observed_only` as before.
 *  - FA-2 answer_owner_question / ack_digest_item / unack_digest_item join the state_update executed tier
 *    (they mint no receipt; ack_digest_item's id rides its `key` arg).
 *  - FA-3 stage 2 ACT (soft): an IN-LOOP finish_run whose claims fail the check is answered with which
 *    claims failed, why and the fix (finishRunCorrectionText — claims by index, never echoing a ref) and ONE
 *    chance to call again; the next call (or none) ends it. The delivered final is never blocked, rewritten
 *    or annotated; the nudge / auto-finish paths are unchanged (a nudged call is never corrected — the
 *    nudge IS that run's one extra turn). FINISH_RUN_ACT = off | seats | on (default on — owner
 *    2026-10-11 "turn everything remaining on"); seats acts only on a seat whose measured 7-day valid rate
 *    is ≥ FINISH_RUN_ACT_SEAT_BAR (coding/finish-run-act.ts). Telemetry on the finish_run row:
 *    actMode / actApplied / inLoopError / rejectedOnFirst / correctedOnSecond / extraTurnMs.
 */

import { refNamesPrNumber, refNamesSha } from './claims-block';
import { PLATFORM_OBSERVE_TOOLS } from './evidence-tools';
import { PLATFORM_READ_TOOLS } from '../platform/platform-tool-names';

// ── Identity ────────────────────────────────────────────────────────────────

export const FINISH_RUN_TOOL = 'finish_run';
/** loop_metrics kinds (mirrored in LOOP_METRIC_KINDS.FINISH_RUN / FINISH_RUN_AGREEMENT — a test pins equality). */
export const FINISH_RUN_METRIC = 'finish_run';
export const FINISH_RUN_AGREEMENT_METRIC = 'finish_run_agreement';
/** The isolated nudge turn's wall-clock bound (a timeout ⇒ auto-finish, recorded). */
export const FINISH_RUN_NUDGE_TIMEOUT_MS = 120_000;
/** The nudge turn lowers an effort the seat ALREADY sends to this level (effort-cap.ts never adds the param). */
export const FINISH_RUN_NUDGE_EFFORT_CAP = 'high' as const;
/** A flood of claims must not soak the matcher (claims-block parity). */
export const MAX_FINISH_CLAIMS = 25;
export const MAX_FINISH_OPEN_ITEMS = 25;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** FINISH_RUN_DISABLED=1|true|on — the whole feature off (read per call). */
export function finishRunDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.FINISH_RUN_DISABLED);
}

/**
 * Who is offered finish_run: a TOP-LEVEL loop (never a delegate worker, a
 * helper fast seat or an anonymous chat) of a MACHINE-triggered or owner-
 * dispatched run (nobody is waiting live — human turns keep their latency and
 * streaming, as the design says) on a coding lane or a supervisor seat.
 */
export function finishRunEligible(o: {
  topLevel: boolean;
  role?: string | null;
  fastSeat?: boolean;
  sessionId: string;
  machineTriggered?: boolean;
  ownerDispatch?: boolean;
  profileKind: string;
  supervisorTools?: boolean;
}, env: NodeJS.ProcessEnv = process.env): boolean {
  if (finishRunDisabled(env)) return false;
  if (!o.topLevel || o.role || o.fastSeat) return false;
  if (!o.sessionId || o.sessionId.startsWith('anon-')) return false;
  if (o.machineTriggered !== true && o.ownerDispatch !== true) return false;
  return o.profileKind === 'coding' || o.supervisorTools === true;
}

// ── Stage 2 act mode (build 2026-10-11 FA-3 / FA-4) ─────────────────────────

/**
 * FINISH_RUN_ACT — off | seats | on. UNSET = on (owner 2026-10-11: "turn everything remaining on").
 * off/0/false/no/shadow ⇒ the shadow stage exactly (fixed ACK, no in-loop error); seats ⇒ act only on a seat
 * whose measured 7-day valid rate meets FINISH_RUN_ACT_SEAT_BAR (fail-safe: shadow); anything else ⇒ on.
 * Read per call (no cache) like FINISH_RUN_DISABLED.
 */
export type FinishRunActMode = 'off' | 'seats' | 'on';
export function finishRunActMode(env: NodeJS.ProcessEnv = process.env): FinishRunActMode {
  const s = String(env.FINISH_RUN_ACT ?? '').trim().toLowerCase();
  if (!s) return 'on';
  if (['off', '0', 'false', 'no', 'shadow', 'disabled'].includes(s)) return 'off';
  if (s === 'seats' || s === 'seat') return 'seats';
  return 'on';
}

/** seats mode: a seat acts when its 7-day finish_run valid rate (valid within one nudge, auto-finishes count as misses) ≥ this… */
export const FINISH_RUN_ACT_SEAT_BAR = 0.95;
/** …over at least this many finish_run rows (fewer ⇒ unmeasured ⇒ shadow). */
export const FINISH_RUN_ACT_SEAT_MIN_RUNS = 20;

export interface FinishActDecision {
  mode: FinishRunActMode;
  act: boolean;
  /** on | off | seat_meets_bar | seat_below_bar | seat_sample_small | seat_unmeasured | seat_stats_unavailable | error */
  reason: string;
  seatRate?: number;
  seatRuns?: number;
}

/** The act decision for one seat (pure). `stat` = that seat's 7-day {runs, valid}; null/undefined ⇒ unmeasured. */
export function finishRunActDecision(mode: FinishRunActMode, stat?: { runs: number; valid: number } | null, statsAvailable = true): FinishActDecision {
  if (mode === 'off') return { mode, act: false, reason: 'off' };
  if (mode === 'on') return { mode, act: true, reason: 'on' };
  if (!statsAvailable) return { mode, act: false, reason: 'seat_stats_unavailable' };
  if (!stat || !(stat.runs > 0)) return { mode, act: false, reason: 'seat_unmeasured' };
  const seatRate = Math.round((stat.valid / stat.runs) * 1000) / 1000;
  const base = { mode, seatRate, seatRuns: stat.runs };
  if (stat.runs < FINISH_RUN_ACT_SEAT_MIN_RUNS) return { ...base, act: false, reason: 'seat_sample_small' };
  return seatRate >= FINISH_RUN_ACT_SEAT_BAR ? { ...base, act: true, reason: 'seat_meets_bar' } : { ...base, act: false, reason: 'seat_below_bar' };
}

// ── Contract vocabulary ─────────────────────────────────────────────────────

export const FINISH_RUN_STATUSES = ['done', 'partial', 'blocked', 'no_op'] as const;
export type FinishStatus = (typeof FINISH_RUN_STATUSES)[number];

export const FINISH_CLAIM_TYPES = [
  'push', 'commit', 'pr_opened', 'pr_merged', 'deploy', 'verify', 'ticket_update',
  'message_sent', 'dispatch', 'schedule_armed', 'email_sent', 'file_change',
  // build 2026-10-09 FR-3: supervisor state / housekeeping (state save, archive, owner question, card, stopped run).
  'state_update',
] as const;
export type FinishClaimType = (typeof FINISH_CLAIM_TYPES)[number];

export const FINISH_SCOPES = ['this_run', 'session', 'relayed'] as const;
export type FinishScope = (typeof FINISH_SCOPES)[number];

export const FINISH_OPEN_ITEM_KINDS = ['next_step', 'needs_owner', 'blocked_on'] as const;
export type FinishOpenItemKind = (typeof FINISH_OPEN_ITEM_KINDS)[number];

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Forgiving aliases (case-insensitive, spaces/hyphens → _) — the names models actually wrote in the fence. */
const TYPE_ALIASES: Record<string, FinishClaimType> = {
  push: 'push', pushed: 'push', git_push: 'push',
  commit: 'commit', committed: 'commit', git_commit: 'commit',
  pr: 'pr_opened', pr_opened: 'pr_opened', pr_created: 'pr_opened', pull_request: 'pr_opened', open_pr: 'pr_opened', opened_pr: 'pr_opened', pr_open: 'pr_opened',
  merge: 'pr_merged', merged: 'pr_merged', pr_merged: 'pr_merged', merge_pr: 'pr_merged', pr_merge: 'pr_merged',
  deploy: 'deploy', deployed: 'deploy', deployment: 'deploy',
  verify: 'verify', verified: 'verify', test: 'verify', tests: 'verify', check: 'verify', checks: 'verify', ci: 'verify',
  ticket_update: 'ticket_update', ticket: 'ticket_update', feedback: 'ticket_update', todo: 'ticket_update', todo_update: 'ticket_update',
  goal: 'ticket_update', goal_update: 'ticket_update', board_update: 'ticket_update', todo_done: 'ticket_update',
  message_sent: 'message_sent', message: 'message_sent', sent: 'message_sent', send: 'message_sent', steer: 'message_sent', reply: 'message_sent',
  dispatch: 'dispatch', dispatched: 'dispatch', spawn: 'dispatch', spawned: 'dispatch', session_started: 'dispatch', delegate: 'dispatch', delegated: 'dispatch',
  schedule_armed: 'schedule_armed', schedule: 'schedule_armed', scheduled: 'schedule_armed', schedule_update: 'schedule_armed', schedule_message: 'schedule_armed',
  email_sent: 'email_sent', email: 'email_sent', mail: 'email_sent', emailed: 'email_sent',
  file_change: 'file_change', file: 'file_change', file_write: 'file_change', write: 'file_change', edit: 'file_change', changed: 'file_change',
  state_update: 'state_update', state: 'state_update', state_save: 'state_update', supervisor_state: 'state_update',
  save_supervisor_state: 'state_update', update_supervisor_state: 'state_update', archive: 'state_update', archived: 'state_update',
};

const STATUS_ALIASES: Record<string, FinishStatus> = {
  done: 'done', complete: 'done', completed: 'done', success: 'done', ok: 'done',
  partial: 'partial', partially_done: 'partial', in_progress: 'partial',
  blocked: 'blocked', failed: 'blocked', stuck: 'blocked',
  no_op: 'no_op', noop: 'no_op', nothing: 'no_op', idle: 'no_op', none: 'no_op',
};

const SCOPE_ALIASES: Record<string, FinishScope> = {
  this_run: 'this_run', run: 'this_run', current: 'this_run',
  session: 'session', earlier: 'session', carried: 'session', previous_run: 'session', prior: 'session',
  relayed: 'relayed', relay: 'relayed', lane: 'relayed', other_chat: 'relayed',
};

const OPEN_KIND_ALIASES: Record<string, FinishOpenItemKind> = {
  next_step: 'next_step', next: 'next_step', todo: 'next_step',
  needs_owner: 'needs_owner', owner: 'needs_owner', ask_owner: 'needs_owner',
  blocked_on: 'blocked_on', blocked: 'blocked_on', blocker: 'blocked_on', waiting: 'blocked_on',
};

/** Edit distance bounded to `max` (returns max+1 past it) — the did-you-mean helper. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The nearest canonical claim type for an unknown spelling (≤ 3 edits), else null. */
export function didYouMeanClaimType(raw: string): FinishClaimType | null {
  const n = norm(raw);
  if (!n) return null;
  let best: FinishClaimType | null = null;
  let bestD = 4;
  for (const key of Object.keys(TYPE_ALIASES)) {
    const d = editDistance(n, key, 3);
    if (d < bestD) { bestD = d; best = TYPE_ALIASES[key]; }
  }
  return best;
}

// ── The tool schema + the harness texts ─────────────────────────────────────

export const FINISH_RUN_SCHEMA = {
  type: 'function',
  function: {
    name: FINISH_RUN_TOOL,
    description:
      'Record how this machine-triggered run ended, as typed data the harness checks against its own tool receipts. '
      + 'Call it ONCE as your LAST tool call, right before your final answer — then write your final answer in full, exactly as you normally would '
      + '(finish_run is NOT delivered to anyone and replaces nothing you write, including any claims fence). '
      + 'claims: one entry per thing you DID, each with the receipt-visible id it rests on — push (commit sha or branch), commit (sha; local, not pushed), '
      + 'pr_opened (PR number), pr_merged (PR number or merge sha), verify (the verify tool receipt, a run_command receipt id, or the id a read you made this run checked), '
      + 'ticket_update (ticket / goal / todo id), message_sent (receipt id, message id, the chat you messaged, or the Telegram handle notify_user reached), dispatch (session or task id), '
      + 'schedule_armed (schedule id), email_sent (recipient), file_change (path or commit sha), deploy (run id or sha), '
      + 'state_update (your supervisor-state save, an archive, an owner question, a card or a stopped run — its id, or "supervisor_state"). '
      + 'The ref is the bare id, no extra words. An id you only READ is a verify, never a ticket_update or schedule_armed. '
      + 'scope: this_run (default), session (an earlier run of THIS chat, last 24 h) or relayed (a receipt you read with get_run_receipts this run). '
      + 'open_items: everything NOT done — next steps, what needs the owner, what you are blocked on. Listing work as open is always fine; never claim what you did not execute.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...FINISH_RUN_STATUSES], description: 'done | partial | blocked | no_op (nothing needed doing).' },
        summary: { type: 'string', description: '2–5 sentences: what this run did and found.' },
        claims: {
          type: 'array',
          description: 'Completion claims, each bound to a receipt-visible ref. Empty when nothing was done.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: [...FINISH_CLAIM_TYPES] },
              ref: { type: 'string', description: 'The bare id the receipt carries: sha, PR number, receipt id, ticket/goal/todo id, schedule id, session/chat id, path.' },
              scope: { type: 'string', enum: [...FINISH_SCOPES] },
              note: { type: 'string' },
            },
            required: ['type', 'ref'],
          },
        },
        open_items: {
          type: 'array',
          description: 'What is NOT done.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              kind: { type: 'string', enum: [...FINISH_OPEN_ITEM_KINDS] },
              ref: { type: 'string' },
            },
            required: ['text'],
          },
        },
      },
      required: ['status', 'summary'],
    },
  },
} as const;

/**
 * The tool's ONLY answer (pinned). Fixed text — it echoes nothing the model
 * wrote (a ref echoed here would sit in the tool-output haystack the evidence
 * guard and the action verifier exonerate against) and states no verdict (no
 * in-loop errors in the shadow stage). No failure marker (looksLikeToolFailure).
 */
export const FINISH_RUN_ACK =
  'finish_run recorded. The harness checks it against this run\'s tool receipts; it is not delivered to anyone and changes nothing you write. '
  + 'Now write your complete final answer exactly as you normally would — that text is what gets delivered. Do not call finish_run again unless your status changes.';

/** The ONE post-loop nudge (user role — ZAI rejects mid-run system messages). Pinned. */
export const FINISH_RUN_NUDGE =
  '[HARNESS NOTICE — not typed by the user] This machine-triggered run ended without a finish_run call. '
  + 'Call finish_run now: status, a short summary, every completion claim with the receipt-visible ref it rests on, and open_items for anything not done. '
  + 'Your answer above is already final and will be delivered exactly as written — reply with the finish_run call only.';

// ── Parsing (forgiving) ─────────────────────────────────────────────────────

export interface FinishClaim {
  type: FinishClaimType;
  /** What the model wrote, when it differed from the canonical type (alias telemetry). */
  rawType?: string;
  ref: string;
  scope?: FinishScope;
  note?: string;
}

export interface FinishOpenItem { text: string; kind: FinishOpenItemKind | null; ref?: string }

export type FinishErrorKind =
  | 'malformed_args' | 'bad_status' | 'missing_summary' | 'unknown_type' | 'missing_ref'
  | 'bad_claim' | 'too_many_claims' | 'bad_open_item';

export interface FinishError { kind: FinishErrorKind; detail: string; index?: number; didYouMean?: string }

export interface ParsedFinishRun {
  status: FinishStatus | null;
  summary: string;
  claims: FinishClaim[];
  /** FA-3: the RAW array position of each parsed claim (claims[i] came from the model's claims[claimIndex[i]]). */
  claimIndex: number[];
  openItems: FinishOpenItem[];
  errors: FinishError[];
  /** Forgiving repairs applied (trailing commas, a stringified array, a single object…). */
  repairs: string[];
}

const stripTrailingCommas = (s: string): string => s.replace(/,\s*([}\]])/g, '$1');

/** Parse a JSON-ish value tolerantly: as-is, trailing commas, then JSONL objects (the 13/16 fence shape). */
function parseJsonish(raw: string, repairs: string[]): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* repairs below */ }
  try { const v = JSON.parse(stripTrailingCommas(text)); repairs.push('trailing_commas'); return v; } catch { /* next */ }
  // One object per line / back-to-back objects ("Unexpected non-whitespace after JSON").
  if (/^\{[\s\S]*\}$/.test(text)) {
    try {
      const v = JSON.parse(`[${stripTrailingCommas(text.replace(/\}\s*\n?\s*\{/g, '},{'))}]`);
      repairs.push('jsonl_objects');
      return v;
    } catch { /* give up */ }
  }
  return undefined;
}

/** An array-shaped field that may arrive stringified / as one object. */
function arrayField(v: unknown, field: string, repairs: string[]): unknown[] | null {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const parsed = parseJsonish(v, repairs);
    if (Array.isArray(parsed)) { repairs.push(`${field}_stringified`); return parsed; }
    if (parsed && typeof parsed === 'object') { repairs.push(`${field}_stringified_object`); return [parsed]; }
    return v.trim() ? null : [];
  }
  if (typeof v === 'object') { repairs.push(`${field}_single_object`); return [v]; }
  return null;
}

/**
 * Parse finish_run arguments (the raw tool-call string or an already-parsed
 * object). Never throws; every problem is an entry in `errors` — a parse
 * problem in one claim never drops the others. A downgrade is never an error:
 * status blocked/partial/no_op with no claims and only open items is valid.
 */
export function parseFinishRunArgs(raw: unknown): ParsedFinishRun {
  const out: ParsedFinishRun = { status: null, summary: '', claims: [], claimIndex: [], openItems: [], errors: [], repairs: [] };
  let obj: unknown = raw;
  if (typeof raw === 'string') obj = parseJsonish(raw, out.repairs);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.errors.push({ kind: 'malformed_args', detail: typeof raw === 'string' ? `arguments are not a JSON object (${String(raw).slice(0, 60)})` : 'arguments are not an object' });
    return out;
  }
  const o = obj as Record<string, unknown>;

  const statusRaw = o.status;
  const st = STATUS_ALIASES[norm(statusRaw)];
  if (st) out.status = st;
  else out.errors.push({ kind: 'bad_status', detail: `status ${JSON.stringify(statusRaw ?? null).slice(0, 40)} is not done | partial | blocked | no_op` });

  out.summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!out.summary) out.errors.push({ kind: 'missing_summary', detail: 'summary is empty' });

  const claims = arrayField(o.claims, 'claims', out.repairs);
  if (claims === null) out.errors.push({ kind: 'bad_claim', detail: 'claims is not an array' });
  else {
    if (claims.length > MAX_FINISH_CLAIMS) out.errors.push({ kind: 'too_many_claims', detail: `${claims.length} claims (max ${MAX_FINISH_CLAIMS}) — only the first ${MAX_FINISH_CLAIMS} are checked` });
    claims.slice(0, MAX_FINISH_CLAIMS).forEach((e, i) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) { out.errors.push({ kind: 'bad_claim', detail: `claim ${i} is not an object`, index: i }); return; }
      const c = e as Record<string, unknown>;
      const rawType = String(c.type ?? '').trim();
      const type = TYPE_ALIASES[norm(rawType)];
      if (!type) {
        const dym = didYouMeanClaimType(rawType);
        out.errors.push({ kind: 'unknown_type', detail: `claim ${i} has unknown type ${JSON.stringify(rawType).slice(0, 40)}`, index: i, ...(dym ? { didYouMean: dym } : {}) });
        return;
      }
      const ref = typeof c.ref === 'string' ? c.ref.trim() : typeof c.ref === 'number' ? String(c.ref) : '';
      if (!ref) { out.errors.push({ kind: 'missing_ref', detail: `claim ${i} (${type}) has no ref`, index: i }); return; }
      const claim: FinishClaim = { type, ref: ref.slice(0, 300) };
      if (norm(rawType) !== type) claim.rawType = rawType.slice(0, 40);
      const scope = SCOPE_ALIASES[norm(c.scope)];
      if (scope) claim.scope = scope;
      if (typeof c.note === 'string' && c.note.trim()) claim.note = c.note.trim().slice(0, 300);
      out.claims.push(claim);
      out.claimIndex.push(i);
    });
  }

  const items = arrayField(o.open_items ?? o.openItems, 'open_items', out.repairs);
  if (items === null) out.errors.push({ kind: 'bad_open_item', detail: 'open_items is not an array' });
  else {
    items.slice(0, MAX_FINISH_OPEN_ITEMS).forEach((e, i) => {
      if (typeof e === 'string' && e.trim()) { out.openItems.push({ text: e.trim().slice(0, 300), kind: null }); return; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) { out.errors.push({ kind: 'bad_open_item', detail: `open item ${i} is not an object`, index: i }); return; }
      const it = e as Record<string, unknown>;
      const text = typeof it.text === 'string' ? it.text.trim() : '';
      if (!text) { out.errors.push({ kind: 'bad_open_item', detail: `open item ${i} has no text`, index: i }); return; }
      const item: FinishOpenItem = { text: text.slice(0, 300), kind: OPEN_KIND_ALIASES[norm(it.kind)] ?? null };
      const ref = typeof it.ref === 'string' ? it.ref.trim() : typeof it.ref === 'number' ? String(it.ref) : '';
      if (ref) item.ref = ref.slice(0, 120);
      out.openItems.push(item);
    });
  }
  return out;
}

// ── Evidence + verification ─────────────────────────────────────────────────

/**
 * The receipt fields verification reads (ToolReceipt and a get_run_receipts row both fit). argsHead /
 * resultHead are the scrubbed in-memory heads THIS run's receipts carry (run-receipts E8 — never on a DB
 * row): build 2026-10-09 FR-8 reads their id-keyed fields, so a receipt whose ids envelope is empty
 * (dismiss_owner_question, cancel_confirmation, an observation read) still names what it acted on.
 */
export interface ReceiptLike { id: string; tool: string; ok: boolean; ids: Record<string, unknown>; argsHead?: string; resultHead?: string }

/**
 * A non-receipt tool this run executed: name, did it succeed, the path arg (file writes), the id values in
 * its args / result (FR-3: state tools, schedule_self), and — for a raw-shell `git commit` / `git push`
 * (run_command, FR-6) — the shas git itself printed.
 */
export interface ExecutedCall {
  tool: string;
  ok: boolean;
  path?: string;
  ids?: string[];
  git?: { committed: string[]; pushed: string[]; pushedFrom: string[] };
}

/** FA-1 'read': a `verify` backed by the read index (an id a read this run was called with or returned). */
export type FinishVia = 'this_run' | 'session' | 'relayed' | 'tool_result' | 'read';

export interface ClaimVerdict {
  claim: FinishClaim;
  outcome: 'verified' | 'unverified' | 'unverifiable';
  via?: FinishVia;
  receiptId?: string;
  /**
   * Unverified / unverifiable reason (stable tokens — the readout groups by them). FR-1: 'observed_only' = a
   * mutation claim on an id this run only READ (an observation receipt names it, nothing changed it);
   * 'downgrade' = the ref is real but only as a WEAKER type (a push only a local commit carries, a merge only an
   * opened PR carries) — both stay rejected; only 'wrong_type' is a repair.
   */
  reason?: 'no_receipt' | 'unknown_receipt_id' | 'wrong_type' | 'observed_only' | 'downgrade' | 'deploy_not_receipted' | 'run_command_output' | 'path_not_in_receipts';
  /** A different claim type a receipt WOULD prove this ref as (the 'wrong_type' fix — a type REPAIR at finalize). */
  suggestType?: FinishClaimType;
  /** The declared scope differed from where the evidence was found (still verified). */
  scopeMismatch?: boolean;
  /** A hex-sha ref with no receipt — a GitHub origin re-query (stage 2) could still vouch it. */
  originCheckable?: boolean;
  /** Up to 3 receipts of the claim's class from this run ("<id8> <tool> <key id>") — the precision sample's context. */
  nearest?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{7,40}$/i;

/** Prefix-tolerant id match (run-receipts' M1 rule), case-insensitive. */
function idMatches(cited: string, actual: string): boolean {
  const c = cited.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (!c || !a) return false;
  return a === c || (c.length >= 8 && a.length >= 8 && (a.startsWith(c) || c.startsWith(a)));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

// ── Ref tokens (FR-2: decorated refs) ──
// Models write "ec533e98 (f108 state amendment …)", "goal <uuid>", "PR #19 o/r", "msg 76502520",
// "digby/session-6eee904c@7148fc9e…". The id tokens inside are matched like a bare ref.
const REF_UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REF_PREFIXED_G = /(?<![\w-])[a-z]{1,4}_[0-9a-f]{6,}(?:-[0-9a-f]{4,12})*/gi; // oq_<id>, cf_<id>
const REF_HEX_G = /\b[0-9a-f]{7,40}\b/gi;
const REF_PR_G = /(?:\bPR\s*#?\s*|(?<![\w&/])#|\/pulls?\/)(\d{1,6})\b/gi;

/** The id-shaped tokens inside a ref: uuids, prefixed ids (oq_…, cf_…), digit-bearing hex runs (shas, id prefixes). Pure. */
export function refIdTokens(ref: string): string[] {
  let text = String(ref ?? '').slice(0, 300);
  const out: string[] = [];
  const take = (re: RegExp): void => {
    for (const m of text.match(re) ?? []) out.push(m.toLowerCase());
    text = text.replace(re, ' ');
  };
  take(REF_PREFIXED_G); // first: "oq_<uuid>" is one id, not a uuid
  take(REF_UUID_G);
  for (const m of text.match(REF_HEX_G) ?? []) if (/[0-9]/.test(m)) out.push(m.toLowerCase());
  return Array.from(new Set(out)).slice(0, 8);
}

/** PR numbers a ref names ("#19", "PR 19", "…/pull/19"). Pure. */
export function refPrNumbers(ref: string): number[] {
  return Array.from(new Set([...String(ref ?? '').slice(0, 300).matchAll(REF_PR_G)].map((m) => Number(m[1])))).slice(0, 4);
}

/** The whole ref first, then the parts a decorated ref carries (branch@sha halves, id tokens, PR numbers for PR-aware types). */
function refCandidates(ref: string, type: FinishClaimType): string[] {
  const r = ref.trim();
  const out = [r];
  // "branch@sha" — never an email address or a leading "@handle"
  if (!/\s/.test(r) && r.indexOf('@') > 0 && !EMAIL_ADDR_RE.test(r)) out.push(...r.split('@').filter(Boolean));
  out.push(...refIdTokens(r));
  if (type === 'pr_opened' || type === 'pr_merged' || type === 'verify') out.push(...refPrNumbers(r).map((n) => `#${n}`));
  return Array.from(new Set(out.filter(Boolean))).slice(0, 12);
}

/** A receipt's id pairs: its ids envelope + the id-keyed fields of its in-memory args / result heads (FR-8). */
const HEAD_ID_PAIR_G = /"(id|[A-Za-z]*(?:Id|ID))"\s*:\s*"([^"\s]{4,120})"/g;
function receiptIdPairs(r: ReceiptLike): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(r.ids ?? {})) if (typeof v === 'string' || typeof v === 'number') out.push([k, String(v)]);
  for (const head of [r.argsHead, r.resultHead]) {
    if (typeof head !== 'string' || !head) continue;
    for (const m of head.matchAll(HEAD_ID_PAIR_G)) { if (out.length >= 40) break; out.push([m[1], m[2]]); }
  }
  return out;
}

/** The receipt tools each claim type may be proven by — typed for the real receipt shapes. */
const TYPE_RECEIPT_TOOLS: Record<FinishClaimType, ReadonlySet<string>> = {
  push: new Set(['git_push']),
  // a pushed commit was committed: a push receipt's HEAD sha proves the commit too
  commit: new Set(['git_commit', 'git_push']),
  // a PR this run MERGED was opened (the 9/9 hand-checked fence misses)
  pr_opened: new Set(['open_pull_request', 'merge_pull_request']),
  pr_merged: new Set(['merge_pull_request']),
  deploy: new Set(['git_push', 'run_command']),
  // the PR gate and the self-merge gate both run the verify chain green first; FR-5: an observation read
  // (get_chat_status / goal_get / list_* …) proves a verify of the id it was called with
  verify: new Set(['verify', 'run_command', 'open_pull_request', 'merge_pull_request', ...PLATFORM_OBSERVE_TOOLS]),
  ticket_update: new Set(['file_feedback', 'update_feedback', 'todo_update', 'goal_update', 'todo_create', 'goal_create', 'goal_premise_set']),
  message_sent: new Set(['send_chat_message', 'answer_chat_question',
    // todo 1e356736 (2026-10-16): notify_user mints a receipt now
    // (run-receipts NOTIFY_RECEIPT_TOOLS, ids {channel}) — the receipt tier
    // joins the EXECUTED tier (FR-4), mirroring claims-block's fold so the
    // two vocabularies stay one (ticket 6d7b379f).
    'notify_user']),
  dispatch: new Set(['dispatch_platform_task', 'start_coding_session']),
  schedule_armed: new Set(['schedule_message', 'update_schedule', 'cancel_schedule', 'pause_schedule', 'resume_schedule']),
  email_sent: new Set<string>(),
  file_change: new Set(['git_commit', 'git_push']),
  // FR-3: lane control / owner questions / cards / grants — receipts whose ids envelope is often empty (heads name the id)
  state_update: new Set(['stop_run', 'dismiss_owner_question', 'cancel_confirmation', 'approve_request', 'set_chat_autonomy', 'set_chat_instructions', 'set_decision_gate_mode',
    // audit 94f608c1 (2026-10-16): the supervisor-state mutations now mint
    // receipts (run-receipts SUPERVISOR_STATE_RECEIPT_TOOLS) — an archive
    // (ids.chatId), an owner-question flag (ids.questionId) and a state save
    // (ids.supervisor_state + receipt-id anchor, the FR-3 shape) verify on the
    // receipt tier; STATE_EXECUTED_TOOLS keeps them as the anon-session /
    // write-failure fallback.
    // Follow-up 60bfeab1 (2026-10-16): answer_owner_question joins the same
    // receipted class (specimen: the Fleet Supervisor's 05:24Z triage answer
    // oq_05c1345d, previously EXECUTED-tier only since build FA-2) — an
    // "answered oq_…" claim now verifies on ids.questionId.
    'archive_chat', 'flag_owner_question', 'update_supervisor_state', 'answer_owner_question']),
};

/**
 * FR-3: supervisor state / housekeeping tools that mint NO receipt — read on the executed tier
 * (update_supervisor_state is THE supervisor state save; 0 receipts existed for it, so a supervisor could never
 * claim it: 18 of the 2026-10-09 rejections).
 */
export const STATE_EXECUTED_TOOLS: readonly string[] = [
  'update_supervisor_state', 'archive_chat', 'flag_owner_question', 'register_watched_resource', 'release_watched_resource',
  'observe_resource', 'register_infra_blocker', 'clear_infra_blocker',
  // build 2026-10-11 FA-2: answering an owner question / acking a digest item mints no receipt either (the
  // 2026-10-10..11 replay: "state_update oq_524247ed" after answer_owner_question, "state_update <uuid>" /
  // "blocked_todo:<uuid>" after ack_digest_item were rejected as observed_only / no_receipt).
  'answer_owner_question', 'ack_digest_item', 'unack_digest_item',
];

/** FA-2: state tools whose success is their JSON envelope's ok:true (a plain-text scope refusal wrote nothing). */
const ENVELOPE_OK_TOOLS: ReadonlySet<string> = new Set(['answer_owner_question', 'ack_digest_item', 'unack_digest_item']);
/** FA-2: state tools whose acted-on id rides a non-id-keyed arg (ack_digest_item's `key`, e.g. "blocked_todo:<uuid>"). */
const STATE_KEY_ARG: Readonly<Record<string, string>> = { ack_digest_item: 'key', unack_digest_item: 'key' };

/** Non-receipt tools whose executed, non-failed call proves a claim type (tool-result tier). */
const TYPE_EXECUTED_TOOLS: Partial<Record<FinishClaimType, ReadonlySet<string>>> = {
  email_sent: new Set(['send_email_as_digby', 'gmail_send_email']),
  // FR-6: a raw-shell `git commit` / `git push` proves the shas git printed (run_command receipts carry no sha)
  file_change: new Set(['write_file', 'edit_file', 'ast_rewrite', 'run_command']),
  push: new Set(['run_command']),
  commit: new Set(['run_command']),
  // FR-4: notify_user mints a receipt since todo 1e356736 (run-receipts
  // NOTIFY_RECEIPT_TOOLS) — TYPE_RECEIPT_TOOLS above joins it to the receipt
  // tier; the EXECUTED tier below stays the anon-session fallback
  message_sent: new Set(['notify_user']),
  // FR-7: schedule_self ("Scheduled (once, id <uuid>) …") mints no receipt
  schedule_armed: new Set(['schedule_self']),
  state_update: new Set(STATE_EXECUTED_TOOLS),
};

/** The harness-authored success line of the file tools (coding/tools.ts) — anything else wrote nothing. */
const EXECUTED_SUCCESS_LINE: Record<string, RegExp> = {
  write_file: /^Wrote \S/,
  edit_file: /^Edited \S/,
};

/** Tool names the loop should hand to FinishRunSession.observeToolResult. */
export const FINISH_RUN_OBSERVED_TOOLS: ReadonlySet<string> = new Set([
  'get_run_receipts',
  ...[...Object.values(TYPE_EXECUTED_TOOLS)].flatMap((s) => [...(s ?? [])]),
  // FA-1: the read tools feed the read index (connector reads ride finishRunObservesTool — names are dynamic)
  ...(PLATFORM_READ_TOOLS as readonly string[]),
  ...PLATFORM_OBSERVE_TOOLS,
]);

// ── The read index (build 2026-10-11 FA-1) ──────────────────────────────────

/** Connector reads (provider-limits' tiering: a connector prefix, no write verb). mcp_ tools are excluded — arbitrary names. */
const READ_CONNECTOR_RE = /^(?:gmail|drive|calendar|docs|sheets|slides|github|slack|discord|asana|x|xero|plaid|imessage)_/;
const READ_CONNECTOR_WRITE_RE = /_(?:send|create|update|post|write|append|upload|delete|remove)(?:_|$)/;
const PLATFORM_READ_SET: ReadonlySet<string> = new Set<string>(PLATFORM_READ_TOOLS as readonly string[]);

/** A READ tool whose arguments / returned ids back a `verify` claim: the platform read set, the observation set, connector reads. Pure. */
export function isFinishReadTool(name: string): boolean {
  const n = String(name ?? '');
  if (!n) return false;
  if (PLATFORM_READ_SET.has(n) || PLATFORM_OBSERVE_TOOLS.has(n)) return true;
  return READ_CONNECTOR_RE.test(n) && !READ_CONNECTOR_WRITE_RE.test(n);
}

/** The loop hands a dispatched tool's result to FinishRunSession.observeToolResult when this is true. */
export function finishRunObservesTool(name: string): boolean {
  return FINISH_RUN_OBSERVED_TOOLS.has(name) || isFinishReadTool(name);
}

/** Bounds: distinct tokens kept per run, chars of one result scanned, tokens taken from one read. */
export const READ_INDEX_MAX_TOKENS = 5_000;
const READ_SCAN_CHARS = 64_000;
const READ_TOKENS_PER_CALL = 800;
const PR_KEY_RE = /^(?:number|prnumber|pr|pr_number|pullnumber)$/i;
const RESULT_PR_JSON_G = /"(?:number|prNumber|pr_number|pullNumber)"\s*:\s*"?(\d{1,6})\b/g;
/** A decision purpose name ("wake_triage") — indexed from the decision-status read only. */
const SNAKE_WORD_G = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const PREFIXED_ID_RE = /^[a-z]{1,4}_[0-9a-f]{6,}/;

/** Is a whole (lowercased, trimmed) string an id on its own? uuid / prefixed id / digit-bearing hex. */
const idShaped = (s: string): boolean => UUID_RE.test(s) || PREFIXED_ID_RE.test(s) || (HEX_RE.test(s) && /[0-9]/.test(s));

/**
 * The tokens a read's RESULT returned: `id:` uuids, prefixed ids, digit-bearing hex runs (shas, id prefixes,
 * CI run ids), `pr:` PR numbers (#N, PR N, /pull/N, "number": N), and — the decision-status read only —
 * `w:` purpose names. Bounded; pure; never throws.
 */
export function readResultTokens(tool: string, result: string): string[] {
  const text = String(result ?? '').slice(0, READ_SCAN_CHARS);
  const out = new Set<string>();
  const add = (t: string): void => { if (out.size < READ_TOKENS_PER_CALL) out.add(t); };
  try {
    for (const m of text.matchAll(REF_PREFIXED_G)) add(`id:${m[0].toLowerCase()}`);
    for (const m of text.matchAll(REF_UUID_G)) add(`id:${m[0].toLowerCase()}`);
    for (const m of text.replace(REF_UUID_G, ' ').matchAll(REF_HEX_G)) if (/[0-9]/.test(m[0])) add(`id:${m[0].toLowerCase()}`);
    for (const m of text.matchAll(REF_PR_G)) add(`pr:${Number(m[1])}`);
    for (const m of text.matchAll(RESULT_PR_JSON_G)) add(`pr:${Number(m[1])}`);
    if (tool === 'get_decision_gate_status') for (const m of text.matchAll(SNAKE_WORD_G)) add(`w:${m[0]}`);
  } catch { /* tolerant */ }
  return [...out];
}

/**
 * The tokens a read's ARGUMENTS carried: every short whitespace-free string value (`w:`, and `id:` when
 * id-shaped), the id tokens / PR numbers inside longer strings, PR-keyed numbers, ≥ 7-digit numbers. Pure.
 */
export function readArgTokens(args: unknown): string[] {
  const out = new Set<string>();
  let root = args;
  if (typeof root === 'string') { try { root = JSON.parse(root); } catch { /* a bare string arg */ } }
  const visit = (v: unknown, key: string, depth: number): void => {
    if (out.size >= 200 || depth > 5 || v === null || v === undefined) return;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) return;
      const s = String(v);
      if (PR_KEY_RE.test(key) && s.length <= 6) out.add(`pr:${v}`);
      if (s.length >= 7) out.add(`id:${s}`);
      return;
    }
    if (typeof v === 'string') {
      const s = v.trim().slice(0, 300);
      if (!s) return;
      const low = s.toLowerCase();
      if (!/\s/.test(low) && low.length <= 120) {
        out.add(`w:${low}`);
        if (idShaped(low)) out.add(`id:${low}`);
      }
      for (const t of refIdTokens(s)) out.add(`id:${t}`);
      for (const n of refPrNumbers(s)) out.add(`pr:${n}`);
      if (PR_KEY_RE.test(key) && /^\d{1,6}$/.test(s)) out.add(`pr:${Number(s)}`);
      return;
    }
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) visit(x, key, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, depth + 1);
  };
  try { visit(root, '', 0); } catch { /* tolerant */ }
  return [...out];
}

/** An id token against an indexed id: exact, a ≥ 7-hex prefix of it, or (both ≥ 8) a prefix either way (run-receipts M1). */
function indexIdMatches(cited: string, seen: string): boolean {
  if (cited === seen) return true;
  if (cited.length >= 7 && seen.length > cited.length && /^[0-9a-f]+$/.test(cited) && seen.startsWith(cited)) return true;
  return cited.length >= 8 && seen.length >= 8 && (seen.startsWith(cited) || cited.startsWith(seen));
}

/**
 * FA-1: what the run READ, as a bounded token index keyed to the read's sequence number (so a claim is judged
 * against the reads that existed WHEN finish_run was called). Pure, in-memory, never throws.
 */
export class FinishReadIndex {
  private tokens = new Map<string, number>();
  private tools = new Map<string, number>();
  private seq = 0;

  /** Reads observed so far (the next read's sequence number). */
  get reads(): number { return this.seq; }
  get size(): number { return this.tokens.size; }

  add(tool: string, args: unknown, result: string): void {
    try {
      const s = this.seq++;
      if (!this.tools.has(tool)) this.tools.set(tool, s);
      for (const t of [...readArgTokens(args), ...readResultTokens(tool, result)]) {
        if (this.tokens.size >= READ_INDEX_MAX_TOKENS) break;
        if (!this.tokens.has(t)) this.tokens.set(t, s);
      }
    } catch { /* never breaks the run */ }
  }

  /**
   * Does a `verify` ref rest on a read made before read #`limit`? The ref names a read tool this run called,
   * is a word an argument carried / the decision-status read returned, names a PR number a read returned,
   * or carries an id token a read was called with or returned (8-hex prefix-tolerant).
   */
  provesVerify(ref: string, limit: number = Number.POSITIVE_INFINITY): boolean {
    const r = String(ref ?? '').trim().slice(0, 300);
    if (!r) return false;
    const low = r.toLowerCase();
    const seen = (t: string): boolean => { const s = this.tokens.get(t); return s !== undefined && s < limit; };
    for (const w of low.split(/[^a-z0-9_]+/)) {
      const s = w ? this.tools.get(w) : undefined;
      if (s !== undefined && s < limit) return true;
    }
    if (!/\s/.test(low) && low.length <= 120 && seen(`w:${low}`)) return true;
    const prs = [...refPrNumbers(r), ...(/^#?\d{1,6}$/.test(low) ? [Number(low.replace('#', ''))] : [])];
    if (prs.some((n) => seen(`pr:${n}`))) return true;
    const ids = new Set<string>([...refIdTokens(r), ...(idShaped(low) ? [low] : [])]);
    for (const t of ids) {
      if (seen(`id:${t}`)) return true;
      for (const [k, s] of this.tokens) if (s < limit && k.startsWith('id:') && indexIdMatches(t, k.slice(3))) return true;
    }
    return false;
  }
}

const TICKET_ID_KEYS: ReadonlySet<string> = new Set(['ticketId', 'goalId', 'todoId']);
const OBSERVE_TOOL_NAMES: ReadonlySet<string> = PLATFORM_OBSERVE_TOOLS;

/** One candidate ref against one ok receipt of the type's class. `descriptive` = the loose "verify <words> + a passed verify" rule. */
function proveOne(type: FinishClaimType, refT: string, r: ReceiptLike, descriptive: boolean): boolean {
  const ids = (r.ids && typeof r.ids === 'object' ? r.ids : {}) as Record<string, unknown>;
  if (idMatches(refT, r.id)) {
    // A receipt-id citation of the right class. A verify receipt must record a PASS.
    return !(type === 'verify' && r.tool === 'verify' && ids.passed !== true);
  }
  switch (type) {
    case 'push': {
      const sha = str(ids.sha);
      if (sha && refNamesSha(refT, sha)) return true;
      if (str(ids.branch) === refT) return true;
      return Array.isArray(ids.refs) && ids.refs.some((x) => typeof x === 'string' && (x === refT || x.endsWith(`/${refT}`)));
    }
    case 'commit':
    case 'file_change': {
      const sha = str(ids.sha);
      return !!sha && refNamesSha(refT, sha);
    }
    case 'pr_opened': {
      const n = num(ids.prNumber);
      if (n !== null && refNamesPrNumber(refT, n)) return true;
      return r.tool === 'open_pull_request' && str(ids.url) === refT;
    }
    case 'pr_merged': {
      const n = num(ids.prNumber);
      if (n !== null && refNamesPrNumber(refT, n)) return true;
      const sha = str(ids.mergeSha);
      return !!sha && refNamesSha(refT, sha);
    }
    case 'deploy': {
      const sha = str(ids.sha);
      return !!sha && refNamesSha(refT, sha);
    }
    case 'verify': {
      if (r.tool === 'verify') return descriptive && ids.passed === true && !UUID_RE.test(refT); // descriptive ref + a passed verify this scope
      if (r.tool === 'open_pull_request' || r.tool === 'merge_pull_request') {
        const n = num(ids.prNumber);
        return n !== null && refNamesPrNumber(refT, n); // "verify 1225" = the PR whose gate ran green
      }
      if (OBSERVE_TOOL_NAMES.has(r.tool)) {
        // FR-5: the id the read was called with (args head) / returned (result head), or the read named by tool
        return receiptIdPairs(r).some(([, v]) => idMatches(refT, v)) || refT.includes(r.tool);
      }
      return false; // run_command: only by its receipt id (above)
    }
    case 'ticket_update':
      return receiptIdPairs(r).some(([k, v]) => TICKET_ID_KEYS.has(k) && idMatches(refT, v));
    case 'message_sent':
    case 'dispatch':
    case 'schedule_armed':
    case 'state_update':
      return receiptIdPairs(r).some(([, v]) => idMatches(refT, v));
    case 'email_sent':
      return false;
  }
}

/**
 * Does this ONE ok receipt prove `ref` as `type`? The whole ref first, then the id tokens a decorated ref
 * carries (FR-2). `refBound` (the wrong_type suggestion search) never uses the loose descriptive-verify rule:
 * "message_sent @handle" must not be suggested as a verify because SOME verify passed.
 */
export function receiptProves(type: FinishClaimType, ref: string, r: ReceiptLike, opts: { refBound?: boolean } = {}): boolean {
  if (!r || !r.ok || !TYPE_RECEIPT_TOOLS[type].has(r.tool)) return false;
  const refT = String(ref ?? '').trim();
  if (!refT) return false;
  if (proveOne(type, refT, r, !opts.refBound)) return true;
  for (const c of refCandidates(refT, type)) if (c !== refT && proveOne(type, c, r, false)) return true;
  return false;
}

/** A path ref names the written path (suffix either way, leading ./ ignored). */
function pathMatches(ref: string, path: string): boolean {
  const a = ref.trim().replace(/^\.\//, '');
  const b = path.trim().replace(/^\.\//, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

const looksLikePath = (ref: string): boolean => /[\\/]|\.[a-z0-9]{1,6}$/i.test(ref.trim()) && !HEX_RE.test(ref.trim());

const EMAIL_ADDR_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const EMAIL_REF_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\be-?mail\b/i;
const HANDLE_REF_RE = /(?:^|[\s:(])@[A-Za-z0-9_]{3,}/;
const NOTIFY_REF_RE = /telegram|notif|(?:^|[\s:(])@[A-Za-z0-9_]{3,}/i;
/** A descriptive ref that names the supervisor state / housekeeping itself (the FR-3 suggestion bar). */
const STATE_REF_RE = /supervisor[\s_-]*state|\bstate\b|project[\s_-]*status|\bnotes?\b|\bdirectives?\b|\barchiv|owner[\s_-]*question/i;

/**
 * The executed (tool-result) tier. `strict` (the wrong_type suggestion search) only accepts a ref BOUND to the
 * call — an id it carried, or a descriptive ref naming that kind of action — never the advisory "the send itself
 * is the fact" reading a claim of the type itself gets.
 */
function executedProves(type: FinishClaimType, ref: string, calls: ExecutedCall[], o: { strict?: boolean; ownChatId?: string } = {}): boolean {
  const tools = TYPE_EXECUTED_TOOLS[type];
  if (!tools) return false;
  const refT = String(ref ?? '').trim();
  const toks = refIdTokens(refT);
  const cands = [refT, ...toks];
  const bound = (vals: string[]): boolean => cands.some((t) => vals.some((v) => idMatches(t, v)));
  const shaIn = (shas: string[]): boolean => cands.some((t) => shas.some((s) => refNamesSha(t, s)));
  for (const c of calls) {
    if (!c.ok || !tools.has(c.tool)) continue;
    switch (type) {
      case 'email_sent':
        if (!o.strict || EMAIL_REF_RE.test(refT)) return true; // the ref (recipient) is advisory — the send itself is the fact
        break;
      case 'message_sent':
        // notify_user reaches the owner's own Telegram: the ref is a handle / channel, never an id
        if (!EMAIL_ADDR_RE.test(refT) && (!toks.length || HANDLE_REF_RE.test(refT)) && (!o.strict || NOTIFY_REF_RE.test(refT))) return true;
        break;
      case 'file_change':
        if (c.path && pathMatches(refT, c.path)) return true;
        if (c.git && shaIn([...c.git.committed, ...c.git.pushed, ...c.git.pushedFrom])) return true;
        break;
      case 'push':
        if (c.git && shaIn(c.git.pushed)) return true;
        break;
      case 'commit':
        if (c.git && shaIn([...c.git.committed, ...c.git.pushed, ...c.git.pushedFrom])) return true;
        break;
      case 'schedule_armed':
        if (bound(c.ids ?? [])) return true;
        break;
      case 'state_update': {
        // a supervisor state save is THIS chat's own row — its chat id names it too
        const vals = [...(c.ids ?? []), ...(c.tool === 'update_supervisor_state' && o.ownChatId ? [o.ownChatId] : [])];
        if (toks.length || UUID_RE.test(refT)) { if (bound(vals)) return true; } else if (!o.strict || STATE_REF_RE.test(refT)) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

const receiptLabel = (r: ReceiptLike): string => {
  const ids = (r.ids ?? {}) as Record<string, unknown>;
  const key = ['prNumber', 'sha', 'mergeSha', 'branch', 'ticketId', 'todoId', 'goalId', 'scheduleId', 'sessionId', 'messageId', 'chatId', 'runId', 'questionId', 'confirmationId']
    .map((k) => (ids[k] !== undefined && ids[k] !== null ? `${k}=${String(ids[k]).slice(0, 12)}` : ''))
    .find(Boolean);
  return `${String(r.id).slice(0, 8)} ${r.tool}${key ? ` ${key}` : ''}`;
};

export interface FinishEvidence {
  /** This run's receipts at the time of the call (+ a resumed run's earlier attempts). */
  thisRun: ReceiptLike[];
  /** Rows printed by get_run_receipts this run (another chat's receipts — `relayed`). */
  relayed: ReceiptLike[];
  /** Non-receipt tools executed this run (email / file writes / state tools / shell git). */
  executed: ExecutedCall[];
  /** THIS chat's ok receipts from earlier runs (≤ 24 h) — loaded lazily, only when needed. */
  loadSession?: () => Promise<ReceiptLike[]>;
  /** THIS chat's id (FR-3: a supervisor's state save is its own chat's row). */
  ownChatId?: string;
  /** FA-1: does the read index (as it stood at the call) back a `verify` of this ref? */
  readProves?: (ref: string) => boolean;
}

/** The wrong_type search order: every mutation type first, verify LAST (a ref this run READ and also changed is the change). */
const SUGGEST_ORDER: readonly FinishClaimType[] = [...FINISH_CLAIM_TYPES.filter((t) => t !== 'verify'), 'verify'];

/**
 * A "wrong type" that is really an OVERCLAIM is never a repair: a push whose sha only a local commit (or a
 * verify) carries is the finding-A1 "LOCAL ONLY — NOT PUSHED" line; a merge only an opened PR / its gate carries
 * was not merged. Reason 'downgrade' (still rejected, suggestType kept for the doctrine).
 */
const DOWNGRADE: Partial<Record<FinishClaimType, ReadonlySet<FinishClaimType>>> = {
  push: new Set<FinishClaimType>(['commit', 'file_change', 'verify']),
  pr_merged: new Set<FinishClaimType>(['pr_opened', 'verify']),
};

/**
 * Verify every claim. Tiers, in order: this run's receipts → the executed-
 * tool tier (email / file paths / state tools / shell git) → relayed rows → this chat's earlier receipts
 * (session, loaded once, only when a claim is still open). A declared scope
 * never makes a real receipt invalid — a mismatch is verified and FLAGGED.
 * Anti-forgery: a full-uuid ref matching no receipt is `unknown_receipt_id`.
 * Not found: a REF-BOUND receipt / call of another type ⇒ 'wrong_type' + suggestType (a type repair at
 * finalize); a mutation claim whose ref only an observation read names ⇒ 'observed_only' (stays rejected).
 */
export async function verifyFinishClaims(claims: FinishClaim[], ev: FinishEvidence): Promise<ClaimVerdict[]> {
  const verdicts: ClaimVerdict[] = [];
  let session: ReceiptLike[] | null = null;
  const loadSession = async (): Promise<ReceiptLike[]> => {
    if (session) return session;
    try { session = ev.loadSession ? (await ev.loadSession()).filter((r) => r && r.ok) : []; } catch { session = []; }
    return session;
  };
  const xo = ev.ownChatId ? { ownChatId: ev.ownChatId } : {};
  const readProves = (ref: string): boolean => { try { return !!ev.readProves?.(ref); } catch { return false; } };
  for (const claim of claims) {
    const declared = claim.scope ?? 'this_run';
    const found = (pool: ReceiptLike[]): ReceiptLike | undefined => pool.find((r) => receiptProves(claim.type, claim.ref, r));
    let hit: { via: FinishVia; id?: string } | null = null;
    const own = found(ev.thisRun);
    if (own) hit = { via: 'this_run', id: own.id };
    else if (executedProves(claim.type, claim.ref, ev.executed, xo)) hit = { via: 'tool_result' };
    else if (claim.type === 'verify' && readProves(claim.ref)) hit = { via: 'read' };
    else {
      const rel = found(ev.relayed);
      if (rel) hit = { via: 'relayed', id: rel.id };
      else {
        const ses = found(await loadSession());
        if (ses) hit = { via: 'session', id: ses.id };
      }
    }
    if (hit) {
      const scopeOf = (via: FinishVia): FinishScope => (via === 'tool_result' || via === 'read' ? 'this_run' : via);
      verdicts.push({
        claim, outcome: 'verified', via: hit.via, ...(hit.id ? { receiptId: hit.id } : {}),
        ...(claim.scope && scopeOf(hit.via) !== declared ? { scopeMismatch: true } : {}),
      });
      continue;
    }
    // Not found anywhere. Unverifiable (the receipt channel cannot adjudicate it) or unverified.
    const ref = claim.ref.trim();
    const nearest = ev.thisRun.filter((r) => r.ok && TYPE_RECEIPT_TOOLS[claim.type].has(r.tool)).slice(-3).map(receiptLabel);
    const base = { claim, ...(nearest.length ? { nearest } : {}) };
    if (claim.type === 'deploy' && !UUID_RE.test(ref)) { verdicts.push({ ...base, outcome: 'unverifiable', reason: 'deploy_not_receipted' }); continue; }
    if (claim.type === 'verify' && !UUID_RE.test(ref) && ev.thisRun.some((r) => r.ok && r.tool === 'run_command')) {
      verdicts.push({ ...base, outcome: 'unverifiable', reason: 'run_command_output' }); continue;
    }
    if (claim.type === 'file_change' && looksLikePath(ref) && [...ev.thisRun, ...(await loadSession())].some((r) => r.ok && r.tool === 'git_commit')) {
      verdicts.push({ ...base, outcome: 'unverifiable', reason: 'path_not_in_receipts' }); continue;
    }
    // FR-1: a REF-BOUND suggestion only (never the descriptive verify rule, never the advisory executed reading).
    const pool = [...ev.thisRun, ...ev.relayed, ...(session ?? [])];
    let suggestType: FinishClaimType | undefined;
    let observedOnly = false;
    for (const t of SUGGEST_ORDER) {
      if (t === claim.type) continue;
      const hits = pool.filter((r) => receiptProves(t, ref, r, { refBound: true }));
      // FA-1: an id only the read index carries is a verify (the run read it) — never a repair, always observed_only
      const readHit = t === 'verify' && !hits.length && readProves(ref);
      if (!hits.length && !readHit && !executedProves(t, ref, ev.executed, { ...xo, strict: true })) continue;
      suggestType = t;
      // a mutation claim whose only evidence is a READ of the ref: the run looked at it, never changed it
      observedOnly = t === 'verify' && (readHit || (hits.length > 0 && hits.every((r) => OBSERVE_TOOL_NAMES.has(r.tool))));
      break;
    }
    const originCheckable = (HEX_RE.test(ref) || refIdTokens(ref).some((t) => HEX_RE.test(t)))
      && (claim.type === 'push' || claim.type === 'commit' || claim.type === 'file_change' || claim.type === 'pr_merged');
    const downgrade = !!suggestType && !observedOnly && !!DOWNGRADE[claim.type]?.has(suggestType);
    verdicts.push({
      ...base, outcome: 'unverified',
      reason: observedOnly ? 'observed_only' : downgrade ? 'downgrade' : suggestType ? 'wrong_type' : UUID_RE.test(ref) ? 'unknown_receipt_id' : 'no_receipt',
      ...(suggestType ? { suggestType } : {}),
      ...(originCheckable ? { originCheckable: true } : {}),
    });
  }
  return verdicts;
}

/** FR-1: a wrong_type verdict with a REF-BOUND suggestion is a TYPE REPAIR — the claim is real, only its type was wrong. */
export function isTypeRepair(v: ClaimVerdict): boolean {
  return v.outcome === 'unverified' && v.reason === 'wrong_type' && !!v.suggestType;
}

/** A type repair as the finish_run row records it (meta.repairs). */
export interface FinishTypeRepair { from: FinishClaimType; to: FinishClaimType; ref: string; reason: 'wrong_type' }

// ── Executed-call observation (FR-3 / FR-6 / FR-7) ──────────────────────────

const ID_KEY_RE = /^(?:id|ids|[a-z]\w*Ids?|\w+_ids?)$/;

function collectIdValues(v: unknown, out: string[], depth: number, idKey: boolean): void {
  if (out.length >= 40 || depth > 5 || v === null || v === undefined) return;
  if (typeof v === 'string' || typeof v === 'number') {
    if (!idKey) return;
    const s = String(v).trim();
    if (s.length >= 4 && s.length <= 120 && !/\s/.test(s)) out.push(s);
    return;
  }
  if (Array.isArray(v)) { for (const x of v.slice(0, 50)) collectIdValues(x, out, depth + 1, idKey); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) collectIdValues(x, out, depth + 1, ID_KEY_RE.test(k));
}

/** The id values a call carried: id-keyed fields of its args, and of its result (JSON) or the ids its first line names (prose). Pure. */
export function executedCallIds(args: unknown, result: string): string[] {
  const out: string[] = [];
  try { collectIdValues(args, out, 0, false); } catch { /* tolerant */ }
  const text = String(result ?? '').trim();
  let parsed: unknown;
  if (text.startsWith('{') || text.startsWith('[')) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
  if (parsed !== undefined) { try { collectIdValues(parsed, out, 0, false); } catch { /* tolerant */ } }
  else out.push(...refIdTokens(text.split('\n')[0].slice(0, 300)).filter((t) => UUID_RE.test(t) || /^[a-z]{1,4}_/.test(t)));
  return Array.from(new Set(out)).slice(0, 40);
}

/** The executed-tier tool names (non-receipt tools whose executed call proves a claim) — FINISH_RUN_OBSERVED_TOOLS minus the reads. */
const TYPE_EXECUTED_TOOL_NAMES: ReadonlySet<string> = new Set([...Object.values(TYPE_EXECUTED_TOOLS)].flatMap((s) => [...(s ?? [])]));

/** FA-2: a platform envelope that says ok:true (anything else — a refusal, plain text — acted on nothing). */
function envelopeOk(text: string): boolean {
  try {
    const j = JSON.parse(text);
    return !!j && typeof j === 'object' && (j as Record<string, unknown>).ok === true;
  } catch { return false; }
}

/** update_supervisor_state answers {applied: [...], errors: [...]} — a save that applied nothing saved nothing. */
function stateSaveApplied(text: string): boolean {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && Array.isArray(j.applied) ? j.applied.length > 0 : true;
  } catch { return true; }
}

const GIT_CMD_RE = /\bgit\b/;
const GIT_PUSH_CMD_RE = /\bgit\b[^\n]*?\bpush\b/;
const GIT_COMMIT_LINE_G = /^\[[^\]\n]{1,160}? ([0-9a-f]{7,40})\] /gm;
const GIT_PUSH_RANGE_G = /^\s*\+?\s*([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})\s+\S+\s+->\s+\S+/gm;
/** run_command answers that executed nothing (run-receipts' not-executed shapes). */
const RUN_NOT_EXECUTED_RE = /^(?:Tool "run_command" exceeded \d+s and was aborted\.|\[command REFUSED\b|\[command failed\]|Tool run_command failed:|\[SELF-STARTED MONITOR\])/i;

/**
 * FR-6: a raw-shell git command's own output — `[<branch> <sha>] <subject>` commit lines and, when the command
 * pushed, the `<old>..<new>  <src> -> <dst>` ranges. The run_command receipt carries no sha, so a lane that
 * pushes from the shell (the publish-intent notice is advisory) could never claim its push. Null ⇒ not a
 * git command / nothing printed. Pure.
 */
export function gitShellShas(args: unknown, result: string): { committed: string[]; pushed: string[]; pushedFrom: string[] } | null {
  const cmd = args && typeof args === 'object' && typeof (args as any).command === 'string' ? String((args as any).command) : '';
  if (!cmd || !GIT_CMD_RE.test(cmd)) return null;
  const text = String(result ?? '').slice(0, 64_000);
  if (RUN_NOT_EXECUTED_RE.test(text.trim())) return null;
  const committed = [...text.matchAll(GIT_COMMIT_LINE_G)].map((m) => m[1].toLowerCase());
  const pushed: string[] = [];
  const pushedFrom: string[] = [];
  if (GIT_PUSH_CMD_RE.test(cmd)) for (const m of text.matchAll(GIT_PUSH_RANGE_G)) { pushedFrom.push(m[1].toLowerCase()); pushed.push(m[2].toLowerCase()); }
  if (!committed.length && !pushed.length) return null;
  return { committed: committed.slice(0, 20), pushed: pushed.slice(0, 20), pushedFrom: pushedFrom.slice(0, 20) };
}

// ── Auto-finish (receipts only — never prose) ───────────────────────────────

/** The claims a run's own ok receipts support, one per distinct ref (≤ MAX_FINISH_CLAIMS). */
export function autoFinishClaims(receipts: ReceiptLike[]): FinishClaim[] {
  const out: FinishClaim[] = [];
  const seen = new Set<string>();
  const add = (type: FinishClaimType, ref: string | null): void => {
    if (!ref || out.length >= MAX_FINISH_CLAIMS) return;
    const key = `${type}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, ref });
  };
  const pushedShas = new Set(receipts.filter((r) => r.ok && r.tool === 'git_push').map((r) => String((r.ids ?? {}).sha ?? '')).filter(Boolean));
  for (const r of receipts) {
    if (!r || !r.ok) continue;
    const ids = (r.ids ?? {}) as Record<string, unknown>;
    const id8 = String(r.id).slice(0, 8);
    switch (r.tool) {
      case 'git_push': add('push', str(ids.sha) ?? str(ids.branch) ?? id8); break;
      case 'git_commit': { const sha = str(ids.sha); if (!sha || !pushedShas.has(sha)) add('commit', sha ?? id8); break; }
      case 'open_pull_request': add('pr_opened', num(ids.prNumber) !== null ? String(num(ids.prNumber)) : id8); break;
      case 'merge_pull_request': add('pr_merged', num(ids.prNumber) !== null ? String(num(ids.prNumber)) : str(ids.mergeSha) ?? id8); break;
      case 'verify': if (ids.passed === true) add('verify', id8); break;
      default:
        for (const t of ['ticket_update', 'message_sent', 'dispatch', 'schedule_armed', 'state_update'] as const) {
          if (TYPE_RECEIPT_TOOLS[t].has(r.tool)) {
            const ref = t === 'ticket_update' ? (str(ids.ticketId) ?? str(ids.todoId) ?? str(ids.goalId)) : t === 'schedule_armed' ? str(ids.scheduleId) : null;
            add(t, ref ?? id8);
            break;
          }
        }
    }
  }
  return out;
}

// ── Undeclared ids in the summary (the stage-2 backstop, measured here) ─────

const SUMMARY_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SUMMARY_HEX_RE = /\b[0-9a-f]{7,40}\b/gi;
const SUMMARY_PR_RE = /(?:\bPR\s*#?\s*|(?<![\w&])#)(\d{1,6})\b/gi;

/**
 * Id-shaped tokens in the summary (uuids, hex shas with a digit AND a letter,
 * PR numbers) that no claim ref / open item names — the design's "narrow
 * deterministic scan" (stage 2 turns a hit into an in-loop error). Recorded
 * only. Pure.
 */
export function undeclaredSummaryTokens(summary: string, claims: FinishClaim[], openItems: FinishOpenItem[]): string[] {
  const text = String(summary ?? '');
  if (!text) return [];
  const declared = [...claims.map((c) => c.ref), ...openItems.flatMap((o) => [o.ref ?? '', o.text])].map((s) => s.toLowerCase());
  const covered = (tok: string): boolean => {
    const t = tok.toLowerCase();
    return declared.some((d) => d && (d.includes(t) || (t.length >= 7 && d.length >= 7 && /^[0-9a-f]+$/.test(d) && (t.startsWith(d) || d.startsWith(t)))));
  };
  const found: string[] = [];
  const uuids = text.match(SUMMARY_UUID_RE) ?? [];
  for (const u of uuids) if (!covered(u)) found.push(u);
  const noUuid = text.replace(SUMMARY_UUID_RE, ' ');
  for (const h of noUuid.match(SUMMARY_HEX_RE) ?? []) {
    if (!/[0-9]/.test(h) || !/[a-f]/i.test(h)) continue;
    if (!covered(h)) found.push(h);
  }
  for (const m of noUuid.matchAll(SUMMARY_PR_RE)) {
    const n = m[1];
    if (!claims.some((c) => (c.type === 'pr_opened' || c.type === 'pr_merged' || c.type === 'verify') && refNamesPrNumber(c.ref, Number(n))) && !covered(`#${n}`) && !covered(n)) found.push(`#${n}`);
  }
  return Array.from(new Set(found)).slice(0, 12);
}

// ── Relayed rows (get_run_receipts output) ──────────────────────────────────

/** Receipt rows printed by a get_run_receipts result (runs[].receipts + chatTurns[].receipts). Tolerant; never throws. */
export function parseRelayedReceiptRows(result: string): ReceiptLike[] {
  const rows: ReceiptLike[] = [];
  let parsed: any = null;
  try { parsed = JSON.parse(String(result ?? '')); } catch { return rows; }
  if (!parsed || typeof parsed !== 'object') return rows;
  const add = (r: any): void => {
    if (!r || typeof r !== 'object' || typeof r.tool !== 'string') return;
    rows.push({ id: String(r.id ?? ''), tool: r.tool, ok: r.ok === true, ids: r.ids && typeof r.ids === 'object' && !Array.isArray(r.ids) ? r.ids : {} });
  };
  for (const run of Array.isArray(parsed.runs) ? parsed.runs : []) for (const r of Array.isArray(run?.receipts) ? run.receipts : []) add(r);
  for (const t of Array.isArray(parsed.chatTurns) ? parsed.chatTurns : []) for (const r of Array.isArray(t?.receipts) ? t.receipts : []) add(r);
  return rows;
}

// ── The per-run session (agent.ts holds one per eligible run) ───────────────

export type FinishSource = 'model' | 'nudged' | 'auto';

export interface FinishNudge {
  /** not_needed (called in-loop) | called | prose | other_tool | timeout | error | skipped:<reason> */
  outcome: string;
  ms?: number;
}

export interface FinishRunRecord {
  source: FinishSource;
  calls: number;
  /** Was the tool ever in the offered list (false ⇒ a tool cap kept it out — nudge-only). */
  offered: boolean;
  nudge: FinishNudge;
  status: FinishStatus | null;
  /** Stage-2 acceptance: parsed, status + summary present, no schema error, no unverified claim (a type REPAIR is not unverified). */
  valid: boolean;
  errors: FinishError[];
  /** Forgiving parse repairs (strings) + FR-1 type repairs ({from, to, ref, reason: 'wrong_type'}). */
  repairs: Array<string | FinishTypeRepair>;
  claims: number;
  verified: number;
  /** Claims still rejected (type repairs excluded — they are counted in `repaired`). */
  unverified: number;
  /** FR-1: wrong_type claims accepted with a type repair (the ref IS a real receipt of `to`). */
  repaired: number;
  unverifiable: number;
  scopeMismatch: number;
  byVia: Partial<Record<FinishVia, number>>;
  claimTypes: Partial<Record<FinishClaimType, number>>;
  aliasTypes: number;
  rejected: Array<{ type: FinishClaimType; ref: string; reason: string; suggestType?: FinishClaimType; originCheckable?: boolean; nearest?: string[] }>;
  unverifiableRefs: Array<{ type: FinishClaimType; ref: string; reason: string }>;
  openItems: number;
  openKinds: Partial<Record<FinishOpenItemKind | 'unkinded', number>>;
  undeclared: number;
  undeclaredSample: string[];
  summaryChars: number;
  finalChars: number;
  receiptsAtCall: number;
  /** Auto-finish only: the receipt-derived claims (count + per type). */
  autoClaims?: number;
  autoClaimTypes?: Partial<Record<FinishClaimType, number>>;
  step?: number;
  /** An in-loop call's cost proxy: model turns (steps) the loop took AFTER it and ms from the call to the run end. */
  stepsAfterCall?: number;
  callToEndMs?: number;
  /** FA-1: reads indexed this run + the distinct tokens they carried. */
  readsIndexed?: number;
  readTokens?: number;
  /** FA-4: FINISH_RUN_ACT as this run read it (off | seats | on). */
  actMode?: FinishRunActMode;
  /** FA-3: did act apply to this run's seat (null ⇒ never decided — no in-loop call reached the check). */
  actApplied?: boolean | null;
  actReason?: string;
  actSeatRate?: number;
  actSeatRuns?: number;
  /** FA-3: the in-loop correction was returned (the first failing in-loop call got the error instead of the ACK). */
  inLoopError?: boolean;
  /** FA-3: the run's FIRST finish_run call failed the check (measured in every mode — the shadow baseline). null ⇒ no call. */
  rejectedOnFirst?: boolean | null;
  /** FA-3: after the in-loop error, the next call passed the check (false: it failed or never came). null ⇒ no in-loop error. */
  correctedOnSecond?: boolean | null;
  /** FA-3: ms from the in-loop error to the next finish_run call (or to the run end when none came). */
  extraTurnMs?: number;
}

interface RecordedCall {
  parsed: ParsedFinishRun; receiptCount: number; source: 'model' | 'nudged'; step: number; at: number;
  /** FR: the executed / relayed evidence that existed WHEN the call was made (a claim cannot rest on later work). */
  executedCount: number; relayedCount: number;
  /** FA-1: the reads that existed WHEN the call was made (read-index sequence number). */
  readSeq: number;
}

/** The evidence context a check needs (the loop's receipt collector + the session loader). */
export interface FinishCheckContext {
  receipts: ReceiptLike[];
  priorReceipts?: ReceiptLike[];
  loadSessionReceipts?: () => Promise<ReceiptLike[]>;
}

interface CallCheck { verdicts: ClaimVerdict[]; valid: boolean; atCall: ReceiptLike[] }

// ── The in-loop correction (stage 2, FA-3) ──────────────────────────────────

/** Pinned head / tail of the in-loop correction. No failure marker (looksLikeToolFailure), never a ref echo. */
export const FINISH_RUN_CORRECTION_HEAD =
  '[HARNESS CHECK — finish_run, not typed by the user] This finish is not valid yet: some claims are not backed by anything this run did or read.';
export const FINISH_RUN_CORRECTION_TAIL =
  'You have ONE chance to correct it: call finish_run again with every claim backed (cite the id a receipt or a read of THIS run carries — '
  + 'read it now if you have not) and move anything you cannot back to open_items; a downgrade is always accepted. '
  + 'This check is not delivered to anyone and changes nothing you write: after that call, write your complete final answer exactly as you normally would.';

const REASON_WHY: Record<string, string> = {
  no_receipt: 'nothing this run executed or read carries this ref (no receipt, no read argument, no id a read returned).',
  unknown_receipt_id: 'this full id matches no receipt of this run and no read of this run returned it.',
  observed_only: 'you only READ this id this run — nothing you did changed it.',
  downgrade: 'the ref is real, but only as a weaker claim.',
};
const reasonFix = (v: ClaimVerdict): string => {
  if (v.reason === 'observed_only') return 'type it verify, or move the change to open_items.';
  if (v.reason === 'downgrade' && v.suggestType) return `claim it as ${v.suggestType}, or move the ${v.claim.type} to open_items.`;
  if (v.claim.type === 'verify') return 'read it now (get_chat_status / get_chat_messages / get_run_receipts / list_owner_questions …) and cite the id the read returns, or move it to open_items.';
  return 'cite the id the receipt of that action carries, or move it to open_items.';
};
const ERROR_TEXT: Partial<Record<FinishErrorKind, string>> = {
  malformed_args: 'the arguments are not a JSON object.',
  bad_status: `status must be one of ${FINISH_RUN_STATUSES.join(' | ')}.`,
  missing_summary: 'summary is empty.',
  unknown_type: `has an unknown type — use one of ${FINISH_CLAIM_TYPES.join(' | ')}.`,
  missing_ref: 'has no ref.',
  bad_claim: 'is not a {type, ref} object.',
  too_many_claims: `more than ${MAX_FINISH_CLAIMS} claims — keep the ones that matter.`,
  bad_open_item: 'is not a {text, kind?, ref?} object.',
};

/**
 * The in-loop correction for a failing finish_run call: which claims failed (by their index in the model's
 * claims array and their type — the ref itself is NEVER echoed, so the text can never launder an id into the
 * tool-output haystack the evidence guard / action verifier read), why, and the fix; the schema errors; the
 * run's own receipts of that class as the nearest candidates. Pure.
 */
export function finishRunCorrectionText(parsed: ParsedFinishRun, verdicts: ClaimVerdict[]): string {
  const lines: string[] = [FINISH_RUN_CORRECTION_HEAD];
  for (const e of parsed.errors.slice(0, 6)) {
    const t = ERROR_TEXT[e.kind] ?? 'is malformed.';
    const who = typeof e.index === 'number' ? (e.kind === 'bad_open_item' ? `open_items[${e.index}]` : `claims[${e.index}]`) : 'the call';
    lines.push(`- ${who}: ${t}${e.didYouMean ? ` Did you mean ${e.didYouMean}?` : ''}`);
  }
  verdicts.forEach((v, i) => {
    if (v.outcome !== 'unverified' || isTypeRepair(v)) return;
    const idx = parsed.claimIndex[i] ?? i;
    const nearest = v.nearest?.length ? ` This run's receipts of that class: ${v.nearest.join('; ')}.` : '';
    lines.push(`- claims[${idx}] (${v.claim.type}): ${REASON_WHY[v.reason ?? 'no_receipt'] ?? REASON_WHY.no_receipt} Fix: ${reasonFix(v)}${nearest}`);
  });
  lines.push(FINISH_RUN_CORRECTION_TAIL);
  return lines.join('\n');
}

/**
 * Per-run state. The loop calls onCall / onCallChecked (returns the ACK, or — stage 2 — the one in-loop
 * correction), observeToolResult (relayed rows, executed sends / writes, the read index), noteOffered, and
 * finalize once at the run end. The LAST call is the run's finish (a model that re-finishes after more work
 * supersedes itself); its claims are checked against the evidence that existed WHEN it was made — a claim
 * cannot rest on later work.
 */
export class FinishRunSession {
  private calls: RecordedCall[] = [];
  private relayed: ReceiptLike[] = [];
  private executed: ExecutedCall[] = [];
  private readIndex = new FinishReadIndex();
  private offeredEver = false;
  private sessionMemo: Promise<ReceiptLike[]> | null = null;
  private actMemo: Promise<FinishActDecision> | null = null;
  private actDecided: FinishActDecision | null = null;
  private inLoopError: { at: number; callIndex: number } | null = null;
  private readonly actMode: FinishRunActMode;

  /** `ownChatId` — this run's chat (FR-3: a supervisor's state save is its own chat's row). `actMode` defaults to FINISH_RUN_ACT. */
  constructor(private readonly ownChatId?: string, opts: { actMode?: FinishRunActMode } = {}) {
    this.actMode = opts.actMode ?? finishRunActMode();
  }

  noteOffered(): void { this.offeredEver = true; }
  offered(): boolean { return this.offeredEver; }
  called(): boolean { return this.calls.length > 0; }

  /** Record a finish_run call; returns the fixed acknowledgement the model sees (the shadow stage / a nudged call). */
  onCall(rawArgs: unknown, receiptCount: number, step: number, source: 'model' | 'nudged' = 'model'): string {
    try {
      this.calls.push({
        parsed: parseFinishRunArgs(rawArgs), receiptCount, source, step, at: Date.now(),
        executedCount: this.executed.length, relayedCount: this.relayed.length, readSeq: this.readIndex.reads,
      });
    } catch { /* never throws */ }
    return FINISH_RUN_ACK;
  }

  /**
   * FA-3 — an IN-LOOP call under stage 2: record it, and when act applies to this run (resolveAct — memoized
   * per run; fail-safe: shadow) and no correction was given yet, check it NOW against the evidence at the call.
   * A failing check answers finishRunCorrectionText (the run's ONE correction); everything else — a passing
   * check, act off, a call after the correction, any error — answers the fixed ACK. Never throws.
   */
  async onCallChecked(
    rawArgs: unknown, receiptCount: number, step: number,
    o: FinishCheckContext & { resolveAct?: () => Promise<FinishActDecision> },
  ): Promise<string> {
    const ack = this.onCall(rawArgs, receiptCount, step, 'model');
    try {
      if (this.inLoopError) return ack; // the one chance was given — this call (or none) ends it
      const decision = await this.resolveAct(o.resolveAct);
      if (!decision.act) return ack;
      const idx = this.calls.length - 1;
      if (idx < 0) return ack;
      const check = await this.checkCall(this.calls[idx], o);
      if (check.valid) return ack;
      this.inLoopError = { at: Date.now(), callIndex: idx };
      return finishRunCorrectionText(this.calls[idx].parsed, check.verdicts);
    } catch {
      return ack;
    }
  }

  private resolveAct(resolver?: () => Promise<FinishActDecision>): Promise<FinishActDecision> {
    if (!this.actMemo) {
      const mode = this.actMode;
      const p: Promise<FinishActDecision> = mode === 'seats'
        ? (resolver ? resolver().catch(() => finishRunActDecision(mode, null, false)) : Promise.resolve(finishRunActDecision(mode, null, false)))
        : Promise.resolve(finishRunActDecision(mode));
      this.actMemo = p.then((d) => { this.actDecided = d; return d; });
    }
    return this.actMemo;
  }

  /** One session-scope read per run, shared by the in-loop check and the finalize. */
  private sessionLoader(o: FinishCheckContext): (() => Promise<ReceiptLike[]>) | undefined {
    const load = o.loadSessionReceipts;
    if (!load) return undefined;
    return () => {
      if (!this.sessionMemo) this.sessionMemo = Promise.resolve().then(load).catch(() => []);
      return this.sessionMemo;
    };
  }

  /** Verify ONE recorded call against the evidence as it stood when it was made. */
  private async checkCall(call: RecordedCall, o: FinishCheckContext): Promise<CallCheck> {
    const atCall = [...(o.priorReceipts ?? []), ...o.receipts.slice(0, call.receiptCount)];
    const loadSession = this.sessionLoader(o);
    const verdicts = await verifyFinishClaims(call.parsed.claims, {
      thisRun: atCall, relayed: this.relayed.slice(0, call.relayedCount), executed: this.executed.slice(0, call.executedCount),
      ...(loadSession ? { loadSession } : {}),
      ...(this.ownChatId ? { ownChatId: this.ownChatId } : {}),
      readProves: (ref) => this.readIndex.provesVerify(ref, call.readSeq),
    });
    const unverified = verdicts.filter((v) => v.outcome === 'unverified' && !isTypeRepair(v));
    return { verdicts, atCall, valid: call.parsed.errors.length === 0 && unverified.length === 0 };
  }

  /**
   * Feed a dispatched tool's result: READ tools feed the read index (FA-1 — only a non-failed read; its args
   * and its returned ids); get_run_receipts rows also become relayed evidence; sends / writes / state tools
   * the executed tier. `ok` is the caller's failure-shape read; the file tools are judged by their OWN success
   * line instead (an edit_file "old_string not found…" answer — failure-shaped since d2e6b0fb — still wrote
   * nothing, so the `^Edited` line is the executed proof either way), a
   * supervisor state save by its `applied` list (FR-3), the FA-2 envelope tools by their ok:true, and a
   * run_command only when it is a git command that printed shas (FR-6 — every other shell call is ignored).
   */
  observeToolResult(tool: string, args: unknown, result: string, ok: boolean): void {
    try {
      const text = String(result ?? '');
      if (ok && isFinishReadTool(tool)) this.readIndex.add(tool, args, text);
      if (tool === 'get_run_receipts') { this.relayed.push(...parseRelayedReceiptRows(result)); return; }
      if (!TYPE_EXECUTED_TOOL_NAMES.has(tool)) return;
      if (tool === 'run_command') {
        const git = gitShellShas(args, text);
        if (git) this.executed.push({ tool, ok: true, git });
        return;
      }
      const success = EXECUTED_SUCCESS_LINE[tool];
      let okv = success ? success.test(text) : ok;
      if (okv && tool === 'update_supervisor_state') okv = stateSaveApplied(text);
      if (okv && ENVELOPE_OK_TOOLS.has(tool)) okv = envelopeOk(text);
      const path = args && typeof args === 'object' && typeof (args as any).path === 'string' ? String((args as any).path) : undefined;
      const ids = TYPE_EXECUTED_TOOLS.state_update?.has(tool) || TYPE_EXECUTED_TOOLS.schedule_armed?.has(tool) ? executedCallIds(args, text) : [];
      const keyArg = STATE_KEY_ARG[tool];
      const keyVal = keyArg && args && typeof args === 'object' && typeof (args as any)[keyArg] === 'string' ? String((args as any)[keyArg]).trim().slice(0, 200) : '';
      if (keyVal) ids.push(keyVal, ...refIdTokens(keyVal));
      this.executed.push({ tool, ok: okv, ...(path ? { path } : {}), ...(ids.length ? { ids: Array.from(new Set(ids)).slice(0, 40) } : {}) });
    } catch { /* observation never breaks the run */ }
  }

  /** Build the run's record. `receipts` = this run's collector (+ earlier attempts of a resumed run). */
  async finalize(o: {
    receipts: ReceiptLike[];
    priorReceipts?: ReceiptLike[];
    loadSessionReceipts?: () => Promise<ReceiptLike[]>;
    nudge: FinishNudge;
    finalText: string;
    /** The loop's step count at the end (stepsAfterCall). */
    endStep?: number;
  }): Promise<FinishRunRecord> {
    const last = this.calls[this.calls.length - 1];
    const act = this.actDecided;
    const base = {
      calls: this.calls.length,
      offered: this.offeredEver,
      nudge: o.nudge,
      finalChars: String(o.finalText ?? '').length,
      readsIndexed: this.readIndex.reads,
      readTokens: this.readIndex.size,
      actMode: this.actMode,
      actApplied: act ? act.act : null,
      ...(act ? { actReason: act.reason } : {}),
      ...(act && typeof act.seatRate === 'number' ? { actSeatRate: act.seatRate, actSeatRuns: act.seatRuns } : {}),
      inLoopError: !!this.inLoopError,
    };
    const all = [...(o.priorReceipts ?? []), ...o.receipts];
    if (!last) {
      const auto = autoFinishClaims(all);
      const autoClaimTypes: Partial<Record<FinishClaimType, number>> = {};
      for (const c of auto) autoClaimTypes[c.type] = (autoClaimTypes[c.type] ?? 0) + 1;
      return {
        ...base, source: 'auto', status: null, valid: false, errors: [], repairs: [],
        claims: 0, verified: 0, unverified: 0, repaired: 0, unverifiable: 0, scopeMismatch: 0, byVia: {}, claimTypes: {}, aliasTypes: 0,
        rejected: [], unverifiableRefs: [], openItems: 0, openKinds: {}, undeclared: 0, undeclaredSample: [],
        summaryChars: 0, receiptsAtCall: all.length, autoClaims: auto.length, autoClaimTypes,
        rejectedOnFirst: null, correctedOnSecond: null,
      };
    }
    const p = last.parsed;
    const ctx: FinishCheckContext = {
      receipts: o.receipts,
      ...(o.priorReceipts ? { priorReceipts: o.priorReceipts } : {}),
      ...(o.loadSessionReceipts ? { loadSessionReceipts: o.loadSessionReceipts } : {}),
    };
    const lastCheck = await this.checkCall(last, ctx);
    const { verdicts, atCall } = lastCheck;
    // FA-3 stage-2 telemetry: the FIRST call's verdict (the shadow baseline in every mode) and, after an
    // in-loop error, whether the NEXT call passed.
    const validOf = async (i: number): Promise<boolean> => (i === this.calls.length - 1 ? lastCheck.valid : (await this.checkCall(this.calls[i], ctx)).valid);
    const rejectedOnFirst = !(await validOf(0));
    let correctedOnSecond: boolean | null = null;
    let extraTurnMs: number | undefined;
    if (this.inLoopError) {
      const nextIdx = this.inLoopError.callIndex + 1;
      const next = this.calls[nextIdx];
      correctedOnSecond = next ? await validOf(nextIdx) : false;
      extraTurnMs = Math.max(0, (next ? next.at : Date.now()) - this.inLoopError.at);
    }
    const byVia: Partial<Record<FinishVia, number>> = {};
    const claimTypes: Partial<Record<FinishClaimType, number>> = {};
    for (const c of p.claims) claimTypes[c.type] = (claimTypes[c.type] ?? 0) + 1;
    for (const v of verdicts) if (v.via) byVia[v.via] = (byVia[v.via] ?? 0) + 1;
    // FR-1: a wrong_type claim with a ref-bound suggestion is REPAIRED (valid), recorded with its from → to.
    const repairedV = verdicts.filter(isTypeRepair);
    const unverified = verdicts.filter((v) => v.outcome === 'unverified' && !isTypeRepair(v));
    const unverifiable = verdicts.filter((v) => v.outcome === 'unverifiable');
    const typeRepairs: FinishTypeRepair[] = repairedV.slice(0, 8).map((v) => ({ from: v.claim.type, to: v.suggestType as FinishClaimType, ref: v.claim.ref.slice(0, 80), reason: 'wrong_type' }));
    const openKinds: Partial<Record<FinishOpenItemKind | 'unkinded', number>> = {};
    for (const it of p.openItems) { const k = it.kind ?? 'unkinded'; openKinds[k] = (openKinds[k] ?? 0) + 1; }
    const undeclared = undeclaredSummaryTokens(p.summary, p.claims, p.openItems);
    return {
      ...base,
      source: last.source,
      status: p.status,
      valid: lastCheck.valid,
      errors: p.errors.slice(0, 6),
      repairs: [...p.repairs.slice(0, 6), ...typeRepairs],
      claims: p.claims.length,
      verified: verdicts.filter((v) => v.outcome === 'verified').length,
      unverified: unverified.length,
      repaired: repairedV.length,
      unverifiable: unverifiable.length,
      scopeMismatch: verdicts.filter((v) => v.scopeMismatch).length,
      byVia, claimTypes,
      aliasTypes: p.claims.filter((c) => c.rawType).length,
      rejected: unverified.slice(0, 6).map((v) => ({
        type: v.claim.type, ref: v.claim.ref.slice(0, 80), reason: v.reason ?? 'no_receipt',
        ...(v.suggestType ? { suggestType: v.suggestType } : {}),
        ...(v.originCheckable ? { originCheckable: true } : {}),
        ...(v.nearest?.length ? { nearest: v.nearest } : {}),
      })),
      unverifiableRefs: unverifiable.slice(0, 4).map((v) => ({ type: v.claim.type, ref: v.claim.ref.slice(0, 80), reason: v.reason ?? '' })),
      openItems: p.openItems.length,
      openKinds,
      undeclared: undeclared.length,
      undeclaredSample: undeclared.slice(0, 5),
      summaryChars: p.summary.length,
      receiptsAtCall: atCall.length,
      step: last.step,
      ...(last.source === 'model' ? { callToEndMs: Math.max(0, Date.now() - last.at), ...(typeof o.endStep === 'number' ? { stepsAfterCall: Math.max(0, o.endStep - last.step) } : {}) } : {}),
      rejectedOnFirst,
      correctedOnSecond,
      ...(extraTurnMs !== undefined ? { extraTurnMs } : {}),
    };
  }
}

// ── Nudge + telemetry helpers ───────────────────────────────────────────────

/** Why the post-loop nudge does not run (null ⇒ it runs). Order = precedence. */
export function finishRunNudgeSkipReason(o: {
  called: boolean;
  finalText: string;
  cancelled: boolean;
  modelErrored: boolean;
  deadlineHit: boolean;
  terminalBreak: boolean;
  retiring: boolean;
}): string | null {
  if (o.called) return 'not_needed';
  if (o.cancelled) return 'cancelled';
  if (o.modelErrored) return 'model_error';
  if (o.retiring) return 'retiring';
  if (o.deadlineHit) return 'deadline';
  if (o.terminalBreak) return 'terminal_break';
  if (!String(o.finalText ?? '').trim()) return 'no_final';
  return null;
}

/** The finish_run row's meta (bounded — every list is already capped in the record). */
export function finishRunMeta(rec: FinishRunRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...rec, ...extra };
}

/**
 * The agreement row (stage-4 overlap measurement): the finish_run verdict vs
 * an old prose detector's verdict on the SAME delivered final.
 * cell: both_clean | both_flagged | finish_only | detector_only, or
 * no_finish_clean / no_finish_flagged on an auto-finished run.
 */
export function finishRunAgreementMeta(
  rec: FinishRunRecord,
  d: { detector: 'evidence_guard' | 'action_verifier'; convicted: boolean; kinds?: string[]; extra?: Record<string, unknown> },
): Record<string, unknown> {
  const finishFlagged: boolean | null = rec.source === 'auto' ? null : !rec.valid;
  const cell = finishFlagged === null
    ? (d.convicted ? 'no_finish_flagged' : 'no_finish_clean')
    : finishFlagged
      ? (d.convicted ? 'both_flagged' : 'finish_only')
      : (d.convicted ? 'detector_only' : 'both_clean');
  return {
    detector: d.detector,
    cell,
    agree: finishFlagged === null ? null : finishFlagged === d.convicted,
    finishSource: rec.source,
    finishValid: rec.valid,
    finishStatus: rec.status,
    finishClaims: rec.claims,
    finishUnverified: rec.unverified,
    finishRepaired: rec.repaired ?? 0,
    finishRejectedTypes: Array.from(new Set(rec.rejected.map((r) => r.type))),
    detectorConvicted: d.convicted,
    detectorKinds: (d.kinds ?? []).slice(0, 8),
    ...(d.extra ?? {}),
  };
}
