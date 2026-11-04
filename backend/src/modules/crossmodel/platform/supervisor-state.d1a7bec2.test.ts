/**
 * REPLAY test — ticket d1a7bec2 (enhancement, filed 2026-11-02T12:50Z), CASE 1:
 * "Board false-positive class: never-close 'standing role' todos always read
 * STALLED".
 *
 * The mishap, verbatim from the ticket: Schooltime goal 53c7e5f6 carries two
 * PERMANENT roles that are designed never to close —
 *  - todo e7bebd4a "Gap identifier role (standing, RUNS FIRST)", whose note
 *    says "STANDING ROLE" and describes the discharge of its condition;
 *  - todo 00432983 "Dataset enhancer role (standing)", note "(Standing role -
 *    never close.)".
 * Both appeared in [FLEET ATTENTION → STALLED / UNSTARTED TODOS] at 47 h and
 * 33 h untouched. Neither was stalled: the first is idle BY DESIGN (ingestion
 * queue len=1, licence-gated), the second was actively shipping (ladder rungs
 * 92971885 / f2ebf24d / 0580cef6, kr-moe S3 422 rows, premise
 * standards_enriched 2891→3313). Cost: two fleet steers and a full
 * project-supervisor wake on ledger hygiene — and both rows re-entered the
 * stall list ~24 h after every refresh, forever.
 *
 * The fix: a todo whose TITLE or progressNote declares a standing role is
 * split out of BOTH pulls before any stall clock runs, and re-surfaces only
 * through an ADOPTION check — its assignee lane's newest run older than
 * STANDING_ROLE_QUIET_MS (72 h). A live standing role stays quiet; a dead one
 * still surfaces, with the remedy that fits a never-close duty (re-steer or
 * retire), not the impossible "close it with todo_update".
 *
 * DETECTOR-RECALL REPLAY (the self-merge gate's replay bar): the last suite
 * re-runs the STALLED detector's PRIOR true positives — a genuinely stalled
 * todo, an UNSTARTED row, and a plain note that merely mentions the word
 * "standing" in prose — and asserts they STILL fire.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  buildFleetAttentionBlock,
  isStandingRoleTodo,
  STANDING_ROLE_QUIET_MS,
} from './supervisor-state.service';

const UID = 'u1';
/** The flagging wake (the ticket's 2026-11-02 ~12:50Z observation). */
const NOW = new Date('2026-11-02T12:50:00.000Z');
/** The Schooltime goal's two permanent-role lanes. */
const GAP_LANE = 'e7bebd4a-0000-4000-8000-schooltime-gap';
const DATA_LANE = '00432983-0000-4000-8000-schooltime-data';

/**
 * The ticket's todo e7bebd4a — idle-BY-DESIGN, 47 h untouched, never closes.
 */
const gapTodo = (over: Partial<any> = {}): any => ({
  id: 'e7bebd4a-1f2e-4a3b-8c9d-0a1b2c3d4e5f',
  title: 'Gap identifier role (standing, RUNS FIRST)',
  status: 'in_progress',
  assigneeChatId: GAP_LANE,
  updatedAt: new Date('2026-10-31T13:50:00.000Z'), // ~47 h
  progressNote:
    'STANDING ROLE — runs first on every wake: sweep the ingestion queue for unmet licence/coverage gaps. Queue len=1, licence-gated; ' +
    'nothing to dispatch this wake. The role is discharged by the sweep itself, not by closing the todo.',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...over,
});

/** The ticket's todo 00432983 — actively shipping, 33 h since its last restamp. */
const dataTodo = (over: Partial<any> = {}): any => ({
  id: '00432983-9a8b-4c7d-8e6f-1a2b3c4d5e6f',
  title: 'Dataset enhancer role (standing)',
  status: 'in_progress',
  assigneeChatId: DATA_LANE,
  updatedAt: new Date('2026-11-01T03:50:00.000Z'), // ~33 h
  progressNote: '(Standing role - never close.) Ladder rungs 92971885 / f2ebf24d / 0580cef6 shipped; kr-moe S3 422 rows; standards_enriched 2891→3313.',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...over,
});

/** Route the two projectTodo queries by their where.status (as the service pulls them). */
function mockTodos({ stalled = [] as any[], pending = [] as any[] } = {}) {
  mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) =>
    where?.status === 'in_progress' ? stalled : pending,
  );
}

/** agentRun.groupBy helper: sessionId → newest run stamp. */
const runAgg = (sessionId: string, newest: Date): any => ({ sessionId, _max: { updatedAt: newest } });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED;
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
});

describe('isStandingRoleTodo — the marker', () => {
  it('matches the ticket\'s two live titles (both word orders)', () => {
    expect(isStandingRoleTodo({ title: 'Gap identifier role (standing, RUNS FIRST)' })).toBe(true);
    expect(isStandingRoleTodo({ title: 'Dataset enhancer role (standing)' })).toBe(true);
    expect(isStandingRoleTodo({ title: 'STANDING ROLE — gap identifier' })).toBe(true);
  });

  it('matches the never-close DECLARATION in the note', () => {
    expect(isStandingRoleTodo({ title: 'Dataset enhancer', progressNote: '(Standing role - never close.)' })).toBe(true);
    expect(isStandingRoleTodo({ title: 'Thing', progressNote: 'Permanent by design — never close it.' })).toBe(true);
    expect(isStandingRoleTodo({ title: 'Thing', progressNote: 'Do not close this row.' })).toBe(true);
  });

  it('does NOT match prose that merely uses the word "standing" or a third-person "never closes"', () => {
    expect(isStandingRoleTodo({ title: 'Wire the read-back', progressNote: 'Standing by for the deploy window; the soak never closes early.' })).toBe(false);
    expect(isStandingRoleTodo({ title: 'Mesh soak', progressNote: 'holding steady, window never closes before 11-20' })).toBe(false);
    expect(isStandingRoleTodo({ title: 'Deploy the fix', progressNote: 'waiting on CI' })).toBe(false);
  });

  /**
   * Review round 1 (attack 4) — a marker false positive is EXPENSIVE in the
   * wrong direction: a match REMOVES a row from the STALLED/UNSTARTED list, so
   * a genuinely stalled todo whose note merely contains both words would be
   * silenced. The first cut used a 24-character gap and matched all of the
   * shapes below, including the NORMAL note on a paused todo ("Do not close the
   * PR until CI is green"). These are pinned so a future widening of the marker
   * fails here instead of quietly muting real stalls.
   */
  it('does NOT match ordinary prose that puts "standing" and "role" near each other', () => {
    for (const t of [
      'role table sorted; pod standing.',
      'role: standing up the replica',
      'Standing wave -- role of the mesh',
      'standing order: the role of the ledger is unchanged',
    ]) {
      expect(isStandingRoleTodo({ title: t })).toBe(false);
    }
  });

  it('does NOT match the NORMAL paused-work note "do not close" (imperative needs it/this)', () => {
    expect(isStandingRoleTodo({ title: 'Ship the fix', progressNote: 'Do not close the PR until CI is green.' })).toBe(false);
  });
});

describe('ticket d1a7bec2 CASE 1 — standing roles no longer read STALLED', () => {
  it('REPLAY: the ticket wake — BOTH permanent roles, 47 h / 33 h untouched → neither is flagged', async () => {
    mockTodos({ stalled: [gapTodo(), dataTodo()] });
    // Both lanes are demonstrably alive: the gap role ran 4 h ago (its sweep),
    // the enhancer lane ran 30 h ago (shipping rungs). Adoption holds for both.
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      runAgg(GAP_LANE, new Date('2026-11-02T08:50:00.000Z')),
      runAgg(DATA_LANE, new Date('2026-11-01T06:50:00.000Z')),
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).not.toContain('UNSTARTED todo');
    expect(block).not.toContain('e7bebd4a');
    expect(block).not.toContain('00432983');
    expect(block).toBe(''); // the whole false positive is gone — no other flag
  });

  it('REPLAY: the ticket shape PAST the 24 h drift backstop — still quiet (a permanent role has no 24 h clock)', async () => {
    // 30 DAYS untouched: the old 24 h backstop re-flagged this every wake.
    mockTodos({ stalled: [gapTodo({ updatedAt: new Date('2026-10-03T12:50:00.000Z') })] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(GAP_LANE, new Date('2026-11-02T12:00:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('an UNSTARTED standing role is quiet too (the split covers BOTH pulls)', async () => {
    mockTodos({ pending: [gapTodo({ status: 'pending' })] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(GAP_LANE, new Date('2026-11-02T10:50:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('UNSTARTED todo');
    expect(block).toBe('');
  });

  it('ADOPTION, not a mute: a dead standing role (lane silent > 72 h) STILL surfaces, on its own line with its own remedy', async () => {
    mockTodos({ stalled: [dataTodo()] });
    // The enhancer lane has not run in 5 days — the role has lost its channel.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(DATA_LANE, new Date('2026-10-28T12:50:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STANDING ROLE, NO ADOPTION');
    expect(block).toContain('00432983');
    // The remedy that fits a never-close duty — never "close it".
    expect(block).toContain('never close it');
    // …and it is NOT reported as a stall.
    expect(block).not.toContain('STALLED todo');
  });

  it('ADOPTION: a standing role on a lane that NEVER ran falls back to the todo clock (no silent pass)', async () => {
    mockTodos({ stalled: [dataTodo({ updatedAt: new Date('2026-10-20T12:50:00.000Z') })] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([]); // no run rows at all
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STANDING ROLE, NO ADOPTION');
  });

  it('the 72 h threshold is the boundary (72 h silent surfaces, 71 h stays quiet)', async () => {
    const boundary = new Date(NOW.getTime() - STANDING_ROLE_QUIET_MS);
    mockTodos({ stalled: [dataTodo()] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(DATA_LANE, boundary)]);
    expect(await buildFleetAttentionBlock(UID, NOW)).toContain('STANDING ROLE, NO ADOPTION');

    jest.clearAllMocks();
    mockTodos({ stalled: [dataTodo()] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(DATA_LANE, new Date(NOW.getTime() - STANDING_ROLE_QUIET_MS + 60_000))]);
    expect(await buildFleetAttentionBlock(UID, NOW)).not.toContain('STANDING ROLE, NO ADOPTION');
  });

  it('fail-open: a broken adoption lookup does NOT hide the role and does NOT throw', async () => {
    mockTodos({ stalled: [dataTodo({ updatedAt: new Date('2026-10-20T12:50:00.000Z') })] });
    mockPrisma.agentRun.groupBy.mockRejectedValue(new Error('db down'));
    const block = await buildFleetAttentionBlock(UID, NOW);
    // Falls back to the todo clock (very old) → still surfaces.
    expect(block).toContain('STANDING ROLE, NO ADOPTION');
  });

  it('kill switch: FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED=1 restores the bare clock byte-for-byte', async () => {
    process.env.FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED = '1';
    mockTodos({ stalled: [gapTodo(), dataTodo()] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      runAgg(GAP_LANE, new Date('2026-11-02T08:50:00.000Z')),
      runAgg(DATA_LANE, new Date('2026-11-01T06:50:00.000Z')),
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    // The pre-fix rendering: both permanent roles read STALLED again.
    expect(block).toContain('STALLED todo');
    expect(block).not.toContain('STANDING ROLE, NO ADOPTION');
  });
});

describe('DETECTOR-RECALL REPLAY — the STALLED/UNSTARTED detector still fires on its prior true positives', () => {
  it('DETECTOR-RECALL REPLAY: a genuinely stalled ORDINARY in_progress todo still flags STALLED', async () => {
    mockTodos({
      stalled: [{
        id: 'aaaa1111-0000-4000-8000-000000000001',
        title: 'Ship the mesh soak',
        status: 'in_progress',
        assigneeChatId: 'lane-silent',
        // 20 h untouched: past the 2 h stall clock AND the 12 h fresh-note
        // credit, so the detector is genuinely armed.
        updatedAt: new Date('2026-11-01T16:50:00.000Z'),
        progressNote: 'waiting on CI',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      }],
    });
    // Silent lane (last ran 2 days ago → liveness credit does NOT apply).
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg('lane-silent', new Date('2026-10-31T12:50:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
    expect(block).toContain('Ship the mesh soak');
  });

  it('DETECTOR-RECALL REPLAY: an UNSTARTED assigned todo still flags UNSTARTED', async () => {
    mockTodos({
      pending: [{
        id: 'bbbb2222-0000-4000-8000-000000000002',
        title: 'Write the migration',
        status: 'pending',
        assigneeChatId: 'lane-b',
        updatedAt: new Date('2026-11-01T20:50:00.000Z'),
        progressNote: null,
        createdAt: new Date('2026-10-30T00:00:00.000Z'),
      }],
    });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo');
    expect(block).toContain('Write the migration');
  });

  it('DETECTOR-RECALL REPLAY: prose that merely says "standing by" / "never closes early" still flags STALLED', async () => {
    mockTodos({
      stalled: [{
        id: 'cccc3333-0000-4000-8000-000000000003',
        title: 'Mesh soak window',
        status: 'in_progress',
        assigneeChatId: 'lane-c',
        updatedAt: new Date('2026-11-01T16:50:00.000Z'), // 20 h — the detector is armed
        progressNote: 'Standing by for the deploy window; the soak never closes early.',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      }],
    });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg('lane-c', new Date('2026-10-31T12:50:00.000Z'))]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
    expect(block).toContain('Mesh soak window');
    expect(block).not.toContain('STANDING ROLE, NO ADOPTION');
  });
});