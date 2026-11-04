/**
 * edit_file miss diagnostics (tool-failure-streak CLASS fix — tickets
 * efcdcbca + bb77c6ad, Fleet Supervisor ask 2026-10-22). Two lanes each
 * missed edit_file 3× in a row and tripped the derail breaker: the bare
 * one-line refusal said THAT the old_string missed, never WHY, so a stale
 * quote (file moved since the last read / quote from aged context) became a
 * guessing streak. The refusal now appends ONE deterministic
 * ` [edit_file hint: …]` tail; the failure markers were widened in the SAME
 * commit to admit exactly that tail and nothing else. Pins:
 *  - the four miss probes (line endings / trailing ws / indentation /
 *    Jaccard nearest window) and the multi-occurrence line list;
 *  - no probe firing ⇒ the byte-exact pre-hint envelope;
 *  - EDIT_FILE_MISS_DIAGNOSTICS_DISABLED=1 restores the pre-hint envelope;
 *  - the widened markers count hint-tailed refusals as failures and still
 *    never count a model's own trailing narration.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config mocks: learnings-index.service.ts (imported for looksLikeToolFailure)
// pulls unified-memory.service → config/database → config/env, which
// process.exit(1)s without env (the d2e6b0fb suite's discipline).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from agent-derail-break
// .8e900af9.test.ts / tools.test.ts (the tools.ts import graph reaches
// config/env, which process.exit(1)s without env).
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
  listProcesses: jest.fn(async () => ''),
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
  createSchedule: jest.fn(async () => ({ ok: true, schedule: { id: 'sch1', kind: 'recurring', intervalSec: 3600, nextRunAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-09-13T00:00:00.000Z' } })),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async (): Promise<any> => null),
  findPriorRunPrReceipt: jest.fn(async (): Promise<any> => null),
  prHeadMatchesReceipt: jest.fn(async (): Promise<boolean> => false),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { editFileMissDiagnostic, editFileMultiDiagnostic, clipEditFileHint } from './edit-file-hint';
import { executeCodingTool, type ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';

let WT: string;
const TARGET = 'note.ts';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-edit-file-hint', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

beforeAll(async () => {
  WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'edit-file-hint-')));
});
afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED; });

describe('editFileMissDiagnostic — the four probes', () => {
  it('(a) names a line-ending mismatch (file CRLF vs old_string LF, and the reverse)', () => {
    expect(editFileMissDiagnostic('alpha\r\nbeta\r\n', 'alpha\nbeta'))
      .toContain('CRLF');
    expect(editFileMissDiagnostic('alpha\nbeta\n', 'alpha\r\nbeta'))
      .toContain('LF');
  });

  it('(b) names a trailing-whitespace-only mismatch', () => {
    expect(editFileMissDiagnostic('foo  \nbar\n', 'foo\nbar'))
      .toContain('TRAILING whitespace');
  });

  it('(c) names a different-indentation match with the file line and indent width', () => {
    expect(editFileMissDiagnostic('    foo\n    bar\n', 'foo\nbar'))
      .toContain('DIFFERENT INDENTATION');
    expect(editFileMissDiagnostic('    foo\n    bar\n', 'foo\nbar'))
      .toContain('line 1');
  });

  it('(d) names the nearest window with its line range on a stale quote (the consumed-anchor class)', () => {
    const cur = "import { a, b, c } from './x';\nrouter.get('/health', h);\n";
    const hint = editFileMissDiagnostic(cur, "import { a, b } from './x';");
    expect(hint).toContain('nearest match');
    expect(hint).toContain('lines 1–1');
    expect(hint).toContain("import { a, b, c } from './x';");
  });

  it('no probe firing ⇒ empty (the handler returns the byte-exact pre-hint envelope)', () => {
    expect(editFileMissDiagnostic('alpha\nbeta\ngamma\n', 'not-in-the-file')).toBe('');
    // Jaccard below threshold: one shared token across a dissimilar file
    expect(editFileMissDiagnostic('alpha\nbeta\ngamma\n', 'delta epsilon zeta')).toBe('');
  });
});

describe('editFileMultiDiagnostic — occurrence line list', () => {
  it('lists the start line of every occurrence', () => {
    const cur = 'dup\nmid\ndup\nend\n';
    expect(editFileMultiDiagnostic(cur, 'dup')).toContain('lines: 1, 3');
  });
});

describe('clipEditFileHint', () => {
  it('bounds the bracketed tail so a miss never blows up the model context', () => {
    const long = 'x'.repeat(400);
    expect(clipEditFileHint(long).length).toBe(300);
    expect(clipEditFileHint('short')).toBe('short');
  });
});

describe('handler integration (executeCodingTool)', () => {
  it('a stale-quote miss returns the refusal PLUS the bracketed hint, and the widened marker still counts it', async () => {
    await fs.writeFile(path.join(WT, TARGET), "import { a, b, c } from './x';\nrouter.get('/health', h);\n");
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: "import { a, b } from './x';", new_string: 'y' });
    expect(out.startsWith(`old_string not found in ${TARGET}. Read the file and match exactly. [edit_file hint: `)).toBe(true);
    expect(out).toContain('nearest match');
    expect(out.endsWith(']')).toBe(true);
    expect(looksLikeToolFailure(out)).toBe(true); // the widened marker admits exactly the bracketed tail
  });

  it('a non-unique miss lists the occurrence start lines inside the hint tail', async () => {
    await fs.writeFile(path.join(WT, TARGET), 'dup\nmid\ndup\n');
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: 'dup', new_string: 'y' });
    expect(out.startsWith(`old_string appears 2× in ${TARGET} — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 1, 3`)).toBe(true);
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('no probe firing ⇒ the byte-exact pre-hint envelope (and it still counts)', async () => {
    await fs.writeFile(path.join(WT, TARGET), 'alpha\nbeta\ngamma\n');
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: 'not-in-the-file', new_string: 'y' });
    expect(out).toBe(`old_string not found in ${TARGET}. Read the file and match exactly.`);
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('EDIT_FILE_MISS_DIAGNOSTICS_DISABLED=1 restores the byte-exact pre-hint envelope even when a probe would fire', async () => {
    process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED = '1';
    await fs.writeFile(path.join(WT, TARGET), "import { a, b, c } from './x';\nrouter.get('/health', h);\n");
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: "import { a, b } from './x';", new_string: 'y' });
    expect(out).toBe(`old_string not found in ${TARGET}. Read the file and match exactly.`);
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it("a model's own trailing narration still never counts (the d2e6b0fb anchor discipline survives the widened marker)", () => {
    expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly. — then I re-read it')).toBe(false);
    expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly. [edit_file hint: unterminated')).toBe(false);
    expect(looksLikeToolFailure('old_string appears 3× in x — it must be unique. Add surrounding context. extra words')).toBe(false);
  });
});
