/** Ticket 4258335e — LocalBrowserDriver CDP-attach dispatch semantics.
 *
 * The per-task CDP-attach opt-in (browser_task attach=true → runBrowserAgentSession
 * attach → router → this driver's third ctor arg) rides every browser_* command
 * as params.attach — but ONLY when the paired Mac agent is ≥ 0.5.0 (older agents
 * don't understand the param and would silently run their Digby profile anyway).
 * The agent's observations report which mode ACTUALLY drove; the driver
 * normalizes it defensively. attachNote() names the version gap for the
 * session's localBrowserStatus so the caller can answer "why didn't my own
 * Chrome engage?" honestly.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// agent-link's import graph reaches config/redis → config/env (process.exit(1)
// without env) — mock the broker and mirror the real agentVersionAtLeast.
const mockDispatch = jest.fn();
jest.mock('../imessage/agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: (...a: any[]) => mockDispatch(...a) },
  agentVersionAtLeast: (version: string | null | undefined, min: string) => {
    if (!version) return false;
    const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  },
}));

import { LocalBrowserDriver } from './local-driver';

beforeEach(() => jest.clearAllMocks());

const NAVIGATE = { name: 'navigate' as const, url: 'https://example.com' };

describe('LocalBrowserDriver CDP-attach (4258335e)', () => {
  it('attach + agent v0.5.0 → params.attach:true rides the dispatch', async () => {
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://example.com', mode: 'attached' });
    const driver = new LocalBrowserDriver('agent-1', '0.5.0', true);

    const obs = await driver.execute(NAVIGATE);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const params = mockDispatch.mock.calls[0][2];
    expect(params.attach).toBe(true);
    expect(driver.attachAllowed()).toBe(true);
    expect(driver.attachNote()).toBeNull();
    expect(obs.mode).toBe('attached');
  });

  it('attach + agent v0.4.4 → the param is WITHHELD and attachNote names the gap', async () => {
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://example.com' });
    const driver = new LocalBrowserDriver('agent-1', '0.4.4', true);

    await driver.execute(NAVIGATE);
    const params = mockDispatch.mock.calls[0][2];
    expect(params.attach).toBeUndefined();
    expect(driver.attachAllowed()).toBe(false);
    expect(driver.attachNote()).toContain('v0.4.4');
    expect(driver.attachNote()).toContain('v0.5.0');
  });

  it('attach + unknown agent version → withheld (conservative), note says unknown', async () => {
    mockDispatch.mockResolvedValue({ ok: true });
    const driver = new LocalBrowserDriver('agent-1', null, true);

    await driver.execute(NAVIGATE);
    expect(mockDispatch.mock.calls[0][2].attach).toBeUndefined();
    expect(driver.attachNote()).toContain('unknown');
  });

  it('no attach (default) → no attach param, no note, even on a new agent', async () => {
    mockDispatch.mockResolvedValue({ ok: true });
    const driver = new LocalBrowserDriver('agent-1', '0.5.0');

    await driver.execute(NAVIGATE);
    expect(mockDispatch.mock.calls[0][2].attach).toBeUndefined();
    expect(driver.attachNote()).toBeNull();
  });

  it('mode normalization: digby-profile passes through; missing/garbage modes are dropped', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, mode: 'digby-profile' });
    const driver = new LocalBrowserDriver('agent-1', '0.5.0', true);
    expect((await driver.execute(NAVIGATE)).mode).toBe('digby-profile');

    mockDispatch.mockResolvedValueOnce({ ok: true });
    expect((await driver.execute(NAVIGATE)).mode).toBeUndefined();

    mockDispatch.mockResolvedValueOnce({ ok: true, mode: 'everyday-chrome' });
    expect((await driver.execute(NAVIGATE)).mode).toBeUndefined();
  });

  it('error observations carry no mode (dispatch failure shape unchanged)', async () => {
    mockDispatch.mockRejectedValue(new Error('broker timeout'));
    const driver = new LocalBrowserDriver('agent-1', '0.5.0', true);
    const obs = await driver.execute(NAVIGATE);
    expect(obs.ok).toBe(false);
    expect(obs.error).toContain('broker timeout');
    expect(obs.mode).toBeUndefined();
  });
});
