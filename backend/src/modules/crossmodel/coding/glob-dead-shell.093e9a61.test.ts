/**
 * REPLAY — ticket 093e9a61 (family deploy-kills-lane-background-workers).
 *
 * The glob false zero. A lane whose session container was replaced mid-run
 * asked `glob` a question and was told "(no matches)" — a confident, wrong
 * answer that its files do not exist. `glob` is precisely the tool a lane
 * reaches for FIRST when it suspects its work was lost, so this false zero
 * compounds the container loss with a false conclusion about the worktree.
 *
 * PRE-FIX (tools.ts case 'glob'):
 *     const { stdout } = await ctx.execShell(…).catch(() => ({ stdout: '' }));
 *     return cap((stdout || '').trim() || '(no matches)');
 * Any exec failure — a dead container, a 30s timeout, a transport death —
 * collapsed into the empty string and then into "(no matches)".
 *
 * The SAME false zero was already fixed for `grep` (ticket b6d50f4a,
 * grep-false-zero.b6d50f4a.test.ts): there the discriminator is a missing exit
 * sentinel, which PROVES bash never ran the pipeline. glob's command is a
 * two-command list with `2>/dev/null` on both halves, so it carries no sentinel
 * by construction — the discriminator here is instead the existing
 * isExecTransportFailure classifier (exec-transport.ts) over stderr.
 *
 * THE DISCRIMINATOR (fails on the old code, passes on the new):
 *   - transport death + empty output  ⇒ [INFRA] "…did not complete", NEVER
 *     "(no matches)"  (the old code returned exactly "(no matches)")
 *   - a genuine empty result (the shell RAN and found nothing) ⇒ still
 *     "(no matches)" — this half must not regress, or a real empty answer
 *     would be reported as an infra failure.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from grep-false-zero.b6d50f4a
// (the tools.ts import graph reaches config/env, which process.exit(1)s env-less).
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
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

import { executeCodingTool, ToolContext } from './tools';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

let WT = '';

/** REAL execShell — mirrors agent.ts execInProcess exactly (bash -lc, cwd-locked,
 *  timeout rejection reshaped to the {stdout, stderr:'[exit: …]'} infra shape). */
const realExec = async (command: string, cwd?: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('bash', ['-lc', command], { cwd: cwd || WT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
};

const mkCtx = (exec: (c: string, cwd?: string, t?: number) => Promise<{ stdout: string; stderr: string }>): ToolContext => ({
  worktree: WT, sessionId: 'sess-093e9a61-glob', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: exec,
}) as unknown as ToolContext;

/** The exact shape execInContainer returns for a container that vanished: the
 *  daemon's own refusal, exit non-zero, and no stdout. */
const deadShell = async () => ({
  stdout: '',
  stderr: 'Error response from daemon: No such container: digby-code-093e9a61-d23\n[exit: 1]',
});

beforeAll(async () => {
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-093e9a61-'));
  const git = async (...args: string[]) => execFileAsync('git', args, { cwd: WT });
  await git('init', '-q', '.');
  await git('config', 'user.email', 'replay@digby.ai');
  await git('config', 'user.name', 'Replay');
  await fs.mkdir(path.join(WT, 'backend/src'), { recursive: true });
  await fs.writeFile(path.join(WT, 'backend/src/auth-signal.ts'), 'export const THRESHOLD = 30;\n');
  await fs.writeFile(path.join(WT, 'backend/src/render-probe.ts'), 'export const probe = 1;\n');
  await git('add', '-A');
  await git('commit', '-qm', 'fixture');
});

describe('093e9a61 — glob must never render a dead shell as "(no matches)"', () => {
  test('THE INCIDENT: a container that vanished mid-run is INFRA, not a false zero', async () => {
    // Pre-fix this returned literally "(no matches)" — telling the lane that
    // auth-signal.ts (present, committed) does not exist.
    const out = await executeCodingTool(mkCtx(deadShell as any), 'glob', { pattern: '**/auth-signal.ts' });
    expect(out).not.toBe('(no matches)');
    expect(out).not.toContain('(no matches)');
    expect(out).toContain('[INFRA]');
    expect(out).toContain('did not complete');
    // It must say plainly that this is NOT a "no matches" verdict...
    expect(out).toMatch(/NOT a "no matches" verdict/);
    // ...and must not send the lane off rewriting a valid pattern.
    expect(out).toContain('Retry the SAME call');
  });

  test('a timeout is INFRA too (the b6d50f4a shape, which glob shared)', async () => {
    const timedOut = async () => ({ stdout: '', stderr: '[exit: 1 — timed out]' });
    const out = await executeCodingTool(mkCtx(timedOut as any), 'glob', { pattern: '**/*.ts' });
    expect(out).not.toContain('(no matches)');
    expect(out).toContain('[INFRA]');
    expect(out).toContain('timed out');
  });

  test('an execShell REJECTION is INFRA, not a false zero', async () => {
    const rejected = async () => { throw new Error('docker exec failed'); };
    const out = await executeCodingTool(mkCtx(rejected as any), 'glob', { pattern: '**/*.ts' });
    expect(out).not.toContain('(no matches)');
    expect(out).toContain('[INFRA]');
  });

  test('NO REGRESSION: a genuine empty result is still "(no matches)"', async () => {
    // The shell ran fine and really found nothing. Reporting this as an infra
    // failure would be the opposite error and just as costly.
    const emptyOk = async () => ({ stdout: '', stderr: '' });
    const out = await executeCodingTool(mkCtx(emptyOk as any), 'glob', { pattern: '**/does-not-exist.ts' });
    expect(out).toBe('(no matches)');
  });

  test('NO REGRESSION: a real match list against a real worktree is unchanged', async () => {
    const out = await executeCodingTool(mkCtx(realExec), 'glob', { pattern: '**/auth-signal.ts' });
    expect(out).toContain('backend/src/auth-signal.ts');
    expect(out).not.toContain('[INFRA]');
  });

  test('a NON-empty stdout is returned as matches even if stderr carries noise', async () => {
    // git ls-files writes nothing to stderr normally, but a `.gitignore` warning
    // or a transport note on stderr must never suppress real matches.
    const noisy = async () => ({ stdout: 'backend/src/auth-signal.ts\n', stderr: 'warning: something\n[exit: 1]' });
    const out = await executeCodingTool(mkCtx(noisy as any), 'glob', { pattern: '**/*.ts' });
    expect(out).toContain('backend/src/auth-signal.ts');
  });
});