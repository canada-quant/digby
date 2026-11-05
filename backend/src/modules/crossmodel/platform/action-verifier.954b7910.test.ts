/**
 * REPLAY PIN — mishap ticket 954b7910 (2026-10-08T03:14:29Z, verifier:
 * action-verifier): "Supervisor fabricated evidence citation: cited id(s) do
 * not exist (chat 41bd202a)" — Schooltime PROJECT supervisor, wake
 * 2026-10-08T03:15Z (hook on Drive lane 1c2b28d6 run_completed).
 *
 * THE INCIDENT: the wake digest quoted the Drive lane's final answer VERBATIM
 * ("Final answer: No audio yet, 8:13 PM PDT (03:13Z) — drive_search … →
 * 'No files found matching' …; successor firing 47 of 500") and named the
 * source CHAT id (the 2026-09-14 hardening) — but carried NO message id for
 * the answer it quoted. The supervisor's lane-digest idiom ends "(msg …)" —
 * with the text but no lawful id to copy, it invented `msg 40c5cfc2`
 * (existence-checked nowhere: no crossModelMessage/chat/schedule row). The
 * deterministic msg-citation lane convicted it PRE-DELIVERY: the note was
 * WITHHELD (assistant row replaced by the withheld-marker system note,
 * ba391242) and the in-channel correction landed (c461bc78) — the ticket's
 * deliveredRedacted:true / containedPreDelivery:true. First offense for the
 * chat (occurrences 1); the class is the long-known ba65163d family.
 *
 * THE FIX this file pins ALONGSIDE the containment: a digest that QUOTES an
 * answer now also carries the answer's persisted message id
 * (run-outcome-line.ts buildAnswerMsgIdLine — ANSWER_MSG_ID rides directly
 * under RUN_OUTCOME, front-loaded for truncation immunity) at BOTH producer
 * seams (run-executor.ts coding finals, chat-agent.service.ts plain-chat
 * finals). The id is the dual-written crossModelMessage row id — the exact
 * table citedMessageRowExists probes — so the id a supervisor copies from the
 * digest EXONERATES instead of convicting. Same remedy as the 2026-09-14
 * title→id hardening: when the harness hands the model text, it must hand the
 * citable id for that text too.
 *
 * These tests pin, against the REAL guard (boundary-mocked like the sibling
 * pins action-verifier.6fac1460.test.ts / action-verifier.080365bf.test.ts):
 *   1. INCIDENT REPLAY: the reconstructed note is struck with exactly msg
 *      40c5cfc2 (citation-class), strip+mark elides its line 1:1 (survivors
 *      delivered unmodified), and the mishap filing carries the incident's
 *      exact attribution + flags (title chat 41bd202a, area
 *      project-supervisor, supervisorScope 'project', deliveredRedacted,
 *      containedPreDelivery);
 *   2. CLOSURE PIN (the fix's payoff): the SAME note shape citing the id the
 *      digest now carries — `msg <REAL>` where REAL is a persisted row —
 *      stays CLEAN (no strike, no filing): the corrected behavior needs no
 *      fabrication to satisfy the idiom;
 *   3. the sanctioned escape: "(id not captured)" stays clean;
 *   4. DIGEST UNIT: buildAnswerMsgIdLine / frontLoadRunOutcome embed the id
 *      as line 2, stay idempotent, omit it when absent (guard-replaced /
 *      failed / cancelled runs quote no answer), and survive the 2000-char
 *      truncateSummary cut that hooks.service applies.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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
  guardMachineWakeFinalAnswer, isCitationClassClaim, mineEvidenceCitations, REDACTED_CLAIM_LINE,
} from './action-verifier';
import { ANSWER_MSG_ID_PREFIX, buildAnswerMsgIdLine, frontLoadRunOutcome } from './run-outcome-line';

/** The incident chat (ticket context sessionId) — the Schooltime project supervisor seat. */
const SUP_PROJECT = '41bd202a-7152-437e-bf4b-a097981692b1';

/** The ticket's fabricated citation (exists NOWHERE — the ticket's existence-check answer). */
const PHANTOM_MSG = '40c5cfc2';

/**
 * The id the note MEANT and the digest now carries (954b7910 fix): the Drive
 * lane's real persisted final-answer row. A representative uuid-shaped id —
 * the incident's own row id is not in the ticket text; what matters to the
 * pin is that a REAL row exonerates (the exact id is arbitrary).
 */
const REAL_ANSWER_MSG = '5d4e3f2a-1111-4222-8333-444455556666';
const REAL_ANSWER_MSG_8 = '5d4e3f2a';

/** The Recorder lane's real last message (existed during the incident — exonerated live). */
const REAL_RECORDER_MSG = '5c3298de';

/** The incident's owner (ticket userId). */
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

/* ----- The incident note (project supervisor, wake 2026-10-08T03:15:10Z) ----- */

const HEAD = '**Schooltime wake — 8:15 PM PDT Oct 7 (03:15Z).** Drive-lane hourly firing quiet — nothing moved';
/** The CONVICTED line — verbatim from the ticket's fabricated-citation block. */
const PHANTOM_LINE = `- **Drive lane (1c2b28d6):** 03:13Z firing 47/500 — "No files found" (msg ${PHANTOM_MSG}) · next 04:13Z future`;
const RECORDER_LINE = `- **Recorder lane (0037460b, fresh list_chats):** idle since 01:57Z (last msg ${REAL_RECORDER_MSG}) · watch 50532ee7 next 05:55Z future`;
const BOARD_LINE = '- **Board (compose-time ledger):** todo a62eb6ce + bf3514e9 both blocked/external on the same school-hours window · **0 open owner questions** — nothing is waiting on you';
const NEXT_LINE = 'Next delta: school-hours firing 17:55Z Thu runs the fixed pipeline against an occupied classroom';
const SWEEP_LINE = 'Sweep 04:05Z future · no fleet report-up';
const CLOSER = 'WAKE: no-op — nothing moved in Schooltime since the previous wake';

/** The incident note: 9 non-empty lines, exactly 1 convicted → the >50%-gutted fail-closed guard does NOT trip (1×2 ≤ 9). */
const NOTE = [HEAD, '', PHANTOM_LINE, RECORDER_LINE, BOARD_LINE, NEXT_LINE, SWEEP_LINE, CLOSER].join('\n');

/** The incident's real clock (wake 03:15:10Z; ticket filed 03:14:29Z…) — every remaining clock token is past or future-labeled. */
const NOW = new Date('2026-10-08T03:15:10.000Z');

const INPUT = {
  chatId: SUP_PROJECT,
  userId: OWNER,
  parts: [] as any[],
  receipts: [] as any[],
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'project' as const,
  runStartedAt: new Date('2026-10-08T03:13:48.000Z'),
  now: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  // The LLM action extractor found NO action claims (the ticket: "fabricated
  // EVIDENCE, not an action"; consequential actions NONE) — the conviction
  // arrived via the deterministic citation lane.
  mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
  // The msg-citation existence probe (citedMessageRowExists): ONLY the
  // phantom id exists NOWHERE; every other probed id exonerates on its row
  // (the incident's Recorder msg + the closure's digest-carried answer id).
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) =>
    JSON.stringify(args).includes(PHANTOM_MSG) ? null : { id: REAL_ANSWER_MSG });
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // no same-prefix near-miss hints
  // The lanes + board rows the note names are REAL — exonerated on existence
  // (the Drive/Recorder chats, their schedules, the two blocked todos).
  mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5' });
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.findFirst.mockResolvedValue({ id: '50532ee7-0000-4000-8000-000000000000' });
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.projectGoal.findFirst.mockResolvedValue(null);
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue({ id: 'a62eb6ce-0000-4000-8000-000000000000', status: 'blocked' });
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
});

describe('ticket 954b7910 replay — fabricated msg citation in a lane-digest line (Schooltime supervisor 41bd202a)', () => {
  it('INCIDENT REPLAY: struck with exactly msg 40c5cfc2, strip+mark elides its line 1:1, filing carries deliveredRedacted + containedPreDelivery + project-seat attribution', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...INPUT, finalText: NOTE });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(true);

    // Exactly the ticket's phantom — no more (the Recorder msg 5c3298de
    // EXISTED, the todo/chat/schedule ids exonerate), no less.
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM_MSG]);
    expect(res.phantoms[0].kind).toBe('message');
    expect(isCitationClassClaim(res.phantoms[0])).toBe(true); // the [evidence citation] class

    // Strip+mark (the incident's delivery): the one convicted line elided,
    // the survivors delivered UNMODIFIED — not a wholesale replacement.
    expect(res.finalText.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(1);
    expect(res.finalText).toContain(HEAD);
    expect(res.finalText).toContain(RECORDER_LINE);
    expect(res.finalText).toContain(BOARD_LINE);
    expect(res.finalText).toContain(CLOSER);
    expect(res.finalText).not.toContain(`\n${PHANTOM_LINE}`);
    expect(res.finalText).not.toContain('BEGIN STRUCK NOTE'); // redaction lane, not full replacement

    // The citation-only strike names the true failure class (fabricated
    // EVIDENCE ids, not unexecuted actions).
    expect(res.notice).toContain('cited evidence id(s) that DO NOT EXIST');
    expect(res.notice).toContain('REMOVED before delivery');

    // The mishap filing carries the incident ticket's exact attribution +
    // context flags (its title IS the live ticket's title).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filing = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filing.type).toBe('mishap');
    expect(filing.title).toBe('Supervisor fabricated evidence citation: cited id(s) do not exist (chat 41bd202a)');
    expect(filing.area).toBe('project-supervisor');
    expect(filing.context).toMatchObject({
      sessionId: SUP_PROJECT,
      verifier: 'action-verifier',
      supervisorScope: 'project',
      deliveredRedacted: true,
      containedPreDelivery: true,
    });
    expect(filing.description).toContain(PHANTOM_MSG);
    expect(filing.description).toContain('Executed consequential actions this run: NONE');

    // The durable state-doc refutation fires for the supervisor.
    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });

  it('MINER UNIT: mineEvidenceCitations lifts the msg-idiom ids — the todo ids ride their own lane, and the phantom is among them', () => {
    const mined = mineEvidenceCitations(NOTE);
    // Both `msg <id>` citations are mined (the Recorder's real one too — it
    // exonerates at the existence probe, not at the miner).
    expect(mined.map((m) => m.id)).toEqual(expect.arrayContaining([PHANTOM_MSG, REAL_RECORDER_MSG]));
    expect(mined.every((m) => m.kind === 'message')).toBe(true);
  });

  it('CLOSURE PIN (the 954b7910 fix payoff): the SAME note shape citing the id the digest now carries stays CLEAN — no strike, no filing', async () => {
    // Post-fix, the run_completed digest carries ANSWER_MSG_ID: <id> — the
    // supervisor copies its first 8 chars into the same "(msg …)" slot.
    const fixedNote = NOTE.replace(`(msg ${PHANTOM_MSG})`, `(msg ${REAL_ANSWER_MSG_8})`);

    const res = await guardMachineWakeFinalAnswer({ ...INPUT, finalText: fixedNote });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toHaveLength(0);
    expect(res.finalText).toBe(fixedNote); // delivered verbatim — nothing elided
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('CONTROL — the sanctioned escape: the same line with "(id not captured)" stays clean', async () => {
    const escaped = NOTE.replace(`(msg ${PHANTOM_MSG})`, '(id not captured)');
    const res = await guardMachineWakeFinalAnswer({ ...INPUT, finalText: escaped });

    expect(res.struck).toBe(false);
    expect(res.phantoms).toHaveLength(0);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('954b7910 digest seam — ANSWER_MSG_ID rides the run_completed summary (run-outcome-line.ts)', () => {
  it('buildAnswerMsgIdLine names the id, its 8-char citation idiom, and the never-invent rule', () => {
    const line = buildAnswerMsgIdLine(REAL_ANSWER_MSG);
    expect(line.startsWith(ANSWER_MSG_ID_PREFIX)).toBe(true);
    expect(line).toContain(REAL_ANSWER_MSG);
    expect(line).toContain("cite this id's first 8 chars as 'msg <8 chars>'");
    expect(line).toContain('never invent');
  });

  it('frontLoadRunOutcome puts ANSWER_MSG_ID directly under RUN_OUTCOME (both front-loaded, cut-immune) and stays idempotent', () => {
    const out = frontLoadRunOutcome('Coding run completed. Final answer: No audio yet', {
      outcome: 'completed', finalText: 'No audio yet', answerMessageId: REAL_ANSWER_MSG,
    });
    const lines = out.split('\n');
    expect(lines[0].startsWith('RUN_OUTCOME:')).toBe(true);
    expect(lines[1].startsWith(ANSWER_MSG_ID_PREFIX)).toBe(true);
    expect(lines[1]).toContain(REAL_ANSWER_MSG);
    expect(lines[2]).toBe('Coding run completed. Final answer: No audio yet');
    // Idempotence: a re-wrap of an already-prefixed summary never double-prefixes.
    expect(frontLoadRunOutcome(out, { outcome: 'completed', finalText: 'x', answerMessageId: REAL_ANSWER_MSG })).toBe(out);
  });

  it('TRUNCATION IMMUNITY: both front-loaded lines survive hooks.service SUMMARY_CAP (2000) applied to a long summary', () => {
    const long = `Coding run completed. Final answer: ${'quiet hour. '.repeat(400)}`;
    const out = frontLoadRunOutcome(long, { outcome: 'completed', finalText: 'x', answerMessageId: REAL_ANSWER_MSG });
    const capped = out.slice(0, 2000); // hooks.service truncateSummary's cut
    expect(capped.startsWith('RUN_OUTCOME:')).toBe(true);
    expect(capped).toContain(ANSWER_MSG_ID_PREFIX);
    expect(capped).toContain(REAL_ANSWER_MSG);
  });

  it('NO LINE WHEN NOTHING IS QUOTED: absent/null answerMessageId (guard-replaced, failed, cancelled runs) emits the legacy shape unchanged', () => {
    const legacy = frontLoadRunOutcome('Coding run completed, but the evidence guard REPLACED its final answer — treat claims as NOT DONE.', {
      outcome: 'completed', finalText: '', verdictOverride: 'GUARD-REPLACED',
    });
    expect(legacy).not.toContain(ANSWER_MSG_ID_PREFIX);
    expect(legacy.split('\n')[0].startsWith('RUN_OUTCOME:')).toBe(true);
    // Explicit null (persist failed) behaves the same as absent.
    const nullId = frontLoadRunOutcome('Coding run completed. Final answer: x', { outcome: 'completed', answerMessageId: null });
    expect(nullId).not.toContain(ANSWER_MSG_ID_PREFIX);
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });
