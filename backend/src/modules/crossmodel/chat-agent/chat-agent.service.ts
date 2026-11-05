/**
 * One-Digby Phase 2 (step 5): the agent CHAT engine.
 *
 * The coding orchestrator (agentLoop) answers chat queries under a chat profile:
 *   L1 (single_thinking): direct answer — the agent searches via its OWN web
 *     tools under the search-discipline doctrine (owner 2026-09-03: the forced
 *     harness B1 SERP is REMOVED — grounding is model-disciplined, watched via
 *     the 'chat_search_usage' loop metric).
 *   L2 (thinking): the CROSS_CHECKERS lineup (DeepSeek V4 Pro since owner
 *     2026-09-03; was GLM-5.2 one-shot) runs as a FULL autonomous peer — its
 *     own 8-step tool loop, web + retrieval tools, no user interaction — IN
 *     PARALLEL with the orchestrator; its draft surfaces as a legacy
 *     model-response card and is injected into the orchestrator's context,
 *     which reconciles and streams the synthesis. Same product promise, one
 *     engine.
 *
 * Emits ONLY legacy SSE events (via ChatAgentSSEAdapter) so today's chat UI
 * renders agent runs with zero frontend changes. Open-source models only (P2).
 *
 * Capability doctrine (2026-09-08 agentic expansion): every orchestrator
 * doctrine (chat + council lead, user turns AND machine wakes) carries the
 * platform playbook + proactive-offer + follow-up-chip blocks from
 * ./capability-doctrine (a pure leaf), and finalize records a
 * 'chat_platform_usage' loop metric beside 'chat_search_usage'.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { randomUUID } from 'crypto';
import { storedModeToPreset } from '../types';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { finishRunAgreementMeta, FINISH_RUN_AGREEMENT_METRIC } from '../coding/finish-run';
import { toolLaneHintFromPlan } from '../coding/tool-diet';
import { githubFileReadToolDisabled } from '../coding/integration-tool-schema';
import { dispatchOnlyTurnTools } from './dispatch-turn';
import { bindTelemetryRunSession, chatRunTelemetryIdDisabled, currentTelemetryRunId, runWithTelemetryRun } from '../../../utils/run-telemetry-context';
import { unbackedDispatchClaimIds, inventedReceiptIds, unbackedClaimNotice, unbackedFreshnessClaim, unbackedFreshnessNotice, unbackedFreshnessRetryDisabled, unbackedActionClaims, unbackedActionNotice, unbackedActionRetryDisabled, filterHonestReferences, residualUnbackedClaims, rewriteUnbackedClaims, unbackedClaimRewriteDisabled, noActionToolNote, noActionToolNoteDisabled, stripNoActionToolNote, actedSinceTurn, NO_ACTION_TOOL_NOTE, unbackedMachineWakeDisabled, toolNounCitedIds, inventedToolNounIds, unbackedCredentialClaims, citedOwnReceiptIds, citedChatLinkIds, groundFollowThroughCitations, followThroughIdGroundingDisabled, inventedReceiptSpans, receiptTripleGroundingDisabled, receiptTripleEnforceDisabled, receiptToolMismatches, tripleAggregateLogLevel, artifactAttributionMismatches } from './unbacked-claim';
// BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20): the action-class footnote + owner-briefing
// filter for the claims the integrity check could not verify on a supervisor machine wake (pure leaf).
import { actionClassAnnotateDisabled, briefingUnverifiedFilterDisabled, collectUnverifiedClaims, placeUnverifiedFootnote, renderUnverifiedClaimsFootnote, runMadeNoToolCall, stripUnverifiedFootnote, zeroToolDispatchQuotes, type ClaimIdRef, type UnverifiedClaim } from '../platform/unverified-claims';
// Read receipts are observations, never evidence of an act (the footnote lane's act-evidence probe).
import { PLATFORM_OBSERVE_TOOLS } from '../coding/evidence-tools';
import { ownerStatusProxyDisabled, loadOwnerStatusLedgerView, detectOwnerStatusProxyMismatches } from './owner-status';
import { chatProfile, quickChatProfile, supervisorProfile, projectSupervisorProfile, CROSS_CHECK_SOFT_MS, CROSS_CHECK_HARD_MS, CROSS_CHECK_GATE_MS, CROSS_CHECK_LATE_WAIT_MS, CROSS_CHECK_RECONCILE_MS, CROSS_CHECK_LATE_RECONCILE_MS, CROSS_CHECK_LATE_RECONCILE_MACHINE_MS } from '../coding/agent-profiles';
import { buildChatQueryContext, persistAndEmitCanvases } from './chat-context';
import { collectStructuredBlocks, CARRIED_FORWARD_LABEL } from './structured-blocks';
import { normalizeAssistantMarkdown } from '../markdown-normalize';
import { lintMarkdownNote, degradeMachineNotePipes, markdownLintDisabled } from '../platform/markdown-lint';
import { looksLikeLeakedChatToolCall, looksLikeToolCallNarration, firedReplayUnsafeTool, CHAT_LEAK_NUDGE, MAX_CHAT_LEAK_RETRIES } from './tool-call-leak';
import { stampAnswerClockHeader, answerClockStampDisabled, stampAheadHeadlineClock } from './answer-clock';
import { futureClockReplaceEnabled } from '../platform/future-clock-policy';
// STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21): a machine note that re-posts the chat's previous
// STRUCK note is sent back once (at most once per struck note, ever), then annotated; the next machine turn after a
// strike carries [PRIOR NOTE STRUCK]. computer_task claim check (related to ticket 4c7aebf7 (c) — part (c) itself is
// not built): on-screen input claims vs the run's computer_task results — observe-only (a counts-only row) unless
// COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1.
import { checkComputerTaskClaims, computerTaskClaimAnnotateEnabled, computerTaskClaimCheckDisabled, computerTaskClaimMetricMeta, computerTaskClaimRowWorthy, computerTaskCallsInputFree, renderComputerTaskClaimAnnotation, COMPUTER_TASK_CLAIM_METRIC, COMPUTER_TASK_CLAIM_SEAM, COMPUTER_TASK_CLAIM_STRIKE } from './computer-task-claims';
import { detectStruckNoteRepeat, explicitNoopPredicate, loadPriorAssistantNote, priorNoteStruckBlockDisabled, renderPriorNoteStruckBlock, renderRepeatAnnotation, renderRepeatRejectBackNotice, repeatLineageStamp, repeatRejectBackSkip, repeatTargetOf, struckNoteRepeatDisabled, withoutNoMentionSentence, REPEAT_LINEAGE_META_KEY, STRUCK_NOTE_REPEAT_METRIC, type PriorNote, type RepeatAnnotatedOutcome, type RepeatLineageStamp, type RepeatSkip } from './struck-note-repeat';
import { findUnbackedWebFailureClaim } from './phantom-tool-claim';
import { ownerStateReadRetryDisabled, stripUnreadStateNote, unreadStateClaimProse, unreadStateNoteText, unreadStateNotice, withUnreadStateNoteParts, UNREAD_STATE_NOTE } from './unread-state-note';
import { scrubDeliveredRowContent, stripAnswerScaffolding } from './answer-scaffolding';
import { unsavedStandingRule, standingRuleNotice, standingRuleRetryDisabled } from './standing-rule';
// Hand-back lint (cohesive-chat program, rule task.lifecycle): a human ask
// handed back as a question while work remains — observe-only telemetry.
// (The continuation branch — turn-continuation.ts classifyRunEnd — carries
// its OWN classifier; this leaf gates nothing.)
import { findHandback } from './handback-detector';
import { parseCanvasTags, parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { updateContextAsync } from '../langgraph/memory.graph';
import contextService from '../context.service';
import moonshotIntegration, { cleanQuestionForTitle } from '../integrations/moonshot.integration';
import { isStaleChatTitle } from './title-placeholder';
import { modelSupportsVisionForRun, resolveRoleModelForRun, resolveRoleFallbackForRun, roleOverrideForRun, seatUnservableReason, SeatUnservableError, EMPTY_ASSISTANT_PLACEHOLDER } from '../coding/coding-model';
import { EMPTY_RUN_FALLBACK_NOTE, isHarnessErrorNote } from '../coding/harness-error-notes';
import { WAKE_NOOP_NOTE_RE } from '../fleet/supervisor-reply-row';
import type { ChatImage } from '../coding/chat-images';
import { ChatAgentSSEAdapter, hostOf, LegacySend, isNonCitationHost } from './sse-adapter';
import { STATUS } from './status-voice';
import { withholdFromClient } from '../coding/reasoning-wire';
// Shared vision hop (owner 2026-09-03): TEXT-ONLY ensemble peers (the DeepSeek
// L2 checker + both council colleagues) get ONE glm-5.3-flash description of
// the user's attached images injected as context; the orchestrator (kimi-k3)
// keeps seeing images natively.
import { describeImageWithVision, resolveVisionDescribeModel } from '../image-describe';
// Grounding telemetry (owner 2026-09-03 search-force removal): one fire-and-
// forget row per chat run so post-launch grounding rates are chartable.
import { recordLoopMetric, LOOP_METRIC_KINDS, MetricStamp } from '../platform/loop-metrics.service';
import { noteChatRunStarted } from '../platform/delegation-tasks'; // build 2026-10-08 D-1 (SHADOW ledger)
import { MODEL_BENCH_ACCOUNT_EMAIL } from '../platform/model-bench-scorecard';
import { applyHarnessReceipts, harnessReceiptsMeta, harnessReceiptsView, stripModelActionsBlock, stripModelActionsBlockFromParts, stripTrailingHarnessAppendix, stripTrailingNoopCloseLine, stripTrailingNoopCloseLineFromParts, stripForgedHarnessChrome, stripForgedHarnessChromeFromParts, supervisorHarnessReceiptsDisabled, supervisorOwnerTurnReceiptsDisabled, wakeNoteRetryCloseClause, type HarnessReceiptsView } from '../platform/harness-receipts';
// Session titles (2026-09-27): a human-pinned title is never repaired — the
// where-clause of both CAS title writes carries titlePinned:false.
const titlePinGuard = (): { titlePinned?: false } => ({ titlePinned: false });

// P1.1 (owner handoff 2026-10-05): memoized bench-account probe for synthetic ux_ttft stamping.
// The model-bench pipeline drives chat runs as MODEL_BENCH_ACCOUNT_EMAIL; those rows are
// synthetic evidence, never prod latency (platform/model-evidence.ts loadFresh excludes them).
// Fail-open to not-synthetic: a lookup failure must never corrupt the stamp, only leave a
// row unflagged (the reader's by-account SQL arm still catches pre-flag rows). try/catch,
// not a chained .catch — a missing/partial prisma client (test mocks with no `user` model)
// throws SYNCHRONOUSLY on the property access, before a chained .catch can attach.
let benchAccountUserIdMemo: string | null | undefined;
const isBenchAccountUser = async (userId: string | null | undefined): Promise<boolean> => {
  if (!userId) return false;
  if (benchAccountUserIdMemo === undefined) {
    try {
      const benchUser = await prisma.user.findUnique({
        where: { email: MODEL_BENCH_ACCOUNT_EMAIL },
        select: { id: true },
      });
      benchAccountUserIdMemo = benchUser?.id ?? null;
    } catch {
      benchAccountUserIdMemo = null;
    }
  }
  return benchAccountUserIdMemo === userId;
};
// WI-D (2026-09-25): one shared spend ledger per turn — the lead, the Double
// Checker, council colleagues and the reconcile pass all record into it, and
// the turn writes ONE run_spend when the last of them releases it.
import { createTurnUsageLedger } from './turn-spend';
import type { UsageAccumulator } from '../coding/cost';
// WI-O #4c (2026-09-25): a plain chat's stored lead-model pick (crossmodel_chats.leadModel).
import { chatLeadOverrideForRun } from './chat-lead-model';
import { ghostModeDisabled, ghostSingleModelPlan } from './ghost-runtime';
import { resolveGhostEndpointForRun, type ResolvedGhostEndpoint } from '../model-endpoints/ghost-endpoint.service';
import { frontLoadRunOutcome } from '../platform/run-outcome-line';
import { endLiveRun, isRunActive, tryStartLiveRun, cancelRun, setRunEventTap, setRunMeta, bindLiveRun, type BoundLiveRun } from '../coding/live-runs';
import { wrapInjectWithRetireNudge } from './retire-nudge';
import { scheduledNotifyBackstopDisabled, scheduleMandatesTrailingNotify, modelAlreadyNotified, isQuietRunReply, buildScheduledNotifyMessage, parseNotifyOutcome } from './trailing-notify-backstop'; // ticket 8aa5688f
import { resolveTerminalStepOutcome } from './terminal-step-brief'; // ticket 0973bdd7
import { chatSessionRunKey, markGuestSessionRunLive, clearGuestSessionRunLive } from './guest-session-run';
import { isRetiring, retiringSinceIso } from '../coding/retiring';
import { clearRunEventMirror, chatRunMirrorTap, guestMirrorId } from './run-event-mirror';
import { guestStreamAttachDisabled } from './stream-drops';
import {
  claimChatLiveRun, refreshChatLiveRun, releaseChatLiveRun,
  takeChatRunStopRequest, isChatBusy, LIVE_RUN_HEARTBEAT_MS,
  isChatRunMachineTriggered, requestChatRunStop, clearChatRunStopRequest,
} from './chat-busy';
import { peekOldest, deletePending, readPendingOrigin, consumePendingUploads, latestOwnerRowsAfter, buildSupersededSteerNote, enqueueChatMessage, createMessagesConsumingPending, consumeDrainedPendingRows, noteDrainAttempt, tripDrainCooldown, isDrainCoolingDown, MAX_DRAIN_ATTEMPTS } from './message-queue.service';
// Turn continuation + the task-card contract (cohesive-chat wave 2026-09-28).
import {
  classifyRunEnd, rewriteClosingText, armTurnContinuation, nextContinuationRound, planStepCounts, planUnfinishedCount,
  planTouchedSince, receiptCounts, turnContinuationDisabled, continuationMaxRounds, closingText,
  isContinuationPrompt, recoverContinuationFromPrompt, parseContinuationRound,
  CONTINUATION_RESULT_KIND, CONTINUATION_TASK_TITLE, CONTINUATION_LINE, CONTINUATION_CAP_LINE, CONTINUATION_FAILED_LINE,
  CONTINUATION_STOPPED_LINE, CONTINUATION_SUPERSEDED_LINE,
  type ContinuationRun, type RunEndVerdict,
} from './turn-continuation';
// Review fixes 4 + 5 (same wave): a lost origin stash is recovered from the row
// (never run as a machine wake) and a user message supersedes a queued round.
import { continuationSupersededByUser, settleContinuationCard, settleLostContinuation, type ContinuationSupersession } from './continuation-recovery';
// build 2026-10-08 A1: answer-first on OWNER turns in supervisor chats (soft deadline + follow-through continuation).
import {
  resolveOwnerAnswerFirst, createAnswerFirstObserver, answerFirstDoctrineLine, parseFollowThrough, followThroughContinuationLine,
  ownerAnswerFirstVerdict, mutatingCallSignatures, duplicateSignatures, answerFirstContinuationNote, ownerAnswerFirstMetricMeta,
  markChatRunPreempted, takeChatRunPreempted, setFollowThroughHold, followThroughHoldMs, isAnswerFirstFollowThrough, followThroughQuietZeroDisabled,
  OWNER_ANSWER_FIRST_METRIC, OWNER_ANSWER_FIRST_META_KEY, ANSWER_FIRST_MAX_RESUMES, ANSWER_FIRST_PREEMPT_HOLD_MS, ANSWER_FIRST_RESUME_NOTE,
  type AnswerFirstObserver, type FollowThrough, type OwnerAnswerFirstResolution,
} from './owner-answer-first';
import {
  buildTaskEvent, emitTaskEvent, persistTaskCard, TASK_EVENT_TYPE, buildSessionTaskEvent, spawnedSessionsInParts,
  spawnEndTurnNotice, spawnCardStillOwed, type TaskEvent, type SpawnedSession,
} from './task-events';
import { getPlan as getChatPlan, type CodingPlan } from '../coding/plan.service';
import { machineWakePreamble, OWNER_DIGEST_KIND } from './machine-wake';
// audit 2026-10-08 W6-1: the continuity slice of a supervisor machine wake (pure leaf).
import { selectWakeContinuityHistory, wakeLedgerDiffActive } from '../platform/wake-material-rule';
import {
  OWNER_TURN_READ_BOUND_MS, OWNER_TURN_READ_CEILING_MS, ownerHistoryV2Disabled, ownerLedgerDiffDisabled, ownerThreadEntriesFromRows,
  ownerTurnReadFailOpen, pendingConfirmationNoteFrom, renderOwnerThreadBlock, selectOwnerTurnHistory, startOwnerTurnRead,
  type OwnerTurnRead, type OwnerTurnRow,
} from '../platform/owner-turn-history';
import { isOwnerDispatchRun } from '../platform/agent-send-header';
// Child-session relay lineage at PERSIST time (ticket 327ff5e3 — the residual
// of 1757b07d): the same leaf the fleet read path uses, so one authority
// decides "is this agent send my child reporting back?" on both sides.
import { isChildSessionRelaySend } from '../platform/child-session-relay';
import { humanTurnProviderExtra, effortProviderExtra, leadEffortArm } from './human-turn-effort';
import { readMachineCaps } from './machine-caps';
// N9 (2026-09-25): type-only — the machine-wake effort gate itself is a dynamic import (decision-gate's static graph reaches config/env).
import type { WakeEffortGate } from '../platform/wake-effort';
import { renderResumeBriefNote, type DeployResumeBrief } from './deploy-resume-brief';
import { quickLaneBrief } from './quick-lane-note';
// Self-host setup hardening (2026-10-20): the Quick lane brief must not order a search on an instance with none.
import { webSearchMissingOnInstance } from '../platform/instance-setup';
import { firstWordNote, quickFirstWordNote } from './first-word-note';
// Ticket e3113ec9 (2026-11-01): a video ask must disclose the gap in the FIRST
// line, not after several turns of reference frames — a turn-scoped note, so it
// costs nothing on any other turn.
import { videoCapabilityNote } from './video-capability-note';
import { crossCheckArtifactGroundingRule, crossCheckFleetScopeNote, crossCheckLaneClockNote, crossCheckPlatformScopeRule, crossCheckVerifySilenceRule } from './cross-check-scope';
import { crossCheckDraftsHeader, stripCrossCheckActionClaims } from './cross-check-action-claims';
import { crossCheckDraftIntegrityBanner, findPhantomDraftIds } from './cross-check-draft-integrity';
// Fleet-supervisor durable state (2026-08-22 rebuild) — a LEAF module (prisma +
// logger only), safe to static-import onto the run-start path.
import { getSupervisorState, formatStateForWake, appendDirective, closeAskOnReply, buildFleetAttentionBlock, buildFleetLivenessBlock, buildProjectScheduleBlock, buildInflightPreemptBlock, markPreemptedInflight } from '../platform/supervisor-state.service';
import { loadKpisForSupervisorChat } from '../platform/kpi-register.service';
import { kpiReplyFooter } from '../platform/kpi-of-record';
import { runBoundedColleague, normalizeCouncilSeat, fitColleagueDeadline, fittedDispatchCeiling, researchRungColleagueFitDisabled, councilPresetColleagueFitDisabled, COUNCIL_DISPATCH_CEILING_MS, researchNoWallClock, isLateCouncilFinding, councilStallMs, councilDispatchStallMs, councilReasoningOnlyMs, councilLateStragglerWaitMs, createSeatProgress, noteSeatProgress, seatIdleMs, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, type CouncilProgressEvent } from './council-dispatch';
import { decideTurnPlan, turnPlanDisabled, turnPlanMetadata, turnPlanCanaryIncludes, TURN_PLAN_PRIOR_TURNS, TURN_PLAN_TIMEOUT_MS, TURN_PLAN_PURPOSE, type TurnPlan } from '../platform/turn-plan';
import { turnPlanFromMetadata, turnPlanSupervisorSkipDisabled, ranRosterOf, TURN_PLAN_HYGIENE_KIND } from './turn-plan-labels';
import { skipRetiredHumanAsk } from '../platform/human-turn-retirement';
import { QUICK_SEAT_ROLE } from '../coding/helper-seat';
import { armLateCouncilAddendum } from './council-late-addendum';
import { buildBoardDigestBlock, buildLaneBoardBlock } from '../platform/board-digest.service';
// Action-verifier pre-gate (ticket ae085617) — executed-actions is import-free,
// so the keyword check costs nothing; the verifier itself stays a dynamic import.
import { hasActionClaimKeywords } from '../platform/executed-actions';
// Per-question latency classification (ticket 62761c89) — the auto router's
// EXISTING triviality heuristic, reused (no new classifier): a question it
// would route to L1 is "simple" and gets the short cross-check deadline.
import { routeMessageHeuristic, detectCodeIntent } from '../platform/auto-router';
// Capability doctrine (2026-09-08 agentic expansion): the platform playbook,
// proactive-offer and follow-up-chip blocks every orchestrator doctrine carries,
// plus the action-chip counter for the 'chat_platform_usage' metric. PURE LEAF.
import { platformPlaybookBlock, proactiveOffersBlock, followUpsInstruction, countActionChips } from './capability-doctrine';
import { followupBackstopDisabled, generateBackstopFollowUps } from './followups-backstop';
// Platform tool NAMES from the dependency-free leaf — NEVER platform-tools.ts
// (its static graph reaches config/env and would kill the jest worker of every
// suite that imports this service): the set 'chat_platform_usage' counts against.
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
// WI-C (2026-09-25): type-only — the outcome label itself is a dynamic import at finalize.
import { decide, decisionMode, type DecideResult, type DecisionStash, type DecisionPurpose, type DecisionMode } from '../platform/decision-gate';
// N4 (2026-09-25): the Level 2 checker-site router — purpose checker_route
// asked beside the isSimpleQuestion regex (shadow), labelled from the turn's facts.
import {
  buildCheckerRouteRequest, checkerRouteDisabled, checkerRouteVerdict, recordCheckerRouteOutcome,
  CHECKER_ROUTE_PURPOSE, CHECKER_ROUTE_TIMEOUT_MS, type CheckerRunFacts,
} from './checker-route-gate';
// Compute policy (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4/§5 — branch
// cp/harness): the per-turn DepthPlan (preset / gate / escalation), the
// answer-first injector rule, drafts_agree + revision_material at the reconcile,
// the check_state pill events, the Dig-deeper chip and the DepthBudget hook.
// The gate module (platform/compute-policy-gate) is Module A's; every call here
// fails open to the preset plan.
import {
  decideComputePlan, decideDraftsAgree, decideRevisionMaterial, presetPlan, normalizeDepthPreset, stakesWaitMs, computePolicyTimeoutMs,
  computePolicyDisabled, recordComputePolicyTelemetry, draftsAgreeThreshold, DRAFTS_AGREE_DEFAULT_THRESHOLD, type DepthPlan, type RevisionMaterialVerdict, type ComputeSegment,
} from '../platform/compute-policy-gate';
import { depthBudgetFor, backgroundBoundMs, depthBudgetBackgroundBoundDisabled, type DepthBudget } from '../platform/depth-budget';
// Supervisor OFF switch (owner 2026-09-26): the plain-chat machine-run backstop
// — agent messages / webhooks / queue drains into a switched-off supervisor
// chat start no run (the message stays queued; a human turn is never refused).
import { supervisorWakeSkipById } from '../platform/supervisor-switch';
import {
  answerFirstDisabled, digDeeperDisabled, injectorWaitMs, blockingCheckerGateMs, finalizeDraftWaitMs, shouldSpawnChecker, keyedProgress, depthChipFor, nextRungForPlan,
  depthMetadataFor, escalationPlan, escalationUserNote, parallelCrossCheckNote, PLAN_LABEL_ATTACH_MS, compactDecisionStash,
  researchRungBudgetDisabled, researchRungDeadlineMs,
  DEEPER_FINDINGS_KIND, DEEPER_FINDINGS_TITLE,
  computePolicyMachineDisabled, machinePresetPlan, applyMachineRails, machineGateSpawnsChecker,
  computePolicyMachineActEnabled, shadowMachineAct, stampEscalation,
  type CheckStatePayload, type NextRung, type DepthChip,
  computePolicyEnforcementStamp,
  supervisorCheckerSkipDisabled, withoutSupervisorChecker,
} from './compute-policy-wiring';
import { labelDraftsAgree, labelComputePolicyFacts, draftsAgreeLabelMaterial, draftsAgreeMeta, type ComputePolicyTurnFacts } from './compute-policy-labels';
import { pickAvoidingFamily, checkerFamilyGuardDisabled } from '../platform/model-pick';
import { actingSpec, resolveRolePicks, resolveRolePicksBounded, type RolePickRequest, type RolePickResult } from '../platform/role-pick';
import { quickWebCapDecision, rolePickDecision } from '../platform/roster-policy';
import { quickWebToolCaps, type WebToolCaps } from '../coding/web-tool-cap';
import { modelFamily } from '../model-endpoints/model-catalog';
// Dynamic roster phase 4 (roster 2026-10-06 Team D): the persisted SESSION ROSTER (D-1), the lead's call_in tool (D-2)
// and the per-answer team note (D-3). Pure leaves + fail-open I/O — off / error restores today's turn.
import {
  readSessionRosterForTurn, saveSessionRosterTurn, guardPriorLane, applyStickyLead, stickyLeadDisabled, ranLaneOf,
  newRosterTrace, rosterDepthRecord, sessionRosterMetricMeta, type RosterRead,
} from './session-roster';
import { callInOffer, callInDoctrineRow, createCallInTool, type CallInOffer } from './call-in';
import { teamNoteFor, teamNoteDisabled } from './team-note';
import { rosterConfig, DEFAULT_ROSTER_CONFIG } from '../platform/roster-config';
// Roster 2026-10-06 (Team A): the turn plan decides DEPTH — the checker by lane (A-2), the lane fail-open (A-4); the
// research route itself runs at the controller (A-3) and hands its answered plan in as args.turnPlanPrefetched.
import { answerGroundingFromParts } from '../memory/answer-grounding';
import { imessageDraftSkipReason, toolNamesCalled } from '../imessage/draft-skip';
import { laneDepthFor, applyLaneDepth, laneCheckerModelFor, laneDepthRowMeta, laneCheckerFollowUpDisabled, LANE_DEPTH_METRIC, ttftLaneStamp, standardLaneThinkingBudget, type LaneDepthAccess, type LaneDepthRunDecision } from '../platform/lane-depth';
// 2026-10-20: the A-2 checker drop's follow-up hysteresis (the Quick guard's session rule) — see prefetchedSessionLane.
import { QUICK_LANE_FOLLOW_UP_CEILING } from '../platform/quick-lane-guards';
import type { Lane } from '../platform/turn-plan';

/**
 * cp/labels (2026-09-26): the INLINE reconcile's revision_material verdict as
 * persisted on metadata.check.verdict — the same shape late-crosscheck's
 * revisionVerdictMeta writes (material / source / decisionId + the gate's
 * compact stash), so a later thumbs / Dig-deeper tap can label the decision
 * from the row alone. Pure; {} when no inline verdict was taken.
 */
function inlineVerdictMeta(v: RevisionMaterialVerdict | null): { verdict?: Record<string, unknown> } {
  if (!v) return {};
  const decision = v.stash ? compactDecisionStash(v.stash) : null;
  return { verdict: { material: v.material, source: v.source, ...(typeof v.contradicts === 'boolean' ? { contradicts: v.contradicts } : {}), ...(v.decisionId ? { decisionId: v.decisionId } : {}), ...(decision ? { decision } : {}) } };
}
// The compute_policy decision purpose: Module A (branch cp/gate) registers
// 'compute_policy' in the DecisionPurpose union + the modes registry; until that
// merge the cast is the seam — decisionMode() resolves any purpose name through
// store → env (DECISION_GATE_MODE_COMPUTE_POLICY) → the default ('shadow';
// 'off' under NODE_ENV=test), so the harness never awaits a non-act ask.
const COMPUTE_POLICY_PURPOSE = 'compute_policy' as DecisionPurpose;

/**
 * Rollout watch 2026-09-14: a machine wake whose model turn came back empty
 * (reasoning-only / provider empty completion — the sanitizer's "[no content]"
 * placeholder) used to persist as a literal "[no content]" bubble. It now
 * closes with the doctrine's no-op marker so the noop classifier counts it,
 * the action verifier sees no claims, and the owner reads a sentence.
 */
export const MACHINE_WAKE_EMPTY_NOTE =
  'WAKE: no-op — the model returned no text on this wake (empty completion); nothing was changed.';
/** Tools whose receipts are reads, never actions — the empty-wake note may claim "nothing changed" only when every ok receipt is one of these. */
// Ticket 66007a6e: web_pipe|youtube_pipe joined the alternation because the
// web-probe receipt class now mints (collector-only) ok receipts for web
// tools — without this rider a web_pipe ok receipt would flip the machine-wake
// "acted" count below and mislabel a probe-only wake as an action wake.
// scrape_/search_engine already matched; youtube_pipe is reachable on chat
// surfaces too (agent.ts CHAT_ORCH_TOOLS includes it) and rides along for
// consistency.
export const READ_ONLY_TOOL_RE = /^(get_|list_|search_|read_|describe_|fetch_|check_|view_|goal_get|todo_list|memory_|web_search|search_engine|scrape_|web_pipe|youtube_pipe)/i;

// 2026-08-01 lineup (owner directive): Kimi K3 orchestrates EVERY level —
// L1 Quick, L2 main+synthesis, L3 council lead.
// These constants are the BUILT-IN DEFAULTS of the named seats — each run
// resolves its actual lineup through the instance's model-roles config
// (model-roles.service via resolveRoleModelForRun; fail-open to these), so a
// Digby Edge admin can point every seat at a custom '<label>:<modelId>'
// endpoint (built-in seats 401 on Edge where the cloud provider keys are absent).
// L1 Quick runs the SAME orchestrator seat (owner, 2026-08-01: glm-5.2 → kimi-k3).
const ORCHESTRATOR_MODEL = 'kimi-k3';             // every level: L1 direct, L2 main+synthesis, L3 council lead
// Image attachments: when the picked orchestrator can't see images, the run
// upgrades to a vision-capable model (kimi-k3 — verified 2026-07, PR #65).
const VISION_ORCHESTRATOR_MODEL = 'kimi-k3';
// L2's ONE independent cross-checker. Owner 2026-09-03 full-peer redesign:
// DeepSeek V4 Pro (the alias serves the 0813 GA snapshot) runs a genuine
// autonomous tool loop — full maxSteps, its own web + retrieval tools,
// reasoning_effort 'max' + thinking enabled — instead of the one-shot
// SERP-grounded drafter. Was GLM-5.2 one-shot (owner 2026-08-01).
// 2026-09-10: DeepSeek V4.1 Flash (`deepseek-flash`) — the vendor retired V4 Pro
// (routed to V4.1 Flash from 2026-09-14); owner asked for the checker on the
// newest DeepSeek. The admin `double_checker` seat (instance-wide; owner rename
// 2026-09-15 — ONE secondary model for Level 2 AND the Level 3 council) overrides.
const CROSS_CHECKERS = ['deepseek-flash'];
// Web tools whose calls count as grounding for the 'chat_search_usage' loop
// metric and the answer card's webSearchUsed flag.
const WEB_GROUNDING_TOOLS = new Set(['search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe']);
/** Count of web-grounding tool calls in a run's parts (pure; bad input → 0). */
export function countWebToolCalls(parts: unknown): number {
  return Array.isArray(parts)
    ? parts.filter((p: any) => p?.type === 'tool_call' && WEB_GROUNDING_TOOLS.has(String(p?.name))).length
    : 0;
}
// Platform-usage telemetry (2026-09-08 agentic expansion): which of a run's
// tool calls were PLATFORM tools (account / fleet / organizational — the set the
// capability playbook teaches), for the 'chat_platform_usage' loop metric.
// Reads the leaf's live list, so tools registered later are counted for free.
const PLATFORM_TOOL_NAME_SET = new Set<string>(PLATFORM_TOOL_NAMES);
/** Count of platform-tool calls in a run's parts (pure; bad input → 0). */
export function countPlatformToolCalls(parts: unknown): number {
  return Array.isArray(parts)
    ? parts.filter((p: any) => p?.type === 'tool_call' && PLATFORM_TOOL_NAME_SET.has(String(p?.name))).length
    : 0;
}
/** Distinct platform tool names called in a run's parts — first-seen order, capped (default 12; pure). */
export function platformToolNamesCalled(parts: unknown, max = 12): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts as any[]) {
    const name = p?.type === 'tool_call' ? String(p?.name) : '';
    if (name && PLATFORM_TOOL_NAME_SET.has(name) && !out.includes(name)) {
      out.push(name);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ── Latency budget constants (ticket 62761c89, 2026-08-25) ─────────────────
// Router-classified SIMPLE questions (the auto router would send them to L1):
// the orchestrator stops waiting on the cross-checker draft after this and
// answers without it (deep/council questions keep the CROSS_CHECK_* caps).
// 75s ≈ one thinking one-shot's realistic envelope for a simple lookup.
const CROSS_CHECK_SIMPLE_WAIT_MS = 75_000;
// …and on the step-0 fast path a simple question skips the 60s late-wait +
// reconcile entirely, keeping only this short grace so a fast checker's
// More-info card still fills.
const CROSS_CHECK_SIMPLE_CARD_GRACE_MS = 2_000;
// Compute policy (2026-09-26, design §4 D1): a drafts_agree answer at or above
// the purpose's acting bar, in ACT, skips the reconcile pass ("Checked ✓").
// The bar is draftsAgreeThreshold() at the call site (DECISION_GATE_THRESHOLD_
// DRAFTS_AGREE, default this constant) — the SAME value decideDraftsAgree's
// `agree` and decision-gate inActBand use, so the acted set and the E12 act
// band stay identical (drafts_agree label semantics, 2026-09-26).
export const DRAFTS_AGREE_ACT_P = DRAFTS_AGREE_DEFAULT_THRESHOLD;
/** Guest title (2026-09-26): how long 'complete' waits for a still-running
 *  up-front title chain on a guest's FIRST turn — the echo on 'complete' is the
 *  guest client's only second chance (no title endpoint for sessions). */
export const GUEST_TITLE_COMPLETE_WAIT_MS = 4_000;

/**
 * L2 step-0 reconcile pass (2026-08-18, ticket 9e6950d1): when the orchestrator
 * answers with NO tool round, injectSystem (which only delivers from step ≥ 1 —
 * the deliberate research-overlap window) never hands it the cross-check drafts,
 * and the answer would ship UNRECONCILED (~10/day in prod). One bounded one-shot
 * pass with the SAME orchestrator model — question + its draft + the checker
 * block → the final reconciled answer. Returns '' on any failure so the caller
 * falls back to the original draft.
 */
async function reconcileWithCrossCheck(opts: {
  model: string; question: string; draft: string; block: string;
  sessionId: string; projectId: string; userId: string; userTurnAt: Date | undefined;
  /** A plain user-space chat (userSpaceChatIsolated) — rides into the worker so a tool round it is granted (leaked-tool-call
   *  retry) cannot read the space's project memory through search_memory. */
  projectMemoryIsolated?: boolean;
  isCancelled?: () => boolean;
  /** Bound for the one-shot pass (default CROSS_CHECK_RECONCILE_MS — the inline, user-waiting case; the late path passes CROSS_CHECK_LATE_RECONCILE_MS). */
  timeoutMs?: number;
  /** Telemetry label — where the pass runs. */
  path?: 'inline' | 'late';
  /** WI-D: the turn's shared spend ledger — the reconcile pass's tokens land on the turn's run_spend row. */
  usage?: UsageAccumulator;
}): Promise<string> {
  const reconcileBoundMs = opts.timeoutMs ?? CROSS_CHECK_RECONCILE_MS;
  const reconcileT0 = Date.now();
  // One crosscheck_reconcile row per pass (autonomy loop #4): 11 "reconcile
  // pass returned empty" lines in 4 h had no timing and no cause — timeout
  // vs a genuinely empty completion is what decides the fix.
  const recordReconcile = (outcome: 'ok' | 'empty' | 'timeout' | 'error') => {
    try {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.CROSSCHECK_RECONCILE, sessionId: opts.sessionId,
        value: Date.now() - reconcileT0,
        meta: { path: opts.path ?? 'inline', outcome, boundMs: reconcileBoundMs, draftChars: opts.draft.length, blockChars: opts.block.length },
      });
    } catch { /* telemetry never breaks the pass */ }
  };
  const reconcileDoctrine = 'You are finalizing an answer. Below are the user\'s QUESTION, your earlier DRAFT ANSWER, and an independent model\'s CROSS-CHECK DRAFT answering the same question. Reconcile them into the FINAL answer: adopt what the cross-check got right, correct what it got wrong, and where they genuinely disagree go with the stronger evidence and note the disagreement honestly. Preserve your draft\'s structure, format, and depth unless the cross-check materially changes it. Output ONLY the final answer to the question — no meta-commentary about the reconciliation process. ' +
    // Owner 2026-09-18 ("what happened to the follow-ups?"): the reconciled
    // text IS the user's final message, so it must carry the same end-of-answer
    // chrome the draft did — this doctrine never asked for it, so a step-0 L2
    // answer shipped its offer SENTENCE but no chips (and could drop a canvas).
    'Your DRAFT may end with a [FOLLOWUPS]…[/FOLLOWUPS] block and may contain [CANVAS …]…[/CANVAS] blocks: KEEP them in the final answer — the [FOLLOWUPS] block stays the very last thing, verbatim unless the reconciliation changed the answer (then update the chips to fit), and every [CANVAS] block stays intact. Never drop or paraphrase these blocks.';
  const result = await Promise.race([
    runChatWorker({
      worktree: '', sessionId: opts.sessionId, projectId: opts.projectId, userId: opts.userId,
      ...(opts.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}),
      permissionMode: 'auto', model: opts.model, projectName: 'chat', branch: 'chat',
      userTurnAt: opts.userTurnAt,
      history: [],
      userMessage: `QUESTION:\n${opts.question}\n\nYOUR DRAFT ANSWER:\n${opts.draft}\n\n${opts.block}\n\nWrite the final reconciled answer now.`,
      // One-shot reconciler (maxSteps 1 → the loop omits tools on the last
      // step): same proven shape as the one-shot checker drafters above.
      profile: { ...chatProfile('thinking', false), maxSteps: 1, runDeadlineMs: reconcileBoundMs },
      doctrineOverride: reconcileDoctrine,
      noWebTools: true,
      emit: () => {},
      isCancelled: opts.isCancelled,
      usage: opts.usage,
      // Seat honesty (prod 2026-09-25, run rmuhe55kkcd97v7): this is the LEAD
      // model borrowing the cross_checker worker shape for one step — meter it
      // under its own seat 'reconcile', not as the Double Checker (run_spend
      // meta.seats read glm-5.3:[lead,cross_checker]). The worker ROLE below is
      // unchanged: its prompt/toolset are what the one-shot needs.
      usageRole: 'reconcile',
    }, 'cross_checker'),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('cross-check reconcile deadline')), reconcileBoundMs + 15_000).unref()),
  ]).catch((err: any) => {
    recordReconcile(/reconcile deadline/.test(String(err?.message ?? '')) ? 'timeout' : 'error');
    throw err;
  });
  const text = (result.finalText || '').trim();
  recordReconcile(text ? 'ok' : 'empty');
  return text;
}
/**
 * Seat vocabulary (owner 2026-09-15): status lines, model cards and the admin
 * Model-roles page share ONE set of names — "Digby" (lead), "Double Checker"
 * (the one secondary model: Level 2 parallel answer + Level 3 council) and
 * "Triple Checker" (Level 3 council). Labels follow the SEAT, never the vendor
 * — any model can occupy any seat. Cards are keyed by seat too, so two seats
 * on the same vendor never collide. Mirrors frontend model-display SEAT_LABELS.
 */
export const SEAT_LABELS = { lead: 'Digby', double: 'Double Checker', triple: 'Triple Checker' } as const;
export const SEAT_CARD_KEYS = { lead: 'digby', double: 'double_checker', triple: 'triple_checker' } as const;
/** modelLabels payload (card key → seat label) for the complete event / persisted metadata. */
export const SEAT_MODEL_LABELS: Record<string, string> = {
  [SEAT_CARD_KEYS.lead]: SEAT_LABELS.lead,
  [SEAT_CARD_KEYS.double]: SEAT_LABELS.double,
  [SEAT_CARD_KEYS.triple]: SEAT_LABELS.triple,
};
type CouncilSeat = 'double_checker' | 'triple_checker';
/** Human status phrase for a sub-agent's tool RESULT (owner 2026-09-15: the
 *  line used to read "is analyzing the search engine result (8070 B)…" — a
 *  raw tool id plus developer telemetry). */
export function toolResultPhrase(toolName: string): string {
  const n = String(toolName || '');
  if (n === 'search_engine' || n === 'web_pipe') return 'is reading the search results';
  if (n === 'search_memory') return 'is checking what it already knows';
  if (n.startsWith('scrape') || n === 'browser_task') return 'is reading the page';
  if (/search/i.test(n)) return 'is reading what it found';
  return 'is reviewing what came back';
}
const COUNCIL_SEAT_LABEL: Record<CouncilSeat, string> = { double_checker: SEAT_LABELS.double, triple_checker: SEAT_LABELS.triple };

/**
 * Compact digest of a run's tool work for the seat-fallback harness notice
 * (2026-09-11): CALL/RESULT lines with names and truncated args/results, so the
 * model finishing the turn treats them as evidence already gathered and does
 * not redo side effects. Bounded; pure; exported for tests.
 */
export function summarizeToolEvidence(parts: any[] | undefined, opts?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = opts?.maxLines ?? 24;
  const maxChars = opts?.maxChars ?? 300;
  const out: string[] = [];
  for (const p of parts ?? []) {
    if (!p || (p.type !== 'tool_call' && p.type !== 'tool_result')) continue;
    const body = p.type === 'tool_call' ? JSON.stringify(p.args ?? {}) : String(p.result ?? '');
    out.push(`- ${p.type === 'tool_call' ? 'CALL' : 'RESULT'} ${p.name ?? '?'}: ${body.replace(/\s+/g, ' ').slice(0, maxChars)}`);
    if (out.length >= maxLines) { out.push('- … (more tool work omitted)'); break; }
  }
  return out.join('\n');
}

/**
 * Harness-authored guard chrome (the action-guard notice unshifted into parts,
 * or an evidence-guard wrapper): persists byte-identical — guard-chrome-redact
 * detects these by banner prefix and its contract says storage never drifts.
 * Prefix literals mirror guard-chrome-redact.ts (not exported there; this file
 * may not widen that module's surface).
 */
const isGuardChromeText = (t: string): boolean => {
  const lead = t.trimStart();
  return lead.startsWith('[ACTION VERIFIER —') || lead.startsWith('[HARNESS EVIDENCE GUARD —');
};

/** Live-run key for a chat's agent run (namespaced away from coding session ids). */
export function chatRunKey(chatId: string): string {
  return `chat:${chatId}`;
}

/** Live-run key for an ANONYMOUS session's agent run (cm_session cookie identity) —
 *  defined in guest-session-run.ts (the controller's guest-state read needs it
 *  without this module's import graph); re-exported for existing callers. */
export { chatSessionRunKey };

/**
 * The ONE run-key resolver — used by startDetachedChatRun (which returns the
 * key for the caller to subscribe with) and by the controller's active-run
 * pre-guard. Chat runs key on chatId, anonymous runs on the session cookie; a
 * logged-in user without a chat (auto-create failed) gets an ephemeral key,
 * which simply never collides in the active-run guard (and is why the guard
 * only pre-checks when chatId or sessionId exists).
 */
export function chatAgentRunKey(args: { chatId?: string | null; sessionId?: string | null }): string {
  if (args.chatId) return chatRunKey(args.chatId);
  if (args.sessionId) return chatSessionRunKey(args.sessionId);
  return `chat:ephemeral:${randomUUID()}`;
}

/**
 * DETACHED chat run (owner report 2026-07-15): runs used to be tied to the SSE
 * request — iOS backgrounding/locking dropped the stream, the disconnect was
 * treated as a user cancel, and "(Stopped.)" got persisted as the answer. Now
 * the run executes independently and finishes even if every viewer disconnects;
 * the answer persists and is there when the user returns. Cancellation is an
 * EXPLICIT act (cancelRun via the stop endpoint), never an inferred one.
 * Returns the live-run key the run registered under — callers MUST subscribe
 * with THIS key rather than recomputing one (the ephemeral case — logged-in,
 * no chat, no session — mints a fresh uuid key here, so a recomputed key would
 * never match and the SSE response would end with zero events) — or null when
 * a run is already active for this chat/session.
 *
 * Cross-process gate (P5 audit): the local tryStartLiveRun closes the
 * same-process TOCTOU; the Redis claim (chat-busy claimChatLiveRun, SET NX)
 * closes the CROSS-process one — a chat busy on the other blue/green instance
 * now reports null here instead of double-running. Anonymous/session runs stay
 * process-local (no chatId to key the shared state on).
 */
// (2026-09-11's `inflightHumanTurns` map + `requeueInflightHumanTurnsForShutdown`
// were DELETED 2026-09-26 (audit routing-unify-4 / tests-gaps-1): server.ts never
// called them — the SIGTERM deploy-interrupt ritual (shutdown-interrupt.ts)
// subsumed that path, and the dead helper kept being cited as a live mechanism.)

/**
 * The message-origin half of every run classification in this file: a
 * non-'user' origin (schedule / hook / agent / webhook) is a MACHINE run —
 * EXCEPT an owner dispatch (2026-10-01): an agent send a supervisor relayed on
 * the OWNER's own turn, which platform sendChatMessage stamps
 * `ownerDispatch: true` beside the owner anchor (platform/agent-send-header.ts
 * isOwnerDispatchRun). Row
 * provenance (metadata.origin, authorId, human-row counts) keeps reading
 * messageOrigin directly — only RUN classification goes through here.
 */
export function machineOriginRun(args: Pick<ChatAgentRunArgs, 'messageOrigin' | 'ownerDispatch' | 'userTurnAt'>): boolean {
  if (args.messageOrigin == null || args.messageOrigin === 'user') return false;
  return !isOwnerDispatchRun({ origin: args.messageOrigin, ownerDispatch: args.ownerDispatch, userTurnAt: args.userTurnAt });
}

export async function startDetachedChatRun(args: Omit<ChatAgentRunArgs, 'send' | 'isCancelled'>): Promise<string | null> {
  const key = chatAgentRunKey(args);
  const chatId = args.chatId ?? null;
  // Machine-triggered? (F1 preemption gate — owner incident 2026-09-04): the
  // Redis claim carries the marker so ANY instance can tell a replayable
  // machine run (wake/schedule/hook/agent/webhook) from a user-typed one.
  // Undefined origin = a user turn (the interactive stream path sets none).
  const machineTriggered = args.machineWake === true
    || machineOriginRun(args);
  // RETIRING COLOUR (2026-09-18 deploy-replay tax — coding/retiring.ts): the
  // OLD colour of a deploy, once its drain began, starts NO machine run —
  // every caller already treats null as "busy" (hooks park with attempts
  // frozen, schedule firings queue behind the chat, queue drains keep their
  // row for the new colour's orphan sweeper). User turns are never refused
  // here: nginx already routes them to the new colour. Checked BEFORE the
  // local slot is taken so nothing is left to release.
  if (machineTriggered && isRetiring()) {
    logger.info(`chat-agent: retiring colour (since ${retiringSinceIso()}) — not starting machine run for ${chatId ?? 'anonymous'} (origin ${String(args.messageOrigin ?? (args.machineWake ? 'machineWake' : 'unknown'))}); it parks for the new colour`, { source: 'chat-agent' });
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.MACHINE_START_DEFERRED_RETIRING, sessionId: chatId ?? undefined, meta: { origin: String(args.messageOrigin ?? (args.machineWake ? 'machineWake' : 'unknown')) } });
    return null;
  }
  // SUPERVISOR OFF SWITCH backstop (owner 2026-09-26; platform/supervisor-
  // switch.ts): a MACHINE-triggered run on a Fleet / project supervisor chat
  // whose admin switch is OFF never starts — null reads as "busy" to every
  // caller (the agent message stays queued and drains once the switch is back
  // on; hook rows and schedule firings were already terminal-marked upstream).
  // User turns are never refused. Steady state all-ON costs no query.
  if (machineTriggered && chatId) {
    const origin = String(args.messageOrigin ?? (args.machineWake ? 'machineWake' : 'unknown'));
    const off = await supervisorWakeSkipById(chatId, `detached:${origin}`).catch(() => null);
    if (off) {
      logger.info(`chat-agent: ${off} supervisor switch is OFF — not starting machine run for ${chatId} (origin ${origin})`, { source: 'chat-agent' });
      return null;
    }
  }
  if (!tryStartLiveRun(key)) return null;
  // Every write / Stop read of this run goes through a handle on THIS run, never the key (integration review
  // 2026-10-20): a council straggler that outlives the lead must not write into — or be stopped by — the next run
  // a queue drain starts on the same chat.
  const liveRun = bindLiveRun(key);
  if (chatId && !(await claimChatLiveRun(chatId, { machineTriggered }))) {
    endLiveRun(key); // release the local slot — another PROCESS owns this chat
    return null;
  }
  if (chatId) noteChatRunStarted(chatId); // build 2026-10-08 D-1: this chat's submitted delegation tasks are now worked
  if (chatId) {
    // Cross-instance SSE mirror (run-event-mirror.ts): a viewer whose attach
    // lands on the OTHER blue/green instance tails this capped Redis list.
    // DEL first — a new run must never replay the previous run's events — and
    // the DEL is awaited BEFORE the tap is wired so it can't race the run's
    // first mirrored push. The tap only writes to Redis; local subscribers
    // are untouched (no double-send on the local attach path).
    await clearRunEventMirror(chatId);
    setRunEventTap(key, chatRunMirrorTap(chatId));
  }
  // Heartbeat (chat runs only): keeps the Redis liveness key fresh so peer
  // instances see the run, and polls the cross-process stop flag — a Stop
  // pressed against the OTHER instance cancels here, releasing any parked
  // ask_user wait exactly like the local stop endpoint does.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (chatId) {
    heartbeat = setInterval(() => {
      void refreshChatLiveRun(chatId, machineTriggered);
      void takeChatRunStopRequest(chatId).then(async (stop) => {
        if (!stop) return;
        cancelRun(key);
        const { resolvePendingForSession } = await import('../coding/question-registry');
        resolvePendingForSession(chatId);
      }).catch(() => {});
      // ask_user answers arrive cross-process: when the POST lands on the peer
      // web instance, the confirmations endpoint RPUSHes this chat's resolution
      // mailbox — apply each entry to the process-local registry (mirror of
      // run-executor's worker-side drain; chat runs never drained it before, so
      // peer-instance answers were dropped and the wait ran to its timeout).
      void (async () => {
        const { drainResolutions } = await import('../coding/session-run-lock');
        const entries = await drainResolutions(chatId);
        if (!entries.length) return;
        const { applyQuestionResolution } = await import('../coding/question-registry');
        const { applyApprovalResolution } = await import('../coding/approval-registry');
        for (const e of entries) {
          if (e.kind === 'approval') applyApprovalResolution(e.id, e.decision as 'allow' | 'always' | 'deny');
          else applyQuestionResolution(e.id, e.answer);
        }
      })().catch(() => {});
    }, LIVE_RUN_HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  // Guest (anonymous) runs (owner report 2026-09-26 — a reload mid-answer lost
  // the turn): publish liveness cross-process (guest-session-run.ts) so a
  // reloaded guest tab, on EITHER blue/green instance, can tell "still
  // working" from "the run died" via GET /session/:id/state. Heartbeat-
  // refreshed like the chat marker above; cleared in the finally below.
  const guestSessionId = !chatId && args.sessionId ? args.sessionId : null;
  if (guestSessionId) {
    // Stream drops (2026-10-20): mirror the guest run's events under its
    // session too (cm:runevents:session:<sid>, same DEL-then-tap discipline as
    // the chat mirror above) so GET /session/:sessionId/stream can tail it
    // from the OTHER box. GUEST_STREAM_ATTACH_DISABLED=1 ⇒ no guest mirror.
    if (!guestStreamAttachDisabled()) {
      const mirrorId = guestMirrorId(guestSessionId);
      await clearRunEventMirror(mirrorId);
      setRunEventTap(key, chatRunMirrorTap(mirrorId));
    }
    await markGuestSessionRunLive(guestSessionId);
    heartbeat = setInterval(() => { void markGuestSessionRunLive(guestSessionId); }, LIVE_RUN_HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  // Fleet-supervisor durable state (2026-08-22 rebuild — the 2026-08-21
  // amnesia incident): on a MACHINE wake of the supervisor chat, its Postgres
  // state doc is injected right under the freshness preamble (the 12-pair
  // transcript is NOT memory). ANY failure here must leave the run proceeding
  // with just the preamble — never break run start.
  let supervisorStateBlock = '';
  let wakeLedgerAt: string | null = null;
  if (args.machineWake && args.chatId) {
    try {
      const chat = await prisma.crossModelChat.findUnique({
        where: { id: args.chatId },
        select: { isSupervisor: true, isProjectSupervisor: true, userId: true, projectId: true },
      });
      if (chat?.isSupervisor === true || chat?.isProjectSupervisor === true) {
        // [OPEN OWNER ASKS — ANSWER FIRST] (tt-rd audit 2026-09-27 finding 5):
        // unanswered owner status questions ride ABOVE the state doc with an
        // answer-first instruction; kill switch OPEN_OWNER_ASKS_BLOCK_DISABLED=1.
        // fixer 2026-09-27 (finding upward-chatter-1c): the same read also
        // RECONCILES asks a qualifying reply already answered (closeAskOnReply,
        // source 'reconcile') and hands back the ids the [SUPERVISOR STATE]
        // render must omit — the block's own rows (listed once, not twice) and
        // the answered ones (never re-injected for 72 h). Dynamic import +
        // guarded: thin suites mock neither module; a failure leaves the plain
        // state block exactly as before.
        let asksBlock = '';
        let hideAskIds: string[] = [];
        try {
          const asksMod: any = await import('../platform/owner-asks').catch(() => null);
          if (typeof asksMod?.buildOpenOwnerAsksWake === 'function') {
            const wake = await asksMod.buildOpenOwnerAsksWake(args.chatId, { userId: chat.userId });
            asksBlock = String(wake?.block ?? '');
            hideAskIds = Array.isArray(wake?.hideAskIds) ? wake.hideAskIds : [];
          } else if (typeof asksMod?.buildOpenOwnerAsksBlock === 'function') {
            asksBlock = await asksMod.buildOpenOwnerAsksBlock(args.chatId);
          }
        } catch { /* the block is best-effort */ }
        // KPI annotation (tt-rd audit 2026-09-27, finding 2d): the live
        // register value rides any project line that types a KPI rate.
        const kpis = await loadKpisForSupervisorChat({ projectId: chat.isProjectSupervisor ? chat.projectId : null, userId: chat.userId, fleet: chat.isSupervisor === true }).catch(() => []);
        supervisorStateBlock = formatStateForWake(await getSupervisorState(args.chatId), new Date(), { hideAskIds, kpis });
        // [OWNER DIRECTIVES IN FORCE] (OWNER-DIRECTIVE-FANOUT, 2026-10-20;
        // platform/owner-directive-fanout.ts): a PROJECT supervisor's state
        // doc is its OWN ledger only — an owner ruling banked on the Fleet
        // Supervisor's ledger (scope 'fleet' or this project) never reached
        // it. The harness reads every owner-origin row in force across the
        // owner's supervisor ledgers (its own excluded — it renders above)
        // and places them right under the state doc. Fail-open ('' = no
        // block); kill switch OWNER_DIRECTIVE_FANOUT_DISABLED=1.
        if (chat.isProjectSupervisor === true && chat.projectId) {
          try {
            const fan: any = await import('../platform/owner-directive-fanout').catch(() => null);
            if (typeof fan?.buildOwnerDirectivesInForceBlock === 'function') {
              const r = await fan.buildOwnerDirectivesInForceBlock(chat.userId, chat.projectId, { excludeChatId: args.chatId });
              if (r?.block) {
                supervisorStateBlock = [supervisorStateBlock, r.block].filter(Boolean).join('\n\n');
                if (typeof fan.recordOwnerDirectiveDelivered === 'function') fan.recordOwnerDirectiveDelivered({ targetChatId: args.chatId, surface: 'ps_wake', shown: r.shown ?? [], hidden: r.hidden ?? 0 });
              }
            }
          } catch { /* the fan-out block is best-effort */ }
        }
        // [SINCE YOUR LAST WAKE] (audit 2026-10-08 W6-1; platform/supervisor-wake-ledger.ts):
        // the HARNESS diff of the ledger since this supervisor's last completed
        // wake — right under the owner asks, above the state doc. The wake's
        // history is then trimmed to its last few own notes (runChatAgentTurn,
        // wakeLedgerAt). Fail-open (no block, 24-message history); kill switch
        // SUPERVISOR_WAKE_LEDGER_DIFF_DISABLED=1.
        // MIND-HYGIENE: the rendered diff is also the recall query below (what moved, not the constant trigger text).
        let ledgerDiffText = '';
        try {
          const wl: any = await import('../platform/supervisor-wake-ledger').catch(() => null);
          const ledger = typeof wl?.buildWakeLedgerBlock === 'function' ? await wl.buildWakeLedgerBlock(args.chatId) : null;
          if (ledger?.block) {
            supervisorStateBlock = `${ledger.block}\n\n${supervisorStateBlock}`;
            wakeLedgerAt = ledger.at;
            ledgerDiffText = String(ledger.block);
          }
        } catch { /* the diff block is best-effort */ }
        // Ticket a5b36dc6 — [PREEMPTED RUN — ACTION IN FLIGHT]: when a user
        // preemption interrupted this supervisor's previous run (< 2 h ago),
        // render the LIVE tool-intent journal window (unsettled calls may
        // still land) ABOVE everything else, so the wake VERIFIES before
        // claiming actions out or not-out instead of answering "from earlier
        // context" and retracting. Fail-open ('' = no block); kill switch
        // SUPERVISOR_INFLIGHT_PREEMPT_DISABLED=1.
        const inflight = await buildInflightPreemptBlock(args.chatId).catch(() => '');
        if (asksBlock) supervisorStateBlock = `${asksBlock}\n\n${supervisorStateBlock}`;
        if (inflight) supervisorStateBlock = `${inflight}\n\n${supervisorStateBlock}`;
        // ── Supervisor run journal — READ side, machine wakes (ticket
        // 9993f30c, 2026-10-18): this supervisor's own journal — last 10
        // entries under SUPERVISOR_JOURNAL_BLOCK_CAP — right under the
        // state doc, so the wake READS what its earlier turns did (and the
        // receipt ids that back them) instead of recalling it from the
        // dieted transcript. Human-typed turns get the same block via
        // loadChatContextNode. Fail-open: a failed read leaves the composed
        // wake exactly as before; kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1
        // (checked here AND inside the writer).
        try {
          if (process.env.SUPERVISOR_RUN_JOURNAL_DISABLED !== '1') {
            const journalMod: any = await import('../coding/run-journal.service').catch(() => null);
            if (typeof journalMod?.buildSupervisorJournalBlock === 'function') {
              const supervisorJournalBlock = await journalMod.buildSupervisorJournalBlock(args.chatId).catch(() => '');
              if (supervisorJournalBlock) supervisorStateBlock += `\n\n${supervisorJournalBlock}`;
            }
          }
        } catch { /* the journal block is best-effort */ }
        // [INTERVENTION OUTCOMES — 7d] (supervisor SOTA round 2, 2026-10-20;
        // platform/intervention-outcomes.ts): this supervisor's own lane
        // interventions, labelled by the harness 24 h later (progressed /
        // ran, no artifact / no run / repeated / unlabelled) per lever and
        // per lane — rendered only after one week of observation and ≥ 3
        // labels; evidence, never an order. Fail-open ('' = no block, 2.5 s
        // read deadline); kill switches SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1
        // and SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED=1 (read inside).
        try {
          const ioMod: any = await import('../platform/intervention-outcomes').catch(() => null);
          if (typeof ioMod?.buildInterventionOutcomesBlock === 'function') {
            const interventionBlock = await ioMod.buildInterventionOutcomesBlock(args.chatId).catch(() => '');
            if (interventionBlock) supervisorStateBlock += `\n\n${interventionBlock}`;
          }
        } catch { /* the intervention-outcomes block is best-effort */ }
        // Ticket 2b8508cb — [SUPERVISOR STATE (retrieved)]: semantic recall
        // over the embedded doc rows (source `supervisor_state`), so what the
        // 6000-char wake-block trims dropped is still retrievable per turn.
        // The query is the rendered [SINCE YOUR LAST WAKE] diff (MIND-HYGIENE —
        // a stock sweep's trigger text is the same constant prompt every
        // time), falling back to the wake's OWN original message; hits the
        // composed wake already shows are skipped (visibleText). Fail-open
        // ('' = no block); kill switches SUPERVISOR_STATE_RECALL_DISABLED=1
        // (no block) and SUPERVISOR_RECALL_DIFF_QUERY_DISABLED=1 (trigger-text
        // query, no visibility filter).
        try {
          if (process.env.SUPERVISOR_STATE_RECALL_DISABLED !== '1') {
            const memMod: any = await import('../platform/supervisor-state-memory').catch(() => null);
            if (typeof memMod?.buildSupervisorStateRecallBlock === 'function') {
              const hygiene = typeof memMod.supervisorRecallDiffQueryDisabled === 'function' && !memMod.supervisorRecallDiffQueryDisabled()
                && typeof memMod.recallQueryFromLedgerDiff === 'function';
              const recall = hygiene
                // hiddenIds: the asks block renders open asks WITHOUT ids and hideAskIds also names
                // answered-not-closed asks kept out on purpose — never re-surfaced as retrieved directives.
                ? await memMod.buildSupervisorStateRecallBlock(args.chatId, memMod.recallQueryFromLedgerDiff(ledgerDiffText, args.message), 5, { visibleText: supervisorStateBlock, hiddenIds: hideAskIds }).catch(() => '')
                : await memMod.buildSupervisorStateRecallBlock(args.chatId, args.message, 5).catch(() => '');
              if (recall) supervisorStateBlock += `\n\n${recall}`;
            }
          }
        } catch { /* the recall block is best-effort */ }
      }
      if (chat?.isProjectSupervisor === true && chat.projectId) {
        // Per-lane schedule truth (ticket 69d0c808): a PROJECT supervisor gets
        // none of the live fleet blocks below (owner-scoped) — without ground
        // truth it narrated a worker lane's cadence from memory and
        // confabulated schedule ids the delivery guard had to strike
        // pre-delivery. Inject the project's live per-lane schedule table so
        // an "enabled re-arms queued" claim is citable from context — or
        // visibly false at compose time. Same failure posture as the doc load.
        const projectSchedules = await buildProjectScheduleBlock(chat.projectId);
        if (projectSchedules) supervisorStateBlock += `\n\n${projectSchedules}`;
        // [BOARD] (owner 2026-09-16 "inject the board, don't let the model
        // recall it"): the live goal/todo/owner-question ledger, so status and
        // count claims are READ, never recalled — the verifier's board lane
        // strikes a note that contradicts it. Same failure posture.
        const board = await buildBoardDigestBlock({ scope: 'project', projectId: chat.projectId });
        if (board) supervisorStateBlock += `\n\n${board}`;
      }
      if (chat?.isSupervisor === true) {
        // Live drift signals (2026-08-30 fleet audit): the durable doc is the
        // supervisor's own memory and can lag reality — append the live
        // stalled-todo / unstarted-assignment / machine-rewritten-schedule
        // block so every sweep wake sees ground truth the doc never recorded.
        // Fleet-scoped (per-owner, every project): the FLEET supervisor only —
        // a project supervisor's drift signals are its own project's, read live.
        const attention = await buildFleetAttentionBlock(chat.userId);
        if (attention) supervisorStateBlock += `\n\n${attention}`;
        // Fleet liveness (remediation P7, spark G4): the BASELINE per-project
        // heartbeat table (enabled schedules · last firing age · live runs) —
        // the attention block lists exceptions, this makes a silently deaf
        // project visible as exactly that. Same failure posture.
        const liveness = await buildFleetLivenessBlock(chat.userId);
        if (liveness) supervisorStateBlock += `\n\n${liveness}`;
        // Fleet [BOARD] roll-up (owner 2026-09-16): per-project goal/todo/
        // owner-question counts + every open owner question account-wide.
        const board = await buildBoardDigestBlock({ scope: 'fleet', userId: chat.userId });
        if (board) supervisorStateBlock += `\n\n${board}`;
      }
      // LANE BOARD (ticket 2c203dac): a NON-supervisor machine wake gets the
      // same read-don't-recall contract for the rows it is accountable for —
      // owner questions linked to it (filed by it / gating it via forChatId)
      // and todos assigned to it. The mishap: this lane's machine wake had no
      // live ledger at all, so it recalled three owner questions as "sit open"
      // four days after the owner answered them, and the verifier's
      // board-assertion lane struck the note (mishap 2c203dac). The
      // supervisor block above stays supervisor-only (a supervisor's own
      // [BOARD] already covers its rows); this is the LANE surface,
      // deliberately narrow (no goals/counts). Same failure posture (a failed
      // read leaves the plain preamble); kill switch LANE_BOARD_BLOCK_DISABLED=1.
      if (
        chat?.isSupervisor !== true
        && chat?.isProjectSupervisor !== true
        && process.env.LANE_BOARD_BLOCK_DISABLED !== '1'
      ) {
        const laneBoard = await buildLaneBoardBlock(args.chatId).catch(() => '');
        if (laneBoard) supervisorStateBlock = supervisorStateBlock ? `${supervisorStateBlock}\n\n${laneBoard}` : laneBoard;
      }
    } catch (err: any) {
      logger.warn(`chat-agent: supervisor state load failed for ${args.chatId}: ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // Machine-triggered runs (schedule firings / hook wakes) get the freshness
  // preamble baked into the persisted prompt — visible in the transcript, which
  // makes later debugging of a wake's behavior possible (postmortem 2026-08-11).
  // The PRE-PREAMBLE message is captured alongside (machineWakeOriginalMessage
  // → persisted metadata.machineMessage) so the orphan sweeper can re-fire a
  // dead wake down this same path with a FRESH preamble (ticket bb2eca92).
  if (args.machineWake) args = { ...args, machineWakeOriginalMessage: args.message, message: machineWakePreamble() + (supervisorStateBlock ? `\n${supervisorStateBlock}\n` : '') + args.message, ...(wakeLedgerAt ? { wakeLedgerAt } : {}) };
  void (async () => {
    try {
      await runChatAgentTurn({
        ...args,
        send: (type, data) => liveRun.push(type, data),
        isCancelled: () => liveRun.isCancelled(),
      });
    } catch (err: any) {
      logger.error(`chat-agent detached run failed for ${args.chatId}: ${err.message}`, { source: 'chat-agent' });
      // A seat-config problem is the USER's to fix — surface the specific
      // message (which seat, which key, where to assign a model) instead of
      // the generic retry line that hides it (owner report 2026-09-04).
      liveRun.push('error', {
        message: err instanceof SeatUnservableError
          ? err.message
          : 'The agent engine hit an error — please try again.',
      });
      // Turn continuation (2026-09-28): a thrown round never reached its
      // finalize — flip the task card to failed with the honest line so the
      // owner is never left with a card that says "running" forever.
      if (args.chatId && args.continuation) {
        const c = args.continuation;
        const failedChatId = args.chatId;
        void (async () => {
          const payload = buildTaskEvent({ taskId: c.taskId, chatId: failedChatId, kind: 'continuation', status: 'failed', title: CONTINUATION_TASK_TITLE, startedAt: c.startedAt, note: CONTINUATION_FAILED_LINE });
          await persistTaskCard(failedChatId, payload, { messageId: c.ofMessageId });
          emitTaskEvent(failedChatId, payload);
          const failedRow: any = await prisma.crossModelMessage.create({ data: { chatId: failedChatId, role: 'assistant', content: CONTINUATION_FAILED_LINE, metadata: { kind: CONTINUATION_RESULT_KIND, continuation: { taskId: c.taskId, round: c.round, maxRounds: c.maxRounds, ofMessageId: c.ofMessageId, reason: c.reason }, failed: true } } }).catch(() => null);
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.TURN_CONTINUATION, sessionId: failedChatId, meta: { chatId: failedChatId, taskId: c.taskId, round: c.round, reason: c.reason, outcome: 'failed', ...(c.answerFirst ? { answerFirst: true, resumes: c.answerFirst.resumes ?? 0 } : {}) } });
          // build 2026-10-08 A1: an answer-first follow-through that failed still closes the owner ask it carried.
          if (c.answerFirst && c.askMessageId && args.userId) {
            await closeAskOnReply(failedChatId, args.userId, { askMessageId: c.askMessageId, replyMessageId: typeof failedRow?.id === 'string' ? failedRow.id : c.ofMessageId, source: 'continuation' }).catch(() => false);
          }
        })().catch(() => {});
      }
      // Fleet supervisor (§3): a thrown turn never reached its own finalize —
      // emit run_failed here (then clear the wake-depth stamp, same as the
      // success path). Fire-and-forget; anonymous runs have no hooks.
      if (args.chatId) {
        const failedChatId = args.chatId;
        void import('../platform/hooks.service')
          .then(async (m) => {
            await m.emitHookEventSafe(failedChatId, 'run_failed', frontLoadRunOutcome(`Chat run failed: ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`, { outcome: 'failed' }));
            await m.clearHookDepth(failedChatId);
          })
          .catch(() => {});
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      endLiveRun(key);
      // Release the cross-process claim BEFORE draining — the drain's fresh
      // start must be able to re-claim it.
      if (chatId) await releaseChatLiveRun(chatId);
      if (guestSessionId) await clearGuestSessionRunLive(guestSessionId);
      // Busy-chat queue (2026-08-07): messages enqueued while THIS run was
      // active (pending_chat_messages) start automatically — THE immediate
      // run-finalize drain (F2b): it fires the moment the run ends, so queued
      // messages never wait for the sweep tick. The drain starts USER-origin
      // rows first (F2a priority — message-queue.service peekOldest), then
      // machine rows FIFO; that run's own finally then drains the next
      // (natural chain). Fire-and-forget: a drain failure must never break the
      // finishing run, and anonymous/ephemeral runs have no queue to drain.
      // Covers the fleet supervisor chat too: it is a plain detached chat, so
      // its queued /fleet/supervisor/messages sends drain through this path.
      if (args.chatId && args.userId) {
        const { chatId, userId } = args;
        void (async () => {
          // Instant hooks (owner 2026-09-14) + FAIRNESS: a chat whose oldest
          // pending hook row has waited past HOOK_STARVATION_MS drains HOOKS
          // first (one digest wake) — with lane report-ups queued every few
          // minutes the fleet chat's message queue was never empty and its
          // hook backlog (36 rows) starved for hours. That hook wake's own
          // finalize drains the message queue next, so the two backlogs
          // alternate. Otherwise: queue first; nothing queued → hook drain.
          // The hooks module is optional here (tests mock it partially; a
          // load failure must never cost the queue drain): every access is
          // guarded and the queue drain is the invariant.
          // Schedule priority (autonomy loop #4, 2026-09-19; #10 2026-09-20):
          // when one of this chat's recurring schedules has been busy-skipped
          // ≥ 10 times (the Fleet Supervisor's sweep sat at 98 — ~5 h without
          // a full sweep while hook wakes chained through this very drain),
          // pull it to now and FIRE IT HERE through the sweep's own row pass,
          // then yield ONCE: leave the queue/hook backlog for the sweep run's
          // own finalize. (#4 only pulled it forward for the next sweeper tick
          // and lost 3 of 4 slots to message wakes that found the idle chat
          // first.) A schedule that cannot fire now → no yield, normal drain.
          //
          // Retiring-colour HAND-OFF (autonomy loop #11, 2026-09-20): on the
          // retiring colour every drain below is a silent no-op — the direct
          // fire reports 'retiring', sweepHookEvents returns before the DB,
          // startDetachedChatRun refuses machine starts — so the chat went
          // idle with its backlog untouched and the next direct send took the
          // window (live 11:51Z: 8 hook rows then waited another 22 min).
          // Hand the backlog to the NEW colour explicitly: un-park the chat's
          // busy-parked hook rows (its sweeper delivers them on its next 30 s
          // tick), pull a starved schedule forward (its sweeper fires it), and
          // leave queued messages to the orphan sweeper. Nothing starts here.
          if (isRetiring()) {
            const hooksMod: any = await import('../platform/hooks.service').catch(() => null);
            const unparked = typeof hooksMod?.unparkHookEventsForTarget === 'function'
              ? Number(await Promise.resolve(hooksMod.unparkHookEventsForTarget(chatId)).catch(() => 0)) || 0
              : 0;
            try {
              const { claimStarvedScheduleSlot } = await import('../coding/schedule-priority');
              await claimStarvedScheduleSlot(chatId); // pull-forward only — its direct fire reports 'retiring'
            } catch { /* best-effort */ }
            logger.info(`chat-agent: finalize for ${chatId.slice(0, 8)} ran on the RETIRING colour — drains handed to the new colour (${unparked} parked hook row(s) released)`, { source: 'chat-agent' });
            recordLoopMetric({ kind: LOOP_METRIC_KINDS.FINALIZE_HANDOFF, sessionId: chatId, value: unparked, meta: { unparked } });
            return;
          }
          try {
            const { claimStarvedScheduleSlot } = await import('../coding/schedule-priority');
            if (await claimStarvedScheduleSlot(chatId)) return;
          } catch { /* priority is best-effort — the drain below is the invariant */ }
          const hooks: any = await import('../platform/hooks.service').catch(() => null);
          const drainHooks = () => { try { hooks?.drainHookEventsForTarget?.(chatId); } catch { /* never blocks the queue */ } };
          // QUEUE FAIRNESS (autonomy loop #15, 2026-09-21): hooks-first used to
          // key on the hook backlog's age ALONE, and under steady lane traffic
          // a ≥ 5-min-old hook row is always waiting at a wake's finalize — the
          // promised alternation never happened and the Fleet Supervisor's
          // queue held 20 rows for 3.8 h (8 more sends lost as "queue full").
          // Compare heads: hooks go first only when their oldest deliverable
          // row has waited at least as long as the queue's oldest row; a
          // waiting USER row always drains first. See hooks.service
          // hooksFirstVerdict. Partial mocks / an unavailable head fall back
          // to the pre-#15 raw-age rule.
          let starving = false;
          let verdictAges = { hookAgeMs: 0, queueHeadAgeMs: 0 };
          try {
            let head: { createdAt: Date; source: string } | null = null;
            try {
              const mq = await import('./message-queue.service');
              head = typeof mq.oldestPendingHead === 'function' ? await mq.oldestPendingHead(chatId).catch(() => null) : null;
            } catch { head = null; }
            const queueHead = { ageMs: head ? Math.max(0, Date.now() - new Date(head.createdAt).getTime()) : 0, source: head?.source ?? null };
            if (typeof hooks?.hooksFirstVerdict === 'function') {
              // No 'stuck' cap here (loop #17): the finalize AWAITS the wake below and
              // falls through to the queue when nothing starts, so an old deliverable
              // backlog cannot starve the queue — the cap stays on the idle-window entrants.
              const v = await hooks.hooksFirstVerdict(chatId, queueHead, new Date(), { capMs: Number.POSITIVE_INFINITY });
              starving = !!v?.hooksFirst;
              verdictAges = { hookAgeMs: Number(v?.hookAgeMs) || 0, queueHeadAgeMs: queueHead.ageMs };
              if (head && (v?.reason === 'queue_older' || v?.reason === 'user_waiting')) {
                recordLoopMetric({ kind: LOOP_METRIC_KINDS.QUEUE_FAIRNESS_PREEMPT, sessionId: chatId, value: queueHead.ageMs, meta: { entrant: 'finalize', reason: v.reason, hookAgeMs: v.hookAgeMs, queueHeadAgeMs: queueHead.ageMs, source: queueHead.source } });
              }
            } else {
              const threshold = typeof hooks?.HOOK_STARVATION_MS === 'number' ? hooks.HOOK_STARVATION_MS : Number.POSITIVE_INFINITY;
              const age = typeof hooks?.oldestPendingHookAgeMs === 'function' ? await hooks.oldestPendingHookAgeMs(chatId) : 0;
              starving = Number(age) >= threshold;
            }
          } catch { starving = false; }
          if (starving) {
            // AWAIT the hook wake (loop #17): the fire-and-forget kick let the enqueue
            // nudge / orphan sweeper take the idle window with a queue drain first, and
            // the wake then parked as 'busy' — the Fleet Supervisor delivered 2 of 8
            // hook events in 4 h. Bounded wait; a legacy partial mock keeps the kick.
            let wakeStarted = false;
            if (typeof hooks?.drainHookEventsForTargetNow === 'function') {
              let timer: NodeJS.Timeout | null = null;
              try {
                wakeStarted = await Promise.race([
                  Promise.resolve(hooks.drainHookEventsForTargetNow(chatId)).then((r: unknown) => !!r).catch(() => false),
                  new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), HOOKS_FIRST_AWAIT_MS); }),
                ]);
              } finally { if (timer) clearTimeout(timer); }
            } else { drainHooks(); wakeStarted = true; }
            recordLoopMetric({ kind: LOOP_METRIC_KINDS.FINALIZE_HOOKS_FIRST, sessionId: chatId, value: verdictAges.hookAgeMs, meta: { ...verdictAges, wakeStarted } });
            if (wakeStarted) return;
            // Nothing could start (cap / depth / undeliverable / retiring) — the queue proceeds.
          }
          const started = await drainChatQueue(chatId, userId);
          if (!started) drainHooks();
        })().catch(err => logger.warn(`chat-agent: finalize drain failed for ${chatId}: ${err?.message ?? err}`, { source: 'chat-agent' }));
      }
    }
  })();
  return key;
}

/** Upper bound on the finalize's awaited hooks-first wake start (loop #17) — the sweep is DB work + a detached start. */
const HOOKS_FIRST_AWAIT_MS = 20_000;

/** Modes a queued message may carry into a fresh run (anything else → L1). */
const QUEUED_RUN_MODES = new Set(['single_thinking', 'thinking', 'deep_research', 'deep_research_all']);

/**
 * Busy-chat queue drain — start the OLDEST pending message as a normal
 * detached run when the chat is idle. ONE message per drain: the newly
 * started run's own finally re-invokes this, unrolling the queue FIFO.
 *
 * Never throws (the finally call site catches; defensive for direct callers).
 * 'user' SSE arrivals run as a normal user message; 'agent' tool sends drain
 * with their stashed fleet origin (messageOrigin 'agent' + sourceChatId) and
 * re-stamp the sender's hook wake-depth onto this chat (loop bound — see
 * hooks.service). The drained run is deliberately UNANCHORED (no userTurnAt):
 * the sender typed their message DURING another run — possibly before that
 * run surfaced a confirmation prompt — so it must not launder into a
 * user-anchored turn for pending-confirmation purposes
 * (platform/pending-confirmations.ts).
 *
 * Deletion happens only AFTER a successful start: losing the start race
 * (another drain/first-run won the key between the idle check and
 * tryStartLiveRun) leaves the row in place for the winner's finally to
 * retry — peek → start → delete is the safe order. Cross-process races are
 * closed by startDetachedChatRun's atomic Redis claim (chat-busy), so a
 * drain on instance A can never double-start against a run on instance B.
 */
type PendingSendOriginLike = Awaited<ReturnType<typeof readPendingOrigin>>;

/**
 * REPORT-UP ACK-ONLY DRAIN (OPT-IN — tt-rd audit 2026-09-27, finding
 * upward-chatter-2; platform/report-up.ts). Deterministic + cheap: when every
 * queued row of the batch is an AGENT send whose SOURCE is a project
 * supervisor, the TARGET is the Fleet Supervisor, no user row waits behind the
 * batch, and no body carries an ask or a goal state change, persist the bodies
 * as one agent-origin user row plus the harness ack row, delete the pending
 * rows, record `report_up_ack_only`, and answer true — no model turn starts.
 * Default OFF (REPORT_UP_ACK_ONLY_DRAIN=1 enables; unsetting it is the kill
 * switch). Any error / any unmet condition answers false — the drain proceeds
 * exactly as before. The ack row's origin is NOT a supervisor-note origin, so
 * the watchdog's stuck-note backstop and follow-through never score it.
 */
async function ackOnlyReportUpDrain(input: {
  chatId: string;
  userId: string;
  batchRows: Array<{ id: string; content: string; userId?: string; createdAt?: Date }>;
  batchOrigins: Array<PendingSendOriginLike | null>;
}): Promise<boolean> {
  try {
    const ru: any = await import('../platform/report-up').catch(() => null);
    if (!ru || typeof ru.reportUpAckOnlyDrainEnabled !== 'function' || !ru.reportUpAckOnlyDrainEnabled()) return false;
    const { chatId, userId, batchRows, batchOrigins } = input;
    if (!batchRows.length || batchRows.length !== batchOrigins.length) return false;
    const sourceIds: string[] = [];
    for (const o of batchOrigins) {
      if (!o || o.kind !== 'agent' || !o.sourceChatId) return false;
      sourceIds.push(o.sourceChatId);
    }
    const bodies = batchRows.map((r) => String(r.content ?? ''));
    if (!ru.batchIsStatusOnly(bodies)) return false;
    const target = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true } });
    if (target?.isSupervisor !== true) return false;
    const distinctSources = [...new Set(sourceIds)];
    const sources = await prisma.crossModelChat.findMany({ where: { id: { in: distinctSources }, userId }, select: { id: true, isProjectSupervisor: true } });
    if (sources.length !== distinctSources.length || sources.some((c) => c.isProjectSupervisor !== true)) return false;
    // Humans preempt machine traffic — a waiting user row means the chat is about to run anyway.
    const usersWaiting = await prisma.pendingChatMessage.count({ where: { chatId, source: 'user' } });
    if (usersWaiting > 0) return false;
    const chars = bodies.reduce((n, b) => n + b.length, 0);
    const content = `[${batchRows.length} status-only report-up(s) from project supervisor(s) ${distinctSources.map((id) => id.slice(0, 8)).join(', ')} — acked by the harness, no turn started]\n\n${bodies.map((b) => b.trim()).join('\n\n— — —\n\n')}`;
    await prisma.crossModelMessage.create({
      data: { chatId, role: 'user', content, metadata: { origin: 'agent', sourceChatId: distinctSources[0], ackOnly: true, batch: batchRows.length } },
    });
    await prisma.crossModelMessage.create({
      data: { chatId, role: 'assistant', content: ru.REPORT_UP_ACK_NOTE, metadata: { origin: ru.REPORT_UP_ACK_ORIGIN, kind: 'report_up_ack', sources: distinctSources.map((id) => id.slice(0, 8)), batch: batchRows.length } },
    });
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    for (const row of batchRows) {
      await deletePending(row.id).catch((err: any) => logger.error(`chat-agent: acked row ${row.id} for ${chatId} failed to delete (message may re-run): ${err?.message ?? err}`, { source: 'chat-agent' }));
    }
    recordLoopMetric({ kind: 'report_up_ack_only', sessionId: chatId, value: batchRows.length, meta: { chatId, sources: distinctSources.map((id) => id.slice(0, 8)), chars } });
    logger.info(`chat-agent: acked ${batchRows.length} status-only report-up(s) for ${chatId.slice(0, 8)} without a turn (REPORT_UP_ACK_ONLY_DRAIN)`, { source: 'chat-agent' });
    return true;
  } catch (err: any) {
    logger.warn(`chat-agent: ack-only drain check failed (draining normally): ${err?.message ?? err}`, { source: 'chat-agent' });
    return false;
  }
}

export async function drainChatQueue(chatId: string, userId: string): Promise<boolean> {
  try {
    if (await isChatBusy(chatId)) return false; // a run owns the chat — ITS finally drains
    let pending = await peekOldest(chatId);
    if (!pending) return false;
    // MERGE-1 kill-window fix (2026-11-05): consume-at-persist means a persist
    // that keeps failing leaves its row queued for redelivery — correct for a
    // transient fault, but the finished run's own finally would re-drain it
    // immediately, turning recovery into a tight retry loop. The bound is
    // enforced at the RUN-START point below (see RUN-START BOUND), not here:
    // counting a drain ENTRY would also charge the drop paths (superseded /
    // cancel-class / ack-only), which make real progress by terminating a row
    // — bounding those would strand a row that should be dropped.
    // Fleet origin + wake-depth stashed at enqueue (message-queue.service): a
    // queued AGENT send must drain MARKED (metadata.origin — otherwise it
    // renders as an interactive human turn in the fleet views) and must carry
    // the sender's hook depth onto this chat, or the MAX_HOOK_DEPTH ladder
    // resets to 0 through every busy-chat hop. Read-only here — deletePending
    // below clears the stash with the row.
    let origin = await readPendingOrigin(pending.id);
    // Cancel-wins for queued ONCE-schedule firings (ticket 3405e332): a
    // one-shot firing enqueued behind a busy run must NOT deliver after its
    // schedule was cancelled or deleted — the drain-time mirror of
    // run-executor's claim-time stale-firing guard. DROP only on certainty:
    // row gone, or a cancel-class lastStatus ('cancelled'/'skipped:cancelled').
    // A consumed firing (enabled:false lastStatus 'started'), an expired row,
    // an enabled row, a lost stash (no scheduleId) and a read ERROR all
    // deliver — uncertainty never drops a real firing. Bounded (5 drops):
    // each dropped row re-peeks; a non-schedule row ends the loop untouched;
    // an exhausted bound leaves the rest queued for the next drain.
    let dropBoundHit = false;
    for (let drops = 0; pending && (pending.source === 'schedule' || origin?.kind === 'schedule'); ) {
      const schedId = origin?.kind === 'schedule' ? origin.scheduleId : undefined;
      let drop = false;
      if (schedId) {
        const sched = await prisma.chatSchedule
          .findUnique({ where: { id: schedId }, select: { lastStatus: true } })
          .catch(() => undefined);
        // 'parked:dormant' (ticket b1d435fd goal-gate) is cancel-class: the
        // auto-park is the durable stop for a dormant project's heartbeat.
        drop = sched === null || (sched != null && (sched.lastStatus === 'cancelled' || sched.lastStatus === 'skipped:cancelled' || sched.lastStatus === 'parked:dormant'));
      }
      if (!drop) break;
      if (++drops > 5) { dropBoundHit = true; break; }
      logger.info(`chat-agent: dropping queued schedule firing ${pending.id} for ${chatId} — schedule ${schedId} was cancelled/deleted after queueing`, { source: 'chat-agent' });
      await deletePending(pending.id).catch(() => {});
      pending = await peekOldest(chatId);
      origin = pending ? await readPendingOrigin(pending.id) : null;
    }
    if (!pending || dropBoundHit) return false;
    // TURN CONTINUATION rows (cohesive-chat wave 2026-09-28; review fixes 4 + 5).
    // The stash is best-effort Redis: a continuation row whose stash is gone
    // must still drain as a CONTINUATION — rebuilt from the marker the prompt
    // carries — never as a machine wake of a plain user chat (wake preamble,
    // origin-stamped reply, a card left "running"). A marker with no fields
    // (pre-fix rows) settles the newest running card as failed and drops the
    // row. A user message typed since the task started (a transcript row newer
    // than the stash, or a user row waiting in this queue) supersedes the
    // round: the row is dropped and the card reads waiting_user with the
    // superseded line — the user's own turn owns the ask now.
    let continuation: ContinuationRun | null = null;
    if (pending.source === 'schedule' && isContinuationPrompt(pending.content)) {
      continuation = origin?.kind === 'schedule' && origin.continuation
        ? origin.continuation
        : recoverContinuationFromPrompt(pending.content, { startedAt: new Date(pending.createdAt) });
      if (!continuation) {
        await deletePending(pending.id).catch(() => {});
        const settledTaskId = await settleLostContinuation(chatId);
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.TURN_CONTINUATION, sessionId: chatId, meta: { chatId, taskId: settledTaskId, round: parseContinuationRound(pending.content)?.round ?? null, reason: 'unknown', outcome: 'stash_lost' } });
        logger.warn(`chat-agent: continuation row ${pending.id} for ${chatId.slice(0, 8)} lost its stash and carries no recoverable marker — dropped, card settled (${settledTaskId ? settledTaskId.slice(0, 8) : 'none found'})`, { source: 'chat-agent' });
        return drainChatQueue(chatId, userId);
      }
      // build 2026-10-08 A1: an answer-first follow-through (a supervisor chat's) is never DROPPED for a newer owner
      // message — it runs after it; a round an owner message preempted waits out the hold so that turn starts first.
      if (continuation.answerFirst) {
        const holdMs = await followThroughHoldMs(chatId);
        if (holdMs > 0) {
          nudgeQueueDrainSoon(chatId, userId, [holdMs + 1_000]);
          logger.info(`chat-agent: answer-first follow-through for ${chatId.slice(0, 8)} held ${Math.round(holdMs / 1000)}s — the preempting owner turn starts first`, { source: 'chat-agent' });
          return false;
        }
      }
      if (!continuation.answerFirst) {
        const superseded = await continuationSupersededByUser(chatId, new Date(continuation.startedAt)).catch(() => null);
        if (superseded) {
          await deletePending(pending.id).catch(() => {});
          await settleContinuationCard(chatId, continuation, 'waiting_user', CONTINUATION_SUPERSEDED_LINE);
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.TURN_CONTINUATION, sessionId: chatId, meta: { chatId, taskId: continuation.taskId, round: continuation.round, reason: continuation.reason, outcome: 'superseded', supersededBy: superseded.kind } });
          logger.info(`chat-agent: continuation round ${continuation.round} for ${chatId.slice(0, 8)} superseded by a newer user message (${superseded.kind}) — dropped`, { source: 'chat-agent' });
          return drainChatQueue(chatId, userId);
        }
      }
    }
    // Hook-starvation YIELD (autonomy loop #11, 2026-09-20): a MACHINE row
    // (agent / webhook / schedule) never jumps a starving hook backlog. The
    // finalize's hooks-first check never reaches this function when hooks
    // starve, but the enqueue nudge and the orphan sweeper call it directly —
    // and did start queued agent steers on an idle chat while its hook rows
    // waited 27+ min. Kick the hook digest instead; ITS finalize drains this
    // queue next. User rows keep priority (humans preempt machine traffic).
    // hooks.service is optional here (partial mocks) — no helper, no yield.
    // A continuation round is the human's own ask being finished — it keeps a
    // user row's priority over machine traffic and never yields.
    if (pending.source !== 'user' && !continuation) {
      const hooksMod: any = await import('../platform/hooks.service').catch(() => null);
      // Loop #15: state this row's own wait so a long-queued machine row is
      // not held behind a hook backlog younger than itself (fairness).
      const queueHead = { ageMs: Math.max(0, Date.now() - new Date(pending.createdAt).getTime()), source: pending.source };
      const starving = typeof hooksMod?.hookBacklogStarving === 'function'
        ? await Promise.resolve(hooksMod.hookBacklogStarving(chatId, undefined, queueHead)).catch(() => false)
        : false;
      if (starving) {
        try { hooksMod?.drainHookEventsForTarget?.(chatId); } catch { /* the kick is best-effort */ }
        logger.info(`chat-agent: queue drain for ${chatId.slice(0, 8)} yields to a starving hook backlog — hook digest kicked; the queued ${pending.source} message runs after that wake`, { source: 'chat-agent' });
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.HOOK_STARVATION_YIELD, sessionId: chatId, meta: { entrant: 'queue_drain', source: pending.source } });
        return false;
      }
    }
    // Coalesced report-up digest (owner 2026-09-14): when the oldest row is an
    // AGENT send with no staged uploads, every consecutive upload-free agent
    // row queued behind it rides the SAME turn — the Fleet Supervisor was
    // spending a full kimi run per one-paragraph lane report-up (24 of its 50
    // turns in 3 h). Each row keeps its own [AGENT-SENT MESSAGE …] provenance
    // header (or gets a minimal one from its stash); the turn carries the
    // FIRST row's origin and the MAX stashed depth. User rows never batch.
    let batchRows: typeof pending[] = [pending];
    let batchOrigins: Array<PendingSendOriginLike | null> = [origin];
    const pendingUploads = Array.isArray(pending.uploadIds) ? (pending.uploadIds as unknown[]).filter((x) => typeof x === 'string' && (x as string).length > 0) : [];
    if (pending.source === 'agent' && !pendingUploads.length) {
      const { peekOldestAgentBatch } = await import('./message-queue.service');
      const batch = await peekOldestAgentBatch(chatId).catch(() => [] as typeof pending[]);
      if (batch.length > 1 && batch[0]?.id === pending.id) {
        batchRows = batch;
        batchOrigins = await Promise.all(batch.map((r, i) => (i === 0 ? Promise.resolve(origin) : readPendingOrigin(r.id))));
        origin = batchOrigins.find((o) => o?.kind === 'agent') ?? origin;
      }
    }
    // Supersession marker (ticket c6db9c72, 2026-09-16): a queued agent steer
    // can be DELIVERED long after its source chat moved on — the owner may
    // have ruled there after the steer was queued, and a receiver ruling on
    // the cold copy inverts the owner's call (the fleet incident: spark's
    // stand-down steer delivered at 23:01Z with the owner's 22:42Z ruling
    // unread in the source chat → an inverted single-executor ruling + ~18
    // min of stalled work). Check each distinct source chat for owner-authored
    // rows NEWER than the row's enqueue time and annotate the delivered copy —
    // advisory, never a drop. USER/webhook rows and stash-less rows are never
    // checked; a lookup hiccup delivers unannotated (marker is best-effort).
    let supersededNotes: Array<string | null> = batchRows.map(() => null);
    try {
      const newestOwner = await latestOwnerRowsAfter(
        batchRows.map((r, i) => ({
          sourceChatId: batchOrigins[i]?.kind === 'agent' ? batchOrigins[i]?.sourceChatId : undefined,
          since: r.createdAt,
        })),
      );
      supersededNotes = batchRows.map((r, i) => {
        const src = batchOrigins[i]?.kind === 'agent' ? batchOrigins[i]?.sourceChatId : undefined;
        const ownerAt = src ? newestOwner.get(src) : null;
        return src && ownerAt && ownerAt > r.createdAt
          ? buildSupersededSteerNote(src, ownerAt, r.createdAt)
          : null;
      });
    } catch { /* the marker is advisory — delivery must never fail on it */ }
    // REPORT-UP ACK-ONLY DRAIN (OPT-IN, tt-rd audit 2026-09-27 finding
    // upward-chatter-2; platform/report-up.ts): when EVERY batched row is an
    // agent send from a PROJECT SUPERVISOR into the FLEET SUPERVISOR, none
    // carries an ask or a goal state change, and no user row waits behind the
    // batch, the harness ACKS the batch (transcript rows + telemetry) instead
    // of starting a full Fleet Supervisor reasoning turn. Default OFF —
    // REPORT_UP_ACK_ONLY_DRAIN=1 enables after a week of `report_up`
    // telemetry; unsetting it is the kill switch. Fail-open to the normal drain.
    if (pending.source === 'agent' && await ackOnlyReportUpDrain({ chatId, userId, batchRows, batchOrigins })) {
      return drainChatQueue(chatId, userId); // the next queued row (if any) drains on this same chain
    }
    // DECISION GATE — DRAIN TRIAGE (N6, 2026-09-25; platform/drain-triage.ts).
    // A queued AGENT batch is put to the decision seat over a code-computed
    // state (row count / senders / ages / question-or-request / sender-awaits-
    // reply / failure cues / superseded markers / open directives / user rows
    // waiting) BEFORE the detached turn. SHADOW (default): nothing changes —
    // the stash rides ChatAgentRunArgs.decision and the run's finalize labels
    // it from what the drained turn did. ACT (designed, not enabled): a
    // confidently quiet batch is PARKED for one bounded defer window (Redis
    // marker = the hook triagedAt/retryAt idiom; the orphan sweeper re-drains
    // it; never re-triaged; never when a USER row waits behind it). User /
    // webhook / schedule rows never enter the gate. Fails open to the drain.
    let drainStash: DecisionStash | null = null;
    // DECISION GATE — SUPERVISOR TURN PRE-TRIAGE (agent-decisions 2026-09-27;
    // platform/supervisor-turn-noop.ts, drain origin): the queued AGENT batch is
    // judged over the TARGET's own record (7-day no-op / action rates,
    // consecutive no-ops, last action, last notes, board counts) with the batch
    // bodies as the pending inputs. SHADOW (default): nothing changes — the
    // stash rides the run beside drain_triage's. ACT (designed, admitted by the
    // readiness ruler only): a confidently quiet batch with no new input / no
    // alarm / no user row waiting is PARKED (Redis marker; the orphan sweeper
    // re-drains it after the defer window; the heartbeat floor bounds the
    // consecutive parks). Fails open to the drain. Once supervisor_turn_noop is
    // in ACT it REPLACES drain_triage at this site (one act consumer per batch);
    // while shadow both ask and both stashes ride the turn (DecisionStash.also).
    // Fixer 2026-09-27: the two asks run CONCURRENTLY under the drain triage's
    // wall clock (turn-noop facts 1.5 s + decide 4 s inside snapshot 3 s + decide
    // 4 s) — the shadow ask adds no serial latency before an agent batch drains,
    // and its Redis / facts reads run only when the purpose is consulted at all.
    let turnNoopStash: DecisionStash | null = null;
    if (pending.source === 'agent') {
      const tn = await import('../platform/supervisor-turn-noop').catch(() => null);
      let turnNoopGoverns = false;
      let askTurnNoop = false;
      try {
        turnNoopGoverns = tn ? tn.supervisorTurnNoopActive() : false;
        askTurnNoop = tn ? tn.supervisorTurnNoopConsulted() : false;
      } catch { turnNoopGoverns = false; askTurnNoop = false; }
      const tnAsk = tn && askTurnNoop ? tn : null;
      const drainAsk = turnNoopGoverns
        ? Promise.resolve(null)
        : import('../platform/drain-triage')
            .then((dt) => dt.preTriageDrainBatch({ chatId, rows: batchRows, origins: batchOrigins, supersededNotes }))
            .catch(() => null); // fail open — the drain proceeds exactly as before
      const turnAsk = tnAsk
        ? (async () => {
            const inputs = await Promise.all(batchRows.map(async (r, i) => {
              const text = String(r.content ?? '');
              return {
                id: r.id, eventType: 'agent_message', sourceChatId: batchOrigins[i]?.kind === 'agent' ? batchOrigins[i]?.sourceChatId : undefined,
                text, depth: batchOrigins[i]?.depth, createdAt: r.createdAt,
                alarm: await tnAsk.pendingInputIsAlarm('agent_message', null, text),
              };
            }));
            return tnAsk.preTriageSupervisorTurn({ origin: 'drain', chatId, pending: inputs });
          })().catch(() => null) // fail open
        : Promise.resolve(null);
      const [drainTriage, turnTriage] = await Promise.all([drainAsk, turnAsk]);
      if (drainTriage?.parked) {
        logger.info(`chat-agent: drain triage parked ${batchRows.length} queued agent row(s) for ${chatId.slice(0, 8)} (${drainTriage.parked.disposition} ${drainTriage.parked.p}) until ${new Date(drainTriage.parked.until).toISOString()} — they drain on their own after the park`, { source: 'chat-agent' });
        // The concurrent turn-noop ask (shadow) never started a turn — close it unlabelled so it still pairs.
        try { tn?.closeUnstartedTurnNoop(turnTriage?.stash ?? null, chatId, 'drain_triage parked'); } catch { /* telemetry never blocks a drain */ }
        return false;
      }
      drainStash = drainTriage?.stash ?? null;
      if (turnTriage?.parked) {
        logger.info(`chat-agent: supervisor turn pre-triage still holds ${batchRows.length} queued agent row(s) for ${chatId.slice(0, 8)} until ${new Date(turnTriage.parked.until).toISOString()}`, { source: 'chat-agent' });
        return false;
      }
      if (turnTriage?.skip) {
        logger.info(`chat-agent: supervisor turn pre-triage parked ${batchRows.length} queued agent row(s) for ${chatId.slice(0, 8)} (will_act ${turnTriage.skip.p.toFixed(2)}, skip ${turnTriage.skip.consecutive}) — they drain on their own after the park`, { source: 'chat-agent' });
        return false;
      }
      turnNoopStash = turnTriage?.stash ?? null;
      if (turnNoopStash && tn) drainStash = tn.withSiblingStash(drainStash, turnNoopStash);
    }
    // MATERIAL-CHANGE GATE (audit 2026-10-08 W6-2; platform/supervisor-wake-ledger.ts):
    // a queued AGENT batch for a SUPERVISOR chat whose every message is a
    // near-duplicate lane report (or a status-only PS → Fleet report-up) and
    // nothing material moved since the last completed wake is ACKED — the
    // bodies persist as one agent-origin row + a harness ack row (the next
    // wake's diff lists them), no turn starts. Fail-open; uploads never gate.
    // Kill switch SUPERVISOR_MATERIAL_GATE_DISABLED=1.
    if (pending.source === 'agent' && !pendingUploads.length) {
      const wl = await import('../platform/supervisor-wake-ledger').catch(() => null);
      if (wl && typeof wl.materialGateForDrain === 'function') {
        const srcIds = batchOrigins.map((o) => (o?.kind === 'agent' ? o.sourceChatId : undefined));
        const mg = await wl.materialGateForDrain({ chatId, rows: batchRows, sourceChatIds: srcIds }).catch(() => null);
        if (mg) wl.recordMaterialGateAgreement(mg, [drainStash]);
        // SUP-WAKE-TIERS (2026-10-20): skipReason 'progress_self_driving' = a progress-only batch from lanes still driving themselves.
        if (mg?.skip && await wl.ackMaterialGateDrain({ chatId, rows: batchRows, sourceChatIds: srcIds, verdict: mg.verdict, ...(mg.skipReason ? { skipReason: mg.skipReason } : {}) })) {
          void wl.closeStashesForGateSkip([drainStash], chatId, 'drain');
          logger.info(`chat-agent: material gate acked ${batchRows.length} queued agent row(s) for supervisor ${chatId.slice(0, 8)} — ${mg.skipReason === 'progress_self_driving' ? 'progress only, the reporting lanes are driving themselves (SUP-WAKE-TIERS 2026-10-20)' : 'no material change since its last wake (audit 2026-10-08 W6)'}`, { source: 'chat-agent' });
          return drainChatQueue(chatId, userId);
        }
      }
    }
    // Queued attachments (ac65d51e): the enqueue persisted staged upload ids
    // (and stretched their Redis TTL). Resolve them EXACTLY like an immediate
    // send (fleet supervisor path): images → userImages, doc/PDF text →
    // documentText, filename+type → attachmentMeta on the user row. An expired
    // blob annotates the message honestly — never a silent drop.
    let message = pending.content;
    if (batchRows.length > 1) {
      const AGENT_HDR = '[AGENT-SENT MESSAGE';
      // audit 2026-10-16 item 3 fix C (todo 21c11618): two IDENTICAL bodies
      // inside one coalesced envelope (Schooltime's 02:13Z report-up arrived
      // twice in ONE "[N agent messages arrived…]" batch; a busy-batch showed
      // the same message twice) — collapse byte-identical bodies into ONE with
      // an ×N marker so the woken supervisor reads one ask, not N copies of it.
      // Window = the batch itself (bounded by coalescing); kill switch
      // CHAT_AGENT_BATCH_DEDUPE_DISABLED=1. Fail-open: any error keeps every body.
      const dedupeOn = process.env.CHAT_AGENT_BATCH_DEDUPE_DISABLED !== '1';
      const bodyList: Array<{ body: string; note: string; src?: string; count: number }> = [];
      for (let i = 0; i < batchRows.length; i++) {
        const body = String(batchRows[i].content ?? '').trim();
        const note = supersededNotes[i] ? `${supersededNotes[i]}\n` : '';
        const src = batchOrigins[i]?.sourceChatId;
        const prev = dedupeOn ? bodyList.find((b) => b.body === body && b.src === src) : undefined;
        if (prev) {
          prev.count += 1;
          continue;
        }
        bodyList.push({ body, note, src, count: 1 });
      }
      const dedupedRows = bodyList.reduce((a, b) => a + b.count, 0) - bodyList.length;
      if (dedupedRows > 0) {
        logger.info(`chat-agent: coalesced batch for ${chatId.slice(0, 8)} collapsed ${dedupedRows} identical body(ies) (audit 2026-10-16 21c11618 fix C)`, { source: 'chat-agent' });
        try {
          const { recordLoopMetric } = await import('../platform/loop-metrics.service');
          recordLoopMetric({ kind: 'chat_agent_batch_dedupe', sessionId: chatId, value: dedupedRows, meta: { batchRows: batchRows.length, kept: bodyList.length } });
        } catch { /* telemetry never blocks the batch */ }
      }
      const bodies = bodyList.map((b) => {
        const dupTag = b.count > 1 ? `[same message delivered ${b.count}× — one copy shown]\n` : '';
        const body = b.body;
        if (body.startsWith(AGENT_HDR)) return `${b.note}${dupTag}${body}`;
        return `${b.note}${dupTag}${b.src ? `[queued agent message from chat ${String(b.src).slice(0, 8)} — another Digby agent, NOT the owner]\n` : ''}${body}`;
      });
      message = `[${batchRows.length} agent messages arrived while this chat was busy — coalesced into ONE turn. Act on asks and state changes; a status-only report from a project supervisor needs no answer — do not narrate it. Owner directives in this transcript govern over all of them.]\n\n${bodies.join('\n\n— — —\n\n')}`;
    } else if (supersededNotes[0]) {
      // A single queued agent row carries the same staleness risk (it waited
      // in the queue too) — annotate it identically, without the digest wrapper.
      message = `${supersededNotes[0]}\n${message}`;
    }
    let userImages: ChatAgentRunArgs['userImages'];
    let documentText: string | undefined;
    let attachmentMeta: ChatAgentRunArgs['attachmentMeta'];
    const queuedUploadIds = Array.isArray(pending.uploadIds)
      ? (pending.uploadIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    if (queuedUploadIds.length) {
      const { loadAttachment, combineAttachments } = await import('../upload.controller');
      const { mapAttachmentForAgent } = await import('./chat-gate');
      const loaded = await Promise.all(queuedUploadIds.map(async (id) => ({ id, a: await loadAttachment(id) })));
      const resolvedPairs = loaded.filter((l): l is { id: string; a: NonNullable<(typeof loaded)[number]['a']> } => l.a !== null);
      const resolved = resolvedPairs.map((l) => l.a);
      const expired = loaded.length - resolved.length;
      // Persistent chat files (2026-08-25): durable copy of every resolved
      // staged upload. Usually a no-op (the original send persisted at its own
      // consumption — the unique (uploadId, chatId) key dedupes); this is the
      // safety net for queued rows whose blobs survived to drain. Authored by
      // pending.userId (the actual uploader — the drain runs under the
      // finishing run's userId). Fire-and-forget: never blocks the drain.
      if (resolved.length) {
        void import('../chat-files.service')
          .then((m) => m.persistChatUploads({
            chatId,
            userId: pending.userId || userId,
            loaded: resolvedPairs.map((l) => ({ id: l.id, attachment: l.a })),
          }))
          .catch(() => {});
      }
      if (resolved.length) {
        // Chips carry the staged uploadId (ticket c6e8edda): getChatById
        // resolves it against the durable ChatFile row at read time so the
        // transcript can render image chips INLINE (fileId → authed byte route).
        attachmentMeta = resolvedPairs.map((l) => ({ filename: l.a.filename, type: l.a.type, uploadId: l.id }));
        const mapped = mapAttachmentForAgent(combineAttachments(resolved));
        if (mapped.userImages?.length) userImages = mapped.userImages;
        if (mapped.documentText) documentText = mapped.documentText;
      }
      if (expired > 0) {
        message = `${message ? `${message}\n\n` : ''}[${expired} attachment(s) expired before this queued message ran — please re-send ${expired === 1 ? 'it' : 'them'}.]`;
      }
      if (!message.trim() && (userImages?.length || documentText)) {
        message = '[Sent with attachment(s) while the chat was busy]';
      }
    }
    // RUN-START BOUND (MERGE-1 kill-window fix, 2026-11-05 rework). The only
    // cycle this bounds is the no-progress one: a run STARTED, its persist
    // failed, the row stayed queued, and the finished run's finally re-drains
    // it. Counting here — not at drain entry — is what keeps the DROP paths
    // free: a superseded / cancel-class / ack-only row terminates WITHOUT
    // starting a run, so it never consumes budget and can always be dropped.
    // Past MAX_DRAIN_ATTEMPTS the row is left QUEUED under a bounded cooldown
    // (the periodic sweep retries it; nothing is ever dropped).
    if (isDrainCoolingDown(pending.id)) {
      logger.warn(`chat-agent: queue row ${pending.id} for ${chatId} is cooling down after exhausting its immediate-delivery budget — left queued for the next sweep`, { source: 'chat-agent' });
      return false;
    }
    const deliverAttempts = await noteDrainAttempt(pending.id);
    if (deliverAttempts > MAX_DRAIN_ATTEMPTS) {
      await tripDrainCooldown(pending.id);
      logger.warn(`chat-agent: queue row ${pending.id} for ${chatId} exceeded ${MAX_DRAIN_ATTEMPTS} immediate deliveries — cooling down instead of re-arming, left queued for the next sweep`, { source: 'chat-agent' });
      return false;
    }
    const key = await startDetachedChatRun({
      userId,
      chatId,
      message,
      // A queued row carries the level its send RESOLVED (platform.service routes
      // 'auto' before enqueueing); a defensive stored 'auto' here is the L2
      // preset fallback (types.ts storedModeToPreset, 2026-09-26).
      mode: (QUEUED_RUN_MODES.has(pending.mode || '') ? pending.mode! : storedModeToPreset(pending.mode)) as ChatAgentRunArgs['mode'],
      ...(userImages?.length ? { userImages } : {}),
      ...(documentText ? { documentText } : {}),
      ...(attachmentMeta?.length ? { attachmentMeta } : {}),
      // A drained WEBHOOK send is still a machine wake: pin titling exactly as
      // the immediate-start path does (platform.service) — the stash kind wins,
      // the row's source column is the fallback when the stash expired. A
      // drained SCHEDULE firing (3405e332) gets the same machine-wake frame it
      // would have had on the direct fire path (schedule.service.ts passes
      // machineWake:true) — otherwise a queued one-shot would run as an
      // interactive human turn.
      // A queued TURN CONTINUATION (cohesive-chat wave 2026-09-28) is a
      // machine run of the same chat WITHOUT the wake frame: no freshness
      // preamble / supervisor state, the stash rides as args.continuation
      // (resolved above — from the Redis stash, else rebuilt from the marker).
      ...((origin?.kind ?? pending.source) === 'webhook' || ((origin?.kind ?? pending.source) === 'schedule' && !continuation) ? { machineWake: true } : {}),
      ...(continuation ? { continuation } : {}),
      // Origin preservation (audit p10): the stash (agent sends) also carries
      // sourceChatId + wake-depth; the pending row's source column carries the
      // KIND even when the stash is absent, so a drained send keeps the same
      // provenance it would have had if the chat had been idle on arrival.
      messageOrigin: (origin ? origin.kind : pending.source === 'agent' ? 'agent' : pending.source === 'webhook' ? 'webhook' : pending.source === 'schedule' ? 'schedule' : 'user') as 'agent' | 'webhook' | 'schedule' | 'user',
      ...(origin?.sourceChatId ? { originSourceChatId: origin.sourceChatId } : {}),
      // Owner-armed queue-drain parity (ticket 6ef770a1): a queued ONE-SHOT
      // firing of an owner-armed schedule (promptSetBy 'user', stashed at
      // enqueue as PendingSendOrigin.ownerArmed) keeps the EXPANDED render
      // it would have had on the direct fire path — otherwise the same
      // digest would render collapsed merely because the chat was busy.
      // Stash-less (Redis hiccup) degrades to unmarked, never blocks.
      ...(origin?.kind === 'schedule' && origin.ownerArmed ? { scheduleOwnerArmed: true } : {}),
      // One-shot chain provenance (finding B1): a drained queued firing keeps
      // the schedule id it was enqueued with, so its own-chat re-arms still
      // stamp their chain link exactly like the direct fire path.
      ...(origin?.kind === 'schedule' && origin.scheduleId ? { firedByScheduleId: origin.scheduleId } : {}),
      // Author attribution (f89d1213): the drain runs under the FINISHING
      // run's userId, but the row remembers who actually enqueued — thread it
      // so a teammate's queued message never persists stamped as the drainer.
      ...(pending.userId ? { authorUserId: pending.userId } : {}),
      // N6: the drain_triage shadow stash rides to this run's finalize label.
      ...(drainStash ? { decision: drainStash } : {}),
      // MERGE-1 cutover kill-window fix (2026-11-05): the queued rows this turn
      // CARRIES ride to the run, which consumes them in the same transaction as
      // its transcript row. Never deleted here — see the block below.
      drainedPendingIds: batchRows.map((r) => r.id),
    });
    if (!key) {
      // lost the start race — the winner's finally retries this row (and re-asks); close this ask unlabelled so it still pairs.
      // NOTE (2026-11-05): a lost start race deliberately KEEPS its attempt.
      // Refunding it was tried and reverted — a refund makes the bound
      // unreachable (charge 1, refund, charge 1 …), which reproduces the very
      // hot no-progress retry this bound exists to stop. Charging a rare lost
      // race one slot is the safe side of that trade.
      if (turnNoopStash) { const tn = await import('../platform/supervisor-turn-noop').catch(() => null); tn?.closeUnstartedTurnNoop(turnNoopStash, chatId, 'lost start race'); }
      return false;
    }
    // Release the enqueue's TTL pin — the started run owns the resolved
    // content now; a lingering 24h blob is pure memory pressure (review M2).
    if (queuedUploadIds.length) await consumePendingUploads(queuedUploadIds);
    const maxDepth = Math.max(0, ...batchOrigins.map((o) => Number(o?.depth ?? 0) || 0));
    if (maxDepth > 0) {
      // Depth propagation through the queued hop (hooks.service ladder). The
      // stamp lands long before the just-started run's finalize reads it. A
      // coalesced batch stamps the DEEPEST sender's depth.
      await import('../platform/hooks.service')
        .then((m) => m.stampHookDepth(chatId, maxDepth))
        .catch(() => {});
    }
    // MERGE-1 cutover kill-window fix (2026-11-05): the drained rows are NOT
    // deleted here any more — see `drainedPendingIds` on startDetachedChatRun
    // above. The run consumes them in the SAME transaction that persists its
    // transcript row, which is the only ordering where a cutover kill can
    // neither duplicate the message nor lose it.
    logger.info(`chat-agent: drained ${batchRows.length > 1 ? `${batchRows.length} coalesced agent messages` : `queued message ${pending.id} (source=${pending.source})`} into a new run for ${chatId}`, { source: 'chat-agent' });
    return true;
  } catch (err: any) {
    logger.warn(`chat-agent: queue drain failed for ${chatId}: ${err?.message ?? err}`, { source: 'chat-agent' });
    return false;
  }
}

// ── F1: user messages preempt REPLAYABLE machine runs (owner incident 2026-09-04,
// supervisor chat c0e22e36 — the owner's question sat 12 minutes behind machine
// traffic while the UI said "Idle") ─────────────────────────────────────────────

/** Bounded wait for the preempted run's graceful teardown before the caller
 *  falls back to queue-with-priority (F2 is the delivery guarantee). */
const PREEMPT_WAIT_MS = 5_000;
const PREEMPT_POLL_MS = 250;

/**
 * Request cancellation of the chat's ACTIVE run IFF it is machine-triggered
 * (machineWake / schedule / hook / agent / webhook — the Redis claim carries
 * the marker), then wait a bounded ~5s for the slot to free.
 *
 * PLAIN-CHAT LANE ONLY, by construction:
 *   - the machine marker lives on the plain-chat liveness claim — coding runs
 *     never claim it, so they can never test machine-triggered here;
 *   - the local cancel targets ONLY the `chat:<id>` run key (never the bare
 *     coding session key);
 *   - the cross-process stop flag is polled ONLY by the plain-chat run
 *     heartbeat (startDetachedChatRun) — the coding lane's Redis cancel is a
 *     different channel entirely.
 * A USER-triggered run is NEVER cancelled: the gate is the explicit `:machine`
 * claim marker, and every degraded read (Redis hiccup, absent key) answers
 * false — fail-safe toward not preempting.
 *
 * Cancellation is BEST-EFFORT (the loop applies it between steps; a run that
 * is mid-finalize completes its persistence untouched) — the caller must treat
 * `freed:false` as "queue with priority" (F2), never as an error. Machine work
 * is replayable by design: its schedule/hook re-fires, and the orphan sweeper
 * re-fires dead machine turns (bb2eca92), so a cancelled wake is never lost
 * product state.
 *
 * Returns { preempted, freed }: preempted = a machine run was found and its
 * cancellation requested; freed = the chat went idle within the bounded wait
 * (the caller may start the user's run immediately).
 */
export async function preemptMachineRunForUserMessage(
  chatId: string,
  opts: { waitMs?: number } = {},
): Promise<{ preempted: boolean; freed: boolean }> {
  try {
    if (!(await isChatRunMachineTriggered(chatId))) return { preempted: false, freed: false };
    // Ticket a5b36dc6 — the IN-FLIGHT checkpoint stamps HERE, at the single
    // choke point every preempt route shares (REST sendChatMessage AND the
    // SSE stream controller): the interrupted run's side-effecting calls may
    // never settle (journal rows stay pending/unknown — the effects may still
    // land), and without the marker the next turn answers "from earlier
    // context" and retracts claims. Supervisor-class chats only (the state
    // service checks); never throws; kill switch
    // SUPERVISOR_INFLIGHT_PREEMPT_DISABLED=1. BOUNDED (250 ms) rather than
    // fire-and-forget so the user's own run — the turn most likely to ask
    // "did my thing go out?" — starts only after the marker write has either
    // landed or definitively not (a slow write must not delay the preempt;
    // a missed stamp still renders on later wakes within the 2 h window).
    let stampTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      markPreemptedInflight(chatId).finally(() => { if (stampTimer !== undefined) clearTimeout(stampTimer); }),
      new Promise<void>((r) => { stampTimer = setTimeout(r, 250); }),
    ]).catch(() => { /* fail-open — the preempt proceeds regardless */ });
    // build 2026-10-08 A1: an answer-first follow-through round cancelled HERE re-queues after the owner's turn (a Stop never marks).
    await markChatRunPreempted(chatId);
    const key = chatRunKey(chatId);
    const local = isRunActive(key);
    if (local) {
      // Same-process: apply the stop endpoint's exact local semantics — cancel
      // the loop AND release any parked ask_user wait so teardown is prompt.
      cancelRun(key);
      const { resolvePendingForSession } = await import('../coding/question-registry');
      resolvePendingForSession(chatId);
    }
    // Cross-process: the owning instance's run heartbeat polls this flag (it
    // cancels + releases parked waits there). Harmless when the run was local
    // (the next claim clears any leftover).
    await requestChatRunStop(chatId);
    // Withdraw-if-raced: if the machine run ended between the marker read and
    // the stop write, the flag would target the NEXT run — which may be the
    // user's own drained message. Still machine-marked (or re-marked by
    // another machine drain — also a legitimate preemption target) → keep it.
    if (!(await isChatRunMachineTriggered(chatId))) {
      await clearChatRunStopRequest(chatId);
    }
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CHAT_PREEMPTION,
      sessionId: chatId,
      // No model context here (the preempted run belongs to another turn) —
      // stamp what IS known: the lane, and that a USER message preempted.
      stamp: { profile: 'chat', triggerKind: 'user' },
      meta: { local },
    });
    // Preempted-wake redelivery (spark B21): the machine run being cancelled
    // consumed hook events ('delivered') that it will never act on — requeue
    // them ONCE so the wake re-lands after the user's turn (schedule firings
    // need no analogue: the cadence re-fires on its own). Fire-and-forget;
    // the once-guard lives in the payload (preemptRequeued).
    void import('../platform/hooks.service')
      .then((m) => m.requeuePreemptedHookEvents(chatId))
      .catch(() => {});
    logger.info(`chat-agent: user message preempting machine run in ${chatId} (local=${local})`, { source: 'chat-agent' });
    const deadline = Date.now() + (opts.waitMs ?? PREEMPT_WAIT_MS);
    while (Date.now() < deadline) {
      if (!(await isChatBusy(chatId))) return { preempted: true, freed: true };
      await new Promise((r) => setTimeout(r, PREEMPT_POLL_MS));
    }
    return { preempted: true, freed: !(await isChatBusy(chatId)) };
  } catch (err: any) {
    logger.warn(`chat-agent: preemption attempt failed for ${chatId} (queue-with-priority covers delivery): ${err?.message ?? err}`, { source: 'chat-agent' });
    return { preempted: false, freed: false };
  }
}

/**
 * F2(b) enqueue-side immediate-drain nudge: fire-and-forget drain attempts
 * shortly after a message is queued. Closes the enqueue-vs-finalize race the
 * 2026-09-04 incident exposed — the owner's message was enqueued moments after
 * a machine run's finally had ALREADY drained (the busy check saw the dying
 * run), so nothing delivered it until the sweep's 5-min-grace tick. Each
 * attempt is drainChatQueue itself: cross-instance-safe (its own isChatBusy
 * check + startDetachedChatRun's atomic Redis claim — the same guarantees the
 * sweep relies on) and a harmless no-op when the chat is busy or the queue is
 * empty. The run-finalize drain stays the primary path; the 60s sweep stays
 * the backstop.
 */
export function nudgeQueueDrainSoon(chatId: string, userId: string, delaysMs: number[] = [1_500, 8_000]): void {
  for (const delay of delaysMs) {
    const t = setTimeout(() => {
      void drainChatQueue(chatId, userId).catch(() => {});
    }, delay);
    t.unref?.();
  }
}

/** metadata.origin values that mark MACHINE traffic (wakes + agent sends) —
 *  mirrors fleet.service's MACHINE_ORIGINS ('machine' is a legacy stamp). */
const MACHINE_ROW_ORIGINS = ['schedule', 'hook', 'agent', 'machine', 'webhook'];

/**
 * How many of a chat's persisted messages are HUMAN-VISIBLE conversation
 * (machine-origin rows excluded). Powers the titling windows (audit p10): raw
 * history length overstates human turns once machine wakes have run, closing
 * both title windows before the human's first real message.
 */
async function countHumanVisibleMessages(chatId: string, excludeMessageId?: string): Promise<number> {
  // Orphan-recovery re-fire (ticket 68bc5aec): excludeMessageId drops the
  // recovered turn's own (already-persisted) user row from BOTH counts so the
  // titling windows see exactly the prior-turn count the original send saw.
  const exclude = excludeMessageId ? { id: { not: excludeMessageId } } : {};
  const [total, machine] = await Promise.all([
    prisma.crossModelMessage.count({ where: { chatId, ...exclude } }),
    prisma.crossModelMessage.count({
      where: { chatId, ...exclude, OR: MACHINE_ROW_ORIGINS.map(origin => ({ metadata: { path: ['origin'], equals: origin } })) },
    }),
  ]);
  return Math.max(0, total - machine);
}

export interface ChatAgentRunArgs {
  /** Ghost mode (owner 2026-10-22): per-send ghost opt-in — the GUEST toggle
   *  (guests have no chat row). For a chat with a row the stored flag wins. */
  ghost?: boolean,
  /**
   * Decision-outcome label (WI-C, 2026-09-25): the shadow decision-gate stash
   * (wake_triage for a hook wake, delta_material for a delta-gate firing,
   * drain_triage for a drained agent-message batch — N6, 2026-09-25) this
   * machine run's finalize labels from what the run did — set ONLY by
   * fireScheduleTarget and drainChatQueue; never by the interactive path.
   */
  decision?: DecisionStash | null;
  /** null for anonymous users — prisma writes + memory are guarded on presence. */
  userId: string | null;
  /** null for anonymous users (and as a fallback when chat auto-create failed). */
  chatId: string | null;
  /** Anonymous session id (cm_session cookie) — context + history when userId is null. */
  sessionId?: string | null;
  message: string;
  mode: 'single_thinking' | 'thinking' | 'deep_research' | 'deep_research_all';
  /** Pre-fetched integration data (integration-context.ts) → system prompt. */
  additionalContext?: string;
  /** Paired + online Mac bridge agent — runs the post-answer iMessage draft classifier. */
  imessagePairedAgentId?: string | null;
  /** Validated image attachments for the CURRENT user turn (forces a vision orchestrator). */
  userImages?: ChatImage[];
  /** Extracted document/PDF text block appended to the agent's user message. */
  documentText?: string;
  /**
   * Attachment summary for the persisted user row's metadata.attachments
   * (filename + type + the staged uploadId — never base64) so transcripts can
   * render the file chips after a reload. The uploadId (ticket c6e8edda) is
   * the join key to the durable ChatFile row persisted at consumption:
   * getChatById resolves chips → fileId at read time so image chips render
   * inline. Set by callers that resolved uploads (the SSE stream path, the
   * fleet supervisor send, the busy-queue drain); chips from older rows have
   * no uploadId and keep rendering as plain filename chips.
   */
  attachmentMeta?: Array<{ filename: string; type: string; uploadId?: string }>;
  /**
   * Set ONLY for runs triggered by a REAL user message (UI stream, REST
   * send, or a user-confirmed send_chat_message): the request-arrival time.
   * The run's confirmation anchor (platform/pending-confirmations.ts) is the
   * persisted user row's createdAt, falling back to this value. Machine
   * triggers (schedule firings) MUST leave it undefined — those runs can
   * register pending confirmations but can never confirm them.
   */
  userTurnAt?: Date;
  /**
   * Fleet origin marking (Management): who/what this run's message is from.
   *   - 'user'     — a real human turn (REST send, UI stream, fleet queue drain).
   *   - 'schedule' — a ChatSchedule firing (machine wake).
   *   - 'hook'     — an event-hook wake delivery (hooks.service outbox — NOT a
   *                  schedule; audit p10: hook wakes used to be mis-stamped
   *                  'schedule', sending overnight-run investigations to the
   *                  wrong subsystem).
   *   - 'agent'    — another chat's agent (in-loop send_chat_message tool).
   * Persisted as metadata.origin (+ metadata.sourceChatId for 'agent') on BOTH
   * the user row and the assistant reply, so the fleet views can tell machine
   * noise apart from the interactive thread. Undefined = legacy/unmarked.
   */
  messageOrigin?: 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
  /** For messageOrigin 'agent': the SENDING chat's id (the run's own session). */
  originSourceChatId?: string;
  /**
   * Owner-dispatch (2026-10-01): set ONLY by platform sendChatMessage for an
   * owner-dispatch-eligible agent send that STARTS this run (never the queue
   * drain). With messageOrigin 'agent' + userTurnAt the run is NOT
   * machine-triggered (machineOriginRun / isOwnerDispatchRun); the persisted
   * rows keep metadata.origin 'agent'.
   */
  ownerDispatch?: boolean;
  /**
   * Owner-armed schedule firing (ticket 6ef770a1): set ONLY when
   * messageOrigin 'schedule' AND the firing schedule row's promptSetBy ===
   * 'user' — the owner armed the digest from a real user turn
   * (schedule_message), so the fired content is DELIVERED CONTENT, not
   * internal wake noise. Persists metadata.scheduleOwnerArmed:true on the
   * user row, which the frontend machine-turn grouping reads off the group's
   * ANCHOR row to render the whole machine turn EXPANDED with a "requested"
   * marker. ALSO stamps metadata.kind 'owner_digest' (OWNER_DIGEST_KIND) on
   * the run's ASSISTANT row (ticket 77c3a7e9) so the digest ANSWER renders as
   * a normal visible assistant bubble, not accordion chrome. Legacy NULL
   * promptSetBy and machine/system rows never set it — they render collapsed
   * exactly as today. The busy-queue drain re-threads it from the Redis
   * origin stash (PendingSendOrigin.ownerArmed).
   */
  scheduleOwnerArmed?: boolean;
  /**
   * One-shot CHAIN provenance (finding B1, 2026-09-27): the coding_schedules
   * row whose firing started this run — set by fireScheduleTarget (origin
   * 'schedule') and the busy-queue drain (PendingSendOrigin.scheduleId);
   * threaded into the agent loop's ToolContext so the run's own-chat `once`
   * re-arms stamp chainedFromScheduleId (schedule-once-chain.ts).
   */
  firedByScheduleId?: string;
  /**
   * Child→parent result-hook wake (ticket 56d6b204): set ONLY when
   * messageOrigin 'hook' AND the delivering hook is the auto-wired
   * sub-session result path (isChildResultTemplate — hooks.service
   * deliverHookGroup). The spawn that requested this session is waiting on
   * its verdict, so the wake turn is DELIVERED CONTENT, not internal wake
   * noise. Persists metadata.childResult:true on the user row, which the
   * frontend machine-turn grouping reads off the group's ANCHOR row to render
   * the whole machine turn EXPANDED with a "results" marker — the 2026-09-25
   * incident (chat 6e36c834): the sub-session's completed DB-audit work was
   * folded behind a collapsed machine accordion the owner never opened.
   * Guarded at the compose on origin 'hook' exactly like the schedule guard
   * above: a stray flag on any other origin must never stamp.
   */
  childResult?: boolean;
  /**
   * Owner-ask wake (fixer 2026-09-27, finding upward-chatter-1): set ONLY by
   * hooks.service (via fireScheduleTarget) when messageOrigin 'hook' AND the
   * delivered rows carry payload.kind 'owner_ask_unanswered' — the [OWNER ASK
   * UNANSWERED] re-wake (platform/owner-asks.ts) or the [FOLLOW-THROUGH] nudge
   * (fleet/follow-through.service.ts). The owner crossmodel_messages row ids
   * those wakes were raised for. Effects at finalize: a REAL reply (not an
   * envelope, not a 'WAKE: no-op' close) closes each ask via closeAskOnReply
   * (source 'machine_wake') and stamps metadata.ownerAskReply:true on the
   * reply row (fleet/supervisor-reply-row accepts it as the supervisor's
   * answer); the wake user row is stamped ownerAskReply:true at persist so the
   * frontend grouping mounts the turn EXPANDED (the answer must not fold behind
   * the machine accordion). Guarded on origin 'hook' exactly like childResult.
   */
  ownerAskMessageIds?: string[];
  /**
   * Shared-project author attribution (ticket f89d1213): the account that
   * actually WROTE this message, when it differs from the run's identity.
   * The busy-queue drain runs under the FINISHING run's userId (memory/
   * integrations scope stays untouched), but the pending row remembers who
   * enqueued — the drain threads that here so the persisted user row's
   * metadata.authorId names the real sender. Defaults to userId. Only
   * human-origin rows (messageOrigin absent or 'user') are stamped.
   */
  authorUserId?: string;
  /**
   * MERGE-1 cutover kill-window fix (2026-11-05) — the `pending_chat_messages`
   * rows whose CONTENT this run carries. drainChatQueue no longer deletes them
   * right after the claim; it threads their ids here so the run's own user-row
   * persist consumes them in ONE transaction with the transcript write
   * (message-queue.service createMessagesConsumingPending). That closes both
   * halves of the handover window: a kill before the commit leaves the row
   * queued for redelivery (no loss), a kill after it leaves both effects
   * exactly once (no duplication). Absent = not a queue drain.
   */
  drainedPendingIds?: string[];
  send: LegacySend;
  isCancelled?: () => boolean;
  /**
   * P4 Auto router: when the message arrived as mode='auto', the heuristic
   * router's decision. Emitted as a 'routing' SSE event right after 'init'
   * and persisted into the assistant message metadata so the transcript can
   * show which level Auto picked. `mode` above is already the RESOLVED level.
   */
  routing?: {
    level: string; reason: string; suggestCode: boolean;
    /** Patience plan 1a (2026-09-25): code-selected reason, judge, allowance clamp, the client's requested mode / modeSource. */
    reasonKey?: string; source?: string; clamped?: string; requestedMode?: string; modeSource?: string; confidence?: number; backend?: string;
  };
  /**
   * Patience plan 1a (2026-09-25): how this turn's level was chosen —
   * 'auto_heuristic' | 'auto_decision' (an Auto send), 'user_picked' |
   * 'user_default' | 'user_explicit' (an explicit level, by the client's
   * modeSource), 'machine'. Persisted as metadata.routingSource on the
   * assistant row and stamped (with `mode`) on the turn's run_spend /
   * chat_search_usage rows so cost per level reads without joins.
   */
  routingSource?: string;
  /** The human channel a CHATLESS send came from (audit 2026-09-26 routing-unify-6): 'telegram' stamps the compute_policy segment — never derived from the sessionId prefix. */
  channel?: 'telegram';
  /**
   * Machine-triggered run (schedule firing / hook wake via fireScheduleTarget —
   * never user messages, never queue drains). Effects (postmortem 2026-08-11,
   * docs/ONE_SESSION_PLATFORM.md Part 2-P1):
   *  1. the freshness preamble is prepended to the prompt (machine-wake.ts);
   *  2. the L2 cross-checker is skipped (a checker draft on an event digest is
   *     pure noise — the supervisor litigated it in every note; and since
   *     owner 2026-09-03 the peer checker is a full agentic run, so skipping
   *     it on wakes is also a hard cost gate);
   *  3. history slice deepens 8 → 24 (machine runs aren't latency-bound).
   *  (The old forced B1 SERP skip is moot — the forced search was removed for
   *  ALL lanes on 2026-09-03; every run keeps its on-demand web tools.)
   */
  machineWake?: boolean;
  /**
   * DEPLOY-INTERRUPT SOFT CHECKPOINT (mishap ticket 5ba5f03e): set ONLY by the
   * orphan-recovery re-fire paths when the previous attempt of THIS turn died
   * to a deploy mid-run. The SIGTERM ritual's receipt-backed harvest of what
   * the dead attempt ALREADY executed — rendered into the context (the
   * additionalContext seam) so the re-fired turn CONTINUES the work instead of
   * repeating completed side effects (the from-scratch re-run double-sent
   * messages / double-wrote lane ledgers). Absent on every normal send.
   */
  resumeBrief?: DeployResumeBrief;
  /**
   * ORPHAN-RECOVERY machine re-fire (ticket bb2eca92): the PRE-PREAMBLE
   * message of a machineWake run, captured by startDetachedChatRun right
   * before it prepends machineWakePreamble, and persisted as
   * metadata.machineMessage on the user row. The orphan sweeper re-fires a
   * dead machineWake turn from THIS clean copy with machineWake:true — a
   * fresh preamble + supervisor state block + clock get re-baked here, so
   * nothing doubles and no machine traffic runs down the interactive path.
   * Never set by callers; startDetachedChatRun stamps it internally.
   */
  machineWakeOriginalMessage?: string;
  /**
   * audit 2026-10-08 W6-1: when this supervisor MACHINE wake's prompt carries
   * the [SINCE YOUR LAST WAKE] ledger diff, the ISO time it was read. Set ONLY
   * by startDetachedChatRun. It (a) trims the wake's transcript history to its
   * last few own notes + owner-typed rows (the diff replaces the 24-message
   * replay) and (b) becomes the supervisor's next high-water mark at finalize.
   */
  wakeLedgerAt?: string;
  /**
   * ORPHAN-RECOVERY re-fire (ticket 68bc5aec): set ONLY by the chat-orphan
   * sweeper (chat-agent/orphan-recovery.ts) when re-firing a user row whose
   * original run DIED mid-flight (deploy/restart) after persisting the row.
   * The value is that row's id. Effects — every message-driven side effect in
   * this function was audited for this path (2026-08-28):
   *  1. HISTORY LOAD: buildChatQueryContext excludes this message id (threaded
   *     to context.service loadChatContext + getEnrichedContext) — the row is
   *     ALREADY persisted, so loading it would show the model the current
   *     question twice (the 2026-07-14 "models saw it twice" regression the
   *     load-before-persist ordering fixed).
   *  2. USER-ROW PERSIST: SKIPPED — the row exists; re-creating it would
   *     double the transcript. The recovery caller threads the row's ORIGINAL
   *     createdAt as userTurnAt, so the confirmation anchor matches the send
   *     the user actually made (pendings live ~14 min and the sweep grace is
   *     30 min, so in practice any pre-orphan pending has expired — the anchor
   *     is for parity, not liveness).
   *  3. TITLING: the titling count (countHumanVisibleMessages) excludes the
   *     orphan row too, so the up-front/repair gates see EXACTLY the prior-turn
   *     count the original send saw — a turn-1 orphan re-fires the up-front
   *     title chain; its CAS staleness guard stands down if the dead run's own
   *     title chain already landed.
   *  4. SUPERVISOR DIRECTIVE CAPTURE: SKIPPED — appendDirective runs right
   *     after the persist in the original run, so the dead run already captured
   *     it (the row's presence proves the persist — and therefore the capture
   *     — happened); appendDirective is NOT idempotent (fresh uuid per call),
   *     so re-capturing would duplicate the directive.
   *  5. CHAT updatedAt BUMP: kept — mirrors the original persist-time bump;
   *     the assistant-persist bumps it again at finalize as usual.
   *  6. MEMORY EXTRACTION (updateContextAsync, finalize): UNCHANGED — it runs
   *     after the assistant persist in program order, so a run that died
   *     before persisting its answer never reached it; no double extraction.
   *  7. SSE/queue/gates (routing event, cross-checkers, action guard /
   *     verifier, iMessage classifier, hook emissions, the finally's queue
   *     drain): UNCHANGED — all derive from the answer produced THIS run.
   *  8. ATTACHMENTS: NOT RECOVERABLE (honest degradation) — the original
   *     send's resolved userImages/documentText lived only in the dead
   *     process's memory (staged blobs expire in ~15 min; the sweep grace is
   *     30), so the recovery re-fires the TEXT content only. The persisted
   *     row's metadata.attachments chips remain on the transcript row.
   *  9. METADATA RECOVERY MARKER: the sweeper's {recovery:{firedAt,by}} stamp
   *     on the row survives untouched — this run never rewrites the user row.
   */
  recoveryForMessageId?: string;
  /**
   * DIG DEEPER escalation (compute policy, 2026-09-26): this run is the NEXT
   * rung on an earlier assistant message of the same chat — `ofMessageId` is
   * that row, `rung` 'verify' (a Level-2-class re-verify with the Double
   * Checker) or 'research' (the council, run INLINE on this same stream —
   * the ordinary deep_research path, because the controller rewrote `mode`;
   * `council:'background'` on the plan is a label no harness path detaches
   * on (only the chip suppressor, the budget flag and telemetry read it), so
   * the run survives a client disconnect, a deploy drain REQUEUES it as an
   * escalation (shutdown-interrupt.ts; only a hard box restart kills it); its
   * result posts as a NEW "Deeper findings" message +
   * notify_user when Telegram is linked).
   * Effects: NO user row is persisted (the question is the original one), the
   * chat is never re-titled, the plan is `escalationPlan(rung)` (source
   * 'escalation'), the assistant row carries metadata.kind 'deeper_findings'
   * + escalationOf, and the ORIGINAL row's metadata.depth.escalations gains
   * the rung so the next tap runs the rung after it (or none).
   */
  escalation?: { ofMessageId: string; rung: NextRung };
  /**
   * TURN CONTINUATION (cohesive-chat wave 2026-09-28; turn-continuation.ts):
   * this run is round N of the harness finishing a HUMAN ask that the
   * previous run handed back mid-task. Set ONLY by drainChatQueue from the
   * queued row's PendingSendOrigin.continuation (messageOrigin 'schedule',
   * never machineWake — no wake preamble, no supervisor state). Effects: NO
   * user row is persisted (the prompt is the harness's), the assistant row
   * carries metadata.kind 'continuation_result' + metadata.continuation and
   * NO machine origin (it renders as a normal bubble — the result the user
   * was promised), and the finalize flips the task card on `ofMessageId`
   * (done / failed / waiting_user) or arms the next round under the cap.
   */
  continuation?: ContinuationRun;
  /**
   * Roster 2026-10-06 A-3 (platform/lane-depth.ts routeResearchLane): the turn plan the CONTROLLER already asked for
   * this send (a research-routing canary / act sender) — the run reuses it instead of asking turn_plan twice. Set only
   * on human, non-escalation sends; absent / null ⇒ the run asks as before.
   */
  turnPlanPrefetched?: TurnPlan | null;
}

/**
 * Connected-apps + email/iMessage composition doctrine — appended to the chat
 * doctrines ONLY for authenticated runs (anonymous users have no connected
 * integrations, so telling the model about them would invite refused answers).
 * The tool set mirrors INTEGRATION_TOOL_SCHEMA (coding-integrations.ts); the
 * send paths: gmail_send_email (2026-09-23) and the #26 connector writes
 * (imessage_send / slack_post_message / x_post, 2026-09-24; Discord sends
 * added 2026-10-05) are agent tools gated on a human-attended turn; the UI's
 * confirmation cards remain.
 */
function userAppsBlock(): string {
  return `
## Your connected apps
You have CALLABLE TOOLS for the user's connected apps — use them whenever the request touches their own data:
- Gmail: gmail_search / gmail_get_message / gmail_get_attachment
- Google Calendar: calendar_list_events
- Google Drive / Docs / Sheets: drive_search / drive_get_doc / sheets_get_data
- Slack: slack_search / slack_list_channels / slack_get_channel_history
- Discord: discord_list_guilds / discord_list_channels / discord_channel_history / discord_list_dms
- Asana: asana_search / asana_list_tasks / asana_list_projects
- GitHub: github_search_code${githubFileReadToolDisabled() ? "" : " / github_get_file_contents (read a file on the default branch — the direct check before saying code does not exist)"} / github_list_issues / github_get_issue / github_list_prs
- X (Twitter): x_search / x_get_user_profile / x_get_trends — these read PUBLIC X data and work whether or not the user connected their own X account. If a result says "X READ DEGRADED", X's anti-bot blocked the read — that is a platform-side failure, NEVER a sign the user's X is disconnected; fall back to search_engine with a site:x.com query and say so honestly (ticket f609ec35)
- Xero: xero_get_organisation / xero_get_contacts / xero_get_invoices
- Banking (Plaid): plaid_get_accounts / plaid_get_balances / plaid_get_transactions
- iMessage: imessage_list_chats / imessage_get_messages
- WRITES on those apps (2026-09-24, Discord 2026-10-05): imessage_send {to handle, text} · slack_post_message {channel, text} · x_post {text} · discord_send_message {channelId, text} · discord_send_dm {userId, text} — each ONLY on a turn where the user asked for THAT send/post with THAT text (never from a scheduled run; confirm the exact text in your reply); asana_create_task / asana_update_task are ordinary edits. A reason 'missing_scopes' / 'not_connected' means the user reconnects the app in Account → Integrations — say so, never retry.
CALL these tools whenever the request touches the user's email, files, calendar, messages, tasks, repos, posts, accounting, or banking. Any pre-fetched app data in the context is a head start, NOT the complete picture — fetch more whenever you need it. If a tool reports the app isn't connected, say so and point the user to Account → Integrations. Never claim you lack access to a connected app.

## API keys & credentials (Account → Coding)
The user's stored coding credentials (Cloudflare, AWS, Namecheap, Brev, custom…) are listed BY NAME in the [YOUR INTEGRATION STATUS] block — e.g. "CLOUDFLARE_API_TOKEN". Values are write-only: you cannot read one back, and you must NEVER ask the user to re-paste a key that is listed there. To USE a stored key, hand the work to a coding session (start_coding_session) — its shell has every listed key as an environment variable already set, so a lane can run e.g. wrangler/aws/curl against the provider as the user. If the key the work needs is NOT in the list, then and only then ask for it — and on a turn where the user pastes it, store_secret saves it without it ever being echoed.

## Writing & sending email
When the user asks you to write, compose, or send an email, compose it properly:
- Recipient: figure out who it goes to — use gmail_search to find the person's address or the thread to reply to instead of guessing; ask the user only if it's genuinely ambiguous.
- Subject: clear and specific.
- Body: an appropriate greeting, a concise well-structured body in the user's tone, and a sign-off.
Then output the draft EXACTLY as:
[SEND_EMAIL to="recipient@example.com" subject="Subject"]
body
[/SEND_EMAIL]
followed by ONE short sentence ("Here's the draft — tap Send to deliver it, or Edit to make changes.").
Rules: the block contains ONLY the email body — never commentary inside it; NEVER say "I can't send emails" — the user confirms with a Send/Edit/Cancel card in the UI.

## Texts & iMessages
When the user's context says a Mac is paired, compose texts/iMessages plainly when asked — a confirm-and-send card appears automatically; never say you can't send texts.`;
}

/**
 * Per-run inputs of the capability playbook (capability-doctrine.ts), shared by
 * chatDoctrine and councilLeadDoctrine (2026-09-08): the run's chat id (= the
 * orchestrator's sessionId), a REAL chat title or null, the owning project or
 * null (the 'chat' sentinel normalized away by the caller), the supervisor
 * flag, and whether a signed-in user is on the run (anonymous runs get the
 * no-account-tools variants).
 */
export interface PlatformDoctrineArgs {
  chatId: string;
  chatTitle: string | null;
  projectId: string | null;
  isSupervisor: boolean;
  hasUser: boolean;
  /**
   * Machine-triggered run (schedule firing / hook wake / webhook / agent
   * origin — the same expression the loop metrics segment on). The playbook
   * stays (notify_user must be findable), but the offers block and the
   * action-chip follow-up line switch to their no-offers variants (review
   * 2026-09-08: a recurring wake ended every firing offering to set up the
   * schedule that produced it).
   */
  machine: boolean;
}

export function chatDoctrine(args: PlatformDoctrineArgs & {
  mode: 'single_thinking' | 'thinking' | 'deep_research' | 'deep_research_all';
  systemContext: string;
  crossCheckBlock: string;
  deadlineNote: string;
  /** false on an instance with no search backend (self-host setup hardening, 2026-10-20) — the web bullets are replaced; default true keeps the text byte-identical. */
  webSearchConfigured?: boolean;
}): string {
  const noWeb = args.webSearchConfigured === false;
  return `You are Digby, the AI assistant at digby.ai — answering ONE user question conversationally.

## How to answer
${noWeb
    ? `- This instance has NO live web search (not set up here): answer from your own knowledge, the user's files and connected accounts — and when the question needs current facts, say in one sentence what you could not verify. Your final message is the answer the user reads; do not narrate ("let me check…").`
    : `- Research FIRST (web tools below), answer LAST: your final message is the answer the user reads. Do not narrate ("let me check…") — either call a tool or write the answer.
- Search discipline: use your web tools whenever the question is time-sensitive, involves anything after your training cutoff, is disputable, or you are not fully certain of the answer — answering purely from memory is reserved for stable, indisputable facts. When you searched, ground your claims in the results and weave in source specifics.`}
- When the request names an artifact (a summary, a deck, a draft), deliver it — and when the goal behind the request is clear and a bigger outcome is one step away, say so in one line and offer it ("this deck exists to get a decision on X — I can also draft the decision memo with options"). Never withhold the asked-for artifact; altitude is an offer, never a substitution.
- You act in AUTO mode: never ask for confirmation on routine, goal-aligned actions. ask_user pauses for the user's reply inline (they answer, you continue in the same turn) — use it for: (1) CLARIFY — the request leaves out something that materially changes the result and has no sensible default (a logo with no brand name, "the weather" with no place you know, a cover letter with no job): ask ONE question bundling everything you need, before spending tools on a guess; (2) CREATIVE DIRECTION — taste decides the result (a logo, a name, a design, a story, a tone) and the user has not said what they like: offer 2-4 concrete directions as options ("Label — one-line description"; multiSelect:true when they may combine), unless a short draft is the faster way to learn their taste — then draft it and offer variants; (3) a genuinely human-worthy decision (irreversible/risky, spends money, changes account/security posture, deletes data). Never ask what research, memory or this conversation already answers, never ask twice in one turn, and never fill a missing subject with an unrelated fact from memory.
- Work the user asked for in THIS message runs directly with no card (start_coding_session, and schedule_message / update_schedule / cancel_schedule on THIS chat) — the tool result says it started. External-effect account tools (send_chat_message, set_chat_autonomy, create_share_link, and schedules on OTHER chats) are confirmation-gated: the first call returns needsConfirmation with a confirmationId — show the summary and ask the user to confirm; you CANNOT confirm in the same turn. When the user confirms in a NEW message, re-call the tool with just that confirmationId — the staged arguments execute exactly as summarized (a [System note] in the conversation history carries the id across turns). A staged confirmation STAYS PENDING until the user answers or dismisses its card (sidebar or Management page) — it does NOT expire on a short timer, so never tell the user it will die in minutes; if a re-call reports it unknown/stale, re-register by calling WITHOUT confirmationId and ask again.
- When you are blocked on a decision only the owner can make and no user turn is coming soon, call flag_owner_question — it persists in the owner's Management → Inbox (Needs owner) until they answer or dismiss it, and their answer appears in this chat's transcript.
- file_feedback tickets are ONLY for issues in Digby itself (this product) — NEVER for the user's own projects/apps: a problem reported in a project chat is presumptively project work (fix it via the project's workspace — attach_workspace / start_coding_session), and when you cannot tell which app the user means, ask. A genuine Digby filing from a project chat requires about='digby_platform' plus digbyEvidence.
${noWeb ? '' : `- To pull SEVERAL pages at once, call web_pipe({query or urls, focus?}) — ONE deterministic call: search→scrape in parallel→embed to session memory→digest with retrieval hints. Fastest path; use it instead of scraping page-by-page. delegate({role:'web_researcher', ...}) when the research itself needs judgment mid-fetch (following links, choosing sources, multi-hop questions) — the researcher has web_pipe too and reasons about when to use it.
`}${noWeb ? '- Be direct and complete. Format with markdown.' : '- Be direct and complete. Format with markdown. Never claim you lack access to public web content.'}
- Report tool outcomes truthfully: never narrate a web search, fetch or scrape as having run or failed unless a tool result for it is in this conversation this turn — if you did not call a web tool, say you are answering from memory and simply run the search when fresh material would help; a fabricated tool failure is worse than an honest unsearched answer. The same rule covers every consequential and staging action: never say you have staged/sent/delivered/attached/dispatched/scheduled/filed something unless the tool result confirming it is in this conversation this turn — a staging claim ("I've staged a message", "the files are on their way as attachments") is an action claim too: run the stage_upload (and the send it feeds), then report what the result actually said, or say plainly that you have not done it yet and do it next.
- Media & files (ticket 6e15a4c8): when the question touches the user's own photos, media, or files — or the answer would clearly benefit from them — include the directly relevant items PROACTIVELY: embed images inline with markdown (![name](/api/crossmodel/files/<id>/inline) — the THIS CHAT'S UPLOADS block in your context and the list_files tool give you the exact per-image URLs) and link other files with their download URLs. Relevance-gated: include only what genuinely helps the answer — never dump the whole list.
- For substantial STANDALONE artifacts the user will edit or reuse (code files, documents, diagrams) emit them as [CANVAS:type=<code|html|mermaid|document|table>,title=<title>]...[/CANVAS] blocks — but the direct answer to the user's question (lists, plans, tables, steps) ALWAYS stays in your chat message text; never send requested content to a canvas only (chat users can't always see the panel).
${followUpsInstruction({ hasUser: args.hasUser, machine: args.machine })}
${args.deadlineNote}
${args.hasUser ? userAppsBlock() : ''}

${platformPlaybookBlock(args)}

${proactiveOffersBlock({ hasUser: args.hasUser, machine: args.machine })}

${args.crossCheckBlock}

${args.systemContext}`;
}


// ═══════════════════════════════════════════════════════════════════════════
// L3 DEEP COUNCIL (owner design 2026-07-16, grounded in Anthropic's
// orchestrator-worker research system + 2026 supervisor/swarm practice):
// Kimi K3 leads a council of AUTONOMOUS colleagues (GLM-5.2, DeepSeek V4
// Pro). Each colleague plans its own work, spawns up to 3 clones of itself
// for parallel legs, messages peers/lead mid-flight (notes injected between
// steps), shares everything through session memory, and finishes when IT
// judges the mission complete. No pacing timeouts — only generous graceful
// runaway backstops (the deadline mechanism yields a complete answer, never
// a truncation). Effort scaling, sharp mission briefs, and agent-owned end
// conditions are prompt-embedded per the published SOTA failure modes.
// ═══════════════════════════════════════════════════════════════════════════

// Council seats (owner, 2026-08-01: the old 'kimi' seat → 'glm'; Kimi K3 is the
// LEAD now). glm seat 'glm-5.2' → 'glm-5.3' (owner wave 2026-09-03).
// deepseek seat 'deepseek-v4-pro' → 'deepseek-flash' (V4.1 Flash cutover 2026-09-10).
const COUNCIL_MODELS: Record<string, string> = { deepseek: 'deepseek-flash', glm: 'glm-5.3' };
const COUNCIL_LEAD_BACKSTOP_MS = 40 * 60_000;      // runaway guard, NOT pacing
const COUNCIL_COLLEAGUE_BACKSTOP_MS = 30 * 60_000;
const COUNCIL_CLONE_BACKSTOP_MS = 15 * 60_000;
const MAX_CLONES_PER_COLLEAGUE = 3;
/** Room a parent colleague keeps for its own final turn after a clone it spawned returns (2026-10-20). */
const CLONE_PARENT_MARGIN_MS = 90_000;
/** The least a clone is worth spawning with; below it spawn_self refuses (2026-10-20). */
const CLONE_MIN_DEADLINE_MS = 60_000;
const MAX_DISPATCH_ROUNDS = 4;

function councilLeadDoctrine(args: PlatformDoctrineArgs & { systemContext: string }): string {
  return `You are Digby's DEEP RESEARCH LEAD — the conductor of a council of autonomous AI colleagues, each a different model:
- 'double_checker' (the Double Checker) — analytical deep-diver (rigorous, quantitative, source-critical)
- 'triple_checker' (the Triple Checker) — broad synthesizer and fact-verifier (wide coverage, cross-checking)

## Your process (own it; adapt to the question)
1. THINK & SCALE: decompose the question and scale effort to complexity. Trivial -> answer directly. Standard -> dispatch BOTH colleagues with divided, NON-OVERLAPPING missions. Complex/multi-domain -> both colleagues + your own parallel research + follow-up dispatch rounds.
2. DISPATCH with dispatch_colleagues (both in ONE call so they run in parallel). Write SHARP mission briefs: objective, expected output format, suggested angles/sources, and explicit boundaries so work never overlaps. Your colleagues are AUTONOMOUS — they plan their own approach, spawn clones of themselves for parallel legs, message you and each other mid-flight (their notes arrive between your steps), and finish when THEY judge the mission complete. There are no timeouts; depth is the point of this mode.
3. RESEARCH YOURSELF while they work when useful: web_pipe for bulk ingestion, search for specific facts, connectors for the user's own data. EVERYTHING the council ingests lands in shared session memory — search_memory retrieves any of it.
4. EVALUATE the reports: gaps -> dispatch follow-up missions (you may dispatch again, up to ${MAX_DISPATCH_ROUNDS} rounds); conflicts -> verify yourself or send_note asking colleagues to reconcile.
5. SYNTHESIZE: a comprehensive, structured, source-cited final answer that reconciles every perspective and names real disagreements honestly. DEPTH MANDATE: the user chose deep-research mode — for any substantial question your final deliverable should be a full report (typically 1,500+ words with sections, specifics, numbers, and sources), not a summary. Draw on search_memory for the detail the council gathered. Do NOT write it before at least one dispatch round unless the question is genuinely trivial. If a colleague FAILED or returned thin material, redispatch it or cover the gap with your own research first — for a substantial question, a thin answer is a failure; the user chose deep-research mode for depth.

- For substantial artifacts emit [CANVAS:type=<code|html|mermaid|document|table>,title=<title>]...[/CANVAS] blocks.
- Media & files (ticket 6e15a4c8): when the question touches the user's own photos, media, or files — or the report would clearly benefit from them — include the directly relevant items PROACTIVELY in your synthesis: embed images inline (![name](/api/crossmodel/files/<id>/inline) — the THIS CHAT'S UPLOADS block in your context and the list_files tool give you the exact per-image URLs) and link other files with their download URLs. Relevance-gated: include only what genuinely helps the answer — never dump the whole list.
${followUpsInstruction({ hasUser: args.hasUser, machine: args.machine })}
${args.hasUser ? userAppsBlock() : ''}

${platformPlaybookBlock(args)}

${proactiveOffersBlock({ hasUser: args.hasUser, machine: args.machine })}

${args.systemContext}`;
}

function councilColleagueDoctrine(args: { persona: string; peer: string; mission: string; imageBlock: string; clone?: boolean; machineWake?: boolean; noLiveWeb?: boolean }): string {
  // Self-host setup hardening (2026-10-20): no web_pipe / search orders on an instance without a search backend.
  const noWebLine = '- This instance has NO live web search: work from your own knowledge, the user\'s files and what search_memory already holds (everything the WHOLE council has gathered so far — avoid duplicating it), and mark every claim you could not verify.';
  const spawnLine = args.clone
    ? ''
    : `- For parallel legs of your mission, spawn_self (up to ${MAX_CLONES_PER_COLLEAGUE} clones) — give each a scoped subtask and required output format.\n`;
  return `You are ${args.persona}, an AUTONOMOUS senior researcher on Digby's deep-research council (your peer: ${args.peer}; the lead synthesizes at the end).

YOUR MISSION FROM THE LEAD:
${args.mission}

## Autonomy charter
- Plan your own approach. Start broad, then narrow. Prefer authoritative sources over SEO farms.
- Insist on the field's real instruments, not its vocabulary: when the mission involves data, use actual computation, tables, and primary sources — never a decorative summary of what an expert would say.
- When you are deep in the material, spend part of your budget looking for what nobody asked about: the earliest signal, the blind spot, the assumption the sources share. Report it separately if you find it.
${args.noLiveWeb ? noWebLine : '- web_pipe({query or urls, focus}) for bulk ingestion (search->read->shared memory->digest in one call); targeted search/scrape for specifics; search_memory to see everything the WHOLE council has gathered so far (avoid duplicating it).'}
${spawnLine}- Share significant findings, surprises, or questions mid-flight with send_note (to 'lead', your peer, or 'all'). Cross-check surprising claims before asserting them.
- You are done ONLY when you judge the mission answered — there is no time pressure.
- END with your full structured report (your final message IS the deliverable): findings with source URLs, confidence notes, and open questions.

${args.imageBlock}${args.machineWake ? `\n\n${crossCheckFleetScopeNote()}` : ''}`;
}

export function councilBackstopMs(kind: 'lead' | 'colleague' | 'clone'): number {
  return kind === 'lead' ? COUNCIL_LEAD_BACKSTOP_MS : kind === 'colleague' ? COUNCIL_COLLEAGUE_BACKSTOP_MS : COUNCIL_CLONE_BACKSTOP_MS;
}

/**
 * `deadlineMs` (audit H2, 2026-09-26): a Dig-deeper RESEARCH rung passes the
 * DepthBudget-derived deadline (`researchRungDeadlineMs`) so the inline
 * council honours `maxBackgroundMs`; the L3 PRESET passes nothing and keeps
 * its plain runaway backstops byte-for-byte.
 *
 * NO WALL CLOCK (owner 2026-10-20, council-dispatch.ts researchNoWallClock): every council profile — lead, colleague,
 * clone, on the preset, the research lane and the rung — runs with NO final-turn deadline and a token-idle stream
 * stall watchdog instead (`streamStallMs`, COUNCIL_STALL_MS). The step caps below are the termination guarantee.
 * RESEARCH_NO_WALL_CLOCK_DISABLED=1 restores the backstop / rung deadline above byte-for-byte.
 */
function councilProfile(kind: 'lead' | 'colleague' | 'clone', deadlineMs?: number) {
  const backstop = councilBackstopMs(kind);
  const unclocked = researchNoWallClock();
  return {
    kind: 'chat' as const,
    maxSteps: kind === 'lead' ? 24 : kind === 'colleague' ? 16 : 8,
    maxDelegations: 0,
    contextCharBudget: kind === 'lead' ? 150_000 : 120_000,
    // Graceful runaway backstops — the deadline mechanism forces a COMPLETE
    // final synthesis (with the [FINAL TURN] notice), never a truncation.
    runDeadlineMs: unclocked ? undefined : typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.min(backstop, deadlineMs) : backstop,
    ...(unclocked ? { streamStallMs: councilStallMs() } : {}),
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat' as const,
  };
}

/**
 * Wire shape for the 'complete' event's model cards (legacy slimModels parity,
 * adversarial review H3 2026-07-23): every card's response is truncated to 200
 * chars so a deep-research complete event stays small enough for Cloudflare
 * Tunnel/proxies (oversized SSE events were silently dropped — the "messages
 * don't show unless you switch conversations" bug). The client builds the
 * assistant message from accumulated 'chunk' text and full 'model-response'
 * events; the FULL models map still persists in the assistant row's metadata
 * (More-info panel after reload). All other card metadata
 * (model/modelUsed/time/error/webSearchUsed) is kept intact.
 */
export function slimChatModelCards(models: Record<string, any>): Record<string, any> {
  const slim: Record<string, any> = {};
  for (const [key, val] of Object.entries(models)) {
    const { response, ...meta } = val as any;
    slim[key] = { ...meta, response: (response || '').substring(0, 200) };
  }
  return slim;
}

/**
 * BRIEFING-UNVERIFIED-FILTER review fix (2026-10-20): the ACT-EVIDENCE probe the finalize footnote lane
 * hands collectUnverifiedClaims. An id in an unverified action claim's sentence exonerates the claim only
 * when it proves the act HAPPENED: an executed (ok) ACTION receipt of THIS chat — read receipts
 * (PLATFORM_OBSERVE_TOOLS) are observations, never acts — or, for a FULL uuid, a message THIS chat sent
 * (metadata.sourceChatId / originSourceChatId, same owner). The first cut asked "does the id exist
 * anywhere" (citedIdExistsAnywhere + any user's receipt by 8-char prefix), so the lane / goal / todo a
 * phantom dispatch TARGETS — which always exists — exonerated it ("I messaged lane 7fbd168c to rerun the
 * eval" on a zero-tool wake reached the owner briefing as fact). Receipt lookups ride the (chatId,
 * createdAt) index; a message is looked up only by its exact PK (an 8-hex prefix LIKE on
 * crossmodel_messages has no usable index). Owner-scoped by construction (this chat's rows). A throw is
 * caught by the caller, which counts the id as evidence (fail toward NOT annotating).
 */
export function unverifiedActEvidenceProbe(chatId: string, userId: string): (ref: ClaimIdRef) => Promise<boolean> {
  return async (ref: ClaimIdRef): Promise<boolean> => {
    const receipt = await prisma.runToolReceipt.findFirst({
      where: { chatId, ok: true, tool: { notIn: [...PLATFORM_OBSERVE_TOOLS] }, id: ref.exact ? ref.id : { startsWith: ref.id } },
      select: { id: true },
    });
    if (receipt) return true;
    if (!ref.exact) return false;
    const msg = await prisma.crossModelMessage.findUnique({ where: { id: ref.id }, select: { metadata: true, chat: { select: { userId: true } } } });
    const meta = (msg?.metadata ?? null) as Record<string, unknown> | null;
    const sender = meta ? (meta.sourceChatId ?? meta.originSourceChatId) : undefined;
    return !!msg && msg.chat?.userId === userId && sender === chatId;
  };
}

/** Run one agent chat turn. Resolves when the complete event has been sent. */
/**
 * One chat-agent turn. Audit 2026-10-06 T6-4 (crosscutting X7): a chat /
 * supervisor turn has no agent_runs row, so its compaction rows, agent-loop
 * rows and tool-failure logs carried no runId. The turn now runs inside an
 * ambient TELEMETRY run (utils/run-telemetry-context) whose minted id is also
 * its run_spend runId; loop_metrics rows and log records of the turn's own
 * session that name no runId take it. Kill switch
 * CHAT_RUN_TELEMETRY_ID_DISABLED=1 (the turn runs exactly as before).
 */
export async function runChatAgentTurn(args: ChatAgentRunArgs): Promise<void> {
  if (chatRunTelemetryIdDisabled()) return runChatAgentTurnInner(args);
  return runWithTelemetryRun({ runId: `chat-${randomUUID()}`, sessionId: args.chatId || null }, () => runChatAgentTurnInner(args));
}

async function runChatAgentTurnInner(args: ChatAgentRunArgs): Promise<void> {
  const { userId, chatId, message, send: rawSend } = args;
  // Run-level Level 3 floor for MACHINE-triggered runs (audit 2026-09-26
  // routing-unify-8 / supervisors-auto-3, defence in depth behind
  // platform/send-mode.ts): the council is keyed on `mode` alone, so a
  // schedule / hook / agent / webhook wake on a chat STORED deep_research —
  // or an agent send that named it — used to convene the inline council with
  // no quota reserve while its plan said council 'none'. A Dig-deeper research
  // rung (escalation) is a human tap and keeps its mode.
  // MACHINE_DEEP_RESEARCH_FLOOR_DISABLED=1 restores the old behaviour.
  const machineTriggeredArgs = args.machineWake === true || machineOriginRun(args);
  let mode: ChatAgentRunArgs['mode'] = args.mode;
  if (machineTriggeredArgs && !args.escalation && (mode === 'deep_research' || mode === 'deep_research_all') && process.env.MACHINE_DEEP_RESEARCH_FLOOR_DISABLED !== '1') {
    logger.info(`chat-agent: machine-triggered run requested ${mode} — floored to thinking (no unmetered council on a machine lane; MACHINE_DEEP_RESEARCH_FLOOR_DISABLED=1 restores)`, { source: 'chat-agent' });
    mode = 'thinking';
  }
  const startedAt = Date.now();
  // Agent-engine identities for chatless runs: the engine's session stores
  // (usage, compaction, findings) are key-value — no FK — so sentinels are safe.
  // `anon-` = a guest; `chatless-` = a signed-in chatless send (Telegram) —
  // audit 2026-09-26 routing-unify-6: telemetry used to read a linked Telegram
  // user as anonymous.
  const runUserId = userId || 'anonymous';
  const runSessionId = chatId || `${userId ? 'chatless' : 'anon'}-${args.sessionId || randomUUID()}`;
  // Audit 2026-10-06 T6-4: a chatless / guest turn binds its sentinel session to the ambient telemetry run.
  bindTelemetryRunSession(runSessionId);
  // WI-D: the turn's shared spend ledger (undefined under the kill switch —
  // every loop then keeps its own accumulator, the pre-WI-D shape). The stamp
  // is read at settle time: chatMetricStamp is built after the vision upgrade.
  // T6-4: the ledger carries the turn's telemetry run id, so run_spend joins its compaction / loop rows.
  let turnSpendStamp: MetricStamp | undefined;
  const turnUsage = createTurnUsageLedger({ sessionId: runSessionId, stamp: () => turnSpendStamp, runId: currentTelemetryRunId() });

  // ── Status pulse (owner UX directive 2026-07-14; honesty pass 2026-08-30):
  // the stream must never go quiet — if no status/thinking line went out for
  // ~8s, emit a beat. The beat reports REAL state (phase + elapsed time)
  // instead of rotating canned fiction ("Digby is reconciling the drafts…"
  // while nothing had actually moved — owner complaint 2026-08-30).
  let lastStatusAt = Date.now();
  let pulsePhase: 'research' | 'synthesis' = 'research';
  // What the lead is doing right now, read off the stream (2026-10-04): the answer phase starts THINKING (reasoning is
  // hidden), a tool line means DIGGING, answer text means WRITING — so a silent stretch is named for what it is.
  let pulseMood: 'thinking' | 'digging' | 'writing' = 'thinking';
  // Compute policy step 0 (2026-09-26): TIME TO FIRST TOKEN — the first 'chunk'
  // the user could read. Persisted as metadata.ux.firstChunkAt + the 'ux_ttft'
  // loop metric; nothing recorded it before (design §2(a)).
  let firstChunkAt: number | null = null;
  // Deep research without a wall clock (2026-10-20, council-dispatch.ts researchNoWallClock): an unclocked research
  // council notes every REAL activity beat on its live run — a lead / research-team event (reasoning and tools
  // included, before they are withheld) or answer text, never a status line or the pulse — so the deploy drain can
  // tell a PROGRESSING council from a stalled one (drain-status.ts researchExtensionEligible). Null ⇒ nothing noted.
  // Bound to the run that started the council (bindLiveRun), so a straggler's beat never lands on a later run.
  let researchProgress: BoundLiveRun | null = null;
  const noteResearchProgress = (): void => { researchProgress?.noteProgress(); };
  const send: LegacySend = (type, data) => {
    if (researchProgress && (type === 'agent-activity' || type === 'chunk')) researchProgress.noteProgress();
    // Thinking stays on the server (owner 2026-10-04, coding/reasoning-wire.ts): the lead's, the Double Checker's
    // and the research team's reasoning never reach this stream (nor count as a status beat — the pulse below
    // then tells the user Digby is still at it). HIDE_REASONING_DISABLED=1 restores it.
    if (withholdFromClient(type, data)) return;
    if (type === 'progress' || type === 'thinking-summary' || type === 'chunk') lastStatusAt = Date.now();
    if (type === 'chunk') pulseMood = 'writing';
    else if (type === 'progress' && pulseMood !== 'writing') {
      if (data?.message === STATUS.thinking) pulseMood = 'thinking';
      else if (data?.stage === 'model-searching' || data?.stage === 'agent') pulseMood = 'digging';
    }
    if (type === 'chunk' && firstChunkAt === null && String(data?.content ?? '').length) firstChunkAt = Date.now();
    rawSend(type, data);
  };
  const pulseTimer = setInterval(() => {
    if (Date.now() - lastStatusAt < 8000) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const mm = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    send('progress', {
      message: pulsePhase === 'research' ? STATUS.heartbeat.research(mm)
        : pulseMood === 'thinking' ? STATUS.heartbeat.thinking(mm)
        : pulseMood === 'digging' ? STATUS.heartbeat.research(mm)
        : STATUS.heartbeat.writing(mm),
      stage: pulsePhase === 'research' ? 'query' : 'synthesis',
    });
  }, 4000);
  pulseTimer.unref?.();

  try {
  // FIRST-WORD OPENER (ticket 4f7263e4, sighting-4 class fix): a HUMAN turn's
  // adapter delivers the first pre-tool segment as the answer's opening chunk
  // (the doctrine note asks for it — chat-agent/first-word-note.ts). Machine
  // wakes opt OUT: their answerText shape is load-bearing (the empty-retry
  // gate below reads it; wake-note doctrine forbids pre-tool chatter), so a
  // machine run streams byte-for-byte as before.
  const adapter = new ChatAgentSSEAdapter(send, { deliverOpener: !machineTriggeredArgs });
  const models: Record<string, any> = {};

  // init.webSearch = "web tools are available to this run" (always true for
  // agent runs). It stopped meaning "a harness search will be forced" on
  // 2026-09-03 — searching is the model's disciplined call now.
  send('init', { mode: 'open_source', webSearch: true, engine: 'agent' });
  // P4: an Auto-routed message announces its resolved level up front (replayable
  // with the rest of the run buffer by the unified /chats/:id/stream attach).
  if (args.routing) send('routing', args.routing);
  send('progress', { message: STATUS.orienting, stage: 'context' });

  // ── Dynamic roster: the TURN PLAN (phase 2, 2026-10-03 — owner chose option B,
  // docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md). ONE batched turn_plan ask per human
  // turn — lane (quick / standard / checked / research, asked in both option
  // orders) + stakes / live-web / contested / multi-step / breadth — fired NOW so
  // it runs alongside the context load. SHADOW: never awaited on the answer path;
  // the plan rides metadata.depth.turnPlan for the labels. ACT: only a confident
  // QUICK lane changes the run (below, at the plan point). Never a machine turn
  // or a Dig-deeper rung. TURN_PLAN_DISABLED=1 = no ask.
  // roster 2026-10-06 B-1 (label hygiene): NEVER on a supervisor-class chat — the plan
  // never acts there (turnPlanMayAct below), and its window-close "held" labels were
  // 59 % of the readiness sample. The chat's supervisor flags are read IN PARALLEL with
  // the prior-turn reads (off the answer path); a skip writes one turn_plan_hygiene row.
  // TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1 asks again, as segment 'supervisor' (the
  // readiness ruler's never-READY partition) with the record stamped supervisor:true.
  const turnPlanFiredAt = Date.now();
  // ── Session roster (roster 2026-10-06 D-1, chat-agent/session-roster.ts): the chat's persisted roster is read ONCE,
  // bounded (ROSTER_READ_TIMEOUT_MS), beside the turn plan. When it ACTS for the sender (store mode act, or a canary
  // user) the Quick guard's priorLane is the roster's session lane (hysteresis) and the model pick keeps the session's
  // lead within a margin; in shadow it is only recorded. Human turns on a chat row only; never throws.
  // SESSION_ROSTER_DISABLED=1 = no read, no write.
  const rosterTrace = newRosterTrace();
  const sessionRosterRead: Promise<RosterRead | null> = !machineTriggeredArgs && !args.escalation && chatId && userId
    ? readSessionRosterForTurn(chatId, userId).then((r) => (rosterTrace.read = r)).catch(() => null)
    : Promise.resolve(null);
  // Roster 2026-10-06 A-3: a plan the controller already asked (research routing) is reused — one ask per turn.
  const turnPlanPromise: Promise<TurnPlan | null> | null = (!machineTriggeredArgs && !args.escalation && !turnPlanDisabled())
    ? args.turnPlanPrefetched ? Promise.resolve(args.turnPlanPrefetched) : (async (): Promise<TurnPlan | null> => {
      const [priorRows, lastAnswer, turnIndex, chatFlags] = chatId
        ? await Promise.all([
          prisma.crossModelMessage.findMany({ where: { chatId, role: 'user' }, orderBy: { createdAt: 'desc' }, take: TURN_PLAN_PRIOR_TURNS, select: { content: true } }).catch(() => [] as Array<{ content: string }>),
          prisma.crossModelMessage.findFirst({ where: { chatId, role: 'assistant' }, orderBy: { createdAt: 'desc' }, select: { metadata: true } }).catch(() => null),
          prisma.crossModelMessage.count({ where: { chatId, role: 'user' } }).catch(() => 0),
          prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true, ghostMode: true } }).catch(() => null),
        ])
        : [[] as Array<{ content: string }>, null, 0, null] as const;
      const supervisorChat = chatFlags?.isSupervisor === true || chatFlags?.isProjectSupervisor === true;
      if (supervisorChat && !turnPlanSupervisorSkipDisabled()) {
        recordLoopMetric({ kind: TURN_PLAN_HYGIENE_KIND, sessionId: chatId ?? undefined, meta: { event: 'supervisor_skip', fleet: chatFlags?.isSupervisor === true } });
        return null;
      }
      // Ghost mode (owner 2026-10-22): the turn plan is a CLOUD decision call
      // carrying the message text — a ghost chat never sends its content to the
      // decision backend (privacy: the whole posture is "this content only
      // reaches the designated self-hosted endpoint"). Same hygiene-row shape.
      // integ/ghost-composer review fix: a chatId-less GHOST send (a guest, or
      // the signed-in createChat-failure fallback — args.ghost, no row to read)
      // skips it too — the row read never saw those. This per-send arm is
      // inert under CHAT_GHOST_MODE_DISABLED=1, like the run's own ghostRun.
      if (chatFlags?.ghostMode === true || (!chatId && args.ghost === true && !ghostModeDisabled())) {
        recordLoopMetric({ kind: TURN_PLAN_HYGIENE_KIND, sessionId: chatId ?? undefined, meta: { event: 'ghost_skip' } });
        return null;
      }
      const priorLane = turnPlanFromMetadata(lastAnswer?.metadata)?.lane ?? null;
      // roster 2026-10-06 D-1: the Quick guard reads the SESSION lane when the roster acts (the ask's state keeps the
      // last answer's own lane — the decision's inputs stay comparable with its calibration).
      const guard = guardPriorLane(await sessionRosterRead, priorLane);
      rosterTrace.legacyPriorLane = priorLane;
      rosterTrace.priorLaneRead = guard.lane;
      rosterTrace.source = guard.source;
      const images = args.userImages?.length ?? 0;
      const documents = Math.max(0, (args.attachmentMeta?.length ?? 0) - images) + (args.documentText ? 1 : 0);
      return decideTurnPlan(
        { message, priorUserTurns: [...priorRows].reverse().map(r => String(r.content ?? '')), images, documents, priorLane, turnIndex, ...(chatId ? { chatId } : {}), sessionId: chatId ?? undefined, segment: supervisorChat ? 'supervisor' : userId ? (args.channel === 'telegram' ? 'telegram' : 'user') : 'guest', userId: userId ?? null },
        { messageChars: String(message ?? '').length, images, documents, mode: String(mode), escalation: false, supervisor: supervisorChat, machine: false, requestedMode: String(mode), codeIntent: !!detectCodeIntent(String(message ?? '')), priorLane: guard.lane },
      );
    })().catch(() => null)
    : null;
  // 2026-10-20 (lane depth A-2 follow-up hysteresis): the session lane the checker drop reads is the SAME lane the
  // Quick guard read — rosterTrace.priorLaneRead, set by the in-run ask above. A plan the controller PREFETCHED (the
  // research route, A-3) skipped that read, so the last answer's lane is read here, beside the context load (one
  // indexed query), through the same guardPriorLane. Recorded apart from rosterTrace (which reports what the Quick
  // guard read). LANE_CHECKER_FOLLOW_UP_DISABLED=1 ⇒ no read (the checker drop then ignores the session anyway).
  let prefetchedSessionLane: Lane | null = null;
  const prefetchedSessionLaneRead: Promise<void> | null = args.turnPlanPrefetched && turnPlanPromise && chatId && !laneCheckerFollowUpDisabled()
    ? (async () => {
      const lastAnswer = await prisma.crossModelMessage.findFirst({ where: { chatId, role: 'assistant' }, orderBy: { createdAt: 'desc' }, select: { metadata: true } }).catch(() => null);
      prefetchedSessionLane = guardPriorLane(await sessionRosterRead, turnPlanFromMetadata(lastAnswer?.metadata)?.lane ?? null).lane;
    })().catch(() => undefined)
    : null;
  const laneSessionLane = (): Lane | null => rosterTrace.priorLaneRead ?? prefetchedSessionLane;
  // The lane the applied lane decision actually read (the finalize row reports THAT one, not a later read).
  let lanePriorUsed: Lane | null = null;
  // build 2026-10-08 A2b (coding/tool-diet.ts): a NON-blocking view of the plan for the lane-aware starting tool
  // set — the agent reads it at run start and again at run end; nothing waits on it here.
  let turnPlanSettled: TurnPlan | null = null;
  void turnPlanPromise?.then((p) => { turnPlanSettled = p; });

  // ── Shared chat context (bit-identical with the legacy pipeline) ────────────
  // MUST run BEFORE the user message persists: persisting first put the current
  // question into loaded history (models saw it twice) AND broke the new-chat
  // title gate (history was never empty again). Regression from the durability
  // fix — owner report 2026-07-14.
  // Deploy-interrupt resume (ticket 5ba5f03e): when this turn is a re-fire of
  // a deploy-killed attempt, its soft checkpoint renders into the context here
  // — one seam covering both the human and the machine re-fire paths.
  const resumeNote = args.resumeBrief ? renderResumeBriefNote(args.resumeBrief) : null;
  const additionalContext = [args.additionalContext, resumeNote].filter(Boolean).join('\n\n') || undefined;
  // Fleet-supervisor rebuild (2026-08-22): ONE early isSupervisor read, reused
  // by the title-pin gate below and the orchestrator profile selection — a
  // supervisor chat runs the raised SUPERVISOR budget, not the tight chat one.
  // 2026-09-08 capability doctrine: the SAME row read also yields the title for
  // the playbook's "This chat" line (zero extra round-trips) — kept only when it
  // is a REAL title (placeholders / stale shapes → null via isStaleChatTitle, the
  // one canonical stale-shape predicate).
  // Ticket a6ba3fda (2026-10-17): the read moved ABOVE buildChatQueryContext —
  // the context build needs isSupervisorChat so a PROJECTLESS supervisor chat
  // (the Fleet Supervisor's own chat, projectId null) also reads durable L3
  // memory. Same single read, same catch, no extra round-trip.
  const supervisorRow = chatId
    ? await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true, title: true, projectId: true, leadModel: true, ghostMode: true } }).catch(() => null)
    : null;
  // Ghost mode (owner 2026-10-22): a ghost chat's legs ALL run on the
  // admin-designated self-hosted endpoint, and its content never reaches the
  // cloud decision/title/label paths. `ghostRun` is the run-level truth: a
  // chat row's STORED flag when one exists (the posture is the session's, not
  // a per-send opt-out — the transcript must be consistently private), else
  // the per-send opt-in (GUESTS and chatId-less sends have no row). Guests
  // never persist anything new either way.
  const ghostRun = (supervisorRow ? supervisorRow.ghostMode === true : args.ghost === true) && !ghostModeDisabled();
  // Resolve the designation ONCE per run, up front: a resolvable spec routes
  // every leg below; anything else keeps the normal lineup and says so
  // honestly (never a throw — ghost must not brick the chat).
  const ghostEndpoint: ResolvedGhostEndpoint = ghostRun ? await resolveGhostEndpointForRun() : { spec: null, reason: 'unset', config: null };
  // Supervisor-class lanes: the FLEET supervisor (isSupervisor) AND a project's
  // dedicated supervisor (isProjectSupervisor, 2026-09-13) share the raised
  // budget, title pin, state doc, and evidence discipline gates below.
  const isFleetSupervisorChat = supervisorRow?.isSupervisor === true;
  const isProjectSupervisorChat = supervisorRow?.isProjectSupervisor === true;
  const isSupervisorChat = isFleetSupervisorChat || isProjectSupervisorChat;
  // ── Supervisor OWNER-turn reads (FS context map 2026-10-22, gaps #1 + #3) ──
  // Started HERE, before the context build, so they run concurrently with it
  // and with the state reads (review 2026-10-23 item 2: started after it they
  // sat serially on the critical path — an owner turn could wait ~5 s for the
  // ledger diff before the run began). Each is bounded by startOwnerTurnRead:
  // the turn waits for it until max(OWNER_TURN_READ_BOUND_MS 1.5 s from its
  // start, the moment the turn first asks for it) — it asks only after the
  // context build and the state reads, so a read slower than 1.5 s but faster
  // than those is kept for free (re-review 2026-10-23: the fixed timer started
  // with the read and dropped it at 1.5 s for nothing), and a read still
  // pending by then is dropped at once. The reads' own deadlines are only a
  // pathology ceiling (OWNER_TURN_READ_CEILING_MS). A dropped read resolves
  // null — the turn runs without that block — and is recorded below
  // (supervisor_owner_turn_context {failedOpen, which, timedOut}). Consumed in
  // the owner-turn block below (the reasoning lives there).
  const ownerTypedSupervisorTurn = isSupervisorChat && !!chatId && !!userId && !args.machineWake
    && (!args.messageOrigin || args.messageOrigin === 'user');
  const ownerHistoryV2On = ownerTypedSupervisorTurn && !ownerHistoryV2Disabled();
  const ownerLedgerDiffOn = ownerTypedSupervisorTurn && !ownerLedgerDiffDisabled();
  const ownerRowsRead: OwnerTurnRead<{ history: OwnerTurnRow[]; thread: OwnerTurnRow[] }> | null = ownerHistoryV2On && chatId
    ? startOwnerTurnRead(import('../platform/owner-turn-history.loader')
      .then((m: any) => (typeof m?.loadOwnerTurnRows === 'function' ? m.loadOwnerTurnRows(chatId, { excludeMessageId: args.recoveryForMessageId ?? null, timeoutMs: OWNER_TURN_READ_CEILING_MS }) : null)), OWNER_TURN_READ_BOUND_MS)
    : null;
  const ownerLedgerRead: OwnerTurnRead<{ block?: string }> | null = ownerLedgerDiffOn && chatId
    ? startOwnerTurnRead(import('../platform/supervisor-wake-ledger')
      .then((m: any) => (typeof m?.buildWakeLedgerBlock === 'function' ? m.buildWakeLedgerBlock(chatId, new Date(), { ownerTurn: true, timeoutMs: OWNER_TURN_READ_CEILING_MS }) : null)), OWNER_TURN_READ_BOUND_MS)
    : null;
  const ctx = await buildChatQueryContext({
    userId, chatId, message, mode, modelSet: 'open_source',
    additionalContext,
    sessionId: args.sessionId,
    // Machine wakes read a DEEPER history window (up to 24 messages, char-
    // bounded) — threaded into the upstream loaders because the final
    // slice(-24) below is a no-op when the loaders already trimmed to ~10
    // (audit p10: PR #190's deepening was dead in its target case).
    machineWake: args.machineWake,
    // Orphan-recovery re-fire: the recovered turn's own user row is already
    // persisted — exclude it from the history load (ChatAgentRunArgs).
    excludeMessageId: args.recoveryForMessageId,
    // Machine wakes: retrieval (memory relevance, project learnings, RAG)
    // embeds the PRE-preamble event/prompt text, not the 13–22k-char composed
    // wake — embedding + reranking the composed text took 27 s on a live wake
    // and tripped the learnings lookup's 6 s deadline on ~50% of machine turns.
    retrievalMessage: args.machineWakeOriginalMessage || undefined,
    // Projectless supervisor chats read durable L3 memory too (ticket a6ba3fda):
    // blended digby_memory search over the caller's OWNED projects + this chat's
    // own scope — the projectId gate in chat-context otherwise drops them.
    isSupervisorChat,
  });
  // Session titles (2026-09-27): a supervisor's title carries the CURRENT
  // wake's verb as its step half ("CanLaw Supervisor · sweep") — written at
  // wake start here, "idle since HH:MMZ" at the finalize. Best-effort, rate
  // limited, honours the pin; HARNESS_TITLE_SUPERVISOR_STEP_DISABLED=1 keeps
  // the bare role label.
  if (isSupervisorChat && chatId) {
    const wakeOrigin = args.machineWake === true ? (args.messageOrigin ?? 'schedule') : (args.messageOrigin ?? 'user');
    void import('../platform/session-titles')
      .then((m) => m.setSupervisorStep(chatId, m.supervisorStepFromWake({ message: args.message, origin: wakeOrigin }), { reason: 'wake', emit: (_t, d) => send('chat-title', { chatId, title: d?.title }) }))
      .catch(() => {});
  }
  // WI-G (2026-09-25): stamp what /drain-status reports per run — the deploy
  // drain's bounded retiring extension waits ONLY for supervisor-class machine
  // wakes that are still making tool calls. Same machine-flag expression the
  // run-lock claim uses. Registry no-op for a key that is not registered
  // (the interactive stream path runs this turn without a live-run slot).
  const runIsMachineTriggered = args.machineWake === true || machineOriginRun(args);
  // Hand-off polish (2026-09-28, audit CT-2 a): a HUMAN turn of a NON-supervisor
  // chat that STARTED a sub-session (a successful start_coding_session) ends
  // its tool loop after that round — one tools-off final that says the work
  // started and the card / Result row report back. Before this the spawn turn
  // stayed open ~7.5 min polling, read the chat 10 s after the hand-off row
  // landed and re-narrated it (a 10.5-min-TTFT duplicate answer). Machine
  // wakes (a supervisor's lanes), supervisor chats and Dig-deeper rungs keep
  // the full loop.
  const spawnEndsTurn = !runIsMachineTriggered && !isSupervisorChat && !args.escalation;
  // build 2026-10-08 A1 (owner-answer-first.ts): an OWNER turn on a supervisor chat — shadow records where it WOULD
  // split at the ~45 s soft deadline; act ends the tool rounds there and the rest runs as the follow-through
  // continuation. Machine wakes, Dig-deeper rungs and follow-through rounds themselves never resolve one.
  // SUPERVISOR_OWNER_ANSWER_FIRST = off | shadow | canary[:id8,…] (DEFAULT since 2026-10-10, ticket 4f7263e4) | act.
  const ownerAf: OwnerAnswerFirstResolution | null = isSupervisorChat && chatId && userId && !runIsMachineTriggered && !args.escalation && !args.continuation
    && (!args.messageOrigin || args.messageOrigin === 'user') // owner-TYPED only (an owner-dispatch agent send has nobody waiting here)
    ? resolveOwnerAnswerFirst(chatId, process.env, { continuationAvailable: !turnContinuationDisabled() && continuationMaxRounds() > 0 }) : null;
  const ownerAfObserver: AnswerFirstObserver | null = ownerAf && ownerAf.mode !== 'off'
    ? createAnswerFirstObserver({ act: ownerAf.mode === 'act', turnStartedAt: startedAt }) : null;
  const ownerAfAct = ownerAfObserver?.act === true;
  let spawnedSessionThisTurn: SpawnedSession | null = null;
  let spawnTurnEnded = false;
  if (chatId || args.sessionId) {
    // A continuation round stamps its stash + prompt + mode so the SIGTERM ritual
    // can requeue it as a CONTINUATION (review fix 3) — never a plain re-ask,
    // never a card left "running" forever.
    try { setRunMeta(chatAgentRunKey(args), { ...(chatId ? { chatId } : {}), machineTriggered: runIsMachineTriggered, isSupervisorWake: isSupervisorChat && runIsMachineTriggered, ...(args.escalation ? { escalation: args.escalation } : {}), ...(args.continuation ? { continuation: { stash: args.continuation, prompt: args.message, mode: String(args.mode) } } : {}) }); } catch { /* registry stamp is best-effort */ }
  }
  const doctrineChatTitle: string | null =
    typeof supervisorRow?.title === 'string' && supervisorRow.title.trim() && !isStaleChatTitle(supervisorRow.title, message)
      ? supervisorRow.title
      : null;

  // Supervisor state on OWNER-typed turns (remediation P2 spark B7): machine
  // wakes bake the durable [SUPERVISOR STATE] doc into the wake prompt
  // (startDetachedChatRun) — but an owner typing INTO the supervisor chat ran
  // WITHOUT it, so the supervisor answered the owner amnesic about its own
  // open directives (the 21:17Z incident conversation shape). Load the doc +
  // the live fleet-attention block into the system context for every
  // NON-machine-wake supervisor turn. Failures degrade to no block.
  let supervisorOwnerStateBlock = '';
  // LANE BOARD second seam (ticket 2c203dac): a machine-origin run that
  // arrives WITHOUT machineWake — a drained AGENT steer (the mishap wake: an
  // agent-sent nudge on a plain lane) — never enters the machineWake block
  // above, so it would still run with no live ledger. Same contract, same
  // kill switch, same failure posture: the block rides the SYSTEM context
  // (the doctrineSystemContext prepend below) instead of the wake prompt.
  let laneBoardSystemBlock = '';
  // ── Supervisor OWNER-turn context (FS context map 2026-10-22, gaps #1 + #3) ──
  // An OWNER-typed turn on a supervisor chat (never a machine wake, a drained
  // agent relay or a harness round) used to read the last 8 transcript rows
  // whatever their origin — ~75 min of the Fleet Supervisor's chat, mostly old
  // baked wake prompts — and none of the "what moved" diff wakes get.
  //  #1 its history is chosen BY ORIGIN from a deep window
  //     (platform/owner-turn-history.ts: owner turns + replies kept, wake
  //     prompts elided, ≤ 2 agent relays, char-bounded) and a compact
  //     [OWNER THREAD — last 48 h] block rides the system context
  //     (SUPERVISOR_OWNER_HISTORY_V2_DISABLED=1 restores the 8-row slice);
  //  #3 it reads the harness ledger diff as [SINCE YOUR LAST NOTE — harness
  //     diff] WITHOUT advancing the high-water mark — args.wakeLedgerAt stays
  //     unset, so the finalize records nothing and the next wake still sees
  //     every event — and each PROJECT STATUS line carries its age
  //     (SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED=1).
  // Both reads STARTED before buildChatQueryContext (above — review 2026-10-23
  // item 2: they ran serially after it and an owner turn could wait ~5 s on
  // the diff), each bounded to max(OWNER_TURN_READ_BOUND_MS, the moment it is
  // first awaited here) — startOwnerTurnRead; every piece fails open to the
  // pre-fix turn and every fail-open is recorded.
  let ownerLedgerBlock = '';
  if (isSupervisorChat && chatId && userId && !args.machineWake) {
    try {
      const ownerTurnKpis = await loadKpisForSupervisorChat({ projectId: isProjectSupervisorChat ? supervisorRow?.projectId ?? null : null, userId, fleet: isFleetSupervisorChat }).catch(() => []);
      supervisorOwnerStateBlock = formatStateForWake(await getSupervisorState(chatId), new Date(), { kpis: ownerTurnKpis, ...(ownerLedgerDiffOn ? { projectStatusAges: true } : {}) });
      // #3: the harness diff sits right above the state doc (a machine wake's order); read in parallel with the doc.
      if (ownerLedgerRead) ownerLedgerBlock = String((await ownerLedgerRead.value())?.block ?? '');
      if (ownerLedgerBlock) supervisorOwnerStateBlock = `${ownerLedgerBlock}\n\n${supervisorOwnerStateBlock}`;
      // Ticket a5b36dc6 — the SAME [PREEMPTED RUN — ACTION IN FLIGHT] guard
      // on an owner-typed turn into the supervisor chat: the owner's message
      // is usually the very preemption that interrupted the last sweep, so
      // this turn must see the live journal window before it answers "did my
      // thing go out?". Fail-open; same kill switch.
      const ownerInflight = await buildInflightPreemptBlock(chatId).catch(() => '');
      if (ownerInflight) supervisorOwnerStateBlock = `${ownerInflight}\n\n${supervisorOwnerStateBlock}`;
      // Fleet-wide attention is FLEET-scope only (reviewer P2-2): a project
      // supervisor's owner turn gets its OWN state doc, never the whole
      // fleet's attention noise (machine wakes already fleet-scope both blocks).
      if (isFleetSupervisorChat) {
        const attention = await buildFleetAttentionBlock(userId);
        if (attention) supervisorOwnerStateBlock += `\n\n${attention}`;
      }
      // (owner 2026-09-16) The [BOARD] block rides owner turns too: when the
      // owner asks "what's open?", the answer comes from the ledger the model
      // can SEE, not from a recalled status. Project scope for a project
      // supervisor (its own board), fleet scope for the Fleet Supervisor.
      const ownerTurnBoard = isProjectSupervisorChat && supervisorRow?.projectId
        ? await buildBoardDigestBlock({ scope: 'project', projectId: supervisorRow.projectId })
        : isFleetSupervisorChat ? await buildBoardDigestBlock({ scope: 'fleet', userId }) : '';
      if (ownerTurnBoard) supervisorOwnerStateBlock += `\n\n${ownerTurnBoard}`;
    } catch (err: any) {
      logger.warn(`chat-agent: supervisor state load failed for owner turn on ${chatId}: ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // The diff is its own switch: a failed / disabled state block never takes it down with it.
  if (ownerLedgerRead && !ownerLedgerBlock) ownerLedgerBlock = String((await ownerLedgerRead.value())?.block ?? '');
  if (ownerLedgerBlock && !supervisorOwnerStateBlock.includes(ownerLedgerBlock)) {
    supervisorOwnerStateBlock = supervisorOwnerStateBlock ? `${ownerLedgerBlock}\n\n${supervisorOwnerStateBlock}` : ownerLedgerBlock;
  }
  // #1: the origin-chosen history (used by the orchestrator input below) + the [OWNER THREAD] block.
  let ownerTurnHistoryV2: Array<{ role: 'user' | 'assistant'; content: string }> | null = null;
  if (ownerRowsRead) {
    try {
      const loaded = await ownerRowsRead.value();
      if (loaded && Array.isArray(loaded.history) && loaded.history.length) {
        const now = new Date();
        const sel = selectOwnerTurnHistory(loaded.history, { pendingNote: pendingConfirmationNoteFrom(ctx.conversationHistory) });
        ownerTurnHistoryV2 = sel.history;
        const entries = ownerThreadEntriesFromRows(Array.isArray(loaded.thread) ? loaded.thread : [], now);
        const thread = renderOwnerThreadBlock(entries, now, { inHistoryIds: sel.ownerRowIds });
        if (thread) supervisorOwnerStateBlock = supervisorOwnerStateBlock ? `${supervisorOwnerStateBlock}\n\n${thread}` : thread;
        const legacy = ctx.conversationHistory.slice(-8);
        recordLoopMetric({
          kind: 'supervisor_owner_turn_context', sessionId: chatId ?? undefined, value: sel.stats.chars,
          meta: {
            ...sel.stats, threadEntries: entries.length, threadChars: thread.length, ledgerDiffChars: ownerLedgerBlock.length,
            legacyRows: legacy.length, legacyChars: legacy.reduce((n, h) => n + String(h?.content ?? '').length, 0),
            fleet: isFleetSupervisorChat,
          },
        });
      }
    } catch (err: any) {
      ownerTurnHistoryV2 = null;
      logger.warn(`chat-agent: owner-turn history failed open for ${chatId}: ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // Re-review 2026-10-23: a read that failed open (the bound passed, it threw, or it answered null) used to
  // record nothing and log nothing — how often v2 / the diff fail open in prod was invisible. One
  // supervisor_owner_turn_context row per dropped read (value 0, meta.failedOpen — a delivered turn's row
  // carries the history chars), plus an info line. An empty answer (no rows yet, an empty diff) is an
  // answer; a null diff counts only where the diff runs on this process (wakeLedgerDiffActive — off, null
  // is its normal answer).
  for (const [which, read, nullIsFailure] of [
    ['rows', ownerRowsRead, true],
    ['ledger', ownerLedgerRead, wakeLedgerDiffActive()],
  ] as const) {
    if (!read) continue;
    const failOpen = ownerTurnReadFailOpen(which, read, { nullIsFailure });
    if (!failOpen) continue;
    recordLoopMetric({ kind: 'supervisor_owner_turn_context', sessionId: chatId ?? undefined, value: 0, meta: { ...failOpen, fleet: isFleetSupervisorChat } });
    logger.info(`chat-agent: owner-turn ${which} read failed open (${failOpen.reason}, waited ${failOpen.waitedMs ?? '?'} ms, asked at ${failOpen.askedAtMs ?? '?'} ms) for ${chatId} — the turn runs without that block`, { source: 'chat-agent' });
  }
  // LANE BOARD second seam (ticket 2c203dac) — the drain: a machine-origin run
  // WITHOUT machineWake (a drained agent steer — the mishap wake) gets its
  // lane board via the system context here. A supervisor chat is excluded
  // (its own [BOARD] already rides); a USER-anchored run is excluded (the
  // read-don't-recall doctrine is a machine-wake contract — the human is on
  // the turn); ownerDispatch runs (the owner's own relayed send) are excluded
  // the same way (machineOriginRun already folds that in).
  if (
    !args.machineWake
    && laneBoardSystemBlock === ''
    && chatId
    && !isSupervisorChat
    && !isProjectSupervisorChat
    && machineOriginRun(args)
    && process.env.LANE_BOARD_BLOCK_DISABLED !== '1'
  ) {
    laneBoardSystemBlock = await buildLaneBoardBlock(chatId).catch(() => '');
  }

  // ── STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21) ─────────────
  // The chat's PREVIOUS note, read once for a machine run the pre-delivery guard covers (the same
  // seam condition as the guard below — machine wakes + machine-triggered supervisor runs; a human
  // turn never reads it). Two consumers: (a) a STRUCK previous note puts a short [PRIOR NOTE STRUCK]
  // block in this turn's system context — acknowledge the flagged claims and re-run them with fresh
  // tool calls (chat e03452f4 answered the Fleet Supervisor's "step 1 first" with a verbatim copy of
  // its struck note); (b) the finalize compares the final note with it (detectStruckNoteRepeat) and
  // routes a near-verbatim re-post through the bounded reject-back ONCE — at most one reject-back per
  // struck note, ever (round 4: a copy that went through the check is SPENT). One indexed read; fail-open
  // (null). STRUCK_NOTE_REPEAT_DISABLED=1 + PRIOR_NOTE_STRUCK_BLOCK_DISABLED=1 ⇒ no read at all.
  // Round 2 (finding 8): SUPERVISOR-CLASS chats only (the Fleet Supervisor + project supervisors — the incident
  // surface and the block's wording); a plain chat's machine wake (a schedule_message firing on a user's chat) is
  // untouched — integrity-check wording never lands in a note the user reads as their own chat.
  const struckRepeatSeam = isSupervisorChat && (args.machineWake === true || runIsMachineTriggered) && !!userId && !!chatId;
  const priorNote: PriorNote | null = struckRepeatSeam && !(struckNoteRepeatDisabled() && priorNoteStruckBlockDisabled())
    ? await loadPriorAssistantNote(chatId!, new Date(startedAt))
    : null;
  const priorNoteStruckBlock = priorNote && !priorNoteStruckBlockDisabled() ? renderPriorNoteStruckBlock(priorNote) : '';

  // ── Model-roles resolution (Digby Edge) ─────────────────────────────────────
  // Each named SEAT resolves through the instance's admin-managed model-roles
  // config; unset roles keep the built-in lineup byte-identically. Resolved
  // ONCE per run (30s service cache behind it) so a mid-run config change
  // can't split one answer across lineups.
  const orchestratorSeatKey = isProjectSupervisorChat ? 'project_supervisor' : isFleetSupervisorChat ? 'supervisor' : 'chat_orchestrator';
  // ── Ghost mode routing (owner 2026-10-22; ONE-LEAD RULING 2026-11-03) ─────
  // A ghost run with a live designation puts its model legs on the designated
  // self-hosted model and CLEARS the custom fallbacks (a cloud fallback would
  // silently re-route a ghost turn's content to a provider API the admin never
  // chose). Since the owner's 2026-11-03 ruling a ghost run makes exactly ONE
  // such leg — the lead. The checker / council seats below are still resolved
  // (they are read by telemetry and the seat health checks) but NOTHING
  // spawns them on a ghost run: `ghostSingleModelPlan` collapses the depth plan
  // after every plan mutation and `shouldSpawnChecker` takes `ghost`.
  // No live designation → the normal seats resolve and the notice says why
  // (ghost never bricks the chat). The per-turn swappers (Quick lane, model
  // pick, role picks, lane checker) are pinned off below via the ghost pin,
  // the same rule as a chat lead pin.
  if (ghostEndpoint.spec) {
    logger.info(`chat-agent: ghost run — lead on ${ghostEndpoint.spec}, no checker / no council (one lead inference) (chat ${chatId ?? `guest/${args.sessionId ?? 'anon'}`})`, { source: 'chat-agent' });
    send('progress', { message: `Ghost mode — answering on the private endpoint (${ghostEndpoint.spec.split(':')[0]})…`, stage: 'context' });
  } else if (ghostRun) {
    const why = ghostEndpoint.reason === 'switch'
      ? 'Ghost mode is switched off on this instance'
      : ghostEndpoint.reason === 'disabled'
        ? 'Ghost mode has no endpoint enabled right now'
        : ghostEndpoint.reason === 'unresolvable'
          ? 'The ghost endpoint is unavailable — an admin needs to re-set it (Account → Admin → Endpoints → Model roles)'
          : 'No ghost endpoint is configured on this instance';
    logger.warn(`chat-agent: ghost run without a designation (${ghostEndpoint.reason}) — normal lineup (chat ${chatId ?? 'guest'})`, { source: 'chat-agent' });
    send('progress', { message: `${why} — continuing on the normal lineup.`, stage: 'context' });
  }
  const [seatOrchestrator, seatDoubleChecker, seatTripleChecker, orchestratorCustomFallback, doubleCheckerFallback, tripleCheckerFallback] = await Promise.all([
    // Supervisor chats resolve their OWN seat (owner 2026-09-10) — swapping the
    // supervisor to a different decoder than the lanes it audits is coverage,
    // not cosmetics. Default = kimi-k3 (byte-identical when unset).
    // Project-supervisor preflight 2026-09-14: a PROJECT supervisor resolves its
    // own 'project_supervisor' seat (default FOLLOWS the supervisor seat's
    // resolved model, so unset = byte-identical to before); the fleet chat
    // keeps 'supervisor'. Gives the layer that spawns/steers workers a knob
    // independent of the owner-facing fleet voice.
    // WI-O #4c (2026-09-25): a PLAIN chat's stored lead pick (set_chat_mode
    // leadModel / crossmodel_chats.leadModel) outranks the instance seat;
    // supervisor chats never honour it (chatLeadOverrideForRun) and the
    // servability pre-flight below runs on whatever resolved here, so a dead
    // pick fails fast with the same named-fix message as a dead seat.
    // Kill switch CHAT_LEAD_MODEL_OVERRIDE_DISABLED=1 ignores the column.
    // Ghost mode (owner 2026-10-22): a live ghost designation outranks every
    // seat and every pick — it IS the chat's model, all legs, by design.
    ghostEndpoint.spec
      ? Promise.resolve(ghostEndpoint.spec)
      : resolveRoleModelForRun(orchestratorSeatKey, ORCHESTRATOR_MODEL).then((seat) => {
      const override = chatLeadOverrideForRun(supervisorRow);
      if (override && override !== seat) logger.info(`chat-agent: chat ${chatId} lead override ${override} (instance seat ${seat})`, { source: 'chat-agent' });
      return override ?? seat;
    }),
    // Owner 2026-09-15: ONE secondary seat ("Double Checker") serves the Level 2
    // parallel answer AND the first Level 3 council chair; the "Triple Checker"
    // is the second council chair. (Was chat_cross_checker + council_logician
    // + council_professor — the legacy keys still resolve in the roles service.)
    ghostEndpoint.spec ? Promise.resolve(ghostEndpoint.spec) : resolveRoleModelForRun('double_checker', CROSS_CHECKERS[0]),
    ghostEndpoint.spec ? Promise.resolve(ghostEndpoint.spec) : resolveRoleModelForRun('triple_checker', COUNCIL_MODELS.glm),
    // Admin custom fallbacks ("add custom fallback", owner 2026-09-15): '' = none.
    // Ghost mode: no cloud fallbacks on a ghost run — a fallback would silently
    // re-route the ghost turn's content to a provider the admin never chose.
    ghostEndpoint.spec ? Promise.resolve('') : resolveRoleFallbackForRun(orchestratorSeatKey),
    ghostEndpoint.spec ? Promise.resolve('') : resolveRoleFallbackForRun('double_checker'),
    ghostEndpoint.spec ? Promise.resolve('') : resolveRoleFallbackForRun('triple_checker'),
  ]);
  // `let` (roster 2026-10-06 A-2): a lane-governed checked turn may take its checker from the checker pool.
  let crossCheckers = [seatDoubleChecker];
  const councilModels: Record<CouncilSeat, string> = { double_checker: seatDoubleChecker, triple_checker: seatTripleChecker };
  const councilFallbacks: Record<CouncilSeat, string> = { double_checker: doubleCheckerFallback, triple_checker: tripleCheckerFallback };
  // Non-image document/PDF text rides as a text block on the agent's user
  // message (mirrors the legacy synthesizeNode doc injection); images go
  // separately as userImages on the orchestrator.
  const queryMessage = args.documentText
    ? `${ctx.queryMessage}\n\n${args.documentText}`
    : ctx.queryMessage;

  // Durability: persist the user's message BEFORE any long-running agent work —
  // a crashed/killed run must never swallow what the user typed.
  // The row's createdAt is also the CONFIRMATION ANCHOR for this run
  // (userTurnAt — consequential platform tools confirm only from a NEW real
  // user turn; machine-triggered runs pass no anchor and fail closed).
  let userTurnAt: Date | undefined;
  let noActionNoteApplied = false; // FSN1021 — the no-action-tool note rides the Double Checker swaps
  let noActionNoteSince: Date | undefined; // FSN1021 review round 4: the receipt window a revision re-checks before keeping the line
  // 2026-10-22 owner-turn live-state read (unread-state-note.ts): human supervisor turns only; the line is the harness's alone.
  const unreadStateNoteScope = isSupervisorChat && !runIsMachineTriggered && !ownerStateReadRetryDisabled();
  let unreadStateNoteApplied = false;
  let userRowPersisted = false;
  // tt-rd audit 2026-09-27: the OWNER row on a supervisor chat — the ask the
  // finalize closes on reply (closeAskOnReply) or re-wakes on a harness envelope.
  let ownerTurnUserRowId: string | null = null;
  // build 2026-10-08 D-2: the row this turn answers — the tool-intent journal's idempotency anchor (a re-fire threads it as recoveryForMessageId).
  let intentAnchorRowId: string | undefined = args.recoveryForMessageId;
  if (chatId) {
    if (args.recoveryForMessageId) {
      // Orphan-recovery re-fire (ticket 68bc5aec): the user row was persisted
      // by the run that DIED — do NOT create a second one (double transcript),
      // and do NOT re-capture a supervisor directive (appendDirective is not
      // idempotent; the dead run ran it right after its persist, which the
      // row's existence proves). The sweeper threads the row's ORIGINAL
      // createdAt as args.userTurnAt so the confirmation anchor matches the
      // send the user actually made. The updatedAt bump below is kept (the
      // original persist bumped it; the assistant persist bumps it again).
      if (args.userTurnAt) userTurnAt = args.userTurnAt;
      if (isSupervisorChat && (!args.messageOrigin || args.messageOrigin === 'user')) ownerTurnUserRowId = args.recoveryForMessageId;
      await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    } else if (args.escalation) {
      // Dig deeper (compute policy): the question is the ORIGINAL user turn —
      // never re-persist it; the tap's arrival time is the confirmation anchor.
      if (args.userTurnAt) userTurnAt = args.userTurnAt;
      // Provisional `running` stamp on the ORIGINAL row (audit 2026-09-26
      // routing-unify-4): nextRungForMessage refuses a second tap while the rung
      // runs (no double quota spend) and a rung the deploy ritual cuts reads
      // 'interrupted' instead of silently re-offering the same chip.
      const esc = args.escalation;
      void prisma.crossModelMessage.findUnique({ where: { id: esc.ofMessageId }, select: { id: true, chatId: true, metadata: true } })
        .then(async (orig) => {
          if (!orig || orig.chatId !== chatId) return;
          const meta = (orig.metadata && typeof orig.metadata === 'object') ? orig.metadata as Record<string, any> : {};
          const depth = (meta.depth && typeof meta.depth === 'object') ? meta.depth : { plan: { preset: String(meta.mode ?? 'single_thinking'), spawnChecker: meta.mode === 'thinking', checkerWaitMs: 0, council: 'none', source: 'preset' } };
          await prisma.crossModelMessage.update({
            where: { id: orig.id },
            data: { metadata: { ...meta, depth: { ...depth, escalations: stampEscalation(depth.escalations, { rung: esc.rung, at: new Date().toISOString(), status: 'running' }) } } as object },
          });
        })
        .catch((err: any) => logger.warn(`chat-agent: escalation running-stamp failed for ${esc.ofMessageId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' }));
    } else if (args.continuation) {
      // Turn continuation (2026-09-28): the harness's own prompt is never a
      // transcript row — the human's ask already is; the result posts as a
      // new assistant message below. Unanchored (no userTurnAt) by design.
      //
      // MERGE-1 kill-window fix (2026-11-05): a continuation CAN be a drained
      // queue row, and this branch persists no user row for it to ride along
      // with — so consume its pending rows HERE. The harness prompt is not
      // owner content, so the consume is its own committed step: losing the
      // harness round is recoverable (the card settles), re-running it is not.
      await consumeDrainedPendingRows(args.drainedPendingIds).catch(() => {});
      await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    } else {
    // Fleet origin marking rides metadata.origin (machine wakes / agent turns
    // are distinguishable from the human's own messages in the fleet views).
    const originMetadata = args.messageOrigin
      ? { origin: args.messageOrigin, ...(args.originSourceChatId ? { sourceChatId: args.originSourceChatId } : {}) }
      : undefined;
    // Attachment chips (filename + type only — NEVER base64) ride alongside so
    // the fleet thread can render the files on the user row after a reload.
    // Shared-project author attribution (f89d1213): HUMAN-origin rows carry
    // metadata.authorId — the real sender (queue drains thread authorUserId;
    // see ChatAgentRunArgs). Machine rows (schedule/hook/agent/webhook) are
    // authored by no human and stay unstamped; their metadata.origin already
    // distinguishes them.
    const authorId = (!args.messageOrigin || args.messageOrigin === 'user')
      ? (args.authorUserId ?? userId)
      : null;
    // Child-session RELAY (ticket 327ff5e3 — residual of 1757b07d/739e8191):
    // a sub-session that FINISHES and reports back through send_chat_message
    // persists an '[AGENT-SENT MESSAGE]' user row with origin 'agent' — the
    // far more common shape than the auto-wired result hook, which is the
    // only path that ever stamped metadata.childResult. Without a stamp this
    // row (and the reply it opens) is machine noise to every consumer: in a
    // PLAIN chat the fleet thread's read-side flatten never runs, so the
    // frontend grouping probe (childResult === true) never fires and the
    // delivered result stays folded inside the collapsed machine accordion —
    // exactly the owner's complaint 1757b07d was filed for.
    //
    // Decided HERE, at persist time, so EVERY reader (plain chat, fleet
    // thread, minimal view) sees the marker without re-deriving lineage.
    // ONE indexed PK read, issued only for an agent send that actually names
    // a sender (never for a human/schedule/hook turn), and fail-CLOSED on any
    // lookup error: a lineage hiccup degrades to today's rendering, it never
    // breaks the send and never invents owner-facing content.
    const childRelayStamp = args.messageOrigin === 'agent' && args.originSourceChatId && chatId
      ? await isChildSessionRelaySend({
        targetChatId: chatId,
        sourceChatId: args.originSourceChatId,
        lookupSender: (senderId) => prisma.crossModelChat
          .findUnique({ where: { id: senderId }, select: { parentChatId: true } }),
      })
      : false;
    const userMetadata = {
      ...(originMetadata ?? {}),
      ...(args.attachmentMeta?.length ? { attachments: args.attachmentMeta } : {}),
      ...(authorId ? { authorId } : {}),
      // Owner-armed schedule firing (ticket 6ef770a1): the row's
      // metadata.scheduleOwnerArmed marks the wake as DELIVERED CONTENT the
      // owner asked for (promptSetBy 'user'), so the frontend renders the
      // machine turn EXPANDED + marked. Guarded on the 'schedule' origin —
      // a stray flag on any other origin must never stamp.
      ...(args.scheduleOwnerArmed && args.messageOrigin === 'schedule' ? { scheduleOwnerArmed: true } : {}),
      // Child→parent result-hook wake (ticket 56d6b204): metadata.childResult
      // marks the machine turn as a DELIVERED SUB-SESSION RESULT the owner is
      // waiting on, so the frontend renders it EXPANDED + "results"-marked
      // instead of folded behind the collapsed machine accordion. Guarded on
      // the 'hook' origin exactly like the schedule guard above — a stray
      // flag on any other origin must never stamp.
      ...(args.childResult && args.messageOrigin === 'hook' ? { childResult: true } : {}),
      // Child-session RELAY into this chat (ticket 327ff5e3): the SAME marker,
      // stamped at persist time when LINEAGE says the agent sender is this
      // chat's own child (isChildSessionRelay above). Adding it here — rather
      // than only on the fleet read path — is what makes a plain chat render
      // the delivered result; the hook guard above is untouched, so an
      // ordinary hook wake still never stamps.
      ...(childRelayStamp ? { childResult: true } : {}),
      // Owner-ask wake (fixer 2026-09-27, finding upward-chatter-1): the wake
      // envelope of an [OWNER ASK UNANSWERED] re-wake / [FOLLOW-THROUGH]
      // nudge is the group's ANCHOR row — metadata.ownerAskReply mounts the
      // turn EXPANDED so the owner sees the answer. Same 'hook' guard.
      ...(args.ownerAskMessageIds?.length && args.messageOrigin === 'hook' ? { ownerAskReply: true, ownerAskMessageIds: args.ownerAskMessageIds.map((id) => id.slice(0, 8)) } : {}),
      // Orphan-recovery machine re-fire (bb2eca92): the clean PRE-PREAMBLE
      // message rides the row so the sweeper can re-bake a fresh wake
      // (machineWake:true) instead of doubling the baked preamble above.
      ...(args.machineWakeOriginalMessage ? { machineMessage: args.machineWakeOriginalMessage } : {}),
    };
    // Compute policy `reask_5m` (cp/labels 2026-09-26, design §4 D2): a HUMAN
    // send ≤ 5 min after the chat's last answer labels THAT answer's decision.
    // `sentAt` is captured BEFORE the new user row exists so the read below can
    // never see this send as the "previous" row; fire-and-forget off the
    // request path, never a throw (COMPUTE_POLICY_LABELS_DISABLED=1).
    if (!runIsMachineTriggered && !isSupervisorChat && userId) {
      const sentAt = new Date();
      void import('./compute-policy-label-hooks')
        .then((m) => m.labelReaskForChat({ chatId, authorId, sentAt, sessionId: runSessionId }))
        .catch(() => {});
    }
    // MERGE-1 cutover kill-window fix (2026-11-05): when this turn carries
    // queued rows, the transcript row and their consumption commit as ONE
    // write. A kill before the commit leaves them queued (no loss); a kill
    // after leaves both effects exactly once (no duplication).
    const drainedPendingIds = Array.isArray(args.drainedPendingIds) ? args.drainedPendingIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    const userRow = await (drainedPendingIds.length
      ? createMessagesConsumingPending({
          messages: [{ chatId, role: 'user', content: message, ...(Object.keys(userMetadata).length ? { metadata: userMetadata } : {}) }],
          pendingIds: drainedPendingIds,
        }).then((rows) => rows[0] ?? null)
      : prisma.crossModelMessage.create({
          data: { chatId, role: 'user', content: message, metadata: Object.keys(userMetadata).length ? userMetadata : undefined },
        })
    ).catch((err: any) => { logger.warn(`chat-agent: user-message persist failed: ${err.message}`, { source: 'chat-agent' }); return null; });
    userRowPersisted = !!userRow;
    if (typeof (userRow as any)?.id === 'string') intentAnchorRowId = String((userRow as any).id);
    if (args.userTurnAt) userTurnAt = userRow?.createdAt ?? args.userTurnAt;
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    // Fleet-supervisor durable state (2026-08-22 rebuild): an OWNER message in
    // the supervisor chat is a DIRECTIVE — it must survive outside the 12-pair
    // transcript window the wakes reconstruct from. Machine/agent-originated
    // rows are NOT directives. Fire-and-forget: capture never delays the run.
    if (userRowPersisted && isSupervisorChat && userId && (!args.messageOrigin || args.messageOrigin === 'user')) {
      const ownerRowId = typeof (userRow as any)?.id === 'string' ? String((userRow as any).id) : null;
      ownerTurnUserRowId = ownerRowId;
      // The row id rides the capture (tt-rd audit 2026-09-27): a status
      // question is ledgered as kind:'ask' keyed on it, and closed when the
      // reply to THIS row lands.
      void appendDirective(chatId, userId, message, ownerRowId ? { messageId: ownerRowId } : {}).catch(() => {});
    }
    }
  } else if (args.userTurnAt) {
    // Anonymous/stream path: no message row — the request-arrival time IS the
    // user-turn anchor (the human's message triggered this run directly).
    userTurnAt = args.userTurnAt;
  }

  // Title for brand-new chats — generated UP FRONT from the question alone
  // (owner, 2026-07-16: the sidebar shouldn't wait for the answer). Fire-and-
  // forget; the 'chat-title' event renames the sidebar row live, and the value
  // is echoed as autoTitle on 'complete' for clients that only read that.
  // (Anonymous sessions have no sidebar — skip title generation.)
  // Title-pinning guards (2026-08-13, tickets ea2dde87/ca8c9400): a MACHINE-WAKE
  // first turn must not name a chat — wake content is not the human's intent.
  // Supervisor chats were retitled from their first wake ("Machine-Triggered Run
  // No User…", "Printing Press History Essay Completed" — prod, six flagged
  // rows), making the pinned supervisor unrecognizable; the replacement +
  // surviving-wiring cascade produced the duplicate-supervisor fleet incident.
  // And a supervisor chat's title is pinned BY DESIGN even when the human types
  // into it directly (the frontend recognizes it via isSupervisor).
  let autoTitle: string | null = null;
  let titlePinned = args.machineWake === true || !!args.escalation; // an escalation rung never renames the chat
  // Titling windows count HUMAN-VISIBLE turns, not raw rows (audit p10):
  // machine wakes persist a user+assistant row each, so a chat that woke 3+
  // times before the human's first real message had BOTH windows (empty-history
  // up-front; 1-4 repair) permanently closed — the sidebar kept its placeholder
  // forever, with no later turn able to fix it. Machine-origin rows are
  // excluded from the count; a failed count falls back to the raw history
  // length (the legacy gates).
  let humanTurnCount = ctx.conversationHistory.length;
  if (!titlePinned && userId && chatId && ctx.conversationHistory.length > 0) {
    // The just-persisted current row must not count toward the PRIOR window
    // (parity with ctx.conversationHistory, which was loaded pre-persist). On a
    // recovery re-fire the current row was never re-persisted — the exclusion
    // on the count removes it instead (same net window as the original send).
    const currentRowCounts = userRowPersisted && (!args.messageOrigin || args.messageOrigin === 'user') ? 1 : 0;
    humanTurnCount = await countHumanVisibleMessages(chatId, args.recoveryForMessageId)
      .then(n => Math.max(0, n - currentRowCounts))
      .catch(() => ctx.conversationHistory.length);
  }
  if (!titlePinned && userId && chatId && humanTurnCount === 0) {
    titlePinned = isSupervisorChat; // hoisted lookup (was a per-branch query)
  }
  // GUEST title (owner report 2026-09-26: "guest mode, chat title generation
  // didn't work"): the up-front chain below is gated on userId && chatId — a
  // guest run has neither, so a guest chat's sidebar row kept the raw first
  // message forever (the guest rail, ticket 63bb607f, only ever minted the
  // placeholder client-side). Generate the SAME title for the first guest turn
  // (empty session history), with no DB write: it ships as the 'chat-title'
  // event and as autoTitle on 'complete' — the client applies it to its
  // browser-local guest-session record. A chain slower than the run gets a
  // short bounded wait before 'complete' (GUEST_TITLE_COMPLETE_WAIT_MS) so the
  // echo is rarely null; the client keeps its placeholder when it is.
  let guestTitlePromise: Promise<string | null> | null = null;
  // Ghost mode (owner 2026-10-22): a ghost send never generates a CLOUD title
  // (generateTitle carries the message text to the Moonshot utility chain).
  // Ticket de60115d (2026-10-23, "ghost mode chat title not working"): the
  // original skip left the placeholder forever — a ghost turn now gets the
  // SAME title lifecycle through generateGhostTitle (the admin-designated
  // endpoint when one is live — it already sees the whole conversation — else
  // the hardened local cleaner; NEVER a cloud model).
  if (!userId && args.sessionId && humanTurnCount === 0 && !titlePinned && ghostRun) {
    const guestSid = args.sessionId;
    guestTitlePromise = moonshotIntegration.generateGhostTitle(message, '', ghostEndpoint.spec).then(t => {
      const title = String(t ?? '').trim();
      if (!title) {
        logger.warn(`chat-agent: guest ghost title returned empty for session ${guestSid.slice(0, 8)} — placeholder retained`, { source: 'chat-agent' });
        return null;
      }
      autoTitle = title;
      send('chat-title', { chatId: null, sessionId: guestSid, title });
      return title;
    }).catch((err: any) => {
      logger.warn(`chat-agent: guest ghost title failed for session ${guestSid.slice(0, 8)}: ${err?.message ?? err}`, { source: 'chat-agent' });
      return null;
    });
  } else if (!userId && args.sessionId && humanTurnCount === 0 && !titlePinned && !ghostRun) {
    const guestSid = args.sessionId;
    guestTitlePromise = moonshotIntegration.generateTitle(message, '').then(t => {
      const title = String(t ?? '').trim();
      if (!title) {
        logger.warn(`chat-agent: guest up-front title returned empty for session ${guestSid.slice(0, 8)} — placeholder retained`, { source: 'chat-agent' });
        return null;
      }
      autoTitle = title;
      send('chat-title', { chatId: null, sessionId: guestSid, title });
      return title;
    }).catch((err: any) => {
      logger.warn(`chat-agent: guest up-front title failed for session ${guestSid.slice(0, 8)}: ${err?.message ?? err}`, { source: 'chat-agent' });
      return null;
    });
  }
  if (userId && chatId && humanTurnCount === 0 && !titlePinned && ghostRun) {
    // Ticket de60115d: the ghost arm of the up-front title — the same
    // fire-and-forget shape + CAS write as the normal path below, but the
    // title comes from generateGhostTitle (the designated endpoint or the
    // local cleaner — NEVER the cloud utility chain). Same de60115d rationale
    // as the guest arm above.
    void moonshotIntegration.generateGhostTitle(message, '', ghostEndpoint.spec).then(async t => {
      if (!t) {
        logger.warn(`chat-agent: ghost up-front title returned empty for chat ${chatId} — placeholder retained`, { source: 'chat-agent' });
        return;
      }
      const current = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true } })
        .catch((err: any) => { logger.warn(`chat-agent: ghost up-front title read failed for chat ${chatId}: ${err?.message || err} — title write stood down`, { source: 'chat-agent' }); return null; });
      if (!current) return;
      if (!isStaleChatTitle(current.title, message)) {
        logger.info(`chat-agent: ghost up-front title for chat ${chatId} stood down — current title "${current.title}" is not stale`);
        return;
      }
      autoTitle = t;
      const titled = await prisma.crossModelChat.updateMany({ where: { id: chatId, userId, isSupervisor: false, title: current.title, ...titlePinGuard() }, data: { title: t } })
        .catch((err: any) => { logger.warn(`chat-agent: ghost title write failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }); return null; });
      if (titled && titled.count > 0) {
        send('chat-title', { chatId, title: t });
      } else if (titled) {
        const now = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true } }).catch(() => null);
        if (now && now.title !== current.title) {
          logger.info(`chat-agent: ghost up-front title for chat ${chatId} stood down — title changed to "${now.title}" mid-write`);
        } else {
          logger.warn(`chat-agent: ghost title write skipped for chat ${chatId} (0 rows — non-owner or supervisor-pinned)`, { source: 'chat-agent' });
        }
      }
    }).catch((err: any) => logger.warn(`chat-agent: ghost up-front title generation failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }));
  }
  if (userId && chatId && humanTurnCount === 0 && !titlePinned && !ghostRun) {
    // Fire-and-forget with NO caller-side race (ticket 26385762): generateTitle
    // never resolves '' (every failure path lands on _smartLocalTitle), so the
    // old 20s Promise.race only ever produced '' when the TIMER won — silently
    // dropping every title whose utility chain outlived it (DeepSeek 15s +
    // DashScope fallback another 15s ≈ 30s worst case by construction). The
    // result arrives via the 'chat-title' event + the autoTitle field on
    // 'complete', so a slow chain delays nothing user-facing — the race was
    // pure loss. Every remaining drop path now logs.
    void moonshotIntegration.generateTitle(message, '').then(async t => {
      if (!t) {
        logger.warn(`chat-agent: up-front title returned empty for chat ${chatId} — placeholder retained`, { source: 'chat-agent' });
        return;
      }
      // Compare-and-swap guard (PR #367 blocking review — turn-1 double-writer
      // race): the run-end repair below fires in the SAME run at
      // humanTurnCount === 0 and can write an answer-aware title while this
      // chain is still in flight (quick answer + ~30s title chain). Overwrite
      // ONLY a title that is still stale at write time — isStaleChatTitle
      // can't be expressed as a Prisma where, so: read, apply the shared
      // helper, then conditional-write with the read title as the CAS clause.
      const current = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true } })
        .catch((err: any) => { logger.warn(`chat-agent: up-front title read failed for chat ${chatId}: ${err?.message || err} — title write stood down`, { source: 'chat-agent' }); return null; });
      if (!current) return; // read failed (warned above) or chat gone — the run-end repair is the second chance
      if (!isStaleChatTitle(current.title, message)) {
        // Another writer (the run-end repair) already landed a real title —
        // expected benign outcome of the turn-1 overlap, so info NOT warn.
        logger.info(`chat-agent: up-front title for chat ${chatId} stood down — current title "${current.title}" is not stale`);
        return;
      }
      autoTitle = t;
      // updateMany with userId filter (legacy parity): no-ops for non-owners
      // (e.g. a project editor running a shared chat) instead of writing
      // someone else's title. isSupervisor:false keeps the Fleet Supervisor's
      // fixed label — a machine-turn prompt must never rename it. The
      // title:<read title> clause is the CAS write guard: if another writer
      // landed between our read and this write, count===0 and we stand down.
      const titled = await prisma.crossModelChat.updateMany({ where: { id: chatId, userId, isSupervisor: false, title: current.title, ...titlePinGuard() }, data: { title: t } })
        .catch((err: any) => { logger.warn(`chat-agent: title write failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }); return null; });
      if (titled && titled.count > 0) {
        send('chat-title', { chatId, title: t });
      } else if (titled) {
        // 0 rows is now ambiguous: the legacy non-owner/supervisor drop
        // (warn, unchanged) — or the title changed between our read and this
        // write (CAS stand-down, benign → info). Re-read to classify.
        const now = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true } }).catch(() => null);
        if (now && now.title !== current.title) {
          logger.info(`chat-agent: up-front title for chat ${chatId} stood down — title changed to "${now.title}" mid-write`);
        } else {
          logger.warn(`chat-agent: title write skipped for chat ${chatId} (0 rows — non-owner or supervisor-pinned)`, { source: 'chat-agent' });
        }
      }
    }).catch((err: any) => logger.warn(`chat-agent: up-front title generation failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }));
  }

  // ── Forced harness SERP: REMOVED (owner 2026-09-03) ────────────────────────
  // The eager B1 searchWithBrightData fire + peekSerpInjection handoff is gone
  // for the adult chat lane: every agentic model has its OWN web tools and the
  // chatDoctrine search-discipline paragraph tells it when memory is not
  // enough. Machine wakes already skipped the SERP (see machineWake). The kid
  // path (controller) keeps its deterministic searchWithBrightData injection.
  // Grounding rates are watched via the 'chat_search_usage' loop metric at
  // finalize.

  // ── Shared image description for the ensemble PEERS (owner 2026-09-03).
  // The L2 checker and both council colleagues receive attached images as
  // this text block — glm-5.3 is text-only, and the peer worker path forwards
  // no image parts even to vision-capable seats (deepseek-flash since
  // 2026-09-10); the orchestrator (kimi-k3) sees them
  // natively (userImages on runCodingAgent — unchanged). ONE describe hop per
  // run (the promise is cached), injected into peer prompts as an
  // [ATTACHED IMAGE — described by glm-5.3-flash] block. Per-image failures
  // degrade to an honest "description unavailable" note, never a silent drop.
  let sharedImageDescription: Promise<string> | null = null;
  const sharedImageBlock = (): Promise<string> => {
    const images = args.userImages;
    if (!images?.length) return Promise.resolve('');
    // Ghost mode (owner 2026-10-22): the describe hop ships the user's images
    // to the Image reader seat (a cloud model). A ghost run never does — the
    // peers get the same honest "attached but undescribed" note the per-image
    // failure path already uses; the designated endpoint either sees the
    // images itself (its own [vision] flag) or the user is told it can't.
    if (ghostRun) {
      return Promise.resolve(
        `[ATTACHED IMAGE${images.length > 1 ? 'S' : ''} — an image${images.length > 1 ? 's are' : ' is'} attached to this message, but this chat is in ghost mode and its images are never sent to the cloud image describer; if you cannot see ${images.length > 1 ? 'them' : 'it'} directly, say so honestly]\n`);
    }
    if (!sharedImageDescription) {
      sharedImageDescription = (async () => {
        const lines = await Promise.all(images.map(async (img, i) => {
          const label = `Image ${i + 1}${img.name ? ` (${img.name})` : ''}`;
          try {
            const desc = await describeImageWithVision(Buffer.from(img.data, 'base64'), img.mediaType, img.name || `image-${i + 1}`);
            return `${label}: ${desc}`;
          } catch (err: any) {
            logger.warn(`chat-agent: shared image description failed for image ${i + 1}: ${err?.message ?? err}`, { source: 'chat-agent' });
            return `${label}: (an image is attached to this message, but its description was unavailable — you cannot see it; say so honestly if it matters to the answer)`;
          }
        }));
        const plural = images.length > 1 ? 'S' : '';
        // Honest attribution: the Image reader SEAT's live model (admin-editable).
        const describer = await resolveVisionDescribeModel();
        return `[ATTACHED IMAGE${plural} — described by ${describer}; you cannot see the image${images.length > 1 ? 's' : ''} directly]\n${lines.join('\n')}\n[/ATTACHED IMAGE${plural}]\n`;
      })();
      sharedImageDescription.catch(() => {});
    }
    // Whole-hop failure (should be unreachable — per-image errors are caught):
    // still inject the honest attached-but-undescribed note.
    return sharedImageDescription.catch(() =>
      '[ATTACHED IMAGE — an image is attached to this message but its description was unavailable; you cannot see it]\n');
  };

  // Per-question latency classification (ticket 62761c89): reuse the auto
  // router's EXISTING triviality heuristic (no new classifier) — a question it
  // would route to L1 single_thinking is SIMPLE. Simple L2 runs stop waiting
  // on the cross-checker after CROSS_CHECK_SIMPLE_WAIT_MS and skip the step-0
  // reconcile wait; deep/council questions keep the full CROSS_CHECK_* caps.
  const regexSimpleQuestion = args.machineWake !== true
    && routeMessageHeuristic({ content: ctx.queryMessage, hasWorkspace: false }).level === 'single_thinking';
  let isSimpleQuestion = regexSimpleQuestion;
  // N4 (2026-09-25): the same judgment as a typed decision (purpose
  // checker_route, questions depth + needs_live_web) asked CONCURRENTLY with
  // the regex once the checker is known to run (below) — shadow never waits;
  // the outcome is labelled at finalize from what the turn actually did.
  let checkerRoutePromise: Promise<DecideResult | null> | null = null;
  let checkerRouteActed = false;
  let checkerEffort: 'high' | 'max' = 'max';

  // ── L2 cross-checkers — run IN PARALLEL with the orchestrator (2026-07-16;
  // was a serial blocking pre-step that added up to the full checker deadline
  // of dead wall-clock before synthesis). The orchestrator researches while
  // the checkers draft; their block is INJECTED into its loop when ready via
  // injectSystem, which blocks the final answer until the drafts are in.
  let checkersPromise: Promise<string> | null = null;

  // ── Digby Edge seat pre-flight (owner screenshot report 2026-09-04) ────────
  // A seat whose EFFECTIVE model is a built-in with no provider key on this
  // instance can only 401 — on a keyless Edge box that surfaced as a silent
  // 401 retry crawl ending in an opaque ⚠︎ note (orchestrator) or an error
  // note injected as a "draft" (checker). Fail fast and NAME the fix:
  // the orchestrator seat throws (the detached-run catch surfaces
  // SeatUnservableError verbatim); an unservable checker seat is SKIPPED with
  // an honest progress line instead of dispatching a doomed run. On an
  // instance with the provider keys set (prod) both checks are null — no-ops.
  const orchestratorSeatProblem = await seatUnservableReason(seatOrchestrator, runUserId);
  if (orchestratorSeatProblem) {
    throw new SeatUnservableError(`This instance cannot run the lead "Digby" seat${chatLeadOverrideForRun(supervisorRow) ? ` (this chat's lead-model override "${chatLeadOverrideForRun(supervisorRow)}")` : ''}: ${orchestratorSeatProblem}. An admin can assign a custom endpoint model to the seat (Account → Admin → Endpoints → Model roles) or set that API key in the backend environment.`);
  }
  // Owner 2026-09-22 ("we shouldn't have double checker run for machine
  // supervisors"): EVERY machine-origin turn skips the Level 2 checker — not
  // only schedule/webhook firings (machineWake) but hook wakes and agent-sent
  // messages too (messageOrigin 'hook' | 'agent'), which had been running the
  // full agentic checker ~100 times a day on supervisor chats and then
  // re-writing the note as "revised" with nobody reading it. A human-typed
  // turn (origin absent or 'user') keeps the independent second answer.
  // Kill switch: MACHINE_TURN_CROSSCHECK_ENABLED=1 restores the old gate.
  const machineTurnSkipsChecker = process.env.MACHINE_TURN_CROSSCHECK_ENABLED === '1'
    ? args.machineWake === true
    : (args.machineWake === true || machineOriginRun(args));

  // ── Compute policy: the turn's DepthPlan (2026-09-26, design §4 D0) ──────
  // The three levels survive as PRESETS (presetPlan(mode)); a human turn in a
  // plain chat asks the compute_policy gate (Module A) CONCURRENTLY with the
  // lead's start. Only a purpose CONFIGURED to act (decisionMode === 'act') is
  // awaited here — bounded by COMPUTE_PLAN_TIMEOUT_MS, with headers + 'init'
  // already out — because only an ACT plan can change the tuple that runs. In
  // SHADOW / OFF the preset runs AT ONCE (nothing sits on the first-token
  // path — design §4 D0 "off the request path"; review 2026-09-26 M4) and the
  // gate's answer (decisionId / answers / mode) is attached at finalize for
  // labels. The kill switch (COMPUTE_POLICY_DISABLED=1) and any error ⇒ the
  // preset, exactly today's tuple. An escalation run carries its own plan
  // (source 'escalation').
  // Owner 2026-09-26 ("default all chats to auto even supervisors and fleet
  // supervisors"): supervisor-class chats AND machine-triggered runs ask the
  // SAME gate now. Their fallback is the MACHINE preset (machinePresetPlan —
  // lead max, no checker, no wait, no council: byte-for-byte what such a run
  // got by construction before), and whatever the gate returns passes the
  // machine rails (applyMachineRails): never a checker WAIT (the stakes wait
  // is for humans), never an auto-started council, lead max (only the
  // wake_effort purpose lowers it), a checker only when the gate ACTED to add
  // one — it runs behind the answer and reconciles late. Shadow ⇒ the machine
  // preset. The segment ('supervisor' | 'machine' | 'user' | 'guest') rides
  // decideComputePlan → decide() as meta.segment on the decision, challenger
  // and (via the stash) outcome rows, and the 'compute_policy' row carries
  // machine + segment; the readiness ruler partitions machine / supervisor
  // rows into their own never-READY groups (decision-gate-fit
  // NON_HUMAN_SEGMENTS; audit 2026-09-26 — before that the ruler read only
  // the pooled decision_gate rows). COMPUTE_POLICY_MACHINE_DISABLED=1 keeps machine runs off
  // the gate (preset rails only). The `mode` a machine wake arrives with is
  // already its preset fallback (types.ts storedModeToPreset: a stored 'auto'
  // ⇒ the L2 preset; a legacy stored level ⇒ that level).
  const ghostSingleModel = ghostRun && !!ghostEndpoint.spec;
  const isCouncilMode = !ghostSingleModel && (mode === 'deep_research' || mode === 'deep_research_all');
  // The owner's stakes bound (STAKES_WAIT_MS env, default 90 s) and the D0 ask
  // ceiling are read PER RUN from the real gate (Module A) — never a boot-time const.
  const STAKES_WAIT_MS = stakesWaitMs();
  const COMPUTE_PLAN_TIMEOUT_MS = computePolicyTimeoutMs();
  const depthPreset = normalizeDepthPreset(mode);
  const planSegment: ComputeSegment = isSupervisorChat ? 'supervisor' : runIsMachineTriggered ? 'machine' : args.channel === 'telegram' ? 'telegram' : userId ? 'user' : 'guest';
  // The machine rails apply to a machine-triggered run that SKIPS the checker
  // by construction (the 2026-09-22 default). Under the legacy
  // MACHINE_TURN_CROSSCHECK_ENABLED=1 switch a hook / agent turn keeps its
  // preset checker + the old gate byte-for-byte — that turn takes the plain
  // preset path (still asked as machine:true for the row).
  const usesMachineRails = runIsMachineTriggered && machineTurnSkipsChecker;
  const machineRails = { answerFirstOff: answerFirstDisabled() };
  // Owner 2026-10-06: supervisor-class chats never run the Double Checker (compute-policy-wiring withoutSupervisorChecker).
  const supervisorNoChecker = isSupervisorChat && !supervisorCheckerSkipDisabled();
  const fallbackPlan = (reason?: string): DepthPlan => usesMachineRails
    ? machinePresetPlan(depthPreset, reason ? `machine ${reason}` : undefined)
    : (supervisorNoChecker ? withoutSupervisorChecker(presetPlan(depthPreset, reason)) : presetPlan(depthPreset, reason));
  let plan: DepthPlan = fallbackPlan();
  let planPromise: Promise<DepthPlan> | null = null;
  if (args.escalation) {
    plan = escalationPlan(args.escalation.rung, STAKES_WAIT_MS);
  } else if (!computePolicyDisabled() && !(runIsMachineTriggered && computePolicyMachineDisabled())) {
    // Ghost mode (owner 2026-10-22): the compute-policy gate is a CLOUD
    // decision call carrying the message text — a ghost chat never sends its
    // content to the decision backend. The preset runs, exactly the
    // gate-error path (privacy over depth-tuning; the roster picks are
    // ghost-pinned off below anyway).
    if (ghostRun) {
      logger.info(`chat-agent: ghost chat ${chatId ?? 'guest'} — compute-policy gate skipped (private posture)`, { source: 'chat-agent' });
    } else {
    try {
      const priorUserTurns = ctx.conversationHistory.filter(h => h.role === 'user').slice(-2).map(h => String(h.content || '').slice(0, 1000));
      planPromise = decideComputePlan({
        message: ctx.queryMessage.slice(0, 4000), priorUserTurns,
        attachmentCount: (args.userImages?.length ?? 0) + (args.attachmentMeta?.length ?? 0),
        chatId: chatId ?? undefined, userId: userId ?? undefined, guest: !userId,
        machine: runIsMachineTriggered, segment: planSegment,
        // A machine lane never earns a background council (the rails drop it anyway).
        requestedMode: mode, allowDeepResearch: !!userId && !runIsMachineTriggered, sessionId: runSessionId,
      })
        .then(p => (usesMachineRails ? applyMachineRails(p, machineRails) : p))
        // A compute_policy ACT plan never governs a machine / supervisor turn until
        // that segment has its own readiness (audit 2026-09-26 supervisors-auto-5).
        .then(p => ((usesMachineRails || isSupervisorChat) && !computePolicyMachineActEnabled() ? shadowMachineAct(p, fallbackPlan()) : p))
        .then(p => (supervisorNoChecker ? withoutSupervisorChecker(p) : p))
        .catch(() => fallbackPlan('preset (gate error)'));
      if (decisionMode(COMPUTE_POLICY_PURPOSE) === 'act') {
        const TIMED_OUT = Symbol('plan-timeout');
        const raced = await Promise.race([planPromise, new Promise<typeof TIMED_OUT>(res => setTimeout(() => res(TIMED_OUT), COMPUTE_PLAN_TIMEOUT_MS).unref())]);
        if (raced !== TIMED_OUT && raced && typeof raced === 'object') plan = raced as DepthPlan;
        else logger.info(`chat-agent: compute plan not in within ${COMPUTE_PLAN_TIMEOUT_MS}ms — preset ${mode} stands`);
      }
    } catch (err: any) {
      logger.warn(`chat-agent: compute plan failed (${err?.message ?? err}) — preset ${mode} stands`, { source: 'chat-agent' });
      plan = fallbackPlan('preset (gate error)');
    }
    }
  }
  // ── Dynamic roster: the QUICK lane (turn_plan in ACT, 2026-10-03) ─────────
  // Only a purpose CONFIGURED to act awaits the turn plan here — bounded by
  // what is left of TURN_PLAN_TIMEOUT_MS since it was fired before the context
  // load (usually already in); shadow never waits. A confident quick lane on an
  // eligible human turn swaps the preset for the Quick answers seat: Level 1
  // shape, no checker, the quick profile, thinking off. Supervisor chats,
  // machine turns, councils and Dig-deeper rungs never take it; an unservable
  // quick model keeps the preset. QUICK_LANE_DISABLED=1 kills it on its own.
  let turnPlan: TurnPlan | null = null;
  let quickLaneModel: string | null = null;
  // The act CANARY (2026-10-03 hardening): a listed user's eligible turn takes the Quick lane while the purpose is still shadow.
  // A chat PINNED to a lead model (crossmodel_chats.leadModel — the user's / owner's explicit pick) never takes an
  // automatic swap: neither the Quick lane nor the per-turn model pick (2026-10-04; explicit choices win).
  const chatLeadPinned = !!chatLeadOverrideForRun(supervisorRow);
  // Ghost mode (owner 2026-10-22): a ghost run with a LIVE designation is
  // pinned to it — the Quick lane, per-turn model pick, role picks and lane
  // checker never swap a leg off the designated model (they would re-route
  // ghost content to a cloud model). Same rule as a chat lead pin.
  const ghostPinned = ghostRun && !!ghostEndpoint.spec;
  const turnPlanMayAct = !!turnPlanPromise && !isSupervisorChat && !runIsMachineTriggered && !isCouncilMode && !args.escalation && !chatLeadPinned && !ghostPinned
    && (decisionMode(TURN_PLAN_PURPOSE) === 'act' || await turnPlanCanaryIncludes(userId ?? null).catch(() => false));
  // ── Lane depth (roster 2026-10-06 A-2 / A-4, platform/lane-depth.ts): on a human plain-chat turn the turn plan's LANE
  // may set the checker (standard ⇒ none, checked ⇒ one) and, with no usable answer, the lane fail-open runs "standard
  // on the seat". Per-feature store flags + the owner canary; every failure keeps the preset. Never a supervisor chat,
  // a machine wake, a Dig-deeper rung or a council run (the research LANE routes at the controller, A-3). A chat pinned
  // to a lead model keeps its pin (the pin is the lead MODEL, never the depth).
  // laneTurn = a human plain-chat turn the lane_depth row describes (a research-routed council included);
  // laneEligible = one whose checker / fail-open the lane may set (never a council run).
  const laneTurn = !!turnPlanPromise && !isSupervisorChat && !runIsMachineTriggered && !args.escalation;
  const laneEligible = laneTurn && !isCouncilMode;
  const laneAccess: LaneDepthAccess | null = laneTurn ? await laneDepthFor(userId ?? null).catch(() => null) : null;
  const laneAwait = laneEligible && !!laneAccess && (laneAccess.acts.checker || laneAccess.acts.failOpen);
  let laneDecision: LaneDepthRunDecision | null = null;
  if (turnPlanPromise && (turnPlanMayAct || laneAwait)) {
    const left = Math.max(0, TURN_PLAN_TIMEOUT_MS + 300 - (Date.now() - turnPlanFiredAt));
    const TP_TIMED_OUT = Symbol('turn-plan-timeout');
    const raced = await Promise.race([turnPlanPromise, new Promise<typeof TP_TIMED_OUT>(res => setTimeout(() => res(TP_TIMED_OUT), left).unref())]);
    if (raced !== TP_TIMED_OUT && raced) {
      turnPlan = raced as TurnPlan;
      if (turnPlanMayAct && turnPlan.act && turnPlan.roster?.lead) {
        const problem = await seatUnservableReason(turnPlan.roster.lead, runUserId).catch(() => 'servability probe failed');
        if (!problem) quickLaneModel = turnPlan.roster.lead;
        else logger.warn(`chat-agent: quick lane model ${turnPlan.roster.lead} unservable (${problem}) — preset ${mode} stands`, { source: 'chat-agent' });
      }
    } else if (raced === TP_TIMED_OUT) {
      logger.info(`chat-agent: turn plan not in within ${left}ms — preset ${mode} stands`);
    }
  }
  // Lane depth A-2 / A-4 (before the pick: the family guard below reads plan.spawnChecker). The Quick lane wins.
  if (laneAwait && laneAccess && !quickLaneModel) {
    // A prefetched plan's session-lane read ran beside the context load; a follow-up waits for it at most 300 ms (a slow
    // read = no hysteresis, never a slower turn). Every other turn reads whatever is already in.
    if (prefetchedSessionLaneRead && (turnPlan?.cls?.followUp ?? 0) >= QUICK_LANE_FOLLOW_UP_CEILING) {
      await Promise.race([prefetchedSessionLaneRead, new Promise<void>((res) => setTimeout(res, 300).unref())]);
    }
    lanePriorUsed = laneSessionLane();
    laneDecision = applyLaneDepth({ plan, turnPlan, access: laneAccess, eligible: true, priorLane: lanePriorUsed });
    if (laneDecision.applied) {
      plan = laneDecision.plan;
      mode = plan.preset;
      logger.info(`chat-agent: LANE DEPTH ${laneDecision.applied} — lane ${plan.lane}, checker ${plan.spawnChecker ? 'on' : 'off'} (${laneDecision.why})`, { source: 'chat-agent' });
    }
  }
  // Integration order (roster 2026-10-06): lane depth (A) → session sticky lead (D) → role picks (C) → family guard + lead pick.
  // roster 2026-10-06 D-1: the SESSION's lead stays when the pick would swap it for a model only marginally better
  // (a lead swap throws the provider's prompt cache away) — only when the roster acts for this sender; the family guard
  // below still applies. SESSION_ROSTER_STICKY_LEAD_DISABLED=1 never sticks.
  if (turnPlan?.modelPick && rosterTrace.read?.acts && rosterTrace.read.roster?.last.lead && !stickyLeadDisabled()) {
    const sticky = applyStickyLead(turnPlan.modelPick, rosterTrace.read.roster.last.lead);
    if (sticky.stuck) {
      rosterTrace.sticky = sticky.stuck;
      turnPlan = { ...turnPlan, modelPick: { ...turnPlan.modelPick, ...sticky.pick } };
    }
  }
  // ── ROLE picks (roster 2026-10-06 C-3, platform/role-pick.ts): the Quick model, the Double Checker and the council
  // colleagues chosen per turn from their Auto pools with the lead pick's utility (quality − wait − failures − cost)
  // and the family rule (a checker / colleague never shares the lead's family). Store mode `rolePick` (shadow by
  // default: recorded as `role_pick` loop metrics, never awaited) + the `rolePickCanaryUserIds` canary; an ACTING turn
  // waits ≤ ROLE_PICK_WAIT_MS, else the seats run. Human plain chats only — never a supervisor chat, a machine turn
  // or a chat pinned to a lead model. ROLE_PICK_DISABLED=1 = seats only. Every picked model falls back to its seat.
  let rolePicks: RolePickResult | null = null;
  // Checker fallback: the admin's custom fallback for the seat, or the SEAT itself once a picked checker runs.
  let checkerFallbackModel = doubleCheckerFallback;
  // Which harness pick replaced the seat checker this turn (role pick C-3 wins over the lane pool A-2); null = the seat.
  let checkerPickedBy: 'role' | 'lane' | null = null;
  if (!isSupervisorChat && !runIsMachineTriggered && !chatLeadPinned && !ghostPinned) {
    const rawLead = quickLaneModel ?? (turnPlan?.modelPick?.act && turnPlan.modelPick.changed ? turnPlan.modelPick.spec : seatOrchestrator);
    const rolePickReq: RolePickRequest = {
      userId: userId ?? null, lead: rawLead, stakes: turnPlan?.cls?.stakes ?? null, images: (args.userImages?.length ?? 0) > 0,
      quick: quickLaneModel ? { seat: quickLaneModel } : null,
      checker: plan.spawnChecker && !quickLaneModel ? { seat: seatDoubleChecker } : null,
      colleagues: isCouncilMode ? [{ slot: 'double_checker', seat: seatDoubleChecker }, { slot: 'triple_checker', seat: seatTripleChecker }] : null,
      sessionId: runSessionId, lane: quickLaneModel ? 'quick' : (turnPlan?.lane ?? null),
    };
    if (rolePickReq.quick || rolePickReq.checker || rolePickReq.colleagues) {
      const rpDecision = await rolePickDecision(userId ?? null).catch(() => null);
      if (rpDecision?.acts) rolePicks = await resolveRolePicksBounded(rolePickReq);
      else if (rpDecision && rpDecision.mode !== 'off') void resolveRolePicks(rolePickReq).catch(() => null); // shadow: record only
    }
    const quickPicked = actingSpec(rolePicks, rolePicks?.quick);
    if (quickPicked && quickLaneModel) {
      const problem = await seatUnservableReason(quickPicked, runUserId).catch(() => 'servability probe failed');
      if (!problem) {
        logger.info(`chat-agent: ROLE PICK — Quick lane on ${quickPicked} instead of ${quickLaneModel} (${rolePicks!.quick!.reason})`, { source: 'chat-agent' });
        quickLaneModel = quickPicked;
      } else logger.warn(`chat-agent: role-picked Quick model ${quickPicked} unservable (${problem}) — ${quickLaneModel} stands`, { source: 'chat-agent' });
    }
    const checkerPicked = actingSpec(rolePicks, rolePicks?.checker);
    if (checkerPicked && rolePickReq.checker) {
      const problem = await seatUnservableReason(checkerPicked, runUserId).catch(() => 'servability probe failed');
      if (!problem) {
        logger.info(`chat-agent: ROLE PICK — ${SEAT_LABELS.double} on ${checkerPicked} instead of ${seatDoubleChecker} (${rolePicks!.checker!.reason})`, { source: 'chat-agent' });
        crossCheckers[0] = checkerPicked;
        checkerFallbackModel = seatDoubleChecker;
        checkerPickedBy = 'role';
      } else logger.warn(`chat-agent: role-picked checker ${checkerPicked} unservable (${problem}) — the seat checks`, { source: 'chat-agent' });
    }
    for (const c of rolePicks?.colleagues ?? []) {
      const spec = actingSpec(rolePicks, c.pick);
      const slot = c.slot as CouncilSeat;
      if (!spec || !(slot in councilModels)) continue;
      const problem = await seatUnservableReason(spec, runUserId).catch(() => 'servability probe failed');
      if (problem) { logger.warn(`chat-agent: role-picked colleague ${spec} unservable (${problem}) — the ${slot} seat runs`, { source: 'chat-agent' }); continue; }
      logger.info(`chat-agent: ROLE PICK — council ${slot} on ${spec} instead of ${councilModels[slot]} (${c.pick.reason})`, { source: 'chat-agent' });
      councilFallbacks[slot] = councilModels[slot];
      councilModels[slot] = spec;
    }
  }
  // ── Per-turn MODEL PICK (2026-10-04, platform/model-pick.ts; owner: "shouldn't the decision model decide any model
  // it wants for the specific task") — on a standard / checked turn the turn plan names the best MEASURED open model
  // for the task; when that pick ACTS (store mode act, or a canary user in shadow) it leads instead of the seat. The
  // seat finishes the turn if the picked model fails (fallback chain below). AUTO_MODEL_PICK_DISABLED=1 kills it.
  let pickedLeadModel: string | null = null;
  // A turn that will run the Double Checker keeps the second opinion INDEPENDENT (2026-10-05): the pick never shares
  // the checker's model family (platform/model-pick.ts pickAvoidingFamily; MODEL_PICK_CHECKER_FAMILY_GUARD_DISABLED=1).
  const turnPick = turnPlan?.modelPick && plan.spawnChecker && !checkerFamilyGuardDisabled()
    ? pickAvoidingFamily(turnPlan.modelPick, modelFamily(crossCheckers[0] ?? seatDoubleChecker), modelFamily)
    : turnPlan?.modelPick ?? null;
  // The answer row records the guarded pick (what the turn actually led with), not the raw one.
  if (turnPlan?.modelPick && turnPick && turnPick !== turnPlan.modelPick) turnPlan = { ...turnPlan, modelPick: { ...turnPlan.modelPick, ...turnPick } };
  // turnPlanMayAct (roster 2026-10-06): the lane-depth await may fill turnPlan on a PINNED chat — the pick never swaps a pin.
  if (!quickLaneModel && turnPlanMayAct && turnPlan?.modelPick?.act && turnPick?.changed && turnPick.spec !== seatOrchestrator && !ghostPinned) {
    const problem = await seatUnservableReason(turnPick.spec, runUserId).catch(() => 'servability probe failed');
    if (!problem) {
      pickedLeadModel = turnPick.spec;
      logger.info(`chat-agent: MODEL PICK — ${pickedLeadModel} leads instead of ${seatOrchestrator} (${turnPick.reason})`, { source: 'chat-agent' });
    } else {
      logger.warn(`chat-agent: picked model ${turnPick.spec} unservable (${problem}) — the seat leads`, { source: 'chat-agent' });
    }
  }
  // roster 2026-10-06 C-4 (coding/web-tool-cap.ts): the Quick lane's harness web budget — 1 search + 1 page read, then
  // answer. Store mode `quickWebCap` (shadow by default: counted only) + `quickWebCapCanaryUserIds`;
  // QUICK_LANE_WEB_CAP_DISABLED=1 = off.
  let quickWebCaps: WebToolCaps | null = null;
  let quickWebCapCanary = false;
  if (quickLaneModel) {
    const d = await quickWebCapDecision(userId ?? null).catch(() => null);
    if (d && d.mode !== 'off') { quickWebCaps = quickWebToolCaps(d.acts ? 'act' : 'shadow'); quickWebCapCanary = d.canary; }
  }
  if (quickLaneModel) {
    logger.info(`chat-agent: QUICK lane — ${quickLaneModel} (preset ${mode} → single_thinking; ${turnPlan?.reason ?? ''})`, { source: 'chat-agent' });
    mode = 'single_thinking';
    plan = { ...plan, preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', lane: 'quick' };
  }
  // ── GHOST = ONE LEAD INFERENCE (owner ruling 2026-11-03) ──────────────────
  // HARD short-circuit, placed AFTER every plan mutation above (the
  // compute-policy gate, the Dig-deeper rung, lane depth, the Quick lane) and
  // BEFORE anything below reads the plan to decide the roster — the checker
  // decision (`shouldSpawnChecker`), the checker_route ask, the checker spawn
  // and every checker status line / pill all sit downstream of this line.
  //
  // Why it is needed at all: #1888 routed EVERY ghost leg to the designated
  // endpoint but still RAN them, so a ghost 'thinking' turn spawned a Double
  // Checker (the plan said `spawnChecker: true` from the preset, and the seat
  // resolved to the ghost spec) and streamed "Digby is digging in — the Double
  // Checker is researching alongside…". The owner retired that on 2026-11-03:
  // ghost mode must make ONE private inference on the abliterated endpoint and
  // nothing else — no checker, no ensemble, no council, whatever the depth,
  // the routing or the decision gate asked for.
  //
  // `ghostRun && ghostEndpoint.spec` (NOT plain `ghostRun`): with no live
  // designation the chat keeps the normal lineup and the honest notice — the
  // privacy posture never bricks the chat (the long-standing ghost rule).
  // (`ghostSingleModel` itself is declared above, beside `isCouncilMode`.)
  if (ghostSingleModel) {
    const before = `preset ${plan.preset}, checker ${plan.spawnChecker ? 'on' : 'off'}, council ${plan.council === 'none' ? 'none' : plan.council}`;
    plan = ghostSingleModelPlan(plan);
    logger.info(`chat-agent: GHOST one-lead-inference — ${before} collapsed to a single answer on ${ghostEndpoint.spec} (chat ${chatId ?? `guest/${args.sessionId ?? 'anon'}`})`, { source: 'chat-agent' });
  }
  // Lane depth A-2: a lane-checked turn takes its checker from the checker POOL in a different family than the lead
  // (the pool follows the double_checker seat until an admin configures one ⇒ the seat; any error ⇒ the seat).
  // Roster C-3 (Team C's utility pick for the checker) replaces laneCheckerModelFor at this seam.
  let laneCheckerSpec: string | null = null;
  if (laneDecision?.applied === 'checker' && plan.spawnChecker && checkerPickedBy !== 'role' && !ghostPinned) {
    const lc = await laneCheckerModelFor(pickedLeadModel ?? seatOrchestrator, seatDoubleChecker).catch(() => null);
    if (lc && lc.spec !== seatDoubleChecker) {
      const problem = await seatUnservableReason(lc.spec, runUserId).catch(() => 'servability probe failed');
      if (!problem) {
        crossCheckers = [lc.spec];
        laneCheckerSpec = lc.spec;
        checkerPickedBy = 'lane';
        checkerFallbackModel = doubleCheckerFallback || seatDoubleChecker;
        logger.info(`chat-agent: LANE checker ${lc.spec} instead of the seat ${seatDoubleChecker} (${lc.why})`, { source: 'chat-agent' });
      }
    }
  }
  // A pool checker that fails falls back to the admin's custom fallback, else the double_checker seat itself (fail-open).
  // (the shared checkerFallbackModel above: a picked checker — role or lane pool — falls back to the custom fallback, else the seat.)
  const budget: DepthBudget = depthBudgetFor(plan);
  // Dig-deeper RESEARCH rung (audit H2, 2026-09-26): the council runs INLINE
  // on the tapper's stream (mode='deep_research' from the controller; nothing
  // consumes `plan.council:'background'`), so `budget.maxBackgroundMs` is
  // enforced through the council profiles' FINAL-TURN deadline — the lead
  // gets the budget, a colleague / clone what is LEFT of it at dispatch. The
  // L3 PRESET is untouched (plain backstops). No USD hook exists since
  // 2026-09-27 (owner: no hidden cost caps). DEPTH_BUDGET_DISABLED=1
  // restores the previous behaviour.
  const researchRungBudgeted = args.escalation?.rung === 'research' && !researchRungBudgetDisabled();
  // Deep research has NO wall clock (owner 2026-10-20, council-dispatch.ts researchNoWallClock): the preset, the
  // research lane and the rung run unclocked — no rung rail, no colleague fit, no per-attempt fit, no council deadline;
  // the stream stall watchdog + the progress-based dispatch wait + the step caps bound the council instead.
  // RESEARCH_NO_WALL_CLOCK_DISABLED=1 ⇒ every clock below exactly as before.
  const researchUnclocked = researchNoWallClock();
  // The rung's wall-clock rail also honours the umbrella DEPTH_BUDGET_BACKGROUND_BOUND_DISABLED (maxBackgroundMs applied nowhere).
  const rungDeadlineArmed = !researchUnclocked && researchRungBudgeted && !depthBudgetBackgroundBoundDisabled();
  // audit 2026-10-08 W4-8 (council-dispatch.ts fitColleagueDeadline): on the rung a colleague / clone deadline is also
  // fitted inside the lead's dispatch wait so its forced final report lands BEFORE the wait ends.
  const rungColleagueFit = rungDeadlineArmed && !researchRungColleagueFitDisabled();
  // The preset's per-attempt colleague fit (dispatch closure below) — off on a budgeted rung (its own fit) and under the switch.
  const presetAttemptFit = !researchUnclocked && !rungDeadlineArmed && !councilPresetColleagueFitDisabled();
  const councilDeadlineFor = (kind: 'lead' | 'colleague' | 'clone'): number | undefined => {
    if (researchUnclocked) return undefined;
    // The preset (no rung budget): colleagues / clones are still fitted inside the 12-min dispatch wait — their plain
    // 30 / 15-min backstops guaranteed a timeout + restart (council-dispatch.ts councilPresetColleagueFitDisabled).
    if (!rungDeadlineArmed) return kind !== 'lead' && !councilPresetColleagueFitDisabled() ? fitColleagueDeadline(councilBackstopMs(kind)) : undefined;
    const ms = researchRungDeadlineMs(councilBackstopMs(kind), budget, Date.now() - startedAt, false);
    return rungColleagueFit && kind !== 'lead' ? fitColleagueDeadline(ms) : ms;
  };
  // The checker-side bounds (audit 2026-09-26, settings-switches-5): the knob
  // was stamped on every row and applied nowhere. It now bounds the Double
  // Checker's harness kill (+ its 300 s self-wrap) and the late reconcile wait
  // THROUGH their existing cap (CROSS_CHECK_HARD_MS), never past it — the
  // default equals the cap, so nothing changes unless an operator shortens the
  // env. DEPTH_BUDGET_BACKGROUND_BOUND_DISABLED=1 (or DEPTH_BUDGET_DISABLED=1)
  // ⇒ the caps alone; the same switch also unarms the research rung's council
  // deadline above.
  const checkerBound = backgroundBoundMs(budget, CROSS_CHECK_HARD_MS);
  const checkerHardMs = checkerBound.ms;
  // The Dig-deeper research rung is the ONE background council today (nothing
  // consumes `plan.council:'background'`); its lead bound is the rail above.
  const isBackgroundCouncil = isCouncilMode && args.escalation?.rung === 'research';
  const councilLeadBound: { ms: number; source: 'depth_budget' | 'cap' | 'disabled' } = (() => {
    if (!isBackgroundCouncil) return { ms: COUNCIL_LEAD_BACKSTOP_MS, source: 'cap' as const };
    // No wall clock: the rung's lead runs unbounded (the telemetry row stamps backgroundBoundMs null).
    if (researchUnclocked) return { ms: Number.POSITIVE_INFINITY, source: 'disabled' as const };
    const ms = councilDeadlineFor('lead');
    if (ms === undefined) return { ms: COUNCIL_LEAD_BACKSTOP_MS, source: 'disabled' as const };
    return { ms, source: ms < COUNCIL_LEAD_BACKSTOP_MS ? 'depth_budget' as const : 'cap' as const };
  })();
  // A machine-triggered run whose plan the gate ACTED to give a checker
  // (post-rails): the checker runs BEHIND the answer — answer-first, wait 0.
  const gateSpawnedOnMachine = machineGateSpawnsChecker(plan, usesMachineRails);
  // ANSWER-FIRST (design §5 step 1): the lead never blocks on the Double
  // Checker — except the stakes path (plan.checkerWaitMs ≤ STAKES_WAIT_MS) —
  // and the delivered row is revised late. Only a PERSISTED row can receive a
  // late revision, so guests (no chatId) keep today's bounded behaviour, and
  // ANSWER_FIRST_DISABLED=1 restores today's 300 s gate byte-for-byte.
  const answerFirst = !answerFirstDisabled() && !!chatId && (!machineTurnSkipsChecker || gateSpawnedOnMachine);
  // Checker spawn keys on the PLAN (design §5 step 1: "no longer keyed on
  // mode==='thinking'") — the L2 preset says spawn, the L1 preset says not,
  // the gate in ACT may flip either way; the council never spawns; a machine
  // turn spawns ONLY a checker the gate acted to add (never from its preset).
  const wantsChecker = shouldSpawnChecker({ plan, machineTurnSkipsChecker: machineTurnSkipsChecker && !gateSpawnedOnMachine, checkerSeatProblem: null, isCouncil: isCouncilMode, ghost: ghostSingleModel });
  const checkerSeatProblem = wantsChecker
    ? await seatUnservableReason(crossCheckers[0], runUserId)
    : null;
  if (checkerSeatProblem) {
    logger.warn(`chat-agent: cross-checker seat skipped — ${checkerSeatProblem}`, { source: 'chat-agent' });
    // The admin detail (no servable model on the Double Checker seat — assign one under Account → Admin →
    // Endpoints → Model roles) is on that page's seat badge; the user line stays plain (status-voice.ts).
    send('progress', { message: STATUS.checker.unavailable, stage: 'query' });
  }
  const spawnChecker = wantsChecker && !checkerSeatProblem;
  // The pill state this turn ends in (metadata.check + the check_state event).
  let checkState: CheckStatePayload | null = null;
  // drafts_agree at first answer (D1): the decision + whether it ACTED (skipped
  // the reconcile) — labelled from the reconcile's own material verdict.
  let draftsAgreeResult: Awaited<ReturnType<typeof decideDraftsAgree>> | null = null;
  let draftsAgreeActed = false;
  if (args.escalation?.rung === 'research') {
    // Ghost = one lead inference (owner ruling 2026-11-03): the collapse above
    // forced council 'none' and `isCouncil` is false, so no research rung runs —
    // this line would promise "Deeper findings will post here" and then never
    // post them. Same defect class as the Double Checker banner: a status line
    // advertising a second model that is not going to run. Say nothing instead;
    // the ghost notice already explains that one private answer is coming.
    if (!ghostSingleModel) send('progress', keyedProgress('deeper_findings_started'));
  } else if (plan.source === 'gate_act' && !plan.spawnChecker && plan.preset === 'thinking') checkState = { state: 'skipped' };

  // N4 checker-site router (shadow by default): fire the typed request now,
  // beside the regex verdict already taken. Only human Level 2 turns that
  // actually run the checker are judged (a machine turn / unservable seat
  // has nothing to place). Fail-open: any error ⇒ the regex stands.
  // roster 2026-10-06 B-2: retired on HUMAN turns (AUROC 0.553 on the 2026-10-06 readout; the regex placed the
  // checker on every human turn in shadow) — a human turn answers as OFF (the regex verdict stands) with one
  // decision_ask_retired row. Kill switches: DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 /
  // DECISION_GATE_CHECKER_ROUTE_HUMAN_RETIRE_LIFTED=1.
  const checkerRouteBaseMode = spawnChecker && !checkerRouteDisabled() ? decisionMode(CHECKER_ROUTE_PURPOSE) : 'off';
  const checkerRouteMode = checkerRouteBaseMode !== 'off' && !runIsMachineTriggered
    && skipRetiredHumanAsk(CHECKER_ROUTE_PURPOSE, { site: 'checker', segment: planSegment, sessionId: runSessionId })
    ? 'off' : checkerRouteBaseMode;
  if (checkerRouteMode !== 'off') {
    try {
      const lastUserTurn = [...ctx.conversationHistory].reverse().find(h => h.role === 'user')?.content;
      const { state, questions } = buildCheckerRouteRequest({ message: ctx.queryMessage, lastUserTurn });
      checkerRoutePromise = decide(state, questions, { purpose: CHECKER_ROUTE_PURPOSE, timeoutMs: CHECKER_ROUTE_TIMEOUT_MS, sessionId: runSessionId }).catch(() => null);
      if (checkerRouteMode === 'act') {
        // ACT (designed, default off): only a purpose CONFIGURED to act is
        // awaited here (bounded by the gate's own timeout) — a shadow purpose
        // never adds latency. Acting itself still keys on the RESULT's mode
        // (E2: an uncalibrated answer comes back 'shadow' and does nothing).
        // A confident simple_lookup takes the 75 s checker path and a checker
        // at 'high'; a confident contestable forces the full wait; the
        // checker is never skipped.
        const v = checkerRouteVerdict(await checkerRoutePromise);
        if (v.actSimple !== null) {
          isSimpleQuestion = v.actSimple;
          checkerEffort = v.actSimple ? 'high' : 'max';
          checkerRouteActed = true;
          logger.info(`chat-agent: checker-site router ACT — depth=${v.depth} (${v.depthConfidence?.toFixed(2)}) → ${v.actSimple ? 'simple path, checker at high' : 'full wait'} (regex said ${regexSimpleQuestion ? 'simple' : 'deep'})`);
        }
      }
    } catch (err: any) {
      logger.warn(`chat-agent: checker-site router failed (${err?.message ?? err}) — regex verdict stands`, { source: 'chat-agent' });
    }
  }

  // Machine turns skip the L2 cross-checker (machineTurnSkipsChecker above): a
  // checker draft on a fleet-event digest is noise the supervisor then
  // litigates every note — and since 2026-09-03 the checker is a FULL agentic
  // run, so this gate is also a hard cost bound on every schedule/hook/agent
  // firing.
  // Compute policy (2026-09-26): keyed on the PLAN (spawnChecker), not on the level.
  let checkersUnbounded: Promise<string> | null = null;
  // Audit 2026-10-06 T6-5: set when the finalize finds a PURE dispatch / coordination turn
  // (dispatch-turn.ts) — the checker loop stops at its next step and is never retried.
  let checkerStopRequested = false;
  if (spawnChecker) {
    checkersPromise = (async (): Promise<string> => {
    // Model-roles seat: the double_checker override replaces the built-in
    // checker lineup (Digby Edge); unset → CROSS_CHECKERS default.
    // Owner 2026-09-15 ("isn't the main model and the double checker supposed
    // to run simultaneously? in the UI it looks like only the double checker
    // runs"): they DO run in parallel — this line used to read as a hand-off
    // ("dispatching…") and the follow-up "checkers running in parallel" line
    // landed milliseconds later and was swallowed by the status throttle. Say
    // the parallelism here, in the line that survives.
    // Answer-first: the FIXED-key status line ("answering now — a second opinion
    // is running alongside"; server-side table, never model prose). The kill
    // switch keeps today's line.
    if (answerFirst && plan.checkerWaitMs <= 0) send('progress', keyedProgress('second_opinion'));
    else send('progress', { message: STATUS.checker.parallelStart, stage: 'query' });
    // FULL-PEER checker (owner 2026-09-03): the checker researches the user's
    // question AUTONOMOUSLY with its own web + retrieval tools — no harness
    // SERP handoff, no one-shot grounding, no UNVERIFIED stamping (the checker
    // itself states its grounding honestly). Single-writer principle: the
    // orchestrator is the only actor that mutates or talks to the user — the
    // cross_checker role's tool grant (roles.ts) is WEB + RETRIEVE +
    // INTEGRATIONS + file_feedback, all read-only (verified 2026-09-03:
    // integration-tool-schema.ts is search/list/get/read only), and workers
    // never get ask_user or platform tools.
    // Vision parity: attached images reach the checker as the shared
    // glm-5.3-flash description block ('' when no images) — the peer worker
    // path carries no image parts, whatever the seat's model can see.
    const checkerImageBlock = await sharedImageBlock();
    // Self-host setup hardening (2026-10-20): an instance with no search backend
    // must not promise the checker live web tools it does not have.
    const checkerWebSentence = webSearchMissingOnInstance()
      ? 'This instance has NO live web search: answer from your own knowledge, the user\'s files and connected accounts, plus retrieval (search_memory) — and state plainly what you could not verify instead of presenting knowledge as current.'
      : 'You have your OWN live web tools (search_engine / scrape_as_markdown / web_pipe / browser_task) and retrieval (search_memory): research the question autonomously whenever it is time-sensitive, past your training cutoff, disputable, or you are not fully certain — and state your grounding honestly (cite sources where facts matter; where you could not verify, say so instead of presenting knowledge as current).';
    const checkerDoctrine = `You are an independent CROSS-CHECKER — a different frontier model answering the SAME user question in parallel with the main assistant. ${checkerWebSentence} You CANNOT ask the user questions or take any action on their behalf — the main assistant owns all user interaction and actions; your sole deliverable is a COMPLETE independent answer to the question (this is what the main assistant reconciles against). END with that full answer — your final message IS your draft.\n\n${crossCheckLaneClockNote(new Date())}\n\n${crossCheckArtifactGroundingRule()}\n\n${crossCheckPlatformScopeRule()}\n\n${crossCheckVerifySilenceRule()}\n\n${checkerImageBlock}\n${ctx.systemContext}${(isSupervisorChat || args.machineWake) ? `\n\n${crossCheckFleetScopeNote()}` : ''}`;    const drafts = await Promise.all(crossCheckers.map(async seatModel => {
      const t0 = Date.now();
      const label = SEAT_LABELS.double;
      const cardKey = SEAT_CARD_KEYS.double;
      let model = seatModel;
      send('agent-activity', { kind: 'sub_start', label });
      // No "Double Checker is working on its own answer…" status line (2026-10-04 live check): it landed in the same
      // instant as the lane line ("the Double Checker is researching alongside") and, being last, replaced Digby's own
      // status for the first seconds of the turn. The sub_start activity above still marks the checker's start.
      // Dead-air fix (owner dogfood): the pre-step can run 1-4 minutes — surface
      // each checker's live activity instead of a frozen progress line.
      let lastBeat = 0;
      const checkerEmit = (type: string, data: any) => {
        if (type === 'subagent:reasoning') {
          // Native feed: full live thinking, coding-UI style.
          send('agent-activity', { kind: 'reasoning', label, delta: String(data?.delta ?? '') });
          const now = Date.now();
          if (now - lastBeat < 2500) return;
          lastBeat = now;
          const line = String(data?.delta ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
          if (line) send('thinking-summary', { summary: `${label}: ${line}` });
        } else if (type === 'subagent:tool_call') {
          send('agent-activity', { kind: 'tool', label, name: String(data?.name ?? ''), detail: String(data?.args?.query || data?.args?.url || '').slice(0, 80) });
          const tn = String(data?.name ?? '');
          if (/search/i.test(tn)) send('progress', { message: STATUS.checker.search(label, data?.args?.query), stage: 'model-searching' });
          else if (tn.startsWith('scrape')) send('progress', { message: STATUS.checker.read(label, hostOf(data?.args?.url)), stage: 'model-searching' });
        } else if (type === 'subagent:tool_result') {
          // Owner 2026-09-15: the checker's results used to reach the UI only as
          // a progress line — its tool rows never paired (each call rendered
          // alone, and a late result broke Digby's own call→result merge). Emit
          // the tool_done the orchestrator path emits, seat-labelled.
          const tn = String(data?.name ?? '');
          send('agent-activity', { kind: 'tool_done', label, name: tn, size: String(data?.result ?? '').length });
          // Real result, not a canned beat (owner directive 2026-08-30) — but a
          // human sentence: no raw tool id, no byte count (owner 2026-09-15).
          send('progress', { message: STATUS.checker.afterResult(label, tn), stage: 'query' });
        }
      };
      try {
        // DeepSeek intermittently returns EMPTY content (same failure mode as
        // the utility tier's documented empties) — one bounded retry when the
        // first attempt comes back blank and the hard deadline leaves room.
        const attempt = (m: string) => Promise.race([
          runChatWorker({
            worktree: '', sessionId: runSessionId, projectId: ctx.projectId || 'chat', ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}), userId: runUserId,
            permissionMode: 'auto', model: m, projectName: 'chat', branch: 'chat',
            userTurnAt,
            history: ctx.conversationHistory.slice(-6).map(h => ({ role: h.role, content: h.content })),
            userMessage: queryMessage,
            // FULL autonomous peer (owner 2026-09-03): the checker runs the
            // real L2 chat profile — its role-default tool loop (maxSteps 8
            // via chatProfile) with web + retrieval tools — bounded by the
            // raised CROSS_CHECK_SOFT_MS (300s self-wrap; the harness kill
            // stays CROSS_CHECK_HARD_MS). Replaces the one-shot maxSteps:1
            // SERP-grounded drafter.
            // DepthBudget.maxBackgroundMs shortens both the self-wrap and the
            // harness kill below (never lengthens either).
            profile: { ...chatProfile('thinking', false), runDeadlineMs: Math.min(CROSS_CHECK_SOFT_MS, checkerHardMs) },
            // DeepSeek V4 Pro peer thinking config (owner 2026-09-03): the
            // 0813 GA snapshot supports reasoning_effort 'max' with thinking
            // enabled — full-depth reasoning for the independent answer.
            // Built-in ids only: a custom-endpoint seat ('<label>:…' — a label
            // may start with "deepseek") must not get DeepSeek-only params.
            providerExtra: (!m.includes(':') && m.startsWith('deepseek')) ? { reasoning_effort: checkerEffort, thinking: { type: 'enabled' } } : undefined,
            doctrineOverride: checkerDoctrine,
            emit: checkerEmit,
            isCancelled: () => !!args.isCancelled?.() || checkerStopRequested,
            usage: turnUsage, // WI-D: the checker's tokens land on THIS turn's run_spend row
          }, 'cross_checker'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(checkerBound.source === 'depth_budget' ? `cross-check deadline (DepthBudget.maxBackgroundMs ${Math.round(checkerHardMs / 1000)}s)` : 'cross-check deadline')), checkerHardMs - (Date.now() - t0)).unref()),
        ]);
        const runOnce = async (m: string) => {
          let r = await attempt(m);
          if (!(r.finalText || '').trim() && !r.modelErrored && !checkerStopRequested && checkerHardMs - (Date.now() - t0) > 150_000) {
            logger.warn(`chat-agent: ${SEAT_LABELS.double} ${m} returned empty — retrying once`, { source: 'chat-agent' });
            send('progress', { message: STATUS.checker.retry(label), stage: 'query' });
            r = await attempt(m);
          }
          return r;
        };
        let result = await runOnce(model);
        // Admin custom fallback (owner 2026-09-15): a provider-errored or empty
        // seat → ONE try on the configured backup model, with time left. The
        // card stays the Double Checker's; modelUsed names what actually served.
        const seatFailed = result.modelErrored === true || !(result.finalText || '').trim();
        if (seatFailed && checkerFallbackModel && checkerFallbackModel !== model && !checkerStopRequested && checkerHardMs - (Date.now() - t0) > 150_000 && !(await seatUnservableReason(checkerFallbackModel, runUserId).catch(() => 'probe failed'))) {
          const failedSeat = model;
          const reason = result.modelErrored ? 'provider_error' : 'empty';
          logger.warn(`chat-agent: ${SEAT_LABELS.double} seat ${failedSeat} ${reason === 'empty' ? 'returned nothing' : 'was rejected by its provider'} — trying ${checkerFallbackModel === doubleCheckerFallback ? "the admin's custom fallback" : 'the double_checker seat (picked checker failed)'} ${checkerFallbackModel}`, { source: 'chat-agent' });
          send('progress', { message: STATUS.checker.snag(label), stage: 'query' });
          model = checkerFallbackModel;
          const fb = await runOnce(model);
          const recovered = !fb.modelErrored && !!(fb.finalText || '').trim();
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, sessionId: runSessionId, stamp: chatMetricStamp,
            meta: { seat: 'double_checker', failedSeat, fallbackModel: model, recovered, reason, customFallback: !!doubleCheckerFallback && checkerFallbackModel === doubleCheckerFallback, ...(checkerPickedBy === 'role' ? { rolePicked: true } : {}), ...(laneCheckerSpec ? { lane: 'checked', laneChecker: laneCheckerSpec } : {}), toolCalls: (result.parts || []).filter((p: any) => p?.type === 'tool_call').length },
          });
          if (recovered) result = fb;
        }
        const time = Date.now() - t0;
        // A provider-gave-up run's finalText is an honest ERROR NOTE, not a
        // draft — injecting it as an independent answer polluted the
        // orchestrator's reconcile (and on a keyless Edge the 401 note read
        // like a real cross-check). Treat it as a failed checker instead.
        if (result.modelErrored) {
          const note = (result.finalText || 'model request rejected').trim();
          adapter.handle('subagent_end', { model, summary: '', time, persona: label, cardKey });
          models[cardKey] = { model: cardKey, response: '', time, modelUsed: model, persona: label, error: note.slice(0, 300) };
          logger.warn(`chat-agent: ${SEAT_LABELS.double} ${model} provider-errored — draft discarded: ${note.slice(0, 200)}`, { source: 'chat-agent' });
          return { model, text: '', toolTexts: [] as string[] };
        }
        const text = (result.finalText || '').trim();
        send('progress', { message: STATUS.checker.done(label, time), stage: 'query' });
        // adapter.handle('subagent_end') also emits the feed's sub_end row — do
        // NOT send one directly too (double "finished in Xs" rows, owner report).
        adapter.handle('subagent_end', { model, summary: text, time, persona: label, cardKey });
        // webSearchUsed is HONEST per-run telemetry now: true iff the peer
        // actually fired a web tool in its own loop.
        if (text) models[cardKey] = { model: cardKey, response: text, time, modelUsed: model, persona: label, webSearchUsed: countWebToolCalls(result.parts) > 0 };
        // Ticket 31738d9a: keep the lane's OWN tool-result texts with the
        // draft — at injection time they are the future-clock scan's
        // provenance haystacks (an honestly quoted forward reading is not a
        // confabulation, the a688ba29 discipline) and part of the phantom-id
        // corpus (an id the lane actually READ is quotable).
        const { toolResultTextsFromParts } = await import('../platform/action-verifier');
        return { model, text, toolTexts: toolResultTextsFromParts(result.parts) };
      } catch (err: any) {
        const time = Date.now() - t0;
        adapter.handle('subagent_end', { model, summary: '', time, persona: label, cardKey });
        models[cardKey] = { model: cardKey, response: '', time, modelUsed: model, persona: label, error: err.message || 'cross-check failed' };
        logger.warn(`chat-agent: ${SEAT_LABELS.double} ${model} failed: ${err.message}`, { source: 'chat-agent' });
        return { model, text: '', toolTexts: [] as string[] };
      }
    }));
    const usable = drafts.filter(d => d.text);
    send('progress', { message: STATUS.checker.answersIn(usable.length), stage: 'synthesis' });
    logger.info(`chat-agent L2 checkers: ${usable.length}/${crossCheckers.length} drafts in ${Date.now() - startedAt}ms (soft=${CROSS_CHECK_SOFT_MS})`);
    if (!usable.length) return '';
    const header = crossCheckDraftsHeader(usable.length, { webSearchConfigured: !webSearchMissingOnInstance() });
    // Ticket 31738d9a (mishap 2026-09-17): deterministic draft-integrity
    // annotation. The corpus a lane could LEGITIMATELY quote = its user
    // message + the conversation history it was shown + the system context
    // embedded in its doctrine + its own tool results. A future clock (vs the
    // LIVE harness clock) or a labeled id absent from that corpus is
    // confabulated by construction — annotate, never strip (the draft's
    // analysis stays; the banner refutes the flagged lines).
    const { findFutureObservedTimestamps } = await import('../platform/action-verifier');
    const laneContextCorpus = [queryMessage, ctx.systemContext || '', ...ctx.conversationHistory.slice(-6).map(h => h.content || '')].join('\n');
    return `\n${header}\n${
      usable.map(d => {
        // Ticket 0cbfa36e (mishap 2026-09-15): a cross_checker lane has NO
        // action tools, so an "ACTIONS TAKEN"-style block in its draft can
        // only be confabulated — strip it BEFORE injection (the header's
        // never-adoptable framing is the second layer for inline claims).
        // Log the strip so the phantom-dispatch-via-ensemble class stays
        // observable instead of silently filtered.
        const clean = stripCrossCheckActionClaims(d.text);
        if (clean.stripped) logger.warn(`chat-agent: cross-checker ${d.model} draft carried ${clean.stripped} confabulated action-claim section(s) — stripped before injection (ticket 0cbfa36e)`, { source: 'chat-agent' });
        const futureClocks = findFutureObservedTimestamps(clean.text, new Date(), { evidenceHaystacks: d.toolTexts });
        const phantomIds = findPhantomDraftIds(clean.text, `${laneContextCorpus}\n${d.toolTexts.join('\n')}`);
        const banner = crossCheckDraftIntegrityBanner({ futureClocks, phantomIds });
        if (banner) logger.warn(`chat-agent: cross-checker ${d.model} draft integrity flags — ${futureClocks.length} future-clock(s), ${phantomIds.length} phantom id(s) — annotated before injection (ticket 31738d9a)`, { source: 'chat-agent' });
        const body = banner ? `${banner}\n${clean.text}` : clean.text;
        return `--- ${d.model} ---\n${body.slice(0, 8000)}`;
      }).join('\n\n')}\n[/CROSS-CHECK DRAFTS]\n`;
    })();
    checkersPromise.catch(() => {}); // never let a checker failure become unhandled
    checkersUnbounded = checkersPromise; // the real draft — the late reconcile awaits THIS under answer-first
    // Answer-first: the lead never waits, so the 75 s simple-question cap on
    // the promise would only throw a late draft away (the late path would
    // read '' at 75 s as "no draft"). Today's cap stays under the kill switch.
    if (isSimpleQuestion && !answerFirst) {
      // Per-question SOFT deadline (ticket 62761c89): bound the PROMISE the
      // orchestrator waits on (the deadlineOffsetMs machinery already excludes
      // that wait from the run deadline — what was missing is a cap on the
      // wait itself for trivial questions). The checker keeps running to fill
      // the More-info card; its draft simply stops being answer-gating after
      // CROSS_CHECK_SIMPLE_WAIT_MS. Deep/council questions keep the full
      // CROSS_CHECK_SOFT/HARD caps above.
      const unbounded = checkersPromise;
      checkersPromise = Promise.race([
        unbounded,
        new Promise<string>(res => setTimeout(() => {
          logger.info(`chat-agent L2 checkers: simple question — soft deadline ${CROSS_CHECK_SIMPLE_WAIT_MS}ms reached, orchestrator proceeds without the draft`);
          res('');
        }, CROSS_CHECK_SIMPLE_WAIT_MS).unref()),
      ]);
      checkersPromise.catch(() => {}); // same unhandled-rejection guard on the wrapped promise
    }
  }

  // ── L3 DEEP COUNCIL wiring (inbox bus + dispatch/spawn/note tools).
  //    `deep_research_all` is a retired alias the controller normalizes to
  //    deep_research; its one-shot FRONTIER CONSULTANTS (gemini/chatgpt/grok)
  //    were deleted 2026-09-22 with every frontier model — the council is the
  //    Double Checker + Triple Checker seats. ──
  // Ghost = one lead inference (owner ruling 2026-11-03): the SECOND council
  // read is keyed on `mode` alone, and `mode` deliberately stays as requested
  // (it feeds the lead's step profile + doctrine below — collapsing it would
  // shrink the one inference the ghost run is allowed to make). Gate the
  // council read itself instead, so a chat STORED deep_research cannot convene
  // colleagues around a plan the collapse set to council 'none'.
  const isCouncil = !ghostSingleModel && (mode === 'deep_research' || mode === 'deep_research_all');
  // No wall clock (2026-10-20): stamp the live run as a research council and start its progress beats (the drain's
  // research extension reads both). RESEARCH_NO_WALL_CLOCK_DISABLED=1 ⇒ nothing stamped, today's drain eligibility.
  if (isCouncil && researchUnclocked && (chatId || args.sessionId)) {
    const researchKey = chatAgentRunKey(args);
    researchProgress = bindLiveRun(researchKey);
    try { setRunMeta(researchKey, { isResearchCouncil: true }); } catch { /* registry stamp is best-effort */ }
    noteResearchProgress();
  }
  // Council slots are SEATS (owner 2026-09-15): the Double Checker and the
  // Triple Checker — the same names the admin page and the status stream use.
  const inbox: Record<string, string[]> = { lead: [], double_checker: [], triple_checker: [] };
  const personaOf = (key: string) =>
    key === 'double_checker' ? SEAT_LABELS.double : key === 'triple_checker' ? SEAT_LABELS.triple
    : SEAT_LABELS.lead;

  const makeNoteTool = (from: string) => ({
    schema: { type: 'function' as const, function: {
      name: 'send_note',
      description: `Send a short note to another council member mid-flight (they see it between their reasoning steps). Use for significant findings, surprises, questions, or reconciling disagreements.`,
      parameters: { type: 'object', properties: {
        to: { type: 'string', enum: ['lead', 'double_checker', 'triple_checker', 'all'], description: 'Recipient (a council seat, the lead, or all).' },
        content: { type: 'string', description: 'The note (keep it tight — findings, sources, questions).' },
      }, required: ['to', 'content'] },
    } },
    execute: async (a: any) => {
      const rawTo = String(a?.to || 'all').trim().toLowerCase();
      const to = rawTo === 'all' || rawTo === 'lead' ? rawTo : (normalizeCouncilSeat(rawTo) ?? rawTo);
      const content = String(a?.content || '').slice(0, 4000);
      if (!content) return 'Empty note — nothing sent.';
      const line = `[NOTE from ${personaOf(from)}] ${content}`;
      const targets = to === 'all' ? Object.keys(inbox).filter(k => k !== from) : [to];
      // Never report a dropped note as delivered (audit 2026-10-03).
      if (!targets.every(t => inbox[t])) return `Unknown recipient '${String(a?.to)}' — nothing sent (use lead, double_checker, triple_checker or all).`;
      for (const t of targets) inbox[t].push(line);
      send('agent-activity', { kind: 'tool', label: personaOf(from), name: 'send_note', detail: `→ ${to}: ${content.slice(0, 60)}` });
      return `Note delivered to ${targets.join(', ')}.`;
    },
  });
  const drainInbox = (who: string) => () => {
    const q = inbox[who]; if (!q?.length) return null;
    const batch = q.splice(0, q.length).join('\n');
    return `[COUNCIL NOTES — messages from your colleagues since your last step]\n${batch}`;
  };

  // onProgress (no wall clock, 2026-10-20): every event of this colleague — and of its clones — feeds the dispatch's
  // progress-based wait (council-dispatch.ts runBoundedColleague `stall`); unset ⇒ nothing is reported.
  const runColleague = async (key: CouncilSeat, mission: string, opts?: { clone?: boolean; cloneIdx?: number; fallbackOf?: string; cancelled?: () => boolean; deadlineMs?: number; onProgress?: (e: CouncilProgressEvent) => void }): Promise<string> => {
    let model = councilModels[key];
    const persona = personaOf(key) + (opts?.clone ? ` clone ${opts.cloneIdx}` : '');
    const cardKey = key; // seat card key (SEAT_CARD_KEYS.double / .triple)
    const customFallback = councilFallbacks[key];
    // Ticket 9aedb32f: the dispatch ceiling can cancel ONE attempt from
    // outside (a wedged run is retried on a fresh connection) without
    // touching the run-level Stop latch — opts.cancelled is that per-attempt
    // latch; args.isCancelled stays the user's Stop for every attempt.
    const cancelledNow = () => !!(args.isCancelled?.() || opts?.cancelled?.());
    // Seat pre-flight (2026-09-04): a colleague seat that cannot be served on
    // this instance (keyless built-in) reports back to the lead immediately
    // instead of dispatching a run that can only 401 its way to an error note.
    // Admin custom fallback (owner 2026-09-15): an unservable seat with a
    // servable configured backup runs on the backup for the rest of this run.
    let colleagueSeatProblem = await seatUnservableReason(model, runUserId);
    if (colleagueSeatProblem && customFallback && customFallback !== model && !(await seatUnservableReason(customFallback, runUserId).catch(() => 'probe failed'))) {
      logger.warn(`deep-council: ${persona} seat ${model} unservable (${colleagueSeatProblem}) — running on the admin's custom fallback ${customFallback}`, { source: 'chat-agent' });
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, sessionId: runSessionId, stamp: chatMetricStamp, meta: { seat: key, failedSeat: model, fallbackModel: customFallback, recovered: true, reason: 'unservable', customFallback: true } });
      councilModels[key] = customFallback;
      model = customFallback;
      colleagueSeatProblem = null;
    }
    if (colleagueSeatProblem) {
      logger.warn(`deep-council: ${persona} seat unservable — ${colleagueSeatProblem}`, { source: 'chat-agent' });
      send('progress', { message: STATUS.team.unavailable(persona), stage: 'query' });
      return `(${persona} unavailable on this instance: ${colleagueSeatProblem}. Cover this mission yourself; an admin can assign the seat a model under Account → Admin → Endpoints → Model roles.)`;
    }
    const peer = personaOf(key === 'double_checker' ? 'triple_checker' : 'double_checker');
    let clonesSpawned = 0;
    send('agent-activity', { kind: 'sub_start', label: persona });
    send('progress', { message: STATUS.team.on(persona, mission), stage: 'query' });
    const t0 = Date.now();
    // This attempt's FINAL-TURN deadline: the dispatch's per-attempt fit (opts.deadlineMs) else the run's fit / backstop.
    // deadlineAt bounds this colleague's clones — spawn_self blocks the parent, so a clone must finish inside it.
    const deadlineMs = opts?.deadlineMs ?? councilDeadlineFor(opts?.clone ? 'clone' : 'colleague');
    const deadlineAt = typeof deadlineMs === 'number' ? t0 + deadlineMs : undefined;
    // A fallback re-run gets what is LEFT of this attempt's deadline, never a fresh full one (it must still fit the wait).
    const leftFor = (): { deadlineMs?: number } => (deadlineAt !== undefined ? { deadlineMs: Math.max(60_000, deadlineAt - Date.now()) } : {});
    const colleagueEmit = (type: string, data: any) => {
      // Reasoning is reported as its own kind (review 2026-10-20): the dispatch wait bounds reasoning-only liveness.
      opts?.onProgress?.(type === 'subagent:tool_call' ? 'tool_start' : type === 'subagent:tool_result' ? 'tool_end' : type === 'subagent:reasoning' ? 'reasoning' : 'event');
      if (type === 'subagent:reasoning') {
        send('agent-activity', { kind: 'reasoning', label: persona, delta: String(data?.delta ?? '') });
      } else if (type === 'subagent:tool_call') {
        send('agent-activity', { kind: 'tool', label: persona, name: String(data?.name ?? ''), detail: String(data?.args?.query || data?.args?.url || data?.args?.subtask || '').slice(0, 80) });
      } else if (type === 'subagent:tool_result') {
        // Owner 2026-09-15: pair the colleague's rows too (see checkerEmit).
        send('agent-activity', { kind: 'tool_done', label: persona, name: String(data?.name ?? ''), size: String(data?.result ?? '').length });
      }
    };
    const extraTools: Array<{ schema: any; execute: (a: any) => Promise<string> }> = [makeNoteTool(key)];
    if (!opts?.clone) {
      extraTools.push({
        schema: { type: 'function' as const, function: {
          name: 'spawn_self',
          description: `Spawn an autonomous clone of yourself (same model) on a scoped subtask — use for parallel legs of your mission. Up to ${MAX_CLONES_PER_COLLEAGUE} clones. The clone returns its full report to you.`,
          parameters: { type: 'object', properties: {
            subtask: { type: 'string', description: 'Complete, self-contained subtask: objective + expected output format.' },
          }, required: ['subtask'] },
        } },
        execute: async (a: any) => {
          if (clonesSpawned >= MAX_CLONES_PER_COLLEAGUE) return `Clone limit reached (${MAX_CLONES_PER_COLLEAGUE}).`;
          // Not enough of this colleague's deadline left for a clone to finish inside it — refuse rather than floor (a
          // floored clone would outlive its parent). Not counted against the clone limit.
          if (deadlineAt !== undefined && deadlineAt - Date.now() - CLONE_PARENT_MARGIN_MS < CLONE_MIN_DEADLINE_MS) {
            return 'Not enough time left in your deadline for a clone — cover this subtask yourself and write your report.';
          }
          clonesSpawned += 1;
          // 2026-10-20 review: a clone is bounded by what is LEFT of its parent's deadline (minus room for the parent's
          // own final turn), and inherits the parent attempt's cancel latch (a cancelled attempt's clone stops too).
          const cloneDeadlineMs = deadlineAt !== undefined
            ? Math.min(councilDeadlineFor('clone') ?? Number.POSITIVE_INFINITY, deadlineAt - Date.now() - CLONE_PARENT_MARGIN_MS)
            : undefined;
          return runColleague(key, String(a?.subtask || ''), { clone: true, cloneIdx: clonesSpawned, cancelled: opts?.cancelled, ...(cloneDeadlineMs !== undefined ? { deadlineMs: cloneDeadlineMs } : {}), ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}) });
        },
      });
    }
    try {
      const result = await runChatWorker({
        worktree: '', sessionId: runSessionId, projectId: ctx.projectId || 'chat', ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}), userId: runUserId,
        permissionMode: 'auto', model, projectName: 'chat', branch: 'chat',
        userTurnAt,
        history: [],
        userMessage: queryMessage,
        profile: councilProfile(opts?.clone ? 'clone' : 'colleague', deadlineMs),
        // Council colleagues research with their OWN web tools (the SERP-await
        // grounding handoff is gone — owner 2026-09-03); colleagues (glm-5.3 +
        // deepseek-flash) get the shared image description when the user
        // attached images.
        doctrineOverride: councilColleagueDoctrine({ persona, peer, mission, imageBlock: await sharedImageBlock(), clone: opts?.clone, machineWake: args.machineWake, noLiveWeb: webSearchMissingOnInstance() }),
        emit: colleagueEmit,
        isCancelled: cancelledNow, // latch-aware: the dispatch retry cancels a wedged attempt via opts.cancelled — passing the bare Stop flag left the latch dead outside the pre-flight check
        extraTools,
        injectSystem: opts?.clone ? undefined : async () => drainInbox(key)(),
        usage: turnUsage, // WI-D: colleagues (and their clones) meter onto the turn's ledger
      }, 'cross_checker');
      const time = Date.now() - t0;
      const text = (result.finalText || '').trim();
      // Admin custom fallback (owner 2026-09-15): a provider-errored or empty
      // colleague run → ONE re-run on the configured backup model (never for a
      // run that is itself the fallback). The seat keeps the backup for the
      // rest of this run so later dispatches and clones stop hitting the dead model.
      if ((result.modelErrored || !text) && !opts?.fallbackOf && customFallback && customFallback !== model && !(await seatUnservableReason(customFallback, runUserId).catch(() => 'probe failed'))) {
        const reason = result.modelErrored ? 'provider_error' : 'empty';
        logger.warn(`deep-council: ${persona} seat ${model} ${reason === 'empty' ? 'produced no report' : 'was rejected by its provider'} — re-running on the admin's custom fallback ${customFallback}`, { source: 'chat-agent' });
        send('progress', { message: STATUS.team.snag(persona), stage: 'query' });
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, sessionId: runSessionId, stamp: chatMetricStamp, meta: { seat: key, failedSeat: model, fallbackModel: customFallback, recovered: null, reason, customFallback: true } });
        councilModels[key] = customFallback;
        return runColleague(key, mission, { ...opts, fallbackOf: model, ...leftFor() });
      }
      // Emit sub_end directly ONLY when the adapter path below won't (clones and
      // empty reports) — adapter.handle('subagent_end') emits its own sub_end,
      // so sending both produced duplicate "finished in Xs" rows (owner report).
      if (opts?.clone || !text) {
        send('agent-activity', { kind: 'sub_end', label: persona, time });
      }
      send('progress', { message: STATUS.team.done(persona, !!opts?.clone, time), stage: 'query' });
      if (!opts?.clone && text) {
        models[cardKey] = { model: cardKey, response: text, time, modelUsed: model, persona: personaOf(key), webSearchUsed: true };
        adapter.handle('subagent_end', { model, summary: text, time, persona: personaOf(key), cardKey });
      }
      return text || '(no report produced)';
    } catch (err: any) {
      // Same custom-fallback lane for a THROWN colleague run (deadline/network).
      if (!opts?.fallbackOf && customFallback && customFallback !== model && !args.isCancelled?.() && !(await seatUnservableReason(customFallback, runUserId).catch(() => 'probe failed'))) {
        logger.warn(`deep-council: ${persona} seat ${model} failed (${err.message}) — re-running on the admin's custom fallback ${customFallback}`, { source: 'chat-agent' });
        send('progress', { message: STATUS.team.snag(persona), stage: 'query' });
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, sessionId: runSessionId, stamp: chatMetricStamp, meta: { seat: key, failedSeat: model, fallbackModel: customFallback, recovered: null, reason: 'error', customFallback: true } });
        councilModels[key] = customFallback;
        return runColleague(key, mission, { ...opts, fallbackOf: model, ...leftFor() });
      }
      send('agent-activity', { kind: 'sub_end', label: persona, time: Date.now() - t0 });
      logger.warn(`deep-council: ${persona} failed: ${err.message}`, { source: 'chat-agent' });
      return `(${persona} failed: ${err.message})`;
    }
  };

  // Ticket c7d5f885: capture-always, decide-later holder for late council
  // findings on a DEGRADED run (see council-late-addendum.ts). Armed here
  // where runSessionId is in scope; chatMetricStamp is built later, so the
  // stamp is resolved lazily at settle time (turnSpendStamp precedent, :1922).
  // No wall clock (review 2026-10-20): the follow-up posts what is in hand after its grace, then each tracked straggler's
  // finding as it lands — for at most councilLateStragglerWaitMs (nothing is tracked under the switch: no bound armed).
  const lateCouncil = armLateCouncilAddendum({ chatId, sessionId: runSessionId, stamp: () => chatMetricStamp, ...(researchUnclocked ? { stragglerWaitMs: councilLateStragglerWaitMs() } : {}) });

  let dispatchRounds = 0;
  // Ticket 9aedb32f: colleagues that returned REAL research this run — a
  // deep-research run where the council was dispatched but this stayed 0 is
  // DEGRADED (lead-only answer, deep-research quota paid) and the final
  // message says so.
  let councilRealReports = 0;
  const councilTools = isCouncil ? [
    {
      schema: { type: 'function' as const, function: {
        name: 'dispatch_colleagues',
        description: 'Dispatch one or both autonomous colleagues — the Double Checker (double_checker) and the Triple Checker (triple_checker) — IN PARALLEL with sharp mission briefs. Each works until it judges its mission complete (spawning clones, messaging you and each other as needed) and returns a full structured report. You may dispatch again in later rounds for gaps/follow-ups.',
        parameters: { type: 'object', properties: {
          tasks: { type: 'array', items: { type: 'object', properties: {
            model: { type: 'string', enum: ['double_checker', 'triple_checker'], description: 'Which colleague (council seat).' },
            mission: { type: 'string', description: 'Sharp brief: objective, expected output format, suggested angles/sources, explicit boundaries (no overlap with the other missions).' },
          }, required: ['model', 'mission'] }, description: '1-2 missions (dispatch both colleagues in ONE call for parallelism).' },
        }, required: ['tasks'] },
      } },
      execute: async (a: any) => {
        if (dispatchRounds >= MAX_DISPATCH_ROUNDS) return `Dispatch limit reached (${MAX_DISPATCH_ROUNDS} rounds) — synthesize with what the council has gathered.`;
        // Validate BEFORE spending a round (audit 2026-10-03): a refused call
        // used to count against MAX_DISPATCH_ROUNDS.
        const tasks = (Array.isArray(a?.tasks) ? a.tasks : []).slice(0, 2)
          .map((t: any) => ({ ...t, model: normalizeCouncilSeat(t?.model) }))
          .filter((t: any) => t.model && councilModels[t.model as CouncilSeat]);
        if (!tasks.length) return 'No valid tasks (model must be double_checker or triple_checker) — no dispatch round was used.';
        dispatchRounds += 1;
        // Carry the first mission brief in the status line (owner directive
        // 2026-08-30: real activity, not a canned "autonomous research" beat).
        const firstMission = String(tasks[0]?.mission || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        send('progress', { message: STATUS.team.dispatched(tasks.length, personaOf(tasks[0].model), firstMission), stage: 'query' });
        // Generous-but-FINITE ceiling per dispatch round (ticket 9aedb32f:
        // this used to be a raw Promise.race that resolved a slow colleague
        // to a placeholder with NO retry, NO telemetry and NO user notice —
        // the lead answered alone while deep-research quota was paid, chat
        // 2f25f493). runBoundedColleague (council-dispatch.ts) bounds each
        // attempt at the ceiling, gives a wedged attempt ONE fresh retry
        // (the timed-out attempt is cancelled via its latch so it stops
        // spending), lets the TERMINAL straggler keep running — its late
        // report lands in the lead's council-note inbox instead of being
        // discarded — and logs council_dispatch_timeout either way.
        const reports = await Promise.all(tasks.map((t: any) => {
          const key = String(t.model);
          const persona = personaOf(key);
          // Per-ATTEMPT latch: every attempt mints a FRESH one, so cancelling
          // a wedged attempt can never be un-cancelled when the retry resets
          // the shared state; the user's Stop is OR-ed in inside runColleague.
          // The closure captures the attempt's OWN latch in a local const —
          // reading the outer (reassignable) binding let attempt 2's fresh
          // latch silently un-cancel attempt 1 (reviewer F1).
          let latch: { cancelled: boolean } | undefined;
          // audit 2026-10-08 W4-8: a budgeted research rung waits the colleague's fitted deadline + the final-turn grace,
          // ONE attempt (council-dispatch.ts fittedDispatchCeiling); the L3 preset keeps the 12-min ceiling + retry.
          const fitCeilingMs = rungColleagueFit ? fittedDispatchCeiling(councilDeadlineFor('colleague') ?? COUNCIL_DISPATCH_CEILING_MS) : undefined;
          if (fitCeilingMs !== undefined) recordLoopMetric({ kind: 'council_rung_fit', sessionId: runSessionId, stamp: chatMetricStamp, meta: { seat: key, persona, ceilingMs: fitCeilingMs, colleagueDeadlineMs: councilDeadlineFor('colleague') ?? null, elapsedMs: Date.now() - startedAt } });
          // No wall clock (2026-10-20): the lead waits while the colleague PROGRESSES — a fresh per-attempt tracker fed
          // by every event of the attempt and its clones (a tool in flight counts) — and gives an attempt up only after
          // 1.5 × COUNCIL_STALL_MS without progress (the colleague's own stream-stall retry acts first). The retry gets
          // the same window; every straggler is tracked so its late report is flushed, never dropped. Reasoning alone is
          // bounded progress (review 2026-10-20 — a looping reasoning stream held the wait for hours): past one more
          // window since the seat's last NON-reasoning event its reasoning-only time counts as idle.
          let seatProgress = createSeatProgress();
          const reasoningOnlyMs = councilReasoningOnlyMs();
          const stallWait = researchUnclocked ? { ms: councilDispatchStallMs(), idleMs: () => seatIdleMs(seatProgress, Date.now(), COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, reasoningOnlyMs) } : undefined;
          return runBoundedColleague({
            persona,
            // Per-attempt fit on the preset (2026-10-20 review): attempt N's FINAL-TURN deadline fits ITS ceiling (12 min ⇒ 9;
            // the half-ceiling retry 6 min ⇒ 3) — a 9-min deadline inside a 6-min retry window was a guaranteed timeout.
            run: (attemptInfo) => {
              const mine = { cancelled: false }; latch = mine;
              const attemptDeadline = presetAttemptFit && attemptInfo ? fitColleagueDeadline(councilBackstopMs('colleague'), attemptInfo.ceilingMs) : undefined;
              const progress = createSeatProgress();
              if (stallWait) seatProgress = progress;
              const onProgress = stallWait ? (e: CouncilProgressEvent) => { noteSeatProgress(progress, e); noteResearchProgress(); } : undefined;
              return runColleague(key as CouncilSeat, String(t.mission || ''), { cancelled: () => !!mine.cancelled, ...(attemptDeadline !== undefined ? { deadlineMs: attemptDeadline } : {}), ...(onProgress ? { onProgress } : {}) });
            },
            retryDisabled: fitCeilingMs !== undefined,
            ...(fitCeilingMs !== undefined ? { ceilingMs: fitCeilingMs } : {}),
            ...(stallWait ? { stall: stallWait, onStraggler: (p: Promise<string>) => lateCouncil.track(p) } : {}),
            onTimeout: info => {
              if (!info.terminal && latch) latch.cancelled = true; // stop the wedged attempt; a fresh one follows
              // The give-up was the reasoning-only bound (the seat kept streaming reasoning, nothing else) — not silence.
              const reasoningOnly = !!stallWait && seatIdleMs(seatProgress) <= stallWait.ms;
              recordLoopMetric({ kind: LOOP_METRIC_KINDS.COUNCIL_DISPATCH_TIMEOUT, sessionId: runSessionId, stamp: chatMetricStamp, meta: { seat: key, persona, attempt: info.attempt, terminal: info.terminal, ceilingMs: info.ceilingMs, retryDisabled: false, ...(fitCeilingMs !== undefined ? { rungFit: true } : {}), ...(stallWait ? { stall: true } : {}), ...(reasoningOnly ? { reasoningOnly: true } : {}) } });
              if (!info.terminal) send('progress', { message: stallWait ? (reasoningOnly ? STATUS.team.stuckThinking(persona) : STATUS.team.stalled(persona)) : STATUS.team.slow(persona), stage: 'query' });
            },
            // No wall clock: the late-findings follow-up (now on every dispatched run) carries research only — never the
            // "(Stopped.)" of an abandoned attempt or a failure note (council-dispatch.ts isLateCouncilFinding).
            onLateReport: text => { inbox.lead.push(`[LATE REPORT from ${persona}] ${String(text).slice(0, 4000)}`); if (!stallWait || isLateCouncilFinding(text)) lateCouncil.note(persona, String(text).slice(0, 4000)); },
          }).then(outcome => {
            if (outcome.realReport) councilRealReports += 1;
            return `=== REPORT: ${persona} ===\n${outcome.report.slice(0, 12000)}`;
          });
        }));
        return reports.join('\n\n');
      },
    },
    makeNoteTool('lead'),
  ] : undefined;

  // ── Orchestrator run (GLM) — streams the answer through the adapter ─────────
  pulsePhase = 'synthesis';
  // Keyed on the PLAN, not the preset (audit 2026-09-26 routing-unify-9): a gate
  // that dropped / added the checker used to leave the L2 / L1 line on screen.
  send('progress', { message: isCouncil ? STATUS.lane.research : spawnChecker ? STATUS.lane.checked : quickLaneModel ? STATUS.lane.quick : STATUS.lane.standard, stage: 'synthesis' });
  // Fleet-supervisor rebuild (Phase 0): supervisor chats get the raised
  // SUPERVISOR budget (24 steps / 15 min) — the stock 8-step chat budget was
  // the direct cause of phantom dispatches (the loop omits tools on its last
  // step, so a step-starved wake NARRATED actions it never executed).
  // audit 2026-10-08 W4-1c: a harness-set Standard lane runs the 'thinking' BUDGET (8 steps / 480 s) with its checker
  // still off (platform/lane-depth.ts standardLaneThinkingBudget; STANDARD_LANE_THINKING_BUDGET_DISABLED=1 ⇒ Level 1).
  const profile = isCouncil ? councilProfile('lead', councilDeadlineFor('lead')) : isFleetSupervisorChat ? supervisorProfile() : isProjectSupervisorChat ? projectSupervisorProfile() : quickLaneModel ? quickChatProfile() : chatProfile(mode === 'thinking' || standardLaneThinkingBudget(plan) ? 'thinking' : 'single_thinking', false);
  const deadlineNote = ownerAfAct ? answerFirstDoctrineLine(ownerAfObserver!.deadlineMs) : `- You have a hard time budget (~${Math.round((profile.runDeadlineMs || 120000) / 1000)}s) and at most ${profile.maxSteps} tool rounds — spot-check what matters, then ANSWER.`;
  // Compute policy (review 2026-09-26 H2): under answer-first the lead is told
  // NOT to wait for the draft and is never told to "answer now" — it reconciles
  // only a draft injected before it finishes; the kill switch / a guest run
  // keeps today's blocking paragraph (compute-policy-wiring holds both texts).
  const parallelNote = checkersPromise ? parallelCrossCheckNote({ answerFirst, webSearchConfigured: !webSearchMissingOnInstance() }) : '';
  // Capability playbook inputs (2026-09-08): the run's chat id IS the
  // orchestrator's sessionId (anonymous runs carry the anon-… key and get the
  // no-account-tools variant anyway); ctx.projectId is null for an ungrouped
  // chat — the 'chat' sentinel is minted only downstream (`ctx.projectId ||
  // 'chat'`) but is normalized here too so the playbook never prints "in
  // project chat". Machine wakes share this doctrine ON PURPOSE: a scheduled
  // prompt ending in "then notify_user with the result" finds notify_user here
  // — but they get the NO-offers / no-action-chips variants of the offers block
  // and the follow-up line (`machine`, the same origin expression the loop
  // metrics segment on; review 2026-09-08).
  const platformDoctrine: PlatformDoctrineArgs = {
    chatId: runSessionId,
    chatTitle: doctrineChatTitle,
    projectId: ctx.projectId && ctx.projectId !== 'chat' ? ctx.projectId : null,
    isSupervisor: isSupervisorChat,
    hasUser: !!userId,
    machine: args.machineWake === true || machineOriginRun(args),
  };
  // Owner-turn supervisor state (spark B7): composed HERE, never by mutating
  // ctx — ctx can be a shared object in tests and mutation would accumulate
  // blocks across runs.
  // (tickets 4c7aebf7 + 9a976d83) the [PRIOR NOTE STRUCK] block leads — '' unless the previous note was struck.
  const doctrineSystemContext = supervisorOwnerStateBlock || laneBoardSystemBlock || priorNoteStruckBlock
    ? `${[priorNoteStruckBlock, supervisorOwnerStateBlock, laneBoardSystemBlock].filter(Boolean).join('\n\n')}\n\n${ctx.systemContext ?? ''}`
    : ctx.systemContext;
  // ── The lead's call_in tool (roster 2026-10-06 D-2, chat-agent/call-in.ts): offered on an eligible HUMAN turn of a
  // signed-in user on a plain chat — never a supervisor chat, a machine-triggered run, a Dig-deeper rung, a council or
  // the Quick lane — under the store mode (canary by default). Its doctrine row rides the cross-check slot; the tool
  // itself is built just before the lead runs. CALL_IN_DISABLED=1 = never offered.
  const callInOffered: CallInOffer = (userId && !isSupervisorChat && !runIsMachineTriggered)
    ? callInOffer({ userId, supervisor: isSupervisorChat, machine: runIsMachineTriggered, escalation: !!args.escalation, council: isCouncil, quick: !!quickLaneModel, checkerRunning: spawnChecker }, await rosterConfig().catch(() => DEFAULT_ROSTER_CONFIG))
    : { offered: false, roles: [], why: 'not a human plain-chat turn', mode: 'off', canary: false };
  const callInRow = callInOffered.offered ? callInDoctrineRow(callInOffered.roles) : '';
  // Ticket e3113ec9 (2026-11-01): a HUMAN turn whose message asks for a VIDEO gets a turn-scoped
  // brief — the gap in the first line, then what Digby CAN make in the same answer. It rides the
  // cross-check slot beside the first-word note (same turn shape, same audience). Machine wakes
  // are excluded: nobody is waiting on a first line there and the note would leak into a
  // notify_user push. '' on every other turn, so the doctrine is byte-identical.
  const videoNote = (!runIsMachineTriggered && userId && !isSupervisorChat) ? videoCapabilityNote(args.message) : '';
  const doctrine = isCouncil
    ? councilLeadDoctrine({ systemContext: doctrineSystemContext, ...platformDoctrine })
    // A Quick-lane turn runs no checker, so the cross-check slot carries the lane's brief instead
    // (one search, answer from it — chat-agent/quick-lane-note.ts; QUICK_LANE_BRIEF_DISABLED=1).
    // First-word opener (ticket 4f7263e4, sighting-4 class fix): every HUMAN plain-chat turn that
    // is NOT the Quick lane also carries the first-word note — open with one honest line before
    // the first tool call (chat-agent/first-word-note.ts; FIRST_WORD_OPENER_DISABLED=1). A human
    // turn only: machine wakes share this doctrine and keep their byte-identical shape.
    : chatDoctrine({ mode, webSearchConfigured: !webSearchMissingOnInstance(), systemContext: doctrineSystemContext, crossCheckBlock: [parallelNote, quickLaneModel ? quickLaneBrief(process.env, { webBudgetEnforced: quickWebCaps?.mode === 'act', webSearchConfigured: !webSearchMissingOnInstance() }) : '', (!runIsMachineTriggered && !quickLaneModel) ? firstWordNote(process.env) : '', (!runIsMachineTriggered && quickLaneModel) ? quickFirstWordNote(process.env) : '', videoNote, callInRow].filter(Boolean).join('\n\n'), deadlineNote, ...platformDoctrine });

  // Checker-draft injection (the forced-SERP handoff is gone — owner
  // 2026-09-03): from the 2nd step on, WAIT for the checkers (bounded by their
  // own hard deadline — or CROSS_CHECK_SIMPLE_WAIT_MS for simple questions) so
  // the final answer always reconciles with them; step 0 runs immediately —
  // that's the research-overlap window. agent.ts excludes this wait from the
  // run deadline (deadlineOffsetMs).
  let draftsDelivered = false;
  // (ticket 899554af, reviewer F1/N1 2026-09-19) the action-verifier's
  // exoneration anchor — set TRUE only when the checker's draft text was
  // genuinely MERGED into this turn's answer: injected mid-loop below
  // (non-empty raced block) or reconciled in by the late-reconcile pass
  // (reconciledLive). Deliberately NOT draftsDelivered: that latch flips
  // before the gate check, so gate-timeout / empty-draft / late-armed runs
  // would falsely exonerate — those keep full conviction power here.
  let crossCheckMerged = false;
  // Owner 2026-09-18: set when the lead answer ships BEFORE the Double
  // Checker's draft — the persisted row is marked pendingCrossCheck and
  // late-crosscheck.ts revises it when the draft lands.
  let lateCrossCheckArmed = false;
  // Owner 2026-09-18 (audit: 55 of 273 Level 2 turns in 48 h were killed-checker
  // single-model answers after the lead BLOCKED up to 420 s on the draft): the
  // injector's wait is gated at CROSS_CHECK_GATE_MS; when the gate fires the
  // lead answers on its own research and finalize arms the late reconcile.
  let checkerGateTimedOut = false;
  // Progressive inline reconcile (autonomy loop #4): when the step-0 reconcile
  // pass outruns the inline bound the answer ships and the SAME running pass
  // finishes into the persisted row through late-crosscheck.ts.
  let lateReconcilePromise: Promise<string> | null = null;
  let lateReconcileBlock: string | null = null;
  const leadDrain = drainInbox('lead');
  // Compute policy (review 2026-09-26 M5): the STAKES clock starts at the
  // injector's FIRST opportunity (step ≥ 1, after the lead's step-0 model
  // turn), not at run start — on a glm-5.3 'max' seat step 0 alone commonly
  // exceeds the 90 s owner bound, which silently degraded the one blocking
  // path to wait 0. Today's kill-switch arithmetic keeps run start.
  let firstInjectAt: number | null = null;
  // The blocking gate for a run that cannot be answer-first: a guest (no chat
  // row) is bounded at 75 s (audit 2026-10-03 — it blocked up to 300 s).
  const checkerGateMs = blockingCheckerGateMs({ hasChatRow: !!chatId, gateMs: CROSS_CHECK_GATE_MS });
  const injectSystem = isCouncil ? (async (_step: number): Promise<string | null> => {
    // Council lead: colleague notes between steps. No wall clock (2026-10-20): every late report noted so far is in
    // this drain (note + push are synchronous in onLateReport), so the addendum flushes only what the lead never read.
    if (researchUnclocked) lateCouncil.markDelivered();
    return leadDrain();
  }) : checkersPromise ? async (step: number): Promise<string | null> => {
    if (step < 1) return null; // research-overlap window — nothing delivers at step 0
    if (!draftsDelivered) {
      // WAIT for the drafts (the deep-question reconcile contract; simple
      // questions cap the promise itself at CROSS_CHECK_SIMPLE_WAIT_MS) — but
      // never past CROSS_CHECK_GATE_MS from the run start (owner 2026-09-18:
      // the lead used to block here until the checker's 420 s kill, then ship
      // a single-model answer 7–12 min in and DISCARD the checker's research).
      // Past the gate the lead answers now; the checker keeps running and
      // late-crosscheck.ts reconciles its draft into the delivered message.
      if (firstInjectAt === null) firstInjectAt = Date.now();
      const GATE = '\u0000gate'; // NUL sentinel (escaped: a raw NUL made BSD grep treat this file as binary)
      // Compute policy (design §5 step 1, lines formerly `CROSS_CHECK_GATE_MS −
      // elapsed`): answer-first waits 0 — except the STAKES path, bounded by
      // STAKES_WAIT_MS (owner 2026-09-26: 90 s) from this first call — and the
      // kill switch / a guest run gets today's gate arithmetic byte-for-byte
      // (injectorWaitMs).
      const stakesPath = answerFirst && plan.checkerWaitMs > 0;
      const gateLeft = injectorWaitMs({ answerFirst, plan, elapsedMs: Date.now() - startedAt, stakesElapsedMs: Date.now() - firstInjectAt, gateMs: checkerGateMs, stakesBoundMs: STAKES_WAIT_MS });
      if (stakesPath && gateLeft > 0) send('progress', keyedProgress('double_checking_stakes', { waitMs: gateLeft }));
      const raced = await Promise.race([
        checkersPromise!.catch(() => ''),
        new Promise<string>(res => setTimeout(() => res(GATE), Math.max(0, gateLeft)).unref()),
      ]);
      if (raced === GATE) {
        if (answerFirst && !stakesPath) {
          // ANSWER-FIRST, no stakes wait (review 2026-09-26 H2): the draft is
          // simply not in yet. Inject NOTHING — the lead keeps its full step
          // budget and its own research judgment (the doctrine's answer-first
          // paragraph already says not to wait); this re-checks at zero cost on
          // every later step (no latch), so a draft landing mid-loop is
          // reconciled in-loop, and if none lands finalize arms the late
          // reconcile. Today's "answer now" note fires ONLY under the kill
          // switch / for guests, or when a STAKES wait actually expired.
          return null;
        }
        draftsDelivered = true;
        checkerGateTimedOut = true;
        const waitedS = Math.round((Date.now() - startedAt) / 1000);
        logger.info(`chat-agent L2: ${SEAT_LABELS.double} draft not in after ${waitedS}s (${stakesPath ? `stakes wait ${STAKES_WAIT_MS}ms from the injector's first call` : `gate ${checkerGateMs}ms`}) — the lead answers now; the draft reconciles into the delivered message when it lands`);
        send('progress', { message: STATUS.checker.stillChecking, stage: 'synthesis' });
        return `[The Double Checker is still researching after ${waitedS}s — do NOT wait for it. Write your final answer from your own research now; when its draft lands, the harness reconciles it into your delivered answer and updates the message.]`;
      }
      draftsDelivered = true;
      const block = raced;
      // (ticket 899554af F1) the exoneration anchor flips ONLY here — a real
      // draft block reached the orchestrator's context. The GATE and empty-
      // draft returns above leave crossCheckMerged false (conviction kept).
      if (block) {
        crossCheckMerged = true;
        // (review 2026-09-26 M6) the draft reached the lead IN-LOOP — the check
        // completed before the answer: the pill reads "Checked ✓" and no late
        // pass is armed. Answer-first only (the kill switch emits no pill).
        if (answerFirst) checkState = { state: 'checked' };
      } else if (answerFirst) {
        // The checker finished with no usable draft — nothing will ever
        // reconcile late: "Check didn't finish", never a silent blank.
        checkState = { state: 'interrupted' };
      }
      return block
        ? `${block}\n[The independent drafts above just arrived. Reconcile with them now, then write your final answer.]`
        : '[The Double Checker returned no usable draft — proceed on your own research; note lower confidence where you could not verify.]';
    }
    return null;
  } : undefined;

  const orchestratorT0 = Date.now();
  // Every level runs the orchestrator SEAT (L1 === L2/L3 default since
  // 2026-08-01; the model-roles override applies to all of them alike).
  // Dynamic roster: a QUICK-lane turn runs the Quick answers seat's model (turn_plan act).
  // Per-turn model pick (2026-10-04): the decision's pick leads when it acts.
  let orchestratorModel = quickLaneModel ?? pickedLeadModel ?? seatOrchestrator;
  // Image attachments need a VISION orchestrator — upgrade when the picked
  // model can't see (the default kimi-k3 sees; a text-only pick upgrades).
  // Registry-aware gate: a custom-endpoint seat honors its [vision] flag
  // instead of being wrongly normalized to glm-5.2 (= "no vision") and
  // silently bounced back to the built-in kimi-k3, which 401s on Edge.
  let orchestratorImages = args.userImages;
  let imageDropNotice = '';
  if (args.userImages?.length && !(await modelSupportsVisionForRun(orchestratorModel, runUserId))) {
    // Admin-visible rule (2026-09-22): the Digby seat's CUSTOM FALLBACK takes
    // the images when it can see and is servable; otherwise the built-in
    // vision model (kimi-k3, needs MOONSHOT_API_KEY); otherwise the images are
    // dropped honestly. The chat_orchestrator seat text on the admin page
    // states exactly this.
    // 2026-10-26 (self-host honesty, explorer F3) + review F2 (2026-10-27):
    // the Image reader (vision_describe) seat is consulted BEFORE the
    // built-in kimi-k3 leg — but ONLY on an actual admin OVERRIDE
    // (roleOverrideForRun), never the seat's EFFECTIVE model. Reading the
    // effective model returned the built-in glm-5.3-flash on every
    // UNTOUCHED instance (including production), displacing the guaranteed
    // kimi-k3 whole-turn upgrade with a seat documented as a non-streaming
    // single-shot image-describer. '' = untouched seat = the ladder
    // proceeds exactly as before this feature existed. Read ONCE, outside
    // the IIFE, so the log line below can label the pick honestly.
    const visionSeatOverride = await roleOverrideForRun('vision_describe');
    const visionTarget = await (async (): Promise<string | null> => {
      // Ghost mode (owner 2026-10-22): a ghost run never upgrades to the
      // built-in vision model or a seat fallback — that would route ghost
      // content (the images) to a cloud provider. The designated endpoint
      // either sees (its own [vision] flag) or the images are dropped
      // honestly, exactly like the keyless-Edge corner below.
      if (ghostPinned) return null;
      if (orchestratorCustomFallback && orchestratorCustomFallback !== orchestratorModel
        && (await modelSupportsVisionForRun(orchestratorCustomFallback, runUserId))
        && !(await seatUnservableReason(orchestratorCustomFallback, runUserId).catch(() => 'probe failed'))) return orchestratorCustomFallback;
      if (visionSeatOverride && visionSeatOverride !== orchestratorModel
        && (await modelSupportsVisionForRun(visionSeatOverride, runUserId))
        && !(await seatUnservableReason(visionSeatOverride, runUserId).catch(() => 'probe failed'))) return visionSeatOverride;
      if (process.env.MOONSHOT_API_KEY) return VISION_ORCHESTRATOR_MODEL;
      return null;
    })();
    if (visionTarget) {
      logger.info(`chat-agent: ${args.userImages.length} image(s) attached — upgrading orchestrator ${orchestratorModel} → ${visionTarget}${visionTarget === orchestratorCustomFallback ? ' (the seat\'s custom fallback)' : visionTarget === visionSeatOverride ? ' (the Image reader seat\'s admin override)' : ' (built-in vision model)'}`);
      orchestratorModel = visionTarget;
    } else {
      // Keyless Edge (review finding): upgrading to the built-in vision model
      // would 401 — keep the configured seat, DROP the images (the loop would
      // otherwise send image parts a text-only provider rejects), and tell
      // both the model and the user honestly.
      logger.warn(`chat-agent: ${args.userImages.length} image(s) attached but seat "${orchestratorModel}" is not vision-capable, its custom fallback cannot see, and the built-in vision model (${VISION_ORCHESTRATOR_MODEL}) has no key on this instance — continuing WITHOUT the images`, { source: 'chat-agent' });
      // Admin fix (logs / Model roles page): assign a vision model to the Digby seat or its custom fallback.
      send('progress', { message: STATUS.recover.noImages, stage: 'context' });
      orchestratorImages = undefined;
      imageDropNotice = '[HARNESS NOTE: the user attached image(s), but no vision-capable model is available on this instance — the images were NOT delivered to you. Answer the text, say you could not view the attached image(s), and do not guess their contents.]';
    }
  }
  // Per-run metric stamp (remediation P0 item N6): merged under this run's
  // loop_metrics rows. Built AFTER the vision upgrade so it names the model
  // that actually orchestrates; trigger mirrors the machine-flag expression
  // the usage rows already segment by (schedule/hook kept distinct).
  const chatMetricStamp: MetricStamp = {
    model: orchestratorModel,
    profile: 'chat',
    triggerKind: args.messageOrigin === 'schedule' || args.messageOrigin === 'hook'
      ? args.messageOrigin
      : (args.machineWake === true || machineOriginRun(args) ? 'machine' : 'user'),
    // E5 cost stamp (2026-09-25): the shadow decision that gated this wake
    // (args.decision — wake_triage / delta_material) rides the turn's run_spend
    // row as meta.decisionId so shed cost joins exactly.
    ...(args.decision?.id ? { decisionId: args.decision.id } : {}),
    // Patience plan 1a (2026-09-25): cost per level without joins — the
    // resolved level + how it was chosen ride run_spend / run_tokens too.
    mode,
    // Routing PROVENANCE, not run posture: an owner-dispatched agent send's
    // level was still chosen on the agent channel (send-mode channel floor),
    // so it keeps the raw origin read (owner-dispatch 2026-10-01).
    ...(args.routingSource ? { routingSource: args.routingSource } : (args.machineWake === true || (args.messageOrigin != null && args.messageOrigin !== 'user')) ? { routingSource: 'machine' } : {}),
  };
  turnSpendStamp = chatMetricStamp; // WI-D: the turn's run_spend row carries this stamp
  // N9 (2026-09-25): machine-wake reasoning-effort score (decision-gate purpose
  // `wake_effort`, platform/wake-effort.ts; SHADOW by default). The gate runs
  // CONCURRENTLY with the orchestrator call — never awaited before it, so no
  // latency is added — and this run's finalize labels the score from what the
  // wake actually did. Owner 2026-09-26 ("default all chats to auto even
  // supervisors"): the 2026-09-22 owner LOCK is lifted — resolveActEffort()
  // applies a calibrated act answer through the normal store mode + READY
  // admission; DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 is the HARD DISABLE
  // (unset = allowed). User turns never touch it. Fail-open throughout.
  const wakeEffortGate: WakeEffortGate | null = runIsMachineTriggered
    ? await import('../platform/wake-effort')
      .then((m) => m.startWakeEffortGate({
        message: args.message,
        origin: args.messageOrigin && args.messageOrigin !== 'user' ? args.messageOrigin : 'machine',
        chatKind: isFleetSupervisorChat ? 'fleet_supervisor' : isProjectSupervisorChat ? 'project_supervisor' : 'lane',
        historyMessages: ctx.conversationHistory.length,
        hasImages: !!orchestratorImages?.length,
        model: orchestratorModel,
        sessionId: runSessionId,
      }))
      .catch(() => null)
    : null;
  const wakeEffortActEffort = wakeEffortGate ? await wakeEffortGate.resolveActEffort().catch(() => null) : null;
  // Lead-effort A/B (owner 2026-10-04): a HUMAN-typed turn the human-turn cut would apply to (not machine, not the
  // Quick lane, not a stakes / escalation 'max' plan, not the council) gets a stable arm; null = not in the A/B.
  const leadEffortAbArm = (args.machineWake === true || (args.messageOrigin != null && args.messageOrigin !== 'user')
    || quickLaneModel || isCouncil || (plan.leadEffort === 'max' && plan.source !== 'preset'))
    ? null
    : leadEffortArm(`${chatId ?? runSessionId}:${args.userTurnAt ? new Date(args.userTurnAt as any).getTime() : startedAt}`);
  // roster 2026-10-06 D-2: this turn's call_in tool (one call per turn, a bounded window inside the lead's own run
  // budget, other-family models from the Auto pools — the seats when the pools cannot be read; never throws). The
  // closure outlives an empty-answer / leak retry of the lead, so a replay sees the first report, never a second run.
  const callIn = callInOffered.offered ? createCallInTool({
    roles: callInOffered.roles,
    leadModel: () => orchestratorModel,
    leadBudget: () => ({ startedAt: orchestratorT0, deadlineMs: profile.runDeadlineMs ?? 240_000 }),
    candidates: async () => {
      const seats = { pools: { checker: [seatDoubleChecker], colleague: [seatDoubleChecker, seatTripleChecker] }, catalog: new Map() };
      const live = (async () => {
        const [{ resolveEffectivePools }, { listChatModelCatalog }] = await Promise.all([import('../model-endpoints/auto-pools.service'), import('../model-endpoints/model-catalog')]);
        const [pools, cards] = await Promise.all([resolveEffectivePools(), listChatModelCatalog()]);
        return { pools: { checker: pools.checker.models, colleague: pools.colleague.models }, catalog: new Map(cards.map((c) => [c.spec, c] as const)) };
      })();
      return Promise.race([live, new Promise<typeof seats>((res) => setTimeout(() => res(seats), 3000).unref())]).catch(() => seats);
    },
    familyOf: modelFamily,
    unservable: (spec) => seatUnservableReason(spec, runUserId),
    runWorker: (req) => runChatWorker({
      worktree: '', sessionId: runSessionId, projectId: ctx.projectId || 'chat', ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}), userId: runUserId,
      permissionMode: 'auto', model: req.model, projectName: 'chat', branch: 'chat',
      userTurnAt,
      // A checker answers the same question with the recent turns; a colleague works its brief on its own.
      history: req.role === 'checker' ? ctx.conversationHistory.slice(-6).map(h => ({ role: h.role, content: h.content })) : [],
      userMessage: queryMessage,
      profile: { ...chatProfile('thinking', false), maxSteps: req.maxSteps, runDeadlineMs: req.windowMs },
      // DeepSeek built-ins run reasoning max with thinking on (owner 2026-09-03) — never on a custom endpoint id.
      providerExtra: (!req.model.includes(':') && req.model.startsWith('deepseek')) ? { reasoning_effort: 'max', thinking: { type: 'enabled' } } : undefined,
      doctrineOverride: req.doctrine,
      emit: req.emit,
      isCancelled: req.isCancelled,
      usage: turnUsage, // the call-in's tokens land on THIS turn's run_spend row
    }, 'cross_checker'),
    imageBlock: () => sharedImageBlock(),
    systemContext: ctx.systemContext,
    send,
    onCard: (cardKey, card) => {
      models[cardKey] = card;
      adapter.handle('subagent_end', { model: card.modelUsed, summary: card.response, time: card.time, persona: card.persona, cardKey });
    },
    record: (meta) => recordLoopMetric({ kind: LOOP_METRIC_KINDS.CALL_IN, sessionId: runSessionId, stamp: chatMetricStamp, meta }),
    isCancelled: args.isCancelled,
  }) : null;
  if (callInOffered.offered) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.CALL_IN, sessionId: runSessionId, stamp: chatMetricStamp, meta: { phase: 'offer', roles: callInOffered.roles, mode: callInOffered.mode, canary: callInOffered.canary } });
  }
  const runOrchestratorAttempt = (harnessNotice?: string) => runCodingAgent({
    worktree: '', sessionId: runSessionId, projectId: ctx.projectId || 'chat', ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}), userId: runUserId,
    permissionMode: 'auto', model: orchestratorModel, projectName: 'chat', branch: 'chat',
    // 2026-09-27: the SEAT this turn runs on — the in-loop lead-seat fallback
    // lanes (429 cooldown, deterministic 400 latch) consult THIS seat's admin
    // custom fallback (a supervisor chat's, not coding_default's) and file
    // seat_fallback rows under it.
    seatRole: quickLaneModel ? QUICK_SEAT_ROLE : orchestratorSeatKey,
    // build 2026-10-08 D-2: the turn's idempotency anchor (every attempt of THIS turn shares it — a requeue, a retry).
    intentScopeAnchor: args.continuation ? `cont:${args.continuation.taskId}:${args.continuation.round}`
      : args.escalation ? `esc:${args.escalation.ofMessageId}:${args.escalation.rung}` : intentAnchorRowId,
    // The Quick lane runs in the seat's FAST shape (thinking off / no reasoning_effort).
    ...(quickLaneModel ? { fastSeat: true } : {}),
    // roster 2026-10-06 C-4: the Quick lane's web budget (act refuses past it; shadow counts).
    ...(quickLaneModel && quickWebCaps ? { webToolCaps: quickWebCaps } : {}),
    // build 2026-10-08 A2b: the turn plan's lane picks the starting tool set (the plan already computed — no new ask).
    toolLaneHint: () => toolLaneHintFromPlan(turnPlan ?? turnPlanSettled),
    userTurnAt,
    // WI-D: every lead loop of this turn (first attempt, empty retry, seat
    // fallback, leak retry) records into the ONE turn ledger — a retry no
    // longer mints a second run_spend row.
    usage: turnUsage,
    // Owner-subscribed firing (ticket 4565991a): threaded into the agent loop's
    // ToolContext so the run's OWN schedule_message/update_schedule calls can
    // INHERIT the subscription onto successor rungs (the dormant-gate one-shot
    // ladder pattern) — same flag the user-row metadata compose stamps below.
    ...(args.scheduleOwnerArmed && args.messageOrigin === 'schedule' ? { scheduleOwnerArmed: true } : {}),
    // One-shot chain provenance (finding B1): the firing schedule's id rides
    // the tool ctx so own-chat `once` re-arms stamp their chain link.
    ...(args.firedByScheduleId && args.messageOrigin === 'schedule' ? { firedByScheduleId: args.firedByScheduleId } : {}),
    // Cohesive chat (platform/work-tools.ts): a Dig-deeper rung re-runs an
    // earlier ask — its requested-work tools card instead of executing twice;
    // a fresh human turn threads the user's OWN text (args.message — the raw
    // send, never the composed queryMessage with document text) so the gate
    // can bind a repo URL to what the user typed.
    ...(args.escalation ? { escalation: true } : {}),
    ...(userTurnAt && !(args.machineWake === true || machineOriginRun(args)) && typeof args.message === 'string' && args.message
      ? { userTurnText: args.message.slice(0, 20_000) }
      : {}),
    // Zero-tool pre-final gate (coding/agent.ts): byte-identical to the
    // classification the chat-busy run-lock marker carries (startDetachedChatRun
    // → claimChatLiveRun) — machine wakes/schedule/hook/agent/webhook runs may
    // not finalize with zero executed tool calls; user turns are never gated.
    machineTriggered: args.machineWake === true || machineOriginRun(args),
    // Owner-dispatch (2026-10-01): user-classified but UNATTENDED — keys the
    // long transient-backoff table in the agent loop (unattendedRun), nothing else.
    ...(args.machineWake !== true && isOwnerDispatchRun({ origin: args.messageOrigin, ownerDispatch: args.ownerDispatch, userTurnAt: args.userTurnAt }) ? { ownerDispatch: true } : {}),
    // Human-typed turns are LATENCY-bound (owner 2026-09-22, after a 10-minute
    // wait for "have you served glm5.3?": 48 h p50 655 s / p90 851 s from
    // question to answer across the supervisor chats, 14 of 19 over five
    // minutes — the orchestrator itself thinking at reasoning_effort 'max'
    // over ~215k tokens of context). A HUMAN turn on a built-in glm/deepseek
    // seat answers at CHAT_HUMAN_TURN_EFFORT (default 'high' ≈ 3 min/turn vs
    // 'max' ≈ 12 on glm-5.3); machine wakes keep 'max' (nobody is waiting).
    // Compute policy: a confident STAKES plan (or an escalation rung) keeps the
    // lead at 'max' — i.e. omits the human-turn 'high' override (effort 'max'
    // is the provider default; effortProviderExtra sends nothing for it).
    // Owner-dispatch (2026-10-01) keeps the RAW origin read here: the 'high'
    // cut exists because a human is waiting IN this chat; a dispatched lane is
    // not watched live (the owner waits on the supervisor), and coding lanes
    // never apply the cut — so the lane keeps 'max' like any agent send.
    ...(quickLaneModel || (plan.leadEffort === 'max' && plan.source !== 'preset')
      ? {}
      : humanTurnProviderExtra(orchestratorModel, args.machineWake === true || (args.messageOrigin != null && args.messageOrigin !== 'user'))),
    // Lead-effort A/B (owner 2026-10-04): arm 'high' caps the lead's already-sent effort (custom endpoints
    // included — the cut above never reaches them); 'max' is the control. See human-turn-effort.ts leadEffortArm.
    ...(leadEffortAbArm === 'high' ? { effortCap: 'high' as const } : {}),
    // (DELETED 2026-09-27 — owner: "no cost caps anywhere in the framework
    // unless set by a user at the project settings level".) The DepthBudget
    // USD rail — `forceFinalTurn` on the turn ledger crossing maxUsd ($0.25)
    // — is gone: no human turn, Dig-deeper rung or machine run is ever ended
    // or refused on cost. The turn ledger stays a record (depth.spentUsd).
    // N9: the owner-armed act path only (null otherwise) — re-evaluated per call so a seat fallback (kimi-k3 / custom) never receives the param.
    ...(quickLaneModel ? {} : effortProviderExtra(orchestratorModel, wakeEffortActEffort)),
    // Machine wakes aren't latency-bound and live-or-die by continuity: give
    // them a deeper transcript slice (their own prior notes are their state).
    // The upstream loaders honor machineWake too (buildChatQueryContext →
    // getEnrichedContext / loadChatContext), so ctx.conversationHistory really
    // carries up to 24 messages here — this slice is the final cap, not the
    // only one that matters (audit p10).
    // audit 2026-10-08 W6-1: a supervisor machine wake whose prompt carries the
    // [SINCE YOUR LAST WAKE] ledger diff keeps only its last few own notes (+
    // owner-typed rows; machine prompts elided to a stub) — the stale state
    // snapshots of 12 earlier wake prompts no longer ride every wake.
    // FS context map 2026-10-22 (#1): a supervisor OWNER turn reads the origin-chosen
    // history built above (null = switch off / read failed ⇒ the 8-row slice).
    history: (args.machineWake && args.wakeLedgerAt && isSupervisorChat
      ? selectWakeContinuityHistory(ctx.conversationHistory.slice(-24))
      : ownerTurnHistoryV2 ?? ctx.conversationHistory.slice(args.machineWake ? -24 : -8)).map(h => ({ role: h.role, content: h.content })),
    // A reject-back notice (the machine-wake integrity gate below) rides the
    // final user turn for maximum salience — the model re-answers the SAME
    // wake with the struck claims named and the citation contract restated.
    userMessage: [args.escalation ? escalationUserNote(args.escalation.rung) : '', queryMessage, imageDropNotice, harnessNotice].filter(Boolean).join('\n\n'),
    userImages: orchestratorImages,
    profile,
    doctrineOverride: doctrine,
    // WI-G (2026-09-25): on a RETIRING colour a machine wake is told ONCE, at
    // its next tool round, that the server is torn down in ~N s and to write
    // its final now (retire-nudge.ts; kill switch DEPLOY_RETIRE_NUDGE_DISABLED=1).
    // User turns pass through untouched; the inner injector (drafts / colleague
    // notes) is preserved ahead of the nudge.
    injectSystem: wrapInjectWithRetireNudge(injectSystem, {
      machineTriggered: runIsMachineTriggered,
      isRetiring,
      retiringSinceIso,
      onNudge: ({ step, remainingSeconds }) => {
        logger.info(`chat-agent: retiring colour — retire nudge delivered to ${chatId ?? 'anonymous'} at step ${step} (~${remainingSeconds}s left)`, { source: 'chat-agent' });
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.DEPLOY_RETIRE_NUDGE, sessionId: chatId ?? undefined, stamp: chatMetricStamp, meta: { ...(chatId ? { chatId } : {}), step, remainingSeconds, isSupervisorWake: isSupervisorChat } });
      },
    }),
    extraTools: councilTools ?? (callIn ? [callIn.tool] : undefined),
    emit: (type, data) => {
      // Hand-off polish (CT-2 a): notice the successful spawn as its tool
      // result streams (the same envelope reader the finalize card uses).
      if (spawnEndsTurn && !spawnedSessionThisTurn && type === 'tool_result' && (data as any)?.name === 'start_coding_session') {
        try {
          const [spawned] = spawnedSessionsInParts([{ type: 'tool_result', name: 'start_coding_session', result: (data as any)?.result }]);
          if (spawned) spawnedSessionThisTurn = spawned;
        } catch { /* fail-open: the loop runs as before */ }
      }
      ownerAfObserver?.observe(type, data);
      adapter.handle(type, data);
    },
    isCancelled: args.isCancelled,
    ...(spawnEndsTurn
      ? {
        endTurnAfterToolRound: () => {
          if (!spawnedSessionThisTurn) return null;
          spawnTurnEnded = true;
          return spawnEndTurnNotice(spawnedSessionThisTurn.title);
        },
      }
      : {}),
    // build 2026-10-08 A1: the owner turn's soft deadline (a fresh hook per invocation — a retry keeps one tool round).
    // Shadow passes the same hook; it only records and never collapses (spawnEndsTurn never runs on supervisor chats).
    ...(ownerAfObserver ? { endTurnAfterToolRound: ownerAfObserver.hook() } : {}),
  });
  // 2026-10-21 (FSN1021): every attempt of the turn (seat fallback, empty / leak / unbacked retries) lands its
  // tool calls here — the no-action-tool note judges the whole turn, never only the delivered attempt.
  const turnToolCallParts: Array<{ type?: string; name?: string }> = [];
  // 2026-10-22 (owner-turn live-state read): every attempt's tool calls WITH their args and results, in order — the
  // production-state matcher's grounding haystack (a read an earlier attempt made, e.g. the evidence an empty-answer
  // retry carries, grounds the delivered answer and forbids the re-run). Human supervisor turns only.
  const turnToolParts: any[] = [];
  // HR-1 (todo 76fd0cce): every attempt's tool calls WITH their args — an earlier
  // attempt's write can say what the turn proves for a claim the DELIVERED attempt
  // cannot back (and only that: HR-1 never widens backing by class). Separate array
  // from turnToolParts because the live-state grounding haystack is scope-gated.
  const turnWriteCallParts: Array<{ type?: string; name?: string; args?: unknown }> = [];
  const runOrchestrator = async (harnessNotice?: string) => {
    const attempt = await runOrchestratorAttempt(harnessNotice);
    for (const p of (attempt?.parts || []) as any[]) {
      if (p?.type === 'tool_call') turnToolCallParts.push({ type: 'tool_call', name: String(p.name ?? '') });
      if (p?.type === 'tool_call') turnWriteCallParts.push({ type: 'tool_call', name: String(p.name ?? ''), args: p.args });
      if (unreadStateNoteScope && (p?.type === 'tool_call' || p?.type === 'tool_result')) turnToolParts.push(p);
    }
    return attempt;
  };
  /** The delivered run's parts plus every attempt's tool calls (FSN1021 review): an attempt a fallback / retry replaced still backs a claim and still blocks a replay. */
  // Replay safety only (owner empty retry, unbacked retry) — the claim checks judge the delivered attempt exactly as before
  // (FSN1021 review round 6: letting earlier calls back claims kept opening holes; the note itself reads every attempt).
  const turnParts = (parts: unknown): any[] => (noActionToolNoteDisabled() ? ((parts as any[]) || []) : [...((parts as any[]) || []), ...turnToolCallParts]);
  let result = await runOrchestrator();
  // Retry-superseded parts (review round 3, ticket 8aa5688f B-1R-d): every
  // `result = retry` swap below drops attempt 1's parts on the floor — the
  // finalize's trailing-notify backstop would then not see a notify_user
  // envelope attempt 1 delivered on the intent-replay leg (no receipt
  // minted there) and would DOUBLE-PING. Each swap site appends the
  // superseded attempt's parts here; the finalize unions them with
  // result.parts. Same shape as rejectBackSupersededParts /
  // harnessSupersededParts (which cover their own swap paths).
  let retrySupersededParts: unknown[] = [];
  // feedback 5f22a689 (Kimi K3, 2026-08-14): an orchestrator that finalizes
  // EMPTY produced a silent blank bubble — no log, no error, no retry. Retry
  // ONCE when the run did NO tool work (an empty first-turn completion is the
  // classic provider blip and side-effect-free to replay — the same shape as
  // the cross-checker retry above); NEVER replay a run that fired tools (its
  // side effects — emails, canvases — already happened).
  // Rollout watch 2026-09-15 (tick 12): MACHINE wakes on the BUILT-IN seat
  // closed as "the model returned no text on this wake" 16× in 24h across the
  // fleet and project supervisors (kimi-k3 reasoning-only turns) — each a LOST
  // wake: the coalesced agent messages, the hook event, the sweep all went
  // unanswered until the next organic wake. Every supervisor wake fires tools
  // (get_chat_status, goal_list…), so the no-tool replay never applied, and
  // the seat fallback below is for OVERRIDE seats only. A machine wake whose
  // tool work was READ-ONLY (firedReplayUnsafeTool — the leak retry's replay-
  // safety rule) now gets the same ONE retry, carrying the read results as
  // evidence so nothing is re-fetched; a wake that fired a mutating tool is
  // never replayed.
  // Review F1 (ticket 4f7263e4 first-word opener): read answerTextWithoutOpener,
  // not answerText — a human turn's delivered opener ("I'll check X now") is
  // user-visible answer text but NOT gate-relevant content. Pre-opener, a turn
  // that finalized empty after tool calls counted as EMPTY and recovered (the
  // exact 5f22a689 / 871d203b classes these gates exist for); reading
  // answerText would blind every gate below on the human lane.
  const firstIsEmpty = (() => { const t = (result.finalText || adapter.answerTextWithoutOpener || '').trim(); return !t || t === EMPTY_ASSISTANT_PLACEHOLDER; })();
  const firstFiredTools = (result.parts || []).some((p: any) => p?.type === 'tool_call');
  const machineReadOnlyReplay =
    firstIsEmpty && firstFiredTools && args.machineWake === true
    && !firedReplayUnsafeTool(result.parts as any[]);
  // OWNER turn on a SUPERVISOR chat (tt-rd audit 2026-09-27, finding
  // upward-chatter-4 — the 871d203b failure: the owner's "what is going on…"
  // ended EMPTY after 5 tool calls on glm-5.3 and the harness persisted the
  // fallback note, so the question was never answered): the same ONE retry,
  // carrying the read evidence. update_supervisor_state is replay-SAFE here
  // (its merge is validated + idempotent on re-merge); every other mutating
  // tool still forbids the replay.
  const ownerTurnSupervisorReplay =
    firstIsEmpty && firstFiredTools && isSupervisorChat && !runIsMachineTriggered && !machineReadOnlyReplay
    && !firedReplayUnsafeTool(turnParts(result.parts), { allow: ['update_supervisor_state'] });
  const evidenceReplay = machineReadOnlyReplay || ownerTurnSupervisorReplay;
  if (firstIsEmpty && !args.isCancelled?.() && (!firstFiredTools || evidenceReplay)) {
    const toolCalls = (result.parts || []).filter((p: any) => p?.type === 'tool_call').length;
    logger.warn(`chat-agent: orchestrator ${orchestratorModel} returned empty on a ${machineReadOnlyReplay ? `machine wake with ${toolCalls} read-only tool call(s)` : ownerTurnSupervisorReplay ? `supervisor owner turn with ${toolCalls} tool call(s)` : 'no-tool run'} — retrying once (${machineReadOnlyReplay ? 'rollout watch 2026-09-15' : ownerTurnSupervisorReplay ? 'tt-rd audit 2026-09-27' : 'feedback 5f22a689'})`, { source: 'chat-agent' });
    send('progress', { message: STATUS.recover.emptyReply, stage: 'synthesis' });
    adapter.resetForRetry(); // a stale suppressed/segment would corrupt the retry's stream
    const evidence = evidenceReplay ? summarizeToolEvidence(result.parts) : '';
    const retry = await runOrchestrator(
      machineReadOnlyReplay
        ? '[HARNESS NOTE — EMPTY COMPLETION: your previous attempt at this wake ended with NO text (reasoning only). '
          + (evidence ? `Its read-only tool calls and results are summarized below — treat them as evidence already gathered THIS wake and do not re-fetch them:\n${evidence}\n` : '')
          // HARNESS-RECEIPTS (2026-10-20): on a supervisor the harness writes the receipts — the clause follows the doctrine variant in force.
          + `Write the wake note now — ${isSupervisorChat ? wakeNoteRetryCloseClause() : 'close with the ACTIONS TAKEN or WAKE: no-op line the doctrine requires'} — and act where the events call for it.]`
        : ownerTurnSupervisorReplay
          ? '[HARNESS NOTE — EMPTY COMPLETION: your previous attempt at answering the OWNER\'s message ended with NO text (reasoning only). '
            + (evidence ? `Its tool calls and results are summarized below — treat them as evidence already gathered THIS turn and do not re-fetch them:\n${evidence}\n` : '')
            + 'Answer the owner now, in plain words, from that evidence and the ledger — the owner is waiting on this reply.]'
          : undefined,
    ).catch((err: any) => {
      logger.warn(`chat-agent: orchestrator retry failed: ${err?.message}`, { source: 'chat-agent' });
      return null;
    });
    // F1 (review of ticket 4f7263e4): answerTextWithoutOpener — the retry must
    // produce real content, not just attempt-2's opener line (the adapter was
    // reset, so attempt-1's opener no longer masks emptiness; this read now
    // excludes attempt-2's opener too).
    const recovered = !!(retry && (retry.finalText || adapter.answerTextWithoutOpener || '').trim() && (retry.finalText || adapter.answerTextWithoutOpener || '').trim() !== EMPTY_ASSISTANT_PLACEHOLDER);
    if (recovered) {
      retrySupersededParts = [...retrySupersededParts, ...((result.parts ?? []) as unknown[])];
      result = retry!;
    }
    if (machineReadOnlyReplay) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MACHINE_WAKE_EMPTY_RETRY,
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: { seat: isProjectSupervisorChat ? 'project_supervisor' : isFleetSupervisorChat ? 'supervisor' : 'chat_orchestrator', model: orchestratorModel, recovered, toolCalls },
      });
    } else if (ownerTurnSupervisorReplay) {
      recordLoopMetric({
        kind: 'owner_turn_empty_retry',
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: { seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel, recovered, toolCalls, ...(ownerTurnUserRowId ? { askMessageId: ownerTurnUserRowId.slice(0, 8) } : {}) },
      });
    }
  }

  // ── Seat FALLBACK (2026-09-11, owner: "our fleet supervisor chat is fully broken") ──
  // F4(b) (review of ticket 4f7263e4): set when the orchestrator seat fallback
  // REPLACED the answer (recovered seat-fallback path) — attempt-1's opener-only
  // chunks already streamed, so the 'complete' event must carry the fallback's
  // finalText for live viewers to swap in (declared here at function scope,
  // beside the other swap flags; assigned inside the fallback block below).
  let seatFallbackSwapped = false;
  // The supervisor seat on glm-5.3 finalized EMPTY on 23 of 124 wakes since the
  // seat swap (0 on kimi-k3 before it) — each after 9-11 min of real tool work,
  // so the no-tool replay above never applied and the owner saw dead bubbles.
  // When an OVERRIDE seat returns nothing, finish the turn on the built-in
  // orchestrator with the failed attempt's tool evidence in the notice, and
  // forbid redoing side effects. One bounded fallback; never for the built-in
  // seat itself (that is the retry above); never when cancelled, and never when
  // the built-in is unservable (keyless Edge — fail closed on a probe error).
  // Rollout watch 2026-09-15 (tick 16): the fallback also covers an OVERRIDE
  // seat whose endpoint REJECTED the request shape (agent.ts 'capability'
  // give-up — tool calling not enabled on the server). 26 supervisor wakes in
  // one hour ended as "Sorry — the AI provider returned an error (HTTP 400)"
  // after the supervisor seat moved to a LiteLLM-fronted deepseek-v4.1-flash;
  // the seat is the owner's decision, but the TURN can still be finished on
  // the built-in seat instead of going dark.
  const seatRejectedShape = result.modelErrored === true && result.modelErrorKind === 'capability';
  // Owner 2026-09-15 ("add custom fallback"): the admin's fallback for this
  // seat is tried FIRST — and it also covers the BUILT-IN seat, which had no
  // fallback at all before. Then the built-in orchestrator, when the seat was
  // an override. Each candidate must differ from the failed seat and be
  // servable here (keyless Edge — fail closed on a probe error).
  const orchestratorNeedsFallback =
    // F1 (review of ticket 4f7263e4): answerTextWithoutOpener, not answerText —
    // an opener-only run (the failed seat wrote one line, fired tools, then
    // finalized empty) is still an empty run for the fallback trigger.
    (!(result.finalText || adapter.answerTextWithoutOpener || '').trim() || seatRejectedShape)
    && !args.isCancelled?.();
  // Probes run ONLY when a fallback is actually needed (a clean turn costs nothing).
  // Ghost mode (owner 2026-10-22): a ghost run NEVER falls back to another
  // model — every fallback target (seat, custom, built-in kimi-k3) would
  // re-route the ghost turn's content (incl. the summarized tool evidence)
  // to a provider the admin never designated. The turn ends with its honest
  // empty/error note instead (adversarial review B6/M1).
  const orchestratorFallbackTarget: string | null = orchestratorNeedsFallback && !ghostPinned
    ? await (async () => {
      // A QUICK-lane turn (dynamic roster 2026-10-03) whose quick model returned nothing is finished
      // on the Digby seat first — the lead the user would have had without the Quick lane.
      // …and so is a turn the per-turn model pick led (2026-10-04).
      if ((quickLaneModel || pickedLeadModel) && seatOrchestrator !== orchestratorModel
        && !(await seatUnservableReason(seatOrchestrator, runUserId).catch(() => 'probe failed'))) return seatOrchestrator;
      if (orchestratorCustomFallback && orchestratorCustomFallback !== orchestratorModel
        && !(await seatUnservableReason(orchestratorCustomFallback, runUserId).catch(() => 'probe failed'))) return orchestratorCustomFallback;
      if (orchestratorModel !== ORCHESTRATOR_MODEL
        && !(await seatUnservableReason(ORCHESTRATOR_MODEL, runUserId).catch(() => 'probe failed'))) return ORCHESTRATOR_MODEL;
      return null;
    })()
    : null;
  if (orchestratorNeedsFallback && orchestratorFallbackTarget) {
    const failedSeat = orchestratorModel;
    const fallbackModel = orchestratorFallbackTarget;
    const isCustomFallback = fallbackModel === orchestratorCustomFallback;
    const evidence = summarizeToolEvidence(result.parts);
    const toolCalls = (result.parts || []).filter((p: any) => p?.type === 'tool_call').length;
    const reason = seatRejectedShape ? 'capability_rejected' : 'empty';
    logger.warn(`chat-agent: orchestrator seat ${failedSeat} ${seatRejectedShape ? 'REJECTED the request shape (HTTP 400)' : 'returned no output'} after ${Date.now() - orchestratorT0}ms (${toolCalls} tool calls) — finishing the turn on ${isCustomFallback ? 'the admin\'s custom fallback' : 'the built-in'} ${fallbackModel} (seat fallback: ${reason})`, { source: 'chat-agent' });
    send('progress', { message: STATUS.recover.backup, stage: 'synthesis' });
    orchestratorModel = fallbackModel; // runOrchestrator reads it at call time; the answer card follows
    adapter.resetForRetry();
    const fallback = await runOrchestrator(
      (seatRejectedShape
        ? `[HARNESS NOTE — SEAT FALLBACK: the configured model for this seat (${failedSeat}) REJECTED the request shape this turn (HTTP 400 — its endpoint cannot serve tool-enabled requests as sent; the owner has been ticketed), so you (${fallbackModel}) are finishing it. `
        : `[HARNESS NOTE — SEAT FALLBACK: the configured model for this seat (${failedSeat}) worked this turn but produced NO final text, so you (${fallbackModel}) are finishing it. `)
      + (evidence
        ? `Its tool calls and results are summarized below — treat them as evidence already gathered THIS turn and do NOT repeat side-effecting actions (messages, schedules, tickets, todos, state writes) they show as done:\n${evidence}\n`
        : 'It made no tool calls. ')
      + 'Write the final answer/note now.]',
    ).catch((err: any) => { logger.warn(`chat-agent: seat fallback on ${fallbackModel} failed: ${err?.message}`, { source: 'chat-agent' }); return null; });
    const recovered = !!(fallback && (fallback.finalText || adapter.answerTextWithoutOpener || '').trim() && !fallback.modelErrored);
    // F4(b) (review of ticket 4f7263e4): a recovered fallback replaced the
    // failed attempt, whose opener-only chunks already streamed to live
    // viewers — flag it so the 'complete' event carries the fallback's
    // finalText and the UI swaps (same swap-in as leakRetrySwapped).
    if (recovered) { result = fallback!; seatFallbackSwapped = true; }
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SEAT_FALLBACK,
      sessionId: runSessionId,
      stamp: chatMetricStamp,
      // Project-supervisor preflight 2026-09-14: name the seat that actually
      // resolved (project_supervisor vs supervisor) so seat_fallback rows can
      // be split per layer once a project is enabled.
      meta: { seat: quickLaneModel ? QUICK_SEAT_ROLE : orchestratorSeatKey, failedSeat, fallbackModel, recovered, toolCalls, reason, customFallback: isCustomFallback, ...(quickLaneModel ? { lane: 'quick' } : {}) },
    });
  }

  // ── Plain-text tool-call leak retry (owner report, chat 7dc031fb) ──────────
  // agentLoop's in-loop leak retry only matches the STRUCTURAL native-token
  // leak (looksLikeAttemptedToolCall); kimi-k3 in plain chats also leaks the
  // PROSE form — `list_chats({...})` on its own line or a fenced tool-call
  // JSON as the final text — which sailed through and rendered as the answer.
  // Port of the coding loop's leakRetries mechanism (coding/agent.ts): same
  // nudge, same bound (2). The nudge rides runOrchestrator(harnessNotice) —
  // the reject-back channel — since the loop's own transcript is gone here.
  // Replay safety: the coding loop retries IN-LOOP (nothing re-executes); this
  // seam re-runs the whole orchestration, so it stands down when the run fired
  // any mutating tool (read-only calls replay harmlessly). After a retry,
  // trust ONLY retry.finalText — never adapter.answerText (review B2: post-
  // resetForRetry the adapter holds attempt1+attempt2 concatenated).
  let leakRetrySwapped = false;
  {
    let leakCandidate = result.finalText || adapter.answerText || '';
    let chatLeakRetries = 0;
    while (
      chatLeakRetries < MAX_CHAT_LEAK_RETRIES
      && !args.isCancelled?.()
      // Call-shaped leaks (tool-call-leak.ts) OR first-person narration of
      // calls the run never made (feedback ab9d96eb — the 21:35Z "*(Calling
      // list_chats + get_chat_messages on…)*" answer the call-shape detector
      // provably misses). Both shapes ride this same bounded retry.
      && (looksLikeLeakedChatToolCall(leakCandidate) || looksLikeToolCallNarration(leakCandidate))
    ) {
      // FSN1021 review: an earlier attempt's send blocks the replay too; its update_supervisor_state does not — the
      // owner empty retry already judged that write replay-safe and re-ran past it (the delivered attempt's own still blocks).
      // Supervisor HUMAN turns only — plain chats and machine wakes replay exactly as before.
      const unsafeTool = firedReplayUnsafeTool(result.parts as any[])
        || (!isSupervisorChat || runIsMachineTriggered || noActionToolNoteDisabled() ? null : firedReplayUnsafeTool(turnToolCallParts, { allow: ['update_supervisor_state'] }));
      if (unsafeTool) {
        logger.warn(`chat-agent: plain-text tool-call leak in the final answer, but the run fired mutating tool '${unsafeTool}' — NOT replaying (side effects already happened)`, { source: 'chat-agent' });
        break;
      }
      chatLeakRetries += 1;
      logger.warn(`chat-agent: plain-text tool-call leak in the final answer — nudging and retrying (${chatLeakRetries}/${MAX_CHAT_LEAK_RETRIES})`, { source: 'chat-agent' });
      send('progress', { message: STATUS.recover.hiccup, stage: 'leak' });
      adapter.resetForRetry(); // a stale suppressed/segment would corrupt the retry's stream
      const retry = await runOrchestrator(CHAT_LEAK_NUDGE).catch((err: any) => {
        logger.warn(`chat-agent: tool-call-leak retry failed: ${err?.message}`, { source: 'chat-agent' });
        return null;
      });
      if (!retry || !(retry.finalText || '').trim()) {
        logger.warn('chat-agent: tool-call-leak retry returned empty — delivering the original answer', { source: 'chat-agent' });
        // The adapter was reset, so its answerText may now be attempt-polluted
        // — pin the pre-retry candidate as the deliverable when the original
        // run's finalText was empty (leak lived only in the streamed text).
        if (!(result.finalText || '').trim()) result = { ...result, finalText: leakCandidate };
        break;
      }
      retrySupersededParts = [...retrySupersededParts, ...((result.parts ?? []) as unknown[])];
      result = retry;
      leakRetrySwapped = true; // attempt-1's leaked chunks already streamed — live viewers swap to this text
      leakCandidate = retry.finalText || '';
    }
  }
  // ── HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20; platform/harness-receipts.ts) ──
  // What a supervisor MACHINE wake did is stated from the harness record, not
  // the model's own 'ACTIONS TAKEN' text. Phase 1 (here, BEFORE the receipt
  // passes below — the unbacked-claim / follow-through grounding / receipt-tool
  // TRIPLE checks that rewrote the ids the model copied wrong after the fact):
  // read the wake's REAL mutating calls (decision-outcome-labels
  // isRealActionTool — the same vocabulary as realActionToolNames) with their
  // results and receipts, and strip the model-typed ACTIONS TAKEN block. A note
  // that WAS only that block is stripped in phase 2 instead (an empty final
  // here would fall back to the streamed text). Phase 2 (after the KPI footer,
  // outside the post-delivery verifier's text) appends the harness block and
  // stamps metadata.harnessActions. Never blocks or bounces a wake; any error
  // leaves the note as the model wrote it. Kill switch
  // SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1.
  // Review fixes (2026-10-20): (a) an OWNER-ARMED schedule firing (the owner's
  // digest — metadata.kind owner_digest, DELIVERED content the owner asked
  // for) is never stripped or appended to: its 'ACTIONS TAKEN (last 24h)'
  // section summarises the fleet, it is not the wake's receipt block — the
  // record rides the metadata only. (b) The pre-delivery reject-back
  // re-orchestration (runRejectBackAndSecondPass below) is a full orchestrator
  // turn with every tool: the view is REBUILT there from every attempt's
  // parts (attempt 1's calls really executed; the retry's are added) and the
  // retry's own block gets this phase's strip.
  let harnessView: HarnessReceiptsView | null = null;
  let harnessModelBlockLines = 0;
  let harnessForgedLines = 0; // of harnessModelBlockLines: model-typed copies of harness lines (footnote wording)
  const harnessTextExempt = args.scheduleOwnerArmed === true && args.messageOrigin === 'schedule';
  let harnessViewOf: ((parts: unknown[], receipts: unknown) => HarnessReceiptsView) | null = null;
  let harnessSupersededParts: unknown[] = [];
  const harnessStripPhase1 = (r: typeof result): typeof result => {
    if (harnessTextExempt) return r;
    const f = r.finalText || '';
    const s = f.trim() ? stripModelActionsBlock(f) : null;
    if (!s || !s.strippedLines || !s.text.trim()) return r;
    harnessModelBlockLines += s.strippedLines;
    harnessForgedLines += s.forgedLines;
    const out = { ...r, finalText: s.text };
    if (out.parts?.length) out.parts = stripModelActionsBlockFromParts(out.parts).parts;
    return out;
  };

  let forgedChromeSwapped = false; // review fix 2: the owner-turn strip marks the live view for the swap (harnessReceiptsSwapped semantics)
/** Review fix 3 (ticket 0c647003): a swapped-in retry's text never passed the owner-turn
 *  forged-chrome strip (the strip ran before the retry) — re-apply it to the retry's finalText,
 *  mirroring how the machine path's reject-back retry re-runs harnessStripPhase1 (2026-10-20
 *  precedent). Strip-only, same guards: never to empty (the retry's text is kept whole), plain
 *  blocks kept, and the swap flag + stamp follow the strip's own contract. */
const reStripForgedChromeOnRetry = (r: typeof result): { r: typeof result; swapped: boolean } => {
    const t = stripForgedHarnessChrome(r.finalText ?? '');
    if (!t.strippedLines || !t.text.trim() || t.text === r.finalText) return { r, swapped: false };
    return { r: { ...r, finalText: t.text }, swapped: true };
  };

  // Ticket 0c647003 (2026-10-24): this gate stays MACHINE-WAKE ONLY. An OWNER
  // turn on a supervisor chat is covered by its own STRIP-ONLY block below
  // (search 'FORGED-CHROME STRIP (OWNER TURN)') — never by this record
  // (phase 2 appends a harness block; an owner reply's bytes are pinned by
  // the owner-answer-first / follow-through contracts, and a human turn on a
  // supervisor chat is NEVER touched per the 2026-10-20 pin).
  if (isSupervisorChat && runIsMachineTriggered && chatId && !args.isCancelled?.() && result.modelErrored !== true && !supervisorHarnessReceiptsDisabled()) {
    try {
      const { isRealActionTool } = await import('../platform/decision-outcome-labels');
      const { supervisorReportUpIsAction } = await import('../coding/schedule-cadence');
      // A project supervisor's send to the owner's Fleet Supervisor is a REPORT-UP (the doctrine's third
      // close shape), never a lane action — unless SUPERVISOR_REPORT_UP_IS_ACTION=1 restores the old count.
      const reportUpTarget = isProjectSupervisorChat && !supervisorReportUpIsAction()
        ? await import('../platform/supervisor.service').then((m) => m.reportUpTargetForSession(chatId)).catch(() => null)
        : null;
      harnessViewOf = (parts, receipts) => harnessReceiptsView({ parts, receipts, sessionId: chatId, reportUpTargetChatId: reportUpTarget, isAction: isRealActionTool });
      harnessView = harnessViewOf((result.parts ?? []) as unknown[], result.receipts);
      result = harnessStripPhase1(result);
    } catch (err: any) {
      harnessView = null;
      harnessViewOf = null;
      logger.warn(`chat-agent: harness receipts skipped for ${chatId.slice(0, 8)} (note kept as written): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }

  // ── FORGED-CHROME STRIP (OWNER TURN, ticket 0c647003, 2026-10-24) ────────────
  // The machine-wake harness-receipts record above never reaches an OWNER turn
  // on a supervisor chat — and that is precisely where the incident hit: chat
  // 5c3f302e (project supervisor) answered the owner at 01:12:42Z and 01:19:05Z
  // with a model-typed 'ACTIONS TAKEN (harness):' block plus a 'Reported up
  // (harness):' line citing THIRTEEN invented ids (todos 3d12de01/c6160e1c/
  // b6ed9942, session 5fc8d6bd, goal 8de39fdd, receipts d8397fca/1a23abbb/
  // 30bc81c3/60f3b944/b21322a5/1c362f1e/4f4cbcc4/480fd0b2 — none exists in any
  // of nine DB tables) on a turn whose only tool calls were reads. Delivered
  // verbatim (the post-delivery verifier is observe-only on human turns), no
  // in-channel correction ever landed. This block is STRIP-ONLY: it removes the
  // harness-impersonating chrome (the '(harness)'-decorated block header with
  // its items, and forged harness lines wherever they stand) and NOTHING else —
  // no phase-2 appendix ever lands on an owner reply (its bytes are pinned by
  // the owner-answer-first / follow-through contracts; a clean reply passes
  // byte-identical), and the model's PLAIN 'ACTIONS TAKEN' self-report is KEPT
  // (the 2026-10-20 human-turn pin; an owner reply may report its own work in
  // its own words — the unbacked-claim detector owns unbacked PLAIN claims).
  // An execution-shaped LIE beside the chrome ('Done this wake: goal 8de39fdd
  // created …') is evidence-class prose, not chrome — the post-delivery
  // verifier owns it (it filed 0c647003); this block never rewrites prose.
  // Observability: a strip stamps metadata.forgedChrome + one
  // supervisor_forged_chrome metric row (both only when something was
  // actually stripped — a clean reply stamps nothing). Kill switch
  // SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED=1 restores the pre-ticket
  // passthrough byte-for-byte.

  const forgedChromeStrip: { lines: number; blockLines: number; forgedLines: number; emptyKept?: boolean } | null = (() => {
    if (!isSupervisorChat || runIsMachineTriggered || !chatId || args.isCancelled?.() || result.modelErrored === true || supervisorOwnerTurnReceiptsDisabled()) return null;
    try {
      const strippedModelText = stripForgedHarnessChrome(result.finalText ?? '');
      // Review fix 1 (ticket 0c647003): NEVER strip a reply to nothing — an empty finalText falls back to
      // the streamed answerText downstream (let raw = result.finalText || adapter.answerText || ''), which
      // would resurrect the FORGED text verbatim while this stamp claims it was removed (the machine path's
      // harnessStripPhase1 carries the same guard). A reply that is ONLY chrome is left as delivered, stamped
      // emptyKept so the row and metric never claim a removal that did not happen.
      if (strippedModelText.strippedLines && !strippedModelText.text.trim()) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SUPERVISOR_FORGED_CHROME, sessionId: chatId, stamp: chatMetricStamp, value: 0,
          meta: { emptyKept: true, blockLines: strippedModelText.blockLines, forgedLines: strippedModelText.forgedLines, seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', origin: args.messageOrigin ?? null, ownerTurn: true },
        });
        return { lines: 0, blockLines: strippedModelText.blockLines, forgedLines: strippedModelText.forgedLines, emptyKept: true };
      }
      const strippedParts = stripForgedHarnessChromeFromParts((result.parts ?? []) as unknown[]);
      const lines = strippedModelText.strippedLines;
      if (!lines && !strippedParts.strippedLines) return null;
      result = {
        ...result,
        ...(strippedModelText.strippedLines ? { finalText: strippedModelText.text } : {}),
        ...(strippedParts.strippedLines ? { parts: strippedParts.parts as typeof result.parts } : {}),
      };
      forgedChromeSwapped = true; // review fix 2: live viewers swap to the stripped text (318b3175 semantics — never a silent shrink)
      const stamp = { lines, blockLines: strippedModelText.blockLines + strippedParts.blockLines, forgedLines: strippedModelText.forgedLines + strippedParts.forgedLines };
      recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SUPERVISOR_FORGED_CHROME,
          sessionId: chatId,
          stamp: chatMetricStamp,
          value: lines,
          meta: {
            blockLines: strippedModelText.blockLines + strippedParts.blockLines,
            forgedLines: strippedModelText.forgedLines + strippedParts.forgedLines,
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor',
            origin: args.messageOrigin ?? null,
            ownerTurn: true,
          },
      });
      return stamp;
    } catch (err: any) {
      logger.warn(`chat-agent: forged-chrome strip skipped for ${chatId.slice(0, 8)} (reply kept as written): ${err?.message ?? err}`, { source: 'chat-agent' });
      return null;
    }
  })();

  // ── Unbacked dispatch claim (2026-09-29, TB 2.1 v3c bench — unbacked-claim.ts) ──
  // A HUMAN turn on a supervisor chat that CLAIMS a dispatch and cites a
  // receipt id while the run made NO tool call invented that id — nothing was
  // sent. Re-run ONCE with a harness note naming it (no tool call ⇒ no side
  // effect to repeat). An id matching a real receipt of this chat (an honest
  // reference to an earlier send) never triggers it.
  // Audit 2026-10-06 T6-3 (others.md F2, fleet.md F4): the same ONE re-run
  // when a zero-tool answer claims FRESH verification ("fresh reads", "verified
  // … just now", "re-read", "recount", "checked live") — the dispatch check
  // wins when both fire (one retry per turn). Kill switch
  // SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED=1.
  // Audit 2026-10-16 (todo 6f8b52b7, gap i — specimen af8ed7b6): the SAME
  // detection now also runs on MACHINE wakes of supervisor chats, FLAG-FIRST
  // (observe-only): a hit records the supervisor_unbacked_claim_machine metric
  // (id + phrase) but does NOT retry and does NOT rewrite — the machine wake
  // may legitimately carry report-only prose. Flips to enforcement after the
  // measured false-positive rate. Kill switch SUPERVISOR_UNBACKED_MACHINE_WAKE_DISABLED=1.
  // ── Owner-status proxy detector (todo 908f48a7, monitor lesson 5, 2026-10-16) ──
  // A supervisor machine note's owner-facing status claims checked against the
  // LEDGER, not proxies: a best-leg rate value presented as the end-to-end
  // rate vs a target (specimens 33e56bf7 / d4a3eb4e); "nothing needs the
  // owner" counted from open cards alone while todos sit blocked on an owner
  // action or an approved-but-never-landed one (970e4dcb / ec93e808 / 19e43f7f
  // / 8847b231 / ce0c7009 / ff3bc329 / f561c547); "started" with the todo
  // pending and no mutating receipt (eb4f8455). OBSERVE-ONLY, the same ladder
  // as 6f8b52b7 / PR #1548: metric only, never a rewrite, never a retry, never
  // a block — enforcement is a later decision on the measured rate. Its OWN
  // kill switch, independent of the unbacked leg's below.
  if (isSupervisorChat && runIsMachineTriggered && chatId && userId && !args.isCancelled?.() && !ownerStatusProxyDisabled()) {
    const statusLedger = await loadOwnerStatusLedgerView({
      userId,
      projectId: isProjectSupervisorChat ? (supervisorRow?.projectId ?? null) : null,
      parts: result.parts as any[] | undefined,
    }).catch(() => null);
    if (statusLedger) {
      const statusMismatches = detectOwnerStatusProxyMismatches(result.finalText || adapter.answerText || '', statusLedger);
      if (statusMismatches.length) {
        logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake carried ${statusMismatches.length} owner-status proxy mismatch(es) (observe-only) — todo 908f48a7`, { source: 'chat-agent' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.OWNER_STATUS_PROXY_MISMATCH,
          sessionId: runSessionId,
          stamp: chatMetricStamp,
          meta: {
            chatId,
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor',
            model: orchestratorModel,
            findings: statusMismatches.slice(0, 6).map((m) => ({ kind: m.kind, proxyPair: m.proxyPair, claim: m.claim.slice(0, 100), evidence: m.evidence.slice(0, 160) })),
            count: statusMismatches.length,
          },
        });
        // Rate-premise inconsistencies ride their own kind (todo 908f48a7 item
        // 3): a note implying a rate the register does not hold like-for-like
        // is a register problem, not only a prose problem.
        const rateInconsistent = statusMismatches.filter((m) => m.kind === 'rate_premise_inconsistent');
        if (rateInconsistent.length) {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.RATE_PREMISE_INCONSISTENT,
            sessionId: runSessionId,
            stamp: chatMetricStamp,
            meta: {
              chatId,
              seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor',
              model: orchestratorModel,
              findings: rateInconsistent.slice(0, 6).map((m) => ({ proxyPair: m.proxyPair, claim: m.claim.slice(0, 100), evidence: m.evidence.slice(0, 160) })),
              count: rateInconsistent.length,
            },
          });
        }
      }
    }
  }
  // ── Unbacked dispatch claim (2026-09-29, TB 2.1 v3c bench — unbacked-claim.ts) ──
  // A HUMAN turn on a supervisor chat that CLAIMS a dispatch and cites a
  // receipt id while the run made NO tool call invented that id — nothing was
  // sent. Re-run ONCE with a harness note naming it (no tool call ⇒ no side
  // effect to repeat). An id matching a real receipt of this chat (an honest
  // reference to an earlier send) never triggers it.
  // Audit 2026-10-06 T6-3 (others.md F2, fleet.md F4): the same ONE re-run
  // when a zero-tool answer claims FRESH verification ("fresh reads", "verified
  // … just now", "re-read", "recount", "checked live") — the dispatch check
  // wins when both fire (one retry per turn). Kill switch
  // SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED=1.
  // Audit 2026-10-16 (todo 6f8b52b7, gap i — specimen af8ed7b6): the SAME
  // detection now also runs on MACHINE wakes of supervisor chats, FLAG-FIRST
  // (observe-only): a hit records the supervisor_unbacked_claim_machine metric
  // (id + phrase) but does NOT retry and does NOT rewrite — the machine wake
  // may legitimately carry report-only prose. Flips to enforcement after the
  // measured false-positive rate. Kill switch SUPERVISOR_UNBACKED_MACHINE_WAKE_DISABLED=1.
  // BRIEFING-UNVERIFIED-FILTER (2026-10-20): the send-class claims of a ZERO-TOOL supervisor machine wake,
  // captured below as quotes of the text they were found in — convicted by construction (no tool call ⇒
  // nothing can have been sent). The finalize's footnote / owner-briefing lane keeps only the ones still
  // in the delivered note (a reject-back swap or a follow-through rewrite drops the rest).
  let zeroToolSendQuotes: Array<{ quote: string }> = [];
  if (isSupervisorChat && runIsMachineTriggered && chatId && !args.isCancelled?.() && !unbackedMachineWakeDisabled()) {
    const machineText = result.finalText || adapter.answerText || '';
    const machineClaims = await residualUnbackedClaims(chatId, machineText, result.parts as any[]).catch(() => []);
    const machineCited = unbackedDispatchClaimIds(machineText, result.parts as any[]);
    const machineToolNoun = toolNounCitedIds(machineText, result.parts as any[]);
    // Todo 77c88942 item 3: tool-noun citations ("start_coding_session → 9e39ec5c") join the
    // invented-id lane (specimen 8fae35a4) — the machine leg stays observe-only.
    const machineInvented = [...(machineCited ? await inventedReceiptIds(chatId, machineCited).catch(() => []) : []),
      ...(machineToolNoun ? await inventedToolNounIds(chatId, machineToolNoun).catch(() => []) : [])];
    if ((!actionClassAnnotateDisabled() || !briefingUnverifiedFilterDisabled()) && runMadeNoToolCall(result.parts as any[])) {
      zeroToolSendQuotes = zeroToolDispatchQuotes(machineText, machineClaims as any[]);
    }
    // Todo efb2960d (specimens bc618690 + fc20e6df): a FOLLOW-THROUGH round
    // (args.continuation — the machine-origin answer the human was promised)
    // is ENFORCED, not just flagged: every receipt id its note cites as its
    // own action is grounded against the chat's real receipts and ids
    // envelopes, and every cited chat link against the chat rows — an
    // invented id or dead link rewrites the citing sentence to the honest
    // line BEFORE delivery (read-only rounds made every zero-tool lane above
    // stand down, so the ids sailed out untouched). The dead-chat-link and
    // honest-reference verdicts ride the SAME grounding call. Fail-closed on a
    // read error (ids treated as real). Kill switch
    // SUPERVISOR_FOLLOW_THROUGH_ID_GROUNDING_DISABLED=1.
    let followThroughEnforced = false;
    if (args.continuation && !followThroughIdGroundingDisabled()) {
      const ftText = result.finalText || adapter.answerText || '';
      const grounding = await groundFollowThroughCitations(chatId, ftText).catch(() => ({ invented: [] as string[], deadChatLinks: [] as string[] }));
      if (grounding.invented.length) {
        // The dispatch spans carry the whole citing sentence — the same honest
        // rewrite the human lane's residual check ships.
        const spans = inventedReceiptSpans(ftText, grounding.invented);
        if (spans.length) {
          result = { ...result, finalText: rewriteUnbackedClaims(ftText, spans) };
          // The transcript renders PARTS over content — keep them in step (the reconcile seam's pattern).
          if (result.parts?.length) result.parts = [...(result.parts || []).filter((p: any) => p.type !== 'text'), { type: 'text', text: result.finalText }];
          leakRetrySwapped = true; // the streamed fabricated ids are replaced for live viewers too
          followThroughEnforced = true;
          logger.warn(`chat-agent: follow-through round for ${chatId.slice(0, 8)} cited ${grounding.invented.length} invented receipt id(s) (${grounding.invented.join(', ')}) — sentences rewritten honestly before delivery`, { source: 'chat-agent' });
        }
      }
      // A dead chat link renders as if real even when every receipt id is
      // honest — flag it on the same metric (meta.deadChatLinks) so the
      // bc618690 shape is visible, but never rewrite prose we cannot verify.
      if (grounding.invented.length || grounding.deadChatLinks.length) {
        recordLoopMetric({
          kind: 'supervisor_unbacked_claim_machine',
          sessionId: runSessionId,
          stamp: chatMetricStamp,
          meta: {
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel,
            invented: grounding.invented.slice(0, 6),
            ...(grounding.deadChatLinks.length ? { deadChatLinks: grounding.deadChatLinks.slice(0, 4) } : {}),
            enforced: true, // todo efb2960d: the continuation round is rewritten, not just flagged
            count: grounding.invented.length + grounding.deadChatLinks.length,
          },
        });
      }
    }
    // Todo d597ce5d (#1578 escape, monitor lesson 6) + ticket f05b38c1: the
    // TRIPLE check — a cited id may resolve to a receipt of the WRONG TOOL
    // for the claim's verb ("Resolved duplicate ticket 9c307167 via filer
    // self-close — receipt ticket 9c307167" while the id only lives in a
    // file_feedback envelope). ENFORCED for ACT-GRADE citations (ticket
    // f05b38c1): a mismatch whose citation an own-act verb governs is
    // rewritten to the honest line BEFORE delivery (rewriteUnbackedClaims on
    // the mismatch's sentence span — the same machinery the residual check
    // ships). REPORT-grade citations (another lane's work, entity
    // restatements, "(msg id)" evidence pointers) stay observe-only — one
    // metric row each, never a rewrite (a false strike on an honest note is
    // strictly worse than a miss, 587e9d64). Kill switches:
    // RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED=1 (everything),
    // RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED=1 (enforcement only).
    if (!receiptTripleGroundingDisabled()) {
      const tripleText = result.finalText || adapter.answerText || '';
      const tripleMismatches = await receiptToolMismatches(chatId, tripleText).catch(() => []);
      if (tripleMismatches.length) {
        const actMismatches = tripleMismatches.filter((mm) => mm.grade === 'act' && mm.span);
        const observeMismatches = tripleMismatches.filter((mm) => mm.grade !== 'act' || !mm.span);
        // (ticket f05b38c1) ENFORCEMENT — act-grade only, pre-delivery.
        if (actMismatches.length && !receiptTripleEnforceDisabled()) {
          const spans = actMismatches
            .map((mm) => ({ cls: mm.claimClass ?? 'change', phrase: mm.phrase.slice(0, 120), start: mm.span![0], end: mm.span![1], source: 'dispatch' as const }))
            .filter((s) => s.end > s.start);
          if (spans.length) {
            const rewritten = rewriteUnbackedClaims(tripleText, spans, { noBlockCollapse: true });
            if (rewritten !== tripleText) {
              result = { ...result, finalText: rewritten };
              // The transcript renders PARTS over content — keep them in step (the reconcile seam's pattern).
              if (result.parts?.length) result.parts = [...(result.parts || []).filter((p: any) => p.type !== 'text'), { type: 'text', text: rewritten }];
              leakRetrySwapped = true; // the streamed mismatched claim is replaced for live viewers too
              logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake cited ${spans.length} receipt id(s) of the WRONG TOOL for its act-verb claim — sentence(s) rewritten honestly before delivery (ticket f05b38c1)`, { source: 'chat-agent' });
            }
          }
        }
        const observe = observeMismatches.length
          ? `${observeMismatches.length} observe-only (report-grade) + `
          : '';
        // (ticket 62718124) act-grade mismatches stay WARN (the wrong-tool-CLAIM
        // signal); a report-only wake is the f05b38c1-adjudicated benign class
        // — INFO (the log-signal sweep reads warn+error only, so the benign
        // class stops tripping its RULE 1; the metric rows keep the baseline).
        logger[tripleAggregateLogLevel(actMismatches.length)](`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake cited ${observe}${tripleMismatches.length} receipt id(s) whose tool mismatches the claim's verb — spec d597ce5d / ticket f05b38c1`, { source: 'chat-agent' });
        for (const mm of tripleMismatches) {
          recordLoopMetric({
            kind: 'receipt_tool_mismatch',
            sessionId: runSessionId,
            stamp: chatMetricStamp,
            meta: {
              verb: mm.verb, ...(mm.noun ? { noun: mm.noun } : {}),
              expectedTools: [...mm.expectedTools], actualTool: mm.actualTool, receiptId: mm.receiptId,
              leg: 'machine', phrase: mm.phrase, grade: mm.grade,
              ...(actMismatches.includes(mm) && !receiptTripleEnforceDisabled() ? { enforced: true } : {}),
            },
          });
        }
      }
    }
    // Todo 13dfa16d (monitor lesson 7): the artifact-attribution cross-check —
    // a '<todo> merged/landed/shipped' sentence must agree with that todo's
    // row AND the event-time stamp on the PR receipt for the same sentence
    // (the #1590 specimen class). OBSERVE-ONLY FIRST — one metric row per
    // mismatch, never a rewrite, never a retry (the 6f8b52b7 / PR #1548
    // ladder: enforcement is gated on a 7-day baseline). Kill switch
    // ARTIFACT_ATTRIBUTION_DISABLED=1.
    {
      const attribText = result.finalText || adapter.answerText || '';
      const attribMismatches = await artifactAttributionMismatches(chatId, attribText).catch(() => []);
      if (attribMismatches.length) {
        logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake carried ${attribMismatches.length} artifact-attribution mismatch(es) (observe-only) — spec 13dfa16d`, { source: 'chat-agent' });
        for (const mm of attribMismatches) {
          recordLoopMetric({
            kind: 'artifact_attribution_mismatch',
            sessionId: runSessionId,
            stamp: chatMetricStamp,
            meta: {
              prefix: mm.prefix, claimedWorkItem: mm.claimedWorkItem, todoStatus: mm.todoStatus,
              ...(mm.todoEvidence ? { todoEvidence: mm.todoEvidence } : {}),
              ...(mm.stampedWorkItem ? { stampedWorkItem: mm.stampedWorkItem } : {}),
              verb: mm.verb, leg: 'machine', phrase: mm.phrase,
            },
          });
        }
      }
    }
    if (!followThroughEnforced && (machineClaims.length || machineInvented.length)) {
      logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake carried ${machineClaims.length + machineInvented.length} unbacked claim(s) (flag-only, observe-only) — spec 6f8b52b7 gap (i)`, { source: 'chat-agent' });
      recordLoopMetric({
        kind: 'supervisor_unbacked_claim_machine',
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: {
          seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel,
          claims: machineClaims.slice(0, 4).map((c: any) => ({ cls: c.cls, phrase: c.phrase.slice(0, 100) })),
          invented: machineInvented.slice(0, 6),
          count: machineClaims.length + machineInvented.length,
        },
      });
      // Todo 77c88942 item 3: a credential-store narration ("Seven keys banked")
      // carries its own observe-only metric — the 7-day baseline before the
      // credential lane is ever allowed to convict on its own.
      const credentialClaims = machineClaims.filter((c: any) => c.source === 'credential');
      if (credentialClaims.length) {
        recordLoopMetric({
          kind: 'credential_claim_unbacked',
          sessionId: runSessionId,
          stamp: chatMetricStamp,
          meta: {
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel,
            phrases: credentialClaims.slice(0, 4).map((c: any) => c.phrase.slice(0, 100)),
            count: credentialClaims.length, leg: 'machine',
          },
        });
      }
    }
  }
  // Audit 2026-10-08 W1-2 (c): the deliverable of an owner-turn re-run is RE-CHECKED — a retry that still made no
  // matching tool call (CanLaw 74471a68's retry re-fabricated and shipped) or no retry at all never ships the
  // claim: each unbacked claim's sentence is rewritten to the honest line ("I have not sent that message yet —
  // nothing went out in this answer."). Deterministic, no model call. Kill switch
  // SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED=1 delivers the retry as-is (the pre-fix behaviour).
  // 2026-10-21 (FSN1021): when that rewrite replaced a send / change claim and the delivered text still speaks of
  // something sent / underway / running in the background, ONE harness line states what the tool log proves
  // (unbacked-claim.ts noActionToolNote) — judged on EVERY attempt of the turn (turnToolCallParts) plus the chat's
  // receipts since the owner's message; never a rewrite. The answer-first follow-through (ownerAfAct) owns its own
  // closing line. Kill switch SUPERVISOR_NO_ACTION_NOTE_DISABLED=1.
  // 2026-10-22 review: one helper for every owner-turn re-run that swaps in a new deliverable — the unbacked-claim
  // re-run below AND the live-state re-run after it, so no delivered owner answer escapes the claim check.
  const rewriteResidualOwnerClaims = async (cid: string, fallbackText: string): Promise<{ rewritten: number; residualClasses: string[]; noActionNote: boolean }> => {
    let rewritten = 0;
    let residualClasses: string[] = [];
    if (!unbackedClaimRewriteDisabled()) {
      const deliverable = result.finalText || fallbackText;
      const residual = await residualUnbackedClaims(cid, deliverable, result.parts as any[], { turnParts: turnWriteCallParts }).catch(() => []);
      if (residual.length) {
        result = { ...result, finalText: rewriteUnbackedClaims(deliverable, residual) };
        // The transcript renders PARTS over content — keep them in step (the reconcile seam's pattern).
        if (result.parts?.length) result.parts = [...(result.parts || []).filter((p: any) => p.type !== 'text'), { type: 'text', text: result.finalText }];
        leakRetrySwapped = true; // the streamed claim is replaced for live viewers too
        rewritten = residual.length;
        residualClasses = [...new Set(residual.map((c) => c.cls))];
        logger.warn(`chat-agent: supervisor ${cid.slice(0, 8)} answer still carried ${residual.length} unbacked claim(s) (${residualClasses.join('/')}) after the check — rewritten honestly before delivery`, { source: 'chat-agent' });
      }
    }
    let noActionNote = false;
    if (rewritten > 0 && residualClasses.some((c) => c !== 'read') && !ownerAfAct && !noActionToolNoteDisabled()) {
      const noted = noActionToolNote(result.finalText || fallbackText, turnToolCallParts);
      // The owner's message anchors the receipt read; an unanchored turn reads from the orchestration start (every attempt is after it).
      const noteSince = userTurnAt ?? new Date(orchestratorT0);
      if (noted && !(await actedSinceTurn(cid, noteSince))) {
        noActionNoteSince = noteSince;
        result = { ...result, finalText: noted };
        // The residual rewrite above already collapsed the text to one part; rebuild it from the noted text so content and
        // parts place the line in the SAME spot (round 9: a chip block followed by prose had put it in two places).
        if (result.parts?.length) result.parts = [...(result.parts || []).filter((p: any) => p?.type !== 'text'), { type: 'text', text: noted }];
        leakRetrySwapped = true;
        noActionNote = true;
        noActionNoteApplied = true;
      }
    }
    return { rewritten, residualClasses, noActionNote };
  };
  // One claim re-run per owner turn: the live-state check below never stacks a second round on this one.
  let ownerClaimRetryRan = false;
  if (isSupervisorChat && !runIsMachineTriggered && chatId && !args.isCancelled?.()) {
    const claimText = result.finalText || adapter.answerText || '';
    const cited = unbackedDispatchClaimIds(claimText, result.parts as any[]);
    const invented = cited ? await inventedReceiptIds(chatId, cited) : [];
    // Todo efb2960d (specimen fc20e6df): the human lane grounds EVERY id the
    // answer cites as its own action — no tool-call precondition, no dispatch
    // verb required ("Ledger verified — receipt b471f5dc" has neither). An id
    // that resolves to no receipt of this chat joins the existing invented[]
    // below, so the SAME retry / rewrite machinery fires for it.
    if (!invented.length && !followThroughIdGroundingDisabled()) {
      const ownCited = citedOwnReceiptIds(claimText);
      if (ownCited?.length) invented.push(...await inventedToolNounIds(chatId, ownCited).catch(() => []));
    }
    // Todo d597ce5d (#1578 escape) + ticket f05b38c1: the TRIPLE check on the
    // human lane — ACT-GRADE mismatches are ENFORCED (rewritten to the honest
    // line before delivery, same as the machine leg); REPORT-grade citations
    // stay observe-only metric rows (never a retry, never a rewrite). Runs
    // even when invented.length > 0 (a note can cite one invented id AND one
    // wrong-tool id; both classes must be visible).
    if (!receiptTripleGroundingDisabled()) {
      const tripleMismatches = await receiptToolMismatches(chatId, claimText).catch(() => []);
      if (tripleMismatches.length) {
        const actMismatches = tripleMismatches.filter((mm) => mm.grade === 'act' && mm.span);
        const observeMismatches = tripleMismatches.filter((mm) => mm.grade !== 'act' || !mm.span);
        if (actMismatches.length && !receiptTripleEnforceDisabled()) {
          const spans = actMismatches
            .map((mm) => ({ cls: mm.claimClass ?? 'change', phrase: mm.phrase.slice(0, 120), start: mm.span![0], end: mm.span![1], source: 'dispatch' as const }))
            .filter((s) => s.end > s.start);
          if (spans.length) {
            const rewritten = rewriteUnbackedClaims(claimText, spans, { noBlockCollapse: true });
            if (rewritten !== claimText) {
              result = { ...result, finalText: rewritten };
              if (result.parts?.length) result.parts = [...(result.parts || []).filter((p: any) => p.type !== 'text'), { type: 'text', text: rewritten }];
              leakRetrySwapped = true;
              logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} cited ${spans.length} receipt id(s) of the WRONG TOOL for its act-verb claim — sentence(s) rewritten honestly before delivery (ticket f05b38c1)`, { source: 'chat-agent' });
            }
          }
        }
        const observe = observeMismatches.length ? `${observeMismatches.length} observe-only (report-grade) + ` : '';
        // (ticket 62718124) same demotion as the machine leg: act-grade stays
        // WARN (the wrong-tool-CLAIM signal), report-only → INFO (the
        // f05b38c1-adjudicated benign class; sweep reads warn+error only).
        logger[tripleAggregateLogLevel(actMismatches.length)](`chat-agent: supervisor ${chatId.slice(0, 8)} cited ${observe}${tripleMismatches.length} receipt id(s) whose tool mismatches the claim's verb — spec d597ce5d / ticket f05b38c1`, { source: 'chat-agent' });
        for (const mm of tripleMismatches) {
          recordLoopMetric({
            kind: 'receipt_tool_mismatch',
            sessionId: runSessionId,
            stamp: chatMetricStamp,
            meta: {
              verb: mm.verb, ...(mm.noun ? { noun: mm.noun } : {}),
              expectedTools: [...mm.expectedTools], actualTool: mm.actualTool, receiptId: mm.receiptId,
              leg: 'human', phrase: mm.phrase, grade: mm.grade,
              ...(actMismatches.includes(mm) && !receiptTripleEnforceDisabled() ? { enforced: true } : {}),
            },
          });
        }
      }
    }
    // Todo 13dfa16d (monitor lesson 7) — the artifact-attribution cross-check
    // on the human turn too (same observe-only ladder as the machine leg
    // above): '<todo> merged/landed/shipped' vs the todo row + the receipt's
    // event-time stamp. Never a retry, never a rewrite.
    {
      const attribMismatches = await artifactAttributionMismatches(chatId, claimText).catch(() => []);
      if (attribMismatches.length) {
        logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} human turn carried ${attribMismatches.length} artifact-attribution mismatch(es) (observe-only) — spec 13dfa16d`, { source: 'chat-agent' });
        for (const mm of attribMismatches) {
          recordLoopMetric({
            kind: 'artifact_attribution_mismatch',
            sessionId: runSessionId,
            stamp: chatMetricStamp,
            meta: {
              prefix: mm.prefix, claimedWorkItem: mm.claimedWorkItem, todoStatus: mm.todoStatus,
              ...(mm.todoEvidence ? { todoEvidence: mm.todoEvidence } : {}),
              ...(mm.stampedWorkItem ? { stampedWorkItem: mm.stampedWorkItem } : {}),
              verb: mm.verb, leg: 'human', phrase: mm.phrase,
            },
          });
        }
      }
    }
    // Todo 77c88942 item 3 (specimen 8fae35a4): a tool noun cited with an id —
    // "start_coding_session → 9e39ec5c" — is a dispatch claim even without a
    // send verb or the word "receipt"; an invented id after it is a fabricated
    // dispatch and trips the SAME retry lane.
    if (!invented.length) {
      const toolNounIds = toolNounCitedIds(claimText, result.parts as any[]);
      if (toolNounIds?.length) {
        const toolNounInvented = await inventedToolNounIds(chatId, toolNounIds);
        if (toolNounInvented.length) invented.push(...toolNounInvented);
      }
    }
    // Audit 2026-10-08 W1-2 (supervisors F1, chats F1): a first-person send / read / change claim
    // ("I've messaged chat d1d0b346", "Steering the lane now", "I read back both settings") that no
    // tool call of the matching class backs — no receipt citation required (unbacked-claim.ts).
    // Kill switch SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED=1.
    let actionClaims = !invented.length && !unbackedActionRetryDisabled()
      ? await filterHonestReferences(chatId, claimText, unbackedActionClaims(claimText, result.parts as any[])).catch(() => [])
      : [];
    // Todo 77c88942 item 3 (specimen 8fae35a4): subject-less credential-store
    // prose ("Seven keys banked", zero-tool) joins the human leg's INITIAL
    // detection — it rode only the re-check before, so the retry never fired.
    if (!invented.length && !unbackedActionRetryDisabled()) {
      const credentialClaims = unbackedCredentialClaims(claimText, result.parts as any[]);
      if (credentialClaims.length) actionClaims = [...actionClaims, ...credentialClaims];
    }
    const freshness = !invented.length && !actionClaims.length && !unbackedFreshnessRetryDisabled() ? unbackedFreshnessClaim(claimText, result.parts as any[]) : null;
    if (invented.length || actionClaims.length || freshness) {
      const claim: 'dispatch' | 'action' | 'freshness' = invented.length ? 'dispatch' : actionClaims.length ? 'action' : 'freshness';
      if (claim === 'dispatch') logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} claimed a dispatch citing receipt(s) ${invented.join(', ')} with NO tool call this turn — re-running once with a harness check`, { source: 'chat-agent' });
      else if (claim === 'action') logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} claimed ${actionClaims.map((c) => c.cls).join('/')} action(s) ("${actionClaims[0].phrase.slice(0, 80)}") with no matching tool call this turn — re-running once with a harness check`, { source: 'chat-agent' });
      else logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} claimed fresh verification ("${freshness}") with NO tool call this turn — re-running once with a harness check`, { source: 'chat-agent' });
      // Dispatch / freshness claims fire only on zero-tool runs (always replay-safe); an action claim on
      // a run that called tools is re-run only when none of them mutated — otherwise straight to the
      // honest rewrite below (a replay would repeat the side effect).
      const replayUnsafe = firedReplayUnsafeTool(turnParts(result.parts), { allow: ['update_supervisor_state'] });
      let retry: Awaited<ReturnType<typeof runOrchestrator>> | null = null;
      if (!replayUnsafe) {
        send('progress', { message: claim === 'freshness' ? STATUS.recover.recheck : STATUS.recover.phantomSend, stage: 'synthesis' });
        adapter.resetForRetry();
        ownerClaimRetryRan = true;
        retry = await runOrchestrator(claim === 'dispatch' ? unbackedClaimNotice(invented) : claim === 'action' ? unbackedActionNotice(actionClaims) : unbackedFreshnessNotice(freshness!)).catch((err: any) => {
          logger.warn(`chat-agent: unbacked-claim retry failed: ${err?.message}`, { source: 'chat-agent' });
          return null;
        });
      }
      const retryText = (retry?.finalText || '').trim();
      const retrySent = (retry?.parts || []).some((p: any) => p?.type === 'tool_call' && p?.name === 'send_chat_message');
      if (retry && retryText && retryText !== EMPTY_ASSISTANT_PLACEHOLDER) {
        retrySupersededParts = [...retrySupersededParts, ...((result.parts ?? []) as unknown[])];
        result = retry;
        const reStrip = reStripForgedChromeOnRetry(result); // review fix 3 — the retry's text gets the strip attempt 1 got
        result = reStrip.r; if (reStrip.swapped) forgedChromeSwapped = true;
        leakRetrySwapped = true; // attempt 1's claim already streamed — live viewers swap to the retry's text
      } else if (!(result.finalText || '').trim()) {
        result = { ...result, finalText: claimText };
      }
      // Audit 2026-10-08 W1-2 (c) + FSN1021: the deliverable is RE-CHECKED and honestly rewritten, then noted (rewriteResidualOwnerClaims).
      const { rewritten, residualClasses, noActionNote } = await rewriteResidualOwnerClaims(chatId, claimText);
      recordLoopMetric({
        kind: 'supervisor_unbacked_claim_retry',
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: {
          seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel, invented, recovered: !!retryText && !rewritten, retrySent,
          // Audit 2026-10-06 T6-3: which claim class fired + (freshness) the claimed phrase and whether the retry really read.
          claim, ...(freshness ? { phrase: freshness.slice(0, 160) } : {}),
          retryToolCalls: (retry?.parts || []).filter((p: any) => p?.type === 'tool_call').length,
          // Audit 2026-10-08 W1-2: the action claims, a skipped replay, and the honest rewrite.
          ...(actionClaims.length ? { classes: [...new Set(actionClaims.map((c) => c.cls))], phrases: actionClaims.slice(0, 4).map((c) => c.phrase.slice(0, 100)) } : {}),
          ...(replayUnsafe ? { replaySkipped: replayUnsafe } : {}),
          retried: !replayUnsafe, rewritten, ...(residualClasses.length ? { residualClasses } : {}),
          ...(noActionNote ? { noActionNote: true } : {}),
        },
      });
      // Todo 77c88942 item 3: the credential lane's own observe-only counter —
      // a credential-store narration tripped the guard (retry/rewrite ran);
      // the 7-day baseline gates any future conviction-only tightening.
      if (claim === 'action' && actionClaims.some((c: any) => (c as any).source === 'credential')) {
        const credentialPhrases = actionClaims.filter((c: any) => (c as any).source === 'credential').map((c: any) => c.phrase.slice(0, 100));
        recordLoopMetric({
          kind: 'credential_claim_unbacked',
          sessionId: runSessionId,
          stamp: chatMetricStamp,
          meta: {
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel,
            phrases: credentialPhrases.slice(0, 4), count: credentialPhrases.length, leg: 'human',
            ...(invented.length ? { invented: invented.slice(0, 6) } : {}),
          },
        });
      }
    }
  }
  // ── Owner-turn live-state read (2026-10-22 — owner's Fleet Supervisor chat, 21:13Z + 21:46Z; unread-state-note.ts) ──
  // Two OWNER turns asked "is X deployed / running on cluster Y", "was the memory issue fixed" and the Fleet
  // Supervisor answered with ZERO tool calls — from memory, stale or wrong; the owner pushed back twice. The
  // doctrine already says a serving / deployed / running / banked sentence cites a THIS-TURN read or says it was
  // not read; the harness only OBSERVED that on machine wakes (findUnreadProductionStateClaims, seam
  // machine_wake_production_state — untouched). A HUMAN turn on a supervisor chat whose answer asserts live
  // production / run state per that matcher, while NO attempt of the turn made a read that could ground it (the
  // matcher's own haystack discipline — productionStateHasGroundingRead: memory reads, the own state doc and a read
  // of this chat never count), is re-run ONCE with a harness check: read the live state, or say plainly it was not
  // read this turn. Same seam, replay rule and progress line as the unbacked-claim retry above, and never a second
  // round on a turn that retry already re-ran or the answer-first follow-through split. A deliverable that STILL
  // asserts unread state gets ONE appended harness line (UNREAD_STATE_NOTE — before a [FOLLOWUPS] block, never inside
  // a code fence; stripped from model history by guard-chrome-redact). Machine wakes, plain chats and kids (never a
  // supervisor chat) are never judged; any failure keeps the answer as written. loop_metrics
  // supervisor_unread_state_retry {retried, stillUnread, …}. Kill switch SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED=1.
  // Scope (review 2026-10-22): the matcher's PRESENT-state shapes — deployed / serving / running on / live / in
  // production / on main head. A past-tense "the memory issue was fixed in PR 1888" is its history register and is
  // NOT judged (a "fixed / landed in <id>" predicate would need its own observe-only baseline first). A re-run's
  // answer gets the leak guard and the claim rewrite before it can be delivered (rewriteResidualOwnerClaims).
  if (unreadStateNoteScope && chatId && !args.isCancelled?.()) {
    try {
      const { findUnreadProductionStateClaims, productionStateHasGroundingRead } = await import('../platform/action-verifier');
      const stateText = result.finalText || adapter.answerText || '';
      // Judged against EVERY attempt's reads (a read can only remove a hit) and the delivered run's receipts, on the
      // answer's PROSE only (review 2026-10-22: a follow-up chip, an offer or a restated question is never a claim —
      // unreadStateClaimProse strips the chips, ownerTurn drops the questions / governed clauses left in the prose).
      const unreadHits = (text: string, r: typeof result) => findUnreadProductionStateClaims(unreadStateClaimProse(text), {
        parts: turnToolParts, receipts: (r.receipts ?? []) as any[], selfChatId: chatId, ownerTurn: true,
      });
      const hits = unreadHits(stateText, result);
      if (hits.length && !productionStateHasGroundingRead({ parts: turnToolParts, selfChatId: chatId })) {
        const replayUnsafe = firedReplayUnsafeTool(turnParts(result.parts), { allow: ['update_supervisor_state'] });
        const skipped: 'claim_retry_ran' | 'answer_first_split' | 'replay_unsafe' | null = ownerClaimRetryRan ? 'claim_retry_ran'
          : (ownerAfAct && ownerAfObserver?.split()) ? 'answer_first_split'
          : replayUnsafe ? 'replay_unsafe' : null;
        logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} owner answer states live state with NO read this turn ("${hits[0].sentence.slice(0, 80)}") — ${skipped ? `not re-run (${skipped})` : 're-running once with a harness check'}`, { source: 'chat-agent' });
        let retry: Awaited<ReturnType<typeof runOrchestrator>> | null = null;
        if (!skipped) {
          send('progress', { message: STATUS.recover.recheck, stage: 'synthesis' });
          adapter.resetForRetry();
          retry = await runOrchestrator(unreadStateNotice(hits.map((h) => h.sentence))).catch((err: any) => {
            logger.warn(`chat-agent: live-state read retry failed: ${err?.message}`, { source: 'chat-agent' });
            return null;
          });
        }
        const retryText = (retry?.finalText || '').trim();
        // Review 2026-10-22 (finding 1): the re-run's answer is held to the checks every delivered owner answer gets —
        // the leak / narration retry and the claim check above judged attempt 1 only. A re-run that leaks or narrates a
        // tool call it never made ("*(Calling get_chat_status on the spark lane…)*" — the four reads the notice names
        // invite exactly that) is never swapped in: attempt 1 ships, with the line.
        const retryLeaked = !!retryText && (looksLikeLeakedChatToolCall(retryText) || looksLikeToolCallNarration(retryText));
        let swapped = false;
        if (retry && retryText && retryText !== EMPTY_ASSISTANT_PLACEHOLDER && !retryLeaked) {
          retrySupersededParts = [...retrySupersededParts, ...((result.parts ?? []) as unknown[])];
          result = retry;
          const reStrip = reStripForgedChromeOnRetry(result); // review fix 3 — the retry's text gets the strip attempt 1 got
          result = reStrip.r; if (reStrip.swapped) forgedChromeSwapped = true;
          swapped = true;
          leakRetrySwapped = true; // attempt 1's answer already streamed — live viewers swap to the retry's text
        } else {
          if (retryLeaked) leakRetrySwapped = true; // the rejected re-run streamed — live viewers swap back to attempt 1
          if (!(result.finalText || '').trim()) result = { ...result, finalText: stateText };
        }
        // …and a swapped-in re-run gets the claim check's deterministic rewrite + no-action note (an unbacked send /
        // freshness / dispatch claim the re-run made never ships) — the same helper the claim re-run above uses, no model call.
        const claimCheck = swapped
          ? await rewriteResidualOwnerClaims(chatId, retryText)
          : { rewritten: 0, residualClasses: [] as string[], noActionNote: false };
        const deliverable = result.finalText || stateText;
        const still = unreadHits(deliverable, result);
        let noted = false;
        if (still.length) {
          const withLine = unreadStateNoteText(deliverable);
          if (withLine) {
            result = { ...result, finalText: withLine, ...(result.parts?.length ? { parts: withUnreadStateNoteParts(result.parts as any[], deliverable, withLine) } : {}) };
            leakRetrySwapped = true; // live viewers swap to the noted text
            noted = true;
            unreadStateNoteApplied = true;
          }
        }
        recordLoopMetric({
          kind: 'supervisor_unread_state_retry',
          sessionId: runSessionId,
          stamp: chatMetricStamp,
          meta: {
            seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', model: orchestratorModel,
            retried: !skipped, stillUnread: still.length > 0, noted,
            hits: hits.length, reasons: [...new Set(hits.map((h) => h.reason))], sentences: hits.slice(0, 3).map((h) => h.sentence.slice(0, 120)),
            retryToolCalls: (retry?.parts || []).filter((p: any) => p?.type === 'tool_call').length,
            ...(skipped ? { skipped } : {}), ...(replayUnsafe ? { replaySkipped: replayUnsafe } : {}),
            ...(retryLeaked ? { retryRejected: 'tool_call_leak' } : {}),
            ...(claimCheck.rewritten ? { rewritten: claimCheck.rewritten, residualClasses: claimCheck.residualClasses } : {}),
            ...(claimCheck.noActionNote ? { noActionNote: true } : {}),
          },
        });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: owner-turn live-state check failed (non-fatal — answer kept as written): ${err?.message}`, { source: 'chat-agent' });
    }
  }
  // Audit 2026-10-08 W1-6 (supervisors F9): an owner answer on a supervisor chat whose header clock
  // was copied from an older lane message ("**10:31 AM PDT (17:31Z) — capturing right now**" at
  // 18:09Z) is restamped from the server clock (answer-clock.ts). Kill switch
  // OWNER_ANSWER_CLOCK_STAMP_DISABLED=1.
  if (isSupervisorChat && !runIsMachineTriggered && chatId && !args.isCancelled?.() && !answerClockStampDisabled()) {
    const headerText = result.finalText || '';
    const stamp = stampAnswerClockHeader(headerText, new Date());
    if (stamp.stamped) {
      const { from, to } = stamp.stamped;
      result = {
        ...result,
        finalText: stamp.text,
        // the first text part carries the same header — restamp it in place (parts render over content)
        ...(result.parts?.length ? { parts: (() => { let done = false; return (result.parts || []).map((p: any) => (!done && p?.type === 'text' && typeof p.text === 'string' && p.text.includes(from) ? (done = true, { ...p, text: p.text.replace(from, to) }) : p)); })() } : {}),
      };
      leakRetrySwapped = true; // live viewers swap to the restamped header
      recordLoopMetric({ kind: 'owner_answer_clock_stamped', sessionId: runSessionId, stamp: chatMetricStamp, value: stamp.stamped.driftMin, meta: stamp.stamped });
    }
  }
  // ── Unsaved standing chat rule (ticket ccd634fb — nightly query suite 2026-10-06) ──
  // "for the rest of this chat, always answer in exactly one sentence" was answered "Noted — …"
  // with NO tool call: set_chat_instructions was offered and named in the playbook, but the rule
  // was never saved and is lost once the chat outgrows its history window. A HUMAN turn on a
  // signed-in, non-supervisor chat whose message sets a standing rule for this chat and whose run
  // saved nothing (no set_chat_instructions / remember_fact) and fired no mutating tool is re-run
  // ONCE with a harness check (standing-rule.ts) — the model still decides; a replay has no side
  // effect to repeat. Kill switch CHAT_RULE_UNSAVED_RETRY_DISABLED=1.
  if (!isSupervisorChat && !runIsMachineTriggered && chatId && userId && !args.escalation && !args.isCancelled?.() && !standingRuleRetryDisabled()) {
    const ruleText = result.finalText || adapter.answerText || '';
    const cue = unsavedStandingRule({ message: args.message, finalText: ruleText, parts: result.parts as any[], unsafeTool: firedReplayUnsafeTool(result.parts as any[]) });
    if (cue) {
      logger.info(`chat-agent: chat ${chatId.slice(0, 8)} — the user set a standing rule ("${cue}") but the turn saved nothing — re-running once with a harness check`, { source: 'chat-agent' });
      send('progress', { message: STATUS.recover.saveRule, stage: 'synthesis' });
      adapter.resetForRetry();
      const retry = await runOrchestrator(standingRuleNotice(cue)).catch((err: any) => {
        logger.warn(`chat-agent: standing-rule retry failed: ${err?.message}`, { source: 'chat-agent' });
        return null;
      });
      const retryText = (retry?.finalText || '').trim();
      const savedVia = (retry?.parts || []).filter((p: any) => p?.type === 'tool_call' && (p?.name === 'set_chat_instructions' || p?.name === 'remember_fact')).map((p: any) => String(p.name));
      if (retry && retryText && retryText !== EMPTY_ASSISTANT_PLACEHOLDER) {
        retrySupersededParts = [...retrySupersededParts, ...((result.parts ?? []) as unknown[])];
        result = retry;
        const reStrip = reStripForgedChromeOnRetry(result); // review fix 3 — the retry's text gets the strip attempt 1 got
        result = reStrip.r; if (reStrip.swapped) forgedChromeSwapped = true;
        leakRetrySwapped = true; // attempt 1's "noted" already streamed — live viewers swap to the retry's text
      } else if (!(result.finalText || '').trim()) {
        result = { ...result, finalText: ruleText };
      }
      recordLoopMetric({
        kind: 'chat_rule_unsaved_retry',
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: { cue: cue.slice(0, 60), recovered: !!retryText, saved: savedVia.length > 0, savedVia: [...new Set(savedVia)] },
      });
    }
  }
  adapter.finish();

  // Pre-parse emptiness drives the empty-run handling — a canvas- or
  // followups-only answer is NOT "no output": the tag strip below can
  // legitimately leave finalText='' on a real answer (PR #292 review).
  // The sanitizer's '[no content]' placeholder (coding-model EMPTY_ASSISTANT_PLACEHOLDER)
  // can surface as the whole final when the model's last turn was reasoning-only
  // (rollout watch 2026-09-14: tt-rd + fleet wakes persisted a literal "[no content]"
  // bubble) — it is emptiness, not an answer.
  const rawFinalTrim = (result.finalText || adapter.answerTextWithoutOpener || '').trim();
  const orchestratorEmpty = !rawFinalTrim || rawFinalTrim === EMPTY_ASSISTANT_PLACEHOLDER;

  // ── Finalize: canvases + followups + persistence + memory (legacy parity) ────
  // NOTE (review F1, ticket 4f7263e4): `raw` reads answerText (WITH the opener) —
  // the opener is user-visible answer text and must persist for refresh parity —
  // while `orchestratorEmpty` above reads the sans-opener view so an opener-only
  // turn still gets the empty-finalization warn + error card, never a silent
  // non-empty-looking bubble.
  let raw = result.finalText || adapter.answerText || '';
  // FSN1021 review: only the harness writes the no-action line, and only on a turn it judged — a model copy
  // (echoed from history) is removed from content and parts.
  // Round 4: supervisor human turns only (where the line can exist), every text part (a copy can sit in an
  // intermediate step), and only a standalone line — a quotation of it is the model's own words.
  const noActionNoteScope = isSupervisorChat && !runIsMachineTriggered && !noActionToolNoteDisabled();
  if (noActionNoteScope && !noActionNoteApplied) {
    const stripped = stripNoActionToolNote(raw);
    // An answer that is ONLY a copy of the line is left as delivered (stripping it would empty the reply past the empty-answer handling).
    const copyOnly = stripped !== raw && !stripped.trim();
    if (stripped !== raw && !copyOnly) { raw = stripped; leakRetrySwapped = true; } // live viewers swap to the stripped text
    // (a copy-only answer keeps content AND parts as delivered — stripping only the parts would reload as an empty bubble)
    if (!copyOnly && (result.parts as any[] | undefined)?.some((p: any) => p?.type === 'text' && typeof p.text === 'string' && p.text.includes(NO_ACTION_TOOL_NOTE))) {
      const before = JSON.stringify(result.parts);
      result.parts = (result.parts as any[]).map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? { ...p, text: stripNoActionToolNote(p.text) } : p));
      if (JSON.stringify(result.parts) !== before) leakRetrySwapped = true;
    }
  }
  // 2026-10-22: the same copy rule for the unread-state line (unread-state-note.ts) — only the harness writes it, and
  // only on an owner turn it judged; a copy-only answer is left as delivered, a quotation is the model's own words.
  if (unreadStateNoteScope && !unreadStateNoteApplied) {
    const stripped = stripUnreadStateNote(raw);
    const copyOnly = stripped !== raw && !stripped.trim();
    if (stripped !== raw && !copyOnly) { raw = stripped; leakRetrySwapped = true; }
    if (!copyOnly && (result.parts as any[] | undefined)?.some((p: any) => p?.type === 'text' && typeof p.text === 'string' && p.text.includes(UNREAD_STATE_NOTE))) {
      const before = JSON.stringify(result.parts);
      result.parts = (result.parts as any[]).map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? { ...p, text: stripUnreadStateNote(p.text) } : p));
      if (JSON.stringify(result.parts) !== before) leakRetrySwapped = true;
    }
  }
  /** A Double Checker draft / revision baseline never carries the harness's own lines — whether they are present is the harness's decision, never a checker change. */
  const harnessLinesOff = (text: string): string => {
    const s = noActionNoteScope ? stripNoActionToolNote(text) : text;
    return unreadStateNoteScope ? stripUnreadStateNote(s) : s;
  };
  /**
   * FSN1021 review round 4: a Double Checker revision (inline swap or late pass) keeps the line only when
   * the harness noted this turn, the revised text still carries a cue, no attempt ran a non-read tool, and
   * the chat minted no non-read receipt since the owner's message — the checker or the reconcile pass may
   * have acted after the note was written. Otherwise every copy is removed: the line can go missing, never
   * be false.
   */
  const rejudgeNoActionNote = async (text: string): Promise<string> => {
    if (!noActionNoteApplied) return stripNoActionToolNote(text);
    const judged = noActionToolNote(text, turnToolCallParts);
    if (!judged || !chatId) return stripNoActionToolNote(text);
    return (await actedSinceTurn(chatId, noActionNoteSince)) ? stripNoActionToolNote(text) : judged;
  };
  if (orchestratorEmpty && args.machineWake === true) {
    // A machine wake that produced no text closes with the doctrine's no-op
    // marker instead of an empty/placeholder bubble: the noop classifier counts
    // it, the action verifier sees no claims, and the owner reads a sentence.
    // EOD review 2026-09-14: ONLY when no consequential tool ran — a wake that
    // acted (send_chat_message, schedule_*, todo_update, …) and then ended
    // reasoning-only must never be summarized as "nothing was changed".
    const acted = (result.receipts ?? []).filter((r: any) => r?.ok && !READ_ONLY_TOOL_RE.test(String(r?.tool ?? ''))).length;
    // HARNESS-RECEIPTS (2026-10-20): on a supervisor wake the harness block appended at the finalize lists
    // what ran, so the empty note points at it instead of saying the actions went unsummarized.
    raw = acted > 0
      ? (harnessView && !harnessTextExempt
        ? 'WAKE: the model returned no closing text — the harness record below states what this wake did.'
        : `WAKE: the model returned no closing text, but ${acted} tool action(s) ran this wake (see the receipts) — actions NOT summarized; re-verify at source.`)
      : MACHINE_WAKE_EMPTY_NOTE;
  }
  // Set when the step-0 reconcile pass below replaced the answer — the client
  // rendered the UNRECONCILED text from live chunks, so the complete event must
  // carry the reconciled full text for the UI to swap in (adversarial review:
  // otherwise screen ≠ DB until reload — the H3 slim-cards design drops full
  // text from 'complete', so this is the ONE sanctioned exception: a single
  // answer, only on this path).
  let reconciledLive = false;
  // Pre-delivery action guard (ticket fcc4dbb4): set when the machine-wake
  // guard below REPLACED finalText — the 'complete' event must then carry the
  // replacement for live viewers (same swap-in as reconciledLive), and the
  // post-delivery verifier block must stand down (its consequences already
  // fired pre-delivery).
  let actionGuardStruck = false;
  // SINGLE-AUDIT (ticket fc337153): set when the machine-wake guard ran its
  // audit to a verdict (clean OR struck — ActionGuardResult.audited). The
  // post-delivery verifier stands down on an audited wake: a second
  // independent LLM extraction over the same note + evidence can only
  // diverge (the 2026-09-11 02:17Z delivered-phantom reopen), while a guard
  // that FAILED OPEN (audited:false) keeps the post lane as its backstop.
  let actionGuardAudited = false;
  // B1 (adversarial review, ticket ba65163d reject-back): set when a clean
  // reject-back retry replaces the answer — attempt 1's chunks already
  // streamed to subscribers, so the 'complete' event must carry finalText for
  // live viewers exactly like a struck path (declared beside actionGuardStruck
  // — the complete event sits outside the machine-wake block below).
  let rejectBackSwapped = false;
  // Ticket 51ed3a65: on an action-phantom strike the guard also returns the
  // in-thread correction TEXT — injected as a user-role harness message AFTER
  // the replacement assistant row persists (below), so the next wake sees the
  // SPECIFIC struck claims in-window. The persisted replacement wrapper is
  // swapped for a GENERIC placeholder when reloaded as model context
  // (guard-chrome-redact), so the replacement alone no longer teaches the next
  // wake which claims failed; user-role harness messages survive redaction by
  // role gate.
  let actionGuardCorrection = '';
  // (ticket b216475a) Machine-triggered in the WIDE sense — a schedule/hook
  // wake (args.machineWake) OR any non-user origin send (agent/webhook/…):
  // send_chat_message lane steers/reports anchor origin 'agent' with
  // machineWake UNSET, and those supervisor runs previously escaped BOTH the
  // pre-delivery guard and the post-delivery verifier (the 2026-09-13
  // fabricated-ticket-ids incident, chat c0e22e36). The same expression the
  // run-lock claim (startDetachedChatRun) and the zero-tool gate use.
  const machineTriggeredRun = args.machineWake === true || machineOriginRun(args);

  // `checkerGateTimedOut` (owner 2026-09-18): the injector gave up waiting at
  // the gate — the lead answered on its own research and the checker is still
  // running, so this is the same "ship now, reconcile late" situation as the
  // step-0 path below (a draft that landed while the lead wrote its answer
  // reconciles inline within the short late-wait).
  // Compute policy (design §4 D1b): the INLINE reconcile's revision_material
  // verdict — material ⇒ the reconciled text replaces the draft + 'updated'
  // (changed[]); wording-only ⇒ the draft stands + 'checked'. Fail-open:
  // any error ⇒ material (today's swap).
  // cp/labels (2026-09-26): the inline verdict is kept OFF the check_state
  // event and merged into the persisted metadata.check.verdict at finalize
  // (revisionVerdictMeta — the gate's compact stash rides it so a later thumbs
  // / tap can label revision_material exactly like the late path's rows).
  let inlineRevisionVerdict: RevisionMaterialVerdict | null = null;
  const inlineRevisionIsMaterial = async (reconciled: string): Promise<boolean> => {
    try {
      // deferShadowAsk (audit gate-runtime-4): a diff-decided verdict's SHADOW
      // ask rides v.pending instead of delaying the swap — finalize reads the
      // stash if it has landed and patches the row when it lands later.
      // FSN1021: whether the harness line is present is the harness's decision, never a checker change.
      const v = await decideRevisionMaterial(harnessLinesOff(raw), harnessLinesOff(reconciled), { chatId: chatId ?? undefined, deferShadowAsk: true });
      inlineRevisionVerdict = v;
      checkState = v.material ? { state: 'updated', changed: v.changed } : { state: 'checked' };
      if (!v.material) logger.info(`chat-agent L2: reconcile changed wording only (${v.source}) — the delivered draft stands, Checked ✓`);
      return v.material;
    } catch {
      checkState = { state: 'updated', changed: [] };
      return true;
    }
  };
  // ── Pure dispatch / coordination turn (audit 2026-10-06 T6-5, stanne P3) ──
  // The checker is a web + retrieval lane: on a turn whose only work was
  // coordination (send_chat_message / start_coding_session / todo / schedule /
  // state writes, after platform reads at most) its draft has nothing to
  // cross-check — prod e748a8ce waited 315 s for a reconcile that resolved
  // empty. Skip the reconcile (no late pass armed), stop the checker at its
  // next step, pill "skipped". Kill switch CROSSCHECK_DISPATCH_SKIP_DISABLED=1.
  const dispatchTurnTools = checkersPromise && (!draftsDelivered || checkerGateTimedOut) && !args.isCancelled?.()
    ? dispatchOnlyTurnTools(result.parts as any[])
    : null;
  if (dispatchTurnTools) {
    checkerStopRequested = true;
    checkState = { state: 'skipped' };
    logger.info(`chat-agent L2: pure dispatch turn (${dispatchTurnTools.join(', ')}) — Double Checker stopped, no reconcile`, { source: 'chat-agent' });
    recordLoopMetric({
      kind: 'crosscheck_dispatch_skip',
      sessionId: runSessionId,
      stamp: chatMetricStamp,
      meta: { tools: dispatchTurnTools.slice(0, 8), supervisor: isSupervisorChat, machine: machineTriggeredRun, answerFirst, elapsedMs: Date.now() - startedAt },
    });
  }
  if (checkersPromise && !dispatchTurnTools && (!draftsDelivered || checkerGateTimedOut)) {
    if (answerFirst) {
      // ── ANSWER-FIRST (compute policy 2026-09-26, design §4 D1) ──────────
      // The lead's answer ships NOW. A draft that is already in (or lands
      // within the short late-wait) is judged by drafts_agree: a confident
      // AGREE in act skips the reconcile pass ("Checked ✓"); otherwise ONE
      // reconcile pass starts here and finishes INTO the persisted row through
      // late-crosscheck.ts (revision_material decides rewrite vs "Checked ✓").
      // No draft yet ⇒ the late reconcile is armed unconditionally (chatId rows).
      // A stakes / verify plan whose lead answered at step 0 never reached the
      // injector's wait — finalize owes it (audit 2026-10-03).
      const finalizeWaitMs = finalizeDraftWaitMs({ answerFirst, plan, injectorWaited: firstInjectAt !== null, lateWaitMs: CROSS_CHECK_LATE_WAIT_MS, stakesBoundMs: STAKES_WAIT_MS });
      if (finalizeWaitMs > CROSS_CHECK_LATE_WAIT_MS && !draftsDelivered) send('progress', keyedProgress('double_checking_stakes', { waitMs: finalizeWaitMs }));
      const block = await Promise.race([
        checkersUnbounded ?? checkersPromise,
        new Promise<string>(res => setTimeout(() => res(''), finalizeWaitMs).unref()),
      ]).catch(() => '');
      if (block && raw.trim() && !args.isCancelled?.()) {
        try {
          // Ghost mode (owner 2026-10-22): the drafts-agree ask ships BOTH
          // texts to the cloud decision backend — a ghost run never sends
          // its answer/drafts anywhere but the designated endpoint. The
          // deterministic reconcile still runs; only the decision ASK skips.
          draftsAgreeResult = ghostRun ? null : await decideDraftsAgree({ leadFinal: harnessLinesOff(raw).slice(0, 3000), checkerDraft: block.slice(0, 3000), chatId: chatId ?? undefined, machine: machineTriggeredRun });
        } catch { draftsAgreeResult = null; }
        if (draftsAgreeResult?.mode === 'act' && draftsAgreeResult.agree === true && (draftsAgreeResult.p ?? 0) >= draftsAgreeThreshold() - 1e-9) {
          draftsAgreeActed = true;
          crossCheckMerged = true; // the draft was weighed against the answer — the check completed
          checkState = { state: 'checked' };
          logger.info(`chat-agent L2 (answer-first): drafts agree (p=${draftsAgreeResult.p?.toFixed(2)}, act) — reconcile pass skipped, Checked ✓`);
        } else {
          // The second opinion is IN — it is being weighed, not "on its way" (status-voice.ts STATUS.checker.weighing).
          send('progress', { message: STATUS.checker.weighing, stage: 'synthesis' });
          const reconcilePromise = reconcileWithCrossCheck({
            model: orchestratorModel, question: queryMessage, draft: harnessLinesOff(raw), block,
            sessionId: runSessionId, projectId: ctx.projectId || 'chat', userId: runUserId,
            ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}),
            userTurnAt, isCancelled: args.isCancelled,
            timeoutMs: machineTriggeredRun ? CROSS_CHECK_LATE_RECONCILE_MACHINE_MS : CROSS_CHECK_LATE_RECONCILE_MS, path: 'inline',
            usage: turnUsage,
          }).catch(() => '');
          lateCrossCheckArmed = !!chatId && !args.isCancelled?.();
          if (lateCrossCheckArmed) { lateReconcilePromise = reconcilePromise; lateReconcileBlock = block; checkState = { state: 'checking' }; }
          logger.info(`chat-agent L2 (answer-first): draft in — reconcile pass runs into the persisted row${lateCrossCheckArmed ? '' : ' (not armed)'}`);
        }
      } else if (!block) {
        lateCrossCheckArmed = !!chatId && !args.isCancelled?.();
        if (lateCrossCheckArmed) checkState = { state: 'checking' };
        logger.info(`chat-agent L2 (answer-first): no cross-check draft within ${CROSS_CHECK_LATE_WAIT_MS}ms — shipping the first answer${lateCrossCheckArmed ? '; the draft reconciles into this message when it lands' : ''}`);
      } else {
        // A draft landed but there was nothing to reconcile (empty/cancelled answer): the More-info card fills.
        await Promise.race([checkersPromise, new Promise(res => setTimeout(res, 5000).unref())]).catch(() => {});
      }
    } else if (isSimpleQuestion && !checkerGateTimedOut) {
      // Step-0 FAST PATH for simple questions (ticket 62761c89): the answer is
      // already complete — do NOT penalize it with the +60s late-wait and the
      // reconcile pass. Keep only a short grace so the More-info checker
      // card still fills when the draft lands moments later. (Deep questions
      // take the full wait + reconcile below, unchanged.)
      await Promise.race([checkersPromise, new Promise(res => setTimeout(res, CROSS_CHECK_SIMPLE_CARD_GRACE_MS).unref())]).catch(() => {});
    } else {
    // Step-0 fast answer: the orchestrator finished with no tool round, so the
    // injector (which only delivers from step ≥ 1 — the deliberate research-
    // overlap window) never handed it the cross-check drafts. Prod: ~10/day;
    // previously the answer shipped UNRECONCILED and only the More-info cards
    // got a 5s grace (ticket 9e6950d1). Now: wait for the drafts (bounded),
    // then run ONE bounded reconcile pass with the SAME orchestrator model;
    // the reconciled text flows through the normal canvas/followup parsing.
    const block = await Promise.race([
      checkersPromise,
      new Promise<string>(res => setTimeout(() => res(''), CROSS_CHECK_LATE_WAIT_MS).unref()),
    ]).catch(() => '');
    if (block && raw.trim() && !args.isCancelled?.()) {
      // Real count, real event (owner directive 2026-08-30 — this was the
      // canned "reconciling the independent cross-check draft…" line).
      const draftCount = (block.match(/--- [^-]+ ---/g) || []).length || 1;
      send('progress', { message: STATUS.checker.comparing(draftCount), stage: 'synthesis' });
      // The pass runs under the LATE bound; the user waits only up to the
      // INLINE bound (CROSS_CHECK_RECONCILE_MS). Past it the lead's answer
      // ships now and this same promise finishes into the row late (11 inline
      // passes in 4 h "returned empty" on 2026-09-19 — the 150 s cap on long
      // supervisor-shaped drafts, and the draft was thrown away).
      // Machine wakes (autonomy loop #7): nobody waits on the stream, so the
      // pass gets the wider machine bound — the 300 s cap lost two supervisor
      // revisions at 315 s on 2026-09-19. Loop #8: keyed on the run's
      // machine-triggered posture (machineTriggeredRun), NOT args.machineWake —
      // hook wakes carry messageOrigin 'hook' and no machineWake flag, so every
      // project-supervisor wake was still bounded at 300 s (14 rows, 21:05–00:00Z).
      const lateReconcileBoundMs = machineTriggeredRun ? CROSS_CHECK_LATE_RECONCILE_MACHINE_MS : CROSS_CHECK_LATE_RECONCILE_MS;
      const reconcilePromise = reconcileWithCrossCheck({
        model: orchestratorModel, question: queryMessage, draft: harnessLinesOff(raw), block,
        sessionId: runSessionId, projectId: ctx.projectId || 'chat', userId: runUserId,
        ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}),
        userTurnAt, isCancelled: args.isCancelled,
        timeoutMs: lateReconcileBoundMs, path: 'inline',
        usage: turnUsage,
      }).catch(() => '');
      const INLINE_GATE = ' inline-gate';
      const raced = await Promise.race([
        reconcilePromise,
        new Promise<string>(res => setTimeout(() => res(INLINE_GATE), CROSS_CHECK_RECONCILE_MS).unref()),
      ]);
      const reconciled = raced === INLINE_GATE ? '' : raced;
      if (raced === INLINE_GATE) {
        lateCrossCheckArmed = !!chatId && !args.isCancelled?.();
        if (lateCrossCheckArmed) { lateReconcilePromise = reconcilePromise; lateReconcileBlock = block; }
        logger.info(`chat-agent L2: reconcile pass still running after ${CROSS_CHECK_RECONCILE_MS}ms — shipping the first answer${lateCrossCheckArmed ? '; the pass finishes into this message' : ''}`);
        if (lateCrossCheckArmed) send('progress', { message: STATUS.checker.stillComparing, stage: 'synthesis' });
      } else if (reconciled && await inlineRevisionIsMaterial(reconciled)) {
        // (compute policy 2026-09-26: revision_material judged the reconcile —
        // a WORDING-ONLY rewrite keeps the delivered draft and reads
        // "Checked ✓" (inlineRevisionIsMaterial false); the stub / fallback
        // verdict is material = today's swap.)
        // Deterministic safety net (owner 2026-09-18): whatever the reconciler
        // did with the draft's end-of-answer chrome, the FINAL text carries the
        // draft's [FOLLOWUPS] block when the reconciled text has none — the
        // chips the user sees never depend on a one-shot model keeping markup.
        const draftFollowUps = parseFollowUps(raw).followUps;
        const reconciledHasBlock = /\[followups/i.test(reconciled);
        raw = (!reconciledHasBlock && draftFollowUps.length)
          ? `${reconciled.trim()}\n\n[FOLLOWUPS]\n${draftFollowUps.map(q => `- ${q}`).join('\n')}\n[/FOLLOWUPS]`
          : reconciled;
        if (noActionNoteScope) raw = await rejudgeNoActionNote(raw); // FSN1021: re-judged on the reconciled text
        // 2026-10-22: a revision drops the unread-state line — the checker's own reads may ground it (missing, never false).
        if (unreadStateNoteScope) raw = stripUnreadStateNote(raw);
        reconciledLive = true;
        // (ticket 899554af N1) the reconciled answer DID merge the checker's
        // draft — the step-0 fast path never injected mid-loop, so without
        // this anchor the incident's false-positive class survived here.
        crossCheckMerged = true;
        // The plain view renders PARTS over content, live and after reload
        // (AssistantParts) — replace the draft's text parts with the reconciled
        // answer so the screen, the copy button, the More-info card and the DB
        // row all show the SAME text (audit 2026-09-18: the swap-in reached
        // only `content`; every surface kept showing the unreconciled draft).
        result.parts = [...(result.parts || []).filter(p => p.type !== 'text'), { type: 'text', text: raw }];
      }
      else logger.warn('chat-agent L2: reconcile pass returned empty — shipping the original answer', { source: 'chat-agent' });
    } else if (!block) {
      // No draft within the (short) late-wait. Owner 2026-09-18 ("users get
      // the first available answer"): ship the lead's answer NOW and let
      // late-crosscheck.ts reconcile the Double Checker's draft INTO the
      // persisted message when it lands (the old 60 s wait then DISCARDED a
      // draft that missed it — 11 of 51 supervisor L2 turns in 48 h). Armed
      // only for persisted chats (anonymous runs have no row to revise).
      lateCrossCheckArmed = !!chatId && !args.isCancelled?.();
      logger.info(`chat-agent L2: no cross-check draft within ${CROSS_CHECK_LATE_WAIT_MS}ms — shipping the first answer${lateCrossCheckArmed ? '; the draft reconciles into this message when it lands' : ''}`);
      if (lateCrossCheckArmed) send('progress', { message: STATUS.checker.stillChecking, stage: 'synthesis' });
    } else {
      // A draft landed but there was nothing to reconcile (empty/cancelled
      // answer): the short grace lets the More-info card fill.
      await Promise.race([checkersPromise, new Promise(res => setTimeout(res, 5000).unref())]).catch(() => {});
    }
    }
  }

  // ── Ticket 9aedb32f: degraded-council notice ─────────────────────────────
  // A deep-research run that dispatched the council but received ZERO real
  // reports (every colleague timed out even after the one automatic retry)
  // answered lead-only while the user paid the deep-research compute budget.
  // Say so, visibly, in the final message — never a silent degrade. `raw` is
  // the text BOTH surfaces read (the streamed final and the persisted row),
  // so the notice survives reloads; the metric gives the audit its counter.
  // No wall clock (2026-10-20): a stalled colleague's report that lands after the lead's last drain is attached as the
  // late-findings follow-up on EVERY run that dispatched — not only a degraded one (council-late-addendum.ts).
  const councilDegraded = dispatchRounds > 0 && councilRealReports === 0;
  if (councilDegraded || (researchUnclocked && dispatchRounds > 0)) lateCouncil.enable();
  if (councilDegraded) {
    raw += researchUnclocked
      ? `\n\n---\n*⚠ Degraded research run: the deep-research council (${dispatchRounds} dispatch round${dispatchRounds === 1 ? '' : 's'}) returned no report — every colleague stalled or failed — so this answer is from the lead model alone. Late-arriving council findings that reach the lead before this answer is finalized appear above as [LATE REPORT] blocks; findings that arrive afterward are attached below as an update once the council settles.*`
      : `\n\n---\n*⚠ Degraded research run: the deep-research council (${dispatchRounds} dispatch round${dispatchRounds === 1 ? '' : 's'}) returned no report within its time budget, so this answer is from the lead model alone. Late-arriving council findings that reach the lead before this answer is finalized appear above as [LATE REPORT] blocks; findings that arrive afterward are attached below as an update once the council settles.*`;
    // Keep the transcript parts in step with `raw` (same rewrite pattern the
    // reconcile branch uses at the drafts-agree seam) so no surface diverges.
    if (result.parts?.length) result.parts = [...(result.parts || []).filter(p => p.type !== 'text'), { type: 'text', text: raw }];
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.COUNCIL_DEGRADED_RUN, sessionId: runSessionId, stamp: chatMetricStamp, meta: { chatId, dispatchRounds, machineTriggered: machineTriggeredRun } });
  }

  // Repair degraded model markdown (missing blank lines before headings/lists,
  // fully-collapsed single-line answers) before canvas/followup parsing and
  // persistence — models progressively drop blank lines in long conversations
  // (feedback fc841f58). Canvas/SEND_EMAIL/FOLLOWUPS regions pass through
  // byte-identical, so parseCanvasTags/parseFollowUps are unaffected.
  // (ticket 942db7aa) The lint's 'emitted' telemetry below must measure the
  // note AS THE MODEL EMITTED it — the regression rate — not the post-repair
  // text (which measures repair misses). Snapshot the strike classes HERE,
  // before any repair, machine notes only (the lint seam's own gate).
  let markdownLintEmittedClasses: string[] = [];
  if ((args.machineWake === true || (isSupervisorChat && machineTriggeredRun)) && !markdownLintDisabled() && chatId) {
    try {
      markdownLintEmittedClasses = [...new Set(lintMarkdownNote(raw).strikes.map((s) => s.cls))];
    } catch { /* fail-open: telemetry only */ }
  }
  // ── Ticket 4d161561 (escalation d36ad50a): the delivered-answer scaffolding gate ──────────
  // The nightly live-chat audit convicted a delivered human answer that carried internal text
  // (ANSWER_LEAK_RE). The answer path stripped canvas / [FOLLOWUPS] markup and the fullwidth-bar
  // native tool tokens — and NOTHING else: `<function=…>` fragments, ASCII special tokens like
  // `<|tool_call|>`, an echoed harness marker line ([HARNESS CLOCK] / [EVIDENCE LEDGER …] /
  // [MACHINE-TRIGGERED RUN …]), a bare `{"name": …, "arguments": …}` call object, and a stray
  // or mismatched reasoning tag all reached the persisted row. answer-scaffolding.ts is that
  // missing strip, applied HERE so both the content and the parts pipeline see the same text
  // (parts are re-run through it at the persist map below). Fenced / block-quoted text and the
  // harness's own guard chrome are never touched.
  // Deliberately NO warn line: this is the repair path working (a boilerplate warn would become a
  // log-signal ticket per fingerprint). The audit's own answer_leaks count is the measure.
  {
    const scrubbed = stripAnswerScaffolding(raw);
    if (scrubbed.removed > 0) raw = scrubbed.text;
  }
  raw = normalizeAssistantMarkdown(raw);

  let { canvases: parsedCanvases, cleanText } = parseCanvasTags(raw);
  const { followUps: parsedFollowUps, cleanText: parsedFinalText } = parseFollowUps(cleanText);
  // `let`, not const: the pre-delivery action guard below may REPLACE the
  // machine-wake final note before anything persists it (ticket fcc4dbb4).
  let finalText = parsedFinalText;
  // `let` (ticket 4ac547de): the deterministic backstop below may fill this
  // when the model emitted no block.
  let followUps = parsedFollowUps;
  //   // ── Ticket 4ac547de: deterministic follow-ups backstop ──────────────────────────────────────────────
  // A zero-chip parse used to be final — but on a Level 2 HUMAN turn the
  // chips are a product contract (owner 2026-09-18 "what happened to the
  // follow-ups?"), and measured prod (2026-10-17) showed 126/126 zero-chip
  // 'thinking' rows were human turns whose lead closed with the supervisor
  // wake-close contract or a "Follow-through:" line instead of the
  // [FOLLOWUPS] block, with no checker draft on those paths to re-append
  // (chat-agent/followups-backstop.ts). BOUNDED await: the utility race
  // resolves in ≤ FOLLOWUP_BACKSTOP_TIMEOUT_MS (default 4 s) and fails open.
  // Human turns only — guests INCLUDED (the doctrine mandates question chips
  // for signed-out users too, and the product alert counts their rows;
  // adversarial review F2); machine wakes stay out — nobody is on the turn
  // to tap a chip, and the alert's user-turn filter never counts machine
  // rows (review F3: NOT because their doctrine omits chips — it asks for
  // questions); the bench account is excluded so E2E load never pays the
  // utility call (review F6); a continuation round never re-arms it (the
  // ANSWER row owns the chips); Level 1 ('single_thinking') is the one-shot
  // lane and stays out of scope.
  if (
    !followUps.length
    && mode === 'thinking'
    && !machineTriggeredRun
    && !args.continuation
    && !args.escalation
    && !(await isBenchAccountUser(userId))
    && !followupBackstopDisabled()
    && !ghostRun
    && finalText.trim().length > 0
    && !isHarnessErrorNote(finalText)
  ) {
    const backstop = await generateBackstopFollowUps(
      (q, s, mem) => moonshotIntegration.generateFollowUps(q, s, mem),
      { question: queryMessage, cleanText: finalText, sessionId: runSessionId },
    ).catch(() => ({ followUps: [] as string[], fired: false }));
    if (backstop.followUps.length) followUps = backstop.followUps;
  }

  // ── PRE-DELIVERY phantom-action guard (ticket fcc4dbb4, 2026-08-26) ───────
  // Machine-triggered plain-chat runs only: audit the final note against the
  // run's REAL executions (computePhantomClaims — the same matcher the
  // post-delivery verifier uses) and, on a phantom conviction, REPLACE the
  // note with a harness-authored honest notice + the original as a quoted
  // audit block BEFORE the assistant row commits — the phantom claim never
  // reaches the owner. AWAITED (not fire-and-forget): the delivery below is
  // what it guards. Fully fail-open — any guard error keeps the original
  // text and the post-delivery verifier still runs as backstop. Dynamic
  // import, same discipline as the other platform finalize hooks (the module
  // pulls the utility-LLM chain). EVERY machine wake reaches the guard
  // (ticket 375c8618): its deterministic future-observation-clock check must
  // see keyword-free notes too — a fabricated clock carries no action-claim
  // keywords. The LLM action matcher stays keyword-gated INSIDE the guard,
  // so the added cost here is one regex scan per wake, zero extra LLM calls.
  // (ticket b216475a) Seam widened: EVERY machine wake (args.machineWake), and
  // additionally AGENT-ANCHORED runs on the SUPERVISOR chat (origin 'agent' /
  // 'webhook' with machineWake unset — send_chat_message steers/reports). The
  // 2026-09-13 incident notes were anchored by agent-origin sends, so both
  // audit lanes stood down and four fabricated ticket ids delivered twice.
  // Non-supervisor agent-anchored runs are intentionally NOT widened (scope
  // discipline — only the supervisor chat's fleet notes are the incident
  // surface).
  // Seat label for the verifier's attribution surfaces (hardening review
  // 2026-09-14): a PROJECT supervisor's phantom ticket used to read "The fleet
  // supervisor's machine-wake note" under area 'fleet-supervisor'. Label-only —
  // rides every guard / post-delivery call below and the guard_strike meta so
  // fleet vs project strike rows split without a chat join. Undefined for
  // non-supervisor machine wakes.
  const supervisorScope: 'fleet' | 'project' | undefined = isSupervisorChat ? (isProjectSupervisorChat ? 'project' : 'fleet') : undefined;
  // BRIEFING-UNVERIFIED-FILTER (2026-10-20): the ACTION-class convictions the guard below delivers
  // unmodified (observe-only — the whole verdict, or a mixed strike's action-class rest) and the claim
  // details an annotation the guard already put on the note names; the finalize's footnote lane reads both.
  let actionClassObservedClaims: any[] = [];
  let guardAnnotatedClaimDetails: string[] = [];
  // STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83): the delivered note carries the repeat annotation — an APPEND
  // (live viewers get the text, never the `corrected` marker) and no owner briefing restates it as news
  // (`struckRepeatBriefingClosed` — every annotated outcome; round 5 removed the run-backed exception along with the
  // run-backed skip). `struckRepeatLineage` = the spend stamp the delivered row carries
  // (metadata[REPEAT_LINEAGE_META_KEY]): its lineage has had its one reject-back.
  let struckRepeatAnnotated = false;
  let struckRepeatBriefingClosed = false;
  let struckRepeatLineage: RepeatLineageStamp | null = null;
  // A reject-back retry's swap REPLACES result.parts — the superseded attempt's parts (its tool calls really
  // executed) are kept here for the computer_task claim check below, which judges the whole run.
  let rejectBackSupersededParts: unknown[] = [];
  if ((args.machineWake === true || (isSupervisorChat && machineTriggeredRun)) && userId && chatId) {
    try {
      const { guardMachineWakeFinalAnswer, toolResultTextsFromParts, isCitationClassClaim, claimAuditExcerpts } = await import('../platform/action-verifier');
      // REJECT-BACK (fleet-integrity cluster ba65163d / aac649ba — the
      // machine-wake counterpart of the coding lane's dc04deea gate): the
      // FIRST pass defers consequences. A struck note is rejected back for
      // ONE bounded re-orchestration with the guard's notice in context — the
      // model can re-verify with FRESH tool calls (the prompt-ceiling
      // citation habit this fixes is one after-the-fact corrections cannot
      // reach: the supervisor re-invents ids every wake because every remedy
      // landed post-hoc). A clean second answer delivers with ZERO ticket
      // churn — the self-correction IS the fix working; a still-convicted
      // second answer (or a failed retry) is re-guarded with consequences ON,
      // so the strike path fires exactly once, on the final answer. The guard
      // decides; the executor regenerates (dc04deea's split).
      // Gate flip 2026-09-11 (owner: full steam): the action verifier is
      // OBSERVE-ONLY by default. Its verdict is recorded (guard_strike seam
      // machine_wake_reject_back, outcome 'observed', phantom kinds) and the
      // note is delivered UNMODIFIED — no line removal, no reject-back
      // re-orchestration (a second ~12-min glm-5.3 turn), no correction row.
      // Evidence: on 2026-09-11 all 9 "phantom" message ids it struck across
      // 3 supervisor notes were REAL lane messages the supervisor had read —
      // its receipt-idiom miner reads "(msg <id>)" citations as send claims.
      // ACTION_VERIFIER_ENFORCE=1 restores the strike + reject-back pipeline.
      const actionVerifierEnforce = process.env.ACTION_VERIFIER_ENFORCE === '1';
      // build 2026-10-08 Q-3 (OWNER-APPROVED clock package — platform/future-clock-policy.ts): an
      // AHEAD-of-now headline clock is CORRECTED from the server clock (answer-clock.ts), never flagged;
      // the guard's clock verdict is recorded once per pass (future_clock_verdict). Both off under
      // FUTURE_CLOCK_REPLACE_ENABLED=1 (the legacy replace lane).
      const clockPolicyOn = !futureClockReplaceEnabled();
      const restampAheadHeadline = (): void => {
        if (!clockPolicyOn) return;
        const ahead = stampAheadHeadlineClock(finalText, new Date());
        if (!ahead.stamped) return;
        const { from, to } = ahead.stamped;
        finalText = ahead.text;
        if (result.parts?.length) {
          let done = false;
          result.parts = (result.parts || []).map((p: any) => (!done && p?.type === 'text' && typeof p.text === 'string' && p.text.includes(from) ? (done = true, { ...p, text: p.text.replace(from, to) }) : p));
        }
        leakRetrySwapped = true; // live viewers swap to the corrected headline
        recordLoopMetric({ kind: 'owner_answer_clock_stamped', sessionId: runSessionId, stamp: chatMetricStamp, value: ahead.stamped.driftMin, meta: { ...ahead.stamped, surface: 'machine_wake', ...(supervisorScope ? { supervisorScope } : {}) } });
      };
      const recordClockVerdict = (g: { clockVerdict?: any }, pass: 1 | 2): void => {
        if (!g?.clockVerdict) return;
        recordLoopMetric({ kind: 'future_clock_verdict', sessionId: chatId, stamp: chatMetricStamp, value: (g.clockVerdict.hits ?? []).filter((h: any) => h?.verdict === 'convicted').length, meta: { ...g.clockVerdict, pass, ...(supervisorScope ? { supervisorScope } : {}) } });
      };
      restampAheadHeadline();
      // (Fleet 17:14Z incident, 2026-09-15) In observe-only mode the FIRST pass
      // already runs under consequenceScope 'citation-only': a MIXED verdict
      // comes back scoped to its deterministic convictions (citation-class +
      // fabricated ids) with the action-class rest in observedPhantoms, so the
      // always-on citation enforcement below sees a homogeneous set and bites.
      // Before this, one co-riding action phantom made isCitationClassStrike
      // false and the whole fabricated set delivered unmodified (the 17:14Z
      // fleet note: "sched 88d9287e" / "ticket 61797fe8" / "goal ff4f99fd").
      // STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21 — chat-agent/struck-note-repeat.ts): is this
      // note a near-verbatim re-post (≥ 90 %, timestamps aside, the SAME numbers and ids) of the chat's previous
      // STRUCK note? The 17:20:32Z note on chat e03452f4 copied its struck 17:12 note verbatim (another wrong
      // clock, in the past this time — nothing for the clock lane) instead of running the Fleet Supervisor's
      // "step 1 first". A repeat rides the bounded reject-back below ONCE with `repeatLeadNotice` (naming the
      // repeat + the struck claims) — folded into a guard reject-back that runs anyway, else its own cycle; a
      // retry that still repeats is delivered as written with an annotation (the end of this block). Never a
      // second retry. Round 2: the verdict is computed BEFORE pass 1 (finding 4) so a planned repeat reject-back
      // defers the clock lane's ticket like every other lane's (deferClockTicket — it files on the pass-2
      // verdict of the text actually delivered, never on a draft the retry discards); a supervisor NO-OP note
      // (classifySupervisorNote, the one classifier) is never compared (finding 3a). STRUCK_NOTE_REPEAT_DISABLED=1.
      // Round 3: the no-op skip needs an EXPLICIT no-op marker closing the note (explicitNoopPredicate — never the
      // classifier's ≤200-char fall-through, which read every short re-post of a struck claim as a no-op once phase 1
      // had stripped the model's ACTIONS TAKEN block); a note struck only by the computer_task claim check (that
      // unmeasured pattern check) never drives a reject-back.
      // Round 4 (both round-3 reviews NOT_MERGE_SAFE): a struck note costs AT MOST ONE reject-back, ever — the
      // round-3 carry-through is gone and a copy that went through the check is SPENT (repeatSpent: the repeat
      // annotation, or the lineage stamp this seam writes on the delivered row), so an honest unchanged status after
      // one bounce is never bounced again. `repeatPrior` = any STRUCK prior (an ineligible one — spent /
      // screen-claims-only — is still measured as wouldRepeat, never acted on); `repeatTarget` = the prior only when
      // it may drive the one reject-back (repeatTargetOf). The reject-back is SKIPPED — annotated instead
      // (repeatSkip) — when the run fired a replay-unsafe tool (tool-call-leak firedReplayUnsafeTool, the same rule the
      // leak / empty-answer retries use; update_supervisor_state's idempotent merge and an input-free computer_task —
      // camera-only / busy / unavailable — are replay-safe): a whole-wake replay never re-runs a send or a desktop action.
      // Round 5 (both round-4 reviews NOT_MERGE_SAFE): that is the ONLY skip — the round-4 'run_backed' skip (a struck
      // clock / id found in any tool result) is gone, because the likeliest such tool result is an echo of the struck
      // note itself (a read of this chat's messages, the supervisor state, a relay quoting the clock), not evidence.
      let repeatIsNoop: (body: string) => boolean = () => false;
      const repeatPrior: PriorNote | null = !struckNoteRepeatDisabled() && priorNote?.struck ? priorNote : null;
      const repeatTarget: PriorNote | null = repeatTargetOf(repeatPrior);
      if (repeatPrior) {
        try {
          const { classifySupervisorNote, SUPERVISOR_NOOP_NOTE_RE, SUPERVISOR_ACTION_NOTE_RE } = await import('../platform/supervisor.service');
          repeatIsNoop = explicitNoopPredicate({ classify: classifySupervisorNote, noop: SUPERVISOR_NOOP_NOTE_RE, action: SUPERVISOR_ACTION_NOTE_RE });
        } catch { /* fail-open: no classifier ⇒ every note is compared, as in round 1 */ }
      }
      const repeatVerdict = repeatPrior ? detectStruckNoteRepeat(finalText, repeatPrior, { isNoop: repeatIsNoop }) : null;
      const repeatSkip: RepeatSkip | null = repeatVerdict?.repeat && repeatTarget
        ? repeatRejectBackSkip({
            replayUnsafeTool: firedReplayUnsafeTool(result.parts as any[], { allow: ['update_supervisor_state', ...(computerTaskCallsInputFree(result.parts as unknown[]) ? ['computer_task'] : [])] }),
          })
        : null;
      const repeatRejectBackPlanned = !!repeatVerdict?.repeat && !repeatSkip && !args.isCancelled?.();
      // The pass-1 instant, pinned only when a repeat reject-back is planned — the stop-mid-pass-1 re-guard below
      // files the deferred clock ticket against the SAME clock pass 1 judged (byte-identical args otherwise).
      const pass1Now = new Date();
      const pass1Input: Parameters<typeof guardMachineWakeFinalAnswer>[0] = {
        chatId, userId, finalText,
        parts: (result.parts || []) as any[],
        receipts: result.receipts ?? [],
        runStartedAt: new Date(startedAt),
        supervisor: isSupervisorChat,
        supervisorScope,
        machineTriggered: true,
        deferConsequences: true,
        ...(repeatRejectBackPlanned ? { deferClockTicket: true, now: pass1Now } : {}),
        consequenceScope: actionVerifierEnforce ? 'all' : 'citation-only',
        // (ticket 899554af) TRUE cross-check narration exoneration: an agent-
        // anchored 'thinking' run (machineWake unset) DOES run the L2 checker
        // — when its draft was genuinely merged (injected or reconciled in),
        // the synthesis may truthfully narrate the merge. Machine wakes never
        // run the checker (crossCheckMerged stays false) so their audit is
        // byte-identical; a gate-timeout/late-armed run keeps conviction too.
        crossCheckDelivered: crossCheckMerged,
        ...(harnessModelBlockLines ? { harnessStripped: { block: harnessModelBlockLines > harnessForgedLines, copies: harnessForgedLines > 0 } } : {}),
        // (ticket 7cabb0cc) Same anchor for the L3 council: a deep-research /
        // Dig-deeper rung that genuinely dispatched colleagues
        // (dispatchRounds > 0) may truthfully narrate the council round even
        // though the pipeline lane mints no receipt and leaves no part.
        councilDispatched: dispatchRounds > 0,
      };
      let guarded = await guardMachineWakeFinalAnswer(pass1Input);
      if (guarded.audited) actionGuardAudited = true; // ticket fc337153 single-audit: the guard's verdict covers this text
      recordClockVerdict(guarded, 1);
      // (ticket b216475a) Citation-class strike classification: a conviction
      // that is ALL citation-class (deterministic row-existence lanes — msg /
      // sched / session-chat / ticket, isCitationClassClaim) or a DETERMINISTIC
      // future-clock strike (phantoms:[]) is enforced even in observe-only
      // mode; ACTION-class convictions (the coin-flip LLM lane the 2026-09-11
      // flip was driven by) stay observe-only. Pure future-clock strikes carry
      // zero phantoms; a clock strike carrying ticket-citation phantoms (PART
      // B) is all-citation-class too.
      // WHAT a clock-lane strike struck (iteration 11): ≤4 hits, line clipped —
      // rides guard_strike meta as `clockHits` for strike-class measurement.
      const clockHitsForMetric = (g: typeof guarded): Array<{ token: string; minutesAhead: number; line: string }> =>
        (g.futureClocks ?? []).slice(0, 4).map((h) => ({ token: String(h.token).slice(0, 40), minutesAhead: h.minutesAhead, line: String(h.line).slice(0, 164) }));
      const isCitationClassStrike = (g: typeof guarded): boolean => {
        if (!g.struck) return false;
        const phantoms = g.phantoms ?? [];
        if (phantoms.length === 0) return true; // pure deterministic future-clock strike
        return phantoms.every((p: any) => isCitationClassClaim(p));
      };
      // (ticket b216475a) ONE bounded reject-back re-orchestration + the
      // consequences-ON second pass — EXTRACTED from the enforce branch so the
      // enforce path and the always-on citation-enforce path run the IDENTICAL
      // flow. Behavior unchanged: reject back with the guard's notice, swap in
      // a non-empty retry (receipts unioned, parse pipeline re-run), then
      // re-guard whatever text now stands with consequences ON and record the
      // citationRetry outcome row.
      // `secondPassScope` (ticket f16cc02a): the enforce branch passes 'all'
      // (every standing conviction tickets); the citation-enforce branch
      // passes 'citation-only' — when the standing second-pass verdict flips
      // ACTION-class, this seam deliberately does NOT apply the redaction
      // (the 2026-09-11 observe-only flip), so the guard must not file the
      // strip+mark containment ticket either (it would claim a redaction that
      // never happens — the false containedPreDelivery/deliveredRedacted
      // provenance behind f16cc02a).
      // STRUCK-NOTE REPEAT state (the verdict itself is computed above, before pass 1). Round 2 (finding 5):
      // `repeatRetryAttempted` = the reject-back ran with the repeat notice; `repeatRetried` = a NON-EMPTY retry was
      // swapped in — only then can the outcome say a retry "came back"; `repeatCycle` = the cycle's facts for the
      // struck_note_repeat row (a repeat-only cycle writes no guard_strike row — finding 1). Round 4: a SKIPPED repeat
      // (repeatSkip) never rides a cycle — not even a guard reject-back that runs anyway keeps the repeat notice / the
      // repeat seed ("re-run every flagged claim") on a replay-unsafe run; the guard's own "reuse, do not redo" seed stands.
      let repeatLeadNotice = repeatRejectBackPlanned && repeatVerdict && repeatTarget ? renderRepeatRejectBackNotice(repeatVerdict, repeatTarget) : '';
      let repeatOnlyRejectBack = false; // the repeat is the only trigger: the guard's own notice is not acted on
      let repeatRetryAttempted = false;
      let repeatRetried = false;
      let repeatCycle: { trigger: string; seeded: boolean; retryMs: number; swapped: boolean; firstPassStruck: boolean; firstPassClockHits?: Array<{ token: string; minutesAhead: number; line: string }>; secondPassStruck: boolean; secondPassPhantoms: number } | null = null;
      // Round 5 (both round-4 reviews, minor): did ANY reject-back cycle re-run this wake (set once its retry was
      // attempted, whatever triggered it)? A replay-unsafe repeat skip whose wake the guard's own cycle re-ran anyway is
      // 'guard_cycle_repeat' — never worded as "it was not sent back".
      let rejectBackCycle: { swapped: boolean } | null = null;
      const runRejectBackAndSecondPass = async (secondPassScope: 'all' | 'citation-only'): Promise<void> => {
        const leadNotice = repeatLeadNotice;
        repeatLeadNotice = ''; // one cycle carries it — the helper never runs twice in a run (see the call sites)
        if (leadNotice) repeatRetryAttempted = true;
        if (repeatOnlyRejectBack) {
          logger.warn('chat-agent: machine-wake note repeats this chat\'s previous STRUCK note — rejecting back for ONE bounded re-orchestration (the guard struck nothing on pass 1)', { source: 'chat-agent', struckNoteRepeat: true });
        } else {
          logger.warn(`chat-agent: machine-wake note struck pre-delivery — rejecting back for ONE bounded re-orchestration (${guarded.phantoms.length} phantom claim(s))`, { source: 'chat-agent', claims: claimAuditExcerpts(guarded.phantoms ?? []), ...(leadNotice ? { struckNoteRepeat: true } : {}) });
        }
        send('progress', { message: STATUS.recover.recheck, stage: 'synthesis' });
        adapter.resetForRetry(); // a stale suppressed/segment would corrupt the retry's stream
        const firstReceipts = result.receipts ?? [];
        // HARNESS-RECEIPTS (review fix 2026-10-20): attempt 1's calls really executed — they stay in the harness record.
        const firstParts = (result.parts ?? []) as unknown[];
        // WHAT was struck (iteration 11, 2026-09-25): the first pass's clock
        // hits ride the outcome row as `clockHits` — pass 2 overwrites
        // `guarded`, and a clean retry left no persisted notice to mine.
        const firstPassClockHits = clockHitsForMetric(guarded);
        // Round 3 (nit): a repeat-only cycle writes no guard_strike row, so a pass-1 strike the guard did NOT reject
        // back on (a clock-only observe-only annotation) is stamped on the struck_note_repeat row's cycle instead.
        const firstPassStruck = !!guarded.struck;
        // (FO firing 57) Same capture for the CLAIMS: the outcome row below
        // reads the pass-2 verdict, so a clean retry logged phantoms:0 with
        // no trace of what the ~5-min re-orchestration was bought to fix.
        // The excerpts ride the row as `struckClaims` (kind/detail/id, capped).
        const firstPassStruckClaims = claimAuditExcerpts(guarded.phantoms ?? []);
        // Cross-attempt stamp provenance (ticket a688ba29): the retry may
        // honestly re-cite a forward stamp whose tool-output provenance lives
        // in THIS attempt's tool results (the reject-back notice names the
        // struck stamp) — pass them into the second pass, the same parity the
        // receipt union below gives execution evidence. Tool-output text only.
        const firstToolTexts = toolResultTextsFromParts((result.parts || []) as any[]);
        // Retry SEED (autonomy loop #11, 2026-09-20 — chat-agent/reject-back-seed.ts):
        // the retry used to see only the notice and redid the WHOLE wake (one
        // took 16 min on the crossmodel Supervisor while its hook backlog
        // starved). It now also gets the rejected draft (quoted — the guard's
        // quoted-void exemption covers an echoed struck clock) and this run's
        // tool RESULT texts — the same texts pass 2 already accepts as evidence
        // via extraEvidenceHaystacks — with instructions to rewrite and make
        // ONE fresh evidence-bearing call. Metric meta seeded/retryMs measure it.
        const { buildRejectBackRetrySeed } = await import('./reject-back-seed');
        // A repeat's retry is NOT seeded with the rejected draft — the draft IS the re-posted struck note, and
        // "rewrite it" invites the same copy; this run's tool results still ride the seed.
        // Round 2 (finding 7): a repeat retry gets its OWN seed (reference-only tool results — no "rewrite", no "do
        // not re-fetch"), and a folded guard notice loses "Do not mention this check" (the repeat notice asks for one
        // line on what the previous note got wrong).
        const retrySeed = leadNotice
          ? buildRejectBackRetrySeed((result.parts || []) as any[], '', { mode: 'repeat' })
          : buildRejectBackRetrySeed((result.parts || []) as any[], finalText);
        const guardNoticeForRetry = repeatOnlyRejectBack ? '' : leadNotice ? withoutNoMentionSentence(guarded.rejectBackNotice ?? '') : guarded.rejectBackNotice;
        const retryStartedAt = Date.now();
        const retry = await runOrchestrator([leadNotice, guardNoticeForRetry, retrySeed].filter(Boolean).join('\n\n')).catch((err: any) => {
          logger.warn(`chat-agent: machine-wake reject-back re-orchestration failed: ${err?.message}`, { source: 'chat-agent' });
          return null;
        });
        const retryMs = Date.now() - retryStartedAt;
        // FAIL-CLOSED (review B2): trust ONLY the orchestrator's own finalText
        // — never adapter.answerText. resetForRetry()'s contract covers the
        // EMPTY-answer shape (the orchestrator-empty retry idiom); here the
        // adapter already holds attempt 1's struck text, so its answerText is
        // attempt1+attempt2 concatenated (and a short retry's tail can strand
        // in its segment buffer — no second finish() runs on this path).
        // Parsing that pollution would re-guard text already convicted
        // (spurious re-strike) or, on an extraction miss, deliver the phantom
        // (guard defeat). An empty retry is a FAILED retry — the original
        // strike stands below.
        const retrySwapped = !!(retry && (retry.finalText || '').trim());
        rejectBackCycle = { swapped: retrySwapped };
        if (retry && (retry.finalText || '').trim()) {
          result = retry;
          if (leadNotice) repeatRetried = true; // round 2 (finding 5): only a real, non-empty retry "came back"
          rejectBackSupersededParts = [...rejectBackSupersededParts, ...firstParts];
          // HARNESS-RECEIPTS (review fix 2026-10-20): phase 1's strip on the retry's own model-typed block
          // (the second pass below then audits the same shape pass 1 did); the view is rebuilt after the
          // receipt union below. A no-op without the harness view (kill switch / human turn / errored phase 1).
          if (harnessViewOf) {
            harnessSupersededParts = [...harnessSupersededParts, ...firstParts];
            // The delivered note is the retry's: its strip counts start over, so the footnote / annotation
            // wording names what was removed from THIS text, never attempt 1's (review fix 2026-10-20).
            harnessModelBlockLines = 0;
            harnessForgedLines = 0;
            result = harnessStripPhase1(result);
          }
          // Re-run the finalize parse pipeline on the retry's text — the
          // deliverable AND its side-products (canvases/follow-ups) must be
          // the retry's, never the rejected attempt's. The lint's 'emitted'
          // snapshot (942db7aa) re-snapshots HERE too: the delivered note is
          // the retry's emission, not attempt-1's.
          if ((args.machineWake === true || (isSupervisorChat && machineTriggeredRun)) && !markdownLintDisabled() && chatId) {
            try {
              markdownLintEmittedClasses = [...new Set(lintMarkdownNote(result.finalText || '').strikes.map((s) => s.cls))];
            } catch { /* keep attempt-1's snapshot */ }
          }
          const retryParsed = parseCanvasTags(normalizeAssistantMarkdown(result.finalText || ''));
          parsedCanvases = retryParsed.canvases;
          const retryFollow = parseFollowUps(retryParsed.cleanText);
          followUps = retryFollow.followUps;
          finalText = retryFollow.cleanText;
          rejectBackSwapped = true; // B1: attempt-1 chunks already streamed — live viewers swap to this text
          restampAheadHeadline(); // build 2026-10-08 Q-3: the retry's headline gets the same correction
          // Union both attempts' receipts (deduped by id): the retry's fresh
          // pulls are legitimate evidence for its own answer; the first
          // attempt's receipts remain valid context (resumed-run parity).
          const seenReceipt = new Set<string>();
          const unionReceipts: any[] = [];
          for (const r of [...firstReceipts, ...(retry.receipts ?? [])] as any[]) {
            if (!r || seenReceipt.has(r.id)) continue;
            seenReceipt.add(r.id);
            unionReceipts.push(r);
          }
          result.receipts = unionReceipts;
          // HARNESS-RECEIPTS (review fix 2026-10-20): the record states what EVERY attempt executed — attempt 1's
          // calls then the retry's, paired against the unioned receipts (phase 2 renders from this view).
          if (harnessViewOf) harnessView = harnessViewOf([...harnessSupersededParts, ...((result.parts ?? []) as unknown[])], unionReceipts);
        } else {
          logger.warn('chat-agent: machine-wake reject-back retry returned empty — the original strike stands', { source: 'chat-agent' });
        }
        // SECOND pass — consequences ON, on whatever text now stands: the
        // retry's clean answer passes; a still-convicted retry or the
        // failed-retry original takes the normal struck path exactly once.
        // The deliverable text changed hands above (the retry swap) — pass
        // 1's verdict no longer covers it; only THIS pass's audited counts.
        actionGuardAudited = false;
        guarded = await guardMachineWakeFinalAnswer({
          chatId, userId, finalText,
          parts: (result.parts || []) as any[],
          receipts: result.receipts ?? [],
          runStartedAt: new Date(startedAt),
          supervisor: isSupervisorChat,
          supervisorScope,
          machineTriggered: true,
          extraEvidenceHaystacks: firstToolTexts,
          consequenceScope: secondPassScope,
          // STRUCK-NOTE REPEAT (round 4, decision 4): pass 1 deferred the clock ticket because a repeat reject-back
          // was PLANNED; when the retry did not swap (empty / failed), the text standing is pass 1's — judge it on
          // pass 1's clock (as the stop-mid-pass-1 path does), or a clock that was ahead then has become the past
          // during a long retry and the deferred ticket never files on the text actually delivered.
          ...(repeatRejectBackPlanned && !retrySwapped ? { now: pass1Now } : {}),
          // (ticket 899554af) Same TRUE-narration exoneration as pass 1.
          crossCheckDelivered: crossCheckMerged,
          ...(harnessModelBlockLines ? { harnessStripped: { block: harnessModelBlockLines > harnessForgedLines, copies: harnessForgedLines > 0 } } : {}),
          // (ticket 7cabb0cc) Same L3 council anchor as pass 1.
          councilDispatched: dispatchRounds > 0,
        });
        if (guarded.audited) actionGuardAudited = true; // single-audit (fc337153): the second pass's verdict covers the delivered text
        recordClockVerdict(guarded, 2);
        // Reject-back outcome telemetry (owner 2026-09-04, CV0904 root cause):
        // one row per reject-back cycle — did the bounced model self-correct?
        // Rides the existing GUARD_STRIKE kind (the pre-delivery guard DID
        // fire on pass 1); meta.citationRetry carries the outcome the fix
        // exists to move: 'clean' (the retry delivered — self-correction
        // worked, zero ticket churn) vs 'still_dirty' (the strip/replace lane
        // ran on the final answer). Fire-and-forget, never throws.
        // STRUCK-NOTE REPEAT (round 2, finding 1): a REPEAT-ONLY cycle (the guard struck nothing it would reject
        // back on pass 1) writes NO guard_strike row — the nightly adjudicator labels machine_wake_reject_back +
        // citationRetry 'clean' true_positive and the G17 fabrication-class count includes the seam, so the row
        // would be a false fabrication label. The struck_note_repeat row records this cycle (`repeatCycle`). A
        // cycle the guard armed itself (the repeat FOLDED into it) keeps its row as before.
        if (leadNotice) repeatCycle = { trigger: repeatOnlyRejectBack ? 'struck_note_repeat' : 'guard+struck_note_repeat', seeded: retrySeed.length > 0, retryMs, swapped: retrySwapped, firstPassStruck, ...(firstPassClockHits.length ? { firstPassClockHits } : {}), secondPassStruck: !!guarded.struck, secondPassPhantoms: guarded.phantoms?.length ?? 0 };
        if (!repeatOnlyRejectBack) recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            guard: 'action-verifier',
            seam: 'machine_wake_reject_back',
            citationRetry: guarded.struck ? 'still_dirty' : 'clean',
            phantoms: guarded.phantoms?.length ?? 0,
            // (FO firing 57) pass-1 evidence: what the retry was bought to fix
            // — the pass-2 verdict above says clean, these excerpts say WHAT
            // struck (kind/detail/id, capped at 4 by claimAuditExcerpts).
            ...(firstPassStruckClaims.length ? { struckClaims: firstPassStruckClaims } : {}),
            // Retry cost (autonomy loop #11): was the retry seeded with the
            // draft + tool results, and how long did the re-orchestration take.
            seeded: retrySeed.length > 0,
            retryMs,
            ...(firstPassClockHits.length ? { clockHits: firstPassClockHits } : {}),
            ...(leadNotice ? { trigger: 'guard+struck_note_repeat' } : {}),
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
      };
      // The repeat's reject-back (tickets 4c7aebf7 + 9a976d83): when no guard reject-back is armed for this note
      // (a clean pass, a clock-only annotation, or an observe-only ACTION-class verdict), the repeat runs ITS OWN
      // cycle here — the second pass re-guards the retry with consequences ON and the branches below judge that
      // verdict exactly as they would any other (none of them re-enters the helper: the pass-2 verdict carries no
      // rejectBackNotice). When a guard reject-back IS armed, the repeat notice rides that one cycle instead.
      // Round 2 (finding 4): pass 1 deferred the clock ticket because this reject-back was PLANNED; a run stopped
      // while pass 1 ran gets no retry, so the deferred ticket files now through a consequences-ON re-guard of the
      // same text pinned to the pass-1 instant (the clock lane early-returns — only the clock ticket is at stake).
      if (repeatRejectBackPlanned && args.isCancelled?.()) {
        if (guarded.futureClocks?.length) {
          const { deferConsequences: _deferred, deferClockTicket: _deferredClock, ...consequencesOn } = pass1Input;
          guarded = await guardMachineWakeFinalAnswer(consequencesOn);
          if (guarded.audited) actionGuardAudited = true;
        }
      } else if (repeatRejectBackPlanned) {
        const guardRejectBackArmed = guarded.struck && !!guarded.rejectBackNotice && (actionVerifierEnforce || isCitationClassStrike(guarded));
        logger.warn(`chat-agent: machine-wake note repeats this chat's previous STRUCK note (${Math.round(repeatVerdict!.similarity * 100)}% the same) — rejecting back once${guardRejectBackArmed ? ' (folded into the armed guard reject-back)' : ''}`, { source: 'chat-agent', chatId: chatId.slice(0, 8), priorMessageId: repeatTarget!.id.slice(0, 8), similarity: repeatVerdict!.similarity });
        if (!guardRejectBackArmed) {
          repeatOnlyRejectBack = true;
          await runRejectBackAndSecondPass(actionVerifierEnforce ? 'all' : 'citation-only');
        }
      }
      // NOTE (hardening review 2026-09-14): the observe-only outcome row used
      // to be recorded HERE, for EVERY non-enforce strike — including
      // citation-class strikes that the always-on branch below then redacted
      // and stamped 'enforced'. One wake landed an 'observed' row (stating the
      // opposite of what happened) AND an 'enforced' row, so guard_strike
      // counts read 2-3 per strike. It now lives BELOW the citation-enforce
      // block, keyed on the verdict that STANDS — see there.
      if (guarded.struck && actionVerifierEnforce && guarded.rejectBackNotice && !args.isCancelled?.()) {
        await runRejectBackAndSecondPass('all');
      }
      if (guarded.struck && actionVerifierEnforce) {
        finalText = guarded.finalText;
        // Lead the persisted PARTS with the honest notice too (run-executor's
        // evidence-guard idiom): the transcript UI renders parts when present;
        // the streamed original stays quoted below as the audit trail.
        (result.parts = result.parts || [])[guarded.delivery === 'annotated' ? 'push' : 'unshift']({ type: 'text', text: guarded.notice }); // audit 2026-10-08 W1-4: an observe-only annotation trails the note
        actionGuardStruck = true;
        actionGuardCorrection = guarded.correction || '';
        if (guarded.delivery === 'annotated') guardAnnotatedClaimDetails = (guarded.phantoms ?? []).map((p: any) => String(p?.detail ?? ''));
      }
      // (ticket b216475a) DETERMINISTIC citation enforcement — ALWAYS ON,
      // independent of ACTION_VERIFIER_ENFORCE. The 2026-09-11 observe-only
      // flip was driven by message-ACTION false positives (the coin-flip LLM
      // lane); the deterministic citation lanes (msg/sched/session/ticket
      // row-existence + haystack exoneration) and the future-clock lane are
      // false-positive-safe, so they keep their pre-delivery bite even in
      // observe-only mode. A strike that is ALL citation-class
      // (isCitationClassStrike — every conviction isCitationClassClaim, or a
      // pure deterministic future-clock strike with phantoms:[]) is enforced:
      // reject-back (deferConsequences) when the first pass armed it, then the
      // delivered text is the guard's redacted/replaced text. Action-class
      // strikes stay observed-only above.
      if (guarded.struck && !actionVerifierEnforce && isCitationClassStrike(guarded)) {
        // Reject-back (deferConsequences) if the first pass armed it — the
        // SAME extracted flow the enforce branch runs; the second pass re-guards
        // with consequences ON and the enforcement below applies to its verdict.
        // Scope 'citation-only' (ticket f16cc02a): if the standing verdict
        // flips ACTION-class, the F1 re-check below delivers UNMODIFIED — the
        // guard's consequences must not claim a containment that never happens.
        if (guarded.rejectBackNotice && !args.isCancelled?.()) {
          await runRejectBackAndSecondPass('citation-only');
        }
        // (review F1, ticket b216475a) RE-CLASSIFY on the verdict that STANDS:
        // the reject-back second pass reassigns `guarded` to a FULL re-guard of
        // the retry's fresh text — LLM action lane included. Without this
        // re-check, a citation-class first-pass strike whose retry is convicted
        // ACTION-class would be ENFORCED here with ACTION_VERIFIER_ENFORCE
        // unset — silently regressing the 2026-09-11 observe-only flip for the
        // exact false-positive class that motivated it. An action-class (or
        // clean) second-pass verdict falls through to the observed-only path.
        if (guarded.struck && isCitationClassStrike(guarded)) {
          // Deliver the guard's (redacted/replaced) text + correction.
          finalText = guarded.finalText;
          (result.parts = result.parts || [])[guarded.delivery === 'annotated' ? 'push' : 'unshift']({ type: 'text', text: guarded.notice }); // audit 2026-10-08 W1-4: an observe-only annotation trails the note
          actionGuardStruck = true;
          actionGuardCorrection = guarded.correction || '';
          if (guarded.delivery === 'annotated') guardAnnotatedClaimDetails = (guarded.phantoms ?? []).map((p: any) => String(p?.detail ?? ''));
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: chatId,
            stamp: chatMetricStamp,
            meta: {
              guard: 'action-verifier',
              seam: 'machine_wake_citation_enforce',
              // audit 2026-10-08 W1-4: delivered as written + annotation (OWNER_NOTE_NO_EDIT_DISABLED=1 ⇒ 'enforced').
              outcome: guarded.delivery === 'annotated' ? 'annotated' : 'enforced',
              phantoms: guarded.phantoms?.length ?? 0,
              kinds: Array.from(new Set((guarded.phantoms ?? []).map((p: any) => String(p?.kind ?? '')))).filter(Boolean).slice(0, 8),
              ids: (guarded.phantoms ?? []).map((p: any) => String(p?.id ?? '').slice(0, 12)).filter(Boolean).slice(0, 8),
              // (FO firing 58) the excerpts too — every outcome row auditable
              // cold, not just the retry row #1175 covered.
              ...(claimAuditExcerpts(guarded.phantoms ?? []).length ? { struckClaims: claimAuditExcerpts(guarded.phantoms ?? []) } : {}),
              fabricatedIds: (guarded.phantoms ?? []).filter((p: any) => p?.fabricatedId === true).length,
              ...(supervisorScope ? { supervisorScope } : {}),
            },
          });
          // (Fleet 17:14Z incident, 2026-09-15) A MIXED strike's action-class
          // rest was delivered unmodified — record it as observed (its own
          // row, `mixed:true`) so the observe-only telemetry stays complete.
          const observedRest = guarded.observedPhantoms ?? [];
          actionClassObservedClaims = observedRest; // BRIEFING-UNVERIFIED-FILTER: the action-class rest gets the finalize footnote
          if (observedRest.length) {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
              sessionId: chatId,
              stamp: chatMetricStamp,
              meta: {
                guard: 'action-verifier',
                seam: 'machine_wake_reject_back',
                outcome: 'observed',
                mixed: true,
                phantoms: observedRest.length,
                kinds: Array.from(new Set(observedRest.map((p: any) => String(p?.kind ?? '')))).filter(Boolean).slice(0, 8),
                ids: observedRest.map((p: any) => String(p?.id ?? '').slice(0, 12)).filter(Boolean).slice(0, 8),
                // (FO firing 58) the observed-action-class rest too.
                ...(claimAuditExcerpts(observedRest).length ? { struckClaims: claimAuditExcerpts(observedRest) } : {}),
                ...(supervisorScope ? { supervisorScope } : {}),
              },
            });
            logger.info(`chat-agent: mixed strike in ${chatId.slice(0, 8)} — ${guarded.phantoms?.length ?? 0} deterministic conviction(s) enforced, ${observedRest.length} action-class conviction(s) observed only`);
          }
        }
      }
      // Gate flip 2026-09-11 (owner: full steam) — the OBSERVE-ONLY outcome
      // row: an ACTION-class strike's verdict is recorded (seam
      // machine_wake_reject_back, outcome 'observed', phantom kinds/ids) and
      // the note is delivered UNMODIFIED — no line removal, no reject-back
      // re-orchestration (a second ~12-min glm-5.3 turn), no correction row.
      // Evidence: on 2026-09-11 all 9 "phantom" message ids it struck across
      // 3 supervisor notes were REAL lane messages the supervisor had read —
      // its receipt-idiom miner reads "(msg <id>)" citations as send claims.
      // ACTION_VERIFIER_ENFORCE=1 restores the strike + reject-back pipeline.
      //
      // Hardening review 2026-09-14: recorded on the verdict that STANDS
      // (after the citation-enforce block) and only when it is NOT
      // citation-class — a citation-class strike was redacted above and
      // already carries its 'enforced' row. Exactly ONE outcome row per
      // delivered verdict (observed = delivered unmodified, enforced =
      // redacted/replaced), plus the per-cycle reject_back row when a
      // reject-back ran. This also covers the F1 shape (citation-class first
      // pass → reject-back → ACTION-class second pass delivered unmodified),
      // which a first-pass-keyed condition would have left with no outcome
      // row at all.
      if (guarded.struck && !actionVerifierEnforce && !isCitationClassStrike(guarded)) {
        // BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20): the delivered verdict's
        // convictions feed the finalize footnote lane — on a SUPERVISOR wake its id-less claims that locate
        // in the note get ONE trailing observe-only footnote (never a block, never an edit) and are
        // marked / left out of the owner briefing. ACTION_CLASS_ANNOTATE_DISABLED=1 keeps this unmodified.
        actionClassObservedClaims = guarded.phantoms ?? [];
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            guard: 'action-verifier',
            seam: 'machine_wake_reject_back',
            outcome: 'observed',
            phantoms: guarded.phantoms?.length ?? 0,
            kinds: Array.from(new Set((guarded.phantoms ?? []).map((p: any) => String(p?.kind ?? '')))).filter(Boolean).slice(0, 8),
            ids: (guarded.phantoms ?? []).map((p: any) => String(p?.id ?? '').slice(0, 12)).filter(Boolean).slice(0, 8),
            // (FO firing 58, the f58 probe's live finding: the 00:42Z Fleet
            // Supervisor row carried phantoms:1 with NO evidence — #1175
            // covered only the retry path, but with ACTION_VERIFIER_ENFORCE
            // unset THIS row is the majority class). Same cap as the retry row.
            ...(claimAuditExcerpts(guarded.phantoms ?? []).length ? { struckClaims: claimAuditExcerpts(guarded.phantoms ?? []) } : {}),
            ...(clockHitsForMetric(guarded).length ? { clockHits: clockHitsForMetric(guarded) } : {}),
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
        logger.info(`chat-agent: action verifier would have struck ${guarded.phantoms?.length ?? 0} claim(s) in ${chatId.slice(0, 8)} — observed only (ACTION_VERIFIER_ENFORCE unset), note delivered ${isSupervisorChat && !actionClassAnnotateDisabled() ? 'as written (a supervisor note\'s id-less claims get the finalize footnote — BRIEFING-UNVERIFIED-FILTER)' : 'unmodified'}`);
      }
      // STRUCK-NOTE REPEAT outcome (tickets 4c7aebf7 + 9a976d83) — on the text that STANDS: a retry that came back
      // as the same repeat, a retry that produced no usable answer, or a repeat that could not be retried (a run
      // stopped before the retry) is delivered AS WRITTEN with ONE trailing annotation worded for what really
      // happened (round 2, finding 5). Observe-only header: guard-chrome-redact keeps it out of later model context;
      // it is NOT a strike on a later read (round 2, finding 3b — only the original strike propagates). One
      // struck_note_repeat row per machine turn that follows a struck note: 'fresh' (not a repeat — the [PRIOR NOTE
      // STRUCK] block's measure; `reason` says why: below_threshold / numbers_differ / noop / too_short), 'clean'
      // (the retry did the work), 'still_repeat_annotated' / 'retry_failed' / 'annotated_no_retry'; `cycle` = the
      // reject-back's facts (the repeat-only cycle writes no guard_strike row — finding 1).
      // Round 4: one row for EVERY struck prior — 'ineligible' when the prior is spent / screen-claims-only (measured
      // as wouldRepeat, never acted on); a skipped reject-back (repeatSkip — replay-unsafe, the only skip since round 5)
      // is 'annotated_replay_unsafe' when the standing text is still a copy and NO reject-back cycle re-ran the wake, or
      // 'guard_cycle_repeat' when the guard's own reject-back re-ran it anyway (round 5 — the wording says so; a cycle
      // that swapped the text is re-judged, and one that produced new work is 'clean'). Every annotated outcome closes
      // the owner briefing. The delivered row is stamped SPENT (repeatLineageStamp → metadata[REPEAT_LINEAGE_META_KEY])
      // when it is still a copy, or when it copies a spent note: no later copy of that lineage is ever bounced again.
      if (repeatPrior && repeatVerdict) {
        const standing = repeatVerdict.repeat && rejectBackSwapped && repeatTarget ? detectStruckNoteRepeat(finalText, repeatTarget, { isNoop: repeatIsNoop }) : repeatVerdict;
        const ineligible = repeatVerdict.reason === 'prior_repeat_spent' || repeatVerdict.reason === 'prior_screen_claims_only';
        const outcome: 'fresh' | 'ineligible' | 'clean' | RepeatAnnotatedOutcome = !repeatVerdict.repeat ? (ineligible ? 'ineligible' : 'fresh')
          : repeatSkip ? (standing.repeat ? (rejectBackCycle ? 'guard_cycle_repeat' : 'annotated_replay_unsafe') : 'clean')
          : !repeatRetryAttempted ? 'annotated_no_retry'
          : !repeatRetried ? 'retry_failed'
          : standing.repeat ? 'still_repeat_annotated' : 'clean';
        if (repeatVerdict.repeat && standing.repeat && repeatTarget && outcome !== 'fresh' && outcome !== 'ineligible' && outcome !== 'clean') {
          const annotation = renderRepeatAnnotation(standing, repeatTarget, outcome, repeatSkip ? { tool: repeatSkip.tool } : {});
          finalText = `${finalText.replace(/\s+$/, '')}\n\n${annotation}`;
          (result.parts = result.parts || []).push({ type: 'text', text: annotation });
          struckRepeatAnnotated = true;
          struckRepeatBriefingClosed = true;
        }
        struckRepeatLineage = repeatLineageStamp(repeatVerdict, repeatVerdict.repeat && standing.repeat);
        recordLoopMetric({
          kind: STRUCK_NOTE_REPEAT_METRIC, sessionId: chatId, stamp: chatMetricStamp, value: standing.similarity,
          meta: {
            outcome, reason: repeatVerdict.reason, similarity: repeatVerdict.similarity,
            ...(repeatVerdict.wouldRepeat !== undefined ? { wouldRepeat: repeatVerdict.wouldRepeat } : {}),
            ...(standing !== repeatVerdict ? { retrySimilarity: standing.similarity } : {}),
            ...(repeatCycle ? { cycle: repeatCycle } : {}),
            ...(repeatSkip ? { skip: repeatSkip } : {}),
            // Round 5: a skipped repeat whose wake the guard's own reject-back re-ran anyway (did its retry swap the text?)
            ...(repeatSkip && rejectBackCycle ? { guardCycle: rejectBackCycle } : {}),
            ...(struckRepeatLineage ? { lineage: struckRepeatLineage.via } : {}),
            priorMessageId: repeatPrior.id.slice(0, 8), priorStruck: repeatPrior.struck, priorSpent: !!repeatPrior.repeatSpent, struckClaims: repeatPrior.struckClaims.length,
            priorBlock: !priorNoteStruckBlockDisabled(),
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
        if (repeatVerdict.repeat) logger.info(`chat-agent: struck-note repeat on ${chatId.slice(0, 8)} — ${outcome} (similarity ${repeatVerdict.similarity}${standing !== repeatVerdict ? ` → ${standing.similarity} after the reject-back` : ''})`, { source: 'chat-agent' });
      }
      // build 2026-10-08 F-2 — finish_run SHADOW agreement: the typed finish verdict (coding/finish-run.ts) vs the
      // action verifier's STANDING verdict on the SAME delivered note. Telemetry only; never touches the note.
      if (result.finishRun) {
        const allPhantoms = [...(guarded.phantoms ?? []), ...(guarded.observedPhantoms ?? [])] as any[];
        recordLoopMetric({
          kind: FINISH_RUN_AGREEMENT_METRIC, sessionId: chatId, stamp: chatMetricStamp,
          meta: finishRunAgreementMeta(result.finishRun, {
            detector: 'action_verifier',
            convicted: !!guarded.struck || allPhantoms.length > 0,
            kinds: Array.from(new Set(allPhantoms.map((p) => String(p?.kind ?? '')))).filter(Boolean),
            extra: { futureClocks: guarded.futureClocks?.length ?? 0, ...(supervisorScope ? { supervisorScope } : {}) },
          }),
        });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: pre-delivery action guard failed (non-fatal — original note kept): ${err?.message}`, { source: 'chat-agent' });
    }
  }

  // ── COMPUTER_TASK CLAIM CHECK (related to ticket 4c7aebf7 (c), 2026-10-21 — chat-agent/computer-task-claims.ts) ──
  // The 17:12:19Z note on chat e03452f4 said it drove the owner's Mac via computer_task ("applied the ACL edit … and
  // clicked Save") while the run's computer_task was OBSERVE-ONLY (owner active ⇒ a machine run is camera-only) — the
  // owner, watching the Mac, saw zero cursor movement. On a supervisor-class MACHINE note the check asks: do its
  // first-person on-screen INPUT claims have a computer_task result of this run that could act (no call at all with
  // the device named, or every call observe-only / busy / unavailable / never started ⇒ unbacked)?
  // Round 4 (both round-3 reviews NOT_MERGE_SAFE — the false-positive rate on real supervisor prose is unmeasured):
  // OBSERVE-ONLY BY DEFAULT — ONE loop_metrics row per non-empty verdict (kind computer_task_claim: the reason class
  // and counts, never note text) and NOTHING else: no annotation, no strike, no [PRIOR NOTE STRUCK] feed, no delivery
  // change, no briefing change. COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 is the opt-in that restores the round-3
  // annotation (ONE trailing observe-only paragraph naming the claims + a guard_strike row; a [PRIOR NOTE STRUCK]
  // strike, never a repeat; the owner briefing stays open and marks the `- [screen input]` lines "(unverified)" —
  // closed only when BRIEFING_UNVERIFIED_FILTER_DISABLED=1 leaves no filter to mark them). Never a block, never a
  // reject-back, no ticket, no correction row; human turns and plain chats untouched; judged on the text that STANDS
  // (a replaced / redacted note is not judged again), against EVERY attempt's tool calls (a reject-back retry's swap
  // keeps the superseded parts). Fail-open. Kill switch COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 (no check, no row).
  let computerClaimAnnotated = false;
  if (isSupervisorChat && machineTriggeredRun && userId && chatId && !computerTaskClaimCheckDisabled()) {
    try {
      const verdict = checkComputerTaskClaims(finalText, [...rejectBackSupersededParts, ...((result.parts ?? []) as unknown[])]);
      if (verdict.unbacked && !computerTaskClaimAnnotateEnabled()) {
        logger.info(`chat-agent: computer_task claim check — ${verdict.claims.length} on-screen input claim(s) in ${chatId.slice(0, 8)}'s machine note with no computer_task result that could act (${verdict.reason}) — observe-only, note untouched`, { source: 'chat-agent' });
      }
      if (verdict.unbacked && computerTaskClaimAnnotateEnabled()) {
        const annotation = renderComputerTaskClaimAnnotation(verdict);
        finalText = `${finalText.replace(/\s+$/, '')}\n\n${annotation}`;
        (result.parts = result.parts || []).push({ type: 'text', text: annotation });
        computerClaimAnnotated = true;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            guard: 'computer-task-claims',
            seam: COMPUTER_TASK_CLAIM_SEAM,
            outcome: 'annotated',
            strike: COMPUTER_TASK_CLAIM_STRIKE,
            reason: verdict.reason,
            claims: verdict.claims.length,
            calls: Object.fromEntries(Object.entries(verdict.calls).filter(([, n]) => n > 0)),
            excerpts: verdict.claims.slice(0, 4).map((c) => ({ phrase: c.phrase, sentence: c.sentence.slice(0, 164) })),
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
        logger.info(`chat-agent: computer_task claim check — ${verdict.claims.length} on-screen input claim(s) in ${chatId.slice(0, 8)}'s machine note with no computer_task result that could act (${verdict.reason}) — annotated, delivered as written`, { source: 'chat-agent' });
      }
      // The shadow measure (round 4): one counts-only row per non-empty verdict, whatever the mode.
      if (computerTaskClaimRowWorthy(verdict)) {
        recordLoopMetric({
          kind: COMPUTER_TASK_CLAIM_METRIC, // ≡ LOOP_METRIC_KINDS.COMPUTER_TASK_CLAIM (pinned by the leaf test)
          sessionId: chatId,
          stamp: chatMetricStamp,
          value: verdict.claims.length,
          meta: { ...computerTaskClaimMetricMeta(verdict, { annotated: computerClaimAnnotated }), ...(supervisorScope ? { supervisorScope } : {}) },
        });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: computer_task claim check failed (non-fatal — note kept unchanged): ${err?.message}`, { source: 'chat-agent' });
    }
  }

  // ── PRODUCTION-STATE UNREAD lane (supervisor doctrine audit D1, 2026-09-27)
  // — OBSERVE-ONLY. A supervisor's serving / deployed / running / banked
  // sentence whose facts appear in NONE of this run's grounding reads (a
  // production build named from memory with no lane read on the chat for two
  // weeks — supervisor chats have no shell; a box fact reaches them only
  // through a lane's message / receipt read this wake)
  // mints ONE guard_strike row (seam machine_wake_production_state, outcome
  // observed, strike production_state_unread) and the note is delivered
  // UNMODIFIED — no redaction, no reject-back, no ticket, no correction row
  // (the 2026-09-11 gate flip: telemetry + doctrine, never a withhold on a
  // machine lane's own work). Runs on the text that STANDS after the guard
  // (a guard replacement's quoted note is '> '-prefixed and skipped by the
  // miner). Independent of the guard's verdict and its own try/catch: a
  // failure here never touches the note. Supervisor seats only (the owner-
  // facing surface the incident was on). The kill switch was retired
  // 2026-10-30 — the matcher is unconditional now.
  if (isSupervisorChat && machineTriggeredRun && userId && chatId) {
    try {
      const { findUnreadProductionStateClaims, PRODUCTION_STATE_STRIKE, PRODUCTION_STATE_SEAM } = await import('../platform/action-verifier');
      const hits = findUnreadProductionStateClaims(finalText, {
        parts: (result.parts || []) as any[],
        receipts: (result.receipts ?? []) as any[],
        // A get_chat_messages read of THIS chat re-reads the supervisor's own
        // prior notes — the surface the confabulation came from; it grounds nothing.
        selfChatId: chatId,
      });
      if (hits.length) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            guard: 'action-verifier',
            seam: PRODUCTION_STATE_SEAM,
            outcome: 'observed',
            strike: PRODUCTION_STATE_STRIKE,
            hits: hits.length,
            reasons: Array.from(new Set(hits.map((h) => h.reason))),
            sentences: hits.slice(0, 4).map((h) => ({ sentence: h.sentence.slice(0, 164), factTokens: h.factTokens.slice(0, 6) })),
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
        logger.info(`chat-agent: production-state lane — ${hits.length} serving/deployed/banked sentence(s) in ${chatId.slice(0, 8)} rest on nothing this run read — observed only, note delivered unmodified`);
      }
    } catch (err: any) {
      logger.warn(`chat-agent: production-state lane failed (non-fatal — note kept unchanged): ${err?.message}`, { source: 'chat-agent' });
    }
  }

  // ── Claims-with-receipts lane — SUPERVISOR chat runs (owner 2026-09-03) ────
  // The coding run-executor composes applyClaimsBlockLane over the evidence
  // guard at finalize; supervisor chat runs get the SAME typed-claims contract:
  // a fenced ```claims block in the final note is verified against the run's
  // harness tool receipts (result.receipts — the same source the action
  // verifier above consumes). Fully verified → the positive note; unverified
  // entries → the conviction note, appended before anything persists.
  // Supervisor-only for now; owner-typed turns are identity by the lane's own
  // contract (triggerKind 'user'); a guard STRIKE stands down here (the struck
  // replacement is harness text — no claims block to verify, and the strike
  // already ticketed/refuted). Fail-open: any error keeps the text unchanged.
  let claimsLaneAnnotated = false;
  if (isSupervisorChat && userId && chatId && !actionGuardStruck) {
    try {
      const { applyClaimsBlockLane, parseClaimsBlock } = await import('../coding/run-evidence-guard');
      const triggerKind: 'user' | 'schedule' | 'hook' | 'machine' =
        args.messageOrigin === 'schedule' ? 'schedule'
        : args.messageOrigin === 'hook' ? 'hook'
        : (args.machineWake || machineOriginRun(args)) ? 'machine'
        : 'user';
      // Ticket ed728b87 (2026-10-27): scope:session/relayed fence entries
      // re-match against this chat's receipt history (the get_run_receipts
      // pool) before a miss convicts. One read per wake WITH a fence — the
      // swallowing variant (fail-open: an unread pool verifies nothing, never
      // convicts more); empty ⇒ pre-ed728b87 behavior byte for byte. The
      // parser presence check keeps partially-mocked module shapes (tests) on
      // the pre-ed728b87 path instead of throwing inside the guard.
      let carriedReceipts: any[] = [];
      if (triggerKind !== 'user' && typeof parseClaimsBlock === 'function' && parseClaimsBlock(finalText).present) {
        try {
          const { getRecentChatReceipts } = await import('../coding/run-receipts.service');
          carriedReceipts = await getRecentChatReceipts(chatId);
        } catch (err: any) {
          logger.warn(`chat-agent: supervisor claims lane carried-receipt read failed (non-fatal — this-run receipts only): ${err?.message}`, { source: 'chat-agent' });
        }
      }
      const composed = await applyClaimsBlockLane({
        originalText: finalText,
        guarded: { finalText, notes: [], verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] } },
        receipts: (result.receipts ?? []) as any[],
        triggerKind,
        ...(carriedReceipts.length ? { carriedReceipts } : {}),
      });
      if (composed.finalText !== finalText) {
        finalText = composed.finalText;
        claimsLaneAnnotated = true;
        // The transcript UI renders parts when present — carry the lane's
        // harness notes there too (guard-chrome persists byte-identical via
        // the isGuardChromeText exemption below).
        if (composed.notes.length) (result.parts = result.parts || []).push({ type: 'text', text: composed.notes.join('\n\n') });
        logger.info(`chat-agent: supervisor claims lane annotated the final note (${composed.lane.verified.length} verified / ${composed.lane.unverified.length} unverified claim(s))`, { source: 'chat-agent' });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: supervisor claims lane failed (non-fatal — note kept unchanged): ${err?.message}`, { source: 'chat-agent' });
    }
  }

  // ── Deferred-action receipts — SUPERVISOR machine wakes (remediation P2
  // spark G8, the 2026-09-08 ~21:00Z incident): a note that DEFERS an action
  // ("the swap runs next wake") while the run armed NO schedule and messaged
  // NO lane is a commitment living only in prose — prose gets compacted away
  // and the action never runs. The harness auto-arms a bounded one-shot
  // self-schedule (+15 min, the schedule floor) quoting the deferred line,
  // and says so in the final note. Guard-struck notes stand down (the
  // replacement is harness chrome, not the model's commitments). Best-effort:
  // any failure keeps the note unchanged. Kill-switch:
  // DEFERRED_ACTION_RECEIPTS_DISABLED=1 (checked inside the detector).
  //
  // Gate flip 2026-09-11 (owner: full steam): OBSERVE-ONLY — the detector
  // still runs, but the harness NO LONGER auto-arms the +15 min one-shot
  // self-schedule. Evidence: 67 auto-armed schedules on 4 supervisor chats in
  // two days (~+16% supervisor wakes, each a full unmetered tool loop); of 57
  // fired follow-ups 20 STOOD DOWN, 11 no-action, 12 re-armed ANOTHER follow-up
  // (self-perpetuating — prior stand-down text re-tripped the idiom regex), a
  // bare '## Next (my next wake)' header tripped it, and at most 2/57 did
  // anything otherwise lost. Now: one `supervisor_deferral_unarmed` loop
  // metric + a one-line non-blocking transcript note naming the deferral. No
  // opt-in env re-arms this path (plan action observe_only) — restoring the
  // auto-arm is a code revert, and if ever restored DEFERRAL_IDIOM_RE must
  // first skip 'STANDING DOWN'/'executed'/'RESOLVED' lines and bare headers.
  if (isSupervisorChat && args.machineWake === true && userId && chatId && !actionGuardStruck) {
    try {
      const { detectUnarmedDeferral, deferralNotePrecisionDisabled, findDeferralClause } = await import('./deferred-actions');
      const detected = detectUnarmedDeferral(finalText, result.parts);
      // Ticket fcee0741: a deferral line that cites a schedule id ("Next sweep: 21:47Z (schedule 53f68b62)") is
      // armed by the citation. Resolve it against THIS chat's own schedules (one sessionId-scoped read): a cited
      // own row that is DISABLED arms nothing — the line is the unarmed deferral after all; an enabled own row or
      // an id this chat does not own (a lane's schedule) is accepted. Telemetry: supervisor_deferral_covered
      // {by:'cited_schedule', resolved}. Kill switch DEFERRAL_CADENCE_EXEMPT_DISABLED=1 (the detector never cites).
      let verdict = detected;
      if (!detected.deferralLine && detected.citedLine && detected.citedScheduleIds?.length) {
        let resolved: 'own' | 'own_disabled' | 'unresolved' = 'unresolved';
        try {
          const own: Array<{ id: string; enabled: boolean }> = await prisma.chatSchedule.findMany({
            where: { sessionId: chatId, OR: detected.citedScheduleIds.map((id) => ({ id: { startsWith: id } })) },
            select: { id: true, enabled: true },
            take: 10,
          });
          if (own.some((r) => r.enabled)) resolved = 'own';
          else if (own.length) resolved = 'own_disabled';
        } catch { /* unknown ⇒ accept the citation */ }
        if (resolved === 'own_disabled') {
          verdict = { deferralLine: detected.citedLine, deferralClause: findDeferralClause(detected.citedLine) };
        } else {
          recordLoopMetric({ kind: 'supervisor_deferral_covered', sessionId: chatId, meta: { line: detected.citedLine.slice(0, 120), by: 'cited_schedule', resolved, scheduleIds: detected.citedScheduleIds } });
        }
      }
      // audit 2026-10-06 T8-9: an enabled RECURRING schedule on this chat is an armed follow-up (its next firing
      // wakes the chat) — telemetry only, no note; the note quotes the deferral CLAUSE, not the line head.
      // DEFERRAL_NOTE_PRECISION_DISABLED=1 restores the previous note.
      const precise = !!verdict.deferralLine && !deferralNotePrecisionDisabled();
      let recurringArmed = false;
      if (precise) {
        try { recurringArmed = (await prisma.chatSchedule.count({ where: { sessionId: chatId, enabled: true, kind: 'recurring' } })) > 0; } catch { /* unknown ⇒ unarmed (the previous note) */ }
      }
      if (verdict.deferralLine && recurringArmed) {
        recordLoopMetric({ kind: 'supervisor_deferral_covered', sessionId: chatId, meta: { line: (verdict.deferralClause ?? verdict.deferralLine).slice(0, 120), by: 'recurring_schedule' } });
      } else if (verdict.deferralLine) {
        const clipped = (precise ? verdict.deferralClause ?? verdict.deferralLine : verdict.deferralLine).slice(0, 120);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SUPERVISOR_DEFERRAL_UNARMED,
          sessionId: chatId,
          meta: { line: clipped },
        });
        // Leading '[' so a verbatim echo of this note is harness chrome to the
        // detector (findDeferralLine skips bracketed lines) — it must never
        // become the next wake's "deferral".
        const observeNote = `\n\n[harness — deferred-action note] This note defers an action ("${clipped}") but armed no schedule and messaged no lane. Recorded as telemetry only — the harness no longer auto-arms a follow-up (owner 2026-09-11); arm a schedule_message yourself if it genuinely must wait.`;
        finalText += observeNote;
        (result.parts = result.parts || []).push({ type: 'text', text: observeNote.trim() });
        logger.info(`chat-agent: unarmed deferral observed on supervisor ${chatId.slice(0, 8)} (spark G8, observe-only since 2026-09-11)`, { source: 'chat-agent' });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: deferred-action observe seam failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }

  const savedCanvasIds = await persistAndEmitCanvases({ userId, chatId, parsedCanvases, sendEvent: send });
  // (compute policy 2026-09-26) the 'followups' event moved AFTER the assistant
  // persist below: the Dig-deeper chip needs the persisted row id.

  // Key the answer card by the ORCHESTRATOR's real slot — NOT the legacy
  // hard-coded 'glm' holdover from when GLM-5.2 orchestrated. With Kimi K3
  // orchestrating and GLM-5.2 cross-checking, a 'glm' answer card collided
  // with the checker's live card in the same slot and the UI labeled the
  // whole answer "GLM-5.2" (owner report 2026-08-15).
  // Owner 2026-09-15: the answer card is the DIGBY seat's card ('digby'), whatever
  // model occupies the seat — the More-info panel labels by seat and shows the
  // served model id on the card.
  const answerKey = SEAT_CARD_KEYS.lead;
  if (orchestratorEmpty) {
    // Never silent again (feedback 5f22a689): an empty finalization gets a
    // warn log AND an error-stamped card, so the More-info panel explains the
    // blank answer instead of rendering nothing.
    logger.warn(`chat-agent: orchestrator ${orchestratorModel} finalized EMPTY (mode=${mode}, ${Date.now() - orchestratorT0}ms) — persisting the fallback with an error-stamped card`, { source: 'chat-agent' });
  }
  models[answerKey] = {
    model: answerKey, response: finalText, time: Date.now() - orchestratorT0,
    persona: SEAT_LABELS.lead,
    // Honest per-run flag: true iff the orchestrator actually fired a web tool
    // (the forced-SERP OR-in is gone — owner 2026-09-03).
    modelUsed: orchestratorModel, webSearchUsed: adapter.webSearchUsed,
    ...(orchestratorEmpty ? { error: `${orchestratorModel} returned no output (provider refusal or empty completion)` } : {}),
  };

  // Grounding telemetry (owner 2026-09-03 search-force removal): one
  // fire-and-forget row per chat run — recordLoopMetric never throws or blocks.
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.CHAT_SEARCH_USAGE,
    sessionId: runSessionId,
    stamp: chatMetricStamp,
    // machine flag (owner review 2026-09-06): the thinking-mode bucket is
    // dominated by machine wakes (fleet-state work that legitimately skips
    // search) — grounding rate is only readable segmented by origin.
    meta: {
      mode,
      webToolCalls: countWebToolCalls(result.parts),
      machine: args.machineWake === true || machineOriginRun(args),
    },
  });
  // roster 2026-10-06 C-4: what a Quick run did with the web — every Quick answer, whatever the budget's mode — so the
  // lane's tool discipline (and the budget's effect) is measurable: calls by class, refusals / would-refusals.
  if (quickLaneModel && !runIsMachineTriggered) {
    const cap = (result as { webToolCap?: { search: number; fetch: number; refused: number; wouldRefuse: number; mode: string } }).webToolCap;
    recordLoopMetric({
      kind: 'quick_lane_tools',
      sessionId: runSessionId,
      stamp: chatMetricStamp,
      value: countWebToolCalls(result.parts),
      meta: {
        model: orchestratorModel, webToolCalls: countWebToolCalls(result.parts),
        toolCalls: Array.isArray(result.parts) ? result.parts.filter((p: any) => p?.type === 'tool_call').length : 0,
        budget: cap ? cap.mode : 'off', ...(quickWebCapCanary ? { canary: true } : {}),
        ...(cap ? { search: cap.search, fetch: cap.fetch, refused: cap.refused, wouldRefuse: cap.wouldRefuse } : {}),
        thinkingOff: true,
      },
    });
  }
  // Phantom web-failure claim (ticket 1ef71188): the answer narrated a web
  // attempt "just now" failing while the run's parts show no web tool call
  // backed it (the originating incident's own ordering is unprovable — its
  // run made 2 web_pipe calls and guests persist no per-part rows; what the
  // incident proved is the search backend was healthy and the user was told
  // otherwise). Telemetry only — the detector (chat-agent/phantom-tool-claim.ts)
  // is precision-gated to the fabricated shape and a mid-turn claim can
  // self-correct within the turn, so this records, never blocks. Pure +
  // try/catch-guarded (fire-and-forget telemetry can never break the
  // finalize path).
  {
    const phantomWebClaim = findUnbackedWebFailureClaim({ parts: result.parts, finalText });
    if (phantomWebClaim) {
      logger.warn(`chat-agent: unbacked web-failure claim in the final answer (${phantomWebClaim.tier}${phantomWebClaim.selfCorrected ? ', self-corrected later in the run' : ''}): "${phantomWebClaim.excerpt}" — recorded as ${LOOP_METRIC_KINDS.CHAT_PHANTOM_WEB_CLAIM}`, { source: 'chat-agent' });
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.CHAT_PHANTOM_WEB_CLAIM,
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: {
          mode,
          tier: phantomWebClaim.tier,
          selfCorrected: phantomWebClaim.selfCorrected === true,
          excerpt: phantomWebClaim.excerpt,
          machine: args.machineWake === true || machineOriginRun(args),
        },
      });
    }
  }
  // Hand-back lint (cohesive-chat program, rule task.lifecycle): a HUMAN turn's
  // final that ends by handing the asked work back as a question ("say the
  // word and I will search her thread next" after the deadline cut the run;
  // "confirm the card" on a staged start_coding_session) while work evidently
  // remains. OBSERVE-ONLY: one loop_metrics handback_detected row — nothing
  // is rewritten or blocked (the continuation branch's turn-continuation.ts
  // decides from its OWN classifier whether the run keeps going). A staged
  // EXTERNAL-EFFECT card (share link, cross-chat message, autonomy grant) is
  // the doctrine's third lifecycle state, so "confirm it from the card" on
  // such a run is not a hand-back; the tool-round signal is the loop's REAL
  // step count (result.stepsUsed), never a burst estimate from parts. Machine
  // wakes are out of scope (a wake's hand-back is the deferred-action seam
  // above). Pure + try/catch-guarded.
  const humanTurn = !(args.machineWake === true || machineOriginRun(args));
  if (humanTurn) {
    const handback = findHandback({
      finalText,
      parts: result.parts,
      deadlineHit: (result as { deadlineHit?: boolean })?.deadlineHit === true,
      stepsUsed: (result as { stepsUsed?: number })?.stepsUsed,
      maxSteps: profile.maxSteps,
    });
    if (handback) {
      logger.info(`chat-agent: hand-back detected on a human turn (${handback.strength}: "${handback.phrase}"${handback.stoppedShort.deadlineHit ? ', deadline hit' : ''}${handback.stoppedShort.stepsExhausted ? ', tool rounds exhausted' : ''}${handback.stoppedShort.stagedCard ? ', staged card' : ''}) — recorded as telemetry (rule task.lifecycle)`, { source: 'chat-agent' });
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.HANDBACK_DETECTED,
        sessionId: runSessionId,
        stamp: chatMetricStamp,
        meta: {
          chatId: chatId ?? null,
          phrase: handback.phrase,
          strength: handback.strength,
          excerpt: handback.excerpt,
          deadlineHit: handback.stoppedShort.deadlineHit,
          stepsExhausted: handback.stoppedShort.stepsExhausted,
          stagedCard: handback.stoppedShort.stagedCard,
          externalCard: handback.externalCard,
          continuationCue: handback.continuationCue,
          mode,
          supervisor: isSupervisorChat === true,
        },
      });
    }
  }
  // Compute policy (review 2026-09-26 M4): in SHADOW / OFF the plan ask never
  // sat on the request path — the preset ran. Attach the gate's answer
  // (decisionId / answers / mode / shadow source) here, bounded by
  // PLAN_LABEL_ATTACH_MS, so the decision still gets its labels (escalated /
  // reask / thumbs) on this row's metadata.depth and the compute_policy row.
  // The tuple that RAN is never rewritten after the fact.
  // Roster 2026-10-06: a lane-governed plan (source turn_plan / lane_fail_open) keeps its source but still carries the
  // compute_policy decision identity for its labels.
  if (planPromise && (plan.source === 'preset' || plan.source === 'turn_plan' || plan.source === 'lane_fail_open')) {
    const late = await Promise.race([
      planPromise,
      new Promise<null>(res => setTimeout(() => res(null), PLAN_LABEL_ATTACH_MS).unref()),
    ]).catch(() => null);
    if (late && typeof late === 'object' && late.decisionId) {
      plan = {
        ...plan,
        decisionId: late.decisionId,
        ...(late.answers ? { answers: late.answers } : {}),
        // The gate's stash + segment ride too (audit 2026-09-26 telemetry-readiness-5 / -9): the
        // facts row / persisted compact decision used to read backend 'unknown' in shadow, and the
        // finalize `facts` label stamps meta.segment on the SHADOW path too (the common case today).
        ...(late.stash ? { stash: late.stash } : {}),
        ...(late.segment ? { segment: late.segment } : {}),
        mode: late.mode,
        ...(late.source === 'gate_shadow' && plan.source === 'preset' ? { source: 'gate_shadow' as const, reason: late.reason } : {}),
      };
    }
  }
  // Compute policy telemetry (2026-09-26): ONE 'compute_policy' row per turn
  // (the plan that ran, its source and budget — since the owner's 2026-09-26
  // "all chats Auto" directive machine wakes and supervisor turns write it too,
  // stamped machine + segment for the per-segment plan / TTFT read; the
  // readiness ruler does NOT read this kind — it partitions on the
  // meta.segment the decision_gate rows carry, see the compute-plan block) and
  // ONE 'ux_ttft' row per non-machine turn — the TTFT baseline the design's
  // every later claim needs (§5 step 0). Fire-and-forget.
  // The row itself is written by Module A (platform/compute-policy-gate.ts
  // recordComputePolicyTelemetry — the ONE writer of kind 'compute_policy');
  // the harness adds what only it knows: guest / machine / segment, the
  // escalation rung, the pill.
  // Telemetry honesty (audit 2026-09-26 supervisors-auto-4): a machine row
  // carries the effort the lead was actually sent (`leadEffortSent` — the
  // wake_effort act value when the seat takes the param, else the plan's)
  // and, fail-open and bounded, the caps that DO govern it (`caps`: daily
  // firings + the user-set PROJECT spend cap, or null). The former
  // `budgetEnforced: false` stamp died with the USD rail (2026-09-27 — no
  // cost caps).
  const enforcementStamp = computePolicyEnforcementStamp({
    machine: runIsMachineTriggered, supervisor: isSupervisorChat, council: isCouncilMode,
    leadEffortSent: wakeEffortActEffort && effortProviderExtra(orchestratorModel, wakeEffortActEffort).providerExtra ? wakeEffortActEffort : plan.leadEffort,
  });
  const machineCaps = runIsMachineTriggered && chatId
    ? await readMachineCaps(chatId).catch(() => null)
    : null;
  recordComputePolicyTelemetry(plan, {
    sessionId: runSessionId, stamp: chatMetricStamp, budget,
    ...(firstChunkAt ? { ttftMs: firstChunkAt - startedAt } : {}), completionMs: Date.now() - startedAt,
    extra: {
      guest: !userId, machine: runIsMachineTriggered, segment: planSegment,
      ...(args.escalation ? { escalationRung: args.escalation.rung } : {}), ...(checkState ? { check: checkState.state } : {}),
      ...enforcementStamp, ...(machineCaps ? { caps: machineCaps } : {}),
      // The bound this turn's background job ACTUALLY ran under (audit
      // 2026-09-26 — budget.maxBackgroundMs alone recorded a number nothing
      // applied): the lead deadline on a background council, else the
      // checker's harness kill; `backgroundTimeout` when it fired — the
      // Double Checker card carries the deadline error, or a background
      // council outlived its lead bound (harness-measured; the late
      // reconcile's own timeout lands on its crosscheck_late_reconcile row).
      backgroundBoundMs: isBackgroundCouncil ? (Number.isFinite(councilLeadBound.ms) ? councilLeadBound.ms : null) : checkerHardMs,
      backgroundBoundSource: isBackgroundCouncil ? councilLeadBound.source : checkerBound.source,
      ...((String(models[SEAT_CARD_KEYS.double]?.error ?? '').startsWith('cross-check deadline') || (isBackgroundCouncil && Date.now() - startedAt > councilLeadBound.ms)) ? { backgroundTimeout: true } : {}),
    },
  });
  // P3 (2026-10-05): hoisted out of the block below — the message-side turnPlan record
  // now carries the same synthetic flag. Machine-guarded (machine turns write no UX_TTFT
  // row and no turn-plan labels) and memoized inside isBenchAccountUser, so the hoist
  // costs a machine finalize nothing.
  // The turn's completion instant — taken before the (bounded) turn-plan await below so completionMs never absorbs it.
  const turnCompletedAt = Date.now();
  const isBenchUser = runIsMachineTriggered ? false : await isBenchAccountUser(userId);
  // Dynamic roster (2026-10-03): the turn plan this answer was planned under —
  // already in by now in practice (fired before the context load); bounded so a
  // hung ask never holds the finalize. Persisted on metadata.depth.turnPlan for
  // the Dig-deeper / re-ask / thumbs / window-close labels. (audit 2026-10-08 W4-1b:
  // resolved BEFORE the ux_ttft row so that row is keyed by the turn plan's lane.)
  const turnPlanFinal: TurnPlan | null = turnPlan ?? (turnPlanPromise
    ? await Promise.race([turnPlanPromise, new Promise<null>(res => setTimeout(() => res(null), 1500).unref())]).catch(() => null)
    : null);
  if (!runIsMachineTriggered) {
    // audit 2026-10-08 W4-1b: EVERY human turn's row carries the lane the model pick evaluates (platform/lane-depth.ts
    // ttftLaneStamp) + what ran — before, only canary / Quick / research turns did and the pick's prod latency starved.
    const ttftLane = ttftLaneStamp(plan, turnPlanFinal);
    // P1.1 (owner handoff 2026-10-05): bench-account rows are synthetic, never prod latency
    // evidence. Stamped at write so the reader (platform/model-evidence.ts loadFresh) can
    // exclude them — and by account in SQL for rows written before this flag existed.
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.UX_TTFT, sessionId: runSessionId, stamp: chatMetricStamp,
      value: firstChunkAt ? firstChunkAt - startedAt : undefined, unit: 'ms',
      // leadModel on EVERY row (2026-10-04): the per-turn model pick's prod latency evidence (platform/model-evidence.ts).
      // webToolCalls (roster 2026-10-06 C-2): the tool-aware latency evidence (platform/model-evidence.ts V2).
      // taskKind (2026-10-20, task-aware pick): the turn's USABLE job type (platform/task-kind.ts) or null — the prod
      // rows a per-(model, kind) readout groups on.
      meta: { mode, preset: plan.preset, leadModel: orchestratorModel, webToolCalls: countWebToolCalls(result.parts), ...(ttftLane.laneSource === 'legacy' ? (plan.lane ? { lane: plan.lane } : {}) : ttftLane), ...(pickedLeadModel ? { modelPicked: true } : {}), ...(leadEffortAbArm ? { effortArm: leadEffortAbArm } : {}), ...(firstChunkAt ? { ttftMs: firstChunkAt - startedAt } : { noChunk: true }), completionMs: turnCompletedAt - startedAt, guest: !userId, taskKind: turnPlanFinal?.taskKind?.usable ? turnPlanFinal.taskKind.kind : null, ...(isBenchUser ? { synthetic: true } : {}) },
    });
  }
  // roster 2026-10-06 B-1: the record says what RAN — `modelPick.act` = the pick led this run
  // (pickedLeadModel), `wouldAct` = the plan's verdict, `ran` = lane / lead / checker /
  // colleagues that actually ran (the lead after any vision swap or seat fallback; the Double
  // Checker seat only when it spawned; council colleagues that produced a card). The label
  // writer's counterfactual rule reads `ran.lane`. TURN_PLAN_APPLIED_STAMP_DISABLED=1 ⇒ the
  // would-act record (turnPlanMetadata ignores `applied`).
  const turnPlanApplied = turnPlanFinal ? {
    pickApplied: !!pickedLeadModel,
    ran: ranRosterOf({
      quick: !!quickLaneModel, council: isCouncilMode, checkerSpawned: spawnChecker,
      lead: orchestratorModel,
      checker: (models[SEAT_CARD_KEYS.double] as any)?.modelUsed ?? crossCheckers[0] ?? null,
      colleagues: [SEAT_CARD_KEYS.double, SEAT_CARD_KEYS.triple].map(k => (models[k] as any)?.modelUsed),
    }),
  } : null;
  const turnPlanMeta = runIsMachineTriggered ? null : turnPlanMetadata(turnPlanFinal ? { ...turnPlanFinal, act: !!quickLaneModel } : null, turnPlanApplied);
  // P3 (2026-10-05): same synthetic flag as the UX_TTFT row — the turn_plan label
  // reader (turn-plan-labels.ts labelTurnPlan) excludes these rows from fit so
  // bench/e2e answers can never move turn_plan's act-band/auto-demote evidence.
  // Spread AFTER turnPlanMetadata(): it whitelists fields, so an input-side
  // synthetic field would be silently dropped. Runs on the same memoized
  // isBenchAccountUser probe as P1.1.
  // roster 2026-10-06 B-1: a supervisor-chat record (asked only under TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1) is stamped
  // supervisor:true — its labels are written excludeFromFit (turn-plan-labels.ts).
  const turnPlanMetaStamped = turnPlanMeta && (isBenchUser || isSupervisorChat)
    ? { ...turnPlanMeta, ...(isBenchUser ? { synthetic: true } : {}), ...(isSupervisorChat ? { supervisor: true } : {}) }
    : turnPlanMeta;
  // Roster 2026-10-06 (Team A): ONE `lane_depth` row per eligible human turn — the turn plan's lane, the checker /
  // research decision it implies (recorded in every mode: the readiness evidence for widening the act flags), what
  // acted and what RAN. Telemetry only; never throws.
  if (laneTurn) {
    try {
      recordLoopMetric({
        kind: LANE_DEPTH_METRIC, sessionId: runSessionId, stamp: chatMetricStamp,
        meta: {
          ...laneDepthRowMeta({
            access: laneAccess, turnPlan: turnPlanFinal, decision: laneDecision, ranPlan: plan, ranChecker: spawnChecker,
            checkerModel: spawnChecker ? crossCheckers[0] : null, segment: planSegment,
            routedLevel: args.routing?.level ?? null, keywordReasonKey: args.routing?.reasonKey ?? null,
            researchRouted: args.routing?.source === 'turn_plan', priorLane: laneDecision ? lanePriorUsed : laneSessionLane(),
          }),
          ...(isBenchUser ? { synthetic: true } : {}),
        },
      });
    } catch { /* telemetry never breaks a turn */ }
  }
  // Compute policy `facts` (cp/labels 2026-09-26, design §4 D2): what THIS
  // turn measurably did — the checker-route vocabulary (lead tool rounds, web
  // calls, final length, checker spawned / merged). Persisted on
  // metadata.depth.facts (the later reask / thumbs / late-tap labels derive
  // the same depth actual from it) and written as the decision's finalize
  // row after the assistant row persists below. Never on machine turns.
  const computePolicyFacts: ComputePolicyTurnFacts | null = runIsMachineTriggered ? null : {
    leadToolCalls: Array.isArray(result.parts) ? result.parts.filter((p: any) => p?.type === 'tool_call').length : 0,
    webToolCalls: countWebToolCalls(result.parts),
    finalChars: finalText.length,
    checkerSpawned: spawnChecker,
    checkerMerged: crossCheckMerged,
    // The reasoning_effort the checker ACTUALLY received (audit 2026-09-26 budgets-cost-2).
    ...(spawnChecker ? { checkerEffortSent: checkerEffort } : {}),
    // H2: the research rung's lead reached its DepthBudget-derived deadline (coding/agent.ts
    // result.deadlineHit) — stamped only when the budget actually bounded this run, so the
    // row never claims a bound it did not run under.
    ...(rungDeadlineArmed && isCouncil && (result as { deadlineHit?: boolean })?.deadlineHit ? { backgroundDeadlineHit: true } : {}),
  };
  // Platform-usage telemetry (2026-09-08 agentic expansion): did the run USE
  // the platform the capability playbook teaches (schedules, memory, feeds,
  // knowledge base, canvases, projects, fleet…), and did it OFFER a next step
  // (action chips among the follow-ups)? One fire-and-forget row per finalized
  // run beside the grounding metric; the machine flag segments by origin for
  // the same reason as above (wakes legitimately run many platform tools and
  // never offer chips — adoption/offer rates are only readable per origin).
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.CHAT_PLATFORM_USAGE,
    sessionId: runSessionId,
    stamp: chatMetricStamp,
    meta: {
      mode,
      platformToolCalls: countPlatformToolCalls(result.parts),
      tools: platformToolNamesCalled(result.parts),
      actionChips: countActionChips(followUps),
      // Owner 2026-09-18: how many follow-up chips the answer carried at all
      // (action chips are the subset that name a platform action) — the
      // per-level cohesion check reads this by mode.
      followUps: followUps.length,
      machine: args.machineWake === true || machineOriginRun(args),
    },
  });
  // N4 (2026-09-25): label the checker-site router's decision from what THIS
  // turn measurably did — the lead's tool rounds, web calls, final length and
  // whether the Double Checker's draft was merged. Fire-and-forget; an empty
  // orchestrator finalize evidences nothing (actual null).
  // Audit 2026-09-26 (docs-drift-12): under answer-first a heavy turn whose draft
  // lands AFTER the lead's loop used to label depth null at finalize ("depth
  // unknown") — the merge happens minutes later in the late reconcile. When the
  // late pass is armed the label is DEFERRED to its settle with checkerMerged
  // upgraded from the outcome (revised / unchanged / addendum = the draft
  // reached the answer).
  let deferredCheckerRouteFacts: CheckerRunFacts | null = null;
  if (checkerRoutePromise) {
    const facts: CheckerRunFacts = {
      regexSimple: regexSimpleQuestion,
      leadToolCalls: Array.isArray(result.parts) ? result.parts.filter((p: any) => p?.type === 'tool_call').length : 0,
      webToolCalls: countWebToolCalls(result.parts),
      finalChars: finalText.length,
      checkerMerged: crossCheckMerged,
      lateArmed: lateCrossCheckArmed,
    };
    if (answerFirst && lateCrossCheckArmed && !crossCheckMerged && !orchestratorEmpty) {
      deferredCheckerRouteFacts = facts;
    } else {
      void checkerRoutePromise
        .then((r) => recordCheckerRouteOutcome(r, facts, { sessionId: runSessionId, acted: checkerRouteActed, failed: orchestratorEmpty }))
        .catch(() => {});
    }
  }
  // Decision-outcome label (WI-C, 2026-09-25): a machine wake that carried a
  // shadow decision stash (hooks.service wake_triage / fireDue delta_material
  // via fireScheduleTarget) labels that decision from what THIS run did —
  // mutating platform tools, evidence calls, note class. Fire-and-forget; an
  // empty orchestrator finalize evidences nothing (actual stays null).
  if (args.decision) {
    const decisionStash = args.decision;
    void import('../platform/decision-outcome-labels')
      .then((m) => m.labelMachineRunOutcome(decisionStash, { parts: result.parts, finalText, sessionId: runSessionId, failed: orchestratorEmpty }))
      .catch(() => {});
  }
  // audit 2026-10-08 W6: a SUPERVISOR run's finalize advances its wake-ledger
  // high-water mark (completed machine wakes only — the next diff starts where
  // this wake's state was read) and labels the material-gate verdict that let
  // the wake through with what it measurably did. Fire-and-forget; never throws.
  if (isSupervisorChat && chatId) {
    const ledgerChatId = chatId;
    void import('../platform/supervisor-wake-ledger')
      .then((m) => m.onSupervisorRunFinalized({ chatId: ledgerChatId, machineWake: args.machineWake === true, failed: orchestratorEmpty, wakeLedgerAt: args.wakeLedgerAt ?? null, runStartedAt: orchestratorT0 - 30_000, parts: result.parts }))
      .catch(() => {});
  }
  // INTERVENTION-OUTCOMES (supervisor SOTA round 2, 2026-10-20; platform/intervention-outcomes.ts):
  // every ok lane-lever receipt of this supervisor turn (spawn / steer / schedule aimed at a coding
  // lane) becomes ONE supervisor_intervention row per lane, labelled +6 h / +24 h by the worker cron
  // supervisor-intervention-outcomes from what the lane did next. Receipts are real even when the
  // final note came back empty, so the turn's failure never suppresses them. Fire-and-forget;
  // never throws. Kill switch SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1 (read inside).
  if (isSupervisorChat && chatId && Array.isArray(result.receipts) && result.receipts.length) {
    const interventionChatId = chatId;
    const interventionReceipts = result.receipts;
    void import('../platform/intervention-outcomes')
      .then((m) => m.recordSupervisorInterventions({
        supervisorChatId: interventionChatId, receipts: interventionReceipts,
        machineWake: args.machineWake === true || machineOriginRun(args),
        supervisorTier: isFleetSupervisorChat ? 'fleet' : 'project',
      }))
      .catch(() => {});
  }
  // ── Supervisor run journal — WRITE side (ticket 9993f30c, 2026-10-18) ──────
  // A supervisor chat's turns run through THIS pipeline, not the coding
  // run-executor, so until now they wrote NO run-journal row: a supervisor's
  // only cross-run memory was its compacted transcript, and a 2026-10-16 note
  // cited todo ids that never existed with nothing to check them against.
  // ONE deterministic, receipt-backed journal row per supervisor turn (both
  // machine wakes and owner-typed turns), written AFTER the turn's final note
  // settles (the claims lane may have annotated it above). Fire-and-forget
  // dynamic import (the wake-ledger precedent); never throws into finalize.
  // Kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1 (checked here AND inside the
  // writer — the call-site check keeps the import unpinned under the switch).
  if (isSupervisorChat && chatId && process.env.SUPERVISOR_RUN_JOURNAL_DISABLED !== '1') {
    const journalChatId = chatId;
    const triggerKind: 'user' | 'schedule' | 'hook' | 'machine' =
      args.messageOrigin === 'schedule' ? 'schedule'
      : args.messageOrigin === 'hook' ? 'hook'
      : (args.machineWake || machineOriginRun(args)) ? 'machine'
      : 'user';
    void import('../coding/run-journal.service')
      .then((m) => m.writeSupervisorTurnEntryAsync({
        chatId: journalChatId,
        triggerKind,
        message: args.machineWakeOriginalMessage ? String(args.machineWakeOriginalMessage) : String(message ?? ''),
        finalNote: finalText,
        receipts: (result.receipts ?? []) as any[],
        toolsUsed: Array.isArray(result.parts) ? Array.from(new Set((result.parts as any[]).filter((p: any) => p?.type === 'tool_call').map((p: any) => String(p.name)))) : [],
        // Review M5 (88d85d8e): orchestratorEmpty is frozen BEFORE the retry /
        // claims-lane / guard / compose lanes can reassign finalText (:5300,
        // :5441, :5521, :5561, :5748, :5832) — a turn that RECOVERED through
        // any of them still had the EMPTY/failed shape journaled and its real
        // note dropped. Gate on the note we are actually about to journal.
        failed: orchestratorEmpty && !finalText.trim(),
      }))
      .catch(() => {});
  }

  // N9 (2026-09-25): the machine-wake effort score's outcome — the run's own
  // behaviour (no-op / note / action) plus its harness-measured length and the
  // turn ledger's cost. Fire-and-forget; never throws into the finalize.
  if (wakeEffortGate) {
    const snap = (() => { try { return turnUsage?.snapshot(); } catch { return undefined; } })();
    void wakeEffortGate.label({
      parts: result.parts, finalText, sessionId: runSessionId, failed: orchestratorEmpty,
      runMs: Date.now() - orchestratorT0, costUsd: snap?.totalCostUsd, turns: snap?.turns,
    }).catch(() => {});
  }


  // Persist the ASSISTANT row (the user row was written at run start).
  // canvasIds/canvasCount persist so the inline reopen chip survives reload
  // (owner report 2026-07-16: 'lost the icon for the canvas' — the chip is
  // scoped to message.metadata.canvasIds, which agent metadata omitted).
  // Anonymous sessions have no chat rows — their history lives in the Redis
  // session store (legacy controller parity: saveToSessionHistory).
  // Sources = what the run's OWN tool calls actually read (the adapter
  // collects + unwraps them); the forced-SERP URL harvest died with the
  // search force (owner 2026-09-03). Non-citation hosts (search-engine
  // redirect/block pages, vendor error docs) still never render as chips.
  // The chat UI's Sources chips expect RAG-shaped objects; web sources carry
  // no relevanceScore (the UI hides the % when absent). Computed ONCE and
  // written to BOTH the complete payload and the persisted metadata (owner
  // 2026-09-18 — the pills, like the follow-up chips, vanished on reload).
  const runSources = [...new Set(adapter.collectedSources)]
    .filter(u => !isNonCitationHost(u))
    .slice(0, 12)
    .map(u => ({ documentName: u, mimeType: 'url', content: u, sourceUrl: u }));
  // Compute policy: the turn ledger so far (the checker may still be running —
  // the late path's spend settles into the same run_spend row; this snapshot
  // is a RECORD on metadata.depth.spentUsd — nothing is refused on it since
  // 2026-09-27, owner: no hidden cost caps).
  const spentUsdAtFinalize: number | undefined = (() => { try { return turnUsage?.snapshot().totalCostUsd; } catch { return undefined; } })();
  // The assistant row's id is minted HERE so the Dig-deeper chip can name the
  // row it escalates before the row persists (one write, every surface agrees).
  const plannedRowId: string | null = chatId ? randomUUID() : null;
  // ── TURN CONTINUATION (cohesive-chat wave 2026-09-28; turn-continuation.ts) ──
  // A HUMAN turn that ended mid-task (deadline over an open plan, or a closing
  // text that hands the rest back — "say the word" beside evidence the work was
  // cut short) is not finished: the closing is rewritten to the one
  // continuation line, a background round of the SAME chat is armed through
  // the busy-chat queue (the finally drains it), and the task card goes
  // 'running'. A continuation round that ends the same way re-arms under the
  // cap; a genuine clarifying question (credentials, an ambiguous target) is
  // left alone as waiting_user. Human turns on plain chats only (supervisor
  // chats have wake machinery; Dig-deeper rungs, cancelled runs and provider
  // kills never arm). Deterministic detection; every failure keeps the answer
  // byte-identical (fail-open). Runs BEFORE the chips / metadata compose so a
  // rewritten answer carries no follow-up chips and no Dig-deeper chip (the
  // model's chip would double-run the offered work; review fix 1).
  // Review fixes (same wave): a confirmation hand-back on a human turn is
  // never armed — a machine round cannot confirm a card — the card reads
  // waiting_user and the answer (with its pointer to the card) stands (fix 2);
  // a user message typed since the task started, or waiting in the queue,
  // supersedes the round — nothing is armed behind it (fix 5); a round the
  // user STOPPED settles as waiting_user, never "finished" (fix 6).
  // Kill switches TURN_CONTINUATION_DISABLED=1 / CONTINUATION_MAX_ROUNDS=0.
  let continuationVerdict: RunEndVerdict | null = null;
  let continuationRewrote = false;
  let continuationLine: string = CONTINUATION_LINE;
  let continuationPlan: CodingPlan | null = null;
  const continuationPreviousAnswer = finalText;
  let continuationArmed: ContinuationRun | null = null;
  let continuationArmFailed = false;
  let continuationStop: 'cap' | 'waiting_user' | 'done' | 'superseded' | 'stopped' | null = null;
  let continuationWaitingCard = false;
  let continuationSupersededBy: ContinuationSupersession | null = null;
  const continuationCancelled = args.isCancelled?.() === true;
  // build 2026-10-08 A1 (owner-answer-first.ts): supervisor chats arm a continuation ONLY as the answer-first
  // follow-through — an acting owner turn, or a follow-through round (nothing else arms one on a supervisor chat)
  // while the chat's mode still acts. A round on a chat switched back to shadow / off still settles its card below.
  const afRound = isSupervisorChat && !!args.continuation && !!chatId;
  const afEligible = isSupervisorChat && !!chatId && (ownerAfAct || (afRound && resolveOwnerAnswerFirst(chatId!).mode === 'act'));
  let afFollowThrough: FollowThrough | null = null;
  let afResumed: ContinuationRun | null = null;
  const continuationEligible = !turnContinuationDisabled() && continuationMaxRounds() > 0 && !!chatId && !!userId
    && (!isSupervisorChat || afEligible) && !args.escalation && !continuationCancelled
    && (args.continuation ? true : !runIsMachineTriggered)
    && result.modelErrored !== true && finalText.trim().length > 0 && !isHarnessErrorNote(finalText);
  if (continuationEligible && chatId && userId) {
    try {
      continuationPlan = await getChatPlan(runSessionId).catch(() => null);
      // build 2026-10-08 A1: an acting OWNER turn reads its split + "Follow-through:" line (ownerAnswerFirstVerdict).
      const afSplit = ownerAfAct && !args.continuation && !!ownerAfObserver?.split();
      if (afSplit) afFollowThrough = parseFollowThrough(finalText);
      continuationVerdict = classifyRunEnd({
        finalText: afFollowThrough ? afFollowThrough.stripped : finalText, deadlineHit: result.deadlineHit === true,
        unfinishedSteps: planUnfinishedCount(continuationPlan),
        planTouchedThisRun: planTouchedSince(continuationPlan, startedAt),
      });
      if (ownerAfAct && !args.continuation) {
        continuationVerdict = ownerAnswerFirstVerdict({ split: afSplit, followThrough: afFollowThrough ?? parseFollowThrough(''), base: continuationVerdict });
      }
      const verdict = continuationVerdict;
      // An answer-first follow-through is never superseded by a newer owner message — it runs after it (A1).
      if (verdict.kind === 'continue' && !afEligible) {
        continuationSupersededBy = await continuationSupersededByUser(chatId, args.continuation ? new Date(args.continuation.startedAt) : null).catch(() => null);
      }
      // build 2026-10-08 A1: `pre` lifts the split answer's "Follow-through:" line first (its items ride `line`).
      const rewriteAnswer = (line: string = CONTINUATION_LINE, pre?: (t: string) => string) => {
        finalText = rewriteClosingText(pre ? pre(finalText) : finalText, line);
        continuationRewrote = true;
        continuationLine = line;
        // The answer no longer ends in an offer — the chips that mirrored it go
        // too (a tapped chip would run the offered work a second time).
        followUps = [];
        // The reloaded transcript renders PARTS — apply the same rewrite to the
        // last delivered text part (one complete turn document per part).
        const parts = (result.parts || []) as Array<{ type: string; text?: string; marker?: string; struck?: boolean }>;
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.type === 'reasoning') continue;
          if (p.type !== 'text' || p.marker || p.struck) break;
          // Text parts carry the RAW stream — the [FOLLOWUPS] block would be the
          // "last paragraph"; lift it first so the rewrite sees the real closing
          // (the block is dropped with the chips anyway).
          const clean = parseFollowUps(p.text || '').cleanText;
          p.text = rewriteClosingText(pre ? pre(clean) : clean, line);
          break;
        }
      };
      const afPre = afFollowThrough?.found ? (t: string) => parseFollowThrough(t).stripped : undefined;
      const afLine = afFollowThrough ? followThroughContinuationLine(afFollowThrough.items) : CONTINUATION_LINE;
      // The answer turn's mutating calls (+ earlier rounds') ride the stash — the next round is told not to repeat them.
      const afArmFields = (prev?: ContinuationRun) => {
        if (!afEligible) return {};
        const items = prev?.answerFirst ? (prev.answerFirst.items ?? null) : (afFollowThrough?.items ?? null);
        const done = [...new Set([...(prev?.answerFirst?.done ?? []), ...mutatingCallSignatures(result.parts as any[])])].slice(0, 24);
        return {
          answerFirst: { resumes: prev?.answerFirst?.resumes ?? 0, done, items },
          extraNote: answerFirstContinuationNote({ items, done }),
          ...(!prev && ownerTurnUserRowId ? { askMessageId: ownerTurnUserRowId } : {}),
        };
      };
      const armNext = async (prev?: ContinuationRun) => {
        try {
          continuationArmed = await armTurnContinuation({
            chatId, userId, mode, reason: verdict.kind === 'continue' ? verdict.reason : 'unfinished_plan',
            askText: prev?.askText ?? message, previousAnswer: continuationPreviousAnswer, plan: continuationPlan,
            ofMessageId: prev?.ofMessageId ?? (plannedRowId ?? ''), ...(prev ? { prev } : {}),
            ...afArmFields(prev),
          }, { enqueue: async (a) => enqueueChatMessage(a) });
        } catch (err: any) {
          continuationArmFailed = true;
          logger.warn(`chat-agent: turn continuation arm failed for ${chatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
        }
      };
      if (!args.continuation) {
        if (verdict.kind === 'continue' && verdict.reason === 'confirmation_handback') {
          continuationWaitingCard = !!plannedRowId; // the staged card is the user's to answer — never a machine round
        } else if (verdict.kind === 'continue' && continuationSupersededBy) {
          continuationStop = 'superseded'; // the user already spoke — their turn owns the ask
        } else if (verdict.kind === 'continue' && plannedRowId) {
          await armNext();
          if (continuationArmed) rewriteAnswer(afLine, afPre);
        }
        // A1: a split answer that armed nothing ("Follow-through: none", or the owner must answer first) drops the
        // bare harness line; a line naming items that could not be armed stays — it is the honest remainder.
        if (!continuationArmed && afFollowThrough?.found && afFollowThrough.none) {
          finalText = parseFollowThrough(finalText).stripped;
          leakRetrySwapped = true; // live viewers swap to the text without the harness line
          const parts = (result.parts || []) as Array<{ type: string; text?: string; marker?: string; struck?: boolean }>;
          for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.type === 'reasoning') continue;
            if (p.type === 'text' && !p.marker && !p.struck) p.text = parseFollowThrough(p.text || '').stripped;
            break;
          }
        }
      } else {
        const next = nextContinuationRound(args.continuation, verdict);
        if ('round' in next) {
          if (continuationSupersededBy) {
            continuationStop = 'superseded';
          } else {
            await armNext(args.continuation);
            if (continuationArmed) rewriteAnswer();
            else continuationStop = 'done';
          }
        } else {
          continuationStop = next.stop;
          if (next.stop === 'cap') {
            // The budget is spent: the partial stands, the offer goes, and the
            // one honest line says how to resume — never a question back.
            rewriteAnswer(CONTINUATION_CAP_LINE);
          }
        }
      }
    } catch (err: any) {
      logger.warn(`chat-agent: turn continuation check failed (answer unchanged): ${err?.message ?? err}`, { source: 'chat-agent' });
      continuationVerdict = null;
    }
  } else if (args.continuation && continuationCancelled) {
    continuationStop = 'stopped'; // the user stopped the round — the card must not read "finished"
    // build 2026-10-08 A1 — "resume after the owner's turn": an answer-first follow-through round an OWNER message
    // PREEMPTED (preemptMachineRunForUserMessage marked it — a Stop never does) is re-queued once more, held from the
    // drain until the owner's own turn has started; its card stays running. Capped at ANSWER_FIRST_MAX_RESUMES.
    const prevAf = args.continuation.answerFirst;
    if (afRound && chatId && userId && (prevAf?.resumes ?? 0) < ANSWER_FIRST_MAX_RESUMES && await takeChatRunPreempted(chatId)) {
      try {
        const resumes = (prevAf?.resumes ?? 0) + 1;
        const stash: ContinuationRun = { ...args.continuation, answerFirst: { ...(prevAf ?? { resumes: 0 }), resumes } };
        const content = /\saf=\d+/.test(args.message) ? args.message.replace(/(\s)af=\d+/, `$1af=${resumes}`) : args.message;
        await enqueueChatMessage({ chatId, userId, content, mode, source: 'schedule', origin: { kind: 'schedule', continuation: stash } });
        await setFollowThroughHold(chatId, ANSWER_FIRST_PREEMPT_HOLD_MS);
        afResumed = stash;
      } catch (err: any) {
        logger.warn(`chat-agent: answer-first follow-through re-queue failed for ${chatId.slice(0, 8)} (card settles as stopped): ${err?.message ?? err}`, { source: 'chat-agent' });
      }
    }
  }
  // build 2026-10-08 A1: the follow-through task this OWNER turn armed (assigned inside armNext — read through a typed alias).
  const afArmedTask: ContinuationRun | null = ownerAfAct ? (continuationArmed as ContinuationRun | null) : null;
  // Compute policy (2026-09-26): the ONE depth chip appended server-side on
  // human turns — 'escalate' (Dig deeper → the next rung not yet spent on
  // THIS persisted row) for signed-in users, 'signin_deeper' for guests, none
  // on machine runs / supervisor chats / under DIG_DEEPER_DISABLED=1. Rides the
  // 'followups' event, the 'complete' payload and metadata.chips.
  // A Dig-deeper run's chip points back at the ORIGINAL message (whose
  // metadata.depth.escalations records the rung just spent) — a "Deeper
  // findings" row is never itself escalated (nextRungForMessage: kind check).
  // Whether the chip is DISABLED on this turn (global switch / supervisor chat) — the finalize
  // `facts` label below reads it too: with no chip, `escalated:true` can never arrive, so the
  // row must not become the ruler's window-closed negative (audit 2026-09-26).
  // A rewritten "Still working on this" answer carries no Dig-deeper chip either
  // (review fix 1) — the disabled flag keeps the ruler's `escalatable` label honest.
  const depthChipDisabled = digDeeperDisabled() || isSupervisorChat || continuationRewrote;
  const depthChip: DepthChip | null = depthChipFor({
    guest: !userId, machine: runIsMachineTriggered, messageId: args.escalation ? args.escalation.ofMessageId : plannedRowId,
    nextRung: nextRungForPlan(plan, args.escalation?.rung), disabled: depthChipDisabled,
  });
  const chips: DepthChip[] = depthChip ? [depthChip] : [];
  // Owner-ask wake close (fixer 2026-09-27, finding upward-chatter-1): a hook
  // wake raised FOR an owner ask (args.ownerAskMessageIds — the [OWNER ASK
  // UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge) closes the ask when its
  // reply is REAL text: never a harness envelope, never a provider kill, never
  // a 'WAKE: no-op' close (the wake ignored the ask). Decided BEFORE the row
  // persists so the reply row carries metadata.ownerAskReply — the stamp
  // fleet/supervisor-reply-row accepts as the supervisor's answer despite the
  // 'hook' origin. Before this the close ran only on owner turns, so the very
  // wakes built to answer an ask could never close it.
  const ownerAskWake = isSupervisorChat && runIsMachineTriggered && args.messageOrigin === 'hook'
    && (args.ownerAskMessageIds?.length ?? 0) > 0 && !!userId && !!chatId;
  // Follow-through harness line (2026-10-22, owner-answer-first.ts isAnswerFirstFollowThrough): an answer-first
  // FOLLOW-THROUGH round of the owner's own turn runs machine-triggered (origin 'schedule'), so the harness record
  // below closed its zero-action result with 'WAKE: no-op (harness: 0 lane actions)' — the owner read their answer
  // as a stray no-op wake. It is the answer they were promised: like an owner-ask reply it gets the neutral
  // 'Harness record:' line (metadata mode 'record' ⇒ harnessNoteKind 'supervisor_note', never a wake no-op);
  // executed actions still list under 'ACTIONS TAKEN (harness):'. A round that closes itself with the model-typed
  // 'WAKE: no-op …' line has that trailing line stripped before the record (FOLLOW-THROUGH NO-OP CLOSE, at the KPI
  // footer below — 2026-10-22 minors). Kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1.
  const followThroughQuietZero = isSupervisorChat && runIsMachineTriggered && !!chatId
    && isAnswerFirstFollowThrough(args.continuation) && !followThroughQuietZeroDisabled();
  // HARNESS-RECEIPTS (review fix 2026-10-20): judged on the text that will STAND — a reply that was only the
  // model's ACTIONS TAKEN block is stripped in phase 2 below (the owner then reads harness lines only), so it
  // never closes the ask as answered.
  const ownerAskReplyText = harnessView && !actionGuardStruck && !harnessTextExempt ? stripModelActionsBlock(finalText).text : finalText;
  const ownerAskAnswered = ownerAskWake && result.modelErrored !== true
    && ownerAskReplyText.trim().length > 0 && !isHarnessErrorNote(finalText) && !WAKE_NOOP_NOTE_RE.test(ownerAskReplyText);

  const metadata = {
    // ticket 0c647003: the owner-turn forged-chrome strip's stamp (present only when something was stripped)
    ...(forgedChromeStrip ? { forgedChrome: { v: 1, ...forgedChromeStrip, ownerTurn: true } } : {}),
    // webSearch here means "web tools were AVAILABLE to the run" (always true
    // for agent runs) — the forced-search product posture died 2026-09-03;
    // per-run actual usage lives on the model cards' webSearchUsed.
    models, modelLabels: SEAT_MODEL_LABELS, mode, engine: 'agent', synthesisTime: Date.now() - orchestratorT0, webSearch: true,
    ...(runSources.length ? { sources: runSources } : {}),
    // Fleet origin marking: the reply inherits the turn's origin so machine-run
    // answers are classified like their wake prompts in the fleet views.
    // A turn-continuation result (2026-09-28) carries NO machine origin: it is
    // the answer the human was promised and renders as a normal bubble
    // (machine-turn grouping folds origin-stamped rows); metadata.continuation
    // links it to the task instead.
    ...(args.messageOrigin && !args.continuation ? { origin: args.messageOrigin, ...(args.originSourceChatId ? { sourceChatId: args.originSourceChatId } : {}) } : {}),
    ...(args.continuation ? { kind: CONTINUATION_RESULT_KIND, continuation: { taskId: args.continuation.taskId, round: args.continuation.round, maxRounds: args.continuation.maxRounds, ofMessageId: args.continuation.ofMessageId, reason: args.continuation.reason } } : {}),
    // Owner-ask wake (fixer 2026-09-27): this hook-origin row IS the answer to
    // an owner ask — the reply-row leaf, the fleet views and the frontend
    // grouping read the stamp (see ownerAskAnswered above).
    ...(ownerAskAnswered ? { ownerAskReply: true } : {}),
    // build 2026-10-08 A1: the owner turn ran under answer-first — `armed` = its follow-through task is running, so
    // fleet/supervisor-reply-row.ts does not count THIS row as the ask's reply until the card settles.
    ...(ownerAfObserver ? { [OWNER_ANSWER_FIRST_META_KEY]: { mode: ownerAf!.mode, split: !!ownerAfObserver.split(), armed: !!afArmedTask, ...(afArmedTask ? { taskId: afArmedTask.taskId } : {}) } } : {}),
    // Owner-armed scheduled digest (ticket 77c3a7e9): the ANSWER row of an
    // owner-armed schedule firing is DELIVERED CONTENT, not internal wake
    // noise — the same guard shape as the wake user-row stamp above (6ef770a1),
    // and the frontend/machine-turn-grouping exemption keys on this kind so
    // the digest renders as a NORMAL visible assistant bubble instead of
    // folding into the machine-turn accordion (the owner's "buried in
    // accordion" report). The envelope and verifier chrome stay collapsed.
    ...(args.scheduleOwnerArmed && args.messageOrigin === 'schedule' ? { kind: OWNER_DIGEST_KIND } : {}),
    ...(args.routing ? { routing: args.routing } : {}),
    ...(args.routingSource ? { routingSource: args.routingSource } : {}),
    ...(parsedCanvases.length ? { canvasCount: parsedCanvases.length, canvasIds: savedCanvasIds } : {}),
    // Owner 2026-09-18 ("what happened to the follow-ups?"): the chips were
    // only ever SENT (the `followups` SSE event + the complete payload) and
    // never persisted — a reload, a PWA re-open or a second device showed the
    // answer without them (0 of 46 plain-chat answers in 7 days carried them
    // in metadata). Persist the same list the live turn showed so the
    // rendered end state is the same on every surface.
    ...(followUps.length ? { followUps } : {}),
    // STRUCK-NOTE REPEAT (round 4, tickets 4c7aebf7 + 9a976d83): this row's lineage has had its one repeat
    // reject-back — chat-agent/struck-note-repeat priorNoteFromRow reads it back (repeatSpent).
    ...(struckRepeatLineage ? { [REPEAT_LINEAGE_META_KEY]: struckRepeatLineage } : {}),
    // Owner 2026-09-18: the Double Checker is still working — late-crosscheck.ts
    // clears this (and may revise the row) when its draft lands; the client
    // polls while it is true.
    ...(lateCrossCheckArmed ? { pendingCrossCheck: true } : {}),
    // Compute policy (2026-09-26): the plan + budget this turn ran under, the
    // pill state it ends in, the TTFT the user experienced, and — for a Dig
    // deeper run — the "Deeper findings" kind + the message it deepened.
    // (no `budget.enforced` since 2026-09-27 — there is no USD rail to
    // describe; older rows may still carry it, readers ignore it.)
    depth: depthMetadataFor(plan, budget, spentUsdAtFinalize, computePolicyFacts, turnPlanMetaStamped),
    // cp/labels: the INLINE reconcile's verdict persists like the late path's
    // (material / source / decisionId + the gate's compact stash) so a later
    // thumbs / tap can label revision_material from the row alone.
    // drafts_agree (2026-09-26): an ACTED decision (reconcile skipped) persists its
    // compact stash here so a later thumbs / tap can label it acted:true
    // (labelDraftsAgreeFromMetadata) — the E12 auto-demote window was blind to
    // acted asks before this.
    ...(checkState ? { check: { ...checkState, at: new Date().toISOString(), ...inlineVerdictMeta(inlineRevisionVerdict as RevisionMaterialVerdict | null), ...draftsAgreeMeta(draftsAgreeResult, draftsAgreeActed) } } : {}),
    ux: { ...(firstChunkAt ? { firstChunkAt: new Date(firstChunkAt).toISOString(), ttftMs: firstChunkAt - startedAt } : {}), completionMs: Date.now() - startedAt, ...(leadEffortAbArm ? { effortArm: leadEffortAbArm } : {}) },
    ...(args.escalation ? { kind: DEEPER_FINDINGS_KIND, escalationOf: args.escalation.ofMessageId, escalationRung: args.escalation.rung, title: DEEPER_FINDINGS_TITLE } : {}),
    ...(chips.length ? { chips } : {}),
    // Spark B21: a machine wake cancelled mid-run (user preemption / Stop) is
    // marked so fleet views and forensics can tell it from a real completion
    // (its run_completed emission is suppressed and its source hook events are
    // requeued by the preemption path).
    ...((args.machineWake === true || machineOriginRun(args)) && args.isCancelled?.() === true
      ? { preempted: true } : {}),
    // Ticket 08e58e1d: a provider-killed run persists the harness's terminal
    // error envelope (modelErrorTerminalNote — e.g. the 429 "Sorry — I
    // couldn't get an answer out this time…" fallback) as the assistant row
    // UNDER THE WAKE'S MACHINE ORIGIN, indistinguishable from a lane-authored
    // note; two dead wakes in a row read as "near-identical supervisor notes"
    // to the fleet watchdog's stuck-note backstop. Stamp the kill
    // deterministically so machine readers (the watchdog note scan first)
    // never score the harness's own error text as lane output. Forensics
    // bonus: the row now self-describes WHY it is an envelope.
    ...(result.modelErrored === true
      ? { providerError: { status: result.modelErrorStatus ?? null, kind: result.modelErrorKind ?? 'unknown' } }
      : {}),
  } as any;
  // ── roster 2026-10-06 D-1 / D-3: who worked on THIS answer. The team note (metadata.depth.team — data for the depth
  // pill; it rides the 'complete' event's `depth` too; TEAM_NOTE_DISABLED=1 drops it) and the turn the session roster
  // folds in once the row persists (below). Members are what RAN: the lead after any fallback, the plan's Double
  // Checker, the council colleagues that reported, a successful call_in.
  const callInRec = callIn?.record() ?? null;
  const rosterRanLane = ranLaneOf({ quick: !!quickLaneModel, council: isCouncil, checker: spawnChecker });
  const rosterChecker: string | null = !isCouncil && spawnChecker ? (String(models[SEAT_CARD_KEYS.double]?.modelUsed || crossCheckers[0] || '') || null) : null;
  const rosterColleagues: string[] = isCouncil
    ? (['double_checker', 'triple_checker'] as const).filter((k) => !!String(models[k]?.response ?? '').trim()).map((k) => String(models[k].modelUsed || councilModels[k]))
    : [];
  if (!runIsMachineTriggered && !teamNoteDisabled() && metadata.depth && typeof metadata.depth === 'object') {
    const team = teamNoteFor({
      lane: rosterRanLane,
      lead: orchestratorModel,
      checker: rosterChecker ? { model: rosterChecker, via: 'plan' } : callInRec?.ok && callInRec.role === 'checker' ? { model: callInRec.model, via: 'call_in' } : null,
      colleagues: [...rosterColleagues.map((m) => ({ model: m, via: 'council' as const })), ...(callInRec?.ok && callInRec.role === 'colleague' ? [{ model: callInRec.model, via: 'call_in' as const }] : [])],
      web: Object.values(models).some((m: any) => m?.webSearchUsed === true) || (callInRec?.webToolCalls ?? 0) > 0,
    });
    if (team) metadata.depth.team = team;
  }
  const rosterRecord = rosterDepthRecord(rosterTrace);
  if (rosterRecord && metadata.depth && typeof metadata.depth === 'object') metadata.depth.roster = rosterRecord;
  // Ticket 2ce29c32: mid-run [DISPATCH-NEEDED] blocks live only in the run's
  // parts — intermediate turns are never persisted as rows, and every
  // machine-facing surface (get_chat_messages, next-run history, the
  // run_completed hook summary) reads content only. Carry them into the
  // durable content so fleet readers see the dispatch, not just a reference.
  // KPI REPLY FOOTER (tt-rd audit 2026-09-27, finding 5): a supervisor reply
  // that types a rate in the KPI's unit which differs from the register value
  // without citing the premise key gets the register's own line appended —
  // deterministic, cheap, observe-only (nothing is replaced or refused).
  // The 7.3 / 6.56 tok/s mis-reports were owner-facing chat turns with no
  // agent_run, which the numeric-provenance detector never sees. Persisted
  // content + parts carry it; the SSE stream already ended. Row kpi_reply_mismatch.
  // The post-delivery action verifier audits the note WITHOUT the footer: its
  // receipt-citation lane (mineReceiptCitations) would otherwise read the
  // harness's own "receipt <id8>" as a claim of this run's.
  // FOLLOW-THROUGH NO-OP CLOSE (2026-10-22 minors; owner-answer-first.ts answerFirstContinuationNote tells the round
  // too): every supervisor prompt carries the core wake.close rule, so an answer-first follow-through round could
  // still close the OWNER's answer with the model-typed 'WAKE: no-op — nothing moved …' — the owner read it at the end
  // of their answer and phase 2 below filed the round 'noop_present'. The round's TRAILING no-op close is stripped
  // from the content and the same line(s) from the stored parts, so phase 2 renders the neutral 'Harness record:'
  // line (mode 'record'). Here, before the KPI footer, so the footer / footnote / appendix all land after the model's
  // own last line and the post-delivery verifier audits the stripped words. Never on a frozen note (a guard-struck
  // note, an owner digest — byte-identical storage) and only with the harness record on (harnessView). Same kill
  // switch: SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1 (followThroughQuietZero is false) keeps the line.
  // Review fixes (2026-10-22): (1) a close that carries a REASON keeps it as plain text (only the marker and its
  // boilerplate go) and a round that is ONLY the close is never stripped — it stays a no-op reply, so the owner ask
  // stays open (stripped to '' the row was the bare record line and closeAskOnReply closed the ask on a content-free
  // bubble); (2) the strip itself marks the live view for the swap (harnessReceiptsSwapped) — phase 2 below can
  // throw ('harness receipts append skipped') and the live view then kept the streamed close the row had dropped —
  // and an empty result is never taken (the row would store the empty-run envelope ⇒ continuation 'failed'); (3) the
  // close is found under the model's own Receipts line, behind heading / quote / bullet chrome and above the harness
  // trailers appended before this seam (struck-repeat / computer-claim annotations, the claims-lane notes, the
  // deferral note — kept in place), and the parts take the content strip's exact line edits wherever the line sits
  // (a trailing notes part made the last-part walk miss).
  let followThroughNoopLines = 0;
  let followThroughNoopReasonLines = 0;
  let harnessReceiptsSwapped = false;

  if (followThroughQuietZero && harnessView && !actionGuardStruck && !harnessTextExempt) {
    const s = stripTrailingNoopCloseLine(finalText);
    if (s.strippedLines && s.text.trim()) {
      followThroughNoopLines = s.strippedLines;
      followThroughNoopReasonLines = s.reasonLines;
      finalText = s.text;
      harnessReceiptsSwapped = true;
      if (result.parts?.length) result.parts = stripTrailingNoopCloseLineFromParts(result.parts, s.edits).parts;
    }
  }
  const finalTextBeforeKpiFooter = finalText;
  if (isSupervisorChat && chatId && finalText.trim()) {
    try {
      const kpis = await loadKpisForSupervisorChat({ projectId: isProjectSupervisorChat ? supervisorRow?.projectId ?? null : null, userId, fleet: isFleetSupervisorChat });
      const hit = kpiReplyFooter(finalText, kpis);
      if (hit) {
        finalText = `${finalText.trimEnd()}\n\n${hit.footer}`;
        (result.parts = result.parts || []).push({ type: 'text', text: `\n\n${hit.footer}` });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.KPI_REPLY_MISMATCH, sessionId: chatId, stamp: chatMetricStamp,
          meta: { chatId, goalId: hit.kpi.goalId, key: hit.kpi.key, quoted: hit.quoted.slice(0, 8), registered: hit.kpi.value, receiptId: hit.kpi.receiptId ? String(hit.kpi.receiptId).slice(0, 8) : null, machine: machineTriggeredRun === true, scope: supervisorScope ?? null },
        });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: KPI reply footer skipped (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // ── HARNESS-RECEIPTS-AND-CLAIMS phase 2 (supervisor SOTA round 3; phase 1 above) ──
  // Append the harness record of this wake — 'ACTIONS TAKEN (harness):' with
  // one line per executed real mutating call (tool → target · receipt id8), a
  // report-up / not-executed line, or with zero calls the single
  // 'WAKE: no-op (harness: 0 lane actions)' line (never under a note that
  // already closes no-op; the neutral 'Harness record:' line on an owner-ask
  // answer, an answer-first follow-through round (followThroughQuietZero) or a
  // 'WAKE: reported' note) — and stamp metadata.harnessActions,
  // which the attention watchdog and the supervisor_turn_noop facts prefer
  // over the marker regex. AFTER finalTextBeforeKpiFooter on purpose: the
  // post-delivery verifier audits the model's own words, never the harness's
  // "receipt <id8>" lines. The no-op / action trend breaks ONCE at deploy (the
  // watchdog rows carry meta.classifiedBy 'harness' from here on).
  // A guard-STRUCK note (the action verifier's replacement wrapper) is harness text whose storage stays
  // byte-identical (guard-chrome-redact's audit contract) — the record rides the metadata only there; so
  // does an OWNER-ARMED digest firing (harnessTextExempt — the owner's own deliverable, never rewritten;
  // its zero-call record is the neutral one, never a no-op). The appendix lands AFTER any annotate-lane
  // trailer above and stays LAST (the unverified-claims footnote below goes in front of it);
  // guard-chrome-redact treats a trailing appendix as transparent, so those trailers still strip from context.
  // (harnessReceiptsSwapped is declared at the follow-through strip above — that strip marks the swap too.)
  // What this phase appended ('' when nothing) and its part — the footnote lane places itself in front of
  // them and the owner briefing reads the note without them (review fix 2026-10-20).
  let harnessAppendix = '';
  let harnessAppendixPart: { type: 'text'; text: string } | null = null;
  // The model's words the footnote lane locates claims in: finalTextBeforeKpiFooter minus a block the late
  // strip below removed (a claim inside it is no longer in the delivered note — review fix 2026-10-20).
  let unverifiedClaimsHaystack = finalTextBeforeKpiFooter;
  if (harnessView && chatId) {
    try {
      const textFrozen = actionGuardStruck || harnessTextExempt;
      // A note that was ONLY the model's block was left whole by phase 1 — strip it now.
      const late = textFrozen ? { text: finalText, strippedLines: 0, forgedLines: 0 } : stripModelActionsBlock(finalText);
      if (late.strippedLines) {
        harnessModelBlockLines += late.strippedLines;
        harnessForgedLines += late.forgedLines;
        if (result.parts?.length) result.parts = stripModelActionsBlockFromParts(result.parts).parts;
        unverifiedClaimsHaystack = stripModelActionsBlock(finalTextBeforeKpiFooter).text;
      }
      const applied = applyHarnessReceipts(late.text, harnessView, { quietZero: ownerAskWake || harnessTextExempt || followThroughQuietZero });
      if (!textFrozen && applied.text !== finalText) {
        finalText = applied.text;
        harnessReceiptsSwapped = true;
        if (applied.appendix) {
          harnessAppendix = applied.appendix;
          harnessAppendixPart = { type: 'text', text: `\n\n${applied.appendix}` };
          (result.parts = result.parts || []).push(harnessAppendixPart);
        }
      }
      if (harnessModelBlockLines) harnessReceiptsSwapped = true;
      metadata.harnessActions = applied.harnessActions;
      metadata.harnessReceipts = { ...harnessReceiptsMeta(applied, harnessModelBlockLines), ...(harnessTextExempt ? { textExempt: 'owner_digest' } : {}), ...(followThroughQuietZero ? { followThrough: true } : {}), ...(followThroughNoopLines ? { modelNoopLines: followThroughNoopLines } : {}), ...(followThroughNoopReasonLines ? { modelNoopReasonLines: followThroughNoopReasonLines } : {}) };
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SUPERVISOR_HARNESS_RECEIPTS, sessionId: chatId, stamp: chatMetricStamp, value: applied.harnessActions,
        meta: {
          mode: applied.mode, harnessActions: applied.harnessActions, reportUps: applied.reportUps, notExecuted: applied.notExecuted,
          modelBlockLines: harnessModelBlockLines, tools: [...new Set(harnessView.actions.map((a) => a.tool))].slice(0, 8),
          seat: isProjectSupervisorChat ? 'project_supervisor' : 'supervisor', origin: args.messageOrigin ?? null,
          ...(actionGuardStruck ? { struck: true } : {}),
          ...(harnessTextExempt ? { ownerDigest: true } : {}),
          ...(followThroughQuietZero ? { followThrough: true } : {}),
          ...(followThroughNoopLines ? { modelNoopLines: followThroughNoopLines } : {}),
          ...(followThroughNoopReasonLines ? { modelNoopReasonLines: followThroughNoopReasonLines } : {}),
          ...(rejectBackSwapped ? { rejectBackRetry: true } : {}),
        },
      });
    } catch (err: any) {
      logger.warn(`chat-agent: harness receipts append skipped for ${chatId.slice(0, 8)} (note kept): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // ── BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20) ───────
  // The owner steers by the briefing, and a convicted "dispatched X" line reached it as fact: the
  // guard above delivers an ACTION-class verdict UNMODIFIED (the 2026-09-11 gate flip) and the briefing
  // gate (`!actionGuardStruck`) passes the note straight to generateOwnerBriefing. Now, on a SUPERVISOR
  // machine wake: (1) the W1-4 annotate path covers action-class convictions — ONE trailing observe-only
  // footnote (the W1-4 header, so guard-chrome-redact keeps it out of later wakes' context) names the
  // claims; never a block, never an edit; (2) the same claims ride generateOwnerBriefing as
  // `unverifiedClaims` — their lines are marked "(unverified)" or left out of the briefing; (3) on a
  // ZERO-TOOL wake every send-class claim the unbacked-claim lane found is convicted by construction.
  // A verifier claim is exonerated only by EVIDENCE OF THE ACT in its sentence — an id resolving to an
  // executed action receipt of THIS chat or a message THIS chat sent (unverifiedActEvidenceProbe); the
  // lane / goal / todo a claim merely targets existing is never evidence (review fix 2026-10-20). Zero-
  // tool claims are never id-probed (residualUnbackedClaims already dropped sentences citing a real
  // receipt of this chat). A claim no longer in the note is dropped — claims are located in the model's
  // words AFTER phase 2's late strip (unverifiedClaimsHaystack), and when the harness stripped the note's own
  // ACTIONS TAKEN list the footnote says so (never "nothing above was removed" — review fix 2026-10-20).
  // Placed AFTER the KPI footer and IN FRONT OF the harness appendix (placeUnverifiedFootnote — the appendix
  // stays last, transparent to the guard-chrome tail walk, which then strips this footnote and every trailer
  // before it; footnote-last shielded them — review fix 2026-10-20); the post-delivery verifier audits
  // finalTextBeforeKpiFooter (never this footnote). Fail-open: any error keeps the note
  // and the briefing exactly as before. Kill switches ACTION_CLASS_ANNOTATE_DISABLED=1 (the footnote) and
  // BRIEFING_UNVERIFIED_FILTER_DISABLED=1 (the briefing filter); loop_metrics action_class_annotated.
  let unverifiedFootnote = '';
  let unverifiedFootnoteAppended = false;
  let unverifiedBriefingClaims: UnverifiedClaim[] = [];
  const unverifiedAnnotateOn = !actionClassAnnotateDisabled();
  const unverifiedFilterOn = !briefingUnverifiedFilterDisabled();
  // The owner-briefing gate's own predicate (the gate below reads THIS const): only a supervisor machine
  // WAKE whose note the guard did not strike briefs, so the footnote / metric never promise a filter on a
  // drain / continuation run or a mixed strike (f16cc02a: never claim a containment that did not happen).
  // computer_task claim check (opt-in annotation only): its annotation keeps the gate OPEN — the briefing reads its
  // `- [screen input]` lines back and marks them "(unverified)"; only with the briefing filter off (nothing would mark
  // them) does it close. Struck-note repeat: every repeat annotation closes it (round 5: no run-backed exception).
  const ownerBriefingGateOpen = isSupervisorChat && args.machineWake === true && !!userId && !actionGuardStruck && !struckRepeatBriefingClosed && !(computerClaimAnnotated && briefingUnverifiedFilterDisabled());
  if (
    isSupervisorChat && machineTriggeredRun && userId && chatId && !args.isCancelled?.()
    && (unverifiedAnnotateOn || unverifiedFilterOn)
    && (actionClassObservedClaims.length > 0 || zeroToolSendQuotes.length > 0)
  ) {
    try {
      const zeroTool = runMadeNoToolCall(result.parts as any[]);
      const briefingFiltered = unverifiedFilterOn && ownerBriefingGateOpen;
      const claims = await collectUnverifiedClaims({
        text: unverifiedClaimsHaystack,
        verifierClaims: actionClassObservedClaims,
        zeroToolClaims: zeroTool ? zeroToolSendQuotes : [],
        alreadyAnnotated: guardAnnotatedClaimDetails,
        // Evidence of the ACT only, scoped to this chat (the probe and its time budget fail toward EVIDENCE).
        actEvidence: unverifiedActEvidenceProbe(chatId, userId),
      });
      if (claims.length) {
        if (unverifiedAnnotateOn) {
          unverifiedFootnote = renderUnverifiedClaimsFootnote(claims, { zeroTool, briefingFiltered, harnessReplacedBlock: harnessModelBlockLines > harnessForgedLines, harnessStrippedCopies: harnessForgedLines > 0 });
          finalText = placeUnverifiedFootnote(finalText, unverifiedFootnote, harnessAppendix);
          const footnotePart = { type: 'text' as const, text: unverifiedFootnote };
          const parts = (result.parts = result.parts || []);
          const appendixAt = harnessAppendixPart ? parts.indexOf(harnessAppendixPart) : -1;
          if (appendixAt >= 0) parts.splice(appendixAt, 0, footnotePart);
          else parts.push(footnotePart);
          unverifiedFootnoteAppended = true;
        }
        if (briefingFiltered) unverifiedBriefingClaims = claims;
        const bySource = (src: string) => claims.filter((c) => c.source === src).length;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.ACTION_CLASS_ANNOTATED,
          sessionId: chatId,
          stamp: chatMetricStamp,
          value: claims.length,
          meta: {
            ...(supervisorScope ? { supervisorScope } : {}),
            zeroTool,
            footnoted: unverifiedFootnoteAppended,
            briefingFiltered,
            sources: { action_verifier: bySource('action_verifier'), zero_tool_dispatch: bySource('zero_tool_dispatch') },
            kinds: Array.from(new Set(claims.map((c) => c.kind))).slice(0, 6),
            claims: claims.slice(0, 4).map((c) => ({ kind: c.kind, source: c.source, quote: c.quote.slice(0, 120) })),
          },
        });
        logger.info(`chat-agent: ${claims.length} unverified action claim(s) on supervisor ${chatId.slice(0, 8)}'s machine note (${zeroTool ? 'zero-tool wake' : 'observe-only verdict'}) — ${unverifiedFootnoteAppended ? 'footnoted' : 'footnote off'}${briefingFiltered ? ', briefing filter on' : ''} (BRIEFING-UNVERIFIED-FILTER)`, { source: 'chat-agent' });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: unverified-claims footnote lane skipped (non-fatal — note kept unchanged): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // Session titles (2026-09-27): the supervisor's step half goes idle at the finalize (best-effort; rate limited).
  if (isSupervisorChat && chatId) {
    void import('../platform/session-titles')
      .then((m) => m.setSupervisorStep(chatId, m.idleSinceStep(), { reason: 'idle', emit: (_t, d) => send('chat-title', { chatId, title: d?.title }) }))
      .catch(() => {});
  }
  // ── Markdown-structure lint + never-ship-raw-pipes backstop (ticket 942db7aa,
  // 2026-10-15: the Fleet Supervisor's owner-facing note emitted a table with
  // every data row joined on one line behind a blank — GFM ended the table at
  // the blank and the owner saw a wall of raw pipes: "again your formattuinbg
  // is all messed up"). The repair pass (normalizeAssistantMarkdown, on `raw`
  // above + per-part at the persist below) reflows what it can reflow; this
  // seam runs AFTER every guard/annotation lane that can rewrite finalText
  // (action guard, reject-back retry, claims lane, deferral lane,
  // turn-continuation), so the lint sees the text that will actually persist.
  // Machine notes only (machine wakes + supervisor-chat machine runs): human
  // turns are the owner's own words — the surface the incident named.
  //   phase 'emitted' — the structural classes the note carried BEFORE the
  //     backstop (loop metric markdown_lint_strike; the regression RATE the
  //     ticket asks to measure);
  //   degrade — any pipe-led line still outside a structurally valid GFM table
  //     (the repair's fail-safe classes: ragged bodies, gated-out prose tails)
  //     is degraded to plain bullets so raw pipes NEVER ship;
  //   phase 'residual' — the backstop DID rewrite (those lines would have
  //     shipped as raw pipes without it).
  // Fail-open: a lint/degrade error keeps the note unchanged. Kill switch
  // MARKDOWN_NOTE_LINT_DISABLED=1 disables rows + degrade together.
  let markdownLintSwapped = false;
  if (
    (args.machineWake === true || (isSupervisorChat && machineTriggeredRun)) &&
    !markdownLintDisabled() &&
    chatId
  ) {
    try {
      // 'emitted' (942db7aa N3): the classes the MODEL emitted — snapshotted
      // BEFORE the repair pass (raw) or on the reject-back retry, so the row
      // measures the regression rate, not the repair-miss rate.
      if (markdownLintEmittedClasses.length > 0) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.MARKDOWN_LINT_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            surface: 'machine_note',
            phase: 'emitted',
            classes: markdownLintEmittedClasses,
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
      }
      const degraded = degradeMachineNotePipes(finalText);
      if (degraded.text !== finalText) {
        finalText = degraded.text;
        markdownLintSwapped = true; // live viewers swap to the degraded text
        // 'residual' re-lints the delivered text AT the seam: the classes that
        // remain after the repair pass — exactly what would have shipped as
        // raw pipes without the backstop.
        let residualClasses: string[] = [];
        try {
          residualClasses = [...new Set(lintMarkdownNote(finalText).strikes.map((s) => s.cls))];
        } catch { /* telemetry only */ }
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.MARKDOWN_LINT_STRIKE,
          sessionId: chatId,
          stamp: chatMetricStamp,
          meta: {
            surface: 'machine_note',
            phase: 'residual',
            classes: residualClasses,
            degradedLines: degraded.degradedLines.length,
            ...(supervisorScope ? { supervisorScope } : {}),
          },
        });
        logger.info(
          `chat-agent: markdown-lint degraded ${degraded.degradedLines.length} malformed pipe line(s) on machine note (ticket 942db7aa): ${degraded.degradedLines.map((l) => l.slice(0, 60)).join(' | ')}`,
          { source: 'chat-agent' },
        );
      }
      // PARTS carry (dc7fd17a doctrine — the transcript UI renders parts when
      // present, so the content pipeline alone would leave the malformed note
      // visible): run each non-chrome text part through the SAME pipeline the
      // content took — the repair pass first (normalize; reflows what it can,
      // including the rebuildable one-line-table classes), THEN the degrade
      // backstop. Reverse order would bulletize tables the repair can rebuild.
      // Harness guard chrome stays byte-identical (the redact audit contract).
      // The persist map below re-normalizes (idempotent — bullets carry no
      // pipes, so the backstop's output survives it unchanged).
      if (result.parts?.length) {
        result.parts = (result.parts as any[]).map((p: any) =>
          p?.type === 'text' && typeof p.text === 'string' && !isGuardChromeText(p.text || '')
            ? { ...p, text: degradeMachineNotePipes(normalizeAssistantMarkdown(p.text)).text }
            : p,
        );
      }
    } catch (err: any) {
      logger.warn(`chat-agent: markdown-lint skipped (non-fatal — note kept unchanged): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  const carriedBlocks = collectStructuredBlocks(result.parts, finalText);
  // Dig deeper (compute policy): the rung's answer posts as a NEW message
  // titled "Deeper findings" — never a rewrite of the earlier bubble.
  const deeperTitle = args.escalation && finalText.trim() && !/^\s*(\*\*|#+\s*)?deeper findings/i.test(finalText) ? `**${DEEPER_FINDINGS_TITLE}**\n\n` : '';
  // The carried section stays the row's LAST paragraph — get_chat_messages keeps a long row's tail for it
  // (ticket 835595b7 F4) — so a supervisor harness appendix sits in front of it (the stored-note owner
  // briefing peels the section before it strips the appendix: owner-briefing prepareBriefingNote).
  // Ticket 4d161561: the row is the string the live-chat audit convicts, and it is NOT only the finalize
  // text — the carried structured blocks and the "Deeper findings" title are appended right here, after
  // the gate ran. scrubDeliveredRowContent gates that composed head and preserves a trailing harness
  // appendix byte-identically (harness-authored, and the readers peel it by shape).
  const assistantContent = scrubDeliveredRowContent(carriedBlocks
    ? `${deeperTitle}${finalText.trim()}\n\n---\n${CARRIED_FORWARD_LABEL}\n\n${carriedBlocks}`
    : `${deeperTitle}${finalText.trim()}`) || EMPTY_RUN_FALLBACK_NOTE; // ticket 08e58e1d: shared harness-envelope constant — the watchdog's note scan excludes this shape
  let assistantRowId: string | null = null; // the persisted row — the complete event carries it and the late cross-check revises it
  // build 2026-10-08 A1: an answer-first follow-through round an owner message preempted and the harness re-queued
  // persists NO row — its partial ("(Stopped.)") is not a result and was never stopped by the owner; the re-run posts it.
  if (chatId && !afResumed) {
    // Captured (owner 2026-09-04): the wake note's durable id seeds the owner
    // briefing's sourceNoteId below. A failed persist degrades to null — the
    // run still finalizes exactly as before.
    const assistantRow = await prisma.crossModelMessage.create({
      data: {
        ...(plannedRowId ? { id: plannedRowId } : {}),
        chatId, role: 'assistant',
        content: assistantContent,
        metadata,
        // Ticket dc7fd17a: text parts accumulate the RAW model stream (the
        // sse-adapter only cuts [FOLLOWUPS]/canvas from the forwarded SSE
        // chunks), so persisting them unstripped leaked the raw "[FOLLOWUPS]"
        // block into the reloaded chat detail view — CodeSessionView renders
        // parts verbatim and ignores the (clean) content when parts exist.
        // Strip the same structured blocks content gets, non-mutating: the
        // un-stripped result.parts stays authoritative for the post-delivery
        // verifier (1788/1793 below).
        // Owner report chat 7dc031fb ("formatting is all messed up again"):
        // ALSO run each text part through normalizeAssistantMarkdown — content
        // gets the repair at finalize (raw = normalizeAssistantMarkdown(raw)
        // above), but the reloaded chat renders PARTS, so every markdown
        // repair (collapsed tables, flattened lists — the 44204e09 classes)
        // was bypassed since the C1 unified-rendering flip. Same order as the
        // content pipeline: normalize first (canvas/[FOLLOWUPS] regions pass
        // through byte-identical), then strip. Per-part normalize is SAFE as a
        // whole-document operation: the agent loop pushes exactly one text
        // part per assistant TURN (coding/agent.ts — parts.push of the turn's
        // cleanText), and the guard notice is its own standalone part, so a
        // text part is always a complete document, never a fragment split
        // mid-table/mid-list. EXEMPT: harness-authored guard chrome (the
        // banner-led notice unshifted above) persists byte-identical — the
        // guard-chrome-redact.ts audit-trail contract; the normalizer repairs
        // MODEL-degraded markdown, never harness text.
        parts: (result.parts?.length
          ? result.parts
              .filter(p => p.type !== 'reasoning')
              .map(p => (p.type === 'text'
                // Ticket 4d161561: the SAME scaffolding gate the content took, so a reloaded chat
                // (which renders PARTS, ignoring content) can never show a shape the content strip
                // removed. Guard chrome stays byte-identical (the exemption inside the gate already
                // covers the two banner shapes; isGuardChromeText keeps the normalizer's hands off).
                ? { ...p, text: stripAnswerScaffolding(stripAnswerMarkup(isGuardChromeText(p.text || '') ? (p.text || '') : normalizeAssistantMarkdown(p.text || ''))).text }
                : p))
          : undefined) as unknown as object[] | undefined,
      },
    }).catch(err => { logger.error('chat-agent: assistant persist failed:', err); return null; });
    assistantRowId = (assistantRow as any)?.id ?? null;
    // Ticket c7d5f885: bind the shipped row + run meta to the late-council
    // holder and settle it (grace window, then ONE council_addendum follow-up
    // row if the run went degraded — no-op otherwise). fire-and-forget: the
    // holder never rejects, and a null assistantRowId (persist failed) no-ops.
    lateCouncil.bind(assistantRowId, { models, modelLabels: SEAT_MODEL_LABELS, mode });
    void lateCouncil.settle();
    // roster 2026-10-06 D-1: fold this HUMAN turn (a Dig-deeper rung included) into the chat's session roster —
    // read-modify-write, fire-and-forget, never on the answer path — plus one session_roster row. Supervisor chats and
    // machine runs never write one; mode off / SESSION_ROSTER_DISABLED=1 writes nothing.
    if (userId && !isSupervisorChat && !runIsMachineTriggered) {
      void saveSessionRosterTurn(chatId, {
        messageId: assistantRowId,
        planLane: turnPlanFinal?.cls ? turnPlanFinal.lane : null,
        ranLane: rosterRanLane,
        lead: orchestratorModel,
        checker: rosterChecker ?? (callInRec?.ok && callInRec.role === 'checker' ? callInRec.model : null),
        colleagues: [...rosterColleagues, ...(callInRec?.ok && callInRec.role === 'colleague' ? [callInRec.model] : [])],
        callIn: callInRec ? { role: callInRec.role, model: callInRec.model, ok: callInRec.ok } : null,
        escalationRung: args.escalation?.rung ?? null,
      }).then((saved) => {
        if (saved) recordLoopMetric({ kind: LOOP_METRIC_KINDS.SESSION_ROSTER, sessionId: chatId, stamp: chatMetricStamp, meta: sessionRosterMetricMeta(chatId, saved, rosterTrace) });
      }).catch(() => {});
    }
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    // Owner ask close / re-wake on SUPERVISOR chats (tt-rd audit 2026-09-27,
    // findings 3 + 4): a real reply closes the kind:'ask' ledger row captured
    // from this owner message (harness-written evidence `msg <replyId8>`;
    // SUPERVISOR_ASK_AUTOCLOSE_DISABLED=1); a harness error envelope as the
    // reply (the EMPTY_RUN_FALLBACK_NOTE / a provider-killed turn) enqueues
    // ONE machine re-wake so the owner's question is answered
    // (OWNER_ASK_REWAKE_DISABLED=1). Both fire-and-forget, never on the path.
    if (isSupervisorChat && ownerTurnUserRowId && !runIsMachineTriggered && userId) {
      const askMessageId = ownerTurnUserRowId;
      const envelope = result.modelErrored === true || assistantContent === EMPTY_RUN_FALLBACK_NOTE || isHarnessErrorNote(assistantContent);
      // build 2026-10-08 A1: an answer-first split whose follow-through is ARMED closes the ask only when that task
      // settles (the round's finalize, source 'continuation') — never on the split answer.
      if (!envelope && assistantRowId && !(ownerAfAct && afArmedTask)) {
        void closeAskOnReply(chatId, userId, { askMessageId, replyMessageId: assistantRowId }).catch(() => {});
      } else if (envelope) {
        const askAt = userTurnAt ?? new Date();
        void import('../platform/owner-asks')
          .then((m) => m.rewakeForUnansweredOwnerAsk({ chatId, askMessageId, askText: message, askAt, reason: result.modelErrored === true ? 'provider_error' : 'empty' }))
          .catch((err: any) => logger.warn(`chat-agent: owner-ask re-wake failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' }));
      }
    }
    // Owner-ask WAKE close (fixer 2026-09-27, finding upward-chatter-1): the
    // [OWNER ASK UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge answered in real
    // text (ownerAskAnswered above) — close every ask it was raised for, with
    // this reply row as the harness evidence. Fire-and-forget, never on the path.
    if (ownerAskAnswered && assistantRowId && userId) {
      const replyMessageId = assistantRowId;
      for (const askMessageId of args.ownerAskMessageIds ?? []) {
        void closeAskOnReply(chatId, userId, { askMessageId, replyMessageId, source: 'machine_wake' }).catch(() => {});
      }
    }
    // Audit gate-runtime-4: the inline verdict's deferred SHADOW ask landed
    // AFTER the row persisted without its stash ⇒ one bounded patch of
    // metadata.check.verdict so a later thumbs / tap can still label it.
    // Never on the response path; a failed patch changes nothing.
    const inlineVerdictAtPersist = inlineRevisionVerdict as RevisionMaterialVerdict | null;
    const pendingShadowAsk = inlineVerdictAtPersist?.pending;
    if (assistantRowId && inlineVerdictAtPersist && pendingShadowAsk && !inlineVerdictMeta(inlineVerdictAtPersist).verdict?.decision) {
      const rowId = assistantRowId;
      const v = inlineVerdictAtPersist;
      void pendingShadowAsk.then(async () => {
        const meta = inlineVerdictMeta(v).verdict;
        if (!meta?.decision) return;
        const row = await prisma.crossModelMessage.findUnique({ where: { id: rowId }, select: { metadata: true } }).catch(() => null);
        const current = (row?.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, any> : null;
        if (!current?.check || current.check.verdict?.decision) return;
        await prisma.crossModelMessage.update({
          where: { id: rowId },
          data: { metadata: { ...current, check: { ...current.check, verdict: { ...(current.check.verdict ?? {}), ...meta } } } as object },
        });
      }).catch((err: any) => logger.warn(`chat-agent: revision_material stash patch skipped (${err?.message ?? err})`, { source: 'chat-agent' }));
    }
    // Pre-delivery action-guard strike feedback (ticket 51ed3a65): inject the
    // guard-returned correction as a user-role harness message AFTER the
    // replacement assistant row, so "your last status note" reads
    // chronologically and the next wake sees the SPECIFIC struck claims
    // in-window. Mirrors the post-delivery lane's correction row (which stands
    // down on a strike — no double inject); survives guard-chrome redaction by
    // role gate. Best-effort: a failed inject never breaks finalize.
    if (actionGuardCorrection) {
      await prisma.crossModelMessage.create({
        data: {
          chatId,
          role: 'user',
          content: actionGuardCorrection,
          metadata: { origin: 'machine', verifier: 'action-verifier' },
        },
      }).catch((err: any) => logger.warn(`chat-agent: action-guard correction inject failed (non-fatal): ${err?.message}`, { source: 'chat-agent' }));
    }
    // ── Owner briefing (owner 2026-09-04 — the plain-English layer) ──────────
    // A SUPERVISOR machine-wake run that DELIVERED its note (guard-passed:
    // struck notes are harness chrome, not a note) fires the briefing
    // generator: 2-4 plain sentences persisted as a NORMAL assistant message
    // (metadata.kind 'owner_briefing') the noise classifiers exempt, so the
    // owner reads "actual agent messages" instead of audit artifacts.
    // Fire-and-forget + fail-open — the generator's own Redis NX lock
    // (fleet:briefing:<chatId>, 90min TTL) turns hook-wake storms into a
    // steady ~90min-floor rhythm under the 2h sweep heartbeat.
    if (ownerBriefingGateOpen && finalText.trim().length > 0) {
      void import('../fleet/owner-briefing.service')
        .then((m) => m.generateOwnerBriefing({
          chatId, userId,
          // BRIEFING-UNVERIFIED-FILTER: the briefing reads the model's note (the harness footnote off) and
          // the unverified claims it named — their lines are marked "(unverified)" or left out. The harness
          // appendix is off too (review fix 2026-10-20): its no-op line parsed as the model's 'WAKE: no-op'.
          noteContent: stripUnverifiedFootnote(harnessAppendix ? stripTrailingHarnessAppendix(finalText) : finalText, unverifiedFootnote),
          ...(unverifiedBriefingClaims.length ? { unverifiedClaims: unverifiedBriefingClaims } : {}),
          ...(assistantRow && (assistantRow as any).id ? { sourceNoteId: (assistantRow as any).id as string } : {}),
        }))
        .catch((err: any) => logger.warn(`chat-agent: owner-briefing generation failed (non-fatal): ${err?.message}`, { source: 'chat-agent' }));
    }
  } else if (!userId && args.sessionId) {
    // Anonymous: append the turn to the Redis session history so the next
    // anonymous turn loads it as conversation context (exactly what the legacy
    // controller did after runQueryPipeline returned).
    contextService.saveToSessionHistory(args.sessionId, message, assistantContent)
      .catch(err => logger.error('chat-agent: session history persist failed:', err));
  }
  // Compute policy `facts` row (cp/labels 2026-09-26): ONE finalize label per
  // human turn's compute_policy decision — never `escalated` (that is the
  // tap's), never on machine turns / escalation runs (no decision). Written for
  // GUEST turns too (audit 2026-09-26 guest-persistence-2: it sat inside the
  // chatId branch, so a third of the gate's decisions were permanently
  // unlabelled) — stamped guest + segment so the readiness ruler can keep them
  // out of the window-closed-negative rule (a guest can never escalate).
  // Fire-and-forget through Module B's adapter → Module A's writer.
  if (!runIsMachineTriggered && plan.decisionId) {
    labelComputePolicyFacts({
      decisionStash: plan.stash ?? { id: plan.decisionId, answers: plan.answers, mode: plan.mode },
      facts: computePolicyFacts, requestedPreset: depthPreset,
      turn: {
        ...(firstChunkAt ? { ttftMs: firstChunkAt - startedAt } : {}), completionMs: Date.now() - startedAt,
        ...(typeof spentUsdAtFinalize === 'number' ? { spentUsd: spentUsdAtFinalize } : {}),
        council: plan.council, ...(checkState ? { checkState: checkState.state } : {}), ...(args.escalation ? { escalationRung: args.escalation.rung } : {}),
      },
      acted: plan.source === 'gate_act', failed: orchestratorEmpty, sessionId: runSessionId,
      guest: !userId, segment: planSegment,
      // A turn whose Dig-deeper chip was never shown can never pair with an escalated:true —
      // its facts row is tagged excludeFromFit (audit telemetry-readiness-9).
      escalatable: !depthChipDisabled,
    });
  }

  // ── Stale-title repair (legacy parity — adversarial review M2) ───────────
  // The up-front title only fires on the FIRST message (history empty); if its
  // API chain failed there — or never finished before the process moved on —
  // the chat would keep the raw truncated-question placeholder forever.
  // Legacy repaired this on early turns (≤4 prior messages). Same here —
  // INCLUDING turn 1 itself (ticket 26385762): the up-front path runs at
  // humanTurnCount === 0, so a one-question chat previously had NO second
  // chance — the gate below used to require humanTurnCount > 0, exactly
  // excluding the turn that needed the repair. At run end we now also hold
  // real assistantContent, so generateTitle's heading heuristic is reachable
  // where the up-front ''-answer call could never use it. Fire-and-forget;
  // the 'chat-title' event renames the sidebar row live. Owner-scoped
  // updateMany, same as the up-front write.
  // Same pinning guards as the up-front path (2026-08-13): machine-wake turns
  // never repair titles, and supervisor titles are pinned — the prod incident's
  // already-retitled supervisor rows have stale-shaped titles ('…'-terminated)
  // and would otherwise be RE-titled from the next wake payload on turns 2-3.
  // Window bounds use humanTurnCount (audit p10) so machine-wake rows in a
  // chat's early history can't close the repair window before turns 2-3.
  // Ghost mode (owner 2026-10-22): the cloud repair never runs on a ghost
  // chat. Ticket de60115d: the ghost chat still gets its repair — through
  // generateGhostTitle (designated endpoint / local cleaner, never cloud) —
  // so a placeholder-shaped title doesn't survive past turn 1.
  if (userId && chatId && !args.machineWake && humanTurnCount <= 4 && ghostRun) {
    void (async () => {
      try {
        const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true, isSupervisor: true, ghostMode: true } });
        if (chat?.isSupervisor) return; // supervisor titles are pinned by design
        if (chat && chat.ghostMode !== true) return; // ghost was turned OFF mid-run: this arm stands down (the run-start ghostRun flag still masks the normal arm for THIS turn) — the normal repair covers the NEXT turn
        const title = chat?.title;
        if (!title) return;
        if (!isStaleChatTitle(title, message)) return;
        const newTitle = await moonshotIntegration.generateGhostTitle(message, assistantContent.substring(0, 300), ghostEndpoint.spec);
        if (!newTitle || newTitle === 'New Conversation' || newTitle === 'New Chat' || newTitle === title) return;
        const wrote = await prisma.crossModelChat.updateMany({ where: { id: chatId, userId, isSupervisor: false, title, ...titlePinGuard() }, data: { title: newTitle } })
          .catch((err: any) => { logger.warn(`chat-agent: ghost title repair write failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }); return null; });
        if (wrote && wrote.count > 0) {
          logger.info(`chat-agent: repaired stale ghost chat title for ${chatId}: "${title}" → "${newTitle}"`);
          send('chat-title', { chatId, title: newTitle });
        } else if (wrote) {
          logger.info(`chat-agent: ghost title repair for ${chatId} stood down — title changed from "${title}" mid-repair (CAS, benign)`);
        }
      } catch (err: any) {
        logger.warn(`chat-agent: ghost stale title repair failed for ${chatId}: ${err.message}`, { source: 'chat-agent' });
      }
    })();
  }
  if (userId && chatId && !args.machineWake && humanTurnCount <= 4 && !ghostRun) {
    void (async () => {
      try {
        const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true, isSupervisor: true } });
        if (chat?.isSupervisor) return; // supervisor titles are pinned by design
        const title = chat?.title;
        if (!title) return;
        // Stale shapes: ONE shared definition (title-placeholder.ts) that
        // matches the frontend's pre-seeded placeholder formula exactly
        // (ticket 26385762 — the two ends previously matched by two
        // accidents: untrimmed slice+ellipsis vs trimmed substring without).
        if (!isStaleChatTitle(title, message)) return;
        let newTitle = await moonshotIntegration.generateTitle(message, assistantContent.substring(0, 300)).catch(() => null);
        if (!newTitle || newTitle === 'New Conversation' || newTitle === 'New Chat' || newTitle.endsWith('…') || newTitle === title) {
          // Local fallback: the SAME hardened cleaner generateTitle's own
          // fallback uses (audit p10 — this block carried an un-patched
          // duplicate of the pre-PR-#181 cleaner: no email strip, no input
          // bound, and a raw-message fallback that re-leaked the exact PII
          // the PR fixed). Never the raw question: an unusable clean result
          // leaves the existing title alone instead.
          const cleanQ = cleanQuestionForTitle(message);
          newTitle = cleanQ.length >= 4 ? cleanQ.substring(0, 60) : null;
        }
        if (!newTitle || newTitle === title) return;
        // Compare-and-swap write guard (PR #367 blocking review — the same
        // turn-1 double-writer race, other side): the where carries the STALE
        // title read above, so count===0 means another writer (the late
        // up-front chain) landed between our read and this write. That is an
        // expected benign outcome of the turn-1 overlap — stand down at info,
        // NOT warn.
        const wrote = await prisma.crossModelChat.updateMany({ where: { id: chatId, userId, isSupervisor: false, title, ...titlePinGuard() }, data: { title: newTitle } })
          .catch((err: any) => { logger.warn(`chat-agent: title repair write failed for chat ${chatId}: ${err?.message || err}`, { source: 'chat-agent' }); return null; });
        if (wrote && wrote.count > 0) {
          logger.info(`chat-agent: repaired stale chat title for ${chatId}: "${title}" → "${newTitle}"`);
          send('chat-title', { chatId, title: newTitle });
        } else if (wrote) {
          logger.info(`chat-agent: title repair for chat ${chatId} stood down — title changed from "${title}" mid-repair (CAS, benign)`);
        }
      } catch (err: any) {
        logger.warn(`chat-agent: stale title repair failed for ${chatId}: ${err.message}`, { source: 'chat-agent' });
      }
    })();
  }

  // Background memory extraction — identical to legacy, logged-in users only
  // (anonymous sessions have no durable memory stores to update).
  // 2026-09-14 memory unification: a machine wake / agent-sent turn is NOT a
  // human statement — machineRun keeps the pipeline to project extraction
  // (with the pollution guard) and never files the prompt as a user fact,
  // thread summary or user-scope conversation row.
  // Supervisor WAKE NOTES are audit artifacts about other lanes' work (which
  // the lanes' own runs already extract) — they never feed the extractor, so
  // hourly sweeps cannot flood project memory with "decisions" about no-ops.
  if (userId) {
    // Ghost mode (owner 2026-10-22): a ghost chat NEVER feeds the extractors —
    // no personal facts, no episodic distill, no thread state, no project
    // extraction. The posture is "this chat is private": its transcript stays
    // (the user's own rows) but nothing about it is learned or carried into
    // any other chat. One gate covers the whole updateContextAsync pipeline.
    if (ghostRun) {
      logger.info(`chat-agent: ghost chat ${chatId ?? 'guest'} — memory/learning extraction skipped`, { source: 'chat-agent' });
    } else {
    // RAW origin read on purpose (owner-dispatch 2026-10-01): the relayed text
    // is SUPERVISOR-authored, so it never feeds the personal-fact extractor —
    // the same rule the coding executor keeps (isHumanTypedRunInput).
    const machineRun = args.machineWake === true || (args.messageOrigin != null && args.messageOrigin !== 'user');
    if (!(machineRun && isSupervisorChat)) {
      // 2026-09-15 memory-wipe incident: a REAL user turn in a supervisor chat
      // is operational text — supervisorChat keeps it out of the PERSONAL
      // fact extractor (facts + rejections) while the episodic distill,
      // thread state and project extraction still run.
      // audit 2026-10-08 W4-2: what backed this answer (memory/answer-grounding.ts) — an answer no tool result backed is
      // extracted as UNVERIFIED (only the user's statements are stored; nothing becomes "confirmed").
      updateContextAsync({ userId, projectId: ctx.projectId, chatId, userMessage: message, synthesis: finalText, machineRun, supervisorChat: isSupervisorChat, answerGrounding: answerGroundingFromParts(result.parts), ...(ctx.projectMemoryIsolated ? { skipProjectState: true } : {}) });
    }
    }
  }

  // Phantom-claim ACTION VERIFIER (PR #295 port, 2026-08-22): a SUPERVISOR
  // machine wake's final note is audited against the run's REAL tool log
  // (result.parts) — fabricated "dispatched/sent/scheduled" claims produce a
  // deduped mishap ticket, an in-thread [ACTION VERIFIER] correction, and a
  // durable state-doc refutation. Fire-and-forget + dynamic import (same
  // discipline as the hooks finalize below): it never blocks or fails the run.
  // Ticket ae085617 widened the net: NON-supervisor chats are audited too
  // whenever the final text asserts consequential platform actions (the
  // dependency-free keyword pre-gate keeps no-claim turns free — no LLM call).
  // Machine-triggered runs get a machine-authored 'user'-row correction;
  // user-watched turns get an ASSISTANT-role retraction in-thread (ticket
  // d78f477b — the human who just read the phantom claim must see it
  // corrected; never a 'user' row, which would render as a bubble they never
  // typed).
  // SKIP when the pre-delivery guard struck (ticket fcc4dbb4): the replacement
  // IS the correction and the deduped ticket + refutation already fired inside
  // guardMachineWakeFinalAnswer — running the post-delivery lane too would
  // double-ticket (the normalized-title dedup is only the backstop) and inject
  // a redundant correction bubble.
  // SINGLE-AUDIT (ticket fc337153): ALSO skip when the guard audited to a
  // CLEAN verdict. The two lanes share ONE matcher but extract with TWO
  // independent LLM passes, and after a reject-back the guard's second pass
  // exonerates via extraEvidenceHaystacks this lane never receives — so a
  // post-delivery re-audit can only DIVERGE: it convicted a guard-acquitted
  // supervisor note at 2026-09-11T02:17Z, delivering the phantom and
  // reopening the P5 ticket for pure coin-flip churn. A guard that FAILED
  // OPEN (audited:false) still gets this lane as its backstop.
  if (userId && chatId && !actionGuardStruck && !actionGuardAudited) {
    // (ticket b216475a) Widened from args.machineWake to machineTriggeredRun:
    // agent-anchored supervisor runs (origin 'agent', machineWake unset — the
    // 2026-09-13 fabricated-ticket-ids incident shape) get the post-delivery
    // verifier as the fail-open backstop when the guard didn't audit.
    if (isSupervisorChat && machineTriggeredRun) {
      void import('../platform/action-verifier')
        .then((m) => m.verifySupervisorRunAsync({ chatId, userId, finalText: finalTextBeforeKpiFooter, parts: (result.parts || []) as any[], receipts: result.receipts ?? [], runStartedAt: new Date(startedAt), supervisorScope, crossCheckDelivered: crossCheckMerged, councilDispatched: dispatchRounds > 0, harnessContinuationLine: continuationRewrote ? continuationLine : null }))
        .catch((err: any) => logger.warn(`chat-agent: action verifier failed to load (non-fatal): ${err?.message}`, { source: 'chat-agent' }));
    } else if (hasActionClaimKeywords(finalText)) {
      // (ticket 4deaf460) The pre-fix gate was `!isSupervisorChat &&
      // hasActionClaimKeywords(...)` — a HUMAN turn on a supervisor chat fell
      // into a routing dead zone: branch 1 above is machine-triggered-only,
      // and branch 2 refused supervisor chats outright. That is exactly the
      // 2026-10-08 17:51Z incident (chat 99e63f86, the StAnne project
      // supervisor): the owner asked "message the tt-rd supervisor", the
      // assistant's answer asserted "I've messaged chat d1d0b346" while the
      // run's receipt pool held ZERO sends (the real send landed only at
      // 17:53Z, receipt 35fcbce8, after the owner's correction) — and no
      // verifier lane ran, so the phantom reached the human unchallenged.
      // Now: a human-anchored turn on a supervisor chat rides the GENERAL
      // post-delivery lane (the pre-delivery guard stays machine-only by
      // design — its reject-back re-orchestration is a machine-wake shape).
      // Flags: supervisor:true keeps the state-doc ledger exoneration + the
      // durable refutation (the consequence shell's own comment anticipated
      // this route: "a human turn on a SUPERVISOR chat still gets the durable
      // refutation"), while machineTriggered stays FALSE so the consequence
      // is the d78f477b HUMAN shape (observe-only ticket by default,
      // assistant-role retraction under ACTION_VERIFIER_ENFORCE=1) — never a
      // machine-authored 'user' row in a thread the human is actively reading.
      void import('../platform/action-verifier')
        .then((m) => m.verifyRunActionClaimsAsync({
          chatId, userId, finalText, parts: (result.parts || []) as any[],
          supervisor: isSupervisorChat || undefined,
          supervisorScope: isSupervisorChat ? supervisorScope : undefined,
          machineTriggered: args.machineWake === true,
          receipts: result.receipts ?? [],
          // Cross-wake exoneration anchor: the TURN's start (a claim can only be
          // exonerated by receipts written before it).
          runStartedAt: new Date(startedAt),
          // (ticket 899554af) TRUE cross-check narration exoneration: when the
          // L2 Double Checker's draft was ACTUALLY merged this turn (injected
          // mid-loop or reconciled in — crossCheckMerged), the synthesis's
          // "I passed it to a crossmodel agent (cross_checker) and merged its
          // read with mine" is TRUE — the pipeline peer mints no receipt, so
          // without this anchor the pool convicts it as a phantom [dispatch]
          // (chat bb8b8c99, 2026-09-19T00:52Z).
          crossCheckDelivered: crossCheckMerged,
          // (ticket 7cabb0cc) L3 twin: a run whose council genuinely
          // dispatched (dispatchRounds > 0) may truthfully narrate the
          // council round — the colleague runs mint no receipt and leave no
          // part, so without this anchor the pool convicts the honest
          // dispatch narration (chat 182f27b7, 2026-10-08).
          councilDispatched: dispatchRounds > 0,
          // (ticket 5c7727c4) The harness's OWN continuation line is not the
          // model's claim to make or ours to convict: when the continuation
          // machinery rewrote this answer's closing, pass the exact template
          // line it appended so the action lanes judge the model's prose
          // alone (the citation lanes still read the full note).
          harnessContinuationLine: continuationRewrote ? continuationLine : null,
        }))
        .catch((err: any) => logger.warn(`chat-agent: action verifier failed to load (non-fatal): ${err?.message}`, { source: 'chat-agent' }));
    }
  }

  // ── iMessage send — reasoning-based, post-synthesis (no keyword routing) ──
  // Only when the user has a paired Mac. A classifier reasons over the
  // conversation + the composed answer to decide if the user wants to send a
  // text now, and extracts the recipient + the composed message body. If so we
  // surface the confirm-and-send card (nothing is sent until the user taps Send).
  // (Ported verbatim from the legacy controller's post-pipeline block.)
  // audit 2026-10-08 W4-6: never on a supervisor chat, never on a turn that already messaged in-app
  // (imessage/draft-skip.ts; IMESSAGE_DRAFT_INAPP_SKIP_DISABLED=1 restores every-turn classification).
  const imessageSkip = args.imessagePairedAgentId
    ? imessageDraftSkipReason({ supervisorChat: isSupervisorChat, toolNames: toolNamesCalled(result.parts) })
      // Ghost mode (owner 2026-10-22): the classifier ships the message +
      // answer (+ history) to the utility-LLM and a decision ask — a ghost
      // chat's content never leaves for a cloud model. The user can still
      // send iMessages from a ghost chat with the send tool itself; only the
      // passive draft-suggestion classifier is off.
      ?? (ghostRun ? 'ghost' : null)
    : null;
  if (imessageSkip) {
    recordLoopMetric({ kind: 'imessage_draft_skipped', sessionId: runSessionId, stamp: chatMetricStamp, meta: { reason: imessageSkip, ...(chatId ? { chatId } : {}) } });
  }
  if (args.imessagePairedAgentId && !imessageSkip) {
    try {
      const { classifySendDraft, resolveNamedChat } = await import('../imessage/nlp');
      const draft = await classifySendDraft(message, finalText, ctx.conversationHistory, []);
      if (draft && draft.text) {
        let finalDraft = draft;
        // Resolve a name → phone/email against the Mac's chat list only now
        // (avoids a per-query Mac round-trip on non-send turns).
        if (!draft.resolved && draft.displayName) {
          try {
            const { agentBroker, IMESSAGE_READ_DISPATCH_TIMEOUT_MS } = await import('../imessage/agent-link');
            const c = await agentBroker.dispatch(args.imessagePairedAgentId, 'list_chats', { limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS);
            if (Array.isArray(c)) {
              const m = resolveNamedChat(draft.displayName, c);
              if (m) finalDraft = { ...draft, to: m.identifier || '', displayName: m.displayName || m.identifier || draft.displayName, resolved: !!m.identifier };
            }
          } catch (e: any) { logger.warn(`iMessage recipient resolve failed (non-blocking): ${e?.message || e}`, { source: 'chat-agent' }); }
        }
        // E5 (2026-09-25): a draft carrying a DEFERRED imessage_send decision
        // parks it (Redis, short TTL) and hands the card its id — the card's
        // Send / Cancel writes the outcome row (send-draft-outcome.ts). A
        // failed park falls back to the classification-time row so every
        // decision still pairs with one outcome.
        let decisionId: string | undefined;
        if (finalDraft.decision) {
          try {
            const { stashSendDraftDecision } = await import('../imessage/send-draft-outcome');
            if (userId && await stashSendDraftDecision(userId, finalDraft.decision)) decisionId = finalDraft.decision.id;
          } catch { decisionId = undefined; }
          if (!decisionId) {
            try {
              const { reconstructDecision, recordDecisionOutcome } = await import('../platform/decision-gate');
              recordDecisionOutcome(reconstructDecision(finalDraft.decision), 'imessage_send', { question: 'send', actual: true, acted: false, note: 'draft surfaced; modal label unavailable' });
            } catch { /* telemetry never breaks the draft */ }
          }
        }
        send('imessage-draft', {
          to: finalDraft.to,
          displayName: finalDraft.displayName,
          text: finalDraft.text,
          resolved: finalDraft.resolved,
          ...(decisionId ? { decisionId } : {}),
        });
        logger.info(`iMessage draft surfaced (reasoning-based) for userId=${userId} resolved=${finalDraft.resolved}${decisionId ? ` decision=${decisionId}` : ''}`);
      }
    } catch (e: any) {
      logger.warn(`iMessage send classification failed (non-blocking): ${e?.message || e}`, { source: 'chat-agent' });
    }
  }

  // Compute policy: the 'followups' event (moved after the persist — the chip
  // names the persisted row; a chip whose row failed to persist is dropped) and
  // the pill's terminal state for the live viewer (the row carries
  // metadata.check for reloads; the late path rewrites it when it lands).
  // ── TURN CONTINUATION — the task card + telemetry (2026-09-28) ──────────
  // Emitted on THIS stream (the viewer's) and persisted on the ORIGINAL row so
  // a reload shows the same card. One loop_metrics `turn_continuation` row per
  // lifecycle step. Never on the response path's error budget (fail-open).
  // A continuation ROUND always settles its card (a provider kill / empty
  // answer / the switch flipped mid-flight / a user Stop must never leave
  // "running" behind — and a stopped round is never "finished").
  if (chatId && userId && (continuationArmed || continuationArmFailed || continuationWaitingCard || continuationStop === 'superseded' || args.continuation)) {
    try {
      const spend = spentUsdAtFinalize ?? 0;
      const receiptsNow = receiptCounts(result.receipts as Array<{ ok?: boolean }> | undefined);
      const stepsNow = planStepCounts(continuationPlan);
      const armed = continuationArmed as ContinuationRun | null;
      let payload: TaskEvent | null = null;
      let outcome: string;
      let round: number;
      let reason: string;
      let humanWaitingTaskId: string | null = null;
      if (!args.continuation) {
        // Round 1 armed (or its enqueue failed) on a human turn — or the
        // confirmation / superseded cases that arm nothing.
        round = armed?.round ?? 1;
        reason = continuationVerdict?.kind === 'continue' ? continuationVerdict.reason : 'none';
        if (armed) {
          outcome = 'armed';
          payload = buildTaskEvent({
            taskId: armed.taskId, chatId, kind: 'continuation', status: 'running', title: CONTINUATION_TASK_TITLE,
            steps: stepsNow, receipts: receiptsNow, spendUsd: spend, startedAt: armed.startedAt,
            note: `Round ${armed.round} of ${armed.maxRounds} is running in the background.`,
          });
        } else if (continuationWaitingCard) {
          // Review fix 2: the staged action needs the USER's click — the card
          // says so; the answer keeps its pointer to the confirmation card.
          outcome = 'waiting_user';
          humanWaitingTaskId = randomUUID();
          payload = buildTaskEvent({
            taskId: humanWaitingTaskId, chatId, kind: 'continuation', status: 'waiting_user', title: CONTINUATION_TASK_TITLE,
            steps: stepsNow, receipts: receiptsNow, spendUsd: spend, note: closingText(finalText).slice(0, 240) || 'Needs your confirmation to continue.',
          });
        } else if (continuationStop === 'superseded') {
          outcome = 'superseded'; // the user's newer message owns the ask — nothing armed, answer unchanged
        } else {
          outcome = 'arm_failed';
        }
      } else {
        const prev = args.continuation;
        round = prev.round;
        reason = continuationVerdict?.kind === 'continue' ? continuationVerdict.reason : continuationVerdict?.kind === 'waiting_user' ? continuationVerdict.reason : continuationStop ?? 'done';
        const base = { taskId: prev.taskId, chatId, kind: 'continuation' as const, title: CONTINUATION_TASK_TITLE, steps: stepsNow, receipts: receiptsNow, spendUsd: spend, startedAt: prev.startedAt };
        if (afResumed) {
          // build 2026-10-08 A1: an owner message preempted this follow-through round — re-queued after the owner's turn.
          outcome = 'resumed';
          payload = buildTaskEvent({ ...base, status: 'running', note: ANSWER_FIRST_RESUME_NOTE });
        } else if (armed) {
          outcome = 'rearmed';
          payload = buildTaskEvent({ ...base, status: 'running', note: `Round ${armed.round} of ${armed.maxRounds} is running in the background.`, ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else if (continuationStop === 'stopped') {
          // Review fix 6: the user stopped this round — never "finished", no push.
          outcome = 'stopped';
          payload = buildTaskEvent({ ...base, status: 'waiting_user', note: CONTINUATION_STOPPED_LINE, ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else if (continuationStop === 'superseded') {
          // Review fix 5: the user sent a newer message — their turn owns the ask; the partial posted.
          outcome = 'superseded';
          payload = buildTaskEvent({ ...base, status: 'waiting_user', note: CONTINUATION_SUPERSEDED_LINE, ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else if (continuationStop === 'waiting_user') {
          outcome = 'waiting_user';
          payload = buildTaskEvent({ ...base, status: 'waiting_user', note: closingText(finalText).slice(0, 240) || 'Needs your answer to continue.', ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else if (continuationStop === 'cap') {
          outcome = 'cap';
          payload = buildTaskEvent({ ...base, status: 'done', note: `Continuation budget (${prev.maxRounds} rounds) used — the result so far is posted.`, ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else if (!assistantRowId || result.modelErrored === true || assistantContent === EMPTY_RUN_FALLBACK_NOTE || isHarnessErrorNote(assistantContent)) {
          outcome = 'failed';
          payload = buildTaskEvent({ ...base, status: 'failed', note: CONTINUATION_FAILED_LINE, ...(assistantRowId ? { resultMessageId: assistantRowId } : {}) });
        } else {
          outcome = 'posted';
          payload = buildTaskEvent({ ...base, status: 'done', resultMessageId: assistantRowId, note: `Finished in ${prev.round} background round${prev.round === 1 ? '' : 's'}.` });
        }
      }
      // build 2026-10-08 A1: a supervisor follow-through's rows are flagged (the ≥ 95 % done / failed bar) and a round
      // counts the mutating calls it repeated from the answer turn (the 0-duplicate-dispatch bar).
      const afStash = (armed ?? args.continuation)?.answerFirst;
      const afDupes = afRound && args.continuation ? duplicateSignatures(args.continuation.answerFirst?.done, mutatingCallSignatures(result.parts as any[])) : [];
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.TURN_CONTINUATION, sessionId: chatId, stamp: chatMetricStamp,
        meta: {
          chatId, taskId: (armed ?? args.continuation)?.taskId ?? humanWaitingTaskId, round, reason, outcome, rewrote: continuationRewrote, ...(continuationSupersededBy ? { supersededBy: continuationSupersededBy.kind } : {}),
          ...(isSupervisorChat && (afStash || afRound) ? { answerFirst: true, resumes: (afResumed ?? args.continuation)?.answerFirst?.resumes ?? 0, ...(afRound ? { duplicates: afDupes.length, ...(afDupes.length ? { duplicateCalls: afDupes.slice(0, 4) } : {}) } : {}) } : {}),
        },
      });
      // build 2026-10-08 A1: the OWNER ASK closes when its follow-through settles (done / failed) — never on the split
      // answer (the owner turn skipped closeAskOnReply). The result row (or, without one, the split answer) is the evidence.
      const afAskId = afRound ? args.continuation?.askMessageId : undefined;
      if (afAskId && userId && (outcome === 'posted' || outcome === 'cap' || outcome === 'failed')) {
        void closeAskOnReply(chatId, userId, { askMessageId: afAskId, replyMessageId: assistantRowId ?? args.continuation!.ofMessageId, source: 'continuation' }).catch(() => {});
      }
      if (payload) {
        const cardRowId = args.continuation ? args.continuation.ofMessageId : assistantRowId;
        if (cardRowId) await persistTaskCard(chatId, payload, { messageId: cardRowId });
        send(TASK_EVENT_TYPE, payload); // this run's live key IS chat:<id> — the viewer's stream (emitTaskEvent would double it)
        logger.info(`chat-agent: turn continuation ${outcome} for ${chatId.slice(0, 8)} (round ${round}, ${reason})`, { source: 'chat-agent' });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: turn continuation card failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  // ── ANSWER-FIRST telemetry (build 2026-10-08 A1) — one row per owner turn on a supervisor chat (shadow + act):
  // value = the owner's first-word ms (the bar: p90 ≤ 90 s); shadow carries wouldSplitAtMs + the mutating work an
  // act run would have moved to the follow-through, act carries splitAtMs / followThrough / armed.
  if (ownerAfObserver && ownerAf && chatId) {
    try {
      recordLoopMetric({
        kind: OWNER_ANSWER_FIRST_METRIC, sessionId: chatId, stamp: chatMetricStamp,
        value: firstChunkAt ? firstChunkAt - startedAt : undefined, unit: 'ms',
        meta: ownerAnswerFirstMetricMeta({
          chatId, scope: isProjectSupervisorChat ? 'project' : 'fleet', resolution: ownerAf, observer: ownerAfObserver,
          ttftMs: firstChunkAt ? firstChunkAt - startedAt : null, completionMs: Date.now() - startedAt,
          followThrough: afFollowThrough, verdict: continuationVerdict ? (continuationVerdict.kind === 'done' ? 'done' : `${continuationVerdict.kind}:${continuationVerdict.reason}`) : 'none',
          armed: !!afArmedTask, askMessageId: ownerTurnUserRowId,
        }),
      });
    } catch { /* telemetry never touches the turn */ }
  }
  // ── SESSION TASK CARDS — a sub-session spawned THIS turn (cohesive/integration) ──
  // A human ask that needed a workspace spawned it as an implementation detail
  // (the direct work-tool path — no card, no click); its lifecycle is ONE card
  // in THIS chat: running now (persisted on the answer row so a reload shows
  // it; the live frame already rode the stream at spawn time), flipped to done
  // by the deliverable hand-off with the same taskId when the child completes.
  // Human turns only: a machine wake's spawns are a supervisor's lanes, not a
  // user's task. (The per-card kill switch was retired in RSW-1 cluster 35.)
  const spawnedForMetric = spawnedSessionThisTurn as SpawnedSession | null;
  if (spawnTurnEnded && spawnedForMetric) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SPAWN_TURN_END, sessionId: runSessionId, stamp: chatMetricStamp,
      meta: { chatId: chatId ?? null, childChatId: spawnedForMetric.sessionId, title: spawnedForMetric.title, mode, stepsUsed: (result as { stepsUsed?: number })?.stepsUsed ?? null },
    });
  }
  if (chatId && userId && assistantRowId && !runIsMachineTriggered && !isSupervisorChat) {
    try {
      for (const spawned of spawnedSessionsInParts(result.parts)) {
        // Hand-off polish (2026-09-28, audit CT-2 b / E17): the hand-off may
        // ALREADY have posted this session's result on this chat (a fast
        // child, or the spawn turn outliving it) — its done card sits on the
        // row it flipped or on the result row. A running card on this newer
        // answer row would regress it ("running" under a finished task, the
        // live-acceptance defect) — the hand-off row IS the result; persist
        // nothing.
        {
          const latest = await import('../coding/deliverable-handoff').then((m) => m.latestDeliverableHandoff(spawned.sessionId)).catch(() => null);
          if (!spawnCardStillOwed(latest, chatId)) {
            logger.info(`chat-agent: session ${spawned.sessionId.slice(0, 8)} already handed off to ${chatId.slice(0, 8)} (result row ${String(latest?.resultMessageId ?? '').slice(0, 8)}) — no running card on row ${assistantRowId.slice(0, 8)}`, { source: 'chat-agent' });
            continue;
          }
        }
        const payload = buildSessionTaskEvent({ chatId, sessionId: spawned.sessionId, title: spawned.title, startedAt: new Date(startedAt).toISOString() });
        await persistTaskCard(chatId, payload, { messageId: assistantRowId });
        send(TASK_EVENT_TYPE, payload); // this run's live key IS chat:<id> — the viewer's stream
        logger.info(`chat-agent: session task card ${payload.taskId} running on ${chatId.slice(0, 8)} (row ${assistantRowId.slice(0, 8)})`, { source: 'chat-agent' });
      }
    } catch (err: any) {
      logger.warn(`chat-agent: session task card failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
    }
  }
  const liveChips = assistantRowId || !chatId ? chips : [];
  if (followUps.length || liveChips.length) send('followups', { questions: followUps, ...(liveChips.length ? { chips: liveChips } : {}) });
  if (checkState) send('check_state', checkState);
  if (args.escalation?.rung === 'research') send('progress', keyedProgress('deeper_findings_ready'));

  // Guest title (2026-09-26): the run normally outlives the title chain, so this
  // is a no-op wait; when the chain is still in flight, give it a short bounded
  // window so 'complete' can echo the title (the client's only second chance —
  // a guest has no title endpoint to ask afterwards).
  if (guestTitlePromise && !autoTitle) {
    await Promise.race([
      guestTitlePromise,
      new Promise<void>(resolve => { const t = setTimeout(resolve, GUEST_TITLE_COMPLETE_WAIT_MS); t.unref?.(); }),
    ]).catch(() => {});
  }
  send('complete', {
    ...(liveChips.length ? { chips: liveChips } : {}),
    // Depth UX (2026-09-26, audit sse-ui-restore-14): the SAME plan the row
    // persists under metadata.depth — the client's buildPlainMeta reads it so
    // the just-answered bubble walks the Dig-deeper ladder (a rung spent this
    // session ⇒ the NEXT rung) without a reload, exactly like a restored row.
    // Small (plan + budget + decision id + facts); never the checker drafts.
    depth: metadata.depth,
    // NO summary/message fields (adversarial review H3): sending the full
    // answer three times plus full cross-checker drafts made deep-research
    // complete events 50KB+, which Cloudflare Tunnel/proxies silently drop.
    // The client builds the assistant message from accumulated 'chunk' text
    // (both the foreground and background-stream restore paths) and merges
    // these truncated cards with the full 'model-response' events it already
    // has; full responses persist in the assistant row's metadata.
    // ONE exception: when the step-0 reconcile pass replaced the answer, the
    // client already rendered the UNRECONCILED text from chunks — include the
    // reconciled full text (a single answer, only this path) so the UI swaps
    // it in instead of silently diverging from the DB until reload. The
    // pre-delivery action guard's strike gets the same swap (fcc4dbb4): a live
    // viewer of a machine wake must see the replaced note, not the phantom.
    // Ticket 318b3175: the swap rides with a `corrected: true` marker so the
    // client can label the replaced text (the owner watched a long streaming
    // answer "shrink" at finalize with no explanation). Echo-only — the
    // persisted row never carries it. N5 (round-2 review): the marker rides
    // ONLY the true-swap flags — lanes that APPEND without replacing the
    // streamed text (claimsLaneAnnotated, markdownLintSwapped when the degrade
    // merely normalizes) must not claim the draft "was replaced"; their
    // finalText still ships (the pre-318b3175 behavior) but without the note.
    ...((reconciledLive || actionGuardStruck || rejectBackSwapped || leakRetrySwapped || continuationRewrote || seatFallbackSwapped || forgedChromeSwapped) ? { finalText, corrected: true } : {}),
    ...((claimsLaneAnnotated || markdownLintSwapped || harnessReceiptsSwapped || unverifiedFootnoteAppended || struckRepeatAnnotated || computerClaimAnnotated || forgedChromeSwapped) && !(reconciledLive || actionGuardStruck || rejectBackSwapped || leakRetrySwapped || continuationRewrote || seatFallbackSwapped) ? { finalText } : {}),
    models: slimChatModelCards(models),
    // Seat labels per card key (owner 2026-09-15) — the More-info panel names
    // the SEAT that produced each card, never the vendor.
    modelLabels: SEAT_MODEL_LABELS,
    synthesisTime: Math.round((Date.now() - orchestratorT0) / 1000),
    totalTime: Math.round((Date.now() - startedAt) / 1000),
    // Same list the persisted metadata carries (runSources above) — the live
    // turn and the reloaded row show identical Sources pills.
    sources: runSources,
    followUps,
    canvasCount: parsedCanvases.length,
    autoTitle,
    engine: 'agent',
    ...(args.routing ? { routing: args.routing } : {}),
    // Legacy wire parity: the client reads both of these off 'complete'
    // (anonymous session id + whether prior context was loaded).
    sessionId: args.sessionId ?? null,
    contextUsed: ctx.conversationHistory.length > 0,
    // Owner 2026-09-18: the persisted row id (the client swaps THIS bubble when
    // the late cross-check revises it) and the pending flag that starts its poll.
    ...(assistantRowId ? { messageId: assistantRowId } : {}),
    // Audit 2026-09-26 (sse-ui-restore-3): the persisted depth plan rides the
    // live turn too — the client's chip ladder (escalationChipFor) used to see
    // `depth` only after a reload, so a refused tap made the live chip vanish.
    ...(metadata.depth ? { depth: metadata.depth } : {}),
    // Audit 2026-09-26 (sse-ui-restore-3): the persisted depth plan rides the
    // live turn too — the client's chip ladder (escalationChipFor) used to see
    // `depth` only after a reload, so a refused tap made the live chip vanish.
    ...(metadata.depth ? { depth: metadata.depth } : {}),
    ...(lateCrossCheckArmed ? { pendingCrossCheck: true } : {}),
  });

  // Late cross-check (owner 2026-09-18): the Double Checker is still working —
  // keep waiting for its draft OFF the request path and reconcile it into the
  // row that just shipped. Detached; never blocks or fails this run.
  if (lateCrossCheckArmed && chatId && assistantRowId && checkersPromise) {
    // Answer-first: await the REAL draft (the 75 s simple-question cap on the
    // raced promise would read as "no draft"); the kill switch keeps today's.
    const pendingCheckers = answerFirst && checkersUnbounded ? checkersUnbounded : checkersPromise;
    const rowId = assistantRowId;
    const draftsAgreeStash = draftsAgreeResult;
    // WI-D: hold the turn ledger across the detached late pass — the checker's
    // own loop already holds it while running, but the late RECONCILE loop
    // starts after this function's finally has closed the caller's hold;
    // without this hold the turn would settle (and write run_spend) before the
    // reconcile pass recorded.
    turnUsage?.retain();
    void import('./late-crosscheck')
      .then((m) => m.runLateCrossCheck({
        chatId, messageId: rowId, question: queryMessage, draft: harnessLinesOff(raw), model: orchestratorModel,
        // Review fix 7: the late pass reconciles the ORIGINAL draft (the one the
        // reconcile prompt keeps its [FOLLOWUPS] chrome from), so a material
        // revision would write the hand-back sentence back onto a row whose card
        // says "running". The same deterministic rewrite is applied to whatever
        // the reconcile returns; its chips are dropped like the delivered ones.
        ...(continuationRewrote || noActionNoteScope || unreadStateNoteScope ? { rewriteRevised: async (c: string) => {
          const closed = continuationRewrote ? rewriteClosingText(c, continuationLine) : c;
          const noted = noActionNoteScope ? await rejudgeNoActionNote(closed) : closed; // FSN1021: re-judged on the revised text
          // 2026-10-22: a revision never carries the unread-state line — an unchanged answer keeps the stored row
          // (line included), a material one ships without it.
          return unreadStateNoteScope ? stripUnreadStateNote(noted) : noted;
        },
        // FSN1021 review round 5: only a continuation row drops the revision's chips (its delivered row has none).
        ...(continuationRewrote ? {} : { rewriteKeepsChips: true }),
        // The baseline rewrite + no-action strip stay keyed to the FSN1021 note scope alone (review 2026-10-22:
        // SUPERVISOR_NO_ACTION_NOTE_DISABLED=1 restores the pre-FSN1021 comparison); the unread-state line is
        // stripped from both sides of the comparison by its own flag.
        ...(noActionNoteScope ? { rewriteBaseline: true } : {}),
        ...(unreadStateNoteScope ? { unreadStateNoteless: true } : {}) } : {}),
        sessionId: runSessionId, projectId: ctx.projectId || 'chat', userId: runUserId, userTurnAt,
        // A draft that already landed rides in resolved; the still-running
        // inline reconcile pass (if any) is awaited instead of a second pass.
        checkersPromise: lateReconcileBlock != null ? Promise.resolve(lateReconcileBlock) : pendingCheckers,
        ...(lateReconcilePromise ? { preStartedReconcile: lateReconcilePromise } : {}),
        models, cardKey: SEAT_CARD_KEYS.double, startedAt: orchestratorT0,
        // DepthBudget.maxBackgroundMs ∧ CROSS_CHECK_HARD_MS — the same bound the
        // checker's harness kill ran under (default 15 min = today's wait).
        maxWaitMs: checkerHardMs, boundSource: checkerBound.source,
        // Off the request path — the reconcile gets the wider late bound
        // (first live rows ran 150–165 s against the 150 s inline cap).
        reconcile: (o) => reconcileWithCrossCheck({ ...o, ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}), timeoutMs: machineTriggeredRun ? CROSS_CHECK_LATE_RECONCILE_MACHINE_MS : CROSS_CHECK_LATE_RECONCILE_MS, path: 'late', usage: turnUsage }),
        // Compute policy (design §4 D1b): revision_material decides rewrite
        // ("Updated · what changed") vs "Checked ✓"; a conversation_moved
        // material change lands as an ADDENDUM under the newer turn. The
        // drafts_agree decision (D1, shadow) is labelled from the same verdict —
        // read DIRECTION-AWARE (draftsAgreeLabelMaterial, 2026-09-26): only a
        // claim of the lead's answer removed / replaced or a polarity / negation /
        // recommendation flip is "disagree"; additions-only is "agree"; a
        // fallback verdict labels nothing (it used to be "any change ⇒ disagree").
        decideRevision: (prev, next) => decideRevisionMaterial(prev, next, { chatId, ghost: ghostRun }),
        // drafts_agree on the LATE path too (audit 2026-09-26 telemetry-readiness-6 /
        // gate-runtime-3): the inline site only sees a draft that lands within
        // CROSS_CHECK_LATE_WAIT_MS of the lead final; a draft that lands later
        // is judged here before the reconcile (never twice — the late pass
        // skips the ask when the inline site already asked / pre-started).
        ...(!draftsAgreeStash && !draftsAgreeActed ? {
          decideAgree: async (leadFinal: string, checkerDraft: string) => {
            // Ghost mode (owner 2026-10-22): same rule as the inline site —
            // never ship ghost answer/draft text to the decision backend.
            if (ghostRun) return { mode: 'shadow' as const, agree: null, p: null, act: false };
            const v = await decideDraftsAgree({ leadFinal: leadFinal.slice(0, 3000), checkerDraft: checkerDraft.slice(0, 3000), chatId: chatId ?? undefined, machine: machineTriggeredRun });
            return { ...v, act: v.mode === 'act' && v.agree === true && (v.p ?? 0) >= DRAFTS_AGREE_ACT_P };
          },
        } : {}),
        onOutcome: (o) => {
          const stash = draftsAgreeStash ?? o.draftsAgree ?? null;
          const acted = draftsAgreeStash ? draftsAgreeActed : !!o.draftsAgree?.act;
          if (stash && (o.outcome === 'revised' || o.outcome === 'unchanged' || o.outcome === 'addendum')) {
            labelDraftsAgree({
              decisionId: stash.decisionId, p: stash.p, mode: stash.mode as DecisionMode, stash: stash.stash as DecisionStash | undefined,
              material: draftsAgreeLabelMaterial(o), changed: o.verdict?.changed ?? [], acted, sessionId: runSessionId, label: 'reconcile', source: 'late_check',
            });
          }
          if (deferredCheckerRouteFacts && checkerRoutePromise) {
            const merged = o.outcome === 'revised' || o.outcome === 'unchanged' || o.outcome === 'addendum';
            const facts = { ...deferredCheckerRouteFacts, checkerMerged: deferredCheckerRouteFacts.checkerMerged || merged };
            deferredCheckerRouteFacts = null;
            void checkerRoutePromise.then((r) => recordCheckerRouteOutcome(r, facts, { sessionId: runSessionId, acted: checkerRouteActed, failed: false })).catch(() => {});
          }
        },
      }))
      .catch((err: any) => {
        logger.warn(`chat-agent: late cross-check scheduling failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
        if (deferredCheckerRouteFacts && checkerRoutePromise) {
          const facts = deferredCheckerRouteFacts; deferredCheckerRouteFacts = null;
          void checkerRoutePromise.then((r) => recordCheckerRouteOutcome(r, facts, { sessionId: runSessionId, acted: checkerRouteActed, failed: false })).catch(() => {});
        }
      })
      .finally(() => turnUsage?.release());
  } else if (lateCrossCheckArmed) {
    // Armed but nothing to revise (no row id) — clear the flag so nothing polls forever.
    if (chatId && assistantRowId) await prisma.crossModelMessage.update({ where: { id: assistantRowId }, data: { metadata: { ...(metadata as object), pendingCrossCheck: false } as object } }).catch(() => {});
  }
  if (deferredCheckerRouteFacts && checkerRoutePromise) {
    // The late pass never started — write the finalize-time label as before.
    const facts = deferredCheckerRouteFacts; deferredCheckerRouteFacts = null;
    void checkerRoutePromise.then((r) => recordCheckerRouteOutcome(r, facts, { sessionId: runSessionId, acted: checkerRouteActed, failed: orchestratorEmpty })).catch(() => {});
  }

  // ── Dig deeper finalize (compute policy 2026-09-26) ─────────────────────
  // The rung is SPENT on the original message (metadata.depth.escalations —
  // the next tap runs the rung after it, or none), and a research rung tells
  // the user through their OWN Telegram via the existing notify_user tool
  // (rate-capped there; refused honestly when nothing is linked). Best-effort.
  if (args.escalation && chatId && assistantRowId) {
    const esc = args.escalation;
    const newRowId = assistantRowId;
    void (async () => {
      try {
        const orig = await prisma.crossModelMessage.findUnique({ where: { id: esc.ofMessageId }, select: { id: true, chatId: true, metadata: true } });
        if (orig && orig.chatId === chatId) {
          const meta = (orig.metadata && typeof orig.metadata === 'object') ? orig.metadata as Record<string, any> : {};
          const depth = (meta.depth && typeof meta.depth === 'object') ? meta.depth : { plan: { preset: String(meta.mode ?? 'single_thinking'), spawnChecker: meta.mode === 'thinking', checkerWaitMs: 0, council: 'none', source: 'preset' } };
          // `done` + the rung's OWN spend (audit 2026-09-26 budgets-cost-1: the
          // per-message bound sums these; the running stamp is replaced).
          await prisma.crossModelMessage.update({
            where: { id: orig.id },
            data: { metadata: { ...meta, depth: { ...depth, escalations: stampEscalation(depth.escalations, { rung: esc.rung, at: new Date().toISOString(), status: 'done', messageId: newRowId, ...(typeof spentUsdAtFinalize === 'number' ? { spentUsd: spentUsdAtFinalize } : {}) }) } } as object },
          });
        }
      } catch (err: any) {
        logger.warn(`chat-agent: escalation stamp failed for ${esc.ofMessageId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
      }
      if (esc.rung === 'research' && userId) {
        try {
          const { executeAccountTool } = await import('../platform/account-tools');
          const out = await executeAccountTool({
            worktree: '', sessionId: chatId, userId, permissionMode: 'auto',
            emit: () => {}, requestApproval: async () => 'deny' as const,
            execShell: async () => { throw new Error('no shell in the deeper-findings notify'); },
            alwaysAllow: new Set<string>(), userTurnAt,
          } as any, 'notify_user', { message: `Deeper findings are ready${doctrineChatTitle ? ` in "${doctrineChatTitle}"` : ''} — open the chat to read them.`, channel: 'auto' });
          logger.info(`chat-agent: deeper-findings notify_user → ${String(out).slice(0, 120)}`, { source: 'chat-agent' });
        } catch (err: any) {
          logger.warn(`chat-agent: deeper-findings notify_user failed (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
        }
      }
    })();
  }

  // Fleet supervisor (§3): plain-chat run finalize — the assistant row is
  // persisted and the stream complete, so emit run_completed and clear this
  // chat's wake-depth stamp (the emission READ it via depthForChat; clearing
  // ends this wake's depth propagation). Fire-and-forget dynamic import —
  // never blocks the stream end. Anonymous runs (no chatId) have no hooks.
  // Spark B21: a CANCELLED machine wake (user preemption / Stop) did NOT
  // complete — emitting run_completed for it fed supervisors a "(Stopped.)"
  // answer as a completion while the wake's source events were being
  // requeued. Suppress the event; the depth stamp still clears.
  const cancelledMachineWake = (args.machineWake === true || machineOriginRun(args))
    && args.isCancelled?.() === true;

  // ── Scheduled trailing-notify backstop (ticket 8aa5688f) ────────────────
  // A scheduled run whose stored prompt mandates a trailing notify_user
  // ("post the digest, THEN call notify_user…") could exhaust its tool
  // rounds on the data pull (chat 'thinking' = 8 steps; tools are omitted
  // on the final step) and reach the tools-off FINAL TURN structurally
  // unable to ping — 8 consecutive missed mornings on the Sunday Market
  // digest, invisible to the platform. The PLATFORM executes the ping here
  // — the same executeAccountTool('notify_user') surface the Dig-deeper
  // finalize above uses — gated on the schedule's OWN stored prompt and
  // silent whenever the model's own ok notify_user receipt proves it pinged.
  // Best-effort, never blocks the stream end; rate caps inside
  // executeAccountTool stay in force. SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1
  // reverts to byte-for-byte pre-fix behavior.
  if (
    !scheduledNotifyBackstopDisabled()
    && chatId && userId
    && args.firedByScheduleId
    && !cancelledMachineWake
  ) {
    const backstopScheduleId = args.firedByScheduleId;
    const backstopReceipts = (result.receipts ?? []) as any[];
    // Re-review B1-r: a reject-back / harness-chrome retry swap REPLACES
    // result.parts with the retry's and stashes attempt 1's parts in the
    // superseded arrays (only receipts are unioned) — and the intent-replay
    // leg mints no receipt. A delivered attempt-1 notify_user envelope would
    // otherwise be invisible at the finalize and the backstop would re-ping.
    // Scan the superseded parts alongside the live ones.
    const backstopParts = [
      ...((result.parts ?? []) as any[]),
      ...((rejectBackSupersededParts ?? []) as any[]),
      ...((harnessSupersededParts ?? []) as any[]),
      ...((retrySupersededParts ?? []) as any[]),
    ];
    const backstopFinalText = finalText;
    // ticket 0973bdd7: the backstop IIFE used to return silently on every
    // gate, so what ACTUALLY happened to the mandated ping left no trace —
    // and for two mornings the durable row claimed "ping NOT sent" while this
    // backstop had delivered it a second later. The IIFE now reports FACTS
    // (declared / model / platform / refused) and the caller classifies them
    // with resolveTerminalStepOutcome() into one loop_metrics row per firing,
    // where 'missed' is the only alarm value.
    type BackstopFacts = { declared: boolean; modelNotified: boolean; platformDelivered: boolean; platformRefused: boolean };
    const backstopSettled: Promise<BackstopFacts> = (async (): Promise<BackstopFacts> => {
      const facts: BackstopFacts = {
        declared: false,
        modelNotified: modelAlreadyNotified(backstopReceipts, backstopParts),
        platformDelivered: false,
        platformRefused: false,
      };
      try {
        // Declaration read comes FIRST — ahead of both the quiet gate and the
        // model-already-pinged gate — because 'declared' must mean "this
        // schedule's own stored prompt mandates the step", never "the model
        // happened to call notify_user" and never "the answer was not quiet".
        // Getting this wrong in either direction rots the contract: read it
        // after the model gate and an incidental ping mints a row for a
        // schedule with no mandate; read it after the quiet gate and the
        // 'quiet' outcome the registry documents is unreachable dead code.
        // One bounded read per fired run (daily digests — not a hot path).
        const sched = await prisma.chatSchedule.findUnique({
          where: { id: backstopScheduleId },
          select: { prompt: true, enabled: true },
        });
        // Gate 3: the schedule's OWN stored prompt carries the mandate (the
        // composed wake message is never scanned — the doctrine's trigger row
        // quotes the phrase itself). A disabled schedule (mid-run owner
        // pause) does not ping either.
        if (!sched?.enabled) return facts;
        if (!scheduleMandatesTrailingNotify(String(sched.prompt ?? ''))) return facts;
        // Past this line the schedule DOES declare a terminal step — every exit
        // below is a recorded outcome rather than a silent return.
        facts.declared = true;
        // Gate 5: a real answer — empty or "Nothing new." mornings must not ping.
        // Now AFTER declaration so a quiet firing on a mandating schedule stays
        // DISTINGUISHABLE (recorded as 'quiet') from a genuine miss; the ping is
        // still suppressed exactly as before, so delivery behaviour is unchanged.
        if (!backstopFinalText.trim() || isQuietRunReply(backstopFinalText)) return facts;
        // Gate 4: the model already pinged (ok NOTIFY receipt OR a delivered
        // tool-result envelope in the parts — the receipt mint is skipped on
        // intent-replay/read-cache legs while the envelope still lands in the
        // parts; scanning both is the never-double-ping gate) — never double-ping.
        if (facts.modelNotified) return facts;
        // notify_user's own footer reads the chat title internally
        // (account-tools) — the backstop does not re-read it (review N2).
        const message = buildScheduledNotifyMessage(null, backstopFinalText);
        const { executeAccountTool } = await import('../platform/account-tools');
        const out = await executeAccountTool({
          worktree: '', sessionId: chatId, userId, permissionMode: 'auto',
          emit: () => {}, requestApproval: async () => 'deny' as const,
          execShell: async () => { throw new Error('no shell in the scheduled-notify backstop'); },
          alwaysAllow: new Set<string>(), userTurnAt,
        } as any, 'notify_user', { message, channel: 'auto' });
        // executeAccountTool NEVER throws for tool refusals — it answers a
        // JSON string (ok:false, reason) — so the outcome is PARSED, never
        // assumed (review B2: reading .ok off the string was always
        // undefined and recorded every refusal as a sent ping).
        const outcome = parseNotifyOutcome(out);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULED_NOTIFY_BACKSTOP,
          sessionId: chatId,
          meta: { scheduleId: backstopScheduleId, outcome: outcome.ok === true ? 'ok' : outcome.ok === false ? 'refused' : 'unparsed', detail: outcome.detail },
        });
        logger.info(`chat-agent: scheduled-notify backstop ${outcome.ok === true ? 'delivered' : outcome.ok === false ? `refused (${outcome.detail})` : 'unparsed'} for schedule ${backstopScheduleId.slice(0, 8)} → ${String(out).slice(0, 120)}`, { source: 'chat-agent' });
        // ok:null (unparsed) is NOT counted as delivered: an unproven send is a
        // miss from the owner's side, and the detail carries why.
        return { ...facts, platformDelivered: outcome.ok === true, platformRefused: outcome.ok !== true };
      } catch (err: any) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULED_NOTIFY_BACKSTOP,
          sessionId: chatId,
          meta: { scheduleId: backstopScheduleId, outcome: 'error', error: String(err?.message ?? err).slice(0, 200) },
        });
        logger.warn(`chat-agent: scheduled-notify backstop failed for ${backstopScheduleId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: 'chat-agent' });
        return { ...facts, platformRefused: facts.declared };
      }
    })();
    // Record what happened to the declared terminal step. Always-on (no kill
    // switch — the row is purely additive telemetry and this class being
    // invisible is what let the incident run two mornings). A schedule that
    // declares no terminal step writes no row ('declared' false).
    void backstopSettled
      .then((facts) => {
        if (!facts.declared) return;
        const stepOutcome = resolveTerminalStepOutcome({
          finalText: backstopFinalText,
          modelNotified: facts.modelNotified,
          platformDelivered: facts.platformDelivered,
          platformRefused: facts.platformRefused,
        });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.TERMINAL_STEP_OUTCOME,
          sessionId: chatId,
          value: 1,
          meta: { scheduleId: backstopScheduleId, step: 'notify_user', outcome: stepOutcome },
        });
        // 'missed' is the ONLY state where the owner asked for a ping and got
        // none — loud in the log (the metric above is the durable of-record).
        if (stepOutcome === 'missed') {
          logger.warn(`chat-agent: TERMINAL STEP NOT EXECUTED — schedule ${backstopScheduleId.slice(0, 8)} mandates notify_user and NOBODY delivered it (model: no receipt, platform backstop: refused/failed); the owner-facing half of this digest is MISSING`, { source: 'chat-agent' });
        }
      })
      .catch(() => { /* telemetry is best-effort; the backstop itself already ran */ });
  }

  // Fleet supervisor (§3) — the cancelledMachineWake branches: cancelled
  // clears the depth stamp only (no run_completed); the rest emit below.
  if (chatId && cancelledMachineWake) {
    void import('../platform/hooks.service').then((m) => m.clearHookDepth(chatId)).catch(() => {});
  }
  if (chatId && !cancelledMachineWake) {
    // Ticket 835595b7 (F5): the summary read finalText only, so a carried
    // [DISPATCH-NEEDED] block (persisted into content above) was still
    // invisible to the supervisor wake that exists to see it. Surface the
    // carry in the summary too — hooks.service truncateSummary caps the total
    // at 2000, so keep this slice tight.
    // bf30c5d9: front-load the machine-readable RUN_OUTCOME line extracted from
    // the FULL finalText BEFORE the 300-char slice — a verdict/blocking tail
    // past the slice (or past truncateSummary's 2000) would otherwise be
    // invisible to the wake (the child result-hook truncation defect).
    const hookSummary = frontLoadRunOutcome(
      `Chat run completed.${finalText.trim() ? ` Answer: ${finalText.trim().replace(/\s+/g, ' ').slice(0, 300)}` : ''}${carriedBlocks ? ` Carried structured block(s): ${carriedBlocks.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`,
      {
        outcome: 'completed',
        finalText,
        // 954b7910: a digest that quotes the answer must carry the citable id
        // for it (the plain-chat assistant row IS the crossModelMessage the
        // action-verifier probes) — text without an id invites an invented
        // '(msg …)' citation. Same gating as the "Answer:" slice itself.
        ...(finalText.trim() && assistantRowId ? { answerMessageId: assistantRowId } : {}),
        // HARNESS-RECEIPTS-AND-CLAIMS (2026-10-20): the CLAIMS line from the harness's finish_run check
        // (present on machine supervisor / lane runs only). RUN_OUTCOME_CLAIMS_LINE_DISABLED=1 drops it.
        ...(result.finishRun ? { claims: result.finishRun } : {}),
      },
    );
    void import('../platform/hooks.service')
      .then(async (m) => {
        await m.emitHookEventSafe(chatId, 'run_completed', hookSummary);
        await m.clearHookDepth(chatId);
      })
      .catch(() => {});
    // Mobile push (M1, roadmap §3.2 item 3): the backgrounded app's wake
    // signal. Fire-and-forget off the request path; payloads carry ids/titles
    // only (never message bodies). Skips the FRONTEND user turn — a user
    // tapping Send on their phone is IN the app watching the stream.
    // A finished turn continuation (2026-09-28) is the result the user left
    // the tab for — the same wake signal.
    // A round the user STOPPED or a newer message superseded is not a finish (review fixes 5 + 6).
    if (userId && (args.messageOrigin === 'user' || (args.continuation && !continuationArmed && continuationStop !== 'stopped' && continuationStop !== 'superseded'))) {
      void import('../push/push.service')
        .then((m) => m.pushToUserDevices(userId, {
          title: 'Digby',
          body: args.continuation ? 'Your task finished — tap to open.' : 'Your run finished — tap to open.',
          chatId,
          data: { kind: 'run_completed' },
        }))
        .catch(() => {});
    }
  }
  } finally {
    clearInterval(pulseTimer);
    // WI-D: drop the turn's own hold — the ledger settles (ONE run_spend for
    // the whole turn) once every still-running participant has released too.
    turnUsage?.close();
  }
}
