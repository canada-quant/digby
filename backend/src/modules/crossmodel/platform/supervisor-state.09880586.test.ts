/**
 * REPLAY test — ticket 09880586 (enhancement, filed 2026-10-19T18:42Z):
 * "Stall/follow-through detection should credit armed read-back schedules on
 * designed-window todos".
 *
 * The mishap, verbatim from the ticket evidence: todo fea78360 (owner-card
 * contract) has a deliberate 7-day observe window (closes 2026-10-23T21:30Z)
 * with an armed one-shot read-back schedule 0059e4e4 that will compute the
 * before/after metric and close it. The FLEET ATTENTION "STALLED / UNSTARTED
 * TODOS" detector keyed off the todo's updatedAt and flagged it as
 * "untouched ~12h" twice in one day (06:11Z and 18:20Z steers), even though
 * the quiet window is by design and the read-back is armed — the 24h drift
 * backstop (ticket 8f5a45f7) re-flags mid-window no matter how live the
 * assignee lane is. Pre-fix, test 1 below FAILED (the armed read-back todo
 * rendered as STALLED); post-fix the armed-readback credit suppresses it.
 *
 * LIVE-GROUNDED SPECIMENS (probe-09880586.js, prod, 2026-10-19T19:17Z — the
 * exact rows the ticket names, not reconstructions):
 *  - todo fea78360: in_progress, updatedAt 2026-10-19T18:29:23Z, progressNote
 *    "…read-back one-shot armed on own sched 0059e4e4 (enabled, next
 *    10-23T21:30Z, verified live 10-19T18:28Z)…"
 *  - schedule 0059e4e4: kind once, enabled true, nextRunAt 2026-10-23T21:30:17Z,
 *    promptSetBy machine, prompt head "Todo fea78360 (owner-card contract) —
 *    7-day observe-only baseline READ-BACK. Context: the contract landed…"
 *  - census: many enabled schedules reference todo ids in prompts
 *    (4e9f87ab → "todo 4e3b53a5", c1a0cc70 → "todo 2724434c", 20b48bb0 →
 *    "todo a1577ab2") — the matching idiom is common, not a one-off.
 *
 * The fix: filterStalledByArmedReadback drops a STALLED candidate when an
 * ENABLED, still-due schedule references the todo (its prompt names the todo
 * — leg A — or the todo's progressNote cites the schedule id — leg B). It
 * composes AFTER the assignee-liveness pass and applies ONLY to the stalled
 * (in_progress) pull; UNSTARTED rows keep flagging. Fail-open: a lookup
 * failure degrades to flagging. Kill switch
 * FLEET_ATTENTION_READBACK_CREDIT_DISABLED=1 restores the bare-clock behavior.
 *
 * DETECTOR-RECALL REPLAY (the self-merge gate's replay bar): the suites below
 * re-run every prior true-positive shape of the STALLED detector — the 8f5a45f7
 * watch-lane specimens (silent lane, never-ran lane, unassigned todo, drift
 * backstop) and the e13f216e/spec-vocab pins — and assert they STILL fire.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { buildFleetAttentionBlock } from './supervisor-state.service';

const UID = 'u1';
/** The ticket's assignee lane (crossmodel Supervisor chat, prefix). */
const LANE = 'daee2916-0000-4000-8000-crossmodel-sup';
/** The flagging wake (ticket: the 18:20Z steer). */
const NOW = new Date('2026-10-19T18:20:00.000Z');
/** The ticket's todo stamp — ~12h untouched at the flagging wake. */
const TODO_STAMP = new Date('2026-10-19T06:11:00.000Z');

/** The ticket's todo fea78360 — live-grounded specimen. */
const TODO_ID = 'fea78360-b856-4473-be83-5e6a4cae38fc';
const READBACK_NOTE =
  'Owner-card contract — MID-WINDOW by design (NOT stalled): build live (PR #1616, squash 67d67f9cfb16, all boxes since 10-16T21:27Z); ' +
  '7-day observe-only window closes 10-23T21:30Z; read-back one-shot armed on own sched 0059e4e4 (enabled, next 10-23T21:30Z, verified live 10-19T18:28Z) — closes per done bar with the full-window before/after';
/** The ticket's read-back schedule 0059e4e4 — live-grounded specimen. */
const SCHED_ID = '0059e4e4-3cfa-40a0-98b0-18d8ee23870b';
const READBACK_PROMPT =
  'Todo fea78360 (owner-card contract) — 7-day observe-only baseline READ-BACK. Context: the contract landed 2026-10-16 (PR #1616, squash 67d67f9cfb16, deploy wave 38966490371 green, all boxes live on 67d67f9c). The two loop_metrics kinds — owner_card_payload_incomplete and owner_card_chain_unlinked — record at flag time on the deployed boxes since 2026-10-16T21:27Z.';

const readbackTodo = (over: Partial<any> = {}): any => ({
  id: TODO_ID,
  title: 'Owner-card contract (monitor lesson 6): every owner card carries its full payload inline AND a replacement card names what it replaces — one decision, one card, one chain',
  assigneeChatId: LANE,
  updatedAt: TODO_STAMP,
  progressNote: READBACK_NOTE,
  ...over,
});

/** The armed read-back schedule row as the new pull reads it. */
const readbackSched = (over: Partial<any> = {}): any => ({
  id: SCHED_ID,
  kind: 'once',
  enabled: true,
  nextRunAt: new Date('2026-10-23T21:30:17.024Z'),
  expiresAt: new Date('2026-11-16T07:07:17.024Z'),
  prompt: READBACK_PROMPT,
  ...over,
});

/** Route the two projectTodo queries by their where.status. */
function mockTodos({ stalled = [] as any[], pending = [] as any[] } = {}) {
  mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) =>
    where?.status === 'in_progress' ? stalled : pending,
  );
}

/** Route the chatSchedule queries by their where clause:
 *  - readback pull (no sessionId, prompt selected) → readbackRows
 *  - machinePrompts (where.userId + promptSetBy) → [] (kept empty — noise)
 *  - assignee-cadence (where.sessionId.in) → cadenceRows */
function mockSchedules(readbackRows: any[] = [], cadenceRows: any[] = []) {
  mockPrisma.chatSchedule.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.sessionId?.in) return cadenceRows;
    if (w.promptSetBy) return [];
    return readbackRows;
  });
}

/** agentRun.groupBy helper: sessionId → newest run stamp. */
const runAgg = (sessionId: string, newest: Date): any => ({ sessionId, _max: { updatedAt: newest } });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
});

describe('ticket 09880586 — armed-readback credit on the STALLED detector', () => {
  it('REPLAY: the ticket wake — designed-window todo, armed read-back, 12h untouched → NOT flagged STALLED', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockSchedules([readbackSched()]);
    // The assignee lane is demonstrably alive (fired 3h ago) — both credits
    // compose, but the DRIFT BACKSTOP would still re-flag at >24h; the
    // read-back credit is what suppresses mid-window.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-10-19T15:20:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).not.toContain('fea78360');
    expect(block).toBe(''); // nothing else to flag — the false positive is gone
  });

  it('REPLAY: the ticket shape PAST the 24h drift backstop — the armed read-back still suppresses (the window is 7 days)', async () => {
    mockTodos({ stalled: [readbackTodo({ updatedAt: new Date('2026-10-17T18:20:00.000Z') })] }); // 48h untouched
    mockSchedules([readbackSched()]);
    // Lane alive AND >24h backstop — pre-fix this re-flagged on every wake.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-10-19T18:15:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('REPLAY: the ticket shape at the END of the window (read-back fires 10-23) — post-firing, the schedule is spent and the flag returns', async () => {
    // The read-back fired: nextRunAt now past, the sweeper will flip
    // enabled:false; the moment it does (or nextRunAt passes NOW), the credit
    // lapses and an unmoved todo re-flags — the exemption is not a forever-pass.
    mockTodos({ stalled: [readbackTodo({ updatedAt: new Date('2026-10-19T06:11:00.000Z') })] });
    mockSchedules([readbackSched({ nextRunAt: new Date('2026-10-23T21:30:17.024Z') })]);
    const AFTER_FIRE = new Date('2026-10-23T21:35:00.000Z');
    // No further liveness (the lane went idle after closing) → backstop flags.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-10-23T21:31:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, AFTER_FIRE);
    // nextRunAt <= now ⇒ not still-due ⇒ no credit ⇒ flagged as before.
    expect(block).toContain('STALLED todo');
  });

  it('leg A strictness: a prompt naming a DIFFERENT todo id does not credit (no cross-todo leak)', async () => {
    const other = readbackTodo({ id: 'ab12cd34-0000-4000-8000-000000000001' });
    mockTodos({ stalled: [other] });
    mockSchedules([
      readbackSched({ id: '11112222-0000-4000-8000-000000000002', prompt: 'Todo 4e3b53a5 (mesh soak) — hourly observe-only probe, todo 4e3b53a5 watch.' }),
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo'); // no credit — different todo
  });

  it('leg A hex guard: the todo prefix as the head of a LONGER hex run is NOT a match', async () => {
    const todo = readbackTodo({ progressNote: null }); // force leg A only
    mockTodos({ stalled: [todo] });
    mockSchedules([
      // 'fea78360deadbeef' contains 'fea78360' but as a longer hex run —
      // a different row's id, not this todo's.
      readbackSched({ id: '11112222-0000-4000-8000-000000000003', prompt: 'RE-FLAG CHECK — probe state fea78360deadbeef99 then decide.' }),
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });

  it('leg B: a progressNote citing the schedule id credits even when the prompt does not name the todo', async () => {
    const todo = readbackTodo({ progressNote: 'Watch armed: read-back one-shot on own sched 0059e4e4 (enabled, next 10-23T21:30Z).' });
    mockTodos({ stalled: [todo] });
    mockSchedules([
      readbackSched({ prompt: 'Compute the before/after metric over the full observe window and close the work item.' }), // no todo id
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('a DISABLED schedule credits nothing (the spent one-shot the sweeper already flipped)', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockSchedules([readbackSched({ enabled: false })]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });

  it('an EXPIRED schedule credits nothing (expiresAt past)', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockSchedules([readbackSched({ expiresAt: new Date('2026-10-19T00:00:00.000Z'), nextRunAt: new Date('2026-10-19T00:00:00.000Z') })]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });

  it('a recurring schedule that names the todo credits too (standing watch on a long-lived todo)', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockSchedules([
      readbackSched({ kind: 'recurring', intervalSec: 86400, nextRunAt: new Date('2026-10-20T06:00:00.000Z'), prompt: 'TICK — watch (todo fea78360): probe the metric and reconcile.' }),
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('the credit applies ONLY to STALLED rows — an UNSTARTED todo on the same armed schedule still flags (genuine non-start)', async () => {
    mockTodos({
      stalled: [readbackTodo()],
      pending: [{ id: '1111aaaa-0000-4000-8000-000000000004', title: 'Kick off the metric baseline', assigneeChatId: LANE, updatedAt: TODO_STAMP, progressNote: null }],
    });
    mockSchedules([readbackSched()]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toContain('UNSTARTED todo "Kick off the metric baseline"');
  });

  it('fail-open: a readback-lookup failure degrades to FLAGGING (never hides a stall, never throws)', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockPrisma.chatSchedule.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.sessionId?.in) return [];
      if (args?.where?.promptSetBy) return [];
      throw new Error('db down');
    });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });

  it('kill switch FLEET_ATTENTION_READBACK_CREDIT_DISABLED=1 restores the bare-clock behavior (the ticket wake flags again)', async () => {
    process.env.FLEET_ATTENTION_READBACK_CREDIT_DISABLED = '1';
    try {
      mockTodos({ stalled: [readbackTodo()] });
      mockSchedules([readbackSched()]);
      const block = await buildFleetAttentionBlock(UID, NOW);
      expect(block).toContain('STALLED todo');
    } finally {
      delete process.env.FLEET_ATTENTION_READBACK_CREDIT_DISABLED;
    }
  });

  it('no readback rows at all (empty fleet) — unchanged flagging', async () => {
    mockTodos({ stalled: [readbackTodo()] });
    mockSchedules([]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });
});

// ── DETECTOR-RECALL REPLAY — prior true positives must STILL fire ───────────
// The 09880586 fix RELAXES the STALLED detector (a new suppression class);
// these re-run the detector's EXISTING convicting shapes — the 8f5a45f7
// watch-lane specimens and the spec pins — and assert they still flag.

describe('ticket 09880586 — DETECTOR-RECALL REPLAY: prior STALLED true positives still fire', () => {
  /** The 8f5a45f7 specimen todo (no id → the raw pull shape) with an id for the new pull. */
  const legacyTodo = (over: Partial<any> = {}): any => ({
    id: '5f561c18-0000-4000-8000-000000000010',
    title: 'P2: PR #55747 shepherding',
    assigneeChatId: '17f71915-0000-4000-8000-watchlane01',
    updatedAt: new Date('2026-09-14T14:41:00.000Z'),
    progressNote: null,
    ...over,
  });
  const LEGACY_NOW = new Date('2026-09-15T03:44:00.000Z');
  const LEGACY_LANE = '17f71915-0000-4000-8000-watchlane01';

  it('DETECTOR-RECALL REPLAY — 8f5a45f7: a SILENT lane stays flagged (hourly cadence, last run 5h ago)', async () => {
    mockTodos({ stalled: [legacyTodo()] });
    mockSchedules([], [{ sessionId: LEGACY_LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LEGACY_LANE, new Date('2026-09-14T22:44:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('13h');
  });

  it('DETECTOR-RECALL REPLAY — 8f5a45f7: a lane that NEVER ran stays flagged', async () => {
    mockTodos({ stalled: [legacyTodo()] });
    mockSchedules([], [{ sessionId: LEGACY_LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
  });

  it('DETECTOR-RECALL REPLAY — 8f5a45f7: an UNASSIGNED stalled todo stays flagged (no lane to check)', async () => {
    mockTodos({ stalled: [legacyTodo({ assigneeChatId: null })] });
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('assignee chat none');
  });

  it('DETECTOR-RECALL REPLAY — 8f5a45f7: drift backstop still fires WITHOUT an armed read-back (live lane, 25.7h untouched, no referencing schedule)', async () => {
    mockTodos({ stalled: [legacyTodo({ updatedAt: new Date('2026-09-14T02:00:00.000Z') })] });
    mockSchedules([], [{ sessionId: LEGACY_LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LEGACY_LANE, new Date('2026-09-15T03:40:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('untouched 25h');
  });

  it('DETECTOR-RECALL REPLAY — e13f216e: an UNANNOTATED pending todo 22h old stays UNSTARTED (liveness never suppresses pending)', async () => {
    mockTodos({
      pending: [{ id: '2222bbbb-0000-4000-8000-000000000020', title: 'Kick off the canary rebuild', assigneeChatId: LEGACY_LANE, updatedAt: new Date('2026-09-14T05:44:00.000Z'), progressNote: null }],
    });
    mockSchedules([], [{ sessionId: LEGACY_LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LEGACY_LANE, new Date('2026-09-15T03:41:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('UNSTARTED todo "Kick off the canary rebuild"');
    expect(block).toContain('22h');
  });

  it('DETECTOR-RECALL REPLAY — spec vocab: a genuine stall renders the STALLED line with untouched age + full assignee id', async () => {
    mockTodos({ stalled: [legacyTodo()] });
    mockSchedules([], []);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    const block = await buildFleetAttentionBlock(UID, LEGACY_NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('RECONCILE FIRST');
    expect(block).toContain(LEGACY_LANE); // full id (W1-7)
  });
});
