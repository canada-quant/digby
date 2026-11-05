/**
 * OWNER-PROVENANCE-STRICT + the ledger mirror (2026-10-20) — supervisor-state
 * half.
 *
 * The defect: appendAnsweredQuestionDirective banked EVERY answer to a flagged
 * question as "Owner ANSWERED …" with the owner stamp 'owner_question' — the
 * Fleet Supervisor's triage answers (answer_owner_question under the standing
 * directives) and the auto-applied preset defaults included — so the brief,
 * the archive keep and any wake read a supervisor's ruling as the owner's.
 * Pins:
 *  - the banked text + origin by actor: owner → "Owner ANSWERED" /
 *    owner_question; supervisor → "Fleet Supervisor ANSWERED (standing
 *    directives — not the owner)" / supervisor_answer; default → "Preset
 *    DEFAULT applied" / default; the kill switch restores the single shape;
 *  - the new origins survive the parse round trip but are NEVER owner stamps
 *    (isOwnerOriginStamp / isOpenOwnerOriginOrder exclude them);
 *  - the MIRROR row (OWNER-DIRECTIVE-FANOUT) on a project supervisor's ledger
 *    is idempotent per question (`<oq>-answer`), and a ruling's mirror keeps
 *    the asking project's scope even when the ruling is fleet-wide.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import {
  answeredQuestionLedgerShape,
  answeredQuestionMirrorId,
  appendAnsweredQuestionDirective,
  appendOwnerRulingDirective,
  isOpenOwnerOriginOrder,
  isOwnerOriginStamp,
  ownerRulingDirectiveId,
  parseSupervisorStateDoc,
  SupervisorStateDoc,
} from './supervisor-state.service';

const PS = 'apollo-sup';
const FS = 'fleet-sup';
let table: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OWNER_PROVENANCE_STRICT_DISABLED;
  delete process.env.OWNER_RULING_CAPTURE_DISABLED;
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) => (table.has(where.chatId) ? { state: table.get(where.chatId) } : null));
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
});
afterAll(() => { delete process.env.OWNER_PROVENANCE_STRICT_DISABLED; });

const doc = (chatId: string): SupervisorStateDoc => table.get(chatId) as SupervisorStateDoc;
const Q = { question: 'Re-provision the bench box?', answer: 'hold until the lab is back' };

describe('answeredQuestionLedgerShape — WHO answered is banked', () => {
  it('owner / supervisor / default each get their own text and origin', () => {
    expect(answeredQuestionLedgerShape({ ...Q, answeredBy: 'owner' })).toEqual({ text: `Owner ANSWERED flagged question — Q: "${Q.question}" A: "${Q.answer}"`, origin: 'owner_question' });
    expect(answeredQuestionLedgerShape(Q).origin).toBe('owner_question'); // absent = the owner (pre-fix callers)
    const sup = answeredQuestionLedgerShape({ ...Q, answeredBy: 'supervisor' });
    expect(sup.origin).toBe('supervisor_answer');
    expect(sup.text).toMatch(/^Fleet Supervisor ANSWERED \(standing directives — not the owner\) flagged question — /);
    expect(sup.text).not.toMatch(/^Owner/);
    const dflt = answeredQuestionLedgerShape({ ...Q, answeredBy: 'default' });
    expect(dflt.origin).toBe('default');
    expect(dflt.text).toMatch(/^Preset DEFAULT applied \(no owner answer\) to flagged question — /);
    // an owner counter-question stays "asked back — no decision"
    expect(answeredQuestionLedgerShape({ ...Q, counterQuestion: true }).text).toMatch(/^Owner REPLIED WITH A QUESTION/);
  });

  it('kill switch OWNER_PROVENANCE_STRICT_DISABLED=1 banks every answer as the owner\'s again', () => {
    process.env.OWNER_PROVENANCE_STRICT_DISABLED = '1';
    expect(answeredQuestionLedgerShape({ ...Q, answeredBy: 'supervisor' })).toEqual(answeredQuestionLedgerShape({ ...Q, answeredBy: 'owner' }));
    expect(answeredQuestionLedgerShape({ ...Q, answeredBy: 'default' }).origin).toBe('owner_question');
  });

  it('appendAnsweredQuestionDirective writes the supervisor row as a DONE supervisor_answer row — never an owner stamp', async () => {
    await appendAnsweredQuestionDirective(FS, 'u1', { questionId: 'oq_aaaa1111', ...Q, answeredBy: 'supervisor', scope: 'Apollo' });
    const row = doc(FS).directives[0];
    expect(row).toMatchObject({ status: 'done', origin: 'supervisor_answer', evidence: 'oq oq_aaaa1111', scope: 'Apollo' });
    expect(isOwnerOriginStamp(row.origin)).toBe(false);
  });
});

describe('origin round trip', () => {
  it('supervisor_answer / default survive the parse; a bogus origin is dropped; neither is an owner stamp', () => {
    const parsed = parseSupervisorStateDoc({ directives: [
      { id: 'a', text: 'x', at: '2026-10-20T00:00:00Z', status: 'open', origin: 'supervisor_answer' },
      { id: 'b', text: 'y', at: '2026-10-20T00:00:00Z', status: 'open', origin: 'default' },
      { id: 'c', text: 'z', at: '2026-10-20T00:00:00Z', status: 'open', origin: 'owner-ish' },
      { id: 'd', text: 'w', at: '2026-10-20T00:00:00Z', status: 'open', origin: 'owner_question' },
    ] });
    expect(parsed.directives.map((d) => d.origin)).toEqual(['supervisor_answer', 'default', undefined, 'owner_question']);
    expect(parsed.directives.map(isOpenOwnerOriginOrder)).toEqual([false, false, false, true]);
  });
});

describe('the project-supervisor MIRROR (OWNER-DIRECTIVE-FANOUT)', () => {
  it('an answered-question mirror is idempotent per question (<oq>-answer)', async () => {
    const entry = { questionId: 'oq_bbbb2222', ...Q, answeredBy: 'owner' as const, scope: 'Apollo', mirror: true };
    await appendAnsweredQuestionDirective(PS, 'u1', entry);
    await appendAnsweredQuestionDirective(PS, 'u1', entry);
    expect(doc(PS).directives).toHaveLength(1);
    expect(doc(PS).directives[0]).toMatchObject({ id: answeredQuestionMirrorId('oq_bbbb2222'), origin: 'owner_question', scope: 'Apollo', status: 'done' });
    // the Fleet Supervisor's own (non-mirror) rows keep the random id — two answers bank twice
    await appendAnsweredQuestionDirective(FS, 'u1', { questionId: 'oq_cccc3333', ...Q });
    await appendAnsweredQuestionDirective(FS, 'u1', { questionId: 'oq_dddd4444', ...Q });
    expect(doc(FS).directives).toHaveLength(2);
  });

  it('a standing ruling is fleet-scoped on the Fleet Supervisor ledger but keeps the asking project on its mirror', async () => {
    const base = { questionId: 'oq_eeee5555', question: 'Another bench box?', ruling: 'no new Hyperstack IP, ever — the account is shutting down', source: 'dismissal' as const, scope: 'Apollo' };
    expect(await appendOwnerRulingDirective(FS, 'u1', base)).toBe('appended');
    expect(await appendOwnerRulingDirective(PS, 'u1', { ...base, mirror: true })).toBe('appended');
    expect(await appendOwnerRulingDirective(PS, 'u1', { ...base, mirror: true })).toBe('duplicate');
    const fsRow = doc(FS).directives[0];
    const psRow = doc(PS).directives[0];
    expect(fsRow).toMatchObject({ id: ownerRulingDirectiveId('oq_eeee5555'), scope: 'fleet', standing: true, origin: 'owner_question', status: 'open' });
    expect(psRow).toMatchObject({ id: ownerRulingDirectiveId('oq_eeee5555'), scope: 'Apollo', standing: true, origin: 'owner_question', status: 'open' });
    expect(doc(PS).directives).toHaveLength(1);
  });
});
