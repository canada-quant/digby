/**
 * Framework tab — Goals & board SECTIONS (owner ticket, 2026-11-04).
 *
 * THE DEFECT: the panel rendered every tracked goal in ONE flat list and
 * printed each row's raw DB status verbatim. On the live ledger that made the
 * MONITOR Polk probe read as delivery work ("active") and the owner-PAUSED R&D
 * program read as a fault ("blocked") — both truthful rows, both misleading on
 * a delivery board.
 *
 * THE INVARIANT PINNED HERE: the board renders three sections —
 *   Active delivery | Paused | Monitoring —
 * classified from the ONLY classification metadata the ledger carries (the
 * explicit `PAUSED — ` / `MONITOR — ` title prefixes the supervisor stamps),
 * with paused/monitoring rows DISPLAYING 'paused' / 'monitoring' instead of
 * their raw status, and a delivery goal that merely has blocked todos staying
 * in Active delivery (blocked todos are normal delivery state, not a demotion).
 */

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// The component file imports the real API modules at module scope (browser
// axios client). Node-environment test: stub the transport so the import graph
// loads; these tests exercise the pure grouping helpers + the presentational
// core.
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
  boardSectionOf,
  boardStatusLabel,
  boardGoalNeedsAttention,
  groupBoardGoals,
  type FrameworkBoardGoal,
  type FrameworkSnapshot,
} from './FrameworkTab';

/** Rows shaped exactly like the LIVE ledger of 2026-11-04 (5 tracked goals). */
const windowsGoal: FrameworkBoardGoal = {
  goalId: 'e1e7ab69',
  title: 'Windows installer — Azure Trusted Signing (signing + shipment pending)',
  status: 'active',
  todosDone: 1,
  todosTotal: 5,
  blockedCount: 2,
};
const opensourceGoal: FrameworkBoardGoal = {
  goalId: '2ee2aa2d',
  title: 'Open-source Digby release program — public repo → free cloud → enterprise (owner-sequenced)',
  status: 'active',
  todosDone: 6,
  todosTotal: 16,
  blockedCount: 3,
};
const supervisionGoal: FrameworkBoardGoal = {
  goalId: '0e9f6460',
  title: 'Enforce fleet supervision opt-out and framework-only lock',
  status: 'active',
  todosDone: 0,
  todosTotal: 1,
  blockedCount: 0,
};
const pausedGoal: FrameworkBoardGoal = {
  goalId: 'b3f240e4',
  title: 'PAUSED — Constant framework R&D (owner pause since 2026-10-27)',
  status: 'blocked',
  todosDone: 27,
  todosTotal: 30,
  blockedCount: 2,
};
const monitorGoal: FrameworkBoardGoal = {
  goalId: '49bdc590',
  title: 'MONITOR — Polk-class search-pipeline nightly regression probe',
  status: 'active',
  todosDone: 1,
  todosTotal: 2,
  blockedCount: 0,
};

/** The archived model-pick wrapper (f87baba8) — retired, so the digest must
 *  not supply it; the board may never invent it. */
const ARCHIVED_MODEL_PICK_TITLE = 'Model-pick evidence trust';

const LIVE_GOALS = [pausedGoal, monitorGoal, windowsGoal, opensourceGoal, supervisionGoal];

const snapshot = (goals: FrameworkBoardGoal[]): FrameworkSnapshot => ({
  project: {
    id: 'p-fw',
    name: 'crossmodel',
    isFrameworkProject: true,
    isPublic: false,
    chatCount: 2,
    documentCount: 0,
    updatedAt: '2026-11-04T00:00:00.000Z',
  } as any,
  sessions: [],
  goals,
  boardSource: 'goals',
  workspace: null,
  digestGeneratedAt: null,
});

const render = (goals: FrameworkBoardGoal[]) =>
  renderToStaticMarkup(
    createElement(FrameworkSurface, {
      snapshot: snapshot(goals),
      loading: false,
      error: null,
      onOpenChat: () => {},
      onRetry: () => {},
      onSyncWorkspace: () => {},
    }),
  );

/** Slice one section's markup out of the rendered page (sections are siblings
 *  in a fixed order: active → paused → monitoring). */
function sectionHtml(html: string, key: 'active' | 'paused' | 'monitoring'): string {
  const start = html.indexOf(`data-testid="board-section-${key}"`);
  if (start === -1) return '';
  const nextKeys = (['active', 'paused', 'monitoring'] as const).filter((k) => k !== key);
  const ends = nextKeys
    .map((k) => html.indexOf(`data-testid="board-section-${k}"`))
    .filter((i) => i > start);
  return html.slice(start, ends.length ? Math.min(...ends) : html.length);
}

describe('boardSectionOf — classification from the ledger\'s own title prefixes', () => {
  it('the explicit PAUSED prefix is the paused section', () => {
    expect(boardSectionOf(pausedGoal)).toBe('paused');
  });

  it('the explicit MONITOR prefix is the monitoring section', () => {
    expect(boardSectionOf(monitorGoal)).toBe('monitoring');
  });

  it('every other goal is Active delivery — including one with blocked todos', () => {
    expect(boardSectionOf(windowsGoal)).toBe('active');
    expect(boardSectionOf(opensourceGoal)).toBe('active');
    expect(boardSectionOf(supervisionGoal)).toBe('active');
    // A blocked DB status alone never demotes a delivery goal. (Cast: the
    // helper reads ONLY the title, so its parameter is Pick<…,'title'> and a
    // literal carrying `status` would trip TS's excess-property check.)
    expect(boardSectionOf({ ...windowsGoal, status: 'blocked' } as FrameworkBoardGoal)).toBe('active');
  });

  it('classification is prefix-anchored, not a substring match anywhere in the title', () => {
    // A delivery goal whose title merely MENTIONS the word must not be
    // misfiled into Paused/Monitoring.
    expect(boardSectionOf({ title: 'Unpaused delivery: finish the roster voice work' })).toBe('active');
    expect(boardSectionOf({ title: 'Monitoring dashboards for the fleet (delivery work)' })).toBe('active');
    expect(boardSectionOf({ title: 'PAUSED-BY-DESIGN burn-down: retire legacy tree' })).toBe('paused');
  });

  it('hand-typed variants of the same prefix still classify (case / separators)', () => {
    expect(boardSectionOf({ title: 'paused - R&D research' })).toBe('paused');
    expect(boardSectionOf({ title: '  Paused–R&D' })).toBe('paused');
    expect(boardSectionOf({ title: 'Monitor: Polk probe' })).toBe('monitoring');
    expect(boardSectionOf({ title: 'monitor — nightly probe' })).toBe('monitoring');
  });
});

describe('boardStatusLabel — paused/monitoring rows never print a misleading raw status', () => {
  it('renders paused for the parked program (its DB status is blocked)', () => {
    expect(pausedGoal.status).toBe('blocked');
    expect(boardStatusLabel(pausedGoal)).toBe('paused');
  });

  it('renders monitoring for the standing probe (its DB status is active)', () => {
    expect(monitorGoal.status).toBe('active');
    expect(boardStatusLabel(monitorGoal)).toBe('monitoring');
  });

  it('delivery rows keep their real status', () => {
    expect(boardStatusLabel(windowsGoal)).toBe('active');
    expect(boardStatusLabel({ ...windowsGoal, status: 'blocked' })).toBe('blocked');
  });
});

describe('boardGoalNeedsAttention — amber only where there is something to act on', () => {
  it('a delivery goal with blocked todos needs attention', () => {
    expect(boardGoalNeedsAttention(windowsGoal)).toBe(true);
  });

  it('paused / monitoring rows never raise amber, whatever their counts', () => {
    expect(boardGoalNeedsAttention(pausedGoal)).toBe(false);
    expect(boardGoalNeedsAttention(monitorGoal)).toBe(false);
  });

  it('a clean delivery goal is not amber', () => {
    expect(boardGoalNeedsAttention(supervisionGoal)).toBe(false);
  });
});

describe('groupBoardGoals — three sections, incoming order preserved, empties dropped', () => {
  it('partitions the live ledger into the three sections with counts', () => {
    const groups = groupBoardGoals(LIVE_GOALS);
    expect(groups.map((g) => [g.key, g.heading, g.goals.length])).toEqual([
      ['active', 'Active delivery', 3],
      ['paused', 'Paused', 1],
      ['monitoring', 'Monitoring', 1],
    ]);
  });

  it('preserves the incoming row order inside a section (the digest pre-sorts)', () => {
    const groups = groupBoardGoals(LIVE_GOALS);
    const active = groups.find((g) => g.key === 'active')!;
    expect(active.goals.map((g) => g.goalId)).toEqual(['e1e7ab69', '2ee2aa2d', '0e9f6460']);
  });

  it('drops a section that holds no rows (no empty headings)', () => {
    const groups = groupBoardGoals([windowsGoal]);
    expect(groups.map((g) => g.key)).toEqual(['active']);
  });
});

describe('FrameworkSurface — the rendered board tells the truth by section', () => {
  const html = render(LIVE_GOALS);

  it('renders the three section headings, each with its count', () => {
    expect(html).toContain('Active delivery');
    expect(html).toContain('Paused');
    expect(html).toContain('Monitoring');
    expect(html).toContain('data-testid="board-sections"');
  });

  it('R&D appears ONLY under Paused, displayed as paused (never "blocked")', () => {
    // Titles are HTML-escaped in the static markup (`R&D` → `R&amp;D`).
    expect(sectionHtml(html, 'paused')).toContain('Constant framework R&amp;D');
    expect(sectionHtml(html, 'paused')).toContain('paused');
    expect(sectionHtml(html, 'paused')).not.toContain('>blocked<');
    // And nowhere else.
    expect(sectionHtml(html, 'active')).not.toContain('Constant framework R');
    expect(sectionHtml(html, 'monitoring')).not.toContain('Constant framework R');
  });

  it('Polk appears ONLY under Monitoring, displayed as monitoring (never "active")', () => {
    expect(sectionHtml(html, 'monitoring')).toContain('Polk-class search-pipeline');
    expect(sectionHtml(html, 'monitoring')).toContain('monitoring');
    expect(sectionHtml(html, 'active')).not.toContain('Polk-class search-pipeline');
    expect(sectionHtml(html, 'paused')).not.toContain('Polk-class search-pipeline');
  });

  it('the three delivery goals appear ONLY under Active delivery, blocked todos and all', () => {
    const active = sectionHtml(html, 'active');
    expect(active).toContain('Windows installer');
    expect(active).toContain('Open-source Digby release program');
    expect(active).toContain('Enforce fleet supervision opt-out');
    // Blocked TODOS are delivery state — the row stays in Active delivery and
    // still surfaces the amber blocked count.
    expect(active).toContain('2 blocked');
    expect(active).toContain('3 blocked');

    for (const other of ['paused', 'monitoring'] as const) {
      const slice = sectionHtml(html, other);
      expect(slice).not.toContain('Windows installer');
      expect(slice).not.toContain('Open-source Digby release program');
      expect(slice).not.toContain('Enforce fleet supervision opt-out');
    }
  });

  it('the archived model-pick goal (f87baba8) is absent when the digest does not supply it', () => {
    // It is NOT in the supplied rows, so the board must not invent it —
    // no section may carry it, and no f87baba8 row id may appear.
    expect(html).not.toContain(ARCHIVED_MODEL_PICK_TITLE);
    expect(html).not.toContain('f87baba8');
    for (const key of ['active', 'paused', 'monitoring'] as const) {
      expect(sectionHtml(html, key)).not.toContain(ARCHIVED_MODEL_PICK_TITLE);
    }
  });

  it('preserves the aggregate counts over ALL rows, not per section', () => {
    // 5 tracked · 19 open todos ((5-1)+(16-6)+(1-0)+(30-27)+(2-1)) · 3 goal
    // rows flagged blocked-or-carrying-blocked-todos. The aggregate formulas
    // are UNCHANGED by this fix (owner instruction: preserve all counts) —
    // only the per-row presentation is sectioned.
    expect(html).toContain('5 tracked');
    expect(html).toContain('19 open todos');
    expect(html).toContain('3 blocked');
  });

  it('a board with only delivery goals renders exactly one section', () => {
    const only = render([windowsGoal, supervisionGoal]);
    expect(only).toContain('data-testid="board-section-active"');
    expect(only).not.toContain('data-testid="board-section-paused"');
    expect(only).not.toContain('data-testid="board-section-monitoring"');
  });
});