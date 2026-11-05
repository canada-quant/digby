/**
 * Digby Code — agentic coding loop.
 *
 * Drives an open-source model (GLM-5.2 default) over a session's git worktree:
 *   build context → stream a turn → execute tool calls → repeat → final answer.
 *
 * Tools: worktree file/command/git tools (tools.ts) + the shared web/browser/
 * GitHub tools (ToolCache) + spawn_subagent (depth-1 bounded child agent).
 * Emits rich SSE events for the UI and returns the assembled message `parts`.
 */

import { capReasoningEffort } from './effort-cap';
import { isStatuslessTransportAbort, isExternalTransportFailure } from './turn-failure-classification';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { ToolCache, TOOL_DEFINITIONS, inlineGeneratedPath } from '../tool-executor';
import { stripToolCallMarkup, looksLikeAttemptedToolCall, countAsciiXmlToolCalls, asciiXmlToolCallSignatures, hasAsciiXmlToolCall } from '../sanitize-model-output';
import {
  CODING_TOOL_SCHEMA,
  executeCodingTool,
  ToolContext,
  PermissionMode,
  recordAnswerKeyBlock,
} from './tools';
import { guardWebToolCall } from './answer-key-guard';
import { VIEW_IMAGE_TOOL, VIEW_IMAGE_PROMPT_LINE, viewImageToolDisabled } from './view-image';
import { sessionBrowserToolEnabled } from './tools';
// F2 (owner 2026-10-06 late): the frontier reflection council — repeated failures ⇒ reflect ⇒ consult frontier advisors.
import { createFrontierCouncilRun, lastAssistantText, FRONTIER_COUNCIL_TOOL, type FrontierCouncilRun } from './frontier-council';
import { FinishRunSession, finishRunEligible, finishRunNudgeSkipReason, finishRunMeta, FINISH_RUN_TOOL, FINISH_RUN_SCHEMA, FINISH_RUN_NUDGE, FINISH_RUN_METRIC, finishRunObservesTool, FINISH_RUN_NUDGE_TIMEOUT_MS, FINISH_RUN_NUDGE_EFFORT_CAP, type FinishNudge, type FinishRunRecord } from './finish-run';
import { resolveFinishRunAct } from './finish-run-act';
import {
  resolveProviderForRun,
  resolveRoleModelForRun,
  resolveRoleFallbackForRun,
  seatUnservableReason,
  HELPER_MODEL,
  runModelTurn,
  ModelContent,
  StreamedToolCall,
  TurnResult,
  extractProviderErrorDetail,
  parseRetryAfterHeader,
  longLineRepeatCounts,
  drainAxiosErrorBody,
  isCustomEndpointProvider,
  registryContextFamilyDisabled,
  learnedContextCharCeiling,
  learnContextCharCeiling,
  isInferredContextSource,
} from './coding-model';
import { spendModelKey, replaysReasoning } from './coding-model';
import type { MachineFiringEffort } from './machine-firing-effort';
import {
  resolveWorkerModel, buildWorkerSummary, workerEnvelopeInstruction, parseWorkerEnvelope,
  spliceCompletedDelegationsNote, CompletedDelegation, readOnlyFileWriteRefusal,
  WORKER_ROLE_SEATS,
} from './delegation';
import { isProviderQuotaRejection } from './provider-quota';
import { workerSeatFailureReason, helperSeatFallbackDisabled, helperSeatAttributionLine, HelperSeatFallback, HELPER_SEAT_ROLE, leadSeatFallbackDisabled, leadSeatConnectionFailure, leadSeatHttpFailure, pickLeadFallback, LEAD_SEAT_ROLE, orderFallbackCandidates } from './helper-seat';
import type { ModelRoleKey } from '../model-endpoints/model-roles.service';
import { noteProviderRejection, providerCooldownUntil, PROVIDER_COOLDOWN_WINDOW_MS, PROVIDER_COOLDOWN_MS } from './provider-cooldown';
import { providerToolLimitDetail, learnToolLimit, toolLimitKey, trimToolsToLimit, toolTrimSystemNote } from './provider-limits';
import { registerRunToolSchemas } from './run-tools-registry';
// Progressive tool disclosure (2026-09-27, owner: "way smarter than just
// trimming … set a group of tools behind another tool"): a small always-on
// core + tool GROUPS loaded on demand through list_tool_groups / load_tools
// whenever a provider's tool cap binds (or TOOL_GROUPS_ALWAYS=1). Pure leaf.
import {
  ToolGroupSession, toolGroupsDisabled, toolGroupsAlways, initialToolGroups, toolGroupsSystemNote, toolGroupsProgressLine,
  LIST_TOOL_GROUPS_TOOL, LOAD_TOOLS_TOOL, LIST_TOOL_GROUPS_SCHEMA, LOAD_TOOLS_SCHEMA, TOOL_GROUP_META_TOOLS,
  laneOnlyToolHintDisabled, laneOnlyToolHint, laneOnlyToolsInQuery,
} from './tool-groups';
// build 2026-10-08 A2 (tool diet): the guest subset + progressive disclosure on human chat turns.
import {
  TOOL_DIET_METRIC, guestToolSubsetDisabled, guestToolSubset, isGuestSession, chatToolGroupsDisabled, toolDietConfig,
  decideChatToolGroups, isHumanPlainChatRun, chatToolGroupsInitialView, toolGroupsPromptText, calledToolNames, wouldMissTools,
  schemaChars, CHAT_PRELOAD_TOOLS, type ChatToolGroupsDecision,
} from './tool-diet';
// build 2026-10-08 A2b: the turn plan's lane picks the starting tool set.
import { readToolLaneHint, decideLaneToolSets, chatLaneDiet, laneDietMeta, type ToolLaneHint, type ChatLaneDiet } from './tool-diet';
import { reportClipV2Disabled, workerReportCapChars } from './report-clip';
import { persistWorkerReport, readWorkerReport } from './worker-report-store';
import { RunReadCache, runReadCacheDisabled } from './run-read-cache';
import { classifyInvalidRequest, latchSeatInvalidRequest, seatInvalidRequestLatch, INVALID_REQUEST_KIND_LABELS, classifyContentFilter, contentFilterLaneDisabled, contentFilterModelNote } from './seat-invalid-request';
import { isSystemOrderRejection, systemFirstNormalizeDisabled } from './system-first';
import { EditCheckpoints } from './edit-checkpoints';
import { toolFamilyProfile } from './tool-profile';
import { PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';
import { maskDeliverSecretsInArgsString } from '../platform/owner-question-secrets';
import { EditDiagnosticsTracker } from './edit-diagnostics';
import { ChatImage, toImageContentParts } from './chat-images';
import { isEmptyTruncatedTurn, recoveryExtras, truncationCapKey } from './turn-recovery';
import { severedStreamVerdict, severedStreamMeta, noteReemit, beginTurn, type ReemitTurnCarry } from './severed-stream'; // efdb3d31: structurally-unfinished tool-call payload ⇒ re-emit once instead of dispatching a partial call; 192d9087 F2: noteReemit/beginTurn make `re`/`rl` PER-TURN facts
import { newApprovalId, awaitApproval } from './approval-registry';
import { newQuestionId, awaitAnswer, QUESTION_TIMEOUT_MS } from './question-registry';
import { stableStringify } from './pending-durable';
import { publishConfirmPending, clearConfirmPending } from '../confirm-pending';
import {
  getUserCodingMemory, getProjectMemory, getSessionMemory, formatCodingMemoryBlock,
} from './coding-memory.service';
import { getRecentJournalEntries, formatJournalBlock, RunJournalEntryShape, JOURNAL_ENTRIES_N, MACHINE_JOURNAL_ENTRIES_N, MACHINE_JOURNAL_BLOCK_CAP } from './run-journal.service';
import { RECEIPT_TOOLS, extractReceipt, receiptHeads, ToolReceipt, WEB_PROBE_RECEIPT_TOOLS_SET, CONDITION_WAKE_RECEIPT_TOOLS_SET } from './run-receipts';
// build 2026-10-08 D-2 / D-1: the tool-intent journal + the delegation ledger's background-worker seam (both SHADOW).
import { createIntentJournal, type IntentJournal } from './tool-intents';
import { noteBackgroundWorkerPhase, noteBackgroundWorkersLost, sweepOrphanedBackgroundWorkerTasks } from '../platform/delegation-tasks';
// SAA-1.6 PHASE 3a/3b (todo e49dfd07) — the async-tool eligibility leaf (pure, no I/O) and the
// pending-result registry that delivers a handed-off call's result at a step boundary.
import { planAsyncToolCall } from '../platform/async-tool-calls';
import type { AsyncToolPlan } from '../platform/async-tool-calls';
import { AsyncToolRegistry, formatAsyncToolResult, formatOwedToolResults, type AsyncToolDone } from '../platform/async-tool-registry';
import { originalRequest, shouldRunIndependentReview, independentReviewBrief, isUsableReviewReport, originalRequestAuditBlock, reviewFindingsBlock, countWorkToolCalls, REVIEW_WORK_TOOLS, addOpenChoices, reviewKeepAnswerDisabled, keptAnswerWithReviewLine, selfAuditReviewerSkipDisabled, reviewerIsCrossFamily, reviewerReplacesAuditMessage } from './independent-review';
import { independentReviewDiffGateDisabled, isAssignedWorkRequest, readRunStartHead, reviewDiffGate, countMutatingWorkCalls, isMutatingWorkCall } from './review-diff-gate';
import { selfAuditGateDecide, completedStepIds, selfAuditReopened, recordSelfAuditOutcome, recordSelfAuditStepOutcomes, labelSelfAuditOutcome, type SelfAuditGateDecision } from './self-audit-gate';
import { selfAuditPlanSig, laneAuditedThisRun, receiptRuleWouldSkip, selfAuditReceiptRuleMode, selfAuditControlSample, checkReceiptRuleDemotion, checkReceiptRulePromotion, type ReceiptRuleVerdict } from './self-audit-receipt-rule';
import { recordRunReceiptAsync, getRecentChatReceipts } from './run-receipts.service';
import { resolveReceiptRunId } from '../../../utils/run-telemetry-context';
import { isRetiring } from './retiring';
import { auditOutboundArgs, OUTBOUND_AUDITED_TOOL_ARGS } from './outbound-claim-audit';
import { loadUserTimezone, buildCodingDateTimeBlock, buildCodingClockNote, buildChatWakeClockNote } from './datetime-context';
import { buildRepoDivergenceNotice } from './workspace.service';
import { stripTransientHarnessMessages } from './transient-messages';
import { isEvidenceToolName, countEvidenceToolCalls } from './evidence-tools';
import { repairToolCallTranscript } from './transcript-repair';
import { ContextGauge, contextGaugeDisabled, chatClearingDecision, chatFastPathClear, CONTEXT_EDIT_KIND, keepClearedTexts } from './context-gauge'; // build 2026-10-08 C (+ 2026-10-11 T1: tier-1 act)
import { classifyMalformedToolHistory, repairMalformedToolCallArguments, historyRepairDisabled, MAX_HISTORY_REPAIRS_PER_RUN } from './context-clearing'; // build 2026-10-08 C-2
import { groundingHaystack, findUngroundedIdArgs, detectIntendedToolChannels, ungroundedIdRefusal, toolNotOfferedRefusal, isNoopShellCommand, detectNarratedToolIntent, sameNarration, wakePromptHaystack, intentMismatchDiscount, intentMeasureSystemExcludeDisabled } from './tool-preflight';
import { createToolIntentShadow } from './tool-intent-gate';
import { parseToolArguments, toolArgumentRejection, classifyToolCallLoss, isUnrecoveredSeverance, isTransportSeveredRejection, type ToolCallTurnEvidence } from './tool-arguments'; // ticket 5bdbb126: lossless arg repair at the execution seam; ticket aa59535b: per-class rejection text; 8b62e61e: classify a cut from the TURN's own arithmetic (severed-in-transit vs unclassified); 1425001e: the LOSS-signal predicate for the acceptance metric; cffd0d0a: a never-executed (severed) call is exempt from the repeat-break loops
import { createEvidenceLedger } from '../chat-agent/evidence-ledger';
import { isAccountTool } from '../platform/account-tools';
// Cause-level fix for the kimi-k3 wrong-tool emission class (owner 2026-09-22):
// model-facing names that share no prefix with hot tools, schema scoping for
// triage / supervisor-only tools, and the refused-slip transcript prune.
import {
  applyModelToolNames, modelToolName, internalToolName, isLegacyAliasEmission, offeredNamesBothForms,
  isTriageTool, isSupervisorOnlyTool, TRIAGE_TOOL_GROUP, triageToolsAlwaysVisible, supervisorToolsAlwaysVisible,
  runMentionsTicketWork, looksLikePlaceholderId,
  isSupervisorOnlyRefusal, supervisorOnlyPermaAfter,
} from './tool-scope';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
import { getValidToken } from '../github/token-manager';
import { ensureSessionContainer, execInContainer, isContainerMode, reapOrphanedBuildProcesses, workspaceExecExposure, noteSessionContainerIdentity, recoverSessionShellContainer } from './container.service';
import { containerReplacementNotice } from './container-identity';
import { gatherSessionCredentialEnv, credentialEnvNote } from './session-credentials';
import { credentialScrubValues, ghProxyShellPrefix } from './credential-proxy'; // build 2026-10-08 ISO (+ 2026-10-11 ISO-GH: the gh kit prefix)
import { getPlan, applyPlan, planToUpdate, renderPlanReminder, getLastSelfAuditPlanSig, recordSelfAuditPlanSig } from './plan.service';
import { noProgressBrakeDisabled, noProgressBrakeThreshold, isProgressTool, noProgressNotice, NO_PROGRESS_RECHECK_EVERY, noProgressBrakeV2Disabled, noProgressEscalationNotice, isChangeTool, NO_PROGRESS_MAX_RUNGS } from './no-progress-brake';
import { kickCodeIndexSync, buildCodeMatchesBlock } from './code-index.service';
import { kickLearningsIndexSync, buildLearningsBlock, sliceLearningsForInjection, createFailureLearningNudger, looksLikeToolFailure } from './learnings-index.service';
import { CodingRole, ROLES, ROLE_TOOLS, toolsForRole, orchestratorRoleGuidance, isCodingRole, isWriterRole } from './roles';
import { metricTriggerKindFor } from './metric-trigger-kind';
import { storeFindings, buildSessionMemoryInventory } from './coding-retrieval.service';
import { recordVerify, captureVerifyFingerprint, getVerifyState, captureWorktreeTree, readHeadSha, recordVerifyAbsent } from './verify-state';
import { autoVerifyUnchangedSkipDisabled, verifyChainSignature, greenCoversChain, unchangedSinceGreenText } from './verify-unchanged-skip';
import { INTEGRATION_TOOL_SCHEMA, INTEGRATION_TOOL_NAMES, isIntegrationTool, executeIntegrationTool } from './coding-integrations';
import { githubFileReadToolDisabled } from './integration-tool-schema';
import { isUserMcpToolName, userMcpDisabled, textMentionsUserMcpServer } from '../user-mcp/user-mcp-tools';
import type { UserMcpRunTools } from '../user-mcp/user-mcp.service';
// NOTE: imported up here (not further down) because CHAT_ORCH_TOOLS below reads
// CHAT_PROFILE_PLATFORM_TOOLS at MODULE SCOPE — the import must precede that use.
import { AgentProfile, CODING_PROFILE, CHAT_PROFILE_PLATFORM_TOOLS } from './agent-profiles';

// Roles whose gathered content is offloaded to session retrieval memory (so the
// orchestrator/coder can pull full detail back via search_memory).
const OFFLOAD_ROLES = new Set<CodingRole>(['explorer', 'web_researcher', 'architect']);
// Tools whose results are worth storing (content-producing reads).
const OFFLOAD_TOOLS = new Set(['read_file', 'scrape_as_markdown', 'scrape_batch', 'search_engine', 'grep', 'ast_search']);
// A single orchestrator read bigger than this is stored to RAG and replaced in
// context with an excerpt + a search_memory pointer, so broad exploration by the
// orchestrator itself can't bloat the window (subagents keep full detail locally).
const LARGE_READ_CHARS = 6000;
// Display slice for one tool result in the persisted transcript / live UI.
// Results past this are truncated with a marker whose search_memory pointer is
// TRUE only when an offload actually happened (P6 — v1#19).
const DISPLAY_RESULT_CAP = 8000;
// Hard cap on the assistant's own prose stored per turn — a backstop against a
// large/borderline-repetitive turn bloating the transcript (the stream-layer
// degeneration guard catches the egregious loops first).
const ASSISTANT_CONTENT_CAP = 16000;
// Hard cap on a Kimi K3 turn's reasoning_content replayed with its assistant
// message (ticket 22c309f4). Moonshot's Preserved-Thinking contract requires
// replaying the complete assistant message AS-IS — the old 16k truncation
// clipped real 67-71k-char max-effort traces (turn-recovery evidence
// 2026-09-13), silently degrading the next turn per the vendor docs. This is
// now a pathological-only valve (~3x the largest observed trace; reasoning
// counts toward the context budget, so compaction still self-regulates bloat).
const ASSISTANT_REASONING_CAP = 200_000;
// ── Identical-call loop-breaker exemptions (ticket e882204f) ──
// Tools whose DOCUMENTED use is identical-argument repetition across turns:
// background-process monitors (start_background_process → read_process_output /
// wait_for_process_output is the prescribed poll pattern), provisioning polls
// (start_coding_session → "poll get_chat_status until coding.status is ready"),
// and run_command (rebuild/retry loops are legitimate iteration — same exemption
// the failure derail-breaker gives it). Everything else called with the
// IDENTICAL signature 3 turns running is a budget-burn loop, not work.
/**
 * Per-turn tool-call batch cap (autonomy loop #9, 2026-09-20). Run 1cf6f9d4
 * (glm-5.3, schedule-fired): ONE model turn emitted 233 update_feedback calls
 * and the next 327 — 560 refusals in two minutes, 812 calls in the run. The
 * repeat and derail breakers count per CALL and act after the batch, so every
 * call in a storm turn executed. Only the first TOOL_BATCH_CAP calls of a turn
 * run; the rest receive a synthetic "[HARNESS — not executed]" result (every
 * tool_call still needs its tool message or the API rejects the transcript),
 * and a turn dominated (≥ 80%) by one tool counts as a repeat-break trip for
 * it. Legitimate parallel reads sit far below 24. TOOL_BATCH_CAP tunes.
 */
export const TOOL_BATCH_CAP_DEFAULT = 24;
export function toolBatchCap(): number {
  const n = Number(process.env.TOOL_BATCH_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TOOL_BATCH_CAP_DEFAULT;
}

/**
 * Per-run volume cap on create-class fleet tools (ticket 54a172ac, 2026-09-20).
 * CanLaw run c510c56f (kimi-k3, schedule-fired) decoder-locked into a
 * repetition loop and issued 64 todo_create calls ("noop1"…"noop64") across
 * ~35 min — every other breaker was blind: the calls SUCCEED (the derail
 * breaker counts failure-shaped results only), the titles differ per call
 * (the repeat breaker needs identical name:arguments signatures), and the
 * stream was spread across turns (the storm leg needs >24 calls in ONE
 * turn). A run that creates more than LOOP_VOLUME_CAP todos/goals is in a
 * loop, not doing work: calls past the cap are refused BEFORE execution
 * (failure-shaped, so the derail streak sees further attempts) and the tool
 * is perma-withheld for the rest of the run. LOOP_VOLUME_CAP tunes.
 */
export const LOOP_VOLUME_CAP_DEFAULT = 25;
export function loopVolumeCap(): number {
  const n = Number(process.env.LOOP_VOLUME_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LOOP_VOLUME_CAP_DEFAULT;
}

/** Per-tool ceiling on ARMED intent-discount applications (ticket 0625bf62).
 *  Past this many discounted mismatches on ONE tool in a run, the classic
 *  2c98b460 count/steer/trip ladder owns that tool again — the armed discount
 *  absorbs the measured ordered-batch class (9/9 on archive_chat, streaks
 *  1→5 twice) but can never hand a decoder-locked mutating platform-tool
 *  loop an unbounded exemption (archive_chat/move_chat/rename_chat have no
 *  54a172ac volume-cap owner). DERAIL_INTENT_DISCOUNT_CAP tunes. */
export const DISCOUNT_ARM_CAP_DEFAULT = 25;
export function discountArmCap(): number {
  const n = Number(process.env.DERAIL_INTENT_DISCOUNT_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DISCOUNT_ARM_CAP_DEFAULT;
}

/** Create-class fleet tools under the per-run volume cap (board-ledger pollution class). */
const VOLUME_CAP_TOOLS = new Set(['todo_create', 'goal_create']);

const REPEAT_BREAK_EXEMPT_TOOLS = new Set([
  'run_command',
  'read_process_output',
  'wait_for_process_output',
  'get_chat_status',
  'wait_for_chat', // T3b: re-calling to keep waiting IS the prescribed pattern
]);

/**
 * Near-identical repeat-leg eligibility (ticket 54a172ac, inline adversarial
 * review F1 2026-09-20): the digit-collapsed signature counts ONLY for
 * consequential tools — the same watch set buildLoopMarker flags per run
 * (RECEIPT_TOOLS minus run_command, plus update_plan). A content-returning
 * tool called with digit-varying args (read_file page1..page4, `cat
 * shard1…` via run_command) gains NEW information every turn, so the
 * breaker's "adds no new information" premise is false there — counting
 * those turns was a false positive that could strip a working run of
 * read_file on a legitimate numbered-read sequence. Receipt/write tools
 * return ids, not information — digit-varying repetition on them IS the
 * decoder lock this leg exists to break (todo_create noop1…noop64).
 */
const NEAR_BREAK_TOOLS: ReadonlySet<string> = new Set(
  [...RECEIPT_TOOLS].filter((n) => n !== 'run_command').concat(['update_plan']),
);
// Chat orchestrator (no role, non-coding profile): web + connectors +
// search_memory only — no file/git/process/verify tools, no delegate (the
// harness pre-step owns cross-checking in Phase 2). ALL integration tools are
// included via INTEGRATION_TOOL_NAMES (parity tripwire: coding-integrations.test).
// PLUS the platform tools (P1 "Digby can use Digby"): the chat profile opts into
// managing the user's chats/projects/schedules via CHAT_PROFILE_PLATFORM_TOOLS.
// PLUS ask_user (confirmation UX): the chat orchestrator can pause for a HUMAN
// decision — same schema/semantics as coding (the shared CODING_TOOL_SCHEMA),
// resolved in-process via POST /chats/:chatId/questions/:questionId.
// computer_task (2026-09-09): FULL computer use — the user's real Mac screen +
// apps via the paired agent. It was in TOOL_DEFINITIONS since 2026-08-31 but
// never in this set, so chat Digby could not call it at all (owner: "why is it
// not full on computer use and just browser use").
export const CHAT_ORCH_TOOLS = new Set(['search_engine', 'scrape_as_markdown', 'fetch_image', 'browser_task', 'computer_task', 'web_pipe', 'youtube_pipe', 'search_memory', 'search_code_semantic', 'ask_user',
  // Agent document tools (ticket 9dac6576): create/read/edit/list generated
  // files + PDF form fill. They're in TOOL_DEFINITIONS → WEB_TOOL_NAMES, so
  // agent runs dispatch them through the ToolCache path with the run's userId
  // (anonymous runs get the tools' sign-in message).
  'create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form',
  // Image generation (owner 2026-09-24): the Image generator seat as a tool —
  // same ToolCache dispatch as the document tools (sign-in gated, rate-slotted,
  // saved as a GeneratedFile). Hidden from machine-triggered runs below;
  // workers never get it (ROLE_TOOLS untouched) so a council never double-spends.
  'generate_image',
  ...INTEGRATION_TOOL_NAMES, ...CHAT_PROFILE_PLATFORM_TOOLS]);
// fetch_image (e8ef6b04) is CHAT-ONLY — the inverse of VIEW_IMAGE_TOOL's
// coding-only filter (tool-groups.ts): chat peers get no image parts, so the
// tool fetches bytes and attaches them to the reply; coding lanes already see
// pixels natively or via view_image, and its +1 on the coding roster tips the
// 128-tool LRU cap arithmetic one load early (tool-groups.registry.test q4:
// connector_google evicted one load sooner → asana load evicts nothing). The
// coding arms of BOTH assemblers (probe + live) drop it; the chat arms keep it
// via CHAT_ORCH_TOOLS above. Workers never see it (ROLE_TOOLS untouched).
const CODING_EXCLUDED_TOOLS = new Set(['fetch_image']);
function offloadRef(tool: string, args: any): string {
  return String(args?.path || args?.url || (Array.isArray(args?.urls) ? args.urls.join(', ') : '') || args?.query || args?.pattern || tool).slice(0, 300);
}
// Ticket f03b739c (2026-10-13): a raw BrightData SERP body (base64 webp icons,
// sxsrf/fbs URL tokens, pagination arrays, encrypted-tbn image URLs) flowed
// through these offload paths into session memory verbatim — worthEmbedding
// passes anything ≥200 chars, so the scaffolding embedded chunk by chunk and
// now competes with real content in every search_memory retrieval. Every
// storeFindings offload site below routes through this gate: failed search
// surfaces store a compact error record instead of the body; SERP payloads
// distill to titles/links/snippets; everything else is unchanged.
// Kill switch SERP_MEMORY_SANITIZE_DISABLED=1.
import { sanitizeForMemoryEmbed, failedSearchCompactRecord } from './serp-memory-sanitize';
import {
  readDigbyConfig, readDigbyConfigDetailed, resolveVerifyChain, runVerifyChain, loopConfig,
  failureSignature, renderVerifyFeedback, type DigbyConfig,
} from './verify.service';
import { runGatedVerifyChain } from './verify-container-slots'; // build 2026-10-09 VS: per-process FIFO + per-container slot
import { raceToolHardTimeout } from './tool-hard-timeout';
import { messagesChars, compactMessages, clipOversizedMessages, shrinkLargestToolResults, CONTEXT_CHAR_BUDGET, compactionTriggerChars, modelErrorTerminalNote, MEMORY_READ_TOOLS, memoryReadReoffloadSkipDisabled, compactStepDecision } from './compaction';
import { UsageAccumulator, estimateTurnUsage } from './cost';
import { trimToPreModel, RunCheckpoint } from './run-state';
import { loadSessionUsage, commitRunUsage, mergeRunIntoSession, emptySessionUsage, SessionUsage } from './usage-store';
import { recordRunSpend, recordLoopMetric, noteSeatFallback, LOOP_METRIC_KINDS, MetricStamp } from '../platform/loop-metrics.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import { newWebToolCapState, webToolCapCheck, webToolCapRefusal, webToolsOfClass, type WebToolCaps, type WebToolCapState } from './web-tool-cap';
import {
  BackgroundWorkerPool, BackgroundUsageAccumulator, backgroundLatePostGraceMs, backgroundRunEndWaitMs, backgroundStartedText, backgroundStatusMaxWaitMs,
  backgroundWorkerCap, delegateBackgroundDisabled, formatInjectedReport, lostBackgroundWorkerIds, lostWorkersNotice,
  postBackgroundReportMessage, sessionCanReceiveLatePost, recoverBackgroundReportsOnResume, formatRecoveredReport,
  spillBackgroundReport, clearBackgroundReportSpills, finalizeSpillClearIds, type BackgroundTaskSpec, type BackgroundWorker,
} from './background-delegation';

const execFileAsyncAgent = promisify(execFile);

/** A throwing budget hook never breaks the loop — fail open (no collapse). */
function safeForceFinalTurn(hook: () => boolean): boolean {
  try { return hook() === true; } catch { return false; }
}

/** The end-turn-after-tool-round hook (hand-off polish): a throw / empty answer = no collapse. */
function safeEndTurnNotice(hook: () => string | null | undefined): string | null {
  try {
    const v = hook();
    return typeof v === 'string' && v.trim() ? v : null;
  } catch { return null; }
}

/** The FINAL TURN notice pushed when the step budget runs out (hoisted from
 *  the inline literal at the push site; exported for the lossy-finals pin).
 *  Ticket 56df4bfc (lossy finals, 2nd same-day instance): coding lanes spent
 *  their one durable message on an audit/ETA summary while the actual
 *  deliverable stayed in the worktree or mid-run text — the final IS the
 *  deliverable, so audit text must be explicitly subordinate. */
export const FINAL_TURN_NOTICE = '[HARNESS NOTICE — not typed by the user] FINAL TURN: tool calls are no longer available. Write your final answer now — not a transition line. Your final message is the DURABLE DELIVERABLE of this run — the one message the supervisor, the owner, and future runs are guaranteed to see: LEAD with what the run produced (the artifact by its file NAME — never an absolute worktree or container path — ids, or the answer itself), complete enough that a reader who sees ONLY this message receives the work. A self-audit, ETA, or claim summary may FOLLOW the deliverable but must never displace it — a final that carries only an audit/ETA summary while the deliverable stays in the worktree or mid-run text is a FAILED delivery (ticket 56df4bfc). Report ONLY what you actually did and observed THIS run, citing the tool results you hold. If work remains or something is unverified, say so plainly: an honest partial status IS the correct deliverable. NEVER describe an action, timestamp, PR, or result you did not obtain from a tool this run.';

/** audit 2026-10-06 T1-8 (schooltime.md #10): the step budget of a goal-continue
 *  ROUND ends in a tools-off turn, and FINAL_TURN_NOTICE made the model write a
 *  "Run outcome (final turn — run ended at plan step 2 of 7) … Not done this
 *  run" deliverable that the harness then threw away by auto-continuing (run
 *  f0fe6745: 16 rounds, 16 fake finals in the streamed transcript). When the
 *  goal-continue lane WILL resume (goalContinueWillFollow — the same inputs its
 *  decision reads; a tools-off turn can change neither the plan nor the
 *  worktree), the turn gets this CHECKPOINT notice instead. Kill switch
 *  FINAL_TURN_CHECKPOINT_DISABLED=1. */
export const CHECKPOINT_TURN_NOTICE = '[HARNESS NOTICE — not typed by the user] CHECKPOINT — this is NOT the end of the run: this round\'s step budget is spent, so tool calls pause for this ONE turn, and the harness resumes this SAME task right after with your tools back and the plan\'s unfinished steps listed. Do NOT write a final report, run outcome, "not done this run" list or summary. Reply with ONE short line: the next concrete action you will take when tools return.';
export function finalTurnCheckpointDisabled(): boolean { return process.env.FINAL_TURN_CHECKPOINT_DISABLED === '1'; }

/** In-process bash fallback (secret-scrubbed env, cwd-locked). */
async function execInProcess(command: string, cwd: string, timeoutMs: number, extraEnv?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return execFileAsyncAgent('bash', ['-lc', command], {
    cwd,
    // Base scrubbed env (NO Digby provider/infra secrets) + the user's own
    // connected-integration credentials (extraEnv) so the shell has chat-parity access.
    env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8', CI: '1', GIT_TERMINAL_PROMPT: '0', NODE_ENV: 'development', ...(extraEnv || {}) },
    timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  }).then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
}

const MAX_STEPS = 200;        // top-level orchestrator tool rounds (keep in sync with CODING_PROFILE.maxSteps)

// AUTO mode is unattended: the orchestrator must run a DYNAMIC WORKFLOW —
// plan first, delegate in parallel, monitor long-running work — instead of
// grinding inline. Appended to the orchestrator system prompt in auto mode.
export const AUTO_WORKFLOW_DOCTRINE = `
AUTO MODE — DYNAMIC WORKFLOW (mandatory):
- You are unattended. Drive the task to DONE; never stop to ask a question you can resolve yourself.
- CONFIRMATIONS in auto mode: ask_user is the escape hatch, NOT a checkpoint — call it to CLARIFY a missing detail that materially changes the deliverable (no sensible default), for CREATIVE DIRECTION the user has not given (offer 2-4 directions as options), for genuinely human-worthy decisions (irreversible/risky, spends money, changes account/security posture, or deletes data), or when you remain genuinely confused after research. Goal-aligned routine actions: just do them, never ask.
- FIRST set the plan: update_plan with a goal, acceptance criteria, and ordered steps. Keep step statuses current as you work.
- Run a dynamic workflow, not a monologue: DELEGATE self-contained steps to role workers — delegate_parallel for independent steps (research, exploration, verification legs) — and reserve yourself for sequencing, integration, and review. Inline work is for trivial single-step edits only.
- Long-running commands (dev servers, watchers, builds or test suites that may exceed ~2 minutes): start_background_process + wait_for_process_output is your MONITOR — never block the foreground on them. A foreground command that times out is auto-promoted to a monitored background process; pick it up with wait_for_process_output rather than re-running it.
- BUDGET SAFETY NET: before starting any long blocking sequence that could eat the whole step budget (paired-device computer_task, big downloads/installs, or delegation chains), arm ONE cheap one-shot schedule_self as a follow-up wake for the remaining work; a "next turn" you merely promise in your final is a stall — nothing wakes the session unless YOU arm it. Cancel the one-shot (cancel_schedule) once the work lands, and never stack a second net for the same job.
- DEV SERVERS / PREVIEWS: before starting, CHECK the port is free (e.g. \`ss -ltn | grep -q ':3000 ' && echo busy\`); if busy, pick another (3001, 4173, 5173, 8080…) and configure the app accordingly. ALWAYS pass ready.port (+ ready.httpPath or ready.logMatch) to start_background_process — when the server comes up ready, the user's preview pane is configured to that port AUTOMATICALLY. Never tell the user to set the port by hand.
- The harness auto-continues you while plan steps remain unfinished and auto-verifies at the end. Leave no step pending: complete it, or mark it blocked with a note via update_plan.`;

const DELEGATE_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'delegate',
    // build 2026-10-08 A2-3 (tool diet): the camera-only rule for read-only workers is ticket 8fe9429c.
    description: 'Delegate a focused, self-contained sub-task to a SPECIALIZED worker subagent (orchestrator only). The worker shares this session\'s worktree + permission mode, has a role-appropriate tool set and reports back a summary; todo_id links it to a plan step (marked completed/blocked on return). model: "helper" = the fast low-cost model (fine for mechanical fetch/verify work), "premium" = your own model; omit for the role default. READ-ONLY ROLES (planner/architect/explorer/web_researcher/cross_checker/verifier/reviewer) cannot create or edit files — a file-output brief to one is refused at dispatch (delegate to coder/editor, or write the file yourself from its report) — and their device access is camera-only (they can look at a paired screen, never click or type: do desktop actions yourself). Roles: ' + (Object.keys(ROLES) as CodingRole[]).map(r => `${r} (${ROLES[r].purpose})`).join('; ') + '.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: Object.keys(ROLES), description: 'Which specialized worker to run.' },
        task: { type: 'string', description: 'Complete, self-contained instructions + what to report back.' },
        title: { type: 'string', description: 'Short label for the sub-task (shown in the UI).' },
        todo_id: { type: 'number', description: 'Optional plan step id this task fulfils (marked done/blocked on return).' },
        model: { type: 'string', enum: ['premium', 'helper'], description: 'Optional model tier for this worker: "helper" = fast low-cost model, "premium" = the full orchestrator model. Omit to use the role default.' },
      },
      required: ['role', 'task'],
    },
  },
};

const MAX_PARALLEL_WORKERS = 6; // raised 4→6 2026-09-02 (owner throughput review): read-only fan-out, model-tiered workers keep cost bounded
const DELEGATE_PARALLEL_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'delegate_parallel',
    description: `Delegate several INDEPENDENT read-only investigations to run CONCURRENTLY (orchestrator only, up to ${MAX_PARALLEL_WORKERS}). Only non-writing roles are allowed (planner, architect, explorer, web_researcher, verifier, reviewer) — never coder/editor (concurrent writes corrupt the worktree; delegate those one at a time). Returns all workers' summaries together.`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Independent sub-tasks to run in parallel.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: Object.keys(ROLES) },
              task: { type: 'string' },
              title: { type: 'string' },
              todo_id: { type: 'number' },
              model: { type: 'string', enum: ['premium', 'helper'] },
            },
            required: ['role', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
};

// ── Background delegation (coding/background-delegation.ts) ──
// The schemas below EXTEND the two above with `background` and add
// delegate_status; under the kill switch (DELEGATE_BACKGROUND_DISABLED=1) the
// run offers the two schemas above byte-identically and no delegate_status.
const BACKGROUND_PARAM = {
  type: 'boolean',
  description: `true = run the worker in the BACKGROUND: the call returns at once with a handle, you keep working, and the report arrives later as a [BACKGROUND WORKER REPORT] harness message. Read-only roles only (never coder/editor); at most ${backgroundWorkerCap()} background workers run at once. Omit/false = the call BLOCKS until the worker finishes.`,
};
const DELEGATE_SCHEMA_BG = {
  type: 'function' as const,
  function: {
    name: 'delegate',
    description: `${DELEGATE_SCHEMA.function.description} BLOCKING vs BACKGROUND: a plain delegate BLOCKS until the worker finishes (fine when its answer is your next step); with other work meanwhile pass background:true — a handle returns at once and the report arrives at a later turn boundary (or via delegate_status). Long, independent work that should outlive this run belongs in its own session (start_coding_session), not a worker.`,
    parameters: {
      ...DELEGATE_SCHEMA.function.parameters,
      properties: { ...DELEGATE_SCHEMA.function.parameters.properties, background: BACKGROUND_PARAM },
    },
  },
};
const DELEGATE_PARALLEL_SCHEMA_BG = {
  type: 'function' as const,
  function: {
    name: 'delegate_parallel',
    description: `${DELEGATE_PARALLEL_SCHEMA.function.description} This call BLOCKS until ALL of them finish; pass background:true to start them all in the background instead (one handle each, reports arrive as harness messages — check with delegate_status).`,
    parameters: {
      ...DELEGATE_PARALLEL_SCHEMA.function.parameters,
      properties: { ...DELEGATE_PARALLEL_SCHEMA.function.parameters.properties, background: BACKGROUND_PARAM },
    },
  },
};
export const DELEGATE_STATUS_TOOL = 'delegate_status';
const DELEGATE_STATUS_SCHEMA = {
  type: 'function' as const,
  function: {
    name: DELEGATE_STATUS_TOOL,
    description: 'Check (or briefly await) the BACKGROUND workers this run started with delegate/delegate_parallel background:true. Returns each worker\'s state; a finished worker\'s report is returned here once (then it is not injected again). wait_seconds > 0 blocks until the named worker (or, without a handle, any running worker) finishes — bounded by the harness ceiling. Do not poll in a loop: reports arrive by themselves at turn boundaries.',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Worker handle returned by the background call (e.g. "bg1-k3p9"). Omit for all of this run\'s background workers.' },
        wait_seconds: { type: 'number', description: 'Optional: wait up to this many seconds for the worker to finish (bounded). 0/omitted = check now.' },
      },
    },
  },
};
/** The delegation schemas this run offers (background-aware unless the kill switch is set). */
function delegateToolSchemas(): any[] {
  return delegateBackgroundDisabled()
    ? [DELEGATE_SCHEMA, DELEGATE_PARALLEL_SCHEMA]
    : [DELEGATE_SCHEMA_BG, DELEGATE_PARALLEL_SCHEMA_BG, DELEGATE_STATUS_SCHEMA];
}

// ── Progressive tool disclosure (2026-09-09) ──
// The 17 account tools (platform/account-tools.ts — memory, feeds, canvases,
// knowledge, telegram notify, share links, chat instructions) were built for
// the CHAT lane. Landing them in every coding-session schema (fe27ebc0) is the
// prime suspect for kimi-k3's same-day fleet-wide wrong-tool derailment
// (update_canvas was the #2 derail tool). Coding-lane orchestrators now get
// ONE meta-tool instead; calling it adds the group for the rest of the run.
// Same pattern as deferred tools in agent harnesses: a lean default schema,
// capability on request, nothing lost.
export const LOAD_TOOL_GROUP_TOOL = 'load_tool_group';
/** detectIntendedTool may return a MODEL-FACING name (the reasoning names what
 *  the model was offered) — every downstream seam keys on internal names. */
const internalOrNull = (n: string | null): string | null => (n ? internalToolName(n) : null);
const LOAD_TOOL_GROUP_SCHEMA = {
  type: 'function' as const,
  function: {
    name: LOAD_TOOL_GROUP_TOOL,
    description:
      'Load an optional tool group into your tool list for the rest of this run. Group "account": the user-account tools — get_account_overview, list_memory/remember_fact/forget_fact, list_canvases/get_canvas/update_canvas, list_knowledge_documents/add_knowledge_url/add_knowledge_note, revoke_share_link/create_share_link, notify_user (Telegram push), set_chat_instructions, telegram_connect_link. ' +
      'They are NOT loaded by default in coding sessions — call this ONLY when the task genuinely needs one of them (e.g. "notify me on Telegram when done", "remember that…", "update the canvas"). Returns the names now available.',
    parameters: {
      type: 'object',
      properties: {
        group: {
          type: 'string', enum: ['account', TRIAGE_TOOL_GROUP],
          description: 'The tool group to load. "account": the user-account tools. "triage": the feedback-queue tools (list_feedback + the ticket update tool) — hidden from coding sessions that were not dispatched a ticket; load it ONLY when your task is to work or triage feedback tickets.',
        },
      },
      required: ['group'],
    },
  },
};

/** Mark a delegated todo done + attach the worker's summary; returns the new plan. */
async function linkTodoResult(sessionId: string, worktree: string, todoId: number, summary: string, blocked: boolean) {
  const plan = await getPlan(sessionId);
  if (!plan) return null;
  const u = planToUpdate(plan);
  const s = u.steps[todoId - 1];
  if (!s) return null;
  s.status = blocked ? 'blocked' : 'completed';
  s.note = summary.replace(/\s+/g, ' ').slice(0, 160);
  const { plan: updated } = await applyPlan(sessionId, worktree, u);
  return updated;
}

// Web/browser/github tools shared with the chat pipeline (search_engine,
// scrape_as_markdown, scrape_batch, browser_task).
// web_pipe/youtube_pipe are EXCLUDED: in agent runs they must route to the
// session-aware coding executor (RAG storage needs sessionId); the ToolCache
// path is for legacy models. If a pipe tool ever lands in this set, agent runs
// silently take the digest-only legacy path and the "embedded to session
// memory" contract breaks — guarded by the tripwire test in
// coding-integrations.test.ts.
export const WEB_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.function.name).filter(n => n !== 'web_pipe' && n !== 'youtube_pipe'));

/** Document-seam tools whose id args the placeholder-streak detector (re-
 *  anchor leg (c), ticket 431518a2) grounds AFTER execution — unlike the
 *  platform tools they are not preflight-refused, so an invented-id call is
 *  seen off its failure result via the same grounding rule (tool-preflight). */
const DOC_SEAM_ID_TOOLS = new Set(['update_document', 'read_document', 'fill_pdf_form']);

export interface AgentRunInput {
  worktree: string;
  sessionId: string;
  projectId: string;
  /** A plain chat in the hidden user space (userSpaceChatIsolated, 2026-10-20): search_memory reads none of the
   *  space's project memory (ToolContext.projectMemoryIsolated). Workers inherit it with the input. */
  projectMemoryIsolated?: boolean;
  userId: string;
  permissionMode: PermissionMode;
  model: string;
  /** What governed `model` (seats govern sessions, 2026-09-28; coding/seat-governance.ts):
   *  'explicit' | 'project' | 'preference' | 'seat' | 'stamp' — rides the run's
   *  metric stamp so run_spend meta.modelSource says what governed. Omitted =
   *  not stamped (chat lanes / older callers). */
  modelSource?: string;
  /** GOAL-PRIORITY-SPEND (2026-10-20, platform/goal-spend.ts resolveRunGoalId): the goal this lane's spend is
   *  attributed to — the chat's charterGoalId, else its charter todo's goal. Rides the run's metric stamp
   *  (run_spend / run_tokens meta.goalId). Omitted = not attributed (supervisors, plain chats, workers inherit
   *  the input). GOAL_SPEND_ATTRIBUTION_DISABLED=1 ⇒ run-executor never sets it. */
  goalId?: string;
  /** A4 machine-firing effort step-down (2026-10-04, machine-firing-effort.ts):
   *  set by run-executor ONLY for a schedule / hook firing — `cap` 'high' on an
   *  all-complete plan board (the lead seat's existing reasoning_effort is
   *  lowered via coding/effort-cap.ts capReasoningEffort, never added), null = keep the
   *  seat's effort. Applied to the TOP-LEVEL run's lead seat only (workers keep
   *  their seats); the effort + reason ride run_spend. Omitted = byte-identical. */
  machineFiringEffort?: MachineFiringEffort;
  /** The model-roles SEAT this run is on ('supervisor', 'project_supervisor',
   *  'chat_orchestrator', 'coding_default'; 2026-09-27) — names the seat whose
   *  ADMIN CUSTOM FALLBACK the lead-seat fallback lanes consult
   *  (pickLeadFallback) and the role a seat_fallback row is filed under.
   *  Omitted = coding_default (the coding lanes; byte-identical to before). */
  seatRole?: string;
  projectName: string;
  branch: string;
  // Publishing context (git_push / open_pull_request).
  repoUrl?: string;
  provider?: string;
  baseBranch?: string;
  githubLabel?: string | null;
  /** Engine profile (One-Digby Phase 2). Omitted = CODING_PROFILE (today's behavior). */
  profile?: AgentProfile;
  /** Helper-SEAT run (helper-tier worker / delegate({model:'helper'})): the
   *  provider is resolved in its fast shape — a DeepSeek built-in runs with
   *  thinking off and no reasoning_effort (coding-model.ts fastSeatProvider). */
  fastSeat?: boolean;
  /** roster 2026-10-06 C-4: a per-run web-tool budget (the Quick lane — ./web-tool-cap.ts). 'act' refuses calls past
   *  a class's cap and withholds the class; 'shadow' only counts. Absent = no budget (every other run). */
  webToolCaps?: WebToolCaps;
  /** Chat profiles: the full system doctrine (replaces the coding systemPrompt). */
  doctrineOverride?: string;
  /**
   * Per-chat custom instructions (crossmodel_chats.systemPrompt — project
   * supervisors). Appended LAST in the coding doctrine (highest precedence,
   * after repo context + memory). Ignored when doctrineOverride is set (the
   * chat-agent path already carries it inside its systemContext).
   */
  chatSystemPrompt?: string;
  /** The owner's fleet notice block (platform/fleet-notice.ts renderFleetNoticeBlock) — '' / unset = none. */
  fleetNotice?: string;
  /** Strip web tools for this run (e.g. the gateway is down — don't grind retries). */
  noWebTools?: boolean;
  /** build 2026-10-08 A2b (coding/tool-diet.ts): the turn plan's lane + needs_live_web for a HUMAN chat turn — a
   *  getter over the plan chat-agent ALREADY computed (zero extra decision calls; null = no classified plan yet).
   *  Read at run start (the lane-aware starting tool set) and again at run end (the shadow row). */
  toolLaneHint?: () => ToolLaneHint | null;
  /**
   * Cap-skip notice for THIS run (run-executor): rendered as a [SCHEDULER
   * NOTICE] block in the system prompt — system context only, never part of
   * the persisted user message. Stripped when delegating (cadence is the
   * orchestrator's concern, not a worker's).
   */
  schedulerNotice?: string;
  /**
   * CLAIM BAR for an agent/webhook-triggered machine run (mishap b397a918):
   * the executor injects MACHINE_CLAIM_BAR_TEXT (chat-agent/machine-wake.ts)
   * when triggerKind === 'machine' — the one machine class whose queued user
   * row carries NO bar (schedule/hook firings get one from machineFiringHeader
   * at queue time; ticket dispatches get one in the brief). Rendered in the
   * SYSTEM prompt only — never in the persisted user message (the cap-skip
   * banner rule: message rows stay human-readable). Stripped when delegating
   * (evidence discipline is the parent's concern, not a worker's).
   */
  machineClaimBar?: string;
  history: Array<{ role: string; content: ModelContent }>;
  userMessage: string;
  /**
   * Timestamp of the USER MESSAGE that triggered this run (the confirmation
   * anchor for consequential platform tools — see ToolContext.userTurnAt).
   * UNDEFINED for machine-triggered runs (schedule firings, auto-resumes) —
   * those can register pending confirmations but never confirm them.
   */
  userTurnAt?: Date;
  /**
   * Owner-subscribed schedule firing (ticket 4565991a): TRUE when THIS run was
   * fired by a schedule row carrying ownerSubscribed (or promptSetBy 'user' —
   * the 6ef770a1 signal), threaded by fireScheduleTarget via
   * startDetachedChatRun → ChatAgentRunArgs.scheduleOwnerArmed. Lets the
   * orchestrator's OWN platform-tool calls inherit the subscription: a digest
   * firing that re-arms its next one-shot rung (the dormant-gate ladder
   * pattern) stamps the successor ownerSubscribed so the next delivery also
   * renders EXPANDED. Scoped to the run's OWN chat in the tool gate — a
   * cross-chat arm from a subscribed firing is a dispatch, not a delivery.
   */
  scheduleOwnerArmed?: boolean;
  /**
   * One-shot CHAIN provenance (finding B1, 2026-09-27): the coding_schedules
   * row whose firing started this run — threaded into ToolContext so the
   * run's own-chat `once` re-arms stamp chainedFromScheduleId
   * (schedule-once-chain.ts). Undefined on every non-schedule trigger.
   */
  firedByScheduleId?: string;
  /**
   * Dig-deeper rung (cohesive chat): this run re-runs an EARLIER ask as a
   * human turn — requested-work tools card instead of executing twice
   * (ToolContext.escalation, platform/work-tools.ts).
   */
  escalation?: boolean;
  /**
   * The user's OWN message text for a human turn (bounded), threaded to
   * ToolContext.userTurnText so the requested-work gate can bind a repo URL
   * to what the user typed. The chat run passes it explicitly; a coding run
   * falls back to `userMessage` on a user-anchored, non-machine run.
   */
  userTurnText?: string;
  /**
   * TRUE when this run was MACHINE-triggered (schedule firing, hook wake,
   * agent/webhook send, auto-resume) — the deterministic zero-tool pre-final
   * gate keys on it (wake #118 fabrication class: a machine wake pattern-
   * completing its own prompt into a full report with ZERO tool calls).
   * Threaded by run-executor (triggerKind !== 'user') and chat-agent (the
   * exact classification the chat-busy run-lock marker uses). Absent/false =
   * user-triggered: the gate NEVER applies. Top-level only — workers are
   * exempt (a delegated summarize legitimately answers without tools).
   */
  machineTriggered?: boolean;
  /**
   * Decision-gate cost stamp (E5, 2026-09-25): the `meta.id` of the shadow
   * decision that gated THIS run's existence (RunInput.decision — wake_triage /
   * delta_material), threaded by run-executor so the run's run_spend row
   * carries `decisionId` and shed cost can be joined exactly. Telemetry only.
   */
  decisionId?: string;
  /**
   * Backoff-class inheritance for DELEGATE WORKERS (ticket cffaa701, review
   * finding): the delegate spread strips machineTriggered (the zero-tool
   * gate is top-level-only — a delegated summarize legitimately answers
   * without tools), which would otherwise silently drop a MACHINE parent's
   * workers back to the short interactive backoff table. Set by the delegate
   * spread when the PARENT run is machine-triggered; keys ONLY the transient
   * backoff table selection, never the zero-tool gate or any other
   * machine-posture behavior.
   */
  workerUnattended?: boolean;
  /**
   * TELEMETRY ONLY (audit 2026-10-06 T8-11): the parent loop's metric-stamp triggerKind, set by the delegate spread
   * so a worker's loop_metrics rows (seat_fallback, guard_strike, run_spend …) are attributed to the run that
   * spawned it instead of falling to 'user'. Never read for posture. SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED=1 ignores it.
   */
  parentTriggerKind?: string;
  /**
   * Owner-dispatch (2026-10-01, platform/agent-send-header.ts
   * isOwnerDispatchRun): a USER-classified run a supervisor started by
   * relaying the OWNER's own-turn ask — nobody watches it live. Keys ONLY the
   * unattended transient-backoff class here (unattendedRun); every
   * user-posture behaviour (zero-tool gate off, evidence ledger off, tool-ctx
   * classification) still follows machineTriggered. Threaded by run-executor
   * and chat-agent; stripped from delegate workers (workerUnattended carries it).
   */
  ownerDispatch?: boolean;
  /** Image attachments for the CURRENT user turn (validated upstream). */
  userImages?: ChatImage[];
  emit: (event: string, data: any) => void;
  /** Cooperative cancel — checked between steps so Stop actually halts the loop. */
  isCancelled?: () => boolean;
  /** Soft drain yield (2026-10-19): true once the draining worker asked this run to hand off. */
  isDrainYieldRequested?: () => boolean;
  /** Hand off: mark the run shutdown-interrupted (checkpoint retained) AND cancelled. */
  onDrainYield?: () => void;
  /**
   * Compute policy DepthBudget (2026-09-26, docs/DEPTH_UX_SOTA §4 hard rails):
   * polled beside the run deadline at the top of every top-level step. `true`
   * ⇒ the NEXT turn is forced to be the last through the SAME FINAL-TURN
   * mechanism the deadline uses (tools omitted, FINAL_TURN_NOTICE pushed) —
   * the model still writes a complete answer; nothing is truncated. The chat
   * harness used to pass the turn ledger's maxUsd crossing here; since the
   * owner's 2026-09-27 "no hidden cost caps" directive NOTHING passes it — a
   * generic harness hook kept for non-cost callers; absent = never forced.
   */
  forceFinalTurn?: () => boolean;
  /**
   * Hand-off polish (2026-09-28, audit CT-2): polled beside `forceFinalTurn`
   * at the top of every top-level step. A non-empty string ⇒ the NEXT turn is
   * the last through the SAME FINAL-TURN collapse (tools omitted), but the
   * notice pushed is THIS string instead of FINAL_TURN_NOTICE — the chat
   * harness uses it after a successful `start_coding_session` on a human
   * turn ("the sub-session is running; finish your answer now — never poll
   * or re-read it"). Fail-open: a throw or '' / null means no collapse.
   */
  endTurnAfterToolRound?: () => string | null | undefined;
  /**
   * Polled once per top-level step BEFORE the model turn. Return a string (or
   * { text, images } for a steer payload with attachments) to append it as a
   * user message (one-shot semantics are the caller's job). May be async — the
   * loop awaits it, which lets a harness BLOCK the run until out-of-band
   * material (e.g. parallel cross-checker drafts) is ready.
   */
  injectSystem?: (step: number) => Promise<string | { text: string; images?: ChatImage[] } | null> | string | { text: string; images?: ChatImage[] } | null;
  /**
   * Per-run overrides merged into the provider request payload (e.g.
   * { reasoning_effort: 'medium' } for one-shot drafter workers — DeepSeek at
   * 'high' burns the whole max_tokens budget on reasoning and returns empty).
   */
  providerExtra?: Record<string, any>;
  /**
   * Per-run reasoning-effort CAP (2026-10-04 lead-effort A/B, coding/effort-cap.ts): lowers a
   * `reasoning_effort` the resolved provider ALREADY sends (built-in or custom endpoint) to this level;
   * never adds the param. Applied wherever providerExtra merges (lead + every fallback provider).
   */
  effortCap?: import('./effort-cap').EffortCap;
  /**
   * Per-run EXTRA TOOLS (L3 Deep Council: dispatch_colleagues / spawn_self /
   * send_note). Schemas are appended to the run's toolset; execution is
   * checked BEFORE the built-in dispatch. Executors run a whole sub-loop, so
   * like delegate they are exempt from the single-tool hard timeout.
   */
  extraTools?: Array<{ schema: any; execute: (args: any) => Promise<string> }>;
  /**
   * Shared token/cost accumulator for the WHOLE run (orchestrator + every
   * delegated worker records into the same one — the sidebar meter breaks
   * spend out per agent). Created at the top level; inherited via input spread.
   */
  usage?: UsageAccumulator;
  /**
   * Usage-ledger SEAT for this loop, preferred over the worker role when its
   * turns are recorded (seat-label fix, 2026-09-25): the L2 reconcile pass runs
   * the LEAD model through runChatWorker under the cross_checker role (that
   * role's prompt/toolset is what the one-shot needs), so run_spend meta.seats
   * stamped 'cross_checker' on the lead's own model. The pass sets 'reconcile';
   * unset = the worker role (byte-identical). Forwarded by runChatWorker only —
   * never by delegate (workerOpts) — and it changes NOTHING about the role
   * prompt, the toolset or the agent label the events carry.
   */
  usageRole?: string;
  /**
   * Shared receipt collector for the WHOLE run (anti-confabulation evidence
   * channel — run-receipts.ts): every consequential tool execution pushes one
   * harness-written receipt here; workers inherit the SAME array via the input
   * spread, so a worker's executions land in the parent's set. Same idiom as
   * `usage`. The evidence guard reads this — never the model's prose.
   */
  receipts?: ToolReceipt[];
  /**
   * The durable agent_runs.id this execution belongs to (worker-claimed coding
   * runs). Receipts persist under it so a RESUMED run's evidence guard sees
   * prior attempts' executions (same row across attempts). Undefined for
   * non-durable callers (chat runs) — their receipts collect under the turn's
   * ambient telemetry id (chat-<uuid>, ticket e225aad8) via
   * resolveReceiptRunId, not null.
   */
  runId?: string;
  /** build 2026-10-08 D-2: the tool-intent journal of THIS attempt (coding/tool-intents.ts, SHADOW) — created on
   *  first use; workers share it through the input spread. */
  intentJournal?: IntentJournal;
  /** build 2026-10-08 D-2: a CHAT turn's idempotency anchor (the user / wake row it answers, a Dig-deeper rung, a
   *  continuation round) — stable across a deploy requeue. Worker runs key on runId instead. */
  intentScopeAnchor?: string;
  /**
   * Durable-run hooks (durability Phase 1, top-level coding runs only).
   * onCheckpoint is called fire-and-forget at each write-ahead point (top of
   * step, before each tool call). resumeFrom rehydrates an interrupted run's
   * transcript + counters. BOTH are stripped before delegating to workers —
   * a worker writing the parent's checkpoint (or rehydrating its transcript)
   * would corrupt the run.
   */
  onCheckpoint?: (cp: RunCheckpoint) => void;
  resumeFrom?: RunCheckpoint;
  /**
   * Evidence-guard REJECT-BACK config (ticket dc04deea — f8d68167 option (b)).
   * Set by run-executor for durable coding runs. When present, a top-level
   * MACHINE run's clean-finish candidate answer is run through the evidence
   * guard BEFORE the loop accepts it; a convicted answer is rejected back to
   * the model with the missing-receipt list (bounded: maxRejections) so a
   * zero-tool short-circuit run corrects BEFORE submission. On exhaustion,
   * guard error, cancel, or a leaked-tool-call candidate, the candidate exits
   * normally and the executor's replace/redact lane (option (a)) applies
   * unchanged. Workers never receive it (stripped with the delegate spread).
   */
  evidenceGuardRejectBack?: {
    triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
    resumed: boolean;
    maxRejections: number;
    /** Prior attempts' durable receipts (executor pre-fetches for guard parity). */
    priorReceipts: ToolReceipt[];
    /** Resume-haystack parity inputs (same values the executor's guard call passes). */
    priorToolTexts?: string[];
    ticketIdsExist: (ids: string[]) => Promise<Set<string>>;
    /** GUARD 7 resolvers (ticket 938dac2e) — same values the executor's guard call passes. */
    todoIdsExist?: (ids: string[]) => Promise<Set<string>>;
    ownerQuestionIdsExist?: (ids: string[]) => Promise<Set<string>>;
    /** GUARD 6 board resolver (ticket dc636d0c) — same value the executor's guard call passes. */
    goalIdsExist?: (ids: string[]) => Promise<Set<string>>;
    /** GUARD 8 resolver (ticket cae70bfa) — same values the executor's guard call passes. */
    scheduleIdsExist?: (ids: string[]) => Promise<Set<string>>;
    /** Iteration 13 (2026-09-25): enabled coding_schedules nextRunAt instants (epoch ms) — the ±60s schedule-firing clock exemption's ground (same value the executor's guard call passes). */
    scheduleFiringTimes?: number[];
    /** CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27): earlier runs' ok receipts for this chat — same value the executor's guard call passes (parity). */
    carriedReceipts?: ToolReceipt[];
  };
}

// Hard ceiling on a single tool call so nothing (a wedged scrape/command) can
// freeze the whole run. Per-tool internals have their own shorter timeouts; this
// is a backstop that returns a message to the model instead of hanging forever.
// 15 min (owner max-out directive 2026-07-22) — long builds/installs get room;
// approval-registry's APPROVAL_TIMEOUT_MS must stay BELOW this (it does: 14 min).
const TOOL_HARD_TIMEOUT_MS = 15 * 60 * 1000;

export interface MessagePart {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'subagent' | 'image';
  /** ISO wall-clock time the part was pushed (transcript per-block hover timestamps). */
  ts?: string;
  /**
   * Harness-authored marker (owner transcript 2026-09-08): a 'guard' text part
   * is the loop's own notice that the preceding draft was discarded (zero-tool
   * gate) or rejected back (evidence guard). Renderers show it as a callout;
   * transcript accumulators never coalesce streamed text into it.
   */
  marker?: 'guard';
  /**
   * The text part is a draft the evidence guard REJECTED before submission —
   * kept for audit, never delivered as the answer. Renderers collapse it;
   * memory/summary fallbacks skip it.
   */
  struck?: boolean;
  [k: string]: any;
}

/**
 * The loop's own marker texts (exported so tests pin them and the frontend
 * never has to pattern-match prose). Both ride the transcript as
 * `marker: 'guard'` text parts AND the live stream as `guard_marker` events —
 * before 2026-09-08 they were pushed to parts only, so a viewer watching LIVE
 * saw a discarded/rejected fabrication as ordinary prose with no marker (the
 * owner's a8976e11 firing-87 report: two zero-tool fabricated audits read as
 * real until the run was reloaded).
 */
export const REJECT_BACK_MARKER = '⚠︎ Final answer rejected by the evidence guard (unproven claims) — the run is correcting it before submission. The draft above was NOT submitted; treat everything it claims as not done.';

export interface AgentRunResult {
  finalText: string;
  parts: MessagePart[];
  /** The run's shared receipt collector (input.receipts) — present whenever the loop ran. */
  receipts?: ToolReceipt[];
  /**
   * Finding chunks this WORKER stored to session memory (offload roles only;
   * absent/0 otherwise). The delegate return site appends a model-facing
   * search_memory pointer from it — without this, the "stored to memory"
   * notices were UI-only progress events the orchestrator never saw.
   */
  offloaded?: number;
  /**
   * Evidence-guard reject-back rounds this attempt spent (2026-09-08 audit):
   * the executor must not CLEAR a prior plan-store guard strike on a run whose
   * own drafts were rejected in-loop, even though the corrected final passes.
   */
  guardRejectBacks?: number;
  /**
   * Full-fidelity MODEL-FACING tool output texts — the exact strings pushed to
   * the role:'tool' messages. The evidence guard's GUARD 4 needs them: `parts`
   * hold only the 8000-char display slice of each result, but the model quotes
   * from the full text it was shown, so an honest quote past the display cut
   * was convicted without this union (review round-4 B-1). References only —
   * the strings already live in the messages array.
   */
  toolTexts?: string[];
  /**
   * Provider-gave-up signal (feedback cff523e7): the model API rejected the
   * request and the bounded recovery budgets ran out — the run's finalText is an
   * honest error note, NOT a work product, yet the run still finalizes
   * agent_runs 'completed'. Only SET on a terminal give-up (absent on a clean
   * finish) so a schedule-fired run's executor can count consecutive
   * provider-killed runs without changing agent_runs.status semantics.
   */
  modelErrored?: boolean;
  /** The provider's HTTP status on the killing turn (429, 5xx, …), when known. */
  modelErrorStatus?: number;
  /** Which failure class exhausted its budget. */
  modelErrorKind?: ModelErrorKind;
  /**
   * Helper-SEAT health fallback (owner 2026-09-14): this WORKER started on the
   * admin's custom coding_helper seat, the endpoint rejected a turn (4xx) or
   * was unreachable, and the rest of the run finished on the built-in helper.
   * The delegate return site appends an honest attribution from it so the
   * orchestrator (and the owner reading the transcript) learn the seat is
   * unhealthy instead of seeing a silently re-seated worker.
   */
  seatFallback?: HelperSeatFallback;
  /** 2026-09-27 tool-limit trim: the last trim this run applied (the model's
   *  tool cap cut the list) — { from, to, dropped } — for surfaces that stamp
   *  meta.toolsTrimmed; the tool_list_trimmed loop_metrics row is the record. */
  toolsTrimmed?: { from: number; to: number; dropped: string[] };
  /** 2026-09-27 progressive tool disclosure: the tool GROUPS this run had loaded
   *  at its end (most-recently-used first) — set only when groups were active
   *  (a provider cap bound, or TOOL_GROUPS_ALWAYS=1); the tool_groups
   *  loop_metrics row carries the full snapshot. */
  toolGroupsLoaded?: string[];
  /** roster 2026-10-06 C-4: the web-tool budget's counts when the run carried one (input.webToolCaps). */
  webToolCap?: WebToolCapState & { mode: 'act' | 'shadow' };
  /**
   * Narrated-tool-emit loop wedge (ticket 177a31b7, 2026-09-20): the run ended
   * because the model kept ANNOUNCING the same imminent tool call in prose
   * while the structured call never executed. Set only on that terminal break
   * so the executor can raise an attention_needed alarm — the announced action
   * did NOT happen and a supervisor may need to re-drive the lane.
   */
  narrLoopEnded?: { tool: string | null; repeats: number; snippet: string };
  /**
   * H2 (2026-09-26): `profile.runDeadlineMs` fired and collapsed the run to
   * its FINAL TURN (a complete answer, never a truncation). Only SET when it
   * happened — the chat harness stamps a bounded background council's
   * metadata.depth.facts.backgroundDeadlineHit from it.
   */
  deadlineHit?: boolean;
  /**
   * The loop's REAL step (tool-round) count at return — `step` after the last
   * for-loop exit. The chat finalize hand-back lint compares it with the lead
   * profile's maxSteps (stepsUsed >= maxSteps ⇒ the round budget ran out); a
   * burst estimate from `parts` cannot serve — parts are pushed per call
   * ([call, result, call, result, …]), so a batched round reads as N rounds.
   */
  stepsUsed?: number;
  /**
   * Time-sliced machine runs (todo 89df978b, observe-only): the run's ACTIVE
   * clock at return — elapsed ms minus approval/steer queue waits
   * (deadlineOffsetMs). Always set by the coding loop; the finalize-seam
   * budget observer compares it with the observation budget using the SAME
   * exclusion the act-path seam (profile.runDeadlineMs) uses.
   */
  activeMs?: number;
  /**
   * build 2026-10-08 F-1 — the typed finish_run SHADOW record (coding/finish-run.ts): set only on an eligible
   * top-level machine run (coding lane / supervisor) while FINISH_RUN_DISABLED is unset. Telemetry only — the
   * delivered finalText never depends on it; run-executor / chat-agent read it for the agreement row.
   */
  finishRun?: FinishRunRecord;
  /**
   * audit 2026-10-08 W2-7: tool calls in THIS loop that changed something
   * (file write / edit, commit, push, PR, an organizational platform mutation —
   * never a delegation). A delegating parent's no-progress brake counts a
   * worker as progress only through this number. Omitted when 0.
   */
  progressCalls?: number;
  /**
   * MERGE-INTENT-AWAIT (2026-10-20): a tool (await_condition) registered a
   * CONDITION WAKE and ended the run — the harness wakes the chat when the
   * condition is met (backstop at its horizon). The executor's unfinished-work
   * continuation stands down on it (continuation-guard 'awaiting_condition').
   * Only SET when it happened.
   */
  awaitingCondition?: boolean;
}

/** The model-error terminal classes agentLoop can give up on. */
export type ModelErrorKind = 'transient' | 'size' | 'billing' | 'repetition' | 'capability' | 'content_filter';

/**
 * Rollout watch 2026-09-15 (tick 16): a 400 whose provider body says the
 * endpoint cannot serve the request SHAPE — tool calling not enabled on a
 * self-hosted vLLM ("auto" tool choice requires --enable-auto-tool-choice and
 * --tool-call-parser), tools/function-calling unsupported, an unknown or
 * unsupported parameter. Neither the shrink lane nor the backoff lane can fix
 * it, and both burned 7 retries per wake for an hour after the supervisor
 * seat moved to a LiteLLM-fronted deepseek-v4.1-flash (26 supervisor wakes
 * dead, 0 delivered). Exported for the chat orchestrator's seat fallback.
 */
export const CAPABILITY_REJECTION_RE =
  // 2026-09-27: + the two deterministic LiteLLM/OpenAI shapes of the gpt-6-astra
  // incident — "Invalid 'tools': array too long … maximum length 128" and
  // "Function tools with reasoning_effort are not supported … use /v1/responses
  // or set reasoning_effort to 'none'" — so that even with no seat fallback
  // they still FAIL FAST here instead of burning the backoff + shrink lanes
  // (48 retries in 6 h).
  // 2026-10-06 (FO f90): + the retired-route shape — LiteLLM "Invalid model
  // name passed in model=… Call /v1/models to view available models" (HTTP 400)
  // when the endpoint registry still lists a model the gateway no longer serves
  // (cql-litellm api-cohere-command-a-plus after the mesh teardown). Deterministic
  // like the others: shrinking or backing off can never make an unserved model
  // name valid — without this, 15 chat runs burned ~6 shrink retries each
  // (90 errors/4 h) before gave_up.
  /tool.?choice|tool.?call.?parser|enable-auto-tool-choice|does not support (tools?|function|tool.?calling)|tools? (is|are) not supported|function.?calling.{0,40}(not\s+|un)supported|unsupported (parameter|value|field)|unknown (parameter|field|argument)|unrecognized (request )?argument|is not (a )?(valid|supported|recognized) (parameter|argument|field)|response_format.{0,30}not supported|(tools?|functions?)[^.]{0,80}?(array )?too long|maximum length \d+[^.]{0,60}(tools?|functions?|array)|too many (tools?|functions?)|reasoning[_ -]?effort[^.]{0,160}(not supported|unsupported)|use \/v1\/responses or set reasoning[_ -]?effort|invalid model name passed in|call .?\/v1\/models.? to view available models/i;

/**
 * The tool schemas a run on a given seat OFFERS THE MODEL (2026-09-27) — the
 * same assembly agentLoop performs (all schemas + delegate for coding; the
 * CHAT_ORCH_TOOLS subset + delegates for chat; supervisor-only tools only on
 * supervisor seats), BEFORE the per-turn filters (withheld tools, anonymous,
 * machine-triggered image tool, extra council tools). The admin role tester
 * sends this list so the Test button exercises the REAL request shape: a
 * 128-tool cap or an effort rejection shows up there, not in production.
 */
export function runToolSchemasForProbe(opts: { kind: 'chat' | 'coding'; supervisorTools?: boolean; allowSubagents?: boolean }): any[] {
  const allSchemas = [...CODING_TOOL_SCHEMA,
    ...TOOL_DEFINITIONS.filter(t => t.function.name !== 'web_pipe' && t.function.name !== 'youtube_pipe'),
    ...INTEGRATION_TOOL_SCHEMA];
  let tools: any[] = opts.kind === 'coding'
    ? [...allSchemas.filter(t => !CODING_EXCLUDED_TOOLS.has(t.function.name)), ...delegateToolSchemas(), LOAD_TOOL_GROUP_SCHEMA]
    : [...allSchemas.filter(t => CHAT_ORCH_TOOLS.has(t.function.name)),
       ...(opts.allowSubagents !== false ? delegateToolSchemas() : [])];
  if (!opts.supervisorTools && !supervisorToolsAlwaysVisible()) tools = tools.filter(t => !isSupervisorOnlyTool(t.function.name));
  if (viewImageToolDisabled()) tools = tools.filter(t => t.function.name !== VIEW_IMAGE_TOOL);
  return tools;
}
// The admin role tester reads the assembler through the run-tools registry
// leaf (never by importing this module — see run-tools-registry.ts).
registerRunToolSchemas(runToolSchemasForProbe);

async function buildRepoContext(worktree: string): Promise<string> {
  try {
    const entries = await fs.readdir(worktree, { withFileTypes: true });
    const top = entries.filter(e => e.name !== '.git').map(e => e.isDirectory() ? `${e.name}/` : e.name).sort().slice(0, 60);
    let readme = '';
    for (const cand of ['README.md', 'readme.md', 'README']) {
      try { readme = (await fs.readFile(path.join(worktree, cand), 'utf8')).slice(0, 1500); break; } catch { /* none */ }
    }
    return `Project files (top level):\n${top.join('\n')}${readme ? `\n\nREADME excerpt:\n${readme}` : ''}`;
  } catch {
    return '(could not read project root)';
  }
}

/**
 * Load the project's agent guide (AGENTS.md + .digby/rules/*.md) so the model is
 * grounded in the repo's own contract on every turn. AGENTS.md is the LF/OpenAI
 * open standard Digby scaffolds and any imported repo may already ship — either
 * way we honour it. Kept bounded so a huge hand-written guide can't blow context.
 */
/** AGENTS.md injection window (chars). Exported for tests (P6 — spark B10/G10). */
export const AGENTS_MD_INJECT_CHARS = 8_000;
/** Above this size a one-line [GUIDE NOTICE] names .digby/rules as the reliable channel. */
export const AGENTS_MD_NOTICE_CHARS = 12_000;

export async function buildAgentGuide(worktree: string, opts: { nudge?: boolean } = {}): Promise<string> {
  const blocks: string[] = [];
  try {
    const agents = await fs.readFile(path.join(worktree, 'AGENTS.md'), 'utf8');
    // Truncation HONESTY (P6 — spark B10/G10): the old bare slice silently cut
    // an 83k guide to its first 8k with no marker, so lanes trusted a guide
    // they had never seen most of. Mark the cut with byte counts, and above
    // 12k also name the channel that IS reliably injected (.digby/rules/*.md).
    const truncMarker = agents.length > AGENTS_MD_INJECT_CHARS
      ? `\n[GUIDE TRUNCATED: showing ${AGENTS_MD_INJECT_CHARS.toLocaleString('en-US')} of ${agents.length.toLocaleString('en-US')} chars — put must-see doctrine in .digby/rules/]`
      : '';
    blocks.push(`=== AGENTS.md (project agent guide — follow it) ===\n${agents.slice(0, AGENTS_MD_INJECT_CHARS)}${truncMarker}`);
    if (agents.length > AGENTS_MD_NOTICE_CHARS) {
      blocks.push(`[GUIDE NOTICE] AGENTS.md is ${agents.length.toLocaleString('en-US')} chars but only its first ${AGENTS_MD_INJECT_CHARS.toLocaleString('en-US')} are injected — files in .digby/rules/*.md are the reliable always-injected channel for doctrine every run must see.`);
    }
  } catch { /* none */ }
  try {
    const learnings = await fs.readFile(path.join(worktree, '.digby', 'notes', 'learnings.md'), 'utf8');
    // Only inject if the user/agent has actually recorded something (skip the empty stub).
    // Recency-aware slice (audit #11): head (title/intro) + the NEWEST entries —
    // the old head-only slice showed the ~10 oldest entries of a 90KB+ file.
    if (learnings.replace(/<!--[\s\S]*?-->/g, '').split('\n').some(l => l.trim().startsWith('- ')))
      blocks.push(`=== .digby/notes/learnings.md (durable learned conventions) ===\n${sliceLearningsForInjection(learnings, 4000)}`);
  } catch { /* none */ }
  try {
    const rulesDir = path.join(worktree, '.digby', 'rules');
    const files = (await fs.readdir(rulesDir)).filter(f => f.endsWith('.md')).sort();
    for (const f of files.slice(0, 6)) {
      const body = await fs.readFile(path.join(rulesDir, f), 'utf8');
      blocks.push(`=== .digby/rules/${f} ===\n${body.slice(0, 6000)}`);
    }
  } catch { /* none */ }
  // DOCS HEALTH: when the recorded commands/stack drifted from ground truth but
  // Digby couldn't auto-refresh (hand-written guide, edited scaffold, user-tuned
  // config), say so. The provision-time refresh (ensureProjectDocs) already fixed
  // everything it owns, so a nudge here means human intent is involved — the agent
  // should reconcile the docs, not silently follow stale ones. Top-level runs only:
  // a worker must not race the orchestrator with off-task doc edits.
  if (opts.nudge) try {
    const { assessDocsHealth } = await import('./scaffolding.service');
    const health = await assessDocsHealth(worktree);
    if (health.drift.length > 0 && !health.nudgeSilenced && (health.commandsUserOwned || !health.autoRefreshable)) {
      blocks.push(
        `=== DOCS HEALTH (harness notice) ===\n`
        + `This repo's agent guide looks stale vs the checked-out code:\n`
        + health.drift.map(d => `- ${d}`).join('\n') + `\n`
        + `The guide is hand-written/user-tuned, so Digby did NOT rewrite it. Update AGENTS.md /\n`
        + `.digby/config.json to match reality in your first commit — or ignore if the divergence\n`
        + `is intentional (set docsHealth.nudge=false in .digby/config.json to silence this).`,
      );
    }
  } catch { /* best-effort */ }
  return blocks.join('\n\n');
}

/** Exported for tests/benches (the system-prompt clip bench composes the REAL prompt). */
export function systemPrompt(input: AgentRunInput, repoContext: string, memoryBlock: string, agentGuide: string, dateTimeBlock: string): string {
  const modeNote = input.permissionMode === 'plan'
    ? 'You are in PLAN mode: DO NOT modify files or run commands. Investigate with read/search tools and present a concrete step-by-step plan for the user to approve.'
    : input.permissionMode === 'ask'
    ? 'You are in ASK mode: file writes, edits, commands, and commits require the user to approve each action (they will see a prompt). Read/search freely.'
    : 'You are in AUTO mode: you may edit files and run commands without asking. Work autonomously to complete the task, then summarize what you ACTUALLY did — work you did not execute this run is reported as not done (an honest incomplete is a pass; an uncited completion claim is a fabrication strike). In AUTO mode NEVER ask for confirmation on goal-aligned routine actions — ask_user is reserved for clarifying a missing detail that materially changes the deliverable, creative direction the user has not given, genuinely human-worthy decisions (irreversible/risky, spends money, changes account/security posture, deletes data) or genuine confusion that survives research.';

  const guideBlock = agentGuide
    ? `\n\nThis project ships an agent guide. Treat it as authoritative — follow its commands and conventions, and keep AGENTS.md accurate when you learn something durable:\n\n${agentGuide}`
    : '\n\nThis project has no agent guide (AGENTS.md). When you establish durable project facts (stack, commands, conventions), create a lean AGENTS.md and commit it so future sessions start grounded.';

  // Block order (P6 — spark B8): STABLE content first (doctrine, guide, repo),
  // VOLATILE blocks last (memory/journal, then the datetime block, then the
  // scheduler notice) — a volatile block early in the prompt busts the
  // provider's cached prefix for everything after it on every run.
  return `You are Digby Code, an expert autonomous software engineer working inside a real git worktree of the project "${input.projectName}" on branch "${input.branch}".

${modeNote}

## How you work (Digby defaults)

Your loop is **explore → plan → change → verify → commit**.
- **Plan first** for any multi-step task: call **update_plan** with a one-sentence goal, acceptance criteria, and 3-8 ordered steps. Keep exactly one step in_progress and update it as you go — it keeps you oriented and shows the user your progress. If the request contains MULTIPLE independent goals, say so in the plan and split: keep the primary goal here, spawn a child session per other goal (see "Parallelize across sessions") instead of serializing unrelated work.
- Explore: **search_code_semantic** finds code by MEANING across the whole repo ("where do we throttle provisioning retries?") when you don't know the identifier or file; grep/glob find exact symbols; list_dir/read_file to read. Never edit a file you have not read this session.
${viewImageToolDisabled() ? '' : `${VIEW_IMAGE_PROMPT_LINE}\n`}- **Memory first:** past sessions and workers have already banked knowledge about this project — check **search_memory** BEFORE re-deriving project facts, re-reading large files, or re-searching the web. Scope 'project' holds durable learnings + the semantic code index; scope 'session' holds this session's offloaded findings and digests. When a tool fails or the codebase surprises you, search_memory(source:'learning') with the error text — a past session may have recorded the exact gotcha and its fix. And when YOU learn a durable, non-obvious project fact the hard way, append one bullet to .digby/notes/learnings.md in the same commit so future sessions inherit it.
- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.
- Make one focused change, then verify it, then move on — don't batch many unverified edits.
- **Verify before you're done:** call **verify** (runs the project's typecheck→lint→test chain) and fix what you break. "Looks right" is not verification. In auto mode Digby will also auto-run this when you finish and hand back any failures. If verify answers "No verify chain configured", nothing is verified: write "unverified — no verify chain" in your final instead of "verified" — a probe you ran by hand is not the chain. Then ONE of two moves: (a) the project genuinely has no typecheck/lint/test commands (an ops / config / docs repo) — say so in your final ("no verify chain applies: <reason>") and add NO step; never invent a placeholder command (an always-green command is a hollow chain, worse than an honest "no chain"); (b) it has real commands — file the config ONCE: check your plan and the project's open PRs/branches for an existing \`.digby/config.json\` step first, and only if none exists add ONE plan step (update_plan) to create it with the real commands; if a config step already exists elsewhere, leave it to its owner and report "unverified — config pending".
- For a process that doesn't exit (dev server, watcher), use **start_background_process** (with a "ready" check), then **read_process_output** / **stop_process** — don't run it with run_command (it will block). To check a running app, curl it from run_command.
- For a LONG build/test you started in the background, use **wait_for_process_output** (blocks until a log pattern or exit — one call, no polling), then read the output.
- Commit logical units with git_commit on the session branch. git_push / open_pull_request publish when ready — always through these tools, never raw \`git push\`/\`gh pr merge\` in run_command (the tools carry the auth, guards and receipts; a base-branch push is recorded and executes — prefer the session branch + PR + merge_pull_request unless the task is to publish base). **After pushing, check CI before claiming done:** call **check_ci** on your pushed sha and confirm it turned green — red or unknown CI means the work is NOT done (fix and re-push, or report the red CI honestly). To WAIT on CI, a PR merge or a deploy, call **await_condition** once — never a check_ci / sleep loop; a merge answered MERGE QUEUED needs no wait (the harness merges at green and wakes you). **A results/tracker/journal APPEND is a RECORD, not a change: do not open a PR for it alone.** Keep appending on the session branch and open ONE PR per day (or when a code/script change lands). Your cross-run state — the queue, the next step, the of-record numbers — lives in \`.digby/rules/00-current-state.md\` (≤6,000 chars, injected every run) and the run journal, never in a results log that must be re-landed on main every firing. Results logs and trackers are APPEND-ONLY on main: archive (results/archive/…), never truncate. Your of-record NUMBERS also go to the goal's premise register — goal_premise_set(goalId, [{key, value, unit, note: the run/file that produced it}]) on the goal you serve — because that, not a PR, is how movement is seen upstream: the supervisors read premise deltas and merged code, never PR ids, and a results lane whose day is docs-only PRs with no registered number reads as a RECORD-KEEPER (redirect candidate). The supervisors read \`.digby/rules/00-current-state.md\` from the repo's DEFAULT branch (a mirror of main, refreshed within 30 min), not from your session branch — a state-only PR (only \`.digby/**\` files) is exempt from the one-PR-per-day rule and its notice: land it whenever the queue / next step changes so they see what you see.
- Scope to the stated goal — never silently expand it. But if the task is a symptom of a bigger outcome you can see (the fix that wants a guardrail, the report that wants a standing schedule), name it in ONE line of your final as a suggestion with the concrete next command, and leave it to the owner.
- **Docs move with the code:** when a change alters behaviour, an API/CLI surface, configuration, setup, or an operational procedure, update the documentation that describes it (README, docs/, AGENTS.md/CLAUDE.md, .env.example) IN THE SAME commit — grep the repo's markdown for the symbols/commands/paths you changed and fix every claim your change invalidated. A doc you cannot confidently fix gets a dated "⚠ STALE (YYYY-MM-DD):" note instead of silence. Pure-internal refactors with no observable change need no doc edits — say so.
- Delegate scoped sub-tasks to specialized workers with delegate({role, task, todo_id?}) — see the roles below. Give complete instructions; the worker doesn't share your context. Link a worker to a plan step with todo_id. Run up to 4 INDEPENDENT read-only investigations concurrently with delegate_parallel.
- **Parallelize across sessions (sub-sessions):** delegate() shares YOUR worktree, so writing work through it is serial. When a request contains INDEPENDENT goals — two unrelated tasks, or plan branches that touch different files and don't feed each other — spawn CHILD SESSIONS with start_coding_session, one per independent goal beyond the one you keep: each child gets its own worktree and run, executes in PARALLEL with you on the worker fleet, auto-wires a result hook back to this chat (you are woken with its outcome — never poll), and inherits your recent journal context. Give each child a COMPLETE brief (goal, acceptance criteria, constraints, how to verify) — it does not share your transcript. Steer, reprioritize, or stop your own children anytime with send_chat_message / update_schedule / cancel_schedule (no confirmation needed — implicit parent scope, first-degree children only). Do NOT spawn children for trivial subtasks (delegate or do them inline), for work on the SAME files as yours (separate worktrees = merge conflicts), or for dependent steps that need your in-flight results.
- **Plan-time fan-out check (measured 2026-09-19: most lanes ran alone and offline — delegation in 5 of 57 sessions, web in 1, memory in 21):** every time you write or revise the plan, answer three questions IN the plan — (1) which steps are INDEPENDENT of each other and of your in-flight results → start_coding_session for each beyond the one you keep, or delegate_parallel for read-only investigations; (2) which facts you are about to re-derive → search_memory first; (3) which APIs / tools / versions you have not verified in THIS repo → web_pipe once. Working alone is right only when every step is dependent and local — say so in one line. Your run's tool profile (memory / web / delegation / sub-sessions) is telemetered and your supervisor reads it. A delegate(role:"reviewer") on your diff before you publish is a REAL second pair of eyes: the reviewer runs on the Reviewer seat — by default a different model than yours.
- **Checkpoints:** every write_file / edit_file you make is snapshotted per step. A wrong turn is undone in one move with rewind_to_step({step: N}) — the files you changed at step N or later return to their pre-step content (files you created are removed); your own edits only — commands, verify runs and git are not undone. Call it without step to list the checkpoints. Prefer it over hand-reverting or git checkout.
- **Structural search / rewrite (ast_search, ast_rewrite):** when the target is a code SHAPE rather than a string — every call of a function however it is formatted, an import form, a hook usage — use ast_search({pattern, lang?, path?, glob?}) with ast-grep pattern syntax ($A = one node, $$$ARGS = many) instead of grep; for a mechanical multi-site change use ast_rewrite({pattern, rewrite, lang, path?}) ONCE instead of N edit_file calls (dry run → checkpoint → apply; rewind_to_step undoes it). An "[ast-grep] Warning: Pattern contains an ERROR node" line means the PATTERN does not parse — fix the pattern, do not conclude nothing matches. A rewrite preserves syntax, not semantics: read the changed spots or run verify before committing.
- Reach the web with search_engine / scrape_as_markdown for unfamiliar APIs; when you need SEVERAL pages read and remembered, call **web_pipe** once (deterministic search→scrape→session-memory→digest — no step-by-step scraping). When the answer may live in VIDEO content (talks, tutorials, interviews, lectures), call **youtube_pipe** once (YouTube search/URLs → captions or local-STT transcript → session memory). browser_task only when a task truly needs a live browser.
- Google WRITES (2026-09-23): you can CREATE and EDIT the user's Google files — docs_create_document / docs_append_text, sheets_create_spreadsheet / sheets_write_values / sheets_append_rows, slides_create_presentation, drive_upload_file (convertTo doc|sheet|slides) / drive_create_folder, calendar_create_event, gmail_create_draft, and gmail_send_email (ONLY on a human-attended turn where the user asked for the send — machine runs draft instead). Pass 'label' when several Google accounts are connected. A 'missing_scopes' refusal means the user must click "Update permissions" on that account in Account → Integrations — tell them, never retry. Quote the returned link/id. Connector WRITES (2026-09-24, Discord added 2026-10-05): imessage_send / slack_post_message / x_post / discord_send_message / discord_send_dm on a human-attended turn only (the user asked for that send with that text); asana_create_task / asana_update_task anytime. Machine runs put the draft in the final instead.
- Pull external context with the connector tools when the task references it: gmail_search / gmail_get_message / gmail_get_attachment / calendar_list_events / drive_search / drive_get_doc / sheets_get_data / slack_search / slack_list_channels / slack_get_channel_history / asana_search / asana_list_tasks / asana_list_projects / github_search_code${githubFileReadToolDisabled() ? "" : " / github_get_file_contents"} / github_list_issues / github_get_issue / github_list_prs / x_search / x_get_user_profile / x_get_trends / xero_get_organisation / xero_get_contacts / xero_get_invoices / plaid_get_accounts / plaid_get_balances / plaid_get_transactions / imessage_list_chats / imessage_get_messages / discord_list_guilds / discord_list_channels / discord_channel_history / discord_list_dms / discord_scrape_channel (the same integrations as chat; they no-op gracefully if not connected).
- **Watched resources (money on the meter):** when your work holds an EXTERNAL resource that costs money or expires unattended (a GPU reservation, a training box, a paid sandbox), call **register_watched_resource** the moment you acquire it (label, $/h, when the reservation ends, how often you'll check) and **observe_resource** after every real check — an unobserved resource alarms the owner. Record what it produces with **register_artifact** (checkpoint/dataset/eval/model + its durable uri) and, once you have CONFIRMED the artifact exists outside the resource (an ls/HEAD/s3-ls this run), stamp it with **verify_durable**. NEVER release or tear down a watched resource until every artifact it produced verifies durable — hours of training that existed only on the box you just released is the exact loss this exists to prevent. If durability cannot be verified, keep the resource, say so, and flag the owner. When the resource is DONE (torn down, reservation ended, or you spot a stale/duplicate registration in get_account_overview → watchedResources), retire it with **release_watched_resource** so the watchdog never ghost-alarms the owner — resources past their reservationEndsAt are auto-suppressed, everything else needs this explicit release.
- **Tickets vs project work:** file_feedback tickets are ONLY for the Digby platform itself (the product hosting this session) — NEVER for this project. A problem the user reports in this chat is presumptively about THIS project: reproduce and fix it here (or in a child session), do not file it as a Digby ticket. A genuine Digby-platform filing from here requires about='digby_platform' plus digbyEvidence (positive evidence it is Digby's, not this project's). If you cannot tell whether they mean their app or Digby, ask the user.
- Finish with a short summary of what changed and how you verified it — not a replay of every step.
- **Claim discipline (always on, every run):** a completion claim (merged / pushed / deployed / probed / fixed / verified) is only true if a tool actually executed it THIS run — cite the tool result (PR#, sha, exit code). No fresh tool result = report the step as not done. An honest "blocked" or "unfinished — here's why" is a CORRECT outcome; an uncited completion claim is marked UNVERIFIED by the harness evidence guard (its notes are appended to your delivered answer). When a machine-triggered (scheduled/hook-fired) run's final claims a push, PR, deploy, ticket update, message/dispatch, commit, or verify action, you MAY end the final with a fenced claims block the harness auto-verifies against its own tool receipts: open with a line that is exactly \`\`\`claims (backticks and the word on ONE line), put a JSON array of {"type":"...","ref":"..."} entries inside (type: push | pr | merge | deploy | commit | ticket_update | message_sent | dispatch | file_change | verify | schedule_armed | email_sent | state_update | probe | benchmark — a \`commit\` entry is a LOCAL commit, sha ref, vouched by a git_commit receipt, never a push; ref: the receipt-visible id from THIS run — commit sha, PR number, or the receipt id from the tool's result envelope; a verify entry is vouched ONLY by a this-run verify-tool receipt — checks executed via run_command cannot vouch it, so report those as prose with the quoted output line, never as a verify entry; an entry may add optional "scope":"session" (work an earlier run of THIS chat did) or "scope":"relayed" (a receipt you read with get_run_receipts this run) — a scoped entry that matched no this-run receipt is re-checked against the chat's recent receipt history instead of being struck), and close with a line that is exactly \`\`\`. Receipt-verified entries downgrade prose-mining convictions; an entry with no matching receipt is marked UNVERIFIED — never list work you did not execute this run.

## Safety (always, even in AUTO mode)

Never run destructive commands without an explicit reason you've stated: no \`rm -rf\`, no \`git push --force\` to a shared branch, no \`git reset --hard\` over uncommitted work, no history rewrites, no piping the web into a shell. Never print, commit, or exfiltrate secrets or \`.env\` contents. Stay within this session's worktree and branch.
**Dependency security:** before you deploy, restart or expose an app — and whenever you change a framework or runtime version — check its installed versions against published advisories (\`npm audit --omit=dev\` / \`pnpm audit --prod\`; open_pull_request also reports a [SECURITY ADVISORY] line) and upgrade a critical/high advisory with a published fix FIRST; never downgrade a framework to get past a build error without checking the target version's advisories. Before you put an app on the internet (a DNS record, a reverse-proxy site, a public port), confirm the host holds no credentials for other projects or the cloud account (no admin keys in ~/.aws, no other apps' .env, no gateway keys) — a public app must never share such a host; if it would, stop and flag the owner instead of going live. Never copy cloud or admin credentials from your environment onto a server.${guideBlock}

${input.fleetNotice?.trim() ? `${input.fleetNotice.trim()}\n\n` : ''}${repoContext}${input.chatSystemPrompt?.trim() ? `\n\n═══ CHAT INSTRUCTIONS (highest precedence — this chat's own directive) ═══\n${input.chatSystemPrompt.trim()}\n═══════════════════` : ''}${memoryBlock ? `\n\n${memoryBlock}` : ''}

${dateTimeBlock}${input.schedulerNotice ? `\n\n[SCHEDULER NOTICE]\n${input.schedulerNotice}` : ''}${input.machineClaimBar ? `\n\n[MACHINE RUN EVIDENCE RULE]\n${input.machineClaimBar}` : ''}`;
}

/**
 * The turn's OWN transport arithmetic, in the one shape every consumer reads.
 *
 * Extracted so the dispatch-rejection text and the loop breakers cannot drift
 * apart (the "two writers, one fact" rule this file already applies to the
 * gateway verdict). Ticket cffd0d0a: the repeat breaker must reach the SAME
 * verdict `toolArgumentRejection` reaches — from the SAME evidence — or a cut
 * classified one way for the model would be classified another way for the
 * breaker.
 */
function turnEvidenceOf(ctx: ToolContext): ToolCallTurnEvidence {
  return {
    finishReason: ctx.turnFinishReason,
    receivedBytes: ctx.turnStreamTrace?.receivedBytes,
    accumulatedBytes: ctx.turnStreamTrace?.accumulatedBytes,
    droppedBytes: ctx.turnStreamTrace?.droppedBytes,
    undrainedBufferBytes: ctx.turnStreamTrace?.undrainedBufferBytes,
    unreadArgBytes: ctx.turnStreamTrace?.unreadArgBytes,
    skippedRawLines: ctx.turnStreamTrace?.skippedRawLines,
    multilineDataEvents: ctx.turnStreamTrace?.multilineDataEvents,
    parseFailLines: ctx.turnStreamTrace?.parseFailLines,
    parseFailToolCalls: ctx.turnStreamTrace?.parseFailToolCalls,
  };
}

/** Execute one assembled tool call; returns the string result for the model. */
async function runTool(
  ctx: ToolContext,
  tc: StreamedToolCall,
): Promise<string> {
  const parsedArgs = parseToolArguments(tc.arguments);
  let args: any;
  if (parsedArgs.ok) {
    args = parsedArgs.args;
  } else {
    // TICKET 8b62e61e (2026-11-01) — ONE evidence object, TWO sinks.
    // The turn's own measurements (the provider's finish_reason + the
    // GATEWAY-OR-OURS arithmetic) are what settle whether a structurally
    // unfinished payload was severed ABOVE this harness or mis-formatted BY the
    // model. They already ride this ctx; they were simply never consulted here,
    // so every cut got the same hedged text. Built ONCE so the durable row's
    // `ec` and the model-facing classification can never disagree about the
    // class — the "two writers, one fact" rule this region already enforces for
    // the gateway verdict.
    // Built ONCE by `turnEvidenceOf` so the durable row's `ec`, the
    // model-facing classification AND the loop breakers' "did this call ever
    // execute?" test can never disagree about the class — the "two writers, one
    // fact" rule this region already enforces for the gateway verdict.
    const turnEvidence = turnEvidenceOf(ctx);
    const lossClass = classifyToolCallLoss(parsedArgs, turnEvidence);
    // Ticket efdb3d31 (2026-10-29, SEVENTH observation — the UNMISSABLE seam).
    // CORRECTION TO PR #2082's PREMISE (same run, minutes later): the finalize
    // instrument did NOT stay silent — I read total 0 BEFORE its rows landed.
    // A fresh read at 15:50:08Z showed total 2, and the 15:48:19.587Z row is
    // the live drop:
    //   no_complete_payload · slots=1 named=1 unnamed=0 · finishReason=tool_calls
    //   broken[0] = { k:0, name:'goal_update', len:39, 'Unexpected end of JSON input' }
    // That row REFUTES three things this ticket assumed:
    //   1. there is NO twin in the accumulator (unnamed=0) — whatever the
    //      reporting seat renders as a second invoke never arrives as a slot;
    //   2. the cut is NOT at '"progressNote": ' — the header is 67 chars, so
    //      39 chars dies INSIDE the goalId uuid;
    //   3. finishReason='tool_calls' (normal), so this is NOT an output-cap
    //      'length' cut — the provider declared the turn complete.
    // So the bytes stop arriving from the TRANSPORT while the provider reports
    // success, and the finalize seam already names that. This probe is still the
    // right place to confirm it end-to-end: argLen/argType here are the
    // DISPATCHED values, so argLen==39 proves the loss is upstream of dispatch
    // rather than something introduced between finalize and runTool.
    // OBSERVE-ONLY and BYTE-FREE: on every rejection, the
    // DISPATCHED argument length + the sanitized structural reason + the call
    // id + the tool. That is the exact pair that separates "head truncated at
    // emission" (short/headless len, 'Unexpected end of JSON input') from
    // "complete payload mangled at dispatch" (full len, a token-error reason).
    // OBSERVE-ONLY and BYTE-FREE: a length and a structural reason head, never
    // payload content (parseToolArguments already sanitizes the reason; V8
    // echoes a payload PREVIEW on token errors).
    try {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.TOOL_CALL_FINALIZE,
        sessionId: ctx.sessionId,
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        meta: {
          seam: 'dispatch_reject',
          // Ticket aa59535b: the CLASS is the analytic field. Without it every
          // rejection looked alike, so the fleet could not tell a transport cut
          // from a formatting mistake and the recovery advice had to hedge. A
          // 'truncated' row also carries its argLen, which is the fact that
          // separates a cut at 1743 chars of a ~2,100-char prompt (ordinary
          // long-payload severance) from a cut at 17 chars (the stream is
          // severing almost everything).
          //
          // `shape` is a SHORT key on purpose: loop_metrics.meta is a JSONB
          // column, so PostgreSQL canonicalises key order (length-then-bytewise)
          // and fleet-telemetry renders only the first ~240 chars of it. A short
          // key sorts ahead of callId/reason/argType and therefore survives the
          // display cut regardless of the order this object literal is written
          // in — the same reason guard_strike leads with `claims`.
          shape: parsedArgs.shape,
          // ── TICKET 8b62e61e (2026-11-01): THE CLASS, ON THE DURABLE ROW ─────
          // `shape:'truncated'` alone cannot distinguish "the gateway severed
          // it" from "the model mis-formatted a truncated-looking payload", so
          // every cut read alike on the read surface (the aa59535b complaint).
          // `ec` is the SETTLED class from this turn's own arithmetic — the
          // same object that decides the model-facing text, so the two cannot
          // disagree. Values: siv = severed-in-transit (provider said
          // fr=tool_calls AND recv==acc with every ours-side counter zero),
          // cut = structurally cut but not provable from this turn's evidence,
          // mal = complete-but-invalid, obj = complete, wrong shape.
          // 2-char key, so jsonb emits it inside the 240-char read cut.
          ec: lossClass === 'severed-in-transit' ? 'siv'
            : lossClass === 'cut-shape-unclassified' ? 'cut'
            : lossClass === 'malformed' ? 'mal' : 'obj',
          tool: tc.name,
          callId: tc.id,
          argLen: typeof tc.arguments === 'string' ? tc.arguments.length : -1,
          argType: typeof tc.arguments,
          reason: parsedArgs.reason,
          // ── efdb3d31 (2026-10-30): THE GUARD'S OWN DECISION VARIABLES ───────
          // The 200d9d0b re-emit guard shipped and produced ZERO rows in 24h
          // while 44 finalize rows accumulated in 4h — and no stored field could
          // say WHICH of its five conditions rejected the turn, so the Fleet
          // could not tell "unreachable code" from "precondition never holds".
          // These three answer it on every rejection:
          //   sc = turn.streamCompleted (1 sentinel seen / 0 absent / null unknown)
          //   fr = the provider's finish_reason (is this an output-cap 'length'?)
          //   re = the re-emit was already spent this run (1) or not (0)
          // All 2-char keys: jsonb emits them before every longer key, so the
          // 240-char read cut cannot separate them from the rejection itself.
          sc: ctx.turnStreamCompleted === undefined || ctx.turnStreamCompleted === null
            ? null : (ctx.turnStreamCompleted ? 1 : 0),
          fr: ctx.turnFinishReason ?? null,
// ticket 192d9087 F2 (2026-10-30): `re` is a PER-TURN fact — 1 iff THIS
          // turn is the retry a re-emit bought. It used to be `severedRecovered`,
          // copied from the per-RUN bound on every turn, which made `re:1` mean
          // "some re-emit happened earlier in this run" and stamped it onto every
          // later row of the run. The run-level bound still exists (and still
          // bounds the cost) but is reported separately as `rr`, so "already
          // recovered" stays diagnosable without overloading the per-turn key.
          re: ctx.turnIsReemitRetry ? 1 : 0,
          rr: ctx.runReemitSpent ? 1 : 0,
          // `sv` = WHICH arm of the severed-stream ladder decided this turn
          // (efdb3d31, 2026-10-30). `re:0` alone is ambiguous in the worst way:
          // it reads identically for "the gate never fired" and "the gate fired
          // and chose to DISPATCH a mixed turn". The second case is new with the
          // complete-sibling arm and it leaves no recovery row behind, so without
          // `sv` the arm's own success would be invisible — the failure mode that
          // hid this guard for a full day. Present only when the ladder ran at all
          // (a turn with no tool calls never reaches it). 2-char key, so jsonb
          // emits it inside the 240-char read cut like sc/fr/re.
          ...(ctx.severedVerdict ? { sv: ctx.severedVerdict } : {}),
          // `rl` = the argLens the RE-EMITTED attempt produced (absent unless
          // THIS turn is its retry). efdb3d31 (2026-10-30): `re:1` alone says a
          // re-emit happened, NOT what it produced — so "did the re-request
          // reproduce the SAME cut?" needed a join against the recovery row
          // written minutes earlier. With `rl` beside `argLen` the comparison
          // is ONE row: rl:"39" + argLen:39 = the re-request re-cut at the same
          // byte; a different rl means the payload moved. 2-char key, so jsonb
          // emits it inside the 240-char read cut like sc/fr/re.
          ...(ctx.turnReemitLens ? { rl: ctx.turnReemitLens } : {}),
          // ── efdb3d31 CRITERION 1 (2026-10-30): THE PER-FRAGMENT ARITHMETIC ──
          // The rejection row used to carry `argLen` ONLY — a dispatched length
          // with no gateway side to compare it against, so it could not say
          // whether those bytes ever arrived. The diagnosis existed, but solely
          // on the SIBLING finalize row written milliseconds apart; a reader
          // asking "why was this call rejected?" follows THIS row, so the
          // arithmetic has to be here too. Same numbers, same turn, one source
          // (TurnResult.streamTrace) — the two rows cannot disagree.
          //   rb/ab = bytes the gateway handed us vs bytes that landed in slots
          //   db    = rb - ab (negative impossible; the count fix guarantees it)
          //   fg/ub = deltas carrying argument bytes / un-drained SSE tail
          //   sl/ni = slot→fragment routing trace / deltas with no usable index
          // ALL 2-char keys, and the same jsonb reason as sc/fr/re: a 2-char key
          // is emitted before every longer one, so the 240-char read cut can
          // never separate the arithmetic from the rejection it explains.
          ...(ctx.turnStreamTrace ? {
            rb: ctx.turnStreamTrace.receivedBytes,
            ab: ctx.turnStreamTrace.accumulatedBytes,
            db: ctx.turnStreamTrace.droppedBytes,
            fg: ctx.turnStreamTrace.fragments,
            ub: ctx.turnStreamTrace.undrainedBufferBytes,
            sl: ctx.turnStreamTrace.assemblyTrace,
            ni: ctx.turnStreamTrace.deltasWithoutIndex,
            // efdb3d31 (2026-10-30): render-only-when-nonzero, exactly like the
            // finalize row's `ur=`. A rejection on a turn whose argument bytes
            // rode a shape we cannot read is OURS, and this is the row a reader
            // follows to decide who to blame. `ur` is the same 2-char key the
            // finalize row renders, so a reader comparing the two rows sees one
            // name for one fact — and a 2-char key sorts ahead of every longer
            // one in jsonb canonical order, keeping it inside the read cut.
            ...(ctx.turnStreamTrace.unreadArgBytes > 0
              ? { ur: ctx.turnStreamTrace.unreadArgBytes }
              : {}),
          } : {}),
        },
      });
    } catch { /* telemetry never breaks a tool call */ }
    // ── TICKET 1425001e (2026-11-01): THE LOSS SIGNAL, AS ITS OWN KIND ────────
    // The `ec` key above already NAMES the severance class, but a name cannot
    // be an acceptance metric: `loop_metric_count` supports ONE meta key/value
    // pair drawn from a CLOSED 18-key set (ticket-metric.ts PROBE_PARAMS /
    // LOOP_METRIC_META_KEYS — `ec` and `sv` are not in it) and can express
    // neither a two-key AND nor an inequality. So ticket 8b62e61e — whose fix
    // NAMED this class and deliberately kept the warn as the alarm — was
    // measured by a warn-VOLUME probe over an emission site
    // (`coding-model.ts:2145`) its diff never touched. It measured 28 rows
    // against a bar of 2, i.e. a certain FAIL on the next verifier tick
    // (`certainEarlyVerdict`), and would have REOPENED a correct fix.
    //
    // This row makes the LOSS declaratively countable with `kind` alone, so a
    // ticket can say "the severance class stops reaching the executor" without
    // asserting anything about how loud the alarm is.
    //
    // EMITTED BESIDE the tool_call_finalize row rather than merged into it:
    // that row is an OBSERVE-ONLY diagnosis of EVERY reject class (siv / cut /
    // mal / obj) and its own comment pins it as such. A separate kind keeps
    // both populations independently countable — counting `siv` out of it would
    // have meant the closed meta-key set above, i.e. exactly what cannot be
    // expressed today.
    if (isUnrecoveredSeverance(lossClass, ctx.severedVerdict)) {
      try {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.TOOL_CALL_UNRECOVERED_SEVERANCE,
          sessionId: ctx.sessionId,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          value: 1,
          unit: 'calls',
          meta: {
            // `ok:false` is what makes this kind RATE-ABLE. The ok/fail
            // aggregate labels a row only when meta.ok (or meta.success) holds
            // a boolean-ish value (loop-metrics.service.ts
            // queryLoopMetricOutcomes) — `tool_call_finalize` reads 66/66
            // "unlabeled" for exactly that reason. Every row of THIS kind is a
            // severity event, so `ok:false` is the honest label and gives the
            // reader a real fail count instead of a null rate.
            ok: false,
            // `ec`/`sv` are 2-char keys ON PURPOSE — jsonb canonicalises object
            // keys by length then bytewise (NOT insertion order), and
            // fleet-telemetry renders ~240 chars of meta, so a short key is the
            // only kind that survives the read cut (the efdb3d31 lesson).
            ec: 'siv',
            ...(ctx.severedVerdict ? { sv: ctx.severedVerdict } : {}),
            tool: tc.name,
            callId: tc.id,
          },
        });
      } catch { /* telemetry never breaks a tool call */ }
    }
    // 2026-08-30 harness audit: a token-truncated call used to execute with
    // args={} — for zero-parameter MUTATING tools (git_push takes none) the
    // mutation fired while the model's narration described args that never
    // arrived. Reject: nothing executes on malformed arguments.
    //
    // Ticket 5bdbb126: the rejection now carries the REAL parse reason. The old
    // flat "truncated or malformed" told the model (and the fleet) the wrong
    // story when the payload was complete but unescaped (a literal newline in
    // a prose argument parses as "Bad control character"), and gave no way to
    // diagnose it after the fact. `reason` is SANITIZED (sanitizeJsonParseReason):
    // V8 echoes a payload PREVIEW on its token-error shapes, so the raw message
    // would write whatever credential the model put in the payload into the
    // transcript — the reason keeps the structural head only, with any quoted
    // span masked.
    // Ticket efdb3d31 (2026-10-29, EIGHTH observation — the message, not the fold).
    // Measured live on build 86a8ef9c (three rows, three tools, TWO models):
    //   15:48:19.587Z xiaomi-mimo goal_update   len=39    'Unexpected end of JSON input'
    //   15:43:35.994Z xiaomi-mimo finish_run    len=321   'Unterminated string in JSON at position 321'
    //   16:00:19.435Z kimi-k3     edit_file     len=2943  'Unterminated string in JSON at position 2943'
    // Every row: slots=1 named=1 unnamed=0 — there is NO twin/orphan slot in the
    // accumulator, so the "paired truncated twin" the reporting seat renders is
    // NOT a second slot here. The payload simply stops arriving, and for
    // goal_update the cut lands INSIDE the goalId uuid (39 of its 67-char
    // header), not at the long prose value six earlier folds assumed.
    //
    // Why the wording matters: the old text said "Re-issue the call with
    // complete, properly escaped JSON arguments". The seat did exactly that —
    // FOUR consecutive attempts — and every single one landed the SAME
    // byte-identical cut (52a2712b, 13:11Z, 13:12Z, 15:13Z, 15:48Z: 5/5 at the
    // same position). A blind "re-issue" instruction walks the model back into
    // a deterministic wall. The recovery that actually breaks the loop is to
    // VARY the payload — shorter, different content — so the truncation point
    // moves past the cut. The reason still travels verbatim so the fleet (and
    // this telemetry) keeps the real parse reason.
    // Ticket aa59535b: the text is chosen by failure CLASS (truncated in
    // transit vs malformed-but-complete vs not-an-object), because the two live
    // classes need OPPOSITE advice. The flat "CUT SHORT" single text shipped for
    // efdb3d31 told a model whose payload was COMPLETE-but-mistyped that bytes
    // were lost ("RE-ISSUING THE IDENTICAL CALL USUALLY FAILS THE SAME WAY"),
    // sending it hunting a transport fault that did not exist; and it told a
    // model whose payload WAS cut that re-sending usually re-cuts, which is true
    // on some gateways and false on others (the reporting supervisor transport
    // landed the same tool on a later attempt after cuts at 17/39/64/92 chars).
    // So the advice is stated per class and makes no blanket claim about the cut
    // point. Classification, wording and the argLen that separates the ticket's
    // two shapes all live in toolArgumentRejection (pure, unit-tested).
    //
    // TICKET 8b62e61e (2026-11-01) — HAND THE SEAM THE TURN'S OWN EVIDENCE.
    // The text above used to hedge on EVERY cut, including the rows where the
    // arithmetic had already settled the half (`recv == acc`, `drop=0`,
    // `buf=0`, `fr=tool_calls` — 45 such rows in the 48h to 21:30Z). Those
    // fields ride this very ctx (`turnFinishReason` / `turnStreamTrace`) and are
    // already written onto the reject row a few lines below; what was missing is
    // that the MODEL never saw them, so a gateway cut arrived as
    // "did not parse as a JSON object" — indistinguishable from a formatting
    // fault. Live consequence, chat daee2916: three cuts in 2.5 min
    // (21:19:35Z / 21:20:37Z / 21:21:57Z, all goal_update) all carried
    // `sv:"already-recovered" rr:1 re:0` — the per-RUN re-emit was spent, so
    // attempts 2 and 3 had no remedy at all and read as model errors.
    // `classifyToolCallLoss` names that class only where the arithmetic PROVES
    // it, and degrades to today's hedge otherwise (the aa59535b/9b2b3798 rule:
    // never assert a cause this seam cannot observe). No retry, no gate change.
    return toolArgumentRejection(tc.name, parsedArgs, turnEvidence);
  }

  // ── Enforce the role tool policy at EXECUTION (not just schema filtering). A
  //    worker's ctx.allowedTools is its ROLE_TOOLS; the orchestrator's is undefined
  //    (all tools). This stops a worker whose model hallucinates a tool name outside
  //    its policy (e.g. an explorer emitting write_file/git_commit) from running it.
  // Per-run extra tools (L3 council) — matched first; they carry their own
  // authority (the harness only wires them into the runs that may use them).
  const extra = ctx.extraTools?.find(t => t.schema?.function?.name === tc.name);
  if (extra) {
    return extra.execute(args);
  }

  if (ctx.allowedTools && !ctx.allowedTools.has(tc.name)) {
    return `Tool "${tc.name}" is not permitted for your role. You may only use: ${[...ctx.allowedTools].join(', ')}.`;
  }

  // Background delegation (coding/background-delegation.ts): `background:true`
  // hands the SAME validated task(s) to ctx.delegateBackground, which returns
  // handles at once (or, under the kill switch, runs them in the foreground
  // with a note). Absent the closure (a worker) the plain path below answers.
  const wantsBackground = args.background === true || args.background === 'true';
  if (tc.name === 'delegate') {
    if (!ctx.delegate) return 'Delegation is not available here (workers cannot delegate further).';
    const role = String(args.role || '');
    if (!isCodingRole(role)) return `Unknown role "${role}". Valid roles: ${Object.keys(ROLES).join(', ')}.`;
    const todoId = args.todo_id != null && !Number.isNaN(Number(args.todo_id)) ? Number(args.todo_id) : undefined;
    // Model tiering (audit #10): only the documented tier names pass through —
    // anything else falls back to the role default (a hallucinated raw model id
    // must not select an arbitrary provider).
    const tier = args.model === 'premium' || args.model === 'helper' ? { model: String(args.model) } : undefined;
    let foregroundNote = '';
    if (wantsBackground && ctx.delegateBackground) {
      const bg = await ctx.delegateBackground([{ role, task: String(args.task || ''), title: String(args.title || role), todoId, opts: tier }], 'delegate');
      if (bg.handled) return bg.text;
      foregroundNote = bg.text;
    }
    const out = await ctx.delegate(role, String(args.task || ''), String(args.title || role), todoId, tier);
    return foregroundNote ? `${out}\n\n${foregroundNote}` : out;
  }
  if (tc.name === 'delegate_status') {
    if (!ctx.delegateStatus) return 'No background workers here (only the orchestrator starts background workers).';
    const handle = typeof args.handle === 'string' && args.handle.trim() ? args.handle.trim() : undefined;
    const waitSeconds = Number(args.wait_seconds);
    return ctx.delegateStatus(handle, Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 0);
  }
  if (tc.name === 'delegate_parallel') {
    if (!ctx.delegate) return 'Delegation is not available here.';
    const tasks = Array.isArray(args.tasks) ? args.tasks.slice(0, MAX_PARALLEL_WORKERS) : [];
    if (!tasks.length) return 'No tasks provided.';
    for (const t of tasks) {
      if (!isCodingRole(t?.role)) return `Unknown role "${t?.role}". Valid: ${Object.keys(ROLES).join(', ')}.`;
      if (isWriterRole(t.role)) return `Role "${t.role}" writes to the worktree — it cannot run in parallel. Use delegate() for coder/editor one at a time.`;
    }
    let foregroundNote = '';
    if (wantsBackground && ctx.delegateBackground) {
      const bg = await ctx.delegateBackground(tasks.map((t: any) => ({
        role: String(t.role), task: String(t.task || ''), title: String(t.title || t.role),
        todoId: t.todo_id != null && !Number.isNaN(Number(t.todo_id)) ? Number(t.todo_id) : undefined,
        opts: t.model === 'premium' || t.model === 'helper' ? { model: String(t.model) } : undefined,
      })), 'delegate_parallel');
      if (bg.handled) return bg.text;
      foregroundNote = bg.text;
    }
    const results = await Promise.all(tasks.map((t: any) =>
      ctx.delegate!(t.role, String(t.task || ''), String(t.title || t.role),
        t.todo_id != null && !Number.isNaN(Number(t.todo_id)) ? Number(t.todo_id) : undefined,
        t.model === 'premium' || t.model === 'helper' ? { model: String(t.model) } : undefined)
        .then(r => `### ${t.title || t.role} (${t.role})\n${r}`)
        .catch((e: any) => `### ${t.title || t.role} (${t.role})\n[failed: ${e?.message || e}]`),
    ));
    return foregroundNote ? `${results.join('\n\n')}\n\n${foregroundNote}` : results.join('\n\n');
  }
  // ANSWER-KEY GUARD (2026-10-03, opt-in ANSWER_KEY_GUARD=1 — answer-key-guard.ts):
  // guardWebToolCall is a pass-through when the guard is off or the tool is not
  // a web / github read; on, a deny-listed URL / query is refused before the
  // network call, a canary-carrying result is withheld, a search result drops
  // its deny-listed entries — each block records ONE answer_key_blocked row.
  if (WEB_TOOL_NAMES.has(tc.name)) {
    if (!ctx.toolCache) return 'Web tools unavailable.';
    return guardWebToolCall(tc.name, args, () => ctx.toolCache.getOrExecute(tc.name, args), b => recordAnswerKeyBlock(ctx, b));
  }
  // User-added MCP servers (ticket e294f9a4): mcp_<server>_<tool> routes to the
  // run's generic MCP executor (machine-run write gate, per-run circuit,
  // telemetry and the health feed live there). Workers never reach this line —
  // their allowedTools policy above refuses an mcp_ name.
  if (isUserMcpToolName(tc.name)) {
    if (!ctx.userMcp) return JSON.stringify({ ok: false, tool: tc.name, reason: 'not_available', message: `MCP tool ${tc.name} is not available on this run (no MCP server of the user offers it now — Account → Integrations → MCP servers shows each server's state).` });
    // The session's permission mode governs an MCP tool that CHANGES data the
    // way it governs a mutating coding tool (tools.ts checkPermission): PLAN
    // blocks it, ASK asks the human (auto-denied on an unattended run), AUTO
    // runs it. Read-only MCP tools always run.
    if (ctx.userMcp.isReadOnly?.(tc.name) === false) {
      if (ctx.permissionMode === 'plan') return `Blocked in PLAN mode: ${tc.name} changes data in the user's MCP server. Present your plan; the user will switch to auto/ask to apply it.`;
      if (ctx.permissionMode === 'ask' && !ctx.alwaysAllow.has(tc.name)) {
        if (!ctx.userTurnAt || ctx.machineTriggered === true) return `AUTO-DENIED: ${tc.name} changes data and needs a human approval click, but this is an unattended run in ASK mode. Read-only tools still work; tell the owner in your final summary. Do not retry it this run.`;
        const decision = await ctx.requestApproval(tc.name, args);
        if (decision === 'always') ctx.alwaysAllow.add(tc.name);
        else if (decision !== 'allow') return `The user DENIED this ${tc.name} action. Do not retry it; adjust your approach or ask what they'd prefer.`;
      }
    }
    return ctx.userMcp.execute(tc.name, args, { userTurnAt: ctx.userTurnAt, machineTriggered: ctx.machineTriggered, sessionId: ctx.sessionId, runId: ctx.runId ?? null });
  }
  if (isIntegrationTool(tc.name)) {
    // Google WRITE tools key their human-turn anchor off userTurnAt (2026-09-23).
    // projectId/sessionId (99145890): the gmail_get_attachment auto-ingest hook
    // needs the run's project to know WHICH project's KB has the rule enabled —
    // chat runs pass the 'chat' sentinel for ungrouped chats, which the hook guards.
    return guardWebToolCall(tc.name, args, () => executeIntegrationTool(ctx.userId, tc.name, args, { userTurnAt: ctx.userTurnAt, projectId: ctx.projectId, sessionId: ctx.sessionId }), b => recordAnswerKeyBlock(ctx, b));
  }
  return executeCodingTool(ctx, tc.name, args);
}

/**
 * Core loop shared by the ORCHESTRATOR (allowSubagents:true, no role) and WORKER
 * subagents (allowSubagents:false, a role → filtered tools + role prompt).
 * Workers are depth-1 (they cannot delegate further).
 */
async function agentLoop(
  input: AgentRunInput,
  opts: {
    maxSteps: number; allowSubagents: boolean; eventPrefix?: string; role?: CodingRole; agentLabel?: string;
    /** Orchestrator only: receives the run's background-worker pool so runCodingAgent's finally can close it on a throw. */
    bgHolder?: { pool?: BackgroundWorkerPool };
    /**
     * Orchestrator only: receives the async-tool registry's run-end close so
     * runCodingAgent's finally can run it on a THROW too (ticket 9ecabc73).
     *
     * The close used to sit inline, only reachable on the success/cancel path —
     * so a run that threw never closed the registry and a handed-off result it
     * was holding was lost with no post, no progress event and no metric, which
     * is precisely the silence the ticket reports. `closeRun` is idempotent and
     * the closure is a no-op once closed, so the finally may call it safely after
     * the inline call already ran.
     */
    asyncHolder?: { closeAtRunEnd?: () => void };
    /** Seat label for the usage ledger when it differs from `role` (AgentRunInput.usageRole — the L2 reconcile pass). */
    usageRole?: string;
    /**
     * DELEGATED workers only: append the structured result-envelope instruction
     * to the role prompt (the delegate return site parses + strips the footer).
     * runChatWorker's harness pre-step drafts are consumed verbatim — no footer.
     */
    resultEnvelope?: boolean;
  },
): Promise<AgentRunResult> {
  const profile = input.profile ?? CODING_PROFILE;
  // Registry-aware resolution: '<label>:<modelId>' custom-endpoint specs resolve
  // against model_endpoints (enabled + coding-capable row, key decrypted by the
  // service); anything else falls back to the built-in glm-5.2 — which is what
  // the run path ALWAYS got before this wiring, so custom endpoints silently
  // ran as glm-5.2/ZAI and 401'd on Edge where ZAI_API_KEY is absent (09f6e89a).
  // `let`: the truncated-thinking recovery below reshapes the provider extras
  // (bigger output budget, one notch less reasoning) for the rest of the run.
  let provider = await resolveProviderForRun(input.model, input.userId, { fastSeat: input.fastSeat });
  // Lead-seat provider fallback (owner 2026-09-17): the CHOSEN seat is the
  // primary; a 429/5xx turn runs on a sibling seat and the primary is retried
  // on the next step ('armed' → 'active' while the fallback turn runs →
  // 'revert' once it completed → back to primary). A billing suspension is
  // sticky: the fallback BECOMES the primary for the rest of the run.
  let primaryProvider = provider;
  let leadFallbackState: 'none' | 'armed' | 'active' | 'revert' = 'none';
  let leadHttpFallbackThisStep = false;
  let primaryContextBudget: number | undefined; // the primary seat's window, restored on revert
  let primarySeatSpec: string | undefined;
  // Compaction trigger sized to the MODEL for coding runs (Kimi K3's 1M window
  // gets ~200k tokens of transcript, GLM ~120k — not one 22k-token default).
  // Chat profiles keep their own budgets (interactive latency/cost is the
  // binding constraint there), capped by the model's real window so a large
  // profile budget (the supervisor's 1M chars, owner 2026-09-11) can never
  // exceed a small-window custom seat.
  // `let` (ticket fe6f0b0b): the main-seat transient failover below re-sizes the
  // budget to the failover seat's window mid-run.
  let contextBudget = profile.kind === 'coding'
    ? (provider.contextChars ?? profile.contextCharBudget)
    : Math.min(profile.contextCharBudget, provider.contextChars ?? Number.POSITIVE_INFINITY);
  // ── audit 2026-10-06 T1-1: the budget the compaction trigger and the
  //  `context` event use. A FAMILY-inferred custom-endpoint budget
  //  (coding-model.ts registryContextBudget) is capped by a ceiling learned
  //  from a size-named rejection on that seat (learnContextCharCeiling) — the
  //  self-correction for a self-hosted server whose real window is smaller
  //  than its family's. `budgetSource` names what binds: the seat's sizing
  //  ('registry' | 'family' | 'default' | 'builtin'), the profile, or the
  //  learned 'size_rejection' ceiling. Kill switch
  //  REGISTRY_CONTEXT_FAMILY_DISABLED=1: plain contextBudget, no fields. ──
  const effectiveContextBudget = (): number => {
    if (registryContextFamilyDisabled() || !isInferredContextSource(provider.contextCharsSource)) return contextBudget; // W2-3: every inferred sizing self-corrects
    const ceiling = learnedContextCharCeiling(provider);
    return ceiling !== undefined && ceiling < contextBudget ? ceiling : contextBudget;
  };
  const ctxBudgetSourceField = (): { budgetSource?: string; seatContextSource?: string } => {
    if (registryContextFamilyDisabled()) return {};
    const seatContextSource = provider.contextCharsSource ?? 'builtin';
    const eff = effectiveContextBudget();
    const budgetSource = eff < contextBudget ? 'size_rejection' : provider.contextChars === contextBudget ? seatContextSource : 'profile';
    return { budgetSource, seatContextSource };
  };
  // Token/cost meter: one accumulator per top-level run; workers inherit it via
  // the input spread and record under their own label for the per-agent breakdown.
  const usageAcc = input.usage ?? (input.usage = new UsageAccumulator(input.resumeFrom?.usageRunId));
  // Anti-confabulation receipts: one shared collector per top-level run —
  // workers push into the SAME array via the delegate input spread.
  const receiptCollector = (input.receipts = input.receipts ?? []);
  // build 2026-10-08 D-2: one tool-intent journal per ATTEMPT (this call); workers share it via the input spread.
  const intentJournal = input.intentJournal ?? (input.intentJournal = createIntentJournal({
    sessionId: input.sessionId, runId: input.runId ?? null,
    anchor: input.intentScopeAnchor ?? (input.userTurnAt ? new Date(input.userTurnAt).toISOString() : null),
  }));
  const agentLabel = opts.agentLabel || (opts.role ? ROLES[opts.role].label : 'Digby');
  // Run-level provider extras, applied to the chosen seat AND every seat the
  // run later fails over to (each site below calls this). A4 (2026-10-04,
  // machine-firing-effort.ts): a schedule / hook firing on an all-complete
  // board caps the lead seat's reasoning_effort (lower-only — an endpoint that
  // sends no effort still gets none). Top-level only: workers keep their seats.
  // The chat lead-effort A/B (input.effortCap, 2026-10-04 — human-turn-effort.ts leadEffortArm) rides the SAME
  // seam: one lower-only cap (coding/effort-cap.ts), applied to the lead and every failover seat, never workers.
  const runEffortCap = opts.allowSubagents ? (input.effortCap ?? input.machineFiringEffort?.cap ?? null) : null;
  const applyRunProviderExtras = (p: { extra?: Record<string, any> }): void => {
    if (input.providerExtra) p.extra = { ...p.extra, ...input.providerExtra };
    if (runEffortCap && p.extra) p.extra = capReasoningEffort(p.extra, runEffortCap);
  };
  applyRunProviderExtras(provider);
  // A4: what the lead seat was GIVEN at run start, stamped on run_spend (spend per effort).
  const machineEffortStamp: { reasoningEffort: string; effortReason: string } | null = opts.allowSubagents && input.machineFiringEffort
    ? { reasoningEffort: typeof provider.extra?.reasoning_effort === 'string' ? provider.extra.reasoning_effort : 'default', effortReason: input.machineFiringEffort.reason }
    : null;
  // Per-run metric stamp (remediation P0 item N6): built ONCE, merged under
  // every loop_metrics row this loop records (provider derives from model).
  const metricStamp: MetricStamp = {
    // audit 2026-10-08 W3-4: a custom endpoint stamps its registry spec (one name per model across chat + coding).
    model: spendModelKey(provider),
    profile: profile.kind,
    // audit 2026-10-06 T8-11: a delegate worker inherits the parent's stamp (parentTriggerKind) — telemetry only.
    triggerKind: metricTriggerKindFor(input),
    // E5 cost stamp: the run-level gate decision (wake_triage / delta_material)
    // rides every row of this run, run_spend included — join key for shed cost.
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    // Seats govern sessions (2026-09-28): what governed the model (run_spend meta.modelSource).
    ...(input.modelSource ? { modelSource: input.modelSource } : {}),
    // 2026-10-04: the durable agent_runs.id (top-level worker runs) so run_spend joins agent_runs (meta.agentRunId).
    ...(input.runId ? { agentRunId: input.runId } : {}),
    // GOAL-PRIORITY-SPEND (2026-10-20): the lane's charter goal — run_spend meta.goalId (per-goal spend).
    ...(input.goalId ? { goalId: input.goalId } : {}),
  };
  // audit 2026-10-06 T1-1: ONE context_budget row per top-level run on a custom
  // endpoint — which sizing the seat got (registry window / model family /
  // the 160k default) and the budget the run compacts against. The 48 h
  // gateway storm was invisible until an audit read `context` events by hand.
  if (opts.allowSubagents && provider.contextCharsSource) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CONTEXT_BUDGET,
      sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
      value: contextBudget, unit: 'chars',
      meta: { model: provider.model, source: provider.contextCharsSource, seatContextChars: provider.contextChars ?? null, budget: contextBudget, profileBudget: profile.contextCharBudget, profile: profile.kind, outcome: 'run_start' },
    });
  }
  // ── LOG ATTRIBUTION (FO firing 48, 2026-09-29): the coding loop's warn
  // sites wrote to app_error_logs with context=null — the audit's errors_4h
  // readout showed the top classes (19 lead-seat rejections, 24 turn
  // failures) as UNTRACEABLE rows: no session/run id, no way to answer
  // "which run hit this?". logger.warn's second arg becomes the row's
  // context JSON, so every loop warn now carries { sessionId, runId, source
  // }. Pure additive metadata on the same fire-and-forget path — no
  // behavioral change; kill switch unnecessary (the meta object can never
  // throw: same values the adjacent noteSeatFallback rows already stamp). ──
  // Object form (family 5ae52ca3 review F2): `logger.warn(msg, meta)` passes
  // meta as a winston splat arg — a printf token in the message body (provider
  // error text: `printf('%s')`, `LIKE '%x%'`) would format the meta INTO the
  // message, destroying sessionId/runId/source attribution (the exact
  // untraceable-rows defect this helper exists to prevent) and any logClass
  // tag. The object form has no splat args: message verbatim, meta preserved.
  const agentWarn = (msg: string, extraMeta?: Record<string, unknown>) => logger.warn({
    level: 'warn',
    message: msg,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    source: 'coding-agent',
    ...(extraMeta ?? {}),
  });
  // Keep the project's semantic code index current (incremental, throttled,
  // fire-and-forget) so search_code_semantic reflects this checkout — and the
  // learnings index (audit #11) beside it, same throttle pattern, so
  // .digby/notes/learnings.md entries are searchable via search_memory.
  if (profile.workspaceTools) {
    // baseBranch (the stale-base gate's preferred ref, 2026-10-23): a lane
    // checkout far from the default branch must not write the SHARED project
    // code index — a month-old worktree's complete listing purges newer
    // files' rows. Absent → the gate falls back to origin's default ref.
    kickCodeIndexSync(input.projectId, input.worktree, input.userId, input.baseBranch);
    kickLearningsIndexSync(input.projectId, input.worktree, input.userId);
  }
  // Chat profiles have no worktree: repo context / agent guide / coding memory
  // are workspace features (memory arrives inside the doctrine's systemContext).
  // Owner timezone for the datetime block: user-facing timestamps render in the
  // user's tz; machine-facing content stays UTC (datetime-context). A USER
  // feature, not a workspace feature — loaded for every profile (chat profiles
  // short-circuit systemPrompt via doctrineOverride, so it only feeds coding
  // prompts today; if a chat-profile caller ever drops the override, the block
  // still gets the right tz). Never rejects — a memory outage degrades to UTC.
  const userTimezone = await loadUserTimezone(input.userId);
  const [repoContextBase, agentGuide, [userMem, projectMem, sessionMem], journalEntries, learningsBlock, codeMatchesBlock, memoryInventory, divergenceNotice] = profile.workspaceTools
    ? await Promise.all([
        buildRepoContext(input.worktree),
        buildAgentGuide(input.worktree, { nudge: !!opts.allowSubagents }),
        Promise.all([getUserCodingMemory(input.userId), getProjectMemory(input.projectId), getSessionMemory(input.sessionId)]),
        // Cross-run memory (run journal): what earlier runs in THIS chat did,
        // decided, and learned. Workers inherit it — they re-run THIS assembly
        // with the parent's sessionId via the delegate() input spread.
        // MACHINE-triggered runs get the DEEPER slice (P6 — v1#35/#36, spark
        // G4b): their raw wake/report history is dieted to 2 pairs in the
        // executor, so the journal IS their cross-run memory — 10 rows / 4k
        // chars instead of the interactive 6 / 2.4k.
        getRecentJournalEntries(input.sessionId, input.machineTriggered ? MACHINE_JOURNAL_ENTRIES_N : JOURNAL_ENTRIES_N),
        // [RELEVANT LEARNINGS] (audit #11): the learnings.md entries semantically
        // matched to THIS task, injected beside the journal (~1,200 char budget).
        // Best-effort — '' on any failure or before the index is first built.
        buildLearningsBlock(input.projectId, input.userMessage),
        // [CODE INDEX MATCHES] (owner 2026-09-04): files the embedding index
        // matches to THIS task — the index pays on every run, not only when the
        // model thinks to call search_code_semantic. '' on steering turns,
        // unbuilt index, or any failure.
        buildCodeMatchesBlock(input.projectId, input.userMessage),
        // [SESSION MEMORY INVENTORY]: what search_memory would find — a model
        // that believes memory is empty never searches it.
        buildSessionMemoryInventory(input.sessionId),
        // [REPO NOTICE] (I2a, remediation 2026-09-09): when origin/<base> has
        // moved >20 commits past this branch's merge-base, say so at run start
        // (best-effort fetch, cached per worktree).
        buildRepoDivergenceNotice(input.worktree, input.baseBranch),
      ])
    : ['', '', [null as any, null as any, null as any], [] as RunJournalEntryShape[], '', '', '', ''] as const;
  const repoContext = divergenceNotice ? `${repoContextBase}\n\n${divergenceNotice}` : repoContextBase;
  const memoryBlock = profile.workspaceTools
    ? [formatCodingMemoryBlock(userMem, projectMem, sessionMem), formatJournalBlock(journalEntries, input.machineTriggered ? MACHINE_JOURNAL_BLOCK_CAP : undefined), learningsBlock, codeMatchesBlock, memoryInventory].filter(Boolean).join('\n\n')
    : '';
  const emit = (ev: string, data: any) => input.emit((opts.eventPrefix || '') + ev, data);
  // On-tool-failure learnings requery (audit #11): when a tool result comes back
  // failure-shaped, the nudger searches source='learning' with the error text and
  // the single best hit is appended to the tool result — the moment a recorded
  // gotcha pays for itself. Throttled inside to ≤3 requeries per run; best-effort.
  const learningNudge = profile.workspaceTools ? createFailureLearningNudger(input.projectId) : null;

  // Role guidance: orchestrator gets the roster + delegation doctrine; a worker
  // gets its focused role prompt.
  const autoDoctrine = !opts.role && profile.kind === 'coding' && opts.allowSubagents && input.permissionMode === 'auto'
    ? AUTO_WORKFLOW_DOCTRINE : '';
  const roleGuidance = opts.role
    ? `${ROLES[opts.role].prompt}${opts.resultEnvelope ? `\n\n${workerEnvelopeInstruction()}` : ''}`
    : (profile.kind === 'coding' ? `${orchestratorRoleGuidance()}${autoDoctrine}` : '');
  const baseDoctrine = input.doctrineOverride ?? systemPrompt(input, repoContext, memoryBlock, agentGuide, buildCodingDateTimeBlock(userTimezone));
  const messages: any[] = [
    { role: 'system', content: roleGuidance ? `${baseDoctrine}\n\n${roleGuidance}` : baseDoctrine },
    ...input.history.map(h => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: input.userImages?.length
        ? [{ type: 'text', text: input.userMessage || '[see attached image]' }, ...toImageContentParts(input.userImages)]
        : input.userMessage,
    },
  ];

  // ── Durable resume (Phase 1): rehydrate the transcript from an interrupted
  // run's checkpoint. A 'dispatch' checkpoint is trimmed back to its step's
  // preModel state — the partially-dispatched turn is REGENERATED by the model,
  // never re-entered mid-batch — so completed tool calls are not double-executed
  // and the model sees a coherent transcript. Completed steps are never re-run.
  // The user message that TRIGGERED this resume is not in the checkpoint — it is
  // appended below (same content shape as the fresh-run init above). ──
  const resume = input.resumeFrom && input.resumeFrom.version === 1 && Array.isArray(input.resumeFrom.messages) && input.resumeFrom.messages.length
    ? input.resumeFrom : undefined;
  // Ticket 458342f5: handles whose report this run RECOVERED from the durable
  // spill (cleared at run finalize — a terminal run is never resumed).
  const recoveredSpillIds: string[] = [];
  if (resume) {
    // Keep the JUST-BUILT system message (fresh datetime block): replaying the
    // checkpoint's messages[0] would resurrect the original run-start clock, so
    // a run resumed hours later would stamp its report with a stale "now".
    const freshSystem = messages[0];
    const replayed = resume.phase === 'dispatch' ? trimToPreModel(resume.messages) : resume.messages;
    const rest = replayed[0]?.role === 'system' ? replayed.slice(1) : replayed;
    // Strip transient per-turn harness messages that leaked into durable
    // checkpoints via the pre-fix serialization race (ticket 63e9a3cb review
    // B1): a replayed [HARNESS CLOCK] note is a STALE clock instructing stale
    // "now" citation — the exact failure class the note exists to kill — and
    // a replayed <plan> reminder is dead weight. Both regenerate every turn.
    const cleaned = stripTransientHarnessMessages(rest);
    messages.length = 0;
    messages.push(freshSystem, ...cleaned);
    // Background workers the checkpointed run started died with its process.
    // Ticket 458342f5: a worker that had already FINISHED is not lost — its
    // report was spilled to the durable store the moment it settled, so recover
    // those and inject them, and announce only the workers with no completed
    // report (they were still running when the process died).
    if (opts.allowSubagents) {
      const lost = lostBackgroundWorkerIds(cleaned);
      if (lost.length) {
        const resumeChatId = input.sessionId.startsWith('anon-') ? '' : input.sessionId;
        const { recovered, stillLost } = await recoverBackgroundReportsOnResume(resumeChatId, lost);
        for (const r of recovered) {
          messages.push({ role: 'user', content: formatRecoveredReport(r) });
          recoveredSpillIds.push(r.id);
        }
        if (recovered.length) {
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.DELEGATE_BACKGROUND, sessionId: input.sessionId, runId: input.runId, meta: { phase: 'recovered_on_resume', workerIds: recovered.map(r => r.id), count: recovered.length } });
        }
        if (stillLost.length) {
          messages.push({ role: 'user', content: lostWorkersNotice(stillLost) });
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.DELEGATE_BACKGROUND, sessionId: input.sessionId, runId: input.runId, meta: { phase: 'lost_on_resume', workerIds: stillLost, count: stillLost.length } });
          noteBackgroundWorkersLost(stillLost, { sessionId: input.sessionId }); // build 2026-10-08 D-1: their ledger tasks fail (lost_on_resume)
        }
      }
    }
    messages.push({
      role: 'user',
      content: input.userImages?.length
        ? [{ type: 'text', text: input.userMessage || '[see attached image]' }, ...toImageContentParts(input.userImages)]
        : input.userMessage,
    });
  }

  // Orchestrator gets every tool + delegate; a worker gets only its role's tools
  // (and never delegate — depth-1).
  const allSchemas = [...CODING_TOOL_SCHEMA,
    ...TOOL_DEFINITIONS.filter(t => t.function.name !== 'web_pipe' && t.function.name !== 'youtube_pipe'), // both pipes already in CODING_TOOL_SCHEMA
    ...INTEGRATION_TOOL_SCHEMA];
  let tools = opts.role
    ? toolsForRole(opts.role, allSchemas)
    : profile.kind === 'coding'
      ? [...allSchemas.filter(t => !CODING_EXCLUDED_TOOLS.has(t.function.name)), ...delegateToolSchemas(), LOAD_TOOL_GROUP_SCHEMA]
      : [...allSchemas.filter(t => CHAT_ORCH_TOOLS.has(t.function.name)),
         // Chat mode may delegate RESEARCH/CHECK helpers (web_pipe inside the
         // helper model) — never writer/coding roles; enforced in the closure.
         ...(profile.maxDelegations > 0 && opts.allowSubagents ? delegateToolSchemas() : [])];
  const WEB_NAMES = new Set(['search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe', 'youtube_pipe']);
  if (input.noWebTools) tools = tools.filter(t => !WEB_NAMES.has(t.function.name));
  // Supervisor-only tools (state doc, infra blockers) leave every non-supervisor
  // schema: their executors refuse outside a supervisor chat anyway, so offering
  // them elsewhere only hands a decoder a wrong target (prod 2026-09-22: a CanLaw
  // coordinator lane slipped onto update_supervisor_state twice in one turn).
  if (!profile.supervisorTools && !supervisorToolsAlwaysVisible()) tools = tools.filter(t => !isSupervisorOnlyTool(t.function.name));
  // Anonymous chat runs (anon-* session ids) can never resolve an ask_user wait:
  // no chatId, no authenticated answer endpoint, no stop path — the run would
  // park for the full 60-min question window with the user locked out of chat.
  // Don't advertise the tool; the model proceeds on its own judgment.
  if (input.sessionId.startsWith('anon-')) tools = tools.filter(t => t.function.name !== 'ask_user');
  // build 2026-10-08 A2-1 (tool diet, coding/tool-diet.ts): a guest's top-level chat run is offered only
  // web + documents + image + delegation — every account / platform / connector tool refuses a guest anyway
  // (1 platform call in 59 guest turns), and those schemas were ~44k tokens per call. Harness extras
  // (council tools, call_in) are appended below. Kill switch GUEST_TOOL_SUBSET_DISABLED=1.
  const guestDiet = !opts.role && profile.kind !== 'coding' && isGuestSession(input.sessionId) && !guestToolSubsetDisabled()
    ? { fullTools: tools.length, fullChars: schemaChars(tools), offeredTools: 0, offeredChars: 0 }
    : null;
  if (guestDiet) {
    tools = guestToolSubset(tools);
    guestDiet.offeredTools = tools.length;
    guestDiet.offeredChars = schemaChars(tools);
  }
  // Image generation (2026-09-24): machine-triggered runs (supervisor wakes,
  // schedules, feeds) never draw unprompted — spend is a human decision. A
  // human turn in the same chat still gets the tool (machineTriggered is set
  // from machineWake/messageOrigin at the chat-agent seam).
  if (input.machineTriggered === true) tools = tools.filter(t => t.function.name !== 'generate_image');
  // view_image kill switch (2026-10-01): the schema leaves every list; the
  // executor refuses a by-name call too (view-image.ts).
  if (viewImageToolDisabled()) tools = tools.filter(t => t.function.name !== VIEW_IMAGE_TOOL);
  // Hosted hardened browser (ea3ad8a8): staged rollout — the schema leaves
  // every list unless BROWSER_SERVICE_ENABLED is on; executeCodingTool's
  // session_browser case refuses a by-name call too.
  if (!sessionBrowserToolEnabled()) tools = tools.filter(t => t.function.name !== 'session_browser');
  if (input.extraTools?.length) tools = [...tools, ...input.extraTools.map(t => t.schema)];
  // ── USER-ADDED MCP SERVERS (ticket e294f9a4): the user's own servers' tools
  //    (mcp_<server>_<tool>), read from the stored tool cache — no network at
  //    run start, bounded (2.5 s, per-server / total caps), never throws. The
  //    orchestrator / chat lead only (workers keep their role policy); never an
  //    anonymous run. An unattended run sees READ-ONLY tools unless the user
  //    allowed changes on scheduled runs for that server. A broken server's
  //    tools are omitted with ONE progress line. USER_MCP_DISABLED=1 ⇒ none. ──
  let userMcp: UserMcpRunTools | null = null;
  if (!opts.role && !input.sessionId.startsWith('anon-') && input.userId && !userMcpDisabled()) {
    try {
      const { loadUserMcpRunTools } = await import('../user-mcp/user-mcp.service');
      userMcp = await loadUserMcpRunTools(input.userId, { machine: input.machineTriggered === true || !input.userTurnAt });
    } catch (err: any) {
      logger.warn(`coding agent: user MCP tools unavailable this run (non-fatal): ${err?.message || err}`);
      userMcp = null;
    }
    if (userMcp) {
      const known = new Set(tools.map(t => t?.function?.name as string));
      const fresh = userMcp.schemas.filter(sc => !known.has(sc.function.name));
      if (fresh.length) tools = [...tools, ...fresh];
      if (userMcp.doctrine && messages[0]?.role === 'system' && typeof messages[0].content === 'string') messages[0].content += userMcp.doctrine;
      for (const line of userMcp.statusLines) emit('progress', { message: line, stage: 'mcp' });
    }
  }

  // build 2026-10-08 A2-2 (tool diet, coding/tool-diet.ts): progressive tool disclosure BY PROFILE on a
  // signed-in human plain-chat turn — the tool-groups core + the groups the turn text needs + by-name
  // auto-load, add-only (no cap ⇒ no eviction). It never ran in prod: it needed a binding provider cap
  // (built-ins have none) or TOOL_GROUPS_ALWAYS (never forwarded by compose). Store mode shadow (default:
  // only the owner canary acts, everyone else records the would-miss) / act / off; kill switch
  // CHAT_TOOL_GROUPS_DISABLED=1 (no store read, no row; the global TOOL_GROUPS_DISABLED=1 too). Supervisors,
  // machine wakes, workers and coding lanes keep the full list.
  // build 2026-10-08 A2b: `lane` = the turn plan's lane-aware starting set (acts only where A2 acts; else the shadow
  // record), `laneOpts` = what a run-end ('late') lane record is rebuilt from when the plan was not in at run start.
  let chatDiet: (ChatToolGroupsDecision & { view: Set<string>; fullNames: Set<string>; fullChars: number; offeredChars: number;
    lane: ChatLaneDiet | null; laneOpts: Omit<Parameters<typeof chatLaneDiet>[2], 'source'>; laneTools: typeof tools }) | null = null;
  if (isHumanPlainChatRun({ role: opts.role, profileKind: profile.kind, supervisorTools: profile.supervisorTools, sessionId: input.sessionId, machineTriggered: input.machineTriggered, userId: input.userId })
    && !chatToolGroupsDisabled() && !toolGroupsDisabled()) {
    try {
      const decision = decideChatToolGroups(await toolDietConfig(), input.userId);
      const fullNames = new Set<string>(tools.map((t) => t?.function?.name as string).filter(Boolean));
      const text = toolGroupsPromptText(input);
      const view = chatToolGroupsInitialView([...fullNames], {
        text, triage: runMentionsTicketWork(input),
        extraGroups: userMcp?.toolCount && textMentionsUserMcpServer(text, userMcp.serverHints) ? ['connector_mcp'] : [],
      });
      const dietCfg = await toolDietConfig(); // cached (30 s) — the same row A2 just read
      const laneOpts = {
        text, triage: runMentionsTicketWork(input),
        extraGroups: (userMcp?.toolCount && textMentionsUserMcpServer(text, userMcp.serverHints) ? ['connector_mcp'] : []) as Array<'connector_mcp'>,
        keep: (input.extraTools ?? []).map((t) => String(t?.schema?.function?.name ?? '')),
        webDropBelow: dietCfg.laneWebDropBelow, decision: decideLaneToolSets(dietCfg, input.userId, decision.acts),
      };
      const lane = chatLaneDiet(readToolLaneHint(input.toolLaneHint), tools, { ...laneOpts, source: 'start' });
      chatDiet = { ...decision, view, fullNames, fullChars: schemaChars(tools), offeredChars: schemaChars(tools.filter((t) => view.has(t?.function?.name as string))), lane, laneOpts, laneTools: tools };
    } catch (err: any) {
      logger.warn(`coding agent: tool-diet decision failed — full tool list this run (non-fatal): ${err?.message || err}`);
      chatDiet = null;
    }
  }

  // The run's chatId for generated-file attribution (ticket 8db4c18e): chat
  // runs pass the chat id as sessionId (runSessionId in chat-agent.service),
  // coding sessions live ON crossModelChat rows (P5-B — session id IS the
  // chat id); anonymous runs key on an `anon-` sentinel (no chat → null,
  // behavior unchanged). Same derivation as confirmChatId below.
  const runChatId: string | null = input.sessionId.startsWith('anon-') ? null : input.sessionId;
  // UI Phase 6a (browser program): browser_task forwards its sub-session's
  // per-action `browser_observation` events through this sink. input.emit —
  // NOT the prefixed local emit — for the same reason as the UI-GLOBAL list in
  // ctx.emit below: browser transparency must reach the panel even from a
  // WORKER (whose 'subagent:'-prefixed events the UI drops). Lanes that don't
  // render it (the chat cross-checker's emit switch) ignore the type.
  // Ticket 8fe9429c (2026-09-25): a WORKER's cache is marked observe-only at
  // the device-input layer — its browser_task COMPUTER handoff and any
  // computer_task run CAMERA-ONLY on the user's paired desktop (screenshots
  // and reads allowed; click/type/key/scroll/open/uia_invoke refused at the
  // computer-loop dispatch gate BEFORE anything reaches the device). The
  // orchestrator (opts.role undefined) keeps the historical full-control
  // behavior. The incident: a read-only observation sub-agent quit Terminal
  // on the harvest Mac via this exact path, killing a nohup'd tar+scp child.
  const toolCache = new ToolCache(
    input.userId,
    runChatId,
    (ev, data) => input.emit(ev, data),
    opts.role ? { computerInputMode: 'observe' as const } : {},
  );
  // cu-diag 2026-09-25 fix #6: computer-use provenance — a MACHINE-triggered
  // run (supervisor wake, schedule, hook, lane) is camera-only on the paired
  // device while the owner appears active there, and the run's lane label is
  // recorded next to the device use-lock so a contender's refusal names it.
  // (A setter, not a fifth constructor arg: the constructor call above is
  // pinned byte-for-byte by observe-only.toolcache.8fe9429c.test.ts. The
  // optional call tolerates the many replay suites that fake ToolCache with
  // a bare { getOrExecute } object.)
  toolCache.setRunContext?.({
    machineTriggered: input.machineTriggered === true,
    lane: `${opts.role ? `${opts.role} worker` : (profile.kind === 'coding' ? 'coding session' : 'chat')} ${input.sessionId}`,
  });
  const alwaysAllow = new Set<string>();

  // Prefer the session's isolated container for shell tools; fall back to
  // in-process bash when container mode is off or the container isn't available.
  // `let`, not `const`: the shell executor re-resolves this once mid-run when it
  // is false (ticket 093e9a61) so a single miss at run start cannot disable
  // every shell tool for the whole firing. See execShell below.
  let useContainer = profile.workspaceTools ? await ensureSessionContainer(input.sessionId) : false;
  // One bounded lazy re-resolve per run (ticket 093e9a61) — never per tool call.
  let shellRecoveryTried = false;
  if (useContainer) emit('progress', { message: 'Using isolated session container', stage: 'container' });
  // Orphan reaper (ticket db25c401): exec legs (tsc/jest/prisma) from prior
  // "terminated" runs survive their wrappers and pin the container cgroup at
  // its memory ceiling — the next verify tsc then gets SIGKILLed (exit 137,
  // empty output, masquerading as a typecheck failure). Reap THIS session's
  // orphans at run start (the verify chain's own pre-chain reap only catches
  // >30-min-old legs — young same-session orphans slip through); best-effort,
  // never blocks the run.
  if (useContainer) {
    const reaped = await reapOrphanedBuildProcesses(input.sessionId).catch(() => 0);
    if (reaped > 0) emit('progress', { message: `Reaped ${reaped} orphaned build process(es) left by earlier runs — freed container memory for this run's verify chain`, stage: 'container' });
  }
  // Container-replacement detection (ticket c25f8b7e). The container NAME is
  // deterministic per session, so a deploy/restart wave that swaps it is
  // invisible by name — the docker ID is the only witness. This records the id
  // the session now runs in on the durable coding_session_env volume and comes
  // back with a replacement when it differs from the one on file. The lane then
  // learns, IN ITS PROMPT (below), that everything it started in the previous
  // container is gone — instead of rediscovering it from a bare "No such
  // container" hours later with a half-written artifact (the 2026-11-03
  // Schooltime lanes 19dd22bc / 60dfc8a8). Best-effort by contract: a first
  // sighting, an unreadable id or a bookkeeping failure reports nothing.
  const containerReplacement = useContainer
    ? await noteSessionContainerIdentity(input.sessionId).catch(() => null)
    : null;
  if (containerReplacement) {
    emit('progress', { message: 'Session container was replaced since the last run — background processes and container-local files from the old container are gone', stage: 'container' });
  }
  // Chat-parity credentials for the session shell: the user's connected GitHub /
  // Google / Slack / Asana tokens + the MCP gateway token, merged into every
  // command's env (so `git push`/`gh`, private clones, and curling MCP tools work
  // as the user). Gathered once per run; best-effort (empty if nothing connected).
  // build 2026-10-08 ISO: sessionId + shell let the credential proxy (CODING_CREDENTIAL_PROXY) replace the raw platform tokens.
  // aa6b6da2: a GATHER FAILURE must never read as "the user has no stored credentials" — log the named reason (the shell then runs with none, which IS the observable contract, but the cause is on record and alertable).
  // agentWarn (FO-48 convention, defined further down): every coding-loop warn carries { sessionId, runId, source } — reviewer F7.
  const credEnv = await gatherSessionCredentialEnv(input.userId, input.githubLabel, { sessionId: input.sessionId, shell: !!profile.workspaceTools }).catch((err: any) => {
    logger.warn(`coding: session credential gather FAILED for user ${String(input.userId).slice(0, 8)} session ${input.sessionId} — reason: ${err?.message || err} — the session shell runs WITHOUT stored credentials this run (not "user has none")`, {
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      source: 'coding-agent',
    });
    return {} as Record<string, string>;
  });
  // Tell the agent WHICH credential env vars its shell already carries (names
  // only) — so it reaches for wrangler/aws/brev/etc. instead of asking for keys.
  if (profile.workspaceTools && messages[0]?.role === 'system') {
    const note = credentialEnvNote(credEnv);
    if (note) messages[0].content += note;
    // Fresh-shell discipline (applies to every coding mode).
    messages[0].content += `\n\n[SHELL STATE]\nEach run_command runs in a FRESH shell — cd, export, and PATH changes do NOT persist to the next command. So:\n- Reference tools/files by ABSOLUTE path, or cd inside the SAME command (\`cd sub && npm test\`).\n- To install a CLI, use its standard installer/prefix; $HOME/.local/bin, $HOME/bin and /usr/local/bin are ALWAYS on PATH, so a normally-installed tool is found next command. Check with \`command -v <tool>\` before assuming it's missing. $HOME IS /tmp: under disk pressure a pre-exec guard wipes /tmp between commands (preserving ONLY $HOME/.local, $HOME/bin and /tmp/digby-proc), so installs elsewhere in /tmp (pip --target /tmp/…, scratch tool dirs) can vanish before the next command — put tool payloads in $HOME/.local (pip install --user) or in the worktree. That keep-list survives the WIPE, not a CONTAINER REPLACEMENT (ticket 9a391db3): the whole writable layer — including $HOME/.local and $HOME/bin when HOME=/tmp — goes with a swapped container, so a tool that answered fine earlier and now exits 127 is that, not a broken PATH: re-check with \`command -v <tool>\` and reinstall it (image-shipped bins in /usr/local/bin and anything vendored in the worktree survive).\n- To make an env var or PATH addition PERSIST across commands, append it to $DIGBY_ENV (already exported; sourced before every command): \`echo 'export FOO=bar' >> "$DIGBY_ENV"\`. Do NOT re-run installs or re-symlink each turn — persist once via $DIGBY_ENV.\n- FILE TOOLS ARE WORKTREE-SCOPED: read_file/write_file/edit_file/list_dir reject absolute paths outside the worktree, and the shell's real /tmp is a DIFFERENT filesystem than a worktree "tmp/" dir — a write_file to "/tmp/x" would never reach run_command's /tmp (this split-brain ran a stale script in prod once). Keep scratch files shared with the shell INSIDE the worktree and reference them relative to the worktree (the shell's cwd), or write them inside run_command itself.`;
  }
  // Container-replacement notice (ticket c25f8b7e) — its own block, placed
  // BEFORE the standing shell-state notes so it cannot be skimmed past: it
  // invalidates work, and the lane must re-check artifacts it remembers
  // producing. Only ever present when a swap was actually detected this run.
  if (containerReplacement && messages[0]?.role === 'system') {
    messages[0].content += `\n\n${containerReplacementNotice(containerReplacement)}`;
    messages[0].content += `\n[next scheduled firing / background workers you START this run are unaffected: this run already has a working shell. The warning above is about the PREVIOUS container. If you were relying on a job started by an earlier run, assume it stopped and check what it actually wrote before continuing from it.]`;
  }
  // A4 (One-Digby): scrub the user's credential VALUES out of shell output before
  // it reaches the model/transcript. Transcripts are persisted (coding_messages)
  // and readable by project members — `env`/`printenv`/a failing command echoing
  // its environment must never publish live OAuth tokens. We hold the exact
  // values, so a plain replace is deterministic and cheap.
  const credValues = credentialScrubValues(credEnv); // build 2026-10-08 ISO: direct mode = every value ≥ 8 chars (unchanged)
  const scrub = (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const v of credValues) out = out.split(v).join('***');
    return out;
  };
  // DETERMINISTIC SHELL STATE: every command runs in a FRESH shell (docker exec
  // / bash -lc), so export/PATH/cd never persist between commands — the agent
  // used to burn steps re-finding an installed CLI, re-symlinking, re-exporting
  // (owner-reported 2026-07-19). Fix without a persistent-shell rewrite:
  //   1. user-bin dirs are always on PATH → a normally-installed CLI is found;
  //   2. a per-session env file ($DIGBY_ENV, git-ignored, in the worktree) is
  //      sourced before every command — the agent appends exports to it once
  //      and they stick for the rest of the session. Durability ACROSS worktree
  //      reaps comes from workspace.service's session-env sidecar
  //      (persistSessionEnv on checkpoint/reap → restoreSessionEnv on
  //      re-provision) — env.sh itself is git-ignored so snapshots never carry
  //      it (2026-08-20 canlaw wipe).
  // The prefix is idempotent and harmless for the process/readiness scripts too.
  const DIGBY_ENV = `${input.worktree}/.digby/session/env.sh`;
  const shellPrefix = `export DIGBY_ENV=${JSON.stringify(DIGBY_ENV)}; export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"; [ -f "$DIGBY_ENV" ] && . "$DIGBY_ENV" 2>/dev/null; ` + ghProxyShellPrefix(credEnv); // build 2026-10-11 ISO-GH: '' unless the proxy env carries the gh kit
  const execShell = async (command: string, cwd?: string, timeoutMs = 300_000) => {
    if (!profile.workspaceTools) return { stdout: '', stderr: 'Shell is not available in chat mode.' };
    // FAIL CLOSED (2026-07-21 audit): when container isolation is configured
    // (CODING_CONTAINER_MODE=1) but the session container isn't available, do NOT
    // silently fall back to execInProcess — that runs arbitrary agent/repo code
    // INSIDE the backend container (every provider secret + every tenant's files).
    // Refuse instead; the run surfaces the degraded state rather than leaking.
    // LIVE binding, not the run-start constant (ticket 093e9a61). `useContainer`
    // is resolved ONCE per run (below), so a single miss at run start used to
    // disable EVERY shell tool for the whole firing — no command, no probe, no
    // way to diagnose it — until the next run boundary. A deploy/restart wave
    // re-provisioning the container at that moment is exactly how a lane lost a
    // firing (family deploy-kills-lane-background-workers: 08:29-08:32Z on two
    // Schooltime lanes). One bounded re-resolve per run recovers the firing.
    // Only the transition false->true is attempted, so the added cost to a lane
    // with no container at all is ONE provisioning attempt per run, not per call.
    if (isContainerMode() && !useContainer && !shellRecoveryTried) {
      shellRecoveryTried = true;
      if (await recoverSessionShellContainer(input.sessionId).catch(() => false)) {
        useContainer = true;
        emit('progress', { message: 'Session shell recovered — the session container was re-provisioned mid-run (a deploy/restart wave or a transient Docker miss at run start). Shell tools work again for the rest of this run; background processes and container-local files from the old container are gone — re-check any artifact an earlier run produced before relying on it.', stage: 'container' });
      }
    }
    if (isContainerMode() && !useContainer) {
      // Still no container after the one recovery attempt: say WHY it is
      // unrecoverable and that it is infra, not the lane's command.
      return { stdout: '', stderr: 'Isolated execution is temporarily unavailable (the session container is not healthy and re-provisioning it failed). Shell/command tools are disabled — do not retry in a loop; report this and continue with non-shell work if possible. The worktree on disk is untouched and the next run re-provisions automatically.' };
    }
    const wrapped = shellPrefix + command;
    const r = useContainer
      ? await execInContainer(input.sessionId, wrapped, cwd || input.worktree, timeoutMs, credEnv)
      : await execInProcess(wrapped, cwd || input.worktree, timeoutMs, credEnv);
    return { stdout: scrub(r.stdout), stderr: scrub(r.stderr) };
  };

  let delegationCount = 0; // per-run cost guard (orchestrator)
  // audit 2026-10-08 W2-7: change calls made by this run's WORKERS (foreground + background) — the
  // no-progress brake's only delegation signal (a delegation that changed nothing is not progress).
  let workerProgressCalls = 0;
  // audit 2026-10-08 W2-13: the model the harness's independent reviewer ACTUALLY ran on (cross-family check).
  let harnessReviewModel: string | null = null;
  // ticket d7e82531: the DURABLE full-report path of that same harness reviewer.
  // The reviewer is always a FOREGROUND worker, so persistWorkerReport always
  // writes its report to the worktree (needDiskReport = !env). The injection
  // site names this path when the audit-message clip has to drop findings, so
  // the lane can read_file the whole verdict instead of losing it.
  let harnessReviewReportPath: string | null = null;
  // ticket d7e82531 / review finding B2: the reviewer's TRUE full length, so the
  // injection can state how much the delegate seam's carrier clip already
  // dropped even when no durable copy is readable (e.g. REPORT_CLIP_V2_DISABLED,
  // whose raw slice appends no "(… N more chars)" tail).
  let harnessReviewFullChars = 0;
  // Delegations that COMPLETED inside the current turn (delegation resume-notes):
  // a 'dispatch' resume rewinds the whole in-flight turn (trimToPreModel), tool
  // results included — so a finished worker's summary would vanish and the
  // regenerated turn would re-dispatch it. checkpoint() splices these into every
  // dispatch-phase snapshot as a [COMPLETED DELEGATIONS THIS RUN] note placed
  // BEFORE the trim cut. Reset at the top of each step: by then the turn's tool
  // results are in the live transcript and need no note.
  const turnDelegations: CompletedDelegation[] = [];
  // Cross-surface confirmation presence (confirm-pending.ts): ONE Redis key per
  // chat — `confirm:pending:{chatId}` — set while the run is blocked on a human
  // (ask_user question or ask-only approval) so the sidebar indicator poll sees
  // it regardless of which process runs the agent. Coding sessions: the session
  // id IS the chat id (P5-B — coding sessions live on crossModelChat rows).
  // Chat runs: runSessionId is the chat id for logged-in users; anonymous runs
  // key on an `anon-` sentinel (chat-agent.service) whose waits no authenticated
  // poll could ever resolve — skip publishing for those.
  const confirmChatId: string | null = runChatId;
  // Plain + background delegation share ONE dispatch path (background-delegation.ts):
  // prepareDelegation runs every refusal / budget / seat check and returns
  // either the refusal text or an `execute` that runs the worker. A plain
  // delegate awaits execute(); a background one hands it to the pool with its
  // own cancel flag, a gated emit (silent once the run finalized) and a usage
  // sink that keeps late turns out of an already-written spend row.
  type WorkerEnv = { handle: string; isCancelled: () => boolean; emitRaw: (ev: string, data: any) => void; usage: UsageAccumulator };
  const prepareDelegation = async (
    role: string, task: string, title: string, todoId?: number, dOpts?: { model?: string; harnessReview?: boolean },
  ): Promise<string | { execute: (env?: WorkerEnv) => Promise<string> }> => {
    if (!isCodingRole(role)) return `Unknown role "${role}".`;
    if (profile.kind !== 'coding' && !['web_researcher', 'cross_checker'].includes(role)) {
      return `Role "${role}" is not available in chat mode. Available: web_researcher (external facts + bulk ingestion via web_pipe/youtube_pipe), cross_checker.`;
    }
    if (delegationCount >= profile.maxDelegations) return `Delegation budget reached (${profile.maxDelegations} workers this run). Finish with what the workers have produced or do the remaining work directly.`;
    // File-artifact brief vs read-only role (ticket 68a36304): refuse
    // BEFORE the budget is charged and BEFORE any worker runs — a
    // read-only worker dispatched on a "write the output file" brief can
    // only half-deliver (its toolset has no write tools at all), so the
    // analysis came back in chat and the persistence step was dropped.
    // The refusal is the contract: it names both re-routes.
    // CODING LANE ONLY: the re-routes it advertises (delegate to
    // coder/editor, or write the file in the worktree yourself) are
    // executable only there — in chat mode coder/editor are not
    // delegable and there is no worktree, so the advice would be a
    // broken recovery path (251e9329) and chat tasks embed the USER's
    // question (a "how do I write to a file" question must not refuse).
    // The harness's own reviewer dispatch quotes the original task (which names files to create) — not a file-artifact demand on the reviewer.
    const fileWriteRefusal = profile.kind === 'coding' && !dOpts?.harnessReview ? readOnlyFileWriteRefusal(role, task) : null;
    if (fileWriteRefusal) return fileWriteRefusal;
    delegationCount += 1;
    // SNAPSHOT this delegation's ordinal NOW (ticket 95210e7e review finding 2):
    // `delegationCount` is a live closure variable, so reading it at COMPLETION
    // time gives the WRONG number as soon as another delegation is prepared
    // in between. `delegate_parallel` runs `Promise.all`, which prepares every
    // task first and only then awaits them — with a live read, all N workers
    // persisted under the last-prepared ordinal, and same-role workers landing
    // in the same millisecond OVERWROTE each other's durable report while the
    // resume note still pointed at the survivor. The ordinal must be the one
    // this delegation was dispatched with.
    const myOrdinal = delegationCount;
    // Model tiering (audit #10): an explicit per-delegation tier override
    // wins ('helper'/'premium' from the delegate tool, or a concrete model
    // id from programmatic callers); else helperTier roles run on the FAST
    // helper model — a reasoning model just makes mechanical work slow and
    // expensive. Resolution lives in delegation.ts (unit-tested). The
    // helper SEAT honors the instance's coding_helper role override
    // (model-roles config) — on Edge the built-in DashScope helper has no
    // key, so helper-tier delegations 401'd until this was configurable.
    const helperModel = await resolveRoleModelForRun('coding_helper', HELPER_MODEL);
    const ruleModel = resolveWorkerModel(role, dOpts?.model, input.model, helperModel);
    // Per-role worker seats (harness roadmap item 4, 2026-09-19): the
    // admin's model for this role's seat (Reviewer follows the Double
    // Checker by default → an independent review model; Architect /
    // Explorer unset = the lane's own model). An explicit model on the
    // delegate call wins; a seat this instance cannot serve degrades to
    // the tier rule with a log line — never a refusal for a default.
    const seatKey = !dOpts?.model ? WORKER_ROLE_SEATS[role] : undefined;
    let seatModel = seatKey ? await resolveRoleModelForRun(seatKey, '') : '';
    if (seatModel && seatModel !== ruleModel) {
      const seatProblem = await seatUnservableReason(seatModel, input.userId);
      if (seatProblem) {
        logger.info(`coding agent [${agentLabel}]: ${seatKey} seat (${seatModel}) cannot serve the ${role} worker on this instance — ${seatProblem}; running it on ${ruleModel}`);
        seatModel = '';
      }
    }
    const workerModel = resolveWorkerModel(role, dOpts?.model, input.model, helperModel, seatModel || undefined);
    const routedBySeat = workerModel !== ruleModel;
    if (routedBySeat) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.WORKER_SEAT_ROUTE, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, value: 1,
        meta: { role, seat: seatKey, model: workerModel, from: ruleModel, machine: input.machineTriggered === true },
      });
    }
    // Worker seat pre-flight (2026-09-08): a worker on a model this
    // instance cannot serve (keyless built-in on Edge) used to 401 inside
    // the sub-loop and surface only as a vague failure summary. Tell the
    // orchestrator up front, naming the seat and the fix; never dispatch.
    const workerSeatProblem = await seatUnservableReason(workerModel, input.userId);
    if (workerSeatProblem) {
      return `Cannot run the ${ROLES[role].label} worker on this instance: ${workerSeatProblem}. Do the work yourself, or ask an admin to assign the ${ROLES[role].helperTier || dOpts?.model === 'helper' ? 'Helper seat' : 'coding model'} a servable model (Account → Admin → Endpoints → Model roles).`;
    }
    return {
      execute: async (env?: WorkerEnv): Promise<string> => {
        const dEmit = env ? (ev: string, data: any) => env.emitRaw((opts.eventPrefix || '') + ev, data) : emit;
        const workerEnvInput = env ? { isCancelled: env.isCancelled, emit: env.emitRaw, usage: env.usage } : {};
        dEmit('subagent_start', { title, role, model: workerModel, ...(routedBySeat ? { seat: seatKey } : {}), ...(env ? { background: true, handle: env.handle } : {}) });
        const workerOpts = { maxSteps: ROLES[role].maxSteps, allowSubagents: false, eventPrefix: 'subagent:' as const, role, agentLabel: title || ROLES[role].label, resultEnvelope: true };
        // Helper-SEAT semantics travel with the worker: a helper-tier role (or
        // an explicit model:'helper') runs the Helper model in its FAST shape —
        // on a DeepSeek built-in that means thinking off, no reasoning_effort
        // (V4.1 Flash thinks by default; mechanical work must stay cheap). An
        // explicit concrete model id or 'premium' keeps the model's own shape.
        const fastSeat = dOpts?.model === 'helper' || (!dOpts?.model && !!ROLES[role].helperTier);
        let sub = await agentLoop(
          // machineTriggered stripped like the guard config: the zero-tool
          // gate is top-level-only anyway, but a worker must never inherit
          // the machine-run posture (a delegated summarize legitimately
          // answers without tools). The BACKOFF class alone is inherited
          // (workerUnattended, cffaa701): a machine parent's workers ride
          // the same long transient table as the parent — otherwise they
          // silently kept the short interactive table and died inside the
          // same provider rate window the parent just survived.
          { ...input, userMessage: task, history: [], model: workerModel, fastSeat, onCheckpoint: undefined, resumeFrom: undefined, schedulerNotice: undefined, machineClaimBar: undefined, evidenceGuardRejectBack: undefined, machineTriggered: undefined, ownerDispatch: undefined, workerUnattended: input.machineTriggered === true || input.ownerDispatch === true || undefined, parentTriggerKind: metricStamp.triggerKind, ...workerEnvInput },
          workerOpts,
        );
        // A worker that produced NO final text is a silent failure (session
        // fa767dbf: "(worker produced no output)" landed in the transcript and
        // the run stalled until the user typed "continue"). Retry ONCE with an
        // explicit deliverable instruction; if still empty, tell the
        // orchestrator unambiguously to do the work itself inline.
        if (!sub.finalText?.trim()) {
          dEmit('subagent_start', { title: `${title} (retry)`, role });
          sub = await agentLoop(
            { ...input, userMessage: `${task}\n\nIMPORTANT: your previous attempt returned no output. Complete the task and END with a written report of what you did/found — your final message IS the deliverable.`, history: [], model: workerModel, fastSeat, onCheckpoint: undefined, resumeFrom: undefined, schedulerNotice: undefined, machineClaimBar: undefined, evidenceGuardRejectBack: undefined, machineTriggered: undefined, ownerDispatch: undefined, workerUnattended: input.machineTriggered === true || input.ownerDispatch === true || undefined, parentTriggerKind: metricStamp.triggerKind, ...workerEnvInput },
            workerOpts,
          );
        }
        // Structured result envelope: prose + a harness [WORKER STATUS: …]
        // line when the worker ended with the JSON footer; the raw text
        // (old behavior) when it didn't.
        workerProgressCalls += sub.progressCalls ?? 0; // W2-7: the worker's own change calls
        if (dOpts?.harnessReview) harnessReviewModel = sub.seatFallback?.to ?? workerModel; // W2-13
        // audit 2026-10-08 W2-6 (report-clip.ts): a report over the cap keeps its
        // FULL text in the worktree's git-ignored scratch and the clipped summary
        // names the file (read_file). REPORT_CLIP_V2_DISABLED=1 = the 4,000 slice.
        const workerFull = sub.finalText || '';
        // DURABLE AT COMPLETION (ticket 95210e7e): write the worker's FULL text
        // to the worktree scratch NOW — unconditionally for a FOREGROUND
        // worker, not only when the report overflows the clip cap. The write
        // used to be over-cap-only, so an ordinary 4–8k reviewer verdict left
        // no durable artefact at all: a mid-turn restart (deploy) orphaned it
        // and the regenerated turn's note carried a 200-char head as the only
        // surviving copy. The worktree outlives a process restart, a redeploy
        // and a container replacement, so this is the report's lifeboat.
        //
        // BACKGROUND workers keep the PRE-EXISTING over-cap gate on purpose:
        // they already have their own durable recovery (the chat-scoped spill,
        // ticket 458342f5), and an extra await inside their `execute` would
        // delay the pool's settlement signal — which is what decides the turn
        // boundary their report is injected at.
        //
        // Gated on the WORKTREE alone for the foreground case: a chat run has
        // none (nothing to write to), a coding run always does.
        // qa: the write is best-effort (never throws); a null result falls back
        // to the in-memory summary exactly as before.
        const needDiskReport = !env
          || (!reportClipV2Disabled() && workerFull.length > workerReportCapChars());
        const workerReportRel = needDiskReport && input.worktree
          ? await persistWorkerReport({ worktree: input.worktree, role, title, ordinal: myOrdinal, report: workerFull })
          : null;
        // ticket d7e82531: remember the harness reviewer's durable copy so the
        // audit-message injection can name it instead of severing the verdict.
        if (dOpts?.harnessReview) {
          harnessReviewFullChars = workerFull.length;
          if (workerReportRel) harnessReviewReportPath = workerReportRel;
        }
        let workerRestHint: string | undefined;
        if (workerReportRel && !reportClipV2Disabled() && workerFull.length > workerReportCapChars()) {
          workerRestHint = `the FULL report is in ${workerReportRel} — read_file it for the rest`;
        }
        // The note's OWN carrier for this worker. The durable file keeps the raw
        // text (faithful artefact); the inline copy drops the JSON status footer
        // so the note's budget is spent on findings, not on envelope syntax.
        const workerProse = parseWorkerEnvelope(workerFull)?.prose.trim() || workerFull.trim();
        const ws = buildWorkerSummary(
          workerFull,
          `[WORKER FAILED — produced no output after a retry. Do this task yourself inline now with your own tools; do NOT re-delegate it. Task was: ${task.slice(0, 300)}]`,
          workerRestHint ? { restHint: workerRestHint } : undefined,
        );
        // The UI event names the model that ACTUALLY finished the worker —
        // the built-in helper when the custom seat failed mid-run.
        dEmit('subagent_end', { title, role, summary: ws.summary, model: sub.seatFallback?.to ?? workerModel, status: ws.status, ...(sub.seatFallback ? { seatFallback: { from: sub.seatFallback.from, reason: sub.seatFallback.reason } } : {}) });
        // Surface the worker's spend immediately (the next per-step context
        // emit could be a long model turn away).
        dEmit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount, usage: usageAcc.snapshot(), sessionUsage: sessionUsageView() });
        // Delegation resume-note: record the completion + write a checkpoint
        // NOW, so a crash later in this turn (a sibling delegation, a later
        // tool call) resumes with this worker's result instead of re-running it.
        // A BACKGROUND worker finishes in a LATER turn: its report reaches the
        // transcript as an injected harness message (checkpointed preModel),
        // never as this turn's tool result — no in-flight resume note.
        if (!env) {
          turnDelegations.push({
            title: title || role, role, status: ws.status, summary: ws.summary,
            // Ticket 95210e7e: the note is the only thing that survives a
            // mid-turn restart — it must point at the durable full report
            // (or carry the report itself when no durable copy exists).
            ...(workerReportRel ? { reportPath: workerReportRel } : { report: workerProse }),
          });
          checkpoint('dispatch');
        }
        // Link the result back to the plan step, if one was named. The parsed
        // envelope decides blocked (prose-only workers keep the old heuristic).
        if (todoId != null) {
          const updated = await linkTodoResult(input.sessionId, input.worktree, todoId, ws.summary, ws.blocked).catch(() => null);
          if (updated) dEmit('plan_update', { plan: updated });
        }
        // Model-facing retrieval pointer (owner 2026-09-04): the worker's
        // offload used to announce itself only via UI progress events — the
        // orchestrator never learned retrievable detail existed. Appended to
        // the RETURN only (plan notes + delegation records keep the clean
        // summary above).
        const memoryPointer = sub.offloaded
          ? `\n\n[HARNESS: this worker stored ${sub.offloaded} full-detail finding chunk${sub.offloaded === 1 ? '' : 's'} to session memory — search_memory with specific keywords (paths, symbols, error text) retrieves what this summary compressed away.]`
          : '';
        // Helper-seat health fallback (owner 2026-09-14): the orchestrator
        // (and the owner reading the transcript) must learn the custom
        // helper seat is unhealthy — an honest attribution, never a silently
        // re-seated worker. Review nit 1 (fe6f0b0b): a MAIN-seat failover
        // inside a premium (non-helperTier) worker carries
        // role 'coding_default' — name the CODING seat there, not the Helper.
        const seatNote = sub.seatFallback
          ? sub.seatFallback.role === 'coding_default'
            ? `\n\n[HARNESS: this worker's coding model ${sub.seatFallback.fromLabel} (${sub.seatFallback.from}) failed transiently mid-run — the worker finished on ${sub.seatFallback.to} (main-seat failover, seat_fallback telemetry). Tell the user the coding seat is unhealthy (Account → Admin → Endpoints → Model roles).]`
            : `\n\n[HARNESS: ${helperSeatAttributionLine(sub.seatFallback, 'worker finished')} — tell the user the custom Helper seat is unhealthy (Account → Admin → Endpoints → Model roles).]`
          : '';
        return ws.summary + memoryPointer + seatNote;
      },
    };
  };

  // ── Background delegation (coding/background-delegation.ts) — orchestrator
  // only. The pool is created on the first background start; runCodingAgent's
  // finally closes it too (a thrown run still posts its late reports).
  let bgPool = null as BackgroundWorkerPool | null; // cast: assigned in closures — keep TS from narrowing it to null
  /**
   * SAA-1.6 PHASE 3b (platform/async-tool-registry.ts) — handed-off tool calls.
   * Created on the FIRST eligible call of the run, closed in the run's `finally`
   * (so a thrown run still REPORTS what it owed rather than dropping it
   * silently). `apply` is the plan's own flag: true only when the switch says
   * `apply`/`rewrite`, so a deploy in the default observe mode records the
   * threshold crossings and changes no timing at all.
   */
  let asyncTools = null as AsyncToolRegistry | null;
  const ensureAsyncTools = (plan: AsyncToolPlan): AsyncToolRegistry => {
    if (asyncTools) return asyncTools;
    asyncTools = new AsyncToolRegistry({
      afterMs: plan.afterMs,
      apply: plan.applied,
      metric: (phase, e) => {
        try {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.ASYNC_TOOL_CALLS_DELIVER,
            sessionId: input.sessionId,
            ...(input.runId ? { runId: input.runId } : {}),
            stamp: metricStamp,
            ...(typeof e.elapsedMs === 'number' ? { value: e.elapsedMs, unit: 'ms' } : {}),
            meta: {
              tool: e.tool,
              phase,
              ...(e.correlationId ? { id: e.correlationId } : {}),
              ...(phase === 'threshold_crossed' ? { apply: e.apply === true } : {}),
              ...(typeof e.ok === 'boolean' ? { ok: e.ok } : {}),
            },
          });
        } catch { /* metrics never break a call */ }
      },
      log: (m) => agentWarn(`coding agent [${agentLabel}]: ${m}`),
      // Ticket 9ecabc73: a handed-off result that lands AFTER this run ended used
      // to be dropped into a log line — the "Started" text had already promised
      // the model it would reach the transcript, so silence here is exactly the
      // severed-write the ticket reports. Post it as a real chat message instead.
      onLateResult: (done: AsyncToolDone) => {
        // A guest/chatless session has no chat row to post into. The hand-off
        // still happened, so say so in the log rather than dropping it mutely —
        // and note WHY, so the run-end path is not mistaken for a broken post.
        if (!runChatId) {
          agentWarn(`coding agent [${agentLabel}]: chattess session cannot receive late background result ${done.tool} ${done.correlationId} (no chat row) — result dropped`);
          return;
        }
        // A post that FAILS must not be silent either — that is the defect this
        // ticket reports (reviewer finding c).
        void postBackgroundReportMessage(runChatId, formatOwedToolResults([{ ...done, settled: true }]), {
          kind: 'background_tool_result', origin: 'background_tool', correlationId: done.correlationId, tool: done.tool, runId: input.runId ?? null, late: true,
        }).then((ok) => {
          if (ok) return;
          agentWarn(`coding agent [${agentLabel}]: failed to post late background result ${done.tool} ${done.correlationId} to chat ${runChatId}`);
          try {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.ASYNC_TOOL_CALLS_DELIVER, sessionId: input.sessionId,
              ...(input.runId ? { runId: input.runId } : {}), stamp: metricStamp,
              meta: { tool: done.tool, phase: 'run_end_post', id: done.correlationId, ok: false },
            });
          } catch { /* metrics never break a run */ }
        }).catch(() => { /* a late post must never throw into the settle path */ });
      },
    });
    return asyncTools;
  };
  // Ticket 9ecabc73 (reviewer finding d): the close is reachable from BOTH the
  // inline run-end path and runCodingAgent's `finally`, so a run that THROWS
  // still posts what it owed instead of losing it. `closeRun` is idempotent —
  // the second caller gets [] — so double invocation posts nothing twice.
  const closeAsyncToolsAtRunEnd = (): void => {
    if (!asyncTools) return;
    try {
      const owed = asyncTools.closeRun();
      if (!owed.length) return;
      // A result already in hand is POSTED, never merely mourned. The old path
      // wrote a log line and a progress event — neither of which is a
      // transcript row — while the "Started" text had promised the model the
      // result would land in the transcript. A still-running call is announced
      // here too, and its eventual result arrives through `onLateResult`;
      // either way the chat gets a terminal status, never silence.
      const settledCount = owed.filter(o => o.settled).length;
      agentWarn(`coding agent [${agentLabel}]: run ended owing ${owed.length} handed-off tool call(s) (${owed.map(o => `${o.tool} ${o.correlationId}${o.settled ? ' [result held]' : ' [still running]'}`).join(', ')}) — posting to the chat`);
      if (runChatId) {
        // A post that FAILS must not be silent either — that is the very defect
        // this ticket reports. Record the outcome so a lost write is visible.
        void postBackgroundReportMessage(runChatId, formatOwedToolResults(owed), {
          kind: 'background_tool_result',
          origin: 'background_tool',
          runId: input.runId ?? null,
          correlationIds: owed.map(o => o.correlationId),
          settledCount,
          runningCount: owed.length - settledCount,
        }).then((ok) => {
          if (ok) return;
          agentWarn(`coding agent [${agentLabel}]: failed to post ${owed.length} owed background tool result(s) to chat ${runChatId}`);
          try {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.ASYNC_TOOL_CALLS_DELIVER, sessionId: input.sessionId,
              ...(input.runId ? { runId: input.runId } : {}), stamp: metricStamp,
              meta: { phase: 'run_end_post', ok: false, count: owed.length },
            });
          } catch { /* metrics never break a run */ }
        }).catch(() => { /* postBackgroundReportMessage never throws, but a promise chain must not either */ });
      } else {
        agentWarn(`coding agent [${agentLabel}]: chattess session cannot receive ${owed.length} owed background tool result(s) (no chat row) — results dropped`);
      }
      emit('progress', {
        // Only claim "posted" when there is a chat to post into (reviewer
        // finding: the old line asserted a delivery that may not have happened).
        message: !runChatId
          ? `${owed.length} background tool call(s) finished without a chat to report into`
          : settledCount
            ? `${settledCount} background tool result${settledCount === 1 ? '' : 's'} posted to this chat (the run ended before ${settledCount === 1 ? 'it' : 'they'} could be delivered in-loop)`
            : `${owed.length} background tool call(s) still running at run end — their results will be posted here when they finish`,
        stage: 'background',
      });
    } catch { /* closing the registry never breaks a finishing run */ }
  };
  // Expose it so runCodingAgent's `finally` covers the THROW path too.
  if (opts.asyncHolder) opts.asyncHolder.closeAtRunEnd = closeAsyncToolsAtRunEnd;
  const bgMetric = (phase: string, w: BackgroundWorker | null, extra?: Record<string, unknown>): void => {
    const ms = w ? (w.finishedAt ?? Date.now()) - w.startedAt : (typeof extra?.ms === 'number' ? extra.ms : undefined);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.DELEGATE_BACKGROUND, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
      ...(ms !== undefined ? { value: ms, unit: 'ms' } : {}),
      meta: {
        phase,
        ...(w ? { workerId: w.id, role: w.role, title: w.title.slice(0, 80), ...(w.todoId != null ? { todoId: w.todoId } : {}) } : {}),
        ...(extra ?? {}),
        machine: input.machineTriggered === true, profile: profile.kind,
      },
    });
    // build 2026-10-08 D-1: the delegation ledger mirrors the worker's lifecycle (SHADOW, never throws).
    noteBackgroundWorkerPhase(phase, w, { sessionId: input.sessionId, runId: input.runId ?? null, userId: input.userId, machine: input.machineTriggered === true });
  };
  const ensureBgPool = (): BackgroundWorkerPool => {
    if (bgPool) return bgPool;
    const pool = new BackgroundWorkerPool({
      metric: bgMetric,
      parentCancelled: () => input.isCancelled?.() === true,
      postLate: async (w, text) => (runChatId
        ? postBackgroundReportMessage(runChatId, text, { kind: 'background_worker_report', origin: 'background_worker', workerId: w.id, role: w.role, title: w.title, runId: input.runId ?? null })
        : false),
      log: (m) => agentWarn(`coding agent [${agentLabel}]: ${m}`),
      latePostGraceMs: backgroundLatePostGraceMs(),
      // Ticket 458342f5: a finished report must outlive this process. Spill it
      // at settle; drop it once the report is durable elsewhere (a landed late
      // post, or run finalize for a delivered report).
      spillReport: (w) => spillBackgroundReport(runChatId as string, w, input.runId ?? null),
      clearSpills: (ids) => Promise.resolve(runChatId ? clearBackgroundReportSpills(runChatId, ids) : 0),
    }, backgroundWorkerCap());
    bgPool = pool;
    if (opts.bgHolder) opts.bgHolder.pool = pool;
    return pool;
  };
  /** The late-turn spend of a background worker that outlived a plain run (its own run_spend row). */
  const settleBackgroundUsage = (late: BackgroundUsageAccumulator): void => {
    try {
      const snap = late.snapshot();
      if (!snap.turns) return;
      recordRunSpend(late.runId, input.sessionId, snap, metricStamp);
      if (profile.workspaceTools) void commitRunUsage(input.sessionId, snap).catch(() => {});
    } catch { /* spend accounting never breaks a worker */ }
  };
  const startBackgroundDelegations = async (specs: BackgroundTaskSpec[], via: 'delegate' | 'delegate_parallel'): Promise<{ handled: boolean; text: string }> => {
    // Kill switch: the pre-feature behaviour — the call runs in the FOREGROUND.
    if (delegateBackgroundDisabled()) {
      bgMetric('sync_fallback', null, { reason: 'disabled', tasks: specs.length, via });
      return { handled: false, text: '[HARNESS: background delegation is turned off on this instance — this ran in the FOREGROUND (the call blocked until it finished); the report is above.]' };
    }
    // A session with no chat row could never receive a late report — never lose one.
    if (!sessionCanReceiveLatePost(input.sessionId)) {
      bgMetric('sync_fallback', null, { reason: 'no_chat', tasks: specs.length, via });
      return { handled: false, text: '[HARNESS: this session has no chat a late background report could be posted to — this ran in the FOREGROUND; the report is above.]' };
    }
    const writer = specs.find(t => isCodingRole(t.role) && isWriterRole(t.role));
    if (writer) {
      bgMetric('refused', null, { reason: 'writer_role', role: writer.role, tasks: specs.length, via });
      return { handled: true, text: `[BACKGROUND REFUSED — nothing was started] Role "${writer.role}" writes to the worktree, so it cannot run in the background (a concurrent write would race your own edits). Run it with a plain delegate (it blocks until done), or — for long independent work that should outlive this run — start_coding_session (its own worktree).` };
    }
    const pool = ensureBgPool();
    if (specs.length > pool.capacity) {
      bgMetric('refused', null, { reason: 'cap', requested: specs.length, running: pool.runningCount(), cap: pool.maxConcurrent, via });
      return { handled: true, text: `[BACKGROUND REFUSED — nothing was started] ${pool.runningCount()} of ${pool.maxConcurrent} background workers are already running and this call asked for ${specs.length} more. Await one with delegate_status({wait_seconds}), run this with a plain delegate (blocks), or drop it.` };
    }
    const started: Array<{ id: string; role: string; title: string }> = [];
    const notStarted: string[] = [];
    for (const t of specs) {
      // Every refusal / budget / seat check of a plain delegation — before anything runs.
      const prep = await prepareDelegation(t.role, t.task, t.title, t.todoId, t.opts);
      if (typeof prep === 'string') {
        notStarted.push(`### ${t.title || t.role} (${t.role}) — not started\n${prep}`);
        continue;
      }
      const late = new BackgroundUsageAccumulator(usageAcc, () => pool.runOpen);
      usageAcc.retain(); // a SHARED turn ledger settles only after this worker (no-op on a plain accumulator)
      const gatedEmit = (ev: string, data: any): void => { if (pool.runOpen) input.emit(ev, data); };
      const w = pool.start({ role: t.role, title: t.title || t.role, todoId: t.todoId }, (isCancelled, wk) =>
        prep.execute({ handle: wk.id, isCancelled, emitRaw: gatedEmit, usage: late })
          .finally(() => { settleBackgroundUsage(late); usageAcc.release(); }));
      started.push({ id: w.id, role: w.role, title: w.title });
    }
    if (!started.length) return { handled: true, text: notStarted.join('\n\n') || 'Nothing was started.' };
    emit('progress', { message: `Started ${started.length} background worker${started.length === 1 ? '' : 's'}: ${started.map(w => w.title).join(', ')}`, stage: 'background' });
    return { handled: true, text: [backgroundStartedText(started), ...notStarted].join('\n\n') };
  };

  // MERGE-INTENT-AWAIT (2026-10-20): a tool's request to END the run after its
  // round (await_condition registered a condition wake — the harness, not
  // another model turn, wakes the chat). Top-level runs only; first notice wins.
  let toolEndTurnRequest: string | null = null;
  const ctx: ToolContext = {
    worktree: input.worktree,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    // Ticket 119df67e: the run's in-process receipt collector, threaded so
    // read-side evidence gates (observe_resource / verify_durable no_receipt)
    // can see THIS run's receipts on chat-surface runs, where the DB path
    // (runId-keyed; no agent_runs row) is structurally blind.
    receipts: receiptCollector,
    projectId: input.projectId,
    projectName: input.projectName,
    ...(input.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}),
    userId: input.userId,
    permissionMode: input.permissionMode,
    repoUrl: input.repoUrl,
    provider: input.provider,
    branch: input.branch,
    baseBranch: input.baseBranch,
    getGithubToken: () => getValidToken(input.userId, input.githubLabel || undefined),
    // A tool's own bounded harness-side wait (self-merge WAIT-ONCE, 2026-09-27)
    // leaves the run deadline — the awaitApproval / ask_user idiom below.
    onShieldedWait: (ms: number, opts?: { queued?: boolean }) => { if (Number.isFinite(ms) && ms > 0) { deadlineOffsetMs += ms; if (opts?.queued) toolQueuedMs += ms; } },
    ...(opts.allowSubagents
      ? { requestEndTurn: (notice: string) => { if (!toolEndTurnRequest && typeof notice === 'string' && notice.trim()) toolEndTurnRequest = notice.trim().slice(0, 2000); } }
      : {}),
    // UI-GLOBAL events must reach the sidebar even from a WORKER (whose emit is
    // 'subagent:'-prefixed and dropped by the UI): a worker starting a dev
    // server still updates the Running section and auto-configures the preview.
    emit: (ev: string, data: any) => {
      if (ev === 'process_update' || ev === 'preview_ready' || ev === 'plan_update' || ev === 'pr_opened' || ev === 'branch_pushed' || ev === 'file_changed' || ev === 'repo_created') {
        input.emit(ev, data);
      } else {
        emit(ev, data);
      }
    },
    toolCache,
    alwaysAllow,
    execShell,
    // audit 2026-10-06 T7-7: arms the run_command workspace-scope guard where the shell sees the whole volume.
    workspaceExposure: () => (useContainer ? workspaceExecExposure(input.sessionId) : null),
    // aa6b6da2: arms run_command's credential-name near-miss guard — the injected
    // NAMES (never values) so a misspelled name is flagged at the point of failure.
    credentialEnvNames: Object.keys(credEnv).filter((k) => !k.startsWith('GIT_CONFIG_')),
    extraTools: input.extraTools,
    ...(userMcp ? { userMcp } : {}),
    userTurnAt: input.userTurnAt,
    // Origin-aware machine flag (secret-scrubbing review fix): the executor's
    // triggerKind classification rides the tool ctx so the chat-read
    // redaction sees an agent-origin wake as a machine run even when the
    // sending run threaded a userTurnAt. Conditional spread: user runs and
    // worker contexts (machineTriggered undefined) keep their exact shape.
    ...(input.machineTriggered === true ? { machineTriggered: true } : {}),
    // audit 2026-10-06 T4-5: an owner-DISPATCH run (user-classified, unattended)
    // rides the tool ctx so schedule provenance stamps its arms 'machine'.
    ...(input.ownerDispatch === true ? { ownerDispatch: true } : {}),
    // Owner-subscribed firing (ticket 4565991a): the run's subscription state
    // rides the tool ctx so schedule_message/update_schedule can INHERIT it
    // onto own-chat successors (the one-shot ladder pattern).
    ...(input.scheduleOwnerArmed ? { scheduleOwnerArmed: true } : {}),
    // One-shot chain provenance (finding B1): the firing schedule's id rides
    // the tool ctx so schedule_self / own-chat schedule_message stamp the link.
    ...(input.firedByScheduleId ? { firedByScheduleId: input.firedByScheduleId } : {}),
    // Cohesive chat (platform/work-tools.ts): a Dig-deeper rung cards its
    // requested-work tools; the user's own text (top-level, user-anchored,
    // non-machine runs only — never a worker's delegated task) binds the
    // credential-spending work tools to a repo URL the user typed.
    ...(input.escalation ? { escalation: true } : {}),
    ...(!opts.role && input.userTurnAt && input.machineTriggered !== true
      ? (() => { const t = typeof input.userTurnText === 'string' ? input.userTurnText : input.userMessage; return typeof t === 'string' && t ? { userTurnText: t.slice(0, 20_000) } : {}; })()
      : {}),
    // Workers are locked to their role's tool policy at execution time; the
    // orchestrator (no role) gets undefined = every tool.
    allowedTools: opts.role
      ? new Set(input.noWebTools
          ? ROLE_TOOLS[opts.role].filter(n => !['search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe', 'youtube_pipe'].includes(n))
          : ROLE_TOOLS[opts.role])
      : undefined,
    // Run-plane identity for file_feedback context (chat pipeline vs coding
    // harness; the worker role for subagents).
    agentSurface: profile.kind === 'coding' ? 'coding' : 'chat',
    agentRole: opts.role,
    requestApproval: async (tool, args) => {
      const approvalId = newApprovalId(input.sessionId);
      // Use the un-prefixed emit so a WORKER's approval prompt still reaches the
      // UI (which listens for 'permission_request', not 'subagent:permission_request').
      input.emit('permission_request', { approvalId, tool, args });
      const detail = String(args?.command ?? args?.path ?? args?.pattern ?? args?.query ?? args?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const approvalPrompt = detail ? `Allow ${tool}: ${detail}?` : `Allow ${tool}?`;
      if (confirmChatId) {
        void publishConfirmPending(confirmChatId, {
          kind: 'approval', id: approvalId,
          question: approvalPrompt,
          options: ['allow', 'always', 'deny'], tool, ts: Date.now(),
        });
      }
      // attentionSummary → the fleet supervisor's attention_needed hook event.
      // Phase 4 seed: tool + stable args — an identical re-ask after a restart
      // replays a recorded decision / aliases a still-pending one.
      // A HUMAN-blocking wait is not this run's work: exclude it from the run
      // deadline like injectSystem/ask_user waits (2026-09-08 audit — an
      // attended chat run's 14-min approval window vs a 240–480s deadline
      // forced a tool-less FINAL TURN right after the person answered).
      const approvalT0 = Date.now();
      const decision = await awaitApproval(approvalId, input.sessionId, approvalPrompt, stableStringify({ tool, args: args ?? null }), tool);
      deadlineOffsetMs += Date.now() - approvalT0;
      if (confirmChatId) void clearConfirmPending(confirmChatId);
      input.emit('permission_resolved', { approvalId, decision });
      return decision;
    },
    askUser: async (question, options, askOpts) => {
      // Defense-in-depth (the tool is already filtered out of anon tool lists):
      // an anonymous run has no surface that could ever answer — no chatId, no
      // authenticated endpoint, no stop path — so never park it; hand the model
      // an immediate "unavailable" so it proceeds on its own judgment.
      if (input.sessionId.startsWith('anon-')) {
        return 'Asking the user is unavailable in this run (anonymous session — no signed-in user can answer). Proceed on your best judgment, or use schedule_self to resume once a signed-in user can respond.';
      }
      const questionId = newQuestionId(input.sessionId);
      // Soft answer deadline, published so clients can render a countdown and
      // auto-expire the card; the registry's grace window beyond it still
      // absorbs in-flight answers.
      const expiresAt = Date.now() + QUESTION_TIMEOUT_MS;
      // Un-prefixed emit so the UI (which listens for 'ask_user') gets it even
      // from a worker. Blocks up to the question registry's window (60 min).
      // optionDetails / multiSelect (2026-10-20) ride beside the label list; every other surface (the pending
      // marker, the inbox, the stop / answer tools) keeps reading the labels alone.
      input.emit('ask_user', {
        questionId, question, options: options || [], expiresAt,
        ...(askOpts?.optionDetails?.length ? { optionDetails: askOpts.optionDetails } : {}),
        ...(askOpts?.multiSelect ? { multiSelect: true } : {}),
      });
      if (confirmChatId) {
        void publishConfirmPending(confirmChatId, {
          kind: 'question', id: questionId, question, options: options || [], ts: Date.now(), expiresAt,
        });
      }
      // The question doubles as the fleet supervisor's attention_needed summary.
      // Phase 4 seed: question text + options (see awaitAnswer).
      const answer = await awaitAnswer(questionId, input.sessionId, question, stableStringify({ q: question, options: options || [] }));
      if (confirmChatId) void clearConfirmPending(confirmChatId);
      input.emit('ask_user_resolved', { questionId, answered: answer != null });
      return answer;
    },
    delegate: opts.allowSubagents
      ? async (role, task, title, todoId, dOpts) => {
          const prep = await prepareDelegation(role, task, title, todoId, dOpts);
          return typeof prep === 'string' ? prep : prep.execute();
        }
      : undefined,
    delegateBackground: opts.allowSubagents ? (specs, via) => startBackgroundDelegations(specs, via) : undefined,
    delegateStatus: opts.allowSubagents
      ? async (handle, waitSeconds) => {
          if (!bgPool) return 'No background workers were started in this run.';
          return bgPool.status(handle, Math.min(Math.max(0, waitSeconds) * 1000, backgroundStatusMaxWaitMs()));
        }
      : undefined,
  };

  const parts: MessagePart[] = [];
  // N10 (2026-09-25): tool-intent attribution SHADOW — one per run; observes
  // every dispatched call next to the regex detector, fire-and-forget, acts on
  // nothing (coding/tool-intent-gate.ts; inert under mode 'off' / the kill switch).
  const toolIntentShadow = createToolIntentShadow({ sessionId: input.sessionId, runId: input.runId });
  // Per-part wall-clock stamp (ISO): the transcript renders a hover timestamp
  // per text block (owner report 2026-08-31 — with only the message-level
  // stamp, a long run's blocks all looked simultaneous). Stamp at PUSH time:
  // stamping at finalize would give every block the run's end time.
  const stampPart = <T extends MessagePart>(p: T): T => ({ ...p, ts: new Date().toISOString() });
  // GUARD 4 full-fidelity haystack (review round-4 B-1) — see AgentRunResult.toolTexts.
  const toolTexts: string[] = [];
  // EVIDENCE LEDGER (ticket a84cc306) — the harness-maintained EVIDENCE LIST
  // for machine-triggered top-level runs (see chat-agent/evidence-ledger.ts).
  // Fed at the same point as the guard haystack; rendered into a transient
  // per-turn system note (clock-note idiom) so the citation copy source
  // machine-wake rule 6 demands is in front of the model at authorship time —
  // and survives the mid-run compaction that used to erase it. Lane-scoped
  // (ticket 5036d072): coding profiles get the receipt-family variant
  // (commit/pr anchors + claims-block wording), chat profiles the fleet-id
  // wake-note variant.
  const evidenceLedger = createEvidenceLedger({ lane: profile.kind === 'coding' ? 'coding' : 'chat' });
  let finalText = '';

  // Retrieval offload: explorer/web_researcher/architect gather full content that
  // the orchestrator (and delegate_parallel siblings) pull back via search_memory.
  // Items are stored LIVE as each tool result arrives (fire-and-forget; settled
  // before the worker returns) — mid-flight searchability, same write volume as
  // the old end-of-worker flush.
  const doOffload = !!opts.role && OFFLOAD_ROLES.has(opts.role);
  const offloadPending: Promise<number>[] = [];

  // GOAL/LOOP harness state (top-level agent only; subagents stay bounded + simple).
  const topLevel = opts.allowSubagents;
  // Whole-SESSION usage totals (all prior runs, every subagent) — loaded once so
  // every context emit can show durable numbers; this run is committed at the end.
  const priorSessionUsage: SessionUsage = topLevel && profile.workspaceTools
    ? await loadSessionUsage(input.sessionId).catch(() => emptySessionUsage())
    : emptySessionUsage();
  const sessionUsageView = () => mergeRunIntoSession(priorSessionUsage, usageAcc.snapshot());
  const digbyConfig = topLevel && profile.workspaceTools ? await readDigbyConfig(input.worktree) : null;
  // ── DIAGNOSTICS AFTER EDIT (harness roadmap item 1, owner 2026-09-19):
  //  every edit_file/write_file on this top-level coding run is noted; a
  //  debounced background pass runs the project's typecheck (tsc made
  //  incremental) + a file-scoped lint and the result lands as ONE
  //  [DIAGNOSTICS] note at the start of the next turn. Informational only —
  //  verify stays the check of record.
  const editDiagnostics = digbyConfig && topLevel && profile.workspaceTools
    ? new EditDiagnosticsTracker({
        worktree: input.worktree, execShell, config: digbyConfig, sessionId: input.sessionId, runId: input.runId, emit,
        onReport: (r) => recordLoopMetric({
          kind: LOOP_METRIC_KINDS.EDIT_DIAGNOSTICS,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          value: r.stages.reduce((n, st) => n + st.touchedLines.length, 0),
          meta: { files: r.files.length, stages: r.stages.map((st) => ({ key: st.key, exit: st.exitCode, touched: st.touchedLines.length, other: st.otherCount, skipped: st.skipped, ms: st.ms, ...(st.tail ? { tail: st.tail } : {}) })) },
        }),
      })
    : null;
  if (editDiagnostics) ctx.diagnostics = editDiagnostics;
  // Working-tree checkpoints (harness roadmap item 7): every write_file /
  // edit_file on a TOP-LEVEL coding run snapshots the prior content per step;
  // rewind_to_step restores.
  const editCheckpoints = topLevel && profile.workspaceTools
    ? new EditCheckpoints({ sessionId: input.sessionId, runId: input.runId })
    : null;
  if (editCheckpoints) ctx.checkpoints = editCheckpoints;
  const loopCfg = loopConfig(digbyConfig);
  let lastToolSig = '';
  let repeatCount = 0;
  // Near-identical (varying-args) loop signature (ticket 54a172ac): digit-runs
  // collapsed so a numbering loop (noop1, noop2, …) shares one signature. Trips
  // the same escalation ladder as the exact-signature breaker below at a higher
  // threshold (4 consecutive turns — reading 3 numbered files is legitimate).
  let lastNearSig = '';
  let nearRepeatCount = 0;
  // ── Wrong-tool derailment breaker (CanLaw session cec340f2, 2026-09-08) ──
  // kimi-k3 got decoder-locked emitting update_feedback with narration ids
  // ("BREAKING_NOW", "RUN_CMD_NEXT_CALL") while its own reasoning said "call
  // run_command" — 20 failed calls over 6h; the repeatCount text nudge never
  // fired (args differed each call) and text alone couldn't break the lock.
  // Mechanical breaker: 3 CONSECUTIVE failure-shaped results from the SAME
  // tool (run_command exempt — consecutive failing builds are normal
  // iteration) ⇒ that tool is WITHHELD from the schema for one model round,
  // forcing the decoder off the bad token path, with an in-band notice.
  let failStreakTool = '';
  let failStreakCount = 0;
  // Ticket 8579d419: the streak's FAILURE TEXTS are captured here, at counting
  // time — never re-derived from the message list at trip time. Tool-result
  // messages carry no tool-name field, so a trip-time scan of the last N
  // role:'tool' messages picks up ANY tool's results, including SUCCESSES
  // (the 2026-09-10 ticket filed with two successful get_chat_messages /
  // list_chats outputs mislabeled "Failure texts"). Newest first, capped at 3
  // (reflection.ts slices to 3 × 500/400 chars anyway; 1200 caps memory).
  let failStreakTexts: string[] = [];
  // DW-4 (568d3652/092382fd gap): the paired ARGS of the calls that produced
  // those texts, captured beside them at counting time (same 8579d419
  // discipline — never re-derived at trip time, where only the SUCCEEDED
  // calls' args survive in message parts). Cap 3 × 200 chars (args can carry
  // ids/paths — the cap bounds the exposure). (RSW-1 cluster 29, 2026-11-02:
  // the STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted — capture is
  // unconditional.)
  let failStreakArgs: string[] = [];
  let derailNoticeTexts: string[] = []; // snapshot of the tripping streak's texts, consumed by the deferred notice
  let derailNoticeArgs: string[] = []; // snapshot of the tripping streak's args — rides recentArgs (DW-4)
  let withheldTool: string | null = null;
  let withheldUntilStep = 0;
  let derailNoticeTool: string | null = null; // notice deferred past the batch (see the dispatch loop)
  // Which ladder produced the pending derail notice: the failure streak
  // ('failure' — the default, every pre-2c98b460 path) or the SUCCESS-side
  // wrong-tool tracker ('success_intent'). Shapes the notice wording (the
  // failure template's "ALL FAILED" is false for successful calls) and the
  // withhold metric's meta.shape. Reset to 'failure' with derailNoticeTool.
  // 'supervisor_only' (D5, 2026-09-27): a supervisor-only tool refused outside
  // a supervisor chat — deterministic, perma-withheld at the second refusal.
  let derailNoticeShape: 'failure' | 'success_intent' | 'supervisor_only' = 'failure';
  // Ticket c737d007: whether the tripping SUCCESS-side streak's NAMED intent
  // churned across the streak (pair-agnostic counting — see the tracker
  // below). Rides the trip and re-anchor guard_strike metrics as
  // meta.churned so the next shortfall cycle can measure the churn blind
  // spot's wild rate (churned:false trips are ones the legacy pair-keyed
  // ladder also caught). Reset with derailNoticeTool.
  let derailNoticeChurned = false;
  let reflectionConsults = 0; // cross-checker consults this run (owner doctrine 2026-09-10; cap in reflection.ts)
  // N8 (2026-09-25): the reflection_route decision awaiting its label — the
  // lane's NEXT tool call (or prose final) after a streak consult. Labelled at
  // the next completed model turn (labelReflectionRoute); a run that ends
  // before another turn leaves the decision row unpaired (never guessed).
  let pendingReflectionRoute: import('./reflection').ReflectionRoutePending | null = null;
  // ── F2 FRONTIER REFLECTION COUNCIL (coding/frontier-council.ts; owner 2026-10-06 late): repeated failures in a
  //    top-level run (a second streak trip, a trip after a troubled previous run, two red verifies, two evidence-guard
  //    reject-backs, two failed runs before this one) ⇒ a [REFLECT — REPEATED FAILURES] note at the next step, then the
  //    agent's own consult_frontier_council call (or the harness's after 2 ignored steps / at a failing stop). Every
  //    top-level loop — lanes, chat leads, supervisors, machine runs — never a worker, an anonymous chat or a human
  //    Quick-lane turn. FRONTIER_REFLECTION_COUNCIL_DISABLED=1 ⇒ null (today's Double-Checker consult). Never throws.
  let frontierCouncil: FrontierCouncilRun | null = null;
  if (topLevel && !opts.role && !input.fastSeat && !input.sessionId.startsWith('anon-')) {
    try {
      frontierCouncil = createFrontierCouncilRun({
        sessionId: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}), // GOAL-PRIORITY-SPEND: the council's spend rows name the run's goal
        ...(input.userId ? { userId: input.userId } : {}),
        runGoal: typeof input.userMessage === 'string' ? input.userMessage : '',
        machine: input.machineTriggered === true || !input.userTurnAt,
        emit,
        pushPart: (p) => { parts.push(stampPart(p as MessagePart)); },
      });
    } catch { frontierCouncil = null; }
  }
  const councilStepState = (s: { step: number; lastStep?: boolean }) => ({
    step: s.step, maxSteps: stepBudget, lastStep: s.lastStep, latestText: lastAssistantText(messages as any[]), receipts: receiptCollector,
  });
  // build 2026-10-08 F-1 — typed finish_run, SHADOW (./finish-run.ts): offered to top-level MACHINE runs of coding
  // lanes and supervisors; verified against receipts and recorded, never delivered. FINISH_RUN_DISABLED=1 ⇒ null.
  const finishRun: FinishRunSession | null = finishRunEligible({
    topLevel, role: opts.role ?? null, fastSeat: input.fastSeat, sessionId: input.sessionId,
    machineTriggered: input.machineTriggered, ownerDispatch: input.ownerDispatch,
    profileKind: profile.kind, supervisorTools: profile.supervisorTools,
  }) ? new FinishRunSession(input.sessionId) : null; // build 2026-10-09 FR-3: the chat id names a supervisor's own state save
  // build 2026-10-11 FA-3: this chat's earlier receipts (≤ 24 h) — ONE read per run, shared by the in-loop check and the finalize.
  const finishRunSessionReceipts = async () => (input.evidenceGuardRejectBack?.carriedReceipts?.length
    ? input.evidenceGuardRejectBack.carriedReceipts
    : (typeof getRecentChatReceipts === 'function' ? await getRecentChatReceipts(input.sessionId) : []));
  let finishRunLastTools: any[] | undefined; // the last tool list a model turn was sent (the nudge reuses it — prompt-cache friendly)
  // Escalation (watch pass #5, 2026-09-08: ~52 derail episodes/hour across the
  // RL lanes — the one-round ban breaks each episode but the decoder re-locks
  // minutes later). A tool that trips the breaker TWICE in one run is withheld
  // for the REST OF THE RUN. A legitimately-used tool cannot get here: any
  // success resets the streak, so two trips means six failure-shaped results
  // with no success in between — always a lock, never real work.
  const derailTripCounts = new Map<string, number>();
  const permaWithheld = new Set<string>();
  // Identical-call loop breaker escalation (autonomy loop #9, 2026-09-20): the
  // one-round withhold fired 23× on one kimi-k3 lane in 26 min (update_document)
  // and 20× on another in 47 min (update_feedback) — a decoder-locked model
  // resumes the identical call the moment the tool returns. Trip 1: one round;
  // trip 2: three rounds; trip 3 on the same tool: gone for the rest of the run
  // (every OTHER tool stays; the notice names the result it already holds).
  const repeatTripCounts = new Map<string, number>();
  // Per-run volume counter for create-class fleet tools (ticket 54a172ac —
  // see loopVolumeCap): counts calls that would actually execute; past the
  // cap the call is refused pre-execution and the tool is perma-withheld.
  const toolRunCounts = new Map<string, number>();
  // roster 2026-10-06 C-4: the Quick lane's web-tool budget (./web-tool-cap.ts) — top-level run only.
  const webCapState: WebToolCapState | null = input.webToolCaps ? newWebToolCapState() : null;
  // D5 (2026-09-27, tool-scope.ts): per-tool count of supervisor-only
  // refusals this run — the executor's `reason:"supervisor_only"` envelope or
  // the not-offered pre-flight refusal of a supervisor-only tool this profile
  // never carries. Deterministic failures: perma-withheld at
  // supervisorOnlyPermaAfter() (default 2) instead of the generic 3+3 ladder.
  const supervisorOnlyRefusals = new Map<string, number>();
  let derailNoticePerma = false;
  // Pre-flight fast trip (2026-09-09, ./tool-preflight): an UNGROUNDED entity id
  // (a narration token where an id belongs — "noop", "BREAKING_NOW") counts as
  // TWO failures and an INTENT MISMATCH (the turn's reasoning names a different
  // offered tool and never this one) as one more — so the incident shape
  // (both signals) trips the breaker on the FIRST call, not the third, and the
  // notice can name the tool the model evidently meant.
  let derailIntendedTool: string | null = null;
  // ── SUCCESS-side wrong-tool tracker (ticket 2c98b460, 2026-09-22) ──────
  // Every ladder in this block needs a signal a derailed lane never produces
  // when its calls SUCCEED: the failure streak needs failure-shaped results
  // (:3472), the identical/near-identical call break needs a repeated
  // (digit-collapsed) signature (:3726-3740 — an update_plan ×27 loop varies
  // the plan every call), the 03587322 repeated-line break never sees tool
  // calls, and the 431518a2 re-anchor arms only off refusals/failures. The
  // cluster-3 shape had NO containment below the :1964 nudge — e083ff2e
  // update_plan ×27 intending get_chat_messages; 10cb988f firing 106; CanLaw
  // c510c56f todo_create ×64 + update_plan ×137 (run-executor.ts:2054).
  // Track CONSECUTIVE successful calls of ONE tool while the turn's own
  // reasoning+narration convicts a DIFFERENT offered tool
  // (detectIntendedTool): the THIRD arms the one-per-run re-anchor (reason
  // 'intent_mismatch_success' — the flush threads the marker and says "it
  // SUCCEEDED", never the false "and it failed"), the FIFTH trips
  // into the EXISTING withhold → perma → run-end ladder (derailTripCounts).
  // An aligned success resets the streak; a failure-shaped result leaves it
  // untouched (the failure ladder owns that result); run_command stays
  // exempt (generic workhorse).
  // Ticket c737d007 (2026-09-22, pair-agnostic re-key): the streak key is
  // the CALLED tool alone — the 2c98b460 key was the called→intended PAIR,
  // so a decoder-locked lane whose NAMED intent churned turn-to-turn reset
  // its own count every turn and burned to GOAL-CONTINUE exhaustion (the
  // pre-2c98b460 hole one level up; word-level args churn defeats the
  // identical/near-identical repeat legs the same way, and this tracker
  // never read args). The named intent is a confabulated rationalization —
  // the derail signal is the lock on ONE wrong tool. intentMissChurned
  // records whether the streak's named intent rotated (telemetry:
  // meta.churned on the trip/re-anchor guard_strike — churned:false = the
  // legacy pair-keyed ladder would have caught it too, churned:true = a
  // blind-spot catch). RESIDUAL (accepted): a same-tool success loop whose
  // narration convicts NOTHING (names the called tool, or nothing offered)
  // still accumulates no counter anywhere — counting bare same-tool
  // successes would convict legitimate sequential work (ticket triage,
  // numbered reads). The volume cap owns create-class, the near-leg owns
  // digit churn; meta.churned measures the rest before thresholds move.
  let intentMissTool = '';
  let intentMissCount = 0;
  let intentMissLastNamed = '';  // the previous mismatch's named intent (churn detection)
  let intentMissChurned = false; // the named intent rotated within this streak
  // DW-4 (568d3652 gap): the ARGS of the counted misses, newest first, cap 3 —
  // a STREAK-OWNED accumulator (never the live derailNoticeArgs slot: a
  // pending deferred notice from the failure ladder must survive this
  // ladder's counting untouched — the 092382fd corruption class). Moved into
  // derailNoticeArgs at trip time, cleared at every streak reset. (The
  // STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted with RSW-1 cluster
  // 29 — capture is unconditional.)
  let intentMissArgs: string[] = [];
  // Ticket 0625bf62 (2026-09-24) — the 58e675c9 measurement cycle ARMED the
  // discount: 9/9 guard_miss rows on the canlegal-bench supervisor (chat
  // 615723ba, 2026-09-24T04:14Z) were preamble_ordered on archive_chat while
  // the run's own outcome was CORRECT (43 archive receipts — the owner retire
  // doctrine executed; 0 genuine derailments in the measured class), so an
  // ordered/pre-computed mismatch on a PLATFORM tool is now treated as
  // ALIGNED (streak reset; count-up/steer/trip skipped). PLATFORM-TOOL
  // SCOPE is the merge-safety line: the same fleet-wide measurement shows the
  // haystack matching GENERIC CODING DOCTRINE (the system prompt's own "call
  // update_plan …" line produced a preamble_ordered row on e083ff2e — the
  // founding 2c98b460 lane), so arming for coding tools would reopen the
  // exact update_plan/read_file derail cluster this guard was built to
  // contain. Runaway create-class platform batches keep their own owner (the
  // 54a172ac volume cap). The guard_miss measurement rows continue UNCHANGED
  // (all tools, armed or not), so the residual conviction volume stays
  // measurable; intentMissLog* is the measurement-shadow streak (classic
  // pre-0625bf62 counting, never reset by the discount) that feeds the row's
  // `streak` field so post-arming telemetry stays comparable with the
  // pre-arming baseline.
  let intentMissLogTool = '';
  let intentMissLogCount = 0;
  // Ticket f6217896 (2026-09-24): BATCH-SIBLING acquittal — a narration that
  // itemizes a MULTI-TOOL batch ("Let me batch: - grep … - read … - read …
  // Let me do the greps and reads in parallel.") convicts every faithful
  // sibling read_file of "intending" grep (the checklist is one final
  // sentence — filename dots never split it), while the batch ITSELF emitted
  // the grep call: the mention is consumed by its own sibling, exactly like
  // the model-facing rename alias (7b2a0969) and the prose self-naming. The
  // wild instance (session b92ef13f, run f7667bd2, explorer subagent, glm-5.3)
  // tripped at 5 with EVERY row reason 'preamble_ordered' on a batch that
  // executed its own checklist item-for-item — faithful work, auto-filed as a
  // derailment. Scope is the SAME DISPATCHED BATCH ONLY (dispatchCalls):
  // cross-batch emission does NOT acquit — the ee39f231 pin's grep-emitting
  // precursor turn precedes its read_file mismatches and the steer STILL
  // fires there (decoder-lock containment unchanged). The measurement-shadow
  // streak (intentMissLog*) keeps classic counting so the acquittal volume
  // stays comparable.
  let batchSiblingAcquittals = 0;
  // 0625bf62 runaway backstop: the discount is bounded PER TOOL PER RUN. The
  // platform-tool scope hands archive_chat/move_chat/rename_chat batches to
  // the discount, and — unlike todo_create/goal_create (the 54a172ac volume
  // cap) — those mutating tools have NO other runaway owner, so an unbounded
  // discount would leave a decoder-locked archive loop uncontained to
  // maxSteps. Past the discountArmCap() ceiling (DERAIL_INTENT_DISCOUNT_CAP,
  // default 25) of discounted mismatches on ONE tool the
  // classic count/steer/trip returns for that tool. 25 mirrors
  // LOOP_VOLUME_CAP_DEFAULT; the measured incident class (9) sits far below it.
  const intentDiscountApplied = new Map<string, number>();

  // ── Measure-first intent-discount probe (ticket 58e675c9, 2026-09-22) ──
  // The 2c98b460 guard above keys on detectIntendedTool's whole-word mention
  // counting, which cannot tell a narration that names a PRE-COMPUTED duty
  // (the supervisor wake's [FLEET LIVENESS] block already carries the
  // get_chat_status answer set) or a batch ORDERED by the schedule preamble
  // (wild instance 92b485bd: schedule_get ×5, all ordered + succeeded, still
  // steered/tripped). The ticket's proposal: MEASURE FIRST — log each
  // success-side mismatch the proposed discounts WOULD absorb as a
  // guard_miss row (seam 'tool_intent_attribution'), and change NOTHING
  // about the streak/steer/trip for one measurement cycle. The wake text is
  // computed once (the standing orders sit at the conversation head; the
  // haystack builder excludes tool results and the harness's own notices).
  // Bounded per run (RSW-1: the log kill switch was deleted 2026-11-02).
  // 0625bf62 (2026-09-24): the measurement cycle ANSWERED (9/9
  // discountable, 0 genuine — see the 2c98b460 block above), so the discount
  // is now APPLIED for platform tools in the success-side leg below; these
  // two vars now feed BOTH the armed application and the measurement row.
  let intentDiscountLogs = 0;
  let wakeOrders: string | null = null;
  let wakeOrdersNoSystem: string | null = null; // audit 2026-10-06 T1-9: the measurement haystack (no system prompt)
  // ── Auto re-anchor steer (ticket 431518a2, 2026-09-20) ──────────────────
  // Mid-run early-steer for the wrong-tool derail class. Firing-start
  // tool-discipline preambles demonstrably DECAY mid-run (tt-rd F83 pre-fix;
  // CanLaw cec340f2 + e083ff2e ~45 min AFTER the 8f4c4464 conformance fix
  // went fleet-live), so the FIRST derail-class signature in a run injects
  // ONE re-anchoring steer — naming the tool the model evidently meant and
  // restating the session's ACTUAL offered toolset — long BEFORE the breaker
  // would have to terminate the run. Bounded: exactly ONE per run
  // (reAnchorUsed); every later occurrence flows through the unchanged
  // breaker path below (withhold → perma → terminal — never a re-anchor
  // loop). TRIGGER (the derail detector's own signals, nothing else):
  //   (a) tool_not_offered preflight refusal for a GENUINELY nonexistent name
  //       (hint === undefined — NOT the breaker-withheld sub-case, which the
  //       breaker's own notice already covers, and NOT the account-not-
  //       loaded progressive-disclosure nudge); or
  //   (b) an intended-vs-emitted mismatch — detectIntendedTool names a
  //       DIFFERENT offered tool on a failure-shaped result (the same signal
  //       that sets derailIntendedTool); or
  //   (c) a placeholder-emission STREAK — the SECOND invented-id signal in
  //       the run (nightly-lane consolidated finding 2026-09-20:
  //       update_document 'noop'/'none', update_feedback 'nonexistent'
  //       streaks recur post-8f4c4464 with the same mid-run decay shape and
  //       the same terminal outcome as wrong-tool substitution). Two
  //       deterministic sources, SAME grounding rule (tool-preflight):
  //       ungrounded-id preflight refusals on platform tools, and — because
  //       document-seam tools EXECUTE (they are not platform-preflighted) —
  //       failure-shaped update_document/read_document/fill_pdf_form results
  //       whose id args fail the grounding check. The FIRST bare invented-id
  //       call is ordinary working containment (the 0c0ce759 close) and
  //       never triggers; the repeat proves the refusal envelope is not
  //       recovering the model.
  // Ordinary failures with faithful narration never trigger.
  // (RSW-1: the DERAIL_REANCHOR kill switch was deleted 2026-11-02.)
  let reAnchorUsed = false;
  let reAnchorPending: {
    tool: string;
    intended: string | null;
    reason: 'tool_not_offered' | 'intent_mismatch' | 'intent_mismatch_success' | 'placeholder_streak';
    badIds?: string[];  // leg (c): the invented id values from the refusal
    count?: number;     // leg (c): invented-id signal tally at detection time
    churned?: boolean;  // success leg (c737d007): the streak's named intent rotated
  } | null = null;
  let inventedIdSignals = 0; // run-level tally feeding leg (c)'s streak signature
  const platformToolNames = new Set<string>(PLATFORM_TOOL_NAMES);
  // audit 2026-10-06 T5-7: coding-lane tool names (the coding schema minus the
  // platform tools) that THIS run does not carry at all — on a chat /
  // supervisor profile a by-name call to one answers "lane-only" at once.
  // Empty on a coding profile (the lane carries them) and under
  // LANE_ONLY_TOOL_HINT_DISABLED=1.
  const laneOnlyAbsent: Set<string> = (() => {
    if (profile.kind === 'coding' || laneOnlyToolHintDisabled()) return new Set<string>();
    const carried = new Set<string>(tools.map((t: any) => t?.function?.name as string).filter(Boolean));
    return new Set<string>(CODING_TOOL_SCHEMA.map((t: any) => t?.function?.name as string)
      .filter((n) => !!n && !platformToolNames.has(n) && !carried.has(n)));
  })();
  // Progressive disclosure: coding-lane orchestrators start WITHOUT the account
  // tools (LOAD_TOOL_GROUP_SCHEMA loads them on request). Chat lanes and role
  // workers are untouched (workers never had them; chat built them).
  let accountToolsLoaded = profile.kind !== 'coding';
  // Triage tools (list_feedback + update_feedback) ride the same on-demand path
  // in coding sessions: visible from the start ONLY when this run's own prompt
  // material works the feedback queue (a ticket-dispatch brief, or an explicit
  // mention), else hidden until load_tool_group({group:"triage"}). Chat and
  // supervisor lanes are unchanged. tool-scope.ts has the prod evidence.
  let triageToolsLoaded = profile.kind !== 'coding' || triageToolsAlwaysVisible() || runMentionsTicketWork(input);
  let autoVerifyIters = 0;
  let autoContinueRounds = 0;      // GOAL-CONTINUE: bounded resumes while the plan has unfinished steps
  let lastPlanSig = '';            // progress guard: full plan signature (statuses+text) at the last continue
  let lastContinueDiffHash = '';   // progress guard: worktree state at the last continue
  let continueStalls = 0;          // consecutive no-progress continue rounds (tolerate a couple)
  let selfAudited = false;         // one-time "are you SURE it's done?" audit before a clean auto finish
  // WI-C (2026-09-25): the self_audit decision stash + the steps completed
  // when the audit round was granted — labelled once the round has run
  // (flushSelfAuditLabel: reopened a completed step ⇒ unevidenced = true).
  // E5 (honest labels, 2026-09-25): the label is a COMPOSITE of three
  // harness-observable deltas measured from the audit grant to the end of the
  // round — reopened step OR evidence-guard strike on the final OR reject-back
  // (labelSelfAuditOutcome; the reopen-only label had 0/9 prod agreement).
  // guardPartsBefore / rejectBacksBefore snapshot the loop's own counters at
  // the grant so no strike site needs touching.
  // Self-audit churn containment (tt-rd audit 2026-09-27): `control` marks a
  // receipt-rule CONTROL round (act mode, 1-in-10 sample — the rule would
  // have skipped it); `receiptRule` is the rule's verdict at the grant, so the
  // post-round label can write the self_audit_control row (reopened ⇔ the
  // rule was WRONG to want a skip). A control label never needs a Jev stash.
  // Fixer 2026-09-27 (finding 5): a non-null `receiptRule` on a round that RAN
  // outside the control sample writes the self_audit_shadow label row — the
  // shadow readout used to have NO outcome (a label existed only when Jev
  // happened to return a stash, 7.5 % of rounds).
  let pendingSelfAuditLabel: { stash: SelfAuditGateDecision['stash']; completedBefore: string[]; rejectBacksBefore: number; guardPartsBefore: number; roundId: string; control?: boolean; receiptRule?: ReceiptRuleVerdict | null; receiptRuleMode?: 'shadow' | 'act' } | null = null;
  // Guard-struck / guard-marker parts in the transcript so far (a struck final,
  // a reject-back or zero-tool discard marker) — the loop's own strike ledger.
  const countGuardParts = (): number => parts.reduce((n, p) => n + ((p as { marker?: string; struck?: boolean }).marker === 'guard' || (p as { struck?: boolean }).struck ? 1 : 0), 0);
  const flushSelfAuditLabel = async (): Promise<void> => {
    if (!pendingSelfAuditLabel) return;
    const label = pendingSelfAuditLabel;
    pendingSelfAuditLabel = null;
    if (!label.stash && !label.control && !label.receiptRule) return;
    try {
      const planAfter = await getPlan(input.sessionId).catch(() => null);
      const reopened = planAfter ? selfAuditReopened(label.completedBefore, planAfter.steps) : null;
      const rejectBacksAfter = Math.max(0, guardRejectBacks - label.rejectBacksBefore);
      const guardStrikesAfter = Math.max(0, countGuardParts() - label.guardPartsBefore);
      if (label.control) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SELF_AUDIT_CONTROL,
          sessionId: input.sessionId, runId: input.runId,
          stamp: { ...metricStamp, selfAuditRoundId: label.roundId },
          meta: { reopened, steps: label.receiptRule?.steps ?? label.completedBefore.length, receipted: label.receiptRule?.receipted ?? null, rejectBacksAfter },
        });
        void checkReceiptRuleDemotion().catch(() => null);
      } else if (label.receiptRule) {
        // Fixer 2026-09-27 (finding 5): the SHADOW readout — every evaluated
        // round that ran gets the same harness label the control sample gets
        // (reopened ⇔ the rule would have been WRONG to skip). The promotion
        // readout reads these; sampled 1-in-10 by round id so the query never
        // rides every finish.
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SELF_AUDIT_SHADOW,
          sessionId: input.sessionId, runId: input.runId,
          stamp: { ...metricStamp, selfAuditRoundId: label.roundId },
          meta: { wouldSkip: label.receiptRule.skip, mode: label.receiptRuleMode ?? 'shadow', reopened, steps: label.receiptRule.steps, receipted: label.receiptRule.receipted, reasons: label.receiptRule.reasons, rejectBacksAfter, guardStrikesAfter },
        });
        if (selfAuditControlSample(label.roundId, input.sessionId)) void checkReceiptRulePromotion().catch(() => null);
      }
      if (!label.stash) return;
      const verdict = labelSelfAuditOutcome({
        reopened,
        rejectBacksAfter,
        guardStrikesAfter,
        completedBefore: label.completedBefore.length,
      });
      recordSelfAuditOutcome(label.stash, verdict.actual, input.sessionId, verdict.note);
      // E8: the v2 fan-out's per-question rows (claims/steps nouls + one per reviewed step); a v1 stash records none.
      // The composite (E5) verdict is the holistic truth the per-question rows pair against.
      recordSelfAuditStepOutcomes(label.stash, label.completedBefore, planAfter?.steps ?? null, input.sessionId, verdict.actual);
    } catch { /* labels never break the run */ }
  };
  // E5 cost stamp: the self_audit decision whose round this run granted — the
  // run's run_spend row carries it so the audit's shed cost is joinable.
  let selfAuditDecisionId: string | undefined;
  // Harness-minted self-audit ROUND id (tt-rd audit 2026-09-27 finding 6): set
  // whenever a round is granted OR skipped, stamped on self_audit_run /
  // self_audit_skip / self_audit_control AND the run's run_spend row — the E5
  // decision id joined only 7.5 % of rounds (it exists only when Jev returned
  // a stash); this id joins every one.
  let selfAuditRoundId: string | undefined;
  let truncationRecovered = false; // ONE retry of an answer-less turn whose budget went to thinking (turn-recovery.ts)
  // efdb3d31: ONE re-emit of a tool-calling turn whose payload STOPS
  // MID-STRUCTURE — the gate is structural, NOT sentinel-keyed (see
  // severed-stream.ts; `streamCompleted` is only a discriminator over which
  // transport story to tell). Narrow by construction: `undefined` (a provider
  // that never sends the sentinel, or a synthesized turn) never fires this lane,
  // so the C-2 dispatch-reject-repair path keeps sole ownership of the
  // ambiguous case. A COMPLETE payload never re-emits no matter what the
  // transport did, so the sentinel-less-provider no-op survives.
  let severedStreamRecovered = false;
  // efdb3d31 (2026-10-30): the argLens the RE-EMITTED turn produced, so a reject
  // row's `rl` answers "did the re-request reproduce the SAME cut?" without a
  // cross-row join against the severed_stream_recovery row.
  //
  // ticket 192d9087 F2 (2026-10-30): this is now a ONE-TURN CARRY, not a sticky
  // variable. It used to be assigned only inside the re-emit branch and never
  // cleared, and `ctx.severedRecovered` was copied from the per-run bound on
  // every turn — so `re:1`/`rl` on a late turn described an EARLIER turn's
  // re-emit, and no stored field enforced the reading rule the family's handoff
  // had to carry by hand. `noteReemit` fills it for exactly the retry the branch
  // just bought; `beginTurn` consumes and clears it at the next turn's start.
  const severedReemitCarry: ReemitTurnCarry = {};
  let modelErrored = false;        // the model API rejected the request and we gave up — NOT a clean finish
  let modelErrorStatus: number | undefined;   // HTTP status of the killing turn (surfaced on AgentRunResult, cff523e7)
  let modelErrorKind: ModelErrorKind | undefined; // which recovery class gave up
  let modelErrorRecoveries = 0;    // bounded compact-and-retry attempts (reset after any good turn)
  const MAX_MODEL_ERROR_RECOVERIES = 2;
  // Helper-SEAT health fallback (owner 2026-09-14): set ONCE when a helper-tier
  // worker on a custom coding_helper endpoint is moved to the built-in helper
  // mid-run — one fallback per loop, never a second hop (helper-seat.ts).
  let helperSeatFallback: HelperSeatFallback | undefined;
  // ── MAIN-SEAT transient failover state (ticket fe6f0b0b, 2026-09-17): the
  //  coding run's own seat (NOT the helper tier) fails over to a second source
  //  when the transient backoff budget is spent — see the lane at the give-up
  //  below. `seatModelSpec` tracks the spec the run is CURRENTLY on (input.model
  //  until a failover latches); the tried-set bounds the chain (each candidate
  //  once per run); codingSeatFallback rides the run result for attribution. ──
  let seatModelSpec: string = input.model;
  let codingSeatFallback: HelperSeatFallback | undefined;
  const codingSeatFailoverTried = new Set<string>();
  let leadSeatFallback: HelperSeatFallback | undefined; // lead seat moved off an unreachable custom endpoint (once per run)
  // ── PROVIDER COOLDOWN pre-seat (autonomy loop #3, 2026-09-19): the chosen
  //  seat's provider tripped the process-local breaker (provider-cooldown.ts —
  //  THRESHOLD 429/5xx inside the window; Z.AI 2026-09-19 00:00–03:10Z: 210
  //  rejected glm-5.3 turns across 16 sessions, one wasted round trip per step
  //  because the revert path re-probed the chosen seat every step). Start THIS
  //  run on the lead fallback seat instead of paying the rejection first; the
  //  primary is probed again on the first step after the cooldown lapses (the
  //  revert branch below). Never the helper tier; honours the seat-fallback
  //  kill switches; the provider breaker is unconditional (its
  //  PROVIDER_COOLDOWN_DISABLED kill switch was deleted with RSW-1 cluster 29). ──
  let cooldownNoticeUntil = 0;
  // The seat this run is on (2026-09-27): names whose ADMIN CUSTOM FALLBACK the
  // lead lanes consult and the role seat_fallback rows are filed under.
  // The seat key a fallback row names: `AgentRunInput.seatRole` is the seat
  // the caller resolved (a chat lane's lead seat) or the coding default —
  // always a real model-roles seat key, typed as one on the fallback row.
  const seatRoleRaw = (input.seatRole && input.seatRole.trim()) || LEAD_SEAT_ROLE;
  const seatRoleKey = seatRoleRaw as ModelRoleKey;
  if (!input.fastSeat && !leadSeatFallbackDisabled()) {
    const cd = providerCooldownUntil(provider.label);
    if (cd) {
      const fb = await pickLeadFallback(input.model, provider.model, input.userId, seatRoleRaw).catch(() => null);
      if (fb) {
        cooldownNoticeUntil = cd;
        const failedLabel = provider.label;
        const failedSpec = seatModelSpec;
        const untilClock = new Date(cd).toISOString().slice(11, 19) + 'Z';
        leadSeatFallback = { role: seatRoleKey, from: failedSpec, fromLabel: failedLabel, to: fb.model, reason: 'HTTP 429', httpStatus: 429, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
        agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${failedSpec}) is cooling down after repeated rejections (until ${untilClock}) — starting this run on ${fb.model}`);
        emit('progress', { message: `Coding seat ${failedLabel} is rate-limited — starting on ${fb.model}; ${failedLabel} is retried after ${untilClock}`, stage: 'seat-fallback' });
        noteSeatFallback({ role: seatRoleKey, from: failedSpec, to: fb.model, reason: 'HTTP 429 (provider cooldown)', status: 'retrying', caller: 'lead', httpStatus: 429, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
        parts.push(stampPart({ type: 'text', text: `⚠︎ SEAT FAILOVER: the model ${failedLabel} (${failedSpec}) is rate-limited (its provider is cooling down) — this run starts on ${fb.model}${fb.custom ? " (the admin's custom fallback)" : ''}; ${failedLabel} is retried once the cooldown lapses.` }));
        applyRunProviderExtras(fb.provider);
        primaryContextBudget = contextBudget; primarySeatSpec = seatModelSpec;
        provider = fb.provider;
        seatModelSpec = fb.model;
        contextBudget = fb.provider.contextChars ?? profile.contextCharBudget;
        leadFallbackState = 'active';
      }
    }
  }
  // ── INVALID-REQUEST LATCH pre-seat (2026-09-27, the gpt-6-astra incident):
  //  the chosen seat is a CUSTOM endpoint that a deterministic 400/404/413/422
  //  (tools over the model's cap, reasoning_effort refused with tools, tools
  //  unsupported, unknown param, model not found, context too long) knocked
  //  out inside the last SEAT_INVALID_REQUEST_LATCH_MIN minutes — this process
  //  does not pay the rejection again: the run STARTS and STAYS on the seat's
  //  custom fallback / the built-in order (sticky — the primary is not probed
  //  per step; the latch expiry re-admits it on a later run). Honest surfaces:
  //  progress event + transcript note + seat_fallback row (meta.latchedUntil).
  //  Also honours the lead-seat fallback switch. ──
  if (!input.fastSeat && !leadSeatFallbackDisabled() && leadFallbackState === 'none' && isCustomEndpointProvider(provider)) {
    const latch = seatInvalidRequestLatch(seatModelSpec);
    if (latch) {
      const fb = await pickLeadFallback(input.model, provider.model, input.userId, seatRoleRaw).catch(() => null);
      const untilIso = new Date(latch.until).toISOString();
      const untilClock = untilIso.slice(11, 19) + 'Z';
      if (fb) {
        const failedLabel = provider.label;
        const failedSpec = seatModelSpec;
        leadSeatFallback = { role: seatRoleKey, from: failedSpec, fromLabel: failedLabel, to: fb.model, reason: `invalid_request:${latch.kind} (latched)`, httpStatus: latch.status, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
        agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${failedSpec}) is latched off (${latch.reason}; until ${untilClock}) — running this run on ${fb.model}`);
        emit('progress', { message: `Seat ${failedLabel} is unusable (${INVALID_REQUEST_KIND_LABELS[latch.kind]}) — this run uses ${fb.model}; ${failedLabel} is retried after ${untilClock}`, stage: 'seat-fallback' });
        noteSeatFallback({ role: seatRoleKey, from: failedSpec, to: fb.model, reason: `invalid_request:${latch.kind} (latched) — ${latch.reason}`.slice(0, 200), status: 'retrying', caller: 'lead', httpStatus: latch.status, fingerprint: latch.kind, latchedUntil: untilIso, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
        parts.push(stampPart({ type: 'text', text: `⚠︎ SEAT FAILOVER: the model ${failedLabel} (${failedSpec}) is unusable — ${latch.reason} — so this run uses ${fb.model}${fb.custom ? " (the admin's custom fallback)" : ''}; ${failedLabel} is retried after ${untilClock}.` }));
        applyRunProviderExtras(fb.provider);
        provider = fb.provider;
        primaryProvider = fb.provider; // sticky for the run — a deterministic rejection does not lapse mid-run
        seatModelSpec = fb.model;
        contextBudget = profile.kind === 'coding'
          ? (fb.provider.contextChars ?? profile.contextCharBudget)
          : Math.min(profile.contextCharBudget, fb.provider.contextChars ?? Number.POSITIVE_INFINITY);
        leadFallbackState = 'none';
      } else {
        emit('progress', { message: `Seat ${provider.label} was rejected deterministically (${INVALID_REQUEST_KIND_LABELS[latch.kind]}) and no fallback is servable here — trying it anyway`, stage: 'seat-fallback' });
      }
    }
  }
  // ── 2026-09-27 seat/provider limits — per-run state. ──
  // tool_list_trimmed rows: ONE per (run, provider model) — the trim repeats every
  // turn but the telemetry names it once.
  const trimTelemetered = new Set<string>();
  // The last trim applied (rides the run result as `toolsTrimmed`).
  let toolsTrimmed: { from: number; to: number; dropped: string[] } | undefined;
  // ── Progressive tool disclosure (2026-09-27, tool-groups.ts) — ONE session
  //    per run, created on the first turn where a provider cap binds (or under
  //    TOOL_GROUPS_ALWAYS=1); loaded-group state persists across steps; the
  //    live-run status line repeats only when the loaded set changes. ──
  let toolGroups: ToolGroupSession | null = null;
  let toolGroupsStatusLast = '';
  const toolGroupsStatus = () => {
    if (!toolGroups) return;
    const line = toolGroupsProgressLine(toolGroups);
    if (line === toolGroupsStatusLast) return;
    toolGroupsStatusLast = line;
    emit('progress', { message: line, stage: 'tool-groups' });
  };
  // Bounded in-run retries per deterministic fingerprint (a learned tool cap
  // gets ONE trimmed re-send on the same seat; the reasoning_effort:'none'
  // retry lives inside runModelTurn) — never a loop.
  const invalidRequestRetries: Record<string, number> = {};
  // audit 2026-10-08 W2-4: provider content-filter rejections this run (the first fails over; a second ends the run).
  let contentFilterHits = 0;
  // Transient failures (429 rate limit, 5xx, connection resets) get their OWN
  // budget: they need TIME (backoff), not a mutated/compacted request — a 429
  // is not a size problem, and compacting burns the rate budget while changing
  // nothing (ticket 1e465443: 429s exhausted 2 compact-retries at ~291k/800k
  // budget). Longer real backoffs ride out a per-minute rate window (ticket
  // 039dceb8: 10 overnight runs died inside the old 2×5s budget).
  let transientRecoveries = 0;     // bounded backoff-and-retry attempts (reset after any good turn)
  // Ticket cffaa701 (2026-09-14): the transient budget is TABLE-DRIVEN — one
  // attempt per table entry. Unattended runs (machine-triggered or helper
  // fast-seat) default to the 5-entry table that reaches into minutes: the
  // 3×≤100s budget died inside EVERY glm-5.3 rate window that afternoon (six
  // canlegal-bench worker deaths in ~1.5h, a second project hit the same
  // window). Interactive runs keep the 3-entry table. AGENT_TRANSIENT_BACKOFF_MS
  // ("ms,ms,…") overrides EVERY class exactly (the retry-lane suites set
  // "1,1,1" so backoff-lane tests run in milliseconds — production should
  // never set it); AGENT_TRANSIENT_BACKOFF_MACHINE_MS overrides only the
  // unattended default. Env-set tables never jitter.
  // Owner-dispatch (2026-10-01): a user-classified run nobody watches live is
  // unattended too — it rides the long table like a machine run.
  const unattendedRun = input.machineTriggered === true || input.ownerDispatch === true || input.fastSeat === true || input.workerUnattended === true;
  const TRANSIENT_BACKOFF = (() => {
    const general = parseBackoffTableEnv(process.env.AGENT_TRANSIENT_BACKOFF_MS);
    if (general.length) return { tableMs: general, jitter: false };
    if (unattendedRun) {
      const machine = parseBackoffTableEnv(process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS);
      if (machine.length) return { tableMs: machine, jitter: false };
      return { tableMs: TRANSIENT_BACKOFF_MACHINE_DEFAULT_MS, jitter: true };
    }
    return { tableMs: TRANSIENT_BACKOFF_USER_DEFAULT_MS, jitter: true };
  })();
  const MAX_TRANSIENT_RECOVERIES = TRANSIENT_BACKOFF.tableMs.length; // budget = table length (3 user / 5 unattended by default)
  const RETRY_AFTER_CAP_MS = (() => {
    const n = parseInt(process.env.AGENT_TRANSIENT_RETRY_AFTER_CAP_MS || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : TRANSIENT_RETRY_AFTER_CAP_DEFAULT_MS;
  })();
  const MAX_TOTAL_RECOVERIES = MAX_MODEL_ERROR_RECOVERIES + MAX_TRANSIENT_RECOVERIES; // interleaved-failure ceiling
  let repetitionRetries = 0;       // bounded nudge-and-retry when the model loops on itself
  const MAX_REPETITION_RETRIES = 2;
  let guardRejectBacks = 0;      // evidence-guard reject-back rounds used (ticket dc04deea) — per-attempt budget, no checkpoint persistence (a resumed run gets one fresh round; attempts themselves are capped)
  let intermediateOffloads = 0;  // P4 CanLaw L4: receipt-citing mid-run deliverables offloaded to session memory (≤5/run)
  let reasoningReplayNoted = false; // build 2026-10-08 Q-2: one reasoning_replay row per run (gateway Kimi family)
  // ── ZERO-TOOL PRE-FINAL GATE state (kernel-opt lane b95e9df6, incident #13:
  // a machine wake produced a COMPLETE fabricated audit in ~2 min with zero
  // tool calls — pure prompt pattern-completion; the reactive evidence guard
  // caught it only POST-generation). Deterministic, O(1), machine runs only:
  // a machine-triggered run may not finalize with ZERO executed tool calls —
  // every machine-wake protocol mandates fresh probes, so a zero-tool machine
  // answer is wrong by construction. One nudge per attempt (guardRejectBacks
  // idiom: not checkpoint-persisted; attempts themselves are capped). ──
  // EVIDENCE-bearing tool calls THIS run: dispatched calls this attempt + (on
  // resume) the prior attempts' calls replayed into the transcript. Fresh-run
  // histories carry only user/assistant rows (coding transcripts + chat
  // conversationHistory), so the tally is exactly this durable run's work.
  // Owner transcript 2026-09-08 (a8976e11 firing-87): the tally used to count
  // EVERY dispatched tool — update_plan / search_memory / search_code_semantic
  // / ask_user included, though the guard has always treated those as
  // evidencing nothing — so a machine run that opened with update_plan and
  // then pattern-completed its audit passed this gate. Shared vocabulary:
  // ./evidence-tools (the guard's NON_EVIDENCE_TOOLS).
  let evidenceToolCalls = countEvidenceToolCalls(messages);
  // Work calls (file writes / edits / commands) for the independent-review eligibility (independent-review.ts).
  let workToolCalls = countWorkToolCalls(messages);
  // audit 2026-10-06 T1-7 (no-progress-brake.ts): consecutive top-level coding
  // tool calls with no mutating tool; ONE harness notice per run.
  let noProgressCalls = 0;
  let noProgressNoticed = false;
  let noProgressCheckedAt = 0;
  // audit 2026-10-08 W2-7: escalation rungs in the current no-progress streak,
  // the call count the next rung is due at, the worker-progress mark already
  // credited, and this loop's own change calls (reported to a parent).
  let noProgressRung = 0;
  let noProgressNextAt = 0;
  let workerProgressSeen = 0;
  let loopChangeCalls = 0;
  // audit 2026-10-08 W2-12 (run-read-cache.ts): identical allowlisted reads in
  // this loop are served from the first result until something state-changing
  // is dispatched. RUN_READ_CACHE_DISABLED=1.
  const readCache: RunReadCache | null = runReadCacheDisabled() ? null : new RunReadCache();
  const noProgressRecent: string[] = [];
  // audit 2026-10-06 T7-5: MUTATING work calls (file writes, git commit/push, a
  // run_command the classifier cannot prove read-only) — an empty diff with none
  // skips the reviewer (review-diff-gate.ts); update_plan calls — a review round
  // that reopened the plan keeps its own final (the kept-answer rule below).
  let mutatingWorkCalls = (typeof countMutatingWorkCalls === 'function') ? countMutatingWorkCalls(messages) : 0;
  let planUpdateCalls = 0;
  // T7-5: the lead's answer at the review grant; restored as the final when the
  // review round changed nothing (the reviewer's verdict never replaces it).
  let reviewAnswerStash: { text: string; mutatingAt: number; planAt: number; fails: number } | null = null;
  // Unresolved either/or sentences from this run's own reasoning (independent-review.ts OPEN CHOICES) — listed back at the self-audit.
  const openChoices: string[] = [];
  // The granted correction round (evidence-guard reject-back / leak retry)
  // is exempt from the deadline collapse at the loop top — collapsing it would
  // re-omit tools and force the very tool-less answer the gates exist to stop.
  let gateGraceUntilStep = -1;
  /**
   * Retry-lane budget grant (owner transcript 2026-09-08 audit): every retry
   * lane re-enters the for-loop with `continue`, which consumes a step — on
   * the LAST step the promised retry never runs: the loop exits with
   * finalText '' and modelErrored false, so a provider error (or a repeating
   * turn) on the final step was recorded as a clean "completed" run whose
   * "final answer" was whatever had streamed earlier. Extending by one lets
   * the retried step actually execute (same tool-less final-step shape).
   */
  const grantRetryStep = () => { if (step >= stepBudget - 1) stepBudget = step + 2; };
  /**
   * Correction-round grant shared by the zero-tool gate, the evidence-guard
   * reject-back and the leaked-tool-call retry: the model is being told to
   * CALL TOOLS, so a FINAL TURN notice pushed this iteration ("tool calls are
   * no longer available") is spliced, one tool round (step+1) plus the answer
   * round (step+2) is guaranteed, and the tool round is shielded from the
   * deadline collapse at the loop top.
   */
  const grantToolRound = (spliceFinalTurnNotice: boolean) => {
    if (spliceFinalTurnNotice) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[HARNESS NOTICE — not typed by the user] FINAL TURN:')) { messages.splice(i, 1); break; }
      }
    }
    gateGraceUntilStep = step + 2;
    if (stepBudget < step + 3) stepBudget = step + 3;
  };
  let leakRetries = 0;             // bounded retry when a tool call was emitted as PLAIN TEXT (never executed)
  const MAX_LEAK_RETRIES = 2;
  /**
   * Ticket 7345b333: how many plain-text tool-call blocks in ONE turn proves a
   * decoder lock rather than an attempt. The owner's transcript carried ~50;
   * 8 is well past "the model tried to call a tool as text" (1–2 blocks, which
   * the bounded leak retry above already handles) and far below the observed
   * storm, so a genuine multi-tool turn written as markup is still surfaced as
   * a leak (not an aborted run) while a wall is stopped on its first turn.
   */
  const LEAKED_CALL_VOLUME_BREAK = 8;
  /**
   * Ticket 7345b333: consecutive turns re-emitting the SAME plain-text call
   * (digits collapsed, args normalised) before the run ends. 3 = the same
   * "identical call 3 turns running" bar the structured-call breaker uses.
   */
  const LEAKED_CALL_REPEAT_BREAK = 2;
  let lastLeakedCallSig = '';
  let leakedCallRepeat = 0;
  // ── NARRATED-TOOL-EMIT LOOP state (ticket 177a31b7, 2026-09-20): consecutive
  // call-free turns whose text ANNOUNCES an imminent tool call that never
  // executes. Repeat 1 → one corrective nudge + a granted tool round (leak-
  // lane idiom); repeat 3 → end the run honestly (derail run-end parity) and
  // flag the result for the executor's attention_needed alarm. Any real tool
  // call, a differently-worded text, or a non-announcement resets the streak.
  // Not checkpoint-persisted — a resumed run re-trips within a few turns when
  // the wedge lives.
  let narrLoopLast = '';
  let narrLoopCount = 0;           // repeats BEYOND the first announcement
  let narrLoopTool: string | null = null;
  let narrLoopNudged = false;
  let narrLoopEnded: { tool: string | null; repeats: number; snippet: string } | null = null;
  // H2 (2026-09-26): did profile.runDeadlineMs collapse this run to its FINAL
  // TURN? Reported on the result so a bounded background council can stamp
  // metadata.depth.facts.backgroundDeadlineHit (the compute_policy row's
  // budget then describes a bound the run actually ran under).
  let deadlineHit = false;
  /** Hand-off polish (CT-2): the custom FINAL-TURN notice from `endTurnAfterToolRound`, once it fired. */
  let endTurnNotice: string | null = null;
  // ── CROSS-TURN REPEATED-LINE state (ticket 03587322, 2026-09-21 — lane
  // 596102ca firing-256): the narr-loop break above needs CONSECUTIVE call-free
  // turns and RESETS on any real tool call (see ~3612), and the in-stream
  // looksRepetitive probe sees ONE turn at a time — so a run that re-states the
  // SAME long narration line once per turn, interleaved with REAL tool calls
  // (23 junk todo_creates between copies, ~38 min of streaming final), tripped
  // nothing. Track long normalized lines CUMULATIVELY across the run's turns
  // (never reset by tool calls — that reset is exactly the blind spot): warn
  // once per line at LINE_REPEAT_RUN_WARN, end the run at
  // LINE_REPEAT_RUN_BREAK. Not checkpoint-persisted — a resumed run re-trips
  // within a few turns.
  const LINE_REPEAT_RUN_WARN = 4;  // cumulative copies across ≥2 turns ⇒ one warning
  const LINE_REPEAT_RUN_BREAK = 6; // cumulative copies across ≥2 turns ⇒ end the run
  // df5ea136 (2026-09-26, lane cec340f2 run 10d8bbd3): a repeated line that
  // CITES an artifact id from this run's own receipts is evidenced completed-
  // work recap — not the unevidenced intention loop this guard exists for —
  // so for that shape the break lifts to 3× the threshold (≥18 copies across
  // turns is degeneration regardless of citations). See the exemption check
  // at the break below.
  const LINE_REPEAT_RUN_EXEMPT_CAP = 3 * LINE_REPEAT_RUN_BREAK;
  // Artifact-id keys a repeated line may cite to qualify — 'url' is excluded
  // (any "https://…" line would then match any PR receipt) and numeric ids
  // like prNumber are too short to prove anything by containment (M1 idiom:
  // prefix/containment matches need ≥8 chars to mean anything).
  const RECEIPT_CITABLE_ID_KEYS = new Set(['sha', 'branch', 'todoId', 'goalId', 'scheduleId', 'ticketId', 'chatId', 'sessionId']);
  const lineRepeatCounts = new Map<string, { line: string; count: number; turns: number }>();
  let lineRepeatNudgedKey: string | null = null;
  let lineRepeatExemptNudgedKey: string | null = null;
  let compactionCount = 0;         // how many times we've compacted this run (surfaced in the sidebar)
  // ticket c9133b94: consecutive cuts that failed to land the transcript back
  // under the trigger. Drives the convergence ladder (compactStepDecision):
  // productive 'early' → escalate once to 'full' → stop paying.
  let compactionNonConvergingCuts = 0;
  // ticket c9133b94: one skip row per run (an armed run can sit over the
  // trigger for hundreds of steps — one row each would flood the kind).
  let compactionSkipRecorded = false;
  // build 2026-10-08 C (context.md A + B-shadow): the per-run context gauge (top-level loops), the chat
  // fast-path clear count and the malformed-history repair budget. CONTEXT_GAUGE_DISABLED=1 ⇒ no gauge.
  const contextGauge = topLevel && !contextGaugeDisabled()
    ? new ContextGauge({ sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, profile: profile.kind })
    : null;
  let chatClears = 0;
  let historyRepairs = 0;
  // build 2026-10-11 T1: the ORIGINAL bodies tier 1 cleared — carried in the checkpoint so a RESUMED run's evidence
  // guard still finds them (run-executor guardPriorToolTexts); in-run the guard reads toolTexts, never `messages`.
  const tier1ClearedTexts: string[] = [];
  const recentDiffHashes: string[] = [];
  const failureSigCounts = new Map<string, number>();

  const worktreeDiffHash = async (): Promise<string> => {
    try {
      const { stdout } = await execShell('git add -A -N >/dev/null 2>&1; git diff HEAD', input.worktree, 20_000);
      return crypto.createHash('sha256').update(stdout || '').digest('hex').slice(0, 16);
    } catch { return ''; }
  };

  // Rehydrate harness counters from the resume checkpoint (Phase 1) so a resumed
  // run continues with its real budgets/guards instead of fresh ones.
  if (resume) {
    compactionCount = resume.compactionCount ?? 0;
    if (Array.isArray(resume.clearedToolTexts)) keepClearedTexts(tier1ClearedTexts, resume.clearedToolTexts.filter((t) => typeof t === 'string')); // build 2026-10-11 T1
    modelErrored = !!resume.modelErrored;
    modelErrorRecoveries = resume.modelErrorRecoveries ?? 0;
    transientRecoveries = resume.transientRecoveries ?? 0;
    repetitionRetries = resume.repetitionRetries ?? 0;
    leakRetries = resume.leakRetries ?? 0;
    autoContinueRounds = resume.autoContinueRounds ?? 0;
    autoVerifyIters = resume.autoVerifyIters ?? 0;
    lastPlanSig = resume.lastPlanSig ?? '';
    lastContinueDiffHash = resume.lastContinueDiffHash ?? '';
    continueStalls = resume.continueStalls ?? 0;
    selfAudited = !!resume.selfAudited;
    lastToolSig = resume.lastToolSig ?? '';
    repeatCount = resume.repeatCount ?? 0;
    recentDiffHashes.push(...(resume.recentDiffHashes ?? []));
    for (const [k, v] of Object.entries(resume.failureSigCounts ?? {})) failureSigCounts.set(k, v);
  }

  let step = resume?.step ?? 0;
  let stepBudget = resume?.stepBudget ?? opts.maxSteps;
  let done = false;
  const runStartedAt = resume?.runStartedAt ?? Date.now();
  // A3 (2026-10-04 coding quick wins — review-diff-gate.ts): HEAD at THIS run's
  // start, the baseline the independent-review diff gate measures the run's
  // own change against. Read only when the gate can matter: a top-level coding
  // auto run on a FRESH start whose request is this run's own message and not
  // assigned work (a resume / continuation / owner dispatch / ticket brief
  // always keeps the reviewer, so it needs no baseline). One `git rev-parse`;
  // null on any failure ⇒ "unmeasured" ⇒ the reviewer runs as before.
  // Kill switch INDEPENDENT_REVIEW_DIFF_GATE_DISABLED=1 (no read at all).
  let runStartHead: string | null = null;
  if (!resume && topLevel && profile.kind === 'coding' && profile.workspaceTools && input.permissionMode === 'auto' && !independentReviewDiffGateDisabled()) {
    try {
      const req0 = originalRequest(input.userMessage, input.history as any);
      if (req0?.source === 'message' && !isAssignedWorkRequest(input.userMessage) && typeof readRunStartHead === 'function') {
        runStartHead = await readRunStartHead(input.worktree);
      }
    } catch { runStartHead = null; }
  }
  let deadlineOffsetMs = resume?.deadlineOffsetMs ?? 0; // injection waits don't count against the budget
  // build 2026-10-09 VS: QUEUED ms a tool reported (onShieldedWait …{ queued: true } — the verify-slot waits); the
  // per-tool hard timer re-arms by the share accrued during its call (tool-hard-timeout.ts).
  let toolQueuedMs = 0;

  /**
   * Write-ahead checkpoint (Phase 1, top-level coding runs only). Called at the
   * top of each step and BEFORE each tool call executes; fire-and-forget — a
   * checkpoint failure must never break the run.
   */
  const checkpoint = (phase: 'preModel' | 'dispatch', pendingToolCalls?: RunCheckpoint['pendingToolCalls']): void => {
    if (!input.onCheckpoint || !topLevel) return;
    try {
      input.onCheckpoint({
        version: 1,
        // SNAPSHOT the array (ticket 63e9a3cb review B1): the executor's
        // onCheckpoint serializes ASYNCHRONOUSLY (after the git worktree
        // snapshot), while this loop keeps pushing/splicing per-turn
        // transients ([HARNESS CLOCK] note, <plan> reminder) into the LIVE
        // array — a live reference persisted them into durable checkpoints
        // and replayed them on resume. Message elements are never mutated in
        // place after being pushed, so a shallow copy is a complete barrier.
        // DISPATCH phase (delegation resume-notes): splice a [COMPLETED
        // DELEGATIONS THIS RUN] note into the SNAPSHOT (never the live array)
        // before the in-flight assistant turn — trimToPreModel rewinds that
        // whole turn on resume, tool results included, so a delegation that
        // already finished inside it would otherwise vanish and be
        // re-dispatched by the regenerated turn. The note sits before the cut.
        messages: phase === 'dispatch' && turnDelegations.length
          ? spliceCompletedDelegationsNote(messages, turnDelegations)
          : [...messages],
        step,
        stepBudget,
        phase,
        ...(pendingToolCalls ? { pendingToolCalls } : {}),
        compactionCount,
        modelErrored,
        modelErrorRecoveries,
        transientRecoveries,
        repetitionRetries,
        leakRetries,
        autoContinueRounds,
        autoVerifyIters,
        lastPlanSig,
        lastContinueDiffHash,
        continueStalls,
        selfAudited,
        lastToolSig,
        repeatCount,
        runStartedAt,
        deadlineOffsetMs,
        recentDiffHashes: [...recentDiffHashes],
        failureSigCounts: Object.fromEntries(failureSigCounts),
        usageRunId: usageAcc.runId,
        ...(tier1ClearedTexts.length ? { clearedToolTexts: [...tier1ClearedTexts] } : {}), // build 2026-10-11 T1
      });
    } catch { /* checkpointing must never break the run */ }
  };

  // audit 2026-10-06 T1-8: will the goal-continue lane below resume after this
  // round's tools-off turn? Mirrors its decision exactly (same flags, same plan
  // signature / worktree hash vs the last continue) without mutating its state.
  let checkpointNoticeThisRound = false;
  const goalContinueWillFollow = async (): Promise<boolean> => {
    if (!(topLevel && profile.workspaceTools && profile.planReminders && !done && !toolEndTurnRequest
      && input.permissionMode === 'auto' && !input.isCancelled?.() && !modelErrored
      && autoContinueRounds < loopCfg.maxAutoContinueRounds)) return false;
    const planNow = await getPlan(input.sessionId).catch(() => null);
    if (!planNow || !planNow.steps.some((s) => s.status === 'pending' || s.status === 'in_progress')) return false;
    if (continueStalls === 0) return true; // a single stall still resumes (stalls < 2)
    const planSig = planNow.steps.map((s) => `${s.id}:${s.status}:${s.text}`).join('|');
    if (planSig !== lastPlanSig) return true;
    return (await worktreeDiffHash()) !== lastContinueDiffHash;
  };

  while (!done) {
    for (; step < stepBudget; step++) {
      editCheckpoints?.setStep(step);
      leadHttpFallbackThisStep = false;
      // ── PER-TURN RE-EMIT TELEMETRY RESET (ticket 192d9087 F2, 2026-10-30) ────
      // THE DEFECT this closes: `severedReemitLens` was assigned only inside the
      // re-emit branch and never cleared, and `severedRecovered` was copied from
      // the per-run bound onto the ctx on EVERY turn. A run that re-emitted once
      // therefore stamped `re:1` and an EARLIER turn's `rl` onto every later
      // reject row — so `re:1` read "a re-emit happened at some point in this
      // run", not "this row followed a re-emit", and an `rl` vs `argLen`
      // comparison could pair two unrelated turns. Both keys are reset HERE, at
      // turn start, from ONE carry: resetting only one would leave the other
      // misleading, which is exactly the class of partial fix this replaces.
      // `beginTurn` CONSUMES the carry, so the lens rides exactly one attempt
      // (the retry the branch bought) and is gone on the turn after.
      const reemitTurn = beginTurn(severedReemitCarry);
      ctx.turnIsReemitRetry = reemitTurn.re === 1;
      ctx.turnReemitLens = reemitTurn.rl;
      // The bounded ONE-per-run gate is a COST bound, not telemetry — it stays
      // per-run and is reported separately as `rr` so the 'already-recovered'
      // diagnosis survives `re` becoming a per-turn fact.
      ctx.runReemitSpent = severedStreamRecovered;
      if (leadFallbackState === 'revert') {
        // Provider cooldown (autonomy loop #3): while the primary's provider is
        // cooling down, stay on the fallback seat — no probe round trip per
        // step. The first step after the cooldown reverts as before.
        const cd = providerCooldownUntil(primaryProvider.label);
        if (cd && provider !== primaryProvider) {
          leadFallbackState = 'active';
          if (cooldownNoticeUntil !== cd) {
            cooldownNoticeUntil = cd;
            emit('progress', { message: `Coding seat ${primaryProvider.label} is still rate-limited — staying on ${seatModelSpec} until ${new Date(cd).toISOString().slice(11, 19)}Z`, stage: 'seat-fallback' });
          }
        } else {
          provider = primaryProvider;
          if (primaryContextBudget !== undefined) contextBudget = primaryContextBudget;
          if (primarySeatSpec !== undefined) seatModelSpec = primarySeatSpec;
          leadFallbackState = 'none';
        }
      } else if (leadFallbackState === 'armed') leadFallbackState = 'active';
      // ── Run deadline (chat profiles): past it, force the NEXT turn to be the
      // last — tools are omitted on the last step, so the model MUST answer.
      // This is the structural guarantee against an unbounded chat run.
      // The zero-tool gate's single granted tool round (step <= grace) is
      // exempt: collapsing it would re-omit tools and force the very zero-tool
      // answer the gate exists to stop. One round, then the deadline resumes.
      let forcedFinalThisStep = false; // audit 2026-10-06 T1-8: a forced final never gets the checkpoint notice
      if (profile.runDeadlineMs && Date.now() - runStartedAt - deadlineOffsetMs > profile.runDeadlineMs && step < stepBudget - 1 && step > gateGraceUntilStep) {
        stepBudget = step + 1;
        deadlineHit = true;
        // Machine coding runs (v1#33): the deadline exists so a wedged run
        // frees its lane — say so honestly in the run surface (the FINAL TURN
        // notice below already authorizes the honest partial).
        emit('progress', {
          message: input.machineTriggered === true && profile.kind === 'coding'
            ? '[HARNESS] Run hit its time budget — finalizing with work-so-far'
            : 'Time budget reached — answering now',
          stage: 'deadline',
        });
      } else if (input.forceFinalTurn && step < stepBudget - 1 && step > gateGraceUntilStep && topLevel && safeForceFinalTurn(input.forceFinalTurn)) {
        forcedFinalThisStep = true;
        // Generic forced-final hook — same FINAL-TURN collapse as the deadline
        // above (the model writes a complete final; nothing is truncated).
        // Historically the chat harness passed the DepthBudget maxUsd crossing
        // here; since 2026-09-27 (owner: no hidden cost caps) no caller passes
        // it, so this branch is inert. The event rides stage 'deadline' with
        // NO key (review 2026-09-26 M8): the FIXED progress-key set
        // (chat-agent/compute-policy-wiring PROGRESS_KEYS) is the client's
        // lookup table; this line is harness text, never model prose.
        stepBudget = step + 1;
        emit('progress', { message: 'Compute budget reached — answering now', stage: 'deadline' });
      } else if (toolEndTurnRequest && step < stepBudget - 1 && step > gateGraceUntilStep && topLevel) {
        // MERGE-INTENT-AWAIT (2026-10-20): a tool (await_condition) registered a
        // condition wake and asked to end the run — the same tools-off final
        // with the tool's notice; goal-continue and the unfinished-work
        // continuation stand down (awaitingCondition), the wake resumes it.
        stepBudget = step + 1;
        endTurnNotice = toolEndTurnRequest;
        emit('progress', { message: 'Waiting on a condition — the harness wakes this chat when it is met', stage: 'deadline' });
      } else if (input.endTurnAfterToolRound && step < stepBudget - 1 && step > gateGraceUntilStep && topLevel) {
        // Hand-off polish (2026-09-28, audit CT-2): a human turn that STARTED a
        // sub-session ends its tool loop after that round — one tools-off
        // final with the caller's own notice (never FINAL_TURN_NOTICE's
        // deliverable framing), so the parent never polls / re-reads the
        // session and never re-narrates the hand-off row. Fail-open.
        const notice = safeEndTurnNotice(input.endTurnAfterToolRound);
        if (notice) {
          stepBudget = step + 1;
          endTurnNotice = notice;
          emit('progress', { message: 'Sub-session started — finishing the answer', stage: 'deadline' });
        }
      }
      const lastStep = step === stepBudget - 1;
      // Tools are omitted on the last step — TELL the model, or it writes a
      // "let me fill the gaps…" transition line expecting another tool round
      // and that narration becomes the persisted answer (owner E2E 2026-07-16).
      if (lastStep && stepBudget > 1) {
        // user-role with harness framing: ZAI 400s persistent mid-position
        // system messages (all three round-2 council leads died exactly here).
        // Anti-confabulation wording (fabrication RCA, 2026-08-23): the old
        // "COMPLETE final answer — full deliverable" demand was direct pressure
        // to confabulate — a budget-cut run being ordered to look finished
        // pattern-completes its own past reports (invented PR numbers tracking
        // the real counter, future-dated timestamps = last timestamp + usual
        // gap). Keep the anti-transition-line intent (owner E2E 2026-07-16)
        // but explicitly authorize the honest partial.
        // audit 2026-10-06 T1-8: a plain step-budget end that the goal-continue
        // lane WILL resume gets the CHECKPOINT notice, never the deliverable one.
        let lastTurnNotice = endTurnNotice ?? FINAL_TURN_NOTICE;
        if (!endTurnNotice && !deadlineHit && !forcedFinalThisStep && !finalTurnCheckpointDisabled() && await goalContinueWillFollow().catch(() => false)) {
          lastTurnNotice = CHECKPOINT_TURN_NOTICE;
          checkpointNoticeThisRound = true;
          emit('progress', { message: 'Round step budget spent — checkpoint turn, then auto-continuing the plan', stage: 'loop' });
        }
        messages.push({ role: 'user', content: lastTurnNotice });
      }

      // ── Soft drain yield: the worker is retiring. Hand off at this step
      // boundary (the previous turn's tools are done, no stream in flight) via
      // the hard drain's own path — interrupted + cancelled — so every
      // post-loop step skips and the live worker resumes from the checkpoint.
      if (topLevel && !input.isCancelled?.() && input.isDrainYieldRequested?.()) {
        input.onDrainYield?.();
        emit('progress', { message: 'Moving this run to a fresh worker', stage: 'loop' });
        done = true;
        break;
      }

      // ── Cooperative cancel: Stop pressed → halt cleanly with what we have. ──
      if (input.isCancelled?.()) {
        finalText = finalText || '(Stopped.)';
        parts.push(stampPart({ type: 'text', text: '⏹ Stopped by user.' }));
        done = true;
        break;
      }

      // New turn: the previous turn's tool results (delegation summaries
      // included) are in the live transcript now — the resume note only ever
      // covers the IN-FLIGHT turn.
      turnDelegations.length = 0;
      // Phase 1: write-ahead checkpoint at the top of every step.
      checkpoint('preModel');

      // ── build 2026-10-11 T1 — TIER-1 tool-result clearing (context-gauge.ts tier1Act; treatment arm only): when the
      // newest provider-reported prompt is over T (160k tokens), ONE batched, cache-aware edit replaces the oldest
      // tool-result bodies outside the last 5 rounds with restorable stubs (never inside the steer guard, never a
      // system / user / assistant message, never plan / verify / todo / receipt state). Compaction below stays the
      // tier-2 fallback above its own char trigger. CONTEXT_CLEARING_ENABLED=shadow restores the shadow-only rows.
      const t1 = contextGauge?.tier1Act(messages, step) ?? null;
      if (t1) {
        messages.length = 0;
        messages.push(...t1.messages);
        keepClearedTexts(tier1ClearedTexts, t1.originals);
        emit('progress', { message: `Cleared ${t1.cleared} older tool result${t1.cleared === 1 ? '' : 's'} (~${Math.round(t1.freedTokens / 1000)}k tokens) to keep the context lean — re-run a call to see it in full`, stage: 'compact' });
      }
      // ── Compaction: keep the running transcript within the context window.
      // v2 (P6): trigger at ~70% of the budget and compact the oldest third —
      // several cheap early compactions instead of one 100% cliff that
      // summarizes everything at once. ──
      if (messagesChars(messages) > compactionTriggerChars(effectiveContextBudget())) { // audit 2026-10-06 T1-1: learned ceiling caps a family budget
        // build 2026-10-08 C-1: chat FAST PATH — on a chat seat with a ≤150k-char budget, a deterministic clear of
        // old tool results replaces the ~9 s LLM summary when it gets under the trigger (owner canary acts; the rest
        // record a shadow row). Otherwise the summariser below runs exactly as before. CHAT_CONTEXT_CLEARING=off.
        const clearDecision = chatClearingDecision({ profileKind: profile.kind, budgetChars: effectiveContextBudget(), userId: input.userId });
        const fastCleared = clearDecision
          ? chatFastPathClear(messages, { decision: clearDecision, beforeChars: messagesChars(messages), budgetChars: effectiveContextBudget(), triggerChars: compactionTriggerChars(effectiveContextBudget()), step, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp })
          : null;
        const compacted = fastCleared ? null : await (async () => {
          // ticket c9133b94: cut once, then stop paying. A REPEAT cut over the
          // trigger cannot converge — 'full' and 'early' clamp to the same span
          // once KEEP_RECENT_MSGS binds — so repeating it bought chat-501 three
          // blocking summarizers in 61 s (32.5 s on the first) to delete
          // transcript that was recorded nowhere.
          const cutStep = compactStepDecision({ nonConvergingCuts: compactionNonConvergingCuts });
          if (cutStep === 'skip') {
            // ONE row per run, not one per over-trigger step: an armed run can
            // sit over the trigger for hundreds of steps and would otherwise
            // flood a kind that is already row-heavy.
            if (!compactionSkipRecorded) {
              compactionSkipRecorded = true;
              try {
                recordLoopMetric({
                  kind: LOOP_METRIC_KINDS.CONTEXT_COMPACTION,
                  sessionId: input.sessionId,
                  value: 0,
                  unit: 'chars_skipped',
                  meta: { skipped: 'cannot_converge', nonConvergingCuts: compactionNonConvergingCuts, chars: messagesChars(messages), trigger: compactionTriggerChars(effectiveContextBudget()) },
                });
              } catch { /* telemetry never breaks a turn */ }
            }
            return null;
          }
          return compactMessages(messages, input.sessionId);
        })();
        if (fastCleared) {
          messages.length = 0;
          messages.push(...fastCleared);
          chatClears += 1;
          emit('progress', { message: 'Cleared older tool results to stay within limits', stage: 'compact' });
        } else if (compacted) {
          messages.length = 0;
          messages.push(...compacted);
          compactionCount += 1;
          // Did this cut actually land the transcript back under the trigger?
          // If not, the next cut must escalate rather than repeat (c9133b94).
          compactionNonConvergingCuts = messagesChars(messages) > compactionTriggerChars(effectiveContextBudget())
            ? compactionNonConvergingCuts + 1 : 0;
          emit('progress', { message: 'Compacted earlier context to stay within limits', stage: 'compact' });
        }
      }
      // Live context-usage signal for the sidebar meter (char proxy vs the
      // compaction budget) + how many times we've compacted this run.
      if (topLevel) emit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount, usage: usageAcc.snapshot(), sessionUsage: sessionUsageView() });

      // ── Harness injection (e.g. parallel cross-checker drafts arriving). ──
      // Injected as a USER-role message with explicit harness framing: ZAI
      // rejects (HTTP 400) system-role messages that persist mid-conversation
      // — plan reminders never hit this because they're spliced out after
      // every turn, so this was the first persistent mid-run system message.
      // Time spent WAITING inside the injector (blocking on parallel checker
      // drafts) is excluded from the run deadline — it isn't this run's work.
      if (topLevel && input.injectSystem) {
        try {
          const injT0 = Date.now();
          const inj = await input.injectSystem(step);
          deadlineOffsetMs += Date.now() - injT0;
          if (inj) {
            const injText = typeof inj === 'string' ? inj : inj.text;
            const injImages = typeof inj === 'string' ? undefined : inj.images;
            const framed = `[HARNESS INJECTION — not typed by the user; treat as system instructions]\n${injText}`;
            messages.push({
              role: 'user',
              content: injImages?.length
                ? [{ type: 'text', text: framed }, ...toImageContentParts(injImages)]
                : framed,
            });
          }
        } catch { /* injection is best-effort */ }
      }
      // ── Background worker reports (coding/background-delegation.ts) — the
      // same seam: a report that finished since the last turn is injected ONCE,
      // framed [BACKGROUND WORKER REPORT — <role> <title>] as DATA (never the
      // "treat as system instructions" line above — a worker's report may quote
      // a scraped page). It also joins the guard haystack and the transcript.
      if (topLevel && bgPool) {
        const ready = bgPool.takeReady();
        if (ready.length) {
          messages.push({ role: 'user', content: ready.map(w => formatInjectedReport(w)).join('\n\n') });
          for (const w of ready) {
            toolTexts.push(w.report ?? '');
            parts.push(stampPart({ type: 'subagent', title: w.title, role: w.role, summary: w.report ?? '', background: true, handle: w.id }));
          }
          emit('progress', { message: `Background worker report${ready.length === 1 ? '' : 's'} arrived: ${ready.map(w => w.title).join(', ')}`, stage: 'background' });
        }
      }

      // ── SAA-1.6 PHASE 3b (platform/async-tool-registry.ts) — DEFERRED TOOL
      // RESULTS. A call that outlived the elapsed threshold was answered
      // "Started" with a correlation id; its real result is drained HERE, at a
      // step boundary, through the same seam as the background-worker report
      // below. Framed as DATA with the id and elapsed time, so the model can
      // join it to the "Started" it saw, and so it is never mistaken for
      // instructions (a tool result may quote a scraped page).
      if (topLevel && asyncTools) {
        const done = asyncTools.takeReady();
        if (done.length) {
          messages.push({ role: 'user', content: done.map(formatAsyncToolResult).join('\n\n') });
          for (const d of done) {
            toolTexts.push(d.result);
            emit('tool_result', { name: d.tool, result: d.result, background: true, correlationId: d.correlationId });
          }
          emit('progress', {
            message: `Background tool result${done.length === 1 ? '' : 's'} arrived: ${done.map(a => `${a.tool} (${a.correlationId})`).join(', ')}`,
            stage: 'background',
          });
        }
      }

      // ── F2 FRONTIER COUNCIL (coding/frontier-council.ts): the [REFLECT — REPEATED FAILURES] note when the trigger
      // armed since the last step, or the harness auto-run's advice when the agent ignored the note for 2 steps. Same
      // seam + framing as the injections above (a user-role harness message after a fully answered tool turn); the
      // wait on the advisors is off the run deadline, like an injector wait. Fail-open.
      if (frontierCouncil) {
        try {
          const fcT0 = Date.now();
          const fcNote = await frontierCouncil.beforeStep(councilStepState({ step, lastStep }));
          deadlineOffsetMs += Date.now() - fcT0;
          if (fcNote) {
            messages.push({ role: 'user', content: fcNote });
            if (!fcNote.startsWith('[REFLECT')) toolTexts.push(fcNote); // the council's answers join the guard haystack, like a worker report
            emit('progress', { message: fcNote.startsWith('[REFLECT') ? 'Repeated failures — reflect, then consult the frontier council' : 'Frontier council answered (harness auto-run)', stage: 'reflection-council' });
          }
        } catch { /* the council is advisory — never blocks a step */ }
      }

      // ── CLOCK: re-inject a fresh [HARNESS CLOCK] note every turn (ticket
      // 63e9a3cb): the [CURRENT DATE & TIME] block is built once per attempt and
      // goes stale on a long run — lanes then ESTIMATE "now" as block-time +
      // guessed elapsed and overshoot the true clock (~+10m fabrications struck
      // by the evidence guard in 2 lanes within 30 min on 2026-08-28). A fresh
      // per-turn harness clock removes the need to estimate. Same transient
      // pattern as the plan reminder: pushed pre-turn, spliced post-turn, never
      // checkpointed (the preModel checkpoint runs above) and never persisted.
      // Extended to chat-lane MACHINE wakes (ticket ad325229, 2026-09-16 — a
      // fleet message-wake lane whose only clock was its ~6-min-stale wake
      // stamp headlined a phantom "19:21Z" against a real 19:16:34Z clock,
      // struck pre-delivery; review finding B12 had already flagged the
      // coding-only gate): the identical overshoot-estimation shape 63e9a3cb
      // killed on coding lanes. The chat-wake disjunct is the same gate as the
      // EVIDENCE LEDGER below (top-level machine-triggered runs; workers never
      // see it — machineTriggered is undefined on subagent inputs, :1171).
      // USER-triggered chat turns stay unchanged (short, interactive).
      // ── DIAGNOSTICS after edit: a completed background pass hands its note
      //  here. Persistent (a tool-result-like fact) and pushed BEFORE the
      //  transient clock / plan / ledger notes, so their post-turn splice of
      //  trailing system messages never removes it.
      const diagNote = editDiagnostics?.takeNote();
      if (diagNote) messages.push({ role: 'system', content: diagNote });

      let clockNotePushed = false;
      if (profile.kind === 'coding' || (topLevel && input.machineTriggered === true)) {
        messages.push({
          role: 'system',
          content: profile.kind === 'coding' ? buildCodingClockNote(userTimezone) : buildChatWakeClockNote(userTimezone),
        });
        clockNotePushed = true;
      }

      // ── GOAL: re-inject a compact <plan> reminder every turn (anti-drift). ──
      let reminderPushed = false;
      if (topLevel && profile.planReminders) {
        const plan = await getPlan(input.sessionId);
        // Reflection nudge: repeated identical calls, or long runs, or no plan yet.
        let nudge = '';
        if (repeatCount >= 2) nudge = `You've repeated the same tool call ${repeatCount}× — it isn't working. Try a different approach — search_memory(source:'learning') with the failing command/error text often surfaces a recorded fix from a past session — or mark the step blocked via update_plan and move on.`;
        else if (step > 0 && step % 8 === 0) nudge = `You're ${step} steps in. Confirm you're still on the right step; if stuck, update_plan(status:"blocked") and proceed.`;
        if (plan && (plan.goal || plan.steps.length)) {
          messages.push({ role: 'system', content: renderPlanReminder(plan, { step, maxSteps: opts.maxSteps, nudge }) });
          reminderPushed = true;
        } else if (step >= 2 && !plan) {
          messages.push({ role: 'system', content: `<plan>You have not set a plan. For a multi-step task, call update_plan now with a one-sentence goal, acceptance criteria, and 3-8 ordered steps.${nudge ? ` ${nudge}` : ''}</plan>` });
          reminderPushed = true;
        }
      }

      let ledgerNotePushed = false;
      // ── EVIDENCE LEDGER (machine-triggered top-level runs; tickets a84cc306
      //    + 5036d072): rule 6 demands citations copied verbatim from "this
      //    run's EVIDENCE LIST" but the harness never SHOWED the model that
      //    consolidated list — across a 24-step sweep + mid-run compaction it
      //    regenerated shape-conformant 8-hex ids instead (ticket 0e2fcb6f: 2
      //    phantom-msg occurrences in ~7 min across two supervisor seats,
      //    guard-stripped both times). The harness now maintains the list
      //    itself and re-injects it every turn. Same transient pattern as the
      //    clock note: pushed pre-turn, spliced post-turn, never checkpointed,
      //    never persisted. Coding lanes were originally excluded ("their
      //    finals ride the run-evidence-guard claim-manifest idiom") — but
      //    that is DETECTION, not PREVENTION, and the detection-only coding
      //    lanes stayed the FM-2.6 recidivists (ticket 5036d072 strike
      //    telemetry: 061b4980 ×13, 9a9911bb ×20, d0597e02 ×34). They now get
      //    the lane-scoped variant (commit/pr receipt anchors + claims-block
      //    wording, chat-agent/evidence-ledger.ts). Workers never see it
      //    (machineTriggered is undefined on subagent inputs, :1171).
      if (topLevel && input.machineTriggered === true) {
        const ledgerNote = evidenceLedger.render();
        if (ledgerNote) {
          messages.push({ role: 'system', content: ledgerNote });
          ledgerNotePushed = true;
        }
      }

      let turnText = '';
      // Ticket 7345b333 (2026-11-02): a turn that emits tool calls as inline
      // ASCII-XML TEXT streamed the raw markup straight to the owner's UI —
      // ~50 near-identical `<tool_call><function=…><parameter=…>` blocks in one
      // turn, each rendered full-width. The persisted answer is sanitized
      // (stripToolCallMarkup → stripAsciiXmlToolCalls), but the LIVE stream had
      // no equivalent net, so the wall appeared in real time. Same latch idiom
      // as the integration paths (moonshot.integration.ts): once a delta is
      // recognisably tool-call markup, stop forwarding content deltas — the
      // turn's real answer is emitted by the final-text path below, sanitized.
      let streamLeakLatched = false;
      const promptCharsBefore = messagesChars(messages);
      // Derailment breaker: the withheld tool returns after its one-round ban.
      if (withheldTool && step >= withheldUntilStep) withheldTool = null;
      // The run's full list minus the breaker's withheld tools — what the
      // executor can resolve this turn, whatever the model is SHOWN.
      const toolsAvail: typeof tools = (withheldTool || permaWithheld.size)
        ? tools.filter((t) => { const name = t?.function?.name as string; return name !== withheldTool && !permaWithheld.has(name); })
        : tools;
      // The provider's tool cap WITH its honest source (provider-limits.ts):
      // registry model > endpoint > DOCUMENTED provider class (OpenAI 128,
      // Gemini 512), min'd with a cap LEARNED from a live 400 body ('learned'
      // only then), else the OPT-IN blanket env, else NONE. Built-ins never.
      // The b085607e blanket 128 that trimmed a Kimi behind a proxy is gone.
      const limitDetail = !lastStep ? providerToolLimitDetail(provider) : { source: 'none' as const, limit: undefined };
      const toolLimit = limitDetail.limit;
      // ── PROGRESSIVE TOOL DISCLOSURE (2026-09-27, tool-groups.ts): when the
      //    cap is below the full list (or TOOL_GROUPS_ALWAYS=1), the model sees
      //    a small always-on CORE + the groups the task text obviously needs +
      //    two gateway tools (list_tool_groups / load_tools); every other group
      //    loads on demand, LRU-evicted under the cap; a by-name call to a tool
      //    not in view auto-loads it (never an unknown-tool refusal). With no
      //    cap and the switch off, or under TOOL_GROUPS_DISABLED=1, the legacy
      //    path below runs byte-for-byte. ──
      const groupsActive = !lastStep && !toolGroupsDisabled()
        && (toolGroupsAlways() || !!chatDiet?.acts || (toolLimit !== undefined && toolsAvail.length + TOOL_GROUP_META_TOOLS.length > toolLimit));
      let toolsForTurn: typeof tools;
      let toolsForModel: typeof tools;
      let trimNotePushed = false;
      let groupsNotePushed = false;
      if (groupsActive) {
        // The legacy single-group meta-tool is superseded by the gateway pair.
        toolsForTurn = [...toolsAvail.filter((t) => t?.function?.name !== LOAD_TOOL_GROUP_TOOL), LIST_TOOL_GROUPS_SCHEMA, LOAD_TOOLS_SCHEMA] as typeof tools;
        const names = toolsForTurn.map((t) => t?.function?.name as string).filter(Boolean);
        if (!toolGroups) {
          toolGroups = new ToolGroupSession(names, toolLimit);
          // Preload: deterministic keyword → group hints from the run's own
          // prompt material (user turns of history + the message + the
          // scheduler notice), then the lane's habitual groups. The legacy
          // account / triage flags are folded into the session from here on.
          const promptText = toolGroupsPromptText(input);
          for (const g of initialToolGroups({ text: promptText, knownTools: names, chatLane: profile.kind !== 'coding', triage: runMentionsTicketWork(input), supervisor: !!profile.supervisorTools })) toolGroups.load(g);
          // User MCP servers (ticket e294f9a4): a prompt naming one of the user's servers preloads their tools.
          if (userMcp?.toolCount && textMentionsUserMcpServer(promptText, userMcp.serverHints)) toolGroups.load('connector_mcp');
          // build 2026-10-08 A2-2: a human chat turn also preloads the non-core tools those turns call most.
          if (chatDiet) toolGroups.loadTools(CHAT_PRELOAD_TOOLS);
          // build 2026-10-08 A2b: an ACTING lane set replaces that starting view with the turn plan's lane view.
          if (chatDiet?.lane?.acts) toolGroups.seedView(chatDiet.lane.view);
          logger.info(`coding agent [${agentLabel}]: progressive tool disclosure on — ${toolGroups.visibleCount()}/${toolLimit ?? '∞'} tools in view (core ${toolGroups.coreCount()} + ${toolGroups.loadedGroups().join(', ') || 'no groups'}; cap source ${limitDetail.source}; ${toolsForTurn.length} total)`);
        } else {
          toolGroups.setTools(names);
          toolGroups.setCap(toolLimit);
        }
        toolsForModel = toolGroups.visible(toolsForTurn);
        // Residual: a cap smaller than the core itself (rare, tiny caps) still
        // falls back to the priority trim — the only place the trim row remains.
        if (toolLimit !== undefined && toolsForModel.length > toolLimit) {
          const trimmed = trimToolsToLimit(toolsForModel, toolLimit);
          toolsForModel = trimmed.tools;
          toolsTrimmed = { from: trimmed.from, to: trimmed.to, dropped: trimmed.dropped };
          const trimKey = toolLimitKey(provider.url, provider.model);
          if (!trimTelemetered.has(trimKey)) {
            trimTelemetered.add(trimKey);
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.TOOL_LIST_TRIMMED,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              value: trimmed.dropped.length, unit: 'tools',
              meta: { model: provider.model, limit: toolLimit, source: limitDetail.source, mode: 'core_residual', from: trimmed.from, to: trimmed.to, dropped: trimmed.dropped.slice(0, 80), droppedGroups: trimmed.droppedGroups },
            });
          }
        }
        messages.push({ role: 'system', content: toolGroupsSystemNote(toolGroups, provider.model) });
        groupsNotePushed = true;
        toolGroupsStatus();
      } else {
        toolsForTurn = (!accountToolsLoaded || !triageToolsLoaded || profile.kind === 'coding')
          ? toolsAvail.filter((t) => {
              const name = t?.function?.name as string;
              // Progressive disclosure (legacy single-group form): the account +
              // triage groups are hidden until loaded; once BOTH are loaded the
              // meta-tool itself leaves the schema.
              if (!accountToolsLoaded && isAccountTool(name)) return false;
              if (!triageToolsLoaded && isTriageTool(name)) return false;
              if (accountToolsLoaded && triageToolsLoaded && name === LOAD_TOOL_GROUP_TOOL) return false;
              return true;
            })
          : toolsAvail;
        // ── TOOL LIMIT TRIM — the FALLBACK path (TOOL_GROUPS_DISABLED=1, or the
        //    gpt-6-astra shape with groups off): the list is cut by the stable
        //    priority in provider-limits.ts (core + doctrine tools first,
        //    connector writes go first), the model reads ONE system note naming
        //    the dropped groups, and ONE tool_list_trimmed row per (run, model)
        //    records what went with the cap's HONEST source. The priority ORDER
        //    is the only ordering — TOOL_LIMIT_TRIM_DISABLED was deleted
        //    2026-11-02 (RSW-1), its first-N default having baked out. ──
        toolsForModel = toolsForTurn;
        if (toolLimit && toolsForTurn.length > toolLimit) {
          const trimmed = trimToolsToLimit(toolsForTurn, toolLimit);
          toolsForModel = trimmed.tools;
          messages.push({ role: 'system', content: toolTrimSystemNote(trimmed, toolLimit, provider.model) });
          trimNotePushed = true;
          toolsTrimmed = { from: trimmed.from, to: trimmed.to, dropped: trimmed.dropped };
          const trimKey = toolLimitKey(provider.url, provider.model);
          if (!trimTelemetered.has(trimKey)) {
            trimTelemetered.add(trimKey);
            const source = limitDetail.source;
            // Designed behaviour (the endpoint's cap), once per (run, model): an
            // info line — the tool_list_trimmed row below is the record.
            logger.info(`coding agent [${agentLabel}]: ${provider.model} accepts at most ${toolLimit} tools (${source}) — sending ${trimmed.to} of ${trimmed.from} (dropped groups: ${trimmed.droppedGroups.join(', ') || 'long tail'})`);
            emit('progress', { message: `Tool list trimmed to ${provider.model}'s ${toolLimit}-tool limit (${trimmed.from} → ${trimmed.to}; dropped: ${trimmed.droppedGroups.join(', ') || 'long tail'})`, stage: 'tool-limit' });
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.TOOL_LIST_TRIMMED,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              value: trimmed.dropped.length, unit: 'tools',
              meta: { model: provider.model, limit: toolLimit, source, mode: 'priority', from: trimmed.from, to: trimmed.to, dropped: trimmed.dropped.slice(0, 80), droppedGroups: trimmed.droppedGroups, toolsTrimmed: { from: trimmed.from, to: trimmed.to, dropped: trimmed.dropped.slice(0, 80) } },
            });
          }
        }
      }
      // F2: consult_frontier_council is offered ONLY while the frontier council's trigger window is open (after the
      // reflect note) — appended after the groups / trim pass so a tool cap never hides it (it displaces the list's
      // last entry when the list already sits at the cap).
      if (frontierCouncil && !lastStep && frontierCouncil.offered()) {
        const fcSchema = frontierCouncil.toolSchema();
        toolsForModel = toolLimit !== undefined && toolsForModel.length >= toolLimit
          ? [...toolsForModel.slice(0, Math.max(0, toolLimit - 1)), fcSchema]
          : [...toolsForModel, fcSchema];
      }
      // build 2026-10-08 F-1: finish_run is appended LAST (after groups / trim) and only below a tool cap — it never
      // displaces a real tool; a capped seat gets the post-loop nudge only (record: offered false).
      if (finishRun && !lastStep && (toolLimit === undefined || toolsForModel.length < toolLimit)) {
        toolsForModel = [...toolsForModel, FINISH_RUN_SCHEMA as any];
        finishRun.noteOffered();
      }
      if (finishRun && !lastStep) finishRunLastTools = toolsForModel;
      const offeredNames = new Set<string>(toolsForModel.map((t) => t?.function?.name as string).filter(Boolean));
      // TRANSCRIPT REPAIR BELT (watch pass #4, 2026-09-08): a tool_calls turn
      // whose ids aren't contiguously answered 400s on EVERY model call until
      // healed — poisoned checkpoints from the inline-notice incident (and any
      // future early-batch-exit seam) must self-repair instead of wedging the
      // run. Pure rebuild; same-reference return means nothing was wrong.
      const repaired = repairToolCallTranscript(messages);
      if (repaired !== (messages as unknown[])) {
        messages.length = 0;
        messages.push(...(repaired as typeof messages));
        emit('progress', { message: 'Transcript had unanswered tool calls — repaired before the model call', stage: 'transcript-repair' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { seam: 'transcript_repair' },
        });
      }
      const turn = await runModelTurn(
        provider,
        messages,
        // Model-facing names (tool-scope.ts): the two cold `update_*` admin tools
        // are offered under names that share no prefix with hot tools; emitted
        // names are mapped back to internal names right after the turn.
        lastStep ? undefined : applyModelToolNames(toolsForModel), // force an answer on the final step
        {
          onReasoning: (d) => emit('reasoning', { delta: d }),
          onContent: (d) => {
            turnText += d;
            // Ticket 7345b333: never stream recognisable tool-call markup to a
            // live viewer. Once latched for this turn, content deltas stop being
            // forwarded (turnText still accumulates for the sanitized paths).
            // The answer itself still reaches the owner — the persisted row is
            // rendered after the run, and the transcript refetches it; what the
            // latch prevents is the raw markup appearing in REAL TIME.
            // NARROW on purpose: only UNAMBIGUOUS special-token shapes latch —
            // the ASCII-XML call element (tag AND argument child), the
            // fullwidth-bar native tokens, and the ▁tool separator. The broad
            // containsToolCallLeak also fires on the bare word "tool_calls",
            // which an honest answer (this repo's own agent discussing its tool
            // API) legitimately contains, and latching on that would blank a
            // whole legitimate turn's stream.
            // Cheap pre-gate: only a delta carrying a delimiter can start a leak.
            if (!streamLeakLatched && (d.includes('<') || d.includes('｜')) && (
              hasAsciiXmlToolCall(turnText) || turnText.includes('｜') || /▁tool/.test(turnText)
            )) {
              streamLeakLatched = true;
              emit('progress', { message: 'The model is emitting tool calls as plain text — suppressing the raw markup from this turn', stage: 'tool-markup-suppressed' });
            }
            if (!streamLeakLatched) emit('text', { delta: d });
          },
        },
        // Coding runs get the max stream window (owner max-out directive
        // 2026-07-22): a deep K3/GLM thinking turn can stream reasoning for
        // many minutes. Chat profiles keep the interactive 290s — their
        // runDeadlineMs latency contract is the binding constraint there.
        profile.kind === 'coding' ? 600_000 : 290_000,
        input.isCancelled, // abort the in-flight stream the instant Stop is pressed (even mid-thinking)
        // Deep-research council profiles (no wall clock, 2026-10-20): a token-idle stall watchdog instead of the
        // byte-idle socket kill — a silent stream is cut with ESTALL and retried by the transient lane below (never the
        // lead-seat-unreachable lane: ESTALL is not a connection failure).
        profile.streamStallMs ? { stallMs: profile.streamStallMs } : undefined,
      ).catch(async (err: any) => {
        const status = err?.response?.status;
        // Streaming requests carry the error body as a STREAM — consume it
        // (bounded) so 400s are diagnosable; JSON.stringify on the raw socket
        // is circular and killed runs before (2026-07-16). 2026-09-27: the
        // drain is shared with runModelTurn (drainAxiosErrorBody caches the
        // text on the error) — a body runModelTurn already read for its own
        // reasoning_effort fingerprint is not read twice.
        const bodyText = await drainAxiosErrorBody(err);
        // Ticket 189cfeb9: the drained body holds the provider's OWN reason
        // (e.g. Moonshot's {"error":{"message":…}} during the 2026-09-11
        // 400-incident window) — surface it on the turn so the terminal note
        // and loop telemetry carry the real cause instead of a status-only
        // guess. It also REPAIRS the billing-outage regex below, which was
        // blind to body-carried "insufficient balance" on streaming requests.
        const providerError = extractProviderErrorDetail(bodyText);
        // Ticket cffaa701: recover the provider's own requested wait (Retry-After
        // header) so the transient lane can honor the rate window instead of
        // hammering it. Absent header ⇒ undefined ⇒ the table alone decides.
        const retryAfterMs = parseRetryAfterHeader(err?.response?.headers?.['retry-after']);
        // Ticket d8078bc6 (log-signal family 5ae52ca3): a STATUS-LESS transport
        // abort ("aborted" — a premature gateway close, the f184 known signature)
        // is external degradation the loop is designed to survive (the transient
        // lane retries; failed_runs stays 0). Exactly the f184-conservative shape
        // and nothing wider gets logClass:'external' — HTTP 429/5xx turn failures
        // stay UNTAGGED (they are real, sweep-worthy load signals). The predicate
        // lives in turn-failure-classification.ts (import-free leaf) so the replay
        // test pins the real one.
        const transportAbort = isStatuslessTransportAbort({ message: err.message, status, bodyText });
        // Ticket 0ae066fe (log-signal family, 2026-10-30): a STATUS-LESS socket
        // reset ('read ECONNRESET', 22 rows / 10 hours) is the same class of
        // external degradation as the 'aborted' premature close just above —
        // the transient lane retries it and failed_runs stays 0 — but only the
        // exact 'aborted' wording carried logClass:'external', so a bare reset
        // sat untagged at warn and the sweep filed it as an internal fault.
        // Widening is safe for the sweep and does not lose the signal: a row
        // that DOES carry a status or a drained body stays untagged and
        // sweep-worthy (it is a real load/provider error), which is the exact
        // conservative axis turn-failure-classification.ts documents.
        const externalTransport = transportAbort || isExternalTransportFailure({ message: err.message, status, bodyText });
        agentWarn(`coding agent turn failed: ${err.message}${status ? ` (HTTP ${status})` : ''}${bodyText ? ` body: ${bodyText.slice(0, 400)}` : ''}`,
          externalTransport ? { logClass: 'external' } : undefined);
        return {
          content: '', reasoning: '', toolCalls: [] as StreamedToolCall[], finishReason: 'error',
          errorMessage: `${err.message || 'model request failed'}${providerError ? ` — provider: ${providerError}` : ''}`,
          errorStatus: status,
          ...(providerError ? { providerError } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        } as TurnResult;
      });

      // Map emitted tool names back to INTERNAL names (tool-scope.ts) — every
      // downstream seam (preflight, breakers, receipts, executor, evidence
      // tools) keys on internal names; the assistant record replays the name
      // the model actually emitted. A legacy alias emission is telemetered.
      for (const tc of turn.toolCalls) {
        const internal = internalToolName(tc.name);
        if (isLegacyAliasEmission(tc.name)) {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'tool_alias_used', outcome: 'observed', tool: tc.name, offeredAs: modelToolName(tc.name) },
          });
        }
        if (internal !== tc.name) { tc.emittedName = tc.name; tc.name = internal; }
      }

      // N8: label the pending reflection_route decision with what the lane
      // actually did on this completed turn (first tool called; null = prose
      // final). Error / cancelled turns are not a next step — keep waiting.
      if (pendingReflectionRoute && turn.finishReason !== 'error' && turn.finishReason !== 'cancelled') {
        const pending = pendingReflectionRoute;
        pendingReflectionRoute = null;
        try {
          const { labelReflectionRoute } = await import('./reflection');
          if (typeof labelReflectionRoute === 'function') labelReflectionRoute(pending, turn.toolCalls[0]?.name ?? null);
        } catch { /* labels never break the loop */ }
      }

      // Remove the transient per-turn notes (clock + plan reminder + evidence
      // ledger) so they don't accumulate in the transcript. They are ALWAYS
      // the trailing system messages (nothing pushes between the reminder
      // block and the turn); bound the removal to exactly what was pushed.
      if (reminderPushed || clockNotePushed || ledgerNotePushed || trimNotePushed || groupsNotePushed) {
        let toRemove = (reminderPushed ? 1 : 0) + (clockNotePushed ? 1 : 0) + (ledgerNotePushed ? 1 : 0) + (trimNotePushed ? 1 : 0) + (groupsNotePushed ? 1 : 0);
        while (toRemove > 0 && messages[messages.length - 1]?.role === 'system') {
          messages.splice(messages.length - 1, 1);
          toRemove--;
        }
      }

      // ── Stop pressed mid-turn (aborted the stream, even during thinking). Bail
      //    NOW with what we have — don't persist the partial turn as an answer.
      if (turn.finishReason === 'cancelled' || input.isCancelled?.()) {
        finalText = finalText || '(Stopped.)';
        parts.push(stampPart({ type: 'text', text: '⏹ Stopped by user.' }));
        done = true;
        break;
      }

      // ── A model API error is NOT a finish. The provider rejected the request
      //    and we recover by failure CLASS (2026-08-20 split):
      //      TRANSIENT (429/5xx/network): back off and retry the SAME request —
      //        a rate limit is not a size problem; compacting mutates the
      //        request and burns the rate budget for nothing (1e465443), and
      //        the old 2×5s budget died inside a per-minute rate window
      //        (039dceb8: 10 consecutive overnight runs lost).
      //      SIZE/MALFORMED (400/413/other): shrink (clip + compact) + retry.
      //    Only if recovery keeps failing do we stop — HONESTLY, never as a
      //    fake success.
      if (turn.finishReason !== 'error' && leadFallbackState === 'active') leadFallbackState = 'revert';
      if (turn.finishReason === 'error') {
        // ── LEAD SEAT REJECTED BY THE PROVIDER (owner 2026-09-17 "why isn't
        //    the fallback working so it just auto uses the fallback and then
        //    retries the chosen model the next turn"): a 429 / 5xx / billing
        //    suspension on the ORCHESTRATOR's seat moves THIS turn to the
        //    admin's coding_default custom fallback or the next servable
        //    built-in (helper-seat.ts pickLeadFallback), same request, no
        //    backoff; the chosen seat is retried on the next step (a billing
        //    suspension is sticky for the run — retries cannot help). Once per
        //    step; when nothing else is servable the lanes below stand.
        //    Kill switch: LEAD_SEAT_FALLBACK_DISABLED=1.
        const leadHttp = !input.fastSeat && !leadSeatFallbackDisabled() && !leadHttpFallbackThisStep
          ? leadSeatHttpFailure(turn)
          : null;
        if (leadHttp) {
          // audit 2026-10-06 T1-6: a gateway 502/503/504 tries candidates OFF the
          // failing endpoint first (helper-seat.ts orderFallbackCandidates).
          const fb = await pickLeadFallback(input.model, provider.model, input.userId, seatRoleRaw, { spec: seatModelSpec, httpStatus: turn.errorStatus }).catch(() => null);
          if (fb) {
            // Provider cooldown (autonomy loop #3): count the rejection; a trip
            // keeps later steps AND later runs off this provider without probing.
            if (leadHttp !== 'billing') {
              const trip = noteProviderRejection(provider.label);
              if (trip.tripped && trip.until) {
                cooldownNoticeUntil = trip.until;
                agentWarn(`coding agent: provider ${provider.label} tripped the cooldown breaker (${trip.strikes} rejections in ${Math.round(PROVIDER_COOLDOWN_WINDOW_MS / 1000)} s) — lead seats on it start on their fallback until ${new Date(trip.until).toISOString()}`);
                recordLoopMetric({
                  kind: LOOP_METRIC_KINDS.PROVIDER_COOLDOWN,
                  sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                  value: trip.strikes,
                  meta: { provider: provider.label, until: new Date(trip.until).toISOString(), httpStatus: turn.errorStatus ?? null, consecutive: trip.consecutive ?? 1, durationS: Math.round((trip.durationMs ?? PROVIDER_COOLDOWN_MS) / 1000) },
                });
              }
            }
            leadHttpFallbackThisStep = true;
            const sticky = leadHttp === 'billing';
            const failedLabel = provider.label;
            const failedSpec = seatModelSpec;
            // FO firing 38 (2026-09-28): a billing suspension ABSORBED by a healthy
            // fallback never reaches the modelError 'billing' lane below (the run
            // survives), so the 2026-08-25 run-death ticket never fires — the
            // Moonshot kimi-k3 suspension streamed 17 warns + seat_fallback rows
            // over 4 h with ZERO owner notification while every coding run paid a
            // 429+failover toll. File the SAME deduped owner-action ticket (title
            // dedup collapses repeats across runs/sessions; occurrences = ongoing)
            // on the FIRST sticky fallback of the run.
            const firstBillingThisRun = sticky && (!leadSeatFallback || leadSeatFallback.reason !== 'billing');
            if (firstBillingThisRun) {
              void import('../feedback/feedback.service')
                .then((m) => m.fileFeedbackTicket({
                  userId: input.userId,
                  type: 'mishap',
                  title: 'PROVIDER BILLING OUTAGE — model account suspended for insufficient balance (owner recharge needed)',
                  description: `A model-provider account is SUSPENDED for insufficient balance. The run SURVIVED on its seat fallback (${fb.model}${fb.custom ? ' — the admin\'s custom fallback' : ''}), but every dependent run pays a failed 429 round trip + failover until the OWNER recharges — the stamped seat stays the default. This is an owner-action item: no agent can fix it.\n\nProvider error (session ${input.sessionId}): ${String(turn.errorMessage || turn.providerError || '').slice(0, 400)}\n\nDedup note: repeats of this ticket across sessions collapse into this row via title dedup; occurrences count = ongoing outage.`,
                  priority: 5,
                  area: 'owner-action',
                  context: { sessionId: input.sessionId, class: 'provider_billing_absorbed', filedAt: new Date().toISOString() },
                }))
                .catch(() => { /* ticket filing is best-effort — the warn + telemetry stand */ });
            }
            for (const sk of fb.skipped) {
              // fe6f0b0b: a skipped candidate is the admin's signal — telemetered as unavailable, never served mislabeled.
              noteSeatFallback({ role: seatRoleKey, from: failedSpec, to: sk.to, reason: sk.reason, status: 'unavailable', caller: 'lead', httpStatus: turn.errorStatus, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
            }
            const firstThisRun = !leadSeatFallback;
            leadSeatFallback = { role: seatRoleKey, from: failedSpec, fromLabel: failedLabel, to: fb.model, reason: leadHttp, httpStatus: turn.errorStatus, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
            agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${failedSpec}) rejected the turn (${leadHttp}) — ${sticky ? 'rest of this run' : 'this turn'} on ${fb.model}`);
            emit('progress', {
              message: sticky
                ? `Coding seat ${failedLabel} is suspended for billing — the rest of this run uses ${fb.model}`
                : `Coding seat ${failedLabel} returned ${leadHttp} — this turn runs on ${fb.model}${fb.sameEndpointDeferred?.length ? ' (a gateway-level failure — other models on the same endpoint are tried last)' : ''}; ${failedLabel} is retried next turn`,
              stage: 'seat-fallback',
            });
            noteSeatFallback({
              role: seatRoleKey, from: failedSpec, to: fb.model, reason: leadHttp, status: 'retrying',
              caller: 'lead', httpStatus: turn.errorStatus, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              detail: turn.providerError || turn.errorMessage || undefined,
              ...(fb.sameEndpointDeferred?.length ? { sameEndpointDeferred: fb.sameEndpointDeferred } : {}),
            });
            // Never a silent swap (fe6f0b0b contract): ONE transcript note per run — the
            // per-turn revert/re-fallback cycle during a long outage stays in progress events.
            if (firstThisRun) {
              parts.push(stampPart({
                type: 'text',
                text: sticky
                  ? `⚠︎ SEAT FAILOVER: the model ${failedLabel} (${failedSpec}) is suspended for billing (${leadHttp}) — the rest of this run uses ${fb.model}${fb.custom ? ' (the admin\'s custom fallback)' : ''}. The owner must recharge that provider account.`
                  : `⚠︎ SEAT FAILOVER: the model ${failedLabel} (${failedSpec}) returned ${leadHttp} — this turn runs on ${fb.model}${fb.custom ? ' (the admin\'s custom fallback)' : ''}; ${failedLabel} is retried on the next turn.`,
              }));
            }
            applyRunProviderExtras(fb.provider);
            if (primaryContextBudget === undefined) { primaryContextBudget = contextBudget; primarySeatSpec = seatModelSpec; }
            provider = fb.provider;
            seatModelSpec = fb.model;
            contextBudget = fb.provider.contextChars ?? profile.contextCharBudget;
            if (sticky) { primaryProvider = fb.provider; primaryContextBudget = contextBudget; primarySeatSpec = seatModelSpec; leadFallbackState = 'none'; } else leadFallbackState = 'armed';
            grantRetryStep();
            continue; // retry this step on the fallback seat — same request
          }
        }
        // ── build 2026-10-08 C-2: MALFORMED TOOL-CALL HISTORY (run 99b4f357 — the gateway 400'd every turn on a
        //    `computer_task` call whose arguments were not valid JSON; backoff resent it, a mode:'full' compaction
        //    kept it in the verbatim recent window, the run failed). When the provider body names malformed tool-call
        //    arguments AND history really holds unparseable ones, re-serialise them (context-clearing.ts) and retry —
        //    no compaction, no backoff. Nothing to repair ⇒ the old lanes below. HISTORY_REPAIR_DISABLED=1. ──
        const malformedHistory = historyRepairs < MAX_HISTORY_REPAIRS_PER_RUN && !historyRepairDisabled() ? classifyMalformedToolHistory(turn) : null;
        if (malformedHistory) {
          const fixed = repairMalformedToolCallArguments(messages);
          recordLoopMetric({
            kind: CONTEXT_EDIT_KIND,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: fixed?.repaired ?? 0, unit: 'calls',
            meta: { event: 'history_repair', outcome: fixed ? 'repaired' : 'nothing_to_repair', status: malformedHistory.status, model: provider.model, attempt: historyRepairs + 1, chars: messagesChars(messages), ...(fixed ? { tools: fixed.tools } : {}), providerError: malformedHistory.detail },
          });
          if (fixed) {
            historyRepairs += 1;
            messages.length = 0;
            messages.push(...fixed.messages);
            emit('progress', { message: `The provider rejected a malformed tool call in the history — repaired ${fixed.repaired} call${fixed.repaired === 1 ? '' : 's'} and retrying`, stage: 'transcript-repair' });
            grantRetryStep();
            continue; // retry this step with the repaired history — no shrink, no backoff
          }
        }
        // ── PROVIDER CONTENT FILTER (audit 2026-10-08 W2-4, seat-invalid-request.ts):
        //    Alibaba's "DataInspectionFailed … inappropriate content" 400 took the
        //    spurious-400 transient lane — 5 backoffs of the IDENTICAL payload,
        //    then 2 useless shrinks, then "too large or malformed" (run 45c4f136
        //    failed after 87 min). Time and shrinking cannot change what the
        //    provider inspected: the FIRST hit fails this run over to the next
        //    seat in the chain (pickLeadFallback — no latch, the seat is fine for
        //    other content) and tells the model in one line; a second hit, or no
        //    servable fallback, ends the run with an honest note. A helper-seat
        //    worker on a custom endpoint keeps its own built-in-helper lane below.
        //    Kill switch CONTENT_FILTER_LANE_DISABLED=1. ──
        const contentFilter = !contentFilterLaneDisabled() && !(input.fastSeat && isCustomEndpointProvider(provider) && !helperSeatFallback)
          ? classifyContentFilter(turn)
          : null;
        if (contentFilter) {
          contentFilterHits += 1;
          const filteredLabel = provider.label;
          const filteredSpec = seatModelSpec;
          const filteredModel = provider.model;
          const fb = contentFilterHits === 1 && !input.fastSeat && !leadSeatFallbackDisabled()
            ? await pickLeadFallback(input.model, provider.model, input.userId, seatRoleKey).catch(() => null)
            : null;
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: messagesChars(messages), unit: 'chars',
            meta: { chars: messagesChars(messages), model: filteredModel, attempt: contentFilterHits, status: contentFilter.status, outcome: fb ? 'seat_fallback' : 'gave_up', lane: 'content_filter', ...(fb ? { to: fb.model } : {}), providerError: contentFilter.detail },
          });
          if (fb) {
            for (const sk of fb.skipped) {
              noteSeatFallback({ role: seatRoleKey, from: filteredSpec, to: sk.to, reason: sk.reason, status: 'unavailable', caller: 'lead', httpStatus: contentFilter.status, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
            }
            const reasonLine = `content_filter — ${contentFilter.detail}`.slice(0, 200);
            noteSeatFallback({ role: seatRoleKey, from: filteredSpec, to: fb.model, reason: reasonLine, status: 'retrying', caller: 'lead', httpStatus: contentFilter.status, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
            if (!leadSeatFallback) leadSeatFallback = { role: seatRoleKey, from: filteredSpec, fromLabel: filteredLabel, to: fb.model, reason: reasonLine, httpStatus: contentFilter.status, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
            agentWarn(`coding agent [${agentLabel}]: ${filteredLabel} (${filteredSpec}) refused the request with its content filter (${contentFilter.detail.slice(0, 160)}) — the rest of this run uses ${fb.model}`);
            emit('progress', { message: `The provider of ${filteredModel} refused this content (content filter) — the rest of this run uses ${fb.model}`, stage: 'seat-fallback' });
            parts.push(stampPart({ type: 'text', text: `⚠︎ PROVIDER CONTENT FILTER: the model ${filteredLabel} (${filteredSpec}) refused this request (provider said: ${contentFilter.detail.slice(0, 200)}) — no retry of the same content can pass it, so the rest of this run uses ${fb.model}${fb.custom ? " (the admin's custom fallback)" : ''}.` }));
            messages.push({ role: 'user', content: contentFilterModelNote({ from: filteredModel, to: fb.model }) });
            applyRunProviderExtras(fb.provider);
            provider = fb.provider;
            primaryProvider = fb.provider; // the inspected content stays in the transcript — the swap is sticky for the run
            seatModelSpec = fb.model;
            contextBudget = profile.kind === 'coding'
              ? (fb.provider.contextChars ?? profile.contextCharBudget)
              : Math.min(profile.contextCharBudget, fb.provider.contextChars ?? Number.POSITIVE_INFINITY);
            primaryContextBudget = contextBudget; primarySeatSpec = seatModelSpec;
            leadFallbackState = 'none';
            grantRetryStep();
            continue; // retry this step on the fallback seat (+ the one-line notice)
          }
          const note = `🛑 PROVIDER CONTENT FILTER: the model provider of ${filteredModel} refused this request${contentFilterHits > 1 ? ' again (after a seat failover)' : ''} — its content filter judged text in this conversation (usually a scraped / fetched tool result) inappropriate. Retrying or shrinking the same content cannot pass it${contentFilterHits === 1 ? ' and no fallback seat is servable here' : ''}. Provider said: ${contentFilter.detail.slice(0, 300)}`;
          parts.push(stampPart({ type: 'text', text: note }));
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          modelErrored = true;
          modelErrorStatus = contentFilter.status;
          modelErrorKind = 'content_filter';
          done = true;
          break;
        }
        // ── DETERMINISTIC INVALID-REQUEST REJECTION from a CUSTOM-endpoint LEAD
        //    seat (2026-09-27, the gpt-6-astra incident: the Fleet Supervisor on
        //    `cql-litellm:api-openai-gpt-6-astra` 400'd EVERY turn for 6 h — 48
        //    provider_rejected rows — "Invalid 'tools': array too long … maximum
        //    length 128 … got 195", then "Function tools with reasoning_effort are
        //    not supported … use /v1/responses or set reasoning_effort to 'none'").
        //    A 400/404/413/422 whose body carries a deterministic fingerprint
        //    (seat-invalid-request.ts) is not transient and not a size problem:
        //      (a) tools_too_long with a cap in the body → LEARN the cap and
        //          re-send THIS turn once with the list trimmed to it;
        //      (b) reasoning_effort refused → runModelTurn already retried once
        //          with reasoning_effort:'none' and latched it; a second sighting
        //          means 'none' failed too → (c);
        //      (c) everything else → LATCH the seat (SEAT_INVALID_REQUEST_LATCH_MIN,
        //          default 30 min; no later run on this process retries it) and
        //          move the REST OF THIS RUN to the seat's custom fallback / the
        //          built-in order (pickLeadFallback — the 429 cooldown's path).
        //    Never on a genuine content error (the model answered — not an HTTP
        //    error); never for the helper tier (its own lane above); when nothing
        //    else is servable the capability fail-fast below stands. ──
        const invalidReqRaw = !input.fastSeat && !leadHttpFallbackThisStep && isCustomEndpointProvider(provider)
          ? classifyInvalidRequest(turn)
          : null;
        // audit 2026-10-06 T1-1: on a FAMILY-inferred budget a context-too-long
        // 400 means OUR guess of the window was too big for this deployment —
        // the size lane below shrinks and learns a ceiling for the seat; a
        // 30-minute seat latch would instead move every run off the gateway.
        const invalidReq = invalidReqRaw && invalidReqRaw.kind === 'context_too_long'
          && isInferredContextSource(provider.contextCharsSource) && !registryContextFamilyDisabled()
          ? null
          : invalidReqRaw;
        if (invalidReq) {
          const limitKey = toolLimitKey(provider.url, provider.model);
          const sentTools = lastStep ? 0 : toolsForModel.length;
          if (invalidReq.kind === 'tools_too_long' && invalidReq.cap && invalidReq.cap < sentTools && (invalidRequestRetries.tools_too_long ?? 0) < 1) {
            // (a) the body names the cap — honour it from now on and re-send once.
            invalidRequestRetries.tools_too_long = (invalidRequestRetries.tools_too_long ?? 0) + 1;
            const learned = learnToolLimit(limitKey, invalidReq.cap);
            agentWarn(`coding agent [${agentLabel}]: ${provider.model} (${provider.label}) rejected ${sentTools} tools — the provider caps at ${learned} (learned from the 400 body); re-sending this turn with the list trimmed`);
            emit('progress', { message: `${provider.model} accepts at most ${learned} tools (sent ${sentTools}) — retrying this turn with the list trimmed`, stage: 'tool-limit' });
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              value: messagesChars(messages), unit: 'chars',
              meta: { chars: messagesChars(messages), model: provider.model, attempt: 0, status: invalidReq.status, outcome: 'trim_retry', lane: 'invalid_request', fingerprint: invalidReq.kind, cap: learned, tools: sentTools, providerError: invalidReq.detail },
            });
            grantRetryStep();
            continue; // the next iteration trims via the standard tool-limit path
          }
          // (c) latch + sticky fallback (also (b)'s second sighting).
          const latch = latchSeatInvalidRequest(seatModelSpec, invalidReq);
          const untilIso = latch ? new Date(latch.until).toISOString() : undefined;
          const fb = !leadSeatFallbackDisabled() ? await pickLeadFallback(input.model, provider.model, input.userId, seatRoleKey).catch(() => null) : null;
          const failedLabel = provider.label;
          const failedSpec = seatModelSpec;
          const reasonLine = `invalid_request:${invalidReq.kind} — ${invalidReq.detail}`.slice(0, 200);
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: messagesChars(messages), unit: 'chars',
            meta: { chars: messagesChars(messages), model: provider.model, attempt: 0, status: invalidReq.status, outcome: fb ? 'seat_fallback' : 'gave_up', lane: 'invalid_request', fingerprint: invalidReq.kind, tools: sentTools, ...(untilIso ? { latchedUntil: untilIso } : {}), providerError: invalidReq.detail },
          });
          if (fb) {
            leadHttpFallbackThisStep = true;
            for (const sk of fb.skipped) {
              noteSeatFallback({ role: seatRoleKey, from: failedSpec, to: sk.to, reason: sk.reason, status: 'unavailable', caller: 'lead', httpStatus: invalidReq.status, sessionId: input.sessionId, runId: input.runId, stamp: metricStamp });
            }
            const firstThisRun = !leadSeatFallback;
            leadSeatFallback = { role: seatRoleKey, from: failedSpec, fromLabel: failedLabel, to: fb.model, reason: reasonLine, httpStatus: invalidReq.status, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
            const untilClock = untilIso ? untilIso.slice(11, 19) + 'Z' : null;
            agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${failedSpec}) rejected the request deterministically (${INVALID_REQUEST_KIND_LABELS[invalidReq.kind]}: ${invalidReq.detail.slice(0, 160)}) — rest of this run on ${fb.model}${untilClock ? `; ${failedLabel} latched off until ${untilClock}` : ''}`);
            emit('progress', { message: `Seat ${failedLabel} cannot take this request (${INVALID_REQUEST_KIND_LABELS[invalidReq.kind]}) — the rest of this run uses ${fb.model}${untilClock ? `; ${failedLabel} is retried after ${untilClock}` : ''}`, stage: 'seat-fallback' });
            noteSeatFallback({
              role: seatRoleKey, from: failedSpec, to: fb.model, reason: reasonLine, status: 'retrying',
              caller: 'lead', httpStatus: invalidReq.status, fingerprint: invalidReq.kind, ...(untilIso ? { latchedUntil: untilIso } : {}),
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            });
            if (firstThisRun) {
              parts.push(stampPart({
                type: 'text',
                text: `⚠︎ SEAT FAILOVER: the model ${failedLabel} (${failedSpec}) rejected the request deterministically — ${INVALID_REQUEST_KIND_LABELS[invalidReq.kind]} (provider said: ${invalidReq.detail.slice(0, 200)}) — so the rest of this run uses ${fb.model}${fb.custom ? " (the admin's custom fallback)" : ''}${untilClock ? `; ${failedLabel} is retried after ${untilClock}` : ''}. Fix: ${invalidReq.kind === 'tools_too_long' ? 'set "max tools" on that model in Account → Admin → Endpoints (or run Detect capabilities)' : invalidReq.kind === 'reasoning_effort_unsupported' ? 'add `reasoning_effort: none` to that model group in the LiteLLM config, or route it via /v1/responses' : 'check the model entry in Account → Admin → Endpoints'}.`,
              }));
            }
            applyRunProviderExtras(fb.provider);
            provider = fb.provider;
            primaryProvider = fb.provider; // sticky: a deterministic rejection does not lapse mid-run
            seatModelSpec = fb.model;
            contextBudget = profile.kind === 'coding'
              ? (fb.provider.contextChars ?? profile.contextCharBudget)
              : Math.min(profile.contextCharBudget, fb.provider.contextChars ?? Number.POSITIVE_INFINITY);
            primaryContextBudget = contextBudget; primarySeatSpec = seatModelSpec;
            leadFallbackState = 'none';
            grantRetryStep();
            continue; // retry this step on the fallback seat — same request
          }
          // No servable fallback: the capability fail-fast lane below ends the
          // run honestly (CAPABILITY_REJECTION_RE covers both incident shapes).
          agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${failedSpec}) rejected the request deterministically (${invalidReq.kind}) and no fallback seat is servable here${untilIso ? ` — latched off until ${untilIso.slice(11, 19)}Z` : ''}`);
        }
        // BILLING/QUOTA SUSPENSION is NOT transient (2026-08-25: Moonshot served
        // "account ... suspended due to insufficient balance" as HTTP 429 for
        // 11 hours — 461 turns burned futile backoff-retries and NOBODY was
        // paged; only the owner can recharge). Fail fast with a clear note and
        // file ONE deduped owner-action ticket (fileFeedbackTicket's title
        // dedup collapses the repeats across sessions).
        const billing = /insufficient balance|exceeded_current_quota|suspended due to|billing details/i
          .test(turn.errorMessage || '');
        if (billing) {
          const note = `🛑 PROVIDER BILLING OUTAGE: the model provider rejected this turn because the account is suspended for insufficient balance — retries cannot help; the OWNER must recharge the provider account. Provider said: ${String(turn.errorMessage || '').slice(0, 300)}`;
          parts.push(stampPart({ type: 'text', text: note }));
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          modelErrored = true;
          modelErrorStatus = turn.errorStatus;
          modelErrorKind = 'billing';
          void import('../feedback/feedback.service')
            .then((m) => m.fileFeedbackTicket({
              userId: input.userId,
              type: 'mishap',
              title: 'PROVIDER BILLING OUTAGE — model account suspended for insufficient balance (owner recharge needed)',
              description: `A model-provider account is SUSPENDED for insufficient balance — every dependent run fails until the OWNER recharges. This is an owner-action item: no agent can fix it.\n\nProvider error (session ${input.sessionId}): ${String(turn.errorMessage || '').slice(0, 400)}\n\nDedup note: repeats of this ticket across sessions collapse into this row via title dedup; occurrences count = ongoing outage.`,
              priority: 5,
              area: 'owner-action',
              context: { sessionId: input.sessionId, class: 'provider_billing', filedAt: new Date().toISOString() },
            }))
            .catch(() => { /* ticket filing is best-effort — the loud final note stands */ });
          done = true;
          break;
        }
        // ── Helper-SEAT health fallback (owner 2026-09-14: "I switched the
        //    helper model in coding sessions over to our local cql spark qwen4b
        //    so im concerned that is not working"). Prod app_error_logs that day:
        //    "runModelTurn 400 fingerprint [spark-qwen3-4b-helper] tools=14" ×4
        //    — the custom gateway rejects the helper worker's tool-bearing turn
        //    outright, and the lanes below (3 backoffs of the SAME request, then
        //    2 shrinks) can never make it accept one. When THIS loop is a
        //    helper-seat worker (input.fastSeat ⇔ the delegate resolved the
        //    coding_helper seat) on a CUSTOM endpoint and the rejection is a
        //    4xx (not 401/403 — config errors surface) or a connection-level
        //    failure, move the worker to the BUILT-IN helper for the rest of
        //    its run and retry the turn there. Not a tool-less retry on the
        //    same seat: a worker exists to run tools, and a prose-only answer
        //    would narrate work it never did. Once per loop; the built-in must
        //    be servable here (keyless Edge falls through to the honest lanes).
        //    Kill switch: HELPER_SEAT_FALLBACK_DISABLED=1.
        const seatReason = input.fastSeat && !helperSeatFallback && !helperSeatFallbackDisabled()
          ? workerSeatFailureReason(provider, turn)
          : null;
        if (seatReason) {
          const builtIn = await resolveProviderForRun(HELPER_MODEL, input.userId, { fastSeat: true }).catch(() => null);
          if (builtIn && builtIn.apiKey && builtIn.model !== provider.model) {
            const failedLabel = provider.label;
            helperSeatFallback = { role: HELPER_SEAT_ROLE, from: input.model, fromLabel: failedLabel, to: HELPER_MODEL, reason: seatReason, httpStatus: turn.errorStatus, status: 'recovered' };
            agentWarn(`coding agent [${agentLabel}]: custom helper seat ${failedLabel} (${input.model}) rejected the turn (${seatReason}; tools=${lastStep ? 0 : toolsForTurn.length}) — continuing this worker on the built-in ${HELPER_MODEL}`);
            emit('progress', { message: `Helper seat ${failedLabel} failed (${seatReason}) — continuing on the built-in ${HELPER_MODEL}`, stage: 'seat-fallback' });
            noteSeatFallback({
              role: HELPER_SEAT_ROLE, from: input.model, to: HELPER_MODEL, reason: seatReason, status: 'retrying',
              caller: `worker:${opts.role ?? 'agent'}`, httpStatus: turn.errorStatus,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            });
            applyRunProviderExtras(builtIn);
            provider = builtIn;
            grantRetryStep();
            continue; // retry this step on the built-in helper — same request
          }
        }
        // ── LEAD SEAT UNREACHABLE (spark-cluster audit 2026-09-17, child
        //    1d39d145): the ORCHESTRATOR's own model is a CUSTOM endpoint the
        //    network cannot reach (connect ETIMEDOUT / ECONNREFUSED / no such
        //    host). Five backoffs of the same request can never fix a dead
        //    host, and the run used to end as an error note with zero tool
        //    calls. Move THIS run to the admin's custom fallback for the
        //    coding_default seat (owner 2026-09-15) or the built-in coding
        //    default, once per loop, same request — the built-in must be
        //    servable here. HTTP rejections never take this lane (the
        //    orchestrator that 400s stays un-re-seated, as pinned). Kill
        //    switch: LEAD_SEAT_FALLBACK_DISABLED=1.
        const leadReason = !input.fastSeat && !leadSeatFallback && !leadSeatFallbackDisabled()
          ? leadSeatConnectionFailure(input.model, turn, transientRecoveries)
          : null;
        if (leadReason) {
          const fb = await pickLeadFallback(input.model, provider.model, input.userId, seatRoleRaw).catch(() => null);
          if (fb) {
            const failedLabel = provider.label;
            leadSeatFallback = { role: seatRoleKey, from: input.model, fromLabel: failedLabel, to: fb.model, reason: leadReason, status: 'recovered', ...(fb.custom ? { customFallback: true } : {}) };
            agentWarn(`coding agent [${agentLabel}]: lead seat ${failedLabel} (${input.model}) is unreachable (${leadReason}; ${transientRecoveries} backoff(s) burned) — continuing this run on ${fb.model}`);
            emit('progress', { message: `Coding seat ${failedLabel} is unreachable (${leadReason}) — continuing this run on ${fb.model}`, stage: 'seat-fallback' });
            noteSeatFallback({
              role: seatRoleKey, from: input.model, to: fb.model, reason: leadReason, status: 'retrying',
              caller: 'lead', sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            });
            applyRunProviderExtras(fb.provider);
            provider = fb.provider;
            primaryProvider = fb.provider; // an unreachable host stays unreachable for this run
            leadFallbackState = 'none';
            grantRetryStep();
            continue; // retry this step on the fallback seat — same request
          }
        }
        // ── CAPABILITY / REQUEST-SHAPE REJECTION (rollout watch 2026-09-15,
        //    tick 16): the endpoint cannot serve the request as SENT — tool
        //    calling not enabled on a self-hosted vLLM, tools unsupported, an
        //    unknown parameter. Time cannot fix it and neither can shrinking:
        //    26 supervisor wakes died 7 retries each in one hour after the
        //    supervisor seat moved to a LiteLLM-fronted deepseek-v4.1-flash.
        //    Fail FAST with the provider's own words; the chat orchestrator's
        //    seat fallback finishes the turn on the built-in seat; ONE deduped
        //    owner-action ticket names the server-side fix (the seat itself is
        //    the owner's decision — never re-seated here).
        const capability = turn.errorStatus === 400
          && CAPABILITY_REJECTION_RE.test(turn.providerError || turn.errorMessage || '');
        if (capability) {
          const said = String(turn.providerError || turn.errorMessage || '').replace(/\s+/g, ' ').slice(0, 300);
          const note = `🛑 MODEL ENDPOINT REJECTED THE REQUEST SHAPE (HTTP 400): the seat's endpoint (${provider.model}) cannot serve this request as sent — usually tool calling is not enabled on the server (vLLM: --enable-auto-tool-choice --tool-call-parser) or a parameter is unsupported. Retries cannot help; this is a server-side configuration fix for the owner. Provider said: ${said}`;
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: messagesChars(messages), unit: 'chars',
            meta: { chars: messagesChars(messages), model: provider.model, attempt: 0, status: 400, outcome: 'gave_up', lane: 'capability', ...(turn.providerError ? { providerError: turn.providerError } : {}) },
          });
          parts.push(stampPart({ type: 'text', text: note }));
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          modelErrored = true;
          modelErrorStatus = 400;
          modelErrorKind = 'capability';
          void import('../feedback/feedback.service')
            .then((m) => m.fileFeedbackTicket({
              userId: input.userId,
              type: 'mishap',
              title: `SEAT MISCONFIGURED — ${provider.model} rejects tool-enabled requests (HTTP 400; owner: enable tool calling on the endpoint or re-seat)`,
              description: `The model endpoint serving seat model "${provider.model}" rejects the request SHAPE every agent turn sends (tools + tool_choice auto). No agent can fix it: enable tool calling on the server (vLLM: --enable-auto-tool-choice --tool-call-parser <parser>; LiteLLM: pass them through to the backend) or point the seat at a model that serves tools.\n\nProvider error (session ${input.sessionId}): ${said}\n\nWhile this stands, chat-orchestrator turns on this seat fall back to the built-in seat for the turn (telemetered as seat_fallback reason capability_rejected); coding runs on this seat fail fast with the note above.\n\nDedup note: repeats collapse into this row via title dedup; occurrences count = ongoing.`,
              priority: 5,
              area: 'owner-action',
              context: { sessionId: input.sessionId, class: 'seat_capability_rejection', model: provider.model, filedAt: new Date().toISOString() },
            }))
            .catch(() => { /* ticket filing is best-effort — the loud final note stands */ });
          done = true;
          break;
        }
        // ── SYSTEM-MESSAGE ORDER REJECTED (ticket 68167bbf, 2026-10-28): the
        //    seat's backend requires every system message to precede the first
        //    user turn — vLLM behind LiteLLM answers "messages[2].role is
        //    system; the system message must be first". runModelTurn already
        //    merges the trailing per-turn notes into ONE leading system block
        //    and retries once (the ONLY correct fix: the request SHAPE is
        //    wrong, and re-sending it byte-identically can never succeed). A
        //    rejection that SURVIVES that retry is therefore deterministic:
        //    before this lane it matched no fingerprint, so it fell to the
        //    spurious-in-budget-400 lane = 3 backoffs of the identical payload
        //    + 2 context shrinks on EVERY turn (the retry storm this ticket
        //    exists for: "coding agent turn failed: aborted" rows clustered
        //    right after the 400 bursts). Time and shrinkage cannot reorder
        //    messages — fail ONCE with the provider's own words. Gated on the SAME
        //    kill switch as the healing path above: SYSTEM_FIRST_NORMALIZE_DISABLED=1
        //    must restore the PRIOR retry lanes too (the ledger line promises a
        //    byte-for-byte revert, and an operator flipping it to undo a suspected
        //    bad interaction has to get prior behaviour back).
        if (turn.errorStatus === 400 && !systemFirstNormalizeDisabled() && isSystemOrderRejection(turn.providerError || turn.errorMessage)) {
          const said = String(turn.providerError || turn.errorMessage || '').replace(/\s+/g, ' ').slice(0, 300);
          const note = `🛑 MODEL REJECTED THE MESSAGE ORDER (HTTP 400): the endpoint serving ${provider.model} requires every system message to come BEFORE the first user turn, and it rejected the request even after the harness merged them into one leading system message. Retrying cannot reorder a request — this is a server-side chat-template requirement (vLLM: --chat-template / LiteLLM: system-first enforcement). Provider said: ${said}`;
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: messagesChars(messages), unit: 'chars',
            meta: { chars: messagesChars(messages), model: provider.model, attempt: 0, status: 400, outcome: 'gave_up', lane: 'message_order', ...(turn.providerError ? { providerError: turn.providerError } : {}) },
          });
          agentWarn(`coding agent [${agentLabel}]: ${provider.model} (${provider.label}) rejected the message ORDER (HTTP 400) even after the system-first merge — failing fast (no retry: reordering is the only fix and it was applied): ${said.slice(0, 200)}`);
          parts.push(stampPart({ type: 'text', text: note }));
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          modelErrored = true;
          modelErrorStatus = 400;
          modelErrorKind = 'capability';
          done = true;
          break;
        }
        // Ticket 4251dcb3 (2026-09-11): during a provider-side 400-incident
        // window (Moonshot rejected EVERY request for hours), IN-BUDGET
        // transcripts (34k–231k chars vs an ~800k budget) died "too large or
        // malformed … 2 compact-and-retry attempts exhausted" — the size lane
        // can never fix a rejection that is not about size, and each later
        // re-send succeeded once the window passed. A 400 on an in-budget
        // transcript whose drained provider body does NOT name a size/token
        // cause is SPURIOUS — the remedy is TIME, not shrinkage — so it takes
        // the transient backoff lane FIRST (SAME request resent — the
        // transcript stays intact for the owner-facing continuation). When the
        // transient budget is spent the spurious term lapses and the shrink
        // lane still gets its chance: a REAL acceptance ceiling under our
        // char budget (the remediation-P1 oversize class) keeps converging,
        // just ~100s later. When the provider body DOES name size/tokens,
        // trust it immediately — the provider's token count can exceed our
        // char estimate, and the shrink lane is the right answer there.
        // (Review N1: the pattern also covers Anthropic-style "prompt is too
        // long" and Zhipu's Chinese overlength phrasing — GLM-5.3 is the
        // default coding seat; review N4: the lane's at-scale shrink still
        // applies above 400k chars from the 2nd backoff — the 4251dcb3
        // incident class was 34k–231k, so incident transcripts stay intact.)
        const providerNamesSize = /context.?length|too many tokens|maximum context|too large|reduce the (length|size)|request.{0,24}(too large|too long)|prompt is too long|exceed.{0,32}(context|token|length|limit)|(长度|上下文|令牌|token).{0,12}(超出|超过|限制)|(超出|超过).{0,12}(限制|长度|上下文|令牌)/i
          .test(turn.providerError || '');
        const spuriousSizeRejection = turn.errorStatus === 400
          && messagesChars(messages) <= contextBudget
          && !providerNamesSize;
        // 2026-09-29: a 402/403 usage-limit / quota rejection (a gateway key
        // out of its plan window — provider-quota.ts) is TRANSIENT too: back
        // off and retry the same request; never shrink.
        const transient = turn.errorStatus === 429 || (turn.errorStatus && turn.errorStatus >= 500)
          || isProviderQuotaRejection(turn)
          || /ECONNRESET|ETIMEDOUT|ESTALL|socket hang up/i.test(turn.errorMessage || '')
          // 2026-09-29: a STATUS-LESS stream abort from the gateway ("aborted", a
          // premature close) on a transcript well under budget is transport,
          // not size — never the shrink lane (bench v3e: 39k of 160k shrunk).
          || (!turn.errorStatus && !providerNamesSize && messagesChars(messages) <= contextBudget
            && /\baborted\b|premature close|ECONNABORTED|EPIPE|other side closed|terminated|stream (?:ended|closed)/i.test(turn.errorMessage || ''))
          || (spuriousSizeRejection && transientRecoveries < MAX_TRANSIENT_RECOVERIES);
        // Telemetry: PROVIDER_REJECTED rows are emitted ONCE per rejection at
        // the outcome sites below (shrink_retry / gave_up — remediation P1),
        // each carrying the P0 metric stamp. (Integration 2026-09-09: P0's
        // separate pre-outcome emission here double-counted every rejection.)
        const totalRecoveries = modelErrorRecoveries + transientRecoveries;
        const canRecover = totalRecoveries < MAX_TOTAL_RECOVERIES && (transient
          ? transientRecoveries < MAX_TRANSIENT_RECOVERIES
          : modelErrorRecoveries < MAX_MODEL_ERROR_RECOVERIES);
        if (canRecover) {
          const st = turn.errorStatus;
          if (transient) {
            transientRecoveries += 1;
            // 429 AT SCALE (2026-08-24: the nightly engineer stalled at ~551k
            // chars — every retry re-spent most of a tokens-per-minute window,
            // so pure backoff could never ride it out). From the SECOND
            // transient failure on a LARGE transcript, shrink as well as wait:
            // deterministic clip always, LLM compaction best-effort. Small
            // transcripts keep the 1e465443 behavior (backoff only — compaction
            // there burned rate budget for nothing).
            const LARGE_TRANSCRIPT_CHARS = 400_000;
            if (transientRecoveries >= 2 && messagesChars(messages) > LARGE_TRANSCRIPT_CHARS) {
              let recovered = clipOversizedMessages(messages);
              try {
                // mode 'full': a provider-rejected request needs the aggressive
                // v1-shaped cut, not the gentle oldest-third pass.
                const c = await compactMessages(recovered, input.sessionId, { mode: 'full' });
                if (c) recovered = c;
              } catch { /* compaction itself may be rate-limited — the clip still shrinks */ }
              messages.length = 0;
              messages.push(...recovered);
              compactionCount += 1;
              emit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount });
            }
            // Rate-limit-aware wait (cffaa701): table value (±25% jitter on the
            // built-in defaults — concurrent lanes stop retrying in lockstep on
            // the shared provider bucket), raised to the provider's Retry-After
            // floor when it sent one (capped). Env-set tables stay exact.
            const waitMs = computeTransientWaitMs({
              attempt: transientRecoveries,
              tableMs: TRANSIENT_BACKOFF.tableMs,
              retryAfterMs: turn.retryAfterMs,
              retryAfterCapMs: RETRY_AFTER_CAP_MS,
              jitter: TRANSIENT_BACKOFF.jitter,
            });
            const tableValue = TRANSIENT_BACKOFF.tableMs[Math.min(transientRecoveries, TRANSIENT_BACKOFF.tableMs.length) - 1] ?? 0;
            // Marker only when the Retry-After floor CLEARLY raised the wait
            // above the nominal table value — jitter alone (or a floor below
            // the table) must never claim the header was honored.
            const retryAfterFloor = turn.retryAfterMs !== undefined ? Math.min(turn.retryAfterMs, RETRY_AFTER_CAP_MS) : 0;
            const raNote = retryAfterFloor > tableValue ? " — honoring the provider's Retry-After" : '';
            emit('progress', { message: `Provider hiccup${st ? ` (HTTP ${st})` : ''} — backing off ${Math.round(waitMs / 1000)}s and retrying (${transientRecoveries}/${MAX_TRANSIENT_RECOVERIES})${raNote}`, stage: 'compact' });
            // Cancel-aware wait: the loop-top stop check only runs between
            // steps, so poll the flag here — Stop must stay responsive during
            // a long backoff (PR #285 review; the cancelled branch at loop top
            // handles the rest when we continue).
            for (let waited = 0; waited < waitMs && !input.isCancelled?.(); waited += 250) {
              await new Promise(r => setTimeout(r, Math.min(250, waitMs - waited)));
            }
            grantRetryStep();
            continue; // retry this step with the SAME request — time, not shrinkage
          }
          modelErrorRecoveries += 1;
          const rejectedChars = messagesChars(messages);
          // audit 2026-10-06 T1-1: a FAMILY-inferred budget that the server
          // rejected by SIZE was a guess too big for this deployment — learn a
          // ceiling (85 % of what was rejected, ≥ the 160k default) so this and
          // later runs compact below it instead of re-hitting the wall.
          if (providerNamesSize && isInferredContextSource(provider.contextCharsSource) && !registryContextFamilyDisabled()) {
            const ceiling = learnContextCharCeiling(provider, rejectedChars);
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.CONTEXT_BUDGET,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              value: ceiling, unit: 'chars',
              meta: { model: provider.model, source: provider.contextCharsSource ?? 'family', budget: contextBudget, ceiling, rejectedChars, status: turn.errorStatus ?? null, outcome: 'ceiling_learned' },
            });
          }
          let recovered = clipOversizedMessages(messages);
          if (messagesChars(recovered) > effectiveContextBudget()) {
            // mode 'full': size-rejection recovery wants the aggressive cut.
            const c = await compactMessages(recovered, input.sessionId, { mode: 'full' });
            if (c) recovered = c;
          }
          // ── Oversize shrink-retry (remediation P1): 4 firings died "too large
          // or malformed" at 178k–439k chars vs an 800k budget — UNDER budget,
          // so the compact above no-oped, every message was under the 14k
          // per-message cap so the clip no-oped too, and both retries resent
          // the IDENTICAL payload (runs ended with ZERO tools run). Shrink the
          // largest tool-result bodies (head/tail excerpts, ids kept,
          // largest-first) toward HALF the rejected size so every retry is
          // strictly smaller.
          {
            const target = Math.floor(messagesChars(recovered) / 2);
            const shrunk = shrinkLargestToolResults(recovered, target);
            if (shrunk) recovered = shrunk;
          }
          messages.length = 0;
          messages.push(...recovered);
          compactionCount += 1;
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            value: rejectedChars, unit: 'chars',
            meta: { chars: rejectedChars, retryChars: messagesChars(messages), model: provider.model, attempt: modelErrorRecoveries, status: st ?? undefined, outcome: 'shrink_retry', ...(turn.providerError ? { providerError: turn.providerError } : {}) },
          });
          emit('progress', {
            message: `Model rejected the request${st ? ` (HTTP ${st})` : ''} — shrank context (${Math.round(rejectedChars / 1000)}k → ${Math.round(messagesChars(messages) / 1000)}k chars) and retrying (${modelErrorRecoveries}/${MAX_MODEL_ERROR_RECOVERIES})`,
            stage: 'compact',
          });
          emit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount });
          grantRetryStep();
          continue; // retry this step with a smaller request
        }
        // ── MAIN-SEAT transient failover (ticket fe6f0b0b, 2026-09-17): a
        //    coding run whose seat died TRANSIENTLY (429/5xx/connection — the
        //    incident: the spark LiteLLM gateway 500ing through a deploy
        //    window, "Received Model Group=spark-glm-5.3-flash Available Model
        //    Group Fallbacks=None") used to die here even when a second source
        //    could serve the SAME turn. Backoff rides out blips FIRST (the
        //    lane above); only once the transient budget is spent, walk the
        //    seat's failover chain — each candidate ONCE per run: the admin's
        //    custom fallback for the coding seat (Account → Admin → Endpoints
        //    → Model roles → Workspace default), then — when the failed seat
        //    is a custom endpoint — the built-in glm-5.3 safety net. A
        //    candidate must be SERVABLE here (keyless Edge fails closed on a
        //    probe error, same as chat-agent). Never silent: progress event +
        //    transcript note + seat_fallback telemetry + the run result's
        //    seatFallback. Coding profiles only (chat seats keep their
        //    post-turn fallback in chat-agent); never the helper tier (its own
        //    lane above); never the billing/capability classes (their own
        //    fast-fail lanes). Kill switch: CODING_SEAT_FALLBACK_DISABLED=1.
        // Review nits (sub-session 686bfe19, MERGE-SAFE): nit 4 — parser mirrors
        // the helper sibling (1/true/on, helper-seat.ts:44-47); nit 3 — the
        // chain is deduped in-loop (an admin fallback of glm-5.3 used to probe
        // the same candidate twice); nit 2 — a colon candidate whose registry
        // row is DEAD falls through resolveProviderForRun to a built-in
        // (fail-open): latching it would serve that built-in under the dead
        // spec's NAME (the exact silent-mislabel this feature forbids) — skip
        // it (the built-in leg offers glm-5.3 properly labeled), and skip any
        // candidate that resolves to the CURRENT serving model (no-op hop —
        // the helper lane's builtIn.model !== provider.model guard).
        const seatFallbackEnv = String(process.env.CODING_SEAT_FALLBACK_DISABLED ?? '').trim().toLowerCase();
        if (transient && profile.kind === 'coding' && !input.fastSeat
          && seatFallbackEnv !== '1' && seatFallbackEnv !== 'true' && seatFallbackEnv !== 'on') {
          const chain: Array<{ to: string; custom: boolean }> = [];
          const customFallback = await resolveRoleFallbackForRun('coding_default');
          if (customFallback && customFallback !== seatModelSpec && !codingSeatFailoverTried.has(customFallback)) {
            chain.push({ to: customFallback, custom: true });
          }
          if (seatModelSpec.includes(':') && !codingSeatFailoverTried.has('glm-5.3')) {
            chain.push({ to: 'glm-5.3', custom: false });
          }
          // audit 2026-10-06 T1-6: a gateway-level 5xx — the admin's fallback on
          // the SAME endpoint label goes after the built-in safety net.
          const chainOrder = orderFallbackCandidates(chain.map((c) => c.to), seatModelSpec, turn.errorStatus);
          if (chainOrder.deferred.length) chain.sort((a, b) => chainOrder.order.indexOf(a.to) - chainOrder.order.indexOf(b.to));
          let failedOver = false;
          for (const cand of chain) {
            if (codingSeatFailoverTried.has(cand.to)) continue; // nit 3: dedupe
            codingSeatFailoverTried.add(cand.to);
            const unservable = await seatUnservableReason(cand.to, input.userId).catch(() => 'servability probe failed');
            if (unservable) {
              agentWarn(`coding agent [${agentLabel}]: coding seat ${provider.label} (${seatModelSpec}) is down transiently and its ${cand.custom ? 'custom fallback' : 'built-in fallback'} ${cand.to} cannot serve here (${unservable})`);
              noteSeatFallback({
                role: 'coding_default', from: seatModelSpec, to: cand.to, reason: 'transient', status: 'unavailable',
                caller: `agent:${opts.role ?? 'coding'}`, httpStatus: turn.errorStatus,
                sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              });
              continue;
            }
            const next = await resolveProviderForRun(cand.to, input.userId).catch(() => null);
            if (!next) continue;
            // Nit 2: a colon candidate whose registry row is DEAD falls through
            // resolveProviderForRun to a built-in (fail-open) — latching it
            // would serve that built-in under the dead spec's NAME in
            // seatFallback.to / the transcript part (the exact silent-mislabel
            // this feature forbids). Skip it: the built-in leg offers glm-5.3
            // properly labeled. A BUILT-IN candidate resolving to the current
            // serving model is a no-op hop (helper lane's builtIn.model !==
            // provider.model guard) — skip silently. (A colon candidate
            // genuinely resolving to a custom endpoint with the same model id
            // is a DISTINCT source — different url/key — and proceeds.)
            const fellThrough = cand.to.includes(':') && !next.label.endsWith('(custom endpoint)');
            const noOpHop = !cand.to.includes(':') && next.model === provider.model;
            if (fellThrough || noOpHop) {
              if (fellThrough) {
                agentWarn(`coding agent [${agentLabel}]: coding seat fallback spec ${cand.to} no longer resolves to a custom endpoint (registry fell through to ${next.model}) — skipping it so the run never serves under a dead spec's name`);
                noteSeatFallback({
                  role: 'coding_default', from: seatModelSpec, to: cand.to, reason: 'fallback spec unresolved (registry fell through to a built-in)', status: 'unavailable',
                  caller: `agent:${opts.role ?? 'coding'}`, httpStatus: turn.errorStatus,
                  sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                });
              }
              continue;
            }
            applyRunProviderExtras(next);
            const fromLabel = provider.label;
            const fromSpec = seatModelSpec;
            provider = next;
            seatModelSpec = cand.to;
            // Re-size the transcript budget to the failover seat's window — a
            // registry fallback's conservative 160k must not inherit glm-5.3's
            // 4M (and a bigger failover seat legitimately WIDENS it).
            contextBudget = next.contextChars ?? profile.contextCharBudget;
            transientRecoveries = 0; // a fresh backoff table on the new seat
            codingSeatFallback = {
              role: 'coding_default', from: fromSpec, fromLabel, to: cand.to,
              reason: `transient HTTP ${turn.errorStatus ?? 'connection error'}`, httpStatus: turn.errorStatus,
              status: 'recovered', ...(cand.custom ? { customFallback: true } : {}),
            };
            agentWarn(`coding agent [${agentLabel}]: coding seat ${fromLabel} (${fromSpec}) kept failing transiently (${turn.errorStatus ?? 'connection-level'}) through the backoff budget — continuing this run on ${cand.custom ? "the admin's custom fallback" : 'the built-in'} ${cand.to}`);
            emit('progress', { message: `Coding seat ${fromLabel} is down (transient HTTP ${turn.errorStatus ?? 'error'}) — failing over to ${cand.custom ? 'the custom fallback' : 'built-in'} ${cand.to} for the rest of this run`, stage: 'seat-fallback' });
            noteSeatFallback({
              role: 'coding_default', from: fromSpec, to: cand.to, reason: 'transient', status: 'retrying',
              caller: `agent:${opts.role ?? 'coding'}`, httpStatus: turn.errorStatus,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            });
            parts.push(stampPart({
              type: 'text',
              text: `⚠︎ SEAT FAILOVER: the coding model ${fromLabel} (${fromSpec}) kept failing transiently (HTTP ${turn.errorStatus ?? 'connection error'}) through every backoff retry — continuing THIS run on ${next.label} (${cand.to}) so the work survives the provider outage. The stamped seat resumes on the next run; the swap is telemetered (seat_fallback) and named here, never silent.`,
            }));
            grantRetryStep();
            failedOver = true;
            break;
          }
          if (failedOver) continue; // retry this step on the failover seat — SAME request
        }
        let note = modelErrorTerminalNote({
          errorStatus: turn.errorStatus,
          errorMessage: turn.errorMessage,
          providerError: turn.providerError,
          transcriptChars: messagesChars(messages),
          contextBudget,
          // Count EVERY recovery the streak burned (ticket 4251dcb3 + review
          // N3): the lanes can interleave (spurious backoffs, then a
          // size-named final — or shrinks, then a 429) and counting only the
          // final lane re-creates the "2 compact-and-retry attempts
          // exhausted" miscount while 3 backoffs also ran.
          attempts: transientRecoveries + modelErrorRecoveries,
          recoveryLabel: transientRecoveries > 0 && modelErrorRecoveries > 0
            ? 'recovery'
            : transient ? 'backoff-and-retry' : undefined,
          // Ticket 6d633649: the note lands in an END-USER chat bubble on
          // chat-profile runs — speak plainly there; the operator evidence
          // (chars vs budget, provider body) stays in the provider_rejected
          // metric meta + progress events. Coding keeps the dense note.
          audience: profile.kind === 'coding' ? 'operator' : 'user',
        });
        // Ticket fe6f0b0b: when the run dies AFTER failover candidates were
        // tried (all unservable, or the failover seat itself died too), the
        // note names them — "no fallback existed" and "the fallback died too"
        // are different operator stories.
        if (transient && codingSeatFailoverTried.size) {
          note += ` Seat failover was ${codingSeatFallback ? 'also exhausted' : 'attempted'} (${[...codingSeatFailoverTried].join(' / ')}) — no second source could serve the turn.`;
        }
        // Give-up telemetry (remediation P1 — terminal outcome; ticket
        // 6d633649: a PURE transient give-up emitted ZERO provider_rejected
        // rows — the 429 incident class was invisible in loop_metrics and the
        // chat-audience note no longer carries the operator detail, so the
        // queryable row is the only engineering evidence left). Emit for BOTH
        // lanes, tagged by lane.
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.PROVIDER_REJECTED,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          value: messagesChars(messages), unit: 'chars',
          meta: { chars: messagesChars(messages), model: provider.model, attempt: transient ? transientRecoveries : modelErrorRecoveries, status: turn.errorStatus ?? undefined, outcome: 'gave_up', lane: transient ? 'transient' : 'size', ...(turn.providerError ? { providerError: turn.providerError } : {}) },
        });
        parts.push(stampPart({ type: 'text', text: `⚠︎ ${note}` }));
        finalText = finalText ? `${finalText}\n\n${note}` : note;
        modelErrored = true;
        modelErrorStatus = turn.errorStatus;
        modelErrorKind = transient || spuriousSizeRejection ? 'transient' : 'size';
        done = true;
        break;
      }

      // ── Token/cost meter: record every turn the provider actually served —
      //    INCLUDING repetition-aborted ones (their discarded output was real,
      //    often large, spend). Only request-rejected turns (finishReason
      //    'error', handled above) are skipped: nothing was generated.
      usageAcc.record(
        // Seat-label fix (2026-09-25): a loop metered under a seat other than
        // its worker role (the L2 reconcile pass — the LEAD model in the
        // cross_checker worker shape) records under that seat AND its own row
        // key. Rows are keyed agent+model, so with a lead override on the
        // checker's vendor the pass would otherwise MERGE into the real
        // checker's row and keep 'cross_checker' (prod run rmuheibibik4zav).
        opts.usageRole ? `${agentLabel} (${opts.usageRole})` : agentLabel,
        provider.model,
        turn.usage
          // cachedTokens (audit #8 rider): cache-served prompt tokens ride into
          // the accumulator so cost records show cache effectiveness.
          ? {
              promptTokens: turn.usage.promptTokens,
              completionTokens: turn.usage.completionTokens,
              ...(typeof turn.usage.cachedTokens === 'number' ? { cachedTokens: turn.usage.cachedTokens } : {}),
              estimated: false,
            }
          : estimateTurnUsage(
              promptCharsBefore,
              (turn.content?.length || 0) + (turn.reasoning?.length || 0)
                + turn.toolCalls.reduce((s: number, tc: StreamedToolCall) => s + tc.arguments.length + tc.name.length, 0),
            ),
        opts.usageRole ?? opts.role,
        // audit 2026-10-08 W3-4: the spend rows key a custom endpoint by its spec (pricing stays on the bare id).
        spendModelKey(provider) !== provider.model ? spendModelKey(provider) : undefined,
      );
      // build 2026-10-08 C: the gauge observes the served turn (pre-rot rows, tier-1 shadow) and the `context`
      // event carries THIS turn's prompt / cached tokens (cumulative usage alone hid the per-turn series).
      const gaugeTurn = contextGauge?.observeTurn({ step, model: provider.model, usage: turn.usage ?? null, messages, toolCalls: turn.toolCalls }) ?? null;
      if (topLevel) emit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount, usage: usageAcc.snapshot(), sessionUsage: sessionUsageView(), ...(gaugeTurn ? { turn: gaugeTurn } : {}) });

      // ── The model looped on itself (degenerate repetition, caught mid-stream).
      //    Don't persist the garbage — nudge it to be concise and retry (bounded).
      if (turn.finishReason === 'repetition') {
        if (repetitionRetries < MAX_REPETITION_RETRIES) {
          repetitionRetries += 1;
          messages.push({ role: 'system', content: 'Your previous reply started repeating the same text over and over. Stop. Respond concisely: either call exactly one tool to take the next concrete step, or give a brief final answer — do not restate what you already said.' });
          emit('progress', { message: `Model output was repeating — nudged to continue concisely (${repetitionRetries}/${MAX_REPETITION_RETRIES})`, stage: 'reflect' });
          grantRetryStep();
          continue; // retry this step; the garbage turn is never recorded
        }
        const note = 'The coding model kept degenerating into looping output. Stopping here rather than continuing incoherently — try narrowing the task or starting a fresh session.';
        parts.push(stampPart({ type: 'text', text: `⚠︎ ${note}` }));
        finalText = finalText ? `${finalText}\n\n${note}` : note;
        modelErrored = true;
        modelErrorKind = 'repetition';
        done = true;
        break;
      }
      modelErrorRecoveries = 0; // a good turn refreshes the recovery budgets
      transientRecoveries = 0;
      repetitionRetries = 0;
      // …and clears the provider-gave-up stamp (a RESUMED run rehydrates
      // modelErrored from its checkpoint — a good turn proves the provider is
      // serving again, so the result must not report a stale give-up).
      modelErrored = false;
      modelErrorStatus = undefined;
      modelErrorKind = undefined;

      // ── LEAKED-CALL LOOP BREAK (ticket 7345b333, 2026-11-02) ────────────────
      // The owner's chat UI carried ~50 near-identical
      // `<tool_call><function=todo_update><parameter=todoId>0946fc49…` blocks in
      // one turn, each followed by a "Used 1 tool" row, and the run kept
      // spending. Every existing breaker was structurally blind to it: the
      // tool-repeat legs count STRUCTURED tool calls (these were TEXT, so the
      // call that repeated was invisible to them), the line-repeat leg keys on
      // identical lines (each copy was reworded slightly), and the leak lane's
      // bounded retry sees one turn at a time. Two legs, both ending the run
      // honestly rather than finalizing a wall of angle brackets:
      //   (a) VOLUME — one turn emitting ≥ LEAKED_CALL_VOLUME_BREAK markup calls
      //       is a decoder lock, not work;
      //   (b) REPEAT — the SAME markup call (digits collapsed) across 3
      //       consecutive turns, the cross-turn twin of the exact-signature
      //       breaker that only watches real calls.
      // Fenced blocks are masked by the sanitizer, so an answer that ILLUSTRATES
      // the markup (this repo's own docs do) never trips either leg.
      {
        const leakedCount = countAsciiXmlToolCalls(turn.content || '');
        const leakedSigs = asciiXmlToolCallSignatures(turn.content || '');
        const leakedSig = leakedSigs.length ? [...leakedSigs].sort().join('||') : '';
        if (leakedSig && leakedSig === lastLeakedCallSig) leakedCallRepeat += 1;
        else { leakedCallRepeat = 0; lastLeakedCallSig = leakedSig; }
        const volumeBreak = leakedCount >= LEAKED_CALL_VOLUME_BREAK;
        const repeatBreak = leakedCallRepeat >= LEAKED_CALL_REPEAT_BREAK;
        if (volumeBreak || repeatBreak) {
          const shape = volumeBreak
            ? `${leakedCount} tool calls as PLAIN-TEXT markup in one turn`
            : `the SAME tool call as PLAIN-TEXT markup ${leakedCallRepeat + 1} turns in a row`;
          const note = `[HARNESS] Run ended: the model emitted ${shape} instead of using the structured tool-calling API, so NONE of those calls executed and nothing was changed by them. The next scheduled firing starts fresh.`;
          parts.push(stampPart({ type: 'text', text: note, marker: 'guard' }));
          emit('guard_marker', { text: note, struckPrev: false });
          emit('progress', { message: `Run ended: ${shape} (none executed)`, stage: 'leaked-call-break' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: {
              seam: 'leaked_call_loop_break', state: 'ended_run',
              leg: volumeBreak ? 'volume' : 'repeat',
              count: leakedCount, repeats: leakedCallRepeat + 1,
              tool: leakedSigs[0]?.split(':')[0],
            },
          });
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          done = true;
          break;
        }
      }
      const cleanText = stripToolCallMarkup(turn.content || '');
      if (cleanText.trim()) parts.push(stampPart({ type: 'text', text: cleanText }));
      // ── DURABLE INTERMEDIATE DELIVERABLES (P4 CanLaw L4): a substantial
      // mid-run assistant text on a TOOL-CALLING turn is superseded by
      // construction — it never becomes finalText, and downstream consumers
      // (journal, digests, next-run history) read only the final. When it
      // cites ≥1 of this run's harness receipt ids (a receipt-backed artifact:
      // a diff summary, a results table after tool output), offload it to
      // session memory so search_memory can recover it. Bounded ≤5/run,
      // ≥600 chars, orchestrator only (workers already offload their digests).
      if (topLevel && turn.toolCalls.length > 0 && cleanText.length >= 600 && intermediateOffloads < 5) {
        const lowerText = cleanText.toLowerCase();
        const citesReceipt = receiptCollector.some((r) => lowerText.includes(r.id.toLowerCase().slice(0, 8)));
        if (citesReceipt) {
          intermediateOffloads += 1;
          void storeFindings(input.sessionId, 'intermediate', [
            { ref: `intermediate:${input.runId ?? 'run'}:${step}`, content: cleanText },
          ]).catch(() => 0);
        }
      }
      // Cap the assistant content stored in context — a large (or borderline-
      // repetitive) turn must never bloat the transcript for the next request.
      const assistantStore = (turn.content || '').length > ASSISTANT_CONTENT_CAP
        ? (turn.content || '').slice(0, ASSISTANT_CONTENT_CAP) + '\n[truncated]'
        : (turn.content || '');
      // Kimi K3 Preserved Thinking (ticket 22c309f4): EVERY replayed assistant
      // message must carry its reasoning_content as-is (vendor requirement;
      // stripping/trimming silently degrades the model) — tool-call turns AND
      // the content-only turns below (leak/narration/final-answer records).
      // Computed once here so every assistant push shares it; the cap is a
      // pathological-only valve (see ASSISTANT_REASONING_CAP).
      // build 2026-10-08 Q-2: matched by FAMILY — the gateway Kimi seat
      // (cql-litellm:api-optimize-moonshot-kimi-k3) replays its reasoning too
      // (coding-model.ts replaysReasoning; KIMI_REASONING_REPLAY_FAMILY_DISABLED=1
      // restores the bare-id match). One reasoning_replay row per run on a custom endpoint.
      const replayReasoning = replaysReasoning(provider);
      if (replayReasoning && turn.reasoning && provider.model !== 'kimi-k3' && !reasoningReplayNoted) {
        reasoningReplayNoted = true;
        recordLoopMetric({ kind: 'reasoning_replay', sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, meta: { outcome: 'replayed', model: provider.model, ...(provider.spec ? { spec: provider.spec } : {}), reasoningChars: turn.reasoning.length } });
      }
      const reasoningStore = replayReasoning && turn.reasoning
        ? (turn.reasoning.length > ASSISTANT_REASONING_CAP
          ? turn.reasoning.slice(0, ASSISTANT_REASONING_CAP) + '\n[truncated]'
          : turn.reasoning)
        : undefined;
      if (topLevel) { try { addOpenChoices(openChoices, `${turn.reasoning || ''}\n${turn.content || ''}`); } catch { /* never breaks the turn */ } }

      // ── CROSS-TURN REPEATED-LINE BREAK (ticket 03587322, 2026-09-21 — lane
      // 596102ca firing-256): count this turn's long lines into the run-level
      // tracker (declared with the narr-loop state). ≥LINE_REPEAT_RUN_BREAK
      // cumulative copies of one line across ≥2 turns ends the run HONESTLY
      // (derail run-end parity) BEFORE any of this turn's tool calls dispatch
      // — in the incident those calls WERE the pollution (23 junk todos).
      // ≥LINE_REPEAT_RUN_WARN arms a one-time in-band warning, pushed after the
      // assistant record below so message role order stays intact. The streak
      // deliberately does NOT reset on real tool calls — that reset is why the
      // narr-loop break missed this class. Requires ≥2 distinct turns: a
      // single turn's in-turn repetition is the in-stream probe's jurisdiction.
      let lineRepeatNotice: { line: string; count: number; turns: number } | null = null;
      if (!input.isCancelled?.()) {
        let lineRepeatWorst: { line: string; count: number; turns: number } | null = null;
        // foldDigits:false (adversarial-review F2, 03587322): the cross-turn
        // tracker feeds a RUN-ENDING guard — numbered progress lines ("Step N
        // of M — …") must NOT collapse into one key across turns. The incident
        // line was verbatim-identical every turn; exact normalization catches it.
        for (const [key, entry] of longLineRepeatCounts(turn.content || '', { foldDigits: false })) {
          const acc = lineRepeatCounts.get(key) ?? { line: entry.line, count: 0, turns: 0 };
          acc.count += entry.count;
          acc.turns += 1;
          lineRepeatCounts.set(key, acc);
          if (acc.turns >= 2 && (!lineRepeatWorst || acc.count > lineRepeatWorst.count)) lineRepeatWorst = acc;
        }
        if (lineRepeatWorst && lineRepeatWorst.count >= LINE_REPEAT_RUN_BREAK) {
          // ── df5ea136 RECEIPT-CITED EXEMPTION: does the repeated line CITE an
          // artifact id carried by an ok:true receipt from THIS run? The
          // incident line — "## 1. COMPLETE + COMMITTED: original teach leg
          // (commit `c04447f4`)" — cited a real git_commit receipt minted 80
          // minutes earlier in the same run: evidenced completed-work recap
          // under heavy mid-run steer traffic, not an unevidenced intention
          // loop. The detection stays (warn still fires, telemetry records
          // every exempted lift) and the break still ends the run at the
          // 3× cap — a cited line repeated 18× is degeneration no receipt
          // can excuse.
          const receiptIdCited = (line: string): boolean => {
            for (const r of receiptCollector) {
              if (!r.ok) continue;
              for (const [k, v] of Object.entries(r.ids ?? {})) {
                if (!RECEIPT_CITABLE_ID_KEYS.has(k)) continue;
                const s = typeof v === 'string' ? v : v == null ? '' : String(v);
                // M1 idiom (action-verifier.ts): a containment/prefix match
                // needs ≥8 chars on BOTH sides to mean anything — shorter
                // tokens match ordinary prose.
                if (s.length < 8) continue;
                if (line.includes(s)) return true;
                // Branch ids are cited VERBATIM in recap lines (the e64fd118
                // shape) and share namespaces — 'digby/session-…', 'fix/…' —
                // so a ≥8-char PREFIX match would let any sibling-branch
                // citation ('digby/session-deadbeef99' vs a real receipt's
                // 'digby/session-e64fd118') lift the break. Exact match only;
                // hex shas keep the short-cite tolerance below (models cite
                // short shas, never abbreviated branches).
                if (k === 'branch') continue;
                // Short-cite tolerance (the incident shape): the line cited
                // the 8-char commit short-sha while the receipt can carry a
                // longer form — any ≥8-char prefix of the id present in the
                // line qualifies.
                for (let n = s.length - 1; n >= 8; n -= 1) {
                  if (line.includes(s.slice(0, n))) return true;
                }
              }
            }
            return false;
          };
          if (receiptIdCited(lineRepeatWorst.line) && lineRepeatWorst.count < LINE_REPEAT_RUN_EXEMPT_CAP) {
            // One strike + one in-band note per distinct lifted line (the same
            // discipline as the warn nudger) — not one per turn.
            if (lineRepeatExemptNudgedKey !== lineRepeatWorst.line) {
              lineRepeatExemptNudgedKey = lineRepeatWorst.line;
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                meta: { seam: 'final_line_repeat_break', state: 'receipt_cited_exempt', count: lineRepeatWorst.count, turns: lineRepeatWorst.turns, line: lineRepeatWorst.line.slice(0, 120) },
              });
              emit('progress', { message: `Identical narration line repeated ${lineRepeatWorst.count}× across ${lineRepeatWorst.turns} turns — receipt-cited (evidenced recap), break lifted`, stage: 'line-repeat-break' });
              if (turn.toolCalls.length > 0) {
                lineRepeatNotice = { ...lineRepeatWorst, line: `${lineRepeatWorst.line} (harness note: this line cites a receipt-backed artifact id from this run, so repeating it will not end the run at the usual threshold — but it is still repeating; stop restating completed work and continue with the live step or finish)` };
              }
            }
          } else {
          const lineRepeatEnded = lineRepeatWorst;
          const lineSnippet = lineRepeatEnded.line.slice(0, 120);
          const note = `[HARNESS] Run ended: the identical narration line was repeated ${lineRepeatEnded.count}× across ${lineRepeatEnded.turns} turns of this run ("${lineSnippet}"). Restating an intention is not execution — treat any action it announced as NOT done unless a tool receipt in this run proves it. The next scheduled firing starts fresh.`;
          parts.push(stampPart({ type: 'text', text: note, marker: 'guard' }));
          emit('guard_marker', { text: note, struckPrev: false });
          emit('progress', { message: `Run ended: identical narration line repeated ${lineRepeatEnded.count}× across ${lineRepeatEnded.turns} turns`, stage: 'line-repeat-break' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'final_line_repeat_break', state: 'ended_run', count: lineRepeatEnded.count, turns: lineRepeatEnded.turns, line: lineSnippet },
          });
          // Derail-rescue parity (ticket ff1fa1b5): machine runs get ONE durable
          // continuation wake carrying the goal context — the ended run's work
          // is otherwise never delivered. Best-effort; never throws.
          try {
            const { enqueueDerailRescue } = await import('./derail-rescue');
            const rescue = await enqueueDerailRescue({
              sessionId: input.sessionId, runId: input.runId,
              tools: [], intended: null, trips: lineRepeatEnded.count,
              goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
              userTurnAt: input.userTurnAt,
            });
            if (rescue.rescued) {
              const rescueText = `[HARNESS] Derail-rescue: enqueued a fresh continuation for this chat carrying the goal context verbatim — rescue #${rescue.count} of at most ${rescue.max} in 24 h.`;
              parts.push(stampPart({ type: 'text', text: rescueText, marker: 'guard' }));
              emit('guard_marker', { text: rescueText, struckPrev: false });
              emit('progress', { message: `Derail-rescue continuation enqueued (#${rescue.count}/${rescue.max})`, stage: 'derail-rescue' });
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                meta: { seam: 'final_line_repeat_break', state: 'continuation_enqueued', count: rescue.count, max: rescue.max },
              });
            }
          } catch { /* the terminal end above is already honest — a failed rescue changes nothing */ }
          // Attribution-investigation parity: the deduped ticket benefits the
          // NEXT firing; the consult is skipped (the run is ending).
          try {
            const { fileStreakInvestigation } = await import('./reflection');
            void fileStreakInvestigation({
              sessionId: input.sessionId, runId: input.runId, tool: 'final_text',
              // Ticket 141d9d92: render the class truthfully (d73765fc
              // precedent) — this is a narration-repeat run-end, NOT a
              // tool-failure streak; 'final_text' is a synthetic label, no
              // such tool exists, and the mislabeled ticket sent the
              // investigator to diff a nonexistent tool's changes.
              shape: 'narration_repeat', repeats: lineRepeatEnded.count,
              perma: false, intended: null, recentFailures: [lineSnippet],
              goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
            });
          } catch { /* attribution must never block the run end */ }
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          done = true;
          break;
          } // end df5ea136 exemption else-branch (the unexempted break path)
        }
        if (
          lineRepeatWorst
          && lineRepeatWorst.count >= LINE_REPEAT_RUN_WARN
          && lineRepeatNudgedKey !== lineRepeatWorst.line
          && turn.toolCalls.length > 0 // call-free turns: the narr-loop break is primary
        ) {
          lineRepeatNudgedKey = lineRepeatWorst.line;
          lineRepeatNotice = lineRepeatWorst;
        }
      }

      if (!turn.toolCalls.length) {
        // ── TRUNCATED-THINKING RECOVERY (2026-09-11; turn-recovery.ts). A
        // thinking model's reasoning counts against max_tokens: glm-5.3 at
        // reasoning_effort 'max' spent the whole per-turn budget thinking about
        // a long supervisor note and returned finish_reason 'length' with EMPTY
        // content, and the run ended with no answer (23/124 supervisor wakes
        // after the 09-10 seat swap). Retry the SAME turn once with a bigger
        // output budget and one notch less reasoning so the answer lands.
        if (isEmptyTruncatedTurn(turn) && !truncationRecovered && !input.isCancelled?.()) {
          truncationRecovered = true;
          // Review 2026-09-13 issue 6: pass omitParams so a seat that strips
          // max_tokens (Kimi K3) gets max_completion_tokens raised instead —
          // the old call re-rolled the same 16,384 budget on every Kimi retry.
          provider = { ...provider, extra: recoveryExtras(provider.extra, provider.omitParams) };
          const capKey = truncationCapKey(provider.extra, provider.omitParams);
          const eff = (provider.extra as any).reasoning_effort;
          agentWarn(`coding agent: ${provider.model} returned no content (finish=${turn.finishReason}, reasoning ${(turn.reasoning || '').length} chars) — retrying the turn once with ${capKey} ${(provider.extra as any)[capKey]}${eff ? ` and reasoning_effort '${eff}'` : ''} (truncated-thinking recovery)`);
          emit('progress', { message: 'The model spent its whole output budget thinking — retrying with a larger budget…', stage: 'truncation-recovery' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.TURN_TRUNCATION_RECOVERY,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { model: provider.model, finishReason: turn.finishReason ?? null, reasoningChars: (turn.reasoning || '').length, maxTokens: (provider.extra as any)[capKey], capKey, reasoningEffort: eff ?? null, lastStep },
          });
          grantRetryStep();
          continue;
        }
        // TOOL-CALL LEAK: the model wrote a tool call as PLAIN TEXT (native
        // special tokens) instead of using the structured channel — so NOTHING
        // ran, yet the prose may claim work was done ("All three figures
        // updated" with zero tool calls — prod session 7be7440a). Don't accept
        // it as the answer: challenge and retry (bounded), forcing a real call.
        // Gate on STRUCTURAL evidence of an attempted call (an invoke element or
        // a native begin-token block), NOT the broad containsToolCallLeak — that
        // fires on a bare '｜' or the word tool_calls, so an honest answer that
        // QUOTES tool-call markup (Digby Code does this on its own repo) is not
        // wrongly rejected + reworded.
        if (looksLikeAttemptedToolCall(turn.content || '') && leakRetries < MAX_LEAK_RETRIES) {
          leakRetries += 1;
          messages.push({ role: 'assistant', content: assistantStore, ...(reasoningStore ? { reasoning_content: reasoningStore } : {}) });
          // The re-issue needs TOOLS: on the final step they were omitted (and
          // the FINAL TURN notice said so) — grant the round the notice below
          // asks for, or a last-step leak `continue`d straight out of the loop
          // with finalText '' (owner transcript 2026-09-08 audit).
          grantToolRound(lastStep);
          messages.push({ role: 'user', content: '[HARNESS NOTICE — not typed by the user] Your previous message contained tool-call markup as PLAIN TEXT, so NO tool was executed and nothing changed. Re-issue it through the structured tool-calling API (do not describe the call in prose). If you are actually done, say so plainly with no tool markup.' });
          emit('progress', { message: 'A tool call was emitted as text (not executed) — retrying…', stage: 'leak' });
          continue;
        }
        // 2026-08-30 audit: after leak-retry exhaustion the stripped prose is
        // accepted as the final answer — but its described tool calls were
        // emitted as PLAIN TEXT and NEVER executed. Say so in-band.
        const leakedUnexecuted = looksLikeAttemptedToolCall(turn.content || '');
        // ── NARRATED-TOOL-EMIT LOOP BREAK (ticket 177a31b7, 2026-09-20 — the
        // spark-cluster wedge: "Sending the window-gate relay to 521020fe NOW:"
        // × dozens over 30+ min while send_chat_message NEVER executed; every
        // other breaker is call- or failure-shaped, the leak lane needs markup,
        // and the zero-tool gate is observe-only — so a prose-only announcement
        // loop finalized and goal-continued indefinitely). A call-free turn
        // whose text ANNOUNCES an imminent action counts when it near-
        // identically repeats the previous counted announcement. Repeat 1: one
        // corrective nudge + a granted tool round. Repeat 3: end the run
        // honestly and flag the result for the attention_needed alarm. FP
        // gates: tools must have been offered this turn (the model COULD
        // call), the leak lanes own markup-shaped attempts, and any real tool
        // call — or a differently-worded/status-only text — resets the streak.
        if (
          offeredNames.size > 0
          && !leakedUnexecuted
          && !input.isCancelled?.()
        ) {
          const narrIntent = detectNarratedToolIntent(cleanText, offeredNames);
          if (narrIntent) {
            const narrRepeated = narrLoopLast !== '' && sameNarration(narrLoopLast, cleanText);
            narrLoopCount = narrRepeated ? narrLoopCount + 1 : 0;
            narrLoopLast = cleanText;
            narrLoopTool = narrIntent.tool ?? (narrRepeated ? narrLoopTool : null);
            if (!narrRepeated) narrLoopNudged = false;
            if (narrLoopCount === 1 && !narrLoopNudged) {
              narrLoopNudged = true;
              messages.push({ role: 'assistant', content: assistantStore, ...(reasoningStore ? { reasoning_content: reasoningStore } : {}) });
              // Same grant idiom as the leak lane: the re-issue needs tools
              // even on the final step (splice the FINAL TURN notice).
              grantToolRound(lastStep);
              const nudgeSnippet = cleanText.replace(/\s+/g, ' ').trim().slice(0, 120);
              messages.push({ role: 'user', content: `[HARNESS NOTICE — not typed by the user] You announced an imminent action ("${nudgeSnippet}") but made NO tool call — narrating a call does not execute it; nothing was sent, written, or changed.${narrLoopTool ? ` If you meant to call ${narrLoopTool}, issue it NOW through the structured tool-calling API — your next turn must carry the actual tool call, not prose about it.` : ' If you meant to call a tool, issue it NOW through the structured tool-calling API — your next turn must carry the actual tool call, not prose about it.'} If no tool call is needed, write your final answer plainly — and never announce an action you are not executing in the same turn.` });
              emit('progress', { message: 'Announced action never executed — challenged to actually issue the tool call (1/1)', stage: 'narr-loop-break' });
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                meta: { seam: 'narrated_tool_emit_loop', outcome: 'nudged', tool: narrLoopTool ?? undefined, repeats: narrLoopCount + 1 },
              });
              continue;
            }
            if (narrLoopCount >= 3) {
              const narrSnippet = cleanText.replace(/\s+/g, ' ').trim().slice(0, 120);
              const note = `[HARNESS] Run ended: repeated narrated-but-unexecuted tool announcements (${narrLoopCount + 1}× "${narrSnippet}"${narrLoopTool ? ` — ${narrLoopTool} never executed` : ' — no tool ever executed'}). The announced action did NOT happen. The next scheduled firing starts fresh.`;
              parts.push(stampPart({ type: 'text', text: note, marker: 'guard' }));
              emit('guard_marker', { text: note, struckPrev: false });
              emit('progress', { message: `Run ended after ${narrLoopCount + 1} narrated-but-unexecuted tool announcements`, stage: 'narr-loop-break' });
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                meta: { seam: 'narrated_tool_emit_loop', state: 'ended_run', tool: narrLoopTool ?? undefined, repeats: narrLoopCount + 1 },
              });
              // RUN-END parity with the derail breaker (2026-09-10): file the
              // deduped attribution investigation; the consult is SKIPPED — the
              // run is ending, so the NEXT firing benefits from the ticket.
              try {
                const { fileStreakInvestigation, writeBreakerLaneNotice } = await import('./reflection');
                void fileStreakInvestigation({
                  sessionId: input.sessionId, runId: input.runId, tool: narrLoopTool ?? 'unknown',
                  perma: false, intended: narrLoopTool, recentFailures: [narrSnippet],
                  goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
                })
                  // Ticket 78f32515: close the loop for the DERAILED lane
                  // itself — a one-shot [BREAKER NOTICE] line naming the
                  // breaker, the streak shape, and the auto-filed ticket id is
                  // consumed into the lane's next run context (run-executor's
                  // schedulerNotice channel). Best-effort; the ticket is the
                  // durable record.
                  .then((ticketId) => writeBreakerLaneNotice(input.sessionId, {
                    breaker: 'narrated-tool-emit loop', tool: narrLoopTool,
                    repeats: narrLoopCount + 1, snippet: narrSnippet, ticketId,
                  }))
                  .catch(() => { /* the lane notice must never block the run end */ });
              } catch { /* attribution must never block the run end */ }
              narrLoopEnded = { tool: narrLoopTool, repeats: narrLoopCount + 1, snippet: narrSnippet };
              finalText = finalText ? `${finalText}\n\n${note}` : note;
              done = true;
              break; // completed-with-note — the done guards below skip goal-continue/auto-verify
            }
          } else {
            narrLoopLast = ''; narrLoopCount = 0; narrLoopTool = null; narrLoopNudged = false;
          }
        }
        // (The ZERO-TOOL PRE-FINAL GATE that sat here was deleted in build
        // 2026-10-08 S-2: observe-only since the 2026-09-11 gate flip — its
        // discard round needed the never-forwarded ZERO_TOOL_GATE_ENFORCE — and
        // its zero_tool_prefinal guard_strike rows had no consumer. simplify.md §1.2.)
        finalText = (leakedUnexecuted
          ? '[HARNESS NOTICE] The following text described tool calls that were emitted as plain text and NEVER executed — treat any completion claims in it as UNVERIFIED.\n\n'
          : '') + (cleanText || finalText);
        // Record the assistant's answer so auto-verify feedback continues coherently.
        if (assistantStore) messages.push({ role: 'assistant', content: assistantStore, ...(reasoningStore ? { reasoning_content: reasoningStore } : {}) });
        // ── EVIDENCE-GUARD REJECT-BACK (ticket dc04deea — f8d68167 option (b)) ──
        // A top-level MACHINE run's clean-finish candidate is guarded BEFORE the
        // loop accepts it: a convicted answer (zero-evidence completion claims,
        // fabricated/refuted PRs, future-dated clocks, forged chrome…) is
        // rejected BACK TO THE MODEL with the missing-receipt list so the run
        // corrects before submission — the one durable fix for the zero-tool
        // short-circuit shape (a prompt cannot force a tool call; this gate
        // rejects the answer that lacks one). Bounded (maxRejections); on
        // exhaustion, guard error, cancel, or a leaked-tool-call candidate the
        // candidate exits normally and the executor's replace/redact lane
        // (option (a)) applies unchanged — fail-closed preserved. The deadline
        // check at the for-loop top still bounds the correction turn, so this
        // cannot overrun the run's wall-clock budget.
        const rejectBack = input.evidenceGuardRejectBack;
        if (rejectBack && topLevel && !leakedUnexecuted && guardRejectBacks < rejectBack.maxRejections && !input.isCancelled?.()) {
          // try/catch spans the dynamic import as well (adversarial review N1) —
          // the gate NEVER breaks the finish path; any failure falls through to
          // the break and the executor's post-run guard still applies.
          let rb: { rejected: boolean; notice?: string; summary?: string; kinds?: string[] } | null = null;
          try {
            const { evaluateFinalCandidateForRejectBack } = await import('./run-evidence-guard');
            rb = await evaluateFinalCandidateForRejectBack({
              finalText, parts,
              triggerKind: rejectBack.triggerKind, resumed: rejectBack.resumed,
              userId: input.userId, repoUrl: input.repoUrl, githubLabel: input.githubLabel, provider: input.provider,
              receipts: receiptCollector, priorReceipts: rejectBack.priorReceipts,
              priorToolTexts: rejectBack.priorToolTexts, toolTexts,
              scheduleFiringTimes: rejectBack.scheduleFiringTimes,
              ticketIdsExist: rejectBack.ticketIdsExist,
              todoIdsExist: rejectBack.todoIdsExist,
              goalIdsExist: rejectBack.goalIdsExist,
              ownerQuestionIdsExist: rejectBack.ownerQuestionIdsExist,
              scheduleIdsExist: rejectBack.scheduleIdsExist,
              carriedReceipts: rejectBack.carriedReceipts,
              // In-loop parity with the executor's finalize lane (audit #6
              // phase 2): compose the typed claims-block lane over the verdict
              // BEFORE the reject-back decision — a fully receipt-verified
              // block downgrades guard-1 convictions here too (no bounce for
              // receipt-proven work); an unverified entry rejects like any
              // other finding.
              applyClaimsBlock: true,
            });
          } catch { /* fall through — fail-closed via the executor's replace lane */ }
          if (rb?.rejected && rb.notice) {
            guardRejectBacks += 1;
            // F2: a repeated evidence-guard rejection counts toward the frontier council (two ⇒ the reflect note).
            frontierCouncil?.noteGuardRejectBack({ round: guardRejectBacks, ...(rb.summary ? { summary: rb.summary } : {}), ...(rb.kinds ? { kinds: rb.kinds } : {}), step });
            // The rejected candidate stays in the transcript for audit but is
            // STRUCK: renderers collapse it, summary/memory fallbacks skip it,
            // and it is no longer this run's finalText (a cancel right after
            // the rejection must not deliver it as the answer).
            const cand = parts[parts.length - 1];
            const struckPrev = !!cleanText.trim() && cand?.type === 'text' && cand.text === cleanText;
            if (struckPrev) cand.struck = true;
            finalText = '';
            parts.push(stampPart({ type: 'text', text: REJECT_BACK_MARKER, marker: 'guard' }));
            emit('guard_marker', { text: REJECT_BACK_MARKER, struckPrev });
            // The correction needs TOOLS (owner transcript 2026-09-08): the
            // notice says "do the verification NOW with real tool calls", so a
            // rejection on the run's final step must not leave the model
            // tool-less — splice a FINAL TURN notice pushed this iteration,
            // guarantee one tool round (step+1) plus the answer round
            // (step+2), and shield that round from the deadline collapse —
            // exactly the zero-tool gate's grant. Without this a last-step
            // rejection 'continue'd straight out of the for-loop with the
            // rejected fabrication still standing as finalText.
            grantToolRound(lastStep);
            messages.push({ role: 'user', content: rb.notice });
            emit('progress', { message: `Final answer failed the evidence guard — rejected back for correction (${guardRejectBacks}/${rejectBack.maxRejections})${rb.summary ? `: ${rb.summary}` : ''}`, stage: 'evidence-guard' });
            // Telemetry parity with the zero-tool gate: an in-loop rejection is
            // a guard STRIKE (the fabrication was caught), even though the
            // executor's finalize lane will later record the corrected final
            // as a clean pass.
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              meta: { seam: 'reject_back', outcome: 'rejected', round: guardRejectBacks, kinds: rb.kinds ?? [] },
            });
            continue;
          }
        }
        // ── Background workers at a finish (coding/background-delegation.ts):
        // a lead that answers while its background workers still run (or
        // with a report not yet seen) does not abandon them. When the run
        // still has a step and time, wait a bounded total for the running
        // ones, then take ONE more turn so the answer can use the reports.
        // Otherwise the run finalizes and a late report is posted to the
        // session as its own message (closeRun below).
        if (topLevel && bgPool && bgPool.pendingCount() > 0 && !lastStep && !deadlineHit && !modelErrored && !input.isCancelled?.()) {
          if (bgPool.runningCount() > 0 && bgPool.readyCount() === 0) {
            const leftMs = profile.runDeadlineMs
              ? profile.runDeadlineMs - (Date.now() - runStartedAt - deadlineOffsetMs) - 15_000
              : Number.POSITIVE_INFINITY;
            const allowance = Math.min(bgPool.remainingEndWaitMs(backgroundRunEndWaitMs()), leftMs);
            if (allowance > 0) {
              emit('progress', { message: `Waiting up to ${Math.round(allowance / 1000)}s for ${bgPool.runningCount()} background worker(s) before finishing`, stage: 'background' });
              await bgPool.awaitRunEnd(backgroundRunEndWaitMs(), leftMs);
            }
          }
          if (bgPool.readyCount() > 0 && !input.isCancelled?.()) {
            emit('progress', { message: 'Background worker report(s) arrived — one more turn so the answer can use them', stage: 'background' });
            continue;
          }
        }
        break; // leave the for-loop; the auto-verify gate below decides if we resume
      }
      leakRetries = 0; // a real tool-calling turn clears the leak budget

      // ── SEVERED-STREAM RE-EMIT (ticket efdb3d31, 2026-10-29) ────────────────
      // MEASURED DEFECT this closes: a gateway that severs the SSE stream
      // mid-`tool_call` still gets to declare the turn finished, and we had no
      // way to tell — `finish()` resolves on `end` and `close` alike, so a
      // half-built payload reached the executor looking exactly like a complete
      // one (`finish_reason: 'tool_calls'`). Twelve stored rows read cuts at
      // 17/39/41/67/84 bytes with `recv == acc, drop=0, buf=0`: every byte the
      // gateway sent we appended, and the payload simply stopped.
      //
      // Wasted work this removes: with the cut payload in history, the next
      // request carries a JSON-invalid `tool_calls` entry, so the API 400s and
      // the C-2 transcript-repair lane rewrites it (bounded at 3/run) — a full
      // round-trip bought us nothing but a burned step. Re-emitting the turn
      // BEFORE the bad record enters history skips that entirely.
      //
      // efdb3d31 CORRECTION (2026-10-30, measured — this comment used to claim the
      // sentinel must be MISSING, and that is exactly why the remedy was dead):
      // the gate is now STRUCTURAL. A payload that stops mid-structure is
      // transport-shaped whether or not `[DONE]` arrived, and on this path the
      // sentinel DOES arrive — every live row reads `fr=tool_calls`, so
      // `streamCompleted` was true and the old `=== false` precondition rejected
      // the turn 100% of the time (0 recovery rows in 24h against 44 finalize
      // rows in 4h). A complete payload still never re-emits, so the
      // sentinel-less-provider no-op and the C-2 lane's sole ownership of the
      // genuinely ambiguous case (`streamCompleted === undefined`, which the
      // pinned agent-context.c.test.ts fixtures carry) both survive intact.
      // ONE decision function now serves the branch AND the telemetry reason.
      ctx.turnStreamCompleted = turn.streamCompleted ?? null;
      ctx.turnFinishReason = turn.finishReason ?? null;
      // efdb3d31 CRITERION 1: the same per-fragment arithmetic the finalize row
      // carries, handed to the executor so a REJECTED call's own row can state
      // whether its bytes ever arrived. Set here (not at the reject site) so it
      // is the TURN's measurement, identical on every rejection of it.
      ctx.turnStreamTrace = turn.streamTrace;

      const severedVerdict = severedStreamVerdict(turn, severedStreamRecovered, !!input.isCancelled?.());
      // efdb3d31 (2026-10-30): record WHICH arm decided this turn. Set for EVERY
      // verdict, not just the ones that re-emit: the mixed-turn arm's whole risk
      // is that diverting a turn leaves no severed_stream_recovery row behind, so
      // a reject row would otherwise read `re:0` and be indistinguishable from
      // "the gate never fired" — the exact false negative that hid this guard for
      // a day. `sv` makes the decision itself the evidence.
      ctx.severedVerdict = severedVerdict;
      if (severedVerdict === 'reemit') {
        severedStreamRecovered = true;
        const partial = turn.toolCalls.map(tc => `${tc.name}:${(tc.arguments || '').length}`).join(',');
        // efdb3d31 (2026-10-30): REMEMBER the cut we are about to re-request, so
        // the reject row of the NEXT attempt can carry it as `rl`. Without this
        // the pre-re-emit length lives only on the recovery row written minutes
        // earlier, and "did the re-request reproduce the same cut?" was a
        // cross-row join no stored read can do. Compare `rl` (attempt 1's cut)
        // against the reject row's own `argLen` (attempt 2's cut).
        //
        // ticket 192d9087 F2 (2026-10-30): the lens is handed to the ONE-TURN
        // carry, NOT onto the ctx. Writing `ctx.turnReemitLens` here would be
        // exactly the sticky bug this fixes — this branch lives in the CURRENT
        // turn, and the field must describe the NEXT one. `beginTurn` picks it up
        // (and clears it) at the retry's turn start; the run-level `rr` flag
        // already read `severedStreamRecovered` at this turn's start, so the
        // recovery row's own turn keeps `re:0` and the retry gets `re:1`.
        noteReemit(severedReemitCarry, turn.toolCalls.map(tc => (tc.arguments || '').length).join(','));
        // LOG-SIGNAL bb6a3aa3 (family lane 3556c8a4, 2026-11-03): this notice is
        // EXTERNAL, not an internal fault. What it reports is the UPSTREAM
        // gateway ending a turn mid-payload — measured in efdb3d31 as recv==acc,
        // drop=0, buf=0 (every byte the gateway sent we appended; the payload
        // simply stopped) — and the turn is RECOVERED right here, by design.
        // Untagged at warn, the hourly sweep fingerprinted it as a framework
        // fault and re-filed it every week (35 rows / 13 distinct hours).
        // The LOSS signal is untouched and stays instrumented on the
        // severed_stream_recovery / tool_call_unrecovered_severance loop_metric
        // rows, so tagging the notice cannot hide a severance regression — it
        // only stops a designed recovery from filing tickets about itself.
        // `agentWarn`'s object form carries meta verbatim (splat-safe — see
        // utils/log-level.ts), so sessionId/runId/source all survive the tag.
        agentWarn(`coding agent: ${provider.model} stream ended ${turn.streamCompleted === false ? 'WITHOUT [DONE]' : 'CLEANLY ([DONE] seen)'} after ${turn.toolCalls.length} tool call(s) (finish=${turn.finishReason ?? 'null'}, sc=${turn.streamCompleted === false ? 0 : 1}, reasoning ${(turn.reasoning || '').length} chars, partial args ${partial || 'none'}) — the assembled payload stops mid-structure; re-emitting the turn once instead of dispatching a partial call (severed-stream recovery)`, { logClass: 'external' });
        emit('progress', { message: 'The model stream was cut short mid-tool-call — re-requesting that turn…', stage: 'severed-stream-recovery' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SEVERED_STREAM_RECOVERY,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          // efdb3d31: this row is the reason the Fleet's named probe becomes
          // answerable — it carries reasoningChars AND the per-call argLen on
          // the SAME row, which no stored row ever did. `rz`/`len` are short on
          // purpose so both survive the reader's 240-char meta cut.
          meta: severedStreamMeta(turn, (turn.reasoning || '').length, provider.model, provider.label, turn.finishReason ?? null),
        });
        grantRetryStep();
        continue;
      }

      // Record the assistant turn (with its raw tool_calls) so the model has
      // context. reasoningStore (above) carries the K3 reasoning passback —
      // Preserved Thinking is a hard vendor requirement in the tool loop.
      messages.push({
        role: 'assistant',
        content: assistantStore,
        ...(reasoningStore ? { reasoning_content: reasoningStore } : {}),
        tool_calls: turn.toolCalls.map(tc => ({
          id: tc.id, type: 'function', function: { name: tc.emittedName ?? tc.name, arguments: tc.arguments },
        })),
      });

      // Cross-turn repeated-line WARNING (ticket 03587322): armed by the tracker
      // above. The notice itself is DEFERRED to after the dispatch loop (see the
      // push below, next to the derail notice): pushed HERE it would land between
      // the assistant tool_calls record and the batch's tool results — the exact
      // interleave that made the API reject whole conversations in the 2026-09-08
      // pass-#4 incident and would force the transcript-repair belt to rewrite an
      // INTENTIONAL message (adversarial-review F1). The turn's tool calls still
      // dispatch — this is a warning, not a withholding; the break threshold ends
      // the run if the line repeats again.
      if (lineRepeatNotice) {
        const notice = lineRepeatNotice;
        emit('progress', { message: `Identical narration line repeated ${notice.count}× across ${notice.turns} turns — warned (run ends if it repeats again)`, stage: 'line-repeat-break' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { seam: 'final_line_repeat_break', state: 'warned', count: notice.count, turns: notice.turns, line: notice.line.slice(0, 200) },
        });
      }

      // Per-turn batch cap (see toolBatchCap): a storm turn runs its first N
      // calls; the rest get a synthetic result and, when one tool dominates the
      // storm, the repeat-break escalation below withholds that tool.
      const batchCap = toolBatchCap();
      let batchStormTool: string | null = null;
      let dispatchCalls = turn.toolCalls;
      if (batchCap > 0 && turn.toolCalls.length > batchCap) {
        dispatchCalls = turn.toolCalls.slice(0, batchCap);
        const counts = new Map<string, number>();
        for (const c of turn.toolCalls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const [domTool, domN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        const domShare = domN / turn.toolCalls.length;
        if (domShare >= 0.8) batchStormTool = domTool;
        for (const sc of turn.toolCalls.slice(batchCap)) {
          messages.push({
            role: 'tool', tool_call_id: sc.id,
            content: `[HARNESS — not executed] This turn requested ${turn.toolCalls.length} tool calls at once; only the first ${batchCap} ran. Read those ${batchCap} results, then re-issue ONLY the calls you still need — a few per turn. Hundreds of parallel calls is a decoder lock, not work.`,
          });
        }
        emit('progress', { message: `${turn.toolCalls.length} tool calls in one turn — only the first ${batchCap} ran${batchStormTool ? ` (${Math.round(domShare * 100)}% were ${batchStormTool})` : ''}`, stage: 'batch-cap' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.TOOL_BATCH_CAP,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          value: turn.toolCalls.length,
          meta: { requested: turn.toolCalls.length, executed: batchCap, dominantTool: domTool, dominantShare: Math.round(domShare * 100) / 100, storm: !!batchStormTool },
        });
        agentWarn(`coding agent [${agentLabel}]: ${turn.toolCalls.length} tool calls in one turn — capped to ${batchCap} (${domTool} ×${domN})`);
      }
      let tci = 0;
      // Per-turn failure flag (ticket 54a172ac follow-up): the near-identical
      // repeat leg below must NOT count turns whose results were failure-
      // shaped — a failing loop is the derail breaker's jurisdiction (its
      // escalation ladder owns it); the repeat legs exist for loops whose
      // calls SUCCEED (the incident's todo_create ×64 all succeeded).
      let turnHadFailure = false;
      // Refused SLIPS this turn (tool-scope.ts, cause 3): a call the pre-flight
      // refused as ungrounded-id / not-offered. When the WHOLE turn was slips,
      // the pair (assistant record + refusals) is pruned from the replayed
      // transcript after the batch so the model is not shown its own slip.
      const slipRefusals: Array<{ id: string; tool: string; emitted: string; reason: string; intended: string | null; ids: string[]; laneOnly?: boolean }> = [];
      for (const tc of dispatchCalls) {
        // Phase 1: write-ahead checkpoint BEFORE each tool call executes —
        // at-least-once per in-flight turn on kill; completed turns never re-run.
        checkpoint('dispatch', dispatchCalls.slice(tci).map(t => ({ id: t.id, name: t.name, arguments: t.arguments })));
        tci += 1;
        if (input.isCancelled?.()) break; // stop dispatching further tools once cancelled
        readCache?.noteDispatch(tc.name); // W2-12: a state-changing call clears the read cache
        // Zero-tool pre-final gate tally: every DISPATCHED evidence-bearing
        // call counts (even a failed probe is a real attempt at fresh evidence
        // — the fabrication shape the gate targets is zero evidence-bearing
        // tool_calls entirely). update_plan / search_memory /
        // search_code_semantic / ask_user prove nothing about the world and
        // do not count (./evidence-tools — the guard's own vocabulary).
        if (isEvidenceToolName(tc.name)) evidenceToolCalls += 1;
        if (REVIEW_WORK_TOOLS.has(tc.name)) workToolCalls += 1;
        if (isChangeTool(tc.name)) loopChangeCalls += 1; // W2-7: reported to a delegating parent
        if (topLevel && profile.kind === 'coding') {
          // W2-7: a worker's own edits (credited once) reset the streak; the delegation call itself does not.
          const workerMoved = !noProgressBrakeV2Disabled() && workerProgressCalls > workerProgressSeen;
          if (isProgressTool(tc.name) || workerMoved) {
            noProgressCalls = 0; noProgressCheckedAt = 0; workerProgressSeen = workerProgressCalls;
            noProgressRung = 0; noProgressNextAt = 0;
          } else {
            noProgressCalls += 1;
            noProgressRecent.push(tc.name);
            if (noProgressRecent.length > 8) noProgressRecent.shift();
          }
        }
        if (typeof isMutatingWorkCall === 'function' && isMutatingWorkCall(tc.name, tc.arguments)) mutatingWorkCalls += 1;
        if (tc.name === 'update_plan') planUpdateCalls += 1;
        let argsPreview: any = {};
        try { argsPreview = JSON.parse(tc.arguments || '{}'); } catch { /* tolerate */ }
        // Ticket 26786762 rework (review BLOCKING 1): a tool call may carry a
        // delivered credential as an argument (flag_owner_question
        // deliverSecrets). The PREVIEW copy — transcript parts, the SSE
        // tool_call event, and through them the persisted coding_messages row
        // — is masked; the executor below still receives the REAL parsed
        // args (the tool vaults the value server-side; nothing else needs
        // it). No-op for every other tool call.
        try {
          const oqSecrets: any = await import('../platform/owner-question-secrets');
          if (tc.name === 'flag_owner_question' && typeof oqSecrets?.maskDeliverSecretsForPreview === 'function') {
            argsPreview = oqSecrets.maskDeliverSecretsForPreview(argsPreview);
          }
        } catch { /* preview masking is best-effort — never break the call */ }
        // N10 shadow — ONCE PER TURN, on the turn's first dispatched call
        // (every sibling in a batched turn shares this narration; the shadow
        // closes the previous turn's decision with THIS tool as its next
        // call). The regex verdict is the SAME detector input the failure/
        // success legs below use; recent tools = this run's earlier tool_call
        // parts (tool results never enter the state); the batch size rides
        // the state + note so batched turns are filterable.
        if (tci === 1) {
          toolIntentShadow.observe({
            emitted: tc.name, reasoning: `${turn.reasoning || ''}`, content: `${turnText || turn.content || ''}`,
            offeredNames: offeredNames, step, batchCalls: dispatchCalls.length,
            recentTools: () => parts.filter((p) => p.type === 'tool_call').slice(-20).map((p) => (p as { name?: string }).name ?? '').filter(Boolean),
            regexVerdict: () => internalOrNull(detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText || turn.content || ''}`, tc.name, offeredNamesBothForms(offeredNames), argsPreview)),
          });
        }
        parts.push(stampPart({ type: 'tool_call', name: tc.name, args: argsPreview }));
        emit('tool_call', { name: tc.name, args: argsPreview });

// SAA-1.6 PHASE 3b (todo e49dfd07, platform/async-tool-calls.ts +
        // platform/async-tool-registry.ts) — THE ARMED PATH.
        // Plan the call, then let the registry race it against the elapsed
        // threshold. Nothing about a FAST call changes: the tool starts now, and
        // if it settles before `afterMs` its own result returns through the same
        // expression as today (the other arm never wins). Only a call still
        // RUNNING at the threshold is handed off — the model gets "Started" plus
        // a correlation id, and the eventual result is queued for the next step
        // boundary (drained below, beside the background-worker pool).
        // Eligibility is a TOOL-CLASS question now, not a declared-duration
        // guess: measuring elapsed time removes the prediction Phase 3a had to
        // make (and which wrongly excluded run_command / computer use).
        // In `observe` mode the crossing is RECORDED and the call still blocks,
        // so a deploy cannot change the loop's timing. Kill switch
        // ASYNC_TOOL_CALLS_DISABLED=1 → reason 'kill_switch', today's behaviour,
        // no row, no race. Telemetry never blocks a call.
        let asyncPlanForCall: AsyncToolPlan | null = null;
        try {
          asyncPlanForCall = planAsyncToolCall({ tool: tc.name, args: argsPreview });
          if (asyncPlanForCall.eligible) {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.ASYNC_TOOL_CALLS_OBSERVE,
              sessionId: input.sessionId,
              ...(input.runId ? { runId: input.runId } : {}),
              value: 1,
              meta: { tool: tc.name, afterMs: asyncPlanForCall.afterMs, declaredMs: asyncPlanForCall.declaredMs, reason: asyncPlanForCall.reason, mode: asyncPlanForCall.mode },
            });
          }
          // TOP-LEVEL ONLY (review P1). `agentLoop` is the loop shared by the
          // orchestrator AND worker subagents, but the drain and the run-end
          // closeRun below are `topLevel`-gated. Without this guard a SUB-loop
          // that handed a call off would queue its result into a registry that
          // nothing ever drains or closes: no `delivered` row, no `orphaned`
          // row, no warn — and the worker would sit on a "Started" it can never
          // resolve. Nulling the plan here makes a sub-loop block exactly as it
          // does today; the readout above still records, so the rate for
          // delegated calls stays measurable.
          if (!topLevel) asyncPlanForCall = null;
        } catch { /* SAA-1.6: telemetry never blocks a tool call */ }

        // Backstop timeout so one wedged tool can't freeze the whole run. Clear the
        // timer once the tool settles so we don't leak a 4-min timer per tool call.
        // EXEMPT delegate/delegate_parallel: a delegation runs a whole sub-agent loop
        // (up to 4 workers, each many steps) that legitimately far exceeds any single
        // tool's budget — and every LEAF tool inside a worker is already wrapped in
        // this same backstop, plus the profile's maxDelegations budget / per-role maxSteps bound it and
        // Stop cancels it. Wrapping the delegation itself in the 240s cap just killed
        // real research (e.g. a 3-way delegate_parallel web-research fan-out aborting
        // at exactly 240s). Await those directly.
        // extraTools (dispatch_colleagues / spawn_self / send_note) run whole
        // council sub-loops — same reasoning as delegate: a colleague legitimately
        // works past 240s (Researcher hit 453s in prod and the aborted dispatch
        // discarded its report), and every leaf tool inside it has its own backstop.
        const isExtraTool = !!input.extraTools?.some(t => t?.schema?.function?.name === tc.name);
        // ask_user BLOCKS on a human typing an answer — it legitimately waits far
        // longer than any compute tool (its own 20-min registry timeout bounds it).
        // wait_for_chat (T3b) blocks on ANOTHER chat's run (≤10 min) — like
        // ask_user it is a wait, not this run's work: no hard timeout, off the deadline.
        const isDelegation = tc.name === 'delegate' || tc.name === 'delegate_parallel' || tc.name === 'ask_user' || tc.name === 'wait_for_chat' || isExtraTool;
        // Citable receipt id (run-receipts follow-up): generated BEFORE dispatch
        // and threaded via ctx so a platform tool's success envelope can EMBED
        // it — the model cites the id, the guard resolves citations against the
        // harness receipt set. Cleared right after the receipt is recorded.
        const receiptId = (RECEIPT_TOOLS.has(tc.name) || WEB_PROBE_RECEIPT_TOOLS_SET.has(tc.name) || CONDITION_WAKE_RECEIPT_TOOLS_SET.has(tc.name)) && !input.sessionId.startsWith('anon-')
          ? crypto.randomUUID()
          : null;
        if (receiptId) ctx.receiptId = receiptId;
        // ── PRE-FLIGHT (./tool-preflight, 2026-09-09) — deterministic checks
        // BEFORE anything executes. (a) A tool that was not offered this round
        // (breaker-withheld, unloaded group, outside this lane's schema) is
        // refused instead of executed — the schema filter is otherwise advisory
        // to a decoder that has already locked onto the name. (b) A platform
        // tool called with an entity id the model never obtained this run is
        // refused without a DB round-trip. Both refusals are failure-shaped so
        // the streak breaker below sees them; (b) additionally fast-trips it.
        let preflightUngrounded = false;
        let preflightResult: string | null = null;
        // Progressive tool disclosure: a by-name call to a tool this run CARRIES
        // but is not showing is AUTO-LOADED (whole group when it fits, else the
        // tool) and executes normally — never a tool_not_offered refusal.
        const autoLoad = toolGroups && !lastStep && !isExtraTool && !offeredNames.has(tc.name) && toolGroups.hasTool(tc.name)
          && tc.name !== withheldTool && !permaWithheld.has(tc.name)
          ? toolGroups.ensureLoadedFor(tc.name)
          : null;
        if (autoLoad) {
          logger.info(`coding agent [${agentLabel}]: ${autoLoad.message}`);
          toolGroupsStatus();
        }
        if (finishRun && tc.name === FINISH_RUN_TOOL && offeredNames.has(FINISH_RUN_TOOL)) {
          // build 2026-10-08 F-1: the harness owns finish_run — record the RAW arguments (a malformed call is data)
          // against the receipts that exist NOW. build 2026-10-11 FA-3 (stage 2, FINISH_RUN_ACT): a failing check
          // answers the ONE in-loop correction instead of the fixed ACK; nothing else in the run changes.
          preflightResult = await finishRun.onCallChecked(tc.arguments, receiptCollector.length, step, {
            receipts: receiptCollector, priorReceipts: input.evidenceGuardRejectBack?.priorReceipts ?? [],
            loadSessionReceipts: finishRunSessionReceipts, resolveAct: () => resolveFinishRunAct(seatModelSpec),
          });
        } else if (frontierCouncil && tc.name === FRONTIER_COUNCIL_TOOL) {
          // F2: the harness owns this tool (it needs the run's failure dossier + counters). The executor refuses
          // outside a trigger window; the advisors' wait is off the run deadline (like ask_user / wait_for_chat).
          const fcT0 = Date.now();
          preflightResult = await frontierCouncil.executeTool(argsPreview, councilStepState({ step, lastStep }));
          deadlineOffsetMs += Date.now() - fcT0;
        } else if (toolGroups && (tc.name === LIST_TOOL_GROUPS_TOOL || tc.name === LOAD_TOOLS_TOOL || tc.name === LOAD_TOOL_GROUP_TOOL)) {
          if (tc.name === LIST_TOOL_GROUPS_TOOL) {
            preflightResult = JSON.stringify({ ok: true, tool: tc.name, ...toolGroups.listing(), message: `Load a group with ${LOAD_TOOLS_TOOL}({group}) or tools by keyword with ${LOAD_TOOLS_TOOL}({query}); a tool you call by name is loaded automatically.` }, null, 1);
          } else {
            const group = String(argsPreview?.group || '').trim();
            const query = String(argsPreview?.query || '').trim();
            const r = group ? toolGroups.load(group) : toolGroups.loadQuery(query);
            // audit 2026-10-06 T5-7: a query naming a coding-lane tool this profile lacks says where it lives.
            const laneOnlyHits = !r.ok && laneOnlyAbsent.size ? laneOnlyToolsInQuery(`${group} ${query}`, laneOnlyAbsent) : [];
            const laneOnlyNote = laneOnlyHits.length ? ` ${laneOnlyToolHint(laneOnlyHits.map(modelToolName).join(' / '))}.` : '';
            preflightResult = JSON.stringify({ ok: r.ok, tool: tc.name, ...(r.group ? { group: r.group } : {}), loaded: r.loaded.map(modelToolName), evicted: r.evicted, ...(r.reason ? { reason: r.reason } : {}), ...(r.partial ? { partial: true } : {}), inView: toolGroups.visibleCount(), cap: toolGroups.getCap() ?? null, message: `${r.message}${laneOnlyNote}` }, null, 1);
            if (r.ok && r.loaded.length) toolGroupsStatus();
          }
        } else if (tc.name === LOAD_TOOL_GROUP_TOOL) {
          const group = String(argsPreview?.group || '');
          if (group === TRIAGE_TOOL_GROUP) {
            if (triageToolsLoaded) {
              preflightResult = JSON.stringify({ ok: true, tool: tc.name, group, loaded: [], message: 'The triage tools are already in your tool list.' }, null, 1);
            } else {
              triageToolsLoaded = true;
              const loaded = tools.map((t) => t?.function?.name as string).filter((n) => isTriageTool(n)).map(modelToolName);
              preflightResult = JSON.stringify({ ok: true, tool: tc.name, group, loaded, message: `Loaded ${loaded.length} triage tools — they are in your tool list from the next round on. Use them only on real ticket ids returned by list_feedback THIS run.` }, null, 1);
              emit('progress', { message: 'Feedback-triage tools loaded into the coding session on request', stage: 'tool-group' });
            }
          } else if (group !== 'account') {
            preflightResult = JSON.stringify({ ok: false, tool: tc.name, reason: 'unknown_group', message: `Unknown tool group. Available: "account", "${TRIAGE_TOOL_GROUP}".` }, null, 1);
          } else if (accountToolsLoaded) {
            preflightResult = JSON.stringify({ ok: true, tool: tc.name, group, loaded: [], message: 'The account tools are already in your tool list.' }, null, 1);
          } else {
            accountToolsLoaded = true;
            const loaded = tools.map((t) => t?.function?.name as string).filter((n) => isAccountTool(n));
            preflightResult = JSON.stringify({ ok: true, tool: tc.name, group, loaded, message: `Loaded ${loaded.length} account tools — they are in your tool list from the next round on.` }, null, 1);
            emit('progress', { message: 'Account tools loaded into the coding session on request', stage: 'tool-group' });
          }
        } else if (!lastStep && !isExtraTool && offeredNames.size && !offeredNames.has(tc.name) && !autoLoad) {
          const hint = tc.name === withheldTool || permaWithheld.has(tc.name)
            ? 'withheld by the loop breaker (repeated failures or a wrong-tool loop)'
            // audit 2026-10-06 T5-7: a coding-lane tool on a profile that never carries it.
            : laneOnlyAbsent.has(tc.name) ? laneOnlyToolHint(modelToolName(tc.name))
            : (!accountToolsLoaded && isAccountTool(tc.name) ? `not loaded — call ${LOAD_TOOL_GROUP_TOOL}({group:"account"}) first if you truly need it`
              : (!triageToolsLoaded && isTriageTool(tc.name) ? `not loaded — this session was not dispatched a feedback ticket and has not filed one this run; if your task genuinely is to work the feedback queue, or to move a ticket THIS session filed (filer binding: in_progress / adminNote / priority while no other lane is dispatched to it), call ${LOAD_TOOL_GROUP_TOOL}({group:"${TRIAGE_TOOL_GROUP}"}) first, otherwise call the tool that advances the task` : undefined));
          preflightResult = toolNotOfferedRefusal(modelToolName(tc.name), [...offeredNames].map(modelToolName), hint);
          const notOfferedIntended = internalOrNull(detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText || turn.content || ''}`, tc.name, offeredNamesBothForms(offeredNames), argsPreview));
          const notOfferedIds = Object.entries((argsPreview && typeof argsPreview === 'object') ? argsPreview : {})
            .filter(([k]) => /^(id|[A-Za-z]+Id)$/.test(k)).map(([, v]) => String(v ?? '')).slice(0, 3);
          slipRefusals.push({ id: tc.id, tool: tc.name, emitted: tc.emittedName ?? modelToolName(tc.name), reason: 'tool_not_offered', intended: notOfferedIntended, ids: notOfferedIds, ...(laneOnlyAbsent.has(tc.name) ? { laneOnly: true } : {}) });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'tool_preflight', tool: tc.name, reason: 'tool_not_offered', ...(laneOnlyAbsent.has(tc.name) ? { laneOnly: true } : {}) },
          });
          // Re-anchor leg (a) — see the state block: a GENUINELY nonexistent
          // tool name (hint === undefined: never offered), not the withheld
          // or account-not-loaded sub-cases (their refusals already carry
          // their own corrective).
          if (!reAnchorUsed && !reAnchorPending && hint === undefined) {
            reAnchorPending = { tool: tc.name, reason: 'tool_not_offered', intended: notOfferedIntended };
          }
        } else if (platformToolNames.has(tc.name)) {
          const bad = findUngroundedIdArgs(argsPreview, groundingHaystack(messages));
          if (bad.length) {
            preflightUngrounded = true;
            inventedIdSignals += 1;
            const intended = internalOrNull(detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText || turn.content || ''}`, tc.name, offeredNamesBothForms(offeredNames), argsPreview));
            preflightResult = ungroundedIdRefusal(modelToolName(tc.name), bad, intended ? modelToolName(intended) : null);
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              meta: { seam: 'tool_preflight', tool: tc.name, reason: 'ungrounded_id', intended: intended ?? undefined, placeholder: bad.every((b) => looksLikePlaceholderId(b.value)) || undefined },
            });
            slipRefusals.push({ id: tc.id, tool: tc.name, emitted: tc.emittedName ?? modelToolName(tc.name), reason: 'ungrounded_id', intended, ids: bad.map((b) => String(b.value)).slice(0, 3) });
            // Re-anchor leg (c), source 1 — see the state block: a REPEAT
            // bare invented-id call is the placeholder-emission streak
            // signature (the first is ordinary containment). When the
            // narration ALSO names a different tool, the intent-mismatch
            // leg (b) below owns the steer instead.
            if (!reAnchorUsed && !reAnchorPending && !intended && inventedIdSignals >= 2) {
              reAnchorPending = {
                tool: tc.name, intended: null, reason: 'placeholder_streak',
                badIds: bad.map((b) => b.value).slice(0, 3), count: inventedIdSignals,
              };
            }
          }
        }
        // ── LOOP VOLUME CAP (ticket 54a172ac — see loopVolumeCap): the
        // repetition-loop shape every other breaker missed (CanLaw c510c56f:
        // 64 junk todos created across ~35 min of single-call turns). Past
        // the cap the call is refused BEFORE execution — failure-shaped, so
        // the derail streak below escalates a model that keeps trying — and
        // the tool leaves the schema for the rest of the run. Counts only
        // calls that would actually execute (preflight-clean); the cap-hit
        // notice/metric fires once, on the crossing call.
        // ── QUICK-LANE WEB BUDGET (roster 2026-10-06 C-4, ./web-tool-cap.ts): a Quick run gets one search + one page
        // read; past a class's cap the call is refused BEFORE it runs (failure-shaped, like the volume cap below) and
        // the whole class leaves the tool list for the rest of the run. Shadow mode only counts.
        if (preflightResult === null && webCapState && input.webToolCaps && topLevel) {
          const v = webToolCapCheck(input.webToolCaps, webCapState, tc.name);
          if (v.refuse && v.cls) {
            preflightResult = webToolCapRefusal(modelToolName(tc.name), v.cls, input.webToolCaps);
            const first = webCapState.refused === 1;
            for (const t of webToolsOfClass(v.cls)) permaWithheld.add(t);
            if (first) emit('progress', { message: 'Quick answer: web budget reached — answering from what was found', stage: 'web-budget' });
            // Its own kind (not guard_strike): a budget refusal on a healthy Quick run is policy, never a fleet alarm.
            recordLoopMetric({
              kind: 'quick_web_budget',
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              meta: { tool: tc.name, cls: v.cls, search: webCapState.search, fetch: webCapState.fetch, refused: webCapState.refused, outcome: 'refused' },
            });
          }
        }
        if (preflightResult === null && VOLUME_CAP_TOOLS.has(tc.name)) {
          const cap = loopVolumeCap();
          if (cap > 0) {
            const volumeCount = (toolRunCounts.get(tc.name) ?? 0) + 1;
            toolRunCounts.set(tc.name, volumeCount);
            if (volumeCount > cap) {
              preflightResult = `Tool ${tc.name} failed: [HARNESS volume cap] this run has already created ${volumeCount - 1} record(s) via ${tc.name} — over the per-run cap of ${cap} (ticket 54a172ac loop containment). A run creating this many is in a repetition loop, not doing work. ${tc.name} is removed from your tool list for the REST OF THIS RUN — update the EXISTING records instead, or finish with what exists.`;
              if (!permaWithheld.has(tc.name)) {
                permaWithheld.add(tc.name);
                emit('progress', { message: `${tc.name} volume cap (${cap}/run) exceeded — refused and withheld for the rest of the run (repetition-loop containment)`, stage: 'volume-break' });
                recordLoopMetric({
                  kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                  sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                  meta: { seam: 'tool_volume_break', tool: tc.name, count: volumeCount - 1, cap },
                });
                agentWarn(`coding agent [${agentLabel}]: ${tc.name} per-run volume cap ${cap} exceeded (call #${volumeCount}) — perma-withheld (ticket 54a172ac)`);
              }
            }
          }
        }
        // ── OUTBOUND CLAIM AUDIT (P4 v1#25 / spark B3+B4): a MACHINE run's
        // outgoing text (send_chat_message, todo/goal notes, ticket
        // descriptions) is claim-audited at dispatch against this run's
        // receipt union — the same extractor the final-answer guard uses. A
        // send_chat_message that IS a completion report with receipt-less
        // claims is REFUSED (failure-shaped envelope — the streak breaker
        // sees it); notes get their convicted lines annotated '[unverified]'
        // inline and still dispatch. Bounded: machine runs, texts >80 chars.
        // Kill-switch: OUTBOUND_CLAIM_AUDIT_DISABLED=1 (read in the auditor).
        // Gate flip 2026-09-11 (owner: full steam): OBSERVE-ONLY by default —
        // the audit still runs and records its GUARD_STRIKE row, but the
        // model's outgoing text is NEVER refused or rewritten (3 rows since
        // 09-08, all 'annotated', both pr_merged annotations structural false
        // positives: owner-click merges and other lanes' merges can never
        // carry this run's receipts). Opt-in OUTBOUND_CLAIM_AUDIT_ENFORCE=1
        // restores the refusal envelope + inline ' [unverified]' rewrite.
        if (preflightResult === null && topLevel && input.machineTriggered === true && OUTBOUND_AUDITED_TOOL_ARGS[tc.name]) {
          try {
            const outboundEnforce = process.env.OUTBOUND_CLAIM_AUDIT_ENFORCE === '1';
            const audit = auditOutboundArgs({
              tool: tc.name,
              args: argsPreview,
              receipts: [...receiptCollector, ...(input.evidenceGuardRejectBack?.priorReceipts ?? [])],
              machineTriggered: true,
            });
            if (audit.action === 'refused' && audit.refusal) {
              if (outboundEnforce) {
                preflightResult = audit.refusal;
                emit('progress', { message: 'Outbound message refused — completion claims without receipts (verify, cite ids, or mark unverified)', stage: 'evidence-guard' });
              } else {
                emit('progress', { message: 'Outbound message carries completion claims without this-run receipts (observed — dispatched unchanged)', stage: 'evidence-guard' });
              }
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId,
                meta: { seam: 'outbound_claim', tool: tc.name, outcome: outboundEnforce ? 'refused' : 'observed_refusable', kinds: audit.kinds },
              });
            } else if (audit.action === 'annotated' && audit.args) {
              if (outboundEnforce) {
                // The ANNOTATED args are what actually dispatch (and what the
                // receipt's inputHash records); the pre-annotation args stay in
                // the streamed tool_call frame for audit.
                argsPreview = audit.args;
                tc.arguments = JSON.stringify(audit.args);
              }
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId,
                meta: { seam: 'outbound_claim', tool: tc.name, outcome: outboundEnforce ? 'annotated' : 'observed_annotatable', kinds: audit.kinds },
              });
            }
          } catch { /* the audit must never break a dispatch */ }
        }
        let result: string;
        // SAA-1.6 PHASE 3b: set only when this call was HANDED OFF — the loop then
        // skips the result-processing tail (offload, receipts, truncation) because
        // there is no result yet; that work runs when the real result is drained.
        let asyncStarted: { correlationId: string; startedText: string } | null = null;
        // W2-12: an identical allowlisted read served from this loop's cache (no re-execution, no new receipt).
        let servedFromReadCache = false;
        // build 2026-10-11 DL-2: a side effect answered from the tool-intent journal instead of run (no re-run, no new
        // receipt) — 'withheld' = an at-most-once call NOT sent, never an executed observation.
        let intentReplay: 'skip' | 'withheld' | null = null;
        const cachedRead = preflightResult === null && !isDelegation ? (readCache?.lookup(tc.name, tc.arguments) ?? null) : null;
        if (preflightResult !== null) {
          result = preflightResult;
        } else if (cachedRead) {
          result = cachedRead.text;
          servedFromReadCache = true;
        } else if (isDelegation) {
          // ask_user blocks on a HUMAN typing (up to its 60-min registry window)
          // — that wait is not this run's work: exclude it from the run
          // deadline like injectSystem waits (2026-09-08 audit: a chat-profile
          // run got a forced tool-less FINAL TURN right after the owner answered).
          const askT0 = tc.name === 'ask_user' || tc.name === 'wait_for_chat' ? Date.now() : 0;
          const delegationWork = runTool(ctx, tc);
          // SAA-1.6: wait_for_chat lives HERE (it is a wait, not this run's work),
          // so the async race must wrap this branch too — otherwise the one tool
          // that declares a real 600 s bound would be the one never handed off.
          if (asyncPlanForCall?.eligible) {
            const outcome = await ensureAsyncTools(asyncPlanForCall).run(tc.name, delegationWork);
            if (outcome.kind === 'handed_off') {
              asyncStarted = { correlationId: outcome.correlationId, startedText: outcome.startedText };
              result = outcome.startedText;
              // A handed-off wait keeps running off-deadline; do not charge its
              // elapsed time to the loop (it is not this run's work either way).
            } else {
              result = outcome.result;
              if (askT0) deadlineOffsetMs += Date.now() - askT0;
            }
          } else {
            result = await delegationWork;
            if (askT0) deadlineOffsetMs += Date.now() - askT0;
          }
        } else {
          // build 2026-10-08 D-2 (SHADOW): a side-effecting call gets its PENDING intent row + idempotency key before
          // it runs (issued fire-and-forget — nothing waits on the DB) and is settled after; the key rides the ctx so
          // the delegation ledger can stamp the task the call creates (coding/tool-intents.ts).
          const intent = intentJournal.begin(tc.name, argsPreview, step);
          // build 2026-10-11 DL-2 (ACT, TOOL_INTENT_ACT_DISABLED): a call an EARLIER attempt of this run / turn already
          // applied is answered with that attempt's receipt instead of re-running; an at-most-once call whose earlier
          // outcome is unknown is not resent. No twin (the common case) ⇒ it runs exactly as before.
          const intentAct = intent ? await intentJournal.act(intent, { worktree: input.worktree || null }) : null;
          if (intent && intentAct?.skip) {
            result = intentAct.result ?? '';
            intentReplay = intentAct.decision === 'withheld' ? 'withheld' : 'skip';
            const carried = intentAct.carriedReceipt;
            if (carried && !receiptCollector.some((r) => r.id === carried.id)) receiptCollector.push(carried);
            intentJournal.finish(intent, result, { receiptId: carried?.id ?? null, state: intentAct.settleAs });
          } else {
            if (intent) ctx.intentKey = intent.idemKey;
            // build 2026-10-09 VS: the hard timer re-arms by the QUEUED ms this call reported (a verify waiting for a slot
            // is never "exceeded 900s"); nothing reported ⇒ the old race exactly (tool-hard-timeout.ts).
            const hardTimedWork = raceToolHardTimeout(
              runTool(ctx, tc), TOOL_HARD_TIMEOUT_MS,
              () => `Tool "${tc.name}" exceeded ${Math.round(TOOL_HARD_TIMEOUT_MS / 1000)}s and was aborted. Do not retry it; proceed with what you have.`,
              () => toolQueuedMs,
            );
            // SAA-1.6 PHASE 3b — race the call against the ELAPSED threshold. The
            // tool has ALREADY started above; this only decides what the loop does
            // if it is still running at `afterMs`. Sub-threshold ⇒ the tool's own
            // result comes back through this same expression, byte-identical.
            if (asyncPlanForCall?.eligible) {
              const outcome = await ensureAsyncTools(asyncPlanForCall).run(tc.name, hardTimedWork);
              if (outcome.kind === 'handed_off') {
                asyncStarted = { correlationId: outcome.correlationId, startedText: outcome.startedText };
                result = outcome.startedText;
              } else {
                result = outcome.result;
              }
            } else {
              result = await hardTimedWork;
            }
            // A handed-off call has no result yet — caching its "Started" text would
            // answer a later identical read with "Started" and never run it.
            if (!asyncStarted) readCache?.record(tc.name, tc.arguments, result, step, receiptId);
            if (intent && !asyncStarted) {
              delete ctx.intentKey;
              intentJournal.finish(intent, result, { receiptId, failureShaped: looksLikeToolFailure(result || '') });
            } else if (intent && asyncStarted) {
              // Handed off: the call has NOT settled, so the intent stays open
              // rather than being settled on text that is not a result.
              delete ctx.intentKey;
              intentJournal.finish(intent, result, { receiptId, failureShaped: false });
            }
          }
        }

        toolGroups?.noteUse(tc.name); // LRU: a used group is the last to be evicted
        // build 2026-10-08 F-1: get_run_receipts rows (relayed evidence) + email sends / file writes (executed tier);
        // build 2026-10-11 FA-1: + every READ tool (the read index a `verify` claim rests on); DL: a withheld resend never counts as executed.
        if (finishRun && preflightResult === null && !asyncStarted && finishRunObservesTool(tc.name)) finishRun.observeToolResult(tc.name, argsPreview, result, intentReplay !== 'withheld' && !looksLikeToolFailure(result || ''));
        // F2: a red verify chain from the lane's own `verify` call counts toward the frontier council (tools.ts
        // answers "Verify FAILED at "<stage>": …" — deferred / unverified / no-chain answers are not reds).
        if (frontierCouncil && tc.name === 'verify' && typeof result === 'string' && result.startsWith('Verify FAILED at')) {
          frontierCouncil.noteVerifyRed({ stage: /^Verify FAILED at "([^"]*)"/.exec(result)?.[1] ?? '', tail: result.slice(-1_200), step, auto: false });
        }

        // ── Offload decisions BEFORE the display slice (P6 — v1#19): the
        // truncation marker used to claim "searchable via search_memory"
        // UNCONDITIONALLY, but only OFFLOAD_TOOLS results were ever stored — a
        // >8k run_command/verify/process output carried a FALSE pointer. Every
        // >8k result is now offloaded (head+tail for huge ones) and the marker
        // states what actually happened. ──
        const isContentRead = !asyncStarted && OFFLOAD_TOOLS.has(tc.name) && !!result && result.length > 200;
        // Ticket f03b739c: gate every offload through the SERP/failure
        // sanitizer — a failed search surface never embeds its body (a compact
        // error record lands instead), and a SERP payload distills to its
        // useful signal before the store. Pure + kill-switched; anything else
        // passes through byte-identical.
        const embedGate = sanitizeForMemoryEmbed(result);
        const embedContent = embedGate.action === 'skip'
          ? failedSearchCompactRecord(result, tc.name)
          : embedGate.content;
        let modelResult = result;
        let offloadedToMemory = false; // a store for THIS result happened (or was submitted)
        if (isContentRead && topLevel && result.length > LARGE_READ_CHARS) {
          // The orchestrator read something big ITSELF (the anti-pattern that
          // overflows context). Store the full text to RAG NOW — awaited, so a
          // later search_memory in this same run finds it — and keep only an
          // excerpt + a pointer in context. This is the same "summary in context,
          // full detail in RAG" contract the explorer subagents provide.
          const ref = offloadRef(tc.name, argsPreview);
          try {
            const n = await storeFindings(input.sessionId, opts.role || 'orchestrator', [{ ref, content: embedContent }]);
            if (n) {
              offloadedToMemory = true;
              emit('progress', { message: `Large read stored to memory — search_memory("${ref}") for detail`, stage: 'offload' });
            }
          } catch { /* best effort — fall back to the excerpt below */ }
          modelResult = offloadedToMemory
            ? `${result.slice(0, LARGE_READ_CHARS)}\n\n[Truncated — ${embedGate.action === 'skip'
                ? 'this failed-search surface was NOT stored to session memory (a compact error record was, per ticket f03b739c)'
                : embedGate.distilled
                  ? `the ${embedContent.length}-char sanitized form (SERP scaffolding stripped, ticket f03b739c) of these ${result.length} chars was stored to session memory`
                  : `the full ${result.length} chars were stored to session memory`}. Use search_memory (query "${ref}" or specific keywords) to retrieve the parts you need instead of re-reading the whole thing.]`
            : `${result.slice(0, LARGE_READ_CHARS)}\n\n[Truncated — storing the full ${result.length} chars to session memory FAILED; re-read a narrower range if you need the rest.]`;
        } else if (isContentRead && doOffload) {
          // Subagents keep full content in their own (bounded) context and offload
          // it for the orchestrator to pull back via search_memory. Stored NOW
          // (incremental offload) — not at worker end — so delegate_parallel
          // siblings and the orchestrator can search this material MID-FLIGHT.
          // Fire-and-forget (no per-read embed latency); settled at worker end.
          // Same item gate as ever (OFFLOAD_TOOLS results > 200 chars), so write
          // volume is unchanged — only the timing moved.
          offloadPending.push(
            storeFindings(input.sessionId, opts.role!, [{ ref: offloadRef(tc.name, argsPreview), content: embedContent }]).catch(() => 0),
          );
          offloadedToMemory = true; // submitted; settled before the worker returns
        } else if (!!result && result.length > DISPLAY_RESULT_CAP && input.sessionId
          // audit 2026-10-06 T1-4: a memory READ (search_memory / list_memory)
          // returns chunks that already live in memory — re-storing it made
          // memory retrieve its own retrievals (40,917 self-stored chunks in
          // 14 days; ~16 self-hits per result). Kill switch
          // MEMORY_READ_REOFFLOAD_SKIP_DISABLED=1.
          && (memoryReadReoffloadSkipDisabled() || !MEMORY_READ_TOOLS.has(tc.name))) {
          // v1#19: a big result from a tool OUTSIDE the content-read paths
          // (run_command, verify, read_process_output, a non-offload-role
          // worker's read…). Store it head+tail so the display marker's
          // search_memory promise is TRUE. Awaited (same as the orchestrator
          // large-read path) so an in-run search finds it immediately.
          const ref = `${tc.name}: ${offloadRef(tc.name, argsPreview)}`.slice(0, 300);
          const content = embedContent.length > 36_000
            ? `${embedContent.slice(0, 18_000)}\n…[middle ${embedContent.length - 36_000} chars omitted at offload]…\n${embedContent.slice(-18_000)}`
            : embedContent;
          try {
            const n = await storeFindings(input.sessionId, opts.role || 'orchestrator', [{ ref, content }]);
            offloadedToMemory = n > 0;
          } catch { /* marker stays honest: NOT stored */ }
        }

        // Tag the truncation so neither the persisted transcript nor the live UI
        // silently drops the tail (prod session 7242c1e4: an 8000-char slice cut
        // a result with no marker, so the reader couldn't tell it was clipped) —
        // and only promise search_memory when a store actually happened (v1#19).
        const memoryReadSkipped = !offloadedToMemory && MEMORY_READ_TOOLS.has(tc.name) && !memoryReadReoffloadSkipDisabled();
        const displayResult = result.length > DISPLAY_RESULT_CAP
          ? `${result.slice(0, DISPLAY_RESULT_CAP)}\n…[truncated ${result.length - DISPLAY_RESULT_CAP} chars — ${offloadedToMemory
            ? embedGate.action === 'skip'
              ? 'only a compact error record (ticket f03b739c) was stored; the failed-search body was not'
              : embedGate.distilled
                ? `the sanitized form (SERP scaffolding stripped, ticket f03b739c) is searchable via search_memory`
                : 'full detail is searchable via search_memory'
            : memoryReadSkipped
              ? 'a memory read is never re-stored to memory; narrow the query if you need the rest'
              : 'NOT stored to memory; re-run with narrower output if you need the rest'}]`
          : result;
        parts.push(stampPart({ type: 'tool_result', name: tc.name, result: displayResult }));
        emit('tool_result', { name: tc.name, result: displayResult });
        // FILER BINDING → triage-work signal (2026-09-27 review finding 4): a
        // successful file_feedback in a CODING run makes this session the
        // filer of a ticket it may now move (in_progress / adminNote /
        // priority — platform-tools.ts filerBindingVerdict), but the triage
        // group is hidden unless the prompt mentioned ticket work
        // (runMentionsTicketWork scans prompt material only, never tool
        // results). Load the group from the receipt itself so the lane is not
        // told "this session was not dispatched a feedback ticket" one round
        // after the harness said the ticket is its own. A dedup hit loads it
        // only when the dedup line says THIS session is the filer. Schema
        // preload only — never a gate.
        if (!triageToolsLoaded && tc.name === 'file_feedback'
          && (/^Filed feedback ticket\b/.test(result) || (/^Already tracked as ticket\b/.test(result) && result.includes('This session filed it — you may triage it')))) {
          triageToolsLoaded = true;
          emit('progress', { message: 'Triage tools loaded — this session filed a feedback ticket it may now move (filer binding)', stage: 'tool-group' });
        }
        // Screenshots in the chat (owner 2026-09-23): a browser_task /
        // computer_task leaves its final screenshot on the ToolCache; it rides
        // the transcript as an `image` part right after the tool card (both
        // lanes persist `parts`) and streams live as an `image` event.
        // Tolerant of test doubles that stub ToolCache with getOrExecute only.
        const attached = typeof (toolCache as any).takeAttachedImages === 'function' ? toolCache.takeAttachedImages() : [];
        for (const img of attached) {
          // Generated images (generate_image, 2026-09-24) persist URL-ONLY: the
          // bytes already live in generated_files, and the chat lane's GET does
          // not strip parts, so an inline-base64 part would ride every
          // transcript load. Screenshots keep the inline shape (the coding GET
          // strips + lazily serves them). The LIVE event carries the bytes for
          // an instant render PLUS url/fileId/prompt so the UI can offer
          // Download/Open without a second round trip.
          const generatedFileId = img.source === 'generated' && typeof img.fileId === 'string' && img.fileId ? img.fileId : null;
          const imagePart: MessagePart = generatedFileId
            ? { type: 'image', mediaType: img.mediaType, url: inlineGeneratedPath(generatedFileId), name: img.name, source: img.source, fileId: generatedFileId, prompt: img.prompt }
            : { type: 'image', mediaType: img.mediaType, data: img.data, name: img.name, source: img.source, pageUrl: img.pageUrl, app: img.app };
          parts.push(stampPart(imagePart));
          emit('image', generatedFileId
            ? { mediaType: img.mediaType, data: img.data, name: img.name, source: img.source, url: inlineGeneratedPath(generatedFileId), fileId: generatedFileId, prompt: img.prompt }
            : { mediaType: img.mediaType, data: img.data, name: img.name, source: img.source, pageUrl: img.pageUrl, app: img.app });
        }

        // Run tool receipts (anti-confabulation evidence channel): one harness-
        // written receipt per CONSEQUENTIAL execution — collected in-process AND
        // persisted fire-and-forget. Extract from the RAW result (displayResult
        // may be truncated). Skipped for anon- chats: run_tool_receipts FK-
        // references crossmodel_chats and anon sessions have no row there.
        // The id is the pre-dispatch one. A staged call (needsConfirmation)
        // mints an ok:false {staged:true, confirmationId} row (WI-K,
        // 2026-09-25 — visible to get_run_receipts, never evidence) but its
        // envelope still never carries the id, so any id the model cites
        // resolves to a real harness receipt it was shown or convicts.
        // W2-12 / DL-2: a read-cache hit or an intent replay — the first call's receipt is the evidence.
        if (receiptId && (servedFromReadCache || intentReplay)) delete ctx.receiptId;
        if (receiptId && !servedFromReadCache && !intentReplay) {
          const draft = extractReceipt(tc.name, argsPreview, result, new Date());
          if (draft) {
            // sessionId IS the chat id on every caller (coding sessions and chat
            // runs both live in crossmodel_chats — same key the journal uses).
            // E8 (2026-09-25): scrubbed args/result heads ride the in-memory
            // receipt only (the self-audit gate's evidence substance; the
            // persisted row keeps its explicit columns).
            // Ticket e225aad8: the runId a receipt persists under resolves
            // through resolveReceiptRunId (utils/run-telemetry-context) — a
            // chat / supervisor turn's receipts take the turn's ambient
            // telemetry id (chat-<uuid>) instead of null, so get_run_receipts
            // groups ONE bucket PER TURN and a runId query for the turn id
            // resolves; a durable coding run's runId always wins. anon- chats
            // never mint a receiptId (skipped above), so this is always a
            // chat turn.
            const receipt: ToolReceipt = {
              ...draft, id: receiptId, chatId: input.sessionId,
              runId: resolveReceiptRunId(input.runId, input.sessionId),
              ...receiptHeads(argsPreview, result),
            };
            receiptCollector.push(receipt);
            // Ticket 66007a6e (web-probe receipt class): web tools are
            // COLLECTOR-ONLY — the receipt is gate evidence ("a real check ran
            // this run" for observe_resource's no_receipt gate, which reads
            // the collector first), never claim evidence. recordRunReceiptAsync
            // is deliberately skipped so no run_tool_receipts row is written:
            // web tools are the hottest tool class fleet-wide, and every
            // DB-reading pool (getRecentChatReceipts's cross-wake 500-cap
            // exoneration pool among them) stays untouched by construction.
            if (!WEB_PROBE_RECEIPT_TOOLS_SET.has(tc.name)) recordRunReceiptAsync(receipt);
          }
          delete ctx.receiptId;
        }

        // Failure-shaped result → append the single best-matching learning (audit
        // #11): a durable convention recorded by a past session often IS the fix
        // for exactly this error. Model-facing only; ≤3 requeries per run.
        if (learningNudge) {
          const learningNote = await learningNudge(tc.name, result).catch(() => '');
          if (learningNote) modelResult += `\n\n${learningNote}`;
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: modelResult });
        // The model quotes from THIS full text, not the 8000-char display
        // slice in parts — feed it to the evidence guard's quote haystack.
        if (modelResult) toolTexts.push(modelResult);
        // EVIDENCE LEDGER (tickets a84cc306 + 5036d072): harvest citable ids
        // from the FULL model-facing result text (same fidelity as the guard
        // haystack). The gate mirrors the render gate — every machine-
        // triggered top-level lane (chat AND coding) pays the (trivial)
        // extraction cost; the lane scopes WHICH families harvest (coding
        // adds the git/PR receipt anchors).
        if (topLevel && input.machineTriggered === true) {
          evidenceLedger.ingest(tc.name, modelResult);
        }

        // Derailment-breaker streak (see the state block): consecutive
        // failure-shaped results from one tool. run_command is exempt —
        // red test/build loops are legitimate iteration, not derailment.
        // The notice itself is DEFERRED to after the dispatch loop: a user
        // message interleaved between a batch's tool results makes the API
        // reject the whole conversation ("tool_call_ids did not have response
        // messages" — pass #4 incident 2026-09-08 20:36Z: the first breaker
        // shipped the push inline and 400-crashed every multi-call turn it
        // fired inside).
        if (tc.name !== 'run_command' && looksLikeToolFailure(result || '')) {
          turnHadFailure = true;
          if (tc.name === failStreakTool) failStreakCount += 1;
          else { failStreakTool = tc.name; failStreakCount = 1; failStreakTexts = []; failStreakArgs = []; } // tool switch = NEW streak: clear both (PR #1250 review — stale args must not ride the new tool)
          // Capture the ACTUAL failure text now (ticket 8579d419) — see the
          // state block for why a trip-time message scan cannot work.
          failStreakTexts.unshift(String(result || '').slice(0, 1200));
          if (failStreakTexts.length > 3) failStreakTexts.length = 3;
          // DW-4 (568d3652 gap): the paired ARGS snapshot — same 8579d419
          // counting-time discipline. tc.arguments is the raw JSON string;
          // clip to 200 chars (args carry ids/paths, the clip bounds the
          // exposure — the backlog's cap). (RSW-1 cluster 29, 2026-11-02: the
          // STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted — capture is
          // unconditional.)
          // Review BLOCKING A (round 3): MASK THEN CLIP, via the helper —
          // the snapshot rides reflection/council prompts and a persisted
          // ticket row. The inline-regex round-2 attempt leaked five shapes
          // (label with ], slice-cut arrays, decoy first match, duplicate
          // keys); the helper parses the full string, masks, and only then
          // clips. No-op for every other tool call.
          failStreakArgs.unshift(maskDeliverSecretsInArgsString(String(tc.arguments || '')).slice(0, 200));
          if (failStreakArgs.length > 3) failStreakArgs.length = 3;
          // Fast-trip weights (see the state block): ungrounded id = +1 (an
          // invented id is never real work), intent mismatch = +1 (the model
          // itself says it meant another tool). Both ⇒ 3 on the first call.
          const intended = internalOrNull(detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText || turn.content || ''}`, tc.name, offeredNamesBothForms(offeredNames), argsPreview));
          if (preflightUngrounded) failStreakCount += 1;
          if (intended) {
            failStreakCount += 1; derailIntendedTool = intended;
            // Re-anchor leg (b) — intended-vs-emitted mismatch (state block):
            // the model's own reasoning names a DIFFERENT offered tool.
            if (!reAnchorUsed && !reAnchorPending) {
              reAnchorPending = { tool: tc.name, intended, reason: 'intent_mismatch' };
            }
          }
          // Re-anchor leg (c), source 2 — document-seam tools EXECUTE (they
          // are not platform-preflighted), so an invented-id call is seen
          // HERE, off the failure result, via the same grounding rule the
          // preflight uses (detection only — no refusal-behavior change).
          // The haystack EXCLUDES this call's own just-pushed result
          // (messages.slice(0, -1)): the existence-refusal envelope echoes
          // the invented id back ("No generated file with id noop…"), which
          // would otherwise ground it.
          if (!intended && DOC_SEAM_ID_TOOLS.has(tc.name)) {
            const badDocIds = findUngroundedIdArgs(argsPreview, groundingHaystack(messages.slice(0, -1))).map((b) => b.value).slice(0, 3);
            if (badDocIds.length) {
              inventedIdSignals += 1;
              // Same streak signature as source 1: the SECOND bare invented-
              // id signal in the run (the first is ordinary containment).
              if (!reAnchorUsed && !reAnchorPending && inventedIdSignals >= 2) {
                reAnchorPending = {
                  tool: tc.name, intended: null, reason: 'placeholder_streak',
                  badIds: badDocIds, count: inventedIdSignals,
                };
              }
            }
          }
          // ── D5 supervisor-only refusal ladder (tool-scope.ts, 2026-09-27) ──
          // A supervisor-only tool refused OUTSIDE a supervisor chat — the
          // executor's `reason:"supervisor_only"` envelope, or the not-offered
          // pre-flight refusal of a tool this profile never carries — can
          // never succeed in this run (prod 28de72e5: 90 refused calls, the
          // old `{"error":…}` shape read as SUCCESS and reset the streak each
          // time). Count per tool; at supervisorOnlyPermaAfter() (default 2)
          // the tool leaves the schema for the rest of the run. It is a SCOPE
          // refusal of a tool the lane never had, NOT a decoder derailment
          // episode, so it feeds NO trip into derailTripCounts (review fixer
          // 2026-09-27: pre-loading 2 trips let ONE later ordinary 3-failure
          // streak on any other tool end the run) — the run-end / rescue gate
          // below never sees it. BOTH sources are gated on the PROFILE, never
          // on what the executor answered: a supervisor-profiled lane
          // (`profile.supervisorTools`) never enters this ladder, so a
          // transient state-read failure (isSupervisorChat is false on ANY
          // DB error) cannot perma-lock a real supervisor out of its own
          // state tools mid-wake. Kill switch: SUPERVISOR_ONLY_PERMA_DISABLED=1.
          const supervisorOnlyAfter = supervisorOnlyPermaAfter();
          // (a tool already perma-withheld is not re-counted — its later
          // emissions are the ordinary withheld pre-flight refusals, which
          // the tool_preflight strike already records.)
          const supervisorOnlySource = supervisorOnlyAfter > 0 && !profile.supervisorTools && isSupervisorOnlyTool(tc.name) && !permaWithheld.has(tc.name)
            ? (isSupervisorOnlyRefusal(result || '') ? 'executor'
              : (preflightResult !== null && offeredNames.size > 0 && !offeredNames.has(tc.name) ? 'preflight' : null))
            : null;
          if (supervisorOnlySource) {
            const refusals = (supervisorOnlyRefusals.get(tc.name) ?? 0) + 1;
            supervisorOnlyRefusals.set(tc.name, refusals);
            const perma = refusals >= supervisorOnlyAfter && !permaWithheld.has(tc.name);
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              meta: { seam: 'supervisor_only_refusal', tool: tc.name, source: supervisorOnlySource, count: refusals, after: supervisorOnlyAfter, outcome: perma ? 'perma_withheld' : 'counted' },
            });
            if (perma) {
              permaWithheld.add(tc.name);
              if (withheldTool === tc.name) withheldTool = null;
              // no derailTripCounts entry — see the block comment above
              derailNoticePerma = true;
              failStreakTool = ''; failStreakCount = 0;
              // DW-4: snapshot the streak's args beside the texts at trip time
              // (same 8579d419 discipline — captured at counting time, never
              // re-derived at trip time).
              derailNoticeTexts = failStreakTexts; derailNoticeArgs = failStreakArgs; failStreakTexts = []; failStreakArgs = [];
              derailNoticeTool = tc.name; // pushed after the batch completes (same deferral as the streak trip)
              derailNoticeShape = 'supervisor_only';
              derailNoticeChurned = false;
              agentWarn(`coding agent [${agentLabel}]: ${tc.name} refused ${refusals}× as supervisor-only outside a supervisor chat — perma-withheld (D5)`);
            }
          }
          if (failStreakCount >= 3 && !withheldTool && !permaWithheld.has(tc.name)) {
            const trips = (derailTripCounts.get(tc.name) ?? 0) + 1;
            derailTripCounts.set(tc.name, trips);
            // Slot reset before the perma check (reviewer 8d77c84f compound
            // path): a same-batch earlier trip may have left perma=true —
            // this trip's own trips>=2 branch re-sets it below.
            derailNoticePerma = false;
            if (trips >= 2) {
              permaWithheld.add(tc.name); // second lock on the same tool: gone for the rest of the run
              derailNoticePerma = true;
            } else {
              withheldTool = tc.name;
              withheldUntilStep = step + 2; // absent for exactly the next model round
            }
            failStreakTool = ''; failStreakCount = 0;
            derailNoticeTexts = failStreakTexts; derailNoticeArgs = failStreakArgs; failStreakTexts = []; failStreakArgs = []; // ride the deferred notice (tickets 8579d419 + DW-4)
            derailNoticeTool = tc.name; // pushed after the batch completes
            // Reviewer 8d77c84f BLOCKING finding (d73765fc follow-up,
            // 2026-09-23): a trip must OWN every deferred-notice slot field
            // it renders. A same-batch success trip earlier in the turn (only
            // a PERMA success trip leaves withheldTool clear for another
            // tool's trip) has already written shape='success_intent' —
            // overwriting texts+tool but NOT the shape files this FAILURE
            // trip under the success title over failure texts, the inverse
            // of the d73765fc mislabel. Reset both shape fields with the
            // rest of the slot.
            derailNoticeShape = 'failure';
            derailNoticeChurned = false;
          }
        } else {
          if (tc.name === failStreakTool) {
            failStreakTool = ''; failStreakCount = 0; failStreakTexts = []; failStreakArgs = []; // a success (or exempt tool) ends the streak
          }
          // SUCCESS-side wrong-tool leg (ticket 2c98b460 — see the state
          // block): on a successful result the failure ladder is blind, so
          // the intent mismatch is counted HERE, with the same detector
          // input as the failure branch (:3483). run_command exempt.
          if (tc.name !== 'run_command') {
            const successIntended = internalOrNull(detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText || turn.content || ''}`, tc.name, offeredNamesBothForms(offeredNames), argsPreview));
            if (successIntended) {
              // Ticket f6217896 — BATCH-SIBLING acquittal (see the state
              // block): when the SAME dispatched batch emitted the "intended"
              // tool as its own call, the narration's mention is consumed by
              // that sibling (the itemized-checklist batch shape), so this
              // call is aligned batch work, not a wrong-tool substitution.
              // Same-batch ONLY — cross-batch emission never acquits (the
              // ee39f231 precursor pin). Bounded telemetry.
              const batchSibling = successIntended !== tc.name
                && dispatchCalls.some((c) => c.name === successIntended);
              if (batchSibling) {
                // Shadow streak first (the 0625bf62 idiom): classic counting
                // that the acquittal never resets, so the row's streak stays
                // comparable with the pre-fix conviction baseline.
                if (tc.name === intentMissLogTool) {
                  intentMissLogCount += 1;
                } else {
                  intentMissLogTool = tc.name; intentMissLogCount = 1;
                }
                batchSiblingAcquittals += 1;
                if (batchSiblingAcquittals <= 12) { // same telemetry bound as the discount probe
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.GUARD_MISS,
                    sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                    meta: {
                      seam: 'tool_intent_attribution',
                      tool: tc.name, intended: successIntended,
                      reason: 'batch_sibling', marker: successIntended,
                      batch: dispatchCalls.length, streak: intentMissLogCount,
                    },
                  });
                }
                intentMissTool = ''; intentMissCount = 0; intentMissLastNamed = ''; intentMissChurned = false;
                intentMissArgs = []; // DW-4: acquittal resets the streak — its args die with it
              }
              if (!batchSibling) {
              // Ticket 0625bf62: compute the discount ONCE per mismatch (the
              // measure-only probe used to compute it only inside its logging
              // guard) so the armed application below and the measurement row
              // share one evaluation. PLATFORM-TOOL SCOPE (see the state
              // block): the haystack matches generic coding doctrine (e.g. the
              // system prompt's own update_plan line), so the discount is
              // APPLIED only for platform tools — every coding-tool mismatch
              // keeps today's exact count/steer/trip behavior.
              if (wakeOrders === null) wakeOrders = wakePromptHaystack(messages);
              const rawDiscount = !platformToolNames.has(tc.name)
                ? null
                : intentMismatchDiscount(successIntended, tc.name, wakeOrders);
              // 0625bf62 runaway backstop (state block): the discount is
              // bounded per tool per run — past the discountArmCap() ceiling
              // of discounted mismatches on one tool, the classic ladder owns
              // that tool again (a decoder-locked archive loop is contained at
              // cap+5 instead of running to maxSteps).
              const discount = rawDiscount && (intentDiscountApplied.get(tc.name) ?? 0) < discountArmCap() ? rawDiscount : null;
              if (discount) intentDiscountApplied.set(tc.name, (intentDiscountApplied.get(tc.name) ?? 0) + 1);
              // ARMED (0625bf62): an ordered/pre-computed mismatch on a
              // platform tool is ALIGNED, not derailment — the measured class
              // (92b485bd schedule_get ×5; canlegal-bench 615723ba
              // archive_chat 9/9) was 100% correct batch work. Reset the
              // streak exactly like an aligned success and skip the count-up,
              // the 3rd-mismatch re-anchor arm, and the 5th-mismatch trip
              // (this branch returns to the shared else below by falling
              // through to the reset at its tail). The kill switch restores
              // measure-only behavior.
              if (discount) {
                intentMissTool = ''; intentMissCount = 0; intentMissLastNamed = ''; intentMissChurned = false;
              } else {
              // Pair-agnostic streak (ticket c737d007): the key is the
              // CALLED tool — a churning NAMED intent no longer resets the
              // count (the legacy pair key made churn self-erasing).
                if (tc.name === intentMissTool) {
                  intentMissCount += 1;
                  if (successIntended !== intentMissLastNamed) intentMissChurned = true;
                } else {
                  intentMissTool = tc.name; intentMissCount = 1; intentMissChurned = false;
                }
                intentMissLastNamed = successIntended;
                // DW-4 (568d3652 gap): every counted miss contributes its args
                // to the STREAK-OWNED accumulator — never the live
                // derailNoticeArgs slot (a pending deferred notice from the
                // failure ladder must survive this ladder's counting
                // untouched — the 092382fd corruption class), and a trip
                // resets this streak before the snapshot below lands. The
                // churned trip thus renders the FULL rotation history, not
                // just the final call (newest first). RSW-1 cluster 29: the
                // STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted here —
                // capture is unconditional.
                //
                // Review BLOCKING A (round 3): same helper as the fail-streak
                // snapshot — mask the full string, then clip. This
                // accumulator rides council prompts and persisted rows.
                intentMissArgs.unshift(maskDeliverSecretsInArgsString(String(tc.arguments || '')).slice(0, 200));
                if (intentMissArgs.length > 3) intentMissArgs.length = 3;
              }
              // MEASUREMENT SHADOW (58e675c9 probe — unchanged output, now
              // riding the shared discount evaluation): record each mismatch
              // the discount WOULD absorb — armed or not, any tool — as a
              // guard_miss row (a registered miss kind) with meta.seam so the
              // 13b2f286 seam-queryable idiom survives the arming; the row's
              // `streak` is the measurement-shadow streak (classic
              // pre-0625bf62 counting, never reset by the armed discount) so
              // post-arming telemetry stays comparable with the baseline.
              if (tc.name === intentMissLogTool) {
                intentMissLogCount += 1;
              } else {
                intentMissLogTool = tc.name; intentMissLogCount = 1;
              }
              if (intentDiscountLogs < 12) {
                // audit 2026-10-06 T1-9: the measurement reads the WAKE/task text
                // only (wakePromptHaystack excludeSystem) — a system-prompt
                // doctrine line no longer counts as an ordered call. An ARMED
                // discount (platform tools, full haystack) is still logged so its
                // effect stays visible (haystack 'system' when only the system
                // prompt matched). Kill switch INTENT_MEASURE_SYSTEM_EXCLUDE_DISABLED=1.
                const measureExcl = !intentMeasureSystemExcludeDisabled();
                if (measureExcl && wakeOrdersNoSystem === null) wakeOrdersNoSystem = wakePromptHaystack(messages, { excludeSystem: true });
                const wakeDiscount = measureExcl ? intentMismatchDiscount(successIntended, tc.name, wakeOrdersNoSystem ?? '') : null;
                const logDiscount = measureExcl
                  ? (wakeDiscount ?? discount)
                  : (discount ?? intentMismatchDiscount(successIntended, tc.name, wakeOrders));
                if (logDiscount) {
                  intentDiscountLogs += 1;
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.GUARD_MISS,
                    sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
                    meta: {
                      seam: 'tool_intent_attribution',
                      tool: tc.name, intended: successIntended,
                      reason: logDiscount.reason, marker: logDiscount.marker,
                      line: logDiscount.line || undefined, streak: intentMissLogCount,
                      ...(measureExcl ? { haystack: wakeDiscount ? 'wake' : 'system', armed: !!discount } : {}),
                    },
                  });
                }
              }
              // THIRD consecutive mismatched success: arm the one-per-run
              // re-anchor (reason 'intent_mismatch_success' — the flush
              // threads the marker and renders a TRUTHFUL "it SUCCEEDED"
              // calledLine; the failure side's legs are untouched).
              if (intentMissCount >= 3 && !reAnchorUsed && !reAnchorPending) {
                reAnchorPending = { tool: tc.name, intended: successIntended, reason: 'intent_mismatch_success', churned: intentMissChurned };
              }
              // FIFTH: trip into the existing withhold → perma → run-end
              // ladder (derailTripCounts feeds the :3610 run-end gate; the
              // schema filter at :2005-2008 enforces the withhold).
              if (intentMissCount >= 5 && !withheldTool && !permaWithheld.has(tc.name)) {
                const trips = (derailTripCounts.get(tc.name) ?? 0) + 1;
                derailTripCounts.set(tc.name, trips);
                // Slot reset before the perma check (reviewer 8d77c84f
                // compound path): a same-batch earlier trip may have left
                // perma=true — this trip's own trips>=2 branch re-sets it.
                derailNoticePerma = false;
                if (trips >= 2) {
                  permaWithheld.add(tc.name); // second lock on the same tool: gone for the rest of the run
                  derailNoticePerma = true;
                } else {
                  withheldTool = tc.name;
                  withheldUntilStep = step + 2; // absent for exactly the next model round
                }
                const churnedTrip = intentMissChurned;
                intentMissTool = ''; intentMissCount = 0; intentMissLastNamed = ''; intentMissChurned = false;
                derailNoticeArgs = intentMissArgs; intentMissArgs = []; // DW-4: the streak's args ride the deferred notice (same 8579d419 move-and-clear discipline)
                intentMissLogTool = ''; intentMissLogCount = 0; // measurement shadow resets with the live streak (trip)
                derailIntendedTool = successIntended;
                // The texts ride the reflection/attribution evidence
                // (recentFailures) — the auto-filed mishap then carries the
                // SUCCESS shape verbatim instead of a mislabeled "failure".
                // Under churn the named intent ROTATED: say so truthfully —
                // the fixed "named X" template would mislabel a churn catch
                // (the gotcha-1 mislabel class, one surface down).
                // DW-4: this churned trip is a SUCCESS-side shape (the calls
                // SUCCEEDED, wrong tool) — the args of the 5 succeeding calls
                // ride recentArgs via the per-miss capture above, so
                // attribution needs no transcript probe (backlog: the
                // churned-trip path shares the gap).
                derailNoticeTexts = [churnedTrip
                  ? `${tc.name} kept SUCCEEDING while the run's own reasoning named a rotating set of OTHER tools (latest: ${successIntended}) — wrong-tool derailment on successful calls (${tc.name} ×5 consecutive, named intent churned, tickets 2c98b460+c737d007).`
                  : `${tc.name} kept SUCCEEDING while the run's own reasoning named ${successIntended} — wrong-tool derailment on successful calls (${tc.name}→${successIntended} ×5 consecutive, ticket 2c98b460).`];
                derailNoticeTool = tc.name; // pushed after the batch completes
                derailNoticeShape = 'success_intent'; // the notice + its metric below render the success shape
                derailNoticeChurned = churnedTrip; // rides the trip metric as meta.churned
              }
              } // end if (!batchSibling) — ticket f6217896 batch-sibling acquittal scope
            } else {
              intentMissTool = ''; intentMissCount = 0; intentMissLastNamed = ''; intentMissChurned = false; // an aligned success ends the mismatch streak
              intentMissArgs = []; // DW-4: a reset streak carries no args — only a TRIP hands them to the notice
              intentMissLogTool = ''; intentMissLogCount = 0; // …and the measurement shadow with it
            }
          }
        }
      }

      // ── Auto re-anchor steer injection (ticket 431518a2) — deferred past
      // the batch for the same tool_call_ids-answered reason as the derail
      // notice below (a role:'user' message may only follow a fully-answered
      // assistant tool_calls turn). Fires BEFORE the breaker block so the
      // steer lands even when the same batch also trips a withhold; when the
      // breaker ends the run right after, the guard-marked transcript part
      // still records that the harness tried the in-run steer. ONE per run —
      // a second derail signature proceeds through the breaker UNCHANGED.
      // ── SLIP ECHO PRUNE (tool-scope.ts cause 3, owner 2026-09-22): when EVERY
      // call this turn was a refused slip (ungrounded placeholder id / a tool not
      // offered), the model's next request would replay its own slip plus our
      // refusal — prod showed the immediate repeat (seq 839 → 841). Remove the
      // assistant record + its refusals from the replayed transcript and leave
      // ONE harness line that restates what the reasoning meant to do. Only a
      // pure-slip turn qualifies: a turn that also ran real tools keeps its
      // full record (their results are evidence). Live-view parts and
      // telemetry already recorded the slip; only the MODEL's context changes.
      if (slipRefusals.length && slipRefusals.length === turn.toolCalls.length && dispatchCalls.length === turn.toolCalls.length) {
        const ids = new Set(slipRefusals.map((r) => r.id));
        let ai = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m: any = messages[i];
          if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((c: any) => ids.has(c?.id))) { ai = i; break; }
        }
        if (ai >= 0) {
          for (let i = messages.length - 1; i > ai; i--) {
            const m: any = messages[i];
            if (m?.role === 'tool' && ids.has(m.tool_call_id)) messages.splice(i, 1);
          }
          messages.splice(ai, 1);
          const first = slipRefusals[0];
          const shown = slipRefusals.map((r) => `${r.emitted}${r.ids.length ? `(${r.ids.map((v) => JSON.stringify(v)).join(', ')})` : ''}`).join(', ');
          const why = first.reason === 'ungrounded_id'
            ? 'the id was a placeholder, not an id any tool returned this run'
            // audit 2026-10-06 T5-7: the pruned slip keeps the lane-only answer (where the tool lives).
            : first.laneOnly ? laneOnlyToolHint(first.emitted)
            : 'that tool is not in your tool list for this session (it is out of scope for this task)';
          const intendedShown = first.intended ? modelToolName(first.intended) : null;
          const said = (turn.content || '').trim().replace(/\s+/g, ' ').slice(0, 200);
          messages.push({
            role: 'user',
            content: `[HARNESS NOTICE — not typed by the user] SLIP REMOVED: your last function call (${shown}) did not execute — ${why} — and has been removed from your transcript so you do not repeat it.` +
              (said ? ` You had written: "${said}".` : '') +
              (intendedShown ? ` Your reasoning named ${intendedShown} — call ${intendedShown} now with its real parameters.` : ' Continue with the action your reasoning was about to take; if nothing needs a tool, write your answer.'),
          });
          emit('progress', { message: `Removed a slipped ${first.emitted} call from the model's context (${first.reason})`, stage: 'slip-prune' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'slip_echo_pruned', outcome: 'pruned', tool: first.tool, reason: first.reason, calls: slipRefusals.length, intended: first.intended ?? undefined },
          });
        }
      }
      if (reAnchorPending) {
        const { tool: raTool, intended: raIntended, reason: raReason, badIds: raBadIds, count: raCount, churned: raChurned } = reAnchorPending;
        reAnchorPending = null;
        if (!reAnchorUsed) {
          reAnchorUsed = true;
          const toolsetLine = [...offeredNames].map(modelToolName).sort().join(', ');
          // Model-facing spellings in the steer (tool-scope.ts) — the model must
          // be told the names it can actually emit.
          const raToolShown = modelToolName(raTool);
          const raIntendedShown = raIntended ? modelToolName(raIntended) : raIntended;
          const calledLine = raReason === 'tool_not_offered'
            ? `You called ${raToolShown} — no tool named ${raToolShown} exists in this session, so nothing executed.`
            : raReason === 'placeholder_streak'
              ? `You called ${raToolShown} with an invented entity id (${(raBadIds ?? []).map((v) => `"${v}"`).join(', ')}) — invented-id refusal #${raCount ?? 2} this run; every one was refused before executing because the id appears in NO tool result you hold. Entity ids come ONLY from real tool results this run (list_files, get_feedback, todo_list, …) — never from memory, narration, or invention.`
              : raReason === 'intent_mismatch_success'
                ? `You called ${raToolShown} and it SUCCEEDED — but your own reasoning named ${raIntendedShown}, a DIFFERENT tool. That narration/emission mismatch on SUCCESSFUL calls is the wrong-tool derail signature all the same.`
                : `You called ${raToolShown} and it failed — but your own reasoning named ${raIntendedShown}, a DIFFERENT tool. That narration/emission mismatch is the wrong-tool derail signature.`;
          const intendedLine = raIntended
            ? ` ${raIntendedShown} IS in your tool list — call ${raIntendedShown} NOW with its real parameters (take ids only from real tool results this run; never invent one).`
            : '';
          const steer = `[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run): a wrong-tool call was intercepted mid-run. ${calledLine}${intendedLine}\n\nYour ACTUAL tool list for the rest of this run is exactly: ${toolsetLine}. Any tool call whose name is not on this list fails without executing.\n\nThis is the run's ONLY re-anchor. If the wrong-tool loop continues, the derail breaker will withhold the looping tool and eventually end the run — recover NOW by calling the tool you actually meant.`;
          messages.push({ role: 'user', content: steer });
          const partText = raReason === 'placeholder_streak'
            ? `[HARNESS] Re-anchor steer injected: placeholder-id streak on ${raTool} (${raCount ?? 2} invented-id refusals this run) — the live run was re-anchored to its real toolset (one per run).`
            : `[HARNESS] Re-anchor steer injected: wrong-tool signature on ${raTool}${raIntended ? ` (reasoning named ${raIntended})` : ''} — the live run was re-anchored to its real toolset (one per run).`;
          parts.push(stampPart({ type: 'text', text: partText, marker: 'guard' }));
          emit('guard_marker', { text: partText, struckPrev: false });
          emit('progress', {
            message: raReason === 'placeholder_streak'
              ? `Placeholder-id streak on ${raTool} — re-anchoring steer injected (one per run)`
              : `Wrong-tool signature on ${raTool} — re-anchoring steer injected (one per run)${raIntended ? `: call ${raIntended}` : ''}`,
            stage: 'derail-reanchor',
          });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'tool_derail_reanchor', tool: raTool, intended: raIntended ?? undefined, reason: raReason, count: raCount, churned: raReason === 'intent_mismatch_success' ? (raChurned ?? false) : undefined },
          });
        }
      }

      // Cross-turn repeated-line WARNING (ticket 03587322) — pushed HERE, after
      // every tool_call in the batch has its tool result (the same deferral rule
      // as the derail notice below; adversarial-review F1: the pre-dispatch push
      // reproduced the pass-#4 interleave hazard and rode the transcript-repair
      // belt as a spurious transcript_repair strike).
      if (lineRepeatNotice) {
        const notice = lineRepeatNotice;
        messages.push({ role: 'user', content: `[HARNESS NOTICE — not typed by the user] You have now repeated the identical line "${notice.line.slice(0, 160)}" ${notice.count} times across ${notice.turns} turns of this run. Restating an intention is not execution: if the action it names has not happened, either execute it NOW with one real tool call, or drop it and finish from the results you already have. Repeating that line again ENDS this run.` });
      }

      // ── NO-PROGRESS BRAKE (audit 2026-10-06 T1-7, no-progress-brake.ts):
      // ≥ N consecutive calls that changed nothing while a plan step is
      // in_progress → ONE notice per run ("make the core change now or state
      // the blocker"). Pushed here, after every tool result of the batch (the
      // same deferral rule as the notices around it). Kill switch
      // NO_PROGRESS_BRAKE_DISABLED=1.
      // audit 2026-10-08 W2-7: v2 re-fires with ESCALATION every N further
      // no-progress calls (≤ NO_PROGRESS_MAX_RUNGS per streak; a real change —
      // the lane's or a worker's — re-arms it). NO_PROGRESS_BRAKE_V2_DISABLED=1
      // = the one-shot brake.
      const npV2 = !noProgressBrakeV2Disabled();
      if (topLevel && profile.kind === 'coding' && npV2 && workerProgressCalls > workerProgressSeen) {
        noProgressCalls = 0; noProgressCheckedAt = 0; workerProgressSeen = workerProgressCalls;
        noProgressRung = 0; noProgressNextAt = 0;
      }
      if (topLevel && profile.kind === 'coding' && (npV2 ? noProgressRung < NO_PROGRESS_MAX_RUNGS : !noProgressNoticed) && !noProgressBrakeDisabled()) {
        const npThreshold = noProgressBrakeThreshold();
        const npDueAt = npV2 && noProgressNextAt > 0 ? noProgressNextAt : npThreshold;
        if (noProgressCalls >= npDueAt && (noProgressCheckedAt === 0 || noProgressCalls - noProgressCheckedAt >= NO_PROGRESS_RECHECK_EVERY)) {
          noProgressCheckedAt = noProgressCalls;
          const npPlan = await getPlan(input.sessionId).catch(() => null);
          const npStep = npPlan?.steps.find((s) => s.status === 'in_progress');
          if (npStep) {
            noProgressNoticed = true;
            noProgressRung += 1;
            noProgressNextAt = noProgressCalls + npThreshold;
            const escalated = npV2 && noProgressRung > 1;
            messages.push({ role: 'user', content: escalated ? noProgressEscalationNotice(noProgressCalls, npStep, noProgressRung) : noProgressNotice(noProgressCalls, npStep) });
            emit('progress', { message: escalated
              ? `${noProgressCalls} tool calls without changing anything (no-progress check #${noProgressRung}) — telling the run to make the change or stop with a blocker report`
              : `${noProgressCalls} tool calls without changing anything — nudging the run to make the core change or name the blocker`, stage: 'no-progress' });
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.NO_PROGRESS_BRAKE,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              value: noProgressCalls, unit: 'calls',
              meta: { calls: noProgressCalls, threshold: npThreshold, step: npStep.id, stepText: String(npStep.text ?? '').slice(0, 160), lastTools: [...noProgressRecent], ...(npV2 ? { rung: noProgressRung, workerChanges: workerProgressCalls } : {}) },
            });
          }
        }
      }

      // Derail-break notice — AFTER every tool_call in the batch has its tool
      // result (see the deferral note above; role:'user' may only follow a
      // fully-answered assistant tool_calls turn).
      if (derailNoticeTool) {
        // Ticket 8579d419: the streak's own failure texts, captured at
        // counting time. The legacy fallback (last 3 tool-role messages)
        // mislabels any tool's results — including SUCCESSES — as "Failure
        // texts" and is kept only as a defensive non-empty default. Hoisted
        // above the terminal branch (2026-09-10 run-end parity) so BOTH exits
        // carry the same evidence.
        const streakFailureTexts = derailNoticeTexts.length
          ? derailNoticeTexts.slice(0, 3)
          : [...messages].reverse()
            .filter((m: any) => m?.role === 'tool' && typeof m.content === 'string' && m.content)
            .slice(0, 3).map((m: any) => String(m.content));
        // ── N1 terminal state (remediation P1, 2026-09-08): trips on ≥2
        // DIFFERENT tools, or a 3rd trip total, mean the decoder lock survives
        // per-tool withholding (1-round ban → perma both already fired) — more
        // rounds only burn budget. END the run HONESTLY: completed-with-note
        // (never failed/wedged — the executor finalizes 'completed' and the
        // journal records the note), naming the tool the pre-flight says the
        // model meant. The next firing starts with a fresh decoder state.
        // (RSW-1: the endless-withholding kill switch was deleted 2026-11-02.)
        const derailTripsTotal = [...derailTripCounts.values()].reduce((s, n) => s + n, 0);
        if (derailTripCounts.size >= 2 || derailTripsTotal >= 3) {
          const intendedNote = derailIntendedTool && derailIntendedTool !== derailNoticeTool
            ? `; intended tool appears to be ${derailIntendedTool}` : '';
          const note = `[HARNESS] Run ended: repeated wrong-tool derailment (${derailTripsTotal} episodes${intendedNote}). The next scheduled firing starts fresh.`;
          parts.push(stampPart({ type: 'text', text: note, marker: 'guard' }));
          emit('guard_marker', { text: note, struckPrev: false });
          emit('progress', { message: `Run ended after ${derailTripsTotal} wrong-tool derailment episodes across ${derailTripCounts.size} tool(s)`, stage: 'derail-break' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId,
            meta: {
              seam: 'tool_derail_break', state: 'ended_run',
              tool: derailNoticeTool, perma: derailNoticePerma,
              trips: derailTripsTotal, tools: [...derailTripCounts.keys()],
              intended: derailIntendedTool ?? undefined,
            },
          });
          // ── Derail-rescue continuation (ticket ff1fa1b5, 2026-09-20): the
          // N1 terminal end is honest but the NEXT firing starts blind — n=3
          // same-day runs ended here with their intended work undelivered and
          // the only observed recovery was a MANUAL fresh run + supervisor
          // steer. Automate it: ONE durable continuation wake carrying the
          // intended next step verbatim (machine runs only, per-chat daily
          // budget, kill switch — see coding/derail-rescue.ts). The ended_run
          // note stays byte-identical; the rescue rides its own guard part.
          // Best-effort — never throws into the loop.
          try {
            const { enqueueDerailRescue } = await import('./derail-rescue');
            const rescue = await enqueueDerailRescue({
              sessionId: input.sessionId, runId: input.runId,
              tools: [...derailTripCounts.keys()], intended: derailIntendedTool,
              trips: derailTripsTotal,
              goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
              userTurnAt: input.userTurnAt,
            });
            if (rescue.rescued) {
              const rescueText = `[HARNESS] Derail-rescue: enqueued a fresh continuation for this chat carrying the intended next step${derailIntendedTool ? ` (call ${derailIntendedTool})` : ''} verbatim — rescue #${rescue.count} of at most ${rescue.max} in 24 h.`;
              parts.push(stampPart({ type: 'text', text: rescueText, marker: 'guard' }));
              emit('guard_marker', { text: rescueText, struckPrev: false });
              emit('progress', { message: `Derail-rescue continuation enqueued (#${rescue.count}/${rescue.max})`, stage: 'derail-rescue' });
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
                sessionId: input.sessionId, runId: input.runId,
                meta: {
                  seam: 'tool_derail_rescue', state: 'continuation_enqueued',
                  tool: derailNoticeTool, intended: derailIntendedTool ?? undefined,
                  trips: derailTripsTotal, count: rescue.count, max: rescue.max,
                },
              });
            }
          } catch { /* the terminal end above is already honest — a failed rescue changes nothing */ }
          finalText = finalText ? `${finalText}\n\n${note}` : note;
          // F2: the run is ending on repeated derailment — the trigger holds, so the harness convenes the frontier
          // council now (the agent has no step left to do it) and the SHORT advice rides the final note; the full
          // answers are a transcript part. The next firing reads both. Fail-open; its wait is off the deadline.
          if (frontierCouncil && derailNoticeShape !== 'supervisor_only') {
            try {
              frontierCouncil.noteStreakTrip({
                tool: derailNoticeTool, texts: streakFailureTexts, args: derailNoticeArgs, perma: derailNoticePerma,
                shape: derailNoticeShape, intended: derailIntendedTool, step, terminal: true,
              });
              const fcT0 = Date.now();
              const fc = await frontierCouncil.escalateAtRunEnd({ ...councilStepState({ step }), reason: 'the run is ending on repeated wrong-tool / failure loops' });
              deadlineOffsetMs += Date.now() - fcT0;
              if (fc) finalText = `${finalText}\n\n${fc.compact}`;
            } catch { /* advisory only */ }
          }
          // RUN-END parity (2026-09-10): this branch exits BEFORE the
          // reflection block below — without this, a run ending for repeated
          // derailment got neither consult nor attribution ticket. File the
          // deduped investigation ticket (fire-and-forget); the consult is
          // SKIPPED — the run is ending, so the NEXT firing benefits from
          // the ticket, not this one.
          try {
            const { fileStreakInvestigation } = await import('./reflection');
            void fileStreakInvestigation({
              sessionId: input.sessionId, runId: input.runId, tool: derailNoticeTool,
              perma: derailNoticePerma, intended: derailIntendedTool, recentFailures: streakFailureTexts,
              recentArgs: derailNoticeArgs, // DW-4: the streak's own tool args, captured at counting time
              // Ticket d73765fc: the ticket + consult render the trip's shape —
              // a success-side trip is NOT a tool-failure streak. (D5: a
              // supervisor-only perma that closed a run-end files under the
              // failure shape — its recentFailures ARE the refusal envelopes.)
              shape: derailNoticeShape === 'supervisor_only' ? 'failure' : derailNoticeShape,
              goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
            });
          } catch { /* attribution must never block the run end */ }
          derailNoticeTool = null;
          derailNoticePerma = false;
          derailIntendedTool = null;
          derailNoticeTexts = [];
          derailNoticeArgs = []; // DW-4
          derailNoticeShape = 'failure';
          derailNoticeChurned = false;
          done = true;
          break; // completed-with-note — the done guards below skip goal-continue/auto-verify
        }
        const intendedHint = derailIntendedTool && derailIntendedTool !== derailNoticeTool
          ? ` Your own reasoning named ${derailIntendedTool} — that is the tool you meant: call ${derailIntendedTool} now with its real parameters.`
          : '';
        // Reflection consult + attribution (owner doctrine 2026-09-10): a
        // DIFFERENT decoder diagnoses the stuck lane (advice rides the notice),
        // and ONE deduped investigation ticket asks the fleet to attribute the
        // streak to framework-vs-model. Bounded + fail-open — the notice never
        // waits on a broken consult.
        let reflectionAdvice: string | null = null;
        // F2: count the trip toward the frontier council. When THIS trip escalates (a repeated failure — the reflect
        // note lands at the next step), the one-model Double-Checker consult is skipped: the frontier council
        // supersedes it. Kill switch FRONTIER_REFLECTION_COUNCIL_DISABLED=1 ⇒ no council ⇒ today's consult.
        let councilEscalates = false;
        if (frontierCouncil && derailNoticeShape !== 'supervisor_only') {
          councilEscalates = frontierCouncil.noteStreakTrip({
            tool: derailNoticeTool, texts: streakFailureTexts, args: derailNoticeArgs, perma: derailNoticePerma,
            shape: derailNoticeShape, intended: derailIntendedTool, step,
          });
        }
        // D5: a supervisor-only refusal is deterministic — nothing for a second
        // decoder to diagnose and no framework-vs-model question to file.
        if (derailNoticeShape !== 'supervisor_only') try {
          const { consultCrossCheckerOnStreak, fileStreakInvestigation, REFLECTION_MAX_PER_RUN } = await import('./reflection');
          const evidence = {
            sessionId: input.sessionId, runId: input.runId, tool: derailNoticeTool,
            perma: derailNoticePerma, intended: derailIntendedTool, recentFailures: streakFailureTexts,
            recentArgs: derailNoticeArgs, // DW-4: the streak's own tool args, captured at counting time
            // Ticket d73765fc: the ticket + consult render the trip's shape —
            // a success-side trip is NOT a tool-failure streak.
            shape: derailNoticeShape as 'failure' | 'success_intent',
            goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
          };
          void fileStreakInvestigation(evidence);
          if (reflectionConsults < REFLECTION_MAX_PER_RUN && !councilEscalates) {
            // N8: the route gate rides the consult (shadow: concurrent; act:
            // a confident route skips it). The pending handle is labelled at
            // the lane's next completed turn (see the post-turn hook above).
            reflectionAdvice = await consultCrossCheckerOnStreak(evidence, { onRoutePending: (p) => { pendingReflectionRoute = p; } });
            if (reflectionAdvice) reflectionConsults += 1;
          }
        } catch { /* reflection must never block the breaker */ }
        // N8 ACT only: the consult was skipped on a confident typed route — render
        // the one-line hint in its place (never as "second-model diagnosis").
        let routeHint = '';
        try {
          // (assigned inside the consult's callback — widen past TS's flow narrowing)
          const p = pendingReflectionRoute as import('./reflection').ReflectionRoutePending | null;
          if (p?.acted && p.route && p.route !== 'needs_diagnosis') {
            const { REFLECTION_ROUTE_HINT } = await import('./reflection');
            const hint = REFLECTION_ROUTE_HINT?.[p.route];
            if (hint) routeHint = `\n[REFLECTION ROUTE — harness decision gate] ${hint}`;
          }
        } catch { /* the notice stands without the hint */ }
        const adviceNote = reflectionAdvice
          ? `\n[CROSS-CHECK REFLECTION — independent second-model diagnosis of your failure loop] ${reflectionAdvice}`
          : councilEscalates
            ? '\n[FRONTIER COUNCIL] These failures repeat — before your next step the harness posts a reflect note: write your reflection, then consult the frontier council.'
            : routeHint;
        messages.push({ role: 'user', content: (derailNoticeShape === 'supervisor_only'
          // D5: a deterministic refusal — name the reason and the honest outlet, never "try a different tool".
          ? `[HARNESS NOTICE — not typed by the user] ${modelToolName(derailNoticeTool)} is only available on a supervisor chat (Fleet / Project Supervisor) and THIS chat is not one, so every call of it is refused before it can do anything — ${supervisorOnlyRefusals.get(derailNoticeTool) ?? 0} refusals this run. It has been REMOVED FOR THE REST OF THIS RUN. Do not try to save supervisor state from a lane: put what you wanted to record in your final answer (or a message to your supervisor chat) and continue with the tool that advances the task.`
          : derailNoticeShape === 'success_intent'
          ? (derailNoticePerma
            ? `[HARNESS NOTICE — not typed by the user] ${derailNoticeTool} was called repeatedly while your own reasoning named a DIFFERENT tool (two wrong-tool loops on SUCCESSFUL calls this run) and has been REMOVED FOR THE REST OF THIS RUN. Call the tool your reasoning names, with its correct name and parameters.`
            : `[HARNESS NOTICE — not typed by the user] Your last 5 calls of ${derailNoticeTool} all SUCCEEDED, but your own reasoning named a DIFFERENT tool each time — a wrong-tool loop, not progress. To break it, ${derailNoticeTool} has been temporarily removed from your tool list for the next round — it returns the round after. Call the tool your reasoning names, with its correct name and parameters.`)
          : (derailNoticePerma
            ? `[HARNESS NOTICE — not typed by the user] ${derailNoticeTool} locked up again (two 3-failure streaks this run) and has been REMOVED FOR THE REST OF THIS RUN. Use a different tool for whatever you were attempting; if you were trying to call a DIFFERENT tool all along (your reasoning may already name it), call that tool with its correct name and parameters.`
            : `[HARNESS NOTICE — not typed by the user] Your last 3 calls of ${derailNoticeTool} ALL FAILED. To break the loop, ${derailNoticeTool} has been temporarily removed from your tool list for the next round — it returns the round after. If you were trying to call a DIFFERENT tool (your reasoning may already name it), call that tool now with its correct name and parameters.`)) + intendedHint + adviceNote });
        emit('progress', { message: derailNoticeShape === 'supervisor_only'
          ? `${modelToolName(derailNoticeTool)} is supervisor-only and this is not a supervisor chat — refused ${supervisorOnlyRefusals.get(derailNoticeTool) ?? 0}×, removed for the rest of the run`
          : derailNoticeShape === 'success_intent'
          ? (derailNoticePerma
            ? `${derailNoticeTool} wrong-tool looped twice on successful calls — removed for the rest of the run`
            : `${derailNoticeTool} succeeded 5× while reasoning named another tool — withheld for one round to break the loop`)
          : (derailNoticePerma
            ? `${derailNoticeTool} locked up twice — removed for the rest of the run`
            : `${derailNoticeTool} failed 3× in a row — withheld for one round to break the loop`), stage: 'derail-break' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { seam: 'tool_derail_break', tool: derailNoticeTool, perma: derailNoticePerma, intended: derailIntendedTool ?? undefined, shape: derailNoticeShape, churned: derailNoticeShape === 'success_intent' ? derailNoticeChurned : undefined },
        });
        derailNoticeTool = null;
        derailNoticePerma = false;
        derailIntendedTool = null;
        derailNoticeTexts = [];
        derailNoticeArgs = []; // DW-4
        derailNoticeShape = 'failure';
        derailNoticeChurned = false;
      }

      // ── TICKET cffd0d0a (2026-11-03): A CALL THAT NEVER RAN IS NEVER GROUNDS
      // FOR PERMANENT REMOVAL ──────────────────────────────────────────────────
      // `sevThisTurn` is true when a dispatched call's arguments were severed in
      // the TRANSPORT — the harness rejected it at dispatch, so the tool never
      // executed and NOTHING was written (`toolArgumentRejection`'s own words).
      //
      // The escalation ladder below ends in `permaWithheld`, which is right for
      // the class it was built for: a decoder lock that keeps re-emitting a call
      // whose result it ALREADY HAS. That premise needs the call to have RUN. It
      // does not hold for a severance, and the difference is load-bearing:
      //
      // MEASURED DEFECT (chat 99e63f86, 2026-11-03). A cut this seam itself
      // classifies `severed-in-transit` re-cuts a re-sent payload at the SAME byte
      // (5/5 measured on that seat), so the arguments are byte-identical across
      // turns BY CONSTRUCTION. The exact leg therefore read a TRANSPORT fault as a
      // decoder lock, escalated 1 round → 3 rounds → `permaWithheld`, and removed
      // `goal_update` from the schema for the rest of the run — `tool_repeat_break`
      // struck at 20:23:09Z and 20:28:07Z on that chat with tool=goal_update. A
      // transient wire fault became a permanent capability loss, so the
      // supervisor's owner-halt marker could NEVER land: the ticket's "then tool
      // loop-broken".
      //
      // WHY CAP RATHER THAN EXEMPT. Dropping these turns out of the signature
      // would leave a model that never closes its JSON with NO breaker at all (it
      // can emit an unfinished fragment every turn forever), and the supervisor /
      // chat profiles that hit this are the ones whose `runDeadlineMs` is the only
      // outer bound. So the streak arithmetic is left EXACTLY as it was — a wedge
      // still trips, still gets the notice, still loses the tool for 1 then 3
      // rounds — and only the PERMANENT removal is withheld for a never-executed
      // class. That keeps the tool re-offered so a reshaped retry can land the
      // write, which is the whole point, while a genuine loop stays bounded.
      //
      // This does not need to tell a transport cut from a model that emitted half
      // an object (it cannot): for BOTH, keeping the tool offered is correct and
      // the bounded withhold is the right response.
      const sevThisTurn = turn.toolCalls.some((tc) => isTransportSeveredRejection(tc.arguments, turnEvidenceOf(ctx)));
      // Reflection tracking: count consecutive identical tool signatures.
      const sig = turn.toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join('|');
      if (sig && sig === lastToolSig) repeatCount += 1; else { repeatCount = 0; lastToolSig = sig; }
      // Near-identical variant (ticket 54a172ac): digit-runs collapsed, so a
      // decoder-locked numbering loop (noop1, noop2, …) shares one signature
      // even though every call's arguments differ. Trips one turn later than
      // the exact leg (4 consecutive turns). Consequential tools ONLY
      // (NEAR_BREAK_TOOLS — review F1): content-returning reads with
      // numbered args gain information every turn and are exempt; a
      // failure-shaped turn is the derail breaker's jurisdiction
      // (turnHadFailure). Any non-counting turn breaks the near streak.
      const nearTc = turn.toolCalls.length === 1 && NEAR_BREAK_TOOLS.has(turn.toolCalls[0].name) ? turn.toolCalls[0] : null;
      const nearSig = nearTc ? `${nearTc.name}:${String(nearTc.arguments).replace(/\d+/g, '#')}` : '';
      if (turnHadFailure || !nearSig) { nearRepeatCount = 0; lastNearSig = ''; }
      else if (nearSig === lastNearSig) nearRepeatCount += 1; else { nearRepeatCount = 0; lastNearSig = nearSig; }
      // A REAL tool call breaks the narrated-announcement streak (177a31b7).
      narrLoopLast = ''; narrLoopCount = 0; narrLoopTool = null; narrLoopNudged = false;

      // ── Identical-call loop breaker (ticket e882204f — Tenstorrent firing-101,
      // 2026-09-09: kimi-k3 burned ~63min / ~70% of budget on repeated listing
      // calls; same shape reproduced on a GLM lane with 140+ duplicate
      // update_feedback calls while its own narration intended other tools). The
      // repeatCount text nudge above fires but a decoder-locked model ignores
      // text indefinitely while GOAL-CONTINUE keeps the run alive, and the
      // failure derail-breaker can't see it — these calls SUCCEED. Mechanical
      // parity with that breaker: ONE tool called with the IDENTICAL signature
      // 3 turns running (repeatCount reaches 2) is withheld from the schema for
      // exactly one model round, with an in-band notice. Documented poll tools
      // (REPEAT_BREAK_EXEMPT_TOOLS) and mixed multi-tool turns never trip it.
      //
      // Ticket 9e2c69a2 (2026-09-15): the run_command exemption covers rebuild/
      // retry/poll iteration — NEVER shell no-ops. A kimi-k3 lane (CanLaw
      // cec340f2, schedule-fired run) decoder-locked on
      // run_command({"command":"true"}) ×~30 while its narration intended a
      // board tool ("TaskGet" — a name that does not exist), then confabulated
      // "No chat-send or board tools exist in this run's toolset" (false: the
      // orchestrator schema is provisioned identically for every coding run —
      // the same chat's continuation run 40 min earlier used send_chat_message
      // successfully). Every breaker missed it: no failures (true succeeds),
      // run_command is repeat-exempt, the name was offered (no preflight). A
      // no-op-shell filler loop now loses the run_command exemption, and the
      // notice names the fleet tools the run DOES have — counter-confabulation.
      // Ticket 54a172ac (2026-09-20): the NEAR-identical leg (nearRepeatCount,
      // digit-collapsed signature) joins the exact leg below — CanLaw c510c56f
      // looped 64 todo_create calls whose titles differed only by number, so
      // every exact signature was distinct and the breaker never saw the loop.
      // Consequential tools only (NEAR_BREAK_TOOLS) — read-class numbered
      // calls are exempt (review F1).
      let noopFillerLoop = false;
      if ((repeatCount >= 2 || nearRepeatCount >= 3) && !withheldTool && turn.toolCalls.length > 0) {
        const turnToolNames = [...new Set(turn.toolCalls.map((tc) => tc.name))];
        noopFillerLoop = turnToolNames.length === 1 && turnToolNames[0] === 'run_command'
          && turn.toolCalls.every((tc) => {
            try { return isNoopShellCommand(JSON.parse(tc.arguments || '{}').command); } catch { return false; }
          });
        if (turnToolNames.length === 1 && (!REPEAT_BREAK_EXEMPT_TOOLS.has(turnToolNames[0]) || noopFillerLoop)) {
          const loopTool = turnToolNames[0];
          // The digit-collapsed leg fired (the exact leg would have tripped a
          // turn earlier) — shapes the notice/progress/metric wording below.
          const nearOnly = repeatCount < 2;
          const repeatTrips = (repeatTripCounts.get(loopTool) ?? 0) + 1;
          repeatTripCounts.set(loopTool, repeatTrips);
          // TICKET cffd0d0a: the PERMANENT rung is unreachable for a turn whose
          // call was rejected at dispatch (see the comment block above the streak
          // arithmetic). The streak itself is untouched, so the bounded rungs
          // still fire every time — a wedged lane is still interrupted, still
          // told, and still loses the tool for 1 then 3 rounds, repeatedly.
          const severanceCapped = repeatTrips >= 3 && sevThisTurn;
          const repeatPerma = repeatTrips >= 3 && !sevThisTurn;
          const withholdRounds = repeatTrips === 1 ? 1 : 3;
          if (repeatPerma) {
            permaWithheld.add(loopTool);
          } else {
            withheldTool = loopTool;
            withheldUntilStep = step + 1 + withholdRounds; // absent for exactly the next `withholdRounds` model round(s)
          }
          repeatCount = 0; lastToolSig = '';
          nearRepeatCount = 0; lastNearSig = '';
          const fleetOffered = ['send_chat_message', 'todo_get', 'todo_update', 'goal_list'].filter((n) => offeredNames.has(n));
          const fillerNote = noopFillerLoop
            ? ` Those ${loopTool} calls were shell no-ops — they execute nothing, and their success says NOTHING about your toolset.${fleetOffered.length ? ` This run's tool list DOES include the platform fleet/board tools (${fleetOffered.join(', ')}) — offered in every round of this run. If you intended a board or message action, call that tool by its exact name now.` : ' If you intended a tool you believe is missing, re-read your offered schema and call it by its exact name.'}`
            : '';
          const identicalPhrase = nearOnly
            ? `NEAR-IDENTICAL ${loopTool} calls 4 turns in a row (arguments differ only by numbers — the noop1, noop2, … numbering loop)`
            : `the IDENTICAL ${loopTool} call with the same arguments 3 turns in a row`;
          messages.push({ role: 'user', content: `[HARNESS NOTICE — not typed by the user] You have made ${identicalPhrase}${repeatTrips > 1 ? ` — for the ${repeatTrips === 2 ? 'second' : 'third'} time this run` : ''} — the result adds no new information.${fillerNote} To break the loop, ${loopTool} ${repeatPerma ? 'is now removed from your tool list for the REST OF THIS RUN' : withholdRounds === 1 ? 'has been temporarily removed from your tool list for the next round — it returns the round after' : `has been temporarily removed from your tool list for the next ${withholdRounds} rounds`}. Call a DIFFERENT tool that advances the task, mark the blocked step via update_plan, or write your final answer now.${repeatPerma ? ' Three identical-call loops on one tool is a decoder lock, not work; every other tool remains, and the result of that call is already in your context.' : ''}${severanceCapped ? ` NOTE: those calls were rejected at DISPATCH — the arguments never arrived complete, so NOTHING was executed and no result exists in your context. Re-sending the same bytes tends to be cut at the same place. Re-issue ${loopTool} with SHORTER argument values (e.g. a brief description, no long prose) so the payload fits.` : ''}` });
          emit('progress', { message: `${loopTool} ${nearOnly ? 'near-identical numbering loop 4×' : 'repeated identically 3×'}${noopFillerLoop ? ' (shell no-op filler)' : ''} — ${repeatPerma ? 'withheld for the rest of the run (third loop)' : `withheld for ${withholdRounds === 1 ? 'one round' : `${withholdRounds} rounds`} to break the loop`}${severanceCapped ? ' (severed at dispatch — not the run)' : ''}`, stage: 'repeat-break' });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
            meta: { seam: 'tool_repeat_break', tool: loopTool, trips: repeatTrips, rounds: repeatPerma ? 'run' : withholdRounds, ...(severanceCapped ? { severanceCapped: true } : {}), ...(noopFillerLoop ? { noopFiller: true } : {}), ...(nearOnly ? { near: true } : {}) },
          });
        }
      }
      // A storm turn dominated by one tool is a loop in a single turn — same
      // escalation ladder as the identical-call breaker (1 round → 3 → the run).
      if (batchStormTool && !permaWithheld.has(batchStormTool)) {
        const stormTool = batchStormTool;
        const repeatTrips = (repeatTripCounts.get(stormTool) ?? 0) + 1;
        repeatTripCounts.set(stormTool, repeatTrips);
        const repeatPerma = repeatTrips >= 3;
        const withholdRounds = repeatTrips === 1 ? 1 : 3;
        if (repeatPerma) permaWithheld.add(stormTool);
        else { withheldTool = stormTool; withheldUntilStep = step + 1 + withholdRounds; }
        messages.push({ role: 'user', content: `[HARNESS NOTICE — not typed by the user] Your last turn requested ${turn.toolCalls.length} tool calls, almost all ${stormTool}${repeatTrips > 1 ? ` — the ${repeatTrips === 2 ? 'second' : 'third'} storm this run` : ''}. ${stormTool} ${repeatPerma ? 'is now removed from your tool list for the REST OF THIS RUN' : withholdRounds === 1 ? 'is removed from your tool list for the next round — it returns the round after' : `is removed from your tool list for the next ${withholdRounds} rounds`}. Work from the results you already have; call a DIFFERENT tool that advances the task, or write your final answer.` });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { seam: 'tool_repeat_break', tool: stormTool, trips: repeatTrips, rounds: repeatPerma ? 'run' : withholdRounds, batch: turn.toolCalls.length },
        });
      }
    }

    // ── LOOP: GOAL-CONTINUE (top-level, AUTO mode) — an auto run should drive to
    // DONE, not stop at a premature "done" or the step budget while work remains.
    const hitBudget = step >= stepBudget;
    // WI-C: reaching here after a granted self-audit round means the round has
    // ended (final, budget, or a terminal break) — label its decision now.
    await flushSelfAuditLabel();
    // audit 2026-10-06 T7-5 (stanne.md #3): the independent reviewer's round
    // must never REPLACE the lead's answer to the user — the owner's "why?"
    // got an audit-criterion verdict as the persisted message. When the review
    // round changed nothing (no mutating call, no plan update) the pre-review
    // answer stands and the round's own final rides as ONE appended line; a
    // round that fixed something keeps its final (it describes the new state).
    // Kill switch INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED=1.
    if (reviewAnswerStash) {
      const st: { text: string; mutatingAt: number; planAt: number; fails: number } = reviewAnswerStash;
      reviewAnswerStash = null;
      const unchanged = mutatingWorkCalls === st.mutatingAt && planUpdateCalls === st.planAt;
      if (unchanged && !modelErrored && !input.isCancelled?.() && finalText.trim() && finalText !== st.text && !reviewKeepAnswerDisabled()) {
        finalText = keptAnswerWithReviewLine(st.text, finalText, st.fails);
        recordLoopMetric({ kind: 'independent_review_answer', sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, meta: { phase: 'answer_kept', fails: st.fails } });
      } else if (!unchanged) {
        recordLoopMetric({ kind: 'independent_review_answer', sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, meta: { phase: 'answer_revised', fails: st.fails } });
      }
    }
    if (
      topLevel && profile.workspaceTools && profile.planReminders
      // !done: a terminal break inside the for-loop (derail run-end) must not
      // be resurrected by goal-continue. Existing terminal breaks were already
      // guarded by isCancelled/modelErrored; this generalizes the contract.
      && !done
      // MERGE-INTENT-AWAIT: a run that registered a condition wake is waiting
      // on the harness — resuming it here would just poll again.
      && !toolEndTurnRequest
      && input.permissionMode === 'auto' && !input.isCancelled?.() && !modelErrored
      && autoContinueRounds < loopCfg.maxAutoContinueRounds
    ) {
      const planNow = await getPlan(input.sessionId).catch(() => null);
      const unfinished = planNow?.steps.filter(s => s.status === 'pending' || s.status === 'in_progress') ?? [];
      if (planNow && unfinished.length) {
        // Progress = the plan changed in ANY way (a step (re)opened, completed,
        // blocked, text edited) OR the worktree changed. The old "completed-count
        // up OR diff changed" test falsely judged read/investigate/reopen rounds
        // as no-progress and stopped a genuinely-working run. We now tolerate a
        // couple of true-stall rounds before giving up (continueStalls).
        const planSig = planNow.steps.map(s => `${s.id}:${s.status}:${s.text}`).join('|');
        const diffNow = await worktreeDiffHash();
        const progressed = planSig !== lastPlanSig || diffNow !== lastContinueDiffHash;
        lastPlanSig = planSig;
        lastContinueDiffHash = diffNow;
        if (progressed) continueStalls = 0; else continueStalls += 1;
        const resumeGranted = progressed || continueStalls < 2;
        // agent-decisions prerequisite 6 (2026-09-27): ONE goal_continue row per
        // evaluation — the `progressed` flag was never telemetered, so the
        // stall share behind the `continueStalls < 2` rule (and the
        // goal_continue_worth candidate, design §2.4) was unmeasurable.
        // Harness facts only.
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GOAL_CONTINUE,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { round: autoContinueRounds, max: loopCfg.maxAutoContinueRounds, progressed, stalls: continueStalls, evidenceToolCalls, unfinished: unfinished.length, resumed: resumeGranted, ...(checkpointNoticeThisRound ? { checkpointNotice: true } : {}) },
        });
        checkpointNoticeThisRound = false;
        if (resumeGranted) {
          autoContinueRounds += 1;
          emit('loop_update', { kind: 'goal-continue', round: autoContinueRounds, max: loopCfg.maxAutoContinueRounds, detail: `${unfinished.length} step(s) left` });
          emit('progress', { message: `Plan has ${unfinished.length} unfinished step(s) — auto-continuing (${autoContinueRounds}/${loopCfg.maxAutoContinueRounds})`, stage: 'loop' });
          const stallNote = progressed ? '' : `\n\nNOTE: the last round made no visible change. If you are stuck, either take a DIFFERENT approach or mark the blocking step(s) blocked via update_plan with a reason — do not repeat the same failing action.`;
          messages.push({ role: 'user', content: `[HARNESS AUTO-CONTINUE — not typed by the user] The run ended but the plan still has ${unfinished.length} unfinished step(s):\n${unfinished.map(s => `- [${s.status}] #${s.id} ${s.text}`).join('\n')}\nContinue working through them now (delegate parallelizable ones). A step that cannot be done must be marked blocked via update_plan with a note — never left pending. When every step is completed or blocked, finish with a final summary.${stallNote}` });
          stepBudget = step + loopCfg.resumeStepBudget;
          continue; // outer while re-enters the for-loop with the new budget
        }
        emit('progress', { message: 'Plan has unfinished steps but no progress for two rounds — stopping honestly', stage: 'loop' });
      } else if (planNow && planNow.steps.length && !selfAudited && !hitBudget) {
        // SELF-AUDIT (once per PLAN STATE): steps are all completed/blocked, but
        // models sometimes declare completion prematurely (owner-observed: "the
        // claim that step 6 was done was premature"). Before accepting a clean
        // auto finish, make the model re-check its OWN acceptance criteria
        // against reality once.
        //
        // Ticket 5ac56d81 — two compounding defects fixed here:
        // (a) FALSE PREMISE: `unfinished` above counts only pending/in_progress,
        //     so a plan with BLOCKED steps lands here and got "You marked every
        //     plan step complete" — a claim the lane never made — plus a blanket
        //     "reopen anything not done" demand the lane must reject (its steps
        //     are blocked on a genuine external wait). The prompt now states the
        //     TRUE plan state and blesses blocked-with-active-wait as a
        //     legitimate holding state while still auditing completed work and
        //     re-probing each blocker.
        // (b) NO CROSS-RUN DEDUPE: `selfAudited` resets every run, so a session
        //     on a recurring schedule re-audited an unchanged plan on every
        //     cadence tick (14 identical rejections overnight on canlegal-bench).
        //     The last-audited plan signature is persisted in the context store;
        //     an unchanged plan skips the repeat. Sig shape matches the
        //     goal-continue lane's planSig (id:status:text — notes excluded, so
        //     a note-only trajectory edit does NOT re-arm the audit).
        const blockedSteps = planNow.steps.filter(s => s.status === 'blocked');
        // Self-audit churn containment (tt-rd audit 2026-09-27, findings 1/2/6;
        // self-audit-receipt-rule.ts): the dedupe signature is TEXT-INSENSITIVE
        // (goal + criteria + id:status) so a lane that renames its steps every
        // firing ("Self-audit F186" → "F187") no longer re-arms the round —
        // ddd26be0 took 224 rounds on 244 runs because the id:status:text sig
        // never matched. Kill switch SELF_AUDIT_SIG_TEXT_INSENSITIVE_DISABLED=1.
        const auditSig = selfAuditPlanSig(planNow);
        let alreadyAudited = false;
        try { alreadyAudited = (await getLastSelfAuditPlanSig(input.sessionId)) === auditSig; }
        catch { alreadyAudited = false; } // fail OPEN to the audit firing (pre-fix behavior) — a store hiccup must never break the run
        // ONE harness round id per decision (granted OR skipped) — see selfAuditRoundId.
        selfAuditRoundId = crypto.randomUUID();
        const roundStamp: MetricStamp = { ...metricStamp, selfAuditRoundId };
        const recordSkip = (reason: 'plan_unchanged' | 'gate' | 'duplicate_step' | 'receipt_rule' | 'reviewer_ran', extra: Record<string, unknown> = {}): void => {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.SELF_AUDIT_SKIP,
            sessionId: input.sessionId, runId: input.runId, stamp: roundStamp,
            meta: { reason, steps: planNow.steps.length, blockedSteps: blockedSteps.length, ...extra },
          });
        };
        // DUPLICATE STEP (finding 1): the lane's OWN completed self-audit /
        // re-verify step + ≥ 1 ok evidence-bearing receipt this run ⇒ the audit
        // already happened; the harness round would be a second pass (the
        // tt-rd journals' "SA2"). Never on a blocked-plan board — the blocker
        // re-probe is the round's other job.
        const dup = (!alreadyAudited && !blockedSteps.length)
          ? laneAuditedThisRun(planNow, input.receipts ?? [])
          : { duplicate: false, stepId: null, evidenceReceipts: 0 };
        // RECEIPT RULE (finding 2): the backtest's deterministic ECT step 0 —
        // every completed step joins an ok receipt ∧ the last verify (if any)
        // passed on this tree ∧ no reject-back this run. Evaluated for
        // telemetry in SHADOW (default); in ACT it skips the round except on a
        // 1-in-10 CONTROL sample that runs it with control:true so the reopen
        // rate keeps being labelled (self_audit_control rows → auto-demote).
        // Consulted BEFORE Jev; Jev's shadow readout still rides the row.
        let receiptRule: ReceiptRuleVerdict | null = null;
        let receiptRuleMode: 'shadow' | 'act' = 'shadow';
        let receiptRuleSource = 'env';
        let control = false;
        // Fixer 2026-09-27 (finding 4): the verify-TREE comparison is a real git
        // capture (throwaway-index `add -A` + `write-tree`: up to 150 s, every
        // changed blob into the object store) and the FINGERPRINT capture also
        // consumes the chain's parked infra-red verdict. The tree is taken ONLY
        // in act, ONLY once every cheaper term already passes (the answer can
        // then skip a round), and through the side-effect-free
        // captureWorktreeTree; in act an unknown tree never skips
        // (verify_tree_unknown). Shadow records the cheap HEAD-sha match
        // (readHeadSha, ms) with treeCompared:false; captureMs rides the row so
        // the cost is visible.
        let receiptRuleCapture: { treeCompared: boolean; shaMatch: boolean | null; captureMs: number } = { treeCompared: false, shaMatch: null, captureMs: 0 };
        if (!alreadyAudited && !dup.duplicate) {
          try {
            const m = await selfAuditReceiptRuleMode();
            receiptRuleMode = m.mode; receiptRuleSource = m.source;
            let lastVerify: Awaited<ReturnType<typeof getVerifyState>> = null;
            try { lastVerify = typeof getVerifyState === 'function' ? await getVerifyState(input.sessionId) : null; }
            catch { lastVerify = null; }
            const ruleInput = { plan: planNow, receipts: input.receipts ?? [], lastVerify, guardRejectBacks };
            receiptRule = receiptRuleWouldSkip({ ...ruleInput, currentTree: null, requireTreeMatch: false });
            if (lastVerify?.tree) {
              const t0 = Date.now();
              try {
                if (receiptRule.skip && receiptRuleMode === 'act' && typeof captureWorktreeTree === 'function') {
                  const currentTree = await captureWorktreeTree(input.worktree);
                  receiptRule = receiptRuleWouldSkip({ ...ruleInput, currentTree, requireTreeMatch: true });
                  receiptRuleCapture = { treeCompared: receiptRule.treeCompared, shaMatch: null, captureMs: Date.now() - t0 };
                } else if (typeof readHeadSha === 'function') {
                  const head = await readHeadSha(input.worktree);
                  receiptRuleCapture = { treeCompared: false, shaMatch: lastVerify.sha && head ? lastVerify.sha === head : null, captureMs: Date.now() - t0 };
                }
              } catch { receiptRuleCapture = { treeCompared: false, shaMatch: null, captureMs: Date.now() - t0 }; }
            }
            control = receiptRule.skip && receiptRuleMode === 'act' && selfAuditControlSample(input.runId, input.sessionId);
          } catch { receiptRule = null; receiptRuleMode = 'shadow'; control = false; } // fail open: the rule never blocks the audit
        }
        // Fixer 2026-09-27 (finding 3): never skip a blocked-plan board — the
        // blocker re-probe is the round's other job. The verdict already carries
        // reason 'blocked_steps'; this term is the belt to that brace.
        const receiptRuleSkip = !!receiptRule?.skip && receiptRuleMode === 'act' && !control && !blockedSteps.length;
        // DECISION GATE — SELF-AUDIT (2026-09-24): the audit round fired on
        // 99.5% of runs. A typed noul over {plan, acceptance criteria, final
        // summary, this run's tool receipts} asks whether the final claims
        // work the receipts do not evidence. SHADOW records; ACT skips the
        // +20-step round on a confident "everything is evidenced" and pins the
        // plan signature exactly like a run audit would. Fail-open = audit.
        // 2026-09-27: the purpose is ACT-CAPPED in code (decision-gate-modes
        // PURPOSE_ACT_CAPS — AUROC 0.232); it still records in shadow.
        const gateDecision: SelfAuditGateDecision = (alreadyAudited || dup.duplicate || receiptRuleSkip) ? { skip: false, stash: null } : await selfAuditGateDecide({
          plan: planNow, finalText, receipts: input.receipts ?? [], sessionId: input.sessionId,
        }).catch((): SelfAuditGateDecision => ({ skip: false, stash: null }));
        const gateSkip = gateDecision.skip;
        const receiptRuleMeta = receiptRule ? { receiptRule: { wouldSkip: receiptRule.skip, mode: receiptRuleMode, source: receiptRuleSource, steps: receiptRule.steps, receipted: receiptRule.receipted, blockedSteps: receiptRule.blockedSteps, reasons: receiptRule.reasons, ...receiptRuleCapture } } : {};
        if (alreadyAudited) {
          // self_audit_skip row (finding 6): the P0 chart counts audits that RAN;
          // this row makes the dedupe's effectiveness readable from the DB.
          recordSkip('plan_unchanged');
          emit('progress', { message: 'Auto-audit skipped: plan unchanged since this session’s last self-audit', stage: 'loop' });
        } else if (dup.duplicate) {
          selfAudited = true;
          recordSkip('duplicate_step', { stepId: dup.stepId, receipts: dup.evidenceReceipts, ...receiptRuleMeta });
          emit('progress', { message: `Auto-audit skipped: the plan’s own self-audit step #${dup.stepId} already completed with ${dup.evidenceReceipts} evidence receipt(s) this run — the harness runs ONE audit per finish`, stage: 'loop' });
          try { await recordSelfAuditPlanSig(input.sessionId, auditSig); }
          catch { /* best-effort — the dedupe write must never break the run */ }
        } else if (receiptRuleSkip) {
          selfAudited = true;
          recordSkip('receipt_rule', { steps: receiptRule!.steps, receipts: receiptRule!.receipted, mode: receiptRuleMode, source: receiptRuleSource });
          emit('progress', { message: `Auto-audit skipped: every completed step (${receiptRule!.steps}) is receipt-evidenced this run and the last verify holds (receipt rule, act)`, stage: 'loop' });
          try { await recordSelfAuditPlanSig(input.sessionId, auditSig); }
          catch { /* best-effort — the dedupe write must never break the run */ }
        } else if (gateSkip) {
          selfAudited = true;
          recordSkip('gate', receiptRuleMeta);
          emit('progress', { message: 'Auto-audit skipped: the decision gate found every completion claim evidenced by this run’s tool receipts', stage: 'loop' });
          try { await recordSelfAuditPlanSig(input.sessionId, auditSig); }
          catch { /* best-effort — the dedupe write must never break the run */ }
        } else {
        selfAudited = true;
        autoContinueRounds += 1;
        // WI-C: label the shadow decision once this audit round has run.
        // E5: snapshot the loop's strike / reject-back ledgers at the grant so
        // the post-round label reads only what THIS round caused.
        // 2026-09-27: a receipt-rule CONTROL round labels itself too (no stash needed).
        // Fixer 2026-09-27 (finding 5): so does EVERY round the receipt rule
        // evaluated (the self_audit_shadow readout).
        if (gateDecision.stash || control || receiptRule) {
          pendingSelfAuditLabel = { stash: gateDecision.stash, completedBefore: completedStepIds(planNow.steps), rejectBacksBefore: guardRejectBacks, guardPartsBefore: countGuardParts(), roundId: selfAuditRoundId, control, receiptRule, receiptRuleMode };
          if (gateDecision.stash) selfAuditDecisionId = gateDecision.stash.id;
        }
        // Telemetry (remediation P0): count self-audit rounds so the "did the
        // pre-finish audit actually run?" rate is chartable per model/trigger.
        // meta.blockedSteps splits blocked-plan audits from all-complete ones.
        // E5 cost stamp: the row names the gate decision (selfAuditDecisionId)
        // and the run's spend/turns BEFORE the round, so `run_spend − before`
        // on the same decision id is the audit's exact shed cost. The harness
        // round id (selfAuditRoundId) joins EVERY round the same way.
        const spendBefore = usageAcc.snapshot();
        // audit 2026-10-08 W2-13: recorded AFTER the independent review below —
        // a round the cross-family reviewer replaces records a self_audit_skip
        // ('reviewer_ran') instead (no same-model audit ran).
        const recordSelfAuditRun = (): void => recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SELF_AUDIT_RUN,
          sessionId: input.sessionId, runId: input.runId,
          stamp: { ...roundStamp, ...(selfAuditDecisionId ? { selfAuditDecisionId } : {}) },
          meta: {
            blockedSteps: blockedSteps.length,
            costUsdBefore: Number((Number(spendBefore.totalCostUsd) || 0).toFixed(6)),
            turnsBefore: Number(spendBefore.turns) || 0,
            ...(control ? { control: true } : {}),
            ...receiptRuleMeta,
          },
        });
        let reviewerReplacesAudit = false;
        try { await recordSelfAuditPlanSig(input.sessionId, auditSig); }
        catch { /* best-effort — the dedupe write must never break the run */ }
        // ORIGINAL REQUEST ANCHOR + INDEPENDENT REVIEW (2026-10-01, TB 2.1
        // audit — independent-review.ts): every failed bench run finished with
        // all of its OWN criteria green; the audit below now quotes the
        // original request, and (no blocked steps, ≥ 1 work call, a TASK
        // request) one reviewer worker on the Reviewer seat — a different
        // model — checks the real artifacts against that request first. Its
        // report rides the audit message; the lead still decides.
        // Kill switch INDEPENDENT_REVIEW_DISABLED.
        let auditExtra = '';
        try {
          const req = originalRequest(input.userMessage, input.history as any);
          if (req) auditExtra += `\n${originalRequestAuditBlock(req, { openChoices })}`;
          let elig = shouldRunIndependentReview({
            request: req, topLevel, codingProfile: profile.kind === 'coding', autoMode: input.permissionMode === 'auto',
            canDelegate: typeof ctx.delegate === 'function', blockedSteps: blockedSteps.length, workToolCalls,
          });
          // A3 (2026-10-04 coding quick wins — review-diff-gate.ts): an eligible
          // run whose OWN diff is trivial (≤ 2 files, ≤ 40 changed lines, ≥ 1
          // file) and touches no risky path skips the 40-step reviewer. Assigned
          // work (owner dispatch / ticket brief), a continuation, an empty or
          // unmeasurable diff always keep it. The numbers ride this same row.
          // Kill switch INDEPENDENT_REVIEW_DIFF_GATE_DISABLED=1 (row unchanged).
          let diffGateMeta: Record<string, unknown> = {};
          if (elig.run && req && !independentReviewDiffGateDisabled() && typeof reviewDiffGate === 'function') {
            const dg = await reviewDiffGate({ worktree: input.worktree, startHead: runStartHead, source: req.source, rawMessage: input.userMessage, mutatingWork: mutatingWorkCalls });
            diffGateMeta = {
              diffGate: dg.gate,
              mutatingWork: mutatingWorkCalls,
              ...(dg.stat ? { diff: { files: dg.stat.files, lines: dg.stat.lines, binary: dg.stat.binary, risky: dg.stat.risky } } : {}),
            };
            if (dg.skip && dg.gate === 'no_diff_no_mutation') {
              // audit 2026-10-06 T7-5: nothing changed in the worktree and no call
              // could have changed anything elsewhere — nothing to review.
              elig = { run: false, reason: 'no_diff_no_mutation' };
              emit('progress', { message: 'Independent review skipped: no diff and no mutating work this run (reads / a merge only)', stage: 'loop' });
            } else if (dg.skip) {
              elig = { run: false, reason: 'trivial_diff' };
              emit('progress', { message: `Independent review skipped: trivial diff (${dg.stat?.files ?? 0} file(s), ${dg.stat?.lines ?? 0} changed line(s), no risky path)`, stage: 'loop' });
            }
          }
          const reviewMeta: Record<string, unknown> = { ran: false, reason: elig.reason, source: req?.source ?? null, dispatched: req?.dispatched ?? null, workToolCalls, openChoices: openChoices.length, ...diffGateMeta };
          if (elig.run && req && ctx.delegate) {
            emit('progress', { message: 'Independent review: a different model is checking the artifacts against the original request…', stage: 'loop' });
            const t0 = Date.now();
            const report = await ctx.delegate('reviewer', independentReviewBrief(req), 'Independent review', undefined, { harnessReview: true }).catch((e: any) => `[review failed: ${e?.message || e}]`);
            reviewMeta.ms = Date.now() - t0;
            if (isUsableReviewReport(report) && !/^\[review failed:/.test(report)) {
              // ticket d7e82531 + review finding B1: `report` here is the delegate
              // seam's CLIPPED carrier summary, not the reviewer's verdict. Clipping
              // that again lost the closing findings before they ever reached the
              // audit message. Read the durable FULL text instead; fall back to the
              // summary and state how much the carrier already dropped.
              const fullReview = harnessReviewReportPath
                ? await readWorkerReport(input.worktree, harnessReviewReportPath)
                : null;
              const reviewText = fullReview || report;
              const carrierOmitted = Math.max(0, harnessReviewFullChars - report.length);
              auditExtra += `\n${reviewFindingsBlock(reviewText, {
                reportPath: harnessReviewReportPath || undefined,
                omittedBefore: fullReview ? 0 : carrierOmitted,
              })}`;
              reviewMeta.ran = true;
              reviewMeta.reportChars = report.length;
              reviewMeta.fails = (report.match(/\bFAIL\b/g) || []).length;
              // audit 2026-10-06 T7-5: the lead's answer as it stood when the
              // review was granted — restored below when the round changes nothing.
              if (finalText.trim() && !reviewKeepAnswerDisabled()) {
                reviewAnswerStash = { text: finalText, mutatingAt: mutatingWorkCalls, planAt: planUpdateCalls, fails: Number(reviewMeta.fails) || 0 };
              }
              // audit 2026-10-08 W2-13: a usable CROSS-FAMILY review replaces the same-model self-audit pass.
              reviewerReplacesAudit = !selfAuditReviewerSkipDisabled() && !blockedSteps.length && !control
                && reviewerIsCrossFamily(harnessReviewModel, seatModelSpec || provider.model);
              reviewMeta.reviewModel = harnessReviewModel;
              if (reviewerReplacesAudit) reviewMeta.replacedSelfAudit = true;
            } else {
              reviewMeta.reason = 'no_report';
              reviewMeta.detail = String(report || '').slice(0, 160);
            }
          }
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.INDEPENDENT_REVIEW, sessionId: input.sessionId, runId: input.runId, stamp: roundStamp, meta: reviewMeta });
        } catch { /* fail open: the audit runs exactly as before */ }
        const ac = (planNow.acceptanceCriteria || []).map(c => `- ${c}`).join('\n');
        // Prompt v2 (finding 3): the old text ("Re-read/re-run the relevant files
        // or commands to confirm each acceptance criterion") had no exemption for
        // criteria this run's receipts already evidence, no one-cheap-check bound
        // and no terminal clause — lanes generalised it into whole firings whose
        // GOAL was an audit pass (fleet: 3,069 audit-goal runs / 14 d, 60 %
        // touched no file).
        const verifyClause = `This is the ONLY audit this firing gets — never plan, schedule or narrate a second pass (SA2/SA3). For EACH acceptance criterion: if a tool receipt from THIS run already evidences it (a merge sha, a probe print, a test pass, a message id) CITE that receipt by id — do not re-run it. Re-probe ONLY a criterion no receipt covers, with ONE cheap check. A criterion verified in an earlier firing whose inputs have not changed is TERMINAL — cite the earlier receipt / run id, never re-probe it.${ac ? ` Criteria:\n${ac}` : ''}`;
        if (reviewerReplacesAudit && harnessReviewModel) {
          recordSkip('reviewer_ran', { reviewModel: harnessReviewModel, leadModel: seatModelSpec || provider.model, ...receiptRuleMeta });
          emit('progress', { message: `Independent review by ${harnessReviewModel} done — the same-model self-audit pass is skipped; acting on the reviewer's findings`, stage: 'loop' });
          messages.push({ role: 'user', content: reviewerReplacesAuditMessage(harnessReviewModel, auditExtra) });
        } else if (blockedSteps.length) {
          recordSelfAuditRun();
          const completedCount = planNow.steps.filter(s => s.status === 'completed').length;
          emit('progress', { message: `Auto-audit: re-verifying completed work + ${blockedSteps.length} blocked-step blocker(s)…${control ? ' (receipt-rule control sample)' : ''}`, stage: 'loop' });
          messages.push({ role: 'user', content: `[HARNESS SELF-AUDIT — not typed by the user] Plan state at this finish: ${completedCount} of ${planNow.steps.length} step(s) completed, ${blockedSteps.length} blocked:\n${blockedSteps.map(s => `- [!] #${s.id} ${s.text}${s.note ? ` — blocker: ${s.note.slice(0, 160)}` : ''}`).join('\n')}\nBefore finishing, do BOTH:\n1. VERIFY the completed work genuinely satisfies the goal — don't take your own earlier "done" on faith. ${verifyClause}\n2. Re-confirm each BLOCKED step's blocker is still real — probe the external condition it waits on (one cheap check, not a full re-work).\nA blocked step whose blocker has genuinely CLEARED must be reopened via update_plan and finished now. A step whose external wait is still genuinely running is a LEGITIMATE holding state — leave it blocked and say so in one line; that is NOT a false completion and needs no defense. If a completed step fails re-verification, reopen it via update_plan (status pending/in_progress) and finish it. If everything genuinely checks out, give your final summary (deliverable first, audit line last).${auditExtra}` });
        } else {
          recordSelfAuditRun();
          emit('progress', { message: `Auto-audit: double-checking the work really meets the goal…${control ? ' (receipt-rule control sample)' : ''}`, stage: 'loop' });
          messages.push({ role: 'user', content: `[HARNESS SELF-AUDIT — not typed by the user] You marked every plan step complete. Before finishing, VERIFY the work actually satisfies the goal — don't take your own earlier "done" on faith. ${verifyClause}\nIf anything is NOT actually done, reopen that step via update_plan (status pending/in_progress) and finish it. If everything genuinely checks out, give your final summary (deliverable first, audit line last).${auditExtra}` });
        }
        stepBudget = step + loopCfg.resumeStepBudget;
        continue;
        }
      }
    }

    // ── LOOP: harness auto-verify gate (top-level, AUTO mode, on a clean finish). ──
    // Skip entirely if the run aborted on a model error — auto-verify passing would
    // masquerade a crashed run as a successful one (the bug this guards against).
    // A cancelled run must NOT run the (up to ~15-min) auto-verify chain and must
    // never print "✓ Auto-verify passed" — the user asked it to stop.
    if (done || !profile.workspaceTools || input.isCancelled?.() || modelErrored || !topLevel || input.permissionMode !== 'auto' || hitBudget || autoVerifyIters >= loopCfg.maxAutoVerifyIterations) {
      done = true; break;
    }
    // Re-read .digby/config.json AT the seam (review fix, A4 follow-up): the
    // run-start snapshot `digbyConfig` is stale when the lane created or fixed
    // the config THIS run — its own doctrine tells it to — and a stale read
    // would (a) skip the chain the lane just added and (b) stamp a "no verify
    // chain" marker AFTER a real green, so the status card printed the absent
    // line on a session that had just verified. The tool seam (tools.ts) reads
    // the file fresh per call; the two seams now agree. Fail-open: an unreadable
    // re-read falls back to the snapshot.
    // DW-2 (FO f118): the re-read uses the DETAILED reader and records the
    // read-error arm for the audit (observe-only, fail-open — an unreadable
    // config falls back to the snapshot exactly as before).
    let verifyConfig: DigbyConfig | null = digbyConfig;
    const r = await readDigbyConfigDetailed(input.worktree).catch(() => null);
    if (r && 'config' in r) verifyConfig = r.config;
    else if (r && 'readError' in r) {
      try {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.VERIFY_CONFIG_READ_ERROR,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { projectId: input.projectId ?? null, seam: 'auto', error: r.readError },
        });
      } catch { /* observe-only — never break the run */ }
    }
    const chain = resolveVerifyChain(verifyConfig);
    if (!chain.length) {
      // A4 (2026-09-27 spark-cluster audit): a chain-less project used to exit
      // here SILENTLY — no event, no metric — so every "verified" the lane wrote
      // was its own probe and nothing on the board said so (spark-cluster:
      // 0 verify_result in 669 runs, 12 verify tool receipts). Observe-only:
      // one typed event + one progress line + one loop_metrics row + the
      // session marker the status card reads. The run still finishes exactly
      // as before. Recorded unconditionally since 2026-11-02. Fail-open:
      // an observation failure (store, metric, a partial test mock) never
      // touches the run's outcome.
      try {
        const configPresent = !!verifyConfig;
        emit('verify_skipped', { reason: 'no_chain', auto: true, configPresent });
        emit('progress', { message: `Auto-verify skipped: no verify chain (${configPresent ? '.digby/config.json has no runnable typecheck/lint/test command' : 'no .digby/config.json'}) — every "verified" this run is the lane's own probe`, stage: 'verify' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.VERIFY_ABSENT,
          sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
          meta: { projectId: input.projectId ?? null, reason: 'no_chain', seam: 'auto', configPresent },
        });
        await recordVerifyAbsent(input.sessionId, { seam: 'auto', configPresent });
      } catch { /* observe-only — never break the run */ }
      done = true; break;
    }

    // ── A1 (2026-10-04 coding quick wins — verify-unchanged-skip.ts): SKIP the
    // chain when the worktree content is unchanged since this session's last
    // GREEN verify of this exact chain. The finish used to re-run the full
    // tsc / lint / test chain on every auto-mode finish even when the tree was
    // byte-identical to the content that had already passed (97 % of lane
    // runs are machine firings; many only read and report). Deterministic:
    // a real pass (not unverified / deferred / environmental) whose chainSig
    // matches this chain and whose content tree equals the tree now. HONEST:
    // nothing is recorded (the earlier green stays the record the PR gate
    // compares against), no verify_result / green check is emitted, and the
    // line names the earlier pass. Fail-open: any read / capture error runs
    // the chain. Kill switch AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1.
    if (!autoVerifyUnchangedSkipDisabled()) {
      let unchangedSkip = false;
      try {
        const lastVerify = typeof getVerifyState === 'function' ? await getVerifyState(input.sessionId) : null;
        if (lastVerify && greenCoversChain(lastVerify, verifyChainSignature(chain)) && typeof captureWorktreeTree === 'function') {
          const t0 = Date.now();
          const currentTree = await captureWorktreeTree(input.worktree);
          const captureMs = Date.now() - t0;
          if (currentTree && currentTree === lastVerify.tree) {
            const stageKeys = chain.map(c => c.key);
            emit('verify_skipped', { reason: 'unchanged_since_green', auto: true, lastGreenAt: lastVerify.at ?? null, lastGreenSha: lastVerify.sha ?? null, stages: stageKeys });
            emit('progress', { message: `Auto-verify skipped: worktree unchanged since the last green verify (${stageKeys.join(', ')})`, stage: 'verify' });
            parts.push(stampPart({ type: 'text', text: unchangedSinceGreenText(lastVerify, stageKeys) }));
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.VERIFY_UNCHANGED_SKIP,
              sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
              meta: { seam: 'auto', reason: 'unchanged_since_green', stages: stageKeys, lastGreenAt: lastVerify.at ?? null, lastGreenSha: lastVerify.sha ?? null, captureMs, autoVerifyIters },
            });
            unchangedSkip = true;
          }
        }
      } catch { /* fail-open: the chain runs exactly as before */ }
      if (unchangedSkip) { done = true; break; }
    }

    emit('verify_start', { stages: chain.map(c => c.key), auto: true });
    // Thundering-herd guard (ticket 6bf8ce36): N sessions hitting auto-verify at
    // once each spawn a cold tsc/lint/test chain and saturate the box — the
    // process-wide limiter serializes the expensive part (FIFO, env-tunable).
    // build 2026-10-09 VS: + the per-CONTAINER slot (verify-container-slots.ts); queued time leaves the run deadline.
    const vr = await runGatedVerifyChain(execShell, input.worktree, {
      seam: 'auto', sessionId: input.sessionId, runId: input.runId,
      progress: (message) => emit('progress', { message, stage: 'verify' }),
      onQueuedWait: (ms) => { if (Number.isFinite(ms) && ms > 0) deadlineOffsetMs += ms; },
    }, () => runVerifyChain(execShell, input.worktree, chain, loopCfg.perCommandTimeoutMs, { baseBranch: input.baseBranch || verifyConfig?.defaultBranch || 'main', sessionId: input.sessionId }));
    // v1#29: sha/tree-key the recorded outcome; v1#30: record hollow passes.
    await recordVerify(input.sessionId, vr.passed, vr.failedStage || undefined, {
      fingerprint: await captureVerifyFingerprint(input.worktree),
      unverified: vr.unverified,
      deferred: vr.stages.some(s => s.deferred),
      // A1 (2026-10-04): the record names the chain it covers (the unchanged-skip key).
      ...(autoVerifyUnchangedSkipDisabled() ? {} : { chainSig: verifyChainSignature(chain), stages: chain.map(c => c.key) }),
    });
    emit('verify_result', { passed: vr.passed, unverified: vr.unverified, deferred: vr.stages.some(s => s.deferred), failedStage: vr.failedStage, auto: true, stages: vr.stages.map(s => ({ key: s.key, passed: s.passed })) });
    if (vr.passed) {
      // v1#30 honesty: a chain that "passed" only because stage tools are
      // missing is UNVERIFIED — never print the green check for it (and it
      // satisfies no gate). It still ends the loop: a missing tool must not
      // drive fix iterations. Framework Operator run 3: a DEFERRED chain
      // (container memory pressure) gets the same honesty with its own label.
      const vrDeferred = vr.stages.some(s => s.deferred);
      parts.push(stampPart({
        type: 'text',
        text: vr.unverified
          ? vrDeferred
            ? `⏸ Auto-verify DEFERRED (container memory pressure — peer lanes' verify stages own the memory a cold chain would need). The chain did NOT run: neither a pass nor a failure. Do not edit code in response; re-run verify when peer load subsides (typically minutes).`
            : `⚠︎ Auto-verify is UNVERIFIED: stage(s) ${vr.stages.filter(s => s.skipped).map(s => s.key).join(', ')} skipped (tool not installed) — the chain did not fully run, so this is not a verified pass.`
          : `✓ Auto-verify passed (${vr.stages.map(s => s.key).join(', ')}).`,
      }));
      done = true; break;
    }

    // F2: a red harness auto-verify counts toward the frontier council (the failing stage's tail is the evidence).
    if (frontierCouncil) {
      const failing = vr.stages.find(s => !s.passed && !s.skipped) ?? vr.stages[vr.stages.length - 1];
      frontierCouncil.noteVerifyRed({ stage: vr.failedStage || failing?.key || '', tail: String(failing?.outputTail ?? '').slice(-1_200), step, auto: true });
    }

    // Safety guards — evaluate BEFORE spending another resume.
    const diffHash = await worktreeDiffHash();
    const sig = failureSignature(vr.failedStage || '', vr.stages[vr.stages.length - 1]?.outputTail || '');
    const sigCount = (failureSigCounts.get(sig) || 0) + 1;
    failureSigCounts.set(sig, sigCount);
    let stopReason = '';
    let sameSigStop = false;
    if (recentDiffHashes.length && recentDiffHashes[recentDiffHashes.length - 1] === diffHash) stopReason = 'no code changed since the last verify';
    else if (recentDiffHashes.includes(diffHash)) stopReason = 'the change oscillated back to an earlier state';
    else if (sigCount >= loopCfg.sameFailureStop) { stopReason = `the same "${vr.failedStage}" failure recurred`; sameSigStop = true; }
    recentDiffHashes.push(diffHash);
    if (recentDiffHashes.length > loopCfg.oscillationWindow) recentDiffHashes.shift();

    if (stopReason) {
      let note = `Auto-verify stopped: ${stopReason}. "${vr.failedStage}" still fails — reporting honestly rather than looping.`;
      // F2: the run is stopping on a verify chain that keeps failing — when the frontier council's trigger holds
      // (≥ 2 reds, or reds + other failures), the harness convenes it now (no step is left for the agent) and the
      // SHORT advice rides the final; it then supersedes the Double-Checker consult below. Fail-open.
      let councilAtStop = false;
      if (frontierCouncil) {
        try {
          const fcT0 = Date.now();
          const fc = await frontierCouncil.escalateAtRunEnd({ ...councilStepState({ step }), reason: 'the verify chain kept failing and the run is stopping' });
          deadlineOffsetMs += Date.now() - fcT0;
          if (fc) { note += `\n${fc.compact}`; councilAtStop = true; }
        } catch { /* advisory only */ }
      }
      // Verify-stop parity (2026-09-10): the same-signature stop is the verify
      // lane's derail breaker — consult + attribute exactly like the tool one.
      // The run is stopping (there is no next attempt), so any advice rides
      // the FINAL; the deduped ticket asks the fleet to attribute the
      // recurring signature to framework-vs-model. Bounded by the shared
      // per-run consult cap; fail-open — reflection never blocks the stop.
      if (sameSigStop) {
        try {
          const { consultCrossCheckerOnStreak, fileStreakInvestigation, REFLECTION_MAX_PER_RUN } = await import('./reflection');
          const failTails = vr.stages
            .filter(s => !s.passed && !s.skipped && s.outputTail)
            .map(s => `${s.key}: ${s.outputTail}`.slice(0, 1200));
          const evidence = {
            sessionId: input.sessionId, runId: input.runId, tool: 'verify',
            perma: false, intended: null,
            recentFailures: [`failureSignature ${sig} (stage ${vr.failedStage})`, ...failTails].slice(0, 3),
            goalHint: typeof input.userMessage === 'string' ? input.userMessage : null,
          };
          void fileStreakInvestigation(evidence);
          if (reflectionConsults < REFLECTION_MAX_PER_RUN && !councilAtStop) {
            const advice = await consultCrossCheckerOnStreak(evidence);
            if (advice) {
              reflectionConsults += 1;
              note += `\n[CROSS-CHECK REFLECTION — independent second-model diagnosis of the recurring verify failure] ${advice}`;
            }
          }
        } catch { /* reflection must never block the honest stop */ }
      }
      parts.push(stampPart({ type: 'text', text: `⚠︎ ${note}` }));
      finalText = `${finalText}\n\n${note}`.trim();
      done = true; break;
    }

    // Feed the failing stage back and grant a bounded resume budget.
    autoVerifyIters += 1;
    emit('loop_update', { kind: 'auto-verify', round: autoVerifyIters, max: loopCfg.maxAutoVerifyIterations, detail: `${vr.failedStage} failing` });
    emit('progress', { message: `Auto-verify: ${vr.failedStage} failed — continuing to fix (${autoVerifyIters}/${loopCfg.maxAutoVerifyIterations})`, stage: 'verify' });
    messages.push({ role: 'user', content: renderVerifyFeedback(vr, autoVerifyIters, loopCfg.maxAutoVerifyIterations) });
    // Anchor the resume to the CURRENT step — goal-continue rounds may have
    // pushed `step` past opts.maxSteps, and a formula anchored to maxSteps can
    // grant ZERO steps (announce "continuing to fix", then instantly end).
    // autoVerifyIters already bounds the number of resumes.
    stepBudget = step + loopCfg.resumeStepBudget;
    // outer while re-enters the for-loop from the current step up to the new budget.
  }

  // ── build 2026-10-08 F-1: typed finish_run, SHADOW (./finish-run.ts). A run that ended WITHOUT the call gets ONE
  //    isolated nudge turn — a COPY of the transcript + the nudge, the same tool list (prompt-cache friendly), the
  //    seat's effort capped, ≤ FINISH_RUN_NUDGE_TIMEOUT_MS, nothing streamed. Its output is never delivered and
  //    finalText is never touched; any tool other than finish_run in it is ignored (never executed). Still no call ⇒
  //    the record is an AUTO-FINISH from receipts. One finish_run row per eligible run. Fail-open: any error here
  //    leaves the run exactly as it was. Kill switch FINISH_RUN_DISABLED=1 (finishRun is null). ──
  let finishRunRecord: FinishRunRecord | null = null;
  if (finishRun) {
    try {
      let retiring = false;
      try { retiring = isRetiring(); } catch { retiring = false; }
      const skip = finishRunNudgeSkipReason({
        called: finishRun.called(), finalText, cancelled: input.isCancelled?.() === true, modelErrored,
        deadlineHit, terminalBreak: !!narrLoopEnded, retiring,
      });
      let nudge: FinishNudge = { outcome: skip === 'not_needed' ? 'not_needed' : `skipped:${skip}` };
      if (skip === null) {
        const t0 = Date.now();
        const nudgeDeadline = t0 + FINISH_RUN_NUDGE_TIMEOUT_MS;
        // The last list already carries finish_run (the common case — same prefix, cache hit); a capped seat that
        // never saw it gets finish_run ALONE (appending would push the list past the seat's cap).
        const tools = finishRunLastTools?.some((t) => t?.function?.name === FINISH_RUN_TOOL)
          ? finishRunLastTools
          : [FINISH_RUN_SCHEMA as any];
        const nudgeMessages = repairToolCallTranscript([...messages, { role: 'user', content: FINISH_RUN_NUDGE }]) as any[];
        const nudgeProvider = { ...provider, extra: capReasoningEffort(provider.extra, FINISH_RUN_NUDGE_EFFORT_CAP) };
        const promptChars = messagesChars(nudgeMessages as any);
        if (profile.kind === 'coding') emit('progress', { message: 'Recording the run\'s finish (finish_run, shadow) — your answer is final', stage: 'finish-run' });
        const nt = await runModelTurn(
          nudgeProvider, nudgeMessages, applyModelToolNames(tools),
          { onReasoning: () => {}, onContent: () => {} },
          FINISH_RUN_NUDGE_TIMEOUT_MS,
          () => input.isCancelled?.() === true || Date.now() > nudgeDeadline,
        ).catch(() => null);
        if (nt && nt.finishReason !== 'error' && nt.finishReason !== 'cancelled') {
          usageAcc.record(
            opts.usageRole ? `${agentLabel} (${opts.usageRole})` : agentLabel,
            provider.model,
            nt.usage
              ? { promptTokens: nt.usage.promptTokens, completionTokens: nt.usage.completionTokens, ...(typeof nt.usage.cachedTokens === 'number' ? { cachedTokens: nt.usage.cachedTokens } : {}), estimated: false }
              : estimateTurnUsage(promptChars, (nt.content?.length || 0) + (nt.reasoning?.length || 0) + (nt.toolCalls ?? []).reduce((s: number, tc: StreamedToolCall) => s + tc.arguments.length + tc.name.length, 0)),
            opts.usageRole ?? opts.role,
            spendModelKey(provider) !== provider.model ? spendModelKey(provider) : undefined,
          );
        }
        const call = (nt?.toolCalls ?? []).find((tc) => internalToolName(tc.name) === FINISH_RUN_TOOL);
        if (call) finishRun.onCall(call.arguments, receiptCollector.length, step, 'nudged');
        nudge = {
          outcome: call ? 'called'
            : !nt ? 'error'
            : nt.finishReason === 'cancelled' ? (input.isCancelled?.() === true ? 'cancelled' : 'timeout')
            : nt.finishReason === 'error' ? 'error'
            : (nt.toolCalls ?? []).length ? 'other_tool' : 'prose',
          ms: Date.now() - t0,
        };
      }
      finishRunRecord = await finishRun.finalize({
        receipts: receiptCollector,
        priorReceipts: input.evidenceGuardRejectBack?.priorReceipts ?? [],
        loadSessionReceipts: finishRunSessionReceipts,
        nudge,
        finalText,
        endStep: step,
      });
      recordLoopMetric({
        kind: FINISH_RUN_METRIC,
        sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
        value: finishRunRecord.valid ? 1 : 0, unit: 'valid',
        meta: finishRunMeta(finishRunRecord, { seat: seatModelSpec, profileKind: profile.kind, supervisor: !!profile.supervisorTools, machine: input.machineTriggered === true, ...(resume ? { resumed: true } : {}) }),
      });
    } catch { finishRunRecord = null; /* shadow telemetry never breaks the run */ }
  }

  // Background workers at run end (coding/background-delegation.ts): close the
  // pool BEFORE the spend snapshot below — a worker's later turns then land in
  // its own spend row, never after this run's was written. A stopped run
  // cancels its running workers; otherwise every report not yet seen is
  // posted to the session as its own message (now, or when it finishes).
  if (topLevel && bgPool) {
    void bgPool.closeRun({ cancelled: input.isCancelled?.() === true });
    // Ticket 458342f5: drop the durable spill of every report this run actually
    // DELIVERED into its own transcript. See finalizeSpillClearIds for why
    // 'posted_late' and 'unposted' MUST NOT be cleared here (review finding).
    const toClear = finalizeSpillClearIds(bgPool.all(), recoveredSpillIds);
    if (toClear.length && runChatId) void clearBackgroundReportSpills(runChatId, toClear);
  }
  // SAA-1.6 PHASE 3b — close the async-tool registry at run end. A handed-off
  // call that has not settled is NOT cancelled (the same discipline
  // tool-hard-timeout follows); whatever the run still owes is POSTED to the
  // chat (ticket 9ecabc73). The same closure is invoked from runCodingAgent's
  // `finally` via asyncHolder, so a run that THROWS reports too — `closeRun` is
  // idempotent, so the second call posts nothing twice.
  if (topLevel) closeAsyncToolsAtRunEnd();

  // Persist this run's spend into the durable whole-session totals (idempotent
  // per runId) and push the final numbers so the meter survives run end.
  //
  // Review 2026-09-13 issue 5: recordRunSpend is UNGATED from workspaceTools —
  // every top-level run (coding, chat, supervisor, council) now lands its
  // run_spend + run_tokens rows. The old `topLevel && profile.workspaceTools`
  // gate discarded all chat-profile spend at finalize (the supervisor's 191
  // wakes and every human chat run metered $0). commitRunUsage + the session
  // meter (`context` event) stay coding-only: they are workspace features.
  // metricStamp already carries profile.kind + the seat model (provider.model)
  // + triggerKind, so spend-cap / dashboards can split coding from chat spend
  // via meta.profile without a second ledger.
  if (topLevel) {
    let committed: SessionUsage | null = null;
    if (profile.workspaceTools) {
      committed = await commitRunUsage(input.sessionId, usageAcc.snapshot()).catch(() => sessionUsageView());
    }
    // Loop-metrics spend accounting (audit #8 rider — wave 1's #12 foundation):
    // one run_spend + per-model token rows per finalized run. Fire-and-forget,
    // never throws (loop-metrics.service buffers internally). Ordered AFTER the
    // coding commit so the durable session totals land first (pinned).
    // WI-D (2026-09-25): a SHARED turn ledger (chat-agent's per-turn
    // accumulator — lead + Double Checker + council + reconcile) is written
    // ONCE by its settle callback when the last participant releases it;
    // writing here too would double-count every lead retry.
    // E5 cost stamp: the run_spend row also names the self_audit decision whose
    // round this run granted (selfAuditDecisionId) — paired with the
    // self_audit_run row's costUsdBefore, the audit's shed cost is exact.
    // 2026-09-27: the harness round id (selfAuditRoundId) rides too — it exists
    // for EVERY audit decision (granted or skipped), the decision id only for
    // the 7.5 % of rounds where Jev returned a stash.
    // A4 (2026-10-04): a judged machine firing also stamps the effort its lead seat was given + why.
    if (!usageAcc.shared) recordRunSpend(usageAcc.runId, input.sessionId, usageAcc.snapshot(), { ...metricStamp, ...(selfAuditDecisionId ? { selfAuditDecisionId } : {}), ...(selfAuditRoundId ? { selfAuditRoundId } : {}), ...(machineEffortStamp ?? {}) });
    contextGauge?.finish({ compactions: compactionCount, chatClears, model: provider.model, receipts: receiptCollector, endState: input.isCancelled?.() ? 'cancelled' : modelErrored ? 'model_error' : 'ok' }); // build 2026-10-08 C: one run-summary row (+ 2026-10-11 T1: arm, outcomes, guardrails)
    if (committed) {
      emit('context', { chars: messagesChars(messages), budget: effectiveContextBudget(), ...ctxBudgetSourceField(), compactions: compactionCount, usage: usageAcc.snapshot(), sessionUsage: committed });
    }
  }

  // End-of-worker offload flush: the per-result items were stored LIVE above —
  // settle those writes, then store the worker's digest. No-op when nothing was
  // gathered and there is no digest.
  let offloadedCount = 0;
  if (doOffload) {
    const settled = await Promise.allSettled(offloadPending);
    let stored = settled.reduce((s, r) => s + (r.status === 'fulfilled' ? r.value : 0), 0);
    if (finalText.trim()) {
      stored += await storeFindings(input.sessionId, opts.role!, [{ ref: `${opts.role} digest`, content: finalText }]).catch(() => 0);
    }
    if (stored) emit('progress', { message: `Offloaded ${stored} findings to session memory (search_memory to retrieve)`, stage: 'offload' });
    offloadedCount = stored;
  }

  // WI-C: a terminal break (cancel / model error) can leave the loop before
  // the goal-continue section flushes — close the label here, once.
  await flushSelfAuditLabel();
  editDiagnostics?.dispose();
  void editCheckpoints?.dispose();

  // Per-run tool-family profile (owner 2026-09-19: "I don't see it ever use
  // read memory… web search… subagents"): ONE run_tool_profile row per
  // TOP-LEVEL run — coding lanes and the chat-tier supervisor wakes alike
  // (workers' calls ride the orchestrator's delegate parts, so they are not
  // counted twice). get_fleet_telemetry view 'collab' aggregates it per lane.
  // Telemetry only; never breaks the run.
  if (opts.allowSubagents) {
    try {
      // platformWrites (2026-10-04, coding option D label): the platform-mutating calls this run made.
      const tp = toolFamilyProfile(parts, { platformMutating: new Set<string>(PLATFORM_MUTATING_TOOLS as readonly string[]) });
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.RUN_TOOL_PROFILE,
        sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
        value: tp.calls,
        meta: { ...tp, steps: step, machine: input.machineTriggered === true, seat: seatModelSpec },
      });
    } catch { /* telemetry never breaks the run */ }
  }

  // audit 2026-10-08 W2-12: ONE run_read_cache row per loop that consulted the cache.
  {
    const rc = readCache?.summary();
    if (rc) {
      try {
        recordLoopMetric({ kind: 'run_read_cache', sessionId: input.sessionId, runId: input.runId, stamp: metricStamp, value: rc.hits, unit: 'hits', meta: { ...rc, topLevel, profile: profile.kind } });
      } catch { /* telemetry never breaks the run */ }
    }
  }

  // Progressive tool disclosure (2026-09-27): ONE tool_groups row per run that
  // ran with groups active — {cap, core, inView, loaded[], evicted[], autoLoads,
  // loads}. Telemetry only; never breaks the run.
  if (toolGroups) {
    try {
      const snap = toolGroups.snapshot();
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.TOOL_GROUPS,
        sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
        value: snap.loaded.length, unit: 'groups',
        meta: { ...snap, model: provider.model, steps: step },
      });
    } catch { /* telemetry never breaks the run */ }
  }

  // build 2026-10-08 A2 (tool diet): ONE tool_diet row per guest / eligible human chat run — the schema
  // bytes offered vs the full list, and the tools the run called outside the core-first view (wouldMiss:
  // auto-loaded when acting, a would-be miss in shadow). Telemetry only; never breaks the run.
  if (guestDiet || chatDiet) {
    try {
      const called = calledToolNames(parts);
      const wouldMiss = chatDiet ? wouldMissTools(called, chatDiet.fullNames, chatDiet.view) : [];
      const snap = toolGroups?.snapshot();
      recordLoopMetric({
        kind: TOOL_DIET_METRIC,
        sessionId: input.sessionId, runId: input.runId, stamp: metricStamp,
        value: wouldMiss.length, unit: 'tools',
        meta: guestDiet
          ? { segment: 'guest', acted: true, ...guestDiet, called: called.slice(0, 40), model: provider.model, steps: step }
          : {
            segment: 'human_chat', mode: chatDiet!.mode, acted: chatDiet!.acts, canary: chatDiet!.canary,
            fullTools: chatDiet!.fullNames.size, fullChars: chatDiet!.fullChars,
            offeredTools: chatDiet!.view.size, offeredChars: chatDiet!.offeredChars,
            called: called.slice(0, 40), wouldMiss: wouldMiss.slice(0, 40),
            ...(snap ? { autoLoads: snap.autoLoads, loads: snap.loads, loadedGroups: snap.loaded } : {}),
            // build 2026-10-08 A2b: the lane's starting view vs what the run called ('late' = the plan only arrived after run start).
            ...laneDietMeta(chatDiet!.lane ?? chatLaneDiet(readToolLaneHint(input.toolLaneHint), chatDiet!.laneTools, { ...chatDiet!.laneOpts, source: 'late' }), called, chatDiet!.fullNames),
            model: provider.model, steps: step,
          },
      });
    } catch { /* telemetry never breaks the run */ }
  }

  return {
    finalText,
    parts,
    receipts: receiptCollector,
    toolTexts,
    ...(offloadedCount ? { offloaded: offloadedCount } : {}),
    ...(guardRejectBacks ? { guardRejectBacks } : {}),
    // 177a31b7: the narrated-tool-emit wedge break — set only when that lane
    // ended the run; the executor turns it into the attention_needed alarm.
    ...(narrLoopEnded ? { narrLoopEnded } : {}),
    // H2 (2026-09-26): the run-deadline FINAL-TURN collapse fired — rides the
    // result only when set so a clean finish carries no trace of it.
    ...(deadlineHit ? { deadlineHit: true } : {}),
    // The real step count — the hand-back lint's tool-round signal (see the
    // AgentRunResult field comment). Always set; a clean run carries it too.
    stepsUsed: step,
    // Time-sliced machine runs (todo 89df978b, observe-only): the run's
    // ACTIVE clock — elapsed ms minus approval/steer queue waits
    // (deadlineOffsetMs). The act-path budget seam compares against exactly
    // this clock (agent.ts runDeadlineMs check), so the would-cut observation
    // must too, else it over-counts runs that merely waited on an owner card.
    activeMs: Date.now() - runStartedAt - deadlineOffsetMs,
    // audit 2026-10-08 W2-7: this loop's change calls (a delegating parent's progress signal).
    ...(loopChangeCalls ? { progressCalls: loopChangeCalls } : {}),
    // MERGE-INTENT-AWAIT (2026-10-20): the run ended on a registered condition wake.
    ...(toolEndTurnRequest ? { awaitingCondition: true } : {}),
    // cff523e7: the provider-gave-up signal only RIDES the result when set — a
    // clean finish carries no trace of it (schedule-failure counting keys off
    // its presence in the executor's finalize path).
    ...(modelErrored ? { modelErrored, modelErrorStatus, modelErrorKind } : {}),
    // helperSeatFallback is fastSeat-exclusive; codingSeatFallback (budget-
    // exhaustion failover, fe6f0b0b) and leadSeatFallback (unreachable-endpoint
    // re-seat) can co-fire in one run — precedence names the LATER latch in
    // the common order (lead re-seat early, budget failover after the burn);
    // both are telemetered + transcripted at fire time regardless.
    ...(helperSeatFallback || codingSeatFallback || leadSeatFallback ? { seatFallback: (helperSeatFallback ?? codingSeatFallback ?? leadSeatFallback)! } : {}),
    ...(toolsTrimmed ? { toolsTrimmed } : {}),
    ...(toolGroups ? { toolGroupsLoaded: toolGroups.loadedGroups() } : {}),
    ...(webCapState && input.webToolCaps ? { webToolCap: { ...webCapState, refusedTools: [...webCapState.refusedTools], mode: input.webToolCaps.mode } } : {}),
    // build 2026-10-08 F-1: the shadow finish_run record (the finalize seams write the agreement row from it).
    ...(finishRunRecord ? { finishRun: finishRunRecord } : {}),
  };
}

/**
 * Transient-lane backoff helpers (ticket cffaa701, 2026-09-14). The glm-5.3
 * throttle incident killed six canlegal-bench worker runs in ~1.5h: the fixed
 * 3×(10s/30s/60s) budget expired inside EVERY provider rate window, so the
 * retries hammered the still-limited window and the runs died mid-plan. The
 * lane is now rate-limit-aware: unattended runs (machine triggers, helper
 * fast seats) ride a longer table that reaches into minutes, built-in default
 * tables carry ±25% jitter so concurrent lanes stop retrying in lockstep on
 * the shared provider bucket, and a provider Retry-After header is honored as
 * a wait floor. Interactive (user-turn) runs keep the short table — a waiting
 * human is better served by the honest terminal note than by minutes of
 * silence. Pure + exported for the replay-pin suite.
 */

/** "ms,ms,…" env table → number[] (empty when unset/invalid). */
export function parseBackoffTableEnv(raw: string | undefined): number[] {
  return (raw || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/** Interactive (user-turn) default: short — a human is waiting. */
export const TRANSIENT_BACKOFF_USER_DEFAULT_MS = [10_000, 30_000, 60_000];
/** Unattended default: ~7.7 min total — rides out a per-minute rate window. */
export const TRANSIENT_BACKOFF_MACHINE_DEFAULT_MS = [10_000, 30_000, 60_000, 120_000, 240_000];
/** Ceiling on an honored Retry-After — a pathological value must never park a run for hours. */
export const TRANSIENT_RETRY_AFTER_CAP_DEFAULT_MS = 600_000;

/**
 * The wait before one transient backoff retry (attempt is 1-indexed; the last
 * table entry repeats past the end). ±25% jitter applies only to built-in
 * default tables — env-set tables stay exact (tests/ops determinism). The
 * provider's Retry-After (when sent) raises the wait to that floor, capped.
 */
export function computeTransientWaitMs(opts: {
  attempt: number;
  tableMs: number[];
  retryAfterMs?: number;
  retryAfterCapMs?: number;
  jitter?: boolean;
  rand?: () => number;
}): number {
  const idx = Math.min(Math.max(opts.attempt, 1), Math.max(opts.tableMs.length, 1)) - 1;
  const base = opts.tableMs[idx] ?? 0;
  const jittered = opts.jitter ? Math.round(base * (0.75 + (opts.rand ?? Math.random)() * 0.5)) : base;
  const floor = opts.retryAfterMs !== undefined
    ? Math.min(opts.retryAfterMs, opts.retryAfterCapMs ?? TRANSIENT_RETRY_AFTER_CAP_DEFAULT_MS)
    : 0;
  return Math.max(jittered, floor);
}

/**
 * One-Digby Phase 2: run a single WORKER directly (the chat runner's harness-
 * driven cross-check pre-step — deterministic, not model-reasoned).
 */
export async function runChatWorker(input: AgentRunInput, role: CodingRole): Promise<AgentRunResult> {
  // WI-D: a shared turn ledger (chat-agent) is held for this loop's whole
  // lifetime — the ledger settles (ONE run_spend for the turn) only after the
  // last participant releases, so a checker that outlives the lead still lands.
  // Captured BEFORE the loop: agentLoop assigns a fresh (unshared) accumulator
  // onto input.usage when none was given, and retain/release are no-ops on it.
  const ledger = input.usage;
  ledger?.retain();
  try {
    // Profile maxSteps (when given) OVERRIDES the role default — the L2 drafter
    // scoping (maxSteps 1) was silently ignored here for days: the role's 6
    // rounds ran instead, which is why checkers kept deadline-racing.
    return await agentLoop(input, { maxSteps: input.profile?.maxSteps ?? ROLES[role].maxSteps, allowSubagents: false, eventPrefix: 'subagent:', role, usageRole: input.usageRole });
  } finally {
    ledger?.release();
  }
}

export async function runCodingAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const profile = input.profile ?? CODING_PROFILE;
  // NOTE (2026-08-30, phantom-recurrence root cause): the coding-memory fold
  // no longer lives here — it fired BEFORE the evidence guard, so a struck
  // confabulation entered session memory as fact and later firings re-asserted
  // it. The fold now happens in run-executor's finalize with the POST-guard
  // text. (Chat runs never folded here — chat memory is updateContextAsync.)
  // WI-D: same shared-ledger hold as runChatWorker (the chat lead's loop and
  // each of its retries retain the turn ledger while they run).
  const ledger = input.usage;
  ledger?.retain();
  // Background delegation: a run that THROWS never reaches agentLoop's own
  // closeRun — close it here so its workers' reports are still posted
  // (closeRun is idempotent; a stopped run cancels them).
  const bgHolder: { pool?: BackgroundWorkerPool } = {};
  // Ticket 9ecabc73 (reviewer finding d): the async-tool registry's run-end close
  // is reachable from THIS finally, so a run that THROWS still posts the
  // background tool results it was holding — no post, no progress event and no
  // metric is exactly the silence the ticket reports. `closeRun` is idempotent
  // (the inline run-end path already called it on success/cancel), so the second
  // invocation posts nothing twice.
  const asyncHolder: { closeAtRunEnd?: () => void } = {};
  try {
    // Ticket d5974d65: heal THIS session's orphaned background-worker ledger
    // rows (a worker that outlived an earlier TERMINAL run and never delivered
    // — its process died or it hung — would otherwise sit 'working' forever;
    // a completed run leaves no resume checkpoint for lost_on_resume to see).
    // Fire-and-forget, session-scoped; the nightly reconcile sweeps globally.
    void sweepOrphanedBackgroundWorkerTasks({ parentChatId: input.sessionId });
    return await agentLoop(input, { maxSteps: profile.maxSteps, allowSubagents: true, bgHolder, asyncHolder });
  } finally {
    // Ticket 9ecabc73: order matters — close the async-tool registry FIRST so a
    // held background tool result is posted while the run is still finalizing,
    // then the worker pool (whose late posts are their own rows).
    try { asyncHolder.closeAtRunEnd?.(); } catch { /* a finishing run never throws on cleanup */ }
    if (bgHolder.pool) void bgHolder.pool.closeRun({ cancelled: input.isCancelled?.() === true });
    ledger?.release();
  }
}
