/**
 * BOARD — GOAL-UNPLANNED (architecture review #6 part 2) + GOAL-OUTCOME-UNMET
 * part 2's board half (2026-10-20).
 *  - every tracked goal line carries '· todos <open> open/<done> done' (dropped
 *    rows leave the bar) and an ACTIVE goal with zero open todos is tagged
 *    UNPLANNED (a held / blocked goal is not);
 *  - the new text shrinks FIRST: counts, then the per-line tags fold into ONE
 *    GOALS-header count, which goes only at the last rung — the fully shrunk
 *    rendering equals the kill-switched one;
 *  - GOAL_UNPLANNED_SIGNAL_DISABLED=1 renders the pre-change board byte-for-byte;
 *  - a done goal older than the suspect window whose outcome-unmet close is
 *    still live (`outcomeLive`) stays on the suspect lines.
 */
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { renderProjectBoardBlock, suspectDoneGoals, BOARD_BLOCK_CAP, BOARD_SUSPECT_DONE_WINDOW_MS, type BoardFacts } from './board-digest.service';
import { isUnplannedGoal, renderGoalUnplannedWake } from './goal-unplanned';

const NOW = new Date('2026-10-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  projectName: 'tt-rd',
  now: NOW,
  goals: [
    { id: uuid('gplanned'), title: 'Serve Qwen on QB2', status: 'active' },
    { id: uuid('gunplan0'), title: 'Hit 10 tok/s client-visible', status: 'active' },
    { id: uuid('gheld000'), title: 'Redeploy :3001', status: 'active', progressNote: 'HOLD until the owner rules on the box' },
    { id: uuid('gblocked'), title: 'Vendor firmware', status: 'blocked', blockKind: 'external', blockedReason: 'Waiting on the vendor' },
  ],
  todos: [
    { id: uuid('t1'), goalId: uuid('gplanned'), title: 'Bench paged-KV', status: 'in_progress', updatedAt: hoursAgo(1) },
    { id: uuid('t2'), goalId: uuid('gplanned'), title: 'Ship it', status: 'done', updatedAt: hoursAgo(30) },
    { id: uuid('t3'), goalId: uuid('gunplan0'), title: 'Adopt lever A', status: 'done', updatedAt: hoursAgo(30) },
    { id: uuid('t4'), goalId: uuid('gunplan0'), title: 'Adopt lever B', status: 'dropped', updatedAt: hoursAgo(30) },
  ],
  ownerQuestions: [],
  ...over,
});

beforeEach(() => {
  delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED;
  delete process.env.GOAL_OUTCOME_CHECK_DISABLED;
});

describe('goal lines — todo counts + UNPLANNED', () => {
  it('counts per goal (dropped excluded); only the ACTIVE, un-held goal with zero open todos is UNPLANNED', () => {
    const block = renderProjectBoardBlock(facts());
    // GOAL-PRIORITY-SPEND (2026-10-20): every tracked goal line leads with its rank (unset = P2 · 60 here).
    expect(block).toContain('- [P2 · 60] goal gplanned [active] "Serve Qwen on QB2" · todos 1 open/1 done\n');
    expect(block).toContain('- [P2 · 60] goal gunplan0 [active] "Hit 10 tok/s client-visible" · todos 0 open/1 done · UNPLANNED\n');
    expect(block).toContain('- [P2 · 60] goal gheld000 [active] "Redeploy :3001" · todos 0 open/0 done\n'); // held on purpose
    expect(block).toContain('- [P2 · 60] goal gblocked [blocked] "Vendor firmware" — blocked (external): Waiting on the vendor · todos 0 open/0 done\n');
    expect(block.match(/UNPLANNED/g)?.length).toBe(1);
  });

  it('kill switch GOAL_UNPLANNED_SIGNAL_DISABLED=1: the pre-change lines byte-for-byte', () => {
    const on = renderProjectBoardBlock(facts());
    process.env.GOAL_UNPLANNED_SIGNAL_DISABLED = '1';
    const off = renderProjectBoardBlock(facts());
    expect(off).not.toContain('todos 1 open');
    expect(off).not.toContain('UNPLANNED');
    expect(off).toContain('- [P2 · 60] goal gunplan0 [active] "Hit 10 tok/s client-visible"\n');
    expect(on.replace(/ · todos \d+ open\/\d+ done/g, '').replace(/ · UNPLANNED/g, '')).toBe(off);
  });

  // 12 goals (6 with todos, 6 UNPLANNED) + 20 long todo lines; `pad` lengthens the goal titles to move the board toward the cap.
  const pressure = (pad: number): BoardFacts => {
    const goals = Array.from({ length: 12 }, (_, i) => ({ id: uuid(`g${String(i).padStart(3, '0')}x`), title: `Goal number ${i} ${'g'.repeat(pad)}`, status: 'active' }));
    const todos = Array.from({ length: 20 }, (_, i) => ({ id: uuid(`t${String(i).padStart(3, '0')}x`), goalId: goals[i % 6].id, title: `Todo ${i} ${'y'.repeat(70)}`, status: 'pending', updatedAt: hoursAgo(i + 1) }));
    return facts({ goals, todos });
  };
  const both = (pad: number): { on: string; off: string } => {
    process.env.GOAL_UNPLANNED_SIGNAL_DISABLED = '1';
    const off = renderProjectBoardBlock(pressure(pad));
    delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED;
    return { on: renderProjectBoardBlock(pressure(pad)), off };
  };
  const todoLines = (b: string) => b.split('\n').filter((l) => l.startsWith('- todo ')).length;

  it('the new text shrinks FIRST, before any older rung: (0a) counts → (0b) tags fold into ONE header count → (0c) gone', () => {
    const roomy = both(20); // fits with everything
    expect(roomy.on).toContain('· todos 4 open/0 done');
    expect(roomy.on.match(/ · UNPLANNED\n/g)?.length).toBe(6);

    const a = both(30); // (0a): the counts go, the tags stay, every todo line stays
    expect(a.on).not.toContain('· todos ');
    expect(a.on.match(/ · UNPLANNED\n/g)?.length).toBe(6);
    expect(todoLines(a.on)).toBe(todoLines(a.off));

    const b = both(49); // (0b): the per-line tags fold into the GOALS header
    expect(b.on).not.toContain(' · UNPLANNED\n');
    expect(b.on).toContain('GOALS: 12 active/blocked · 0 done · 0 archived · 6 UNPLANNED (no open todos)');
    expect(todoLines(b.on)).toBe(todoLines(b.off));

    const c = both(51); // (0c): even the header count goes — ON is byte-identical to OFF and never cuts a todo OFF keeps
    expect(c.on).toBe(c.off);
    for (const pad of [20, 30, 40, 46, 48, 49, 50, 51, 52, 54, 60]) {
      const r = both(pad);
      expect(r.on.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
      expect(todoLines(r.on)).toBe(todoLines(r.off));
    }
  });

  it('a pathological board: after every rung the ON rendering equals the kill-switched rendering', () => {
    const goals = Array.from({ length: 12 }, (_, i) => ({ id: uuid(`h${String(i).padStart(3, '0')}x`), title: `Goal ${i} ${'z'.repeat(70)}`, status: 'active', premises: [{ key: `k${i}_${'p'.repeat(20)}`, value: i, unit: 'u' }] }));
    const todos = Array.from({ length: 40 }, (_, i) => ({ id: uuid(`u${String(i).padStart(3, '0')}x`), goalId: null, title: `Todo ${i} ${'w'.repeat(70)}`, status: 'pending', blockedReason: null, updatedAt: hoursAgo(i + 1) }));
    const ownerQuestions = Array.from({ length: 8 }, (_, i) => ({ id: `oq_${String(i).padStart(8, '0')}`, status: 'open', createdAt: hoursAgo(i + 1), question: `Question ${i} ${'q'.repeat(80)}` }));
    process.env.GOAL_UNPLANNED_SIGNAL_DISABLED = '1';
    const off = renderProjectBoardBlock(facts({ goals, todos, ownerQuestions }));
    delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED;
    const on = renderProjectBoardBlock(facts({ goals, todos, ownerQuestions }));
    expect(on.endsWith('…[truncated]')).toBe(off.endsWith('…[truncated]'));
    expect(on.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
    expect(on).toContain('OWNER QUESTIONS:');
  });
});

describe('GOAL-OUTCOME-UNMET — an older live outcome-unmet close stays badged', () => {
  const KPI = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, history: [{ value: 3.44 }] };
  const old = { id: uuid('gold0000'), title: 'Qwen ≥10 tok/s', status: 'done', premises: [KPI], updatedAt: new Date(NOW.getTime() - BOARD_SUSPECT_DONE_WINDOW_MS - 3 * 86_400_000) };

  it('outside the 7-day window only when the loader marked it outcomeLive; the badge names the KPI miss', () => {
    expect(suspectDoneGoals([old], NOW.getTime())).toEqual([]);
    const s = suspectDoneGoals([{ ...old, outcomeLive: true }], NOW.getTime());
    expect(s).toHaveLength(1);
    expect(s[0].badge).toBe('⚠ suspect: kpi_bar_unmet (kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10)');
    const block = renderProjectBoardBlock(facts({ goals: [{ ...old, outcomeLive: true }], todos: [] }));
    expect(block).toContain('GOALS: 0 active/blocked · 1 done (1 ⚠ suspect) · 0 archived');
    expect(block).toContain('- goal gold0000 [done ⚠ suspect: kpi_bar_unmet (kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10)] "Qwen ≥10 tok/s"');
  });

  it('within the window a KPI-unmet close badges by itself (a board reason)', () => {
    const recent = { ...old, updatedAt: hoursAgo(5) };
    expect(suspectDoneGoals([recent], NOW.getTime())[0].badge).toContain('kpi_bar_unmet');
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    expect(suspectDoneGoals([recent], NOW.getTime())).toEqual([]);
  });
});

describe('goal-unplanned.ts pure helpers', () => {
  it('isUnplannedGoal: active + zero open + not held', () => {
    expect(isUnplannedGoal({ status: 'active' }, 0)).toBe(true);
    expect(isUnplannedGoal({ status: 'active' }, 1)).toBe(false);
    expect(isUnplannedGoal({ status: 'blocked' }, 0)).toBe(false);
    expect(isUnplannedGoal({ status: 'done' }, 0)).toBe(false);
    expect(isUnplannedGoal({ status: 'active', progressNote: 'on hold — waiting for the owner' }, 0)).toBe(false);
    expect(isUnplannedGoal({ status: 'active', progressNote: 'holding steady at 5 tok/s' }, 0)).toBe(true);
  });

  it('the wake text follows the design', () => {
    const w = renderGoalUnplannedWake({ goalId: 'abcdef12-0000-4000-8000-000000000000', title: 'Hit 10 tok/s', doneTodos: 3, droppedTodos: 1, now: NOW });
    expect(w.startsWith('[GOAL UNPLANNED] goal "Hit 10 tok/s" (abcdef12): no open todos (3 done, 1 dropped). Create the next todo (with budget + criterion), close with evidence, or block with a kind + reason.')).toBe(true);
    expect(w).toContain('no lane chartered to it ran in the last 6 h');
  });
});
