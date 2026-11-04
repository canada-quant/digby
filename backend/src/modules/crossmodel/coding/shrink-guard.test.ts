/**
 * I1 (repo-integrity remediation, 2026-09-09) — the git_commit SHRINK GUARD.
 *
 * Real incident: a lane's merge in an external project repo "resolved" its
 * conflicts by leaving three TRACKED files at 0 BYTES on main (incl. a 228KB
 * owner-directives log); nothing noticed for 22 hours; the lane described the
 * commit as "non-destructive". git_commit is the lane commit choke point, so
 * the guard lives there: refuse commits that empty a tracked file, cut >50%
 * of a >20-line file, or still carry conflict markers — unless allowShrink:true
 * with a non-empty shrinkReason is passed (both recorded in the receipt).
 *
 * Boundary mocks mirror tools.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
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
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage',
    CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard',
  },
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(),
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));

import { executeCodingTool, scanStagedShrink, ToolContext } from './tools';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Build marker lines at runtime so THIS file never contains literal conflict
// markers (they would trip the very class of tooling under test).
const OPEN = '<'.repeat(7) + ' ours';
const MID = '='.repeat(7);
const CLOSE = '>'.repeat(7) + ' theirs';

describe('I1: git_commit shrink guard', () => {
  let dir: string;
  const sh = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (rel: string, content: string) => fs.writeFile(path.join(dir, rel), content);

  const mkCtx = (): ToolContext => ({
    worktree: dir, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext);

  /** 30 numbered lines, trailing newline. */
  const lines30 = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-guard-'));
    sh(['init', '-q', '-b', 'digby/x']);
    sh(['config', 'user.email', 't@example.com']);
    sh(['config', 'user.name', 't']);
    await write('keep.txt', lines30);
    await write('small.txt', 'one\ntwo\n');
    sh(['add', '.']);
    sh(['commit', '-qm', 'baseline']);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a normal commit passes untouched (no findings, no metric)', async () => {
    await write('keep.txt', lines30 + 'line 31\n');
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'add a line' });
    expect(out).toMatch(/\[digby\/x [0-9a-f]{7,40}\]/);
    expect(out).not.toContain('shrink');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('REFUSES a commit that leaves a tracked file at 0 bytes — structured {ok:false, reason:"shrink_guard"} with per-file sizes', async () => {
    await write('keep.txt', '');
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'merge main (resolved)' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'shrink_guard' });
    expect(parsed.files).toEqual([
      expect.objectContaining({ file: 'keep.txt', reason: 'empty_file', afterBytes: 0 }),
    ]);
    expect(parsed.files[0].beforeBytes).toBeGreaterThan(0);
    // Nothing was committed.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString();
    expect(log.trim().split('\n')).toHaveLength(1);
    // Telemetry: loop_metrics kind merge_size_guard on refusal.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge_size_guard', sessionId: 'sess-1', value: 1,
      meta: expect.objectContaining({ allowShrink: false, files: [{ file: 'keep.txt', reason: 'empty_file' }] }),
    }));
  });

  it('REFUSES >50% line loss on a >20-line tracked file', async () => {
    await write('keep.txt', 'line 1\nline 2\nline 3\n'); // 30 → 3 lines
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'cleanup' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'shrink_guard' });
    expect(parsed.files[0]).toMatchObject({ file: 'keep.txt', reason: 'line_loss', beforeLines: 30, afterLines: 3 });
  });

  it('allows a <50% trim and small-file rewrites (>20-line floor)', async () => {
    await write('keep.txt', lines30.split('\n').slice(0, 20).join('\n') + '\n'); // 30 → 20 lines (~33% loss)
    await write('small.txt', 'x\n'); // 2-line file gutted — under the 20-line floor
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'trim' });
    expect(out).toMatch(/\[digby\/x [0-9a-f]{7,40}\]/);
  });

  it('REFUSES staged conflict markers (both ends present)', async () => {
    await write('keep.txt', `line 1\n${OPEN}\nours body\n${MID}\ntheirs body\n${CLOSE}\n` + lines30.split('\n').slice(1).join('\n') + '\n');
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'merge' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'shrink_guard' });
    expect(parsed.files[0]).toMatchObject({ file: 'keep.txt', reason: 'conflict_markers' });
  });

  it('allowShrink WITHOUT a shrinkReason still refuses', async () => {
    await write('keep.txt', '');
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'wipe', allowShrink: true });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'shrink_guard' });
  });

  it('allowShrink + shrinkReason commits and records both in the receipt text (per-file before/after sizes)', async () => {
    await write('keep.txt', '');
    const out = await executeCodingTool(mkCtx(), 'git_commit', {
      message: 'retire keep.txt content', allowShrink: true, shrinkReason: 'file superseded by keep2; deliberate wipe',
    });
    expect(out).toMatch(/\[digby\/x [0-9a-f]{7,40}\]/); // git's own stdout — receipt extractor keys on this
    expect(out).toContain('[shrink allowed] reason: "file superseded by keep2; deliberate wipe"');
    expect(out).toMatch(/keep\.txt \[empty_file\] \d+→0 bytes/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled(); // metric fires on refusal only
  });

  it('NEW empty files and DELETIONS are not shrinks (tracked-modified only)', async () => {
    await write('brand-new.txt', '');
    await fs.rm(path.join(dir, 'small.txt'));
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'add stub, drop small' });
    expect(out).toMatch(/\[digby\/x [0-9a-f]{7,40}\]/);
  });

  it('scanStagedShrink: unborn HEAD (first commit) finds nothing', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-fresh-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh });
      await fs.writeFile(path.join(fresh, 'a.txt'), '');
      execFileSync('git', ['add', '.'], { cwd: fresh });
      await expect(scanStagedShrink(fresh)).resolves.toEqual([]);
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });
});
