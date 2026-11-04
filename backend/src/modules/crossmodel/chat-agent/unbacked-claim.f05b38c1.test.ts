/**
 * Ticket f05b38c1 — ENFORCE the receipt-vs-claim verb check (the observe-only
 * d597ce5d leg) + the own-artifact tier's verb-mismatch exoneration.
 *
 * The production adjudication (probe /tmp/probe-f05b38c1.js, box A, 7-day
 * window, 179 receipt_tool_mismatch rows): the rows split into
 *   ACT-GRADE (enforced): an own-act claim clause citing a receipt of the
 *     wrong tool class — the ad60c49d / 05126597 specimen class, and
 *   REPORT-GRADE (observe-only forever): honest status reports where a
 *     mapped verb belongs to another actor or another clause —
 *     "Fleet report-up to c0e22e36 (receipt 250ec3f7): goal 53c7e5f6 moved —
 *      … PR #75 merged" (the receipt is the honest SEND receipt; `merged`
 *     belongs to PR #75's clause),
 *     "One-shots armed: 89cec5aa 03:02Z …" (a third-party subject),
 *     "todo 9c89ab21 closed by lane cb941a0a" (the lane closed it),
 *     "Ticket dedupe: canonical = 1b1c41bc" (an entity restatement).
 * Blanket enforcement would mass-rewrite honest notes (587e9d64 — a false
 * strike is strictly worse than a miss), so the collector GRADES each
 * citation: only an own-act verb governing the id (clause / borrow /
 * passive / noun) reaches the enforcement lane.
 *
 * This suite holds BOTH halves:
 *   (A) the collector's grading + resolution (unbacked-claim),
 *   (B) the verb-consistency veto on the action-verifier's vouching tiers.
 * The DETECTOR-RECALL REPLAY cases below replay the detectors' PRIOR true
 * positives and assert they STILL fire.
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
  receiptTripleEnforceDisabled,
  rewriteUnbackedClaims,
} from './unbacked-claim';
import { governingClaimVerb, expectedToolsForCitation, claimVerbActClass } from '../platform/claim-verb-classes';

/** The chat's receipt rows (the specimens' real shape). */
const receiptRows: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  receiptRows.length = 0;
  delete process.env.RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED;
  delete process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED;
  delete process.env.CLAIM_VERB_CONSISTENCY_DISABLED;
  mockPrisma.runToolReceipt.findMany.mockImplementation(async () => receiptRows.slice());
});

// ── (A) the collector's GRADE — act vs report ───────────────────────────────

describe('f05b38c1 — the citation grade (act enforces, report observes)', () => {
  it('DETECTOR-RECALL REPLAY — the ad60c49d own-act close claim grades ACT with the close verb (the prior true positive still fires)', () => {
    const out = receiptTripleCandidates(
      'ACTIONS TAKEN\n\n- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
    );
    expect(out).not.toBeNull();
    const c = out!.find((x) => x.id === '9c307167')!;
    expect(c.grade).toBe('act');
    expect(c.verb?.toLowerCase()).toBe('resolved');
    expect(expectedToolsForCitation(c.verb)).toContain('resolve_feedback');
  });

  it('DETECTOR-RECALL REPLAY — the 05126597 passive-apposition payload grades ACT (prior true positive still fires)', () => {
    const out = receiptTripleCandidates(
      "The fleet's two duplicates (93292353, 9c307167) are pinned at priority 0 with adminNotes pointing at the canonical.",
    );
    expect(out).not.toBeNull();
    for (const id of ['93292353', '9c307167']) {
      const c = out!.find((x) => x.id === id)!;
      expect(c.grade).toBe('act');
      expect(c.verb?.toLowerCase()).toBe('pinned');
      expect(expectedToolsForCitation(c.verb)).toContain('update_feedback');
    }
  });

  it('DETECTOR-RECALL REPLAY — an act-grade mismatch carries the sentence span + claim class (the rewrite can act)', async () => {
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
    );
    const text = 'Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167.';
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.length).toBe(1);
    expect(out[0].grade).toBe('act');
    expect(out[0].span).toBeDefined();
    expect(out[0].span![1]).toBeGreaterThan(out[0].span![0]);
    expect(out[0].claimClass).toBe('change');
    // The enforcement lane's rewrite actually replaces the claim sentence.
    const rewritten = rewriteUnbackedClaims(text, [{ cls: 'change', phrase: out[0].phrase, start: out[0].span![0], end: out[0].span![1], source: 'dispatch' }]);
    expect(rewritten).not.toContain('Resolved duplicate ticket');
    expect(rewritten).toContain('I have not made that change yet');
  });

  it('the REPORT-grade classes stay observe-only — never act, never a span', () => {
    // (1) cross-clause verb: the receipt is the honest send receipt; "merged" belongs to PR #75's clause.
    const reportUp = receiptTripleCandidates(
      'Fleet report-up to c0e22e36 (receipt 250ec3f7): goal 53c7e5f6 moved — uk-nc science landed, PR #75 merged, premises 4,421 → 4,427.',
    );
    const sendId = reportUp?.find((c) => c.id === '250ec3f7');
    expect(sendId?.grade ?? 'report').not.toBe('act');
    // (2) third-party subject: the LANE closed the todo, not this note.
    const byLane = receiptTripleCandidates('todo 9c89ab21 closed by lane cb941a0a (receipt fea78360).');
    for (const c of byLane ?? []) expect(c.grade).toBe('report');
    // (3) a paren entity aside — an enumeration of OTHER objects.
    const aside = receiptTripleCandidates('Steered the supervisor (todos 38b83fa7, 80150024 now done) — receipt 250ec3f7.');
    const asideIds = aside?.filter((c) => c.id !== '250ec3f7') ?? [];
    for (const c of asideIds) expect(c.grade).toBe('report');
    // (4) a series participle: "— merged, deployed, regression-pinned" is a status elaboration.
    const series = receiptTripleCandidates('the fix is fully done — merged, deployed, regression-pinned (ticket 13dfa16d).');
    for (const c of series ?? []) expect(c.grade).toBe('report');
  });

  it('the honest sibling-act class — "re-armed X … as sched 0059e4e4 — receipt fea78360" — grades by the SAME-clause verb (not the sibling borrow)', () => {
    const out = receiptTripleCandidates(
      'Closed it this wake: re-armed the read-back verbatim on this supervisor chat as sched 0059e4e4 (once, 30-min) — receipt fea78360.',
    );
    const c = out?.find((x) => x.id === '0059e4e4');
    expect(c).toBeDefined();
    expect(c!.grade).toBe('act');
    expect(c!.verb?.toLowerCase()).toBe('armed'); // the re-armed ACT governs its own object
  });

  it('the HONEST todo/goal close vocabulary never strikes (map widening): "Closed todo fea78360" + its todo_update receipt', async () => {
    receiptRows.push({ id: 'fea78360-aaaa', tool: 'todo_update', ok: true, ids: { todoId: 'fea78360-1111-2222-3333-444444444444' } });
    const out = await receiptToolMismatches('chat-1', 'Closed todo fea78360 this wake — receipt fea78360.');
    expect(out).toEqual([]);
  });

  it('resolution prefers ANY in-class receipt (the send receipt vouches an id that ALSO lives on a goal_update envelope)', async () => {
    receiptRows.push(
      { id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } },
      { id: '53c7e5f6-bbbb', tool: 'goal_update', ok: true, ids: { goalId: '53c7e5f6-1111-2222-3333-444444444444' } },
    );
    // The id resolves to BOTH receipts; ANY in-class (send) vouches — no mismatch.
    const out = await receiptToolMismatches('chat-1', 'Sent the fleet report-up to the supervisor — receipt 250ec3f7.');
    expect(out).toEqual([]);
  });

  it('a passive-state report ("now resolved" with no copula) is NOT an own-act claim', () => {
    const out = receiptTripleCandidates('The outage is behind us: the alert cleared, the box back, the runbook now resolved (todo 13dfa16d).');
    for (const c of out ?? []) expect(c.grade).toBe('report');
  });

  // ── review findings B1–B3 (adversarial reviewer, 2026-10-17) — regression pins ──

  it('B1: an AGENTIVE passive ("Merged by the fleet / closed by lane X") is a THIRD-PARTY report — never act, never rewritten', () => {
    const out = receiptTripleCandidates('Merged by the fleet at 21:57Z — receipt 250ec3f7.');
    const c = out?.find((x) => x.id === '250ec3f7');
    expect(c?.grade ?? 'report').toBe('report');
    expect(governingClaimVerb('todo 9c89ab21 was closed by lane cb941a0a — the dedupe landed.')).toBeUndefined();
    expect(governingClaimVerb('The incident was closed by the on-call rotation before this wake.')).toBeUndefined();
    expect(governingClaimVerb('sched 0059e4e4 was retired by lane 645b39f6.')).toBeUndefined();
    // First-person agent stays own-act.
    expect(governingClaimVerb('The cleanup was closed by me this wake.')).toBe('closed');
  });

  it('B2: the triple rewrite NEVER collapses an ACTIONS TAKEN block — honest sibling bullets survive', () => {
    const text = [
      'ACTIONS TAKEN',
      '',
      '- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
      '- Sent the fleet report-up to c0e22e36 — receipt 250ec3f7',
      '- Filed one owner question about the LiteLLM key (ticket a6ebb5a2)',
      '',
      'NEXT: watch the deploy.',
    ].join('\n');
    const span = [text.indexOf('- Resolved'), text.indexOf('\n- Sent')] as [number, number];
    const rewritten = rewriteUnbackedClaims(text, [{ cls: 'change', phrase: 'Resolved duplicate ticket', start: span[0], end: span[1], source: 'dispatch' }], { noBlockCollapse: true });
    expect(rewritten).toContain('I have not made that change yet');
    expect(rewritten).toContain('Sent the fleet report-up'); // honest sibling survives
    expect(rewritten).toContain('Filed one owner question'); // honest sibling survives
    expect(rewritten).toContain('NEXT: watch the deploy.');
    // The default (residual-lane) path still collapses — unchanged behavior for its callers.
    const collapsed = rewriteUnbackedClaims(text, [{ cls: 'change', phrase: 'Resolved duplicate ticket', start: span[0], end: span[1], source: 'action' }]);
    expect(collapsed).not.toContain('Filed one owner question');
  });

  it('B3: the SCHEDULE close verbs are in the close class — an honest cancel_schedule close never strikes', async () => {
    receiptRows.push({ id: '0059e4e4-aaaa', tool: 'cancel_schedule', ok: true, ids: { scheduleId: '0059e4e4-1111-2222-3333-444444444444' } });
    const out = await receiptToolMismatches('chat-1', 'Closed the stale one-shot schedule 0059e4e4 — receipt 0059e4e4.');
    expect(out).toEqual([]);
    receiptRows.length = 0;
    receiptRows.push({ id: '0059e4e4-aaaa', tool: 'update_schedule', ok: true, ids: { scheduleId: '0059e4e4-1111-2222-3333-444444444444' } });
    const out2 = await receiptToolMismatches('chat-1', 'Closed out the stale one-shot on schedule 0059e4e4 — receipt 0059e4e4.');
    expect(out2).toEqual([]);
  });
});

// ── (B) the verb-consistency veto on the verifier's vouching tiers ──────────

describe('f05b38c1 — governingClaimVerb (the pure grammar)', () => {
  it('extracts the clause-initial own-act verb', () => {
    expect(governingClaimVerb('Resolved duplicate ticket 9c307167 via filer self-close')).toBe('Resolved');
  });
  it('extracts a first-person subject verb', () => {
    expect(governingClaimVerb('I steered the supervisor to the new cadence')).toBe('steered');
  });
  it('extracts a passive-bridge verb (the acted-on subject precedes)', () => {
    expect(governingClaimVerb('The duplicates (93292353, 9c307167) are pinned at priority 0')).toBe('pinned');
  });
  it('skips an article participle ("the armed schedule") — and a mid-clause verb governs nothing either: the doctrine-correct answer is undefined (no judgment)', () => {
    // "armed" is a participle in a noun phrase (skipped); "sent" sits mid-clause
    // behind "and" (a coordination, not an own-act clause head). With NO
    // governing verb the veto judges nothing — fail toward miss (587e9d64).
    expect(governingClaimVerb('the armed schedule fired and sent the report')).toBeUndefined();
  });
  it('a series participle ("merged, deployed, regression-pinned") narrates no own act', () => {
    expect(governingClaimVerb('merged, deployed, regression-pinned, all boxes live')).toBeUndefined();
  });
  it('a third-party subject ("PR #75 merged") narrates no own act', () => {
    expect(governingClaimVerb('PR #75 merged at 01:59Z')).toBeUndefined();
  });
  it('the 5ad80b27 mercy — a coordination ("and updated the todo ledger") narrates no governing own-act verb', () => {
    expect(governingClaimVerb('re-ran the Gmail sweep on all four accounts, and updated the todo ledger')).toBeUndefined();
  });
  it('the act class maps send vs change for the honest line', () => {
    expect(claimVerbActClass('sent')).toBe('send');
    expect(claimVerbActClass('resolved')).toBe('change');
    expect(claimVerbActClass(undefined)).toBe('change');
  });
});

describe('f05b38c1 — the enforcement kill switch', () => {
  it('RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED=1 flips the switch (and back)', () => {
    expect(receiptTripleEnforceDisabled()).toBe(false);
    process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED = '1';
    expect(receiptTripleEnforceDisabled()).toBe(true);
    delete process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED;
    expect(receiptTripleEnforceDisabled()).toBe(false);
  });
});
