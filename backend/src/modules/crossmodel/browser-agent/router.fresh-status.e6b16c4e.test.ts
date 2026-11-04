/** Ticket e6b16c4e — result-time device-presence refresh for a LOCAL session.
 *
 *  The incident: a browser_task routed to the Windows agent read
 *  "connected (Windows agent v0.9.0)" in its result header while every op had
 *  just timed out — the device answered one poll at selection, died mid-task,
 *  and the loop returned the SELECTION-time status verbatim. The router now
 *  stamps selection.localAgentId (freshLocalBrowserStatus re-reads presence at
 *  result time). This suite pins that contract: a live agent → 'connected', a
 *  dead agent → 'offline — … (open the Digby app to reconnect)', and a lookup
 *  miss/error NEVER blanks the header (the caller's fallback line survives).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
}));
// The real drivers import the Redis command broker (config/redis → config/env,
// process.exit without env) — mock the leaves so importing the router never
// triggers env validation (same shape as router.test.ts).
jest.mock('./cloud-driver', () => ({
  __esModule: true,
  CloudBrowserDriver: jest.fn().mockImplementation(() => ({ kind: 'cloud' })),
}));
jest.mock('./local-driver', () => ({
  __esModule: true,
  LocalBrowserDriver: jest.fn().mockImplementation((agentId: string) => ({ kind: 'local', agentId })),
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  glmConfigured: jest.fn(),
  stripThink: (s: string) => s,
}));

const mockFindAgentById = jest.fn();
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  listAgents: jest.fn(),
  selectAgent: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || 'Mac'),
  // Mirror the real contract: online iff seen within the last 45s.
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
  findAgentById: (...a: any[]) => mockFindAgentById(...a),
}));

import { freshLocalBrowserStatus, localBrowserStatus } from './router';

const WIN_AGENT = {
  id: 'win-1',
  label: 'cql-stanne-msi-win',
  platform: 'windows',
  agentVersion: '0.9.0',
  capabilities: ['browser', 'computer'],
  lastSeenAt: new Date(),
};

describe('freshLocalBrowserStatus (e6b16c4e)', () => {
  it('returns the CURRENT connected line for a live agent', async () => {
    mockFindAgentById.mockResolvedValue(WIN_AGENT);
    const s = await freshLocalBrowserStatus('win-1', 'stale fallback');
    expect(s).toContain('connected (Windows agent v0.9.0)');
    expect(s).not.toContain('stale');
  });

  it("returns the offline line naming the Windows PC when the device died mid-task", async () => {
    mockFindAgentById.mockResolvedValue({ ...WIN_AGENT, lastSeenAt: new Date(Date.now() - 6 * 60_000) });
    const s = await freshLocalBrowserStatus('win-1', 'connected (Windows agent v0.9.0)');
    expect(s).toContain('offline');
    expect(s).toContain('Windows PC');
    expect(s).toContain('last seen');
    // The stale selection-time 'connected' must NOT survive into the header.
    expect(s.startsWith('offline')).toBe(true);
  });

  it('a deleted/unknown agent keeps the caller fallback (never blanks the header)', async () => {
    mockFindAgentById.mockResolvedValue(null);
    const s = await freshLocalBrowserStatus('gone', 'connected (Mac app v0.4.1)');
    expect(s).toBe('connected (Mac app v0.4.1)');
  });

  it('a lookup error keeps the caller fallback', async () => {
    mockFindAgentById.mockRejectedValue(new Error('db down'));
    const s = await freshLocalBrowserStatus('win-1', 'connected (Windows agent v0.9.0)');
    expect(s).toBe('connected (Windows agent v0.9.0)');
  });

  it('an empty id still keeps the caller fallback (the real findAgentById empty-guard path)', async () => {
    mockFindAgentById.mockClear();
    mockFindAgentById.mockResolvedValue(null); // what the real guard on '' returns
    const s = await freshLocalBrowserStatus('', 'fallback line');
    expect(s).toBe('fallback line');
  });
});

describe('localBrowserStatus offline line (e6b16c4e rendering)', () => {
  it('a Windows agent last seen minutes ago renders the offline + reconnect line', () => {
    const s = localBrowserStatus({ ...WIN_AGENT, lastSeenAt: new Date(Date.now() - 5 * 60_000) });
    expect(s).toContain('offline');
    expect(s).toContain('open the Digby app to reconnect');
  });
});
