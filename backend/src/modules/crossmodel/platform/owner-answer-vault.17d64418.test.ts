/**
 * Ticket 17d64418 finding (b) — the notice-truth corner surviving from the
 * PR #1877 review's finding-2 class, in ONE corner the fix missed.
 *
 * The corner: the declaredPasteValue store guarded
 * `storedKeys.length < OQ_VAULT_MAX_SPANS` OUTSIDE the try with NO unstored
 * naming — when the span loop had already filled the per-answer cap, the
 * paste candidate (which had CLAIMED the declared slot) was silently dropped
 * while the notice read "N credential-shaped values … stored", never naming
 * the drop. The owner's declared-slot credential is gone, the gate for it
 * stays shut, and the notice gives no re-supply instruction — the same
 * silent-drop class the per-value guards at the loop head already fix.
 *
 * The reachable shape (replayed here end-to-end): a SECRET-declared card
 * whose answer carries THREE spans whose labels name the OPPOSITE AWS-pair
 * family (`s3_access_key=` → family key-id, an anti-signal vs the declared
 * secret slot — every span scores 0, none claims the slot) plus paste intent
 * (the whole text is the paste candidate, and it holds no AKIA shape so it
 * is not value-refused). The three spans each store under their own
 * label/ordinal keys — the cap fills to 3 — and the paste leg then hits the
 * cap guard. Pre-fix: dropped, notice silent. Post-fix: NAMED unstored.
 *
 * Runs against the REAL secret-scan + credentials.service (the
 * owner-answer-vault.7caf07ed.test.ts harness pattern).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];
let mockMessages: any[] = [];

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: async () => null, set: async () => true, del: async () => true,
    scan: async () => ({ cursor: 0, keys: [] }),
    mGet: async () => [],
  },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: {
      ...mockQuestions.crossModelMessage,
      findUnique: async ({ where }: any) => mockMessages.find((m) => m.id === where.id) ?? null,
    },
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
      upsert: async ({ where, create, update }: any) => {
        const k = where.userId_envKey_label;
        const row = mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label);
        if (row) { Object.assign(row, update, { updatedAt: new Date() }); return row; }
        const fresh = { id: `cred-${mockCreds.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mockCreds.push(fresh);
        return fresh;
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

import { flagOwnerQuestion, answerOwnerQuestion } from './owner-questions';
import { decryptValue } from '../coding/credentials.service';
import { findSecretSpans } from './secret-scan';

const DECLARED_ENVKEY = 'CANLAW_CPT_S3_SECRET_ACCESS_KEY'; // family: secret

/** Three contradictory-labeled span values — 32-char mixed tokens (NOT
 *  AWS-shaped: the paste candidate must not be value-refused, only
 *  cap-refused, for this corner to be the cap guard and nothing else). The
 *  labels all END in the `access_key_id` compound tail (so secret-scan
 *  captures them as NAMED spans) and name the KEY-ID family — the
 *  anti-signal vs the declared SECRET slot, so no span claims it. */
const SPAN_VALUES = [
  ['Kx9mQ2vLpR7tW4nZb8yC3dH6fJ1sA5', 'eG'].join(''),
  ['Qw7rT4xZb2nM9kPd6hJ3cF8vL5sY1u', 'aD'].join(''),
  ['Zt5bN8kJ2mH7cQ4xV9dL6pR3wS1yF', 'gB'].join(''),
];
const SPAN_LABELS = ['aws_access_key_id', 'backup_access_key_id', 'old_access_key_id'];
const spanAnswer = (labels: string[], values: string[]) => labels.map((l, i) => `${l}=${values[i]}`).join(', ');

const flagCredentialAsk = async (envKey: string) => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: `Please paste the ${envKey} so the lane can sign S3 requests`,
    expectedAnswerType: `credential:${envKey}`,
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

const storedRow = (id: string) => mockQuestions.rows.find((row: any) => row.id === id);

beforeEach(() => {
  mockQuestions.reset();
  mockCreds = [];
  mockMessages = [];
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

describe('ticket 17d64418 (b) — fixture sanity: the corner is reachable', () => {
  it('three access_key_id= spans are captured with key-id-family labels (anti-signal vs the declared SECRET slot), values not AWS-shaped', () => {
    const answer = spanAnswer(SPAN_LABELS, SPAN_VALUES);
    const spans = findSecretSpans(answer);
    expect(spans).toHaveLength(3);
    for (const s of spans) {
      expect(s.label).toMatch(/access_key_id$/); // compound label captured
      expect(s.value).not.toMatch(/^(?:AKIA|ASIA|ABIA|ACCA)/); // no value mismatch
    }
  });
});

describe('ticket 17d64418 (b) — the cap-exhausted paste is NAMED unstored, never silently dropped', () => {
  it('THE PIN: three contradictory-labeled spans fill the cap, the paste candidate that claimed the declared slot is refused by the cap and the notice NAMES it', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = spanAnswer(SPAN_LABELS, SPAN_VALUES);
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner', credentialPaste: true });
    // The declared credential did NOT store (cap-refused paste), so the gate
    // truthfully stays pending — the accepted range is the 7caf07ed posture.
    expect(['ok', 'reply_recorded', 'credential_pending']).toContain(r);
    // The three spans stored under their own label keys — cap = 3.
    expect(mockCreds).toHaveLength(3);
    // The declared key was NOT stored (the paste was cap-refused) — the pin
    // this ticket exists for: the drop is now VISIBLE in the notice.
    expect(mockCreds.some((c) => c.envKey === DECLARED_ENVKEY)).toBe(false);
    const after = storedRow(q.id);
    const answerText = String(after.answer);
    // Notice truth: the warning names the dropped paste and tells the owner
    // to re-supply it (pre-fix: the notice read complete — "3 … stored" —
    // with no warning sentence at all).
    expect(answerText).toContain('WARNING: 1 more credential-shaped value was captured but could NOT be stored');
    expect(answerText).toContain('the pasted value');
    expect(answerText).toContain('Re-supply');
    // ...and the stored-3 claim is still truthful for the three spans.
    expect(answerText).toContain('3 credential-shaped values in this answer were stored');
  });

  it('REGRESSION (the loop-head cap guard is unchanged): a FOURTH span past the cap is still named unstored — the per-value guards keep their shape', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const labels = [...SPAN_LABELS, 'staging_access_key_id'];
    const values = [...SPAN_VALUES, ['Yh3sD8fK6mN2qW7xC5vB9tR4jP1zG', 'uE'].join('')];
    const answer = spanAnswer(labels, values);
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner', credentialPaste: true });
    expect(['ok', 'reply_recorded', 'credential_pending']).toContain(r);
    expect(mockCreds).toHaveLength(3); // cap
    const answerText = String(storedRow(q.id).answer);
    // The 4th span AND the cap-refused paste are BOTH named.
    expect(answerText).toContain('WARNING: 2 more credential-shaped values were captured but could NOT be stored');
    expect(answerText).toContain('the pasted value');
    expect(answerText).toContain('staging_access_key_id');
  });

  it('HEALTHY CONTROL: with cap room (one span), the paste candidate still stores under the DECLARED key — the (b) fix changed only the cap-exhausted corner', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `s3_access_key_1=${SPAN_VALUES[0]}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner', credentialPaste: true });
    expect(r).toBe('ok');
    // Both stored: the span under its label key, the whole-paste under the
    // DECLARED slot (the paste claimed it — no span fit).
    const row = mockCreds.find((c) => c.envKey === DECLARED_ENVKEY && !c.label);
    expect(row).toBeTruthy();
    expect(decryptValue(row.valueEnc)).toBe(answer); // the whole text, byte-identical
    const answerText = String(storedRow(q.id).answer);
    expect(answerText).toContain(`$${DECLARED_ENVKEY}`);
    expect(answerText).not.toContain('WARNING'); // nothing was dropped
  });

  it('HEALTHY CONTROL (pair shape): the ordinary two-value AWS pair paste on a SECRET-declared card still vaults the SECRET half under the declared key (7caf07ed regression)', async () => {
    const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
    const SECRET_VALUE = '/' + ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `x_access_key=${ACCESS_KEY_ID}, x_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner', credentialPaste: true });
    expect(r).toBe('ok');
    const row = mockCreds.find((c) => c.envKey === DECLARED_ENVKEY && !c.label);
    expect(row).toBeTruthy();
    expect(decryptValue(row.valueEnc)).toBe(SECRET_VALUE);
    expect(decryptValue(row.valueEnc)).toHaveLength(40);
  });
});
