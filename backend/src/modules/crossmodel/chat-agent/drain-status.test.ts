/**
 * drain-status (WI-G, 2026-09-25) — the /drain-status payload the blue-green
 * deploy polls on the OLD colour. live-runs and retiring are the REAL leaf
 * modules (the registry contract is what the deploy reads); late-crosscheck
 * is mocked at the boundary (it imports prisma).
 *
 * Pins:
 *   - the pre-WI-G fields keep their shape (activeRuns / chatRuns /
 *     lateCrossChecks / retiring / retiringSince) — the script's
 *     `"activeRuns":N` sed still matches;
 *   - per-run detail {runId, chatId, startedAt, isSupervisorWake, lastToolAt}
 *     for chat:* runs only (coding keys are the worker tier's);
 *   - lastToolAt advances on the coding loop's raw tool events AND on the
 *     chat adapter's agent-activity {kind:'tool'|'tool_done'} mirror, never on
 *     text/reasoning;
 *   - extensionEligible is true ONLY when retiring, no late cross-check is
 *     pending, and EVERY chat run is a supervisor wake with a tool call inside
 *     the progress window (default 120 s).
 *   - (2026-10-20, deep research has no wall clock) researchExtensionEligible is
 *     true ONLY when retiring, nothing late pending, ≥ 1 run is a research council
 *     and EVERY run is a research council with a progress beat / tool event inside
 *     the stall window (COUNCIL_STALL_MS) or a progressing supervisor wake; a
 *     stalled council never extends, and RESEARCH_NO_WALL_CLOCK_DISABLED=1 keeps
 *     it false.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPendingLate = jest.fn((): number => 0);
jest.mock('./late-crosscheck', () => ({
  __esModule: true,
  pendingLateCrossCheckCount: () => mockPendingLate(),
}));

import { buildDrainStatus, shapeDrainRun, extensionEligibleFor, researchExtensionEligibleFor, drainProgressWindowMs } from './drain-status';
import { startLiveRun, endLiveRun, pushRunEvent, setRunMeta, listActiveRunDetails, runLastToolAt, getRunMeta, noteRunProgress, runLastProgressAt } from '../coding/live-runs';
import { markRetiring, __resetRetiringForTests } from '../coding/retiring';

const active: string[] = [];
const start = (key: string) => { startLiveRun(key); active.push(key); };

beforeEach(() => {
  jest.clearAllMocks();
  mockPendingLate.mockReturnValue(0);
  __resetRetiringForTests();
  delete process.env.DRAIN_PROGRESS_WINDOW_SECONDS;
  delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED;
  delete process.env.COUNCIL_STALL_MS;
});
afterEach(() => {
  while (active.length) endLiveRun(active.pop()!);
  __resetRetiringForTests();
});

describe('live-runs registry additions (WI-G)', () => {
  it('lastToolAt advances on tool events in both shapes and never on text', () => {
    start('chat:lt');
    expect(runLastToolAt('chat:lt')).toBeNull();
    pushRunEvent('chat:lt', 'text', { delta: 'hi' });
    pushRunEvent('chat:lt', 'reasoning', { delta: '…' });
    expect(runLastToolAt('chat:lt')).toBeNull();
    pushRunEvent('chat:lt', 'agent-activity', { kind: 'reasoning', delta: '…' });
    expect(runLastToolAt('chat:lt')).toBeNull();
    pushRunEvent('chat:lt', 'agent-activity', { kind: 'tool', name: 'search_engine' });
    const t1 = runLastToolAt('chat:lt');
    expect(typeof t1).toBe('number');
    pushRunEvent('chat:lt', 'tool_result', { name: 'search_engine', result: 'ok' });
    expect(runLastToolAt('chat:lt')!).toBeGreaterThanOrEqual(t1!);
    pushRunEvent('chat:lt', 'agent-activity', { kind: 'tool_done', name: 'search_engine' });
    expect(runLastToolAt('chat:lt')!).toBeGreaterThanOrEqual(t1!);
  });

  it('setRunMeta merges onto an ACTIVE run only; listActiveRunDetails carries timing + meta', () => {
    start('chat:m1');
    setRunMeta('chat:m1', { chatId: 'm1', machineTriggered: true });
    setRunMeta('chat:m1', { isSupervisorWake: true });
    expect(getRunMeta('chat:m1')).toEqual({ chatId: 'm1', machineTriggered: true, isSupervisorWake: true });
    setRunMeta('chat:nope', { chatId: 'nope' });
    expect(getRunMeta('chat:nope')).toEqual({});
    const d = listActiveRunDetails().find((r) => r.runId === 'chat:m1')!;
    expect(d).toMatchObject({ runId: 'chat:m1', chatId: 'm1', machineTriggered: true, isSupervisorWake: true, lastToolAt: null });
    expect(typeof d.startedAt).toBe('number');
    endLiveRun('chat:m1'); active.pop();
    setRunMeta('chat:m1', { chatId: 'late' }); // finished → ignored
    expect(getRunMeta('chat:m1').chatId).toBe('m1');
  });
});

describe('shapeDrainRun + extensionEligibleFor (pure)', () => {
  const now = Date.parse('2026-09-25T10:10:00.000Z');
  const row = (over: Partial<Parameters<typeof shapeDrainRun>[0]> = {}) => ({ runId: 'chat:a', startedAt: now - 600_000, lastToolAt: now - 30_000, chatId: 'a', machineTriggered: true, isSupervisorWake: true, ...over });

  it('shapes ISO stamps, ages, and the progressing flag against the window', () => {
    const d = shapeDrainRun(row(), now, 120_000);
    expect(d).toEqual({
      runId: 'chat:a', chatId: 'a', startedAt: '2026-09-25T10:00:00.000Z', ageSeconds: 600,
      isSupervisorWake: true, machineTriggered: true, lastToolAt: '2026-09-25T10:09:30.000Z', sinceToolSeconds: 30, progressing: true,
      isResearchCouncil: false, sinceProgressSeconds: 30, researchProgressing: false,
    });
    expect(shapeDrainRun(row({ lastToolAt: now - 121_000 }), now, 120_000).progressing).toBe(false);
    expect(shapeDrainRun(row({ lastToolAt: null }), now, 120_000)).toMatchObject({ lastToolAt: null, sinceToolSeconds: null, progressing: false });
    expect(shapeDrainRun(row({ chatId: undefined, isSupervisorWake: undefined, machineTriggered: undefined }), now, 120_000)).toMatchObject({ chatId: null, isSupervisorWake: false, machineTriggered: false });
  });

  it('eligible only when retiring, nothing late pending, ≥1 run, and EVERY run is a progressing supervisor wake', () => {
    const sup = shapeDrainRun(row(), now, 120_000);
    const stale = shapeDrainRun(row({ runId: 'chat:b', lastToolAt: now - 500_000 }), now, 120_000);
    const user = shapeDrainRun(row({ runId: 'chat:c', isSupervisorWake: false, machineTriggered: false }), now, 120_000);
    expect(extensionEligibleFor([sup], { retiring: true, lateCrossChecks: 0 })).toBe(true);
    expect(extensionEligibleFor([sup, sup], { retiring: true, lateCrossChecks: 0 })).toBe(true);
    expect(extensionEligibleFor([sup], { retiring: false, lateCrossChecks: 0 })).toBe(false);
    expect(extensionEligibleFor([sup], { retiring: true, lateCrossChecks: 1 })).toBe(false);
    expect(extensionEligibleFor([], { retiring: true, lateCrossChecks: 0 })).toBe(false);
    expect(extensionEligibleFor([sup, stale], { retiring: true, lateCrossChecks: 0 })).toBe(false);
    expect(extensionEligibleFor([sup, user], { retiring: true, lateCrossChecks: 0 })).toBe(false);
  });

  // ── deep research without a wall clock (2026-10-20) ──
  const council = (over: Partial<Parameters<typeof shapeDrainRun>[0]> = {}) => row({ runId: 'chat:r', chatId: 'r', machineTriggered: false, isSupervisorWake: false, isResearchCouncil: true, lastToolAt: now - 400_000, lastProgressAt: now - 5_000, ...over });

  it('a research council PROGRESSES on its latest beat (a model / tool event) inside the stall window — not on the 120 s tool window', () => {
    const d = shapeDrainRun(council(), now, 120_000, 600_000);
    expect(d).toMatchObject({ isResearchCouncil: true, progressing: false, sinceProgressSeconds: 5, researchProgressing: true });
    // quiet for 9 min (no beat, last tool 9 min ago) is still inside the 10-min stall window
    expect(shapeDrainRun(council({ lastProgressAt: null, lastToolAt: now - 540_000 }), now, 120_000, 600_000).researchProgressing).toBe(true);
    // STALLED: nothing for longer than the stall window
    expect(shapeDrainRun(council({ lastProgressAt: now - 601_000, lastToolAt: now - 700_000 }), now, 120_000, 600_000)).toMatchObject({ researchProgressing: false, sinceProgressSeconds: 601 });
    // no beat at all yet
    expect(shapeDrainRun(council({ lastProgressAt: null, lastToolAt: null }), now, 120_000, 600_000)).toMatchObject({ sinceProgressSeconds: null, researchProgressing: false });
    // a non-council run is never "research progressing", however fresh its beat
    expect(shapeDrainRun(row({ lastProgressAt: now }), now, 120_000, 600_000).researchProgressing).toBe(false);
    // the window defaults to COUNCIL_STALL_MS
    process.env.COUNCIL_STALL_MS = '180000';
    expect(shapeDrainRun(council({ lastProgressAt: now - 200_000, lastToolAt: null }), now, 120_000).researchProgressing).toBe(false);
    expect(shapeDrainRun(council({ lastProgressAt: now - 170_000, lastToolAt: null }), now, 120_000).researchProgressing).toBe(true);
  });

  it('research eligibility: retiring, nothing late, ≥ 1 PROGRESSING council, every other run a progressing council / supervisor wake', () => {
    const live = shapeDrainRun(council(), now, 120_000, 600_000);
    const stalled = shapeDrainRun(council({ runId: 'chat:s', lastProgressAt: now - 900_000, lastToolAt: now - 900_000 }), now, 120_000, 600_000);
    const sup = shapeDrainRun(row(), now, 120_000, 600_000);
    const wedgedSup = shapeDrainRun(row({ runId: 'chat:w', lastToolAt: now - 500_000 }), now, 120_000, 600_000);
    const user = shapeDrainRun(row({ runId: 'chat:u', isSupervisorWake: false, machineTriggered: false }), now, 120_000, 600_000);
    const ok = { retiring: true, lateCrossChecks: 0, disabled: false };
    expect(researchExtensionEligibleFor([live], ok)).toBe(true);
    expect(researchExtensionEligibleFor([live, sup], ok)).toBe(true);
    expect(researchExtensionEligibleFor([stalled], ok)).toBe(false); // a stalled council is not worth waiting for
    expect(researchExtensionEligibleFor([live, stalled], ok)).toBe(false);
    expect(researchExtensionEligibleFor([live, user], ok)).toBe(false);
    expect(researchExtensionEligibleFor([live, wedgedSup], ok)).toBe(false);
    expect(researchExtensionEligibleFor([sup], ok)).toBe(false); // no council ⇒ the WI-G rule alone
    expect(researchExtensionEligibleFor([], ok)).toBe(false);
    expect(researchExtensionEligibleFor([live], { ...ok, retiring: false })).toBe(false);
    expect(researchExtensionEligibleFor([live], { ...ok, lateCrossChecks: 1 })).toBe(false);
    expect(researchExtensionEligibleFor([live], { ...ok, disabled: true })).toBe(false);
    // the supervisor rule never extends for a council (it needs EVERY run to be a supervisor wake)
    expect(extensionEligibleFor([live], { retiring: true, lateCrossChecks: 0 })).toBe(false);
    // RESEARCH_NO_WALL_CLOCK_DISABLED=1 ⇒ today's eligibility (the research flag always false)
    process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1';
    expect(researchExtensionEligibleFor([live], { retiring: true, lateCrossChecks: 0 })).toBe(false);
    delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED;
    expect(researchExtensionEligibleFor([live], { retiring: true, lateCrossChecks: 0 })).toBe(true);
  });

  it('progress window defaults to 120 s and honours DRAIN_PROGRESS_WINDOW_SECONDS', () => {
    expect(drainProgressWindowMs()).toBe(120_000);
    process.env.DRAIN_PROGRESS_WINDOW_SECONDS = '45';
    expect(drainProgressWindowMs()).toBe(45_000);
    process.env.DRAIN_PROGRESS_WINDOW_SECONDS = 'x';
    expect(drainProgressWindowMs()).toBe(120_000);
  });
});

describe('buildDrainStatus (the endpoint payload)', () => {
  it('keeps the pre-WI-G fields, lists only chat:* runs with detail, and computes extensionEligible from the live registry', () => {
    start('chat:sup');
    setRunMeta('chat:sup', { chatId: 'sup', machineTriggered: true, isSupervisorWake: true });
    pushRunEvent('chat:sup', 'agent-activity', { kind: 'tool', name: 'list_chats' });
    start('coding-session-1'); // worker-tier key shape — never a drain concern here
    mockPendingLate.mockReturnValue(0);

    const before = buildDrainStatus();
    expect(before).toMatchObject({ activeRuns: 1, chatRuns: 1, lateCrossChecks: 0, retiring: false, retiringSince: null, extensionEligible: false, progressWindowSeconds: 120 });
    expect(before.runs).toHaveLength(1);
    expect(before.runs[0]).toMatchObject({ runId: 'chat:sup', chatId: 'sup', isSupervisorWake: true, machineTriggered: true, progressing: true });
    expect(typeof before.runs[0].startedAt).toBe('string');
    expect(typeof before.runs[0].lastToolAt).toBe('string');
    expect(typeof before.uptime).toBe('number');

    const since = markRetiring(new Date('2026-09-25T10:00:00.000Z'));
    const retiring = buildDrainStatus();
    expect(retiring).toMatchObject({ retiring: true, retiringSince: since.toISOString(), extensionEligible: true });

    // a late cross-check pending → not eligible, and it still counts in activeRuns
    mockPendingLate.mockReturnValue(1);
    expect(buildDrainStatus()).toMatchObject({ activeRuns: 2, chatRuns: 1, lateCrossChecks: 1, extensionEligible: false });
    mockPendingLate.mockReturnValue(0);

    // a second, non-supervisor chat run → not eligible
    start('chat:user');
    setRunMeta('chat:user', { chatId: 'user', machineTriggered: false });
    pushRunEvent('chat:user', 'tool_call', { name: 'search_engine' });
    const mixed = buildDrainStatus();
    expect(mixed.chatRuns).toBe(2);
    expect(mixed.extensionEligible).toBe(false);

    // JSON shape the deploy script greps
    const json = JSON.stringify(retiring);
    expect(json).toContain('"activeRuns":1');
    expect(json).toContain('"extensionEligible":true');
    // no research council in flight ⇒ the research flag is false (the drain is exactly today's)
    expect(json).toContain('"researchExtensionEligible":false');
  });

  it('a PROGRESSING research council on the retiring colour is research-eligible; once it stalls it is not (live registry)', () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-20T12:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      start('chat:res');
      setRunMeta('chat:res', { chatId: 'res', machineTriggered: false, isResearchCouncil: true });
      noteRunProgress('chat:res');
      expect(runLastProgressAt('chat:res')).toBe(Date.now());
      markRetiring(new Date());
      const live = buildDrainStatus();
      expect(live).toMatchObject({ chatRuns: 1, extensionEligible: false, researchExtensionEligible: true });
      expect(live.runs[0]).toMatchObject({ runId: 'chat:res', isResearchCouncil: true, researchProgressing: true });
      expect(JSON.stringify(live)).toContain('"researchExtensionEligible":true');
      expect(JSON.stringify(live)).not.toContain('"extensionEligible":true');
      // 11 minutes without a beat (> the 10-min stall window) ⇒ stalled ⇒ never extends
      jest.advanceTimersByTime(11 * 60_000);
      expect(buildDrainStatus()).toMatchObject({ researchExtensionEligible: false });
      // a fresh beat (a colleague token) ⇒ progressing again
      noteRunProgress('chat:res');
      expect(buildDrainStatus()).toMatchObject({ researchExtensionEligible: true });
      // the release switch ⇒ today's eligibility
      process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1';
      expect(buildDrainStatus()).toMatchObject({ researchExtensionEligible: false, extensionEligible: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('noteRunProgress is a no-op on an unknown or finished run', () => {
    noteRunProgress('chat:none');
    expect(runLastProgressAt('chat:none')).toBeNull();
    start('chat:fin');
    endLiveRun('chat:fin'); active.pop();
    noteRunProgress('chat:fin');
    expect(runLastProgressAt('chat:fin')).toBeNull();
  });
});
