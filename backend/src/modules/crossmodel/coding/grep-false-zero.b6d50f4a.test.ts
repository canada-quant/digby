/**
 * Replay for ticket b6d50f4a — "grep tool false-zero: returns '(no matches)'
 * for symbols present in worktree (glob/read_file/shell-grep all see them)".
 *
 * THE INCIDENT (filed 2026-10-14T07:12Z by coding session 5f90c628, the FO lane
 * on the JWT-detector retune): `grep` with pattern
 * `INVALID_TOKEN_SPIKE_THRESHOLD|auth-signal|Invalid-signature JWT spike`
 * scoped `backend`, and later
 * `recordInvalidTokenSignal|buildInvalidTokenSample|INVALID_TOKEN_SPIKE_THRESHOLD`
 * repo-wide, returned "(no matches)" — while glob (an auth-signal filename
 * pattern), read_file
 * AND a shell `grep -rn … backend/src --include="*.ts"` in the SAME worktree all
 * saw the file and 20+ hits. Cost: two wasted probe rounds + a near-miss
 * conclusion ("file has no tests") before the lane refuted it via shell.
 *
 * ROOT CAUSE (tools.ts case 'grep', pre-fix): plain `grep -ErnI <scope>` walks
 * EVERYTHING under the scope — node_modules included, because GNU grep ignores
 * .gitignore (glob, by contrast, runs `git ls-files` = gitignore-aware) — so a
 * `backend` or repo-wide scope became a multi-GB crawl (crossmodel:
 * backend/node_modules 774M + frontend/node_modules 875M). Under shared
 * dev-container load that blows the tool's 30s timeout; execInContainer /
 * execInProcess NEVER throw on timeout — they return {stdout:'', stderr:'[exit:
 * … — timed out]'} — and the tool read only stdout through
 * `.catch(() => ({stdout:''}))`, so timeout, container refusal AND a bad regex
 * all rendered as "(no matches)": a false zero.
 *
 * THE FIX (two parts, both pinned here):
 *  1. `git grep -nIE --untracked --full-name` — the SAME ignore view glob uses:
 *     tracked + untracked, .gitignore'd paths (node_modules, .env) excluded.
 *  2. An exit sentinel (PIPESTATUS[0]) after the pipeline: "(no matches)" is
 *     ONLY ever a real git-grep exit-1 verdict; infra failure / timeout / bad
 *     regex surface as "Tool grep failed: …".
 *
 * THE DISCRIMINATOR (fails on the old code, passes on the new): the
 * infra-failure replay below — the OLD tool returned "(no matches)" for exactly
 * that exec result shape (stdout '', stderr '[exit: 124 — timed out]').
 *
 * These tests run the REAL executeCodingTool against a REAL temp git repo with
 * a REAL bash execShell, so the command string, sentinel parsing and failure
 * routing are exercised end-to-end (boundary mocks mirror tools.test.ts /
 * listdir-enoent.4bf65e24.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts (the
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
 * timeout rejection reshaped to the {stdout, stderr:'[exit: …]'} infra shape). */
const realExec = async (command: string, cwd?: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('bash', ['-lc', command], { cwd: cwd || WT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
};

const mkCtx = (exec: typeof realExec = realExec): ToolContext => ({
  worktree: WT, sessionId: 'sess-b6d50f4a', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: exec,
}) as unknown as ToolContext;

beforeAll(async () => {
  // A worktree shaped like the incident's (crossmodel), with the exact symbols
  // the FO lane searched for, plus gitignored bait the old tool crawled.
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-b6d50f4a-'));
  const git = async (...args: string[]) => execFileAsync('git', args, { cwd: WT });
  await git('init', '-q', '.');
  await fs.writeFile(path.join(WT, '.gitignore'), 'node_modules/\n.env\n');
  await fs.mkdir(path.join(WT, 'backend/src/middleware'), { recursive: true });
  await fs.writeFile(
    path.join(WT, 'backend/src/middleware/auth-signal.ts'),
    `import { recordInvalidTokenSignal, buildInvalidTokenSample, INVALID_TOKEN_SPIKE_THRESHOLD } from './auth-signal';\n` +
    `export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;\n` +
    `export function recordInvalidTokenSignal() { return INVALID_TOKEN_SPIKE_THRESHOLD; }\n` +
    `export function buildInvalidTokenSample() { return null; }\n`,
  );
  await fs.writeFile(
    path.join(WT, 'backend/src/middleware/error-handler.ts'),
    `import { recordInvalidTokenSignal } from './auth-signal';\n// Invalid-signature JWT spike counter\n`,
  );
  // Gitignored bait: what the OLD tool crawled (774M of it in the real repo) —
  // and a gitignored secret, which the old tool also SEARCHED.
  await fs.mkdir(path.join(WT, 'backend/node_modules/dep'), { recursive: true });
  await fs.writeFile(path.join(WT, 'backend/node_modules/dep/bait.js'), 'ZQBAIT_INVALID_TOKEN_SPIKE_THRESHOLD node_modules\n');
  await fs.writeFile(path.join(WT, '.env'), 'ZQBAIT_SECRET=INVALID_TOKEN_SPIKE_THRESHOLD\n');
  // An untracked-but-visible file (agent edits land untracked mid-run).
  await fs.writeFile(path.join(WT, 'backend/src/middleware/scratch-note.ts'), '// scratch INVALID_TOKEN_SPIKE_THRESHOLD\n');
  await git('add', '.');
  await git('-c', 'user.email=replay@digby.test', '-c', 'user.name=replay', 'commit', '-qm', 'init');
}, 60_000);

afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });

describe('ticket b6d50f4a — grep false-zero replay (git grep + honest failure routing)', () => {
  jest.setTimeout(60_000);

  it('REPLAY: the incident alternation pattern scoped to backend RETURNS the matches — not "(no matches)"', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', {
      pattern: 'INVALID_TOKEN_SPIKE_THRESHOLD|auth-signal|Invalid-signature JWT spike',
      path: 'backend',
    });
    // The exact false zero the lane saw is gone: every alternation branch hits.
    expect(out).not.toBe('(no matches)');
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('backend/src/middleware/auth-signal.ts:2:export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;');
    expect(out).toContain("backend/src/middleware/error-handler.ts:1:import { recordInvalidTokenSignal } from './auth-signal';");
    expect(out).toContain('Invalid-signature JWT spike counter');
  });

  it('REPLAY (repo-wide scope — the second incident probe): matches across the worktree, worktree-relative paths', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', {
      pattern: 'recordInvalidTokenSignal|buildInvalidTokenSample|INVALID_TOKEN_SPIKE_THRESHOLD',
    });
    expect(out).not.toBe('(no matches)');
    expect(out).toContain('backend/src/middleware/auth-signal.ts:2:export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;');
    expect(out).toContain('recordInvalidTokenSignal');
  });

  it('DISCRIMINATOR — fails on the old code: an infra-failure exec (timeout shape) is an HONEST failure, never "(no matches)"', async () => {
    // The exact mechanism of the incident: execInContainer/execInProcess return
    // {stdout:'', stderr:'[exit: 124 — timed out]'} on timeout — they never
    // throw. The OLD tool read only stdout and answered "(no matches)".
    const deadExec = async () => ({ stdout: '', stderr: '[exit: 124 — timed out]' });
    const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'grep', { pattern: 'INVALID_TOKEN_SPIKE_THRESHOLD', path: 'backend' });
    expect(out).toMatch(/^Tool grep failed: the search did not complete/);
    expect(out).toContain('[exit: 124 — timed out]');
    expect(out).toContain('NOT a "no matches" verdict');
    expect(out).not.toContain('(no matches)');
  });

  it('a thrown exec (the .catch path) is also an honest failure, never "(no matches)"', async () => {
    const throwingExec = async () => { throw new Error('spawn ENOENT'); };
    const out = await executeCodingTool(mkCtx(throwingExec as typeof realExec), 'grep', { pattern: 'x' });
    expect(out).toMatch(/^Tool grep failed: the search did not complete/);
    expect(out).toContain('spawn ENOENT');
    expect(out).not.toBe('(no matches)');
  });

  it('a REAL no-match is still exactly "(no matches)" (no false positives from the sentinel)', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'ZQ_NO_SUCH_SYMBOL_ANYWHERE', path: 'backend' });
    expect(out).toBe('(no matches)');
  });

  it('a bad ERE is an honest failure carrying git\'s own diagnostic — not "(no matches)"', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(', path: 'backend' });
    expect(out).toMatch(/^Tool grep failed:/);
    expect(out).toContain('Unmatched ( or \\(');
    expect(out).not.toBe('(no matches)');
  });

  it('IGNORE-VIEW PARITY (the ticket ask): gitignored node_modules and .env are NOT searched; untracked visible files ARE — the same view as glob', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'ZQBAIT_INVALID_TOKEN_SPIKE_THRESHOLD|ZQBAIT_SECRET|scratch INVALID_TOKEN_SPIKE_THRESHOLD|SPIKE_THRESHOLD = 30' });
    // Ignored paths (the old tool crawled these — and read .env!) are excluded…
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('ZQBAIT_SECRET');
    // …while the untracked-but-visible scratch file IS found (glob's view)…
    expect(out).toContain('backend/src/middleware/scratch-note.ts:1:// scratch INVALID_TOKEN_SPIKE_THRESHOLD');
    // …and the tracked file still matches on its own line, so the exclusion
    // didn't take the whole search down with it.
    expect(out).toContain('backend/src/middleware/auth-signal.ts:2:export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;');
  });

  it('the glob filter composes with the scope (union-safe single pathspec)', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'SPIKE_THRESHOLD', path: 'backend', glob: '*.ts' });
    expect(out).toContain('backend/src/middleware/auth-signal.ts');
    expect(out).not.toContain('ZQBAIT_SECRET');
    expect(out).not.toBe('(no matches)');
  });

  it('a scoped FILE path still searches that one file', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'INVALID_TOKEN_SPIKE_THRESHOLD', path: 'backend/src/middleware/auth-signal.ts' });
    expect(out).toContain('auth-signal.ts:2:export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;');
    expect(out).not.toBe('(no matches)');
  });

  it('huge result sets cap at 200 lines WITH the truncation note — including when SIGPIPE kills git past the ~64KB pipe buffer (review F1)', async () => {
    // 400 lines × ~400 chars ≈ 160KB of RAW git output ≫ the ~64KB pipe buffer:
    // head -201 exits early, git dies on SIGPIPE, sentinel reads 141 — which must
    // route to the MATCHES path + truncation note (the pre-review code discarded
    // all 201 real matches as "Tool grep failed").
    const big = Array.from({ length: 400 }, (_, i) =>
      `// line ${i} ${'ZQBIGMATCH padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding'}`).join('\n');
    await fs.writeFile(path.join(WT, 'big-file.txt'), big);
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'ZQBIGMATCH' });
      const resultLines = out.split('\n').filter(l => l.includes('ZQBIGMATCH'));
      expect(resultLines.length).toBe(200);
      expect(out).toContain('…[truncated — more than 200 matches; narrow the pattern or scope]');
      expect(out).not.toMatch(/^Tool grep failed:/);
    } finally {
      await fs.rm(path.join(WT, 'big-file.txt'), { force: true });
    }
  });

  it('truncation is also detected BELOW the pipe-buffer threshold (head -201 overflow, exit 0 — review F1 companion)', async () => {
    // 250 short lines ≈ 8KB — no SIGPIPE, exit 0: the 201st-line overflow alone
    // must produce the same truncation note (the deterministic path).
    const big = Array.from({ length: 250 }, (_, i) => `ZQSHORT line ${i}`).join('\n');
    await fs.writeFile(path.join(WT, 'short-file.txt'), big);
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'ZQSHORT' });
      const resultLines = out.split('\n').filter(l => l.includes('ZQSHORT'));
      expect(resultLines.length).toBe(200);
      expect(out).toContain('…[truncated — more than 200 matches; narrow the pattern or scope]');
      expect(out).not.toMatch(/^Tool grep failed:/);
    } finally {
      await fs.rm(path.join(WT, 'short-file.txt'), { force: true });
    }
  });

  it('FILE scope + glob filter still searches the named file (review F2: composing the filter onto a file path was a silent false zero)', async () => {
    // The pre-review pathspec ':(glob)<file>/**/*.ts' made git exit 1 on a
    // swallowed "Not a directory" warning → "(no matches)" for a file that HAS
    // the match. The schema documents path as "subdirectory or file" and glob
    // as a filter — the combination must work.
    const out = await executeCodingTool(mkCtx(), 'grep', {
      pattern: 'INVALID_TOKEN_SPIKE_THRESHOLD', path: 'backend/src/middleware/auth-signal.ts', glob: '*.ts',
    });
    expect(out).toContain('auth-signal.ts:2:export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;');
    expect(out).not.toBe('(no matches)');
    expect(out).not.toMatch(/^Tool grep failed:/);
  });

  it('an empty/whitespace pattern is an honest validation failure, not a match-everything search', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '   ' });
    expect(out).toMatch(/^Tool grep failed: a pattern is required/);
    expect(out).not.toBe('(no matches)');
  });

  it('not-a-git-repo worktrees fail honestly (with the fallback hint), never "(no matches)"', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-b6d50f4a-nogit-'));
    try {
      await fs.writeFile(path.join(bare, 'a.txt'), 'INVALID_TOKEN_SPIKE_THRESHOLD\n');
      const out = await executeCodingTool({
        ...mkCtx(), worktree: bare,
      } as unknown as ToolContext, 'grep', { pattern: 'INVALID_TOKEN_SPIKE_THRESHOLD' });
      expect(out).toMatch(/^Tool grep failed:/);
      expect(out).toContain('not a git repository');
      expect(out).toContain('run_command');
      expect(out).not.toBe('(no matches)');
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('injection safety is PRESERVED: the pattern is single-quote-escaped, never expanded by the shell', async () => {
    const commands: string[] = [];
    const captureExec = async (command: string) => { commands.push(command); return { stdout: '', stderr: '' }; };
    await executeCodingTool(mkCtx(captureExec as typeof realExec), 'grep', { pattern: '$(touch /tmp/pwned)' });
    const cmd = commands[0];
    expect(cmd).toContain(`-e '$(touch /tmp/pwned)'`);
    expect(cmd).not.toMatch(/-e \$\(touch/); // not unquoted
    expect(cmd).toContain('git -c core.quotepath=off grep -nIE --untracked --full-name');
    // The sentinel must not be expandable either.
    expect(cmd).toContain('"${PIPESTATUS[0]}"');
  });

  it("an embedded single quote in the pattern can't break out of the quoting", async () => {
    const commands: string[] = [];
    const captureExec = async (command: string) => { commands.push(command); return { stdout: '', stderr: '' }; };
    await executeCodingTool(mkCtx(captureExec as typeof realExec), 'grep', { pattern: "a' ; rm -rf . ; '" });
    expect(commands[0]).toContain(`'a'\\'' ; rm -rf . ; '\\''`);
  });
});
