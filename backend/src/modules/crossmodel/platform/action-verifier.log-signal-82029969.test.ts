/**
 * Characterization pin — log-signal ticket 82029969 (2026-10-23, family lane
 * ecc2bb0d): the "action-verifier: PRE-DELIVERY strike — <n> phantom claim(s)
 * in supervisor <id>'s note …" warn fingerprint the hourly log-signal-sweep
 * filed (13 rows across 8 distinct hours, Oct 21) is the action-verifier
 * guard doing its DESIGNED job — catching REAL phantom claims in supervisor
 * notes BEFORE delivery — not a defect in the guard.
 *
 * PRODUCTION EVIDENCE (this run, 2026-10-23): the class is still live at 41
 * rows / 24 h (newest 00:11:45Z) across MANY supervisor lanes (6061a468,
 * e03452f4, c6941c11, daee2916, c0e22e36, 590d604e …) — always "1–2 phantom
 * claim(s)", never a burst from one lane. Each row is the guard CONVICTING a
 * claim that cited no receipt. The sweep's normalized fingerprint
 * ("…s note; the note was delivered as writ") covers BOTH live delivery
 * phrases, and both are pinned below:
 *   - citation-class strike → "the note was delivered as written with an
 *     observe-only annotation (audit 2026-10-08 W1-4)";
 *   - action-class strike on a supervisor wake → "the note was delivered AS
 *     WRITTEN (observe-only — … BRIEFING-UNVERIFIED-FILTER)".
 * The strike's per-claim evidence (kind / detail / cited id) rides the warn
 * context — pinned 2026-09-30 by action-verifier.f57-strike-evidence.test.ts
 * (FO firing 57), whose harness this suite mirrors.
 *
 * WHY DESIGNED (and why recurrence is not a defect): the strike IS the
 * enforcement record for the platform's fabricate-a-completion-claim guard
 * (the standing owner requirement behind the CLAIM BAR doctrine). The
 * recurrence driver is MODEL behavior on supervisor lanes (a supervisor
 * occasionally narrates an action it did not execute), not a loop: the
 * reject-back pass re-orchestrates ONCE (retryMs ~324–341s, f57 audit) and
 * the retry's clean text supersedes the attempt — bounded by design
 * (deferred-consequences pass, pinned below). Silencing this warn would
 * blind the fleet to exactly the fabrication class the owner rules target.
 *
 * Containment bounds pinned here: ONE strike warn per guarded note (never a
 * per-claim fan-out), level warn (never error), source 'action-verifier',
 * and total SILENCE on a clean note — no sweep rows without a cause.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { guardMachineWakeFinalAnswer } from './action-verifier';
import logger from '../../../utils/logger';

const fs = require('fs');
const path = require('path');

const OWNER = '***';
// A message id that EXISTS in the mock DB and one that does not — the f57
// harness split: the fabricated citation is convicted on non-existence while
// the co-cited real ids exonerate.
const PHANTOM_MSG = '6de2e40e';
const REAL_MSG = 'fbcaa25e';

/** Citation-class shape (the 080365bf / f57 sighting note): a supervisor
 * digest citing a message id that does not exist. */
const NOTE_CITATION = [
  '**20:47Z wake — kernel-opt finished cleanly, no new action needed.**',
  '',
  `- **Kernel-opt** \`chat b95e9df6\` — plan 6/6 done, latest \`msg ${REAL_MSG}\` @ 18:05:02Z: self-audit CLOSED.`,
  `- **Doc worker** \`chat 62671567\` — still \`running:true\`, latest \`msg ${PHANTOM_MSG}\` @ 18:02:30Z: mid verify/finalize on steps #5–6.`,
].join('\n');

/** Action-class shape: a first-person action claim with NO id and NO
 * receipt — the "I sent a steer" narration class behind the live
 * BRIEFING-UNVERIFIED-FILTER rows. The LLM extractor leg surfaces it (the
 * deterministic miners only carry id-bearing lines). */
const ACTION_LINE = 'I sent a steer to the kernel-opt lane, telling it to hold the next merge.';
const NOTE_ACTION = [
  '**20:47Z wake — sweep digest.**',
  '',
  '- Lane A `chat 62671567` — quiet since 19:40Z, nothing to do.',
  `- ${ACTION_LINE}`,
].join('\n');

const CLEAN_NOTE = [
  '**20:47Z wake — sweep digest.**',
  '',
  `- Lane A \`chat 62671567\` — quiet since 19:40Z, nothing to do.`,
].join('\n');

const baseInput = {
  chatId: 'e03452f4-0000-4000-8000-000000000000',
  userId: OWNER,
  parts: [],
  receipts: [],
  runStartedAt: new Date('2026-10-22T20:00:00.000Z'),
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'project' as const,
  now: new Date('2026-10-22T20:05:00.000Z'),
};

const strikeCalls = () =>
  (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => String(c[0]).includes('PRE-DELIVERY strike'));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) =>
    JSON.stringify(args).includes(PHANTOM_MSG) ? null : { id: `${REAL_MSG}-0c06-44ba-af85-6356c31968ac` });
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: '62671567-0000-4000-8000-000000000000' });
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  delete process.env.ACTION_VERIFIER_ENFORCE;
  delete process.env.ACTION_CLASS_ANNOTATE_DISABLED;
});

describe('log-signal 82029969 — the strike warn is the designed enforcement record (both live delivery-phrase variants)', () => {
  it('CITATION-class strike (fabricated msg id): ONE warn at level warn, source action-verifier, swept fingerprint + claim evidence; the annotation delivery phrase', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...baseInput, finalText: NOTE_CITATION });
    expect(res.struck).toBe(true);

    expect(strikeCalls()).toHaveLength(1); // one warn per guarded note — no per-claim fan-out
    const [msg, ctx] = strikeCalls()[0] as [string, any];
    expect(msg).toContain('action-verifier: PRE-DELIVERY strike — 1 phantom claim(s) in supervisor e03452f4');
    expect(msg).toContain('the note was delivered as written with an observe-only annotation (audit 2026-10-08 W1-4)');
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0); // warn, never error — the sweep reads warn+
    expect(ctx.source).toBe('action-verifier');
    expect(ctx.chatId).toBe('e03452f4');
    expect(ctx.claims[0]).toMatchObject({ kind: 'message', id: PHANTOM_MSG });
  });

  it('ACTION-class strike (id-less unvouched action claim, surfaced by the LLM extractor): the BRIEFING-UNVERIFIED-FILTER delivery phrase — the majority live variant', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'message', detail: ACTION_LINE, id: '' }],
    }) as never);
    const res = await guardMachineWakeFinalAnswer({ ...baseInput, finalText: NOTE_ACTION });
    expect(res.struck).toBe(true);

    expect(strikeCalls()).toHaveLength(1);
    const msg = String(strikeCalls()[0][0]);
    expect(msg).toContain('the note was delivered AS WRITTEN (observe-only — the seam will not enforce this verdict');
    expect(msg).toContain('BRIEFING-UNVERIFIED-FILTER');
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('a deferred-consequences strike (the reject-back pre-pass) appends the supersession clause — pass 1 fires BEFORE delivery, bounded by the one retry', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...baseInput, finalText: NOTE_CITATION, deferConsequences: true });
    expect(res.struck).toBe(true);
    const msg = String(strikeCalls()[0][0]);
    // The normalized fingerprint's tail ("the note was delivered as writ…")
    // and the bounded-retry clause that makes recurrence non-looping.
    expect(msg).toContain('the note was delivered as writ');
    expect(msg).toContain("unless the reject-back supersedes it (deferred-consequences pass — the retry's clean text replaces this attempt)");
  });

  it('a CLEAN note logs NO strike warn — the guard stays silent on honesty (no sweep rows without a cause)', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...baseInput, finalText: CLEAN_NOTE });
    expect(res.struck).toBeFalsy();
    expect(strikeCalls()).toHaveLength(0);
  });
});

describe('log-signal 82029969 — seam wiring (textual pin: the emit site cannot silently change shape)', () => {
  it('the strike warn site still passes source + chatId + claims context (action-verifier.ts)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'action-verifier.ts'), 'utf8');
    expect(src.indexOf('action-verifier: PRE-DELIVERY strike — ')).toBeGreaterThan(-1);
    expect(src).toContain("{ source: 'action-verifier', chatId: chat8, claims: claimAuditExcerpts(phantoms) }");
  });
});

// ── Log-signal family lane 92dc54d6 — ticket 91fb1905 (2026-10-26) ──────────────
// The October-25 batch of the 82029969 strike class: 9 rows/24h (Oct 25,
// 16:47–23:24Z) of
//   action-verifier: PRE-DELIVERY strike — 1 phantom claim(s) in supervisor
//   c0e22e36's note; the note was delivered AS WRITTEN (observe-only — …
//   BRIEFING-UNVERIFIED-FILTER) unless the reject-back supersedes it
//   (deferred-consequences pass — the retry's clean text replaces this attempt)
// Adjudication (lane 92dc54d6, 2026-10-27): NOT a framework defect — the
// SAME guard, same emit site, same standing signal as 82029969 (the Oct-21
// batch): a supervisor note's id-less action claim with no backing receipt,
// struck pre-delivery. The Oct-25 rows centre on the fleet lane c0e22e36 and
// carry the action-class delivery phrase UNDER the reject-back pre-pass —
// the exact combination the 82029969 suite pinned piecewise (action-class
// without defer, citation-class with defer) but not together; this block
// replays that combination so THIS ticket's own fingerprint is pinned
// verbatim under the same harness.
describe('log-signal 91fb1905 — the Oct-25 strike batch (action-class under the reject-back pre-pass, lane c0e22e36)', () => {
  it('REPLAYS the prod row verbatim: an action-class strike on a supervisor wake under deferConsequences — warn level, ONE warn, both clauses', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'message', detail: ACTION_LINE, id: '' }],
    }) as never);
    const res = await guardMachineWakeFinalAnswer({
      ...baseInput,
      chatId: 'c0e22e36-0000-4000-8000-000000000000', // the prod row's lane
      finalText: NOTE_ACTION,
      deferConsequences: true,
    });
    expect(res.struck).toBe(true);
    expect(strikeCalls()).toHaveLength(1);
    const [msg, ctx] = strikeCalls()[0] as [string, any];
    expect(msg).toContain('action-verifier: PRE-DELIVERY strike — 1 phantom claim(s) in supervisor c0e22e36');
    // the action-class delivery phrase…
    expect(msg).toContain('the note was delivered AS WRITTEN (observe-only — the seam will not enforce this verdict; nothing is removed, and its id-less action claims that locate in the note and cite no action receipt of this chat may get a trailing footnote at finalize — BRIEFING-UNVERIFIED-FILTER)');
    // …and the deferred-consequences tail — the exact prod-row combination.
    expect(msg).toContain("unless the reject-back supersedes it (deferred-consequences pass — the retry's clean text replaces this attempt)");
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0); // warn, never error
    expect(ctx.source).toBe('action-verifier');
    expect(ctx.chatId).toBe('c0e22e36');
  });

  it('the class is ONE family with 82029969: the same emit site — only the batch dates and lanes differ (Oct 21 → 82029969, Oct 25 → 91fb1905)', () => {
    // Both tickets normalize to the same fingerprint prefix ("action-verifier:
    // pre-delivery strike — <n> phantom claim(s) in supervisor <id>'s note;
    // the note was delivered as") — two batches of ONE standing signal:
    // model-narrated actions that never executed, caught pre-delivery. The
    // recurrence is bounded by design (ONE reject-back re-orchestration,
    // pinned above), never a retry loop.
    const src = fs.readFileSync(path.join(__dirname, 'action-verifier.ts'), 'utf8');
    expect(src.indexOf('action-verifier: PRE-DELIVERY strike — ')).toBeGreaterThan(-1);
  });
});
