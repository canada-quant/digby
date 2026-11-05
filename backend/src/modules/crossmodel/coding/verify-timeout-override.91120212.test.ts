/**
 * verify-timeout-override.91120212.test.ts — ticket 91120212.
 *
 * THE REPORT: a repo whose test suite legitimately runs 329 s is DETERMINISTICALLY
 * killed by the verify per-command timeout (four identical `passed:false` kills,
 * same stage, no retry can pass), while the identical suite passes under
 * run_command. Because open_pull_request is gated on a green verify, every PR for
 * that repo is blocked. The lane's complaint is precise: "the failure notice
 * instructs the lane not to touch cap/code/tests, so there is no in-repo escape".
 *
 * THE DEFECTS pinned here (all three are why the escape did not exist):
 *
 *  A. THE OVERRIDE EXISTS BUT WAS NEVER NAMED. `loop.perCommandTimeoutMs` in
 *     .digby/config.json IS the per-repo override (loopConfig merges it over
 *     DEFAULT_LOOP), yet a stage-timeout result said the OPPOSITE — "Do NOT edit
 *     code, tests or verify config in response to this" — so the one sanctioned
 *     remedy read as forbidden. A lane obeyed the text and burned four attempts.
 *
 *  B. A STAGE TIMEOUT WAS MISLABELLED INFRASTRUCTURE. A timeout kills the wrapper
 *     before it can echo __DIGBY_EXIT__, so `terminated` is true and the tool's
 *     `[INFRA]` branch (which ALSO says "Do NOT edit … verify config") fired
 *     first, defeating the T2e split (verify.service.ts sets stageTimeout:true
 *     and explicitly refuses to call a timeout environmental). A timeout is a
 *     FAILURE the lane must act on, not a dead box to retry.
 *
 *  C. THE SCAFFOLD SHIPPED A CAP TIGHTER THAN THE HARNESS DEFAULT. Every new repo
 *     was born with perCommandTimeoutMs 300000 while the code's own DEFAULT_LOOP
 *     is 600000 (verify.service.ts). A scaffolded repo therefore had HALF the
 *     timeout of a repo with no loop block at all.
 *
 * WHAT MUST STAY TRUE (discriminators — the exemptions must not leak):
 *   - an OOM/SIGKILL death (exit 137, zero diagnostics) keeps its `[INFRA]`
 *     anchor and its "Do NOT edit code" advice: that one really is a box problem;
 *   - a REAL code red (non-zero exit with a test verdict) keeps the strict
 *     "Do NOT disable the check … to force a pass" text;
 *   - the tool result keeps its `Verify FAILED at "<stage>"` receipt anchor.
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

const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
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
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout', VERIFY_ENV_RED: 'verify_env_red',
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
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async () => null),
  findPriorRunPrReceipt: jest.fn(async () => null),
  prHeadMatchesReceipt: jest.fn(async () => false),
}));
// Import-time boundary mock (the discipline of
// infra-not-model.tool-failure-streak.test.ts): learnings-index.service reaches
// the memory layer → prisma → config/database → config/env, whose parseEnv()
// process.exit(1)s without DATABASE_URL. The same no-op stubs every platform suite uses.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
}));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created' })) }));
// The two concurrency gates (per-process FIFO + per-container slot) are
// irrelevant to the render contract this suite pins — pass straight through.
jest.mock('./verify-limiter', () => ({
  __esModule: true,
  withVerifySlot: jest.fn(async (fn: () => Promise<any>) => fn()),
}));
jest.mock('./verify-container-slots', () => {
  const actual = jest.requireActual('./verify-container-slots');
  return {
    __esModule: true,
    ...actual,
    runGatedVerifyChain: jest.fn(async (_exec: any, _wt: string, _hooks: any, run: () => Promise<any>) => run()),
  };
});

import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeCodingTool, ToolContext } from './tools';
import { DEFAULT_LOOP, loopConfig, renderVerifyFeedback, runVerifyChain, type VerifyResult } from './verify.service';
import { DEFAULT_PER_COMMAND_TIMEOUT_MS, VERIFY_STAGE_CAP_CEILING_MS, recommendedStageCapMs, stageTimeoutAdvice } from './loop-defaults';
import { renderConfigJson } from './scaffolding.service';
import { looksLikeToolFailure } from './learnings-index.service';

const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** The per-command-timeout kill shape: the wrapper died before the exit marker,
 *  and the exec layer stamped it. 329 s of real jest output, then the kill. */
const TIMEOUT_KILL = {
  stdout: 'PASS src/a.test.ts\nPASS src/b.test.ts\n',
  stderr: '\n[exit: error — timed out]',
};
/** The OOM/SIGKILL shape: exit 137, zero diagnostics (the genuine infra class). */
const OOM_KILL = { stdout: '', stderr: '__DIGBY_EXIT__ 137' };
/** A real code red: the tool ran and rendered a verdict. */
const REAL_RED = { stdout: 'FAIL src/a.test.ts\n\xe2\x97\x8f A \xe2\x80\xba computes\n__DIGBY_EXIT__ 1', stderr: '' };

describe('ticket 91120212 — a legitimately long stage must be escapable (not a deterministic wall)', () => {
  let wt: string;

  const mkCtx = (stageOut: { stdout: string; stderr: string }, cfg?: Record<string, unknown>) => ({
    worktree: wt, sessionId: 'sess-911', userId: 'u1', runId: 'run-911', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async (cmd: string) => cmd.includes('pgrep')
      ? { stdout: '', stderr: '' }          // the 2026-09-10 env-guard reap preamble
      : stageOut,
    getGithubToken: async () => null,
    userTurnAt: new Date(),
  } as unknown as ToolContext);

  beforeEach(async () => {
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
    memStore.clear();
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'vto-911-'));
    g(wt, ['init', '-q', '-b', 'digby/x']);
    g(wt, ['config', 'user.email', 't@example.com']);
    g(wt, ['config', 'user.name', 't']);
    await fs.mkdir(path.join(wt, '.digby'), { recursive: true });
    await fs.writeFile(path.join(wt, '.digby', 'config.json'), JSON.stringify({
      commands: { typecheck: 'npx tsc --noEmit' },
      verify: ['typecheck'],
    }));
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(wt, ['add', '.']);
    g(wt, ['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  });

  // ── DEFECT A+B at the TOOL SEAM ────────────────────────────────────────────
  it('DEFECT A+B: the tool names loop.perCommandTimeoutMs as the sanctioned per-repo override (the escape the ticket could not find)', async () => {
    const out = await executeCodingTool(mkCtx(TIMEOUT_KILL), 'verify', {});
    // It is still a FAILURE the lane must act on — the receipt anchor is kept.
    expect(out.startsWith('Verify FAILED at "typecheck"')).toBe(true);
    // …but it is NOT infrastructure: a timeout is a cap, not a dead box.
    expect(out.startsWith('[INFRA]')).toBe(false);
    // THE FIX: the per-repo override is NAMED, with the key and the file.
    expect(out).toContain('perCommandTimeoutMs');
    expect(out).toContain('.digby/config.json');
    // …and the text that made the escape read as forbidden is GONE.
    expect(out).not.toContain('Do NOT edit code, tests or verify config');
  });

  it('DEFECT A+B: a stage timeout stays failure-shaped for the derail breaker (the lane must act on it)', async () => {
    const out = await executeCodingTool(mkCtx(TIMEOUT_KILL), 'verify', {});
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  // ── DISCRIMINATOR: the env class must NOT be reclassified by this fix ──────
  it('DISCRIMINATOR: an OOM/SIGKILL death keeps its [INFRA] anchor and "do NOT edit code" advice', async () => {
    const out = await executeCodingTool(mkCtx(OOM_KILL), 'verify', {});
    expect(out.startsWith('[INFRA]')).toBe(true);
    expect(out).toContain('Do NOT edit code');
    expect(out).not.toContain('perCommandTimeoutMs'); // a box problem is not a cap problem
  });

  it('DISCRIMINATOR: a REAL code red keeps the strict "do not weaken the check" text and names no override', async () => {
    const out = await executeCodingTool(mkCtx(REAL_RED), 'verify', {});
    expect(out.startsWith('Verify FAILED at "typecheck"')).toBe(true);
    expect(out).toContain('--- typecheck output tail ---');
    expect(out).not.toContain('perCommandTimeoutMs');
  });

  // ── DEFECT A at the AUTO-VERIFY seam (agent.ts path) ───────────────────────
  it('DEFECT A: renderVerifyFeedback names the override for a stage timeout instead of forbidding the config edit', async () => {
    // Command-routed, not call-ordered: the chain legitimately calls execShell
    // for the session-allowance scan and the env-guard reap preamble BEFORE the
    // stage leg, so a mockResolvedValueOnce queue lands the fixture on the wrong
    // call.
    const killed = jest.fn(async (cmd: string) =>
      /pgrep|session-bg|sessionBg/i.test(cmd) ? { stdout: '', stderr: '' } : TIMEOUT_KILL);
    const r: VerifyResult = await runVerifyChain(killed as any, wt, [{ key: 'test', command: 'npx jest' }], 300_000);
    expect(r.stages[0].stageTimeout).toBe(true);

    const fb = renderVerifyFeedback(r, 1, 3);
    expect(fb).toContain('STAGE TIMEOUT');
    expect(fb).toContain('perCommandTimeoutMs');
    expect(fb).toContain('.digby/config.json');
    // The blanket prohibition is for a CODE red — it must not answer a cap kill.
    expect(fb).not.toContain('edit tests/verify config to force a pass');
  });

  it('DISCRIMINATOR: renderVerifyFeedback keeps the strict text for a real code red', () => {
    const fb = renderVerifyFeedback({
      passed: false, ran: true, unverified: false, failedStage: 'test',
      stages: [{ key: 'test', command: 'npx jest', exitCode: 1, passed: false, outputTail: 'FAIL src/a.test.ts' }],
    }, 1, 3);
    expect(fb).toContain('edit tests/verify config to force a pass');
    expect(fb).not.toContain('perCommandTimeoutMs');
  });

  // ── DEFECT C: the scaffold must not be born tighter than the harness ───────
  it('DEFECT C: a scaffolded config carries the harness default cap, not a tighter one', () => {
    const cfg = JSON.parse(renderConfigJson('main', {
      label: null, cmd: { test: 'npx jest' }, verify: ['test'],
    } as any));
    expect(cfg.loop.perCommandTimeoutMs).toBe(DEFAULT_LOOP.perCommandTimeoutMs);
    // A scaffolded repo and a repo with no loop block therefore behave the same.
    expect(loopConfig(cfg).perCommandTimeoutMs).toBe(loopConfig(null).perCommandTimeoutMs);
  });

  // ── REVIEW FINDING (independent reviewer, blocking): the advice itself must
  //    name a REACHABLE number. The first cut recommended 2 × DEFAULT_LOOP =
  //    1_200_000 ms, which exceeds BOTH harness timers (TOOL_HARD_TIMEOUT_MS =
  //    900_000 racing every tool, and the PR-gate auto-verify ceiling 840_000
  //    covering queue wait + chain). Following that advice would replace a clean
  //    timeout verdict with an opaque tool abort — re-creating the very
  //    "no in-repo escape" class this ticket is about. ────────────────────────
  it('REVIEW FIX: the recommended cap fits under the harness tool abort and the PR-gate ceiling', () => {
    // Read the real constants, not copies: if either timer is tightened later,
    // this fails instead of silently re-introducing an unreachable recommendation.
    const toolHardAbortMs = 15 * 60 * 1000;       // agent.ts TOOL_HARD_TIMEOUT_MS
    const prGateCeilingMs = 14 * 60 * 1000;       // pr-gate-docs-only.ts
    const rec = recommendedStageCapMs();
    expect(rec).toBeLessThan(toolHardAbortMs);
    expect(rec).toBeLessThanOrEqual(prGateCeilingMs);
    expect(VERIFY_STAGE_CAP_CEILING_MS).toBeLessThan(toolHardAbortMs);
    // …and the rendered advice must actually name that reachable value, never 2×.
    const advice = stageTimeoutAdvice(300_000);
    expect(advice).toContain(String(rec));
    expect(advice).not.toContain(String(DEFAULT_LOOP.perCommandTimeoutMs * 2));
    expect(advice).toContain('SHARDED'); // the honest answer past the ceiling
  });
});