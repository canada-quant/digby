/**
 * audit 2026-10-08 W2-8 — the run_command workspace-scope guard's DATA-AWARE
 * reading. Replays the prod refusal shapes of 2026-10-07/08 (loop_metrics
 * guard_strike seam run_command_workspace_scope; the nightly adjudicator judged
 * 12 false positive / 0 true positive): heredoc bodies and multi-word quoted
 * data were read as shell, quotes broke words, `find / -maxdepth 3` counted as
 * an ancestor traversal, and `ln -s` targets resolved against the cwd. Only the
 * command SHAPES are replayed (the lane's own worktree id is the test SID).
 * The true positives stay refused, and WORKSPACE_GUARD_DATA_AWARE_DISABLED=1
 * restores the literal reading.
 */
import {
  checkCommandWorkspaceScope, checkCommandWorkspaceScopeLegacy, extractHeredocs, workspaceGuardDataAwareDisabled,
  type WorkspaceGuardScope,
} from './workspace-path-guard';

const ROOT = '/app/coding-workspaces';
const SID = '7bd45d57-059b-42c5-8245-ea1ee358635f';
const PID = '52ad1f73-aaaa-bbbb-cccc-ddddeeeeffff';
const WT = `${ROOT}/worktrees/${SID}`;
const MIRROR = `${ROOT}/repos/${PID}.git`;
const HOME = `${ROOT}/worktrees/.sandbox-home/${SID}`;
const SCOPE: WorkspaceGuardScope = { root: ROOT, worktree: WT, allowed: [WT, MIRROR, HOME], mirror: MIRROR };

const verdict = (cmd: string) => checkCommandWorkspaceScope(cmd, SCOPE);

const withEnv = (key: string, value: string | undefined, fn: () => void): void => {
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
};

// The prod false positives (2026-10-07 17:03Z → 2026-10-08 19:03Z), shapes only.
const PROD_FALSE_POSITIVES: Array<[string, string]> = [
  // 7bd45d57 05:48Z / e91d41cf 18:45Z — python heredoc run from the lane's own worktree (workspace_root)
  ['python heredoc in the own worktree', `cd ${WT} && python3 - <<'PY'\nimport re\n# fix the misplaced docstring; events.py sits two levels below the repo root, never touch .. here\np="optcg_api/routers/events.py"; s=open(p,encoding="utf-8").read()\nlines=s.split("\\n")\nfor i, l in enumerate(lines):\n    if l.strip().startswith('"""') and i > 0:\n        print(i, l)\nPY`],
  ['python heredoc after a git toplevel cd, piped', `cd "$(git rev-parse --show-toplevel)" && python3 - <<'PY' 2>&1 | head -90\nimport re, collections\n# compare the fixture against .. the parser output\nFIX="tests/fixtures/combat_logs/optcgsim_v1.42c_rocks-vs-mihawk.txt"\nprint(collections.Counter(re.findall(r"\\w+", open(FIX).read())).most_common(5))\nPY`],
  ['venv python heredoc', `cd ${WT} && .venv/bin/python - <<'PY'\nimport json, pathlib, re, collections\n# relative paths only: db/migrations, never ../ climbs\nprint(sorted(pathlib.Path('db/migrations').glob('*.sql'))[-1])\nPY`],
  // 39214f7b 19:03Z / 9effe0d0 18:38Z / af23b007 19:23Z — a probe test written with cat <<'EOF' (glob /**)
  ['cat heredoc writing a probe test (/** comment)', `cat > /tmp/digby-proc/pr1356-review/backend/src/modules/crossmodel/platform/__scratch_review_probe.test.ts <<'EOF'\n/** SCRATCH REVIEW PROBE (adversarial review of the diff) */\nimport { x } from '../feedback/feedback.service';\nimport { y } from '../coding/run-receipts';\ndescribe('probe', () => { it('x', () => expect(x).toBeDefined()); });\nEOF`],
  // 9effe0d0 17:16Z — jest.mock('../../utils/logger') in a heredoc body (foreign_path)
  ['cat heredoc with jest.mock(../../utils/logger) and a spaced delimiter', `cd backend && cat > /tmp/probe-timing.test.ts << 'EOF'\njest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));\nEOF\nnpx jest /tmp/probe-timing.test.ts`],
  // 5f90c628 22:37Z / 521edf42 08:51Z / 0037460b 20:12Z — a shallow find of / (ancestor_traversal)
  ['find / -maxdepth 3', 'pwd; ls -d /app 2>/dev/null; find / -maxdepth 3 -name ".git" -type d 2>/dev/null | head -5'],
  ['find / -maxdepth 3 for a dir', 'ls -la /; ls -la ~ 2>/dev/null | head -30; find / -maxdepth 3 -name "optcg_scraper" -type d 2>/dev/null | head'],
  // e1d114f9 17:03Z — `"$(git rev-parse --show-toplevel)"/backend` read as two words, then cd ../frontend (foreign_path)
  ['quoted toplevel + /backend, then cd ../frontend', `cd "$(git rev-parse --show-toplevel)"/backend && grep -n '"eslint' package.json | head -5; ls node_modules/.bin/ | grep -i eslint | head -3; echo "---frontend---"; cd ../frontend && grep -n '"eslint' package.json | head -5`],
  // d726af77 22:41Z / af1340f8 17:18Z — a remote command handed to a custom runner (ancestor_traversal /)
  ['custom remote runner (labcmd.py) with a remote find /', `cd ${WT} && python3 scratch/labcmd.py 100.64.0.1 root -- 'curl -s "http://localhost:8100/api/x"; find / -name y 2>/dev/null | head'`],
  ['timeout + custom runner after toplevel cd', `cd "$(git rev-parse --show-toplevel)" && timeout 180 python3 scratch/labcmd.py 100.64.0.1 -- 'echo "=== gateway container ==="; docker ps --format "{{.Names}}"; du -sh /'`],
  // 3f077b54 18:43Z — box_exec.py "docker exec … grep -rn \"require(\\\"../\\\"\" …" (foreign_path worktrees/\)
  ['box_exec.py with a docker exec grep', `python3 scripts/box_exec.py "docker exec digby-backend sh -c 'grep -rn \\"require(\\\\\\"../\\" /app/dist/modules/crossmodel/github/github-oauth.controller.js | grep x'"`],
  // 7ebb8fcf 16:54Z / cbcf95fc 17:14Z — relative symlink targets resolve from the LINK's directory
  ['ln -sfn relative targets from a review subdir', 'cd tmp/review-2fc3 && ln -sfn ../../../backend/node_modules backend/node_modules && ln -sfn ../../../frontend/node_modules frontend/node_modules && readlink backend/node_modules'],
  ['ln -sfn from an absolute review subdir', `cd ${WT}/tmp/review-9b944f30 && ln -sfn ../../../backend/node_modules backend/node_modules && ln -sfn ../../../frontend/node_modules frontend/node_modules`],
  // multi-word quoted DATA (echo banners / commit messages) never reads as a path
  ['echo banners with paths in them', 'echo "=== find pg_ctl/initdb under it ===" && echo "see ../ and / for details"'],
  ['commit message with a climb', 'git commit -m "fix: resolve ../../utils/logger mock and / root walk"'],
];

describe('W2-8 replay — the prod false positives now pass', () => {
  it.each(PROD_FALSE_POSITIVES)('%s', (_label, cmd) => {
    expect(verdict(cmd)).toEqual({ refused: false, refs: [] });
  });
});

describe('W2-8 — the literal reading (kill switch) still refuses every replayed shape it refused', () => {
  // The shapes the LITERAL reading refused in prod (a few in the list above are
  // new data-aware passes the literal reading also passed — those are skipped).
  const literalRefused = PROD_FALSE_POSITIVES.filter(([, cmd]) => checkCommandWorkspaceScopeLegacy(cmd, SCOPE).refused);
  it('the replay covers the prod refusals (≥ 10 shapes refused by the literal reading)', () => {
    expect(literalRefused.length).toBeGreaterThanOrEqual(10);
  });
  it.each(literalRefused)('%s refuses with WORKSPACE_GUARD_DATA_AWARE_DISABLED=1', (_label, cmd) => {
    withEnv('WORKSPACE_GUARD_DATA_AWARE_DISABLED', '1', () => {
      expect(verdict(cmd).refused).toBe(true);
    });
  });
});

describe('W2-8 — true positives stay refused', () => {
  it.each([
    ['python heredoc listing the worktrees', `python3 - <<'PY'\nimport os\nprint(os.listdir('/app/coding-workspaces/worktrees'))\nPY`, 'workspace_root'],
    ['python heredoc reading another worktree file', `python3 - <<'PY'\nprint(open("/app/coding-workspaces/worktrees/66bf9d1f-0000/.digby/session/env.sh").read())\nPY`, 'foreign_path'],
    ['python heredoc climbing with a .. literal', `python3 - <<'PY'\nimport os\nprint(os.listdir('..'))\nPY`, 'workspace_root'],
    ['bash heredoc is shell', `bash <<'EOF'\nls /app/coding-workspaces/worktrees\nEOF`, 'workspace_root'],
    ['sh heredoc with a relative climb is shell', `sh <<EOF\ncd .. && ls\nEOF`, 'workspace_root'],
    ['heredoc redirect target is shell', `cat <<EOF > /app/coding-workspaces/worktrees/other/f\nx\nEOF`, 'foreign_path'],
    ['unquoted heredoc command substitution runs locally', `cat <<EOF\n$(ls /app/coding-workspaces/repos)\nEOF`, 'workspace_root'],
    ['single-word quoted absolute path', `echo "/app/coding-workspaces/worktrees/other-id/secret"`, 'foreign_path'],
    ['multi-word quoted DATA naming another worktree', `echo "see /app/coding-workspaces/worktrees/other-id/secret now"`, 'foreign_path'],
    ['data glob with a root literal prefix', `echo "for d in /app/coding-workspaces/worktrees/*"`, 'glob'],
    ['find / -maxdepth 4 can name session dirs', 'find / -maxdepth 4 -name "*node-a*"', 'ancestor_traversal'],
    ['find / without maxdepth', 'find / -name "libnspr4.so*" -o -name "libnss3.so*" 2>/dev/null | head -20', 'ancestor_traversal'],
    ['ln -s absolute target', 'ln -s /app/coding-workspaces/worktrees ./all', 'workspace_root'],
    ['ln -s relative target that climbs out of the worktree from its link dir', 'ln -s ../../other-session/.digby link', 'foreign_path'],
    ['bash -c quoted string is shell', `bash -c 'ls /app/coding-workspaces/worktrees/other'`, 'foreign_path'],
    ['sudo bash -lc with a relative climb', `sudo bash -lc 'cd .. && ls'`, 'workspace_root'],
    ['eval string is shell', `eval "ls /app/coding-workspaces/repos && echo x"`, 'workspace_root'],
    ['double-quoted command substitution is shell', `echo "found: $(ls ../.. | head -3)"`, 'workspace_root'],
    ['node -e code reading the root', `node -e "console.log(require('fs').readdirSync('/app/coding-workspaces/worktrees'))"`, 'workspace_root'],
  ])('%s', (_label, cmd, reason) => {
    const v = verdict(cmd);
    expect(v.refused).toBe(true);
    expect(v.reason).toBe(reason);
  });

  it('a heredoc fed to ssh is a REMOTE command (exemption on) but literal under WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED=1', () => {
    const cmd = `ssh box-a <<'EOF'\nfind / -name x\nEOF`;
    expect(verdict(cmd).refused).toBe(false);
    withEnv('WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED', '1', () => {
      expect(verdict(cmd).refused).toBe(true);
    });
  });

  it('a heredoc does not hide the command AFTER its terminator', () => {
    expect(verdict(`cat > /tmp/x <<'EOF'\nhello\nEOF\nls /app/coding-workspaces/worktrees`).refused).toBe(true);
  });
});

describe('W2-8 helpers', () => {
  it('extractHeredocs lifts bodies (quoted / bare / <<- tabs) and keeps the rest', () => {
    const r = extractHeredocs(`cat <<'A' > f\nline a\nA\necho mid\ncat <<-B\n\tline b\n\tB\necho end`);
    expect(r.docs.map((d) => [d.delim, d.quoted, d.body])).toEqual([['A', true, 'line a'], ['B', false, '\tline b']]);
    expect(r.text).toContain('echo mid');
    expect(r.text).toContain('echo end');
    expect(r.text).not.toContain('line a');
  });
  it('an arithmetic shift and a here-string are not heredocs', () => {
    expect(extractHeredocs('echo $((1 << 2)); cat <<< "x y"').docs).toEqual([]);
  });
  it('a << inside quotes is not a heredoc', () => {
    expect(extractHeredocs(`echo "a << b"\nls`).docs).toEqual([]);
  });
  it('kill switch reader: WORKSPACE_GUARD_DATA_AWARE_DISABLED', () => {
    withEnv('WORKSPACE_GUARD_DATA_AWARE_DISABLED', undefined, () => expect(workspaceGuardDataAwareDisabled()).toBe(false));
    withEnv('WORKSPACE_GUARD_DATA_AWARE_DISABLED', '1', () => expect(workspaceGuardDataAwareDisabled()).toBe(true));
  });
  it('never throws on junk', () => {
    expect(verdict(`cat <<'`)).toEqual({ refused: false, refs: [] });
    expect(verdict(`python3 -c "unterminated`)).toEqual({ refused: false, refs: [] });
    expect(verdict(undefined as any)).toEqual({ refused: false, refs: [] });
  });
});
