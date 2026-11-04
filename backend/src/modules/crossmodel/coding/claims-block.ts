/**
 * Typed CLAIMS block — claims-with-receipts, audit roadmap #6 PHASE 1.
 *
 * THE CONTRACT: a machine-run final answer MAY end with a fenced block
 *
 *   ```claims
 *   [{"type":"push","ref":"1539fa86","note":"digby/fix-x"},
 *    {"type":"pr","ref":"241"}]
 *   ```
 *
 * — a JSON array of typed completion claims, each naming the receipt-visible
 * id (`ref`) of a tool execution performed in THIS run or (scope:session /
 * scope:relayed, ticket ed728b87) an EARLIER run of the same chat. The
 * evidence guard's
 * claims-block lane (run-evidence-guard.ts `applyClaimsBlockLane`) verifies
 * every entry against the run's harness-written tool receipts
 * (run-receipts.ts) — verification becomes RECEIPT LOOKUP instead of the
 * prose-mining regex arms race. Phase 1 is ADDITIVE: an absent block changes
 * nothing (every existing prose lane runs exactly as today); a present,
 * fully-verified block earns a positive verdict and downgrades prose-mining
 * convictions for the covered claim classes; a present block with unverified
 * entries is convicted like any other fabricated-claim finding. Phase 2 (not
 * this module) makes prose advisory and retires the mined idioms.
 *
 * Claim types → receipt tools (RECEIPT_TOOLS, run-receipts.ts) → ref match:
 *   push          git_push                       ids.sha (hex prefix ≥7) | ids.branch (exact) | receipt id
 *                 — PLUS the origin-vouch leg (FO firing 4, 2026-09-22): an
 *                 unreceipted HEX-sha push ref whose commit the guard's GitHub
 *                 re-query confirms PRESENT on origin verifies via 'origin'
 *                 (applyClaimsBlockLane) — raw-shell `git push` (the Framework
 *                 Operator charter's own publish path) leaves only run_command
 *                 receipts, which carry no sha; a 404 stays a conviction and an
 *                 unreachable API lands unverifiable.
 *   pr            open_pull_request              ids.prNumber ("241" / "#241" / "PR 241" / …/pull/241) | ids.url (exact) | receipt id
 *   deploy        git_push, run_command          receipt id | ids.sha — else COARSE: any ok receipt of the
 *                                                class (mirrors receiptMatchesClaim's coarse deploy tier:
 *                                                receipts cannot yet prove WHICH deploy ran; phase 2
 *                                                sharpens refs to Actions run ids)
 *   ticket_update file_feedback,                ids.ticketId | ids.goalId | ids.todoId (prefix ≥8) | receipt id
 *                 update_feedback,               (4243f38a — the tool now leaves receipts; 601f05f8 —
 *                 todo_update, goal_update,      fleet-board goal/todo updates count as ticket updates;
 *                 todo_create, goal_create,      2026-10-18 — goal_create / todo_create / goal_premise_set
 *                 goal_premise_set               joined for parity with finish-run TYPE_RECEIPT_TOOLS,
 *                                                whose auto-suggest hands lanes ticket_update refs minted
 *                                                from goal_premise_set receipts)
 *   message_sent  send_chat_message,             receipt id | any envelope ids value (exact or prefix ≥8 —
 *                 schedule_message,              messageId/chatId/receiptId, whatever the envelope carried);
 *                 notify_user                    notify_user (1e356736): the channel token rides ids —
 *                                                the receipt id vouches; the message text NEVER enters ids
 *   dispatch      dispatch_platform_task,        same as message_sent
 *                 start_coding_session
 *   file_change   git_commit,                    git_commit: receipt id | ids.sha — else COARSE: any ok git_commit
 *                 open_pull_request               (receipts do not record paths; the ref path is advisory
 *                                                in phase 1).
 *                 (7177bb71, 2026-10-11) — a PR receipt vouches a PATH ref
 *                 ONLY via ids.files[]: exact repo-relative path, or a basename
 *                 unique in the list (ambiguity never vouches) — NEVER the
 *                 coarse tier. The raw-shell-commit shape (ticket lane: commits
 *                 via shell → no git_commit receipts, then git_push +
 *                 open_pull_request with ids.files[]) was false-convicted
 *                 before this channel existed.
 *                 — PLUS the origin-vouch leg (FO firing 4, 2026-09-22): an
 *                 unreceipted HEX-sha file_change ref confirmed PRESENT on
 *                 origin verifies via 'origin' — same rationale as push; a
 *                 404 stays a conviction (the sha does not exist), unavailable
 *                 lands unverifiable.
 *   verify        verify                         ids.passed === true REQUIRED; receipt id or a descriptive ref
 *
 * ANTI-FORGERY: a full-uuid ref that matches no receipt id NEVER falls through
 * to a coarse tier — an invented receipt-id citation stays unverified. Only
 * ok:true receipts count (a failed git_push proves nothing — the
 * receiptMatchesClaim hole-fix discipline). Runs that act through raw shell
 * instead of the receipted tools keep the prose lanes' GitHub re-query as
 * their exoneration path (the pr_created precedent in run-receipts.ts).
 *
 * SCOPE (ticket ed728b87, 2026-10-27): entries may carry finish_run's
 * scope field — {"scope":"session"} / {"scope":"relayed"} (aliases
 * earlier/carried/previous_run/prior/relay/lane/other_chat, mirroring finish-run's
 * SCOPE_ALIASES; anything else is dropped as unscoped). A scoped entry that
 * matched no THIS-run receipt re-matches against the chat's recent receipt
 * history (the caller's carriedReceipts — the get_run_receipts pool) and
 * verifies via 'session'/'relayed'; a miss keeps its this-run tier. The scope
 * field WIDENS THE RECEIPT CHANNEL for the cross-run claims finish_run's
 * schema documents; it never widens the conviction bar (an invented ref
 * verifies under no scope).
 *
 * DEPENDENCY-FREE leaf (run-receipts discipline): NO prisma, NO config/env,
 * NO imports beyond the ToolReceipt TYPE. Pure, deterministic, never throws.
 */

import type { ToolReceipt } from './run-receipts';

// ── Contract types ──────────────────────────────────────────────────────────

export const CLAIMS_BLOCK_TYPES = [
  'push', 'pr', 'deploy', 'ticket_update', 'message_sent', 'dispatch', 'file_change', 'verify',
  // 'merge' (tt-rd audit 2026-09-27, finding docs-churn-log-3): vouched ONLY by
  // a this-run merge_pull_request receipt (run-receipts MERGE_PR_OK_RE) — a
  // merged claim used to have no receipt class at all.
  'merge',
  // Ticket 6d7b379f (2026-10-12): the finish_run vocabulary joins the fence.
  // finish_run's documented type set (finish-run.ts FINISH_CLAIM_TYPES) always
  // had these four; models call finish_run as their LAST tool call right
  // before the final answer and carried its vocabulary into the fence — an
  // honest {"type":"commit","ref":"<sha>"} MALFORMED the whole block (live
  // incident: lane b92ef13f firing 22, 2026-10-12 16:37Z, msg 9c693023) and
  // the typed record was dropped wholesale. The two vocabularies are now one:
  //   commit         git_commit, git_push   receipt id | ids.sha (the ref IS
  //                  the sha) — LOCAL ONLY, never a push (finding A1's
  //                  receipt split); a VERIFIED commit entry covers the prose
  //                  commit_local class ONLY, sha-narrowed — never commit_pushed.
  //   schedule_armed schedule_message, update_schedule, cancel_schedule,
  //                  pause_schedule, resume_schedule   receipt id | ids.scheduleId
  //   email_sent     NO receipt tool (the email sends mint none) — the
  //                  unverifiable tier adjudicates exactly like deploy: a
  //                  miss is advisory, a forged full-uuid ref still convicts.
  //   state_update   stop_run, dismiss_owner_question, cancel_confirmation,
  //                  approve_request, set_chat_autonomy, set_chat_instructions,
  //                  set_decision_gate_mode   receipt id | any ids value —
  //                  misses land unverifiable (the supervisor state tools
  //                  mint no receipt; finish-run FR-3's 18-rejection lesson).
  'commit', 'schedule_armed', 'email_sent', 'state_update',
] as const;

export type ClaimsBlockType = (typeof CLAIMS_BLOCK_TYPES)[number];

export interface ClaimsBlockEntry {
  type: ClaimsBlockType;
  /** The receipt-visible id: sha, branch, PR number/URL, ticket id, path, or a harness receipt id. */
  ref: string;
  /**
   * Ticket ed728b87 (2026-10-27): the finish_run SCOPE vocabulary joins the
   * fence. finish_run accepts scope 'session' / 'relayed' for exactly the
   * cross-run claims a multi-firing lane makes (the run before this one did
   * the work), but the fence ignored the field — an honest scope:session
   * entry whose receipt lives in the chat's EARLIER runs was convicted ("no
   * matching receipt in this run"). When present (and only then), verification
   * re-matches the ref against the chat's recent receipt history — the same
   * pool get_run_receipts serves — before the miss tiers apply. A ref found in
   * NO pool is still unverified (an invented id never verifies under any
   * scope), so this widens the receipt channel, never the conviction bar.
   * Unrecognized values are dropped at parse (treated as unscoped).
   */
  scope?: 'session' | 'relayed';
  /** Optional free-text gloss — advisory, never read by verification. */
  note?: string;
}

/** Parse outcome. present=false → no fenced claims block anywhere in the text. */
export interface ParsedClaimsBlock {
  present: boolean;
  /** The parsed entries — null when absent OR malformed (see malformedReason). */
  claims: ClaimsBlockEntry[] | null;
  /** Why parsing failed — set exactly when present && claims === null. */
  malformedReason?: string;
}

/** Cap on entries in one block (a fabricated flood must not soak the matcher). */
export const MAX_CLAIMS_BLOCK_ENTRIES = 25;

// ── Parsing (tolerant: LAST fenced block wins; malformed → null with reason) ─

/**
 * The claims-fence line grammar (single source of truth — ticket 59ac00bd F1):
 * a ```claims opener at (or near) the start of a line, through the closing
 * fence on its own line. Anchored to line starts so an inline mention of the
 * fence in prose never parses; up to 3 leading spaces/tabs tolerated on the
 * OPENER (markdown fence rules — indented ≥4 it is an indented CODE block,
 * never a claims fence); the closer may sit at any indentation. Trailing
 * blanks (and a CR from CRLF text) tolerated on both.
 */
const CLAIMS_FENCE_OPEN_LINE_RE = /^[ \t]{0,3}```claims[ \t]*\r?$/;
const CLAIMS_FENCE_CLOSE_LINE_RE = /^[ \t]*```[ \t]*\r?$/;
/**
 * TWO-LINE opener (owner screenshot 2026-09-25 — the manifest rendering as a
 * plain "Text" code block under a verified final): the models wrote the fence
 * as a bare ``` line followed by the word `claims` on the NEXT line — 12 of 12
 * finals across four sessions over three days — because the claim-bar
 * instruction said "a line of three backticks followed by the word claims"
 * (now reworded to the literal opener). That shape is a plain code block to
 * markdown and was invisible to this parser (present:false — the typed
 * manifest lane silently verified nothing) AND to the UI splitter. Accepted
 * here as an opener spanning two lines; the frontend splitter mirrors it.
 */
const CLAIMS_BARE_FENCE_LINE_RE = /^[ \t]{0,3}```[ \t]*\r?$/;
const CLAIMS_WORD_LINE_RE = /^[ \t]*claims[ \t]*\r?$/;
/** Opener at line i: returns the number of opener LINES (1 or 2), or 0 when none. */
function claimsOpenerAt(lines: string[], i: number): number {
  if (CLAIMS_FENCE_OPEN_LINE_RE.test(lines[i])) return 1;
  if (CLAIMS_BARE_FENCE_LINE_RE.test(lines[i]) && i + 1 < lines.length && CLAIMS_WORD_LINE_RE.test(lines[i + 1])) return 2;
  return 0;
}

/** One fenced ```claims block located in the source text: its 0-based
 *  inclusive LINE span (indexing text.split('\n')) and raw body text. */
export interface ClaimsFenceMatch {
  startLine: number;
  endLine: number;
  body: string;
}

/**
 * Locate EVERY fenced ```claims block in text, in source order, on the RAW
 * lines with the strict fence grammar above. Pairing is nearest-following-
 * closer (an opener with no later closer yields no match; a nested opener
 * line inside a body is just body text). Consumers that exclude a parsed
 * block's lines from a prose scan MUST take the span from here — a span
 * computed any other way (e.g. on trimmed lines) can bind to lines the
 * parser never saw (ticket 59ac00bd F1: a ≥4-space-indented pseudo-fence
 * vanished from guard-6's ticket scan unparsed).
 */
export function findClaimsFences(text: string): ClaimsFenceMatch[] {
  const out: ClaimsFenceMatch[] = [];
  if (!text) return out;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const openerLines = claimsOpenerAt(lines, i);
    if (!openerLines) continue;
    for (let j = i + openerLines; j < lines.length; j++) {
      if (CLAIMS_FENCE_CLOSE_LINE_RE.test(lines[j])) {
        out.push({ startLine: i, endLine: j, body: lines.slice(i + openerLines, j).join('\n') });
        i = j;
        break;
      }
    }
  }
  return out;
}

/** Best-effort JSON cleanup: strip trailing commas before } or ] (the one
 *  malformation models actually produce). Applied only on a failed parse. */
function stripTrailingCommas(src: string): string {
  return src.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse one fenced block's BODY with the tolerant rules: a single object is
 * wrapped into an array; numeric refs are coerced to strings; trailing commas
 * are stripped on a retry; unknown extra keys are ignored. Anything else
 * malformed → { present: true, claims: null, reason }.
 */
function parseClaimsBody(body: string): ParsedClaimsBlock {
  const malformed = (reason: string): ParsedClaimsBlock => ({ present: true, claims: null, malformedReason: reason });

  const raw = body.trim();
  if (!raw) return malformed('empty claims block');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripTrailingCommas(raw));
    } catch (err: any) {
      return malformed(`invalid JSON: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length > MAX_CLAIMS_BLOCK_ENTRIES) return malformed(`more than ${MAX_CLAIMS_BLOCK_ENTRIES} entries`);

  const claims: ClaimsBlockEntry[] = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return malformed(`entry ${i} is not an object`);
    const typeRaw = (e as Record<string, unknown>).type;
    // Ticket 6d7b379f (reviewer M2): finish_run DOCUMENTS `pr_opened` /
    // `pr_merged` where the fence spells them `pr` / `merge` — the two
    // remaining members of finish-run.ts FINISH_CLAIM_TYPES a model copying
    // its finish_run claims into the fence would write. Accepted as spellings
    // of the fence types ONLY; finish-run's wider FUZZY alias table
    // (pushed/committed/merged/…) is deliberately NOT imported — the fence
    // keeps its strict vocabulary, and "merged" stays an unknown type.
    const type = typeRaw === 'pr_opened' ? 'pr' : typeRaw === 'pr_merged' ? 'merge' : typeRaw;
    if (typeof type !== 'string' || !(CLAIMS_BLOCK_TYPES as readonly string[]).includes(type)) {
      return malformed(`entry ${i} has unknown claim type ${JSON.stringify(typeRaw ?? null)}`);
    }
    const refRaw = (e as Record<string, unknown>).ref;
    const ref = typeof refRaw === 'string' ? refRaw.trim() : typeof refRaw === 'number' ? String(refRaw) : '';
    if (!ref) return malformed(`entry ${i} (${type}) is missing ref`);
    const noteRaw = (e as Record<string, unknown>).note;
    const entry: ClaimsBlockEntry = { type: type as ClaimsBlockType, ref };
    // Ticket ed728b87: finish_run's scope vocabulary (FINISH_SCOPES minus
    // 'this_run' — a this_run scope carries no extra information, the default).
    // Aliases mirror finish-run's SCOPE_ALIASES so a model copying its
    // finish_run claims verbatim parses; anything else is DROPPED (unscoped),
    // never malformed — scope is optional metadata, not part of the contract.
    const scopeRaw = typeof (e as Record<string, unknown>).scope === 'string'
      ? String((e as Record<string, unknown>).scope).trim().toLowerCase().replace(/[\s-]+/g, '_')
      : '';
    const scope = scopeRaw === 'session' || scopeRaw === 'earlier' || scopeRaw === 'carried' || scopeRaw === 'previous_run' || scopeRaw === 'prior'
      ? 'session' as const
      : scopeRaw === 'relayed' || scopeRaw === 'relay' || scopeRaw === 'lane' || scopeRaw === 'other_chat'
        ? 'relayed' as const
        : null;
    if (scope) entry.scope = scope;
    if (typeof noteRaw === 'string' && noteRaw) entry.note = noteRaw;
    claims.push(entry);
  }
  return { present: true, claims };
}

/**
 * Find the LAST fenced ```claims block in the text and parse it (the claims
 * lane's LAST-wins contract), with parseClaimsBody's tolerant rules.
 */
export function parseClaimsBlock(text: string): ParsedClaimsBlock {
  if (!text) return { present: false, claims: null };
  const fences = findClaimsFences(text);
  if (!fences.length) return { present: false, claims: null };
  return parseClaimsBody(fences[fences.length - 1].body);
}

/** A fenced claims block with its parse outcome, bound to its 0-based
 *  inclusive LINE span (indexing text.split('\n')) by construction. */
export interface ParsedClaimsFence {
  startLine: number;
  endLine: number;
  result: ParsedClaimsBlock;
}

/**
 * Parse EVERY fenced ```claims block in text, in source order (ticket
 * 59ac00bd F2). Each block is parsed independently with parseClaimsBlock's
 * tolerant rules — a malformed block never poisons its neighbours. Guard-6
 * consumes this so the spans it excludes from the prose scan are EXACTLY the
 * blocks it parsed (span ↔ typed context bound by construction, F1).
 */
export function parseClaimsBlocks(text: string): ParsedClaimsFence[] {
  return findClaimsFences(text).map((f) => ({ startLine: f.startLine, endLine: f.endLine, result: parseClaimsBody(f.body) }));
}

// ── Ref matching helpers ────────────────────────────────────────────────────

// fb64368a review finding 6: exported so run-executor's zero-receipt gate
// imports the SAME uuid shape it adjudicates fence refs against — a
// hand-copied duplicate would silently diverge if this shape ever changes.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{7,40}$/i;

/** Prefix-tolerant id match (run-receipts' M1 rule): exact, or BOTH sides ≥8
 *  chars with either a prefix of the other. Case-insensitive. */
function idMatches(cited: string, actual: string): boolean {
  const c = cited.toLowerCase();
  const a = actual.toLowerCase();
  return a === c || (c.length >= 8 && a.length >= 8 && (a.startsWith(c) || c.startsWith(a)));
}

/** Git-sha match: both sides hex (≥7 for the cited side — git short-sha), prefix either way. */
export function refNamesSha(ref: string, sha: string): boolean {
  const c = ref.trim().toLowerCase();
  const a = sha.trim().toLowerCase();
  if (!HEX_ID_RE.test(c) || !HEX_ID_RE.test(a)) return false;
  return a === c || a.startsWith(c) || c.startsWith(a);
}

/**
 * True when a claims-block ref is a bare git sha (7–40 hex) — the only ref
 * shape the origin-vouch leg (applyClaimsBlockLane) can adjudicate: the
 * commits API answers shas, never branch names or paths. Exported for the
 * guard's origin tier (dependency-free leaf discipline holds — no imports).
 */
export function isHexRef(ref: string): boolean {
  return HEX_ID_RE.test(ref.trim());
}

/** True iff the ref names exactly this PR number: "241", "#241", "PR 241",
 *  "PR #241", or a …/pull/241 URL. A ref naming no number matches nothing. */
export function refNamesPrNumber(ref: string, prNumber: number): boolean {
  const r = ref.trim();
  const url = r.match(/\/pulls?\/(\d{1,6})\b/i);
  if (url) return parseInt(url[1], 10) === prNumber;
  const bare = r.match(/^(?:PR\s*)?#?(\d{1,6})$/i);
  return bare !== null && parseInt(bare[1], 10) === prNumber;
}

/** Any envelope ids value (string/number) matching ref — exact, or prefix ≥8 both sides. */
function anyIdsValueMatches(ref: string, ids: Record<string, unknown>): boolean {
  for (const v of Object.values(ids ?? {})) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (idMatches(ref, String(v))) return true;
  }
  return false;
}

/**
 * True iff the claimed file ref names a file in the PR receipt's changed-files
 * list (7177bb71, 2026-10-11). Match discipline: exact repo-relative path
 * (case-insensitive, slashes normalized); ELSE a basename match that is
 * UNIQUE in the list — "probe-x.js" matching two listed files vouches
 * nothing (ambiguity never vouches). A leading "./" or "/" on either side is
 * trimmed so prose-shaped refs ("/app/x.ts", "./x.ts") still match the
 * repo-relative list.
 */
export function refNamesPrFile(ref: string, files: readonly string[]): boolean {
  const norm = (p: string) => p.trim().toLowerCase().replace(/^[./]+/, '').replace(/\/+/g, '/');
  const r = norm(ref);
  if (!r) return false;
  if (files.some((f) => norm(f) === r)) return true;
  const base = r.split('/').pop()!;
  const hits = files.filter((f) => (norm(f).split('/').pop() ?? '') === base);
  return hits.length === 1;
}

// ── Claim ↔ receipt verification ────────────────────────────────────────────

/** The receipt tools each claim type may be proven by (see header table). */
const CLAIM_TYPE_TOOLS: Record<ClaimsBlockType, ReadonlySet<string>> = {
  push: new Set(['git_push']),
  pr: new Set(['open_pull_request']),
  deploy: new Set(['git_push', 'run_command']),
  // 601f05f8: fleet-board goal/todo mutations are 'ticket' updates in lane
  // parlance — a claims-block ticket_update ref naming a goal/todo id is
  // vouched by that row's goal_update/todo_update receipt (the 421938f3
  // incident: an honest todo-done claim was convicted as phantom for want of
  // this leg). The ref-match stays id-exact — no coarse-tier laundering.
  // Vocabulary drift fix (2026-10-18, lane b92ef13f strike specimen
  // "ticket_update fa54f4b9" at 2026-10-17 16:48Z): finish-run.ts
  // TYPE_RECEIPT_TOOLS.ticket_update had ALREADY grown goal_create /
  // todo_create / goal_premise_set (its auto-suggest at finish-run.ts:1187
  // even hands the lane a ticket_update ref minted from a goal_premise_set
  // receipt) while this map stayed three tools short — a truthful,
  // receipt-backed premise registration (ids.goalId, run-receipts.ts:592)
  // was convicted as a phantom. All three mint receipts carrying exactly
  // the ids.ticketId|goalId|todoId keys the matcher below reads; parity
  // with finish-run's set is now pinned by test.
  ticket_update: new Set(['file_feedback', 'update_feedback', 'todo_update', 'goal_update', 'todo_create', 'goal_create', 'goal_premise_set']),
  message_sent: new Set(['send_chat_message', 'schedule_message',
    // notify_user (todo 1e356736, 2026-10-16): the Telegram push now mints a
    // receipt (NOTIFY_RECEIPT_TOOLS) — ids {channel} only, so the vouch is the
    // receipt id (or the channel token via anyIdsValueMatches), never the
    // message text. finish-run FR-4's EXECUTED tier keeps the tool as the
    // anon-session fallback.
    'notify_user']),
  dispatch: new Set(['dispatch_platform_task', 'start_coding_session']),
  // 7177bb71 (2026-10-11): open_pull_request joins git_commit as a file_change
  // vouch channel — its receipt records the PR's changed files (ids.files[]),
  // which is exactly the evidence a raw-shell-committed lane holds (it has no
  // git_commit receipts, but a real PR). Path-matched only — see the
  // file_change leg in claimMatchesReceipt (a PR receipt never rides the
  // coarse tier; git_commit keeps it).
  file_change: new Set(['git_commit', 'open_pull_request']),
  verify: new Set(['verify']),
  merge: new Set(['merge_pull_request']),
  // Ticket 6d7b379f (2026-10-12) — the finish_run vocabulary. Receipt rules
  // mirror finish-run.ts TYPE_RECEIPT_TOOLS where the receipt channel exists:
  'commit': new Set(['git_commit', 'git_push']),
  'schedule_armed': new Set(['schedule_message', 'update_schedule', 'cancel_schedule', 'pause_schedule', 'resume_schedule']),
  // The email sends mint NO receipt (finish-run FR-4 lists notify_user /
  // gmail_send_email as EXECUTED-tier there) — here an email_sent entry can
  // never receipt-verify; misses land unverifiable (see verifyClaimsBlock).
  'email_sent': new Set<string>(),
  'state_update': new Set(['stop_run', 'dismiss_owner_question', 'cancel_confirmation', 'approve_request', 'set_chat_autonomy', 'set_chat_instructions', 'set_decision_gate_mode',
    // audit 94f608c1 (2026-10-16): the supervisor-state mutations now mint
    // receipts (run-receipts SUPERVISOR_STATE_RECEIPT_TOOLS) — an archive, an
    // owner-question flag and a state save are receipt-verifiable claims, not
    // executed-tier-only. update_supervisor_state is the real tool behind the
    // request's "save_supervisor_state" vocabulary.
    // Follow-up 60bfeab1 (2026-10-16): answer_owner_question joins the same
    // receipted class (specimen: the FS's 05:24Z triage answer oq_05c1345d) —
    // a supervisor's "answered oq_…" claim verifies on the receipt tier;
    // finish-run's EXECUTED tier keeps it as the anon-session fallback.
    'archive_chat', 'flag_owner_question', 'update_supervisor_state', 'answer_owner_question']),
};

/**
 * Does ONE ok receipt of the claim's tool class prove this claim? See the
 * header table for the per-type rules. Anti-forgery: a full-uuid ref must
 * match the receipt's id — it never rides a coarse tier.
 */
function claimMatchesReceipt(claim: ClaimsBlockEntry, r: ToolReceipt): boolean {
  if (!r.ok) return false;
  if (!CLAIM_TYPE_TOOLS[claim.type].has(r.tool)) return false;
  const ref = claim.ref.trim();
  const ids = (r.ids ?? {}) as Record<string, unknown>;
  switch (claim.type) {
    case 'verify': {
      // The receipt must record a PASSED verify — an executed-but-failed
      // chain proves the opposite of the claim.
      if (ids.passed !== true) return false;
      return idMatches(ref, r.id) || !UUID_RE.test(ref);
    }
    case 'push': {
      if (idMatches(ref, r.id)) return true;
      const sha = typeof ids.sha === 'string' ? ids.sha : null;
      const branch = typeof ids.branch === 'string' ? ids.branch : null;
      return (!!sha && refNamesSha(ref, sha)) || (!!branch && ref === branch);
    }
    case 'pr': {
      if (idMatches(ref, r.id)) return true;
      const num = ids.prNumber;
      if ((typeof num === 'number' || typeof num === 'string') && refNamesPrNumber(ref, Number(num))) return true;
      const url = typeof ids.url === 'string' ? ids.url : null;
      return !!url && ref === url;
    }
    case 'merge': {
      // The merge receipt's ids: { repo, prNumber, mergeSha } — a ref names the
      // PR number ("#740" / "PR 740" / "740") or the merge sha (prefix ≥ 7).
      if (idMatches(ref, r.id)) return true;
      const num = ids.prNumber;
      if ((typeof num === 'number' || typeof num === 'string') && refNamesPrNumber(ref, Number(num))) return true;
      const sha = typeof ids.mergeSha === 'string' ? ids.mergeSha : null;
      return !!sha && refNamesSha(ref, sha);
    }
    case 'ticket_update': {
      if (idMatches(ref, r.id)) return true;
      // Match the receipt's target id — the feedback ticketId (4243f38a) or
      // the fleet board's goalId/todoId (601f05f8). Full-uuid refs still
      // never ride a coarse tier: no id match, no vouch.
      for (const key of ['ticketId', 'goalId', 'todoId'] as const) {
        const t = typeof ids[key] === 'string' ? (ids[key] as string) : null;
        if (t && idMatches(ref, t)) return true;
      }
      return false;
    }
    case 'message_sent':
    case 'dispatch':
      return idMatches(ref, r.id) || anyIdsValueMatches(ref, ids);
    case 'commit': {
      // Ticket 6d7b379f: a commit entry's ref IS the sha (finish-run contract
      // "commit (sha; local, not pushed)"). A git_commit receipt's ids.sha
      // names the committed sha; a git_push receipt's ids.sha names a push
      // that necessarily contained the commit (finish-run's "a pushed commit
      // was committed" rule). NEVER the coarse tier — a specific sha must be
      // named; a full-uuid ref still requires the receipt id (anti-forgery).
      if (idMatches(ref, r.id)) return true;
      const sha = typeof ids.sha === 'string' ? ids.sha : null;
      return !!sha && refNamesSha(ref, sha);
    }
    case 'schedule_armed': {
      if (idMatches(ref, r.id)) return true;
      const sid = typeof ids.scheduleId === 'string' ? ids.scheduleId : typeof ids.scheduleId === 'number' ? String(ids.scheduleId) : null;
      return !!sid && idMatches(ref, sid);
    }
    case 'email_sent': {
      // No receipt tool can vouch an email (CLAIM_TYPE_TOOLS.email_sent is
      // empty) — unreachable while the guard holds; kept explicit so a future
      // receipt channel slots in deliberately, never via the coarse tier.
      return idMatches(ref, r.id) && false;
    }
    case 'state_update':
      // The state tools' receipts often carry empty ids envelopes (finish-run
      // FR-3): the receipt id is the anchor; any ids value the envelope did
      // carry (scheduleId, ticketId, purpose…) vouches the same way
      // message_sent's envelope ids do. A specific ref must NAME something.
      return idMatches(ref, r.id) || anyIdsValueMatches(ref, ids);
    case 'deploy': {
      if (idMatches(ref, r.id)) return true;
      const sha = typeof ids.sha === 'string' ? ids.sha : null;
      if (sha && refNamesSha(ref, sha)) return true;
      // Coarse tier RETIRED (P4 v1#23): "any ok git_push/run_command vouches"
      // let an ok `ls` receipt stamp a deploy claim VERIFIED. A deploy ref must
      // now actually MATCH (receipt id / ids.sha); everything else lands in the
      // 'unverifiable' tier (verifyClaimsBlock) — never VERIFIED, and convicted
      // only when the ref is a forged full-uuid receipt citation.
      return false;
    }
    case 'file_change': {
      // Coarse tier: any ok git_commit vouches (a commit ran; receipts do not
      // record paths — the path ref is advisory). 7177bb71 (2026-10-11): a PR
      // receipt NEVER rides the coarse tier — the branch would let ANY ok
      // open_pull_request vouch ANY path. A PR receipt vouches only when its
      // ids.files[] names the claimed path: exact repo-relative match, or a
      // basename unique in the list (ambiguity never vouches). UUID refs
      // still require a receipt-id match (anti-forgery unchanged).
      if (r.tool === 'open_pull_request') {
        if (idMatches(ref, r.id)) return true;
        const files = Array.isArray(ids.files) ? (ids.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
        if (files.length && refNamesPrFile(ref, files)) return true;
        return false; // never coarse
      }
      return idMatches(ref, r.id) || !UUID_RE.test(ref); // coarse: an ok git_commit vouches; path advisory
    }
  }
}

export interface VerifiedBlockClaim {
  claim: ClaimsBlockEntry;
  /** The id of the receipt that proved it (first match wins). */
  receiptId: string;
  /**
   * 'origin' when this entry was verified NOT by a harness receipt but by the
   * guard's GitHub origin re-query (applyClaimsBlockLane's origin-vouch leg,
   * Framework Operator firing 4 2026-09-22): a hex-sha push/file_change entry
   * whose run performed the work through raw shell (`git push origin HEAD:main`
   * — the Framework Operator charter's own publish path) leaves only
   * run_command receipts, which carry no sha. The commit confirmed PRESENT on
   * origin is the same truth channel prose GUARD 2b already uses; a 404 stays
   * a conviction and an unreachable API lands unverifiable. ReceiptId then
   * carries the confirmed sha (traceability), not a receipt id.
   *
   * 'session' / 'relayed' (ticket ed728b87, 2026-10-27): the entry DECLARED
   * scope:session / scope:relayed (finish_run's cross-run scopes) and its ref
   * matched a receipt from an EARLIER run of the same chat (the executor's
   * carried pool). The receipt id is real and traceable via get_run_receipts;
   * the via value says the run that minted it was not this one.
   */
  via?: 'origin' | 'session' | 'relayed';
}

export interface ClaimsBlockVerification {
  verified: VerifiedBlockClaim[];
  unverified: ClaimsBlockEntry[];
  /**
   * The 'unverifiable' tier (P4 v1#23): entries whose ref the receipt channel
   * CANNOT adjudicate — today, deploy entries with a descriptive/run-id ref or
   * an unmatched sha (receipts carry no Actions run ids; the prose lanes'
   * GUARD 5 Actions-API check stays the truth channel for those). Never
   * VERIFIED (an ok `ls` receipt must not vouch) and never a conviction (a
   * miss, not a strike) — but such a block earns NO claimsBlockVerified
   * positive verdict. Empty when the kill-switch restores the coarse tier.
   * (verify and file_change have NO unverifiable tier — a miss is a
   * conviction; see tickets aada3761 / 4243f38a.)
   */
  unverifiable: ClaimsBlockEntry[];
}

/**
 * Verify a parsed claims block against THIS run's tool receipts. Pure and
 * deterministic — no network, no GitHub: the receipts ARE the evidence
 * channel (the prose lanes' GitHub re-query stays the exoneration path for
 * un-receipted honest work). Every claim lands in exactly one bucket:
 * verified (a receipt proved it), unverified (a receipt SHOULD have existed —
 * conviction), or unverifiable (the receipt channel cannot adjudicate the
 * ref — advisory; see the tier note above).
 *
 * Ticket ed728b87 (2026-10-27): a scope:session / scope:relayed entry names
 * work an EARLIER run of the same chat performed — finish_run's schema and
 * docs bless exactly that shape (FINISH_SCOPES). `carriedReceipts` is the
 * chat's recent receipt history (run-executor's guardCarriedReceipts, the
 * same pool get_run_receipts serves): when present, each UNMATCHED entry
 * whose scope is session/relayed re-matches against it and verifies with
 * via:'session'/'relayed' (finish-run's cross-run evidence semantics). A miss
 * there still falls through to the unverified/unverifiable tiers unchanged —
 * an invented id never verifies under any scope, so the conviction set for
 * this-run entries is byte-identical to the pre-ed728b87 behavior.
 */
export function verifyClaimsBlock(claims: ClaimsBlockEntry[], receipts: ToolReceipt[], carriedReceipts?: ToolReceipt[]): ClaimsBlockVerification {
  const verified: VerifiedBlockClaim[] = [];
  const unverified: ClaimsBlockEntry[] = [];
  const unverifiable: ClaimsBlockEntry[] = [];
  const carried = carriedReceipts?.length ? carriedReceipts : null;
  const missingWithScope: ClaimsBlockEntry[] = [];
  for (const claim of claims) {
    const match = receipts.find((r) => claimMatchesReceipt(claim, r));
    if (match) {
      verified.push({ claim, receiptId: match.id });
      continue;
    }
    if (carried && claim.scope) missingWithScope.push(claim);
    // Unmatched deploy entries: a forged full-uuid receipt citation stays a
    // conviction; an unmatched-but-receipt-shaped sha, a run id, or a
    // descriptive ref is 'unverifiable' — GUARD 5 (Actions API) and GUARD 2b
    // (commits API) adjudicate those on the prose side (P4 v1#23). verify
    // entries NEVER demote (ticket aada3761: a miss is a conviction —
    // CLAIM_TYPE_TOOLS.verify = {'verify'} by design so an ok `ls` can never
    // stamp a verify claim); file_change without an ok git_commit likewise
    // stays convicted (4243f38a reconciliation — the contract texts teach
    // "entry with no matching receipt = fabricated until re-verified").
    // Ticket 6d7b379f: commit joins the strict pair (a sha-bearing claim
    // names its evidence — a git_commit/git_push receipt or nothing), while
    // schedule_armed / email_sent / state_update misses land unverifiable:
    // schedule_self and the supervisor state tools mint NO receipt (finish-run
    // FR-3/FR-7's 18-false-rejection lesson), and the email sends mint none
    // at all — the receipt channel cannot adjudicate those refs, and GUARD 8
    // (schedule-id DB existence) remains the truth channel for schedule ids.
    // None of them earns the claimsBlockVerified verdict (unverifiable
    // entries block it by construction).
    if ((claim.type === 'deploy' || claim.type === 'schedule_armed' || claim.type === 'email_sent' || claim.type === 'state_update')
      && !UUID_RE.test(claim.ref.trim())) {
      unverifiable.push(claim);
      continue;
    }
    unverified.push(claim);
  }
  // ── Cross-run second pass (ticket ed728b87) ────────────────────────────────
  // After the this-run tiers settle: each unmatched entry that DECLARED
  // scope:session / scope:relayed gets one re-match against the chat's recent
  // receipt history. A hit verifies via:'session'/'relayed' (the ref is a
  // real receipt of this chat — an honest cross-run claim, not a fabrication);
  // a miss stays in its this-run tier (a scope decoration cannot launder an
  // invented ref — the unverified/unverifiable sets are untouched otherwise).
  // A forged full-uuid ref also stays convicted here: claimMatchesReceipt is
  // id-narrow for uuid refs, so the scope pass adds no coarse tier.
  if (missingWithScope.length && carried) {
    for (const claim of missingWithScope) {
      const match = carried.find((r) => claimMatchesReceipt(claim, r));
      if (!match) continue;
      verified.push({ claim, receiptId: match.id, via: claim.scope });
      // Remove the claim from the ONE tier it actually landed in (indexOf ≥ 0 —
      // a -1 splice would eat an unrelated entry).
      const ui = unverified.indexOf(claim);
      if (ui !== -1) unverified.splice(ui, 1);
      const vi = unverifiable.indexOf(claim);
      if (vi !== -1) unverifiable.splice(vi, 1);
    }
  }
  return { verified, unverified, unverifiable };
}
