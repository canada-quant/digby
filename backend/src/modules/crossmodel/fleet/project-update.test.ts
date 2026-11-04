/**
 * Project update (owner 2026-09-29, the digby-benchmarks recording): the
 * at-a-glance half of the hourly status card — state pill, one summary line,
 * what changed since the last update, open owner questions verbatim.
 */
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));

import {
  buildProjectUpdate, deriveChanges, deriveState, pickFocus, etaText, renderUpdateMarkdown,
  PROJECT_UPDATE_MAX_CHANGES,
  type ProjectUpdateInputs,
} from './project-update';
import { hashProjectStatus, type ProjectStatus, type ProjectTiming } from './project-status.service';

const NOW = new Date('2026-09-28T22:06:00.000Z');
const SINCE = new Date(NOW.getTime() - 60 * 60_000);
const OLD = new Date('2026-09-20T00:00:00.000Z');
const IN = new Date(NOW.getTime() - 15 * 60_000);

function status(over: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    projectName: 'digby-benchmarks', headline: 'digby-benchmarks: 1 of 4 goals active, 3 done; 1 lane scheduled, none running',
    workingOn: [], doneSince: [], blocked: [], next: [],
    goals: { active: 1, done: 3, blocked: 0 },
    todos: { inProgress: 1, pending: 0, blocked: 0, doneSince: 0 },
    lanesRunning: 0, lanesScheduled: 1, ownerItems: 0,
    ...over,
  };
}

// The recording's board: one active goal whose own note carries the count the
// owner kept asking for; one in-progress to-do; three old done goals.
const GOALS = [
  { id: 'g0', title: 'Scaffold the bench project', status: 'done', progressNote: null, blockedReason: null, updatedAt: OLD, createdAt: OLD },
  { id: 'g1', title: 'Run the full Digby framework on Terminal-Bench 2.1', status: 'active', progressNote: 'v3 run: 66 of 89 tasks done, 10 errors, 6 still running', blockedReason: null, updatedAt: OLD, createdAt: OLD },
];
const TODOS = [
  { id: 't1', goalId: 'g1', title: 'TB 2.1 v3 — production LiteLLM seat + supervisor-routed full-framework run', status: 'in_progress', progressNote: 'settling', blockedReason: null, updatedAt: OLD, createdAt: OLD },
];

function inputs(over: Partial<ProjectUpdateInputs> = {}): ProjectUpdateInputs {
  return { status: status(), goals: GOALS, todos: TODOS, since: SINCE, now: NOW, openQuestions: [], failedRuns: 0, prev: null, ...over };
}

describe('project update — the recording replay', () => {
  it('a quiet hour (only a supervisor check-in + a finished work session) has NO changes, names the work and the count, and is Idle when nothing runs', () => {
    const s = status({ doneSince: ['1 work session finished', 'The project supervisor checked in and found nothing that needed a hand.'], todos: { inProgress: 1, pending: 0, blocked: 0, doneSince: 0 } });
    const u = buildProjectUpdate(inputs({ status: s }));
    expect(u.changes).toEqual([]);
    expect(u.state).toBe('idle');
    expect(u.stateLabel).toBe('Idle');
    expect(u.focus).toBe('TB 2.1 v3 — production LiteLLM seat + supervisor-routed full-framework run');
    expect(u.progress).toEqual({ done: 66, total: 89, label: 'Run the full Digby framework on Terminal-Bench 2.1' });
    expect(u.summary).toContain('66 of 89 done (74%)');
    expect(u.needsYou).toEqual([]);
  });

  it('the no-change hash ignores the window lists (doneSince, the to-do doneSince count, failed-run / attention lines) but not board state', () => {
    const a = status({ doneSince: ['The project supervisor checked in and found nothing that needed a hand.'], blocked: ['1 work session hit an error'], todos: { inProgress: 1, pending: 0, blocked: 0, doneSince: 2 } });
    const b = status({ doneSince: ['1 work session finished'], blocked: ['2 lanes asked for attention'], todos: { inProgress: 1, pending: 0, blocked: 0, doneSince: 0 } });
    expect(hashProjectStatus(a)).toBe(hashProjectStatus(b));
    expect(hashProjectStatus(status({ blocked: ['Todo blocked: Upload the eval set — blocked: disk full'] }))).not.toBe(hashProjectStatus(a));
    expect(hashProjectStatus(status({ todos: { inProgress: 0, pending: 1, blocked: 0, doneSince: 0 } }))).not.toBe(hashProjectStatus(a));
  });
});

describe('state', () => {
  it('owner questions win; then done; then blocked; stalled; working; no goals; idle', () => {
    expect(deriveState({ status: status({ ownerItems: 1 }), todos: TODOS, stalled: true })).toBe('needs_you');
    expect(deriveState({ status: status({ goals: { active: 0, done: 4, blocked: 0 } }), todos: [], stalled: false })).toBe('done');
    expect(deriveState({ status: status({ goals: { active: 0, done: 1, blocked: 1 } }), todos: [], stalled: false })).toBe('blocked');
    expect(deriveState({ status: status(), todos: [{ ...TODOS[0], status: 'blocked' }], stalled: false })).toBe('blocked');
    expect(deriveState({ status: status({ lanesRunning: 1 }), todos: TODOS, stalled: true })).toBe('stalled');
    expect(deriveState({ status: status({ lanesRunning: 1 }), todos: TODOS, stalled: false })).toBe('working');
    expect(deriveState({ status: status({ goals: { active: 0, done: 0, blocked: 0 } }), todos: [], stalled: false })).toBe('no_goals');
    expect(deriveState({ status: status(), todos: TODOS, stalled: false })).toBe('idle');
  });

  it('Stalled only from a RUNNING lane\'s measured stall — never from an unmoved goal note', () => {
    const timing: ProjectTiming = {
      lanes: [{ chatId: 'l1', title: 'bench', state: 'running', runningForMin: 90, progress: { done: 61, total: 89, label: 'run', stalled: true } }],
      goals: [], closures: [], nextStatusAt: NOW.toISOString(),
    };
    expect(buildProjectUpdate(inputs({ status: status({ lanesRunning: 1, timing }) })).state).toBe('stalled');
    // Same goal-note count as last card, lane running, no measured stall ⇒ still Working.
    const u = buildProjectUpdate(inputs({ status: status({ lanesRunning: 1 }), prev: { progress: { done: 66, total: 89 } } }));
    expect(u.state).toBe('working');
  });
});

describe('changes since the last update', () => {
  it('names goals/to-dos finished, newly blocked (on blockedAt — never a reason rewrite), new work, a moving count, the KPI, failed runs and new questions', () => {
    const goals = [
      ...GOALS,
      { id: 'g2', title: 'Publish the scorecard', status: 'done', progressNote: null, blockedReason: null, updatedAt: IN, createdAt: OLD },
      { id: 'g3', title: 'Rerun the failures', status: 'blocked', progressNote: null, blockedReason: "owner's HALT-band decision MADE", updatedAt: IN, createdAt: OLD, blockedAt: IN },
      { id: 'g4', title: 'Reason rewritten only', status: 'blocked', progressNote: null, blockedReason: 'new words', updatedAt: IN, createdAt: OLD, blockedAt: OLD },
    ];
    const todos = [
      ...TODOS,
      { id: 't2', title: 'Bank results', status: 'done', progressNote: null, blockedReason: null, updatedAt: IN, createdAt: OLD },
      { id: 't3', title: 'Register the KPI', status: 'pending', progressNote: null, blockedReason: null, updatedAt: IN, createdAt: IN },
    ];
    const s = status({ kpi: { goalId: 'g1', key: 'kpi:tb21_v3_mean_reward', value: 0.61, prevValue: 0.5056, setAt: IN.toISOString() } });
    const changes = deriveChanges(inputs({ status: s, goals, todos, failedRuns: 2, openQuestions: [{ question: 'Rerun at 2× timeout?', createdAt: IN }], prev: { progress: { done: 61, total: 89 } } }), { done: 66, total: 89 });
    expect(changes.slice(0, PROJECT_UPDATE_MAX_CHANGES - 1)).toEqual([
      'Goal done: Publish the scorecard',
      'Goal now blocked: Rerun the failures',
      'A new question is waiting for you',
      '2 work sessions hit an error',
      'tb21 v3 mean reward: 0.5056 → 0.61',
    ]);
    expect(changes).toHaveLength(PROJECT_UPDATE_MAX_CHANGES);
    expect(changes.at(-1)).toMatch(/^…and \d+ more changes?$/);
    expect(changes.join(' ')).not.toMatch(/HALT-band|Reason rewritten only/);
  });

  it('"Progress: a → b of N" only when the same total moved', () => {
    expect(deriveChanges(inputs({ prev: { progress: { done: 61, total: 89 } } }), { done: 66, total: 89 })).toEqual(['Progress: 61 → 66 of 89']);
    expect(deriveChanges(inputs({ prev: { progress: { done: 66, total: 89 } } }), { done: 66, total: 89 })).toEqual([]);
    expect(deriveChanges(inputs({ prev: { progress: { done: 10, total: 50 } } }), { done: 66, total: 89 })).toEqual([]);
  });

  it('identifiers never reach the owner', () => {
    const todos = [{ id: 't9', title: 'Ship run 9f8e7d6c5b4a3210 (receipt 3c2d1e0f9a8b)', status: 'done', progressNote: null, blockedReason: null, updatedAt: IN, createdAt: OLD }];
    const [line] = deriveChanges(inputs({ todos }));
    expect(line).toBe('Finished: Ship run');
  });
});

describe('needs you + next check + summary', () => {
  it('quotes open questions in their own words (≤3, ids stripped) and counts all of them', () => {
    const qs = ['Rerun failures at 2× timeout? (oq_ab12cd34)', 'Keep the bench box?', 'Publish to the leaderboard?', 'Fourth?'].map((q) => ({ question: q, createdAt: OLD }));
    const u = buildProjectUpdate(inputs({ status: status({ ownerItems: 4 }), openQuestions: qs }));
    expect(u.state).toBe('needs_you');
    expect(u.needsYou).toEqual(['Rerun failures at 2× timeout?', 'Keep the bench box?', 'Publish to the leaderboard?']);
    expect(u.needsYouCount).toBe(4);
  });

  it('next check = the supervisor\'s next check, else the earliest lane wake', () => {
    const timing: ProjectTiming = { lanes: [{ chatId: 'l', title: 'x', state: 'scheduled', nextWakeAt: '2026-09-29T06:03:00.000Z' }], goals: [], closures: [], nextStatusAt: NOW.toISOString() };
    expect(buildProjectUpdate(inputs({ status: status({ timing }) })).nextCheckAt).toBe('2026-09-29T06:03:00.000Z');
    expect(buildProjectUpdate(inputs({ status: status({ timing: { ...timing, nextCheckAt: '2026-09-28T23:03:00.000Z' } }) })).nextCheckAt).toBe('2026-09-28T23:03:00.000Z');
  });

  it('a lane\'s measured fraction wins and carries its ETA', () => {
    const timing: ProjectTiming = {
      lanes: [{ chatId: 'l1', title: 'bench', state: 'running', progress: { done: 70, total: 89, label: 'v3 run' }, eta: { minutes: 125, basis: 'rate', confidence: 'low' } }],
      goals: [], closures: [], nextStatusAt: NOW.toISOString(),
    };
    const f = pickFocus({ goals: GOALS, todos: TODOS, timing });
    expect(f.progress).toEqual({ done: 70, total: 89, label: 'v3 run' });
    const u = buildProjectUpdate(inputs({ status: status({ lanesRunning: 1, timing }) }));
    expect(u.summary).toBe(`TB 2.1 v3 — production LiteLLM seat + supervisor-routed full-framework run · 70 of 89 done (79%) · ${etaText(125)}`);
    expect(etaText(125)).toBe('about 2 h left at this pace');
  });

  // Ticket a8d6e514: notes may now hold a 2,000-char ledger — the count is parsed from the note's LEAD only, so a
  // larger fraction in the ledger tail ("firing 1668/1687 done" of an old cycle) never becomes the Pulse's progress.
  it('a8d6e514: the progress fraction is read from the note lead, never a ledger tail past char 200', () => {
    const lead = 'v3 run: 66 of 89 tasks done, 10 errors, 6 still running.';
    const note = `${lead}${' '.repeat(200 - lead.length)} ledger: earlier cycle 1668/1687 rows done; older 191/219 done.`;
    const todos = [{ id: 't1', goalId: 'g1', title: 'Untitled step', status: 'in_progress', progressNote: note, blockedReason: null, updatedAt: NOW, createdAt: NOW }];
    expect(pickFocus({ goals: [], todos }).progress).toMatchObject({ done: 66, total: 89 });
    const tailOnly = [{ ...todos[0], progressNote: `${'x '.repeat(110)}1668/1687 rows done` }];
    expect(pickFocus({ goals: [], todos: tailOnly }).progress).toBeUndefined();
  });

  it('done / no-goal projects say so plainly', () => {
    expect(buildProjectUpdate(inputs({ status: status({ goals: { active: 0, done: 4, blocked: 0 } }), goals: [], todos: [] })).summary).toBe('All 4 goals done.');
    expect(buildProjectUpdate(inputs({ status: status({ goals: { active: 0, done: 0, blocked: 0 } }), goals: [], todos: [] })).summary).toBe('No goals have been set for this project yet.');
  });

  it('renders a short markdown block for body-only surfaces', () => {
    const md = renderUpdateMarkdown(buildProjectUpdate(inputs({ status: status({ ownerItems: 1 }), openQuestions: [{ question: 'Rerun at 2× timeout?' }] })));
    expect(md).toBe('**Needs you** — TB 2.1 v3 — production LiteLLM seat + supervisor-routed full-framework run · 66 of 89 done (74%)\nNo change since the last update.\nNeeds you: "Rerun at 2× timeout?"');
  });
});
