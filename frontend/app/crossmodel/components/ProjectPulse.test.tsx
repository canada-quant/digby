/**
 * Renderer tests for ProjectPulse — the shared Project Pulse block (owner
 * 2026-09-04) used by the management dashboard (under each project title),
 * the project page, and the workspace-panel Fleet tab.
 *
 * SSR via react-dom/server (the repo's node-environment vitest idiom — no
 * jsdom, initial state only): every honest state renders — on_pace with the
 * "~Nd" chip, no_movement, blocked, done, a digest without goals, and the
 * no-digest empty state. The label helpers are pinned directly so the chip
 * text can never silently drift into fabricated-estimate territory.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ProjectPulse, etaSummaryLabel, goalChipLabel, stoppedScheduleChipLabel } from './ProjectPulse';
import type {
  FleetDigest,
  FleetDigestAttentionItem,
  FleetDigestEtaSummary,
  FleetDigestGoalProgress,
  FleetGoalEta,
} from '@/lib/api/fleet';

const eta = (over: Partial<FleetGoalEta> = {}): FleetGoalEta => ({
  remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace', ...over,
});

const goal = (over: Partial<FleetDigestGoalProgress> & { goalId: string; title: string }): FleetDigestGoalProgress => ({
  status: 'active', todosDone: 7, todosTotal: 18, blockedCount: 0,
  completed24h: 1, completed7d: 7, eta: eta(), ...over,
});

const summaryFor = (cls: FleetDigestEtaSummary['class'], over: Partial<FleetDigestEtaSummary> = {}): FleetDigestEtaSummary => ({
  goalsTracked: 1, goalsBlocked: 0, todosDone: 7, todosTotal: 18,
  todosRemaining: 11, blockedCount: 0, pacePerDay: 1, etaDays: 11, class: cls, ...over,
});

const digest = (over: Partial<FleetDigest> = {}): FleetDigest => ({
  projectId: 'p1',
  projectName: 'Alpha',
  status: 'on_track',
  summary: 'Alpha is moving well toward its routing goal.',
  attentionItems: [],
  stats: {} as any,
  goalProgress: [goal({ goalId: 'g1', title: 'Optimal multi-model routing' })],
  etaSummary: summaryFor('on_pace'),
  generatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

const render = (props: Parameters<typeof ProjectPulse>[0]) =>
  renderToStaticMarkup(createElement(ProjectPulse, props));

describe('ProjectPulse — on_pace', () => {
  it('renders the summary, the overall ETA chip, per-goal counts, and the as-of stamp', () => {
    const html = render({ digest: digest() });
    expect(html).toContain('Alpha is moving well toward its routing goal.');
    expect(html).toContain('On pace · ~11d to go');
    expect(html).toContain('Optimal multi-model routing');
    expect(html).toContain('7/18 · ~11d');
    expect(html).toContain('as of');
    expect(html).toContain('line-clamp-2'); // collapsed by default (expand is a client toggle)
  });

  it('caps the goal chips and shows the +N overflow', () => {
    const goals = Array.from({ length: 6 }, (_, i) => goal({ goalId: `g${i}`, title: `Goal ${i}` }));
    const html = render({ digest: digest({ goalProgress: goals }) });
    expect(html).toContain('Goal 3');
    expect(html).not.toContain('Goal 4');
    expect(html).toContain('+2 more goals');
  });
});

describe('ProjectPulse — honest non-pace states', () => {
  it('no_movement: says so plainly, never invents an estimate', () => {
    const html = render({
      digest: digest({
        goalProgress: [goal({
          goalId: 'g1', title: 'Sleepy goal', todosDone: 2, todosTotal: 6,
          completed24h: 0, completed7d: 0,
          eta: eta({ remaining: 4, pacePerDay: 0, etaDays: null, class: 'no_movement' }),
        })],
        etaSummary: summaryFor('no_movement', { etaDays: null, pacePerDay: 0, todosDone: 2, todosTotal: 6, todosRemaining: 4 }),
      }),
    });
    expect(html).toContain('No recent movement');
    expect(html).toContain('2/6 · no movement');
    expect(html).not.toContain('~'); // no ETA figure anywhere
  });

  it('blocked: the gate is named with its count', () => {
    const html = render({
      digest: digest({
        goalProgress: [goal({
          goalId: 'g1', title: 'Gated goal', status: 'blocked', blockedCount: 1,
          todosDone: 1, todosTotal: 3,
          eta: eta({ remaining: 2, pacePerDay: 0, etaDays: null, class: 'blocked' }),
        })],
        etaSummary: summaryFor('blocked', { goalsBlocked: 1, blockedCount: 1, etaDays: null, pacePerDay: 0 }),
      }),
    });
    expect(html).toContain('Blocked · 1 task gating');
    expect(html).toContain('1/3 · blocked');
  });

  it('done: goals-complete state', () => {
    const html = render({
      digest: digest({
        goalProgress: [goal({
          goalId: 'g1', title: 'Finished goal', todosDone: 4, todosTotal: 4,
          eta: eta({ remaining: 0, etaDays: null, class: 'done' }),
        })],
        etaSummary: summaryFor('done', { todosDone: 4, todosTotal: 4, todosRemaining: 0, etaDays: null }),
      }),
    });
    expect(html).toContain('Goals done');
    expect(html).toContain('4/4 · done');
  });
});

describe('ProjectPulse — no goals / no digest', () => {
  it('a digest without goals renders the summary with NO chips', () => {
    const html = render({ digest: digest({ goalProgress: [], etaSummary: null }) });
    expect(html).toContain('Alpha is moving well toward its routing goal.');
    expect(html).not.toContain('On pace');
    expect(html).not.toContain('rounded-full'); // no chip row at all
    expect(html).toContain('as of');
  });

  it('deploy skew: a digest MISSING the pulse fields entirely renders like no-goals', () => {
    const legacy = digest();
    delete (legacy as any).goalProgress;
    delete (legacy as any).etaSummary;
    const html = render({ digest: legacy });
    expect(html).toContain('Alpha is moving well toward its routing goal.');
    expect(html).not.toContain('On pace');
  });

  it('digest === null renders the honest no-pulse state (compact + full copy)', () => {
    expect(render({ digest: null })).toContain('No pulse yet — the hourly project summary lands after the next sweep.');
    expect(render({ digest: null, compact: true })).toContain('No pulse yet.');
  });

  it('the optional title renders as a block heading', () => {
    const html = render({ digest: digest(), title: 'Project pulse' });
    expect(html).toContain('Project pulse');
  });
});

describe('label helpers (pure pins — the honesty contract)', () => {
  it('etaSummaryLabel per class', () => {
    expect(etaSummaryLabel(summaryFor('on_pace', { etaDays: 2.6 }))).toBe('On pace · ~3d to go');
    expect(etaSummaryLabel(summaryFor('on_pace', { etaDays: null }))).toBe('On pace');
    expect(etaSummaryLabel(summaryFor('blocked', { blockedCount: 1 }))).toBe('Blocked · 1 task gating');
    expect(etaSummaryLabel(summaryFor('blocked', { blockedCount: 3 }))).toBe('Blocked · 3 tasks gating');
    expect(etaSummaryLabel(summaryFor('no_movement'))).toBe('No recent movement');
    expect(etaSummaryLabel(summaryFor('done'))).toBe('Goals done');
  });

  it('goalChipLabel per class (ETA figure only when the server computed one)', () => {
    expect(goalChipLabel(goal({ goalId: 'g', title: 't' }))).toBe('7/18 · ~11d');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ etaDays: 0.4 }) }))).toBe('7/18 · ~1d');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ etaDays: null, class: 'no_movement' }) }))).toBe('7/18 · no movement');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ class: 'blocked' }) }))).toBe('7/18 · blocked');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', todosDone: 18, eta: eta({ remaining: 0, etaDays: null, class: 'done' }) }))).toBe('18/18 · done');
    // GOAL-UNPLANNED (2026-10-20): an open goal with nothing open under it.
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', todosDone: 18, eta: eta({ remaining: 0, etaDays: null, class: 'unplanned' }) }))).toBe('18/18 · needs a plan');
  });

  it('ticket C1 (2026-09-27): held + behind_deadline labels — the server-computed daysLeft is displayed, never re-derived', () => {
    const deadline = (daysLeft: number) => ({ key: 'sft2_start_by_unixts', at: '2026-09-28T12:00:00.000Z', daysLeft });
    // Review 2026-09-27: a fact about the note, never an owner-set "On hold" status.
    expect(etaSummaryLabel(summaryFor('held'))).toBe('Held per note');
    expect(etaSummaryLabel(summaryFor('behind_deadline', { deadline: deadline(1) }))).toBe('Behind deadline · due in 1d');
    expect(etaSummaryLabel(summaryFor('behind_deadline', { deadline: deadline(0.3) }))).toBe('Behind deadline · due today');
    expect(etaSummaryLabel(summaryFor('behind_deadline', { deadline: deadline(-3) }))).toBe('Behind deadline · 3d overdue');
    expect(etaSummaryLabel(summaryFor('behind_deadline'))).toBe('Behind deadline');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ class: 'held' }) }))).toBe('7/18 · held per note');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ class: 'behind_deadline', deadline: deadline(5) }) }))).toBe('7/18 · due in 5d');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ class: 'behind_deadline', deadline: deadline(-1) }) }))).toBe('7/18 · 1d overdue');
    expect(goalChipLabel(goal({ goalId: 'g', title: 't', eta: eta({ class: 'behind_deadline' }) }))).toBe('7/18 · behind deadline');
  });
});

/**
 * SA0906 — the stopped-schedule warning chip: the digest's schedule_error
 * attention items are successor-aware on the backend (only genuinely
 * heartbeat-dead lanes / live-erroring schedules survive the sweep), so the
 * chip counts true positives only and carries the destructive tint.
 */
describe('stopped-schedule warning chip (SA0906)', () => {
  const scheduleError = (id: string): FleetDigestAttentionItem => ({
    kind: 'schedule_error',
    title: 'hourly W4A16 kernel sweep',
    detail: 'recurring schedule stopped after 8 runs — it will not resume on its own',
    scheduleId: id,
    chatId: 'c1',
    at: new Date().toISOString(),
  });
  const otherItem: FleetDigestAttentionItem = {
    kind: 'failed_run', title: 'Spark lane', detail: 'OOM killed', runId: 'r1', chatId: 'c1',
    at: new Date().toISOString(),
  };

  it('renders the destructive-tinted chip for ONE stopped schedule', () => {
    const html = render({ digest: digest({ attentionItems: [scheduleError('s1')] }) });
    expect(html).toContain('1 stopped schedule');
    expect(html).not.toContain('1 stopped schedules');
    expect(html).toContain('text-destructive');
  });

  it('pluralizes for N stopped schedules', () => {
    const html = render({ digest: digest({ attentionItems: [scheduleError('s1'), scheduleError('s2'), scheduleError('s3')] }) });
    expect(html).toContain('3 stopped schedules');
  });

  it('renders NO chip at zero schedule_error items — other attention kinds do not count', () => {
    expect(render({ digest: digest({ attentionItems: [] }) })).not.toContain('stopped schedule');
    expect(render({ digest: digest({ attentionItems: [otherItem] }) })).not.toContain('stopped schedule');
  });

  it('renders NO chip when there is no digest at all', () => {
    expect(render({ digest: null })).not.toContain('stopped schedule');
  });

  it('deploy skew: a digest missing attentionItems entirely renders chip-free', () => {
    const legacy = digest();
    delete (legacy as any).attentionItems;
    expect(render({ digest: legacy })).not.toContain('stopped schedule');
  });

  it('the chip still renders on a digest without goals/eta (its own row condition)', () => {
    const bare = digest({ attentionItems: [scheduleError('s1')], goalProgress: [], etaSummary: null as any });
    expect(render({ digest: bare })).toContain('1 stopped schedule');
  });

  it('stoppedScheduleChipLabel pins the copy', () => {
    expect(stoppedScheduleChipLabel(1)).toBe('1 stopped schedule');
    expect(stoppedScheduleChipLabel(2)).toBe('2 stopped schedules');
  });
});
