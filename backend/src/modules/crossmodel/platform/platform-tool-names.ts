/**
 * Platform tool NAME constants — DEPENDENCY-FREE leaf module.
 *
 * Split out of platform-tools.ts so policy modules (coding/agent-profiles.ts →
 * CHAT_PROFILE_PLATFORM_TOOLS) can import the name lists without dragging in
 * platform.service's heavy chain (prisma → crossmodel.service → …) — importing
 * platform-tools.ts from coding/agent.ts's profile module created a module-
 * init-order hazard (agent.ts's CHAT_ORCH_TOOLS reads these names at module
 * scope). platform-tools.ts re-exports everything from here, so existing
 * importers are untouched. (Same leaf pattern as coding/integration-tool-schema.ts.)
 */

/** Read-only platform tools (never gated). */
export const PLATFORM_READ_TOOLS = [
  'list_chats', 'get_chat_status', 'get_chat_messages', 'list_schedules', 'get_project',
  // topology_check (session titles + topology 2026-09-27): the read-only placement verdict + goal→lane index before a spawn.
  'topology_check',
  // list_projects (ticket 3521595b): the ONLY agent-side project enumeration —
  // goal_list/todo_list/list_chats surface projects incidentally (a zero-goal,
  // zero-chat project never appears in them), so a newly created EMPTY project
  // was unenumerable by every fleet run.
  'list_projects',
  // schedule_get (ticket 9423b41b): read ONE schedule's STORED prompt back
  // verbatim (+ length + sha256) — update_schedule writes were otherwise
  // unverifiable until the next firing (write-without-read class, cf. the
  // 2026-08-10 todo_update bug). Owner-scoped, read-only, never gated.
  'schedule_get',
  // list_owner_questions (2026-09-12 spark-stall incident): gate-state probe —
  // the owner's flagged questions at their LIVE status (open | answered |
  // dismissed). Lanes and supervisors reported work as "waiting on the owner's
  // cards" when the cards were already answered a day earlier, because no
  // surface could fresh-verify a gate. Owner-scoped, read-only, never gated.
  'list_owner_questions',
  // list_feedback reads nothing the caller owns — it is ADMIN-gated at
  // EXECUTION (feedback.service isAdminUser), not by permission mode.
  'list_feedback',
  // get_feedback (audit #9d): ONE ticket's FULL row (full description +
  // adminNote + context) so lanes stop re-deriving state from list_feedback's
  // 500-char digests. Visibility-gated at EXECUTION (admin, or the filer's own
  // ticket), like list_feedback.
  'get_feedback',
  // fleet supervisor (slice D): goals / todos / hooks reads. goal_get/todo_get
  // resolve a SINGLE entity by id (read-side parity with goal_update/todo_update,
  // which already take ids directly) — the answer to "I have this id, where does
  // it live and what state is it in?" without knowing its project first.
  'goal_list', 'todo_list', 'hook_list', 'goal_get', 'todo_get',
  // infra introspection (ticket 54e0a7ea): the backend's OWN network identity
  // (live egress IP via a direct IP echo — the proxied web tools can only ever
  // report BrightData's IP). Read-only, no user data, never gated.
  'get_platform_network_info',
  // list_infra_blockers (feedback 2b45941b): the LIVE fleet-wide blocker
  // registry (read side) — a lane told by a [FLEET INFRA BLOCKER] annotation
  // to "re-verify it is cleared" fresh-checks here. Read-only, never gated.
  'list_infra_blockers',
  // list_batch_trains (T2c, todo 9c89ab21): live batch-train discovery —
  // boarding/landed/abandoned per batch/<ts> branch; the read surface behind
  // the [BATCH TRAIN ACTIVE] advisory and the batch_train merge-gate refusal.
  'list_batch_trains',
  // get_fleet_telemetry (owner 2026-09-18 — the fleet supervisor as framework
  // OPERATOR): the verification reads the human operator did by hand — main
  // head + deploy runs + the sha each box runs (view 'deploy'), per-box
  // health (view 'boxes'), one loop_metrics kind over a window (view
  // 'metrics'), the kinds seen (view 'kinds'). Platform-wide facts, so
  // ADMIN-gated at EXECUTION (like list_feedback), never by permission mode.
  'get_fleet_telemetry',
  // get_supervisor_state (autonomy loop #6, 2026-09-19): a supervisor reads its
  // OWN durable doc in full — the wake block shows only what fits 6000 chars
  // and the harness now archives stale open directives out of it. Read-only,
  // SUPERVISOR-SCOPED at execution (like update_supervisor_state), never gated.
  'get_supervisor_state',
  // account tools (2026-09-08, "Digby operates Digby"): what is set up for THIS
  // user (integrations/telegram/paired Mac/schedules/projects/memory/
  // canvases/quota/this chat), the memory facts, canvases and a
  // project's knowledge documents. Owner-scoped reads (any project member for
  // knowledge documents), never gated. Handlers: platform/account-tools.ts.
  // (Topic feeds were retired 2026-10-20, ticket 43c24152 — digests are
  // schedule_message on a real chat now.)
  'get_account_overview', 'list_memory', 'list_canvases', 'get_canvas', 'list_knowledge_documents',
  // telegram_connect_link is READ-ONLY (2026-09-08 review): it mints NO token —
  // it returns the in-app Integrations page where the user's own browser mints
  // the one-time link. No side effect ⇒ nothing to confirm (a gate here was pure
  // friction against "set up Telegram and I can message you later").
  'telegram_connect_link',
  // get_spend (capability gap audit T2, 2026-09-24 — platform/session-tools.ts):
  // trailing-window USD + tokens per model for a chat / project / account / run.
  // Owner-scoped read (project scope = any project member), never gated.
  'get_spend',
  // ops/inbox reads (capability gap audit T3a, 2026-09-24 — platform/ops-tools.ts):
  // get_model_roles is ADMIN at execution; the rest are owner-scoped.
  'get_model_roles', 'get_run_receipts', 'get_chat_autonomy', 'search_chats', 'list_pending_confirmations',
  // coordination / workspace / file reads (capability gap audit T3b, 2026-09-24 —
  // platform/coord-tools.ts): wait_for_chat is a bounded block (non-evidence);
  // session-file reads are owner-or-project-member; list_github_repos decrypts
  // the user's OWN connected tokens for one API call each.
  'wait_for_chat', 'get_chat_instructions', 'list_github_repos', 'list_session_files', 'read_session_file',
  // account defaults (T4a, 2026-09-24 — platform/housekeeping-tools.ts)
  'get_preferences',
  // fleet / ops reads (T4b, 2026-09-24 — platform/fleet-ops-tools.ts): list_instances
  // is ADMIN at execution; get_chat_webhook never returns the token.
  'list_instances', 'get_session_diff', 'resolve_id', 'get_chat_webhook',
  // test_model_role (WI-M, 2026-09-25): the POST /admin/model-roles/test twin —
  // a LIVE seat probe (real call shape, ROLE_TEST_TIMEOUT_MS per leg), ADMIN at
  // execution like get_model_roles; read-only (nothing is re-seated).
  'test_model_role',
  // decision-gate self-knowledge (rollout self-governance, 2026-09-27 —
  // platform/fleet-ops-tools.ts): the registry + modes + readiness + the
  // rollout automaton's ledger + recent auto-demotes. Read-only, never gated.
  'get_decision_gate_status',
  // self-service reads (T5, 2026-09-24 — platform/self-service-tools.ts)
  'memory_rebuild_status', 'list_chat_uploads', 'read_chat_upload',
  // the delegation ledger's reads (build 2026-10-11 DL-1 — platform/delegation-task-tools.ts): one task / the
  // caller's delegations with ONE state each — the status source that replaces polling lanes. Scoped to the caller.
  'task_get', 'task_list',
] as const;

/** Mutating platform tools — join MUTATING_TOOLS for auto/plan/ask gating. */
export const PLATFORM_MUTATING_TOOLS = [
  'create_chat', 'send_chat_message', 'start_coding_session', 'move_chat', 'rename_chat',
  'archive_chat', 'create_project', 'update_project', 'move_folder', 'schedule_message', 'cancel_schedule', 'update_schedule',
  // fleet supervisor: per-chat autonomy grant (also CONSEQUENTIAL — user-turn-only, see platform-tools.ts)
  'set_chat_autonomy',
  // fleet supervisor (slice D): goal/todo CRUD + hook wiring. Organizational
  // mutations (reversible, owner-scoped) — NOT consequential, so no
  // user-turn-anchored confirmation; an unattended supervisor chat may use them.
  'goal_create', 'goal_update', 'todo_create', 'todo_update', 'hook_subscribe', 'hook_update', 'hook_unsubscribe',
  // first-class Google Drive watch (owner-confirmed cf_822011a4): organizational
  // mutation like hook wiring — reversible, owner-scoped, NOT consequential
  // (an unattended lane must be able to arm a watch when the owner asked for it).
  'subscribe_drive_watch', 'unsubscribe_drive_watch',
  // premise register (owner 2026-09-16, item 2): the numbers a goal rests on —
  // organizational metadata on the caller's own goal, reversible, NOT
  // consequential (a machine-triggered supervisor wake must register premises).
  'goal_premise_set',
  // fleet supervisor (2026-08-22 durable-state rebuild): merge into the
  // supervisor's OWN state doc. Harmless self-state — NOT consequential (no
  // confirmation gate) and NOT autonomy-grantable: it must execute freely in
  // unattended machine runs. Dispatch refuses non-supervisor chats.
  'update_supervisor_state',
  // tailnet session-recourse (platform task 2026-08-28): bounce tailscaled in
  // the caller's OWN shared dev container — per-user scoped, reversible (the
  // daemon respawns), mid-run-safe. NOT consequential: the 2026-08-28
  // tt-quietbox window proved a machine-triggered session must reach this
  // unattended (kill on the platform-owned pid was EPERM from uid 1001).
  'restart_dev_tailnet',
  // infra-actuation lever (ticket c12239c1): env_probe / dev_container_resize /
  // reap_orphans / worker_restart against the caller's OWN dev container + the
  // coding docker host — the lever the 2026-09-09 OOM lanes lacked (14 correct
  // diagnoses ended in stand-down because no tool touches infrastructure).
  // NOT consequential: the DEFAULT posture is observe-only — mutating kinds
  // return dry-run receipts until a human arms INFRA_ACTIONS_ENABLED=1 in the
  // deployed env (the gate is the environment, not the confirmation protocol,
  // precisely so unattended machine lanes self-heal once armed; a
  // confirmation-gated tool could never fire from a machine-triggered run).
  // Hard caps (host−4GiB / host−2cpus) + per-kind+target NX cooldowns bound
  // every call; every call writes a loop_metrics infra_action receipt.
  'infra_action',
  // fleet-wide infra-blocker registry (feedback 2b45941b): the write side of
  // the registry the machine-wake seams annotate deploy-runbook firings from.
  // Reversible (clear / auto-expire), advisory-only in effect — NOT
  // consequential: the Fleet Supervisor must register/clear from unattended
  // machine wakes (a confirmation-gated tool could never fire there).
  // SUPERVISOR-SCOPED at execution (like update_supervisor_state): one
  // fleet-wide writer, so lanes never fight over the registry.
  'register_infra_blocker', 'clear_infra_blocker',
  // agent feedback loop: file_feedback is low-risk (dedup'd + rate-capped in
  // feedback.service) and reachable by EVERY worker role; update_feedback is
  // admin-gated at execution like list_feedback.
  'file_feedback', 'update_feedback',
  // "Needs owner" inbox (ticket 7705fec2): flag a question/decision for the
  // owner — it PERSISTS in the owner's inbox (Management → Inbox + the
  // sidebar rail) until answered/dismissed. Low-risk like file_feedback
  // (dedup'd + capped in platform/owner-questions.ts), NOT consequential (it
  // only files the question — no confirmation gate).
  'flag_owner_question',
  // Review 2026-09-13 issue 11: supervisor-first triage — the Fleet Supervisor
  // answers a machine lane's triaged owner question under the owner's standing
  // directives. Mutating (flips the row + wakes the lane) but NOT consequential
  // (it must execute in the supervisor's unattended wakes) and NOT autonomy-
  // grantable. SCOPE, not a gate: dispatch refuses non-supervisor MACHINE
  // callers (a lane never answers owner questions — including its own); a
  // user-present turn may call it (the owner is directing).
  'answer_owner_question',
  // User Space §4b (P3d): attach a workspace satellite to the CURRENT chat —
  // the agent-driven escalation trigger. NON-consequential: cheap, owner-
  // scoped (runs execute as the chat owner), reversible-in-effect (a dormant
  // satellite); the NEXT send routes coding automatically — the tool never
  // fires a run (shape follows flag_owner_question, not set_chat_autonomy).
  'attach_workspace',
  // platform engineering lane (Option D, 2026-08-22): every chat sees it in
  // schema; ADMIN-gated at EXECUTION (non-admins degrade to filing a feedback
  // ticket). CONSEQUENTIAL (confirmation-gated, autonomy-grantable) — see
  // platform-tools.ts.
  'dispatch_platform_task',
  // Digby Edge (Phase 5, 2026-08-30): push a message into a chat on a PAIRED
  // self-hosted instance (as UNTRUSTED machine traffic, via the local relay).
  // CONSEQUENTIAL (confirmation-gated, autonomy-grantable) — a push wakes a
  // run on ANOTHER instance, and machine-triggered sends increment the
  // cloud→edge→cloud depth counter (the loop bound).
  'send_to_instance',
  // account tools (2026-09-08, "Digby operates Digby" — platform/account-tools.ts):
  // NON-consequential, owner-scoped, reversible account mutations — auto-allowed
  // in chat runs: durable user memory (forget_fact additionally requires a live
  // user turn — a machine run may never forget), project knowledge (URL / note
  // → background ingestion), canvas rewrites, share-link revoke, standing
  // per-chat instructions, and notify_user (a rate-capped push to the user's
  // OWN linked Telegram — deliberately executable in machine-triggered runs
  // without confirmation: "set up Telegram and I can message you later").
  'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'update_canvas',
  'revoke_share_link', 'notify_user', 'set_chat_instructions',
  // email AS Digby (ticket 54f237bf): sends from the instance's OWN identity
  // (digby@digby.ai) via SMTP — machine-capable (a scheduled digest must be
  // able to send one), NON-consequential like notify_user but outbound to ANY
  // address, so it carries its own instance rate cap (30/hour) +
  // recipient-prefix-only telemetry (email/digby-email.service.ts).
  'send_email_as_digby',
  // account tools, CONSEQUENTIAL (confirmation-gated in platform-tools.ts):
  // create_share_link is NEVER autonomous — it changes the account's security
  // posture (NEVER_AUTONOMOUS_TOOLS) and is NOT autonomy-grantable
  // (AUTONOMY_GRANTABLE_TOOLS unchanged on purpose).
  // (create_feed was retired 2026-10-20, ticket 43c24152 — a topic digest is
  // schedule_message on a real chat now.)
  'create_share_link',
  // watched resources + training artifacts (remediation P7 S1b —
  // platform/resource-tools.ts): NON-consequential owner-scoped records, so an
  // unattended training lane can register/observe them freely; the EVIDENCE
  // discipline lives in the executor (machine observe_resource needs ≥1 OK
  // receipt this run; machine verify_durable additionally needs an evidence
  // line naming the uri). The attention-watchdog sweep alarms on unobserved/
  // ending resources (resources.service.sweepWatchedResources).
  // release_watched_resource (ticket a0a199f8): retires a registration (torn
  // down / reservation ended / stale duplicate) — deliberately UNGATED beyond
  // sign-in so an unattended cleanup lane can silence ghost alarms; the sweep
  // also suppresses every alarm once a resource is past its reservationEndsAt.
  'register_watched_resource', 'observe_resource', 'register_artifact', 'verify_durable', 'release_watched_resource',
  // control tools (agent capability gap audit P0, 2026-09-24 — platform/
  // control-tools.ts): stop a chat's run, answer a run's ask_user question,
  // decide a permission request, pause / resume a schedule. CONSEQUENTIAL and
  // target-scoped exactly like send_chat_message; approve_request refuses
  // ask-only (destructive) requests in machine runs at execution.
  'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
  // session/chat settings (capability gap audit T2, 2026-09-24 — platform/
  // session-tools.ts): NON-consequential, owner-scoped, reversible — the
  // session side-panel pickers as tools. set_session_permission_mode refuses
  // machine widening to 'auto' outside own children / supervisor seats.
  'set_session_model', 'set_chat_mode', 'set_session_permission_mode',
  // ops/inbox mutations (T3a): dismiss a flagged owner question (supervisor /
  // filing chat / user-present), cancel a staged confirmation card (staging
  // chat / supervisor / user-present); set_model_role_fallback is ADMIN and
  // ASK-ONLY (instance-wide setting).
  'dismiss_owner_question', 'cancel_confirmation', 'set_model_role_fallback',
  // coordination / workspace mutations (T3b): sync_workspace + stage_upload are
  // owner-scoped and non-consequential; configure_workspace + import_repo are
  // CONSEQUENTIAL (credential + clone compute — card / grant / supervisor seat).
  'sync_workspace', 'stage_upload', 'configure_workspace', 'import_repo',
  // account housekeeping (T4a, 2026-09-24 — platform/housekeeping-tools.ts):
  // knowledge file-in, canvas lifecycle, project archive, account defaults
  // (set_preferences needs a live user turn); share_canvas is CONSEQUENTIAL +
  // NEVER-AUTONOMOUS; remove_knowledge_document / delete_canvas are ASK-ONLY.
  // (The feed lifecycle tools set_feed / refresh_feed / delete_feed were retired
  // 2026-10-20, ticket 43c24152 — digests live on schedules now.)
  'add_knowledge_file', 'add_knowledge_gmail', 'create_canvas', 'share_canvas', 'revoke_canvas_share',
  'archive_project', 'set_preferences', 'remove_knowledge_document', 'delete_canvas',
  // fleet / ops mutations (T4b): digest inbox acks (own account), webhook revoke (owner).
  'ack_digest_item', 'unack_digest_item', 'revoke_chat_webhook',
  // #32 close-out (2026-09-25): CONSEQUENTIAL; the token reaches only the owner's browser.
  // Owner ruling oq_d45410a4 (d53eed71): card-free only on an EXPLICIT 'manual' grant —
  // Agent-mode-Auto never enables it (autonomy EXECUTIVE_GRANT_ONLY_TOOLS).
  'create_chat_webhook',
  // set_decision_gate_mode (rollout self-governance, 2026-09-27): the admin PUT's
  // twin for the Fleet Supervisor seat (admin owner + supervisor chat or a
  // user-present turn) — the SAME admission (caps, READY stamp, primary pin);
  // a widening act flip outside tier 1 files an owner question instead. Audited.
  'set_decision_gate_mode',
  // self-service mutations (T5): memory jobs need a live user turn; share_project /
  // add_project_member / remove_project_member are CONSEQUENTIAL + NEVER-AUTONOMOUS;
  // delete_document / delete_chat_upload are ASK-ONLY.
  'consolidate_memory', 'rebuild_memory', 'share_project', 'add_project_member', 'remove_project_member', 'resolve_feedback',
  'delete_document', 'delete_chat_upload',
  // store_secret (audit 2026-10-06 T2-3 — platform/secret-handoff-tools.ts): the
  // sanctioned owner-secret hand-off — the SERVER lifts the value from the
  // owner's own message into the encrypted coding credentials ($ENVKEY in every
  // lane shell). Value source is owner-authored at execution (this turn, or a
  // fromMessageId row the owner typed — machine runs may ONLY cite such a row,
  // ticket 37a875ee); NOT consequential (the owner's paste is the authorization
  // — a card would be one more "STOP ASKING ME").
  'store_secret',
  // destructive ↓ (also ask-only)
  'delete_chat', 'delete_project',
] as const;

/**
 * Destructive tools: ASK-ONLY regardless of permission mode — even an
 * unattended auto run must get an explicit human approval first (mirrors the
 * git safety choke points: a deterministic guard that 'auto' cannot bypass).
 */
export const PLATFORM_ASK_ONLY_TOOLS = ['delete_chat', 'delete_project',
  // instance-wide model-seat change (T3a, 2026-09-24): a human approves every call.
  'set_model_role_fallback',
  // T4a destructive housekeeping (2026-09-24): the chunks / the canvas are gone.
  'remove_knowledge_document', 'delete_canvas',
  // T5 (2026-09-24): a generated file / a chat upload are gone for good.
  'delete_document', 'delete_chat_upload'] as const;

export const PLATFORM_TOOL_NAMES: string[] = [...PLATFORM_READ_TOOLS, ...PLATFORM_MUTATING_TOOLS];
