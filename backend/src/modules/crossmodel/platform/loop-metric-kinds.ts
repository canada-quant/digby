/**
 * LOOP_METRIC_KINDS — the canonical loop-metrics kind registry, extracted to
 * an IMPORT-FREE LEAF (ticket 6665fff6, review A8): the acceptance-metric
 * validator (feedback/ticket-metric.ts) reads the registered kinds to refuse
 * typo'd params at filing, and must not drag loop-metrics.service's
 * env-validating import chain (logger → config/env, which process.exit(1)s in
 * a Jest worker) into every suite that imports it. loop-metrics.service
 * re-exports everything below, so existing importers are unchanged.
 */

/** Canonical metric kinds. The column is deliberately an open string (new
 *  kinds must not need a migration), but wiring should use these constants. */
export const LOOP_METRIC_KINDS = {
  /** a self-merge gate refused a merge_pull_request attempt (owner 2026-09-09
   *  self-merge follow-on) — meta { gate, cause, repo, pullNumber, cycles } */
  MERGE_GATE_FAILURE: 'merge_gate_failure',
  /** merge_pull_request confirmed merged:true — the success counterpart of
   *  MERGE_GATE_FAILURE so merge outcomes chart as a rate, not failures alone:
   *  meta { repo, pullNumber, mergeSha, cycles (prior gate-failure cycles),
   *  machineTriggered } */
  MERGE_SUCCESS: 'merge_success',
  /** self-merge WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27): the tool
   *  slept once, harness-side, on a timing-class gate failure before re-running
   *  the gates — meta { kind: 'ci_pending' | 'merge_in_progress' | 'server_5xx',
   *  waitedMs, repo, pullNumber, headSha?, ciP50Ms? }. Every merge_gate_failure
   *  row now also carries meta.headSha (+ waitKind / waitedMs when a wait
   *  preceded it) so red-on-head can be measured. */
  MERGE_WAIT_ONCE: 'merge_wait_once',
  /** goal-continue telemetry (agent-decisions prerequisite 6, 2026-09-27): ONE
   *  row per goal-continue EVALUATION at the end of a top-level auto run whose
   *  plan still has unfinished steps — meta { round (rounds granted so far),
   *  progressed (the plan board or the worktree changed since the last round),
   *  stalls (consecutive no-progress rounds after this one), evidenceToolCalls,
   *  unfinished, resumed (the harness granted another round: progressed OR
   *  stalls < 2), max }. The trimmed terminal checkpoint (run-state.ts) keeps
   *  the same counters so the `goal_continue_worth` decision is replayable. */
  GOAL_CONTINUE: 'goal_continue',
  /** tt-rd audit 2026-09-27 (kpi-honesty-loops): a goal's kpi: premise was set
   *  / moved from a verified receipt — meta { goalId, projectId, key, value,
   *  prev, receiptId (8), tool, bar }. */
  KPI_PREMISE_SET: 'kpi_premise_set',
  /** a supervisor reply typed a rate in the KPI's unit that differs from the
   *  register value without citing the key; the harness appended the
   *  '(KPI of record: …)' footer — meta { chatId, key, quoted[], registered,
   *  receiptId, machine }. Observe-only. */
  KPI_REPLY_MISMATCH: 'kpi_reply_mismatch',
  /** turn continuation (cohesive-chat wave 2026-09-28; chat-agent/turn-continuation.ts):
   *  one row per lifecycle step of a human ask the harness finished in the
   *  background — meta { chatId, taskId, round, reason, outcome: 'armed' |
   *  'arm_failed' | 'posted' | 'failed' | 'cap' | 'waiting_user' | 'rearmed' }.
   *  Kill switch TURN_CONTINUATION_DISABLED=1. */
  TURN_CONTINUATION: 'turn_continuation',
  /** harness-measured ADOPTION LADDER signal: a goal's KPI has not moved
   *  toward its bar for K experiments / H hours on its assignee lanes —
   *  meta { goalId, projectId, lane, experiments, hours, kpiKey, woken }.
   *  One row per [NO-ADOPTION] wake (deduped 24 h per goal). */
  ADOPTION_LADDER: 'adoption_ladder',
  /** the Mission KPI contract REFUSED a goal_premise_set call — the ONE deterministic
   *  gate on the kpi-honesty branch, unmeasured until the 2026-09-27 fixer follow-up:
   *  meta { gate:'kpi_contract', reason: 'no_receipt' | 'second_kpi' | 'receipt_missing'
   *  | 'receipt_not_ok' | 'other_project', goalId, projectId, key, receiptId (8),
   *  sessionId }. Refusal rate = refused / (refused + kpi_premise_set). */
  KPI_PREMISE_REFUSED: 'kpi_premise_refused',
  /** a loop guard fired and struck (blocked/limited an action) */
  GUARD_STRIKE: 'guard_strike',
  MARKDOWN_LINT_STRIKE: 'markdown_lint_strike',
  /** the filer duplicate-retire rail executed (ticket 76045f4e, 2026-10-16):
   *  the session that filed a ticket retired it as a linked duplicate of a
   *  server-verified canonical row — meta { ticketId, duplicateOf, filerClass:
   *  'supervisor'|'lane' }. Before the rail, that retire had NO lawful
   *  machine path (the 76045f4e specimen: 4 refusals, owner closed both
   *  dupes by hand). */
  FILER_DUPLICATE_RETIRE: 'filer_duplicate_retire',
  /** a ticket's dependency set was written (9dacab1a — the queue's
   *  dependsOnTicketIds layer): meta { ticketId, deps (8-char ids),
   *  cleared }. The dispatcher holds the ticket until every blocker
   *  closes, then dispatches it automatically. */
  TICKET_DEPENDENCY_SET: 'ticket_dependency_set',
  /** the post-deploy done-bar refused a machine close to done (ticket 6665fff6
   *  — b4824553's lifecycle half): the cited fix could not be positively
   *  proven merged ∧ deployed — meta { ticketId, reason }. The close was
   *  refused; nothing mutated. */
  TICKET_DONE_BAR_REFUSAL: 'ticket_done_bar_refusal',
  /** the post-deploy verifier job (6665fff6) ruled on a metric-carrying
   *  ticket — meta { ticketId, verdict: 'deployed_verified'|'reopened'|
   *  'waiting'|'unmeasurable', probe, measured?, target }. One row per
   *  ruled/watIing tick per in-flight ticket. */
  TICKET_POSTDEPLOY_VERIFIER: 'ticket_postdeploy_verifier',
  /** the ticket-drain pre-spawn status re-read caught a ticket that CLOSED
   *  between the drain's scan and its lane spawn (1a6afc6a — the dispatch/close
   *  TOCTOU): the spawn was skipped, claims released, cap token refunded —
   *  meta { phase:'pre_spawn', laneFor, blocked:['<id8>:<status>'],
   *  family?, members? }. Value 1 per catch; absence = the window stayed
   *  clean. One row per blocked spawn, never per drain. */
  TICKET_DISPATCH_CLOSE_RACE: 'ticket_dispatch_close_race',
  /** the evidence guard threw mid-evaluation — its verdict is PARTIAL (2026-09-08 audit) */
  GUARD_ERROR: 'guard_error',
  /** a loop guard evaluated and deliberately let the action through */
  GUARD_MISS: 'guard_miss',
  /** an in-flight detached CHAT run was interrupted by a process shutdown
   *  (blue-green deploy teardown) — meta { reason:'deploy', chatId?, runKey }
   *  (feedback 56159c5a: deploys silently killed unanswered chat turns) */
  CHAT_RUN_INTERRUPTED: 'chat_run_interrupted',
  /** WI-G (2026-09-25): a MACHINE chat run on a RETIRING colour was told once,
   *  at its next tool round, to write its final now — meta { chatId?, step,
   *  remainingSeconds, isSupervisorWake } (kill switch DEPLOY_RETIRE_NUDGE_DISABLED=1) */
  DEPLOY_RETIRE_NUDGE: 'deploy_retire_nudge',
  /** a scheduled wake was delivered to its session */
  WAKE_DELIVERED: 'wake_delivered',
  /** a wake was parked (session busy/offline) for later delivery — meta.reason:
   *  'busy' | 'triage' (wake_triage act) | 'preempted_redelivery' | 'turn_noop'
   *  (agent-decisions 2026-09-27: supervisor_turn_noop act skipped a sweep firing /
   *  parked an agent drain; meta { origin:'sweep'|'drain', consecutive, p, deferMs? }) */
  WAKE_PARKED: 'wake_parked',
  /** one finalized run's total spend — value = USD (recordRunSpend) */
  RUN_SPEND: 'run_spend',
  /** Seats govern sessions (2026-09-28): one admin "Apply seats to existing sessions"
   *  run (POST /admin/model-roles/apply-seats) — value = sessions re-stamped;
   *  meta { dryRun, seat, projects: {cleared, kept}, sessions: {restamped, explicit, alreadyOnSeat}, prefs: {explicit, ignored} } */
  SEAT_APPLY: 'seat_apply',
  /** one finalized run's prompt tokens per model — value = tokens, meta.model */
  RUN_TOKENS_IN: 'run_tokens_in',
  /** one finalized run's completion tokens per model — value = tokens, meta.model */
  RUN_TOKENS_OUT: 'run_tokens_out',
  /**
   * E5 context_window_used (R&D stream 3 experiment #5, 2026-09-26): the
   * per-model context FILL at run finalize — the largest single-turn
   * prompt_tokens the provider reported for that model in the run (the peak
   * transcript size the loop actually fed), as a ratio against the model's
   * known context window. One row per model that reported usage. value =
   * peakPromptTokens (tokens), meta { model, windowTokens, fillRatio
   * (0..1+, peak/window), peakPromptTokens }. Measure-only: no refill or
   * compaction decision reads it yet — this is the surfaced primitive that
   * future compaction triggers (and the 2026-09-25 contextChars
   * "raise further once per-step cost/latency at high fill is validated"
   * note in coding-model.ts) can be tuned against.
   */
  RUN_CONTEXT_FILL: 'run_context_fill',
  /** frontend UX beacon (perceived latency / rage-click / abandon) — wired
   *  2026-09-26 (compute policy step 0): POST /ux/beacon records
   *  { event: 'first_paint' | 'revision_seen' | 'tap' | 'abandon', chatId?, messageId?, ms?, mode? } */
  UX_BEACON: 'ux_beacon',
  /** Stream drops (2026-10-20, chat-agent/stream-drops.ts): a viewer's SSE connection closed BEFORE the final event
   *  while its run was still active — value = the connection's lifetime ms; sessionId = the chat id or `anon-<sid>`;
   *  meta { surface: 'stream' | 'attach' | 'guest', path: 'local' | 'remote', elapsedMs, eventsWritten,
   *  runElapsedMs?, guest, host, colour? } (never text). Throttled per chat / session + per process.
   *  Kill switch SSE_DROP_TELEMETRY_DISABLED=1. */
  SSE_VIEWER_DROP: 'sse_viewer_drop',
  /** Stream drops (2026-10-20): a viewer REATTACHED to a live / just-finished run (GET /chats/:id/stream or the guest
   *  GET /session/:sessionId/stream) — meta { surface: 'attach' | 'guest', source: 'local' (this box's buffer, whole)
   *  | 'remote' (the other box's Redis mirror) | 'truncated' (either replay lost its head), events?, guest, host,
   *  colour? }. Same throttle + kill switch. */
  SSE_REATTACH: 'sse_reattach',
  /** compute policy (2026-09-26): ONE row per non-machine chat turn — value =
   *  TTFT ms (first 'chunk' after run start; undefined when no chunk streamed),
   *  meta { mode, preset, ttftMs?, completionMs, guest } */
  UX_TTFT: 'ux_ttft',
  /** dynamic roster phase 4 (roster 2026-10-06 D-1, chat-agent/session-roster.ts): ONE row per persisted session
   *  roster turn on a plain chat — meta { chatId, planLane, ranLane, needLane, sessionLanePrev, sessionLane, lead,
   *  checker, colleagues, callIn, mode, acts, priorLaneRead, legacyPriorLane, rosterPriorLane, sticky?, escalation? };
   *  sessionId = the chat. Kill switch SESSION_ROSTER_DISABLED=1 (no row). */
  SESSION_ROSTER: 'session_roster',
  /** the lead's call_in tool (roster 2026-10-06 D-2, chat-agent/call-in.ts): phase 'offer' — once per human turn the
   *  tool is offered (meta { roles, mode, canary }); phase 'call' — one row per call (meta { outcome: ok | empty |
   *  error | timeout | cancelled | refused | repeat, reason?, role, model, family, leadModel, leadFamily, ms,
   *  windowMs, chars, webToolCalls, toolCalls }). sessionId = the chat. Kill switch CALL_IN_DISABLED=1 (no rows). */
  CALL_IN: 'call_in',
  /** F2 frontier reflection council (owner 2026-10-06 late, coding/frontier-council.ts): phase 'armed' (the reflect
   *  note was injected — meta { trigger, failures, step, defaults }), 'run' (one row per council — value = usdEst;
   *  meta { councilId, trigger, models, chosenBy: agent | harness, ok: {model: bool}, latencyMs, usdEst, failures,
   *  redactions, agreement, autoReason? }), 'refused' (meta { reason: no_trigger | run_cap | window_consumed |
   *  daily_cap | bad_models | unknown_model | no_reflection | no_question | no_models | error }), 'no_models' (the
   *  trigger met on an instance with no servable frontier model). Every row carries meta.machine. The advisor
   *  calls' spend rides run_spend rows with meta.profile 'reflection_council'. Kill switch
   *  FRONTIER_REFLECTION_COUNCIL_DISABLED=1 (no rows). */
  FRONTIER_COUNCIL: 'frontier_council',
  /** F1 frontier pick rule (owner 2026-10-06 late, platform/roster-policy.ts): ONE row per process when the stored
   *  autoPickPolicy says 'all' but the pickers ignore it — meta { stored: 'all', effective: 'open_only', reason }. */
  AUTO_PICK_POLICY: 'auto_pick_policy',
  /** one verify chain failed ENVIRONMENTALLY (OOM/SIGKILL — exit 137 or a
   *  diagnostics-free non-zero exit; verify.service classification, 2026-09-10):
   *  meta = { stage, exitCode }, recorded with the sessionId so infra-red rates
   *  are chartable apart from code-red fix-loops */
  VERIFY_ENV_RED: 'verify_env_red',
  /** T2e (todo a04cda91, ticket 7ec6200b, 2026-10-17): one verify stage died
   *  at the harness per-command TIMEOUT (the '— timed out' exec stamp) — split
   *  OUT of the environmental class: a hung test may be a code defect (an
   *  infinite loop, a deadlock), so it is surfaced as a FAILURE with its own
   *  kind, while OOM/SIGKILL stays env-classified (never a code failure).
   *  meta = { stage, timeoutMs }. */
  VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout',
  /** A4 (2026-09-27 spark-cluster audit): the harness auto-verify (or the
   *  lane's own `verify` call) found NO verify chain — `.digby/config.json`
   *  absent or without runnable typecheck/lint/test commands — so nothing
   *  verified this run beyond the lane's own probes. ONE row per skip:
   *  meta = { projectId, reason:'no_chain', seam:'auto'|'tool', configPresent }.
   *  Recorded unconditionally since 2026-11-02 (row + event + status line). */
  VERIFY_ABSENT: 'verify_absent',
  /** DW-2 (backlog 2026-10-02; FO f118, 2026-10-11): .digby/config.json exists
   *  but could not be READ or PARSED (readDigbyConfigDetailed third arm) —
   *  read error, truncated write, trailing comma, BOM. The verify tool answer
   *  names the file + error; this row is the audit's observe-only record.
   *  Kill switch: none needed (observe-only surfacing, no behavior change). */
  VERIFY_CONFIG_READ_ERROR: 'verify_config_read_error',
  /** A1 (2026-10-04 coding quick wins, coding/verify-unchanged-skip.ts): the
   *  harness auto-verify did NOT run the chain because the worktree content is
   *  unchanged since this session's last GREEN verify of the same chain (the
   *  earlier pass stays the evidence; nothing is re-recorded). ONE row per skip:
   *  meta = { seam:'auto', reason:'unchanged_since_green', stages, lastGreenAt,
   *  lastGreenSha, captureMs, autoVerifyIters }. Kill switch
   *  AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1 (the chain runs on every finish). */
  VERIFY_UNCHANGED_SKIP: 'verify_unchanged_skip',
  /** build 2026-10-09 VS (coding/verify-container-slots.ts): ONE row per verify chain the per-CONTAINER slot
   *  limiter decided — value = waitedMs (unit 'ms'), meta = { seam:'tool'|'auto', outcome:'immediate'|'acquired'|
   *  'timeout'|'fail_open'|'no_limit', container, capGiB, slots, holders, position, waitedMs, reason? }. 'timeout' =
   *  the chain was DEFERRED after the bounded wait. Kill switch VERIFY_SLOT_LIMIT_DISABLED=1 (no rows). */
  VERIFY_SLOT_WAIT: 'verify_slot_wait',
  /** ff262da5 (2026-10-16): the ENV-STARVED verify verdict — the chain did NOT
   *  run because the environment could not host it (container working-set ≥
   *  VERIFY_PRESSURE_DEFER_PCT default 85, host MemAvailable floor, or the
   *  session's own background-process allowance). meta carries the arm and
   *  the measured numbers. Observe-only — the audit bakes verify_env_red /
   *  env-starved rates per day; this row is the AFTER-number series for the
   *  ticket's MEASURE bar. Kill switch: VERIFY_SESSION_ALLOWANCE_DISABLED=1
   *  stops the defers, not the metric. */
  VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred',
  /** one infra_action decision (ticket c12239c1 — the infra-actuation lever):
   *  every call writes ONE row, dry-run/refused/cooldown included, so the owner
   *  can review a week of dry-run receipts before arming INFRA_ACTIONS_ENABLED=1:
   *  meta { action, target, dryRun, executed, reason, refused?, cappedBy?, cooldown?, error? } */
  INFRA_ACTION: 'infra_action',
  /** one utilityChat call where BOTH providers (DeepSeek primary + DashScope fallback) failed */
  UTILITY_LLM_DUAL_FAILURE: 'utility_llm_dual_failure',
  /** a supervisor wake note that ended in an explicit no-op (or a markerless one-liner) —
   *  HARNESS-classified by classifySupervisorNote (supervisor.service), recorded by the
   *  attention-watchdog note scan; never model-claimed */
  SUPERVISOR_NOOP: 'supervisor_noop',
  /** a supervisor wake note carrying an ACTIONS TAKEN receipt marker — harness-classified */
  SUPERVISOR_ACTION: 'supervisor_action',
  /** any other substantive supervisor wake note (narration without an action receipt) */
  SUPERVISOR_NOTE: 'supervisor_note',
  /** HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20; platform/harness-receipts.ts): one row per
   *  supervisor MACHINE wake finalize — the harness record appended in place of the model-typed ACTIONS TAKEN
   *  block. value = executed real actions; meta { mode: actions | reported | noop | noop_present | record,
   *  harnessActions, reportUps, notExecuted, modelBlockLines (lines of the model's own block stripped — the
   *  model-claimed vs harness-recorded comparison), tools, seat, origin }. Kill switch
   *  SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1. */
  SUPERVISOR_HARNESS_RECEIPTS: 'supervisor_harness_receipts',
  /** a supervisor chat's OWNER-turn reply carried harness-impersonating chrome and
   *  the forged-chrome strip removed it (ticket 0c647003, 2026-10-24) — meta
   *  { blockLines, forgedLines, seat, origin, ownerTurn:true }. Strip-only: a
   *  clean reply stamps nothing. Kill switch SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED=1. */
  SUPERVISOR_FORGED_CHROME: 'supervisor_forged_chrome',
  /** one finalized chat run's web-grounding footprint (owner 2026-09-03 —
   *  search-force removal): meta = { mode, webToolCalls } where webToolCalls
   *  counts the run's search_engine / scrape_as_markdown / browser_task /
   *  web_pipe calls, so grounding rates are chartable post-launch */
  CHAT_SEARCH_USAGE: 'chat_search_usage',
  /** patience plan 1a (2026-09-25): the stream controller REFUSED a deep_research
   *  send on the daily council quota — meta = { scope:'user'|'anon', anon,
   *  mode, routingSource, limit, used, autoOnly, demoted } (demoted = the
   *  patience_auto_only switch turned the refusal into an Ensemble run) */
  DEEP_RESEARCH_QUOTA_REJECTED: 'deep_research_quota_rejected',
  /** one finalized chat run's PLATFORM footprint (2026-09-08 agentic
   *  expansion — the capability playbook teaches Digby to operate the
   *  platform for the user and offer next steps): meta = { mode,
   *  platformToolCalls, tools, actionChips, machine } where platformToolCalls
   *  counts the run's calls to PLATFORM_TOOL_NAMES tools (schedules, memory,
   *  feeds, knowledge base, canvases, projects, fleet…), tools = the distinct
   *  platform tool names called (≤ 12, first-seen order), actionChips = the
   *  follow-up chips that read as action offers (imperative first word —
   *  capability-doctrine.ts countActionChips), so platform adoption and the
   *  offer rate are chartable beside CHAT_SEARCH_USAGE */
  CHAT_PLATFORM_USAGE: 'chat_platform_usage',
  /** ticket 4ac547de (2026-10-17): the deterministic follow-ups backstop for
   *  zero-chip Level 2 human turns fired — meta { got, outcome: ok | empty |
   *  error | timeout, timeoutMs } (FOLLOWUP_BACKSTOP_DISABLED=1 kills both the
   *  call and this row). */
  FOLLOWUP_BACKSTOP: 'followup_backstop',
  /** ticket 8aa5688f (2026-10-26): the platform executed a scheduled run's
   *  mandated trailing notify_user at the finalize (the model's tool rounds
   *  were exhausted by the data pull — the ping could not depend on a spare
   *  round). meta { scheduleId, outcome: ok | refused | unparsed | error,
   *  detail?, error? } — the envelope is PARSED, so a rate-capped or
   *  unlinked refusal is recorded as refused, never as sent
   *  (SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1 kills both the call and this row). */
  SCHEDULED_NOTIFY_BACKSTOP: 'scheduled_notify_backstop',
  /** a finalized chat run narrated a web-attempt FAILURE its own parts do not
   *  back — the claiming text sits where NO web tool call had run yet (ticket
   *  1ef71188: "the search came back garbage" with zero preceding web calls;
   *  the same run's post-claim re-test came back healthy): meta = { mode, tier:
   *  'midturn'|'final', selfCorrected, excerpt, machine }. Telemetry only —
   *  the detector is precision-gated (chat-agent/phantom-tool-claim.ts) and a
   *  mid-turn claim can self-correct inside the same turn. */
  CHAT_PHANTOM_WEB_CLAIM: 'chat_phantom_web_claim',
  /** a HUMAN-turn chat final ended by handing the asked work BACK as a
   *  question while work evidently remained (cohesive-chat program: "say the
   *  word and I will search her thread next" after the deadline cut the run,
   *  "confirm the card" on a staged start_coding_session): meta = { chatId,
   *  phrase, strength:'strong'|'soft', excerpt, deadlineHit, stepsExhausted,
   *  stagedCard, continuationCue, mode, supervisor }. Observe-only — the
   *  detector (chat-agent/handback-detector.ts, rule task.lifecycle) records,
   *  never rewrites. */
  HANDBACK_DETECTED: 'handback_detected',
  /** Nightly live-chat audit summary over the last 24 h of real human turns (platform/live-chat-audit.ts, 2026-10-04). */
  LIVE_CHAT_AUDIT: 'live_chat_audit',
  /** one finalized CODING run's memory/embeddings-grounding footprint (owner
   *  2026-09-04 "doesn't read memory or embeds very often"): value = total
   *  search_memory + search_code_semantic calls in the orchestrator transcript,
   *  meta = { trigger, searchMemory, searchCode, grep, readFile, webPipe } so
   *  retrieval-vs-raw-read ratios are chartable. Orchestrator-lane only —
   *  worker calls are visible via CODING_RETRIEVAL_HITS below. */
  CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage',
  /** one row per search_memory / search_code_semantic CALL (orchestrator AND
   *  workers — recorded at the shared tool executor): value = hits returned,
   *  meta = { tool, scope?, source? }; value 0 charts the empty-result rate */
  CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
  /** run-start PROJECT MEMORY injection into a coding run (owner 2026-09-14
   *  "coding sessions must read the project knowledge base and project
   *  decisions"): one row per coding run that ATTEMPTED the injection
   *  (session has a project + a task text), value = items
   *  injected into the [PROJECT MEMORY — relevant to this task] block (0 charts
   *  the empty rate), meta = { trigger, chars, sources: {source: n}, candidates }
   *  — sources are the unified store's 'learning' / 'decision' + the federated
   *  knowledge base's 'document' (never 'code': search_code_semantic covers it) */
  CODING_MEMORY_INJECTED: 'coding_memory_injected',
  /** one home-screen starter-question generation for one user (owner
   *  2026-09-08 "are you sure it is reasoning for these?"): value = chips
   *  kept, unit 'chips', meta = { outcome: 'cached'|'cached_without_critic'|
   *  'defaults_low_yield'|'defaults_no_candidates', drafted, mechanicalDrops,
   *  drops: {reason: n}, sourceCheck: 'applied'|'skipped', usedCritic,
   *  criticDrops, kept, fromChats, codes: {criticCode: n}, factCount,
   *  chatCount, draftMs, criticMs } so chip quality (critic reject rate,
   *  sub-3 fallbacks to defaults) is chartable instead of anecdotal */
  SUGGESTED_QUESTIONS_QUALITY: 'suggested_questions_quality',
  /** the decision gate (platform/decision-gate.ts, 2026-09-24) asked the
   *  `decision` seat a typed question, or recorded what the reasoning path
   *  actually did next to it. Two phases under one kind:
   *   - phase 'decision': value = ms; meta { id, purpose, mode, ok, backend,
   *     answers: {q: {noul|choice+confidence|score+confidence}}, stateChars, error? }
   *   - phase 'outcome':  value = 1 agreed / 0 disagreed (absent when unknown);
   *     meta { id, purpose, mode, backend, question, predicted, confidence,
   *     actual, acted, agreed? } — the shadow-mode agreement + calibration signal */
  DECISION_GATE: 'decision_gate',
  /** compute policy (2026-09-26, platform/compute-policy-gate.ts recordComputePolicyTelemetry): ONE row per
   *  human chat turn — meta { planSource, preset, spawnChecker, checkerWaitMs, council, leadEffort, mode,
   *  decisionId?, ttftMs?, budget:{checker, checkerEffort, council, maxBackgroundMs} (no maxUsd since 2026-09-27 — no cost cap), guest?,
   *  escalationRung?, check? }; value = ttftMs when known. The DepthPlan / DepthBudget the turn ran under,
   *  chartable next to decision_gate rows by decisionId. */
  COMPUTE_POLICY: 'compute_policy',
  /** Laya follow-up (2026-09-26): a SAMPLED decision state (opt-in DECISION_GATE_STATE_SAMPLE_RATE) —
   *  { id, purpose, questionsHash, stateChars, state (capped), questions, backendSpec }; the readiness cron
   *  prunes the kind after DECISION_GATE_STATE_RETENTION_DAYS (28). decision-gate.ts writes it through its
   *  own DECISION_GATE_STATE_KIND constant (its unit suites mock this map with DECISION_GATE only). */
  DECISION_GATE_STATE: 'decision_gate_state',
  /** audit budgets-cost-6 (2026-09-26): a decision backend answered 401/403 and was LATCHED (event 'latched' — the
   *  first of an episode — / 'relatched' after a failed half-open probe / 'recovered' when a probe answered; meta
   *  { event, spec, backend, status, purpose, cooldownMs, relatches, since, downMs? }), or EVERY leg of an ask failed
   *  (event 'all_legs_failed', meta { purpose, legErrors, streak } + since ticket 4d476b9a { cause: stall | egress |
   *  provider | mixed | budget, legTimings[] (round 2: + dispatchLagMs?, wireLateMs?, stallConfirmed), loopBusyMs?,
   *  loopBusy?, stallRetried, streakExempt? } — a cause-'stall' row (every timeout a CONFIRMED stall) never advances
   *  the streak; decision-gate-stall.ts). decision-gate.ts writes it through its own
   *  DECISION_GATE_BACKEND_DOWN_KIND constant (its unit suites mock this map with DECISION_GATE only); the infra-watch
   *  sweep and get_fleet_telemetry view 'boxes' read it. */
  DECISION_GATE_BACKEND_DOWN: 'decision_gate_backend_down',
  /** DECISION-GATE-LIFECYCLE (2026-10-20, platform/decision-gate-rollout.ts planLifecycle): the rollout automaton
   *  set a SHADOW purpose OFF through the admin path — rule 'review_by' (a shadow_review purpose past its registry
   *  reviewBy date with its reviewBar unmet) or 'non_converging' (measured AUROC < 0.6 on ≥ 200 labels over ≥ 10 d;
   *  one re-pose ticket filed). ONE row per retirement — meta { purpose, rule, from, to:'off', detail, auroc, n,
   *  days, partition, reviewBy?, ticketId?, dryRun }. Kill switch DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED=1. */
  DECISION_GATE_LIFECYCLE_RETIRED: 'decision_gate_lifecycle_retired',
  /** the git_commit shrink guard refused a commit (I1, remediation 2026-09-09 —
   *  a merge "resolution" left tracked files at 0 bytes on an external repo's
   *  main for 22h): value = flagged files, meta = { files: [{file, reason}],
   *  allowShrink } so gutted-commit attempts are chartable */
  MERGE_SIZE_GUARD: 'merge_size_guard',
  /** a user-typed message preempted (requested cancellation of) a REPLAYABLE
   *  machine-triggered plain-chat run (owner incident 2026-09-04 — 12 min of
   *  silence behind machine traffic): meta = { local } (was the run cancelled
   *  in-process, or via the cross-instance stop flag) */
  CHAT_PREEMPTION: 'chat_preemption',
  /** ticket a5b36dc6: the preempt path stamped the supervisor-state INFLIGHT
   *  marker (markPreemptedInflight) — the next turn on that chat renders the
   *  [PREEMPTED RUN — ACTION IN FLIGHT] guard block from a live journal read */
  INFLIGHT_PREEMPT_MARK: 'inflight_preempt_mark',
  /** a configured SEAT failed and the built-in served instead. Two shapes
   *  under the one kind (both name the role so the admin Endpoints panel can
   *  badge a flaky seat — countSeatFallbacksByRole):
   *   - orchestrator/supervisor (2026-09-11 — the glm-5.3 supervisor seat
   *     returned no output on 23/124 wakes): meta = { seat, failedSeat,
   *     fallbackModel, recovered, toolCalls }
   *   - helper seat (2026-09-14 — a custom coding_helper endpoint 400'd
   *     tool-bearing worker turns and timed out digests; helper-seat.ts
   *     noteSeatFallback): meta = { role, from, to, reason, status:
   *     'recovered' | 'failed' | 'unavailable' | 'retrying', caller?, httpStatus? } */
  SEAT_FALLBACK: 'seat_fallback',
  /** coding-run final persisted as EXTREME degenerate output — provider-side
   *  corruption (custom LiteLLM endpoint; ticket e8f71984): final row is
   *  multilingual garbage tokens with no sentence structure. Detect-and-mark
   *  ONLY (metadata outputDegenerate + this row); never replaces or retries.
   *  meta = { ticket: 'e8f71984', seam: 'final_persist', chars?, families?,
   *  glueRatio?, terminatorDensity?, wordRatio? } */
  DEGENERATE_FINAL: 'degenerate_final',
  /** seat governance (audit E3, 2026-09-27 — model-roles.service
   *  assertAssignable): a frontier-class registry model (provider-class.ts)
   *  was assigned to, or probed on, a governed chat / supervisor seat or its
   *  fallback: meta = { role, spec, slot: 'seat' | 'fallback', outcome:
   *  'observed' (default — visibility only) | 'refused' (FRONTIER_SEATS_REFUSE=1
   *  on a save) | 'allowed_by_owner' (refusal on, owner-confirmed card),
   *  probe: boolean }. Never written on the run path. */
  SEAT_GOVERNANCE: 'seat_governance',
  /** a turn returned no content because the thinking budget ate max_tokens
   *  (finish_reason length / reasoning-only) and was retried once with a bigger
   *  budget and less reasoning (2026-09-11, turn-recovery.ts): meta = { model,
   *  finishReason, reasoningChars, maxTokens, reasoningEffort, lastStep } */
  TURN_TRUNCATION_RECOVERY: 'turn_truncation_recovery',
  /** ticket efdb3d31 (2026-10-29) — OBSERVE-ONLY finalize-seam diagnosis. ONE
   *  row per model turn whose slot table holds a named call that would dispatch
   *  UNPARSEABLE (the "Unexpected end of JSON input" class), carrying the three
   *  data points needed to separate the remaining mechanisms instead of guessing
   *  a seventh attribution rule: the provider's finishReason (a 'length' cap cut
   *  is otherwise invisible — isEmptyTruncatedTurn bails as soon as any tool call
   *  exists), the slot-table SHAPE (counts + which unnamed slots are complete and
   *  would be discarded by finalize's `.filter(tc => tc.name)`), and a verdict
   *  naming which of no_complete_payload / complete_not_prefixed /
   *  ambiguous_complete the table fits. BYTE-FREE: lengths, counts, slot indexes
   *  and sanitized parse-reason heads only — never payload content.
   *  meta { verdict, finishReason, slots, named, unnamed, broken:[{k,name,len,
   *  reason}], discardedComplete:[k], claims:[{k,owners:[k]}], model, label,
   *  sessionId, runId }. Never changes what the turn does. */
  TOOL_CALL_FINALIZE: 'tool_call_finalize',
  /** ticket efdb3d31 (2026-10-29) — SEVERED-STREAM RECOVERY. The SSE transport
   *  closed WITHOUT its `data: [DONE]` terminator while a tool call was still
   *  streaming, so we re-emitted the turn ONCE instead of dispatching a partial
   *  call. The gate is STRUCTURAL (a payload that stops mid-structure) and
   *  `turn.streamCompleted` is only a DISCRIMINATOR over the transport story —
   *  the retired 200d9d0b form's `=== false` precondition is NOT the switch, and
   *  asserting it here is what made a Fleet read propose an already-shipped
   *  widening (corrected 2026-10-30). This row is also the
   *  telemetry that makes the Fleet's named probe answerable from DATA: it
   *  carries `rz` (reasoningChars) and `len` (per-call argLen) on the SAME row,
   *  which no earlier finalize/dispatch row ever did.
   *  meta { rz, len[], calls, finishReason, model, label, caps }.
   *  `rz`/`len` are short keys on purpose — the reader cuts meta at 240 chars.
   *  Kill switch: SEVERED_STREAM_RECOVERY_DISABLED=1. Never changes what a turn
   *  EXECUTES: the re-emit is a retry, and the original partial call is still
   *  discarded, exactly as before this row existed. */
  SEVERED_STREAM_RECOVERY: 'severed_stream_recovery',
  // ── Remediation P0 kinds (2026-09-09 autonomy-remediation program, phase 0;
  //    see docs/reviews/2026-09-09-autonomy-remediation-record.md). All are
  //    fire-and-forget observations of EXISTING behavior — no site changes what
  //    it does, only reports it. (Their LOOP_METRICS_P0_DISABLED kill switch was
  //    never forwarded to prod — deleted in build 2026-10-08 S-2.) ──
  /** one idle/pressure worktree reap (project-workspace reapIdleWorktrees):
   *  meta = { chatId, reason: 'idle'|'disk_pressure', provider? } */
  WORKTREE_REAPED: 'worktree_reaped',
  /** One row per worktree-reaper pass: worktree count, bytes freed, usage %. */
  WORKTREE_REAP_PASS: 'worktree_reap_pass',
  /** one Digby-identity email attempt (ticket 54f237bf — email/digby-email.service):
   *  meta = { outcome: 'sent'|'send_failed'|'rate_limited'|'not_configured', to:
   *  recipient PREFIX only (local-part capped + domain — never the full address,
   *  never the body), messageId?, cc?, subjectChars?, textChars?, error? } */
  DIGBY_EMAIL_SENT: 'digby_email_sent',
  /** one learnings/code index sync pass that changed rows: meta = { index:
   *  'code'|'learnings', projectId, changed/added, removed } */
  INDEX_SWEPT: 'index_swept',
  /** a coding-memory REPLACE (storePut over an existing blob) shrank the
   *  stored bytes >30% — possible memory loss, observed NOT prevented (the
   *  replace behavior itself is Phase 8's): meta = { scope: 'project'|'user',
   *  beforeBytes, afterBytes } */
  MEMORY_SHRUNK: 'memory_shrunk',
  /** scaffolding.service could not commit the scaffold/docs-refresh it wrote:
   *  meta = { project, lane: 'scaffold'|'docs_refresh', error } */
  SCAFFOLD_COMMIT_FAILED: 'scaffold_commit_failed',
  /** the provider REJECTED a model call (agent.ts model-turn catch): meta =
   *  { status, chars (transcript at rejection), attempt, outcome?, lane? } +
   *  the run stamp (+ providerError when the drained body carried a reason).
   *  outcome (remediation P1 oversize shrink-retry): 'shrink_retry' = the loop
   *  shrank the largest tool results and retried; 'gave_up' = recovery budget
   *  exhausted, the run finalized with an honest error note. lane (ticket
   *  6d633649): 'size' = 400/413/malformed class; 'transient' = 429/5xx/
   *  network class — gave_up fires for BOTH (previously size-only, which left
   *  pure-429 give-ups invisible here). */
  PROVIDER_REJECTED: 'provider_rejected',
  /** the schedule sweeper skipped a due firing because the session was busy
   *  (fireScheduleTarget → {started:false, reason:'busy'}): meta = { scheduleId } */
  SCHEDULE_BUSY_SKIP: 'schedule_busy_skip',
  /** blank-session provisioning was DEFERRED to the claiming worker (FO
   *  2026-09-23 cross-box fix): the web box marked the session ready WITHOUT a
   *  worktreePath because its box-local worktree would be invisible to the
   *  coding worker that claims the run. meta = { sessionId } */
  BLANK_PROVISION_DEFERRED: 'blank_provision_deferred',
  /** repo-backed provisioning was DEFERRED off a NON-volume-owner web box
   *  (ticket a086c69d, 2026-09-28): web boxes that don't own the coding
   *  workspaces volume were building worktrees against a STALE copy of it —
   *  diverging volume copies and stranding sessions (ENOENT on
   *  .digby/rules/00-current-state.md, forced re-provisions). The web process
   *  now flips the session ready WITHOUT a worktreePath; the volume-owner
   *  worker's ensureRunnable re-provisions on first run. meta = { sessionId } */
  REPO_PROVISION_DEFERRED: 'repo_provision_deferred',
  /** the coding worker SELF-HEALED a stranded blank session (worktreePath set,
   *  dir absent on this box, zero completed runs): rebuilt the standalone repo
   *  locally before executing the run. meta = { sessionId, hadWorktreePath } */
  BLANK_PROVISION_SELFHEAL: 'blank_provision_selfheal',
  /** the coding worker SELF-HEALED a local-provider project's bare mirror at
   *  session start (hardening loop iteration 10): the mirror was missing on
   *  disk and ensureProvisioned re-created it (init --bare + seed) before the
   *  reattach. meta = { projectId, mirrorExisted } — mirrorExisted:false marks
   *  a real heal, true a no-op ensure on a surviving mirror. The FO audit's
   *  i10_hardening_check section reads this kind (PR #1043). */
  LOCAL_MIRROR_SELFHEAL: 'local_mirror_selfheal',
  /** build 2026-10-08 ISO — per-user workspace subtree (coding/workspace-layout.ts + -placement.ts).
   *  meta.phase: 'placement' (a NEW worktree / mirror placed: { what, layout, reason }) | 'container'
   *  (a session container CREATED: { layout, mount: scoped|user_subtree|whole_volume, hardened }) —
   *  the "scoped provision ≥ 99 %" bar | 'dev_uncovered' (the user's subtree-mounted dev container cannot
   *  see this session → per-session fallback) | 'dev_mount' (dev container create/converge: { plan,
   *  perUser, legacy, extraMirrors, outcome }) | 'migration' (one migrated / reverted item or the run
   *  summary from scripts/framework-audit/migrate-workspace-per-user.js). Read by the integrator's canary
   *  query (AGENTS.md ISO bullet). Switch CODING_WORKSPACE_PER_USER_SUBTREE. */
  WORKSPACE_ISOLATION: 'workspace_isolation',
  /** build 2026-10-08 ISO — credential proxy (coding/credential-proxy.ts). meta.phase: 'env' (one per
   *  shell-capable run: { mode: direct|proxy|fail_to_direct, rawPlatform, userManaged, reason? } — the
   *  "0 raw credentials in the session shell env" bar) | 'request' (one proxied git pack op / API call:
   *  { provider, op: fetch|push|info_refs|api, status, ok, ms }) — the "push/pull ≥ 99 %" bar.
   *  Switch CODING_CREDENTIAL_PROXY. */
  CREDENTIAL_PROXY: 'credential_proxy',
  /** the loop's one-time pre-finish self-audit fired (agent.ts goal-continue:
   *  all plan steps done → "re-verify acceptance criteria" round granted) */
  SELF_AUDIT_RUN: 'self_audit_run',
  /** Self-audit churn containment (tt-rd audit 2026-09-27): the pre-finish
   *  self-audit round was NOT granted — meta { reason: 'plan_unchanged' |
   *  'gate' | 'duplicate_step' | 'receipt_rule', steps, receipts?, stepId?,
   *  mode? }; stamp.selfAuditRoundId pairs it with the run's run_spend row.
   *  Before this kind the alreadyAudited skip left NO row (the dedupe's
   *  effectiveness was unreadable from the DB). */
  SELF_AUDIT_SKIP: 'self_audit_skip',
  /** Self-audit receipt rule CONTROL row (act mode, 1-in-10 sample): the rule
   *  would have skipped the round but it RAN — meta { reopened, steps,
   *  receipted } labels the rule's false-skip rate (checkReceiptRuleDemotion
   *  reads these; base 1.8 % + 2 pt over ≥ 30 rows demotes act → shadow). */
  SELF_AUDIT_CONTROL: 'self_audit_control',
  /** Self-audit receipt rule SHADOW label (fixer 2026-09-27, finding 5): every
   *  receipt-rule-evaluated round that RAN outside the control sample — meta
   *  { wouldSkip, mode, reopened, steps, receipted, reasons, rejectBacksAfter,
   *  guardStrikesAfter }. reopened ⇔ the rule would have been WRONG to skip.
   *  The promotion readout (checkReceiptRulePromotion → store
   *  ['instance','self-audit-receipt-rule']/readiness) reads the wouldSkip:true
   *  rows; self_audit_control stays the act-period demotion bar. */
  SELF_AUDIT_SHADOW: 'self_audit_shadow',
  /** A MACHINE run changed the cadence (intervalSec) of an OWNER-ARMED schedule
   *  (promptSetBy user / legacy null) — observe-only (fixer 2026-09-27, AUDIT
   *  CHURN finding 1: the doctrine scopes "lengthen its cadence" to machine-armed
   *  rows); meta { scheduleId, kind, fromIntervalSec, toIntervalSec, promptSetBy }. */
  SCHEDULE_OWNER_CADENCE_EDIT: 'schedule_owner_cadence_edit',
  /** A RECURRING schedule fired on a plan board that is already 100 %
   *  complete — every step completed; a blocked step makes it a wait lane,
   *  which never takes this path (tt-rd audit 2026-09-27 finding 5) — the firing got
   *  the advisory [ALL-COMPLETE BOARD] notice (or, opt-in, was skipped):
   *  meta { scheduleId, steps, planUnchangedSinceLastFire, action:
   *  'notice' | 'skip' }. */
  SCHEDULE_ALLCOMPLETE_FIRING: 'schedule_allcomplete_firing',
  /** an agent_runs lease heartbeat write failed (P3 pin 14c — previously
   *  swallowed; a run whose lease lapses is re-claimable by another worker):
   *  meta = { runId } */
  LEASE_HEARTBEAT_FAILED: 'lease_heartbeat_failed',
  /** FO firing 46 (2026-09-29): the lease heartbeat touched 0 rows — the run's
   *  durable row is gone (chat deleted mid-run, agent_runs cascaded) and the
   *  executor cancelled the zombie execution through the Stop-release path.
   *  Before this, chat 5a87b912's zombie ran ~90 min doing real GitHub actions
   *  with 97 FK-failed receipt/journal writes. meta = { runId, reason }. */
  ZOMBIE_RUN_STOPPED: 'zombie_run_stopped',
  /** FO firing 47 (2026-09-29): the Digby Edge 'utility' role override leg
   *  was latched off for a backoff window — an unreachable/slow custom utility
   *  seat made every caller pay its full timeout (prod: 24 latch events in 4h,
   *  each a 30s hang). The window now escalates 5→15→30→60 min on a sustained
   *  outage (one retry per step); the first success resets the streak.
   *  meta = { backoffMin, streak, status?, error?, escalation? }.
   *  Kill switch UTILITY_OVERRIDE_BACKOFF_DISABLED=1 (flat 5-min window). */
  UTILITY_OVERRIDE_LATCH: 'utility_override_latch',
  // (memory_shrunk is registered ONCE in the P0 block above; the P6 shrink
  // guard emits it with meta { store, oldLines, newLines, oldChars, newChars }.)
  /** a containment-ladder state TRANSITION for one lane (remediation P8 item
   *  S7 — fleet/containment-ladder.service). TELEMETRY ONLY since the
   *  2026-09-11 gate flip deleted the action path: meta = { lane, state, prev,
   *  strikes, runs, machineMajority, outcome: 'observed' }. States: normal |
   *  claims_required | cadence_halved | model_swap_proposed. No kill switch —
   *  CONTAINMENT_LADDER_DISABLED / CONTAINMENT_LADDER_ACTIONS are retired. */
  CONTAINMENT_LADDER: 'containment_ladder',
  /** renewOnExhaustion successor REFUSED by the self-re-arming governor
   *  (finding B2, 2026-09-27 — canlaw watch 7fbd168c renewed itself 8×):
   *  meta = { scheduleId, kind: 'generation_cap' | 'no_anchor', generation,
   *  maxGenerations, promptSetBy }, value = the exhausted row's generation. */
  SCHEDULE_RENEW_REFUSED: 'schedule_renew_refused',
  /** arm-time duration fit (finding B3, 2026-09-27): a recurring arm/update
   *  whose cadence is shorter than the lane's p50 run length × the fit
   *  multiplier (default 1; SCHEDULE_DURATION_FIT_MULTIPLIER) over its last 10
   *  finished agent_runs — a MACHINE cadence is STRETCHED to the floor, an
   *  owner's is advised — meta = { outcome: 'stretched' | 'warned',
   *  requestedSec, intervalSec, floorSec, p50RunMs, samples, multiplier,
   *  scheduleId? } */
  SCHEDULE_DURATION_FIT: 'schedule_duration_fit',
  /** agent-decisions prerequisite 5 (2026-09-27): a [HARNESS CONTINUATION]
   *  firing / queued row was SKIPPED because the plan board had zero unfinished
   *  steps when re-read — at fire time (any origin, fireScheduleTarget) or at
   *  claim time (run-executor, a queued fast-lane row gone stale behind a busy
   *  lane): meta = { scheduleId? | runId?, origin, seam: 'fire' | 'claim', steps } */
  SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip',
  /** STOP MEANS STOP (2026-09-29, coding/continuation-guard.ts): the
   *  unfinished-work backstop / queue / claim did NOT run a harness
   *  continuation because the run was stopped, cut by a graceful deploy, or
   *  the session is archived — or a Stop cancelled queued continuation rows:
   *  meta = { reason: 'stopped'|'shutdown'|'archived', seam: 'backstop'|'queue'|'claim'|'stop', origin?, unfinished?, cancelled? } */
  CONTINUATION_SUPPRESSED: 'continuation_suppressed',
  // 2026-09-29 (coding/transient-resume.ts): a provider-limit resume was queued (or refused) for a run killed by an exhausted transient lane before it wrote a plan.
  TRANSIENT_RESUME: 'transient_resume',
  /** Independent pre-finish review (coding/independent-review.ts): one row per eligibility decision at the self-audit seam — {ran, reason, model, reportChars, fails, ms, source, dispatched}. */
  INDEPENDENT_REVIEW: 'independent_review',
  /** ANSWER-KEY GUARD (2026-10-03, coding/answer-key-guard.ts — opt-in ANSWER_KEY_GUARD=1): one row per refusal (phase 'pre': a deny-listed benchmark answer-key URL / query / command, nothing fetched or executed) or withheld result (phase 'post': a benchmark canary in fetched content, or deny-listed search entries dropped) — meta { phase, tool, label, target?, dropped? }. */
  ANSWER_KEY_BLOCKED: 'answer_key_blocked',
  /** sweep pre-triage (decision gate N2, 2026-09-25 — ACT mode only, shadow
   *  by default): a due fleet/project SWEEP firing was skipped because the
   *  gate was confident nothing moved since the previous sweep (lastStatus
   *  'skipped:sweep_quiet:<n>', n = consecutive skips; the heartbeat floor
   *  fires the sweep anyway every DECISION_GATE_SWEEP_HEARTBEAT_TICKS-th
   *  tick): meta = { scheduleId, sweep, needsTurn, consecutive } */
  SCHEDULE_SWEEP_SKIP: 'schedule_sweep_skip',
  /** N7 (2026-09-25) — the "parked firing claimed after a finished run" metric the doc asked for FIRST: a
   *  recurring firing that had been busy-parked (busySkips > 0) actually STARTED once the lane freed;
   *  meta = { scheduleId, busySkips, parkedMin, finishedRunId?, finishedAgoMin?, decisionId? } */
  SCHEDULE_PARKED_CLAIM: 'schedule_parked_claim',
  /** N7 ACT only (shadow by default): a busy-parked machine firing was skipped because the decision gate was
   *  confident the run that held the lane already did its work (lastStatus 'skipped:superseded' | 'skipped:merged_next');
   *  meta = { scheduleId, disposition, confidence, finishedRunId } */
  SCHEDULE_SUPERSEDED_SKIP: 'schedule_superseded_skip',
  /** one-shot CHAIN link (finding B1, 2026-09-27): a machine `once` arm from a
   *  schedule firing on its own chat was stamped chainedFromScheduleId — the
   *  chain is walked over a rolling 24h window; ≥3 links ⇒ recurring-like and
   *  the recurring controls apply (schedule-once-chain.ts). Recorded on EVERY
   *  stamped link and every fire-time park (telemetry never gated): meta =
   *  { scheduleId, chainedFrom, rootId, links, recurringLike, intervalSec,
   *  observedCadenceSec, cadenceSec, outcome: 'armed' | 'warned_cap_cadence'
   *  | 'deduped' | 'would_park_dormant', guardDisabled } */
  SCHEDULE_ONCE_CHAIN: 'schedule_once_chain',
  /** a supervisor machine-wake note deferred an action in prose while the run
   *  armed no schedule and messaged no lane — OBSERVED ONLY (gate flip
   *  2026-09-11: the +15 min auto-arm is gone; chat-agent.service deferred-
   *  action seam): meta = { line } (the deferral line, clipped to 120 chars) */
  SUPERVISOR_DEFERRAL_UNARMED: 'supervisor_deferral_unarmed',
  /** finding C3 (2026-09-27): a goal_premise_set re-registered a key with a value
   *  beyond tolerance — value = signed pct change (unit 'pct', absent when old = 0);
   *  meta { goalId, projectId, key, old, new, pct, unit, oldManifest, newManifest, manifestMatch, mode, actingChatId } */
  PREMISE_REVISED: 'premise_revised',
  /** follow-through (item 3): a supervisor diagnosed a lane as stalled and took
   *  no action toward it inside the grace window — meta { laneId8, noteId, minutesSince } */
  FOLLOW_THROUGH_NUDGE: 'follow_through_nudge',
  /** abd733af (6d19f11f sibling seam): a premise-register drift/conflict wake
   *  enqueue FAILED ({ ok: false }) — meta { goalId? , key, goalIds?, outcome:
   *  'enqueue_failed', error } — distinguishable from the sweep's own counters;
   *  no dedupe key was set, so the still-true premise retries next sweep. */
  PREMISE_REGISTER_WAKE: 'premise_register_wake',
  /** follow-through (item 3): an "owner-gated" claim with no open owner
   *  question ⇒ auto-filed — meta { outcome, noteId, oqId } */
  DECISION_AUTOFILED: 'decision_autofiled',
  /** directive age (D2, 2026-09-27): ONE row per supervisor chat per day —
   *  value = age in HOURS of the oldest open directive with no evidence (0 when
   *  none); meta { open, openNoEvidence, overAlarm, archivedOpen, oldestId, overdueIds, projectId } */
  DIRECTIVE_OPEN_AGE: 'directive_open_age',
  /** directive age (D2): a [FOLLOW-THROUGH — DIRECTIVE] wake named directives
   *  open ≥ 24h with no evidence — meta { directiveIds, oldestAgeHours, projectId } */
  DIRECTIVE_FOLLOW_THROUGH: 'directive_follow_through',
  /** directive age (D2): a close whose pr/receipt/run/deploy evidence matched
   *  no receipt of the closing chat and no dispatch id — meta { directiveId,
   *  refs, outcome: 'observed' | 'rejected' } */
  DIRECTIVE_CLOSE_UNRECEIPTED: 'directive_close_unreceipted',
  // Infra watch (owner 2026-09-18 — the fleet supervisor as framework operator):
  // per-box health rows and the alerts raised from them / deploy failures / owner-click cost.
  BOX_HEALTH: 'box_health',
  INFRA_ALERT: 'infra_alert',
  /** Ticket 8a66441e (2026-10-16): the hourly log-signal-sweep over app_error_logs —
   *  ONE row per pass (value = signals found, counters in meta) plus one per
   *  delivered [INFRA ALERT — recurring log signals] wake. */
  LOG_SIGNAL_SWEEP: 'log_signal_sweep',
  /** 2026-10-20 (Grok-bot follow-up): the hourly framework-signal-sweep —
   *  ONE row per pass (value = tickets filed; counts only in meta: scanned,
   *  found, deduped, filed, capped, dayCapped, dayCap). */
  FRAMEWORK_SIGNAL_SWEEP: 'framework_signal_sweep',
  /** ACCEPTANCE-METRIC-BASELINE (2026-10-20): ONE row per framework-signal-sweep
   *  FINDING per pass, stamped at the finding's EVENT time (the message /
   *  card / owner turn's createdAt — so a post-deploy metric window never
   *  counts a pre-deploy event the 2 h lookback re-detected). meta {class:
   *  'raw-marker'|'incomplete-card'|'missed-bug', fingerprint}. The default
   *  acceptance metric of a raw-marker ticket counts these by meta.fingerprint
   *  (loop_metric_count's meta filter). Kill switch AUTOFILER_DEFAULT_METRIC_DISABLED=1
   *  (no rows). */
  FRAMEWORK_SIGNAL_FINDING: 'framework_signal_finding',
  /** TICKET-FAMILY-ROUTING (2026-10-20): measured family precision routing —
   *  phase 'filed_queued' (a noisy-family member filed 'queued': meta {family,
   *  considered, falsePositives, siblings, trueDefects}) and phase 'drain' (one
   *  row per drain that absorbed / day-held / spawned a noisy family lane: meta
   *  {noisy[], daySpent[], noisySpawns[], queuedRiding, dayHeld, absorbed}).
   *  Kill switch TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1 (no rows). */
  TICKET_FAMILY_ROUTING: 'ticket_family_routing',
  /** ACCEPTANCE-METRIC-BASELINE (2026-10-20): the baseline gate measured an
   *  acceptance metric over its PRE-FIX window — phase 'filing' (feedback.service:
   *  a vacuous metric is NOT stored, the ticket files flagged) | 'close' (the
   *  update_feedback done-bar redirect stamps it) | 'verifier' (a vacuous metric
   *  closes on the merged ∧ deployed bar as done, never deployed_verified).
   *  meta {phase, ticketId?, probe, baseline|null, target, operator, vacuous,
   *  reason?, source?}. Kill switch ACCEPTANCE_BASELINE_GATE_DISABLED=1 (no rows). */
  ACCEPTANCE_METRIC_BASELINE: 'acceptance_metric_baseline',
  /** FO firing 102 (2026-10-08): ONE row per SUCCESSFUL deploy.yml run the
   *  infra-watch sweep has seen (Redis-deduped by runId for 7 d) — the recovery
   *  signal for red-deploy alerts. meta.at = the run's CONCLUSION time
   *  (updated_at), so the audit adjudicates "a green wave concluded AFTER this
   *  alert was raised" precisely: deploy_ci_red_24h marks such alerts
   *  'recovered' instead of escalating every ci-red inside 24h (the f100
   *  merge-gate shape, applied to deploys). meta { runId, sha, at } */
  DEPLOY_WAVE_SUCCESS: 'deploy_wave_success',
  /** DEPLOY-WATCH-BLIND (2026-10-20): ONE row per infra-watch sweep that could
   *  NOT read the deploy.yml runs (no usable token anywhere, or every probed
   *  credential got a non-200 / no response) — the silent state that left 0
   *  deploy_wave_success rows over 10-17..10-20 against 120 deploy runs.
   *  meta { reason: 'no_token' | 'network' | 'http_<n>', consecutive, since,
   *  tried, failures: ['env:http_401', 'user:<id8>:http_403', …] }; a SEEING
   *  sweep that ends an episode writes one meta { outcome: 'recovered',
   *  reason, consecutive, since, source } row. Kill switch
   *  INFRA_WATCH_BLIND_ALARM_DISABLED=1. */
  INFRA_WATCH_BLIND: 'infra_watch_blind',
  /** DEPLOY-WATCH-BLIND follow-up (2026-10-20): which credential the deploy watch read GitHub with —
   *  meta.source 'env' (the read-only INFRA_WATCH_GITHUB_TOKEN) or 'user:<id8>' (an admin's connected
   *  account). One row per process at its first sighted read and on every change of source, so the
   *  owner can see the dedicated token in use. */
  INFRA_WATCH_SOURCE: 'infra_watch_source',
  /** LANE-IDLE-WAKE (2026-10-20, coding/lane-idle.ts): ONE row per lane-run
   *  finalize that found the lane holding actionable assigned work, and ONE
   *  per delivery revalidation of the resulting supervisor wake. meta { phase:
   *  'finalize' | 'delivery', outcome: 'enqueued' | 'live_run' |
   *  'pending_wake' | 'schedule_due' | 'no_supervisor' | 'deduped' |
   *  'enqueue_failed' (finalize) | 'delivered' | 'suppressed' (delivery),
   *  reason?, finalStatus?, todoId, openTodos?, supervisorChatId?,
   *  supervisorKind?, notBefore? }. Kill switch LANE_IDLE_WAKE_DISABLED=1. */
  LANE_IDLE_WAKE: 'lane_idle_wake',
  // Capacity watch (todo 0f58ddde, 2026-10-16 — the board-surface gap): the
  // shared coding box's SATURATION probes. ONE row per capacity-probe cron
  // tick (box C only, volume-bound): value = the reading the check keyed on,
  // meta { host, signal, ...readings } per kind below. The box-C writers are
  // docker/volume-bound; the CLASSIFIER that raises [INFRA ALERT — capacity]
  // from these rows is DB-only and runs in the infra-watch sweep on any
  // worker. Kill switch CAPACITY_WATCH_DISABLED=1 (writers AND classifier).
  /** drainer pool saturation — ONE row per tick even when healthy: meta
   *  { host, drainers: [{name, ageMin, running}], occupied, cap, oldestAgeMin } */
  CAPACITY_DRAINER_POOL: 'capacity_drainer_pool',
  /** dev-container memory saturation (WORKING SET, page-cache-corrected): ONE
   *  row per tick per RUNNING digby.dev.container — meta { host, container,
   *  pct, workingSetKb, maxKb, rawPct?, oomKill } */
  CAPACITY_DEV_MEMORY: 'capacity_dev_memory',
  /** ticket-dispatch queue depth — ONE row per ticket-drain drain that reached
   *  the slot accounting (written by the drain itself, not the probe): meta
   *  { occupied, cap, waiting, spawned, heldByFiler, archived } */
  CAPACITY_TICKET_QUEUE: 'capacity_ticket_queue',
  /** ticket-lane slot release (d34f1d6a): ONE row per release EPISODE — a
   *  live lane's slot surrendered (idle sleep/poll park, reason 'idle') or
   *  force-released (hard per-lane cap, reason 'cap') so the queue keeps
   *  moving: meta { reason: 'idle' | 'cap', laneId, ticketId, heldMs,
   *  windowMs? (idle), capMs? (cap) } */
  TICKET_LANE_SLOT_RELEASE: 'ticket_lane_slot_release',
  /** a RETIRING colour (deploy drain window) refused to START a machine-
   *  triggered chat run — it parks/queues for the new colour instead of
   *  extending the drain and dying at teardown (2026-09-18 deploy-replay tax):
   *  meta = { origin } */
  MACHINE_START_DEFERRED_RETIRING: 'machine_start_deferred_retiring',
  /** the product watch (fleet/product-watch.service.ts) raised a [PRODUCT ALERT]
   *  wake to the admin's Fleet Supervisor — a measured product regression from
   *  telemetry (e.g. user-turn answers without follow-up chips): meta { kind, mode, n, zero } */
  PRODUCT_ALERT: 'product_alert',
  /** the Level 2 Double Checker's draft landed AFTER the first answer shipped and
   *  was reconciled into the persisted message (chat-agent/late-crosscheck.ts):
   *  value = checker ms, meta { outcome: revised|unchanged|no_draft|conversation_moved|
   *  reconcile_failed|timeout, checkerTimeMs, reconcileMs, waitedMs } */
  CROSSCHECK_LATE_RECONCILE: 'crosscheck_late_reconcile',
  // Provider cooldown (autonomy loop #3, 2026-09-19): one row per TRIP — a
  // provider hit THRESHOLD 429/5xx rejections inside the window and lead seats
  // on it start on / stay on their fallback until `meta.until`.
  PROVIDER_COOLDOWN: 'provider_cooldown',
  // Tool-list trim (2026-09-27 seat/provider limits): ONE row per (run, model)
  // whose tool list was cut to the model's tool cap — value = tools dropped,
  // meta { model, limit, source: model|endpoint|class|learned, from, to,
  // dropped: [names ≤ 80], droppedGroups }. The 195-tools-on-a-128-cap incident.
  TOOL_LIST_TRIMMED: 'tool_list_trimmed',
  // Progressive tool disclosure (2026-09-27 late, coding/tool-groups.ts): ONE
  // row per run that ran with tool GROUPS active (a provider cap bound, or
  // TOOL_GROUPS_ALWAYS=1) — value = groups loaded at the end, meta { cap, core,
  // inView, loaded[], evicted[], autoLoads, loads, model, steps }. Replaces the
  // tool_list_trimmed row for capped seats (that row now marks only the
  // TOOL_GROUPS_DISABLED fallback or a cap smaller than the core itself).
  TOOL_GROUPS: 'tool_groups',
  // Per-run tool-family profile (owner 2026-09-19): ONE row per top-level run
  // (coding lanes + supervisor wakes) — {calls, memory, web, delegate, spawn,
  // messages, connectors, runCommand, distinct} so the fleet can see which
  // lanes work alone and offline. Aggregated by get_fleet_telemetry view 'collab'.
  RUN_TOOL_PROFILE: 'run_tool_profile',
  // P5 SHADOW firing-size predictor (coding option D step 2, 2026-10-04 —
  // docs/CODING_DYNAMIC_ROSTER_OPTIONS_2026-10-04.md §D): ONE row per
  // schedule/hook firing where the lane's history predicted its size —
  // meta { triggerKind, predicted, reason, n, noOps, writes, newestNoOp }.
  // Pure shadow: NEVER caps the seat / effort / finish.
  FIRING_SIZE_PREDICTED: 'firing_size_predicted',
  // Diagnostics after edit (harness roadmap item 1, 2026-09-19): one row per
  // background typecheck/lint pass over a run's touched files — value = the
  // count of diagnostics in those files; meta.stages per stage.
  EDIT_DIAGNOSTICS: 'edit_diagnostics',
  // Hook-starvation yield (autonomy loop #11): an idle-window entrant (queue drain / agent send)
  // stepped aside for a starving hook backlog; meta {entrant, source|sourceChatId}.
  HOOK_STARVATION_YIELD: 'hook_starvation_yield',
  // Retiring-colour finalize hand-off (autonomy loop #11): value = parked hook rows released.
  FINALIZE_HANDOFF: 'finalize_handoff',
  // Worktree git snapshot (durable checkpoint) failed — meta {class: timeout|unstable|embedded|other} (autonomy loop #12).
  WORKTREE_SNAPSHOT_FAILED: 'worktree_snapshot_failed',
  // A child (spawned) coding session archived by the reaper — meta {reason: finished|idle_7d, idleH|idleDays, steps} (autonomy loop #12).
  CHILD_SESSION_ARCHIVED: 'child_session_archived',
  // A MACHINE dispatch (schedule/hook/agent/webhook) into an ARCHIVED chat was refused — meta {origin?, surface} (autonomy loop #13).
  MACHINE_DISPATCH_ARCHIVED_REFUSED: 'machine_dispatch_archived_refused',
  // A live run re-acquired its MISSING Redis run lock (evicted / Redis restarted) — autonomy loop #14.
  RUN_LOCK_REACQUIRED: 'run_lock_reacquired',
  // A worktree Files-tab snapshot was trimmed to the Redis byte ceiling — meta {before, after, droppedFiles, cutEntries}.
  WORKTREE_SNAPSHOT_TRIMMED: 'worktree_snapshot_trimmed',
  // Finalize fairness (loop #15): the message queue drained BEFORE a hook backlog younger than its head — meta {entrant, reason, hookAgeMs, queueHeadAgeMs, source}.
  QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt',
  // Finalize chose hooks-first and AWAITED the wake (loop #17) — meta {hookAgeMs, queueHeadAgeMs, wakeStarted}.
  FINALIZE_HOOKS_FIRST: 'finalize_hooks_first',
  // Fleet Supervisor stock sweep parked (account dormant ≥ 7 d) or resumed by ensureFleetSupervisor (loop #18) — meta {action, scheduleId}.
  FLEET_SWEEP_DORMANCY: 'fleet_sweep_dormancy',
  /** Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts): a flip
   *  {target:'fleet'|'project', action:'flipped', enabled, by} or ONE rate-limited
   *  skipped-wake row {target, action:'skipped', source:<entry point>, chatId, suppressed}. */
  SUPERVISOR_SWITCH: 'supervisor_switch',
  /** Always-Auto switch (`patience_auto_only`; rate-limit.service setPatienceAutoOnly, audit 2026-09-26): one
   *  row per REAL flip {action:'flipped', enabled, by, previous, previousSource}. The 2026-09-26 20:35Z prod
   *  flip predates this kind and has no row (author unrecorded). */
  PATIENCE_SWITCH: 'patience_switch',
  /** DW-5 measure-first (FO firing 68, 2026-10-03; owner 2026-09-11 "feels
   *  stuck 3-7 s"): ONE row per supervisor-chat send through the Management
   *  fleet surface — value = total ms-to-durable-accept; meta { surface:
   *  'fleet', outcome: started|queued|queued_409|error, busy: bool,
   *  preempted: bool, authMs, modeMs, busyMs, preemptMs, deliverMs }.
   *  PreemptMs carries the f66 source-derived bound (PREEMPT_WAIT_MS 5_000
   *  poll 250 ms) on a busy preempt; authMs carries the capability probe.
   *  Kill switch SUPERVISOR_SEND_TIMING_DISABLED was deleted 2026-10-30 (RSW-1
   *  delete-with-ledger — NF_INERT, never forwarded by compose); the row is
   *  always stamped on a fleet-surface send. */
  SUPERVISOR_SEND_TIMING: 'supervisor_send_timing',
  // One mutation of a user's flat memory blob (extractor turn / rebuild / dream / Memory tab / remember_fact) — value = net visible-fact change; meta {userId, source, before, after, added[], removed[], droppedRemovals?[], rejected?[], rejectedConsolidation?} (owner report 2026-09-21: 3 facts, no trail).
  USER_MEMORY_MUTATION: 'user_memory_mutation',
  // One flat-fact extractor call — value = ms; meta {userId, source, outcome: changed|noop|parse_error|llm_error|empty, detail?} (2026-09-22: a 150-exchange rebuild with one mutation and no way to tell silence from failure).
  MEMORY_EXTRACTION: 'memory_extraction',
  // One in-loop transcript compaction of a coding/chat agent run — value = ms; meta {mode, cutMessages, totalChars, storedItems, storedChars, summarizerOk, priorOffloaded} (2026-09-22 audit: the primary context compactor had no telemetry).
  CONTEXT_COMPACTION: 'context_compaction',
  /** Session titles (2026-09-27): one harness title render — meta {chatId, source: user|spawn-param|harness|llm, reason: plan|todo|goal|finalize|bootstrap|archive|restore|spawn|wake|idle|migration, changed, pinnedSkip?}. */
  TITLE_RENDER: 'title_render',
  /** Session topology (2026-09-27): one placement decision before a spawn / on topology_check — meta {rule, verdict, targetChatId, goalId, signals, source: rule|gate|override, enforced, decisionId?, stash?}. */
  SESSION_TOPOLOGY: 'session_topology',
  /** Session topology outcome (2026-09-27, worker cron session-topology-outcomes): the +24 h label of a decision — meta {decisionId, verdict, ttfrSec, duplicateSpawned24h, oneRunNoPr, reactivatedAfterRetire, correct}. */
  SESSION_TOPOLOGY_OUTCOME: 'session_topology_outcome',
  /** Lane lifecycle C (2026-10-21, platform/lane-retire.ts + archiveChat's cascade): an idle lane retired —
   *  meta {phase: 'archived' (sessionId = the lane; proof p1..p4, idleDays, projectId, parentChatId) | 'pass'
   *  (one per R6 scan pass; considered, archived, skipped {reason: n}) | 'cascade' (sessionId = the child;
   *  parentChatId, chatId — archived because its parent was)}. Kill switches LANE_IDLE_RETIRE_DISABLED /
   *  ARCHIVE_CASCADE_DISABLED. */
  LANE_RETIRED: 'lane_retired',
  // digby_memory rows evicted by the per-scope cap (unified-memory enforceScopeCap) — value = rows deleted; meta {scopeType, scopeId, source?, cap} (2026-09-22 audit: deletions had no record).
  MEMORY_SCOPE_EVICTED: 'memory_scope_evicted',
  /** One row per unified-memory search: per-leg ms (embed/vec/fts/rerank), rerankSkipped, embedCached, purpose (2026-09-23). */
  MEMORY_SEARCH_TIMING: 'memory_search_timing',
  /** SAME-RUN RAW RECALL (2026-10-31, goal 9ecd595e / RAG-1, WRP-1 defect D4's regression
   *  detector): one row per read the raw (query-free) path answered — value = rows returned,
   *  meta {path: 'raw-first'|'raw-fallback', overlap, ageMinutes, scopes, queryChars}.
   *  `raw-fallback` is THE incident class (the hybrid ladder found nothing for a scope holding
   *  fresh rows, so the model was told "not stored") and its count must stay at zero. */
  MEMORY_SAME_RUN_RAW_RECALL: 'memory_same_run_raw_recall',
  /** A unified-memory store whose embedding call failed (the rows land keyword-only): value = rows that stayed
   *  NULL; meta {kind, status, code, providerMessage, rows, maxChars, recovered, source, scopeType} (telemetry-noise audit). */
  UNIFIED_MEMORY_EMBED_FAILED: 'unified_memory_embed_failed',
  /** FO f185 (2026-10-22): one row per unified-memory embed circuit-breaker transition (open | reopen | close) —
   *  the fail-fast for a sustained DashScope outage; meta {transition, failures, cooldownMs, openUntil}. */
  UNIFIED_MEMORY_EMBED_BREAKER: 'unified_memory_embed_breaker',
  /** The memory-embed-backfill cron's bounded repair pass (ticket d7bf73c2): value = rows
   *  whose NULL embedding was filled this tick; meta {scanned, embedded, failed, cooldown,
   *  limit, maxAgeDays, oldestHours} — the repair counterpart of UNIFIED_MEMORY_EMBED_FAILED. */
  MEMORY_EMBED_BACKFILL: 'memory_embed_backfill',
  /** ONE row per rerank ladder attempt (2026-11-01 RAG transport incident): value = ms;
   *  meta {target, ok, ms, errorKind, status, op}. The COUNTER that makes a failure RATE
   *  measurable — the incident ran 689 timeouts/24 h with no denominator because the emit
   *  was a once-per-process warn. ok:true rows are the call volume; ok:false carry
   *  errorKind (timeout | auth | http_4xx | http_5xx | network | empty). */
  RAG_RERANK_CALL: 'rag_rerank_call',
  /** ONE row per attempt at the embeddings lane (2026-11-01 RAG transport incident): value = ms;
   *  meta {target, ok, ms, chars, unit:'attempt', batch, errorKind, status, op}. The call-level
   *  roll-up carries {batchAttempts, batchFailures, batchChars, batchCount} and no `unit`, so
   *  attempt-vs-call rates differ — the fleet telemetry `metrics` view groups by meta.unit for
   *  exactly that reason. Emitted on the DashScope leg and the custom endpoint leg, so
   *  `ok:false / (ok:true + ok:false)` per target is the failure share. */
  RAG_EMBED_CALL: 'rag_embed_call',
  /** A failed POST /api/auth/login (401): meta {ipHash, emailHash, clientIpHash?} — never the address or the raw IP — so a
   *  password-guessing burst from one client is queryable (telemetry-noise audit). clientIpHash (ticket 4a8fcbde) is the
   *  hash of the client IP derived from X-Forwarded-For at the trust-proxy depth (QUOTA_TRUSTED_PROXY_HOPS, the entry
   *  `hops` from the RIGHT — the last trusted proxy appended it, so a forged PREPENDED hop cannot move it; the same
   *  derivation as quotaClientIp). Present only when the hop count is configured and the derived entry is public — it
   *  distinguishes real client rotation from ALB-node rotation on ipHash. The synthetic deploy-healthcheck probe
   *  (emailHash 0034506974bc51de) is never recorded (error-handler skips it: a liveness probe is not a guess). */
  AUTH_LOGIN_FAILED: 'auth_login_failed',
  /** A successful POST /api/auth/change-password (2026-10-12): meta {userIdHash, refreshTokensRevoked, accessCutoff}
   *  — a hash of the user id, never the address, a password or a hash of one. */
  AUTH_PASSWORD_CHANGED: 'auth_password_changed',
  /** A wildcard-hook wake also carried pending rows of sibling hooks on the same target (2026-09-24). */
  HOOK_SIBLING_DRAIN: 'hook_sibling_drain',
  /** A hook/schedule wake on a plain chat carried queued AGENT report-ups as a rider — value = rows; meta {origin, chars, remaining, hookId|scheduleId} (hardening loop iteration 7, 2026-09-24). */
  WAKE_QUEUE_RIDER: 'wake_queue_rider',
  // One row per Google WRITE tool call (2026-09-23, 32d0ebc8 verification):
  // meta { tool, ok, reason?, account? } — the owner-steered ok/reason
  // distribution (missing_scopes / ambiguous / machine_run / disabled vs ok)
  // that decides whether the doctrine must tell models to ask which account.
  GOOGLE_WRITE_TOOL: 'google_write_tool',
  /** Google OAuth token refresh latched on a terminal CLIENT-level answer
   *  (disabled_client — FO firing f156, 2026-10-18): ONE row per latch window per
   *  process, so the bake sees the latch instead of the hot error loop it replaced
   *  (was: a level=error row every ~90 s per expired user token, errors-1h 38 vs
   *  the 10.1/h baseline) — meta { error, latchMs, userId, label }. Kill switch /
   *  tuning: GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS (default 6 h; 0 = off). */
  GOOGLE_REFRESH_LATCH: 'google_refresh_latch',
  /** (07c1d554) The dead-client emission latch SUPPRESSED an arm — the
   *  process-local retry latch still armed (this process stops hammering
   *  Google) but the Redis NX fleet key was already held, so no error row was
   *  written. One row per suppressed arm: the positive observable that the
   *  fleet latch is working (loop_metrics is invisible to the log-signal
   *  sweep's app_error_logs read) — meta matches GOOGLE_REFRESH_LATCH
   *  { error, latchMs, userId, label }. */
  GOOGLE_REFRESH_LATCH_SUPPRESSED: 'google_refresh_latch_suppressed',
  /** GitHub label-miss fallback (ticket e1cca01d, 2026-10-19): ONE row per latch
   *  window per (userId, pinnedLabel) per process — the f121 fallback itself stays
   *  silent-but-working between rows — meta { pinnedLabel, fallbackLabel,
   *  fallbackUsername, userId, warnMs }. Kill switch / tuning:
   *  GITHUB_LABEL_FALLBACK_WARN_MS (default 6 h; 0 = legacy every-miss warn). */
  GITHUB_LABEL_FALLBACK: 'github_label_fallback',
  /** User-added MCP servers (ticket e294f9a4, 2026-10-06): one row per mcp_<server>_<tool> call — value = ms; meta {serverId, slug, tool, ok, errorClass (auth | timeout | network | protocol | http | rpc | tool_error | …), machine, readOnly}. */
  USER_MCP_CALL: 'user_mcp_call',
  /** User-added MCP servers: one row per health STATUS transition (probe or call) — meta {serverId, userId, slug, from, to, source, errorClass, recovered}. */
  USER_MCP_HEALTH: 'user_mcp_health',
  /** PG-unsafe strings (lone surrogates/NULs) stripped at a DB write boundary — value = chars dropped; meta {seam} (FO firing 20, 2026-09-24: 22P05 was failing agentEvent appends + final transcript persists). */
  PG_UNSAFE_STRIPPED: 'pg_unsafe_stripped',
  // One agent_events retention tick that found work — value = rows deleted (or would-delete in dry run); meta {mode, batches, cutoff, oldestRemaining, reachedBoundary, ms} (owner 2026-09-22: 19 GB, no retention).
  AGENT_EVENTS_RETENTION: 'agent_events_retention',
  // One agent_events tiered-compaction tick that found work (audit 2026-10-06 T9-2) — value = rows deleted + payloads stripped (or would-be in dry run); meta {mode, ranges, skips, fromId, cursor, reachedFrontier, tiers{reasoning,context,screenshots,images,complete}{rows,bytes}, ms}.
  AGENT_EVENTS_COMPACTION: 'agent_events_compaction',
  // ── wake-cadence (2026-09-27 tt-rd audit, sup/wake-cadence) ──
  /** A recurring schedule's firing landed on an active run that ALREADY holds a steer from this schedule — not steered again; meta {scheduleId, runId, steersInRun}. */
  SCHEDULE_STEER_DEDUPED: 'schedule_steer_deduped',
  /** The harness stretched a recurring cadence at fire time (never shrinks); meta {scheduleId, medianRunMin, from, to, reason, promptSetBy}. */
  SCHEDULE_CADENCE_STRETCHED: 'schedule_cadence_stretched',
  /** A stock project sweep backed off (doubled) after consecutive schedule-origin no-ops, or reset to default; meta {chatId, from, to, noopStreak, kind}. */
  SWEEP_BACKOFF: 'sweep_backoff',
  /** A recurring lane monitor backed off after BLOCK_STREAK_TRIGGER consecutive near-identical blocked-no-end-date firing answers (todo 27c215d6); meta {scheduleId, chatId, from, to, streak, fingerprint}. */
  BLOCK_STREAK_BACKOFF: 'block_streak_backoff',
  /** Observe-only: a recurring firing's newest answers read as the same blocked-no-end-date finding (todo 27c215d6) — recorded at every claim the streak ≥ trigger, before any backoff verdict; meta {scheduleId, chatId, streak, trigger, escalatedCard}. */
  BLOCK_STREAK_OBSERVED: 'block_streak_observed',
  /** Observe-only lint on a machine-authored schedule prompt; meta {rule:'cap_handoff', scheduleId?, seam:'create'|'update'}. */
  SCHEDULE_PROMPT_LINT: 'schedule_prompt_lint',
  /** A project supervisor wake whose only receipted action was a send_chat_message to the Fleet Supervisor — a report-up, not lane work (SUPERVISOR_REPORT_UP_IS_ACTION=1 restores supervisor_action). */
  SUPERVISOR_REPORT_UP: 'supervisor_report_up',
  /** A schedule-origin run received the one-line wrap-up note at 2× its schedule's interval; meta {scheduleId, elapsedMin, intervalMin}. */
  SCHEDULE_RUN_WRAPUP_NOTE: 'schedule_run_wrapup_note',
  /** Time-sliced machine runs (todo 89df978b, observe-only): wall-clock minutes of ONE unattended machine run at its finalize — the p95 source; meta {status, origin?, scheduleId?}. */
  MACHINE_RUN_DURATION: 'machine_run_duration',
  /** Time-sliced machine runs (todo 89df978b, observe-only — NEVER a cut): an unattended machine run that OUTLIVED the run budget (default 60 min) — the would-have-been-cut record for a future act-path decision (gate-flip doctrine: flip on the measured false-positive rate, not now); meta {budgetMin, overMin, durationMin, activeMin?, status, steps, stepBudget, attempts, checkpointed, waitingBehind, queueWaitMs, origin?, scheduleId?}. */
  MACHINE_RUN_WOULD_CUT: 'machine_run_would_cut',
  /** Queue wait of ONE claimed run (createdAt → first startedAt, ms) — every claim, machine AND user (the fair-queuing input; a user turn queued behind a long machine run is the latency the budget would relieve); meta {origin, preStatus}. */
  RUN_QUEUE_WAIT: 'run_queue_wait',
  // A worktree checkpoint snapshot joined one already in flight for the same session instead of starting a second git walk (loop #16).
  WORKTREE_SNAPSHOT_COALESCED: 'worktree_snapshot_coalesced',
  // Level 2 reconcile pass telemetry (autonomy loop #4): one row per pass —
  // value = ms; meta {path: inline|late, outcome: ok|empty|timeout|error, boundMs}.
  CROSSCHECK_RECONCILE: 'crosscheck_reconcile',
  // Repo-level tool hooks (harness roadmap item 2): one row per postEdit run
  // ({kind:'postEdit', ok, run, file}, value = ms) or per preCommand refusal
  // ({kind:'preCommand', blocked:true, command}).
  REPO_HOOK: 'repo_hook',
  // Per-role worker seats (harness roadmap item 4): one row per delegation
  // whose model came from a seat rather than the tier rule —
  // {role, seat, model, from, machine}, value 1.
  WORKER_SEAT_ROUTE: 'worker_seat_route',
  // Working-tree checkpoints (harness roadmap item 7): one row per rewind_to_step
  // call — {step, restored, deleted, skipped, nothing, reason}, value = files touched.
  EDIT_CHECKPOINT_REWIND: 'edit_checkpoint_rewind',
  // Hedged web fetch (autonomy loop #7): one row per direct-tier search/scrape —
  // {tool, winner: direct|gateway|none, hedged, directOutcome, directMs}, value = total ms.
  WEB_FETCH_PATH: 'web_fetch_path',
  /** D3 resume-after-throttle (goal 9ecd595e, 2026-10-31): ONE row per
   *  `callMcpTool` call that actually waited out a provider-stated throttle
   *  under a caller's `resumeBudgetMs` — i.e. a wait the default fail-fast
   *  contract would have refused. meta = {tool, outcome: resumed|exhausted,
   *  attempts, resumeWaits, waitedMs, statedWaitMs, budgetMs}, value = waitedMs.
   *  Absence of a row means NO resume occurred (previously absence was
   *  indistinguishable from an unobservable success — this kind closes that). */
  WEB_SERP_RESUME: 'web_serp_resume',
  // web_pipe stage timings (2026-10-20 real-user audit, probe WPL1020: p50 69 s): one row per web_pipe call —
  // {mode, searchMs, serpRetry, serpShape, scrapeMs, targets, good, stragglers, storeMs, digestMs, totalMs, ok}, value = totalMs.
  WEB_PIPE_TIMING: 'web_pipe_timing',
  // Per-turn tool-call batch cap (autonomy loop #9): one row per capped turn —
  // {requested, executed, dominantTool, dominantShare, storm}, value = requested.
  TOOL_BATCH_CAP: 'tool_batch_cap',
  /** a MACHINE run (no user turn) executed schedule_message / update_schedule /
   *  cancel_schedule on an own-scope target that used to STAGE a confirmation
   *  card (platform-tools gate; staging opt-in MACHINE_SCHEDULE_CONFIRM_GATE=1):
   *  meta = { tool, surface } */
  MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation',
  /** a consequential platform tool STAGED a pending confirmation (the only
   *  place staging is counted — gate flip 2026-09-11): meta = { tool, machine,
   *  surface } */
  CONFIRMATION_STAGED: 'confirmation_staged',
  /** a requested-WORK platform tool (work-tools.ts: start_coding_session,
   *  configure_workspace, import_repo, own-chat schedule tools)
   *  executed card-free because a HUMAN turn asked for it: meta = { tool,
   *  origin: 'human', surface } */
  WORK_TOOL_DIRECT: 'work_tool_direct',
  /** a blocked goal/todo carries a gate owner-question that is NO LONGER OPEN
   *  (answered or dismissed) — a STALE GATE (2026-09-12 spark-stall incident:
   *  work stayed parked on cards the owner had already answered): meta = {
   *  surface, entity: 'goal'|'todo', id, oqId, oqStatus } */
  STALE_GATE: 'stale_gate',
  /** Review 2026-09-13 issue 11: supervisor-first triage of machine-lane
   *  owner questions — one row per question the supervisor answered with
   *  answer_owner_question (meta { questionId, chatId }). */
  OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  /** Audit 96fb2f25: a supervisor answer to an OWNER-ONLY class question was
   *  REFUSED at answer time (specimen oq_e4869c75 — the Fleet Supervisor
   *  answered an approve-dispatch ask over the held-ticket "another account"
   *  note citing only a generic standing directive): the row stays open for
   *  the owner; meta = { questionId, chatId, reason: the owner-only class }.
   *  Kill switch OWNER_ANSWER_OWNER_ONLY_DISABLED=1 (no refusals, no rows). */
  OWNER_ANSWER_OWNER_ONLY_REFUSED: 'owner_answer_owner_only_refused',
  /** Ticket 1a56f816: a triage window was released EARLY — the owner posted in
   *  the filing chat after the card was filed (an unambiguous engagement signal;
   *  the same countOwnerPostsSinceQuestion probe the triage-race guard and the
   *  dismiss rails use), so the surfacing sweep flipped the row to 'surfaced'
   *  and DM'd at once instead of holding the remaining SLA; meta = { questionId,
   *  chatId }. Kill switch OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED=1 (no
   *  early releases, no rows). */
  OWNER_QUESTION_TRIAGE_EARLY_RELEASED: 'owner_question_triage_early_released',
  /** OWNER-DISMISS-RAILS (2026-10-20): dismiss_owner_question from a SUPERVISOR
   *  seat on a machine turn was REFUSED — meta = { questionId, chatId, reason:
   *  'owner_only_class' | 'owner_engaged' | 'out_of_project', role: 'fleet' |
   *  'project', detail? (the owner-only class) }. Kill switch
   *  OWNER_DISMISS_RAILS_DISABLED=1 (no refusals, no rows). */
  OWNER_QUESTION_DISMISS_REFUSED: 'owner_question_dismiss_refused',
  /** OWNER-DIRECTIVE-FANOUT (2026-10-20): the harness delivered the [OWNER
   *  DIRECTIVES IN FORCE] block — ONE aggregate row per delivery (never per
   *  directive): value = rows shown, meta = { directiveIds (≤12), targetChatId,
   *  surface: 'ps_wake' | 'lane_run', fleet, project, hidden }. Kill switch
   *  OWNER_DIRECTIVE_FANOUT_DISABLED=1 (no block, no rows). */
  OWNER_DIRECTIVE_DELIVERED: 'owner_directive_delivered',
  /** one owner-gate sweeper pass that ACTED (ticket 356d21bb — the backstop
   *  for owner answers resolving ALL derived gates): value = items acted on,
   *  meta = { unblockedTodos, unblockedGoals, dupesResolved, pendingsResolved,
   *  scanned } — the three sweep actions: (a) todos/goals blocked on an
   *  answered gateQuestionId → unblock; (b) OPEN rows matching a recently-
   *  answered same-user decision → auto-resolve + wake; (c) stale live
   *  ask_user pendings matching an answered question → mailbox resolution. */
  OWNER_GATE_SWEEP: 'owner_gate_sweep',
  /** Ticket fadc3563 (2026-10-04): an owner answer to a gated goal/todo was
   *  classified a HOLD/negative — the gate stays blocked as the owner's hold
   *  instead of unblocking (the 06:56:55Z incident: "Not yet — hold the store
   *  wave" cleared goal e1e96be5 + todo 3bf505f8). One row per held answer,
   *  meta = { questionId, source, answeredBy, answer } — questionId is the
   *  closed oq_ row (11-char prefix), answer clipped to 120 chars. */
  OWNER_GATE_HOLD: 'owner_gate_hold',
  /** the per-project supervisor spawn circuit breaker TRIPPED (2026-09-14
   *  spawn guard + breaker — the deterministic anti-self-amplification trip
   *  for the supervisor fan-out lane in platform-tools start_coding_session):
   *  ONE row per trip, value = the breached reading, meta = { projectId,
   *  reason: 'storm' | 'budget' | 'rate', count, cap } — 'rate' = the observe-only hourly spawn-rate advisory (2026-09-14) */
  PROJECT_SUPERVISOR_BREAKER: 'project_supervisor_breaker',
  /** sup3 audit C2 (2026-09-27): a goal was closed 'done' while its own
   *  target_* premise is unmet/unobserved, its progress note carries a HOLD
   *  token, or an open owner directive still names it — the done gate checks
   *  dependency goals only, so the close STANDS (observe-only) and this row +
   *  the '⚠ suspect' board badge are the contradiction: meta = { goalId,
   *  projectId, seam: 'update' | 'auto', reasons[], unmet[], holdToken,
   *  directiveIds[], force, actingChatId }. KS GOAL_DONE_SUSPECT_DISABLED=1. */
  GOAL_DONE_SUSPECT: 'goal_done_suspect',
  /** GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20): a goal closed — or,
   *  under the opt-in GOAL_OUTCOME_GATE_ENFORCE=1, held open by the auto-complete
   *  cascade — while its own outcome bar is unmet (kpi_bar_unmet: the kpi: premise
   *  of record misses its bar; premise_target_unmet: an observed target misses).
   *  ONE row per close-seam assessment — meta = { goalId (8), projectId (8), seam:
   *  'update' | 'auto', reason (the first), reasons[], outcome: 'woken' | 'deduped'
   *  | 'self' | 'owner_close' | 'no_supervisor' | 'supervisor_off' | 'no_redis' |
   *  'enqueue_failed', enforced, actorKind, kpiKey, kpiValue, bar }. KS
   *  GOAL_OUTCOME_CHECK_DISABLED=1. */
  GOAL_OUTCOME_UNMET: 'goal_outcome_unmet',
  /** GOAL-UNPLANNED (architecture review #6, 2026-10-20): the attention-watchdog
   *  sweep woke a project supervisor about an ACTIVE goal with zero open todos and
   *  no lane chartered to it that ran in the last 6 h ([GOAL UNPLANNED] wake,
   *  Redis NX 24 h per goal) — meta = { goalId, projectId, outcome: 'woken' |
   *  'enqueue_failed', doneTodos, droppedTodos, ageH }. KS
   *  GOAL_UNPLANNED_SIGNAL_DISABLED=1. */
  GOAL_UNPLANNED: 'goal_unplanned',
  /** goal status transition (architecture review #6 part 4, 2026-10-20): ONE row
   *  per goals.service status write — meta = { from (null on create), to,
   *  actorKind: 'user' | 'machine' | 'harness', projectId, goalId, ageH (row age
   *  in hours) }. KS GOAL_TRANSITION_METRICS_DISABLED=1. */
  GOAL_TRANSITION: 'goal_transition',
  /** todo status transition (same wave) — meta = { from, to, actorKind,
   *  projectId, goalId, todoId, ageH }. Same kill switch. */
  TODO_TRANSITION: 'todo_transition',
  /** todo_create canonicalized a unique ≥8-char goal prefix to its full id
   *  (FO firing 24, 2026-09-25 — the live 'Goal not found: "09a1ec04"' class
   *  whose Did-you-mean hint already named the unique match): meta =
   *  { from (8-char prefix), to (8-char resolved head), userId } — one row per
   *  resolved create, so the adoption of the fleet 8-char idiom on the LAST
   *  exact-id-only create path charts over time */
  TODO_CREATE_PREFIX_RESOLVED: 'todo_create_prefix_resolved',
  /** a todo_create / todo_update assigneeChatId that was NOT a full chat id
   *  resolved to its canonical full form through the ONE owner-scoped chat
   *  resolver (the LAST exact-id-only write path in the goal/todo graph — a
   *  supervisor assigning todos by the fleet-standard 8-char lane prefix its
   *  own board prints 400'd where goalId resolved in the same call): meta =
   *  { from (8-char typed head), to (8-char resolved head), userId } — one row
   *  per resolved assignment, so adoption of the 8-char idiom on the assignee
   *  seam charts over time */
  TODO_ASSIGNEE_PREFIX_RESOLVED: 'todo_assignee_prefix_resolved',
  GOAL_TODO_NEAR_MATCH_RESOLVED: 'goal_todo_near_match_resolved',
  /** a full-shape (36-char) goal/todo id whose suffix was INVENTED resolved to
   *  the unique caller-visible row sharing its 8-char time prefix (tickets
   *  99ad288e + 636b622b, 2026-09-28 — two 3× todo_update breaker streaks the
   *  same morning: the lanes held the fleet-standard 8-char ref from a board
   *  digest, expanded it back to 36 chars by hallucinating the suffix, and the
   *  36-char length cap refused prefix resolution while the 'Did you mean'
   *  already named the unique row): meta = { entity: 'goal'|'todo', typed
   *  (8-char), resolved (8-char), userId } — one row per healed call, so the
   *  breaker-streak class charts to zero. KS GOAL_TODO_SUFFIX_HEAL_DISABLED=1. */
  GOAL_TODO_SUFFIX_HEALED: 'goal_todo_suffix_healed',
  /** rollout watch 2026-09-15 (tick 12): a MACHINE wake on the built-in seat
   *  finalized EMPTY after read-only tool work and was retried once with the
   *  read results as evidence:
   *  meta = { seat, model, recovered, toolCalls } */
  MACHINE_WAKE_EMPTY_RETRY: 'machine_wake_empty_retry',
  /** one hourly BRANCH JANITOR pass over one GitHub repo (fleet/branch-janitor
   *  .service — owner 2026-09-14 "the framework isnt automatically deleting
   *  branches after they are merged"): ONE row per repo per pass, value =
   *  branches deleted (0 in dry-run), meta = { repo, scanned, deleted, kept,
   *  reasons: {reason: n} (merged | pr_merged | pr_closed |
   *  legacy_session_history | kept_*), dryRun, failed, alreadyGone, aborted? }.
   *  2026-10-21 extended rules (BRANCH_JANITOR_EXTENDED_RULES_DISABLED=1 drops
   *  them): + reasons pr_closed_docs_repush | ported | kept_session_history |
   *  kept_live_lane | kept_young | kept_unported | kept_port_unverified |
   *  kept_archive_failed, ownRepo (true = the framework's own repo, where the
   *  new delete rules + archive run), and — when the pass needed an archive —
   *  archiveTag (the ONE refs/tags/archive/<date>/branch-janitor-<HHMM>Z, null
   *  when it failed), archivedTips (≤50 {branch, sha} — the restore trail) and
   *  archiveFailed (why; old-rule deletes then went ahead untagged) */
  BRANCH_JANITOR: 'branch_janitor',
  /** owner-questions shared-project second chance FAILED and degraded to
   *  "unmatched" (ticket 56284f30 F3 — previously a logger-only warn, so a
   *  real prod failure mode was invisible to the metrics surface). Pure
   *  counter; meta = { probes, error } (error truncated to ≤300 chars) */
  SHARED_OQ_SECOND_CHANCE_FAILED: 'shared_oq_second_chance_failed',
  /** Scoped supervisor autonomy delegation (ticket eb4337fe, ruling
   *  oq_2674964f): a supervisor-class granter's set_chat_autonomy grant to a
   *  supervised same-owner lane EXECUTED card-free via
   *  delegateChatAutonomy (source 'machine_delegated'): meta = {
   *  granterChatId, targetChatId, allowedTools, scheduleCap } */
  AUTONOMY_DELEGATION: 'autonomy_delegation',
  /** Preference-covered recurring digest (ticket eb4337fe, limb B): a
   *  schedule_message with kind 'recurring' whose prompt matches a stored
   *  owner digest preference EXECUTED card-free at first use: meta = {
   *  preferenceKey } */
  PREFERENCE_DIGEST_ARMED: 'preference_digest_armed',
  /** an image was generated on the Image generator seat (2026-09-24 — the
   *  generate_image tool, POST /images/generate, or the admin Test probe):
   *  value = provider latency ms, unit 'ms'; meta = { model, provider
   *  ('dashscope' | 'zai' | 'custom'), spec (the seat/leg spec that served —
   *  shows how often the default is bypassed for its fallbacks), aspect,
   *  referenceMode ('none' | 'native' | 'described'), editLegSource? (native
   *  edits only — 'seat' | 'fallback'; 'fallback' = the serving leg joined via
   *  IMAGE_EDIT_FALLBACK_CHAIN, e.g. the seat chain had no edit-capable leg —
   *  WI-P 2026-09-25), substitutedFor? + substitutionReason? (09a03aef —
   *  present ONLY on a substituted serve: the SEAT's effective spec that did
   *  not serve, and ITS failure class 'timeout' | 'provider' | 'unavailable';
   *  never a later leg's error), surface ('tool' | 'rest'
   *  | 'probe'), latencyMs, bytes, chatId?, ok (false on a failure, with
   *  `error` code), rateLimited? (a cap refusal, with `scope`) } */
  IMAGE_GENERATION: 'image_generation',
  // ── Supervisor upward-chatter + owner-ask follow-through (tt-rd audit 2026-09-27) ──
  /** ONE row per project-supervisor → Fleet-Supervisor send_chat_message (platform-tools observeReportUp): meta =
   *  { sourceChatId, targetChatId, chars, hasStateChange, hasAsk, statusOnly } — statusOnly bodies get the advisory line. */
  REPORT_UP: 'report_up',
  /** OPT-IN (REPORT_UP_ACK_ONLY_DRAIN=1): a queued status-only project-supervisor batch was ACKED by the harness instead of
   *  starting a Fleet Supervisor turn — value = rows acked; meta = { chatId, sources, chars }. */
  REPORT_UP_ACK_ONLY: 'report_up_ack_only',
  /** A kind:'ask' owner directive was closed by the harness because the supervisor's reply landed (closeAskOnReply):
   *  meta = { chatId, directiveId, askMessageId, replyMessageId, ageMs, source: 'owner_turn' | 'machine_wake' | 'reconcile' }
   *  (fixer 2026-09-27: 'machine_wake' = an [OWNER ASK UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge answered it;
   *  'reconcile' = the wake-block builder found a qualifying reply already in the transcript). */
  DIRECTIVE_ASK_AUTOCLOSE: 'directive_ask_autoclose',
  /** An OWNER turn on a supervisor chat ended EMPTY after tool work and was retried once (chat-agent): meta = { seat, model, recovered, toolCalls }. */
  OWNER_TURN_EMPTY_RETRY: 'owner_turn_empty_retry',
  /** An owner turn on a supervisor chat got a harness error envelope as its reply → ONE machine re-wake enqueued
   *  ('[OWNER ASK UNANSWERED]'): meta = { chatId, askMessageId, reason, enqueued }. */
  OWNER_ASK_REWAKE: 'owner_ask_rewake',
  /** Follow-through detector 3: an open kind:'ask' directive with no reply → meta = { stage: 'nudge' | 'escalate', chatId, directiveId, ageMs, projectId? }. */
  OWNER_ASK_NUDGE: 'owner_ask_nudge',

  /** Secret-scrubbing D4 (2026-09-27): a chat-read tool (get_chat_messages /
   *  get_run_receipts) on a MACHINE run redacted credential-shaped strings
   *  from its output before the model saw it — one row per call with hits;
   *  meta = { tool, chatId, hits (pattern names), count, machine } */
  CHAT_READ_SECRET_REDACTED: 'chat_read_secret_redacted',

  /** Deliverable hand-off (cohesive chat wave, 2026-09-27): one row per
   *  completed run the harness handed back to its parent chat (or posted on
   *  itself for a top-level session) — value = files delivered; meta =
   *  { runId, parentChatId, targetChatId, files, prs, canvases, bytes,
   *    skippedTooLarge, truncated, candidates, worktreeLocal, trigger, posted,
   *    resultMessageId } (posted:false rows carry `error`). */
  DELIVERABLE_HANDOFF: 'deliverable_handoff',
  /** cohesive chat live fixes (2026-09-28, platform/human-spawn.ts): the
   *  permission mode a start_coding_session child got and WHY — meta =
   *  { childChatId, permissionMode, permissionSource: 'spawn-param' |
   *    'user-pref' | 'human-spawn-default' | 'default', humanSpawn, direct,
   *    surface }; sessionId = the spawning (parent) chat. */
  SPAWN_PERMISSION: 'spawn_permission',
  /** cohesive chat live fixes (2026-09-28, platform/handoff-parent-wake.ts):
   *  a child-result run_completed / run_failed hook wake aimed at a HUMAN-
   *  owned non-supervisor parent was skipped because the deliverable hand-off
   *  (the result row + the task card) already told the user — rows terminal-
   *  marked 'skipped:handoff_posted', never replayed. meta = { hookId,
   *  childChatId, eventTypes, runIds, reason: 'handoff_posted' |
   *  'failed_card_flipped', cardFlipped }; sessionId = the parent chat. */
  HANDOFF_PARENT_WAKE_SKIPPED: 'handoff_parent_wake_skipped',
  /** Ticket f8c62820 (platform/child-ownership-wake.ts): an auto-wired
   *  child→parent result hook wake was skipped because the child lane's
   *  ownership moved away from the spawning parent (a newer agent-sent steer
   *  from another chat) — rows terminal-marked 'skipped:ownership_moved',
   *  never replayed; the hook stays armed and self-heals on renewed parent
   *  engagement. meta = { hookId, childChatId, eventTypes, reason:
   *  'external_steer_<chatId>' }; sessionId = the ex-parent chat. */
  CHILD_OWNERSHIP_WAKE_SKIPPED: 'child_ownership_wake_skipped',
  /** Hand-off polish (2026-09-28, audit CT-2): a HUMAN turn that started a
   *  sub-session ended its tool loop after that round (one tools-off final;
   *  chat-agent.service ↔ coding/agent.ts endTurnAfterToolRound). meta =
   *  { chatId, childChatId, title, mode, stepsUsed }; sessionId = the chat. */
  SPAWN_TURN_END: 'spawn_turn_end',
  /** Council dispatch bounding (ticket 9aedb32f, 2026-09-29,
   *  chat-agent/council-dispatch.ts): a deep-research dispatch_colleagues
   *  attempt hit its per-attempt ceiling. One row per timed-out attempt;
   *  meta = { chatId, seat, persona, attempt, terminal, ceilingMs, clone } —
   *  terminal:true means no retry followed (the lead proceeds without that
   *  colleague; a run with zero reports across all rounds also logs
   *  council_degraded_run). sessionId = the council chat. */
  COUNCIL_DISPATCH_TIMEOUT: 'council_dispatch_timeout',
  /** Degraded-council run (ticket 9aedb32f): the lead dispatched the council
   *  at least once but NO colleague ever returned a real report — the final
   *  answer was lead-only while deep-research quota was paid, so the final
   *  message carries a visible degraded-run notice. meta = { chatId, dispatchRounds,
   *  machine }; sessionId = the council chat. */
  COUNCIL_DEGRADED_RUN: 'council_degraded_run',
  /** Late council findings attached as ONE follow-up row on a degraded run
   *  (ticket c7d5f885): the council's terminal stragglers fired after the
   *  lead answered alone, so their reports land as a council_addendum row
   *  after a grace window (kill switch COUNCIL_ADDENDUM_DISABLED=1). meta =
   *  { chatId, reports, graceMs, persisted? }; sessionId = the council chat. */
  COUNCIL_LATE_ADDENDUM: 'council_late_addendum',
  /** gmail_get_attachment resolved a ROTATED attachmentId by downloading directly
   *  with the caller's stale-but-valid ID (tickets 9a818013 / a7f6c4e4, 2026-10-01:
   *  Gmail mints fresh attachmentIds on every format=full fetch while old IDs stay
   *  downloadable, so the exact-match download path was structurally dead) —
   *  meta { messageId }. Server kill switch GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED=1. */
  GMAIL_STALE_ATTACHMENT_ID: 'gmail_stale_attachment_id',
  // ── audit 2026-10-06 T1 (context budget / compaction / memory) ──
  /** T1-1: a custom-endpoint seat's transcript budget — meta { model, source
   *  ('registry' | 'family' | 'default'), budget, outcome: 'run_start' |
   *  'ceiling_learned' (a family budget rejected by size → ceiling, rejectedChars) }.
   *  value = chars. Kill switch REGISTRY_CONTEXT_FAMILY_DISABLED=1 (source omitted). */
  CONTEXT_BUDGET: 'context_budget',
  /** T1-7: a coding lane made ≥ N consecutive tool calls with no mutating tool
   *  while a plan step was in_progress → ONE harness notice — meta { calls,
   *  threshold, step, lastTools }. Kill switch NO_PROGRESS_BRAKE_DISABLED=1. */
  NO_PROGRESS_BRAKE: 'no_progress_brake',
  /** T1-5: a session-scope memory store skipped chunks already stored under the
   *  same (source, ref) — meta { source, deduped, written }. value = deduped.
   *  Kill switch MEMORY_SESSION_DEDUPE_DISABLED=1. */
  MEMORY_STORE_DEDUPED: 'memory_store_deduped',
  // ── roster 2026-10-06 Team B ──
  /** B-1: a turn-plan hygiene decision — meta { event: 'supervisor_skip', fleet } (the turn plan is never asked on a
   *  supervisor-class chat). Written through chat-agent/turn-plan-labels.ts TURN_PLAN_HYGIENE_KIND (same value).
   *  Kill switch TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1 (the ask runs again, tagged segment 'supervisor'). */
  TURN_PLAN_HYGIENE: 'turn_plan_hygiene',
  /** B-2: a decision-gate ask RETIRED on a human turn was skipped — meta { purpose: auto_route | compute_policy |
   *  checker_route | drafts_agree, site, segment? }. Written through platform/human-turn-retirement.ts
   *  DECISION_ASK_RETIRED_KIND (same value). Kill switches DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 /
   *  DECISION_GATE_<PURPOSE>_HUMAN_RETIRE_LIFTED=1. */
  DECISION_ASK_RETIRED: 'decision_ask_retired',
  /** Background delegation (coding/background-delegation.ts): ONE row per worker lifecycle phase —
   *  meta { phase: start | injected | status | posted_late | unposted | cancelled | refused | end_wait |
   *  sync_fallback | lost_on_resume, workerId?, role?, title?, todoId?, reason?, … }; value = the worker's
   *  duration so far (ms) on a worker row, the waited ms on end_wait. Kill switch DELEGATE_BACKGROUND_DISABLED=1
   *  (background:true then runs in the foreground — one sync_fallback row). */
  DELEGATE_BACKGROUND: 'delegate_background',
  /** build 2026-10-08 F-1 — typed finish_run, SHADOW (coding/finish-run.ts): ONE row per eligible top-level
   *  MACHINE run (coding lane / supervisor) — meta = FinishRunRecord { source model | nudged | auto, calls, offered,
   *  nudge {outcome, ms}, status, valid, errors[], claims, verified, unverified, unverifiable, scopeMismatch, byVia,
   *  claimTypes, rejected[{type, ref, reason, suggestType?, originCheckable?, nearest?}], unverifiableRefs[],
   *  openItems, undeclared, finalChars, autoClaims? }; value 1 = valid. Reader: scripts/framework-audit/finish-run-readout.js.
   *  Kill switch FINISH_RUN_DISABLED=1. */
  FINISH_RUN: 'finish_run',
  /** build 2026-10-08 F-2 — the finish_run verdict vs the OLD prose detector on the SAME delivered final
   *  (run-executor: the evidence guard; chat-agent: the machine-wake action verifier) — meta { detector, cell
   *  both_clean | both_flagged | finish_only | detector_only | no_finish_*, agree, finishSource, finishValid,
   *  detectorConvicted, detectorKinds[] }. Same reader + kill switch. */
  FINISH_RUN_AGREEMENT: 'finish_run_agreement',
  /** build 2026-10-08 D-1 — the delegation task ledger (platform/delegation-tasks.ts, SHADOW): meta { phase:
   *  created | skipped (reason report_up) | duplicate_key | terminal_conflict, kind, source, state?, from?, to?, seam?,
   *  taskId } (a transition's record is the delegation_tasks row itself). build 2026-10-11 DL-1: phase tool_read
   *  { tool: task_get | task_list, seat, scope, returned, total?, open?, via? } — one row per model read of the ledger.
   *  Read by the admin delegation view (GET /admin/delegation-tasks). Kill switch DELEGATION_TASKS_DISABLED=1. */
  DELEGATION_TASK: 'delegation_task',
  /** build 2026-10-08 D-1 — the nightly ledger-vs-sources reconcile (delegation-reconcile cron): meta { checked,
   *  truthTerminal, agree, disagree, falseTerminal, missedTerminal, agreementPct, missingParent, missingRows,
   *  stale, byKind }. The shadow bar: ≥ 99 % terminal-state agreement, 0 rows missing a parent. */
  DELEGATION_TASK_RECONCILE: 'delegation_task_reconcile',
  /** build 2026-10-08 D-2 — the tool-intent journal (coding/tool-intents.ts): meta { phase:
   *  would_reconcile | executed_twice | daily | act, tool, verdict?, priorState?, priorAgeMs?, scopeKind, … }.
   *  build 2026-10-11 DL-2 ACT: phase act { decision: skip_applied | skip_reconciled | withheld | run_*, priorIntentId,
   *  receiptId?, taskId?, why?, intentId } on every call with an earlier-attempt twin — the weekly 20-sample "0 false
   *  skips" check reads these. Kill switches TOOL_INTENT_JOURNAL_DISABLED=1, TOOL_INTENT_ACT_DISABLED=1. */
  TOOL_INTENT: 'tool_intent',
  /** 2026-10-12 credential incident — open_pull_request looked up the project's production dependencies in OSV
   *  (coding/dependency-advisories.ts): meta { repo, manifests, packages, findings: [{pkg, version, id, severity,
   *  fixed}], critical, high, error? }. One row per PR with a finding (or a lookup error). Observe-only — the PR
   *  still opens; the notice rides the tool result AND the PR body. Kill switch DEPENDENCY_ADVISORY_CHECK_DISABLED=1. */
  DEPENDENCY_ADVISORY: 'dependency_advisory',
  /** Todo d597ce5d (#1578 escape, monitor lesson 6) — the (verb, tool, id) TRIPLE grounding of a follow-through
   *  citation: a cited receipt id that RESOLVES but to a receipt of the wrong TOOL CLASS for the claim's verb
   *  (specimen ad60c49d: "Resolved duplicate ticket 9c307167 … receipt ticket 9c307167" while the id lives only in
   *  a file_feedback envelope; specimen 05126597: "pinned at priority 0 with adminNotes" claimed inside a
   *  send_chat_message payload on failed update_feedback calls). One row per mismatch — meta { verb, noun?,
   *  expectedTools, actualTool, receiptId, leg: 'human'|'machine', phrase }. OBSERVE-ONLY: metric only, never a
   *  rewrite, never a retry — the 7-day baseline gates any future enforcement (the 6f8b52b7 / PR #1548 ladder).
   *  Kill switch RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED=1. */
  RECEIPT_TOOL_MISMATCH: 'receipt_tool_mismatch',
  /** Todo 13dfa16d (framework-audit monitor lesson 7) — a supervisor sentence claims '<todo> merged/landed/shipped'
   *  while that todo's row disagrees (status not done, evidence naming no PR, or a PR receipt for the sentence is
   *  STAMPED with a different work item — the #1590 specimen class: the sentence said 908f48a7, the PR served
   *  27c215d6). meta { prefix, claimedWorkItem, todoStatus, todoEvidence?, stampedWorkItem?, verb, leg: 'human'|'machine',
   *  phrase }. OBSERVE-ONLY FIRST: metric row only, never a rewrite, never a retry — the 7-day baseline gates any
   *  future enforcement (the 6f8b52b7 / PR #1548 ladder). Kill switch ARTIFACT_ATTRIBUTION_DISABLED=1. */
  ARTIFACT_ATTRIBUTION_MISMATCH: 'artifact_attribution_mismatch',
  /** 2026-10-16 todo 908f48a7 (monitor lesson 5) — a supervisor machine note's owner-facing status claim checked
   *  against the LEDGER, not proxies (chat-agent/owner-status.ts, wired at the machine-wake seam): meta { chatId,
   *  seat, model, findings: [{kind, proxyPair: 'best_leg_rate'|'open_card_count'|'lane_run_active', claim, evidence}],
   *  count }. Three proxy pairs: a best-leg rate value presented as an end-to-end rate vs a target; "nothing needs
   *  the owner" counted from open cards alone while todos/plan steps sit blocked on an owner action (incl.
   *  approved-but-never-landed); "started" with the todo pending and no mutating receipt. Observe-only — no rewrite,
   *  no retry, no block; enforcement is a later decision on the measured rate. Kill switch
   *  OWNER_STATUS_PROXY_MISMATCH_DISABLED=1. */
  OWNER_STATUS_PROXY_MISMATCH: 'owner_status_proxy_mismatch',
  /** 2026-10-16 todo 908f48a7 item 3 — a rate claim in an owner-facing note that implies a rate the premise
   *  register does not hold like-for-like (the 162.9-plays-presented-as-clips shape): meta { chatId, seat, model,
   *  findings: [{proxyPair, claim, evidence}], count }. Rides the same observe-only wiring as
   *  owner_status_proxy_mismatch; same kill switch. */
  RATE_PREMISE_INCONSISTENT: 'rate_premise_inconsistent',
  /** Todo fea78360 (monitor lesson 6, 2026-10-16) — the owner-card PAYLOAD-COMPLETENESS half of the
   *  contract, observe-only: a filed card missing the decision context the owner's 13:19Z inline-payload
   *  directive requires (background / options / recommendation — the baseline: 14 of 25 cards carried the
   *  full payload inline). One row per incomplete card at flag time — meta { chatId, kind: 'flag',
   *  missing: string[], questionChars }. Metric only, never a refusal, never a rewrite — the 7-day
   *  baseline gates any future enforcement (the 6f8b52b7 / PR #1548 ladder). Kill switch
   *  OWNER_CARD_CONTRACT_DISABLED=1. */
  OWNER_CARD_PAYLOAD_INCOMPLETE: 'owner_card_payload_incomplete',
  /** Todo fea78360 (monitor lesson 6, 2026-10-16) — the owner-card CHAIN half: a replacement/superseding
   *  card that does NOT name the card it replaces (baseline: 0 of 5 named it; the 4-card ACL-chain specimen
   *  oq_d5948325/oq_ea52c6ae/oq_9396afac/oq_19ab7b6b — the owner answered the STALE card while the live
   *  one sat under it). Records BOTH polarities at flag time: meta { chatId, kind: 'flag',
   *  predecessorId, linked: boolean, matched?: boolean, scope } — linked=false is the contract violation
   *  (an unlinked successor, or a named-but-wrong link: matched=false), linked=true the healthy
   *  counterpart (a named, same-decision link). Same kill switch. */
  OWNER_CARD_CHAIN_UNLINKED: 'owner_card_chain_unlinked',
  OWNER_QUESTION_SECRET_DELIVERED: 'owner_question_secret_delivered',
  /** Ticket be06c812 (log-signal family lane, 2026-10-18, PR #1709) — a CLOSED
   *  same-type exact-title row carrying a RECORDED adjudication verdict absorbed
   *  a standing-class sighting in the reopen pass's short-circuit (occurrences +
   *  trail, no reopen, no escalation, no dispatch) instead of reopening and
   *  re-firing a weekly lane dispatch. One row per absorption — meta { ticketId,
   *  occurrences, filedType, ticketType, via: 'reopen-pass-short-circuit', count?,
   *  bar? }. Kill switch FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED=1. */
  FEEDBACK_ADJUDICATED_CLASS_DEDUPE: 'feedback_adjudicated_class_dedupe',
  /** Ticket be06c812 (same fix) — a recorded adjudication bar was CROSSED: the
   *  sighting's 24h count exceeded the verdict's own re-open bar, the verdict's
   *  re-open condition fired, and the sighting fell through to the legacy
   *  recurrence gates instead of being absorbed. One row per breach — meta
   *  { ticketId, count, bar, filedType }. Same kill switch. */
  FEEDBACK_ADJUDICATED_BAR_BREACH: 'feedback_adjudicated_bar_breach',
  /** ARCHIVED-TARGET-RETIRE (2026-10-20; platform/archived-target-retire.ts): machine work aimed at an
   *  ARCHIVED chat is retired at its source instead of being refused at every firing (prod: 821
   *  machine_dispatch_archived_refused rows / 7 d, ~20/h). One row per retirement — meta { surface:
   *  'schedule' | 'owner_answer' | 'todo' | 'arm', action: 'paused' | 'rerouted' | 'unassigned' |
   *  'refused' | 'restored', chatId, ... }. Kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1. */
  ARCHIVED_TARGET_RETIRE: 'archived_target_retire',
  /** INTERVENTION-OUTCOMES (supervisor SOTA round 2, 2026-10-20; platform/intervention-outcomes.ts): ONE row per
   *  (supervisor turn, coding lane) the turn pulled a lane lever on — an ok, non-no-op receipt of
   *  start_coding_session / dispatch_platform_task (spawn), send_chat_message (steer), schedule_message /
   *  update_schedule / resume_schedule (schedule) or answer_chat_question / approve_request (answer — the lane's
   *  own request) whose target is a coding lane, never a supervisor. sessionId = the supervisor chat; meta
   *  { supervisorChatId, targetChatId, goalId, todoId, projectId, kind, tools, receiptId, turnId, at (the
   *  receipt's own time), liveRun (a lever acted on the run live at that moment), origin: machine|human, tier }.
   *  Kill switch SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1. */
  SUPERVISOR_INTERVENTION: 'supervisor_intervention',
  /** INTERVENTION-OUTCOMES: the +6 h / +24 h label of a supervisor_intervention row (worker cron
   *  supervisor-intervention-outcomes) — sessionId = the supervisor chat, value 1 iff progressed; meta
   *  { interventionKey (the intervention row id), horizonH: 6|24, targetChatId, kind, liveRun, outcome:
   *  progressed | ran_no_artifact | no_run | repeated | null, reason (null label: target_missing |
   *  in_flight_run | owner_confounded | other_supervisor_confounded | target_archived | run_window_truncated |
   *  label_expired — the last written without facts when the labeller fell behind), artifacts,
   *  inFlightArtifacts, runs, inFlightRuns, runsTruncated, firstArtifactAt, firstRepeatAt, confounded,
   *  archivedInWindow, … }. Same kill switch. */
  SUPERVISOR_INTERVENTION_OUTCOME: 'supervisor_intervention_outcome',
  /** CI-WATCH (2026-10-20; coding/ci-watch.service.ts): the no-LLM 5-min CI watch over lane-pushed shas.
   *  meta.phase: 'pass' (one row per pass that checked anything or hit a rate limit — candidates, due,
   *  checked, failures, wakes, escalations, resolved, superseded, rateLimited, pruned), 'lane_woken' (a
   *  completed red sha → ONE direct wake on the lane with the failing checks), 'escalated' (still red with
   *  the lane idle / past the 2 h hold / unwakeable / stopped / looping → ONE ci_failed some hook heard),
   *  'no_supervisor' (that ci_failed reached no hook — never counted as escalated), 'escalation_failed' (the
   *  emission failed; its claim was released and the next pass retries), 'resolved' (went green after the
   *  wake), 'superseded' (the lane moved past the sha: a newer git_push receipt, or the live branch / PR
   *  head is another commit — meta.via receipt | pr_head | branch_head), 'closed' (the PR merged / closed or
   *  the branch is gone), 'out_of_scope' (observed only, never woken: meta.scope human_run | unknown_run |
   *  not_machine_lane), 'loop_suppressed' (the lane's 24 h ci-watch wake budget is spent and its lane_loop
   *  escalation already went out), 'ps_row_skipped' (hooks.service: a ci_failed row on a ci-watch-
   *  provisioned project-supervisor hook withheld because the lane is live or the switch is off),
   *  'harness_wake' (r3 interactions fix: a merge intent / await_condition red-CI outcome wake booked as the
   *  lane's one wake about the sha — meta.via, verdict deliver | loop, wakes, reds) and 'harness_woken'
   *  (route found that booking: no second lane wake). Kill switch CI_WATCH_DISABLED=1. */
  CI_WATCH: 'ci_watch',
  /** FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20; platform/fleet-ps-first.ts): one row per step of a
   *  PS-covered alarm's path to the Fleet Supervisor — sessionId = the Fleet chat, meta { phase: 'held' (new
   *  45-min escalation) | 'appended' (folded into the open one for that project) | 'shed_quiet' (a quiet-cause
   *  alarm type — the project supervisor only) | 'shed_cadence' (schedule_near_cap / schedule_cap_skipped —
   *  never escalated: the escalation is an alarm-class todo_wake) | 'direct_watch' (the Fleet also has a direct
   *  hook on the lane — today's immediate wildcard row) | 'direct_fallback' (the hold failed — the row was
   *  written at once) | 'ps_handled' (dropped at delivery: the PS's high-water mark is later than every alarm) |
   *  'rehold' (reason 'window': a newer alarm still inside the PS's window; 'inflight': a PS wake that started
   *  after the alarm is still running) | 'escalated' (the Fleet is woken — once per stamp, not per busy re-park),
   *  eventType?, projectId, sourceChatId?, psChatIds, alarms?, handled?, unhandled?, psMarkAt?, inflight?,
   *  heldMin? }. Kill switch HOOK_FLEET_ALARM_PS_FIRST_DISABLED=1. */
  FLEET_PS_ESCALATION: 'fleet_ps_escalation',
  /** BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20; platform/unverified-claims.ts): ONE row
   *  per supervisor machine wake whose delivered note got the observe-only action-class footnote — the
   *  verifier's ACTION-class convictions (id-less, located in the note) and, on a run that made NO tool call,
   *  the unbacked-claim lane's send-class claims (convicted by construction). sessionId = the supervisor chat,
   *  value = claims; meta { supervisorScope, zeroTool, footnoted (the footnote was appended — false when only
   *  the briefing filter is on), sources { action_verifier, zero_tool_dispatch }, kinds, claims (≤ 4 excerpts),
   *  briefingFiltered }. Kill switch ACTION_CLASS_ANNOTATE_DISABLED=1 (the footnote). */
  ACTION_CLASS_ANNOTATED: 'action_class_annotated',
  /** BRIEFING-UNVERIFIED-FILTER: ONE row per posted owner briefing that was handed unverified claims
   *  (fleet/owner-briefing.service.ts) — sessionId = the supervisor chat, value = claims located in the note;
   *  meta { path: deterministic | llm, scope, supplied, embedded (read back from an annotation paragraph in the
   *  note), located, markedInBriefing ("(unverified)" markers in the posted text), droppedFromLlmInput,
   *  sourceNoteId }. Kill switch BRIEFING_UNVERIFIED_FILTER_DISABLED=1. */
  BRIEFING_UNVERIFIED_FILTER: 'briefing_unverified_filter',
  /** GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20; platform/goal-priority.ts): one row per write
   *  that carried a goal ranking field (priority / dueAt) — sessionId = the acting chat (null for a REST
   *  write), meta { goalId, projectId, outcome: 'set' | 'cleared' | 'refused_owner_set' (a machine write on
   *  an OWNER-set ranking — the other fields still applied) | 'refused_not_supervisor' (a machine write from a
   *  lane — only a supervisor may rank), source: 'owner' | 'machine', from?, to?, dueAt?, seam: 'create' |
   *  'update' }. The drift read: how often machines try to re-rank owner goals. Telemetry only — the switches
   *  GOAL_PRIORITY_ORDER_DISABLED / GOAL_SPEND_ATTRIBUTION_DISABLED govern ordering and attribution. */
  GOAL_PRIORITY: 'goal_priority',
  /** OWNER-INTERRUPT-ECONOMY (supervisor SOTA round 3, 2026-10-20; platform/owner-interrupt-economy.ts): ONE
   *  row per flag_owner_question call — the owner's interrupt load, measured per OWNER (the caps were per chat).
   *  sessionId = the filing chat; meta { outcome: created | deduped | refused, refused? (… | previously_decided),
   *  delivery: immediate | digest | triage | null, deliveryReason (owner_only:<class> | urgent | cost_of_delay |
   *  batched | queue_failed | digest_disabled | economy_unavailable), priorRecall: refused | annotated | null,
   *  machine, supervisorFiler, advisory (ask-vs-decide reason) | null, reversible (armed | why not) | null,
   *  ownerOnly, urgent, questionId?, priorQuestionId?, priorStrict?, chatId, userId }. Kill switch
   *  OWNER_INTERRUPT_METRICS_DISABLED=1 (this kind and the two below). */
  OWNER_QUESTION_FLAGGED: 'owner_question_flagged',
  /** OWNER-INTERRUPT-ECONOMY: ONE row per owner-question resolution — sessionId = the filing chat; meta
   *  { outcome: answered | dismissed, by: owner | supervisor | default | agent | system, surface: answer |
   *  same_as_before | credential_paste | duplicate | chat_card | dismiss | superseded | preset_default |
   *  reversible_default, latencyMin (from filing), questionId, chatId, userId? }. */
  OWNER_QUESTION_RESOLVED: 'owner_question_resolved',
  /** OWNER-INTERRUPT-ECONOMY: the per-owner 12 h decision digest — meta { phase: sent | flushed (the digest
   *  kill switch drained the queue) | send_failed, userId, questions, defaults, entries?, oldestWaitMin?,
   *  droppedStale?, sinceLastDigestMin? (gap since the owner's previous digest), spacingOverridden? (the 12 h
   *  wait bound sent it closer than 12 h − one sweep after the previous one) }. */
  OWNER_DECISION_DIGEST: 'owner_decision_digest',
  /** OWNER-INTERRUPT-ECONOMY review 2026-10-20: the armed reversible-default index (sweepReversibleDefaults) —
   *  sessionId = the filing chat (absent on 'overdue'); meta { phase: applied (waitMin) | refused (the 24 h
   *  apply refused for a permanent reason — reason: owner_only:<class> | typed_gate — and the default was
   *  RETIRED: pair cleared, lane told; retired) | overdue (count of armed defaults still unapplied
   *  REVERSIBLE_DEFAULT_OVERDUE_ALARM_MS past due — one row per pass), questionId? }. */
  OWNER_REVERSIBLE_DEFAULT: 'owner_reversible_default',
  /** SHARED-PROJECT-DISPATCH (supervisor SOTA round 3, 2026-10-20; platform/shared-project-access.ts): one row per
   *  coding session a project MEMBER (editor / admin — never a viewer) started in a project it does not own —
   *  sessionId = the new session, meta { projectId, runUserId (the project owner the session runs as),
   *  spawnedByUserId, role, source: direct | ancestor | blank }. Kill switch SPAWN_MEMBER_ACCESS_DISABLED=1. */
  MEMBER_SPAWN: 'member_spawn',
  /** SHARED-PROJECT-DISPATCH (2026-10-20; feedback/held-ticket-escalation.ts): the held-ticket escalation —
   *  meta.phase: 'card' (ONE owner card Approve / Keep held / Dismiss for a ticket held > 2 h; ticketId,
   *  questionId, heldHours), 'decision' (the owner's answer applied: decision approve | keep_held | dismiss,
   *  ticketId, questionId, applied), 'pass' (one row per pass that did anything: held, overdue, carded,
   *  decided, capped) and 'autoapprove' (an agent-filed about=digby_platform ticket from a SUPERVISOR seat on
   *  another account auto-approved at filing with a shape-only description: ticketId, seat). Kill switches
   *  HELD_TICKET_ESCALATION_DISABLED=1 / HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED=1. */
  HELD_TICKET_ESCALATION: 'held_ticket_escalation',
  /** MERGE-INTENT-AWAIT (supervisor SOTA round 3, 2026-10-20; coding/merge-intent.service.ts): the harness-owned
   *  merge wait. sessionId = the lane chat that queued the merge; meta { phase, repo, pullNumber, headSha, … }.
   *  phase: 'queued' | 'refreshed' (the tool parked a TIMING-class gate failure — waitKind ci_pending |
   *  merge_in_progress | server_5xx, gate, updateBranch) | 'cap' (the chat already holds 6 open intents — bounced
   *  as before) | 'cleared' (the tool merged it itself, why) | 'update_branch' (G1 BEHIND → the harness asked GitHub
   *  to update the branch, from) | 'adopted' (the update-branch merge commit became the intent head, newHead) |
   *  'merged' (the cron merged on the exact head — waitedMs, checks, mergeSha) | 'already_merged' | 'blocked' (a real
   *  gate failure on the head — gate) | 'expired' (6 h without green) | 'superseded' (a push moved the head) |
   *  'closed' | 'unobservable' (5 errors) | 'policy_off' | 'cancelled' (no wake: why lane_gone | lane_archived |
   *  lane_stopped | isolation_boundary) | 'wake_failed' (the lane wake could not be queued — retried next pass) |
   *  'loop_handoff' (a red-CI BLOCKED with the lane's ci-watch red-fix loop budget spent — no lane wake, backstop
   *  suppressed, ci-watch escalates the loop). Kill switch MERGE_INTENT_QUEUE_DISABLED=1. */
  MERGE_INTENT: 'merge_intent',
  /** MERGE-INTENT-AWAIT (2026-10-20; coding/await-condition.ts): the await_condition tool and its condition wakes.
   *  sessionId = the waiting chat; meta { phase, condition: ci | pr_merged | deploy, repo, … }. phase: 'met_in_tool'
   *  (the tool returned the verdict — waitedMs, polls) | 'registered' | 'refreshed' (not met in time — a condition
   *  wake + a backstop one-shot at the horizon, the run ends) | 'register_failed' (reason cap | backstop_failed |
   *  store_error) | 'tool_error' | 'met' (the cron woke the lane, backstop suppressed) | 'covered' (a merge-intent
   *  wake already told the lane) | 'horizon' (dropped — the backstop delivers) | 'lane_gone' | 'lane_archived' |
   *  'lane_stopped' | 'unobservable' | 'loop_handoff' (a 'ci' wait met red with the lane's ci-watch red-fix loop
   *  budget spent — no lane wake, backstop suppressed, ci-watch escalates the loop). Kill switch
   *  AWAIT_CONDITION_DISABLED=1. */
  AWAIT_CONDITION: 'await_condition',
  /** STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21; chat-agent/struck-note-repeat.ts): ONE row per
   *  machine turn (guard seam) that follows a STRUCK note in the same chat. sessionId = the chat, value = the
   *  standing similarity; meta { outcome: 'fresh' (not a repeat) | 'ineligible' (the prior was spent / struck by the
   *  screen-claims check only — measured as wouldRepeat, never acted on) | 'clean' (a reject-back produced new work)
   *  | 'still_repeat_annotated' (the retry repeated — delivered with the annotation) | 'retry_failed' |
   *  'annotated_no_retry' (a cancelled run) | 'annotated_replay_unsafe' (the reject-back was skipped — a replay could
   *  repeat a side effect, meta.skip — and no cycle re-ran the wake) | 'guard_cycle_repeat' (skipped, but the guard's
   *  own reject-back re-ran the wake anyway and a copy stands — meta.guardCycle {swapped}), reason, similarity,
   *  wouldRepeat?, retrySimilarity?, cycle?, guardCycle?, lineage? ('repeat' |
   *  'copy_of_spent' — the spend stamp written on the delivered row), priorMessageId (8), priorStruck (annotated |
   *  replaced | redacted), priorSpent, struckClaims, priorBlock, supervisorScope? }. Kill switch
   *  STRUCK_NOTE_REPEAT_DISABLED=1. */
  STRUCK_NOTE_REPEAT: 'struck_note_repeat',
  /** COMPUTER_TASK CLAIM CHECK (related to ticket 4c7aebf7 (c), 2026-10-21; chat-agent/computer-task-claims.ts): ONE
   *  row per supervisor-class machine note whose verdict is not empty (a screen-input claim found, or a computer_task
   *  call made). OBSERVE-ONLY by default — the note is never touched unless COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1.
   *  sessionId = the chat, value = the claims the verdict rests on; meta { unbacked, reason (no_claims | backed |
   *  no_computer_task_call | no_device_claim | no_input_possible | browser_task_ran | unknown_result | struck_note),
   *  found, claims, deviceClaims, totalCalls, calls {class: n}, mode (observe | annotate), annotated,
   *  supervisorScope? } — counts only, NEVER note text. Kill switch COMPUTER_TASK_CLAIM_CHECK_DISABLED=1. */
  COMPUTER_TASK_CLAIM: 'computer_task_claim',
  /** NEWS FORMATTER LADDER (log-signal family a800a12d, 2026-11-01; news.service.ts): ONE row per
   *  designed news-formatter ladder event, so the class stays MEASURABLE after its emit sites stopped
   *  writing untagged warn rows (the hourly log-signal sweep re-filed them every ISO week). value = 1.
   *  meta { phase: 'prefetch_retry' | 'llm_reformat' | 'extract_failed',
   *  outcome: 'thin' | 'fallback' | 'attempted' | 'extract_failed', source }. NOT the outage alarm —
   *  a sustained news outage still escalates through the fetch circuit breaker (recordFetchFailure →
   *  ONE deduped mishap ticket, fe661565). */
  NEWS_FORMATTER_LADDER: 'news_formatter_ladder',
  /** NEWS FETCH BREAKER RESET (ticket ebc81863, 2026-11-01; news.service.ts recordFetchSuccess):
   *  ONE row each time a HEALTHY news fetch discards a NON-ZERO failure streak. The fetch breaker's
   *  success half used to reset silently, so "the trip predicate genuinely never saw 4-in-60s" and
   *  "the pipeline was degraded-but-alive, an occasional success kept resetting it" produced the
   *  identical log store — and only the OPEN path ever files a ticket, so the degraded class paged
   *  no one. value = the discarded streak (failures); meta { streak, spanMs, source }.
   *  A zero-streak success writes NOTHING (this is a reset event, never a per-fetch counter). */
  NEWS_FETCH_BREAKER_RESET: 'news_fetch_breaker_reset',
  /** TERMINAL STEP OUTCOME (ticket 0973bdd7, 2026-11-01; chat-agent/terminal-step-brief.ts): ONE row per
   *  scheduled run whose OWN stored prompt declares a terminal side-effect, recording what actually
   *  happened to it — because for two mornings the durable row said "ping NOT sent" while the platform
   *  backstop had delivered it a second later, and the genuinely-MISSED case looked identical.
   *  sessionId = the chat, value = 1; meta { scheduleId, step, outcome: 'model' (the model made the call)
   *  | 'platform' (the finalize backstop did) | 'missed' (NOBODY did — the owner-facing half of the
   *  deliverable is missing) | 'quiet' (a "Nothing new." firing, no ping wanted) }. 'missed' is the only
   *  alarm value. Always-on by design (no kill switch): a purely additive telemetry row is exactly what
   *  was missing for two mornings, so this class must never be switchable off. */
  TERMINAL_STEP_OUTCOME: 'terminal_step_outcome',
  /** TICKET 1425001e (2026-11-01) — THE LOSS SIGNAL of a tool-call severance.
   *  ONE row per rejected call whose class was settled as `ec:'siv'`
   *  (severed-in-transit — see coding/tool-arguments.ts classifyToolCallLoss:
   *  the provider declared the turn COMPLETE and every byte it sent was
   *  appended here) AND which reached the executor UNRECOVERED.
   *
   *  WHY A SEPARATE KIND, and not a filter on TOOL_CALL_FINALIZE. The
   *  acceptance PROBE `loop_metric_count` supports ONE meta key/value pair
   *  (ticket-metric.ts PROBE_PARAMS: metaKey/metaValue) from a CLOSED 18-key
   *  set that does not carry `ec`/`sv`, and it can express neither a two-key
   *  AND nor an inequality. So "tool_call_finalize rows with ec=siv that were
   *  NOT recovered" was NOT expressible as an acceptance metric — which is how
   *  ticket 8b62e61e ended up measured by a warn-VOLUME probe that counts an
   *  emission site (`coding-model.ts:2145`) its fix never touched. A dedicated
   *  kind makes the loss signal declaratively countable with `kind` alone.
   *
   *  WHAT "UNRECOVERED" MEANS HERE — by construction, not by a filter. The
   *  `reemit` arm of the severed-stream ladder `continue`s BEFORE the turn is
   *  dispatched, so a cut the harness RE-REQUESTED never reaches this seam and
   *  can never write this row. Every row of this kind is therefore a cut that
   *  the executor actually saw: the re-emit budget was already spent this run
   *  (`sv:'already-recovered'`), a complete SIBLING call in the same turn made
   *  a re-emit the wrong trade (`sv:'complete-sibling'`), there was no
   *  transport signal to act on, or the ladder was disabled. `sv:'cancelled'`
   *  (Stop pressed) is the ONE arm NOT counted — a user-initiated stop is not a
   *  loss the harness owes anyone.
   *
   *  The warn at the finalize seam is the DELIBERATE alarm for this class and
   *  is untouched: containment means naming and counting the loss, never
   *  silencing it. meta { ok:false (so the ok/fail aggregate can rate it), ec,
   *  sv, tool, callId } — `ok`/`ec`/`sv` are short keys on purpose so they
   *  survive fleet-telemetry's ~240-char meta render cut. (The emit seam's ctx
   *  carries no provider/model, so none is claimed here.)
   *  Always-on by design (no kill switch): a purely additive telemetry row. */
  TOOL_CALL_UNRECOVERED_SEVERANCE: 'tool_call_unrecovered_severance',
  /** SAA-1.3 PHASE 0 (todo 9114e7b5, 2026-11-02; platform/inline-spill.ts): ONE row per
   *  injector call that had something to SPILL. TWO loss classes, both counted: objects the
   *  surface's cap CLIPPED (a followable pointer would have been added) and objects it
   *  dropped WHOLE (zero chars reached the model). OBSERVE-ONLY: the injected text is
   *  returned UNCHANGED (the plan type pins `applied:false`, so no call site can read a
   *  plan as a rewrite) and this row is the only production effect. value = 1;
   *  meta { surface: 'chat_messages' | 'drain_triage' | 'decision_gate' | 'supervisor_wake' |
   *  'run_receipts' | 'search_memory', wouldInject (clipped+dropped), clipped, droppedRows,
   *  elidedChars (chars the cap clipped away), wouldAddChars (what a Phase-1 pointer would
   *  cost), ids (≤3, 8-char) } — counts and ids only, NEVER injected prose.
   *  The droppedRows class is counted SEPARATELY because it is the invisible one: an earlier
   *  cut of this kind wrote no row when nothing was clipped, which silenced the drain-triage
   *  case (whole rows skipped at `budget <= 0`) that SAA-1.3 exists to expose. A call that
   *  lost NOTHING still writes nothing, so the rate is "calls that lost something / calls".
   *  Read it with get_fleet_telemetry view 'metrics' kind 'inline_spill_observe'.
   *  Kill switch: INLINE_SPILL_INJECTION_DISABLED=1 (release; =1 restores today's per-surface
   *  caps verbatim AND stops the row — the observation is the feature in Phase 0). */
  INLINE_SPILL_OBSERVE: 'inline_spill_observe',
  /** SAA-1.4 PHASE 0 (todo 9114e7b5, 2026-11-02; platform/chain-of-recall.ts): ONE row per
   *  recall call that had a NEXT-HOP id to offer — the parent goal / sibling todo / authoring
   *  run / receipt behind a hit, resolved from data the surface already read. OBSERVE-ONLY:
   *  no `next:` line is appended (the chain type pins `applied:false`) and this row is the
   *  only production effect. value = 1; meta { surface: 'search_memory' | 'get_run_receipts' |
   *  'goal_get' | 'todo_get', wouldAppend, kinds {run? goal? todo? receipt?}, ids (≤3, 8-char) }
   *  — ids and counts only, never the hop labels (those can carry prose). A recall with no
   *  resolvable next hop writes NOTHING. On get_run_receipts the hops are the chat's
   *  charterGoalId / charterTodoId and `input.scheduleId` of the returned runs — the runs
   *  query MUST therefore select `input` (it did not at first, which made the schedule hop
   *  dead code; pinned by a source assertion in saa1-phase0.observe-only.test.ts).
   *  Kill switch: CHAIN_OF_RECALL_DISABLED=1 (release; =1 stops appending `next:` lines — and
   *  in Phase 0 stops the row). */
  CHAIN_OF_RECALL_OBSERVE: 'chain_of_recall_observe',
} as const;

export type LoopMetricKind = (typeof LOOP_METRIC_KINDS)[keyof typeof LOOP_METRIC_KINDS];
