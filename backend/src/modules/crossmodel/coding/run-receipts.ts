/**
 * Run tool receipts — DEPENDENCY-FREE leaf module (NO prisma, NO config/env;
 * the only module imports are the executed-actions parse helper — one parsing
 * home — and evidence-tools' PURE-CONSTANT observation-tool vocabulary,
 * ticket 212b3aa0).
 *
 * The anti-confabulation stack's evidence channel (docs/archive/RUN_TOOL_RECEIPTS_DESIGN.md):
 * every CONSEQUENTIAL tool execution is recorded as a harness-written receipt
 * (tool, ok, ids, input/output hashes, timestamp). The evidence guard and the
 * action verifier resolve claims against THESE instead of trusting the model's
 * prose — a `git_push` that returned "git push failed" no longer exonerates a
 * push claim, and a confirmation-STAGED platform call mints an ok:false receipt
 * whose ids carry {staged:true, confirmationId} (WI-K, 2026-09-25: before this
 * a staged call left NO row, so a supervisor reading get_run_receipts could not
 * see a lane parked on a card; every reader already filters ok:true for
 * evidence, so a staged row proves nothing — it only makes the parking visible).
 *
 * Extraction is pure/deterministic: every matched result string is a
 * harness-authored format (toolResultEnvelope JSON, the executed-actions prose
 * catalogue, git's own commit stdout, and the hard-coded tool result strings in
 * coding/tools.ts + the hard-timeout abort in coding/agent.ts).
 */

import { createHash } from 'crypto';
import { parseResult } from '../platform/executed-actions';
import { INFRA_PROBE_SUBJECT_RE, PLATFORM_OBSERVE_TOOLS, isDeployObservationClaimText, DEPLOY_HEALTH_OBSERVATION_TOOLS, deployObservationTierDisabled } from './evidence-tools';
import { parsePrDiffLine } from './pr-diff-shape';
import { attributionOfStampText, artifactAttributionDisabled } from './artifact-attribution';

/** A recorded tool execution. id/chatId/runId are assigned at the recording seam. */
export interface ToolReceipt {
  id: string;
  chatId: string;
  runId: string | null;
  tool: string;
  /** True only when the tool actually executed (not staged, not errored). */
  ok: boolean;
  /** Canonical ids the result carried: { prNumber?, sha?, branch?, chatId?, scheduleId?, ticketId?, sessionId?, passed?, failedStage? } */
  ids: Record<string, unknown>;
  /** sha256 of the canonical (key-sorted) JSON of the call args. */
  inputHash: string | null;
  /** sha256 of the raw result string. */
  outputHash: string | null;
  createdAt: Date;
  /** E8 (2026-09-25): IN-MEMORY ONLY (never persisted — run-receipts.service
   *  writes explicit columns): scrubbed ≤ RECEIPT_HEAD_CHARS heads of the call
   *  args and the raw result, the substance the self-audit decision gate needs
   *  to match a receipt to a claim. Absent on rows read back from the DB. */
  argsHead?: string;
  resultHead?: string;
}

/** Max chars of each receipt head (E8). */
export const RECEIPT_HEAD_CHARS = 200;
// Credential shapes a head must never carry to a decision backend (the seat
// may be an external vendor): bearer tokens, sk-/ghp_/xox*/AKIA keys, and
// `<name>=<long secret>` env-style assignments.
const HEAD_SECRET_RES: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+\S+/gi, '$1 •••'],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g, '•••'],
  [/\bghp_[A-Za-z0-9]{8,}/g, '•••'],
  [/\bxox[abp]-[A-Za-z0-9-]{8,}/g, '•••'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '•••'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=\S{8,}/g, '$1=•••'],
];
function scrubHead(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const [re, replacement] of HEAD_SECRET_RES) out = out.replace(re, replacement);
  return out.length > RECEIPT_HEAD_CHARS ? `${out.slice(0, RECEIPT_HEAD_CHARS - 1)}…` : out;
}

/** The scrubbed heads of a call's args + result (E8). Pure; never throws. */
export function receiptHeads(args: unknown, result: unknown): { argsHead: string; resultHead: string } {
  let argsText = '';
  try { argsText = typeof args === 'string' ? args : JSON.stringify(args ?? {}); } catch { argsText = String(args); }
  return { argsHead: scrubHead(argsText || ''), resultHead: scrubHead(String(result ?? '')) };
}

/** The fields extractReceipt derives — everything but the seam-assigned id/chatId/runId. */
export type ReceiptDraft = Omit<ToolReceipt, 'id' | 'chatId' | 'runId'>;

/**
 * Tools whose execution leaves a receipt (PR1 — the minimal consequential set):
 * the 7 tracked platform tools plus the coding-side world-changers. run_command
 * is required for parity: it evidences deploy/probe claims today, and honest
 * `gh pr merge` CLI flows must not be convicted.
 * Follow-up coverage (2026-08-24): set_chat_autonomy (consequential, staged-
 * capable) + the goal/todo mutations (goal_create/goal_update/todo_create/
 * todo_update) — the fleet supervisor's planning writes are claimable actions
 * too ("I created the goal", "that todo is done").
 * Ticket 212b3aa0 (2026-09-10): the read-only PLATFORM_OBSERVE_TOOLS join the
 * set — a probe/benchmark claim about fleet/platform state is PROVEN by these
 * reads and could never be evidenced while they left no receipts (the guard's
 * claim resolution only sees receipts on the executor path).
 */
/**
 * Control / coordination / ops MUTATIONS (capability-gap audit T1-T5; peer
 * verification 2026-09-25 P1-1): "I stopped the run", "I answered the lane's
 * question", "I paused its schedule", "I imported the repo", "I cleared my
 * stale card" are claimable actions exactly like a send or a dispatch, yet
 * none minted a receipt — the audit's "cite its {stopping:true} receipt"
 * contract was unmet. Every one returns the shared `out()` JSON envelope
 * ({ok, tool, ids, …}; needsConfirmation when staged), which parseResult
 * already reads, so they join the platform-envelope lane.
 */
export const CONTROL_COORD_RECEIPT_TOOLS: readonly string[] = [
  'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
  'configure_workspace', 'import_repo', 'sync_workspace', 'set_chat_instructions',
  'cancel_confirmation', 'dismiss_owner_question', 'create_chat_webhook',
  // stage_upload (2026-09-25 live proof of the worktreePath branch): a staged
  // file hand-off is a claimable artifact ("I sent you the PNG") — the
  // uploadId in ids is what send_chat_message's receipt then cites.
  'stage_upload',
  // set_decision_gate_mode (rollout self-governance, 2026-09-27): a mode flip is
  // a claimable fleet-wide action — the {ids:{purpose, mode}} envelope is the receipt.
  'set_decision_gate_mode',
];

/**
 * SUPERVISOR-STATE receipt class (audit 94f608c1, 2026-10-16 — the no-receipt
 * gap the Fleet Supervisor's own baseline measured: 3 of 13 ids cited in its
 * 24h replies were UNVERIFIABLE — oq_483730f8, oq_211513ed, state_update —
 * because these three mutations minted no row):
 *   - archive_chat — a TRUE archive claim was receipt-indistinguishable from a
 *     fabricated one (specimens: the FS 03:09Z archive of e87d6f73, true by
 *     ledger, no receipt anywhere; LiteLLM c6941c11's ~23:59Z archive of
 *     26be18cc, no receipt in its log);
 *   - flag_owner_question — an oq_ id claim had no receipt channel;
 *   - update_supervisor_state — the supervisor state save (the request's
 *     "save_supervisor_state" names this tool; there is no tool by that
 *     literal name — finish-run's claim vocabulary already aliases both to
 *     the state_update claim type).
 * Follow-up 60bfeab1 (Fleet relay, 2026-10-16 — same class, one day later):
 *   - answer_owner_question — a triage answer given on the owner's behalf
 *     (specimen: the Fleet Supervisor's 05:24Z triage answer oq_05c1345d)
 *     minted no receipt either; build FA-2 had parked it on the finish-run
 *     EXECUTED tier only, so a supervisor's "answered oq_…" claim was
 *     unverifiable from get_run_receipts exactly like the three above.
 * None fits the shared out()/parseResult envelope lane (archive_chat returns
 * PROSE; flag_owner_question carries a TOP-LEVEL questionId, not ids.*;
 * update_supervisor_state returns a bare {applied, errors} with no ok flag;
 * answer_owner_question's SUCCESS is the toolResultEnvelope but its REFUSALS
 * carry a TOP-LEVEL questionId the generic lane would drop) — each gets a
 * dedicated extractReceipt case below. The finish-run executed tier
 * (STATE_EXECUTED_TOOLS) keeps all four as the anon-session /
 * receipt-write-failure fallback.
 */
export const SUPERVISOR_STATE_RECEIPT_TOOLS: readonly string[] = [
  'archive_chat', 'flag_owner_question', 'update_supervisor_state',
  'answer_owner_question',
];

/**
 * NOTIFICATION receipt class (todo 1e356736 item 1, Fleet specimens monitor
 * lesson 5-f, 2026-10-16): notify_user — the owner's Telegram push — minted NO
 * receipt, so any supervisor "I notified the owner" claim was unverifiable
 * from get_run_receipts (specimen: Fleet Supervisor wake 2026-10-16 09:00Z
 * Telegram send — delivered, no receipt row). The tool answers with the
 * account-tools j() envelope whose channel is TOP-LEVEL ({ok, tool,
 * channel:'telegram', deliveredTo, chars} — NOT ids.*), so the shared
 * parseResult envelope lane would drop the one id-worthy field; refusals
 * carry {ok:false, reason, …extra} where only SOME shapes hold a channel.
 *
 * PRIVACY CONTRACT (the todo's own words): ids carry {channel} ONLY — NEVER
 * the message text. The push content is the user's own text and has no place
 * in the receipt channel; deliveredTo (the owner's Telegram handle) is
 * likewise omitted — it is not an id and verifies nothing a channel token
 * would not. A refusal keeps the channel when the envelope carried one
 * (proof the call ran, never that it delivered).
 *
 * finish-run FR-4 keeps notify_user on the EXECUTED tier
 * (TYPE_EXECUTED_TOOLS message_sent) as the anon-session fallback, exactly
 * like the supervisor-state tools keep STATE_EXECUTED_TOOLS.
 */
export const NOTIFY_RECEIPT_TOOLS: readonly string[] = ['notify_user'];

/**
 * WEB-PROBE receipt class (ticket 66007a6e, 2026-10-20): the read-only web
 * tools a probe-only seat uses to observe the outside world. A project-
 * supervisor chat running an hourly uptime re-probe (scrape_as_markdown on
 * the health endpoint + a control scrape of a known-good URL) could never
 * satisfy observe_resource's machine no_receipt gate: web tools minted NO
 * receipt (not in RECEIPT_TOOLS), so a lane whose ONLY probe tools are web
 * reads was structurally un-stampable and the watchdog's maxUnobservedMinutes
 * eventually alarmed the owner about a resource that WAS being probed hourly.
 *
 * DELIBERATELY NOT in RECEIPT_TOOLS itself — membership there derives
 * behavior beyond minting: (a) tool-intents.ts classifyIntentOutcome and the
 * near-break watch set (agent.ts NEAR_BREAK_TOOLS / loop-marker.ts) both read
 * RECEIPT_TOOLS membership — web reads are content-returning and idempotent,
 * so a retried scrape must never be journal-classified as an applied
 * side effect nor land in the near-break watch set; (b) claim matching
 * (claims-block.ts CLAIM_TYPE_TOOLS / finish-run.ts TYPE_RECEIPT_TOOLS) gates
 * on per-type tool sets that deliberately exclude web tools — no completion
 * claim may be laundered by a web read, and receiptMatchesClaim's
 * external-action class excludes them too. The agent seam mints ids for this
 * class explicitly; extractReceipt gains a dedicated WEB_PROBE lane below.
 * COLLECTOR-ONLY PERSISTENCE (the decided design): these rows are pushed to
 * the in-process collector ONLY and recordRunReceiptAsync is deliberately
 * SKIPPED for this class — no DB row, so run_tool_receipts volume and every
 * DB-reading pool — including the verifier's cross-wake 500-cap exoneration
 * pool — are unchanged by construction; a web read is gate evidence ("a real
 * check ran this run"), never claim evidence.
 */
export const WEB_PROBE_RECEIPT_TOOLS: readonly string[] = [
  'scrape_as_markdown', 'scrape_batch', 'search_engine', 'web_pipe', 'youtube_pipe',
];

/**
 * CONDITION-WAKE registration receipts (ticket e44e1219, 2026-10-24): the
 * web-probe pattern applied to await_condition. Lanes ended deploy-gated runs
 * claiming "condition wake registered (backstop HH:MMZ)" and the supervisor's
 * only verification surfaces (get_chat_status schedules, hook_list, receipts)
 * were all blind to the wake (a store row + a delayed backstop hook event,
 * never a coding_schedules row) — so a TRUE claim read as fabrication and
 * redundant one-shots were armed. A registration now mints a receipt so
 * "wake registered" is a receipted fact a supervisor can verify in
 * get_run_receipts, and get_chat_status surfaces the open wakes under
 * `conditionWakes` (platform.service.ts).
 *
 * DELIBERATELY NOT a RECEIPT_TOOLS member (the web-probe discipline):
 * membership derives behavior beyond minting — (a) journal intent
 * classification (a wait is not an applied side effect; the wake row is the
 * effect, minted when the STORE write happens, not when the tool returns),
 * (b) NEAR_BREAK_TOOLS / loop-marker near-break watch, (c) claims-block /
 * finish-run TYPE_RECEIPT_TOOLS claim classes, (d) receiptMatchesClaim's
 * tiers (a wait registration vouches NOTHING but its own wake — EXTERNAL_
 * ACTION_TOOL_RE excludes it, PLATFORM_OBSERVE_TOOLS excludes it). The agent
 * seam mints ids for this class explicitly (agent.ts receipt gate);
 * extractReceipt gains a dedicated lane below, before the platform lanes.
 * COLLECTOR-ONLY PERSISTENCE would defeat the purpose (the supervisor's
 * probe is get_run_receipts, a DB read) — so this class DOES persist, like
 * every platform receipt; the volume is self-limiting (one row per
 * registered wait, bounded by the tool's own usage).
 */
export const CONDITION_WAKE_RECEIPT_TOOLS: readonly string[] = ['await_condition'];

/** Membership test for the condition-wake registration class (agent.ts mint gate). */
export const CONDITION_WAKE_RECEIPT_TOOLS_SET: ReadonlySet<string> = new Set(CONDITION_WAKE_RECEIPT_TOOLS);

/** Membership test for the web-probe class (agent.ts mint gate + the seam's
 *  collector-only persistence skip — the seam needs the SET, not the array). */
export const WEB_PROBE_RECEIPT_TOOLS_SET: ReadonlySet<string> = new Set(WEB_PROBE_RECEIPT_TOOLS);

// Web-probe NOT-EXECUTED markers (ticket 66007a6e): position-0 anchored heads,
// the same discipline as RUN_COMMAND_NOT_OK_RE / the platform lane's
// NOT_EXECUTED_RES (never loose substrings — a loose marker matches its own
// literal source in files/tests quoting it). Every head below was verified
// against its producing site:
//   - `Tool call failed: …`     tool-executor.ts:1751 catch-all (a thrown executor error)
//   - `Tool "<name>" exceeded Ns and was aborted.`  agent.ts:5361 hard-timeout abort
//   - `Web tools unavailable.` agent.ts:1281 runTool guard when ctx.toolCache is absent
//   - `Web search failed — the search provider answered with an error…`
//                               tool-executor.ts:1102 SERP provider error
//   - `Web search is temporarily unavailable…`  WEB_DEGRADED_MSG head (tool-executor.ts:46)
//   - `Failed to fetch the URLs…`  scrape_batch plural head (tool-executor.ts:1732)
//   - `web_pipe search backend failed…`  serpBackendFailedSummary (serp-provider-guard.ts:228)
//       + the provider-host variant (web-pipe.ts:399)
//   - `web_pipe found no sources: the search call failed…` / `…: search responded…`
//       web-pipe.ts:414 (gateway unreachable / circuit open) + :408 (no parseable links)
//   - `web_pipe could not read any of the …`  web-pipe.ts:517
// The BARE zero-source head `web_pipe found no sources (no urls given and search
// returned nothing).` (web-pipe.ts:418) is deliberately NOT here: the pipe was
// called with neither urls nor query — nothing was asked of the outside world,
// but the call DID execute its resolution path; it rides the ok:true default.
// SEMANTICS (decided): a TARGET-side fetch failure ("Failed to fetch <url> — the
// page may be unavailable…", tool-executor.ts:1113) is ok:true — the fetch was
// really attempted, and for an uptime watchdog the DOWN observation is exactly
// what must be stampable; ok:false is reserved for tool/infrastructure-shape
// failures (provider error, degraded gateway, tool unavailable, thrown,
// aborted). "No search results found. Try a different query."
// (tool-executor.ts:1114) → ok:true (executed, empty).
const WEB_PROBE_NOT_EXECUTED_RES: RegExp[] = [
  /^Tool \S+ failed:/,                                   // thrown catch-all (tool-executor.ts:1748/1751)
  /^Tool "\S+" exceeded \d+s and was aborted\./,
  /^Web tools unavailable\./,                            // agent.ts runTool guard when ctx.toolCache is absent
  /^Web search failed — the search provider answered with an error/,  // tool-executor.ts:1102 SERP provider error
  /^Web search is temporarily unavailable/,              // WEB_DEGRADED_MSG head (tool-executor.ts:46)
  /^Failed to fetch the URLs/,                           // scrape_batch plural head (tool-executor.ts:1727)
  /^web_pipe search backend failed/,                     // serpBackendFailedSummary + provider-host variant
  /^web_pipe found no sources: (?:the search call failed|search responded)/, // web-pipe.ts:414 gateway-unreachable + :408 no-parseable-links
  /^web_pipe could not read any of the /,                // web-pipe.ts:517
];

/**
 * ids for a web-probe receipt: url and/or query ONLY, each capped at 200
 * chars — the notify_user {channel} privacy precedent (no page content ever
 * rides ids; a URL/query token verifies WHICH check ran, nothing else).
 */
function webProbeReceiptIds(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as { url?: unknown; query?: unknown };
  return {
    ...(a.url ? { url: String(a.url).slice(0, 200) } : {}),
    ...(a.query ? { query: String(a.query).slice(0, 200) } : {}),
  };
}

export const RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'start_coding_session', 'schedule_message',
  'update_schedule', 'cancel_schedule', 'dispatch_platform_task',
  'file_feedback', 'update_feedback',
  // store_secret (audit 2026-10-16 todo 77c88942, LiteLLM specimen 8fae35a4 —
  // "Seven keys banked … store_secret ×7" was unverifiable): a successful
  // store mints ids {envKey} — the env var NAME only, NEVER the value — so
  // 'banked/stored <KEY>' becomes an action claim the unbacked-claim guard
  // verifies like any send/dispatch. The envelope parse lives in
  // PLATFORM_RECEIPT_TOOLS below.
  'store_secret',
  'git_commit', 'git_push', 'open_pull_request', 'verify', 'run_command',
  // merge_pull_request (tt-rd audit 2026-09-27, finding docs-churn-log-3): the
  // merge minted a merge_success loop metric but NO receipt, so a supervisor's
  // reconcile rule ("a claimed push/PR/verify with no receipt did NOT happen")
  // could never verify a merge claim and the status card counted PRs opened
  // but never merges.
  'merge_pull_request',
  'set_chat_autonomy', 'goal_create', 'goal_update', 'goal_premise_set', 'todo_create', 'todo_update',
  ...PLATFORM_OBSERVE_TOOLS,
  ...CONTROL_COORD_RECEIPT_TOOLS,
  ...SUPERVISOR_STATE_RECEIPT_TOOLS,
  ...NOTIFY_RECEIPT_TOOLS,
]);

/**
 * LOCAL receipt class (finding A1, 2026-09-27 — canlaw 710 commits / 1 push;
 * spark "fully banked a65e79f4" relayed 3x with the sha 422 on origin): a
 * git_commit receipt proves a commit exists in the session's WORKTREE — never
 * that it reached origin. Before this split any ok receipt carrying ids.sha
 * (git_commit included) id-matched a commit_pushed claim and the coarse
 * external-action tier let git_commit vouch for a push-shaped line, so
 * commit-only work passed every guard. A local receipt never satisfies a
 * commit_pushed / commit_local claim (receiptMatchesClaim) and never counts
 * as the receipted survivor of a push line (the guard's line-level gate).
 * Kill switch COMMIT_LOCAL_CLAIM_GUARD_DISABLED=1 restores the pre-split
 * behaviour everywhere (matcher + guard).
 */
export const LOCAL_RECEIPT_TOOLS: ReadonlySet<string> = new Set(['git_commit']);

/** True when the receipt's tool proves only a LOCAL state change (never origin). */
export const isLocalReceiptTool = (tool: string): boolean => LOCAL_RECEIPT_TOOLS.has(tool);

/**
 * Kill switch for the commit≠push receipt split + the commit_local claim
 * kind (finding A1): COMMIT_LOCAL_CLAIM_GUARD_DISABLED=1|true|on restores
 * the pre-2026-09-27 behaviour (git_commit shas exonerate push claims; no
 * commit_local extraction). Read per call — the leaf stays import-free.
 */
export function commitLocalClaimGuardDisabled(): boolean {
  const v = String(process.env.COMMIT_LOCAL_CLAIM_GUARD_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const PLATFORM_RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'start_coding_session', 'schedule_message',
  'update_schedule', 'cancel_schedule', 'dispatch_platform_task',
  'file_feedback', 'update_feedback',
  // store_secret (audit 2026-10-16 todo 77c88942, LiteLLM specimen 8fae35a4 —
  // "Seven keys banked … store_secret ×7" was unverifiable): a successful
  // store mints a receipt with ids {envKey} — the env var NAME only, NEVER
  // the value — so 'banked/stored <KEY>' becomes an action claim the
  // unbacked-claim guard verifies like any send/dispatch. A refusal envelope
  // {ok:false} mints ok:false (proof the call ran, not that it stored).
  'store_secret',
  ...CONTROL_COORD_RECEIPT_TOOLS,
]);

/** House idiom (agent.ts worktreeDiffHash, platform-tools.ts). */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON with recursively key-sorted objects — stable across arg orderings. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** sha256 of the canonical (key-sorted) JSON of a call's args — the SAME inputHash a receipt carries
 *  (build 2026-10-08 D-2: the tool-intent journal keys calls on it, coding/tool-intents.ts). */
export function receiptInputHash(args: unknown): string {
  return sha256(canonicalJson(args));
}

// ── Result formats (all harness-authored; pinned against the producing code) ─

// git_commit (tools.ts): success is git's own stdout — "[main 84fe3ae] msg";
// the secret-scan refusal starts "COMMIT BLOCKED —"; execution failure is
// "git commit failed: <detail>".
const GIT_COMMIT_OK_RE = /\[([\w./-]+) ([0-9a-f]{7,40})\]/;

// git_push (tools.ts pushSessionBranch): "Pushed <branch> to GitHub (<url>)"
// with an optional appended " — sha <sha>" (citable-ids follow-up — HEAD read
// post-push, best-effort) and an optional "(verified: ancestry)" /
// "(verified: failed — …)" ancestry verdict (I2b, remediation 2026-09-09:
// the local sha must be an ancestor of the RE-FETCHED remote tip — never
// verified on tip-string equality). Anything else ("git push failed: …", the
// no-token/no-github strings) is not a push.
const GIT_PUSH_OK_RE = /^Pushed (\S+)/;
const GIT_PUSH_SHA_RE = /\bsha ([0-9a-f]{7,40})\b/;
const GIT_PUSH_VERIFIED_RE = /\(verified: (ancestry|failed)\b/;
// P5 v1#28b: the ONE bounded post-push CI observation appends "\nCI: <state> …"
// (tools.ts git_push / open_pull_request via ci-status.observeCiAfterPush).
const GIT_PUSH_CI_RE = /\nCI: (pending|success|failure|none)\b/;
// Published-refs list (ticket 2c01e9d2, 2026-09-27): "— published refs: <ref>[, <ref>]*"
// appended at the END of the push result (tools.ts pushSessionBranch). The
// capture is the verbatim comma-separated refspec list — "refs/heads/fo/guard-fix"
// — so the journal/evidence-guard reader can see WHICH refs moved; the receipts
// layer stores it as ids.refs (array). Legacy results (pre-fix) omit it.
const GIT_PUSH_REFS_RE = /— published refs: ([\w\/., -]+?)(?:\.\s*$|\.$)/;
// Artifact attribution stamp (todo 13dfa16d, monitor lesson 7): the three
// artifact tools append "— serves todo <8-hex>" / "— serves ticket <8-hex>" to
// the result (tools.ts, computed at EVENT time from the branch / PR body /
// commit message / the run's in-progress plan step). The receipt stores the
// FULL work-item id + its source leg in ids (todoId|ticketId +
// workItemSource) so the wake ledger renders the artifact's OWN work item —
// never a join to the lane's CURRENT title (the SCD trap: PR #1590 served
// todo 27c215d6 but every digest after the 14:14:53Z title switch labelled it
// with the lane's new title todo 908f48a7). Legacy results omit the stamp.
// ARTIFACT_ATTRIBUTION_DISABLED=1 drops the ids fields (stamp still rides the
// text; extraction stays tolerant).

// open_pull_request (tools.ts): "Opened PR #<n>: <html_url>". Since the tt-rd
// audit (2026-09-27) the result may carry a harness-authored "[PR DIFF] …"
// tail line (pr-diff-shape.ts renderPrDiffLine) — the ONE compare call's
// shape: file count, +/−, docs-only vs code, a diff hash, the first paths.
// Its fields ride into ids so the status card / timing lines / duplicate
// and docs-only notices can read the shape from the receipt alone.
const OPEN_PR_OK_RE = /^Opened PR #(\d+): (\S+)/;

// merge_pull_request (tools.ts): the ONLY success shape is
// "MERGED <owner>/<repo>#<n> (squash sha <sha>) — confirmed merged:true …";
// "PR <slug>#<n> is ALREADY merged …" is an honest no-op (ok:false,
// ids.alreadyMerged — never a fresh merge); every other shape (MERGE BLOCKED /
// MERGE FAILED / MERGE UNCONFIRMED / policy off / disabled) is not a merge.
const MERGE_PR_OK_RE = /^MERGED ([\w.-]+\/[\w.-]+)#(\d+) \((?:squash|merge|rebase) sha ([0-9a-f]{7,40})\) — confirmed merged:true/;
const MERGE_PR_ALREADY_RE = /^PR ([\w.-]+\/[\w.-]+)#(\d+) is ALREADY merged/;



// verify (tools.ts): "Verify PASSED: …" or `Verify FAILED at "<stage>": …`
// (also "No verify chain configured …" → passed:false, failedStage:null).
// P5 v1#30 adds `Verify UNVERIFIED: …` — the chain "passed" only because a
// stage tool is missing; the receipt records passed:false + unverified:true
// (an unverified chain exonerates no verification claim).
const VERIFY_PASSED_RE = /^Verify PASSED/;
const VERIFY_FAILED_STAGE_RE = /^Verify FAILED at "([^"]+)"/;
const VERIFY_UNVERIFIED_RE = /^Verify UNVERIFIED/;

// run_command: the single-tool hard timeout (agent.ts — Promise.race against
// runTool) resolves with `Tool "<name>" exceeded <N>s and was aborted. …`. A
// command that merely exits non-zero still EXECUTED — only the abort is not
// an execution.
const RUN_COMMAND_ABORT_RE = /^Tool "run_command" exceeded \d+s and was aborted\./;
// Every NON-success shape tools.ts emits for run_command (2026-09-08 audit —
// only the uppercase `[command FAILED` banner used to count): the lowercase
// `[command failed] <detail>` (process vanished mid-wait), the catch-all
// `Tool run_command failed: …`, and `[SELF-STARTED MONITOR]` (still running —
// no exit code yet, so it proves NO completion). None may exonerate a claim.
// …plus the publish-guard refusal `[command REFUSED — publish guard]` (P5
// v1#27 — nothing executed at all).
const RUN_COMMAND_NOT_OK_RE = /^(?:\[command failed\b|\[command REFUSED\b|Tool run_command failed:|\[SELF-STARTED MONITOR\])/i;

// set_chat_autonomy (platform-tools.ts): two prose success shapes — "Autonomy
// granted for chat <id>: …" / "Autonomy revoked for chat <id> — …". Validation
// failures are prose ("set_chat_autonomy requires …").
const AUTONOMY_OK_RE = /^Autonomy (granted|revoked) for chat ([0-9a-f-]{8,})/i;

// goal_create / todo_create (platform-tools.ts): "Created goal <id> "<title>"
// (status: …)." / "Created todo <id> …" (entity JSON appended after the prose).
const GOAL_CREATE_OK_RE = /^Created goal ([0-9a-f-]{8,})/i;
const TODO_CREATE_OK_RE = /^Created todo ([0-9a-f-]{8,})/i;
// archive_chat (platform-tools.ts): prose success — "Archived chat <id>." /
// "Restored chat <id> from the archive." (the id is followed by '.' or ' ').
// Refusals are validation prose ("archive_chat requires …"). Not
// consequential → never confirmation-staged.
const ARCHIVE_CHAT_OK_RE = /^(Archived|Restored) chat ([0-9a-f-]{8,})[.\s]/i;

// flag_owner_question (platform-tools.ts): JSON with a TOP-LEVEL questionId —
// {ok:true, questionId} (created; +triage:'supervisor' when routed) or
// {ok:false, reason:'deduped', questionId} (a dedup bump — real row interaction,
// NOT a new question: ok:false like update_feedback's dedup shape) or
// {ok:false, reason:<refusal>}. Not consequential → never staged.
// update_supervisor_state (platform-tools.ts): bare {applied[], errors[]} JSON —
// NO ok flag. Refusals are PROSE (supervisorOnlyRefusal / stateReadFailedRefusal),
// so a JSON parse success IS a save; errors non-empty = failed items.
// answer_owner_question (platform-tools.ts, follow-up 60bfeab1): SUCCESS is the
// toolResultEnvelope ({ok:true, tool, ids:{questionId, answeredBy}}) but the
// REFUSALS carry a TOP-LEVEL questionId ({ok:false, reason, questionId}) the
// generic envelope lane would drop, and the scope refusal is PROSE — so it
// joins the per-tool class: JSON parse; ok = parsed.ok === true; ids carry the
// questionId from EITHER ids.* or top level plus answeredBy ('owner'|'supervisor'
// — the provenance stamp) when present. A refusal keeps the questionId but
// mints ok:false — a refused answer is a real row interaction that answered
// NOTHING and must never vouch a claim.


// goal_update / todo_update (platform-tools.ts): success is the BARE updated-
// entity JSON (goals.service GoalView/TodoView — has `id`); failures THROW
// (AppError) and surface as prose ("Tool <name> failed: …", tools.ts) or a
// validation string. Parsed in extractReceipt, not via regex.

/** Shared staged-gate detection for the coverage-extension platform tools
 *  (set_chat_autonomy is consequential → confirmation-gated): reuse the ONE
 *  envelope parser; only `.staged` is read — their success formats are parsed
 *  per-tool below. */
const isStagedCall = (tool: string, text: string): boolean => parseResult(tool, text).staged;

/**
 * The receipt of a confirmation-STAGED call (WI-K, 2026-09-25): ok:false, ids
 * {staged:true, confirmationId?}. Staged ≠ executed — `ok:false` keeps it out
 * of every evidence lane (receiptMatchesClaim, getRecentChatReceipts,
 * follow-through, idempotency all filter ok:true) and `ids.staged` lets the
 * verifier's pool entry and the fleet guard tile tell "parked on a card" from
 * "refused/errored". Null under the kill switch.
 */
function stagedReceipt(base: Omit<ReceiptDraft, 'ok' | 'ids'>, text: string): ReceiptDraft | null {
  let confirmationId: string | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.confirmationId === 'string' && parsed.confirmationId) {
      confirmationId = parsed.confirmationId;
    }
  } catch { /* a staged envelope is always JSON; a parse miss just drops the id */ }
  return { ...base, ok: false, ids: { staged: true, ...(confirmationId ? { confirmationId } : {}) } };
}

/**
 * Derive the receipt for one executed tool call, or null when the call leaves
 * none: non-receipt tools (a confirmation-STAGED platform call by default
 * mints an ok:false {staged:true, confirmationId} receipt, see stagedReceipt).
 */
export function extractReceipt(
  tool: string,
  args: unknown,
  result: string,
  now: Date,
): ReceiptDraft | null {
  // Web-probe tools are NOT RECEIPT_TOOLS members (that membership derives
  // behavior beyond minting — intent classification, near-break watch, claim
  // matching); they admit through their OWN class below.
  if (!RECEIPT_TOOLS.has(tool) && !WEB_PROBE_RECEIPT_TOOLS_SET.has(tool) && !CONDITION_WAKE_RECEIPT_TOOLS_SET.has(tool)) return null;
  const text = String(result ?? '');
  const inputHash = sha256(canonicalJson(args));
  const outputHash = sha256(text);
  const base = { tool, inputHash, outputHash, createdAt: now };

  // Shared NOT-EXECUTED markers (ticket 212b3aa0's observe lane + e44e1219's
  // condition-wake lane — the same shapes): the tools.ts catch-all prose
  // ("Tool <name> failed: …"), the loop-backstop hard-timeout abort ("Tool
  // \"<name>\" exceeded Ns and was aborted."), the platform layer's
  // returned-prose PRE-EXECUTION refusals (arg validation "… requires …" /
  // "… takes X OR Y, not both.", the admin-gate "… is restricted to admin
  // users …", the "Ambiguous … id prefix …" resolver refusal).
  const NOT_EXECUTED_RES = [
    /^Tool \S+ failed:/,
    /^Tool "\S+" exceeded \d+s and was aborted\./,
    /^[a-z_]+ requires /,
    / is restricted to admin users\b/,
    /^Ambiguous \S+ id prefix /,
    /^[a-z_]+ takes .+ not both\./,
  ];

  // Web tools are in no other set (never RECEIPT_TOOLS members — see the
  // WEB_PROBE_RECEIPT_TOOLS doc block), so this dedicated lane BEFORE the
  // platform lanes is unambiguous.
  if (WEB_PROBE_RECEIPT_TOOLS_SET.has(tool)) {
    if (WEB_PROBE_NOT_EXECUTED_RES.some((re) => re.test(text))) return { ...base, ok: false, ids: {} };
    return { ...base, ok: true, ids: webProbeReceiptIds(args) };
  }

  // CONDITION-WAKE registration (ticket e44e1219): ok:true ONLY when the tool
  // result carries the wake-registration line (the not-met answer + the
  // end-turn notice both end with "Registered a CONDITION WAKE:" /
  // "registered a CONDITION WAKE for:"). A met-in-tool answer, an honest
  // error, or a disabled-switch refusal registered nothing — ok:false (proof
  // the call ran, never that a wake exists). ids carry the CONDITION KEY
  // (kind + repo + sha/pullNumber), the exact identity the store row and the
  // get_chat_status conditionWakes block key off — a supervisor matching a
  // claimed "backstop HH:MMZ" against a receipt + a status row has both
  // halves. Not-executed heads (thrown/aborted) reuse the shared platform
  // NOT_EXECUTED_RES — ok:false, ids:{} (the call ran and registered nothing).
  if (CONDITION_WAKE_RECEIPT_TOOLS_SET.has(tool)) {
    if (NOT_EXECUTED_RES.some((re) => re.test(text))) return { ...base, ok: false, ids: {} };
    const registered = /Registered a CONDITION WAKE:|registered a CONDITION WAKE for:/.test(text);
    const a = (args ?? {}) as Record<string, unknown>;
    const ids: Record<string, unknown> = {};
    const kind = typeof a.condition === 'string' && a.condition ? a.condition : null;
    const repo = typeof a.repo === 'string' && a.repo ? a.repo : null;
    const sha = typeof a.sha === 'string' && a.sha ? a.sha : null;
    const pullNumber = typeof a.pullNumber === 'number' && Number.isInteger(a.pullNumber) ? a.pullNumber : null;
    if (kind) ids.condition = kind;
    if (repo) ids.repo = repo;
    if (sha) ids.sha = sha;
    if (pullNumber !== null) ids.pullNumber = pullNumber;
    return { ...base, ok: registered, ids };
  }

  if (PLATFORM_RECEIPT_TOOLS.has(tool)) {
    // Envelope JSON + the file_feedback prose catalogue live in ONE home.
    const parsed = parseResult(tool, text);
    if (parsed.staged) return stagedReceipt(base, text);
    return { ...base, ok: parsed.ok, ids: { ...parsed.ids } };
  }

  if (PLATFORM_OBSERVE_TOOLS.has(tool)) {
    // Observation reads (ticket 212b3aa0): EXECUTED = evidence — the result
    // payload is the platform's own ground truth (JSON payloads; the prose
    // empty-success shapes like "No schedules found." are executed
    // observations too). A call that never executed proves NOTHING
    // (adversarial review B1/B2): the shared NOT_EXECUTED_RES above (heads
    // verified in the 212b3aa0 audit) plus any JSON envelope carrying a
    // boolean ok flag (preflight refusals, staged gates).
    if (NOT_EXECUTED_RES.some((re) => re.test(text))) return { ...base, ok: false, ids: {} };
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
        return { ...base, ok: parsed.ok, ids: {} };
      }
    } catch { /* prose empty-success ("No schedules found.") IS an executed observation */ }
    return { ...base, ok: true, ids: {} };
  }

  switch (tool) {
    case 'git_commit': {
      const m = text.match(GIT_COMMIT_OK_RE);
      // e64fd118 (2026-09-27): mint the branch token too. The df5ea136
      // receipt-cited exemption lists 'branch' in RECEIPT_CITABLE_ID_KEYS,
      // but git_commit parsed the branch and DISCARDED it — ids.sha only —
      // so a recap line citing the session's own branch (the e64fd118 shape:
      // "### Committed artifacts (branch `digby/session-…`)" ×6 across 6
      // turns of a productive run) could never match it, while a git_push
      // receipt's branch could. The branch is already captured by the regex
      // and rides the ok result's first bracket group — recording it changes
      // no ok/false semantics. Consumers were audited: claims-block's
      // claimMatchesReceipt gates on CLAIM_TYPE_TOOLS[claim.type] FIRST
      // (git_commit is only in 'file_change', which matches on ids.sha), so
      // a commit receipt's branch can never vouch a 'push' claim.
      return { ...base, ok: !!m, ids: m ? { sha: m[2], branch: m[1] } : {} };
    }
    case 'git_push': {
      const m = text.match(GIT_PUSH_OK_RE);
      if (!m) return { ...base, ok: false, ids: {} };
      const sha = text.match(GIT_PUSH_SHA_RE);
      const verified = text.match(GIT_PUSH_VERIFIED_RE);
      const ci = text.match(GIT_PUSH_CI_RE);
      // Published-refs list (ticket 2c01e9d2): "— published refs: <ref>[, <ref>]*"
      // rides at the END of the result (after the base note) so every prefix
      // consumer (idempotency, PR pre-push, CI hook, ledger regex) is stable;
      // ids.refs is the verbatim refspec list for the journal + guard.
      const refs = text.match(GIT_PUSH_REFS_RE);
      // Artifact attribution (todo 13dfa16d): the "— serves todo|ticket <8-hex>"
      // stamp pushSessionBranch appended (event-time work item — branch / commit
      // message / the run's in-progress plan step). Stored as the FULL id +
      // source leg; the wake ledger renders THIS, never the lane's current title.
      const attrib = attributionOfStampText(text);
      return {
        ...base,
        ok: true,
        ids: {
          branch: m[1],
          ...(sha ? { sha: sha[1] } : {}),
          ...(verified ? { verified: verified[1] } : {}),
          ...(ci ? { ci: ci[1] } : {}),
          ...(refs ? { refs: refs[1].split(',').map((r) => r.trim()).filter(Boolean) } : {}),
          ...(attrib && !artifactAttributionDisabled() ? { [attrib.workItem.startsWith('ticket ') ? 'ticketId' : 'todoId']: attrib.prefix, workItemSource: 'stamp' } : {}),
        },
      };
    }
    case 'open_pull_request': {
      const m = text.match(OPEN_PR_OK_RE);
      if (!m) return { ...base, ok: false, ids: {} };
      const shape = parsePrDiffLine(text);
      const attrib = attributionOfStampText(text);
      return {
        ...base,
        ok: true,
        ids: {
          prNumber: Number(m[1]),
          url: m[2],
          ...(shape ? { filesOnlyMd: shape.filesOnlyMd, filesOnlyState: shape.filesOnlyState, files: shape.files, fileCount: shape.fileCount, additions: shape.additions, deletions: shape.deletions, diffHash: shape.diffHash } : {}),
          ...(attrib && !artifactAttributionDisabled() ? { [attrib.workItem.startsWith('ticket ') ? 'ticketId' : 'todoId']: attrib.prefix, workItemSource: 'stamp' } : {}),
        },
      };
    }
    case 'merge_pull_request': {
      const m = text.match(MERGE_PR_OK_RE);
      if (m) {
        const attrib = attributionOfStampText(text);
        return {
          ...base,
          ok: true,
          ids: {
            repo: m[1], prNumber: Number(m[2]), mergeSha: m[3],
            ...(attrib && !artifactAttributionDisabled() ? { [attrib.workItem.startsWith('ticket ') ? 'ticketId' : 'todoId']: attrib.prefix, workItemSource: 'stamp' } : {}),
          },
        };
      }
      const a = text.match(MERGE_PR_ALREADY_RE);
      return { ...base, ok: false, ids: a ? { repo: a[1], prNumber: Number(a[2]), alreadyMerged: true } : {} };
    }
    case 'verify': {
      // Always executed — the VERDICT rides in ids (passed / failedStage).
      const failed = text.match(VERIFY_FAILED_STAGE_RE);
      const passed = VERIFY_PASSED_RE.test(text);
      const unverified = VERIFY_UNVERIFIED_RE.test(text);
      return { ...base, ok: true, ids: { passed, failedStage: failed ? failed[1] : null, ...(unverified ? { unverified: true } : {}) } };
    }
    case 'run_command':
      // 2026-08-30 audit: the receipt used to be verdict-blind (any executed
      // command — even exit 1 — was ok:true, so a fabricated "merged" claim in
      // a run that ran `ls` was exonerated at this layer). The harness now
      // leads command results with [command FAILED — exit N] / [command OK] —
      // honor it.
      return { ...base, ok: !RUN_COMMAND_ABORT_RE.test(text) && !RUN_COMMAND_NOT_OK_RE.test(text), ids: {} };
    // ── Coverage-extension platform tools (bespoke formats — the 7 envelope
    // tools are handled above via parseResult; these parse their own shapes) ──
    case 'set_chat_autonomy': {
      if (isStagedCall(tool, text)) return stagedReceipt(base, text);
      const m = text.match(AUTONOMY_OK_RE);
      return { ...base, ok: !!m, ids: m ? { chatId: m[2], granted: m[1] === 'granted' } : {} };
    }
    case 'goal_create': {
      if (isStagedCall(tool, text)) return stagedReceipt(base, text);
      const m = text.match(GOAL_CREATE_OK_RE);
      return { ...base, ok: !!m, ids: m ? { goalId: m[1] } : {} };
    }
    case 'todo_create': {
      if (isStagedCall(tool, text)) return stagedReceipt(base, text);
      const m = text.match(TODO_CREATE_OK_RE);
      return { ...base, ok: !!m, ids: m ? { todoId: m[1] } : {} };
    }
    case 'goal_update':
    case 'goal_premise_set':
    case 'todo_update': {
      if (isStagedCall(tool, text)) return stagedReceipt(base, text);
      const idKey = tool === 'todo_update' ? 'todoId' : 'goalId';
      try {
        const parsed = JSON.parse(text);
        const id = parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed.id : null;
        // Interaction fix (2026-10-20): a goal_update whose only field was a REFUSED ranking write
        // (goals.service updateGoal: rankingApplied:false + changed:false) changed nothing — never an
        // executed action, never evidence (the goal id is kept so the record still names the target).
        if (id && tool === 'goal_update' && parsed.rankingApplied === false && parsed.changed === false) {
          return { ...base, ok: false, ids: { [idKey]: id, rankingRefused: true } };
        }
        return { ...base, ok: !!id, ids: id ? { [idKey]: id } : {} };
      } catch {
        return { ...base, ok: false, ids: {} }; // prose failure ("Tool <name> failed: …")
      }
    }
    // ── Supervisor-state receipt class (audit 94f608c1) — none fits the shared
    // envelope lane: bespoke shapes, parsed per tool (see SUPERVISOR_STATE_RECEIPT_TOOLS) ──
    case 'archive_chat': {
      // Prose success carries the archived/restored chat id; the archived flag
      // rides ids so an "archived <id>" claim cannot be vouched by a RESTORE.
      const m = text.match(ARCHIVE_CHAT_OK_RE);
      return { ...base, ok: !!m, ids: m ? { chatId: m[2], archived: m[1].toLowerCase() === 'archived' } : {} };
    }
    case 'flag_owner_question': {
      // Top-level questionId (not ids.*); a dedup bump keeps the questionId but
      // ok:false (like update_feedback's "Already tracked" dedup shape).
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const qid = typeof parsed.questionId === 'string' ? parsed.questionId : null;
          const ok = parsed.ok === true;
          return { ...base, ok, ids: qid ? { questionId: qid, ...(parsed.triage === 'supervisor' ? { triage: 'supervisor' } : {}) } : {} };
        }
      } catch { /* prose failure → ok:false below */ }
      return { ...base, ok: false, ids: {} };
    }
    case 'update_supervisor_state': {
      // Bare {applied[], errors[]} — no ok flag. Refusals are PROSE, so a JSON
      // parse success is a save; ok = no errors (a save with partial errors is
      // a failed mutation for evidence purposes — never vouch a claim).
      // No entity id exists: the receipt id (anchored, as finish-run FR-3) plus
      // 'supervisor_state' (the finish-run vocabulary's own suggestion) vouch
      // the state_update claim; applied[] is advisory count only.
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.applied)) {
          const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((e: unknown) => typeof e === 'string' && e) : [];
          return { ...base, ok: errors.length === 0, ids: { supervisor_state: 'supervisor_state', applied: parsed.applied.length } };
        }
      } catch { /* prose refusal → ok:false below */ }
      return { ...base, ok: false, ids: {} };
    }
    case 'answer_owner_question': {
      // Follow-up 60bfeab1 (specimen: the Fleet Supervisor's 05:24Z triage
      // answer oq_05c1345d). SUCCESS is the toolResultEnvelope (ids.questionId
      // + ids.answeredBy, the owner/supervisor provenance stamp); the REFUSALS
      // carry a TOP-LEVEL questionId ({ok:false, reason, questionId}) and the
      // scope refusal is PROSE — none fits the shared envelope lane. A refusal
      // keeps the questionId (a real row interaction) but ok:false — a refused
      // answer answered NOTHING and must never vouch a claim.
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const ok = parsed.ok === true;
          const raw = parsed as Record<string, unknown>;
          const ids = (raw.ids ?? {}) as Record<string, unknown>;
          const qid = typeof ids.questionId === 'string' && ids.questionId
            ? ids.questionId
            : typeof raw.questionId === 'string' && raw.questionId
              ? raw.questionId
              : null;
          const answeredBy = typeof ids.answeredBy === 'string' && ids.answeredBy ? ids.answeredBy : null;
          return {
            ...base,
            ok,
            ids: qid
              ? { questionId: qid, ...(answeredBy ? { answeredBy } : {}) }
              : {},
          };
        }
      } catch { /* prose scope refusal → ok:false below */ }
      return { ...base, ok: false, ids: {} };
    }
    // ── Notification receipt class (todo 1e356736 item 1) — the account-tools
    // j() envelope with a TOP-LEVEL channel (never ids.*); ids stay {channel}
    // ONLY: no message text, no deliveredTo handle (privacy contract) ──
    case 'notify_user': {
      // Success: {ok:true, tool, channel:'telegram', deliveredTo, chars} (the
      // secretsRedacted note may append — appendOutboundRedactionNote rewrites
      // the JSON in place, keys stay). Refusals: {ok:false, tool, reason,
      // message, …extra} where SOME shapes carry a channel extra (not_configured
      // {channel}, send_failed {channel:'telegram'}), others none
      // (telegram_not_linked, rate_limited, duplicate_notification,
      // dismissed_question, kpi_reannouncement, invalid_message, anonymous). A
      // refusal mints ok:false with the channel when present — proof the call
      // ran, never that it delivered.
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const ok = parsed.ok === true;
          const raw = parsed as Record<string, unknown>;
          const channel = typeof raw.channel === 'string' && raw.channel ? raw.channel : null;
          return { ...base, ok, ids: channel ? { channel } : {} };
        }
      } catch { /* prose failure ("Tool notify_user failed: …") → ok:false below */ }
      return { ...base, ok: false, ids: {} };
    }
    default:
      return null;
  }
}

// ── Claim ↔ receipt matching ────────────────────────────────────────────────

/**
 * The subset of run-evidence-guard's CompletionClaim shape this module reads.
 * Structural, NOT a type import: the guard imports run-receipts, so importing
 * back would cycle.
 */
export interface ReceiptClaimLike {
  kind: string;
  prNumber?: number;
  sha?: string;
  /** The claim line — carried for CONTENT-aware class selection (infra-subject probes). */
  text?: string;
}

/**
 * EXTERNAL-ACTION tools (same class as the guard's layer-2 tier): the only
 * receipts that can evidence a world-changing claim. F32 (2026-10-22): kept
 * in sync with the guard's copy VERBATIM — merge_pull_request joins BOTH (a
 * squash-merge receipt is a world-changing action; the guard's copy lacked
 * it, masked on the live receipts-first path and biting on the legacy parts
 * path). Any future member added here must be added there in the same commit.
 */
const EXTERNAL_ACTION_TOOL_RE = /^(run_command|git_|open_pull_request|merge_pull_request|github_)/;

/**
 * Prefix-tolerant id match — the verifier's M1 rule (action-verifier.ts):
 * BOTH sides must be ≥8 chars for a prefix match (envelope ids can carry
 * non-id values like a queue position "3"); exact equality stays ungated.
 */
const idMatches = (cited: string, actual: string): boolean =>
  actual === cited ||
  (cited.length >= 8 && actual.length >= 8 && (actual.startsWith(cited) || cited.startsWith(actual)));

/**
 * Does the receipt set prove this claim? Only ok:true receipts count — a
 * failed push/commit must not exonerate (the claimHasEvidence name-only hole).
 *   1. id-bearing claims (prNumber, sha) match the SPECIFIC receipt carrying
 *      that id, prefix-tolerant both sides ≥8 chars. pr_created is id-ONLY:
 *      open_pull_request receipts capture the exact number, so an unmatched
 *      pr_created claim is a phantom (honest gh-CLI creation still has the
 *      guard's layer-3 GitHub re-query as its exoneration lane).
 *   2. coarse kinds (deploy / probe / benchmark, and pr_merged / pr_closed /
 *      commit_pushed whose id matched nothing) accept ANY ok receipt in the
 *      external-action class — receipts cannot (yet) prove WHICH deploy ran.
 *   3. finding A1 (2026-09-27): commit_pushed and the new commit_local kind
 *      ("banked/committed <sha>") never match a LOCAL
 *      receipt (git_commit) in either tier — only git_push carries a sha
 *      that reached origin. COMMIT_LOCAL_CLAIM_GUARD_DISABLED=1 restores
 *      the old behaviour.
 */
export function receiptMatchesClaim(claim: ReceiptClaimLike, receipts: ToolReceipt[]): boolean {
  const ok = receipts.filter((r) => r.ok);
  if (claim.prNumber !== undefined && claim.prNumber !== null) {
    const cited = String(claim.prNumber);
    const matched = ok.some(
      (r) => r.ids?.prNumber !== undefined && r.ids?.prNumber !== null
        // e44e1219: an await_condition registration receipt names the PR it
        // WAITS on (ids.pullNumber) — waiting on a merge proves nothing about
        // the PR itself; it must never vouch a PR claim.
        && !CONDITION_WAKE_RECEIPT_TOOLS_SET.has(r.tool)
        && idMatches(cited, String(r.ids.prNumber)),
    );
    if (matched) return true;
    if (claim.kind === 'pr_created') return false;
  }
  const originClaim = claim.kind === 'commit_pushed' || claim.kind === 'commit_local';
  // Finding A1 (2026-09-27): a sha on a push/banked line must match a receipt
  // whose tool actually reached origin — git_push (ids.sha = HEAD after the
  // verified push). A git_commit receipt is LOCAL and matches nothing here;
  // the kill switch restores the old any-ids.sha match.
  // e44e1219: an await_condition registration receipt carries ids.sha of the
  // commit/DEPLOY it waits on — a lane that waits on a sha it never pushed
  // must not have its commit_pushed claim exonerated by the wait itself (the
  // exact laundering shape the visibility fix would otherwise have opened).
  const localSplit = originClaim && !commitLocalClaimGuardDisabled();
  if (originClaim && claim.sha) {
    const matched = ok.some(
      (r) => r.ids?.sha !== undefined && r.ids?.sha !== null
        && !(localSplit && isLocalReceiptTool(r.tool))
        && !CONDITION_WAKE_RECEIPT_TOOLS_SET.has(r.tool)
        && idMatches(String(claim.sha), String(r.ids.sha)),
    );
    if (matched) return true;
  }
  // Token-less kinds bind to their evidence TOOL CLASS (receipts cannot prove
  // WHICH probe/deploy ran). deploy / pr claims / commit_pushed fallthrough:
  // external action only (finding A1: MINUS the local class for
  // commit_pushed / commit_local — a git_commit receipt never vouches that a
  // sha reached origin; run_command / git_push / github_* still do, the
  // origin re-query in the guard adjudicates the sha itself). probe/benchmark (ticket 212b3aa0): external action
  // ∪ the read-only platform observation tools — a fleet/platform-state probe
  // is PROVEN by the platform's own read tools (get_chat_status, todo_get,
  // list_schedules, …), the exact tools the probe-first doctrine mandates.
  // CONTENT BOUNDARY (ticket 4df4bb41): a probe whose line names REMOTE INFRA
  // (box / tailnet / remote host) asserts an observation fleet reads can
  // never produce — the observation class does NOT evidence it ("box probe
  // healthy, tailnet probe active" with a fleet-reads-only journal stays a
  // conviction).
  if (claim.kind === 'probe' || claim.kind === 'benchmark') {
    const infraSubject = !!claim.text && INFRA_PROBE_SUBJECT_RE.test(claim.text);
    return ok.some((r) => EXTERNAL_ACTION_TOOL_RE.test(r.tool) || (!infraSubject && PLATFORM_OBSERVE_TOOLS.has(r.tool)));
  }
  // F32 (2026-10-22): the deploy-OBSERVATION shape (DEPLOY_ALT: "health
  // check 200", "prod green", "digby.example.com healthy" — no deploy verb) is also
  // evidenced by the deploy-health observation tools — get_fleet_telemetry
  // receipts (a PLATFORM_OBSERVE_TOOLS member, so it mints one) and the web
  // health reads — the reads the deploy doctrine itself mandates for exactly
  // this sentence. A deploy-verb line keeps the action-only class (it asserts
  // the run PERFORMED the deploy). Kill switch:
  // EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1.
  if (claim.kind === 'deploy' && !deployObservationTierDisabled() && isDeployObservationClaimText(claim.text)) {
    return ok.some((r) => EXTERNAL_ACTION_TOOL_RE.test(r.tool) || DEPLOY_HEALTH_OBSERVATION_TOOLS.has(r.tool));
  }
  return ok.some((r) => EXTERNAL_ACTION_TOOL_RE.test(r.tool) && !(localSplit && isLocalReceiptTool(r.tool)));
}
