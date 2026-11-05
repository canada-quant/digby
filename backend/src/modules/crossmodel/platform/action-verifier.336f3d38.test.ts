/**
 * Ticket 336f3d38 — REPLAY: the ctrl.cql.ca project supervisor's 16:31:43Z machine-wake note
 * (chat 99e63f86, msg fdd722fc) cited THREE evidence ids that exist nowhere — dispatch
 * "d12f21f1", message "d031a112", schedule "2b3cf15b" — on a run whose receipt ledger is EMPTY
 * (zero rows 13:09:05Z → 16:38:20Z; the first attempt at 16:30:37Z was replaced pre-delivery and
 * the retry, delivered 16:31:43.972Z, shipped the same invented ids). Ground truth, pulled fresh
 * this lane: all three ids resolve in no store (resolve_id ×3 empty; the verifier's own
 * crossModelMessage / chatSchedule / crossModelChat probes found no row); the peer lane
 * 69fb25fc refuted the actions first-hand at 16:33:40Z (lane 24f1950e STILL archived, amd-1 key
 * STILL revoked — "Permission denied (publickey)"); the REAL actions ran seven minutes later
 * under entirely different ids (receipt ff30a27d archive 24f1950e, c2eca357 → schedule 24d810d9,
 * aa129c6a send 24f1950e, aa4375e3 steer 69fb25fc) and the supervisor's own correction (msg
 * 68e70836, 16:41Z) concedes the fabrication. NOT a miscopy (the run had no envelopes to
 * mis-transcribe) and NOT a verifier gap (every conviction was a true positive): true
 * fabrication on a zero-tool wake, caught by the citation lanes' existence checks.
 *
 * The DEFECT this ticket fixes is in the guard's own durable records, not its verdicts:
 * under the audit 2026-10-08 W1-4 default (owner-facing notes are never edited) the strike
 * delivered the note AS WRITTEN with a trailing observe-only annotation — the ticket's own
 * context carries deliveredAnnotated:true and the fabricated citations DID reach the peer —
 * yet (a) the PRE-DELIVERY warn (app_error_logs row 2896eeb7, 16:31:43.823Z) said "the final
 * note was replaced before delivery", and (b) the closed-ticket counter-bump prose asserted
 * "the struck content never reached the thread". An operator reading app_error_logs to answer
 * "did the struck content reach the fleet?" got the wrong answer, on the exact question that
 * matters for containment-vs-escape adjudication.
 *
 * Pins (fixed by this change):
 *  1. The PRE-DELIVERY warn states the ACTUAL delivery mode: "delivered as written with an
 *     observe-only annotation" under the W1-4 default, "stripped line(s)" under strip+mark,
 *     "replaced before delivery" only under OWNER_NOTE_NO_EDIT_DISABLED=1.
 *  2. The annotation/correction/ticket side is UNCHANGED (the observe-only delivery itself is
 *     W1-4 doctrine — pinned by action-verifier.owner-note-no-edit.test.ts; this suite pins
 *     only that the RECORDS tell the truth).
 *  3. The closed-ticket counter-bump trail names the annotated delivery for
 *     deliveredAnnotated sightings and never claims "never reached the thread" for them.
 *
 * DETECTOR-RECALL REPLAY: the sections marked DETECTOR-RECALL REPLAY below re-run the
 * detector's PRIOR true positives — the citation-lane convictions this incident class rests
 * on — and assert they STILL convict with isCitationClassClaim=true, so the logging/trail fix
 * cannot silently weaken detection.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async (..._a: any[]) => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import logger from '../../../utils/logger';
import { guardMachineWakeFinalAnswer, isCitationClassClaim } from './action-verifier';

/** The incident's seat / owner (from the live ticket's context / userId). */
const CHAT = '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa';
const USER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
/** The three invented ids (exist NOWHERE — resolve_id ×3 empty this lane; the real actions' ids came later and differ entirely). */
const FAB_DISPATCH = 'd12f21f1';
const FAB_MESSAGE = 'd031a112';
const FAB_SCHED = '2b3cf15b';
/** The idiom forms the struck note actually used: "(receipt d12f21f1)", "receipt d031a112", "sched 2b3cf15b". */
const FAB_DISPATCH_LINE = `**Lane 24f1950e reactivated + dispatched** (receipt ${FAB_DISPATCH}) with the established append lifecycle`;
const FAB_MESSAGE_LINE = `**Ack to the requester** (receipt ${FAB_MESSAGE}): grant in flight, close-trigger protocol banked`;
const FAB_SCHED_LINE = `**Window-watch armed on my own chat** (one-shot, fires 16:45Z — sched ${FAB_SCHED})`;

/** The struck note, abridged to the convicted lines (verbatim phrasing from msg fdd722fc). */
const NOTE = [
  '**Peer re-grant request verified and answered — grant dispatched, window-watch armed, triggers banked As of 09:31 AM PDT (16:31Z).**',
  FAB_DISPATCH_LINE,
  FAB_MESSAGE_LINE,
  FAB_SCHED_LINE,
  'ACTIONS TAKEN',
  `- Lane 24f1950e unarchived + briefed — receipt ${FAB_DISPATCH}`,
  `- Close-trigger protocol + grant ack sent to spark-cluster 69fb25fc — receipt ${FAB_MESSAGE}`,
  `- One-shot window-watch armed on this chat (next fire 16:45Z) — sched ${FAB_SCHED}`,
].join('\n');

const guardInput = (finalText: string) => ({
  chatId: CHAT, userId: USER, finalText, parts: [] as any[], receipts: [] as any[],
  runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
  machineTriggered: true, consequenceScope: 'citation-only' as const,
  // (reviewer F1) PIN the clock: the incident note's headline carries "As of
  // 09:31 AM PDT (16:31Z)" — a time-of-day-conditional tokenization risk the
  // reviewer probed at 9 clock hours. Pinning now to the delivery instant
  // keeps the fixture deterministic at ANY hour: the strike must depend on the
  // three invented ids, never on when the suite happens to run.
  now: new Date('2026-10-19T16:31:43Z'),
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OWNER_NOTE_NO_EDIT_DISABLED;
  delete process.env.ACTION_VERIFIER_ENFORCE;
  delete process.env.ACTION_CLASS_ANNOTATE_DISABLED;
});

describe('ticket 336f3d38 — the guard\'s durable records state the actual delivery mode', () => {
  it('INCIDENT REPLAY: a zero-receipt supervisor wake citing three invented ids is struck; the warn says DELIVERED-AS-WRITTEN (annotated), not "replaced"', async () => {
    const res = await guardMachineWakeFinalAnswer(guardInput(NOTE));

    expect(res.struck).toBe(true);
    // The citation lanes convicted the invented ids (receipt-labeled ids mine on the
    // receipt-citation lane; "sched <id>" on the schedule lane).
    const ids = res.phantoms.map((p) => String(p.id));
    for (const id of [FAB_DISPATCH, FAB_MESSAGE, FAB_SCHED]) {
      expect(ids).toContain(id);
    }
    // (a) The delivered note: AS WRITTEN plus the observe-only annotation.
    expect(res.finalText).toContain(FAB_DISPATCH_LINE);
    expect(res.finalText).toContain('[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]');
    // (b) THE FIX: the warn's delivery phrase states the W1-4 annotated delivery — never
    // "replaced before delivery" for a note that reached the thread as written.
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('PRE-DELIVERY strike') && String(c[0]).includes('phantom claim'));
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of warnCalls) {
      expect(String(c[0])).not.toContain('replaced before delivery');
      expect(String(c[0])).toContain('delivered as written with an observe-only annotation');
    }
    // (c) The filing carries the annotated-delivery marker (the counter-bump prose reads it).
    const filing = mockFileFeedbackTicket.mock.calls.find((c: any[]) => (c[0] as any)?.context) as any[] | undefined;
    expect(filing).toBeDefined();
    expect((filing![0] as any).context).toMatchObject({
      sessionId: CHAT,
      deliveredAnnotated: true,
      containedPreDelivery: true,
    });
  });

  it('the same strike under OWNER_NOTE_NO_EDIT_DISABLED=1 (strip+mark / replacement restored) logs the non-annotated mode actually used — never "delivered as written"', async () => {
    process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1';
    const res = await guardMachineWakeFinalAnswer(guardInput(NOTE));
    expect(res.struck).toBe(true);
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('PRE-DELIVERY strike') && String(c[0]).includes('phantom claim'));
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of warnCalls) {
      const msg = String(c[0]);
      expect(msg).not.toContain('delivered as written');
      // Either lawful non-annotated mode, named as such (strip+mark when the
      // redaction succeeded, replacement when it failed closed).
      expect(/stripped line\(s\) removed \(strip\+mark\)|replaced before delivery/.test(msg)).toBe(true);
    }
  });

  it('DETECTOR-RECALL REPLAY — the citation lanes still convict the prior true positives this class rests on: all three invented ids strike CITATION-class (the 2026-09-11 consequence scope), the note body still delivered unmodified with the annotation', async () => {
    const res = await guardMachineWakeFinalAnswer(guardInput(NOTE));
    expect(res.struck).toBe(true);
    const convicted = res.phantoms.filter((p) => [FAB_DISPATCH, FAB_MESSAGE, FAB_SCHED].includes(String(p.id)));
    expect(convicted.length).toBeGreaterThanOrEqual(3);
    // fabricatedId ∨ miscopiedFrom ∨ a citation detail tag — whichever
    // disjunct stamped it, the conviction must remain citation-class so the
    // consequence scope (2026-09-11 flip) still enforces on it.
    for (const p of convicted) {
      expect(isCitationClassClaim(p)).toBe(true);
    }
    expect(res.finalText).toContain(FAB_SCHED_LINE); // note body delivered unmodified
    expect(String(res.finalText)).toContain('[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]');
  });

  it('F3 pin (cross-review): the non-admin shapeDescription record names the annotated delivery — never "replaced" for a W1-4 delivery', async () => {
    const res = await guardMachineWakeFinalAnswer(guardInput(NOTE));
    expect(res.struck).toBe(true);
    const shapeCalls = mockFileFeedbackTicket.mock.calls.map((c: any[]) => c[0]).filter((o: any) => typeof o?.shapeDescription === 'string');
    expect(shapeCalls.length).toBeGreaterThanOrEqual(1);
    for (const shape of shapeCalls) {
      expect(String(shape.shapeDescription)).toContain('pre-delivery strike (delivered as written with observe-only annotation (audit 2026-10-08 W1-4))');
      expect(String(shape.shapeDescription)).not.toMatch(/pre-delivery strike \(replaced\)/);
      expect(String(shape.shapeDescription)).not.toMatch(/pre-delivery strike \(strip\+mark\)/);
    }
  });

  it('SYNTHETIC (cross-review F1): an ACTION-class strike under the default logs the UNMODIFIED phrase — the seam will not enforce that verdict, so the record must not claim an annotation', async () => {
    // A second, independently-shaped case (not the incident's citation class):
    // an ID-LESS action claim — "steered the lane" with no receipt id —
    // convicted ACTION-class by the LLM extractor on a zero-receipt wake.
    // (markFabricatedIds gates on idish(p.id), so an id-less action claim
    // stays pure ACTION-class — exactly the f58 majority class the seam
    // delivers UNMODIFIED.) Under ACTION_VERIFIER_ENFORCE unset the
    // machine-wake seam delivers the ORIGINAL note unmodified for this
    // verdict class (chat-agent.service.ts:5673 "observed only … note
    // delivered unmodified") — no annotation is appended, and under
    // consequenceScope 'citation-only' the consequences are suppressed
    // (f16cc02a). The warn must say exactly that.
    const ACTION_NOTE = [
      '**ctrl.cql.ca wake — gap matrix follow-up.**',
      'ACTIONS TAKEN',
      '- Steered the spark-cluster lane onto the gap-matrix follow-up',
    ].join('\n');
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'Steered the spark-cluster lane onto the gap-matrix follow-up' }],
    }));
    const res = await guardMachineWakeFinalAnswer(guardInput(ACTION_NOTE));
    expect(res.struck).toBe(true);
    expect(res.phantoms.length).toBeGreaterThanOrEqual(1);
    // The verdict stands ACTION-class (the citation lanes skipped the id —
    // it rides an LLM action claim).
    expect(res.phantoms.every((p) => !isCitationClassClaim(p))).toBe(true);
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('PRE-DELIVERY strike') && String(c[0]).includes('phantom claim'));
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of warnCalls) {
      const msg = String(c[0]);
      // BRIEFING-UNVERIFIED-FILTER (2026-10-20): on a SUPERVISOR wake the seam appends a trailing
      // action-class footnote for the id-less claims it can locate — the warn names it (still never
      // the W1-4 citation annotation, never a replacement).
      expect(msg).toContain('the note was delivered AS WRITTEN (observe-only — the seam will not enforce this verdict; nothing is removed');
      expect(msg).toContain('BRIEFING-UNVERIFIED-FILTER');
      // Conditional (review fix 2026-10-20): an unlocatable or receipt-backed claim gets no footnote.
      expect(msg).toContain('may get a trailing footnote at finalize');
      expect(msg).not.toContain('observe-only annotation (audit 2026-10-08 W1-4)');
      expect(msg).not.toContain('replaced before delivery');
    }
    // f16cc02a class-flip suppression: an ACTION-class standing verdict under
    // 'citation-only' files NO pre-delivery ticket (it would claim a
    // containment that never happens) — the seam's 'observed' row is the record.
    const filings = mockFileFeedbackTicket.mock.calls.map((cc: any[]) => cc[0]).filter((o: any) => o && o.context);
    expect(filings).toHaveLength(0);
  });

  it('KILL SWITCH (BRIEFING-UNVERIFIED-FILTER): ACTION_CLASS_ANNOTATE_DISABLED=1 restores the UNMODIFIED / no-annotation phrase for the same ACTION-class strike', async () => {
    process.env.ACTION_CLASS_ANNOTATE_DISABLED = '1';
    const ACTION_NOTE = [
      '**ctrl.cql.ca wake — gap matrix follow-up.**',
      'ACTIONS TAKEN',
      '- Steered the spark-cluster lane onto the gap-matrix follow-up',
    ].join('\n');
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'Steered the spark-cluster lane onto the gap-matrix follow-up' }],
    }));
    const res = await guardMachineWakeFinalAnswer(guardInput(ACTION_NOTE));
    expect(res.struck).toBe(true);
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('PRE-DELIVERY strike') && String(c[0]).includes('phantom claim'));
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of warnCalls) {
      const msg = String(c[0]);
      expect(msg).toContain('the note was delivered UNMODIFIED (observe-only — the seam will not enforce this verdict; the struck content reached the thread as written, no annotation appended)');
      expect(msg).not.toContain('BRIEFING-UNVERIFIED-FILTER');
    }
  });

  it('CONTROL — an honest note citing ids that EXIST (receipt id and sched id with real rows) strikes nothing and logs no PRE-DELIVERY strike', async () => {
    // Real rows for the receipt-cited message id and the schedule id: the
    // receipt-citation lane exonerates ids present in run_tool_receipts, the
    // schedule lane on a chatSchedule row.
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: 'real-receipt-row' });
    mockPrisma.chatSchedule.findFirst.mockResolvedValueOnce({ id: 'real-sched-row' });
    const honest = [
      '**Wake — grant re-verified against the ledger.**',
      `**Ack to the requester** (receipt d031a112): delivered — the row exists in run_tool_receipts.`,
      `**Window-watch armed** (one-shot — sched 2b3cf15b): the schedule row exists.`,
      'ACTIONS TAKEN',
      '- State doc updated — supervisor_state',
    ].join('\n');
    const res = await guardMachineWakeFinalAnswer(guardInput(honest));
    expect(res.struck).not.toBe(true);
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('PRE-DELIVERY strike') && String(c[0]).includes('phantom claim'));
    expect(warnCalls).toHaveLength(0);
  });
});
