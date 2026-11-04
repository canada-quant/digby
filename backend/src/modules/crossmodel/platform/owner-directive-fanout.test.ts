/**
 * OWNER-DIRECTIVE-FANOUT (2026-10-20) — the [OWNER DIRECTIVES IN FORCE] block.
 *
 * The gap it closes: an owner ruling banked on the Fleet Supervisor's ledger
 * (scope 'fleet' or a project's) never reached the project supervisor (its
 * wake renders only its own ledger) or the coding lanes doing the work. Pins:
 *  - selection: OPEN owner-origin rows only (the harness stamp — never a
 *    supervisor-written row, a supervisor / default answer, an ask or a done
 *    row), a STANDING 'fleet' row or a row scoped to THIS project (name or id,
 *    case-insensitive), never a scopeless or another project's row, and never
 *    a NON-standing 'fleet' row (review fix: 'fleet' is the default stamp of
 *    every owner message in the Fleet Supervisor chat — "halt the canlaw
 *    ladder" must not bind spark-cluster's lanes); the excluded (own) ledger
 *    is skipped AND seeds the dedupe (its ruling's Fleet copy stays out); a
 *    ruling and its project mirror (same id) render once;
 *  - render: heading names fleet + the project, standing rows first, each
 *    line carries the scope tag, id8 and date; the char cap drops the OLDEST
 *    non-standing row first, then the oldest standing one, and says so;
 *  - the builder reads the Fleet Supervisor's and THIS project's live
 *    supervisor ledgers BY CHAT ID (Fleet Supervisor's first — never an
 *    unordered take-50 of every state row), resolves the project name, fails
 *    open, and the kill switch OWNER_DIRECTIVE_FANOUT_DISABLED=1 returns no
 *    block;
 *  - telemetry: ONE aggregate owner_directive_delivered row per delivery.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findMany: jest.fn(async (): Promise<any[]> => []) },
  crossModelProject: { findUnique: jest.fn(async (): Promise<any> => ({ name: 'Apollo' })) },
  crossModelChat: {
    findFirst: jest.fn(async (): Promise<any> => ({ id: 'fleet-sup' })),
    findMany: jest.fn(async (): Promise<any[]> => [{ id: 'apollo-sup' }]),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// The ledger module's static graph reaches the dormancy gate / schedule modules —
// stub the two heavy edges (the parse + archive helpers under test are real).
jest.mock('../coding/dormancy-gate.service', () => ({ __esModule: true, evaluateProjectDormancy: jest.fn(async () => ({ dormant: false })) }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import {
  buildOwnerDirectivesInForceBlock,
  fleetRowBindsEveryProject,
  isFanoutCandidate,
  recordOwnerDirectiveDelivered,
  renderOwnerDirectivesInForceBlock,
  scopeMatchesTarget,
  selectOwnerDirectivesInForce,
  OWNER_DIRECTIVES_BLOCK_CHARS,
  OWNER_DIRECTIVES_BLOCK_HEADING,
} from './owner-directive-fanout';
import type { SupervisorDirective } from './supervisor-state.service';

const NOW = Date.now();
const day = 86_400_000;
const iso = (agoDays: number) => new Date(NOW - agoDays * day).toISOString();
// Default: an owner order typed into the Apollo PROJECT supervisor chat. A fleet-wide
// row must say so explicitly (scope 'fleet' + standing) — the review fix.
const dir = (over: Partial<SupervisorDirective> & { id: string; text: string }): SupervisorDirective =>
  ({ at: iso(1), status: 'open', origin: 'owner', scope: 'Apollo', ...over }) as SupervisorDirective;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OWNER_DIRECTIVE_FANOUT_DISABLED;
});
afterAll(() => { delete process.env.OWNER_DIRECTIVE_FANOUT_DISABLED; });

describe('selection', () => {
  it('only OPEN owner-origin orders qualify — never supervisor-written, supervisor / default answers, asks or done rows', () => {
    expect(isFanoutCandidate(dir({ id: 'a', text: 'x' }))).toBe(true);
    expect(isFanoutCandidate(dir({ id: 'b', text: 'x', origin: 'owner_question' }))).toBe(true);
    expect(isFanoutCandidate(dir({ id: 'c', text: 'x', origin: undefined }))).toBe(false);
    expect(isFanoutCandidate(dir({ id: 'd', text: 'x', origin: 'supervisor_answer' }))).toBe(false);
    expect(isFanoutCandidate(dir({ id: 'e', text: 'x', origin: 'default' }))).toBe(false);
    expect(isFanoutCandidate(dir({ id: 'f', text: 'x', kind: 'ask' }))).toBe(false);
    expect(isFanoutCandidate(dir({ id: 'g', text: 'x', status: 'done' }))).toBe(false);
    expect(isFanoutCandidate(dir({ id: 'h', text: '   ' }))).toBe(false);
  });

  it('scope: fleet → fleet (the standing gate is the selection\'s); the project by name or id (case / spacing insensitive); never scopeless or another project', () => {
    const t = { projectName: 'Apollo  Lander', projectId: 'p-1' };
    expect(scopeMatchesTarget('fleet', t)).toBe('fleet');
    expect(scopeMatchesTarget(' FLEET ', {})).toBe('fleet');
    expect(scopeMatchesTarget('apollo lander', t)).toBe('project');
    expect(scopeMatchesTarget('p-1', t)).toBe('project');
    expect(scopeMatchesTarget('Zeus', t)).toBeNull();
    expect(scopeMatchesTarget('', t)).toBeNull();
    expect(scopeMatchesTarget(undefined, t)).toBeNull();
    expect(scopeMatchesTarget('Apollo Lander', { projectId: null })).toBeNull(); // fleet-only target
  });

  it('across ledgers: excluded (own) ledger skipped, a ruling and its project mirror render once, another project never', () => {
    const fleetDoc = { directives: [
      dir({ id: 'oq_1111aaaa-ruling', text: 'Owner RULING (standing) — "no new boxes, ever"', origin: 'owner_question', standing: true, scope: 'fleet' }),
      dir({ id: 'own-apollo', text: 'Apollo ships behind the flag', scope: 'Apollo' }),
      dir({ id: 'own-zeus', text: 'Zeus pauses its GPU work', scope: 'Zeus' }),
      dir({ id: 'sup-row', text: 'Supervisor default rule', origin: undefined, scope: 'fleet', standing: true }),
    ] };
    const psDoc = { directives: [
      // the mirror of the same ruling (same id, project scope) — deduped
      dir({ id: 'oq_1111aaaa-ruling', text: 'Owner RULING (standing) — "no new boxes, ever"', origin: 'owner_question', standing: true, scope: 'Apollo' }),
      dir({ id: 'ps-own', text: 'Owner typed this in the Apollo supervisor', scope: 'Apollo' }),
    ] };
    const rows = selectOwnerDirectivesInForce(
      [{ chatId: 'fleet-sup', doc: fleetDoc }, { chatId: 'apollo-sup', doc: psDoc }],
      { projectName: 'Apollo', projectId: 'p-apollo' },
    );
    expect(rows.map((r) => r.id)).toEqual(['oq_1111aaaa-ruling', 'own-apollo', 'ps-own']);
    expect(rows[0]).toMatchObject({ match: 'fleet', standing: true, sourceChatId: 'fleet-sup' });
    // the project supervisor's own wake: its ledger is excluded (it renders there already) —
    // and so is the Fleet copy of the ruling its own ledger mirrors (same id)
    const psWake = selectOwnerDirectivesInForce(
      [{ chatId: 'fleet-sup', doc: fleetDoc }, { chatId: 'apollo-sup', doc: psDoc }],
      { projectName: 'Apollo', projectId: 'p-apollo', excludeChatId: 'apollo-sup' },
    );
    expect(psWake.map((r) => r.id)).toEqual(['own-apollo']);
  });
});

describe('selection — a \'fleet\' row binds every project only when STANDING (review fix)', () => {
  it('a NON-standing owner order typed into the Fleet Supervisor chat (scope fleet) is NOT delivered to a lane', () => {
    const fleetDoc = { directives: [
      dir({ id: 'fs-order', text: 'kill the canlaw H100 bench and delete its branches', scope: 'fleet' }),
      dir({ id: 'fs-rule', text: 'from now on never buy new GPU boxes', scope: 'fleet', standing: true }),
      dir({ id: 'fs-apollo', text: 'Apollo: freeze the release branch', scope: 'Apollo' }),
    ] };
    const lane = selectOwnerDirectivesInForce([{ chatId: 'fleet-sup', doc: fleetDoc }], { projectName: 'Apollo', projectId: 'p-apollo' });
    expect(lane.map((r) => r.id)).toEqual(['fs-rule', 'fs-apollo']);
    // nor to another project's lane
    const zeus = selectOwnerDirectivesInForce([{ chatId: 'fleet-sup', doc: fleetDoc }], { projectName: 'Zeus', projectId: 'p-zeus' });
    expect(zeus.map((r) => r.id)).toEqual(['fs-rule']);
    expect(fleetRowBindsEveryProject({ standing: true })).toBe(true);
    expect(fleetRowBindsEveryProject({})).toBe(false);
  });

  it('a project supervisor wake: its own ledger seeds the dedupe — the Fleet copy of its mirrored ruling (same id) and a same-text owner row stay out', () => {
    const fleetDoc = { directives: [
      dir({ id: 'oq_3333cccc-ruling', text: 'Owner RULING (standing) — "no new Hyperstack IPs, ever"', origin: 'owner_question', standing: true, scope: 'fleet' }),
      dir({ id: 'fleet-twin', text: 'Apollo ships behind the flag', scope: 'Apollo' }),
      dir({ id: 'fleet-other', text: 'Apollo uses the sim harness', scope: 'Apollo' }),
    ] };
    const psDoc = { directives: [
      dir({ id: 'oq_3333cccc-ruling', text: 'Owner RULING (standing) — "no new Hyperstack IPs, ever"', origin: 'owner_question', standing: true, scope: 'Apollo' }),
      dir({ id: 'ps-own', text: 'Apollo ships  behind the FLAG', scope: 'Apollo' }),
    ] };
    const psWake = selectOwnerDirectivesInForce(
      [{ chatId: 'fleet-sup', doc: fleetDoc }, { chatId: 'apollo-sup', doc: psDoc }],
      { projectName: 'Apollo', projectId: 'p-apollo', excludeChatId: 'apollo-sup' },
    );
    expect(psWake.map((r) => r.id)).toEqual(['fleet-other']);
  });
});

describe('render', () => {
  it('heading + guide, standing first, each line tagged with scope, id8 and date', () => {
    const rows = selectOwnerDirectivesInForce([{ chatId: 'fleet-sup', doc: { directives: [
      dir({ id: 'proj-new-0001', text: 'Apollo uses the sim harness', scope: 'Apollo', at: iso(1) }),
      dir({ id: 'fleet-std-0002', text: 'No new GPU boxes, ever', standing: true, scope: 'fleet', at: iso(5) }),
    ] } }], { projectName: 'Apollo' });
    const { block, shown, hidden } = renderOwnerDirectivesInForceBlock(rows, { projectName: 'Apollo' });
    const lines = block.split('\n');
    expect(lines[0]).toBe(`${OWNER_DIRECTIVES_BLOCK_HEADING} — scope: fleet + Apollo]`);
    expect(lines[1]).toMatch(/BIND this work/);
    expect(lines[1]).toMatch(/never a relay or a paraphrase/);
    expect(lines[2]).toBe(`- [fleet] No new GPU boxes, ever (fleet-st, ${iso(5).slice(0, 10)}, standing)`);
    expect(lines[3]).toBe(`- [Apollo] Apollo uses the sim harness (proj-new, ${iso(1).slice(0, 10)})`);
    expect(shown).toHaveLength(2);
    expect(hidden).toBe(0);
  });

  it('nothing in force → empty block', () => {
    expect(renderOwnerDirectivesInForceBlock([])).toEqual({ block: '', shown: [], hidden: 0 });
  });

  it('the cap drops the OLDEST non-standing rows first, then the oldest standing, and names the hidden count', () => {
    const directives = [
      ...Array.from({ length: 3 }, (_, i) => dir({ id: `std-${i}`, text: `Standing rule ${i} ${'s'.repeat(80)}`, standing: true, scope: 'fleet', at: iso(10 + i) })),
      ...Array.from({ length: 8 }, (_, i) => dir({ id: `ord-${i}`, text: `Order ${i} ${'o'.repeat(80)}`, at: iso(i) })),
    ];
    const rows = selectOwnerDirectivesInForce([{ chatId: 'f', doc: { directives } }], { projectName: 'Apollo' });
    expect(rows).toHaveLength(11);
    const { block, shown, hidden } = renderOwnerDirectivesInForceBlock(rows, { projectName: 'Apollo' });
    expect(block.length).toBeLessThanOrEqual(OWNER_DIRECTIVES_BLOCK_CHARS);
    expect(hidden).toBeGreaterThan(0);
    expect(block).toMatch(new RegExp(`\\(\\+${hidden} older owner directives? in force not shown`));
    // every standing row survives while any non-standing row was dropped, and the newest orders survive the oldest
    const ids = shown.map((r) => r.id);
    expect(ids.filter((id) => id.startsWith('std-'))).toEqual(['std-0', 'std-1', 'std-2']);
    expect(ids).toContain('ord-0');
    expect(ids).not.toContain('ord-7');
    // a block of only standing rows past the cap drops the OLDEST standing one
    const onlyStanding = selectOwnerDirectivesInForce([{ chatId: 'f', doc: { directives: Array.from({ length: 9 }, (_, i) => dir({ id: `s${i}`, text: `Rule ${i} ${'r'.repeat(200)}`, standing: true, scope: 'fleet', at: iso(i) })) } }], {});
    const r2 = renderOwnerDirectivesInForceBlock(onlyStanding);
    expect(r2.block.length).toBeLessThanOrEqual(OWNER_DIRECTIVES_BLOCK_CHARS);
    expect(r2.shown.map((r) => r.id)).toContain('s0');
    expect(r2.shown.map((r) => r.id)).not.toContain('s8');
  });
});

describe('buildOwnerDirectivesInForceBlock', () => {
  const fleetState = { directives: [
    dir({ id: 'oq_2222bbbb-ruling', text: 'Owner RULING (standing) — "digby defaults use the github secrets, always"', origin: 'owner_question', standing: true, scope: 'fleet' }),
    // an ordinary owner order typed into the projectless Fleet Supervisor chat — stamped 'fleet', NOT standing
    dir({ id: 'fs-order-1', text: 'halt the canlaw ladder until I say', scope: 'fleet' }),
  ], archived: [], dispatches: [], projects: [], notes: '', refutations: [] };
  const psState = { directives: [dir({ id: 'ps-1', text: 'Apollo: ship on Fridays', scope: 'Apollo' })], archived: [], dispatches: [], projects: [], notes: '', refutations: [] };

  it('reads the Fleet Supervisor\'s + this project\'s supervisor ledgers by chat id, resolves the project name, Fleet Supervisor first', async () => {
    mockPrisma.supervisorState.findMany.mockResolvedValue([{ chatId: 'apollo-sup', state: psState }, { chatId: 'fleet-sup', state: fleetState }]);
    const r = await buildOwnerDirectivesInForceBlock('u1', 'p-apollo');
    // BY CHAT ID: the Fleet Supervisor's ledger + this project's live supervisor chats — never a take-50 of every state row
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', projectId: 'p-apollo', isProjectSupervisor: true, archivedAt: null } }));
    expect(mockPrisma.supervisorState.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', chatId: { in: ['fleet-sup', 'apollo-sup'] } } }));
    expect(mockPrisma.supervisorState.findMany.mock.calls[0][0]).not.toHaveProperty('take');
    expect(mockPrisma.crossModelProject.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-apollo' } }));
    expect(r.block).toContain('scope: fleet + Apollo]');
    expect(r.block).toContain('github secrets, always');
    expect(r.block).toContain('Apollo: ship on Fridays');
    expect(r.shown[0].sourceChatId).toBe('fleet-sup');
    // the non-standing Fleet Supervisor chat order is NOT delivered to an Apollo lane
    expect(r.block).not.toContain('halt the canlaw ladder');
    expect(r.shown.map((d) => d.id)).not.toContain('fs-order-1');
  });

  it('a fleet-only read (no project) reads the Fleet Supervisor ledger alone', async () => {
    mockPrisma.supervisorState.findMany.mockResolvedValue([{ chatId: 'fleet-sup', state: fleetState }]);
    await buildOwnerDirectivesInForceBlock('u1', null);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.supervisorState.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', chatId: { in: ['fleet-sup'] } } }));
  });

  it('a project supervisor wake excludes its own ledger; fleet scope only without a project', async () => {
    mockPrisma.supervisorState.findMany.mockResolvedValue([{ chatId: 'apollo-sup', state: psState }, { chatId: 'fleet-sup', state: fleetState }]);
    const own = await buildOwnerDirectivesInForceBlock('u1', 'p-apollo', { excludeChatId: 'apollo-sup' });
    expect(own.block).not.toContain('ship on Fridays');
    const fleetOnly = await buildOwnerDirectivesInForceBlock('u1', null);
    expect(fleetOnly.block).toContain('scope: fleet]');
    expect(fleetOnly.block).not.toContain('ship on Fridays');
  });

  it('kill switch → no read, no block; a DB failure → no block (never throws)', async () => {
    process.env.OWNER_DIRECTIVE_FANOUT_DISABLED = '1';
    expect((await buildOwnerDirectivesInForceBlock('u1', 'p-apollo')).block).toBe('');
    expect(mockPrisma.supervisorState.findMany).not.toHaveBeenCalled();
    delete process.env.OWNER_DIRECTIVE_FANOUT_DISABLED;
    mockPrisma.supervisorState.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await buildOwnerDirectivesInForceBlock('u1', 'p-apollo')).toEqual({ block: '', shown: [], hidden: 0 });
  });
});

describe('telemetry', () => {
  it('ONE aggregate owner_directive_delivered row per delivery; nothing shown → no row', async () => {
    const rows = selectOwnerDirectivesInForce([{ chatId: 'f', doc: { directives: [dir({ id: 'aaaaaaaa-1', text: 'one', scope: 'fleet', standing: true }), dir({ id: 'bbbbbbbb-2', text: 'two', scope: 'Apollo' })] } }], { projectName: 'Apollo' });
    recordOwnerDirectiveDelivered({ targetChatId: 'lane-12345678', surface: 'lane_run', shown: rows, hidden: 1, runId: 'run-1' });
    recordOwnerDirectiveDelivered({ targetChatId: 'lane-12345678', surface: 'lane_run', shown: [], hidden: 0 });
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_directive_delivered', sessionId: 'lane-12345678', runId: 'run-1', value: 2,
      meta: expect.objectContaining({ directiveIds: ['aaaaaaaa-1', 'bbbbbbbb-2'], targetChatId: 'lane-123', surface: 'lane_run', fleet: 1, project: 1, hidden: 1 }),
    }));
  });
});
