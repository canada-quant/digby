/**
 * REPLAY + pin test — ticket e13f216e (enhancement, filed 2026-09-16T19:07Z):
 * "Fleet-attention 'stalled todo' pull re-flags deliberately-queued todos
 * after project-supervisor reconcile stamps".
 *
 * The ticket evidence, as shapes: tt-rd todos 19d2f388 ("P1 (speed lever L3):
 * MoE router+shared+shared_ar chain lever") and c38d8fac ("P2 (speed lever L4
 * = Lever B): device-side logits+sampling"), created 2026-09-15 ~14:46Z, were
 * annotated sequenced/deliberate-queue by the tt-rd project supervisor (chat
 * 810c924d) via progressNote restamps at 10:57Z and 18:59Z on 2026-09-16 plus
 * a full reconcile answer 10:58Z. The fleet-attention block in chat c0e22e36's
 * wake envelopes at 18:45Z and 18:52Z still flagged BOTH as
 * 'UNSTARTED todo … assigned 7h ago, still pending' — the "7h" being the
 * 10:57Z restamp (Prisma @updatedAt bumps on every progressNote write), not
 * the ~28h creation age. Pre-fix, tests 1–2 FAILED: the deliberately-queued
 * todos rendered as UNSTARTED, and the age line keyed on the restamp.
 *
 * The fix: both todo pulls drop rows whose progressNote was restamped within
 * RECONCILED_FRESH_MS (12h) — a fresh annotation is positive reconcile
 * evidence (deliberate queue / active work); the stamp ages out at 12h and an
 * unmoved todo re-flags. The UNSTARTED age line now reports the untouched age
 * plus the true creation age instead of "assigned N ago, still pending".
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

import { buildFleetAttentionBlock } from './supervisor-state.service';

const UID = 'u1';
/** The fleet wake that re-flagged the annotated todos (ticket evidence). */
const NOW = new Date('2026-09-16T18:45:00.000Z');
/** The project supervisor's 10:57Z progressNote restamp (7h48m before NOW). */
const RESTAMP = new Date('2026-09-16T10:57:00.000Z');
/** The todos' creation stamp (~28h before NOW — the ticket's "28h" age). */
const CREATED = new Date('2026-09-15T14:46:00.000Z');
const ASSIGNEE = '810c924d-0000-4000-8000-assigneeLane';

const queuedTodo = (over: Partial<any> = {}): any => ({
  title: 'P1 (speed lever L3): MoE router+shared+shared_ar chain lever',
  assigneeChatId: ASSIGNEE,
  updatedAt: RESTAMP,
  createdAt: CREATED,
  progressNote: 'Sequenced after L2 lands — deliberate queue (reconciled 10:58Z)',
  ...over,
});

/** Route the two projectTodo queries by their where.status. */
function mockTodos({ stalled = [] as any[], pending = [] as any[] } = {}) {
  mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) =>
    where?.status === 'in_progress' ? stalled : pending,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
});

describe('ticket e13f216e replay — freshly-reconciled todos are NOT stalled/unstarted', () => {
  it('REPLAY: the 18:45Z wake — pending todo restamped 7h48m prior (created 28h prior) → NOT flagged', async () => {
    mockTodos({ pending: [queuedTodo()] });
    const block = await buildFleetAttentionBlock(UID, NOW);
    // Pre-fix this block contained `- UNSTARTED todo "P1 (speed lever L3)…" — assigned 7h ago, still pending`.
    expect(block).not.toContain('UNSTARTED todo');
    expect(block).not.toContain('MoE router');
    expect(block).toBe(''); // nothing else to flag — the false positive is simply gone
  });

  it('REPLAY: BOTH ticket todos (19d2f388 + c38d8fac shapes) suppressed together', async () => {
    mockTodos({
      pending: [
        queuedTodo(),
        queuedTodo({ title: 'P2 (speed lever L4 = Lever B): device-side logits+sampling' }),
      ],
    });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('UNSTARTED todo');
    expect(block).toBe('');
  });

  it('the annotation AGES OUT: a restamp 13h old re-flags the still-pending todo', async () => {
    mockTodos({ pending: [queuedTodo({ updatedAt: new Date('2026-09-16T05:45:00.000Z') })] }); // 13h before NOW
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo "P1 (speed lever L3): MoE router+shared+shared_ar chain lever"');
    expect(block).toContain('untouched 13h');
  });

  it('an UNANNOTATED pending todo still flags at 6h+ (never-started behavior unchanged)', async () => {
    mockTodos({ pending: [queuedTodo({ progressNote: null, updatedAt: new Date('2026-09-16T11:45:00.000Z') })] }); // 7h
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo');
    expect(block).toContain('untouched 7h');
  });

  it('a whitespace-only progressNote is NOT reconcile evidence — the todo still flags', async () => {
    mockTodos({ pending: [queuedTodo({ progressNote: '   ' })] });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo');
  });

  it('STALLED pull: an in_progress todo restamped 3h ago is suppressed even with NO lane runs', async () => {
    mockTodos({
      stalled: [queuedTodo({ title: 'P3 (speed lever L5): kernel autotune sweep', updatedAt: new Date('2026-09-16T15:45:00.000Z') })],
    });
    mockPrisma.agentRun.groupBy.mockResolvedValue([]); // lane never ran — pre-fix this flagged STALLED
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
    // The freshly-reconciled row is dropped BEFORE the liveness lookups.
    expect(mockPrisma.agentRun.groupBy).not.toHaveBeenCalled();
  });

  it('age-line honesty: a flagged todo reports untouched age + true creation age — never "assigned N ago"', async () => {
    mockTodos({
      pending: [queuedTodo({
        progressNote: null,
        updatedAt: new Date('2026-09-15T20:45:00.000Z'), // untouched 22h
        createdAt: new Date('2026-09-15T14:45:00.000Z'), // created 28h
      })],
    });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo');
    expect(block).toContain('untouched 22h');
    expect(block).toContain('created 28h');
    // The misstating shapes are gone:
    expect(block).not.toContain('assigned 22h ago');
    expect(block).not.toContain('still pending');
  });

  it('legacy rows without createdAt render clean — no NaN age leaks into the block', async () => {
    mockTodos({
      pending: [{ title: 'Legacy row shape', assigneeChatId: ASSIGNEE, updatedAt: new Date('2026-09-16T11:45:00.000Z') }],
    });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo "Legacy row shape"');
    expect(block).toContain('untouched 7h');
    expect(block).not.toContain('NaN');
  });
});
