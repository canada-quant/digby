/**
 * Digby Code — coding tool definitions + executor.
 *
 * Tools run scoped to a session's git worktree. Safety model:
 *   - Every path is resolved and MUST stay inside the worktree (no ../ escape,
 *     no absolute paths outside it). read_file additionally re-checks the
 *     SYMLINK-RESOLVED target so a symlink inside the worktree can't be used to
 *     read backend secrets (e.g. a repo shipping `link -> /app/.env`).
 *   - run_command executes with cwd = worktree and a SCRUBBED env (no provider
 *     API keys / secrets), a wall-clock timeout, and an output cap.
 *   - Permission modes gate mutating tools (write/edit/run_command/git_commit):
 *       auto → execute always (bypass)
 *       plan → BLOCKED (agent is told to only plan; read tools still work)
 *       ask  → emit a permission_request and await the user's decision
 *
 * Read/search tools (read_file/view_image/list_dir/glob/grep/git_status/git_diff) always run.
 * Web + browser + GitHub tools are shared with the chat pipeline via ToolCache.
 */

import { parseAskUserOptions, type AskUserOpts } from './ask-user-options';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { logHandled } from '../../../utils/log-level';
import { redactUrlCredentials } from '../../../utils/redact-credentials';
import { git } from './workspace.service';
import { applyPlan, PlanUpdate, validatePlanUpdate, renderPlanValidationFailure } from './plan.service';
import { readDigbyConfig, readDigbyConfigDetailed, resolveVerifyChain, runVerifyChain, loopConfig, type DigbyConfig, type VerifyChainEntry, type VerifyResult } from './verify.service';
import { stageTimeoutAdvice, killedAtMsFromTail } from './loop-defaults';
import { prGateAutoVerifyDeadlineMs, withDeadline, classifyDocsOnly, listPrDiffFiles, docsOnlyPrBodyNote, prHeadMismatchBodyNote } from './pr-gate-docs-only';
// NOTE: imported from the PURE LEAF `exec-transport`, never from
// container.service — importing that module here would put
// container.service → prisma → config/database → config/env on tools.ts's
// module-load path, and parseEnv() process.exit(1)s without DATABASE_URL, so
// every env-less suite that touches tools would fail to LOAD (29 suites did,
// 2026-11-03). CI requires the suite to run with no .env.
import { isExecTransportFailure } from './exec-transport';
import type { EditDiagnosticsSink } from './edit-diagnostics';
import { loadRepoHooks, preCommandBlock, runPostEditHooks } from './repo-hooks';
import { editFileMissDiagnostic, editFileMultiDiagnostic, clipEditFileHint } from './edit-file-hint';
import { runGatedVerifyChain } from './verify-container-slots'; // build 2026-10-09 VS: per-process FIFO + per-container slot
import { startBackgroundProcess, readProcessOutput, stopProcess, listProcesses, waitForProcessOutput, releaseHandle, processSnapshot } from './process.service';
import { storePut } from '../memory/context-store';
import { searchMemory } from './coding-retrieval.service';
import { searchCodeSemantic, readCodeIndexState } from './code-index.service';
import { runCodeSemanticSearch, probeToolAvailable, codeSearchChatScopeRefuseDisabled, codeIndexWalkV2Disabled, type CodeSearchDeps } from './code-search';
import { isIntegrationTool } from './integration-tool-schema';
import { planSearchMemoryScopes, supervisorSearchCoverageNote, supervisorSearchMemoryEligible } from './supervisor-search-scopes'; // 2026-10-22: supervisor chats search their ledger + own distills
import { runWebPipe } from './web-pipe';
import { runYoutubePipe } from './youtube-pipe';
import { recordVerify, getVerifyState, captureVerifyFingerprint, recordVerifyAbsent } from './verify-state';
import { autoVerifyUnchangedSkipDisabled, verifyChainSignature } from './verify-unchanged-skip';
import {
  PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_ASK_ONLY_TOOLS,
  isPlatformTool, executePlatformTool,
} from '../platform/platform-tools';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { checkDependencyAdvisories, dependencyAdvisoryCheckDisabled, renderAdvisoryNotice, renderAdvisoryPrBody } from './dependency-advisories';
import { EditCheckpoints, renderCheckpointIndex, renderRewindResult } from './edit-checkpoints';
import { buildAstGrepCommand, parseAstGrepOutput, astGrepUnavailableReason, parseAppliedChanges, renderAstMatches, uniqueFiles, validateAstLang, AST_TIMEOUT_MS, AST_REWRITE_MAX_FILES } from './ast-tools';
import { VIEW_IMAGE_SCHEMA, runViewImage } from './view-image';
import { answerKeyCommandPre, answerKeyCommandPost, answerKeyCommandMessage, answerKeyArgsMatch, answerKeyBlockedMessage, answerKeyGuardEnabled, type AnswerKeyBlock } from './answer-key-guard';
import { scheduleArmOwnerAuthored } from './schedule-provenance';
import { checkCommandWorkspaceScope, runCommandWorkspaceGuardDisabled, workspaceGuardRefusalMessage } from './workspace-path-guard';
import { credentialNearMisses, credentialNearMissNotice, credentialNameGuardDisabled } from './credential-name-guard'; // ticket aa6b6da2: a misspelled credential name reads as EMPTY — disambiguate at the point of failure
import type { ToolReceipt } from './run-receipts';
import { artifactAttributionDisabled, attributeArtifact, servesStamp, workItemIdsInText } from './artifact-attribution';

const execFileAsync = promisify(execFile);

export type PermissionMode = 'auto' | 'plan' | 'ask';

/** Tools that mutate the worktree, run commands, publish, or mutate the platform — gated by permission mode. */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'ast_rewrite', 'rewind_to_step', 'run_command', 'git_commit', 'git_push', 'open_pull_request', 'merge_pull_request', 'start_background_process', 'stop_process', ...PLATFORM_MUTATING_TOOLS]);
/**
 * Tools that ALWAYS need an explicit human approval — even in auto mode (the
 * deterministic choke-point pattern, like the commit-time secret scan below:
 * 'auto' cannot bypass it). Platform unification (P1): destructive platform
 * ops. plan mode still blocks outright; ask/auto prompt via requestApproval.
 */
export const ASK_ONLY_TOOLS = new Set<string>(PLATFORM_ASK_ONLY_TOOLS);
/** Tools that execute project code — blocked in plan mode (read-only), allowed otherwise. */
export const EXECUTES_CODE = new Set(['verify']);

/**
 * audit 2026-10-06 T7-7 — the run_command workspace-scope guard at the tool
 * seam (workspace-path-guard.ts). Only where the shell can see the WHOLE
 * workspace volume (ctx.workspaceExposure ← container.service
 * workspaceExecExposure, wired by agent.ts); a refusal mints
 * one guard_strike row (seam run_command_workspace_scope) and returns the
 * "[command REFUSED" envelope. null = run the command. Never throws.
 */
const sameOwnerPathsCache = new Map<string, { at: number; paths: string[]; sessionIds: string[]; projectIds: string[] }>();
/** The same owner's session worktrees + project mirrors (60 s cache per user; empty on any error — the guard then stays strict). */
async function sameOwnerWorkspace(userId: string, worktreeOf: (sessionId: string) => string, legacyWorktreeOf: (sessionId: string) => string, mirrorOf: (projectId: string) => string): Promise<{ paths: string[]; sessionIds: string[]; projectIds: string[] }> {
  const empty = { paths: [], sessionIds: [], projectIds: [] };
  if (!userId) return empty;
  const hit = sameOwnerPathsCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  try {
    const prisma = (await import('../../../config/database')).default;
    const rows = await prisma.chatCodingState.findMany({ where: { userId }, select: { id: true, projectId: true } });
    // build 2026-10-08 ISO: each worktree / mirror where it IS (dual-read) AND
    // its legacy `<root>/worktrees/<id>` path (the pre-ISO answer; for a
    // migrated session a compatibility link to its own per-user dir).
    const paths = Array.from(new Set(rows.flatMap((r) => [worktreeOf(r.id), legacyWorktreeOf(r.id), r.projectId ? mirrorOf(r.projectId) : ''].filter(Boolean))));
    const entry = { at: Date.now(), paths, sessionIds: rows.map((r) => r.id), projectIds: rows.map((r) => r.projectId).filter((p): p is string => !!p) };
    sameOwnerPathsCache.set(userId, entry);
    return entry;
  } catch {
    return empty;
  }
}

async function workspaceScopeRefusal(ctx: ToolContext, command: string, tool: string): Promise<string | null> {
  try {
    if (runCommandWorkspaceGuardDisabled() || !command.trim()) return null;
    const exposure = ctx.workspaceExposure?.() ?? null;
    if (!exposure) return null;
    const { WORKSPACE_ROOT, repoMirrorPath, worktreePath } = await import('./workspace.service');
    const layout = await import('./workspace-layout');
    let mirror: string | null = ctx.projectId ? repoMirrorPath(ctx.projectId) : null;
    if (!mirror) {
      // A worktree's .git file names its mirror (gitdir: <mirror>/worktrees/<name>).
      const gitFile = await fs.readFile(path.join(ctx.worktree, '.git'), 'utf8').catch(() => '');
      const m = gitFile.match(/^gitdir:\s*(.+?)\/worktrees\/[^/\n]+\s*$/m);
      mirror = m ? m[1].trim() : null;
    }
    // The session's durable HOME (container.service sandboxHomeDir — the same resolver, no import of that module here).
    const home = layout.resolveSandboxHomeSync(ctx.sessionId, WORKSPACE_ROOT);
    // 2026-10-06 live follow-up: the guard is about OTHER TENANTS. Explicit paths into the same owner's other
    // sessions (worktree + project mirror) pass — a lane recovering a sibling lane's artifact is legitimate; the
    // container dirs (worktrees/, repos/) and globs over them still refuse (listing them enumerates every tenant).
    // Kill switch WORKSPACE_GUARD_SAME_OWNER_ALLOW_DISABLED=1.
    const owner = process.env.WORKSPACE_GUARD_SAME_OWNER_ALLOW_DISABLED === '1'
      ? { paths: [] as string[], sessionIds: [] as string[], projectIds: [] as string[] }
      : await sameOwnerWorkspace(ctx.userId, worktreePath, (id) => layout.legacyWorktreePath(id, WORKSPACE_ROOT), repoMirrorPath);
    // build 2026-10-08 ISO: the owner's own per-user subtree (when one exists) is theirs, whole;
    // the session's OWN legacy path is its own data (a dir, or a migration link to its subtree dir).
    const ownKey = ctx.userId ? layout.userSubtreeKey(ctx.userId) : null;
    const ownSubtree = ownKey && layout.isSubtreeKeySync(ownKey, WORKSPACE_ROOT) ? layout.subtreeRoot(ownKey, WORKSPACE_ROOT) : '';
    const ownLegacy = layout.legacyWorktreePath(ctx.sessionId, WORKSPACE_ROOT);
    const scope = { root: WORKSPACE_ROOT, worktree: ctx.worktree, allowed: [ctx.worktree, mirror ?? '', home, ...owner.paths, ownSubtree, ownLegacy].filter(Boolean), mirror };
    const verdict = checkCommandWorkspaceScope(command, scope);
    if (!verdict.refused) return null;
    // build 2026-10-08 ISO: a shell that sees only its user's subtree cannot
    // reach another tenant — the guard is the transitional BACKSTOP there and
    // runs OBSERVE-ONLY (records, the command executes). Every strike carries
    // the rollout's deciding metric: refs that are another tenant's
    // (crossTenant) and that this exposure could actually read (reachesData).
    const observeOnly = exposure === 'user_subtree';
    const tenancy = layout.classifyRefTenancy(verdict.refs, {
      exposure, ownKey, ownSessionIds: new Set([ctx.sessionId, ...owner.sessionIds]),
      ownProjectIds: new Set([...(ctx.projectId ? [ctx.projectId] : []), ...owner.projectIds]),
      visibleExtra: mirror ? [mirror] : [],
    }, WORKSPACE_ROOT);
    const state = observeOnly ? 'observed' : 'refused';
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
      meta: { seam: 'run_command_workspace_scope', state, outcome: state, tool, exposure, reason: verdict.reason, refs: verdict.refs, machine: !ctx.userTurnAt, command: command.slice(0, 160), crossTenant: tenancy.crossTenant, reachesData: tenancy.reachesData },
    });
    if (observeOnly) return null;
    logHandled(`coding tools: ${tool} refused for session ${ctx.sessionId} — references outside the session workspace (${verdict.reason}: ${verdict.refs.join(', ')})`);
    return workspaceGuardRefusalMessage(verdict, scope);
  } catch {
    return null;
  }
}

export interface ToolContext {
  worktree: string;
  sessionId: string;
  /**
   * The durable agent_runs row this execution belongs to (top-level coding
   * runs; undefined for chat-pipeline/test contexts). P4 v1#10: todo_update's
   * machine-close evidence records it as project_todos.doneRunId.
   */
  runId?: string | null;
  userId: string;
  permissionMode: PermissionMode;
  /** Publishing context (git_push / open_pull_request). */
  repoUrl?: string;
  provider?: string;          // 'github' | 'git' | 'blank'
  branch?: string;            // the session branch
  baseBranch?: string;        // PR base (project default branch)
  /** Project identity — lets a BLANK project's first push auto-create a private GitHub repo. */
  projectId?: string;
  projectName?: string;
  /** A plain chat in the hidden user space (platform/user-space.service userSpaceChatIsolated, 2026-10-20):
   *  search_memory reads no project-scope memory there (the space's learnings / decisions mix unrelated chats);
   *  the user's uploaded files (knowledge base) still federate in. */
  projectMemoryIsolated?: boolean;
  getGithubToken?: () => Promise<string | null>;
  /** Emit a structured event to the SSE stream. */
  emit: (event: string, data: any) => void;
  /** Ask the user to approve a gated tool; resolves to the decision. */
  requestApproval: (tool: string, args: any) => Promise<'allow' | 'always' | 'deny'>;
  /** Pause and ask the human a free-form question (ask_user tool); resolves to the
   *  typed answer, or null if no one answered within the window. */
  askUser?: (question: string, options?: string[], opts?: AskUserOpts) => Promise<string | null>;
  /** Shared per-request cache for web/browser/github tools (chat pipeline). */
  toolCache?: any;
  /** Per-run extra tools (L3 council) — matched before built-in dispatch. */
  extraTools?: Array<{ schema: any; execute: (args: any) => Promise<string> }>;
  /**
   * User-added MCP servers (ticket e294f9a4): the run's mcp_<server>_<tool>
   * executor (user-mcp.service loadUserMcpRunTools). Set on the orchestrator /
   * chat lead only; absent ⇒ an mcp_ call answers not_available.
   */
  userMcp?: {
    names: ReadonlySet<string>;
    /** false = the tool changes data (permission mode applies); undefined / true = read-only or unknown. */
    isReadOnly?(name: string): boolean | undefined;
    execute(name: string, args: unknown, ctx: { userTurnAt?: Date; machineTriggered?: boolean; sessionId?: string; runId?: string | null }): Promise<string>;
  };
  /**
   * Run a shell command for this session — inside the session's Docker
   * container when container mode is active, else in-process (bash in the
   * backend). Centralizes shell execution so run_command/glob/grep are
   * isolated identically. cwd defaults to the worktree.
   */
  execShell: (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;
  /**
   * audit 2026-10-06 T7-7: can this session's shell see the WHOLE workspace
   * volume (other users' worktrees)? 'dev_container' / 'whole_volume' arm the
   * run_command workspace-scope guard; null / absent = a scoped container (or
   * no container) — the guard stays out of the way. Wired by agent.ts from
   * container.service workspaceExecExposure. build 2026-10-08 ISO:
   * 'user_subtree' = the shell sees only its user's subtree — the guard runs
   * OBSERVE-ONLY there (records, never refuses).
   */
  workspaceExposure?: () => 'dev_container' | 'whole_volume' | 'user_subtree' | null;
  /**
   * The NAMES of the credential env vars injected into this session's shell
   * (ticket aa6b6da2): run_command's credential-name near-miss guard uses them
   * to flag a MISSPELLED name — which reads as empty and is indistinguishable
   * from a credential that was never injected. Names only; NEVER values.
   * Absent (chat-pipeline/test contexts) ⇒ the guard is inert.
   */
  credentialEnvNames?: readonly string[];
  /**
   * efdb3d31 (2026-10-30): the CURRENT turn's transport verdict plus the
   * re-emit guard's decision inputs, so a `dispatch_reject` row can state why
   * the guard did not save this turn instead of leaving it to inference.
   *
   * MEASURED WHY THIS IS NEEDED: the guard shipped on 200d9d0b and produced
   * ZERO rows in 24h while 44 finalize rows accumulated in 4h, and the stored
   * rows carried no field that could say which of its five conditions rejected
   * the turn. These three ride on the ctx the tool executor already holds, so
   * every rejection names its own guard state (`sc`/`fr`/`re` in the meta).
   *
   * `turnStreamCompleted` uses `null` for "unknown/synthesized" so it is
   * distinct from a measured `false` — the same three-valued discipline the
   * guard itself documents.
   */
  turnStreamCompleted?: boolean | null;
  turnFinishReason?: string | null;
/** TRUE iff THIS turn is the retry a re-emit bought (ticket 192d9087 F2).
   *  Renders as `re` (1/0). It is a PER-TURN fact: a turn that merely happens
   *  after a re-emit is `false`, because `re:1` on such a row used to read as
   *  "this row followed a re-emit" when it only meant "some re-emit happened
   *  earlier in this run". */
  turnIsReemitRetry?: boolean;
  /** TRUE once this RUN has spent its ONE re-emit — the gate's own bound, kept
   *  per-RUN on purpose (`beginTurn` never clears it). Renders as `rr` so the
   *  'already-recovered' diagnosis survives the per-turn split of `re`. */
  runReemitSpent?: boolean;
  /** efdb3d31 (2026-10-30) — WHICH arm of the severed-stream ladder decided this
   *  turn (`reemit` / `complete-payload` / `complete-sibling` / `already-recovered`
   *  / `no-transport-signal` / …). Two characters, like sc/fr/re, so jsonb keeps
   *  it inside the 240-char meta read cut.
   *
   *  WHY IT HAS TO EXIST: the guard once ran a full day producing zero rows and
   *  no stored field could say which condition rejected a turn, so the Fleet
   *  could not tell "unreachable code" from "precondition never holds" and
   *  guessed wrong once already. The mixed-turn arm makes that failure mode WORSE,
   *  not better: when it diverts a turn, the recoverable evidence DISAPPEARS — no
   *  `severed_stream_recovery` row is written (no re-emit happened) and the
   *  reject row would otherwise carry a bare `re:0`, which reads identically to
   *  "the gate never fired". `sv` is the field that tells those two apart. */
  severedVerdict?: string;
  /** The argLens the re-emitted attempt produced (comma-joined), so a reject
   *  row's `rl` answers "did the re-request reproduce the SAME cut?" without a
   *  cross-row join against the severed_stream_recovery row. Present ONLY on the
   *  retry turn (ticket 192d9087 F2: it is a one-turn carry, not sticky). */
  turnReemitLens?: string;
  /** EFDB3D31 CRITERION 1 — the per-fragment arithmetic for THIS turn, so a
   *  `dispatch_reject` row can state whether the rejected call's bytes ever
   *  arrived (received vs accumulated), how many deltas carried argument bytes,
   *  which slot each fragment routed into, and how many deltas had no usable
   *  `index`. Lengths/counts only, never payload bytes.
   *
   *  WHY IT RIDES THE CTX: this is the same "the tool executor already holds
   *  it" argument that put `sc`/`fr`/`re` here — the alternative was a table
   *  join across two loop-metrics rows written milliseconds apart, which no
   *  stored read can do, and the rejection row is the one a reader follows when
   *  asking why a call was refused. Absent when the turn never reached the
   *  finalize seam (cancelled, or an ambiguous accumulator where the arithmetic
   *  is meaningless rather than merely unknown). */
  turnStreamTrace?: {
    receivedBytes: number;
    accumulatedBytes: number;
    droppedBytes: number;
    fragments: number;
    undrainedBufferBytes: number;
    assemblyTrace: string;
    deltasWithoutIndex: number;
    /** Bytes carried on a shape the accumulator cannot read; >0 VOIDS the gateway verdict. */
    unreadArgBytes: number;
    /**
     * Lines the SSE frame reader skipped BEFORE any counter ran; >0 VOIDS the
     * gateway verdict (efdb3d31, 2026-10-30 firing 6). Carried here because a cut
     * turn is REJECTED and this row is where a reader decides who to blame —
     * a counter the blame seam cannot reach is equivalent to no counter.
     */
    skippedRawLines: number;
    skippedRawBytes: number;
    /** SSE events that arrived split across several `data:` lines (spec joins them with "\n"; this reader does not). */
    multilineDataEvents: number;
    /** `data:` frames that failed JSON.parse, and how many of those carried tool-call bytes (pc). */
    parseFailLines: number;
    parseFailToolCalls: number;
  };
  /** Delegate a scoped task to a specialized worker subagent; returns its report.
   *  opts.model overrides the worker's model (One-Digby cross-check delegation). */
  /** opts.harnessReview: the HARNESS's own pre-finish reviewer dispatch (independent-review.ts) — its brief quotes the
   *  original task verbatim, which names files to create, so the read-only file-artifact refusal must not apply. Never
   *  set by the model-facing delegate tool. */
  delegate?: (role: string, task: string, title: string, todoId?: number, opts?: { model?: string; harnessReview?: boolean }) => Promise<string>;
  /** Background delegation (coding/background-delegation.ts; orchestrator only): start the
   *  validated task(s) in the background → `{handled:true, text}` (handles, or a refusal) AT ONCE.
   *  `{handled:false, text}` = run them in the FOREGROUND as a plain call and append `text` as a note
   *  (DELEGATE_BACKGROUND_DISABLED, or a session with no chat to post a late report to). */
  delegateBackground?: (tasks: Array<{ role: string; task: string; title: string; todoId?: number; opts?: { model?: string } }>, via: 'delegate' | 'delegate_parallel') => Promise<{ handled: boolean; text: string }>;
  /** delegate_status: state of this run's background workers; waitSeconds > 0 awaits (bounded). */
  delegateStatus?: (handle: string | undefined, waitSeconds: number) => Promise<string>;
  /**
   * Tools the user chose "always allow" for this session (ask mode). */
  alwaysAllow: Set<string>;
  /**
   * Timestamp of the USER MESSAGE that triggered the CURRENT run — the anchor
   * for the consequential-platform-tool confirmation protocol (see
   * platform/pending-confirmations.ts): a pending confirmation created during
   * this run can only execute from a LATER real user turn (pending.createdAt <
   * userTurnAt). UNDEFINED for machine-triggered runs (schedule firings,
   * auto-resumes) — those fail closed and can never confirm.
   */
  userTurnAt?: Date;
  /**
   * ORIGIN-aware machine classification (secret-scrubbing review fix): TRUE
   * when the executor classified this run's trigger as schedule / hook /
   * machine (agent / webhook origin) — the same `triggerKind !== 'user'` the
   * guard lanes read. An agent-origin send from a user-anchored run threads
   * a userTurnAt onto the target run (run-state.ts: it must persist origin
   * 'agent'), so `!userTurnAt` alone under-counts machine runs. Read-side
   * redaction (get_chat_messages / get_run_receipts / search_chats /
   * list_chats) keys on `machineTriggered === true || !userTurnAt`. Absent on
   * user runs and on worker (subagent) contexts.
   */
  machineTriggered?: boolean;
  /**
   * audit 2026-10-06 T4-5 (schooltime.md F9): TRUE on an OWNER-DISPATCH run
   * (platform/agent-send-header isOwnerDispatchRun — a supervisor relayed the
   * owner's own-turn ask; the run is user-classified and carries the owner
   * turn's userTurnAt, but nobody typed THIS run's words). Schedule provenance
   * reads it: an arm from such a run is MODEL-authored ('machine'), never
   * 'user'. Absent on every other run.
   */
  ownerDispatch?: boolean;
  /**
   * Dig-deeper rung (cohesive chat, platform/work-tools.ts): TRUE when this
   * run is an ESCALATION of an earlier answer — a human turn that re-runs the
   * ORIGINAL ask with a new anchor. Requested-work tools card on such a turn
   * instead of executing a second time. Absent on every other run.
   */
  escalation?: boolean;
  /**
   * The user's OWN message text for this turn (bounded), threaded by the chat
   * run on human turns only — never a machine wake's composed prompt, never a
   * worker's delegated task. The requested-work gate binds the credential-
   * spending tools (import_repo / configure_workspace) to a repo URL that
   * appears in it; absent ⇒ those tools fall through to the card.
   */
  userTurnText?: string;
  /**
   * Set by executePlatformTool on the ctx COPY it hands the executor when a
   * requested-work tool runs card-free on a human turn (the direct path):
   * the schedule executors stamp MODEL provenance (promptSetBy / initiator
   * 'machine') instead of the owner stamps the confirmed re-call earns.
   * Never set by a caller.
   */
  workToolDirect?: boolean;
  /**
   * Owner-subscribed schedule firing (ticket 4565991a): TRUE when THIS run was
   * fired by an owner-subscribed schedule row (threaded fireScheduleTarget →
   * startDetachedChatRun → AgentRunInput → here). The schedule_message /
   * update_schedule gates read it for SUBSCRIPTION INHERITANCE: an arm or
   * update on the run's OWN chat from a subscribed firing keeps the successor
   * owner-subscribed (the dormant-gate one-shot ladder pattern — every rung is
   * promptSetBy 'machine' but serves the owner's original subscription).
   * Cross-chat arms NEVER inherit (a dispatch is not a delivery).
   */
  scheduleOwnerArmed?: boolean;
  /**
   * One-shot CHAIN provenance (finding B1, 2026-09-27): the id of the
   * coding_schedules row whose FIRING started this run (threaded
   * fireScheduleTarget → RunInput.scheduleId / ChatAgentRunArgs.firedByScheduleId
   * → here). schedule_self and an own-chat schedule_message stamp it as the
   * new `once` row's chainedFromScheduleId, so a lane that re-arms a one-shot
   * from every firing becomes a VISIBLE chain the recurring controls govern
   * (schedule-once-chain.ts). Undefined on user turns, hook wakes, agent sends.
   */
  firedByScheduleId?: string;
  /** When true, skip the PR verify-gate (a human clicked "Open PR" — explicit override). */
  prGateBypass?: boolean;
  /**
   * Citable receipt id for the IN-FLIGHT consequential call (run-receipts
   * follow-up): the agent.ts receipt seam sets this right BEFORE dispatching a
   * RECEIPT_TOOLS call and deletes it right after — a platform tool's success
   * envelope (toolResultEnvelope) embeds it so the model can cite the receipt
   * the harness wrote. Never set by hand.
   */
  receiptId?: string;
  /** build 2026-10-08 D-2: the in-flight side-effecting call's idempotency key (coding/tool-intents.ts) — set by the
   *  agent.ts dispatch seam around the call, read by the delegation ledger. Never set by hand. */
  intentKey?: string;
  /**
   * THIS run's in-process receipt collector (ticket 119df67e): the SAME shared
   * array agent.ts's receipt seam pushes every consequential execution into
   * (input.receipts — one collector per top-level run; workers inherit it via
   * the delegate input spread). Read-side evidence gates (observe_resource /
   * verify_durable's no_receipt check) consult it FIRST: chat-surface runs
   * (supervisor sweeps, hook wakes) persist receipts keyed by chatId with
   * runId null and create NO agent_runs row, so a DB read keyed on runId sees
   * nothing there even seconds after a real check — the in-process collector
   * is the only source that can see this-run receipts on those surfaces.
   * Absent on test/bare contexts — gates then fall back to the DB path.
   */
  receipts?: ToolReceipt[];
  /**
   * Tool names this agent is allowed to call. Set for WORKER subagents (their role's
   * ROLE_TOOLS) to enforce the role tool policy at EXECUTION time — not just by
   * filtering the advertised schema (an open-source model can hallucinate a tool name
   * outside its policy). Undefined = orchestrator = every tool allowed.
   */
  allowedTools?: Set<string>;
  /** Diagnostics-after-edit sink (edit-diagnostics.ts): edit_file / write_file
   *  note the path; the run's tracker schedules the background pass. */
  diagnostics?: EditDiagnosticsSink;
  /** Working-tree checkpoints (harness roadmap item 7): write_file / edit_file snapshot the prior
   *  content per step; rewind_to_step restores. Set by agent.ts on top-level coding runs only. */
  checkpoints?: EditCheckpoints;
  /**
   * Run-plane identity for the agent feedback loop (file_feedback context
   * capture): which surface this run is on ('coding' harness vs chat pipeline)
   * and, for WORKER subagents, the role. Both are populated by agentLoop from
   * the run profile + opts.role; absent only for hand-built contexts (tests).
   */
  agentSurface?: 'chat' | 'coding';
  agentRole?: string;
  /**
   * A HARNESS-SIDE wait inside a tool call that is not this run's work
   * (agent-decisions prerequisite 4, 2026-09-27: the self-merge WAIT-ONCE on a
   * CI-pending / merge-in-progress / 5xx gate failure). The tool reports the
   * milliseconds it slept; agent.ts adds them to deadlineOffsetMs exactly like
   * an awaitApproval / ask_user wait, so a bounded wait never forces a
   * tool-less FINAL TURN. Absent for hand-built contexts (tests / chat).
   * build 2026-10-09 VS: `queued: true` marks a QUEUE wait (the verify-slot waits, verify-container-slots.ts),
   * reported as it accrues — it also leaves this call's per-tool hard timer (agent.ts → tool-hard-timeout.ts).
   */
  onShieldedWait?: (ms: number, opts?: { queued?: boolean }) => void;
  /**
   * MERGE-INTENT-AWAIT (2026-10-20): a tool asks the agent loop to END this run
   * after the current tool round — one tools-off final turn carrying `notice`
   * (the `endTurnAfterToolRound` collapse), with goal-continue and the
   * unfinished-work continuation standing down (AgentRunResult.awaitingCondition).
   * await_condition calls it once it registered a condition wake: the harness,
   * not another model turn, wakes the chat when the condition is met. Set by
   * agent.ts on TOP-LEVEL runs only; absent ⇒ the tool's text still says stop.
   */
  requestEndTurn?: (notice: string) => void;
}

// ── Artifact attribution (todo 13dfa16d, monitor lesson 7) ─────────────────────
//
// Board artifacts are keyed by the work item they serve AT EVENT TIME, never
// by the lane's CURRENT title at read time (slowly-changing-dimension trap —
// the 2026-10-16 specimen: PR #1590, branch block-escalation-27c215d6, served
// todo 27c215d6, but after the lane's title todo switched at 14:14:53Z every
// digest labelled it with the new title todo 908f48a7). The three artifact
// tool results append "— serves todo <8-hex>" so the receipt (and any reader)
// sees the work item the EVENT itself carried. Fixed order (the Jira
// smart-commit / GitHub closing-keyword / Gerrit Change-Id convention):
//   (a) a work-item id in the branch name / PR body / commit message;
//   (b) else the todo the run's in-progress plan step names;
//   (c) else NOTHING appended ('unattributed' is printed by the render side,
//       never guessed here). ARTIFACT_ATTRIBUTION_DISABLED=1 drops the stamp.

/** The commit-message work-item trailer line the git_commit seam records (best-effort, ≤ 1). */
export async function readCommitMessageTrailer(worktree: string): Promise<string> {
  try {
    const { stdout } = await git(['log', '-1', '--pretty=%B'], worktree);
    return stdout.trim().slice(0, 400);
  } catch { return ''; }
}

/**
 * The event-time attribution stamp for an artifact tool result — pure decision
 * plus ONE bounded plan read (the run's in-progress step). Returns '' when the
 * kill switch holds or no leg matched (the render side prints 'unattributed').
 */
export async function artifactAttributionStamp(
  ctx: ToolContext,
  artifact: { branch?: string; body?: string; commitMessage?: string },
): Promise<string> {
  if (artifactAttributionDisabled()) return '';
  let plan: { steps?: Array<{ text?: unknown; note?: unknown; status?: unknown }> } | null = null;
  try {
    const { getPlan } = await import('./plan.service');
    plan = await getPlan(ctx.sessionId);
  } catch { plan = null; }
  const decision = attributeArtifact(artifact, plan);
  if (decision.workItem === 'unattributed') return '';
  return servesStamp(decision);
}

// ── Merge intents (MERGE-INTENT-AWAIT, 2026-10-20 — merge-intent.ts) ───────────

/**
 * Queue a TIMING-class merge failure as a harness merge intent and return the
 * "MERGE QUEUED" tool text — or null (switch off, not a timing class — a CI
 * dispatch gap included —, no head, the per-chat cap, a store / backstop
 * error): the caller then bounces exactly as before. Records the
 * merge_gate_failure row (meta.queued) so the repo CI p50 keeps its samples.
 * `updateBranch` = an update-branch THIS call asked for (from the failure, or
 * carried from the verdict before the WAIT-ONCE — review fix 2026-10-20: the
 * re-gated verdict no longer carries it, but the remote branch has the merge
 * commit): stored on the intent only when it was asked on the intent's own
 * head, named in the text either way. Never throws.
 */
async function queueMergeIntent(ctx: ToolContext, i: {
  owner: string; repo: string; pullNumber: number; mergeMethod?: unknown;
  failure: { gate: string; cause: string; headSha?: string; transient?: import('./self-merge.service').MergeWaitKind; branchUpdatedFrom?: string; dispatchGap?: boolean };
  updateBranch?: { from: string; at: Date } | null;
  waitTrail: string; waitMeta: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const mi = await import('./merge-intent');
    if (mi.mergeIntentQueueDisabled()) return null;
    const kind = mi.queueableWaitKind({ failure: i.failure });
    const headSha = String(i.failure.headSha ?? '');
    if (!kind || !headSha) return null;
    const upd = i.updateBranch ?? null;
    const updOnHead = upd && mi.sameSha(upd.from, headSha) ? upd : null;
    const svc = await import('./merge-intent.service');
    const reg = await svc.registerMergeIntent({
      owner: i.owner, repo: i.repo, pullNumber: i.pullNumber, headSha,
      chatId: ctx.sessionId, userId: ctx.userId, projectId: ctx.projectId ?? null, runId: ctx.runId ?? null,
      mergeMethod: typeof i.mergeMethod === 'string' ? i.mergeMethod : undefined,
      waitKind: kind, gate: i.failure.gate as import('./self-merge.service').MergeGate, cause: i.failure.cause,
      updateBranchFrom: updOnHead?.from ?? null, updateBranchAt: updOnHead?.at ?? null,
    });
    if (!reg.ok) return null;
    const slug = `${i.owner}/${i.repo}`;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
      meta: { gate: i.failure.gate, cause: String(i.failure.cause).slice(0, 160), repo: slug, pullNumber: i.pullNumber, headSha, queued: true, waitKind: kind, ...(upd ? { updateBranch: true } : {}), ...i.waitMeta },
    });
    return mi.renderMergeQueuedText({
      slug, pullNumber: i.pullNumber, headSha: reg.record.headSha, gate: i.failure.gate, cause: i.failure.cause,
      refreshed: reg.refreshed, heldByOtherChat: reg.heldByOtherChat, updateBranchFrom: upd?.from ?? null,
    }) + i.waitTrail;
  } catch {
    return null;
  }
}

/**
 * The tool merged / found merged the PR itself — drop THIS chat's queued
 * intent for it (best-effort). Another chat's intent stays: the cron reads the
 * PR merged and wakes that holder with the outcome (review fix 2026-10-20).
 */
async function clearQueuedMergeIntent(owner: string, repo: string, pullNumber: number, chatId: string, why: string): Promise<void> {
  try {
    const svc = await import('./merge-intent.service');
    await svc.clearMergeIntent(owner, repo, pullNumber, chatId, why);
  } catch { /* best-effort — an intent the cron later finds merged closes itself */ }
}

// The end of the seam block.
const OUTPUT_CAP = 60_000; // chars returned to the model per tool result
const CMD_TIMEOUT_MS = 300_000; // foreground command window (auto mode self-promotes to the background rail at this point — nothing is killed)

// ── Tool schemas (OpenAI function-calling format) ───────────────────────────────
// Base coding tools; the exported CODING_TOOL_SCHEMA = this + PLATFORM_TOOL_SCHEMA
// (see the bottom of the schema block).
// ── Session browser tool (ticket ea3ad8a8) ───────────────────────────────────
// Direct, single-action access to this session's hosted hardened browser
// context (persistent cookies/localStorage). The full agentic browser loop
// stays browser_task; this is the raw driver surface for run-tools, as the
// original design specified ("add session_browser case to run-tools").

/** The session_browser tool schema (exported for the availability test). */
export const SESSION_BROWSER_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'session_browser',
    description:
      "Drive Digby's HOSTED hardened browser for THIS session — a real Chromium with its own " +
      'persistent cookies/localStorage (sign in once in a task; later tasks resume signed in; ' +
      'isolated per session, never the user\u2019s everyday browser). One action per call.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'get_content', 'click', 'type', 'scroll', 'screenshot', 'close'],
          description: 'The browser action to execute.',
        },
        url: { type: 'string', description: 'navigate: absolute http(s) URL.' },
        selector: { type: 'string', description: 'click/type: CSS selector.' },
        text: { type: 'string', description: 'type: text to fill.' },
        submit: { type: 'boolean', description: 'type: press Enter after filling.' },
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'scroll direction.' },
        amount: { type: 'number', description: 'scroll: pixels.' },
      },
      required: ['action'],
    },
  },
};

/** True when the hosted hardened browser is enabled for this deployment. */
export function sessionBrowserToolEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.BROWSER_SERVICE_ENABLED || '');
}

const BASE_CODING_TOOL_SCHEMA = [
  // ea3ad8a8 — session_browser: drive Digby's HOSTED hardened browser for this
  // session (persistent cookies/cache — sign in once, resume signed in). Gated
  // per-role in coding/roles.ts (SESSION_BROWSER group); disabled entirely when
  // BROWSER_SERVICE_ENABLED is off (agent.ts drops the schema).
  SESSION_BROWSER_SCHEMA,
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file from the project. Returns its contents (optionally a line range).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
          start_line: { type: 'number', description: 'Optional 1-based start line.' },
          end_line: { type: 'number', description: 'Optional 1-based end line.' },
        },
        required: ['path'],
      },
    },
  },
  // view_image (2026-10-01): LOOK at an image through the Image reader seat —
  // a text-only lead otherwise rebuilds vision from pixels (view-image.ts).
  // VIEW_IMAGE_TOOL_DISABLED=1 drops it from the run's list in agent.ts.
  VIEW_IMAGE_SCHEMA,
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path (relative to project root; default root).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to project root (default ".").' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern (e.g. "src/**/*.ts"). Returns matching paths.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: 'Search file contents with a POSIX extended regex (ERE): (), +, ?, |, [...] work unescaped. No lookaround. OUTSIDE bracket classes, \\w \\W \\s \\S \\b \\B word/space classes are native, and \\d \\D \\A \\z \\Z plus (?: groups are auto-translated to ERE; inside […] write explicit ranges ([0-9], [a-z]) — class escapes like [\\w] are not ERE. A LEADING (?i)/(?im)/(?is)/(?s) flag prefix is accepted (i = case-insensitive); any other (?...) construct fails with a how-to-fix message. Returns matching lines with file:line. Same ignore view as glob/git: tracked + untracked files, .gitignore\'d paths (node_modules, .env, build output) EXCLUDED — use run_command with plain grep to search ignored paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional subdirectory or file to scope the search.' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts".' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ast_search',
      description: 'Structural (AST-aware) code search with ast-grep pattern syntax: the pattern is CODE with metavariables — $A matches one node, $$$ARGS matches many (e.g. "console.log($A)", "import $X from \'react\'", "await fetch($$$ARGS)"). Matches regardless of whitespace/formatting and ignores comments/strings that merely look alike. Returns file:line:col with the source line. Prefer it over grep when the target is a code SHAPE (every call of a function, a hook usage, an import form). Language is inferred per file when lang is omitted.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ast-grep pattern (code with $META variables).' },
          lang: { type: 'string', description: 'Optional language id (ts, tsx, js, py, rs, go, java, c, cpp, cs, rb, php, kt, swift, html, css, json, yaml, bash). Omit to infer per file.' },
          path: { type: 'string', description: 'Optional subdirectory or file to scope the search.' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "src/**/*.ts".' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ast_rewrite',
      description: 'Structural codemod: rewrite every match of an ast-grep pattern with a template across files in one call (e.g. pattern "console.log($A)" → rewrite "logger.info($A)"; pattern "foo($A, $B)" → rewrite "foo({ a: $A, b: $B })"). Runs a dry run first, checkpoints every touched file (rewind_to_step undoes it), applies, then reports each change. Use it instead of N edit_file calls for a mechanical multi-site change; verify afterwards — syntax is preserved, semantics are yours to check.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ast-grep pattern to match (code with $META variables).' },
          rewrite: { type: 'string', description: 'Replacement template; metavariables from the pattern are substituted. "" deletes the match.' },
          lang: { type: 'string', description: 'Language id (recommended for rewrites; omit to infer per file).' },
          path: { type: 'string', description: 'Optional subdirectory or file to scope the rewrite.' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "src/**/*.ts".' },
        },
        required: ['pattern', 'rewrite'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or OVERWRITE a file with the given content. Use edit_file for surgical changes to large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file with a new string (the old string must be unique). Preferred for targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to replace (must appear exactly once).' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rewind_to_step',
      description: 'Undo your own edits: restore every file you changed at step N or later (in THIS run) to its content from before that step — files you created are removed. Only write_file / edit_file changes are undone; commands, verify runs, git operations and post-edit hooks are not. Call WITHOUT step to list the checkpoints (step → files). Use it after a wrong turn instead of hand-reverting or reaching for git.',
      parameters: {
        type: 'object',
        properties: {
          step: { type: 'number', description: 'Rewind to before this loop step (from the checkpoint list). Omit to list checkpoints.' },
          reason: { type: 'string', description: 'One line: why (recorded in the run telemetry).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project root (build, tests, linters, package installs). Returns stdout+stderr (capped). Use for anything not covered by the file tools.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_status',
      description: 'Show the working-tree status of the session branch (porcelain).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_diff',
      description: 'Show the diff of uncommitted changes (optionally for one path).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional path to scope the diff.' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_log',
      description:
        'Show recent commit history (one line per commit: short-sha, date, subject). Read-only — works for read roles (explorer/reviewer) that have no shell. rev may be a branch/sha or a range ("HEAD", "main..HEAD", "HEAD~20..HEAD"); path scopes to commits touching that file. In a shallow session worktree a [note] marks locally-truncated history — older commits then live only on GitHub.',
      parameters: {
        type: 'object',
        properties: {
          rev: { type: 'string', description: 'Branch or range to log, e.g. "HEAD", "main..HEAD". Default HEAD.' },
          path: { type: 'string', description: 'Optional path to scope the history.' },
          max: { type: 'number', description: 'Max commits (default 30, cap 100).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_show',
      description:
        'Read a file blob from ANY git ref (branch, sha, tag) straight out of the local object store — "git show <ref>:<path>". Read-only — works for read roles (explorer/web_researcher/reviewer) that have no shell. Use it to read PR-branch content when the worktree has a different ref checked out (private-repo PR files exist in the object store even though read_file cannot see them).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Git ref to read from (branch, sha, tag). Default HEAD.' },
          path: { type: 'string', description: 'Repo-relative file path to read at that ref.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_commit',
      description: 'Stage all changes and commit them on the session branch with a message. A shrink guard refuses commits that empty a tracked file, cut >50% of a >20-line file, or still contain merge conflict markers — a DELIBERATE large deletion/rewrite must pass allowShrink:true with a shrinkReason.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          allowShrink: { type: 'boolean', description: 'Acknowledge a deliberate destructive shrink (emptied/gutted tracked files). Requires shrinkReason.' },
          shrinkReason: { type: 'string', description: 'Why the shrink is intentional (recorded in the commit receipt).' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_push',
      description: 'Push the committed work on the session branch to the GitHub remote (creates the remote branch). Commit first. Only for github projects with a connected account. Pushing the BASE branch (main/master/the PR base) is allowed but annotated: the result carries a base-push note and a guard_strike metric is recorded (it is refused only under the BASE_PUSH_GUARD_ENFORCE switch) — prefer publishing on the session branch and opening a PR unless the task is to publish base. Post-push CI observation is opt-in (the PUSH_CI_OBSERVE_ENABLED switch) — call check_ci to see the CI verdict.',
      parameters: {
        type: 'object',
        properties: {
          allowBase: { type: 'boolean', description: 'Explicitly confirm a BASE-branch push (suppresses the base-push note on user-present runs). Under the BASE_PUSH_GUARD_ENFORCE switch it is the only way a user-present run may push base; unattended (machine-triggered) runs cannot override the enforced refusal.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_pull_request',
      description: 'Open a GitHub pull request from the session branch into the base branch (pushes first if needed); give a title and a concise description. Verify gate: a docs-only diff (every file under docs/ or *.md) opens without the verify chain and the PR body says "docs-only, unverified"; otherwise, when the chain has not passed, this tool runs verify itself and opens on green — a red chain refuses with the failing stage\'s tail. BASE DRIFT: a branch built on a stale base is REFUSED when it would restore a file to a snapshot the base has moved past (silently reverting merged work) — rebase and re-open, or pass allowBaseDrift:true. The result ends with a "[PR DIFF]" line; a markdown-only PR is a RECORD, not a change — batch such appends. BATCH TRAIN: baseBranch:"<batch/<ts>>" boards (list_batch_trains).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown description of the change.' },
          headBranch: { type: 'string', description: 'Optional: open the PR from THIS existing remote branch instead of the worktree branch (verified on the remote first; the worktree push is skipped). REQUIRED when you wrote the commits through the GitHub REST API — without it the PR opens from the worktree branch as an EMPTY-DIFF no-op.' },
          baseBranch: { type: 'string', description: 'Optional: open the PR against THIS remote branch instead of the repo default (verified to exist on the remote first). Use it to board a batch train: pass the active batch/<ts> branch from list_batch_trains while a train is boarding.' },
          allowBaseDrift: { type: 'boolean', description: 'Override the BASE DRIFT pre-flight: by default a PR that restores a file to a snapshot the base has moved past — or DELETES a file the base tracks that this branch never deleted itself — is refused (it would silently revert merged work). The refusal names the files and the base; remedy: rebase and re-open. Pass true only when the reversion is intended.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_ci',
      description: "READ the remote CI verdict for a pushed commit: queries the GitHub Checks API (falling back to the legacy commit-status API) and returns the combined state (pending | success | failure | none) plus each check run's name and conclusion (max 20). Defaults to the last sha THIS session pushed (falling back to HEAD). Use it after pushing — pushed work is NOT done while CI is red or still pending. To WAIT for a pending verdict, call await_condition (condition \"ci\") once — never a check_ci / sleep loop.",
      parameters: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'Commit sha to check (7-40 hex chars). Default: the last sha this session pushed, else HEAD.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'merge_pull_request',
      description: 'Merge a pull request through the deterministic gate engine (self-merge). Gates on FRESH GitHub evidence: PR open+mergeable-clean, CI green on the head sha (repos with no CI pass as no_ci), session verify-chain noted (observe-only), secret-scan clean on the diff. A gate FAILURE returns {gate, cause, evidence, suggestedFix} — treat it as your next work item: fix the cause, then retry (a retry with nothing changed is called out). A TIMING failure (CI running, a merge in progress, a branch BEHIND its base — updated for you) answers "MERGE QUEUED": the harness merges that exact head at green and wakes this chat — never poll or retry. Success is only reported after a follow-up GET shows merged:true. Per-project policy applies (self-merge is ON unless a human set the project OFF).', // provenance: owner directive, 2026-09-09
      parameters: {
        type: 'object',
        properties: {
          pullNumber: { type: 'number', description: 'The PR number to merge.' },
          repo: { type: 'string', description: 'owner/name — defaults to this session’s project repo.' },
          mergeMethod: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Default squash.' },
        },
        required: ['pullNumber'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'await_condition',
      description: 'WAIT harness-side (no model steps) for an external condition instead of polling: "ci" — CI on a pushed sha finished (success / failure / none); "pr_merged" — a PR merged or closed; "deploy" — the deploy run for a sha (e.g. a merge sha) concluded. Blocks up to timeoutSec (≤ 600, default 600) and returns the verdict once met. NOT met in time ⇒ the harness registers a CONDITION WAKE and ENDS THIS RUN: it re-checks every 2 min and wakes this chat with [CONDITION MET — …] (a backstop wake follows at the horizon) — write a one-line status and stop. Use it instead of check_ci / sleep loops or a schedule_self per re-check; a merge answered MERGE QUEUED needs no await.',
      parameters: {
        type: 'object',
        properties: {
          condition: { type: 'string', enum: ['ci', 'pr_merged', 'deploy'], description: 'What to wait for.' },
          sha: { type: 'string', description: 'ci / deploy: the commit sha (7-40 hex).' },
          pullNumber: { type: 'number', description: 'pr_merged: the PR number.' },
          repo: { type: 'string', description: 'owner/name — defaults to this session’s project repo.' },
          timeoutSec: { type: 'number', description: 'How long this call may block before handing the wait to the harness (0-600, default 600).' },
        },
        required: ['condition'],
      },
    },
  },
  // ── GOAL: plan/todo tracking ──────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description: 'Record or revise your plan for the current task. Call ONCE at the start (before editing files) to set the goal, acceptance criteria, and 3-8 ordered steps; then call again whenever a step changes status. Rewrite the FULL steps array each time. Keep exactly ONE step in_progress. Never mark a step completed until it is actually done and verified. Do NOT add a self-audit / re-verify / SA2 step — the harness runs ONE audit at the finish (a plan that ends in its own audit step gets audited twice).',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'One sentence: the objective. Set on the first call; omit later to keep it.' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Definition of done — observable checks. Set on the first call.' },
          steps: {
            type: 'array',
            // Ticket 17a0b383: a lane sent {"in_progress": "<text>"} (status as the KEY) 3× — state the shape in one clause.
            // Static schema text: NOT covered by UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED (only the validator path is).
            description: '3-8 ordered steps (full rewrite each call), each {"text": "…", "status": "pending"} — the status is a value, never a key.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
                note: { type: 'string', description: 'Optional: blocker reason, file touched, or finding.' },
              },
              required: ['text'],
            },
          },
          explanation: { type: 'string', description: 'One line: what changed in this update and why.' },
        },
        required: ['steps'],
      },
    },
  },
  // ── LOOP: verify chain ─────────────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'verify',
      description: "Run the project's verify chain (cheapest-first: typecheck → lint → test, from .digby/config.json) and report per-stage pass/fail. Call this before opening a PR and after significant changes.",
      parameters: {
        type: 'object',
        properties: {
          only: { type: 'array', items: { type: 'string' }, description: "Optional subset of verify keys, e.g. ['typecheck','lint']." },
        },
      },
    },
  },
  // ── RETRIEVAL: session memory (findings offloaded by explorer/researcher) ──
  {
    type: 'function' as const,
    function: {
      name: 'search_memory',
      description: "Search Digby memory: this session's gathered findings (worker offloads, scraped pages, large reads, digests) AND the project's durable knowledge — its KNOWLEDGE BASE (source 'document': files, notes and URLs filed for this project and its parent folders), PROJECT DECISIONS (source 'decision': conclusions from earlier chats and runs), learnings.md entries (source 'learning': conventions, gotchas, fix patterns) and the code index (source 'code'). Use it to recover specifics a worker summarized, to check what the owner's documents or past decisions say before changing behavior, and to check the learnings when something fails. Returns the most relevant excerpts with source refs; reads are limited to projects you are authorized for.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for (natural language or keywords).' },
          scope: { type: 'string', enum: ['session', 'project', 'all'], description: "'session' = this session's findings; 'project' = durable project knowledge (knowledge-base documents, decisions, learnings.md entries, code index); 'all' (default) = both." },
          source: { type: 'string', description: "Optional source filter — 'document' (project knowledge base: uploaded files/notes/URLs), 'decision' (extracted project decisions), 'learning' (durable conventions), 'code', 'web_pipe', 'compaction'." },
        },
        required: ['query'],
      },
    },
  },
  // ── RETRIEVAL: semantic code search (project-wide embeddings index) ──
  {
    type: 'function' as const,
    function: {
      name: 'search_code_semantic',
      description: "Find code by MEANING across the whole project — 'where do we throttle provisioning retries?', 'auth token refresh logic'. Complements grep (exact symbols): use this when you don't know the identifier or file. Returns the most relevant code chunks with file paths. Index refreshes at run start; very recent edits may not appear yet." + (codeSearchChatScopeRefuseDisabled() ? "" : " A miss is NOT proof the code does not exist — read the file directly before saying so."),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the code DOES, in natural language (or a symbol you only half-remember).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_pipe',
      description: 'Deterministic web ingestion in ONE call: searches (or takes your URLs), scrapes the top pages in parallel, embeds full text into session memory, and returns a digest + suggested search_memory queries. Much faster than chaining search_engine + scrape yourself when you just need pages read and remembered. Detail stays retrievable via search_memory.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — the pipe picks the top organic results. Omit if you pass urls.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Specific URLs to ingest (max 4). Takes precedence over query.' },
          focus: { type: 'string', description: 'Optional: what the digest should focus on.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'youtube_pipe',
      description: 'Deterministic YouTube ingestion in ONE call: finds videos by query (or takes your YouTube URLs), pulls captions (fast) or transcribes the audio with the local open-source STT (slow fallback), embeds the transcripts into session memory, and returns a digest + suggested search_memory queries. Use when the answer may live in video content (talks, tutorials, interviews, lectures, reviews). Detail stays retrievable via search_memory.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — the pipe picks the top YouTube videos. Omit if you pass urls.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Specific YouTube video URLs to ingest (max 4). Takes precedence over query.' },
          focus: { type: 'string', description: 'Optional: what the digest should focus on.' },
          stt: { type: 'boolean', description: 'Set false to skip the slow audio-transcription fallback (captions only).' },
        },
      },
    },
  },
  // ── MONITOR: background processes ──────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'start_background_process',
      description: 'Start a long-running process (dev server, test watcher, build watcher) that would otherwise block. Returns a handle; read its output with read_process_output. Use for anything that does not exit on its own.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run in the background.' },
          name: { type: 'string', description: 'Short label for the process.' },
          ready: {
            type: 'object',
            description: 'Optional readiness check — wait until this is satisfied before returning.',
            properties: {
              port: { type: 'number', description: 'Wait until this TCP port (on 127.0.0.1) accepts a connection.' },
              httpPath: { type: 'string', description: 'With port: also require HTTP 200 at this path.' },
              logMatch: { type: 'string', description: 'Wait until this substring appears in the log (e.g. "Ready in").' },
              timeoutSec: { type: 'number', description: 'Max seconds to wait (default 30).' },
            },
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_process_output',
      description: 'Read NEW output from a background process since your last read (or from sinceOffset). Returns the chunk, the next offset, and the live status (running/exited).',
      parameters: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          sinceOffset: { type: 'number', description: 'Byte offset to read from (default: continue where you left off).' },
          filter: { type: 'string', description: 'Optional regex (grep -E) to keep only matching lines.' },
        },
        required: ['handle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wait_for_process_output',
      description: 'BLOCK until a background process\'s log matches a pattern or the process exits (whichever first) — ONE call instead of polling read_process_output. Use after starting builds/tests/servers. Returns matched/exited/timeout; re-call to keep waiting.',
      parameters: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          log_match: { type: 'string', description: 'Substring to wait for in the log (e.g. "Tests passed", "error", "Ready in"). Omit to wait only for process exit.' },
          timeout_sec: { type: 'number', description: 'Max seconds to wait (default 120, cap 240).' },
        },
        required: ['handle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_processes',
      description: 'List this session\'s background processes with their live status and output size.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stop_process',
      description: 'Stop a background process (kills its whole process group). Always stop dev servers/watchers when done.',
      parameters: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          signal: { type: 'string', enum: ['TERM', 'KILL'], description: 'Default TERM (then KILL).' },
        },
        required: ['handle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      // 2026-10-20 (real-user audit): clarify + creative direction joined the human-worthy-decision use — "make me a
      // logo" had generated a subject guessed from unrelated memory; the full rule is in the chat doctrine.
      description: 'Pause and ask the HUMAN, then wait for their reply or option pick (up to ~60 min). Use it to (1) CLARIFY a missing detail that materially changes the result with no sensible default (whose logo, which city, which job) — ONE question bundling everything; (2) get CREATIVE DIRECTION when taste decides the result — offer 2-4 directions as options; (3) confirm a genuinely human-worthy decision (irreversible/risky, spends money, account/security posture, deletes data). Never ask what research, memory or the conversation answers; never fill a missing subject from unrelated memory. In Auto mode NEVER ask to confirm routine goal-aligned actions. Returns the answer, or a no-reply note (then proceed on your best judgment, or schedule_self to resume).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The specific question. Give enough context that the user can answer without scrolling back.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional quick picks (2-6). Each is a short label, optionally followed by " — " and a one-line description (e.g. "Playful — cartoon pup, bright teal and orange"). The user can always type their own answer instead.' },
          multiSelect: { type: 'boolean', description: 'true when the user may pick several options (e.g. "which of these styles do you like?"). Default false.' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_self',
      // build 2026-10-08 A2-3 (tool diet): provenance moved here — tickets 1ead3b52 / ae20da66 / 2694a581 /
      // 903249e5 / b9cb221b, 0b1dbe75 (delta gate), the tt-rd self-audit churn audit 2026-09-27. Behaviour
      // details the arm RESPONSE already explains (chain advisory, cap math, drift marker) left the schema.
      description: 'Schedule THIS coding session to run again — the durable way to keep working across hours, days and deploys (a background process dies on redeploy). Each firing is a FRESH run of this session with `prompt` as its instruction and your full toolkit. A poll/wait loop is ONE recurring schedule (+ a deltaGate when a cheap probe can tell "nothing changed"), never a `once` re-armed from every firing (a chain of ≥3 in 24h is governed as a recurring cadence). Limits: interval ≥ 15 min; expires after 30 days or maxRuns; ≤ 5 active per session; a recurring cadence must fit the chat\'s daily firing cap (default 48/day, shared with one-shots and hook wakes) — over it is REFUSED, ≥ 75 % warns. Busy at fire time: a one-shot queues behind it as a pending message; a recurring firing re-arms ~3 min later with lastStatus \'skipped:busy\' — a firing is NEVER auto-disabled for a busy chat. An identical prompt returns the existing row; a machine recurring arm supersedes the older one at the same interval (the response names it — do not cancel it again). Firings re-arm from fire time: use 1440m for a fixed time of day. A firing that finds nothing new answers in ONE line and stops (no re-audit). Returns the schedule id (for cancel_schedule).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The instruction each run executes — standalone (every run starts fresh). Max 8000 chars: longer is REJECTED and nothing is created (reference a plan/file instead of pasting it).' },
          kind: { type: 'string', enum: ['once', 'recurring'], description: "'once' = run a single time after the delay; 'recurring' = every intervalMinutes." },
          intervalMinutes: { type: 'number', description: 'once: the delay. recurring: the cadence. Minimum 15. A machine recurring cadence shorter than this lane\'s median run length is stretched at arm time (the response names the armed cadence).' },
          maxRuns: { type: 'number', description: 'Optional cap on total firings (recurring only; default/most 500).' },
          deltaGate: {
            type: 'object',
            description: "RECURRING only: the platform polls these cheap https probes at each fire time and SKIPS the run when no probe value changed (lastStatus 'skipped:delta_unchanged' — burns no run, maxRuns or daily-cap budget). The first evaluation fires to set the baseline; a probe error fires. 1-4 probes; an invalid gate rejects the whole create.",
            properties: {
              probes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'https URL to poll (no credentials in the URL).' },
                    headers: { type: 'object', description: 'Optional headers (≤8; values may be secrets — stored, never echoed).' },
                    jsonPath: { type: 'string', description: "Path into a JSON body, e.g. 'runs[0].score' (or use pattern)." },
                    pattern: { type: 'string', description: 'Regex over a text body; the first capture group is read.' },
                  },
                  required: ['url'],
                },
              },
              heartbeatHours: { type: 'number', description: 'Force a real run at least this often (1-168 h, default 6).' },
            },
            required: ['probes'],
          },
        },
        required: ['prompt', 'kind', 'intervalMinutes'],
      },
    },
  },
  // NOTE: list_schedules / cancel_schedule / update_schedule are NOT here — those
  // names are owned by the platform tools (PLATFORM_TOOL_SCHEMA, appended below),
  // which widen them from this-session scope to the whole owning user (P1).
];

// ── Platform tools ("Digby can use Digby", P1): chat/project/schedule management ──
// Appended so the coding orchestrator gets them; the chat profile opts in via
// CHAT_ORCH_TOOLS in agent.ts. Dispatch: executeCodingTool routes them to
// executePlatformTool (platform.service.ts owns authz + audit).
export const CODING_TOOL_SCHEMA = [...BASE_CODING_TOOL_SCHEMA, ...PLATFORM_TOOL_SCHEMA];

/** Parse "owner/repo" from a GitHub https URL. */
function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = repoUrl.replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── Secret scan (commit-time choke point) ────────────────────────────────────
// Session fa767dbf shipped a whole repo and only audited for leaked tokens when
// the user asked "you made sure to make it all private correct?". Scan the
// STAGED diff's added lines on every git_commit and block on a hit. Exported
// for tests. Escape hatch: include [allow-secrets] in the commit message for
// deliberate fixtures (documented in the block message).
// The pattern set moved to the shared leaf platform/secret-scan.ts (remediation
// P1 item N9) — the inbound-text redaction (owner-question answers, supervisor
// directives) reuses the SAME set, so a new token shape lands in both scans.
import { SECRET_PATTERNS, redactChatReadSecrets } from '../platform/secret-scan';
// Instance isolation boundary (ticket c75b5f34) — import-free leaf: a non-prod
// instance (DIGBY_INSTANCE != prod) never publishes to the production repo.
import { repoTargetAllowed, isolationRefusal, resolveInstanceOwnRepoSlug } from '../platform/instance-targets';

/** Scan a unified diff's ADDED lines for secret-shaped strings. Returns hits as "<pattern> (<file>)". */
export function scanDiffForSecrets(diff: string): string[] {
  const hits: string[] = [];
  let currentFile = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) {
        const hit = `${p.name} (${currentFile || 'unknown file'})`;
        if (!hits.includes(hit)) hits.push(hit);
      }
    }
  }
  return hits;
}

// ── Shrink guard (commit-time choke point — I1, remediation 2026-09-09) ──────
// Real incident: a lane's merge "resolution" in an external project repo left
// three TRACKED files at 0 BYTES on main (incl. a 228KB owner-directives log)
// and called it "non-destructive"; nothing noticed for 22 hours. Every lane
// commit funnels through git_commit, so this is the deterministic choke point:
// scan the STAGED state and refuse any commit where a tracked file becomes
// empty, loses >50% of its lines (files >20 lines), or still carries merge
// conflict markers — unless the call explicitly declares the shrink
// (allowShrink:true + a non-empty shrinkReason, both recorded in the receipt).
// Refusals emit loop_metrics kind 'merge_size_guard'.

export interface ShrinkFinding {
  file: string;
  reason: 'empty_file' | 'line_loss' | 'conflict_markers';
  beforeBytes: number | null;
  afterBytes: number | null;
  beforeLines: number | null;
  afterLines: number | null;
}

/** Line-start conflict markers ("<<<<<<< ours" … ">>>>>>> theirs"). Both ends
 *  must be present — a lone ======= is ordinary markdown/ASCII art. */
const CONFLICT_OPEN_RE = new RegExp(`^${'<'.repeat(7)}( |$)`, 'm');
const CONFLICT_CLOSE_RE = new RegExp(`^${'>'.repeat(7)}( |$)`, 'm');

const SHRINK_SCAN_MAX_FILES = 400;           // safety valve on pathological commits
const SHRINK_SCAN_MAX_BLOB_BYTES = 4 * 1024 * 1024; // never slurp huge blobs

const countLines = (text: string): number => {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
};

/**
 * Scan the STAGED state (call after `git add -A`) for destructive shrinks.
 * Modified tracked files only — deletions (status D) are visible, deliberate
 * operations and renames don't change content. Best-effort per file: a read
 * failure skips that file (the guard must not turn repo oddities into blocked
 * commits), but a finding is a hard refusal upstream.
 */
export async function scanStagedShrink(worktree: string): Promise<ShrinkFinding[]> {
  const findings: ShrinkFinding[] = [];
  // Unborn HEAD (first commit) → everything is new; nothing tracked can shrink.
  try { await git(['rev-parse', '--verify', 'HEAD'], worktree); } catch { return findings; }

  const statusRaw = (await git(['diff', '--cached', '--name-status', '-z', '--no-renames'], worktree)).stdout;
  const statusParts = statusRaw.split('\u0000').filter(Boolean);
  const statuses = new Map<string, string>();
  for (let i = 0; i + 1 < statusParts.length; i += 2) statuses.set(statusParts[i + 1], statusParts[i]);

  const numstatRaw = (await git(['diff', '--cached', '--numstat', '-z', '--no-renames'], worktree)).stdout;
  const numstat = new Map<string, { added: number | null; deleted: number | null }>();
  for (const rec of numstatRaw.split('\u0000').filter(Boolean)) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    numstat.set(m[3], {
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2]),
    });
  }

  const blobSize = async (spec: string): Promise<number | null> => {
    try { return Number((await git(['cat-file', '-s', spec], worktree)).stdout.trim()); } catch { return null; }
  };
  const stagedText = async (file: string): Promise<string | null> => {
    try { return (await git(['show', `:0:${file}`], worktree)).stdout; } catch { return null; }
  };

  let scanned = 0;
  for (const [file, status] of statuses) {
    if (scanned >= SHRINK_SCAN_MAX_FILES) break;
    if (status !== 'M' && status !== 'A') continue;
    scanned++;
    const stat = numstat.get(file) ?? { added: null, deleted: null };
    const afterBytes = await blobSize(`:0:${file}`);
    const beforeBytes = status === 'M' ? await blobSize(`HEAD:${file}`) : 0;

    if (status === 'M') {
      // 1. Tracked file emptied.
      if (afterBytes === 0 && (beforeBytes ?? 0) > 0) {
        findings.push({ file, reason: 'empty_file', beforeBytes, afterBytes, beforeLines: stat.deleted, afterLines: 0 });
        continue;
      }
      // 2. >50% line loss on a >20-line file (numstat-derived — binary files
      //    report '-' and are covered by the empty check above only).
      if (stat.added !== null && stat.deleted !== null && stat.deleted > stat.added && stat.deleted >= 11
          && afterBytes !== null && afterBytes <= SHRINK_SCAN_MAX_BLOB_BYTES) {
        const text = await stagedText(file);
        if (text !== null) {
          const afterLines = countLines(text);
          const beforeLines = afterLines - stat.added + stat.deleted;
          if (beforeLines > 20 && (beforeLines - afterLines) / beforeLines > 0.5) {
            findings.push({ file, reason: 'line_loss', beforeBytes, afterBytes, beforeLines, afterLines });
            continue;
          }
        }
      }
    }
    // 3. Conflict markers still in the staged content (markers arrive as
    //    ADDED lines, so only files with additions need the read).
    if ((stat.added ?? 0) > 0 && afterBytes !== null && afterBytes > 0 && afterBytes <= SHRINK_SCAN_MAX_BLOB_BYTES) {
      const text = await stagedText(file);
      if (text !== null && !text.includes('\u0000') && CONFLICT_OPEN_RE.test(text) && CONFLICT_CLOSE_RE.test(text)) {
        findings.push({ file, reason: 'conflict_markers', beforeBytes, afterBytes, beforeLines: null, afterLines: countLines(text) });
      }
    }
  }
  return findings;
}

const describeShrinkFinding = (f: ShrinkFinding): string => {
  const bytes = `${f.beforeBytes ?? '?'}→${f.afterBytes ?? '?'} bytes`;
  const lines = f.beforeLines !== null || f.afterLines !== null ? `, ${f.beforeLines ?? '?'}→${f.afterLines ?? '?'} lines` : '';
  return `${f.file} [${f.reason}] ${bytes}${lines}`;
};

function authedPushUrl(repoUrl: string, token: string): string {
  const u = new URL(repoUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

/**
 * BLANK project + connected GitHub → create a PRIVATE repo on first push,
 * persist it on the project, and upgrade ctx in place. Session fa767dbf: the
 * agent had to ask the user to hand-create the repo and paste its URL because
 * push flatly refused non-github projects. Private by default — publishing is
 * an explicit later step.
 *
 * Ticket b1852d45 (new-project bootstrap order/ownership): two hardenings —
 *  1. A same-name collision is reused ONLY when the existing repo is EMPTY
 *     (an earlier retry of this same creation). The old code silently reused
 *     ANY same-named repo, so a session's whole push history could land in an
 *     unrelated pre-existing repo. Non-empty collision → fall through to a
 *     session-suffixed name (deterministic per session, retry-stable) instead
 *     of hijacking the stranger's repo.
 *  2. repo_created now carries owner + name so the stream (and any future UI
 *     consumer) can say exactly WHERE the repo landed — the incident report
 *     was a repo the user could not find anywhere.
 * Returns null on success (ctx mutated) or a user-facing error string.
 * Exported for tests.
 */
export async function ensureGithubRepoForBlank(ctx: ToolContext): Promise<string | null> {
  const token = ctx.getGithubToken ? await ctx.getGithubToken() : null;
  if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations to push.';
  const axios = (await import('axios')).default;
  const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const slug = (ctx.projectName || `digby-${ctx.sessionId.slice(0, 8)}`)
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 90)
    || `digby-${ctx.sessionId.slice(0, 8)}`;
  const candidates = [slug, `${slug}-${ctx.sessionId.slice(0, 8)}`.slice(0, 100)];

  /** A repo is reusable only when it has NO commits (an earlier creation retry
   *  of ours). GitHub answers the commits listing of a truly empty repo with
   *  409 "Git Repository is empty". */
  const isEmptyRepo = async (login: string, name: string): Promise<boolean> => {
    try {
      const commits = await axios.get(`https://api.github.com/repos/${login}/${name}/commits`, {
        headers: H, params: { per_page: 1 }, timeout: 15000,
      });
      return Array.isArray(commits.data) && commits.data.length === 0;
    } catch (err: any) {
      if (err.response?.status === 409) return true;
      throw err;
    }
  };

  let repo: any = null;
  let collisionNote = '';
  for (const name of candidates) {
    try {
      const resp = await axios.post('https://api.github.com/user/repos',
        { name, private: true, auto_init: false, description: 'Created by Digby Code' },
        { headers: H, timeout: 20000 });
      repo = resp.data;
      break;
    } catch (err: any) {
      const msg = err.response?.data?.errors?.[0]?.message || err.response?.data?.message || err.message || '';
      if (!/already exists/i.test(msg)) {
        return `Could not create the GitHub repo "${name}": ${msg}`;
      }
      // Collision: reuse only an EMPTY same-named repo; otherwise fall through
      // to the next (session-suffixed) candidate rather than pushing this
      // session's work into someone else's project (ticket b1852d45).
      try {
        const me = await axios.get('https://api.github.com/user', { headers: H, timeout: 15000 });
        const existing = (await axios.get(`https://api.github.com/repos/${me.data.login}/${name}`, { headers: H, timeout: 15000 })).data;
        if (await isEmptyRepo(me.data.login, name)) {
          repo = existing;
          break;
        }
        collisionNote = `a non-empty repo named "${name}" already exists under ${me.data.login}`;
      } catch (err2: any) {
        return `A repo named "${name}" already exists but could not be read: ${err2.response?.data?.message || err2.message}`;
      }
    }
  }
  if (!repo) {
    return `Could not create a GitHub repo for this project: ${collisionNote || 'name candidates exhausted'}. Rename the conflicting repo on GitHub or pick a different project name, then push again.`;
  }
  ctx.emit('repo_created', { url: repo.html_url, private: true, owner: repo.owner?.login, name: repo.name });
  const cloneUrl: string = repo.clone_url || `${repo.html_url}.git`;
  // Persist so future sessions, pushes, and PRs treat this as a real GitHub project.
  if (ctx.projectId) {
    try {
      const { persistProjectRepo } = await import('./coding-data.service');
      await persistProjectRepo(ctx.projectId, cloneUrl);
    } catch { /* best-effort — push still works this run via the mutated ctx */ }
  }
  ctx.repoUrl = cloneUrl;
  ctx.provider = 'github';
  // Push the base branch first (best-effort) so PRs have a base on the remote.
  if (ctx.baseBranch) {
    try {
      await execFileAsync('git', ['push', authedPushUrl(cloneUrl, token), `refs/heads/${ctx.baseBranch}:refs/heads/${ctx.baseBranch}`], {
        cwd: ctx.worktree, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: ctx.worktree, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch { /* base may not exist locally in mirror worktrees — PR falls back to first-parent */ }
  }
  return null;
}

/** The branch actually checked out in the worktree. Agents sometimes create and
 *  switch to their own feature branch mid-run (e.g. digby/nightly-*): pushing
 *  blindly to ctx.branch then published the SESSION branch name pointing at the
 *  feature work, and PRs opened from the wrong head (prod session b92ef13f).
 *  Returns null when detached or unreadable — callers fall back to ctx.branch. */
export async function currentHeadBranch(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree);
    const name = stdout.trim();
    return name && name !== 'HEAD' ? name : null;
  } catch { return null; }
}

/** Pragmatic git-branch-name validation (git check-ref-format's everyday rules). */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  return !(/[\s~^:?*[\]\\]/.test(name) || name.includes('..') || name.includes('@{')
    || name.startsWith('/') || name.endsWith('/') || name.includes('//')
    || name.endsWith('.') || name.endsWith('.lock') || name.startsWith('-'));
}

/**
 * Verify a branch exists on the GitHub remote before opening an explicit-head
 * PR (ticket c7bf1e66). The agent asserted the branch was published out-of-band
 * (e.g. created via the GitHub API); opening unverified would 422 — or worse,
 * silently target the wrong ref. Returns { sha } (the branch tip — reused for
 * the post-PR CI observation, since the worktree checkout is unrelated on this
 * path), or a loud human-readable error.
 */
export async function verifyRemoteBranchExists(
  token: string, owner: string, repo: string, branch: string,
): Promise<{ sha: string } | string> {
  try {
    const axios = (await import('axios')).default;
    const resp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, timeout: 10_000 },
    );
    return { sha: String(resp.data?.object?.sha ?? '') };
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return `PR head "${branch}" is not on the remote ${owner}/${repo} (GitHub 404) — push the branch first (git_push) or omit headBranch to open the PR from the session branch. Nothing was opened.`;
    }
    const detail = err?.response?.data?.message || err?.message || 'unknown error';
    return `Could not verify remote branch "${branch}" on ${owner}/${repo}: ${detail}. Nothing was opened.`;
  }
}

/**
 * POST /pulls — then VERIFY the created PR's head is the branch we asked for
 * (ticket c7bf1e66: the tool reported "Opened PR #629" while that PR's head.ref
 * was an ancient unrelated branch, digby/gdn-window-a, and the lane had no
 * signal). A mismatch FAILS LOUDLY — never reports success — records a
 * guard-strike telemetry row, and names the PR so the lane can close it.
 */
export async function createPullRequestWithHeadCheck(opts: {
  token: string; owner: string; repo: string;
  title: string; body: string; base: string; head: string;
  sessionId?: string; runId?: string;
}): Promise<{ ok: true; number: number; url: string } | { ok: false; message: string }> {
  try {
    const axios = (await import('axios')).default;
    const resp = await axios.post(
      `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls`,
      { title: opts.title, head: opts.head, base: opts.base, body: opts.body },
      { headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/vnd.github+json' }, timeout: 20_000 },
    );
    const gotHead = String(resp.data?.head?.ref ?? '');
    const number = Number(resp.data?.number);
    const url = String(resp.data?.html_url ?? '');
    if (gotHead !== opts.head) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: opts.sessionId, runId: opts.runId,
        meta: { seam: 'pr_head_mismatch', state: 'observed', expected: opts.head, actual: gotHead, prNumber: number },
      });
      return {
        ok: false,
        message: `PR #${number} opened with the WRONG head branch: requested "${opts.head}" but GitHub reports head.ref "${gotHead}" (${url}) — the ticket-c7bf1e66 failure class. Refusing to report success: close that PR unmerged (REST PATCH state=closed) and re-open with an explicit headBranch, or investigate why the head diverged.`,
      };
    }
    return { ok: true, number, url };
  } catch (err: any) {
    const gh = err.response?.data?.errors?.[0]?.message || err.response?.data?.message || err.message;
    return { ok: false, message: `Opening the PR failed: ${gh}` };
  }
}

// ── PR diff shape + notices (tt-rd audit 2026-09-27, findings docs-churn-log-1/-2/-4) ──
/** GitHub's compare endpoint caps `files[]` at 300 and offers no pagination. */
const COMPARE_FILES_CAP = 300;
/**
 * How many candidate files the base-drift probe reads per PR. Each probe is a
 * local `git merge-tree` + `git log` over one path; the PR's biggest deletions
 * go first. NOTE: a PR deleting from MORE files than this probes only the top
 * `BASE_DRIFT_PROBE_CAP` and the remainder are NOT reported as `incomplete`
 * (detectBaseDrift never sees them — review finding 6 on ticket 7445695d). The
 * cap is a deliberate, bounded blind spot, not a surfaced one.
 */
const BASE_DRIFT_PROBE_CAP = 12;

/** Adapter: the leaf's probe, wired to the worktree's git. The probe itself
 *  lives in coding/pr-base-drift.ts (ONE implementation — a second copy here
 *  once drifted from it, silently losing the `--no-abbrev` flag and making the
 *  whole guard unable to fire). */
/** Does `ref` resolve to a commit in this worktree? */
async function resolveLocalRef(worktree: string, ref: string): Promise<boolean> {
  try {
    const { stdout } = await git(['rev-parse', '-q', '--verify', `${ref}^{commit}`], worktree, 10_000);
    return /^[0-9a-f]{40}$/.test(String(stdout ?? '').trim());
  } catch { return false; }
}

async function probeDriftFor(worktree: string, target: { base: string; head: string }, path: string) {
  const pbd = await import('./pr-base-drift');
  // A mirror worktree usually holds the base only as a remote-tracking ref.
  const baseRef = (await resolveLocalRef(worktree, `refs/remotes/origin/${target.base}`)) ? `origin/${target.base}` : target.base;
  return pbd.probeBaseBlobs((args, timeoutMs) => git(args, worktree, timeoutMs), baseRef, target.head, path);
}

// ONE GitHub compare call before open_pull_request creates the PR. Everything
// here is observe-only and fails OPEN (null ⇒ the PR opens exactly as before);
// the only refusal is the docs-only churn notice under DOCS_ONLY_PR_ENFORCE=1
// on a MACHINE run (default off — the 2026-09-11 gate flip). Exported for tests
// (deps inject the three GitHub reads; production uses axios).
export async function describePrDiff(
  ctx: Pick<ToolContext, 'sessionId' | 'runId' | 'userTurnAt' | 'worktree'>,
  target: { token: string; owner: string; repo: string; base: string; head: string },
  deps: {
    compareFiles?: (t: typeof target) => Promise<any[] | null>;
    prState?: (prNumber: number) => Promise<{ state: string; headRef: string | null } | null>;
    preBytes?: (path: string) => Promise<number | null>;
    priorReceipts?: () => Promise<Array<{ tool: string; ok: boolean; ids: Record<string, unknown>; createdAt: Date }>>;
    /** Merged-tree blob probe for ONE path vs the base's own history (base-drift guard). */
    driftProbe?: (path: string, t: typeof target) => Promise<{ mergedBlob: string | null; baseBlob: string | null; historyBlobs: string[]; deletedByBranch?: boolean | null } | null>;
    now?: Date;
  } = {},
  opts: {
    /** The tool arg allowBaseDrift:true — an explicit, audited acknowledgement of the reversion. */
    allowBaseDrift?: boolean;
  } = {},
): Promise<{ tail: string; refusal: string | null; filesOnlyMd: boolean; baseDrift?: boolean } | null> {
  try {
    const pds = await import('./pr-diff-shape');
    const rl = await import('./results-log-guard');
    const gh = async (url: string) => {
      const axios = (await import('axios')).default;
      return axios.get(url, { headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/vnd.github+json' }, timeout: 15_000 });
    };
    const files = deps.compareFiles
      ? await deps.compareFiles(target)
      : (await gh(`https://api.github.com/repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(target.base)}...${encodeURIComponent(target.head)}?per_page=100`)).data?.files ?? null;
    if (!Array.isArray(files)) return null;
    const shape = pds.prDiffShape(files);
    const now = deps.now ?? new Date();
    const notices: string[] = [];
    let refusal: string | null = null;
    // (a0) BASE DRIFT (ticket 9d4ef436, family pr-diff-base-drift): a branch cut
    // from a stale base can make a green-looking PR whose MERGE silently reverts
    // another lane's landed work (prod: two Schooltime PRs closed unmerged
    // inside 4h). The question the refusal makes is exactly "does merging this
    // revert base's work", so the probe computes the MERGE (`merge-tree
    // --write-tree base head`) and compares the merged blob for each path
    // against base's tip and base's own history.
    // THREE earlier mechanisms were refuted against real git — file overlap
    // (fires on routine hot-file co-editing whose merge is clean), line identity
    // across two three-dot compares (INERT: same merge-base ⇒ disjoint sets),
    // and branch-blob identity (fires on an honest lane that legitimately drops
    // a line base just added, while the merge keeps base's work intact).
    // ONE implementation lives in pr-base-drift.ts; local git only.
    // Fails OPEN everywhere: an unprobeable file narrows the evidence and can
    // never refuse a PR. allowBaseDrift:true is the explicit override.
    let baseDrift = false;
    const pbd = await import('./pr-base-drift');
    // Hermetic test seam: compareFiles injected WITHOUT driftProbe means the git
    // read is unavailable — skip rather than shell out. Production passes
    // neither dep, so the probe is real.
    if ((!!deps.driftProbe || !deps.compareFiles) && ctx.worktree) {
      try {
        // Only files the PR DELETES from can revert anything; probe the biggest.
        const candidates = (files as Array<{ filename?: string; deletions?: number }>)
          .filter((f) => f && typeof f.filename === 'string' && f.filename
            && typeof f.deletions === 'number' && f.deletions > 0 && !pbd.STATE_PATH_RE.test(f.filename))
          .sort((a, b) => (b.deletions ?? 0) - (a.deletions ?? 0))
          .slice(0, BASE_DRIFT_PROBE_CAP)
          .map((f) => ({ path: f.filename as string, deletions: f.deletions }));
        if (candidates.length) {
          // Judge the PR's TREE, never the worktree checkout: on the
          // explicit-head path the checkout may be unrelated (ticket 9d4ef436
          // review round 3 — reading HEAD there judged the wrong tree both ways).
          const headRef = (await resolveLocalRef(ctx.worktree, `refs/remotes/origin/${target.head}`))
            ? `origin/${target.head}`
            : target.head;
          const probes = new Map<string, { mergedBlob: string | null; baseBlob: string | null; historyBlobs: string[] } | null>();
          for (const c of candidates) {
            probes.set(c.path, deps.driftProbe
              ? await deps.driftProbe(c.path, target)
              : await probeDriftFor(ctx.worktree, { base: target.base, head: headRef }, c.path).catch(() => null));
          }
          const verdict = pbd.detectBaseDrift(candidates, probes);
          if (verdict.reverting) {
            baseDrift = true;
            const override = opts.allowBaseDrift === true;
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: {
                seam: 'base_drift', state: override ? 'overridden' : 'enforced', outcome: 'observed',
                repo: `${target.owner}/${target.repo}`, base: target.base,
                revertingFiles: verdict.revertingFiles.slice(0, 20), revertingCount: verdict.revertingFiles.length,
                deletedFiles: verdict.deletedFiles.slice(0, 20), deletedCount: verdict.deletedFiles.length,
                probedFiles: verdict.probedFiles, probeCap: BASE_DRIFT_PROBE_CAP, incomplete: verdict.incomplete,
                machineRun: !ctx.userTurnAt,
              },
            });
            if (!override) return { tail: '', refusal: pbd.renderBaseDriftRefusal(verdict, target.base), filesOnlyMd: false, baseDrift: true };
            notices.push(pbd.renderBaseDriftNotice(verdict, target.base));
          } else if (verdict.incomplete) {
            // Some candidate could not be read: a miss is possible (never a
            // refusal) — surfaced so the fleet can see the blind spot.
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: { seam: 'base_drift', state: 'incomplete', outcome: 'observed', repo: `${target.owner}/${target.repo}`, base: target.base, probedFiles: verdict.probedFiles, candidateCount: candidates.length, probeCap: BASE_DRIFT_PROBE_CAP },
            });
          }
        }
      } catch { /* the guard must never block a real PR */ }
    }
    let prior: Array<{ tool: string; ok: boolean; ids: Record<string, unknown>; createdAt: Date }> = [];
    try {
      if (deps.priorReceipts) prior = await deps.priorReceipts();
      else {
        const { findRecentChatPrReceipts } = await import('./run-idempotency');
        prior = await findRecentChatPrReceipts(ctx.sessionId, pds.DUP_PR_WINDOW_MS);
      }
    } catch { prior = []; }
    const slug = `${target.owner}/${target.repo}`;
    // (b) duplicate re-open: same diff hash, prior PR still open.
    {
      const dup = pds.duplicatePrReceipt(shape, prior, now);
      if (dup && dup.ids.prNumber != null) {
        const n = Number(dup.ids.prNumber);
        const st = deps.prState
          ? await deps.prState(n)
          : await gh(`https://api.github.com/repos/${slug}/pulls/${n}`).then((r) => ({ state: String(r.data?.state ?? ''), headRef: r.data?.head?.ref ? String(r.data.head.ref) : null })).catch(() => null);
        if (st && st.state === 'open') {
          notices.push(pds.renderDuplicatePrNotice(dup, st.headRef));
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
            meta: { seam: 'duplicate_pr', state: 'observed', priorPrNumber: n, diffHash: shape.diffHash, repo: slug },
          });
        }
      }
    }
    // (c) docs-only churn: the Nth docs-only PR on the same file in the window.
    {
      const hit = pds.docsOnlyPrPriorCount(shape, prior, now);
      if (hit) {
        const machineRun = !ctx.userTurnAt;
        const enforced = pds.docsOnlyPrEnforced() && machineRun;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
          meta: { seam: 'docs_only_pr', state: enforced ? 'enforced' : 'observed', count: hit.count, file: hit.sharedFile, additions: shape.additions, deletions: shape.deletions, machineRun, repo: slug },
        });
        if (enforced) refusal = pds.renderDocsOnlyPrRefusal(shape, hit);
        else notices.push(pds.renderDocsOnlyPrNotice(shape, hit));
      }
    }
    // (d) results-log truncation — notice only at this seam (the merge gate is G6).
    {
      const stats = rl.diffStatsFromPatches(files);
      const candidates = rl.resultsLogCandidates(stats);
      if (candidates.length) {
        const sizes = new Map<string, number | null>();
        for (const c of candidates) {
          try {
            const size = deps.preBytes
              ? await deps.preBytes(c.path)
              : Number((await gh(`https://api.github.com/repos/${slug}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(target.base)}`)).data?.size);
            sizes.set(c.path, typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null);
          } catch { sizes.set(c.path, null); }
        }
        for (const t of rl.findResultsLogTruncations(candidates, (path) => sizes.get(path) ?? null, stats)) {
          notices.push(`[RESULTS-LOG NOTICE] ${rl.renderResultsLogNote(t)}`);
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
            meta: { seam: 'results_log_truncate', state: 'observed', at: 'open_pull_request', path: t.path, deleted: t.deleted, added: t.added, sections: t.sectionsDeleted, ratio: t.ratio, hunkEstimated: t.hunkEstimated, archiveMissing: t.archiveMissing, repo: slug },
          });
        }
      }
    }
    const tail = `\n${pds.renderPrDiffLine(shape)}` + notices.map((n) => `\n${n}`).join('');
    return { tail, refusal, filesOnlyMd: shape.filesOnlyMd, baseDrift };
  } catch {
    return null;
  }
}

// ── Base-branch push guard (v1#26 / spark G15, P5 publish-path remediation) ──
// Real class: machine-triggered lanes pushing straight to the project's BASE
// branch (main/master/the PR base) — no PR, no review surface, no CI gate on a
// branch anyone can see first. pushSessionBranch is the ONE seam every publish
// flows through (git_push tool, open_pull_request's pre-push, the controller's
// human Push button), so the guard lives here:
//   - machine-triggered runs (no ctx.userTurnAt — the consequential-gate
//     anchor: set on every real user turn, absent on schedule firings and
//     auto-resumes) used to be REFUSED outright, allowBase or not;
//   - user-present runs used to be refused UNLESS the call explicitly passed
//     allowBase:true (the human buttons pass it — an explicit click).
// Gate flip 2026-09-11 (owner: full steam): the refusal is OBSERVE-ONLY by
// default — the detection stays, a GUARD_STRIKE loop metric (seam 'base_push',
// state 'observed') is recorded and the push result carries a one-line note,
// but the push EXECUTES (the standing directive is "merge to main and push
// autonomously"; the deploy workflow's CI test gate is the real safety net).
// Opt-in BASE_PUSH_GUARD_ENFORCE=1 restores the refusal (the old
// BASE_PUSH_GUARD_DISABLED kill-switch is retired — default is now off).

/** The branch names a session must not push unattended: the project base + the conventional defaults. */
export function protectedBaseBranches(baseBranch?: string): Set<string> {
  const names = new Set(['main', 'master']);
  if (baseBranch) names.add(baseBranch);
  return names;
}

function basePushRefusal(ctx: ToolContext, headBranch: string, userPresent: boolean): string {
  const base = ctx.baseBranch || headBranch;
  return JSON.stringify({
    ok: false,
    reason: 'base_push_guard',
    message: `PUSH REFUSED — "${headBranch}" is a base branch (protected: project base "${base}", main, master). Nothing was pushed.`,
    sessionBranch: ctx.branch || null,
    instructions: userPresent
      ? `To publish: commit on the session branch ("${ctx.branch || 'digby/<task>'}"), git_push it, and open_pull_request into "${base}". If pushing the base branch is genuinely intended, re-call git_push with allowBase:true — the user is present on this run, so the override is honored.`
      : `This is an unattended machine-triggered run: base-branch pushes are NEVER allowed here (allowBase does not override). Publish on the session branch ("${ctx.branch || 'digby/<task>'}") with git_push and open_pull_request into "${base}"; if the base truly must move, say so in your final summary so a human can push it from a user-present run with allowBase:true.`,
  }, null, 1);
}

/** Push the session branch to GitHub. Returns a human-readable result string.
 *  opts.headBranch pins the push to a head the CALLER already resolved
 *  (open_pull_request resolves the PR head once and passes it down so the
 *  published branch and the PR head cannot diverge — ticket c7bf1e66);
 *  omitted, the head is read from the worktree checkout as before. */
/** Regex matching a plan goal that states a LANDING-ON-BASE intent — the
 *  trigger leg of the branch-only-landing advisory (ticket 2c01e9d2). Written
 *  against the goal TEXT (not the step list) and kept conservative: it must
 *  match "land/merge/push … on/to main"-shaped goals without firing on goals
 *  that merely NAME the base branch (e.g. "fix the guard in main's files" —
 *  no landing verb) — a false-positive advisory is noise, a false-negative is
 *  the 8h silent non-landing the ticket exists to kill. */
export function goalLandingOnBaseRe(base: string): RegExp {
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:land|lands|landing|landed|merge|merges|merging|merged|push|pushes|pushing|pushed|deploy|deploys|deploying|deployed|publish|publishes|publishing|published|ship|ships|shipping|shipped)\\b[^.]{0,80}?\\b(?:on|onto|to|into|in)\\s+(?:the\\s+)?(?:${b}|main|master)\\b`,
    'i',
  );
}

/** The durable plan's goal text for this session (the "stated goal" leg of the
 *  ticket-2c01e9d2 advisory), or '' when unavailable — best-effort by design:
 *  a store hiccup, a missing plan, or a test context with a mocked store all
 *  render no advisory rather than an error. */
export async function pushGoalText(ctx: ToolContext): Promise<string> {
  try {
    const { getPlan } = await import('./plan.service');
    const plan = await getPlan(ctx.sessionId);
    return (plan?.goal ?? '').trim();
  } catch {
    return '';
  }
}

/** Did the pushed commit LAND on the remote base branch? tri-state:
 *  true = the base tip contains the pushed sha (an ancestor/equal — the push
 *  WAS a landing); false = it definitively does NOT (merge-base exited 1 —
 *  the advisory fires); null = indeterminate (fetch/network/object error —
 *  the advisory renders NOTHING, never a false claim either way). */
export async function pushedShaLandsOnBase(
  ctx: ToolContext, url: string, base: string, pushedSha: string,
): Promise<boolean | null> {
  try {
    await execFileAsync('git', ['fetch', url, `refs/heads/${base}`], {
      cwd: ctx.worktree, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: ctx.worktree, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    return null; // base branch unreadable (e.g. absent on a brand-new repo)
  }
  try {
    await git(['merge-base', '--is-ancestor', pushedSha, 'FETCH_HEAD'], ctx.worktree, 15_000);
    return true; // exit 0: the base tip contains the pushed commit
  } catch (err: any) {
    // Exit 1 = a DEFINITIVE no (both objects present, no ancestry). Any other
    // failure (exit 128, missing object) is indeterminate — never advisory.
    if (typeof err?.code === 'number' && err.code === 1) return false;
    return null;
  }
}

export async function pushSessionBranch(ctx: ToolContext, opts?: { allowBase?: boolean; headBranch?: string }): Promise<string> {
  // Blank projects: auto-create a PRIVATE repo under the user's account first.
  if ((ctx.provider === 'blank' || !ctx.repoUrl) && ctx.branch && ctx.provider !== 'git') {
    const created = await ensureGithubRepoForBlank(ctx);
    if (created) return created;
  }
  if (ctx.provider !== 'github' || !ctx.repoUrl || !ctx.branch) {
    return 'Push is only available for GitHub projects.';
  }
  // ── Isolation boundary (ticket c75b5f34) ────────────────────────────────
  // A NON-PROD instance (DIGBY_INSTANCE != prod) never pushes to the
  // production repo — even when the project's repoUrl or a connected GitHub
  // token would allow it. Hard refusal (the ONE publish seam: git_push and
  // open_pull_request's push both pass through here). Prod is a no-op.
  // Review F1: the guard keys on repoTargetAllowed (which normalizes the
  // target itself — trailing slash, .git, URL spellings), NEVER on
  // parseOwnerRepo's result: `https://github.com/example-org/crossmodel/`
  // parses to null there and used to skip the guard entirely.
  const isoRepo = parseOwnerRepo(ctx.repoUrl);
  if (!repoTargetAllowed(ctx.repoUrl)) {
    return isolationRefusal(isoRepo ? `${isoRepo.owner}/${isoRepo.repo}` : ctx.repoUrl);
  }
  // Base-branch push guard (v1#26) — decide on the branch the push would
  // actually publish: the caller-pinned head when given (open_pull_request
  // resolves it ONCE so push and PR head cannot diverge, ticket c7bf1e66),
  // else currentHeadBranch, BEFORE any token/network work.
  const guardHeadBranch = opts?.headBranch || (await currentHeadBranch(ctx.worktree)) || ctx.branch;
  let baseNote = '';
  if (protectedBaseBranches(ctx.baseBranch).has(guardHeadBranch)) {
    const userPresent = !!ctx.userTurnAt;
    if (!userPresent || opts?.allowBase !== true) {
      // Gate flip 2026-09-11 (owner: full steam): observe-only — record the
      // strike + annotate the receipt, then push. Opt-in
      // BASE_PUSH_GUARD_ENFORCE=1 restores the refusal envelope.
      if (process.env.BASE_PUSH_GUARD_ENFORCE === '1') {
        return basePushRefusal(ctx, guardHeadBranch, userPresent);
      }
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
        meta: { seam: 'base_push', state: 'observed', head: guardHeadBranch, userPresent },
      });
      baseNote = ` (note: base branch "${guardHeadBranch}" pushed from ${userPresent ? 'a user-present' : 'a machine'} run — base-push guard observe-only)`;
    }
  }
  const token = ctx.getGithubToken ? await ctx.getGithubToken() : null;
  if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations to push.';
  try {
    const url = authedPushUrl(ctx.repoUrl, token);
    // Push HEAD to the branch NAME actually checked out (falling back to the
    // session branch) — see currentHeadBranch. execFile (no shell) keeps the
    // token out of any shell history/args logging beyond this call.
    const headBranch = guardHeadBranch;
    await execFileAsync('git', ['push', url, `HEAD:refs/heads/${headBranch}`], {
      cwd: ctx.worktree, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: ctx.worktree, GIT_TERMINAL_PROMPT: '0' },
    });
    ctx.emit('branch_pushed', { branch: headBranch });
    // Citable-ids follow-up: the pushed sha IS HEAD — capture it best-effort so
    // the receipt (and the model) can name exactly what landed. Appended AFTER
    // the "Pushed <branch> …" prefix the receipt extractor keys on; a read
    // failure must NEVER break the result (the push already happened).
    let pushedSha = '';
    try {
      const { stdout } = await git(['rev-parse', 'HEAD'], ctx.worktree);
      pushedSha = stdout.trim();
    } catch { /* best-effort — sha capture is additive */ }
    // audit 2026-10-08 W2-2 (lanes.md F3): a push to a URL never moved
    // refs/remotes/origin/* on git ≤2.55 (git ≥2.56 now updates the tracking
    // ref itself when the URL uniquely matches the configured remote — same
    // sha this sets), so the run-end "N local commits NOT pushed" note
    // counted every pushed commit as unpushed (18 of 25 prod notes false). Move
    // the tracking ref to what we published and remember the sha for the
    // session (unpushed-commits.ts excludes it even after the remote branch is
    // squash-merged + deleted). Best-effort — the push already happened.
    // Kill switch UNPUSHED_PUSHED_SHAS_DISABLED=1.
    if (pushedSha && process.env.UNPUSHED_PUSHED_SHAS_DISABLED !== '1') {
      await git(['update-ref', `refs/remotes/origin/${headBranch}`, pushedSha], ctx.worktree).catch(() => {});
      await import('./unpushed-commits').then((m) => m.recordPushedSha(ctx.sessionId, pushedSha)).catch(() => {});
    }
    // Ancestry push verdict (I2b, remediation 2026-09-09): real incident — push
    // "verification" that compared ls-remote TIP STRINGS declared success while
    // main ran as two divergent lines for ~11 days. Verify by ANCESTRY instead:
    // re-fetch the remote branch and require the local sha to be an ancestor of
    // (or equal to) the remote tip. The verdict rides the result string and the
    // receipt (ids.verified) — never report a push verified on tip equality
    // alone.
    let verdict = '';
    if (pushedSha) {
      try {
        await execFileAsync('git', ['fetch', url, `refs/heads/${headBranch}`], {
          cwd: ctx.worktree, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: ctx.worktree, GIT_TERMINAL_PROMPT: '0' },
        });
        await git(['merge-base', '--is-ancestor', pushedSha, 'FETCH_HEAD'], ctx.worktree, 15_000);
        verdict = ' (verified: ancestry)';
      } catch {
        verdict = ' (verified: failed — the re-fetched remote tip does not contain this commit; treat the push as UNCONFIRMED and re-check with git_push / git log before claiming it landed)';
      }
    }
    // Published-refs list (ticket 2c01e9d2, 2026-09-27): a push publishes
    // exactly ONE ref — `HEAD:refs/heads/<branch>` — but the old result named
    // only the branch NAME, and a lane read it as "landed on main" (FO firing
    // 29: a fo/* branch publish was treated as a main landing; boxes ran ~8h
    // without the fix). The result now names the VERBATIM refspec(s) published
    // so any reader — model, journal, evidence guard — can see WHICH refs
    // moved without re-deriving intent. An array keeps the shape
    // forward-compatible with multi-ref pushes.
    const pushedRefs: string[] = [`refs/heads/${headBranch}`];
    // Artifact attribution stamp (todo 13dfa16d): the work item THIS push
    // serves, at event time — leg (a) the branch name / last commit message,
    // leg (b) the run's in-progress plan step. The receipt parses it into
    // ids.todoId/ticketId; the wake ledger renders it. Best-effort: a stamp
    // failure never breaks the push result.
    let attributionNote = '';
    try {
      const commitMessage = await readCommitMessageTrailer(ctx.worktree);
      attributionNote = await artifactAttributionStamp(ctx, { branch: headBranch, commitMessage });
    } catch { /* best-effort — the push already happened */ }
    // Branch-only-landing advisory (ticket 2c01e9d2): the ticket's exact
    // silent-non-landing shape is "the run's stated goal is landing on main,
    // the push publishes ONLY a branch ref". When the durable plan's goal
    // states a main-landing intent and the pushed sha is NOT an ancestor of
    // the remote base tip, append an explicit NOT-a-main-landing note + a
    // guard_strike (seam 'branch_only_landing'). Purely additive: a store read
    // failure, an unreadable remote base tip, or a goal with no main-landing
    // intent renders NOTHING (the push already succeeded and the refs list +
    // ancestry verdict fully describe it); never a refusal.
    let mainNote = '';
    if (!protectedBaseBranches(ctx.baseBranch).has(headBranch) && pushedSha) {
      const base = ctx.baseBranch || 'main';
      const goalText = await pushGoalText(ctx);
      if (goalText && goalLandingOnBaseRe(base).test(goalText)) {
        try {
          const landed = await pushedShaLandsOnBase(ctx, url, base, pushedSha);
          if (landed === false) {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: { seam: 'branch_only_landing', state: 'observed', head: headBranch, base },
            });
            mainNote = ` (note: branch publish ONLY — "${base}" does NOT contain this commit: nothing landed on "${base}". To land it: open_pull_request + merge_pull_request, or push HEAD to "${base}" explicitly.)`;
          }
        } catch { /* best-effort — the advisory never breaks a successful push */ }
      }
    }
    return `Pushed ${headBranch} to GitHub (${ctx.repoUrl.replace(/\.git$/, '')})${pushedSha ? ` — sha ${pushedSha}` : ''}${verdict}${mainNote}${attributionNote}.${baseNote} — published refs: ${pushedRefs.join(', ')}.`;
  } catch (err: any) {
    // T7 (2026-09-28): the authed push URL is in execFile's argv echo — mask it
    // before the text reaches the model transcript / receipts.
    return `git push failed: ${redactUrlCredentials(err.stderr?.toString() || err.message || '').slice(0, 300)}`;
  }
}

// The subagent + web/browser tool schemas are appended by the agent when available.

// ── Path safety ────────────────────────────────────────────────────────────────
/**
 * Root-path guard (ticket d559ea0f, 2026-10-27). A MISSING/empty/'.' path on a
 * single-FILE tool is coerced by resolveInside's `path.resolve(root, rel)`
 * into the WORKTREE ROOT itself — a directory — so the tool dies one errno
 * deeper than the truth: edit_file/read_file surface `EISDIR: illegal
 * operation on a directory, read` (the incident's newest filed text; the
 * call args show NO path key at all), and write_file would try to WRITE the
 * root. The model then stares at a filesystem errno that names nothing it
 * controls. The honest, deterministic surface names the actual defect — no
 * file path was given — and the recovery. STRICTLY SCOPED to the
 * resolves-to-root case: an EXPLICIT sub-directory path
 * ('backend/src/modules/crossmodel/coding') keeps the pinned raw EISDIR
 * contract (ticket 8e900af9: an explicit directory argument is a model-
 * authored bad arg, truthfully rejected — replay suite
 * agent-derail-break.8e900af9.test.ts). In-band text (no throw), so the
 * catch-all renderer never sees it.
 */
function rootPathRefusal(name: string, worktree: string, rel: string): string | null {
  // path.resolve(root, rel) is the exact coercion resolveInside applies
  // (absolute rel resolves to itself; every relative rel anchors at root).
  const abs = path.resolve(worktree, rel);
  if (abs !== path.resolve(worktree)) return null; // an explicit non-root path keeps its designed surface
  return `Tool ${name} failed: no file path was given — the path argument (${rel === '' || rel == null ? '(missing or empty)' : `'${rel}'`}) resolves to the WORKTREE ROOT, which is a directory, not a file. Give the file's worktree-relative path (the shell's cwd IS the worktree, so the same relative path works in run_command); list candidates with list_dir or glob. This is a missing-argument error, not a filesystem error.`;
}

export function resolveInside(worktree: string, rel: string): string {
  // Reject traversal and normalize; the resolved path must stay within worktree.
  const root = path.resolve(worktree);
  let abs: string;
  if (path.isAbsolute(rel)) {
    // Absolute paths OUTSIDE the worktree used to be silently re-rooted
    // (leading "/" stripped: "/tmp/x" → "<worktree>/tmp/x") — while run_command's
    // shell honors the real absolute path. Two different files at one apparent
    // path: a write_file "refresh" of /tmp/probe.sh never reached the shell,
    // which then base64-encoded and ran a STALE pre-existing /tmp script (prod
    // incident 2026-08-25, ticket c7591297 — caught only because the lane
    // decoded its own SSM payload). Fail loud with the fix instead of writing
    // somewhere the shell cannot see. Absolute paths that already point INSIDE
    // the worktree are honored as-is (previously they double-nested on write
    // or ENOENT'd on read).
    abs = path.resolve(rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(
        `path is outside the worktree: ${rel} — file tools are worktree-scoped and no longer remap absolute paths ` +
        `(the shell's real /tmp, /etc, … are a DIFFERENT filesystem than the worktree — a write_file there never reaches run_command). ` +
        `Fix: use a worktree-relative path (the shell's cwd IS the worktree, so the same relative path works in run_command), ` +
        `or write/read the absolute container path inside run_command itself (heredoc).`,
      );
    }
  } else {
    abs = path.resolve(root, rel);
  }
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the project root: ${rel}`);
  }
  return abs;
}

/**
 * Like resolveInside, but ALSO resolves symlinks and re-checks that the real
 * target stays within the worktree — so a symlink committed inside the repo
 * (`link -> /app/.env` or `-> /etc/passwd`) can't be read through. Used for
 * read_file. Falls back to the lexical path if the file doesn't exist yet.
 */
async function resolveRealInside(worktree: string, rel: string): Promise<string> {
  const abs = resolveInside(worktree, rel);
  let real: string;
  try { real = await fs.realpath(abs); } catch { return abs; } // not created yet — lexical check stands
  const root = await fs.realpath(worktree).catch(() => path.resolve(worktree));
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`path escapes the project root via a symlink: ${rel}`);
  }
  return real;
}

/**
 * Write-safe containment: like resolveRealInside but for paths we're about to
 * WRITE (the file may not exist yet). Blocks two symlink escapes the lexical
 * resolveInside misses: (1) writing THROUGH an existing symlink whose target is
 * outside the worktree, and (2) creating a new file under a symlinked directory
 * that points outside. Resolves the target's realpath if it exists, else the
 * nearest existing ancestor dir, and re-checks worktree containment.
 */
async function resolveRealInsideForWrite(worktree: string, rel: string): Promise<string> {
  const abs = resolveInside(worktree, rel); // lexical guard first
  const root = await fs.realpath(worktree).catch(() => path.resolve(worktree));
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);

  // Target already exists — following it (symlink or not) must stay inside.
  const existing = await fs.realpath(abs).catch(() => null);
  if (existing) {
    if (!inside(existing)) throw new Error(`path escapes the project root via a symlink: ${rel}`);
    return existing;
  }
  // New file — the nearest EXISTING ancestor dir must resolve inside; the rest
  // is created (mkdir -p) under it, so it can't be redirected out.
  let dir = path.dirname(abs);
  for (;;) {
    const realDir = await fs.realpath(dir).catch(() => null);
    if (realDir) {
      if (!inside(realDir)) throw new Error(`path escapes the project root via a symlinked directory: ${rel}`);
      return path.join(realDir, path.relative(dir, abs));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return abs;
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + `\n…[truncated ${text.length - OUTPUT_CAP} chars]`;
}

/**
 * The real lookups behind search_code_semantic's scoping (code-search.ts takes
 * them injected so its logic is testable without prisma). prisma and the
 * supervisor flag are imported lazily — the same pattern as the sandbox-path
 * lookup above — so tools.ts' import graph does not grow.
 */
function defaultCodeSearchDeps(): CodeSearchDeps {
  return {
    search: (projectId, query, k) => searchCodeSemantic(projectId, query, k),
    readState: (projectId) => readCodeIndexState(projectId),
    isSupervisorChat: async (chatId) => (await import('../platform/supervisor-state.service')).supervisorChatFlag(chatId),
    listRepoProjects: async (userId) => {
      const prisma = (await import('../../../config/database')).default;
      return prisma.crossModelProject.findMany({
        where: { userId, archivedAt: null, repoUrl: { not: null } },
        select: { id: true, name: true, repoUrl: true },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
    },
    // A refusal (non-prod instance pointed at the production repo) or no
    // configured repo ⇒ '' ⇒ no platform index is searched.
    ownRepoSlug: () => { try { return resolveInstanceOwnRepoSlug('SELF_REPO'); } catch { return ''; } },
  };
}

/**
 * Single-quote-escape a string for safe interpolation into a bash command.
 * JSON.stringify() is NOT safe here: it produces a DOUBLE-quoted string, and bash
 * still performs $(…)/backtick/$VAR expansion inside double quotes — so a read-only
 * tool like grep/glob could be steered into arbitrary command execution
 * (`pattern: "$(rm -rf .)"`). Single quotes disable ALL expansion; the only escape
 * needed is closing the quote for a literal ' (→ '\'').
 */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * PCRE→ERE preflight for the grep tool (ticket 1ecde029, 2026-10-20).
 *
 * THE INCIDENT: `grep {pattern:'(?i)qwen'}` (then `(?i)helper`, then `(?i)4b`)
 * fatal'd 3× in one run — `fatal: -e option, '(?i)qwen': Invalid preceding
 * regular expression` — because the tool's engine is `git grep -E` = POSIX
 * ERE and ERE has NO `(?…)` constructs, while the tool's own schema said
 * "ripgrep-like" — a syntax family whose `(?i)` inline flags every frontier
 * model knows by heart. The generic failure text never named the
 * ERE-vs-PCRE gap, so the filing session retried three times varying only
 * the search term and keeping `(?i)`.
 *
 * POLICY: translate only what translates FAITHFULLY (identical match
 * semantics on git grep's single-line subjects); anything else gets a
 * classified, how-to-fix failure — never a silent semantic change:
 *  - leading flags-only groups (?i) (?im) (?is)… → strip; i → git's -i.
 *    m/s are no-ops on single-line subjects (each git-grep subject IS one
 *    line: ^/$ already sit at its edges and `.` never sees a newline), so
 *    stripping them is faithful.
 *  - (?: non-capturing groups → plain ( (ERE groups never capture anyway).
 *  - \d \D \A \z \Z → [0-9] [^0-9] ^ $ $ — glibc ERE would otherwise treat
 *    them as LITERAL letters (`\d` silently matching every line containing
 *    the letter d is the same silent-wrong-verdict family b6d50f4a filed;
 *    \w \W \s \S \b \B are native glibc ERE and stay verbatim).
 *  - [\d…] class interiors → 0-9; as a RANGE ENDPOINT ([a-\d], [\d-z]) or
 *    negated ([\D]) it is classified — a class escape cannot sit there.
 *  - lookarounds, scoped groups (?i:…), mid-pattern flags, flags ERE cannot
 *    honour (x, u, a…) → unsupported, with the construct named in the remedy.
 *  - POSIX [:class:] sequences inside brackets and unterminated classes are
 *    copied VERBATIM (git's own diagnostic is the honest failure there).
 *
 * REVIEW FOLLOW-UP (B1): the rewrite is a single left-to-right pass — bracket
 * interiors are never globally rewritten, so a literal '(?:' inside a class
 * ([(?:] = the set {(, :, ?}) reaches git exactly as written. A blanket
 * split('(?:').join('(') here once silently mangled exactly that pattern.
 */
function translatePcreToEre(raw: string):
  | { kind: 'ok'; pattern: string; caseInsensitive: boolean }
  | { kind: 'unsupported'; construct: string; remedy: string } {
  let body = raw;
  let caseInsensitive = false;
  // 1) Leading flags-only groups (stackable). Only flags that are no-ops or
  //    translatable may pass: i → -i; m/s are no-ops on single-line subjects.
  for (;;) {
    const lead = /^\(\?([a-zA-Z]+)\)/.exec(body);
    if (!lead) break;
    if (![...lead[1]].every(c => 'ims'.includes(c))) {
      return {
        kind: 'unsupported', construct: `(?${lead[1]})`,
        remedy: 'its flags cannot be honoured by POSIX ERE — only a leading i/m/s translates (i becomes -i; m/s are no-ops on single-line subjects); x/u/a have no ERE equivalent.',
      };
    }
    if (lead[1].includes('i')) caseInsensitive = true;
    body = body.slice(lead[0].length);
  }
  // 2) Single left-to-right pass building the ERE pattern. Escapes and
  //    bracket interiors are copied verbatim (minus the faithful \d/\D/\A/\z/
  //    \Z translations); every other unescaped `(?` construct is classified
  //    with a how-to-fix message — never an opaque git fatal.
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      // Outside a bracket: translate the escapes glibc ERE would silently
      // treat as literal letters. \w \W \s \S \b \B are native — verbatim.
      const next = body[i + 1];
      if (next === 'd') { out += '[0-9]'; i++; continue; }
      if (next === 'D') { out += '[^0-9]'; i++; continue; }
      if (next === 'A') { out += '^'; i++; continue; }
      if (next === 'z' || next === 'Z') { out += '$'; i++; continue; }
      out += ch + (next ?? ''); i++; continue;
    }
    if (ch === '[') {
      // Bracket expression: copy VERBATIM (B1) — honouring POSIX [:class:]
      // sequences (a `]` inside them is not the class close), a leading ]/^]
      // literal member, and \d/\D inside the class:
      //   \d → the interior range 0-9 (faithful: [\d.-] ≡ [0-9.-])
      //   \D → classified (a negated class cannot be embedded in ERE)
      //   a \d adjacent to an unescaped range dash → classified (a class
      //   escape cannot be a range endpoint: [a-\d] / [\d-z])
      let j = i + 1;
      let head = '[';
      if (body[j] === '^') { head += '^'; j++; }
      if (body[j] === ']') { head += ']'; j++; } // literal ] member
      let interior = '';
      // Escaped dashes (\-) defer to the END of the class: glibc ERE rejects
      // `[a\-0-9]` ("Invalid range end") even though PCRE reads it as the set
      // {a, -, 0-9}. A dash in final position is always a literal member, and
      // class membership is order-independent — so `[a\-0-9]` ≡ `[a0-9-]`.
      let trailingLiterals = '';
      // True when the last appended member is a RAW (unescaped, non-[:…:])
      // dash — the only position where an adjacent \d/\w/\s escape would be
      // read as a range endpoint. An ESCAPED dash ([a\-\d]) or a trailing
      // dash ([\d-], dash-then-]) is a literal member, not a range.
      let endsRawDash = false;
      while (j < body.length && body[j] !== ']') {
        const c = body[j];
        if (c === '[' && body[j + 1] === ':') {
          // POSIX character class [:alpha:] etc. — copy through its own :]
          const close = body.indexOf(':]', j + 2);
          if (close === -1) { interior += body.slice(j); j = body.length; break; }
          interior += body.slice(j, close + 2); j = close + 2; endsRawDash = false; continue;
        }
        if (c === '\\') {
          const n = body[j + 1];
          if (n === 'd' || n === 'D' || n === 'w' || n === 'W' || n === 's' || n === 'S') {
            // A dash counts as a range START only when a class MEMBER follows
            // it (not ']' and not end-of-string — those are literal dashes).
            // Escaped dashes never reach here as range starts: they are
            // consumed as deferred literals by the n === '-' branch below.
            const rangeAdj = endsRawDash
              || (body[j + 2] === '-' && body[j + 3] !== ']' && body[j + 3] !== undefined);
            const negated = n === 'D' || n === 'W' || n === 'S';
            if (negated || rangeAdj) {
              return {
                kind: 'unsupported',
                construct: `\\${n} (inside a bracket class${rangeAdj && !negated ? ', as a range endpoint' : ''})`,
                remedy: negated
                  ? 'a negated class cannot be embedded in POSIX ERE — write the whole class as [^…] or restructure the pattern.'
                  : 'a class escape cannot be a range endpoint in ERE — spell the range out (e.g. [a-z0-9]) or restructure.',
              };
            }
            // Faithful interior expansions. POSIX class SEQUENCES compose
            // inside ONE bracket ([\s,] → [[:space:],] — proven on this
            // engine); a literal control character would break the
            // shell-quoted command line (the \s-as-' \t\n…' bug the N2 test
            // caught). 0-9 is equivalent for \d and avoids class nesting.
            interior += n === 'd' ? '0-9' : n === 'w' ? '[:alnum:]_' : '[:space:]';
            j += 2; endsRawDash = false; continue;
          }
          if (n === '-') { trailingLiterals += '-'; j += 2; endsRawDash = false; continue; } // deferred literal dash — never interior
          interior += c + (n ?? ''); j += (n === undefined ? 1 : 2); endsRawDash = false; continue;
        }
        interior += c; j++; endsRawDash = c === '-';
      }
      if (j >= body.length) {
        // Unterminated class: copy the remainder verbatim — git's own
        // "Unmatched [" diagnostic is the honest failure (b6d50f4a shape).
        out += head + interior;
        break;
      }
      out += head + interior + trailingLiterals + ']';
      i = j; // the loop's i++ moves past the closing ]
      continue;
    }
    if (ch !== '(' || body[i + 1] !== '?') { out += ch; continue; }
    // (?: non-capturing group — faithfully a plain ERE group … UNLESS the
    // pattern also uses backreferences: glibc ERE honours \1, and turning
    // (?:x)(a)\1 into (x)(a)\1 would silently RETARGET \1 to the wrong
    // group. Classified instead (review N4) — never a silent change.
    if (body[i + 2] === ':') {
      if (/\\[1-9]/.test(body)) {
        return {
          kind: 'unsupported', construct: '(?: … combined with a backreference (\\1…)',
          remedy: 'ERE counts EVERY group, so removing the (?: marker would silently renumber the backreference — rewrite without backreferences or use run_command with plain grep.',
        };
      }
      out += '('; i += 2; continue;
    }
    const rest = body.slice(i);
    const look = /^\(\?(?:<[=!]|[=!])/.exec(rest);
    if (look) {
      return {
        kind: 'unsupported', construct: look[0],
        remedy: 'POSIX ERE has no lookaround — match the parts with separate greps, or use run_command with plain grep.',
      };
    }
    const grp = /^\(\?[a-zA-Z]*[:)]/.exec(rest);
    if (grp) {
      const scoped = grp[0].endsWith(':');
      return {
        kind: 'unsupported', construct: scoped ? `${grp[0]}…)` : grp[0],
        remedy: scoped
          ? 'a scoped flags group has no ERE equivalent — hoist the flag to a leading (?i) prefix (auto-translated to -i; note this makes the WHOLE pattern case-insensitive) or rewrite the group as a plain alternation.'
          : 'flags translate only as the FIRST thing in the pattern — a leading (?i)/(?im)/(?is)/(?s) prefix becomes -i automatically.',
      };
    }
    return {
      kind: 'unsupported', construct: rest.slice(0, 3),
      remedy: 'it has no POSIX ERE equivalent — rewrite as plain ERE ((), +, ?, |, [...]) or use run_command with plain grep.',
    };
  }
  // 3) A flags-only pattern reduces to an empty regex — `-e ''` would dump
  //    every line. That is never what the caller meant; say so.
  if (!out) {
    return {
      kind: 'unsupported', construct: '(flags-only pattern)',
      remedy: 'it reduces to an empty regex, which would match EVERY line — add the search term after the flags.',
    };
  }
  return { kind: 'ok', pattern: out, caseInsensitive };
}

function isPermissionError(err: any): boolean {
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

/**
 * Repair worktree file ownership so Node-side writes succeed. run_command
 * executes inside the session container as the RUNNER image's user (root in the
 * stock node:20 image), so any file it creates/rewrites becomes root-owned on
 * the shared volume — and write_file/edit_file (plain fs in the backend
 * process, uid 1001) then die with EACCES (prod session 7be7440a: the agent had
 * to chmod its way out by hand). ctx.execShell runs AS that container user, so
 * it can hand ownership back: chown the target (and its parent dir, covering
 * new-file creation in a root-owned dir) to the backend's uid, then the caller
 * retries the fs op once. In in-process mode the shell IS the backend user, so
 * a real permission error stays a real error (chown fails, we return false).
 */
async function healNodeAccess(ctx: ToolContext, abs: string): Promise<boolean> {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
    const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
    const dir = path.dirname(abs);
    await ctx.execShell(
      `mkdir -p ${shq(dir)} && chown ${uid}:${gid} ${shq(dir)} && { [ ! -e ${shq(abs)} ] || chown ${uid}:${gid} ${shq(abs)}; }`,
      ctx.worktree, 20_000,
    );
    return true;
  } catch { return false; }
}

// Minimal env for run_command: no provider secrets. PATH/HOME + language-neutral basics.
function commandEnv(worktree: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: worktree,
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    NODE_ENV: 'development',
  };
}

// ── run_command publish-intent interception (v1#27, P5 publish-path) ─────────
// session-credentials injects GH_TOKEN + a git credential helper into EVERY
// shell command, so `git push`, `gh pr merge`, and raw REST merge curls through
// run_command bypass every publish gate (base-branch guard, ancestry verdict,
// CI observation, receipts). Intercept the UNAMBIGUOUS shapes only:
//   - `git push` (word-boundary; dash-options between `git` and `push` match —
//     `git --no-pager push`, `git --git-dir=x push`; a separated-argument form
//     (`git -C /path push`) matches by ONE optional separated argument after a
//     dash-option — PBG-1 2026-11-03; a path-prefixed binary
//     (`/usr/bin/git push`, `./x/git push`) matches too — same PR);
//   - a SHELL-WRAPPER invocation: `sh|bash|zsh|dash|ksh -c '<inner>'` is
//     unwrapped (bounded depth 2) and its payload re-tested — `bash -c "git
//     push"` used to execute with NO notice and NO metric (PBG-1 2026-11-03);
//   - `gh pr merge`;
//   - GitHub REST merge URLs (…/pulls/<n>/merge and …/merges) — only when the
//     command also carries a WRITE verb marker (-X/--request/--method PUT|POST,
//     or a -d/--data body): a bare GET of …/pulls/<n>/merge is the merge-STATUS
//     probe and must not match (3 of 15 live refusals were such probes);
//   - `git remote add|set-url … x-access-token` (credential-persisting remote —
//     the exfil-ish shape from the review). This is the ONE hard refusal.
// Gate flip 2026-09-11 (owner: full steam): publish-shaped commands are
// OBSERVE-ONLY — every run (machine or user-present) gets the
// `[publish-intent notice]` line after the status banner, a GUARD_STRIKE loop
// metric (seam 'run_command_publish', state 'observed') is recorded, and the
// command EXECUTES. Only the credential-persisting remote (hardRefuse) is still
// refused on machine runs. Opt-in RUN_COMMAND_PUSH_GUARD_ENFORCE=1 restores the
// machine-run refusal envelope for every pattern. ACCEPTED EDGES: an UNQUOTED
// benign phrase (`echo git push`) matches — now it only earns the notice (a
// QUOTED `echo "git push"` does not match: the quote breaks the boundary);
// heredoc-embedded commands are NOT specially parsed (they match like any other
// text). There is NO kill-switch for the detection (RUN_COMMAND_PUSH_GUARD_DISABLED
// was retired 2026-09-11 — it used to switch off the credential refusal too).
export const PUBLISH_INTENT_PATTERNS: ReadonlyArray<{ re: RegExp; also?: RegExp; what: string; redirect: string; hardRefuse?: boolean }> = [
  {
    // PBG-1 (2026-11-03) widened this from "bare `git` only" to the shapes a
    // real shell reaches, WITHOUT the two defects the first cut shipped (found
    // by independent review, fixed in the follow-up):
    //   - an EXECUTABLE PATH PREFIX must look like one (`/`, `./`, `../`, `~/`,
    //     `$VAR/`) — a bare `bin/` used to make path-prefixed PROSE inside a
    //     quoted string (`echo "please run bin/git push"`) match, and quotes are
    //     excluded from the class so `grep "bin/git push"` stays unmatched;
    //   - ONE separated argument after a dash-option (`git -C /p push`), which
    //     MUST NOT itself look like a flag — that negative lookahead is what
    //     keeps the group unambiguous, and unambiguity is what keeps matching
    //     LINEAR (see PUBLISH_SCAN_CAP_CHARS / the timing row in the PIN).
    re: /(?:^|[\s;&|(`])(?:(?:\/|\.{1,2}\/|~\/|\$\{?\w+\}?\/)[^\s;&|()'"`]*\/)?git(?:\s+-{1,2}[\w=./:@-]+(?:\s+(?!-)[^\s;&|()`]+)?)*\s+push\b/,
    what: 'git push',
    redirect: 'use the git_push tool — it authenticates for you, annotates base-branch pushes, verifies the push by ancestry, observes CI, and leaves a receipt',
  },
  {
    re: /(?:^|[\s;&|(`])(?:(?:\/|\.{1,2}\/|~\/|\$\{?\w+\}?\/)[^\s;&|()'"`]*\/)?gh\s+pr\s+merge\b/,
    what: 'gh pr merge',
    redirect: 'merge through the merge_pull_request tool — it verifies CI/verify-chain/secrets on fresh API evidence, refuses nothing-changed retries, and only reports success after GitHub confirms merged:true',
  },
  {
    re: /api\.github\.com\/repos\/[^\s"']+\/(?:pulls\/[^\s"'/]+\/merge|merges)\b/,
    // Write-verb marker: a GET merge-status probe (`curl …/pulls/10/merge`)
    // must not read as a merge. `-X PUT`, `-XPUT`, `--request PUT`,
    // `--method=PUT`, or a request body (-d/--data*) all count.
    also: /(?:^|\s)(?:-X[\s=]*|(?:--request|--method)[\s=]+)(?:PUT|POST)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?)(?:\s|=|$)/,
    what: 'GitHub REST merge call',
    redirect: 'a raw REST merge bypasses every gate: merge through the merge_pull_request tool — it verifies CI/verify-chain/secrets deterministically and confirms merged:true itself',
  },
  {
    // PBG-1 follow-up (review B2): this class MUST accept the same executable
    // path prefix as the git/gh patterns above. Widening those two without it
    // manufactured a SILENT bypass of the ONE auto-refused class —
    // `/usr/bin/git remote set-url … x-access-token …` matched nothing.
    re: /(?:^|[\s;&|(`])(?:(?:\/|\.{1,2}\/|~\/|\$\{?\w+\}?\/)[^\s;&|()'"`]*\/)?git\s+remote\s+(?:add|set-url)\b[^\n]*x-access-token/,
    what: 'git remote with an embedded x-access-token credential',
    redirect: 'never persist credentials in a remote URL — the git_push tool injects auth per call without storing the token',
    hardRefuse: true,
  },
];

/**
 * ANSWER-KEY GUARD telemetry (2026-10-03, answer-key-guard.ts — opt-in
 * ANSWER_KEY_GUARD=1): ONE loop_metrics `answer_key_blocked` row per refusal /
 * withheld result — meta { phase: 'pre'|'post', tool, label, target?, dropped? }.
 * Never throws (recordLoopMetric is fire-and-forget).
 */
export function recordAnswerKeyBlock(ctx: Pick<ToolContext, 'sessionId' | 'runId'>, b: AnswerKeyBlock): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.ANSWER_KEY_BLOCKED, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
      meta: {
        phase: b.phase, tool: b.tool, label: b.label,
        ...(b.target ? { target: b.target.slice(0, 200) } : {}),
        ...(b.dropped ? { dropped: b.dropped } : {}),
      },
    });
  } catch { /* telemetry only */ }
}

/** First unambiguous publish/merge intent in a shell command, or null.
 *  `hardRefuse` marks the ONE pattern still refused on machine runs by default
 *  (credential persistence) — every other match is observe-only.
 *
 *  PBG-1 (2026-11-03): a shell-WRAPPER payload is unwrapped and re-tested.
 *  `bash -c "git push origin main"` / `sh -c 'gh pr merge 7'` used to execute
 *  with NO notice and NO metric — the regex never saw the inner command. The
 *  unwrap is bounded (depth 2) and a wrapper whose payload cannot be extracted
 *  falls through to the outer scan unchanged (no new false negative).
 *
 *  PBG-1 follow-up (independent review N1): the first cut used ONE regex
 *  requiring the `c` GLUED to the flag cluster, so the ordinary
 *  `bash -e -c '<payload>'` / `sh -o pipefail -c …` forms still slipped
 *  through while `bash -ec` matched — the same class split in two. Replaced by
 *  token scanning (`extractShellWrapperPayload`), which walks the wrapper's own
 *  argument list: separate flags, glued clusters (`-ec`/`-lc`), `-o <opt>`
 *  pairs, and `--command[=]` are all handled, and a script-file invocation
 *  (`bash build.sh`) correctly yields nothing.
 */
const SHELL_WRAPPER_HEAD_RE = /(?:^|[\s;&|(`])(?:(?:\/|\.{1,2}\/|~\/|\$\{?\w+\}?\/)[^\s;&|()'"`]*\/)?(?:bash|sh|zsh|dash|ksh)\b/g;

/** The `-c` payload of the FIRST shell wrapper that has one, else null.
 *  Linear in the command length and allocation-light — it only runs after the
 *  pattern scan misses, so it never adds cost to the common case. */
function extractShellWrapperPayload(command: string): string | null {
  const head = new RegExp(SHELL_WRAPPER_HEAD_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = head.exec(command)) !== null) {
    let i = m.index + m[0].length;
    let expectPayload = false;
    for (;;) {
      while (i < command.length && /\s/.test(command[i])) i++;
      if (i >= command.length) break;
      const ch = command[i];
      if (ch === ';' || ch === '&' || ch === '|' || ch === ')' || ch === '`') break; // wrapper ended
      let tok: string;
      if (ch === "'" || ch === '"') {
        const q = ch;
        let j = i + 1;
        while (j < command.length && command[j] !== q) { if (q === '"' && command[j] === '\\') j++; j++; }
        tok = command.slice(i + 1, j);
        i = j + 1;
        if (expectPayload) return tok; // bash -c '<payload>'
        continue;                      // some other quoted argument
      }
      let j = i;
      while (j < command.length && !/\s/.test(command[j]) && !/[;&|)`]/.test(command[j])) j++;
      tok = command.slice(i, j);
      i = j;
      if (expectPayload) return tok;   // bash -c <payload-unquoted>
      if (tok.startsWith('--command')) {
        const inline = tok.startsWith('--command=') ? tok.slice('--command='.length) : '';
        if (inline) return inline;
        expectPayload = true;
        continue;
      }
      if (tok.startsWith('-') && !tok.startsWith('--')) {
        const cluster = tok.slice(1);
        if (cluster.includes('c')) { expectPayload = true; continue; } // -c / -ec / -lc
        // `-o <option>` / `-O <option>` consume a SEPARATE argument.
        if (cluster === 'o' || cluster === 'O') {
          while (i < command.length && /\s/.test(command[i])) i++;
          let k = i;
          while (k < command.length && !/\s/.test(command[k])) k++;
          i = k;
          continue;
        }
        continue;
      }
      break; // `bash something.sh` — a script file, not a -c payload
    }
  }
  return null;
}

export function detectPublishIntent(command: string, depth = 0): { what: string; redirect: string; hardRefuse: boolean } | null {
  for (const p of PUBLISH_INTENT_PATTERNS) {
    if (p.re.test(command) && (!p.also || p.also.test(command))) {
      return { what: p.what, redirect: p.redirect, hardRefuse: p.hardRefuse === true };
    }
  }
  // Shell-wrapper payload: re-test the INNER command (bounded depth 2).
  if (depth < 2) {
    const inner = extractShellWrapperPayload(command);
    if (inner && inner !== command) {
      const hit = detectPublishIntent(inner, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Permission gate ──────────────────────────────────────────────────────────────
async function checkPermission(ctx: ToolContext, tool: string, args: any): Promise<{ ok: boolean; message?: string }> {
  // verify executes project code — allowed in auto/ask, blocked in plan (read-only).
  if (EXECUTES_CODE.has(tool)) {
    if (ctx.permissionMode === 'plan') {
      return { ok: false, message: `Blocked in PLAN mode: ${tool} runs project commands. Present your plan first.` };
    }
    return { ok: true };
  }
  // ASK-ONLY tools (destructive platform ops): 'auto' does NOT bypass the human
  // prompt — the same deterministic choke-point discipline as the commit-time
  // secret scan. plan mode blocks outright; ask/auto both requestApproval.
  if (ASK_ONLY_TOOLS.has(tool)) {
    if (ctx.permissionMode === 'plan') {
      return { ok: false, message: `Blocked in PLAN mode: ${tool} is destructive. Present your plan; the user will switch to auto/ask to apply it.` };
    }
    if (ctx.alwaysAllow.has(tool)) return { ok: true };
    // Unattended (machine-triggered) run: nobody is watching to click, and these
    // destructive tools ALWAYS need a human decision (auto does not bypass them)
    // — fail fast instead of parking 14 min in requestApproval per attempt (the
    // same guard as the general ask-mode branch below; it was missing here, so
    // schedule-fired runs still stalled on delete_chat/delete_project).
    if (!ctx.userTurnAt) {
      return { ok: false, message: `AUTO-DENIED: ${tool} is destructive and always requires a human approval click (even in AUTO mode), but this is an unattended machine-triggered run — nobody is watching to approve it. Do not retry it this run; tell the owner in your final summary that this action needs them present.` };
    }
    const askDecision = await ctx.requestApproval(tool, args);
    if (askDecision === 'always') { ctx.alwaysAllow.add(tool); return { ok: true }; }
    if (askDecision === 'allow') return { ok: true };
    return { ok: false, message: `The user DENIED (or did not approve) this destructive ${tool} action. Do not retry it; adjust your approach or ask what they'd prefer.` };
  }
  if (!MUTATING_TOOLS.has(tool)) return { ok: true };
  if (ctx.permissionMode === 'auto') return { ok: true };
  if (ctx.permissionMode === 'plan') {
    return { ok: false, message: `Blocked in PLAN mode: ${tool} makes changes. Present your plan; the user will switch to auto/ask to apply it.` };
  }
  // ask mode
  if (ctx.alwaysAllow.has(tool)) return { ok: true };
  // Unattended (machine-triggered) run: nobody is watching to click, and the
  // registry auto-denies after 14 min anyway — fail fast with the real reason
  // instead of stalling EVERY mutating tool call. userTurnAt is set on EVERY
  // real user turn and omitted on schedule firings/auto-resumes (see agent.ts).
  if (!ctx.userTurnAt) {
    return { ok: false, message: `AUTO-DENIED: ${tool} needs a human approval click, but this is an unattended machine-triggered run in ASK mode (the approval would stall then auto-deny anyway). Read-only tools still work — do what you can read-only, and tell the owner in your final summary that this session must be switched to AUTO mode for autonomous work. Do not retry mutating tools this run.` };
  }
  const decision = await ctx.requestApproval(tool, args);
  if (decision === 'always') { ctx.alwaysAllow.add(tool); return { ok: true }; }
  if (decision === 'allow') return { ok: true };
  return { ok: false, message: `The user DENIED this ${tool} action. Do not retry it; adjust your approach or ask what they'd prefer.` };
}

// ── Verify chain runner (shared by the verify tool and the open_pull_request
// gate's auto-verify, 2026-09-27 A5) ──────────────────────────────────────────
// Emits verify_start / verify_result, runs the chain under the process-wide
// verify slot, records the fingerprinted pass, and renders the one-line summary.
async function runVerifyChainForTool(
  ctx: ToolContext, config: DigbyConfig | null, chain: VerifyChainEntry[],
): Promise<{ result: VerifyResult; summary: string }> {
  const lc = loopConfig(config);
  ctx.emit('verify_start', { stages: chain.map(c => c.key) });
  // Thundering-herd guard (ticket 6bf8ce36): cap concurrent verify chains
  // process-wide (FIFO; VERIFY_GATE_CONCURRENCY) so N sessions can't
  // stampede the box with parallel cold tsc/lint/test runs.
  // build 2026-10-09 VS: + the per-CONTAINER slot (verify-container-slots.ts); queued time leaves the run deadline
  // and this call's hard timer (so a verify waiting in line is never "exceeded 900s").
  const result = await runGatedVerifyChain(ctx.execShell, ctx.worktree, {
    seam: 'tool', sessionId: ctx.sessionId, runId: ctx.runId,
    progress: (message) => ctx.emit('progress', { message, stage: 'verify' }),
    onQueuedWait: (ms) => ctx.onShieldedWait?.(ms, { queued: true }),
  }, () => runVerifyChain(ctx.execShell, ctx.worktree, chain, lc.perCommandTimeoutMs, { baseBranch: ctx.baseBranch || config?.defaultBranch || 'main', sessionId: ctx.sessionId }));
  // v1#29: key the recorded pass to the workspace content at verify time
  // (the PR gate re-fingerprints and compares). v1#30: record the hollow
  // "passed only because tools were missing" outcome as unverified.
  await recordVerify(ctx.sessionId, result.passed, result.failedStage || undefined, {
    fingerprint: await captureVerifyFingerprint(ctx.worktree),
    unverified: result.unverified,
    deferred: result.stages.some(s => s.deferred),
    // A1 (2026-10-04, verify-unchanged-skip.ts): the record names the chain it
    // covers — a full-chain green here lets the harness auto-verify skip an
    // unchanged tree; an `only` subset signs differently and never does.
    ...(autoVerifyUnchangedSkipDisabled() ? {} : { chainSig: verifyChainSignature(chain), stages: chain.map(c => c.key) }),
  });
  ctx.emit('verify_result', { passed: result.passed, unverified: result.unverified, failedStage: result.failedStage, stages: result.stages.map(s => ({ key: s.key, passed: s.passed })) });
  const summary = result.stages.map(s => `${s.deferred ? '⏸' : s.skipped ? '⊘' : s.passed ? '✓' : '✗'} ${s.key}${s.envStarved ? ' (env-starved — the container cannot host a cold chain now; this is NOT a code failure; do not retry in a tight loop — wait for peer load to subside)' : s.deferred ? ' (deferred — container memory pressure; retry when peer load subsides)' : s.skipped ? ' (skipped — tool not installed)' : ` (exit ${s.exitCode})`}`).join('  ');
  return { result, summary };
}

// ── Executor ─────────────────────────────────────────────────────────────────────
export async function executeCodingTool(ctx: ToolContext, name: string, args: any): Promise<string> {
  try {
    const perm = await checkPermission(ctx, name, args);
    if (!perm.ok) return perm.message || 'Not permitted.';

    // Platform tools (P1): thin wrappers over platform.service.ts — authz and
    // audit live there; gating above already applied.
    if (isPlatformTool(name)) return await executePlatformTool(ctx, name, args);

    switch (name) {
      case 'session_browser': {
        // ea3ad8a8 — the hosted hardened browser, per-session context. Raw
        // single-action surface; the agentic loop is browser_task. The context
        // key is the coding session id (per-session isolation).
        if (!sessionBrowserToolEnabled()) {
          return 'session_browser is not enabled on this deployment (BROWSER_SERVICE_ENABLED off).';
        }
        const key = `session:${ctx.sessionId}`;
        const action = String(args.action || '').trim();
        const allowed = ['navigate', 'get_content', 'click', 'type', 'scroll', 'screenshot', 'close'];
        if (!allowed.includes(action)) {
          return `session_browser: unknown action "${action}" — one of ${allowed.join(', ')}.`;
        }
        const { sessionBrowserAction } = await import('../browser-agent/session-browser-client');
        const res = await sessionBrowserAction(key, {
          name: action,
          ...(action === 'navigate' && args.url ? { url: String(args.url) } : {}),
          ...(action === 'click' && args.selector ? { selector: String(args.selector) } : {}),
          ...(action === 'type' ? { ...(args.selector ? { selector: String(args.selector) } : {}), ...(args.text != null ? { text: String(args.text) } : {}), ...(args.submit === true ? { submit: true } : {}) } : {}),
          ...(action === 'scroll' ? { ...(args.direction ? { direction: String(args.direction) } : {}), ...(args.amount != null ? { amount: Number(args.amount) } : {}) } : {}),
        });
        if (action === 'screenshot' && res.ok && res.screenshotBase64) {
          return `[screenshot captured: ${res.url || 'page'} — ${res.screenshotBase64.length} base64 chars; the image is not renderable in this tool's text return — use browser_task when you need to SEE a page]`;
        }
        const parts: string[] = [
          res.ok ? 'ok' : `error: ${res.error || 'unknown'}`,
          res.url ? `url: ${res.url}` : '',
          res.content ? `content:\n${res.content}` : '',
          res.links?.length ? `links: ${res.links.map((l) => `${l.text} <${l.href}>`).join(' · ')}` : '',
          res.truncated ? '(content truncated)' : '',
        ].filter(Boolean);
        return cap(parts.join('\n'));
      }

      case 'read_file': {
        // Root-path guard (ticket d559ea0f, 2026-10-27) — see rootPathRefusal.
        const rpRoot = rootPathRefusal('read_file', ctx.worktree, String(args.path || ''));
        if (rpRoot) return rpRoot;
        const abs = await resolveRealInside(ctx.worktree, String(args.path || ''));
        let content = await fs.readFile(abs, 'utf8');
        if (args.start_line || args.end_line) {
          const lines = content.split('\n');
          const s = Math.max(1, Number(args.start_line) || 1);
          const e = Math.min(lines.length, Number(args.end_line) || lines.length);
          content = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n');
        }
        return cap(content);
      }

      case 'view_image':
        // Bytes come through the session shell (task files may live outside
        // the worktree, e.g. /app/…); the path is shq()-quoted in every command.
        return cap(await runViewImage({ execShell: ctx.execShell, worktree: ctx.worktree, quote: shq, userId: ctx.userId }, args));

      case 'list_dir': {
        const abs = resolveInside(ctx.worktree, String(args.path || '.'));
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return entries
          .filter(e => e.name !== '.git')
          .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n') || '(empty)';
      }

      case 'glob': {
        const pattern = String(args.pattern || '');
        // Match tracked AND untracked files with proper glob semantics (** / *) via
        // git's `:(glob)` magic pathspec — recursive, unlike the old `ls -1`.
        // NB: single-quote-escape the pattern (shq); never expand it via the shell
        // (unquoted expansion is exactly what made this injectable) or JSON.stringify.
        const spec = shq(`:(glob)${pattern}`);
        let execThrew = false;
        const { stdout, stderr } = await ctx.execShell(
          `(git ls-files -- ${spec} 2>/dev/null; git ls-files --others --exclude-standard -- ${spec} 2>/dev/null) | sort -u | head -300`,
          ctx.worktree, 30_000,
        ).catch((err: any) => { execThrew = true; return { stdout: '', stderr: `[exec failed] ${err?.message ?? err}` }; });
        // A DEAD SHELL IS NOT "no matches" (family deploy-kills-lane-background-
        // workers, ticket 093e9a61). This branch used to `.catch(() => ({stdout:
        // ''}))` and render the empty string as "(no matches)" — so a container
        // replaced mid-run, a timeout or a transport death told the lane its
        // files do not exist. The grep tool was fixed for exactly this false
        // zero (ticket b6d50f4a); glob never got the same treatment, and it is
        // the tool a lane reaches for FIRST when it suspects its work was lost.
        // TWO ways to know the shell did not run: execShell THREW (it never
        // throws by contract — execInContainer/execInProcess return `[exit: …]`
        // shapes — so a throw means something broke beneath it), or stderr
        // carries a transport signature. Either way, with no stdout, this is
        // INFRA and emphatically not a missing-file verdict.
        const errText = String(stderr || '').trim();
        if (!String(stdout || '').trim() && (execThrew || (errText && isExecTransportFailure(errText)))) {
          const why = (errText.match(/\[exit:[^\]]*\]/)?.[0] || errText.split('\n').find(Boolean) || 'no output').slice(0, 300);
          // Never advise a fallback that is down for the same reason: when the
          // exec layer itself is gone, run_command rides the SAME execShell.
          const fallback = /exec failed|Isolated execution is temporarily unavailable/i.test(errText)
            ? 'Shell tools share this transport, so switching tools will not help — report this as an infra block and continue with non-shell work.'
            : 'Retry the SAME call; if it persists, run_command is available.';
          return `[INFRA] Tool glob failed: the search did not complete (${why}) — the session shell is not available, so this is NOT a "no matches" verdict and NOT a missing file. ${fallback}`;
        }
        return cap((stdout || '').trim() || '(no matches)');
      }

      case 'grep': {
        const pattern = String(args.pattern || '');
        if (!pattern.trim()) return 'Tool grep failed: a pattern is required (extended regex — an empty pattern would match every line).';
        // PCRE→ERE preflight (ticket 1ecde029): the engine is `git grep -E`
        // (POSIX ERE), but models schooled on ripgrep/PCRE send `(?i)`-style
        // constructs it cannot compile. Translate the faithfully-translatable
        // leading-flag shapes; classify the rest with a how-to-fix message
        // instead of the pre-fix opaque git fatal the model retried verbatim.
        const pcre = translatePcreToEre(pattern);
        if (pcre.kind === 'unsupported') {
          return `Tool grep failed: the pattern uses ${shq(pcre.construct)} which this tool cannot translate to POSIX ERE — ${pcre.remedy} The pattern was: ${shq(pattern).slice(0, 300)}.`;
        }
        const erePattern = pcre.pattern;
        const scopeAbs = args.path ? resolveInside(ctx.worktree, String(args.path)) : ctx.worktree; // path-escape guard
        const scopeRel = path.relative(ctx.worktree, scopeAbs) || '.';
        // shq() every interpolated value — a double-quoted JSON.stringify still lets
        // bash expand $(…)/backticks/$VAR, which would turn this read-only tool into
        // arbitrary command execution.
        //
        // b6d50f4a (2026-10-14): the old `grep -ErnI <scope>…` walked EVERYTHING
        // under the scope — node_modules included, because plain GNU grep ignores
        // .gitignore — so a scoped or repo-wide search became a multi-GB crawl that
        // blew the 30s timeout under load, and the `.catch(() => ({stdout:''}))`
        // rendered the kill as "(no matches)": a FALSE ZERO for symbols that
        // verifiably existed (glob, read_file and shell grep in the same worktree
        // all saw them). Two-part fix:
        //  1. `git grep --untracked` — the SAME ignore view glob uses
        //     (git ls-files --exclude-standard): tracked + untracked files,
        //     .gitignore'd paths excluded. No node_modules crawl, and ignored
        //     secrets (.env) are no longer searched either. To search ignored
        //     paths, use run_command with plain grep. (.digbyignore is
        //     deliberately NOT layered in via core.excludesFile: glob's view does
        //     not include it either — grep must match glob exactly, which is the
        //     consistency contract this ticket filed.)
        //  2. An exit sentinel (PIPESTATUS[0]) after the pipeline + honest failure
        //     surfacing: infra failure, timeout, or a bad regex is reported as
        //     "Tool grep failed: …" — "(no matches)" is ONLY ever a real verdict.
        // Pathspec composition — multiple pathspecs are a UNION, so scope + filter
        // must compose into ONE pathspec, never two:
        //  - no filter, or an explicit FILE scope (review F2: composing a filter
        //    onto a file path made git exit 1 on a swallowed "Not a directory"
        //    warning — a silent false zero; an explicitly named file is searched
        //    as-is): ':(literal)<scope>'  (parens/spaces/glob chars stay literal)
        //  - filter, no '/':   ':(glob)<scope>/**/<filter>'  (basename-style, like grep --include)
        //  - filter with '/':  ':(glob)<scope>/<filter>'     (path-anchored)
        const filter = args.glob ? String(args.glob) : '';
        const scopeIsFile = await fs.stat(scopeAbs).then(st => st.isFile()).catch(() => false);
        const scopePrefix = scopeRel === '.' ? '' : `${scopeRel}/`;
        const spec = filter && !scopeIsFile
          ? `:(glob)${scopePrefix}${filter.includes('/') ? filter : `**/${filter}`}`
          : `:(literal)${scopeRel}`;
        // cut -c1-500 bounds line length (a match inside a minified bundle would
        // otherwise blow the 16MB exec buffer). head -201 requests ONE line past
        // the cap: a 201st line ⇒ truncated. When the RAW git output outruns the
        // ~64KB pipe buffer, the early-exiting head SIGPIPEs git (through cut) ⇒
        // exit 141 — which ALSO means "more matches than the cap", so it routes to
        // the same matches path below (review F1: routing 141 to the failure
        // branch discarded 201 REAL matches on ordinary broad searches).
        const { stdout, stderr } = await ctx.execShell(
          `git -c core.quotepath=off grep -nIE${pcre.caseInsensitive ? 'i' : ''} --untracked --full-name -e ${shq(erePattern)} -- ${shq(spec)} | cut -c1-500 | head -201; printf '\\n[digby-grep-exit:%s]' "\${PIPESTATUS[0]}"`,
          ctx.worktree, 30_000,
        ).catch((err: any) => ({ stdout: '', stderr: `[exec failed] ${err?.message ?? err}` }));
        const out = String(stdout || '');
        const errOut = String(stderr || '').trim();
        const lines = out.split('\n');
        const sm = /^\[digby-grep-exit:(\d+)\]$/.exec(lines[lines.length - 1] || '');
        if (!sm) {
          // No sentinel ⇒ the pipeline never finished (timeout, infra failure,
          // exec throw). NEVER render this as "(no matches)" — that is the exact
          // false zero this ticket filed.
          const why = (errOut.match(/\[exit:[^\]]*\]/)?.[0] || errOut.split('\n').find(Boolean) || 'no exit marker in output').slice(0, 300);
          // FAMILY tool-failure-streak (2026-11-03): a DEAD SHELL is not a bad
          // pattern. Eight auto-filed members carried this exact text for calls
          // whose pattern AND scope replay GREEN in the worktree — all six
          // recorded call shapes still exit 0/1 today, so the patterns were
          // never the problem; the shell died (container reaped mid-run) and the
          // old advice sent each lane off rewriting a VALID pattern, racking the
          // 3× streak that withheld `grep` for a model round and auto-filed a
          // model-blaming mishap.
          // No sentinel is PROOF of an infra death, by construction: the command
          // list ends in an UNCONDITIONAL `printf` after `;`, so if bash had run
          // the list at all the sentinel would be there. A bad pattern never
          // lands here either — git grep exits 128 with a `fatal:` line and the
          // sentinel intact (the code!==0 branch below). So: name it INFRA, and
          // anchor the result with `[INFRA]` so the derail streak
          // (learnings-index looksLikeToolFailure) never charges it to the model.
          if (isExecTransportFailure(errOut) || !errOut.replace(/\[exit:[^\]]*\]/g, '').trim()) {
            return `[INFRA] Tool grep failed: the search did not complete (${why}) — the session shell died before git grep ran (container/exec unavailable), so this is NOT a "no matches" verdict and NOT a bad pattern or scope. Retry the SAME call; changing the pattern/scope will not help. If it persists, run_command is available.`;
          }
          return `Tool grep failed: the search did not complete (${why}) — this is NOT a "no matches" verdict. Narrow the scope/path, or fall back to run_command with plain grep.`;
        }
        const code = Number(sm[1]);
        if (code === 0 || code === 1 || code === 141) {
          // 141 = SIGPIPE from head's early exit ⇒ more matches than the cap.
          const bodyLines = lines.slice(0, -1).filter(Boolean);
          const truncated = bodyLines.length > 200 || code === 141;
          const body = (truncated ? bodyLines.slice(0, 200) : bodyLines).join('\n');
          const note = truncated ? '\n…[truncated — more than 200 matches; narrow the pattern or scope]' : '';
          return body ? cap(body) + note : '(no matches)';
        }
        // Anything else is a real failure (128 = git fatal: bad ERE, not a repo…).
        // Surface it honestly — never as "(no matches)".
        const fatal = errOut.split('\n').find(l => /fatal:|error:/i.test(l)) || errOut.split('\n').find(Boolean) || `git grep exited ${code}`;
        const noRepo = /not a git repository/i.test(errOut);
        return `Tool grep failed: ${fatal.slice(0, 300)}${noRepo ? ' — the worktree is not a git repository; use run_command with plain grep.' : ' — fix the pattern/scope, or use run_command with plain grep.'}`;
      }

      case 'ast_search':
      case 'ast_rewrite': {
        // AST-aware search / rewrite (harness roadmap item 3, 2026-09-20):
        // ast-grep via npx inside the dev container — see ast-tools.ts. Same
        // quoting invariant as grep/glob: shq() on EVERY interpolated value.
        const pattern = String(args.pattern ?? '');
        if (!pattern.trim()) return `Tool ${name} failed: a pattern is required (ast-grep pattern syntax — $A matches one node, $$$ARGS many).`;
        const langErr = validateAstLang(args.lang);
        if (langErr) return langErr.replace(/^Tool failed:/, `Tool ${name} failed:`);
        const scopeAbs = resolveInside(ctx.worktree, args.path ? String(args.path) : '.'); // path-escape guard
        const scope = path.relative(ctx.worktree, scopeAbs) || '.'; // relative ⇒ ast-grep prints worktree-relative paths
        const lang = args.lang ? String(args.lang) : null;
        const glob = args.glob ? String(args.glob) : null;
        const isRewrite = name === 'ast_rewrite';
        if (isRewrite && typeof args.rewrite !== 'string') return 'Tool ast_rewrite failed: `rewrite` must be a string (the replacement template — metavariables from the pattern such as $A are substituted; "" deletes the match).';
        const rewrite: string | undefined = isRewrite ? String(args.rewrite) : undefined;
        const run = async (update: boolean): Promise<{ stdout: string; stderr: string }> => {
          const cmd = buildAstGrepCommand({ pattern, lang, glob, rewrite, update, scope }, shq);
          // KEEP stderr (family tool-failure-streak, residual seam, ticket
          // 0c6a47de): this used to return stdout ONLY, so the one field that
          // says "the box died" was thrown away before anything could read it.
          const r = await ctx.execShell(cmd, ctx.worktree, AST_TIMEOUT_MS)
            .catch((err: any) => ({ stdout: `[command failed] ${err?.message ?? err}`, stderr: `[exec failed] ${err?.message ?? err}` }));
          return { stdout: String(r?.stdout ?? ''), stderr: String((r as any)?.stderr ?? '') };
        };
        // One classifier for both ast-grep legs. The `2>&1` on the built command
        // proves ast-grep's own diagnostics never reach exec's stderr — so a
        // stderr carrying a transport signature means the SHELL died, not the
        // pattern. But that argument does NOT prove the command never RAN, so the
        // timeout leg must not claim "changing the pattern/scope will not help":
        // a 90s ast-grep overrun is most plausibly a genuinely huge scope.
        // After `beforeWrite` the tree may be PARTIALLY rewritten, so the apply
        // leg must never say a bare "retry the SAME call".
        const infraOrNull = (stderr: string, leg: 'search' | 'apply'): string | null => {
          if (!isExecTransportFailure(stderr)) return null;
          const why = (stderr.match(/\[exit:[^\]]*\]/)?.[0] || stderr.split('\n').find(Boolean) || 'no output from ast-grep').slice(0, 300);
          const advice = leg === 'apply'
            ? 'Check the files with git_diff before re-running; the rewrite may have been applied in part.'
            : (/timed out/i.test(stderr)
              ? 'Retry the SAME call once; if it times out again the scope is too large — narrow it with path / glob.'
              : 'Retry the SAME call; changing the pattern/scope will not help.');
          return `[INFRA] Tool ${name} failed: ast-grep never ran (${why}) — the session shell died before npx ast-grep could start (container/exec unavailable), so this is NOT a bad pattern and NOT a "no matches" verdict. ${advice} If it persists, run_command is available.`;
        };
        // The search — or the rewrite's DRY RUN (same command minus --update-all).
        const searched = await run(false);
        const out = searched.stdout;
        const searchInfra = infraOrNull(searched.stderr, 'search');
        if (searchInfra) return searchInfra;
        // An npm/registry outage is INFRASTRUCTURE too, not the lane's pattern:
        // the command fetches @ast-grep/cli through npx on a cold cache, so a
        // DNS/registry hiccup would otherwise convict the model for the box's
        // network — the same harm, different trigger.
        const unavailable = astGrepUnavailableReason(out);
        if (unavailable) return `[INFRA] Tool ${name} failed: ast-grep is unavailable in this container (${unavailable}) — that is the box's npm/registry access, not your pattern. Retry the SAME call; if it persists, fall back to grep${isRewrite ? ' + edit_file' : ''}.`;
        const res = parseAstGrepOutput(out);
        if (!res.parsed) {
          // RESIDUAL SEAM of the tool-failure-streak family (2026-11-03, ticket
          // 0c6a47de): the grep branch was taught to name a dead shell as INFRA
          // (PR #2390), but THIS branch still rendered the same transport death
          // as a bare `no output from ast-grep`, which reads as a bad pattern and
          // is charged to the model by the derail breaker — so the lane rewrites
          // a VALID pattern three times and auto-files the mishap that IS the
          // ticket. Unlike grep there is no unconditional pipeline sentinel here
          // (the ast-grep command ends `2>&1`), so empty output alone is NOT
          // proof — and a genuinely silent ast-grep keeps the old text and still
          // counts (handled by the infraOrNull call above, which returns null).
          const detail = out.trim().slice(-400);
          if (!detail) return `Tool ${name} failed: no output from ast-grep — this is NOT a "no matches" verdict (ast-grep's exit code is not an error signal). Re-run the SAME call once; if it repeats, use grep${isRewrite ? ' + edit_file' : ''} rather than rewriting the pattern.`;
          return `Tool ${name} failed: ${detail}`;
        }
        if (!isRewrite) return cap(renderAstMatches(res));
        if (!res.matches.length) return `(no matches — nothing rewritten)${res.notes.length ? `\n${res.notes.map((n) => `[ast-grep] ${n}`).join('\n')}` : ''}`;
        const files = uniqueFiles(res.matches);
        if (files.length > AST_REWRITE_MAX_FILES) return `Tool ast_rewrite failed: the pattern matches ${res.matches.length} places in ${files.length} files (cap ${AST_REWRITE_MAX_FILES}) — narrow the scope with path / glob and rewrite in slices.`;
        // Checkpoint every file BEFORE the apply — rewind_to_step undoes the rewrite like any edit.
        for (const f of files) await ctx.checkpoints?.beforeWrite(f, path.join(ctx.worktree, f));
        const appliedRun = await run(true);
        // The SAME defect one line below the search fix: without this, a dead
        // shell during `--update-all` yields applied === '' → the "no Applied N
        // changes line" refusal below, which is ALSO failure-shaped and so counts
        // against the model. Three of those is the streak this work exists to
        // prevent. Classified with apply-specific advice: beforeWrite has already
        // run, so the tree may be PARTIALLY rewritten.
        const applyInfra = infraOrNull(appliedRun.stderr, 'apply');
        if (applyInfra) return applyInfra;
        const applied = appliedRun.stdout;
        const unavailableLate = astGrepUnavailableReason(applied);
        if (unavailableLate) return `[INFRA] Tool ast_rewrite failed: ast-grep became unavailable between the dry run and the apply (${unavailableLate}) — that is the box's npm/registry access, not your pattern; nothing was changed, so re-run.`;
        const n = parseAppliedChanges(applied);
        if (n === null) return `Tool ast_rewrite failed: the apply step reported no "Applied N changes" line — check the files with git_diff before trusting the tree:\n${applied.trim().slice(-400)}`;
        const hooks = await loadRepoHooks(ctx.worktree);
        const hookNotes: string[] = [];
        for (const f of files) {
          ctx.emit('file_changed', { path: f, action: 'edit' });
          ctx.diagnostics?.noteEdit(f);
        }
        for (const f of files.slice(0, 10)) {
          const note = await runPostEditHooks(ctx.execShell, ctx.worktree, hooks, f, ctx.sessionId).catch(() => '');
          if (note) hookNotes.push(note);
        }
        const shown = res.matches.slice(0, 60).map((m) => `${m.file}:${m.line}  ${(m.lines || m.text).replace(/\s+/g, ' ').trim().slice(0, 140)}  →  ${String(m.replacement ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
        const more = res.matches.length > 60 ? `\n…+${res.matches.length - 60} more` : '';
        return cap(`Rewrote ${n} change(s) across ${files.length} file(s) (dry run matched ${res.matches.length}):\n${shown.join('\n')}${more}\nAn AST rewrite preserves syntax, not necessarily semantics — read the changed spots or run verify before committing. rewind_to_step undoes it.${hookNotes.length ? `\n${hookNotes.join('\n')}` : ''}`);
      }

      case 'rewind_to_step': {
        // Working-tree checkpoints (harness roadmap item 7): top-level coding
        // runs only (agent.ts wires ctx.checkpoints); a worker or a disabled
        // run gets an honest note, never a fake receipt.
        if (!ctx.checkpoints) return 'Checkpoints are not available in this run (nested worker or chat mode). Revert by re-reading and re-editing the files.';
        if (args?.step === undefined || args?.step === null || args?.step === '') {
          return renderCheckpointIndex(ctx.checkpoints.list(), ctx.checkpoints.currentStep, ctx.checkpoints.isFull);
        }
        const r = await ctx.checkpoints.rewindTo(Number(args.step));
        for (const f of r.restored) { ctx.emit('file_changed', { path: f, action: 'write' }); ctx.diagnostics?.noteEdit(f); }
        for (const f of r.deleted) ctx.emit('file_changed', { path: f, action: 'delete' });
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.EDIT_CHECKPOINT_REWIND, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
          value: r.restored.length + r.deleted.length,
          meta: { step: r.step, restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length, nothing: r.nothing, reason: String(args?.reason ?? '').slice(0, 200) },
        });
        return renderRewindResult(r);
      }

      case 'write_file': {
        // Root-path guard (ticket d559ea0f, 2026-10-27) — see rootPathRefusal.
        const wpRoot = rootPathRefusal('write_file', ctx.worktree, String(args.path || ''));
        if (wpRoot) return wpRoot;
        const abs = await resolveRealInsideForWrite(ctx.worktree, String(args.path || ''));
        const content = String(args.content ?? '');
        await ctx.checkpoints?.beforeWrite(String(args.path || ''), abs); // snapshot BEFORE the write; never throws
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, 'utf8');
        } catch (err: any) {
          if (!isPermissionError(err) || !(await healNodeAccess(ctx, abs))) throw err;
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, 'utf8');
        }
        ctx.emit('file_changed', { path: args.path, action: 'write' });
        ctx.diagnostics?.noteEdit(String(args.path || ''));
        const lines = content.length ? content.split('\n') : [];
        const preview = lines.length && lines.length <= 20
          ? `\n+++ ${args.path}\n${lines.map(l => `+${l}`).join('\n')}` : '';
        // Repo-level postEdit hooks (harness roadmap item 2): the project's own
        // format/lint-fix commands, run deterministically; reported, never blocking.
        const writeHookNote = await runPostEditHooks(ctx.execShell, ctx.worktree, await loadRepoHooks(ctx.worktree), String(args.path || ''), ctx.sessionId).catch(() => '');
        return `Wrote ${args.path} (${content.length} bytes, ${lines.length} lines).${preview}${writeHookNote ? `\n${writeHookNote}` : ''}`;
      }

      case 'edit_file': {
        // edit targets an EXISTING file — resolveRealInside blocks editing
        // through a symlink whose target sits outside the worktree.
        // Root-path guard FIRST (ticket d559ea0f, 2026-10-27) — a missing/
        // empty/'.' path resolves to the worktree root: name the missing
        // argument instead of surfacing the root directory's raw EISDIR.
        // An explicit sub-directory path keeps the pinned raw-EISDIR
        // contract (ticket 8e900af9).
        const epRoot = rootPathRefusal('edit_file', ctx.worktree, String(args.path || ''));
        if (epRoot) return epRoot;
        const abs = await resolveRealInside(ctx.worktree, String(args.path || ''));
        const cur = await fs.readFile(abs, 'utf8');
        await ctx.checkpoints?.beforeWrite(String(args.path || ''), abs, cur); // snapshot the pre-edit content; never throws
        const oldStr = String(args.old_string ?? '');
        const count = cur.split(oldStr).length - 1;
        // Miss diagnostics (tool-failure-streak CLASS fix, tickets efcdcbca +
        // bb77c6ad, 2026-10-22): the bare one-liner told the model THAT it
        // missed, never WHY — a stale quote became a 3× guessing streak. The
        // hint rides a bracketed tail so the failure markers keep their
        // full-envelope anchoring; EDIT_FILE_MISS_DIAGNOSTICS_DISABLED=1
        // restores the byte-exact pre-hint envelopes from box env.
        if (count === 0) {
          const hint = process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED === '1' ? '' : editFileMissDiagnostic(cur, oldStr);
          return `old_string not found in ${args.path}. Read the file and match exactly.${hint ? ` [edit_file hint: ${clipEditFileHint(hint)}]` : ''}`;
        }
        if (count > 1) {
          const hint = process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED === '1' ? '' : editFileMultiDiagnostic(cur, oldStr);
          return `old_string appears ${count}× in ${args.path} — it must be unique. Add surrounding context.${hint ? ` [edit_file hint: ${clipEditFileHint(hint)}]` : ''}`;
        }
        const newStr = String(args.new_string ?? '');
        // Replacement-function form: a string second arg makes String.replace
        // interpret dollar-patterns in newStr (dollar-ampersand = the match,
        // dollar-backtick = pre-match head, dollar-quote = post-match tail) — so
        // a new_string containing dollar-quote silently re-appends the whole file
        // tail while returning a clean-looking diff (feedback b6013de0:
        // fleet-state.md doubled 208 to 416 lines). The function form inserts
        // newStr LITERALLY.
        const next = cur.replace(oldStr, () => newStr);
        try {
          await fs.writeFile(abs, next, 'utf8');
        } catch (err: any) {
          if (!isPermissionError(err) || !(await healNodeAccess(ctx, abs))) throw err;
          await fs.writeFile(abs, next, 'utf8');
        }
        ctx.emit('file_changed', { path: args.path, action: 'edit' });
        ctx.diagnostics?.noteEdit(String(args.path || ''));
        const editHookNote = await runPostEditHooks(ctx.execShell, ctx.worktree, await loadRepoHooks(ctx.worktree), String(args.path || ''), ctx.sessionId).catch(() => '');
        // Emit a compact +/- hunk so the UI can show git-style diff colors.
        const clip = (s: string) => { const l = s.split('\n'); return l.length > 16 ? [...l.slice(0, 15), `… (+${l.length - 15} more lines)`] : l; };
        const hunk = [
          `--- ${args.path}`, `+++ ${args.path}`,
          ...clip(oldStr).map(l => `-${l}`),
          ...clip(newStr).map(l => `+${l}`),
        ].join('\n');
        return `Edited ${args.path}\n${hunk}${editHookNote ? `\n${editHookNote}` : ''}`;
      }

      case 'run_command': {
        const command = String(args.command || '');
        if (!command.trim()) return 'No command provided.';
        // CREDENTIAL NAME NEAR-MISS GUARD (ticket aa6b6da2): a misspelled env-var
        // name reads as EMPTY — byte-indistinguishable from a credential that was
        // never injected. In the incident a lane read AWS_*_DIGIBOPERATOR /
        // _DIGIBYOPERATOR (two different typos of the stored label DIGBYOPERATOR)
        // across ~70 invocations and concluded the injection was flaky; it had
        // never failed. The platform knows the injected names, so it disambiguates
        // HERE — a notice appended to the command's own result, never blocking it.
        // Names only; values never enter this path. Kill switch below (house
        // parser — reviewer F6: raw truthiness would disable on '0'/'false').
        // Computed AFTER the refusals below (reviewer F4: a refused command never
        // ran, so it must not mint an observed strike) — see the call site.
        // WORKSPACE-SCOPE GUARD (audit 2026-10-06 T7-7, workspace-path-guard.ts):
        // where this shell can see the WHOLE workspace volume (the shared dev
        // container / a whole-volume fallback container), a command naming
        // another session's worktree / another project's mirror is refused
        // before it runs. Kill switch RUN_COMMAND_WORKSPACE_GUARD_DISABLED=1.
        {
          const scopeRefusal = await workspaceScopeRefusal(ctx, command, 'run_command');
          if (scopeRefusal) return scopeRefusal;
        }
        // ANSWER-KEY GUARD (2026-10-03, opt-in ANSWER_KEY_GUARD=1): a command
        // whose TEXT names a deny-listed benchmark answer-key URL / host path is
        // refused before anything executes; `akPost` withholds the output of a
        // REMOTE fetch that carries a benchmark canary (a command that only
        // reads local files is never touched — answer-key-guard.ts).
        {
          const akPre = answerKeyCommandPre(command);
          if (akPre) {
            recordAnswerKeyBlock(ctx, akPre);
            return answerKeyCommandMessage(akPre);
          }
        }
        const akPost = (out: string): string => {
          const b = answerKeyCommandPost(command, out);
          if (!b) return out;
          recordAnswerKeyBlock(ctx, b);
          return answerKeyCommandMessage(b);
        };
        // Repo-level preCommand hooks (harness roadmap item 2): the PROJECT's own
        // forbidden command shapes from its .digby/config.json — the platform
        // adds no rule of its own here (gate flip 2026-09-11).
        {
          const repoBlock = preCommandBlock(await loadRepoHooks(ctx.worktree), command);
          if (repoBlock) {
            recordLoopMetric({ kind: LOOP_METRIC_KINDS.REPO_HOOK, sessionId: ctx.sessionId, meta: { kind: 'preCommand', blocked: true, command: command.slice(0, 160) } });
            return repoBlock;
          }
        }
        // Publish-intent interception (v1#27). Gate flip 2026-09-11 (owner:
        // full steam): OBSERVE-ONLY — a publish-shaped command earns the
        // `[publish-intent notice]` line after the status banner + a
        // GUARD_STRIKE loop metric, and EXECUTES on machine and user runs alike
        // (15/15 live refusals were owner-approved merges, own-branch pushes or
        // text/GET false positives). The ONE hard refusal left is the
        // credential-persisting `git remote … x-access-token` shape on machine
        // runs. Opt-in RUN_COMMAND_PUSH_GUARD_ENFORCE=1 restores the machine
        // refusal envelope for every pattern. The refusal LEADS with
        // "[command REFUSED" so the receipt extractor records ok:false.
        let publishWarn = '';
        // Detection is unconditional (gate flip 2026-09-11 retired the
        // RUN_COMMAND_PUSH_GUARD_DISABLED kill-switch: it also switched off the
        // kept x-access-token credential refusal).
        {
          const intent = detectPublishIntent(command);
          if (intent) {
            const machine = !ctx.userTurnAt;
            const enforce = process.env.RUN_COMMAND_PUSH_GUARD_ENFORCE === '1';
            if (machine && (intent.hardRefuse || enforce)) {
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                meta: { seam: 'run_command_publish', state: 'refused', matched: intent.what, machine, hardRefuse: intent.hardRefuse },
              });
              return `[command REFUSED — publish guard] NOTHING was executed.\n` + JSON.stringify({
                ok: false,
                reason: 'run_command_publish_guard',
                matched: intent.what,
                message: intent.hardRefuse
                  ? `This machine-triggered run tried to persist a credential in a git remote ("${intent.what}"). Credential persistence is never allowed unattended.`
                  : `This machine-triggered run tried to publish/merge via raw shell ("${intent.what}"). Raw-shell pushes/merges bypass the base-branch guard, the ancestry push verdict, CI observation, and the receipts the harness uses to verify your claims — so unattended runs must publish through the gated tools.`,
                useInstead: intent.redirect,
              }, null, 1);
            }
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: { seam: 'run_command_publish', state: 'observed', matched: intent.what, machine },
            });
            publishWarn = `[publish-intent notice] this command looks like "${intent.what}" via raw shell, which bypasses Digby's publish gates (base-branch guard, ancestry verdict, CI observation, receipts). Prefer the gated tools: git_push / open_pull_request.\n`;
          }
        }
        // CREDENTIAL NAME NEAR-MISS GUARD (ticket aa6b6da2) — computed HERE, after
        // every hard refusal above (reviewer F4: a refused command never ran, so
        // it must not mint an observed strike). Kill switch uses the house
        // parser (reviewer F6: raw truthiness would disable on '0'/'false').
        const credMisses = ctx.credentialEnvNames && !credentialNameGuardDisabled()
          ? credentialNearMisses(command, ctx.credentialEnvNames)
          : [];
        const credNameMissNotice = credMisses.length ? credentialNearMissNotice(credMisses) : '';
        if (credMisses.length) {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
            // state 'observed' — nothing is refused or withheld; the containment
            // ladder weighs this seam at 0.5 (ANNOTATION_ONLY_SEAMS, reviewer F3:
            // a false-positive storm must never ladder a lane on its own weight).
            meta: { seam: 'run_command_credential_name', state: 'observed', names: credMisses.slice(0, 4).map((m) => m.used) },
          });
        }
        // SELF-STARTED MONITOR (auto mode): run through the background-process
        // rail FROM THE START, then wait up to the foreground window for exit.
        // A long command is thus promoted seamlessly — the ONE process keeps
        // running and nothing is ever killed mid-flight or re-run from scratch
        // (a killed docker-exec/bash timeout can orphan live children while a
        // blind restart would race a second copy over the same worktree, and
        // non-idempotent commands like migrations must never re-execute).
        // Ticket e663964f: the message must spell out that the rail NEVER
        // kills the process (the 300s figure is only this wait's window) and
        // that a later non-zero exit (e.g. 124, the GNU timeout(1) signature)
        // came from the command ITSELF (its own timeout wrapper / watchdog) —
        // a probe died mid-window because the old wording read as a no-kill
        // GUARANTEE, so the agent misread the command's own exit code as a
        // harness kill.
        if (ctx.permissionMode === 'auto') {
          const started = await startBackgroundProcess(ctx.execShell, ctx.sessionId, {
            command, name: `cmd: ${command.slice(0, 40)}`, cwd: ctx.worktree,
          }).catch(() => null);
          if (started && !started.error) {
            const w = await waitForProcessOutput(ctx.execShell, ctx.sessionId, started.handle,
              { timeoutSec: Math.round(CMD_TIMEOUT_MS / 1000) - 5 }, ctx.worktree);
            if (w.outcome === 'exited') {
              const r = await readProcessOutput(ctx.execShell, ctx.sessionId, started.handle, { sinceOffset: 0 }, ctx.worktree);
              releaseHandle(ctx.sessionId, started.handle);
              // 2026-08-30 harness audit: failure used to ride as a ONE-LINE
              // tail suffix ([exit: N]) after up to 20k of early output — a
              // failing `gh pr merge` could visually read as success, and a
              // weak model narrating over the result missed the suffix. Lead
              // with an unmistakable status banner instead; keep the tail
              // suffix for the receipt parser's back-compat.
              const failed = w.exitCode != null && w.exitCode !== '0';
              const banner = failed ? `[command FAILED — exit ${w.exitCode}]\n` : '[command OK]\n';
              const exitNote = failed ? `\n[exit: ${w.exitCode}]` : '';
              // publishWarn then the notice ride AFTER the banner; the exit
              // marker stays the LAST line (reviewer F2 — the documented
              // exit-marker-tail contract: learnings-index EXIT_MARKER_TAIL_RE
              // anchors the non-zero marker at $, so nothing may follow it).
              return cap(akPost(banner + publishWarn + credNameMissNotice + (r.chunk.trim() || '(no output)') + exitNote));
            }
            if (w.outcome === 'not_found') {
              // Ticket e3f24291: the launch looked fine but the wait lost the
              // process's ground truth (worktree/container vanished mid-wait)
              // — never claim it "KEEPS RUNNING".
              releaseHandle(ctx.sessionId, started.handle);
              return cap(`[command failed] ${w.detail}${credNameMissNotice}`);
            }
            const r = await readProcessOutput(ctx.execShell, ctx.sessionId, started.handle, { sinceOffset: 0 }, ctx.worktree)
              .catch(() => ({ chunk: '' } as any));
            ctx.emit('progress', { message: `Long command promoted to a background monitor (${started.name})`, stage: 'monitor' });
            ctx.emit('process_update', { processes: processSnapshot(ctx.sessionId) });
            return cap(akPost(`[SELF-STARTED MONITOR] The command is still running after ${Math.round(CMD_TIMEOUT_MS / 1000)}s. It was started on the background rail, so it KEEPS RUNNING — the rail never kills it and never re-runs it; the ${Math.round(CMD_TIMEOUT_MS / 1000)}s above is only how long this call WAITED before handing it to the monitor, not a kill deadline. If it later exits non-zero — e.g. 124, the GNU timeout(1) signature — that exit came from the command itself (its own timeout wrapper / watchdog), not from this rail. Handle: "${started.handle}". Monitor it: wait_for_process_output(handle:"${started.handle}", log_match:"<success/error marker>") blocks until done; read_process_output(handle:"${started.handle}") peeks. Do NOT re-run the command.\n${publishWarn ? `\n${publishWarn}` : ''}${credNameMissNotice ? `\n${credNameMissNotice.trimStart()}` : ''}\n--- output so far ---\n${(r.chunk || '(none yet)').slice(-3000)}`));
          }
          // Background rail unavailable (handle cap, shell hiccup) — fall through.
        }
        const { stdout, stderr } = await ctx.execShell(command, ctx.worktree, CMD_TIMEOUT_MS);
        // Same banner contract as the auto path (2026-08-30 audit): the exec
        // wrappers append [exit: N] on stderr — cap() tail-cuts at 60k, so the
        // verdict must LEAD or a long output buries it (and the exit marker).
        // The exit marker stays the LAST line here too (reviewer F2).
        const exitMatch = (stderr || '').match(/\[exit: (\d+)\]/);
        const failed = !!exitMatch && exitMatch[1] !== '0';
        const out = [stdout, stderr.replace(/\[exit: \d+\]\s*$/, '')].filter(Boolean).join('\n').trim();
        const exitTail = failed ? `\n[exit: ${exitMatch![1]}]` : (exitMatch ? `\n[exit: 0]` : '');
        return cap(akPost((failed ? `[command FAILED — exit ${exitMatch![1]}]\n` : '[command OK]\n') + publishWarn + credNameMissNotice + (out || '(no output)') + exitTail));
      }

      case 'git_status': {
        const { stdout } = await git(['status', '--porcelain=v1', '--branch'], ctx.worktree);
        return cap(stdout.trim() || '(clean)');
      }

      case 'git_diff': {
        const gitArgs = ['diff'];
        if (args.path) gitArgs.push('--', String(args.path));
        const { stdout } = await git(gitArgs, ctx.worktree);
        return cap(stdout.trim() || '(no uncommitted changes)');
      }

      case 'git_log': {
        // Read-only history for roles with no shell (explorer/reviewer). Reject
        // flag-shaped rev/path so a leading '-' can't inject git options.
        const rev = String(args.rev || 'HEAD');
        const scopePath = args.path ? String(args.path) : '';
        if (rev.startsWith('-') || scopePath.startsWith('-')) return 'Invalid rev/path (must not start with "-").';
        const max = Math.min(100, Math.max(1, Number(args.max) || 30));
        // One line per commit: short-sha, date (b3a35131 — dating a regression
        // window used to require the GitHub API), subject.
        const gitArgs = ['log', '--no-color', '--date=short', '--pretty=format:%h %ad %s', '-n', String(max), rev];
        if (scopePath) gitArgs.push('--', scopePath);
        try {
          const { stdout } = await git(gitArgs, ctx.worktree);
          // b3a35131: in a SHALLOW worktree (a shallow project mirror — an ops
          // re-clone/disk-prune re-seed) history silently stops at the grafted
          // boundary, whose whole-tree diff makes path-scoped results collapse
          // to one unrelated-looking commit. Say so explicitly instead of
          // letting the agent read a truncated result as the full truth.
          let shallowNote = '';
          try {
            const { stdout: isShallow } = await git(['rev-parse', '--is-shallow-repository'], ctx.worktree);
            if (isShallow.trim() === 'true') {
              const { stdout: count } = await git(['rev-list', '--count', rev], ctx.worktree)
                .catch(() => ({ stdout: '?', stderr: '' }));
              shallowNote =
                `\n[note: this worktree's git history is SHALLOW — only ~${String(count).trim()} commit(s) reachable from ${rev} are stored locally. ` +
                `Older history (including older per-file history) is missing locally, so "no commits before X" here does NOT mean none exist — ` +
                `use the github_* tools / GitHub API for older history until the project mirror is re-healed.]`;
            }
          } catch { /* best-effort — a failed probe never breaks git_log */ }
          return cap((stdout.trim() || '(no commits)') + shallowNote);
        } catch (e: any) {
          return `git log failed: ${cap((e.stderr?.toString() || e.message || '').trim())}`;
        }
      }

      case 'git_show': {
        // Read-only blob read for roles with no shell (ticket 460806c6): PR-branch
        // files live in the local object store even when the worktree has a
        // different ref checked out — read_file can't see them, git show can.
        // Same option-injection guard as git_log: a leading '-' on the combined
        // "ref:path" arg could smuggle git options (e.g. --output=<file> writes).
        const ref = String(args.ref || 'HEAD');
        const blobPath = args.path ? String(args.path) : '';
        if (!blobPath) return 'path is required (repo-relative file to read, e.g. { ref: "pr-branch", path: "src/foo.ts" }).';
        if (ref.startsWith('-') || blobPath.startsWith('-')) return 'Invalid ref/path (must not start with "-").';
        try {
          const { stdout } = await git(['show', `${ref}:${blobPath}`], ctx.worktree);
          if (stdout.includes('\u0000')) return `(binary file at ${ref}:${blobPath} — not shown)`;
          return cap(stdout.trimEnd() || `(empty file at ${ref}:${blobPath})`);
        } catch (e: any) {
          return `git show failed: ${cap((e.stderr?.toString() || e.message || '').trim())}`;
        }
      }

      case 'check_ci': {
        // v1#28a: READ the remote CI verdict for a sha (default: the last sha
        // this session pushed — from the durable git_push receipts — else HEAD).
        // Auth = the session's own GitHub OAuth token (ctx.getGithubToken →
        // github/token-manager getValidToken), same as every publish tool.
        if (ctx.provider !== 'github' || !ctx.repoUrl) return 'check_ci is only available for GitHub projects.';
        // ── Isolation boundary (ticket c75b5f34) ──────────────────────────────
        // Read-side twin: a non-prod instance never reads CI state from the
        // production repo. Keyed on the NORMALIZED target (review F1's
        // trailing-slash class) and checked BEFORE the owner/repo parse, so
        // an unparseable PROD spelling still refuses with the boundary text
        // rather than a generic parse error. Prod is a no-op.
        if (ctx.repoUrl && !repoTargetAllowed(ctx.repoUrl)) return isolationRefusal(ctx.repoUrl);
        const or = parseOwnerRepo(ctx.repoUrl);
        if (!or) return 'Could not parse owner/repo from the project URL.';
        const token = ctx.getGithubToken ? await ctx.getGithubToken() : null;
        if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations.';
        let sha = String(args.sha || '').trim();
        if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) return `Invalid sha "${sha}" — pass 7-40 hex characters, or omit it to use the last pushed sha.`;
        let sessionPushedSha = false; // did THIS session push the sha we're checking?
        try {
          const { getRecentChatReceipts } = await import('./run-receipts.service');
          const receipts = await getRecentChatReceipts(ctx.sessionId);
          const pushShas = receipts
            .filter(r => r.tool === 'git_push' && typeof r.ids?.sha === 'string' && r.ids.sha)
            .map(r => String(r.ids.sha));
          if (!sha && pushShas.length) sha = pushShas[pushShas.length - 1];
          sessionPushedSha = !!sha && pushShas.some(p => p === sha || p.startsWith(sha) || sha.startsWith(p));
        } catch { /* receipts are best-effort — fall through to HEAD */ }
        if (!sha) {
          try { sha = (await git(['rev-parse', 'HEAD'], ctx.worktree)).stdout.trim(); } catch { /* below */ }
          if (!sha) return 'No sha to check: this session has no recorded push and HEAD is unreadable — pass a sha explicitly.';
        }
        const { fetchCiStatus, renderCiStatus, emitCiFailed } = await import('./ci-status');
        try {
          const ci = await fetchCiStatus(token, or.owner, or.repo, sha);
          // ci_failed hook event (v1#28c) — only for shas THIS session pushed
          // (per-lane work signal; a failure on someone else's sha is not ours).
          if (ci.state === 'failure' && sessionPushedSha) emitCiFailed(ctx.sessionId, sha, ci.failing);
          const doneNote = ci.state === 'failure'
            ? '\nThe pushed work is NOT done: read the failing checks, fix, commit, and push again (or report the red CI honestly).'
            : ci.state === 'pending'
              ? '\nChecks are still running — re-check before claiming the work is done.'
              : '';
          return `${renderCiStatus(sha, ci)}${doneNote}`;
        } catch (err: any) {
          const status = err?.response?.status;
          return `check_ci failed: ${status ? `GitHub answered ${status}` : String(err?.message || 'error').slice(0, 200)} for sha ${sha.slice(0, 12)} — the commit may not be on the remote yet (push first), or the token lacks repo access.`;
        }
      }

      case 'await_condition': {
        // MERGE-INTENT-AWAIT (2026-10-20) — see await-condition.ts. Blocks ≤ 600 s
        // harness-side (deadline-shielded), then registers a condition wake and
        // asks the loop to end the run (ctx.requestEndTurn). Never throws.
        const { executeAwaitCondition } = await import('./await-condition');
        return executeAwaitCondition({
          sessionId: ctx.sessionId, userId: ctx.userId, runId: ctx.runId ?? null,
          repoUrl: ctx.repoUrl, provider: ctx.provider,
          getGithubToken: ctx.getGithubToken, onShieldedWait: ctx.onShieldedWait, requestEndTurn: ctx.requestEndTurn,
        }, args);
      }

      case 'merge_pull_request': {
        // Self-merge (owner directive 2026-09-09) — see self-merge.service.ts.
        const sm = await import('./self-merge.service');
        if (sm.selfMergeDisabled()) {
          return 'merge_pull_request is disabled (SELF_MERGE_DISABLED=1) — open the PR with open_pull_request and let the owner merge it.';
        }
        const pullNumber = Number(args.pullNumber);
        if (!Number.isInteger(pullNumber) || pullNumber <= 0) return 'Pass pullNumber (a positive integer).';
        let owner: string; let repo: string;
        const repoArg = String(args.repo || '').trim();
        if (repoArg) {
          const m = repoArg.match(/^([\w.-]+)\/([\w.-]+)$/);
          if (!m) return `Invalid repo "${repoArg}" — pass "owner/name".`;
          owner = m[1]; repo = m[2];
        } else {
          // Isolation boundary (c75b5f34, review F1's class): the normalized
          // check runs BEFORE the parse — a trailing-slash prod spelling must
          // refuse with the boundary text, not a generic "no repo" error.
          if (ctx.repoUrl && !repoTargetAllowed(ctx.repoUrl)) return isolationRefusal(ctx.repoUrl);
          const or = ctx.repoUrl ? parseOwnerRepo(ctx.repoUrl) : null;
          if (!or) return 'No repo to merge into: pass repo:"owner/name" or run this in a GitHub project session.';
          owner = or.owner; repo = or.repo;
        }
        const slug = `${owner}/${repo}`;
        // ── Isolation boundary (ticket c75b5f34) ─────────────────────────────
        // A NON-PROD instance (DIGBY_INSTANCE != prod) may never merge into the
        // PRODUCTION repo. Hard fail — returned to the model as the tool result
        // (no exception, no silent prod read). This is the write-side twin of
        // the resolver guard: even with a connected GitHub token that CAN write
        // example-org/crossmodel, the merge is refused here.
        if (!repoTargetAllowed(slug)) {
          return isolationRefusal(slug);
        }
        const token = ctx.getGithubToken ? await ctx.getGithubToken() : null;
        if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations.';
        const machineTriggered = !ctx.userTurnAt;
        // Per-project policy: crossmodel always on; else a HUMAN-set project
        // OFF is honored and everything else is ON (gate flip 2026-09-11). The
        // former 'ask' branch (inference judge + ask-once owner card) was deleted
        // 2026-09-28 — it had no production use since the flip.
        const policy = await sm.resolveSelfMergePolicy({ repo: slug, projectId: ctx.projectId ?? null, userId: ctx.userId });
        if (policy.policy === 'off') {
          return `Self-merge is OFF for this project (source: ${policy.source}${policy.why ? ` — ${policy.why}` : ''}). Ask the owner to merge PR #${pullNumber}, or to enable self-merge for the project.`;
        }
        // Gate engine — fresh evidence.
        const api = sm.defaultGithubApi(token);
        const firstGateAt = new Date();
        let verdict = await sm.evaluateMergeGates({ api, owner, repo, pullNumber, sessionId: ctx.sessionId });
        // MERGE-INTENT-AWAIT review fix: an update-branch THIS call asked for
        // (G1 'behind') — carried through the WAIT-ONCE re-gate, whose verdict
        // no longer names it, so a queued merge still tells the lane to pull.
        let updateBranch: { from: string; at: Date } | null = !verdict.ok && verdict.branchUpdatedFrom ? { from: verdict.branchUpdatedFrom, at: firstGateAt } : null;
        let prev = await sm.readAttempt(ctx.sessionId, slug, pullNumber);
        // WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27): a TIMING-class
        // failure — CI still running on the head, the merge API answering 405
        // "in progress" or a 5xx — is waited out ONCE, harness-side, and the
        // gates re-run one time before the failure is declared to the model
        // (131 ci-pending + 39 merge_api bounces / 14 d each cost a model retry
        // turn; 180/194 bounced PRs merged later, avg 7 min). Bounded
        // (self-merge.service mergeWaitOnceMs: min(2 × repo CI p50, 10 min)),
        // one wait per PR head (attempt record `waitedHeadSha`), one per call,
        // ≤ MERGE_WAIT_MAX_CONCURRENT per process, and the wait leaves the run
        // deadline through ctx.onShieldedWait (the awaitApproval idiom). Every
        // error inside the wait path falls through to today's bounce.
        let waitTrail = '';
        let waitMeta: Record<string, unknown> = {};
        const waitOnce = async (kind: import('./self-merge.service').MergeWaitKind, headSha: string | undefined): Promise<boolean> => {
          try {
            if (waitMeta.waitKind) return false; // one wait per tool call
            if (headSha && prev.waitedHeadSha === headSha) return false; // one wait per PR head
            if (!sm.tryAcquireMergeWaitSlot()) return false; // worker-slot cap — bounce as today
            try {
              const p50 = kind === 'ci_pending' ? await sm.repoCiP50Ms(slug) : null;
              const ms = sm.mergeWaitOnceMs(p50, kind);
              const t0 = Date.now();
              await sm.mergeWaitSleep(ms);
              const waitedMs = Date.now() - t0;
              try { ctx.onShieldedWait?.(waitedMs); } catch { /* the deadline shield is best-effort */ }
              prev = { ...prev, ...(headSha ? { waitedHeadSha: headSha } : {}) };
              await sm.writeAttempt(ctx.sessionId, slug, pullNumber, prev).catch(() => {});
              waitMeta = { waitKind: kind, waitedMs, ...(p50 != null ? { ciP50Ms: p50 } : {}) };
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.MERGE_WAIT_ONCE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                meta: { kind, waitedMs, repo: slug, pullNumber, ...(headSha ? { headSha } : {}), ...(p50 != null ? { ciP50Ms: p50 } : {}) },
              });
              waitTrail = `\n[harness waited ${Math.round(waitedMs / 1000)}s once for ${kind} (deadline-shielded) and re-ran the gates before this verdict]`;
              return true;
            } finally { sm.releaseMergeWaitSlot(); }
          } catch { return false; }
        };
        if (!verdict.ok) {
          const kind = sm.classifyMergeWait({ failure: verdict });
          if (kind && await waitOnce(kind, verdict.headSha)) {
            const regateAt = new Date();
            verdict = await sm.evaluateMergeGates({ api, owner, repo, pullNumber, sessionId: ctx.sessionId });
            if (!verdict.ok && verdict.branchUpdatedFrom) updateBranch = { from: verdict.branchUpdatedFrom, at: regateAt };
          }
        }
        if (!verdict.ok) {
          const headMeta = verdict.headSha ? { headSha: verdict.headSha } : {};
          // MERGE-INTENT-AWAIT (2026-10-20, merge-intent.ts): a TIMING-class
          // failure still standing after the one wait is QUEUED, not handed
          // back — the harness holds a merge intent, the merge-intents cron
          // re-runs every gate on this exact head and merges at green, and the
          // lane is woken once with the outcome. Fail-open: a registration
          // error (or the cap) bounces exactly as before. Kill switch
          // MERGE_INTENT_QUEUE_DISABLED=1.
          const queued = await queueMergeIntent(ctx, { owner, repo, pullNumber, mergeMethod: args.mergeMethod, failure: verdict, updateBranch, waitTrail, waitMeta });
          if (queued) return queued;
          const unchanged = sm.nothingChanged(prev, null, { gate: verdict.gate, evidenceHash: verdict.evidenceHash });
          if (unchanged) {
            return `MERGE BLOCKED (gate ${verdict.gate}) — NOTHING CHANGED since your last attempt: same gate, same evidence. Do not retry until you change something (fix the cause, push a new sha, or the world moves).\ncause: ${verdict.cause}\nevidence: ${verdict.evidence}\nfix: ${verdict.suggestedFix}${waitTrail}`;
          }
          const cycles = (prev.cycles ?? 0) + 1;
          await sm.writeAttempt(ctx.sessionId, slug, pullNumber, {
            lastGate: verdict.gate, lastEvidenceHash: verdict.evidenceHash, cycles, cardFiled: prev.cardFiled,
            ...(prev.waitedHeadSha ? { waitedHeadSha: prev.waitedHeadSha } : {}),
          });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
            meta: { gate: verdict.gate, cause: verdict.cause.slice(0, 160), repo: slug, pullNumber, cycles, ...headMeta, ...waitMeta },
          });
          await sm.recordMergeLearning(ctx.projectId ?? null, `PR ${slug}#${pullNumber} gate ${verdict.gate} failed: ${verdict.cause} | fix: ${verdict.suggestedFix}`);
          // Gate flip 2026-09-11 (owner: full steam): the circuit breaker no
          // longer files an owner card (its ONE firing was a G3 environmental
          // false positive answered 'STALE' after the lane self-resolved). It
          // records ONE breaker-flagged merge_gate_failure metric — the Fleet
          // Supervisor's telemetry — and keeps the once-only `cardFiled`
          // bookkeeping so the breaker still trips exactly once per PR. Opt-in
          // SELF_MERGE_BREAKER_CARD_ENABLED=1 restores the owner card.
          let breakerNote = '';
          if (cycles >= sm.selfMergeMaxCycles() && !prev.cardFiled) {
            try {
              if (process.env.SELF_MERGE_BREAKER_CARD_ENABLED === '1') {
                const { flagOwnerQuestion } = await import('../platform/owner-questions');
                await flagOwnerQuestion({
                  chatId: ctx.sessionId, userId: ctx.userId, machineTriggered,
                  question: `Self-merge circuit breaker: PR ${slug}#${pullNumber} has failed gate "${verdict.gate}" ${cycles} evidence-distinct times — a human look is needed.`,
                  context: `Latest cause: ${verdict.cause}\nEvidence: ${verdict.evidence.slice(0, 400)}\nEach failure and its suggested fix is in the project's self-merge learnings.`,
                });
                breakerNote = `\nCIRCUIT BREAKER: ${cycles} evidence-distinct failures on this gate — ONE owner card is now filed; keep working the cause but expect the owner to weigh in.`;
              } else {
                recordLoopMetric({
                  kind: LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                  meta: { gate: verdict.gate, cycles, breaker: true, repo: slug, pr: pullNumber, ...headMeta },
                });
                breakerNote = `\nCIRCUIT BREAKER: ${cycles} evidence-distinct failures on this gate — recorded as a breaker metric for the Fleet Supervisor (no owner card is filed); keep working the cause.`;
              }
              await sm.writeAttempt(ctx.sessionId, slug, pullNumber, { lastGate: verdict.gate, lastEvidenceHash: verdict.evidenceHash, cycles, cardFiled: true, ...(prev.waitedHeadSha ? { waitedHeadSha: prev.waitedHeadSha } : {}) });
            } catch { /* breaker notice is best-effort */ }
          }
          return `MERGE BLOCKED (gate ${verdict.gate}, attempt ${cycles}) — this is your next work item, not a dead end.\ncause: ${verdict.cause}\nevidence: ${verdict.evidence}\nfix: ${verdict.suggestedFix}${breakerNote}${waitTrail}\nRetry merge_pull_request after you changed something — an identical retry is refused.`;
        }
        if (verdict.alreadyMerged) {
          await sm.clearAttempt(ctx.sessionId, slug, pullNumber);
          await clearQueuedMergeIntent(owner, repo, pullNumber, ctx.sessionId, 'already_merged');
          return `PR ${slug}#${pullNumber} is ALREADY merged (merge sha ${verdict.headSha.slice(0, 12)}) — nothing to do. Never re-claim this as a fresh merge.`;
        }
        // All gates green — merge, then CONFIRM merged:true before reporting.
        const mergeMethod = ['squash', 'merge', 'rebase'].includes(String(args.mergeMethod)) ? String(args.mergeMethod) : 'squash';
        let put = await api.put(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
          merge_method: mergeMethod,
          sha: verdict.headSha, // refuse a race: merge exactly the sha the gates saw
        });
        if (put.status !== 200 || put.data?.merged !== true) {
          // WAIT-ONCE on the API classes (405 "merge already in progress" / 5xx):
          // one bounded wait, the gates re-run (they may gate a moved head), ONE more PUT.
          const apiKind = sm.classifyMergeWait({ apiStatus: put.status, apiMessage: String(put.data?.message ?? '') });
          if (apiKind && await waitOnce(apiKind, verdict.headSha)) {
            const again = await sm.evaluateMergeGates({ api, owner, repo, pullNumber, sessionId: ctx.sessionId });
            if (again.ok && again.alreadyMerged) {
              await sm.clearAttempt(ctx.sessionId, slug, pullNumber);
              return `PR ${slug}#${pullNumber} is ALREADY merged (merge sha ${again.headSha.slice(0, 12)}) — nothing to do. Never re-claim this as a fresh merge.${waitTrail}`;
            }
            if (again.ok) {
              verdict = again;
              put = await api.put(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, { merge_method: mergeMethod, sha: again.headSha });
            }
          }
        }
        if (put.status !== 200 || put.data?.merged !== true) {
          const cause = `merge API answered ${put.status}: ${String(put.data?.message ?? '').slice(0, 200)}`;
          // MERGE-INTENT-AWAIT: a still-transient merge-API answer (405 "in
          // progress" / 5xx) after the one wait is queued like a CI wait.
          const apiKindNow = sm.classifyMergeWait({ apiStatus: put.status, apiMessage: String(put.data?.message ?? '') });
          if (apiKindNow) {
            const queuedApi = await queueMergeIntent(ctx, {
              owner, repo, pullNumber, mergeMethod: args.mergeMethod, waitTrail, waitMeta, updateBranch,
              failure: { gate: 'merge_api', cause, headSha: verdict.headSha, transient: apiKindNow },
            });
            if (queuedApi) return queuedApi;
          }
          await sm.recordMergeLearning(ctx.projectId ?? null, `PR ${slug}#${pullNumber} merge attempt failed post-gates: ${cause}`);
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
            meta: { gate: 'merge_api', cause: cause.slice(0, 160), repo: slug, pullNumber, headSha: verdict.headSha, ...waitMeta },
          });
          return `MERGE FAILED at the API step (gates were green): ${cause}${waitTrail}\nRe-run merge_pull_request — the gates re-verify; if the head moved, they gate the new sha.`;
        }
        const confirm = await api.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`);
        if (confirm.data?.merged !== true) {
          return `MERGE UNCONFIRMED: the merge API answered 200 but a follow-up GET does not show merged:true yet — do NOT claim this merged. Re-check with a fresh GET before any claim.`;
        }
        const mergeSha = String(put.data?.sha ?? confirm.data?.merge_commit_sha ?? '');
        await sm.clearAttempt(ctx.sessionId, slug, pullNumber);
        await clearQueuedMergeIntent(owner, repo, pullNumber, ctx.sessionId, 'merged_by_tool');
        // Success telemetry — the counterpart of MERGE_GATE_FAILURE above, so
        // merge outcomes chart as a rate (cycles = prior gate-failure cycles
        // this merge burned through before landing).
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.MERGE_SUCCESS, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
          meta: { repo: slug, pullNumber, mergeSha, cycles: prev.cycles ?? 0, machineTriggered },
        });
        if (prev.lastGate) {
          await sm.recordMergeLearning(ctx.projectId ?? null, `PR ${slug}#${pullNumber} MERGED after earlier ${prev.lastGate} failures (cycles ${prev.cycles ?? 0}) — resolved by a changed head/evidence.`);
        }
        ctx.emit('pr_merged', { repo: slug, number: pullNumber, sha: mergeSha });
        // Head-branch cleanup (owner 2026-09-14): delete refs/heads/<head> once
        // merged:true is confirmed — same-repo head, never the default/base
        // branch; 404 = GitHub already did it. Best-effort: a failure warns
        // once inside the helper and never fails the merge result.
        // SELF_MERGE_KEEP_HEAD_BRANCH=1 keeps it.
        let headNote = '';
        try {
          const cleanup = await sm.deleteMergedHeadBranch({ api, owner, repo, pr: confirm.data });
          if (cleanup?.outcome === 'deleted') headNote = ` · head branch ${cleanup.branch} deleted`;
        } catch { /* best-effort — the merge stands */ }
        let ciSuffix = '';
        try {
          const or2 = { owner, repo };
          const { observeCiAfterPush } = await import('./ci-status');
          ciSuffix = await observeCiAfterPush({ token, owner: or2.owner, repo: or2.repo, sha: mergeSha, sessionId: ctx.sessionId });
        } catch { /* bounded observation is best-effort */ }
        // Artifact attribution stamp (todo 13dfa16d): the work item THIS merge
        // serves, at event time — the PR's head-branch name / the run's
        // in-progress plan step. Rides the result; the receipt parses it into
        // ids.todoId/ticketId; the wake ledger renders it. Best-effort,
        // additive-only — a stamp failure never breaks a confirmed merge.
        let mergeAttributionNote = '';
        try {
          const headRef = String(confirm.data?.head?.ref ?? '');
          mergeAttributionNote = await artifactAttributionStamp(ctx, { branch: headRef });
        } catch { /* best-effort — the merge stands */ }
        return `MERGED ${slug}#${pullNumber} (squash sha ${mergeSha.slice(0, 12)}) — confirmed merged:true by follow-up GET${headNote}${mergeAttributionNote}.\nGate evidence:\n- ${verdict.evidenceNotes.join('\n- ')}${ciSuffix}${waitTrail}`;
      }

      case 'git_push': {
        // Idempotent resume guard (audit #8): a resumed run's rewound tool turn
        // legitimately re-issues pushes whose prior attempt already executed
        // (at-least-once). When THIS run already holds an ok git_push receipt
        // for the SAME branch at the SAME sha as the current HEAD, there is
        // nothing new to push — no-op with an honest skip instead of
        // re-executing. Exact-identity matched and fail-open (run-idempotency):
        // new commits move HEAD, so a genuinely new push always executes.
        try {
          if (ctx.provider === 'github' && ctx.repoUrl && ctx.branch) {
            const headBranch = (await currentHeadBranch(ctx.worktree)) || ctx.branch;
            const headSha = (await git(['rev-parse', 'HEAD'], ctx.worktree)).stdout.trim();
            const { findPriorRunPushReceipt } = await import('./run-idempotency');
            const prior = headSha ? await findPriorRunPushReceipt(ctx.sessionId, headBranch, headSha) : null;
            if (prior) {
              return `[idempotent skip] already done in this run: Pushed ${headBranch} to GitHub — sha ${headSha} (receipt ${prior.id}). The remote branch already carries this exact commit; nothing new to push.`;
            }
          }
        } catch { /* the guard must never block a real push */ }
        const pushOut = await pushSessionBranch(ctx, { allowBase: args?.allowBase === true });
        // v1#28b: ONE bounded post-push CI observation (wait ~30s, query once)
        // — the result carries a first CI verdict so "pushed ⇒ done" claims
        // meet reality immediately. Failure also emits the ci_failed hook
        // event. Opt-in: PUSH_CI_OBSERVE_ENABLED=1 (default OFF since the
        // 2026-09-11 gate flip — observeCiAfterPush returns '' immediately).
        if (pushOut.startsWith('Pushed') && ctx.repoUrl) {
          const or = parseOwnerRepo(ctx.repoUrl);
          const shaMatch = pushOut.match(/\bsha ([0-9a-f]{7,40})\b/);
          if (or && shaMatch) {
            const { observeCiAfterPush } = await import('./ci-status');
            const suffix = await observeCiAfterPush({
              token: ctx.getGithubToken ? await ctx.getGithubToken().catch(() => null) : null,
              owner: or.owner, repo: or.repo, sha: shaMatch[1], sessionId: ctx.sessionId,
            });
            return pushOut + suffix;
          }
        }
        return pushOut;
      }

      case 'open_pull_request': {
        // Blank projects are upgraded to GitHub projects by pushSessionBranch
        // (private repo auto-created), so only a non-GitHub git remote refuses.
        if (!ctx.branch || ctx.provider === 'git') return 'Pull requests are only available for GitHub projects.';
        // ── Isolation boundary (ticket c75b5f34) ──────────────────────────────
        // A NON-PROD instance never opens a PR against the production repo —
        // covers the explicit-headBranch route that skips the push seam (the
        // normal route is already refused by pushSessionBranch's guard).
        if (ctx.repoUrl && !repoTargetAllowed(ctx.repoUrl)) {
          const iso = parseOwnerRepo(ctx.repoUrl);
          return isolationRefusal(iso ? `${iso.owner}/${iso.repo}` : ctx.repoUrl);
        }
        // ── PR GATE (P4): the agent must get the verify chain green before opening a
        // PR. A human clicking "Open PR" bypasses this. If the project has no verify
        // chain, there's nothing to gate on (honest — don't block what can't run).
        // An explicit headBranch arg names a branch the agent published
        // out-of-band (e.g. created via the GitHub API): the worktree push is
        // skipped entirely and the branch is verified to exist on the remote
        // before anything is opened. Validate its shape FIRST — before the
        // verify gate and any token/network work — so a bad name refuses with
        // no chain run and no network at all. Parsed ABOVE the gate (review
        // fix 2026-09-27) so the docs-only bypass can see a head that is not
        // the checkout it classifies.
        const explicitHead = String(args.headBranch || '').trim();
        // T2c (todo 9c89ab21): boarding support — an optional EXPLICIT base
        // branch (the active batch/<ts> train). When set, the PR is opened
        // against THAT branch instead of the repo default (verified to exist
        // on the remote first — a typo'd batch name must fail loudly, not
        // create a PR against a nonexistent base). Lanes boarding a train use
        // this OR `gh pr edit <n> --base <batch>` after the fact; the
        // merge-time gate redirects them here via suggestedFix.
        const requestedBase = String(args.baseBranch || '').trim();
        if (requestedBase && !isValidBranchName(requestedBase)) {
          return `Invalid baseBranch "${requestedBase}" — pass the exact remote branch name (e.g. batch/20261017T015348Z).`;
        }
        if (explicitHead && !isValidBranchName(explicitHead)) {
          return `Invalid headBranch "${explicitHead}" — not a legal git branch name. Nothing was opened.`;
        }
        let unverifiedNote = '';
        let gateNote = '';
        let prBodyNote = '';
        if (!ctx.prGateBypass) {
          const config = await readDigbyConfig(ctx.worktree);
          const chain = resolveVerifyChain(config);
          if (chain.length && loopConfig(config).gatePullRequest) {
            let vs = await getVerifyState(ctx.sessionId);
            // v1#29: the pass is keyed to the workspace CONTENT at verify time
            // (tree fingerprint; sha fallback). A commit of exactly-verified
            // content keeps the same tree and passes; any new edit or new
            // commit with different content invalidates the pass — no explicit
            // clearing by mutation tools needed. Legacy fingerprint-less states
            // (recorded before this deploy) pass unchanged (fail-open on
            // ABSENCE, fail-closed on MISMATCH).
            let stale = false;
            if (vs?.passed && (vs.tree || vs.sha)) {
              const now = await captureVerifyFingerprint(ctx.worktree);
              stale = now ? (vs.tree ? vs.tree !== now.tree : vs.sha !== now.sha) : false;
            }
            const needsVerify: 'unpassed' | 'stale' | null = !vs?.passed ? 'unpassed' : stale ? 'stale' : null;
            if (needsVerify) {
              // A5 (2026-09-27): a docs-only PR (every file the PR would carry
              // is under docs/ or *.md) skips the chain — the PR body carries
              // the "docs-only, unverified" note. Any git failure ⇒ not
              // docs-only (fail-safe).
              let docsOnly = false;
              // Review fix (2026-09-27, MEDIUM): the classification reads the
              // WORKTREE (branch vs merge-base ∪ dirty tree), but an explicit
              // headBranch that is NOT the checkout opens the PR from an
              // out-of-band remote branch the worktree says nothing about — a
              // docs-only checkout plus a code headBranch must neither bypass
              // verify nor stamp a false "docs-only" trailer on a code PR. Such
              // a head is never docs-only here: it falls through to auto-verify
              // / the plain refusal. A detached checkout counts as a mismatch.
              const headMismatch = !!explicitHead && explicitHead !== (await currentHeadBranch(ctx.worktree));
              if (!headMismatch) {
                const files = await listPrDiffFiles((a, cwd) => git(a, cwd, 15_000), ctx.worktree, ctx.baseBranch || config?.defaultBranch || 'main').catch(() => null);
                const verdict = classifyDocsOnly(files || []);
                if (files && verdict.docsOnly) {
                  docsOnly = true;
                  // `outcome:'observed'` is the fleet's observe-only key (strike
                  // adjudication reads meta.outcome); `state` stays for the A5
                  // readers. Both pr_gate_* seams are excluded from the
                  // same-seam alarm — they fire on every relieved PR by
                  // construction (review fix 2026-09-27).
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                    value: verdict.files.length,
                    meta: { seam: 'pr_gate_docs_only', state: 'observed', outcome: 'observed', reason: needsVerify, files: verdict.files.slice(0, 20) },
                  });
                  prBodyNote = docsOnlyPrBodyNote(verdict.files.length);
                  gateNote = `\nNOTE: docs-only diff (${verdict.files.length} file${verdict.files.length === 1 ? '' : 's'} under docs/ or *.md) — the verify gate was skipped and the PR body says so ("docs-only, unverified").`;
                }
              }
              if (!docsOnly) {
                // A5 (2026-09-27): instead of refusing and sending the lane
                // through verify → retry (three rounds), run the chain here
                // and open on green. A red chain still refuses, with the
                // failing stage's tail. (The release switch that restored the
                // plain refusal was retired by RSW-1 — the auto-verify arm is
                // unconditional; a lane that wants the old refusal just runs
                // `verify` itself first.)
                const why = needsVerify === 'stale'
                  ? `the recorded verify pass was STALE (workspace content changed since${vs?.sha ? ` commit ${String(vs.sha).slice(0, 12)}` : ''})`
                  : `the verify chain had not passed this session${vs?.failedStage ? ` (last failure: ${vs.failedStage})` : ''}`;
                // Review fix (2026-09-27, HIGH): the agent loop hard-aborts a
                // tool at TOOL_HARD_TIMEOUT_MS (15 min, agent.ts) WITHOUT
                // cancelling it. An auto-verify that outlived that timer
                // (verify-slot queue wait + up to 3 × 300–600 s of chain) would
                // let this call go on to push and open a PR AFTER the model was
                // told the tool was aborted — an unowned PR the lane cannot see
                // and a 422 on the re-issue. So the chain is bounded here,
                // safely under that timer (PR_GATE_AUTO_VERIFY_DEADLINE_MS,
                // default 12 min, clamped ≤ 14 min): on expiry the tool refuses
                // and points at `verify` — nothing is pushed or opened. The
                // chain keeps running in the background and records its result
                // (the pre-A5 `verify` behaviour), so the retry after a green
                // finish passes the gate without re-running it.
                const deadlineMs = prGateAutoVerifyDeadlineMs();
                const raced = await withDeadline(runVerifyChainForTool(ctx, config, chain), deadlineMs);
                if (raced.timedOut) {
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                    meta: { seam: 'pr_gate_auto_verify', state: 'observed', outcome: 'observed', reason: needsVerify, verdict: 'timeout', timedOut: true, deadlineMs, headMismatch },
                  });
                  return `PR blocked: ${why}, so open_pull_request ran the chain itself (${chain.map(c => c.key).join(' → ')}) — it did not finish within ${Math.round(deadlineMs / 1000)}s (the verify-slot queue and/or the chain are still running in the background and will record their result). Run \`verify\` (it waits for the chain) and call open_pull_request again once it is green; nothing was pushed or opened.`;
                }
                const { result, summary } = raced.value;
                recordLoopMetric({
                  kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                  meta: { seam: 'pr_gate_auto_verify', state: 'observed', outcome: 'observed', reason: needsVerify, verdict: result.passed ? 'green' : 'red', passed: result.passed, unverified: result.unverified, failedStage: result.failedStage, headMismatch },
                });
                if (!result.passed) {
                  const failed = result.stages[result.stages.length - 1];
                  return `PR blocked: ${why}, so open_pull_request ran the chain itself (${chain.map(c => c.key).join(' → ')}) — FAILED at "${result.failedStage}": ${summary}\n--- ${failed?.key || result.failedStage} output tail ---\n${failed?.outputTail || ''}\nFix the failure and call open_pull_request again (it re-runs verify itself); nothing was pushed or opened.`;
                }
                // Shortfall fix (2026-10-04, nightly S1): the green note must be
                // QUALIFIED when headMismatch — the chain above verified the
                // WORKTREE checkout (ctx.worktree), but an explicit headBranch
                // ≠ the checkout opens the PR from an out-of-band remote head
                // the chain says nothing about. An unqualified "[auto-verify] …
                // green" trailer would attest a head the chain never saw (the
                // same false-attestation class the 2026-09-27 docs-only fix
                // closed). Qualify the note and mirror the docs-only PR-body
                // principle: an honest trailer on the PR itself, never a false
                // one. Do NOT refuse — the MEDIUM fix deliberately lets the
                // mismatched head fall through to the chain.
                if (headMismatch) {
                  prBodyNote = prHeadMismatchBodyNote(explicitHead!);
                  gateNote = `\nNOTE: verify chain green (${summary}), but it ran against the WORKTREE checkout — this PR opens from out-of-band head ${explicitHead}, which the chain did not verify. The PR body says so; CI on the PR is the verification of record.`;
                } else {
                  gateNote = `\n[auto-verify] ${why}; open_pull_request ran it itself: ${summary}.`;
                }
                vs = await getVerifyState(ctx.sessionId);
              }
            }
            // v1#30: an UNVERIFIED "pass" (stage tools not installed) proves
            // nothing about the code. Gate flip 2026-09-11 (owner: full steam):
            // no longer a block — a lane cannot install a missing container
            // tool and looped 7 verify rounds against this wall; the PR's CI is
            // the verification of record. The honest note rides the PR result
            // and a GUARD_STRIKE metric (seam 'unverified_pr_gate', state
            // 'observed') is recorded. Opt-in UNVERIFIED_GATE_ENFORCE=1
            // restores the block (the old UNVERIFIED_GATE_DISABLED is retired).
            if (vs?.unverified) {
              if (process.env.UNVERIFIED_GATE_ENFORCE === '1') {
                return `PR blocked: the last verify was UNVERIFIED — one or more stages were skipped because their tool is not installed, so the chain never fully ran and proves nothing. Install the missing tool (or fix the command in .digby/config.json) and get a REAL green verify before opening the PR.`;
              }
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
                meta: { seam: 'unverified_pr_gate', state: 'observed' },
              });
              unverifiedNote = vs.deferred
                ? '\nNOTE: the last verify was DEFERRED — the container was under memory pressure from peer lanes (neither a pass nor a failure); CI on the PR is the verification of record.'
                : '\nNOTE: the last verify was UNVERIFIED — stage(s) skipped because their tool is not installed; CI on the PR is the verification of record.';
            }
          }
        }
        // (explicitHead — the out-of-band headBranch — was parsed and
        // validated ABOVE the verify gate.)
        const token = ctx.getGithubToken ? await ctx.getGithubToken() : null;
        if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations.';
        // Resolve the PR head ONCE, up front, and use it for BOTH the push and
        // the PR create — ticket c7bf1e66: the head used to be re-read from the
        // worktree's CURRENT checkout AFTER the push, so a checkout flip (or a
        // detached/stale checkout) between the two reads opened the PR on a
        // branch that never received this lane's commits (prod: PR #629 on
        // canada-quant/tt-rd with head digby/gdn-window-a instead of the lane's
        // fold branch).
        const prHead = explicitHead || (await currentHeadBranch(ctx.worktree)) || ctx.branch;
        // Idempotent resume guard (audit #8): a resumed run re-issuing
        // open_pull_request after its prior attempt already opened the PR used
        // to re-push and then 422 ("A pull request already exists"). When THIS
        // run holds an ok open_pull_request receipt AND GitHub confirms that
        // PR's head is the branch this call would open one for, no-op honestly.
        // Same-run receipts only + head-verified + fail-open (run-idempotency)
        // — a new feature branch's PR is genuinely new work and still executes.
        // audit 2026-10-08 W2-5: the skip needs the matched PR OPEN + unmerged
        // (run-idempotency prStateWarrantsSkip); a merged / closed match opens
        // a follow-up PR and says so. PR_IDEMPOTENCY_OPEN_ONLY_DISABLED=1.
        let followUpPrNote = '';
        try {
          const or0 = ctx.repoUrl ? parseOwnerRepo(ctx.repoUrl) : null;
          if (or0) {
            const idem: any = await import('./run-idempotency');
            const prior = await idem.findPriorRunPrReceipt(ctx.sessionId);
            if (prior) {
              const prNumber = Number(prior.ids.prNumber);
              // Older partial mocks export only prHeadMatchesReceipt — fall back to it.
              const st = typeof idem.prReceiptHeadState === 'function'
                ? await idem.prReceiptHeadState(token, or0.owner, or0.repo, prNumber, prHead)
                : undefined;
              const skip = st !== undefined && typeof idem.prStateWarrantsSkip === 'function'
                ? idem.prStateWarrantsSkip(st)
                : await idem.prHeadMatchesReceipt(token, or0.owner, or0.repo, prNumber, prHead);
              if (skip) {
                return `[idempotent skip] already done in this run: Opened PR #${prior.ids.prNumber}: ${prior.ids.url} (receipt ${prior.id}; head ${prHead}). If the branch has new commits, git_push them — they appear on the existing PR.`;
              }
              if (st && st.headMatches) {
                followUpPrNote = ` (follow-up: this run's PR #${prior.ids.prNumber} on ${prHead} is already ${st.merged ? 'MERGED' : 'closed'} — its new commits need this new PR.)`;
                recordLoopMetric({ kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined, meta: { seam: 'pr_idempotency_followup', state: 'observed', outcome: 'observed', prNumber, merged: st.merged, prState: st.state } });
              }
            }
          }
        } catch { /* the guard must never block a real PR */ }
        let or: { owner: string; repo: string } | null;
        let explicitHeadSha = '';
        if (explicitHead) {
          // Out-of-band branch: verify it exists on the remote instead of
          // pushing the worktree checkout (which may carry unrelated work).
          or = ctx.repoUrl ? parseOwnerRepo(ctx.repoUrl) : null;
          if (!or) return 'Could not parse owner/repo from the project URL.';
          const refCheck = await verifyRemoteBranchExists(token, or.owner, or.repo, explicitHead);
          if (typeof refCheck === 'string') return refCheck;
          explicitHeadSha = refCheck.sha;
        } else {
          // Ensure the branch is on the remote first — for a blank project this
          // also auto-creates the private repo and fills ctx.repoUrl. The push
          // is pinned to the SAME resolved head (see above), so the published
          // branch and the PR head cannot diverge.
          const pushResult = await pushSessionBranch(ctx, { headBranch: prHead });
          if (!pushResult.startsWith('Pushed')) return pushResult;
          or = parseOwnerRepo(ctx.repoUrl || '');
          if (!or) return 'Could not parse owner/repo from the project URL.';
        }
        // T2c: resolve the PR base — an explicit baseBranch (verified on the
        // remote) wins; otherwise the session/project default. The compare +
        // create both use this so a boarding PR's diff shape is computed
        // against the batch branch, not main.
        let prBase = ctx.baseBranch || 'main';
        if (requestedBase && requestedBase !== prBase) {
          if (!or) return 'Could not parse owner/repo from the project URL.';
          const baseCheck = await verifyRemoteBranchExists(token, or.owner, or.repo, requestedBase);
          if (typeof baseCheck === 'string') return baseCheck;
          prBase = requestedBase;
        }
        // ── PR DIFF SHAPE (tt-rd audit 2026-09-27, findings docs-churn-log-1/-2/-4):
        // ONE compare call (base...head) BEFORE the create, so the harness can
        // (a) stamp the result with a "[PR DIFF] …" line the receipt parses
        // (docs-only vs code, +/−, diff hash, first paths), (b) notice a
        // duplicate re-open (this chat already opened a PR with the SAME diff
        // hash inside 7 days and it is still open), (c) notice docs-only churn
        // (this PR only appends to a results/tracker file a prior docs-only PR
        // of this chat touched inside DOCS_ONLY_PR_BATCH_HOURS), and (d) notice
        // a results-log truncation. All observe-only and fail-open;
        // DOCS_ONLY_PR_ENFORCE=1 refuses (c) on MACHINE runs only.
        let prDiffTail = '';
        const prShape = await describePrDiff(ctx, { token, owner: or.owner, repo: or.repo, base: prBase, head: prHead }, {}, { allowBaseDrift: args.allowBaseDrift === true });
        if (prShape) {
          if (prShape.refusal) return prShape.refusal;
          prDiffTail = prShape.tail;
        }
        // ── DEPENDENCY ADVISORIES (2026-10-12 credential incident): look the
        // project's production npm dependencies up in OSV and surface any
        // critical/high advisory to the lane (tool result) and the owner (PR
        // body). Observe-only — the PR still opens; bounded, fail-open.
        // 4dbd09fa (2026-10-14): resolve the deps from the PUSHED PR HEAD TREE,
        // not the on-disk worktree — the lane's disk can be a stale or (on the
        // explicit-head path) entirely unrelated checkout, and PR #1488's body
        // reported a pre-#1453 dep set its head did not carry. The head sha is
        // the commit pushSessionBranch just published (normal path) or the
        // remote ref verified above (explicit-head path).
        let advisoryNotice = '';
        let advisoryBody = '';
        if (!dependencyAdvisoryCheckDisabled()) {
          let advisoryHeadSha = '';
          try {
            advisoryHeadSha = explicitHead
              ? explicitHeadSha
              : (await git(['rev-parse', 'HEAD'], ctx.worktree)).stdout.trim();
          } catch { /* best-effort — the scan falls back to the disk walk */ }
          // Explicit-head path: the head sha came from the GitHub API and may
          // not exist as a local object (the branch was created out-of-band).
          // Fetch it so the tree read cannot silently fall back to the lane's
          // UNRELATED on-disk checkout (4dbd09fa: the whole point is reporting
          // the PR's dependency state). Object already local → no fetch at
          // all. Bounded + fail-open.
          if (advisoryHeadSha && explicitHead && ctx.repoUrl && token) {
            try {
              await git(['cat-file', '-e', `${advisoryHeadSha}^{commit}`], ctx.worktree, 10_000);
            } catch {
              try {
                await execFileAsync('git', ['fetch', '-q', authedPushUrl(ctx.repoUrl, token), advisoryHeadSha], {
                  cwd: ctx.worktree, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
                  env: { PATH: process.env.PATH, HOME: ctx.worktree, GIT_TERMINAL_PROMPT: '0' },
                });
              } catch { /* fail-open: GitTreeIO probe fails → disk fallback */ }
            }
          }
          const advisories = await checkDependencyAdvisories(ctx.worktree, { ...(advisoryHeadSha ? { headRef: advisoryHeadSha } : {}) });
          advisoryNotice = renderAdvisoryNotice(advisories);
          advisoryBody = renderAdvisoryPrBody(advisories);
          if (advisories.findings.length || advisories.error) {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.DEPENDENCY_ADVISORY, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              value: advisories.findings.length,
              meta: {
                repo: `${or.owner}/${or.repo}`, manifests: advisories.manifests, packages: advisories.packages,
                // 4dbd09fa: which dependency state the report describes — the
                // PR head tree ('pr-head') or the worktree disk fallback
                // ('worktree'). The one-glance signal that would have exposed
                // the stale-disk false report on PR #1488.
                source: advisories.source ?? 'worktree',
                critical: advisories.findings.filter(f => f.severity === 'CRITICAL').length,
                high: advisories.findings.filter(f => f.severity === 'HIGH').length,
                findings: advisories.findings.slice(0, 20).map(f => ({ pkg: f.pkg, version: f.version, id: f.id, severity: f.severity, fixed: f.fixed })),
                ...(advisories.error ? { error: advisories.error } : {}),
              },
            });
          }
        }
        const created = await createPullRequestWithHeadCheck({
          token, owner: or.owner, repo: or.repo,
          title: String(args.title || `Digby Code: ${prHead}`),
          body: String(args.body || '') + prBodyNote + advisoryBody,
          base: prBase,
          head: prHead,
          sessionId: ctx.sessionId,
          runId: ctx.runId ?? undefined,
        });
        if (!created.ok) return created.message;
        ctx.emit('pr_opened', { url: created.url, number: created.number });
        // Artifact attribution stamp (todo 13dfa16d): the work item THIS PR
        // serves, at event time — leg (a) the branch name / PR body, leg (b)
        // the run's in-progress plan step. Rides the result; the receipt
        // parses it into ids.todoId/ticketId. Best-effort, additive-only.
        let prAttributionNote = '';
        try {
          prAttributionNote = await artifactAttributionStamp(ctx, { branch: prHead, body: String(args.body || '') });
        } catch { /* additive — never break a real PR result */ }
        let prResult = `Opened PR #${created.number}: ${created.url}${prAttributionNote}`;
        // T2c: boarding advisory — when a train is boarding and this PR targets
        // the default branch with a non-docs-only diff, append the redirect so
        // the lane learns BEFORE the merge gate refuses it. Observe-only (the
        // PR still opens — re-targeting is a later, deliberate act). The
        // classification here is advisory (worktree-based, the A5 idiom); the
        // AUTHORITATIVE classification is the merge gate's (remote diff).
        if (requestedBase === '') {
          try {
            const { getLiveBatchTrain, discoveryApiFromGithub, batchTrainGithubApi } = await import('./batch-train.service');
            const { classifyTrainDocsOnly } = await import('./batch-train');
            const trainApi = discoveryApiFromGithub(batchTrainGithubApi(token), or.owner, or.repo);
            const train = await getLiveBatchTrain(trainApi);
            if (train) {
              const files = await listPrDiffFiles((a, cwd) => git(a, cwd, 15_000), ctx.worktree, ctx.baseBranch || 'main').catch(() => null);
              const docsOnly = files ? classifyTrainDocsOnly(files).docsOnly : false;
              if (!docsOnly) {
                prResult += `\n\n[BATCH TRAIN ACTIVE] A batch train is boarding (${train.branch} @ ${String(train.sha).slice(0, 12)}). The merge_pull_request gate will REFUSE a code PR into main while it boards — re-target this PR onto the train branch: gh pr edit ${created.number} --base ${train.branch} (or open with baseBranch:"${train.branch}" next time), so the train-runner's merge carries it. docs-only PRs (.md, docs/**, .digby/**) may still merge straight to main.`;
              }
            }
          } catch { /* advisory — never break a real PR result */ }
        }
        // v1#28b: the same ONE bounded post-push CI observation as git_push,
        // on the pushed head sha. Skipped for the human "Open PR" button
        // (prGateBypass — a UI click must not hang ~30s on a poll).
        if (!ctx.prGateBypass) {
          try {
            // Explicit-head path: the worktree checkout is unrelated to the PR
            // branch — observe CI on the remote ref sha verified above instead
            // of the worktree HEAD (empty sha ⇒ skip; additive-only).
            const headSha = explicitHead
              ? explicitHeadSha
              : (await git(['rev-parse', 'HEAD'], ctx.worktree)).stdout.trim();
            if (headSha) {
              const { observeCiAfterPush } = await import('./ci-status');
              prResult += await observeCiAfterPush({
                token, owner: or.owner, repo: or.repo, sha: headSha, sessionId: ctx.sessionId,
              });
            }
          } catch { /* observation is additive — never break a real PR result */ }
        }
        return prResult + followUpPrNote + prDiffTail + gateNote + unverifiedNote + advisoryNotice;
      }

      case 'git_commit': {
        await git(['add', '-A'], ctx.worktree);
        // Block commits whose staged diff adds secret-shaped strings — private
        // repos get published later, and history rewrites are painful.
        if (!/\[allow-secrets\]/.test(String(args.message || ''))) {
          try {
            const { stdout: staged } = await git(['diff', '--cached', '--unified=0'], ctx.worktree);
            const hits = scanDiffForSecrets(staged);
            if (hits.length) {
              return `COMMIT BLOCKED — the staged changes appear to contain secrets: ${hits.join('; ')}. Remove them (use .env + .gitignore and reference via env vars, or add placeholders in a .env.example). If these are deliberate non-secret fixtures, re-run git_commit with "[allow-secrets]" in the message.`;
            }
          } catch { /* scan is best-effort — never turn a scan failure into a blocked commit */ }
        }
        // Shrink guard (I1): refuse commits that gut tracked files unless the
        // shrink is explicitly declared. Unlike the secret scan this is a HARD
        // gate — the incident class it kills ("merge resolved by emptying
        // files") is exactly the one a lane calls non-destructive.
        let shrinkAudit = '';
        let findings: ShrinkFinding[] = [];
        try {
          findings = await scanStagedShrink(ctx.worktree);
        } catch { /* scan machinery failure never blocks a commit (fail-open like the secret scan) */ }
        if (findings.length) {
          const allowShrink = args.allowShrink === true;
          const shrinkReason = String(args.shrinkReason || '').trim();
          if (!allowShrink || !shrinkReason) {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.MERGE_SIZE_GUARD,
              sessionId: ctx.sessionId,
              value: findings.length,
              meta: { allowShrink, files: findings.slice(0, 12).map(f => ({ file: f.file, reason: f.reason })) },
            });
            return JSON.stringify({
              ok: false,
              reason: 'shrink_guard',
              message: 'COMMIT REFUSED — the staged changes destructively shrink tracked files (this is how a botched merge "resolution" once left files at 0 bytes on main):',
              files: findings.map(f => ({
                file: f.file, reason: f.reason,
                beforeBytes: f.beforeBytes, afterBytes: f.afterBytes,
                beforeLines: f.beforeLines, afterLines: f.afterLines,
              })),
              instructions: 'Nothing was committed. Restore the gutted content (e.g. `git checkout HEAD -- <file>` via run_command, or resolve the merge properly) and re-run git_commit. Conflict markers must be resolved, never committed. ONLY if the shrink is genuinely intentional (deliberate rewrite/cleanup), re-call git_commit with allowShrink:true AND a non-empty shrinkReason explaining why — both are recorded in the receipt.',
            }, null, 1);
          }
          shrinkAudit = `\n[shrink allowed] reason: "${shrinkReason}" — ${findings.map(describeShrinkFinding).join('; ')}`;
        }
        try {
          const { stdout } = await git(['commit', '-m', String(args.message || 'Digby Code changes')], ctx.worktree);
          ctx.emit('git_committed', { message: args.message });
          return cap((stdout.trim() || 'Committed.') + shrinkAudit);
        } catch (e: any) {
          // Surface the real failure (e.g. "nothing to commit") instead of
          // swallowing it — the model must not believe a failed commit succeeded.
          const detail = (e.stdout?.toString() || e.stderr?.toString() || e.message || '').trim();
          return `git commit failed: ${cap(detail)}`;
        }
      }

      case 'update_plan': {
        // Strict input validation BEFORE any write (2026-09-30, TB 2.1 trace:
        // a `steps` array of numbers silently wiped the plan to zero steps).
        const checked = validatePlanUpdate(args);
        if (!checked.ok) return renderPlanValidationFailure(checked.problems);
        const planArgs = checked.update;
        const coercionNotes = checked.notes;
        const applied = await applyPlan(ctx.sessionId, ctx.worktree, planArgs);
        const plan = applied.plan;
        const warnings = coercionNotes.length ? [...coercionNotes, ...applied.warnings] : applied.warnings;
        ctx.emit('plan_update', { plan });
        // Session titles (2026-09-27): the newest in-progress step is the title's step half (charter lanes; best-effort).
        void import('../platform/session-titles').then((m) => m.refreshSessionTitle(ctx.sessionId, 'plan', { emit: ctx.emit })).catch(() => {});
        // audit 2026-10-08 W5-4 (lane-todos.ts): a plan step that NAMES one of this lane's todos (assigned, or an
        // unassigned todo of its charter goal) moves it on the board — a naming step started ⇒ in_progress. NEVER
        // done: a step that names a todo is not evidence its deliverable landed (mishap 260dd714 — a bookkeeping
        // "re-read the todos" step closed them); done is an explicit todo_update(done, evidence). Fire-and-forget.
        // LANE_TODO_PLAN_RECONCILE_DISABLED=1.
        void import('./lane-todos').then((m) => m.reconcileLaneTodosFromPlan({
          chatId: ctx.sessionId, userId: ctx.userId, runId: ctx.runId ?? null, plan,
          machineTriggered: ctx.machineTriggered === true || !ctx.userTurnAt,
        })).catch(() => {});
        const done = plan.steps.filter(s => s.status === 'completed').length;
        const lines = plan.steps.map(s => `  ${({ pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' } as any)[s.status]} ${s.id} ${s.text}`);
        return `Plan updated (${done}/${plan.steps.length} done)${warnings.length ? `\n${warnings.map(w => `NOTE: ${w}`).join('\n')}` : ''}\nGOAL: ${plan.goal || '(unset)'}\n${lines.join('\n')}`;
      }

      case 'search_memory': {
        const scope = args.scope === 'session' || args.scope === 'project' ? args.scope : 'all';
        // 2026-10-22 (fs-durable-memory): a SUPERVISOR chat searches its own
        // ledger mirror (chat scope) + the owner's distills of THIS chat (user
        // scope, ref-filtered) and never the 'chat' placeholder project — see
        // supervisor-search-scopes.ts. One row read; a read failure = not a supervisor (old search).
        const supervisorChat = supervisorSearchMemoryEligible({ sessionId: ctx.sessionId, userId: ctx.userId })
          ? (await import('../platform/supervisor-state.service').then((m) => m.supervisorChatFlag(ctx.sessionId)).catch(() => null)) === true
          : false;
        const memPlan = planSearchMemoryScopes({ sessionId: ctx.sessionId, projectId: ctx.projectId, userId: ctx.userId, supervisorChat });
        const memProjectId = memPlan.projectId;
        if (scope === 'project' && !memProjectId) {
          return 'Project-scope memory is unavailable in this context (no project) — retry with scope "session".';
        }
        // Per-user memory gate (owner 2026-09-14): the caller's userId scopes
        // every read — project memory only for projects this user owns or is
        // a (folder-inherited) member of; the knowledge-base blend only across
        // projects they OWN. Without it the project scope is dropped.
        const results = await searchMemory(ctx.sessionId, String(args.query || ''), 6, {
          scope,
          projectId: memProjectId,
          // Anonymous chat runs carry the sentinel 'anonymous' (chat-agent) — the
          // gated path would drop their own session scope as an unknown chat, so
          // pass no user (session-only, ungated) for them (EOD review 2026-09-14).
          userId: ctx.userId && ctx.userId !== 'anonymous' ? ctx.userId : undefined,
          sources: args.source ? [String(args.source)] : undefined,
          ...(ctx.projectMemoryIsolated ? { projectMemoryIsolated: true } : {}),
          // 2026-10-20 cold tier (memory/memory-archive.ts): ONLY this explicit tool tops up thin
          // results from rows the scope cap archived, labelled [archived]; injected blocks never do.
          includeArchive: true,
          // 2026-10-31 SAME-RUN RAW RECALL (goal 9ecd595e / todo 6fa816ee, WRP-1 defect D4): the
          // Polk County run stored its own SERP and then could not recall it in the SAME run —
          // this explicit tool is exactly the surface that must never say "not stored" for a row
          // it just wrote. Index read before the semantic ladder; raw rows returned (labelled) when
          // the ladder misses. Kill switch SAME_RUN_RAW_RECALL_DISABLED=1.
          sameRunRecall: true,
          ...(memPlan.chatScopeId ? { chatScopeId: memPlan.chatScopeId } : {}),
          ...(memPlan.conversationRef ? { conversationRef: memPlan.conversationRef } : {}),
        });
        // Retrieval observability (owner 2026-09-04): one row per call — the
        // shared executor sees orchestrator AND worker calls; value 0 charts
        // the empty-result rate. Fire-and-forget, never throws.
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.CODING_RETRIEVAL_HITS,
          sessionId: ctx.sessionId,
          value: results.length,
          meta: { tool: 'search_memory', scope, ...(args.source ? { source: String(args.source) } : {}), ...(memPlan.supervisor ? { supervisorScopes: true } : {}) },
        });
        // Honest degradation note: without a projectId, scope 'all' silently
        // covers only the session — say so instead of implying project
        // knowledge (learnings, code index) was searched and found empty.
        const noProjectNote = memPlan.supervisor
          ? supervisorSearchCoverageNote(memPlan, scope, args.source ? [String(args.source)] : undefined)
          : !memProjectId && scope === 'all'
          ? ' (NOTE: project-scope knowledge — knowledge-base documents, decisions, learnings, code index — was NOT searched: this run has no project context; only session findings were covered)'
          : ctx.projectMemoryIsolated && scope !== 'session'
            // userSpaceChatIsolated (2026-10-20): say what was skipped so the model neither retries nor reads [] as "searched, nothing there".
            ? ' (NOTE: this is an ungrouped chat — the shared decisions / learnings / code index of the hidden personal workspace were NOT searched, by design; only this chat\'s findings and the user\'s uploaded files were)'
            : '';
        if (!results.length) return `No stored memory matched${noProjectNote} (nothing offloaded/indexed yet, or no match). Try different keywords or a different scope/source; to gather NEW material, delegate an explorer/web_researcher or read the files directly.`;
        const memAnswer = results.map((r, i) => `[${i + 1}] (${r.source}${r.ref ? ` · ${r.ref}` : ''})\n${cap(r.content)}`).join('\n\n') + noProjectNote;
        // ── SAA-1.4 PHASE 1 (todo 2ef2b254): the `search_memory` chain surface ──
        // A memory hit carries a `ref` but not the ids of the objects BEHIND it, so
        // walking from a finding to its authoring chat is another SEARCH. Hops here
        // are deliberately the cheap, TRUTHFUL ones: this chat itself (a real id the
        // caller already has) plus up to three receipt refs the results actually
        // returned. Nothing is invented — a ref that is not a plain id shape
        // (`[A-Za-z0-9_-]+`) is skipped rather than mangled into a hop, because a
        // hop that cannot be pasted into a read tool is worse than no hop. When
        // there is no session id and no safe ref, `hops` is empty and the plan is
        // an empty observe plan: `applied:false` ⇒ renderRecallChain returns
        // `memAnswer` BY REFERENCE, so a default box is byte-identical to before.
        let memAnswerOut = memAnswer;
        try {
          const recall = await import('../platform/chain-of-recall');
          const hops: Array<{ kind: 'run' | 'goal' | 'todo' | 'receipt' | 'chat' | 'schedule'; id: string }> = [];
          if (ctx.sessionId) hops.push({ kind: 'chat', id: String(ctx.sessionId) });
          for (const r of results.slice(0, 3)) {
            const ref = typeof r?.ref === 'string' ? r.ref.trim() : '';
            if (ref && /^[A-Za-z0-9_-]+$/.test(ref)) hops.push({ kind: 'receipt', id: ref });
          }
          const chain = recall.planRecallChain({ surface: 'search_memory', hops });
          memAnswerOut = recall.renderRecallChain(memAnswer, chain);
          // Telemetry last, and only when there is something to say (the leaf
          // returns null when the switch is off or the chain is empty, so an idle
          // recall writes no row). `recordLoopMetric` is already imported statically
          // at the top of this module and is fire-and-forget / fail-open itself.
          const rememberMeta = recall.recallChainMetricMeta(chain, { tool: 'search_memory' });
          if (rememberMeta) {
            try {
              recordLoopMetric({ kind: LOOP_METRIC_KINDS.CHAIN_OF_RECALL_OBSERVE, sessionId: ctx.sessionId, value: 1, meta: rememberMeta });
            } catch { /* telemetry never blocks a recall */ }
          }
        } catch { /* chain-of-recall: never blocks a recall */ }
        // Review 2026-10-23: a supervisor's recall of owner words follows the
        // chat-read rule (get_chat_messages / get_run_receipts, D4) — a MACHINE
        // wake reads it redacted, an owner turn reads its own words verbatim.
        // SAA-1.4: redaction runs on the RENDERED text (memAnswerOut), i.e. AFTER
        // the `next:` line is appended — a hop id must go through the same secret
        // scan as the prose it rides, never around it.
        return memPlan.supervisor
          ? redactChatReadSecrets(memAnswerOut, { machineRun: ctx.machineTriggered === true || !ctx.userTurnAt }).text
          : memAnswerOut;
      }

      case 'search_code_semantic': {
        // fs-code-knowledge (2026-10-22): an ungrouped chat ('chat' sentinel) or a
        // never-indexed project holds NO code index — say so instead of a fake empty
        // search; a supervisor chat searches the platform repo's project index; a miss
        // names only the probes this caller has (code-search.ts).
        if (!codeSearchChatScopeRefuseDisabled()) {
          const surface: 'chat' | 'coding' = ctx.agentSurface === 'chat' ? 'chat' : 'coding';
          const r = await runCodeSemanticSearch({
            // An ungrouped chat filed in the hidden personal workspace is the same
            // no-index scope as the 'chat' sentinel (search_memory skips that
            // workspace's code index by design too).
            projectId: ctx.projectMemoryIsolated ? undefined : ctx.projectId,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            surface,
            hasTool: (n) => probeToolAvailable(n, { surface, allowedTools: ctx.allowedTools, integrationTool: isIntegrationTool }),
          }, String(args.query || ''), defaultCodeSearchDeps(), { k: 8, cap, freshness: !codeIndexWalkV2Disabled() });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.CODING_RETRIEVAL_HITS,
            sessionId: ctx.sessionId,
            value: r.hits,
            meta: { tool: 'search_code_semantic', scope: r.scope, ...(r.noIndex ? { noIndex: r.noIndex } : {}), ...(r.scope === 'platform' && r.searchedProjectId ? { searchedProjectId: r.searchedProjectId } : {}) },
          });
          return r.text;
        }
        if (!ctx.projectId) return 'Semantic code search is unavailable in this context (no project).';
        const hits = await searchCodeSemantic(ctx.projectId, String(args.query || ''), 8);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.CODING_RETRIEVAL_HITS,
          sessionId: ctx.sessionId,
          value: hits.length,
          meta: { tool: 'search_code_semantic' },
        });
        if (!hits.length) return 'No indexed code matched THIS phrasing. The index may still be building for this project (it syncs at run start), or the concept lives under different vocabulary — try once more with different words (what the code DOES), and use grep/glob for exact symbols meanwhile.';
        return hits.map((h, i) => `[${i + 1}] ${h.ref}\n${cap(h.content)}`).join('\n\n');
      }

      case 'web_pipe': {
        // ANSWER-KEY GUARD (2026-10-03, opt-in): a deny-listed query / url
        // refuses the whole call before any network access; inside the pipe,
        // SERP-derived targets are deny-filtered and a canary-carrying page is
        // dropped before it is embedded or digested (web-pipe.ts).
        if (answerKeyGuardEnabled()) {
          const pre = answerKeyArgsMatch('web_pipe', { query: args.query, urls: args.urls });
          if (pre) {
            const b: AnswerKeyBlock = { phase: 'pre', tool: 'web_pipe', label: pre.label, target: pre.target.slice(0, 200) };
            recordAnswerKeyBlock(ctx, b);
            return answerKeyBlockedMessage(b);
          }
        }
        const r = await runWebPipe(ctx.sessionId, {
          query: args.query ? String(args.query) : undefined,
          urls: Array.isArray(args.urls) ? args.urls.map(String) : undefined,
          focus: args.focus ? String(args.focus) : undefined,
        }, msg => ctx.emit('progress', { message: msg, stage: 'web_pipe' }), { onAnswerKeyBlock: b => recordAnswerKeyBlock(ctx, b) });
        // Stage timings (2026-10-20 real-user audit — web_pipe p50 69 s): where a call's time went, one row per call.
        if (r.timing) recordLoopMetric({ kind: LOOP_METRIC_KINDS.WEB_PIPE_TIMING, sessionId: ctx.sessionId, value: r.timing.totalMs, unit: 'ms', meta: r.timing });
        const srcLines = r.sources.map(s => `- ${s.title || s.url} (${s.url}) ${s.stored ? `— ${s.chars} chars ${r.storedChunks > 0 ? 'stored' : 'read'}` : `— ${s.note || 'unreadable'}`}`).join('\n');
        // Trailer honesty (owner 2026-09-04): only promise retrievability when
        // chunks actually landed — a failed store used to still claim it.
        // Attribution (owner 2026-09-08): name the Helper-seat model that wrote
        // the digest so "did the pipe use my custom model?" is answerable.
        return `${r.summary}\n\nSOURCES:\n${srcLines}\n${r.ok && r.storedChunks > 0 ? `\n${r.storedChunks} chunks embedded to session memory — use search_memory for detail beyond this digest.` : r.ok ? '\nNOTE: session-memory store failed — the digest above is all that was kept; re-run web_pipe if you need the full text later.' : ''}${r.model ? `\nDigest by ${r.model}.` : ''}`;
      }

      case 'youtube_pipe': {
        const r = await runYoutubePipe(ctx.sessionId, {
          query: args.query ? String(args.query) : undefined,
          urls: Array.isArray(args.urls) ? args.urls.map(String) : undefined,
          focus: args.focus ? String(args.focus) : undefined,
          stt: typeof args.stt === 'boolean' ? args.stt : undefined,
        }, msg => ctx.emit('progress', { message: msg, stage: 'youtube_pipe' }));
        const vidLines = r.videos.map(v => `- ${v.title || v.videoId} (${v.url}) ${v.method !== 'failed' ? `— ${v.chars} chars via ${v.method}${v.stored ? ' stored' : ''}` : '— no transcript'}`).join('\n');
        return `${r.summary}\n\nVIDEOS:\n${vidLines}\n${r.ok && r.storedChunks > 0 ? `\n${r.storedChunks} chunks embedded to session memory — use search_memory for detail beyond this digest.` : r.ok ? '\nNOTE: session-memory store failed — the digest above is all that was kept; re-run youtube_pipe if you need the transcripts later.' : ''}${r.model ? `\nDigest by ${r.model}.` : ''}`;
      }

      case 'verify': {
        // DW-2 (backlog 2026-10-02; FO f118): distinguish UNREADABLE config
        // from ABSENT config before answering. A mangled .digby/config.json
        // (truncated write, trailing comma, BOM) used to fall into the
        // "No verify chain configured" answer — indistinguishable from a repo
        // that never authored one. Here the answer names the file + error and
        // the observe-only loop_metrics row (kind verify_config_read_error)
        // records it for the audit. Fail-open: an observation failure never
        // changes the answer. Receipt contract unchanged (passed:false,
        // failedStage:null — no PASSED/FAILED/UNVERIFIED anchor).
        const configRead = await readDigbyConfigDetailed(ctx.worktree);
        const config = 'config' in configRead ? configRead.config : null;
        if ('readError' in configRead) {
          try {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.VERIFY_CONFIG_READ_ERROR, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: { projectId: ctx.projectId ?? null, seam: 'tool', error: configRead.readError },
            });
          } catch { /* observe-only */ }
          return `No verify chain could be read — .digby/config.json exists but is not readable/parseable (${configRead.readError}). Fix the file (often a truncated write or trailing comma) and re-run verify. Nothing is verified — report "unverified — config unreadable" rather than "verified".`;
        }
        const only = Array.isArray(args.only) && args.only.length ? args.only.map(String) : undefined;
        // Review fix (A4 follow-up): "the requested SUBSET has no stages" is not
        // "the project has no verify chain" — absence is judged on the
        // UNFILTERED chain, so `verify({only:['lint']})` on a typecheck+test
        // project never stamps the project-level marker / row.
        const fullChain = resolveVerifyChain(config);
        const chain = resolveVerifyChain(config, only);
        if (!fullChain.length) {
          // A4 (2026-09-27): the lane's own probe is not the chain — mark the
          // session + row it so the status card and telemetry say so
          // (observe-only; the receipt shape "No verify chain configured …" is
          // unchanged — run-receipts.ts parses passed:false/failedStage:null).
          try {
            const configPresent = !!config;
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.VERIFY_ABSENT, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined,
              meta: { projectId: ctx.projectId ?? null, reason: 'no_chain', seam: 'tool', configPresent },
            });
            await recordVerifyAbsent(ctx.sessionId, { seam: 'tool', configPresent });
          } catch { /* observe-only — the answer below is the tool's contract */ }
          return 'No verify chain configured (.digby/config.json has no runnable typecheck/lint/test commands). Nothing is verified — report "unverified — no verify chain" rather than "verified". If the project has real typecheck/lint/test commands, file the config ONCE: check your plan and the project\'s open PRs/branches for an existing .digby/config.json step first; only if none exists, add ONE plan step to create .digby/config.json with the real commands. If the project genuinely has no such commands (ops / config / docs repo), say "no verify chain applies: <reason>" in your final and add NO step — never invent a placeholder command (an always-green command is a hollow chain, worse than an honest "no chain").';
        }
        if (!chain.length) {
          // A configured project, but none of the requested `only` keys is a
          // configured stage: answer precisely (no marker, no row — the chain
          // exists) so the lane re-calls with the right keys. Reads as
          // passed:false / failedStage:null in run-receipts.ts (nothing ran).
          return `None of the requested verify stages (${(only || []).join(', ')}) is configured — configured stages: ${fullChain.map(c => c.key).join(', ')}. Nothing ran. Call verify without \`only\` (or with one of those keys) to run the chain.`;
        }
        const { result, summary } = await runVerifyChainForTool(ctx, config, chain);
        if (result.passed && result.unverified) {
          const deferredStages = result.stages.filter(s => s.deferred);
          if (deferredStages.length) {
            return `Verify DEFERRED: ${summary}\n${deferredStages[0].outputTail}\nThe verify chain did NOT run — this is neither a pass nor a failure. Do NOT edit code in response: re-run verify when peer load subsides (typically minutes). If your work is otherwise complete, report the deferral honestly instead of claiming a verified pass.`;
          }
          const skipped = result.stages.filter(s => s.skipped);
          const skippedKeys = skipped.map(s => s.key).join(', ');
          // Ticket 6a8dddd3: a bare "tool not installed" with zero diagnostics
          // sent sessions hunting for a phantom pre-command probe — the real
          // cause (e.g. a python wrapper whose /tmp payload the disk-pressure
          // cleanup had wiped, printing "No module named X") was invisible.
          // Show each skipped stage's command + output tail so the failure is
          // actionable, and name the wiped-payload pattern when it matches.
          const detail = skipped.map(s => {
            const out = s.outputTail.split('\n').slice(-6).join('\n').trim() || '(no output)';
            const wiped = /\bno module named\b/i.test(s.outputTail)
              ? '\nHint: the tool RAN but its Python package is missing — a pip --user/--target install under /tmp was likely wiped by the pre-exec disk-pressure cleanup (HOME=/tmp). Reinstall into $HOME/.local (preserved) or into the worktree, then re-run verify.'
              : '';
            return `--- ${s.key} skipped (${s.command}; exit ${s.exitCode}) ---\n${out}${wiped}`;
          }).join('\n');
          return `Verify UNVERIFIED: ${summary}\nStage(s) ${skippedKeys} could not run (tool not installed in this environment), so the chain did NOT fully execute — this is not a verified pass; the PR gate lets it through with an UNVERIFIED note (CI on the PR is the verification of record). Install the missing tool (or fix the command in .digby/config.json) and re-run verify if you can; if that is impossible here, report the reduced verification honestly instead of claiming a pass.\n${detail}`;
        }
        if (result.passed) return `Verify PASSED: ${summary}`;
        const failed = result.stages[result.stages.length - 1];
        // FAMILY tool-failure-streak (2026-11-03): the SAME infra/model confusion
        // as the grep branch, one seam over. verify.service.ts already CLASSIFIES
        // a diagnostics-free / wrapper-killed stage as `environmental` or
        // `terminated` and its own outputTail literally says "infra, NOT a code
        // failure" / "NOT a test verdict" — yet the tool rendered it as a bare
        // `Verify FAILED at …`, so it fed the derail streak exactly like a real
        // code red (member 744b2798: two typecheck "reds" whose only diagnostic
        // was "container … is not running"). Anchor it `[INFRA]` so the breaker
        // (looksLikeToolFailure) never counts infrastructure, and tell the lane
        // the truth: retry, do not go "fix" byte-identical code.
        if (failed && (failed.environmental || failed.terminated)) {
          // TICKET 91120212: a STAGE TIMEOUT must be answered BEFORE this
          // infra branch. A timeout kills the wrapper before it echoes
          // __DIGBY_EXIT__, so `terminated` is true and this branch used to fire
          // first — telling the lane "the stage did not produce a code verdict.
          // Do NOT edit code, tests or verify config" even though verify.service
          // had already classified it stageTimeout:true and REFUSED to call it
          // environmental (the T2e split). That text forbade the one sanctioned
          // remedy (`loop.perCommandTimeoutMs`) and the lane, obeying it, burned
          // four identical kills on a 329 s suite against a 300 s cap. A timeout
          // is a cap the lane may raise, not a dead box to retry.
          if (failed.stageTimeout) {
            return `Verify FAILED at "${result.failedStage}": ${summary}\n${stageTimeoutAdvice(killedAtMsFromTail(failed.outputTail))}\n--- ${failed.key} output tail ---\n${failed.outputTail}`;
          }
          const cause = failed.environmental ? 'environmental death (SIGKILL/OOM or zero diagnostics)' : 'wrapper death before an exit marker (truncated stream, NOT a test verdict)';
          return `[INFRA] Verify FAILED at "${result.failedStage}": ${summary}\n${cause} — the stage did not produce a code verdict. Do NOT edit code, tests or verify config in response to this; the stage already took its in-chain retry. Re-run verify (the box may be under memory pressure) or proceed with other pending work and re-run before finishing.\n--- ${failed.key} output tail ---\n${failed.outputTail}`;
        }
        return `Verify FAILED at "${result.failedStage}": ${summary}\n--- ${failed.key} output tail ---\n${failed.outputTail}`;
      }

      case 'start_background_process': {
        // WORKSPACE-SCOPE GUARD (audit 2026-10-06 T7-7): same pre-check as run_command.
        {
          const scopeRefusal = await workspaceScopeRefusal(ctx, String(args.command || ''), 'start_background_process');
          if (scopeRefusal) return scopeRefusal;
        }
        // ANSWER-KEY GUARD (opt-in): same command-text pre-check as run_command.
        {
          const akPre = answerKeyCommandPre(String(args.command || ''));
          if (akPre) {
            const b: AnswerKeyBlock = { ...akPre, tool: 'start_background_process' };
            recordAnswerKeyBlock(ctx, b);
            return answerKeyCommandMessage(b);
          }
        }
        const r = await startBackgroundProcess(ctx.execShell, ctx.sessionId, {
          command: String(args.command || ''), name: args.name ? String(args.name) : undefined, cwd: ctx.worktree,
          ready: args.ready,
        });
        if (r.error) return r.error;
        ctx.emit('process_update', { processes: processSnapshot(ctx.sessionId) });
        // Self-configuring preview: a dev server that declared its port AND came
        // up ready configures the user's preview pane automatically (event for
        // the live sidebar + persisted so reopening the session seeds the port).
        const port = Number(args?.ready?.port) || 0;
        let previewNote = '';
        if (port && r.ready?.ok) {
          ctx.emit('preview_ready', { port, handle: r.handle, name: r.name });
          void storePut([ctx.sessionId, 'coding-ui'], 'state', { previewPort: port }).catch(() => {});
          previewNote = `\nThe user's preview pane has been configured to port ${port} automatically — no manual setup needed.`;
        }
        const readyNote = r.ready ? `\nReadiness: ${r.ready.ok ? 'READY' : 'NOT ready'} (${r.ready.detail})` : '';
        return `Started background process "${r.name}" → handle ${r.handle} (pgid ${r.pgid || '?'}). Read output with read_process_output("${r.handle}"). Stop it with stop_process when done.${readyNote}${previewNote}`;
      }

      case 'read_process_output': {
        const r = await readProcessOutput(ctx.execShell, ctx.sessionId, String(args.handle || ''), {
          sinceOffset: args.sinceOffset != null ? Number(args.sinceOffset) : undefined,
          filter: args.filter ? String(args.filter) : undefined,
        }, ctx.worktree);
        if (r.notFound) return `No such process handle "${args.handle}" (it may have been stopped/reaped). Use list_processes.`;
        const procs = processSnapshot(ctx.sessionId);
        ctx.emit('process_update', { processes: procs });
        // ANSWER-KEY GUARD (opt-in): a background REMOTE fetch (a promoted
        // run_command or start_background_process) gets the run_command
        // post-check — its command comes from the in-memory snapshot.
        {
          const procCommand = procs.find(p => p.handle === String(args.handle || ''))?.command || '';
          const b = procCommand ? answerKeyCommandPost(procCommand, r.chunk || '') : null;
          if (b) {
            const bb: AnswerKeyBlock = { ...b, tool: 'read_process_output' };
            recordAnswerKeyBlock(ctx, bb);
            return answerKeyCommandMessage(bb);
          }
        }
        // Ticket e663964f hardening (adversarial review): the read surface can
        // report `code=unknown` (state dir alive, no exit file, pgid unkillable
        // — e.g. an external SIGKILL/OOM before the runner recorded $?, or the
        // runner-start race). That is NOT a command-owned exit code, so the
        // attribution note rides ONLY on a numeric non-zero one.
        return `[${r.status}${r.exitCode ? ` code=${r.exitCode}` : ''}]${r.status === 'exited' && /^\d+$/.test(r.exitCode ?? '') && r.exitCode !== '0' ? ' The rail never killed it — that exit code came from the command itself.' : ''} offset→${r.nextOffset}\n${cap(r.chunk) || '(no new output)'}`;
      }

      case 'wait_for_process_output': {
        const r = await waitForProcessOutput(ctx.execShell, ctx.sessionId, String(args.handle || ''), {
          logMatch: args.log_match ? String(args.log_match) : undefined,
          timeoutSec: args.timeout_sec != null ? Number(args.timeout_sec) : undefined,
        }, ctx.worktree);
        if (r.outcome === 'not_found') return r.detail;
        ctx.emit('process_update', { processes: processSnapshot(ctx.sessionId) });
        // Ticket e663964f: the rail NEVER kills a monitored process, so a
        // non-zero exit here is the command's OWN death (its timeout wrapper /
        // watchdog — 124 is the GNU timeout(1) signature). State that in-band
        // so the agent does not read the rail's earlier "KEEPS RUNNING" as a
        // no-kill guarantee and report the command's own exit as a harness
        // kill. The note rides ONLY on a non-zero exit and stays LAST so it
        // never reorders output around the receipt-anchored markers.
        const railOwnExitNote = r.outcome === 'exited' && /^\d+$/.test(r.exitCode ?? '') && r.exitCode !== '0'
          ? ' The rail never killed it — that exit code came from the command itself (its own timeout wrapper / watchdog; 124 is the GNU timeout(1) signature).'
          : '';
        return `[${r.outcome}${r.exitCode != null ? ` code=${r.exitCode}` : ''}] ${r.detail}${railOwnExitNote} Read the output with read_process_output("${args.handle}").`;
      }

      case 'list_processes': {
        const procs = await listProcesses(ctx.execShell, ctx.sessionId, ctx.worktree);
        ctx.emit('process_update', { processes: processSnapshot(ctx.sessionId) });
        if (!procs.length) return '(no background processes)';
        return procs.map(p => `${p.handle}  [${p.status}]  ${p.bytes}B  ${p.command}`).join('\n');
      }

      case 'stop_process': {
        const r = await stopProcess(ctx.execShell, ctx.sessionId, String(args.handle || ''), args.signal === 'KILL' ? 'KILL' : 'TERM', ctx.worktree);
        ctx.emit('process_update', { processes: processSnapshot(ctx.sessionId) });
        return `Stopped ${args.handle} (exit ${r.exitCode}).`;
      }

      case 'ask_user': {
        if (!ctx.askUser) return 'Asking the user is not available in this run.';
        const question = String(args.question || '').trim();
        if (!question) return 'ask_user requires a question.';
        const parsed = parseAskUserOptions(args.options);
        const multiSelect = args.multiSelect === true && parsed.labels.length > 1;
        const answer = await ctx.askUser(question, parsed.labels, {
          ...(parsed.details.some(d => d.description) ? { optionDetails: parsed.details } : {}),
          ...(multiSelect ? { multiSelect: true } : {}),
        });
        if (answer == null) {
          return 'No response from the user within the wait window. Proceed with your best judgment, or call schedule_self to resume this later (recommended if you truly need their input) and then stop.';
        }
        return `User answered: ${answer}`;
      }

      case 'schedule_self': {
        // Orchestrator-only durable self-scheduling. userId + sessionId come from ctx.
        const { createSchedule } = await import('./schedule.service');
        const kind = args.kind === 'once' ? 'once' : 'recurring';
        const mins = Number(args.intervalMinutes);
        if (!Number.isFinite(mins) || mins <= 0) return 'schedule_self requires intervalMinutes > 0 (minimum 15).';
        const res = await createSchedule({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          prompt: String(args.prompt || ''),
          kind,
          intervalSec: Math.round(mins * 60),
          maxRuns: args.maxRuns != null ? Number(args.maxRuns) : undefined,
          // audit 2026-10-06 T4-5 (schooltime.md F9): a userTurnAt alone is not
          // owner authorship — an owner-dispatch run (and any machine-classified
          // run that threaded an anchor) arms MODEL-authored rows; four "owner-
          // armed hourly" watches were laundered this way, armed 48–250 min
          // after the owner's turn. scheduleArmOwnerAuthored keeps the old
          // userTurnAt test under SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED=1.
          promptSetBy: scheduleArmOwnerAuthored(ctx) ? 'user' : 'machine',
          // Owner-subscription marker (ticket 4565991a): schedule_self always
          // targets the run's OWN chat — a real user turn marks it owner-
          // subscribed (delivered content), and an owner-subscribed firing
          // re-arming itself (the one-shot ladder) INHERITS the subscription
          // so every rung renders expanded.
          ...(scheduleArmOwnerAuthored(ctx) || ctx.scheduleOwnerArmed ? { ownerSubscribed: true } : {}),
          ...(args.deltaGate !== undefined ? { deltaGate: args.deltaGate } : {}),
          // One-shot CHAIN link (finding B1): a machine `once` re-arm from a
          // schedule firing names the firing schedule — createSchedule stamps
          // chainedFromScheduleId and governs a ≥3-link chain as recurring.
          ...(kind === 'once' && !ctx.userTurnAt && ctx.firedByScheduleId ? { chainedFromScheduleId: ctx.firedByScheduleId } : {}),
        });
        // LOUD, actionable failure — a rejected schedule_self must never look
        // like a silently-lost wake (1d4c8a14). res.error is already actionable
        // (createSchedule spells out the fix, e.g. shorten an over-length prompt).
        if (!res.ok) return `⚠️ schedule_self FAILED — no schedule was created. ${res.error}`;
        ctx.emit('schedule_update', { schedule: res.schedule });
        const s = res.schedule!;
        // Duplicate-backstop guard (ticket 1ead3b52): an identical enabled row
        // already exists — say so LOUDLY so the lane does not believe it now
        // holds TWO backstops (and so a genuinely different cadence is routed
        // through cancel + re-arm, not a stack).
        if (res.deduped) {
          return `An IDENTICAL enabled ${s.kind} schedule already exists (id ${s.id}) — no duplicate was created; this returns the existing one (next run at ${s.nextRunAt}). One backstop per wait is enough — cancel_schedule it first if you meant a different cadence or a different prompt.${res.gateUpdated ? ' Its delta gate was (re)armed from your call — the next evaluation fires once to re-baseline.' : ''}`;
        }
        // Ask-mode + scheduled runs = dead autonomy: an unattended run's mutating
        // tools are AUTO-DENIED instantly (checkPermission's userTurnAt fail-fast).
        const askModeWarning = ctx.permissionMode === 'ask'
          ? `\n\n⚠️ WARNING: this session is in ASK permission mode. Scheduled runs start unattended, and every mutating tool (edits, commits, commands) is AUTO-DENIED instantly — no human is present to approve, so the run can only do read-only work. For a reliable unattended loop, ask the user to switch this session to AUTO mode.`
          : '';
        // Cap-cadence advisory (ticket 2694a581): the arm landed, but its
        // cadence burns most/all of the chat's daily firing cap — say so LOUDLY
        // so the lane re-spaces before one-shots/hook wakes start skipping.
        const capWarning = res.warning ? `\n\n${res.warning}` : '';
        // Same-cadence collapse (ticket ae20da66): the arm atomically cancelled
        // older machine recurring row(s) at the SAME interval — say so LOUDLY
        // so the lane neither cancel_schedules an already-cancelled row nor
        // believes two cadences are live.
        const supersededNote = res.superseded?.length
          ? `\n\nThis arm SUPERSEDED ${res.superseded.length} same-cadence recurring schedule(s): ${res.superseded.join(', ')} — already cancelled atomically (no separate cancel_schedule needed; you now hold ONE live cadence at this interval).`
          : '';
        return `Scheduled (${s.kind}, id ${s.id}). Next run at ${s.nextRunAt}${s.kind === 'recurring' ? `, every ${Math.round((s.intervalSec || 0) / 60)} min` : ''}. Expires ${s.expiresAt}. It will run even after you stop — cancel with cancel_schedule.${capWarning}${askModeWarning}${supersededNote}`;
      }

      // NOTE: 'list_schedules' / 'cancel_schedule' / 'update_schedule' are dispatched
      // ABOVE the switch — they are platform tools now (widened from this-session to
      // the owning user, P1; platform.service owns authz + audit).

      default:
        return `Unknown coding tool: ${name}`;
    }
  } catch (err: any) {
    // Attribution stamp (firing-50): carry the session/run ids as logger meta so
    // the audit's errors_4h can attribute this row to a chat instead of landing
    // context=null (the firing-48 agentWarn class). Mirrors agentLoop's agentWarn.
    //
    // Taxonomy (log-signal family 1e6ca603, 2026-11-06): an EXPECTED input
    // REFUSAL is the product, not an internal fault — the same adjudication
    // tools.ts:165 already makes for a workspace refusal, and the message the
    // model receives (`Tool <n> failed: …`) is UNCHANGED, so the lane keeps the
    // full actionable text (e.g. goal_premise_set's mode:'replace' hatch).
    //
    // The discriminator is deliberately NARROW: a platform tool refusing with
    // AppError 400, i.e. the caller's own input failed validation. Everything
    // else still files — 403/404/409/410 refusals can indicate a stale id or a
    // real authority bug, every 5xx stays untagged, and a non-AppError throw
    // (TypeError, Prisma, ENOENT, a git failure) carries no statusCode at all so
    // it can never be swallowed here. Duck-typed on purpose: importing
    // middleware/error-handler would pull config/env into this file's graph and
    // process.exit(1) in env-less suites (tools.ts:33-38).
    //
    // NB: both arms carry the meta object INLINE — warn-attribution.firing50
    // reads the warn span out of this file and requires these five fields.
    const refusalStatus = typeof err?.statusCode === 'number' ? err.statusCode : null;
    if (isPlatformTool(name) && refusalStatus === 400) {
      logHandled(`coding tool ${name} refused: ${err.message}`, {
        sessionId: ctx?.sessionId,
        runId: ctx?.runId ?? undefined,
        userId: ctx?.userId,
        source: 'coding-tool',
        tool: name,
      });
    } else {
      logger.warn(`coding tool ${name} failed: ${err.message}`, {
        sessionId: ctx?.sessionId,
        runId: ctx?.runId ?? undefined,
        userId: ctx?.userId,
        source: 'coding-tool',
        tool: name,
      });
    }
    return `Tool ${name} failed: ${err.message}`;
  }
}
