/**
 * Project brief — owner authority (2026-10-20).
 *
 * OWNER-PROVENANCE-STRICT: the brief listed EVERY answered flagged question
 * from the project's chats as an "Owner standing decision" — the supervisor's
 * triage answers and the auto-applied preset defaults included. Now only an
 * owner answer (answeredBy 'owner', or NULL — the column predates the
 * supervisor / default paths) is an owner decision; 'supervisor' / 'default'
 * answers render under "Supervisor rulings (revisable …)", and their banked
 * state-doc copies are never promoted. Kill switch
 * OWNER_PROVENANCE_STRICT_DISABLED=1 lists them all as decisions again.
 *
 * OWNER-DIRECTIVE-FANOUT: a standing owner rule scoped 'fleet' (banked on the
 * Fleet Supervisor's ledger) never reached the project prompt. Now OPEN +
 * standing + 'fleet' + owner-stamped rows from the Fleet Supervisor's ledger
 * and this supervisor's own render under "Fleet-wide owner rules"; never a
 * non-standing / done / ask / supervisor-written / supervisor-answer row.
 * Kill switch OWNER_DIRECTIVE_FANOUT_DISABLED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(async () => ({ id: 'p-apollo', name: 'Apollo', description: null, repoUrl: null })) },
  crossModelChat: {
    findMany: jest.fn(async () => [{ id: 'c1' }]),
    findFirst: jest.fn(async () => ({ id: 'fleet-sup' })),
  },
  projectGoal: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async (): Promise<any[]> => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));
jest.mock('./folder-inheritance', () => ({ __esModule: true, getEffectiveSystemPrompt: jest.fn(async () => ''), getMergedProjectStoreState: jest.fn(async () => ({})) }));

const docs: Record<string, any> = {};
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  getSupervisorState: jest.fn(async (chatId: string) => docs[chatId] ?? { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [] }),
}));

import { loadProjectBrief, clearProjectBriefCache } from './project-brief.loader';
import { renderProjectBrief } from './project-brief.model';

const at = '2026-10-12T10:00:00Z';
const answered = [
  { id: 'oq_owner001', question: 'Sim harness or live hardware?', answer: 'Sim harness.', chosenOption: null, resolvedAt: new Date('2026-10-15T10:00:00Z'), answeredBy: 'owner' },
  { id: 'oq_legacy01', question: 'Metric or imperial?', answer: 'Metric.', chosenOption: null, resolvedAt: new Date('2026-10-14T10:00:00Z'), answeredBy: null },
  { id: 'oq_super001', question: 'Approve the staging window?', answer: 'Approved under the standing directives.', chosenOption: null, resolvedAt: new Date('2026-10-13T10:00:00Z'), answeredBy: 'supervisor' },
  { id: 'oq_dflt0001', question: 'Retry the flaky eval?', answer: 'hold [auto-answered with the flagger\'s preset default after 2 days with no owner answer]', chosenOption: null, resolvedAt: new Date('2026-10-12T10:00:00Z'), answeredBy: 'default' },
];

beforeEach(() => {
  jest.clearAllMocks();
  clearProjectBriefCache();
  for (const k of Object.keys(docs)) delete docs[k];
  delete process.env.OWNER_PROVENANCE_STRICT_DISABLED;
  delete process.env.OWNER_DIRECTIVE_FANOUT_DISABLED;
  mockPrisma.ownerQuestion.findMany.mockResolvedValue(answered);
});
afterAll(() => { delete process.env.OWNER_PROVENANCE_STRICT_DISABLED; delete process.env.OWNER_DIRECTIVE_FANOUT_DISABLED; });

describe('OWNER-PROVENANCE-STRICT — supervisor rulings are not owner decisions', () => {
  it('owner + legacy NULL answers are decisions; supervisor / default answers are revisable rulings; banked copies never promoted', async () => {
    docs['apollo-sup'] = { directives: [
      // a LEGACY banked copy of the supervisor answer (pre-fix owner stamp) — skipped, the table lists it as a ruling
      { id: 'd1', text: 'Owner ANSWERED flagged question — Q: "Approve the staging window?" A: "Approved"', at, status: 'done', evidence: 'oq oq_super001', scope: 'Apollo', origin: 'owner_question' },
      // a post-fix supervisor_answer row — never an owner decision
      { id: 'd2', text: 'Fleet Supervisor ANSWERED (standing directives — not the owner) flagged question — Q: "Other?" A: "x"', at, status: 'done', evidence: 'oq oq_other01', scope: 'Apollo', origin: 'supervisor_answer' },
    ] };
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'apollo-sup', bypassCache: true });
    expect(mockPrisma.ownerQuestion.findMany.mock.calls[0][0].select.answeredBy).toBe(true);
    const decisions = (brief.standingDecisions ?? []).map((d) => d.evidence);
    expect(decisions).toEqual(['oq_owner001', 'oq_legacy01']);
    expect((brief.supervisorRulings ?? []).map((d) => d.evidence)).toEqual(['oq_super001', 'oq_dflt0001']);
    expect(brief.supervisorRulings?.[0].text).toContain('→ supervisor ruling: Approved under the standing directives.');
    expect(brief.supervisorRulings?.[1].text).toContain('→ preset default: hold');
    const text = renderProjectBrief(brief);
    expect(text).toContain('- Supervisor rulings (revisable — a supervisor or a preset default answered these, not the owner):');
    expect(text.indexOf('Owner standing decisions')).toBeLessThan(text.indexOf('Supervisor rulings'));
    expect(text.split('Approved').length).toBe(2); // listed once, under the rulings
  });

  it('kill switch OWNER_PROVENANCE_STRICT_DISABLED=1 lists every answer as an owner decision again', async () => {
    process.env.OWNER_PROVENANCE_STRICT_DISABLED = '1';
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'apollo-sup', bypassCache: true });
    expect((brief.standingDecisions ?? []).map((d) => d.evidence)).toEqual(['oq_owner001', 'oq_legacy01', 'oq_super001', 'oq_dflt0001']);
    expect(brief.supervisorRulings).toBeUndefined();
  });
});

describe('OWNER-DIRECTIVE-FANOUT — fleet-wide owner rules reach the project brief', () => {
  it('OPEN + standing + fleet + owner-stamped rows from the Fleet Supervisor ledger and this supervisor\'s own, newest first', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
    docs['fleet-sup'] = { directives: [
      { id: 'oq_68d001e9-ruling', text: 'Owner RULING (standing) — "digby defaults use the github secrets, always"', at: '2026-10-12T10:00:00Z', status: 'open', standing: true, scope: 'fleet', origin: 'owner_question' },
      { id: 'f-nonstanding', text: 'Fleet: pause the bench this week', at, status: 'open', scope: 'fleet', origin: 'owner' },
      { id: 'f-done', text: 'Fleet: done rule', at, status: 'done', standing: true, scope: 'fleet', origin: 'owner' },
      { id: 'f-ask', text: 'any progress across the fleet?', at, status: 'open', standing: true, scope: 'fleet', origin: 'owner', kind: 'ask' },
      { id: 'f-model', text: 'Supervisor rule: everyone uses 4 shards', at, status: 'open', standing: true, scope: 'fleet' },
      { id: 'f-supans', text: 'Fleet Supervisor ANSWERED …', at, status: 'open', standing: true, scope: 'fleet', origin: 'supervisor_answer' },
      { id: 'f-zeus', text: 'Zeus only: keep the old host', at, status: 'open', standing: true, scope: 'Zeus', origin: 'owner' },
    ] };
    docs['apollo-sup'] = { directives: [
      { id: 'ps-fleet', text: 'Owner said in the Apollo supervisor: fleet-wide, never use spot boxes', at: '2026-10-18T10:00:00Z', status: 'open', standing: true, scope: 'fleet', origin: 'owner' },
    ] };
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'apollo-sup', bypassCache: true });
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', isSupervisor: true } }));
    expect((brief.fleetRules ?? []).map((r) => r.evidence)).toEqual(['directive ps-fleet', 'directive oq_68d00']);
    const text = renderProjectBrief(brief);
    expect(text).toContain('- Fleet-wide owner rules (owner-origin, standing — they bind this project too):');
    expect(text).toContain('github secrets, always');
    expect(text).not.toContain('pause the bench');
    expect(text).not.toContain('4 shards');
    expect(text).not.toContain('Zeus only');
  });

  it('a standing ruling mirrored on this supervisor\'s ledger is listed ONCE — as a standing decision, never again under the fleet rules', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
    const ruling = 'Owner RULING (standing) — "no new Hyperstack IPs, ever"';
    docs['fleet-sup'] = { directives: [
      { id: 'oq_892c91ae-ruling', text: ruling, at, status: 'open', standing: true, scope: 'fleet', origin: 'owner_question' },
      { id: 'oq_77777777-ruling', text: 'Owner RULING (standing) — "secrets come from github, always"', at, status: 'open', standing: true, scope: 'fleet', origin: 'owner_question' },
    ] };
    docs['apollo-sup'] = { directives: [
      // the project mirror of the first ruling: same id, project scope
      { id: 'oq_892c91ae-ruling', text: ruling, at, status: 'open', standing: true, scope: 'Apollo', origin: 'owner_question' },
    ] };
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'apollo-sup', bypassCache: true });
    expect((brief.standingDecisions ?? []).map((d) => d.text)).toEqual([ruling]);
    expect((brief.fleetRules ?? []).map((r) => r.evidence)).toEqual(['directive oq_77777']);
    expect(renderProjectBrief(brief).split('no new Hyperstack IPs').length).toBe(2);
  });

  it('kill switch OWNER_DIRECTIVE_FANOUT_DISABLED=1 → no fleet rules, no Fleet Supervisor read', async () => {
    process.env.OWNER_DIRECTIVE_FANOUT_DISABLED = '1';
    docs['fleet-sup'] = { directives: [{ id: 'r1', text: 'never use spot boxes', at, status: 'open', standing: true, scope: 'fleet', origin: 'owner' }] };
    const brief = await loadProjectBrief('p-apollo', 'u1', { supervisorChatId: 'apollo-sup', bypassCache: true });
    expect(brief.fleetRules).toBeUndefined();
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
  });
});
