/**
 * Reconnect with the saved key (2026-10-13, owner: "properly configure it for
 * professional config"). Pins: the key reaches the container ONLY over stdin
 * into a root-owned 0600 file at a path the boot script never reads; the join
 * reads it via `--auth-key=file:` (never argv); the file is removed on every
 * path (script trap + a belt-and-braces rm even when the exec dies); the key
 * is never logged or returned; failures come back as a classified outcome with
 * a plain note (tailscale's own output never leaves the container); the
 * daemon's Running state, not the CLI exit code, decides "joined"; no-key /
 * not-running / not-enabled refuse without touching the container. Also pins
 * the pure helpers (nodeIdentityFields, parseReconnectOutput, reconnectScript).
 */
process.env.DEV_JOIN_VERIFY_TIMEOUT_MS = '120';
process.env.DEV_JOIN_VERIFY_POLL_MS = '20';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: mockLogger }));

const mockPrisma: any = {
  userPreferences: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  agentRun: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
jest.mock('fs/promises', () => ({ __esModule: true, mkdir: jest.fn(async () => undefined) }));
const mockIsDockerAvailable = jest.fn(async () => true);
jest.mock('./container.service', () => ({
  __esModule: true,
  isDockerAvailable: (...a: any[]) => (mockIsDockerAvailable as any)(...a),
  SANDBOX_HOMES_ROOT: '/tmp/digby-sandbox-homes',
  containerMountDestinations: jest.fn(async () => null),
}));
jest.mock('./workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
jest.mock('./workspace-layout', () => ({ __esModule: true, ...jest.requireActual('./workspace-layout'), listSubtreeKeysSync: () => [] }));

const SECRET = 'tskey-auth-kSECRETvalue0123456789';
const mockGetCred = jest.fn(async (): Promise<string | null> => SECRET);
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: (...a: any[]) => (mockGetCred as any)(...a) }));

// execFile: script the docker sub-invocations; record argv AND stdin writes.
const calls: { args: string[]; stdin: string }[] = [];
let running = true;
let joinedAfter = true;            // tailscale status --json → Running?
let reconnectStdout = 'DIGBY_RECONNECT rc=0 class=ok\n';
let reconnectThrows = false;       // the join exec dies (timeout / killed)
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    const rec = { args, stdin: '' };
    calls.push(rec);
    let stdout = '';
    let err: any = null;
    if (args[0] === 'ps') stdout = running ? (args.find(a => a.startsWith('name=^')) ?? '').replace(/^name=\^/, '').replace(/\$$/, '') : '';
    else if (args[0] === 'exec' && args.includes('status')) {
      if (joinedAfter) stdout = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.9'], HostName: 'digby-dev', Online: true, Tags: ['tag:digby-dev'], KeyExpiry: '0001-01-01T00:00:00Z' } });
      else stdout = JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/zzz', Self: { Online: false } });
    } else if (args[0] === 'exec' && args.some(a => a.includes('DIGBY_RECONNECT'))) {
      if (reconnectThrows) err = Object.assign(new Error('timeout'), { stdout: '', stderr: '' });
      else stdout = reconnectStdout;
    }
    const child: any = { stdin: { write: (d: string) => { rec.stdin += d; }, end: () => {} } };
    process.nextTick(() => cb(err, stdout, ''));
    return child;
  },
}));

import {
  reconnectDevTailnet, reconnectScript, parseReconnectOutput, nodeIdentityFields, reconnectNote,
  getDevContainerStatus, RECONNECT_KEY_PATH,
} from './dev-container.service';

let n = 0;
const uid = () => `recon-user-${String(n++).padStart(4, '0')}`;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  running = true; joinedAfter = true; reconnectThrows = false;
  reconnectStdout = 'DIGBY_RECONNECT rc=0 class=ok\n';
  mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: true });
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
  mockIsDockerAvailable.mockResolvedValue(true);
  mockGetCred.mockResolvedValue(SECRET);
});

const allArgv = () => calls.map(c => c.args.join(' ')).join('\n');
const loggedText = () => JSON.stringify([mockLogger.info.mock.calls, mockLogger.warn.mock.calls, mockLogger.error.mock.calls]);

describe('reconnectDevTailnet', () => {
  it('joins with the saved key delivered over STDIN to the reconnect path — never argv, never logged, never returned', async () => {
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('joined');
    expect(r.status.note).toBe(reconnectNote('joined'));
    // Delivery: exactly one exec -i writing the key on stdin to the reconnect path, umask 077 first.
    const delivery = calls.filter(c => c.args[0] === 'exec' && c.args[1] === '-i');
    expect(delivery).toHaveLength(1);
    expect(delivery[0].stdin).toBe(SECRET);
    expect(delivery[0].args.join(' ')).toContain(`umask 077 && mkdir -p /run/secrets && cat > ${RECONNECT_KEY_PATH} && chmod 600 ${RECONNECT_KEY_PATH}`);
    // The join reads the FILE (tailscale's file: form) and forces re-auth.
    const join = calls.find(c => c.args.some(a => a.includes('DIGBY_RECONNECT')))!;
    const script = join.args[join.args.length - 1];
    expect(script).toContain('--auth-key="file:$F"');
    expect(script).toContain('--force-reauth');
    expect(script).toContain('--reset');
    expect(script).toContain('--hostname=digby-dev');
    // The key appears nowhere but the stdin write: not in any argv, log line or the returned status.
    expect(allArgv()).not.toContain(SECRET);
    expect(loggedText()).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // Mid-run safe: never removes / recreates / restarts the container.
    expect(calls.some(c => ['rm', 'run', 'start', 'restart', 'stop'].includes(c.args[0]))).toBe(false);
  });

  it('removes the key file even when the join exec dies (the trap never ran)', async () => {
    reconnectThrows = true;
    joinedAfter = false;
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('failed');
    const cleanup = calls.filter(c => c.args[0] === 'exec' && c.args.includes('rm') && c.args.includes(RECONNECT_KEY_PATH));
    expect(cleanup).toHaveLength(1);
  });

  it('also runs the belt-and-braces rm on success', async () => {
    await reconnectDevTailnet(uid());
    expect(calls.some(c => c.args[0] === 'exec' && c.args.includes('rm') && c.args.includes(RECONNECT_KEY_PATH))).toBe(true);
  });

  it.each([
    ['invalid_key', /rejected the saved key/],
    ['tags_not_permitted', /tagOwners/],
    ['key_expired', /has expired/],
  ])('classified failure %s → that outcome + its plain note (no daemon verify needed)', async (cls, note) => {
    reconnectStdout = `DIGBY_RECONNECT rc=1 class=${cls}\n`;
    joinedAfter = false;
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe(cls);
    expect(r.status.note).toMatch(note);
    expect(JSON.stringify(r)).not.toContain('login.tailscale.com');
  });

  it('the daemon, not the CLI exit code, decides: rc=0 but never Running → timeout', async () => {
    joinedAfter = false;
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('timeout');
  });

  it('no saved key → refuses with guidance and never touches the container', async () => {
    mockGetCred.mockResolvedValue(null);
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('no_key');
    expect(r.status.note).toMatch(/Save a tagged, reusable auth key/);
    expect(calls.some(c => c.args[0] === 'exec' && (c.args[1] === '-i' || c.args.some(a => a.includes('DIGBY_RECONNECT'))))).toBe(false);
  });

  it('container not running → points at Restart, no key delivered', async () => {
    running = false;
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('not_running');
    expect(r.status.note).toMatch(/use Restart/);
    expect(calls.some(c => c.args[1] === '-i')).toBe(false);
  });

  it('feature not enabled → refuses without delivering a key or joining (status reads only)', async () => {
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: false });
    const r = await reconnectDevTailnet(uid());
    expect(r.outcome).toBe('not_enabled');
    expect(calls.some(c => c.args[1] === '-i')).toBe(false);
    expect(calls.some(c => c.args.some(a => a.includes('DIGBY_RECONNECT')))).toBe(false);
  });
});

describe('status — node identity (2026-10-13)', () => {
  it('reports online, tags and a null key expiry for a tagged node', async () => {
    const st = await getDevContainerStatus(uid());
    expect(st.tailscale).toMatchObject({ state: 'Running', online: true, tags: ['tag:digby-dev'], keyExpiry: null });
    expect(st.tailscale?.loginUrl).toBeUndefined();
  });

  it('a NeedsLogin node with a saved key → loginPending true, never the URL', async () => {
    joinedAfter = false;
    const st = await getDevContainerStatus(uid());
    expect(st.tailscale?.state).toBe('NeedsLogin');
    expect(st.tailscale?.loginPending).toBe(true);
    expect(JSON.stringify(st)).not.toContain('login.tailscale.com');
  });
});

describe('pure helpers', () => {
  it('nodeIdentityFields: Go zero time = no expiry; a real expiry passes through; AuthURL → loginPending only', () => {
    expect(nodeIdentityFields({ Self: { KeyExpiry: '0001-01-01T00:00:00Z', Tags: ['tag:a'], Online: true } }))
      .toEqual({ keyExpiry: null, tags: ['tag:a'], online: true });
    expect(nodeIdentityFields({ Self: { KeyExpiry: '2026-11-27T10:00:00Z' }, AuthURL: 'https://login.tailscale.com/a/x' }))
      .toEqual({ keyExpiry: '2026-11-27T10:00:00Z', tags: [], loginPending: true });
    expect(nodeIdentityFields({})).toEqual({ keyExpiry: null, tags: [] });
  });

  it('parseReconnectOutput: token → outcome; unknown class → failed; no token → null', () => {
    expect(parseReconnectOutput('noise\nDIGBY_RECONNECT rc=0 class=ok\n')).toBe('joined');
    expect(parseReconnectOutput('DIGBY_RECONNECT rc=99 class=no_key')).toBe('no_key');
    expect(parseReconnectOutput('DIGBY_RECONNECT rc=1 class=weird')).toBe('failed');
    expect(parseReconnectOutput('To authenticate, visit: https://login.tailscale.com/a/x')).toBeNull();
  });

  it('reconnectScript: trap removes the key + log on exit, the key is read from the file, only a token is printed', () => {
    const s = reconnectScript();
    expect(s).toContain(`F=${RECONNECT_KEY_PATH}`);
    expect(s).toContain(`trap 'rm -f "$F" "$L"' EXIT`);
    expect(s).toContain('--auth-key="file:$F"');
    expect(s).not.toMatch(/--auth-?key="\$\(/); // never cat the key into argv
    expect(s).not.toMatch(/cat "?\$L"?/);       // tailscale's output is grepped, never echoed
    const echoes = s.split('\n').filter(l => l.includes('echo'));
    for (const l of echoes) expect(l).toMatch(/DIGBY_RECONNECT rc=/);
    // tags are checked before the generic invalid-key match (their message also says "invalid")
    expect(s.indexOf('tags_not_permitted')).toBeLessThan(s.indexOf('cls=invalid_key'));
  });
});
