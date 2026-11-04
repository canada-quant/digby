/**
 * Agent platform + capability handshake (Windows client W0, 2026-09-25).
 *
 * These suites pin the core invariants:
 *   • agentPlatform / normalizePlatform: legacy rows resolve as macos; only
 *     'windows' is Windows; junk never becomes a platform
 *   • normalizeCapabilities: array or comma-list inputs; unknown values are
 *     DROPPED (an agent can never inject arbitrary tokens); empty → undefined
 *     (never clobbers a stored advertisement)
 *   • hasCapability: advertisement wins; legacy Mac row → version gates
 *     (imessage always, browser ≥ 0.2.0, computer ≥ 0.3.0); a Windows row
 *     that advertises nothing can do nothing
 *   • completePairing stores the advert (create + upsert paths); a legacy
 *     agent (no advert) never clobbers a stored one
 *   • touchAgent refreshes the advert on poll (agent self-heals after upgrade)
 *   • the gates (computerUseAvailable / localBrowserAvailable) answer from
 *     the advertisement; legacy rows keep byte-identical version-gating
 *   • computerAgentStatus / localBrowserStatus: Windows rows get Windows
 *     copy; legacy Mac rows keep the exact historical strings
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = { rows: [] };
  return { __esModule: true, default: store };
});
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

import redisClient from '../../../config/redis';
import prisma from '../../../config/database';
import {
  agentPlatform,
  advertisesCapabilities,
  hasCapability,
  resolvedCapabilities,
  normalizePlatform,
  normalizeCapabilities,
  platformNoun,
} from './agent-capabilities';
import { completePairing, touchAgent } from './imessage.service';
import { computerUseAvailable, computerAgentStatus } from '../computer-agent/availability';
import { localBrowserAvailable } from '../browser-agent/router';

const asMock = (fn: unknown) => fn as jest.Mock;

// The availability/router modules import isOnline from imessage.service which
// reads the (mocked) prisma — isOnline is pure on its arguments, so the real
// implementation runs. For the gate tests we control lastSeenAt directly.
const now = () => new Date();
const online = { lastSeenAt: now() };

function seedDb(rows: any[] = []) {
  const table = rows.map((r, i) => ({
    id: r.id || `agent-${i + 1}`,
    userId: r.userId || 'u1',
    label: r.label || 'Primary',
    deviceId: r.deviceId ?? null,
    deviceName: r.deviceName ?? null,
    agentVersion: r.agentVersion ?? null,
    platform: r.platform ?? null,
    capabilities: r.capabilities ?? [],
    isDefault: r.isDefault ?? false,
    lastSeenAt: r.lastSeenAt ?? null,
    pairedAt: new Date(),
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
      if (where.id) return table.find((r) => r.id === where.id) ?? null;
      return null;
    }),
    findFirst: jest.fn(async ({ where }: any) => table.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null),
    findMany: jest.fn(async () => table.slice()),
    count: jest.fn(async () => table.length),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: 'created-1', pairedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), isDefault: false, ...data };
      table.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const idx = table.findIndex((r) => r.id === (where.id || r.id));
      if (idx < 0) throw new Error('not found');
      table[idx] = { ...table[idx], ...data };
      return table[idx];
    }),
    updateMany: jest.fn(async () => ({ count: 0 })),
    delete: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };
  return table;
}

function mockPairCode(userId = 'u1') {
  asMock(redisClient.get).mockResolvedValue(userId);
  asMock(redisClient.del).mockResolvedValue(1);
}

describe('agentPlatform / normalizePlatform', () => {
  it('legacy rows (no platform) resolve as macos', () => {
    expect(agentPlatform({})).toBe('macos');
    expect(agentPlatform({ platform: null })).toBe('macos');
    expect(agentPlatform(null)).toBe('macos');
  });

  it('windows is windows; mac/macOS normalize to macos; junk is undefined', () => {
    expect(normalizePlatform('windows')).toBe('windows');
    expect(normalizePlatform('Windows')).toBe('windows');
    expect(normalizePlatform('macos')).toBe('macos');
    expect(normalizePlatform('Mac')).toBe('macos');
    expect(normalizePlatform('linux')).toBeUndefined();
    expect(normalizePlatform('')).toBeUndefined();
    expect(normalizePlatform(42)).toBeUndefined();
    expect(platformNoun({ platform: 'windows' })).toBe('Windows PC');
    expect(platformNoun({})).toBe('Mac');
  });
});

describe('normalizeCapabilities (W0 wire surface)', () => {
  it('accepts an array of known capabilities, deduped + ordered', () => {
    expect(normalizeCapabilities(['computer', 'browser', 'computer'])).toEqual(['imessage', 'browser', 'computer'].filter((c) => c !== 'imessage'));
  });

  it('accepts a comma-separated query string (the poll wire format)', () => {
    expect(normalizeCapabilities('browser,computer')).toEqual(['browser', 'computer']);
  });

  it('DROPS unknown values — an agent can never inject arbitrary tokens', () => {
    expect(normalizeCapabilities(['browser', 'sudo', 'admin', 'imessage'])).toEqual(['imessage', 'browser']);
    expect(normalizeCapabilities(['totally-fake'])).toBeUndefined();
  });

  it('empty / absent → undefined (never clobbers a stored advertisement)', () => {
    expect(normalizeCapabilities([])).toBeUndefined();
    expect(normalizeCapabilities('')).toBeUndefined();
    expect(normalizeCapabilities(undefined)).toBeUndefined();
  });
});

describe('hasCapability (the W0 gate semantics)', () => {
  it('advertisement wins over version — a Windows agent at any version', () => {
    const win = { platform: 'windows', capabilities: ['browser', 'computer'], agentVersion: '0.6.0', ...online };
    expect(hasCapability(win, 'browser')).toBe(true);
    expect(hasCapability(win, 'computer')).toBe(true);
    expect(hasCapability(win, 'imessage')).toBe(false);
  });

  it('legacy Mac row → the historical version gates (byte-identical semantics)', () => {
    expect(hasCapability({ agentVersion: '0.1.9', ...online }, 'imessage')).toBe(true);   // always
    expect(hasCapability({ agentVersion: '0.1.9', ...online }, 'browser')).toBe(false);  // < 0.2.0
    expect(hasCapability({ agentVersion: '0.2.0', ...online }, 'browser')).toBe(true);
    expect(hasCapability({ agentVersion: '0.2.9', ...online }, 'computer')).toBe(false); // < 0.3.0
    expect(hasCapability({ agentVersion: '0.3.0', ...online }, 'computer')).toBe(true);
    // Advertised Mac with old version: advertisement wins (a modern Mac agent
    // advertising capabilities at 0.1.9 — e.g. a downgrade — still answers
    // from the advertisement, never from the stale version axis).
    expect(hasCapability({ platform: 'macos', capabilities: ['computer'], agentVersion: '0.1.9', ...online }, 'computer')).toBe(true);
  });

  it('a Windows row that advertises nothing can do nothing', () => {
    expect(hasCapability({ platform: 'windows', agentVersion: '0.9.9', ...online }, 'browser')).toBe(false);
    expect(hasCapability({ platform: 'windows', agentVersion: '0.9.9', ...online }, 'computer')).toBe(false);
  });

  it('resolvedCapabilities renders the advertisement (or the legacy gates)', () => {
    expect(resolvedCapabilities({ platform: 'windows', capabilities: ['browser', 'computer'], ...online })).toEqual(['browser', 'computer']);
    expect(resolvedCapabilities({ agentVersion: '0.4.1', ...online })).toEqual(['imessage', 'browser', 'computer']);
    expect(resolvedCapabilities({ agentVersion: '0.1.0', ...online })).toEqual(['imessage']);
    expect(resolvedCapabilities(null)).toEqual([]);
  });

  it('empty array is NOT an advertisement (legacy detection)', () => {
    expect(advertisesCapabilities({ capabilities: [] })).toBe(false);
    expect(advertisesCapabilities({ capabilities: ['browser'] })).toBe(true);
    expect(advertisesCapabilities({})).toBe(false);
  });
});

describe('completePairing / touchAgent store the advertisement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('a Windows agent pairing (deviceId path) stores platform + capabilities', async () => {
    seedDb();
    mockPairCode();
    const res = await completePairing('ABCD-EFGH', 'OFFICE-PC', '0.6.0', 'device-win-1', {
      platform: 'windows',
      capabilities: ['browser', 'computer'],
    });
    expect(res?.agentId).toBe('created-1');
    const create = asMock((prisma as any).iMessageAgent.create).mock.calls[0][0].data;
    expect(create.platform).toBe('windows');
    expect(create.capabilities).toEqual(['browser', 'computer']);
  });

  it('re-pairing an existing device updates the advertisement (agent upgrade self-heals)', async () => {
    seedDb([
      {
        id: 'agent-1',
        deviceId: 'device-win-1',
        platform: 'windows',
        capabilities: ['browser'], // an older W0 build without computer
        agentVersion: '0.6.0',
      },
    ]);
    mockPairCode();
    await completePairing('ABCD-EFGH', 'OFFICE-PC', '0.7.0', 'device-win-1', {
      platform: 'windows',
      capabilities: ['browser', 'computer'],
    });
    const update = asMock((prisma as any).iMessageAgent.update).mock.calls[0][0].data;
    expect(update.platform).toBe('windows');
    expect(update.capabilities).toEqual(['browser', 'computer']);
  });

  it('a legacy agent (no advert) never clobbers stored platform/capabilities', async () => {
    seedDb([
      {
        id: 'agent-1',
        deviceId: 'device-win-1',
        platform: 'windows',
        capabilities: ['browser', 'computer'],
        agentVersion: '0.6.0',
      },
    ]);
    mockPairCode();
    await completePairing('ABCD-EFGH', 'OFFICE-PC', '0.6.0', 'device-win-1'); // no advert
    const update = asMock((prisma as any).iMessageAgent.update).mock.calls[0][0].data;
    expect(update.platform).toBeUndefined();
    expect(update.capabilities).toBeUndefined();
  });

  it('touchAgent refreshes the advertisement on poll', async () => {
    seedDb([{ id: 'agent-1', platform: 'windows', capabilities: ['browser'] }]);
    await touchAgent('agent-1', '0.7.0', { platform: 'windows', capabilities: ['browser', 'computer'] });
    const data = asMock((prisma as any).iMessageAgent.update).mock.calls[0][0].data;
    expect(data.agentVersion).toBe('0.7.0');
    expect(data.platform).toBe('windows');
    expect(data.capabilities).toEqual(['browser', 'computer']);
  });
});

describe('the gates answer from the advertisement (W0)', () => {
  it('computerUseAvailable: a Windows agent advertising computer is available at any version', () => {
    expect(computerUseAvailable({ platform: 'windows', capabilities: ['computer'], agentVersion: '0.6.0', ...online })).toBe(true);
  });

  it('computerUseAvailable: a Windows agent WITHOUT computer is not; offline never is', () => {
    expect(computerUseAvailable({ platform: 'windows', capabilities: ['browser'], agentVersion: '0.6.0', ...online })).toBe(false);
    expect(computerUseAvailable({ platform: 'windows', capabilities: ['computer'], agentVersion: '0.6.0', lastSeenAt: new Date(Date.now() - 120_000) })).toBe(false);
  });

  it('computerUseAvailable: legacy Mac row keeps the version gate', () => {
    expect(computerUseAvailable({ agentVersion: '0.2.9', ...online })).toBe(false);
    expect(computerUseAvailable({ agentVersion: '0.3.0', ...online })).toBe(true);
  });

  it('localBrowserAvailable: advertisement wins; legacy keeps the 0.2.0 gate', () => {
    expect(localBrowserAvailable({ platform: 'windows', capabilities: ['browser'], agentVersion: '0.6.0', ...online })).toBe(true);
    expect(localBrowserAvailable({ platform: 'windows', capabilities: ['computer'], agentVersion: '0.6.0', ...online })).toBe(false);
    expect(localBrowserAvailable({ agentVersion: '0.1.9', ...online })).toBe(false);
    expect(localBrowserAvailable({ agentVersion: '0.2.0', ...online })).toBe(true);
  });
});

describe('status lines: Windows copy + legacy Mac byte-parity', () => {
  it('computerAgentStatus keeps the exact legacy Mac strings', () => {
    expect(computerAgentStatus({ agentVersion: '0.3.0', ...online })).toBe('connected (Mac app v0.3.0)');
    expect(computerAgentStatus(null)).toContain('not connected');
    expect(computerAgentStatus({ agentVersion: '0.2.1', ...online })).toContain('too old');
  });

  it('computerAgentStatus: Windows rows get Windows copy', () => {
    expect(computerAgentStatus({ platform: 'windows', capabilities: ['computer'], agentVersion: '0.6.0', ...online })).toBe('connected (Windows agent v0.6.0)');
    expect(computerAgentStatus({ platform: 'windows', capabilities: ['computer'], agentVersion: '0.6.0', lastSeenAt: new Date(Date.now() - 120_000) })).toContain('paired Windows PC is');
    expect(computerAgentStatus({ platform: 'windows', capabilities: ['browser'], agentVersion: '0.6.0', ...online })).toContain('does not support computer use');
  });
});
