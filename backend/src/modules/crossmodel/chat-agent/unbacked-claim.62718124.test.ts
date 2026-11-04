/**
 * Ticket 62718124 — the receipt-vs-claim verb check's three precision legs:
 *
 *   (1) SENTENCE-LEVEL ANY-IN-CLASS VOUCH: an honest ACTIONS-TAKEN sentence
 *       names the act's other artifacts (the goal it moved, the chat it
 *       messaged) next to the act's OWN receipt citation. The per-id vouch
 *       (f05b38c1) cleared the honest citation itself but let the ENTITY id —
 *       resolving via its envelope to an old receipt of another tool — strike
 *       the whole sentence act-grade, rewriting a truthful claim into a false
 *       denial ("I have not made that change yet") that contradicted its own
 *       ACTIONS TAKEN block. Prod specimens (receipts held, 2026-10-18):
 *         5c48f492: "send_chat_message → Fleet Supervisor (chat c0e22e36),
 *                    receipt 5ef5b9e3: goal d1a991a1 DONE state change + …"
 *                    (5ef5b9e3 IS that run's ok send receipt; the goal id
 *                    resolved to goal_update and struck)
 *         41bd202a: "closed todo 276c004d done … (todo a62eb6ce + todo
 *                    2ba14b54)" — the closed class contains todo_update, but
 *                    the conviction shape is the same.
 *   (2) MAP WIDENING: `retired`/`archived` of a CHAT runs archive_chat
 *       (specimen: "Retired the reviewer chat … archive_chat 518c6687 ok").
 *   (3) The AGGREGATE warn's LEVEL: act-grade stays WARN (the wrong-tool-CLAIM
 *       signal this warn exists for); a REPORT-only wake is the
 *       f05b38c1-adjudicated BENIGN class → INFO, which keeps it out of the
 *       log-signal sweep's hourly series (the sweep reads warn+error only)
 *       while the per-row metric rows keep the full observe-only baseline.
 *
 * The DETECTOR-RECALL REPLAY cases replay the check's PRIOR true positives
 * and assert they STILL fire (the ad60c49d close claim, the 05126597 passive
 * apposition, the ad60c49d wrong-tool strike — the TPs cite NO in-class
 * sibling, so the sentence vouch cannot acquit them).
 */
const mockPrisma: any = {
  runToolReceipt: {
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => receiptRows.slice()),
  },
  crossModelChat: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  receiptTripleCandidates,
  receiptToolMismatches,
  tripleAggregateLogLevel,
} from './unbacked-claim';
import { expectedToolsForCitation, claimVerbActClass } from '../platform/claim-verb-classes';

const receiptRows: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  receiptRows.length = 0;
  delete process.env.RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED;
  delete process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED;
  mockPrisma.runToolReceipt.findMany.mockImplementation(async () => receiptRows.slice());
});

// ── (0) the ticket's OWN specimen — the fingerprint the sweep filed ────────

describe('62718124 — the ticket-filed specimen (chat 41bd202a: the sweep fingerprint <n>bd<n>a)', () => {
  it('DETECTOR-RECALL REPLAY (pre-fix TRUE conviction, post-fix HONEST): the 23:00Z "Action: closed todo 276c004d" sentence no longer strikes', async () => {
    // The sweep filed this ticket on the 41bd202a fingerprint (its id slice
    // survives normalization: 41bd202a → <n>bd<n>a). The 2026-10-18T23:00Z row
    // (receipt_tool_mismatch, grade=act, verb=closed, receiptId=276c004d)
    // convicted THIS sentence — the run's own note (msg 5586857f) delivered
    // with the false honest-line "I have not made that change yet — nothing
    // was changed in this answer." wedged into the middle of the truthful
    // ACTIONS TAKEN block.
    // The run's REAL receipts (get_run_receipts chat-8cc96be1, this run):
    //   todo_update 9214e63f { todoId: 276c004d-d09d-4e2a-b7ce-a717f883f7bc } ok
    //   send_chat_message 0457da65 { chatId: c0e22e36-… } ok
    // Structural proof the fix covers it: the sentence's claimed act (closing
    // todo 276c004d) resolves to an OK todo_update INSIDE the `closed` class
    // — so after PR #1775 the act-grade candidate for 276c004d is vouched by
    // the per-id rule itself (f05b38c1 ANY-in-class), and the sibling ids
    // (a62eb6ce, 2ba14b54 — covering-row citations) cannot strike it either
    // once any cited id in the sentence resolves in-class. The 23:00Z
    // conviction was the per-id vouch's blind spot: it matched the id to a
    // todo_get envelope (196d40d1/15f51643) instead of the todo_update, and
    // convicted on the read-tool match.
    receiptRows.push(
      { id: '9214e63f-1111-2222-3333-444444444444', tool: 'todo_update', ok: true, ids: { todoId: '276c004d-d09d-4e2a-b7ce-a717f883f7bc' } },
      { id: '196d40d1-1111-2222-3333-444444444444', tool: 'todo_get', ok: true, ids: { todoId: '276c004d-d09d-4e2a-b7ce-a717f883f7bc' } },
      { id: '15f51643-1111-2222-3333-444444444444', tool: 'todo_get', ok: true, ids: { todoId: 'a62eb6ce-1111-2222-3333-444444444444' } },
      { id: '0457da65-1111-2222-3333-444444444444', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' } },
    );
    const text = '**Action:** closed todo 276c004d done with the full covering-row mapping recorded as evidence (todo_update returned, row carries a62eb6ce + 2ba14b54 as cover).';
    const out = await receiptToolMismatches('chat-41bd202a', text);
    expect(out).toHaveLength(0);
  });

  it('the same 41bd202a sentence STILL strikes when the close is NOT receipt-backed (no in-class row anywhere) — the recall direction', async () => {
    // Only the todo_get rows exist (reads, not acts): a close claim citing a
    // read-only envelope stays a wrong-tool act claim — the guard keeps its
    // teeth for the ticket's own fingerprint too.
    receiptRows.push(
      { id: '196d40d1-1111-2222-3333-444444444444', tool: 'todo_get', ok: true, ids: { todoId: '276c004d-d09d-4e2a-b7ce-a717f883f7bc' } },
    );
    const text = '**Action:** closed todo 276c004d done with the full covering-row mapping recorded as evidence (todo_update returned, row carries a62eb6ce + 2ba14b54 as cover).';
    const out = await receiptToolMismatches('chat-41bd202a', text);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const act = out.find((r) => r.grade === 'act');
    expect(act).toBeDefined();
    expect(act!.receiptId).toBe('276c004d');
    expect(act!.actualTool).toBe('todo_get');
  });
});

describe('62718124 — sentence-level any-in-class vouch (act grade)', () => {
  it('DETECTOR-RECALL REPLAY — the ad60c49d wrong-tool CLAIM still strikes: no in-class sibling in the sentence', async () => {
    // The f05b38c1 fixture: an own-act close claim whose cited id resolves to
    // a receipt of the WRONG tool class, with NO honest sibling citation to
    // vouch it.
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'run_command', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
    );
    const out = await receiptToolMismatches('chat-1', 'Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167.');
    expect(out.length).toBe(1);
    expect(out[0].grade).toBe('act');
    expect(out[0].claimClass).toBe('change');
    expect(out[0].expectedTools).toContain('resolve_feedback');
    expect(out[0].actualTool).toBe('run_command');
  });

  it('DETECTOR-RECALL REPLAY — the 05126597 passive apposition still grades ACT', () => {
    const out = receiptTripleCandidates(
      "The fleet's two duplicates (93292353, 9c307167) are pinned at priority 0 with adminNotes pointing at the canonical.",
    );
    for (const id of ['93292353', '9c307167']) {
      const c = out!.find((x) => x.id === id)!;
      expect(c.grade).toBe('act');
      expect(c.verb?.toLowerCase()).toBe('pinned');
    }
  });

  it('the 5c48f492 prod specimen (receipts held): the goal id NO LONGER strikes a sentence whose own send receipt is cited beside it', async () => {
    // receipt 5ef5b9e3 = the run's ok send_chat_message (chatId envelope
    // c0e22e36); goal d1a991a1 → an ok goal_update (goalId envelope).
    receiptRows.push(
      { id: '5ef5b9e3-b3e2-49f7-8569-ee74fc8ab351', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' } },
      { id: '7c1ba4ad-1111-2222-3333-444444444444', tool: 'goal_update', ok: true, ids: { goalId: 'd1a991a1-abb9-4125-a2b6-9cd60c665079' } },
    );
    const text = 'send_chat_message → Fleet Supervisor (chat c0e22e36), receipt 5ef5b9e3: goal d1a991a1 DONE state change + dispatch-help.';
    const out = await receiptToolMismatches('chat-1', text);
    // The goal id is an act-grade candidate (borrow-bound in the sentence of a
    // send noun clause) whose expected class is send_chat_message… — but the
    // sentence's OWN citation (5ef5b9e3) is an ok send receipt: vouched.
    expect(out).toHaveLength(0);
  });

  it('the vouch is earned, not free — A/B on the SAME row set: no in-class sibling → strike; sibling cited → no strike', async () => {
    // The run's real rows (receipts held): the ok send receipt (chatId
    // envelope c0e22e36) and the ok goal_update (goalId envelope d1a991a1).
    receiptRows.push(
      { id: '5ef5b9e3-b3e2-49f7-8569-ee74fc8ab351', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' } },
      { id: '7c1ba4ad-1111-2222-3333-444444444444', tool: 'goal_update', ok: true, ids: { goalId: 'd1a991a1-abb9-4125-a2b6-9cd60c665079' } },
    );
    // B: the sentence cites NO send-class id — nothing vouches the goal id →
    // the wrong-tool-claim signal survives (this half fails if the vouch is
    // ever made unconditional/act-scoped).
    const bare = 'sent the dispatch-help to Fleet Supervisor: goal d1a991a1 DONE state change.';
    const bareOut = await receiptToolMismatches('chat-1', bare);
    expect(bareOut.length).toBe(1);
    expect(bareOut[0].grade).toBe('act');
    expect(bareOut[0].receiptId).toBe('d1a991a1');
    expect(bareOut[0].actualTool).toBe('goal_update');
    // A: the same sentence plus the run's own send receipt citation → the
    // goal id is vouched by its in-class sibling (this half fails if the
    // vouch is removed — the prod FP returns).
    const withReceipt = 'sent the dispatch-help to Fleet Supervisor (receipt 5ef5b9e3): goal d1a991a1 DONE state change.';
    const vouchedOut = await receiptToolMismatches('chat-1', withReceipt);
    expect(vouchedOut).toHaveLength(0);
  });

  it('the vouch never acquits a REPORT-grade row (the observe-only baseline keeps its series)', async () => {
    receiptRows.push(
      { id: '5ef5b9e3-b3e2-49f7-8569-ee74fc8ab351', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' } },
      { id: '7c1ba4ad-1111-2222-3333-444444444444', tool: 'goal_update', ok: true, ids: { goalId: 'd1a991a1-abb9-4125-a2b6-9cd60c665079' } },
    );
    // The f05b38c1 report-up shape: the send receipt is cited as evidence for
    // the REPORT, and the goal id rides a clause whose verb (`merged`) belongs
    // to PR #75. Both grade report — the vouch is act-grade only, and the
    // report rows must still be EMITTED (assert the goal row is present, not
    // merely that whatever is emitted is report-grade).
    const text = 'Fleet report-up to c0e22e36 (receipt 5ef5b9e3): goal d1a991a1 moved — uk-nc science landed, PR #75 merged.';
    const out = await receiptToolMismatches('chat-1', text);
    const goalRow = out.find((r) => r.receiptId === 'd1a991a1');
    expect(goalRow).toBeDefined();
    expect(goalRow!.grade).toBe('report');
    for (const row of out) expect(row.grade).toBe('report');
  });
});

// ── (2) the archive_chat map widening ──────────────────────────────────────

describe('62718124 — retired/archived of a CHAT is archive_chat', () => {
  it('"Retired the reviewer chat (chat 1b3d4fea)" citing its ok archive_chat receipt is honest — no strike', async () => {
    receiptRows.push(
      { id: '518c6687-1111-2222-3333-444444444444', tool: 'archive_chat', ok: true, ids: { chatId: '1b3d4fea-2bb7-41a2-ad00-054c30c03a1c' } },
    );
    const text = 'Retired the stale reviewer chat (chat 1b3d4fea) — receipt 518c6687.';
    const out = await receiptToolMismatches('chat-1', text);
    expect(out).toHaveLength(0);
  });

  it('"archived chat 1b3d4fea" is a mapped change verb backed by archive_chat', () => {
    expect(expectedToolsForCitation('archived')).toContain('archive_chat');
    expect(claimVerbActClass('archived')).toBe('change');
    expect(expectedToolsForCitation('retired')).toContain('archive_chat');
  });

  it('an archived claim citing a WRONG-tool receipt still strikes (the widening vouches, never blinds)', async () => {
    receiptRows.push(
      { id: 'aaaabbbb-1111-2222-3333-444444444444', tool: 'send_chat_message', ok: true, ids: { chatId: '1b3d4fea-2bb7-41a2-ad00-054c30c03a1c' } },
    );
    const out = await receiptToolMismatches('chat-1', 'Archived chat 1b3d4fea (receipt aaaabbbb).');
    expect(out.length).toBe(1);
    expect(out[0].expectedTools).toContain('archive_chat');
    expect(out[0].actualTool).toBe('send_chat_message');
  });
});

// ── (3) the aggregate warn's level ─────────────────────────────────────────

describe('62718124 — the aggregate warn level (act stays WARN, report-only INFO)', () => {
  it('an act-grade mismatch keeps WARN — the wrong-tool-CLAIM signal', () => {
    expect(tripleAggregateLogLevel(1)).toBe('warn');
    expect(tripleAggregateLogLevel(3)).toBe('warn');
  });

  it('a REPORT-only wake is INFO — the f05b38c1-adjudicated benign class leaves the sweep series', () => {
    expect(tripleAggregateLogLevel(0)).toBe('info');
  });
});
