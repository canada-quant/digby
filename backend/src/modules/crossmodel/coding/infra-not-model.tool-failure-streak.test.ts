/**
 * Replay for the `tool-failure-streak` auto-filer family (9 mishap tickets filed
 * 2026-11-02T23:41Z … 2026-11-03T05:29Z, lead 3a9eed02; members 744b2798,
 * 5143d030, 9c3d700c, db23402c, 90ce7e88, c5cb6576, d8de9ea0, cd8b8a25).
 *
 * THE INCIDENT: eight members carried the SAME failure text —
 *   `Tool grep failed: the search did not complete ([exit: 1]) — this is NOT a
 *    "no matches" verdict. Narrow the scope/path, or fall back to run_command …`
 * — each three times in a row, on calls whose pattern AND scope were perfectly
 * valid. Replaying all six recorded call shapes in the real worktree TODAY gives
 * exit 0 / exit 1 WITH the sentinel (see the REPLAY case below): the patterns
 * were never the problem. The session shell had died mid-run (the fleet's
 * `coding container: session-bg reap failed for <session>` / "container … is not
 * running" rows land in the same window), so `git grep` never ran and the
 * pipeline's sentinel never printed.
 *
 * THE DEFECT (two parts, both pinned here):
 *  1. the tool named an INFRA death as a PATTERN problem ("Narrow the
 *     scope/path"), so each lane obeyed and rewrote a VALID pattern — three
 *     times — which is exactly how a dead box became a 3× streak;
 *  2. the derail breaker (`looksLikeToolFailure`) counted those infra results as
 *     model failures, withheld `grep` for a model round and auto-filed a mishap
 *     blaming the model. verify had the same hole one seam over (member
 *     744b2798: a `Verify FAILED at "typecheck"` whose only diagnostic was
 *     "container … is not running").
 *
 * THE FIX: an infra result is anchored `[INFRA]`, named as infra (retry the SAME
 * call), and EXEMPT from the derail streak. A REAL model failure keeps the old
 * text and still counts — the discriminator cases below assert both directions.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from
// grep-false-zero.b6d50f4a.test.ts (the tools.ts import graph reaches config/env,
// which process.exit(1)s without env).
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
// Import-time boundary mock, same reason as the tools.ts graph above:
// learnings-index.service imports the memory layer, which reaches
// prisma → config/database → config/env, whose parseEnv() process.exit(1)s
// without DATABASE_URL. The same pair of no-op stubs every platform suite uses.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
}));
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

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { executeCodingTool, ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';
// Imported from the PURE LEAF, never './container.service': that module reaches
// prisma → config/database → config/env, whose parseEnv() process.exit(1)s
// without DATABASE_URL, so importing it here would make this suite fail to LOAD
// in the env-less CI contract (see the leaf-module case below).
import { isExecTransportFailure } from './exec-transport';

const execFileAsync = promisify(execFile);

let WT = '';

/** REAL execShell — mirrors agent.ts execInProcess (bash -lc, cwd-locked). */
const realExec = async (command: string, cwd?: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('bash', ['-lc', command], { cwd: cwd || WT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
};

const mkCtx = (exec: typeof realExec = realExec): ToolContext => ({
  worktree: WT, sessionId: 'sess-tool-failure-streak', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: exec,
}) as unknown as ToolContext;

beforeAll(async () => {
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-infra-not-model-'));
  const git = async (...args: string[]) => execFileAsync('git', args, { cwd: WT });
  await git('init', '-q', '.');
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/chat-agent'), { recursive: true });
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/fleet'), { recursive: true });
  await fs.writeFile(
    path.join(WT, 'backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts'),
    `export async function startDetachedChatRun() { return drainChatQueue(); }\n` +
    `export async function drainChatQueue() { return 'ok'; }\n`,
  );
  await fs.writeFile(
    path.join(WT, 'backend/src/modules/crossmodel/fleet/infra-watch.service.ts'),
    `import { logger } from '../../../utils/logger';\nexport const infraWatch = true;\n`,
  );
  await git('add', '.');
  await git('-c', 'user.email=replay@digby.test', '-c', 'user.name=replay', 'commit', '-qm', 'init');
}, 60_000);

afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });

describe('tool-failure-streak family — an infra death is named infra and never charged to the model', () => {
  jest.setTimeout(60_000);

  // The exact call shapes eight members recorded (newest first in their tickets).
  const MEMBER_CALLS: Array<{ pattern: string; path: string }> = [
    { pattern: 'startDetachedChatRun', path: 'backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts' },
    { pattern: 'drainChatQueue', path: 'backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts' },
    { pattern: '^import .* from', path: 'backend/src/modules/crossmodel/fleet/infra-watch.service.ts' },
    { pattern: '^import', path: 'backend/src/modules/crossmodel/fleet/infra-watch.service.ts' },
  ];

  it('REPLAY: the members\' own recorded calls SUCCEED today — the pattern/scope was never the defect', async () => {
    for (const c of MEMBER_CALLS) {
      const out = await executeCodingTool(mkCtx(), 'grep', c);
      // Not a failure at all: these are the valid calls the tickets blamed.
      expect(out).not.toMatch(/^\[INFRA\] Tool grep failed/);
      expect(out).not.toMatch(/^Tool grep failed/);
      expect(out).not.toBe('(no matches)');
    }
    // …and a genuine no-match still answers exactly "(no matches)".
    expect(await executeCodingTool(mkCtx(), 'grep', { pattern: 'ZQ_NO_SUCH_SYMBOL', path: 'backend' })).toBe('(no matches)');
  });

  it('DISCRIMINATOR — a dead shell (no sentinel: the pipeline never finished) is INFRA, not a pattern problem', async () => {
    // The incident's exact transport shape: the exec never ran the command list,
    // so the UNCONDITIONAL `printf` sentinel is absent and stderr carries the
    // container-gone marker the fleet logged in the same window.
    const deadExec = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container 49e506f86e0b851e03af5269c07b57f2ea4f1bec2e01538ad094a01357a86bff is not running\n[exit: 1]',
    });
    const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'grep', MEMBER_CALLS[0]);

    // 1. Named INFRA, and anchored so the breaker can exempt it.
    expect(out).toMatch(/^\[INFRA\] Tool grep failed: the search did not complete/);
    // 2. It tells the truth: retry the SAME call — do NOT rewrite the pattern.
    expect(out).toContain('Retry the SAME call');
    expect(out).toContain('NOT a bad pattern or scope');
    // 3. It never falsely claims "no matches".
    expect(out).not.toContain('(no matches)');
    // 4. …and the derail breaker does NOT charge it to the model.
    expect(looksLikeToolFailure(out)).toBe(false);
  });

  it('DISCRIMINATOR — three such infra deaths in a row never form a streak (the exact 3× shape of all 8 members)', async () => {
    const deadExec = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container 49e506f86e0b851e03af5269c07b57f2ea4f1bec2e01538ad094a01357a86bff is not running\n[exit: 1]',
    });
    let streak = 0;
    for (let i = 0; i < 3; i++) {
      const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'grep', MEMBER_CALLS[i]);
      if (looksLikeToolFailure(out)) streak += 1;
    }
    // Pre-fix this was 3 → the breaker withheld `grep` and auto-filed a mishap.
    expect(streak).toBe(0);
  });

  it('a SIGKILL/OOM wrapper death (no marker, empty stderr) is INFRA too — it is NOT the lane\'s pattern', async () => {
    const killed = async () => ({ stdout: '', stderr: '[exit: 137]' });
    const out = await executeCodingTool(mkCtx(killed as typeof realExec), 'grep', MEMBER_CALLS[1]);
    expect(out).toMatch(/^\[INFRA\]/);
    expect(looksLikeToolFailure(out)).toBe(false);
  });

  it('KEEPS THE OLD BEHAVIOUR FOR A REAL DEFECT: a bad regex is still a plain failure that COUNTS', async () => {
    // git grep exits 128 with `fatal:` AND the sentinel prints — no infra shape.
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(', path: 'backend' });
    expect(out).toMatch(/^Tool grep failed:/);
    expect(out).not.toMatch(/^\[INFRA\]/);
    expect(out).toContain('Unmatched ( or \\(');
    // A real, actionable failure must still feed the breaker.
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('KEEPS THE OLD BEHAVIOUR FOR A SCOPE ERROR: a bad pathspec is a plain failure, not INFRA', async () => {
    const thrown = async () => { throw new Error('spawn ENOENT'); };
    // A thrown exec with NO infra marker in stderr still reads as a plain failure.
    const out = await executeCodingTool(mkCtx(thrown as typeof realExec), 'grep', { pattern: 'x' });
    expect(out).not.toBe('(no matches)');
    expect(out).toMatch(/Tool grep failed:/);
  });

  it('isExecTransportFailure: container/daemon/kill signatures true; a bare [exit: 1] is NOT transport', () => {
    expect(isExecTransportFailure('Error response from daemon: container abc is not running\n[exit: 1]')).toBe(true);
    expect(isExecTransportFailure('No such container: digby-x')).toBe(true);
    expect(isExecTransportFailure('[exit: 124 — timed out]')).toBe(true);
    expect(isExecTransportFailure('[exit: 137]')).toBe(true);
    expect(isExecTransportFailure('OCI runtime exec failed: exec failed')).toBe(true);
    // The ambiguous one stays ambiguous: a real `git grep` fatal exits 1 too,
    // so `[exit: 1]` ALONE must never be read as transport.
    expect(isExecTransportFailure('[exit: 1]')).toBe(false);
    expect(isExecTransportFailure('')).toBe(false);
  });

  it('DETECTOR-RECALL REPLAY — the existing true positives on this detector STILL fire', () => {
    // looksLikeToolFailure is a framework detector (coding/learnings-index.service.ts).
    // Every pre-existing convicting shape must keep firing after the [INFRA] exemption.
    const priorTruePositives = [
      'Tool grep failed: fatal: Not a git repository — fix the pattern/scope, or use run_command with plain grep.',
      'Verify FAILED at "test": ✓ typecheck (exit 0)  ✗ test (exit 1)\n--- test output tail ---\nFAIL src/x.test.ts',
      'Tool read_file failed: no such file or directory',
      'git commit failed: pre-commit hook rejected',
      'COMMIT BLOCKED — evidence guard',
      'Opening the PR failed: 422',
      '{\n "ok": false,\n "gate": "ci"\n}',
      'Tool "grep" exceeded 900s and was aborted',
      'No generated file with id doc-abc123 belongs to this user.',
    ];
    for (const tp of priorTruePositives) {
      expect(looksLikeToolFailure(tp)).toBe(true);
    }
    // …and the exemption is narrowly scoped to the [INFRA] anchor only.
    expect(looksLikeToolFailure('[INFRA] Tool grep failed: the search did not complete ([exit: 1])')).toBe(false);
    // A confirmation STAGE is still a pending user action, never a failure.
    expect(looksLikeToolFailure('{"ok": false, "needsConfirmation": true}')).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RESIDUAL SEAM (PR #2390 closed the grep + verify seams; these two tickets
  // were filed from the lane's OWN run de4d1a9d inside the same container-death
  // window and proved a THIRD seam was still open).
  // ───────────────────────────────────────────────────────────────────────────

  it('RESIDUAL SEAM (ticket 0c6a47de): ast_search on a dead shell is INFRA, never "no output from ast-grep"', async () => {
    // The ticket's three calls (renderVerifyFeedback / ensureSessionContainer)
    // were VALID — both symbols exist in backend/src/modules/crossmodel/coding
    // (5 and 154 files). The shell died; ast-grep never started. Pre-fix this
    // branch returned `Tool ast_search failed: no output from ast-grep`, which
    // reads as a bad PATTERN (the tool even told the lane to change it) and the
    // derail breaker charged it to the MODEL.
    const deadAst = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container 49e506f86e0b851e03af5269c07b57f2ea4f1bec2e01538ad094a01357a86bff is not running\n[exit: 1]',
    });
    for (const pattern of ['function renderVerifyFeedback($$$ARGS)', 'ensureSessionContainer($$$ARGS)']) {
      const out = await executeCodingTool(mkCtx(deadAst as typeof realExec), 'ast_search', { pattern, lang: 'ts' });
      // Named INFRA + anchored, so the breaker can exempt it…
      expect(out).toMatch(/^\[INFRA\] Tool ast_search failed: ast-grep never ran/);
      // …with the truth: retry the SAME call, the pattern is NOT the problem…
      expect(out).toContain('Retry the SAME call');
      expect(out).toContain('NOT a bad pattern');
      // …and never the old bad-pattern advice that caused the 3× rewrite.
      expect(out).not.toContain('no output from ast-grep');
      // …and the breaker does NOT charge it to the model.
      expect(looksLikeToolFailure(out)).toBe(false);
    }
  });

  it('DISCRIMINATOR (ticket 0c6a47de): a genuinely SILENT ast-grep still reads as a plain failure that COUNTS', async () => {
    // ast-grep has no unconditional pipeline sentinel, so empty output ALONE is
    // never proof of transport death (unlike the grep seam). A silent run with
    // no transport signature keeps the old text and still feeds the breaker —
    // the exemption is scoped to a real INFRA signature, not to "no output".
    const silentAst = async () => ({ stdout: '', stderr: '' });
    const out = await executeCodingTool(mkCtx(silentAst as typeof realExec), 'ast_search', { pattern: 'x', lang: 'ts' });
    expect(out).toMatch(/^Tool ast_search failed: no output from ast-grep/);
    expect(out).not.toMatch(/^\[INFRA\]/);
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('RESIDUAL SEAM (ticket b7bf4dcb): its three grep shapes are VALID patterns, not the defect', async () => {
    // The ticket's calls (filed 06:28:59Z from run de4d1a9d, the same dead-shell
    // window) were plain, valid EREs. Replaying them here proves they parse and
    // run: none is a tool failure, so the `[exit: 1]` in the ticket was the dead
    // shell, never a bad pattern. The grep seam that mislabeled them is covered
    // by the [INFRA] cases above.
    const SHAPES = [
      'isRunning|docker ps|container.*health|ensureSessionContainer|execTargetName',
      'function renderVerifyFeedback|renderVerifyFeedback =',
      'No such container|is not running|docker inspect|containerState',
    ];
    for (const pattern of SHAPES) {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern, path: 'backend' });
      expect(out).not.toMatch(/^Tool grep failed/);
      expect(out).not.toMatch(/^\[INFRA\]/);
    }
  });
});