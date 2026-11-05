/**
 * FO FIRING 57 PIN (2026-09-30) — the PRE-DELIVERY strike must carry its
 * EVIDENCE, not just its count.
 *
 * PRODUCTION EVIDENCE (firing-57 audit, 2026-09-30 18:30–22:30Z): the
 * action-verifier PRE-DELIVERY strike fired 10 times in 24h across six
 * supervisor lanes (daee2916 ×4, c0e22e36 ×2, c6941c11, 810c924d, e03452f4,
 * 41bd202a), every single one reading "1 phantom claim(s)" — and the durable
 * record carried only {chatId}. The app_error_logs context was
 * {"chatId": "…", "source": "action-verifier"}; the reject-back guard_strike
 * rows read phantoms:1 on pass 1 but phantoms:0 on the reject-back outcome
 * row (pass 2 — the CLEAN retry — overwrites the verdict), with retryMs
 * 324–341s: a ~5-minute bounded re-orchestration whose CAUSE was never
 * recorded anywhere durable. The operator (this lane) could not adjudicate
 * verifier false-positive vs real model phantom from telemetry — the same
 * unauditable-guard defect class as the firing-50/55 unattributed-warn
 * sweeps, now on the enforcement side.
 *
 * THE FIX (this firing): a shared exported helper `claimAuditExcerpts`
 * (bounded: ≤4 claims, detail ≤120 chars, id ≤24, ≤4 near-misses) rides
 * (a) the PRE-DELIVERY warn context → app_error_logs.context.claims,
 * (b) the chat-agent reject-back warn context (same field),
 * (c) the reject-back outcome row as meta.struckClaims — captured from the
 *     PASS-1 verdict before pass 2 overwrites `guarded` (the phantoms:0
 *     blind spot).
 *
 * This file pins (a) + the helper's bounds against the REAL guard,
 * boundary-mocked exactly like the sibling pins action-verifier.080365bf /
 * 0d9de3cc (their mock topology, their SIGHTING-1 note shape): a fabricated
 * msg citation note is struck, and the warn's context must now name the
 * claim's kind, detail text and cited id. The chat-agent seam sites (b)/(c)
 * live inside chat-agent.service.ts's 4k-line run pipeline (not unit-drivable
 * here) — they are pinned TEXTUALLY below: the reject-back warn span must
 * carry `claims: claimAuditExcerpts(...)` and the outcome-row meta the
 * `struckClaims` capture from the PASS-1 verdict.
 */

const fs = require('fs');
const path = require('path');

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

import { guardMachineWakeFinalAnswer, claimAuditExcerpts } from './action-verifier';
import logger from '../../../utils/logger';

const SUP_PROJECT = '9e6e1712-8dc3-4e02-b70c-557bb5b41d2d';
const PHANTOM_MSG_1 = '6de2e40e';
const REAL_MSG = 'fbcaa25e';
const REAL_SCHED_1 = 'b0456337';
const OWNER = '***';

/** The 080365bf sighting-1 note shape: one fabricated msg citation line + exonerated co-citations. */
const NOTE = [
  '**18:05Z wake — kernel-opt finished cleanly, no new action needed.**',
  '',
  `- **Kernel-opt** \`chat b95e9df6\` — plan 6/6 done, latest \`msg ${REAL_MSG}\` @ 18:05:02Z: self-audit CLOSED. Quiet until its own \`sched ${REAL_SCHED_1}\` cadence (next 20:38Z future)`,
  `- **Doc worker** \`chat 62671567\` — still \`running:true\`, latest \`msg ${PHANTOM_MSG_1}\` @ 18:02:30Z: mid verify/finalize on steps #5–6`,
  '- **R8** `oq_c282dfe5` — probed fresh via list_owner_questions: still OPEN, triaged until 19:19Z future',
  '- **Spark lane** `chat 28de72e5` — mid monitor firing 30/500, normal (`sched 8082b51f` next 18:54Z future).',
].join('\n');

describe('FO firing 57 — the PRE-DELIVERY strike carries its evidence (claimAuditExcerpts)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRecentChatReceipts.mockResolvedValue([]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) =>
      JSON.stringify(args).includes(PHANTOM_MSG_1) ? null : { id: `${REAL_MSG}-0c06-44ba-af85-6356c31968ac` });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: '62671567-0000-4000-8000-000000000000' });
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
    mockPrisma.chatSchedule.findFirst.mockResolvedValue({ id: `${REAL_SCHED_1}-0000-4000-8000-000000000000` });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  });

  it('a strike now logs WHAT was struck: the warn context carries kind + detail + cited id for every phantom', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: SUP_PROJECT, userId: OWNER, finalText: NOTE, parts: [], receipts: [],
      runStartedAt: new Date('2026-09-14T18:04:30.000Z'), machineTriggered: true,
      supervisor: true, supervisorScope: 'project',
      now: new Date('2026-09-14T18:05:40.000Z'),
    });

    expect(res.struck).toBe(true);
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM_MSG_1]);

    // THE PIN: the PRE-DELIVERY strike warn names the claim, not just the count.
    const call = (logger.warn as jest.Mock).mock.calls.find((c: any[]) => String(c[0]).includes('PRE-DELIVERY strike'));
    expect(call).toBeTruthy();
    const ctx = call![1] as any;
    expect(ctx.source).toBe('action-verifier');
    expect(ctx.chatId).toBe(SUP_PROJECT.slice(0, 8));
    expect(Array.isArray(ctx.claims)).toBe(true);
    expect(ctx.claims).toHaveLength(1);
    expect(ctx.claims[0]).toMatchObject({ kind: 'message', id: PHANTOM_MSG_1 });
    expect(ctx.claims[0].detail).toContain('62671567'); // the struck line's substance survives into the excerpt
  });

  it('claimAuditExcerpts is BOUNDED: at most 4 claims, detail ≤120 chars, id ≤24, nearMiss ≤4 — log-context safe', () => {
    const claims: any[] = Array.from({ length: 9 }, (_, i) => ({
      kind: 'message',
      detail: 'x'.repeat(500) + ` #${i}`,
      id: `id-${i}-` + '0123456789abcdef0123456789abcdef0123456789', // 45 chars
      nearMiss: ['nm-aaaa', 'nm-bbbb', 'nm-cccc', 'nm-dddd', 'nm-eeee', 'nm-ffff'],
    }));
    const out = claimAuditExcerpts(claims);
    expect(out).toHaveLength(4); // capped at 4
    for (const c of out) {
      expect(c.detail.length).toBeLessThanOrEqual(120);
      expect(c.id!.length).toBeLessThanOrEqual(24);
      expect(c.nearMiss!).toHaveLength(4);
      expect(c.kind).toBe('message');
    }
    // empty input → empty array (the chat-agent seam spreads it conditionally)
    expect(claimAuditExcerpts([])).toEqual([]);
    // an id-less claim (action-class) still carries kind + detail
    expect(claimAuditExcerpts([{ kind: 'dispatch', detail: 'dispatched the nightly audit worker' }])).toEqual([
      { kind: 'dispatch', detail: 'dispatched the nightly audit worker' },
    ]);
  });

  it('a CLEAN note logs NO strike and NO claims context (the guard stays silent on honesty)', async () => {
    const cleanNote = NOTE.replace(`msg ${PHANTOM_MSG_1}`, `msg ${REAL_MSG}`); // every cited id now exists
    const res = await guardMachineWakeFinalAnswer({
      chatId: SUP_PROJECT, userId: OWNER, finalText: cleanNote, parts: [], receipts: [],
      runStartedAt: new Date('2026-09-14T18:04:30.000Z'), machineTriggered: true,
      supervisor: true, supervisorScope: 'project',
      now: new Date('2026-09-14T18:05:40.000Z'),
    });
    expect(res.struck).toBeFalsy();
    expect((logger.warn as jest.Mock).mock.calls.filter((c: any[]) => String(c[0]).includes('PRE-DELIVERY strike'))).toHaveLength(0);
  });
});

describe('FO firing 57 — chat-agent seam wiring (textual pins: the excerpt must ride the seam sites)', () => {
  /** Balanced-paren span scan — same shape as warn-attribution.firing50.test.ts. */
  function warnSpans(rel: string): string[] {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const spans: string[] = [];
    let i = 0;
    while ((i = src.indexOf('logger.warn(', i)) !== -1) {
      let depth = 0;
      let j = i + 'logger.warn('.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) break; }
      }
      spans.push(src.slice(i, j + 1));
      i = j + 1;
    }
    return spans;
  }

  it('the reject-back warn (chat-agent.service.ts) carries claims: claimAuditExcerpts(...) — WHAT was struck, not just the count', () => {
    const span = warnSpans('../chat-agent/chat-agent.service.ts').find((s) => s.includes('note struck pre-delivery'));
    expect(span).toBeTruthy();
    expect(span).toContain("source: 'chat-agent'"); // the firing-50 stamp survives
    expect(span).toContain('claims: claimAuditExcerpts');
  });

  it('the reject-back OUTCOME ROW captures the PASS-1 verdict before pass 2 overwrites it (struckClaims + firstPassStruckClaims)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../chat-agent/chat-agent.service.ts'), 'utf8');
    const guardCall = 'guarded = await guardMachineWakeFinalAnswer';
    const pass1At = src.indexOf(guardCall);
    const pass2At = src.indexOf(guardCall, pass1At + 1); // the reassignment inside runRejectBackAndSecondPass
    // captured INSIDE the retry fn, between pass 1 and the pass-2 overwrite
    const captureAt = src.indexOf('const firstPassStruckClaims = claimAuditExcerpts(guarded.phantoms ?? [])');
    expect(pass1At).toBeGreaterThan(-1);
    expect(pass2At).toBeGreaterThan(pass1At); // exactly the two-pass shape the pin describes
    expect(captureAt).toBeGreaterThan(pass1At);
    expect(captureAt).toBeLessThan(pass2At); // pass-1 capture precedes the pass-2 overwrite
    // and it rides the outcome row's meta
    expect(src).toContain('struckClaims: firstPassStruckClaims');
  });

  // FO firing 58 (2026-10-01): the f58 live probe (verify-iter58-av-evidence.js)
  // caught #1175's gap — with ACTION_VERIFIER_ENFORCE unset the OBSERVE-ONLY
  // row is the MAJORITY class, and it (plus the mixed-rest and enforced rows)
  // still carried only kinds/ids. Pin: EVERY guard_strike outcome-row meta in
  // chat-agent.service.ts now carries a struckClaims excerpt line, so a future
  // edit cannot re-blind any of the four sites.
  it('FO firing 58 — EVERY guard_strike outcome-row meta carries struckClaims (all four sites: retry, enforced, mixed-rest, observed)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../chat-agent/chat-agent.service.ts'), 'utf8');
    // every recordLoopMetric meta block whose seam is a machine-wake outcome row
    const sites: Array<{ seam: string; needle: string }> = [
      { seam: 'machine_wake_reject_back (retry row)', needle: 'struckClaims: firstPassStruckClaims' },
      { seam: 'machine_wake_citation_enforce (enforced row)', needle: "seam: 'machine_wake_citation_enforce'" },
      { seam: 'machine_wake_reject_back (mixed-rest row)', needle: 'struckClaims: claimAuditExcerpts(observedRest)' },
      { seam: 'machine_wake_reject_back (observed row — the f58 live finding)', needle: "seam: 'machine_wake_reject_back'" },
    ];
    // the enforced row: the seam literal followed (within its meta block) by a struckClaims line
    const enforcedAt = src.indexOf("seam: 'machine_wake_citation_enforce'");
    expect(enforcedAt).toBeGreaterThan(-1);
    const enforcedMeta = src.slice(enforcedAt, enforcedAt + 900);
    expect(enforcedMeta).toContain('struckClaims: claimAuditExcerpts(guarded.phantoms ?? [])');
    // the observed row (line 4296 class): find the LAST machine_wake_reject_back seam
    // occurrence (the observed row is the final one) and check its meta
    const lastRejectBackAt = src.lastIndexOf("seam: 'machine_wake_reject_back'");
    expect(lastRejectBackAt).toBeGreaterThan(-1);
    const observedMeta = src.slice(lastRejectBackAt, lastRejectBackAt + 900);
    expect(observedMeta).toContain('struckClaims: claimAuditExcerpts(guarded.phantoms ?? [])');
    // and the retry + mixed rows are pinned by their unique needles
    expect(src).toContain(sites[0].needle);
    expect(src).toContain(sites[2].needle);
  });
});
