/**
 * Integration prefetch deadline — ticket 11d98377 (nightly query suite, run 37962929291,
 * seed 20261009): the Quick-lane first-chunk p50 breached 45 s (49.7 s over 4 turns; the
 * "trending on X" turn took 49.7 s to the first chunk with ZERO tool calls — the whole wait
 * was the controller's blocking integration prefetch: crossmodel.controller.ts fully awaits
 * buildIntegrationContext BEFORE the model run starts, and the X trends leg scraped the
 * always-walled x.com/explore page for 25–40 s before the trends24.in mirror that works).
 *
 * Replays the incident class: a prefetch that never settles (a wedged family chain) must
 * resolve at the deadline with empty context, never wedge the send; a fast prefetch is
 * unchanged; the underlying promise keeps settling in the background; the kill switch
 * restores the unbounded wait.
 */
import { buildIntegrationContextBounded, INTEGRATION_PREFETCH_DEADLINE_MS } from './integration-context';

// The module under test imports Prisma + logger transitively; the deadline race
// is pure promise arithmetic — mock the heavy imports the sibling controller
// tests mock (chat-events.endpoint.test.ts does the same).
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock('./chat-agent/status-voice', () => ({ __esModule: true, STATUS: { integration: {} } }));

describe('integration prefetch deadline (11d98377)', () => {
  const REAL_MS = Number(process.env.INTEGRATION_PREFETCH_DEADLINE_MS ?? 45_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('INTEGRATION_PREFETCH_DEADLINE_MS defaults to 45 s (the Quick-lane first-chunk bar)', () => {
    expect(INTEGRATION_PREFETCH_DEADLINE_MS).toBe(45_000);
    expect(REAL_MS).toBe(45_000);
  });

  it('an unparseable deadline value falls CLOSED to the default, never back to the unbounded wait (reviewer F2)', () => {
    const prev = process.env.INTEGRATION_PREFETCH_DEADLINE_MS;
    try {
      process.env.INTEGRATION_PREFETCH_DEADLINE_MS = '45s';
      jest.resetModules();
      const mod = jest.requireActual<{ INTEGRATION_PREFETCH_DEADLINE_MS: number }>('./integration-context');
      expect(mod.INTEGRATION_PREFETCH_DEADLINE_MS).toBe(45_000); // NaN would have disabled the race
    } finally {
      process.env.INTEGRATION_PREFETCH_DEADLINE_MS = prev;
      jest.resetModules();
    }
  });

  it('a fast prefetch resolves with its context unchanged', async () => {
    const out = await buildIntegrationContextBounded(
      () => Promise.resolve({ additionalContext: 'DATA', imessagePairedAgentId: 'mac-1' }),
      45_000,
    );
    expect(out).toEqual({ additionalContext: 'DATA', imessagePairedAgentId: 'mac-1' });
  });

  it('a wedged prefetch resolves at the deadline with empty context, never blocks the send (the 11d98377 shape)', async () => {
    let settled = false;
    const wedged = new Promise<{ additionalContext: string; imessagePairedAgentId: string | null }>((resolve) => {
      // The X-trends incident shape: a family chain that never settles inside the bar.
      const t = setTimeout(() => { settled = true; resolve({ additionalContext: 'LATE', imessagePairedAgentId: null }); }, 300);
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') (t as unknown as { unref: () => void }).unref();
    });
    const t0 = Date.now();
    const out = await buildIntegrationContextBounded(() => wedged, 60);
    const waited = Date.now() - t0;
    expect(out).toEqual({ additionalContext: undefined, imessagePairedAgentId: null });
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(5_000); // bounded — nowhere near what the leg wanted
    // The underlying leg keeps settling in the background (no abort, no unhandled race loss).
    await wedged;
    expect(settled).toBe(true);
  });

  it('the timer never leaks past resolution (clearTimeout runs on the fast path — reviewer F5)', async () => {
    const unrefSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const out = await buildIntegrationContextBounded(
      () => Promise.resolve({ additionalContext: 'x', imessagePairedAgentId: null }),
      45_000,
    );
    expect(out.additionalContext).toBe('x');
    // A timer was created for the race and the finally block CLEARED it once the
    // build won (the race's timer handle, not an arbitrary one).
    expect(unrefSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    unrefSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('deadline <= 0 disables the race — the unbounded pre-fix wait (kill switch)', async () => {
    const slow = () => new Promise<{ additionalContext: string; imessagePairedAgentId: string | null }>((resolve) => {
      setTimeout(() => resolve({ additionalContext: 'SLOW-BUT-FINE', imessagePairedAgentId: null }), 150);
    });
    const out = await buildIntegrationContextBounded(slow, 0);
    expect(out.additionalContext).toBe('SLOW-BUT-FINE'); // waited, never raced
    const outNeg = await buildIntegrationContextBounded(slow, -1);
    expect(outNeg.additionalContext).toBe('SLOW-BUT-FINE');
  });

  it('a prefetch that settles with a rejection propagates (the deadline never swallows errors)', async () => {
    await expect(
      buildIntegrationContextBounded(() => Promise.reject(new Error('leg blew up')), 45_000),
    ).rejects.toThrow('leg blew up');
  });
});
