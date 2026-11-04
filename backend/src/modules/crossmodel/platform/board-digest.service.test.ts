/**
 * BOARD DIGEST pins (owner 2026-09-16, "inject the board, don't let the model
 * recall it"). The pure renderers are deterministic: the same facts always
 * render the same block. These tests pin the shapes the doctrine and the
 * verifier's board-assertion lane rely on — the NONE line when no owner
 * question is open, the "NOT open; cite it as answered" line for a recently
 * answered ruling (the spark oq_bd1130d5 class), the count headers, the
 * shrink order (todos first, owner questions never), and the wake-seam wiring
 * in chat-agent.service.ts + the doctrine bullets in both supervisor prompts.
 */
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  // Timing block (owner 2026-09-17) — computeProjectTiming reads these too.
  agentRun: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findFirst: jest.fn(async () => null) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON.
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// config/redis is loaded LAZILY by supervisor-switch (skip counter read) on an
// OFF path only — the real module pulls config/env (process.exit without env).
const mockRedisGet: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: (...a: any[]) => mockRedisGet(...a), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import * as fs from 'fs';
import * as path from 'path';
import {
  renderProjectBoardBlock, renderFleetBoardBlock, renderPremisesInline, buildBoardDigestBlock,
  BOARD_BLOCK_PREFIX, BOARD_BLOCK_CAP, FLEET_BOARD_BLOCK_CAP, BOARD_MAX_TODOS,
  type BoardFacts,
} from './board-digest.service';
import { renderTimingBlock, TIMING_BLOCK_CAP, TIMING_BLOCK_HEADER } from './board-digest.service';

const NOW = new Date('2026-09-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

describe('renderProjectBoardBlock', () => {
  const facts = (): BoardFacts => ({
    projectName: 'spark-cluster',
    now: NOW,
    goals: [
      { id: uuid('g1active'), title: 'Ship dflash2E at parity', status: 'active', premises: [] },
      { id: uuid('g2blockd'), title: 'Publish the g4 graphs', status: 'blocked', blockKind: 'external', blockedReason: 'Waiting on the vendor firmware drop', premises: [{ key: 'baseline', value: 60.07, unit: '%' }] },
      { id: uuid('g3done00'), title: 'Old goal', status: 'done' },
    ],
    todos: [
      { id: uuid('t1inprog'), title: 'Rerun the 30-prompt eval', status: 'in_progress', assigneeChatId: uuid('lane0001'), assigneeTitle: 'Eval lane', updatedAt: hoursAgo(1) },
      { id: uuid('t2blockd'), title: 'Flash firmware', status: 'blocked', blockKind: 'missing_input', blockedReason: null as string | null, updatedAt: hoursAgo(2) },
      { id: uuid('t3pendin'), title: 'Write the postmortem', status: 'pending', updatedAt: hoursAgo(3) },
      { id: uuid('t4done00'), title: 'Closed recently', status: 'done', updatedAt: hoursAgo(5) },
      { id: uuid('t5oldone'), title: 'Closed long ago', status: 'done', updatedAt: hoursAgo(80) },
    ],
    ownerQuestions: [
      { id: 'oq_bd1130d5-aaaa-4000-8000-000000000000', status: 'answered', createdAt: hoursAgo(60), resolvedAt: hoursAgo(48), answeredBy: 'owner', question: 'Keep dflash2E or fall back to incoai?' },
    ],
  });

  it('renders goals, todos and owner questions from the ledger with the [BOARD header', () => {
    const block = renderProjectBoardBlock(facts());
    expect(block.startsWith(`${BOARD_BLOCK_PREFIX} — the live ledger for "spark-cluster"`)).toBe(true);
    expect(block).toContain('GOALS: 2 active/blocked · 1 done · 0 archived');
    // GOAL-PRIORITY-SPEND (2026-10-20): each tracked goal line leads with its rank ([P-level · score]).
    expect(block).toContain('- [P2 · 60] goal g1active [active] "Ship dflash2E at parity"');
    // GOAL-UNPLANNED (2026-10-20): every goal line carries its todo counts (this fixture's todos name no goal).
    expect(block).toContain('- [P2 · 60] goal g2blockd [blocked] "Publish the g4 graphs" — blocked (external): Waiting on the vendor firmware drop · todos 0 open/0 done · premises: baseline=60.07%');
    expect(block).toContain('TODOS: 3 open (1 in_progress · 1 blocked · 1 pending) · 1 closed in the last 24h: t4done00 [done]');
    expect(block).not.toContain('t5oldone'); // outside the 24h window
    expect(block).toContain('- todo t1inprog [in_progress] "Rerun the 30-prompt eval" → lane lane0001 "Eval lane"');
    expect(block).toContain('- todo t2blockd [blocked] "Flash firmware" → unassigned — blocked (missing_input): (no reason recorded)');
    // in_progress sorts before blocked before pending
    expect(block.indexOf('t1inprog')).toBeLessThan(block.indexOf('t2blockd'));
    expect(block.indexOf('t2blockd')).toBeLessThan(block.indexOf('t3pendin'));
  });

  it('says NONE when no owner question is open and marks a recently answered one as NOT open (the oq_bd1130d5 class)', () => {
    const block = renderProjectBoardBlock(facts());
    expect(block).toContain('- OPEN owner questions on this project: NONE — nothing is waiting on the owner');
    expect(block).toContain('- oq_bd1130d5 ANSWERED 09-14 12:00Z by owner — NOT open; cite it as answered');
  });

  it('lists an open owner question with its id and drops the NONE line', () => {
    const f = facts();
    f.ownerQuestions.push({ id: 'oq_12345678-bbbb-4000-8000-000000000000', status: 'open', createdAt: hoursAgo(2), resolvedAt: null as any, answeredBy: null as any, question: 'Approve the v0.8.2 publish?' });
    const block = renderProjectBoardBlock(f);
    expect(block).not.toContain('NONE — nothing is waiting');
    expect(block).toContain('- oq_12345678 OPEN since 09-16 10:00Z: "Approve the v0.8.2 publish?"');
  });

  it('stays under the cap by shrinking todos first and never cuts the owner-question section', () => {
    const f = facts();
    for (let i = 0; i < 60; i++) {
      f.todos.push({ id: uuid(`x${String(i).padStart(2, '0')}`), title: `A long-winded todo title number ${i} that pads the block toward its cap`.repeat(2), status: 'blocked', blockKind: 'external', blockedReason: 'A long block reason that also pads the line toward the cap so the shrink loop has to run for real here', updatedAt: hoursAgo(i + 1) });
    }
    f.ownerQuestions.push({ id: 'oq_abcdef01-cccc-4000-8000-000000000000', status: 'open', createdAt: hoursAgo(1), resolvedAt: null as any, answeredBy: null as any, question: 'Still here?' });
    const block = renderProjectBoardBlock(f);
    expect(block.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
    expect(block).toContain('more open todos (use todo_list)');
    expect(block).toContain('- oq_abcdef01 OPEN since');
    expect(block).toContain('- oq_bd1130d5 ANSWERED');
    expect((block.match(/^- todo /gm) ?? []).length).toBeLessThan(BOARD_MAX_TODOS);
    // owner questions render BEFORE the todo list so a hard truncation can only eat todos
    expect(block.indexOf('OWNER QUESTIONS:')).toBeLessThan(block.indexOf('TODOS:'));
  });

  it('always leaves a "…N more (use todo_list)" marker when the todo list is longer than the visible limit, even under the cap', () => {
    const f = facts();
    for (let i = 0; i < 25; i++) f.todos.push({ id: uuid(`y${String(i).padStart(2, '0')}`), title: `t${i}`, status: 'pending', updatedAt: hoursAgo(i + 1) });
    const block = renderProjectBoardBlock(f);
    expect(block).toContain('TODOS: 28 open');
    expect((block.match(/^- todo /gm) ?? []).length).toBe(BOARD_MAX_TODOS);
    expect(block).toContain('- …8 more open todos (use todo_list)');
  });
});

describe('renderFleetBoardBlock', () => {
  it('rolls up one line per supervised project and lists open owner questions account-wide', () => {
    const block = renderFleetBoardBlock([
      { name: 'spark-cluster', projectId: uuid('spark000'), activeGoals: 1, blockedGoals: 0, openTodos: 3, blockedTodos: 1, openOwnerQuestions: 0 },
      { name: 'CanLaw', projectId: uuid('canlaw00'), activeGoals: 4, blockedGoals: 2, openTodos: 9, blockedTodos: 0, openOwnerQuestions: 1 },
    ], [
      { id: 'oq_99999999-dddd-4000-8000-000000000000', status: 'open', createdAt: new Date('2026-09-16T09:30:00Z'), question: 'Publish v0.8.2 with Gates 1–3 unmet?' },
    ], NOW);
    expect(block.startsWith(`${BOARD_BLOCK_PREFIX} — fleet ledger roll-up`)).toBe(true);
    expect(block).toContain('SUPERVISED PROJECTS: 2');
    expect(block).toContain('- CanLaw (canlaw00): 4 active goal(s) (2 blocked) · 9 open todo(s) · 1 open owner question(s)');
    expect(block).toContain('- spark-cluster (spark000): 1 active goal(s) · 3 open todo(s) (1 blocked) · 0 open owner question(s)');
    expect(block).toContain('- oq_99999999 OPEN since 09-16 09:30Z: "Publish v0.8.2 with Gates 1–3 unmet?"');
    expect(block.length).toBeLessThanOrEqual(FLEET_BOARD_BLOCK_CAP);
  });

  it('says NONE open account-wide when no owner question is open', () => {
    const block = renderFleetBoardBlock([], [], NOW);
    expect(block).toContain('- NONE open account-wide — no project is waiting on the owner right now.');
  });
});

describe('renderPremisesInline', () => {
  it('renders value + unit and a drift warning when the source disagrees', () => {
    expect(renderPremisesInline([{ key: 'untrained-base', value: 60.07, unit: '%' }])).toBe(' · premises: untrained-base=60.07%');
    expect(renderPremisesInline([{ key: 'rate', value: 28, unit: ' tok/s', drift: 'drift', observed: 22 }])).toBe(' · premises: rate=28 tok/s ⚠ source now reads 22 tok/s');
    expect(renderPremisesInline([])).toBe('');
    expect(renderPremisesInline(undefined)).toBe('');
  });

  it('goals-lifecycle 2026-09-28: a recorded `observed` that is NOT a drift rides the ACTIVE line — a manual goal_premise_set observed says "manual"; an observed equal to the value (a clean sweep) and a drift line are unchanged', () => {
    expect(renderPremisesInline([{ key: 'target_tok_per_s', value: 20, unit: 'tok/s', observed: 5.33, observedNote: 'run r-9' }])).toBe(' · premises: target_tok_per_s=20tok/s (observed 5.33tok/s, manual)');
    expect(renderPremisesInline([{ key: 'target_tok_per_s', value: 20, unit: 'tok/s', observed: 24.1 }])).toBe(' · premises: target_tok_per_s=20tok/s (observed 24.1tok/s)');
    expect(renderPremisesInline([{ key: 'rate', value: 28, observed: 28, drift: 'ok' }])).toBe(' · premises: rate=28');
    expect(renderPremisesInline([{ key: 'rate', value: 28, unit: ' tok/s', drift: 'drift', observed: 22 }])).toBe(' · premises: rate=28 tok/s ⚠ source now reads 22 tok/s');
  });
});

describe('clipLaneTitle — the 40-char two-half lane clip (session titles + topology, 2026-09-28)', () => {
  const { clipLaneTitle, BOARD_LANE_TITLE_CHARS } = require('./board-digest.service');
  it('keeps a short title whole, clips a plain long title at 40, and keeps BOTH halves of a "<goal> · <step>" title', () => {
    expect(BOARD_LANE_TITLE_CHARS).toBe(40);
    expect(clipLaneTitle('Eval lane')).toBe('Eval lane');
    expect(clipLaneTitle('H2H bench S3+S5 · PR #712 opened')).toBe('H2H bench S3+S5 · PR #712 opened');
    const plain = 'A very long plain lane title with no separator anywhere in it';
    expect(clipLaneTitle(plain)).toHaveLength(40);
    expect(clipLaneTitle(plain).endsWith('…')).toBe(true);
    const two = clipLaneTitle('Quantize the 27B checkpoint for the serving box · benchmarking shard r1 on the A100');
    expect(two).toHaveLength(40);
    expect(two).toContain(' · ');
    expect(two.split(' · ')[1]).toMatch(/^benchmark/); // the step half survives
    expect(two.split(' · ')[0]).toMatch(/^Quantize/);
    // a short goal leaves the step half the rest of the budget
    const shortGoal = clipLaneTitle('Bench · verifying the throughput probe against the of-record command');
    expect(shortGoal).toHaveLength(40);
    expect(shortGoal.startsWith('Bench · verifying')).toBe(true);
  });

  it('the [BOARD] todo line carries the two-half lane title', () => {
    const block = renderProjectBoardBlock({
      projectName: 'p', now: NOW, ownerQuestions: [], goals: [],
      todos: [{ id: uuid('t1inprog'), title: 'Run it', status: 'in_progress', assigneeChatId: uuid('lane0001'), assigneeTitle: 'Quantize the 27B checkpoint for the serving box · benchmarking shard r1 on the A100', updatedAt: hoursAgo(1) }],
    });
    expect(block).toMatch(/→ lane lane0001 "Quantize[^"]* · benchmark[^"]*"/);
    expect(block).not.toContain('Quantize the 27B checkpoint for the serving box · benchmarking shard r1 on the A100');
  });

  // Todo 908f48a7 (monitor lesson 5): the needs-you union rides the
  // owner-questions section. The Tailscale-ACL specimen class — an ANSWERED
  // card whose follow-up never landed while zero cards are open — must render
  // as needing the owner; "nothing is waiting on the owner" may be written
  // only from a union line that says 0.
  it('908f48a7: an approved-but-never-landed row renders the NEEDS-YOU UNION line even with zero open cards; a true-zero union carries the quotable zero line', () => {
    const gated = renderProjectBoardBlock({
      projectName: 'p', now: NOW, goals: [], ownerQuestions: [],
      todos: [{ id: uuid('tgated0'), title: 'Save the Tailscale ACL', status: 'blocked', gateQuestionId: 'oq_0bb22222-3333-4444-5555-666677778888', updatedAt: hoursAgo(2) }],
      needsYouUnion: { total: 1, openCards: 0, answeredUnlanded: 1, ownerBlocked: 0, unlandedTitles: ['Save the Tailscale ACL'] },
    });
    expect(gated).toContain('NEEDS-YOU UNION: 1 item(s) waiting on the owner = 0 open card(s) + 1 approved action(s) NOT yet landed');
    expect(gated).toContain('"nothing needs the owner" is FALSE while this line is present');

    const zero = renderProjectBoardBlock({
      projectName: 'p', now: NOW, goals: [], ownerQuestions: [],
      todos: [],
      needsYouUnion: { total: 0, openCards: 0, answeredUnlanded: 0, ownerBlocked: 0, unlandedTitles: [] },
    });
    expect(zero).toContain('NEEDS-YOU UNION is 0');
    expect(zero).toContain('never count open cards alone');
    // absent union (no gated rows) keeps the pre-union line byte-identical — fail-open
    const absent = renderProjectBoardBlock({ projectName: 'p', now: NOW, goals: [], ownerQuestions: [], todos: [] });
    expect(absent).toContain('OPEN owner questions on this project: NONE — nothing is waiting on the owner; never write');
  });
});

describe('buildBoardDigestBlock', () => {
  beforeEach(() => { for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockClear(); });

  it("returns '' for an unknown project and never throws on a prisma failure", async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce(null);
    expect(await buildBoardDigestBlock({ scope: 'project', projectId: uuid('nope') })).toBe('');
    mockPrisma.crossModelProject.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await buildBoardDigestBlock({ scope: 'project', projectId: uuid('nope') })).toBe('');
  });

  it('project scope reads goals/todos/owner questions for that project only', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce({ id: uuid('p1'), name: 'spark-cluster' });
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([{ id: uuid('g1'), title: 'G', status: 'active' }]);
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([{ id: uuid('c1'), title: 'lane' }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValueOnce([{ id: 'oq_bd1130d5-x', status: 'answered', resolvedAt: hoursAgo(10), answeredBy: 'owner', question: 'q' }]);
    const block = await buildBoardDigestBlock({ scope: 'project', projectId: uuid('p1'), now: NOW });
    expect(block).toContain('GOALS: 1 active/blocked');
    expect(block).toContain('oq_bd1130d5 ANSWERED');
    const where = mockPrisma.ownerQuestion.findMany.mock.calls[0][0].where;
    expect(where.OR[0].chatId.in).toEqual([uuid('c1')]);
    expect(where.OR[1].forChatId.in).toEqual([uuid('c1')]);
  });

  it('project scope appends the harness-measured TIMING section (owner 2026-09-17) after the board, and stays plain when timing cannot be computed', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce({ id: uuid('p1'), name: 'spark-cluster' });
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([{ id: uuid('g1'), title: 'G', status: 'active' }]);
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([{ id: uuid('c1'), title: 'lane' }]);
    // computeProjectTiming's own reads: one running lane with a 42-minute-old run.
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([{ id: uuid('c1'), title: 'Citator re-scrape', isProjectSupervisor: false, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValueOnce([{ sessionId: uuid('c1'), startedAt: new Date(NOW.getTime() - 42 * 60_000), heartbeatAt: new Date(NOW.getTime() - 60_000) }]);
    const block = await buildBoardDigestBlock({ scope: 'project', projectId: uuid('p1'), now: NOW });
    expect(block).toContain('GOALS: 1 active/blocked');
    const idx = block.indexOf(TIMING_BLOCK_HEADER);
    expect(idx).toBeGreaterThan(block.indexOf('TODOS:'));
    expect(block).toContain('"Citator re-scrape": running 42m · last activity 1m ago');
    expect(block).toContain('next status card ~');
    expect(block).toContain('No estimate yet — no lane has reported a countable step.');

    // A timing read that throws leaves the plain board (never an error, never a missing board).
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce({ id: uuid('p1'), name: 'spark-cluster' });
    // board facts' chat read, then the timing compute's chat read (one lane → the schedule read runs, and fails)
    mockPrisma.crossModelChat.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: uuid('c1'), title: 'lane', isProjectSupervisor: false, archivedAt: null }]);
    mockPrisma.codingSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
    const plain = await buildBoardDigestBlock({ scope: 'project', projectId: uuid('p1'), now: NOW });
    expect(plain).toContain('GOALS:');
    expect(plain).not.toContain(TIMING_BLOCK_HEADER);
  });

  it('renderTimingBlock caps its length by dropping lane/goal lines before the tail line', () => {
    const timing = {
      lanes: Array.from({ length: 6 }, (_, i) => ({ chatId: `lane-${i}-xxxxxxxx`, title: `Lane ${i} with a long descriptive title that runs on`, state: 'running' as const, runningForMin: 5 + i, lastActivityMin: 1, progress: { done: 10 + i, total: 100, label: 'a long label for the countable step under test' } })),
      goals: Array.from({ length: 6 }, (_, i) => ({ id: `goal-${i}-xxxxxxxx`, title: `Goal ${i} with a long descriptive title`, status: 'active', done: i, total: 9 })),
      closures: [], nextStatusAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    };
    const block = renderTimingBlock(timing, NOW);
    expect(block.length).toBeLessThanOrEqual(TIMING_BLOCK_CAP);
    expect(block.startsWith(TIMING_BLOCK_HEADER)).toBe(true);
    expect(block).toContain('next status card ~');
  });

  it('fleet scope is scoped to the caller: projects where userId matches, open owner questions where userId matches', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValueOnce([{ id: uuid('p1'), name: 'spark-cluster' }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValueOnce([]);
    const block = await buildBoardDigestBlock({ scope: 'fleet', userId: 'user-1', now: NOW });
    expect(block).toContain('SUPERVISED PROJECTS: 1');
    expect(mockPrisma.crossModelProject.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'user-1', projectSupervisorEnabled: true });
    expect(mockPrisma.ownerQuestion.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'user-1', status: 'open' });
  });
});

describe('wiring pins (source-level)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('chat-agent.service.ts appends the board block on project + fleet machine wakes and on the owner-turn mirror', () => {
    const src = read('../chat-agent/chat-agent.service.ts');
    // 2c203dac: the import also carries buildLaneBoardBlock (the lane board —
    // same doctrine, the non-supervisor machine-wake surface).
    expect(src).toContain("import { buildBoardDigestBlock, buildLaneBoardBlock } from '../platform/board-digest.service';");
    expect(src).toContain("await buildBoardDigestBlock({ scope: 'project', projectId: chat.projectId })");
    expect(src).toContain("await buildBoardDigestBlock({ scope: 'fleet', userId: chat.userId })");
    expect(src).toContain("await buildBoardDigestBlock({ scope: 'project', projectId: supervisorRow.projectId })");
    expect(src).toContain("await buildLaneBoardBlock(args.chatId)");
    expect(src).toContain("await buildLaneBoardBlock(chatId)");
    // leadModel joined the same row read (WI-O #4c, 2026-09-25 — the per-chat lead pick rides the one supervisorRow query).
    // ghostMode joined it too (owner 2026-10-22 — the ghost posture rides the same single row read).
    expect(src).toContain("select: { isSupervisor: true, isProjectSupervisor: true, title: true, projectId: true, leadModel: true, ghostMode: true }");
  });

  it('both supervisor prompts carry the BOARD FACTS doctrine bullet', () => {
    // build 2026-10-08 S-2: both tiers' bullet rides the layered role profiles (the dated pre-layering builders were deleted).
    expect(read('./role-profiles.ts').split('BOARD FACTS come from the [BOARD] block').length - 1).toBe(2);
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// The board carries ONE harness-composed line per OFF tier so a supervisor
// (or the owner reading its context) never mistakes a switched-off tier for a
// stalled one. Both ON = no line (two cached reads, no query).
import { supervisorSwitchBoardLine, SUPERVISOR_SWITCH_BOARD_PREFIX } from './board-digest.service';
import { invalidateSupervisorSwitchCache } from './supervisor-switch';

describe('supervisor OFF switch × board digest line', () => {
  beforeEach(() => {
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockClear();
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    mockRedisGet.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockResolvedValue(null); invalidateSupervisorSwitchCache(); });

  it('both ON: no line, and the board block is byte-identical to before', async () => {
    expect(await supervisorSwitchBoardLine()).toBeNull();
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce(null);
    expect(await buildBoardDigestBlock({ scope: 'project', projectId: uuid('nope') })).toBe('');
  });

  it('fleet OFF: the line names OFF since / by / wakes skipped and rides an otherwise-empty board alone; fleet scope appends it after the roll-up', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: new Date('2026-09-26T17:30:00Z') }
        : where?.key === 'fleet_supervisor_enabled_by' ? { key: where.key, value: 'paul@sunday.market', updatedAt: new Date() }
          : null);
    mockRedisGet.mockResolvedValue('5');
    invalidateSupervisorSwitchCache();
    const line = await supervisorSwitchBoardLine();
    expect(line).toBe(`${SUPERVISOR_SWITCH_BOARD_PREFIX} Fleet supervisor: OFF since 2026-09-26 17:30Z by paul@sunday.market — wakes skipped: 5`);
    mockPrisma.crossModelProject.findUnique.mockResolvedValueOnce(null);
    expect(await buildBoardDigestBlock({ scope: 'project', projectId: uuid('nope') })).toBe(line);
    mockPrisma.crossModelProject.findMany.mockResolvedValueOnce([{ id: uuid('p1'), name: 'spark-cluster' }]);
    const fleet = await buildBoardDigestBlock({ scope: 'fleet', userId: 'u1', now: NOW });
    expect(fleet.startsWith(BOARD_BLOCK_PREFIX)).toBe(true);
    expect(fleet.endsWith(line as string)).toBe(true);
  });
});


// ── KPI of record + adoption ladder on the board (tt-rd audit 2026-09-27) ────
describe('board — kpi: premise rendering + adoption ladder (kpi-honesty-loops findings 1/2/3)', () => {
  const NOWK = new Date('2026-09-27T15:22:15Z');
  const KPI = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', kind: 'kpi', bar: 10, receiptId: 'f5b42fe6-1111-4000-8000-000000000000', setAt: '2026-09-27T13:22:15Z', prev: { value: 2.464, setAt: '2026-09-27T03:34:40Z' } };

  it('renders the KPI first with receipt · age · bar · last change; a receipted plain premise shows its receipt + age; legacy premises are unchanged', () => {
    expect(renderPremisesInline([{ key: 'host_tail_eng_gap_ms_tok', value: 12, unit: 'ms' }, KPI], NOWK))
      .toBe(' · premises: KPI client_visible_e2e_tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last change 2.464→5.08 @13:22Z; host_tail_eng_gap_ms_tok=12ms');
    expect(renderPremisesInline([{ key: 'read_wait_ms', value: 138, unit: 'ms', receiptId: 'deadbeef-0000-4000-8000-000000000000', setAt: '2026-09-27T14:52:15Z' }], NOWK))
      .toBe(' · premises: read_wait_ms=138ms (receipt deadbeef · 30m ago)');
    expect(renderPremisesInline([{ key: 'untrained-base', value: 60.07, unit: '%' }])).toBe(' · premises: untrained-base=60.07%');
  });

  it('a goal with an adoption ladder carries "KPI … unchanged since … · N experiments / D d without adoption" on its board line', () => {
    const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;
    const facts: BoardFacts = {
      projectName: 'tt-rd', now: NOWK, todos: [], ownerQuestions: [],
      goals: [{
        id: uuid('226be7b7'), title: 'Qwen3.8-Flash-Next serving on QB2', status: 'active', premises: [KPI],
        adoption: { goalId: uuid('226be7b7'), projectId: 'p', goalTitle: 't', kpiKey: KPI.key, kpiValue: 5.08, kpiUnit: 'tok/s', bar: 10, receiptId: KPI.receiptId, lastMoveAt: '2026-09-21T08:42:00Z', experiments: 27, hours: 150.4, lanes: ['ddd26be0'], tripped: true },
      }],
    };
    const block = renderProjectBoardBlock(facts);
    // GOAL-PRIORITY-SPEND: 62 = P2 (60) + the KPI-gap accrual (bar ≥10 unmet).
    expect(block).toContain('- [P2 · 62] goal 226be7b7 [active] "Qwen3.8-Flash-Next serving on QB2" · todos 0 open/0 done · UNPLANNED · premises: KPI client_visible_e2e_tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last change 2.464→5.08 @13:22Z · KPI 5.08 tok/s unchanged since 09-21 08:42Z · 27 experiments / 6.3 d without adoption');
  });
});

// ── sup3 audit C2 (2026-09-27): suspect 'done' closes badged on the board ────
describe('C2 — suspect done goals on the board + fleet roll-up', () => {
  const { suspectDoneGoals, BOARD_SUSPECT_DONE_WINDOW_MS } = require('./board-digest.service');

  const spark = {
    id: 'a57fb2e2-0000-4000-8000-000000000000', title: 'vLLM serving ≥20 tok/s', status: 'done',
    updatedAt: new Date(NOW.getTime() - 2 * 3600_000), progressNote: null,
    premises: [{ key: 'target_tok_per_s', value: 20, unit: 'tok/s', observed: 5.33, drift: 'drift' }],
  };
  const bench = {
    id: 'f6b31f1b-0000-4000-8000-000000000000', title: 'Redeploy canlegal-bench on :3001', status: 'done',
    updatedAt: new Date(NOW.getTime() - 3 * 86400_000), progressNote: 'redeploy of :3001 held', premises: [],
  };
  const stale = { ...spark, id: 'stale000-0000-4000-8000-000000000000', updatedAt: new Date(NOW.getTime() - BOARD_SUSPECT_DONE_WINDOW_MS - 1000) };
  const clean = { id: 'clean000-0000-4000-8000-000000000000', title: 'Clean close', status: 'done', updatedAt: NOW, progressNote: '3/3', premises: [{ key: 'target_x', value: 1, observed: 2 }] };
  const facts = (goals: any[]): BoardFacts => ({ projectName: 'spark-cluster', goals, todos: [], ownerQuestions: [], now: NOW });

  it('suspectDoneGoals: recent done rows with an unmet target premise or a HOLD note; stale / clean / active rows excluded', () => {
    const out = suspectDoneGoals([spark, bench, stale, clean, { ...spark, id: 'active00', status: 'active' }], NOW.getTime());
    expect(out.map((x: any) => x.goal.id.slice(0, 8))).toEqual(['a57fb2e2', 'f6b31f1b']);
    expect(out[0].badge).toBe('⚠ suspect: premise_target_unmet (target_tok_per_s ≥20tok/s, observed 5.33tok/s)');
    expect(out[1].badge).toBe('⚠ suspect: hold_token');
  });

  it('board-time directive reason (goals-lifecycle 2026-09-28): with the facts loader\'s directive read a done goal a same-project directive still names badges open_directive; without directives the badge set is unchanged; the close the owner ordered never badges', () => {
    const quiet = { ...clean, id: 'quiet000-0000-4000-8000-000000000000', title: 'vLLM serving ≥20 tok/s on the quant box', updatedAt: new Date(NOW.getTime() - 3600_000), premises: [] };
    const naming = [{ id: 'd-12345678', text: 'Keep the vLLM serving lane on the tok/s target until it holds', at: new Date(NOW.getTime() - 5 * 3600_000).toISOString(), scope: 'spark-cluster' }];
    const other = [{ ...naming[0], id: 'd-other', scope: 'CanLaw' }];
    const ordered = [{ ...naming[0], id: 'd-ord', text: 'Mark the vLLM serving goal done — the 20 tok/s bar is met, I checked the box myself' }];
    expect(suspectDoneGoals([quiet], NOW.getTime())).toEqual([]);
    expect(suspectDoneGoals([quiet], NOW.getTime(), { directives: naming, projectName: 'spark-cluster' }).map((x: any) => x.badge)).toEqual(['⚠ suspect: open_directive']);
    expect(suspectDoneGoals([quiet], NOW.getTime(), { directives: other, projectName: 'spark-cluster' })).toEqual([]);
    expect(suspectDoneGoals([quiet], NOW.getTime(), { directives: ordered, projectName: 'spark-cluster' })).toEqual([]);
    // the premise / hold badges are byte-identical with or without the read, and the directive joins them
    expect(suspectDoneGoals([spark, bench], NOW.getTime(), { directives: other, projectName: 'spark-cluster' }).map((x: any) => x.badge))
      .toEqual(suspectDoneGoals([spark, bench], NOW.getTime()).map((x: any) => x.badge));
    expect(suspectDoneGoals([spark], NOW.getTime(), { directives: naming, projectName: 'spark-cluster' })[0].badge).toBe('⚠ suspect: premise_target_unmet, open_directive (target_tok_per_s ≥20tok/s, observed 5.33tok/s)');
    // …and the board block renders it from BoardFacts.directives
    const block = renderProjectBoardBlock({ ...facts([quiet]), directives: naming });
    expect(block).toContain('GOALS: 0 active/blocked · 1 done (1 ⚠ suspect) · 0 archived');
    expect(block).toContain('- goal quiet000 [done ⚠ suspect: open_directive] "vLLM serving ≥20 tok/s on the quant box"');
    expect(renderProjectBoardBlock(facts([quiet]))).not.toContain('suspect');
  });

  it('project block: the GOALS header counts suspect closes and each rides its own [done ⚠ suspect] line', () => {
    const block = renderProjectBoardBlock(facts([spark, bench, clean]));
    expect(block).toContain('GOALS: 0 active/blocked · 3 done (2 ⚠ suspect) · 0 archived');
    // Review fix 2026-09-27 (finding 2): the remedy clause lives in the doctrine — the line is short.
    expect(block).toContain('- goal a57fb2e2 [done ⚠ suspect: premise_target_unmet (target_tok_per_s ≥20tok/s, observed 5.33tok/s)] "vLLM serving ≥20 tok/s" — closed 09-16 10:00Z\n');
    expect(block).toContain('- goal f6b31f1b [done ⚠ suspect: hold_token] "Redeploy canlegal-bench on :3001" — closed 09-13 12:00Z\n');
    expect(block).not.toContain('reopen it or record');
    expect(block).not.toContain('clean000');
    expect(block.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
  });

  it('finding 1 (review fix 2026-09-27): a done goal whose target premise was never observed is NOT badged — telemetry only', () => {
    const unobserved = { ...spark, id: 'unobs000-0000-4000-8000-000000000000', premises: [{ key: 'target_tok_per_s', value: 20, note: 'measured 24.1 in run r-9' }] };
    expect(suspectDoneGoals([unobserved], NOW.getTime())).toEqual([]);
    const block = renderProjectBoardBlock(facts([unobserved]));
    expect(block).toContain('GOALS: 0 active/blocked · 1 done · 0 archived');
    expect(block).not.toContain('suspect');
    // …and once the lane records the measured value (goal_premise_set observed) it stays clean; a recorded MISS badges.
    expect(suspectDoneGoals([{ ...unobserved, premises: [{ key: 'target_tok_per_s', value: 20, observed: 24.1, observedNote: 'run r-9' }] }], NOW.getTime())).toEqual([]);
    expect(suspectDoneGoals([{ ...unobserved, premises: [{ key: 'target_tok_per_s', value: 20, observed: 5.33, observedNote: 'run r-9' }] }], NOW.getTime())).toHaveLength(1);
  });

  it('finding 2 (review fix 2026-09-27): WORST-CASE board — BOARD_MAX_GOALS blocked goals with premises + 4 suspect closes + BOARD_MAX_OQ open questions + 20 todos keeps EVERY owner-question line and is never tail-truncated (suspect lines shrink before the slice)', () => {
    const { BOARD_MAX_GOALS, BOARD_MAX_OQ } = require('./board-digest.service');
    const long = (s: string, n: number) => `${s} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua`.slice(0, n);
    const premises = [1, 2, 3, 4].map((i) => ({ key: `untrained_base_suite_mean_${i}`, value: 60.07, unit: '%' }));
    const blocked = Array.from({ length: BOARD_MAX_GOALS }, (_, i) => ({
      id: uuid(`blk${i}`), title: long(`Blocked goal ${i}`, 72), status: 'blocked', blockKind: 'external', blockedReason: long(`Waiting on the vendor firmware drop ${i}`, 110), premises,
    }));
    const suspects = [1, 2, 3, 4].map((i) => ({ ...spark, id: uuid(`sus${i}`), title: long(`Suspect close ${i}`, 72) }));
    const oqs = Array.from({ length: BOARD_MAX_OQ }, (_, i) => ({ id: `oq_${String(i).padStart(8, '0')}`, question: long(`Owner question ${i}?`, 90), status: 'open', createdAt: hoursAgo(i + 1) }));
    const todos = Array.from({ length: 20 }, (_, i) => ({ id: uuid(`td${i}`), title: long(`Todo ${i}`, 72), status: 'pending', updatedAt: hoursAgo(i + 1) }));
    const block = renderProjectBoardBlock({ projectName: 'spark-cluster', goals: [...blocked, ...suspects], todos, ownerQuestions: oqs, now: NOW });
    expect(block.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
    expect(block).not.toContain('…[truncated]');
    expect(block).toContain('OWNER QUESTIONS:');
    for (const q of oqs) expect(block).toContain(`- ${q.id} OPEN since`);
    expect(block).toContain('TODOS: 20 open');
    expect(block).toContain(`GOALS: ${BOARD_MAX_GOALS} active/blocked · 4 done (4 ⚠ suspect) · 0 archived`);
    // The suspect closes shrank (to one line + marker, or to the marker alone) instead of eating the owner questions.
    expect(block).toMatch(/- …[1-4] more suspect closes? \(use goal_list\)/);
    // The SAME facts without the suspect closes render byte-identically apart from the GOALS header + suspect section.
    const without = renderProjectBoardBlock({ projectName: 'spark-cluster', goals: blocked, todos, ownerQuestions: oqs, now: NOW });
    expect(without).not.toContain('…[truncated]');
    for (const q of oqs) expect(without).toContain(`- ${q.id} OPEN since`);
  });

  it('a fifth suspect close beyond BOARD_MAX_SUSPECT_DONE rides as a "…1 more suspect close (use goal_list)" marker even when nothing shrinks', () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({ ...spark, id: uuid(`sus${i}`), title: `Suspect close ${i}` }));
    const block = renderProjectBoardBlock(facts(five));
    expect(block).toContain('GOALS: 0 active/blocked · 5 done (5 ⚠ suspect) · 0 archived');
    expect(block).toContain('- …1 more suspect close (use goal_list)');
    expect(block).not.toContain('sus50000');
  });

  it('project block: no suspect closes ⇒ the header and lines are byte-identical to before', () => {
    const block = renderProjectBoardBlock(facts([clean]));
    expect(block).toContain('GOALS: 0 active/blocked · 1 done · 0 archived');
    expect(block).not.toContain('suspect');
  });

  it('fleet roll-up: a project line carries "N ⚠ suspect done goal(s)" only when N > 0', () => {
    const block = renderFleetBoardBlock([
      { name: 'spark-cluster', projectId: 'p-spark000', activeGoals: 1, blockedGoals: 0, openTodos: 2, blockedTodos: 0, openOwnerQuestions: 0, suspectDoneGoals: 2 },
      { name: 'CanLaw', projectId: 'p-canlaw00', activeGoals: 3, blockedGoals: 1, openTodos: 4, blockedTodos: 1, openOwnerQuestions: 1 },
    ], [], NOW);
    expect(block).toContain('- spark-cluster (p-spark0): 1 active goal(s) · 2 open todo(s) · 0 open owner question(s) · 2 ⚠ suspect done goal(s)');
    expect(block).toContain('- CanLaw (p-canlaw): 3 active goal(s) (1 blocked) · 4 open todo(s) (1 blocked) · 1 open owner question(s)\n');
  });

  it('fleet loader: counts suspect closes per project from ONE bounded read of recent done goals', async () => {
    mockPrisma.crossModelProject.findMany.mockImplementationOnce(async () => [{ id: 'p-spark000', name: 'spark-cluster' }]);
    mockPrisma.projectGoal.findMany.mockImplementationOnce(async (args: any) => {
      expect(args.where).toEqual(expect.objectContaining({ status: 'done', projectId: { in: ['p-spark000'] } }));
      expect(args.take).toBe(200);
      return [{ ...spark, projectId: 'p-spark000' }, { ...clean, projectId: 'p-spark000' }];
    });
    const block = await buildBoardDigestBlock({ scope: 'fleet', userId: 'u-1', now: NOW });
    expect(block).toContain('1 ⚠ suspect done goal(s)');
  });
});
