/**
 * Account → Coding → Dev container, routed to where Docker is (2026-10-13).
 * Pins: local vs remote routing (a web box with no Docker asks the coding
 * server over the existing request/reply channel); nobody answering is an
 * honest "unreachable" status (never a fake "not running"); actions are
 * acknowledged and run in the background with a Redis progress record; one
 * action per user (a busy lock refuses, a peer responder answering the SAME
 * request stays silent); the full Restart refuses while runs are in flight;
 * Reconnect refuses without a saved key; a lost reply after a real start is
 * still reported as started; the responder half stays silent without Docker
 * and re-checks session ownership; egress pushes split DB write / live push;
 * DEV_CONTAINER_REMOTE_OPS_DISABLED=1 restores the in-process path.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// In-memory Redis slice (SET NX/EX, GET, DEL).
const kv = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, o?: { NX?: boolean; EX?: number }) => {
    if (o?.NX && kv.has(k)) return null;
    kv.set(k, v);
    return 'OK';
  }),
  get: jest.fn(async (k: string) => kv.get(k) ?? null),
  del: jest.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  codingCredential: { findFirst: jest.fn(async () => ({ id: 'cred-1' })) },
  userPreferences: { findUnique: jest.fn(async () => ({ devContainerEgressAllow: '["box-1","box-2"]' })) },
  chatCodingState: { findUnique: jest.fn(async () => ({ userId: 'u-000000000001' })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockDocker = jest.fn(async () => false);
jest.mock('./container.service', () => ({ __esModule: true, isDockerAvailable: () => mockDocker() }));

const mockRemote = jest.fn(async (_devc: any, _t?: number): Promise<unknown | null> => null);
jest.mock('./worktree-remote-read', () => ({ __esModule: true, requestRemoteDevContainer: (d: any, t: number) => mockRemote(d, t) }));

const st = (over: any = {}) => ({
  enabled: true, running: true, container: 'digby-dev-u-0000000000', image: 'img', keyConfigured: true,
  tailscale: { state: 'Running' }, egress: { mode: 'legacy', shim: null, policyRules: null }, ...over,
});
const svc = {
  getDevContainerStatus: jest.fn(async () => st()),
  restartUserDevContainer: jest.fn(async () => st()),
  restartDevTailnet: jest.fn(async () => st({ note: 'tailscaled restarted and re-joined (Running)' })),
  reconnectDevTailnet: jest.fn(async () => ({ outcome: 'joined', status: st({ note: 'Reconnected.' }) })),
  devContainerEnabledTriState: jest.fn(async () => true as boolean | null),
  inFlightRunSummary: jest.fn(async () => ({ count: 0, titles: [] as string[] }) as { count: number; titles: string[] } | null),
  saveUserEgressPolicy: jest.fn(async () => ({ allow: ['box-1'], pushed: false })),
  saveSessionEgressOverride: jest.fn(async () => ({ allow: null, refreshed: false })),
  pushUserEgressPolicyNow: jest.fn(async () => true),
  refreshSessionEgressNow: jest.fn(async () => true),
};
jest.mock('./dev-container.service', () => ({
  __esModule: true,
  ...svc,
  devContainerName: (u: string) => `digby-dev-${u.slice(0, 12)}`,
  reconnectNote: (o: string) => (o === 'no_key' ? 'No Tailscale auth key is saved. Save a tagged, reusable auth key first, then press Reconnect.' : o),
  inFlightRestartNote: (s: any) => `${s ? s.count : '?'} runs block it: ${(s?.titles ?? []).join(', ')} — use Reconnect`,
}));

import {
  routedDevContainerStatus, routedDevContainerAction, beginDevContainerAction, handleDevcRequest,
  readActionRecord, finishedRecord, routedSaveUserEgressPolicy, routedSaveSessionEgressOverride,
  UNREACHABLE_STATUS_NOTE, UNREACHABLE_ACTION_NOTE, BUSY_ACTION_NOTE, DEVC_STATUS_TIMEOUT_MS,
} from './dev-container-remote';

const U = 'u-000000000001-aaaa';
const settle = async (until: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await until()) return;
    await new Promise((r) => setImmediate(r));
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  kv.clear();
  delete process.env.DEV_CONTAINER_REMOTE_OPS_DISABLED;
  mockDocker.mockResolvedValue(false);
  mockRemote.mockResolvedValue(null);
  mockPrisma.codingCredential.findFirst.mockResolvedValue({ id: 'cred-1' });
  mockPrisma.chatCodingState.findUnique.mockResolvedValue({ userId: U });
  svc.devContainerEnabledTriState.mockResolvedValue(true);
  svc.inFlightRunSummary.mockResolvedValue({ count: 0, titles: [] });
  svc.getDevContainerStatus.mockResolvedValue(st());
  svc.restartUserDevContainer.mockResolvedValue(st());
  svc.reconnectDevTailnet.mockResolvedValue({ outcome: 'joined', status: st({ note: 'Reconnected.' }) });
});

describe('status routing', () => {
  it('a process WITH Docker reads locally (reach local) and attaches the action record', async () => {
    mockDocker.mockResolvedValue(true);
    kv.set(`coding:devaction:${U.slice(0, 12)}`, JSON.stringify({ action: 'tailnet_reconnect', state: 'done', startedAt: 't0', note: 'ok' }));
    const s = await routedDevContainerStatus(U);
    expect(s.reach).toBe('local');
    expect(s.action).toMatchObject({ action: 'tailnet_reconnect', state: 'done' });
    expect(mockRemote).not.toHaveBeenCalled();
  });

  it('a web box (no Docker) asks the coding server and reports ITS view (reach remote)', async () => {
    mockRemote.mockResolvedValue({ status: st({ egress: { mode: 'scoped', shim: true, policyRules: 2 } }) });
    const s = await routedDevContainerStatus(U);
    expect(mockRemote).toHaveBeenCalledWith({ userId: U, action: 'status' }, DEVC_STATUS_TIMEOUT_MS);
    expect(svc.getDevContainerStatus).not.toHaveBeenCalled();
    expect(s.reach).toBe('remote');
    expect(s.egress.mode).toBe('scoped');
  });

  it('nobody answers → an honest UNREACHABLE status (state unknown), never "not running" from the web box', async () => {
    const s = await routedDevContainerStatus(U);
    expect(s.reach).toBe('unreachable');
    expect(s.note).toBe(UNREACHABLE_STATUS_NOTE);
    expect(s.egress).toEqual({ mode: 'unknown', shim: null, policyRules: 2 });
    expect(s.keyConfigured).toBe(true); // presence read from the DB row, never decrypted
    expect(svc.getDevContainerStatus).not.toHaveBeenCalled();
  });

  it('kill switch keeps it in-process (pre-2026-10-13 behaviour)', async () => {
    process.env.DEV_CONTAINER_REMOTE_OPS_DISABLED = '1';
    const s = await routedDevContainerStatus(U);
    expect(svc.getDevContainerStatus).toHaveBeenCalledWith(U);
    expect(mockRemote).not.toHaveBeenCalled();
    expect(s.reach).toBeUndefined();
  });
});

describe('action routing', () => {
  it('remote start accepted → kind started with the start note', async () => {
    mockRemote.mockImplementation(async (d: any) => (d.action === 'status' ? { status: st() } : { start: { accepted: true, note: 'Reconnecting the tailnet with your saved key…' } }));
    const r = await routedDevContainerAction(U, 'tailnet_reconnect');
    expect(r.kind).toBe('started');
    expect(r.status.note).toBe('Reconnecting the tailnet with your saved key…');
    expect(mockRemote).toHaveBeenCalledWith({ userId: U, action: 'tailnet_reconnect' }, expect.any(Number));
  });

  it('remote refusal → kind refused carrying the reason', async () => {
    mockRemote.mockImplementation(async (d: any) => (d.action === 'status' ? { status: st() } : { start: { accepted: false, note: BUSY_ACTION_NOTE } }));
    const r = await routedDevContainerAction(U, 'restart');
    expect(r.kind).toBe('refused');
    expect(r.note).toBe(BUSY_ACTION_NOTE);
  });

  it('no answer and no fresh record → unreachable ("nothing was started")', async () => {
    const r = await routedDevContainerAction(U, 'restart');
    expect(r.kind).toBe('unreachable');
    expect(r.note).toBe(UNREACHABLE_ACTION_NOTE);
  });

  it('a LOST reply after the coding server really started it → still reported as started (record check)', async () => {
    kv.set(`coding:devaction:${U.slice(0, 12)}`, JSON.stringify({ action: 'restart', state: 'running', startedAt: new Date().toISOString(), note: 'Rebuilding…' }));
    const r = await routedDevContainerAction(U, 'restart');
    expect(r.kind).toBe('started');
    expect(r.note).toBe('Rebuilding…');
  });

  it('a process WITH Docker starts it locally (no channel round-trip for the start)', async () => {
    mockDocker.mockResolvedValue(true);
    const r = await routedDevContainerAction(U, 'tailnet_reconnect');
    expect(r.kind).toBe('started');
    expect(mockRemote).not.toHaveBeenCalled();
    await settle(async () => (await readActionRecord(U))?.state === 'done');
    expect(svc.reconnectDevTailnet).toHaveBeenCalledWith(U);
  });

  it('kill switch → synchronous in-process call, kind done', async () => {
    process.env.DEV_CONTAINER_REMOTE_OPS_DISABLED = '1';
    const r = await routedDevContainerAction(U, 'tailnet_restart');
    expect(r.kind).toBe('done');
    expect(svc.restartDevTailnet).toHaveBeenCalledWith(U);
    expect(mockRemote).not.toHaveBeenCalled();
  });
});

describe('beginDevContainerAction (runs on the Docker box)', () => {
  it('accepted → running record, background run, done record, lock released', async () => {
    const r = await beginDevContainerAction(U, 'tailnet_reconnect', 'req-1');
    expect(r).toEqual({ accepted: true, note: expect.stringContaining('Reconnecting') });
    await settle(async () => (await readActionRecord(U))?.state !== 'running');
    const rec = await readActionRecord(U);
    expect(rec).toMatchObject({ action: 'tailnet_reconnect', state: 'done', note: 'Reconnected.' });
    expect(rec?.finishedAt).toBeTruthy();
    expect(kv.has(`coding:devaction-lock:${U.slice(0, 12)}`)).toBe(false);
  });

  it('a second action while one runs → BUSY refusal; a peer answering the SAME request → silent (null)', async () => {
    kv.set(`coding:devaction-lock:${U.slice(0, 12)}`, 'req-A');
    expect(await beginDevContainerAction(U, 'tailnet_reconnect', 'req-B')).toEqual({ accepted: false, note: BUSY_ACTION_NOTE });
    expect(await beginDevContainerAction(U, 'tailnet_reconnect', 'req-A')).toBeNull();
    expect(svc.reconnectDevTailnet).not.toHaveBeenCalled();
  });

  it('full Restart refuses while runs are in flight, naming them and pointing at Reconnect', async () => {
    svc.inFlightRunSummary.mockResolvedValue({ count: 2, titles: ['Schooltime nightly', 'Bench'] });
    const r = await beginDevContainerAction(U, 'restart', 'req-1');
    expect(r?.accepted).toBe(false);
    expect(r?.note).toContain('Schooltime nightly, Bench');
    expect(r?.note).toContain('Reconnect');
    expect(svc.restartUserDevContainer).not.toHaveBeenCalled();
    expect(kv.size).toBe(0); // no lock, no record
  });

  it('an unreadable run list also refuses the Restart (unknown = busy)', async () => {
    svc.inFlightRunSummary.mockResolvedValue(null);
    expect((await beginDevContainerAction(U, 'restart', 'req-1'))?.accepted).toBe(false);
  });

  it('Reconnect without a saved key refuses with guidance', async () => {
    mockPrisma.codingCredential.findFirst.mockResolvedValue(null);
    const r = await beginDevContainerAction(U, 'tailnet_reconnect', 'req-1');
    expect(r).toEqual({ accepted: false, note: expect.stringContaining('Save a tagged, reusable auth key') });
  });

  it('feature off → refuses', async () => {
    svc.devContainerEnabledTriState.mockResolvedValue(false);
    expect((await beginDevContainerAction(U, 'tailnet_restart', 'req-1'))?.accepted).toBe(false);
  });

  it('a Reconnect that does not join → failed record with the classified note', async () => {
    svc.reconnectDevTailnet.mockResolvedValue({ outcome: 'invalid_key', status: st({ note: 'Tailscale rejected the saved key.' }) });
    await beginDevContainerAction(U, 'tailnet_reconnect', 'req-1');
    await settle(async () => (await readActionRecord(U))?.state !== 'running');
    expect(await readActionRecord(U)).toMatchObject({ state: 'failed', note: 'Tailscale rejected the saved key.' });
  });

  it('a runner that throws → failed record with a generic note, lock released', async () => {
    svc.restartUserDevContainer.mockRejectedValue(new Error('boom'));
    await beginDevContainerAction(U, 'restart', 'req-1');
    await settle(async () => (await readActionRecord(U))?.state !== 'running');
    expect(await readActionRecord(U)).toMatchObject({ state: 'failed' });
    expect(kv.has(`coding:devaction-lock:${U.slice(0, 12)}`)).toBe(false);
  });
});

describe('handleDevcRequest (responder half)', () => {
  it('no Docker here → null (stay silent)', async () => {
    expect(await handleDevcRequest({ userId: U, action: 'status' }, 'r1')).toBeNull();
  });

  it('status / egress push answer from the Docker box', async () => {
    mockDocker.mockResolvedValue(true);
    expect(await handleDevcRequest({ userId: U, action: 'status' }, 'r1')).toEqual({ status: st() });
    expect(await handleDevcRequest({ userId: U, action: 'egress_push' }, 'r2')).toEqual({ pushed: true });
  });

  it('session egress refresh re-checks ownership — another user\'s session is never refreshed', async () => {
    mockDocker.mockResolvedValue(true);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ userId: 'someone-else-0000' });
    expect(await handleDevcRequest({ userId: U, action: 'session_egress_refresh', args: { sessionId: 'sess-123456' } }, 'r1')).toEqual({ refreshed: false });
    expect(svc.refreshSessionEgressNow).not.toHaveBeenCalled();
  });

  it('unknown action → an explicit error answer (never silent)', async () => {
    mockDocker.mockResolvedValue(true);
    expect(await handleDevcRequest({ userId: U, action: 'format_disk' }, 'r1')).toEqual({ error: 'unknown action' });
  });
});

describe('finishedRecord', () => {
  it('restart: joined → done; not joined → failed with a plain note', () => {
    expect(finishedRecord('restart', st() as any, 't0').state).toBe('done');
    const f = finishedRecord('restart', st({ running: false, tailscale: null }) as any, 't0');
    expect(f.state).toBe('failed');
    expect(f.note).toMatch(/couldn't join your tailnet/);
  });
});

describe('egress routing', () => {
  it('web box: DB write without a local push, then the live push on the coding server', async () => {
    mockRemote.mockResolvedValue({ pushed: true });
    const r = await routedSaveUserEgressPolicy(U, ['box-1']);
    expect(svc.saveUserEgressPolicy).toHaveBeenCalledWith(U, ['box-1'], { push: false });
    expect(mockRemote).toHaveBeenCalledWith({ userId: U, action: 'egress_push' }, expect.any(Number));
    expect(r).toEqual({ allow: ['box-1'], pushed: true });
  });

  it('web box, coding server silent → saved, pushed:false (applies on the next start)', async () => {
    const r = await routedSaveUserEgressPolicy(U, ['box-1']);
    expect(r.pushed).toBe(false);
  });

  it('session override: refresh rides the channel with the session id', async () => {
    mockRemote.mockResolvedValue({ refreshed: true });
    const r = await routedSaveSessionEgressOverride(U, 'sess-123456', null);
    expect(svc.saveSessionEgressOverride).toHaveBeenCalledWith('sess-123456', null, { refresh: false });
    expect(mockRemote).toHaveBeenCalledWith({ userId: U, action: 'session_egress_refresh', args: { sessionId: 'sess-123456' } }, expect.any(Number));
    expect(r.refreshed).toBe(true);
  });

  it('Docker box: the original single call (DB write + local push)', async () => {
    mockDocker.mockResolvedValue(true);
    await routedSaveUserEgressPolicy(U, null);
    expect(svc.saveUserEgressPolicy).toHaveBeenCalledWith(U, null);
    expect(mockRemote).not.toHaveBeenCalled();
  });
});
