/**
 * Ticket 9759bf5c — the second false green on the SAME broken credential pair.
 *
 * THE DEFECT (measured in prod): the owner-gate sweeper's action (d)
 * auto-resolved a credential-gated owner question whenever the vault SLOT held
 * a row, even when that row PREDATED the question. The card exists precisely
 * BECAUSE the stored value is known-dead — the lane is asking for a FRESH key —
 * so a stored row that predates `createdAt` can never be the answer. Two
 * consecutive asks were stamped resolved on the same dead pair with zero owner
 * action:
 *   oq_aacc4a12 (2026-10-21)  → "gate lifted via the stored credential"
 *   oq_d054352c (2026-10-30, filed 01:37:54Z, auto-answered 01:39:25Z — 91 s)
 *     → "a slot-validated store row — no new value was pasted"
 * while every probe of the pair returned AK_len=20, SK_len=20, IDENTICAL
 * values and STS SignatureDoesNotMatch. The owner's inbox showed the wall
 * resolved, so nobody acted.
 *
 * SECOND HOLE (why "slot validation" alone was not enough): the live pair is
 * CANLAW_CPT_S3_KEY / CANLAW_CPT_S3_SECRET_ACCESS_KEY. The KEY half held a
 * well-formed 20-char AKIA id — it PASSED its own slot validation — so the
 * sweep lifted on it, while its sibling held the same bytes in the secret
 * slot. A credential row is only HALF the evidence for an AWS pair; the pair
 * must be internally consistent to count.
 *
 * The fix, replayed end-to-end against the REAL sweeper + REAL credential-gate
 * + REAL owner-questions over a stateful fake Prisma (the
 * owner-answer-vault.7caf07ed.test.ts harness pattern — only config/database
 * and the wake boundaries are mocked):
 *   (1) credentialLifted({notBefore}) refuses a row/receipt written BEFORE the
 *       question → declinedBy 'predates-question';
 *   (2) a readable AWS-pair row whose sibling contradicts it (identical halves,
 *       or a corrupt sibling) refuses → declinedBy 'aws-pair-mismatch';
 *   (3) the sweeper leaves the card OPEN on either decline and counts it in
 *       credentialGatesDeclined instead of stamping the false green.
 * The healthy paths stay healthy: a credential stored AFTER the ask still
 * self-heals, and an in-place REPAIR (updatedAt rewritten) counts as new.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: async () => null, set: async () => true, del: async () => true,
    // owner-gate-sweeper action (c) SCANs confirm:pending:* presence keys —
    // return an empty page so the pending arm is a no-op in this suite.
    scan: async () => ({ cursor: 0, keys: [] }),
    mGet: async () => [],
  },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    runToolReceipt: { findFirst: async () => null },
    codingCredential: {
      findUnique: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
      },
      findFirst: async ({ where }: any) => {
        const ek = where.envKey;
        const pred: (r: any) => boolean = typeof ek === 'string'
          ? (r) => String(r.envKey) === ek
          : ek && typeof ek.startsWith === 'string'
            ? (r) => String(r.envKey).startsWith(ek.startsWith)
            : () => false;
        return mockCreds.find((r) => r.userId === where.userId && pred(r)) ?? null;
      },
      count: async ({ where }: any) => mockCreds.filter((r) => r.userId === where.userId).length,
      upsert: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
      },
    },
    activity: { create: async ({ data }: any) => data },
    projectTodo: { findMany: async () => [] },
    projectGoal: { findMany: async () => [] },
    telegramLink: { findUnique: async () => null },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));

// Ticket 9759bf5c review finding F1: the owner_gate_sweep loop_metrics row is
// the observable proof that a false green was WITHHELD — pin that it is emitted
// on a decline-only pass.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { flagOwnerQuestion } from './owner-questions';
import { encryptValue } from '../coding/credentials.service';
import { credentialLifted } from './credential-gate';
import { sweepOwnerGatesOnce } from './owner-gate-sweeper';

/** Fake AWS pair, assembled from parts so no credential-shaped literal sits
 *  contiguous in source (the 7caf07ed/ca0b57cd fixture convention). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_BODY = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const SECRET_VALUE = `/${SECRET_BODY}`;
const KEY_ENV = 'CANLAW_CPT_S3_KEY';
const SECRET_ENV = 'CANLAW_CPT_S3_SECRET_ACCESS_KEY';

const flagCredentialAsk = async (envKey: string) => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: `Please create a FRESH IAM key and paste the ${envKey} — the stored one is dead`,
    expectedAnswerType: `credential:${envKey}`,
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

const storedRow = (id: string) => mockQuestions.rows.find((r: any) => r.id === id);

/** Seed a vault row. `at` defaults to AFTER the just-filed question, which is
 *  the honest "the key actually landed" shape the auto-heal exists for. */
const seedStoreRow = (envKey: string, value: string, at: Date = new Date(Date.now() + 60_000)) => {
  mockCreds.push({
    id: `cred-seed-${mockCreds.length + 1}`, createdAt: at, updatedAt: at,
    userId: 'u1', provider: 'custom', envKey, label: '',
    valueEnc: encryptValue(value),
  });
};

beforeEach(() => {
  mockQuestions.reset();
  mockCreds = [];
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
});

describe('ticket 9759bf5c — the sweeper must not resolve a credential ask on a row that PREDATES it', () => {
  it('REPLAY (oq_d054352c, 2026-10-30T01:37:54Z filed → 01:39:25Z auto-answered): a stored row older than the card leaves the card OPEN for the owner', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    // The DEAD row the ask exists to replace: written days earlier, well-formed
    // for its slot (the live shape — it passes slot validation on its own).
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID, new Date(Date.now() - 9 * 24 * 3600 * 1000));

    const stats = await sweepOwnerGatesOnce();

    // The false green is withheld: nothing was answered, and the refusal is
    // counted so the fleet can see the gate being held rather than stamped.
    expect(stats.credentialGatesResolved).toBe(0);
    expect(stats.credentialGatesDeclined).toBe(1);
    expect(storedRow(q.id).status).toBe('open');
    // Pre-fix this row read: status 'answered', answeredBy 'default', answer
    // "… a slot-validated store row … no new value was pasted".
    expect(storedRow(q.id).answeredBy ?? null).toBeNull();
  });

  it('REPLAY (oq_aacc4a12, 2026-10-21): the SAME shape on the secret half is refused the same way — one fix covers both occurrences', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    seedStoreRow(SECRET_ENV, SECRET_VALUE, new Date(Date.now() - 9 * 24 * 3600 * 1000));

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(0);
    expect(stats.credentialGatesDeclined).toBe(1);
    expect(storedRow(q.id).status).toBe('open');
  });

  it('the healthy control stays healthy: a credential stored AFTER the ask self-heals the gate (action (d) is not disabled)', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID); // default: after the question

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(stats.credentialGatesDeclined).toBe(0);
    const after = storedRow(q.id);
    expect(after.status).toBe('answered');
    expect(after.answeredBy).toBe('default'); // machine provenance, never 'owner'
    expect(String(after.answer)).toContain('auto-heal');
    expect(String(after.answer)).toContain('dated AFTER this card was filed');
  });

  it('the REPAIR path counts as new: a corrupt row overwritten in place after the ask (updatedAt rewritten) lifts', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    // Created before the ask but REPAIRED after — the 7caf07ed recovery shape.
    seedStoreRow(SECRET_ENV, SECRET_VALUE, new Date(Date.now() + 60_000));
    const row = mockCreds[0];
    row.createdAt = new Date(Date.now() - 9 * 24 * 3600 * 1000);

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });

  it('a row with NO readable timestamp never declines — an exotic/legacy row must not wedge a gate shut', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID);
    delete mockCreds[0].updatedAt; // legacy / stub shape: cannot prove anything

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });
});

describe('ticket 9759bf5c — an AWS pair whose halves contradict each other is not evidence', () => {
  it('REPLAY (the live measured shape: AK_len=20, SK_len=20, IDENTICAL): the KEY row passes its own slot check but its sibling holds the same bytes — the gate stays SHUT', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    // Both halves NEWER than the ask, so the predates rule cannot be what
    // saves us here — this is the pair-consistency hole on its own.
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID);
    seedStoreRow(SECRET_ENV, ACCESS_KEY_ID); // the corrupt capture: same 20 bytes

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(0);
    expect(stats.credentialGatesDeclined).toBe(1);
    expect(storedRow(q.id).status).toBe('open');
    // The card is left for the OWNER — nothing was stamped as an answer.
    expect(storedRow(q.id).answeredBy ?? null).toBeNull();
  });

  it('the pair-consistency verdict is reachable from the gate itself (unit shape: declinedBy aws-pair-mismatch)', async () => {
    const prisma: any = {
      runToolReceipt: { findFirst: async () => null },
      codingCredential: {
        findFirst: async ({ where }: any) => mockCreds.find((r) =>
          r.userId === where.userId
          && (typeof where.envKey === 'string' ? r.envKey === where.envKey : r.envKey.startsWith(where.envKey.startsWith))) ?? null,
      },
    };
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID);
    seedStoreRow(SECRET_ENV, ACCESS_KEY_ID);
    const lift = await credentialLifted(prisma, 'u1', KEY_ENV, { notBefore: new Date(Date.now() - 60_000) });
    expect(lift).toEqual({ lifted: false, via: null, declinedBy: 'aws-pair-mismatch' });
  });

  it('a WELL-FORMED pair (20-char key id + 40-char secret) lifts — the check never convicts a healthy credential', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID);
    seedStoreRow(SECRET_ENV, SECRET_VALUE);

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });

  it('a sibling that is itself a wrong-slot capture also convicts (defect 2b): the secret slot holding a 20-char AKIA id', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID);
    // Different bytes, but a known wrong-slot shape in the secret half.
    seedStoreRow(SECRET_ENV, ['AKIA', 'ZZZZZZZZZZ123456'].join(''));

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(0);
    expect(stats.credentialGatesDeclined).toBe(1);
    expect(storedRow(q.id).status).toBe('open');
  });

  it('a non-AWS slot is unaffected: an ordinary api key row still self-heals (no sibling family to compare)', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    seedStoreRow('SCHOOLTIME_API_KEY', 'a'.repeat(40));

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });

  it('a MISSING sibling proves nothing either way — the lone half still lifts (never wedge on absence)', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID); // no secret half stored at all

    const stats = await sweepOwnerGatesOnce();

    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });
});

describe('ticket 9759bf5c — the receipt leg honors the same bar', () => {
  it('a store_secret receipt that predates the ask is not evidence (a NEW-key ask cannot be met by an OLD store)', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    const prisma: any = {
      runToolReceipt: { findFirst: async () => ({ id: 'r-old', createdAt: new Date(Date.now() - 9 * 24 * 3600 * 1000) }) },
      codingCredential: { findFirst: async () => null },
    };
    const lift = await credentialLifted(prisma, 'u1', KEY_ENV, { notBefore: new Date(Date.now() - 60_000) });
    expect(lift).toEqual({ lifted: false, via: null, declinedBy: 'predates-question' });
    // …and the sweeper leaves the card open on it.
    const stats = await sweepOwnerGatesOnce();
    expect(stats.credentialGatesResolved).toBe(0);
    expect(storedRow(q.id).status).toBe('open');
  });

  it('a receipt NEWER than the ask lifts via receipt (unchanged path)', async () => {
    const prisma: any = {
      runToolReceipt: { findFirst: async () => ({ id: 'r-new', createdAt: new Date(Date.now() + 60_000) }) },
      codingCredential: { findFirst: async () => { throw new Error('must not be reached'); } },
    };
    const lift = await credentialLifted(prisma, 'u1', KEY_ENV, { notBefore: new Date(Date.now() - 60_000) });
    expect(lift).toEqual({ lifted: true, via: 'receipt' });
  });
});

describe('ticket 9759bf5c — a withheld false green is OBSERVABLE (review finding F1)', () => {
  const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

  it('a pass whose ONLY outcome is a decline still emits the owner_gate_sweep metric carrying credentialGatesDeclined', async () => {
    const q = await flagCredentialAsk(KEY_ENV);
    seedStoreRow(KEY_ENV, ACCESS_KEY_ID, new Date(Date.now() - 9 * 24 * 3600 * 1000)); // predates → decline
    await sweepOwnerGatesOnce();
    await flush();
    // Pre-F1 the emit gate was `actedTotal > 0`, and a decline is not an "act",
    // so this pass emitted NOTHING — the one signal that proves the fix works
    // (and the post-deploy metric read that closes this ticket) was invisible.
    const row = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0])
      .filter((m: any) => m?.kind === 'owner_gate_sweep').pop();
    expect(row).toBeDefined();
    expect(row.meta.credentialGatesDeclined).toBe(1);
    expect(row.meta.credentialGatesResolved).toBe(0);
    // A decline must never inflate the "acted" value.
    expect(row.value).toBe(0);
    expect(storedRow(q.id).status).toBe('open');
  });
});