/**
 * Phantom-claim ACTION VERIFIER (ported from PR #295's two-lane rebuild onto
 * the merged #296 supervisor design, 2026-08-22).
 *
 * The supervisor failure class this kills: a machine wake writes a detailed
 * status note claiming it "dispatched three workers" / "opened PR #243" while
 * its tool log shows ZERO consequential executions — the fabricated ids then
 * fossilize in later notes (owner audit 2026-08-21: phantom tickets #21–#24,
 * fabricated dispatch UUIDs caught by the CanLaw overseer at 13:42Z).
 *
 * Mechanism, run fire-and-forget from the chat-agent finalize — every
 * SUPERVISOR machine wake, plus (ticket ae085617) ANY other chat turn whose
 * final text asserts consequential platform actions (the executed-actions.ts
 * keyword pre-gate keeps that cheap — no LLM call otherwise):
 *   1. ground truth — the run's ACTUAL successful consequential tool
 *      executions (executed-actions.ts over result.parts);
 *   2. claim extraction — a cheap utility-LLM pass lists the note's
 *      already-happened action claims (dispatch / message / schedule /
 *      ticket filings);
 *   3. count-match claims against executions per kind; an unmatched claim that
 *      cites an id gets exoneration checks (the durable state doc's dispatch
 *      ledger — supervisor only, filtered to entries stamped BEFORE the
 *      audited run started so the run can't acquit itself via its own
 *      same-run state writes — then one DB existence check) before being
 *      called phantom;
 *   4. every phantom → (a) a deduped 'mishap' feedback ticket (the shared
 *      triage queue is the fix loop), (b) an in-thread correction: supervisor
 *      + machine-triggered runs get a machine-authored 'user' row so the NEXT
 *      wake sees the refutation in-window; user-watched interactive chats get
 *      an ASSISTANT-role retraction (ticket d78f477b — the human who just read
 *      the phantom claim must see it corrected; never a 'user' row, which
 *      would render as a bubble they never typed), and (c) supervisor only: a
 *      durable refutation line in the
 *      supervisor state doc (supervisor-state.service
 *      appendVerifierRefutation — rendered into every later wake block,
 *      untouchable by the supervisor's own merge).
 *
 * Everything is best-effort: a verifier failure is a warn log, never a broken
 * run.
 *
 * TWO LANES share ONE matcher (computePhantomClaims — ticket fcc4dbb4,
 * 2026-08-26):
 *   - POST-DELIVERY (verifyRunActionClaimsAsync): observational, fire-and-
 *     forget, one step behind — tickets + corrections land AFTER the note is
 *     already committed to the thread.
 *   - PRE-DELIVERY (guardMachineWakeFinalAnswer): machine-triggered runs only
 *     — when the matcher convicts, the final note is REPLACED before the
 *     assistant row commits (honest harness notice on top, the original
 *     blockquoted below for audit), so a phantom claim never reaches the
 *     owner unread. The chat-agent seam awaits it and skips the post-delivery
 *     lane on a strike (no double ticket / double correction).
 *
 * TWO SURFACES feed that matcher (ticket e65061e1, 2026-08-27): the final
 * note AND the ARGS of the run's own consequential tool_calls. The 2026-08-27
 * incident embedded a phantom dispatch story in file_feedback args — the call
 * was receipted, so the narrative inside its arguments passed unverified and
 * consumed a full forensic investigation. Args claims run through the SAME
 * extractor + tier chain; convictions are prefixed `[in <tool> args]`.
 *
 * FOUR DETERMINISTIC CITATION LANES ride alongside the action matcher (zero
 * LLM calls, existence-checked, merged into the same conviction set):
 *   - EVIDENCE CITATIONS (ticket c1cbe6a2): `msg <id>` receipt citations in
 *     observation prose, checked against crossmodel message rows;
 *   - SCHEDULE CITATIONS (ticket 5448a836): `sched <id>`/`schedule <id>`
 *     citations of list_schedules-sourced facts, checked against
 *     coding_schedules rows (the 18:34Z incident's invented schedule id
 *     1fd6a55f rode the gap alongside the struck [msg:fa6942ce]);
 *   - SESSION/CHAT REFERENCES (ticket f1cb73ff): dispatch receipts
 *     ("dispatched session X", "session X RUNNING ~70 min") and owner-item
 *     chat refs ("reply in chat X"), cross-checked against the run's actual
 *     executed dispatch records first, then crossmodel_chats/coding_sessions
 *     existence;
 *   - VANISHED-ARTIFACT CITATIONS (rollout watch 2026-09-14): "chat X 404'd /
 *     vanished / no longer exists" — the absence register the session lane
 *     excludes — convicts only when the id has NO trace anywhere (chat,
 *     session, agent_runs, hook_events) AND is absent from this run's tool
 *     output (the fleet's four invented "vanished" chat ids, 07:26Z);
 *   - GOAL/TODO CITATIONS (ticket 3ed139cd): `goal <id>`/`todo <id>` evidence
 *     citations — the labels machine-wake.ts rule 6 TEACHES ('todo'/'goal')
 *     but no lane existence-checked, so the supervisor's 2026-09-13 phantom
 *     rename receipts (five goal ids + todo 078bbac3, all "not found", zero
 *     title matches account-wide, control id resolving fine) sailed through
 *     every audit and fossilized into later notes. Checked against
 *     project_goals/project_todos rows (existence, not status: goals are
 *     archived, never deleted; todos have no delete path).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { utilityChat } from '../../../utils/utility-llm';
// N5 (2026-09-25): per-claim evidence gate — deterministic miner first, the
// decision seat judges each mined claim against the receipts CONCURRENTLY with
// the LLM extractor (shadow); act (designed, not enabled) skips the LLM lane.
import { startClaimEvidenceGate, settleClaimEvidenceGate, claimEvidenceWouldSkipLlm, type ClaimEvidenceGate, type ClaimEvidenceLane } from './claim-evidence-gate';
import { extractDelegationExecutions, extractExecutedActions, extractTaskExecutions, hasActionClaimKeywords, isDelegationClaimDetail, isDelegationTool, isTaskDelegationClaimDetail, isTaskDelegationTool, isTaskOutcomeClaimDetail, trackedCallOutcomeIndexes, ExecutedAction, RunPartLike } from './executed-actions';
import { getRecentChatReceipts } from '../coding/run-receipts.service';
import type { ToolReceipt } from '../coding/run-receipts';
import { isEvidenceToolName, PLATFORM_OBSERVE_TOOLS } from '../coding/evidence-tools';
import { isWriteAckToolName } from '../chat-agent/tool-call-leak';
// (ticket f05b38c1) the shared, PURE claim-verb → tool-class map + the
// own-act clause grammar the verb-consistency veto extracts its verb from.
import { governingClaimVerb, expectedToolsForCitation } from './claim-verb-classes';
import { futureClockReplaceEnabled, partitionFutureClockHits, type ClockHitVerdict, type FutureClockVerdict } from './future-clock-policy';
// BRIEFING-UNVERIFIED-FILTER (2026-10-20): the pre-delivery warn names the action-class footnote the
// supervisor seam appends at finalize (pure leaf, no graph).
import { actionClassAnnotateDisabled, harnessStrippedWording } from './unverified-claims';

const MIN_NOTE_CHARS = 40;
const NOTE_SLICE = 6000;
const RECENT_ARTIFACT_MS = 60 * 60 * 1000; // an id cited as "done this run" must be ≤1h old
const CROSS_WAKE_WINDOW_MS = 24 * 60 * 60 * 1000; // cross-wake exoneration: prior receipts must be ≤24h old

/**
 * Receipts → ExecutedAction pool entries (`ok` carries executed-vs-failed;
 * `staged` mirrors the receipt's ids.staged — since WI-K (2026-09-25) a
 * confirmation-STAGED call mints an ok:false {staged:true, confirmationId}
 * row, and because receipts are authoritative per tool in buildExecutedPool
 * the parts lane no longer supplies the staged entry for that tool).
 * ExecutedAction.ids is string-valued — stringify scalars (a receipt's
 * prNumber arrives as a number) and drop nulls.
 */
function receiptsToActions(receipts: ToolReceipt[]): ExecutedAction[] {
  return receipts.map((r) => ({
    tool: r.tool,
    ok: r.ok,
    staged: r.ids?.staged === true,
    ids: {
      // The receipt row's own id IS the envelope receiptId the model was shown
      // (agent.ts threads ctx.receiptId as the row id) — keep it matchable so
      // a cited "receipt <prefix>" resolves at tier 1 (ticket 6f01288e).
      // Post-fix receipts also carry ids.receiptId (parseResult lifts it) —
      // same value, the spread below simply re-sets it.
      ...(r.id ? { receiptId: String(r.id) } : {}),
      ...Object.fromEntries(
        Object.entries(r.ids ?? {})
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
    },
  }));
}

/**
 * (ticket d25172ca, 2026-09-16) The executed pool is the UNION of both
 * evidence channels: harness receipts (authoritative per-tool wherever a row
 * exists — they carry `ok`/staged semantics) PLUS parts-parsed executions for
 * every tool receipts do NOT cover this run, PLUS the task-execution lane.
 * The pre-fix ternary picked ONE lane on `input.receipts` truthiness — and an
 * EMPTY receipts array is truthy, so any run with zero receipted executions
 * (every plain-chat run that only called notify_user, or any caller passing
 * `receipts ?? []`) had the parts lane BLANKED: a real notify_user Telegram
 * delivery stayed invisible and its truthful narration was struck phantom
 * (chat 66311e6d, 22:47Z). The tool-name filter keeps the two lanes disjoint,
 * so receipts stay authoritative for exactly the tools they carry rows for
 * and no execution double-counts into the kind slot budgets.
 */
function buildExecutedPool(receipts: ToolReceipt[] | undefined, parts: RunPartLike[] | null | undefined): ExecutedAction[] {
  const receiptCovered = new Set((receipts ?? []).map((r) => r.tool));
  return [
    ...receiptsToActions(receipts ?? []),
    ...extractExecutedActions(parts).filter((a) => !receiptCovered.has(a.tool)),
    ...extractTaskExecutions(parts),
    // (ticket 9ca6e125, 2026-10-29) Worker delegations (delegate /
    // delegate_parallel) mint no receipt and answer a PROSE summary with no
    // ok:true envelope, so parts are their only evidence — the same arm as the
    // task lane above. They are NOT in KIND_TOOLS (61b9200a's anti-laundering
    // rule); findPhantomClaims spends them only through the delegation tier.
    ...extractDelegationExecutions(parts),
  ];
}

export type ClaimKind = 'dispatch' | 'message' | 'schedule' | 'ticket';

/**
 * (ticket 3ed139cd) The deterministic CITATION lanes convict kinds outside the
 * action-claim vocabulary: a `goal <id>`/`todo <id>` evidence citation is not
 * an action claim, so it never enters the KIND_TOOLS slot-budget chain (the
 * goal/todo tools deliberately stay OUT of KIND_TOOLS/TRACKED_CONSEQUENTIAL_TOOLS
 * — widening those would rewire the LLM extractor, the args-scan surface, and
 * the coding lane's receipt consumers for zero gain: row existence is the whole
 * exoneration test for a citation). ExtractedClaim.kind is therefore the union;
 * every switch on the four action kinds keeps compiling unchanged.
 */
export type CitedArtifactKind = ClaimKind | 'goal' | 'todo' | 'chat' | 'receipt' | 'oq' | 'board';

export interface ExtractedClaim {
  kind: CitedArtifactKind;
  detail: string;
  id?: string;
  /**
   * Same-prefix REAL ids attached at conviction time (ticket ef347cd0) — the
   * id-splice educational hint rendered by claimDetailLines. Only ever set on a
   * CONVICTED citation; presence implies the cited id does not exist.
   */
  nearMiss?: string[];
  /**
   * (tick 24, 2026-09-16) The id's KIND was inferred by expandCitationLists
   * from a list ("msgs a, b" → b is a msg) — the note never wrote the noun
   * next to it. A kind-probe miss on such an id must fall back to the
   * kind-agnostic existence probe before convicting: the bench supervisor's
   * "3e1cae6f msg f68410cf, 619a1241 msg 619f11f9" put a REAL lane id after a
   * comma and the msg lane struck it as a fabricated message.
   */
  listInferred?: boolean;
  /**
   * (owner 2026-09-16, board-assertion lane) The STATUS the note asserted for
   * a ledger row ("oq_X still open", "todo Y blocked") when the ledger says
   * otherwise; `ledger` carries the row's real status. Both render in the
   * strike so the correction names the right status.
   */
  asserted?: string;
  ledger?: string;
  /**
   * (ticket 7ea4819b, 2026-10-07) Set on a conviction whose cited id is a
   * NEAR-MATCH (edit distance ≤2 for full uuids, ≤1 for short prefixes) of an
   * id in THIS run's executed-pool envelope of the claim's own kind — the id
   * was OBSERVED in a real tool result and then mistranscribed (the incident:
   * the note cited ticket 59a407b-ee05-… while the run's own file_feedback
   * envelope returned 59a4407b-ee05-… — one dropped character). Presence
   * implies the id as written exists nowhere (existence checks are unchanged
   * — the conviction stands) but the citation was MISCOPIED, not invented;
   * `miscopiedFrom` carries the real id so every strike surface can teach it.
   */
  miscopiedFrom?: string;
  /**
   * (Fleet 17:14Z incident, 2026-09-15) Set on an id-bearing ACTION-lane
   * conviction whose cited id exists in NO Digby artifact table AND in none of
   * this run's tool outputs — an INVENTED id, existence arithmetic, not the
   * coin-flip the 2026-09-11 observe-only flip was about. isCitationClassClaim
   * treats it as citation-class so the always-on enforcement strips the line.
   * A real-but-mis-typed id (f16cc02a: a todo labelled [dispatch]) is NOT
   * marked — some table holds it — and stays action-class. A MISCOPIED id
   * (miscopiedFrom set, ticket 7ea4819b) is not marked either: it was
   * observed, then mistranscribed.
   */
  fabricatedId?: boolean;
  /**
   * (ticket c5629165, 2026-10-13) Set on a [ticket] ACTION-lane conviction
   * whose cited id IS a real ticket row — but one this run never filed: the
   * row's filer is another session (context.filedBy / context.sessionId, the
   * E1 filer-binding stamps) or a human, and/or its filing predates this run
   * while this run's own tool OUTPUTS contain no file_feedback success for it.
   * The claim is a MISATTRIBUTION, not an invention: the model READ the ticket
   * (get_feedback / list_feedback) and then asserted authorship of the
   * filing. Presence implies the ticket EXISTS — the strike must never say
   * "invented from memory" and must never advise re-filing (that would
   * DUPLICATE a real ticket — the same harm class ticket 7ea4819b removed
   * for miscopies); the truthful correction is to re-attribute the filing or
   * drop the claim.
   */
  misattributedFiling?: boolean;
}

const KIND_TOOLS: Record<ClaimKind, string[]> = {
  // NOTE (ticket 61b9200a): computer_task / browser_task are deliberately NOT
  // here — KIND_TOOLS feeds BOTH the matcher's per-kind slot budget AND
  // ARGS_SCAN_TOOLS. Putting task tools in `dispatch` would (a) let a phantom
  // id-less PLATFORM-dispatch claim ("I dispatched a worker") be exonerated by
  // an unrelated real computer-task run, and (b) widen the args-scan surface to
  // every task description (LLM extraction cost + claim noise). Task claims get
  // their own budget in findPhantomClaims via TASK_DELEGATION_TOOLS instead.
  dispatch: ['start_coding_session', 'dispatch_platform_task'],
  // (ticket d25172ca) notify_user rides the message kind: a "Telegram
  // notification delivered to @user" claim extracts as message (the
  // 'delivered' cue) and is vouchable by this run's own notify_user
  // execution — it mints a receipt since todo 1e356736 (run-receipts
  // NOTIFY_RECEIPT_TOOLS, ids {channel} only); the parts lane stays its
  // anon-session / receipt-write-failure fallback, same union as before.
  // (ticket 169846b6) both email-send tools ride the message kind too: an
  // email-send claim ("the test email just went out from your CQL Gmail") had
  // no tool that could ever vouch for it, so the TRUE claim in chat b9cd2f21
  // was struck phantom while the real Gmail send (message 1a0e43973e3cca6c)
  // sat in the run's own parts. Vocabulary and pool MUST move in lockstep
  // (the d25172ca rule): widening KIND_TOOLS without widening
  // TRACKED_CONSEQUENTIAL_TOOLS convicts honest sends; the reverse widens
  // ARGS_SCAN_TOOLS' args surface to email bodies (same accepted trade-off as
  // notify_user's message text, ticket e65061e1).
  message: ['send_chat_message', 'notify_user', 'gmail_send_email', 'send_email_as_digby',
    // (ticket 9ca6e125, 2026-10-29) the outbound-connector + edge-instance send
    // class, in LOCKSTEP with their addition in executed-actions.ts
    // TRACKED_CONSEQUENTIAL_TOOLS (the d25172ca rule). They answer the shared
    // {ok, tool, ids} JSON envelope, so they enter the pool as vouchable
    // executions; while absent from BOTH surfaces a truthful "posted it in
    // #eng" / "messaged them on iMessage" claim was unvouchable and convicted
    // id-less with "executed consequential actions this run: NONE". The
    // accepted cost of the lockstep (documented on the email tools above and at
    // notify_user, ticket e65061e1): ARGS_SCAN_TOOLS widens to these tools'
    // args, i.e. to outbound message BODIES — a narration-shaped Slack/iMessage
    // body becomes auditable prose, which is the safe direction.
    'send_to_instance', 'imessage_send', 'slack_post_message',
    'discord_send_message', 'discord_send_dm', 'x_post',
  ],
  schedule: ['schedule_message', 'update_schedule', 'cancel_schedule'],
  // ticket ae085617's exact incident: "I've filed a ticket" + an invented
  // ticket id, with zero file_feedback tool calls.
  ticket: ['file_feedback'],
};

/**
 * (ticket a235fbd6, 2026-09-28) STAGING-NARRATION exoneration tier — the
 * backing tools for "I've staged a message/file … it will land as chat
 * attachments" claims. stage_upload mints a receipt (run-receipts
 * CONTROL_COORD_RECEIPT_TOOLS) and answers {ok, ids:{uploadId}} from its own
 * JSON envelope, so it arrives in the executed pool as a vouchable execution.
 * It deliberately stays OUT of KIND_TOOLS.message: a phantom "sent a message"
 * claim must NOT be exonerated by an unrelated real stage_upload (staging is
 * a precondition of a send, not a send), and a truthful STAGING claim must
 * not burn a real send_chat_message slot it never claimed. Instead
 * findPhantomClaims routes STAGING-NARRATION claims to their own tier below
 * (matched by narration idiom, like the task-delegation tier's discipline).
 */
const STAGING_NARRATION_TOOLS = ['stage_upload'] as const;

/** Exported for tests: is this pool entry a staging execution (stage_upload)? */
export function isStagingTool(tool: string): boolean {
  return STAGING_NARRATION_TOOLS.includes(String(tool ?? '') as any);
}

/**
 * (ticket ee212347, 2026-09-30) DISPATCH-STAGING narration tools — the
 * backing tools for "I've dispatched a worker/session" claims whose detail
 * narrates a STAGING action (the claim surface the extractor labels
 * [dispatch]). dispatch_platform_task stages a coding session but does NOT
 * ship code — it answers {staged:true, confirmationId} (or 409) and the
 * owner confirms. A truthful staging claim must be exonerated by the STAGING
 * execution, not by a shipping tool (start_coding_session / delegate). The
 * pair maps: claim kind 'dispatch' + staging idiom → staging tools
 * (dispatch_platform_task). Mirrors STAGING_NARRATION_TOOLS for messages.
 */
const DISPATCH_STAGING_NARRATION_TOOLS = ['dispatch_platform_task'] as const;

/** Exported for tests: is this pool entry a dispatch-staging execution? */
export function isDispatchStagingTool(tool: string): boolean {
  return DISPATCH_STAGING_NARRATION_TOOLS.includes(String(tool ?? '') as any);
}

/**
 * First-person staging-narration idiom for a stage_upload-backed claim (the
 * claim surface the extractor labels [message]): "I've staged a message to
 * the deck session", "staged the deck files as attachments",
 * "hand-deliver … as real chat attachments". Mirrors the pre-gate's
 * STAGING_CLAIM_IDIOM in executed-actions.ts (the two must move in lockstep —
 * the pre-gate routes, the tier exonerates).
 */
const STAGING_CLAIM_DETAIL_IDIOM =
  /\b(?:staged|staging)\s+(?:a\s+|an\s+|the\s+)?(?:message|file|upload|attachment|blob|pdf|deck|document|image|spreadsheet|csv)\b|\b(?:hand-?deliver(?:ed|ing)?|as\s+(?:real\s+)?chat\s+attachments?)\b/i;

/** Exported for tests: does this claim detail narrate a STAGING action (the a235fbd6 class)? */
export function isStagingClaimDetail(detail: string): boolean {
  return STAGING_CLAIM_DETAIL_IDIOM.test(String(detail ?? ''));
}

/**
 * (ticket ee212347, 2026-09-30) First-person DISPATCH-STAGING idiom for a
 * [dispatch] claim that narrates a STAGING action rather than a shipped
 * dispatch: "I've dispatched a platform task — staged for owner confirmation",
 * "staged the dispatch … awaiting confirmation". Four patterns, readonly
 * RegExp[] — keep in sync with executed-actions.ts STAGING_CLAIM_IDIOM
 * (the pre-gate routes, this tier exonerates).
 */
const DISPATCH_STAGING_CLAIM_DETAIL_IDIOMS: readonly RegExp[] = [
  /\bstaged\b/i,
  /\bdraft(?:ed|ing)?\b/i,
  /\bpreview(?:ed|ing)?\b/i,
  /\bdry[- ]run\b/i,
];

/** Exported for tests: does this claim detail narrate a DISPATCH-STAGING action (the ee212347 class)? */
export function isDispatchStagingClaimDetail(detail: string): boolean {
  const d = String(detail ?? '');
  return DISPATCH_STAGING_CLAIM_DETAIL_IDIOMS.some((re) => re.test(d));
}

/** Tracked tool_calls whose ARGS the matcher also scans (ticket e65061e1) — derived from KIND_TOOLS so the two can never drift. */
const ARGS_SCAN_TOOLS = new Set<string>(([] as string[]).concat(...Object.values(KIND_TOOLS)));

const parseJson = <T,>(text: string, fallback: T): T => {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as T; } catch { return fallback; }
};

/** Exported for tests: LLM claim extraction over one narrative surface (the final note, or a tool_call's args — ticket e65061e1). */
export async function extractActionClaims(finalText: string, surface = 'STATUS NOTE'): Promise<ExtractedClaim[]> {
  const raw = await utilityChat([
    {
      role: 'system',
      content: 'You audit an AI assistant\'s status note for ACTION CLAIMS — statements that an action was ALREADY TAKEN during this run. '
        + 'Return ONLY valid JSON: {"claims":[{"kind":"dispatch"|"message"|"schedule"|"ticket","detail":"<short verbatim quote>","id":"<the id/uuid the note cites for it, else empty>"}]}. '
        + 'kind dispatch = started/dispatched a coding session, worker, or platform task, OR staged a platform-task dispatch for owner confirmation (a staging claim — "dispatched the task, staged for owner confirmation", "dispatched a draft/preview" — quote verbatim; the staging tool is dispatch_platform_task), OR ran a delegated computer/browser task on the user\'s machine (a computer task / browser task / computer-use / browser-agent sub-session — quote its task narration verbatim); message = sent/queued/delivered a message to another chat, OR staged a message/file/attachment for delivery to another chat (staging claims — "staged a message", "hand-deliver as chat attachments", "prepared the files as an upload" — quote verbatim; the staging tool is stage_upload), OR pushed a notification to the user (notify_user — e.g. "Telegram notification delivered to @user", "notified you on Telegram"), OR sent an email this run (gmail_send_email from the user\'s Gmail / send_email_as_digby — e.g. "the test email just went out from your CQL Gmail"); schedule = created/updated/cancelled a schedule; ticket = filed/flagged a feedback ticket or issue report. '
        + 'Count ONLY first-person completed actions in THIS run. IGNORE: plans and intentions ("I will", "next I"), observations, questions, reports about OTHER agents\' or past runs\' actions, and readings of existing state'
        + (failureReportExemptDisabled() ? '.' : ', and reports that an action FAILED, timed out, errored or did not complete ("my browser task timed out", "the dispatch failed") — those claim no completed action.'),
    },
    { role: 'user', content: `${surface}:\n${finalText.slice(0, NOTE_SLICE)}` },
  ], { maxTokens: 500, temperature: 0.1, timeout: 30000, retryNotFound: true });
  const parsed = parseJson<{ claims?: Array<{ kind?: string; detail?: string; id?: string }> }>(raw, {});
  const out: ExtractedClaim[] = [];
  for (const c of parsed.claims ?? []) {
    const kind = String(c?.kind ?? '') as ClaimKind;
    if (!KIND_TOOLS[kind]) continue;
    out.push({ kind, detail: String(c?.detail ?? '').slice(0, 200), ...(c?.id ? { id: String(c.id).trim() } : {}) });
  }
  return out;
}

/**
 * (ticket 587e9d64) VERBATIM-GROUNDING for LLM-extracted action claims — the
 * extractor is INSTRUCTED to return "short verbatim quote" details, but until
 * now nothing enforced it, and the 2026-09-14 chat-378224d5 incident showed
 * the cost: an HONEST note ("The deliverable (created this run) … built from
 * the session's parse of the ALL IN attendee directory") was paraphrase-
 * hallucinated by the utility LLM into a first-person DISPATCH claim
 * ("created a coding session to generate the deliverable … (id 9ed656af-…)"
 * — words the note never contained), which the tier chain then convicted (no
 * own-run receipts; the dispatch artifact check reads crossmodel_chats only,
 * and the cited id is a generated-FILE row). The appended [ACTION VERIFIER]
 * correction was itself false — it contradicted a TRUE note in the user's
 * thread, and auto-filed the mishap ticket this fix answers.
 *
 * The deterministic miners are regex-grounded by construction; the LLM lane
 * now is too: a claim survives only when its detail has textual support in
 * the surface it was extracted from. Fail toward MISS (drop), never toward
 * strike — a false strike replaces an HONEST note (strictly worse than a
 * miss, which the deterministic miner + the post-delivery lane backstop; and
 * a dropped TRUE claim is harmless whenever the action really executed, since
 * there is nothing to exonerate).
 *
 * Grounding rule (callers pass the SAME NOTE_SLICE window the extractor saw):
 *   1. fast path — the normalized detail is a verbatim substring of the
 *      normalized source;
 *   2. token path — the detail's content tokens (≥3 chars, non-stopword,
 *      non-numeric, non-id-fragment) must be covered by ONE source window (a
 *      line or sentence): ALL of them when ≤4 tokens, else ≥80%. Verbatim
 *      quotes pass trivially; paraphrases spanning sentences fail — the safe
 *      direction;
 *   3. a claim with no checkable content (empty / stopword-only / id-only
 *      detail) is KEPT — grounding never invents a reason to drop.
 */
export interface GroundingResult {
  grounded: ExtractedClaim[];
  dropped: ExtractedClaim[];
}

/**
 * (audit 2026-10-08 W1-4 — supervisors F5) ID-SHAPE + VERB-KIND gate for
 * LLM-extracted claims. The incident: the extractor labelled Schooltime's TRUE
 * line "push `2b7bc8a` verified on origin" a `ticket` claim with id 2b7bc8a (a
 * real git sha — git_commit receipt 875f891a, git_push a8d531ea); verbatim
 * grounding passed (the detail IS a quote), no ticket row matched a 7-char
 * sha, the citation-enforce lane struck the line from the owner-facing note and
 * told the supervisor it had fabricated evidence. Digby artifact ids are uuids
 * cited as an 8-hex prefix or the full uuid; a 7-hex token, a 9–40-hex run
 * without dashes, or any hex id sitting next to git vocabulary (push / commit /
 * sha / merge / origin / branch …) is a git ref, never a Digby action id. And
 * a claim's verb must match its kind — a `ticket` claim needs a filing verb AND
 * a ticket noun. Failing either ⇒ the claim is DROPPED (fail toward miss, the
 * 587e9d64 doctrine — a false strike is strictly worse than a miss). Kill
 * switch ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED=1. Pure; exported for tests.
 */
const GIT_CONTEXT_RE = /\b(?:push(?:ed|es|ing)?|commit(?:s|ted)?|sha|merge[ds]?|merging|origin|branch(?:es)?|rebase[ds]?|head|cherry-?pick(?:ed)?|tag(?:ged)?|git|ancestry|fast-forward(?:ed)?)\b/i;
/** A ticket claim must be WORDED as a filing: a filing verb or a ticket noun (file_feedback / bug_report count). */
const KIND_WORDING_RES: Record<string, RegExp> = {
  ticket: /(?:\b|_)(?:fil(?:ed|ing|e)|flag(?:ged|ging)?|rais(?:ed|ing)|logg(?:ed|ing)|submit(?:ted|ting)|tickets?|feedback|issues?|bugs?|reports?|mishaps?)(?:\b|_)/i,
};
export function claimShapeGateDisabled(): boolean {
  return process.env.ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED === '1';
}

/**
 * (ticket 331a1b23, 2026-10-27) Kill switch for the args-scan execution gate +
 * id-less args-twin dedup: =1 restores the pre-fix behavior byte-for-byte
 * (every tracked tool_call's args scanned regardless of outcome, no id-less
 * dedup) the moment a phantom exploits the execution gate to slip past the
 * args surface. A precision change on the fabrication guard's conviction path
 * needs an instant box-env revert, not a code change.
 */
export function argsTwinFixDisabled(): boolean {
  return process.env.ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED === '1';
}
export type ClaimShapeDropReason = 'git_sha_shape' | 'git_context' | 'kind_verb';
export function gateLlmClaimShapes(claims: ExtractedClaim[]): { kept: ExtractedClaim[]; dropped: Array<{ claim: ExtractedClaim; reason: ClaimShapeDropReason }> } {
  if (claimShapeGateDisabled()) return { kept: claims, dropped: [] };
  const kept: ExtractedClaim[] = [];
  const dropped: Array<{ claim: ExtractedClaim; reason: ClaimShapeDropReason }> = [];
  for (const c of claims) {
    const id = String(c.id ?? '').trim().replace(/^[`'"#(]+|[`'".,)]+$/g, '');
    const detail = String(c.detail ?? '');
    // A CONTIGUOUS hex run of 7 or 9–40 chars is a git sha shape (a Digby id is cited as its 8-hex
    // prefix or the dashed uuid — a dashed id, even a miscopied one, is never read as a sha).
    // A 7/9-char id WORDED as its kind with no git vocabulary stays — it may be a miscopied 8-hex
    // prefix (ticket 7ea4819b: "59a407b" for 59a4407b), which the miscopy tier diagnoses.
    const contiguousHex = /^[0-9a-f]{7,40}$/i.test(id);
    const shaShape = contiguousHex && id.length !== 8;
    const gitContext = contiguousHex && GIT_CONTEXT_RE.test(detail);
    const wording = KIND_WORDING_RES[c.kind];
    const kindWorded = !wording || wording.test(detail);
    if (shaShape && (gitContext || !kindWorded)) { dropped.push({ claim: c, reason: 'git_sha_shape' }); continue; }
    if (gitContext && !kindWorded) { dropped.push({ claim: c, reason: 'git_context' }); continue; }
    if (!kindWorded) { dropped.push({ claim: c, reason: 'kind_verb' }); continue; }
    kept.push(c);
  }
  return { kept, dropped };
}

function recordClaimShapeDrops(chatId: string, surface: 'note' | 'args', dropped: Array<{ claim: ExtractedClaim; reason: ClaimShapeDropReason }>): void {
  if (!dropped.length) return;
  logger.warn(`action-verifier: dropped ${dropped.length} LLM-extracted ${surface} claim(s) whose id shape / verb does not fit their kind (audit 2026-10-08 W1-4): ${dropped.map((d) => `[${d.claim.kind}:${d.reason}] ${String(d.claim.id ?? '')} ${d.claim.detail.slice(0, 80)}`).join(' | ')}`, { source: 'action-verifier', chatId });
  void import('./loop-metrics.service').then(({ recordLoopMetric }) => recordLoopMetric({
    kind: 'action_verifier_claim_shape_drop',
    sessionId: chatId,
    value: dropped.length,
    meta: { surface, drops: dropped.slice(0, 6).map((d) => ({ kind: d.claim.kind, reason: d.reason, id: String(d.claim.id ?? '').slice(0, 40), detail: d.claim.detail.slice(0, 120) })) },
  })).catch(() => { /* telemetry never blocks */ });
}

/**
 * (ticket bbd8521e, 2026-10-13) THIRD-PARTY-ATTRIBUTION drop register for
 * LLM-extracted action claims. THE INCIDENT CLASS: a project supervisor's
 * wake notes narrate OTHER lanes' status over REAL artifacts —
 *   · "the **dispatched lane 41fd09ed** is well ahead — read the verdict as
 *     it landed and pushed fix commits…" (strike 2026-10-13T09:09:54Z, kinds
 *     dispatch, phantoms:1 — lane 41fd09ed is a real chat dispatched by the
 *     ticket machinery on an earlier wake),
 *   · "The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane is
 *     acknowledged — not re-staged" (strike 10:39:25Z, kinds message — the
 *     HARNESS'S OWN deliverables-acknowledgment idiom, so the platform
 *     instructs an idiom its verifier then strikes),
 *   · "24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z)" (strikes 06:54/10:57/
 *     11:27Z, kinds message — a backstop cadence report citing a real
 *     in_progress ticket).
 * The LLM extractor's prompt SAYS "Count ONLY first-person completed actions
 * in THIS run … IGNORE … reports about OTHER agents' or past runs' actions",
 * but nothing ENFORCES that contract: verbatim grounding passes (the text IS
 * verbatim), the id-shape gate passes (the id IS well-formed), every
 * exoneration tier then CORRECTLY finds no own-run execution (message-kind
 * has no artifact exoneration by design, review C5; dispatch-kind requires
 * createdAt ≤1h) — and an honest note is struck on real artifacts other
 * lanes own. This is the residual class behind the 2026-09-11 observe-only
 * flip ("all 9 'phantom' message ids it struck … were REAL lane messages the
 * supervisor had read"), and it still fired 5× on ONE supervisor on
 * 2026-10-13. The deterministic fallback miner is person-gated
 * (MINER_FIRST_PERSON); this register gives the LLM lane the same teeth.
 *
 * Frames (all require a THIRD-PARTY subject — a first-person ACTIVE claim
 * never matches; frame (f) is the deliberate exception, a first-person
 * PASSIVE subject ("I was dispatched to a fix lane") narrates machinery
 * action ON the run, never the run's own action):
 *   (a) ATTRIBUTIVE PARTICIPLE — determiner + optional emphasis + optional
 *       adjective + participle + agent noun: "the **dispatched lane
 *       41fd09ed**", "the spawned reviewer", "its steered sub-session". A
 *       genuine claim ("I dispatched lane X", "Restored lane X from the
 *       archive") has NO determiner before the participle and never matches.
 *   (b) AGENT-LOCATION — "<verb> on/onto/into the lane/session/chat":
 *       "posted on the lane is acknowledged", "folded into the lane".
 *   (c) STATUS COPULA — agent noun + id + is/was/owns/stays/fires/…:
 *       "lane 41fd09ed is well ahead", "the lane 41fd09ed owns the cycle".
 *   (d) FIRING-STATUS — "firing 10/24 (msg …)": a backstop cadence report.
 *   (e) PROGRESSIVE LANE STATUS (ticket 2580b092, 2026-10-16) — a lane
 *       NARRATED as present-progressive work-in-progress, either shape:
 *       agent-subject ("the decrypt lane is building your batch-decrypt
 *       proposal", "the other two threads are already moving") or
 *       agent-location ("the Gmail SMTP recovery-email wiring is running on
 *       the app lane"). The incident: the Schooltime project supervisor's
 *       05:57Z note reported its two REAL worker lanes' status — both
 *       threads existed and were genuinely mid-flight (the SMTP leg's todo
 *       746aa1c5 had just closed with full evidence at 05:56Z; the decrypt
 *       lane was mid batch-build) — and the extractor mislabeled both
 *       [dispatch]; the id-less claims then convicted on the empty
 *       execution pool (step 4 slot accounting), striking an honest note
 *       that narrated NO self-action. Frames (a)–(d) miss the shape: no
 *       participle-before-agent-noun, "running" is not in (b)'s verb list,
 *       no id for (c). The progressive frame carries THREE extra
 *       first-person guards of its own (beyond FIRST_PERSON_ACTOR_RE)
 *       because present-progressive prose is where an honest actor lives:
 *       (1) a first-person progressive ("I am building…", "we are already
 *       moving…") is the run's OWN ongoing work, never third-party; (2) an
 *       embedded actor ("the wiring I just deployed is running…") anchors
 *       the work to a first-person completed action; (3) ANY elided-actor
 *       completed-action verb ("dispatched session X and it is now
 *       running") keeps the claim for the tier chain — the ee212347
 *       laundering shape must never ride a location phrase to acquittal.
 * Fail toward MISS (drop, never strike) — the 587e9d64 doctrine: a false
 * strike replaces an HONEST note, strictly worse than a dropped TRUE claim
 * (harmless whenever the action really executed — there is nothing to
 * exonerate). Kill switch ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1.
 */
const THIRD_PARTY_ATTRIBUTION_FRAMES: readonly RegExp[] = [
  // (a) attributive participle: "the **dispatched lane 41fd09ed**"
  /\b(?:the|this|that|these|those|its|our)\s*[*_]{0,2}\s*`?\s*(?:new|duplicate|prior|live|restored|fresh|original|other|own)?\s*(?:\*\*)?\s*(?:dispatched|spawned|launched|started|restored|archived|steered|messaged|nudged|queued|forwarded|notified|escalated|relayed|reported|filed|flagged|scheduled|updated|sent)\s+[*_`]{0,2}\s*(?:lanes?|sessions?|workers?|reviewers?|vehicles?|sub-?sessions?|colleagues?|subagents?)\b/i,
  // (b) agent-location: "posted on the lane is acknowledged"
  /\b(?:posted|sent|delivered|landed|queued|folded|staged|dropped|written|reported|acknowledged)\s+(?:back\s+|in\s+)?(?:on|onto|into|in)\s+(?:the|its|this|that|a|an)\s+(?:lanes?|sessions?|chat|thread|reviewers?|vehicles?)\b/i,
  // (c) status copula: "lane 41fd09ed is well ahead" / "the lane owns the cycle"
  /\b(?:lanes?|sessions?|workers?|reviewers?|vehicles?|sub-?sessions?|colleagues?|subagents?)\s+(?:id\s*)?[`"']?[0-9a-f-]{6,}[`"']?\s+(?:is|was|stays|remains|owns|carries|holds|keeps|fires|fired|re-?arms?|absorbs|absorbed|acknowledges|acknowledged|confirms|confirmed|verifies|verified)\b/i,
  // (d) firing-status: "24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z)"
  /\bfiring\s+\d+\s*\/\s*\d+\b/i,
];
/**
 * (ticket 2580b092, 2026-10-16) Frame (e) — PROGRESSIVE LANE STATUS. The
 * incident lines ("the Gmail SMTP recovery-email wiring is running on the app
 * lane", "the decrypt lane is building your batch-decrypt proposal") matched
 * NONE of frames (a)–(d): no participle-before-agent-noun (a), "running" not
 * in (b)'s verb list, no id for (c). Two sub-shapes, both THIRD-PARTY:
 *   (e1) AGENT-SUBJECT — determiner + ≤3 modifier words + agent noun +
 *        is/are/was/were + (adverbs) + progressive participle:
 *        "the decrypt lane is building …", "the other two threads are
 *        already moving", "the spawned reviewer is verifying the diff".
 *   (e2) AGENT-LOCATION — is/are/was/were + participle + on/onto/in/at +
 *        determiner + ≤2 modifier words + agent noun:
 *        "the Gmail SMTP recovery-email wiring is running on the app lane".
 *        A first-person subject ("I was working …") or possessive subject
 *        ("my batch build is running …") is EXCLUDED by lookbehind — the
 *        run's own work is never third-party narration.
 * The progressive frame runs ONLY after frames (a)–(d) and its own guards
 * (below) — see THIRD_PARTY_PROGRESSIVE_* for why this frame is the most
 * laundering-prone of the five and carries three extra actor guards.
 */
const TP_AGENT_NOUNS = 'lanes?|sessions?|workers?|reviewers?|vehicles?|sub-?sessions?|colleagues?|subagents?|supervisor|fleet|threads?';
const TP_EMPHASIS_WORD = '(?:[`*_]{0,2}[a-z0-9][a-z0-9_-]*[`*_]{0,2}[ \\-])';
const TP_AGENT_NOUN_E = `(?:[\`*_]{0,2}(?:${TP_AGENT_NOUNS})[\`*_]{0,2})`;
const TP_PROG_ADVERBS = '(?:(?:already|still|now|also|currently|again)\\s+)*';
const TP_PROG_PARTICIPLES = '(?:running|building|working|verifying|validating|processing|measuring|walking|testing|checking|folding|carrying|preparing|executing|chasing|serving|streaming|pushing|landing|moving|finishing)';
const THIRD_PARTY_PROGRESSIVE_FRAMES: readonly RegExp[] = [
  // (e1) agent-subject: "the decrypt lane is building your batch-decrypt proposal"
  new RegExp(`\\b(?:the|this|that|these|those|its|our|their)\\s+(?:${TP_EMPHASIS_WORD}){0,3}${TP_AGENT_NOUN_E}\\s+(?:is|are|was|were)\\s+${TP_PROG_ADVERBS}${TP_PROG_PARTICIPLES}\\b`, 'i'),
  // (e2) agent-location: "the wiring is running on the app lane" — first-person
  // and possessive subjects are excluded by lookbehind (variable-length, ES2018+).
  // The possessive window is {0,12} (cross-family review F3: a 6-modifier
  // possessive subject "my brand new decrypt batch proposal build is running
  // on the app lane" slipped the earlier {0,5} bound and laundered through).
  new RegExp(`(?<!\\b(?:i|we)\\s+)(?<!\\b(?:my|our|your)\\s+(?:${TP_EMPHASIS_WORD}){0,12})\\b(?:is|are|was|were)\\s+${TP_PROG_ADVERBS}${TP_PROG_PARTICIPLES}\\s+(?:on|onto|in|at)\\s+(?:the|its|this|that|a|an)\\s+(?:${TP_EMPHASIS_WORD}){0,2}(?:${TP_AGENT_NOUNS})\\b`, 'i'),
];
/**
 * (ticket 385de869, 2026-10-21) Frame (f) — PASSIVE MACHINERY DISPATCH. The
 * incident: a user-facing chat's honest note (msg 60d56315, chat b3dede3e)
 * narrated the ticket machinery's REAL dispatch of the very ticket that chat
 * had filed — "Ticket `4424ebd6` updated with the fresh-install reproduction
 * — it's already dispatched to a fix lane (started 16:52 UTC), so a platform
 * fix is in motion" — and the verifier struck it as a phantom [dispatch]
 * claim. The state was TRUE observed data: the dispatcher had auto-routed
 * ticket 4424ebd6 to lane 5a73dd5c at 16:52:08.100Z (filedAt 16:52:08.072Z,
 * eighteen milliseconds earlier by the chat's own file_feedback), and the
 * chat had read that row back via get_feedback before narrating it. The run
 * executed zero dispatch tools — correctly: the DISPATCH was the ticket
 * machinery's action, not the chat's. None of frames (a)–(e) match the
 * shape: frame (a) needs the participle directly before the agent noun
 * ("the dispatched lane X", not "dispatched TO a fix lane"), "dispatched" is
 * absent from frame (b)'s verb list and "to" from its prepositions, frame
 * (c) needs an id, frame (e) needs a progressive participle. The id-less
 * claim fell to step-4 slot accounting and convicted on the empty dispatch
 * pool — the exact bbd8521e harm class (an honest note struck over real
 * machinery state) in a residual grammatical shape: the PASSIVE VOICE.
 *
 * The frame: passive auxiliary + (adverbs) + machinery participle +
 * to/onto/into + determiner + ≤3 modifiers + agent noun —
 * "it's already dispatched to a fix lane", "the ticket is queued to a
 * worker lane", "the report was routed to a dedicated session", "the mishap
 * got escalated to the fleet supervisor", "the follow-up has been assigned
 * to a reviewer". A passive construction's subject is the PATIENT, not the
 * actor — even a FIRST-PERSON passive subject ("I was dispatched to a fix
 * lane as the worker", review F5) narrates the machinery's action ON the
 * run, never the run's own action, so the FIRST_PERSON_ACTOR_RE guard (an
 * ACTIVE-voice actor) correctly does not fire and the claim is third-party
 * state, the (a)–(d) doctrine. The (e)-frame guards #1/#2 (first-person
 * progressive, embedded first-person actor) still run FIRST — they anchor
 * the narration to the run's own work in any voice and win.
 *
 * EVALUATION ORDER (review F1): guards #1/#2 → frame (f) → guard #3 → frames
 * (e). Frame (f) must run BEFORE guard #3 (ELIDED_ACTOR_COMPLETED_ACTION_RE)
 * — the incident detail ends "(started 16:52 UTC)" and guard #3 matches
 * "started"/"dispatched" in ANY voice, so a post-guard placement would veto
 * the drop — but AFTER guards #1/#2, which the incident does not need
 * bypassed (its detail carries no I/we) and which keep the 2580b092 shapes
 * ("the wiring I just deployed is assigned to the app lane") for the tier
 * chain. The passive auxiliary is the voice discriminator: every pinned
 * true-positive phantom is ACTIVE — "I dispatched the nightly audit worker"
 * (587e9d64, first person), "dispatched session X and it is now running on
 * the lane" (ee212347 case 5, subject-dropped), "dispatched a worker for
 * the backlog" (e413c084, elided actor), "I dispatched lane deadbeef"
 * (bbd8521e guard), "the browser task did dispatch to your Mac's local
 * browser" (d78f477b, emphatic "did" + BASE form "dispatch") — none carries
 * a copula/get/has-been before its participle, so none can match. The
 * perfect-active shape ("has dispatched a worker to the lane") is excluded
 * structurally: has/have/had are admitted ONLY in the "has [adverb] been
 * <participle>" chain. Fail toward MISS (the 587e9d64 doctrine); kill
 * switch unchanged (ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1, the
 * register's shared row).
 */
// (review F2/F3) The auxiliary chain: \b-anchored (F3 — the "is" inside
// "analysis"/"axis" is never a passive auxiliary), adverbs admitted BOTH
// between has/have/had and "been" ("the ticket has now been dispatched" —
// without this the ticket's own phrasing recurs on the most natural perfect
// passive) and between the plain auxiliary and the participle ("was just
// routed"), the adverb set widened beyond (e)'s with
// just/then/subsequently/finally/successfully, and 'm/'re admitted so the
// same first-person passive is not tense-asymmetric ("I was assigned…"
// drops; "I'm assigned…" must too).
const TP_PASSIVE_ADVERBS = '(?:already|still|now|also|currently|again|just|then|subsequently|finally|successfully)';
// (review F4) Bounded modifier token — the shared TP_EMPHASIS_WORD's
// unbounded [a-z0-9_-]* backtracks super-linearly on long non-matching runs
// (measured 9.6 s at 4k chars pre-bound); a local {0,23}-bounded class is
// semantically identical for real prose and keeps frame (f)'s worst case
// linear.
const TP_PASSIVE_MODIFIER = '(?:[`*_]{0,2}[a-z0-9][a-z0-9_-]{0,23}[`*_]{0,2}[ \\-])';
const TP_PASSIVE_AUX = `\\b(?:(?:'s|'m|'re|is|are|was|were|gets?|got)\\s+(?:(?:${TP_PASSIVE_ADVERBS}|been|being)\\s+){0,2}|(?:has|have|had)\\s+(?:${TP_PASSIVE_ADVERBS}\\s+){0,2}been\\s+(?:${TP_PASSIVE_ADVERBS}\\s+){0,2})`;
const TP_PASSIVE_PARTICIPLES = '(?:dispatched|queued|routed|escalated|assigned|relayed)';
const THIRD_PARTY_PASSIVE_DISPATCH_RE = new RegExp(
  `${TP_PASSIVE_AUX}${TP_PASSIVE_PARTICIPLES}\\s+(?:to|onto|into)\\s+(?:the|a|an|its|this|that|our|their)\\s+(?:${TP_PASSIVE_MODIFIER}){0,3}(?:${TP_AGENT_NOUNS})\\b`,
  'i',
);
/**
 * (ticket a328c93e, av-mishap family, 2026-11-01) Frame (g) — AGENT-SUBJECT
 * PAST-TENSE ACTION. The incident class: a SUPERVISOR's machine-wake note
 * reports ANOTHER lane's progress in the simple past — "the lane started its
 * first turn at 19:36Z (run `44374562`)", "a build lane picked up the first
 * three within ninety seconds of being created" — and the LLM extractor
 * labels it a this-run [dispatch] claim. The run executed no dispatch tool
 * (correctly: it READ goal_get / todo_list / get_chat_messages and narrated
 * what it saw), so the id-less claim fell to step-4 slot accounting and was
 * struck as a phantom on the empty dispatch pool — the bbd8521e harm class
 * again, in a grammatical shape none of the six existing frames covers:
 *   - (a) needs the participle BEFORE the agent noun ("the dispatched lane");
 *   - (b)'s verb list is past-tense but its prepositions are location-only and
 *     it needs the verb FIRST ("posted on the lane"), not an agent SUBJECT;
 *   - (c) needs an id on the noun;
 *   - (e1) needs a copula + PROGRESSIVE participle ("the lane is building"),
 *     so a simple past ("the lane started") falls straight through;
 *   - (e2) is agent-location, not agent-subject;
 *   - (f) is PASSIVE (no agent) — here the agent noun IS the subject.
 * Empirically confirmed pre-fix: isThirdPartyAttributionDetail returned false
 * on both incident details (probe run in this lane, 2026-11-01).
 *
 * The frame: determiner + ≤3 modifiers + agent noun + optional relative
 * pronoun + (adverbs) + PAST-TENSE completed verb. A determiner-headed agent
 * noun in subject position performing a completed action is machinery state
 * narrated third-party, exactly like (a)–(f) — the run's OWN work is
 * first-person ("I dispatched…") and is protected by the guards that run
 * BEFORE this frame.
 *
 * SAFETY (the pinned true positives this must never drop — every one is
 * ACTIVE voice with an ELIDED or FIRST-PERSON actor, never a determiner-headed
 * agent-noun subject):
 *   - "I dispatched the nightly audit worker" (587e9d64) — FIRST_PERSON_ACTOR_RE
 *   - "dispatched session 41fd09ed and it is now running on the lane"
 *     (ee212347 case 5) — subject-dropped, no determiner subject
 *   - "dispatched a worker for the backlog" (e413c084) — verb-first
 *   - "I dispatched lane deadbeef" (bbd8521e) — FIRST_PERSON_ACTOR_RE
 *   - "the browser task did dispatch to your Mac's local browser" (d78f477b) —
 *     the EMPHATIC "did <base>" form is deliberately NOT admitted: this frame
 *     requires the finite PAST form directly, so "did" cannot bridge it (that
 *     pin is a real expiry of a REAL earlier dispatch and must keep firing).
 * Placement mirrors frame (f) (review F1): AFTER guards #1/#2 — which anchor
 * a narration to the run's own work in any voice ("the lane I dispatched",
 * "the wiring I just deployed") — and BEFORE guard #3
 * (ELIDED_ACTOR_COMPLETED_ACTION_RE), whose verb list matches "started" in
 * ANY voice and would veto the drop. Guard #3 is exactly why (a)–(e) cannot
 * simply be widened. Fail toward MISS (the 587e9d64 doctrine); same kill
 * switch row (ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1).
 */
const TP_AGENT_SUBJECT_ADVERBS = '(?:(?:already|still|now|also|currently|again|just|then|subsequently|finally|successfully|immediately|quickly|directly|first)\\s+)*';
const TP_AGENT_SUBJECT_PAST_VERBS = '(?:started|began|kicked\\s+off|picked\\s+up|ran|took|landed|moved|progressed|finished|completed|reached|shipped|spent|used|handled|processed|executed|worked|turned|replied|answered|acted|created|wrote|committed|merged|deployed|produced|opened|filed|closed|cleared|pushed|built|drafted|posted|sent|delivered|reported|flagged|verified|confirmed|checked|resumed|restored|retired|archived|steered|messaged|nudged|forwarded|notified|escalated|relayed|installed|wired|registered|placed|renewed|armed|revived|reopened|rebooted|restarted|spawned|dispatched|launched|queued|scheduled|updated)';
const THIRD_PARTY_AGENT_SUBJECT_ACTION_RE = new RegExp(
  // 'this' is deliberately ABSENT from the determiner set: "this session
  // updated the ledger" / "this lane ran the build" is SELF-reference — the
  // run's own work in a third-person disguise, which must stay for the tier
  // chain (dropping it would be a needless miss). Every third-party noun
  // keeps the|that|these|those|its|their|a|an.
  '\\b(?:the|that|these|those|its|their|a|an)\\s+'
  + `(?:${TP_PASSIVE_MODIFIER}){0,3}${TP_AGENT_NOUN_E}\\s+`
  + '(?:(?:that|which)\\s+)?'
  + `${TP_AGENT_SUBJECT_ADVERBS}${TP_AGENT_SUBJECT_PAST_VERBS}\\b`,
  'i',
);
/**
 * (ticket a328c93e) Frame (g2) — the ID-ANCHORED variant of the same class:
 * supervisors habitually name the lane by its short id with no determiner
 * ("lane `8abd551a` started its first turn at 19:36Z", "worker 41fd09ed ran
 * three steps"). Frame (c) already owns `<agent noun> <id> <copula>`, and
 * this arm owns the same subject with a completed PAST verb, which (c)'s verb
 * list does not carry. No determiner is required because the id itself is the
 * specificity anchor. True-positive safety: every pinned dispatch phantom is
 * VERB-FIRST ("dispatched session 41fd09ed and it is now running") or
 * first-person — an agent noun BEFORE the verb is never the run's own action
 * (its own work is "I dispatched …", kept by FIRST_PERSON_ACTOR_RE, or the
 * actor-elided verb-first form).
 */
const THIRD_PARTY_AGENT_ID_SUBJECT_ACTION_RE = new RegExp(
  '\\b(?:'
  + `${TP_AGENT_NOUNS}`
  + ')\\s*[`"\'*_]{0,2}\\s*[0-9a-f][0-9a-f-]{5,}\\s*[`"\'*_]{0,2}\\s+'
  + `${TP_AGENT_SUBJECT_ADVERBS}${TP_AGENT_SUBJECT_PAST_VERBS}\\b`,
  'i',
);
/**
 * (ticket a328c93e) LAUNDERING GUARD for frames (g)/(g2) — the ee212347 shape
 * must never ride a determiner-headed state clause to acquittal. A detail
 * that ALSO narrates a VERB-FIRST dispatch act with an object noun
 * ("dispatched a worker; the lane started immediately", "spawned two lanes
 * and the lane started") is a claim about the RUN's own act and belongs to the
 * tier chain — frames (g)/(g2) are skipped for it and the pre-existing
 * ELIDED_ACTOR_COMPLETED_ACTION_RE guard keeps it. Verbs: the dispatch
 * family only (a state clause in the same breath can never launder a claimed
 * dispatch); object: determiner + agent noun, singular or plural.
 */
const TP_ELIDED_DISPATCH_ACT_RE = /\b(?:dispatched|spawned|launched|started|queued|scheduled|steered|messaged)\s+(?:a|an|the|another|two|three|four|five|\d+)\s+(?:new\s+|fresh\s+|second\s+)?(?:lanes?|sessions?|workers?|reviewers?|sub-?sessions?|subagents?|colleagues?)\b/i;
/**
 * (ticket 2580b092) The three extra actor guards for the progressive frame.
 * Present-progressive prose is where an honest first-person actor LIVES
 * ("I am building…"), so frame (e) can never rely on FIRST_PERSON_ACTOR_RE
 * alone (it only catches completed-action verbs):
 *   1. FIRST_PERSON_PROGRESSIVE_RE — "I am building …", "we are already
 *      moving …": the run's own ongoing work, never third-party.
 *   2. FIRST_PERSON_EMBEDDED_ACTOR_RE — "the wiring I just deployed is
 *      running …", "the sweep I started yesterday is running on the lane":
 *      the progressive is anchored to a first-person completed action; the
 *      claim belongs to the tier chain, not this register.
 *   3. ELIDED_ACTOR_COMPLETED_ACTION_RE — "dispatched session X and it is
 *      now running [on the lane]": ANY completed-action verb with an elided
 *      actor keeps the claim for the tier chain — the ee212347 laundering
 *      shape must never ride a location phrase to acquittal. Runs only on
 *      the progressive path (frames a–d already carry their own actor
 *      shapes and have adjudicated pins).
 */
const FIRST_PERSON_PROGRESSIVE_RE = new RegExp(`\\b(?:i|we)\\s+(?:am|are|was|were)\\s+${TP_PROG_ADVERBS}${TP_PROG_PARTICIPLES}\\b`, 'i');
// (ticket 385de869, review F5) The FILLER window is VOICE-GATED: a filler
// that is itself a passive auxiliary ("I was dispatched…", "we were
// assigned…") is a first-person PASSIVE — the run is the PATIENT of the
// machinery's action, never the actor — so it must NOT anchor the claim to
// a first-person completed action. The filler class therefore excludes the
// auxiliary verbs, which admits the guard's adjudicated ACTIVE shapes ("the
// wiring I just deployed", "the sweep I started yesterday") while letting
// frame (f) judge the passive ones. First-person PERFECT actives ("I have
// started …") are unaffected: the shared FIRST_PERSON_ACTOR_RE admits
// "have" as a prefix and keeps them before this guard ever runs.
const FIRST_PERSON_EMBEDDED_ACTOR_RE = /\b(?:I|we)\s+(?:(?!was\b|were\b|am\b|are\b|is\b|get\b|got\b|gets\b|has\b|have\b|had\b)\w+\s+){0,2}(?:dispatched|spawned|launched|started|deployed|registered|placed|wired|installed|sent|steered|messaged|posted|staged|delivered|filed|flagged|scheduled|updated|built|made|ran|renewed|armed)\b/i;
const ELIDED_ACTOR_COMPLETED_ACTION_RE = /\b(?:dispatched|spawned|launched|started|restored|archived|steered|messaged|nudged|queued|forwarded|notified|escalated|relayed|reported|posted|staged|delivered|sent|filed|flagged|scheduled|updated|cancelled|canceled|deployed|registered|placed|wired|installed|renewed|armed|merged|pushed|revived|reinstated|rebooted|resurrected|re-?created|restarted|reopened|resumed|re-?ran|respawned)\b/i;
/**
 * A detail asserting a FIRST-PERSON actor ("I dispatched…", "I've posted…")
 * is never third-party narration — the tier chain judges it on its receipts.
 * This guard keeps the register strictly third-party (fail toward miss in
 * BOTH directions: no first-person drop, no third-party strike).
 */
const FIRST_PERSON_ACTOR_RE = /\bI\s+(?:'ve\s+|have\s+|just\s+|also\s+|now\s+)*(?:sent|steered|messaged|queued|forwarded|nudged|dispatched|spawned|launched|started|restored|archived|posted|staged|delivered|folded|dropped|written|filed|flagged|scheduled|updated|cancelled|canceled)\b/i;
export function thirdPartyGateDisabled(): boolean {
  return process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED === '1';
}
/** Exported for tests: does this claim detail narrate a THIRD-PARTY lane's action/status (tickets bbd8521e + 2580b092)? */
export function isThirdPartyAttributionDetail(detail: string): boolean {
  const d = String(detail ?? '');
  if (FIRST_PERSON_ACTOR_RE.test(d)) return false;
  if (THIRD_PARTY_ATTRIBUTION_FRAMES.some((re) => re.test(d))) return true;
  // (ticket 2580b092) frame (e) PROGRESSIVE LANE STATUS — guarded, last:
  // present-progressive prose is where an honest first-person actor lives,
  // so this frame carries its own three actor guards beyond the shared one.
  if (FIRST_PERSON_PROGRESSIVE_RE.test(d)) return false;
  if (FIRST_PERSON_EMBEDDED_ACTOR_RE.test(d)) return false;
  // (ticket 385de869) frame (f) PASSIVE MACHINERY DISPATCH — BETWEEN the
  // (e) guards: AFTER guards #1/#2 (first-person progressive, embedded
  // first-person actor), which anchor a narration to the run's own work in
  // any voice and must keep winning ("the wiring I just deployed is
  // assigned to the app lane"), and BEFORE guard #3
  // (ELIDED_ACTOR_COMPLETED_ACTION_RE), which matches the incident detail's
  // trailing "(started 16:52 UTC)" in ANY voice and would veto the drop
  // (review F1: only guard #3 needs bypassing — the incident detail carries
  // no I/we). The passive auxiliary is the voice discriminator: every
  // pinned true-positive dispatch phantom is ACTIVE-voice (first-person,
  // elided or emphatic "did dispatch"), none carries a copula/get/
  // has-been before its participle, so none can match this frame.
  if (THIRD_PARTY_PASSIVE_DISPATCH_RE.test(d)) return true;
  // (ticket a328c93e, av-mishap family) frame (g) AGENT-SUBJECT PAST-TENSE
  // ACTION — placed with frame (f), i.e. after guards #1/#2 (first-person
  // progressive, embedded first-person actor: "the lane I dispatched started
  // …" stays with the tier chain) and BEFORE guard #3, whose verb list
  // matches "started" in ANY voice and would veto the drop (same review-F1
  // reasoning as frame (f)). Every pinned dispatch true positive is
  // first-person or actor-elided and none has a determiner-headed agent-noun
  // subject, so none can match; the emphatic "did <base>" shape is excluded
  // structurally (no finite past form directly after the noun).
  // LAUNDERING GUARD: a detail that ALSO narrates a verb-first dispatch ACT
  // ("dispatched a worker; the lane started immediately") is a claim about
  // the RUN's own act — frames (g)/(g2) are skipped so guard #3 below keeps
  // it for the tier chain (the ee212347 doctrine).
  if (!TP_ELIDED_DISPATCH_ACT_RE.test(d)) {
    if (THIRD_PARTY_AGENT_SUBJECT_ACTION_RE.test(d)) return true;
    if (THIRD_PARTY_AGENT_ID_SUBJECT_ACTION_RE.test(d)) return true;
  }
  if (ELIDED_ACTOR_COMPLETED_ACTION_RE.test(d)) return false;
  return THIRD_PARTY_PROGRESSIVE_FRAMES.some((re) => re.test(d));
}
/**
 * Exported for tests: the LLM-lane drop gate — a claim whose verbatim detail
 * narrates third-party lane status is not a this-run action claim, enforcing
 * the extractor prompt's own IGNORE rule (ticket bbd8521e).
 */
export function dropThirdPartyAttributionClaims(claims: ExtractedClaim[]): { kept: ExtractedClaim[]; dropped: ExtractedClaim[] } {
  if (thirdPartyGateDisabled()) return { kept: claims, dropped: [] };
  const kept: ExtractedClaim[] = [];
  const dropped: ExtractedClaim[] = [];
  for (const c of claims) {
    if (isThirdPartyAttributionDetail(String(c.detail ?? ''))) { dropped.push(c); continue; }
    kept.push(c);
  }
  return { kept, dropped };
}

function recordThirdPartyDrops(chatId: string, surface: 'note' | 'args', dropped: ExtractedClaim[]): void {
  if (!dropped.length) return;
  logger.warn(`action-verifier: dropped ${dropped.length} LLM-extracted ${surface} claim(s) narrating THIRD-PARTY lane status — real artifacts owned by other lanes, not this run's actions (ticket bbd8521e): ${dropped.map((c) => `[${c.kind}] ${String(c.id ?? '')} ${c.detail.slice(0, 100)}`).join(' | ')}`, { source: 'action-verifier', chatId });
  void import('./loop-metrics.service').then(({ recordLoopMetric }) => recordLoopMetric({
    kind: 'action_verifier_claim_shape_drop',
    sessionId: chatId,
    value: dropped.length,
    meta: { surface, drops: dropped.slice(0, 6).map((c) => ({ kind: c.kind, reason: 'third_party_attribution', id: String(c.id ?? '').slice(0, 40), detail: c.detail.slice(0, 120) })) },
  })).catch(() => { /* telemetry never blocks */ });
}

const GROUND_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you',
  'has', 'have', 'had', 'was', 'were', 'are', 'its', 'it', 'to', 'of', 'a',
  'an', 'in', 'on', 'at', 'is', 'be', 'been', 'by', 'as', 'or', 'not', 'no',
  'my', 'me', 'i', 'our', 'we', 'their', 'they', 'them', 'his', 'her', 'she',
  'he', 'so', 'if', 'then', 'than', 'but', 'also', 'just', 'now', 'all',
]);

const normalizeForGrounding = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const isGroundContentToken = (t: string): boolean =>
  t.length >= 3
  && !GROUND_STOPWORDS.has(t)
  && !/^\d+$/.test(t) // bare numbers (dates, counts) are weak grounding signals
  && !/^[0-9a-f]{7,}$/.test(t) // uuid-ish ids are validated by the tier chain, not grounding
  && !(/^[0-9a-f]+$/.test(t) && /\d/.test(t)); // hex id FRAGMENTS (230a/452d) — a-f-only words (face/beef/decade) stay

export function groundExtractedClaims(claims: ExtractedClaim[], source: string): GroundingResult {
  const grounded: ExtractedClaim[] = [];
  const dropped: ExtractedClaim[] = [];
  if (!claims.length) return { grounded, dropped };
  const haystack = normalizeForGrounding(source ?? '');
  const windows = String(source ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((w) => new Set(normalizeForGrounding(w).split(' ').filter(Boolean)))
    .filter((s) => s.size > 0);
  for (const claim of claims) {
    const detail = normalizeForGrounding(claim.detail ?? '');
    if (!detail || !haystack) { grounded.push(claim); continue; } // nothing to check — grounding never invents a drop reason
    if (haystack.includes(detail)) { grounded.push(claim); continue; } // verbatim fast path
    const tokens = detail.split(' ').filter(isGroundContentToken);
    if (!tokens.length) { grounded.push(claim); continue; }
    const required = tokens.length <= 4 ? tokens.length : Math.ceil(tokens.length * 0.8);
    const hit = windows.some((wset) => tokens.filter((t) => wset.has(t)).length >= required);
    (hit ? grounded : dropped).push(claim);
  }
  return { grounded, dropped };
}

/**
 * DETERMINISTIC receipt-idiom claim miner (ticket e413c084, 2026-08-29) — the
 * LLM extractor's safety net. The 2026-08-29 supervisor incident: a machine
 * wake's final line claimed "I sent a steer to `3bd727f6` (receipt `6fbb2f9d`)"
 * with ZERO consequential executions that run; the pre-delivery guard's single
 * utility-LLM extraction pass found no claims in the note, so the phantom was
 * DELIVERED — the post-delivery lane's independent extraction caught it 5s
 * later. Same deterministic matcher, two LLM coin flips. This miner recognizes
 * the fleet's first-person receipt-citation idiom with REGEXES (no LLM call)
 * and runs ONLY as a fallback when the LLM extraction found nothing — unioning
 * instead would double-count one truthful action (LLM id-less + miner
 * id-bearing) and false-convict the id-less twin on the consumed slot.
 *
 * Precision guards (a false strike replaces an HONEST note — strictly worse
 * than a miss, which the post-delivery lane still backstops):
 *   - first-person completed-action verbs ONLY ("I sent/steered/dispatched/
 *     scheduled/cancelled/filed…") plus a kind-specific noun — third-party
 *     receipt quotes ("the gateway lane (its receipt 0c888f29)") and plain
 *     observations never mine;
 *   - intention/honesty/refutation markers skip the line (will/planned/about
 *     to, PLANNED — NOT EXECUTED, "never executed", UNVERIFIED, refuted,
 *     struck, phantom, fabricated) — the fleet's own honest-reporting idiom
 *     and verifier-correction quotes must not re-convict. These words also
 *     cause safe MISSES in notes that discuss fabrications — accepted;
 *   - blockquoted lines ('>') are audit quotes (struck-note blocks) — skipped;
 *   - every mined claim carries a SEMANTICALLY-ANCHORED cited id (the token
 *     after "receipt", else the kind's own anchor: target chat for message,
 *     session/schedule/ticket for the rest) — id-less action prose stays
 *     LLM-only. The anchor keeps tier-1 exoneration working for truthful
 *     claims (the cited id lives in the execution's result-envelope ids);
 *     anything unanchored (a ticket id mentioned mid-sentence) is never
 *     mistaken for the action's receipt. Mined ids flow through the SAME tier
 *     chain as LLM claims: own-run execution → dispatch ledger → cross-wake
 *     receipts (≤24h) → DB artifact check — truthful restatements of prior
 *     real actions keep exonerating exactly as they do today.
 */
const MINER_FIRST_PERSON = /\bI\s+(?:have\s+)?(?:just\s+)?(?:also\s+)?(?:sent|steered|messaged|queued|forwarded|nudged|dispatched|started|spawned|launched|scheduled|cancelled|canceled|rescheduled|paused|resumed|updated|filed|flagged)\b/i;
const MINER_EXCLUSION = /\b(?:will|going to|about to|plan|planned|planning|intend|intended|intending|not executed|never executed|did not execute|didn't execute|unverified|refuted|refutation|struck|phantom|phantoms|fabricated|fabrication)\b/i;
const MINER_RECEIPT_ID = /\breceipt\b[^0-9a-z]{0,20}[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/i;
const MINER_HEX_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}$/i;
const MINER_KINDS: Array<{ kind: ClaimKind; verbs: RegExp; nouns: RegExp; idAnchor: RegExp }> = [
  {
    kind: 'message',
    verbs: /\b(?:sent|steered|messaged|queued|forwarded|nudged)\b/i,
    nouns: /\b(?:steer|message|nudge|escalation|digest|summary|directive|reply)\b/i,
    idAnchor: /\b(?:to|into|at)\s+[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/i,
  },
  {
    kind: 'dispatch',
    verbs: /\b(?:dispatched|started|spawned|launched)\b/i,
    nouns: /\b(?:session|worker|lane|task|agent|coder)\b/i,
    idAnchor: /\b(?:session|worker|lane|task|chat|agent)\s+[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/i,
  },
  {
    kind: 'schedule',
    verbs: /\b(?:scheduled|cancelled|canceled|rescheduled|paused|resumed|updated)\b/i,
    nouns: /\b(?:schedule|cadence|sweep|poller|monitor|timer|firing)\b/i,
    idAnchor: /\b(?:schedule|cadence|sweep|poller|monitor|timer)\s+[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/i,
  },
  {
    kind: 'ticket',
    // FILING verbs only — "I reported ticket X closed" is an update_feedback
    // (untracked) spot-check report, never a file_feedback claim.
    verbs: /\b(?:filed|flagged)\b/i,
    nouns: /\b(?:ticket|feedback|issue)\b/i,
    idAnchor: /\b(?:ticket|feedback|issue)(?:\s+id)?\s+[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/i,
  },
];

/** Exported for tests: deterministic first-person receipt-claim mining over a final note. */
export function mineReceiptIdiomClaims(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    if (!MINER_FIRST_PERSON.test(line)) continue;
    if (MINER_EXCLUSION.test(line)) continue;
    for (const rule of MINER_KINDS) {
      if (!rule.verbs.test(line) || !rule.nouns.test(line)) continue;
      const id = (line.match(MINER_RECEIPT_ID)?.[1] ?? line.match(rule.idAnchor)?.[1] ?? '').toLowerCase();
      if (!MINER_HEX_ID.test(id)) continue;
      const key = `${rule.kind}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: rule.kind, detail: line.slice(0, 200), id });
      break; // one claim per line — the first matching rule wins
    }
  }
  return out;
}

/**
 * GATE-ONLY deterministic claim CANDIDATES (N5 reachability fix, 2026-09-26)
 * — what the claim-evidence decision gate is asked about. Superset of
 * mineReceiptIdiomClaims, which stays byte-identical because it is a
 * CONVICTION-capable lane (the LLM-miss fallback whose claims enter the tier
 * chain and can be stamped fabricatedId ⇒ enforced); this miner's output only
 * ever feeds decide() (shadow: telemetry paired with the verifier's verdict;
 * act, designed-not-enabled: the stand-in note claims — which then face the
 * same tier chain as any claim).
 *
 * WHY a second miner: the gate shipped fed by the first-person miner alone
 * and recorded ZERO decision rows all-time (verified 2026-09-26 on deploy
 * bff9033e: 16 wake_delivered rows, 3 verifier guard rows, 0 claim_evidenced
 * rows). Over the 60 most recent supervisor wake notes (15 chats, 48 h) the
 * first-person miner mined 0 claims in 0 notes — the fleet does not write
 * "I sent … to <id>"; it writes tool-name receipt lines and passive report-
 * up idioms. The gate's `if (!claims.length) return null` therefore held on
 * every wake and decide() was never reached. This miner recognises those
 * idioms, in order per line (first match wins, one claim per line, deduped
 * per kind|id, same line floor / blockquote skip / honesty-register
 * exclusion as the first-person miner):
 *   0. the first-person miner's own rule (byte-identical output for the lines
 *      it already covers — the N5 fixtures keep their positions);
 *   a. a TOOL-NAME receipt line — a KIND_TOOLS tool name followed within a
 *      few chars (→ : — - ( whitespace) by an id: "- send_chat_message →
 *      7d1f3308 — ack/steer …", "send_chat_message 69c724f9 — Fleet delta"
 *      (kind = the tool's kind — the most explicit deed claim the fleet
 *      writes);
 *   b. a completed-action VERB (any grammatical person) with a `receipt <id>`
 *      anchor on the same line — "Relay sent to the inference supervisor …
 *      — receipt 9cb2cebf", "Reported delta to Fleet Supervisor (receipt
 *      74f01852, queued)", "Steered harvest lane 11449a0a … — receipt
 *      2d3a19be" (kind by verb table; the receipt id is the claim's own
 *      anchor, which receiptsToActions exposes as ids.receiptId);
 *   c. the first-person rule's verb + kind-noun + kind-anchor WITHOUT the
 *      first-person requirement — "Dispatched session 3e1cae6f …" (the
 *      generic `started` verb is dropped here: "deploy started on lane X" is
 *      not a dispatch claim).
 */
const GATE_TOOL_KIND: Record<string, ClaimKind> = Object.fromEntries(
  (Object.entries(KIND_TOOLS) as Array<[ClaimKind, string[]]>).flatMap(([kind, tools]) => tools.map((t) => [t, kind] as const)),
);
const GATE_TOOL_RECEIPT_LINE = new RegExp(
  `\\b(${Object.keys(GATE_TOOL_KIND).join('|')})\\b[^0-9a-z\\n]{0,24}[\`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\\b`,
  'i',
);
const GATE_RECEIPT_VERBS: Array<{ kind: ClaimKind; verbs: RegExp }> = [
  { kind: 'message', verbs: /\b(?:sent|steered|messaged|queued|forwarded|nudged|relayed|reported|notified|escalated|report(?:ed)?-up)\b/i },
  { kind: 'dispatch', verbs: /\b(?:dispatched|spawned|launched)\b/i },
  { kind: 'schedule', verbs: /\b(?:scheduled|cancelled|canceled|rescheduled|paused|resumed|re-?armed)\b/i },
  { kind: 'ticket', verbs: /\b(?:filed|flagged)\b/i },
];
const GATE_KINDS_NO_PERSON: Array<{ kind: ClaimKind; verbs: RegExp; nouns: RegExp; idAnchor: RegExp }> = MINER_KINDS.map((rule) =>
  rule.kind === 'dispatch' ? { ...rule, verbs: /\b(?:dispatched|spawned|launched)\b/i } : rule,
);

/** Exported for tests: the gate's deterministic claim candidates over a final note (see the header above). */
export function mineGateClaimCandidates(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const push = (kind: ClaimKind, id: string, line: string): boolean => {
    const key = `${kind}|${id}`;
    if (seen.has(key)) return true; // the line is spoken for — still one claim per line
    seen.add(key);
    out.push({ kind, detail: line.slice(0, 200), id });
    return true;
  };
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    if (MINER_EXCLUSION.test(line)) continue;
    // 0. the first-person miner's rule, verbatim.
    if (MINER_FIRST_PERSON.test(line)) {
      let matched = false;
      for (const rule of MINER_KINDS) {
        if (!rule.verbs.test(line) || !rule.nouns.test(line)) continue;
        const id = (line.match(MINER_RECEIPT_ID)?.[1] ?? line.match(rule.idAnchor)?.[1] ?? '').toLowerCase();
        if (!MINER_HEX_ID.test(id)) continue;
        matched = push(rule.kind, id, line);
        break;
      }
      if (matched) continue;
    }
    // a. tool-name receipt line.
    const toolLine = line.match(GATE_TOOL_RECEIPT_LINE);
    if (toolLine) {
      const id = toolLine[2].toLowerCase();
      if (MINER_HEX_ID.test(id)) { push(GATE_TOOL_KIND[toolLine[1].toLowerCase()], id, line); continue; }
    }
    // b. completed-action verb + receipt anchor (any person).
    const receiptId = (line.match(MINER_RECEIPT_ID)?.[1] ?? '').toLowerCase();
    if (MINER_HEX_ID.test(receiptId)) {
      const rule = GATE_RECEIPT_VERBS.find((r) => r.verbs.test(line));
      if (rule) { push(rule.kind, receiptId, line); continue; }
    }
    // c. verb + kind noun + kind anchor, no person required.
    for (const rule of GATE_KINDS_NO_PERSON) {
      if (!rule.verbs.test(line) || !rule.nouns.test(line)) continue;
      const id = (line.match(rule.idAnchor)?.[1] ?? '').toLowerCase();
      if (!MINER_HEX_ID.test(id)) continue;
      push(rule.kind, id, line);
      break;
    }
  }
  return out;
}

/**
 * (ticket 5ad80b27) KIND-ACTION IDIOM — the deterministic "does the claim's
 * DETAIL actually NARRATE a <kind> action" check backing the own-artifact
 * kind-consistency tier in findPhantomClaims. The residual phantom class the
 * 587e9d64 grounding fix does NOT cover (its sighting 2): the note's prose is
 * VERBATIM-TRUE and the run's receipts show the narrated actions really ran
 * (gmail_search / todo_update — NON-claim-kind tools), but the LLM extractor
 * mis-labelled the claim's KIND ([dispatch]) and attached an unrelated real
 * own-run artifact id (the generated-FILE row). Grounding passes (the detail
 * is verbatim), so the tier chain judged kind+id — no dispatch receipts, no
 * crossmodel_chats row — and appended a FALSE correction to an honest note.
 *
 * The discriminator between that shape and a TRUE phantom ("dispatched
 * session <own commit sha>" — review P1's id-splice): whether the DETAIL
 * itself narrates the claimed kind's action. Two clause-local shapes count:
 *   (a) a kind verb within 60 chars BEFORE a kind noun (the fleet's
 *       first-person idiom is verb-first — DISPATCH_RECEIPT_VERB_RE's shape);
 *   (b) a kind noun within 24 chars BEFORE a kind verb (the adjacent
 *       noun-fronted idiom: "the session I dispatched", "the schedule I
 *       cancelled" — review F1: without it a false claim citing a REAL
 *       own-run id laundered by fronting the noun).
 * Neither crosses `.`/`;`/newline. The 24-char window is load-bearing: the
 * sighting-2 detail ("re-ran the Gmail sweep on all four accounts, and
 * updated the todo ledger") carries its schedule noun ("sweep") exactly 27
 * chars before its schedule verb ("updated") — a wider noun-first window
 * would misread the trap as a schedule narration and re-convict; 24 keeps it
 * clear while every natural noun-fronted claim ("the X I <verb>ed") binds at
 * ~3 chars.
 *
 * Verb lists are SUPERSETS of the receipt-idiom miner's per-kind verbs, so a
 * mined claim keeps its idiom whenever its verb and noun sit in the SAME
 * clause (the miner's first-person shape). Accepted residual (fail toward
 * miss, the 587e9d64 doctrine — review F2): a mined/LLM line that separates
 * verb from noun across a sentence boundary, or narrates with a bare pronoun
 * ("I dispatched it"), reads as NO narration and exonerates when the own-
 * artifact anchor holds — the post-delivery lane and the note's own prose
 * backstop those.
 */
const KIND_ACTION_VERBS: Record<ClaimKind, string> = {
  dispatch: 're-?dispatch(?:ed|ing)?|dispatch(?:ed|ing)?|start(?:ed|ing)?|spawn(?:ed|ing)?|launch(?:ed|ing)?|kick(?:ed|ing)?\\s+off|track(?:ed|ing)?|creat(?:ed|ing)',
  message: 're-?sent|sent|steered|messaged|queued|forwarded|nudged|posted|delivered|replied',
  schedule: 're-?scheduled|scheduled|cancelled|canceled|rescheduled|paused|resumed|updated|re-?armed|renewed',
  ticket: 're-?filed|filed|flagged',
};
const KIND_ACTION_NOUNS: Record<ClaimKind, string> = {
  dispatch: 'start_coding_session|dispatch_platform_task|sub-sessions?|sessions?|workers?|lanes?|tasks?|agents?|coders?',
  message: 'send_chat_message|steers?|messages?|nudges?|escalations?|digests?|summar(?:y|ies)|directives?|repl(?:y|ies)|check-?ins?|reminders?',
  schedule: 'schedule_message|update_schedule|cancel_schedule|schedules?|cadences?|sweeps?|pollers?|monitors?|timers?|firings?',
  ticket: 'file_feedback|tickets?|feedback|issues?',
};
const KIND_ACTION_IDIOM: Record<ClaimKind, RegExp> = Object.fromEntries(
  (Object.keys(KIND_ACTION_VERBS) as ClaimKind[]).map((k) => [
    k,
    new RegExp(
      `\\b(?:${KIND_ACTION_VERBS[k]})\\b[^.;\\n]{0,60}?\\b(?:${KIND_ACTION_NOUNS[k]})\\b`
      + `|\\b(?:${KIND_ACTION_NOUNS[k]})\\b[^.;\\n]{0,24}?\\b(?:${KIND_ACTION_VERBS[k]})\\b`,
      'i',
    ),
  ]),
) as Record<ClaimKind, RegExp>;

/** Exported for tests: does the claim detail narrate a <kind> action in the fleet's verb→noun idiom? */
export function claimNarratesKindAction(kind: ClaimKind, detail: string): boolean {
  return KIND_ACTION_IDIOM[kind].test(String(detail ?? ''));
}

/**
 * EVIDENCE-CITATION lane (ticket c1cbe6a2, 2026-08-29) — the coverage gap the
 * 12:43Z supervisor incident exposed: "Verified the Nightly claim-discipline
 * run fired and closed clean … schedule re-armed for 14:08Z (msg e6bf2fda)"
 * cited a message-row receipt that never existed (fresh schedule-list +
 * transcript pulls refuted both halves). Both claim lanes missed it BY
 * DESIGN: the LLM extractor is instructed to ignore third-party observations,
 * and the receipt-idiom miner requires a first-person action verb — a
 * fabricated EVIDENCE citation inside verification/observation prose is
 * neither. This pass deterministically mines `msg <hex-id>` receipt citations
 * and DB-checks the cited MESSAGE ROW's existence: an existing row exonerates,
 * a missing row convicts. Existence, not recency — honest notes cite days-old
 * real receipts. This is NOT the review-C5 target-chat case (chat existence
 * proves nothing about a send), but the binding is deliberately weak
 * (review F2): existence proves A send created SOME row — it cannot prove the
 * row evidences the claimed event, so a fabricator citing a REAL but
 * unrelated msg-row id (e.g. from a send_chat_message result envelope)
 * launders through. That is a follow-up (content/chat binding); what this
 * lane catches is the incident shape — INVENTED ids that name no row at all.
 *
 * Precision guards (a false strike replaces an HONEST note — strictly worse
 * than a miss, which the post-delivery lane backstops):
 *   - blockquoted lines ('>') skipped — audit quotes of struck notes;
 *   - the action miner's honesty/refutation markers PLUS the absence idioms
 *     refutation prose uses ("absent", "no such", "never existed",
 *     "not found", "missing"…) skip the line — a note DISCUSSING a phantom
 *     citation must not re-convict (safe misses accepted, same as the miner);
 *   - ids already carried by an action claim (either extraction surface) are
 *     skipped — the tier chain judged them; no double-processing;
 *   - DB error → the candidate is skipped (fail toward MISS — a deliberate
 *     asymmetry with citedArtifactExists' fail-toward-phantom: an action
 *     claim is a positive first-person assertion that must be provable, but
 *     convicting an unverifiable citation during a DB blip would replace
 *     honest notes).
 */
/**
 * LIST-FORM citations (rollout-watch tick 21, 2026-09-15). Every evidence
 * miner keys on "<noun> <id>" and mined only the FIRST id after the noun — the
 * b216475a pin even recorded that under-breadth as accepted scope. The Fleet
 * Supervisor's 20:42Z and 20:53Z notes then DELIVERED "(msgs 469d1c90,
 * fbe61917, c6f93b25; chats 59cb243f, f31cb903)" and "(receipt 949c1f4b)" —
 * every id invented, none struck. This pre-pass rewrites a noun + comma /
 * slash / "and" list into repeated singular citations ("msg a, msg b, msg c;
 * chat x, chat y") so each miner's singular regex sees every id; `detail`
 * still quotes the ORIGINAL line. `;` is a family boundary, never a list
 * separator. Singular citations pass through unchanged. Pure; exported for
 * tests.
 */
/**
 * SENTENCE-SCOPED exclusion (rollout-watch tick 22, 2026-09-16). Every citation
 * miner tested its honesty / refutation / intent register against the WHOLE
 * line — right for the short lines the lanes were built on, wrong for the
 * 1,000-char bullet paragraphs supervisors actually write: the fleet's 01:39Z
 * "chat d7138361" (nowhere) survived because "stale" sat in the NEXT sentence
 * of the same line, and spark's 01:14Z "chat 1565dd16" (a wrong id for the
 * kernel-opt lane) because "plan 7/7" — the INTENT register's `plan` — sat in
 * the sentence before. The register now has to sit in the citation's own
 * SENTENCE: the stretch between sentence boundaries (". " followed by a
 * capital / digit / markdown opener, a newline, or a table " | ") around the
 * match. Dashes and semicolons are NOT boundaries — every honest retraction
 * the lanes protect ("…against crossModelMessage — zero rows", "goal a, goal
 * b — did not happen either", "(cited id X — does not exist; …)") keeps its
 * register inside the sentence. Exported for tests.
 */
const SENTENCE_BOUNDARY_RE = /\.\s+(?=[A-Z0-9*\[(\-•"“_`])|\n|\s\|\s/g;
export function citationSentence(text: string, index: number): string {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_BOUNDARY_RE)) {
    const at = m.index ?? 0;
    if (at < index) start = at + m[0].length;
    else { end = at; break; }
  }
  return text.slice(start, end);
}
const clauseExcluded = (text: string, index: number, registers: RegExp[]): boolean => {
  const sentence = citationSentence(text, index);
  return registers.some((re) => { re.lastIndex = 0; return re.test(sentence); });
};

const CITATION_ID_SRC = '[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}';
const CITATION_LIST_LABEL: Array<[RegExp, string]> = [
  [/^(?:msgs?|messages?)$/i, 'msg'], [/^chats?$/i, 'chat'], [/^sessions?$/i, 'session'], [/^lanes?$/i, 'lane'],
  [/^(?:scheds?|schedules?)$/i, 'sched'], [/^tickets?$/i, 'ticket'], [/^goals?$/i, 'goal'], [/^todos?$/i, 'todo'],
  [/^receipts?$/i, 'receipt'],
];
const CITATION_LIST_RE = new RegExp(
  `\\b(msgs?|messages?|chats?|sessions?|lanes?|scheds?|schedules?|tickets?|goals?|todos?|receipts?)\\b(?:\\s+ids?)?[\\s:]*`
  + `([\`"']?${CITATION_ID_SRC}[\`"']?(?:(?:\\s*(?:,|/|&|\\+|\\|)\\s*(?:and\\s+)?|\\s+and\\s+)[\`"']?${CITATION_ID_SRC}[\`"']?)+)(?![0-9a-z])`,
  'gi',
);
const CITATION_LIST_NOUN_AFTER_RE = /^\s*[`"']?\s*(?:msgs?|messages?|chats?|sessions?|lanes?|scheds?|schedules?|tickets?|goals?|todos?|receipts?)\b/i;
export interface CitationListExpansion {
  text: string;
  /** Lower-cased ids whose kind label was INFERRED from the list noun. */
  inferred: Set<string>;
}
export function expandCitationListsDetailed(line: string): CitationListExpansion {
  const inferred = new Set<string>();
  const text = String(line ?? '').replace(CITATION_LIST_RE, (match, noun: string, list: string, offset: number, whole: string) => {
    const label = CITATION_LIST_LABEL.find(([re]) => re.test(noun))?.[1] ?? noun.toLowerCase();
    const ids = list.match(new RegExp(CITATION_ID_SRC, 'gi')) ?? [];
    // (tick 24) "<noun> a, <laneId> <noun> b": an id that itself LABELS the
    // next citation ("619a1241 msg 619f11f9") is not a list member — re-emit
    // it bare so no lane mines it under the wrong noun.
    const after = String(whole).slice(offset + String(match).length);
    let tail = '';
    if (ids.length > 1 && CITATION_LIST_NOUN_AFTER_RE.test(after)) tail = `, ${ids.pop()}`;
    ids.slice(1).forEach((id) => inferred.add(id.toLowerCase()));
    return ids.map((id) => `${label} ${id}`).join(', ') + tail;
  });
  return { text, inferred };
}
export function expandCitationLists(line: string): string {
  return expandCitationListsDetailed(line).text;
}
/**
 * (tick 24) Kind-agnostic fallback for a list-INFERRED id whose kind probe
 * missed: the note never asserted the kind, so a real row of ANY artifact
 * kind exonerates. Explicitly labelled citations keep the mislabel-convicts
 * doctrine (3ed139cd rule 5). Probe failures fail toward EXISTS.
 */
async function inferredIdExists(claim: ExtractedClaim): Promise<boolean> {
  if (claim.listInferred !== true || !claim.id) return false;
  return citedIdExistsAnywhere(String(claim.id)).catch(() => true);
}
// RECEIPT-CITATION regex (tick 21): a run_tool_receipts id cited as evidence
// ("its monitor passed another clean check (receipt 949c1f4b)"). Real receipt
// ids reach a note only by copying a tool result envelope's receiptId — which
// puts the full id in this run's tool-output haystack (exonerated before any
// probe); an id in neither the haystack nor run_tool_receipts was invented.
const EVIDENCE_RECEIPT_CITATION = /\breceipts?\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
// BARE CHAT/SESSION/LANE-CITATION regex (tick 21): the session-ref lane mines
// only dispatch-receipt and owner-chat-ref IDIOMS (verbs/status tails), so a
// bare observation citation — "chats 59cb243f, f31cb903" — reached no lane.
// Existence-probed against crossmodel_chats + coding_sessions like the
// session lane; the deletion/failure register (SESSION_REF_EXCLUSION_RE) and
// quoted spans skip exactly as there.
const EVIDENCE_CHAT_CITATION = /\b(?:chat|session|lane)\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
const EVIDENCE_MSG_CITATION = /\bmsg\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
// SCHEDULE-CITATION sibling regex (ticket 5448a836, 2026-08-30): the wake
// preamble's evidence-list rule (machine-wake.ts rule 6) sanctions 'sched' as
// the citation label for a list_schedules-sourced fact, so fabricated schedule
// ids need the same existence-checked conviction the msg lane gives fabricated
// msg ids. The incident: the supervisor observed the Mac-installer monitor's
// runs-count in list_schedules (real row 08ae015c, firing #2) and cited an
// invented [msg:fa6942ce] for it AND an invented schedule id 1fd6a55f — the
// msg lane struck the first; the schedule id sailed through every lane
// un-audited. Word-boundary keyed on 'sched'/'schedule' SINGULAR ONLY:
// "scheduled firing"/"Schedules" carry no following id and never mine; the
// fleet's real idioms ("schedule `2ffa817e`", "once-schedule `104d0f81`",
// "[sched:08ae015c]") mine and exonerate on row existence.
const EVIDENCE_SCHED_CITATION = /\bsched(?:ule)?\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
// Post-id label form ("`1fbe4800…` (sched) active") — the fleet contract's
// parenthesized label idiom (ticket ca153ef8): the session/chat-ref lane now
// SKIPS (sched)-labeled ids (they are evidence citations, not dispatch
// receipts), so THIS lane must mine them or a fabricated schedule id in the
// taught form would escape every audit lane (adversarial review F2).
const EVIDENCE_SCHED_CITATION_POST_ID = /[`"']?\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b[`"']?\s*\((?:sched|schedule)\)/gi;
// GOAL/TODO-CITATION sibling regexes (ticket 3ed139cd, 2026-09-13): machine-
// wake.ts rule 6 TEACHES 'goal'/'todo' as citation labels ("todo/goal ids from
// todo_list/goal_list/goal_get … label each cited id with the tool-family it
// came from") — but no lane existence-checked them, the exact gap the
// supervisor's phantom rename receipts sailed through: its 11:57 AM EDT owner
// reply claimed "I renamed all five into plain language today" citing goal ids
// 4dc6b1d1 / 48c93a9e / 8ec1f4cd / 8e489f12 / 81c9bc8e plus "todo 078bbac3
// (unblocked)" — all six return "Goal not found"/"Todo not found" from the
// platform's own by-id resolvers, ZERO account-wide rows carry the claimed
// titles, and a control goal id resolved fine (the ids simply never existed).
// The phantom ids then FOSSILIZED: 8ec1f4cd was re-cited in the 16:14Z note.
// Word-boundary keyed on the singular AND plural label: the fleet's real
// idioms ("goal e1f27829 done", "goals 97922708/3da1b307", "todo `b67d316d`
// (unblocked, board read-back)", "[goal:3f87efe1]") mine and exonerate on row
// existence; the tool names goal_get/goal_list/todo_get/todo_list NEVER mine
// ('_' is a word char — no boundary after 'goal'/'todo'). Bare series tails
// ("goal A done · B done · C done") deliberately do NOT mine: rule 6 teaches
// one label per id, and an unlabeled bare-hex grab would false-mine commit
// shas — under-broad is the fail-safe direction (the post-delivery lane
// backstops), same doctrine as the session-ref lane's plural-list exemption.
const EVIDENCE_GOAL_CITATION = /\bgoals?\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
const EVIDENCE_TODO_CITATION = /\btodos?\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
// Post-id label forms ("`3f87efe1` (goal) active") — the ca153ef8 parenthesized
// idiom; this lane must mine them or a fabricated goal/todo id in the taught
// form would escape every audit lane.
const EVIDENCE_GOAL_CITATION_POST_ID = /[`"']?\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b[`"']?\s*\(goals?\)/gi;
const EVIDENCE_TODO_CITATION_POST_ID = /[`"']?\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b[`"']?\s*\(todos?\)/gi;
// Lane-local honesty-register extension (NOT added to the shared
// EVIDENCE_EXCLUSION — the msg/sched/session lanes stay byte-identical, one
// concern per PR): the goal/todo class's canonical REFUTATION vocabulary is
// the resolve register — the supervisor's actual 17:05Z retraction read
// "cited five goal-rename receipts that don't resolve", its 16:59Z retraction
// "the five goal renames I reported yesterday did NOT happen", and ticket
// 3ed139cd itself says "unresolvable". Without these, an honest retraction or
// audit note quoting the phantom ids in labeled form would re-convict — a
// false strike replaces an HONEST note, the worst outcome class (review
// doctrine of the msg lane, F1).
const GOAL_TODO_EXCLUSION_EXTRA = /\b(?:unresolv\w*|does(?:\s+not|n't)\s+resolve|did(?:\s+not|n't)\s+resolve|do(?:\s+not|n't)\s+resolve|can(?:\s+not|n't)\s+resolve|could(?:\s+not|n't)\s+resolve|never\s+resolved?|will\s+not\s+resolve|won't\s+resolve|did(?:\s+not|n't)\s+happen|never\s+happened?)\b/i;
// TICKET-CITATION sibling regexes (ticket b216475a, 2026-09-13 — the Fleet
// Supervisor's agent-anchored notes cited four FABRICATED feedback-ticket ids
// (1322de9e / 1f7cadb1 / 6cec4aa1 / 3562a3d4 — none exist) in a "tickets
// filed"/"Receipts: tickets <id>" receipts idiom that matched NOTHING: the msg
// and sched lanes key on their own labels, and both action extractors miss
// passive "tickets filed" prose). Same shape as the msg/sched lanes:
// word-boundary keyed on 'ticket'/'tickets', capturing the FIRST id of a
// plural list ("tickets 1322de9e, 1f7cadb1" mines 1322de9e — accepted scope:
// bare list ids after the first stay unmined, under-broad is the fail-safe
// direction, same as the schedule lane's plural-list choice).
const EVIDENCE_TICKET_CITATION = /\btickets?\b[\s:]*[`"']?([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi;
// Post-id label form ("`6cec4aa1` (ticket)", "`6cec4aa1` (feedback)") — the
// fleet contract's parenthesized label idiom, same as the sched lane's
// POST_ID sibling: a fabricated ticket id in the taught form must not escape
// every audit lane.
const EVIDENCE_TICKET_CITATION_POST_ID = /[`"']?\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b[`"']?\s*\((?:ticket|feedback)\)/gi;
// (review F1) The exclusion must cover the fleet's SEARCH-FAILURE register
// too — refutation/audit prose most often says "I looked and it isn't there"
// ("pulls did not find the cited msg … row", "still no row", "zero rows",
// "could not locate", "no evidence of", "treating the claim as void", and the
// ticket-closure idiom "closed as a false positive — the citation pointed at
// nothing"). Adversarial review drove the pre-fix function against 8 such
// honest lines: 7 mined and WOULD have been convicted — a false strike
// replaces an HONEST note, the worst outcome class this lane guards against.
// (review N1 + round-3 M1–M4) The MESSAGE-NATIVE absence verbs are the
// canonical honest register for refuting a message receipt specifically:
// "never sent", "not delivered", "never landed/received/arrived" AND their
// contraction forms ("wasn't sent", "didn't arrive" — matched via `'t`),
// "failed to arrive", "never showed up", "turned up empty", "came back
// empty/negative", "ghost", "stale", "unconfirmed", "bogus", "fake",
// "doesn't check out", "without … ever materializing", and the
// citation-instruction bigram ("avoid/refrain from/skip(ped) citing" — keyed
// on the BIGRAM so an innocent bare "avoid" no longer over-excludes). All
// verified to false-mine pre-fix (and "sent"/"delivered" even pass the
// non-supervisor keyword gate, so the honest note reaches the matcher).
// Multi-word alternatives use \s+ — double-spaced prose still matches.
// (ticket 5a784ec2 sighting 2, 2026-09-15) The EXISTENCE-REFUTATION register
// in its plural/collective forms: the fleet supervisor's honest cross-check
// line — "the parallel draft … cited sched 8b59cff6 / goals 60954734,
// cf4cf53b — none of those ids exist" — mined and CONVICTED the quoted ids
// pre-fix (only the singular "does not exist" was covered) — a false strike
// replacing audit prose, the worst outcome class (review F1 above). Added:
// "do not/don't exist" (the plural sibling; VANISHED_EXCLUSION_RE already
// treats it as honesty register) and "none of those/these/the/them … exist".
// Shared by all four citation lanes (msg/sched/goal-todo/ticket) — one
// source of truth, same doctrine as GOAL_TODO_EXCLUSION_EXTRA's lane-local
// resolve register.
const EVIDENCE_EXCLUSION = /\b(?:will|going to|about to|plan(?:ned|ning)?|intend(?:ed|ing)?|not executed|never executed|did not execute|didn't execute|unverified|unconfirmed|refut\w*|struck|phantom(?:s)?|fabricat\w*|invented|mint\w*|absent|nonexistent|non-existent|no such|not found|never existed|does not exist|doesn't exist|do(?:\s+not|n't)\s+exist|none\s+of\s+(?:those|these|the|them)\b[^.\n]{0,60}?\bexist\w*|missing|bogus|fake|did(?: not|n't)\s+(?:find|locate)|could(?: not|n't)\s+(?:find|locate)|no\s+(?:row|rows|record|trace|sign|evidence|match)\b|zero\s+rows|nothing\s+(?:matching|found)\b|void(?:ed)?|false[ -]positive|(?:'t|not|never)\s+(?:sent|send|delivered|deliver|landed|land|received|receive|arrived|arrive)\b|failed\s+to\s+(?:arrive|land|send|deliver|show)\w*|never\s+showed\s+up|turned\s+up\s+empty|came\s+back\s+(?:empty|negative)|ghost\w*|stale|does(?:\s+not|n't)\s+check\s+out|did(?:\s+not|n't)\s+check\s+out|ever\s+materializ\w*|avoid\w*\s+(?:\w+\s+){0,3}cit\w*|refrain\s+from\s+cit\w*|skip(?:ped|ing)?\s+cit\w*)\b/i;

/** Exported for tests: deterministic `msg <id>` evidence-citation mining over a final note. */
export function mineEvidenceCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    for (const m of expanded.matchAll(EVIDENCE_MSG_CITATION)) {
      const id = m[1].toLowerCase();
      if (!MINER_HEX_ID.test(id) || seen.has(id) || clauseExcluded(expanded, m.index ?? 0, [EVIDENCE_EXCLUSION])) continue;
      seen.add(id);
      out.push({ kind: 'message', detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
    }
  }
  return out;
}

/** Exported for tests: deterministic `sched <id>` evidence-citation mining over a final note (ticket 5448a836) — the msg lane's exact discipline (line floor, blockquote skip, honesty/refutation-register exclusion, dedupe). */
export function mineScheduleCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    for (const re of [EVIDENCE_SCHED_CITATION, EVIDENCE_SCHED_CITATION_POST_ID]) {
      re.lastIndex = 0;
      for (const m of expanded.matchAll(re)) {
        const id = m[1].toLowerCase();
        if (!MINER_HEX_ID.test(id) || seen.has(id) || clauseExcluded(expanded, m.index ?? 0, [EVIDENCE_EXCLUSION])) continue;
        seen.add(id);
        out.push({ kind: 'schedule', detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
      }
    }
  }
  return out;
}

/** Exported for tests: deterministic `goal <id>`/`todo <id>` evidence-citation mining over a final note (ticket 3ed139cd) — the sched lane's exact discipline (line floor, blockquote skip, honesty/refutation-register exclusion PLUS the lane-local resolve register, dedupe per kind|id so the same hex cited under both labels is checked against BOTH stores). */
export function mineGoalTodoCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const families: Array<{ kind: 'goal' | 'todo'; res: RegExp[] }> = [
    { kind: 'goal', res: [EVIDENCE_GOAL_CITATION, EVIDENCE_GOAL_CITATION_POST_ID] },
    { kind: 'todo', res: [EVIDENCE_TODO_CITATION, EVIDENCE_TODO_CITATION_POST_ID] },
  ];
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    for (const { kind, res } of families) {
      for (const re of res) {
        re.lastIndex = 0;
        for (const m of expanded.matchAll(re)) {
          const id = m[1].toLowerCase();
          if (!MINER_HEX_ID.test(id) || clauseExcluded(expanded, m.index ?? 0, [EVIDENCE_EXCLUSION, GOAL_TODO_EXCLUSION_EXTRA])) continue;
          const key = `${kind}|${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ kind, detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
        }
      }
    }
  }
  return out;
}

/** Exported for tests: deterministic `ticket <id>` evidence-citation mining over a final note (ticket b216475a) — the sched lane's exact discipline (line floor, blockquote skip, honesty/refutation-register exclusion, both label forms, dedupe). */
export function mineTicketCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    for (const re of [EVIDENCE_TICKET_CITATION, EVIDENCE_TICKET_CITATION_POST_ID]) {
      re.lastIndex = 0;
      for (const m of expanded.matchAll(re)) {
        const id = m[1].toLowerCase();
        if (!MINER_HEX_ID.test(id) || seen.has(id) || clauseExcluded(expanded, m.index ?? 0, [EVIDENCE_EXCLUSION])) continue;
        seen.add(id);
        out.push({ kind: 'ticket', detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
      }
    }
  }
  return out;
}

/** Exported for tests: deterministic `receipt <id>` evidence-citation mining (tick 21, 2026-09-15) — the ticket lane's exact discipline (line floor, blockquote skip, honesty/refutation-register exclusion, list expansion, dedupe). */
export function mineReceiptCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    EVIDENCE_RECEIPT_CITATION.lastIndex = 0;
    for (const m of expanded.matchAll(EVIDENCE_RECEIPT_CITATION)) {
      const id = m[1].toLowerCase();
      if (!MINER_HEX_ID.test(id) || seen.has(id) || clauseExcluded(expanded, m.index ?? 0, [EVIDENCE_EXCLUSION])) continue;
      seen.add(id);
      out.push({ kind: 'receipt', detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
    }
  }
  return out;
}

/**
 * Exported for tests: deterministic BARE `chat|session|lane <id>` evidence-
 * citation mining (tick 21, 2026-09-15). Skips exactly what the session-ref
 * lane skips (its exclusion register covers deletion/failure prose — "chat X
 * was deleted", "lane Y failed to start" — plus quoted spans) and never
 * double-mines an id the session-ref lane's idioms already own.
 */
// First-person ACTION narration ("I dispatched three workers (sessions a, b,
// c)") is the action tiers' business — the LLM extractor + receipt-idiom
// miner judge it against this run's executions with the slot budget. The bare
// chat lane audits OBSERVATION citations only; a first-person action line
// skips here so the tier chain's verdict is never second-guessed by an
// existence probe (the action-verifier.test.ts clean-path pins).
// (tick 22) Completed-action FORMS only: the bare stems "arm"/"fil"/"open"
// matched "Arm B", "final" and "OPEN" in ordinary observation prose.
const FIRST_PERSON_ACTION_RE = /\b(?:I|we|I've|we've|I'd|we'd|I'm|we're)\b[^.\n;]{0,48}?\b(?:dispatch(?:ed|ing)?|start(?:ed|ing)?|spawn(?:ed|ing)?|launch(?:ed|ing)?|kick(?:ed|s)?\s+off|creat(?:ed|ing)|open(?:ed|ing)|sent|send(?:ing)?|(?:re-?)?arm(?:ed|ing)|fil(?:ed|ing)|assign(?:ed|ing)?|steer(?:ed|ing)?|nudg(?:ed|ing)|messag(?:ed|ing)|hand(?:ed)?\s+off|schedul(?:ed|ing))\b/i;
export function mineChatCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  // Ids the session-ref lane's idioms or the vanished-artifact lane already
  // own are never double-mined here (one conviction per id, one owner).
  const seen = new Set<string>([
    ...mineSessionChatReferences(note).map((c) => String(c.id ?? '').toLowerCase()),
    ...mineVanishedArtifactCitations(note).map((c) => String(c.id ?? '').toLowerCase()),
  ]);
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    if (FIRST_PERSON_ACTION_RE.test(line)) continue;
    const { text: expanded, inferred } = expandCitationListsDetailed(line);
    EVIDENCE_CHAT_CITATION.lastIndex = 0;
    for (const m of expanded.matchAll(EVIDENCE_CHAT_CITATION)) {
      const id = m[1].toLowerCase();
      if (!MINER_HEX_ID.test(id) || seen.has(id) || insideQuotedSpan(expanded, m.index ?? 0)) continue;
      if (clauseExcluded(expanded, m.index ?? 0, [SESSION_REF_EXCLUSION_RE, EVIDENCE_EXCLUSION])) continue;
      seen.add(id);
      out.push({ kind: 'chat', detail: `[evidence citation] ${line.slice(0, 180)}`, id, ...(inferred.has(id) ? { listInferred: true } : {}) });
    }
  }
  return out;
}

/**
 * Existence-only check for a cited RECEIPT ROW (tick 21) — run_tool_receipts,
 * prefix-matched, fail toward MISS like every sibling probe.
 */
export async function citedReceiptRowExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.runToolReceipt.findFirst({ where, select: { id: true } });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * The receipt-citation lane's matcher (tick 21, 2026-09-15) — the ticket
 * lane's shape: mine, drop ids carried by an action claim, exonerate ids in
 * this run's tool OUTPUTS (a receipt id honestly copied from a result envelope
 * is ALWAYS there), exonerate rows that exist, convict the rest. No near-miss
 * bucket: receipt ids are never something a lane "meant".
 */
export async function findPhantomReceiptCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  receiptCheck: (id: string) => Promise<boolean> = citedReceiptRowExists,
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const candidates = mineReceiptCitations(note)
    .filter((c) => !claimedIds.has(String(c.id)))
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  const verdicts = await Promise.all(candidates.map(async (c) => (await receiptCheck(String(c.id)).catch(() => true)) || inferredIdExists(c)));
  return candidates.filter((_, i) => !verdicts[i]);
}

/**
 * The bare chat-citation lane's matcher (tick 21, 2026-09-15) — the session-
 * ref lane's exoneration order: action-claim ids (prefix-tolerant), this run's
 * tool OUTPUTS, this run's receipted executions, then row existence
 * (crossmodel_chats + coding_sessions); convict the rest with the chat
 * near-miss bucket attached.
 */
export async function findPhantomChatCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  executed: ExecutedAction[],
  chatCheck: (id: string) => Promise<boolean> = citedChatOrSessionExists,
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('chat', id),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = actionClaims.map((c) => String(c.id ?? '').toLowerCase()).filter((id) => id.length > 0);
  const executedIds = executed.filter((a) => a.ok).flatMap((a) => Object.values(a.ids).map((v) => String(v).toLowerCase()));
  const candidates = mineChatCitations(note).filter((c) => {
    const cited = String(c.id);
    if (claimedIds.some((cl) => idMatches(cited, cl))) return false;
    if (citedIdInToolOutput(cited, evidenceHaystacks)) return false;
    return !executedIds.some((v) => idMatches(cited, v));
  });
  const verdicts = await Promise.all(candidates.map(async (c) => (await chatCheck(String(c.id)).catch(() => true)) || inferredIdExists(c)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

// ── BOARD ASSERTION lane (owner directive 2026-09-16, "inject the board,
// don't let the model recall it") ─────────────────────────────────────────
// The rollout watch found supervisors asserting RECALLED board state: an
// owner ruling reported "still OPEN" two days after the owner answered it
// (spark, oq_bd1130d5), "same 4 active goals" against a ledger of 1, a todo
// labelled with another todo's status. The [BOARD] block (board-digest.service)
// now puts the ledger in the wake; this lane strikes a note whose status
// claims contradict the same rows — the id-bearing shapes enforce (strip+mark,
// the sentence names the ledger's real status), the id-less COUNT shape is
// observed only (an id-less conviction can never strip one line, so it must
// not withhold the note).
export const BOARD_ASSERTION_TAG = '[board assertion]';
export const BOARD_COUNT_TAG = '[board count]';
const OQ_ID_RE = /\boq_([0-9a-f]{8})[0-9a-f-]*\b/gi;
const BOARD_ROW_RE = /\b(todo|goal)\s+[`"']?([0-9a-f]{8})[0-9a-f-]*[`"']?/gi;
const OQ_OPEN_WORDS = /\b(?:still\s+)?(?:open(?!\s+(?:question|issue|item|point|thread|pr|pull)s?\b)|unanswered|awaiting\s+(?:the\s+)?(?:owner|your|an?\s+answer|a\s+ruling)|pending\s+(?:the\s+)?(?:owner|your|a\s+ruling|an?\s+answer)|not\s+(?:yet\s+)?answered|outstanding)\b/i;
const OQ_DONE_WORDS = /\b(?:answered|resolved|dismissed|ruled|closed)\b/i;
// Global variants for matchAll (ticket 1256aadd): the oq miner needs the
// OFFSETS of the open/answered words it fires on, not just their presence, so
// the sole-future-subordinate guard can test which words sit inside a span.
// Reset lastIndex before each matchAll (matchAll starts the clone at it).
const OQ_OPEN_WORDS_G = new RegExp(OQ_OPEN_WORDS.source, `${OQ_OPEN_WORDS.flags}g`);
const OQ_DONE_WORDS_G = new RegExp(OQ_DONE_WORDS.source, `${OQ_DONE_WORDS.flags}g`);
// (ticket 1256aadd) FUTURE SUBORDINATES, span-scoped: "when oq_c65275e3 is
// answered, its answer lands in this chat and wakes me" / "once oq_X closes
// we re-dispatch" / "after oq_X is answered the lane resumes" are PLANS about
// a future event, not present-tense board reads. A when/once/after/as-soon-as/
// until/till/before cue renders the open/answered words of ITS OWN clause
// non-assertive; the clause ends at the first comma / semicolon / dash / arrow
// / coordinating conjunction after the cue (or the window end). RECALL-SAFE BY
// CONSTRUCTION: a cue BEFORE the id never governs a word AFTER the id across a
// boundary ("when the sweep lands, oq_X is still open" keeps mining "open"),
// a cue in a trailing clause never reaches back over the id ("oq_X is still
// open, parked until the owner rules" — the 2026-09-16 pin — keeps mining the
// main-clause "open"), and a sentence whose ONLY status word sits inside the
// future subordinate asserts nothing. The SPLIT with the sentence-level
// register is deliberate: until/till/after/before are NEVER sentence-level
// (they appear in convicted main clauses); when/once/as-soon-as are BOTH
// (sentence-level hypothetical + span cue) — overlap is defense-in-depth.
const FUTURE_SUBORDINATE_CUE_RE = /\b(?:when|once|after|as\s+soon\s+as|until|till|before)\b/gi;
// (ticket 2475ab13, minor 4 note) "whenever" / "every time" / "by the time"
// are NOT matched by any cue here — \bwhen\b does not cross into "whenever"
// and the compound forms were never cued — so a note phrased with them keeps
// the pre-1256aadd behavior (its status words mine). Adding them is a
// precision-side change with no pinned recall case; they stay out until a
// live incident asks for them.
// (ticket 1256aadd comment + ticket 2475ab13 fix) The clause a cue opens ends
// at the first comma / semicolon / colon / dash / arrow / period, or at a
// COORDINATING CONJUNCTION (and / or / but / so / yet / nor) — the 1256aadd
// comment promised "coordinating conjunction" but the class never encoded it
// (2475ab13 Finding 2: "I probed once this wake AND oq_X is answered on the
// card"). "for" is deliberately NOT a boundary: as a preposition it sits
// INSIDE the cue's own subject ("when the SLA for the card passes" must keep
// its verb — review MAJOR 2). A ':' ',' '-' '.' directly followed by a DIGIT
// is a timestamp / separator, never a boundary ("when the 06:04Z watch
// fires"); the ASCII hyphen U+002D joins the class (minor 5: em and en dash
// were in, plain "-" was not) but only when NOT word-internal ("re-dispatch"
// is one word, "lands - the lane resumes" is a dash boundary).
const CLAUSE_BOUNDARY_AFTER_CUE_RE = /(?:[;—–→]|:(?!\d)|,(?!\d)|-(?![A-Za-z0-9])|\.(?!\d)|\s(?:and|or|but|so|yet|nor)\b)/g;
const CONJUNCTION_BOUNDARY_RE = /\s(?:and|or|but|so|yet|nor)\b/i;
// (review round-3 MAJOR 1) ELLIPTICAL past-participle plans: "Once granted, …"
// / "When answered, the lane resumes" — a cue directly followed by a PAST
// PARTICIPLE + a clause boundary (comma/semicolon/colon/dash — review
// round-4 MINOR 3) is a REDUCED subordinate clause (subject omitted); it is
// a plan and shapes the cue without the subject+verb scan. (review round-5
// MAJOR 1) The optional INTONATIONAL comma ("Once, granted, oq…") is allowed
// ONLY when the cue is SENTENCE-INITIAL — mid-sentence, "I probed once,
// granted, and oq…" is the adverbial once + a participle-shaped aside, not a
// reduced clause, and must keep mining.
const ELLIPTICAL_PARTICIPLE_TAIL = '(?:granted|merged|answered|landed|asked|done|resolved|closed|opened|shipped|published|dropped|cleared|unblocked|wrapped|concluded|sent|given|picked|ruled|fired|arrived|returned|completed|finished|passed|replied|responded|paid|filed|seen|confirmed|approved)\\s*(?:,|;|:|—|–|\\s-\\s)';
const ELLIPTICAL_PARTICIPLE_RE = new RegExp(`^\\s*${ELLIPTICAL_PARTICIPLE_TAIL}`);
const ELLIPTICAL_PARTICIPLE_LEAD_RE = new RegExp(`^\\s*,?\\s*${ELLIPTICAL_PARTICIPLE_TAIL}`);
// (review round-3 MAJOR 2) Bare noun-trap stems (wake|open|close) are VERBS
// only after a PLURAL subject ("the boxes wake", "the lanes open") — never
// after this/its/his ("this wake" is a noun phrase). The once-lane verb
// stems (review rounds 2–4 MAJOR B: end|text|say|read|rest|settle|write|
// drain|start + 3sg forms) sit in SUBORDINATOR_VERB_WORD_RE itself.
const PLURAL_SUBJECT_BARE_VERB_RE = /\b(?:(?!this\b|its\b|his\b)[a-z]+s)\s+(?:wake|open|close)\b/i;
// (round-5 MAJOR 2) Claim material: an oq/todo/goal row reference or a bare
// status word. A comma-crossed segment carrying this BEFORE any verb is the
// CLAIM clause, not an appositive — the comma was a clause-ender and the cue
// must stay unshaped so the honest claim keeps mining.
const CLAIM_MATERIAL_RE = /\boq_[0-9a-f]{6,}\b|\b(?:todo|goal)\s+[0-9a-f]{8}\b|\b(?:still\s+)?(?:open|unanswered|outstanding|answered|resolved|dismissed|ruled|closed|blocked|in[ _-]?progress|pending|done|active|archived)\b/i;
// (review round-4 MAJOR C) Quoted spans are inert for BOTH scans, and the
// strip is LENGTH-PRESERVING (each quoted character becomes a space, the
// quote marks stay) so every offset computed on the original string remains
// valid on the stripped one. A semicolon inside quotes ("when the log line
// is "a;b"") is not a clause break; a verb-ish word inside quotes ("when the
// note says "done"") is a quotation, not the cue clause's verb.
const stripQuotedSpans = (s: string): string =>
  s.replace(/"[^"\n]*"/g, (q) => '"' + ' '.repeat(q.length - 2) + '"')
    .replace(/“[^”\n]*”/g, (q) => '“' + ' '.repeat(q.length - 2) + '”');
// (ticket fd9f6fc8, 2026-10-22) The BOARD-ASSERTION miner's quote strip — the
// same length-preserving "quoted spans are inert" contract as
// stripQuotedSpans, widened for the miner's own call sites ONLY (the cue
// layers keep the narrow two-glyph helper, whose callers pin its behavior):
// backtick code spans, curly single quotes, MIXED-GLYPH pairs ("…" / "…" —
// one glyph opens, the other closes), and GUARDED ASCII single quotes. The
// guard: an ASCII ' opens a span only when NOT preceded by a word char (so
// the apostrophe of "Fleet's" / "oq_X's" never opens) and closes only when
// NOT followed by a word char (so "it's" never closes) — a naive '…' pairer
// blanks from one possessive to the next and eats honest claims. ROUND-2
// REVIEW (finding 4), the honest close-direction caveat: a PLURAL possessive
// ("the supervisors' notes") is a legal CLOSE (apostrophe + space), so an odd
// single-quote count can still blank a run of honest text up to the next
// possessive — the same accepted-MISS class as the inch-mark pair (pinned in
// the fd9f6fc8 suite); it can never CREATE a conviction because every arm is
// MARK-PRESERVING (round-2 finding 1: blanking the closing mark bridged
// "awaiting the 'answered' owner" into a live open-word match — both marks
// stay, whitespace cannot span them).
// Every arm is length-preserving: offsets computed on the original sentence
// (id matchAll indices, window edges, nounIdx/idEnd) remain valid on the
// stripped string. Idempotent with stripQuotedSpans (already-blanked spans
// re-blank to themselves).
const stripQuotedStatusSpans = (s: string): string =>
  stripQuotedSpans(s)
    .replace(/`[^`\n]*`/g, (q) => '`' + ' '.repeat(q.length - 2) + '`')
    .replace(/["“][^"“”\n]*["”]/g, (q) => q[0] + ' '.repeat(q.length - 2) + q[q.length - 1])
    .replace(/‘[^‘’\n]*’/g, (q) => '‘' + ' '.repeat(q.length - 2) + '’')
    .replace(/(^|[^\w'])'[^'\n]*'(?!\w)/g, (q) => q[0] + q[1] + ' '.repeat(Math.max(0, q.length - 3)) + q[q.length - 1]);
// (review round-3 MAJOR 4 + MINOR 1) An INDEPENDENT-CLAUSE separator between
// the cue and the status word: a semicolon, a NON-timestamp colon, or a dash
// (em / en / spaced ASCII). Quoted spans are stripped BEFORE testing, so a
// semicolon inside a quoted string ("when the log line is "a;b"") is not a
// clause break. A COMMA is deliberately NOT a separator here: "when the sweep
// lands, oq_X is still open" is the pinned subordinate→main transition.
const INDEPENDENT_CLAUSE_SEP_RE = /;|(?:^|[^0-9])(?::)(?:[^0-9]|$)|—|–|\s-\s/;
// (ticket 2475ab13) THE SUBORDINATOR SHAPE TEST — when|once|as-soon-as act as
// SUBORDINATING CONJUNCTIONS only in the shape "cue + subject + verb" ("when
// the owner answers…"). The bare "once" of "I probed once this wake" is the
// ADVERB "one time": no verb follows it in its own clause, so it carries no
// hypothetical semantics and must never suppress anything. The test is
// positional over a generous verb class (verbs move: "when that happens" /
// "once granted"); failure direction is one-sided — a shape MISS leaves the
// sentence MINED (the pre-1256aadd behavior for that phrasing), never a new
// skip. The 1256aadd incident line and the reviewer's when-first probes all
// carry is/was/fires/lands/answers-class verbs directly after the cue.
const SUBORDINATOR_VERB_WORD_RE = /\b(?:is|are|am|be|been|being|has|have|does|do|can|could|will|would|shall|should|may|might|must|land|lands|fire|fires|arrive|arrives|answer|answers|closes|opens|resume|resumes|return|returns|complete|completes|finish|finishes|pass|passes|rule|rules|respond|responds|reply|replies|pick|picks|grant|grants|publish|publishes|merge|merges|drop|drops|stay|stays|remain|remains|come|comes|go|goes|get|gets|happen|happens|show|shows|turn|turns|become|becomes|give|gives|send|sends|re-?dispatch|re-?dispatches|re-?arm|re-?arms|move|moves|hit|hits|reach|reaches|clear|clears|unblock|unblocks|ship|ships|wrap|wraps|conclude|concludes|see|sees|ping|pings|agree|agrees|wakes|end|ends|text|texts|say|says|read|reads|rest|rests|settle|settles|write|writes|drain|drains|start|starts|converge|converges)\b/i;
// (review MAJOR 1) PRESENT-TENSE FORMS ONLY: bare + 3sg stems (land|lands,
// see|sees, ping|pings, agree|agrees …) — plural subjects are the norm in
// board prose ("when the boxes land", "when both lanes finish"). PAST forms
// are OUT: a past verb after the cue is narration ("this wake I probed") or
// an elliptical participle, and shaping those re-eats the adverbial once.
// Bare "wake" / "open" / "close" are NOUNS / status words here — only 3sg
// "wakes" / "closes" / "opens" are verbs ("this wake" is the most common
// noun in a board note).
/** (ticket 2475ab13) The when|once|as-soon-as SUBORDINATOR source, shared by the sentence-level history registers and the span-layer shape gate. after|until|till|before stay OUT (they appear in convicted main clauses — span-scoped only, and never shape-gated). */
const SENTENCE_LEVEL_CUE_SRC = '(?:when|once|as\\s+soon\\s+as)';
const SENTENCE_LEVEL_CUE_TEST_RE = new RegExp(`^${SENTENCE_LEVEL_CUE_SRC}$`, 'i');
/**
 * (ticket 1256aadd + 2475ab13) True when the cue at `cueAt` sits in
 * SUBORDINATOR POSITION — a verb-ish word appears in the cue's OWN clause
 * (from cueEnd to the first clause boundary at or after cueEnd). "when the
 * owner answers" ✓; the adverbial "probed once this wake" ✗ ("this wake" is a
 * noun phrase — which is exactly why "wake" must NEVER appear in the verb
 * class: "this wake" is the most common noun in board notes).
 */
function cueInSubordinatorPosition(window: string, cueAt: number, cueEnd: number, cueText = ''): boolean {
  // (review round-4 MAJOR C) strip quoted spans (LENGTH-PRESERVING, so every
  // offset below stays valid): a verb-ish word inside quotes ("when the note
  // says "done"") is a quotation, not the cue clause's verb, and a boundary
  // inside quotes never ends the clause-run.
  const scanned = stripQuotedSpans(window);
  // (review round-3 MAJOR 1 + round-5 MAJOR 1) ELLIPTICAL reduced clause: the
  // cue directly followed by a past participle + boundary ("Once granted, …" /
  // "When answered, the lane resumes") shapes with no subject — but the
  // optional INTONATIONAL comma ("Once, granted, oq…") shapes only when the
  // cue is SENTENCE-INITIAL; mid-sentence, "I probed once, granted, and oq…"
  // is the adverbial once + a participle-shaped aside and must keep mining.
  if (ELLIPTICAL_PARTICIPLE_RE.test(scanned.slice(cueEnd))) return true;
  if (cueAt === 0 && ELLIPTICAL_PARTICIPLE_LEAD_RE.test(scanned.slice(cueEnd))) return true;
  // (review MAJOR 2) A COORDINATING CONJUNCTION ends the cue's clause-run
  // only once a verb has been seen — while NO verb has been seen it is
  // NP-coordination inside the subject ("when the owner and the delegate
  // answer"), and the scan crosses it. ONLY for when|as-soon-as cues: "once"
  // NEVER crosses, because the adverbial "probed once this wake and oq_X is
  // answered" must keep its clause ending at the "and" (crossing would shape
  // it and re-eat 2475ab13 Finding 2). (Review round-3 MAJOR 3) a COMMA is
  // crossed the same way while no verb has been seen — "when the owner, the
  // delegate or the watcher answers" is a comma-list subject — but a comma
  // followed by a DIGIT is a separator, never coordination.
  const crossesConjunctions = /^(?:when|as\s+soon\s+as)$/i.test(cueText);
  // (review round-4 MAJOR C) scan the QUOTE-STRIPPED window (length-preserving
  // strip, so cueEnd and every boundary offset stay valid): a boundary
  // inside a quoted span ("when the log line "a;b" is green") never ends the
  // cue clause-run, and a verb inside quotes is a quotation, not the verb.
  const scannedWindow = stripQuotedSpans(window);
  let runStart = cueEnd;
  let sawVerb = false;
  let firstSegment = true;
  for (let crossings = 0; crossings < 8 && runStart < window.length; crossings++) {
    CLAUSE_BOUNDARY_AFTER_CUE_RE.lastIndex = 0;
    let b: RegExpExecArray | null;
    let boundaryAt = window.length;
    let boundaryText = '';
    while ((b = CLAUSE_BOUNDARY_AFTER_CUE_RE.exec(scannedWindow))) {
      if (b.index >= runStart) { boundaryAt = b.index; boundaryText = b[0]; break; }
    }
    const run = scannedWindow.slice(runStart, boundaryAt);
    const verbAt = SUBORDINATOR_VERB_WORD_RE.exec(run)?.index ?? -1;
    const claimAt = CLAIM_MATERIAL_RE.exec(run)?.index ?? -1;
    if (firstSegment) {
      // the segment directly after the cue is the subordinate clause proper:
      // its verb counts wherever it sits ("when oq_c65275e3 is answered" —
      // the 1256aadd incident line — shapes on "is" even though the id
      // precedes the verb).
      if (verbAt >= 0) sawVerb = true;
    } else if (verbAt >= 0 && (claimAt < 0 || verbAt < claimAt)) {
      sawVerb = true;
    } else if (claimAt >= 0) {
      // (round-5) a CROSSED segment that carries claim material (an oq/todo/
      // goal id or a status word) before any verb is the CLAIM clause — the
      // comma we crossed was a clause-ender ("…once this wake, meanwhile
      // oq_X is answered"), not an appositive: abort unshaped so the honest
      // claim keeps mining.
      return false;
    }
    firstSegment = false;
    // (review round-3 MAJOR 2) bare wake/open/close are verbs only after a
    // plural subject ("the boxes wake"); after this/its/his they are nouns.
    if (PLURAL_SUBJECT_BARE_VERB_RE.test(scannedWindow.slice(runStart, boundaryAt + 40))) sawVerb = true;
    if (boundaryAt >= window.length) break;
    // (round-5 MAJOR 2) once crosses COMMAS only (never conjunctions — the
    // adverbial "probed once this wake and oq_X is answered" must keep its
    // clause ending at the "and"); when|as-soon-as cross commas AND
    // conjunctions (compound subjects, appositives).
    const commaBoundary = /^,(?!\d)/.test(boundaryText);
    const conjBoundary = CONJUNCTION_BOUNDARY_RE.test(boundaryText);
    const mayCross = crossesConjunctions ? (commaBoundary || conjBoundary) : commaBoundary;
    if (!sawVerb && mayCross) { runStart = boundaryAt + boundaryText.length; continue; }
    break;
  }
  return sawVerb;
}
/**
 * (ticket 2475ab13) The sentence-level hypothetical skip, made ORDER-SENSITIVE
 * and SUBORDINATOR-SHAPED. Pre-2475ab13 the skip ate ANY sentence carrying
 * when|once|as-soon-as, which eroded recall in two shapes: a mixed sentence
 * whose main clause honestly asserts the present ("oq_X is still open; when
 * the owner answers, I re-dispatch" — status PRECEDES cue) and an adverbial
 * "once" with no hypothetical semantics at all ("I probed once this wake and
 * oq_X is answered on the card"). The skip now fires only when a
 * subordinator-SHAPED cue (cue + subject + verb) PRECEDES the first status /
 * count word — a trailing plan clause never governs an honest main-clause
 * assertion before it. when-FIRST predictions ("when the sweep lands, oq_X is
 * still open") and the 1256aadd incident line stay skipped whole.
 */
const SENTENCE_LEVEL_STATUS_WORD_RE = /\b(?:open(?!\s+(?:question|issue|item|point|thread|pr|pull)s?\b)|unanswered|awaiting|pending|outstanding|answered|resolved|dismissed|ruled|closed|in[ _-]?progress|blocked|done|completed|finished|dropped|cancelled|canceled|queued|not\s+started|unstarted|active|archived|was|were|remains?|stays?|goals?|todos?)\b/i;
/** (ticket 2475ab13) A sentence skips as a whole-board hypothetical only when a SUBORDINATOR SHAPE precedes its first status/count word — and no semicolon (a new independent clause) sits between them (review MINOR 1: "When the owner answers, I re-dispatch; meanwhile oq_X is still open" mines again). */
function isHypotheticalSentence(sentence: string): boolean {
  const cueRe = new RegExp(`\\b${SENTENCE_LEVEL_CUE_SRC}\\b`, 'gi');
  let c: RegExpExecArray | null;
  let cueAt = -1; let cueEnd = -1;
  while ((c = cueRe.exec(sentence))) {
    if (cueInSubordinatorPosition(sentence, c.index, c.index + c[0].length, c[0])) { cueAt = c.index; cueEnd = c.index + c[0].length; break; }
  }
  if (cueAt < 0) return false;
  const m = SENTENCE_LEVEL_STATUS_WORD_RE.exec(sentence);
  if (!m) return true; // no status word at all: nothing the registers mine; the shape alone is the historical skip
  if (cueAt >= m.index) return false; // trailing plan clause — the honest main-clause claim BEFORE the cue mines (Finding 1)
  // (review MINOR 1 + round-3 MAJOR 4 + round-4 MAJOR A + round-5 MAJOR 2) An
  // INDEPENDENT-CLAUSE separator (semicolon / non-timestamp colon / em-en-or-
  // spaced dash — never a comma) between the cue and the status word starts a
  // new clause whose honest present-tense claim is not governed by the leading
  // plan — but ONLY when the separator is preceded by the SUBORDINATE CLAUSE'S
  // CLOSING comma: the subordinate clause's own verb must come BEFORE that
  // comma, so a main clause ("I re-dispatch") sits between the plan and the
  // claim. A comma INSIDE the subordinate clause (an appositive, "when the
  // owner, per the card, answers", or a subject list, "when the owner, the
  // delegate or the watcher answers") never arms the escape — and a separator
  // that DIRECTLY joins the subordinate clause to the claim ("when the owner
  // answers — oq_Y is still open") is the dash twin of the pinned comma
  // transition and stays skipped. Quoted spans are inert (length-preserving
  // strip) so a semicolon inside quotes never counts.
  const between = stripQuotedSpans(sentence.slice(cueEnd, m.index));
  const sepMatch = INDEPENDENT_CLAUSE_SEP_RE.exec(between);
  if (sepMatch) {
    const head = between.slice(0, sepMatch.index); // the subordinate clause + any main clause, up to the separator
    let verbEnd = -1;
    const sv = SUBORDINATOR_VERB_WORD_RE.exec(head);
    if (sv) verbEnd = sv.index + sv[0].length;
    const pv = PLURAL_SUBJECT_BARE_VERB_RE.exec(head);
    if (pv && (verbEnd < 0 || pv.index < (sv?.index ?? Infinity))) verbEnd = pv.index + pv[0].length;
    // the subordinate clause's verb (the EARLIEST verb-ish word) must be
    // followed by the closing comma before the separator → a main clause intervened
    if (verbEnd >= 0 && /,(?!\d)/.test(head.slice(verbEnd))) return false;
  }
  return true;
}
/**
 * (ticket 1256aadd; order/shape/minor-3 revisions ticket 2475ab13) True when
 * at least one match of `re` sits OUTSIDE every future-subordinate clause.
 * The NEAREST cue before the word (searched in the WHOLE sentence, not just
 * the id's ±OQ_STATUS_WINDOW slice — minor 3: a cue >70 chars before the id
 * is still the word's governor) governs the word only when (a) no clause
 * boundary (semicolon / comma / colon / dash / arrow / hyphen / coordinating
 * conjunction) separates them, and (b) for the sentence-level cues
 * (when|once|as-soon-as) the cue sits in SUBORDINATOR POSITION — an adverbial
 * "once" governs nothing. after|until|till|before keep their unconditional
 * 1256aadd span semantics (preposition-class cues: "after the deploy, …").
 */
function matchesOutsideFutureSubordinate(re: RegExp, window: string, sentence = window, windowStart = 0): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window))) {
    const wordAt = m.index + windowStart; // sentence-relative
    FUTURE_SUBORDINATE_CUE_RE.lastIndex = 0;
    let cueAt = -1; let cueEnd = -1; let cueText = '';
    let c: RegExpExecArray | null;
    while ((c = FUTURE_SUBORDINATE_CUE_RE.exec(sentence))) {
      if (c.index >= wordAt) break;
      cueAt = c.index; cueEnd = c.index + c[0].length; cueText = c[0];
    }
    if (cueAt < 0) return true; // no cue before the word → assertive
    if (SENTENCE_LEVEL_CUE_TEST_RE.test(cueText) && !cueInSubordinatorPosition(sentence, cueAt, cueEnd, cueText)) return true; // adverbial "once" governs nothing
    CLAUSE_BOUNDARY_AFTER_CUE_RE.lastIndex = cueEnd;
    const b = CLAUSE_BOUNDARY_AFTER_CUE_RE.exec(sentence);
    if (b && b.index < wordAt) return true; // a boundary ends the cue's clause before the word → assertive
    // else: the word sits inside the future subordinate → suppressed; try the next match
  }
  return false;
}
/** How far from the oq id an open/answered word must sit to count as a claim about THAT id. */
const OQ_STATUS_WINDOW = 70;

/**
 * (ticket fd9f6fc8, sighting 2, 2026-10-22T21:11:03Z) SLOT-SCOPED STATUS-WORD
 * OWNERSHIP. A fleet-supervisor receipts line read
 *
 *   "oq oq_015ffa54 (open, supersedes oq_71d6b7af)"
 *
 * — where "(open," is oq_015ffa54's OWN parenthetical status — and was mined
 * as an assertion about oq_71d6b7af as well: the word "open" sits only ~15
 * chars from the SECOND id, well inside its ±OQ_STATUS_WINDOW, and the
 * per-id window knew nothing about WHICH row the word describes.
 *
 * Ownership applies ONLY to a status word INSIDE a parenthetical slot, and
 * the slot itself decides its owner (three shapes, review round 2):
 *  (a) RECEIPTS SLOT — an id span ends immediately (≤2 chars) before the
 *      '(': the slot's status words belong to THAT row alone. Ids merely
 *      NAMED inside the slot (a supersedes clause) own nothing — the
 *      incident itself.
 *  (b) INTERIOR LIST — no id precedes the '(' but the slot names one or
 *      more ids itself ("(oq_a, oq_b still open)"): the slot's status words
 *      are SHARED by the interior ids and belong to NO row outside the slot
 *      — a bystander id elsewhere in the sentence never inherits them.
 *  (c) STATUS-ONLY SLOT — the slot names no id ("(three still open): oq_a,
 *      oq_b" / "(both still open)" trailing two ids): which rows the word
 *      covers is exactly what the ±OQ_STATUS_WINDOW already decides, so
 *      NOTHING is blanked (pre-fix semantics — the collective-read reach
 *      the committed 2c203dac pin and round-2 pins 5/11 hold to).
 * Unbracketed status words are untouched everywhere — collective board reads
 * keep their reach.
 *
 * Blanking is MARK-PRESERVING: matched characters become '·' (middle dot),
 * never whitespace. A space-blank inside a multi-word alternation
 * ("pending a [closed] answer" → "pending a       answer") lets the
 * pattern's own \s+ span the hole and FABRICATE an open match that exists
 * in no source text (review F2 — measured 60 fabricated assertions under a
 * space mutant, 0 under '·') — '·' is neither \s nor a word character, so
 * no status token can form across it. Like stripQuotedStatusSpans the mask
 * is length-preserving, and it can only REMOVE characters — every
 * conviction still needs a status token that exists verbatim in the raw
 * window, so the raw-vs-stripped polarity agreement gate below stays the
 * sole referee for mixed windows.
 */
function enclosingParenOpen(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const ch = s[i];
    if (ch === ')') depth++;
    else if (ch === '(') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

function ownedStatusWordMask(s: string, selfId: string): string {
  OQ_ID_RE.lastIndex = 0;
  const ids = [...s.matchAll(OQ_ID_RE)].map((m) => ({ id: m[1].toLowerCase(), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  if (ids.length <= 1) return s; // one row named → the window alone governs
  const blank = (str: string, at: number, len: number) => str.slice(0, at) + '·'.repeat(len) + str.slice(at + len);
  let out = s;
  for (const re of [OQ_OPEN_WORDS_G, OQ_DONE_WORDS_G]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const at = m.index;
      const slotOpen = enclosingParenOpen(s, at);
      if (slotOpen < 0) continue; // unbracketed → pre-fix semantics (collective reads keep their reach)
      const slotClose = s.indexOf(')', slotOpen);
      const slotEnd = slotClose < 0 ? s.length : slotClose;
      // (a) receipts slot: the id ending nearest before the '(' (within 2 chars)
      let owner: string | null = null; let ownerEnd = -1;
      for (const cand of ids) {
        if (cand.end <= slotOpen && slotOpen - cand.end <= 2 && cand.end > ownerEnd) { owner = cand.id; ownerEnd = cand.end; }
      }
      if (owner) {
        if (owner !== selfId) out = blank(out, at, m[0].length);
        continue;
      }
      // (b) interior list: the slot names its own rows — they SHARE the word
      const interior = ids.filter((cand) => cand.at > slotOpen && cand.end < slotEnd);
      if (interior.length > 0) {
        if (!interior.some((cand) => cand.id === selfId)) out = blank(out, at, m[0].length);
        continue;
      }
      // (c) status-only slot: no blanking — the window alone decides
    }
  }
  return out;
}
// Status words, canonical ledger value, and how PROMISCUOUS the word is in
// prose: 'pending' / 'active' / 'done' also serve as prepositions and
// adjectives ("pending the build", "active watch", "done with"), so they need
// a status FRAME (bracketed, or a state verb, or trailing punctuation) —
// 'blocked' / 'in_progress' rarely mean anything else and may carry a tail
// ("blocked on firmware"). First live strike after the 2026-09-16 rollout
// (tt-rd 02:54Z, "todo 95f2fcf0 … pending" vs ledger in_progress) is the
// shape this guards against.
const canonicalStatus = (w: string): string => {
  const x = w.toLowerCase().replace(/\s+/g, ' ');
  if (/^in[ _-]?progress$/.test(x)) return 'in_progress';
  if (x === 'blocked') return 'blocked';
  if (/^(done|complete|completed|closed|finished)$/.test(x)) return 'done';
  if (/^(dropped|cancelled|canceled)$/.test(x)) return 'dropped';
  if (/^(pending|queued|not started|unstarted)$/.test(x)) return 'pending';
  if (x === 'active') return 'active';
  return 'archived';
};
const PROMISCUOUS_STATUS = new Set(['pending', 'active', 'done', 'dropped', 'archived']);
const STATUS_TAIL_OK = /^\s*(?:$|[,.;:!?—\-–)\]]|since\b|as\s+of\b|until\b|for\s+now\b|→|per\b|\()/;
const STATUS_TAIL_PREPOSITIONAL = /^\s+(?:with|as|the|a|an|on|for|to|of|by|in)\b/i;
/**
 * The status a sentence asserts for the row reference ending at `idEnd`
 * (noun starting at `nounIdx`), or null. Frames: `[status]` / `(status)`
 * right after the id or title; `is|remains|still|now|status: status`;
 * `status todo|goal <id>` before the noun; a bare `todo <id> status.` at a
 * clause end. A promiscuous word followed by a plain noun phrase is a
 * preposition / adjective, never a status. A status word extended by a
 * hyphen compound is a NOUN, never a status (ticket e4138a3d, 2026-09-26:
 * "goal 00ec236b done-check" — future intent, "run the done-check" —
 * convicted as asserted status "done"): `\b` passes at a hyphen and the
 * tail check's punctuation class accepts '-', so the lookahead after the
 * status word must itself reject a '-word' continuation.
 */
export function framedRowStatus(sentence: string, nounIdx: number, idEnd: number): string | null {
  // (ticket fd9f6fc8, review F3 — the oq branch's incident class applies to
  // todo/goal rows too) The frames must be read on the QUOTE-STRIPPED
  // sentence: a note quoting the [BOARD] block or an owner message verbatim
  // ("The owner wrote "todo 95f2fcf0 (blocked)" in the thread.") was mined
  // as asserting todo 95f2fcf0 blocked — the QUOTED material's status, not
  // the note's. stripQuotedStatusSpans is LENGTH-PRESERVING, so nounIdx and
  // idEnd (offsets into the original sentence) index the stripped copy
  // correctly, and the optional quoted-title arm below still matches its
  // shape (a blanked "title" reads as spaces inside the same quote marks).
  //
  // (round-2 review finding 3 — AGREE-GUARD, mirroring the oq branch's) The
  // strip may only REMOVE a frame, never create or change one: the frame is
  // mined only when the RAW and stripped readings AGREE. raw=null while
  // stripped finds a status means the blanking CREATED the match (the
  // token-bridging class round-2 proved against the both-marks-blanked
  // variant) — refused; raw≠stripped means the blanking changed WHICH status
  // the frame reads — refused as ambiguous. A quoted status the raw read
  // finds and the stripped read loses is simply not mined (the incident
  // class).
  const onStripped = rowFramesOn(stripQuotedStatusSpans(sentence), nounIdx, idEnd);
  if (!onStripped) return null;
  return rowFramesOn(sentence, nounIdx, idEnd) === onStripped ? onStripped : null;
}

/** The frame reader proper — one sentence (raw or stripped), the row reference's noun/id offsets. */
function rowFramesOn(sentence: string, nounIdx: number, idEnd: number): string | null {
  const after = sentence.slice(idEnd, idEnd + 110);
  const found: string[] = [];
  // after the id: optional quoted title, optional state verb, optional bracket, the word, the tail.
  // (ticket e4138a3d) The (?![-–]) lookahead after the status word rejects a
  // HYPHEN COMPOUND — "done-check", "pending-review", "active-watch" are NOUNS
  // ("run the done-check"), never present-tense statuses. \b alone passes at a
  // hyphen and STATUS_TAIL_OK's punctuation class accepts '-', which convicted
  // the 2026-09-26 00:14Z CQL supervisor note ("goal 00ec236b done-check" in a
  // **Next:** chain read as asserted status "done" vs ledger "active" — the id
  // was REAL, the line was honest future intent, strip+mark removed it). An
  // attached em-dash stays allowed ("done — the deploy landed" is a status with
  // a tail clause); rejecting toward MISS is the safe direction for an
  // ENFORCED conviction lane.
  const A = /^[\s:—\-–]{0,4}(?:["“][^"”\n]{0,90}["”]\s*)?(?:(?:is|are|remains|stays|still|now|currently|marked|marked\s+as|set\s+to|status[:=]?|state[:=]?|→|=)\s*)?([\[(]\s*)?(in[ _-]?progress|blocked|done|completed?|closed|finished|dropped|cancelled|canceled|pending|queued|not\s+started|unstarted|active|archived)\b(?![-–])(\s*[\])])?/i.exec(after);
  if (A) {
    const status = canonicalStatus(A[2]);
    const bracketed = !!(A[1] && A[3]);
    const verb = /(?:is|are|remains|stays|still|now|currently|marked|set\s+to|status|state|→|=)\s*[\[(]?\s*$/i.test(after.slice(0, A.index + A[0].length - A[2].length - (A[3]?.length ?? 0) - (A[1]?.length ?? 0)));
    const tail = after.slice(A[0].length);
    if (!PROMISCUOUS_STATUS.has(status)) found.push(status);
    else if (bracketed) found.push(status);
    else if (STATUS_TAIL_PREPOSITIONAL.test(tail)) { /* "pending the build", "done with", "active for" — not a status */ }
    else if (verb || STATUS_TAIL_OK.test(tail)) found.push(status);
  }
  // before the noun: "blocked todo <id>", "the pending goal <id>", "[done] todo <id>"
  const before = sentence.slice(Math.max(0, nounIdx - 40), nounIdx);
  const B = /(?:^|[\s\[(])(in[ _-]?progress|blocked|done|completed?|closed|finished|dropped|cancelled|canceled|pending|queued|not\s+started|unstarted|active|archived)[\])]?\s+(?:the\s+)?$/i.exec(before);
  if (B) found.push(canonicalStatus(B[1]));
  const distinct = [...new Set(found)];
  return distinct.length === 1 ? distinct[0] : null;
}
// History / retraction / conditional register: a sentence that TALKS ABOUT a
// past or hypothetical status is not asserting the present one.
// The bare arrow is NOT history: the [BOARD] block's own todo lines read
// "todo X [pending] "title" → lane Y". A status→status TRANSITION is.
// (ticket 1256aadd) when|once|as-soon-as join if|unless as HYPOTHETICAL
// markers at sentence level — "when oq_c65275e3 is answered, its answer
// lands in this chat" is a future plan, and so is "when the sweep lands,
// oq_X is still open" (a prediction, not a board read). until/till/after/
// before stay OUT of this sentence-level register: "X stays parked until the
// owner rules" ASSERTS X's present status (the 2026-09-16 pin convicts on
// exactly that shape) — those cues are suppressed span-scoped, in the oq
// miner's own clause window (matchesOutsideFutureSubordinate).
// (ticket 2475ab13) The when|once|as-soon-as membership is now GATED by
// isHypotheticalSentence — ORDER-SENSITIVE (the cue must PRECEDE the first
// status word, so "oq_X is still open; when the owner answers, I re-dispatch"
// mines again) and SUBORDINATOR-SHAPED (cue + subject + verb, so the adverbial
// "I probed once this wake" never trips it). when-first hypotheticals keep
// skipping whole.
const BOARD_HISTORY_RE = /\b(?:was|were|had\s+been|previously|earlier|yesterday|last\s+(?:wake|sweep|night|week)|used\s+to|no\s+longer|now\s+(?:answered|closed|done)|flipped|moved\s+(?:from|to)|if|unless|would|should|will|going\s+to|reopen)\b/i;
/** (ticket 2475ab13) Sentence-level history/hypothetical skip: the fixed register OR a governing subordinator shape (order-sensitive, subordinator-shaped — the when|once|as-soon-as membership moved out of the raw regex into isHypotheticalSentence). */
function isBoardHistorySentence(sentence: string): boolean {
  return BOARD_HISTORY_RE.test(sentence) || isHypotheticalSentence(sentence);
}
const STATUS_TRANSITION_RE = /\b(?:in[ _-]?progress|blocked|done|completed?|closed|pending|queued|active|archived|dropped|open|answered)\b\s*(?:→|->|to)\s*\b(?:in[ _-]?progress|blocked|done|completed?|closed|pending|queued|active|archived|dropped|open|answered)\b/i;
// (ticket 2475ab13) Same register split for the COUNT lane: the fixed markers
// OR the order-sensitive, subordinator-shaped hypothetical gate
// (isHypotheticalSentence — shared with the status lane so the two can never
// drift apart).
const COUNT_HISTORY_RE = /\b(?:was|were|had\s+been|previously|earlier|yesterday|used\s+to|no\s+longer|if|unless|would|should|will|going\s+to)\b|→|->/i;
/** (ticket 2475ab13) Count-lane history/hypothetical skip: the fixed register OR the same governing subordinator shape. */
function isCountHistorySentence(sentence: string): boolean {
  return COUNT_HISTORY_RE.test(sentence) || isHypotheticalSentence(sentence);
}
// Review fix (sup3 fixer pass, 2026-09-27 — finding 5): a sentence quoting
// the board's own '⚠ suspect' badge or writing "suspect close" is the
// doctrine's prescribed phrasing for a suspect 'done' close (goal-done-suspect
// C2) — it cites the ledger status verbatim and is never read as an assertion.
// Rejecting toward MISS is the safe direction for an ENFORCED lane.
export const BOARD_SUSPECT_CUE_RE = /⚠\s*suspect|\bsuspect\s+close[sd]?\b/i;
const GOAL_VALID = new Set(['active', 'blocked', 'done', 'archived']);
const TODO_VALID = new Set(['pending', 'in_progress', 'blocked', 'done', 'dropped']);

export interface BoardAssertion { kind: 'oq' | 'todo' | 'goal'; id: string; asserted: string; sentence: string }
export interface BoardCountAssertion { family: 'goal' | 'todo'; qualifier: 'active' | 'open' | 'blocked'; count: number; sentence: string }

const sentencesOf = (note: string): string[] => String(note ?? '').split(/\n+/).flatMap((line) => {
  const out: string[] = [];
  let start = 0;
  for (const m of line.matchAll(SENTENCE_BOUNDARY_RE)) { const at = m.index ?? 0; out.push(line.slice(start, at)); start = at + m[0].length; }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length >= 12 && !s.startsWith('>'));
});

/** Exported for tests: deterministic status assertions ("oq_X still open", "todo Y blocked") — one per (kind,id) per sentence, sentences with a history/conditional register skipped, sentences asserting TWO statuses for one row skipped (ambiguous). */
export function mineBoardAssertions(note: string): BoardAssertion[] {
  const out: BoardAssertion[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(note)) {
    if (isBoardHistorySentence(sentence) || STATUS_TRANSITION_RE.test(sentence) || EVIDENCE_EXCLUSION.test(sentence) || BOARD_SUSPECT_CUE_RE.test(sentence)) continue;
    OQ_ID_RE.lastIndex = 0;
    for (const m of sentence.matchAll(OQ_ID_RE)) {
      const id = m[1].toLowerCase();
      // The open/answered word must sit NEAR this id — a sentence naming two
      // questions with two statuses, or an "open question" idiom elsewhere in
      // the sentence, is not a claim about this row. (ticket 1256aadd) The
      // word must also sit OUTSIDE any future-subordinate span: "when
      // oq_c65275e3 is answered, its answer lands in this chat" is a plan for
      // the future, not a present-tense board read — pre-fix, its clause's
      // "answered" convicted an honest note against a ledger the note itself
      // had just quoted correctly ("still open").
      const at = m.index ?? 0;
      const windowStart = Math.max(0, at - OQ_STATUS_WINDOW);
      // (ticket fd9f6fc8, 2026-10-22) The status-word window must come from a
      // QUOTE-STRIPPED sentence: the incident note read "Your answer to
      // oq_c5756aaf — *"Saved — signed in as root on mbp-1, console left open
      // (Digby drives from here)"* — is verified in the ledger as ANSWERED" —
      // an HONEST note that QUOTED the owner's answer text. The word "open"
      // inside that quotation sat inside the id's ±70-char window while the
      // note's own status word (ANSWERED, agreeing with the ledger) sat
      // outside it, so the oq lane mined asserted="open" against a ledger
      // "answered" and struck the truthful line as a mis-stated board read.
      // The strip (stripQuotedStatusSpans — length-preserving, so `at`,
      // windowStart and every offset computed on the original sentence stay
      // valid) must run on the WHOLE sentence BEFORE the slice: stripping the
      // slice itself would truncate a quoted span that crosses the window
      // edge into an unpaired quote, which strips nothing and re-admits the
      // quoted word.
      //
      // (review F1, cross-row attribution) The strip may NEVER resolve a
      // mixed window on its own. "Unlike oq_A which is "still open", oq_B is
      // answered" — A's RAW window holds open+done (ambiguous, skipped
      // pre-fix) but the strip removes A's QUOTED "still open", leaving only
      // B's honest "answered" inside A's window: the lane would attribute
      // B's word to A and strike A "answered" vs ledger open. So the window
      // mines ONLY when the raw and stripped windows AGREE on polarity:
      //   - both say open (or both say done) → mine that polarity;
      //   - raw is mixed (open===done) → stays skipped, exactly as pre-fix;
      //   - raw is single-polarity but the strip flips/empties it → the
      //     conviction rested on QUOTED material → not mined (the incident
      //     shape). A conviction can never be CREATED by the strip — only
      //     removed — and a raw mixed window can never be resolved by it.
      const rawWindow = sentence.slice(windowStart, at + m[0].length + OQ_STATUS_WINDOW);
      // (ticket fd9f6fc8, sighting 2) composed BEFORE the slice and in order:
      // quoted spans are inert (whole sentence), then — when the sentence
      // names more than one oq row — a status word inside another row's
      // parenthetical slot is blanked. BOTH masks run on the WHOLE sentence
      // BEFORE the window is sliced (round-3 review edge): a slice-level mask
      // loses the '(' when it falls before windowStart and the slot status
      // reads as unbracketed — the same truncated-at-the-edge bug class the
      // sighting-1 comment above pins for quotes. Both masks are
      // length-preserving (offsets stay valid) and removal-only (the
      // raw-vs-stripped agreement gate below stays the sole polarity
      // referee; a raw mixed window is never resolved).
      const window = ownedStatusWordMask(stripQuotedStatusSpans(sentence), id)
        .slice(windowStart, at + m[0].length + OQ_STATUS_WINDOW);
      const rawOpen = matchesOutsideFutureSubordinate(OQ_OPEN_WORDS_G, rawWindow, sentence, windowStart);
      const rawDone = matchesOutsideFutureSubordinate(OQ_DONE_WORDS_G, rawWindow, sentence, windowStart);
      const open = rawOpen !== rawDone
        ? matchesOutsideFutureSubordinate(OQ_OPEN_WORDS_G, window, sentence, windowStart)
        : false;
      const done = rawOpen !== rawDone
        ? matchesOutsideFutureSubordinate(OQ_DONE_WORDS_G, window, sentence, windowStart)
        : false;
      if (open === done) continue; // neither or both → not an assertion we can read
      const key = `oq|${id}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ kind: 'oq', id, asserted: open ? 'open' : 'answered', sentence });
    }
    BOARD_ROW_RE.lastIndex = 0;
    for (const m of sentence.matchAll(BOARD_ROW_RE)) {
      const kind = m[1].toLowerCase() as 'todo' | 'goal';
      const id = m[2].toLowerCase();
      const status = framedRowStatus(sentence, m.index ?? 0, (m.index ?? 0) + m[0].length);
      if (!status || !(kind === 'goal' ? GOAL_VALID : TODO_VALID).has(status)) continue;
      const key = `${kind}|${id}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ kind, id, asserted: status, sentence });
    }
  }
  return out;
}

const COUNT_RE_A = /\b(\d{1,3})\s+(?:of\s+\d{1,3}\s+)?(active|open|blocked)\s+(goals?|todos?)\b/gi;
const COUNT_RE_B = /\b(\d{1,3})\s+of\s+\d{1,3}\s+(goals?|todos?)\s+(active|open|blocked)\b/gi;
/** Exported for tests: "N active goals" / "N of M goals active" / "N open todos" assertions. */
export function mineBoardCountAssertions(note: string): BoardCountAssertion[] {
  const out: BoardCountAssertion[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(note)) {
    if (isCountHistorySentence(sentence)) continue;
    for (const [re, order] of [[COUNT_RE_A, 'nqf'], [COUNT_RE_B, 'nfq']] as Array<[RegExp, string]>) {
      re.lastIndex = 0;
      for (const m of sentence.matchAll(re)) {
        const count = Number(m[1]);
        const qualifier = (order === 'nqf' ? m[2] : m[3]).toLowerCase() as BoardCountAssertion['qualifier'];
        const family = ((order === 'nqf' ? m[3] : m[2]).toLowerCase().startsWith('goal') ? 'goal' : 'todo') as BoardCountAssertion['family'];
        const key = `${family}|${qualifier}`; if (seen.has(key) || !Number.isFinite(count)) continue; seen.add(key);
        out.push({ family, qualifier, count, sentence });
      }
    }
  }
  return out;
}

/**
 * When the audited row's CURRENT status took effect (transition timestamp) —
 * null when the row carries no transition stamp (open rows, or a legacy null
 * resolvedAt). oq rows: resolvedAt is stamped on EVERY resolution path
 * (answer/dismiss, REST + tool, owner + supervisor + auto-default). todo/goal
 * rows: no per-status transition column exists (updatedAt bumps on every
 * write — never a status-change proof), so they return null and the race
 * exoneration stays oq-only. Exported for tests.
 */
export async function ledgerTransitionAt(kind: 'oq' | 'todo' | 'goal', rowId: string): Promise<Date | null> {
  try {
    if (kind !== 'oq') return null;
    const row = await prisma.ownerQuestion.findFirst({
      where: { id: { startsWith: rowId.startsWith('oq_') ? rowId : `oq_${rowId}` } },
      select: { status: true, resolvedAt: true },
    });
    if (!row || row.status === 'open' || !row.resolvedAt) return null;
    const t = new Date(row.resolvedAt).getTime();
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}

/** Ledger status of one row by kind + 8-char id; null when absent/unreadable (existence lanes own absence). Exported for tests. */
export async function ledgerStatusOf(kind: 'oq' | 'todo' | 'goal', id: string): Promise<string | null> {
  try {
    if (kind === 'oq') {
      const row = await prisma.ownerQuestion.findFirst({ where: { id: { startsWith: id.startsWith('oq_') ? id : `oq_${id}` } }, select: { status: true } });
      if (!row?.status) return null;
      return row.status === 'open' ? 'open' : 'answered';
    }
    const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
    const row = kind === 'todo'
      ? await prisma.projectTodo.findFirst({ where, select: { status: true } })
      : await prisma.projectGoal.findFirst({ where, select: { status: true } });
    return row?.status ? String(row.status) : null;
  } catch {
    return null;
  }
}

/** Ledger counts for a project supervisor's own project; null when unknown. Exported for tests. */
export async function ledgerCountsForChat(chatId: string): Promise<{ goals: Record<string, number>; todos: Record<string, number> } | null> {
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { projectId: true, isProjectSupervisor: true } });
    if (!chat?.isProjectSupervisor || !chat.projectId) return null;
    const [g, t] = await Promise.all([
      (prisma.projectGoal as any).groupBy({ by: ['status'], where: { projectId: chat.projectId }, _count: { _all: true } }),
      (prisma.projectTodo as any).groupBy({ by: ['status'], where: { projectId: chat.projectId }, _count: { _all: true } }),
    ]);
    const fold = (rows: any[]) => Object.fromEntries((rows ?? []).map((r) => [String(r.status), Number(r._count?._all ?? 0)]));
    return { goals: fold(g), todos: fold(t) };
  } catch {
    return null;
  }
}

/**
 * The board-assertion lane's matcher (owner 2026-09-16). Status assertions
 * whose ledger row disagrees convict as citation-class (id-bearing → the
 * offending line strips); count assertions for a PROJECT supervisor whose
 * ledger totals disagree convict id-less under BOARD_COUNT_TAG (observed
 * only — never a whole-note withhold). Rows that do not exist are skipped:
 * the existence lanes own absence. Every probe failure fails toward MISS.
 */
export async function findPhantomBoardAssertions(
  note: string,
  actionClaims: ExtractedClaim[],
  opts: { chatId?: string; supervisorScope?: SupervisorScope; runStartedAt?: Date } = {},
  statusLookup: (kind: 'oq' | 'todo' | 'goal', id: string) => Promise<string | null> = ledgerStatusOf,
  countsLookup: (chatId: string) => Promise<{ goals: Record<string, number>; todos: Record<string, number> } | null> = ledgerCountsForChat,
  transitionLookup: (kind: 'oq' | 'todo' | 'goal', id: string) => Promise<Date | null> = ledgerTransitionAt,
): Promise<ExtractedClaim[]> {
  const out: ExtractedClaim[] = [];
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const assertions = mineBoardAssertions(note).filter((a) => !claimedIds.has(a.id));
  const verdicts = await Promise.all(assertions.map((a) => statusLookup(a.kind, a.id).catch(() => null)));
  // (ticket a9846924) MID-RUN-TRANSITION races: the verifier reads the ledger at
  // FINALIZE time, the model read it at run START ([BOARD] render) or mid-run
  // (a probe) — an owner answer landing in that window turns a truthful note
  // into a finalize-time contradiction with zero lane fault. resolvedAt is
  // harness-stamped on every resolution path, so when it proves the row's
  // current (contradicting) status took effect AFTER the run started, the
  // assertion was correct when the model could have read it: exoneration,
  // observed-only telemetry below, never a strike. Only oq rows carry a
  // transition stamp (ledgerTransitionAt returns null elsewhere), so a
  // todo/goal contradiction is never race-exonerated — those rows' updatedAt
  // bumps on every write and proves nothing. Absent runStartedAt (pre-fix
  // callers, most test shapes) the tier is skipped entirely.
  // Adversarial review (2026-10-07 03:40–04:10Z, session a3d42a16) verified the fail-closed
  // properties of this tier: (1) the exoneration is ONE-DIRECTIONAL — it only
  // lifts an asserted-open conviction against a row that resolved mid-run; a
  // fabricated "answered" against a still-open row can never ride it (an open
  // row has no transition stamp → null → strike); (2) fabricated ids never
  // reach the tier (statusLookup null → existence lanes); (3) legacy rows with
  // NULL resolvedAt resolve to null → strike stands (safe direction); (4) an
  // invalid/NaN date fails the strict > → strike; (5) the tier is TIMING-based,
  // not probe-based — a lane that recalled rather than probed is also
  // exonerated when the answer genuinely landed mid-run. (5) is the deliberate
  // miss-bias trade: the false negative is one stale-but-was-true-at-compose
  // status line about a REAL row, self-correcting on the next wake's board;
  // the pre-fix false positive (this ticket) stripped truthful notes and filed
  // "mis-stated from memory" mishaps against faultless lanes.
  const runStart = opts.runStartedAt ? opts.runStartedAt.getTime() : null;
  const racedIds = new Set<string>();
  const racedLines: string[] = [];
  if (runStart !== null) {
    const transitions = await Promise.all(assertions.map((a, idx) =>
      (a.kind === 'oq' && verdicts[idx] && verdicts[idx] !== a.asserted) ? transitionLookup(a.kind, a.id).catch(() => null) : Promise.resolve(null)));
    assertions.forEach((a, i) => {
      if (a.kind !== 'oq') return;
      const ledger = verdicts[i];
      if (!ledger || ledger === a.asserted) return;
      const transition = transitions[i];
      if (transition && transition.getTime() > runStart) {
        racedIds.add(a.id);
        racedLines.push(`oq_${a.id} asserted=${a.asserted} ledger=${ledger} resolvedAt=${transition.toISOString()} runStartedAt=${new Date(runStart).toISOString()}`);
      }
    });
  }
  if (racedLines.length) {
    logger.info(`action-verifier: ${racedLines.length} board assertion(s) in chat ${(opts.chatId ?? '').slice(0, 8)} EXONERATED as mid-run transitions (resolvedAt after runStartedAt — ticket a9846924 race tier; not phantoms): ${racedLines.join('; ')}`, { source: 'action-verifier' });
  }
  assertions.forEach((a, i) => {
    const ledger = verdicts[i];
    if (!ledger || ledger === a.asserted) return;
    if (racedIds.has(a.id)) return;
    out.push({ kind: a.kind, id: a.id, asserted: a.asserted, ledger, detail: `${BOARD_ASSERTION_TAG} ${a.sentence.slice(0, 180)} — asserted ${a.kind === 'oq' ? `oq_${a.id}` : `${a.kind} ${a.id}`} is "${a.asserted}"; the ledger says "${ledger}"` });
  });
  if (opts.supervisorScope === 'project' && opts.chatId) {
    const counts = mineBoardCountAssertions(note);
    if (counts.length) {
      const ledger = await countsLookup(opts.chatId).catch(() => null);
      if (ledger) {
        const sum = (rec: Record<string, number>, keys: string[]) => keys.reduce((n, k) => n + (rec[k] ?? 0), 0);
        for (const c of counts) {
          const actual = c.family === 'goal'
            ? (c.qualifier === 'blocked' ? sum(ledger.goals, ['blocked']) : sum(ledger.goals, ['active', 'blocked']))
            : (c.qualifier === 'blocked' ? sum(ledger.todos, ['blocked']) : sum(ledger.todos, ['pending', 'in_progress', 'blocked']));
          if (actual !== c.count) {
            out.push({ kind: 'board', asserted: String(c.count), ledger: String(actual), detail: `${BOARD_COUNT_TAG} ${c.sentence.slice(0, 180)} — asserted ${c.count} ${c.qualifier} ${c.family}(s); the ledger counts ${actual}` });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Existence-only check for a cited MESSAGE ROW (see the lane docblock). The
 * fleet's citation idiom is an 8-char prefix — prefix-match exactly like
 * citedArtifactExists. Returns TRUE on DB error: fail toward miss, never
 * convict an unverifiable citation.
 */
export async function citedMessageRowExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.crossModelMessage.findFirst({ where, select: { id: true } });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * Existence-only check for a cited SCHEDULE ROW (ticket 5448a836) — the same
 * prefix-match + fail-toward-miss contract as citedMessageRowExists, against
 * coding_schedules. Existence, not liveness: a disabled-but-real schedule
 * honestly cited ("once-schedule X auto-retired") must exonerate.
 */
export async function citedScheduleRowExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.chatSchedule.findFirst({ where, select: { id: true } });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * Existence-only checks for a cited GOAL/TODO ROW (ticket 3ed139cd) — the same
 * prefix-match + fail-toward-miss contract as citedScheduleRowExists, against
 * project_goals/project_todos. Existence, not status: goals are ARCHIVED, never
 * deleted, and todos have no delete path at all (goals.service.0633adb5), so a
 * real id stays exonerable forever — an archived-but-real goal honestly cited
 * ("goal e1f27829, archived") must exonerate exactly like the schedule lane's
 * disabled-but-real row. A goal/todo this run created or updated keeps its ROW
 * (goal_update renames in place — the id is immutable), so existence alone also
 * exonerates every truthful same-run citation; no executed-pool tier is needed.
 */
export async function citedGoalRowExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.projectGoal.findFirst({ where, select: { id: true } });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

export async function citedTodoRowExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.projectTodo.findFirst({ where, select: { id: true } });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * KIND-AGNOSTIC id existence (fleet 17:14Z incident, 2026-09-15). The action
 * lane's kind-scoped check convicts a REAL id the extractor mis-typed (f16cc02a:
 * a real todo labelled [dispatch]) — coin-flip class, rightly observed-only.
 * An id that exists as NO message / chat-session / schedule / ticket / goal /
 * todo row is a different animal: it was invented. This probe backs the
 * `fabricatedId` classification. Prefix-match (the 8-char citation idiom);
 * fail toward EXISTS on any error — a probe failure must never convict.
 * Exported for tests.
 */
export async function citedIdExistsAnywhere(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  const probes: Array<() => Promise<unknown>> = [
    () => prisma.crossModelMessage.findFirst({ where, select: { id: true } }),
    () => prisma.crossModelChat.findFirst({ where, select: { id: true } }),
    () => prisma.chatSchedule.findFirst({ where, select: { id: true } }),
    () => prisma.userFeatureRequest.findFirst({ where, select: { id: true } }),
    () => prisma.projectGoal.findFirst({ where, select: { id: true } }),
    () => prisma.projectTodo.findFirst({ where, select: { id: true } }),
  ];
  for (const probe of probes) {
    try {
      if (await probe()) return true;
    } catch {
      return true; // fail toward EXISTS — never classify on a probe failure
    }
  }
  return false;
}

/**
 * (ticket 7ea4819b, 2026-10-07) MISCOPIED-id detection — the third existence-
 * arithmetic class alongside INVENTED (fabricatedId) and mis-typed-but-real
 * (f16cc02a). The incident: a user-facing chat turn cited ticket
 * `59a407b-ee05-4026-bac9-b4a71c00fed3` while the run's OWN file_feedback
 * result envelope carried `59a4407b-ee05-…` — ONE dropped character, every
 * digit of the real id otherwise intact. Every recovery tier is exact-or-
 * prefix and missed it by that one character: citedIdInToolOutput is an exact
 * substring probe, idMatches is exact/prefix, and samePrefixRealIds buckets on
 * the FIRST 8 chars — exactly where the corruption sat. So a citation the
 * model OBSERVED and then mistranscribed was struck as "invented from memory"
 * (false), the mishap ticket mis-diagnosed it, and correctionAdvice's
 * fabricatedActionIds tail told the lane the filing "is ALSO NOT DONE — call
 * the tool" — actively instructing a DUPLICATE ticket filing for an action
 * that HAD run. This tier cannot exonerate (the id as written must still be
 * strippable — a reader following it finds nothing), but it can reclassify
 * the diagnosis and RECOVER the real id onto every strike surface.
 *
 * Precision contract (a false stamp teaches "your invention was real" — as
 * bad as the false fabrication prose it replaces):
 *   - KIND-CONSTRAINED: the near-match must be an envelope id of an executed
 *     action whose tool belongs to the claim's own KIND_TOOLS kind (a ticket
 *     claim matches only file_feedback envelopes, a schedule claim only
 *     schedule-tool envelopes…). Two same-kind candidates ⇒ ambiguous ⇒ no
 *     stamp. Id-less or non-idish convictions skip.
 *   - LENGTH-GATED Levenshtein: full uuid-ish ids (≥32 chars) allow distance
 *     ≤2 (a dropped char, an inserted char, a transposition — the classic
 *     mistranscription pair); short prefix citations (8–31 chars, the 8-char
 *     fleet idiom) allow ≤1 — at 8 hex chars a distance-2 window starts
 *     matching unrelated ids (birthday collisions in 4 billion), so the
 *     shorter the cited string the stricter the gate.
 *   - DISTINGUISHABLE: an id that ALSO appears verbatim in this run's tool
 *     outputs somewhere else (a different real row) is not stamped — the
 *     cited string may be a legitimate foreign id, not a miscopy.
 */
const MISCOPY_FULL_MAX = 2;
const MISCOPY_PREFIX_MAX = 1;
const MISCOPY_FULL_MIN = 32;

/** Bounded Levenshtein distance: returns `max + 1` as soon as the bound is passed. Exported for tests. */
export function levenshteinWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1; // early exit — every completion of this row is over budget
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Stamp `miscopiedFrom` on convictions whose cited id near-matches (uniquely,
 * kind-constrained) an id in this run's executed-pool envelopes. Pure
 * decoration: mutates in place, never exonerates, never un-convicts. The
 * haystacks parameter is the same tool-OUTPUT haystacks the exoneration tier
 * uses — an id present verbatim there was already exonerated upstream, and a
 * DISTINCT real id sharing the cited string keeps this conservative. Returns
 * the number stamped. Exported for tests.
 */
export function stampMiscopiedIds(
  phantoms: ExtractedClaim[],
  executed: ExecutedAction[],
  evidenceHaystacks: string[] = [],
): number {
  let stamped = 0;
  for (const p of phantoms) {
    if (p.miscopiedFrom || !idish(p.id)) continue;
    if (String(p.detail ?? '').startsWith('[in ')) continue; // args surface — drafted content, not the note's citation (markFabricatedIds' discipline)
    const cited = String(p.id).toLowerCase();
    // Only the four ACTION kinds have a KIND_TOOLS vocabulary to constrain
    // against — a deterministic citation lane's kind ('msg', 'goal'…) has no
    // executed-envelope counterpart and is left to the near-miss hint bucket.
    const tools = KIND_TOOLS[p.kind as ClaimKind];
    if (!tools) continue;
    const full = cited.length >= MISCOPY_FULL_MIN;
    const limit = full ? MISCOPY_FULL_MAX : MISCOPY_PREFIX_MAX;
    const hits = new Set<string>();
    for (const action of executed) {
      if (!action.ok || !tools.includes(action.tool)) continue;
      for (const value of Object.values(action.ids ?? {})) {
        const actual = String(value ?? '').toLowerCase();
        if (actual.length < 8) continue;
        if (actual === cited || actual.startsWith(cited) || cited.startsWith(actual)) continue; // exact/prefix is the OTHER tiers' business
        // A SHORT cited id (the 8-char prefix idiom) is compared against the
        // length-matched prefix WINDOW of the envelope id — a corruption INSIDE
        // the prefix (59a407b vs 59a4407b) is invisible to both the exact tiers
        // and the same-prefix bucket, and it is this ticket's shape. The window
        // spans cited.length ±1 (reviewer Finding A, ticket 7ea4819b): a
        // DROPPED char cites n-1, a SUBSTITUTION cites n, an INSERTED char
        // cites n+1 — all three alignments must reach a ≤limit comparison, or
        // the miscopy degenerates back to fabricatedId + the duplicate-filing
        // advice for that corruption shape.
        const candidates = full
          ? [actual]
          : Array.from(new Set([-1, 0, 1].map((d) => actual.slice(0, cited.length + d))))
              .filter((cand) => cand.length >= 8);
        if (candidates.some((cand) => levenshteinWithin(cited, cand, limit) <= limit)) hits.add(actual);
      }
    }
    if (hits.size === 1 && !citedIdInToolOutput(cited, evidenceHaystacks)) {
      p.miscopiedFrom = [...hits][0];
      stamped += 1;
    }
  }
  return stamped;
}

/**
 * (ticket c5629165, 2026-10-13) Stamp `misattributedFiling` on [ticket]
 * ACTION-lane convictions whose cited id IS a real ticket row this chat did
 * not file. The incident (chat 91d79e37, 2026-10-13T05:48Z): the note said
 * "one new platform ticket filed — ca805a61" while the run's only
 * consequential tool calls were get_feedback ×9 + list_feedback — the ticket
 * EXISTS (filed 2026-10-07 by session 9effe0d0), so the generic action
 * framing ("call the tool and cite the id") instructed a DUPLICATE filing of
 * a real ticket, and the generic prose never named the true defect: the model
 * READ the ticket and claimed authorship of the filing.
 *
 * Two anchors, EITHER suffices (both were live in the incident):
 *   - the row's stored filer (context.filedBy / context.sessionId /
 *     context.chatId) names a session OTHER than the claiming chat;
 *   - the row's updatedAt PRECEDES the run's start — a ticket filed days
 *     before the claiming run cannot be "filed this run" — while this run's
 *     own file_feedback executions (if any) do not carry the id.
 * A row matching NEITHER keeps the unstamped action-class conviction (e.g. a
 * fresh ticket with an unstamped/NULL filer context — pre-2026-09-27 rows,
 * human-filed rows), and a claim stamped here is SKIPPED by
 * markFabricatedIds's "in a tool output" exoneration only in the sense that
 * it is already classified: the id is real, seen in a get_feedback result,
 * never invented. Mutates in place; returns the count stamped. Exported for
 * tests.
 */
export async function stampMisattributedFilings(
  phantoms: ExtractedClaim[],
  chatId: string,
  executed: ExecutedAction[],
  runStartedAt: Date | undefined,
  rowLookup: (id: string) => Promise<{ context: unknown; updatedAt: Date } | null> = defaultTicketRowLookup,
): Promise<number> {
  let stamped = 0;
  for (const p of phantoms) {
    if (p.kind !== 'ticket' || p.miscopiedFrom || !idish(p.id)) continue;
    if (String(p.detail ?? '').startsWith('[in ')) continue; // args surface — drafted content, not the note's claim
    const cited = String(p.id);
    // An id this run's own file_feedback execution actually carried would have
    // exonerated the claim at tier 1 — a surviving ticket conviction citing a
    // real row means the filing (if real) was NOT this run's. But belt and
    // braces: skip any id the run's own ok file_feedback envelopes carry
    // (defensive against future tier reordering).
    const ownFiling = executed.some((a) => a.ok && a.tool === 'file_feedback' && Object.values(a.ids ?? {}).some((v) => idMatches(cited, String(v))));
    if (ownFiling) continue;
    const row = await rowLookup(cited).catch(() => null);
    if (!row) continue; // no row → fabricatedId's business, not ours
    const foreignFiler = ticketRowFiledByAnother(row.context, chatId);
    const predatesRun = !!runStartedAt && row.updatedAt < runStartedAt;
    if (foreignFiler || predatesRun) {
      p.misattributedFiling = true;
      stamped += 1;
    }
  }
  return stamped;
}

/**
 * The production row lookup for stampMisattributedFilings — prefix-tolerant
 * (the citation idiom cites 8-hex prefixes). NOT tenant-scoped, exactly like
 * the citedArtifactExists gate it mirrors (adversarial review L3, ticket
 * c5629165: only citedTicketRowExists / the near-miss bucket carry
 * ticketTenantScope — the artifact-check lane never did, and this lookup must
 * not imply otherwise). Returns null on any DB error (fail toward "no stamp"
 * — an unverifiable row keeps the generic action class, never a wrong
 * diagnosis).
 */
async function defaultTicketRowLookup(id: string): Promise<{ context: unknown; updatedAt: Date } | null> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    return await prisma.userFeatureRequest.findFirst({ where, select: { context: true, updatedAt: true } });
  } catch {
    return null;
  }
}

/**
 * Stamp `fabricatedId` on the ACTION-lane convictions whose cited id (a) is
 * written in the audited note itself, (b) appears in none of this run's tool
 * OUTPUTS, and (c) exists in no artifact table. Args-surface claims are
 * skipped (their ids live in drafted artifact content, not in the note).
 * (ticket 7ea4819b) A MISCOPIED conviction (miscopiedFrom set) is skipped —
 * the id was observed in a real envelope and mistranscribed, not invented.
 * Mutates in place; returns the count marked. Exported for tests.
 */
export async function markFabricatedIds(
  phantoms: ExtractedClaim[],
  note: string,
  evidenceHaystacks: string[],
  existsAnywhere: (id: string) => Promise<boolean> = citedIdExistsAnywhere,
): Promise<number> {
  const noteLower = String(note ?? '').toLowerCase();
  let marked = 0;
  for (const p of phantoms) {
    // (ticket 7ea4819b) a MISCOPIED id was observed in a real envelope — not
    // invented; the miscopiedFrom stamp carries its own (truthful) lesson.
    if (p.miscopiedFrom) continue;
    if (!idish(p.id) || isCitationClassClaim(p)) continue;
    if (String(p.detail ?? '').startsWith('[in ')) continue; // args surface
    const id = String(p.id).toLowerCase();
    if (!noteLower.includes(id)) continue;
    if (citedIdInToolOutput(id, evidenceHaystacks)) continue;
    if (await existsAnywhere(id).catch(() => true)) continue;
    p.fabricatedId = true;
    marked += 1;
  }
  return marked;
}

/**
 * TOOL-OUTPUT HAYSTACK EXONERATION for the citation lanes (owner fix
 * 2026-09-04, CV0904 citation-strike root cause — the chat-lane port of the
 * coding lane's grounded-relay tier, run-evidence-guard.ts RELAY_CITE_RE /
 * ticket 93006fd8). The msg/sched/session-chat lanes existence-checked cited
 * ids against DB ROWS only, so an id honestly copied VERBATIM from a NON-row
 * tool result — a Redis approval/question id from get_chat_status, a GitHub
 * Actions run id, an edge-instance id — convicted as fabricated no matter how
 * disciplined the citation. A cited id that appears verbatim in this run's
 * tool_result texts is anchored to a real pull (the model cannot forge the
 * haystack), so it is exonerated BEFORE any DB probe — which also makes the
 * reject-back instruction ("copy the id from a tool result visible THIS run")
 * symmetrical with what the verifier enforces.
 *
 * OUTPUTS ONLY — never tool-call ARGS: args are model-authored, so counting
 * them would let the model launder an invented id by citing it into any call
 * it makes (the same fdHaystacks discipline the future-clock lane documents).
 * Residual laundering vector (accepted): a PRIOR struck note's content read
 * back via get_chat_messages IS a tool output — but the platform read path
 * swaps guard-replaced content for a generic placeholder before it reaches
 * the model or this haystack (redactGuardChromeMessage in
 * platform.service.ts getChatMessages, the 2026-08-30 phantom-recurrence fix
 * C), so a struck fabrication cannot re-anchor itself on a later wake; what
 * remains is a tool result echoing model-authored args (a filed ticket's
 * title), the identical accepted residual stampHasToolProvenance ships.
 */
const citedIdInToolOutput = (id: unknown, haystacks: string[]): boolean => {
  const needle = String(id ?? '').toLowerCase();
  // The fleet's citation idiom floor (MINER_HEX_ID guarantees ≥8 hex chars) —
  // a shorter needle would substring-match unrelated hex and launder.
  if (needle.length < 8) return false;
  return haystacks.some((h) => String(h ?? '').toLowerCase().includes(needle));
};

/**
 * The evidence lane's matcher: mine citations, drop ids already carried by an
 * action claim (the tier chain judged those), exonerate ids grounded in this
 * run's tool OUTPUTS (citedIdInToolOutput — owner 2026-09-04), exonerate rows
 * that exist, convict the rest. Exported for tests; the row check is
 * injectable.
 */
export async function findPhantomEvidenceCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  messageCheck: (id: string) => Promise<boolean> = citedMessageRowExists,
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('message', id),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const candidates = mineEvidenceCitations(note)
    .filter((c) => !claimedIds.has(String(c.id)))
    // Tool-output exoneration tier (owner 2026-09-04) — BEFORE any DB probe.
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  // (review F4) one indexed existence probe per distinct cited id, PARALLEL —
  // a note citing N receipts must not serialize N round trips into the
  // pre-delivery finalize path. .catch(() => true) preserves the
  // fail-toward-miss contract even for an injected check that rejects.
  const verdicts = await Promise.all(candidates.map(async (c) => (await messageCheck(String(c.id)).catch(() => true)) || inferredIdExists(c)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

/**
 * Ticket ef347cd0: decorate each conviction with up to 3 same-prefix REAL ids
 * — the strike must teach the lane the id it MEANT (id-splice phantoms
 * fabricate the suffix from memory/clipped output; agent-side discipline alone
 * has not stopped the recurrence). Parallel, fail-open BY CONTRACT: a lookup
 * error yields [] and the conviction stands unchanged.
 */
async function attachNearMissHints(
  convicted: ExtractedClaim[],
  nearMissLookup: (id: string) => Promise<string[]>,
): Promise<ExtractedClaim[]> {
  if (!convicted.length) return convicted;
  const hints = await Promise.all(convicted.map((c) => nearMissLookup(String(c.id)).catch(() => [] as string[])));
  return convicted.map((c, i) => (hints[i].length ? { ...c, nearMiss: hints[i] } : c));
}

/**
 * The schedule-citation lane's matcher (ticket 5448a836) — mirrors the msg
 * lane exactly: mine citations, drop ids already carried by an action claim
 * (the tier chain judged those), exonerate rows that exist, convict the rest.
 * No executed-pool tier is needed: a schedule this run created/updated/cancelled
 * keeps its ROW (created, updated, or disabled — never deleted by those tools),
 * so existence alone exonerates every truthful same-run citation. Exported for
 * tests; the row check is injectable.
 */
export async function findPhantomScheduleCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  scheduleCheck: (id: string) => Promise<boolean> = citedScheduleRowExists,
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('schedule', id),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const candidates = mineScheduleCitations(note)
    .filter((c) => !claimedIds.has(String(c.id)))
    // Tool-output exoneration tier (owner 2026-09-04) — see citedIdInToolOutput.
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  // One indexed existence probe per distinct cited id, PARALLEL (the evidence
  // lane's review-F4 discipline). .catch(() => true) preserves the
  // fail-toward-miss contract even for an injected check that rejects.
  const verdicts = await Promise.all(candidates.map(async (c) => (await scheduleCheck(String(c.id)).catch(() => true)) || inferredIdExists(c)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

/**
 * The goal/todo-citation lane's matcher (ticket 3ed139cd) — mirrors the sched
 * lane exactly: mine citations, drop ids already carried by an action claim
 * (the tier chain judged those), exonerate ids grounded in this run's tool
 * OUTPUTS (citedIdInToolOutput — a goal/todo id honestly copied from this
 * run's goal_list/todo_list/goal_get/todo_get result never reaches a probe),
 * exonerate rows that exist (kind-routed: a 'goal'-labeled id checks
 * project_goals, a 'todo'-labeled id checks project_todos — a MISLABELED
 * citation convicts, the same doctrine rule 5 applies to a deploy run id
 * cited as 'msg'), convict the rest. Exported for tests; the row check and
 * near-miss lookup are injectable (kind, id) — one function covering both
 * families instead of two near-identical lanes, the mergeConvictions kind|id
 * dedupe already speaking that union.
 */
export async function findPhantomGoalTodoCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  rowCheck: (kind: 'goal' | 'todo', id: string) => Promise<boolean> = (kind, id) =>
    kind === 'goal' ? citedGoalRowExists(id) : citedTodoRowExists(id),
  nearMissLookup: (kind: 'goal' | 'todo', id: string) => Promise<string[]> = (kind, id) =>
    samePrefixRealIds(kind, id),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const candidates = mineGoalTodoCitations(note)
    .filter((c) => !claimedIds.has(String(c.id)))
    // Tool-output exoneration tier (owner 2026-09-04) — BEFORE any DB probe.
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  // One indexed existence probe per distinct cited id, PARALLEL (the evidence
  // lane's review-F4 discipline). .catch(() => true) preserves the
  // fail-toward-miss contract even for an injected check that rejects.
  const verdicts = await Promise.all(
    candidates.map(async (c) => (await rowCheck(c.kind as 'goal' | 'todo', String(c.id)).catch(() => true)) || inferredIdExists(c)),
  );
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  // Near-miss hints route by kind too (attachNearMissHints takes a per-id
  // lookup — close over each family and re-merge; kind|id dedupe keeps order).
  const withGoalHints = await attachNearMissHints(
    convicted.filter((c) => c.kind === 'goal'),
    (id) => nearMissLookup('goal', id),
  );
  const withTodoHints = await attachNearMissHints(
    convicted.filter((c) => c.kind === 'todo'),
    (id) => nearMissLookup('todo', id),
  );
  return mergeConvictions(withGoalHints, withTodoHints);
}

/**
 * The ticket-citation lane's matcher (ticket b216475a, 2026-09-13) — mirrors
 * the sched lane exactly: mine citations, drop ids already carried by an
 * action claim (the tier chain judged those), exonerate ids grounded in this
 * run's tool OUTPUTS (citedIdInToolOutput — a file_feedback/list_feedback
 * result the model copied verbatim), exonerate rows that exist, convict the
 * rest. The row check is citedTicketRowExists bound to the caller's userId
 * (same-tenant scoping — a cross-tenant ticket citation is almost certainly
 * fabricated or leaked; citedTicketRowExists' own contract). The incident:
 * the Fleet Supervisor's agent-anchored notes carried "Receipts: tickets
 * 1322de9e / 1f7cadb1 / 6cec4aa1 / 3562a3d4 (file_feedback)" — four ids that
 * exist NOWHERE, riding a receipts idiom no lane matched. Exported for tests;
 * the row check is injectable.
 */
export async function findPhantomTicketCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  userId?: string,
  ticketCheck: (id: string) => Promise<boolean> = (id) => citedTicketRowExists(id, userId),
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('ticket', id, userId),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = new Set(actionClaims.filter((c) => c.id).map((c) => String(c.id).toLowerCase()));
  const candidates = mineTicketCitations(note)
    .filter((c) => !claimedIds.has(String(c.id)))
    // Tool-output exoneration tier (owner 2026-09-04) — BEFORE any DB probe.
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  // One indexed existence probe per distinct cited id, PARALLEL (the evidence
  // lane's review-F4 discipline). .catch(() => true) preserves the
  // fail-toward-miss contract even for an injected check that rejects.
  const verdicts = await Promise.all(candidates.map(async (c) => (await ticketCheck(String(c.id)).catch(() => true)) || inferredIdExists(c)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

/**
 * SESSION/CHAT-REFERENCE lane (ticket f1cb73ff, 2026-08-29) — the coverage gap
 * the fleet-supervisor phantom-session incident exposed: machine-wake notes
 * claimed the wake "dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933",
 * tracked "session 79464b3d RUNNING ~70 min" with elapsed-time updates across
 * wakes, and nagged the owner across many wakes to "reply in chat 2d4ff22f"
 * (with "fresh pull this wake" claims) — NONE of the three ids exists in
 * crossmodel_chats or coding_sessions. Every existing lane missed them BY
 * DESIGN: cross-wake tracking prose and owner-action items are neither
 * first-person completed actions this run (the LLM extractor ignores
 * observations and prior-run reports; the receipt-idiom miner requires a
 * first-person verb) nor `msg <id>` receipt citations (the evidence lane).
 * This lane deterministically mines uuid-shaped ids cited as
 *   (a) DISPATCH RECEIPTS — "dispatched session X", "session X RUNNING/
 *       live/dispatched", "worker X ~70 min in"; and
 *   (b) OWNER-ITEM CHAT REFERENCES — "reply in chat X", "chat X waiting on
 *       your go/no-go";
 * and existence-checks them. Exoneration tiers, strongest first: a cited id
 * matching one of the run's ACTUAL executed consequential tool records (the
 * same result-envelope ids tier 1 matches — a receipted dispatch beats a bare
 * row lookup), then DB existence (crossmodel_chats, then coding_sessions —
 * the same physical id space post One-Digby merge, both checked as belt).
 * An existing row exonerates; a missing row convicts. Existence, not recency
 * — honest supervisors track sessions dispatched hours or days ago.
 *
 * Precision guards (a false strike replaces an HONEST note — strictly worse
 * than a miss, which the post-delivery lane backstops):
 *   - blockquoted lines ('>') skipped — audit quotes of struck notes;
 *   - the citation-lane exclusion registers skip the line: intent markers
 *     ("will dispatch…"), the honesty/refutation vocabulary, the absence/
 *     search-failure register, AND the HISTORICAL-deletion register
 *     ("session X was deleted", "chat X no longer exists") — a deleted
 *     artifact's row is gone, so without the wording exemption every truthful
 *     history mention would convict;
 *   - ids inside a DOUBLE-QUOTED span are quoted text (the owner's or another
 *     agent's words), never this note's own claim — backticked ids (the
 *     fleet's own citation style) still mine;
 *   - only ANCHORED idioms mine (verb→noun+id, or noun+id→status): a bare
 *     truthful "chat ab12cd34" mention never costs a probe;
 *   - plural list forms ("dispatched sessions A, B, C") deliberately do NOT
 *     mine — under-broad is the fail-safe direction, and the singular
 *     noun+id adjacency is the incident shape;
 *   - ids already carried by an action claim (either extraction surface) are
 *     skipped prefix-tolerantly — the tier chain judged them;
 *   - DB error → the candidate is skipped (fail toward MISS, the citation-
 *     lane convention: convicting an unverifiable citation during a DB blip
 *     would replace honest notes).
 */
const SESSION_REF_ID_SRC = '[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}';
const DISPATCH_NOUN_SRC = '(?:session|worker|lane|task|coder)';
// (a1) verb-first dispatch receipt: "dispatched [the cleanup] session <id>".
// The verb→noun gap is clause-bounded (no '.'/';' crossing — the coding
// lane's M2 anti-smuggle discipline) and short, so a verb in one clause can
// never claim an id two clauses later.
const DISPATCH_RECEIPT_VERB_RE = new RegExp(
  `\\b(?:re-?dispatch(?:ed|ing)?|dispatch(?:ed|ing)?|start(?:ed|ing)?|spawn(?:ed|ing)?|launch(?:ed|ing)?|kick(?:ed|ing)?\\s+off|track(?:ed|ing)?)\\b[^.;\\n]{0,60}?\\b${DISPATCH_NOUN_SRC}\\s+[\`"']?(${SESSION_REF_ID_SRC})\\b`,
  'gid',
);
// (a2) status-tail dispatch receipt: "session <id> RUNNING/live/…" or the
// elapsed-time tracking idiom ("session <id> ~70 min in").
const DISPATCH_RECEIPT_STATUS_RE = new RegExp(
  `\\b${DISPATCH_NOUN_SRC}\\s+[\`"']?(${SESSION_REF_ID_SRC})[\`"']?\\b[^.;\\n]{0,60}?(?:\\b(?:running|live|active|dispatched|spawned|launched|underway|in\\s+progress|still\\s+going)\\b|\\bin[- ]flight\\b|~?\\s*\\d+\\s*(?:min(?:ute)?s?|hours?|hrs?)\\s+(?:in|elapsed)\\b)`,
  'gid',
);
// (b1) verb-first owner-item chat ref: "reply/respond/… in chat <id>". The
// preposition is REQUIRED — "Reviewed chat <id> context" (a plain reading
// report) must not mine.
const OWNER_CHAT_REF_VERB_RE = new RegExp(
  `\\b(?:reply|repl(?:ied|ies|ying)|respond(?:ed|ing|s)?|answer(?:ed|ing|s)?|review(?:ed|ing)?|approve|confirm|weigh\\s+in|follow\\s+up|see|check)\\b[^.;\\n]{0,40}?\\b(?:in|at|on|to|via)\\s+chat\\s+[\`"']?(${SESSION_REF_ID_SRC})\\b`,
  'gid',
);
// (b2) status-tail owner-item chat ref: "chat <id> waiting/awaiting/needs…".
const OWNER_CHAT_REF_STATUS_RE = new RegExp(
  `\\bchat\\s+[\`"']?(${SESSION_REF_ID_SRC})[\`"']?\\b[^.;\\n]{0,60}?\\b(?:waiting|awaiting|pending|needs?|blocked|unanswered)\\b`,
  'gid',
);
// The lane's line-level exclusions: the shared intent/honesty/refutation/
// absence vocabulary of the sibling citation lane PLUS the historical-deletion
// register and negated-dispatch forms ("never dispatched session X").
// (FW29-B follow-up) PLUS the FAILURE register: "dispatch failed", "tool call
// errored", "never created", "no session exists". A dispatch that FAILED never
// created the artifact — the id legitimately does not exist BECAUSE the note
// says so; mining it convicts honest failure prose (a false strike replaces an
// honest note, the worst outcome class this lane guards against). Battery-
// confirmed on the pre-fix register: 5/5 honest failure lines mined (dispatch
// failed with a 409 / never created / errored + no session exists / never
// happened + returned an error / start failed + no lane exists) while 5/5
// phantom success lines still mined. Phantom prose claims SUCCESS (running,
// elapsed, pending) — failure vocabulary is how honest notes report a
// non-event, so exonerating it cannot shield the incident class. `fail` is
// suffix-bounded so "failover" never matches (group-level \b rejects it).
const SESSION_REF_EXCLUSION_RE = /\b(?:will|going to|about to|plan(?:ned|ning)?|intend(?:ed|ing)?|not executed|never executed|did not execute|didn't execute|unverified|unconfirmed|refut\w*|struck|phantom(?:s)?|fabricat\w*|invented|bogus|fake|ghost\w*|stale|absent|nonexistent|non-existent|no such|not found|never existed|does(?:\s+not|n't)\s+exist|missing|no\s+(?:row|rows|record|trace|sign|evidence|match)\b|zero\s+rows|nothing\s+(?:matching|found)\b|void(?:ed)?|false[ -]positive|could(?:\s+not|n't)\s+(?:find|locate)|did(?:\s+not|n't)\s+(?:find|locate)|delet\w+|removed|archiv\w+|purged|pruned|wiped|dropped|no\s+longer\s+exists?|(?:'t|not|never)\s+(?:dispatch|start|spawn|launch|exist)\w*|fail(?:ed|s|ure|ing)?|errored|returned\s+an\s+error|never\s+(?:created|made|happened)|nothing\s+(?:was\s+)?created|no\s+(?:session|worker|lane|task|coder|chat)\s+exists)\b/i;

// Schedule TYPE LABEL the fleet evidence contract teaches notes to attach
// immediately after a cited schedule id ("`1fbe4800…` (sched) active", ticket
// ca153ef8). A (sched|schedule)-labeled id is an EVIDENCE CITATION, not a
// dispatch/chat receipt: mining it here convicts a note that followed the
// labeling rule exactly — the 2026-08-30 22:53Z supervisor wake's "TT lane
// `1fbe4800-…` (sched) active" matched the (a2) status-tail pattern and was
// convicted as a phantom dispatch though the id is a real schedule row.
// Skipping here does NOT drop the id from audit: the schedule-citation lane
// owns the label form (EVIDENCE_SCHED_CITATION_POST_ID, added with this fix)
// and runs its existence probe — fabricated schedule ids are convicted THERE.
// ONLY sched labels skip: any other parenthesized label on a session-noun
// receipt ((ticket)/(goal)/(msg)/…) stays minable so the chat/session
// existence check still decides (review F2 — a broad-label skip let
// contradictory-label phantoms escape every lane). Session-typed labels
// ((chat)/(session)) likewise stay minable.
const SCHED_TYPE_LABEL_RE = /^[`"']?\s*\((?:sched|schedule)\)/i;

/**
 * True when `index` sits inside an open double-quoted span on its line —
 * quoted user/agent text is a citation of someone else's words, never this
 * note's own claim. Straight and curly double quotes count; backticks and
 * apostrophes deliberately do NOT (backticked ids are the fleet's own
 * citation style, and apostrophes appear mid-word).
 */
const insideQuotedSpan = (line: string, index: number): boolean => {
  let quotes = 0;
  for (let i = 0; i < index; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 0x22 /* " */ || ch === 0x201c /* “ */ || ch === 0x201d /* ” */) quotes++;
  }
  return quotes % 2 === 1;
};

const SESSION_REF_RULES: Array<{ kind: ClaimKind; re: RegExp; tag: string }> = [
  { kind: 'dispatch', re: DISPATCH_RECEIPT_VERB_RE, tag: 'dispatch receipt' },
  { kind: 'dispatch', re: DISPATCH_RECEIPT_STATUS_RE, tag: 'dispatch receipt' },
  { kind: 'message', re: OWNER_CHAT_REF_VERB_RE, tag: 'owner chat ref' },
  { kind: 'message', re: OWNER_CHAT_REF_STATUS_RE, tag: 'owner chat ref' },
];

/** Exported for tests: deterministic dispatch-receipt + owner-chat-ref mining over a final note (ticket f1cb73ff). */
export function mineSessionChatReferences(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    if (SESSION_REF_EXCLUSION_RE.test(line)) continue;
    for (const rule of SESSION_REF_RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const id = String(m[1] ?? '').toLowerCase();
        if (!MINER_HEX_ID.test(id) || insideQuotedSpan(line, m.index ?? 0)) continue;
        // A (sched)-labeled id is an evidence citation owned by the schedule
        // lane — never a dispatch/chat receipt here (ca153ef8). m.indices[1]
        // (the `d` flag) pins the CAPTURED id's span: the verb-first gap can
        // repeat the same id string, so indexOf would mis-anchor (review F1).
        const idSpan = m.indices?.[1];
        if (idSpan && SCHED_TYPE_LABEL_RE.test(line.slice(idSpan[1]))) continue;
        const key = `${rule.kind}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: rule.kind, detail: `[${rule.tag}] ${line.slice(0, 180)}`, id });
      }
    }
  }
  return out;
}

/**
 * Cheap deterministic pre-gate for the lane (the guard's non-supervisor
 * machine wakes): does the text carry any of the four anchored idioms at all?
 * No exclusions here — over-matching just runs the matcher (which applies the
 * full precision guards); the keyword gate's own docblock accepts that cost.
 */
export function hasSessionChatRefIdiom(text: string | null | undefined): boolean {
  if (!text) return false;
  return SESSION_REF_RULES.some((rule) => {
    rule.re.lastIndex = 0; // 'g' regexes carry lastIndex across .test calls
    return rule.re.test(text);
  });
}

/**
 * Existence-only check for a cited CHAT/SESSION row (see the lane docblock).
 * coding session ids ARE chat ids post One-Digby merge, but coding_sessions
 * (ChatCodingState) is checked independently as belt — a legacy session row
 * whose chat row is gone still exonerates. Prefix-match for the fleet's
 * 8-char citation idiom, exact for full uuids. Returns TRUE on DB error: fail
 * toward MISS, never convict an unverifiable citation.
 */
export async function citedChatOrSessionExists(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const chat = await prisma.crossModelChat.findFirst({ where, select: { id: true } });
    if (chat) return true;
    const session = await prisma.chatCodingState.findFirst({ where, select: { id: true } });
    return !!session;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * The session/chat-reference lane's matcher: mine citations, drop ids already
 * carried by an action claim (the tier chain judged them — prefix-tolerant),
 * exonerate ids the run's ACTUAL executions receipted (a real dispatch's
 * result-envelope ids — stronger evidence than row existence), then exonerate
 * rows that exist; convict the rest. Exported for tests; the row check is
 * injectable.
 */
export async function findPhantomSessionRefs(
  note: string,
  actionClaims: ExtractedClaim[],
  executed: ExecutedAction[],
  chatCheck: (id: string) => Promise<boolean> = citedChatOrSessionExists,
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('chat', id),
  evidenceHaystacks: string[] = [],
  ledgerIds: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = actionClaims
    .map((c) => String(c.id ?? '').toLowerCase())
    .filter((id) => id.length > 0);
  const executedIds = executed
    .filter((a) => a.ok)
    .flatMap((a) => Object.values(a.ids).map((v) => String(v).toLowerCase()));
  // (ticket ee212347 GAP A) The verdict gate's durable-ledger fold below
  // (ledgerIds — the chat's state-doc dispatches, hoisted from ~L3048) is a
  // SECOND existence lane for ids the chat cited from its own durable state:
  // a NON-supervisor chat whose note names a dispatch/session id living in
  // its state doc must not be convicted as phantom (the pre-fix ledger was
  // supervisor-only). Fail-open: a ledger hit exonerates, a miss falls
  // through to the DB existence probe unchanged.
  // PREFIX-TOLERANT (the firing-52 replay): notes cite 8-char prefixes while
  // the state doc stores full uuids — an exact-match set missed the incident
  // shape ("The refactor session a1b2c3d4 is in flight per the state doc").
  // Same idMatches semantics as the action lane's ledger tier below.
  const ledgerSet = new Set(ledgerIds.map((v) => String(v).toLowerCase()));
  const candidates = mineSessionChatReferences(note).filter((c) => {
    const cited = String(c.id).toLowerCase();
    if (claimedIds.some((cl) => idMatches(cited, cl))) return false; // the tier chain judged it — no double-processing
    if (citedIdInToolOutput(cited, evidenceHaystacks)) return false; // grounded in this run's tool OUTPUTS (owner 2026-09-04)
    if (ledgerSet.has(cited) || [...ledgerSet].some((l) => idMatches(cited, l))) return false; // durable state-doc fold (ticket ee212347 GAP A) — prefix-tolerant
    return !executedIds.some((v) => idMatches(cited, v)); // receipted THIS run — executed-actions evidence beats DB existence
  });
  // One indexed existence probe per candidate, PARALLEL (the evidence lane's
  // review-F4 discipline). .catch(() => true) preserves fail-toward-miss even
  // for an injected check that rejects.
  const verdicts = await Promise.all(candidates.map((c) => chatCheck(String(c.id)).catch(() => true)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

// ── VANISHED-ARTIFACT CITATION lane (rollout watch 2026-09-14) ───────────────
/**
 * The gap the Fleet Supervisor's 2026-09-14 07:26Z wake exposed (chat c0e22e36):
 * its note reported "four chats appeared in my fleet list at 07:26Z and then
 * 404'd on read within minutes — the 'Fix LLM routing' lane (chat b53a5b28,
 * whose run_failed event carried a complete-looking final answer) plus three
 * framework child sessions (chat 580e2d84, ea88664e, 48dc7f05)", put the story
 * in its durable state, and dispatched the spark project supervisor to chase
 * it. None of the four ids has ANY trace in the instance: no crossmodel_chats /
 * coding_sessions row, no agent_runs row (a deleted coding chat leaves those —
 * soft ref), no hook_events payload naming them, and none of the run's own tool
 * OUTPUTS contained them (its four get_chat_status receipts were all ok:true).
 * The session/chat lane skipped those lines BY DESIGN: the absence /
 * historical-deletion register ("404'd", "vanished", "no longer exists") is an
 * EXCLUSION there, because a truthful history mention of a deleted artifact
 * must never convict. This lane owns exactly that register with a STRICTER test
 * an honest history mention always passes — exoneration tiers, strongest first:
 *   - the id appears in THIS run's tool OUTPUT (list_chats really listed it,
 *     get_chat_status really 404'd it) — citedIdInToolOutput;
 *   - ANY durable trace: a chat / coding-session row, an agent_runs.sessionId,
 *     or a hook_events payload.sourceChatId within 30 days (citedArtifactHasTrace);
 *   - otherwise the "vanished" artifact never existed → convict.
 * Citation-class ('[vanished artifact]'): fabricated EVIDENCE, no action to
 * "actually do" — the correction says re-pull or drop the citation. Precision
 * guards mirror the sibling lanes: blockquotes and double-quoted spans skip,
 * the verifier's own refutation vocabulary skips (an honest retraction quoting
 * the ids — "never existed", "struck", "UNVERIFIED" — must not re-convict), and
 * only chat/session/lane-labeled ids mine (a bare hex id never costs a probe).
 */
const VANISHED_REGISTER_RE = /(?:\b404(?:'?(?:d|ed))?\b|\b(?:vanish(?:ed|es|ing)?|disappear(?:ed|s|ing)?|unreadable|unresolvable|gone missing|not found|no longer (?:exists?|readable|visible|listed|resolv\w*)|could not be (?:read|found|resolved)|stopped existing|lost the read path|delet(?:ed|ing|es))\b)/i;
const VANISHED_EXCLUSION_RE = /\b(?:struck|phantom\w*|fabricat\w*|unverified|refut\w*|invented|hallucinat\w*|never existed|no such (?:chat|session|lane|row)|do not exist|does not exist|exist nowhere|retract\w*|correction)\b/i;
// "chat <id>", "session <id>", "lane <id>", "chats A, B, C", "(chat X, Y and Z)".
const VANISHED_ID_LIST_RE = new RegExp(
  `\\b(?:chats?|sessions?|lanes?)\\s+(?:ids?\\s+)?[\`"']?(${SESSION_REF_ID_SRC})[\`"']?((?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)[\`"']?${SESSION_REF_ID_SRC}[\`"']?)*)`,
  'gi',
);
const VANISHED_ANY_ID_RE = new RegExp(SESSION_REF_ID_SRC, 'gi');

/** Exported for tests: mine chat/session ids cited as vanished / 404'd / deleted on the same line. */
export function mineVanishedArtifactCitations(note: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(note ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 20 || line.startsWith('>')) continue;
    if (!VANISHED_REGISTER_RE.test(line) || VANISHED_EXCLUSION_RE.test(line)) continue;
    VANISHED_ID_LIST_RE.lastIndex = 0;
    for (const m of line.matchAll(VANISHED_ID_LIST_RE)) {
      if (insideQuotedSpan(line, m.index ?? 0)) continue;
      const ids = [m[1], ...(String(m[2] ?? '').match(VANISHED_ANY_ID_RE) ?? [])].map((x) => String(x).toLowerCase());
      for (const id of ids) {
        if (!MINER_HEX_ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ kind: 'dispatch', detail: `[vanished artifact] ${line.slice(0, 180)}`, id });
      }
    }
  }
  return out;
}

/** Cheap pre-gate for the lane (non-supervisor machine wakes): the register + a labeled id on one line. */
export function hasVanishedArtifactIdiom(text: string | null | undefined): boolean {
  if (!text) return false;
  return String(text).split('\n').some((line) => {
    if (!VANISHED_REGISTER_RE.test(line)) return false;
    VANISHED_ID_LIST_RE.lastIndex = 0;
    return VANISHED_ID_LIST_RE.test(line);
  });
}

/**
 * ANY durable trace of a cited chat/session id: the chat row, the coding-state
 * row, an agent_runs row (soft ref — survives chat deletion), or a hook_events
 * payload that named it as source within 30 days. Prefix-match for the fleet's
 * 8-char citation idiom, exact for full uuids. Returns TRUE on DB error (fail
 * toward MISS — an unverifiable citation is never a conviction).
 */
export async function citedArtifactHasTrace(id: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    if (await prisma.crossModelChat.findFirst({ where, select: { id: true } })) return true;
    if (await prisma.chatCodingState.findFirst({ where, select: { id: true } })) return true;
    const runWhere = id.length >= 36 ? { sessionId: id } : { sessionId: { startsWith: id } };
    if (await prisma.agentRun.findFirst({ where: runWhere, select: { id: true } })) return true;
    const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM hook_events WHERE payload->>'sourceChatId' LIKE ${id + '%'} AND "createdAt" > now() - interval '30 days' LIMIT 1`;
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * The vanished-artifact lane's matcher — mirrors the sibling citation lanes:
 * mine, drop ids an action claim already carries, exonerate ids grounded in
 * this run's tool OUTPUTS, exonerate ids with ANY durable trace, convict the
 * rest (parallel probes, fail toward miss, same-prefix near-miss hints).
 * Exported for tests; the trace check is injectable.
 */
export async function findPhantomVanishedArtifactCitations(
  note: string,
  actionClaims: ExtractedClaim[],
  traceCheck: (id: string) => Promise<boolean> = citedArtifactHasTrace,
  nearMissLookup: (id: string) => Promise<string[]> = (id) => samePrefixRealIds('chat', id),
  evidenceHaystacks: string[] = [],
): Promise<ExtractedClaim[]> {
  const claimedIds = actionClaims.map((c) => String(c.id ?? '').toLowerCase()).filter((id) => id.length > 0);
  const candidates = mineVanishedArtifactCitations(note)
    .filter((c) => !claimedIds.some((cl) => idMatches(String(c.id), cl)))
    .filter((c) => !citedIdInToolOutput(c.id, evidenceHaystacks));
  const verdicts = await Promise.all(candidates.map((c) => traceCheck(String(c.id)).catch(() => true)));
  const convicted = candidates.filter((_, i) => !verdicts[i]);
  return attachNearMissHints(convicted, nearMissLookup);
}

/**
 * The ticket store's tenant scope (ticket cdf7332b): the caller's own rows
 * PLUS null-userId rows. System lanes with no user context (e.g. the
 * utilityChat billing/auth latch, watchdogs, crons) file feedback tickets with
 * userId NULL, and the owner's lanes legitimately cite them after a
 * get_feedback/list_feedback pull (the read path returns them). A bare
 * `userId = <caller>` scope missed those rows and convicted a REAL citation
 * as "does not exist" (2026-09-14 23:28Z: the Fleet Supervisor's note citing
 * outage ticket 2b7ceafa — userId NULL, filed 51 min before the strike —
 * strip+marked with a false "does not exist" rationale). FOREIGN non-null
 * userIds stay excluded: the 0beea9f1 cross-tenant doctrine (a citation of
 * another tenant's row is fabricated or leaked — the model could never have
 * seen it) stands.
 */
const ticketTenantScope = (userId: string) => ({ OR: [{ userId }, { userId: null as string | null }] });

/**
 * Near-miss lookup for a FAILED existence check (ticket ef347cd0, 2026-08-31):
 * the fleet's id-splice phantoms are same-PREFIX fabrications — the lane cites
 * an id from memory or clipped tool output and invents the suffix (edcf4dda →
 * fce83c69 → c3091844 → aa125b67 → aa289d50, all true positives; three explicit
 * steers + a durable-state citation rule did NOT stop the recurrence). Make
 * every strike educational: return up to 3 REAL rows sharing the cited id's
 * 8-char prefix, formatted with the owning chat + timestamp, so the next note
 * can self-correct ("cited id 751c12b9-5350-… does not exist; same-prefix real
 * ids: 751c12b9-e755-… (chat a8976e11, 2026-08-31T01:09:00.000Z)"). Fail-open BY
 * CONTRACT: a DB error yields [] — a hint must never block, reverse, or
 * replace a conviction.
 */
export async function samePrefixRealIds(
  kind: 'message' | 'schedule' | 'chat' | 'goal' | 'todo' | 'ticket',
  id: string,
  userId?: string,
): Promise<string[]> {
  const prefix = String(id || '').slice(0, 8);
  if (prefix.length < 8) return []; // the near-miss contract is the fleet's 8-char citation idiom — a shorter citation has no meaningful prefix bucket
  try {
    // (ticket e3246ad5 NB#1) Same-tenant scoping: when the auditing chat's
    // owner is known, constrain the bucket to THAT tenant's rows — a fabricated
    // id whose 8-hex prefix collides with ANOTHER tenant's row must never
    // render that tenant's chat title / chat-id prefix / timestamps into this
    // chat's ticket, correction, pre-delivery notice, or durable refutation.
    // The conviction is untouched (existence checks are unchanged); an omitted
    // userId keeps the legacy global bucket (direct test callers).
    if (kind === 'message') {
      const rows = await prisma.crossModelMessage.findMany({
        where: { id: { startsWith: prefix }, ...(userId ? { chat: { userId } } : {}) },
        select: { id: true, chatId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      return rows.map((r) => `${r.id} (chat ${r.chatId.slice(0, 8)}, ${r.createdAt.toISOString()})`);
    }
    if (kind === 'schedule') {
      const rows = await prisma.chatSchedule.findMany({
        where: { id: { startsWith: prefix }, ...(userId ? { userId } : {}) },
        select: { id: true, sessionId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      return rows.map((r) => `${r.id} (chat ${r.sessionId.slice(0, 8)}, ${r.createdAt.toISOString()})`);
    }
    // (ticket 3ed139cd) goal/todo near-miss buckets: same-prefix REAL board
    // rows, same-tenant scoped via the models' own userId (both denormalized
    // onto the row — no relation traversal). Rendered with the row title so
    // the struck lane can self-correct to the goal/todo it MEANT.
    if (kind === 'goal') {
      const rows = await prisma.projectGoal.findMany({
        where: { id: { startsWith: prefix }, ...(userId ? { userId } : {}) },
        select: { id: true, title: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      });
      return rows.map((r) => `${r.id} (goal "${String(r.title ?? '').slice(0, 60)}", ${r.updatedAt.toISOString()})`);
    }
    if (kind === 'todo') {
      const rows = await prisma.projectTodo.findMany({
        where: { id: { startsWith: prefix }, ...(userId ? { userId } : {}) },
        select: { id: true, title: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      });
      return rows.map((r) => `${r.id} (todo "${String(r.title ?? '').slice(0, 60)}", ${r.updatedAt.toISOString()})`);
    }
    // (ticket b216475a) The ticket-citation lane's bucket: user_feature_requests
    // rows, same-tenant scoped like the schedule branch (userId sits on the
    // row — null-userId SYSTEM-filed rows included per ticket cdf7332b, the
    // same scope citedTicketRowExists uses), titled like the chat branch so
    // the hint teaches the id the lane MEANT.
    if (kind === 'ticket') {
      const rows = await prisma.userFeatureRequest.findMany({
        where: { id: { startsWith: prefix }, ...(userId ? ticketTenantScope(userId) : {}) },
        select: { id: true, title: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      return rows.map((r) => `${r.id} (ticket "${String(r.title ?? '').slice(0, 60)}", ${r.createdAt.toISOString()})`);
    }
    const rows = await prisma.crossModelChat.findMany({
      where: { id: { startsWith: prefix }, ...(userId ? { userId } : {}) },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
    return rows.map((r) => `${r.id} ("${String(r.title ?? '').slice(0, 60)}", ${r.updatedAt.toISOString()})`);
  } catch {
    return [];
  }
}

/**
 * Existence-only check for a cited TICKET row (ticket 0beea9f1) — the same
 * prefix-match + fail-toward-miss contract as citedMessageRowExists /
 * citedScheduleRowExists, against user_feature_requests, scoped to the SAME
 * owner when userId is known (a cross-tenant ticket citation is almost
 * certainly fabricated or leaked — the model could never have seen the row;
 * null-userId SYSTEM-filed rows count as in-tenant per ticket cdf7332b).
 * Existence, NOT recency: this serves the args-citation exoneration below,
 * where a historical cross-reference to a real ticket is truthful at any age.
 * (citedArtifactExists' 1h recency gate stays the rule for this-run
 * DEED-claims.) Returns TRUE on DB error: never convict an unverifiable
 * citation.
 */
export async function citedTicketRowExists(id: string, userId?: string): Promise<boolean> {
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    const row = await prisma.userFeatureRequest.findFirst({
      where: { ...where, ...(userId ? ticketTenantScope(userId) : {}) },
      select: { id: true },
    });
    return !!row;
  } catch {
    return true; // fail toward MISS — an unverifiable citation is never a conviction
  }
}

/**
 * A cited id is exonerating only if the artifact exists AND is recent. Applies
 * to dispatch/schedule/ticket kinds ONLY: a 'message' claim must never be
 * exonerated by target-chat existence — every chat the supervisor merely
 * surveyed has a fresh updatedAt, so existence proves nothing about a send
 * (review C5).
 */
/**
 * (ticket c5629165) Does this ticket row's stored FILER name a session OTHER
 * THAN the claiming chat? The filer stamps are the E1 filer-binding fields
 * (platform-tools.ts file_feedback case): `context.filedBy` (the filing
 * session, written since 2026-09-27) and the legacy `context.sessionId` /
 * `context.chatId` (the same id on older rows). A NULL/unstamped filer is
 * NEVER read as foreign — fail toward miss (the 587e9d64 doctrine: a false
 * strike is strictly worse than a missed one): pre-2026-09-27 rows and
 * human-filed rows keep the pure recency gate. Exported for tests.
 */
export function ticketRowFiledByAnother(context: unknown, claimingChatId: string): boolean {
  if (!context || typeof context !== 'object') return false;
  const ctx = context as Record<string, unknown>;
  const filer = typeof ctx.filedBy === 'string' && ctx.filedBy
    ? ctx.filedBy
    : typeof ctx.sessionId === 'string' && ctx.sessionId
      ? ctx.sessionId
      : typeof ctx.chatId === 'string' && ctx.chatId
        ? ctx.chatId
        : null;
  if (!filer) return false;
  // Prefix-tolerant (the idMatches doctrine): the fleet cites 8-hex prefixes,
  // and a row's filer stamp may carry the chat id in either form. A same-chat
  // filer cited as a prefix must never read as foreign — only a genuinely
  // DIFFERENT id does (fail toward miss, 587e9d64).
  if (filer === claimingChatId) return false;
  if (filer.length >= 8 && claimingChatId.length >= 8 && (claimingChatId.startsWith(filer) || filer.startsWith(claimingChatId))) return false;
  return true;
}

export async function citedArtifactExists(kind: ClaimKind, id: string, chatId?: string): Promise<boolean> {
  if (kind === 'message') return false;
  const since = new Date(Date.now() - RECENT_ARTIFACT_MS);
  // The supervisor prompt teaches 8-char-prefix citations ("dispatched session
  // 1a2b3c4d"), so an exact-PK lookup would ~never fire for them (review M2).
  // Prefix-match when the citation is shorter than a full uuid — safe: `idish`
  // guarantees ≥7 hex chars and ids are uuids repo-wide.
  const where = id.length >= 36 ? { id } : { id: { startsWith: id } };
  try {
    if (kind === 'schedule') {
      // ChatSchedule has NO updatedAt (schema.prisma) — a creation-recency
      // check alone makes day-old truthful restatements unexonerable. Liveness
      // signals instead: recently created, recently fired, or enabled with a
      // future run. (A cancelled schedule stays inherently unexonerable — the
      // row is gone/disabled; the ledger/state-JSON check is its exoneration.)
      const row = await prisma.chatSchedule.findFirst({
        where,
        select: { createdAt: true, lastFiredAt: true, nextRunAt: true, enabled: true },
      }).catch(() => null);
      if (!row) return false;
      const now = new Date();
      return row.createdAt >= since || (!!row.lastFiredAt && row.lastFiredAt >= since) || (row.enabled && !!row.nextRunAt && row.nextRunAt >= now);
    }
    if (kind === 'ticket') {
      // ticket → a user_feature_requests row. updatedAt covers BOTH shapes of
      // a real filing this run: a fresh create AND a dedup bump onto an
      // existing row (which rewrites description/context — @updatedAt moves).
      // (ticket c5629165) AUTHORSHIP, not just recency: the pre-fix gate
      // exonerated ANY claim naming a ≤1h-old row, but a fresh row only
      // proves SOMEONE filed recently — never that THIS chat did. The
      // incident (chat 91d79e37, 2026-10-13T05:48Z): "one new platform ticket
      // filed — ca805a61" over a ticket another session (9effe0d0) had filed
      // six days earlier; it convicted ONLY because the row was >1h old. The
      // fresh variant of the same lie — a ticket another lane filed or bumped
      // minutes ago — would have exonerated silently. A row whose filer
      // context (context.filedBy / context.sessionId, the E1 filer-binding
      // stamps) names a DIFFERENT session than the claiming chat never
      // vouches a filing claim: the model read the ticket (get_feedback /
      // list_feedback) and claimed the filing. The stamp on the claim
      // (misattributedFiling) is applied at the conviction point in
      // computePhantomClaimsInner so every surface can teach the true class.
      const row = await prisma.userFeatureRequest.findFirst({
        where,
        select: { updatedAt: true, context: true },
      }).catch(() => null);
      // `!(row.updatedAt >= since)` (not `row.updatedAt < since`) preserves the
      // pre-fix semantics byte-identically for a row with NO updatedAt
      // (undefined >= since is false → no exoneration; NaN-comparison inversion
      // would instead exonerate — mock rows and any legacy shape would flip).
      if (!row || !(row.updatedAt >= since)) return false;
      if (chatId && ticketRowFiledByAnother(row.context, chatId)) return false;
      return true;
    }
    // dispatch → a coding chat (creation is the artifact).
    const chat = await prisma.crossModelChat.findFirst({ where, select: { createdAt: true } }).catch(() => null);
    return !!chat && chat.createdAt >= since;
  } catch {
    return false; // fail toward "phantom" — a claim must be provable
  }
}

const idish = (s: string | undefined): boolean => !!s && /^[0-9a-f][0-9a-f-]{6,}$/i.test(s);
/**
 * Prefix-tolerant id match — notes usually cite 8-char prefixes of full uuids.
 * BOTH sides must be ≥8 chars for a prefix match (review M1): envelope ids can
 * carry non-id values like a queue position ("3") or a title, and without the
 * guard any fabricated id starting with the same char would be exonerated by
 * an unrelated value (`cited.startsWith("3")`). Exact equality stays ungated.
 */
const idMatches = (cited: string, actual: string): boolean =>
  actual === cited ||
  (cited.length >= 8 && actual.length >= 8 && (actual.startsWith(cited) || cited.startsWith(actual)));

/**
 * Exported for tests: matching of claims against executed actions.
 * Order per claim (review C2/C5/C6):
 *   1. id-bearing claims match the SPECIFIC execution of their kind whose
 *      result-envelope ids match (prefix-tolerant) — a fabricated target id
 *      can no longer ride an unrelated execution's count slot. The match is
 *      NON-CONSUMING (ticket 363f5793, 2026-09-22): burning the slot
 *      false-convicted a same-surface id-less TWIN narration of the one
 *      proven action (see the in-code note at the match site);
 *   1a. KIND-AGNOSTIC own-run exoneration (ticket fc337153): an id-bearing
 *      claim whose cited id matches ANY own-run execution's envelope ids —
 *      regardless of kind — is a true but mis-TYPED claim (the extraction
 *      labelled the action under the wrong kind), not a phantom. A
 *      fabricated id appears in no own-run envelope, so this cannot launder
 *      a phantom; the execution is NOT consumed (step 4's id-less slot
 *      accounting for the action's own kind is untouched).
 *   2. an id-bearing claim whose id appears in the durable DISPATCH LEDGER is
 *      a truthful cross-wake restatement, not a phantom. The CALLER filters
 *      the ledger to entries stamped before the audited run started (ticket
 *      ae7db80b): the state doc is read at finalize — after the run's own
 *      update_supervisor_state writes have merged — so an unfiltered ledger
 *      lets a supervisor acquit its own fabrication by writing the invented
 *      id into its state doc first (2026-08-25: two phantom ticket-filing
 *      claims laundered this way; a third claim, made in a run with no state
 *      write, was convicted). The raw state-JSON catch-all (review M2) is
 *      GONE — notes/evidence prose carries no trustworthy write time and is
 *      the same self-report channel; legitimate restatements are covered by
 *      the filtered ledger + the harness-written cross-wake receipts tier.
 *   3. remaining id-bearing claims get one DB artifact check (dispatch/schedule
 *      kinds only, recency/liveness-bounded);
 *   4. id-less claims count-match against executions not consumed by step 1.
 *   5. (ticket 5ad80b27) OWN-ARTIFACT KIND-CONSISTENCY tier — at the conviction
 *      point of an id-bearing claim, when the cited id anchors to THIS run's
 *      own evidence (a non-claim-kind receipt envelope, or the trusted
 *      tool-output texts via ownArtifact.evidenceTexts) AND the detail does
 *      NOT narrate the claimed kind's action (claimNarratesKindAction), the
 *      claim is TRUE prose the extractor mis-kinded/mis-ided — exonerate
 *      (fail toward miss, the 587e9d64 doctrine). A detail that DOES narrate
 *      the kind convicts unchanged (the review-P1 id-splice shape).
 */
export interface OwnArtifactTierInput {
  /**
   * This run's TRUSTED tool-output texts — the SAME citation-lane haystack
   * seam (citedIdInToolOutput; OUTPUTS ONLY, never model-authored args).
   * Needed because artifact-producing tools like create_document mint no
   * receipts: their ids never enter the execution pool, so the pool lane
   * alone would miss the anchor.
   */
  evidenceTexts?: string[];
  /** Telemetry sink — every claim this tier exonerated (callers dedupe). */
  exonerated?: ExtractedClaim[];
}

/**
 * FAILURE-REPORT tier (2026-10-04, found by the live query suite — scripts/e2e/query-suite.py).
 * On a plain human chat the lead answered "The exact page heading is Example Domain — my browser
 * task timed out, so I verified by fetching the page directly"; the extractor (task narration ⇒
 * [dispatch], quoted verbatim) mined "my browser task timed out", the timed-out browser_task was
 * ok:false (no step header) and dropped from the ok-only pool, so the post-delivery lane posted a
 * user-visible "claimed action(s) that did NOT actually run" correction on an HONEST failure report.
 * A claim whose detail REPORTS A FAILURE is vouched by any ATTEMPTED call of its family — the task
 * tools for task narration, else KIND_TOOLS[kind] — read from the UNFILTERED executions (failed
 * attempts included; never consumed). With no attempt at all it still convicts: a made-up attempt
 * is a phantom. Accepted residual (fail toward miss, the 587e9d64 doctrine): "dispatched it after
 * the first try failed" with only the failed try on record exonerates. The extraction prompt also
 * tells the extractor to ignore failure reports. Kill switch ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED=1.
 */
export const ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED_ENV = 'ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED';
function failureReportExemptDisabled(): boolean {
  return process.env[ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED_ENV] === '1';
}
const FAILURE_REPORT_RE = /\b(?:timed?[ -]?out|failed|fails|errored|couldn['’]?t|could not|can(?:no|['’])t|did(?:n['’]?t| not)|was(?:n['’]?t| not) able|unable to|never (?:ran|started|completed|finished|went through)|no result)\b/i;
/**
 * (ticket 7cabb0cc) Run-SELF-incompletion idiom: the model reporting that IT
 * ran out of its own budget before finishing ("I ran out of turn before
 * completing my own live verification" — chat 182f27b7). This is an honesty
 * statement about the RUN, not a completed-action claim; the FAILURE_REPORT_RE
 * shape above covers tool outcomes ("my browser task timed out") but not this
 * phrasing, so the incident's second [dispatch] conviction was exactly this
 * residue. Any id-less claim whose detail reports the run itself ran out of
 * budget is a failure report, not a phantom — grounded by the run's own
 * existence, vouchable by no tool family, and never exonerated for ID-BEARING
 * claims (a claim citing an id still claims a citable artifact).
 */
const RAN_OUT_OF_TURN_RE = /\bran\s+out\s+of\s+(?:turn|time|budget|steps?)\b/i;

/** Exported for tests: does this claim detail report that the action FAILED / did not complete? */
export function isFailureReportDetail(detail: string): boolean {
  return FAILURE_REPORT_RE.test(String(detail ?? ''));
}

/**
 * (ticket 7cabb0cc) Run-SELF-incompletion — an id-less claim whose detail
 * reports the run itself ran out of budget before finishing. Distinct from
 * isFailureReportDetail: that shape covers TOOL outcomes vouchable by the
 * attempted tool family (failureReportAttempted); this one's subject is the
 * run itself, whose existence needs no voucher. Exported for tests.
 */
export function isRunSelfIncompletionDetail(detail: string): boolean {
  return RAN_OUT_OF_TURN_RE.test(String(detail ?? ''));
}

/** An attempted (ok OR failed OR staged) call of the claim's tool family exists in this run. */
function failureReportAttempted(claim: ExtractedClaim, executed: ExecutedAction[]): boolean {
  // (ticket 9bd94417) outcome-shaped task narration reports the TASK attempt —
  // "Discord failed to open on its screen" vouches on a computer_task attempt
  // exactly like the tool-name idiom does.
  // (3cf9190c review F3) The OUTCOME disjunct is scoped to the DISPATCH kind.
  // The f6dbcb66 arm widened isTaskOutcomeClaimDetail to device-task-subject
  // prose, and this helper acquits on a bare idiom match with no slot and no
  // kind check — so a MESSAGE/TICKET claim was acquitted by an unrelated task
  // attempt ("the Mac task ran but the send to the owner chat failed" →
  // EXONERATED, while the task-less control CONVICTED). Scoping the outcome
  // surface to `dispatch` confines the widening to the one kind whose budget
  // the arm was written for, and leaves the pre-existing tool-name idiom
  // (isTaskDelegationClaimDetail) exactly as it was for every kind.
  if (isTaskDelegationClaimDetail(claim.detail)
    || (claim.kind === 'dispatch' && isTaskOutcomeClaimDetail(claim.detail))) {
    return executed.some((a) => isTaskDelegationTool(a.tool));
  }
  const tools = KIND_TOOLS[claim.kind as ClaimKind] ?? [];
  return executed.some((a) => tools.includes(a.tool));
}

/**
 * (ticket 7cabb0cc, adversarial review F1) TRUE when the detail narrates a
 * tracked action of ANY family — any claim kind's verb→noun idiom, a delegated
 * task, or a staging action. The run-self-incompletion tier acquits only PURE
 * run reports: the kind-label gate alone was too weak (a phantom "I dispatched
 * the report to the owner lane but ran out of turn" mislabelled [message]
 * carries a DISPATCH idiom the message gate never sees), so the exclusion is
 * family-agnostic. Exported for tests.
 */
export function claimNarratesAnyTrackedAction(claim: ExtractedClaim): boolean {
  const detail = String(claim.detail ?? '');
  // (3cf9190c review F4) An outcome idiom sitting UNDER an incompletion
  // subordinator states the task did NOT complete — "I ran out of turn before
  // the Mac task completed", "stopped without the browser task finishing".
  // This tier is only consulted for run-self-incompletion details (the call
  // site gates on it), and the f6dbcb66 arm made the outcome idiom match that
  // subordinate phrase, so the honest shape stopped acquitting — a NEW false
  // strike created by a false-strike fix. The tool-NAME idiom and the staging
  // idiom are untouched: the documented 61b9200a laundering shape ("I ran a
  // computer task … but ran out of time" — no task slot on record) still
  // narrates a tracked action via isTaskDelegationClaimDetail and still
  // convicts.
  const outcomeUnderIncompletion = /\b(?:before|without|until)\b[^.;\n]*$/i.test(detail);
  if (isTaskDelegationClaimDetail(detail)
    || isStagingClaimDetail(detail)
    || (isTaskOutcomeClaimDetail(detail) && !outcomeUnderIncompletion)) return true;
  return (Object.keys(KIND_ACTION_IDIOM) as ClaimKind[]).some((k) => KIND_ACTION_IDIOM[k].test(detail));
}

export async function findPhantomClaims(
  claims: ExtractedClaim[],
  executed: ExecutedAction[],
  artifactCheck: (kind: ClaimKind, id: string, chatId?: string) => Promise<boolean> = citedArtifactExists,
  ledgerIds: string[] = [],
  ownArtifact?: OwnArtifactTierInput,
  /**
   * (ticket c5629165) The CLAIMING chat's id — threaded to the artifact
   * check so a ticket row filed by ANOTHER session can never vouch this
   * chat's filing claim. Absent (every existing caller/test passes
   * positionally) → the check keeps its pre-c5629165 semantics.
   */
  claimantChatId?: string,
): Promise<ExtractedClaim[]> {
  /**
   * (ticket f05b38c1) VERB-CONSISTENCY VETO — an id-bearing claim whose own
   * act verb expects a tool class that NO ok execution of this run belongs
   * to is NOT vouched by a same-id match. The owning verb is extracted from
   * the claim DETAIL (governingClaimVerb — clause grammar, not the leftmost
   * token): "Resolved duplicate ticket 9c307167 via filer self-close"
   * governs `resolved` → the close class, so this run's file_feedback
   * envelope (the FILING, not the close) cannot acquit it — through the
   * kind-specific tier, the any-claim-kind tier, or the own-artifact tier.
   * A verb the map does not know, or a detail that narrates no own-act verb
   * (a report, a status, a coordination "and updated the ledger"), judges
   * nothing — the 5ad80b27 mercy stands and every existing exoneration
   * keeps its semantics. NOT applied to the ledgerIds lane (a prior run's
   * verified restatement — the act ran THEN, not this run) or artifactCheck
   * (external artifact existence), which vouch different facts.
   */
  const verbConsistencyDisabled = process.env.CLAIM_VERB_CONSISTENCY_DISABLED === '1';
  /**
   * (ticket c7b408ef, F2) KNOWN LIMIT — RUN-scoped, not ID-scoped: the veto
   * checks that SOME ok execution of the claim's expected tool class ran THIS
   * run (`pool`), not that an execution of that class exists for the CLAIMED
   * ID. If this run closed a DIFFERENT ticket (a real resolve_feedback for
   * another id), the veto does not block, and the same-id wrong-tool vouch
   * (e.g. the filing's own envelope on the claimed id) can still exonerate
   * the unclosed claim. Recorded as a known limit on purpose: it is a MISS
   * (a fabrication slips through), never a false strike — fail toward miss,
   * doctrine 587e9d64. Making the veto id-scoped would require the pool rows
   * to carry their envelope ids through every tier's consumption accounting;
   * revisit only with a live false-negative specimen in hand.
   */
  const verbMismatchBlocksVouch = (claim: ExtractedClaim): boolean => {
    if (verbConsistencyDisabled) return false;
    const gov = governingClaimVerb(claim.detail);
    if (!gov) return false;
    const expected = expectedToolsForCitation(gov);
    if (!expected) return false;
    return !pool.some((p) => p.action.ok && expected.includes(p.action.tool));
  };
  // (ticket ee212347 GAP B) STAGED rows join the pool: a confirmation-STAGED
  // dispatch_platform_task answers ok:false {staged:true, confirmationId} —
  // it IS the execution a truthful "dispatched a task — for owner
  // confirmation" claim vouches against. The kind budgets below stay ok-only
  // (ofKind filters p.action.ok), so a staged row can never vouch a
  // SHIPPED-action claim — only the idiom-gated staging tiers can spend it.
  const pool = executed.filter((a) => a.ok || a.staged === true).map((a) => ({ action: a, consumed: false }));
  const ofKind = (kind: ClaimKind) => pool.filter((p) => !p.consumed && p.action.ok && KIND_TOOLS[kind].includes(p.action.tool));
  const phantoms: ExtractedClaim[] = [];
  const idless: ExtractedClaim[] = [];

  for (const claim of claims) {
    if (!idish(claim.id)) { idless.push(claim); continue; }
    const cited = String(claim.id);
    // claim.kind is a ClaimKind here BY CONSTRUCTION: both producers feeding
    // this matcher (the LLM extractor's KIND_TOOLS gate, the receipt-idiom
    // miner) emit only the four ACTION kinds — the citation-lane kinds
    // (goal/todo, ticket 3ed139cd) merge into the conviction set downstream
    // of this matcher and never enter it.
    const kind = claim.kind as ClaimKind;
    const specific = ofKind(kind).find((p) => Object.values(p.action.ids).some((v) => idMatches(cited, String(v))));
    // (ticket 363f5793, mishap 2026-09-22) NON-CONSUMING — the same doctrine
    // the kind-agnostic tier below already states ("the id match is
    // claim-specific … the same-kind id-less slot accounting stays available
    // for the action's own-kind narration"): burning the slot here
    // false-convicted the SAME-surface id-less TWIN narration of the one
    // proven action ("Ticket's in now: **`23c68866`** — bug report,
    // priority 1." + "**The ticket:** filed against Digby's platform…" — ONE
    // real file_feedback, two truthful mentions; chat dddbf9ba msg 43b2d0d7
    // → the false user-visible correction d9d7f773 telling the user "no
    // matching successful tool call exists" while the receipt named the
    // ticket). The per-surface pool split (review B1, ticket e65061e1)
    // protects note↔args twins; this extends it to same-surface twins.
    // Accepted residual (fail toward MISS, the 587e9d64 doctrine — a false
    // strike replaces an HONEST note, strictly worse): an id-less claim
    // narrating a SECOND, unexecuted action of the same kind now exonerates
    // on the freed slot. Pure id-less over-claims still convict on slot
    // count, and a fabricated id still convicts through the tier chain (no
    // envelope match anywhere) — both pinned in
    // action-verifier.363f5793.test.ts.
    // (ticket f05b38c1) the verb-consistency veto guards this tier too: the
    // matching execution is of the WRONG tool class for the claim's own
    // governing act verb (and no other ok execution of the right class ran
    // this run) — the id is real but the claimed act never ran. Falls
    // through toward the conviction set instead of vouching.
    if (specific) {
      if (verbMismatchBlocksVouch(claim)) {
        // fall through: the same-id vouch is of the wrong tool class — the
        // tiers below (fc337153, own-artifact) re-test the same veto and the
        // claim reaches the conviction set unless a NON-same-id lane (ledger,
        // artifact) vouches it.
      } else {
        continue;
      }
    }
    // (ticket ee212347 GAP B, firing-52 replay) ID-BEARING DISPATCH-STAGING
    // tier — the id-bearing twin of the id-less routing below (~L2458). A
    // claim whose DETAIL narrates a staging action ("staged the task <id> for
    // confirmation", "dispatched a draft <id> for preview") AND cites an id
    // from a row this run STAGED (ok:false {staged:true}) is vouched by that
    // row — the staged dispatch IS the execution the claim narrates. The
    // idiom gate (isDispatchStagingClaimDetail) is the laundering guard: a
    // SHIPPED-dispatch claim ("dispatched <id>, it's running now") carries no
    // staging idiom, never routes here, and still needs an ok:true slot — an
    // unrelated staged task cannot acquit it (case 5 of the ee212347 replay
    // pins exactly this). NON-CONSUMING, same doctrine as the tiers above:
    // the id match is claim-specific, slot accounting stays untouched.
    if (
      kind === 'dispatch'
      && isDispatchStagingClaimDetail(claim.detail)
      && pool.some((p) => p.action.staged === true && isDispatchStagingTool(p.action.tool) && Object.values(p.action.ids).some((v) => idMatches(cited, String(v))))
    ) {
      continue;
    }
    // Kind-agnostic own-run exoneration (ticket fc337153): a TRUE but
    // mis-TYPED claim — the extraction labelled it [dispatch] while the
    // action it narrates ran under another kind's tool (a send_chat_message
    // receipt cited on a "lane unblocked" claim) — must not fall through to
    // the kind-specific artifact check and convict. A fabricated id appears
    // in NO own-run envelope, so matching any kind's execution cannot
    // launder a phantom. The execution is NOT consumed: the id match is
    // claim-specific, and the same-kind id-less slot accounting (step 4)
    // stays available for the action's own-kind narration.
    // Scoped to CLAIM-KIND tools (ARGS_SCAN_TOOLS = ∪ KIND_TOOLS, review
    // P1): the receipt pool also carries non-claimable envelopes (git shas,
    // branch names, prNumbers via receiptsToActions) — an id-splice phantom
    // ("dispatched session <own commit sha>") must NOT be laundered by a
    // git receipt. A mis-typed claim can only be mis-typed among claim
    // kinds, so a backing tool outside the kinds' union cannot exonerate.
    // (ticket ee212347, GAP-B doctrine guard) Staged rows are EXCLUDED here
    // (p.action.ok): the pool admits confirmation-STAGED rows so the
    // idiom-gated staging tiers can vouch a "staged for confirmation" claim,
    // but a staged row must NEVER vouch a SHIPPED-verb claim — this
    // kind-agnostic lane vouches verbs indiscriminately, so it stays ok-only
    // exactly like ofKind (line 2306).
    if (pool.some((p) => p.action.ok && ARGS_SCAN_TOOLS.has(p.action.tool) && Object.values(p.action.ids).some((v) => idMatches(cited, String(v))))
      && !verbMismatchBlocksVouch(claim)) continue;
    if (ledgerIds.some((l) => idMatches(cited, l))) continue; // verified in a PRIOR run (caller pre-filters the ledger to pre-run entries) — restatement, not phantom
    if (await artifactCheck(kind, cited, claimantChatId)) continue;
    // (ticket 5ad80b27) OWN-ARTIFACT KIND-CONSISTENCY tier — the 587e9d64
    // sighting-2 residual. Grounding (PR #747) proved the DETAIL is verbatim
    // note prose; it cannot judge the extractor's KIND/ID annotation. When
    // the cited id anchors to this run's OWN evidence —
    //   (a) a NON-claim-kind receipt envelope (the fc337153 scope's complement:
    //       git shas, todo ids, autonomy chat ids… — matched WITHOUT the
    //       ARGS_SCAN_TOOLS scope), or
    //   (b) the trusted tool-output texts (citedIdInToolOutput — the seam
    //       that covers artifact tools minting no receipts, create_document's
    //       file id being the incident shape)
    // — the id is REAL and own-run, never a fabrication. If the DETAIL also
    // fails to narrate the claimed kind's action (claimNarratesKindAction),
    // the note's words never claimed the consequential action at all: only
    // the extractor's kind label did. Convicting would append a FALSE
    // correction to an HONEST note — strictly worse than a miss (the
    // 587e9d64 doctrine), so exonerate instead. The review-P1 id-splice shape
    // ("dispatched session <own commit sha>") keeps convicting: its detail
    // narrates the dispatch, so the kind-idiom gate lets it through. The
    // matched execution is NOT consumed (same claim-specific doctrine as the
    // fc337153 tier — slot accounting is untouched).
    if (
      (pool.some((p) => !ARGS_SCAN_TOOLS.has(p.action.tool) && Object.values(p.action.ids).some((v) => idMatches(cited, String(v))))
        || citedIdInToolOutput(cited, ownArtifact?.evidenceTexts ?? []))
      && !claimNarratesKindAction(kind, claim.detail)
      // (ticket f05b38c1) the own-artifact tier may not exonerate a verb
      // mismatch either — the shared veto: the id anchors to this run's own
      // envelope/tool output, but the claim's governing act verb expects a
      // tool class no ok execution of this run belongs to (the ad60c49d
      // class: a close verb vouched by the filing's own file_feedback
      // envelope). The id-splice shape ("dispatched session <own commit
      // sha>") still convicts on the kind-idiom gate above.
      && !verbMismatchBlocksVouch(claim)
    ) {
      ownArtifact?.exonerated?.push(claim);
      continue;
    }
    phantoms.push(claim);
  }
  for (const claim of idless) {
    // FAILURE-REPORT tier (see failureReportAttempted) — an honest "it timed out / failed" never convicts
    // when the attempt it reports is on record. Non-consuming: no ok slot is spent.
    if (!failureReportExemptDisabled() && isFailureReportDetail(claim.detail) && failureReportAttempted(claim, executed)) continue;
    // (ticket 7cabb0cc) RUN-SELF-INCOMPLETION tier: an honest "I ran out of
    // turn before completing my own live verification" reports the RUN's own
    // budget exhaustion — a non-completion statement the extractor can
    // mis-label [dispatch]/[message] when it names the thing not completed.
    // Its subject is the run itself (this very audit's input), so no tool
    // family can voucher it and none is needed: the run provably ran.
    // SCOPE GUARD (adversarial review F1, ticket 7cabb0cc): the idiom alone
    // must never acquit a claim that ALSO asserts a completed action. Three
    // probed laundering shapes, each now excluded: "I filed the ticket and
    // ran out of time before recording its id" (kind idiom: filed→ticket),
    // "I dispatched the report to the owner lane but ran out of turn to
    // verify it" (kind idiom: dispatched→lane), and the 61b9200a steps:0
    // shape "I ran a computer task … but ran out of time" (TASK idiom — no
    // dispatch verb→noun pair, so the kind gate alone would miss it; with
    // no task slot on record it must still convict). Only a claim whose
    // detail narrates NO tracked action — kind, task, or staging — is a
    // pure run report; everything else falls through to the normal chain.
    // The incident detail ("ran out of turn before completing my own live
    // verification") narrates none, so the honest shape still acquits.
    // Same kill switch; non-consuming.
    if (
      !failureReportExemptDisabled()
      && isRunSelfIncompletionDetail(claim.detail)
      && !claimNarratesAnyTrackedAction(claim)
    ) continue;
    // (ticket 61b9200a) TASK-BUDGET ROUTING for id-less dispatch claims: a
    // claim whose detail narrates a delegated computer/browser task ("I ran a
    // computer task to find the PDF") is vouched for by the run's OWN task
    // executions FIRST — task slots and platform slots never mix, so (a) a
    // truthful task narration no longer depends on platform-session slots it
    // can never match (the 2026-09-12 false conviction in chat 0945e820: the
    // task HAD run 12 steps, but no pool entry could vouch for it), and (b) a
    // phantom PLATFORM-dispatch claim ("I dispatched a worker") cannot be
    // laundered by an unrelated real task run — KIND_TOOLS.dispatch still
    // excludes task tools, so platform claims never see task slots.
    // FALL-THROUGH to the platform budget is deliberate (doctrine: a false
    // strike is strictly worse than a miss): "dispatched a session to run the
    // browser-use check" mentions a task but is a SESSION claim — a real
    // start_coding_session still vouches for it.
    if (claim.kind === 'dispatch' && isTaskDelegationClaimDetail(claim.detail)) {
      const taskSlot = pool.find((p) => !p.consumed && isTaskDelegationTool(p.action.tool));
      if (taskSlot) { taskSlot.consumed = true; continue; }
    }
    // (ticket 9bd94417, 2026-10-28) SIBLING task-budget arm — the OUTCOME
    // surface of the same dedicated budget. A dispatch claim whose detail
    // narrates a task RESULT without naming the tool ("Discord is now open on
    // its screen" — chat 18a957cb, narrated after a REAL 10-step
    // computer_task) never matches the 61b9200a tool-name idiom above, fell
    // to the platform budget KIND_TOOLS.dispatch cannot fill, and the TRUE
    // claim was convicted as a phantom (false strike — the doctrine
    // 587e9d64 names strictly worse than a miss). isTaskOutcomeClaimDetail
    // gates this arm on a device/screen surface (screen/display/desktop/
    // mac/computer/browser) so platform claims ("the PR is open on GitHub",
    // "the ticket is open on the board") never route here, and the slot it
    // spends is the SAME task pool — an outcome claim with NO task
    // execution on record still convicts (a fabricated "Discord is open"
    // with no task run stays a phantom). Same deliberate fall-through: a
    // real platform slot below can still vouch an outcome-shaped compound
    // that was really a session action.
    if (claim.kind === 'dispatch' && isTaskOutcomeClaimDetail(claim.detail)) {
      const taskSlot = pool.find((p) => !p.consumed && isTaskDelegationTool(p.action.tool));
      if (taskSlot) { taskSlot.consumed = true; continue; }
    }
    // (ticket a235fbd6) STAGING-BUDGET ROUTING for id-less MESSAGE claims: a
    // claim whose detail narrates a STAGING action ("I've staged a message to
    // the deck session … as real chat attachments") is vouched for by the
    // run's OWN stage_upload execution FIRST — staging slots and message
    // slots never mix, so (a) a truthful staging narration is exonerated by
    // the stage_upload that actually ran (it mints a receipt with
    // ids.uploadId) instead of depending on a send_chat_message slot it never
    // claimed, and (b) a phantom "sent a message" claim is NOT laundered by an
    // unrelated real staging run (the staging tier only catches claims whose
    // WORDS narrate staging — claimNarratesKindAction's discipline).
    // NO FALL-THROUGH here (unlike the task tier): a staging claim that finds
    // no staging slot falls through to the message budget deliberately — a
    // run that DID send_chat_message a staged message ("staged the files and
    // sent them over") is still vouched for by the send. A pure staging claim
    // with zero staging AND zero message executions convicts (the incident:
    // the narration claimed a send-staging pipeline that never ran at all).
    if (claim.kind === 'message' && isStagingClaimDetail(claim.detail)) {
      const stagingSlot = pool.find((p) => !p.consumed && isStagingTool(p.action.tool));
      if (stagingSlot) { stagingSlot.consumed = true; continue; }
    }
    // (ticket ee212347 GAP B) DISPATCH-STAGING-BUDGET ROUTING for id-less
    // dispatch claims — the dispatch twin of the a235fbd6 tier above. A claim
    // whose detail narrates a STAGING action ("I've dispatched the platform
    // task — staged for owner confirmation", "dispatched a draft for
    // preview") is vouched for by the run's OWN staged dispatch_platform_task
    // execution (ok:false {staged:true} — admitted to the pool by the GAP B
    // pool change, spendable ONLY here). The idiom gate is the laundering
    // guard: a shipped-dispatch claim ("I dispatched the worker, it's
    // running now") carries no staging idiom, never routes here, and still
    // needs an ok:true slot from ofKind — an unrelated staged task cannot
    // acquit it. NO FALL-THROUGH skip: a staging claim that finds no staged
    // slot falls through to the ok-only dispatch budget deliberately, so a
    // run that STARTED a session after staging narration ("staged the task,
    // then started the session directly") is still vouched by the real
    // start_coding_session.
    if (claim.kind === 'dispatch' && isDispatchStagingClaimDetail(claim.detail)) {
      const dispatchStagingSlot = pool.find((p) => !p.consumed && isDispatchStagingTool(p.action.tool));
      if (dispatchStagingSlot) { dispatchStagingSlot.consumed = true; continue; }
    }
    // (ticket 9ca6e125, 2026-10-29) WORKER-DELEGATION-BUDGET ROUTING for
    // id-less dispatch claims. The extractor defines a dispatch claim as
    // "started/dispatched a coding session, WORKER, or platform task", and the
    // chat orchestrator is offered delegate/delegate_parallel — but those mint
    // no receipt, answer PROSE (no ok:true envelope) and are deliberately out
    // of KIND_TOOLS.dispatch, so before this tier a TRUTHFUL "I dispatched a
    // reviewer worker to check the detector" had NO possible vouch and
    // convicted as [dispatch] (no id) with "NONE executed" — the av-mishap
    // class this ticket was filed for.
    // The idiom gate is the 61b9200a anti-laundering guard: the tier is
    // reachable ONLY for claims that name a delegated worker/subagent, so a
    // platform-session phantom ("I dispatched a coding session 9e39ec5c")
    // never reaches it and still needs an ok:true KIND_TOOLS.dispatch slot —
    // an unrelated real delegation cannot acquit it. FALL-THROUGH to the
    // platform budget is deliberate (doctrine 587e9d64: a false strike is
    // strictly worse than a miss): "dispatched a worker to open the session"
    // is a compound that a real start_coding_session should still vouch.
    if (claim.kind === 'dispatch' && isDelegationClaimDetail(claim.detail)) {
      const delegationSlot = pool.find((p) => !p.consumed && p.action.ok && isDelegationTool(p.action.tool));
      if (delegationSlot) { delegationSlot.consumed = true; continue; }
    }
    const slot = ofKind(claim.kind as ClaimKind)[0]; // action-kind by construction (see the id-bearing loop above)
    if (slot) { slot.consumed = true; continue; }
    phantoms.push(claim);
  }
  return phantoms;
}

/**
 * The supervisor seat a machine-wake note belongs to — see
 * PhantomClaimAuditInput.supervisorScope.
 */
export type SupervisorScope = 'fleet' | 'project';

/**
 * Inputs shared by both verifier lanes (the post-delivery
 * verifyRunActionClaimsAsync and the pre-delivery guardMachineWakeFinalAnswer).
 */
export interface PhantomClaimAuditInput {
  chatId: string;
  userId: string;
  finalText: string;
  parts: RunPartLike[];
  /** Supervisor wakes get the state-doc exoneration + durable refutation. */
  supervisor?: boolean;
  /**
   * Which supervisor SEAT the note came from (hardening review 2026-09-14):
   * the FLEET supervisor (isSupervisor) or a PROJECT's dedicated supervisor
   * (isProjectSupervisor). Label-only — it steers the phantom ticket's
   * attribution prose, `area` ('fleet-supervisor' vs 'project-supervisor')
   * and `context.supervisorScope`, never the verdict or any consequence.
   * Defaults to 'fleet' whenever `supervisor` is true and the scope is
   * omitted (every pre-2026-09-14 caller), so existing pins are byte-identical.
   */
  supervisorScope?: SupervisorScope;
  /** Machine-triggered runs also get the in-thread correction (post-delivery lane). */
  machineTriggered?: boolean;
  /**
   * PIPELINE CROSS-CHECK exoneration anchor (ticket 899554af, mishap
   * 2026-09-19): TRUE only when this run's L2 cross-check draft was
   * genuinely MERGED into the delivered answer — chat-agent's
   * `crossCheckMerged`, which flips only on a non-empty injected draft block
   * or a successful late-reconcile (reviewer F1/N1: never the injector latch
   * `draftsDelivered`, which flips before the gate check). The L2 Double
   * Checker is a pipeline lane, not a consequential tool — it mints no
   * run-receipt and leaves no part, so the executed pool is blind to it and
   * the synthesis model's TRUE narration of the merge ("passed a digest to a
   * crossmodel agent (cross_checker) and merged its independent gap list
   * with my own read" — chat bb8b8c99, 2026-09-19T00:52Z, chat_search_usage
   * mode:'thinking') convicted as a phantom [dispatch]. When this flag is
   * on, cross-check-shaped claims (isCrossCheckPipelineNarration) are
   * exonerated; EVERY caller that leaves it unset sees byte-identical
   * behavior (L1 runs, machine wakes — which skip the checker entirely —
   * coding lanes, and every pre-2026-09-19 caller). A false "I cross-checked
   * this" in a run whose draft never merged (gate timeout / empty draft /
   * late-armed / L1) stays convicted.
   */
  crossCheckDelivered?: boolean;
  /**
   * What the supervisor harness already removed from this note (platform/harness-receipts — the note's own
   * ACTIONS TAKEN list / model-typed copies of harness lines; review fix 2026-10-20). Wording only: the
   * observe-only annotation then names the removal instead of "nothing above was removed or changed". Unset
   * ⇒ byte-identical.
   */
  harnessStripped?: { block?: boolean; copies?: boolean } | null;
  /**
   * COUNCIL DISPATCH exoneration anchor (ticket 7cabb0cc, mishap 2026-10-08):
   * TRUE only when this run's L3 deep-research council was genuinely
   * dispatched — chat-agent's `dispatchRounds > 0` (the dispatch_colleagues
   * executor increments it only after validation, before any colleague call).
   * The council is a PIPELINE lane, exactly like the L2 checker: the lead's
   * dispatch_colleagues call is an inline tool of the chat agent (not
   * start_coding_session / dispatch_platform_task), the colleague runs mint
   * no run-receipt and leave no tracked part — so the executed pool is blind
   * to the whole round and the lead's TRUE narration ("I dispatched both
   * council colleagues … but both ran past the dispatch ceiling and their
   * reports came back empty" — chat 182f27b7, 2026-10-08) convicted as a
   * phantom [dispatch] with "Executed consequential actions this run: NONE".
   * When this flag is on, council-shaped id-less claims
   * (isCouncilDispatchNarration) are exonerated; every caller that leaves it
   * unset sees byte-identical behavior. A false "I dispatched the council" in
   * a run that never dispatched stays convicted, and a co-riding fabricated
   * id still dies in the citation lanes (the id-less scope mirrors the
   * cross-check tier's real-artifact carve-out).
   */
  councilDispatched?: boolean;
  /**
   * HARNESS CONTINUATION LINE exoneration anchor (ticket 5c7727c4, mishap
   * 2026-10-27): the EXACT closing line the harness itself appended to this
   * note (chat-agent's answer-first / turn-continuation rewrite —
   * followThroughContinuationLine / CONTINUATION_LINE / CONTINUATION_CAP_LINE),
   * set ONLY when the harness actually rewrote the note's closing
   * (chat-agent's `continuationRewrote`; every value it can take is a platform
   * template). The incident (chat 590d604e, 2026-10-27T04:22Z): the
   * answer-first machinery split the owner turn at the soft deadline, rewrote
   * the closing with
   * "Still working on this in the background — <items>. I will post the
   * result here." and armed a follow-through round that then EXECUTED the
   * items (goal 2bcc6f79 04:25:05Z → todo 95499211 04:26:20Z → session
   * b6b1e0e1 04:28:01Z) — but the post-delivery lane audited the DELIVERED
   * text, the extractor quoted the template line's items ("[dispatch]
   * dispatch a probe lane to check … and post the verdict with receipts in
   * this chat") with no in-run receipt, and the mishap fired against
   * platform-authored promise text the model never wrote in that form.
   *
   * The items themselves ARE model words (the model's own "Follow-through:"
   * line, consumed by the rewrite), so a DELETE would be a laundering
   * channel: a model could write "Follow-through: pushed the hotfix and
   * confirmed prod green", let the harness reframe it, and its words would
   * exist in NO audit window. Instead the matcher STRIP-OR-RESTORES the
   * exact line: the harness's reframed line leaves the action window, and
   * when the parsed items carry a completed-action shape (verb-bound, house
   * style — isCompletedActionItems) the model's own words go back in place
   * as "Follow-through: <items>" — still first-person, still extractable,
   * still convicte. An intent-shaped remainder ("probe S1:8000, check the
   * route, restart if down") is a PROMISE the armed round owns, never a
   * completed-action claim, and stays out.
   *
   * Scope guards:
   *   - EXACT-LINE: only the anchored line is touched, only its LAST
   *     occurrence (a model-typed echo mid-note stays for full audit); a
   *     line that matches only mid-line is left in place;
   *   - citation lanes untouched: they read the FULL note, so an id inside
   *     the line still dies in the deterministic id-existence lanes;
   *   - unset anchor, or ACTION_VERIFIER_CONTINUATION_EXEMPT_DISABLED=1 ⇒
   *     byte-identical behavior (every pre-2026-10-27 caller).
   */
  harnessContinuationLine?: string | null;
  /**
   * The run's harness-written execution receipts (run-receipts). The executed
   * pool is the UNION (buildExecutedPool, ticket d25172ca): receipts are
   * authoritative for every tool they carry a row for (they carry `ok`, so a
   * staged confirmation or a failed call no longer counts as executed), and
   * parts-parsed executions cover the tools receipts do NOT (and an EMPTY
   * receipts array is truthy, which used to blank the parts lane entirely;
   * notify_user is receipted since todo 1e356736 — the parts lane stays its
   * fallback when the receipt write itself failed).
   */
  receipts?: ToolReceipt[];
  /**
   * When the claiming run STARTED (cross-wake exoneration anchor): a claim with
   * no in-run evidence is checked against this chat's PRIOR receipts (24h
   * window) before conviction — only receipts created BEFORE this instant count
   * (a later receipt would be the claim causing its own evidence). Absent →
   * the cross-wake tier is skipped entirely (today's behavior).
   */
  runStartedAt?: Date;
  /**
   * Clock override for the deterministic future-observation check (ticket
   * 375c8618) — tests inject a fixed instant; production callers omit it and
   * the check anchors to `new Date()` at guard time.
   */
  now?: Date;
  /**
   * Additional TRUSTED tool-output text, unioned with this input's own parts'
   * tool_result texts, for BOTH haystack exonerations: the future-clock
   * provenance check (ticket a688ba29) AND the citation lanes' tool-output
   * tier (owner 2026-09-04 — citedIdInToolOutput). The reject-back seam
   * passes a struck FIRST attempt's tool results so an honest forward stamp
   * or id citation the retry re-uses keeps its provenance (the first
   * attempt's receipts already union the same way). TOOL OUTPUT ONLY — never
   * prompt/system/model/guard text (the one accepted residual: a tool result
   * echoing model-authored args, the same exposure the coding lane ships).
   */
  extraEvidenceHaystacks?: string[];
  /**
   * REJECT-BACK pre-pass (fleet-integrity cluster ba65163d / aac649ba — the
   * machine-wake counterpart of the coding lane's dc04deea gate): when true
   * the guard computes the full verdict (struck / phantoms / correction) AND
   * renders `rejectBackNotice` on a strike, but DEFERS every side effect
   * (ticket filing, durable refutation). The chat-agent seam uses it for the
   * FIRST pass only: a struck note is rejected back for ONE bounded
   * re-orchestration with the notice in model context — a clean second answer
   * delivers with zero ticket churn (the self-correction IS the fix working);
   * a still-convicted second answer is re-guarded with this flag OFF, so the
   * normal consequences fire exactly once, on the final answer.
   */
  deferConsequences?: boolean;
  /**
   * STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, round-2 finding 4 — chat-agent/struck-note-repeat.ts): the
   * seam has ALREADY decided to reject this note back as a near-verbatim re-post of the chat's previous struck
   * note. Under the clock policy a clock-only strike otherwise files its ticket on pass 1 ("DELIVERED AS WRITTEN
   * with a trailing annotation") — and the repeat's retry then discards that draft (the f16cc02a provenance
   * class). With this set the clock lane's ticket DEFERS the way every other lane's does under deferConsequences:
   * it files on the pass-2 verdict of the text actually delivered. No rejectBackNotice is rendered for it (the
   * seam's repeat notice carries the retry). Ignored unless deferConsequences is true. Folded under
   * STRUCK_NOTE_REPEAT_DISABLED (the seam never sets it then).
   */
  deferClockTicket?: boolean;
  /**
   * CONSEQUENCE SCOPE (ticket f16cc02a, 2026-09-15 — the class-flip hole):
   * which standing verdicts may fire the side effects (the deduped mishap
   * ticket + durable refutation) when `deferConsequences` is OFF.
   *   - 'all' (DEFAULT, every pre-2026-09-15 caller): any conviction files.
   *   - 'citation-only': consequences fire ONLY when the standing conviction
   *     is all-citation-class (allCitationClassClaims). An ACTION-class
   *     standing verdict is returned (struck, redacted text computed) with
   *     consequences SUPPRESSED.
   * The chat-agent citation-enforce branch (b216475a) runs its second pass
   * with 'citation-only': the seam's F1 re-classification deliberately does
   * NOT apply the redaction when the standing verdict flips ACTION-class
   * (the 2026-09-11 observe-only flip keeps ACTION-class verdicts metric-
   * only), so firing the ticket there wrote a FALSE containment record —
   * the ticket claimed "the struck claim line(s) never reached the thread"
   * (containedPreDelivery/deliveredRedacted) while the note was delivered
   * UNMODIFIED (project supervisor 810c924d, 2026-09-15: the phantom
   * todo_update line reached the thread, no correction row fired).
   */
  consequenceScope?: 'all' | 'citation-only';
  /** GAP A (ticket ee212347): harness-mined dispatch/session ids from PRIOR
   * state docs (the 24h cross-wake window), supplied by the caller for
   * NON-supervisor chats that have no supervisor state doc; folded into the
   * same exoneration ledger as supervisor dispatches so a truthful
   * cross-wake restatement exonerates identically. Callers supply ALREADY
   * time-filtered (pre-run) ids, so NO additional prior-wake filter is
   * applied to them here — unlike supervisor state-doc rows, which are read
   * at audit time and therefore need the ae7db80b laundering filter.
   * Fail-open: absent/empty → no behavior change (byte-identical for every
   * existing caller). */
  stateDocIds?: string[];
}

/** Everything a consequence shell (post- or pre-delivery) needs from the matcher. */
export interface PhantomClaimComputation {
  /** The audited note (trimmed finalText). */
  note: string;
  /** Every claim the extraction pass found ([] when the note never reached extraction). */
  claims: ExtractedClaim[];
  /** Claims that survived every exoneration tier — the convictions. */
  phantoms: ExtractedClaim[];
  /** The tier-1 executed-action pool the claims were matched against. */
  executed: ExecutedAction[];
  /** How many initially-convicted claims the cross-wake receipt tier exonerated. */
  crossWakeExonerated: number;
  /** How many claims the own-artifact kind-consistency tier exonerated (ticket 5ad80b27). */
  ownArtifactExonerated: number;
  /** How many convicted claims the pipeline cross-check tier exonerated (ticket 899554af — crossCheckDelivered runs only). */
  pipelineCrossCheckExonerated: number;
  /** How many convicted claims the council-dispatch tier exonerated (ticket 7cabb0cc — councilDispatched runs only). */
  councilDispatchExonerated: number;
  supervisor: boolean;
  /** Normalized seat label: input.supervisorScope ?? 'fleet' when supervisor; undefined otherwise. */
  supervisorScope?: SupervisorScope;
  /** Normalized exactly like the legacy body: explicit flag OR supervisor. */
  machineTriggered: boolean;
  /** The supervisor state-doc refutation writer — non-null for supervisor chats only. */
  appendRefutation: ((chatId: string, userId: string, detail: string) => Promise<unknown>) | null;
}

/**
 * Cross-check-pipeline narration shape (ticket 899554af): a claim whose cited
 * id OR detail names the run's OWN answer-pipeline cross-check — the L2
 * Double Checker lane (`cross_checker` role id, "cross-check(er)", "Double
 * Checker", or the incident's "crossmodel agent" phrasing). Kind-agnostic ON
 * PURPOSE: the extractor tagged the incident claim [dispatch], but the same
 * narration could surface as [message] ("sent the digest to the
 * cross_checker") on another coin flip — the acquittal anchor is the
 * VOCABULARY, and the safety anchor is the crossCheckDelivered flag (true
 * only when the drafts were really injected this turn). Deliberately NOT
 * matched: generic "independent researcher/model" prose (too broad — could
 * launder a real phantom), council/colleague narration (the L3 lane is a
 * separate shape — crossCheckMerged stays false there, so council notes keep
 * today's audit either way), and any real artifact id (a fabricated
 * "cross_checker receipt msg xyz" stays convicted by the citation lanes —
 * the checker mints no receipts, so the id can only be invented).
 */
const CROSS_CHECK_NARRATION_RE = /cross[-_ ]?check(?:er|ers|ed|ing)?|double[- ]?check(?:er|ers)?|crossmodel agent/i;
export const isCrossCheckPipelineNarration = (claim: ExtractedClaim): boolean =>
  CROSS_CHECK_NARRATION_RE.test(String(claim.id ?? '')) || CROSS_CHECK_NARRATION_RE.test(String(claim.detail ?? ''));

/**
 * COUNCIL DISPATCH narration shape (ticket 7cabb0cc, mishap 2026-10-08 — the
 * L3 twin of the 899554af cross-check tier, whose comment explicitly deferred
 * this shape: "council/colleague narration (the L3 lane is a separate shape
 * … council notes keep today's audit either way)"). The incident: the
 * Dig-deeper research rung's lead honestly reported "I dispatched both
 * council colleagues … but both ran past the dispatch ceiling and their
 * reports came back empty" — the dispatch REALLY happened
 * (chat-agent.service.ts dispatchRounds incremented, COUNCIL_DISPATCH_TIMEOUT
 * metrics + the degraded-run notice corroborate), but the council is a
 * pipeline lane: dispatch_colleagues is an inline tool of the chat agent (NOT
 * start_coding_session / dispatch_platform_task), the colleague runs mint no
 * run-receipt and leave no tracked part — the executed pool stayed empty and
 * the extractor's [dispatch] label convicted the TRUE narration with
 * "Executed consequential actions this run: NONE" (chat 182f27b7).
 *
 * (adversarial review F2/F3, ticket 7cabb0cc) TWO hardening gates on the
 * vocabulary, both probed by the reviewer:
 *   - VERB-BOUND, not noun-bound: the council noun must ride a DISPATCH-
 *     family verb in the same clause ("dispatched/launched/sent …
 *     colleagues", "dispatched the council"). A bare "council"/"colleague"
 *     anywhere would acquit a true phantom platform action that merely
 *     MENTIONS the council ("I scheduled the council review for 6pm",
 *     "I dispatched a coding session for the colleague-requested refactor").
 *   - NO-ID: only a claim whose extractor record cites NO id at all acquits
 *     — a non-hex id ("PR-1338") fails `idish` and would otherwise ride this
 *     id-less tier (the F3 partition debt); any id-citation attempt keeps
 *     the full conviction chain.
 * The safety anchor `councilDispatched` (dispatchRounds > 0) is TRUE only
 * when a dispatch round genuinely ran this turn; runs that never dispatched
 * (flag unset — L1, L2, machine wakes, coding lanes, every pre-2026-10-08
 * caller) see byte-identical behavior.
 */
const COUNCIL_DISPATCH_NARRATION_RE = /\b(?:dispatch(?:ed|ing)?|spawn(?:ed|ing)?|launch(?:ed|ing)?|sent)\s+(?:(?:both|the|my|all|two)\s+)*(?:autonomous\s+)?colleagues?\b|\bdispatch(?:ed|ing)?\s+(?:(?:both|the|my)\s+)?council\b/i;
export const isCouncilDispatchNarration = (claim: ExtractedClaim): boolean =>
  !String(claim.id ?? '').trim() && COUNCIL_DISPATCH_NARRATION_RE.test(String(claim.detail ?? ''));

/**
 * (ticket 5c7727c4) Completed-action shape for a continuation line's ITEMS
 * — the model-authored "Follow-through:" remainder the harness reframed into
 * "Still working on this in the background — <items>. I will post the result
 * here." (owner-answer-first.ts followThroughContinuationLine). The items are
 * the MODEL's words: when they carry a completed-action verb the strip
 * RESTORES them into the action window as the model's own
 * "Follow-through: <items>" line (anti-laundering — a model that writes
 * "Follow-through: pushed the hotfix and confirmed prod green" gets those
 * words audited, never deleted; the frontier review's finding). Intent-shaped
 * items ("probe S1:8000, check the route, restart if down") are the armed
 * round's PROMISE and stay out of the completed-action window.
 *
 * Verb-bound, house style (COUNCIL_DISPATCH_NARRATION_RE's F2 gate): a bare
 * plan noun never matches; the verb must head a clause and be a
 * completed-action form — present/past/perfect, never the infinitive/
 * future/gerund intent forms ("to probe", "will restart", "probing",
 * "dispatching that now" — the incident's own honest admission is
 * intent-shaped and must NOT restore).
 */
const COMPLETED_ACTION_ITEMS_RE = /\b(?:push(?:ed)?|shipped|deployed|merged|landed|filed|flagged|sent|sent|messaged|archived|cancelled|canceled|created|chartered|spawned|dispatched|launched|started|restored|updated|closed|verified|confirmed|checked|posted|published|wrote|wired|fixed)\b/i;
export const isCompletedActionItems = (items: string): boolean =>
  COMPLETED_ACTION_ITEMS_RE.test(String(items ?? ''));

/**
 * (ticket 3cf9190c, chat 65c98b82) CLAUSE-HEAD ANCHORING — the judging gate.
 *
 * COMPLETED_ACTION_ITEMS_RE above is an UNANCHORED substring test over a whole
 * clause, so it cannot tell a completed action from a verb that merely APPEARS
 * later in an intent-shaped clause. The house rule this file already documents
 * (§ "Verb-bound, house style" on the items regex) is that the verb must HEAD
 * a clause and be a completed-action form — present/past/perfect, never the
 * infinitive/future/gerund intent forms. Nothing enforced it, and the
 * supervisor incident is the cost: the harness continuation line's items were
 *
 *   "steer restored lane f7e14cf8 with the Pi diagnosis brief (reachability,
 *    dashboard service + today's logs, LAN IP vs 192.168.1.126); apply minimal
 *    fix, verify the dashboard URL answers, report root cause here…"
 *
 * — an INFINITIVE-headed promise whose "restored" is an attributive participle
 * modifying "lane" (the lane WAS restored; the steer was NOT sent). The
 * unanchored test saw "restored" and mined the clause; MINER_KINDS then found
 * no dispatch verb ("dispatched|started|spawned|launched"), the `?? 'dispatch'`
 * default in mineContinuationClaims classified it, the id-less claim found no
 * dispatch slot, and the note's OWN promise was struck as a phantom ~15s
 * after the note itself said "NOT done yet: the diagnostic itself hasn't been
 * dispatched". A false strike on an honest note — doctrine 587e9d64 calls that
 * strictly worse than a miss.
 *
 * So: the clause's FIRST word must be a completed-action form. "steer",
 * "apply", "verify", "report", "probe", "check", "restart", "post" — every
 * imperative/infinitive head — no longer mines, while the register's true
 * positives ("pushed the hotfix and confirmed prod green", "dispatched the
 * probe lane on the RED-SNOW goal") keep their head verb and still convict.
 * A leading adverb ("also", "then", "successfully") is tolerated because it
 * never changes the clause's mood.
 */
const COMPLETED_HEAD_ADVERBS = /^(?:also|then|and|successfully|finally|already|just|now)[\s,]+/i;
// (3cf9190c review F1) EVERY alternative here is a PAST-only spelling. `push`
// was the single base form left in the allowlist, and the allowlist is tested
// BEFORE the denylist, so a base-form imperative head mined and convicted one
// verb over from the incident's own harm class:
//   isCompletedActionClause('push the hotfix to origin once CI is green') → true
// It is now `pushed`, which lets IMPERATIVE_ACTION_HEAD_RE's `push` win.
const COMPLETED_ACTION_HEAD_RE = /^(?:pushed|shipped|deployed|merged|landed|filed|flagged|sent|messaged|archived|cancelled|canceled|created|chartered|spawned|dispatched|launched|started|restored|updated|closed|verified|confirmed|checked|posted|published|wrote|wired|fixed)\b/i;
/**
 * (3cf9190c review F2) LABEL-PREFIXED completed clauses. The house style for a
 * supervisor's follow-through list is "Label: verb phrase" — "Update: closed the
 * ticket 8aa5688f", "Note: archived the lane". Those bare label nouns are in
 * IMPERATIVE_ACTION_HEAD_RE (update, verify, deploy…), so post-fix the head test
 * rejected the whole clause and stripContinuationLine DELETED it from every
 * audited surface (mining is the only route back into the window) — a recall
 * loss, i.e. a laundering channel, not just a trim.
 *
 * Deliberately a CONSERVATIVE label set: a label is stripped only when it is NOT
 * itself an action verb. "Verify:", "Deploy:" and "Steer:" stay unstripped —
 * "Steer: restored lane f7e14cf8" is the incident's own shape with a colon, and
 * re-admitting it would reopen the false strike this ticket exists to fix.
 * Doctrine 587e9d64: a false strike is strictly worse than a miss, so the
 * ambiguous action-verb labels keep the conservative (miss) direction.
 */
const CLAUSE_LABEL_PREFIX = /^(?:update|note|status|result|summary|next|todo|plan|done|remaining|follow-?up)\s*:\s*/i;
/**
 * BASE-FORM (infinitive/imperative) action heads — the forms the house rule
 * says are the armed round's PROMISE, never a completed-action claim. Kept as
 * a DENYLIST rather than an allowlist on purpose: a clause with any other head
 * keeps the pre-3cf9190c judgement byte-for-byte, so only the imperative class
 * changes and no prior true positive loses its conviction (a detector change
 * must never quietly stop a real phantom from firing).
 */
const IMPERATIVE_ACTION_HEAD_RE = /^(?:steer|apply|verify|report|probe|check|restart|post|send|dispatch|launch|start|push|merge|deploy|ship|file|flag|update|close|create|spawn|charter|write|wire|fix|restore|archive|cancel|message|confirm|publish|land)\b/i;

/**
 * Exported for tests: does this clause narrate a COMPLETED action, or is it an
 * intent-shaped (imperative/infinitive-headed) promise?
 *
 * true  ← the head is a completed-action form ("pushed the hotfix …")
 * false ← the head is a base-form action verb ("steer restored lane …")
 * otherwise the pre-existing unanchored test decides, unchanged.
 */
export function isCompletedActionClause(clause: string): boolean {
  // (3cf9190c review F2) Strip a NON-action label ("Update:", "Note:") before
  // the head test so the house "Label: verb phrase" form keeps mining. Action
  // labels ("Verify:", "Deploy:") are deliberately NOT stripped — they keep
  // the conservative direction (see CLAUSE_LABEL_PREFIX).
  const text = String(clause ?? '').trim().replace(COMPLETED_HEAD_ADVERBS, '').replace(CLAUSE_LABEL_PREFIX, '').trim();
  if (!text) return false;
  if (COMPLETED_ACTION_HEAD_RE.test(text)) return true;
  if (IMPERATIVE_ACTION_HEAD_RE.test(text)) return false;
  return isCompletedActionItems(text);
}

/**
 * (ticket 3cf9190c) Split a harness continuation line's ITEMS into clauses —
 * the exact segmentation mineContinuationClaims has always used, hoisted so
 * the head judgement and the miner read the same spans (never drift).
 */
export function splitContinuationClauses(items: string): string[] {
  return String(items ?? '')
    .split(/\s*(?:;|\bthen\b|·)\s*/i)
    .map((raw) => raw.trim().replace(/^[-*•]\s*/, '').replace(/[.;,\s]+$/, ''))
    .filter((clause) => clause.length >= 8);
}

/**
 * The args-scan surface (ticket e65061e1): each tracked tool_call's args from
 * the run's parts, JSON-stringified, pre-gated to blobs that could even carry
 * an action claim (length floor + the shared keyword gate) — claim-free args
 * never cost an LLM extraction. Exported for tests.
 * (ticket 331a1b23, 2026-10-27) EXECUTION GATE: a tracked tool_call whose
 * paired result is a PLAIN FAILURE (ok:false, not confirmation-staged) is
 * SKIPPED — its drafted args are internal-only (no artifact, no owner-visible
 * text ever fossilizes them), and scanning them double-counts a REFUSED call
 * + its ok RETRY against the id-less slot budget, convicting the truthful
 * twin (the incident: file_feedback refused once, re-filed ok — the note
 * truthfully cited the ticket while the failed draft's twin claim convicted).
 * `receipts` decides the UNANSWERED calls (result part missing — a truncated
 * parts log): a tool whose receipts show NO ok/staged row fails all its
 * unanswered calls; any ok/staged receipt for the tool keeps them scannable
 * (fail-open). A call whose args CITED an id that matches an ok execution's
 * envelope is never skipped (the e65061e1 fabricated-id lane stays armed even
 * on a failed call — the tier chain judges it, existence checks and all).
 * Kill switch ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED=1 restores the
 * pre-2026-10-27 surface byte-for-byte.
 */
export function scanToolCallArgs(parts: RunPartLike[] | null | undefined, receipts?: ToolReceipt[]): Array<{ tool: string; text: string }> {
  if (argsTwinFixDisabled()) return scanToolCallArgsLegacy(parts);
  const out: Array<{ tool: string; text: string }> = [];
  if (!Array.isArray(parts)) return out;
  const { failed, unanswered } = trackedCallOutcomeIndexes(parts);
  // Unanswered-call adjudication (fail-open): a tool with any ok/staged
  // receipt row keeps every unanswered call scannable; a tool whose receipts
  // are ALL failed treats its unanswered calls as failed. Absent receipts ⇒
  // keep scannable (pre-fix behavior for a truncated log with no receipts
  // either — never a new blind spot).
  const receiptedOkTools = new Set((receipts ?? []).filter((r) => r.ok === true || (r as any).ids?.staged === true).map((r) => String(r.tool ?? '')));
  const allFailedTools = new Set<string>();
  if (receipts?.length) {
    for (const tool of new Set(receipts.map((r) => String(r.tool ?? '')))) {
      if (!receiptedOkTools.has(tool)) allFailedTools.add(tool);
    }
  }
  // An ok execution's envelope ids — a failed call whose args cite one of
  // these keeps its scan (the e65061e1 fabricated-id lane stays armed).
  // (reviewer B1) Citation-shaped ids ONLY: numbers (prNumber/steps) and
  // short tokens never count — a digit in the args must not defeat the gate.
  const okEnvelopeIds = new Set<string>();
  for (const p of extractExecutedActions(parts)) {
    if (p.ok) for (const v of Object.values(p.ids)) if (isCitationShapedId(v)) okEnvelopeIds.add(String(v).toLowerCase());
  }
  for (const r of receipts ?? []) {
    if (r.ok === true) for (const v of Object.values(r.ids ?? {})) if (isCitationShapedId(v)) okEnvelopeIds.add(String(v).toLowerCase());
  }
  parts.forEach((part, idx) => {
    if (!part || part.type !== 'tool_call') return;
    const tool = String(part.name ?? '');
    if (!ARGS_SCAN_TOOLS.has(tool)) return;
    if (failed.has(idx)) {
      if (!argsCiteOkEnvelopeId(part.args, okEnvelopeIds)) {
        logger.info(`action-verifier: skipping failed ${tool} call's args (ticket 331a1b23 execution gate — internal draft, never an owner-visible artifact)`, { source: 'action-verifier' });
        return;
      }
    } else if (unanswered.has(idx) && allFailedTools.has(tool) && !argsCiteOkEnvelopeId(part.args, okEnvelopeIds)) {
      logger.info(`action-verifier: skipping unanswered ${tool} call's args (ticket 331a1b23 execution gate — every receipt row for this tool failed)`, { source: 'action-verifier' });
      return;
    }
    let text = '';
    try { text = JSON.stringify(part.args ?? {}) || ''; } catch { return; }
    if (text.length >= MIN_NOTE_CHARS && hasActionClaimKeywords(text)) out.push({ tool, text });
  });
  return out;
}

/** The pre-331a1b23 scan (kill-switch path): every tracked call's args, no outcome check. */
function scanToolCallArgsLegacy(parts: RunPartLike[] | null | undefined): Array<{ tool: string; text: string }> {
  const out: Array<{ tool: string; text: string }> = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || part.type !== 'tool_call') continue;
    const tool = String(part.name ?? '');
    if (!ARGS_SCAN_TOOLS.has(tool)) continue;
    let text = '';
    try { text = JSON.stringify(part.args ?? {}) || ''; } catch { continue; }
    if (text.length >= MIN_NOTE_CHARS && hasActionClaimKeywords(text)) out.push({ tool, text });
  }
  return out;
}

/**
 * Does this args object cite (as a value substring) any ok execution's
 * envelope id? (ticket 331a1b23) CITATION-SHAPED ids ONLY: a value must look
 * like a citable platform id (hex-family, ≥8 chars — the idish discipline)
 * to keep a failed call's blob in the scan. A bare NUMBER (prNumber 1998,
 * steps 3, fileCount 12) is not a citation shape, and letting it count made
 * the gate a no-op for any args text containing a digit on a run that opened
 * a PR (reviewer B1: numeric-envelope ids substring-match everywhere) — the
 * fabricated-id lane stays armed exactly where it is real, and no digit
 * re-opens the retry-twin conviction.
 */
function argsCiteOkEnvelopeId(args: unknown, okEnvelopeIds: Set<string>): boolean {
  if (!okEnvelopeIds.size || args === null || args === undefined) return false;
  try {
    const text = JSON.stringify(args) ?? '';
    const lower = text.toLowerCase();
    for (const id of okEnvelopeIds) if (id && lower.includes(id)) return true;
  } catch { /* unstringifiable args — no citation possible */ }
  return false;
}

/** (reviewer B1) Only citation-shaped envelope ids enter the ok-citation set. */
function isCitationShapedId(v: unknown): boolean {
  if (typeof v === 'number') return false; // prNumber/steps/fileCount — never citations
  return idish(String(v ?? ''));
}

/**
 * Convictions merge, deduped per (kind, cited id) — shared by every lane pair
 * (note vs args surfaces, action vs citation lanes). Id-less convictions
 * always survive. Hoisted to module scope for the deterministic citation
 * lanes (ticket f1cb73ff) — the sub-floor and no-claims paths merge too.
 */
const mergeConvictions = (a: ExtractedClaim[], b: ExtractedClaim[]): ExtractedClaim[] => {
  const seen = new Set<string>();
  return [...a, ...b].filter((c) => {
    if (!c.id) return true;
    const k = `${c.kind}|${c.id.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * The SHARED phantom-computation core (ticket fcc4dbb4, 2026-08-26): ONE
 * matcher behind BOTH the post-delivery verifier and the pre-delivery guard,
 * so the two lanes can never drift. Applies the full tier chain, in order:
 *   1. executed pool — receipts (receiptsToActions) when provided, else the
 *      extractExecutedActions(parts) fallback;
 *   2. claim extraction — extractActionClaims (utility-LLM; MIN_NOTE_CHARS /
 *      NOTE_SLICE respected: notes under the floor, and claim-free notes,
 *      audit to zero phantoms without touching the later tiers) over BOTH
 *      claim surfaces (ticket e65061e1): the final note AND each tracked
 *      tool_call's args (scanToolCallArgs; args claims carry a
 *      `[in <tool> args]` detail prefix), deduped per (kind, cited id);
 *   2a. args-citation exoneration (ticket 0beea9f1) — ticket-kind id-bearing
 *      claims mined from tool-call ARGS (artifact-draft content, e.g. a
 *      file_feedback description cross-referencing an earlier ticket) are
 *      exonerated when the cited ticket row EXISTS (citedTicketRowExists,
 *      same-tenant scoped, fail-open) — existence, not recency; fabricated
 *      ids fall through to tier 4 unchanged;
 *   3. supervisor dispatch-ledger exoneration — filtered to entries stamped
 *      BEFORE runStartedAt (the ae7db80b laundering guard; legacy unparseable
 *      `at` rows keep exonerating power — fail open);
 *   4. findPhantomClaims — per-kind count budget, prefix-tolerant id matching,
 *      and the citedArtifactExists DB check for ticket/schedule/dispatch kinds
 *      (message-kind is a designed no-op there); at the conviction point the
 *      own-artifact kind-consistency tier (ticket 5ad80b27) exonerates a
 *      grounded claim whose cited id anchors to this run's OWN evidence
 *      (non-claim-kind envelope / trusted tool output) when its detail never
 *      narrated the claimed kind's action;
 *   5. cross-wake exoneration re-check — getRecentChatReceipts(chatId,
 *      CROSS_WAKE_WINDOW_MS) filtered to createdAt < runStartedAt, appended to
 *      the pool for a second findPhantomClaims pass.
 * NOT fail-soft internally by design: an extraction/DB failure THROWS, and each
 * lane's own catch decides (post lane: warn log; pre-delivery guard: warn log
 * + original text).
 */
export async function computePhantomClaims(input: PhantomClaimAuditInput): Promise<PhantomClaimComputation> {
  // N5 (2026-09-25): the claim-evidence gate is started INSIDE the matcher
  // (it needs the executed pool + the mined claims) and settled HERE, after
  // the tier chain has judged every claim — on every exit, including a throw
  // (paired, unlabelled). Shadow adds no latency: the promise is never
  // awaited on the path; only an ACT request awaits it (in place of the LLM).
  const gateRef: { gate: ClaimEvidenceGate | null; lane: ClaimEvidenceLane; acted: boolean } = { gate: null, lane: 'none', acted: false };
  try {
    const out = await computePhantomClaimsInner(input, gateRef);
    settleClaimEvidenceGate(gateRef.gate, { computation: out, lane: gateRef.lane, acted: gateRef.acted });
    return out;
  } catch (err: any) {
    settleClaimEvidenceGate(gateRef.gate, { computation: null, lane: gateRef.lane, acted: gateRef.acted, error: String(err?.message ?? err) });
    throw err;
  }
}

async function computePhantomClaimsInner(input: PhantomClaimAuditInput, gateRef: { gate: ClaimEvidenceGate | null; lane: ClaimEvidenceLane; acted: boolean }): Promise<PhantomClaimComputation> {
  const { chatId, userId, finalText, parts } = input;
  const supervisor = input.supervisor === true;
  // (ticket 4deaf460) Explicit `machineTriggered: false` now wins over the
  // supervisor coercion: a HUMAN turn on a supervisor chat routes through the
  // general post-delivery lane with supervisor:true (state-doc ledger
  // exoneration + durable refutation) but a HUMAN consequence shape — the
  // d78f477b assistant-role retraction lane, never a machine-authored 'user'
  // row in a thread the human is actively reading. Back-compat: callers that
  // omit machineTriggered (or pass true) keep the pre-2026-10-08 coercion
  // exactly — every existing caller passes true explicitly.
  const machineTriggered = input.machineTriggered === true || (supervisor && input.machineTriggered !== false);
  // Seat label (hardening review 2026-09-14): 'fleet' is the default for every
  // supervisor caller that predates project supervisors — label-only.
  const supervisorScope: SupervisorScope | undefined = supervisor ? (input.supervisorScope ?? 'fleet') : undefined;
  const note = String(finalText ?? '').trim();
  const out: PhantomClaimComputation = {
    note, claims: [], phantoms: [], executed: [],
    crossWakeExonerated: 0, ownArtifactExonerated: 0, pipelineCrossCheckExonerated: 0, councilDispatchExonerated: 0, supervisor, supervisorScope, machineTriggered, appendRefutation: null,
  };
  // (ticket e3246ad5 NB#1) Same-tenant near-miss hints: the same-prefix lookup
  // is scoped to THIS chat's owner so a fabricated id colliding with ANOTHER
  // tenant's row can no longer leak that tenant's title / chat prefix /
  // timestamps into this chat's strike surfaces. Convictions are untouched —
  // the existence checks stay exactly as they were.
  const nearMissFor = {
    message: (id: string) => samePrefixRealIds('message', id, userId),
    schedule: (id: string) => samePrefixRealIds('schedule', id, userId),
    chat: (id: string) => samePrefixRealIds('chat', id, userId),
    goalTodo: (kind: 'goal' | 'todo', id: string) => samePrefixRealIds(kind, id, userId),
    ticket: (id: string) => samePrefixRealIds('ticket', id, userId),
  };
  // Citation-lane tool-OUTPUT haystacks (owner 2026-09-04, CV0904 root cause):
  // this run's tool_result texts + the reject-back seam's cross-attempt union
  // (extraEvidenceHaystacks) — the SAME sources the future-clock lane trusts.
  // Tool-call ARGS are deliberately absent (see citedIdInToolOutput's
  // laundering note); the exoneration applies identically to the pre-delivery
  // guard and the post-delivery verifier, which both route through here.
  const citationHaystacks = [...toolResultTextsFromParts(parts), ...(input.extraEvidenceHaystacks ?? [])];
  // (ticket 5c7727c4) HARNESS CONTINUATION LINE strip + deterministic mining:
  // when the caller anchored the EXACT harness-appended continuation line (see
  // PhantomClaimAuditInput.harnessContinuationLine), the harness's reframed
  // promise leaves the ACTION extraction window — but the ITEMS are the
  // model's own words, so they must NOT vanish from audit (the frontier
  // review's laundering finding). A label-restore ("Follow-through: <items>")
  // is NOT enough: the extractor's prompt ignores intent labels and counts
  // only first-person completed actions, so restored prose would be judged by
  // nothing — a true-positive REGRESSION (pre-fix, the same words were
  // convicted, quoted from the harness line; the incident itself proves the
  // extractor quotes them there). Instead, completed-action-shaped items are
  // MINED deterministically into the claim set (verbatim clauses, miner
  // discipline — no LLM dependence), and the tier chain judges them against
  // the executed pool: truthful items exonerate via own-run receipts; a
  // completed-verb claim with no receipt convicts exactly as it did pre-fix.
  // Intent-shaped items ("probe S1:8000, check the route, restart if down" —
  // the incident's own honest admission) are the armed round's PROMISE, not a
  // completed-action claim, and stay out. Only the anchored line's LAST
  // occurrence is touched (a model-typed echo mid-note stays for full
  // audit); a mid-line partial match is left in place; `out.note` (the
  // ticket excerpt) and every deterministic CITATION lane keep the note AS
  // DELIVERED.
  const continuationExemptOff = String(process.env.ACTION_VERIFIER_CONTINUATION_EXEMPT_DISABLED ?? '').trim().toLowerCase() === '1';
  const anchoredContinuationLine = !continuationExemptOff && typeof input.harnessContinuationLine === 'string' && input.harnessContinuationLine.trim().length >= 20
    ? input.harnessContinuationLine.trim() : null;
  /** The harness template's fixed head/tail — the model-authored items sit between them. */
  const CONTINUATION_HEAD = 'Still working on this in the background — ';
  const CONTINUATION_TAIL = '. I will post the result here.';
  const parseContinuationItems = (line: string): string | null => {
    if (line.startsWith(CONTINUATION_HEAD) && line.endsWith(CONTINUATION_TAIL)) {
      const items = line.slice(CONTINUATION_HEAD.length, line.length - CONTINUATION_TAIL.length).trim();
      return items || null;
    }
    return null;
  };
  /**
   * Deterministic completed-action claims mined from the anchored line's
   * items (verbatim clauses; MINER_KINDS classification, 'dispatch' default —
   * the incident's own extractor label). Id-bearing clauses keep their id so
   * the receipt/tier exonerations and the fabricated-id lanes both apply.
   */
  const mineContinuationClaims = (items: string): ExtractedClaim[] => {
    const out: ExtractedClaim[] = [];
    for (const clause of splitContinuationClauses(items)) {
      // (ticket 3cf9190c) HEAD-anchored: the completed-action verb must HEAD
      // the clause. The unanchored isCompletedActionItems precheck stays as a
      // cheap whole-string gate (it decides whether mining is worth starting);
      // the PER-CLAUSE judgement is isCompletedActionClause, so an
      // infinitive-headed promise that merely CONTAINS a past participle in
      // attributive position ("steer restored lane f7e14cf8 with the brief")
      // is the armed round's promise, never a completed-action claim.
      if (!isCompletedActionItems(clause) || !isCompletedActionClause(clause)) continue;
      const kind = MINER_KINDS.find((r) => r.verbs.test(clause) && r.nouns.test(clause))?.kind ?? 'dispatch';
      const id = (clause.match(MINER_RECEIPT_ID)?.[1] ?? '').toLowerCase();
      out.push({ kind, detail: clause.slice(0, 200), ...(id ? { id } : {}) });
    }
    return out;
  };
  const stripContinuationLine = (text: string): { text: string; staleAnchor: boolean; minedItems: string | null } => {
    if (!anchoredContinuationLine) return { text, staleAnchor: false, minedItems: null };
    // LAST occurrence only: the appended closing line is the note's tail;
    // a model-typed echo earlier in the note is model prose and stays.
    const idx = text.lastIndexOf(anchoredContinuationLine);
    if (idx < 0) return { text, staleAnchor: true, minedItems: null };
    // Full-line boundary guard: a mid-line partial match is never the
    // appended closing — leave it (and everything else) in place.
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
    const lineEnd = idx + anchoredContinuationLine.length;
    if (text.slice(lineStart, idx).trim() !== '' || (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r')) {
      return { text, staleAnchor: true, minedItems: null };
    }
    const items = parseContinuationItems(anchoredContinuationLine);
    // (ticket 3cf9190c) HEAD-anchored mining decision: mine only when at
    // least one clause HEADS with a completed-action verb. The pre-fix test
    // was `isCompletedActionItems(items)` over the WHOLE items string, which
    // an intent-shaped clause could satisfy from a participle buried inside
    // it ("steer restored lane …") — that is exactly how the incident's own
    // promise got mined and struck.
    const minedItems = items && splitContinuationClauses(items).some((clause) => isCompletedActionClause(clause)) ? items : null;
    const head = text.slice(0, lineStart).replace(/\n{3,}/g, '\n\n');
    const tail = text.slice(lineEnd).replace(/^\n+/, '');
    return { text: `${head}${head && tail ? '\n' : ''}${tail}`, staleAnchor: false, minedItems };
  };
  const actionNoteResult = anchoredContinuationLine ? stripContinuationLine(note) : { text: note, staleAnchor: false, minedItems: null as string | null };
  const actionNote = actionNoteResult.text;
  if (anchoredContinuationLine && actionNoteResult.staleAnchor) {
    logger.info(`action-verifier: harnessContinuationLine anchor did not match the note as a full closing line in chat ${chatId.slice(0, 8)} — no strip, no mining (fail-closed to full audit; ticket 5c7727c4)`, { source: 'action-verifier', chatId });
  }
  if (anchoredContinuationLine && actionNoteResult.minedItems) {
    logger.info(`action-verifier: mined ${mineContinuationClaims(actionNoteResult.minedItems).length} completed-action claim(s) from the harness continuation line's items in chat ${chatId.slice(0, 8)} (anti-laundering — the items are model words; ticket 5c7727c4)`, { source: 'action-verifier', chatId });
  }

  // (ticket e65061e1) A tiny note no longer short-circuits the audit when the
  // run's tool_call args still carry a scannable narrative.
  // (ticket 331a1b23) receipts ride along: the scan's execution gate needs the
  // run's receipt rows to adjudicate UNANSWERED calls (a truncated parts log)
  // and to keep the fabricated-id lane armed on failed calls via ok envelopes.
  const argsBlobs = scanToolCallArgs(parts, input.receipts);
  if (note.length < MIN_NOTE_CHARS && !argsBlobs.length) {
    // (review F3) The floor exists to skip the LLM extraction — the
    // DETERMINISTIC citation lanes cost zero LLM calls, so a sub-floor note
    // carrying a fabricated msg-receipt citation OR a phantom session/chat
    // reference (ticket f1cb73ff) is still audited. The executed pool is the
    // same cheap deterministic build the main path does — a truthful
    // sub-floor "dispatched session X" keeps its receipt exoneration.
    // The executed pool is the same cheap deterministic build the main path
    // does — a truthful sub-floor "dispatched session X" keeps its receipt
    // exoneration. (ticket 61b9200a) Task executions ride the pool in BOTH
    // shapes: they mint no receipts, so parts are their only evidence.
    const subFloorExecuted: ExecutedAction[] = buildExecutedPool(input.receipts, parts);
    out.phantoms = mergeConvictions(
      mergeConvictions(
        mergeConvictions(
          await findPhantomEvidenceCitations(note, [], undefined, nearMissFor.message, citationHaystacks),
          await findPhantomScheduleCitations(note, [], undefined, nearMissFor.schedule, citationHaystacks),
        ),
        await findPhantomSessionRefs(note, [], subFloorExecuted, undefined, nearMissFor.chat, citationHaystacks),
      ),
      mergeConvictions(
        mergeConvictions(
          // (ticket b216475a) The ticket-citation lane is deterministic too — a
          // sub-floor note carrying a fabricated `ticket <id>` citation is still
          // audited (the 17:45Z incident note's "Receipts: tickets …" line).
          await findPhantomTicketCitations(note, [], userId, undefined, nearMissFor.ticket, citationHaystacks),
          // GOAL/TODO CITATION lane (ticket 3ed139cd) — deterministic, zero LLM
          // cost, so it rides the sub-floor path exactly like the other three.
          await findPhantomGoalTodoCitations(note, [], undefined, nearMissFor.goalTodo, citationHaystacks),
        ),
        // (tick 21, 2026-09-15) receipt + bare chat citation lanes — deterministic too.
        mergeConvictions(
          mergeConvictions(
            await findPhantomReceiptCitations(note, [], undefined, citationHaystacks),
            await findPhantomChatCitations(note, [], subFloorExecuted, undefined, nearMissFor.chat, citationHaystacks),
          ),
          // (owner 2026-09-16) board-assertion lane — a sub-floor "oq_X still open" is still audited.
          await findPhantomBoardAssertions(note, [], { chatId, supervisorScope: input.supervisorScope, runStartedAt: input.runStartedAt }),
        ),
      ),
    );
    // (ticket 7ea4819b) miscopy stamp on the sub-floor path too.
    stampMiscopiedIds(out.phantoms, subFloorExecuted, citationHaystacks);
    if (out.phantoms.length && supervisor) {
      const { appendVerifierRefutation } = await import('./supervisor-state.service');
      out.appendRefutation = appendVerifierRefutation;
    }
    return out;
  }

  // (ticket 61b9200a) Task executions ALWAYS ride the executed pool: computer_task
  // / browser_task mint no run-receipt, so a receipts-provided pool (the
  // supervisor + machine-wake callers) would otherwise be blind to them — the
  // exact blindness that convicted chat 0945e820's truthful task narration
  // ("executed: NONE" while the parts held a 12-step computer_task result).
  // Receipts stay authoritative for the tools they carry rows for (ok/staged
  // semantics); parts cover the rest (ticket d25172ca; an empty receipts array
  // is truthy and used to blank the parts lane entirely — and notify_user, now
  // receipted since todo 1e356736, still falls back to the parts lane when its
  // write failed), so no double count can arise from the union.
  const executed: ExecutedAction[] = buildExecutedPool(input.receipts, parts);
  out.executed = executed;

  // N5 (2026-09-25): mine claims DETERMINISTICALLY FIRST and start the
  // per-claim evidence gate against the executed pool. Started here, never
  // awaited in shadow (the LLM extraction below runs as before); settled by
  // the computePhantomClaims wrapper once the tier chain has its verdicts.
  // (2026-09-26 reachability fix) The candidates come from
  // mineGateClaimCandidates — the fleet's tool-name / receipt-anchored /
  // no-person idioms — NOT from the first-person fallback miner alone, which
  // mined nothing on real supervisor notes and kept this gate at zero rows.
  // Same NOTE_SLICE window as every other note surface; sub-floor notes never
  // reach here (the early return above), so they are never gated.
  const minedForGate = note.length >= MIN_NOTE_CHARS ? mineGateClaimCandidates(actionNote.slice(0, NOTE_SLICE)) : [];
  gateRef.gate = startClaimEvidenceGate({ chatId, claims: minedForGate, executed, kindTools: KIND_TOOLS });

  // (ticket e65061e1) Consequential-tool ARGS are a second claim surface: the
  // 2026-08-27 incident embedded a phantom dispatch story in file_feedback
  // args — the call itself was receipted, so the narrative INSIDE its
  // arguments passed unverified. Mine each tracked tool_call's args from parts
  // (keyword pre-gate — the same cheap gate the callers use), run the SAME
  // extractor over them, and let the tier chain below judge args claims
  // exactly like note claims: own-run receipts exonerate truthful narration;
  // the cross-wake tier + DB artifact check cover prior-run references.
  // NOTE and ARGS claims stay in SEPARATE lists here — they are matched
  // independently below (review B1).
  // (ticket e413c084) The LLM extraction is ONE coin flip per lane — in the
  // 2026-08-29 supervisor incident the pre-delivery guard's pass found zero
  // claims in a note whose final line was a first-person receipt citation, so
  // the phantom was DELIVERED while the post-delivery pass caught it. Two
  // failure shapes collapse here: an LLM error (degrade to the deterministic
  // receipt-idiom miner instead of blanking the audit) and an LLM miss (zero
  // claims → mine). FALLBACK ONLY — never unioned with LLM claims (see the
  // miner's header for the double-count hazard).
  let noteClaims: ExtractedClaim[] = [];
  // N5 ACT contract (designed, not enabled): an ACT request awaits the gate
  // in place of the LLM call; when the RESULT's mode is act and every mined
  // claim is confidently evidenced, the miner's claims stand and the LLM
  // lane is skipped. The tier chain below still judges every claim.
  let llmSkippedByGate = false;
  if (gateRef.gate && gateRef.gate.requestedMode === 'act' && note.length >= MIN_NOTE_CHARS) {
    const gateDecision = await gateRef.gate.decision;
    if (claimEvidenceWouldSkipLlm(gateDecision, gateRef.gate.claims.length)) {
      noteClaims = gateRef.gate.claims.map((c) => ({ kind: c.kind as ClaimKind, detail: c.detail, ...(c.id ? { id: c.id } : {}) }));
      llmSkippedByGate = true;
      gateRef.lane = 'gate';
      gateRef.acted = true;
      logger.info(`action-verifier: decision gate judged every mined claim evidenced for chat ${chatId.slice(0, 8)} — LLM claim extraction skipped (N5 act)`);
    }
  }
  if (note.length >= MIN_NOTE_CHARS && !llmSkippedByGate) {
    gateRef.lane = 'llm';
    noteClaims = await extractActionClaims(actionNote).catch((err: any) => {
      logger.warn(`action-verifier: LLM claim extraction failed (deterministic miner fallback still applies): ${err?.message}`, { source: 'action-verifier', chatId });
      return [] as ExtractedClaim[];
    });
    // (ticket 587e9d64) Verbatim-ground the LLM lane against the SAME window
    // the extractor saw: a paraphrase-hallucinated claim (kind/detail invented
    // from honest prose) is dropped BEFORE the tier chain can convict an
    // honest note on it. An emptied result falls through to the deterministic
    // miner exactly like an LLM error/miss (ticket e413c084 doctrine).
    // (ticket 5c7727c4) The grounding window is the ACTION window — the
    // anchored harness continuation line is stripped from both, so a claim
    // quoting it is grounded in (and only in) the model prose the tier chain
    // judges.
    const noteGround = groundExtractedClaims(noteClaims, actionNote.slice(0, NOTE_SLICE));
    if (noteGround.dropped.length) {
      logger.warn(`action-verifier: dropped ${noteGround.dropped.length} LLM-extracted note claim(s) with NO verbatim support in the audited note (ticket 587e9d64 grounding lane — extraction paraphrase-hallucination): ${noteGround.dropped.map((c) => `[${c.kind}] ${c.detail.slice(0, 120)}`).join(' | ')}`, { source: 'action-verifier', chatId });
    }
    noteClaims = noteGround.grounded;
    // (ticket 5c7727c4) ANTI-LAUNDERING: the anchored continuation line left
    // the extraction window, so the extractor can never judge its items —
    // but the items are the MODEL's own words. Completed-action-shaped
    // clauses are MINED deterministically (verbatim, no extractor
    // dependence) and enter the claim set here, facing the same tier chain
    // as any claim: truthful items exoneration via own-run receipts; a
    // completed-verb claim with no receipt convicts exactly as pre-fix. A
    // label-restore would be cosmetic — the extractor's prompt ignores
    // intent labels and non-first-person prose (the frontier review's
    // blocking finding).
    if (actionNoteResult.minedItems) {
      noteClaims = [...noteClaims, ...mineContinuationClaims(actionNoteResult.minedItems)];
    }
    // (audit 2026-10-08 W1-4) id-shape + verb-kind gate: a git sha read as a "ticket" never convicts.
    const noteShape = gateLlmClaimShapes(noteClaims);
    recordClaimShapeDrops(chatId, 'note', noteShape.dropped);
    noteClaims = noteShape.kept;
    // (ticket bbd8521e) third-party-attribution gate: a claim narrating ANOTHER
    // lane's action/status over a real artifact ("the dispatched lane 41fd09ed
    // is well ahead") is the extractor prompt's own IGNORE class, enforced.
    const noteThirdParty = dropThirdPartyAttributionClaims(noteClaims);
    recordThirdPartyDrops(chatId, 'note', noteThirdParty.dropped);
    noteClaims = noteThirdParty.kept;
    if (!noteClaims.length) {
      // NOTE_SLICE parity (review Finding 2): the fallback audits exactly the
      // text window the LLM extraction was shown — never a surface beyond it.
      const mined = mineReceiptIdiomClaims(actionNote.slice(0, NOTE_SLICE));
      if (mined.length) {
        logger.warn(`action-verifier: LLM extraction found no action claims; deterministic receipt-idiom miner contributes ${mined.length} (ticket e413c084 fallback)`, { source: 'action-verifier', chatId });
        noteClaims = mined;
        gateRef.lane = 'miner';
      }
    }
  }
  const argsClaims: ExtractedClaim[] = [];
  for (const blob of argsBlobs) {
    const found = await extractActionClaims(blob.text, `TOOL-CALL ARGUMENTS (JSON) of ${blob.tool}`).catch((err: any) => {
      logger.warn(`action-verifier: LLM args-claim extraction failed for ${blob.tool} (skipping that surface): ${err?.message}`, { source: 'action-verifier', chatId });
      return [] as ExtractedClaim[];
    });
    // (ticket 587e9d64) Same verbatim-grounding as the note surface, against
    // the SAME args window the extractor saw.
    const argsGround = groundExtractedClaims(found, blob.text.slice(0, NOTE_SLICE));
    if (argsGround.dropped.length) {
      logger.warn(`action-verifier: dropped ${argsGround.dropped.length} LLM-extracted args claim(s) with NO verbatim support in ${blob.tool}'s args (ticket 587e9d64 grounding lane)`, { source: 'action-verifier', chatId });
    }
    const argsShape = gateLlmClaimShapes(argsGround.grounded); // (audit 2026-10-08 W1-4)
    recordClaimShapeDrops(chatId, 'args', argsShape.dropped);
    // (ticket bbd8521e) same third-party-attribution gate on the args surface.
    const argsThirdParty = dropThirdPartyAttributionClaims(argsShape.kept);
    recordThirdPartyDrops(chatId, 'args', argsThirdParty.dropped);
    for (const c of argsThirdParty.kept) {
      argsClaims.push({ ...c, detail: `[in ${blob.tool} args] ${c.detail}`.slice(0, 200) });
    }
  }
  // ARGS-CITATION exoneration (ticket 0beea9f1): a ticket-kind claim mined
  // from tool-call ARGS is the CONTENT of an artifact being drafted — a
  // file_feedback description cross-referencing an EARLIER ticket ("earlier
  // runs returned truncated reports — ticket fcc28eba") — not a deed-claim
  // about this run. The action lane's recency gate (citedArtifactExists ≤1h)
  // rightly convicts "filed X this run" deed-claims, but a historical
  // cross-reference to a REAL same-tenant ticket row is truthful at any age;
  // convicting it struck a disciplined citation (2026-09-07, chat b93df15e:
  // fcc28eba was filed by the SAME chat six days earlier and carried a full
  // fix record). Existence, not recency: a FABRICATED id has no row and still
  // convicts through the normal tier chain below, so the 2026-08-27 args
  // incident shape (a phantom story riding an invented id) stays caught.
  // Scoped to the ARGS surface only — a NOTE-surface "ticket X" reads to the
  // user as a this-run deed-claim, where the recency gate stays. Id-less
  // ticket claims ("Now I'm filing the session-inheritance question") are
  // untouched: the count-slot accounting still convicts them (sighting 2 of
  // the same mishap).
  const argsTicketRefs = argsClaims.filter((c) => c.kind === 'ticket' && idish(c.id));
  if (argsTicketRefs.length) {
    // One indexed existence probe per candidate, PARALLEL (the evidence
    // lane's review-F4 discipline); .catch(() => true) preserves
    // fail-toward-miss even for a rejecting probe.
    const verdicts = await Promise.all(argsTicketRefs.map((c) => citedTicketRowExists(String(c.id), userId).catch(() => true)));
    const exonerated = new Set(argsTicketRefs.filter((_, i) => verdicts[i]).map((c) => String(c.id).toLowerCase()));
    if (exonerated.size) {
      for (let i = argsClaims.length - 1; i >= 0; i--) {
        const c = argsClaims[i];
        if (c.kind === 'ticket' && c.id && exonerated.has(String(c.id).toLowerCase())) argsClaims.splice(i, 1);
      }
      logger.info(`action-verifier: ${exonerated.size} args-surface ticket reference(s) in chat ${chatId.slice(0, 8)} exonerated by EXISTING same-tenant ticket rows (ticket 0beea9f1 lane) — historical cross-references, not phantoms`);
    }
  }
  // (ticket 331a1b23) ID-LESS ARGS-TWIN DEDUP: byte-identical id-less claims
  // mined from MULTIPLE args blobs of the same tool (a refused call's draft +
  // its ok retry — or any repeated call pair) collapse to ONE claim. The
  // count-slot accounting in findPhantomClaims budgets id-less claims against
  // ok executions; twins from one logical action over-subscribe the budget and
  // the LAST twin convicts as a phantom even when the note truthfully cites
  // the executed artifact. Deduping twins restores the budget to one-claim
  // per logical action — the id-less conviction lane itself is untouched (a
  // lone id-less claim with zero executions still convicts, 0beea9f1 pin).
  if (!argsTwinFixDisabled()) {
    const seen = new Set<string>();
    for (let i = argsClaims.length - 1; i >= 0; i--) {
      const c = argsClaims[i];
      if (c.id && String(c.id).trim()) continue; // cited-id claims stay (their tier chain is per-id)
      const key = `${c.kind}::${String(c.detail)}`;
      if (seen.has(key)) {
        argsClaims.splice(i, 1);
      } else {
        seen.add(key);
      }
    }
  }
  out.claims = [...noteClaims, ...argsClaims];

  // DURABLE-LEDGER build (hoisted, ticket ee212347 GAP A): the verdict
  // gate's durable-ledger fold (supervisor state-doc dispatches + the
  // caller-supplied PRIOR state-doc ids) must exist BEFORE the citation
  // lanes below so the session/chat-reference lane can exonerate an id the
  // chat cited from its own durable state. The prior-wake filter
  // (ae7db80b) and the fail-open `at` semantics are UNCHANGED — only the
  // placement moved up from below the citation lanes. See the full comment
  // block re-attached at the consumption site (~findPhantomClaims).
  const runStartedAt = input.runStartedAt;
  const startedMs = runStartedAt?.getTime();
  let ledgerIds: string[] = [];
  if (supervisor) {
    const { getSupervisorState, appendVerifierRefutation } = await import('./supervisor-state.service');
    const stateDoc = await getSupervisorState(chatId).catch(() => null);
    ledgerIds = (stateDoc?.dispatches ?? [])
      .filter((d) => {
        if (startedMs === undefined) return true;
        const at = Date.parse(d.at);
        return Number.isNaN(at) || at < startedMs;
      })
      .map((d) => d.id);
    out.appendRefutation = appendVerifierRefutation;
  }
  // GAP A (ticket ee212347): non-supervisor chats have no supervisor state
  // doc, so the durable dispatch ledger above is empty for them. Fold the
  // caller-supplied PRIOR state-doc ids into the same ledger so a truthful
  // cross-wake restatement exonerates identically. The caller supplies
  // already time-filtered (pre-run) ids, so NO prior-wake filter applies
  // here — the ae7db80b laundering guard is enforced upstream by the miner.
  // Deduped against the supervisor set.
  if (input.stateDocIds?.length) {
    const seen = new Set(ledgerIds);
    for (const id of input.stateDocIds) {
      if (typeof id === 'string' && id.length >= 8 && !seen.has(id)) {
        seen.add(id);
        ledgerIds.push(id);
      }
    }
  }

  // EVIDENCE-CITATION lane (ticket c1cbe6a2) — runs BEFORE the no-claims
  // early return: the 12:43Z incident note was PURE observation prose with
  // zero action claims by design of both extraction lanes, so this return
  // would otherwise skip the audit that catches a fabricated `msg <id>`
  // receipt citation. Same NOTE_SLICE window as the LLM/miner surfaces.
  const evidencePhantoms = await findPhantomEvidenceCitations(note.slice(0, NOTE_SLICE), out.claims, undefined, nearMissFor.message, citationHaystacks);
  if (evidencePhantoms.length) {
    logger.warn(`action-verifier: ${evidencePhantoms.length} fabricated msg-row evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (ticket c1cbe6a2 lane)`, { source: 'action-verifier', chatId });
  }
  // SCHEDULE-CITATION lane (ticket 5448a836) — same placement rationale as the
  // msg lane: a `sched <id>` citation is observation prose both action
  // extractors ignore by design, and the 18:34Z incident's invented schedule
  // id rode exactly that gap. Same NOTE_SLICE window; existence-checked
  // against coding_schedules.
  const schedulePhantoms = await findPhantomScheduleCitations(note.slice(0, NOTE_SLICE), out.claims, undefined, nearMissFor.schedule, citationHaystacks);
  if (schedulePhantoms.length) {
    logger.warn(`action-verifier: ${schedulePhantoms.length} fabricated schedule-row evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (ticket 5448a836 lane)`, { source: 'action-verifier', chatId });
  }
  // TICKET-CITATION lane (ticket b216475a) — same placement rationale as the
  // msg/sched lanes: a `ticket <id>` / "tickets filed" receipts citation is
  // observation prose both action extractors ignore by design, and the
  // 2026-09-13 incident's four invented feedback-ticket ids rode exactly that
  // gap (chat c0e22e36, notes ca59c504 + 3e5775d4). Same NOTE_SLICE window;
  // existence-checked against user_feature_requests (same-tenant scoped).
  const ticketPhantoms = await findPhantomTicketCitations(note.slice(0, NOTE_SLICE), out.claims, userId, undefined, nearMissFor.ticket, citationHaystacks);
  if (ticketPhantoms.length) {
    logger.warn(`action-verifier: ${ticketPhantoms.length} fabricated ticket-row evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (ticket b216475a lane)`, { source: 'action-verifier', chatId });
  }
  // SESSION/CHAT-REFERENCE lane (ticket f1cb73ff) — same placement rationale
  // as the evidence lane above: dispatch receipts ("session X RUNNING") and
  // owner-item chat refs ("reply in chat X") are observation/status prose
  // both action extractors ignore by design, so this deterministic pass must
  // run before the no-claims early return. Same NOTE_SLICE window; the run's
  // executed pool exonerates receipted dispatches before any DB probe.
  const sessionRefPhantoms = await findPhantomSessionRefs(note.slice(0, NOTE_SLICE), out.claims, executed, undefined, nearMissFor.chat, citationHaystacks, ledgerIds);
  if (sessionRefPhantoms.length) {
    logger.warn(`action-verifier: ${sessionRefPhantoms.length} phantom session/chat reference(s) in chat ${chatId.slice(0, 8)}'s note (ticket f1cb73ff lane)`, { source: 'action-verifier', chatId });
  }
  // GOAL/TODO-CITATION lane (ticket 3ed139cd) — same placement rationale as
  // the other citation lanes: a `goal <id>`/`todo <id>` board citation is
  // observation/status prose both action extractors ignore by design, so this
  // deterministic pass must run before the no-claims early return. Same
  // NOTE_SLICE window; existence-checked against project_goals/project_todos.
  const goalTodoPhantoms = await findPhantomGoalTodoCitations(note.slice(0, NOTE_SLICE), out.claims, undefined, nearMissFor.goalTodo, citationHaystacks);
  if (goalTodoPhantoms.length) {
    logger.warn(`action-verifier: ${goalTodoPhantoms.length} fabricated goal/todo evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (ticket 3ed139cd lane)`, { source: 'action-verifier', chatId });
  }
  // VANISHED-ARTIFACT lane (rollout watch 2026-09-14) — the absence register
  // the session/chat lane deliberately EXCLUDES ("chat X 404'd / vanished /
  // no longer exists"): a vanished artifact must leave a trace or appear in
  // this run's tool output; a zero-trace one never existed.
  const vanishedPhantoms = await findPhantomVanishedArtifactCitations(note.slice(0, NOTE_SLICE), out.claims, undefined, nearMissFor.chat, citationHaystacks);
  if (vanishedPhantoms.length) {
    logger.warn(`action-verifier: ${vanishedPhantoms.length} zero-trace "vanished" chat/session citation(s) in chat ${chatId.slice(0, 8)}'s note (vanished-artifact lane)`, { source: 'action-verifier', chatId });
  }
  // (tick 21, 2026-09-15) receipt + bare chat citation lanes — the Fleet
  // Supervisor's "(msgs a, b, c; chats x, y)" / "(receipt z)" idioms.
  const receiptPhantoms = await findPhantomReceiptCitations(note.slice(0, NOTE_SLICE), out.claims, undefined, citationHaystacks);
  if (receiptPhantoms.length) {
    logger.warn(`action-verifier: ${receiptPhantoms.length} fabricated receipt evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (tick-21 lane)`, { source: 'action-verifier', chatId });
  }
  const chatCitationPhantoms = await findPhantomChatCitations(note.slice(0, NOTE_SLICE), out.claims, executed, undefined, nearMissFor.chat, citationHaystacks);
  if (chatCitationPhantoms.length) {
    logger.warn(`action-verifier: ${chatCitationPhantoms.length} fabricated bare chat/session/lane evidence citation(s) in chat ${chatId.slice(0, 8)}'s note (tick-21 lane)`, { source: 'action-verifier', chatId });
  }
  // (owner 2026-09-16) board-assertion lane — status/open-closed claims vs the ledger.
  const boardPhantoms = await findPhantomBoardAssertions(note.slice(0, NOTE_SLICE), out.claims, { chatId, supervisorScope: input.supervisorScope, runStartedAt: input.runStartedAt });
  if (boardPhantoms.length) {
    logger.warn(`action-verifier: ${boardPhantoms.length} board assertion(s) contradicting the ledger in chat ${chatId.slice(0, 8)}'s note (board lane): ${boardPhantoms.map((p) => `${p.kind}${p.id ? ' ' + p.id : ''} asserted=${p.asserted} ledger=${p.ledger}`).join('; ')}`, { source: 'action-verifier', chatId });
  }
  const citationPhantoms = mergeConvictions(mergeConvictions(mergeConvictions(mergeConvictions(mergeConvictions(mergeConvictions(mergeConvictions(mergeConvictions(evidencePhantoms, schedulePhantoms), sessionRefPhantoms), goalTodoPhantoms), ticketPhantoms), vanishedPhantoms), receiptPhantoms), chatCitationPhantoms), boardPhantoms);
  if (!out.claims.length) {
    out.phantoms = citationPhantoms;
    // (ticket 7ea4819b) The deterministic lanes' convictions get the miscopy
    // stamp too — a `ticket <id>`/`msg <id>` citation mistranscribed from this
    // run's real envelope is this incident's exact shape, sub-floor or not.
    stampMiscopiedIds(out.phantoms, executed, citationHaystacks);
    // Supervisor-only durable refutation must survive the early return too —
    // the state-doc writer is normally assigned in the ledger block below,
    // which this branch skips (the citation lanes need no ledger: row
    // existence is the whole exoneration test).
    if (citationPhantoms.length && supervisor) {
      const { appendVerifierRefutation } = await import('./supervisor-state.service');
      out.appendRefutation = appendVerifierRefutation;
    }
    return out;
  }

  // The durable dispatch ledger exonerates truthful cross-wake
  // Main's state doc (#296): getSupervisorState degrades to an EMPTY doc
  // on any failure — the ledger check just finds nothing. Supervisor
  // chats only — no other chat has a state doc. (The ledger build itself
  // was HOISTED above the citation lanes by ticket ee212347 GAP A.)
  // PRIOR-WAKE FILTER (ticket ae7db80b, 2026-08-25): dispatch `at` stamps
  // are harness-written at merge time (the model supplies only
  // kind/id/note), so they are forgery-proof: only entries stamped BEFORE
  // this run started exonerate. Entries with no parseable `at`
  // (legacy/hand-edited rows) keep exonerating power — fail open against
  // false convictions. Absent runStartedAt the filter cannot apply — keep
  // the whole ledger (pre-fix behavior).
  // Per-surface matching (review B1, ticket e65061e1): note claims and args
  // claims match the executed pool INDEPENDENTLY — findPhantomClaims consumes
  // pool slots, and a truthful id-bearing restatement in one surface must not
  // steal the slot a truthful id-less restatement in the other counts on (the
  // common granularity mismatch: notes say "dispatched the worker", args cite
  // the full session id). Note claims run the pre-e65061e1 semantics
  // UNCHANGED. Convictions merge deduped per (kind, cited id), note first
  // (mergeConvictions — module scope since ticket f1cb73ff).
  // (ticket 5ad80b27) The own-artifact kind-consistency tier rides BOTH
  // surfaces and BOTH passes with the citation lanes' trusted haystack seam
  // (tool OUTPUTS only — never args). The sink collects every exoneration;
  // the cross-wake re-run re-exonerates the same claims, so the count is
  // deduped before it is reported.
  const ownArtifactExonerated: ExtractedClaim[] = [];
  const ownArtifactTier: OwnArtifactTierInput = { evidenceTexts: citationHaystacks, exonerated: ownArtifactExonerated };
  let phantoms = mergeConvictions(
    await findPhantomClaims(noteClaims, executed, undefined, ledgerIds, ownArtifactTier, chatId),
    argsClaims.length ? await findPhantomClaims(argsClaims, executed, undefined, ledgerIds, ownArtifactTier) : [],
  );

  // Cross-wake exoneration (run-receipts follow-up): a claim restating an
  // action from a PRIOR wake of THIS chat has no in-run evidence by
  // definition. Before convicting, re-run the SAME deterministic matcher
  // with this chat's durable receipts appended to the pool — filtered to
  // receipts created BEFORE this run started (a later receipt would be the
  // claim causing its own evidence). Tier order: in-run pool → cross-wake
  // receipts → (when no receipts were provided at all) the parts parse that
  // built the pool. The read degrades to [] on error → today's behavior.
  if (phantoms.length && runStartedAt) {
    const prior = (await getRecentChatReceipts(chatId, CROSS_WAKE_WINDOW_MS).catch(() => [] as ToolReceipt[]))
      .filter((r) => r.createdAt < runStartedAt);
    if (prior.length) {
      const poolX = [...executed, ...receiptsToActions(prior)];
      const withCrossWake = mergeConvictions(
        await findPhantomClaims(noteClaims, poolX, undefined, ledgerIds, ownArtifactTier, chatId),
        argsClaims.length ? await findPhantomClaims(argsClaims, poolX, undefined, ledgerIds, ownArtifactTier) : [],
      );
      out.crossWakeExonerated = phantoms.length - withCrossWake.length;
      if (out.crossWakeExonerated > 0) {
        logger.info(`action-verifier: ${out.crossWakeExonerated} claim(s) in chat ${chatId.slice(0, 8)} exonerated by PRIOR-WAKE receipts (cross-wake, ≤24h) — not phantoms`);
      }
      phantoms = withCrossWake;
    }
  }
  // PIPELINE CROSS-CHECK exoneration (ticket 899554af, mishap 2026-09-19 —
  // FALSE-POSITIVE strike on a TRUE claim): an L2 'thinking' run's synthesis
  // narrates the Double Checker's contribution ("passed a full digest … to a
  // crossmodel agent (helper-model `cross_checker`), and merged its
  // independent gap list with my own read" — chat bb8b8c99, 2026-09-19T00:52Z).
  // The checker lane REALLY ran — chat_search_usage stamped mode:'thinking'
  // at 00:52:44.647Z, one second before the strike — and its draft was
  // injected into the orchestrator's context, but a pipeline peer mints no
  // consequential-tool receipt and leaves no part, so the executed pool was
  // EMPTY and the [dispatch]-classified narration convicted ("Executed
  // consequential actions this run: NONE"). chat-agent now passes
  // crossCheckDelivered === crossCheckMerged: TRUE only when the checker's
  // draft was genuinely MERGED this turn — a non-empty injected block or a
  // successful late-reconcile (reviewer F1/N1: a gate-timeout / empty-draft /
  // late-armed run whose lead answered alone keeps the conviction power).
  // Vocabulary-anchored, kind-
  // agnostic: ONLY claims naming the cross-check pipeline are acquitted — a
  // co-riding "dispatched a coding session X" convicts with the flag on, and
  // a fabricated "cross_checker receipt msg xyz" still dies in the citation
  // lanes (the checker mints no receipt ids to cite). Runs WITHOUT the flag
  // (L1, machine wakes — which skip the checker — coding lanes, every pre-
  // 2026-09-19 caller) see byte-identical behavior.
  if (phantoms.length && input.crossCheckDelivered === true) {
    const kept = phantoms.filter((p) => !isCrossCheckPipelineNarration(p));
    const acquitted = phantoms.length - kept.length;
    if (acquitted > 0) {
      out.pipelineCrossCheckExonerated = acquitted;
      logger.info(`action-verifier: ${acquitted} claim(s) in chat ${chatId.slice(0, 8)} exonerated as TRUE narration of the run's OWN L2 cross-check pipeline (drafts delivered this turn — ticket 899554af) — not phantoms`);
    }
    phantoms = kept;
  }
  // COUNCIL DISPATCH exoneration (ticket 7cabb0cc, mishap 2026-10-08 — the L3
  // twin of the tier above, exactly the shape its comment deferred: "the L3
  // lane is a separate shape … council notes keep today's audit either way").
  // A Dig-deeper research rung's lead truthfully narrates the council round it
  // dispatched ("I dispatched both council colleagues … but both ran past the
  // dispatch ceiling and their reports came back empty"); the round REALLY ran
  // (dispatchRounds > 0 — the anchor chat-agent passes here) but is invisible
  // to the executed pool: dispatch_colleagues is an inline chat-agent tool,
  // not a tracked consequential tool, and the colleague runs mint no receipt
  // and leave no part. The extractor labels the honest narration [dispatch],
  // no dispatch slot can match, and the note convicted with "Executed
  // consequential actions this run: NONE" (chat 182f27b7, 2026-10-08) — the
  // verifier's own line was the only false statement in the thread. Same
  // anchors as the L2 tier: vocabulary-gated (isCouncilDispatchNarration) and
  // kind-agnostic on purpose (the extractor's kind label is the coin flip,
  // not the evidence), with the ID-LESS scope as the laundering guard — a
  // council-shaped claim that cites an id keeps full conviction power (the
  // council mints no citable ids, so the id can only be invented), and a run
  // that never dispatched (flag false — L1, L2, machine wakes, coding lanes,
  // every pre-2026-10-08 caller) sees byte-identical behavior.
  if (phantoms.length && input.councilDispatched === true) {
    const kept = phantoms.filter((p) => !isCouncilDispatchNarration(p));
    const acquitted = phantoms.length - kept.length;
    if (acquitted > 0) {
      out.councilDispatchExonerated = acquitted;
      logger.info(`action-verifier: ${acquitted} claim(s) in chat ${chatId.slice(0, 8)} exonerated as TRUE narration of the run's OWN L3 council dispatch round (dispatched this turn — ticket 7cabb0cc) — not phantoms`);
    }
    phantoms = kept;
  }
  if (ownArtifactExonerated.length) {
    const uniq = new Set(ownArtifactExonerated.map((c) => `${c.kind}|${String(c.id ?? '').toLowerCase()}|${c.detail}`));
    out.ownArtifactExonerated = uniq.size;
    logger.info(`action-verifier: own-artifact kind-consistency tier (ticket 5ad80b27) exonerated ${uniq.size} claim(s) in chat ${chatId.slice(0, 8)} — grounded detail + own-run artifact id + no kind narration — not phantoms`);
  }
  // FABRICATED-ID classification (fleet 17:14Z incident, 2026-09-15): an
  // action-lane conviction whose cited id exists NOWHERE is deterministic —
  // the always-on citation enforcement must not lose it to the coin-flip
  // action class. The 17:14Z note claimed "schedule_message → sched 88d9287e",
  // "file_feedback → ticket 61797fe8" (both invented) beside a fabricated
  // "goal ff4f99fd" citation; the mixed set was delivered UNMODIFIED because
  // only the goal was citation-class.
  // (ticket 7ea4819b) The miscopy tier runs FIRST, over the MERGED conviction
  // set (action lanes + deterministic citation lanes — a `ticket <id>`
  // evidence citation mistranscribed from this run's REAL envelope is this
  // incident's exact shape): a miscopy must never be classified as invented
  // (cited 59a407b-ee05-… vs the run's real file_feedback envelope
  // 59a4407b-ee05-…, one dropped char).
  const merged = citationPhantoms.length ? mergeConvictions(phantoms, citationPhantoms) : phantoms;
  const miscopied = stampMiscopiedIds(merged, executed, citationHaystacks);
  if (miscopied) {
    logger.info(`action-verifier: ${miscopied} conviction(s) in chat ${chatId.slice(0, 8)} cite id(s) miscopied from this run's real result envelope(s) — stamped miscopiedFrom, not fabricated`, { source: 'action-verifier', chatId });
  }
  const fabricated = await markFabricatedIds(merged, note, citationHaystacks);
  if (fabricated) {
    logger.warn(`action-verifier: ${fabricated} action-lane conviction(s) in chat ${chatId.slice(0, 8)} cite id(s) that exist in NO artifact table — fabricated ids, enforced as citation-class`, { source: 'action-verifier', chatId });
  }
  // (ticket c5629165) MISATTRIBUTED-FILING classification: a [ticket]
  // conviction citing a REAL row this chat never filed is a misattribution,
  // not an invention — stamp it so every strike surface names the true class
  // and never advises the duplicate re-filing the generic action advice
  // would. Runs over the MERGED conviction set, after the miscopy tier
  // (a miscopy's backing filing DID run this run — never this class) and
  // after markFabricatedIds (an invented id has no row; a misattributed id
  // has one, so the two classes are disjoint by construction).
  const misattributed = await stampMisattributedFilings(merged, chatId, executed, runStartedAt);
  if (misattributed) {
    logger.info(`action-verifier: ${misattributed} conviction(s) in chat ${chatId.slice(0, 8)} cite REAL ticket row(s) this run did not file — stamped misattributedFiling (read-then-claimed-authorship), not fabricated`, { source: 'action-verifier', chatId });
  }
  out.phantoms = citationPhantoms.length ? mergeConvictions(phantoms, citationPhantoms) : phantoms;
  return out;
}

/**
 * The cited-id + near-miss suffix EVERY conviction surface renders (tickets
 * ef347cd0 + e3246ad5 NB#3): "cited id X — does not exist; same-prefix real
 * ids: …" — the strike teaches the lane the id it MEANT. One shared helper so
 * the ticket, the in-thread correction, the pre-delivery notice, and the
 * durable state-doc refutation can never drift apart.
 * (ticket 7ea4819b) A MISCOPIED conviction renders its own clause — the real
 * id this run's envelope carried — which is strictly more actionable than a
 * same-prefix bucket (the incident's corruption sat INSIDE the 8-char prefix,
 * so the bucket came back empty and the strike taught nothing).
 */
const citedIdSuffix = (p: ExtractedClaim): string =>
  p.id
    ? p.misattributedFiling
      ? ` (cited id ${p.id} — a REAL ticket row, but this run never filed it: the row's filer is another session and/or its filing predates this run, while this run's own tool outputs show only a READ — the claim misattributed a filing, it did not invent the id)`
      : p.miscopiedFrom
      ? ` (cited id ${p.id} — does not exist AS WRITTEN; this run's real result envelope carried ${p.miscopiedFrom} — the id was miscopied, not invented)`
      : ` (cited id ${p.id}${p.nearMiss?.length ? ` — does not exist; same-prefix real ids: ${p.nearMiss.join('; ')}` : ''})`
    : '';

/**
 * (ticket 7ea4819b) A strike whose citations are ALL miscopies (each stamped
 * miscopiedFrom) gets its own framing tier, below board-status in specificity:
 * the backing actions DID run, the ids were mistranscribed — "invented from
 * memory" is false for this class, and "call the tool" advice would DUPLICATE
 * a real action. A MIXED set (a miscopy beside a true fabrication) keeps the
 * fabrication framing for the whole strike (the any-fabrication-keeps-the-
 * framing doctrine); each miscopy's detail line still names its real id.
 */
/**
 * (ticket c5629165) A strike whose citations are ALL misattributed filings
 * (each stamped misattributedFiling) gets its own framing tier, below
 * board-status and miscopy in specificity: the cited tickets EXIST, the ids
 * were honestly copied from real reads — only the AUTHORSHIP was claimed.
 * "Invented from memory" is false for this class, and "call the tool" advice
 * would DUPLICATE a real filing (the same harm ticket 7ea4819b removed for
 * miscopies). A MIXED set keeps the framing of its most severe co-riding
 * class (the any-fabrication-keeps-the-framing doctrine).
 */
export const isMisattributedFilingClaim = (claim: ExtractedClaim): boolean => claim.misattributedFiling === true;
export const allMisattributedFilingClaims = (phantoms: ExtractedClaim[]): boolean =>
  phantoms.length > 0 && phantoms.every(isMisattributedFilingClaim);

export const isMiscopiedClaim = (claim: ExtractedClaim): boolean => claim.miscopiedFrom !== undefined;
export const allMiscopiedClaims = (phantoms: ExtractedClaim[]): boolean =>
  phantoms.length > 0 && phantoms.every(isMiscopiedClaim);

/**
 * One rendering of the conviction list — shared by the ticket, the in-thread
 * correction, and the pre-delivery notice. A convicted citation carries its
 * near-miss hint inline (ticket ef347cd0). Exported for tests.
 */
export const claimDetailLines = (phantoms: ExtractedClaim[]): string =>
  phantoms.map((p) => `- [${p.kind}] "${p.detail}"${citedIdSuffix(p)}`).join('\n');

/**
 * (FO firing 57, 2026-09-30) Bounded per-claim audit excerpts for the strike
 * surfaces that DON'T reach the delivered note — the PRE-DELIVERY warn context
 * (→ app_error_logs.context) and the guard_strike metric meta (→ loop_metrics).
 * Production evidence for the fix: 10 strikes/24h across six supervisor lanes
 * each read "1 phantom claim(s)" while carrying {chatId} only, and every
 * reject-back outcome row (the ~5-min bounded re-orchestration, retryMs
 * 324–341s) carried phantoms:0 because pass 2 — the CLEAN retry — overwrote
 * the verdict that caused the retry. The operator could not adjudicate
 * verifier false-positive vs real phantom from telemetry. Same fields as
 * claimDetailLines (kind / detail / id / near-miss hint), hard-capped:
 * 4 claims, detail 120 chars, ids 24 chars, 4 near-misses — bounded enough for
 * a log context / JSONB meta cell, complete enough to adjudicate the class
 * cold. Exported for tests + the chat-agent seam (reject-back metric rows).
 */
export const claimAuditExcerpts = (phantoms: ExtractedClaim[]): Array<{ kind: string; detail: string; id?: string; nearMiss?: string[]; miscopiedFrom?: string; misattributedFiling?: boolean }> =>
  phantoms.slice(0, 4).map((p) => ({
    kind: String(p.kind ?? ''),
    detail: String(p.detail ?? '').slice(0, 120),
    ...(p.id ? { id: String(p.id).slice(0, 24) } : {}),
    ...(p.nearMiss?.length ? { nearMiss: p.nearMiss.slice(0, 4).map((x) => String(x).slice(0, 24)) } : {}),
    // (ticket 7ea4819b) the recovered REAL id — the field an operator needs to
    // adjudicate miscopy vs invention cold.
    ...(p.miscopiedFrom ? { miscopiedFrom: String(p.miscopiedFrom).slice(0, 24) } : {}),
    // (ticket c5629165) read-then-claimed-authorship — the row EXISTS, the
    // filer is another session; the operator adjudicates misattribution vs
    // fabrication from this flag without re-deriving the row lookup.
    ...(p.misattributedFiling ? { misattributedFiling: true } : {}),
  }));

/**
 * The DURABLE refutation's detail (ticket e3246ad5 NB#3): the pre-fix
 * rendering kept only p.detail, so the state-doc VERIFIER REFUTED line — the
 * one surface guaranteed to reach every later wake — dropped the cited id and
 * its same-prefix hint while the ticket/correction/notice carried them. Same
 * single-line '; '-joined shape as before, now with the shared suffix.
 * Exported for tests.
 */
export const refutationDetail = (phantoms: ExtractedClaim[]): string =>
  phantoms.map((p) => `${p.detail}${citedIdSuffix(p)}`).join('; ');

/**
 * Citation-class vs action-class convictions (ticket 5e1ca207 — 22 sightings,
 * 3 reopens). The deterministic EVIDENCE lanes ('[evidence citation]' — msg +
 * sched — and '[owner chat ref]') existence-check the cited id: a conviction
 * there means the note cited an id that exists NOWHERE — fabricated EVIDENCE,
 * not an unexecuted action. The action-class framing ("claimed action(s) that
 * did NOT execute … call the tool and cite the id from its result envelope")
 * mis-describes that failure and teaches the wrong lesson: there is no tool
 * call that "does" a citation, so the lane kept inventing envelope-style ids
 * strike after strike while the correction told it to "call the tool". A
 * strike whose convictions are ALL citation-class gets its own ticket bucket
 * + correction wording; ANY action-class conviction (LLM extractor, receipt-
 * idiom miner, args surface, or a '[dispatch receipt]' — a narrated dispatch
 * the run never executed, for which "call the tool" IS the right advice)
 * keeps the action framing for the whole strike.
 */
const CITATION_CLASS_TAGS = ['[evidence citation]', '[owner chat ref]', '[vanished artifact]', BOARD_ASSERTION_TAG] as const;
// (Fleet 17:14Z incident, 2026-09-15) An action-lane conviction stamped
// `fabricatedId` — its cited id exists in NO artifact table and in none of
// the run's tool outputs — is existence arithmetic too: citation-class.
// (ticket 7ea4819b, 2026-10-07) A conviction stamped `miscopiedFrom` — its
// cited id near-matches this run's REAL envelope of the same kind — is the
// same deterministic arithmetic (the id as written still resolves to nothing),
// so it stays enforceable pre-delivery; only the DIAGNOSIS differs.
export const isCitationClassClaim = (claim: ExtractedClaim): boolean =>
  claim.fabricatedId === true || claim.miscopiedFrom !== undefined || CITATION_CLASS_TAGS.some((tag) => String(claim.detail ?? '').startsWith(tag));
export const allCitationClassClaims = (phantoms: ExtractedClaim[]): boolean =>
  phantoms.length > 0 && phantoms.every(isCitationClassClaim);
// (ticket e4138a3d, 2026-09-26) A BOARD-STATUS strike is a different failure
// class from an existence strike: the cited row EXISTS (the detail line quotes
// its real ledger status) and only the ASSERTED STATUS contradicts it. The
// pre-fix prose told that lane its ids "exist nowhere" and "were invented from
// memory" — teaching the exact opposite of the true lesson (re-read the [BOARD]
// block / re-pull the ledger) and misfiling the mishap as id fabrication in
// triage. Board-COUNT convictions ([board count]) are id-less and observed-only
// — they are NOT this class.
export const isBoardStatusClaim = (claim: ExtractedClaim): boolean =>
  String(claim.detail ?? '').startsWith(BOARD_ASSERTION_TAG);
export const allBoardStatusClaims = (phantoms: ExtractedClaim[]): boolean =>
  phantoms.length > 0 && phantoms.every(isBoardStatusClaim);

/**
 * The strike's correction tail — what the lane must LEARN from it (ticket
 * 5e1ca207). Citation-class: the cited id was never seen in a tool result —
 * re-pull or drop the citation; there is no action to "actually do".
 * Board-status-only (ticket e4138a3d): the ids are REAL — the row exists and
 * only the asserted status was wrong; the lesson is re-read the board, not
 * re-cite an id.
 */
export const correctionAdvice = (citationOnly: boolean, fabricatedActionIds = false, boardStatusOnly = false, miscopyOnly = false, misattributedOnly = false): string =>
  boardStatusOnly
    ? 'These are BOARD-STATUS errors, not fabricated ids: every cited row above EXISTS — the struck line asserted a status the ledger contradicts (each detail line names both the asserted and the real status). BOARD FACTS (a goal or todo STATUS, whether an owner question is open or answered, how many goals/todos are active) come ONLY from the [BOARD] block in your wake or a this-run goal_list / todo_list / list_owner_questions pull — a status you remember is not evidence. Re-pull the ledger before asserting any board status, and quote the status verbatim from that pull.'
    : miscopyOnly
    ? 'These citations were MISCOPED, not invented: each cited id is one or two characters off an id this run\'s real tool result envelope actually carried (the real id is named per line above). The backing action DID run — do NOT call the tool again (that would duplicate a real ticket filing / send / dispatch); the only defect is the written id. To fix: re-open the tool result that produced it and copy the id VERBATIM, character for character, or write (id not captured) with the tool name + clock time — always acceptable, never penalized. Never retype an id from memory: when you cannot see it, scroll back to the result envelope or drop the citation.'
    : misattributedOnly
    ? 'These are MISATTRIBUTED FILINGS, not inventions and not unexecuted plans: every cited ticket EXISTS and the ids are real (you READ them via get_feedback / list_feedback this run), but the filings were made by ANOTHER session and/or before this run — this run never called file_feedback for them. Do NOT call file_feedback again (that would file a DUPLICATE of a real ticket); the ticket already exists and the cited id already points at it. The only defect is the CLAIMED DEED: correct the record by re-attributing the filing ("ticket <id>, filed earlier by its own lane / during an earlier run") or dropping the filing claim entirely. AUTHORSHIP FACTS (who filed a ticket, when) come from the ticket row itself — context.filedBy / createdAt in a get_feedback read — never from memory or from the mere fact that you know the id. A ticket you can cite is a ticket you can reference honestly: say what you did with it (read it, verified it, linked it), not that you filed it.'
    : citationOnly
    ? 'These citations are fabricated EVIDENCE, not unexecuted actions — there is no tool call that "does" a citation. NEVER reproduce an id from memory or from your own earlier notes: cite ONLY an id you can see verbatim in a tool result from THIS run (get_chat_messages / list_chats / list_schedules / schedule_get / a receipt envelope) — EVERY id in a list ("msgs a, b, c", "chats x, y", "receipts p, q") is checked, not just the first. BOARD FACTS (a goal or todo STATUS, whether an owner question is open or answered, how many goals/todos are active) come ONLY from the [BOARD] block in your wake or a this-run goal_list / todo_list / list_owner_questions pull — a status you remember is not evidence, and a struck line above names the real ledger status. If you cannot see the id right now, DROP the citation and write (id not captured) with the lane + clock time instead — always acceptable, never penalized; an invented id is always struck. Any same-prefix real id(s) named above are what you likely meant — re-pull the source and confirm before citing.'
      + (fabricatedActionIds
        ? ' Where a fabricated id labelled an ACTION you claimed to have taken (a schedule armed or cancelled, a ticket filed, a message sent, a session started), that action is ALSO NOT DONE — the id was invented, so no tool ran; to actually do it, call the tool and copy the id from its JSON result envelope ({ok:true, ids:{...}}).'
        : '')
    : 'These are NOT done. Never restate them as done. To actually do them, call the tool and cite the id from its JSON result envelope ({ok:true, ids:{...}}).';

/**
 * Banner prefixing the USER-FACING in-thread correction (ticket d78f477b):
 * an assistant-role retraction posted into a human's visible thread when the
 * post-delivery verifier convicts phantom claims on a user-anchored turn.
 * Exported for tests.
 */
export const USER_FACING_CORRECTION_BANNER = '⚠️ [ACTION VERIFIER — automated integrity check]';

/**
 * Consequence (a), shared by BOTH lanes: the deduped mishap ticket. The title
 * is stable per chat, so fileFeedbackTicket's normalized-title dedupe bumps ONE
 * ticket's occurrences instead of flooding the queue — and a pre-delivery
 * strike and a post-delivery catch of the same pattern land in the SAME bucket.
 * `preDelivery` only appends a provenance line to the description; the title
 * (the dedup identity) is untouched.
 */
async function filePhantomTicket(opts: {
  chatId: string;
  userId: string;
  supervisor: boolean;
  /** Seat label for supervisor tickets (hardening review 2026-09-14); 'fleet' when omitted. */
  supervisorScope?: SupervisorScope;
  machineTriggered: boolean;
  phantoms: ExtractedClaim[];
  executed: ExecutedAction[];
  crossWakeExonerated: number;
  note: string;
  preDelivery?: boolean;
  /** Strip+mark strikes (tickets 5e1ca207/e66950c1) file with delivered-redacted provenance instead of replaced;
   *  (audit 2026-10-08 W1-4) 'annotated' = delivered as written with an observe-only annotation. */
  delivery?: 'replaced' | 'redacted' | 'annotated';
}): Promise<void> {
  const { chatId, userId, supervisor, machineTriggered, phantoms, executed, crossWakeExonerated, note } = opts;
  const chat8 = chatId.slice(0, 8);
  // Citation-class framing (ticket 5e1ca207): a citation-only strike files
  // under its OWN normalized title — a separate dedup bucket from the action
  // bucket, so fabricated-citation sightings stop reopening the action-class
  // ticket and the description names the true failure (invented ids, not
  // unexecuted actions).
  const citationOnly = allCitationClassClaims(phantoms);
  // (ticket e4138a3d) Board-status-only strike: its OWN bucket again — the
  // cited row EXISTS and only the asserted status contradicts the ledger.
  // Filing it as "cited id(s) do not exist" mis-describes the failure in
  // triage AND collides it with the true-fabrication bucket's dedupe.
  const boardStatusOnly = citationOnly && allBoardStatusClaims(phantoms);
  // (ticket 7ea4819b) Miscopy-only strike: its OWN bucket too — every cited id
  // was OBSERVED in this run's real envelope and then mistranscribed. "Invented
  // from memory" is false for this class and the two must not share a dedupe
  // bucket (the incident: 59a407b-… vs the run's real envelope 59a4407b-…).
  const miscopyOnly = citationOnly && !boardStatusOnly && allMiscopiedClaims(phantoms);
  // (ticket c5629165) Misattributed-filing-only strike: its OWN bucket as
  // well — every cited ticket EXISTS, the ids were honestly copied from real
  // reads, and only the AUTHORSHIP was claimed. Distinct dedupe identity so
  // read-then-claimed-authorship sightings never collide with the
  // invented-id bucket (the incident: chat 91d79e37 claimed "one new platform
  // ticket filed — ca805a61" over a ticket session 9effe0d0 had filed six
  // days earlier).
  const misattributedOnly = !citationOnly && allMisattributedFilingClaims(phantoms);
  // Seat attribution (hardening review 2026-09-14): a PROJECT supervisor's
  // strike used to file as "The fleet supervisor's…" under area
  // 'fleet-supervisor' — the prose predates project supervisors (2026-08-22),
  // and it folded three project lanes into the fleet seat's ticket queue /
  // per-area triage. The TITLE is deliberately unchanged (it is the dedupe
  // identity; chat8 already separates buckets) — only prose, area and the
  // structured context field name the seat.
  const supervisorScope: SupervisorScope | null = supervisor ? (opts.supervisorScope ?? 'fleet') : null;
  const who = supervisor
    ? (supervisorScope === 'project' ? "A project supervisor's machine-wake note" : "The fleet supervisor's machine-wake note")
    : `A ${machineTriggered ? 'machine-triggered' : 'user-facing'} chat turn`;
  // (ticket e4138a3d) Board-status head: the row EXISTS, the STATUS is wrong.
  // Existence prose ("exist nowhere, invented from memory") is false for this
  // class — the 00:14Z CQL strike filed as id-fabrication while its own detail
  // line quoted the real row's ledger status "active".
  const head = boardStatusOnly
    ? `${who} asserted board status(es) that CONTRADICT the ledger — the cited row(s) EXIST and every cited id is real, but the asserted status disagrees with the row's ledger status (quoted per claim below). The note mis-stated board STATE from memory — not ids, not actions.`
    : miscopyOnly
    ? `${who} cited evidence id(s) that DO NOT EXIST AS WRITTEN — each one a near-miss (one or two characters) of an id this run's own tool result envelope actually carried: the citation was OBSERVED and then MISCOPED, not invented. The backing action(s) DID execute (see the executed list below); only the written id is wrong, so a reader following it finds nothing.`
    : misattributedOnly
    ? `${who} claimed to have FILED ticket(s) it only READ — every cited ticket EXISTS (the ids are real, observed in this run's get_feedback / list_feedback outputs), but each was filed by another session and/or before this run: the note misattributed AUTHORSHIP of a filing, it did not invent an id and no fabricated artifact exists. The defect is the claimed deed, not the citation.`
    : citationOnly
    ? `${who} cited evidence id(s) that DO NOT EXIST — existence-checked against crossmodel message / coding_schedule / chat rows (an existing row exonerates; these exist nowhere, so the ids were invented from memory rather than observed in a tool result). The note fabricated EVIDENCE, not an action.`
    : `${who} claimed actions its tool log never executed.`;
  const { fileFeedbackTicket } = await import('../feedback/feedback.service');
  await fileFeedbackTicket({
    userId,
    type: 'mishap',
    title: boardStatusOnly
      ? supervisor
        ? `Supervisor board-status assertion contradicts the ledger (chat ${chat8})`
        : `Board-status assertion contradicts the ledger (chat ${chat8})`
      : miscopyOnly
      ? supervisor
        ? `Supervisor miscited evidence id(s): miscopied from this run's real envelope (chat ${chat8})`
        : `Miscited evidence id(s): chat miscopied a real this-run id (chat ${chat8})`
      : misattributedOnly
      ? supervisor
        ? `Supervisor misattributed filing: claimed tickets it only read (chat ${chat8})`
        : `Phantom filing claim: chat claimed tickets it only READ, not filed (chat ${chat8})`
      : citationOnly
      ? supervisor
        ? `Supervisor fabricated evidence citation: cited id(s) do not exist (chat ${chat8})`
        : `Phantom evidence citation: chat cited id(s) that do not exist (chat ${chat8})`
      : supervisor
        ? `Supervisor phantom claim: narrated action(s) never executed (chat ${chat8})`
        : `Phantom action claim: chat asserted action(s) never executed (chat ${chat8})`,
    description: `${head}\n\n${boardStatusOnly ? 'Contradicted board assertion(s)' : miscopyOnly ? 'Miscopied citation(s)' : misattributedOnly ? 'Misattributed filing claim(s)' : citationOnly ? 'Fabricated citation(s)' : 'Phantom claims'}:\n${claimDetailLines(phantoms)}\n\nExecuted consequential actions this run: ${executed.filter((a) => a.ok).map((a) => `${a.tool}→${JSON.stringify(a.ids)}`).join(', ') || 'NONE'}${crossWakeExonerated ? `\n\nCross-wake exonerations (claims that cited actions PROVABLY executed by a prior wake of this chat, ≤24h, run_tool_receipts): ${crossWakeExonerated} — those are NOT phantoms.` : ''}\n\nNote excerpt:\n${note.slice(0, 1500)}${opts.preDelivery ? (opts.delivery === 'annotated' ? '\n\nPre-delivery strike (guardMachineWakeFinalAnswer, observe-only — audit 2026-10-08 W1-4): the note was DELIVERED AS WRITTEN with a trailing annotation naming the unverified claim(s); nothing was removed.' : opts.delivery === 'redacted' ? '\n\nPre-delivery strike (guardMachineWakeFinalAnswer, strip+mark): the note was DELIVERED with the phantom-claim line(s) removed and marked — the struck claim line(s) never reached the thread; surviving content was delivered unmodified.' : '\n\nPre-delivery strike (guardMachineWakeFinalAnswer): the note was REPLACED before it reached the thread — the phantom claim(s) were never delivered; the original survives as a quoted audit block.') : ''}`,
    // audit 2026-10-08 W5-1b: stored INSTEAD of the description (which quotes the note) when the chat's account is not
    // an admin — the harness head + claim kinds + cited ids, never chat text (feedback/harness-ticket.ts).
    shapeDescription: `${head} Claim shape: ${phantoms.slice(0, 8).map((p) => `[${p.kind}]${p.id ? ` cites ${String(p.id).slice(0, 40)}` : ' (no id)'}`).join(', ')}${phantoms.length > 8 ? ` +${phantoms.length - 8} more` : ''}; executed consequential actions this run: ${executed.filter((a) => a.ok).map((a) => a.tool).join(', ') || 'NONE'}${opts.preDelivery ? `; pre-delivery strike (${opts.delivery === 'redacted' ? 'strip+mark' : opts.delivery === 'annotated' ? 'delivered as written with observe-only annotation (audit 2026-10-08 W1-4)' : 'replaced'})` : ''}.`,
    priority: 3,
    area: supervisor ? (supervisorScope === 'project' ? 'project-supervisor' : 'fleet-supervisor') : 'fleet-integrity',
    context: {
      sessionId: chatId,
      surface: 'chat',
      verifier: 'action-verifier',
      filedAt: new Date().toISOString(),
      // Structured seat label (hardening review 2026-09-14) — nothing filters
      // on area or prose today; a later per-seat read keys on this field.
      ...(supervisorScope ? { supervisorScope } : {}),
      // Strip+mark strikes are HANDLED events (the note was delivered with the
      // convicted line(s) elided) — feedback.service's reopen path counter-bumps
      // a done ticket on this marker instead of reopening it (5e1ca207 churn).
      ...(opts.delivery === 'redacted' ? { deliveredRedacted: true } : {}),
      ...(opts.delivery === 'annotated' ? { deliveredAnnotated: true } : {}),
      // Pre-delivery containment (ticket aac649ba — 9 sightings / 3 reopens of
      // pure churn on chat aa78e314): a guardMachineWakeFinalAnswer strike —
      // full replacement OR strip+mark — means the struck content never
      // reached the thread as-authored. That is CONTAINED recidivism (the
      // model re-offended, the guard caught it pre-delivery), NOT a
      // containment escape: counter-bump the closed ticket, never reopen.
      // The only genuine escape in this lane is the post-delivery catch
      // (verifyRunActionClaimsAsync), which files with no preDelivery flag
      // and keeps the legacy reopen behavior.
      ...(opts.preDelivery === true ? { containedPreDelivery: true } : {}),
    },
  }).catch((err: any) => logger.warn(`action-verifier: ticket filing failed: ${err?.message}`, { source: 'action-verifier' }));
}

/**
 * The general finalize hook (ticket ae085617 — the verifier used to cover
 * ONLY supervisor machine wakes; a plain interactive chat asserting a
 * file_feedback filing with an invented ticket id was unguarded).
 * Fire-and-forget. Callers pre-gate with executed-actions.ts
 * hasActionClaimKeywords so no-claim turns never pay the LLM extraction.
 *   - supervisor: full consequence chain — state-doc ledger exoneration,
 *     in-thread correction, durable refutation.
 *   - non-supervisor machine-triggered: ticket + in-thread correction (the
 *     next wake must see the refutation in-window).
 *   - non-supervisor user-watched: ticket + ASSISTANT-role in-thread
 *     correction (ticket d78f477b — the human who just read the phantom claim
 *     must see the retraction; an assistant row renders as Digby correcting
 *     itself, never as a bubble they never typed).
 *
 * The matcher itself lives in computePhantomClaims (shared with the
 * pre-delivery guard — ticket fcc4dbb4); this entry is its POST-DELIVERY
 * consequence shell.
 */
export function verifyRunActionClaimsAsync(input: PhantomClaimAuditInput): void {
  void (async () => {
    try {
      const { chatId, userId } = input;
      const comp = await computePhantomClaims(input);
      if (!comp.phantoms.length) return;
      const { supervisor, supervisorScope, machineTriggered, phantoms, executed, crossWakeExonerated, note } = comp;

      const chat8 = chatId.slice(0, 8);
      const detailLines = claimDetailLines(phantoms);
      logger.warn(`action-verifier: ${phantoms.length} phantom claim(s) in ${supervisor ? 'supervisor' : 'chat'} ${chat8}'s note`, { source: 'action-verifier', chatId: chat8 });

      // (a) Deduped mishap ticket — the shared triage queue is the fix loop.
      // The title is stable per chat, so fileFeedbackTicket's normalized-title
      // dedupe bumps ONE ticket's occurrences instead of flooding the queue.
      await filePhantomTicket({ chatId, userId, supervisor, supervisorScope, machineTriggered, phantoms, executed, crossWakeExonerated, note });

      // (b) In-thread correction — lands inside the next wake's history window.
      // Machine runs get a machine-authored 'user' row (orchestration advice
      // for the next wake); a human's interactive thread gets an ASSISTANT-role
      // correction instead (ticket d78f477b) — a machine-authored 'user' row
      // would render as a bubble they never typed (the ae085617 objection),
      // while an assistant row reads as Digby correcting itself, which is
      // exactly what is happening.
      if (machineTriggered) {
        const citationOnly = allCitationClassClaims(phantoms);
        // (ticket e4138a3d) Board-status-only: the ids are REAL, the asserted
        // status is wrong — name the true failure class, never "do not exist".
        const boardStatusOnly = citationOnly && allBoardStatusClaims(phantoms);
        // (ticket 7ea4819b) Miscopy-only: the ids were OBSERVED then mistyped —
        // name the true class ("miscopied, not invented"), never "invented".
        const miscopyOnly = citationOnly && !boardStatusOnly && allMiscopiedClaims(phantoms);
        // (ticket c5629165) Misattributed-filing-only: the tickets are REAL and
        // the ids honest — only the AUTHORSHIP was claimed. Never "call the
        // tool" (that would duplicate a real filing).
        const misattributedOnly = !citationOnly && allMisattributedFilingClaims(phantoms);
        await prisma.crossModelMessage.create({
          data: {
            chatId,
            role: 'user',
            content: boardStatusOnly
              ? `[ACTION VERIFIER — automated integrity check] Your last status note asserted board status(es) that CONTRADICT the ledger — every cited id below is REAL (the row exists), but the asserted status disagrees with the row's ledger status:\n${detailLines}\n${correctionAdvice(true, false, true)}`
              : miscopyOnly
              ? `[ACTION VERIFIER — automated integrity check] Your last status note cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id THIS RUN's tool result envelope actually carried (miscopied, not invented; the real id is named per line below):\n${detailLines}\n${correctionAdvice(true, false, false, true)}`
              : misattributedOnly
              ? `[ACTION VERIFIER — automated integrity check] Your last status note claimed to have FILED ticket(s) this run never filed — every cited ticket EXISTS and the ids are real (you READ them via get_feedback / list_feedback), but the filings were another session's and/or predate this run:\n${detailLines}\n${correctionAdvice(false, false, false, false, true)}`
              : citationOnly
              ? `[ACTION VERIFIER — automated integrity check] Your last status note cited evidence id(s) that DO NOT EXIST (database existence-checked — a real row would have exonerated them):\n${detailLines}\n${correctionAdvice(true)}`
              : `[ACTION VERIFIER — automated integrity check] Your last status note claimed action(s) that did NOT execute (no matching successful tool call in that run):\n${detailLines}\n${correctionAdvice(false)}`,
            metadata: { origin: 'machine', verifier: 'action-verifier' },
          },
        }).catch((err: any) => logger.warn(`action-verifier: correction inject failed: ${err?.message}`, { source: 'action-verifier' }));
      } else {
        // USER-FACING correction (ticket d78f477b, 2026-09-09): the pre-fix
        // lane filed the deduped ticket and STOPPED — the human who just read
        // the phantom claim was never told it was false (chat 089fb613: the
        // user was left believing a browser task had dispatched to their Mac
        // and might have a file downloading; nothing had run). Post an
        // assistant-role retraction naming the convicted claim(s): it renders
        // in the visible thread AND lands in the next turn's conversation
        // history, so the model sees its own retraction and stops doubling
        // down. Human-addressed wording — no orchestration advice.
        const citationOnly = allCitationClassClaims(phantoms);
        // (ticket e4138a3d) Board-status-only: the ids are real, the status was
        // wrong — the human-facing retraction must say exactly that.
        const boardStatusOnly = citationOnly && allBoardStatusClaims(phantoms);
        // (ticket 7ea4819b) Miscopy-only: the human retraction must not call a
        // miscopied citation "fabricated" — the action DID run.
        const miscopyOnly = citationOnly && !boardStatusOnly && allMiscopiedClaims(phantoms);
        // (ticket c5629165) Misattributed-filing-only: the tickets are REAL —
        // the human retraction must say the filings were not this run's, never
        // "nothing was filed" (the tickets exist; only the authorship was
        // claimed).
        const misattributedOnly = !citationOnly && allMisattributedFilingClaims(phantoms);
        // OBSERVE-ONLY on human chats (owner 2026-10-04): the 2026-09-11 gate flip
        // made every other action-class strike observe-only, but this lane kept
        // posting a user-visible retraction — 4 landed on real plain chats in 7
        // days (prod readout TP1004B), one of them a false positive on an honest
        // "my browser task timed out". The deduped mishap ticket above is the
        // record; the user sees the answer unmodified. ACTION_VERIFIER_ENFORCE=1
        // restores the posted correction (the d78f477b behaviour).
        // (No early return: a human turn on a SUPERVISOR chat still gets the durable
        // refutation below.)
        if (process.env.ACTION_VERIFIER_ENFORCE !== '1') {
          logger.info(`action-verifier: ${phantoms.length} phantom claim(s) on human chat ${chatId} — observe-only (ticket filed, no user-visible correction; ACTION_VERIFIER_ENFORCE=1 posts it)`, { source: 'action-verifier', outcome: 'observed', claims: phantoms.length, citationOnly });
        } else await prisma.crossModelMessage.create({
          data: {
            chatId,
            role: 'assistant',
            content: boardStatusOnly
              ? `${USER_FACING_CORRECTION_BANNER} Correction: my previous message asserted board status(es) that contradict the ledger — the cited row(s) are REAL, but the status I stated disagrees with their actual ledger status:\n${detailLines}\nPlease treat those status claim(s) as NOT verified — I've re-checked the board and will state statuses only from a fresh pull.`
              : miscopyOnly
              ? `${USER_FACING_CORRECTION_BANNER} Correction: my previous message miscited reference id(s) — each is one or two characters off the id the tool result actually returned (the real id is named per line below). The action itself DID run:\n${detailLines}\nPlease disregard the miscited id(s) — the filed ticket / sent message / dispatched session is real; only my transcription of its id was wrong.`
              : misattributedOnly
              ? `${USER_FACING_CORRECTION_BANNER} Correction: my previous message claimed I had filed ticket(s) I did not file — the tickets are REAL and the ids are correct, but the filings were made earlier / by another session; I only read them:\n${detailLines}\nPlease treat the filing claim(s) as withdrawn — the tickets exist and the cited ids point at them; only the claim that I filed them was wrong.`
              : citationOnly
              ? `${USER_FACING_CORRECTION_BANNER} Correction: my previous message cited reference id(s) that DO NOT EXIST (database existence-checked — a real row would have exonerated them):\n${detailLines}\nPlease disregard those citations — they were fabricated, not observed.`
              : `${USER_FACING_CORRECTION_BANNER} Correction: my previous message claimed action(s) that did NOT actually run — no matching successful tool call exists in that turn's log:\n${detailLines}\nPlease treat the claim(s) above as NOT done — nothing was dispatched, sent, filed, downloaded, or executed. If you still want it done, say the word and I'll retry for real.`,
            metadata: { origin: 'machine', verifier: 'action-verifier' },
          },
        }).catch((err: any) => logger.warn(`action-verifier: user-facing correction inject failed: ${err?.message}`, { source: 'action-verifier' }));
      }

      // (c) Durable refutation in the state doc (rendered into every later
      // wake block; the supervisor's own update_supervisor_state merge can
      // never erase it). Supervisor only — no state doc elsewhere.
      if (comp.appendRefutation) {
        await comp.appendRefutation(chatId, userId, refutationDetail(phantoms)).catch(() => {});
      }
    } catch (err: any) {
      logger.warn(`action-verifier: verification failed (non-fatal): ${err?.message}`, { source: 'action-verifier' });
    }
  })();
}

/**
 * Supervisor machine-wake entry (the original name — kept so existing wiring
 * and tests read true): the general verifier with the full supervisor chain.
 */
export function verifySupervisorRunAsync(input: {
  chatId: string;
  userId: string;
  finalText: string;
  parts: RunPartLike[];
  /** Receipts ride the spread into the general verifier (see verifyRunActionClaimsAsync). */
  receipts?: ToolReceipt[];
  /** Cross-wake anchor — see verifyRunActionClaimsAsync. */
  runStartedAt?: Date;
  /** Seat label (hardening review 2026-09-14) — rides the spread; 'fleet' when omitted. */
  supervisorScope?: SupervisorScope;
  /** TRUE cross-check narration anchor (ticket 899554af) — rides the spread; see PhantomClaimAuditInput.crossCheckDelivered. */
  crossCheckDelivered?: boolean;
  /** TRUE council-dispatch anchor (ticket 7cabb0cc) — rides the spread; see PhantomClaimAuditInput.councilDispatched. */
  councilDispatched?: boolean;
  /** Harness continuation-line anchor (ticket 5c7727c4) — rides the spread; see PhantomClaimAuditInput.harnessContinuationLine. */
  harnessContinuationLine?: string | null;
}): void {
  verifyRunActionClaimsAsync({ ...input, supervisor: true, machineTriggered: true });
}

/** The pre-delivery guard's banner — harness-only chrome, DISTINCT from the coding lane's [HARNESS EVIDENCE GUARD] markers. */
export const ACTION_GUARD_BANNER = "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]";

/**
 * Strip+mark banner (tickets 5e1ca207 / e66950c1) — a machine note whose
 * convicted claims were ALL id-bearing and note-locatable is DELIVERED with
 * those lines removed instead of wholesale-replaced. Same '[ACTION VERIFIER —'
 * prefix, so guard-chrome-redact's prefix lane (ACTION_VERIFIER_BANNER_PREFIX)
 * swaps it for the generic placeholder in model context exactly like the
 * replacement banner.
 */
export const ACTION_GUARD_REDACT_BANNER = "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS DELIVERED WITH UNPROVEN CLAIM LINE(S) REMOVED]";

/**
 * The 1:1 elision marker for the strip+mark lane. Tests pin its safety: no
 * action-claim keywords, no citation idioms, no id-shaped tokens, no
 * timestamps — it must extract zero claims if a future audit ever re-reads it.
 */
export const REDACTED_CLAIM_LINE = '⛔ [line removed by the action verifier — it carried an unproven claim; details in the verifier notice]';

/**
 * Strip+mark redaction (tickets 5e1ca207 / e66950c1 — the supervisor
 * citation-phantom cluster: 19+ wholesale-withheld notes whose valid triage
 * content was destroyed along with the fabrication). Exported for tests.
 *
 * Returns the note with every line carrying a convicted claim's cited id
 * replaced 1:1 by REDACTED_CLAIM_LINE — or null, in which case the caller
 * fails closed to the full replacement. Null unless ALL hold:
 *   1. every conviction is id-bearing (id-less count-budget convictions and
 *      `[in <tool> args]` convictions have no note line to strip);
 *   2. every convicted id appears verbatim in ≥1 note line (an unlocatable
 *      conviction cannot be stripped — never guess);
 *   3. elided non-empty lines ≤ 50% of the note's non-empty lines (a gutted
 *      note is not a delivery worth making);
 *   4. ≥1 non-empty line survives.
 * Every line carrying a convicted id is elided (not just the first): a
 * nonexistent id is unproven everywhere it appears.
 */
export function tryRedactNoteLines(note: string, phantoms: ExtractedClaim[]): string | null {
  if (!phantoms.length) return null;
  if (!phantoms.every((p) => idish(p.id))) return null;
  const ids = [...new Set(phantoms.map((p) => String(p.id)))];
  const lines = note.split('\n');
  const elide = new Set<number>();
  for (const id of ids) {
    let found = false;
    lines.forEach((line, i) => {
      if (line.includes(id)) { elide.add(i); found = true; }
    });
    if (!found) return null;
  }
  const nonEmptyIdx = lines.map((_l, i) => i).filter((i) => lines[i].trim().length > 0);
  const elidedNonEmpty = nonEmptyIdx.filter((i) => elide.has(i)).length;
  if (elidedNonEmpty === 0) return null;
  if (elidedNonEmpty * 2 > nonEmptyIdx.length) return null; // >50% gutted — fail closed
  if (nonEmptyIdx.length - elidedNonEmpty < 1) return null; // zero survivors — fail closed
  return lines.map((l, i) => (elide.has(i) ? REDACTED_CLAIM_LINE : l)).join('\n');
}

// ── PRODUCTION-STATE UNREAD lane (supervisor doctrine audit D1, 2026-09-27) ──
//
// The incident class: a project supervisor told the owner a specific build
// was serving on its cluster — confabulated from memory, with NO read of that
// state on the chat for two weeks — and another supervisor narrated a later,
// better result as the awaited verdict. No lane audited PRODUCTION-STATE
// sentences: the existence lanes ask whether a cited id exists, the board
// lane whether a status matches the ledger, the clock lane whether an
// observation is possible — a "what is serving / deployed / running / banked"
// sentence carrying no id at all passed every one of them.
//
// This lane is DETERMINISTIC and OBSERVE-ONLY (the 2026-09-11 gate flip: a
// strike on a machine lane's own work is telemetry + a note, never a
// withhold). It mines sentences whose predicate asserts production state
// (PRODUCTION_STATE_RE) and asks whether THIS RUN read anything that could
// have grounded them:
//   - a sentence carrying GROUNDABLE FACT TOKENS (anything with a digit —
//     "NVFP4", "433", "s2v12r6", "0.6.2", an 8-hex id — minus bare one- or
//     two-digit counts, which any tool output carries by accident) is UNREAD
//     when NONE of those tokens appears as a WHOLE TOKEN in this run's
//     grounding haystack (tool_result texts of evidence-bearing reads +
//     ok-receipt ids + the seam's extra haystacks) — precision over recall:
//     one grounded token exonerates the sentence;
//   - a sentence with no groundable token ("the cluster is serving", "2
//     replicas are live") is UNREAD only when the run made NO evidence-bearing
//     read at all (coding/evidence-tools vocabulary — update_plan /
//     search_memory / ask_user prove nothing);
//   - the "on main head" shape is grounded by an onMainHead field in any
//     platform-observe read (get_fleet_telemetry view 'deploy') — the fact it
//     asserts is that field, not the digits around it.
// Grounding haystack discipline (review fixes 2026-09-27): a memory read
// (NON_EVIDENCE_TOOLS), the supervisor's own state doc (get_supervisor_state)
// and a get_chat_messages read of the supervisor's OWN chat never ground a
// production sentence — those are the very surfaces the confabulation came
// from ("a prior note is not a fact"); a LANE's message read this wake does.
// Exemptions (each a precision guard, none a loophole for the incident):
// quoted lines ('> ', the sentence splitter drops them); forward-intent
// sentences (will / plan / once / until / ETA — a plan is not an observation,
// whole-sentence); and, CLAUSE-SCOPED so a neighbour claim on the same
// sentence is still mined: the honest "not read this wake" / unverified
// disclaimer the doctrine prescribes, the history register in its GOVERNING
// form (a past-tense predicate — "was serving" — or "last wake / yesterday /
// 2 h ago"; a bare "last" or "prior" elsewhere in the sentence exempts
// nothing), and a negated predicate ("is not yet in production").
// every internal
// failure returns [] (fail-open). The chat-agent seam records a guard_strike
// row (seam machine_wake_production_state, outcome observed,
// strike production_state_unread) and delivers the note UNMODIFIED; the
// nightly strike adjudicator and the same-seam alarm both skip the seam.
export const PRODUCTION_STATE_STRIKE = 'production_state_unread';
export const PRODUCTION_STATE_SEAM = 'machine_wake_production_state';
export const PRODUCTION_STATE_MAX_HITS = 6;
/** The doctrine's honest escape hatch — verbatim in both supervisor prompts. */
export const PRODUCTION_STATE_NOT_READ_PHRASE = 'not read this wake';
/** Tool results that never ground a production sentence: the supervisor's own memory surfaces. */
export const PRODUCTION_STATE_MEMORY_TOOLS: ReadonlySet<string> = new Set(['get_supervisor_state']);

export interface ProductionStateHit {
  /** The offending sentence or clause (≤ 180 chars). */
  sentence: string;
  /** The digit-bearing tokens the sentence rests on (≤ 8), none of which this run read. */
  factTokens: string[];
  /** 'tokens_unread' — groundable fact tokens present, none in the haystack; 'no_read_this_run' — no groundable token, zero evidence-bearing reads. */
  reason: 'tokens_unread' | 'no_read_this_run';
}

export interface ProductionStateAuditInput {
  parts?: RunPartLike[] | null;
  receipts?: Array<Pick<ToolReceipt, 'tool' | 'ok' | 'ids'>> | null;
  /** Extra TRUSTED tool-output text (the reject-back seam's first-attempt texts). */
  extraEvidenceHaystacks?: string[];
  /** The chat this note is written on: a get_chat_messages read of THIS chat re-reads the supervisor's own prior notes and grounds nothing. */
  selfChatId?: string | null;
  /**
   * 2026-10-22 review (owner-turn live-state read, chat-agent.service.ts): the text is an OWNER answer, not a
   * machine-wake note — questions, offers and restated asks are never claims there (ownerTurnClaimUnits). The
   * machine lane never sets it, so its observe-only baseline is byte-identical.
   */
  ownerTurn?: boolean;
}

// The predicate shapes: "<X> is/remains/still serving|deployed|live|banked",
// "serving|deployed|banked on|in|at|from|since", "in production", "on main
// head", "up and running", "is running on|in|at" (a lane "running" a job is a
// lane state, not production — the locative particle is what marks the
// production shape). "healthy" / "online" are lane-health vocabulary
// ("lane X is healthy and online"), not production state — dropped (review
// 2026-09-27). Past-tense auxiliaries are NOT claim shapes: "was serving" is
// the history register (PRODUCTION_STATE_HISTORY_RE).
const PRODUCTION_STATE_RE = /\b(?:(?:is|are|remains?|stays?|still|now|currently|already)\s+(?:being\s+)?(?:serving|served|deployed|live|banked|up\s+and\s+running|running\s+(?:on|in|at)|in\s+production|on\s+main\s+head)\b|\b(?:serving|serves|deployed|deploys|banked)\s+(?:on|in|at|from|since|as|via|behind)\b|\bin\s+production\b|\bon\s+main\s+head\b|\bonMainHead\b)/i;
// The "on main head" shape — grounded by an onMainHead field in a platform-observe read.
const PRODUCTION_STATE_MAIN_HEAD_RE = /\bon\s+main\s+head\b|\bonMainHead\b/i;
// The honest disclaimer (doctrine) — a clause that says it did not read is
// not a claim of state.
const PRODUCTION_STATE_DISCLAIMER_RE = /\b(?:not\s+(?:re-?)?read\s+this\s+wake|unread\s+this\s+wake|not\s+read\s+this\s+(?:run|sweep|turn)|unverified|not\s+verified|unconfirmed|cannot\s+verify|could\s+not\s+verify|no\s+(?:fresh\s+)?read\s+this\s+wake)\b/i;
// Forward intent / plan — an intention is not an observation (kept NARROWER
// than the clock lane's FUTURE_INTENT_RE: that list is a whole-line exemption
// tuned for clocks; "next"/"expect" alone would exempt ordinary state lines).
// Whole-sentence: a plan sentence is a plan even across its clauses.
const PRODUCTION_STATE_FORWARD_RE = /\b(?:will|would|should|shall|plan(?:s|ned|ning)?\s+to|going\s+to|about\s+to|once\s+(?:it|the|that)|until|eta|to\s+be\s+(?:deployed|served|banked))\b/i;
// History register in its GOVERNING form only (review fix 2026-09-27): a
// past-tense predicate, or a past-reference phrase that names a past moment.
// A bare "last" / "prior" / "earlier" ("the last checkpoint … is serving",
// "per the prior plan … is serving") governs nothing and exempts nothing —
// the OWNER-FACING NUMBERS rule itself makes supervisors write "since the
// owner's last message" inside production sentences.
const PRODUCTION_STATE_HISTORY_RE = /\b(?:was|were|had\s+been|used\s+to\s+be)\s+(?:being\s+|still\s+)?(?:serving|served|deployed|live|banked|up\s+and\s+running|running|in\s+production|on\s+main\s+head)\b|\b(?:last|previous|prior)\s+(?:wake|sweep|run|firing|turn|time|night|week|month|check|read)\b|\byesterday\b|\bpreviously\b|\bearlier\s+(?:today|tonight|this\s+(?:wake|sweep|week))\b|\b\d+\s*(?:m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|weeks?)\s+ago\b|\bused\s+to\b|\bno\s+longer\b/i;
// A negated predicate is not a claim of state ("PR 1098 is not yet in
// production", "the checkpoint is not deployed", "never banked").
const PRODUCTION_STATE_NEGATION_RE = /\b(?:not|never|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|nor|no)\s+(?:yet\s+|currently\s+|actually\s+|even\s+|being\s+)*(?:serving|served|deployed|live|banked|running|up|in\s+production|on\s+main\s+head)\b|\b(?:un-?deployed|offline)\b/i;
// Clause boundaries for the clause-scoped exemptions: ';', a dash, or a
// coordinating conjunction (with or without its comma). Bare commas are NOT
// boundaries ("stock X, the current build, is serving" is one claim), nor is
// "yet" ("not yet in production" is one negated clause).
const PRODUCTION_STATE_CLAUSE_SPLIT_RE = /\s*(?:;|—|–|,?\s+(?:and|but|while|whereas)\s+)\s*/i;
// Clock / ISO stamps are stripped BEFORE token mining (a clock is never a
// production fact; "14:20Z" would otherwise shed "14" and "20Z").
const PRODUCTION_STATE_CLOCK_STRIP_RE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b|(?<![\d:])\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\s*(?:[ap]\.?m\.?)?\s*(?:Z|UTC|[EPMC][DS]T)?\b/gi;
// A fact token: one or more word-ish chars containing at least one digit
// ("NVFP4", "433", "s2v12r6", "0.6.2", "3e1cae6f", "GLM-5.3", "t3.large").
// The trailing lookahead forbids a WORD char or a dot-then-word (mid-token)
// but allows a sentence-ending period ("… t3.large." is the token t3.large).
const PRODUCTION_STATE_FACT_TOKEN_RE = /(?<![\w.])(?=[\w.\/-]*\d)[A-Za-z0-9][\w.\/-]*[A-Za-z0-9](?!\w|\.\w)|(?<![\w.])\d(?!\w|\.\w)/g;
// A bare one- or two-digit count ("4 nodes", "2 replicas", "32 slots") is
// reported as a fact token but never GROUNDS the sentence: any tool output
// carries such digits by accident (review fix 2026-09-27 — "chats: 4 rows"
// exonerated the incident sentence).
const PRODUCTION_STATE_BARE_COUNT_RE = /^\d{1,2}$/;

function productionStateClauses(sentence: string): string[] {
  return sentence.split(PRODUCTION_STATE_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter((c) => c.length >= 12);
}

/** The clause-scoped exemptions: true when this clause is NOT a claim of present production state. */
function productionStateClauseExempt(clause: string): boolean {
  return PRODUCTION_STATE_DISCLAIMER_RE.test(clause) || PRODUCTION_STATE_HISTORY_RE.test(clause) || PRODUCTION_STATE_NEGATION_RE.test(clause);
}

// ── Owner-turn claim units (2026-10-22 review of the owner-turn live-state read) ──
// The matcher was written for machine-wake notes, which carry no chips, offers or
// restated questions; an OWNER answer does ("Want me to verify that the v0.6.3
// agent is deployed on mbp-1?", "You asked whether glm-5.3 is deployed on
// spark-2"), and every one of those was mined as a claim — a pointless re-run and
// a harness line quoting the offer back as a "claim". On an owner turn
// (ProductionStateAuditInput.ownerTurn) a sentence is first reduced to what it
// ASSERTS:
//   - its question chunks go (a '?' ending a chunk; a statement piece in front of
//     a hard separator stays: "Yes, it's deployed on spark-2 — want logs?");
//   - each clause is cut at a governing cue — whether / if / unless / in case /
//     check | verify | confirm that|whether|if / make sure / ensure ("it is
//     deployed on spark-2 if the canary passed" keeps its claim, "If it is
//     deployed on spark-2, …" keeps nothing); never the past tense — "I confirmed
//     that it is deployed on spark-2" IS a claim;
//   - a unit that still carries the doctrine's not-read disclaimer is exempt
//     WHOLE: the owner-turn re-run tells the model to "say in the same sentence
//     that it was not read this turn", so "GLM-5.3 is deployed on spark-2 — not
//     read this turn" (the dash is a clause boundary for the machine lane) is the
//     honest exit, never a hit.
// Precision over recall, as the lane's own design: a miss is the pre-check status
// quo, a false hit costs the owner an extra round and a misleading line. Machine
// wakes never take this path.
const OWNER_TURN_QUESTION_END_RE = /\?+["'”’*_)\]]*(?=\s|$)/g;
const OWNER_TURN_HARD_SEP_RE = /\s*(?:;|—|–)\s*/g;
const OWNER_TURN_INTERROGATIVE_LEAD_RE = /^[\s*_\-•"“'‘(]*(?:is|are|was|were|am|do|does|did|has|have|had|can|could|should|shall|will|would|may|might|must|want|what|what['’]s|which|who|whom|whose|where|when|why|how|any)\b/i;
const OWNER_TURN_GOVERNING_CUE_RE = /\b(?:whether|if|unless|in\s+case|(?:check|verify|confirm)(?:ing|s)?\s+(?:that|whether|if)|make\s+sure|ensure)\b/i;

/** A question chunk's leading statement pieces (by ; — –) — kept while none of them opens like a question; the '?' piece always goes. */
function ownerTurnStatementLead(chunk: string): string {
  const seps = [...chunk.matchAll(OWNER_TURN_HARD_SEP_RE)];
  let start = 0;
  let keptEnd = 0;
  for (const m of seps) {
    const at = m.index ?? 0;
    if (OWNER_TURN_INTERROGATIVE_LEAD_RE.test(chunk.slice(start, at))) break;
    keptEnd = at;
    start = at + m[0].length;
  }
  return chunk.slice(0, keptEnd);
}

/** The text with every clause cut at its first governing cue (whether / if / check that …) — what it asserts, not what it asks or offers. */
function ownerTurnUngoverned(text: string): string {
  const pieces = text.split(/(\s*(?:;|—|–|,?\s+(?:and|but|while|whereas)\s+)\s*)/i);
  let out = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const clause = pieces[i];
    const cue = OWNER_TURN_GOVERNING_CUE_RE.exec(clause);
    const kept = cue ? clause.slice(0, cue.index).replace(/[\s,:]+$/, '') : clause;
    if (!kept.trim()) continue;
    out += (out && i > 0 ? pieces[i - 1] : '') + kept;
  }
  return out;
}

/** Exported for tests: the owner-turn claim units of ONE sentence (questions, governed clauses and a disclaimed unit dropped). */
export function ownerTurnClaimUnits(sentence: string): string[] {
  const s = String(sentence ?? '');
  let asserted = '';
  let cursor = 0;
  for (const m of s.matchAll(OWNER_TURN_QUESTION_END_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    asserted += ` ${ownerTurnStatementLead(s.slice(cursor, end))}`;
    cursor = end;
  }
  asserted += ` ${s.slice(cursor)}`;
  const unit = ownerTurnUngoverned(asserted.replace(/\s+/g, ' ').trim()).trim();
  if (unit.length < 12 || PRODUCTION_STATE_DISCLAIMER_RE.test(unit)) return [];
  return [unit];
}

/**
 * Exported for tests: the production-state claim units of a note (exemptions
 * applied). A sentence with no clause-level exemption is one unit; a sentence
 * carrying a disclaimer / history / negation clause yields its OTHER clauses
 * that still assert present production state (each its own unit), so a
 * "(not read this wake)" parenthesis never launders the claim beside it.
 * `ownerTurn` (2026-10-22): each sentence is first reduced by ownerTurnClaimUnits.
 */
export function mineProductionStateSentences(note: string, opts: { ownerTurn?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const raw of sentencesOf(note)) {
    for (const sentence of opts.ownerTurn ? ownerTurnClaimUnits(raw) : [raw]) {
      if (!PRODUCTION_STATE_RE.test(sentence)) continue;
      if (PRODUCTION_STATE_FORWARD_RE.test(sentence)) continue;
      if (!productionStateClauseExempt(sentence)) { out.push(sentence); continue; }
      for (const clause of productionStateClauses(sentence)) {
        if (!PRODUCTION_STATE_RE.test(clause)) continue;
        if (productionStateClauseExempt(clause)) continue;
        out.push(clause);
      }
    }
  }
  return out;
}

/** Exported for tests: the digit-bearing tokens a sentence rests on (clocks stripped; ≤ 8, deduped, lowercased). */
export function productionStateFactTokens(sentence: string): string[] {
  const stripped = String(sentence ?? '').replace(PRODUCTION_STATE_CLOCK_STRIP_RE, ' ');
  const seen = new Set<string>();
  for (const m of stripped.matchAll(PRODUCTION_STATE_FACT_TOKEN_RE)) {
    const tok = m[0].replace(/^[.\/-]+|[.\/-]+$/g, '').toLowerCase();
    if (tok.length >= 1 && !seen.has(tok)) seen.add(tok);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

/** Exported for tests: the subset of a sentence's fact tokens that can ground it (bare 1–2 digit counts excluded). */
export function productionStateGroundableTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !PRODUCTION_STATE_BARE_COUNT_RE.test(t));
}

/** Whole-token match: the token must not sit inside a longer alphanumeric run ("433" is not in "9c4330ab"). */
function productionStateTokenGrounded(token: string, haystack: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i').test(haystack);
}

/** True when this run made at least one evidence-bearing read (a tool_result part or an ok receipt of an evidence tool). */
function runHasEvidenceRead(input: ProductionStateAuditInput): boolean {
  for (const p of Array.isArray(input.parts) ? input.parts : []) {
    if (p && p.type === 'tool_result' && isEvidenceToolName(p.name) && typeof p.result === 'string' && p.result) return true;
  }
  for (const r of Array.isArray(input.receipts) ? input.receipts : []) {
    if (r && r.ok === true && isEvidenceToolName(r.tool)) return true;
  }
  return false;
}

/** A get_chat_messages read of the supervisor's OWN chat: its args name the chat, or its result envelope does. */
function isSelfChatRead(result: string, callArgs: unknown, selfChatId: string | null | undefined): boolean {
  if (!selfChatId) return false;
  const argId = callArgs && typeof callArgs === 'object' ? String((callArgs as any).chatId ?? '') : '';
  if (argId && (argId === selfChatId || (argId.length >= 8 && selfChatId.startsWith(argId)))) return true;
  return result.includes(`"chatId": "${selfChatId}"`) || result.includes(`"chatId":"${selfChatId}"`);
}

/**
 * The grounding haystack: this run's tool_result texts MINUS the surfaces a
 * confabulation is copied from — memory reads (NON_EVIDENCE_TOOLS), the own
 * state doc, and a get_chat_messages read of the note's own chat. Returns
 * the texts and, separately, the platform-observe texts (the onMainHead
 * grounding surface). Exported for tests.
 */
export function productionStateGroundingTexts(input: ProductionStateAuditInput): { texts: string[]; observe: string[] } {
  const texts: string[] = [];
  const observe: string[] = [];
  const lastCallArgs = new Map<string, unknown>();
  for (const p of Array.isArray(input.parts) ? input.parts : []) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' ? p.name : '';
    if (p.type === 'tool_call') { if (name) lastCallArgs.set(name, (p as any).args); continue; }
    if (p.type !== 'tool_result' || typeof p.result !== 'string' || !p.result) continue;
    if (!name || !isEvidenceToolName(name)) continue;
    if (PRODUCTION_STATE_MEMORY_TOOLS.has(name)) continue;
    // A WRITE observes nothing (review 2026-10-23): update_supervisor_state /
    // send_chat_message / todo / connector writes answer with a non-empty
    // envelope that often echoes the model's OWN words back — counting them
    // made a write-only owner turn read as "already read" (no re-run, no
    // line, no row) and let the echo ground the very claim it repeats. Only
    // a write ACK is skipped (recheck 2026-10-23 — never the replay-unsafe
    // set): browser_task / computer_task observe the page / screen and
    // infra_action kind 'env_probe' reads the host, so they ground. The args
    // are the call that precedes this result.
    if (isWriteAckToolName(name, lastCallArgs.get(name))) continue;
    if (name === 'get_chat_messages' && isSelfChatRead(p.result, lastCallArgs.get(name), input.selfChatId)) continue;
    texts.push(p.result);
    if (PLATFORM_OBSERVE_TOOLS.has(name)) observe.push(p.result);
  }
  return { texts, observe };
}

/**
 * True when this run made at least one read that CAN ground a production
 * sentence — the haystack's own discipline (productionStateGroundingTexts):
 * a memory read, the own state doc and a get_chat_messages read of the note's
 * own chat never count. The owner-turn live-state check (2026-10-22,
 * chat-agent.service.ts) re-runs an owner answer only when this is false, so
 * a turn that already read something is never replayed. Fails toward TRUE (a
 * read happened ⇒ no retry) — a matcher error never costs an extra round.
 */
export function productionStateHasGroundingRead(input: ProductionStateAuditInput = {}): boolean {
  try {
    return productionStateGroundingTexts(input).texts.length > 0;
  } catch {
    return true;
  }
}

/**
 * The lane's matcher (exported for tests + the chat-agent seam). Pure over its
 * input — no DB, no LLM. Returns [] under the kill switch and on any failure.
 */
export function findUnreadProductionStateClaims(note: string, input: ProductionStateAuditInput = {}): ProductionStateHit[] {
  try {
    const sentences = mineProductionStateSentences(note, { ownerTurn: input.ownerTurn === true });
    if (!sentences.length) return [];
    const grounding = productionStateGroundingTexts(input);
    const haystackParts: string[] = [...grounding.texts, ...(input.extraEvidenceHaystacks ?? [])];
    for (const r of Array.isArray(input.receipts) ? input.receipts : []) {
      if (!r || r.ok !== true) continue;
      for (const v of Object.values(r.ids ?? {})) if (v != null) haystackParts.push(String(v));
    }
    const haystack = haystackParts.join('\n').toLowerCase();
    const mainHeadRead = grounding.observe.some((t) => /onmainhead/i.test(t));
    const hasRead = runHasEvidenceRead(input);
    const out: ProductionStateHit[] = [];
    for (const sentence of sentences) {
      if (mainHeadRead && PRODUCTION_STATE_MAIN_HEAD_RE.test(sentence)) continue; // the field it asserts was read
      const tokens = productionStateFactTokens(sentence);
      const groundable = productionStateGroundableTokens(tokens);
      if (groundable.length) {
        if (haystack && groundable.some((t) => productionStateTokenGrounded(t, haystack))) continue; // one grounded token exonerates
        out.push({ sentence: sentence.slice(0, 180), factTokens: tokens, reason: 'tokens_unread' });
      } else if (!hasRead) {
        out.push({ sentence: sentence.slice(0, 180), factTokens: tokens, reason: 'no_read_this_run' });
      }
      if (out.length >= PRODUCTION_STATE_MAX_HITS) break;
    }
    return out;
  } catch (err: any) {
    logger.warn(`action-verifier: production-state lane failed open: ${err?.message}`, { source: 'action-verifier' });
    return [];
  }
}

/** What guardMachineWakeFinalAnswer hands its caller (the chat-agent finalize seam). */
export interface ActionGuardResult {
  /** The text to deliver/persist — the replacement on a strike, the input otherwise. */
  finalText: string;
  /** The harness-authored notice alone ('' when not struck) — the seam unshifts it as a leading part so the parts-rendered transcript also leads honest. */
  notice: string;
  struck: boolean;
  phantoms: ExtractedClaim[];
  /**
   * The future-observation-clock hits behind a clock-lane strike (iteration
   * 11, 2026-09-25) — token, minutes ahead, the struck line — so the seam's
   * guard_strike telemetry names WHAT was struck (`clockHits`) and the next
   * operator pass can classify strikes without mining persisted notices.
   * Undefined on pass-through and on action-lane strikes.
   */
  futureClocks?: FutureObservedTimestamp[];
  /**
   * SINGLE-AUDIT contract (ticket fc337153 — the 2026-09-11 02:17Z reopen):
   * TRUE when this guard ran its audit pipeline to a verdict (a clean pass
   * AFTER computePhantomClaims, or any strike); FALSE when it never audited —
   * the non-machine-triggered passthrough, the non-supervisor cheap pre-gates,
   * or the fail-open error return. The chat-agent seam stands the post-
   * delivery verifier down whenever the guard audited: the two lanes share
   * ONE matcher but extract with TWO independent LLM passes, and the guard's
   * reject-back second pass receives extraEvidenceHaystacks the post lane
   * never sees — so a re-audit can ONLY diverge (a delivered-phantom
   * sighting, a P5 reopen, an engineering dispatch: pure coin-flip churn).
   * On audited:false the post-delivery lane still runs as the error backstop.
   */
  audited: boolean;
  /**
   * In-thread correction text (tickets 51ed3a65 / a688ba29) — set on EVERY
   * pre-delivery strike (action-phantom AND future-clock), undefined on
   * pass-through. The seam injects it as a user-role harness message AFTER
   * the replacement row persists, so the next wake sees the SPECIFIC struck
   * claims in-window: the persisted replacement wrapper is swapped for a
   * GENERIC placeholder when stored rows reload as model context
   * (guard-chrome-redact, ticket ac835c00), while user-role harness messages
   * survive redaction by role gate. Without it, a struck run's next wake had
   * no specifics and re-confabulated — five strikes in one night on the
   * action lane (51ed3a65), then the SAME hole on the clock lane: five
   * sightings / two auto-reopens on chat c0e22e36 (a688ba29) — projected
   * headline clocks, a "fired"-before-fire-time claim, and unlabeled forward
   * references the model could not know were the strike cause.
   */
  correction?: string;
  /**
   * Model-context notice for the reject-back re-orchestration (fleet-integrity
   * cluster ba65163d / aac649ba): set on a strike ONLY when the caller passed
   * deferConsequences:true. CHROME RULE (dc04deea, ticket ac835c00): this text
   * enters the MODEL's context — it never carries the harness-only conviction
   * chrome (the ACTION_GUARD banners), or it teaches the layer the format it
   * convicts.
   */
  rejectBackNotice?: string;
  /**
   * (Fleet 17:14Z incident, 2026-09-15) Under consequenceScope 'citation-only',
   * the ACTION-class convictions of a MIXED strike that were NOT enforced —
   * delivered unmodified; the seam records them as 'observed'. Absent when the
   * verdict was homogeneous.
   */
  observedPhantoms?: ExtractedClaim[];
  /**
   * (audit 2026-10-08 W1-4) 'annotated' when the strike delivered the note AS WRITTEN with a
   * trailing observe-only annotation (`notice` is that annotation — the seam appends it as the
   * LAST part, never the first). Absent on a strip+mark / replacement delivery.
   */
  delivery?: 'annotated';
  /**
   * build 2026-10-08 Q-3: the clock lane's verdict on this note (present whenever the future-clock
   * detector had ≥1 hit) — every hit with why it did / did not convict. The seam records it as one
   * `future_clock_verdict` loop_metrics row per guard pass.
   */
  clockVerdict?: FutureClockVerdict;
}

/** Kill switch: OWNER_NOTE_NO_EDIT_DISABLED=1 restores strip+mark / full replacement of a struck note. */
export function ownerNoteNoEditDisabled(): boolean {
  return process.env.OWNER_NOTE_NO_EDIT_DISABLED === '1';
}

/**
 * First line of the observe-only annotation (audit 2026-10-08 W1-4). guard-chrome-redact lists it
 * among the trailing note headers, so a later wake reloading this row never sees the annotation
 * (the in-thread correction row carries the specifics to the model instead).
 */
export const ACTION_GUARD_ANNOTATION_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';

/** The trailing annotation an un-edited struck note carries: one paragraph, no blank lines. Pure; exported for tests. */
export function renderObserveOnlyAnnotation(
  phantoms: ExtractedClaim[],
  cls: { citationOnly: boolean; boardStatusOnly: boolean; miscopyOnly: boolean; misattributedOnly?: boolean },
  harnessStripped?: { block?: boolean; copies?: boolean } | null,
): string {
  // The supervisor harness may have removed the note's own ACTIONS TAKEN list / copies of its lines
  // before this pass (review fix 2026-10-20): then the annotation says so, never "nothing above was removed".
  const stripped = harnessStrippedWording(harnessStripped);
  const what = cls.boardStatusOnly
    ? 'board status(es) that disagree with the ledger'
    : cls.miscopyOnly
    ? 'id(s) that do not match the tool result they were copied from'
    : cls.misattributedOnly
    ? 'ticket filing(s) this run did not perform — the cited tickets exist, but the filings were another session\'s and/or predate this run'
    : cls.citationOnly
    ? 'id(s) the integrity check could not find'
    : 'action(s) with no matching tool call in this run';
  return [
    ACTION_GUARD_ANNOTATION_HEADER,
    `${stripped ? stripped.delivered : 'This note was delivered as written.'} The integrity check could not verify ${phantoms.length} claim(s) in it — ${what}:`,
    claimDetailLines(phantoms.slice(0, 6)),
    `Treat those lines as unverified until a fresh tool result confirms them; ${stripped ? stripped.rest : 'nothing above was removed or changed'}.`,
  ].join('\n');
}

/**
 * Deterministic future-observation-clock detector (ticket 375c8618, 2026-08-27).
 * Deploy/restart-interrupted machine runs keep posting final answers that cite
 * "observed" clocks LATER than the run's real clock (the Re-Send lane claimed
 * observations through "15:03:42Z" while its tool-printed clock read 14:24:28Z)
 * — an observation of the future is impossible, so the note is fabricated. The
 * LLM claim matcher can't catch this class (nothing it extracts is an action
 * claim); this check is pure arithmetic on tz-suffixed clock tokens.
 *
 * Rules:
 *  - Only tz-SUFFIXED tokens count ("15:03:42Z", "2:26:59 PM PDT") — a bare
 *    "12:30" could be a duration or a version, never a conviction.
 *  - Each token resolves to the candidate (today's or yesterday's UTC date)
 *    NEAREST to now. "23:45Z" cited at 00:30Z is last night's probe (past);
 *    "15:03Z" cited at 14:24Z is 39 min in the future (impossible). No
 *    midnight-boundary false positives.
 *  - DST pairs (PDT/PST, EDT/EST, …) resolve under BOTH offsets and the
 *    most-favorable reading wins — a season-mislabeled real observation
 *    ("6:30 AM PST" in August) is not a conviction (review F2).
 *  - Convict only when that nearest candidate is > now + 90s skew (ticket
 *    80dd882d evaluated ±15 min and kept 90s: the incident replay gate pins
 *    small-ahead phantoms — a8976e11 +6m38s, #307 +13m33s — as real evasion
 *    classes; over-fire relief comes from the quoted-void exemption + the
 *    precision guards above — a convicted clock now REPLACES the note pre-
 *    delivery, ticket cdd3fbfe) AND the
 *    token's LINE carries no future-intent keyword ("next fire 22:00Z",
 *    schedules, ETAs, expiries are legitimate forward references) AND no
 *    past-reference wording ("last night's probe", "yesterday" — citations
 *    of EARLIER observations, exempt per review F2) AND cites no schedule
 *    artifact by id ("[sched:…]" ledger lines — the clock is the schedule's
 *    fire time, forward-looking by construction; ticket 65239c9a) AND the
 *    stamp has no TOOL-OUTPUT PROVENANCE (opts.evidenceHaystacks — ticket
 *    a688ba29: the run's own tool_result texts carry the same clock reading,
 *    so the stamp is quoted forward data — a schedule nextRunAt, a receipt
 *    instant — not an invented observation; stamp-specific, so a co-line
 *    phantom with no provenance still convicts).
 *  - Residual ambiguity (accepted, re-review #2): a BARE future-looking
 *    citation with no past-reference wording ("Probe at 22:00Z found
 *    nothing." cited the next afternoon) still convicts — the nearest-
 *    candidate rule cannot tell "tonight 22:00Z" from "last night 22:00Z",
 *    and preferring the past reading would gut the Re-Send conviction.
 *    Notes citing older probes should say so ("last night's …").
 *  - Known miss (documented, accepted): ISO-embedded timestamps
 *    ("2026-08-27T15:03:42Z") carry their own date and never match — real
 *    tool-output quotes cannot hold a future clock anyway.
 */
// 90s — deliberately NOT widened to the ±15 min ticket 80dd882d suggested:
// the incident replay gate pins small-ahead phantoms as a real evasion class
// (a8976e11 +6m38s probe, #307 +13m33s merge stamp); a 15-min bar makes those
// fabrications invisible. Over-fire relief comes from the detector's own
// precision guards (nearest-candidate resolution, DST-pair favorability,
// future-intent/past-reference line exemptions, the quoted-void exemption);
// a CONVICTED clock is past every grace and now replaces pre-delivery
// (ticket cdd3fbfe — the warn-inline lane this comment used to cite kept
// delivering impossible observation clocks; superseded).
const FUTURE_TS_TOLERANCE_MS = 90_000;

/**
 * Offset candidates BEHIND UTC (minutes) per tz label. DST pairs list BOTH
 * offsets (PDT/PST → [7h, 8h]): a note that mislabels the season ("6:30 AM
 * PST" in August) resolves under the pair's other member too, and the
 * conviction uses the resolution MOST FAVORABLE to the note (review F2 —
 * fixed-offset resolution false-struck DST-mislabeled real observations).
 */
const TZ_BEHIND_UTC_MIN: Record<string, number[]> = {
  Z: [0], UTC: [0],
  EDT: [4 * 60, 5 * 60], EST: [4 * 60, 5 * 60],
  CDT: [5 * 60, 6 * 60], CST: [5 * 60, 6 * 60],
  MDT: [6 * 60, 7 * 60], MST: [6 * 60, 7 * 60],
  PDT: [7 * 60, 8 * 60], PST: [7 * 60, 8 * 60],
};

// Rollout watch tick 10 (2026-09-15 01:14Z, crossmodel supervisor daee2916):
// the honest wake-line stamp "Wake 2026-09-15T01:10:53Z" was STRUCK — this
// regex matched its MM:SSZ tail ("10:53Z", \b after the colon) and read it as
// a 10:53 clock, 579 min in the future. A token preceded by a digit or a
// colon is the tail of a longer stamp, never a clock of its own; full ISO
// stamps get their own lane (ISO_STAMP_RE) and are evaluated with their date.
const CLOCK_TOKEN_RE = /(?<![\d:])\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(?:(a|p)\.?m\.?)?\s*(Z|UTC|[EPMC][DS]T)\b/gi;
const ISO_STAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?Z\b/g;

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Explicit calendar dates ON a line PIN an ADJACENT clock token's day
 * (ticket c7c90f40). "unsent since Aug-27 17:01Z" run at 08:43Z the next
 * morning resolved to TODAY 17:01Z under the nearest-candidate rule (498 min
 * "ahead") — a fabricated-future conviction of a truthful past citation.
 * Guards, each bought by an adversarial-review finding (PR-B review F1–F3):
 *   - BOUNDED, CAPITALIZED month forms (Jan|January|…|Sep|Sept|September):
 *     an open `[a-z]*` matched month-PREFIXED WORDS ("separate 3", "augment
 *     30", "mayor 3") and a case-insensitive `may` matched the modal verb
 *     ("we may 3 retries") — false pins that could resolve FUTURE and strike
 *     truthful lines. Capitalized English date forms only ("Aug-27"); a
 *     lowercase "may 30" (modal) or "aug 27" never pins — under-pinning is
 *     the fail-safe direction.
 *   - ADJACENCY: a pin governs a token only across a short connector gap
 *     (DATE_TIME_GAP_RE) — a date modifying another noun ("the Sept 1/3
 *     date-correction draft … probe ran 22:00Z") must not govern the probe's
 *     clock. The LAST adjacent pin governs; a later pin supersedes.
 *   - EXONERATION-ONLY (round-2 review): a pin is tried ALONGSIDE the
 *     today/yesterday proximity candidate and the most-favorable (smallest
 *     ahead-ms) wins — a pin can clear a proximity false-positive (the
 *     incident class) but can NEVER create a conviction the base rule
 *     wouldn't make (a forward reference like "Owner call Sept 1 22:00Z"
 *     stays exactly as clean as base; a future-dated phantom still convicts
 *     via proximity whenever its time-of-day is ahead of now).
 *   - VALIDITY: a roundtrip check rejects rolled days (2026-02-31 → Mar-3).
 * The year of a year-less month-name date resolves to the nearer of
 * THIS/LAST year (round-3 review N1: nextYear is never tried — a January
 * date cited in late December pins ~a year past, clearing a base false-
 * positive on truthful forward references while leaving a narrow, documented
 * escape for days-ahead date-citing phantoms; under-broad is fail-safe).
 * Residual (accepted, identical to base): NON-ADJACENT phrasings fall back to
 * the proximity rule. (Postposed dates — "17:01Z on Aug-27", "10:23:17Z
 * Aug-29" — were part of this residual until the 2026-08-30 prod strike
 * 9ed1bf8e; they now pin via TRAILING_DATE_GAP_RE.)
 */
const MONTH_NAME_SRC = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const LINE_DATE_RE = new RegExp(
  `\\b(?:(\\d{4})-(\\d{2})-(\\d{2})|${MONTH_NAME_SRC}[\\s-](\\d{1,2})(?:st|nd|rd|th)?\\b|(\\d{1,2})(?:st|nd|rd|th)?[\\s-]${MONTH_NAME_SRC}\\b)`,
  'g',
);

/**
 * Bare MM-DD numeric dates as date pins (ticket 958311f1, 2026-09-30): a
 * truthful machine note cited "premises unchanged since 09-29 02:22Z" — the
 * calendar-date shorthand the fleet's state cards use constantly. LINE_DATE_RE
 * carries only ISO yyyy-mm-dd + month-name forms, so "09-29" was NOT a date
 * pin; the clock check fell to the today/yesterday proximity rule, resolved
 * "02:22Z" to TODAY 02:22Z (127 min "ahead" at a real 00:15Z run) and struck
 * the note as a fabricated-future observation though the date was printed
 * beside the time. Guards, matching the month-name pin contract exactly:
 *   - EXONERATION-ONLY + ADJACENCY: the pin joins the same most-favorable
 *     candidate set under DATE_TIME_GAP_RE / TRAILING_DATE_GAP_RE, so it can
 *     clear a proximity false-positive but can NEVER create a conviction the
 *     base rule wouldn't make — a FUTURE MM-DD ("since 10-01 02:22Z") pins
 *     MORE ahead than proximity and the proximity candidate still convicts.
 *   - SEPARATE REGEX, never folded into LINE_DATE_RE: a whole-line date
 *     exemption (the PAST_REFERENCE_RE class at the clock check, ~line 4786)
 *     skips a line that already reads as dated; an MM-DD folded into that
 *     whole-line machinery would launder an unrelated same-line future clock
 *     ("logged 2026-09-29; will verify 23:59Z"). A dedicated regex keeps MM-DD
 *     strictly inside the per-token adjacency machinery, never a line-level
 *     exemption.
 *   - VALIDITY via utcDayMs roundtrip (rejects 2026-02-31-class rollovers);
 *     the year resolves to the nearer of THIS/LAST year exactly like the
 *     month-name branch (never nextYear — under-pinning is the fail-safe
 *     direction).
 * Residual (accepted, identical in kind to the month-name pins): a plausible
 * past MM-DD citing a fabricated observation is out of THIS lane's mandate —
 * the clock check convicts impossible FUTURE times only.
 */
const MM_DD_DATE_RE = /\b(\d{1,2})-(\d{1,2})\b/g;

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Day-of-WEEK names as date pins (ticket 65239c9a sighting 2, 2026-09-02):
 * the supervisor's truthful "Polished draft delivered 19:25Z Tuesday (msg
 * fee3342b)" — written Wed 14:10Z, meaning the PREVIOUS day — resolved under
 * the no-pin proximity rule to TODAY 19:25Z (+314 min "ahead") and the note
 * was struck wholesale though it carried an explicit day reference (the lane
 * had even rewritten it to carry dates after the first correction — rule-8
 * compliance could not save it). A clock token governed by an ADJACENT day
 * name is never an impossible-observation claim under EITHER natural
 * reading: past-tense + bare day name = the most recent such day (English
 * convention), and a future-plan reading is a forward reference (the
 * FUTURE_INTENT_RE whitelist's job, not this lane's). Contract follows the
 * month-name pin idioms, bought by the same review findings:
 *   - CAPITALIZED forms only (Mon|Monday|Tue|Tues|Tuesday|…): a lowercase
 *     "tuesday" never pins — under-pinning is the fail-safe direction
 *     (month-name parity: "may 30" the modal must not pin either).
 *   - MOST RECENT occurrence ≤ now's UTC day — never a FUTURE day: a pin may
 *     only LOWER a token's ahead-ms (the exoneration-only invariant), and
 *     resolving forward would both blur that invariant and misread the
 *     past-tense register these pins serve ("delivered Tuesday").
 *   - ADJACENCY + EXONERATION-ONLY inherited unchanged: the pin joins the
 *     same candidate set as explicit dates (leading/trailing connector gap,
 *     most-favorable wins), so it can clear a proximity false-positive but
 *     NEVER create a conviction the base rule wouldn't make. A same-day name
 *     pins to today (identical to the proximity candidate — no shield for a
 *     same-day future clock), and a day name modifying another noun fails
 *     the connector-gap test exactly like a date would ("Tuesday's deploy
 *     shipped; final tally logged 22:45Z" still convicts 22:45Z).
 * Residual (accepted, identical in kind to the standing PAST_REFERENCE_RE
 * line exemption): a fabricated observation naming a PLAUSIBLE past day
 * ("verified Friday" when nothing was verified) is out of THIS lane's
 * mandate by design — the clock check convicts impossible FUTURE times only;
 * plausible-past fabrications belong to the citation/receipt lanes.
 */
const DAY_NAME_RE = /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/g;

/** The gap between a date pin and the clock token it may govern: short, digit-free, connector words only. */
const DATE_TIME_GAP_RE = /^[\s,;:()~-]{1,4}(?:(?:at|around|about|approx|by)\s{1,2})?$/i;

/**
 * The gap between a clock token and a TRAILING (postposed) date pin
 * (ticket 9ed1bf8e): "10:23:17Z Aug-29", "17:01Z on Aug-27". Dates FOLLOW
 * clocks with "on" (never "at/around/about/by" — those introduce times), so
 * the trailing connector vocabulary is the leading one minus the time words,
 * plus "on". Same bounded, digit-free adjacency rule.
 */
const TRAILING_DATE_GAP_RE = /^[\s,;:()~-]{1,4}(?:on\s{1,2})?$/i;

/**
 * "since <clock>" is only coherent BACKWARD-pointing ("silent since 17:01Z",
 * "since Wed 14:02Z" — ticket c7c90f40): the proximity rule mis-resolves
 * those as future on every early-UTC morning. Per-TOKEN (not whole-line — PR-
 * B review F4): the exemption covers only the token "since" directly
 * governs, so a co-line fabrication ("silent since 17:01Z; verified at
 * 15:03:42Z") still convicts. Accepted residual (same class as the line-level
 * earlier/previous/prior words): a phantom adopting "verified since <future>"
 * phrasing escapes — under-broad is the fail-safe direction for a fabrication
 * detector. Up to two short words may intervene ("since early Wed").
 */
const SINCE_TOKEN_RE = /\bsince(?:\s+[a-z~]{1,12}){0,2}\s*$/i;

/**
 * Conditional-CLAUSE exemption (ticket b84db359) — chat-lane port of the
 * coding lane's c0f5a799 fix (run-evidence-guard.ts, PR #448): a stamp whose
 * own clause is explicitly hypothetical is a THRESHOLD the run set for the
 * future, not an observation it claims to have made. Real incident (chat
 * c0e22e36, fleet supervisor, real clock 07:23:06Z): "If silent past ~08:00Z
 * I'll treat it as wedged and pull" — a self-imposed future deadline inside
 * an if-clause — struck as a fabricated observation (+37m) and the honest
 * sweep note was replaced. The line-level FUTURE_INTENT_RE can't catch this
 * shape (no intent word: "I'll" is not "will"), and the intent words FOLLOW
 * the stamp — the same gap the coding lane documented.
 *
 * Scoped per stamp and CLAUSE-BOUNDED (the coding lane's M2 anti-smuggle
 * constraint, same regex semantics): the conditional word must sit between
 * the stamp and the nearest preceding clause boundary (; . , : ! ?) with NO
 * boundary in between — a fabricated "verified the merge at <future>; if the
 * probe confirms…" never inherits an "if" from a neighbouring clause. A
 * future-dated stamp governed by if/when/whenever/once/unless is
 * definitionally hypothetical: no reader takes "if silent past ~08:00Z" as a
 * claim that 08:00Z already happened. Reach is 96 chars (coding-lane parity:
 * its incident clause spanned 52).
 */
const CONDITIONAL_BEFORE_STAMP_RE = /\b(?:if|when|whenever|once|unless)\b[^\n;.,:!?]{0,96}$/i;

/**
 * Estimate/deadline-governed stamp (operator iteration 11, 2026-09-25). Two
 * Fleet Supervisor strikes in 48 h were honest forward ESTIMATES in a sweep
 * table's ETA column: 2026-09-25 01:11Z "- ~6:20 PM PDT — tt-rd speed verdict
 * (automatic)" (+9 min, retry still_dirty — the honest note was replaced) and
 * 2026-09-23 18:02Z "| Verdict by ~11:45 AM PDT (18:45Z) |" (+43 min). Neither
 * line carried a FUTURE_INTENT_RE word, so the clock lane read them as
 * observations. An approximation mark ("~", "≈") or a deadline/estimate
 * preposition (by, before, around, about, roughly, circa, toward(s), no later
 * than) DIRECTLY governing the clock is a forward estimate by construction —
 * nobody observes the world at an approximate time — so the token is exempt.
 * Bounds (anti-smuggle, the standing constraints of this lane):
 *   - per-TOKEN: only the governed token clears; a co-line bare future clock
 *     still convicts;
 *   - a completed-work verb earlier on the line keeps convicting ("merged by
 *     ~18:45Z", "verified at ~15:03Z"), and the bare "at ~<clock>" frame
 *     ("at ~6:20 PM PDT I saw …") is NOT an estimate frame — only a
 *     deadline preposition or a lone approximation mark exempts;
 *   - the exemption covers ONLY the impossible-observation tell — every
 *     claim on the line still faces the action/citation lanes;
 *   - a same-instant ZONE GLOSS right after an exempted estimate ("~11:45 AM
 *     PDT (18:45Z)") inherits the exemption under the coding lane's
 *     inheritsExemptGloss rule (gap ≤ 24 chars holding an unclosed "(").
 * Shipped VERBATIM in both lanes (this file + coding/run-evidence-guard.ts —
 * the keep-in-sync discipline). Reject-back retries cost the supervisor ≈4 min
 * each (28 clean retries in the 24 h before this shipped); the guard_strike
 * meta now also carries `clockHits` so the next operator pass can measure the
 * remaining strike classes instead of inferring them from persisted notices.
 */
const ESTIMATE_BEFORE_STAMP_RE = /(?:\b(?:by|before|around|about|roughly|circa|towards?|no later than|nlt|eta)\s+[~≈]?\s*|\b(?:paid|booked|reserved|covered|funded|prepaid|locked|held)\s+thr(?:ough|u)\s+[~≈]?\s*|(?<!\bat\s{0,3})\b(?:block|reservation|lease|coverage|hold|budget|quota|grant|contract|subscription|trial|blackout|cooldown|moratorium)s?\s+ends?(?:\s*date)?\s+(?:at\s+)?[~≈]?\s*|(?<!\bat\s{0,3})[~≈]\s*)$/i;
// Ticket 0e7684e0 (mishap, 2026-09-27 — prod strike 2da8766f 03:42:28Z, token
// "2026-10-03T11:30Z" +9108 min, ENFORCED reject-back REPLACED an honest note):
// a SPAN-BOUNDARY NOUN + "end(s)" — "monitor waits for CanLaw SFT-2 launch or
// block end 2026-10-03T11:30Z" — names the reservation's END BOUNDARY in NOUN
// form: the same reservationEndsAt instant iteration 20 cleared in VERB form
// ("capacity block paid through 2026-10-03T11:30Z"), with no future-intent
// word anywhere on the line. "end" is deliberately NOT a line-level
// FUTURE_INTENT_RE word (too common — it would exempt whole lines); the
// governor is the SPAN-NOUN + "end" PAIR, ADJACENCY-ONLY: the noun sits
// immediately before "end", "end" immediately before the stamp (optional
// "at" between), so the iter20 BOUND pin ("paid through the end of the
// quarter <stamp>" — "the" is not a span noun and "of the quarter"
// intervenes) and the i12 ANTI-SMUGGLE pin ("the block end handoff 11:30Z" —
// "handoff" intervenes) keep convicting, and a span noun ALONE is not a
// governor ("the capacity block <stamp>" convicts). No span noun is a
// completed-work verb, so the near-backstop never convicts the honest shape;
// "verified the block end <stamp>" still convicts (verb ~23 chars back, no
// clause break). Estimate exemption unconditional since 2026-11-02.
// VERBATIM twin in coding/run-evidence-guard.ts.
// Iteration 21 (FO firing 31, 2026-09-27 — UNION with the 0e7684e0 governor
// above, which landed mid-firing as 0c28eb77d/PR #1095 and was authored from
// the SAME prod strike 2da8766f 03:42:28.587Z): the FO lane's independent
// source-verification of the same incident pulled the chat's own registered
// premise (goal acc90864): "PURCHASED cbe-067018e84ab483a59
// payment-succeeded 19:40:55Z, block end 2026-10-03T11:30Z (value 13953.41
// unchanged, no drift)" — hard source evidence for the reservationEndsAt
// class — and found TWO shapes the 0e7684e0 arm misses, now folded into this
// union regex: (a) the INFORMAL span spelling "block paid thru
// 2026-10-03T11:30Z" (seen verbatim in that chat's state rows) — the
// span-subject pair accepts thr(ough|u); (b) "reservation end date <ISO>"
// (the premise row's own wording) — "end" accepts an optional "date"
// compound. Both keep the "at" lookbehind BEFORE the noun (stricter than the
// landed arm, which only looked back at the tilde arm): "idles at block end
// <ISO>" still convicts on the noun arm. Kill switch unchanged:
// Est. exemption unconditional since 2026-11-02. VERBATIM twin in
// coding/run-evidence-guard.ts.
// Iteration 20 (FO firing 29, 2026-09-26 — prod strike c0e22e36 18:44:21Z, token
// "2026-10-03T11:30Z" +9647 min, ENFORCED reject-back stripped the ISO token
// from an honest note): a SPAN SUBJECT + "through" — "capacity block PAID
// through 2026-10-03T11:30Z" — states a PRESENT fact: the paid window's end
// boundary (the reservationEndsAt concept), like "valid until". Bare "through"
// is NOT a governor: "Observations through 15:03:42Z" claims perception
// coverage through a future instant — the original 375c8618 fabrication class
// (the base-suite pins keep convicting it). Governor = the span-subject pair
// only (paid/booked/reserved/covered/funded/prepaid/locked/held + through),
// ADJACENCY-ONLY: at phrase distance it false-exempts across table-cell pipes
// (the iter13 pin "paid through tomorrow | capacity decision 12:08Z"), and no
// span verb is a completed-work verb, so the near-backstop never convicts the
// honest shape. Estimate exemption unconditional since 2026-11-02.
// VERBATIM twin in coding/run-evidence-guard.ts.
// Iteration 12 (FO firing 24, 2026-09-25 — prod strike 2da8766f 07:05:24.501Z,
// token "11:30Z" +267 min): a deadline governor may sit at DISTANCE behind a
// bounded noun phrase + date — "hand both p5s before block end Sep 26 11:30Z"
// convicted because the adjacency-only window sliced mid-word ("…efore block
// e"). The governor-to-clock span may hold phrase material (≤60 chars, no
// clause boundary newline/;/:/.) but must NOT end in the bare "at" observation
// frame, and the completed-work backstop on the FULL prefix still convicts
// ("merged … before 18:45Z"). Estimate exemption unconditional since 2026-11-02.
// Iteration 14 (FO firing 22, 2026-09-25): "eta" joined the vocabulary — the
// prod strike's line was "TRAIN_DONE envelope **ETA ~19:00–19:40Z**", the
// fleet's canonical estimate noun (the doctrine itself lists "ETA ~…"), yet
// the marker list only knew prepositions. Same kill switch, same backstops.
const ESTIMATE_BEFORE_PHRASE_RE = /\b(?:by|before|around|about|roughly|circa|towards?|no later than|nlt|eta)\b[^\n;:.]{0,60}(?<!\bat\s{0,3})[~≈]?\s*$/i;
// Iteration 20 bound: "through" is ADJACENCY-ONLY (ESTIMATE_BEFORE_STAMP_RE).
// At phrase distance it FALSE-EXEMPTS: the iter13 pin line "| GPU block
// verified alive, paid through tomorrow | capacity decision 12:08Z |" — the
// 60-char phrase window crosses the table-cell pipe and lets "paid through
// TOMORROW" govern the NEXT cell's bare clock. Dedicated temporal connectives
// (by/before/nlt/eta) are safe at distance; "through" is a common preposition
// and stays adjacent-only.
const ESTIMATE_COMPLETED_WORK_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b/i;
// Iteration 14 range-END inheritance helpers: the separator immediately before
// the end token (en/em dash, hyphen, or "to"), and the range-START token it
// skips back over (a bare clock "19:00" or a bare number — a ZONED start
// "18:00Z" does NOT match, so an unmarked range with zoned ends never
// inherits; the start must itself be estimate-governed).
const RANGE_SEP_BEFORE_RE = /(?:[–—-]|\bto\b)\s*$/i;
// Iteration 16 (FO firing 27, 2026-09-26): a MERIDIEM range start
// ("~11:35 AM–12:05 PM PDT") ends in AM/PM, not digits — the digit-anchored
// token never matched, so the honest range end struck (prod strike c0e22e36
// 12:14:16Z, token "12:05 PM PDT"). The start may now end in an optional
// meridiem; the exemption still requires the start to be estimate-governed
// (exemptAt below), so an unmarked meridiem range still convicts. VERBATIM
// twin in coding/run-evidence-guard.ts.
const RANGE_START_TOKEN_RE = /(?:\d{1,2}:\d{2}|\d{1,4})(?:\s*[AaPp]\.?[Mm]\.?)?\s*$/;
/**
 * Iteration 15 (FO firing 23, 2026-09-25): the completed-work backstop's
 * REACH. A listed verb GOVERNS a stamp only within the SAME clause, ≤24 chars
 * before it (the SCHED_COMPLETED_WORK_GOVERNS_RE discipline). Dashes are
 * ALLOWED in the gap so "merged by ~18:00–19:00Z" still convicts; clause
 * breaks (; : . |) sever governance. The pre-15 LINE-scoped test convicted
 * honest estimates whose EARLIER, unrelated clauses carried receipt-backed
 * completed-work verbs (prod strike f5c2c1f4 20:50:06Z, ENFORCED note replaced).
 */
const ESTIMATE_COMPLETED_WORK_NEAR_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[^\n;.|,]{0,40}$/i;
// Iteration 16 (FO firing 27, 2026-09-26 — prod strikes c0e22e36 10:52:41Z,
// 11:18:46Z and 12:14:16Z, all honest CanLaw digest rows, 0 phantom claims,
// ENFORCED lane replaced each note; lineage-verified on i15-containing code):
// a STATUS PREDICATE fused DIRECTLY to its own estimate marker is a forecast
// LABEL — "Training done ~8:30–9:00 AM PDT" / "Done ~9:35–10:05 AM PDT". The
// i15 same-clause backstop convicted them because no clause severance sits
// between "done" and the tilde, yet the verb there is the forecast's SUBJECT
// ("done ≈ when"), not an observation tell. Observation frames carry a
// CONNECTOR between verb and marker ("merged BY ~", "verified THROUGH ~") —
// that connector is what the label test refuses to mask, so the pinned
// smuggles still convict. Kill switch unchanged
// (the exemption path is unconditional since 2026-11-02).
const ESTIMATE_ATTACHED_PREDICATE_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[ \t]{1,2}[~≈]/i;
const ESTIMATE_GLOSS_TOLERANCE_MS = 60_000;
// Iteration 13 (FO firing 25, 2026-09-25): a future clock that PARAPHRASES a
// real schedule's next firing time — "morning nudge 7:31 AM PDT" (canlegal-
// bench nextRunAt 14:31:29Z), "the 5:08 AM PDT capacity check" (the inference
// CHAIN-DECISION schedule's 12:08:42Z firing), "next tick 11:30Z" — struck as
// an impossible observation because the line carries no future-intent word
// (prod strikes f5c2c1f4 10:26:33Z and c0e22e36 10:46:17Z + 10:53:13Z, ALL
// post-iteration-12). A token whose instant matches an ENABLED
// coding_schedules.nextRunAt within ±60s carries deterministic provenance
// (existence arithmetic — the doctrine's false-positive-safe class): a
// fabricated clock does not land within a minute of a real armed firing.
// Per-TOKEN (a co-line phantom clock with no matching firing still
// convicts), and the completed-work backstop on the FULL prefix still
// convicts ("merged at 7:31 AM PDT"). The instant set is fetched by the
// caller (guardMachineWakeFinalAnswer) — enabled schedules only, bounded
// window; a lookup failure leaves the exemption OFF (a DB hiccup strikes
// honestly and the reject-back retry re-checks — it can never launder a
// phantom). Keep VERBATIM in sync with coding/run-evidence-guard.ts (the
// two-lane discipline). Exemption unconditional since 2026-11-02.
const SCHEDULE_FIRING_MATCH_MS = 60_000;
// Iteration 13b (FO firing 25, supervisor steer 12:19Z — the "After <EVENT>:"
// forward-plan shape, struck twice: 2da8766f 07:05:24Z and f5c2c1f4
// 10:26:33Z): a line LEADING with "After <event>:" describes what happens
// AFTER a named event — a forward plan, never an observation. Line-leading
// only (after optional list/quote decoration); the event label is ≤48 chars
// with no clause boundary (newline/;/:/.) inside; ANTI-SMUGGLE: a
// completed-work verb anywhere on the line still convicts ("After the audit:
// verified 15:03Z") — the same full-line bound the steer prescribed for
// estimateGovernedStamp. "After TRAIN_DONE:" survives the backstop: \bdone\b
// does not match inside TRAIN_DONE (underscore is a word char). VERBATIM twin
// in coding/run-evidence-guard.ts.
const AFTER_EVENT_CUE_RE = /^(?:> ?|[-*+] |\d{1,9}[.)] )*after\s+[^;\n]{2,48}:\s/i;
function afterEventCueLine(line: string): boolean {
  if (!AFTER_EVENT_CUE_RE.test(line)) return false;
  return !ESTIMATE_COMPLETED_WORK_RE.test(line);
}
// Connector-governed completed-work tell (the coding lane's
// COMPLETED_WORK_BEFORE_STAMP_RE discipline): verb → ≤24 chars → an
// at/during/in/@ connector immediately before the clock. Blocks "merged at
// 7:31 AM PDT" while a verb governing a DIFFERENT clock nearby ("not landed
// @08:07Z, drain triggers ~12:08Z") cannot block a proven firing time.
const SCHED_COMPLETED_WORK_GOVERNS_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[^\n;:.]{0,24}(?:\b(?:at|during|in|into|within)\s+|@\s*)(?:(?:the|this|that|a|an)\s+)?~?\s*$/i;
export function schedFiringGovernedStamp(line: string, idx: number, instantMs: number, schedTimes: number[]): boolean {
  if (!schedTimes.length) return false;
  if (!schedTimes.some((s) => Math.abs(instantMs - s) <= SCHEDULE_FIRING_MATCH_MS)) return false;
  // Completed-work backstop, CONNECTOR-GOVERNED (unlike the estimate lane's
  // full-prefix backstop): the ±60s instant-match against an ENABLED schedule
  // already proves the clock is a real armed firing time, so only a verb
  // DIRECTLY governing the clock through an at/@ connector refuses. A distant
  // narrative verb ("…corrections landed, … drain trigger armed on the SFT-2
  // launch announcement … 12:08Z" — the f5c2c1f4 strike) cannot block a
  // proven firing time; its own claim still faces the action/citation lanes.
  return !SCHED_COMPLETED_WORK_GOVERNS_RE.test(line.slice(Math.max(0, idx - 64), idx));
}
export function estimateGovernedStamp(line: string, idx: number): boolean {
  const exemptAt = (end: number) =>
    ESTIMATE_BEFORE_STAMP_RE.test(line.slice(Math.max(0, end - 24), end)) ||
    // Iteration 12: the deadline governor at distance (governing a noun phrase
    // + date before the clock). Same completed-work backstop below.
    ESTIMATE_BEFORE_PHRASE_RE.test(line.slice(Math.max(0, end - 64), end));
  // Iteration 15 (FO firing 23, 2026-09-25 — prod strike f5c2c1f4 20:50:06Z,
  // token "22:10Z" +83 min, ENFORCED reject-back REPLACED an honest note):
  // the backstop was LINE-scoped — "report-up sent … capacity landed …
  // TRAIN_DONE re-anchored ≈21:55–22:10Z" struck the honest range END because
  // "sent"/"landed" sat in unrelated, receipt-backed clauses 60+ chars away.
  // A verb now governs only within the SAME clause, ≤24 chars before the
  // stamp (verbGovernStamp). Anti-smuggle intact: "merged by ~18:00–19:00Z"
  // (verb 11 chars before the end token) still convicts; per-TOKEN; kill
  // switch above unchanged.
  // Iteration 16 (FO firing 27, 2026-09-26): the backstop is masked ONLY for
  // the fused forecast-label subject ("Training done ~8:30–9:00 AM PDT") —
  // anywhere else on the line, a same-clause verb still convicts.
  const labelSubject = ESTIMATE_ATTACHED_PREDICATE_RE.test(line);
  const verbGovernStamp = (end: number) =>
    ESTIMATE_COMPLETED_WORK_NEAR_RE.test(line.slice(Math.max(0, end - 56), end)) && !labelSubject;
  if (exemptAt(idx)) return !verbGovernStamp(idx);
  // Iteration 14 (FO firing 22, 2026-09-25 — prod strike 2da8766f 18:14:53Z,
  // token "19:40Z" +85 min, ENFORCED lane, honest note replaced pre-delivery):
  // a RANGE-END token inherits the range start's estimate marker. In
  // "ETA ~19:00–19:40Z" the marker governs the WHOLE envelope, but the end
  // token's 24-char window ends in the dash and the colons inside "19:00"
  // block the iteration-12 phrase reach, so the honest end was struck. When a
  // range separator immediately precedes the token, skip back over the
  // separator + the range-start token and apply the same adjacency/phrase
  // checks there. Bounds unchanged: per-TOKEN, kill switch above, and the
  // completed-work backstop on the FULL prefix still convicts
  // ("merged by ~18:00–19:00Z"); an UNMARKED range ("window 18:00–19:40Z",
  // "at 18:00–19:40Z") still convicts — the start must itself be governed.
  // Iteration 16 (FO firing 27): the separator window is 16 chars (a meridiem
  // start "11:35 AM" + en-dash is ~11) so a meridiem-marked range start
  // reaches the inheritance branch at all.
  const sep = RANGE_SEP_BEFORE_RE.exec(line.slice(Math.max(0, idx - 16), idx));
  if (sep) {
    const sepStart = Math.max(0, idx - 16) + sep.index;
    const tok = RANGE_START_TOKEN_RE.exec(line.slice(Math.max(0, sepStart - 24), sepStart));
    if (tok) {
      const tokStart = Math.max(0, sepStart - 24) + tok.index;
      if (exemptAt(tokStart)) return !verbGovernStamp(idx);
    }
  }
  return false;
}

/** UTC-midnight ms for a VALID y/mo/d only — rejects rolled days (2026-02-31) and two-digit-year remaps. */
function utcDayMs(y: number, mo: number, d: number): number | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo, d);
  const dt = new Date(ms);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? ms : null;
}

interface LineDatePin { start: number; end: number; dayMs: number }

/** Valid calendar dates mentioned on a line, in order — UTC-midnight dayMs + the span the mention covers. */
function findLineDatePins(line: string, now: Date): LineDatePin[] {
  const pins: LineDatePin[] = [];
  LINE_DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_DATE_RE.exec(line))) {
    let dayMs: number | null = null;
    if (m[1] !== undefined) {
      // ISO yyyy-mm-dd — the year is explicit.
      dayMs = utcDayMs(+m[1], +m[2] - 1, +m[3]);
    } else {
      const mon = String(m[4] ?? m[7]).slice(0, 3).toLowerCase();
      const d = +(m[5] ?? m[6]);
      const mo = MONTH_INDEX[mon];
      if (mo !== undefined) {
        const thisYear = utcDayMs(now.getUTCFullYear(), mo, d);
        const lastYear = utcDayMs(now.getUTCFullYear() - 1, mo, d);
        if (thisYear !== null && lastYear !== null) {
          dayMs = Math.abs(thisYear - now.getTime()) <= Math.abs(lastYear - now.getTime()) ? thisYear : lastYear;
        } else {
          dayMs = thisYear ?? lastYear; // e.g. Feb-29: only leap-year candidates survive
        }
      }
    }
    if (dayMs !== null) pins.push({ start: m.index, end: m.index + m[0].length, dayMs });
  }
  // Bare MM-DD numeric dates (ticket 958311f1) — exoneration-only pins, scanned
  // from the DEDICATED MM_DD_DATE_RE (never LINE_DATE_RE, so they stay out of
  // any whole-line date exemption and cannot launder a whole line).
  MM_DD_DATE_RE.lastIndex = 0;
  while ((m = MM_DD_DATE_RE.exec(line))) {
    const mo = +m[1];
    const d = +m[2];
    const thisYear = utcDayMs(now.getUTCFullYear(), mo - 1, d);
    const lastYear = utcDayMs(now.getUTCFullYear() - 1, mo - 1, d);
    let dayMs: number | null = null;
    if (thisYear !== null && lastYear !== null) {
      dayMs = Math.abs(thisYear - now.getTime()) <= Math.abs(lastYear - now.getTime()) ? thisYear : lastYear;
    } else {
      dayMs = thisYear ?? lastYear; // e.g. Feb-29: only leap-year candidates survive
    }
    if (dayMs !== null) pins.push({ start: m.index, end: m.index + m[0].length, dayMs });
  }
  // Day-of-week names pin to their MOST RECENT occurrence ≤ now's UTC day
  // (ticket 65239c9a sighting 2) — capitalized forms only, never a future
  // day; see DAY_NAME_RE's comment for the full contract.
  DAY_NAME_RE.lastIndex = 0;
  const dayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  while ((m = DAY_NAME_RE.exec(line))) {
    const dow = DAY_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (dow === undefined) continue;
    const back = (now.getUTCDay() - dow + 7) % 7;
    pins.push({ start: m.index, end: m.index + m[0].length, dayMs: dayStartUtc - back * 86_400_000 });
  }
  // Pins from both sources must stay in line order — the detector's "LAST
  // adjacent pin governs" and "FIRST trailing pin" scans assume position sort.
  pins.sort((a, b) => a.start - b.start);
  return pins;
}

/**
 * A line pointing its clock token(s) at the FUTURE is not an observation
 * claim — schedules, ETAs, expiries and maintenance windows are legitimate
 * forward references (review F2: this list must cover the common wordings —
 * "Cron schedules 22:00Z", "token expires 18:00Z", "maintenance window").
 * Ticket 6cd44575 widened the ETA/forecast vocabulary: "the baseline finishes
 * ~6:30–8:30 PM PDT tonight" is a PREDICTION (an ETA attributed to an observed
 * message), not an observation of the future — the old list had no
 * finish/tonight wording, so the note was struck wholesale and a false
 * phantom ticket was filed. Additions (all INTRINSICALLY prospective
 * wordings): finishes/finishing, land(s/ing), projected/projection,
 * estimate(d/s), forecast, predict, expects, tonight/this evening/eod.
 * Deliberately EXCLUDED (adversarial review E1 — these are one-token drifts
 * of the phantom corpus's nemesis "Audit complete — verified through
 * 15:03:42Z" and would shield future-clock convictions): ALL complete/
 * completion/completes/completed forms, "ready", bare "finish", past-tense
 * finished, bare noun "project" (on every fleet line), "by" ("verified by
 * fresh probe at …" is an observation line), done/closed/running. Accepted
 * residual (review E2/E3): tonight/eod exempt their whole line like the
 * standing "will" does, and honest modal ETAs ("should finish around 8:30 PM
 * PDT") still convict — under-broad is the fail-safe direction for a
 * fabrication detector. Merge note (2026-08-28): PR #428 shipped the same
 * root fix mid-review with `finish\w*` — narrowed here to `finish(?:es|ing)`
 * because `\w*` also exempts "finished", the past-tense completion-claim
 * register ("Baseline finished at 8:30 PM PDT — tallies in.").
 * Ticket 188e0993 (2026-08-29, third same-class false positive): the fleet
 * supervisor's canonical next-look idiom — "Watch for `28de72e5` bench JSONL
 * completion …; watch for Path C's 13:12Z R42 probe; watch for Nightly's
 * 14:08Z tick" (its ## Next section) — was struck as an impossible
 * observation, but "watch for" is INTRINSICALLY prospective (you can only
 * watch for what has not happened), so the line is a forward monitoring
 * reference, never an observation claim. Addition: watch(?:es|ing)?\s+for —
 * the PHRASAL form only. Deliberately EXCLUDED: "watched" (past-tense
 * observation register — "watched the 15:03Z probe — all green" with a future
 * stamp IS the phantom class and must still convict) and bare "watch" with no
 * "for" (a one-token drift shield).
 * 2026-08-31 (chat c0e22e36, the recurring 375c8618-class false strike the
 * owner escalated): the supervisor's wake note relayed a message "queued
 * behind its hourly tick 17:29:37Z future" — run clock 17:17:56Z — and was
 * struck +12m though the note had FOLLOWED machine-wake rule 8 ("a future
 * timestamp may appear ONLY labeled as a future event") and labeled it with
 * the literal label word: "future" — which this whitelist did not contain.
 * Additions: `future` — the very word the taught contract names for the
 * exemption (self-refuting on an observation line: no phantom writes
 * "observed at <clock> future", so it cannot launder the incident class) —
 * and `ticks?`, the fleet's canonical schedule noun ("hourly tick", "monitor
 * tick", "its 14:08Z tick"; a tick time is a schedule's fire time, forward-
 * looking by construction — the same ledger logic as ticket 65239c9a).
 * Operator iteration 24 (FO firing 34, 2026-09-27 14:25Z): the fleet's
 * DECISION-INSTANT noun — "the 18:00Z checkpoint (cheapest non-preemptible
 * capacity purchase …)", "Coordinator's 18:00Z escalation checkpoint" — was
 * struck 4× in 4h (f5c2c1f4 11:40:52Z / 12:05:13Z / 14:25:51Z, 615723ba
 * 13:31:00Z; +214m…+379m), each reject-back costing a full bounded
 * re-orchestration, because "checkpoint" named no intent word. A checkpoint
 * time is a scheduled future decision instant — the same register as
 * `deadline` (already exempt: "deadline 2026-10-03T11:30Z") and the coding
 * lane's schedule-subject noun list (run-evidence-guard.ts tickets 2884edba /
 * ca153ef8 / 10ee7161, which long ago enumerated "checkpoint" as a schedule
 * noun and even INVERTED its gate to exemption-by-default — this lane's
 * enumerated list is the strictly more conservative shape). Addition:
 * `checkpoints?` (noun, plural included). Deliberately EXCLUDED: verb
 * "checked" and "re-checked" (past-tense observation register), "checkpointed"
 * (completed-work register — "checkpointed at <future stamp>" is the phantom
 * class), and bare "check" (too common). ANTI-SMUGGLE: the exemption is
 * line-scoped and only fires when the token's line names the noun; an
 * observation claim whose stamp is future still convicts on every line NOT
 * carrying a future-intent word.
 * STRUCTURAL follow-up (the whack-a-mole breaker): machine-wake rule 8 now
 * enumerates its taught label examples from this same vocabulary, and the
 * test suite runs the FULL machineWakePreamble through this detector
 * (action-verifier.test.ts "preamble ↔ detector drift guard") — the taught
 * vocabulary and the detected vocabulary can no longer diverge silently:
 * any rule-8 example this regex doesn't exempt fails CI instead of striking
 * an honest note in prod.
 */
const FUTURE_INTENT_RE = /\b(next|will|schedul\w*|fires?|firing|planned|plans?|eta|resumes?|resuming|resets?|tomorrow|tonight|this evening|eod|upcoming|deadline|targets?|backoff|polls?|expect(?:s|ed|ing)?|finish(?:es|ing)|lands?|landing|projected|projections?|estimated?|estimates|forecast(?:s|ed|ing)?|predict(?:s|ed|ing)?|due|expires?|expiry|valid|until|windows?|cron|maintenance|watch(?:es|ing)?\s+for|future|ticks?|checkpoints?)\b/i;

/**
 * Schedule-ARTIFACT citation lines (ticket 65239c9a, 2026-08-31): a line that
 * cites a schedule row by id — the wake preamble's evidence-list idiom
 * "[sched:24576714-…]", "sched `08ae015c`", "schedule `2ffa817e`",
 * "`1fbe4800…` (sched)" — is a
 * schedule LEDGER entry, so its clock token is that schedule's FIRE TIME:
 * forward-looking by construction, never an observation of the future. The
 * incident: the fleet supervisor's verbatim dispatch-ledger line
 * "- [sched:24576714-…] — **new this wake**: one-time Monday 13:33Z (9:30 AM
 * ET) owner checklist into d1062348" (real run clock 2026-08-31T02:01:43Z)
 * was struck +691m and the honest wake note replaced pre-delivery — the
 * line's only schedule marker was the ABBREVIATED artifact label "sched:",
 * which FUTURE_INTENT_RE's `schedul\w*` cannot match, and "one-time"/
 * "checklist" carry no intent keyword. Shape mirrors EVIDENCE_SCHED_CITATION
 * AND EVIDENCE_SCHED_CITATION_POST_ID (minus captures and the global flag) so
 * every lane reads the same idiom vocabulary — no drift (review N2: the
 * post-id label form "`id` (sched)" is the same ledger register; omitting it
 * left an honest post-id ledger line convicting). ANTI-SMUGGLE: an INVENTED
 * id gains nothing — the schedule-citation lane (ticket 5448a836)
 * existence-checks every mined id against the schedule rows and convicts ids
 * naming no row, and (review B1) the guard's non-supervisor gate below gained
 * the hasScheduleCitationIdiom disjunct so a citation-carrying note ALWAYS
 * reaches that lane — before it, an invented id co-located with a future
 * fire-time clock escaped every audit on a keyword-free non-supervisor wake
 * (this lane exempts the line; "sched <id>" is no ACTION_CLAIM_KEYWORD_RE
 * word). The residual laundering surface is the deliberately-weak
 * REAL-but-unrelated binding the msg lane documented (review F2); a
 * whole-line exemption is also the standing posture of FUTURE_INTENT_RE
 * itself ("will" shields its whole line). Accepted residual (identical to the
 * co-line "will" smuggle): a fabricated observation sharing a line with a
 * REAL sched citation escapes THIS detector — the post-delivery action-claim
 * lanes backstop the fabrication itself, and under-broad stays the fail-safe
 * direction. Re-review residual (round-2, 3a): a BLOCKQUOTED ledger line
 * ('>') in a note with zero void context escapes every lane — this gate fires
 * on the decorated line while the citation miners skip '>' unconditionally —
 * accepted: the realistic quote case (an audit note quoting struck content)
 * carries void markers and SHOULD skip, and a quotation is not the note's own
 * assertion.
 */
const SCHED_ARTIFACT_LINE_RE = /\bsched(?:ule)?\b[\s:]*[`"']?[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}\b|[`"']?\b[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}\b[`"']?\s*\((?:sched|schedule)\)/i;

/**
 * Cheap deterministic pre-gate (ticket 65239c9a review B1): does the text cite
 * a schedule row by id in either taught idiom? No exclusions — over-matching
 * just runs the matcher (which applies the full precision guards), the same
 * contract as hasSessionChatRefIdiom. Non-global regex → .test is stateless.
 */
export function hasScheduleCitationIdiom(text: string | null | undefined): boolean {
  return !!text && SCHED_ARTIFACT_LINE_RE.test(text);
}

/**
 * A line pointing its clock token(s) at the PAST cites an EARLIER observation
 * — exempt (review F2: without this escape, a real probe 12–24h old whose
 * clock-of-day is later than now's reads as "future" under the nearest-
 * candidate rule, e.g. "last night's 22:00Z probe" cited at 14:24Z).
 * ("since <clock>" is past-pointing too, but handled PER-TOKEN below via
 * SINCE_TOKEN_RE — a whole-line "since" exemption would shield a co-line
 * fabrication; PR-B review F4.)
 */
const PAST_REFERENCE_RE = /\b(last|yesterday|earlier|previous|prior|ago|this morning|this afternoon)\b/i;

export interface FutureObservedTimestamp {
  /** The literal token as written ("15:03:42Z"). */
  token: string;
  /** The full line it appeared on (truncated to 160 chars). */
  line: string;
  /** The instant the token claims, resolved to UTC. */
  claimedAt: Date;
  /** Whole minutes the claim is ahead of `now`. */
  minutesAhead: number;
}

/**
 * Void/strike context (ticket 80dd882d, supervisor steer 2026-08-28): a note
 * that is VOIDING or auditing prior content (its own void notice, or a quote
 * of the guard's struck/audit blocks) treats blockquoted lines as CITATIONS
 * of that content, so their stamps are exempt from future-clock scanning.
 * Gated on this context so bare decoration alone NEVER exempts a fabricated
 * line (the coding lane's review-A1 anti-laundering pin). 'UNVERIFIED' is
 * deliberate: the guard's own warn/strike banners carry it, so a note quoting
 * guard-flagged content gets the exemption.
 */
const VOID_CONTEXT_RE = /\b(void(?:ed|s|ing)?|struck|fabricat\w+|NOT DONE|UNVERIFIED)\b|---\s*(?:BEGIN|END)\s+(?:STRUCK NOTE|UNVERIFIED RUN OUTPUT)/i;

/**
 * BLOCK-LOCAL quoted-void exemption (2026-09-08; mirrors run-evidence-guard's
 * quotedVoidExemptions — keep the two in sync): the cue used to be tested on
 * the WHOLE note, and every redo/recovery note echoes the harness vocabulary
 * ("struck", "NOT DONE"), so any '> …' line anywhere laundered a future clock.
 * A blockquote block (a maximal run of '>' lines, blank lines tolerated when
 * another '>' line follows) is exempt only when the cue sits inside it or
 * within VOID_CONTEXT_LOOKBACK_LINES non-blank lines immediately above it.
 * Input: TRIMMED lines in original order; output: per-line exemption flags.
 */
const VOID_CONTEXT_LOOKBACK_LINES = 3;
function quotedVoidExemptions(lines: string[]): boolean[] {
  const out: boolean[] = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('>')) { i++; continue; }
    let j = i;
    while (j < lines.length) {
      if (lines[j].startsWith('>')) { j++; continue; }
      if (!lines[j]) {
        let k = j;
        while (k < lines.length && !lines[k]) k++;
        if (k < lines.length && lines[k].startsWith('>')) { j = k; continue; }
      }
      break;
    }
    let exempt = false;
    for (let k = i; k < j && !exempt; k++) if (lines[k] && VOID_CONTEXT_RE.test(lines[k])) exempt = true;
    if (!exempt) {
      let seen = 0;
      for (let k = i - 1; k >= 0 && seen < VOID_CONTEXT_LOOKBACK_LINES; k--) {
        if (!lines[k]) continue;
        seen++;
        if (VOID_CONTEXT_RE.test(lines[k])) { exempt = true; break; }
      }
    }
    if (exempt) for (let k = i; k < j; k++) if (lines[k].startsWith('>')) out[k] = true;
    i = j;
  }
  return out;
}

/**
 * ── Tool-output stamp PROVENANCE (ticket a688ba29 — the chat-lane port of the
 * coding lane's e409e51e / 9ed46ffe machinery; the five helpers below are
 * VERBATIM copies of run-evidence-guard.ts's — keep the two in sync, the same
 * discipline as VOID_CONTEXT_RE) ──
 * A future-looking stamp is a fabricated OBSERVATION only when the run could
 * not have SEEN it: when this run's own tool output carries the same clock
 * reading (a schedule's nextRunAt, a receipt instant), the stamp is quoted
 * data about the future, not an invented clock. Sighting 6 (chat c0e22e36,
 * 2026-09-03T04:12Z): "monitor re-armed for 04:40Z" struck +28m though the
 * run's fresh list_schedules carried nextRunAt "2026-09-03T04:40:06.386Z" —
 * the chat-lane materialization of the coding lane's e409e51e ("re-armed for
 * collection at 20:05Z"). The FUTURE_INTENT_RE keyword whitelist is unbounded
 * whack-a-mole — every recurrence coined a new forward phrasing ("… future",
 * "hourly tick", now "re-armed"); provenance is phrasing-independent.
 * Anti-smuggle: the exemption covers ONLY the stamp tell — any claim on the
 * same line still faces the action/citation lanes — and the observed phantom
 * corpus wrote clocks with NO tool provenance (the a8976e11/#307 pins carry
 * no matching haystack times and keep convicting). Anti-laundering: haystacks
 * are built ONLY from tool_result text — never prompts, system text, model
 * text, or guard chrome. Model text can reach a haystack ONLY echoed inside a
 * tool result (e.g. a file_feedback result quoting its own model-authored
 * title arg): a deliberate two-step mint, outside the hallucination threat
 * model, the identical exposure the coding lane ships, and the action/
 * citation lanes still audit the line's claims (adversarial review, claim-2
 * caveat — do not re-widen this wording into an absolute).
 * Inherited residuals (both byte-identical to the coding lane, both in the
 * over-strike — safe — direction): the isoDate/human-date legs of
 * stampHasToolProvenance are LATENT here (CLOCK_TOKEN_RE tokens never carry
 * dates — kept verbatim for sync discipline); and a haystack carrying ONLY a
 * 12-hour reading ("12:40 AM EDT") cannot vouch for the 24h form of the same
 * instant (the instant path parses Z/UTC/GMT 24h readings only) — an honest
 * cross-format quote can still strike, never the reverse (F1, probed
 * 2026-09-03: same-format works, a different-instant phantom still convicts).
 */
/** Clock-reading contexts in a haystack: ISO date+time, or HH:MM[:SS][.fff]
 * immediately followed by a zone. A bare "20:05" (mm:ss duration) matches
 * neither. Leading (?<!\d) blocks substring hits inside longer numbers.
 * (Verbatim copy of run-evidence-guard.ts — keep in sync.) */
function haystackHasClockContext(h: string, timeKey: string): boolean {
  const esc = timeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<!\\d)(?:\\d{4}-\\d{2}-\\d{2}[T ]${esc}|${esc}(?::\\d{2})?(?:\\.\\d+)?\\s*(?:Z|UTC|GMT|[AP]M\\b|[PCEM][SD]T\\b))`,
    'i',
  ).test(h);
}

/** Clock readings whose INSTANT can be computed from a haystack (ticket
 * 9ed46ffe): ISO date+times (zone defaulting to Z, matching parseIsoStamp)
 * and 24h HH:MM[:SS][.fff] readings tagged Z/UTC/GMT — the forms receipts
 * and log lines actually print. Bare unzoned HH:MM stays un-parsed (the P3
 * duration rule: a "20:05" mm:ss duration never vouches for a clock).
 * (Verbatim copies of run-evidence-guard.ts — keep in sync.) */
const HAYSTACK_ISO_INSTANT_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/g;
const HAYSTACK_CLOCK_INSTANT_RE = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(?:Z|UTC|GMT)\b/gi;

/**
 * Slack permalink epochs (ticket 71a270d2, 2026-09-24): slack_search — the
 * only surface that reaches DM/MPIM content (channel history cannot list DMs)
 * — renders NO clock text at all; each hit's permalink embeds the message
 * instant as /p<seconds+micros, dot stripped> (16 digits:
 * p1790195999249539 = 2026-09-23T20:39:59.249Z). The incident: the daily
 * Slack-digest machine wake (chat 1ea4621f, run clock 2026-09-24T15:21:04Z)
 * cited a REAL yesterday DM datelessly — "(1:40 PM PDT / 20:40Z)" for that
 * very permalink — so the provenance reader above saw nothing it could match
 * (no clock text, and the µs epoch is not an ISO/Z reading), the
 * nearest-candidate rule resolved the dateless token to TODAY 20:40Z
 * (+319 min, "impossible"), and the whole owner-requested digest was
 * REPLACED pre-delivery. Channel-sourced lines survived ("20:09:00 UTC" in
 * history output vouches via the clock leg) — only the search/permalink
 * surface was blind. The /p prefix keeps this unambiguous (a Slack permalink
 * IS a timestamp by construction; a bare 16-digit run could be an id —
 * pinned in tests). thread_ts query params carry the dotted seconds form and
 * never match. (Verbatim copy of run-evidence-guard.ts — keep in sync.)
 */
const HAYSTACK_PERMALINK_EPOCH_RE = /\/p(\d{16})(?!\d)/g;
/**
 * Time-of-day tolerance for the permalink-epoch leg: the incident's own
 * citations round to the minute (20:39:59→"20:40", 1s; 21:15:29→"21:15",
 * 29s), so 120s absorbs minute-rounding with 4x margin while staying inside
 * "the clock matches a real tool-observed instant" — a fabricated clock must
 * land within 2 minutes of an instant the run's own tool output actually
 * carried to launder through this leg, and every other claim on the line
 * still faces the action/citation lanes (the standing exemption scope).
 */
const EPOCH_TIME_OF_DAY_TOLERANCE_MS = 120_000;

/** Verbatim copy of run-evidence-guard.ts's parseIsoStamp — keep in sync. */
function parseIsoStamp(date: string, hh: string, mm: string, ss: string | undefined, zone?: string): number | null {
  let suffix = zone ?? 'Z';
  if (suffix === 'UTC' || suffix === 'GMT') suffix = 'Z';
  if (/^[+-]\d{4}$/.test(suffix)) suffix = `${suffix.slice(0, 3)}:${suffix.slice(3)}`;
  const t = Date.parse(`${date}T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}${suffix}`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Does a haystack carry the stamp's INSTANT in a different clock format?
 * ("4:07 PM PDT" citing a schedule receipt's nextRunAt "…T23:07:42.195Z" —
 * the verbatim timeKey check keys on "4:07" and sees nothing, the P9
 * residual.) ISO readings compare minute-floored instants (date included);
 * clock-only readings compare UTC HH:MM (date-independent — the same
 * semantics as the verbatim clock-context path, P4 accepted residual);
 * Slack permalink epochs compare UTC time-of-day ±120s (date-independent,
 * ticket 71a270d2 — see HAYSTACK_PERMALINK_EPOCH_RE).
 * (Verbatim copy of run-evidence-guard.ts — keep in sync.)
 */
function haystackHasInstant(h: string, instantMs: number): boolean {
  const wantMinute = Math.floor(instantMs / 60_000);
  const wantClock = new Date(instantMs).toISOString().slice(11, 16); // "HH:MM" UTC
  HAYSTACK_ISO_INSTANT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HAYSTACK_ISO_INSTANT_RE.exec(h))) {
    const t = parseIsoStamp(m[1], m[2], m[3], m[4], m[5]);
    if (t !== null && Math.floor(t / 60_000) === wantMinute) return true;
  }
  HAYSTACK_CLOCK_INSTANT_RE.lastIndex = 0;
  while ((m = HAYSTACK_CLOCK_INSTANT_RE.exec(h))) {
    if (parseInt(m[1], 10) > 23 || parseInt(m[2], 10) > 59) continue;
    if (`${m[1].padStart(2, '0')}:${m[2]}` === wantClock) return true;
  }
  // Slack permalink-epoch leg (ticket 71a270d2): a search result's /p<16-digit
  // µs epoch> IS a clock reading this run's tool output carried — encoded.
  // Decode and compare time-of-day date-INDEPENDENTLY (the clock-only stamp
  // asserts no day; the same P4 semantics as the clock leg above), within
  // EPOCH_TIME_OF_DAY_TOLERANCE_MS for the incident's observed minute-
  // rounding (20:39:59.249Z cited as "20:40Z"; 21:15:29.075Z as "21:15Z").
  // Widened residual (accepted, same P4 class): a digest run's many search
  // permalinks raise the odds a fabricated dateless clock coincides with a
  // real observed time-of-day — the exemption still covers ONLY the
  // impossible-observation tell (every claim on the line keeps facing the
  // action/citation lanes), and over-exemption is the fail-safe direction
  // for this detector.
  HAYSTACK_PERMALINK_EPOCH_RE.lastIndex = 0;
  const wantTodMs = ((instantMs % 86_400_000) + 86_400_000) % 86_400_000;
  while ((m = HAYSTACK_PERMALINK_EPOCH_RE.exec(h))) {
    const epochMs = Number(m[1]) / 1000; // µs → ms (16 digits stay < 2^53)
    const todMs = ((epochMs % 86_400_000) + 86_400_000) % 86_400_000;
    const deltaMs = Math.abs(todMs - wantTodMs);
    if (Math.min(deltaMs, 86_400_000 - deltaMs) <= EPOCH_TIME_OF_DAY_TOLERANCE_MS) return true;
  }
  return false;
}

/** Verbatim copy of run-evidence-guard.ts's stampHasToolProvenance — keep in sync. */
function stampHasToolProvenance(stamp: string, evidence: string[], instantMs?: number): boolean {
  if (!evidence.length) return false;
  const timeKey = /(\d{1,2}:\d{2})/.exec(stamp)?.[1];
  let hasClock = timeKey ? evidence.some((h) => haystackHasClockContext(h, timeKey)) : false;
  if (!hasClock && instantMs !== undefined) {
    // P9 closed (ticket 9ed46ffe): the stamp quotes a receipt instant in a
    // DIFFERENT clock format ("4:07 PM PDT" citing nextRunAt "…T23:07:42.195Z")
    // — compare minute-floored instants instead of verbatim strings. Every
    // stamp the passes parse reaches here with an instant (zoned clocks;
    // zone-less ISO stamps default Z in parseIsoStamp — same UTC reading the
    // guard convicts them by, so the fallback is format normalization, not a
    // zone assumption); a bare "4:07" with no zone still cannot borrow the
    // receipt's 23:07.
    hasClock = evidence.some((h) => haystackHasInstant(h, instantMs));
  }
  if (!hasClock) return false;
  const isoDate = /(\d{4}-\d{2}-\d{2})/.exec(stamp)?.[1];
  if (isoDate) return evidence.some((h) => h.includes(isoDate));
  // Human-form explicit date ("Aug 29 …", "August 29, 2026 …", "Aug-29"): the
  // stamp ASSERTS a date — evidence must carry that month-day literally too,
  // or a bare duration would vouch for an explicit-future-date phantom (probe
  // P5). Separator is space OR dash: the trailing-pin compound pass (ticket
  // 85f8d318) puts dash-form dates into stamps for the first time, and they
  // assert a day exactly like the space form.
  const human = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s-](\d{1,2})/i.exec(stamp);
  if (human) {
    const litRe = new RegExp(`${human[1]}[\\s-]${human[2]}(?:st|nd|rd|th)?\\b`, 'i');
    return evidence.some((h) => litRe.test(h));
  }
  return true;
}

/**
 * The guard's future-clock evidence haystacks: the run's tool_result texts
 * ONLY (the coding lane's fdHaystacks discipline, run-evidence-guard.ts
 * L2912-2915) — never prompts, system text, model text, or guard chrome, so a
 * phantom clock cannot be laundered through text written ABOUT it (the
 * reject-back notice names the struck stamp — it is a user-role harness
 * message, never a part, so it cannot vouch). A tool result may still ECHO
 * model-authored args (e.g. a filed-ticket title) — the accepted, coding-lane
 * parity residual documented above. Exported for the chat-agent reject-back
 * seam (pass-2 cross-attempt provenance) and tests.
 */
export function toolResultTextsFromParts(parts: RunPartLike[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p && p.type === 'tool_result' && typeof p.result === 'string' && p.result) out.push(p.result);
  }
  return out;
}

/**
 * (FO firing 24, 2026-09-26) Token-anchored strike excerpt. The old excerpt
 * was `rawLine.trim().slice(0, 160)` — the LINE'S FIRST 160 chars — so on a
 * long sweep-table row the struck TOKEN itself was cut off entirely (prod
 * strike c0e22e36 00:19:36.900Z: a 156-char row, token "5:45 PM PDT" past the
 * window; the stored clockHits.line carried a "|" column the token never
 * appeared in), and the governing marker/verb (a "~" 40 chars before the
 * token, a "merged" in an earlier clause) was invisible to the operator
 * without re-running the guard live. This excerpt keeps the line's head when
 * the token fits, otherwise it anchors a 160-char window around the token
 * (up to 64 chars before it — covering the estimate-marker adjacency window
 * and most clause-scoped verb gaps — ellipsed at the cut so a mid-window
 * start is unmistakable). The FULL untruncated line still reaches the seam's
 * correction/notice surfaces; only this diagnostic excerpt changes shape.
 */
function tokenAnchoredExcerpt(rawLine: string, token: string, tokenStart: number): string {
  const line = rawLine.trim();
  const tok = String(token ?? '');
  if (!tok) return line.slice(0, 160);
  // tokenStart is an index into rawLine; re-locate it on the trimmed line
  // (only leading whitespace was trimmed, so the offset shifts by the trim).
  const lead = rawLine.length - rawLine.trimStart().length;
  const idx = line.indexOf(tok, Math.max(0, tokenStart - lead - 8));
  const tokEnd = idx >= 0 ? idx + tok.length : line.length;
  if (tokEnd <= 160) return line.slice(0, 160);
  const from = Math.max(0, Math.min(idx - 64, line.length - 160));
  const body = line.slice(from, from + 160);
  return (from > 0 ? '…' : '') + body;
}

export function findFutureObservedTimestamps(
  text: string,
  now: Date,
  opts?: { evidenceHaystacks?: string[]; scheduleFiringTimes?: number[] },
): FutureObservedTimestamp[] {
  const out: FutureObservedTimestamp[] = [];
  if (!text) return out;
  // Provenance haystacks (ticket a688ba29): this run's tool-output texts,
  // whitespace-collapsed once (the coding lane's idiom) so formatting drift
  // inside a result cannot defeat an honest match.
  const haystacks = (opts?.evidenceHaystacks ?? []).map((h) => String(h ?? '').replace(/\s+/g, ' ')).filter(Boolean);
  const rawLines = text.split('\n');
  const voidQuoteExempt = quotedVoidExemptions(rawLines.map((l) => l.trim()));
  const dayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nowMs = now.getTime();
  for (let li = 0; li < rawLines.length; li++) {
    const rawLine = rawLines[li];
    // Quoted-void exemption (ticket 80dd882d, supervisor steer 2026-08-28): a
    // blockquoted line inside a note that is VOIDING/auditing prior content
    // is a CITATION of that content, not this run's own observation claim —
    // the 14:42Z incident: a recovery audit voiding the prior tick's
    // fabricated reply was flagged for the future stamp inside its quote.
    // Gated on void-context so bare decoration alone can NEVER launder a
    // fabricated line (the coding lane's review-A1 pin: an unmatched
    // decorated quote in an ordinary note still convicts). BLOCK-LOCAL since
    // 2026-09-08 (quotedVoidExemptions): the cue must be in the quote block
    // or its ≤3-line lead-in, not anywhere in the note.
    if (voidQuoteExempt[li]) continue;
    if (FUTURE_INTENT_RE.test(rawLine) || PAST_REFERENCE_RE.test(rawLine) || SCHED_ARTIFACT_LINE_RE.test(rawLine)) continue;
    if (afterEventCueLine(rawLine)) continue; // line-leading "After <EVENT>:" forward plan (iteration 13b, steer 2026-09-25)
    const datePins = findLineDatePins(rawLine, now);
    // The schedule-firing instants the caller fetched (iteration 13) — the
    // ±60s exemption needs them as plain epoch ms numbers.
    const schedTimes = opts?.scheduleFiringTimes ?? [];
    // Estimate-gloss inheritance (iteration 11): the END index + instant of the
    // last estimate-exempted token on THIS line — a same-instant parenthetical
    // zone gloss right after it inherits the exemption.
    let lastEstimateExempt: { end: number; ms: number } | null = null;
    const inheritsEstimateGloss = (idx: number, ms: number): boolean => {
      if (!lastEstimateExempt || Math.abs(lastEstimateExempt.ms - ms) > ESTIMATE_GLOSS_TOLERANCE_MS) return false;
      const gap = rawLine.slice(lastEstimateExempt.end, idx);
      return gap.length <= 24 && gap.lastIndexOf('(') > gap.lastIndexOf(')');
    };
    // Full ISO stamps (date-pinned by construction — tick 10, 2026-09-15): a
    // "2026-09-15T05:00:00Z" asserted as an observation at a real 01:14Z is
    // impossible exactly like a bare future clock; before this lane the
    // stamp's MM:SSZ tail was mis-read by CLOCK_TOKEN_RE instead.
    ISO_STAMP_RE.lastIndex = 0;
    let iso: RegExpExecArray | null;
    while ((iso = ISO_STAMP_RE.exec(rawLine))) {
      const stampMs = Date.parse(iso[0]);
      if (!Number.isFinite(stampMs)) continue;
      if (SINCE_TOKEN_RE.test(rawLine.slice(Math.max(0, iso.index - 40), iso.index))) continue;
      if (CONDITIONAL_BEFORE_STAMP_RE.test(rawLine.slice(0, iso.index))) continue;
      const aheadMs = stampMs - nowMs;
      if (aheadMs <= FUTURE_TS_TOLERANCE_MS) continue;
      if (haystacks.length && stampHasToolProvenance(iso[0], haystacks, stampMs)) continue;
      if (estimateGovernedStamp(rawLine, iso.index)) { lastEstimateExempt = { end: iso.index + iso[0].length, ms: stampMs }; continue; } // estimate/deadline-governed ("by ~2026-09-25T04:26Z")
      if (schedFiringGovernedStamp(rawLine, iso.index, stampMs, schedTimes)) { lastEstimateExempt = { end: iso.index + iso[0].length, ms: stampMs }; continue; } // schedule-firing paraphrase (iteration 13) — gloss twins inherit
      if (inheritsEstimateGloss(iso.index, stampMs)) continue;
      out.push({
        token: iso[0],
        line: rawLine.trim().slice(0, 160),
        claimedAt: new Date(stampMs),
        minutesAhead: Math.round(aheadMs / 60_000),
      });
    }
    CLOCK_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLOCK_TOKEN_RE.exec(rawLine))) {
      let hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      const ss = m[3] ? parseInt(m[3], 10) : 0;
      const ap = m[4]?.toLowerCase();
      const tz = m[5].toUpperCase();
      if (ap === 'p' && hh < 12) hh += 12;
      else if (ap === 'a' && hh === 12) hh = 0;
      const offsetCandidates = TZ_BEHIND_UTC_MIN[tz];
      if (!offsetCandidates) continue;
      // "since <clock>" is only coherent backward-pointing — skip the token
      // "since" directly governs (per-TOKEN: a co-line fabrication like
      // "silent since 17:01Z; verified at 15:03:42Z" still convicts — F4).
      if (SINCE_TOKEN_RE.test(rawLine.slice(Math.max(0, m.index - 40), m.index))) continue;
      // Hypothetical-clause exemption (ticket b84db359, chat-lane port of the
      // coding lane's c0f5a799 fix): "If silent past ~08:00Z I'll treat it as
      // wedged" sets a future THRESHOLD, not an observation. Clause-bounded —
      // "merged at <future>; if the probe confirms" still convicts (the "if"
      // sits in the NEXT clause, after the stamp).
      if (CONDITIONAL_BEFORE_STAMP_RE.test(rawLine.slice(0, m.index))) continue;
      // The LAST ADJACENT date pin governs the token's day (a date modifying
      // another noun must NOT govern the clock — review F2: "the Sept 1/3
      // date-correction draft … probe ran 22:00Z"). No pin → today/yesterday.
      let pinDayMs: number | null = null;
      for (const p of datePins) {
        if (p.end > m.index) break;
        if (DATE_TIME_GAP_RE.test(rawLine.slice(p.end, m.index))) pinDayMs = p.dayMs;
      }
      // TRAILING (postposed) date pin — "10:23:17Z Aug-29", "17:01Z on
      // Aug-27" (ticket 9ed1bf8e: the prod strike convicted a 24h-old
      // citation as +6m because only LEADING pins governed). The FIRST pin
      // after the token is the only adjacency candidate; if its gap isn't a
      // connector, no trailing pin governs (a date modifying a LATER noun —
      // "ran 22:00Z clean; the Aug-29 log" — must not reach back across
      // words). Same exoneration-only semantics as a leading pin: tried
      // ALONGSIDE the other candidates, never creating a conviction the base
      // rule wouldn't make.
      let trailingPinDayMs: number | null = null;
      const tokenEnd = m.index + m[0].length;
      for (const p of datePins) {
        if (p.start < tokenEnd) continue;
        if (TRAILING_DATE_GAP_RE.test(rawLine.slice(tokenEnd, p.start))) trailingPinDayMs = p.dayMs;
        break;
      }
      // Most-favorable resolution wins: for each plausible UTC offset (DST
      // pairs carry both), take the nearest of today's/yesterday's candidate —
      // then the SMALLEST ahead-ms across offsets. Convicting on the minimum
      // keeps a DST-mislabeled real observation out of the strike lane.
      let bestAheadMs = Infinity;
      let bestMs = 0;
      for (const behindMin of offsetCandidates) {
        const timeMs = (hh * 60 + mm + behindMin) * 60_000 + ss * 1000;
        const todayMs = dayStartUtc + timeMs;
        const yesterdayMs = todayMs - 86_400_000;
        const proxMs = Math.abs(yesterdayMs - nowMs) < Math.abs(todayMs - nowMs) ? yesterdayMs : todayMs;
        // EXONERATION-ONLY pins (round-2 review): the pinned candidate is
        // tried ALONGSIDE the proximity candidate and the most-favorable wins
        // — a pin can clear a proximity false-positive (the c7c90f40 class)
        // but never creates a conviction the base rule wouldn't make (a
        // future-dated forward reference like "Owner call Sept 1 22:00Z"
        // stays as clean as base; a future-dated phantom still convicts via
        // proximity whenever its time-of-day is ahead of now). TRAILING pins
        // (ticket 9ed1bf8e) join the same candidate set under the identical
        // most-favorable rule — adding candidates can only LOWER bestAheadMs,
        // so the change is pure exoneration by construction.
        const candidates = [proxMs];
        if (pinDayMs !== null) candidates.push(pinDayMs + timeMs);
        if (trailingPinDayMs !== null) candidates.push(trailingPinDayMs + timeMs);
        for (const candMs of candidates) {
          const aheadMs = candMs - nowMs;
          if (aheadMs < bestAheadMs) { bestAheadMs = aheadMs; bestMs = candMs; }
        }
      }
      if (bestAheadMs > FUTURE_TS_TOLERANCE_MS) {
        const token = m[0].trim();
        // Tool-output PROVENANCE exoneration (ticket a688ba29): the stamp is a
        // clock reading this run's OWN tool output carries (a schedule's
        // nextRunAt, a receipt instant) — quoted forward data, not an invented
        // observation. Stamp-specific (the coding lane's pin): a co-line
        // phantom clock with no provenance still convicts, and every claim on
        // the line still faces the action/citation lanes — this exemption
        // covers ONLY the impossible-observation tell.
        if (haystacks.length && stampHasToolProvenance(token, haystacks, bestMs)) continue;
        // Estimate/deadline-governed token (iteration 11): "~6:20 PM PDT",
        // "Verdict by ~11:45 AM PDT" — a forward estimate, never an observation.
        if (estimateGovernedStamp(rawLine, m.index)) { lastEstimateExempt = { end: m.index + m[0].length, ms: bestMs }; continue; }
        if (schedFiringGovernedStamp(rawLine, m.index, bestMs, schedTimes)) { lastEstimateExempt = { end: m.index + m[0].length, ms: bestMs }; continue; } // schedule-firing paraphrase (iteration 13) — gloss twins inherit
        if (inheritsEstimateGloss(m.index, bestMs)) continue; // "(18:45Z)" zone gloss of the exempted estimate
        out.push({
          token,
          line: tokenAnchoredExcerpt(rawLine, token, m.index),
          claimedAt: new Date(bestMs),
          minutesAhead: Math.round(bestAheadMs / 60_000),
        });
      }
    }
  }
  return out;
}

/**
 * Schedule-clock haystack (operator iteration 13, 2026-09-25). After the
 * estimate-lane fix landed, the next clock strikes on the Fleet Supervisor
 * were citations of HARNESS SCHEDULE fire times the model knew from earlier
 * wakes but had not listed THIS run: "| canlegal-bench | … | morning nudge
 * 7:31 AM PDT |" (+229 min, 10:46Z) and "the 5:08 AM PDT capacity check:
 * unchanged since the 3:44 AM note" (+77 min, 10:53Z) — both reject-back
 * retries came back clean at ≈4 min of supervisor time each. The tool-
 * provenance lane already exonerates a stamp whose instant appears in this
 * run's tool output (list_schedules nextRunAt, cross-format); this haystack
 * supplies the same forward data from the harness itself: the caller's
 * ENABLED schedules' nextRunAt / lastFiredAt (bounded, recent-or-future
 * only). Stamp-specific like every provenance exemption — a co-line invented
 * clock still convicts, and a fabricated observation that happens to land on
 * a real fire time is the accepted narrow miss. Fails open to [] on any DB
 * error.
 */
export async function scheduleClockHaystack(userId: string): Promise<string[]> {
  if (!userId) return [];
  try {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const rows = await prisma.chatSchedule.findMany({
      where: { userId, enabled: true, nextRunAt: { gte: since } },
      select: { id: true, nextRunAt: true, lastFiredAt: true },
      take: 400,
    });
    return (rows ?? []).map((r: any) =>
      `[harness schedule ${String(r.id).slice(0, 8)}] nextRunAt ${r.nextRunAt ? new Date(r.nextRunAt).toISOString() : '-'}${r.lastFiredAt ? ` lastFiredAt ${new Date(r.lastFiredAt).toISOString()}` : ''}`);
  } catch {
    return [];
  }
}

/**
 * PRE-DELIVERY phantom-action guard (ticket fcc4dbb4, 2026-08-26) — the
 * plain-chat machine-wake counterpart of the coding lane's run-evidence-guard
 * replacement (run-executor.ts). The post-delivery verifier convicts only
 * AFTER the note commits, so the owner can read the phantom claim first (five
 * flags in ~11.5h across two supervisor lanes before this shipped); this guard
 * runs the SAME matcher (computePhantomClaims — no drift) BEFORE the assistant
 * row persists and, on a conviction, REPLACES the final text: an honest
 * harness notice on top naming the struck claim kinds/ids, the original note
 * blockquoted below for audit. Structure mirrors
 * run-evidence-guard.renderSuppressedFinal with deliberately DISTINCT chrome
 * (the coding guard's markers stay its own).
 *
 * Gates (a): machine-triggered runs ONLY (machineTriggered !== true → pass-
 * through, struck:false). Gate (a2): BEFORE the keyword gate, a deterministic
 * future-observation-clock check (ticket 375c8618 — findFutureObservedTimestamps):
 * a machine note citing a tz-suffixed clock LATER than the run's real clock
 * (no future-intent wording on the line) is struck the same way — impossible
 * observations are fabrications the action matcher cannot see. Supervisor
 * chats always run the matcher, non-supervisor chats only when
 * hasActionClaimKeywords(finalText) — the same cheap pre-gate the post-
 * delivery lane uses. Consequences on a strike (d):
 * the SAME deduped mishap ticket (filePhantomTicket — identical title, so the
 * dedup bucket is shared with the post lane), for supervisors the durable
 * state-doc refutation, AND (ticket 51ed3a65) the in-thread correction bubble
 * after all: the replacement is NOT the correction for model context —
 * guard-chrome redaction (ticket ac835c00) swaps the persisted wrapper for a
 * GENERIC placeholder when stored rows reload as history, so a struck run's
 * next wake saw no specifics and re-confabulated (five strikes in one night
 * on the fleet supervisor, 2026-08-31). The guard returns the correction
 * TEXT on the result; the chat-agent seam injects it as a user-role harness
 * message AFTER the replacement row persists (chronology, and user-role
 * harness messages survive redaction by role gate). Zero phantoms → the
 * input text back with struck:false (e). Fully fail-open (f): any internal
 * error → warn log + the original text, struck:false.
 */
export async function guardMachineWakeFinalAnswer(input: PhantomClaimAuditInput): Promise<ActionGuardResult> {
  // build 2026-10-08 Q-3: the clock lane's verdict rides EVERY result (a note whose clock hits did not
  // convict continues to the citation / action lanes, whose returns know nothing of the clocks).
  const clockSink: { verdict?: FutureClockVerdict } = {};
  const result = await guardMachineWakeFinalAnswerInner(input, clockSink);
  return clockSink.verdict ? { ...result, clockVerdict: clockSink.verdict } : result;
}

async function guardMachineWakeFinalAnswerInner(input: PhantomClaimAuditInput, clockSink: { verdict?: FutureClockVerdict }): Promise<ActionGuardResult> {
  const pass: ActionGuardResult = { finalText: input.finalText, notice: '', struck: false, phantoms: [], audited: false };
  try {
    if (input.machineTriggered !== true) return pass;

    // (a2) Deterministic future-observation-clock strike (ticket 375c8618) —
    // BEFORE the keyword gate: a note whose ONLY fabrication is an impossible
    // clock carries no action keywords (the Re-Send lane's fabricated "5/5
    // verified audit" cited observations through 15:03:42Z with a real clock
    // of 14:24:28Z — deploy/restart-interrupted runs invent clock evidence).
    // Runs for every machine-triggered run; costs no LLM call.
    const futureClockNow = input.now ?? new Date();
    // Schedule-firing instants (iteration 13): every ENABLED schedule's next
    // firing in [now − 10 min, now + 24 h] — the window a supervisor note can
    // legitimately reference ("next tick 11:30Z", an ETA-cell firing time).
    // Lookup failure → NO exemption (the detector strikes honestly; the
    // reject-back retry re-checks — a DB hiccup can never launder a phantom).
    // Bounded: enabled rows only, one indexed column, capped at 500 instants.
    let scheduleFiringTimes: number[] = [];
    if (input.userId) {
      try {
        const rows = await prisma.chatSchedule.findMany({
          where: { userId: input.userId, enabled: true, nextRunAt: { gte: new Date(futureClockNow.getTime() - 10 * 60_000), lte: new Date(futureClockNow.getTime() + 24 * 60 * 60_000) } },
          select: { nextRunAt: true },
          take: 500,
        });
        scheduleFiringTimes = rows.map((r) => r.nextRunAt.getTime());
      } catch (err: any) {
        logger.warn(`action-verifier: schedule-firing lookup failed (clock exemption OFF for this note): ${err?.message}`, { source: 'action-verifier' });
      }
    }
    // Provenance haystacks (ticket a688ba29): this run's tool_result texts
    // (plus a rejected first attempt's, via the seam) — an honest forward
    // stamp quoting this run's own tool output is exonerated inside the
    // detector; invented clocks carry no provenance and still convict.
    const futureHitsAll = findFutureObservedTimestamps(input.finalText, futureClockNow, {
      evidenceHaystacks: [
        ...toolResultTextsFromParts(input.parts),
        ...(input.extraEvidenceHaystacks ?? []),
        // Harness-owned forward clocks (iteration 13): the owner's enabled
        // schedules' fire times — quoted forward data whether or not THIS run
        // listed them (see scheduleClockHaystack).
        ...(await scheduleClockHaystack(input.userId)),
      ],
      scheduleFiringTimes,
    });
    // build 2026-10-08 Q-3 (OWNER-APPROVED, supersedes the replace half of cdd3fbfe — future-clock-policy.ts):
    // only a clock WRITTEN AS AN OBSERVATION convicts; every other hit is recorded and the note continues to
    // the citation / action lanes. FUTURE_CLOCK_REPLACE_ENABLED=1 restores the legacy lane (every hit convicts).
    const clockPolicyOn = !futureClockReplaceEnabled();
    let futureHits = futureHitsAll;
    if (futureHitsAll.length) {
      const part = clockPolicyOn ? partitionFutureClockHits(futureHitsAll) : { convicted: futureHitsAll, observed: [] as Array<FutureObservedTimestamp & { verdict: Exclude<ClockHitVerdict, 'convicted'> }> };
      futureHits = part.convicted;
      clockSink.verdict = {
        outcome: !clockPolicyOn ? 'replaced' : part.convicted.length ? 'annotated' : 'observed',
        legacy: !clockPolicyOn,
        hits: [
          ...part.convicted.map((h) => ({ token: String(h.token).slice(0, 40), minutesAhead: h.minutesAhead, line: String(h.line).slice(0, 164), verdict: 'convicted' as ClockHitVerdict })),
          ...part.observed.map((h) => ({ token: String(h.token).slice(0, 40), minutesAhead: h.minutesAhead, line: String(h.line).slice(0, 164), verdict: h.verdict as ClockHitVerdict })),
        ].slice(0, 6),
      };
    }
    if (futureHits.length) {
      const { chatId, userId } = input;
      const nowIso = futureClockNow.toISOString();
      const hitLines = futureHits
        .map((h) => `- "${h.token}" — ${h.minutesAhead} min ahead of this run's real clock (${nowIso}) — in: "${h.line}"`)
        .join('\n');
      // (ticket b216475a) DETERMINISTIC ticket-citation check rides the clock
      // strike: this block EARLY-RETURNS before computePhantomClaims, so a note
      // carrying BOTH a future clock AND fabricated `ticket <id>` citations
      // (ca59c504: the 17:40Z headline + four invented ticket ids) had its
      // clock convicted while the ids were never named — the next wake
      // re-emitted them (3e5775d4). Mine + existence-check the citations HERE
      // (deterministic only — NEVER the LLM matcher in the clock lane) so the
      // notice/correction/reject-back name them, the returned phantoms carry
      // them to the seam's telemetry, and the citation-enforce branch treats
      // the combined strike as citation-class.
      const ticketPhantoms = await findPhantomTicketCitations(
        input.finalText.slice(0, NOTE_SLICE), [], userId, undefined,
        (id) => samePrefixRealIds('ticket', id, userId),
        [...toolResultTextsFromParts(input.parts), ...(input.extraEvidenceHaystacks ?? [])],
      );
      if (ticketPhantoms.length) {
        logger.warn(`action-verifier: future-clock strike in chat ${chatId.slice(0, 8)}'s note ALSO carries ${ticketPhantoms.length} fabricated ticket citation(s) — named in the strike surfaces (ticket b216475a; the clock lane's early-return no longer swallows them)`, { source: 'action-verifier', chatId });
      }
      // Ticket cdd3fbfe (owner directive 2026-08-30, verbatim: "unproven
      // action/observation claims must block the final answer at commit
      // (fail-closed), not post-hoc strike"): EVERY future-observation
      // conviction — action-keyworded or not — is a full pre-delivery
      // replacement. This SUPERSEDES ticket 80dd882d's warn-inline
      // CLOCK_WARN_BANNER class for keyword-free notes: the warn lane kept
      // DELIVERING impossible observation clocks (fleet-integrity ticket
      // 9baaba8d, 7 occurrences), and the blockquoted original preserves the
      // note's real work for audit without delivering it as fact.
      // build 2026-10-08 Q-3: under the clock policy the note is DELIVERED AS WRITTEN with one trailing
      // annotation (the W1-4 rule for every strike), and a CLOCK-ONLY strike is never rejected back for a
      // re-orchestration — its ticket fires now. Co-riding fabricated ticket citations keep the reject-back.
      const annotateClock = clockPolicyOn;
      const deferClock = input.deferConsequences === true && (!clockPolicyOn || ticketPhantoms.length > 0);
      // (tickets 4c7aebf7 + 9a976d83) a struck-note repeat's reject-back is coming: the ticket waits for pass 2.
      const deferClockTicket = deferClock || (input.deferConsequences === true && input.deferClockTicket === true);
      logger.warn(`action-verifier: PRE-DELIVERY future-clock strike — ${futureHits.length} impossible observation timestamp(s) in chat ${chatId.slice(0, 8)}'s note; ${annotateClock ? 'delivered as written with an observe-only annotation' : 'the final note was replaced before delivery'}`, { source: 'action-verifier', chatId });
      const notice = [
        ACTION_GUARD_BANNER,
        `This machine-triggered run's final note asserted observation(s) timestamped in the FUTURE — the cited clock reading(s) are later than this run's real clock (${nowIso}), so the observation(s) cannot have happened. Struck impossible timestamp(s):\n${hitLines}`,
        'Any conclusion premised on the struck timestamp(s) is UNVERIFIED — never restate it as fact; re-run the observation against the real clock (a fresh tool result) before believing it.',
        // (ticket b216475a) name the co-riding fabricated ticket citations.
        ...(ticketPhantoms.length
          ? [`Fabricated ticket citation(s) also found (existence-checked — no such row): ${ticketPhantoms.map((p) => p.id).join(', ')} — treat them as UNVERIFIED.`]
          : []),
        "The run's original note is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
      ].join('\n');
      const quoted = input.finalText.split('\n').map((l) => `> ${l}`).join('\n');
      const clockAnnotation = annotateClock
        ? [
            ACTION_GUARD_ANNOTATION_HEADER,
            `This note was delivered as written. ${futureHits.length} clock reading(s) in it are written as observations but read LATER than this run's real clock (${nowIso}) — an observation cannot be in the future:`,
            futureHits.map((h) => `- "${h.token}" — ${h.minutesAhead} min ahead — in: "${h.line}"`).join('\n'),
            ...(ticketPhantoms.length ? [`Ticket citation(s) the integrity check could not find: ${ticketPhantoms.map((p) => p.id).join(', ')}.`] : []),
            'Treat those lines as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
          ].join('\n')
        : '';
      const finalText = annotateClock
        ? `${String(input.finalText ?? '').replace(/\s+$/, '')}\n\n${clockAnnotation}`
        : [
            notice,
            '--- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---',
            quoted,
            '--- END STRUCK NOTE ---',
          ].join('\n\n');
      const { fileFeedbackTicket } = await import('../feedback/feedback.service');
      // Reject-back pre-pass (ba65163d / aac649ba): deferConsequences defers
      // the ticket — the seam re-orchestrates ONCE with rejectBackNotice in
      // context; a still-convicted retry is re-guarded with the flag OFF and
      // the ticket fires then, on the final answer.
      if (!deferClockTicket) {
      await fileFeedbackTicket({
        userId,
        type: 'mishap',
        title: `Phantom observation clock: machine note cites future timestamp(s) (chat ${chatId.slice(0, 8)})`,
        description: `A machine-triggered run's final note cited observation clock(s) LATER than the run's real clock (${nowIso}) — an observation of the future is impossible, so the note was fabricated (ticket 375c8618 class: deploy/restart-interrupted runs inventing clock evidence).\n\nStruck timestamp(s):\n${hitLines}\n\nNote excerpt:\n${input.finalText.slice(0, 1500)}\n\n${annotateClock ? 'Pre-delivery strike (guardMachineWakeFinalAnswer, observe-only — build 2026-10-08 Q-3): only clocks written as observations convict; the note was DELIVERED AS WRITTEN with a trailing annotation naming them; nothing was removed.' : 'Pre-delivery strike (guardMachineWakeFinalAnswer): the note was REPLACED before it reached the thread; the original survives as a quoted audit block.'}`,
        priority: 3,
        area: 'fleet-integrity',
        // containedPreDelivery (ticket aac649ba): the note was REPLACED before
        // delivery — contained recidivism, not an escape; sightings counter-bump
        // a done ticket instead of reopening it (65239c9a reopened once on the
        // same unmarked-strike churn before this marker existed).
        context: { sessionId: chatId, surface: 'chat', verifier: 'action-verifier', filedAt: nowIso, containedPreDelivery: true, ...(annotateClock ? { deliveredAnnotated: true } : {}) },
      }).catch((err: any) => logger.warn(`action-verifier: future-clock ticket filing failed: ${err?.message}`, { source: 'action-verifier' }));
      }
      // The reject-back notice (model context — CHROME RULE: no guard banners):
      // names the struck clocks in the self-exempting quoted shape (the re-run
      // must be able to echo them without re-convicting) and restates the
      // clock contract at the moment of failure.
      const rejectBackNotice = deferClock
        ? [
            '[HARNESS NOTICE — not typed by the user] The integrity check REJECTED your previous answer before delivery — it was NOT posted. It cited observation clock(s) LATER than that attempt\'s real clock — impossible observations:',
            futureHits.map((h) => `> - struck "${h.token}" — ${h.minutesAhead} min ahead of that attempt's real clock (${nowIso}) — in: "${h.line}"`).join('\n'),
            'Rewrite the note: copy every "now"/"as of" clock VERBATIM from a clock printed THIS run (the wake line or a fresher tool-printed clock — run date -u again if you need one) — never project the note\'s landing time and never add estimated elapsed minutes to the wake clock. A genuine forward reference is legal ONLY with an explicit future label on the same line ("next fire …", "ETA ~…", "watch for …"); a past event whose time-of-day reads later than now must carry its date or a past word ("yesterday"). Re-run any observation you need with a real tool call NOW and cite the fresh result — anything you cannot verify this run is "attempted, unverified", not fact.',
            // (ticket b216475a) the retry must know the co-riding ticket ids
            // are fabricated — name them so they are never re-cited.
            ...(ticketPhantoms.length
              ? [`Fabricated ticket citation(s) also found in the rejected answer (existence-checked — no such row): ${ticketPhantoms.map((p) => p.id).join(', ')} — these ticket ids exist nowhere — never re-cite them. A ticket id is legal ONLY copied VERBATIM from a file_feedback/list_feedback tool result THIS run; where you did not capture one, write (id not captured).`]
              : []),
          ].join('\n')
        : undefined;
      // The in-thread correction bubble (ticket a688ba29 — the clock lane's
      // 51ed3a65 recurrence hole): the persisted replacement is swapped for a
      // GENERIC placeholder when stored rows reload as model context
      // (guard-chrome redaction), so a struck run's next wake saw no specifics
      // and re-offended — five sightings / two auto-reopens on chat c0e22e36
      // (two projected headline "now" clocks, a "fired"-before-fire-time
      // claim, two unlabeled forward schedule references). The correction
      // names the struck timestamp(s)/line(s) and restates the rule-8
      // contract at the moment of failure. The seam injects it as a user-role
      // harness message (survives redaction by role gate) AFTER the
      // replacement row persists — same wiring as the action-phantom lane.
      // The struck-clock lines are shaped SELF-EXEMPTING (adversarial review
      // F1): '> '-prefixed (the quoted-void citation lane, ticket 80dd882d —
      // the correction's own "struck"/"UNVERIFIED" vocabulary supplies the
      // void context) AND carrying the past-reference word "earlier"
      // (PAST_REFERENCE_RE) — a next wake quoting the correction verbatim
      // convicts NONE of its clocks, where the raw hitLines shape re-struck
      // 6 tokens at +5m within minutes of the strike (and again next-day).
      // The notice/ticket keep the raw hitLines shape (authored and read in
      // the striking run's frame); the correction is read in LATER runs, so
      // its lines say "that run's real clock".
      const correctionHitLines = futureHits
        .map((h) => `> - struck "${h.token}" — ${h.minutesAhead} min ahead of that run's real clock (${nowIso}), an earlier run's impossible clock — in: "${h.line}"`)
        .join('\n');
      const correction = [
        `[ACTION VERIFIER — automated integrity check] Your last status note was ${annotateClock ? 'DELIVERED AS WRITTEN with an observe-only annotation (nothing in it was removed or changed)' : 'WITHHELD before delivery'}: it asserted observation(s) timestamped in the FUTURE — clock reading(s) later than that run's real clock (${nowIso}), so the observation(s) cannot have happened:`,
        correctionHitLines,
        'Clock discipline (machine-wake rule 8): a "now" clock (your headline, "as of <time>", "at <time> I saw …") must be copied from a clock printed THIS run (the per-turn [HARNESS CLOCK] note — re-injected before every model call — else the wake line or a fresher tool-printed clock) — never project the note\'s landing time, never add estimated run duration to the wake clock, never promote a schedule\'s next-fire time into a "now", and never claim a scheduled event fired before its fire time. A genuine FORWARD reference is legal ONLY with an explicit future label on the same line ("next fire …", "ETA ~…", "hourly tick …", "watch for …", "… future"); a clock citing a PAST event whose time-of-day reads later than now must carry its date ("merged_at 2026-08-30T20:38Z") or a past word ("yesterday", "last night"). Any conclusion premised on the struck timestamp(s) is UNVERIFIED — never restate it as fact; re-run the observation against a fresh tool-printed clock before believing it.',
        // (ticket b216475a) name the co-riding fabricated ticket citations so
        // the next wake never re-emits them (3e5775d4 did, pre-fix).
        ...(ticketPhantoms.length
          ? [`Fabricated ticket citation(s) also found (existence-checked — no such row): ${ticketPhantoms.map((p) => p.id).join(', ')} — these ticket ids exist nowhere; never re-cite them. Cite a ticket id ONLY copied verbatim from a file_feedback/list_feedback tool result from THIS run — where you did not capture one, write (id not captured) instead.`]
          : []),
      ].join('\n');
      return { finalText, notice: annotateClock ? clockAnnotation : notice, struck: true, phantoms: ticketPhantoms, correction, audited: true, futureClocks: futureHits, ...(annotateClock ? { delivery: 'annotated' as const } : {}), ...(rejectBackNotice ? { rejectBackNotice } : {}) };
    }

    const supervisor = input.supervisor === true;
    // The cheap pre-gates: the shared action-claim keyword scan, OR (ticket
    // f1cb73ff) the session/chat-reference idiom scan — an owner-item chat
    // ref ("reply in chat <id>") carries none of the action keywords, and
    // widening ACTION_CLAIM_KEYWORD_RE itself just runs the LLM matcher on
    // claim-free notes (wasted coin flips) — OR (ticket 65239c9a review B1)
    // the schedule-citation idiom scan: the (a2) clock
    // lane now EXONERATES sched-ledger lines (SCHED_ARTIFACT_LINE_RE), so a
    // citation-carrying note must always reach the existence lane below — an
    // invented id co-located with a future fire-time clock otherwise escapes
    // every audit on a keyword-free non-supervisor wake ("sched <id>" is no
    // ACTION_CLAIM_KEYWORD_RE word: that list keys on schedul(?:ed|es|ing),
    // never the abbreviated artifact label). All scans are regex-only.
    // (ticket a235fbd6) hasActionClaimKeywords now ALSO routes staging
    // narration (STAGING_CLAIM_IDIOM in executed-actions.ts). The "must NOT
    // widen" line above predates that idiom's own exoneration tier; the
    // widening is deliberate there because a staging claim with no
    // co-occurring keyword otherwise skips the audit entirely — the incident.
    if (!supervisor && !hasActionClaimKeywords(input.finalText) && !hasSessionChatRefIdiom(input.finalText) && !hasScheduleCitationIdiom(input.finalText) && !hasVanishedArtifactIdiom(input.finalText)) return pass;

    const comp = await computePhantomClaims(input);
    if (!comp.phantoms.length) return { ...pass, audited: true }; // audited clean — the seam stands the post-delivery lane down (ticket fc337153 single-audit)

    const { chatId, userId } = input;
    const { note } = comp;
    const chat8 = chatId.slice(0, 8);
    // MIXED-STRIKE scoping (fleet 17:14Z incident, 2026-09-15): under
    // consequenceScope 'citation-only' a verdict carrying BOTH deterministic
    // convictions (citation-class / fabricated-id) and coin-flip ACTION
    // convictions is enforced on its deterministic subset — the action-class
    // rest rides back as `observedPhantoms` for the seam's 'observed' row
    // (delivered, recorded, never redacted — the 2026-09-11 flip). Before this
    // the seam gated enforcement on EVERY conviction being citation-class, so
    // one co-riding action phantom delivered the whole fabricated set
    // unmodified. An ALL-action verdict keeps the f16cc02a shape untouched:
    // struck with the redaction computed, consequences suppressed below.
    let phantoms: ExtractedClaim[] = comp.phantoms;
    let observedPhantoms: ExtractedClaim[] = [];
    if (input.consequenceScope === 'citation-only') {
      const enforceable = phantoms.filter(isCitationClassClaim);
      if (enforceable.length && enforceable.length < phantoms.length) {
        observedPhantoms = phantoms.filter((p) => !isCitationClassClaim(p));
        phantoms = enforceable;
        logger.info(`action-verifier: mixed strike in chat ${chat8} — enforcing ${phantoms.length} deterministic conviction(s), ${observedPhantoms.length} action-class conviction(s) observed only`);
      }
    }
    const fabricatedActionIds = phantoms.some((p) => p.fabricatedId === true);
    const detailLines = claimDetailLines(phantoms);
    // (c-redact) Strip+mark (tickets 5e1ca207 / e66950c1): when EVERY
    // conviction is an id-bearing, note-locatable claim, deliver the note
    // with the convicted lines elided 1:1 instead of wholesale-replacing it —
    // 19+ withheld supervisor notes destroyed valid fleet triage content
    // along with the fabrication (the f8d68167 / 45edaf25 fail-soft doctrine,
    // applied to the action-phantom lane). Fail closed to full replacement on
    // any id-less / args-sourced / unlocatable conviction, >50% gutted, or
    // zero survivors. The future-clock lane (a2) is untouched — owner
    // directive cdd3fbfe keeps full replacement there.
    const redactedNote = tryRedactNoteLines(note, phantoms);
    // (audit 2026-10-08 W1-4 — supervisors F5) An owner-facing note is NEVER edited by the harness:
    // the strip+mark lane deleted a TRUE line ("push `2b7bc8a` verified on origin" — a real sha
    // the LLM extractor called a ticket). The note is delivered AS WRITTEN with one trailing
    // observe-only annotation naming the unverified claim(s); the correction row, the ticket and
    // the reject-back still run. Kill switch OWNER_NOTE_NO_EDIT_DISABLED=1 restores strip+mark /
    // replacement.
    const annotateOnly = !ownerNoteNoEditDisabled();
    // (ticket 336f3d38) The PRE-DELIVERY warn must state the ACTUAL delivery
    // mode, not the pre-W1-4 one: the incident's telemetry row read "the
    // final note was replaced before delivery" while the W1-4 default had
    // delivered the supervisor's note AS WRITTEN with an observe-only
    // annotation (the live ticket's context carried deliveredAnnotated:true
    // and the fabricated citations reached the peer lane, which refuted them
    // and cost a window cycle). An operator reading app_error_logs to answer
    // "did the struck content reach the fleet?" got the wrong answer.
    //   (cross-review F1) The annotated phrase itself must ALSO be scoped to
    // the verdict class the seam actually delivers it for: the machine-wake
    // seam (chat-agent.service.ts) delivers the guard's annotated/redacted
    // text ONLY for citation-class strikes (or under ACTION_VERIFIER_ENFORCE=1);
    // an ACTION-class strike under the default falls through BOTH delivery
    // blocks — the ORIGINAL note is delivered unmodified, no annotation
    // appended (:5673 "observed only … note delivered unmodified"). The same
    // holds for the f16cc02a class flip (consequencesSuppressed below). The
    // warn must never claim an annotation that was never appended — the
    // mirror-image of the "never reached" error this ticket fixed. Content
    // direction is unchanged (the note DID reach the thread either way); only
    // the containment claim is scoped to what actually happens.
    const citationClassVerdict = allCitationClassClaims(phantoms);
    const deliveryPhrase = annotateOnly
      ? (process.env.ACTION_VERIFIER_ENFORCE === '1' || citationClassVerdict
          ? 'the note was delivered as written with an observe-only annotation (audit 2026-10-08 W1-4)'
          // ACTION-class strike under the default: the seam will NOT enforce
          // this verdict — the original note is delivered unmodified and the
          // seam's 'observed' guard_strike row is the record (f16cc02a
          // doctrine: never claim a containment that never happened).
          // BRIEFING-UNVERIFIED-FILTER (2026-10-20): on a SUPERVISOR wake the
          // seam now appends a trailing observe-only footnote naming the
          // id-less action claims it can locate in the note (nothing removed)
          // — the warn says so, CONDITIONALLY (review fix: a claim that does
          // not locate, or cites an action receipt of this chat, gets none —
          // never claim an annotation that may not happen);
          // ACTION_CLASS_ANNOTATE_DISABLED=1 restores the no-annotation
          // phrase with the behaviour.
          : supervisor && !actionClassAnnotateDisabled()
          ? 'the note was delivered AS WRITTEN (observe-only — the seam will not enforce this verdict; nothing is removed, and its id-less action claims that locate in the note and cite no action receipt of this chat may get a trailing footnote at finalize — BRIEFING-UNVERIFIED-FILTER)'
          : 'the note was delivered UNMODIFIED (observe-only — the seam will not enforce this verdict; the struck content reached the thread as written, no annotation appended)')
      : redactedNote !== null
      ? 'the note was delivered with the struck line(s) removed (strip+mark)'
      : 'the final note was replaced before delivery';
    // (reviewer F3, ticket 336f3d38) Under deferConsequences (the reject-back
    // pre-pass, chat-agent.service.ts:5350) this warn fires on pass 1 BEFORE
    // the seam decides delivery: on a reject-back the attempt is NOT posted
    // and a clean retry's text supersedes it. The record must not over-claim
    // in the "content reached the thread" direction on that path — the
    // mirror-image of the old phrase's "never reached" error. The delivery
    // phrase stays exact for the non-deferred path (the guard's own seam).
    const deferredDeliveryPhrase = input.deferConsequences
      ? `${deliveryPhrase} unless the reject-back supersedes it (deferred-consequences pass — the retry's clean text replaces this attempt)`
      : deliveryPhrase;
    // (FO firing 57) The strike's EVIDENCE rides the warn context: the class
    // detail (kind / claim text / cited id / near-miss real ids) is what the
    // operator needs to adjudicate verifier false-positive vs real phantom —
    // the notice carries it to the thread, but before this the ONLY durable
    // record was "N phantom claim(s)" + {chatId}. 10 blind strikes/24h.
    logger.warn(`action-verifier: PRE-DELIVERY strike — ${phantoms.length} phantom claim(s) in ${supervisor ? 'supervisor' : 'chat'} ${chat8}'s note; ${deferredDeliveryPhrase}`, { source: 'action-verifier', chatId: chat8, claims: claimAuditExcerpts(phantoms) });

    // (c) The delivered final text. Strip+mark lane: honest harness notice on
    // top (naming the struck kinds/ids) + the note with convicted lines
    // elided 1:1. Full-replacement lane: the notice + the original
    // blockquoted below as audit-only. Citation-only strikes name the true
    // failure class (ticket 5e1ca207): fabricated EVIDENCE ids, not
    // unexecuted actions.
    const citationOnly = allCitationClassClaims(phantoms);
    // (ticket e4138a3d) Board-status-only strike: the owner-facing notice must
    // not say "ids DO NOT EXIST" — the cited row is REAL and only the asserted
    // status contradicts the ledger.
    const boardStatusOnly = citationOnly && allBoardStatusClaims(phantoms);
    // (ticket 7ea4819b) Miscopy-only strike: same doctrine — the notice must
    // say MISCOPED (observed, then mistranscribed), never "fabricated"; the
    // backing action DID run.
    const miscopyOnly = citationOnly && !boardStatusOnly && allMiscopiedClaims(phantoms);
    // (ticket c5629165) Misattributed-filing-only strike: same doctrine — the
    // notice must say the tickets are REAL and only the AUTHORSHIP was
    // claimed, never "call the tool" (that would duplicate a real filing).
    const misattributedOnly = !citationOnly && allMisattributedFilingClaims(phantoms);
    const notice = redactedNote !== null
      ? [
          ACTION_GUARD_REDACT_BANNER,
          boardStatusOnly
            ? `This machine-triggered run's final note asserted board status(es) that CONTRADICT the ledger — every cited id is REAL (the row exists), but the asserted status disagrees with the row's ledger status. The line(s) carrying the contradicted assertion(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck board assertion(s):\n${detailLines}`
            : miscopyOnly
            ? `This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id this run's own tool result envelope actually carried: miscopied, not invented. The line(s) carrying the miscited id(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck miscited citation(s):\n${detailLines}`
            : misattributedOnly
            ? `This machine-triggered run's final note claimed to have FILED ticket(s) this run never filed — every cited ticket EXISTS (the ids are real, read via get_feedback / list_feedback), but the filings were another session's and/or predate this run. The line(s) carrying the misattributed filing claim(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck misattributed filing claim(s):\n${detailLines}`
            : citationOnly
            ? `This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST — database existence-checked, no such row. The line(s) carrying the fabricated citation(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck fabricated citation(s):\n${detailLines}`
            : `This machine-triggered run's final note claimed action(s) that did NOT execute — no matching successful tool call exists in this run's log. The line(s) carrying the struck claim(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck phantom claim(s):\n${detailLines}`,
          boardStatusOnly
            ? 'The struck assertion(s) mis-stated board state — the rows are real; treat any status claim resting on them as UNVERIFIED until re-pulled from a fresh ledger read (the [BOARD] block or goal_list / todo_list).'
            : miscopyOnly
            ? 'The struck citation(s) were MISCOPED from real this-run result envelopes — the real id is named per line above and the backing action DID run; re-cite it verbatim from the result envelope, and never retype an id from memory.'
            : misattributedOnly
            ? 'The struck filing claim(s) misattributed AUTHORSHIP — the tickets are real and the ids honest (read via get_feedback / list_feedback), but this run never called file_feedback for them: do NOT re-file (that would duplicate a real ticket); re-attribute or drop the claim.'
            : citationOnly
            ? 'The struck citation(s) are fabricated — the ids exist nowhere; treat any claim resting on them as UNVERIFIED until re-pulled from a fresh tool result.'
            : 'The struck claim(s) are NOT done. Never restate them as done; re-verify against fresh tool evidence (a real {ok:true, ids:{...}} result envelope or a run_tool_receipts row) before believing them.',
        ].join('\n')
      : [
          ACTION_GUARD_BANNER,
          boardStatusOnly
            ? `This machine-triggered run's final note asserted board status(es) that CONTRADICT the ledger — every cited id is REAL (the row exists), but the asserted status disagrees with the row's ledger status. Struck board assertion(s):\n${detailLines}`
            : miscopyOnly
            ? `This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id this run's own tool result envelope actually carried: miscopied, not invented. Struck miscited citation(s):\n${detailLines}`
            : misattributedOnly
            ? `This machine-triggered run's final note claimed to have FILED ticket(s) this run never filed — every cited ticket EXISTS (the ids are real, read via get_feedback / list_feedback), but the filings were another session's and/or predate this run. Struck misattributed filing claim(s):\n${detailLines}`
            : citationOnly
            ? `This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST — database existence-checked, no such row. Struck fabricated citation(s):\n${detailLines}`
            : `This machine-triggered run's final note claimed action(s) that did NOT execute — no matching successful tool call exists in this run's log. Struck phantom claim(s):\n${detailLines}`,
          boardStatusOnly
            ? 'The struck assertion(s) mis-stated board state — the rows are real; treat any status claim resting on them as UNVERIFIED until re-pulled from a fresh ledger read (the [BOARD] block or goal_list / todo_list).'
            : miscopyOnly
            ? 'The struck citation(s) were MISCOPED from real this-run result envelopes — the real id is named per line above and the backing action DID run; re-cite it verbatim from the result envelope, and never retype an id from memory.'
            : misattributedOnly
            ? 'The struck filing claim(s) misattributed AUTHORSHIP — the tickets are real and the ids honest (read via get_feedback / list_feedback), but this run never called file_feedback for them: do NOT re-file (that would duplicate a real ticket); re-attribute or drop the claim.'
            : citationOnly
            ? 'The struck citation(s) are fabricated — the ids exist nowhere; treat any claim resting on them as UNVERIFIED until re-pulled from a fresh tool result.'
            : 'The struck claim(s) are NOT done. Never restate them as done; re-verify against fresh tool evidence (a real {ok:true, ids:{...}} result envelope or a run_tool_receipts row) before believing them.',
          "The run's original note is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
        ].join('\n');
    const editedText = redactedNote !== null
      ? [notice, redactedNote].join('\n\n')
      : [
          notice,
          '--- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---',
          note.split('\n').map((l) => `> ${l}`).join('\n'),
          '--- END STRUCK NOTE ---',
        ].join('\n\n');
    // (audit 2026-10-08 W1-4 — supervisors F5) An owner-facing note is NEVER edited by the harness:
    // the strip+mark lane deleted a TRUE line ("push `2b7bc8a` verified on origin" — a real sha
    // the LLM extractor called a ticket). The note is delivered AS WRITTEN with one trailing
    // observe-only annotation naming the unverified claim(s); the correction row, the ticket and
    // the reject-back still run. Kill switch OWNER_NOTE_NO_EDIT_DISABLED=1 restores strip+mark /
    // replacement.
    // (annotateOnly + deliveryPhrase were computed above, before the warn — ticket 336f3d38.)
    const annotation = annotateOnly ? renderObserveOnlyAnnotation(phantoms, { citationOnly, boardStatusOnly, miscopyOnly, misattributedOnly }, input.harnessStripped) : '';
    const finalText = annotateOnly ? `${String(input.finalText ?? '').replace(/\s+$/, '')}\n\n${annotation}` : editedText;
    const deliveredNotice = annotateOnly ? annotation : notice;

    // (d) The post lane's consequences: the shared deduped ticket + (for
    // supervisors) the durable state-doc refutation. The in-thread correction
    // bubble is NOT injected from here — the seam inserts it AFTER the
    // replacement assistant row persists (the correction's "your last status
    // note" must read chronologically); it rides back on the result below as
    // `correction` (ticket 51ed3a65).
    // Reject-back pre-pass (ba65163d / aac649ba): deferConsequences defers
    // the ticket + durable refutation — the seam re-orchestrates ONCE with
    // rejectBackNotice in context; a still-convicted retry is re-guarded with
    // the flag OFF and the consequences fire then, on the final answer.
    // CLASS-FLIP suppression (ticket f16cc02a): the citation-enforce seam's
    // second pass runs with consequenceScope 'citation-only'. When the
    // STANDING verdict flipped ACTION-class, that seam deliberately delivers
    // the note UNMODIFIED (the 2026-09-11 observe-only flip) — a ticket fired
    // here would claim strip+mark containment ("the struck claim line(s)
    // never reached the thread", containedPreDelivery/deliveredRedacted) that
    // never happens. Suppress the consequences for the verdict class the
    // caller will not enforce; the seam's 'observed' guard_strike row remains
    // the record (the same doctrine a FIRST-pass action-class strike gets).
    const consequencesSuppressed = input.consequenceScope === 'citation-only' && !citationOnly;
    if (consequencesSuppressed) {
      logger.info(`action-verifier: consequence scope 'citation-only' — standing verdict is ACTION-class, suppressing the ticket + refutation for ${chat8} (the seam records the observed-only row and delivers unmodified; ticket f16cc02a)`);
    }
    if (!input.deferConsequences && !consequencesSuppressed) {
      await filePhantomTicket({
        chatId, userId, supervisor, supervisorScope: comp.supervisorScope, machineTriggered: true,
        phantoms, executed: comp.executed, crossWakeExonerated: comp.crossWakeExonerated, note,
        preDelivery: true,
        delivery: annotateOnly ? 'annotated' : redactedNote !== null ? 'redacted' : 'replaced',
      });
      if (comp.appendRefutation) {
        await comp.appendRefutation(chatId, userId, refutationDetail(phantoms)).catch(() => {});
      }
    }

    // (e) The in-thread correction text (ticket 51ed3a65) — the post-delivery
    // lane's correction wording, adapted: this note was WITHHELD before
    // delivery. Originally the pre-delivery lane injected no bubble ("the
    // replacement IS the correction"), but guard-chrome redaction swaps the
    // persisted replacement for a GENERIC placeholder in model context, so
    // the next wake saw no specifics — the recurrence hole behind 51ed3a65.
    // The user-role harness message survives redaction by role gate
    // (guard-chrome-redact.test.ts pins that survival).
    const correctionBody = redactedNote !== null || annotateOnly
      ? [
          boardStatusOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was DELIVERED with its unproven claim line(s) REMOVED (strip+mark): it asserted board status(es) that CONTRADICT the ledger — every cited id below is REAL (the row exists), but the asserted status disagrees with the row\'s ledger status:'
            : miscopyOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was DELIVERED with its unproven claim line(s) REMOVED (strip+mark): it cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id THIS RUN\'s tool result envelope actually carried (miscopied, not invented; the real id is named per line below):'
            : misattributedOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was DELIVERED with its unproven claim line(s) REMOVED (strip+mark): it claimed to have FILED ticket(s) this run never filed — every cited ticket EXISTS (you READ the ids via get_feedback / list_feedback), but the filings were another session\'s and/or predate this run:'
            : citationOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was DELIVERED with its unproven claim line(s) REMOVED (strip+mark): it cited evidence id(s) that DO NOT EXIST (database existence-checked — a real row would have exonerated them):'
            : '[ACTION VERIFIER — automated integrity check] Your last status note was DELIVERED with its unproven claim line(s) REMOVED (strip+mark): it claimed action(s) that did NOT execute (no matching successful tool call in that run):',
          detailLines,
          correctionAdvice(citationOnly, fabricatedActionIds, boardStatusOnly, miscopyOnly, misattributedOnly),
        ].join('\n')
      : [
          boardStatusOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it asserted board status(es) that CONTRADICT the ledger — every cited id below is REAL (the row exists), but the asserted status disagrees with the row\'s ledger status:'
            : miscopyOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id THIS RUN\'s tool result envelope actually carried (miscopied, not invented; the real id is named per line below):'
            : misattributedOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it claimed to have FILED ticket(s) this run never filed — every cited ticket EXISTS (you READ the ids via get_feedback / list_feedback), but the filings were another session\'s and/or predate this run:'
            : citationOnly
            ? '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it cited evidence id(s) that DO NOT EXIST (database existence-checked — a real row would have exonerated them):'
            : '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it claimed action(s) that did NOT execute (no matching successful tool call in that run):',
          detailLines,
          correctionAdvice(citationOnly, fabricatedActionIds, boardStatusOnly, miscopyOnly, misattributedOnly),
        ].join('\n');
    // (audit 2026-10-08 W1-4) observe-only delivery: the correction says what really happened.
    const correction = annotateOnly
      ? correctionBody.replace(/DELIVERED with its unproven claim line\(s\) REMOVED \(strip\+mark\)/g, 'DELIVERED AS WRITTEN with an observe-only annotation (nothing in it was removed or changed)')
      : correctionBody;

    // The reject-back notice (model context — CHROME RULE: no guard banners):
    // names the struck claims and restates the citation contract at the
    // moment of failure. The re-orchestrated run may make FRESH tool calls —
    // it is told to verify NOW and cite only what a tool result shows.
    // F1 wording (owner 2026-09-04, CV0904 citation-strike root cause): the
    // notice now teaches the "(id not captured)" escape hatch at the moment of
    // failure — the exact doctrine machine-wake rule 6 and the supervisor
    // prompt carry — so the ONE bounded retry has a legal way to keep every
    // true fact whose id it never saw. Pinned phrases ('VERBATIM in a tool
    // result from THIS run', 'attempted, unverified') are load-bearing tests.
    // Retry v2 (owner review 2026-09-06 — two days of citationRetry telemetry
    // showed 24 clean vs 21 still_dirty): the retry is now a LOOKUP, not a
    // recall test — the notice lists the ids ACTUALLY visible in the attempt's
    // tool outputs (outputs only, same anti-laundering rule as the exoneration
    // tier), so the rewrite copies from the list instead of re-inventing.
    const visibleIds = input.deferConsequences
      ? Array.from(new Set(
          toolResultTextsFromParts(input.parts)
            .flatMap((t) => t.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}\b/gi) ?? [])
            .filter((id) => /\d/.test(id))
            .map((id) => id.slice(0, 8).toLowerCase()),
        )).slice(0, 20)
      : [];
    const rejectBackNotice = input.deferConsequences
      ? [
          '[HARNESS NOTICE — not typed by the user] The integrity check REJECTED your previous answer before delivery — it was NOT posted. These claims had no matching successful tool call in that attempt\'s log, or cited evidence id(s) that exist nowhere (database existence-checked):',
          detailLines,
          'Rewrite your ENTIRE note now: cite an id ONLY when you can see it VERBATIM in a tool result from THIS run (list_chats / get_chat_messages / list_schedules / schedule_get / a receipt envelope) — copy it at the moment of reading, never reconstruct one from memory or from your own earlier notes. Where you did not capture an id, write (id not captured) instead — that is ALWAYS acceptable and never penalized; an invented id never is. For an action you cannot evidence, drop the claim or mark it "attempted, unverified". Make the fresh tool calls you need NOW, then answer from their results. Do not mention this check in the note.',
          ...(visibleIds.length > 0
            ? [`For reference, id prefixes ACTUALLY visible in that attempt's tool results (cite ONLY from these or from fresh tool calls, or write (id not captured)): ${visibleIds.join(', ')}.`]
            : []),
        ].join('\n')
      : undefined;

    return { finalText, notice: deliveredNotice, struck: true, phantoms, correction, audited: true, ...(annotateOnly ? { delivery: 'annotated' as const } : {}), ...(rejectBackNotice ? { rejectBackNotice } : {}), ...(observedPhantoms.length ? { observedPhantoms } : {}) };
  } catch (err: any) {
    // (f) Fail-open: a guard failure must never break or blank a delivery.
    logger.warn(`action-verifier: pre-delivery guard failed (fail-open — original note kept): ${err?.message}`, { source: 'action-verifier' });
    return pass;
  }
}
