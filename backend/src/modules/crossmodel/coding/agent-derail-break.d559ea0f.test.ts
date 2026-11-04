/**
 * Replay pin — ticket d559ea0f (mishap, lead of the tool-failure-streak
 * family, breaker trip filed 2026-10-26T05:18Z; session 7927f037-563c-46f9-
 * bca9-fd0f58d1f14f "family tool-failure-streak: 1 tickets (l", run
 * 470157f9-c679-4dab-a37a-25ac117b8032; tool edit_file; first streak this run).
 *
 * THE INCIDENT (filed failure texts, newest first):
 *   1. `Tool edit_file failed: EISDIR: illegal operation on a directory, read`
 *   2. `old_string not found in backend/src/modules/crossmodel/coding/
 *      edit-file-hint.f7d0dfe9.test.ts. Read the file and match exactly.
 *      [edit_file hint: nearest match is 100% similar at lines 24–24 but
 *      line 24 differs at col 23: the file's docstring-close tail (a path-
 *      token line ending in a star-slash) … — copy the file's line 24
 *      byte-exactly]` ×2
 *
 * SPLIT ADJUDICATION (this lane, 2026-10-27; the ticket body carries the
 * call args verbatim):
 *  A. THE EISDIR LEG IS A FRAMEWORK DEFECT. The newest call args show NO
 *     `path` key at all — only {old_string, new_string}. resolveInside's
 *     `path.resolve(root, rel)` coerces the missing path to the WORKTREE
 *     ROOT (a directory), and edit_file's raw `fs.readFile(abs)` dies with
 *     EISDIR — an errno that names nothing the model controls. A missing
 *     argument should be refused AS a missing argument, deterministically,
 *     with the recovery named. THE FIX: rootPathRefusal (tools.ts) — when
 *     the path resolves lexically to the worktree root (missing/empty/'.'),
 *     read_file / write_file / edit_file return an in-band missing-argument
 *     refusal naming the fix; NO change to any other path's surface.
 *  B. THE TWO HINT LEGS ARE MODEL BEHAVIOR — already adjudicated and pinned
 *     by edit-file-hint.f7d0dfe9.test.ts (phantom content: the model's
 *     "yours" lines quote docstring shapes the file never had). This suite
 *     does NOT re-pin them; it only pins that the SAME call shape (old_string
 *     quoting the file's line 24 tail with a phantom prefix) still gets the
 *     honest miss envelope on a REAL file.
 *
 * CONTRACT PRESERVATION (ticket 8e900af9, pinned 2026-09-20): an EXPLICIT
 * sub-directory path ('backend/src/modules/crossmodel/coding') is a model-
 * authored bad arg and keeps its byte-exact raw EISDIR
 * (`Tool edit_file failed: EISDIR: illegal operation on a directory, read`)
 * — agent-derail-break.8e900af9.test.ts pins it; the boundary leg below
 * re-asserts it here so the two contracts are provably disjoint.
 *
 * Boundary mock discipline copied verbatim from
 * agent-derail-break.8e900af9.test.ts (the tools.ts import graph).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// listdir-enoent.4bf65e24.test.ts / agent-derail-break.8e900af9.test.ts (the
// tools.ts import graph reaches config/env, which process.exit(1)s without env).
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
  },
}));
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: jest.fn(async (): Promise<any> => ({ policy: 'on', source: 'setting' })),
  checkOrAskOwner: jest.fn(async (): Promise<any> => 'pending'),
  evaluateMergeGates: jest.fn(async (): Promise<any> => ({ ok: true, alreadyMerged: false, headSha: 'x', evidenceHash: 'e', evidenceNotes: [] })),
  readAttempt: jest.fn(async (): Promise<any> => ({})),
  writeAttempt: jest.fn(async () => {}),
  clearAttempt: jest.fn(async () => {}),
  recordMergeLearning: jest.fn(async () => {}),
  deleteMergedHeadBranch: jest.fn(async (): Promise<any> => ({ outcome: 'kept', branch: null })),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => ({ put: jest.fn(), get: jest.fn(), delete: jest.fn() }),
}));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created' })) }));
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
  listProcesses: jest.fn(() => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  getStoredSchedulePrompt: jest.fn(async () => null),
}));

import { executeCodingTool, ToolContext } from './tools';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const EXISTING = 'backend/src/modules/crossmodel/coding/hint-tail.test.ts';
const EXISTING_BODY = [
  '/**',
  ' * A docstring whose line 24 tail quotes a path token.',
  ' *      path token. */',
  'describe("x", () => { it("y", () => { expect(1).toBe(1); }); });',
  '',
].join('\n');

let WT = '';
beforeAll(async () => {
  WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'replay-d559ea0f-')));
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/coding'), { recursive: true });
  await fs.writeFile(path.join(WT, EXISTING), EXISTING_BODY, 'utf8');
});
afterAll(async () => {
  await fs.rm(WT, { recursive: true, force: true });
});

const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-d559ea0f', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

describe('ticket d559ea0f — missing-path coercion to the worktree root: the framework half of the lead family ticket', () => {
  it('REPLAY the EISDIR leg (the framework defect): edit_file with NO path key — the incident call args — now names the missing argument instead of the root directory raw EISDIR', async () => {
    // The incident's newest call args carry NO path key: {old_string, new_string}.
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      old_string: " *      path token. */ ' (read_session_file + nl this run). The old_string",
      new_string: " *      path token. */' (read_session_file + nl this run). The old_string",
    } as any);
    // BEFORE the fix this was: `Tool edit_file failed: EISDIR: illegal operation on a directory, read`.
    expect(out).toMatch(/^Tool edit_file failed: no file path was given — the path argument \(\(missing or empty\)\) resolves to the WORKTREE ROOT/);
    expect(out).toContain('Give the file\'s worktree-relative path');
    expect(out).not.toContain('EISDIR');
    // No mutation: the existing file is untouched.
    expect(await fs.readFile(path.join(WT, EXISTING), 'utf8')).toBe(EXISTING_BODY);
  });

  it('REPLAY the empty-string and "." species: both resolve to the root and get the same named refusal (empty and \'.\' named literally)', async () => {
    const outEmpty = await executeCodingTool(mkCtx(), 'edit_file', { path: '', old_string: 'x', new_string: 'y' });
    expect(outEmpty).toMatch(/^Tool edit_file failed: no file path was given — the path argument \(\(missing or empty\)\) resolves to the WORKTREE ROOT/);
    const outDot = await executeCodingTool(mkCtx(), 'read_file', { path: '.' });
    expect(outDot).toMatch(/the path argument \('\.'\) resolves to the WORKTREE ROOT/);
  });

  it('read_file with NO path gets the same named refusal (the guard is uniform across the file tools)', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', {} as any);
    expect(out).toMatch(/^Tool read_file failed: no file path was given/);
    expect(out).not.toContain('EISDIR');
  });

  it('write_file with NO path is refused the same way — the root is never written', async () => {
    const out = await executeCodingTool(mkCtx(), 'write_file', { content: 'x' } as any);
    expect(out).toMatch(/^Tool write_file failed: no file path was given/);
    expect(out).not.toContain('EISDIR');
  });

  it('CONTRACT PRESERVATION (ticket 8e900af9): an EXPLICIT sub-directory path keeps the byte-exact raw EISDIR — the two contracts are disjoint', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: 'backend/src/modules/crossmodel/coding', old_string: 'alpha', new_string: 'BETA',
    });
    // The pinned 8e900af9 surface, unchanged by this fix.
    expect(out).toBe('Tool edit_file failed: EISDIR: illegal operation on a directory, read');
  });

  it('CONTROL: the fix changes nothing for a real file path — read_file reads, edit_file edits', async () => {
    const read = await executeCodingTool(mkCtx(), 'read_file', { path: EXISTING });
    expect(read).toContain('path token. */');
    const edited = await executeCodingTool(mkCtx(), 'edit_file', {
      path: EXISTING, old_string: ' *      path token. */', new_string: ' *      path token (edited). */',
    });
    expect(edited).toMatch(/^Edited backend\/src\/modules\/crossmodel\/coding\/hint-tail\.test\.ts/);
    expect(await fs.readFile(path.join(WT, EXISTING), 'utf8')).toContain('path token (edited). */');
  });
});
