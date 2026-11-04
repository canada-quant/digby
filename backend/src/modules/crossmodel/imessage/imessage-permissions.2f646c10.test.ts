/**
 * macOS TCC permission onboarding + self-diagnostics (ticket 2f646c10, agent
 * v0.6.0, 2026-09-25).
 *
 * These suites pin the server side of the permission advertisement:
 *   • normalizeAgentPermissions — the poll query form (four flat '1'/'0'
 *     params; numbers accepted) and its absent-never-clobbers contract
 *   • permissionsFromBody — the pair body form ({ax,sr,fda,relaunch} object
 *     of REAL booleans; partial/garbage → undefined)
 *   • touchAgent advert persistence — permissions written when advertised,
 *     untouched when absent
 *   • devicePayload passthrough — permissions: null for a legacy row
 *   • the permissionAction controller route — validation (400s), user
 *     scoping (404), and the broker dispatch (method + params + relaunch
 *     timeout posture)
 *
 * Same stand-ins as multi-mac.test.ts (config/database, config/redis,
 * config/env, utils/logger) — the controller additionally needs agent-link
 * (the broker) mocked so no Redis is touched.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = { rows: [] };
  return {
    __esModule: true,
    default: store,
  };
});
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    setEx: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  },
}));
jest.mock('./agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), waitForCommand: jest.fn(), deliverResult: jest.fn() },
}));
// devicePayload (via the /status + /agents payload) resolves browser/computer
// availability — pure helpers here, but they import config/env transitively.
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

import redisClient from '../../../config/redis';
import prisma from '../../../config/database';
import { agentBroker } from './agent-link';
import controller from './imessage.controller';
import { touchAgent } from './imessage.service';
import {
  normalizeAgentPermissions,
  permissionsFromBody,
  agentPermissions,
} from './agent-capabilities';

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
      if (where.userId_deviceId) {
        return table.find((r) => r.userId === where.userId_deviceId.userId && r.deviceId === where.userId_deviceId.deviceId) ?? null;
      }
      if (where.tokenHash) return table.find((r) => r.tokenHash === where.tokenHash) ?? null;
      if (where.id) return table.find((r) => r.id === where.id) ?? null;
      return null;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      let rows = table.filter((r) => !where || Object.entries(where).every(([k, v]: any) => {
        if (v && typeof v === 'object' && v.not !== undefined) return r[k] !== v.not;
        return r[k] === v;
      }));
      if (orderBy && orderBy.pairedAt === 'desc') rows = [...rows].sort((a, b) => b.pairedAt - a.pairedAt);
      return rows[0] ?? null;
    }),
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
    count: jest.fn(async ({ where }: any) => table.filter((r) => !where || Object.entries(where).every(([k, v]: any) => r[k] === v)).length),
    create: jest.fn(async ({ data }: any) => {
      const row = { deviceId: null, id: 'agent-new-' + table.length, createdAt: new Date(), updatedAt: new Date(), pairedAt: new Date(), ...data };
      table.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = table.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let n = 0;
      for (const r of table) {
        if (Object.entries(where).every(([k, v]: any) => r[k] === v)) { Object.assign(r, data); n++; }
      }
      return { count: n };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const i = table.findIndex((r) => r.id === where.id);
      if (i === -1) throw new Error('not found');
      table.splice(i, 1);
      return {};
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      let n = 0;
      for (let i = table.length - 1; i >= 0; i--) {
        if (Object.entries(where).every(([k, v]: any) => table[i][k] === v)) { table.splice(i, 1); n++; }
      }
      return { count: n };
    }),
  };
  (prisma as any).$transaction = jest.fn(async (ops: any[]) => Promise.all(ops));
  return table;
}

/** Minimal Express-ish req/res pair (the same hand-rolled shape route tests use). */
function resOf() {
  const res: any = {
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

const ONLINE = () => new Date();
const ALL_GRANTED = { ax: true, sr: true, fda: true, relaunch: false };

beforeEach(() => {
  jest.clearAllMocks();
  asMock(redisClient.get).mockResolvedValue('u1');
});

describe('normalizeAgentPermissions — poll query form (flat params)', () => {
  it('all four valid string flags → the object', () => {
    expect(normalizeAgentPermissions({ ax: '1', sr: '0', fda: '1', relaunch: '0' }))
      .toEqual({ ax: true, sr: false, fda: true, relaunch: false });
  });

  it('numeric 1/0 accepted (pair-body callers reuse the same normalizer)', () => {
    expect(normalizeAgentPermissions({ ax: 1, sr: 0, fda: 1, relaunch: 0 }))
      .toEqual({ ax: true, sr: false, fda: true, relaunch: false });
  });

  it('absent ANY param → undefined (never a partial advertisement)', () => {
    expect(normalizeAgentPermissions({ ax: '1', sr: '1', fda: '1' })).toBeUndefined();
    expect(normalizeAgentPermissions({})).toBeUndefined();
  });

  it('garbage values → undefined', () => {
    expect(normalizeAgentPermissions({ ax: 'yes', sr: '1', fda: '1', relaunch: '1' })).toBeUndefined();
    expect(normalizeAgentPermissions({ ax: 2, sr: '1', fda: '1', relaunch: '1' })).toBeUndefined();
  });

  it('real booleans round-trip (the stored JSONB form — agentPermissions re-normalizes rows)', () => {
    expect(normalizeAgentPermissions({ ax: true, sr: false, fda: true, relaunch: false }))
      .toEqual({ ax: true, sr: false, fda: true, relaunch: false });
  });

  it('agentPermissions reads a stored row (null for legacy/malformed)', () => {
    expect(agentPermissions({ permissions: ALL_GRANTED })).toEqual(ALL_GRANTED);
    expect(agentPermissions({ permissions: null })).toBeNull();
    expect(agentPermissions({})).toBeNull();
    expect(agentPermissions({ permissions: { ax: 'x' } })).toBeNull();
  });
});

describe('permissionsFromBody — pair body form ({ax,sr,fda,relaunch} object)', () => {
  it('four booleans → the object', () => {
    expect(permissionsFromBody({ ax: false, sr: true, fda: false, relaunch: false }))
      .toEqual({ ax: false, sr: true, fda: false, relaunch: false });
  });

  it('partial object → undefined', () => {
    expect(permissionsFromBody({ ax: true, sr: true, fda: true })).toBeUndefined();
    expect(permissionsFromBody({ ax: true })).toBeUndefined();
  });

  it('non-boolean values → undefined (the body form wants real booleans)', () => {
    expect(permissionsFromBody({ ax: '1', sr: '1', fda: '1', relaunch: '1' })).toBeUndefined();
    expect(permissionsFromBody('granted')).toBeUndefined();
    expect(permissionsFromBody(null)).toBeUndefined();
    expect(permissionsFromBody(undefined)).toBeUndefined();
  });
});

describe('touchAgent — permission advert persistence', () => {
  it('advertised permissions are WRITTEN on the poll', async () => {
    const table = seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    await touchAgent('a1', '0.6.0', { permissions: { ax: false, sr: true, fda: false, relaunch: true } });
    expect(table[0].permissions).toEqual({ ax: false, sr: true, fda: false, relaunch: true });
  });

  it('absent permissions leave the stored value UNTOUCHED (a legacy poll never clobbers)', async () => {
    const table = seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), permissions: ALL_GRANTED }]);
    await touchAgent('a1', '0.6.0', { platform: 'macos' });
    expect(table[0].permissions).toEqual(ALL_GRANTED);
  });

  it('a permissions refresh overwrites a stale stored state', async () => {
    const table = seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), permissions: { ax: false, sr: false, fda: false, relaunch: false } }]);
    await touchAgent('a1', '0.6.0', { permissions: ALL_GRANTED });
    expect(table[0].permissions).toEqual(ALL_GRANTED);
  });
});

describe('devicePayload passthrough (via controller.listAgents)', () => {
  it('an advertised row carries its permissions; a legacy row carries null', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.6.0', permissions: ALL_GRANTED },
      { id: 'a2', deviceId: 'd2', label: 'Legacy', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.5.2' },
    ]);
    const res = resOf();
    await controller.listAgents({ user: { id: 'u1' } } as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledTimes(1);
    const agents = res.json.mock.calls[0][0].data;
    expect(agents).toHaveLength(2);
    expect(agents.find((a: any) => a.id === 'a1').permissions).toEqual(ALL_GRANTED);
    expect(agents.find((a: any) => a.id === 'a2').permissions).toBeNull();
    // platform still rides the payload (the card hides the section for windows).
    expect(agents.find((a: any) => a.id === 'a1').platform).toBe('macos');
  });
});

describe('permissionAction route — validation, scoping, dispatch', () => {
  const reqOf = (id: string, body: any, userId = 'u1') => ({ params: { id }, body, user: { id: userId } } as any);

  it('valid relaunch → dispatched as permission_relaunch with empty params', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    asMock(agentBroker.dispatch).mockResolvedValue({ relaunching: true });
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'relaunch' }), res, jest.fn());
    expect(agentBroker.dispatch).toHaveBeenCalledWith('a1', 'permission_relaunch', {}, 20_000);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { relaunching: true }, device: 'MacBook Pro' });
  });

  it('open-pane → dispatched with the pane param', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    asMock(agentBroker.dispatch).mockResolvedValue({ opened: 'accessibility' });
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'open-pane', pane: 'accessibility' }), res, jest.fn());
    expect(agentBroker.dispatch).toHaveBeenCalledWith('a1', 'permission_open_pane', { pane: 'accessibility' }, 20_000);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it('reveal → dispatched as permission_reveal', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    asMock(agentBroker.dispatch).mockResolvedValue({ revealed: '/path' });
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'reveal' }), res, jest.fn());
    expect(agentBroker.dispatch).toHaveBeenCalledWith('a1', 'permission_reveal', {}, 20_000);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it('invalid action → 400 (nothing dispatched)', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'delete-everything' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('open-pane with an unknown pane → 400', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'open-pane', pane: 'microphone' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('open-pane with NO pane → 400', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'open-pane' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('foreign agent id → 404, no dispatch (user-scoped row resolution)', async () => {
    seedDb([{ id: 'a1', userId: 'someone-else', deviceId: 'd1', label: 'Not Yours', isDefault: true, lastSeenAt: ONLINE() }]);
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'relaunch' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, error: 'No such paired Mac' });
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('relaunch whose dispatch times out STILL succeeds (the helper may be gone)', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    asMock(agentBroker.dispatch).mockRejectedValue(new Error('iMessage agent did not respond within 20000ms'));
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'relaunch' }), res, jest.fn());
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { relaunching: true } });
  });

  it('a NON-relaunch dispatch timeout → 504 (like the send handler)', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    asMock(agentBroker.dispatch).mockRejectedValue(new Error('iMessage agent did not respond within 20000ms'));
    const res = resOf();
    await controller.permissionAction(reqOf('a1', { action: 'open-pane', pane: 'accessibility' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false });
  });
});

describe('agentPoll / completePair — the advert reaches the row', () => {
  it('agentPoll persists the four flat query flags', async () => {
    const table = seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    // waitForCommand resolving null = "poll window elapsed, no command" — the
    // normal no-work path; the touch happens BEFORE the long-poll starts.
    asMock(agentBroker.waitForCommand).mockResolvedValue(null);
    const res: any = { writableEnded: false, json: jest.fn(), on: jest.fn() };
    const req: any = {
      agent: { id: 'a1', userId: 'u1', deviceName: 'book.local' },
      query: { ax: '1', sr: '0', fda: '1', relaunch: '0', version: '0.6.0' },
      on: jest.fn(),
    };
    await controller.agentPoll(req, res);
    expect(table[0].permissions).toEqual({ ax: true, sr: false, fda: true, relaunch: false });
    expect(res.json).toHaveBeenCalledWith({ command: null });
  });

  it('agentPoll with NO permission params leaves the stored state untouched', async () => {
    const table = seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), permissions: ALL_GRANTED }]);
    asMock(agentBroker.waitForCommand).mockResolvedValue(null);
    const res: any = { writableEnded: false, json: jest.fn(), on: jest.fn() };
    const req: any = {
      agent: { id: 'a1', userId: 'u1', deviceName: 'book.local' },
      query: { version: '0.5.2' }, // a legacy agent — no ax/sr/fda/relaunch
      on: jest.fn(),
    };
    await controller.agentPoll(req, res);
    expect(table[0].permissions).toEqual(ALL_GRANTED);
  });

  it('completePair persists the body-object form (a fresh 0.6.0 pairing)', async () => {
    const table = seedDb([]);
    const res = resOf();
    await controller.completePair(
      { body: { pairingCode: 'ABCD-EFGH', deviceName: 'book.local', agentVersion: '0.6.0', deviceId: 'device-a', permissions: { ax: false, sr: false, fda: false, relaunch: false } } } as any,
      res,
      jest.fn(),
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(table).toHaveLength(1);
    expect(table[0].permissions).toEqual({ ax: false, sr: false, fda: false, relaunch: false });
  });

  it('completePair with a GARBAGE permissions body stores nothing (legacy pairing shape)', async () => {
    const table = seedDb([]);
    const res = resOf();
    await controller.completePair(
      { body: { pairingCode: 'ABCD-EFGH', deviceName: 'book.local', agentVersion: '0.5.2', deviceId: 'device-a', permissions: { ax: true } } } as any,
      res,
      jest.fn(),
    );
    expect(table).toHaveLength(1);
    expect(table[0].permissions).toBeUndefined();
  });
});
