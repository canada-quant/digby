/**
 * v1#27 (P5 publish-path remediation) — run_command push/merge interception.
 *
 * session-credentials injects GH_TOKEN + a git credential helper per command,
 * so raw-shell `git push` / `gh pr merge` / REST merge curls bypass the gated
 * publish tools. The run_command handler detects the UNAMBIGUOUS shapes.
 *
 * Gate flip 2026-09-11 (owner: full steam) — the guard is OBSERVE-ONLY:
 *   - every run (machine or user-present) gets the `[publish-intent notice]`
 *     line after the status banner, a GUARD_STRIKE loop metric (seam
 *     'run_command_publish', state 'observed') is recorded, and the command
 *     EXECUTES (15/15 live refusals were owner-approved merges, own-branch
 *     pushes or text/GET false positives);
 *   - the ONE hard refusal left: `git remote add|set-url … x-access-token`
 *     (credential persistence) on machine runs — structured envelope, NOTHING
 *     executes, receipt ok:false;
 *   - a GET of …/pulls/<n>/merge (the merge-STATUS probe) no longer matches —
 *     the REST shape needs a write-verb marker (-X PUT/POST, -d/--data);
 *   - opt-in RUN_COMMAND_PUSH_GUARD_ENFORCE=1 restores the machine refusal for
 *     every pattern; the old RUN_COMMAND_PUSH_GUARD_DISABLED kill-switch is
 *     RETIRED (2026-09-11) — detection (and the credential refusal) can no
 *     longer be switched off.
 *
 * Boundary mocks mirror tools.test.ts.
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
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
  },
}));
// Background rail unavailable → run_command falls through to ctx.execShell
// (the observable seam for "did anything execute").
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => null),
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

import { executeCodingTool, detectPublishIntent, ToolContext } from './tools';
import { extractReceipt } from './run-receipts';

describe('v1#27: run_command publish-intent interception (observe-only since the 2026-09-11 gate flip)', () => {
  const mkCtx = (userTurnAt?: Date) => {
    const execShell = jest.fn(async () => ({ stdout: 'done', stderr: '' }));
    const ctx = {
      worktree: '/tmp/wt', sessionId: 'sess-1', userId: 'u1', runId: 'run-1', permissionMode: 'auto',
      emit: jest.fn(), alwaysAllow: new Set<string>(),
      requestApproval: async () => 'allow' as const,
      execShell,
      userTurnAt,
    } as unknown as ToolContext;
    return { ctx, execShell };
  };

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['RUN_COMMAND_PUSH_GUARD_DISABLED', 'RUN_COMMAND_PUSH_GUARD_ENFORCE'] as const;
  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockRecordLoopMetric.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  const observedMetric = (matched: string, machine: boolean) => expect.objectContaining({
    kind: 'guard_strike', sessionId: 'sess-1', runId: 'run-1',
    meta: { seam: 'run_command_publish', state: 'observed', matched, machine },
  });

  const MACHINE_OBSERVED_SHAPES: Array<[string, string]> = [
    ['git push origin main', 'git push'],
    ['git push', 'git push'],
    ['cd /repo && git push origin HEAD --force', 'git push'],
    ['git --no-pager push origin HEAD', 'git push'],
    ['gh pr merge 42 --squash --admin', 'gh pr merge'],
    ['curl -s -X PUT -H "Authorization: bearer $GH_TOKEN" https://api.github.com/repos/o/r/pulls/42/merge', 'GitHub REST merge call'],
    [`curl -X POST https://api.github.com/repos/o/r/merges -d '{"base":"main","head":"digby/x"}'`, 'GitHub REST merge call'],
  ];

  it.each(MACHINE_OBSERVED_SHAPES)('MACHINE run: %s → notice + EXECUTES + observed metric (no refusal)', async (command, what) => {
    const { ctx, execShell } = mkCtx(undefined);
    const out = await executeCodingTool(ctx, 'run_command', { command });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out.startsWith('[command OK]\n[publish-intent notice]')).toBe(true);
    expect(out).toContain(`"${what}"`);
    expect(out).toContain('git_push / open_pull_request');
    expect(out).not.toContain('REFUSED');
    expect(out).toContain('done');
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observedMetric(what, true));
    // The receipt verdict stays banner-anchored (the notice must not break it).
    expect(extractReceipt('run_command', { command }, out, new Date())).toMatchObject({ ok: true });
  });

  const HARD_REFUSED_SHAPES: Array<[string, string]> = [
    ['git remote set-url origin https://x-access-token:$GITHUB_TOKEN@github.com/o/r.git', 'git remote with an embedded x-access-token credential'],
    ['git remote add pushable https://x-access-token:tok@github.com/o/r.git', 'git remote with an embedded x-access-token credential'],
  ];

  it.each(HARD_REFUSED_SHAPES)('the ONE hard refusal — MACHINE run: %s → refused, nothing executed', async (command, what) => {
    const { ctx, execShell } = mkCtx(undefined);
    const out = await executeCodingTool(ctx, 'run_command', { command });
    expect(out).toMatch(/^\[command REFUSED — publish guard\] NOTHING was executed\./);
    const env = JSON.parse(out.slice(out.indexOf('\n') + 1));
    expect(env).toMatchObject({ ok: false, reason: 'run_command_publish_guard', matched: what });
    expect(env.message).toContain('credential');
    expect(env.useInstead).toBeTruthy();
    expect(execShell).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ seam: 'run_command_publish', state: 'refused', hardRefuse: true }),
    }));
  });

  it('the hard refusal extracts as an ok:false run_command receipt (nothing to exonerate)', async () => {
    const { ctx } = mkCtx(undefined);
    const command = 'git remote add pushable https://x-access-token:tok@github.com/o/r.git';
    const out = await executeCodingTool(ctx, 'run_command', { command });
    expect(extractReceipt('run_command', { command }, out, new Date())).toMatchObject({ ok: false });
  });

  it('the credential shape on a USER-PRESENT run keeps the pre-flip posture: notice + executes (no new restriction on humans)', async () => {
    const { ctx, execShell } = mkCtx(new Date());
    const out = await executeCodingTool(ctx, 'run_command', { command: 'git remote add pushable https://x-access-token:tok@github.com/o/r.git' });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out.startsWith('[command OK]\n[publish-intent notice]')).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observedMetric('git remote with an embedded x-access-token credential', false));
  });

  it('USER-PRESENT run: the command executes with the notice after the status banner — and no "user is present" excuse', async () => {
    const { ctx, execShell } = mkCtx(new Date());
    const out = await executeCodingTool(ctx, 'run_command', { command: 'git push origin HEAD' });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out.startsWith('[command OK]\n[publish-intent notice]')).toBe(true);
    expect(out).toContain('git_push / open_pull_request');
    expect(out).not.toContain('Proceeding because the user is present');
    expect(out).toContain('done');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observedMetric('git push', false));
    expect(extractReceipt('run_command', {}, out, new Date())).toMatchObject({ ok: true });
  });

  const BENIGN: string[] = [
    'git status',
    'git log --oneline -5',
    'git commit -m "push the button later"', // "push" not adjacent to git
    'grep -rn "git pushed" src/',            // pushed ≠ push (word boundary)
    'npm run push-notifications',
    'echo pushing && npm test',
    'gh pr view 42',
    'curl https://api.github.com/repos/o/r/pulls/42', // read, not merge
    'curl -s https://api.github.com/repos/o/r/pulls/10/merge', // the merge-STATUS probe (GET) — a live false positive
    'curl -sI https://api.github.com/repos/o/r/pulls/10/merge',
  ];

  it.each(BENIGN)('benign command runs untouched (machine run): %s', async (command) => {
    const { ctx, execShell } = mkCtx(undefined);
    const out = await executeCodingTool(ctx, 'run_command', { command });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('publish');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('phrase edges: a QUOTED phrase (`echo "git push"`) does not match; the UNQUOTED `echo git push` now only earns the notice and still runs', async () => {
    const quoted = mkCtx(undefined);
    const outQ = await executeCodingTool(quoted.ctx, 'run_command', { command: 'echo "git push"' });
    expect(outQ.startsWith('[command OK]')).toBe(true);
    expect(outQ).not.toContain('publish-intent notice');
    expect(quoted.execShell).toHaveBeenCalledTimes(1);
    const bare = mkCtx(undefined);
    const outB = await executeCodingTool(bare.ctx, 'run_command', { command: 'echo git push' });
    expect(outB).toContain('[publish-intent notice]');
    expect(outB).not.toContain('REFUSED');
    expect(bare.execShell).toHaveBeenCalledTimes(1);
  });

  it('PBG-1: the separated-argument form `git -C /path push` NOW matches (was a DOCUMENTED gap before 2026-11-03)', () => {
    // The pin flipped deliberately with the fix: this test used to assert
    // `toBeNull()` as an accepted conservatism. The enumeration that closed
    // PBG-1 measured that the separated form (and the path-prefixed binary, and
    // the shell wrapper) executed with NO notice and NO metric, so all three
    // are now OBSERVED. The rest of the conservatism list is re-pinned below.
    expect(detectPublishIntent('git -C /path push origin main')).toMatchObject({ what: 'git push', hardRefuse: false });
    expect(detectPublishIntent('git --git-dir=/r/.git push origin main')).toMatchObject({ what: 'git push' });
  });

  it('opt-in RUN_COMMAND_PUSH_GUARD_ENFORCE=1 → a machine `git push` is REFUSED again (old envelope), nothing executed', async () => {
    process.env.RUN_COMMAND_PUSH_GUARD_ENFORCE = '1';
    const { ctx, execShell } = mkCtx(undefined);
    const out = await executeCodingTool(ctx, 'run_command', { command: 'git push origin main' });
    expect(out).toMatch(/^\[command REFUSED — publish guard\] NOTHING was executed\./);
    const env = JSON.parse(out.slice(out.indexOf('\n') + 1));
    expect(env).toMatchObject({ ok: false, reason: 'run_command_publish_guard', matched: 'git push' });
    expect(env.message).toContain('gated tools');
    expect(execShell).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ seam: 'run_command_publish', state: 'refused', hardRefuse: false }),
    }));
  });

  it('ENFORCE=1 never touches USER-PRESENT runs (notice + executes, as before)', async () => {
    process.env.RUN_COMMAND_PUSH_GUARD_ENFORCE = '1';
    const { ctx, execShell } = mkCtx(new Date());
    const out = await executeCodingTool(ctx, 'run_command', { command: 'git push origin HEAD' });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('REFUSED');
    expect(out).toContain('[publish-intent notice]');
  });

  it('RETIRED kill-switch RUN_COMMAND_PUSH_GUARD_DISABLED=1 has NO effect: detection + notice + metric still happen, and the x-access-token refusal still fires', async () => {
    process.env.RUN_COMMAND_PUSH_GUARD_DISABLED = '1';
    const { ctx, execShell } = mkCtx(undefined);
    const out = await executeCodingTool(ctx, 'run_command', { command: 'git push origin main' });
    expect(execShell).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('REFUSED');
    expect(out).toContain('[publish-intent notice]');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'run_command_publish', state: 'observed' }) }));
    const cred = mkCtx(undefined);
    const refused = await executeCodingTool(cred.ctx, 'run_command', { command: 'git remote set-url origin https://x-access-token:ghp_abc@github.com/o/r.git' });
    expect(refused).toContain('[command REFUSED');
    expect(cred.execShell).not.toHaveBeenCalled();
  });

  it('PBG-1: enumERATION AS A PIN — every run_command→origin path with its OBSERVE-or-REFUSE verdict', () => {
    // The written enumeration lives in docs/FRAMEWORK_BACKLOG.md (PBG-1) and in
    // the PR body; this test is the executable half, so a future regex edit
    // that silently un-covers a path fails CI instead of drifting.
    const OBSERVE: Array<[string, string]> = [
      ['P1 raw', 'git push origin main'],
      ['P2 forced', 'git push --force origin HEAD'],
      ['P3 separated arg', 'git -C /w push origin main'],
      ['P3b separated --git-dir', 'git --git-dir=/r/.git push origin main'],
      ['P3c path-prefixed binary', '/usr/bin/git push origin main'],
      ['P3d relative-path binary', './bin/git push origin main'],
      ['P4 gh pr merge', 'gh pr merge 2421 --squash'],
      ['P4b path-prefixed gh', '/usr/bin/gh pr merge 7'],
      ['P5 REST merge PUT', 'curl -X PUT https://api.github.com/repos/a/b/pulls/1/merge'],
      ['P10 sh -c single-quoted', "sh -c 'git push origin main'"],
      ['P11 bash -c double-quoted', 'bash -c "git push origin main"'],
      ['P11b combined flags', 'bash -lc "gh pr merge 7"'],
      ['P17 subshell', '(git push origin main)'],
      ['P18 backgrounded', 'git push origin main &'],
      ['P19 env prefix', 'GIT_SSH_COMMAND=ssh git push origin main'],
    ];
    for (const [label, cmd] of OBSERVE) {
      const r = detectPublishIntent(cmd);
      expect([label, r?.what]).toEqual([label, expect.stringMatching(/^(git push|gh pr merge|GitHub REST merge call)$/)]);
      expect(r!.hardRefuse).toBe(false); // observe-only — never a refusal
    }

    // REFUSE — the ONE class: credential persistence, machine runs only.
    const refuse = detectPublishIntent('git remote set-url origin https://x-access-token:a@github.com/a/b.git');
    expect(refuse).toMatchObject({ hardRefuse: true });
    expect(detectPublishIntent('git remote add o https://x-access-token:a@github.com/a/b')!.hardRefuse).toBe(true);

    // UNCOVERED BY DESIGN (documented, not silent): a repo script or an npm
    // script that pushes internally, and a nested wrapper past the depth bound.
    for (const byDesign of ['./commit-and-push.sh', 'npm run publish:push', 'bash scripts/deploy.sh']) {
      expect(detectPublishIntent(byDesign)).toBeNull();
    }
    // …and these must STAY null or the guard starts crying wolf on reads.
    for (const read of ['git log --oneline -5', 'git fetch && git rebase origin/main', 'grep -rn "git push" docs/', 'echo "git push"', 'bash -x build.sh', 'curl https://api.github.com/repos/a/b/pulls/1/merge']) {
      expect(detectPublishIntent(read)).toBeNull();
    }
  });

  it('PBG-1 follow-up (review B1/B2/N1/N2/N3): the defects the FIRST cut shipped, pinned so they cannot come back', () => {
    // B1 — the first cut's "one separated argument" group was ambiguous (the
    // argument could itself be a flag), so a long flag run backtracked
    // exponentially INSIDE the synchronous run_command handler: a stuck tool
    // call, worse than the silent bypass being closed. Now the separated
    // argument is forbidden from starting with `-`, which makes matching
    // linear. Timing is asserted, not assumed: profiled shapes must stay well
    // inside a per-command budget (they run in 0–2 ms; 250 ms is generous).
    for (const n of [8, 12, 16, 20]) {
      const cmd = 'git log ' + Array.from({ length: n }, (_, i) => ['--stat', '--oneline', '--author=x', '--grep=y', '--'][i % 5]).join(' ');
      const t0 = Date.now();
      detectPublishIntent(cmd);
      expect([n, Date.now() - t0 < 250]).toEqual([n, true]);
    }

    // B2 — widening git/gh while leaving the credential class narrow made the
    // ONE auto-refused class bypassable by prefix: `x-access-token` remotes
    // under an executable path matched NOTHING.
    for (const cmd of [
      'git remote set-url origin https://x-access-token:a@github.com/a/b.git',
      '/usr/bin/git remote set-url origin https://x-access-token:a@github.com/a/b.git',
      './bin/git remote add o https://x-access-token:a@github.com/a/b',
    ]) {
      expect([cmd, detectPublishIntent(cmd)?.hardRefuse]).toEqual([cmd, true]);
    }

    // N1 — the wrapper unwrap must not depend on `c` being GLUED to the flag
    // cluster: `bash -e -c …` / `sh -o pipefail -c …` are the ordinary forms.
    for (const cmd of [
      "bash -c 'git push origin main'",
      'bash -c "git push origin main"',
      "bash -e -c 'git push origin main'",
      "bash -eu -c 'git push origin main'",
      "sh -e -c 'git push origin main'",
      'bash -o pipefail -c "git push origin main"',
      "bash -ec 'git push origin main'",
      "bash --command 'git push origin main'",
    ]) {
      expect([cmd, detectPublishIntent(cmd)?.what]).toEqual([cmd, 'git push']);
    }
    // …while a script-file invocation is NOT a payload and yields nothing.
    expect(detectPublishIntent('bash -x build.sh')).toBeNull();
    expect(detectPublishIntent('bash scripts/deploy.sh')).toBeNull();

    // N2 — the path prefix must look like an EXECUTABLE path. A bare `bin/`
    // made quoted prose match, which is exactly the crying-wolf failure the
    // 15/15 refusals taught.
    for (const cmd of ['grep -rn "bin/git push" docs/', 'echo "please run bin/git push later"', 'grep -rn "git push" docs/', 'echo "git push"']) {
      expect([cmd, detectPublishIntent(cmd)]).toEqual([cmd, null]);
    }

    // N3 — the documented separated form must be PINNED, not just true.
    expect(detectPublishIntent('git --git-dir /r/.git push origin main')).toMatchObject({ what: 'git push' });
    expect(detectPublishIntent('git -C /w push origin main')).toMatchObject({ what: 'git push' });
  });

  it('detectPublishIntent: unit rows for the exact shapes (+ hardRefuse flag, + REST write-verb requirement)', () => {
    expect(detectPublishIntent('git push')).toMatchObject({ what: 'git push', hardRefuse: false });
    expect(detectPublishIntent('VAR=1 git push origin x')!.what).toBe('git push');
    expect(detectPublishIntent('gh pr merge 7')!.what).toBe('gh pr merge');
    // REST: a bare GET of the merge endpoint is the merge-STATUS probe → null.
    expect(detectPublishIntent('curl https://api.github.com/repos/a/b/pulls/7/merge')).toBeNull();
    expect(detectPublishIntent('curl -X PUT https://api.github.com/repos/a/b/pulls/7/merge')!.what).toBe('GitHub REST merge call');
    expect(detectPublishIntent('curl -XPUT https://api.github.com/repos/a/b/pulls/7/merge')!.what).toBe('GitHub REST merge call'); // attached -X form
    expect(detectPublishIntent('curl --method=POST https://api.github.com/repos/a/b/merges')!.what).toBe('GitHub REST merge call');
    expect(detectPublishIntent('curl --request PUT https://api.github.com/repos/a/b/pulls/7/merge')!.what).toBe('GitHub REST merge call');
    expect(detectPublishIntent(`curl https://api.github.com/repos/a/b/pulls/7/merge -d '{"merge_method":"squash"}'`)!.what).toBe('GitHub REST merge call');
    expect(detectPublishIntent('curl -X POST https://api.github.com/repos/a/b/merges --data @body.json')!.what).toBe('GitHub REST merge call');
    expect(detectPublishIntent('git remote add o https://x-access-token:t@github.com/a/b'))
      .toMatchObject({ what: 'git remote with an embedded x-access-token credential', hardRefuse: true });
    expect(detectPublishIntent('git fetch && git rebase origin/main')).toBeNull();
    expect(detectPublishIntent('gh pr create --fill')).toBeNull(); // create is not merge
  });
});
