/**
 * Executed-action extraction — DEPENDENCY-FREE leaf module.
 *
 * Walks an agent run's recorded parts (coding/agent.ts MessagePart log: every
 * tool_call and its tool_result, in order) and returns the CONSEQUENTIAL
 * platform actions that actually executed, with the ids their result envelopes
 * carried. This is the ground truth the phantom-claim verifier
 * (action-verifier.ts) and the supervisor state doc (supervisor-state.service)
 * compare status-note claims against: a claim with no matching entry here is a
 * fabrication.
 *
 * Kept import-free (same leaf discipline as platform-tool-names.ts /
 * chat-agent/machine-wake.ts) so it is unit-testable without the config/env
 * import-exit hazard and usable from both the chat-agent finalize path and the
 * platform layer without cycles.
 */

/** Consequential platform tools whose execution the verifier tracks. */
export const TRACKED_CONSEQUENTIAL_TOOLS = [
  'send_chat_message', 'start_coding_session', 'schedule_message',
  'update_schedule', 'cancel_schedule', 'dispatch_platform_task',
  'file_feedback',
  // (ticket d25172ca, 2026-09-16) notify_user mints a run-receipt since todo
  // 1e356736 (2026-10-16, NOTIFY_RECEIPT_TOOLS — ids {channel} only) — the
  // parts log stays its SECOND execution evidence lane: an anon session (no
  // receipt row — the FK guard skips anon- prefixes) or a receipt-write
  // failure still needs the parts lane, and the verifier's pool union reads
  // both. Before EITHER lane, a REAL Telegram delivery
  // ({ok:true, channel:'telegram', deliveredTo:'@user'}) was invisible to the
  // action verifier, which struck the truthful "Telegram notification
  // delivered to @codoublez" claim and posted a FALSE correction telling the
  // user nothing was sent (chat 66311e6d, 2026-09-16T22:47Z).
  'notify_user',
  // (ticket 169846b6, 2026-09-27) BOTH email-send tools ride the same lane for
  // the same reason: they mint NO run-receipt, so the parts log is their only
  // execution evidence. While untracked, the action verifier convicted the
  // TRUE "the test email just went out from your CQL Gmail (example-user@example.com)"
  // claim in chat b9cd2f21 (msg e87286da) even though the run's own parts held
  // {ok:true, tool:'gmail_send_email', account:'CQL', message:'1a0e43973e3cca6c'}
  // — Gmail message id 1a0e43973e3cca6c landed at 18:56:05Z, nine seconds
  // BEFORE the claim — and posted a user-facing correction inverting the truth
  // (the verifier's "Executed consequential actions this run: NONE" was the
  // only false statement in the thread). Both tools answer with the shared
  // {ok, tool, …} JSON envelope (googleWriteEnvelope / account-tools j()),
  // which parseResult already reads; refusals (not_configured, label_not_found,
  // machine_run) carry ok:false and correctly stay non-executions.
  'gmail_send_email', 'send_email_as_digby',
  // (ticket 9ca6e125, 2026-10-29) The OUTBOUND-CONNECTOR and edge-instance send
  // class rides the same lane, for the same reason and with the same evidence:
  // these tools mint NO run-receipt and answer a JSON {ok, tool, ids} envelope
  // (connectorWriteEnvelope, coding-integrations.ts; toolResultEnvelope for
  // send_to_instance, platform-tools.ts), so the parts log is their ONLY
  // execution evidence. While untracked they were in NEITHER pool lane, so a
  // TRUTHFUL "posted it in #eng" / "messaged them on iMessage" / "delivered to
  // the edge chat" narration extracted as [message] (no id), found no slot that
  // could ever vouch for it, and was struck phantom with "executed
  // consequential actions this run: NONE" — the av-mishap class. The sibling
  // detector already carried this vocabulary (unbacked-claim.ts
  // SEND_CLAIM_TOOLS) and claim-verb-classes.ts maps `sent`/`messaged` onto
  // exactly these tools, so the platform lane was the only surface missing it.
  // All of these are HUMAN-TURN-ONLY (HUMAN_TURN_CONNECTOR_WRITES answers
  // ok:false reason:'machine_run' without a user turn), and a refusal carries
  // ok:false — a refusal correctly stays a non-execution.
  'send_to_instance',
  'imessage_send', 'slack_post_message', 'discord_send_message', 'discord_send_dm', 'x_post',
] as const;

/**
 * (ticket 9ca6e125, 2026-10-29) WORKER-DELEGATION tools — the [dispatch] half
 * of the same av-mishap class. The claim extractor's own vocabulary defines a
 * dispatch claim as "started/dispatched a coding session, WORKER, or platform
 * task" (action-verifier.ts extractActionClaims), and the chat orchestrator is
 * offered both delegate schemas (runToolSchemasForProbe, kind:'chat',
 * allowSubagents). But delegate/delegate_parallel mint NO run-receipt and are
 * absent from TRACKED_CONSEQUENTIAL_TOOLS, and their result is a PROSE summary
 * ("### title (role)\n<report>") with no ok:true envelope — so a truthful "I
 * dispatched a reviewer worker to check the detector" claim had NO possible
 * vouch and convicted as [dispatch] (no id) with NONE executed.
 *
 * They get their OWN lane and their OWN id-less tier (never KIND_TOOLS.dispatch)
 * per the 61b9200a anti-laundering rule: a real worker delegation must not
 * launder an unrelated platform-dispatch phantom ("I dispatched a coding
 * session 9e39ec5c"), and the tier is gated on a WORKER/SUBAGENT idiom so only
 * claims that actually narrate a delegated worker can reach it.
 */
export const DELEGATION_TOOLS = ['delegate', 'delegate_parallel'] as const;
const DELEGATION_SET = new Set<string>(DELEGATION_TOOLS);

/**
 * Refusals delegate/delegate_parallel answer as PROSE (agent.ts:1270-1299) —
 * never an execution. ANCHORED to the WHOLE result string on purpose: every
 * refusal is a complete single-line `return`, whereas a REAL delegation result
 * is a multi-line summary ("### title (role)\n<report>") that may QUOTE any of
 * these phrases (a reviewer worker reviewing agent.ts itself will echo
 * "Unknown role …"), and an unanchored match would flip a genuine run to
 * non-executed and re-convict exactly the honest claims this lane exists to
 * stop convicting.
 */
const DELEGATION_REFUSAL_RE =
  /^(?:Delegation is not available[^\n]*|No background workers here[^\n]*|Unknown role "[^"]*"[^\n]*|No tasks provided\.|Role "[^"]*" writes to the worktree[^\n]*)$/;

/**
 * (ticket 9ca6e125) First-person WORKER-dispatch idiom for an id-less dispatch
 * claim backed by delegate/delegate_parallel — the laundering guard for the
 * delegation tier above. Requires delegated-worker nouns (worker / subagent /
 * sub-agent / delegate / delegated / reviewer / explorer / architect /
 * cross-checker / researcher), so a platform/session dispatch claim ("I
 * dispatched a coding session", "dispatched the platform task") can never be
 * acquitted by an unrelated real worker run. Exported for tests.
 */
const DELEGATION_CLAIM_IDIOM =
  /\b(?:workers?|sub-?agents?|delegat(?:e|ed|ing|ion|ions)|reviewer|explorer|architect|cross-?checker|researcher)\b/i;

/** Exported for tests: does this claim detail narrate a DELEGATED WORKER (the delegation tier)? */
export function isDelegationClaimDetail(detail: string): boolean {
  return DELEGATION_CLAIM_IDIOM.test(String(detail ?? ''));
}

/** Exported for tests: is this pool entry a worker-delegation execution? */
export function isDelegationTool(tool: string): boolean {
  return DELEGATION_SET.has(String(tool ?? ''));
}

/**
 * Worker-delegation execution lane (ticket 9ca6e125) — same FIFO pairing as
 * extractTaskExecutions, over DELEGATION_TOOLS. Exported for the verifier's
 * pool construction and for tests.
 */
export function extractDelegationExecutions(parts: RunPartLike[] | null | undefined): ExecutedAction[] {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  const out: ExecutedAction[] = [];
  const pendingByTool = new Map<string, number[]>();
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const name = String(part.name ?? '');
    if (part.type === 'tool_call' && DELEGATION_SET.has(name)) {
      const idx = out.push({ tool: name, ok: false, staged: false, ids: {} }) - 1;
      const q = pendingByTool.get(name) ?? [];
      q.push(idx);
      pendingByTool.set(name, q);
    } else if (part.type === 'tool_result' && DELEGATION_SET.has(name)) {
      const q = pendingByTool.get(name);
      const idx = q?.shift();
      if (idx === undefined) continue; // orphan result — nothing claimed it
      const text = String(part.result ?? '').trim();
      // A worker run is REAL when its summary came back. A REFUSAL ("Delegation
      // is not available here", "Unknown role", a writer role in parallel) is
      // not an execution; a per-task "[failed: …]" tag inside an otherwise-real
      // run still is (fail toward miss — a false strike is strictly worse than
      // a miss, doctrine 587e9d64).
      out[idx] = { tool: name, ok: text.length > 0 && !DELEGATION_REFUSAL_RE.test(text), staged: false, ids: {} };
    }
  }
  return out;
}

/**
 * Task-delegation tools (ticket 61b9200a, 2026-09-12): computer_task and
 * browser_task run REAL sub-agent sessions (the user's Mac / a browser) — a
 * chat note narrating "I ran a computer task to find the PDF" is an ACTION
 * claim about real work, and the phantom-claim verifier must be able to
 * vouch for it. They mint NO run-receipt (run-receipts.ts RECEIPT_TOOLS is
 * the consequential-platform allowlist), so their execution evidence lives
 * ONLY in the MessagePart log — this lane parses it.
 */
export const TASK_DELEGATION_TOOLS = ['computer_task', 'browser_task'] as const;

const TASK_SET = new Set<string>(TASK_DELEGATION_TOOLS);

/** Exported for the verifier's task-slot routing: is this pool entry a delegated task execution? */
export function isTaskDelegationTool(tool: string): boolean {
  return TASK_SET.has(String(tool ?? ''));
}

/**
 * First-person narration idiom for a delegated computer/browser task (the
 * claim surface the extractor labels [dispatch]): "I ran a computer task to
 * find the PDF", "the browser task did dispatch to your Mac's local browser".
 * Underscore/hyphen variants cover the tool names themselves (computer_task).
 */
const TASK_CLAIM_IDIOM = /\b(?:computer|browser)[ _-]tasks?\b|\bcomputer[ _-]use\b|\bbrowser[ _-]agent\b/i;

/** Exported for tests: does this claim detail narrate a delegated task? */
export function isTaskDelegationClaimDetail(detail: string): boolean {
  return TASK_CLAIM_IDIOM.test(String(detail ?? ''));
}

/**
 * (ticket 9bd94417, 2026-10-28) Outcome idiom for a delegated computer/browser
 * task — the task-budget arm's SECOND surface. The 61b9200a idiom above keys
 * on the tool's own NAME ("computer task", "computer use", "browser agent"),
 * but the natural way a note narrates a desktop task's RESULT names neither:
 * "Discord is now open on its screen", "I opened Discord on the Mac", "the
 * app is running on the desktop". Chat 18a957cb narrated exactly that after a
 * REAL 10-step computer_task (steps:10 in the run's own verifier record), the
 * task-budget arm never recognised the words, the claim fell to the platform
 * budget KIND_TOOLS.dispatch deliberately cannot fill, and the TRUE claim was
 * CONVICTED as a [dispatch] phantom. Both idioms vouch the same fact (a task
 * execution existed), so the outcome idiom rides the SAME dedicated task
 * budget — never a platform slot first.
 *
 * Laundering guard (mirrors the 61b9200a discipline): every arm requires a
 * device/screen surface (screen/display/desktop/mac·macbook/computer/browser,
 * plural-tolerant), so platform claims ("the PR is now open on GitHub", "I opened a
 * ticket on the board", "the issue is open on the board") never route here —
 * and with no task slot on record an outcome claim still convicts (a
 * fabricated "Discord is open" with no task run stays a phantom). Accepted
 * residual (fail toward miss, the 587e9d64 doctrine): a compound sentence
 * ("opened a coding session on the Mac for the fix") can be vouched by a real
 * task run — the same accepted miss the 61b9200a fall-through already makes.
 */
const TASK_OUTCOME_DEVICE = '\\b(?:screens?|displays?|desktops?|macs?|macbooks?|computers?|browsers?)\\b';
/** The same device words WITHOUT the outer word boundaries — the task-subject
 * arm below needs to append a phrase (not start one), so \b on both ends would
 * fight its own quantifiers. One list, two renderings: they must never drift. */
const TASK_OUTCOME_DEVICE_SRC = '(?:screens?|displays?|desktops?|macs?|macbooks?|computers?|browsers?)';
const TASK_OUTCOME_IDIOM = new RegExp(
  [
    // Copula-first: "Discord is now open on its screen", "the app was left
    // open on the Mac", "Discord is running on the desktop", "the window is
    // visible on screen".
    '\\b(?:is|was|are|were)\\s+(?:now\\s+)?(?:open|opened|running|visible|launched|up)\\b'
    + '[^.;\\n]{0,40}?' + TASK_OUTCOME_DEVICE,
    // Verb-first: "I opened Discord on the Mac", "launched Chrome on its
    // screen", "started the server on the desktop".
    '\\b(?:open(?:ed|s)?|launch(?:ed|es)?|start(?:ed|s)?)\\b'
    + '[^.;\\n]{0,40}?(?:\\bon\\s+(?:its|the|your|their)\\s+)?' + TASK_OUTCOME_DEVICE,
    // Task-SUBJECT (ticket f6dbcb66, chat 026682ae): the note makes the
    // delegated TASK the grammatical subject and reports its COMPLETION —
    // "The Mac task ran and delivered the link", "the computer task finished
    // in 7 steps", "the browser task completed". Neither arm above covers it:
    // the copula arm wants open/running/visible, the verb arm wants
    // open/launch/start, and "ran"/"finished"/"completed"/"delivered" are in
    // neither. A REAL 7-step computer_task was on record, both task-budget
    // arms missed the words, the claim fell to the platform dispatch slot
    // KIND_TOOLS.dispatch deliberately cannot fill, and the TRUE claim was
    // convicted (false strike — doctrine 587e9d64: strictly worse than a
    // miss).
    //
    // Laundering guard, same discipline as the arms above: the DEVICE word
    // must qualify the task (≤2 modifiers between them), so a platform claim
    // naming a bare task ("the task ran on the board", "the parity task
    // finished") never routes here — and with no task slot on record a
    // fabricated "The Mac task ran" still convicts.
    '\\b' + TASK_OUTCOME_DEVICE_SRC + '\\s+(?:[\\w-]+\\s+){0,2}tasks?\\b'
    + '[^.;\\n]{0,40}?\\b(?:ran|finished|completed|delivered|executed|succeeded)\\b',
  ].join('|'),
  'i',
);

/** Exported for tests + the verifier's task-slot routing: does this claim detail narrate a task OUTCOME? */
export function isTaskOutcomeClaimDetail(detail: string): boolean {
  return TASK_OUTCOME_IDIOM.test(String(detail ?? ''));
}

/**
 * Parse a computer_task / browser_task tool_result into { ok, ids }.
 * Success shape (tool-executor.ts formatComputerTaskToolResult /
 * formatBrowserTaskToolResult) — the header is anchored at a LINE start so a
 * prepended capability banner (`[BROWSER_TASK — INTERACTION UNAVAILABLE…]` /
 * `[COMPUTER_TASK — UNAVAILABLE]`, which rides BEFORE the header when the
 * formatter emits one) still parses:
 *   "[Computer task result — steps: 12 · mac: connected (…)]\n<finalResponse>"
 *   "[Browser agent result — driver: local, steps: 4 …]\n<finalResponse>"
 * A run that EXECUTED (steps > 0 on the machine/browser) counts as
 * ok=true even when the task found nothing ("I was unable to locate the
 * requested PDF") — the CLAIM the model makes about that result ("I searched
 * Spotlight and Finder") is then true. `steps: 0` counts as NOT executed
 * (the capability-gate path: no agent → capabilityNotice + steps 0, no
 * session ever started). The executor's plain-prose error returns ("No task
 * provided…", "The browser agent finished without a result…", "Tool call
 * failed: …") never carry the header, so they stay non-executions.
 */
export function parseTaskResult(tool: string, result: string): { ok: boolean; ids: Record<string, string> } {
  const text = String(result ?? '');
  if (!text.trim()) return { ok: false, ids: {} };
  // Accept the em-dash the formatters emit and a plain hyphen (so a formatter
  // tweak cannot silently blind this lane). Header idiom is formatter-owned —
  // no executor error path emits it.
  const m = text.match(/^!?\[Computer task result\s*[—-]\s*steps:\s*(\d+)/m)
    ?? text.match(/^!?\[Browser agent result\s*[—-][^\]]*?steps:\s*(\d+)/m);
  if (!m) return { ok: false, ids: {} };
  const steps = parseInt(m[1], 10);
  if (!Number.isFinite(steps) || steps <= 0) return { ok: false, ids: {} };
  return { ok: true, ids: { taskTool: tool, steps: String(steps) } };
}

/**
 * Task-execution lane (ticket 61b9200a): pair each computer_task/browser_task
 * tool_call with its tool_result, same FIFO discipline as
 * extractExecutedActions. Exported for the verifier's pool construction and
 * for tests.
 */
export function extractTaskExecutions(parts: RunPartLike[] | null | undefined): ExecutedAction[] {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  const out: ExecutedAction[] = [];
  const pendingByTool = new Map<string, number[]>();
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const name = String(part.name ?? '');
    if (part.type === 'tool_call' && TASK_SET.has(name)) {
      const idx = out.push({ tool: name, ok: false, staged: false, ids: {} }) - 1;
      const q = pendingByTool.get(name) ?? [];
      q.push(idx);
      pendingByTool.set(name, q);
    } else if (part.type === 'tool_result' && TASK_SET.has(name)) {
      const q = pendingByTool.get(name);
      const idx = q?.shift();
      if (idx === undefined) continue; // orphan result — nothing claimed it
      const parsed = parseTaskResult(name, String(part.result ?? ''));
      out[idx] = { tool: name, staged: false, ...parsed };
    }
  }
  return out;
}

/**
 * Cheap pre-gate for the phantom-claim verifier on NON-supervisor chats
 * (ticket ae085617): a final answer with none of these action-claim words has
 * nothing worth an LLM extraction pass — skip the verifier entirely. The list
 * mirrors the verifier's claim kinds (dispatch / message / schedule / ticket):
 * over-matching costs one cheap utility call, under-matching misses a claim.
 * (ticket 61b9200a) The task-delegation narration idiom ("I ran a computer
 * task…") joined the gate: it is an action claim with its own exoneration
 * lane, and the incident note reached the extractor only because "ran" is not
 * itself a gate keyword — the browser-task phrasing of d78f477b rode
 * "dispatch" in. One regex, matched per note — the cost is one backtracking
 * scan on the false side.
 */
export const ACTION_CLAIM_KEYWORD_RE =
  /\b(?:dispatch(?:ed|ing|es)?|sent|delivered|queued|schedul(?:ed|es|ing)|filed|filing|ticket(?:ed|s)?|start(?:ed)?\s+(?:a\s+)?(?:coding\s+)?session)\b|\b(?:computer|browser)[ _-]tasks?\b|\bcomputer[ _-]use\b|\bbrowser[ _-]agent\b|\b(?:start_coding_session|send_chat_message|dispatch_platform_task|delegate_parallel|store_secret|merge_pull_request|open_pull_request)\b/i;
/**
 * (ticket 4deaf460, 2026-10-08) MESSAGE-SEND narration idiom joins the gate:
 * "I've messaged chat d1d0b346 … It runs autonomously" contains NONE of the
 * words above in the incident's exact shape — the supervisor's answer to
 * "message the tt-rd supervisor" asserted a send_chat_message that never ran
 * (the run's receipt pool held zero sends; the real send landed only after
 * the owner's correction), and because the chat was a supervisor chat the
 * routing dead zone (fixed in chat-agent.service.ts) never reached the
 * extractor either. With routing closed, the idiom must route too:
 * "messaged/messaging/texted/DM'd/pinged" + a chat/contact/recipient object.
 * The extractor's own message-verb vocabulary already carries
 * `messaged` (VERB_RE line ~576); this is the PRE-GATE twin — over-matching
 * costs one cheap utility call (the pre-gate's own doctrine), under-matching
 * lets a fabricated send reach the human unchallenged (this incident).
 * Narrow by object so status prose like "no messages" stays off the lane.
 */
export const MESSAGE_SEND_CLAIM_IDIOM =
  /\b(?:messag(?:ed|ing)|texted|dm(?:'d|ed)?|pinged|poked)\s+(?:the\s+|a\s+|an\s+|chat\s+)?[\w-]*\s?(?:chat|supervisor|lane|session|contact|agent|worker|team|group|channel|owner|fleet)/i;

export function hasMessageSendClaimIdiom(text: string | null | undefined): boolean {
  return !!text && MESSAGE_SEND_CLAIM_IDIOM.test(text);
}
/**
 * (ticket a235fbd6, 2026-09-28) STAGING-narration idiom joins the gate: "I've
 * staged a message to the deck session telling it to hand-deliver the files"
 * contains NONE of the words above ("hand-deliver" ≠ "delivered", "staged" ≠
 * "queued") — the incident note reached the extractor only because "filed"
 * (a gate keyword) co-occurred in the same answer. A pure staging claim with
 * no co-occurring keyword would skip the verifier entirely. The idiom covers
 * stage_upload-backed claims (staged/prepared/attached … a message/file) and
 * is a PRE-GATE only: it routes the note to the LLM matcher, which — with the
 * extractor's new staging vocabulary — labels it [message]; a truthful
 * narration is then exonerated by the run's own stage_upload execution
 * (findPhantomClaims' staging tier), never by an unrelated message slot.
 * Over-matching costs one cheap utility call (the pre-gate's own doctrine).
 */
export const STAGING_CLAIM_IDIOM =
  /\b(?:staged|staging)\s+(?:a\s+|an\s+|the\s+)?(?:message|file|upload|attachment|blob|pdf|deck|document|image|spreadsheet|csv)\b|\b(?:hand-?deliver(?:ed|ing)?|as\s+(?:real\s+)?chat\s+attachments?)\b/i;

export function hasStagingClaimIdiom(text: string | null | undefined): boolean {
  return !!text && STAGING_CLAIM_IDIOM.test(text);
}

export function hasActionClaimKeywords(text: string | null | undefined): boolean {
  if (!text) return false;
  return ACTION_CLAIM_KEYWORD_RE.test(text) || STAGING_CLAIM_IDIOM.test(text) || MESSAGE_SEND_CLAIM_IDIOM.test(text);
}

const TRACKED_SET = new Set<string>(TRACKED_CONSEQUENTIAL_TOOLS);

/** The subset of MessagePart shape this module reads (structural, no import). */
export interface RunPartLike {
  type: string;
  name?: string;
  result?: string;
  [k: string]: any;
}

export interface ExecutedAction {
  tool: string;
  /** True only for a result that reports actual execution (not a staged confirmation, not an error). */
  ok: boolean;
  /** True when the call only STAGED a pending confirmation (needsConfirmation envelope). */
  staged: boolean;
  /** Canonical ids from the result envelope (or parsed out of legacy prose). */
  ids: Record<string, string>;
}

/** Legacy prose success patterns for results predating the JSON envelope. */
const PROSE_SUCCESS: Array<{ tool: string; re: RegExp; idKey?: string }> = [
  { tool: 'start_coding_session', re: /^Started coding session ([0-9a-f-]{8,})/i, idKey: 'sessionId' },
  { tool: 'send_chat_message', re: /^Message (?:queued|delivered) (?:in|to) chat ([0-9a-f-]{8,})/i, idKey: 'chatId' },
  { tool: 'schedule_message', re: /^Scheduled \((?:once|recurring), id ([0-9a-f-]{8,})\)/i, idKey: 'scheduleId' },
  { tool: 'update_schedule', re: /^Updated schedule ([0-9a-f-]{8,})/i, idKey: 'scheduleId' },
  { tool: 'cancel_schedule', re: /^(?:Cancelled|Disabled) (?:\(disabled\) )?schedule ([0-9a-f-]{8,})/i, idKey: 'scheduleId' },
  // file_feedback never adopted the JSON envelope — its two success shapes are
  // prose (platform-tools.ts): a fresh filing, and a dedup bump onto an
  // existing ticket (a REAL execution — the sighting was recorded).
  { tool: 'file_feedback', re: /^Filed feedback ticket ([0-9a-f-]{8,})/i, idKey: 'ticketId' },
  { tool: 'file_feedback', re: /^Already tracked as ticket ([0-9a-f-]{8,})/i, idKey: 'ticketId' },
  // update_feedback's success shape is prose too (platform-tools.ts: "Updated
  // feedback ticket <id>: status=…[, adminNote set]."). Its refusal shapes are
  // the {ok:false} verified-close envelope and gate prose — neither matches, so
  // only a real update records ok:true (ticket 4243f38a).
  { tool: 'update_feedback', re: /^Updated feedback ticket ([0-9a-f-]{8,})/i, idKey: 'ticketId' },
];

/**
 * Parse one tool result into { ok, staged, ids }: the toolResultEnvelope JSON
 * (and the gate's needsConfirmation envelope) first, then the legacy prose
 * catalogue. Exported for coding/run-receipts.ts — ONE parsing home for the
 * envelope across the executed-action extractor and the receipt extractor.
 */
/**
 * (reviewer B2, ticket 331a1b23 follow-up) parseResult flags `staged` ONLY
 * for needsConfirmation envelopes; a tracked tool that answers an explicit
 * {ok:false, staged:true, confirmationId} envelope (the degraded-dispatch
 * shape some consequential tools answer) must ALSO read as staged — its args
 * can still be truthfully narrated as "staged for owner confirmation", so the
 * args-scan execution gate keeps the call scannable. One cheap JSON probe;
 * non-JSON results answer false.
 */
function isStagedEnvelopeText(result: unknown): boolean {
  const text = String(result ?? '').trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text);
    return !!parsed && typeof parsed === 'object' && (parsed as any).staged === true;
  } catch { return false; }
}

export function parseResult(tool: string, result: string): { ok: boolean; staged: boolean; ids: Record<string, string> } {
  const text = String(result ?? '').trim();
  // JSON envelope path (toolResultEnvelope in platform-tools.ts, and the
  // needsConfirmation envelope from the consequential gate).
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        if (parsed.needsConfirmation === true) return { ok: false, staged: true, ids: {} };
        const ids: Record<string, string> = {};
        if (parsed.ids && typeof parsed.ids === 'object') {
          for (const [k, v] of Object.entries(parsed.ids)) {
            if (typeof v === 'string' || typeof v === 'number') ids[k] = String(v);
          }
        }
        // The envelope's TOP-LEVEL receiptId (toolResultEnvelope, platform-
        // tools.ts) is the harness receipt id the model is TOLD it may cite —
        // lift it into ids so the verifier's tier-1 prefix match can resolve
        // the citation (ticket 6f01288e: a truthful "receipt d7553cbe" claim
        // was convicted phantom — no pool entry ever carried the receiptId,
        // and message claims are hard-blocked from the DB existence tier).
        if (typeof parsed.receiptId === 'string' && parsed.receiptId) ids.receiptId = parsed.receiptId;
        return { ok: parsed.ok === true, staged: false, ids };
      }
    } catch { /* fall through to prose matching */ }
  }
  // Legacy prose path.
  for (const p of PROSE_SUCCESS) {
    if (p.tool !== tool) continue;
    const m = text.match(p.re);
    if (m) return { ok: true, staged: false, ids: p.idKey && m[1] ? { [p.idKey]: m[1] } : {} };
  }
  return { ok: false, staged: false, ids: {} };
}

/**
 * Pair each tracked tool_call with the next tool_result of the same tool name
 * (parts are recorded in call order by the agent loop). A call whose result
 * never appears counts as NOT executed.
 */
export function extractExecutedActions(parts: RunPartLike[] | null | undefined): ExecutedAction[] {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  const out: ExecutedAction[] = [];
  const pendingByTool = new Map<string, number[]>(); // tool → indexes into `out` awaiting a result
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const name = String(part.name ?? '');
    if (part.type === 'tool_call' && TRACKED_SET.has(name)) {
      const idx = out.push({ tool: name, ok: false, staged: false, ids: {} }) - 1;
      const q = pendingByTool.get(name) ?? [];
      q.push(idx);
      pendingByTool.set(name, q);
    } else if (part.type === 'tool_result' && TRACKED_SET.has(name)) {
      const q = pendingByTool.get(name);
      const idx = q?.shift();
      if (idx === undefined) continue; // orphan result — nothing claimed it
      const parsed = parseResult(name, String(part.result ?? ''));
      out[idx] = { tool: name, ...parsed };
    }
  }
  return out;
}

/**
 * (ticket 331a1b23, 2026-10-27) Args-scan execution gate: the parts-index sets
 * for tracked tool_calls whose paired result is a PLAIN FAILURE — ok:false AND
 * not a confirmation-STAGE (a staged call's args can still be truthfully
 * narrated as "dispatched for owner confirmation", so staged stays scannable).
 * Pairing mirrors extractExecutedActions' queue (call → next same-tool result,
 * in call order). TWO sets come back:
 *   - `failed`: calls paired with a failed result (deterministic lane);
 *   - `unanswered`: calls whose result part never appeared (a truncated/lost
 *     parts log) — NOT failures on their own; the caller decides them against
 *     the run's receipts (a tool whose every receipt row failed ⇒ its
 *     unanswered calls failed too; any ok/staged receipt ⇒ fail-open,
 *     pre-2026-10-27 scannability). An orphan result claims nothing.
 *
 * WHY: the action-verifier's args-scan surface (scanToolCallArgs) mined the
 * ARGS of every tracked tool_call regardless of outcome, so a REFUSED call
 * plus its ok RETRY (the incident: file_feedback refused once — receipt
 * 61544a44 ok:false — then re-filed ok, receipt a161f88c) contributed TWO
 * id-less [ticket] claims against ONE ok execution; the id-less slot budget
 * vouches the first twin and convicts the second, filing a mishap ticket
 * against a truthful note ("Filed — ticket 8aa5688f" backed by the receipt).
 * A refused call's drafted args are internal-only: no ticket row, no artifact,
 * no owner-visible text ever fossilizes them — the phantom-claim harm model
 * (an unverified story fossilizing into later notes) cannot apply. Skip them.
 */
export function trackedCallOutcomeIndexes(parts: RunPartLike[] | null | undefined): { failed: Set<number>; unanswered: Set<number> } {
  const failed = new Set<number>();
  const unanswered = new Set<number>();
  if (!Array.isArray(parts)) return { failed, unanswered };
  const pendingByTool = new Map<string, number[]>(); // tool → parts indexes of its calls awaiting a result
  parts.forEach((part, idx) => {
    if (!part || typeof part !== 'object') return;
    const name = String(part.name ?? '');
    if (part.type === 'tool_call' && TRACKED_SET.has(name)) {
      const q = pendingByTool.get(name) ?? [];
      q.push(idx);
      pendingByTool.set(name, q);
    } else if (part.type === 'tool_result' && TRACKED_SET.has(name)) {
      const idxCall = pendingByTool.get(name)?.shift();
      if (idxCall === undefined) return; // orphan result — nothing claimed it
      const parsed = parseResult(name, String(part.result ?? ''));
      // (reviewer B2) parseResult flags `staged` only for needsConfirmation
      // envelopes; an explicit {ok:false, staged:true, confirmationId} answer
      // (the degraded-dispatch shape) must ALSO stay scannable — its args can
      // be truthfully narrated as "staged for owner confirmation".
      const stagedEnvelope = parsed.staged === true || isStagedEnvelopeText(part.result);
      if (!parsed.ok && !stagedEnvelope) failed.add(idxCall);
    }
  });
  for (const q of pendingByTool.values()) for (const idx of q) unanswered.add(idx);
  return { failed, unanswered };
}

/** Convenience: only the actions that genuinely executed (ok, not merely staged). */
export function successfulActions(parts: RunPartLike[] | null | undefined): ExecutedAction[] {
  return extractExecutedActions(parts).filter((a) => a.ok);
}
