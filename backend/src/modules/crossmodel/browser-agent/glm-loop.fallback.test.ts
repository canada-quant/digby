/** Cloud→local fallback (feedback b346ce80): when the cloud browser cannot
 * INTERACT (BrightData zone-block mid-session, or the default prod config with
 * CLOUD_BROWSER_CDP unset — every cloud session read-only from the start), the
 * session must re-route to the user's paired Mac browser the moment an
 * interactive action is refused — instead of grinding a click-less session.
 * Pure-read sessions must NOT reroute: scrape handles them fine (PR #293
 * review). */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string) => s,
}));
jest.mock('./router', () => ({
  __esModule: true,
  selectBrowserDriver: jest.fn(),
  selectLocalFallbackDriver: jest.fn(),
}));

import { glmChat } from './glm-client';
import { selectBrowserDriver, selectLocalFallbackDriver } from './router';
import { runBrowserAgentSession } from './glm-loop';

const INTERACTIVE = new Set(['click', 'type', 'scroll', 'screenshot']);

/** readOnly=true models "no live CDP session": interactive actions are refused. */
const mkDriver = (kind: 'cloud' | 'local', readOnly = false) => {
  const d: any = {
    kind,
    refused: false,
    isAvailable: jest.fn(async () => true),
    wasInteractiveRefused: () => d.refused,
    execute: jest.fn(async (action: any) => {
      if (readOnly && INTERACTIVE.has(action.name)) {
        d.refused = true;
        return { ok: false, driver: kind, action: action.name, error: `read-only — cannot ${action.name}` };
      }
      return {
        ok: true, driver: kind, action: action.name,
        url: action.url || 'https://example.test/', content: `${kind} page content`,
      };
    }),
    close: jest.fn(async () => {}),
  };
  return d;
};

const turn = (id: string, name: string, args: any) => ({
  content: '',
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const navigateTurn = turn('t1', 'navigate', { url: 'https://example.test/' });
const clickTurn = turn('t2', 'click', { ref: 'e5' });
const readTurn = turn('t2', 'get_content', { format: 'text' });
const localNavigateTurn = turn('t3', 'navigate', { url: 'https://example.test/' });
const doneTurn = turn('t4', 'done', { message: 'all done via the Mac browser' });

const runSession = () => {
  const events: Array<{ type: string; data: any }> = [];
  return {
    events,
    result: runBrowserAgentSession({
      userId: 'u1', message: 'log in and check the deck builder page', maxSteps: 5,
      sendEvent: (type: string, data: any) => events.push({ type, data }),
    } as any),
  };
};

const cloudSelected = (cloud: any) =>
  (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver: cloud, kind: 'cloud', reason: 'cloud picked' });
const localAvailable = (local: any) =>
  (selectLocalFallbackDriver as jest.Mock).mockResolvedValue({ driver: local, kind: 'local', reason: 'switching to your Mac browser' });

beforeEach(() => jest.clearAllMocks());

describe('cloud cannot-interact → local Mac fallback (feedback b346ce80)', () => {
  it('a refused interactive action re-routes to the paired local browser (works in the CDP-off prod config too)', async () => {
    const cloud = mkDriver('cloud', true);
    const local = mkDriver('local');
    cloudSelected(cloud); localAvailable(local);
    // Snapshot the transcript AT EACH CALL — the mock records the messages
    // array by reference, so reading .mock.calls later would show the final
    // mutated state, not what the model actually saw mid-run.
    const rolesAtCall: string[][] = [];
    const sysAtCall: string[] = [];
    const queue = [navigateTurn, clickTurn, localNavigateTurn, doneTurn];
    (glmChat as jest.Mock).mockImplementation((input: any) => {
      rolesAtCall.push(input.messages.map((m: any) => m.role));
      sysAtCall.push(String(input.messages[0]?.content ?? ''));
      return Promise.resolve(queue[Math.min(rolesAtCall.length - 1, queue.length - 1)]);
    });

    const { events, result } = runSession();
    const r = await result;

    expect(selectLocalFallbackDriver).toHaveBeenCalledWith('u1', { attach: false });
    expect(cloud.execute).toHaveBeenCalledTimes(2); // navigate + refused click — no grinding
    expect(cloud.close).toHaveBeenCalled();
    expect(local.execute).toHaveBeenCalled(); // the session continued on the Mac
    expect(events.filter((e) => e.type === 'progress' && e.data?.stage === 'browser-route').length).toBeGreaterThanOrEqual(2);
    // PR #293 review Finding 2: the post-fallback turn must re-plan from a
    // CLEAN transcript — a wiped message list + the LOCAL system prompt (an
    // orphaned cloud tool_call batch would 400 the chat API).
    expect(rolesAtCall[2]).toEqual(['system', 'user']);
    // Honest local prompt (2026-09-09): Digby's OWN browser profile on the Mac,
    // not the user's everyday browser session.
    expect(sysAtCall[2]).toContain("Digby's own browser on the user's Mac");
    expect(r.finalResponse).toContain('all done');
  });

  it('stays on cloud (no crash) when no local agent is online', async () => {
    const cloud = mkDriver('cloud', true);
    cloudSelected(cloud);
    (selectLocalFallbackDriver as jest.Mock).mockResolvedValue(null);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(clickTurn)   // refused, but nowhere to fall back to
      .mockResolvedValueOnce(doneTurn);

    const { result } = runSession();
    const r = await result;

    expect(selectLocalFallbackDriver).toHaveBeenCalledWith('u1', { attach: false });
    expect(cloud.execute).toHaveBeenCalled(); // carried on, read-only
    expect(r.finalResponse).toContain('all done');
  });

  it('never probes the fallback when the cloud driver is healthy (CDP interactive)', async () => {
    const cloud = mkDriver('cloud', false); // full CDP session
    cloudSelected(cloud);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(clickTurn)   // succeeds on CDP — no refusal
      .mockResolvedValueOnce(doneTurn);

    const { result } = runSession();
    await result;

    expect(selectLocalFallbackDriver).not.toHaveBeenCalled();
  });

  it('never reroutes a PURE-READ session — read-only cloud scrape handles those (PR #293 review)', async () => {
    const cloud = mkDriver('cloud', true); // read-only, but the task never interacts
    cloudSelected(cloud);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(readTurn)    // get_content works fine on scrape
      .mockResolvedValueOnce(doneTurn);

    const { result } = runSession();
    const r = await result;

    expect(selectLocalFallbackDriver).not.toHaveBeenCalled();
    expect(cloud.execute).toHaveBeenCalledTimes(2);
    expect(r.finalResponse).toContain('all done');
  });
});
