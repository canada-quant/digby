/**
 * ROLLOUT-WATCH TICK 21 (2026-09-15, 22:00–23:50Z) — invented ids PASSING the
 * verifier in three delivered Fleet Supervisor notes (chat c0e22e36):
 *   - 20:42Z: "all active lanes re-probed fresh (msgs 469d1c90, fbe61917,
 *     d0e5a42e, 95d58c28; chats b92ef13f, daee2916)"
 *   - 20:53Z: "both watchers healthy (msgs 469d1c90, fbe61917, c6f93b25;
 *     chats 59cb243f, f31cb903)"
 *   - 21:03Z: "Its monitor passed another clean check (receipt 949c1f4b) and
 *     CanLaw's data build ticked 1,090/2,000 (receipt 903ebfda …)"
 * Every msg/receipt id and the two chat ids exist in NO table, NO transcript
 * and NO tool output of those runs — and NOT ONE was struck. Three gaps:
 *   (1) every evidence miner keyed on "<noun> <id>" and mined only the FIRST
 *       id after the noun (the b216475a pin recorded that as accepted scope);
 *   (2) no lane audited `receipt <id>` evidence citations;
 *   (3) the session-ref lane mines only dispatch/owner-ref IDIOMS, so a bare
 *       "chats x, y" observation citation reached no lane.
 * This file pins the fix: expandCitationLists (list → repeated singular
 * citations, `;` = family boundary), the receipt lane, the bare chat lane,
 * and computePhantomClaims wiring on the incident lines.
 *
 * Mock discipline mirrors action-verifier.b216475a.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
const mockAppendVerifierRefutation = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a) }));

import {
  citationSentence, expandCitationLists, expandCitationListsDetailed, findPhantomEvidenceCitations, mineEvidenceCitations, mineScheduleCitations, mineGoalTodoCitations, mineTicketCitations,
  mineReceiptCitations, mineChatCitations, findPhantomReceiptCitations, findPhantomChatCitations,
  computePhantomClaims, isCitationClassClaim, type ExtractedClaim,
} from './action-verifier';

const CHAT = 'c0e22e36-1111-2222-3333-444455556666';
const noHints = async () => [] as string[];
const L2053 = 'CanLaw bench re-probed: unchanged, both watchers healthy (msgs 469d1c90, fbe61917, c6f93b25; chats 59cb243f, f31cb903). Nothing needs you.';
const L2103 = 'Its monitor passed another clean check (receipt 949c1f4b) and CanLaw\'s data build ticked 1,090/2,000 (receipt 903ebfda, freshly stamped at 20:54Z).';

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as jest.Mock[]) fn.mockReset();
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null); mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.findFirst.mockResolvedValue(null); mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null); mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.projectGoal.findFirst.mockResolvedValue(null); mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue(null); mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.runToolReceipt.findFirst.mockResolvedValue(null);
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

describe('expandCitationLists — noun + id list → repeated singular citations (tick 21)', () => {
  it('expands comma lists per family and keeps ";" as the family boundary (the 20:53Z line)', () => {
    expect(expandCitationLists('(msgs 469d1c90, fbe61917, c6f93b25; chats 59cb243f, f31cb903).'))
      .toBe('(msg 469d1c90, msg fbe61917, msg c6f93b25; chat 59cb243f, chat f31cb903).');
  });
  it('handles "and", slashes, backticks, "ids", and the singular noun before a list', () => {
    expect(expandCitationLists('tickets `1322de9e` / `1f7cadb1` and 6cec4aa1 (file_feedback)')).toBe('ticket 1322de9e, ticket 1f7cadb1, ticket 6cec4aa1 (file_feedback)');
    expect(expandCitationLists('schedule ids 08ae015c, 1fd6a55f armed')).toBe('sched 08ae015c, sched 1fd6a55f armed');
    expect(expandCitationLists('lane 0b69e9b1 and e7d9eefb live')).toBe('lane 0b69e9b1, lane e7d9eefb live');
    expect(expandCitationLists('receipts 949c1f4b, 903ebfda stamped')).toBe('receipt 949c1f4b, receipt 903ebfda stamped');
  });
  it('leaves singular citations, prose without ids, and non-hex lists untouched', () => {
    for (const s of ['msg 469d1c90 landed at 20:42Z', 'messages 12, 13 and 14 were long', 'chats with Paul, Sam', 'the todo list: wash, dry']) {
      expect(expandCitationLists(s)).toBe(s);
    }
  });
});

describe('list-aware miners — every id in a list mines (tick 21)', () => {
  it('msg lane mines all three msgs of the 20:53Z line and none of the chats', () => {
    const mined = mineEvidenceCitations(L2053);
    expect(mined.map((c) => c.id)).toEqual(['469d1c90', 'fbe61917', 'c6f93b25']);
    expect(mined.every((c) => c.kind === 'message' && c.detail.startsWith('[evidence citation]'))).toBe(true);
    // detail quotes the ORIGINAL line, not the expanded rewrite
    expect(mined[0].detail).toContain('(msgs 469d1c90, fbe61917, c6f93b25;');
  });
  it('sched / goal+todo / ticket lanes mine full lists too', () => {
    expect(mineScheduleCitations('Re-armed both watchers (scheds 08ae015c, 1fd6a55f) for the morning sweep.').map((c) => c.id)).toEqual(['08ae015c', '1fd6a55f']);
    expect(mineGoalTodoCitations('Ledger pulled fresh: todos 751d7628 and 48c5b216 still open on the monitor lane.').map((c) => [c.kind, c.id])).toEqual([['todo', '751d7628'], ['todo', '48c5b216']]);
    expect(mineTicketCitations('Receipts: tickets 1322de9e, 1f7cadb1, 6cec4aa1, 3562a3d4 (file_feedback).').map((c) => c.id)).toEqual(['1322de9e', '1f7cadb1', '6cec4aa1', '3562a3d4']);
  });
});

describe('receipt lane (tick 21)', () => {
  it('mines both receipt ids of the 21:03Z line as citation-class', () => {
    const mined = mineReceiptCitations(L2103);
    expect(mined.map((c) => c.id)).toEqual(['949c1f4b', '903ebfda']);
    expect(mined.every((c) => c.kind === 'receipt' && isCitationClassClaim(c))).toBe(true);
  });
  it('skips refutation/absence prose, blockquotes, and sub-floor lines', () => {
    expect(mineReceiptCitations('receipt 949c1f4b does not exist — phantom, struck last wake.')).toEqual([]);
    expect(mineReceiptCitations('> clean check (receipt 949c1f4b) — quoted from the struck note')).toEqual([]);
    expect(mineReceiptCitations('receipt 949c1f4b')).toEqual([]);
  });
  it('convicts when the row check is false, exonerates on an existing row, on a haystack hit, or on an action-claim carry; fails toward MISS on a probe error', async () => {
    expect((await findPhantomReceiptCitations(L2103, [], async () => false, [])).map((c) => c.id)).toEqual(['949c1f4b', '903ebfda']);
    expect(await findPhantomReceiptCitations(L2103, [], async () => true, [])).toEqual([]);
    const check = jest.fn(async () => false);
    const hay = ['{"ok":true,"receiptId":"949c1f4b-1234-4321-8765-0123456789ab"}', '{"ok":true,"receiptId":"903ebfda-aaaa-bbbb-cccc-dddddddddddd"}'];
    expect(await findPhantomReceiptCitations(L2103, [], check, hay)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    const carried = [{ kind: 'ticket', detail: 'I filed it', id: '949c1f4b' } as ExtractedClaim];
    expect((await findPhantomReceiptCitations(L2103, carried, async () => false, [])).map((c) => c.id)).toEqual(['903ebfda']);
    expect(await findPhantomReceiptCitations(L2103, [], async () => { throw new Error('db down'); }, [])).toEqual([]);
  });
  it('the default probe is run_tool_receipts, prefix-matched', async () => {
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: '949c1f4b-1234-4321-8765-0123456789ab' }).mockResolvedValueOnce(null);
    expect((await findPhantomReceiptCitations(L2103, [])).map((c) => c.id)).toEqual(['903ebfda']);
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { startsWith: '949c1f4b' } } }));
  });
});

describe('bare chat lane (tick 21)', () => {
  it('mines the two chats of the 20:53Z line (and not the msgs)', () => {
    expect(mineChatCitations(L2053).map((c) => [c.kind, c.id])).toEqual([['chat', '59cb243f'], ['chat', 'f31cb903']]);
  });
  it('mines "lane <id>" / "session <id>" observation citations, never markdown chatId= query strings on their own', () => {
    expect(mineChatCitations('lane 0b69e9b1 pushed branch digby/session-0b69e9b1 after 7/7 suites.').map((c) => c.id)).toEqual(['0b69e9b1']);
    expect(mineChatCitations('[Tenstorrent R&D](/crossmodel?chatId=f31cb903) new faster serving recipe passed every gate.')).toEqual([]);
  });
  it('leaves the session-ref lane its idioms (no double-mining) and skips the deletion / failure / quoted registers', () => {
    expect(mineChatCitations('Dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933 for the census re-run this wake.')).toEqual([]);
    expect(mineChatCitations('chat 580e2d84 was deleted by its lane after the merge landed.')).toEqual([]);
    expect(mineChatCitations('lane 48dc7f05 failed to start — the dispatch returned a 409 this wake.')).toEqual([]);
    expect(mineChatCitations('The owner wrote "look at chat 2d4ff22f" — quoting, not citing, that id here.')).toEqual([]);
  });
  it('convicts on a false row check with chat near-miss hints; exonerates on existing rows, haystack, executed ids and action-claim carries', async () => {
    const hints = ['59cb243f-aaaa-bbbb-cccc-dddddddddddd (chat "CanLaw bench watcher")'];
    const phantoms = await findPhantomChatCitations(L2053, [], [], async () => false, async () => hints, []);
    expect(phantoms.map((c) => c.id)).toEqual(['59cb243f', 'f31cb903']);
    expect(phantoms[0].nearMiss).toEqual(hints);
    expect(await findPhantomChatCitations(L2053, [], [], async () => true, noHints, [])).toEqual([]);
    expect(await findPhantomChatCitations(L2053, [], [], async () => false, noHints, ['{"chats":[{"id":"59cb243f-…"},{"id":"f31cb903-…"}]}'])).toEqual([]);
    const executed = [{ tool: 'send_chat_message', ok: true, ids: { chatId: '59cb243f-aaaa-bbbb-cccc-dddddddddddd' } } as any];
    expect((await findPhantomChatCitations(L2053, [], executed, async () => false, noHints, [])).map((c) => c.id)).toEqual(['f31cb903']);
    const carried = [{ kind: 'dispatch', detail: 'started it', id: 'f31cb903' } as ExtractedClaim];
    expect((await findPhantomChatCitations(L2053, carried, [], async () => false, noHints, [])).map((c) => c.id)).toEqual(['59cb243f']);
  });
});

describe('computePhantomClaims wiring — the three delivered fleet lines now convict (tick 21)', () => {
  const base = { chatId: CHAT, userId: 'u1', parts: [] as any[], receipts: [] as any[], supervisor: true, machineTriggered: true, runStartedAt: new Date('2026-09-15T20:53:00.000Z') };

  it('20:53Z: five convictions — three msgs + two chats — all citation-class', async () => {
    const out = await computePhantomClaims({ ...base, finalText: `Fleet sweep — 20:53Z: CanLaw past the halfway mark.\n${L2053}` });
    expect(out.phantoms.map((p) => [p.kind, p.id]).sort()).toEqual([['chat', '59cb243f'], ['chat', 'f31cb903'], ['message', '469d1c90'], ['message', 'c6f93b25'], ['message', 'fbe61917']].sort());
    expect(out.phantoms.every(isCitationClassClaim)).toBe(true);
  });

  it('21:03Z: both receipt ids convict; a receipt id VERBATIM in a tool_result part is exonerated end-to-end', async () => {
    const out = await computePhantomClaims({ ...base, finalText: `Fleet sweep — 20:55Z: bench rebuild past 40,000 records.\n${L2103}` });
    expect(out.phantoms.map((p) => [p.kind, p.id]).sort()).toEqual([['receipt', '903ebfda'], ['receipt', '949c1f4b']]);
    const honest = await computePhantomClaims({
      ...base, finalText: `Fleet sweep — 20:55Z: bench rebuild past 40,000 records.\n${L2103}`,
      parts: [{ type: 'tool_result', name: 'get_chat_status', result: '{"ok":true,"receiptId":"949c1f4b-1234-4321-8765-0123456789ab"}' }, { type: 'tool_result', name: 'get_chat_status', result: '{"ok":true,"receiptId":"903ebfda-aaaa-bbbb-cccc-dddddddddddd"}' }] as any[],
    });
    expect(honest.phantoms).toEqual([]);
  });

  it('real rows exonerate the same lines (crossmodel_messages / crossmodel_chats / run_tool_receipts prefix probes)', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'x' });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'y' });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue({ id: 'z' });
    const out = await computePhantomClaims({ ...base, finalText: `Fleet sweep — 20:53Z.\n${L2053}\n${L2103}` });
    expect(out.phantoms).toEqual([]);
  });
});

describe('sentence-scoped exclusion registers (rollout-watch tick 22, 2026-09-16)', () => {
  // The two DELIVERED lines the whole-line register let through (trimmed, the
  // register word kept at its real distance from the citation).
  const FLEET_0139 = 'WAKE: no-op — nothing moved on any project since 01:38Z. The B300 lane\'s event is a mid-self-audit completion with no reported change to the node\'s paused state; its lane ([Scaffold Inference Container](/crossmodel?chatId=d7138361-e978-4a73-90f6-b0d823e16737), chat d7138361, fresh list_chats pull this wake) stays healthy with no enabled schedules by design. The owner\'s question is unchanged and the earlier digest is now stale relative to the 01:20Z list, so nothing to send.';
  const SPARK_0114 = '**01:13Z — verdict watch fired for the seventh time; Arm B was already complete and the verdict already delivered, so this watch closes itself.** Fresh pulls this run confirm what the earlier sweeps established: bench lane (chat e6ea164d) idle, plan 7/7 complete, 0 enabled schedules — its last row reports run 6/6, all four tasks completed. Kernel-opt (chat 1565dd16): last firing 46m ago, sched a98ffc41 next 10:16Z, msg 5d52c3ca is its latest row.';

  it('citationSentence returns the sentence around the match — dashes/semicolons stay inside, ". " + capital splits, decimals and "e.g. the" do not', () => {
    const line = 'First sentence here. Receipts: msg aaaaaaaa landed; the digest is 0.5 GB, e.g. the big one — nothing to send. Next sentence is stale.';
    expect(citationSentence(line, line.indexOf('msg aaaaaaaa'))).toBe('Receipts: msg aaaaaaaa landed; the digest is 0.5 GB, e.g. the big one — nothing to send');
    expect(citationSentence(line, line.indexOf('First'))).toBe('First sentence here');
    expect(citationSentence(line, line.indexOf('Next'))).toBe('Next sentence is stale.');
  });

  it('a register word in ANOTHER sentence of the same line no longer exempts the citation (the two delivered lines now mine)', () => {
    expect(mineChatCitations(FLEET_0139).map((c) => c.id)).toEqual(['d7138361']);
    // e6ea164d shares its sentence with "plan 7/7" (the intent register) and
    // stays excluded — under-mining a probably-real chat is the safe side;
    // 1565dd16 sits in the next sentence and mines.
    expect(mineChatCitations(SPARK_0114).map((c) => c.id)).toEqual(['1565dd16']);
    expect(mineEvidenceCitations(SPARK_0114).map((c) => c.id)).toEqual(['5d52c3ca']);
    expect(mineScheduleCitations(SPARK_0114).map((c) => c.id)).toEqual(['a98ffc41']);
  });

  it('an honest retraction in the citation\'s OWN clause still excludes — every lane', () => {
    expect(mineEvidenceCitations('Correction: msg b50992c6 does not exist — I invented it last wake; dropping it.')).toEqual([]);
    expect(mineChatCitations('chat d7138361 was deleted by its lane after the merge landed; nothing to read.')).toEqual([]);
    expect(mineReceiptCitations('The receipt 949c1f4b never existed — struck and retracted.')).toEqual([]);
    expect(mineTicketCitations('ticket 1322de9e not found in user_feature_requests — dropping the citation.')).toEqual([]);
    expect(mineGoalTodoCitations('todo 751d7628 is unresolvable on the board — never resolved, dropping it.')).toEqual([]);
    // …a retraction shields every id in ITS sentence (";" is not a boundary —
    // the safe side), but not a fresh citation in the NEXT sentence.
    expect(mineEvidenceCitations('msg b50992c6 was struck as fabricated last wake; so was msg 4dcdeeb2. This wake the lane\'s real row is msg 5d52c3ca.').map((c) => c.id)).toEqual(['5d52c3ca']);
  });

  it('first-person action narration still skips the chat lane, but "Arm B", "final" and "OPEN" no longer trip it', () => {
    expect(mineChatCitations('Status: I dispatched three burn-down workers (sessions 23a1e15e, 52ec57b9, f762dc33) and they are working the queue now.')).toEqual([]);
    expect(mineChatCitations('Arm B verdict landed as we expected; the monitor lane (chat 899ccb42) posted its final row and the directive stays OPEN.').map((c) => c.id)).toEqual(['899ccb42']);
  });
});

describe('list expansion stops at a lane-label id; inferred kinds exonerate on ANY real row (rollout-watch tick 24, 2026-09-16)', () => {
  // The bench supervisor's 05:32Z line — DELIVERED with this honest line REMOVED
  // because the expansion read "619a1241" (a REAL lane chat) as the second
  // member of the msg list and the msg lane struck it as a fabricated message.
  const BENCH_0532 = '- **Lanes:** all idle-healthy — 3e1cae6f msg f68410cf, 619a1241 msg 619f11f9. Nothing stuck.';

  it('an id that labels the NEXT citation is re-emitted bare, never relabelled as a list member', () => {
    expect(expandCitationLists(BENCH_0532)).toBe(BENCH_0532);
    expect(mineEvidenceCitations(BENCH_0532).map((c) => c.id)).toEqual(['f68410cf', '619f11f9']);
    expect(mineChatCitations(BENCH_0532)).toEqual([]); // bare ids carry no noun — no lane mines them
    // Three-member list whose last id labels the next citation: two members expand, the label stays bare.
    expect(expandCitationLists('msgs aaaaaaaa, bbbbbbbb, cccccccc msg dddddddd')).toBe('msg aaaaaaaa, msg bbbbbbbb, cccccccc msg dddddddd');
    // A genuine list before ")" / ";" / end still expands fully.
    expect(expandCitationLists('(msgs aaaaaaaa, bbbbbbbb; chats cccccccc, dddddddd)')).toBe('(msg aaaaaaaa, msg bbbbbbbb; chat cccccccc, chat dddddddd)');
  });

  it('marks list-inferred ids (every member after the first) so a kind-probe miss falls back to the kind-agnostic probe', () => {
    const { text, inferred } = expandCitationListsDetailed('Receipts: msgs f68410cf, 619a1241 (lane id pasted into the list).');
    expect(text).toBe('Receipts: msg f68410cf, msg 619a1241 (lane id pasted into the list).');
    expect([...inferred]).toEqual(['619a1241']);
    const mined = mineEvidenceCitations('Receipts: msgs f68410cf, 619a1241 (lane id pasted into the list).');
    expect(mined.map((c) => [c.id, c.listInferred === true])).toEqual([['f68410cf', false], ['619a1241', true]]);
  });

  it('msg lane: an inferred id that exists as a CHAT row is exonerated; an explicitly labelled mislabel still convicts', async () => {
    mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) => (String(args?.where?.id?.startsWith ?? '').startsWith('619a1241') ? { id: '619a1241-b080-4630-bfc3-5aa5456b1cd0' } : null));
    const inferredLine = 'Receipts: msgs f68410cf, 619a1241 (lane id pasted into the list).';
    const out = await findPhantomEvidenceCitations(inferredLine, [], async () => false, noHints, []);
    expect(out.map((c) => c.id)).toEqual(['f68410cf']); // 619a1241 exonerated via the chat row
    const explicit = 'Receipts: msg f68410cf, msg 619a1241 (explicitly labelled as a message).';
    expect((await findPhantomEvidenceCitations(explicit, [], async () => false, noHints, [])).map((c) => c.id)).toEqual(['f68410cf', '619a1241']);
  });
});
