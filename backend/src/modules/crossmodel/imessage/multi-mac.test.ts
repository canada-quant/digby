/**
 * Multi-Mac pairing (owner 2026-09-24): an account may pair SEVERAL Macs.
 *
 * These suites pin the core invariants:
 *   • completePairing upserts on (userId, deviceId) — a second Mac pairs
 *     WITHOUT evicting the first; re-pairing rotates only THAT row's token
 *   • the legacy single-Mac path (no deviceId) keeps the old contract
 *   • selectAgent routing: single device → that Mac; multi → explicit target,
 *     else default, else most-recently-online; unknown target → clean error
 *   • per-device presence (isOnline per row, never a global flag)
 *   • management: rename (de-duped), set-default (exclusive), delete (scoped
 *     to the owner, default promotion)
 *
 * The service module touches prisma + redis + logger; all mocked (repo-standard
 * stand-ins — config/database, config/redis, config/env, utils/logger).
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

import redisClient from '../../../config/redis';
import prisma from '../../../config/database';
import {
  completePairing,
  selectAgent,
  listAgents,
  renameAgent,
  setDefaultAgent,
  deleteAgent,
  agentDisplayName,
  MAX_AGENTS_PER_USER,
} from './imessage.service';

const asMock = (fn: unknown) => fn as jest.Mock;

/** In-memory iMessageAgent table emulating the prisma surface the service uses. */
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
      // Real Prisma stores NULL for an omitted nullable column — mirror that.
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

const ONLINE = () => new Date();
const OFFLINE = () => new Date(Date.now() - 10 * 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  asMock(redisClient.get).mockResolvedValue('u1');
});

describe('completePairing — multi-device upsert', () => {
  it('first device pairs → new row, becomes the default', async () => {
    const table = seedDb([]);
    const r = await completePairing('ABCD-EFGH', 'book.local', '0.5.0', 'device-a');
    expect(r?.agentId).toBe('agent-new-0');
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ deviceId: 'device-a', deviceName: 'book.local', agentVersion: '0.5.0', isDefault: true, label: 'book.local' });
  });

  it('SECOND device pairs → both rows exist; the first is untouched', async () => {
    const table = seedDb([
      { id: 'a1', deviceId: 'device-a', deviceName: 'book.local', label: 'book.local', isDefault: true, tokenHash: 'hash-a', lastSeenAt: ONLINE() },
    ]);
    const r = await completePairing('ABCD-EFGH', 'mini.local', '0.5.0', 'device-b');
    expect(table).toHaveLength(2);
    expect(table.find((x) => x.deviceId === 'device-b')).toMatchObject({ label: 'mini.local', isDefault: false });
    // The FIRST Mac's row is untouched — same token hash, still the default.
    expect(table.find((x) => x.deviceId === 'device-a')).toMatchObject({ tokenHash: 'hash-a', isDefault: true });
    expect(r?.agentToken).toEqual(expect.any(String));
  });

  it('re-pairing the SAME device rotates only its token (other rows untouched)', async () => {
    const table = seedDb([
      { id: 'a1', deviceId: 'device-a', deviceName: 'book.local', label: 'book.local', isDefault: true, tokenHash: 'hash-a' },
      { id: 'a2', deviceId: 'device-b', deviceName: 'mini.local', label: 'mini.local', isDefault: false, tokenHash: 'hash-b' },
    ]);
    await completePairing('ABCD-EFGH', 'book.local', '0.5.1', 'device-a');
    expect(table).toHaveLength(2);
    const a = table.find((x) => x.deviceId === 'device-a')!;
    const b = table.find((x) => x.deviceId === 'device-b')!;
    expect(a.tokenHash).not.toBe('hash-a'); // rotated
    expect(a.agentVersion).toBe('0.5.1');
    expect(b.tokenHash).toBe('hash-b');    // untouched
    expect(a.isDefault).toBe(true);        // still default
  });

  it('duplicate hostnames get de-duped labels ("Mac mini", "Mac mini 2")', async () => {
    const table = seedDb([
      { id: 'a1', deviceId: 'device-a', deviceName: 'Mac mini', label: 'Mac mini', isDefault: true },
    ]);
    await completePairing('ABCD-EFGH', 'Mac mini', '0.5.0', 'device-b');
    expect(table.find((x) => x.deviceId === 'device-b')?.label).toBe('Mac mini 2');
  });

  it('enforces MAX_AGENTS_PER_USER with a clean error', async () => {
    seedDb(
      Array.from({ length: MAX_AGENTS_PER_USER }, (_, i) => ({
        id: `a${i}`, deviceId: `device-${i}`, label: `Mac ${i}`, isDefault: i === 0,
      })),
    );
    await expect(completePairing('ABCD-EFGH', 'overflow.local', '0.5.0', 'device-overflow'))
      .rejects.toThrow(/Too many paired Macs/);
  });

  it('LEGACY client (no deviceId) re-pairs the legacy row — pre-multi-Mac contract', async () => {
    const table = seedDb([
      { id: 'a1', deviceId: null, deviceName: 'old.local', label: 'Primary', isDefault: true, tokenHash: 'hash-old' },
    ]);
    await completePairing('ABCD-EFGH', 'old.local', '0.4.9', undefined);
    expect(table).toHaveLength(1); // same row, NOT a second one
    expect(table[0].tokenHash).not.toBe('hash-old');
    expect(table[0].deviceId).toBeNull();
  });

  it('invalid/expired pairing code → null (no rows written)', async () => {
    const table = seedDb([]);
    asMock(redisClient.get).mockResolvedValue(null);
    await expect(completePairing('XXXX-YYYY', 'x.local', '0.5.0', 'device-x')).resolves.toBeNull();
    expect(table).toHaveLength(0);
  });

  it('a malformed deviceId is treated as legacy (no row collision)', async () => {
    const table = seedDb([]);
    await completePairing('ABCD-EFGH', 'x.local', '0.5.0', 'bad id!');
    expect(table).toHaveLength(1);
    expect(table[0].deviceId).toBeNull();
  });
});

describe('selectAgent — device-aware routing', () => {
  it('exactly ONE paired Mac (any state) → that Mac, no target needed', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() }]);
    const sel = await selectAgent('u1');
    expect(sel.agent?.id).toBe('a1');
    expect(sel.error).toBeNull();
    expect(sel.note).toBe('the paired Mac');
  });

  it('multiple Macs, no target → the DEFAULT Mac when online', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE() },
    ]);
    const sel = await selectAgent('u1');
    expect(sel.agent?.id).toBe('a1');
    expect(sel.note).toContain("device 'MacBook Pro' (default)");
  });

  it('default Mac OFFLINE → falls over to the most recently online Mac', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: OFFLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE() },
    ]);
    const sel = await selectAgent('u1');
    expect(sel.agent?.id).toBe('a2');
    expect(sel.note).toContain("default 'MacBook Pro' offline");
  });

  it('explicit target by label → that Mac', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE() },
    ]);
    const sel = await selectAgent('u1', 'Mac mini');
    expect(sel.agent?.id).toBe('a2');
    expect(sel.note).toContain("device 'Mac mini' (targeted)");
  });

  it('explicit target by deviceName (label empty) → that Mac', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'Primary', deviceName: 'book.local', isDefault: true, lastSeenAt: ONLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Primary 2', deviceName: 'mini.local', isDefault: false, lastSeenAt: ONLINE() },
    ]);
    const sel = await selectAgent('u1', 'mini.local');
    expect(sel.agent?.id).toBe('a2');
  });

  it('unknown target → clean error naming the available Macs (no dispatch)', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: OFFLINE() },
    ]);
    const sel = await selectAgent('u1', 'iMac');
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("No paired Mac matches 'iMac'");
    expect(sel.error).toContain("'MacBook Pro'");
    expect(sel.error).toContain("'Mac mini'");
    expect(sel.error).toContain('(offline)');
  });

  it('targeted Mac offline → error names it AND the online alternative', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: OFFLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE() },
    ]);
    const sel = await selectAgent('u1', 'MacBook Pro');
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("'MacBook Pro' is offline");
    expect(sel.error).toContain("Online now: 'Mac mini'");
  });

  it('no paired Mac at all → the pairing guidance error', async () => {
    seedDb([]);
    const sel = await selectAgent('u1');
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain('No Mac is connected');
  });

  it('all Macs offline → error lists every device', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: OFFLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: OFFLINE() },
    ]);
    const sel = await selectAgent('u1');
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("'MacBook Pro'");
    expect(sel.error).toContain("'Mac mini'");
  });
});

describe('selectAgent — capability gate (surface-aware fallover, steer 2026-09-24)', () => {
  /** Local-browser-shaped gate: online + agentVersion ≥ 0.2.0. */
  const localBrowserGate = {
    capable: (a: any) => !!a.agentVersion && String(a.agentVersion).split('.').map(Number)[0] >= 0 && Number(String(a.agentVersion).split('.')[1] || 0) >= 2,
    reason: (a: any) => `too old (v${a.agentVersion || 'unknown'} < 0.2.0)`,
    surface: 'the local browser',
  };

  it('default Mac online but TOO OLD → a capable sibling serves (fallover, not failure)', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.1.9' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', null, localBrowserGate);
    expect(sel.agent?.id).toBe('a2');
    expect(sel.error).toBeNull();
    expect(sel.note).toContain("'Mac mini'");
    expect(sel.note).toContain("default 'MacBook Pro' too old");
  });

  it('single Mac online but too old → no fallback (nothing to fall over to), reason names it', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.1.9' }]);
    const sel = await selectAgent('u1', null, localBrowserGate);
    expect(sel.agent).toBeNull();
    expect(sel.note).toBe('no capable Mac');
    expect(sel.error).toContain("'MacBook Pro': too old (v0.1.9 < 0.2.0)");
    expect(sel.error).toContain('No paired Mac can serve the local browser');
  });

  it('EXPLICIT target that is too old → error names THAT Mac + capable siblings — never silently re-routed', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.1.9' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', 'MacBook Pro', localBrowserGate);
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("'MacBook Pro' cannot serve the local browser");
    expect(sel.error).toContain('too old (v0.1.9 < 0.2.0)');
    expect(sel.error).toContain("Capable now: 'Mac mini'");
  });

  it('explicit target capable → served, note says targeted', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', 'Mac mini', localBrowserGate);
    expect(sel.agent?.id).toBe('a2');
    expect(sel.note).toContain("device 'Mac mini' (targeted)");
  });

  it('capable default → default serves, unchanged selection semantics', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', null, localBrowserGate);
    expect(sel.agent?.id).toBe('a1');
    expect(sel.note).toContain("device 'MacBook Pro' (default)");
  });

  it('default OFFLINE, sibling online+capable → sibling serves (unchanged fallover semantics under a gate)', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: OFFLINE(), agentVersion: '0.4.1' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', null, localBrowserGate);
    expect(sel.agent?.id).toBe('a2');
    expect(sel.note).toContain("default 'MacBook Pro' offline");
  });

  it('all Macs offline under a gate → the SAME canonical offline error as without one', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: OFFLINE(), agentVersion: '0.4.1' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: OFFLINE(), agentVersion: '0.4.1' },
    ]);
    const gated = await selectAgent('u1', null, localBrowserGate);
    const ungated = await selectAgent('u1');
    expect(gated.agent).toBeNull();
    expect(gated.note).toBe('all paired Macs offline');
    expect(gated.error).toBe(ungated.error);
  });

  it('no gate => an online Mac is served regardless of version (pre-gate behavior preserved)', async () => {
    seedDb([{ id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.1.9' }]);
    const sel = await selectAgent('u1');
    expect(sel.agent?.id).toBe('a1');
    expect(sel.error).toBeNull();
  });

  it('mixed: one too old, one offline → per-device reasons in the error', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE(), agentVersion: '0.1.9' },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: OFFLINE(), agentVersion: '0.4.1' },
    ]);
    const sel = await selectAgent('u1', null, localBrowserGate);
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("'MacBook Pro': too old (v0.1.9 < 0.2.0)");
    expect(sel.error).toContain("'Mac mini': offline");
  });
});

describe('per-device presence', () => {
  it('isOnline is evaluated per row — one online, one offline, both reported', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, lastSeenAt: ONLINE() },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, lastSeenAt: OFFLINE() },
    ]);
    const rows = await listAgents('u1');
    expect(rows).toHaveLength(2);
    // ONLINE window is 45s — a fresh timestamp is online, a 10-min-old one is not.
    const { isOnline } = await import('./imessage.service');
    expect(isOnline(rows[0].lastSeenAt)).toBe(true);
    expect(isOnline(rows[1].lastSeenAt)).toBe(false);
  });
});

describe('management: rename / set-default / delete', () => {
  it('rename changes the label; a duplicate label gets de-duped', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false },
    ]);
    const row = await renameAgent('u1', 'a2', 'Studio');
    expect(row?.label).toBe('Studio');
    const dup = await renameAgent('u1', 'a2', 'MacBook Pro');
    expect(dup?.label).toBe('MacBook Pro 2');
  });

  it('rename is user-scoped — another user\'s agent id → null, no write', async () => {
    seedDb([{ id: 'a1', userId: 'someone-else', deviceId: 'd1', label: 'X', isDefault: true }]);
    await expect(renameAgent('u1', 'a1', 'Y')).resolves.toBeNull();
  });

  it('set-default flips exclusively (one default per user)', async () => {
    seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false },
    ]);
    const row = await setDefaultAgent('u1', 'a2');
    expect(row?.isDefault).toBe(true);
    const rows = await listAgents('u1');
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows.find((r) => r.id === 'a1')?.isDefault).toBe(false);
  });

  it('delete removes ONE row (never the sibling) and promotes a new default', async () => {
    const table = seedDb([
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: true, pairedAt: new Date(Date.now() - 2000) },
      { id: 'a2', deviceId: 'd2', label: 'Mac mini', isDefault: false, pairedAt: new Date(Date.now() - 1000) },
    ]);
    const ok = await deleteAgent('u1', 'a1');
    expect(ok).toBe(true);
    expect(table).toHaveLength(1);
    expect(table[0].id).toBe('a2');
    expect(table[0].isDefault).toBe(true); // promoted
  });

  it('delete is user-scoped — another user\'s id → false, no write', async () => {
    const table = seedDb([{ id: 'a1', userId: 'someone-else', deviceId: 'd1', isDefault: true }]);
    await expect(deleteAgent('u1', 'a1')).resolves.toBe(false);
    expect(table).toHaveLength(1);
  });
});

describe('agentDisplayName', () => {
  it('label first, then deviceName, then "Mac"', () => {
    expect(agentDisplayName({ label: 'MacBook Pro', deviceName: 'x.local' })).toBe('MacBook Pro');
    expect(agentDisplayName({ label: '', deviceName: 'mini.local' })).toBe('mini.local');
    expect(agentDisplayName({ label: '', deviceName: null })).toBe('Mac');
    expect(agentDisplayName(null)).toBe('Mac');
  });
});

describe('selectAgent — iMessage gate (W1: a Windows agent never serves iMessage)', () => {
  /** The controller's iMessage gate: capability-first (Windows agents advertise no imessage). */
  const imessageGate = {
    capable: (a: any) => !(a?.platform === 'windows'),
    reason: (a: any) => (a?.platform === 'windows' ? 'a Windows PC (no iMessage)' : 'iMessage not supported'),
    surface: 'iMessage',
  };

  it('Windows-only fleet → error names iMessage-not-supported, NOT the Mac pairing guidance', async () => {
    seedDb([
      { id: 'w1', deviceId: 'dw1', label: 'DESKTOP-XY', isDefault: true, lastSeenAt: ONLINE(), platform: 'windows', capabilities: ['browser', 'computer'], agentVersion: '0.7.0' },
    ]);
    const sel = await selectAgent('u1', null, imessageGate);
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain('iMessage');
    expect(sel.error).not.toContain('No Mac is connected');
  });

  it('mixed fleet (Windows PC + legacy Mac) → the Mac serves iMessage', async () => {
    seedDb([
      { id: 'w1', deviceId: 'dw1', label: 'DESKTOP-XY', isDefault: true, lastSeenAt: ONLINE(), platform: 'windows', capabilities: ['browser', 'computer'], agentVersion: '0.7.0' },
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.5.0' },
    ]);
    const sel = await selectAgent('u1', null, imessageGate);
    expect(sel.agent?.id).toBe('a1');
    expect(sel.error).toBeNull();
  });

  it('explicitly targeted Windows device → error names THAT device (never silently re-routed)', async () => {
    seedDb([
      { id: 'w1', deviceId: 'dw1', label: 'DESKTOP-XY', isDefault: true, lastSeenAt: ONLINE(), platform: 'windows', capabilities: ['browser', 'computer'], agentVersion: '0.7.0' },
      { id: 'a1', deviceId: 'd1', label: 'MacBook Pro', isDefault: false, lastSeenAt: ONLINE(), agentVersion: '0.5.0' },
    ]);
    const sel = await selectAgent('u1', 'DESKTOP-XY', imessageGate);
    expect(sel.agent).toBeNull();
    expect(sel.error).toContain("'DESKTOP-XY'");
    expect(sel.error).toContain('a Windows PC (no iMessage)');
  });
});
