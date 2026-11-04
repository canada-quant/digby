/**
 * DEVICE PAYLOAD PARITY — the OWNER-facing surface (ticket c468f922).
 *
 * WHY THIS TEST EXISTS. `prelogin` and `remoteAccess` were wired into the
 * SCHEDULER-facing device list (`account-tools.ts` `pairedMac.devices[]`) but
 * NOT into `devicePayload()`, which is what `/status` and `/agents` return and
 * therefore the ONLY device shape the web UI ever sees. The owner's security
 * contract for this ticket asks for "a health line in the agent status" — and
 * the agent status the product renders is this payload. A capability that
 * reaches a lane but not the person who owns the machine is half a feature.
 *
 * THE SECOND THING PINNED HERE is the separation. `prelogin` answers "can THIS
 * run's input land at a login window" (still `unavailable` in this build — no
 * privileged helper ships). `remoteAccess` answers "does a hardened OPERATOR
 * channel exist" (`off` is healthy). A payload that lets one stand in for the
 * other re-creates the exact defect #2144 had to correct: a notice telling a
 * lane to take a path no shipped client can drive.
 *
 * Same stand-ins as imessage-permissions.2f646c10.test.ts (config/database,
 * config/redis, config/env, utils/logger, agent-link, plus the browser/computer
 * availability leaves so no Redis or vision seat is touched).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn(), get: jest.fn(), del: jest.fn() },
}));
jest.mock('./agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), waitForCommand: jest.fn(), deliverResult: jest.fn() },
}));
jest.mock('../browser-agent/router', () => ({
  __esModule: true,
  localBrowserAvailable: () => false,
  localBrowserStatus: () => 'no paired Mac',
  localBrowserStatusMulti: () => 'no paired Mac',
}));
jest.mock('../computer-agent/availability', () => ({
  __esModule: true,
  computerAgentStatus: () => 'unavailable',
  computerUseAvailable: () => false,
}));
jest.mock('../computer-agent/vision-client', () => ({
  __esModule: true,
  visionConfigured: async () => false,
}));

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import controller from './imessage.controller';

const asMock = (fn: unknown) => fn as jest.Mock;

/** In-memory iMessageAgent table (the same prisma stand-in as multi-mac.test.ts). */
function seedDb(rows: any[] = []) {
  const table = rows.map((r, i) => ({
    id: r.id || `agent-${i + 1}`,
    userId: r.userId || 'u1',
    label: r.label || 'Primary',
    deviceId: r.deviceId ?? null,
    deviceName: r.deviceName ?? null,
    agentVersion: r.agentVersion ?? null,
    isDefault: r.isDefault ?? false,
    lastSeenAt: r.lastSeenAt ?? null,
    pairedAt: r.pairedAt || new Date(Date.now() - 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    tokenHash: r.tokenHash || 'hash-' + (i + 1),
    ...r,
  }));
  (prisma as any).iMessageAgent = {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.id) return table.find((r) => r.id === where.id) ?? null;
      if (where.tokenHash) return table.find((r) => r.tokenHash === where.tokenHash) ?? null;
      return null;
    }),
    findFirst: jest.fn(async ({ where }: any) => table.find((r) => !where || Object.entries(where).every(([k, v]: any) => {
      if (v && typeof v === 'object' && v.not !== undefined) return r[k] !== v.not;
      return r[k] === v;
    })) ?? null),
    findMany: jest.fn(async ({ where, orderBy }: any) => {
      let rows = table.filter((r) => !where || Object.entries(where).every(([k, v]: any) => {
        if (v && typeof v === 'object' && v.not !== undefined) return r[k] !== v.not;
        return r[k] === v;
      }));
      if (Array.isArray(orderBy)) {
        for (const o of [...orderBy].reverse()) {
          const [k, dir] = Object.entries(o)[0];
          rows = [...rows].sort((a, b) => (dir === 'desc' ? (a[k] > b[k] ? -1 : 1) : (a[k] > b[k] ? 1 : -1)));
        }
      }
      return rows;
    }),
    count: jest.fn(async () => table.length),
    update: jest.fn(async ({ where, data }: any) => {
      const row = table.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: jest.fn(async () => ({ count: 0 })),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
  };
  (prisma as any).$transaction = jest.fn(async (ops: any[]) => Promise.all(ops));
  return table;
}

function resOf() {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}

const ONLINE = () => new Date();

beforeEach(() => {
  jest.clearAllMocks();
  asMock(redisClient.get).mockResolvedValue('u1');
});

describe('devicePayload — the owner-facing /agents + /status shape carries the c468f922 facts', () => {
  it('every device row carries prelogin, remoteAccess and unattendedReady', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.9.14' }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const agents = res.json.mock.calls[0][0].data;
    expect(agents).toHaveLength(1);
    const row = agents[0];
    expect(row.prelogin).toBeDefined();
    expect(row.remoteAccess).toBeDefined();
    expect(row.unattendedReady).toBeDefined();
  });

  it('a LOCKED device positively reports prelogin.blockedNow (the fact a dispatcher refuses on)', async () => {
    seedDb([{
      id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(),
      unattended: { enabled: true, blockers: ['locked'] },
    }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.prelogin.blockedNow).toBe(true);
    expect(row.prelogin.reason).toMatch(/lock \/ login screen right now/);
  });

  it('a legacy row is an honest unknown — prelogin NOT blocked, remoteAccess state unavailable', async () => {
    // No advert at all: silence must never be turned into a refusal, and an
    // unreported channel must never be rendered as a confirmed `off`.
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'Legacy', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.5.2' }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.prelogin.blockedNow).toBe(false);
    expect(row.remoteAccess.state).toBe('unavailable');
    expect(row.remoteAccess.ready).toBe(false);
  });

  it('a proved-off channel reports state off and is NOT framed as a failure', async () => {
    // `off` is the healthy default (opt-in, nothing listening). It must be
    // reachable and distinct from `unavailable`, or the UI cannot tell a
    // deliberately-off device from one too old to report.
    seedDb([{
      id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(),
      remoteAccess: { enabled: false, tunnelOnly: false, blockers: [], off: true },
    }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.remoteAccess.state).toBe('off');
    expect(row.remoteAccess.reason).not.toMatch(/update the agent/i);
  });

  it('an enabled + tunnel-bound + blocker-free channel is ready with state on', async () => {
    seedDb([{
      id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(),
      remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] },
    }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.remoteAccess.state).toBe('on');
    expect(row.remoteAccess.ready).toBe(true);
  });
});

describe('devicePayload — prelogin and remoteAccess stay SEPARATE facts', () => {
  it('an operator channel does NOT make computer_task input available', async () => {
    // The bug class this ticket exists to end: a hardened channel an OPERATOR
    // can drive is not "this run can type at the login window". No RFB/RDP
    // client ships, so prelogin stays unavailable even when remoteAccess is on.
    seedDb([{
      id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(),
      remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] },
    }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.remoteAccess.state).toBe('on');
    expect(row.prelogin.status).toBe('unavailable');
  });

  it('the payload carries no field a credential could ride', async () => {
    // Criterion 5 of the ticket. The advert normalization is a closed
    // vocabulary, and the shape below is the proof at the OWNER surface too.
    seedDb([{
      id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(),
      remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] },
    }]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    const row = res.json.mock.calls[0][0].data[0];
    expect(Object.keys(row.remoteAccess).sort()).toEqual(['enabled', 'ready', 'reason', 'state', 'tunnelOnly']);
    expect(Object.keys(row.prelogin).sort()).toEqual(['blockedNow', 'reason', 'status']);
  });
});