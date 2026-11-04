/**
 * Framework tab — Goals & board provenance pins (ticket 2162c692).
 *
 * THE DEFECT (owner-reported 2026-11-02): Management → Framework rendered
 * "No active or blocked goals on the board right now." while the SAME page's
 * Chats & lanes panel listed lanes with "goal: SAA-1 rollout … 2 open todos".
 * The board's ONLY data source was `digest?.goalProgress ?? []`, and the
 * hourly project-digest sweep never creates a bucket for the framework
 * project (every chat filed in it is a hidden fleet artifact, so all three
 * exclusion filters drop it, and the ghost-row cleanup then deletes any row
 * it once had). A null digest therefore collapsed into an empty array — and
 * an empty array is indistinguishable from "this project has no goals".
 *
 * THE INVARIANT PINNED HERE: the empty-goals sentence may be rendered ONLY
 * when a digest row carrying `goalProgress` was actually read. A null digest
 * with no successful fallback read must say "board data unavailable", and a
 * null digest with a successful goals read must show those goals.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// The component file imports the real API modules at module scope (browser
// axios client). Node-environment test: stub the transport so the import graph
// loads; these tests exercise the pure resolver + the presentational core.
vi.mock('@/lib/api-client', () => ({
  default: {
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  FrameworkSurface,
  resolveFrameworkBoard,
  boardGoalFromGoal,
  type FrameworkSnapshot,
} from './FrameworkTab';

const TAB = readFileSync(new URL('./FrameworkTab.tsx', import.meta.url), 'utf8');

const EMPTY_COPY = 'No active or blocked goals on the board right now.';
const UNAVAILABLE_COPY = 'Board data unavailable right now.';

const digestRow = (goalProgress?: any) => ({
  projectId: 'p-fw',
  projectName: 'crossmodel',
  status: 'on_track',
  summary: 'ok',
  attentionItems: [],
  stats: {} as any,
  generatedAt: '2026-11-02T19:00:00.000Z',
  updatedAt: '2026-11-02T19:00:00.000Z',
  ...(goalProgress === undefined ? {} : { goalProgress }),
});

const digestGoal = (over: Record<string, unknown> = {}) => ({
  goalId: 'g1',
  title: 'Framework hardening',
  status: 'active',
  todosDone: 3,
  todosTotal: 5,
  blockedCount: 1,
  completed24h: 1,
  completed7d: 3,
  eta: { remaining: 2, pacePerDay: 1.5, etaDays: 1.3, class: 'on_pace' },
  ...over,
});

/** A platform-API goal row (what the fallback read returns). */
const apiGoal = (over: Record<string, unknown> = {}) => ({
  id: 'g-saa1',
  projectId: 'p-fw',
  title: 'SAA-1 rollout',
  description: '',
  status: 'active',
  blockedReason: null,
  createdByChatId: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  todos: [
    { id: 't1', title: 'phase 0', status: 'done' },
    { id: 't2', title: 'phase 1', status: 'in_progress' },
    { id: 't3', title: 'phase 2', status: 'blocked' },
  ],
  dependsOnGoalIds: [],
  dependentGoalIds: [],
  ...over,
});

const snapshot = (over: Partial<FrameworkSnapshot> = {}): FrameworkSnapshot => ({
  project: {
    id: 'p-fw',
    name: 'crossmodel',
    isFrameworkProject: true,
    isPublic: false,
    chatCount: 2,
    documentCount: 0,
    updatedAt: '2026-11-02T00:00:00.000Z',
  } as any,
  sessions: [],
  goals: [],
  boardSource: 'digest',
  workspace: null,
  digestGeneratedAt: null,
  ...over,
});

const render = (snap: FrameworkSnapshot) =>
  renderToStaticMarkup(
    createElement(FrameworkSurface, {
      snapshot: snap,
      loading: false,
      error: null,
      onOpenChat: () => {},
      onRetry: () => {},
      onSyncWorkspace: () => {},
    }),
  );

describe('resolveFrameworkBoard — provenance (ticket 2162c692)', () => {
  it('a digest row WITH goalProgress is the preferred source (real pace/ETA kept)', () => {
    const board = resolveFrameworkBoard({ digest: digestRow([digestGoal()]) as any, fallback: null });
    expect(board.boardSource).toBe('digest');
    expect(board.goals).toHaveLength(1);
    expect(board.goals[0].title).toBe('Framework hardening');
    expect(board.goals[0].eta?.etaDays).toBe(1.3);
    expect(board.digestGeneratedAt).toBe('2026-11-02T19:00:00.000Z');
  });

  it('a MISSING digest row falls back to the live goals read instead of reporting zero goals', () => {
    const board = resolveFrameworkBoard({
      digest: null,
      fallback: { active: [apiGoal() as any], blocked: [] },
    });
    expect(board.boardSource).toBe('goals');
    expect(board.goals.map((g) => g.title)).toEqual(['SAA-1 rollout']);
    // No digest row was read → no digest timestamp may be claimed.
    expect(board.digestGeneratedAt).toBeNull();
  });

  it('a digest row without goalProgress (old-backend skew) is NOT read as "zero goals"', () => {
    const board = resolveFrameworkBoard({ digest: digestRow() as any, fallback: { active: [apiGoal() as any], blocked: [] } });
    expect(board.boardSource).toBe('goals');
    expect(board.goals).toHaveLength(1);
  });

  it('neither source answering yields "unavailable", never an empty board', () => {
    const board = resolveFrameworkBoard({ digest: null, fallback: null });
    expect(board.boardSource).toBe('unavailable');
    expect(board.goals).toEqual([]);
    expect(board.digestGeneratedAt).toBeNull();
  });

  it('a genuinely empty digest board stays source "digest" (the honest empty case)', () => {
    const board = resolveFrameworkBoard({ digest: digestRow([]) as any, fallback: { active: [], blocked: [] } });
    expect(board.boardSource).toBe('digest');
    expect(board.goals).toEqual([]);
  });

  it('the goals fallback derives todo counts from the embedded summaries', () => {
    const row = boardGoalFromGoal(apiGoal() as any);
    expect(row).toMatchObject({ goalId: 'g-saa1', todosDone: 1, todosTotal: 3, blockedCount: 1 });
    // The platform goals API has no completion history — no ETA may be invented.
    expect(row.eta).toBeUndefined();
  });

  it('DROPPED todos leave the bar, matching the digest sweep (review finding 1)', () => {
    // project-digest.service.ts counts `status !== 'dropped'`; counting a
    // dropped todo as open would put a phantom open-todo on the board and
    // disagree with the digest for the same goal.
    const row = boardGoalFromGoal(
      apiGoal({
        todos: [
          { id: 't1', title: 'a', status: 'done' },
          { id: 't2', title: 'b', status: 'done' },
          { id: 't3', title: 'c', status: 'dropped' },
        ],
      }) as any,
    );
    expect(row).toMatchObject({ todosDone: 2, todosTotal: 2, blockedCount: 0 });
    // No phantom open todo for the dropped row: 2 - 2 === 0.
    expect(row.todosTotal - row.todosDone).toBe(0);
  });
});

describe('FrameworkSurface — the empty-goals sentence is never a lie (ticket 2162c692)', () => {
  it('the null-digest-with-goals path renders the goals, NOT the empty sentence', () => {
    const html = render(snapshot({ boardSource: 'goals', goals: [boardGoalFromGoal(apiGoal() as any)] }));
    expect(html).toContain('SAA-1 rollout');
    expect(html).toContain('1/3 todos done');
    expect(html).toContain('1 blocked');
    expect(html).toContain('live goals');
    // THE REGRESSION: the pre-fix tab rendered this over the very goals the
    // lanes panel was listing.
    expect(html).not.toContain(EMPTY_COPY);
  });

  it('board data unavailable renders its own state and never the empty sentence', () => {
    const html = render(snapshot({ boardSource: 'unavailable', goals: [] }));
    expect(html).toContain(UNAVAILABLE_COPY);
    expect(html).toContain('NOT an empty board');
    expect(html).not.toContain(EMPTY_COPY);
  });

  it('a digest row that was read and holds zero goals still says the empty sentence', () => {
    const html = render(snapshot({ boardSource: 'digest', goals: [], digestGeneratedAt: '2026-11-02T19:00:00.000Z' }));
    expect(html).toContain(EMPTY_COPY);
    expect(html).not.toContain(UNAVAILABLE_COPY);
  });
});

describe('FrameworkTab source pins — the collapsed `?? []` may not come back', () => {
  it('the board no longer reads `digest?.goalProgress ?? []` into snapshot.goals', () => {
    expect(TAB).not.toContain('digest?.goalProgress ?? []');
    expect(TAB).not.toContain('goals: digest?.goalProgress');
    expect(TAB).toContain('resolveFrameworkBoard({ digest, fallback: settled })');
    // The digest is still preferred when it actually carries goal rows.
    expect(TAB).toContain('const settled = digest?.goalProgress');
  });

  it('the container reads the project-scoped goals lists as the fallback', () => {
    expect(TAB).toContain('platformFleetApi.listGoals(project.id, { status: \'active\' })');
    expect(TAB).toContain('platformFleetApi.listGoals(project.id, { status: \'blocked\' })');
  });

  it('each fallback leg settles ALONE so one failed read cannot hide the other', () => {
    // Review finding 2: a shared `.catch` on the Promise.all discarded a
    // successful 'active' read whenever the 'blocked' leg 400s (older backend
    // rejects the status param) — a half-read board became 'unavailable'.
    expect(TAB).toMatch(/status: 'active' \}\)\.catch\(\(\) => null\)/);
    expect(TAB).toMatch(/status: 'blocked' \}\)\.catch\(\(\) => null\)/);
    expect(TAB).toContain('active === null && blocked === null ? null :');
  });

  it('a leg that failed degrades to that leg only, and both failing is what yields unavailable', () => {
    // Mirror of the container's combine step: one leg surviving still renders.
    const combine = (active: any[] | null, blocked: any[] | null) =>
      active === null && blocked === null ? null : { active: active ?? [], blocked: blocked ?? [] };
    expect(combine([apiGoal() as any], null)).toEqual({ active: [apiGoal()], blocked: [] });
    expect(combine(null, null)).toBeNull();
    // And the board from a half-read is 'goals', never 'unavailable'.
    const board = resolveFrameworkBoard({ digest: null, fallback: combine([apiGoal() as any], null) as any });
    expect(board.boardSource).toBe('goals');
    expect(board.goals.map((g) => g.title)).toEqual(['SAA-1 rollout']);
  });

  it('the canonical empty sentence has exactly one render site, gated on the unavailable branch first', () => {
    const occurrences = TAB.split(EMPTY_COPY).length - 1;
    expect(occurrences).toBe(1);
    const idxUnavailable = TAB.indexOf(UNAVAILABLE_COPY);
    const idxEmpty = TAB.indexOf(EMPTY_COPY);
    expect(idxUnavailable).toBeGreaterThan(-1);
    expect(idxUnavailable).toBeLessThan(idxEmpty);
  });

  it('the tab stays a READ-ONLY surface (no rename/move/delete/share affordances added)', () => {
    const calls = [...TAB.matchAll(/projectsApi\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(['getWorkspace', 'list', 'sessions', 'syncWorkspace']);
    const platformCalls = [...TAB.matchAll(/platformFleetApi\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
    expect([...new Set(platformCalls)].sort()).toEqual(['listGoals']);
  });
});