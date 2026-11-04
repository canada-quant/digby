/**
 * selectBrowserDriver × decision gate (2026-09-24, purpose 'browser_driver').
 *
 * The gate sits AFTER the availability gates and the GLM-unconfigured
 * fallback, BEFORE the 30 s GLM reasoning call:
 *  - off    → GLM path exactly as before; the gate is never consulted.
 *  - shadow → gate consulted; GLM chooses as before; GLM's pick is recorded
 *             next to the gate's (acted:false) — also on the GLM-failure default.
 *  - act    → a confident pick (confidence ≥ threshold, default 0.7) of an
 *             AVAILABLE destination routes there without GLM (acted:true);
 *             an unavailable pick or a low confidence falls through to GLM.
 *  - only-cloud availability never reaches the gate (nothing to decide).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  selectAgent: jest.fn(),
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || 'Mac'),
  // Mirror the real contract: online iff seen within the last 45s.
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
}));
// The computer-use vision gate resolves its seat through model-roles (dynamic
// import; the real module pulls config/env) — no override → built-in default.
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
jest.mock('./cloud-driver', () => ({
  __esModule: true,
  CloudBrowserDriver: jest.fn().mockImplementation(() => ({ kind: 'cloud' })),
}));
jest.mock('./local-driver', () => ({
  __esModule: true,
  LocalBrowserDriver: jest.fn().mockImplementation((agentId: string) => ({ kind: 'local', agentId })),
}));

const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn();
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import { selectAgent, listAgents } from '../imessage/imessage.service';
import { glmChat, glmConfigured } from './glm-client';
import { selectBrowserDriver } from './router';

const asMock = (fn: unknown) => fn as jest.Mock;
const agentRow = (over: Partial<{ agentVersion: string | null; lastSeenAt: Date | null }> = {}) => ({
  id: 'agent-1', userId: 'u1', label: 'MacBook Pro', deviceId: 'device-1', isDefault: true,
  agentVersion: '0.2.1', lastSeenAt: new Date(), pairedAt: new Date(), ...over,
});
/** Multi-Mac (2026-09-24): the router reads selectAgent (local target) + listAgents (computer pool). */
const mockAgents = (primary: any, all: any[] = primary ? [primary] : []) => {
  asMock(selectAgent).mockResolvedValue(primary
    ? { agent: primary, note: 'the paired Mac', error: null }
    : { agent: null, note: 'no paired Mac', error: 'No Mac is connected. Pair your Mac first.' });
  asMock(listAgents).mockResolvedValue(all);
};
const choice = (pick: string, confidence: number, mode: 'shadow' | 'act' = 'act') => ({
  id: 'dec1', backend: 'test', ms: 9, mode,
  answers: { driver: { type: 'choice', choice: pick, confidence, probabilities: { [pick]: confidence } } },
});

/** Computer use needs agent ≥ 0.3.0 AND the vision seat servable (built-in deepseek-flash → DEEPSEEK_API_KEY). */
const withVision = (fn: () => Promise<void>) => async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEEPSEEK_API_KEY;
  mockAgents(agentRow());
  asMock(glmConfigured).mockReturnValue(true);
  asMock(glmChat).mockResolvedValue({ content: '{"driver":"cloud","reason":"Public page, no login."}' });
});

describe('selectBrowserDriver × decision gate', () => {
  it("act + confident 'local' → kind local without calling GLM; outcome acted:true", async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('local', 0.91));
    const sel = await selectBrowserDriver('u1', 'log into my Swapcard account and export contacts');
    expect(sel.kind).toBe('local');
    expect(sel.reason).toContain('decision gate');
    expect(sel.localStatus).toContain('connected');
    expect(glmChat).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toBe('browser_driver');
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'driver', actual: null, acted: true });
  });

  it("act + confident 'cloud' → cloud selection without GLM", async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('cloud', 0.8));
    const sel = await selectBrowserDriver('u1', 'read the public pricing page');
    expect(sel.kind).toBe('cloud');
    expect(sel.reason).toContain('decision gate');
    expect(glmChat).not.toHaveBeenCalled();
  });

  it('act + a pick for an UNAVAILABLE destination (computer, no vision) → falls through to GLM; GLM pick recorded', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('computer', 0.95));
    asMock(glmChat).mockResolvedValue({ content: '{"driver":"local","reason":"Needs the connected session."}' });
    const sel = await selectBrowserDriver('u1', 'open my mail');
    expect(sel.kind).toBe('local');
    expect(sel.reason).toBe('Needs the connected session.');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'driver', actual: 'local', acted: false });
  });

  it('act + low confidence → GLM path', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('local', 0.55));
    const sel = await selectBrowserDriver('u1', 'look something up');
    expect(sel.kind).toBe('cloud');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'driver', actual: 'cloud', acted: false });
  });

  it("act + confident 'computer' while computer use IS available → the handoff selection, no GLM", withVision(async () => {
    mockAgents(agentRow({ agentVersion: '0.4.1' }));
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('computer', 0.88));
    const sel = await selectBrowserDriver('u1', "what's on my screen right now?");
    expect(sel.kind).toBe('computer');
    expect(sel.driver).toBeNull();
    expect((sel as any).computerStatus).toContain('connected');
    expect(glmChat).not.toHaveBeenCalled();
    // The gate was offered exactly the available destinations.
    const criteria = mockDecide.mock.calls[0][1].driver.criteria;
    expect(Object.keys(criteria).sort()).toEqual(['cloud', 'computer', 'local']);
    expect(mockDecide.mock.calls[0][0]).toEqual({ task: "what's on my screen right now?", mac_browser_available: true, computer_use_available: true });
  }));

  it('shadow → GLM runs and its pick is recorded acted:false; the gate never changes the route', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('local', 0.99, 'shadow'));
    const sel = await selectBrowserDriver('u1', 'scrape a public leaderboard');
    expect(sel.kind).toBe('cloud'); // GLM's pick, not the gate's
    expect(sel.reason).toBe('Public page, no login.');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].id).toBe('dec1');
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'driver', actual: 'cloud', acted: false });
    // State + question shape: small, code-selected, only the available options.
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(state).toEqual({ task: 'scrape a public leaderboard', mac_browser_available: true, computer_use_available: false });
    expect(questions.driver.type).toBe('choice');
    expect(Object.keys(questions.driver.criteria).sort()).toEqual(['cloud', 'local']);
    for (const v of Object.values(questions.driver.criteria as Record<string, string>)) expect(v.length).toBeLessThanOrEqual(200);
    expect(opts).toEqual({ purpose: 'browser_driver', timeoutMs: 2000 });
  });

  it('shadow + GLM failure → the defaulted destination (local) is recorded acted:false', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('cloud', 0.9, 'shadow'));
    asMock(glmChat).mockRejectedValue(new Error('GLM down'));
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('local');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'driver', actual: 'local', acted: false });
  });

  it('off → the gate is never consulted; GLM path byte-identical', async () => {
    mockMode.mockReturnValue('off');
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(sel.kind).toBe('cloud');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('only cloud available → no gate call at all (nothing to decide)', async () => {
    mockMode.mockReturnValue('act');
    mockAgents(null);
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('cloud');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(glmChat).not.toHaveBeenCalled();
  });

  it('GLM unconfigured → the pre-gate Mac default wins before the gate is consulted', async () => {
    mockMode.mockReturnValue('act');
    asMock(glmConfigured).mockReturnValue(false);
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('local');
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('a null gate answer falls through to GLM and records nothing', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('cloud');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a throwing gate fails OPEN to GLM', async () => {
    mockMode.mockImplementation(() => { throw new Error('boom'); });
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('cloud');
    expect(glmChat).toHaveBeenCalledTimes(1);
  });
});

// E6 (2026-09-25): shadow must not add the gate's latency to the user path.
describe('selectBrowserDriver × decision gate — E6 shadow concurrency', () => {
  it('shadow: GLM is called while the gate is STILL PENDING; the outcome is recorded after both settle', async () => {
    mockMode.mockReturnValue('shadow');
    let resolveGate: (v: any) => void = () => {};
    mockDecide.mockReturnValue(new Promise((r) => { resolveGate = r; }));
    let glmCalledWhileGatePending = false;
    let gateSettled = false;
    asMock(glmChat).mockImplementation(async () => {
      glmCalledWhileGatePending = !gateSettled;
      return { content: '{"driver":"cloud","reason":"Public page."}' };
    });
    const pending = selectBrowserDriver('u1', 'read the public docs page');
    await new Promise((r) => setImmediate(r));
    expect(glmChat).toHaveBeenCalledTimes(1); // started at t≈0, not after the gate
    expect(mockRecord).not.toHaveBeenCalled();
    gateSettled = true;
    resolveGate(choice('local', 0.9, 'shadow'));
    const sel = await pending;
    expect(glmCalledWhileGatePending).toBe(true);
    expect(sel.kind).toBe('cloud'); // GLM decides in shadow
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].id).toBe('dec1');
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'driver', actual: 'cloud', acted: false });
  });

  it('shadow: a gate that rejects after GLM answered records nothing and never breaks the pick', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockRejectedValue(new Error('gate down'));
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('cloud');
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('shadow: the GLM-failure default still pairs with the settled gate', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('cloud', 0.8, 'shadow'));
    asMock(glmChat).mockRejectedValue(new Error('GLM down'));
    const sel = await selectBrowserDriver('u1', 'anything');
    expect(sel.kind).toBe('local');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'driver', actual: 'local', acted: false });
  });

  it('act still awaits the gate BEFORE GLM (a confident pick skips it)', async () => {
    mockMode.mockReturnValue('act');
    let resolveGate: (v: any) => void = () => {};
    mockDecide.mockReturnValue(new Promise((r) => { resolveGate = r; }));
    const pending = selectBrowserDriver('u1', 'log into my account');
    await new Promise((r) => setImmediate(r));
    expect(glmChat).not.toHaveBeenCalled();
    resolveGate(choice('local', 0.95));
    const sel = await pending;
    expect(sel.kind).toBe('local');
    expect(glmChat).not.toHaveBeenCalled();
  });
});
