/**
 * BOARD ASSERTION lane — ticket fd9f6fc8 (2026-10-22, av-mishap family):
 * the oq status-word window is now QUOTE-STRIPPED. The incident: a project
 * supervisor's honest wake note read
 *
 *   "Your answer to oq_c5756aaf — *"Saved — signed in as root on mbp-1,
 *   console left open (Digby drives from here)"* — is verified in the ledger
 *   as ANSWERED (answeredBy: owner)."
 *
 * — an AGREEING board read (the ledger says answered) that QUOTED the owner's
 * answer text. The word "open" inside that quotation ("console left open")
 * sat inside the id's ±OQ_STATUS_WINDOW slice while the note's own status
 * word (ANSWERED) sat outside it, so the oq lane mined asserted="open" vs
 * ledger "answered" and struck the truthful line as a contradicted board
 * assertion (mishap ticket filed against a faultless supervisor).
 *
 * Fix: the same "quoted spans are inert" convention the cue layers already
 * use (stripQuotedSpans — length-preserving) now strips the status-word
 * window before the open/done scans.
 *
 * Pins: the incident sentence mines NOTHING (the quoted "open" is inert and
 * the honest ANSWERED word still mines through the matcher's agreement
 * path), unpaired quotes keep the pre-fix behavior, and — DETECTOR-RECALL
 * REPLAY — every prior true positive of the oq board lane still fires: the
 * 2026-09-16 spark incident, f8fc93be's stale-probe incident, 1256aadd's
 * mirrored answered-direction conviction, and the a9846924 pre-run-answer
 * shape. A quoted status word that IS the note's own assertion (not quoted
 * source material) is NOT a shield — only spans inside PAIRED quote marks
 * are inert.
 *
 * Mock discipline mirrors action-verifier.board-assertions.2026-09-16.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { mineBoardAssertions, findPhantomBoardAssertions, isCitationClassClaim, BOARD_ASSERTION_TAG } from './action-verifier';

const CHAT = '99e63f86-0000-4000-8000-000000000000';

// The incident line, verbatim from the struck note (ticket fd9f6fc8's quoted
// claim). The oq id is real, the ledger row is ANSWERED, and the only "open"
// inside the window is the OWNER'S OWN ANSWER TEXT quoted by the note.
const INCIDENT_SENTENCE = 'Your answer to oq_c5756aaf — *"Saved — signed in as root on mbp-1, console left open (Digby drives from here)"* — is verified in the ledger as ANSWERED (answeredBy: owner).';

describe('fd9f6fc8 — quoted owner answer text is inert for the oq status-word window (replay)', () => {
  it('1. THE REPLAY (miner): the incident sentence mines NO oq assertion — the quoted "open" is not the note\'s claim, and ANSWERED sits outside the window', () => {
    expect(mineBoardAssertions(INCIDENT_SENTENCE).filter((a) => a.kind === 'oq')).toEqual([]);
  });

  it('2. THE REPLAY (matcher): the incident sentence against its real ledger (answered) strikes NOTHING — pre-fix this convicted citation-class and filed a mishap against an honest supervisor', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_SENTENCE, [], { chatId: CHAT, supervisorScope: 'project' }, async () => 'answered');
    expect(strikes).toEqual([]);
  });

  it('3. the same sentence with the ledger still OPEN also strikes nothing (no fabricated "answered" is mined either — the ANSWERED word is beyond the window, by design)', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_SENTENCE, [], { chatId: CHAT, supervisorScope: 'project' }, async () => 'open');
    expect(strikes).toEqual([]);
  });

  it('4. curly quotes and the em-dash twin: the same shape with “…” quotes is equally inert', () => {
    const curly = 'Your answer to oq_c5756aaf — *“Saved — signed in as root on mbp-1, console left open (Digby drives from here)”* — is verified in the ledger as ANSWERED.';
    expect(mineBoardAssertions(curly).filter((a) => a.kind === 'oq')).toEqual([]);
  });

  it('5. an UNPAIRED quote strips nothing — the pre-fix behavior survives for one-sided quote marks', () => {
    // No closing " anywhere: the span regex finds no PAIRED span around the
    // answer text, so the window keeps its characters and the sentence
    // behaves as before the fix (here: mined, because "open" is the only
    // status word in the window — the same miss-bias the lane always had).
    const unpaired = 'oq_c5756aaf — the board line reads "console left open pending your sign-in';
    expect(mineBoardAssertions(unpaired)).toEqual([expect.objectContaining({ kind: 'oq', id: 'c5756aaf', asserted: 'open' })]);
  });

  it('6. the honest sentence WITHOUT quotes is unchanged — ANSWERED in the window still mines "answered"', () => {
    const plain = 'oq_c5756aaf is ANSWERED by the owner, so the corridor lane proceeds.';
    expect(mineBoardAssertions(plain)).toEqual([expect.objectContaining({ kind: 'oq', id: 'c5756aaf', asserted: 'answered' })]);
  });
});

describe('fd9f6fc8 — DETECTOR-RECALL REPLAY (prior true positives still fire)', () => {
  it('DETECTOR-RECALL REPLAY — the 2026-09-16 spark incident still convicts: "still open" vs ledger answered', async () => {
    const out = await findPhantomBoardAssertions('Owner ruling oq_bd1130d5 is still open, so the dflash2E decision stays parked.', [], {}, async () => 'answered');
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'open', ledger: 'answered' })]);
    expect(out[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
    expect(isCitationClassClaim(out[0])).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY — f8fc93be stale-probe incident still convicts: OPEN per a fresh probe vs an answered ledger', async () => {
    const sentence = '20:57Z — Fresh probes this rewrite: oq_3458f265 (fleet-filed 20:07Z, Command A+ re-provision fork) is OPEN per this-wake list_owner_questions; the Option A lane (chat cba0dfe9) is RUNNING with generation complete at 1395/1395 rows, and both lanes are correctly gated on the owner while it stands open.';
    const out = await findPhantomBoardAssertions(sentence, [], {}, async () => 'answered');
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: '3458f265', asserted: 'open', ledger: 'answered' })]);
  });

  it('DETECTOR-RECALL REPLAY — 1256aadd mirrored direction still convicts: an "answered" assertion vs an open ledger', async () => {
    const out = await findPhantomBoardAssertions('The owner answered oq_bd1130d5: keep dflash2E.', [], {}, async () => 'open');
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'answered', ledger: 'open' })]);
  });

  it('DETECTOR-RECALL REPLAY — a TRUE open claim is not shielded by a quotation elsewhere in the sentence', async () => {
    // The note's OWN claim (is still open) is NOT inside quote marks; only
    // the owner's earlier words are. The strike must survive the fix.
    const sentence = 'oq_c5756aaf is still open — the answer "signed in as root" belongs to the other card, not this one.';
    const out = await findPhantomBoardAssertions(sentence, [], {}, async () => 'answered');
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: 'c5756aaf', asserted: 'open', ledger: 'answered' })]);
  });

  it('DETECTOR-RECALL REPLAY — a contradiction whose ONLY status word sits inside paired quotes still escapes (the deliberate, incident-shaped trade)', async () => {
    // Post-fix this shape cannot strike: the quoted span is inert and no
    // other status word reaches the window. Pinned as the KNOWN miss — the
    // miss-bias direction is the lane's standing contract (rejecting toward
    // MISS is the safe direction for an ENFORCED conviction lane; the false
    // positive class this fix kills filed mishaps against honest supervisors).
    const sentence = 'oq_c5756aaf — the board says "still open" tonight.';
    const out = await findPhantomBoardAssertions(sentence, [], {}, async () => 'answered');
    expect(out).toEqual([]);
  });

  it('review F1 — the strip may never RESOLVE a mixed window: a quoted status of row A never lends its word to row B (cross-row attribution guard)', async () => {
    // Pre-guard this struck oq_bd1130d5 as "answered" vs ledger open: A's raw
    // window holds open+done (ambiguous — skipped pre-fix), the strip removes
    // A's QUOTED "still open", and B's honest "answered" survives alone inside
    // A's ±70 window. The lane must skip BOTH rows here, exactly as pre-fix.
    const sentence = 'Unlike oq_bd1130d5 which is "still open", oq_c5756aaf is answered by the owner.';
    const statusLookup = async (_k: 'oq' | 'todo' | 'goal', id: string) => (id === 'bd1130d5' ? 'open' : 'answered');
    const out = await findPhantomBoardAssertions(sentence, [], {}, statusLookup);
    expect(out).toEqual([]);
    // And the miner alone agrees: nothing is mined for either row.
    expect(mineBoardAssertions(sentence).filter((a) => a.kind === 'oq')).toEqual([]);
  });

  it('review F2 — backtick and single-quote quotations of owner text are equally inert (the incident class, other glyphs)', () => {
    expect(mineBoardAssertions('Your answer to oq_c5756aaf — *`Saved — signed in as root on mbp-1, console left open (Digby drives from here)`* — is verified in the ledger as ANSWERED.').filter((a) => a.kind === 'oq')).toEqual([]);
    expect(mineBoardAssertions("Your answer to oq_c5756aaf — *'Saved — signed in as root on mbp-1, console left open (Digby drives from here)'* — is verified in the ledger as ANSWERED.").filter((a) => a.kind === 'oq')).toEqual([]);
    // the apostrophe NEVER opens a span: a possessive between the quoted
    // material and the id must not blank past it
    expect(mineBoardAssertions('oq_c5756aaf is the fleet\'s card and it is still open per the board.')).toEqual([expect.objectContaining({ kind: 'oq', id: 'c5756aaf', asserted: 'open' })]);
  });

  it('round-2 finding 1 — the single-quote strip may never CREATE a conviction: "awaiting the \'answered\' owner" stays the note\'s own answered claim, not a bridged open word', async () => {
    // Pre-fix (and against the both-marks-blanked variant round 2 proved)
    // this bridged into a live "awaiting the … owner" OPEN match and struck
    // an honest note citation-class against a CORRECT answered ledger. The
    // mark-preserving strip keeps the closing ' — whitespace cannot span it.
    const statusLookup = async (_k: 'oq' | 'todo' | 'goal', id: string) => (id === 'c5756aaf' ? 'answered' : null);
    const out = await findPhantomBoardAssertions('oq_c5756aaf is awaiting the \'answered\' owner confirm.', [], {}, statusLookup);
    expect(out).toEqual([]);
    // and the mirrored honest shape: the note's OWN "answered" word still mines
    expect(mineBoardAssertions('oq_c5756aaf is answered by the owner, not awaiting anything.')).toEqual([expect.objectContaining({ kind: 'oq', id: 'c5756aaf', asserted: 'answered' })]);
  });

  it('round-2 finding 2 — a quoted phrase after a status word never becomes a todo frame: "blocked \'pending owner sign-off\' todo X" mines nothing', () => {
    // The quoted material 'pending owner sign-off' is inert; the raw frame
    // read finds nothing ("blocked" sits before a quote, not before the noun),
    // and the agree-guard refuses any frame the blanking would create.
    expect(mineBoardAssertions('the lane is blocked \'pending owner sign-off\' todo 95f2fcf0 still sits.')).toEqual([]);
    // recall intact: the note's OWN before-noun frame still asserts
    expect(mineBoardAssertions('the blocked todo 95f2fcf0 still sits on the vendor firmware.')).toEqual([expect.objectContaining({ kind: 'todo', id: '95f2fcf0', asserted: 'blocked' })]);
  });

  it('review F3 — the todo/goal branch is quote-inert too: quoting the [BOARD] block verbatim never asserts its statuses', async () => {
    // Quoted board material carrying a framed todo status is not the note's claim.
    expect(mineBoardAssertions('I copied the block: "todo 95f2fcf0 [blocked] ship the lane" from the digest.')).toEqual([]);
    expect(mineBoardAssertions('The owner wrote "todo 95f2fcf0 (blocked)" in the thread.')).toEqual([]);
    // The note's OWN unquoted frame still asserts (recall intact).
    expect(mineBoardAssertions('todo 95f2fcf0 [blocked] "ship the lane" — unchanged since the digest.')).toEqual([expect.objectContaining({ kind: 'todo', id: '95f2fcf0', asserted: 'blocked' })]);
    // A quoted-title + own-frame hybrid: the title quotes inert, the frame is the note's.
    expect(mineBoardAssertions('todo 95f2fcf0 "S4.5 restamp" is blocked on QSA-R1.')).toEqual([expect.objectContaining({ kind: 'todo', id: '95f2fcf0', asserted: 'blocked' })]);
  });

  it('review F4 — an inch-mark pair blanking a live claim is the accepted miss direction (pinned, unchanged behavior class)', () => {
    // The two inch marks pair up and blank the span containing the honest
    // "still open" — a MISS, never a strike, per the lane's reject-toward-MISS
    // contract (same trade the cue layers' stripQuotedSpans already makes).
    expect(mineBoardAssertions('Padding is 6" for the top and oq_c5756aaf is still open per the 12" rule.').filter((a) => a.kind === 'oq')).toEqual([]);
  });
});

describe('fd9f6fc8 — sighting 2 (2026-10-22T21:11:03Z): bracket-scoped status-word ownership', () => {
  // Verbatim from the ticket's second Contradicted board assertion — the fleet
  // supervisor's 2:10 PM PDT sweep receipts line. "(open," belongs to
  // oq_015ffa54's OWN parenthetical; oq_71d6b7af is named only inside the
  // supersedes clause and never given a status of its own.
  const S2_LINE = 'Receipts: ticket 4424ebd6 (in_progress, P4) · sched 6204c2ef (active, next fire 11:06 AM PDT Oct 23) · oq oq_015ffa54 (open, supersedes oq_71d6b7af)';

  it('1. THE REPLAY (miner): the sighting-2 line mines ONLY oq_015ffa54 open — the word never attaches to the second id', () => {
    expect(mineBoardAssertions(S2_LINE).filter((a) => a.kind === 'oq')).toEqual([
      expect.objectContaining({ kind: 'oq', id: '015ffa54', asserted: 'open' }),
    ]);
  });

  it('2. THE REPLAY (matcher): against the real ledger (015ffa54 open, 71d6b7af answered) the line strikes NOTHING — pre-fix this filed a mishap against a faultless fleet supervisor', async () => {
    const statusLookup = async (_k: 'oq' | 'todo' | 'goal', id: string) => (id === '015ffa54' ? 'open' : 'answered');
    const strikes = await findPhantomBoardAssertions(S2_LINE, [], { chatId: CHAT, supervisorScope: 'project' }, statusLookup);
    expect(strikes).toEqual([]);
  });

  it('3. DETECTOR-RECALL REPLAY — the word\u2019s own row still asserts: the same line with 015ffa54 answered on the ledger still convicts 015ffa54', async () => {
    const statusLookup = async (_k: 'oq' | 'todo' | 'goal', id: string) => (id === '015ffa54' ? 'answered' : 'open');
    const strikes = await findPhantomBoardAssertions(S2_LINE, [], {}, statusLookup);
    expect(strikes).toEqual([expect.objectContaining({ kind: 'oq', id: '015ffa54', asserted: 'open', ledger: 'answered' })]);
  });

  it('4. compact two-row line: both raw windows are MIXED → the ambiguity gate skips both rows (the mask never resolves a mixed window — F1 contract)', () => {
    // ~80-char sentence: each id's ±70 window swallows BOTH parentheticals,
    // so raw open===done for every row → skipped, exactly as pre-fix. The
    // ownership mask would happily blank the far word, but letting a strip
    // RESOLVE a raw-mixed window is the forbidden direction (review F1):
    // rejection toward MISS stays the lane's contract for ambiguous shapes.
    const compact = 'Board: oq_015ffa54 (open, the gate) and oq_71d6b7af (answered, superseded receipt).';
    expect(mineBoardAssertions(compact).filter((a) => a.kind === 'oq')).toEqual([]);
  });

  it('4b. spaced two-row line: each status is window-local to its own row → BOTH rows mine (multi-id recall)', () => {
    // >70 chars of prose between the rows: no window reaches the other row's
    // status word, so each row's raw window is single-polarity and both
    // honest claims assert.
    const spaced = 'Board reads oq_015ffa54 (open, the gate) with a long stretch of neutral prose kept between the two rows, and further down oq_71d6b7af (answered, superseded receipt).';
    const mined = mineBoardAssertions(spaced).filter((a) => a.kind === 'oq');
    expect(mined).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '015ffa54', asserted: 'open' }),
      expect.objectContaining({ id: '71d6b7af', asserted: 'answered' }),
    ]));
    expect(mined).toHaveLength(2);
  });

  it('5. SCOPE BOUNDARY: an UNBRACKETED status word keeps pre-fix window semantics — it reaches every row in range (the collective-read reach, see case 8)', () => {
    // "answered" sits in no parenthetical, so ownership never applies: both
    // windows see it and both rows assert it, exactly as before this fix.
    // That reach is deliberate — killing it broke the committed 2c203dac
    // collective pin in review round 1 (nearest-id-anywhere variant).
    const line = 'oq_015ffa54 supersedes oq_71d6b7af which is answered by the owner.';
    const mined = mineBoardAssertions(line).filter((a) => a.kind === 'oq');
    expect(mined).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '015ffa54', asserted: 'answered' }),
      expect.objectContaining({ id: '71d6b7af', asserted: 'answered' }),
    ]));
    expect(mined).toHaveLength(2);
  });

  it('6. single-id sentences keep the window as sole governor — the ownership mask never touches them', () => {
    const line = 'oq oq_015ffa54 (open, next fire 11:06 AM PDT Oct 23) on the board.';
    expect(mineBoardAssertions(line)).toEqual([expect.objectContaining({ kind: 'oq', id: '015ffa54', asserted: 'open' })]);
  });

  it('7. REMOVAL-ONLY composition (F1 contract): a multi-id window that is raw-mixed stays skipped — the mask never resolves an ambiguous window into a conviction', () => {
    // Compact line: oq_71d6b7af's raw window holds BOTH words (015ffa54's
    // "open" ~4 chars before its own "answered") → raw open===done → skipped
    // pre-fix; the ownership mask would blank the far "open" and leave a lone
    // "answered", but the raw-vs-stripped agreement gate refuses to let a
    // strip RESOLVE a mixed window. BOTH rows mine nothing — rejection toward
    // MISS is the lane's standing contract for ambiguous shapes.
    const line = 'oq_015ffa54 (open) sits beside oq_71d6b7af answered tonight.';
    expect(mineBoardAssertions(line).filter((a) => a.kind === 'oq')).toEqual([]);
    // Spaced control (the incident's own geometry): the far row's slot word is
    // still inside the near id's window, but the raw window is
    // single-polarity — there the ownership mask DOES apply, and only the
    // slot's owning row keeps the claim (pinned above as case 1).
  });

  it('8. DETECTOR-RECALL REPLAY — collective list (2c203dac, review round 1): an unbracketed shared status still reaches EVERY id in range — the committed collective-list conviction keeps convicting', async () => {
    // Verbatim SPECIMEN_NOTE from board-digest.lane-board.2c203dac.test.ts —
    // the nearest-id-anywhere variant of this fix silently dropped two of
    // the three convictions (the shared unbracketed "open" became one row's
    // property). The bracket scope exists to keep this line intact.
    const sentence = '[board assertion] Three owner questions also sit open in the ledger (oq_3dab2289, oq_c620c908, oq_dcc88817) — content not read this run.';
    const mined = mineBoardAssertions(sentence).filter((a) => a.kind === 'oq');
    expect(mined.map((a) => a.id).sort()).toEqual(['3dab2289', 'c620c908', 'dcc88817'].sort());
    expect(mined.every((a) => a.asserted === 'open')).toBe(true);
    const out = await findPhantomBoardAssertions(sentence, [], {}, async () => 'answered');
    expect(out).toHaveLength(3);
  });

  it('9. NO FABRICATION (review F2 / round-2 B1): the mark-preserving blank can never bridge a multi-word alternation — this fixture FAILS under a space-blank mutant', async () => {
    // Discriminating shape (round-2 review): the receipts slot holds "pending
    // a closed answer" — blanking the DONE word "closed" must not let \s+
    // span the hole and fabricate "pending a … answer" → OPEN. Under the
    // space mutant this line strikes 71d6b7af:open (one of 60 measured
    // fabrications); under '·' nothing forms.
    const line = 'oq_015ffa54 (pending a closed answer) while oq_71d6b7af is done.';
    const mined = mineBoardAssertions(line).filter((a) => a.kind === 'oq');
    expect(mined.find((a) => a.id === '71d6b7af' && a.asserted === 'open')).toBeUndefined();
    // and the matcher against a both-answered ledger never strikes 71d6b7af open
    const statusLookup = async () => 'answered' as const;
    const out = await findPhantomBoardAssertions(line, [], {}, statusLookup);
    expect(out.find((s) => s.kind === 'oq' && s.id === '71d6b7af' && s.asserted === 'open')).toBeUndefined();
  });

  it('10. INTERIOR LIST (round-2 B2/C8): ids NAMED inside the slot share its status — an outside bystander never inherits it', () => {
    // Round-2 regression: v2 detached both interior rows and let the
    // bystander keep the word. v3: the slot names its rows → they SHARE the
    // word; the bystander beside the sentence gets nothing.
    const line = 'The questions (oq_aaaaaaaa, oq_bbbbbbbb still open) sit beside oq_cccccccc.';
    const mined = mineBoardAssertions(line).filter((a) => a.kind === 'oq');
    expect(mined).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'aaaaaaaa', asserted: 'open' }),
      expect.objectContaining({ id: 'bbbbbbbb', asserted: 'open' }),
    ]));
    expect(mined.find((a) => a.id === 'cccccccc')).toBeUndefined();
  });

  it('11. STATUS-ONLY SLOT (round-2 B2/C1-C2-C9): a slot naming NO id blanks nothing — the window alone decides (collective reach preserved)', () => {
    expect(mineBoardAssertions('The board is (three still open): oq_aaaaaaaa, oq_bbbbbbbb').filter((a) => a.kind === 'oq'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'aaaaaaaa', asserted: 'open' }),
        expect.objectContaining({ id: 'bbbbbbbb', asserted: 'open' }),
      ]));
    expect(mineBoardAssertions('Board (still open) records oq_aaaaaaaa and oq_bbbbbbbb').filter((a) => a.kind === 'oq'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'aaaaaaaa', asserted: 'open' }),
        expect.objectContaining({ id: 'bbbbbbbb', asserted: 'open' }),
      ]));
    expect(mineBoardAssertions('Board sweep (open) — oq_aaaaaaaa, oq_bbbbbbbb').filter((a) => a.kind === 'oq'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'aaaaaaaa', asserted: 'open' }),
        expect.objectContaining({ id: 'bbbbbbbb', asserted: 'open' }),
      ]));
  });

  it('12. NAMED-ROW SLOT (round-2 D8): "(oq_a open)" gives the word to the row the slot NAMES, not to a trailing bystander', () => {
    const line = 'the sweep (oq_aaaaaaaa open) also names oq_bbbbbbbb';
    const mined = mineBoardAssertions(line).filter((a) => a.kind === 'oq');
    expect(mined).toEqual([expect.objectContaining({ kind: 'oq', id: 'aaaaaaaa', asserted: 'open' })]);
  });
});
