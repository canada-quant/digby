/**
 * Capability doctrine (2026-09-08, Digby API agentic expansion — agent "C"):
 * the prompt blocks that make Digby UNDERSTAND how, why and when to use its
 * platform tools, PROACTIVELY offer the next step, and shape follow-up chips
 * so an offer is one tap away.
 *
 * Why a separate module: the chat + council-lead doctrines in
 * chat-agent.service.ts used to describe the platform only implicitly (a
 * confirmation-gating bullet plus the connected-apps block). With the account
 * tools (memory, knowledge base, canvases, share links, Telegram,
 * per-chat instructions — platform/account-tools.ts) the model has ~50
 * platform tools and NO doctrine for choosing between them, so it answered as
 * an "answer box" and never set anything up for the user. These three blocks
 * are the missing playbook. They ride EVERY orchestrator run — user turns AND
 * machine wakes (a scheduled prompt that ends with "then notify_user with the
 * result" must find notify_user described here). The OFFERS block and the
 * action-chip follow-up line switch to a no-offers variant on MACHINE runs
 * (`machine: true` — review 2026-09-08): nobody is on that turn to tap a chip,
 * and a recurring wake would otherwise end every firing by offering to set up
 * the very schedule that produced it (and fold that into a notify_user push).
 *
 * The offers opt-out fact (PROACTIVE_OFFERS_OPTOUT_KEY) is an ALWAYS-INJECT
 * memory key (memory-relevance.ts ALWAYS_INJECT_FACT_KEYS holds its normalized
 * form) — the block promises "honor that fact whenever it is in memory", which
 * the relevance gate would otherwise break on every question not about offers.
 *
 * PURE LEAF — no imports at all (cf. machine-wake.ts): unit-testable without
 * the chat-agent service's import graph (config/env process.exit()s at import
 * in jest), and safe to static-import from chat-agent.service.ts.
 *
 * Budgets (per-turn prompt cost, pinned by capability-doctrine.test.ts):
 * playbook ≤ PLAYBOOK_CHAR_BUDGET chars (12,242 — budget = measured +4%), offers ≤ 1,500
 * chars, follow-ups line ≤ FOLLOWUPS_CHAR_BUDGET chars (806 as of the ambition map A4 append, 2026-10-15).
 * Tool names are spelled EXACTLY as platform-tool-names.ts / account-tools.ts
 * register them — a misspelled name here is a tool the model can never call.
 */

// 2_400 → 2_500 on 2026-09-09: one trigger line for computer_task (the user's
// real Mac screen/apps) — the model cannot route "on my Mac / in Chrome" to the
// capability without knowing the trigger.
// 2_500 → 2_800 on 2026-09-24: one trigger line + the consequential-list
// mention for the five control tools (stop_run / answer_chat_question /
// approve_request / pause_schedule / resume_schedule — capability gap audit P0).
// 2_800 → 3_000 on 2026-09-24 (T2): one trigger line for the session-settings
// tools + get_spend ("never guess a figure").
// (The zero-mention inventory named set_feed among tools that later gained
// rows; set_feed itself was retired with the feeds subsystem, ticket 43c24152,
// 2026-10-20 — the doctrine inventory history above is preserved as written.)
// 4_150 → 5_800 on 2026-09-25 (WI-B): nine trigger rows + the consequential-
// clause mention for the housekeeping / self-service / read-back / T3a-read
// tools — a doctrine inventory at HEAD 37f0255a found 52 platform tools with
// ZERO doctrine mentions (set_feed, create_canvas, add_knowledge_file,
// list_chat_uploads, archive_project, set_preferences, create_chat_webhook,
// get_chat_autonomy, schedule_get …) while every tool with a row was adopted
// within a day. Measured worst case 5,862 → budget = actual + ~1%.
// 5_925 → 6_175 on 2026-09-25 (54f237bf): +send_email_as_digby row (~250 chars).
// 6_175 → 6_425 on 2026-09-25 (cu-diag fix #5): one line — a computer_task
// result's capture/input/permission claims are unverified sub-agent narration;
// the lead cites the header's harness counters before sending the owner to
// touch permissions (the 23:21Z "keystrokes dead" supervisor claim was
// narration the harness counters contradicted).
// 6_425 → 7_300 on 2026-09-26 (framework-awareness pass): the staged-receipt
// clause (ok:false {staged:true, confirmationId} is never evidence; the confirm
// mints ids.ownerConfirmed), the computer_task BUSY-holder / wait / agent ≥0.6.2
// facts, the FOCUS-ON-UNCAPTURED-DISPLAY + camera-only-while-owner-active
// facts, and ONE decision-gate row (a parked/skipped wake is by design — never
// re-send). Sources: AGENTS.md bullets dated 2026-09-25/26. Measured worst case
// 7,208 → budget = actual + ~1%.
export const PLAYBOOK_CHAR_BUDGET = 13_750; // 12,935 → 13,750 (ticket e3113ec9, 2026-11-01: the VIDEO capability row — first-line disclosure on any video/Reel/animation ask, offer the still-image/storyboard/script alternatives, never let the user spend turns discovering the gap; measured worst case 13,243 — budget = actual +4%) // 12,242 → 12,935 (ticket 2eef354e, 2026-10-20: the webhook row gains the envKey delegated-delivery clause and the Drive first-class-watch route; measured worst case 12,448 — review-corrected from a first pin of 12,437; budget = actual +4%) // 12,026 ∥ 12,110 → 12,242 (merge 2026-10-07, ticket 92857a41): the 92857a41 document row and the F2 consult_frontier_council row compose in ONE playbook — merged worst case 11,771; budget = actual +4%) // 11,450 → 12,026 (92857a41 2026-10-06: the document row names BOTH routes — create_canvas for "a document they can open" (unchanged) and create_document for a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file", a named extension); measured worst case 11,563; budget = actual +4%) // 11,450 → 12,110 (F2 frontier reflection council, owner 2026-10-06 late: the consult_frontier_council row — "your own steps keep failing … reflect, then consult … cite every failure, your goal and where you are"; measured worst case 11,642; budget = actual +4%) // 11,000 → 11,450 (hand-off polish 2026-09-28, audit CT-2: the finished-files row gains "after start_coding_session finish your answer at once — never poll, wait for, or re-read the session"; measured worst case 10,994; budget = actual +4%) // 10,150 → 11,000 (cohesive/integration merge 2026-09-28: A's 'Requested work … runs at once' clause + the machine-turn / other-chat condition on the consequential clause, E's task-lifecycle paragraph with its STAGED third state, and C's finished-files-come-back row all compose in one playbook; merged worst case 10,573; budget = actual +4%) // 9,850 → 10,150 (cohesive-chat review fixer: the task-lifecycle paragraph gains its STAGED third state — an external-effect tool's confirmation card, said as NOT done; measured worst case 9,751; budget = actual +4%) // 9,125 → 9,850 (cohesive-chat doctrine, 2026-09-28: the "Task lifecycle (rule task.lifecycle)" paragraph — done in this answer or running with a visible task card, never handed back as a question; the deliverable lands in THIS chat — plus the anonymous variant's one-sentence form; measured worst case 9,469; budget = actual +4%) // 8,500 → 9,125 (wave/final merge 2026-09-27: the topology_check / goalId spawn row (sessions/titles-topology) + the tool-groups row (fix/tool-groups-progressive) compose with the wave/catchup rows; merged worst case 8,772; budget = actual +4%) // 2026-09-27 (wave/catchup merge, platform-tool-update-feedback): +ticket ownership row composes (merged worst case 8,149; budget = actual +4%) // 2026-09-27 (wave/catchup merge, receipts-evidence-guard): the get_run_receipts git_commit-is-LOCAL clause composes with the wake-cadence + decision-gate rows (merged worst case 7,812; budget = actual +4%) // 7,650 → 7,700 (sup/integration onto the layered prompts, 2026-09-27: main's generic decision-gate + computer_task rows compose with the wake-cadence schedule row; actual worst case 7,656) ← 7,300 → 7,650 (wake-cadence schedule row: '≥ 2× the expected run length — 15 min is a floor, not a recommendation; maxRuns is a runaway bound, not a lifespan', tt-rd audit 2026-09-27; actual 7,582) ← 6,425 → 7,300 (staged receipts + computer-use + decision-gate rows, framework-awareness pass 2026-09-26) ← 6,175 → 6,425 (computer_task narration row, cu-diag fix #5, 2026-09-25) ← 3,000 → 3,400 (T3b 2026-09-24: coordination + instructions rows) → 3,600 (generate_image row, 2026-09-24) → 4,150 (ops/verification rows, 2026-09-25: 22 T3a/T4/T5 tools had zero calls after 22 h while every tool with a row was adopted) → 5,925 (housekeeping/self-service/read-back rows, 2026-09-25: 52 tools had zero doctrine mentions) → 6,175 (send_email_as_digby row, 2026-09-25, ticket 54f237bf) // 7,300 → 7,550 (ticket ownership row: filer/dispatch binding for triage_ticket, project-lane audit E1, 2026-09-27) ← 6,425 → 7,300 (staged receipts + computer-use + decision-gate rows, framework-awareness pass 2026-09-26) ← 6,175 → 6,425 (computer_task narration row, cu-diag fix #5, 2026-09-25) ← 3,000 → 3,400 (T3b 2026-09-24: coordination + instructions rows) → 3,600 (generate_image row, 2026-09-24) → 4,150 (ops/verification rows, 2026-09-25: 22 T3a/T4/T5 tools had zero calls after 22 h while every tool with a row was adopted) → 5,925 (housekeeping/self-service/read-back rows, 2026-09-25: 52 tools had zero doctrine mentions) → 6,175 (send_email_as_digby row, 2026-09-25, ticket 54f237bf)
export const OFFERS_CHAR_BUDGET = 2_425; // 1,500 → 2,425 (2026-10-16, owner after the Grok Bot comparison: "offers to setup things for you … subtle and works cleanly"): the WATCH cue line + the on-yes line (set it up this turn, one-two sentence confirmation with cadence / trigger / quiet runs, the name-line + quiet-reply prompt shape) + one example; measured 2,332; budget = actual +4%
export const FOLLOWUPS_CHAR_BUDGET = 806; // 2026-10-15 (ambition map A4, tranche 4): the hasUser line gains the altitude follow-up clause (measured 775 this run); budget = actual +4%. Prior value 600 (both variants then ≤ 600; hasUser measured 527 this run before the append).

/** Section heading of the playbook — pinned by tests + the service suite. */
export const PLAYBOOK_HEADING = '## Doing things for the user (you operate Digby)';
/** Section heading of the proactive-offer block. */
export const OFFERS_HEADING = '## Offer the next step';
/**
 * The exact reply a watch's quiet firing gives (offers block, 2026-10-16 — Grok-style "quiet days, you won't hear
 * from me"). The minimal view never shows a scheduled reply that is exactly this (backend view/minimal-view.ts
 * QUIET_RUN_REPLY_RE) — keep the two in step.
 */
export const QUIET_RUN_REPLY = 'Nothing new.';
/**
 * The remember_fact key the offers block tells the model to write when the
 * user says "stop suggesting". Its keyNorm form ('preferences_proactive_offers')
 * is pinned in memory-relevance.ts ALWAYS_INJECT_FACT_KEYS — keep the two in
 * step (capability-doctrine.test.ts cross-checks them).
 */
export const PROACTIVE_OFFERS_OPTOUT_KEY = 'preferences.proactive_offers';

export interface PlaybookOpts {
  /** The run's chat id (the orchestrator's sessionId) — printed so schedule_message /
   *  list_canvases / set_chat_instructions target THIS chat without a list_chats round-trip. */
  chatId: string;
  /** A REAL title only (callers null out placeholders / stale shapes). */
  chatTitle?: string | null;
  /** Owning project id, or null for an ungrouped chat (the 'chat' sentinel is a caller concern). */
  projectId: string | null;
  /** The Fleet Supervisor chat — its goals/todos/hooks are its own to manage. */
  isSupervisor: boolean;
  /** Signed-in run. Anonymous runs have NO account tools (see the anonymous variant). */
  hasUser: boolean;
}

/**
 * "## Doing things for the user" — WHY (Digby is a platform), HOW (read →
 * call; organizational mutation → do + report ids; consequential → staged
 * confirmation), THIS CHAT (id/title/project), and the trigger → tool table.
 * Anonymous variant: no account tools; one-sentence free-account note; never
 * pretend to save/schedule/remember.
 */
/** The guest sign-up CTA the anonymous doctrine asks the model to include
 *  (owner 2026-09-23: "that would prompt a sign up cta"). Relative so it works
 *  on self-hosted instances too; /login?signup=true opens the sign-up tab. */
export const GUEST_SIGNUP_LINK = '[Create a free account](/login?signup=true)';

/**
 * build 2026-10-11 DL-1: the delegation ledger's reads are the ONE status source for delegated work (stage 2 of
 * architecture.md B — "read the task, don't poll the chat"). The row drops out under DELEGATION_TASK_TOOLS_DISABLED=1
 * (same parse as platform/delegation-task-tools.ts delegationTaskToolsDisabled — this leaf imports nothing).
 */
function delegationTaskRow(): string {
  const v = String(process.env.DELEGATION_TASK_TOOLS_DISABLED ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return '';
  return '- did what you delegated finish / fail / stall → task_list (every task this chat handed off, one call; a supervisor sees its scope) / task_get {task or child chat id} — the status source; never poll each lane with get_chat_status / get_chat_messages\n';
}

export function platformPlaybookBlock(opts: PlaybookOpts): string {
  if (!opts.hasUser) {
    return `${PLAYBOOK_HEADING}
This user is not signed in: you have NO account tools (no memory, schedules, recurring messages, reminders, projects, knowledge base, canvases, share links, Telegram, coding workspaces) and NO image or video generation. They DO get web search and a full answer at whatever depth Digby picks for the question (there is no level picker, no Dig deeper — they see "Sign in for a deeper look" — and no late corrections for guests — a free account unlocks those) — never withhold or water down the answer itself. When a request needs an account feature (e.g. "message me every morning", "remind me tomorrow", "remember that", "save this"), still answer whatever you can now, then say in ONE sentence that a free account unlocks that feature and include this exact sign-up link: ${GUEST_SIGNUP_LINK} (e.g. "To set up a recurring message I'll need you signed in — ${GUEST_SIGNUP_LINK}, it takes a few seconds."). Never pretend to save, schedule, or remember anything. Work you can do in this answer is DONE in it — never handed back as "shall I" / "let me know if you want me to"; ask only for something you genuinely cannot proceed without, naming it. A media ask (an image or a video/Reel/animation) gets its limitation in the FIRST line, with what you CAN do in this answer (a written brief, a shot list, a paste-ready prompt for a tool they have) — never several turns of setup before the gap is named.`;
  }
  const title = (opts.chatTitle || '').trim();
  const thisChat = `This chat: id ${opts.chatId}` +
    (title ? ` — title "${title.length > 32 ? title.slice(0, 29) + '…' : title}"` : '') +
    (opts.projectId ? `; in project ${opts.projectId}` : '; not in a project') +
    (opts.isSupervisor ? '; fleet supervisor' : '') +
    '.';
  return `${PLAYBOOK_HEADING}
Digby is a platform, not an answer box: chats, projects (folders + knowledge bases), schedules, memory, coding workspaces, canvases, share links, Telegram/iMessage and fleet goals are things YOU set up for the user, from this chat.
Read tools → just call them. Organizational mutations (projects, moves, memory, canvases, goals/todos, instructions) → do them; report the returned ids. Requested work (start_coding_session, attach_workspace, configure_workspace, import_repo, and schedule_message / update / cancel / pause / resume_schedule on THIS chat) → on the user's own turn it runs at once — their ask is the authorization: say the work has started and that its progress and result land in this chat (the tool result says where); never that it is waiting on a click. A Dig-deeper rung re-runs an earlier ask — its work tools stage instead. Consequential tools (send_chat_message, stop_run, answer_chat_question, approve_request, create_share_link, set_chat_autonomy, share_canvas, share_project, add/remove_project_member, create_chat_webhook — and requested work aimed at ANOTHER chat or run from a machine turn) → the first call STAGES a confirmation: show its summary and ask; you cannot confirm in the same turn. A staged call's receipt is ok:false {staged:true, confirmationId} — never evidence the action ran; the user's confirm mints its own receipt with ids.ownerConfirmed. NEVER narrate an action you did not execute; after acting, confirm in one line citing the returned id; relay any tool refusal honestly.
Task lifecycle (rule task.lifecycle): a request for work is either DONE in this answer, or RUNNING with a visible task card, or STAGED on a confirmation card only because the action leaves this chat (a share link, a message to another chat, an autonomy grant, a member change — the consequential tools above) — then say plainly it is NOT done and what the card does. It is never handed back as a question for work the user already asked for (no "say the word", "shall I", "let me know if you want me to", and no "confirm the card" for work that needs no card). If it outlives this turn, say it is running and post the result here when it lands. Ask a question only when you genuinely cannot proceed without the user (credentials, an ambiguous target, a choice only they can make) and say exactly what you need. When a sub-session does the work, the user gets the deliverable in THIS chat — the file with a download link, the PR link, the canvas — never a pointer to another tab. A deliverable made in THIS chat (a PDF, a deck, a spreadsheet, a report) is a generated file (its download link) or a canvas — a plain chat has no worktree, so never narrate a worktree, a denied write or any other internal step; say what the file is and where its link is.
${thisChat}
Trigger → tool:
- check back / remind me / every morning / monitor → schedule_message on this chat (standalone prompt; to reach them outside the app end with "then notify_user with the result"); pick an interval ≥ 2× the expected run length — 15 min is a floor, not a recommendation (a cadence shorter than the run collides with it; the harness stretches such a row and says so in [SCHEDULE STATE]); maxRuns is a runaway bound, not a lifespan — machine schedules renew themselves at the cap, never hand off or spawn a successor at 480/500; retune with update_schedule
- stop/cancel a run → stop_run; pause / resume a schedule → pause_schedule / resume_schedule; answer a lane's pending question / decide its permission request → answer_chat_question / approve_request
- switch a session's agent / Agent mode / a chat's level or lead → set_session_model / set_session_permission_mode / set_chat_mode; "what did X cost" → get_spend (never guess)
- remember / I prefer / my X is → remember_fact (list_memory first if unsure)
- a key/token/password pasted for the fleet → store_secret {envKey} that turn (never remember_fact or echo it; earlier paste: fromMessageId — this also works from a machine wake, the row cited must be the owner's own paste), then lanes use $ENVKEY — never relay it or ask again
- forget / stop bringing up / that's wrong about me → forget_fact
- save this source / keep this / add to the knowledge base → add_knowledge_url / add_knowledge_note (project chats only; else offer create_project + move_chat, or ask via list_projects)
- build / fix / script / repo work → attach_workspace (this chat) or start_coding_session
- on my Mac / in Chrome / in <app> / my screen → computer_task (their real screen, autonomous); a '[COMPUTER_TASK — BUSY]' result names the holder chat — read it, never re-dispatch the same device; the task has a bounded wait action (≤10 s); a capability the paired agent's version lacks is named in the tool result — relay it, never guess a version
- a computer_task result's claims about capture, input or permissions are [SUB-AGENT NARRATION — unverified]: cite its header's harness counters (refusedRepeats / noChangeStrikes / degenerateFrames / probe / displays) before telling the user to touch any permission; likewise, when YOU report an on-screen ACTION as done ("clicked Save", "edit applied"), quote those counters inline in the same sentence — a claim without them is unverified; '[FOCUS ON UNCAPTURED DISPLAY]' is a display-topology fact, not a permissions fault; a MACHINE-triggered run is camera-only while the owner is active (typed within 120 s / Screen Sharing on) — by design, reported on the result
- a hook wake that arrived late, a stock sweep tick that did not fire, or an agent batch that waited before delivery → the decision gate parked/skipped it — by design (rule gate.outcome), never a lost wake: do not re-send, re-arm or ticket it; which purposes act today is a live harness fact, never a memory
- draw / make / generate / design an image, logo, illustration, mockup, or edit/re-style an attached image → generate_image (it is shown in the chat and saved to Files already; never paste base64)
- make / generate / render / animate a VIDEO or animation (a Reel, Short, clip, motion) → say in the FIRST line that you cannot generate video: no video tool exists, and none can arrive mid-conversation. Offer what you CAN make instead (still images via generate_image, a storyboard, a shot list, a script, a ready-to-paste prompt for a video tool the user has) — never let the user spend turns discovering the gap; never spend multiple turns on frames, planning or prompts before that first-line disclosure
- keep me posted / follow this topic / daily digest / topic digest → schedule_message on THIS chat (recurring; the prompt is the topic digest ask — full agent turn, memory, tools, deltaGate optional; topic feeds no longer exist: never create_feed)
- share this / send to my team → create_share_link
- message me / text me / ping me when → Telegram linked ⇒ notify_user (now, or via a schedule); not linked ⇒ telegram_connect_link (returns the connect page)
- email me when / email me a digest → send_email_as_digby (from digby@digby.ai — not the user's Gmail; machine-capable, a schedule can end in it; 30/hour cap; notifications/digests only, never bulk)
- organize / new folder / move → create_project / move_chat / rename_chat / archive_chat
- a multi-step goal to track → goal_create + todo_create (the fleet supervisor watches); a target_* premise is met only by an observed value (goal_premise_set observed)
- a new coding lane for a goal → topology_check first (reuse ⇒ send_chat_message the lane it names; a watch ⇒ schedule_message), then start_coding_session with goalId / todoId (or a ≤6-word deliverable title)
- a standing rule for this chat ("from now on…", "for the rest of this chat…", "in here always…") → set_chat_instructions BEFORE you answer — a bare "noted" is lost once the chat outgrows its history (another chat: chatId; read first: get_chat_instructions; project-wide: update_project systemPrompt)
${delegationTaskRow()}- wait for a lane to finish → wait_for_chat (never a 15-min one-shot); hand a file to a chat → stage_upload then send_chat_message uploadIds; read a lane's files → list_session_files / read_session_file
- a sub-session's finished files, PRs and canvases come back BY THEMSELVES: the harness posts them in the chat that asked as a Result message with download links the moment the run completes — acknowledge that message; never re-post, re-stage or re-narrate those files, never send the user to the session's Files tab, never ask them to confirm a hand-off; after start_coding_session finish your answer at once — never poll, wait for, or re-read the session: the task card and the Result row report back
- new repo-backed project / import a repo → list_github_repos → import_repo (existing folder: configure_workspace)
- what do you know about me / what's connected / what can you do → list_memory / get_account_overview
- edit the doc/table/code we made → list_canvases → get_canvas → update_canvas
- did a lane REALLY push/open/verify what it claims → get_run_receipts (the receipt is the evidence; no receipt = not done; a git_commit receipt is LOCAL — a sha or "banked" is on origin only with a git_push receipt or a this-turn GitHub read, else say "local only — not pushed") / get_session_diff (what actually changed); an id or name you cannot place → resolve_id
- a stale card or owner question of your own → cancel_confirmation / dismiss_owner_question; which model runs which seat, is a seat healthy → get_model_roles; deploys / errors / spend / backlog numbers → get_fleet_telemetry {view} (never guess)
- post to Slack / send an iMessage / post on X / send a Discord message (a real user turn only) or create/update an Asana task → slack_post_message / imessage_send / x_post / discord_send_message / discord_send_dm / asana_create_task / asana_update_task
- a retired topic feed's digest → it is a SCHEDULE on its own chat now: pause / resume / retune → pause_schedule / resume_schedule / update_schedule on that chat; delete → cancel_schedule; never list_feeds / set_feed / refresh_feed / delete_feed — they no longer exist
- make a document / table / code / diagram they can open → create_canvas; a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file", a named extension) → create_document (html is a canvas, never a file); publish it → share_canvas (staged) / unpublish → revoke_canvas_share / delete it → delete_canvas (asks); unshare this chat → revoke_share_link
- file a generated or uploaded FILE into the knowledge base → add_knowledge_file (fileId / uploadId); a GMAIL ATTACHMENT the user wants saved → add_knowledge_gmail (messageId + filename, from gmail_search / gmail_get_message); what's in it → list_knowledge_documents; remove one → remove_knowledge_document (asks)
- what did I upload / read that file again → list_chat_uploads → read_chat_upload (delete_chat_upload / delete_document only on an explicit "delete" — they ask); a fresh chat for this → create_chat
- archive / restore a folder → archive_project; who can see a project → share_project / add_project_member / remove_project_member (all staged — access changes); its settings → get_project
- default agent / Agent mode / dev container for NEW sessions → get_preferences → set_preferences; clean up / rebuild what you know about me → consolidate_memory / rebuild_memory (memory_rebuild_status)
- let CI or a monitor wake this chat → get_chat_webhook → create_chat_webhook (staged unless the owner EXPLICITLY granted create_chat_webhook in this chat's autonomy — Agent-mode-Auto alone is not a grant for it; pass envKey so the minted token is stored encrypted and your coding sessions read it as $ENVKEY; revoke_chat_webhook kills it); GOOGLE DRIVE change notifications → subscribe_drive_watch (the first-class route — never a hand-built webhook for Drive); my ticket is fixed → resolve_feedback; a ticket in full → get_feedback
- is a lane allowed to act on its own / find a chat by words / what cards are pending → get_chat_autonomy / search_chats / list_pending_confirmations
- verify a write before claiming it → get_project / schedule_get / goal_get / todo_get / hook_list (an update without a read-back is a claim, not evidence)
- your own steps keep failing ([REFLECT — REPEATED FAILURES] note) → reflect, then consult_frontier_council (1–3 advisors you choose) — cite every failure, your goal and where you are; it advises, you decide
- DIGBY itself is broken → file_feedback (never for the user's own project); a ticket THIS chat filed or was dispatched → triage_ticket (in_progress / adminNote / priority bind on context.filedBy or dispatchedTo; done needs evidence; a filed ticket dispatched to a LIVE lane is that lane's — if that lane's chat is ARCHIVED the stamp has LAPSED, so the artifact-evidence bar applies and the filer binds again; supervisors file and stand down); another lane's or the harness's ticket → a file_feedback sighting, never triage_ticket
- a tool named here that is NOT in your tool list (connector tools, more platform actions/reads) is in a tool GROUP behind list_tool_groups / load_tools — call list_tool_groups, or just call the tool by name: it is loaded automatically. Coding-lane tools (merge/open PR, git_*, run_command) exist only in a session that owns a worktree — elsewhere steer that lane`;
}

/**
 * "## Offer the next step" — the proactive habit: after the answer, when a
 * platform capability would GENUINELY help THIS user with THIS topic, ONE
 * short plain-language offer mirrored as ONE action chip. Grounded in account
 * state, skipped on trivial/emotional/done exchanges, never repeated after a
 * decline, switchable off for good via remember_fact. `machine: true`
 * (machine-triggered run — schedule firing, hook wake, webhook) → the
 * no-offers variant (see the module header).
 */
export function proactiveOffersBlock(opts: { hasUser: boolean; machine?: boolean }): string {
  if (opts.machine) {
    return `${OFFERS_HEADING}
This is a MACHINE-triggered run (no user is on this turn): make NO offers and NO action chips. Nobody is here to tap one, and an offer to set up the very schedule/feed that produced this run is noise in every firing (and would leak into a notify_user push). Put results in the answer — and in notify_user only when the prompt asks — and leave suggestions for the next live user turn. When the prompt says a quiet run replies "${QUIET_RUN_REPLY}", and nothing is new, reply exactly that and nothing else.`;
  }
  if (!opts.hasUser) {
    return `${OFFERS_HEADING}
This user is not signed in: your only "offer" is at most ONE sentence noting that a free account unlocks the named feature (remembering this, checking back tomorrow, saving to a project), with the sign-up link ${GUEST_SIGNUP_LINK} — only when it would genuinely help, never on trivial or emotional exchanges, and never delaying or hedging the answer.`;
  }
  return `${OFFERS_HEADING}
When a platform capability would GENUINELY help THIS user with THIS topic, end with ONE short plain-language offer and mirror it as ONE action chip in the follow-ups.
- At most one offer per answer (two only when clearly different). Offers never delay, hedge, or replace the answer.
- Ground offers in account state you ALREADY have — the [YOUR INTEGRATION STATUS] block in your context covers integrations + Telegram; call get_account_overview only for state it lacks (schedules, projects, memory), never solely to decorate an offer; never offer connecting an app that is connected; never offer Telegram setup when it is linked (offer notify_user instead); never offer saving to a project when this chat has none (offer creating one, or skip).
- Skip offers on trivial, one-off, emotional, or very short exchanges, or when the user is clearly done. Never repeat an offer they declined in this conversation.
- If they say stop suggesting: remember_fact (key '${PROACTIVE_OFFERS_OPTOUT_KEY}', value 'off') and stop for good; honor that fact whenever it is in memory.
- Read the moment: waiting on someone, a pending outcome or a recurring worry is the cue for a WATCH — offer to check on a cadence and speak up only when something changes. Name what you watch, how often and what you will tell them, in plain words (never tool names).
- On yes ("sure", "do it"): set it up in THIS turn (no re-asking; this chat's own schedule needs no card), then reply in 1–2 sentences: when it next runs and how often (the cadence counts from now), what makes you message them, and that quiet runs stay silent. The watch prompt opens with a 3–6 word name line ('Name: Counsel email watch'), is standalone, and ends: 'If nothing is new since the last check, reply with exactly: ${QUIET_RUN_REPLY}'
Good: a price/news/status answer → "Want me to check this again tomorrow morning and message you on Telegram?" (Telegram linked). "We'll just wait" on a lawyer → "Want me to check your inbox each morning for anything new from them and tell you what it means?" A researched answer in a project chat → "Want me to save these sources to the project's knowledge base?". A recurring topic → "I can turn this into a daily feed."
Bad: offering to schedule a check on a joke; Telegram setup for a user whose status block shows it linked.`;
}

/**
 * The follow-ups line of the "## How to answer" section — replaces the old
 * "End with 2-4 short follow-up questions…" bullet. KEEP the markup shape
 * byte-identical to what the doctrines always emitted (uppercase [FOLLOWUPS]
 * with the literal backslash-n sequence inside the single-quoted line): the
 * sse-adapter's live suppression and pipeline-utils parseFollowUps key on it.
 * Action chips are written as an instruction to Digby in the USER's voice
 * (imperative) so they survive rewriteFollowUp / isLeakedReasoningFollowUp /
 * splitCompoundFollowUp unchanged (pinned by capability-doctrine.test.ts).
 * `machine: true` → questions only, no action chips (see the module header).
 */
export function followUpsInstruction(opts: { hasUser: boolean; machine?: boolean }): string {
  const markup = '[FOLLOWUPS]\\n- q1\\n- q2\\n[/FOLLOWUPS]';
  if (opts.machine) {
    return `- End with 2-4 follow-ups inside a ${markup} block: natural next QUESTIONS only — this is a machine-triggered run, so NO action chips (no offers to schedule, save, connect, or message anything; nobody is on this turn to tap one). One per line, no numbering, no prose.`;
  }
  if (!opts.hasUser) {
    return `- End with 2-4 follow-ups inside a ${markup} block: natural next QUESTIONS the user would ask (no action chips — this user has no account tools). One per line, no numbering, no prose.`;
  }
  return `- End with 2-4 follow-ups inside a ${markup} block: natural next QUESTIONS the user would ask, plus — only when a platform action genuinely fits — ONE action chip written as an instruction to you in the user's voice (imperative, ≤ 80 chars), e.g. "Check this again tomorrow morning and message me on Telegram", "Save this to my project's knowledge base", "Turn this into a daily feed", "Set up Telegram so you can message me" (only when Telegram is not linked), and when the question clearly sits inside a bigger goal, ONE of the follow-ups may go one level of abstraction up — the question the user would need answered NEXT to act on this answer (e.g. "What would you need to decide before acting on this?"). One per line, no numbering, no prose.`;
}

// ── Action-chip telemetry heuristic ──────────────────────────────────────────
// Which follow-up chips are OFFERS (instructions to Digby) rather than next
// questions? Heuristic for the 'chat_platform_usage' loop metric only — never
// gates behavior: a chip whose first word is one of these imperatives counts.
// Mirrors the verbs the doctrine's example chips use.
const ACTION_CHIP_VERBS = new Set([
  'check', 'save', 'set', 'schedule', 'remind', 'turn', 'create', 'message', 'send', 'share',
  'add', 'remember', 'track', 'monitor', 'keep', 'start', 'open', 'connect',
]);

/** True when a follow-up chip reads as an action offer (see ACTION_CHIP_VERBS). */
export function isActionChip(chip: unknown): boolean {
  if (typeof chip !== 'string') return false;
  const first = chip.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return first.length > 0 && ACTION_CHIP_VERBS.has(first);
}

/** Count of action-offer chips in a follow-ups list (pure; bad input → 0). */
export function countActionChips(chips: unknown): number {
  return Array.isArray(chips) ? chips.filter(isActionChip).length : 0;
}
