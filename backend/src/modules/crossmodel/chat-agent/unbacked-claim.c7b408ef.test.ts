/**
 * Ticket c7b408ef — the BORROWED-citation SIBLING-ACT false strike (residual
 * of f05b38c1, found by the post-merge cross-family review).
 *
 * The defect: governCandidate's backward BORROW takes the nearest preceding
 * own-act ACTIVE verb, but a verb behind a COORDINATION ("… and sent the
 * owner the summary") is never an own-act clause head (the 5ad80b27 mercy),
 * so a cited receipt bound by borrow gets the SIBLING clause's verb — an
 * honest send receipt graded against `closed`/`armed` → ACT-grade mismatch →
 * the enforcement lane rewrites the WHOLE sentence, deleting the truthful
 * send. The live repros (both reproduced against the deployed module by the
 * filing reviewer):
 *   "Closed the stale schedule and sent the owner the summary — receipt 250ec3f7."
 *   "Re-armed the read-back as sched 0059e4e4 and sent the report — receipt 250ec3f7."
 * each with a send_chat_message receipt for 250ec3f7.
 *
 * The fix (receiptToolMismatches): after an act-grade mismatch is computed,
 * if ANY mapped verb token of the CITING SENTENCE maps to a class containing
 * the resolved receipt's tool, the citation is honestly attributed to that
 * sibling act — skip the mismatch, fail toward miss (587e9d64). The scan is
 * a RAW token scan (the own-act grammar is exactly what cannot see a
 * coordination sibling) with only the participle guard ("the sent summary" is
 * a noun phrase), and it is SENTENCE-scoped (an act token in a DIFFERENT
 * line must never acquit this sentence's claim).
 *
 * DETECTOR-RECALL REPLAY: the two f05b38c1 true-positive specimens (ad60c49d
 * / 05126597) MUST STILL CONVICT — their citing sentences carry no token
 * whose class contains file_feedback (only `closed` maps there), so the skip
 * never fires for them.
 */
const mockPrisma: any = {
  runToolReceipt: {
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => receiptRows.slice()),
  },
  crossModelChat: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { receiptTripleCandidates, receiptToolMismatches } from './unbacked-claim';
import { expectedToolsForCitation } from '../platform/claim-verb-classes';

/** The chat's receipt rows (the specimens' real shape). */
const receiptRows: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  receiptRows.length = 0;
  delete process.env.RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED;
  delete process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED;
  mockPrisma.runToolReceipt.findMany.mockImplementation(async () => receiptRows.slice());
});

describe('c7b408ef — the borrowed-citation sibling-act false strike (the two live repros)', () => {
  it('REPRO 1: "Closed the stale schedule and sent the owner the summary — receipt 250ec3f7" + its send receipt → NO mismatch (the citation is the sibling send act\'s)', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    const text = 'Closed the stale schedule and sent the owner the summary — receipt 250ec3f7.';
    // The defect shape itself: the borrow binds the send receipt to the
    // sibling clause's `closed` (a coordination verb is never a clause head),
    // act-grade — which pre-fix struck and rewrote the whole sentence.
    const cand = receiptTripleCandidates(text)?.find((c) => c.id === '250ec3f7');
    expect(cand).toBeDefined();
    expect(cand!.grade).toBe('act');
    expect(cand!.verb?.toLowerCase()).toBe('closed');
    expect(expectedToolsForCitation(cand!.verb)).not.toContain('send_chat_message');
    // Post-fix: the sibling `sent` names the act the receipt backs — no
    // mismatch, no metric row, no rewrite (the truthful send survives).
    const out = await receiptToolMismatches('chat-1', text);
    expect(out).toEqual([]);
  });

  it('REPRO 2: "Re-armed the read-back as sched 0059e4e4 and sent the report — receipt 250ec3f7" + its send receipt → NO mismatch', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    const text = 'Re-armed the read-back as sched 0059e4e4 and sent the report — receipt 250ec3f7.';
    // Same defect shape: the send receipt borrows the `armed` of the FIRST clause.
    const cand = receiptTripleCandidates(text)?.find((c) => c.id === '250ec3f7');
    expect(cand).toBeDefined();
    expect(cand!.grade).toBe('act');
    expect(cand!.verb?.toLowerCase()).toBe('armed');
    const out = await receiptToolMismatches('chat-1', text);
    expect(out).toEqual([]);
  });

  it('the same-clause binding is UNCHANGED — "re-armed … as sched 0059e4e4" still grades by its own clause verb (f05b38c1 pin)', () => {
    const out = receiptTripleCandidates(
      'Closed it this wake: re-armed the read-back verbatim on this supervisor chat as sched 0059e4e4 (once, 30-min) — receipt fea78360.',
    );
    const c = out?.find((x) => x.id === '0059e4e4');
    expect(c).toBeDefined();
    expect(c!.grade).toBe('act');
    expect(c!.verb?.toLowerCase()).toBe('armed');
  });
});

describe('c7b408ef — DETECTOR-RECALL REPLAY: the f05b38c1 true positives still convict', () => {
  it('SPECIMEN ad60c49d: the close-verb bullets still mismatch against the file_feedback envelopes', async () => {
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
      { id: '0bb1f832-2222', tool: 'file_feedback', ok: true, ids: { ticketId: '93292353-1953-4e2f-b3e1-d5d49bf10074' } },
    );
    const text = [
      'What I did',
      '',
      '- Retired both duplicate tickets — 9c307167 and 93292353 are now resolved.',
      '',
      'ACTIONS TAKEN',
      '',
      '- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
      '- Resolved duplicate ticket 93292353 via filer self-close — receipt ticket 93292353',
    ].join('\n');
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.map((m) => m.receiptId).sort()).toEqual(['93292353', '9c307167']);
    for (const m of out) {
      expect(m.grade).toBe('act');
      expect(m.actualTool).toBe('file_feedback');
      expect(m.expectedTools).not.toContain('file_feedback');
    }
  });

  it('SPECIMEN 05126597: the passive "are pinned" payload still mismatches against the file_feedback envelopes', async () => {
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
      { id: '0bb1f832-2222', tool: 'file_feedback', ok: true, ids: { ticketId: '93292353-1953-4e2f-b3e1-d5d49bf10074' } },
    );
    const text = "Ticket dedupe: canonical = 1b1c41bc. The fleet's two duplicates (93292353, 9c307167) are pinned at priority 0 with adminNotes pointing at the canonical.";
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) expect(m.actualTool).toBe('file_feedback');
  });
});

describe('c7b408ef — the skip\'s guards (sentence scope, participle, class match)', () => {
  it('SENTENCE-SCOPED: a send act in a DIFFERENT sentence does not acquit a close-verb claim', async () => {
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
      { id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } },
    );
    // The close claim cites the ticket id (resolves via the file_feedback
    // envelope); the sibling SENT act lives in another bullet entirely.
    const text = [
      'ACTIONS TAKEN',
      '',
      '- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
      '- Sent the fleet report-up to the supervisor — receipt 250ec3f7',
    ].join('\n');
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.map((m) => m.receiptId)).toEqual(['9c307167']);
    expect(out[0].actualTool).toBe('file_feedback');
  });

  it('PARTICIPLE GUARD: "the sent summary" (a noun phrase) does not acquit a close-verb claim backed by a send receipt', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // "archived the sent summary" — `sent` is a participle inside a noun
    // phrase, not an act: the citation borrows `Closed` and the mismatch FIRES.
    const out = await receiptToolMismatches('chat-1', 'Closed the ticket and archived the sent summary — receipt 250ec3f7.');
    expect(out.length).toBe(1);
    expect(out[0].receiptId).toBe('250ec3f7');
    expect(out[0].verb?.toLowerCase()).toBe('closed');
    expect(out[0].actualTool).toBe('send_chat_message');
  });

  it('CLASS MATCH REQUIRED: a sibling verb whose class does NOT contain the resolved receipt\'s tool does not acquit', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // `pushed` maps to git_push only — the send receipt backs neither act.
    const out = await receiptToolMismatches('chat-1', 'Closed the ticket and pushed the branch — receipt 250ec3f7.');
    expect(out.length).toBe(1);
    expect(out[0].receiptId).toBe('250ec3f7');
    expect(out[0].actualTool).toBe('send_chat_message');
  });

  it('RESIDUAL (accepted, fail toward miss — 587e9d64): a fabricated close riding an honest same-sentence send citation is a MISS, never a rewrite', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // No close-class receipt exists — the `Closed` claim is unbacked — but the
    // sentence's honest send citation must survive the rewrite: the skip fires
    // and the fabricated close escapes THIS lane (the invented-id lane and the
    // verifier's tiers still stand behind it). Pinned so a future tightening
    // knows this is the deliberate trade, not an oversight.
    const out = await receiptToolMismatches('chat-1', 'Closed the ticket and sent the owner the summary — receipt 250ec3f7.');
    expect(out).toEqual([]);
  });

  it('COMMA-SERIES shape: "Closed the schedule, sent the owner the summary, receipt X" — commas are not clause separators, so the sibling rescues the same way', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // The citation binds via the CLAUSE path here (a comma is no separator):
    // the raw sibling `sent` in coordination position still rescues it.
    const out = await receiptToolMismatches('chat-1', 'Closed the schedule, sent the owner the summary, receipt 250ec3f7.');
    expect(out).toEqual([]);
  });

  // ── adversarial-review hardening (F1/F2/F3/F5, reviewer run 2026-10-17) ──

  it('F1: a receipt annotated with its own TOOL NOUN never self-acquits — "Closed the stale schedule — receipt X (send_chat_message)" still strikes', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // The sentence TELLS us the receipt is a send while the verb claims a
    // close — the strongest wrong-tool shape. The tool-noun token is
    // annotation vocabulary, never an act: the mismatch must fire.
    const out = await receiptToolMismatches('chat-1', 'Closed the stale schedule — receipt 250ec3f7 (send_chat_message).');
    expect(out.length).toBe(1);
    expect(out[0].receiptId).toBe('250ec3f7');
    expect(out[0].actualTool).toBe('send_chat_message');
  });

  it('F2: a THIRD-PARTY agentive token ("closed by lane cb941a0a") does not acquit a close-verb fabrication', async () => {
    receiptRows.push(
      { id: '2a6a748f-1111', tool: 'file_feedback', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } },
    );
    const out = await receiptToolMismatches('chat-1', 'Resolved duplicate ticket 9c307167 — closed by lane cb941a0a — receipt ticket 9c307167');
    expect(out.length).toBe(1);
    expect(out[0].receiptId).toBe('9c307167');
    expect(out[0].actualTool).toBe('file_feedback');
  });

  it('F2b (review finding A, probed on the real module): the RELAY phrasing "and the lane said \\"sent…\\"" stops COLLECTION of the citation entirely, while a QUOTED sibling in coordination position backed by a REAL ok receipt still rescues — fail toward miss', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // (1) The relay shape, verbatim from the probe: the third-party subject
    // ("the lane said …") between the own-act clause and the citation kills
    // the borrow — the id is never collected as an act-grade candidate (the
    // shared citation guards' third-party-relay class), so there is nothing
    // for the sibling scan to rescue or strike. The quoted-token question is
    // answered at the RIGHT layer: collection, not the sibling scan.
    const relay = 'Closed the ticket and the lane said "sent the report" — receipt 250ec3f7.';
    const relayCands = receiptTripleCandidates(relay) ?? [];
    expect(relayCands.find((c) => c.id === '250ec3f7' && c.grade === 'act')).toBeUndefined();
    expect(await receiptToolMismatches('chat-1', relay)).toEqual([]);
    // (2) The quoted-sibling shape, verbatim from the probe: the quote marks
    // do NOT block admission — the token sits in coordination position and
    // the chat's REAL ok send receipt backs the citation, so the skip FIRES
    // on purpose (striking it would delete a truthful send — the exact
    // data-loss defect c7b408ef fixes). The no-quotes control agrees.
    const quoted = 'Closed the ticket and "sent the report" per the lane — receipt 250ec3f7.';
    const control = 'Closed the ticket and sent the report — receipt 250ec3f7.';
    expect(await receiptToolMismatches('chat-1', quoted)).toEqual([]);
    expect(await receiptToolMismatches('chat-1', control)).toEqual([]);
  });

  it('F3: REPORT-grade rows are NEVER rescued — the observe-only metric keeps its baseline series', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141', chatId: 'c0e22e36-1111-2222-3333-444444444444' } });
    // "The lane resolved … and sent the owner a summary" — the resolution
    // clause is a THIRD-PARTY report (no own-act verb governs the id), so the
    // candidate grades REPORT: the skip must not touch it and the mismatch
    // row must survive for the observe-only metric.
    const text = 'The lane resolved ticket 9c307167 and sent the owner a summary — receipt ticket 9c307167';
    const cand = receiptTripleCandidates(text)?.find((c) => c.id === '9c307167');
    expect(cand).toBeDefined();
    expect(cand!.grade).toBe('report');
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.length).toBe(1);
    expect(out[0].grade).toBe('report');
    expect(out[0].span).toBeUndefined();
  });

  it('F5: a NOUN-bound citation is precise and is never rescued by a sibling verb', async () => {
    receiptRows.push({ id: '250ec3f7-aaaa', tool: 'send_chat_message', ok: true, ids: { ticketId: '9c307167-e7b3-401e-9380-b434fe13b141' } });
    // "Sent the report and updated file_feedback → 9c307167": the citation is
    // TOOL-NOUN shaped (file_feedback names the act) — a precise binding, so
    // the sibling `sent` must NOT rescue the noun's mismatch.
    const text = 'Sent the report and updated file_feedback → 9c307167';
    const cand = receiptTripleCandidates(text)?.find((c) => c.id === '9c307167');
    expect(cand).toBeDefined();
    expect(cand!.noun).toBe('file_feedback');
    expect(cand!.via).toBe('noun');
    const out = await receiptToolMismatches('chat-1', text);
    expect(out.length).toBe(1);
    expect(out[0].receiptId).toBe('9c307167');
    expect(out[0].actualTool).toBe('send_chat_message');
  });
});
