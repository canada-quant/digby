/**
 * MISHAP REPLAY — ticket 7ea4819b-5d78-43ef-9a83-061dda2203fa (mishap, 2026-10-07):
 * "Phantom evidence citation: chat cited id(s) that do not exist (chat 21faf114)".
 *
 * The mishap: a user-facing chat turn (chat 21faf114) filed a REAL feedback
 * ticket via file_feedback — the run's own result envelope carried
 *   {"receiptId":"3f1f2736-4c90-445e-aa6d-a0d673d1c5cf",
 *    "ticketId":"59a4407b-ee05-4026-bac9-b4a71c00fed3"}
 * — and then the note cited `59a407b-ee05-4026-bac9-b4a71c00fed3`: ONE
 * dropped character ('4' in the first block), every other digit intact. The
 * deterministic verification convicted the citation (correctly — the id as
 * written exists nowhere), but every recovery tier is EXACT-or-PREFIX and
 * missed the miscopy by that one character:
 *   - citedIdInToolOutput: exact substring — '59a407b…' ≠ '59a4407b…';
 *   - idMatches: exact/prefix — no prefix relation, lengths 35 vs 36;
 *   - citedIdExistsAnywhere: prefix startsWith — same miss;
 *   - samePrefixRealIds: bucket = slice(0,8) = '59a407b-' — the corruption
 *     sits INSIDE the prefix, so the near-miss bucket came back EMPTY and the
 *     strike taught nothing.
 * The conviction was then stamped fabricatedId (markFabricatedIds) → the
 * mishap ticket's head asserted the ids were "invented from memory rather
 * than observed in a tool result" (FALSE — observed, then mistranscribed),
 * and correctionAdvice's fabricatedActionIds tail told the lane the filing
 * "is ALSO NOT DONE — call the tool" — actively instructing a DUPLICATE
 * ticket filing for an action that HAD run.
 *
 * The fix (ticket 7ea4819b): stampMiscopiedIds — a kind-constrained, unique,
 * length-gated Levenshtein near-match against THIS run's executed-pool
 * envelope ids stamps `miscopiedFrom` (the real id). The conviction STANDS
 * (the id as written still resolves to nothing); the DIAGNOSIS becomes true:
 * a miscopy-only strike gets its own mishap bucket + prose, every strike
 * surface renders the recovered real id, and the correction says do NOT
 * re-run the tool (it ran) — re-cite verbatim instead.
 *
 * Pins:
 *   1. THE REPLAY: the 21faf114 note + the run's real file_feedback envelope
 *      convict with miscopiedFrom = the real ticket id — fabricatedId NEVER
 *      set (markFabricatedIds skips miscopies).
 *   2. The miscopy conviction is still citation-class (enforceable), and the
 *      audit excerpt carries the recovered id (miscopiedFrom).
 *   3. The pre-delivery guard's miscopy-only notice/correction say MISCOPED,
 *      name the real id, and NEVER say "invented from memory" or "call the
 *      tool".
 *   4. The mishap ticket files in its OWN bucket (miscited, not phantom-
 *      citation) with the real id in the description.
 *   5. CONTROL — a truly invented id (no near envelope) keeps fabricatedId
 *      and the fabrication prose (the new bucket must not swallow the
 *      true-fabrication class).
 *   6. AMBIGUITY — two same-kind envelope ids within the edit window ⇒ NO
 *      stamp (a false stamp teaches "your invention was real").
 *   7. KIND CONSTRAINT — a near-miss of a MESSAGE id cannot stamp a TICKET
 *      claim (only file_feedback envelopes vouch ticket claims).
 *   8. levenshteinWithin: bound, early-exit and length-gate arithmetic.
 *
 * Mock discipline mirrors action-verifier.61b9200a.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

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

import {
  computePhantomClaims, guardMachineWakeFinalAnswer, stampMiscopiedIds,
  levenshteinWithin, markFabricatedIds, claimAuditExcerpts, isCitationClassClaim,
} from './action-verifier';
import { ExecutedAction } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the replay must read true against it.
const CHAT = '21faf114-69ed-453c-80ed-b7af6440d01b';

// ── The incident's ids (verbatim from the mishap ticket's own context) ──
// The REAL ticket id the run's file_feedback envelope carried:
const REAL_TICKET = '59a4407b-ee05-4026-bac9-b4a71c00fed3';
// The id the note actually cited — ONE dropped character (the '4' at index 4):
const MISCOPIED_TICKET = '59a407b-ee05-4026-bac9-b4a71c00fed3';
const REAL_RECEIPT = '3f1f2736-4c90-445e-aa6d-a0d673d1c5cf';

// The run's REAL parts: the file_feedback call + its JSON envelope, exactly
// the evidence the executed pool saw (and the haystacks, by exact substring).
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'file_feedback', args: { type: 'bug_report', title: 'web_pipe ingests Bright Data SERP error docs as results', description: '…' } },
  { type: 'tool_result', name: 'file_feedback', result: `{"ok":true,"receiptId":"${REAL_RECEIPT}","ticketId":"${REAL_TICKET}"}` },
] as any[];

// Verbatim-ish incident note (ticket excerpt): the miscopied citation in prose
// long enough to clear MIN_NOTE_CHARS.
const INCIDENT_NOTE = `**Ticket: filed.** It's \`${MISCOPIED_TICKET}\` — bug_report, priority 3, open for triage. What it documents: web_pipe ingests Bright Data's own SERP error docs as if they were search results, so a backend failure comes back dressed as a clean digest. The first filing attempt bounced on missing evidence fields; the successful refile with digbyEvidence populated is the ID above.`;

// The run's REAL receipts: the harness receipt row file_feedback mints
// (run-receipts.ts RECEIPT_TOOLS) — this is how the executed pool actually
// saw the envelope in the incident (the mishap ticket's own ground-truth line
// read: Executed consequential actions this run:
// file_feedback→{"receiptId":"3f1f2736…","ticketId":"59a4407b…"}).
const INCIDENT_RECEIPTS: ToolReceipt[] = [{
  id: REAL_RECEIPT,
  chatId: CHAT,
  runId: 'run-1',
  tool: 'file_feedback',
  ok: true,
  ids: { receiptId: REAL_RECEIPT, ticketId: REAL_TICKET },
  inputHash: null,
  outputHash: null,
  createdAt: new Date('2026-10-07T16:05:00Z'),
} as unknown as ToolReceipt];

// AMBIGUITY fixture: TWO real ticket filings this run whose ids both sit
// within the edit window of the citation — which one the lane "meant" is a
// coin flip, so the stamp must NOT fire (a false stamp teaches "your
// invention was real"). Receipts are authoritative per-tool, so both ride the
// pool (buildExecutedPool maps each receipt separately).
const AMBIGUOUS_RECEIPTS: ToolReceipt[] = [
  ...INCIDENT_RECEIPTS,
  {
    id: '11111111-2222-4333-8444-555555555555',
    chatId: CHAT,
    runId: 'run-1',
    tool: 'file_feedback',
    ok: true,
    ids: { receiptId: '11111111-2222-4333-8444-555555555555', ticketId: '59a4407b-ee05-4026-bac9-b4a71c00fed4' },
    inputHash: null,
    outputHash: null,
    createdAt: new Date('2026-10-07T16:06:00Z'),
  } as unknown as ToolReceipt,
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  // The miscopied id exists nowhere (existence checks unchanged) — the
  // conviction must still stand.
  for (const model of [mockPrisma.crossModelMessage, mockPrisma.crossModelChat, mockPrisma.chatSchedule, mockPrisma.userFeatureRequest, mockPrisma.projectGoal, mockPrisma.projectTodo]) {
    model.findFirst.mockResolvedValue(null);
    model.findMany.mockResolvedValue([]);
  }
});

describe('ticket 7ea4819b replay — a miscopied citation is diagnosed as MISCOPED, not invented', () => {
  it('REPLAYS the mishap: the 21faf114 note citing 59a407b… against the run\'s real envelope 59a4407b… convicts with miscopiedFrom = the real id, and NEVER fabricatedId', async () => {
    // The extraction pass labels the line a [ticket] claim with the miscopied
    // id, exactly as it did in the incident.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET} — bug_report, priority 3, open for triage.`, id: MISCOPIED_TICKET }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      machineTriggered: false,
    });
    await flush();

    expect(comp.phantoms.length).toBeGreaterThanOrEqual(1);
    const ticket = comp.phantoms.find((p) => String(p.id) === MISCOPIED_TICKET);
    expect(ticket).toBeDefined();
    // THE FIX: the real id is recovered onto the conviction…
    expect(ticket?.miscopiedFrom).toBe(REAL_TICKET);
    // …and the invention stamp never lands on a miscopy.
    expect(ticket?.fabricatedId).toBeUndefined();
    // The conviction STANDS and stays enforceable (deterministic class).
    expect(isCitationClassClaim(ticket as any)).toBe(true);
    // The audit excerpt carries the recovered id for cold adjudication.
    const excerpt = claimAuditExcerpts([ticket as any])[0];
    expect(excerpt.miscopiedFrom).toBe(REAL_TICKET.slice(0, 24));
  });

  it('the pre-delivery guard\'s miscopy-only notice says MISCOPED, names the real id, and never says "invented from memory" or tells the lane to call the tool', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET} — bug_report, priority 3, open for triage.`, id: MISCOPIED_TICKET }],
    }) as never);

    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      machineTriggered: true,
    });
    await flush();

    expect(res.struck).toBe(true);
    // The notice names the true class…
    expect(res.notice).toContain('DO NOT EXIST AS WRITTEN');
    expect(res.notice).toContain('miscopied, not invented');
    // …recovers the real id…
    expect(res.notice).toContain(REAL_TICKET);
    // …and drops the false invention diagnosis + the duplicate-filing advice.
    expect(res.notice).not.toContain('invented from memory');
    expect(res.correction ?? res.notice).not.toContain('ALSO NOT DONE');
    expect(res.correction).toContain('do NOT call the tool again');
    expect(res.correction).toContain(REAL_TICKET);
    // The struck line never survives as DELIVERED content: the miscopied id
    // appears only in (a) the notice's claim-detail quote (by design —
    // claimDetailLines quotes the struck claim) and (b) the audit blockquote
    // (full-replacement lane preserves the original for audit). The note's
    // surrounding prose must not appear before the audit marker.
    const auditIdx = res.finalText.indexOf('--- BEGIN STRUCK NOTE');
    const deliveredPart = auditIdx === -1 ? res.finalText : res.finalText.slice(0, auditIdx);
    expect(deliveredPart).not.toContain('The first filing attempt bounced');
  });

  it('the mishap ticket files in its OWN bucket (miscited, not phantom-citation) with the real id in the description', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET} — bug_report, priority 3, open for triage.`, id: MISCOPIED_TICKET }],
    }) as never);

    await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      machineTriggered: true,
    });
    await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filed = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filed.title).toBe(`Miscited evidence id(s): chat miscopied a real this-run id (chat ${CHAT.slice(0, 8)})`);
    expect(filed.description).toContain('DO NOT EXIST AS WRITTEN');
    expect(filed.description).toContain(REAL_TICKET);
    expect(filed.description).not.toContain('invented from memory');
    // The ground-truth executed line proves the backing action ran.
    expect(filed.description).toContain(`file_feedback→{"receiptId":"${REAL_RECEIPT}","ticketId":"${REAL_TICKET}"}`);
  });

  it('CONTROL — a truly invented id (no near envelope) keeps fabricatedId and the fabrication prose', async () => {
    const invented = 'deadbeef-0000-4000-8000-000000000000';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${invented} — open for triage.`, id: invented }],
    }) as never);
    const note = `**Ticket: filed.** It's \`${invented}\` — bug_report, priority 3, open for triage. The web_pipe failure class is documented there for the pipeline team.`;

    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS,
      machineTriggered: true,
    });
    await flush();

    expect(res.struck).toBe(true);
    const claim = (res.phantoms as any[]).find((p) => String(p.id) === invented);
    expect(claim?.miscopiedFrom).toBeUndefined();
    expect(claim?.fabricatedId).toBe(true);
    expect(res.notice).toContain('DO NOT EXIST');
    expect(res.notice).not.toContain('miscopied, not invented');
    // The new bucket must not swallow the true-fabrication class.
    const filed = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filed.title).toBe(`Phantom evidence citation: chat cited id(s) that do not exist (chat ${CHAT.slice(0, 8)})`);
    expect(filed.description).toContain('invented from memory');
  });

  it('AMBIGUITY — two same-kind envelope ids within the edit window ⇒ NO stamp', async () => {
    // A second real ticket filed this run whose id is ALSO within distance 2
    // of the citation: which one the lane "meant" is a coin flip — no stamp.
    // Both filings ride the pool as harness receipts (authoritative per-tool).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET} — open for triage.`, id: MISCOPIED_TICKET }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [], receipts: AMBIGUOUS_RECEIPTS, machineTriggered: false,
    });
    await flush();
    const claim = comp.phantoms.find((p) => String(p.id) === MISCOPIED_TICKET);
    expect(claim?.miscopiedFrom).toBeUndefined();
  });

  it('KIND CONSTRAINT — a near-miss of a MESSAGE id cannot stamp a TICKET claim', async () => {
    // The miscopied id sits 1 char off a message id, but the claim is a TICKET
    // claim: only file_feedback envelopes may vouch it.
    const msgId = '59a407be-e005-4026-bac9-b4a71c00fed3'; // distance ~2 from the citation, no ticket relation
    mockPrisma.crossModelMessage.findFirst.mockReset();
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) => {
      const probe = String(args?.where?.id ?? args?.where?.id?.startsWith ?? '');
      return probe.startsWith(MISCOPIED_TICKET.slice(0, 8)) ? null : { id: msgId };
    });
    const executed: ExecutedAction[] = [
      { tool: 'send_chat_message', ok: true, staged: false, ids: { messageId: msgId } },
    ];
    const claims = [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET} — open for triage.`, id: MISCOPIED_TICKET }] as any[];
    expect(stampMiscopiedIds(claims, executed, [])).toBe(0);
    expect(claims[0].miscopiedFrom).toBeUndefined();
  });

  it('markFabricatedIds skips a miscopy — a unit pin of the skip', async () => {
    const claims: any[] = [{ kind: 'ticket', detail: `Ticket: filed. It's ${MISCOPIED_TICKET}`, id: MISCOPIED_TICKET, miscopiedFrom: REAL_TICKET }];
    const marked = await markFabricatedIds(claims, INCIDENT_NOTE, []);
    expect(marked).toBe(0);
    expect(claims[0].fabricatedId).toBeUndefined();
  });

  it('levenshteinWithin — bound arithmetic, length gate and early exit', () => {
    // The incident pair: exactly 1 (dropped char).
    expect(levenshteinWithin(MISCOPIED_TICKET, REAL_TICKET, 2)).toBe(1);
    expect(levenshteinWithin(MISCOPIED_TICKET, REAL_TICKET, 1)).toBe(1);
    // Over budget returns max+1.
    expect(levenshteinWithin('aaaaaaaa', 'bbbbbbbb', 1)).toBe(2);
    // Length gate: more than max apart short-circuits.
    expect(levenshteinWithin('abcd', 'abcdefgh', 2)).toBe(3);
    // Identical strings are 0.
    expect(levenshteinWithin(REAL_TICKET, REAL_TICKET, 2)).toBe(0);
  });

  it('an 8-char prefix citation corrupted INSIDE the prefix also recovers (the bucket-blind shape)', async () => {
    // The fleet's dominant citation idiom is the 8-char prefix — corrupt it in
    // the middle ('59a407b' for '59a4407b') and the same-prefix bucket is
    // empty; the stamp must still recover the full real id.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: `Ticket: filed. It's 59a407b — open for triage.`, id: '59a407b' }],
    }) as never);
    const note = `**Ticket: filed.** It's \`59a407b\` — bug_report, priority 3, open for triage. The web_pipe failure class is documented there for the pipeline team to route.`;

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note,
      parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS, machineTriggered: false,
    });
    await flush();
    const claim = comp.phantoms.find((p) => String(p.id) === '59a407b');
    expect(claim?.miscopiedFrom).toBe(REAL_TICKET);
  });

  it('reviewer Finding A — SUBSTITUTION and INSERTION corruptions of an 8-char prefix also recover (all three alignments)', async () => {
    // The window spans cited.length −1/0/+1: a DROPPED char cites 7 ('59a4407'
    // → '59a4407' minus one), a SUBSTITUTION cites 8 ('59a4407b' with one hex
    // swapped), an INSERTED char cites 9. Pre-fix only the −1 shape recovered;
    // the other two degenerated back to fabricatedId + "ALSO NOT DONE — call
    // the tool" (the duplicate-filing advice this ticket exists to kill).
    const shapes: Array<[string, string]> = [
      ['59a4507b', 'substitution inside the prefix'],   // '4'→'5' at index 3
      ['59a4407bb', 'insertion inside the prefix'],      // doubled tail char
    ];
    for (const [cited, label] of shapes) {
      mockUtilityChat.mockReset();
      mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
        claims: [{ kind: 'ticket', detail: `Ticket: filed. It's ${cited} — open for triage.`, id: cited }],
      }) as never);
      const note = `**Ticket: filed.** It's \`${cited}\` — bug_report, priority 3, open for triage. The web_pipe failure class is documented there for the pipeline team to route.`;

      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: note,
        parts: INCIDENT_PARTS, receipts: INCIDENT_RECEIPTS, machineTriggered: false,
      });
      await flush();
      const claim = comp.phantoms.find((p) => String(p.id) === cited);
      expect(claim).toBeDefined();
      expect(claim?.miscopiedFrom).toBe(REAL_TICKET);
      expect(claim?.fabricatedId).toBeUndefined();
      void label;
    }
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });
