/**
 * REPLAY PIN — mishap ticket 5ad80b27 (2026-09-14, "Residual phantom-claim
 * class: verbatim detail + wrong kind/id escapes the 587e9d64 grounding fix",
 * sighting 2 on ticket 587e9d64, chat 378224d5).
 *
 * The incident shape: an HONEST final note said "re-ran the Gmail sweep on
 * all four accounts, and updated the todo ledger" — TRUE prose (the run's
 * receipts show gmail_search ×4 + todo_get→3c284bab + todo_update→476faed7
 * todoId 0a7f2a5e). The utility-LLM claim extractor emitted
 *   [dispatch] "re-ran the Gmail sweep on all four accounts, and updated the
 *   todo ledger"  (cited id 9ed656af-230a-452d-86f7-a1aa738f350e — the
 *   generated-FILE id from the run's own create_document result).
 * The 587e9d64 grounding fix (PR #747) validates the DETAIL's textual support
 * — this detail IS verbatim, so it grounds — and the tier chain then judged
 * kind=dispatch + id=file-id: no dispatch receipts (fc337153's kind-agnostic
 * tier is scoped to claim-kind envelopes, and create_document mints NO
 * receipts at all), no crossmodel_chats row → CONVICTED, appending a false
 * correction to an honest note. The hallucination was the KIND and the ID,
 * not the detail text.
 *
 * The fix pinned here: the OWN-ARTIFACT KIND-CONSISTENCY tier in
 * findPhantomClaims (ticket 5ad80b27) — at the conviction point of an
 * id-bearing claim, when the cited id anchors to the run's OWN evidence (a
 * non-claim-kind receipt envelope, or the trusted tool-output haystack seam
 * that covers receipt-less artifact tools like create_document) AND the
 * detail does NOT narrate the claimed kind's action (claimNarratesKindAction
 * — verb→noun proximity), the claim is TRUE prose the extractor
 * mis-kinded/mis-ided: exonerate (fail toward miss, the 587e9d64 doctrine).
 * A detail that DOES narrate the kind convicts unchanged (the review-P1
 * id-splice shape, "dispatched session <own commit sha>").
 *
 * Mock discipline mirrors action-verifier.587e9d64.test.ts.
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

import { computePhantomClaims, findPhantomClaims, claimNarratesKindAction, ExtractedClaim } from './action-verifier';
import { ExecutedAction } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';
import logger from '../../../utils/logger';

const CHAT = '378224d5-4271-4efa-bdfc-628dc5e1eecd';
/** The generated-FILE id the mis-kinded claim cited (the incident's real id). */
const FILE_ID = '9ed656af-230a-452d-86f7-a1aa738f350e';
/** The verbatim-TRUE detail the extractor mis-labelled [dispatch]. */
const LEDGER_DETAIL = 're-ran the Gmail sweep on all four accounts, and updated the todo ledger';

/**
 * The incident note's relevant content (shape of chat 378224d5's honest
 * close-out): the ledger line the extractor quoted VERBATIM, plus the file
 * link. No dispatch/session/schedule/ticket/msg citation idioms — every
 * citation lane must stay silent on it.
 */
const INCIDENT_NOTE = `## Sweep status — ledger updated

Re-ran the Gmail sweep on all four accounts, and updated the todo ledger with the results from the directory parse. The compiled list is saved as a file: [allin-targets.md](/api/crossmodel/generated-files/${FILE_ID}/download) — also on your Files page. Meeting booking did not start this run; nothing else is claimed.`;

/** The run's parts: create_document's RESULT carries the file id (it mints NO receipt). */
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'create_document', args: { filename: 'allin-targets.md', content: '…' } },
  { type: 'tool_result', name: 'create_document', result: `{"ok":true,"file":{"id":"${FILE_ID}","filename":"allin-targets.md","download":"/api/crossmodel/generated-files/${FILE_ID}/download"}}` },
] as any[];

/** The run's real receipt shape: todo_update executed (todoId 0a7f2a5e…), nothing dispatch-kind. */
const INCIDENT_RECEIPTS: ToolReceipt[] = [
  {
    id: '476faed7-1111-2222-3333-444455556666', chatId: CHAT, runId: 'run-1',
    tool: 'todo_update', ok: true,
    ids: { todoId: '0a7f2a5e-aaaa-bbbb-cccc-dddddddddddd' },
    inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-09-14T07:05:00Z'),
  } as any,
];

const never = async () => false;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

describe('ticket 5ad80b27 replay — verbatim detail + wrong kind/id + own-run artifact id', () => {
  it('REPLAYS the mishap: the [dispatch]-mis-kinded ledger claim citing the file id now audits CLEAN', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: LEDGER_DETAIL, id: FILE_ID }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.claims).toEqual([{ kind: 'dispatch', detail: LEDGER_DETAIL, id: FILE_ID }]); // grounding keeps the verbatim claim
    expect(comp.phantoms).toEqual([]); // NO false correction on the honest note
    expect(comp.ownArtifactExonerated).toBe(1); // exonerated by THIS tier, not an accident
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('5ad80b27'));
  });

  it('also exonerates the SAME detail mis-kinded [schedule] (verb-after-noun trap: "sweep … updated" is NO schedule narration)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'schedule', detail: LEDGER_DETAIL, id: FILE_ID }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([]);
    expect(comp.ownArtifactExonerated).toBe(1);
  });

  it('KIND-IDIOM GATE: a detail that DOES narrate dispatch ("dispatched session <file id>") still convicts — the anchor cannot launder it', async () => {
    const falseNote = `${INCIDENT_NOTE}\n\nSeparately: I dispatched session ${FILE_ID} to keep the ledger warm overnight.`;
    const falseDetail = `dispatched session ${FILE_ID} to keep the ledger warm overnight`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: falseDetail, id: FILE_ID }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: falseNote,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.ownArtifactExonerated).toBe(0);
    expect(comp.phantoms.some((p) => p.kind === 'dispatch' && p.detail === falseDetail)).toBe(true);
  });
});

describe('ticket 5ad80b27 — findPhantomClaims own-artifact tier (unit surface)', () => {
  const ledgerClaim = (): ExtractedClaim => ({ kind: 'dispatch', detail: LEDGER_DETAIL, id: FILE_ID });

  it('pool-envelope lane: a cited id matching a NON-claim-kind own-run envelope (git sha) + no kind narration exonerates', async () => {
    const commit: ExecutedAction = { tool: 'git_commit', ok: true, staged: false, ids: { sha: '386b6a6b88866547c66bac50e696b786c48085cb' } };
    const exonerated: ExtractedClaim[] = [];
    const claim: ExtractedClaim = { kind: 'dispatch', detail: 'wrapped the sweep and saved the ledger to files', id: '386b6a6b' };
    expect(await findPhantomClaims([claim], [commit], never, [], { exonerated })).toEqual([]);
    expect(exonerated).toEqual([claim]);
  });

  it('tool-output lane: a cited id in the trusted tool-output texts + no kind narration exonerates (create_document mints no receipts)', async () => {
    const exonerated: ExtractedClaim[] = [];
    const claim = ledgerClaim();
    const haystacks = [`{"ok":true,"file":{"id":"${FILE_ID}"}}`];
    expect(await findPhantomClaims([claim], [], never, [], { evidenceTexts: haystacks, exonerated })).toEqual([]);
    expect(exonerated).toEqual([claim]);
  });

  it('guard — NO anchor + no kind narration STILL convicts (the 55b18ba3 fabricated-id class is untouched)', async () => {
    const claim: ExtractedClaim = { kind: 'dispatch', detail: 'session x', id: 'aaaaaaaa-1' };
    expect(await findPhantomClaims([claim], [], never, [], { evidenceTexts: ['unrelated tool output'] })).toEqual([claim]);
  });

  it('guard — anchor + kind narration STILL convicts (the review-P1 id-splice shape is untouched)', async () => {
    const commit: ExecutedAction = { tool: 'git_commit', ok: true, staged: false, ids: { sha: '386b6a6b88866547c66bac50e696b786c48085cb' } };
    const claim: ExtractedClaim = { kind: 'dispatch', detail: 'dispatched session 386b6a6b', id: '386b6a6b' };
    expect(await findPhantomClaims([claim], [commit], never, [], {})).toEqual([claim]);
  });

  it('guard — claim-kind envelopes anchor TIER 1A, never this tier (precedence pin; review F3)', async () => {
    // Tier 1a (fc337153) runs BEFORE the own-artifact tier and exonerates ANY
    // claim-kind envelope id match — so the `hit` claim exonerates either way,
    // and the SINK is the witness: if this tier ever fired on a claim-kind
    // envelope (a scope regression) or jumped its precedence, the sink would
    // capture it. The `miss` claim (id absent from every envelope) pins that
    // the tier does not fire without an anchor.
    const send: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { receiptId: '7f0da5b9-1111-2222-3333-444455556666' } };
    const exonerated: ExtractedClaim[] = [];
    const hit: ExtractedClaim = { kind: 'dispatch', detail: 'wrapped the ledger sweep', id: '7f0da5b9' };
    const miss: ExtractedClaim = { kind: 'dispatch', detail: 'wrapped the ledger sweep', id: 'ffffffff' };
    expect(await findPhantomClaims([hit, miss], [send], never, [], { exonerated })).toEqual([miss]);
    expect(exonerated).toEqual([]); // `hit` was exonerated by tier 1a — this tier never engaged
  });

  it('review F1: a NOUN-FRONTED false claim ("the session I dispatched") citing an own-run artifact still convicts', async () => {
    const commit: ExecutedAction = { tool: 'git_commit', ok: true, staged: false, ids: { sha: '386b6a6b88866547c66bac50e696b786c48085cb' } };
    const claim: ExtractedClaim = { kind: 'dispatch', detail: 'the session I dispatched for the ledger', id: '386b6a6b' };
    expect(await findPhantomClaims([claim], [commit], never, [], { exonerated: [] })).toEqual([claim]);
  });

  it('the tier is ID-BEARING only: id-less claims keep today\'s slot-budget semantics', async () => {
    const idless: ExtractedClaim = { kind: 'dispatch', detail: 'worker 1' };
    expect(await findPhantomClaims([idless], [], never, [], {})).toEqual([idless]);
  });
});

describe('ticket 5ad80b27 — claimNarratesKindAction (the verb→noun proximity contract)', () => {
  it('dispatch: narrations match, the incident ledger detail does not', () => {
    expect(claimNarratesKindAction('dispatch', 'dispatched session 9f8e7d6c')).toBe(true);
    expect(claimNarratesKindAction('dispatch', 'created a coding session to build the list')).toBe(true);
    expect(claimNarratesKindAction('dispatch', 'spawned a worker for the audit')).toBe(true);
    expect(claimNarratesKindAction('dispatch', LEDGER_DETAIL)).toBe(false);
    expect(claimNarratesKindAction('dispatch', 'session 386b6a6b is running now')).toBe(false); // status, not action
  });

  it('schedule: "updated the sweep schedule" narrates; "sweep … updated the todo ledger" (noun-before-verb trap) does NOT', () => {
    expect(claimNarratesKindAction('schedule', 'updated the sweep schedule for the nightly run')).toBe(true);
    expect(claimNarratesKindAction('schedule', 'cancelled the 30-minute poller schedule')).toBe(true);
    expect(claimNarratesKindAction('schedule', LEDGER_DETAIL)).toBe(false);
  });

  it('message + ticket: the fleet idioms match, observation prose does not', () => {
    expect(claimNarratesKindAction('message', 'sent the digest to the ops lane')).toBe(true);
    expect(claimNarratesKindAction('message', 'posted a single gentle check-in to the waiver chat')).toBe(true);
    expect(claimNarratesKindAction('message', 'the digest lives in the ops lane')).toBe(false);
    expect(claimNarratesKindAction('ticket', 'filed ticket abc12345 with the replay')).toBe(true);
    expect(claimNarratesKindAction('ticket', LEDGER_DETAIL)).toBe(false);
  });

  it('proximity: a kind noun across a sentence boundary does NOT bind (the 2026-08-27 args-pin shape still binds)', () => {
    expect(claimNarratesKindAction('dispatch', 'I dispatched it. The session is live.')).toBe(false);
    expect(claimNarratesKindAction('dispatch', '[in file_feedback args] dispatched start_coding_session, ok:true')).toBe(true);
  });

  it('noun-fronted idiom (review F1): "the X I <verb>ed" narrates; the incident 27-char trap does NOT', () => {
    expect(claimNarratesKindAction('dispatch', 'the session I dispatched for the ledger')).toBe(true);
    expect(claimNarratesKindAction('schedule', 'the schedule I cancelled before the sweep')).toBe(true);
    expect(claimNarratesKindAction('ticket', 'a ticket I filed with the replay')).toBe(true);
    // The trap: "sweep" sits exactly 27 chars before "updated" — outside the
    // 24-char noun-first window, so the schedule mis-kind stays exonerated.
    expect(claimNarratesKindAction('schedule', LEDGER_DETAIL)).toBe(false);
    // Accepted residual (documented, fail toward miss): a bare-pronoun
    // narration carries no kind noun at all.
    expect(claimNarratesKindAction('dispatch', 'I dispatched it earlier today')).toBe(false);
  });
});
