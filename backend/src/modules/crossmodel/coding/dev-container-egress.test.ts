/**
 * Service-level pins for per-session tailnet egress scoping (ticket 4ed6eb2e):
 *  - pepper (CODING_EGRESS_SECRET) decides the container layout at CREATE:
 *    scoped = shim :1055 + tailscaled upstream :1057 (no :1056); absent = v1 verbatim.
 *  - scoped create writes the shim + socks-connect + default policy, starts the
 *    shim, and only then marks the container scoped; a dead shim degrades the
 *    helpers to DIRECT (unscoped but working) instead of breaking sessions.
 *  - per-session grants are deterministic HMAC files (session override ?? user
 *    default ?? allow-all) + a credentialed proxy URL for exec-env injection.
 *  - the quiet sweep upgrades legacy containers (recreate) but never mid-run,
 *    and is inert without the pepper.
 * The shim's wire behavior is pinned separately (egress-shim.real.test.ts).
 */
process.env.DEV_JOIN_VERIFY_TIMEOUT_MS = '150';
process.env.DEV_JOIN_VERIFY_POLL_MS = '20';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userPreferences: { findUnique: jest.fn(), upsert: jest.fn() },
  user: { findUnique: jest.fn() },
  chatCodingState: { findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn() },
  agentRun: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = { set: jest.fn(async (): Promise<string | null> => 'OK'), del: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockMkdir = jest.fn(async () => undefined);
jest.mock('fs/promises', () => ({ __esModule: true, mkdir: (...a: any[]) => (mockMkdir as any)(...a) }));

const mockIsDockerAvailable = jest.fn(async () => true);
jest.mock('./container.service', () => ({ __esModule: true, isDockerAvailable: (...a: any[]) => (mockIsDockerAvailable as any)(...a) }));
jest.mock('./workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));

const mockGetCred = jest.fn(async (): Promise<string | null> => 'tskey-auth-abc123');
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: (...a: any[]) => (mockGetCred as any)(...a) }));

// execFile: script the docker sub-invocations by args; capture stdin payloads.
const dockerCalls: string[][] = [];
const stdinWrites: { args: string[]; data: string }[] = [];
let psRunning = false;
let psExists = false;
let tailnetJoins = true;
let runError: string | null = null;
let shimUp = true;         // the /dev/tcp auth-method probe answers [5,2]?
let markerPresent = false; // the scoped marker file exists?
let labelList = '';        // stdout of `ps --filter label=...` (the sweep)
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    dockerCalls.push(args);
    const nameFilter = args.find(a => a.startsWith('name=^'));
    const wantName = nameFilter ? nameFilter.replace(/^name=\^/, '').replace(/\$$/, '') : '';
    const joined = args.join(' ');
    let stdout = '';
    let err: any = null;
    if (args[0] === 'ps' && args.includes('-a')) stdout = psExists ? wantName : '';
    else if (args[0] === 'ps' && joined.includes('label=')) stdout = labelList;
    else if (args[0] === 'ps') stdout = psRunning ? wantName : '';
    else if (args[0] === 'run' && runError) err = Object.assign(new Error('run failed'), { stderr: runError });
    else if (args[0] === 'exec' && args.includes('status')) {
      if (tailnetJoins) stdout = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.1.2.3'], HostName: 'digby-dev' } });
      else err = Object.assign(new Error('not running'), { stderr: 'no status' });
    } else if (args[0] === 'exec' && joined.includes('/dev/tcp')) {
      stdout = (markerPresent && joined.includes('echo MARKER') ? '' : '') + (markerPresent && joined.includes('echo MARKER') ? '' : '');
      stdout = (joined.includes('echo MARKER') && markerPresent ? 'MARKER\n' : '') + (shimUp ? '  5   2\n' : '');
    }
    const child: any = {
      stdin: {
        write: (d: any) => { stdinWrites.push({ args, data: String(d) }); },
        end: () => {},
      },
    };
    process.nextTick(() => cb(err, stdout, err ? String(err.stderr) : ''));
    return child;
  },
}));

import {
  devContainerName, ensureUserDevContainer, getDevContainerStatus,
  ensureSessionEgressGrant, upgradeLegacyEgressContainers,
} from './dev-container.service';
import { egressUsername, egressPassword, passwordHash } from './egress-policy';

let uidCounter = 0;
const freshUid = () => `user-${String(uidCounter++).padStart(4, '0')}-xxxx`; // distinct per test: the health memo is per-user
const PEPPER = 'test-egress-pepper';

beforeEach(() => {
  jest.clearAllMocks();
  dockerCalls.length = 0;
  stdinWrites.length = 0;
  psRunning = false; psExists = false; tailnetJoins = true; runError = null;
  shimUp = true; markerPresent = false; labelList = '';
  mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: true });
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockIsDockerAvailable.mockResolvedValue(true);
  mockGetCred.mockResolvedValue('tskey-auth-abc123');
  mockRedis.set.mockResolvedValue('OK');
  delete process.env.CODING_EGRESS_SECRET;
});
afterEach(() => { delete process.env.CODING_EGRESS_SECRET; });

const runScript = () => {
  const call = dockerCalls.find(c => c[0] === 'run');
  return call ? call.join(' ') : '';
};

describe('dev-container egress: create-time layout (pepper decides)', () => {
  it('pepper PRESENT → scoped layout: upstream 1057, no 1056, shim autostart, scoped helpers/profile', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    const u = freshUid();
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    const s = runScript();
    expect(s).toContain('--socks5-server=127.0.0.1:1057');
    expect(s).not.toContain('--outbound-http-proxy-listen'); // :1056 bypass closed
    expect(s).toContain('nohup node /usr/local/lib/digby-egress/proxy.js'); // docker-start autostart
    expect(s).toContain('/usr/local/lib/digby-egress/socks-connect.js %h %p'); // tssh via auth-capable helper
    expect(s).toContain('exec curl --proxy "$DIGBY_TAILNET_PROXY"'); // tcurl via injected per-session creds
    expect(s).toContain('intentionally NOT set container-wide'); // profile.d is comment-only (fail closed)
    expect(s).not.toContain('export DIGBY_TAILNET_PROXY=socks5://localhost:1055'); // no unguarded base export
    expect(s).toContain('chmod 700 /run/digby-egress /run/digby-egress/creds'); // root-only policy dir
  });

  it('pepper PRESENT → post-create setup writes support files, default policy, starts shim, writes marker', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    const u = freshUid();
    await ensureUserDevContainer(u);
    const j = dockerCalls.map(c => c.join(' '));
    expect(j.some(x => x.includes('cat > /usr/local/lib/digby-egress/proxy.js'))).toBe(true);
    expect(j.some(x => x.includes('cat > /usr/local/lib/digby-egress/socks-connect.js'))).toBe(true);
    expect(j.some(x => x.includes('cat > /run/digby-egress/default.json.$$.tmp'))).toBe(true);
    expect(j.some(x => x.includes('echo scoped > /run/digby-egress/scoped'))).toBe(true); // marker only after a live shim
    // The per-user default policy file is allow-all ({v:1}) when the pref is unset.
    const def = stdinWrites.find(w => w.args.join(' ').includes('default.json.$$.tmp'));
    expect(def?.data).toBe('{"v":1}');
  });

  it('pepper PRESENT but shim never answers → DIRECT posture rewrite (unscoped but working), no marker', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    shimUp = false;
    const u = freshUid();
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u)); // container still delivered
    const j = dockerCalls.map(c => c.join(' '));
    expect(j.some(x => x.includes('nc -x 127.0.0.1:1057'))).toBe(true); // direct tssh fallback
    expect(j.some(x => x.includes('DIGBY_TAILNET_PROXY=socks5h://127.0.0.1:1057'))).toBe(true); // direct profile fallback
    expect(j.some(x => x.includes('echo scoped > /run/digby-egress/scoped'))).toBe(false); // no marker on a dead shim
  }, 20000);

  it('pepper ABSENT → v1 verbatim: 1055+1056, legacy helpers/profile, ZERO egress writes', async () => {
    const u = freshUid();
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    const s = runScript();
    expect(s).toContain('--socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056');
    expect(s).toContain('nc -x localhost:1055');
    expect(s).toContain('export DIGBY_TAILNET_PROXY=socks5://localhost:1055');
    expect(s).not.toContain('digby-egress');
    expect(s).not.toContain('1057');
    expect(dockerCalls.map(c => c.join(' ')).some(x => x.includes('digby-egress'))).toBe(false);
  });
});

describe('dev-container egress: per-session grants', () => {
  const sid = 'aca5a594-cafb-40a9-9286-bdff6e0ec01a';

  it('writes the deterministic cred file (hash + session override) and returns the credentialed URL', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ tailnetEgressAllow: JSON.stringify(['box-1', '.ts.net:22']) });
    const url = await ensureSessionEgressGrant(sid, 'digby-dev-xxxxxxxxxxxx');
    const user = egressUsername(sid);
    const pass = egressPassword(sid, PEPPER);
    expect(url).toBe(`socks5h://${user}:${pass}@localhost:1055`);
    const write = stdinWrites.find(w => w.args.join(' ').includes(`/run/digby-egress/creds/${user}.json.$$.tmp`));
    expect(write).toBeTruthy();
    const body = JSON.parse(write!.data);
    expect(body.v).toBe(1);
    expect(body.pwHash).toBe(passwordHash(pass)); // never the password itself
    expect(body.allow).toEqual(['box-1', '.ts.net:22']);
    expect(JSON.stringify(body)).not.toContain(pass);
  });

  it('no session override → cred file omits allow (shim falls back to the user default)', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ tailnetEgressAllow: null });
    await ensureSessionEgressGrant(sid, 'digby-dev-xxxxxxxxxxxx');
    const write = stdinWrites.find(w => w.args.join(' ').includes('/creds/'));
    expect(JSON.parse(write!.data)).not.toHaveProperty('allow');
  });

  it('corrupt stored override degrades to INHERIT (never a silent deny-all)', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ tailnetEgressAllow: '{not json' });
    await ensureSessionEgressGrant(sid, 'digby-dev-xxxxxxxxxxxx');
    const write = stdinWrites.find(w => w.args.join(' ').includes('/creds/'));
    expect(JSON.parse(write!.data)).not.toHaveProperty('allow');
  });

  it('pepper ABSENT → null grant and zero container writes (legacy posture)', async () => {
    expect(await ensureSessionEgressGrant(sid, 'digby-dev-xxxxxxxxxxxx')).toBeNull();
    expect(stdinWrites.length).toBe(0);
  });
});

describe('dev-container egress: status posture', () => {
  it('pepper absent → legacy with the activation note; feature off → off', async () => {
    psRunning = true;
    const st = await getDevContainerStatus(freshUid());
    expect(st.egress.mode).toBe('legacy');
    expect(st.egress.note).toMatch(/CODING_EGRESS_SECRET/);
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: false });
    const off = await getDevContainerStatus(freshUid());
    expect(off.egress.mode).toBe('off');
  });

  it('pepper present: marker+shim → scoped; marker only → degraded; neither → legacy (upgrade pending)', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    psRunning = true;
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: true, devContainerEgressAllow: JSON.stringify(['box-1', '.ts.net']) });
    markerPresent = true; shimUp = true;
    const scoped = await getDevContainerStatus(freshUid());
    expect(scoped.egress.mode).toBe('scoped');
    expect(scoped.egress.shim).toBe(true);
    expect(scoped.egress.policyRules).toBe(2);
    shimUp = false;
    const degraded = await getDevContainerStatus(freshUid());
    expect(degraded.egress.mode).toBe('degraded');
    expect(degraded.egress.note).toMatch(/shim is DOWN/);
    markerPresent = false;
    const legacy = await getDevContainerStatus(freshUid());
    expect(legacy.egress.mode).toBe('legacy');
    expect(legacy.egress.note).toMatch(/quiet window|Restart/);
  });
});

describe('dev-container egress: quiet upgrade sweep', () => {
  it('recreates a legacy container when quiet (and only then), scoped when peppered', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    const uid = 'user-9999-0000-abcd';
    labelList = `${devContainerName(uid)}\t${uid}`;
    markerPresent = false; // legacy container
    await upgradeLegacyEgressContainers();
    const j = dockerCalls.map(c => c.join(' '));
    expect(j.some(x => x.startsWith('rm -f') && x.includes(devContainerName(uid)))).toBe(true);
    expect(j.some(x => x.startsWith('run '))).toBe(true); // fresh scoped create followed
  });

  it('never touches a container with an in-flight run', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    const uid = 'user-8888-0000-abcd';
    labelList = `${devContainerName(uid)}\t${uid}`;
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1' }]);
    mockPrisma.agentRun.count.mockResolvedValue(1);
    await upgradeLegacyEgressContainers();
    expect(dockerCalls.map(c => c.join(' ')).some(x => x.startsWith('rm -f'))).toBe(false);
  });

  it('is fully inert without the pepper', async () => {
    labelList = `${devContainerName('user-7777-0000-abcd')}\tuser-7777-0000-abcd`;
    await upgradeLegacyEgressContainers();
    expect(dockerCalls.length).toBe(0);
  });

  it('repairs a scoped container whose shim died (no recreate)', async () => {
    process.env.CODING_EGRESS_SECRET = PEPPER;
    const uid = 'user-6666-0000-abcd';
    labelList = `${devContainerName(uid)}\t${uid}`;
    markerPresent = true; shimUp = false;
    // First probe inside the sweep says dead; the restart's own probe then succeeds.
    await upgradeLegacyEgressContainers();
    const j = dockerCalls.map(c => c.join(' '));
    expect(j.some(x => x.startsWith('rm -f'))).toBe(false);
    expect(j.some(x => x.includes('nohup node /usr/local/lib/digby-egress/proxy.js'))).toBe(true);
  }, 20000);
});
