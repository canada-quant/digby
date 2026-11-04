/**
 * Ticket c7d5f885 — REPLAY: late council findings silently dropped on
 * degraded deep-research runs.
 *
 * INCIDENT SHAPE: the council's terminal stragglers fire `onLateReport`
 * (council-dispatch) which pushes into `inbox.lead` — an inbox drained ONLY
 * by the lead's live tool loop. On a degraded run (the lead answers alone)
 * that inbox is dead at finalize, so the finding vanished (the pre-fix footer
 * even admitted it: "findings that arrive afterward are dropped once the run
 * ends").
 *
 * FIX: council-late-addendum.ts — capture-always (note), decide-later
 * (enable + bind + settle): only a run that BOTH went degraded AND shipped an
 * assistant row flushes ONE `council_addendum` follow-up row after a grace
 * window. This suite replays the incident order, pins every non-flush guard,
 * pins the FOUR exemption seams (label hooks, dig-deeper wiring, window
 * closer ×2) and the service source-shape wiring.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async (q: any) => ({ id: 'new_row', ...q.data })) },
  crossModelChat: { update: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// council-late-addendum imports only the CouncilTimer TYPE from here; the
// mock keeps the real module (and its deps) out of the suite either way.
jest.mock('./council-dispatch', () => ({ runBoundedColleague: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { armLateCouncilAddendum, COUNCIL_ADDENDUM_KIND, COUNCIL_ADDENDUM_GRACE_MS_ENV } from './council-late-addendum';
import { isHarnessRow } from './compute-policy-label-hooks';
import { nextRungForMessage } from './compute-policy-wiring';
import { machineLabelEligible, windowCloserEligible } from '../platform/compute-policy-window-closer';

const NOW = new Date('2026-09-30T20:00:00Z');

/** Fake CouncilTimer: settle() hangs on fire() — no real clocks in the suite. */
const makeTimer = () => {
  const pending: Array<{ cb: () => void; ms: number }> = [];
  return {
    timer: {
      set: (cb: () => void, ms: number) => { pending.push({ cb, ms }); return pending.length - 1; },
      clear: () => { pending.length = 0; },
    },
    size: () => pending.length,
    armedMs: () => (pending[0] ? pending[0].ms : null),
    fire: () => { const p = pending.shift(); if (p) p.cb(); },
  };
};

const recordMetric = jest.fn();
const warn = jest.fn();

const arm = (over: Record<string, any> = {}) => armLateCouncilAddendum({
  chatId: 'chat1',
  sessionId: 'sess1',
  stamp: (() => ({ ts: 1 })) as any,
  now: () => NOW,
  prisma: mockPrisma,
  recordMetric: recordMetric as any,
  logger: { warn },
  ...over,
});

const META = { models: { lead: 'kimi-k3' }, modelLabels: { lead: 'Kimi K3' }, mode: 'deep_research' };

/** Flush the create().then(...) microtask chain settle() may leave behind. */
const flush = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[COUNCIL_ADDENDUM_GRACE_MS_ENV];
});

describe('c7d5f885 replay — late council findings on a degraded run', () => {
  it('REPLAY: a finding noted in the INCIDENT ORDER (note → enable → bind) flushes ONE council_addendum follow-up row after the grace window', async () => {
    const t = makeTimer();
    const holder = arm({ timer: t.timer, graceMs: 1000 });
    // Incident order: onLateReport fires while the lead is STILL finalizing —
    // before the degraded notice (enable) and before the answer row ships (bind).
    holder.note('Colleague A', 'Finding: the S3 bucket policy grants public LIST');
    holder.enable();
    holder.bind('answer_row_1', META);

    const settled = holder.settle();
    expect(t.size()).toBe(1);          // the grace timer is armed…
    expect(t.armedMs()).toBe(1000);    // …for the configured window…
    t.fire();                          // …and the grace elapses
    await settled;
    await flush();

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(created.chatId).toBe('chat1');
    expect(created.role).toBe('assistant');
    expect(created.metadata.kind).toBe(COUNCIL_ADDENDUM_KIND);
    expect(created.metadata.addendumFor).toBe('answer_row_1');
    expect(created.metadata.mode).toBe('deep_research');
    expect(created.metadata.models).toEqual({ lead: 'kimi-k3' });
    expect(created.metadata.council.reports).toBe(1);
    expect(String(created.content)).toContain('Colleague A');
    expect(String(created.content)).toContain('public LIST');
    // The follow-up must surface: chat updatedAt bumped…
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'chat1' }, data: { updatedAt: NOW } });
    // …and the audit gets its counter.
    expect(recordMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'council_late_addendum', sessionId: 'sess1',
      meta: expect.objectContaining({ chatId: 'chat1', reports: 1, graceMs: 1000 }),
    }));
  });

  it('the grace window keeps collecting: a straggler noted DURING the grace lands in the same row', async () => {
    const t = makeTimer();
    const holder = arm({ timer: t.timer, graceMs: 1000 });
    holder.note('Colleague A', 'first finding');
    holder.enable();
    holder.bind('answer_row_1', META);
    const settled = holder.settle();
    holder.note('Colleague B', 'second finding'); // fires while the grace runs
    t.fire();
    await settled;
    await flush();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(created.metadata.council.reports).toBe(2);
    expect(String(created.content)).toContain('first finding');
    expect(String(created.content)).toContain('second finding');
  });

  it('graceMs 0 flushes immediately with no timer', async () => {
    const t = makeTimer();
    const holder = arm({ timer: t.timer, graceMs: 0 });
    holder.note('A', 'x');
    holder.enable();
    holder.bind('r1', META);
    await holder.settle();
    await flush();
    expect(t.size()).toBe(0);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('c7d5f885 — non-flush guards (a holder must never invent a row)', () => {
  it('a run that did NOT go degraded never flushes (enable is the only degraded signal)', async () => {
    const t = makeTimer();
    const holder = arm({ timer: t.timer, graceMs: 1000 });
    holder.note('A', 'finding');
    holder.bind('r1', META); // note + bind but NO enable
    await holder.settle();
    await flush();
    expect(t.size()).toBe(0); // short-circuits before even arming the grace
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(recordMetric).not.toHaveBeenCalled();
  });

  it('a run whose assistant persist failed (null rowId) never flushes', async () => {
    const holder = arm({ graceMs: 0 });
    holder.note('A', 'finding');
    holder.enable();
    holder.bind(null, META);
    await holder.settle();
    await flush();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a chatless run (null chatId) never flushes', async () => {
    const holder = arm({ chatId: null, graceMs: 0 });
    holder.note('A', 'finding');
    holder.enable();
    holder.bind('r1', META);
    await holder.settle();
    await flush();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('settle() called with nothing flushable returns without arming the timer — later arrivals need a second settle (why the service settles AFTER bind)', async () => {
    const t = makeTimer();
    const holder = arm({ timer: t.timer, graceMs: 1000 });
    await holder.settle(); // nothing noted/enabled/bound yet
    expect(t.size()).toBe(0);
    holder.note('A', 'finding');
    holder.enable();
    holder.bind('r1', META);
    await flush();
    // The first settle already returned; no row appears until a second settle.
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a create() failure never rejects and is counted persisted:false', async () => {
    mockPrisma.crossModelMessage.create.mockRejectedValueOnce(new Error('db gone'));
    const holder = arm({ graceMs: 0 });
    holder.note('A', 'finding');
    holder.enable();
    holder.bind('r1', META);
    await expect(holder.settle()).resolves.toBeUndefined();
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(recordMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'council_late_addendum',
      meta: expect.objectContaining({ persisted: false }),
    }));
  });
});

describe('c7d5f885 — exemption seams (the addendum row must not perturb the policy passes)', () => {
  // Mirrors compute-policy-window-closer.test.ts's row() shape so the
  // controls prove the fixtures are otherwise ELIGIBLE.
  const answers = { simple_lookup: 0.92, ordinary: 0.05, contestable: 0.02, unclear: 0.01 };
  const decision = { id: 'd1', answers, mode: 'shadow' };
  const base = { mode: 'thinking', origin: 'user', depth: { plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' }, decision, facts: { leadToolCalls: 4, webToolCalls: 2, finalChars: 3000, checkerSpawned: true, checkerMerged: false } } };

  it('label hooks: a council_addendum row is a HARNESS row the re-ask window steps over', () => {
    expect(isHarnessRow({ role: 'assistant', metadata: { kind: COUNCIL_ADDENDUM_KIND } } as any)).toBe(true);
    expect(isHarnessRow({ role: 'assistant', metadata: { kind: 'some_other_kind' } } as any)).toBe(false);
  });

  it('dig-deeper wiring: a council_addendum row is never escalatable (the rung belongs to the ANSWER row)', () => {
    expect(nextRungForMessage({ kind: COUNCIL_ADDENDUM_KIND, mode: 'thinking' })).toBeNull();
  });

  it('window closer: a council_addendum row is exempt from BOTH passes (controls prove the fixtures are otherwise eligible)', () => {
    expect(windowCloserEligible({ ...base }, {})).toBe(true); // control
    expect(windowCloserEligible({ ...base, kind: COUNCIL_ADDENDUM_KIND }, {})).toBe(false);
    expect(machineLabelEligible({ ...base }, { isSupervisor: true })).toBe(true); // control
    expect(machineLabelEligible({ ...base, kind: COUNCIL_ADDENDUM_KIND }, { isSupervisor: true })).toBe(false);
  });
});

describe('c7d5f885 — source-shape wiring pins (regression-by-deletion guard)', () => {
  const src = (f: string) => readFileSync(join(__dirname, f), 'utf8');
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  it('chat-agent.service.ts arms the holder and wires note/enable/bind/settle exactly once each', () => {
    const svc = src('chat-agent.service.ts');
    expect(count(svc, /armLateCouncilAddendum\(/g)).toBe(1);
    expect(count(svc, /lateCouncil\.note\(persona/g)).toBe(1);
    expect(count(svc, /lateCouncil\.enable\(\)/g)).toBe(1);
    expect(count(svc, /lateCouncil\.bind\(assistantRowId/g)).toBe(1);
    expect(count(svc, /void lateCouncil\.settle\(\)/g)).toBe(1);
  });

  it('loop-metrics carries the council_late_addendum kind', () => {
    expect(src('../platform/loop-metric-kinds.ts')).toMatch(/COUNCIL_LATE_ADDENDUM:\s*'council_late_addendum'/);
  });
});
