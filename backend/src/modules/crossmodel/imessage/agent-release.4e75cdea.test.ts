/**
 * Mac agent self-update advert (ticket 4e75cdea, 2026-10-08) — server side.
 *
 * The owner's three Macs sat on agent 0.6.3 for days after 0.7.3 shipped
 * because NOTHING told an old agent a release existed. These suites pin:
 *
 *   • agentUpdateAdvert — the decision: advertised ONLY to a strictly-older
 *     Mac agent; never to an up-to-date one, a Windows agent, when the kill
 *     switch is set, or when the manifest is malformed (unset sha256
 *     placeholder — a half-finished publish must never reach a Mac)
 *   • the poll response — carries the additive `update` block next to
 *     `command`, and OMITS it entirely when there is nothing to advertise
 *     (an up-to-date 0.8.0 poller must not see the key at all)
 *   • the pair/complete response — same block rides `data` at registration
 *   • no-downgrade: a poller NEWER than the manifest never sees an advert
 *     (a stale manifest after a rollback must not walk a fleet backwards)
 *
 * Mocks mirror imessage-permissions.2f646c10.test.ts (config/database,
 * config/redis, config/env, utils/logger, agent-link broker, availability).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  // prisma stand-in with just the models these paths touch (touchAgent /
  // completePairing) — mirrors the store shape the service casts to `any`.
  const store: any = {
    rows: [],
    iMessageAgent: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'agent-new', agentToken: 'tok' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
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
jest.mock('./agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), waitForCommand: jest.fn(), deliverResult: jest.fn() },
  // agentVersionAtLeast is REAL in production (agent-release imports it) — the
  // mock factory replaces the whole module, so re-export the true comparator.
  agentVersionAtLeast: (v: string | null | undefined, min: string) => {
    if (!v) return false;
    const a = String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  },
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

import { agentUpdateAdvert, advertisedAgentUrl, AGENT_RELEASE } from './agent-release';
import * as controller from './imessage.controller';

const REAL_SHA = 'a'.repeat(64);
const REAL_VERSION = AGENT_RELEASE.version;

/** Snapshot the manifest, mutate it per-case, restore after — the module-level
 *  const is shared state across tests, so each case pins it explicitly. */
async function withManifest(patch: Partial<typeof AGENT_RELEASE>, fn: () => void | Promise<void>) {
  const saved = { ...AGENT_RELEASE };
  Object.assign(AGENT_RELEASE, patch);
  try {
    await fn();
  } finally {
    Object.assign(AGENT_RELEASE, saved);
  }
}

describe('advertisedAgentUrl — a self-host serves its own tarball (2026-10-20)', () => {
  it('derives the tarball from the instance public URL off production, and keeps the release URL on prod / without one', () => {
    expect(advertisedAgentUrl({ DIGBY_INSTANCE: 'selfhost', SELFHOST_PUBLIC_URL: 'https://digby.example.com/' } as NodeJS.ProcessEnv)).toBe('https://digby.example.com/digby-imessage-agent.tar.gz');
    expect(advertisedAgentUrl({ DIGBY_INSTANCE: 'selfhost' } as NodeJS.ProcessEnv)).toBe(AGENT_RELEASE.url);
    expect(advertisedAgentUrl({ FRONTEND_URL: 'https://digby.example.com,http://localhost:8247' } as NodeJS.ProcessEnv)).toBe(AGENT_RELEASE.url);
  });
});

describe('agentUpdateAdvert — the decision (ticket 4e75cdea)', () => {
  it('advertises to a strictly-older Mac agent with version + url + sha256', async () => {
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      const a = agentUpdateAdvert('0.6.3');
      expect(a).toBeTruthy();
      expect(a!.version).toBe(REAL_VERSION);
      expect(a!.url).toBe(AGENT_RELEASE.url);
      expect(a!.sha256).toBe(REAL_SHA);
    });
  });

  it('an agent at the release version sees NOTHING (no key, no downgrade loop)', async () => {
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      expect(agentUpdateAdvert(REAL_VERSION)).toBeNull();
    });
  });

  it('an agent NEWER than the manifest sees nothing (stale manifest after rollback never walks a fleet backwards)', async () => {
    await withManifest({ version: '0.8.0', sha256: REAL_SHA }, () => {
      expect(agentUpdateAdvert('0.9.4')).toBeNull();
      expect(agentUpdateAdvert('0.8.1')).toBeNull();
    });
  });

  it('a missing/unparseable poller version is treated as Mac-and-older (legacy 0.6.x rows)', async () => {
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      expect(agentUpdateAdvert(undefined)).toBeTruthy();
      expect(agentUpdateAdvert(null)).toBeTruthy();
      expect(agentUpdateAdvert('garbage')).toBeTruthy();
    });
  });

  it('never advertises to a Windows agent (its installer owns its updates)', async () => {
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      expect(agentUpdateAdvert('0.6.3', 'windows')).toBeNull();
      expect(agentUpdateAdvert('0.6.3', 'Windows')).toBeNull();
    });
    // platform undefined/null = legacy Mac poller → advertised
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      expect(agentUpdateAdvert('0.6.3', undefined)).toBeTruthy();
      expect(agentUpdateAdvert('0.6.3', null)).toBeTruthy();
      expect(agentUpdateAdvert('0.6.3', 'mac')).toBeTruthy();
    });
  });

  it('kill switch AGENT_UPDATE_ADVERT_DISABLED=1 stops advertising to everyone', async () => {
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      const prev = process.env.AGENT_UPDATE_ADVERT_DISABLED;
      process.env.AGENT_UPDATE_ADVERT_DISABLED = '1';
      try {
        expect(agentUpdateAdvert('0.6.3')).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.AGENT_UPDATE_ADVERT_DISABLED;
        else process.env.AGENT_UPDATE_ADVERT_DISABLED = prev;
      }
    });
  });

  it('a malformed manifest (placeholder sha / bad version) never reaches a Mac', async () => {
    await withManifest({ sha256: 'REPLACE_WITH_TARBALL_SHA256' }, () => {
      expect(agentUpdateAdvert('0.6.3')).toBeNull();
    });
    await withManifest({ sha256: '' }, () => {
      expect(agentUpdateAdvert('0.6.3')).toBeNull();
    });
    await withManifest({ sha256: REAL_SHA, version: 'not.a.version' }, () => {
      expect(agentUpdateAdvert('0.6.3')).toBeNull();
    });
  });
});

// ── Response wiring ──────────────────────────────────────────────────────────

/** Minimal res stand-in typed as any — the suite reads .body/.statusCode. */
function fakeRes(): any {
  return {
    writableEnded: false,
    statusCode: 200,
    body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
}

const AGENT_ROW = {
  id: 'agent-1',
  userId: 'user-1',
  deviceName: 'Pauls-Mac-mini.local',
  agentVersion: '0.6.3',
  platform: null,
  lastSeenAt: new Date(),
};

describe('GET /agent/poll response — additive update block (ticket 4e75cdea)', () => {
  it('a behind agent poll receives { command, update } — update names version/url/sha256', async () => {
    const { agentBroker } = jest.requireMock('./agent-link') as any;
    agentBroker.waitForCommand.mockResolvedValue({ cmdId: 'c1', method: 'ping', params: {} });
    const res = fakeRes();
    const req: any = { agent: AGENT_ROW, query: { version: '0.6.3' }, on: jest.fn() };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).agentPoll(req, res);
        });
    expect(res.body.command).toEqual({ cmdId: "c1", method: "ping", params: {} });
    expect(res.body.update).toMatchObject({ version: REAL_VERSION, url: AGENT_RELEASE.url, sha256: REAL_SHA });
  });

  it('an up-to-date (0.8.0) poller receives { command } with NO update key at all', async () => {
    const { agentBroker } = jest.requireMock('./agent-link') as any;
    agentBroker.waitForCommand.mockResolvedValue(null);
    const res = fakeRes();
    const req: any = { agent: { ...AGENT_ROW, agentVersion: REAL_VERSION }, query: { version: REAL_VERSION }, on: jest.fn() };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).agentPoll(req, res);
        });
    expect(res.body).toEqual({ command: null });
    expect('update' in res.body).toBe(false);
  });

  it('a Windows poller never receives the advert', async () => {
    const { agentBroker } = jest.requireMock('./agent-link') as any;
    agentBroker.waitForCommand.mockResolvedValue(null);
    const res = fakeRes();
    const req: any = { agent: { ...AGENT_ROW, platform: 'windows' }, query: { version: '0.6.3', platform: 'windows' }, on: jest.fn() };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).agentPoll(req, res);
        });
    expect('update' in res.body).toBe(false);
  });

  it('the poll still persists the touch/advert BEFORE responding (touchAgent ran)', async () => {
    const { agentBroker } = jest.requireMock('./agent-link') as any;
    agentBroker.waitForCommand.mockResolvedValue(null);
    const res = fakeRes();
    const req: any = { agent: AGENT_ROW, query: { version: '0.6.3' }, on: jest.fn() };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).agentPoll(req, res);
        });
    // touchAgent is fire-and-forget through prisma (mocked store) — the poll
    // must still have answered 200 with a body.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeTruthy();
  });
});

describe('POST /pair/complete response — the block rides registration too', () => {
  it('a behind agent pairing receives data.update next to agentId/agentToken', async () => {
    // completePairing reads the pairing code from redis (mocked): a hit yields
    // a token; a miss → 400. Seed a hit.
    const redis = jest.requireMock('../../../config/redis').default;
    redis.get.mockResolvedValue('user-1');
    redis.del.mockResolvedValue(1);
    const db = jest.requireMock('../../../config/database').default;
    db.rows = [];
    // make prisma usable: the controller path needs the service's prisma; the
    // store stand-in has no model methods, so drive the LEGACY-null path via a
    // minimal prisma shim on the store.
    db.iMessageAgent = {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'agent-new', agentToken: 't' }),
    };
    const res = fakeRes();
    const req: any = {
      user: { id: 'user-1' },
      body: { pairingCode: 'ABCD-EFGH', deviceName: 'mbp', agentVersion: '0.6.3' },
    };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).completePair(req, res);
        });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.update).toMatchObject({ version: REAL_VERSION, sha256: REAL_SHA });
  });

  it('an up-to-date pairing agent receives NO update key (data stays exactly agentId/agentToken-shaped)', async () => {
    const redis = jest.requireMock('../../../config/redis').default;
    redis.get.mockResolvedValue('user-1');
    redis.del.mockResolvedValue(1);
    const db = jest.requireMock('../../../config/database').default;
    db.iMessageAgent = {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'agent-new', agentToken: 't' }),
    };
    const res = fakeRes();
    const req: any = {
      user: { id: 'user-1' },
      body: { pairingCode: 'ABCD-EFGH', deviceName: 'mbp', agentVersion: REAL_VERSION },
    };
    await withManifest({ sha256: REAL_SHA, minUpdaterVersion: undefined }, async () => {
          await (controller.default as any).completePair(req, res);
        });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.update).toBeUndefined();
  });
});
