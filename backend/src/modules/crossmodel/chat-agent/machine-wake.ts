import { modelToolName } from '../coding/tool-scope';

/** metadata.kind stamped on the ASSISTANT row of an owner-armed schedule
 *  firing's turn (ticket 77c3a7e9, owner 2026-09-25: "the digest I asked for
 *  gets buried in accordion style as a machine message"): the digest ANSWER is
 *  delivered content the owner asked to receive, not internal wake noise — it
 *  renders as a NORMAL visible assistant bubble. The 2026-09-03 whole-turn
 *  collapse directive stays intact for every non-digest machine turn; only the
 *  answer row is exempted (the wake envelope and verifier chrome stay folded).
 *  Stamped by chat-agent.service finalize when scheduleOwnerArmed &&
 *  messageOrigin 'schedule'; exempted frontend-side (machine-turn-grouping
 *  isOwnerDigest) and in the fleet thread classifier (fleet.service
 *  classifyThreadRows), byte-parity with the OWNER_BRIEFING_KIND precedent
 *  (fleet/owner-briefing.service). Kept in this leaf module so both
 *  chat-agent.service and fleet.service import it without a cycle. */
export const OWNER_DIGEST_KIND = 'owner_digest';
/**
 * Machine-triggered chat runs (schedule firings + hook wakes on plain chats) —
 * the freshness preamble prepended to their prompt.
 *
 * Why this exists (fleet-supervisor postmortem, 2026-08-11 — tickets 7739f1d8 /
 * 62799318 / 566e1c5f, docs/ONE_SESSION_PLATFORM.md Part 1): a detached chat run
 * reconstructs "now" and fleet state from its truncated transcript (last ~8
 * messages, assistant notes capped at 2400 chars, prior tool calls invisible).
 * The result was clock fabrication (reporting a firing as "landed" 54 min before
 * it could happen), fossilized owner-asks repeated for hours after they were
 * resolved, and actions taken on mid-word-truncated event digests. The coding
 * tier solves this with worktree state files + a self-audit contract; the chat
 * tier gets the cheap 80% version: ground "now" deterministically and put the
 * freshness rules in the one place the model always reads — the trigger itself.
 *
 * Kept in a leaf module (no imports) so it is unit-testable without pulling in
 * the chat-agent service's import graph (config/env exits at import in jest).
 *
 * SLIM (R&D stream 3, test-bench experiment #1, 2026-09-18): the prompt text was
 * compressed ~32% (8304 → ~5.6k chars) by removing redundancy and moving the
 * incident archaeology OUT of the per-wake text (every machine wake pays for
 * it). SEMANTICS ARE UNCHANGED — every rule below survives with its teaching
 * vocabulary intact (the action-verifier drift guards in
 * platform/action-verifier.test.ts run the FULL preamble through the detectors,
 * and machine-wake.test.ts pins the taught tokens). Incident lineage, kept here
 * for archaeology instead of billing it per wake:
 *   rule 1 — zero-tool gate honesty (spark B30; observe-only gate flip 2026-09-11)
 *   rule 3 — fabricated owner green-light + invented lane state (2026-08-13, feedback f548536b)
 *   rule 5 — deploy run id cited as 'msg' (2026-08-30, c8fb9b9f); phantom msg ids
 *             on prefix-addressed lanes (2026-08-30, edcf4dda); fabricated ticket
 *             ids via passive "tickets filed" prose (2026-09-13, b216475a)
 *   rule 6 — 4th same-day phantom strike, invented msg+schedule ids on a
 *             list_schedules observation (2026-08-30, 5448a836); harness-built
 *             ledger replaces the hand-built list (a84cc306, 2026-09-15);
 *             goal/todo labels taught-but-unchecked (3ed139cd, 2026-09-13)
 *   rule 7 — cross-lane dispatch sat ~1h unseen posted mid-run (2026-08-31, 2ce29c32)
 *   rule 8 — projected landing-time headline struck as phantom clock (2026-08-31,
 *             2c15e65a); per-turn [HARNESS CLOCK] note (2026-09-16, ad325229)
 */

/** Prepended to every machine-triggered plain-chat prompt (schedule or hook). */
export function machineWakePreamble(now: Date = new Date()): string {
  return (
    `[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: ${now.toISOString()} — this is the ONLY trustworthy clock; never reconstruct times or dates from earlier notes.]\n` +
    `[FRESHNESS CONTRACT — mandatory:]\n` +
    `1. Cite NO fleet state, counts, schedule IDs, run numbers, PR numbers, or "needs the owner" items from memory or your own earlier notes — pull everything fresh via tools THIS run and report only what you pulled. What you cannot verify fresh right now: drop it or label it UNVERIFIED. Probe even for a genuine no-op — the harness records tool-less answers, and the evidence guard strikes uncited claims: every claim lacking a this-run tool citation is marked UNVERIFIED (plan/memory-search calls do not count as probes).\n` +
    `2. Event payloads below may be truncated (marked …[truncated]). If a detail looks surprising, alarming, or cut off, read the source chat with get_chat_messages BEFORE acting or reporting on it.\n` +
    `3. NEVER quote the owner or attribute a decision, approval, or "go-ahead" to them unless those exact words appear in a tool result you pulled THIS run — and then name the chat you are citing. The same holds for lane/run state ("X is GO", "mid-run"): report only what a fresh tool pull shows; if you cannot verify it right now, label it UNVERIFIED and do not act on it.\n` +
    `4. Keep the final note brief and plain-English: what changed, what needs the owner (with project + why it matters + your recommendation), what is next.\n` +
    `5. EVIDENCE RULE: never claim you dispatched, messaged, scheduled, cancelled, filed (file_feedback), flagged, or updated ANY record (${modelToolName('update_feedback')} / update_schedule / todo_update / goal_update) unless the tool returned a result THIS run — cite the returned id (chat/session/schedule/ticket) for every action you report. This is tool-agnostic: ANY claim that you created, sent, filed, updated, or deleted something is TRUE only if its tool returned a success receipt THIS run whose id you cite verbatim — an action with no returned id did not happen; a claim without an id is a fabrication. Work you got no tool round for is reported as "PLANNED — NOT EXECUTED", never as done. Label every cited id with its true type: 'msg' is ONLY a transcript message id from get_chat_messages (or the lastMessageId list_chats returns per chat); a GitHub Actions run id cites as 'run'/'deploy', never 'msg' — a mislabeled citation is struck by the action verifier as a phantom claim even when the underlying fact is true. get_chat_messages/get_chat_status need the EXACT id as INPUT — resolve 8-char prefixes via list_chats or the tool's 'Did you mean' hint and re-call; if it still returns 'Chat not found', the lane is not readable — label it UNVERIFIED and cite NO msg ids from it.\n` +
    `6. EVIDENCE LIST: before writing your final note, use this run's EVIDENCE LIST — a transient [EVIDENCE LEDGER …] system note re-injected EVERY turn lists every id a tool result ACTUALLY returned this run (message ids from get_chat_messages; schedule ids from list_schedules; chat ids from list_chats; todo/goal ids from todo_list/goal_list/goal_get; ticket ids from list_feedback/file_feedback; workflow-run ids from deploy/CI checks; receipt ids from send/schedule/update/cancel calls). An id may appear in your note ONLY as its first 8 chars copied VERBATIM from that list — 'msg 08ae015c', never a full 36-char uuid: a wrong-suffix uuid is struck as a phantom while a true 8-char prefix exonerates. Never remember, reconstruct, lengthen, or invent an id — a true fact carrying an invented id is struck all the same. Label each cited id with the family it came from: 'msg' (per rule 5), 'sched' for a list_schedules id, 'chat', 'todo'/'goal', 'ticket', 'run'/'deploy', 'receipt' — every labeled id is existence-checked against its own store before your note lands. If the tool behind a fact returned NO id for it, state the fact WITHOUT any id; where you did not capture an id, write (id not captured) — always acceptable and never penalized.\n` +
    `7. DURABILITY RULE: only your FINAL message is durable. Mid-run turn text never becomes transcript rows and never reaches get_chat_messages, next-run history, or the supervisor's run_completed wake summary; the platform carries [DISPATCH-NEEDED] blocks forward into the durable record automatically, but everything else you write mid-run is lost. Put anything another lane, the owner, or your future self must see in your final message verbatim, never as a reference to "the block I posted above".\n` +
    `8. CLOCK DISCIPLINE: a timestamp you state as "now" — your note's headline clock, "as of <time>", "at <time> I saw …" — must be copied from a clock printed THIS run and must NEVER be later than the latest such clock. The harness prints you a fresh one EVERY turn: the transient [HARNESS CLOCK] system note re-injected before every model call. The wake line above is run-START time and goes stale mid-run; a fresher clock inside a tool result also counts. Never project your note's landing time, never add estimated run duration to the wake clock, and never promote a schedule's next-fire time into a "now". A future timestamp may appear ONLY labeled as a future event — the accepted labels: "next fire 05:07Z", "ETA ~05:30Z", "hourly tick 17:29Z", "17:29Z future", "18:00Z checkpoint" (a scheduled decision instant) — never as the time of an observation (an UNLABELED future clock is struck as a fabricated observation and the whole note is replaced). If your turn printed no [HARNESS CLOCK] note and no tool printed a fresher clock, headline the wake line's time verbatim.\n` +
    // 2026-09-26 framework-awareness pass: the decision gate acts in prod and a
    // parked/skipped turn read as a lost wake gets "repaired" by re-sending; a
    // staged call's ok:false receipt read as evidence gets cited. Both are
    // harness facts, so they ride the trigger every wake reads. Layered prompts
    // (2026-09-27): rule 9 is GENERIC (rule gate.outcome) — WHICH purposes act
    // and their bounds are the system prompt's live harness-facts layer, never
    // typed here.
    `9. PARKED / SKIPPED TURNS ARE BY DESIGN (rule gate.outcome): a machine turn the decision gate parked, delayed or skipped — a hook wake delivered late, a stock sweep tick that did not fire, an agent batch that waited — is never a lost wake, a stopped cadence or a deaf lane: never re-send, re-arm or ticket it; your system prompt's harness-facts block names which purposes act today and their bounds. A confirmation-STAGED tool call answers ok:false {staged:true, confirmationId}: that receipt is NOT evidence the action ran — the owner's confirm mints the ids.ownerConfirmed row that is.\n\n`
  );
}

/**
 * The CLAIM BAR sentence every machine trigger carries — hoisted out of
 * machineFiringHeader so the firing header and the agent-send bar
 * (withAgentSendMachineClaimBar, mishap b397a918) share ONE text: drift
 * between the two would re-open the exact surface the bar covers.
 */
export const MACHINE_CLAIM_BAR_TEXT = `CLAIM BAR (the journal-backed evidence guard watches this run): every completion claim in your final answer must cite a concrete tool-result artifact observed THIS run (PR#, run/deploy id, commit SHA, ticket/schedule id, or a quoted output line) — no artifact = no claim; uncited claims are marked UNVERIFIED. The harness records tool-less answers, and the evidence guard strikes uncited claims claim-by-claim — run the mandated fresh probes before answering. Cite clock times only from this-turn tool results or harness-clock notes — never estimates. If your final claims a push, PR, deploy, ticket update, message/dispatch, commit, or verify action, you MAY end it with a fenced claims block the harness auto-verifies against its own receipts: an opening line that is exactly \`\`\`claims (backticks and the word on ONE line), then a JSON array of {"type":"...","ref":"..."} entries — type is one of push | pr | merge | deploy | commit | ticket_update | message_sent | dispatch | file_change | verify | schedule_armed | email_sent | state_update (a \`commit\` entry is a LOCAL commit, sha ref, vouched by a git_commit receipt, never a push), ref is the receipt-visible id from THIS run's tool results (commit sha, PR number, or the receipt id the tool envelope returned; a verify entry is vouched ONLY by a this-run verify-tool receipt — checks executed via run_command cannot vouch it, so report those as prose with the quoted output line, never as a verify entry) — an entry may add optional "scope":"session" (work an earlier run of THIS chat did) or "scope":"relayed" (a receipt you read with get_run_receipts this run): a scoped entry that matched no this-run receipt is re-checked against the chat's recent receipt history instead of being struck — then a closing line that is exactly \`\`\`. Receipt-verified entries downgrade prose convictions; an entry with no matching receipt is marked UNVERIFIED, so never list work you did not execute this run.]`;

/**
 * Provenance header for machine-fired CODING runs (feedback fbe65673): schedule
 * firings and hook wakes on code-capable chats queue via startScheduledRun,
 * which never got the plain-chat preamble above — the firing persisted as a
 * BARE user message, indistinguishable from an owner-typed instruction
 * (2026-08-27: a firing queued before the owner's "pause work" + schedule
 * cancel landed restarted the paused loop, because the lane weighed it as an
 * explicit owner instruction). Prepended at QUEUE time so the marker rides the
 * persisted row, the run goal, and every future history render — the lane can
 * then weigh the trigger against explicit owner messages. The prefix stays
 * byte-aligned with the preamble ('[MACHINE-TRIGGERED RUN') so the chat UI's
 * wake classifier (frontend/lib/machine-wake.ts WAKE_PREFIX) collapses these
 * exactly like plain-chat wake envelopes.
 */
export function machineFiringHeader(origin: 'schedule' | 'hook' | 'continuation', opts?: { continuationOf?: string | null }): string {
  // audit 2026-10-06 T4-6 (litellm.md F6): a [HARNESS CONTINUATION] run queued
  // by the run-end backstop (schedule.service queueContinuationRun) is NOT a
  // schedule firing — no coding_schedules row exists — so it gets its own
  // provenance line naming the run it continues. Same prefix, same single
  // bracketed line (no inner ']' — run ids are uuids), same CLAIM BAR.
  const contRun = typeof opts?.continuationOf === 'string' ? opts.continuationOf.replace(/[^0-9a-zA-Z-]/g, '').slice(0, 8) : '';
  const what = origin === 'hook'
    ? 'a fleet event wake delivered by an event hook'
    : origin === 'continuation'
    ? `a harness continuation of ${contRun ? `run ${contRun}` : 'the previous run'} on this chat (that run ended with unfinished plan steps; this is not a schedule firing)`
    : 'a scheduled firing of a recurring/one-shot schedule';
  return (
    `[MACHINE-TRIGGERED RUN — ${what}, NOT a human-typed message. It may be stale (queued before a cancel or pause landed). ` +
    `Weigh it against the transcript: a newer explicit owner message (e.g. "pause work") GOVERNS over this trigger — halt and report instead of executing. ` +
    // CLAIM BAR (ticket f5ff8329): a coding session's schedule-fired runs kept
    // closing with unproven completions (zero-evidence probe claims + fabricated
    // clock citations) because the firing message itself carried no claim
    // discipline — the bar reached coding runs only via owner-authored prompts
    // (the nightly), ticket-dispatch briefs (PR #569), and continuation notes.
    // The bar now rides EVERY machine firing, so no lane's prompt needs manual
    // steering. One bracketed line, no inner ']' or newline — the strip regex
    // below (title seeds) and the UI wake classifier (WAKE_PREFIX) depend on it.
    // P4 (claims fence): the bar also requests the typed ```claims block the
    // harness verifies deterministically (claims-block.ts grammar, verified by
    // applyClaimsBlockLane) — a receipt-proven block downgrades prose
    // convictions, so honest runs gain from emitting it. Gate wording is the
    // B30-honest version (P1), re-honested for the 2026-09-11 gate flip
    // (owner: full steam): tool-less answers are recorded (the zero-tool gate
    // until build 2026-10-08 S-2; since then the evidence guard's NO FRESH
    // EVIDENCE annotation) and the evidence guard marks uncited claims
    // UNVERIFIED; the claims fence is
    // optional (MAY), an unmatched entry is marked, not convicted.
    MACHINE_CLAIM_BAR_TEXT + '\n\n'
  );
}

/**
 * Strip a queue-time machineFiringHeader from a message — derived displays
 * (session title seeds, previews) must not inherit the ops chrome (review
 * finding 3, fbe65673: a schedule-fired NEW session seeded its title from
 * '[MACHINE-TRIGGERED RUN — a scheduled firing of a r…'). Matches ONLY the
 * single-line firing header above — the multi-line plain-chat preamble never
 * appears in the coding lane and is left untouched.
 */
export function stripMachineFiringHeader(message: string): string {
  return message.replace(/^\[MACHINE-TRIGGERED RUN — [^\]\n]*\]\n\n/, '');
}

/**
 * Machine-authored "user" text: a queue-time firing header, an agent-to-agent
 * send, a coalesced-queue banner, an owner-inbox digest… — never a human
 * statement. Shared by the memory pipeline (personal-fact extraction and the
 * rebuild skip these) and by the coding executor (a run whose input carries
 * one is a machine run even when it also carries a userTurnAt anchor).
 */
export const MACHINE_TEXT_RE =
  /^\s*\[(MACHINE-TRIGGERED RUN|AGENT-SENT MESSAGE|Owner inbox|Fleet goal board|ACTION VERIFIER|HARNESS NOTE|OWNER-QUESTION TRIAGE|Owner-anchored message|\d+ agent messages? arrived)/i;

export function isMachineAuthoredText(text: unknown): boolean {
  return MACHINE_TEXT_RE.test(String(text ?? ''));
}

/**
 * A coding run's input was typed by the human (owner report 2026-09-21): an
 * explicit fleet origin wins ('agent'/'webhook'/'schedule'/'hook' are machine);
 * otherwise the executor's own anchor — a run queued by a REAL user turn
 * carries userTurnAt — and the text itself must not be machine-authored.
 */
export function isHumanTypedRunInput(input: { message?: string; origin?: string | null; userTurnAt?: unknown } | null | undefined): boolean {
  if (!input) return false;
  const origin = input.origin ?? (input.userTurnAt ? 'user' : 'schedule');
  if (origin !== 'user') return false;
  const text = String(input.message ?? '').trim();
  if (!text) return false;
  return !isMachineAuthoredText(text);
}
