/**
 * Loop-metrics foundation (audit #12) — service tests.
 *
 * Pins the three contracts wiring code will rely on:
 *   1. recordLoopMetric / recordRunSpend are fire-and-forget and NEVER throw —
 *      not with a down DB, not with garbage input, not with circular meta —
 *      so guards/hooks can instrument themselves with a bare call.
 *   2. Spend accounting: a RunUsage-shaped snapshot becomes per-model
 *      run_tokens_in/run_tokens_out rows + exactly one run_spend row.
 *   3. Aggregation math: bucket normalization (BigInt counts, null sums,
 *      Date buckets), summary mapping, window clamping, batched retention GC.
 *
 * Prisma + logger are mocked (platform.service.test.ts pattern).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreateMany: jest.Mock = jest.fn();
const mockFindMany: jest.Mock = jest.fn();
const mockDeleteMany: jest.Mock = jest.fn();
const mockGroupBy: jest.Mock = jest.fn();
const mockQueryRaw: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: {
      createMany: (...a: any[]) => mockCreateMany(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
      groupBy: (...a: any[]) => mockGroupBy(...a),
    },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  },
}));

import logger from '../../../utils/logger';
import {
  LOOP_METRIC_KINDS,
  LOOP_METRIC_FLUSH_BATCH,
  LOOP_METRIC_FLUSH_MS,
  LOOP_METRIC_MAX_PENDING,
  LOOP_METRIC_GC_BATCH,
  recordLoopMetric,
  recordLoopMetrics,
  recordRunSpend,
  noteUtilityLlmFailure,
  noteSeatFallback,
  countSeatFallbacksByRole,
  SEAT_FALLBACK_COUNT_MAX_ROWS,
  flushLoopMetrics,
  queryLoopMetrics,
  queryLoopMetricOutcomes,
  queryLoopMetricPayloadSizes,
  normalizeLoopMetricOutcomes,
  normalizeLoopMetricPayloadSizes,
  outcomeRate,
  summarizeLoopMetrics,
  normalizeLoopMetricBuckets,
  sweepLoopMetrics,
  __resetLoopMetricsForTest,
} from './loop-metrics.service';

beforeEach(() => {
  jest.clearAllMocks();
  __resetLoopMetricsForTest();
  mockCreateMany.mockResolvedValue({ count: 0 });
  mockFindMany.mockResolvedValue([]);
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockGroupBy.mockResolvedValue([]);
  mockQueryRaw.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

const flushedRows = (): any[] => mockCreateMany.mock.calls.flatMap((c: any[]) => c[0].data);

// ── Kind constants ────────────────────────────────────────────────────────────

describe('LOOP_METRIC_KINDS', () => {
  it('exports exactly the audit-#12 kind set (+ the supervisor value-telemetry kinds, 2026-09-02)', () => {
    expect(LOOP_METRIC_KINDS).toEqual({
      GUARD_STRIKE: 'guard_strike',
      // markdown-lint (ticket 942db7aa): malformed markdown structure in a
      // machine note (collapsed/detached table rows, glued header, run-on
      // list) — meta { surface:'machine_note', phase:'emitted'|'residual', classes }.
      MARKDOWN_LINT_STRIKE: 'markdown_lint_strike',
      // 2026-09-08 audit: the evidence guard threw mid-evaluation → PARTIAL verdict, observable.
      GUARD_ERROR: 'guard_error',
      GUARD_MISS: 'guard_miss',
      // Deploy-interrupt telemetry (feedback 56159c5a): one row per detached
      // chat run killed by a process shutdown — meta { reason:'deploy', ... }.
      CHAT_RUN_INTERRUPTED: 'chat_run_interrupted',
      // WI-G (2026-09-25): a machine chat run on a RETIRING colour was told once to write its final now.
      DEPLOY_RETIRE_NUDGE: 'deploy_retire_nudge',
      WAKE_DELIVERED: 'wake_delivered',
      WAKE_PARKED: 'wake_parked',
      RUN_SPEND: 'run_spend',
      RUN_TOKENS_IN: 'run_tokens_in',
      RUN_TOKENS_OUT: 'run_tokens_out',
      // E5 context_window_used (2026-09-26): per-model context fill at finalize —
      // peak prompt tokens vs the model's known window. Measure-only.
      RUN_CONTEXT_FILL: 'run_context_fill',
      UX_BEACON: 'ux_beacon',
      // Stream drops (2026-10-20, chat-agent/stream-drops.ts): a viewer left mid-run / a viewer reattached.
      SSE_VIEWER_DROP: 'sse_viewer_drop',
      SSE_REATTACH: 'sse_reattach',
      // Compute policy (2026-09-26, cp/harness): TTFT per chat turn (the DepthPlan row is COMPUTE_POLICY below).
      UX_TTFT: 'ux_ttft',
      // roster 2026-10-06 D-1 / D-2: the persisted session roster + the lead's call_in tool.
      SESSION_ROSTER: 'session_roster',
      CALL_IN: 'call_in',
      // 2026-10-06 (late): the F2 frontier reflection council + the F1 ignored-store-'all' note.
      FRONTIER_COUNCIL: 'frontier_council',
      AUTO_PICK_POLICY: 'auto_pick_policy',
      // Environmental verify red (2026-09-10 infra-red honesty): one row per
      // OOM/SIGKILL chain death, meta { stage, exitCode }.
      VERIFY_ENV_RED: 'verify_env_red',
      // T2e (todo a04cda91, ticket 7ec6200b): the per-command-timeout stage
      // death — its own FAILURE-class kind, split from verify_env_red.
      VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout',
      // A4 (2026-09-27): no verify chain at the auto-verify / verify-tool seam — meta { projectId, reason, seam, configPresent }.
      VERIFY_ABSENT: 'verify_absent',
      // DW-2 (backlog 2026-10-02; FO f118, 2026-10-11): .digby/config.json exists
      // but could not be read/parsed — meta { projectId, seam, error }. Observe-only.
      VERIFY_CONFIG_READ_ERROR: 'verify_config_read_error',
      // A1 (2026-10-04): the auto-verify skipped an unchanged tree after a green of the same chain.
      VERIFY_UNCHANGED_SKIP: 'verify_unchanged_skip',
      // build 2026-10-09 VS: one row per verify chain the per-container slot limiter decided (verify-container-slots.ts).
      VERIFY_SLOT_WAIT: 'verify_slot_wait',
      // ff262da5 (2026-10-16): the ENV-STARVED verify verdict — one row per
      // deferred chain (container working-set / host floor / session allowance).
      VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred',
      // Infra-actuation lever (ticket c12239c1): one receipt row per infra_action
      // call — dry-run/refused/cooldown included (the pre-arming audit trail).
      INFRA_ACTION: 'infra_action',
      UTILITY_LLM_DUAL_FAILURE: 'utility_llm_dual_failure',
      // Supervisor value telemetry — HARNESS-classified by the attention-watchdog
      // note scan (classifySupervisorNote), never model-claimed.
      SUPERVISOR_NOOP: 'supervisor_noop',
      SUPERVISOR_ACTION: 'supervisor_action',
      SUPERVISOR_NOTE: 'supervisor_note',
      // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): the harness record of each supervisor machine wake.
      SUPERVISOR_HARNESS_RECEIPTS: 'supervisor_harness_receipts',
      // ticket 0c647003 — owner-turn forged-chrome strip (supervisor chats)
      SUPERVISOR_FORGED_CHROME: 'supervisor_forged_chrome',
      // Chat grounding telemetry (owner 2026-09-03 search-force removal):
      // one row per chat run, meta { mode, webToolCalls }.
      CHAT_SEARCH_USAGE: 'chat_search_usage',
      DEEP_RESEARCH_QUOTA_REJECTED: 'deep_research_quota_rejected', // patience plan 1a (2026-09-25): the controller refused a council send on quota
      // Chat platform-usage telemetry (2026-09-08 agentic expansion — the
      // capability playbook): one row per chat run, meta { mode,
      // platformToolCalls, tools, actionChips, machine }.
      CHAT_PLATFORM_USAGE: 'chat_platform_usage',
      // Phantom web-failure claim telemetry (ticket 1ef71188, 2026-09-27): a
      // chat run narrated a web-attempt FAILURE its own parts do not back.
      CHAT_PHANTOM_WEB_CLAIM: 'chat_phantom_web_claim',
      HANDBACK_DETECTED: 'handback_detected',
      LIVE_CHAT_AUDIT: 'live_chat_audit',
      // Coding retrieval-grounding telemetry (owner 2026-09-04 "doesn't read
      // memory or embeds very often"): one row per terminal coding run
      // (retrieval-vs-raw-read counts) + one row per search call (value =
      // hits; value 0 charts the empty-result rate, workers included).
      CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage',
      CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
      // Run-start project-memory injection into coding runs (owner 2026-09-14
      // — coding reads the knowledge base + decisions): one row per attempted
      // injection, value = items injected, meta { trigger, chars, sources, candidates }.
      CODING_MEMORY_INJECTED: 'coding_memory_injected',
      SUGGESTED_QUESTIONS_QUALITY: 'suggested_questions_quality',
      DECISION_GATE: 'decision_gate', // 2026-09-24 decision seat (platform/decision-gate.ts): phases 'decision' / 'outcome'
      DECISION_GATE_STATE: 'decision_gate_state', // 2026-09-26 Laya follow-up: the opt-in sampled-state corpus row (pruned by the readiness cron)
      DECISION_GATE_BACKEND_DOWN: 'decision_gate_backend_down', // audit budgets-cost-6 (2026-09-26): a decision backend latched on 401/403 / recovered / an all-legs-failed ask
      DECISION_GATE_LIFECYCLE_RETIRED: 'decision_gate_lifecycle_retired', // DECISION-GATE-LIFECYCLE (2026-10-20): a shadow purpose set off past its reviewBy or as non-converging
      COMPUTE_POLICY: 'compute_policy', // 2026-09-26 depth-UX compute policy (platform/compute-policy-gate.ts): ONE row per human turn — the DepthPlan + DepthBudget it ran under
      // I1 shrink guard (repo-integrity remediation 2026-09-09): one row per
      // git_commit refusal, value = flagged files, meta { files, allowShrink }.
      MERGE_SIZE_GUARD: 'merge_size_guard',
      // F1 preemption observability (owner incident 2026-09-04): one row per
      // user-message preemption of a machine-triggered plain-chat run,
      // meta { local }.
      CHAT_PREEMPTION: 'chat_preemption',
      // a5b36dc6: one row per preempt-path stamp of the supervisor-state
      // INFLIGHT marker (the next turn renders the live journal guard).
      INFLIGHT_PREEMPT_MARK: 'inflight_preempt_mark',
      // Seat fallback (2026-09-11): an OVERRIDE orchestrator/supervisor seat
      // finalized empty and the turn finished on the built-in orchestrator.
      SEAT_FALLBACK: 'seat_fallback',
      // e8f71984: coding-run final persisted as EXTREME degenerate provider
      // output — detect-and-mark only, never replace/retry.
      DEGENERATE_FINAL: 'degenerate_final',
      // Seats govern sessions (2026-09-28): one admin "Apply seats to existing
      // sessions" run (POST /admin/model-roles/apply-seats) — value = sessions
      // re-stamped; meta { dryRun, seat, projects, sessions, prefs }.
      SEAT_APPLY: 'seat_apply',
      // Seat governance (audit E3, 2026-09-27): a frontier-class endpoint
      // model assigned to / probed on a governed chat / supervisor seat —
      // observed (default), refused (FRONTIER_SEATS_REFUSE=1), or
      // allowed_by_owner (refusal on, owner-confirmed card).
      SEAT_GOVERNANCE: 'seat_governance',
      // Truncated-thinking recovery (2026-09-11): an answer-less turn whose
      // budget went to reasoning was retried with a bigger budget.
      TURN_TRUNCATION_RECOVERY: 'turn_truncation_recovery',
      // Remediation P0 kinds (2026-09-09 autonomy-remediation program, phase 0
      // — docs/reviews/2026-09-09-autonomy-remediation-record.md).
      WORKTREE_REAPED: 'worktree_reaped',
      // One row per worktree-reaper pass: worktree count, bytes freed, usage %.
      WORKTREE_REAP_PASS: 'worktree_reap_pass',
      // Email as Digby (ticket 54f237bf): one send attempt per loop_metrics row —
      // outcome sent/send_failed/rate_limited/not_configured, recipient PREFIX only.
      DIGBY_EMAIL_SENT: 'digby_email_sent',
      INDEX_SWEPT: 'index_swept',
      MEMORY_SHRUNK: 'memory_shrunk',
      SCAFFOLD_COMMIT_FAILED: 'scaffold_commit_failed',
      PROVIDER_REJECTED: 'provider_rejected',
      SCHEDULE_BUSY_SKIP: 'schedule_busy_skip',
      // ticket 8aa5688f (2026-10-26): the platform executed a scheduled run's
      // mandated trailing notify_user at the finalize — meta { scheduleId,
      // outcome } (SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1 kills both).
      SCHEDULED_NOTIFY_BACKSTOP: 'scheduled_notify_backstop',
      // ticket 0973bdd7 (2026-11-01): what happened to a scheduled run's
      // declared terminal side-effect — model | platform | missed | quiet.
      TERMINAL_STEP_OUTCOME: 'terminal_step_outcome',
      // FO 2026-09-23 cross-box blank fix: deferred web-box provisioning + the
      // claiming worker's fresh-spawn self-heal.
      BLANK_PROVISION_DEFERRED: 'blank_provision_deferred',
      BLANK_PROVISION_SELFHEAL: 'blank_provision_selfheal',
      // Ticket a086c69d (2026-09-28): a non-volume-owner web box deferred
      // repo-backed provisioning to the volume-owner worker.
      REPO_PROVISION_DEFERRED: 'repo_provision_deferred',
      // Hardening loop iteration 10: the claiming worker re-created a missing
      // local-provider bare mirror before reattach (FO firing 22 telemetry).
      LOCAL_MIRROR_SELFHEAL: 'local_mirror_selfheal',
      // agent-decisions prerequisite 5 (2026-09-27): a [HARNESS CONTINUATION] firing / queued row
      // skipped on a zero-unfinished plan board, at fire time (any origin) or claim time.
      SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip',
      // STOP MEANS STOP (2026-09-29): a continuation not run after a stop / deploy cut / archive.
      CONTINUATION_SUPPRESSED: 'continuation_suppressed',
      TRANSIENT_RESUME: 'transient_resume',
      INDEPENDENT_REVIEW: 'independent_review',
      // 2026-10-03 (coding/answer-key-guard.ts, opt-in): a benchmark answer-key fetch refused / withheld.
      ANSWER_KEY_BLOCKED: 'answer_key_blocked',
      // ticket 9aedb32f (2026-09-29): a deep-research council round returned no real report
      // within its budget (per-colleague ceiling + retry, degraded notice in the answer).
      COUNCIL_DEGRADED_RUN: 'council_degraded_run',
      COUNCIL_DISPATCH_TIMEOUT: 'council_dispatch_timeout',
      // Ticket c7d5f885: late council findings survive degraded run-end as an
      // addendum row (crosscheck_late_reconcile precedent).
      COUNCIL_LATE_ADDENDUM: 'council_late_addendum',
      // decision gate N2 (2026-09-25): act-mode sweep pre-triage skip (shadow by default — never fires today)
      SCHEDULE_SWEEP_SKIP: 'schedule_sweep_skip',
      SCHEDULE_PARKED_CLAIM: 'schedule_parked_claim', // N7 (2026-09-25)
      SCHEDULE_SUPERSEDED_SKIP: 'schedule_superseded_skip', // N7 (2026-09-25)
      SCHEDULE_ONCE_CHAIN: 'schedule_once_chain',
      SELF_AUDIT_RUN: 'self_audit_run',
      // Self-audit churn containment (tt-rd audit 2026-09-27): a skipped
      // round (reason), a receipt-rule CONTROL round's label, and a recurring
      // firing on an all-complete plan board.
      SELF_AUDIT_SKIP: 'self_audit_skip',
      SELF_AUDIT_CONTROL: 'self_audit_control',
      // Fixer 2026-09-27: the receipt rule's SHADOW outcome label (finding 5)
      // and a machine run editing an owner-armed cadence (finding 1).
      SELF_AUDIT_SHADOW: 'self_audit_shadow',
      SCHEDULE_OWNER_CADENCE_EDIT: 'schedule_owner_cadence_edit',
      SCHEDULE_ALLCOMPLETE_FIRING: 'schedule_allcomplete_firing',
      // P3 scheduler remediation (pin 14c): agent_runs lease-heartbeat write
      // failures (previously swallowed — a lapsed lease is re-claimable).
      LEASE_HEARTBEAT_FAILED: 'lease_heartbeat_failed',
      // FO firing 46 (2026-09-29): a 0-row heartbeat (run row gone — chat
      // deleted mid-run) cancelled the zombie execution.
      ZOMBIE_RUN_STOPPED: 'zombie_run_stopped',
      // FO firing 47 (2026-09-29): the 'utility' role override leg latched off
      // for an escalating backoff window (5→15→30→60 min on sustained failure).
      UTILITY_OVERRIDE_LATCH: 'utility_override_latch',
      // Remediation P8 (S7): one row per containment-ladder state transition,
      // meta { lane, state, prev, strikes, runs, machineMajority, outcome }.
      // Telemetry only since the 2026-09-11 gate flip (no action rows, no
      // kill-switch — CONTAINMENT_LADDER_DISABLED/ACTIONS are retired).
      CONTAINMENT_LADDER: 'containment_ladder',
      // ticket c25f8b7e (2026-11-03): a session's container was REPLACED under a
      // live lane — the docker id resolved for the session differs from the one
      // on record (a deploy/restart wave, a host reprovision, or an operator
      // recycle). Everything the lane had running INSIDE the old container is
      // gone. meta { container, previousSeenAt, replacedAt }. A burst of these in
      // one minute is a wave that killed N lanes' background workers; a lone row
      // is one session reprovisioned.
      CONTAINER_REPLACED: 'container_replaced',
      // Self-merge follow-on (owner 2026-09-09): one row per merge_pull_request
      // gate refusal, meta { gate, cause, repo, pullNumber, cycles }.
      MERGE_GATE_FAILURE: 'merge_gate_failure',
      // The success counterpart: one row per confirmed merged:true, meta
      // { repo, pullNumber, mergeSha, cycles, machineTriggered } — merge
      // outcomes chart as a rate, not failures alone.
      MERGE_SUCCESS: 'merge_success',
      // agent-decisions prerequisite 4 (2026-09-27): the self-merge WAIT-ONCE slept once on a
      // timing-class gate failure before re-running the gates.
      MERGE_WAIT_ONCE: 'merge_wait_once',
      // log-signal family a800a12d (2026-11-01, tickets 0de27d1b / d1be4f9e /
      // b4bfd09a / 359c3a35): ONE row per designed news-formatter ladder event,
      // so the class stays measurable after its emit sites stopped writing
      // untagged warn rows to app_error_logs (the hourly sweep re-filed them
      // every ISO week). NOT the news outage alarm — that stays the fetch
      // circuit breaker's deduped mishap ticket (fe661565).
      NEWS_FORMATTER_LADDER: 'news_formatter_ladder',
      // ticket ebc81863 (2026-11-01): ONE row per HEALTHY news fetch that discarded a non-zero
      // fetch-breaker failure streak — the success half of the breaker used to reset silently, so a
      // degraded-but-alive pipeline (an occasional success resetting the streak, so it never trips
      // and never pages) left no fingerprint anywhere. Zero-streak successes write nothing.
      NEWS_FETCH_BREAKER_RESET: 'news_fetch_breaker_reset',
      // agent-decisions prerequisite 6 (2026-09-27): one row per goal-continue evaluation.
      GOAL_CONTINUE: 'goal_continue',
      // tt-rd audit 2026-09-27 (kpi-honesty-loops): a kpi: premise set from a verified receipt;
      // a supervisor reply that typed a rate the register does not hold (footer appended);
      // one [NO-ADOPTION] wake per KPI goal per 24 h.
      KPI_PREMISE_SET: 'kpi_premise_set',
      KPI_REPLY_MISMATCH: 'kpi_reply_mismatch',
      // cohesive-chat wave 2026-09-28: turn continuation lifecycle (chat-agent/turn-continuation.ts).
      TURN_CONTINUATION: 'turn_continuation',
      ADOPTION_LADDER: 'adoption_ladder',
      // fixer follow-up 2026-09-27: the KPI contract's refusals are measurable (refused / (refused + set)).
      KPI_PREMISE_REFUSED: 'kpi_premise_refused',
      // Owner-gate sweeper receipts (ticket 356d21bb): one row per sweep pass,
      // meta { unblockedTodos, unblockedGoals, resolvedDupes, resolvedPendings }.
      OWNER_GATE_SWEEP: 'owner_gate_sweep',
      // fadc3563 (2026-10-04): one row per held answer (a HOLD/negative owner
      // answer keeping a gated goal/todo blocked as the owner's hold).
      OWNER_GATE_HOLD: 'owner_gate_hold',
      // Self-re-arming governor refusal (finding B2, 2026-09-27).
      SCHEDULE_RENEW_REFUSED: 'schedule_renew_refused',
      // Arm-time duration fit (finding B3, 2026-09-27): one row per recurring
      // arm/update whose cadence is shorter than 2× the lane's p50 run length,
      // meta { outcome: 'stretched' | 'warned', requestedSec, intervalSec,
      // floorSec, p50RunMs, samples, scheduleId? }.
      SCHEDULE_DURATION_FIT: 'schedule_duration_fit',
      // Supervisor deferred-action receipts are observe-only (gate flip
      // 2026-09-11): one row per unarmed deferral, meta { line }.
      SUPERVISOR_DEFERRAL_UNARMED: 'supervisor_deferral_unarmed',
      // premise register + follow-through (owner 2026-09-16, framework items 2 + 3)
      PREMISE_REVISED: 'premise_revised',
      FOLLOW_THROUGH_NUDGE: 'follow_through_nudge',
      PREMISE_REGISTER_WAKE: 'premise_register_wake',
      // ticket 4ac547de (2026-10-17): the deterministic follow-ups backstop
      // fired on a zero-chip Level 2 human turn — meta { got, outcome, timeoutMs }.
      FOLLOWUP_BACKSTOP: 'followup_backstop',
      DECISION_AUTOFILED: 'decision_autofiled',
      DIRECTIVE_OPEN_AGE: 'directive_open_age',
      DIRECTIVE_FOLLOW_THROUGH: 'directive_follow_through',
      DIRECTIVE_CLOSE_UNRECEIPTED: 'directive_close_unreceipted',
      // f8c62820 (2026-10-06): child→parent result hook parked on ownership move
      CHILD_OWNERSHIP_WAKE_SKIPPED: 'child_ownership_wake_skipped',
      // infra watch (owner 2026-09-18)
      BOX_HEALTH: 'box_health',
      INFRA_ALERT: 'infra_alert',
      /** Ticket 8a66441e (2026-10-16): the hourly log-signal-sweep over app_error_logs. */
      LOG_SIGNAL_SWEEP: 'log_signal_sweep',
      FRAMEWORK_SIGNAL_SWEEP: 'framework_signal_sweep',
      // ACCEPTANCE-METRIC-BASELINE + TICKET-FAMILY-ROUTING (2026-10-20): per-finding
      // event-time rows, family precision routing, the acceptance-metric baseline gate.
      FRAMEWORK_SIGNAL_FINDING: 'framework_signal_finding',
      TICKET_FAMILY_ROUTING: 'ticket_family_routing',
      ACCEPTANCE_METRIC_BASELINE: 'acceptance_metric_baseline',
      // FO firing 102 (2026-10-08): one row per successful deploy run the sweep
      // has seen — the recovery signal for red-deploy alerts (meta { runId, sha, at }).
      DEPLOY_WAVE_SUCCESS: 'deploy_wave_success',
      // DEPLOY-WATCH-BLIND (2026-10-20): one row per infra-watch sweep that could
      // not read the deploy.yml runs (meta { reason, consecutive, since, … }).
      INFRA_WATCH_BLIND: 'infra_watch_blind',
      INFRA_WATCH_SOURCE: 'infra_watch_source',
      // LANE-IDLE-WAKE (2026-10-20): the lane-idle supervisor wake — finalize decision + delivery revalidation.
      LANE_IDLE_WAKE: 'lane_idle_wake',
      // capacity watch (todo 0f58ddde, 2026-10-16): box-C saturation probes —
      // drainer pool, dev-container working-set memory, ticket-queue depth.
      CAPACITY_DRAINER_POOL: 'capacity_drainer_pool',
      CAPACITY_DEV_MEMORY: 'capacity_dev_memory',
      CAPACITY_TICKET_QUEUE: 'capacity_ticket_queue',
      MACHINE_START_DEFERRED_RETIRING: 'machine_start_deferred_retiring',
      PRODUCT_ALERT: 'product_alert',
      CROSSCHECK_LATE_RECONCILE: 'crosscheck_late_reconcile',
      PROVIDER_COOLDOWN: 'provider_cooldown',
      TOOL_LIST_TRIMMED: 'tool_list_trimmed', // 2026-09-27 seat/provider limits
      TOOL_GROUPS: 'tool_groups', // 2026-09-27 late, progressive tool disclosure (coding/tool-groups.ts)
      RUN_TOOL_PROFILE: 'run_tool_profile',
      EDIT_DIAGNOSTICS: 'edit_diagnostics',
      HOOK_STARVATION_YIELD: 'hook_starvation_yield',
      FINALIZE_HANDOFF: 'finalize_handoff',
      // Filer duplicate-retire rail (76045f4e, 2026-10-16): the filing session
      // retired its own duplicate — meta { ticketId, duplicateOf, filerClass }.
      FILER_DUPLICATE_RETIRE: 'filer_duplicate_retire',
      // Ticket 6665fff6 (b4824553 lifecycle half): the post-deploy done-bar.
      TICKET_DONE_BAR_REFUSAL: 'ticket_done_bar_refusal',
      // d34f1d6a (2026-10-17): one row per ticket-lane slot release episode —
      // a live lane's slot surrendered (idle sleep/poll park) or force-released
      // (hard per-lane cap): meta { reason:'idle'|'cap', laneId, ticketId, heldMs, windowMs?|capMs? }.
      TICKET_LANE_SLOT_RELEASE: 'ticket_lane_slot_release',
      // 9dacab1a (2026-10-18): a ticket's dependency set was written (the
      // queue's dependsOnTicketIds layer): meta { ticketId, deps, cleared }.
      TICKET_DEPENDENCY_SET: 'ticket_dependency_set',
      TICKET_POSTDEPLOY_VERIFIER: 'ticket_postdeploy_verifier',
      // 1a6afc6a (2026-10-24): the drain's pre-spawn status re-read caught a
      // ticket that closed between the scan and the spawn — meta { phase,
      // laneFor, blocked, family?, members? }.
      TICKET_DISPATCH_CLOSE_RACE: 'ticket_dispatch_close_race',
      WORKTREE_SNAPSHOT_FAILED: 'worktree_snapshot_failed',
      CHILD_SESSION_ARCHIVED: 'child_session_archived',
      MACHINE_DISPATCH_ARCHIVED_REFUSED: 'machine_dispatch_archived_refused',
      RUN_LOCK_REACQUIRED: 'run_lock_reacquired',
      WORKTREE_SNAPSHOT_TRIMMED: 'worktree_snapshot_trimmed',
      QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt',
      // 2026-11-01 RAG transport incident: one row per rerank/embed ATTEMPT
      // (ok or not), so a failure RATE has a denominator. The incident ran 689
      // rerank timeouts/24h with no rate because the emit was a bare warn.
      RAG_RERANK_CALL: 'rag_rerank_call',
      RAG_EMBED_CALL: 'rag_embed_call',
      FINALIZE_HOOKS_FIRST: 'finalize_hooks_first',
      // P5 (2026-10-06, options doc §D): shadow firing-size predictor — value = verdict, never caps the seat.
      FIRING_SIZE_PREDICTED: 'firing_size_predicted',
      FLEET_SWEEP_DORMANCY: 'fleet_sweep_dormancy',
      // Supervisor OFF switch (owner 2026-09-26): flips + rate-limited skipped wakes.
      SUPERVISOR_SWITCH: 'supervisor_switch',
      SUPERVISOR_SEND_TIMING: 'supervisor_send_timing',
      // Always-Auto switch (audit 2026-09-26): one row per real patience_auto_only flip.
      PATIENCE_SWITCH: 'patience_switch',
      USER_MEMORY_MUTATION: 'user_memory_mutation',
      MEMORY_EXTRACTION: 'memory_extraction',
      CONTEXT_COMPACTION: 'context_compaction',
      // Session titles + topology (2026-09-27).
      TITLE_RENDER: 'title_render',
      SESSION_TOPOLOGY: 'session_topology',
      SESSION_TOPOLOGY_OUTCOME: 'session_topology_outcome',
      // Lane lifecycle C (2026-10-21): an idle machine-spawned lane retired / a pass / a cascade child.
      LANE_RETIRED: 'lane_retired',
      MEMORY_SCOPE_EVICTED: 'memory_scope_evicted',
      MEMORY_SEARCH_TIMING: 'memory_search_timing',
      // WRP-1 D4 / RAG-1 (2026-10-31): a read answered by the same-run RAW path —
      // meta {path:'raw-first'|'raw-fallback', overlap, ageMinutes, scopes, queryChars}.
      // 'raw-fallback' is the incident class (fresh rows present, ranked ladder empty).
      MEMORY_SAME_RUN_RAW_RECALL: 'memory_same_run_raw_recall',
      // FO f185 (2026-10-22): the unified-memory embed circuit breaker's transition rows.
      UNIFIED_MEMORY_EMBED_BREAKER: 'unified_memory_embed_breaker',
      UNIFIED_MEMORY_EMBED_FAILED: 'unified_memory_embed_failed',
      // Ticket d7bf73c2: the memory-embed-backfill cron's repair pass (NULL rows re-embedded).
      MEMORY_EMBED_BACKFILL: 'memory_embed_backfill',
      AUTH_LOGIN_FAILED: 'auth_login_failed',
      AUTH_PASSWORD_CHANGED: 'auth_password_changed', // change-password (2026-10-12)
      HOOK_SIBLING_DRAIN: 'hook_sibling_drain',
      // SAA-1.1 Phase 1 (todo eb328629): the deterministic trigger-admission
      // policy's observe row — one per batch it had a NON-default opinion about.
      HOOK_SOURCE_POLICY_OBSERVE: 'hook_source_policy_observe',
      // SAA-1.2 Phase 1 (todo c0b8b8cf): the thread pass-through observe row —
      // one per delivery group whose wildcard supervisor wake had a DIFFERENT
      // owning lane to name. Observe-only: no wake is ever re-targeted.
      HOOK_THREAD_PASSTHROUGH_OBSERVE: 'hook_thread_passthrough_observe',
      WAKE_QUEUE_RIDER: 'wake_queue_rider',
      // Firing 11 (2026-09-23): one row per Google WRITE tool call — the
      // 32d0ebc8 owner-steered ok/reason distribution.
      GOOGLE_WRITE_TOOL: 'google_write_tool',
      GOOGLE_REFRESH_LATCH: 'google_refresh_latch',
      GOOGLE_REFRESH_LATCH_SUPPRESSED: 'google_refresh_latch_suppressed',
      // e1cca01d (2026-10-19): the GitHub label-miss fallback's warn latch —
      // one row per (userId, pinnedLabel) per window while the f121 fallback
      // itself stays silent-but-working. meta { pinnedLabel, fallbackLabel,
      // fallbackUsername, userId, warnMs }.
      GITHUB_LABEL_FALLBACK: 'github_label_fallback',
      // 2026-10-01, tickets 9a818013 / a7f6c4e4: gmail_get_attachment resolved a
      // ROTATED (stale-but-valid) attachmentId by downloading directly.
      GMAIL_STALE_ATTACHMENT_ID: 'gmail_stale_attachment_id',
      USER_MCP_CALL: 'user_mcp_call', // user-added MCP servers: one row per mcp_<server>_<tool> call (ticket e294f9a4)
      USER_MCP_HEALTH: 'user_mcp_health', // user-added MCP servers: health status transitions (ticket e294f9a4)
      PG_UNSAFE_STRIPPED: 'pg_unsafe_stripped',
      AGENT_EVENTS_RETENTION: 'agent_events_retention',
      AGENT_EVENTS_COMPACTION: 'agent_events_compaction',
      // wake-cadence (2026-09-27 tt-rd audit): steer dedupe, adaptive stretch,
      // sweep backoff, prompt lint, report-up classification, wrap-up note.
      SCHEDULE_STEER_DEDUPED: 'schedule_steer_deduped',
      SCHEDULE_CADENCE_STRETCHED: 'schedule_cadence_stretched',
      SWEEP_BACKOFF: 'sweep_backoff',
      BLOCK_STREAK_BACKOFF: 'block_streak_backoff',
      BLOCK_STREAK_OBSERVED: 'block_streak_observed',
      SCHEDULE_PROMPT_LINT: 'schedule_prompt_lint',
      SUPERVISOR_REPORT_UP: 'supervisor_report_up',
      SCHEDULE_RUN_WRAPUP_NOTE: 'schedule_run_wrapup_note',
      MACHINE_RUN_DURATION: 'machine_run_duration',
      MACHINE_RUN_WOULD_CUT: 'machine_run_would_cut',
      RUN_QUEUE_WAIT: 'run_queue_wait',
      WORKTREE_SNAPSHOT_COALESCED: 'worktree_snapshot_coalesced',
      CROSSCHECK_RECONCILE: 'crosscheck_reconcile',
      REPO_HOOK: 'repo_hook',
      WORKER_SEAT_ROUTE: 'worker_seat_route',
      // build 2026-10-08 ISO — per-user workspace subtree + credential proxy telemetry.
      WORKSPACE_ISOLATION: 'workspace_isolation',
      CREDENTIAL_PROXY: 'credential_proxy',
      EDIT_CHECKPOINT_REWIND: 'edit_checkpoint_rewind',
      WEB_FETCH_PATH: 'web_fetch_path',
      WEB_PIPE_TIMING: 'web_pipe_timing', // 2026-10-20 real-user audit: web_pipe stage timings
      // D3 (goal 9ecd595e, 2026-10-31): one row per call that actually WAITED
      // OUT a provider-stated throttle under a caller's resumeBudgetMs, so a
      // resume is measurable in prod instead of only a container log line.
      WEB_SERP_RESUME: 'web_serp_resume',
      TOOL_BATCH_CAP: 'tool_batch_cap',
      // ticket efdb3d31 (2026-10-29): OBSERVE-ONLY finalize-seam diagnosis for
      // the "Unexpected end of JSON input" drop class.
      TOOL_CALL_FINALIZE: 'tool_call_finalize',
      // ticket efdb3d31 (2026-10-29): SSE closed without its `[DONE]` sentinel
      // AND the payload is structurally truncated ⇒ re-emit the turn once.
      // Carries rz (reasoningChars) + len[] (per-call argLen) on one row.
      SEVERED_STREAM_RECOVERY: 'severed_stream_recovery',
      // ticket 1425001e (2026-11-01): THE LOSS SIGNAL — a rejected call settled
      // as ec:'siv' that reached the executor UNRECOVERED (the re-emit arms
      // `continue` before dispatch, so they can never write this row).
      TOOL_CALL_UNRECOVERED_SEVERANCE: 'tool_call_unrecovered_severance',
      // Machine schedule self-management / confirmation staging are
      // observe-only (gate flip 2026-09-11; platform-tools gate).
      MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation',
      CONFIRMATION_STAGED: 'confirmation_staged',
      WORK_TOOL_DIRECT: 'work_tool_direct',
      // FO firing 24 (2026-09-25): todo_create canonicalized a unique ≥8-char
      // goal prefix to its full id (the live 'Goal not found: "09a1ec04"'
      // class) — meta { from, to, userId }.
      TODO_CREATE_PREFIX_RESOLVED: 'todo_create_prefix_resolved',
      TODO_ASSIGNEE_PREFIX_RESOLVED: 'todo_assignee_prefix_resolved',
      // TD-1 (Cluster 5, 2026-11-03): one row per todo_create that arrived with
      // NO assigneeChatId, recording the decision the assignee policy made
      // (auto_assign / refuse / unassigned, plus `wouldBe` in observe-only mode).
      TODO_CREATE_ASSIGNEE_POLICY: 'todo_create_assignee_policy',
      // TD-1 audit pass: one row per `in_progress` todo found with no assignee.
      TODO_ASSIGNEE_AUDIT: 'todo_assignee_audit',
      GOAL_TODO_NEAR_MATCH_RESOLVED: 'goal_todo_near_match_resolved',
      // 99ad288e + 636b622b (2026-09-28): a full-shape id with an invented
      // suffix resolved to the unique visible same-prefix row — meta
      // { entity, typed, resolved, userId }.
      GOAL_TODO_SUFFIX_HEALED: 'goal_todo_suffix_healed',
      // eb4337fe (ruling oq_2674964f): one row per card-free machine-delegated
      // autonomy grant (meta { granterChatId, targetChatId, allowedTools,
      // scheduleCap }) and one per preference-covered digest arming (meta names
      // the matched preference key) — an authority change must never be silent.
      AUTONOMY_DELEGATION: 'autonomy_delegation',
      PREFERENCE_DIGEST_ARMED: 'preference_digest_armed',
      // Stale gates (2026-09-12 spark-stall incident): a blocked goal/todo whose
      // gate owner-question is answered/dismissed — surfaced by the attention
      // watchdog, meta { surface, entity, id, oqId, oqStatus }.
      STALE_GATE: 'stale_gate',
      // Review 2026-09-13 issue 11: supervisor-first triage — answered by the
      // supervisor (answer_owner_question).
      OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
      // Audit 96fb2f25: a supervisor answer to an OWNER-ONLY class question
      // was refused at answer time (specimen oq_e4869c75 — an approve-dispatch
      // ask over the held-ticket "another account" note answered by the Fleet
      // Supervisor citing only a generic standing directive).
      OWNER_ANSWER_OWNER_ONLY_REFUSED: 'owner_answer_owner_only_refused',
      OWNER_QUESTION_DISMISS_REFUSED: 'owner_question_dismiss_refused',
      // Ticket 1a56f816: a triage window released EARLY — the owner posted in
      // the filing chat after the card was filed, so the surfacing sweep
      // flipped it and DM'd at once instead of holding the rest of the SLA.
      OWNER_QUESTION_TRIAGE_EARLY_RELEASED: 'owner_question_triage_early_released',
      OWNER_DIRECTIVE_DELIVERED: 'owner_directive_delivered',
      // Project-supervisor spawn circuit breaker (2026-09-14): ONE row per
      // breaker trip, meta { projectId, reason: 'storm'|'budget'|'rate', count, cap }.
      PROJECT_SUPERVISOR_BREAKER: 'project_supervisor_breaker',
      // Ticket 56284f30 (F3): owner-questions shared-project second chance
      // failed and degraded to "unmatched" — was a logger-only warn.
      SHARED_OQ_SECOND_CHANCE_FAILED: 'shared_oq_second_chance_failed',
      // sup3 audit C2 (2026-09-27): a goal closed done with its own target premise unmet / HOLD note / open directive (observe-only).
      GOAL_DONE_SUSPECT: 'goal_done_suspect',
      // 2026-10-20 goal outcome / unplanned / transition telemetry (architecture review #3 + #6).
      GOAL_OUTCOME_UNMET: 'goal_outcome_unmet',
      GOAL_UNPLANNED: 'goal_unplanned',
      GOAL_TRANSITION: 'goal_transition',
      TODO_TRANSITION: 'todo_transition',
      // Rollout watch 2026-09-15 (tick 12): empty machine-wake completion retried once.
      MACHINE_WAKE_EMPTY_RETRY: 'machine_wake_empty_retry',
      // Hourly branch janitor (owner 2026-09-14 — merged/stale/legacy branch
      // cleanup, fleet/branch-janitor.service): ONE row per repo per pass,
      // value = deleted, meta { repo, scanned, deleted, kept, reasons, dryRun }.
      BRANCH_JANITOR: 'branch_janitor',
      // Image generator seat (owner ask 2026-09-24): ONE row per generate_image
      // tool call / POST /images/generate / admin probe, meta { model, provider,
      // spec, aspect, referenceMode, surface, latencyMs, bytes, chatId? }.
      IMAGE_GENERATION: 'image_generation',
      // Supervisor upward-chatter + owner-ask follow-through (tt-rd audit 2026-09-27).
      REPORT_UP: 'report_up',
      REPORT_UP_ACK_ONLY: 'report_up_ack_only',
      DIRECTIVE_ASK_AUTOCLOSE: 'directive_ask_autoclose',
      OWNER_TURN_EMPTY_RETRY: 'owner_turn_empty_retry',
      OWNER_ASK_REWAKE: 'owner_ask_rewake',
      OWNER_ASK_NUDGE: 'owner_ask_nudge',

      // Secret-scrubbing D4 (2026-09-27): a machine-run chat read redacted
      // credential-shaped strings — meta { tool, chatId, hits, count, machine }.
      CHAT_READ_SECRET_REDACTED: 'chat_read_secret_redacted',
      DELIVERABLE_HANDOFF: 'deliverable_handoff', // cohesive chat wave 2026-09-27 (branch C)
      // cohesive chat live fixes 2026-09-28: the child's permission mode + source at spawn (human-spawn.ts);
      // a child-result wake to a human plain-chat parent skipped because the hand-off told the user (handoff-parent-wake.ts).
      SPAWN_PERMISSION: 'spawn_permission',
      HANDOFF_PARENT_WAKE_SKIPPED: 'handoff_parent_wake_skipped',
      // hand-off polish 2026-09-28 (audit CT-2): a human spawn turn ended its tool loop after the spawn round.
      SPAWN_TURN_END: 'spawn_turn_end',
      // audit 2026-10-06 T1: context budget source / no-progress brake / session memory dedupe.
      CONTEXT_BUDGET: 'context_budget',
      NO_PROGRESS_BRAKE: 'no_progress_brake',
      MEMORY_STORE_DEDUPED: 'memory_store_deduped',
      // roster 2026-10-06 Team B: B-1 turn-plan hygiene (supervisor skip) + B-2 retired human-turn asks
      TURN_PLAN_HYGIENE: 'turn_plan_hygiene',
      DECISION_ASK_RETIRED: 'decision_ask_retired',
      DELEGATE_BACKGROUND: 'delegate_background',
      // build 2026-10-08 F: the typed finish_run SHADOW record + its agreement with the old prose detectors
      FINISH_RUN: 'finish_run',
      FINISH_RUN_AGREEMENT: 'finish_run_agreement',
      // build 2026-10-08 D: the SHADOW delegation ledger + its nightly reconcile + the tool-intent journal
      DELEGATION_TASK: 'delegation_task',
      DELEGATION_TASK_RECONCILE: 'delegation_task_reconcile',
      TOOL_INTENT: 'tool_intent',
      // 2026-10-12 credential incident: the open_pull_request OSV advisory lookup.
      DEPENDENCY_ADVISORY: 'dependency_advisory',
      // Todo d597ce5d (#1578 escape, monitor lesson 6): a cited receipt id that
      // RESOLVES but to a receipt of the wrong TOOL CLASS for the claim's verb
      // ("Resolved ticket 9c307167 … receipt ticket 9c307167" while the id
      // lives only in a file_feedback envelope). Observe-only, one row per
      // mismatch — meta { verb, expectedTools, actualTool, receiptId, leg, phrase }.
      RECEIPT_TOOL_MISMATCH: 'receipt_tool_mismatch',
      // Todo 13dfa16d (monitor lesson 7): a supervisor '<todo> merged/landed/
      // shipped' sentence that disagrees with the todo's row (status not done,
      // evidence naming no PR, or the PR receipt stamped with a DIFFERENT work
      // item — the #1590 specimen class). Observe-only, one row per mismatch —
      // meta { prefix, claimedWorkItem, todoStatus, todoEvidence?, stampedWorkItem?, verb, leg, phrase }.
      ARTIFACT_ATTRIBUTION_MISMATCH: 'artifact_attribution_mismatch',
      // 2026-10-16 todo 908f48a7 (monitor lesson 5): owner-status proxy mismatch, observe-only.
      OWNER_STATUS_PROXY_MISMATCH: 'owner_status_proxy_mismatch',
      // 2026-10-16 todo 908f48a7 item 3: a note rate implying a rate the register does not hold.
      RATE_PREMISE_INCONSISTENT: 'rate_premise_inconsistent',
      // 2026-10-16 todo fea78360 (monitor lesson 6): owner-card payload completeness, observe-only.
      OWNER_CARD_PAYLOAD_INCOMPLETE: 'owner_card_payload_incomplete',
      // Ticket 26786762: one row per credential a flag_owner_question card
      // delivers (implicit span rescue + explicit deliverSecrets) — meta
      // { chatId, kind:'flag', implicit, explicit }. Observe-only.
      OWNER_QUESTION_SECRET_DELIVERED: 'owner_question_secret_delivered',
      // 2026-10-16 todo fea78360 (monitor lesson 6): replacement card that does not name what it replaces.
      OWNER_CARD_CHAIN_UNLINKED: 'owner_card_chain_unlinked',
      CONSOLE_ASK_SPECLESS: 'console_ask_specless',
      // Ticket be06c812 (log-signal family lane, 2026-10-18, PR #1709): a closed
      // adjudicated row absorbed a same-type standing-class sighting in the
      // reopen pass's short-circuit; and the bar-breach counterpart (the
      // recorded re-open bar was crossed — legacy gates re-armed).
      FEEDBACK_ADJUDICATED_CLASS_DEDUPE: 'feedback_adjudicated_class_dedupe',
      FEEDBACK_ADJUDICATED_BAR_BREACH: 'feedback_adjudicated_bar_breach',
      ARCHIVED_TARGET_RETIRE: 'archived_target_retire',
      // INTERVENTION-OUTCOMES (2026-10-20): supervisor lane interventions + their +6 h / +24 h labels.
      SUPERVISOR_INTERVENTION: 'supervisor_intervention',
      SUPERVISOR_INTERVENTION_OUTCOME: 'supervisor_intervention_outcome',
      // CI-WATCH (2026-10-20): the no-LLM CI watch over lane-pushed shas.
      CI_WATCH: 'ci_watch',
      FLEET_PS_ESCALATION: 'fleet_ps_escalation',
      // BRIEFING-UNVERIFIED-FILTER (2026-10-20): the action-class footnote + the owner-briefing filter rows.
      ACTION_CLASS_ANNOTATED: 'action_class_annotated',
      BRIEFING_UNVERIFIED_FILTER: 'briefing_unverified_filter',
      // GOAL-PRIORITY-SPEND (2026-10-20): goal ranking writes (set / cleared / refused).
      GOAL_PRIORITY: 'goal_priority',
      // OWNER-INTERRUPT-ECONOMY (2026-10-20): the owner's interrupt load — flags, resolutions, digests.
      OWNER_QUESTION_FLAGGED: 'owner_question_flagged',
      OWNER_QUESTION_RESOLVED: 'owner_question_resolved',
      OWNER_DECISION_DIGEST: 'owner_decision_digest',
      OWNER_REVERSIBLE_DEFAULT: 'owner_reversible_default',
      // SHARED-PROJECT-DISPATCH (2026-10-20): member-caused spawns + the held-ticket escalation.
      MEMBER_SPAWN: 'member_spawn',
      HELD_TICKET_ESCALATION: 'held_ticket_escalation',
      // MERGE-INTENT-AWAIT (2026-10-20): the harness-owned merge wait + the await_condition tool.
      MERGE_INTENT: 'merge_intent',
      AWAIT_CONDITION: 'await_condition',
      // STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21): one row per machine turn after a struck note.
      STRUCK_NOTE_REPEAT: 'struck_note_repeat',
      // COMPUTER_TASK CLAIM CHECK (2026-10-21): one counts-only row per supervisor machine note's verdict.
      COMPUTER_TASK_CLAIM: 'computer_task_claim',
      // SAA-1 PHASE 0 (2026-11-02, todo 9114e7b5): the two OBSERVE-ONLY context-substrate
      // readouts — inline & spill (what an injector's cap dropped and what a followable
      // pointer would have cost) and chain of recall (the next-hop ids a hit did not
      // inline). Both count-only; neither can change what an agent is shown in Phase 0.
      INLINE_SPILL_OBSERVE: 'inline_spill_observe',
      CHAIN_OF_RECALL_OBSERVE: 'chain_of_recall_observe',
      // SAA-1.6 PHASE 3a/3b (2026-11-04, todo e49dfd07): the async-tool readout — which
      // dispatched calls are eligible to be handed off. PHASE 3b changed the RULE
      // (a tool CLASS measured against an ELAPSED 60 s threshold, not a declared
      // duration) and widened `applied` to a real boolean, so this row is no longer
      // "shadow only" — but in the default observe mode it still records without
      // changing any timing, and the kill switch stops it entirely.
      ASYNC_TOOL_CALLS_OBSERVE: 'async_tool_calls_observe',
      // SAA-1.6 PHASE 3b (2026-11-04, todo e49dfd07): the lifecycle of one handed-off
      // call — `threshold_crossed` / `delivered` / `orphaned`. The `delivered` phase is
      // the evidence that a deferred result actually reached the model at a step boundary.
      ASYNC_TOOL_CALLS_DELIVER: 'async_tool_calls_deliver',
    });
  });
});

// ── recordLoopMetric: fire-and-forget, batched, never throws ─────────────────

describe('recordLoopMetric', () => {
  it('buffers and persists normalized rows on flush', async () => {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
      sessionId: 'sess-1',
      runId: 'run-1',
      value: 3,
      unit: 'strikes',
      meta: { reason: 'loop-cap' },
    });
    expect(mockCreateMany).not.toHaveBeenCalled(); // fire-and-forget: no sync write
    await flushLoopMetrics();

    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    const rows = flushedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'guard_strike',
      sessionId: 'sess-1',
      runId: 'run-1',
      value: 3,
      unit: 'strikes',
      meta: { reason: 'loop-cap' },
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date); // stamped at record time
  });

  it('ACCEPTANCE-METRIC-BASELINE: an explicit PAST event time (at) stamps createdAt; a future or invalid one is record time', async () => {
    const past = new Date(Date.now() - 2 * 3600_000);
    recordLoopMetric({ kind: 'framework_signal_finding', at: past, meta: { class: 'raw-marker', fingerprint: 'raw-marker:X' } });
    recordLoopMetric({ kind: 'framework_signal_finding', at: new Date(Date.now() + 3600_000) });
    recordLoopMetric({ kind: 'framework_signal_finding', at: new Date('nope') });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows[0].createdAt).toEqual(past);
    expect(rows[1].createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[2].createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(past.getTime());
  });

  it('normalizes garbage: blank kind dropped, non-finite value → null, circular meta stripped', async () => {
    recordLoopMetric({ kind: '   ' }); // dropped
    recordLoopMetric(undefined as any); // dropped, no throw
    recordLoopMetric({ kind: 'ux_beacon', value: NaN });
    const circular: any = {};
    circular.self = circular;
    recordLoopMetric({ kind: 'ux_beacon', value: 5, meta: circular });
    await flushLoopMetrics();

    const rows = flushedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'ux_beacon', value: null, sessionId: null, runId: null, unit: null });
    expect(rows[1].value).toBe(5);
    expect(rows[1].meta).toBeUndefined(); // circular meta stripped, row kept
  });

  it('NEVER throws or rejects with the DB down (batch dropped, throttled warn)', async () => {
    mockCreateMany.mockRejectedValue(new Error('connection refused'));
    expect(() => recordLoopMetric({ kind: 'guard_miss' })).not.toThrow();
    await expect(flushLoopMetrics()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // second failed flush inside the throttle window stays quiet
    recordLoopMetric({ kind: 'guard_miss' });
    await expect(flushLoopMetrics()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // a failed batch is dropped, not re-queued (lossy by design, no leak)
    mockCreateMany.mockResolvedValue({ count: 0 });
    await flushLoopMetrics();
    expect(mockCreateMany).toHaveBeenCalledTimes(2); // no third call: buffer empty
  });

  it(`auto-flushes when the buffer reaches ${LOOP_METRIC_FLUSH_BATCH}`, () => {
    for (let i = 0; i < LOOP_METRIC_FLUSH_BATCH; i++) recordLoopMetric({ kind: 'wake_delivered' });
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany.mock.calls[0][0].data).toHaveLength(LOOP_METRIC_FLUSH_BATCH);
  });

  it(`flushes on the ${LOOP_METRIC_FLUSH_MS}ms timer when traffic is a trickle`, () => {
    jest.useFakeTimers();
    recordLoopMetric({ kind: 'wake_parked' });
    expect(mockCreateMany).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LOOP_METRIC_FLUSH_MS);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(flushedRows()).toHaveLength(1);
  });

  it('absorbs a metric storm against a dead DB: no throw, batches dropped, buffer never grows unbounded', async () => {
    mockCreateMany.mockRejectedValue(new Error('db down'));
    // recordLoopMetrics is the batch-friendly entry point; every 200th row
    // auto-flushes (dropping against the dead DB), so the in-memory buffer
    // stays bounded even under MAX_PENDING+ input.
    const batch = Array.from({ length: LOOP_METRIC_MAX_PENDING + 50 }, () => ({ kind: 'ux_beacon' }));
    expect(() => recordLoopMetrics(batch)).not.toThrow();
    // no single (dropped) write ever exceeded the flush batch size
    for (const call of mockCreateMany.mock.calls) {
      expect((call[0] as any).data.length).toBeLessThanOrEqual(LOOP_METRIC_FLUSH_BATCH);
    }
    await flushLoopMetrics(); // remainder also drops quietly
    expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('flush failed'))).toBe(true);
  });
});

// ── Spend accounting ─────────────────────────────────────────────────────────

describe('recordRunSpend', () => {
  it('converts a RunUsage snapshot into per-model token rows + one run_spend row', async () => {
    // Shape produced by coding/cost.ts UsageAccumulator.snapshot(): two agents
    // share glm-5.2 (aggregated), one runs kimi-k3.
    recordRunSpend('run-9', 'sess-9', {
      totalInTokens: 1100,
      totalOutTokens: 320,
      totalCostUsd: 1.25,
      turns: 7,
      estimated: true,
      agents: [
        { model: 'glm-5.2', inTokens: 400, outTokens: 100, costUsd: 0.4, estimated: false },
        { model: 'glm-5.2', inTokens: 300, outTokens: 20, costUsd: 0.25, estimated: true },
        { model: 'kimi-k3', inTokens: 400, outTokens: 200, costUsd: 0.6, estimated: false },
      ],
    });
    await flushLoopMetrics();

    const rows = flushedRows();
    const byKind = (k: string) => rows.filter((r) => r.kind === k);

    const tokensIn = byKind('run_tokens_in');
    expect(tokensIn).toHaveLength(2);
    expect(tokensIn.find((r) => r.meta.model === 'glm-5.2')).toMatchObject({
      value: 700,
      unit: 'tokens',
      runId: 'run-9',
      sessionId: 'sess-9',
      meta: { model: 'glm-5.2', estimated: true }, // any estimated turn flags the model
    });
    expect(tokensIn.find((r) => r.meta.model === 'kimi-k3')).toMatchObject({ value: 400, meta: { estimated: false } });

    const tokensOut = byKind('run_tokens_out');
    expect(tokensOut.find((r) => r.meta.model === 'glm-5.2')).toMatchObject({ value: 120, unit: 'tokens' });
    expect(tokensOut.find((r) => r.meta.model === 'kimi-k3')).toMatchObject({ value: 200 });

    const spend = byKind('run_spend');
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({
      value: 1.25,
      unit: 'usd',
      runId: 'run-9',
      sessionId: 'sess-9',
      meta: { models: ['glm-5.2', 'kimi-k3'], turns: 7, estimated: true },
    });
  });

  it('falls back to totals (model "unknown") when there is no per-agent breakdown', async () => {
    recordRunSpend('run-2', undefined, { totalInTokens: 50, totalOutTokens: 10 });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows.find((r) => r.kind === 'run_tokens_in')).toMatchObject({ value: 50, meta: { model: 'unknown' } });
    expect(rows.find((r) => r.kind === 'run_tokens_out')).toMatchObject({ value: 10, meta: { model: 'unknown' } });
    // no totalCostUsd given → summed per-model costs (0 here)
    expect(rows.find((r) => r.kind === 'run_spend')).toMatchObject({ value: 0, unit: 'usd', runId: 'run-2' });
  });

  it('a zero-token run still records exactly one run_spend row (run-count signal)', async () => {
    recordRunSpend('run-3', 'sess-3', { totalInTokens: 0, totalOutTokens: 0, totalCostUsd: 0, turns: 0, agents: [] });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'run_spend', value: 0, runId: 'run-3' });
  });

  it('A4 (2026-10-04): a machine-firing effort stamp lands reasoningEffort + effortReason on run_spend and the token rows; absent ⇒ absent', async () => {
    recordRunSpend('run-eff', 'sess-eff', {
      totalInTokens: 100, totalOutTokens: 10, totalCostUsd: 0.01, turns: 1,
      agents: [{ model: 'glm-5.3', inTokens: 100, outTokens: 10, costUsd: 0.01 }],
    }, { model: 'glm-5.3', profile: 'coding', triggerKind: 'schedule', reasoningEffort: 'high', effortReason: 'all_complete_board' });
    recordRunSpend('run-plain', 'sess-eff', {
      totalInTokens: 100, totalOutTokens: 10, totalCostUsd: 0.01, turns: 1,
      agents: [{ model: 'glm-5.3', inTokens: 100, outTokens: 10, costUsd: 0.01 }],
    }, { model: 'glm-5.3', profile: 'coding', triggerKind: 'user' });
    await flushLoopMetrics();
    const rows = flushedRows();
    const spend = rows.find((r) => r.kind === 'run_spend' && r.runId === 'run-eff');
    expect(spend.meta).toMatchObject({ reasoningEffort: 'high', effortReason: 'all_complete_board', triggerKind: 'schedule' });
    expect(rows.find((r) => r.kind === 'run_tokens_in' && r.runId === 'run-eff').meta).toMatchObject({ reasoningEffort: 'high', effortReason: 'all_complete_board' });
    const plain = rows.find((r) => r.kind === 'run_spend' && r.runId === 'run-plain');
    expect(plain.meta).not.toHaveProperty('reasoningEffort');
    expect(plain.meta).not.toHaveProperty('effortReason');
  });

  it('GOAL-PRIORITY-SPEND (2026-10-20): a goalId stamp lands meta.goalId on run_spend and the token rows; absent ⇒ absent', async () => {
    const usage = { totalInTokens: 100, totalOutTokens: 10, totalCostUsd: 0.01, turns: 1, agents: [{ model: 'glm-5.3', inTokens: 100, outTokens: 10, costUsd: 0.01 }] };
    recordRunSpend('run-goal', 'lane-1', usage, { model: 'glm-5.3', profile: 'coding', triggerKind: 'schedule', goalId: 'g-1' });
    recordRunSpend('run-nogoal', 'sup-1', usage, { model: 'glm-5.3', profile: 'coding', triggerKind: 'hook' });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows.find((r) => r.kind === 'run_spend' && r.runId === 'run-goal').meta).toMatchObject({ goalId: 'g-1' });
    expect(rows.find((r) => r.kind === 'run_tokens_out' && r.runId === 'run-goal').meta).toMatchObject({ goalId: 'g-1' });
    expect(rows.find((r) => r.kind === 'run_spend' && r.runId === 'run-nogoal').meta).not.toHaveProperty('goalId');
  });

  it('never throws on garbage usage', () => {
    expect(() => recordRunSpend('run-4', 'sess-4', null as any)).not.toThrow();
    expect(() => recordRunSpend('run-5', 'sess-5', { agents: [{}] } as any)).not.toThrow();
  });

  it('WI-D: labelled agent rows land meta.seats on the run_spend row (model → distinct seats, the lead unlabelled as "lead"); token rows unchanged', async () => {
    recordRunSpend('run-seats', 'sess-s', {
      totalInTokens: 900, totalOutTokens: 300, totalCostUsd: 0.5, turns: 3, estimated: false,
      agents: [
        { model: 'kimi-k3', inTokens: 500, outTokens: 200, costUsd: 0.4, agent: 'Digby' },
        { model: 'deepseek-flash', inTokens: 300, outTokens: 80, costUsd: 0.08, agent: 'Cross-checker', role: 'cross_checker' },
        { model: 'deepseek-flash', inTokens: 100, outTokens: 20, costUsd: 0.02, agent: 'Cross-checker', role: 'cross_checker' },
      ],
    }, { model: 'kimi-k3', profile: 'chat', triggerKind: 'user' });
    await flushLoopMetrics();
    const rows = flushedRows();
    const spend = rows.find((r) => r.kind === 'run_spend');
    expect(spend.meta).toMatchObject({
      models: ['kimi-k3', 'deepseek-flash'],
      seats: { 'kimi-k3': ['lead'], 'deepseek-flash': ['cross_checker'] },
      profile: 'chat',
    });
    // The per-model token rows carry the checker's model under profile chat —
    // the exact rows prod had zero of before WI-D.
    expect(rows.find((r) => r.kind === 'run_tokens_in' && r.meta.model === 'deepseek-flash')).toMatchObject({ value: 400, meta: { profile: 'chat', provider: 'deepseek' } });
    // Unlabelled rows (hand-built usages) leave meta.seats out entirely.
    mockCreateMany.mockClear();
    recordRunSpend('run-plain', 'sess-p', { totalInTokens: 10, totalOutTokens: 5, agents: [{ model: 'glm-5.3', inTokens: 10, outTokens: 5, costUsd: 0.001 }] });
    await flushLoopMetrics();
    expect(flushedRows().find((r) => r.kind === 'run_spend').meta).not.toHaveProperty('seats');
  });

  it('seat-label fix (2026-09-25): a "reconcile" row on the lead\'s model lands as its own seat next to "lead" — the pass is never labelled cross_checker; token rows stay per MODEL', async () => {
    mockCreateMany.mockClear();
    recordRunSpend('run-seats-rc', 'sess-rc', {
      totalInTokens: 1800, totalOutTokens: 450, totalCostUsd: 0.9, turns: 3, estimated: false,
      agents: [
        { model: 'kimi-k3', inTokens: 500, outTokens: 200, costUsd: 0.4, agent: 'Digby' },
        { model: 'kimi-k3', inTokens: 800, outTokens: 150, costUsd: 0.42, agent: 'Cross-checker (reconcile)', role: 'reconcile' },
        { model: 'deepseek-flash', inTokens: 500, outTokens: 100, costUsd: 0.08, agent: 'Cross-checker', role: 'cross_checker' },
      ],
    }, { model: 'kimi-k3', profile: 'chat', triggerKind: 'user' });
    await flushLoopMetrics();
    const rows = flushedRows();
    const spend = rows.find((r) => r.kind === 'run_spend');
    expect(spend.meta.models).toEqual(['kimi-k3', 'deepseek-flash']);
    expect(spend.meta.seats).toEqual({ 'kimi-k3': ['lead', 'reconcile'], 'deepseek-flash': ['cross_checker'] });
    // The reconcile pass's tokens fold into the LEAD model's per-model row.
    expect(rows.find((r) => r.kind === 'run_tokens_in' && r.meta.model === 'kimi-k3')).toMatchObject({ value: 1300 });
    expect(rows.find((r) => r.kind === 'run_tokens_out' && r.meta.model === 'kimi-k3')).toMatchObject({ value: 350 });
  });

  it('E5 run_context_fill: one fill row per model with a provider-reported peak — value=peak, meta carries window + fillRatio; estimate-only and unknown models mint NONE', async () => {
    mockCreateMany.mockClear();
    recordRunSpend('run-fill', 'sess-f', {
      totalInTokens: 100_000, totalOutTokens: 5_000, totalCostUsd: 0.9, turns: 4, estimated: false,
      agents: [
        // A coding loop on glm-5.3 (1M window): the transcript peaked at 250k
        // tokens on its last turn — a 0.25 fill.
        { model: 'glm-5.3', inTokens: 60_000, outTokens: 5_000, costUsd: 0.8, agent: 'Digby', peakPromptTokens: 250_000 },
        // An estimate-only row (provider never reported usage) — NO peak, no row.
        { model: 'qwen3.6-27b', inTokens: 40_000, outTokens: 0, costUsd: 0.02, agent: 'Worker', estimated: true },
        // An unknown/Edge-spec model — peak present but no known window: no row
        // (a guessed denominator would be worse than none).
        { model: 'nebius-b300:glm-5.3', inTokens: 10_000, outTokens: 0, costUsd: 0.01, agent: 'Helper', peakPromptTokens: 9_000 },
      ],
    });
    await flushLoopMetrics();
    const fill = flushedRows().filter((r) => r.kind === 'run_context_fill');
    expect(fill).toHaveLength(1);
    expect(fill[0]).toMatchObject({
      runId: 'run-fill',
      sessionId: 'sess-f',
      value: 250_000,
      unit: 'tokens',
      meta: { model: 'glm-5.3', peakPromptTokens: 250_000, windowTokens: 1_000_000, fillRatio: 0.25 },
    });
  });

  it('E5 run_context_fill: multiple agent rows on ONE model keep the MAX peak, not a sum (two workers fill two windows)', async () => {
    mockCreateMany.mockClear();
    recordRunSpend('run-fill-2', 'sess-f2', {
      totalInTokens: 100_000, totalOutTokens: 2_000, totalCostUsd: 0.5, turns: 2, estimated: false,
      agents: [
        { model: 'kimi-k3', inTokens: 80_000, outTokens: 1_000, costUsd: 0.4, agent: 'Digby', peakPromptTokens: 80_000 },
        { model: 'kimi-k3', inTokens: 15_000, outTokens: 1_000, costUsd: 0.1, agent: 'Cross-checker', role: 'cross_checker', peakPromptTokens: 15_000 },
      ],
    });
    await flushLoopMetrics();
    const fill = flushedRows().filter((r) => r.kind === 'run_context_fill');
    expect(fill).toHaveLength(1);
    expect(fill[0].value).toBe(80_000); // the max, not 95k
    expect(fill[0].meta).toMatchObject({ model: 'kimi-k3', fillRatio: 0.08 });
  });

  it('E5 run_context_fill: legacy model ids resolve their window through the alias table (deepseek-v4-flash → deepseek-flash 1M)', async () => {
    mockCreateMany.mockClear();
    recordRunSpend('run-fill-3', 'sess-f3', {
      totalInTokens: 100_000, totalOutTokens: 1_000, totalCostUsd: 0.3, turns: 1, estimated: false,
      agents: [{ model: 'deepseek-v4-flash', inTokens: 100_000, outTokens: 1_000, costUsd: 0.3, agent: 'Digby', peakPromptTokens: 400_000 }],
    });
    await flushLoopMetrics();
    const fill = flushedRows().filter((r) => r.kind === 'run_context_fill');
    expect(fill).toHaveLength(1);
    expect(fill[0].meta).toMatchObject({ model: 'deepseek-v4-flash', windowTokens: 1_000_000, fillRatio: 0.4 });
  });
});

// ── Utility-LLM dual-failure telemetry (ticket 26fe2168 close-out) ────────────

describe('noteUtilityLlmFailure', () => {
  it('records one utility_llm_dual_failure row with streak + clipped error strings in meta', async () => {
    noteUtilityLlmFailure({
      streak: 3,
      callerContext: 'timeout=4000 contentOnly=true',
      lastErrors: ['DeepSeek (HTTP 500): boom', `DashScope qwen3.6-27b: ${'x'.repeat(500)}`],
    });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'utility_llm_dual_failure',
      sessionId: null,
      runId: null,
      value: null,
    });
    expect(rows[0].meta.streak).toBe(3);
    expect(rows[0].meta.callerContext).toBe('timeout=4000 contentOnly=true');
    expect(rows[0].meta.lastErrors).toHaveLength(2);
    expect(rows[0].meta.lastErrors[0]).toBe('DeepSeek (HTTP 500): boom');
    expect(rows[0].meta.lastErrors[1].length).toBeLessThanOrEqual(300); // clipped
  });

  it('caps lastErrors at 4 entries and tolerates a bare call', async () => {
    noteUtilityLlmFailure({ lastErrors: ['a', 'b', 'c', 'd', 'e', 'f'] });
    noteUtilityLlmFailure();
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].meta.lastErrors).toEqual(['a', 'b', 'c', 'd']);
    expect(rows[0].meta.streak).toBeUndefined();
    expect(rows[1].kind).toBe('utility_llm_dual_failure');
  });

  it('never throws on garbage input or a down DB', async () => {
    mockCreateMany.mockRejectedValue(new Error('db down'));
    expect(() => noteUtilityLlmFailure({ streak: NaN, lastErrors: 'nope' as any, callerContext: 42 as any })).not.toThrow();
    await expect(flushLoopMetrics()).resolves.toBeUndefined();
  });
});

// ── Aggregation math ─────────────────────────────────────────────────────────

describe('noteSeatFallback (helper-seat health fallback, 2026-09-14)', () => {
  it('records ONE seat_fallback row with the helper shape {role, from, to, reason, status} + caller/httpStatus, clipped', async () => {
    noteSeatFallback({
      role: 'coding_helper', from: 'cql:qwen3-4b', to: 'qwen3.6-27b', reason: 'HTTP 400 — ' + 'x'.repeat(400), status: 'recovered',
      caller: 'web_pipe', httpStatus: 400, sessionId: 'sess-1', runId: 'run-1',
      stamp: { model: 'glm-5.3', profile: 'coding' },
    });
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'seat_fallback', sessionId: 'sess-1', runId: 'run-1', value: null });
    expect(rows[0].meta).toMatchObject({
      role: 'coding_helper', from: 'cql:qwen3-4b', to: 'qwen3.6-27b', status: 'recovered', caller: 'web_pipe', httpStatus: 400,
      // stamp fields ride UNDER the site meta
      model: 'glm-5.3', provider: 'zai', profile: 'coding',
    });
    expect(rows[0].meta.reason).toHaveLength(200);
    expect(rows[0].meta.reason.startsWith('HTTP 400 — ')).toBe(true);
  });

  it('2026-09-30: carries the provider error text as detail — secrets redacted, whitespace folded, ≤200 chars', async () => {
    noteSeatFallback({
      role: 'coding_default', from: 'deepseek-flash', to: 'cql-litellm:api-optimize-moonshot-kimi-k3', reason: 'billing', status: 'retrying',
      caller: 'lead', httpStatus: 402,
      detail: 'Insufficient Balance\n\n  for key sk-' + 'a'.repeat(40) + ' ' + 'y'.repeat(400),
    });
    await flushLoopMetrics();
    const row = flushedRows()[0];
    expect(row.meta.detail.startsWith('Insufficient Balance for key ')).toBe(true);
    expect(row.meta.detail).not.toContain('a'.repeat(40));
    expect(row.meta.detail.length).toBeLessThanOrEqual(200);
  });

  it('omits caller/httpStatus when absent and never throws on garbage', async () => {
    noteSeatFallback({ role: 'coding_helper', from: 'a:b', to: 'qwen3.6-27b', reason: 'timeout', status: 'unavailable' });
    expect(() => noteSeatFallback(undefined as any)).not.toThrow();
    expect(() => noteSeatFallback({ role: '' } as any)).not.toThrow();
    await flushLoopMetrics();
    const rows = flushedRows();
    expect(rows).toHaveLength(1);
    expect('caller' in rows[0].meta).toBe(false);
    expect('httpStatus' in rows[0].meta).toBe(false);
    expect(rows[0].meta).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });
});

// ── sanitizeMeta secret redaction (abd733af, 6d19f11f review finding 3) ───────

describe('recordLoopMetric meta redaction (abd733af)', () => {
  it('redacts credential-shaped meta.error/detail/err and clips them to 200 chars; benign error text passes through; other keys stay byte-identical', async () => {
    // Review round 1b finding 6 (mutation 2): deleting the sanitizeMeta
    // redaction loop passed every suite — it had no pin at the recordLoopMetric
    // write path (noteSeatFallback's :885 test pinned only ITS own site).
    recordLoopMetric({
      kind: 'infra_alert', sessionId: 'fleet-sup-1',
      meta: {
        error: 'target chat not found after retry with key sk-' + 'a'.repeat(40) + ' ' + 'z'.repeat(300),
        detail: 'outbox write failed: AKIA' + 'B'.repeat(16),
        err: 'boom',
        note: 'untouched ' + 'y'.repeat(250),
      } as any,
    });
    await flushLoopMetrics();
    expect(flushedRows()).toHaveLength(1);
    const meta = flushedRows()[0].meta;
    expect(String(meta.error).startsWith('target chat not found after retry with key ')).toBe(true);
    expect(String(meta.error)).not.toContain('a'.repeat(40)); // the sk- key body never persists
    expect(String(meta.error).length).toBeLessThanOrEqual(200);
    expect(String(meta.detail)).not.toContain('AKIA' + 'B'.repeat(16)); // the AWS key never persists
    expect(String(meta.detail).length).toBeLessThanOrEqual(200);
    expect(meta.err).toBe('boom'); // benign string: byte-identical
    expect(meta.note).toBe('untouched ' + 'y'.repeat(250)); // non-redacted keys: no clip, no rewrite
  });
});

describe('countSeatFallbacksByRole (GET /admin/model-roles recentFailures)', () => {
  it('counts seat_fallback rows per role in the trailing window — helper shape (meta.role) and orchestrator shape (meta.seat) alike', async () => {
    mockFindMany.mockResolvedValue([
      { meta: { role: 'coding_helper', status: 'recovered' } },
      { meta: { role: 'coding_helper', status: 'failed' } },
      { meta: { role: 'coding_helper', status: 'retrying' } },
      { meta: { seat: 'supervisor', failedSeat: 'glm-5.3', recovered: true } }, // 2026-09-11 orchestrator shape
      { meta: { nothing: 'here' } },
      { meta: null },
    ]);
    const before = Date.now();
    const counts = await countSeatFallbacksByRole(24);
    expect(counts).toEqual({ coding_helper: 3, supervisor: 1 });
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const args = mockFindMany.mock.calls[0][0];
    expect(args.where.kind).toBe('seat_fallback');
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    // ~24h ago (± a few seconds of test time)
    expect(before - args.where.createdAt.gte.getTime()).toBeGreaterThan(24 * 3_600_000 - 5_000);
    expect(before - args.where.createdAt.gte.getTime()).toBeLessThan(24 * 3_600_000 + 5_000);
    expect(args.select).toEqual({ meta: true });
    expect(args.take).toBe(SEAT_FALLBACK_COUNT_MAX_ROWS);
  });

  it('an empty window → {}; a DB error propagates (the caller fails open)', async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await countSeatFallbacksByRole()).toEqual({});
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(countSeatFallbacksByRole()).rejects.toThrow('db down');
  });
});

describe('normalizeLoopMetricBuckets', () => {
  it('coerces BigInt counts, null sums, Date buckets', () => {
    const d = new Date('2026-09-02T10:00:00.000Z');
    expect(
      normalizeLoopMetricBuckets([
        { bucket: d, kind: 'guard_strike', count: BigInt(7), sum: 21.5, avg: 3.071428 },
        { bucket: '2026-09-02T11:00:00.000Z', kind: 'guard_strike', count: 2, sum: null, avg: null },
      ])
    ).toEqual([
      { bucket: '2026-09-02T10:00:00.000Z', kind: 'guard_strike', count: 7, sum: 21.5, avg: 3.071428 },
      { bucket: '2026-09-02T11:00:00.000Z', kind: 'guard_strike', count: 2, sum: 0, avg: null },
    ]);
  });
});

// ── Outcome aggregate (ticket d59499f4) ──────────────────────────────────────
//
// The two failures this pins, both measured on prod:
//   1. `rag_embed_call` rows carry meta.ok and NOTHING aggregated it, so a lane
//      certifying a reliability KPI had to hand-count rows (ticket 63ab9dc7).
//   2. Even a correct ok-rate is AMBIGUOUS without grouping by unit: one embed
//      call writes TWO rows at the same timestamp — an attempt row
//      (unit:'attempt') and a call roll-up (no unit) — so the same sample read
//      85.71 % per attempt and 95.45 % per call.

describe('outcomeRate', () => {
  it('is ok/(ok+fail) and never NaN on an empty group', () => {
    expect(outcomeRate(6, 1)).toBe(0.8571);
    expect(outcomeRate(21, 1)).toBe(0.9545);
    expect(outcomeRate(0, 0)).toBeNull();
    expect(outcomeRate(0, 4)).toBe(0);
  });
});

describe('normalizeLoopMetricOutcomes', () => {
  const raw = [
    // the prod shape: an attempt group and a unit-less call group, same minute
    { bucket: new Date('2026-11-01T19:55:00.000Z'), unit: 'attempt', total: BigInt(7), ok: BigInt(6), fail: BigInt(1), okKey: BigInt(7), successKey: BigInt(0) },
    { bucket: new Date('2026-11-01T19:55:00.000Z'), unit: null, total: BigInt(22), ok: BigInt(21), fail: BigInt(1), okKey: BigInt(22), successKey: BigInt(0) },
  ];

  it('keeps the attempt rate and the per-call rate APART instead of pooling them', () => {
    const out = normalizeLoopMetricOutcomes(raw);
    expect(out.flag).toBe('ok');
    const attempt = out.byUnit.find((g) => g.unit === 'attempt')!;
    const call = out.byUnit.find((g) => g.unit === null)!;
    expect(attempt).toMatchObject({ total: 7, ok: 6, fail: 1, rate: 0.8571 });
    expect(call).toMatchObject({ total: 22, ok: 21, fail: 1, rate: 0.9545 });
    // The pooled rate is reported too, and it is NEITHER of the two — which is
    // exactly why byUnit exists and the view tells the caller to name a group.
    expect(out.window).toMatchObject({ total: 29, ok: 27, fail: 2, rate: 0.931 });
  });

  it('counts an unlabeled row in total but never in the rate', () => {
    const out = normalizeLoopMetricOutcomes([
      { bucket: '2026-11-01T19:00:00.000Z', unit: 'attempt', total: BigInt(4), ok: BigInt(2), fail: BigInt(1), okKey: BigInt(3), successKey: BigInt(0) },
    ]);
    expect(out.buckets[0]).toMatchObject({ total: 4, ok: 2, fail: 1, unlabeled: 1, rate: 0.6667 });
    // An unlabeled row is counted in `total` and the total is NOT 2+1 — the
    // three labeled rows alone would have read 66.7 % of 3, understating the group.
    expect(out.buckets[0].total).toBe(4);
  });

  it('falls back to meta.success and says which key it used', () => {
    const out = normalizeLoopMetricOutcomes([
      { bucket: '2026-11-01T19:00:00.000Z', unit: null, total: BigInt(3), ok: BigInt(2), fail: BigInt(1), okKey: BigInt(0), successKey: BigInt(3) },
    ]);
    expect(out.flag).toBe('success');
    expect(out.window.rate).toBe(0.6667);
  });

  it('reports flag null when no row carried a boolean-ish flag — no guessed rate', () => {
    const out = normalizeLoopMetricOutcomes([
      { bucket: '2026-11-01T19:00:00.000Z', unit: null, total: BigInt(5), ok: BigInt(0), fail: BigInt(0), okKey: BigInt(0), successKey: BigInt(0) },
    ]);
    expect(out.flag).toBeNull();
    expect(out.window).toMatchObject({ total: 5, ok: 0, fail: 0, unlabeled: 5, rate: null });
  });

  it('sorts buckets oldest-first and groups sorted by volume', () => {
    const out = normalizeLoopMetricOutcomes([
      { bucket: '2026-11-01T20:00:00.000Z', unit: 'attempt', total: BigInt(1), ok: BigInt(1), fail: BigInt(0), okKey: BigInt(1), successKey: BigInt(0) },
      { bucket: new Date('2026-11-01T19:00:00.000Z'), unit: 'attempt', total: BigInt(9), ok: BigInt(9), fail: BigInt(0), okKey: BigInt(9), successKey: BigInt(0) },
    ]);
    expect(out.buckets.map((b) => b.bucket)).toEqual(['2026-11-01T19:00:00.000Z', '2026-11-01T20:00:00.000Z']);
    expect(out.byUnit[0]).toMatchObject({ unit: 'attempt', total: 10 });
  });
});

describe('queryLoopMetricOutcomes', () => {
  it('queries the window grouped by bucket AND unit, and normalizes the result', async () => {
    const before = Date.now();
    mockQueryRaw.mockResolvedValue([
      { bucket: new Date('2026-11-01T19:00:00.000Z'), unit: 'attempt', total: BigInt(3), ok: BigInt(3), fail: BigInt(0), okKey: BigInt(3), successKey: BigInt(0) },
    ]);
    const out = await queryLoopMetricOutcomes('rag_embed_call', { hours: 6, bucket: 'hour' });
    expect(out.byUnit[0]).toMatchObject({ unit: 'attempt', total: 3, rate: 1 });
    expect(out.flag).toBe('ok');

    // tagged template: [strings, unit, since, kind]
    const [, unit, since, kind] = mockQueryRaw.mock.calls[0] as any[];
    expect(unit).toBe('hour');
    expect(kind).toBe('rag_embed_call');
    expect(Math.abs(before - 6 * 3_600_000 - since.getTime())).toBeLessThan(5_000);
    // The grouping requirement is IN the SQL — a bucket-only aggregate is the
    // defect (two rows per call at one timestamp).
    const sql = String((mockQueryRaw.mock.calls[0] as any[])[0].join('?'));
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('unit');
  });
});

describe('normalizeLoopMetricPayloadSizes', () => {
  it('coerces Decimal-string percentiles and drops empty groups', () => {
    expect(
      normalizeLoopMetricPayloadSizes([
        { unit: 'attempt', field: 'chars', n: BigInt(9), p50: '1200.4', p95: '7800.9', max: '9100', avg: '2100.2' },
        { unit: null, field: 'batchChars', n: 0, p50: null, p95: null, max: null, avg: null },
      ] as any)
    ).toEqual([
      { unit: 'attempt', field: 'chars', n: 9, p50: 1200, p95: 7801, max: 9100, avg: 2100 },
    ]);
  });
});

describe('queryLoopMetricPayloadSizes', () => {
  it('scopes the window by kind and returns the distribution', async () => {
    const before = Date.now();
    mockQueryRaw.mockResolvedValue([
      { unit: null, field: 'batchChars', n: BigInt(4), p50: '800', p95: '2400', max: '3000', avg: '1100' },
    ]);
    const out = await queryLoopMetricPayloadSizes('rag_embed_call', { hours: 12 });
    expect(out[0]).toMatchObject({ field: 'batchChars', n: 4, p95: 2400 });

    // Position-independent: the CASE guards add bound params ahead of the WHERE,
    // so asserting by index would pin the parameter ORDER rather than the query.
    const args = mockQueryRaw.mock.calls[0] as any[];
    expect(args).toContain('rag_embed_call');
    const since = args.find((a) => a instanceof Date);
    expect(since).toBeInstanceOf(Date);
    expect(Math.abs(before - 12 * 3_600_000 - (since as Date).getTime())).toBeLessThan(5_000);

    // THE GUARD (adversarial review M1/M2): the numeric test must be applied
    // BEFORE the cast and the cast must stop at `numeric` — a `numeric→float8`
    // cast on a huge digit string raises "value out of range" and would take the
    // whole telemetry read down. Pin both halves in the SQL text, so a refactor
    // that hoists the cast out of the lateral or re-widens it goes red.
    const sql = String(args[0].join('?'));
    expect(sql).toContain('::numeric');
    expect(sql).not.toContain('::float8');
    expect(sql).toContain('LATERAL');
  });
});

describe('queryLoopMetrics', () => {
  it('queries the window with the right unit/kind params and normalizes the result', async () => {
    const before = Date.now();
    mockQueryRaw.mockResolvedValue([
      { bucket: new Date('2026-09-01T00:00:00.000Z'), kind: 'run_spend', count: BigInt(3), sum: 4.5, avg: 1.5 },
    ]);
    const out = await queryLoopMetrics('run_spend', { hours: 48, bucket: 'day' });
    expect(out).toEqual([
      { bucket: '2026-09-01T00:00:00.000Z', kind: 'run_spend', count: 3, sum: 4.5, avg: 1.5 },
    ]);

    // tagged-template call: [strings, unit, since, kind]
    const [, unit, since, kind] = mockQueryRaw.mock.calls[0] as any[];
    expect(unit).toBe('day');
    expect(kind).toBe('run_spend');
    expect(since).toBeInstanceOf(Date);
    expect(Math.abs(before - 48 * 3_600_000 - since.getTime())).toBeLessThan(5_000);
  });

  it('defaults to hourly buckets over 24h and clamps absurd windows to 90d', async () => {
    await queryLoopMetrics('guard_strike', { hours: 999_999 });
    const [, unit, since] = mockQueryRaw.mock.calls[0] as any[];
    expect(unit).toBe('hour');
    expect(Math.abs(Date.now() - 90 * 24 * 3_600_000 - since.getTime())).toBeLessThan(5_000);

    await queryLoopMetrics('guard_strike', { hours: -3 }); // invalid → default 24h
    const since2 = (mockQueryRaw.mock.calls[1] as any[])[2];
    expect(Math.abs(Date.now() - 24 * 3_600_000 - since2.getTime())).toBeLessThan(5_000);
  });
});

describe('summarizeLoopMetrics', () => {
  it('maps groupBy output to {kind, count, sum} with null sums → 0', async () => {
    mockGroupBy.mockResolvedValue([
      { kind: 'guard_strike', _count: { _all: 4 }, _sum: { value: 9 } },
      { kind: 'wake_delivered', _count: { _all: 12 }, _sum: { value: null } },
    ]);
    const out = await summarizeLoopMetrics(24);
    expect(out).toEqual([
      { kind: 'guard_strike', count: 4, sum: 9 },
      { kind: 'wake_delivered', count: 12, sum: 0 },
    ]);
    const arg = mockGroupBy.mock.calls[0][0] as any;
    expect(arg.by).toEqual(['kind']);
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
  });
});

// ── Retention ────────────────────────────────────────────────────────────────

describe('sweepLoopMetrics', () => {
  it('deletes in id batches until a short page, returning the total', async () => {
    const page = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
    mockFindMany
      .mockResolvedValueOnce(page(LOOP_METRIC_GC_BATCH, 'a'))
      .mockResolvedValueOnce(page(120, 'b'));
    mockDeleteMany
      .mockResolvedValueOnce({ count: LOOP_METRIC_GC_BATCH })
      .mockResolvedValueOnce({ count: 120 });

    const deleted = await sweepLoopMetrics(30);
    expect(deleted).toBe(LOOP_METRIC_GC_BATCH + 120);
    expect(mockFindMany).toHaveBeenCalledTimes(2); // short page ends the loop
    const where = (mockFindMany.mock.calls[0][0] as any).where;
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - 30 * 86_400_000 - where.createdAt.lt.getTime())).toBeLessThan(5_000);
    expect((mockDeleteMany.mock.calls[1][0] as any).where.id.in).toHaveLength(120);
  });

  it('is a no-op returning 0 when nothing is old enough', async () => {
    expect(await sweepLoopMetrics()).toBe(0);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('never throws when the DB is down (warns, returns count so far)', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(sweepLoopMetrics()).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
