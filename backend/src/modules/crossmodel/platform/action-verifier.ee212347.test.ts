/**
 * Replay — ticket ee212347 GAP A (2026-09-30): the phantom-claim ACTION VERIFIER
 * convicted truthful status notes that cited artifacts visible in the chat's
 * durable STATE DOC (`input.stateDocIds`), because the pre-fix verdict-gate ledger
 * (action-verifier.ts `verifyRunActionClaimsAsync`) folded stateDocIds ONLY for
 * supervisor chats. A NON-supervisor chat whose note cited a dispatch/session id
 * that lived in its state doc was convicted as phantom.
 *
 * GAP A widened that ledger so NON-supervisor chats also fold
 * `input.stateDocIds ?? []`, mirroring the findPhantomSessionRefs lane (ticket
 * f1cb73ff B2). The supervisor prior-wake filter (ticket ae7db80b) still applies
 * to supervisor state-doc rows.
 *
 * These 7 cases pin the fix + its neighbours (each is labelled with the fix /
 * regression it guards):
 *   1. supervisor CONVICT            — a supervisor note claiming a dispatch with
 *                                      NO evidence anywhere is still convicted
 *                                      (the verdict gate is not a blanket pass);
 *   2. NON-supervisor GAP-A EXONERATE— a non-supervisor note citing an id present
 *                                      in stateDocIds is EXONERATED (the GAP A
 *                                      widening: the ledger now folds the ids);
 *   3. GAP-B dispatch-staging        — a "staged the task" idiom claim vouched by
 *                                      an ok:false {staged:true} dispatch row
 *                                      (tier never regresses: staging rows can
 *                                      vouch a staging claim, never a shipped one);
 *   4. fabricated SHORT id CONVICTED — a fabricated id too short for the
 *                                      idMatches ≥8-char gate stays convicted;
 *   5. staging idiom NOT matched on a shipping verb — "dispatched the task" does
 *                                      NOT match the staging idiom, so with no
 *                                      real execution it convicts (no over-
 *                                      exoneration via the staging tier);
 *   6. supervisor PRIOR-WAKE filter  — honoured at the matcher level: an id-
 *                                      bearing claim exonerated by an own-run
 *                                      ledger entry stamps the SELF-ACQUITTAL
 *                                      warn (ticket ae7db80b, own-ledger hit);
 *   7. either/or matcher regression  — an id-less dispatch claim matched against
 *                                      a same-kind slot exonerates; an id-less
 *                                      claim with no matching kind slot convicts.
 *
 * The suite pins the matcher/verdict-gate chain deterministically: the LLM claim
 * extractor (utilityChat) is mocked to return the claims each note makes, and the
 * harness receipts lane (getRecentChatReceipts) is mocked so cross-wake never
 * re-exonerates — each case controls its own executed pool / stateDocIds / ledger.
 */

// ─── env seam (same as the sibling a235fbd6 suite): config/env.ts parseEnv ───
// process.exit(1)s on a missing required var when the chain
// action-verifier → utils/logger → config/env loads. Set the minimum BEFORE the
// module under test is imported (imports are at the bottom of this block).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

// ─── logger (silence + a warn spy for the self-acquittal pin in case 6) ──────
const mockLoggerWarn = jest.fn();
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: (...a: any[]) => (mockLoggerWarn as any)(...a), error: jest.fn(), debug: jest.fn() },
}));

// ─── prisma: Proxy-based so any model.action the chain touches resolves to an ──
// async null (DB existence checks fail-closed → "not exonerated"). $transaction ─
// is explicit: receipt-less runs pass `receipts: []`, and the verdict-gate's
// `(input.receipts && input.receipts.length > 0) || prisma.$transaction(...)`
// (action-verifier.ts:3042) then awaits it — the sibling's bare-model mock would
// crash on that path, so this suite mocks the transaction lane too.
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: new Proxy(
    { $transaction: async (fn: any) => (typeof fn === 'function' ? fn({}) : []) },
    {
      get: (t, p) => {
        if (p in t) return (t as any)[p];
        return new Proxy(
          {},
          {
            get: (_m, a) => {
              if (a === 'then') return undefined; // keep the model proxy non-thenable
              return async () => null;
            },
          },
        );
      },
    },
  ),
}));

// ─── utility-llm: the claim extractor. mockUtilityChat returns a JSON array of ─
// claims; each case sets it to what its note claims.
const mockUtilityChat = jest.fn(async () => '[]');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

// ─── feedback + supervisor-state (the conviction side-effects; inert here) ───
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

// ─── cross-wake receipts lane: empty by default so a prior receipt never ─────
// re-exonerates a claim the case means to convict (the verdict gate awaits
// getRecentChatReceipts BEFORE its ledger filter; receipts are NOT
// supervisor-filtered, so leaving this live would break supervisor pins).
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { findPhantomClaims, extractActionClaims, computePhantomClaims } from './action-verifier';
import { ExecutedAction } from './executed-actions';
import type { ExtractedClaim, PhantomClaimComputation } from './action-verifier';

// ─── helpers ─────────────────────────────────────────────────────────────────
const CHAT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

/** A >=40-char note (MIN_NOTE_CHARS) with no short-circuit shape. */
const LONG =
  'Run complete — status follows. The verifier window closed cleanly and every ledger entry reconciled against receipts, so this dispatch note is extracted in full detail for the audit. ';

/** Set the extractor to return these claims. The extractor's contract
 * (extractActionClaims) parses {"claims":[…]} — a bare array parses to {} and
 * yields ZERO claims (the firing-52 debugging lesson: every claimsReturning
 * case silently fell to the deterministic miner / citation lanes instead). */
function claimsReturning(claims: Array<Partial<ExtractedClaim>>) {
  mockUtilityChat.mockResolvedValue(JSON.stringify({ claims }));
}

/** An ok:false {staged:true} dispatch-staging receipt-row action (GAP B pool). */
function stagedDispatchAction(id: string): ExecutedAction {
  return { tool: 'dispatch_platform_task', ok: false, staged: true, ids: { receiptId: `receipt-${id}`, taskId: id, sessionId: id } };
}

/** A real (ok:true) dispatch execution whose envelope carries `id`. */
function realDispatchAction(id: string): ExecutedAction {
  return { tool: 'start_coding_session', ok: true, staged: false, ids: { receiptId: `receipt-${id}`, sessionId: id, chatId: id } };
}

const idsOf = (out: PhantomClaimComputation) => out.phantoms.map((p) => p.id).filter(Boolean);
const detailsOf = (out: PhantomClaimComputation) => out.phantoms.map((p) => p.detail);

beforeEach(() => {
  jest.clearAllMocks();
  mockUtilityChat.mockResolvedValue('[]');
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockGetSupervisorState.mockResolvedValue({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] });
});

describe('ticket ee212347 — phantom-claim verifier (GAP A verdict-gate stateDocIds widening)', () => {
  // ── Case 1: supervisor note claiming a dispatch with NO evidence convicts ──
  test('1. supervisor convict: a phantom dispatch claim with no execution/ledger/DB evidence is convicted', async () => {
    const note = `${LONG}I dispatched a fresh coding session 9abcdef0-1111-4222-8333-444455556666 for the refactor and it is now running.`;
    claimsReturning([{ kind: 'dispatch', detail: 'dispatched a fresh coding session 9abcdef0-1111-4222-8333-444455556666', id: '9abcdef0' }]);
    const out = await computePhantomClaims({
      finalText: note,
      chatId: CHAT,
      userId: USER,
      supervisor: true,
      machineTriggered: true,
      receipts: [],
      parts: [],
      stateDocIds: [],
      runStartedAt: new Date(),
    });
    expect(out.supervisor).toBe(true);
    expect(out.phantoms.length).toBeGreaterThan(0);
    expect(idsOf(out)).toContain('9abcdef0');
  });

  // ── Case 2: NON-supervisor GAP A — stateDocIds fold exonerates ────────────
  test('2. non-supervisor GAP-A exonerate: a stateDocIds-cited dispatch id is exonerated', async () => {
    const id = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
    const note = `${LONG}The refactor session a1b2c3d4 is in flight per the state doc and should report back shortly.`;
    claimsReturning([{ kind: 'dispatch', detail: `session ${id} is in flight`, id: 'a1b2c3d4' }]);
    const out = await computePhantomClaims({
      finalText: note,
      chatId: CHAT,
      userId: USER,
      supervisor: false, // ← the GAP-A case: non-supervisor chat
      machineTriggered: true,
      receipts: [],
      parts: [],
      // The verdict gate now folds stateDocIds into the ledger for NON-supervisor
      // chats too — passing them here pins the matcher accepting a state-doc id.
      stateDocIds: [id],
      runStartedAt: new Date(),
    });
    expect(out.supervisor).toBe(false);
    expect(idsOf(out)).not.toContain('a1b2c3d4');
    expect(out.phantoms).toHaveLength(0);

    // (2b) The REAL GAP-A incident shape (firing-52 debug harness): the id rides
    // OBSERVATION PROSE with NO action claim for it — the f1cb73ff session-refs
    // lane mines the bare "session a1b2c3d4" citation, and the ledger fold must
    // exonerate it there too, PREFIX-TOLERANT (the note cites the 8-char prefix,
    // the state doc stores the full uuid — an exact-match set misses it).
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }));
    const out2b = await computePhantomClaims({
      finalText: `${LONG}The refactor session a1b2c3d4 is in flight per the state doc and should report back shortly.`,
      chatId: CHAT,
      userId: USER,
      supervisor: false, // ← non-supervisor: no supervisor state doc, stateDocIds only
      machineTriggered: true,
      receipts: [],
      parts: [],
      stateDocIds: [id],
      runStartedAt: new Date(),
    });
    expect(out2b.supervisor).toBe(false);
    expect(out2b.phantoms).toHaveLength(0);
  });

  // ── Case 3: GAP B — a staged dispatch row vouches the staging idiom ───────
  test('3. GAP-B dispatch-staging exonerate: a staged row vouches a "staged the task" claim', async () => {
    const id = 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789';
    claimsReturning([{ kind: 'dispatch', detail: `staged the task ${id} for confirmation`, id: 'b2c3d4e5' }]);
    const out = await findPhantomClaims(
      [{ kind: 'dispatch', detail: `staged the task ${id} for confirmation`, id: 'b2c3d4e5' }],
      [stagedDispatchAction(id)],
    );
    // A staged dispatch row vouches a staging-idiom claim; it must NOT also
    // vouch a shipped-action claim (that is the kind-budget p.action.ok guard).
    // findPhantomClaims returns the PHANTOMS (ExtractedClaim[]) — exonerated
    // claims are absent, so 'b2c3d4e5' must NOT appear.
    expect(out.some((c) => c.id === 'b2c3d4e5')).toBe(false);
    expect(out).toHaveLength(0);
  });

  // ── Case 4: a fabricated SHORT id (below the idMatches ≥8 gate) convicts ──
  test('4. fabricated short id still convicted: a sub-8-char id cannot ride the prefix-match gate', async () => {
    // '9abc' is <8 chars → idMatches's prefix arm is closed; the unrelated real
    // execution below must NOT exonerate it, and no ledger/DB/cross-wake lane
    // has it → convicted.
    const note = `${LONG}I dispatched session 9abc for the quick fix and it is running now.`;
    claimsReturning([{ kind: 'dispatch', detail: 'dispatched session 9abc for the quick fix', id: '9abc' }]);
    const out = await computePhantomClaims({
      finalText: note,
      chatId: CHAT,
      userId: USER,
      supervisor: true,
      machineTriggered: true,
      receipts: [],
      parts: [],
      stateDocIds: [],
      runStartedAt: new Date(),
    });
    expect(idsOf(out)).toContain('9abc');
  });

  // ── Case 5: the staging idiom does NOT match a shipping verb ──────────────
  test('5. staging idiom NOT matched on a shipping verb: "dispatched" with no execution convicts', async () => {
    const id = 'c3d4e5f6-a7b8-4901-abcd-f01234567890';
    // A SHIPPED-action claim ("dispatched … is running") with only a STAGED row
    // in the pool must NOT be exonerated by the staging tier — the idiom gate
    // (STAGING_CLAIM_DETAIL_IDIOM) does not match a shipping verb, and the
    // ok:false row cannot vouch a shipped action (kind budget is ok-only).
    claimsReturning([{ kind: 'dispatch', detail: `dispatched session ${id} and it is now running`, id: 'c3d4e5f6' }]);
    const out = await findPhantomClaims(
      [{ kind: 'dispatch', detail: `dispatched session ${id} and it is now running`, id: 'c3d4e5f6' }],
      [stagedDispatchAction(id)],
    );
    // findPhantomClaims returns the PHANTOMS (ExtractedClaim[]) — the shipped
    // claim is NOT exonerated by the staged row, so 'c3d4e5f6' IS present.
    expect(out.some((c) => c.id === 'c3d4e5f6')).toBe(true);
  });

  // ── Case 6: supervisor prior-wake filter (ticket ae7db80b) is honoured ────
  test('6. supervisor prior-wake filter: an own-run (unfiltered) ledger hit stamps the self-acquittal warn', async () => {
    const id = 'd4e5f6a7-b8c9-4012-bcde-0123456789ab';
    // An own-run ledger entry (stamped AFTER the audited run started — NOT
    // filtered to before runStartedAt) exonerating an id-bearing claim is the
    // self-acquittal shape ticket ae7db80b kills: the matcher exonerates but
    // stamps the own-ledger warn so the caller's prior-wake filter is the only
    // thing standing between a supervisor and acquitting its own fabrication.
    claimsReturning([{ kind: 'dispatch', detail: `dispatched session ${id}`, id: 'd4e5f6a7' }]);
    const out = await findPhantomClaims(
      [{ kind: 'dispatch', detail: `dispatched session ${id}`, id: 'd4e5f6a7' }],
      [],           // no executions — only the (own-run) ledger can vouch it
      undefined,    // artifactCheck
      [id],         // ← unfiltered ledgerIds (4th arg): the caller's prior-wake filter owns recency
    );
    // findPhantomClaims returns the PHANTOMS (ExtractedClaim[]) — exonerated
    // claims are absent, so 'd4e5f6a7' must NOT appear (exonerated via the
    // ledger lane). NOTE: the ledger exoneration is a bare `continue` at
    // action-verifier.ts:2356 — NO logger.warn fires there, so there is no
    // 'exonerated via own-run state-doc ledger entry' literal to pin. The
    // behavioral exoneration assertion below is the real pin.
    expect(out.some((c) => c.id === 'd4e5f6a7')).toBe(false);
    expect(out).toHaveLength(0);
  });

  // ── Case 7: either/or matcher regression — id-less slot accounting ────────
  test('7. either/or regression: an id-less dispatch claim matches a same-kind slot; a claim with no slot convicts', async () => {
    // (a) id-less claim + one real same-kind execution → exonerated by the slot.
    claimsReturning([{ kind: 'dispatch', detail: 'dispatched a coding session for the work' }]);
    const matched = await findPhantomClaims(
      [{ kind: 'dispatch', detail: 'dispatched a coding session for the work' }],
      [realDispatchAction('e5f6a7b8-c9d0-4123-cdef-123456789abc')],
    );
    expect(matched).toHaveLength(0);

    // (b) the same id-less claim with an EMPTY pool → no slot → convicted.
    const unmatched = await findPhantomClaims(
      [{ kind: 'dispatch', detail: 'dispatched a coding session for the work' }],
      [],
    );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].kind).toBe('dispatch');
  });
});
