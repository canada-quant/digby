/**
 * Replay for ticket 68a1c868 — "Follow-through auto-filer files owner-inbox
 * cards on notes that say NOTHING is waiting on the owner (negation
 * false-positive)".
 *
 * THE INCIDENT (timestamps verbatim from the ticket): at 2026-10-24T07:57:23Z
 * the [FOLLOW-THROUGH] auto-filer filed owner question oq_2cc4131f against
 * the ctrl.example.com project supervisor (chat 99e63f86). The trigger was the
 * supervisor's own 06:16Z note — "Nothing in ctrl.example.com is waiting on the
 * owner." — a NEGATION, the desired steady state. The auto-filed notice (msg
 * 171f709f on that chat) even acknowledged no owner question was open, then
 * filed a card anyway. Dismissed by the Fleet Supervisor as noise.
 *
 * ROOT CAUSE: the sentence matched GATING_RE's "is waiting on (the owner)"
 * arm, but BOTH negation windows (NEGATED_FRAME_RE's {0,3} and
 * NOTHING_CLASS_FRAME_RE's {0,5}) use the dot-EXCLUDING gap-word class
 * `[^.;:,\n \t]+` — a dotted identifier ("ctrl.example.com") cannot be consumed
 * as a gap word, so the "Nothing" marker's scope died before reaching the
 * frame, and the negative status report read as an affirmative owner-wait
 * claim. (The ticket also quotes msg c808a47d "Nothing needs the owner."
 * — that sentence never matches GATING_RE at all; the firing sentence was
 * the dotted one.)
 *
 * THE FIX: the negation windows' gap-word class is now compositional —
 * a dot-free head plus any number of ".lower-or-digit" identifier tails
 * (NEG_GAP_WORD_RE_SOURCE) — so "Nothing in ctrl.example.com is waiting on the
 * owner." suppresses like its undotted sibling "Nothing in the project is
 * waiting on the owner.", while every sentence-terminator behavior is kept:
 * a dot followed by whitespace or a CAPITALIZED token still breaks the
 * window ("Nothing happened. The gate waits on the owner." keeps mining),
 * and dot-initial tails need a lowercase letter/digit so
 * "Nothing happened.The gate waits on the owner." also still mines.
 *
 * DETECTOR-RECALL REPLAY: these tests replay the detector's PRIOR true
 * positives (the affirmative claims the auto-filer exists for — canlegal-bench
 * owner-gated, the seat-swap blocked-on-owner, the comma-contrast and
 * semicolon shapes, the exception idioms 875216b0 pinned as tip/main
 * divergences) and assert they STILL mine, alongside the incident replays
 * asserting the negative status reports file nothing.
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { mineUnfiledDecisionClaims, sweepFollowThrough } from './follow-through.service';

const NOW = new Date('2026-10-24T08:30:00Z');
const SUP = '99e63f86-0000-4000-8000-000000000000'; // the ctrl.example.com project supervisor chat shape
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);

/** The exact sentence that auto-filed oq_2cc4131f (note at 2026-10-24T06:16Z). */
const INCIDENT = 'Nothing in ctrl.example.com is waiting on the owner.';
/** The other supervisor note the ticket quotes (never matches GATING_RE; pinned
 *  so a future widening of the frame cannot regress it). */
const SIBLING = 'Nothing needs the owner.';

const supRow = { id: SUP, userId: 'u1', title: 'ctrl.example.com Supervisor', projectId: 'p-ctrl', isSupervisor: false, isProjectSupervisor: true };
const note = (content: string, createdAt: Date, id = 'note-68a1c868') => ({
  id, content, createdAt, metadata: { origin: 'schedule' },
});
const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_68a1c868-0000-4000-8000-000000000000' } }));
const wake = jest.fn(async () => ({}));

describe('replay 68a1c868 — miner level', () => {
  it('the incident sentence (dotted identifier) mines NO claim anymore', () => {
    expect(mineUnfiledDecisionClaims(INCIDENT)).toEqual([]);
    expect(mineUnfiledDecisionClaims(SIBLING)).toEqual([]);
  });

  it('dotted-identifier negative reports across the guard window suppress (the 68a1c868 class)', () => {
    expect(mineUnfiledDecisionClaims('Nothing in i-020850b4.prod.aws is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing in project.paul-2.config.json waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing about digby.example.com v0.8.2 is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No lane in cluster.example.com is owner-gated.')).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY — the affirmative owner-wait claims the detector exists for STILL mine', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated on Gates 1–3.')).toEqual([
      'Publishing v0.8.2 is owner-gated on Gates 1–3.',
    ]);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('The deploy of digby.example.com waits on the owner.')).toEqual([
      'The deploy of digby.example.com waits on the owner.',
    ]);
  });

  it('DETECTOR-RECALL REPLAY — comma/semicolon/exception shapes keep their pinned behavior', () => {
    // comma contrast (bdd71948 B1): the live claim still mines
    expect(mineUnfiledDecisionClaims('Nothing is queued, but the publish gate waits on the owner.')).toEqual([
      'Nothing is queued, but the publish gate waits on the owner.',
    ]);
    // clause boundary (f7e9df4c): negation never reaches across
    expect(mineUnfiledDecisionClaims('No owner question is open; the publish call waits on Paul.')).toEqual([
      'No owner question is open; the publish call waits on Paul.',
    ]);
    // sentence boundary INSIDE the would-be window — a dot that ends a token
    // is a terminator, not an identifier dot (68a1c868 fix boundary). The
    // spaced form SPLITS into two sentences (SENTENCE_SPLIT_RE), so the live
    // claim is the second sentence; the unspaced form stays one sentence and
    // the window dies because an identifier tail must start .lower-or-digit.
    expect(mineUnfiledDecisionClaims('Nothing happened. The gate waits on the owner.')).toEqual([
      'The gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing happened.The gate waits on the owner.')).toEqual([
      'Nothing happened.The gate waits on the owner.',
    ]);
    // exception idiom (875216b0 F1): the named exception is the thing that DOES wait
    expect(mineUnfiledDecisionClaims('Nothing except the publish gate waits on the owner.')).toEqual([
      'Nothing except the publish gate waits on the owner.',
    ]);
  });

  it('main-parity negative reports keep suppressing (f7e9df4c / bdd71948 regression pins)', () => {
    expect(mineUnfiledDecisionClaims('Nothing is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing in this project waits on the owner right now.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Zero open owner questions; nothing waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).')).toEqual([]);
  });

  it('review pins (adversarial review of 573adc97c, findings F1/F2): connective-PREFIX words and capitalized connectives keep parent behavior', () => {
    // F1 — a gap word that merely STARTS with a connective prefix (shortlist / shortcut /
    // bartender / barometer) is not a connective: the NOTHING_CLASS lookahead needs its
    // word boundary back (dropping \b let the ticket's own FP class resurface through
    // the 4–5-gap band: parent [] / broken tip mined).
    expect(mineUnfiledDecisionClaims('Nothing on the current shortlist is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing on the current shortcut list is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing about the bartender-related gate is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing on the barometer reading is owner-gated.')).toEqual([]);
    // F2 — the exception-connective class must stay case-insensitive in the now
    // case-sensitive windows (ci()-folded): a capitalized connective in an exception
    // idiom keeps mining (parent behavior — a lowercase-only list suppressed it).
    expect(mineUnfiledDecisionClaims('Nothing BUT the publish gate waits on the owner.')).toEqual([
      'Nothing BUT the publish gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing But the publish gate waits on the owner.')).toEqual([
      'Nothing But the publish gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, Except the publish gate, waits on the owner.')).toEqual([
      'Nothing, Except the publish gate, waits on the owner.',
    ]);
  });

  it('mixed note: a dotted no-op status line next to an affirmative claim still auto-files only the claim', () => {
    const claims = mineUnfiledDecisionClaims(
      'Nothing in ctrl.example.com is waiting on the owner. Publishing v0.8.2 is owner-gated on Gates 1–3.',
    );
    expect(claims).toEqual(['Publishing v0.8.2 is owner-gated on Gates 1–3.']);
  });

  it('round-2 review pins (cross-family review of 4b655f10, findings D1/D2): dotted exception idioms MINE and dash-delimited affirmative clauses MINE', () => {
    // D1 — dot tolerance had made "connective + dotted identifier" consumable as two
    // plain gap words, so the affirmative exception idiom suppressed where parent mined:
    // the generic {0,3} window now guards a DOTTED word with a connective lookbehind
    // (the exception names the thing that DOES wait — "Nothing but deploy.example.com waits…"
    // = ONLY deploy.example.com waits, an affirmative owner-wait claim that must file).
    expect(mineUnfiledDecisionClaims('Nothing but deploy.example.com waits on the owner.')).toEqual([
      'Nothing but deploy.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing except digby.example.com waits on the owner.')).toEqual([
      'Nothing except digby.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing other than box.example.com waits on the owner.')).toEqual([
      'Nothing other than box.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('No gate but deploy.example.com waits on the owner.')).toEqual([
      'No gate but deploy.example.com waits on the owner.',
    ]);
    // D2 — a STANDALONE dash is a clause boundary, not a gap word: the negation must not
    // reach across it and wrongly suppress a genuinely affirmative post-dash claim
    // (parent had absorbed the dash as a gap word — its own FN hole of this exact class).
    expect(mineUnfiledDecisionClaims('Nothing in ctrl.example.com — the gate waits on the owner.')).toEqual([
      'Nothing in ctrl.example.com — the gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing in ctrl.example.com - the gate waits on the owner.')).toEqual([
      'Nothing in ctrl.example.com - the gate waits on the owner.',
    ]);
    // Emphatic appositive still negates (a trailing dash may END the window):
    expect(mineUnfiledDecisionClaims('Nothing — absolutely nothing — waits on the owner.')).toEqual([]);
    // Intra-token dash stays legal (one word): "Gates 1–3" does not break a negative report.
    expect(mineUnfiledDecisionClaims('Nothing on Gates 1–3 is waiting on the owner.')).toEqual([]);
    // The incident class is unchanged: a dotted negative status report still suppresses.
    expect(mineUnfiledDecisionClaims('Nothing in ctrl.example.com today is waiting on the owner.')).toEqual([]);
  });

  it('round-2 guard strength: the dotted-word guard must NOT re-suppress plain connective idioms or the ≤3-band pins', () => {
    // The undotted ≤3-band connective suppressions are pinned main-parity (875216b0):
    // "Nothing but the usual waits…" suppresses on both parent and tip.
    expect(mineUnfiledDecisionClaims('Nothing but the usual waits on the owner.')).toEqual([]);
    // The pre-verb exception idiom at 4–5 gap words keeps mining (pinned prior behavior).
    expect(mineUnfiledDecisionClaims('Nothing but the usual four gates wait on the owner.')).toEqual([
      'Nothing but the usual four gates wait on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing except the publish gate waits on the owner.')).toEqual([
      'Nothing except the publish gate waits on the owner.',
    ]);
    // Intensifier band stays suppressed (the swept non-exception connector inventory).
    expect(mineUnfiledDecisionClaims('Nothing without the publish gate waits on the owner.')).toEqual([]);
    // F4 correction (review of abb66db4, finding F4): "Nothing including digi.ai …" was
    // commented "Intensifier band stays suppressed" as if main-parity, but parent
    // 6defebc9a MINED it — the tip's suppression is the 68a1c868 fix working (a dotted
    // id after a non-exception connector is a negative report, not a claim), not
    // parity. Pinned suppression with the right justification; see F2's doctrine below
    // for the one family this class does NOT cover (glued dashes).
    expect(mineUnfiledDecisionClaims('Nothing including digi.ai waits on the owner.')).toEqual([]);
  });

  it('round-3 review pins (adversarial review of PR #1947 at abb66db4f, finding F1): punct-only gap tokens and dash ASIDES no longer auto-file phantom cards', () => {
    // F1 — round 2's alnum-requiring gap class made a punctuation-only token
    // (an ellipsis, a pair of dashes) unconsumable, so the "Nothing" scope died
    // before the frame and these NEGATIVE reports auto-filed phantom owner cards
    // (the ticket's own incident class, oq_2cc4131f). An ellipsis is a consumable
    // gap word again (NEG_GAP_PUNCT_RE_SOURCE); a BALANCED dash aside has its own
    // frame (DASH_PARENTHETICAL_FRAME_RE, the comma aside's sibling).
    // All em/en/hyphen/double/triple dashes, spaced or not — the reviewer's exact
    // seven shapes plus its corroborating shape:
    expect(mineUnfiledDecisionClaims('Nothing — at present — waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing – at present – waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing - at present - waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing -- at present -- waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing … waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No lane … is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nobody — at present — is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing — per the ledger — waits on the owner.')).toEqual([]);
    // An ellipsis after a generic marker with a real gap word — the eighth
    // F1-class shape (parent and round-1 suppressed; round-2 tip mined):
    expect(mineUnfiledDecisionClaims('Nothing more … waits on the owner.')).toEqual([]);
    // The aside body may carry its own trailing punctuation before the closer:
    expect(mineUnfiledDecisionClaims('Nothing — at present — waits on the owner…')).toEqual([]);
    // Guard strength: a contrastive or exception ASIDE still mines (comma-arm
    // parity — same connective lookahead, same pre-existing FP class).
    expect(mineUnfiledDecisionClaims('Nothing — however — waits on the owner.')).toEqual([
      'Nothing — however — waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing — apart from the usual gates — waits on the owner.')).toEqual([
      'Nothing — apart from the usual gates — waits on the owner.',
    ]);
    // The D2 family is INTACT: an UNPAIRED dash (no closing delimiter) is still a
    // clause boundary, so an affirmative post-dash clause still mines — including
    // after an aside-shaped prefix that never closes ("Nothing — at present — the
    // gate waits…" — the aside died, the post-dash subject+verb is a claim).
    expect(mineUnfiledDecisionClaims('Nothing — at present — the gate waits on the owner.')).toEqual([
      'Nothing — at present — the gate waits on the owner.',
    ]);
    // The exception idiom survives an ellipsis in the gap (the dotted branch's
    // lookbehind sees through one punct-only token):
    expect(mineUnfiledDecisionClaims('Nothing but … deploy.example.com waits on the owner.')).toEqual([
      'Nothing but … deploy.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing other than … box.example.com waits on the owner.')).toEqual([
      'Nothing other than … box.example.com waits on the owner.',
    ]);
    // A glued (unspaced) dash aside is NOT an aside in this class: no space follows
    // the marker, so the word arm consumes the tokens and the negative report
    // suppresses (F2's documented residual — the code comment records it).
    expect(mineUnfiledDecisionClaims('Nothing —at present— waits on the owner.')).toEqual([]);
    // Hyphen-asides with the emphatic appositive shape still suppress.
    expect(mineUnfiledDecisionClaims('Nothing - absolutely nothing - waits on the owner.')).toEqual([]);
  });

  it('round-3 sibling-merge pins (main b1b9c7625, ticket 11354cbe): the dash-aside body carries the comma arm\'s post-11354cbe semantics', () => {
    // The comma-aside fix on main made the aside body a run of compositional gap
    // words with a per-word exception guard. The dash aside mirrors it VERBATIM:
    // a DOTTED identifier inside a dash aside is consumable (the negative report
    // suppresses — without this the merge would have re-opened the 68a1c868 FP)…
    expect(mineUnfiledDecisionClaims('Nothing — per ctrl.example.com status — waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing — as of this sweep — waits on the owner.')).toEqual([]);
    // …while a MID-ASIDE exception preposition or contrastive connective MINES
    // (= ONLY the named thing waits — an affirmative claim; 11354cbe review F1).
    expect(mineUnfiledDecisionClaims('Nothing — per ctrl.example.com except the publish gate — waits on the owner.')).toEqual([
      'Nothing — per ctrl.example.com except the publish gate — waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing — per the ledger except the publish gate — waits on the owner.')).toEqual([
      'Nothing — per the ledger except the publish gate — waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing — per the ledger but the publish gate — waits on the owner.')).toEqual([
      'Nothing — per the ledger but the publish gate — waits on the owner.',
    ]);
    // ONE PAIR ONLY: a second dash mid-body has no closer adjacent to the frame,
    // so the aside never forms and the affirmative post-dash clause mines.
    expect(mineUnfiledDecisionClaims('Nothing — at — present — waits on the owner.')).toEqual([
      'Nothing — at — present — waits on the owner.',
    ]);
    // Intra-token hyphens inside the body are single words (the aside survives).
    expect(mineUnfiledDecisionClaims('Nothing — half-done work per the ledger — waits on the owner.')).toEqual([]);
    // A COMMA inside the aside body ends it (the gap-word class is comma-excluding,
    // comma-arm-identical): the closer is never reached, so the sentence MINES —
    // parent/main parity, a documented family residual (same as the comma aside's
    // semicolon body).
    expect(mineUnfiledDecisionClaims('Nothing — half-done work, per the ledger — waits on the owner.')).toEqual([
      'Nothing — half-done work, per the ledger — waits on the owner.',
    ]);
  });
});

describe('replay 68a1c868 — sweep level (no owner question is filed for the negative status report)', () => {
  const seedCursor = (msAgo: number, chatId = SUP) => store.set(`follow-through:cursor:${chatId}`, String(NOW.getTime() - msAgo));
  const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockPrisma.crossModelChat.findMany.mockImplementation(async () => [supRow]);
    mockPrisma.crossModelChat.findFirst.mockImplementation(async () => null);
    mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: 'p-ctrl', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockImplementation(async () => []);
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async () => null);
    mockPrisma.runToolReceipt.findMany.mockImplementation(async () => []);
    mockPrisma.projectTodo.findFirst.mockImplementation(async () => null);
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async () => null);
  });

  it('incident oq_2cc4131f: the negative status note files NOTHING and posts no notice', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(INCIDENT, minutesAgo(120))]);
    const out = await run();
    expect(out.autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('regression pin: an affirmative owner-gated claim in the same-shaped note STILL auto-files', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('Nothing in ctrl.example.com is waiting on the owner. Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Publishing v0.8.2 is owner-gated on Gates 1–3.'),
    }));
  });

  it('round-3 sweep pin (F1): the reviewer\'s end-to-end repro — a dash-aside or ellipsis negative report files NOTHING', async () => {
    // Reviewer msg 594160d1 proved these shapes auto-filed a phantom card at
    // abb66db4f (autofiled=1, flagOwnerQuestion invoked) while parent and
    // round-1 filed nothing. The sweep-level harness mirrors its method.
    const shapes = [
      'Nothing — at present — waits on the owner.',
      'Nothing … waits on the owner.',
      'Nothing -- at present -- waits on the owner.',
      'No lane … is owner-gated.',
      'Nothing — per the ledger — waits on the owner.',
      'Nobody — at present — is waiting on the owner.',
    ];
    for (const content of shapes) {
      jest.clearAllMocks();
      store.clear();
      seedCursor(6 * 3600_000);
      mockPrisma.crossModelChat.findMany.mockResolvedValue([supRow]);
      mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
      mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-ctrl', projectSupervisorEnabled: true, archivedAt: null }]);
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(content, minutesAgo(120))]);
      const out = await run();
      expect(out.autofiled).toBe(0);
      expect(flag).not.toHaveBeenCalled();
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    }
  });

  it('round-3 sweep pin (F1 guard): an affirmative claim in a dash-aside-shaped note STILL auto-files', async () => {
    // The aside frame must not swallow genuine claims: the D2 shape (unpaired
    // dash, new subject+verb after it) keeps filing through the whole sweep.
    jest.clearAllMocks();
    store.clear();
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([supRow]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-ctrl', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('Nothing — at present — the gate waits on the owner.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Nothing — at present — the gate waits on the owner.'),
    }));
  });

  it('efb63eb9 pins (round-3 review of PR #1947, finding F3): the dotted "otherwise than" intensifier idiom MINES', () => {
    // F3 — "otherwise" was in the single-word exception class and in the 4–5-band
    // per-slot guard, but NOT in the phrase arm's heads, so the DOTTED ≤3-band form
    // fell to the generic window's dotted-branch lookbehind, which saw only the TAIL
    // "than" (not a connective) and suppressed an affirmative owner-wait claim
    // ("Nothing otherwise than digi.ai waits" = ONLY digi.ai waits). Parent 6defebc9a
    // mined it; main 4b655f10 and the round-2/3 tip suppressed it (3-way differential
    // verified at ticket-file time and re-verified on this fix's branch).
    expect(mineUnfiledDecisionClaims('Nothing otherwise than digi.ai waits on the owner.')).toEqual([
      'Nothing otherwise than digi.ai waits on the owner.',
    ]);
    // The UNDOTTED 4–5-band sibling must KEEP mining (NOTHING_CLASS_FRAME_RE's
    // per-slot guard already covered it — this fix must not regress it).
    expect(mineUnfiledDecisionClaims('Nothing otherwise than the publish gate waits on the owner.')).toEqual([
      'Nothing otherwise than the publish gate waits on the owner.',
    ]);
    // Guard strength — the phrase-arm members that already worked must stay working:
    expect(mineUnfiledDecisionClaims('Nothing other than digi.ai waits on the owner.')).toEqual([
      'Nothing other than digi.ai waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing apart from ctrl.example.com waits on the owner.')).toEqual([
      'Nothing apart from ctrl.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing short of deploy.example.com waits on the owner.')).toEqual([
      'Nothing short of deploy.example.com waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing exclusive of box.example.com waits on the owner.')).toEqual([
      'Nothing exclusive of box.example.com waits on the owner.',
    ]);
    // Guard strength — the negative-report classes this family fixed stay suppressed:
    // a dotted id after NO exception phrase is a negative report, not a claim.
    expect(mineUnfiledDecisionClaims('Nothing re queue.example.com waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing faster than digi.ai waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing from cluster.example.com waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing including digi.ai waits on the owner.')).toEqual([]);
    // Guard strength — the POST-VERB suffix arm still EXCLUDES "otherwise" (adverbial
    // reading; []-parity with main, pinned in follow-through.service.test.ts): this fix
    // adds it as a phrase HEAD only, never as a suffix re-arm.
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner, otherwise than the publish gate.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner otherwise than digi.ai.')).toEqual([]);
    // Capitalized shape (ci() must fold it — the F2 class of 573adc97c):
    expect(mineUnfiledDecisionClaims('Nothing Otherwise Than digi.ai waits on the owner.')).toEqual([
      'Nothing Otherwise Than digi.ai waits on the owner.',
    ]);
    // F1 pins (adversarial review of THIS fix): "otherwise" pairs with "than" ONLY —
    // "otherwise from/of" is unidiomatic English, so sharing the general head|tail
    // cross-product mined a false positive in the 68a1c868 incident class. Pinned
    // suppressed (base parity): a negative status report through a non-idiomatic
    // preposition pair must never auto-file.
    expect(mineUnfiledDecisionClaims('Nothing otherwise from ctrl.example.com is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing otherwise of ctrl.example.com is waiting on the owner.')).toEqual([]);
    // Benefit shapes the reviewer confirmed beyond dotted hostnames: version ids and
    // AWS box ids ride the same arm.
    expect(mineUnfiledDecisionClaims('Nothing otherwise than v0.8.2 waits on the owner.')).toEqual([
      'Nothing otherwise than v0.8.2 waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing otherwise than i-020850b4.prod.aws waits on the owner.')).toEqual([
      'Nothing otherwise than i-020850b4.prod.aws waits on the owner.',
    ]);
  });
});
