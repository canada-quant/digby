/**
 * session-bg.ts — pure attribution + script builders (ticket ff262da5 /
 * todo 4ecfd309, 2026-10-16). PIN SUITE.
 *
 * The incident (2026-10-16 census, ticket ff262da5): the shared dev container
 * sat at 22.4/24.5 GiB (91.6%) with 54 session daemons and 311 cumulative
 * OOM kills; 4/4 verify runs in 30 min failed environmentally. The census's
 * attribution lessons this suite pins:
 *   - a daemon whose worktree cwd was DELETED is unattributable by cwd —
 *     environ DIGBY_ENV names the session (verified live: the 18 h
 *     next-server and the 22-day stub both carried
 *     DIGBY_ENV=<worktree>/.digby/session/env.sh);
 *   - tracked monitors (/tmp/digby-proc/<sid>/<handle>/pgid) are a FEATURE
 *     spanning runs — the run-end reap spares them, the idle sweep kills them;
 *   - the platform egress daemon (tailscaled, ports 1055/1056) is NEVER a
 *     victim (e72b88f9 doctrine);
 *   - the bare '.sandbox-home' marker is never a session id (e72b88f9 N1).
 */
import {
  SESSION_BG_MARKER, sessionPathCasePatterns, sessionBgScanScript, parseSessionBgRows,
  sessionBgAccounting, sessionRunEndReapScript, sessionIdleReapScript, countReaped,
  sessionBgReapMinAgeSec, sessionBgWorkspaceRoot, sessionBgReapDisabled,
} from './session-bg';

const ROOT = '/app/coding-workspaces';
const SID = 'a1cd1d3f-5a7f-43c5-a7bc-17b0ba620687';

describe('session-bg — path case patterns (both layouts + sandbox-home)', () => {
  test('legacy layout: <root>/worktrees/<sid> and its subtree', () => {
    const p = sessionPathCasePatterns(SID, ROOT);
    expect(p).toContain(`"${ROOT}"/worktrees/"${SID}"`);
    expect(p).toContain(`"${ROOT}"/worktrees/"${SID}"/*`);
  });
  test('per-user layout: <root>/<key>/worktrees/<sid> and its subtree', () => {
    const p = sessionPathCasePatterns(SID, ROOT);
    expect(p).toContain(`"${ROOT}"/*/worktrees/"${SID}"`);
    expect(p).toContain(`"${ROOT}"/*/worktrees/"${SID}"/*`);
  });
  test('sandbox-home both forms are covered', () => {
    const p = sessionPathCasePatterns(SID, ROOT);
    expect(p).toContain(`"${ROOT}"/worktrees/.sandbox-home/"${SID}"`);
    expect(p).toContain(`"${ROOT}"/*/.sandbox-home/"${SID}"/*`);
  });
  test('a malicious session id cannot escape the pattern (sanitized)', () => {
    const p = sessionPathCasePatterns('abc"); rm -rf / #', ROOT);
    expect(p).not.toContain('rm -rf');
    expect(p).toContain('abcrm-rf');
  });
  test('an empty session id yields no patterns', () => {
    expect(sessionPathCasePatterns('', ROOT)).toBe('');
  });
});

describe('session-bg — scan script shape', () => {
  test('embeds the self-marker, the egress exclusion, uid-0 exclusion, tracked-pgid check and the environ fallback', () => {
    const s = sessionBgScanScript(ROOT);
    expect(s).toContain(SESSION_BG_MARKER);
    expect(s).toContain('--statedir=/var/lib/digby-tailscale');
    expect(s).toContain('[ "$uid" != "0" ]');
    expect(s).toContain('/tmp/digby-proc/$sess/*/pgid');
    expect(s).toContain('DIGBY_ENV='); // environ fallback for deleted cwds
    expect(s).toContain('__BG__ ');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('session-bg — parseSessionBgRows', () => {
  test('parses a well-formed __BG__ row', () => {
    const rows = parseSessionBgRows(`__BG__ 123 1001 123 512000 4321 0 ${SID} node server.js`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: '123', uid: '1001', pgid: '123', rssKb: 512000, etimes: 4321, tracked: false, sessionId: SID, args: 'node server.js' });
  });
  test('parses the tracked flag and multi-token args', () => {
    const rows = parseSessionBgRows(`__BG__ 9 1001 9 2048 10 1 ${SID} ssh-agent -s extra-arg`);
    expect(rows[0]?.tracked).toBe(true);
    expect(rows[0]?.args).toBe('ssh-agent -s extra-arg');
  });
  test('skips malformed, partial, and non-__BG__ lines (best-effort shell)', () => {
    const out = [
      '__BG__ 1 1001 1', // too few columns
      '__BG__ x 1001 1 10 10 0 sid args', // non-numeric pid
      'some shell noise',
      '__BG__ 2 1001 2 10 10 0 .sandbox-home args', // bare marker as sid (e72b88f9 N1)
      '__BG__ 3 1001 3 10 10 0', // 7 columns but sid empty → dropped by the shell's own guard; the parser still tolerates it
      `__BG__ 4 1001 4 10 10 0 ${SID} real row`,
    ].join('\n');
    const rows = parseSessionBgRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe('4');
  });
  test('empty/garbage input → zero rows, never throws', () => {
    expect(parseSessionBgRows('')).toEqual([]);
    expect(parseSessionBgRows('\x00garbage\n\n')).toEqual([]);
  });
});

describe('session-bg — accounting aggregate', () => {
  test('sums RSS and counts per session, tracked separately', () => {
    const rows = parseSessionBgRows([
      `__BG__ 1 1001 1 100 10 1 ${SID} a`,
      `__BG__ 2 1001 2 200 10 0 ${SID} b`,
      '__BG__ 3 1001 3 400 10 0 other-session c',
    ].join('\n'));
    const acc = sessionBgAccounting(rows);
    expect(acc.get(SID)).toEqual({ rssKb: 300, count: 2, tracked: 1 });
    expect(acc.get('other-session')).toEqual({ rssKb: 400, count: 1, tracked: 0 });
  });
});

describe('session-bg — RUN-END reap script (charter item 1)', () => {
  test('spares tracked monitors (the cross-run feature), kills untracked', () => {
    const s = sessionRunEndReapScript(SID, ROOT, 300);
    expect(s).toContain('/tmp/digby-proc/$SID/*/pgid');
    expect(s).toContain('[ "$t" = "0" ] || continue'); // tracked → spared
  });
  test('age floor: default 300s, clamped ≥60, env-tunable', () => {
    expect(sessionBgReapMinAgeSec()).toBe(300);
    expect(sessionBgReapMinAgeSec({ SESSION_BG_REAP_MIN_AGE_SEC: '1' } as any)).toBe(60);
    expect(sessionBgReapMinAgeSec({ SESSION_BG_REAP_MIN_AGE_SEC: '900' } as any)).toBe(900);
  });
  test('gates at kill time: uid, age, attribution (cwd OR environ), egress shape, self-marker', () => {
    const s = sessionRunEndReapScript(SID, ROOT, 300);
    expect(s).toContain('[ "$et" -ge "$FLOOR" ] || continue');
    expect(s).toContain('readlink /proc/$pid/cwd');
    expect(s).toContain('DIGBY_ENV=');
    expect(s).toContain('--statedir=/var/lib/digby-tailscale');
    expect(s).toContain(SESSION_BG_MARKER);
    expect(s).toContain('__REAPED__ ');
  });
});

describe('session-bg — IDLE sweep script (the 54-daemon backlog drain)', () => {
  test('kills tracked monitors too (an idle session monitor is garbage) and removes the proc registry', () => {
    const s = sessionIdleReapScript([SID], ROOT);
    expect(s).not.toContain('[ "$t" = "0" ] || continue');
    expect(s).toContain(`rm -rf /tmp/digby-proc/${SID}`);
    expect(s).toContain('__REAPED__ ');
  });
  test('covers multiple sessions in one pass and never matches the platform egress shape', () => {
    const s = sessionIdleReapScript([SID, 'deadbeef-1111'], ROOT);
    expect(s).toContain(`rm -rf /tmp/digby-proc/${SID}`);
    expect(s).toContain('rm -rf /tmp/digby-proc/deadbeef-1111');
    expect(s).toContain('--statedir=/var/lib/digby-tailscale');
    expect(s).toContain(SESSION_BG_MARKER);
  });
  test('empty session list → no-op script (never throws)', () => {
    const s = sessionIdleReapScript([], ROOT);
    expect(s).toContain('true');
    expect(s).not.toContain('rm -rf /tmp/digby-proc/');
  });
});

describe('session-bg — countReaped + kill switches', () => {
  test('counts __REAPED__ lines only', () => {
    expect(countReaped('__REAPED__ 1 a\nnoise\n__REAPED__ 2 b\n__BG_REAP_OK__')).toBe(2);
    expect(countReaped('')).toBe(0);
  });
  test('SESSION_BG_REAP_DISABLED=1 refuses both reaps', () => {
    expect(sessionBgReapDisabled({ SESSION_BG_REAP_DISABLED: '1' } as any)).toBe(true);
    expect(sessionBgReapDisabled({} as any)).toBe(false);
  });
  test('workspace root: env CODING_WORKSPACE_ROOT wins, default /app/coding-workspaces, trailing slash trimmed', () => {
    expect(sessionBgWorkspaceRoot()).toBe('/app/coding-workspaces');
    expect(sessionBgWorkspaceRoot({ CODING_WORKSPACE_ROOT: '/x/y/' } as any)).toBe('/x/y');
  });
});
