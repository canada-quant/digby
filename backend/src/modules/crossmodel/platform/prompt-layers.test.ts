/**
 * prompt-layers.test.ts — the layered-prompt contract (2026-09-27):
 *   - a scaffolded PROJECT SUPERVISOR prompt contains ITS project's brief
 *     (mission, instructions, goals, repos, budget, standing decisions) and no
 *     OTHER project's name or incident; its standing decisions are OWNER-ORIGIN
 *     only (answered owner questions first, then harness-stamped rows scoped
 *     to the project — never a scopeless / supervisor-written / other-project
 *     row), and the goal view is the STABLE one (creation order, no lane
 *     blockedReason, no model contextState) so the heal does not churn;
 *   - the project layer is FITTED to its budget at render time (every cap
 *     filled still renders ≤ LAYER_BUDGETS.project; rows drop from the tail);
 *   - the fleet prompt carries no project brief and no project name;
 *   - the composed builders are the only path (the pre-layering legacy*
 *     builders + PROMPT_LAYERING_DISABLED were deleted, build 2026-10-08 S-2);
 *   - layer markers + the v2 version marker; splitLayers round-trips; the
 *     per-layer budgets hold; no sentence appears in two layers;
 *   - the facts block fits its cap with EVERY registered purpose in act;
 *   - the brief renderer omits empty fields and clips long ones;
 *   - the re-scaffold helper rewrites a v1 lane (paused project included),
 *     leaves a customized prompt alone, and reports dry runs.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  user: { findUnique: jest.fn(async () => ({ isChild: false })) },
  crossModelProject: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []), create: jest.fn(), update: jest.fn(async () => ({})) },
  projectGoal: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  store: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
  chatAutonomy: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
  chatSchedule: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })), deleteMany: jest.fn(async () => ({ count: 0 })) },
  eventHook: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
  activity: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null) },
  chatCodingState: { findUnique: jest.fn(async () => null) },
  agentRun: { count: jest.fn(async () => 0) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn() } }));
jest.mock('../coding/schedule.service', () => ({ __esModule: true, emitScheduleDisabled: jest.fn(async () => undefined) }));
jest.mock('../coding/dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateProjectDormancy: jest.fn(async () => ({ dormant: false })),
  evaluateAccountDormancy: jest.fn(async () => ({ dormant: false })),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  getSupervisorState: jest.fn(async () => ({ directives: [
    // harness-stamped owner row scoped to Apollo → IN
    { id: 'd1', text: 'Ship the benchmark pack by Friday', at: '2026-09-20T10:00:00Z', status: 'open', standing: true, scope: 'Apollo', origin: 'owner' },
    // another project's row (scoped, owner-stamped) → OUT
    { id: 'd2', text: 'Another project only: pause its GPU work', at: '2026-09-21T10:00:00Z', status: 'open', scope: 'Zeus', origin: 'owner' },
    // a SCOPELESS row naming another project — supervisor-written (no stamp) → OUT
    { id: 'd3', text: 'HALT band: Zeus training stays parked until the owner lifts it', at: '2026-09-21T11:00:00Z', status: 'open' },
    // Apollo-scoped but NO stamp (the supervisor's own update_supervisor_state merge) → OUT
    { id: 'd4', text: 'Default rule: Apollo runs pause after 3 failed evals', at: '2026-09-21T12:00:00Z', status: 'open', scope: 'Apollo' },
    // an owner row scoped 'fleet' — not THIS project's scope → OUT
    { id: 'd5', text: 'Fleet-wide: use all hardware', at: '2026-09-21T13:00:00Z', status: 'open', scope: 'fleet', origin: 'owner' },
    // the banked ruling for an answered question the table already lists → deduped
    { id: 'd6', text: 'Owner ANSWERED flagged question — Q: "Use the sim harness or live hardware?" A: "Sim harness."', at: '2026-09-22T10:00:00Z', status: 'done', evidence: 'oq oq_aaaabbbb', scope: 'Apollo', origin: 'owner_question' },
    // a banked ruling outside the table's window → IN (a done row with the owner_question stamp is a decision)
    { id: 'd7', text: 'Owner ANSWERED flagged question — Q: "Metric or imperial?" A: "Metric."', at: '2026-09-10T10:00:00Z', status: 'done', evidence: 'oq oq_ccccdddd', scope: 'Apollo', origin: 'owner_question' },
    // an owner STATUS QUESTION captured as kind:'ask' (sup/upward-chatter) — owner-stamped and scoped, but a question, not a decision → OUT
    { id: 'd8', text: 'any progress on the benchmark pack?', at: '2026-09-23T10:00:00Z', status: 'open', scope: 'Apollo', origin: 'owner', kind: 'ask', messageId: 'msg-ask-1' },
  ], archived: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));

import {
  composePrompt, splitLayers, isLayeredPrompt, LAYERS_VERSION_MARKER, layerMarker, LAYER_BUDGETS, LAYER_BUDGET_MAX_HEADROOM,
  duplicateSentencesAcrossLayers,
} from './prompt-layers';
import { renderProjectBrief, minimalProjectBrief, BRIEF_HEADING, BRIEF_CAPS, BRIEF_CLIPPED_LINE, PROJECT_BRIEF_BUDGET, type ProjectBrief } from './project-brief.model';
import { maximalProjectBrief } from './project-brief.fixtures';
import { loadProjectBrief, clearProjectBriefCache } from './project-brief.loader';
import { lintComposedPrompt, lintPromptText } from './prompt-hygiene';
import { frameworkFactsBlock, FRAMEWORK_FACTS_MAX_CHARS, FRAMEWORK_FACTS_HEADING } from './framework-facts';
import { DECISION_PURPOSES } from './decision-gate-modes';
import { coreDoctrine, CORE_STANDING_DIRECTIVES, CORE_RULE_IDS } from './core-doctrine';
import { fleetSupervisorRoleProfile, projectSupervisorRoleProfile, retireAutoArchiveClause } from './role-profiles';
import {
  buildFleetSupervisorPrompt, buildFleetSweepPrompt, SUPERVISOR_PROMPT_OPENER,
} from './supervisor.service';
import {
  buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt,
  rescaffoldProjectSupervisorPrompt, ensureProjectSupervisor, PROJECT_SUPERVISOR_PROMPT_OPENER, PROJECT_SUPERVISOR_HOOK_EVENT_TYPES,
} from './project-supervisor.service';
import { machineWakePreamble } from '../chat-agent/machine-wake';
import { orchestratorRoleGuidance } from '../coding/roles';

const APOLLO: ProjectBrief = {
  name: 'Apollo', id: 'p-apollo',
  mission: 'Ship a lunar-lander telemetry benchmark.',
  instructions: 'Always report distances in metres. Prefer the sim harness over live hardware.',
  goals: [{ id: 'g-1234abcd', title: 'Benchmark pack v2', status: 'active' }, { id: 'g-5678ef00', title: 'Sim parity', status: 'blocked', blockedReason: 'waiting on the telemetry export' }],
  premises: [{ key: 'baseline_score', value: 0.61, unit: 'f1', source: 'https://example.test/results.json' }],
  repos: [{ url: 'https://github.com/example/apollo', provider: 'github', defaultBranch: 'main', githubLabel: 'work' }],
  environments: [{ name: 'sim-cluster-a', kind: 'gpu reservation', access: 'via the paired box' }],
  budget: { policy: 'envelope', envelope: '$400/day', note: 'owner-set' },
  codingModel: 'the workspace default seat',
  standingDecisions: [{ at: '2026-09-20T10:00:00Z', text: 'Ship the benchmark pack by Friday', evidence: 'oq_11aa22bb' }],
  preferences: ['Name goals by milestone', 'Report in metric units'],
  contextState: 'The sim harness is green; hardware runs resume next week.',
};
const ZEUS_NAME = 'Zeus';

afterEach(() => {
  clearProjectBriefCache();
  jest.clearAllMocks();
});

describe('composePrompt — the layer contract', () => {
  it('emits the opener at offset 0, the v2 marker on line 2, one marker per non-empty layer, in precedence order', () => {
    const r = composePrompt({ role: 'project_supervisor', opener: 'You are X — a supervisor.', core: '## Core\n- rule', facts: '## Harness facts as of 2026-09-27\n- f', project: APOLLO, roleProfile: '## Role\n- duty', chat: { systemPrompt: 'Owner words.', envelope: '[MACHINE]' } });
    expect(r.text.startsWith('You are X — a supervisor.\n\n' + LAYERS_VERSION_MARKER)).toBe(true);
    const order = ['core', 'facts', 'project', 'role', 'chat'].map(id => r.text.indexOf(layerMarker(id as any)));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.layers.map(l => l.id)).toEqual(['core', 'facts', 'project', 'role', 'chat']);
    expect(isLayeredPrompt(r.text)).toBe(true);
    expect(isLayeredPrompt('You are X — plain old prompt')).toBe(false);
    // empty layers are omitted, not emitted blank
    const slim = composePrompt({ role: 'fleet_supervisor', opener: 'O', core: 'C', facts: '', roleProfile: 'R' });
    expect(slim.layers.map(l => l.id)).toEqual(['core', 'role']);
    expect(slim.text).not.toContain(layerMarker('facts'));
  });

  it('splitLayers round-trips the bodies; the duplicate check sees a sentence in two layers', () => {
    const s = 'This exact sentence is long enough to be counted as a duplicate by the checker.';
    const r = composePrompt({ role: 'chat', opener: 'O', core: `## A\n- ${s}`, roleProfile: `## B\n- ${s}` });
    const layers = splitLayers(r.text);
    expect(layers.map(l => l.id)).toEqual(['opener', 'core', 'role']);
    expect(layers[1].body).toBe(`## A\n- ${s}`);
    expect(duplicateSentencesAcrossLayers(r.text)).toEqual([s.toLowerCase()]);
  });
});

describe('ProjectBrief — render + load', () => {
  it('renders every recorded field deterministically and OMITS empty ones (a minimal brief is name + id only)', () => {
    const full = renderProjectBrief(APOLLO);
    expect(full.startsWith(`${BRIEF_HEADING}\nProject "Apollo" (projectId p-apollo).`)).toBe(true);
    for (const s of ['Mission: Ship a lunar-lander', 'Owner instructions for this project', 'Always report distances in metres', '[active] Benchmark pack v2 (goal g-1234ab)', 'blocked: waiting on the telemetry export',
      'baseline_score = 0.61 f1', 'https://github.com/example/apollo (default branch main) via GitHub account work', 'sim-cluster-a [gpu reservation]', 'ENVELOPE $400/day', 'Coding seat for this project', '2026-09-20: Ship the benchmark pack by Friday (oq_11aa22bb)', 'Name goals by milestone', 'Project state summary: The sim harness is green']) {
      expect(full).toContain(s);
    }
    expect(renderProjectBrief(minimalProjectBrief('Apollo', 'p-apollo'))).toBe(`${BRIEF_HEADING}\nProject "Apollo" (projectId p-apollo).`);
    expect(renderProjectBrief(APOLLO)).toBe(renderProjectBrief(APOLLO));
    // clipping: a 5,000-char instruction block renders ≤ its cap
    const long = renderProjectBrief({ ...minimalProjectBrief('L', 'l'), instructions: 'x'.repeat(5_000) });
    expect(long.length).toBeLessThan(1_400);
    expect(long).toContain('…');
  });

  it('loadProjectBrief fills the brief from the project record + goals + settings + owner-origin decisions, and fails open per source', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p-apollo', name: 'Apollo', description: 'Ship a lunar-lander telemetry benchmark.', systemPrompt: 'Always report distances in metres.', path: '', repoUrl: 'https://github.com/example/apollo', repoProvider: 'github', defaultBranch: 'main', githubLabel: 'work' });
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: 'g-1234abcd', title: 'Benchmark pack v2', status: 'active', blockedReason: null, premises: [{ key: 'baseline_score', value: 0.61, unit: 'f1' }] }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1' }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_aaaabbbb', question: 'Use the sim harness or live hardware?', answer: 'Sim harness.', chosenOption: null, resolvedAt: new Date('2026-09-22T10:00:00Z') }]);
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'sup1', bypassCache: true });
    expect(brief.name).toBe('Apollo');
    expect(brief.mission).toContain('lunar-lander');
    expect(brief.instructions).toContain('metres');
    expect(brief.goals?.[0].title).toBe('Benchmark pack v2');
    expect(brief.premises?.[0].key).toBe('baseline_score');
    expect(brief.repos?.[0].url).toContain('example/apollo');
    // standing decisions are OWNER-ORIGIN only: the answered owner question comes FIRST (the table is the
    // one source that is owner-origin by construction), then the harness-stamped rows scoped to Apollo
    const decisions = brief.standingDecisions ?? [];
    const texts = decisions.map(d => d.text).join('\n');
    expect(decisions[0]).toEqual(expect.objectContaining({ evidence: 'oq_aaaabbbb', text: expect.stringContaining('A: Sim harness.') }));
    expect(texts).toContain('Ship the benchmark pack by Friday');      // owner-typed, scoped Apollo → in
    expect(texts).toContain('Q: "Metric or imperial?" A: "Metric."');  // banked ruling outside the table window → in
    expect(texts.split('Sim harness.').length).toBe(2);                // the banked copy of a listed answer is deduped
    expect(texts).not.toContain('Zeus');                                // another project's scoped row → out
    expect(texts).not.toContain('HALT band');                           // SCOPELESS row naming another project (no stamp) → out
    expect(texts).not.toContain('Default rule');                        // Apollo-scoped but supervisor-written (no stamp) → out
    expect(texts).not.toContain('Fleet-wide');                          // an owner row scoped 'fleet' is not THIS project's → out
    expect(texts).not.toContain('any progress on the benchmark pack');  // an owner ASK (kind:'ask') is a question, never a standing decision → out
    // the STABLE goal view: creation order, no lane-authored blockedReason, no model-extracted contextState
    const goalQuery = mockPrisma.projectGoal.findMany.mock.calls[0][0];
    expect(goalQuery.orderBy).toEqual([{ status: 'asc' }, { createdAt: 'asc' }]);
    expect(goalQuery.select.blockedReason).toBeUndefined();
    expect(brief.goals?.[0]).toEqual({ id: 'g-1234abcd', title: 'Benchmark pack v2', status: 'active' });
    expect(brief.contextState).toBeUndefined();
    // fail-open: a project that cannot be read → minimal brief, never a throw
    mockPrisma.crossModelProject.findUnique.mockRejectedValueOnce(new Error('db down'));
    const minimal = await loadProjectBrief('p-gone', 'u1', { bypassCache: true });
    expect(minimal).toEqual({ name: '(unknown project)', id: 'p-gone' });
  });

  it('answered owner questions are never crowded out of the decision cap by state-doc rows', async () => {
    const { getSupervisorState } = jest.requireMock('./supervisor-state.service');
    getSupervisorState.mockResolvedValueOnce({
      directives: Array.from({ length: 14 }, (_, i) => ({ id: `o${i}`, text: `Owner order ${i}`, at: `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`, status: 'open', scope: 'Apollo', origin: 'owner' })),
      archived: [], dispatches: [], projects: [], notes: '', refutations: [],
    });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p-apollo', name: 'Apollo', description: null, systemPrompt: null, path: '', repoUrl: null });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1' }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_zzzz0001', question: 'Ship on Friday?', answer: 'Yes.', chosenOption: null, resolvedAt: new Date('2026-09-25T10:00:00Z') }]);
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'sup1', bypassCache: true });
    expect(brief.standingDecisions).toHaveLength(BRIEF_CAPS.decisions);
    expect(brief.standingDecisions?.[0].evidence).toBe('oq_zzzz0001');
    expect(brief.standingDecisions?.[1].text).toBe('Owner order 0');
  });
});

describe('ProjectBrief — the project layer budget is ENFORCED at render time', () => {
  it('a brief with EVERY cap filled (and over) renders within LAYER_BUDGETS.project, keeps the identity line + the owner\'s words, drops the volatile ledger views first, and says it was clipped', () => {
    const full = maximalProjectBrief('Apollo', 'p-apollo');
    const text = renderProjectBrief(full);
    expect(LAYER_BUDGETS.project).toBe(PROJECT_BRIEF_BUDGET);
    expect(text.length).toBeLessThanOrEqual(LAYER_BUDGETS.project);
    expect(text.startsWith(`${BRIEF_HEADING}\nProject "Apollo" (projectId p-apollo).`)).toBe(true);
    expect(text).toContain('- Owner instructions for this project');
    expect(text).toContain('- Mission: ');
    expect(text.endsWith(BRIEF_CLIPPED_LINE)).toBe(true);
    expect(text).not.toContain('Project state summary'); // contextState is the first section dropped
    expect(text).not.toContain('Registered premises');    // then the premises
    expect(renderProjectBrief(full)).toBe(text);           // deterministic
    // an un-fitted render of the same brief is far over budget — the loop, not the caps, holds the line
    expect(renderProjectBrief(full, 1_000_000).length).toBeGreaterThan(LAYER_BUDGETS.project * 3);
    expect(renderProjectBrief(full, 1_000_000)).not.toContain(BRIEF_CLIPPED_LINE);
    // through the composer + the lint: the project layer is within budget
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', brief: full });
    expect(splitLayers(p).find(l => l.id === 'project')!.body.length).toBeLessThanOrEqual(LAYER_BUDGETS.project);
    expect(lintComposedPrompt({ source: 'project supervisor', text: p }).filter(f => f.rule === 'over_budget')).toEqual([]);
    // a brief that fits carries no clipped line
    expect(renderProjectBrief(APOLLO)).not.toContain(BRIEF_CLIPPED_LINE);
  });

  it('drops rows from the TAIL of a list before the list itself, so the first decisions survive a squeeze', () => {
    const decisions = Array.from({ length: 10 }, (_, i) => ({ at: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`, text: `Decision ${i + 1}: ${'d'.repeat(220)}`, evidence: `oq_0000000${i}` }));
    const brief: ProjectBrief = { ...minimalProjectBrief('Apollo', 'p-apollo'), instructions: 'i'.repeat(1_150), mission: 'm'.repeat(590), standingDecisions: decisions };
    const text = renderProjectBrief(brief);
    expect(text.length).toBeLessThanOrEqual(LAYER_BUDGETS.project);
    expect(text).toContain('- Owner standing decisions');
    expect(text).toContain('Decision 1:');
    expect(text).not.toContain('Decision 10:');
    expect(text).toContain('- Mission: ');
    expect(text.endsWith(BRIEF_CLIPPED_LINE)).toBe(true);
  });
});

describe('the scaffolded PROJECT SUPERVISOR prompt is built for ITS project', () => {
  const apolloPrompt = () => buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', brief: APOLLO });

  it('carries the project layer with ITS brief (mission, instructions, goals, repo, budget, decisions) between the facts and the role profile', () => {
    const p = apolloPrompt();
    expect(p.startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)).toBe(true);
    const project = splitLayers(p).find(l => l.id === 'project')!;
    expect(project.body).toContain('Project "Apollo" (projectId p-apollo)');
    expect(project.body).toContain('Mission: Ship a lunar-lander telemetry benchmark.');
    expect(project.body).toContain('Always report distances in metres');
    expect(project.body).toContain('Benchmark pack v2');
    expect(project.body).toContain('https://github.com/example/apollo');
    expect(project.body).toContain('ENVELOPE $400/day');
    expect(project.body).toContain('Ship the benchmark pack by Friday');
    expect(p.indexOf(layerMarker('facts'))).toBeLessThan(p.indexOf(layerMarker('project')));
    expect(p.indexOf(layerMarker('project'))).toBeLessThan(p.indexOf(layerMarker('role')));
  });

  it('names NO other project and NO incident: the generic layers are project-free, and the whole prompt never mentions another project', () => {
    const p = apolloPrompt();
    for (const other of [ZEUS_NAME, 'CanLaw', 'dflash2', 'Nebius', 'spark', 'SFT-2', 'IDEaS', 'HX300', 'Serve GLM']) expect(p).not.toContain(other);
    // no incident tokens anywhere in the composed prompt
    expect(p).not.toMatch(/\bticket [0-9a-f]{8}\b|\bfeedback [0-9a-f]{8}\b|\(owner 20\d\d/);
    // the brief's own decision evidence (an oq id) is allowed — it is THIS project's record
    expect(p).toContain('oq_11aa22bb');
  });

  it('a brief for a DIFFERENT project id is refused — the prompt falls back to name + id (never another project\'s brief)', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Zeus', projectId: 'p-zeus', fleetSupervisorChatId: null, brief: APOLLO });
    expect(p).toContain('Project "Zeus" (projectId p-zeus).');
    expect(p).not.toContain('Apollo');
    expect(p).not.toContain('lunar-lander');
  });

  it('a project with nothing recorded renders the same bytes as the name+id-only scaffold (no heal churn on empty projects)', () => {
    const a = buildProjectSupervisorPrompt({ projectName: 'Empty', projectId: 'p-empty', fleetSupervisorChatId: 'f' });
    const b = buildProjectSupervisorPrompt({ projectName: 'Empty', projectId: 'p-empty', fleetSupervisorChatId: 'f', brief: minimalProjectBrief('Empty', 'p-empty') });
    expect(a).toBe(b);
  });

  it('ensureProjectSupervisor scaffolds a NEW lane with the loaded brief (mission + instructions from the project row)', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p-apollo', userId: 'u1', name: 'Apollo', isUserSpace: false, archivedAt: null, projectSupervisorEnabled: true, description: 'Ship a lunar-lander telemetry benchmark.', systemPrompt: 'Always report distances in metres.', path: '', repoUrl: null });
    mockPrisma.crossModelChat.findFirst.mockImplementation(async ({ where }: any) => (where?.isSupervisor === true ? { id: 'fleet1', title: 'Fleet Supervisor', userId: 'u1' } : null));
    mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({ id: 'psup1', userId: 'u1', projectId: 'p-apollo', ...data }));
    const chat = await ensureProjectSupervisor('u1', 'p-apollo');
    expect(chat?.id).toBe('psup1');
    const stored = mockPrisma.crossModelChat.create.mock.calls[0][0].data.systemPrompt as string;
    expect(isLayeredPrompt(stored)).toBe(true);
    expect(stored).toContain('Mission: Ship a lunar-lander telemetry benchmark.');
    expect(stored).toContain('Always report distances in metres');
    expect(stored).toContain(CORE_STANDING_DIRECTIVES);
  });
});

describe('the FLEET SUPERVISOR prompt', () => {
  it('has core + facts + role layers, NO project layer, and names no project', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p.startsWith(SUPERVISOR_PROMPT_OPENER)).toBe(true);
    expect(splitLayers(p).map(l => l.id)).toEqual(['opener', 'core', 'facts', 'role']);
    for (const other of ['Apollo', 'CanLaw', 'dflash2', 'Nebius', 'spark', 'IDEaS', 'HX300', 'crossmodel project']) expect(p).not.toContain(other);
    expect(p).toContain(coreDoctrine('fleet'));
    expect(p).toContain(fleetSupervisorRoleProfile());
  });
});

describe('the composed builders are the only path (build 2026-10-08 S-2)', () => {
  it('both system prompts carry the layer markers; the preamble + coding guidance are generic', () => {
    expect(buildFleetSupervisorPrompt()).toContain(LAYERS_VERSION_MARKER);
    expect(buildFleetSupervisorPrompt()).not.toContain('## Harness facts you must not misread (2026-09-25/26)');
    expect(machineWakePreamble(new Date('2026-09-27T00:00:00Z'))).toContain('(rule gate.outcome)');
    expect(machineWakePreamble(new Date('2026-09-27T00:00:00Z'))).not.toContain('wake_triage');
    expect(orchestratorRoleGuidance()).toContain(FRAMEWORK_FACTS_HEADING);
    expect(orchestratorRoleGuidance()).not.toContain('HARNESS FACTS (2026-09-25/26)');
    // the sweep bodies are the generic ledger-diff shape
    expect(buildFleetSweepPrompt()).toContain('(rule gate.outcome)');
    expect(buildProjectSupervisorSweepPrompt({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1' })).toContain('(rule gate.outcome)');
  });
});

describe('budgets + facts', () => {
  it('every layer of both composed prompts is within its budget and no sentence repeats across layers', () => {
    for (const p of [buildFleetSupervisorPrompt(), buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', brief: APOLLO })]) {
      for (const layer of splitLayers(p)) {
        if (layer.id === 'opener') continue;
        expect(layer.body.length).toBeLessThanOrEqual(LAYER_BUDGETS[layer.id]);
      }
      expect(duplicateSentencesAcrossLayers(p)).toEqual([]);
    }
    // the role profiles alone sit under the role budget
    expect(fleetSupervisorRoleProfile().length).toBeLessThanOrEqual(LAYER_BUDGETS.role);
    expect(projectSupervisorRoleProfile({ projectName: 'Apollo', projectId: 'p', fleetSupervisorChatId: null, hookEventTypes: PROJECT_SUPERVISOR_HOOK_EVENT_TYPES }).length).toBeLessThanOrEqual(LAYER_BUDGETS.role);
  });

  it('the facts block fits its cap with EVERY registered purpose in act, names them, and carries ONE dated header', () => {
    const all = DECISION_PURPOSES.map(p => p.purpose);
    const f = frameworkFactsBlock({ actPurposes: all, asOf: new Date('2026-09-27T00:00:00Z') });
    expect(f.length).toBeLessThanOrEqual(FRAMEWORK_FACTS_MAX_CHARS);
    expect(f.endsWith('…')).toBe(false); // never clipped at the cap
    for (const p of ['wake_triage', 'sweep_triage', 'supervisor_turn_noop']) expect(f).toContain(p);
    expect(f.split('\n')[0]).toBe(`${FRAMEWORK_FACTS_HEADING} 2026-09-27 (live values composed at prompt time)`);
    expect((f.match(/\b20\d\d-\d\d-\d\d\b/g) ?? []).length).toBe(1);
    const none = frameworkFactsBlock({ actPurposes: [] });
    expect(none).toContain('none — every purpose is shadow');
  });

  it('the core states every rule id once', () => {
    const core = coreDoctrine('project');
    for (const id of CORE_RULE_IDS) {
      if (id === 'wake.close') continue; // stated in the role profile's close contract
      expect(core.split(`(rule ${id})`).length).toBe(2);
    }
  });

  // Backlog audit CT-8: the core budget was bumped seven times in 36 h (10,547
  // → 15,150) with no compression pass — "measured + 4%" was re-typed on every
  // rule addition. The pin below refuses a budget that sits more than
  // LAYER_BUDGET_MAX_HEADROOM above the measured worst-case layer, so a bump
  // can only land together with the text that needs it (and its justification
  // line in prompt-layers.ts), and a compression pass MUST lower the budget.
  it('LAYER_BUDGETS sit at measured + 4% — a budget bump needs the text that needs it (core + role pinned within +8% of the measured worst case)', () => {
    const coreMeasured = Math.max(coreDoctrine('fleet').length, coreDoctrine('project').length);
    const roleMeasured = Math.max(
      fleetSupervisorRoleProfile().length,
      projectSupervisorRoleProfile({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', hookEventTypes: PROJECT_SUPERVISOR_HOOK_EVENT_TYPES }).length,
    );
    expect(coreMeasured).toBeLessThanOrEqual(LAYER_BUDGETS.core);
    expect(roleMeasured).toBeLessThanOrEqual(LAYER_BUDGETS.role);
    expect(LAYER_BUDGETS.core).toBeLessThanOrEqual(Math.ceil(coreMeasured * LAYER_BUDGET_MAX_HEADROOM));
    expect(LAYER_BUDGETS.role).toBeLessThanOrEqual(Math.ceil(roleMeasured * LAYER_BUDGET_MAX_HEADROOM));
    // The compression's floor: the layers never re-bloat past the pre-compression sizes without a deliberate re-pin.
    // Re-pinned 2026-10-15 (ticket b8028af7): rule hold.blocker-scope joined the scope section — the box-only-seal
    // over-hold incident needed ONE rule sentence (measured worst case 12,095); compressed once before pinning.
    // Re-pinned 2026-10-16 (ticket 50bcd1e7): rule secrets.owner-answer-vault joined the evidence section — the
    // card-answer credential-destruction incident needed ONE rule sentence (measured worst case 12,297); compressed
    // twice before pinning (471 → 240 → 199 chars).
    // Re-pinned 2026-10-16 (audit 96fb2f25): TWO rule sentences — truth.owner-ask (evidence section; the board-shown-
    // done-on-a-not-done-reply specimen) and gate.owner-only-class (gate section; the supervisor-answered owner-only
    // gate specimen). Compressed once before pinning (12,755 → 12,673 measured worst case).
    // Re-pinned 2026-10-16 (todo efb2960d): rule evidence.citation-grounding (evidence section; the invented-receipt-id
    // follow-through specimen) — one rule sentence, compressed once before pinning.
    // Re-pinned 2026-10-16 (ticket 1b1c41bc): rule asks.console-action-inline (gate section; the owner's 3×-in-one-day
    // "better instructions always" directive — a console-action card must carry the paste-ready payload + steps inline)
    // — one rule sentence, compressed twice before pinning (measured worst case 13,140).
    // Re-pinned 2026-10-16 (ticket 76045f4e): rule gate.filer-duplicate-retire (gate section; the no-lawful-retire-path
    // duplicate specimen — the owner closed both dupes by hand) — one rule sentence, compressed once before pinning
    // (435 → 121 chars; measured worst case 13,258).
    // Re-pinned 2026-10-16 (todo fea78360): rule asks.card-contract (standing section; the 4-card ACL-chain stall
    // specimen — one decision, one card) — one rule sentence, compressed once before pinning (415 → 250 chars;
    // measured worst case 13,537; the 13,270 floor sat at the pre-bullet baseline).
    // Re-pinned 2026-10-16 (todo b73b1460): rule evidence.scoped-verify (evidence section; the 14-full-chains-an-hour
    // shared-container specimen) — one rule sentence, compressed once before pinning (178 → 160 chars; measured worst
    // case 13,710; the 13,560 floor sat at the fea78360 baseline).
    // Re-pinned 2026-10-16 (todo 89df978b, post-rebase): rule runs.budget-observe now shares the core with
    // main's evidence.scoped-verify re-pin (13,710) — measured worst case 13,896 (both rules, compressed);
    // LAYER_BUDGETS.core re-pinned 13,789 → 14,412 (measured + 4%) with the comment trail there.
    // Re-pinned 2026-10-17 (second merge — todos b73b1460 + 0f58ddde × 89df978b): all THREE evidence-section
    // bullets coexist — evidence.scoped-verify (178 → 160 chars, measured 13,710) + runs.budget-observe
    // (318 → 168 chars, measured 13,896) + telemetry.board-saturation (246 → 193 → 170 chars, measured
    // 13,749), each independently compressed to its floor BEFORE its merge; union measured worst case
    // 14,108 (core budget 13,789 → 14,412 → 14,672 = measured + 4% in prompt-layers.ts).
    // Re-pinned 2026-10-17 (ticket 26786762): rule secrets.owner-card-delivery joined the scope section
    // (the owner-card credential-destruction incident) — one rule sentence, compressed once before
    // pinning (281 → 247 chars); measured worst case 14,355 (core budget 14,672 → 14,930 = measured + 4%).
    // Re-pinned 2026-10-17 (stitch merge, tickets 26786762 × c75b5f34): BOTH rules coexist —
    // secrets.owner-card-delivery (scope section, 247 chars) + isolation.instance-boundary (standing
    // section, 186 chars), each independently compressed to its floor BEFORE its merge; union measured
    // worst case 14,562 (core budget 14,930 → 15,145 = measured + 4% in prompt-layers.ts).
    // Re-pinned 2026-10-17 (ticket 97c06f46): rule evidence.absence-probe joined the evidence
    // section (the supervisor read an access-scoped 404 as lane deletion and filed a false
    // slot-reclaim ticket) — compressed twice before pinning (297 → 223 chars); union measured
    // worst case 14,784 (core budget 15,145 → 15,376 = measured + 4% in prompt-layers.ts).
    // Re-pinned 2026-10-18 (todo 0dd7d3f2): rule gates.reply-truth joined the gate section
    // (the choice-card credential-banner incident) — compressed once before pinning
    // (348 → 231 chars); union measured worst case 15,025 (core budget 15,376 → 15,626 =
    // measured + 4% in prompt-layers.ts).
    // Re-pinned 2026-10-18 (todo ead881f4): rule evidence.proxy-depth-attribution joined the
    // evidence section (the ALB-node-as-attacker class behind the false password-guessing card) —
    // compressed twice before pinning (507 → 262 chars); union measured worst case 15,311
    // (core budget 15,626 → 15,924 = measured + 4% in prompt-layers.ts).
    // Re-pinned 2026-10-18 (ticket 35c3ecb0): rule board.sent-not-landed joined the evidence
    // section (the own-queued-send-asserted-as-landed specimen) — one rule sentence at 306
    // chars; union measured worst case 15,649 (core budget 15,924 → 16,275 = measured + 4%).
    // Re-pinned 2026-10-19 (ticket b36a150e): rule evidence.structured-verdict joined the
    // evidence section (the run-outcome structured verdict field) — landed rule sentence 234
    // chars; measured worst case 15,919 (core budget 16,275 → 16,556 = measured + 4% exact
    // ceil; review F4 corrected the first pin of 16,576, F5 the "200 chars" claim).
    // Re-pinned 2026-10-20 (ticket 2eef354e): rule platform.first-class-watch-over-webhook
    // joined the standing section (the owner's agents-can't-setup-their-own-webhooks
    // incident) — compressed once before pinning (landed rule 349 full-line chars; the
    // 261-char figure in the first pin was the envKey param description, not the rule);
    // measured worst case
    // 16,269 (core budget 16,556 → 16,920 = measured + 4% exact ceil).
    // Re-pinned 2026-10-20 (ticket b03d7033): rule asks.act-or-escalate joined the
    // evidence section (the explanation-only close of an owner state-complaint ask) —
    // compressed twice before pinning (311 → 249 chars, at its semantic floor); measured
    // worst case 16,520 (core budget 16,920 → 17,181 = measured + 4% exact ceil).
    // Re-pinned 2026-10-22 (fs-code-knowledge): evidence.absence-probe gained its code
    // sentence in place (+129 chars) — measured worst case 16,649 (core budget
    // 17,181 → 17,315 = measured + 4% exact ceil).
    // Re-pinned 2026-10-24 (ticket e44e1219): rule evidence.condition-wake-visibility
    // joined the evidence section (the supervisor verified a lane's true registered-wake
    // claim off the schedule count and armed redundant one-shots — the wake store was
    // never probed) — compressed once before pinning (396 → 287 chars, at its semantic
    // floor); measured worst case 16,983 (core budget 17,315 → 17,663 = measured + 4%
    // exact ceil).
    // Re-pinned 2026-10-24 (ticket 1a6afc6a): rule evidence.stand-down-on-closed
    // joined the evidence section (the ticket drain dispatched a lane to a ticket
    // 0.554s before it closed done; the lane re-executed the verified-done change) —
    // compressed once before pinning (316 → 270 chars, at its semantic floor);
    // measured worst case 17,267 (core budget 17,663 → 17,958 = measured + 4% exact
    // ceil).
    // 2026-10-31 (ticket 5fba7188): rule evidence.answering-build joined the evidence
    // section (a superseded worker colour answered tool calls on the pre-fix build during
    // the zero-gap drain — a shipped fix read as ABSENT four times). Compressed to 193
    // chars so the floor HOLDS: measured worst case 17,461 < 17,287 is false, so the
    // floor moves by exactly the 194 chars the rule adds (17,267 + 194 = 17,461).
    // 2026-11-02 (ticket f94e91eb): rule relay.truncated-answer joined the evidence
    // section (a supervisor read a silently clipped owner answer as real absence and a
    // duplicate owner card asked for values already supplied). Compressed once before
    // pinning (364 → 310 chars, at its semantic floor); measured worst case 17,772
    // (core budget 17,958 unchanged — it already holds; the floor moves to 17,792).
    expect(coreMeasured).toBeLessThan(17_772 + 20);

    expect(roleMeasured).toBeLessThan(28_000);
  });

  it('the compression kept every core section anchor the lesson writer appends under, in order', () => {
    const core = coreDoctrine('fleet');
    const anchors = ['## Standing owner directives', '## Precedence', '## Directive scope', '## Decision-gate outcomes', '## Evidence rules', '## Task lifecycle'];
    const at = anchors.map(a => core.indexOf(`\n${a}`) >= 0 ? core.indexOf(`\n${a}`) : core.indexOf(a));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('rescaffoldProjectSupervisorPrompt — the migration helper', () => {
  const laneRow = (systemPrompt: string | null, enabled = true) => ({
    id: 'psup1', userId: 'u1', projectId: 'p-apollo', isProjectSupervisor: true, systemPrompt,
    project: { id: 'p-apollo', name: 'Apollo', description: 'Ship a lunar-lander telemetry benchmark.', repoUrl: null, repoProvider: null, defaultBranch: 'main', githubLabel: null, projectSupervisorEnabled: enabled },
  });

  it('rewrites a v1 (pre-layering) stock prompt — on a PAUSED project too — from the project brief, and audits it', async () => {
    // A v1 stored stock prompt: the stock opener, no layer markers (the pre-layering builders that wrote these were deleted in build 2026-10-08 S-2).
    const v1 = `${PROJECT_SUPERVISOR_PROMPT_OPENER} for the project "Apollo" (projectId p-apollo) — an autonomous supervisor chat that watches over THIS ONE project's chats and coding sessions and keeps its work moving.\n\n## Standing owner directives (bind every wake — read before acting)\n- (pre-layering body)`;
    expect(isLayeredPrompt(v1)).toBe(false);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow(v1, false));
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p-apollo', name: 'Apollo', systemPrompt: 'Always report distances in metres.', path: '' });
    const r = await rescaffoldProjectSupervisorPrompt('psup1');
    expect(r.outcome).toBe('rewritten');
    expect(r.wasLayered).toBe(false);
    const stored = mockPrisma.crossModelChat.update.mock.calls[0][0].data.systemPrompt as string;
    expect(isLayeredPrompt(stored)).toBe(true);
    expect(stored).toContain('Mission: Ship a lunar-lander telemetry benchmark.');
    expect(stored).toContain('Always report distances in metres');
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'chat.update', metadata: expect.objectContaining({ chatId: 'psup1', wasLayered: false }) }) });
  });

  it('leaves a CUSTOMIZED prompt alone, reports a dry run without writing, and reports current when nothing changed', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow('You are my own project brain.'));
    expect((await rescaffoldProjectSupervisorPrompt('psup1')).outcome).toBe('customized');
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow(null));
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    const dry = await rescaffoldProjectSupervisorPrompt('psup1', { dryRun: true });
    expect(dry.outcome).toBe('dry_run');
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    // current: store what the helper would write, ask again
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow(null));
    const first = await rescaffoldProjectSupervisorPrompt('psup1');
    expect(first.outcome).toBe('rewritten');
    const written = mockPrisma.crossModelChat.update.mock.calls[0][0].data.systemPrompt as string;
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow(written));
    expect((await rescaffoldProjectSupervisorPrompt('psup1')).outcome).toBe('current');
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect((await rescaffoldProjectSupervisorPrompt('nope')).outcome).toBe('not_found');
  });
});

describe('DIRECTIVE AGE doctrine lives in the ROLE layer', () => {
  // Review fix: the sentence was first written into the pre-layering builders
  // (since deleted) — so the prod (layered) supervisors never saw it. It rides
  // role-profiles.ts, undated, and the composed prompts pin it.
  const SENTENCE_RE = /DIRECTIVE AGE:.*?matches none\./;
  it('both composed supervisor prompts carry it', () => {
    const fleet = buildFleetSupervisorPrompt();
    const project = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', brief: APOLLO });
    for (const p of [fleet, project]) {
      expect(p).toMatch(SENTENCE_RE);
      expect(p).toContain('[FOLLOW-THROUGH — DIRECTIVE]');
      expect(p).toContain("evidence:'dispatched: session <id>'");
      expect(p).toContain('a dispatch is progress, not done');
      // The sentence rides the ROLE layer, not the core.
      expect(splitLayers(p).find(l => l.id === 'role')?.body).toMatch(SENTENCE_RE);
    }
    expect(fleetSupervisorRoleProfile()).toMatch(SENTENCE_RE);
  });

  it('the sentence itself is undated, names no env toggle and no incident id (prompt-hygiene clean on its own)', () => {
    for (const text of [fleetSupervisorRoleProfile(), projectSupervisorRoleProfile({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', hookEventTypes: PROJECT_SUPERVISOR_HOOK_EVENT_TYPES })]) {
      const m = text.match(SENTENCE_RE);
      expect(m).not.toBeNull();
      expect(lintPromptText({ source: 'directive-age sentence', text: `- ${m![0]}`, projectNames: [], allow: [] })).toEqual([]);
    }
  });
});

describe('duty 5 auto-archive clause follows LANE_IDLE_RETIRE_DISABLED (lane lifecycle C5, review fixer 2026-10-21)', () => {
  const PRE_C5 = 'a finished one-shot with an empty board self-archives after 6 idle hours — do not wait for that when you can see it is done';
  const C5 = 'the harness auto-archives only a sub-session whose plan board is complete after 6 idle hours and a long-idle machine-spawned lane — never wait for that when you can see it is done';
  const role = () => projectSupervisorRoleProfile({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: 'fleet1', hookEventTypes: PROJECT_SUPERVISOR_HOOK_EVENT_TYPES });
  afterEach(() => { delete process.env.LANE_IDLE_RETIRE_DISABLED; });

  it('default: the prompt names what the harness actually auto-archives (lane-retire included)', () => {
    delete process.env.LANE_IDLE_RETIRE_DISABLED;
    expect(retireAutoArchiveClause()).toBe(C5);
    expect(role()).toContain(`a chat archives only once its schedules are gone; ${C5}).`);
    expect(role()).not.toContain(PRE_C5);
  });

  it('LANE_IDLE_RETIRE_DISABLED=1: the pre-C5 sentence byte-for-byte (no lane-retire, so no "long-idle machine-spawned lane" claim)', () => {
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    expect(retireAutoArchiveClause()).toBe(PRE_C5);
    expect(role()).toContain(`then archive_chat it (a chat archives only once its schedules are gone; ${PRE_C5}). A standing WATCH`);
    expect(role()).not.toContain('long-idle machine-spawned lane');
    expect(role().length).toBeLessThanOrEqual(LAYER_BUDGETS.role);
  });
});
