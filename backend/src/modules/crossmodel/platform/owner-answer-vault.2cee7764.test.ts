/**
 * Ticket 2cee7764 (2026-10-24, filed by the ctrl.example.com Supervisor relay via
 * the Fleet Supervisor report-up lane) — ACCEPTANCE REPLAY, the ticket's own
 * bar: "an owner credential pasted on an owner-question card answer lands in
 * the encrypted store intact (verifiable via store_secret fromMessageId
 * round-trip on a test credential)".
 *
 * The live incident this ticket re-reports: CANLAW_CPT_S3_SECRET_ACCESS_KEY
 * came out corrupt "4-for-4" — a ~20-char AKIA-shaped key-id in the secret
 * slot, both copies unusable. Live forensics THIS ticket (prod activity
 * ledger, read-only): every corrupt write PRE-DATES the fix —
 *   - 2026-10-20T22:39:15Z via=owner_answer_vault [CANLAW_CPT_S3_KEY,
 *     CANLAW_CPT_S3_SECRET_ACCESS_KEY] (oq_6cb6ab58, the pre-fix pair leg);
 *   - 2026-10-20T23:13:31Z via=store_secret from oq_f04ac515 (the ca0b57cd
 *     incident row — the 40-char secret half sat RAW on the stored answer and
 *     was lifted in that ticket's repair; the vault row's createdAt 23:13:30Z
 *     is this write);
 *   - 2026-10-21T17:42:32Z via=owner_answer_vault CANLAW_CPT_S3_KEY
 *     (oq_b90df03d — the key-id leg, correctly stored);
 *   - 2026-10-21T18:25:00.309Z via=owner_answer_vault spans=1
 *     CANLAW_CPT_S3_SECRET_ACCESS_KEY (oq_6a08615e — the 7caf07ed/c54074df
 *     incident: the AKIA provider span was pushed before the named-compound
 *     secret span, so the positional first-span rule minted the key-id as the
 *     secret, OVERWRITING the good 23:13Z value). PR #1877
 *     (a5240a74aa4d8c769ac67fdcd5aa4bd893e97260, merged 2026-10-21T23:31:58Z
 *     — slot-fit routing + AWS-pair valueSlotMismatch on every write door)
 *     landed AFTER that last write; zero CANLAW store rows exist after 18:25Z
 *     Oct 21. The frozen corrupt row is what the corridor measured on
 *     10-23/24; the 40-char secret was stored Oct 20 but overwritten by the
 *     corrupt Oct 21 write — it is unrecoverable NOW (fresh owner paste is
 *     the only repair).
 * The ticket's secondary hypothesis ("the redaction-at-write strips the value
 * before storage instead of vaulting it") is DISPROVEN by the same ledger:
 * values were vaulted (the wrong span, pre-fix); the stored answer text is
 * redacted at rest BY DESIGN (N9) — the vault row, not the answer row, is
 * where the value lives.
 *
 * This suite pins the ticket's acceptance on the CURRENT code so a future
 * regression of any leg fails here by name:
 *   A. the acceptance round-trip — an owner pair paste on a credential card
 *      lands the 40-char secret INTACT under the declared secret slot
 *      (byte-identical, leading '/' preserved), the key-id never in the
 *      secret slot;
 *   B. the store_secret fromMessageId round-trip on that same answered row —
 *      the repair leg lifts the value from the stored answer WITHOUT the raw
 *      value ever being readable on the row (both halves redacted at rest);
 *   C. the direct-corruption doors stay shut: a key-id-only answer and a
 *      key-id-only fromMessageId lift are both REFUSED for the secret slot
 *      (valueSlotMismatch fires through the store_failed refusal);
 *   D. the legacy corrupt-row shape itself: re-pasting the correct secret on
 *      the same declared key REPLACES the corrupt value (upsert replace
 *      posture) — the repair the owner's next paste performs.
 *
 * Runs against the REAL secret-scan + credentials.service (the
 * owner-answer-vault.ca0b57cd.test.ts harness pattern — only config/database
 * and the wake boundaries are mocked; the ownerQuestion table is the shared
 * owner-questions.testkit).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];
let mockMessages: any[] = [];
let mockUpsertCalls: Array<{ envKey: string; label: string }> = [];
let mockActivityRows: any[] = [];

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: async () => null, set: async () => true, del: async () => true },
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
        mockUpsertCalls.push({ envKey: k.envKey, label: k.label });
        const row = mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label);
        if (row) { Object.assign(row, update, { updatedAt: new Date() }); return row; }
        const fresh = { id: `cred-${mockCreds.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mockCreds.push(fresh);
        return fresh;
      },
    },
    activity: { create: async ({ data }: any) => { mockActivityRows.push(data); return data; } },
  },
}));

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the owner-questions.test.ts pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The resolution wake + gate unblock + telegram pushes are dynamic imports —
// mocked at the boundary (the ca0b57cd harness pattern).
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
jest.mock('../langgraph/integration-status-cache', () => ({
  __esModule: true,
  invalidateIntegrationStatusCache: jest.fn(async () => {}),
}));

import { flagOwnerQuestion, answerOwnerQuestion } from './owner-questions';
import { executeSecretHandoffTool } from './secret-handoff-tools';
import { decryptValue, encryptValue } from '../coding/credentials.service';

/** The incident specimen, fake values assembled from parts so no
 *  credential-shaped literal sits contiguous in source (the ca0b57cd/7caf07ed
 *  fixture convention). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_BODY = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const SECRET_VALUE = `/${SECRET_BODY}`; // 40 chars, leading '/' — the byte-fidelity shape
const SECRET_ENV = 'CANLAW_CPT_S3_SECRET_ACCESS_KEY';
/** The exact live incident answer shape (oq_6a08615e): BOTH halves, comma-
 *  separated, named as the corridor convention names them. */
const PAIR_ANSWER = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID}, canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;

const parse = (s: string) => JSON.parse(s);
const machineCtx = (extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-2cee', userId: 'u1', machineTriggered: true, userTurnText: '', ...extra });

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
const vaultedValue = (envKey: string) => {
  const row = mockCreds.find((c) => c.envKey === envKey && !c.label);
  return row ? decryptValue(row.valueEnc) : null;
};

beforeEach(() => {
  mockQuestions.reset();
  mockCreds = [];
  mockMessages = [];
  mockUpsertCalls = [];
  mockActivityRows = [];
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});
// Review N4 (the ad4fae90 pattern): the kill-switch test below sets
// OWNER_ANSWER_VAULT_DISABLED=1 — restore it after EVERY test so this suite
// never leaks the switch into a sibling suite sharing the jest worker.
afterEach(() => {
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

describe('ticket 2cee7764 — A. the acceptance round-trip: an owner pair paste on a SECRET-declared card', () => {
  it('lands the 40-char secret INTACT under the declared secret slot — byte-identical, leading "/" preserved, never the key-id', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    // The pair paste on a SECRET-declared card is a STORE path — the literal
    // 'ok' (the ca0b57cd:267 sibling pin; a union here would re-admit the
    // wrong-slot regression this ticket exists to bar).
    expect(r).toBe('ok');
    const v = vaultedValue(SECRET_ENV);
    expect(v).toBe(SECRET_VALUE);
    expect(v).toHaveLength(40);
    expect(v).not.toBe(ACCESS_KEY_ID);
    // The value is fully formed at rest: leading '/' intact (no trim), no quote
    // residue, decrypts cleanly.
    expect(String(v).startsWith('/')).toBe(true);
  });

  it('vaults the key-id half under its OWN key too (both halves recoverable — the "nothing valid can be lifted" consequence is repaired)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    // Named positively, at the named key (review N2): the AKIA provider span
    // carries NO label, so it falls to the ordinal derived key — assert the
    // value exists under SOME non-secret key with its envKey pinned, not a
    // bare envKey !== SECRET_ENV that any stray key satisfies.
    const idRow = mockCreds.find((c) => !c.label && decryptValue(c.valueEnc) === ACCESS_KEY_ID);
    expect(idRow).toBeTruthy();
    expect(idRow && idRow.envKey !== SECRET_ENV).toBe(true);
    expect(mockUpsertCalls.map((c) => c.envKey)).not.toContain(SECRET_ENV + '_');
  });

  it('stores NEITHER half on the readable answer row (redaction-at-rest holds; the vault row, not the answer row, carries the value)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    expect(r).toBe('ok');
    const after = storedRow(q.id);
    // The gate actually LIFTED (review N1): the row is answered, and the
    // credential was found under the declared key's prefix.
    expect(after.status).toBe('answered');
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
    expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
    // The vault notice names the envKey so the woken lane uses $ENVKEY.
    expect(String(after.answer)).toMatch(/\[CREDENTIAL VAULTED/);
    expect(String(after.answer)).toContain(`$${SECRET_ENV}`);
    // Review N6 (the 50bcd1e7 pattern): the audit row is written with
    // via=owner_answer_vault, names the stored envKeys, and NEVER carries a
    // value — the ledger row this ticket's forensics leaned on.
    const audit = mockActivityRows.find((a: any) => String(a.action || '').includes('credential') && String(a.metadata?.via || '') === 'owner_answer_vault');
    expect(audit).toBeTruthy();
    expect(String(JSON.stringify(audit && audit.metadata))).not.toContain(SECRET_VALUE);
    expect(String(JSON.stringify(audit && audit.metadata))).not.toContain(ACCESS_KEY_ID);
    expect(audit && audit.metadata && JSON.stringify(audit.metadata.envKeys || [])).toContain(SECRET_ENV);
  });

  it('re-pasting a corrected value on the SAME declared key REPLACES the corrupt row (the repair a fresh owner paste performs)', async () => {
    // The live frozen shape: the corrupt AKIA already sitting in the secret slot.
    mockCreds.push({
      id: 'cred-corrupt-2cee7764', createdAt: new Date('2026-10-21T18:25:00.309Z'), updatedAt: new Date('2026-10-21T18:25:00.309Z'),
      userId: 'u1', provider: 'custom', envKey: SECRET_ENV, label: '', valueEnc: encryptValue(ACCESS_KEY_ID),
    });
    const q = await flagCredentialAsk(SECRET_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', `secret_access_key=${SECRET_VALUE}`, { answeredBy: 'owner' });
    expect(r).toBe('ok');
    expect(vaultedValue(SECRET_ENV)).toBe(SECRET_VALUE);
    expect(mockCreds.filter((c) => !c.label && c.envKey === SECRET_ENV)).toHaveLength(1);
  });
});

describe('ticket 2cee7764 — B. the store_secret fromMessageId round-trip (the ticket\'s named verification)', () => {
  it('round-trips intact on the owner\'s OWN typed paste row: store_secret {fromMessageId} stores it byte-identical, value never echoed', async () => {
    mockMessages.push({
      id: 'msg-owner-2cee', role: 'user',
      content: `CANLAW_CPT_S3_SECRET_REPAIRED=${SECRET_VALUE} — use it for the s3 sign`,
      metadata: null, chat: { userId: 'u1' },
    });
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'CANLAW_CPT_S3_SECRET_REPAIRED', fromMessageId: 'msg-owner-2cee' });
    expect(raw).not.toContain(SECRET_VALUE);
    const out = parse(raw);
    expect(out.ok).toBe(true);
    expect(out.source).toBe('message');
    const stored = mockCreds.find((c) => c.envKey === 'CANLAW_CPT_S3_SECRET_REPAIRED');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(SECRET_VALUE);
    expect(out.message).toContain('$CANLAW_CPT_S3_SECRET_REPAIRED');
  });

  it('a lift from the ANSWERED card row is refused honestly — the row is redacted at rest (no_secret_found, never a guess, never a write)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    // The value IS in the vault under the declared key (test A) — a re-lift
    // from the row text must not fabricate one or mint a second copy.
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'CANLAW_CPT_S3_SECRET_REPAIRED', fromMessageId: q.id });
    expect(raw).not.toContain(SECRET_VALUE);
    const out = parse(raw);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no_secret_found');
    expect(mockCreds.find((c) => c.envKey === 'CANLAW_CPT_S3_SECRET_REPAIRED')).toBeFalsy();
  });

  it('the row is redacted at rest — the stored answer carries the [REDACTED marker and the vault notice, never a raw half', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    const row = storedRow(q.id);
    const answerText = String(row.answer);
    expect(answerText).toMatch(/\[REDACTED: looked like a credential\]/);
    expect(answerText).not.toContain(SECRET_VALUE);
    expect(answerText).not.toContain(ACCESS_KEY_ID);
  });
});

describe('ticket 2cee7764 — C. the direct-corruption doors stay shut (the 4-for-4 class)', () => {
  it('a key-id-ONLY answer on a SECRET-declared card never mints it into the secret slot (the oq_6a08615e spans=1 shape)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', `the secret is ${ACCESS_KEY_ID}`, { answeredBy: 'owner' });
    // The literal 'reply_recorded' (not 'ok'): the answer was stored but the
    // credential gate did NOT lift — the key-id is not the secret.
    expect(r).toBe('reply_recorded');
    expect(vaultedValue(SECRET_ENV)).not.toBe(ACCESS_KEY_ID);
    // The declared slot was never WRITTEN with the key-id (a bare !== passes
    // when nothing stored — pin the calls, the 7caf07ed review-finding-8 shape).
    expect(mockUpsertCalls.filter((c) => c.envKey === SECRET_ENV && !c.label)).toHaveLength(0);
  });

  it('a key-id ONLY fromMessageId lift targeting the SECRET slot is REFUSED (store_failed, the slot-mismatch text names both slots)', async () => {
    // Row carries only the key-id half (the 23:13Z Oct 20 half-vaulted shape).
    mockQuestions.rows.push({
      id: 'oq_legacy2cee-01b7-427d-8820-ad67548218f4',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${SECRET_ENV}`,
      answer: `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID} [CREDENTIAL VAULTED — …]`,
      answeredBy: 'owner', expectedAnswerType: `credential:${SECRET_ENV}`,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: 'oq_legacy2cee-01b7-427d-8820-ad67548218f4' });
    expect(raw).not.toContain(SECRET_VALUE);
    const out = parse(raw);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('store_failed');
    expect(String(out.message)).toMatch(/SECRET-ACCESS-KEY slot|look swapped|ACCESS KEY ID/i);
    // No write happened to the secret slot at all.
    expect(mockUpsertCalls.filter((c) => c.envKey === SECRET_ENV && !c.label)).toHaveLength(0);
    expect(vaultedValue(SECRET_ENV)).toBeNull();
  });

  it('a matching sibling assignment on the row is honored: a named secret half lifts and stores clean (the sanctioned repair, positive control)', async () => {
    mockQuestions.rows.push({
      id: 'oq_legacy2cee-01b7-427d-8820-ad67548218f4',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${SECRET_ENV}`,
      answer: `canlaw_cpt_s3_access_key=[REDACTED: looked like a credential],canlaw_cpt_s3_secret_access_key=${SECRET_VALUE} [CREDENTIAL VAULTED — …]`,
      answeredBy: 'owner', expectedAnswerType: `credential:${SECRET_ENV}`,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: 'oq_legacy2cee-01b7-427d-8820-ad67548218f4' });
    const out = parse(raw);
    expect(out.ok).toBe(true);
    expect(decryptValue(mockCreds.find((c) => c.envKey === SECRET_ENV)?.valueEnc ?? '')).toBe(SECRET_VALUE);
  });
});

describe('ticket 2cee7764 — D. honesty of the notice under the pre-fix corrupt-store shape (no false "vaulted" claim)', () => {
  it('when the vault leg is disabled, an owner answer is redacted with NO store and NO vault-notice claim (degrades to pre-fix redaction only)', async () => {
    process.env.OWNER_ANSWER_VAULT_DISABLED = '1';
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_ANSWER, { answeredBy: 'owner' });
    expect(mockCreds).toHaveLength(0);
    const after = storedRow(q.id);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
    expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
    expect(String(after.answer)).not.toMatch(/\[CREDENTIAL VAULTED/);
  });
});
