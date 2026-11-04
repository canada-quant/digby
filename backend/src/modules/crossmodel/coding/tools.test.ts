/**
 * Tests for coding tool safety: path-escape guard + mutating-tool classification.
 * These are the security-critical invariants of the coding agent.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// view_image (2026-10-01): the Image reader seat — the executor-routing test below.
const mockAnswerImageQuestion: jest.Mock = jest.fn();
jest.mock('../image-describe', () => ({
  __esModule: true,
  answerImageQuestion: (...a: any[]) => mockAnswerImageQuestion(...a),
}));

// tools.ts imports platform-tools (P6), whose graph reaches config/env —
// which calls process.exit(1) without env vars and kills the whole jest worker
// at import time — via platform.service → config/database + error-handler, via
// platform.validation → agent-auth → utils/jwt, and via feedback/feedback.service
// → config/database. Mock the boundary modules so the REAL platform-tools
// constants still load (asserted below).
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
// 2026-10-06: the workspace guard reads the owner's sessions (same-owner allowance) through a dynamic import.
const mockSameOwnerSessions = jest.fn(async (): Promise<Array<{ id: string; projectId: string | null }>> => []);
jest.mock('../../../config/database', () => ({ __esModule: true, default: { chatCodingState: { findMany: (...a: any[]) => mockSameOwnerSessions(...(a as [])) } } }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read',
    'chats:write',
    'folders:read',
    'folders:write',
    'schedules:write',
    'code:run',
  ] as const,
}));
// platform-tools also imports feedback/feedback.service → config/database →
// config/env (the same process.exit landmine). FEEDBACK_TYPES is read at MODULE
// SCOPE (spread into the file_feedback/list_feedback schema enums), so the mock
// must carry the real 6-value array — a bare mock crashes differently.
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
// tools.ts transitively imports plan.service → context-store → DB/env; mock the
// store so importing tools doesn't trigger env validation (process.exit) in tests.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
// tools.ts also imports coding-retrieval.service → rag.service → env (process.exit).
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
// Retrieval telemetry (owner 2026-09-04): tools.ts imports the loop-metrics
// recorder, which pulls config/database → config/env (process.exit at import)
// — mock the boundary like the other config-reaching seams here.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard', MERGE_WAIT_ONCE: 'merge_wait_once',
    GUARD_STRIKE: 'guard_strike',
  },
}));
// merge_pull_request dynamic-imports the self-merge engine (→ prisma/redis →
// config/env process.exit) and, on the machine no-project ask branch, the
// owner-questions module (same env landmine) — mock both boundaries.
const mockResolveSelfMergePolicy: jest.Mock = jest.fn(async (): Promise<any> => ({ policy: 'on', source: 'setting' }));
const mockCheckOrAskOwner: jest.Mock = jest.fn(async (): Promise<any> => 'pending');
const mockEvaluateMergeGates: jest.Mock = jest.fn(async (): Promise<any> => ({
  ok: true, alreadyMerged: false, headSha: 'headsha1234567890abcd', evidenceHash: 'ev1', evidenceNotes: ['gates green'],
}));
const mockReadAttempt: jest.Mock = jest.fn(async (): Promise<any> => ({}));
const mockWriteAttempt: jest.Mock = jest.fn(async () => {});
const mockClearAttempt: jest.Mock = jest.fn(async () => {});
const mockRecordMergeLearning: jest.Mock = jest.fn(async () => {});
// Post-merge head-branch cleanup (owner 2026-09-14) — the helper's own rules
// live in self-merge.service.test.ts; here it is a boundary.
const mockDeleteMergedHeadBranch: jest.Mock = jest.fn(async (): Promise<any> => ({ outcome: 'kept', branch: null }));
const mockGithubApi = { put: jest.fn(), get: jest.fn(), delete: jest.fn() };
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: (...a: any[]) => mockResolveSelfMergePolicy(...a),
  checkOrAskOwner: (...a: any[]) => mockCheckOrAskOwner(...a),
  evaluateMergeGates: (...a: any[]) => mockEvaluateMergeGates(...a),
  readAttempt: (...a: any[]) => mockReadAttempt(...a),
  writeAttempt: (...a: any[]) => mockWriteAttempt(...a),
  clearAttempt: (...a: any[]) => mockClearAttempt(...a),
  recordMergeLearning: (...a: any[]) => mockRecordMergeLearning(...a),
  deleteMergedHeadBranch: (...a: any[]) => mockDeleteMergedHeadBranch(...a),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => mockGithubApi,
  // WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27) — the pure classifier
  // is mirrored (the real module reaches prisma); the sleep / p50 / slot seams
  // are observable mocks so the tool's wait path runs in microseconds.
  selfMergeWaitOnceDisabled: () => mockWaitOnceDisabled(),
  classifyMergeWait: (input: any) => input?.failure?.transient
    ?? (Number(input?.apiStatus) >= 500 ? 'server_5xx' : input?.apiStatus === 405 && /in progress|base branch was modified/i.test(String(input?.apiMessage ?? '')) ? 'merge_in_progress' : null),
  mergeWaitOnceMs: (p50: number | null, kind: string) => (kind === 'ci_pending' ? (p50 ? 2 * p50 : 7) : 3),
  repoCiP50Ms: (...a: any[]) => mockRepoCiP50Ms(...a),
  tryAcquireMergeWaitSlot: () => mockAcquireWaitSlot(),
  releaseMergeWaitSlot: (...a: any[]) => mockReleaseWaitSlot(...a),
  mergeWaitSleep: (...a: any[]) => mockMergeWaitSleep(...a),
}));
const mockWaitOnceDisabled: jest.Mock = jest.fn((): boolean => false);
const mockRepoCiP50Ms: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockAcquireWaitSlot: jest.Mock = jest.fn((): boolean => true);
const mockReleaseWaitSlot: jest.Mock = jest.fn();
const mockMergeWaitSleep: jest.Mock = jest.fn(async (_ms: number) => undefined);
const mockFlagOwnerQuestion: jest.Mock = jest.fn(async (): Promise<any> => ({ kind: 'created' }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));
// MERGE-INTENT-AWAIT review fix: a merge intent enqueues its BACKSTOP one-shot
// through hooks.service (→ prisma → config/env) — mock the boundary.
const mockEnqueueDirectWake: jest.Mock = jest.fn(async (_o: any): Promise<any> => ({ ok: true, hookEventId: 'bs-hook-1' }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));
// The success path's bounded post-merge CI observation would really sleep 30s.
jest.mock('./ci-status', () => ({
  __esModule: true,
  observeCiAfterPush: jest.fn(async () => ''),
  fetchCiStatus: jest.fn(async () => ({ state: 'none', checks: [], failing: [], total: 0 })),
  renderCiStatus: jest.fn(() => ''),
  emitCiFailed: jest.fn(),
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
// schedule_self dynamically imports ./schedule.service → config/redis →
// config/env (process.exit at import) — mock the boundary for the warning-copy
// tests below.
jest.mock('./schedule.service', () => ({
  __esModule: true,
  createSchedule: jest.fn(async () => ({
    ok: true,
    schedule: {
      id: 'sch1', kind: 'recurring', intervalSec: 3600,
      nextRunAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-09-13T00:00:00.000Z',
    },
  })),
}));
// Audit #8: the git_push/open_pull_request idempotent-resume guard — mocked at
// the module boundary (the real module reaches prisma → config/env). Defaults
// are "no prior execution" so every pre-existing flow is untouched.
const mockFindPriorRunPushReceipt: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockFindPriorRunPrReceipt: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockPrHeadMatchesReceipt: jest.Mock = jest.fn(async (): Promise<boolean> => false);
// audit 2026-10-08 W2-5: the state-returning re-read. Default undefined => the
// handler falls back to prHeadMatchesReceipt (the pre-W2-5 mock contract).
const mockPrReceiptHeadState: jest.Mock = jest.fn(async (): Promise<any> => undefined);
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: (...a: any[]) => mockFindPriorRunPushReceipt(...a),
  findPriorRunPrReceipt: (...a: any[]) => mockFindPriorRunPrReceipt(...a),
  prHeadMatchesReceipt: (...a: any[]) => mockPrHeadMatchesReceipt(...a),
  prReceiptHeadState: (...a: any[]) => mockPrReceiptHeadState(...a),
  prStateWarrantsSkip: (st: any) => !!st && st.headMatches && st.state === 'open' && !st.merged,
}));

import { resolveInside, MUTATING_TOOLS, executeCodingTool, ToolContext, CODING_TOOL_SCHEMA, describePrDiff } from './tools';
import { createSchedule as mockedCreateSchedule } from './schedule.service';
import { storePut as mockedStorePut, storeGet as mockedStoreGet } from '../memory/context-store';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const WT = '/app/coding-workspaces/worktrees/sess-1';

/** Minimal ToolContext that records the shell command grep/glob would run. */
function captureCtx(): { ctx: ToolContext; commands: string[] } {
  const commands: string[] = [];
  const ctx = {
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async (command: string) => { commands.push(command); return { stdout: '', stderr: '' }; },
  } as unknown as ToolContext;
  return { ctx, commands };
}

describe('resolveInside (path-escape guard)', () => {
  test('allows paths inside the worktree', () => {
    expect(resolveInside(WT, 'src/index.ts')).toBe(`${WT}/src/index.ts`);
    expect(resolveInside(WT, './a/b.txt')).toBe(`${WT}/a/b.txt`);
    expect(resolveInside(WT, '.')).toBe(WT);
  });

  test('honors absolute paths that already point inside the worktree', () => {
    expect(resolveInside(WT, `${WT}/src/index.ts`)).toBe(`${WT}/src/index.ts`);
    expect(resolveInside(WT, WT)).toBe(WT);
    expect(resolveInside(WT, `${WT}/./a/../b.txt`)).toBe(`${WT}/b.txt`);
  });

  test('rejects absolute paths outside the worktree — no silent remap (ticket c7591297)', () => {
    // The old behavior stripped the leading "/" and silently re-rooted the path
    // into the worktree, while run_command's shell sees the REAL absolute path —
    // two different files at one apparent path (a write_file "/tmp/x" refresh
    // never reached the shell, which then ran a stale pre-existing /tmp script).
    expect(() => resolveInside(WT, '/etc/passwd')).toThrow(/outside the worktree/);
    expect(() => resolveInside(WT, '/tmp/probe.sh')).toThrow(/outside the worktree/);
    expect(() => resolveInside(WT, '/')).toThrow(/outside the worktree/);
    // The error must teach the fix (worktree-relative path or shell-side write).
    expect(() => resolveInside(WT, '/tmp/probe.sh')).toThrow(/run_command/);
  });

  test('rejects an absolute path that traverses out of the worktree', () => {
    expect(() => resolveInside(WT, `${WT}/../sess-1-evil/x`)).toThrow(/outside the worktree/);
  });

  test('rejects ../ traversal that escapes the worktree', () => {
    expect(() => resolveInside(WT, '../../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInside(WT, 'a/../../..')).toThrow(/escapes/);
  });

  test('rejects a sibling-prefix escape (worktree-2 next to worktree)', () => {
    // Ensures the guard uses a path-separator boundary, not a string prefix.
    expect(() => resolveInside(WT, '../sess-1-evil/x')).toThrow(/escapes/);
  });
});

describe('MUTATING_TOOLS', () => {
  test('gates the write/command/commit/publish/process tools', () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(
      [
        'edit_file', 'ast_rewrite', 'git_commit', 'git_push', 'merge_pull_request', 'open_pull_request', 'rewind_to_step', 'run_command', 'write_file',
        'start_background_process', 'stop_process',
        // P1 platform tools (mutating subset) — see platform/platform-tools.ts
        'archive_chat', 'cancel_schedule', 'create_chat', 'create_project', 'delete_chat',
        'delete_project', 'move_chat', 'move_folder', 'rename_chat', 'schedule_message', 'send_chat_message',
        // email AS Digby (ticket 54f237bf) — account tool, machine-capable, non-consequential
        'send_email_as_digby',
        'start_coding_session', 'update_project', 'update_schedule',
        // fleet supervisor: per-chat autonomy grant (consequential — user-turn-only)
        'set_chat_autonomy',
        // fleet supervisor (slice D): goal/todo CRUD + hook wiring (organizational — NOT consequential)
        'goal_create', 'goal_update', 'todo_create', 'todo_update', 'hook_subscribe', 'hook_update', 'hook_unsubscribe',
        // premise register (2026-09-17, 47fb11f26): supervisor records a goal's premise; mutating
        'goal_premise_set',
        // agent feedback loop (file is rate-capped; update is admin-gated at execution)
        'file_feedback', 'update_feedback',
        // "Needs owner" persistent inbox (ticket 7705fec2): flags a question for the owner
        // (dedup'd + capped; NOT consequential — it only files the question)
        'flag_owner_question',
        // Review 2026-09-13 issue 11: supervisor-first triage — the Fleet Supervisor
        // answers a triaged owner question (supervisor-chat scope; NOT consequential)
        'answer_owner_question',
        // control tools (capability gap audit P0, 2026-09-24): consequential, target-scoped
        'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
        // session settings (capability gap audit T2, 2026-09-24): non-consequential, owner-scoped
        'set_session_model', 'set_chat_mode', 'set_session_permission_mode',
        // ops/inbox mutations (T3a, 2026-09-24); set_model_role_fallback is also ask-only
        'dismiss_owner_question', 'cancel_confirmation', 'set_model_role_fallback',
        // decision-gate mode flip for the Fleet Supervisor seat (rollout self-governance, 2026-09-27): the admin PUT's admission, owner question outside tier 1
        'set_decision_gate_mode',
        // coordination / workspace mutations (T3b, 2026-09-24); configure_workspace + import_repo are consequential
        'sync_workspace', 'stage_upload', 'configure_workspace', 'import_repo',
        // T4a housekeeping + T4b fleet/ops (2026-09-24); remove_knowledge_document / delete_canvas are also ask-only
        // (set_feed / refresh_feed / delete_feed retired with the feeds subsystem, 43c24152)
        'remove_knowledge_document', 'add_knowledge_file', 'add_knowledge_gmail', 'create_canvas', 'delete_canvas', 'share_canvas', 'revoke_canvas_share', 'archive_project', 'set_preferences',
        'ack_digest_item', 'unack_digest_item', 'revoke_chat_webhook',
        // T5 self-service (2026-09-24); delete_document / delete_chat_upload are also ask-only
        'consolidate_memory', 'rebuild_memory', 'share_project', 'add_project_member', 'remove_project_member', 'resolve_feedback', 'delete_document', 'delete_chat_upload',
        'create_chat_webhook', // #32 close-out (2026-09-25): consequential + never autonomous
        'store_secret', // audit 2026-10-06 T2-3: the owner-secret hand-off — value source is owner-authored at execution (this turn, or an owner-typed fromMessageId row; ticket 37a875ee)
        // User Space §4b (P3d): agent-driven workspace attach on the current chat
        // (cheap, owner-scoped, attach-only — NOT consequential)
        'attach_workspace',
        // fleet supervisor (2026-08-22 durable-state rebuild): self-state merge, supervisor-chat only
        'update_supervisor_state',
        // platform engineering lane (Option D 2026-08-22): admin-gated at execution
        'dispatch_platform_task',
        // coding dev-container tailnet recourse (2026-08-28): per-user scoped, mid-run-safe, NOT consequential
        'restart_dev_tailnet',
        // infra-actuation lever (ticket c12239c1): dry-run receipts until INFRA_ACTIONS_ENABLED=1 — NOT consequential
        'infra_action',
        // fleet-wide infra-blocker registry (feedback 2b45941b): supervisor-gated writes — NOT consequential
        'register_infra_blocker', 'clear_infra_blocker',
        // Digby Edge (2026-08-30): push a message to a paired self-hosted instance's chat
        // (consequential — user-turn anchor or autonomy grant; UNTRUSTED framing on the edge)
        'send_to_instance',
        // account tools (2026-09-08, "Digby operates Digby" — platform/account-tools.ts):
        // owner-scoped, reversible, NOT consequential (notify_user runs unattended on purpose)
        'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'update_canvas',
        'revoke_share_link', 'notify_user', 'set_chat_instructions',
        // account tools, CONSEQUENTIAL: create_share_link is NEVER autonomous
        // (security posture). telegram_connect_link is READ-ONLY (returns the
        // in-app connect page, mints nothing) — not mutating.
        // (create_feed was retired with the feeds subsystem, 43c24152.)
        'create_share_link',
        // watched resources + training artifacts (remediation P7 S1b —
        // platform/resource-tools.ts): owner-scoped records, NOT consequential;
        // the machine evidence discipline lives in the executor.
        'register_watched_resource', 'observe_resource', 'register_artifact', 'verify_durable', 'release_watched_resource',
        // Drive watch (DW-1, 2026-09-29): channel create/stop — owner-scoped, reversible
        'subscribe_drive_watch', 'unsubscribe_drive_watch',
      ].sort()
    );
    // Read/search + planning + read-only monitor tools are never gated.
    expect(MUTATING_TOOLS.has('read_file')).toBe(false);
    expect(MUTATING_TOOLS.has('grep')).toBe(false);
    expect(MUTATING_TOOLS.has('ast_search')).toBe(false);
    expect(MUTATING_TOOLS.has('git_diff')).toBe(false);
    expect(MUTATING_TOOLS.has('git_status')).toBe(false);
    expect(MUTATING_TOOLS.has('update_plan')).toBe(false);
    expect(MUTATING_TOOLS.has('read_process_output')).toBe(false);
    expect(MUTATING_TOOLS.has('list_processes')).toBe(false);
  });
});

describe('grep/glob shell-injection safety (read-only tools must not execute commands)', () => {
  // A malicious/prompt-injected pattern must be single-quote-escaped so bash never
  // performs $(…)/backtick/$VAR expansion — the critical read-only-tool invariant.
  const INJECT = '$(touch /tmp/pwned)';

  test('grep single-quote-escapes the pattern (no live command substitution)', async () => {
    const { ctx, commands } = captureCtx();
    await executeCodingTool(ctx, 'grep', { pattern: INJECT });
    const cmd = commands[0];
    // The payload appears only inside a single-quoted literal, never bare.
    expect(cmd).toContain(`-e '$(touch /tmp/pwned)'`);
    expect(cmd).not.toMatch(/-e \$\(touch/); // not unquoted
  });

  test("grep escapes an embedded single quote so the quote can't be broken out of", async () => {
    const { ctx, commands } = captureCtx();
    await executeCodingTool(ctx, 'grep', { pattern: "a' ; rm -rf . ; '" });
    expect(commands[0]).toContain(`'a'\\'' ; rm -rf . ; '\\'''`);
  });

  test('glob single-quote-escapes the pattern', async () => {
    const { ctx, commands } = captureCtx();
    await executeCodingTool(ctx, 'glob', { pattern: INJECT });
    const cmd = commands[0];
    expect(cmd).toContain(`':(glob)$(touch /tmp/pwned)'`);
    expect(cmd).not.toMatch(/ls -1 \$\(/);
  });
});

describe('ast_search / ast_rewrite (harness roadmap item 3 — ast-grep via npx in the dev container)', () => {
  const MATCH = '[{"text":"console.log(1)","range":{"byteOffset":{"start":14,"end":28},"start":{"line":0,"column":14},"end":{"line":0,"column":28}},"file":"x.ts","lines":"function a(){ console.log(1) }","charCount":{"leading":14,"trailing":2},"replacement":"log(1)","language":"TypeScript","metaVariables":{"single":{},"multi":{},"transformed":{}}}]';
  /** A ctx whose shell answers each call from a queue and records checkpoint/diagnostic/emit calls. */
  function astCtx(replies: string[]) {
    const commands: string[] = [];
    const beforeWrite = jest.fn(async () => {});
    const noteEdit = jest.fn();
    const emitted: any[] = [];
    const ctx = {
      worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
      emit: (type: string, payload: any) => { emitted.push({ type, payload }); }, alwaysAllow: new Set<string>(),
      requestApproval: async () => 'allow' as const,
      execShell: async (command: string) => { commands.push(command); return { stdout: replies.shift() ?? '', stderr: '' }; },
      checkpoints: { beforeWrite },
      diagnostics: { noteEdit },
    } as unknown as ToolContext;
    return { ctx, commands, beforeWrite, noteEdit, emitted };
  }

  beforeEach(() => { });

  test('ast_search single-quote-escapes the pattern and scope, runs ast-grep (not sg) through the pinned npx package, renders matches', async () => {
    const { ctx, commands } = astCtx([MATCH]);
    const out = await executeCodingTool(ctx, 'ast_search', { pattern: '$(touch /tmp/pwned)', lang: 'ts', path: 'src', glob: '**/*.ts' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`--package '@ast-grep/cli@`);
    expect(commands[0]).toContain(` ast-grep run --pattern '$(touch /tmp/pwned)' --lang 'ts' --globs '**/*.ts' --json=compact 'src' 2>&1`);
    expect(commands[0]).not.toMatch(/--pattern \$\(/);
    expect(out).toMatch(/^1 match\(es\) in 1 file\(s\)\nx\.ts:1:15  function a\(\)\{ console\.log\(1\) \}/);
  });

  test('ast_search: a non-parsing pattern comes back as "(no matches)" WITH the ast-grep warning and the fix-the-pattern hint; npx failure is an honest tool failure', async () => {
    const warn = astCtx(['[]\nWarning: Pattern contains an ERROR node and may cause unexpected results.\nHelp: try the playground']);
    const out = await executeCodingTool(warn.ctx, 'ast_search', { pattern: 'if (' });
    expect(out).toMatch(/^\(no matches\)\n\[ast-grep\] Warning: Pattern contains an ERROR node/);
    expect(out).toMatch(/fix the pattern/);
    expect(out).not.toContain('Help:');
    const dead = astCtx(['npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/@ast-grep%2fcli failed']);
    expect(await executeCodingTool(dead.ctx, 'ast_search', { pattern: 'x' })).toMatch(/^Tool ast_search failed: ast-grep is unavailable in this container \(npm ERR! code ENOTFOUND\) — fall back to grep\./);
    const silent = astCtx(['']);
    expect(await executeCodingTool(silent.ctx, 'ast_search', { pattern: 'x' })).toMatch(/^Tool ast_search failed: no output from ast-grep/);
    const badLang = astCtx([]);
    expect(await executeCodingTool(badLang.ctx, 'ast_search', { pattern: 'x', lang: 'ts; id' })).toMatch(/^Tool ast_search failed: lang "ts; id" is not a language id/);
    expect(badLang.commands).toHaveLength(0);
  });

  test('ast_rewrite: dry run (JSON) → checkpoint every touched file → apply (--update-all) → diagnostics + file_changed per file → receipt', async () => {
    const { ctx, commands, beforeWrite, noteEdit, emitted } = astCtx([MATCH, 'Applied 1 changes\n']);
    const out = await executeCodingTool(ctx, 'ast_rewrite', { pattern: 'console.log($A)', rewrite: 'log($A)', lang: 'ts' });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain(`--rewrite 'log($A)' --json=compact '.' 2>&1`);
    expect(commands[0]).not.toContain('--update-all');
    expect(commands[1]).toContain(`--rewrite 'log($A)' --update-all '.' 2>&1`);
    expect(beforeWrite).toHaveBeenCalledWith('x.ts', `${WT}/x.ts`);
    // The checkpoint lands BEFORE the apply command runs.
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(commands.length ? Number.MAX_SAFE_INTEGER : 0);
    expect(noteEdit).toHaveBeenCalledWith('x.ts');
    expect(emitted).toEqual([{ type: 'file_changed', payload: { path: 'x.ts', action: 'edit' } }]);
    expect(out).toMatch(/^Rewrote 1 change\(s\) across 1 file\(s\) \(dry run matched 1\):\nx\.ts:1  function a\(\)\{ console\.log\(1\) \}  →  log\(1\)/);
    expect(out).toMatch(/rewind_to_step undoes it/);
  });

  test('ast_rewrite: no dry-run matches → nothing applied (one command, no checkpoint); a missing rewrite string is refused before any shell', async () => {
    const none = astCtx(['[]']);
    expect(await executeCodingTool(none.ctx, 'ast_rewrite', { pattern: 'zzz()', rewrite: 'y()', lang: 'ts' })).toBe('(no matches — nothing rewritten)');
    expect(none.commands).toHaveLength(1);
    expect(none.beforeWrite).not.toHaveBeenCalled();
    const noRewrite = astCtx([]);
    expect(await executeCodingTool(noRewrite.ctx, 'ast_rewrite', { pattern: 'x' })).toMatch(/^Tool ast_rewrite failed: `rewrite` must be a string/);
    expect(noRewrite.commands).toHaveLength(0);
    // An EMPTY template is a legitimate delete.
    const del = astCtx(['[]']);
    await executeCodingTool(del.ctx, 'ast_rewrite', { pattern: 'debugger', rewrite: '', lang: 'ts' });
    expect(del.commands[0]).toContain(`--rewrite ''`);
  });

  test('ast_rewrite: an apply without the "Applied N changes" receipt is reported as a failure that points at git_diff', async () => {
    const odd = astCtx([MATCH, 'something unexpected']);
    expect(await executeCodingTool(odd.ctx, 'ast_rewrite', { pattern: 'console.log($A)', rewrite: 'log($A)' })).toMatch(/^Tool ast_rewrite failed: the apply step reported no "Applied N changes" line — check the files with git_diff/);
  });
});

describe('scanDiffForSecrets (commit-time secret scan)', () => {
  const { scanDiffForSecrets } = require('./tools');

  const diff = (file: string, added: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${added}\n`;

  it('flags HuggingFace, GitHub, sk-, Slack, AWS, Google tokens and private keys on added lines', () => {
    expect(scanDiffForSecrets(diff('.env', 'HF_TOKEN=hf_' + 'a'.repeat(34)))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('x.ts', 'const t = "ghp_' + 'B'.repeat(36) + '"'))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('x.ts', 'key: sk-' + 'c'.repeat(40)))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('x.ts', 'SLACK=xoxb-12345-abcdefghij'))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('x.ts', 'AKIA' + 'A'.repeat(16)))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('x.ts', 'AIza' + 'D'.repeat(35)))).toHaveLength(1);
    expect(scanDiffForSecrets(diff('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----'))).toHaveLength(1);
  });

  it('names the offending file in the hit', () => {
    const hits = scanDiffForSecrets(diff('config/creds.py', 'hf_' + 'z'.repeat(34)));
    expect(hits[0]).toContain('config/creds.py');
  });

  it('ignores REMOVED lines and placeholder-length strings', () => {
    const removal = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +0,0 @@\n-const t = "hf_${'a'.repeat(34)}"\n`;
    expect(scanDiffForSecrets(removal)).toHaveLength(0);
    expect(scanDiffForSecrets(diff('.env.example', 'HF_TOKEN=hf_your_token_here'))).toHaveLength(0);
    expect(scanDiffForSecrets(diff('x.ts', 'const skill = "sk-illed"'))).toHaveLength(0);
  });

  it('dedupes repeat hits of the same pattern+file', () => {
    const d = diff('x.ts', 'a hf_' + 'a'.repeat(34)) + diff('x.ts', 'b hf_' + 'b'.repeat(34));
    expect(scanDiffForSecrets(d)).toHaveLength(1);
  });
});

describe('run_command background rail (auto mode: pre-emptive promotion, never re-run)', () => {
  const { startBackgroundProcess, waitForProcessOutput, readProcessOutput, releaseHandle } = jest.requireMock('./process.service');

  const mkCtx = (permissionMode: string, shell?: (c: string) => Promise<{ stdout: string; stderr: string }>) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode,
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    // Fixtures simulate a REAL USER TURN; override userTurnAt: undefined for machine runs.
    userTurnAt: new Date(),
    requestApproval: async () => 'allow' as const,
    execShell: shell || (async () => ({ stdout: 'fg-out', stderr: '' })),
  } as unknown as ToolContext);

  beforeEach(() => {
    (startBackgroundProcess as jest.Mock).mockClear().mockResolvedValue({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' });
    (waitForProcessOutput as jest.Mock).mockClear().mockResolvedValue({ outcome: 'exited', detail: '', exitCode: '0' });
    (readProcessOutput as jest.Mock).mockClear().mockResolvedValue({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' });
    (releaseHandle as jest.Mock).mockClear();
  });

  it('auto mode: a fast command runs on the background rail, returns output, releases the handle', async () => {
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'echo ok' });
    expect(startBackgroundProcess).toHaveBeenCalledTimes(1);
    expect(out).toBe('[command OK]\nok'); // 2026-08-30: status banner leads every command result
    expect(releaseHandle).toHaveBeenCalledWith('sess-1', 'p1');
  });

  it('auto mode: a failing command surfaces its exit code', async () => {
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: '', exitCode: '2' });
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'boom', nextOffset: 4, status: 'exited', exitCode: '2' });
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'false' });
    expect(out).toContain('boom');
    expect(out.startsWith('[command FAILED — exit 2]')).toBe(true); // banner leads
    expect(out).toContain('[exit: 2]'); // tail suffix kept (receipt parser back-compat)
  });

  it('auto mode: a long command is promoted to a monitor — the ONE process keeps running, nothing re-runs', async () => {
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'timeout', detail: 'still running', exitCode: null });
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'partial log', nextOffset: 10, status: 'running', exitCode: null });
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'npm test' });
    expect(startBackgroundProcess).toHaveBeenCalledTimes(1); // never a second copy
    expect(out).toContain('SELF-STARTED MONITOR');
    expect(out).toContain('Handle: "p1"');
    expect(out).toContain('KEEPS RUNNING');
    // Ticket e663964f: the promotion message must disown the 300s figure as a
    // kill deadline AND pre-explain a later command-owned exit (124).
    expect(out).toContain('not a kill deadline');
    expect(out).toContain('the rail never kills it and never re-runs it');
    expect(out).toContain('124, the GNU timeout(1) signature');
    expect(out).toContain('partial log');
    expect(releaseHandle).not.toHaveBeenCalled(); // still live — slot stays tracked
  });

  it('auto mode: a promoted command that later exits NON-ZERO is reported by the rail with the FAILED banner + exit tail (the own-exit NOTE belongs to the wait/read monitor surfaces — no "KEEPS RUNNING" claim precedes a fast exit)', async () => {
    // The reporter's scenario: command promoted at 300s, then its OWN 300s
    // watchdog (tssh/GNU timeout) killed it → exit 124. The rail faithfully
    // reports the exit; the wait/read notes below are what de-ambiguates it.
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: 'Process exited with code 124.', exitCode: '124' });
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'tssh box -- sleep 760' });
    expect(out.startsWith('[command FAILED — exit 124]')).toBe(true);
    expect(out.trim().endsWith('[exit: 124]')).toBe(true); // exit marker stays LAST (reviewer F2 contract)
  });

  it('auto mode: background rail unavailable falls through to plain foreground exec', async () => {
    (startBackgroundProcess as jest.Mock).mockResolvedValue({ handle: '', name: '', pgid: null, logPath: '', error: 'Too many background processes' });
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'echo ok' });
    expect(out).toBe('[command OK]\nfg-out'); // 2026-08-30: status banner leads
  });

  it('wait_for_process_output on a NON-ZERO command exit carries the own-exit note (ticket e663964f: "[exited code=124]" must not read as a harness kill)', async () => {
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: 'Process exited with code 124.', exitCode: '124' });
    const out = await executeCodingTool(mkCtx('auto'), 'wait_for_process_output', { handle: 'p1' });
    expect(out.startsWith('[exited code=124]')).toBe(true);
    expect(out).toContain('The rail never killed it');
    expect(out).toContain('124 is the GNU timeout(1) signature');
  });

  it('wait_for_process_output on a zero exit (and on timeout/matched) carries NO own-exit note', async () => {
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: 'Process exited with code 0.', exitCode: '0' });
    const out = await executeCodingTool(mkCtx('auto'), 'wait_for_process_output', { handle: 'p1' });
    expect(out).not.toContain('The rail never killed it');
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'timeout', detail: 'No match or exit within 240s — process still running.', exitCode: null });
    const out2 = await executeCodingTool(mkCtx('auto'), 'wait_for_process_output', { handle: 'p1' });
    expect(out2.startsWith('[timeout]')).toBe(true);
    expect(out2).not.toContain('The rail never killed it');
  });

  it('read_process_output on a NON-ZERO command exit carries the short own-exit note (ticket e663964f)', async () => {
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'probe output', nextOffset: 12, status: 'exited', exitCode: '124' });
    const out = await executeCodingTool(mkCtx('auto'), 'read_process_output', { handle: 'p1' });
    expect(out.startsWith('[exited code=124]')).toBe(true);
    expect(out).toContain('The rail never killed it');
    expect(out).toContain('probe output');
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'fine', nextOffset: 4, status: 'exited', exitCode: '0' });
    const out0 = await executeCodingTool(mkCtx('auto'), 'read_process_output', { handle: 'p1' });
    expect(out0.startsWith('[exited code=0]')).toBe(true);
    expect(out0).not.toContain('The rail never killed it');
  });

  it('read_process_output on code=unknown (external kill / runner-start race — no real exit code exists) carries NO own-exit note (ticket e663964f review: "[exited code=unknown] ... came from the command itself" attributed a code that does not exist)', async () => {
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'last output', nextOffset: 9, status: 'exited', exitCode: 'unknown' });
    const out = await executeCodingTool(mkCtx('auto'), 'read_process_output', { handle: 'p1' });
    expect(out.startsWith('[exited code=unknown]')).toBe(true);
    expect(out).not.toContain('The rail never killed it');
    expect(out).toContain('last output');
    // Wait surface: an empty exit file yields exitCode '' — also not a code.
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: 'Process exited with code .', exitCode: '' });
    const out2 = await executeCodingTool(mkCtx('auto'), 'wait_for_process_output', { handle: 'p1' });
    expect(out2.startsWith('[exited code=]')).toBe(true);
    expect(out2).not.toContain('The rail never killed it');
  });

  it('auto mode: the wait loses the process ground truth (worktree vanished mid-wait) — fails the command, NEVER claims KEEPS RUNNING (ticket e3f24291)', async () => {
    (waitForProcessOutput as jest.Mock).mockResolvedValue({
      outcome: 'not_found',
      detail: 'The wait could not reach the process\'s shell — treating the process as dead, NOT still running. Underlying error:\nOCI runtime exec failed: chdir to cwd("/app/coding-workspaces/worktrees/sess-1") failed: no such file or directory',
      exitCode: null,
    });
    const out = await executeCodingTool(mkCtx('auto'), 'run_command', { command: 'npm test' });
    expect(out).toContain('[command failed]');
    expect(out).toContain('OCI runtime exec failed');
    expect(out).not.toContain('SELF-STARTED MONITOR');
    expect(out).not.toContain('KEEPS RUNNING');
    expect(releaseHandle).toHaveBeenCalledWith('sess-1', 'p1'); // dead handle freed — no phantom slot
  });

  it('ask mode: plain foreground exec, no background rail', async () => {
    const out = await executeCodingTool(mkCtx('ask'), 'run_command', { command: 'echo ok' });
    expect(startBackgroundProcess).not.toHaveBeenCalled();
    expect(out).toBe('[command OK]\nfg-out'); // 2026-08-30: status banner leads
  });

  it('ask mode MACHINE-TRIGGERED run (no userTurnAt): mutating tools fail fast instead of stalling on the approval timeout', async () => {
    const ctx = { ...mkCtx('ask'), userTurnAt: undefined } as unknown as ToolContext;
    const out = await executeCodingTool(ctx, 'run_command', { command: 'echo ok' });
    expect(out).toMatch(/AUTO-DENIED/);
    expect(out).toMatch(/AUTO mode/);
    expect(startBackgroundProcess).not.toHaveBeenCalled();
  });

  it('ask mode machine-triggered run: READ-ONLY tools still work (only mutations are gated)', async () => {
    const ctx = { ...mkCtx('ask'), userTurnAt: undefined } as unknown as ToolContext;
    const out = await executeCodingTool(ctx, 'list_dir', {});
    expect(out).not.toMatch(/AUTO-DENIED/);
  });
});

describe('ASK_ONLY destructive platform tools (delete_chat/delete_project) — machine-run fail-fast', () => {
  const mkCtx = (permissionMode: string, over: Record<string, unknown> = {}) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode,
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: jest.fn(async () => 'deny' as const),
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...over,
  }) as unknown as ToolContext;

  it('machine-triggered AUTO run (no userTurnAt): delete_chat AUTO-DENIES instantly — requestApproval is never parked', async () => {
    const ctx = mkCtx('auto', { userTurnAt: undefined });
    const out = await executeCodingTool(ctx, 'delete_chat', { chat_id: 'c1' });
    expect(out).toMatch(/AUTO-DENIED/);
    expect((ctx as any).requestApproval).not.toHaveBeenCalled();
  });

  it('machine-triggered ASK run: delete_project also fails fast', async () => {
    const ctx = mkCtx('ask', { userTurnAt: undefined });
    const out = await executeCodingTool(ctx, 'delete_project', { project_id: 'p1' });
    expect(out).toMatch(/AUTO-DENIED/);
    expect((ctx as any).requestApproval).not.toHaveBeenCalled();
  });

  it('INTERACTIVE run (userTurnAt set): the human approval prompt is still consulted — behavior unchanged', async () => {
    const ctx = mkCtx('auto');
    const out = await executeCodingTool(ctx, 'delete_chat', { chat_id: 'c1' });
    expect((ctx as any).requestApproval).toHaveBeenCalledWith('delete_chat', { chat_id: 'c1' });
    expect(out).toMatch(/DENIED/);
  });
});

describe('schedule_self ask-mode warning copy', () => {
  const mkCtx = (permissionMode: string) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode,
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: jest.fn(async () => 'allow' as const),
    execShell: async () => ({ stdout: '', stderr: '' }),
  }) as unknown as ToolContext;

  it('ask mode: warns about INSTANT auto-deny — not the stale ~3.5-minute stall that no longer exists', async () => {
    const out = await executeCodingTool(mkCtx('ask'), 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
    expect(out).toContain('Scheduled (recurring, id sch1)');
    expect(out).toContain('AUTO-DENIED instantly');
    expect(out).not.toMatch(/3\.5 min/);
  });

  it('auto mode: no warning appended', async () => {
    const out = await executeCodingTool(mkCtx('auto'), 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
    expect(out).toContain('Scheduled (recurring, id sch1)');
    expect(out).not.toContain('WARNING');
  });

  it('a rejected schedule (e.g. over-length prompt) surfaces a LOUD, actionable result — not a silent wake loss (1d4c8a14)', async () => {
    (mockedCreateSchedule as jest.Mock).mockResolvedValueOnce({
      ok: false,
      error: 'prompt too long (9001 chars; max 8000). No schedule was created — shorten it and call again.',
    });
    const out = await executeCodingTool(mkCtx('auto'), 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'x'.repeat(9001) });
    expect(out).toContain('schedule_self FAILED');
    expect(out).toContain('no schedule was created');
    expect(out).toMatch(/max 8000/);
    expect(out).not.toContain('Scheduled (recurring'); // never looks like success
  });

  it('cap-cadence advisory (ticket 2694a581): a successful arm carrying a cap warning appends it to the success text', async () => {
    (mockedCreateSchedule as jest.Mock).mockResolvedValueOnce({
      ok: true,
      schedule: {
        id: 'sch1', kind: 'recurring', intervalSec: 1800,
        nextRunAt: '2026-09-18T18:30:00.000Z', expiresAt: '2026-10-18T18:00:00.000Z',
      },
      warning: "⚠️ CAP HEADROOM: this recurring alone projects ~48 firings/day — the chat's ENTIRE 48/day schedule budget.",
    });
    const out = await executeCodingTool(mkCtx('auto'), 'schedule_self', { kind: 'recurring', intervalMinutes: 30, prompt: 'tick' });
    expect(out).toContain('Scheduled (recurring, id sch1)');
    expect(out).toContain('⚠️ CAP HEADROOM');
    expect(out).toContain('ENTIRE 48/day schedule budget');
  });

  // ── One-shot CHAIN provenance (finding B1): the executor hop. A dropped
  // spread here would silently turn every chain link back into an unstamped
  // plain one-shot while the createSchedule tests stay green.
  describe('one-shot chain provenance hop (finding B1)', () => {
    const lastCreateArgs = () => (mockedCreateSchedule as jest.Mock).mock.calls.at(-1)?.[0];
    const machineCtx = (extra: Partial<ToolContext> = {}) =>
      ({ ...(mkCtx('auto') as any), userTurnAt: undefined, firedByScheduleId: 'sch_parent', ...extra }) as ToolContext;

    it('a machine `once` re-arm from a schedule firing passes chainedFromScheduleId = ctx.firedByScheduleId', async () => {
      await executeCodingTool(machineCtx(), 'schedule_self', { kind: 'once', intervalMinutes: 15, prompt: 'resume the probe' });
      expect(lastCreateArgs()).toMatchObject({ sessionId: 'sess-1', kind: 'once', chainedFromScheduleId: 'sch_parent', promptSetBy: 'machine' });
    });

    it('a USER-turn `once` arm never stamps a chain link (even with a stray firedByScheduleId)', async () => {
      await executeCodingTool(machineCtx({ userTurnAt: new Date() }), 'schedule_self', { kind: 'once', intervalMinutes: 15, prompt: 'resume the probe' });
      expect(lastCreateArgs().chainedFromScheduleId).toBeUndefined();
    });

    it('a RECURRING machine arm never stamps a chain link', async () => {
      await executeCodingTool(machineCtx(), 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
      expect(lastCreateArgs().chainedFromScheduleId).toBeUndefined();
    });

    it('a machine `once` arm on a non-schedule trigger (no firedByScheduleId) is a plain one-shot', async () => {
      await executeCodingTool(machineCtx({ firedByScheduleId: undefined }), 'schedule_self', { kind: 'once', intervalMinutes: 15, prompt: 'resume the probe' });
      expect(lastCreateArgs().chainedFromScheduleId).toBeUndefined();
    });
  });

  // audit 2026-10-06 T4-5 (schooltime.md F9): a userTurnAt alone is not owner
  // authorship — an owner-DISPATCH run (and a machine-classified run that
  // threaded an anchor) arms MODEL-authored rows, never "owner-armed".
  describe('schedule provenance (audit 2026-10-06 T4-5)', () => {
    const lastCreateArgs = () => (mockedCreateSchedule as jest.Mock).mock.calls.at(-1)?.[0];
    afterEach(() => { delete process.env.SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED; });

    it('a real user turn stamps promptSetBy user + ownerSubscribed', async () => {
      await executeCodingTool(mkCtx('auto'), 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
      expect(lastCreateArgs()).toMatchObject({ promptSetBy: 'user', ownerSubscribed: true });
    });

    it('an owner-dispatch run (userTurnAt + ownerDispatch) stamps machine, no subscription', async () => {
      await executeCodingTool({ ...(mkCtx('auto') as any), ownerDispatch: true } as ToolContext, 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'hourly Drive watch' });
      expect(lastCreateArgs().promptSetBy).toBe('machine');
      expect(lastCreateArgs().ownerSubscribed).toBeUndefined();
    });

    it('a machine-classified run that threaded a userTurnAt stamps machine', async () => {
      await executeCodingTool({ ...(mkCtx('auto') as any), machineTriggered: true } as ToolContext, 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
      expect(lastCreateArgs().promptSetBy).toBe('machine');
    });

    it('kill switch SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED=1 restores the userTurnAt-only stamp', async () => {
      process.env.SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED = '1';
      await executeCodingTool({ ...(mkCtx('auto') as any), ownerDispatch: true } as ToolContext, 'schedule_self', { kind: 'recurring', intervalMinutes: 60, prompt: 'tick' });
      expect(lastCreateArgs()).toMatchObject({ promptSetBy: 'user', ownerSubscribed: true });
    });
  });
});

describe('schedule_self busy-behavior doc (ticket b9cb221b: the stale "firing is skipped" claim taught lanes skip=death and drove cancel+re-arm churn)', () => {
  const desc = (): string => {
    const tool = (CODING_TOOL_SCHEMA as any[]).find((t) => t?.function?.name === 'schedule_self');
    return String(tool?.function?.description ?? '');
  };

  it('no longer claims a firing is skipped when a run is already active', () => {
    expect(desc()).not.toContain('a firing is skipped if a run is already active');
  });

  it('documents the real busy behavior: one-shot queues behind the active run; recurring re-arms with lastStatus skipped:busy; never auto-disabled for busy', () => {
    const d = desc();
    expect(d).toContain('queues behind it as a pending message');
    expect(d).toContain('skipped:busy');
    expect(d).toContain('NEVER auto-disabled');
  });
});

describe('edit_file literal replacement (feedback b6013de0: silent file corruption)', () => {
  const mkEditCtx = (dir: string) => ({
    worktree: dir, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: jest.fn(async () => 'allow' as const),
    execShell: async () => ({ stdout: '', stderr: '' }),
  }) as unknown as ToolContext;

  // The reported corruption (file doubled: stale pre-edit tail appended + a
  // replacement fragment stranded) is exactly what String.replace produces when
  // new_string contains the special patterns $' (post-match tail), $` (pre-match
  // head) or $& (the match). Replacement text must be inserted LITERALLY.
  it('inserts new_string containing $-patterns literally — no tail/head duplication', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editfile-b6013de0-'));
    try {
      const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
      await fs.writeFile(path.join(dir, 'state.md'), original, 'utf8');
      const newStr = "cost $100, owner said $'not yet' — see $& and $` notes";
      const out = await executeCodingTool(mkEditCtx(dir), 'edit_file', {
        path: 'state.md', old_string: 'line 2', new_string: newStr,
      });
      expect(out).toContain('Edited state.md');
      const after = await fs.readFile(path.join(dir, 'state.md'), 'utf8');
      // split/join computes the expectation LITERALLY (a .replace here would
      // re-interpret the dollar-patterns and corrupt the expected value itself).
      expect(after).toBe(original.split('line 2').join(newStr));
      expect(after.split('\n')).toHaveLength(10); // no duplicated file tail/head
      expect(after.match(/line 3/g)).toHaveLength(1); // tail not re-appended
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still replaces the first and only occurrence when the pattern is unique', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editfile-b6013de0-'));
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'alpha beta gamma', 'utf8');
      const out = await executeCodingTool(mkEditCtx(dir), 'edit_file', {
        path: 'a.txt', old_string: 'beta', new_string: 'BETA',
      });
      expect(out).toContain('Edited a.txt');
      expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha BETA gamma');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('write_file absolute-path handling (ticket c7591297: file-tool/shell split-brain)', () => {
  const mkWriteCtx = (dir: string) => ({
    worktree: dir, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: jest.fn(async () => 'allow' as const),
    execShell: async () => ({ stdout: '', stderr: '' }),
  }) as unknown as ToolContext;

  it('REJECTS an absolute path outside the worktree loudly — writes nothing, teaches the fix', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writefile-c7591297-'));
    try {
      const out = await executeCodingTool(mkWriteCtx(dir), 'write_file', {
        path: '/tmp/probe.sh', content: '#!/bin/bash\necho fresh\n',
      });
      expect(out).toMatch(/failed/i);
      expect(out).toMatch(/outside the worktree/);
      expect(out).toMatch(/run_command/);
      // The silent-remap landmine must NOT exist: nothing written to <worktree>/tmp.
      await expect(fs.access(path.join(dir, 'tmp', 'probe.sh'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honors an absolute path inside the worktree (no double-nesting)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writefile-c7591297-'));
    try {
      const out = await executeCodingTool(mkWriteCtx(dir), 'write_file', {
        path: path.join(dir, 'scratch', 'probe.sh'), content: '#!/bin/bash\necho ok\n',
      });
      expect(out).toContain('Wrote');
      expect(await fs.readFile(path.join(dir, 'scratch', 'probe.sh'), 'utf8')).toContain('echo ok');
      // Must not have created the old-style nested mirror path.
      await expect(fs.access(path.join(dir, dir.replace(/^\/+/, '')))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('relative paths still write inside the worktree (unchanged)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writefile-c7591297-'));
    try {
      const out = await executeCodingTool(mkWriteCtx(dir), 'write_file', {
        path: 'scratch/probe.sh', content: 'x',
      });
      expect(out).toContain('Wrote');
      expect(await fs.readFile(path.join(dir, 'scratch', 'probe.sh'), 'utf8')).toBe('x');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git_show (ticket 460806c6 — read PR-branch blobs with no shell)', () => {
  // Real temp repo: the tool reads blobs from the object store even when the
  // worktree has a DIFFERENT ref checked out — the exact researcher-role gap
  // (private-repo PR files are unreadable via read_file and 404 via raw URLs).
  let dir: string;
  const sh = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  const mkShowCtx = (): ToolContext => ({
    worktree: dir, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext);

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitshow-'));
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@example.com']);
    sh(['config', 'user.name', 't']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'main version\n');
    sh(['add', '.']);
    sh(['commit', '-qm', 'main commit']);
    sh(['checkout', '-qb', 'pr-branch']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'pr version\n');
    await fs.writeFile(path.join(dir, 'pr-only.md'), '# PR doc\nsecond line\n');
    await fs.writeFile(path.join(dir, 'empty.txt'), '');
    await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    sh(['add', '.']);
    sh(['commit', '-qm', 'pr commit']);
    sh(['checkout', '-q', '-']); // back to the base branch — pr-only.md is NOT on disk
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a blob from another branch that is not checked out in the worktree', async () => {
    await expect(fs.access(path.join(dir, 'pr-only.md'))).rejects.toThrow(); // premise: not on disk
    const out = await executeCodingTool(mkShowCtx(), 'git_show', { ref: 'pr-branch', path: 'pr-only.md' });
    expect(out).toContain('# PR doc');
    expect(out).toContain('second line');
  });

  it('same path, different content per ref; default ref is HEAD', async () => {
    const pr = await executeCodingTool(mkShowCtx(), 'git_show', { ref: 'pr-branch', path: 'a.txt' });
    const head = await executeCodingTool(mkShowCtx(), 'git_show', { path: 'a.txt' });
    expect(pr).toBe('pr version');
    expect(head).toBe('main version');
  });

  it('rejects flag-shaped ref/path (git option-injection guard, same as git_log)', async () => {
    expect(await executeCodingTool(mkShowCtx(), 'git_show', { ref: '--output=/tmp/x', path: 'a.txt' })).toMatch(/Invalid ref\/path/);
    expect(await executeCodingTool(mkShowCtx(), 'git_show', { path: '-foo' })).toMatch(/Invalid ref\/path/);
  });

  it('missing path is rejected with a usage hint', async () => {
    expect(await executeCodingTool(mkShowCtx(), 'git_show', {})).toMatch(/path is required/);
  });

  it('nonexistent path at a valid ref → "git show failed:" (never throws)', async () => {
    expect(await executeCodingTool(mkShowCtx(), 'git_show', { ref: 'pr-branch', path: 'nope.md' })).toMatch(/^git show failed:/);
  });

  it('empty file → explicit note instead of blank output', async () => {
    expect(await executeCodingTool(mkShowCtx(), 'git_show', { ref: 'pr-branch', path: 'empty.txt' })).toMatch(/empty file/);
  });

  it('binary blob → explicit note instead of mojibake', async () => {
    expect(await executeCodingTool(mkShowCtx(), 'git_show', { ref: 'pr-branch', path: 'bin.dat' })).toMatch(/binary file/);
  });
});

describe('git_log (ticket b3a35131 — path scoping, dates, ranges, shallow note)', () => {
  // Real temp repo: the tool must return the FULL per-file history (not one
  // boundary commit), each line dated, and rev ranges must pass the
  // option-injection guard — the exact gaps the explorer session hit.
  let dir: string;
  const sh = (args: string[], cwd?: string) => execFileSync('git', args, { cwd: cwd || dir, stdio: 'pipe' });

  const mkLogCtx = (worktree: string): ToolContext => ({
    worktree, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext);

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlog-'));
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 't@example.com']);
    sh(['config', 'user.name', 't']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha one\n');
    sh(['add', '.']); sh(['commit', '-qm', 'a: first']);
    await fs.writeFile(path.join(dir, 'b.txt'), 'bravo\n');
    sh(['add', '.']); sh(['commit', '-qm', 'b: only']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha two\n');
    sh(['add', '.']); sh(['commit', '-qm', 'a: second']);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('every line carries short-sha + ISO date + subject', async () => {
    const out = await executeCodingTool(mkLogCtx(dir), 'git_log', {});
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} /);
    expect(out).toContain('a: first');
    expect(out).toContain('a: second');
    expect(out).not.toMatch(/SHALLOW/);
  });

  it('path scoping returns the FULL history of commits touching the path (b3a35131 core)', async () => {
    const out = await executeCodingTool(mkLogCtx(dir), 'git_log', { path: 'a.txt', max: 100 });
    expect(out).toContain('a: first');
    expect(out).toContain('a: second');
    expect(out).not.toContain('b: only'); // never an unrelated commit
  });

  it('rev ranges like HEAD~1..HEAD are accepted (only flag-shaped revs are refused)', async () => {
    const out = await executeCodingTool(mkLogCtx(dir), 'git_log', { rev: 'HEAD~1..HEAD' });
    expect(out).toContain('a: second');
    expect(out).not.toContain('a: first');
    expect(await executeCodingTool(mkLogCtx(dir), 'git_log', { rev: '--all' })).toMatch(/Invalid rev\/path/);
  });

  it('a SHALLOW worktree gets an explicit truncation note instead of a misleading short list', async () => {
    // Depth-1 clone = the exact shape of a worktree backed by a shallow
    // project mirror: path-scoped log collapses to the boundary commit, which
    // used to read as "one unrelated commit" with no explanation.
    const shallowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlog-shallow-'));
    try {
      sh(['clone', '-q', '--depth', '1', `file://${dir}`, shallowDir], os.tmpdir());
      const out = await executeCodingTool(mkLogCtx(shallowDir), 'git_log', { path: 'a.txt' });
      expect(out).toMatch(/SHALLOW/);
      expect(out).toMatch(/GitHub/);
    } finally {
      await fs.rm(shallowDir, { recursive: true, force: true });
    }
  });
});

describe('search_memory scope widening (audit #11: learnings reachable via the tool)', () => {
  const { searchMemory: mockedSearchMemory } = jest.requireMock('./coding-retrieval.service');
  const { CODING_TOOL_SCHEMA } = require('./tools');

  const mkCtx = (projectId?: string) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto', projectId,
    emit: jest.fn(), alwaysAllow: new Set<string>(), userTurnAt: new Date(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext);

  beforeEach(() => (mockedSearchMemory as jest.Mock).mockClear().mockResolvedValue([]));

  it('schema advertises scope (session|project|all) + source so models can reach learnings', () => {
    const schema = CODING_TOOL_SCHEMA.find((t: any) => t.function?.name === 'search_memory')?.function;
    expect(schema).toBeTruthy();
    expect(schema.parameters.properties.scope.enum).toEqual(['session', 'project', 'all']);
    expect(schema.parameters.properties.source).toBeTruthy();
    expect(schema.parameters.required).toEqual(['query']);
    expect(schema.description).toContain('learnings.md');
  });

  it("schema names the knowledge-base ('document') and project-decision ('decision') sources (owner 2026-09-14)", () => {
    const schema = CODING_TOOL_SCHEMA.find((t: any) => t.function?.name === 'search_memory')?.function;
    expect(schema.description).toContain("'document'");
    expect(schema.description).toContain("'decision'");
    expect(schema.description).toMatch(/knowledge base/i);
    expect(schema.parameters.properties.source.description).toContain("'document'");
    expect(schema.parameters.properties.source.description).toContain("'decision'");
    expect(schema.parameters.properties.scope.description).toMatch(/knowledge-base documents, decisions/);
  });

  it('passes scope/projectId/source AND the caller userId (per-user memory gate) through to searchMemory (default scope all)', async () => {
    await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'nfs commit failure', source: 'learning' });
    expect(mockedSearchMemory).toHaveBeenCalledWith('sess-1', 'nfs commit failure', 6, {
      scope: 'all', projectId: 'proj-1', userId: 'u1', sources: ['learning'], includeArchive: true, // 2026-10-20 cold tier: the explicit tool tops up from the archive
      sameRunRecall: true, // 2026-10-31 RAG-1: the explicit tool recalls what this run just wrote
    });
    await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'q', scope: 'project' });
    expect(mockedSearchMemory).toHaveBeenLastCalledWith('sess-1', 'q', 6, {
      scope: 'project', projectId: 'proj-1', userId: 'u1', sources: undefined, includeArchive: true, sameRunRecall: true,
    });
  });

  it('a plain user-space chat (ctx.projectMemoryIsolated, 2026-10-20) forwards the flag; other contexts never carry it', async () => {
    await executeCodingTool({ ...mkCtx('userspace'), projectMemoryIsolated: true }, 'search_memory', { query: 'logo brief' });
    expect(mockedSearchMemory).toHaveBeenLastCalledWith('sess-1', 'logo brief', 6, {
      scope: 'all', projectId: 'userspace', userId: 'u1', sources: undefined, projectMemoryIsolated: true, includeArchive: true, sameRunRecall: true,
    });
    await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'q' });
    expect((mockedSearchMemory as jest.Mock).mock.calls.at(-1)[3].projectMemoryIsolated).toBeUndefined();
  });

  it('an isolated chat is TOLD the shared workspace memory was skipped (never reads [] as "searched, nothing there")', async () => {
    (mockedSearchMemory as jest.Mock).mockResolvedValue([]);
    const iso = await executeCodingTool({ ...mkCtx('userspace'), projectMemoryIsolated: true }, 'search_memory', { query: 'logo brief', scope: 'project' });
    expect(iso).toContain('ungrouped chat');
    expect(iso).toContain('NOT searched');
    const sess = await executeCodingTool({ ...mkCtx('userspace'), projectMemoryIsolated: true }, 'search_memory', { query: 'x', scope: 'session' });
    expect(sess).not.toContain('ungrouped chat');
    const plain = await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'x' });
    expect(plain).not.toContain('ungrouped chat');
  });

  it('renders knowledge-base hits with their document ref', async () => {
    (mockedSearchMemory as jest.Mock).mockResolvedValue([
      { ref: 'doc:d1#3', source: 'document', content: '[spec.pdf] The API must return 429 on quota exhaustion.' },
    ]);
    const out = await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'quota', source: 'document' });
    expect(out).toContain('[1] (document · doc:d1#3)');
    expect(out).toContain('[spec.pdf] The API must return 429');
  });

  it('an unknown scope value falls back to all (never crashes the tool)', async () => {
    await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'q', scope: 'everything' });
    expect(mockedSearchMemory).toHaveBeenLastCalledWith('sess-1', 'q', 6,
      expect.objectContaining({ scope: 'all' }));
  });

  it('scope project without a project explains itself instead of searching', async () => {
    const out = await executeCodingTool(mkCtx(undefined), 'search_memory', { query: 'q', scope: 'project' });
    expect(out).toMatch(/unavailable in this context/);
    expect(mockedSearchMemory).not.toHaveBeenCalled();
  });

  it('renders hits with source + ref prefixes', async () => {
    (mockedSearchMemory as jest.Mock).mockResolvedValue([
      { ref: 'learnings.md', source: 'learning', content: 'use curl REST — gh CLI is not installed' },
    ]);
    const out = await executeCodingTool(mkCtx('proj-1'), 'search_memory', { query: 'gh cli' });
    expect(out).toContain('[1] (learning · learnings.md)');
    expect(out).toContain('use curl REST');
  });
});

describe('idempotent push/PR on resume (audit #8 item 3)', () => {
  // Real temp repo (git_show pattern): the handlers read HEAD branch + sha
  // before consulting the guard, so the worktree must be a genuine repo.
  let dir: string;
  let headSha: string;
  const sh = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idempotent-push-'));
    sh(['init', '-q', '-b', 'digby/x']);
    sh(['config', 'user.email', 't@example.com']);
    sh(['config', 'user.name', 't']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'v1\n');
    sh(['add', '.']);
    sh(['commit', '-qm', 'c1']);
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** GitHub-project ctx. getGithubToken resolves per-call from `tokens` (shift). */
  const mkPushCtx = (tokens: Array<string | null>) => {
    const getGithubToken = jest.fn(async () => tokens.shift() ?? null);
    const ctx = {
      worktree: dir, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
      provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
      emit: jest.fn(), alwaysAllow: new Set<string>(),
      userTurnAt: new Date(),
      requestApproval: async () => 'allow' as const,
      execShell: async () => ({ stdout: '', stderr: '' }),
      getGithubToken,
    } as unknown as ToolContext;
    return { ctx, getGithubToken };
  };

  beforeEach(() => {
    mockFindPriorRunPushReceipt.mockReset().mockResolvedValue(null);
    mockFindPriorRunPrReceipt.mockReset().mockResolvedValue(null);
    mockPrHeadMatchesReceipt.mockReset().mockResolvedValue(false);
    mockPrReceiptHeadState.mockReset().mockResolvedValue(undefined);
  });

  it('git_push: a same-run receipt for the SAME branch+sha → honest [idempotent skip], never re-executes', async () => {
    mockFindPriorRunPushReceipt.mockResolvedValue({ id: 'rcp-push-1', ids: { branch: 'digby/x', sha: headSha } });
    const { ctx, getGithubToken } = mkPushCtx(['tok']);
    const out = await executeCodingTool(ctx, 'git_push', {});
    expect(out).toContain('[idempotent skip] already done in this run:');
    expect(out).toContain(`Pushed digby/x`);
    expect(out).toContain(`sha ${headSha}`);
    expect(out).toContain('receipt rcp-push-1');
    // The guard was consulted with the REAL checked-out branch + HEAD sha…
    expect(mockFindPriorRunPushReceipt).toHaveBeenCalledWith('sess-1', 'digby/x', headSha);
    // …and pushSessionBranch never ran (its token fetch is the observable seam).
    expect(getGithubToken).not.toHaveBeenCalled();
  });

  it('git_push: NO matching receipt → executes normally (falls through to pushSessionBranch)', async () => {
    const { ctx, getGithubToken } = mkPushCtx([null]); // no token → deterministic local result, no network
    const out = await executeCodingTool(ctx, 'git_push', {});
    expect(out).toContain('No connected GitHub account/token');
    expect(getGithubToken).toHaveBeenCalledTimes(1);
  });

  it('git_push: a guard failure fails OPEN to execution (never blocks a real push)', async () => {
    mockFindPriorRunPushReceipt.mockRejectedValue(new Error('db down'));
    const { ctx } = mkPushCtx([null]);
    const out = await executeCodingTool(ctx, 'git_push', {});
    expect(out).toContain('No connected GitHub account/token');
  });

  it('git_push: non-GitHub sessions never consult the guard', async () => {
    const { ctx } = mkPushCtx([null]);
    (ctx as any).provider = 'git';
    await executeCodingTool(ctx, 'git_push', {});
    expect(mockFindPriorRunPushReceipt).not.toHaveBeenCalled();
  });

  it('open_pull_request: a same-run PR receipt whose head GitHub CONFIRMS → [idempotent skip] with the PR identity', async () => {
    mockFindPriorRunPrReceipt.mockResolvedValue({ id: 'rcp-pr-1', ids: { prNumber: 7, url: 'https://github.com/o/r/pull/7' } });
    mockPrHeadMatchesReceipt.mockResolvedValue(true);
    const { ctx, getGithubToken } = mkPushCtx(['tok']);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(out).toContain('[idempotent skip] already done in this run:');
    expect(out).toContain('Opened PR #7: https://github.com/o/r/pull/7');
    expect(out).toContain('receipt rcp-pr-1');
    expect(mockPrHeadMatchesReceipt).toHaveBeenCalledWith('tok', 'o', 'r', 7, 'digby/x');
    // Only the handler's own token gate ran — pushSessionBranch (2nd token
    // fetch) never executed.
    expect(getGithubToken).toHaveBeenCalledTimes(1);
  });

  it('open_pull_request: head MISMATCH (new feature branch) → executes normally', async () => {
    mockFindPriorRunPrReceipt.mockResolvedValue({ id: 'rcp-pr-1', ids: { prNumber: 7, url: 'https://github.com/o/r/pull/7' } });
    mockPrHeadMatchesReceipt.mockResolvedValue(false);
    // 1st token = the handler gate; 2nd (inside pushSessionBranch) = null →
    // deterministic local fall-through proof without any network.
    const { ctx, getGithubToken } = mkPushCtx(['tok', null]);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(out).not.toContain('[idempotent skip]');
    expect(out).toContain('No connected GitHub account/token');
    expect(getGithubToken).toHaveBeenCalledTimes(2);
  });

  it('audit 2026-10-08 W2-5 REPLAY: this run\'s PR is already MERGED on the same head → no skip, the call executes (a follow-up PR)', async () => {
    mockFindPriorRunPrReceipt.mockResolvedValue({ id: 'rcp-pr-23', ids: { prNumber: 23, url: 'https://github.com/o/r/pull/23' } });
    mockPrReceiptHeadState.mockResolvedValue({ headMatches: true, state: 'closed', merged: true });
    const { ctx, getGithubToken } = mkPushCtx(['tok', null]);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(out).not.toContain('[idempotent skip]');
    expect(mockPrReceiptHeadState).toHaveBeenCalledWith('tok', 'o', 'r', 23, 'digby/x');
    expect(getGithubToken).toHaveBeenCalledTimes(2); // pushSessionBranch ran
  });

  it('audit 2026-10-08 W2-5: an OPEN PR on the same head still skips (state-returning path)', async () => {
    mockFindPriorRunPrReceipt.mockResolvedValue({ id: 'rcp-pr-7', ids: { prNumber: 7, url: 'https://github.com/o/r/pull/7' } });
    mockPrReceiptHeadState.mockResolvedValue({ headMatches: true, state: 'open', merged: false });
    const { ctx } = mkPushCtx(['tok']);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(out).toContain('[idempotent skip] already done in this run: Opened PR #7');
    expect(mockPrHeadMatchesReceipt).not.toHaveBeenCalled();
  });

  it('open_pull_request: no same-run PR receipt → GitHub is never consulted and the call executes', async () => {
    const { ctx } = mkPushCtx(['tok', null]);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(mockPrHeadMatchesReceipt).not.toHaveBeenCalled();
    expect(out).toContain('No connected GitHub account/token');
  });

  it('open_pull_request: a guard failure fails OPEN to execution', async () => {
    mockFindPriorRunPrReceipt.mockRejectedValue(new Error('db down'));
    const { ctx } = mkPushCtx(['tok', null]);
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(out).toContain('No connected GitHub account/token');
  });
});

describe('merge_pull_request: success telemetry + machine no-project owner card', () => {
  /** Merge ctx — repo passed as an arg, so no worktree/repoUrl is needed. */
  const mkMergeCtx = (over: Partial<Record<string, unknown>> = {}) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', runId: 'run-9', permissionMode: 'auto',
    projectId: 'p1', projectName: 'proj',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: jest.fn(async () => 'tok'),
    ...over,
  }) as unknown as ToolContext;

  beforeEach(() => {
    mockRecordLoopMetric.mockClear();
    mockFlagOwnerQuestion.mockClear().mockResolvedValue({ kind: 'created' });
    mockResolveSelfMergePolicy.mockClear().mockResolvedValue({ policy: 'on', source: 'setting' });
    mockCheckOrAskOwner.mockClear().mockResolvedValue('pending');
    mockEvaluateMergeGates.mockClear().mockResolvedValue({
      ok: true, alreadyMerged: false, headSha: 'headsha1234567890abcd', evidenceHash: 'ev1', evidenceNotes: ['gates green'],
    });
    mockReadAttempt.mockClear().mockResolvedValue({});
    mockClearAttempt.mockClear();
    mockDeleteMergedHeadBranch.mockClear().mockResolvedValue({ outcome: 'kept', branch: null });
    mockGithubApi.put.mockReset().mockResolvedValue({ status: 200, data: { merged: true, sha: 'mergesha1234' } });
    mockGithubApi.get.mockReset().mockResolvedValue({ data: { merged: true, merge_commit_sha: 'mergesha1234' } });
  });

  it('after a CONFIRMED merge the head-branch cleanup runs on the confirmation GET data and a deletion is appended to the success text', async () => {
    const confirmed = { merged: true, merge_commit_sha: 'mergesha1234', head: { ref: 'digby/session-x', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r', default_branch: 'main' } } };
    mockGithubApi.get.mockResolvedValue({ data: confirmed });
    mockDeleteMergedHeadBranch.mockResolvedValue({ outcome: 'deleted', branch: 'digby/session-x' });

    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 7 });

    expect(mockDeleteMergedHeadBranch).toHaveBeenCalledTimes(1);
    expect(mockDeleteMergedHeadBranch).toHaveBeenCalledWith({ api: mockGithubApi, owner: 'o', repo: 'r', pr: confirmed });
    expect(out).toContain('MERGED o/r#7');
    expect(out).toContain('confirmed merged:true by follow-up GET · head branch digby/session-x deleted.');
  });

  it('a kept / already-gone head adds no suffix, and a cleanup crash never fails the merge result', async () => {
    mockDeleteMergedHeadBranch.mockResolvedValue({ outcome: 'already_gone', branch: 'digby/session-x' });
    let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 8 });
    expect(out).toContain('MERGED o/r#8');
    expect(out).not.toContain('head branch');

    mockDeleteMergedHeadBranch.mockRejectedValue(new Error('network down'));
    out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 9 });
    expect(out).toContain('MERGED o/r#9');
    expect(out).not.toContain('head branch');
    expect(out).toContain('confirmed merged:true by follow-up GET.');
  });

  it('the cleanup never runs on a blocked / unconfirmed merge', async () => {
    mockGithubApi.get.mockResolvedValue({ data: { merged: false } }); // follow-up GET does not confirm
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 10 });
    expect(out).toContain('MERGE UNCONFIRMED');
    expect(mockDeleteMergedHeadBranch).not.toHaveBeenCalled();
  });

  it('a confirmed merged:true records ONE merge_success row — the counterpart of merge_gate_failure', async () => {
    mockReadAttempt.mockResolvedValue({ cycles: 2, lastGate: 'ci' }); // prior gate-failure cycles ride into meta
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 5 });

    expect(out).toContain('MERGED o/r#5');
    expect(mockClearAttempt).toHaveBeenCalledWith('sess-1', 'o/r', 5);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'merge_success', sessionId: 'sess-1', runId: 'run-9',
      meta: { repo: 'o/r', pullNumber: 5, mergeSha: 'mergesha1234', cycles: 2, machineTriggered: true },
    });
    // Success is not a gate failure.
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge_gate_failure' }));
  });

  it('a USER-triggered merge records machineTriggered:false (userTurnAt present)', async () => {
    const out = await executeCodingTool(mkMergeCtx({ userTurnAt: new Date() }), 'merge_pull_request', { repo: 'o/r', pullNumber: 6 });
    expect(out).toContain('MERGED o/r#6');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge_success',
      meta: expect.objectContaining({ pullNumber: 6, cycles: 0, machineTriggered: false }),
    }));
  });

  // ── WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27) ────────────────
  const HEAD = 'headsha1234567890abcd';
  const ciPending = () => ({ ok: false, gate: 'ci', cause: 'CI still running on the head sha', evidence: 'Backend tests: in_progress/-', suggestedFix: 'wait for the checks to finish, then retry', evidenceHash: 'evp', headSha: HEAD, transient: 'ci_pending' });
  const ciRed = () => ({ ok: false, gate: 'ci', cause: 'CI is RED on the head sha', evidence: 'Backend tests: completed/failure', suggestedFix: 'fix', evidenceHash: 'evr', headSha: HEAD });
  const green = () => ({ ok: true, alreadyMerged: false, headSha: HEAD, evidenceHash: 'ev1', evidenceNotes: ['gates green'] });
  const rowsOf = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind);

  beforeEach(() => {
    mockWaitOnceDisabled.mockReset().mockReturnValue(false);
    mockRepoCiP50Ms.mockReset().mockResolvedValue(null);
    mockAcquireWaitSlot.mockReset().mockReturnValue(true);
    mockReleaseWaitSlot.mockReset();
    mockMergeWaitSleep.mockReset().mockResolvedValue(undefined);
    mockWriteAttempt.mockClear();
  });

  it('WAIT-ONCE: a CI-PENDING gate failure is waited out once (deadline-shielded via ctx.onShieldedWait), the gates re-run, and a now-green PR merges with NO merge_gate_failure row — ONE merge_wait_once row + waitedHeadSha persisted', async () => {
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciPending()).mockResolvedValueOnce(green());
    mockRepoCiP50Ms.mockResolvedValue(4);
    const onShieldedWait = jest.fn();
    const out = await executeCodingTool(mkMergeCtx({ onShieldedWait }), 'merge_pull_request', { repo: 'o/r', pullNumber: 11 });

    expect(out).toContain('MERGED o/r#11');
    expect(out).toContain('harness waited');
    expect(mockEvaluateMergeGates).toHaveBeenCalledTimes(2);
    expect(mockMergeWaitSleep).toHaveBeenCalledTimes(1);
    expect(mockMergeWaitSleep).toHaveBeenCalledWith(8); // 2 × the repo p50 (mirrored mergeWaitOnceMs)
    expect(onShieldedWait).toHaveBeenCalledTimes(1);
    expect(onShieldedWait.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(mockReleaseWaitSlot).toHaveBeenCalledTimes(1);
    expect(mockWriteAttempt).toHaveBeenCalledWith('sess-1', 'o/r', 11, expect.objectContaining({ waitedHeadSha: HEAD }));
    expect(rowsOf('merge_wait_once')).toHaveLength(1);
    expect(rowsOf('merge_wait_once')[0]).toMatchObject({ sessionId: 'sess-1', runId: 'run-9', meta: { kind: 'ci_pending', repo: 'o/r', pullNumber: 11, headSha: HEAD, ciP50Ms: 4 } });
    expect(rowsOf('merge_gate_failure')).toHaveLength(0);
    expect(rowsOf('merge_success')).toHaveLength(1);
  });

  it('WAIT-ONCE: still pending after the one wait → MERGE BLOCKED as today, the merge_gate_failure row stamped with headSha + waitKind + waitedMs, the text naming the wait; a second call on the SAME head does not wait again', async () => {
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciPending()).mockResolvedValueOnce(ciPending());
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 12 });
    expect(out).toContain('MERGE BLOCKED (gate ci');
    expect(out).toContain('harness waited');
    expect(mockMergeWaitSleep).toHaveBeenCalledTimes(1);
    expect(mockMergeWaitSleep).toHaveBeenCalledWith(7); // no repo history → the mirrored default
    const failures = rowsOf('merge_gate_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ meta: { gate: 'ci', repo: 'o/r', pullNumber: 12, headSha: HEAD, waitKind: 'ci_pending' } });
    expect(typeof failures[0].meta.waitedMs).toBe('number');
    // The attempt record remembers the waited head — the retry on the same head bounces at once.
    mockRecordLoopMetric.mockClear();
    mockMergeWaitSleep.mockClear();
    mockReadAttempt.mockResolvedValueOnce({ cycles: 1, lastGate: 'ci', lastEvidenceHash: 'other', waitedHeadSha: HEAD });
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciPending());
    const again = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 12 });
    expect(again).toContain('MERGE BLOCKED (gate ci');
    expect(again).not.toContain('harness waited');
    expect(mockMergeWaitSleep).not.toHaveBeenCalled();
    expect(rowsOf('merge_gate_failure')[0].meta).toMatchObject({ headSha: HEAD });
    expect(rowsOf('merge_gate_failure')[0].meta.waitKind).toBeUndefined();
  });

  it('WAIT-ONCE never fires on a real work item (RED CI): the bounce is immediate and the row still carries headSha', async () => {
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciRed());
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 13 });
    expect(out).toContain('MERGE BLOCKED (gate ci');
    expect(mockMergeWaitSleep).not.toHaveBeenCalled();
    expect(mockEvaluateMergeGates).toHaveBeenCalledTimes(1);
    expect(rowsOf('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'ci', headSha: HEAD } });
  });

  it('WAIT-ONCE is skipped under SELF_MERGE_WAIT_ONCE_DISABLED=1 and when the concurrent-wait slots are exhausted (bounce as today, no slot leaked)', async () => {
    mockWaitOnceDisabled.mockReturnValue(true);
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciPending());
    let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 14 });
    expect(out).toContain('MERGE BLOCKED (gate ci');
    expect(mockMergeWaitSleep).not.toHaveBeenCalled();
    expect(mockAcquireWaitSlot).not.toHaveBeenCalled();

    mockWaitOnceDisabled.mockReturnValue(false);
    mockAcquireWaitSlot.mockReturnValue(false);
    mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(ciPending());
    out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 15 });
    expect(out).toContain('MERGE BLOCKED (gate ci');
    expect(mockMergeWaitSleep).not.toHaveBeenCalled();
    expect(mockReleaseWaitSlot).not.toHaveBeenCalled();
  });

  it('WAIT-ONCE on the merge API: a 405 "in progress" answer is waited out once, the gates re-run, ONE more PUT lands the merge (merge_wait_once kind merge_in_progress)', async () => {
    mockEvaluateMergeGates.mockReset().mockResolvedValue(green());
    mockGithubApi.put.mockReset()
      .mockResolvedValueOnce({ status: 405, data: { message: 'Base branch was modified. Review and try the merge again.' } })
      .mockResolvedValueOnce({ status: 200, data: { merged: true, sha: 'mergesha5678' } });
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 16 });
    expect(out).toContain('MERGED o/r#16');
    expect(out).toContain('harness waited');
    expect(mockGithubApi.put).toHaveBeenCalledTimes(2);
    expect(mockEvaluateMergeGates).toHaveBeenCalledTimes(2);
    expect(mockMergeWaitSleep).toHaveBeenCalledWith(3); // the mirrored API slice
    expect(rowsOf('merge_wait_once')[0]).toMatchObject({ meta: { kind: 'merge_in_progress', pullNumber: 16, headSha: HEAD } });
    expect(rowsOf('merge_gate_failure')).toHaveLength(0);
  });

  it('WAIT-ONCE on the merge API: a 5xx that persists after the wait bounces with gate merge_api + headSha + waitKind; a 422 (real refusal) never waits', async () => {
    mockEvaluateMergeGates.mockReset().mockResolvedValue(green());
    mockGithubApi.put.mockReset().mockResolvedValue({ status: 502, data: { message: 'Bad Gateway' } });
    let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 17 });
    expect(out).toContain('MERGE FAILED at the API step');
    expect(out).toContain('harness waited');
    expect(mockMergeWaitSleep).toHaveBeenCalledTimes(1);
    expect(rowsOf('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'merge_api', pullNumber: 17, headSha: HEAD, waitKind: 'server_5xx' } });

    mockRecordLoopMetric.mockClear();
    mockMergeWaitSleep.mockClear();
    mockGithubApi.put.mockReset().mockResolvedValue({ status: 422, data: { message: 'Pull Request is not mergeable' } });
    out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 18 });
    expect(out).toContain('MERGE FAILED at the API step');
    expect(mockMergeWaitSleep).not.toHaveBeenCalled();
    expect(rowsOf('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'merge_api', headSha: HEAD } });
    expect(rowsOf('merge_gate_failure')[0].meta.waitKind).toBeUndefined();
  });

  // ── MERGE-INTENT-AWAIT (2026-10-20): timing failures are QUEUED, not handed back ──
  // (The WAIT-ONCE pins above use a non-hex HEAD, which can never be queued — they
  // keep pinning today's bounce; these use a real sha.)
  describe('merge intents (MERGE-INTENT-AWAIT)', () => {
    const HEX = 'abcdef0123456789abcdef0123456789abcdef01';
    const pendingHex = (over: Record<string, unknown> = {}) => ({ ...ciPending(), headSha: HEX, ...over });
    const intentPuts = () => (mockedStorePut as jest.Mock).mock.calls.filter((c: any[]) => Array.isArray(c[0]) && c[0][0] === 'merge-intent');
    beforeEach(() => { (mockedStorePut as jest.Mock).mockClear(); delete process.env.MERGE_INTENT_QUEUE_DISABLED; });
    afterAll(() => { delete process.env.MERGE_INTENT_QUEUE_DISABLED; });

    it('CI still pending after the one wait ⇒ MERGE QUEUED (never "retry"), the intent stored on the exact head, merge_gate_failure stamped queued', async () => {
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(pendingHex()).mockResolvedValueOnce(pendingHex());
      const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 21 });
      expect(out).toMatch(/^MERGE QUEUED \(gate ci: CI still running on the head sha\)/);
      expect(out).toContain('merge intent for o/r#21 on head abcdef012345');
      expect(out).toContain('Do NOT poll or retry merge_pull_request');
      expect(out).toContain('harness waited');
      expect(out).not.toContain('MERGE BLOCKED');
      const puts = intentPuts();
      expect(puts).toHaveLength(1);
      expect(puts[0][1]).toBe('o/r#21');
      expect(puts[0][2]).toMatchObject({ v: 1, headSha: HEX, chatId: 'sess-1', userId: 'u1', projectId: 'p1', runId: 'run-9', waitKind: 'ci_pending', mergeMethod: 'squash' });
      expect(rowsOf('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'ci', pullNumber: 21, headSha: HEX, queued: true, waitKind: 'ci_pending' } });
      expect(mockWriteAttempt).toHaveBeenCalledTimes(1); // only the WAIT-ONCE head — no cycle counted for a queue
      // review fix: the backstop one-shot is enqueued on THIS chat before the intent is stored
      expect(mockEnqueueDirectWake).toHaveBeenCalledWith(expect.objectContaining({ targetChatId: 'sess-1', meta: expect.objectContaining({ wakeKind: 'merge_intent_backstop' }) }));
      expect(puts[0][2]).toMatchObject({ backstopHookEventId: 'bs-hook-1' });
    });

    it('review fix: a CI DISPATCH GAP is never queued — the lane gets the gate fix (push a commit / dispatch CI) at once', async () => {
      const gap = () => pendingHex({ cause: 'zero check-runs on the head sha in a repo WITH workflows that run on PR heads — a CI dispatch gap', suggestedFix: 'push a commit to the PR branch', dispatchGap: true });
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(gap()).mockResolvedValueOnce(gap());
      const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 26 });
      expect(out).toContain('MERGE BLOCKED (gate ci');
      expect(out).toContain('fix: push a commit to the PR branch');
      expect(out).not.toContain('MERGE QUEUED');
      expect(mockMergeWaitSleep).toHaveBeenCalledTimes(1); // WAIT-ONCE still waits it out once, as before
      expect(intentPuts()).toHaveLength(0);
    });

    it('review fix: an update-branch asked BEFORE the WAIT-ONCE is carried — the queued text still says pull; it is stored only when the intent head is the head it was asked on', async () => {
      const HEX2 = '1234567890abcdef1234567890abcdef12345678';
      // the update landed during the wait: the re-gate reads plain ci_pending on the NEW head
      mockEvaluateMergeGates.mockReset()
        .mockResolvedValueOnce(pendingHex({ gate: 'pr_state', cause: 'PR branch was BEHIND its base', branchUpdatedFrom: HEX }))
        .mockResolvedValueOnce(pendingHex({ headSha: HEX2 }));
      let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 27 });
      expect(out).toMatch(/^MERGE QUEUED/);
      expect(out).toContain('update-branch from abcdef012345');
      expect(intentPuts().at(-1)![2]).toMatchObject({ headSha: HEX2, updateBranchFrom: null });
      // not yet written: the re-gate still reads the old head ⇒ the update is recorded on the intent
      mockEvaluateMergeGates.mockReset()
        .mockResolvedValueOnce(pendingHex({ gate: 'pr_state', cause: 'PR branch was BEHIND its base', branchUpdatedFrom: HEX }))
        .mockResolvedValueOnce(pendingHex());
      out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 28 });
      expect(out).toContain('update-branch from abcdef012345');
      expect(intentPuts().at(-1)![2]).toMatchObject({ headSha: HEX, updateBranchFrom: HEX });
      expect(typeof intentPuts().at(-1)![2].updateBranchAt).toBe('string');
    });

    it('review fix: a chat that only refreshes ANOTHER chat’s same-head intent is told it is NOT woken (await_condition pr_merged), never "wakes this chat ONCE"', async () => {
      (mockedStoreGet as jest.Mock).mockImplementation(async (ns: string[], key: string) => (ns?.[0] === 'merge-intent' && key === 'o/r#29'
        ? { v: 1, key: 'o/r#29', owner: 'o', repo: 'r', pullNumber: 29, headSha: HEX, chatId: 'other-lane-77', userId: 'u1', projectId: 'p1', runId: null, mergeMethod: 'squash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextCheckAt: new Date().toISOString(), waitKind: 'ci_pending', lastGate: 'ci', lastCause: 'x', checks: 0, errors: 0, updateBranchFrom: null, updateBranchAt: null, backstopHookEventId: 'bs-other' }
        : null));
      mockWaitOnceDisabled.mockReturnValue(true);
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(pendingHex());
      const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 29 });
      expect(out).toMatch(/^MERGE QUEUED/);
      expect(out).toContain('session other-la already holds the harness merge intent');
      expect(out).toContain('This chat is NOT woken');
      expect(out).toContain('await_condition condition:"pr_merged" pullNumber:29');
      expect(out).not.toContain('wakes this chat ONCE');
      expect(intentPuts().at(-1)![2]).toMatchObject({ chatId: 'other-lane-77' });
      mockWaitOnceDisabled.mockReturnValue(false);
      (mockedStoreGet as jest.Mock).mockImplementation(async () => null);
    });

    it('a BEHIND branch the gates updated ⇒ queued with the update-branch note; a persisting 5xx at the merge API ⇒ queued too', async () => {
      mockWaitOnceDisabled.mockReturnValue(true);
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(pendingHex({ gate: 'pr_state', cause: 'PR branch was BEHIND its base', branchUpdatedFrom: HEX }));
      let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 22 });
      expect(out).toMatch(/^MERGE QUEUED \(gate pr_state/);
      expect(out).toContain('update-branch from abcdef012345');
      expect(intentPuts()[0][2]).toMatchObject({ updateBranchFrom: HEX });

      mockWaitOnceDisabled.mockReturnValue(false);
      mockEvaluateMergeGates.mockReset().mockResolvedValue({ ok: true, alreadyMerged: false, headSha: HEX, evidenceHash: 'e', evidenceNotes: ['green'] });
      mockGithubApi.put.mockReset().mockResolvedValue({ status: 502, data: { message: 'Bad Gateway' } });
      out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 23 });
      expect(out).toMatch(/^MERGE QUEUED \(gate merge_api: merge API answered 502/);
      expect(intentPuts().at(-1)![2]).toMatchObject({ waitKind: 'server_5xx', headSha: HEX });
    });

    it('a REAL failure (red CI) is never queued, and MERGE_INTENT_QUEUE_DISABLED=1 bounces a timing failure exactly as before', async () => {
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce({ ...ciRed(), headSha: HEX });
      let out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 24 });
      expect(out).toContain('MERGE BLOCKED (gate ci');
      expect(intentPuts()).toHaveLength(0);

      process.env.MERGE_INTENT_QUEUE_DISABLED = '1';
      mockEvaluateMergeGates.mockReset().mockResolvedValueOnce(pendingHex()).mockResolvedValueOnce(pendingHex());
      out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 25 });
      expect(out).toContain('MERGE BLOCKED (gate ci');
      expect(out).toContain('Retry merge_pull_request after you changed something');
      expect(intentPuts()).toHaveLength(0);
    });
  });

});

// ── await_condition (MERGE-INTENT-AWAIT, 2026-10-20) — the executor routes to await-condition.ts ──
describe('await_condition dispatch', () => {
  const mkCtx = (over: Record<string, unknown> = {}) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', runId: 'run-1', permissionMode: 'auto',
    repoUrl: 'https://github.com/o/r', provider: 'github',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: jest.fn(async () => 'tok'),
    onShieldedWait: jest.fn(), requestEndTurn: jest.fn(),
    ...over,
  }) as unknown as ToolContext;
  afterEach(() => { delete process.env.AWAIT_CONDITION_DISABLED; });

  it('is a real schema entry, answers a met condition with the verdict (no end-of-run), and refuses under its kill switch', async () => {
    expect(CODING_TOOL_SCHEMA.some((t: any) => t.function?.name === 'await_condition')).toBe(true);
    const { fetchCiStatus } = jest.requireMock('./ci-status') as { fetchCiStatus: jest.Mock };
    fetchCiStatus.mockResolvedValueOnce({ state: 'success', checks: [], failing: [], total: 1 });
    const ctx = mkCtx();
    const out = await executeCodingTool(ctx, 'await_condition', { condition: 'ci', sha: 'a'.repeat(40) });
    expect(out).toMatch(/^CONDITION MET \(CI on o\/r@aaaaaaaaaaaa finished/);
    expect((ctx as any).requestEndTurn).not.toHaveBeenCalled();
    process.env.AWAIT_CONDITION_DISABLED = '1';
    expect(await executeCodingTool(mkCtx(), 'await_condition', { condition: 'ci', sha: 'a'.repeat(40) })).toMatch(/^await_condition is disabled/);
    expect(await executeCodingTool(mkCtx({ getGithubToken: async () => null }), 'await_condition', { condition: 'ci' })).toMatch(/^await_condition is disabled/);
  });
});

// ── Working-tree checkpoints (harness roadmap item 7, 2026-09-19) ────────────
describe('rewind_to_step (working-tree checkpoints)', () => {
  const { EditCheckpoints } = jest.requireActual('./edit-checkpoints') as typeof import('./edit-checkpoints');
  const mkCtx = (dir: string, checkpoints?: any) => ({
    worktree: dir, sessionId: 'sess-ck', runId: 'run-ck', userId: 'u1', permissionMode: 'auto',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: jest.fn(async () => 'allow' as const),
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...(checkpoints ? { checkpoints } : {}),
  }) as unknown as ToolContext;

  it('write_file / edit_file snapshot per step; a rewind restores edited files, removes created ones, and reports honestly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-tools-'));
    const ckDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-store-'));
    try {
      await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 1;\n', 'utf8');
      const ck = new EditCheckpoints({ sessionId: 'sess-ck', runId: 'run-ck', baseDir: ckDir });
      const ctx = mkCtx(dir, ck);
      ck.setStep(1);
      await executeCodingTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
      ck.setStep(2);
      await executeCodingTool(ctx, 'write_file', { path: 'src/new.ts', content: 'export const n = 1;\n' });
      ck.setStep(3);
      await executeCodingTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'const a = 2;', new_string: 'const a = 3;' });
      const index = await executeCodingTool(ctx, 'rewind_to_step', {});
      expect(index).toMatch(/step 1: a.ts/);
      expect(index).toMatch(/step 2: src\/new.ts/);
      expect(index).toMatch(/step 3: a.ts/);
      const out = await executeCodingTool(ctx, 'rewind_to_step', { step: 2, reason: 'wrong turn' });
      expect(out).toMatch(/Rewound to before step 2/);
      expect(out).toMatch(/Restored: a.ts/);
      expect(out).toMatch(/Removed \(created by this run\): src\/new.ts/);
      expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const a = 2;\n'); // back to the step-1 result, not the original
      await expect(fs.stat(path.join(dir, 'src/new.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((ctx.emit as jest.Mock).mock.calls.filter(([e]) => e === 'file_changed').map(([, d]) => d)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'a.ts', action: 'write' }), expect.objectContaining({ path: 'src/new.ts', action: 'delete' }),
      ]));
      const again = await executeCodingTool(ctx, 'rewind_to_step', { step: 1 });
      expect(again).toMatch(/Restored: a.ts/);
      expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const a = 1;\n'); // original
      expect(await executeCodingTool(ctx, 'rewind_to_step', { step: 1 })).toMatch(/Nothing to rewind/);
      // No tracker (worker / chat / disabled) → an honest note, never a fake receipt.
      expect(await executeCodingTool(mkCtx(dir), 'rewind_to_step', { step: 1 })).toMatch(/not available in this run/);
      expect(MUTATING_TOOLS.has('rewind_to_step')).toBe(true);
      await ck.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(ckDir, { recursive: true, force: true });
    }
  });
});

// ── describePrDiff — the open_pull_request compare seam (tt-rd audit 2026-09-27) ──

describe('describePrDiff (PR diff shape + docs-only / duplicate / results-log notices)', () => {
  const LOG = 'results/2026-08-29-flash-next-device-legs.md';
  const NOW = new Date('2026-09-27T12:00:00Z');
  const H = 3_600_000;
  const target = { token: 'tok', owner: 'o', repo: 'r', base: 'main', head: 'digby/fold-41' };
  // `worktree` is present so the base-drift probe has a repo root (the tests
  // inject driftProbe, so no git is actually run).
  const machineCtx = { sessionId: 'sess-1', runId: 'run-9', worktree: '/wt' } as any;
  const humanCtx = { sessionId: 'sess-1', runId: 'run-9', userTurnAt: NOW, worktree: '/wt' } as any;
  const rcpt = (ids: Record<string, unknown>, agoMs: number) => ({ tool: 'open_pull_request', ok: true, ids, createdAt: new Date(NOW.getTime() - agoMs) });
  const strikes = (seam: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'guard_strike' && r?.meta?.seam === seam);
  const ENV = ['DOCS_ONLY_PR_ENFORCE'];

  beforeEach(() => { mockRecordLoopMetric.mockClear(); });
  afterEach(() => { for (const k of ENV) delete process.env[k]; });

  it('a first docs-only append: the [PR DIFF] line only — no notice, no strike, no refusal', async () => {
    const out = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => [{ filename: LOG, additions: 18, deletions: 0, status: 'modified' }], priorReceipts: async () => [] });
    expect(out).toMatchObject({ refusal: null, filesOnlyMd: true });
    expect(out!.tail).toMatch(/^\n\[PR DIFF\] 1 file · \+18\/−0 · docs-only · hash [0-9a-f]{16} · results\/2026-08-29-flash-next-device-legs\.md$/);
    expect(strikes('docs_only_pr')).toHaveLength(0);
  });

  it('a state-only PR (.digby/** only) gets the state-only [PR DIFF] line and is never noticed, struck or refused — even under DOCS_ONLY_PR_ENFORCE=1 on a machine run (fixer 2026-09-27, finding 2)', async () => {
    process.env.DOCS_ONLY_PR_ENFORCE = '1';
    const STATE = '.digby/rules/00-current-state.md';
    const files = [{ filename: STATE, additions: 12, deletions: 9, status: 'modified' }];
    // Two prior docs-only receipts on the SAME state file inside 24h — the pre-fixer class would refuse this.
    const prior = [rcpt({ prNumber: 850, filesOnlyMd: true, files: [STATE] }, 2 * H), rcpt({ prNumber: 849, filesOnlyMd: true, files: [STATE] }, 5 * H)];
    const out = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior });
    expect(out).toMatchObject({ refusal: null, filesOnlyMd: false });
    expect(out!.tail).toMatch(/^\n\[PR DIFF\] 1 file · \+12\/−9 · state-only · hash [0-9a-f]{16} · \.digby\/rules\/00-current-state\.md$/);
    expect(strikes('docs_only_pr')).toHaveLength(0);
    // a mixed state + results PR still notices on the RESULTS log (never the state file)
    const mixed = [...files, { filename: LOG, additions: 18, deletions: 0, status: 'modified' }];
    const m = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => mixed, priorReceipts: async () => [rcpt({ prNumber: 848, filesOnlyMd: true, files: [STATE, LOG] }, 3 * H)] });
    expect(m!.refusal).toMatch(/this PR only appends to results\/2026-08-29-flash-next-device-legs\.md/);
  });

  it('the Nth docs-only append on the same file in 24h: notice + guard_strike {seam docs_only_pr, observed}; the PR still opens (default)', async () => {
    const files = [{ filename: LOG, additions: 23, deletions: 0, status: 'modified' }];
    const prior = [rcpt({ prNumber: 840, filesOnlyMd: true, files: [LOG] }, 2 * H), rcpt({ prNumber: 839, filesOnlyMd: true, files: [LOG] }, 9 * H)];
    const out = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior });
    expect(out!.refusal).toBeNull();
    expect(out!.tail).toContain('[DOCS-ONLY PR NOTICE] this PR only appends to ' + LOG + ' (+23/−0), the 3rd such PR in 24h');
    expect(strikes('docs_only_pr')).toHaveLength(1);
    expect(strikes('docs_only_pr')[0]).toMatchObject({ sessionId: 'sess-1', runId: 'run-9', meta: { seam: 'docs_only_pr', state: 'observed', count: 3, file: LOG, machineRun: true, repo: 'o/r' } });
  });

  it('DOCS_ONLY_PR_ENFORCE=1 refuses on a MACHINE run only — a human turn still gets the notice', async () => {
    process.env.DOCS_ONLY_PR_ENFORCE = '1';
    const files = [{ filename: LOG, additions: 23, deletions: 0 }];
    const prior = [rcpt({ prNumber: 840, filesOnlyMd: true, files: [LOG] }, 2 * H)];
    const m = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior });
    expect(m!.refusal).toMatch(/^PR REFUSED \(DOCS_ONLY_PR_ENFORCE=1, machine run\)/);
    expect(strikes('docs_only_pr')[0].meta).toMatchObject({ state: 'enforced', machineRun: true });
    mockRecordLoopMetric.mockClear();
    const h = await describePrDiff(humanCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior });
    expect(h!.refusal).toBeNull();
    expect(h!.tail).toContain('[DOCS-ONLY PR NOTICE]');
    expect(strikes('docs_only_pr')[0].meta).toMatchObject({ state: 'observed', machineRun: false });
  });

  it('a duplicate re-open (same diff hash, prior PR still open) → notice naming the prior PR + its head branch, guard_strike {duplicate_pr}; a closed prior is silent', async () => {
    const files = [{ filename: 'models/gdn.py', additions: 4703, deletions: 12 }];
    const first = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => [] });
    const hash = first!.tail.match(/hash ([0-9a-f]{16})/)![1];
    const prior = [rcpt({ prNumber: 632, diffHash: hash, files: ['models/gdn.py'] }, 3 * 24 * H)];
    const asked: number[] = [];
    const dup = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior, prState: async (n) => { asked.push(n); return { state: 'open', headRef: 'digby/gdn-window-a' }; } });
    expect(asked).toEqual([632]);
    expect(dup!.tail).toContain('[DUPLICATE PR NOTICE] open PR #632 already carries this exact file set and line counts (its head branch: digby/gdn-window-a)');
    expect(strikes('duplicate_pr')).toHaveLength(1);
    expect(strikes('duplicate_pr')[0].meta).toMatchObject({ seam: 'duplicate_pr', state: 'observed', priorPrNumber: 632, diffHash: hash });
    mockRecordLoopMetric.mockClear();
    const closed = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => prior, prState: async () => ({ state: 'closed', headRef: null }) });
    expect(closed!.tail).not.toContain('[DUPLICATE PR NOTICE]');
    expect(strikes('duplicate_pr')).toHaveLength(0);
  });

  it('a results-log stub rewrite in the compare files → [RESULTS-LOG NOTICE] (pre-size read at the base ref) + guard_strike {results_log_truncate, at open_pull_request}', async () => {
    const patch = '@@ -1,4238 +1,20 @@\n' + Array.from({ length: 4238 }, (_, i) => (i % 25 === 0 ? '-## section' : '-| row | 5.08 |')).join('\n') + '\n' + Array.from({ length: 20 }, () => '+stub').join('\n');
    const files = [{ filename: LOG, additions: 20, deletions: 4238, status: 'modified', patch }];
    const sized: string[] = [];
    // the deleted rows are ~59 KB; an 80 KB pre-PR file loses ~73 % of its bytes
    const out = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => files, priorReceipts: async () => [], preBytes: async (p) => { sized.push(p); return 80_000; } });
    expect(sized).toEqual([LOG]);
    expect(out!.tail).toMatch(/\[RESULTS-LOG NOTICE\] results_log: results\/2026-08-29-flash-next-device-legs\.md −4238 lines \(170 sections, \+20\) = \d+% of its 80000 pre-PR bytes with NO archive file added/);
    expect(strikes('results_log_truncate')[0].meta).toMatchObject({ state: 'observed', at: 'open_pull_request', path: LOG, deleted: 4238, archiveMissing: true });
  });

  it('fails OPEN: no files / a compare error / a receipts error → null or the plain line', async () => {
    expect(await describePrDiff(machineCtx, target, { compareFiles: async () => null })).toBeNull();
    expect(await describePrDiff(machineCtx, target, { compareFiles: async () => { throw new Error('rate limited'); } })).toBeNull();
    const out = await describePrDiff(machineCtx, target, { now: NOW, compareFiles: async () => [{ filename: 'a.py', additions: 1, deletions: 0 }], priorReceipts: async () => { throw new Error('db down'); } });
    expect(out!.tail).toMatch(/^\n\[PR DIFF\] 1 file · \+1\/−0 · code · hash/);
  });

  // ── BASE DRIFT pre-flight (ticket 9d4ef436, family pr-diff-base-drift) ──
  // The incident: two Schooltime PRs built on a stale base opened merge-ready
  // PRs whose diff silently reverted another lane's merged work. The signal is
  // whole-file BLOB IDENTITY vs the base's own history (see pr-base-drift.ts
  // for the two mechanisms REFUTED before it).
  describe('base drift (ticket 9d4ef436)', () => {
    const BASE = 'main';
    // The PR's computed diff: the lane's own 2-file state edit PLUS three files
    // it "restores" to pre-#257 content because the branch is stale.
    const driftedFiles = [
      { filename: '.digby/rules/00-current-state.md', additions: 12, deletions: 0, status: 'modified' },
      { filename: 'results/2026-11-01-schooltime.md', additions: 4, deletions: 0, status: 'modified' },
      { filename: 'scripts/emulator-post.sh', additions: 0, deletions: 118, status: 'modified' },
      { filename: 'backend/src/emulator/gate.ts', additions: 0, deletions: 91, status: 'modified' },
      { filename: 'docs/EMULATOR.md', additions: 0, deletions: 52, status: 'modified' },
    ];
    /** A probe whose HEAD blob is an OLDER snapshot on base's history = a revert. */
    const reverted = async (path: string) => ({ mergedBlob: `old_${path}`, baseBlob: `tip_${path}`, historyBlobs: [`older`, `old_${path}`, `tip_${path}`] });
    /** A probe whose HEAD blob appears nowhere in base's history = an honest edit. */
    // base's work SURVIVES the merge ⇒ merged blob equals the base tip blob.
    const honest = async (path: string) => ({ mergedBlob: `tip_${path}`, baseBlob: `tip_${path}`, historyBlobs: [`tip_${path}`] });

    it('ACCEPTANCE 1 — a state-only change from a stale base FAILS the pre-flight, the drift named', async () => {
      const out = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => driftedFiles, priorReceipts: async () => [], driftProbe: reverted },
      );
      expect(out).not.toBeNull();
      expect(out!.refusal).toMatch(/^PR REFUSED \(base drift\):/);
      expect(out!.refusal).toContain('would silently REVERT');
      expect(out!.refusal).toContain('scripts/emulator-post.sh');
      expect(out!.refusal).toContain('git rebase origin/main');
      expect(out!.refusal).toContain('allowBaseDrift:true');
      expect(out!.refusal).toContain('nothing was opened');
      // harness STATE (.digby/**) is never probed or named — it is rewritten every firing
      expect(out!.refusal).not.toContain('.digby/rules/00-current-state.md');
      expect(out!.refusal).not.toContain('results/2026-11-01-schooltime.md');
      expect(out!.baseDrift).toBe(true);
      expect(strikes('base_drift')).toHaveLength(1);
      expect(strikes('base_drift')[0].meta).toMatchObject({ seam: 'base_drift', state: 'enforced', base: BASE, machineRun: true });
    });

    it('ACCEPTANCE 2 — a normal PR whose diff matches its head commit is UNAFFECTED', async () => {
      const files = [{ filename: 'backend/src/x.ts', additions: 12, deletions: 3, status: 'modified' }];
      const out = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => files, priorReceipts: async () => [], driftProbe: honest },
      );
      expect(out!.refusal).toBeNull();
      expect(out!.baseDrift).toBe(false);
      expect(out!.tail).toMatch(/^\n\[PR DIFF\] 1 file · \+12\/\u22123 · code · hash/);
      expect(strikes('base_drift')).toHaveLength(0);
    });

    it('THE REFUTED FILE-OVERLAP CLASS: a hot-file co-edit is NOT refused', async () => {
      // Measured on the repo's own lanes: that rule refused 10 of 17 honest
      // branches whose merge was CLEAN. A lane's own edit produces a blob the
      // base never had, so this must open.
      const out = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        {
          now: NOW, priorReceipts: async () => [],
          compareFiles: async () => [{ filename: 'AGENTS.md', additions: 3, deletions: 2 }],
          driftProbe: honest,
        },
      );
      expect(out!.refusal).toBeNull();
      expect(out!.baseDrift).toBe(false);
      expect(strikes('base_drift')).toHaveLength(0);
    });

    it('allowBaseDrift:true OVERRIDES: the PR opens with the drift notice + an `overridden` strike', async () => {
      const out = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => driftedFiles, priorReceipts: async () => [], driftProbe: reverted },
        { allowBaseDrift: true },
      );
      expect(out!.refusal).toBeNull();
      expect(out!.baseDrift).toBe(true);
      expect(out!.tail).toContain('[BASE DRIFT OVERRIDE] allowBaseDrift:true');
      expect(out!.tail).toMatch(/\[PR DIFF\]/);
      expect(strikes('base_drift')[0].meta).toMatchObject({ seam: 'base_drift', state: 'overridden' });
    });

    it('an unprobeable candidate is reported `incomplete` and never refuses', async () => {
      const out = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => [{ filename: 'src/a.ts', additions: 1, deletions: 4 }], priorReceipts: async () => [], driftProbe: async () => null },
      );
      expect(out!.refusal).toBeNull();
      expect(strikes('base_drift')[0].meta).toMatchObject({ seam: 'base_drift', state: 'incomplete' });
    });

    it('fails OPEN when the probe throws or returns nothing — a missing read never refuses a PR', async () => {
      const thrown = await describePrDiff(
        machineCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => driftedFiles, priorReceipts: async () => [], driftProbe: async () => { throw new Error('git failed'); } },
      );
      expect(thrown!.refusal).toBeNull();
      expect(strikes('base_drift')).toHaveLength(0);
    });

    it('probes ONLY files the PR deletes from (a pure-addition PR cannot revert anything)', async () => {
      const probed: string[] = [];
      await describePrDiff(
        machineCtx, { ...target, base: BASE },
        {
          now: NOW, priorReceipts: async () => [],
          compareFiles: async () => [
            { filename: 'src/added-only.ts', additions: 50, deletions: 0 },
            { filename: 'src/edited.ts', additions: 2, deletions: 9 },
          ],
          driftProbe: async (p: string) => { probed.push(p); return honest(p); },
        },
      );
      expect(probed).toEqual(['src/edited.ts']);
    });

    it('a HUMAN turn is refused too: the drift is a mechanical fact, not a machine-run restriction', async () => {
      const out = await describePrDiff(
        humanCtx, { ...target, base: BASE },
        { now: NOW, compareFiles: async () => driftedFiles, priorReceipts: async () => [], driftProbe: reverted },
      );
      expect(out!.refusal).toMatch(/^PR REFUSED \(base drift\):/);
      expect(strikes('base_drift')[0].meta).toMatchObject({ state: 'enforced', machineRun: false });
    });
  });
});

describe('view_image (2026-10-01) — executeCodingTool routes to the Image reader seat through the session shell', () => {
  // A 2x2 PNG header (signature + IHDR) — enough for the magic-byte check and the dimension read.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000200000002080200000000000000', 'hex');
  const shellFor = (commands: string[]) => async (command: string) => {
    commands.push(command);
    if (command.includes('stat -L -c %s')) return { stdout: `__VIEW_IMAGE_SIZE__${PNG.length}\n`, stderr: '' };
    return { stdout: `__VIEW_IMAGE_B64_BEGIN__\n${PNG.toString('base64')}\n__VIEW_IMAGE_B64_END__\n`, stderr: '' };
  };
  beforeEach(() => mockAnswerImageQuestion.mockReset());

  test('a file outside the worktree is read via ctx.execShell with the shq-quoted path, and the answer is labelled', async () => {
    const commands: string[] = [];
    const { ctx } = captureCtx();
    mockAnswerImageQuestion.mockResolvedValue({ answer: 'White: Kg1, Qd1 …', model: 'glm-5.3-flash' });
    const out = await executeCodingTool({ ...ctx, execShell: shellFor(commands) } as ToolContext, 'view_image', { path: '/app/chess_board.png', question: 'list every piece and its square' });
    expect(out).toBe('[view_image — glm-5.3-flash read /app/chess_board.png (2x2)]\nWhite: Kg1, Qd1 …');
    expect(commands).toHaveLength(2);
    for (const c of commands) expect(c).toContain("-- '/app/chess_board.png'");
    expect(mockAnswerImageQuestion).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'chess_board.png', 'list every piece and its square', { userId: 'u1' });
  });

  test('it is a READ tool: not gated, and it runs in PLAN mode', async () => {
    expect(MUTATING_TOOLS.has('view_image')).toBe(false);
    expect((CODING_TOOL_SCHEMA as any[]).some((t) => t?.function?.name === 'view_image')).toBe(true);
    const commands: string[] = [];
    const { ctx } = captureCtx();
    mockAnswerImageQuestion.mockResolvedValue({ answer: 'ok', model: 'm' });
    const out = await executeCodingTool({ ...ctx, permissionMode: 'plan', execShell: shellFor(commands) } as ToolContext, 'view_image', { path: 'shots/a.png' });
    expect(out).toMatch(/^\[view_image — m read shots\/a\.png \(2x2\)\]\nok$/);
  });
});

// ── audit 2026-10-06 T7-7 — run_command workspace-scope guard at the tool seam ──
describe('run_command / start_background_process workspace-scope guard (T7-7)', () => {
  const { startBackgroundProcess } = jest.requireMock('./process.service');
  const mkCtx = (exposure: 'dev_container' | 'whole_volume' | null, shell = jest.fn(async () => ({ stdout: 'ran', stderr: '' }))) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode: 'ask', projectId: 'p1',
    // ask mode + a user turn: the approval resolves 'allow' and the FOREGROUND shell runs (observable).
    emit: jest.fn(), alwaysAllow: new Set<string>(), userTurnAt: new Date(),
    requestApproval: async () => 'allow' as const,
    execShell: shell,
    workspaceExposure: () => exposure,
  } as unknown as ToolContext);
  const prev = process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED;
  beforeEach(() => { delete process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED; mockRecordLoopMetric.mockClear(); (startBackgroundProcess as jest.Mock).mockClear(); });
  afterAll(() => { if (prev === undefined) delete process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED; else process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED = prev; });

  it('dev container: listing other sessions is refused before anything executes + one guard_strike row', async () => {
    const shell = jest.fn(async () => ({ stdout: 'LEAK', stderr: '' }));
    const out = await executeCodingTool(mkCtx('dev_container', shell), 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(out.startsWith('[command REFUSED — workspace scope] NOTHING was executed.')).toBe(true);
    expect(shell).not.toHaveBeenCalled();
    const row = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r: any) => r.meta?.seam === 'run_command_workspace_scope');
    expect(row).toMatchObject({ kind: 'guard_strike', sessionId: 'sess-1', meta: { state: 'refused', exposure: 'dev_container', reason: 'workspace_root', machine: false, tool: 'run_command' } });
  });

  it("dev container: the session's own worktree + its project mirror run normally", async () => {
    const shell = jest.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const out = await executeCodingTool(mkCtx('dev_container', shell), 'run_command', { command: `git -C ${WT} status && git --git-dir=/app/coding-workspaces/repos/p1.git log -1 && ls src/*.ts` });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it('a scoped container (exposure null) is never judged — the command runs as before', async () => {
    const shell = jest.fn(async () => ({ stdout: 'nothing there', stderr: '' }));
    const out = await executeCodingTool(mkCtx(null, shell), 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it('start_background_process is guarded the same way', async () => {
    const out = await executeCodingTool(mkCtx('whole_volume'), 'start_background_process', { command: 'for d in /app/coding-workspaces/worktrees/*/; do git -C $d log; done' });
    expect(out.startsWith('[command REFUSED — workspace scope]')).toBe(true);
    expect(startBackgroundProcess).not.toHaveBeenCalled();
  });

  it("same owner: an explicit path into the owner's OTHER session runs; another user's session and the container listing still refuse", async () => {
    mockSameOwnerSessions.mockResolvedValueOnce([{ id: 'sess-2', projectId: 'p2' }, { id: 'sess-1', projectId: 'p1' }]);
    const shell = jest.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const ok = await executeCodingTool({ ...mkCtx('dev_container', shell), userId: 'u-same-owner' } as ToolContext, 'run_command', { command: 'ls -la /app/coding-workspaces/worktrees/sess-2/.scratch && git --git-dir=/app/coding-workspaces/repos/p2.git log -1' });
    expect(ok.startsWith('[command OK]')).toBe(true);
    const foreign = await executeCodingTool({ ...mkCtx('dev_container', shell), userId: 'u-same-owner' } as ToolContext, 'run_command', { command: 'ls /app/coding-workspaces/worktrees/sess-other-user/' });
    expect(foreign.startsWith('[command REFUSED — workspace scope]')).toBe(true);
    const listing = await executeCodingTool({ ...mkCtx('dev_container', shell), userId: 'u-same-owner' } as ToolContext, 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(listing.startsWith('[command REFUSED — workspace scope]')).toBe(true);
  });

  it('a remote command (run-on-box.sh / ssh) is never read as a local traversal', async () => {
    const shell = jest.fn(async () => ({ stdout: 'remote', stderr: '' }));
    const out = await executeCodingTool(mkCtx('dev_container', shell), 'run_command', { command: `bash scripts/framework-audit/run-on-box.sh A 'echo ---; sudo find / -name "x*" 2>/dev/null | head -5'` });
    expect(out.startsWith('[command OK]')).toBe(true);
  });

  it('RUN_COMMAND_WORKSPACE_GUARD_DISABLED=1 restores the unguarded run (kill switch)', async () => {
    process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED = '1';
    const shell = jest.fn(async () => ({ stdout: 'listing', stderr: '' }));
    const out = await executeCodingTool(mkCtx('dev_container', shell), 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.meta?.seam === 'run_command_workspace_scope')).toBe(false);
  });
});

// ── build 2026-10-08 ISO — the guard is the transitional BACKSTOP: observe-only where the shell sees one user's subtree ──
describe('run_command workspace-scope guard under a per-user SUBTREE exposure (ISO)', () => {
  const mkCtx = (exposure: 'dev_container' | 'user_subtree', shell = jest.fn(async () => ({ stdout: 'ran', stderr: '' }))) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u-iso', permissionMode: 'ask', projectId: 'p1',
    emit: jest.fn(), alwaysAllow: new Set<string>(), userTurnAt: new Date(),
    requestApproval: async () => 'allow' as const,
    execShell: shell,
    workspaceExposure: () => exposure,
  } as unknown as ToolContext);
  const strike = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r: any) => r.meta?.seam === 'run_command_workspace_scope');
  beforeEach(() => { delete process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED; mockRecordLoopMetric.mockClear(); });

  it('stanne.md #1 replay (`ls <root>/worktrees/`): RUNS under user_subtree, recorded as observed with reachesData 0', async () => {
    const shell = jest.fn(async () => ({ stdout: '(only this user\'s mounts)', stderr: '' }));
    const out = await executeCodingTool(mkCtx('user_subtree', shell), 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(strike()).toMatchObject({ kind: 'guard_strike', meta: { state: 'observed', outcome: 'observed', exposure: 'user_subtree', reason: 'workspace_root', crossTenant: 1, reachesData: 0 } });
  });

  it('the 10-08 20:56Z false-positive class (`find / -maxdepth 6 …`) no longer blocks a subtree shell', async () => {
    const shell = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const out = await executeCodingTool(mkCtx('user_subtree', shell), 'run_command', { command: 'find / -maxdepth 6 \\( -name "initdb" -o -name "postgres" \\) -type f 2>/dev/null | head -10' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(strike()).toMatchObject({ meta: { state: 'observed', reason: 'ancestor_traversal', reachesData: 0 } });
  });

  it('the WHOLE-VOLUME dev container still refuses (backstop) and the strike says the listing reached every tenant', async () => {
    const shell = jest.fn(async () => ({ stdout: 'LEAK', stderr: '' }));
    const out = await executeCodingTool(mkCtx('dev_container', shell), 'run_command', { command: 'ls /app/coding-workspaces/worktrees/' });
    expect(out.startsWith('[command REFUSED — workspace scope]')).toBe(true);
    expect(shell).not.toHaveBeenCalled();
    expect(strike()).toMatchObject({ meta: { state: 'refused', exposure: 'dev_container', crossTenant: 1, reachesData: 1 } });
  });
});

// ── ticket aa6b6da2 — run_command credential-name near-miss notice at the tool seam ──
// Incident replay: a lane reading a MISSPELLED injected-credential name saw it as
// empty across ~70 invocations and concluded the injection was flaky (it never
// failed). The guard appends a notice to the command result (never blocks); the
// status banner still LEADS (receipt-parser back-compat).
describe('run_command credential-name near-miss notice (aa6b6da2)', () => {
  const CREDS = ['AWS_ACCESS_KEY_ID_DIGBYOPERATOR', 'AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR', 'HYPERSTACK_SSH_PRIVATE_KEY'];
  const mkCtx = (over: Record<string, unknown> = {}) => ({
    worktree: WT, sessionId: 'sess-1', userId: 'u1', permissionMode: 'ask',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: 'out', stderr: '' }),
    ...over,
  } as unknown as ToolContext);
  const prevGuard = process.env.CREDENTIAL_NAME_GUARD_DISABLED;
  beforeEach(() => { delete process.env.CREDENTIAL_NAME_GUARD_DISABLED; mockRecordLoopMetric.mockClear(); });
  afterAll(() => { if (prevGuard === undefined) delete process.env.CREDENTIAL_NAME_GUARD_DISABLED; else process.env.CREDENTIAL_NAME_GUARD_DISABLED = prevGuard; });

  it('appends the notice after the banner when the command uses a misspelled credential name; banner still leads + one guard_strike row', async () => {
    const out = await executeCodingTool(mkCtx({ credentialEnvNames: CREDS }), 'run_command',
      { command: 'ak="${AWS_ACCESS_KEY_ID_DIGIBYOPERATOR:-}"; echo "ak=${#ak}"' });
    expect(out.startsWith('[command OK]')).toBe(true); // banner leads — receipt parser contract
    expect(out).toContain('[credential name notice]');
    expect(out).toContain('"AWS_ACCESS_KEY_ID_DIGIBYOPERATOR"');
    expect(out).toContain('"AWS_ACCESS_KEY_ID_DIGBYOPERATOR"');
    const row = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r: any) => r.meta?.seam === 'run_command_credential_name');
    expect(row).toMatchObject({ kind: 'guard_strike', sessionId: 'sess-1', meta: { state: 'observed', names: ['AWS_ACCESS_KEY_ID_DIGIBYOPERATOR'] } });
  });

  it('NO notice when the command uses the exact injected names (no false positives)', async () => {
    const out = await executeCodingTool(mkCtx({ credentialEnvNames: CREDS }), 'run_command',
      { command: 'printf "ak_len=%s" "${#AWS_ACCESS_KEY_ID_DIGBYOPERATOR}"' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(out).not.toContain('[credential name notice]');
  });

  it('NO notice when ctx.credentialEnvNames is absent (chat-pipeline / test contexts — guard inert)', async () => {
    const out = await executeCodingTool(mkCtx(), 'run_command',
      { command: 'echo ${AWS_ACCESS_KEY_ID_DIGIBYOPERATOR:-}' });
    expect(out).not.toContain('[credential name notice]');
  });

  it('kill switch CREDENTIAL_NAME_GUARD_DISABLED=1 silences the notice', async () => {
    process.env.CREDENTIAL_NAME_GUARD_DISABLED = '1';
    try {
      const out = await executeCodingTool(mkCtx({ credentialEnvNames: CREDS }), 'run_command',
        { command: 'echo ${AWS_ACCESS_KEY_ID_DIGIBYOPERATOR:-}' });
      expect(out).not.toContain('[credential name notice]');
    } finally {
      delete process.env.CREDENTIAL_NAME_GUARD_DISABLED;
    }
  });

  it('REVIEWER F2 — on a failing near-miss command the exit marker stays the LAST line (tail contract)', async () => {
    const out = await executeCodingTool(mkCtx({
      credentialEnvNames: CREDS,
      execShell: async () => ({ stdout: 'boom', stderr: '[exit: 3]' }),
    }), 'run_command', { command: 'echo ${AWS_ACCESS_KEY_ID_DIGIBOPERATOR:-}' });
    expect(out.startsWith('[command FAILED — exit 3]')).toBe(true);
    expect(out).toContain('[credential name notice]');
    expect(out.trimEnd().endsWith('[exit: 3]')).toBe(true); // marker LAST — learnings-index EXIT_MARKER_TAIL_RE anchors at $
  });

  it('REVIEWER F6 — house parser: CREDENTIAL_NAME_GUARD_DISABLED=0 / false does NOT silence the notice', async () => {
    process.env.CREDENTIAL_NAME_GUARD_DISABLED = '0';
    try {
      const out = await executeCodingTool(mkCtx({ credentialEnvNames: CREDS }), 'run_command',
        { command: 'echo ${AWS_ACCESS_KEY_ID_DIGIBYOPERATOR:-}' });
      expect(out).toContain('[credential name notice]');
    } finally { delete process.env.CREDENTIAL_NAME_GUARD_DISABLED; }
  });

  it('REVIEWER F3 — the documented remediation shape (base wired from the suffixed name) draws NO notice at the tool seam', async () => {
    const out = await executeCodingTool(mkCtx({ credentialEnvNames: CREDS }), 'run_command',
      { command: 'export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID_DIGBYOPERATOR" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR" AWS_REGION=ca-central-1 && aws sts get-caller-identity' });
    expect(out).not.toContain('[credential name notice]');
  });

  it('a FAILING command keeps its FAILED banner and still gets the notice (both lead-critical parts survive)', async () => {
    const out = await executeCodingTool(mkCtx({
      credentialEnvNames: CREDS,
      execShell: async () => ({ stdout: '', stderr: 'boom\n[exit: 3]' }),
    }), 'run_command', { command: 'echo ${AWS_SECRET_ACCESS_KEY_DIGIBYOPERATOR:-}' });
    expect(out.startsWith('[command FAILED — exit 3]')).toBe(true);
    expect(out).toContain('[credential name notice]');
    expect(out).toContain('"AWS_SECRET_ACCESS_KEY_DIGIBYOPERATOR"');
  });

  it('auto mode (background rail): the notice rides after the banner + exit note too', async () => {
    const { startBackgroundProcess, waitForProcessOutput, readProcessOutput, releaseHandle } = jest.requireMock('./process.service');
    (startBackgroundProcess as jest.Mock).mockResolvedValue({ handle: 'p9', name: 'cmd: x', pgid: 1, logPath: '/tmp/p9.log' });
    (waitForProcessOutput as jest.Mock).mockResolvedValue({ outcome: 'exited', detail: '', exitCode: '0' });
    (readProcessOutput as jest.Mock).mockResolvedValue({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' });
    (releaseHandle as jest.Mock).mockClear();
    const out = await executeCodingTool(mkCtx({ permissionMode: 'auto', credentialEnvNames: CREDS }), 'run_command',
      { command: 'echo ${AWS_ACCESS_KEY_ID_DIGIBOPERATOR:-}' });
    expect(out.startsWith('[command OK]')).toBe(true);
    expect(out).toContain('[credential name notice]');
    expect(out).toContain('"AWS_ACCESS_KEY_ID_DIGIBOPERATOR"');
  });
});
