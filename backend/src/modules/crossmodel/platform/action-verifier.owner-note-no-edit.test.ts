/**
 * audit 2026-10-08 W1-4 (supervisors F5) — REPLAY of the Schooltime 17:16:10Z strike: the
 * supervisor's TRUE machine-wake line "push `2b7bc8a` verified on origin" (a real git sha —
 * lane 0037460b's git_commit receipt 875f891a / git_push a8d531ea) was extracted by the utility
 * LLM as a `ticket` claim with id 2b7bc8a, existence-checked against the ticket table (no row),
 * stamped fabricatedId, ENFORCED by the always-on citation lane and the line deleted from the
 * owner-facing note ("⛔ [line removed by the action verifier …]").
 *
 * Pins: (1) the id-shape + verb-kind gate drops a git sha read as a ticket (and keeps true ticket
 * claims, miscopied prefixes and dashed uuids); (2) an owner-facing note is NEVER edited — a real
 * citation strike delivers the note AS WRITTEN with one trailing observe-only annotation (stripped
 * from model context on reload) and the correction says so; (3) both kill switches.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import {
  gateLlmClaimShapes, guardMachineWakeFinalAnswer, renderObserveOnlyAnnotation, ACTION_GUARD_ANNOTATION_HEADER,
  REDACTED_CLAIM_LINE, ownerNoteNoEditDisabled, claimShapeGateDisabled,
} from './action-verifier';
import { redactGuardChrome } from '../guard-chrome-redact';

const CHAT = '41bd202a-7152-437e-bf4b-a097981692b1'; // Schooltime project supervisor
const USER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
// The struck note, shape as delivered (owner's own chat; abridged).
const SCHOOLTIME_NOTE = [
  '**Schooltime wake — 10:16 AM PDT (17:16Z).** Recorder lane fix landed.',
  '- **Recorder lane:** push `2b7bc8a` verified on origin — the sign-in fix is live on the box',
  '- **Board:** 2 active goals · 0 open owner questions — nothing waiting on you',
  'WAKE: reported — lane fix verified; no lane action',
].join('\n');
const SHA_CLAIM = { kind: 'ticket', detail: 'push `2b7bc8a` verified on origin', id: '2b7bc8a' };

const guardInput = (finalText: string) => ({
  chatId: CHAT, userId: USER, finalText, parts: [] as any[], receipts: [] as any[],
  runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
  machineTriggered: true, consequenceScope: 'citation-only' as const,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OWNER_NOTE_NO_EDIT_DISABLED;
  delete process.env.ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED;
});

describe('gateLlmClaimShapes — a git sha is never a ticket', () => {
  it('REPLAY: the 17:16Z claim (7-hex sha beside push/origin, no filing wording) is dropped', () => {
    const r = gateLlmClaimShapes([SHA_CLAIM as any]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{ claim: SHA_CLAIM, reason: 'git_sha_shape' }]);
  });
  it('an 8-hex id beside git vocabulary with no filing wording is a git ref; WITH filing wording it stays', () => {
    expect(gateLlmClaimShapes([{ kind: 'ticket', detail: 'merged 2b7bc8aa into main on origin', id: '2b7bc8aa' } as any]).dropped[0].reason).toBe('git_context');
    expect(gateLlmClaimShapes([{ kind: 'ticket', detail: 'filed ticket 9e1c13ea after the push landed', id: '9e1c13ea' } as any]).kept).toHaveLength(1);
  });
  it('a ticket claim must be worded as a filing (verb or noun); real shapes stay', () => {
    expect(gateLlmClaimShapes([{ kind: 'ticket', detail: 'the recorder now opens LR2 first', id: '1a2b3c4d' } as any]).dropped[0].reason).toBe('kind_verb');
    for (const detail of ['filed a ticket for this pattern', 'file_feedback → ticket 61797fe8 filed', "Ticket's in now: `23c68866` — bug report", "filed against Digby's platform (`bug_report`)"]) {
      expect(gateLlmClaimShapes([{ kind: 'ticket', detail, id: '61797fe8' } as any]).kept).toHaveLength(1);
    }
  });
  it('a miscopied 7-char prefix WORDED as a ticket (7ea4819b) and a dashed uuid are kept; other kinds are only sha-gated', () => {
    expect(gateLlmClaimShapes([{ kind: 'ticket', detail: 'filed ticket 59a407b-ee05-4026-bac9-b4a71c00fed3', id: '59a407b-ee05-4026-bac9-b4a71c00fed3' } as any]).kept).toHaveLength(1);
    expect(gateLlmClaimShapes([{ kind: 'ticket', detail: 'filed ticket 59a407b', id: '59a407b' } as any]).kept).toHaveLength(1);
    expect(gateLlmClaimShapes([{ kind: 'message', detail: 'sent the steer to the recorder lane', id: '0037460b' } as any]).kept).toHaveLength(1);
    expect(gateLlmClaimShapes([{ kind: 'dispatch', detail: 'pushed commit 2b7bc8aa4627 to origin', id: '2b7bc8aa4627' } as any]).dropped[0].reason).toBe('git_sha_shape');
  });
  it('kill switch ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED=1 keeps every claim', () => {
    expect(claimShapeGateDisabled()).toBe(false);
    process.env.ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED = '1';
    expect(gateLlmClaimShapes([SHA_CLAIM as any]).kept).toEqual([SHA_CLAIM]);
  });
});

describe('REPLAY — the Schooltime note is no longer struck', () => {
  it('the extractor still calls the sha a ticket, but the guard delivers the TRUE line untouched', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [SHA_CLAIM] }));
    const out = await guardMachineWakeFinalAnswer(guardInput(SCHOOLTIME_NOTE));
    expect(out.struck).toBe(false);
    expect(out.finalText).toBe(SCHOOLTIME_NOTE);
    expect(out.finalText).not.toContain(REDACTED_CLAIM_LINE);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
  it('pre-fix shape (gate OFF + edit ON): the same input strikes the line — the regression the fix removes', async () => {
    process.env.ACTION_VERIFIER_CLAIM_SHAPE_GATE_DISABLED = '1';
    process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1';
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [SHA_CLAIM] }));
    const out = await guardMachineWakeFinalAnswer(guardInput(SCHOOLTIME_NOTE));
    expect(out.struck).toBe(true);
    expect(out.finalText).toContain(REDACTED_CLAIM_LINE);
  });
});

describe('an owner-facing note is never edited — observe-only annotation', () => {
  // A REAL fabrication: an invented ticket id that exists nowhere (the citation-class lane still convicts it).
  const FAB_NOTE = 'Sweep done.\n- Filed ticket deadbeef for the recorder regression\n- Board unchanged';
  const FAB_CLAIM = { kind: 'ticket', detail: 'Filed ticket deadbeef for the recorder regression', id: 'deadbeef' };

  it('a true strike delivers the note AS WRITTEN plus one trailing annotation; the correction and ticket say so', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [FAB_CLAIM] }));
    const out = await guardMachineWakeFinalAnswer(guardInput(FAB_NOTE));
    expect(out.struck).toBe(true);
    expect(out.delivery).toBe('annotated');
    expect(out.finalText.startsWith(FAB_NOTE)).toBe(true);
    expect(out.finalText).toContain('- Filed ticket deadbeef for the recorder regression');
    expect(out.finalText).not.toContain(REDACTED_CLAIM_LINE);
    expect(out.notice.startsWith(ACTION_GUARD_ANNOTATION_HEADER)).toBe(true);
    expect(out.finalText.endsWith(out.notice)).toBe(true);
    expect(out.correction).toContain('DELIVERED AS WRITTEN with an observe-only annotation');
    expect(out.correction).not.toContain('REMOVED (strip+mark)');
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('DELIVERED AS WRITTEN'),
      context: expect.objectContaining({ deliveredAnnotated: true }),
    }));
  });
  it('the annotation is stripped from model context when the row reloads (guard-chrome redaction); the note body stays', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [FAB_CLAIM] }));
    const out = await guardMachineWakeFinalAnswer(guardInput(FAB_NOTE));
    // HARNESS-RECEIPTS-AND-CLAIMS review fix (2026-10-20): the observe-only action-verifier annotation leaves NO
    // signal line (a lane with measured false positives must never read its own real work as not done).
    expect(redactGuardChrome(out.finalText)).toBe(FAB_NOTE);
  });
  it('kill switch OWNER_NOTE_NO_EDIT_DISABLED=1 restores strip+mark', async () => {
    expect(ownerNoteNoEditDisabled()).toBe(false);
    process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1';
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [FAB_CLAIM] }));
    const out = await guardMachineWakeFinalAnswer(guardInput(FAB_NOTE));
    expect(out.struck).toBe(true);
    expect(out.delivery).toBeUndefined();
    expect(out.finalText).toContain(REDACTED_CLAIM_LINE);
  });
  it('renderObserveOnlyAnnotation is one paragraph (no blank line) led by the header', () => {
    const a = renderObserveOnlyAnnotation([FAB_CLAIM as any], { citationOnly: true, boardStatusOnly: false, miscopyOnly: false });
    expect(a.split('\n')[0]).toBe(ACTION_GUARD_ANNOTATION_HEADER);
    expect(a).not.toMatch(/\n\s*\n/);
    expect(a).toContain('deadbeef');
  });
  it('renderObserveOnlyAnnotation names what the supervisor harness removed (review fix 2026-10-20); unset keeps the wording byte-identical', () => {
    const cls = { citationOnly: true, boardStatusOnly: false, miscopyOnly: false };
    const plain = renderObserveOnlyAnnotation([FAB_CLAIM as any], cls);
    expect(renderObserveOnlyAnnotation([FAB_CLAIM as any], cls, null)).toBe(plain);
    expect(renderObserveOnlyAnnotation([FAB_CLAIM as any], cls, { block: false, copies: false })).toBe(plain);
    expect(plain).toContain('nothing above was removed or changed.');
    const block = renderObserveOnlyAnnotation([FAB_CLAIM as any], cls, { block: true });
    expect(block).toContain('minus its own ACTIONS TAKEN list');
    expect(block).toContain('no other line was removed or changed.');
    expect(block).not.toContain('nothing above was removed');
    expect(block).not.toMatch(/\n\s*\n/);
    expect(renderObserveOnlyAnnotation([FAB_CLAIM as any], cls, { copies: true })).toContain('minus its copies of harness-record lines');
  });
});
