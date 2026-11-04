/**
 * audit 2026-10-06 T7-7 — run_command workspace-scope guard (stanne.md #1).
 */
import { checkCommandWorkspaceScope, globReach, runCommandWorkspaceGuardDisabled, workspaceGuardRefusalMessage, type WorkspaceGuardScope } from './workspace-path-guard';

const ROOT = '/app/coding-workspaces';
const SID = '3ec9e48a-1111-2222-3333-444455556666';
const PID = '52ad1f73-aaaa-bbbb-cccc-ddddeeeeffff';
const WT = `${ROOT}/worktrees/${SID}`;
const MIRROR = `${ROOT}/repos/${PID}.git`;
const HOME = `${ROOT}/worktrees/.sandbox-home/${SID}`;
const SCOPE: WorkspaceGuardScope = { root: ROOT, worktree: WT, allowed: [WT, MIRROR, HOME], mirror: MIRROR };

const refused = (cmd: string) => checkCommandWorkspaceScope(cmd, SCOPE).refused;

describe('checkCommandWorkspaceScope — the audited reviewer commands are refused', () => {
  it.each([
    'ls /app/coding-workspaces/worktrees/',
    'ls -la /app/coding-workspaces/repos',
    'for d in /app/coding-workspaces/worktrees/*/; do git -C "$d" log --oneline -3; git -C "$d" status; done',
    'for r in /app/coding-workspaces/repos/*.git; do git --git-dir=$r remote -v; done',
    'git -C /app/coding-workspaces/worktrees/66bf9d1f-0000-0000-0000-000000000000 log',
    'cat /app/coding-workspaces/worktrees/06553278-0000-0000-0000-000000000000/.digby/session/env.sh',
  ])('%s', (cmd) => {
    expect(refused(cmd)).toBe(true);
  });
});

describe('checkCommandWorkspaceScope — escapes within reason', () => {
  it.each([
    ['.. from the worktree', 'ls ..'],
    ['../.. to the root', 'ls ../..'],
    ['git -C a sibling', 'git -C ../12636e14-x log'],
    ['cd .. then list', 'cd .. && ls'],
    ['cd to root then relative', 'cd /app && ls coding-workspaces/worktrees'],
    ['cd / then relative', 'cd / && cat app/coding-workspaces/repos/x.git/config'],
    ['src/../.. climb', 'cat src/../../other/file'],
    ['double slash', 'ls /app//coding-workspaces//worktrees'],
    ['dot segment', 'ls /app/./coding-workspaces/repos'],
    ['/proc/self/root prefix', 'ls /proc/self/root/app/coding-workspaces/worktrees'],
    ['option value', 'git --git-dir=/app/coding-workspaces/repos/other.git log'],
    ['env assignment', 'W=/app/coding-workspaces/worktrees; ls $W'],
    ['redirect target', 'echo x >/app/coding-workspaces/worktrees/other/f'],
    ['symlink creation', 'ln -s /app/coding-workspaces/worktrees ./all'],
    ['glob on the root name', 'ls /app/coding-work*/worktrees'],
    ['glob on a parent segment', 'ls /app/*/worktrees'],
    ['brace expansion', 'ls /app/coding-workspaces/{worktrees,repos}'],
    ['partial-id glob', 'ls /app/coding-workspaces/worktrees/3ec9*'],
    ['$PWD/..', 'ls $PWD/..'],
    ['$(pwd)/../', 'ls "$(pwd)/../"'],
    ['git toplevel climb', 'ls $(git rev-parse --show-toplevel)/..'],
    ['git common-dir climb', 'ls $(git rev-parse --git-common-dir)/..'],
    ['dirname climb', 'cd "$(dirname "$PWD")" && ls'],
    ['recursive find of /', 'find / -name env.sh 2>/dev/null'],
    ['recursive grep of /app', 'grep -rn password /app'],
    ['ls -R of /', 'ls -R /'],
    ['du of the parent', 'du -sh /app'],
    ['rg over /', 'rg secret /'],
    ['python listing', "python3 -c \"import os; print(os.listdir('/app/coding-workspaces/worktrees'))\""],
    ['python relative', "python3 -c \"import os; print(os.listdir('..'))\""],
    ['bash -lc wrapper', "bash -lc 'ls /app/coding-workspaces/repos'"],
    ['the workspace root itself', 'ls /app/coding-workspaces'],
    ['the homes dir', 'ls /app/coding-workspaces/worktrees/.sandbox-home'],
    ['another session home', 'cat /app/coding-workspaces/worktrees/.sandbox-home/other/.aws/credentials'],
    ['an exclusion does not launder a direct reference', 'find /app/coding-workspaces/worktrees -path /app/coding-workspaces -prune -o -print'],
    ['a look-alike exclusion excludes nothing', 'grep -rn password /app --exclude-dir=coding-workspaces-old'],
  ])('%s', (_label, cmd) => {
    expect(refused(cmd)).toBe(true);
  });
});

describe("checkCommandWorkspaceScope — the session's own work is never blocked", () => {
  it.each([
    'ls',
    'ls -la',
    'npm test',
    'git status && git log --oneline -5',
    'git diff HEAD~1..HEAD',
    'git log main..HEAD',
    'cat src/index.ts',
    'ls src/*.ts',
    'find . -name "*.ts" | head',
    'grep -rn TODO .',
    'du -sh .',
    'cd packages/api && npm run build && cd ../web && npm run build',
    'cd packages/a && cat ../shared/index.ts',
    `ls ${WT}`,
    `ls ${WT}/src/*.ts`,
    `git -C ${WT} status`,
    `cat ${WT}/../${SID}/README.md`,
    `git --git-dir=${MIRROR} log --oneline -3`,
    `ls ${MIRROR}/worktrees`,
    `ls ${HOME}/.local/bin`,
    'ls $PWD/src',
    'echo "Loading..." && echo ...',
    'ls /tmp && cat /etc/os-release',
    'find /usr -name python3',
    'grep -rn foo /tmp/build',
    'ls /app',
    'cd /tmp && ls ..',
    'curl -s https://api.github.com/repos/o/r',
    'cd "$SOME_DIR" && ls ../x',
    // an EXCLUDED workspace root is not a reference, and keeps a walk of /app out of it
    'find /app -path /app/coding-workspaces -prune -o -name "*.py" -print',
    'grep -rn TODO /app --exclude-dir=coding-workspaces',
    'rg -n TODO /app -g "!coding-workspaces"',
    'du -sh /app --exclude=coding-workspaces',
  ])('%s', (cmd) => {
    expect(checkCommandWorkspaceScope(cmd, SCOPE)).toEqual({ refused: false, refs: [] });
  });
});

describe('verdict shape + helpers', () => {
  it('names the reason and the offending refs (≤ 5, normalized)', () => {
    const v = checkCommandWorkspaceScope('ls /app/coding-workspaces/worktrees/abc/ /app//coding-workspaces/repos', SCOPE);
    expect(v).toMatchObject({ refused: true, reason: 'foreign_path' });
    expect(v.refs).toEqual([`${ROOT}/worktrees/abc`, `${ROOT}/repos`]);
    expect(checkCommandWorkspaceScope('ls /app/coding-workspaces/worktrees', SCOPE).reason).toBe('workspace_root');
    expect(checkCommandWorkspaceScope('ls /app/coding-workspaces/worktrees/*', SCOPE).reason).toBe('glob');
    expect(checkCommandWorkspaceScope('find / -name x', SCOPE).reason).toBe('ancestor_traversal');
    expect(checkCommandWorkspaceScope('cd "$(dirname "$PWD")"', SCOPE).reason).toBe('dirname_escape');
  });

  it('globReach: below / ancestor / unrelated', () => {
    expect(globReach('/app/coding-work*/x', ROOT)).toBe('below');
    expect(globReach('/app/**', ROOT)).toBe('below');
    expect(globReach('/a*', ROOT)).toBe('ancestor');
    expect(globReach('/usr/*', ROOT)).toBeNull();
  });

  it('the refusal message leads with "[command REFUSED" (receipts record ok:false) and never echoes file contents', () => {
    const v = checkCommandWorkspaceScope('ls /app/coding-workspaces/worktrees', SCOPE);
    const msg = workspaceGuardRefusalMessage(v, SCOPE);
    expect(msg.startsWith('[command REFUSED — workspace scope] NOTHING was executed.')).toBe(true);
    expect(msg).toContain('"reason": "run_command_workspace_scope"');
    expect(msg).toContain(WT);
  });

  it('kill switch reader: RUN_COMMAND_WORKSPACE_GUARD_DISABLED', () => {
    const prev = process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED;
    try {
      delete process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED;
      expect(runCommandWorkspaceGuardDisabled()).toBe(false);
      process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED = '1';
      expect(runCommandWorkspaceGuardDisabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED; else process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED = prev;
    }
  });

  it('never throws on junk input', () => {
    expect(checkCommandWorkspaceScope(undefined as any, SCOPE)).toEqual({ refused: false, refs: [] });
    expect(checkCommandWorkspaceScope('ls [', SCOPE).refused).toBe(false);
  });
});

describe('remote executors are never read as local paths (2026-10-06 live false positive)', () => {
  const scope = { root: '/app/coding-workspaces', worktree: '/app/coding-workspaces/worktrees/s1', allowed: ['/app/coding-workspaces/worktrees/s1'], mirror: null };
  afterEach(() => { delete process.env.WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED; });
  it.each([
    ['run-on-box.sh with a remote find / (also after a quoted ;)', `bash scripts/framework-audit/run-on-box.sh A 'echo start; sudo find / -name "model-bench-mb1006a*" -not -path "/proc/*" 2>/dev/null | head -5; echo ---;'`],
    ['ssh with a remote grep -r /app', `ssh box-a "grep -rn TOKEN /app/coding-workspaces/worktrees/other | head"`],
    ['python3 infra/sshx.py', `python3 infra/sshx.py magenta 'ls -la /app/coding-workspaces/worktrees/x; du -sh /'`],
    ['aws ssm with a remote command', `aws ssm send-command --instance-ids i-1 --parameters 'commands=["find / -name x"]'`],
  ])('passes: %s', (_l, cmd) => {
    expect(checkCommandWorkspaceScope(cmd, scope).refused).toBe(false);
  });
  it('a LOCAL command chained after a remote one is still judged', () => {
    expect(checkCommandWorkspaceScope(`ssh box-a 'uptime'; find / -name x`, scope).refused).toBe(true);
  });
  it('a quoted local command is still judged (bash -c is local)', () => {
    expect(checkCommandWorkspaceScope(`bash -c 'ls /app/coding-workspaces/worktrees/other'`, scope).refused).toBe(true);
  });
  it('kill switch restores the literal reading', () => {
    process.env.WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED = '1';
    expect(checkCommandWorkspaceScope(`bash scripts/framework-audit/run-on-box.sh A 'echo ---; sudo find / -name x'`, scope).refused).toBe(true);
  });
});
