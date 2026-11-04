/** UI Phase 6b — LocalBrowserDriver.popOutHeaded dispatch semantics.
 *
 * `browser_pop_out` ships in Mac agent v0.4.0 (the headless-by-default cutover).
 * The driver must be tolerant end to end — the pop-out is a courtesy, never a
 * failure mode:
 *   1. Version gate at the call site: a known pre-0.4.0 agent is skipped without
 *      a broker round trip (it runs headed already, and its dispatcher would
 *      answer "Unknown method: browser_pop_out").
 *   2. Unknown version → dispatch anyway; a rejected dispatch (old agent's
 *      unknown-method error, timeout, Redis down) resolves false, never throws.
 *   3. An agent that DECLINES ({ok:false} — DIGBY_BROWSER_HEADLESS=1 forced, or
 *      no live page to show) resolves false.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// agent-link's import graph reaches config/redis → config/env (process.exit(1)
// without env) — mock the broker and mirror the real agentVersionAtLeast
// (semver-ish compare, missing/unparseable → false).
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

describe('LocalBrowserDriver.popOutHeaded (UI Phase 6b)', () => {
  it('v0.4.0 agent: dispatches browser_pop_out and resolves true on ok', async () => {
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://portal.example.com/login' });
    const driver = new LocalBrowserDriver('agent-1', '0.4.0');

    await expect(driver.popOutHeaded()).resolves.toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // W1: dispatches carry the surface capability so broker claiming can gate.
    expect(mockDispatch).toHaveBeenCalledWith('agent-1', 'browser_pop_out', {}, 20000, { capability: 'browser' });
  });

  it('newer agent (v0.4.2) dispatches too', async () => {
    mockDispatch.mockResolvedValue({ ok: true });
    const driver = new LocalBrowserDriver('agent-1', '0.4.2');

    await expect(driver.popOutHeaded()).resolves.toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('known pre-0.4.0 agent (headed by default there): NO round trip, resolves false', async () => {
    const driver = new LocalBrowserDriver('agent-1', '0.3.2');

    await expect(driver.popOutHeaded()).resolves.toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('unknown version: dispatches anyway (the error path below covers a too-old agent)', async () => {
    mockDispatch.mockResolvedValue({ ok: true });
    const driver = new LocalBrowserDriver('agent-1');

    await expect(driver.popOutHeaded()).resolves.toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("an old agent's unknown-method error resolves false — never throws", async () => {
    mockDispatch.mockRejectedValue(new Error('Unknown method: browser_pop_out'));
    const driver = new LocalBrowserDriver('agent-1');

    await expect(driver.popOutHeaded()).resolves.toBe(false);
  });

  it('a dispatch timeout (agent offline) resolves false — never throws', async () => {
    mockDispatch.mockRejectedValue(new Error('iMessage agent did not respond within 20000ms'));
    const driver = new LocalBrowserDriver('agent-1', '0.4.0');

    await expect(driver.popOutHeaded()).resolves.toBe(false);
  });

  it('an agent that declines ({ok:false} — env-forced headless / no live page) resolves false', async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: 'DIGBY_BROWSER_HEADLESS=1 forces headless on this Mac — pop-out is disabled.' });
    const driver = new LocalBrowserDriver('agent-1', '0.4.0');

    await expect(driver.popOutHeaded()).resolves.toBe(false);
  });
});
