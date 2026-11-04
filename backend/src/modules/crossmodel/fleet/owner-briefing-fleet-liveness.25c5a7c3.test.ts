/**
 * Fleet-liveness grounding + the false "fleet is stopped" repair gate —
 * tickets 25c5a7c3 (the 19-schedule live fleet reported as "The fleet is
 * stopped." after ONE cadence-stop made its schedule auto-disable) and
 * 23880ce0 (owner screenshot: "One of your scheduled loops finished its run
 * and stopped. The fleet is stopped." — while 12 other schedules stayed
 * armed and kept firing).
 *
 * The owner-briefing layer rewrites machine wake notes with NO fleet state of
 * its own, so "cadence stopped → schedule auto-disabled → loop ended" in ONE
 * chat hallucinated into a fleet-wide shutdown. The fix: (1) the rewrite
 * prompt is grounded on measured account-wide liveness (armed schedules /
 * live runs / last activity) with a hard never-contradict rule, and (2) a
 * deterministic post-generation gate repairs any fleet-wide stopped /
 * nothing-running claim that contradicts the measurement — "idle between
 * runs", never "stopped".
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async ({ data }: any) => ({ id: 'brief-row-1', ...data })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
  },
}));

// utility-llm + supervisor-state are DYNAMICALLY imported inside
// generateOwnerBriefing — mock both module boundaries.
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));
const mockLiveness: jest.Mock = jest.fn(async () => null);
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  getFleetLivenessSnapshot: (...a: any[]) => mockLiveness(...a),
}));

import {
  generateOwnerBriefing,
  buildBriefingPrompt,
  repairFleetStoppedClaims,
} from './owner-briefing.service';

const ARMED = { enabledSchedules: 12, liveRuns: 0, lastFiredAt: new Date(Date.now() - 12 * 60_000) };
const ACTIVE = { enabledSchedules: 12, liveRuns: 2, lastFiredAt: new Date(Date.now() - 4 * 60_000) };
const DEAD = { enabledSchedules: 0, liveRuns: 0, lastFiredAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockLiveness.mockResolvedValue(null);
});

describe('repairFleetStoppedClaims (the deterministic contradiction gate)', () => {
  it('REPLAYS 23880ce0: "The fleet is stopped." with 12 armed schedules is replaced by measured idle-with-context', () => {
    const incident = 'One of your scheduled loops finished its run and stopped. The fleet is stopped. Nothing needs your attention.';
    const r = repairFleetStoppedClaims(incident, ARMED);
    expect(r.repaired).toBe(true);
    expect(r.text).not.toMatch(/fleet is stopped/i);
    expect(r.text).toContain('One of your scheduled loops finished its run and stopped.'); // the TRUE part survives
    expect(r.text).toContain('idle between runs');
    expect(r.text).toContain('12 schedules are armed');
    expect(r.text).toContain('12 minutes ago');
    expect(r.text).toContain('Nothing needs your attention.');
  });

  it('"nothing is running" / "everything has stopped" claims are contradicted too (25c5a7c3 phrasing)', () => {
    const r = repairFleetStoppedClaims('Nothing is running right now. Everything has stopped.', ARMED);
    expect(r.repaired).toBe(true);
    expect(r.text).not.toMatch(/nothing is running/i);
    expect(r.text).not.toMatch(/everything has stopped/i);
    // Both false sentences collapse into ONE measured replacement.
    expect(r.text.match(/idle between runs/g)).toHaveLength(1);
  });

  it('live runs make the replacement say "active", not "idle"', () => {
    const r = repairFleetStoppedClaims('The fleet is stopped.', ACTIVE);
    expect(r.repaired).toBe(true);
    expect(r.text).toContain('Your fleet is active — 2 runs are running right now, and 12 schedules are armed');
  });

  it('a briefing with NO fleet-wide claim passes through untouched', () => {
    const clean = 'Your fleet checked 3 projects and everything is running smoothly. Nothing needs you right now.';
    const r = repairFleetStoppedClaims(clean, ARMED);
    expect(r.repaired).toBe(false);
    expect(r.text).toBe(clean);
  });

  it('a truly unarmed fleet (0 schedules, 0 runs) leaves the claim alone — it may be TRUE', () => {
    const r = repairFleetStoppedClaims('The fleet is stopped.', DEAD);
    expect(r.repaired).toBe(false);
    expect(r.text).toBe('The fleet is stopped.');
  });

  it('unavailable telemetry (null) never repairs', () => {
    const r = repairFleetStoppedClaims('The fleet is stopped.', null);
    expect(r.repaired).toBe(false);
  });

  it('a fleet-wide-claim-ONLY briefing still yields a full replacement (never posts an empty bubble)', () => {
    const r = repairFleetStoppedClaims('The fleet is stopped.', ARMED);
    expect(r.text).toContain('idle between runs');
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('review N5: a legitimate "down to one active lane" capacity sentence is NOT repaired', () => {
    const clean = 'The fleet is down to one active lane after a quiet night.';
    const r = repairFleetStoppedClaims(clean, ARMED);
    expect(r.repaired).toBe(false);
    expect(r.text).toBe(clean);
  });

  it('review N6: the widened evasion phrasings are repaired too', () => {
    for (const claim of [
      'The fleet has stopped.',
      'The fleet is not running.',
      'Nothing is active right now.',
      'Everything is down.',
      'All lanes are stopped.',
    ]) {
      const r = repairFleetStoppedClaims(claim, ARMED);
      expect(r.repaired).toBe(true);
      expect(r.text).toContain('idle between runs');
    }
  });
});

describe('buildBriefingPrompt liveness grounding', () => {
  it('with liveness: carries the measured fact line AND the never-contradict hard rule', () => {
    const [sys] = buildBriefingPrompt('note', ARMED);
    expect(sys.content).toContain('FLEET LIVENESS');
    expect(sys.content).toContain('12 schedules are armed');
    expect(sys.content).toContain('0 runs are active right now');
    expect(sys.content).toContain('last schedule activity was 12 minutes ago');
    expect(sys.content).toContain('NEVER claim the whole fleet is stopped');
  });

  it('without liveness: the hard rule stands, the fact line is absent (status quo)', () => {
    const [sys] = buildBriefingPrompt('note');
    expect(sys.content).toContain('NEVER claim the whole fleet is stopped');
    expect(sys.content).not.toContain('FLEET LIVENESS');
  });
});

describe('generateOwnerBriefing end-to-end with measured liveness', () => {
  const ARGS = {
    chatId: 'sup-chat-1',
    userId: 'u-owner',
    noteContent: 'WAKE — schedule sc-1 auto-disabled (cadence stop). The cadence-stop loop has ended.',
    sourceNoteId: 'wake-note-1',
  };

  it('the incident end-to-end: a hallucinated "fleet is stopped" briefing is REPAIRED before it is persisted', async () => {
    mockUtilityChat.mockResolvedValue('One scheduled loop finished its run and stopped. The fleet is stopped. Nothing needs your attention.');
    mockLiveness.mockResolvedValue(ARMED);
    const ok = await generateOwnerBriefing(ARGS);
    expect(ok).toBe(true);
    const posted = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content as string;
    expect(posted).not.toMatch(/fleet is stopped/i);
    expect(posted).toContain('idle between runs');
    expect(posted).toContain('12 schedules are armed');
  });

  it('a clean briefing with the same liveness posts verbatim (no gratuitous rewriting)', async () => {
    // Review 2026-09-13 issue 4: a "Your fleet…" opener is no longer "clean" —
    // the vague-voice gate replaces it — so the clean sample speaks per-project.
    const clean = 'Cadence-stop loop: finished its run and stopped → nothing further scheduled → no ETA yet';
    mockUtilityChat.mockResolvedValue(clean);
    mockLiveness.mockResolvedValue(ARMED);
    const ok = await generateOwnerBriefing(ARGS);
    expect(ok).toBe(true);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content).toBe(clean);
  });

  it('telemetry failure (liveness null) leaves generation ungrounded but working (fail-open)', async () => {
    const clean = 'Cadence-stop loop: finished its run → nothing further scheduled → no ETA yet';
    mockUtilityChat.mockResolvedValue(clean);
    mockLiveness.mockRejectedValue(new Error('db down'));
    const ok = await generateOwnerBriefing(ARGS);
    expect(ok).toBe(true);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content).toBe(clean);
  });
});
