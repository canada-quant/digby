/**
 * Ticket f05b38c1 — the action-verifier half: the verb-consistency veto on
 * the vouching tiers of findPhantomClaims.
 *
 * The incident: a supervisor machine wake's claim "Resolved duplicate ticket
 * 9c307167 via filer self-close — receipt ticket 9c307167" cited an id that
 * RESOLVES to the chat's ok file_feedback envelope (the FILING), so the
 * own-artifact tier (and the kind-specific ticket tier — file_feedback ∈
 * KIND_TOOLS.ticket) EXONERATED the close claim: the id is real, but the
 * close never ran. The veto: a same-id vouch whose tool class does not
 * contain the claim's governing act verb (and no other ok execution of the
 * right class exists this run) does not vouch.
 *
 * DETECTOR-RECALL REPLAY: every case below named "REPLAY" re-fires a PRIOR
 * true positive of the tiers this change touches — the 5ad80b27 own-artifact
 * exonerations (which must STILL exonerate) and the id-splice conviction
 * (which must still convict).
 *
 * Mock discipline mirrors action-verifier.5ad80b27.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { findPhantomClaims, ExtractedClaim } from './action-verifier';
import { ExecutedAction } from './executed-actions';

const never = async () => false;

beforeEach(() => {
  delete process.env.CLAIM_VERB_CONSISTENCY_DISABLED;
});

describe('f05b38c1 — the verb-consistency veto (own-artifact + kind tiers)', () => {
  /** The ad60c49d incident shape: an ok file_feedback (the filing) whose envelope carries the cited ticket id. */
  const filing: ExecutedAction = {
    tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' },
    inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-10-16T13:50:00Z'),
  } as any;
  const closeClaim = (): ExtractedClaim => ({
    kind: 'ticket',
    detail: 'Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
    id: '9c307167',
  });

  it('DETECTOR-RECALL REPLAY — the ad60c49d close claim now CONVICTS: the filing envelope cannot vouch the close verb', async () => {
    // kind tier: file_feedback ∈ KIND_TOOLS.ticket, envelope matches the id —
    // pre-f05b38c1 this exonerated; the veto must let it CONVICT.
    const out = await findPhantomClaims([closeClaim()], [filing], never, [], undefined);
    expect(out.map((c) => c.id)).toContain('9c307167');
  });

  it('DETECTOR-RECALL REPLAY — the own-artifact tier cannot exonerate the same shape (pool-envelope lane)', async () => {
    // The pool-envelope lane: file_feedback is NOT an ARGS_SCAN tool, its
    // envelope matches → ownArtifact.exonerated pre-veto; must stay convicted.
    const exonerated: ExtractedClaim[] = [];
    const out = await findPhantomClaims([closeClaim()], [filing], never, [], { exonerated, evidenceTexts: [] });
    expect(exonerated.map((c) => c.id)).not.toContain('9c307167');
    expect(out.map((c) => c.id)).toContain('9c307167');
  });

  it('DETECTOR-RECALL REPLAY — the own-artifact tool-output lane cannot exonerate it either', async () => {
    const exonerated: ExtractedClaim[] = [];
    // evidenceTexts naming the id (the tool-output lane), no envelope match.
    const out = await findPhantomClaims([closeClaim()], [], never, [], {
      exonerated,
      evidenceTexts: ['ticket 9c307167-e7b3-401e-9380-b434fe13b141 filed ok'],
    });
    expect(exonerated.map((c) => c.id)).not.toContain('9c307167');
    expect(out.map((c) => c.id)).toContain('9c307167');
  });

  it('an HONEST close (resolve_feedback ran this run) still exonerates on the kind tier', async () => {
    const closer: ExecutedAction = {
      tool: 'resolve_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' },
      inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-10-16T13:50:00Z'),
    } as any;
    const out = await findPhantomClaims([closeClaim()], [closer], never, [], undefined);
    expect(out).toEqual([]); // the close verb matches the tool — honest, vouched
  });

  it('DETECTOR-RECALL REPLAY — the 5ad80b27 mercy STILL exonerates: "re-ran the Gmail sweep … and updated the todo ledger" (no governing own-act verb)', async () => {
    // The coordination has no clause-initial/first-person/passive-bridge verb
    // — governingClaimVerb returns undefined, the veto judges nothing, and the
    // own-artifact tier keeps its pre-f05b38c1 semantics.
    const sweep: ExecutedAction = {
      tool: 'todo_update', ok: true, ids: { todoId: '0a7f2a5e-1111-2222-3333-444444444444' },
      inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-09-14T07:05:00Z'),
    } as any;
    const claim: ExtractedClaim = {
      kind: 'ticket',
      detail: 're-ran the Gmail sweep on all four accounts, and updated the todo ledger — todo 0a7f2a5e',
      id: '0a7f2a5e',
    };
    const exonerated: ExtractedClaim[] = [];
    const out = await findPhantomClaims([claim], [sweep], never, [], { exonerated, evidenceTexts: [] });
    expect(exonerated.map((c) => c.id)).toContain('0a7f2a5e');
    expect(out).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY — the id-splice shape STILL convicts (own commit sha behind a dispatch claim)', async () => {
    // "dispatched session <sha>" with a git_commit envelope: the dispatch
    // verb maps to start_coding_session & friends, git_commit is not in the
    // class — veto fires, and the kind-idiom gate already blocked the
    // own-artifact tier; the claim must stay convicted.
    const commit: ExecutedAction = {
      tool: 'git_commit', ok: true, ids: { sha: 'aaaaaaaa' },
      inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-10-01T00:00:00Z'),
    } as any;
    const claim: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'dispatched session aaaaaaaa to finish the fix',
      id: 'aaaaaaaa',
    };
    const exonerated: ExtractedClaim[] = [];
    const out = await findPhantomClaims([claim], [commit], never, [], { exonerated, evidenceTexts: [] });
    expect(out.map((c) => c.id)).toContain('aaaaaaaa');
  });

  it('CLAIM_VERB_CONSISTENCY_DISABLED=1 restores the pre-f05b38c1 vouching (the kill switch)', async () => {
    process.env.CLAIM_VERB_CONSISTENCY_DISABLED = '1';
    // Pre-fix the KIND tier (file_feedback ∈ KIND_TOOLS.ticket, envelope
    // matches) vouched it SILENTLY — the kill switch restores exactly that.
    const out = await findPhantomClaims([closeClaim()], [filing], never, [], undefined);
    expect(out).toEqual([]);
    delete process.env.CLAIM_VERB_CONSISTENCY_DISABLED;
  });

  it('a REPORT-shaped claim (third-party subject) is untouched by the veto — vouching proceeds', async () => {
    // "PR #75 merged" names another actor's act; governingClaimVerb is
    // undefined, so the veto judges nothing and an honest envelope vouches.
    const send: ExecutedAction = {
      tool: 'send_chat_message', ok: true, ids: { chatId: '250ec3f7-1111-2222-3333-444444444444' },
      inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-10-16T22:00:00Z'),
    } as any;
    const claim: ExtractedClaim = {
      kind: 'message',
      detail: 'Fleet report-up to c0e22e36 (receipt 250ec3f7): goal 53c7e5f6 moved — PR #75 merged',
      id: '250ec3f7',
    };
    const out = await findPhantomClaims([claim], [send], never, [], undefined);
    expect(out).toEqual([]);
  });
});
