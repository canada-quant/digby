/** Driver-selection transparency (feedback 2027d98d): the router must report
 * WHICH driver it picked, WHY, and the paired-Mac local browser's availability
 * (not paired / offline / too old / connected) — a user with a paired Mac used
 * to get a bare "driver: cloud" with no way to tell why the local browser was
 * skipped or whether pairing enables it at all. */

// Decision gate (2026-09-24): stubbed OFF so this suite keeps pinning the
// pre-gate behaviour. The real module's import chain (loop-metrics.service →
// config/database → config/env) and its shadow-mode seat lookup
// (model-roles.service → middleware/error-handler → config/env) both
// process.exit(1) without env vars. Gate behaviour: *.decision-gate.test.ts.
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  listAgents: jest.fn(),
  selectAgent: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || 'Mac'),
  // Mirror the real contract: online iff seen within the last 45s.
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
}));
// The computer-use vision gate resolves the computer_vision SEAT through the
// model-roles service (dynamic import; the real module pulls config/env) —
// mocked: no override → the built-in default (deepseek-flash).
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  glmConfigured: jest.fn(),
  stripThink: (s: string) => s,
}));
// The real drivers import the Redis command broker (config/redis → config/env,
// which process.exit(1)s at import without env) — the router only constructs
// them, so mock both as inert shells.
jest.mock('./cloud-driver', () => ({
  __esModule: true,
  CloudBrowserDriver: jest.fn().mockImplementation(() => ({ kind: 'cloud' })),
}));
jest.mock('./local-driver', () => ({
  __esModule: true,
  LocalBrowserDriver: jest.fn().mockImplementation((agentId: string) => ({ kind: 'local', agentId })),
}));

import { listAgents, selectAgent } from '../imessage/imessage.service';
import { glmChat, glmConfigured } from './glm-client';
import { localBrowserStatus, localBrowserStatusMulti, selectBrowserDriver, selectLocalFallbackDriver } from './router';

const agentRow = (over: Partial<{ agentVersion: string | null; lastSeenAt: Date | null }> = {}) => ({
  id: 'agent-1',
  userId: 'u1',
  agentVersion: '0.2.1',
  lastSeenAt: new Date(), // online now
  pairedAt: new Date(),
  ...over,
});

const asMock = (fn: unknown) => fn as jest.Mock;

/** Multi-Mac (2026-09-24): the router reads selectAgent (local-browser target)
 *  and listAgents (computer-use pool). Single-agent helper keeps old semantics. */
const mockAgents = (primary: any, all: any[] = primary ? [primary] : []) => {
  asMock(selectAgent).mockResolvedValue(primary
    ? { agent: primary, note: 'the paired Mac', error: null }
    : { agent: null, note: 'no paired Mac', error: primary === null ? 'No Mac is connected. Pair your Mac first.' : 'unavailable' });
  asMock(listAgents).mockResolvedValue(all);
};


beforeEach(() => jest.clearAllMocks());

describe('localBrowserStatus (feedback 2027d98d)', () => {
  it('no paired agent → not connected, with pairing guidance', () => {
    const s = localBrowserStatus(null);
    expect(s).toContain('not connected');
    expect(s).toContain('pair the Mac app');
  });

  it('paired but offline → offline + last-seen guidance', () => {
    const s = localBrowserStatus(agentRow({ lastSeenAt: new Date(Date.now() - 12 * 60_000) }));
    expect(s).toContain('offline');
    expect(s).toContain('12 min ago');
  });

  it('never-seen agent → offline with "never seen online"', () => {
    const s = localBrowserStatus(agentRow({ lastSeenAt: null }));
    expect(s).toContain('offline');
    expect(s).toContain('never seen online');
  });

  it('online but app < v0.2.0 → too old, names both versions', () => {
    const s = localBrowserStatus(agentRow({ agentVersion: '0.1.4' }));
    expect(s).toContain('too old');
    expect(s).toContain('v0.1.4');
    expect(s).toContain('0.2.0');
  });

  it('online + capable version → connected', () => {
    const s = localBrowserStatus(agentRow());
    expect(s).toContain('connected');
    expect(s).toContain('v0.2.1');
  });
});

describe('selectBrowserDriver — availability gating + status surfacing', () => {
  it('no paired agent → cloud with a not-connected status (not a bare "driver: cloud")', async () => {
    mockAgents(null);
    const sel = await selectBrowserDriver('u1', 'check the ALL IN attendee list');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain('not connected');
    expect(sel.reason).toContain('cloud browser');
    // GLM must not be consulted when only one driver is available.
    expect(glmChat).not.toHaveBeenCalled();
  });

  it('paired but offline Mac → cloud with an offline status (the ticket\'s exact case)', async () => {
    mockAgents(agentRow({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }));
    const sel = await selectBrowserDriver('u1', 'test the browser agent on my Mac');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain('offline');
  });

  it('paired, online, but app v0.1.x → cloud with a too-old status', async () => {
    mockAgents(agentRow({ agentVersion: '0.1.9' }));
    const sel = await selectBrowserDriver('u1', 'click through my dashboard');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain('too old');
  });

  it('agent lookup failure → cloud with an unknown status (no crash)', async () => {
    asMock(selectAgent).mockRejectedValue(new Error('db down'));
    const sel = await selectBrowserDriver('u1', 'read a page');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain('unknown');
  });

  it('capable Mac + GLM unconfigured → defaults to local (honor the explicit pairing)', async () => {
    mockAgents(agentRow());
    asMock(glmConfigured).mockReturnValue(false);
    const sel = await selectBrowserDriver('u1', 'read a page');
    expect(sel.kind).toBe('local');
    expect(sel.localStatus).toContain('connected');
  });

  it('capable Mac + GLM picks cloud → cloud, GLM reason preserved, status still connected', async () => {
    mockAgents(agentRow());
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"cloud","reason":"Public site, no login needed."}' });
    const sel = await selectBrowserDriver('u1', 'scrape a public leaderboard');
    expect(sel.kind).toBe('cloud');
    expect(sel.reason).toBe('Public site, no login needed.');
    expect(sel.localStatus).toContain('connected');
  });

  it('capable Mac + GLM picks local → local with the GLM reason', async () => {
    mockAgents(agentRow());
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"local","reason":"Needs the user\'s logged-in Swapcard session."}' });
    const sel = await selectBrowserDriver('u1', 'scrape my ALL IN contacts while logged in');
    expect(sel.kind).toBe('local');
    expect(sel.reason).toContain('Swapcard');
    expect(sel.localStatus).toContain('connected');
  });
});

describe('selectLocalFallbackDriver', () => {
  it('capable Mac online → local selection carrying the connected status', async () => {
    mockAgents(agentRow());
    const sel = await selectLocalFallbackDriver('u1');
    expect(sel?.kind).toBe('local');
    expect(sel?.localStatus).toContain('connected');
  });

  it('no usable local agent → null (session carries on read-only)', async () => {
    mockAgents(agentRow({ agentVersion: '0.1.0' }));
    await expect(selectLocalFallbackDriver('u1')).resolves.toBeNull();
    mockAgents(null);
    await expect(selectLocalFallbackDriver('u1')).resolves.toBeNull();
  });
});

// ── Multi-Mac capability fallover (steer 2026-09-24) ─────────────────────────
// The mock at the top stubs selectAgent; these tests drive the REAL selection
// semantics by mocking its return to the gated contract (the service-level
// suite in imessage/multi-mac.test.ts pins the gate logic itself).
describe('selectBrowserDriver — local-browser capability fallover (multi-Mac)', () => {
  const capableMini = { id: 'agent-2', label: 'Mac mini', agentVersion: '0.4.1', lastSeenAt: new Date(), pairedAt: new Date(), isDefault: false };
  const oldDefaultBook = { id: 'agent-1', label: 'MacBook Pro', agentVersion: '0.1.9', lastSeenAt: new Date(), pairedAt: new Date(), isDefault: true };

  it('default Mac online but TOO OLD → the capable sibling drives the LOCAL browser', async () => {
    // selectAgent with the local-browser gate falls over to the mini.
    asMock(selectAgent).mockResolvedValue({ agent: capableMini, note: "device 'Mac mini' (default 'MacBook Pro' too old)", error: null });
    asMock(listAgents).mockResolvedValue([oldDefaultBook, capableMini]);
    const sel = await selectBrowserDriver('u1', 'click through my dashboard');
    expect(sel.kind).toBe('local');
    // The router must route to the SIBLING the gated selection returned.
    expect((sel.driver as any).agentId).toBe('agent-2');
    expect(sel.localStatus).toContain('Mac mini');
  });

  it('a capable sibling keeps the LOCAL option in the GLM choice set (not cloud-only)', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: capableMini, note: "device 'Mac mini' (default 'MacBook Pro' too old)", error: null });
    asMock(listAgents).mockResolvedValue([oldDefaultBook, capableMini]);
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"local","reason":"needs my logged-in bank"}' });
    const sel = await selectBrowserDriver('u1', 'check my bank balance');
    expect(sel.kind).toBe('local');
    expect((sel.driver as any).agentId).toBe('agent-2');
    // The GLM prompt must have offered the local option (not cloud-only).
    const sys = asMock(glmChat).mock.calls[0][0].messages[0].content as string;
    expect(sys).toContain('LOCAL browser');
  });

  it('single Mac online but too old → no sibling: cloud with the per-device too-old status', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: 'no capable Mac', error: "No paired Mac can serve the local browser right now ('MacBook Pro': too old (v0.1.9 < 0.2.0)). Update the Digby Mac app on a paired Mac, or pair another Mac." });
    asMock(listAgents).mockResolvedValue([oldDefaultBook]);
    const sel = await selectBrowserDriver('u1', 'click through my dashboard');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain('too old');
    expect(sel.localStatus).toContain("'MacBook Pro'");
  });

  it('targeted-but-too-old Mac → selection error naming THAT Mac (never silently re-routed)', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: "device 'MacBook Pro' cannot serve the local browser", error: "'MacBook Pro' cannot serve the local browser — too old (v0.1.9 < 0.2.0). Capable now: 'Mac mini'." });
    asMock(listAgents).mockResolvedValue([oldDefaultBook, capableMini]);
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"cloud","reason":"public page"}' });
    const sel = await selectBrowserDriver('u1', 'use my MacBook Pro');
    expect(sel.kind).toBe('cloud');
    expect(sel.localStatus).toContain("'MacBook Pro' cannot serve the local browser");
    expect(sel.localStatus).toContain("Capable now: 'Mac mini'");
  });
});

describe('selectLocalFallbackDriver — capability fallover (multi-Mac)', () => {
  const capableMini = { id: 'agent-2', label: 'Mac mini', agentVersion: '0.4.1', lastSeenAt: new Date(), pairedAt: new Date(), isDefault: false };

  it('default too old + capable sibling online → mid-loop re-route finds the SIBLING', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: capableMini, note: "device 'Mac mini' (default 'MacBook Pro' too old)", error: null });
    const sel = await selectLocalFallbackDriver('u1');
    expect(sel?.kind).toBe('local');
    expect((sel?.driver as any).agentId).toBe('agent-2');
    expect(sel?.localStatus).toContain('connected');
  });

  it('no capable Mac at all → null (read-only continuation)', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: 'no capable Mac', error: "No paired Mac can serve the local browser right now ('MacBook Pro': too old (v0.1.9 < 0.2.0))." });
    await expect(selectLocalFallbackDriver('u1')).resolves.toBeNull();
  });
});

describe('localBrowserAvailable — the ONE availability gate, reused by status surfaces (UI Phase 6a)', () => {
  const { localBrowserAvailable } = require('./router');

  it('true only for a paired agent that is ONLINE and app ≥ 0.2.0 (what the router routes on)', () => {
    expect(localBrowserAvailable(agentRow())).toBe(true);
  });

  it('false when not paired, offline, or too old — matching the localBrowserStatus taxonomy', () => {
    expect(localBrowserAvailable(null)).toBe(false);
    expect(localBrowserAvailable(agentRow({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }))).toBe(false); // offline
    expect(localBrowserAvailable(agentRow({ agentVersion: '0.1.9' }))).toBe(false); // pre-browser app
    expect(localBrowserAvailable(agentRow({ agentVersion: null }))).toBe(false);
  });
});

describe('selectBrowserDriver × computer use (three-way routing, 2026-09-09)', () => {
  // The router's computer gate = the computer agent's own gate (agent ≥ 0.3.0
  // online) AND the Computer-use vision SEAT servable on this server — its
  // built-in default is deepseek-flash, so DEEPSEEK_API_KEY gates it here
  // (2026-09-22; was the gpt-5.6-luna OPENAI_API_KEY gate).
  const withVision = (fn: () => Promise<void>) => async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
    }
  };

  it('GLM is offered the COMPUTER destination only when the Mac can run computer use AND vision is configured', withVision(async () => {
    mockAgents(agentRow({ agentVersion: '0.4.1' }));
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"cloud","reason":"Public page."}' });
    await selectBrowserDriver('u1', 'read the pricing page');
    const sys = asMock(glmChat).mock.calls[0][0].messages[0].content as string;
    expect(sys).toContain('COMPUTER (the user\'s real desktop)');
    expect(sys).toContain('"driver":"local"|"cloud"|"computer"');
  }));

  it('a too-old agent (0.2.1) never gets the COMPUTER option, even with vision configured', withVision(async () => {
    mockAgents(agentRow({ agentVersion: '0.2.1' }));
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"local","reason":"ok"}' });
    await selectBrowserDriver('u1', 'check my inbox');
    const sys = asMock(glmChat).mock.calls[0][0].messages[0].content as string;
    expect(sys).not.toContain('COMPUTER (the user');
  }));

  it('without vision configured the COMPUTER option is absent (server config, not the Mac)', async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      mockAgents(agentRow({ agentVersion: '0.4.1' }));
      asMock(glmConfigured).mockReturnValue(true);
      asMock(glmChat).mockResolvedValue({ content: '{"driver":"local","reason":"ok"}' });
      await selectBrowserDriver('u1', 'check chrome');
      const sys = asMock(glmChat).mock.calls[0][0].messages[0].content as string;
      expect(sys).not.toContain('COMPUTER (the user');
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  it("GLM picks computer → a HANDOFF selection (driver null, kind 'computer', reason + statuses)", withVision(async () => {
    mockAgents(agentRow({ agentVersion: '0.4.1' }));
    asMock(glmConfigured).mockReturnValue(true);
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"computer","reason":"Needs the user\'s real Chrome login."}' });
    const sel = await selectBrowserDriver('u1', 'see if I am logged into my Google account in Chrome');
    expect(sel.kind).toBe('computer');
    expect(sel.driver).toBeNull();
    expect(sel.reason).toBe("Needs the user's real Chrome login.");
    expect(sel.localStatus).toContain('connected');
    expect((sel as any).computerStatus).toContain('connected (Mac app v0.4.1)');
  }));

  it('GLM picks computer while it is unavailable → falls back to local (never routes to a missing destination)', async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      mockAgents(agentRow({ agentVersion: '0.4.1' }));
      asMock(glmConfigured).mockReturnValue(true);
      asMock(glmChat).mockResolvedValue({ content: '{"driver":"computer","reason":"drift"}' });
      const sel = await selectBrowserDriver('u1', 'anything');
      expect(sel.kind).toBe('local');
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  it('the paired Mac only runs computer use (no local browser? impossible today, but) — GLM unconfigured defaults to the Mac', withVision(async () => {
    mockAgents(agentRow({ agentVersion: '0.4.1' }));
    asMock(glmConfigured).mockReturnValue(false);
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('local'); // the Digby browser wins the no-reasoning default when it runs
  }));
});

describe('localBrowserStatusMulti — capability-aware per-device lines (W1)', () => {
  it('an advertising Windows agent WITH browser reads connected', () => {
    const s = localBrowserStatusMulti([
      { id: 'w1', label: 'DESKTOP-XY', agentVersion: '0.7.0', lastSeenAt: new Date(), platform: 'windows', capabilities: ['browser', 'computer'] },
      { id: 'a1', label: 'MacBook Pro', agentVersion: '0.4.1', lastSeenAt: new Date() },
    ]);
    expect(s).toContain("'DESKTOP-XY': connected (v0.7.0)");
    expect(s).toContain("'MacBook Pro': connected (v0.4.1)");
    expect(s.startsWith('connected — ')).toBe(true);
  });

  it('an advertising agent WITHOUT browser reads no browser capability', () => {
    const s = localBrowserStatusMulti([
      { id: 'w1', label: 'DESKTOP-XY', agentVersion: '0.7.0', lastSeenAt: new Date(), platform: 'windows', capabilities: ['computer'] },
      { id: 'a1', label: 'MacBook Pro', agentVersion: '0.4.1', lastSeenAt: new Date() },
    ]);
    expect(s).toContain("'DESKTOP-XY': no browser capability (capabilities: computer)");
    expect(s).toContain("'MacBook Pro': connected (v0.4.1)");
    expect(s.startsWith('connected — ')).toBe(true); // the legacy Mac keeps the surface usable
  });

  it('legacy too-old Mac keeps the historical version line', () => {
    const s = localBrowserStatusMulti([
      { id: 'a1', label: 'MacBook Pro', agentVersion: '0.1.9', lastSeenAt: new Date() },
      { id: 'a2', label: 'Mac mini', agentVersion: '0.4.1', lastSeenAt: new Date() },
    ]);
    expect(s).toContain("'MacBook Pro': too old (v0.1.9 < 0.2.0)");
  });

  it('all devices incapable → the canonical no-usable prefix holds', () => {
    const s = localBrowserStatusMulti([
      { id: 'w1', label: 'DESKTOP-XY', agentVersion: '0.7.0', lastSeenAt: new Date(), platform: 'windows', capabilities: ['computer'] },
      { id: 'a1', label: 'MacBook Pro', agentVersion: '0.1.9', lastSeenAt: new Date() },
    ]);
    expect(s.startsWith('no usable Mac browser — ')).toBe(true);
    expect(s).toContain("'DESKTOP-XY': no browser capability");
    expect(s).toContain("'MacBook Pro': too old (v0.1.9 < 0.2.0)");
  });
});
