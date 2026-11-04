/**
 * Finding C3 (2026-09-27): the project [BOARD] block PREPENDS a PREMISE
 * REVISIONS section (72h window, newest first, capped, never shrunk) so a
 * same-stack regression such as spark's 30.88→18.6 tok/s is the first thing a
 * supervisor reads; the inline premise line carries each premise's manifest;
 * a `compareTo` gap renders ONLY when both manifests match, otherwise the line
 * says why there is no like-for-like gap.
 * three (pre-C3 rendering byte-for-byte).
 *
 * Review fix (2026-09-27): every C3 addition sits INSIDE the shrink ladder —
 * the never-shrunk prepended section plus the longer goal lines pushed the hard
 * tail cut into OWNER QUESTIONS + TODOS on a realistic CanLaw board (5 goals ×
 * 8 manifested premises + 3 revisions each: 4198 chars, both sections gone)
 * while the same facts rendered whole with the policy OFF. Pins below: the cap
 * shape from the review, the rung order, the todo refill, and the invariant
 * "ON never truncates where OFF does not" over a sweep of board shapes.
 */
const mockPrisma: any = { projectGoal: { findMany: jest.fn(async () => []) }, projectTodo: { findMany: jest.fn(async () => []) }, ownerQuestion: { findMany: jest.fn(async () => []) }, crossModelProject: { findUnique: jest.fn(async () => null) } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  renderProjectBoardBlock, renderPremisesInline, renderPremiseGapsInline, renderPremiseRevisionLines,
  BOARD_BLOCK_PREFIX, BOARD_BLOCK_CAP, BOARD_MAX_PREMISE_REVISIONS, BOARD_PREMISE_REVISION_WINDOW_MS, type BoardFacts,
} from './board-digest.service';

const NOW = new Date('2026-09-27T16:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

const spark = () => ({ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: ' tok/s', manifest: 'llama-bench draft2g tg32', prevValue: 30.88, prevManifest: 'llama-bench draft2g tg32', revisedAt: hoursAgo(2) });
const canlaw = () => [
  { key: 'canlaw_cal16_task_mean_pct', value: 42.59, unit: '%', manifest: 'canlegalbench-v0.8.0/det-v2' },
  { key: 'frontier_bar_pct', value: 73.7, unit: '%', manifest: 'judged/frontier-panel', compareTo: 'canlaw_cal16_task_mean_pct' },
];

describe('renderPremiseRevisionLines', () => {
  it('names old→new, percent, time and goal for a revision inside the 72h window; newest first; capped with a +N more marker', () => {
    const lines = renderPremiseRevisionLines([{ id: uuid('g1spark'), title: 'x', status: 'active', premises: [spark()] }], NOW);
    expect(lines[0]).toMatch(/^PREMISE REVISIONS \(last 72h/);
    expect(lines[1]).toBe('- goal g1spark0 premise draft2g_tg32_mean_tps revised 30.88→18.6 tok/s (-40%) at 09-27 14:00Z [llama-bench draft2g tg32]');
    const many = Array.from({ length: BOARD_MAX_PREMISE_REVISIONS + 2 }, (_, i) => ({ key: `k${i}`, value: 10 + i, prevValue: 20, revisedAt: hoursAgo(i + 1) }));
    const capped = renderPremiseRevisionLines([{ id: uuid('g2many'), title: 'y', status: 'active', premises: many }], NOW);
    expect(capped).toHaveLength(1 + BOARD_MAX_PREMISE_REVISIONS + 1);
    expect(capped[1]).toContain('premise k0 revised'); // newest first
    expect(capped[capped.length - 1]).toBe('- +2 more revised (use goal_get)');
  });
  it('a manifest change on the move says "not like-for-like"; an old revision, a future-dated stamp or a premise with no prevValue renders nothing', () => {
    const moved = { ...spark(), manifest: 'llama-bench draft2g tg64' };
    expect(renderPremiseRevisionLines([{ id: uuid('g1'), title: 'x', status: 'active', premises: [moved] }], NOW)[1]).toContain('— manifest llama-bench draft2g tg32→llama-bench draft2g tg64, not like-for-like');
    expect(renderPremiseRevisionLines([{ id: uuid('g1'), title: 'x', status: 'active', premises: [{ ...spark(), revisedAt: new Date(NOW.getTime() - BOARD_PREMISE_REVISION_WINDOW_MS - 1000).toISOString() }] }], NOW)).toEqual([]);
    expect(renderPremiseRevisionLines([{ id: uuid('g1'), title: 'x', status: 'active', premises: [{ ...spark(), revisedAt: new Date(NOW.getTime() + 3600_000).toISOString() }] }], NOW)).toEqual([]);
    expect(renderPremiseRevisionLines([{ id: uuid('g1'), title: 'x', status: 'active', premises: [{ key: 'k', value: 1 }] }], NOW)).toEqual([]);
    expect(renderPremiseRevisionLines([{ id: uuid('g1'), title: 'x', status: 'active', premises: 'garbage' }], NOW)).toEqual([]);
  });
});

describe('renderPremisesInline — manifest tag + like-for-like gaps', () => {
  it('renders the manifest beside the value and a gap only when both manifests match', () => {
    expect(renderPremisesInline([{ key: 'suite_mean', value: 42.59, unit: '%', manifest: 'canlegalbench-v0.8.0/det-v2' }])).toBe(' · premises: suite_mean=42.59% [canlegalbench-v0.8.0/det-v2]');
    // CanLaw: judged bar vs det-v2 score ⇒ NOT like-for-like, and the line says why
    expect(renderPremisesInline(canlaw())).toBe(' · premises: canlaw_cal16_task_mean_pct=42.59% [canlegalbench-v0.8.0/det-v2]; frontier_bar_pct=73.7% [judged/frontier-panel] · no like-for-like gap frontier_bar_pct vs canlaw_cal16_task_mean_pct (judged/frontier-panel vs canlegalbench-v0.8.0/det-v2)');
    const same = canlaw().map((p) => ({ ...p, manifest: 'canlegalbench-v0.8.0/det-v2' }));
    expect(renderPremiseGapsInline(same)).toBe(' · gap frontier_bar_pct-canlaw_cal16_task_mean_pct=+31.11% (like-for-like: canlegalbench-v0.8.0/det-v2)');
    const unset = canlaw().map((p) => (p.key === 'frontier_bar_pct' ? { ...p, manifest: undefined } : p));
    expect(renderPremiseGapsInline(unset)).toBe(' · no like-for-like gap frontier_bar_pct vs canlaw_cal16_task_mean_pct (manifest unset on frontier_bar_pct)');
    // compareTo naming a key that is not on the goal renders nothing
    expect(renderPremiseGapsInline([{ key: 'a', value: 1, manifest: 'm', compareTo: 'missing' }])).toBe('');
    expect(renderPremiseGapsInline(undefined)).toBe('');
  });
  it('pre-C3 rendering is unchanged for premises without a manifest', () => {
    expect(renderPremisesInline([{ key: 'untrained-base', value: 60.07, unit: '%' }])).toBe(' · premises: untrained-base=60.07%');
    expect(renderPremisesInline([{ key: 'rate', value: 28, unit: ' tok/s', drift: 'drift', observed: 22 }])).toBe(' · premises: rate=28 tok/s ⚠ source now reads 22 tok/s');
  });
});

describe('renderProjectBoardBlock — PREMISE REVISIONS prepended under the header', () => {
  const facts = (): BoardFacts => ({
    projectName: 'spark-cluster', now: NOW,
    goals: [
      { id: uuid('g1spark'), title: 'Ship draft2g at parity', status: 'active', premises: [spark()] },
      { id: uuid('g2canlaw'), title: 'Beat the frontier bar', status: 'active', premises: canlaw() },
    ],
    todos: [], ownerQuestions: [],
  });
  it('the revision line sits right after the [BOARD header and before GOALS; the goal line carries manifests + the no-gap note', () => {
    const block = renderProjectBoardBlock(facts());
    const lines = block.split('\n');
    expect(lines[0].startsWith(`${BOARD_BLOCK_PREFIX} — the live ledger for "spark-cluster"`)).toBe(true);
    expect(lines[1]).toMatch(/^PREMISE REVISIONS \(last 72h/);
    expect(lines[2]).toBe('- goal g1spark0 premise draft2g_tg32_mean_tps revised 30.88→18.6 tok/s (-40%) at 09-27 14:00Z [llama-bench draft2g tg32]');
    expect(lines[3]).toBe('GOALS: 2 active/blocked · 0 done · 0 archived · ranked by [priority · score], P1 highest'); // GOAL-PRIORITY-SPEND
    // GOAL-UNPLANNED (2026-10-20): the todo counts + UNPLANNED tag ride before the premises (no todos in this fixture).
    expect(block).toContain('- [P2 · 60] goal g2canlaw [active] "Beat the frontier bar" · todos 0 open/0 done · UNPLANNED · premises: canlaw_cal16_task_mean_pct=42.59% [canlegalbench-v0.8.0/det-v2]; frontier_bar_pct=73.7% [judged/frontier-panel] · no like-for-like gap frontier_bar_pct vs canlaw_cal16_task_mean_pct');
  });
});

describe('review fix — renderPremiseRevisionLines(cap) and renderPremisesInline(detail) rungs', () => {
  const goals = () => [{ id: uuid('g2many'), title: 'y', status: 'active', premises: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, value: 10 + i, prevValue: 20, revisedAt: hoursAgo(i + 1) })) }];
  it('cap 3 keeps three lines + the "+N more revised" marker; cap 1 keeps one; cap 0 collapses to ONE count line; a cap above 6 clamps', () => {
    expect(renderPremiseRevisionLines(goals(), NOW, 3)).toHaveLength(1 + 3 + 1);
    expect(renderPremiseRevisionLines(goals(), NOW, 3)[4]).toBe('- +6 more revised (use goal_get)');
    expect(renderPremiseRevisionLines(goals(), NOW, 1)).toEqual([expect.stringMatching(/^PREMISE REVISIONS \(last 72h/), expect.stringContaining('premise k0 revised 20→10'), '- +8 more revised (use goal_get)']);
    expect(renderPremiseRevisionLines(goals(), NOW, 0)).toEqual(['PREMISE REVISIONS (last 72h): 9 premise value(s) moved beyond tolerance — board at capacity; goal_get names old→new, say why each moved.']);
    expect(renderPremiseRevisionLines(goals(), NOW, 99)).toEqual(renderPremiseRevisionLines(goals(), NOW));
    expect(renderPremiseRevisionLines([], NOW, 0)).toEqual([]);
  });
  it('detail {gaps:false} drops only the gap phrase; {manifests:false} renders the pre-C3 line', () => {
    const same = canlaw().map((p) => ({ ...p, manifest: 'canlegalbench-v0.8.0/det-v2' }));
    expect(renderPremisesInline(same, { gaps: false })).toBe(' · premises: canlaw_cal16_task_mean_pct=42.59% [canlegalbench-v0.8.0/det-v2]; frontier_bar_pct=73.7% [canlegalbench-v0.8.0/det-v2]');
    expect(renderPremisesInline(same, { manifests: false })).toBe(' · premises: canlaw_cal16_task_mean_pct=42.59%; frontier_bar_pct=73.7% · gap frontier_bar_pct-canlaw_cal16_task_mean_pct=+31.11% (like-for-like: canlegalbench-v0.8.0/det-v2)');
    expect(renderPremisesInline(same, { gaps: false, manifests: false })).toBe(' · premises: canlaw_cal16_task_mean_pct=42.59%; frontier_bar_pct=73.7%');
    expect(renderPremisesInline(same, {})).toBe(renderPremisesInline(same));
  });
});

describe('review fix — the C3 additions live INSIDE the shrink ladder; OWNER QUESTIONS are never cut', () => {
  // The review's shape: N active goals × 8 manifested premises (≤40 chars) with 2 compareTo bars each,
  // 3 revisions per goal, 12 open todos, 3 open owner questions. Pre-fix: goals=5 ⇒ 4198 chars,
  // truncated, 'OWNER QUESTIONS:' and 'TODOS:' absent; OFF ⇒ 3159 chars, everything present.
  const capFacts = (goalsN: number, opts: { todos?: number; oq?: number; blocked?: boolean; premises?: number; revisions?: number } = {}): BoardFacts => {
    const { todos = 12, oq = 3, blocked = false, premises = 8, revisions = 3 } = opts;
    return {
      projectName: 'CanLaw', now: NOW,
      goals: Array.from({ length: goalsN }, (_, gi) => ({
        id: uuid(`g${gi}`), title: `Goal ${gi}: beat the frontier bar on the det-v2 suite and hold the cal16 slice`, status: blocked ? 'blocked' : 'active',
        ...(blocked ? { blockKind: 'external', blockedReason: 'A long block reason that pads the goal line toward the cap so the ladder has to run for real on this board' } : {}),
        premises: Array.from({ length: premises }, (_, pi) => ({
          key: `metric_${gi}_${pi}_pct`, value: 40 + pi + gi / 10, unit: '%', manifest: pi % 2 ? 'canlegalbench-v0.8.0/det-v2' : 'judged/frontier-panel-2026-09',
          ...(pi < 2 ? { compareTo: `metric_${gi}_${pi + 2}_pct` } : {}),
          ...(pi < revisions ? { prevValue: 60 + pi, revisedAt: hoursAgo(gi * 3 + pi + 1) } : {}),
        })),
      })),
      todos: Array.from({ length: todos }, (_, i) => ({ id: uuid(`t${i}`), title: `Todo ${i}: rerun the cal16 slice with the det-v2 scorer and file the delta`, status: 'pending', assigneeChatId: uuid(`lane${i}`), assigneeTitle: `lane ${i}`, updatedAt: hoursAgo(i + 1) })),
      ownerQuestions: Array.from({ length: oq }, (_, i) => ({ id: `oq_${String(i).padStart(8, 'a')}-0000-4000-8000-000000000000`, status: 'open', createdAt: hoursAgo(i + 2), question: `Owner question ${i}: approve the v0.8.${i} publish?` })),
    };
  };
  const oqIds = (block: string) => (block.match(/^- oq_[0-9a-f]{8} OPEN/gm) ?? []).sort();
  const todoCount = (block: string) => (block.match(/^- todo /gm) ?? []).length;

  it.each([5, 6, 8, 12])('%d goals (the review shape): every open owner question survives, the block ends without [truncated], the revisions section is still there', (n) => {
    const block = renderProjectBoardBlock(capFacts(n));
    expect(block.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
    expect(block).not.toContain('[truncated]');
    expect(block).toContain('OWNER QUESTIONS:');
    expect(block).toContain('TODOS: 12 open');
    expect(oqIds(block)).toHaveLength(3);
    expect(block.indexOf('OWNER QUESTIONS:')).toBeLessThan(block.indexOf('TODOS:'));
    expect(block).toMatch(/^PREMISE REVISIONS \(last 72h/m);
    expect(block.split('\n')[1]).toMatch(/^PREMISE REVISIONS/); // still prepended right under the header
  });

  it('rung order: gap phrases first (manifests + all 12 todos stay), then todos, then revisions 6→3→1, then manifest tags — and a freed rung refills todos', () => {
    // 3 goals: the pre-fix ladder shrank todos 12 → 4 here; now only the gap phrases go.
    const three = renderProjectBoardBlock(capFacts(3));
    expect(three).not.toContain('like-for-like');
    expect(three).toContain('[canlegalbench-v0.8.0/det-v2]');
    expect(todoCount(three)).toBe(12);
    expect((three.match(/^- goal [0-9a-z]{8} premise .* revised /gm) ?? []).length).toBe(BOARD_MAX_PREMISE_REVISIONS);
    expect(three).toContain('- +3 more revised (use goal_get)'); // 3 × 3 = 9 revisions, 6 shown
    // 12 goals: revisions down to ONE line (+ marker), manifest tags gone, no goal cut, todos refilled to 4 (+ marker).
    const twelve = renderProjectBoardBlock(capFacts(12));
    expect(twelve).not.toContain('[canlegalbench');
    expect(twelve).not.toContain('like-for-like');
    expect((twelve.match(/^- goal [0-9a-z]{8} premise .* revised /gm) ?? []).length).toBe(1);
    expect(twelve).toContain('- +35 more revised (use goal_get)'); // 12 × 3 = 36 revisions, 1 shown
    expect(twelve).not.toContain('board at capacity');
    expect(twelve).not.toContain('more (use goal_list)');
    expect((twelve.match(/^- goal [0-9a-z]{8} \[active\]/gm) ?? []).length).toBe(12);
    expect(todoCount(twelve)).toBe(4);
    expect(twelve).toContain('- …8 more open todos (use todo_list)');
    expect(twelve.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
  });

  it('invariant over a sweep of board shapes: every block stays within cap, keeps every open owner question, and never cuts a goal it can fit', () => {
    let checked = 0;
    for (const goals of [1, 3, 5, 8, 12]) for (const todos of [0, 12, 40]) for (const oq of [0, 3, 8]) for (const blocked of [false, true]) for (const revisions of [0, 3, 8]) {
      const facts = capFacts(goals, { todos, oq, blocked, revisions });
      const block = renderProjectBoardBlock(facts);
      checked++;
      expect(block.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
      expect(block).not.toContain('[truncated]');
      expect(oqIds(block)).toHaveLength(oq);
      expect(block).toContain('OWNER QUESTIONS:');
      expect(block).toContain('TODOS:');
      if (revisions > 0 && goals > 0) expect(block).toMatch(/PREMISE REVISIONS/);
      if (revisions === 0) expect(block).not.toMatch(/PREMISE REVISIONS/);
    }
    expect(checked).toBe(5 * 3 * 3 * 2 * 3);
  });

  it('a 60-todo board still shrinks todos first and never cuts owner questions', () => {
    const facts = capFacts(2, { todos: 60, oq: 1 });
    const block = renderProjectBoardBlock(facts);
    expect(block).toContain('more open todos (use todo_list)');
    expect(oqIds(block)).toHaveLength(1);
  });
});
