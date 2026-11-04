/**
 * Tickets 7caf07ed + c54074df (companion replay — filed by two lanes on the same
 * defect; this suite is the shared acceptance replay) — the owner-card answer →
 * vault path captured the WRONG credential span and stored it under the declared
 * gate key.
 *
 * THE LIVE INCIDENT (measured, masked — lane ed76d326 probes, 2026-10-21):
 *  - oq_6a08615e (expectedAnswerType credential:CANLAW_CPT_S3_SECRET_ACCESS_KEY,
 *    answered 18:25Z): the answer carried BOTH halves of the AWS pair
 *    (`…_access_key=<20-char AKIA id>, …_secret_access_key=<40-char secret>`).
 *    The vault stored the 20-char AKIA ID under CANLAW_CPT_S3_SECRET_ACCESS_KEY
 *    (activity row: via=owner_answer_vault, spans=1 — only the AKIA was span-
 *    matched) — measured from a fresh shell: SECRET_LEN=20, AKIA-shaped,
 *    byte-equal to the KEY row (sha8-identical). The 40-char secret half was
 *    never vaulted and is unrecoverable (the stored answer is redacted at rest).
 *  - Root cause (this suite replays it end-to-end): vaultOwnerAnswerSecrets
 *    routes candidates[0] — the FIRST span — to the DECLARED envKey purely by
 *    position. redactImpl pushes provider-pattern spans (the AKIA 'AWS access
 *    key') BEFORE named-compound spans, so on the standard two-value paste the
 *    KEY ID is candidates[0] and takes the SECRET slot. No slot-shape validation
 *    guards the declared key (valueSlotMismatch is Cloudflare-only).
 *
 * SIGNATURES 1-2 (the 39-char first-char drop on the manual paste path) are NOT
 * server-side: probes + an end-to-end seam map show every layer byte-faithful
 * (capture charset, vaultCandidateValue, upsertCredential, AES-GCM, shell
 * injection) for leading-char classes {/, +, A, a}. The byte-fidelity test below
 * PINS that server property: whatever string reaches the REST boundary is stored
 * byte-identical — the truncation class is browser/clipboard-side and must never
 * be "fixed" by a server-side transform that would mask it.
 *
 * Runs against the REAL secret-scan + credentials.service (the
 * owner-answer-vault.ca0b57cd.test.ts harness pattern — only config/database and
 * the wake boundaries are mocked; the ownerQuestion table is the shared
 * owner-questions.testkit).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];
let mockMessages: any[] = [];
// Upsert CALL LOG (review finding 8, strengthened so the pin can FAIL): records
// every codingCredential.upsert the vault path issues, so "the sibling row was
// never written" is asserted against CALLS, not just row state (a same-value
// rewrite is invisible in row state).
let mockUpsertCalls: Array<{ envKey: string; label: string }> = [];

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
    activity: { create: async ({ data }: any) => data },
    // owner-gate-sweeper action (a) scans blocked todos/goals — none exist in
    // this suite; action (d)'s row probe is what the sweeper tests exercise.
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
import { decryptValue, encryptValue } from '../coding/credentials.service';
import { findSecretSpans } from './secret-scan';
import { sweepOwnerGatesOnce } from './owner-gate-sweeper';

/** Fake AWS pair, assembled from parts so no credential-shaped literal sits
 *  contiguous in source (the ad4fae90/ca0b57cd fixture convention). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_BODY = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const SECRET_VALUE = `/${SECRET_BODY}`; // leading '/' — base64 alphabet, the shape that
// must never be treated as a path reference (ca0b57cd pass-1) nor trimmed server-side
const SECRET_KEY_ENV = 'CANLAW_CPT_S3_SECRET_ACCESS_KEY';

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
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

describe('ticket 7caf07ed / c54074df — signature 3: the wrong span takes the declared secret key', () => {
  it('REPLAY (the oq_6a08615e incident): a two-value AWS paste on a SECRET-declared card vaults the SECRET under the declared key — never the key ID', async () => {
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const answer = `x_access_key=${ACCESS_KEY_ID}, x_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner' });
    expect(r).toBe('ok');
    // The declared SECRET slot must hold the 40-char secret, byte-identical.
    const v = vaultedValue(SECRET_KEY_ENV);
    expect(v).toBe(SECRET_VALUE);
    expect(v).not.toBe(ACCESS_KEY_ID);
    expect(v).toHaveLength(40);
    // The key ID must not be silently dropped either — it vaults under its own
    // (label-derived / ordinal) key, never under the declared secret key.
    expect(mockCreds.some((c) => !c.label && c.envKey !== SECRET_KEY_ENV && decryptValue(c.valueEnc) === ACCESS_KEY_ID)).toBe(true);
    // Neither value rides the stored row.
    const after = storedRow(q.id);
    expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
  });

  it('REPLAY (span order): the AKIA provider span is pushed BEFORE the named-compound secret span — the positional first-span rule is what routes the wrong value', () => {
    const answer = `x_access_key=${ACCESS_KEY_ID}, x_secret_access_key=${SECRET_VALUE}`;
    const spans = findSecretSpans(answer);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ name: 'AWS access key', value: ACCESS_KEY_ID });
    expect(spans[1]).toMatchObject({ name: 'Named credential assignment', value: SECRET_VALUE, label: 'x_secret_access_key' });
  });

  it('REPLAY (the bare-akia variant, the exact 18:25Z spans=1 shape): an answer carrying ONLY the key ID on a SECRET-declared card must not mint it as the secret', async () => {
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', `the secret is ${ACCESS_KEY_ID}`, { answeredBy: 'owner' });
    expect(['ok', 'reply_recorded']).toContain(r);
    // An AWS access-key ID in a SECRET_ACCESS_KEY slot is a slot mismatch —
    // never stored there (the valueSlotMismatch class, extended to AWS pairs).
    // Strengthened (review finding 8): a bare `!==` passes when NOTHING was
    // stored — the pin must also prove the declared slot was never WRITTEN.
    expect(vaultedValue(SECRET_KEY_ENV)).not.toBe(ACCESS_KEY_ID);
    expect(mockUpsertCalls.filter((c) => c.envKey === SECRET_KEY_ENV && !c.label)).toHaveLength(0);
  });

  it('the healthy control stays healthy: a single-value paste on a KEY-declared card vaults the key ID under the declared key (oq_b90df03d, 17:42Z)', async () => {
    const q = await flagCredentialAsk('CANLAW_CPT_S3_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', `here it is: ${ACCESS_KEY_ID}`, { answeredBy: 'owner' });
    expect(r).toBe('ok');
    expect(vaultedValue('CANLAW_CPT_S3_KEY')).toBe(ACCESS_KEY_ID);
  });
});

describe('ticket 7caf07ed / c54074df — paste intent: the card\'s dedicated secret input says "this whole text IS the key"', () => {
  it('a credentialPaste single-value answer (no span matches a bare 40-char secret) vaults byte-identical under the declared key', async () => {
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', SECRET_VALUE, { answeredBy: 'owner', credentialPaste: true });
    expect(r).toBe('ok');
    const v = vaultedValue(SECRET_KEY_ENV);
    expect(v).toBe(SECRET_VALUE);
    expect(v).toHaveLength(40);
  });

  it('REGRESSION GUARD (signature-3 interplay): with credentialPaste intent AND a span present, the whole-paste leg must not be silently overridden by the span scan — the declared key never receives a DIFFERENT credential\'s value', async () => {
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    // The owner pasted BOTH halves into the secret input (the incident shape).
    const answer = `x_access_key=${ACCESS_KEY_ID}, x_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner', credentialPaste: true });
    expect(r).toBe('ok');
    expect(vaultedValue(SECRET_KEY_ENV)).not.toBe(ACCESS_KEY_ID);
    // Strengthened (review finding 8): the title's claim is that the SECRET
    // half wins the declared slot — pin it positively, not just "not the ID".
    expect(vaultedValue(SECRET_KEY_ENV)).toBe(SECRET_VALUE);
    expect(vaultedValue(SECRET_KEY_ENV)).toHaveLength(40);
  });
});

describe('ticket 7caf07ed / c54074df — signatures 1-2: server-side byte fidelity (the 39-char drop is client-side, and must STAY detectable)', () => {
  const leadingChars = ['/', '+', 'A', 'a'];
  for (const ch of leadingChars) {
    it(`a ${ch}-leading 40-char secret pasted via the card input stores byte-identical (len 40, first char ${ch === '/' || ch === '+' ? 'base64 symbol' : ch})`, async () => {
      const secret = ch + SECRET_BODY.slice(0, 39);
      expect(secret).toHaveLength(40);
      const q = await flagCredentialAsk(SECRET_KEY_ENV);
      const r = await answerOwnerQuestion(q.id, 'u1', secret, { answeredBy: 'owner', credentialPaste: true });
      expect(r).toBe('ok');
      const v = vaultedValue(SECRET_KEY_ENV);
      expect(v).toBe(secret);
      expect(v).toHaveLength(40);
    });
  }

  it('NO server-side transform may "repair" a 39-char input: if 39 chars arrive, 39 chars are stored (the truncation class stays attributable to the client)', async () => {
    const thirtyNine = SECRET_BODY.slice(0, 39); // no leading slash — plain 39 chars
    expect(thirtyNine).toHaveLength(39);
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', thirtyNine, { answeredBy: 'owner', credentialPaste: true });
    expect(r).toBe('ok');
    expect(vaultedValue(SECRET_KEY_ENV)).toBe(thirtyNine);
    expect(vaultedValue(SECRET_KEY_ENV)).toHaveLength(39);
  });
});

describe('ticket 7caf07ed / c54074df — the sweeper class (f871fa83 forensics): owner-gate-sweeper action (d) must not resolve a credential gate on a CORRUPT store row', () => {
  const seedStoreRow = (value: string, updatedAt: Date) => {
    mockCreds.push({
      id: `cred-seed-${mockCreds.length + 1}`, createdAt: updatedAt, updatedAt,
      userId: 'u1', provider: 'custom', envKey: SECRET_KEY_ENV, label: '',
      valueEnc: encryptValue(value),
    });
  };

  it('REPLAY (the stale-corrupt-row shape, the 18:25Z capture): a *_SECRET_ACCESS_KEY store row holding the 20-char AKIA key ID must NOT self-heal an open gate — the card stays open for the owner', async () => {
    // The exact corrupt row the incident measured: the key ID sitting in the
    // SECRET slot (len 20, AKIA-shaped, byte-equal to the KEY row). The
    // sweeper (owner-gate-sweeper.ts action (d), 2026-10-21 forensics) lifts
    // on the ROW's EXISTENCE via credentialLifted's startsWith check — no
    // value inspection — and would stamp "credential … stored (gate lifted
    // via the stored credential)" as the OWNER's answer on a card whose
    // credential is corrupt (fabricating a paste that never happened).
    seedStoreRow(ACCESS_KEY_ID, new Date('2026-10-21T18:25:00.309Z'));
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const stats = await sweepOwnerGatesOnce();
    expect(stats.credentialGatesResolved).toBe(0);
    expect(storedRow(q.id).status).toBe('open');
  });

  it('the healthy control stays healthy: a store row holding a REAL 40-char secret self-heals the open gate (action (d) keeps working)', async () => {
    // Ticket 9759bf5c: the row must be NEWER than the card, which is what
    // "the key actually landed after you asked for it" MEANS. Pre-fix this
    // seeded the 18:25Z incident timestamp and lifted anyway — that acceptance
    // of any older row IS the false green the ticket reports (it auto-answered
    // oq_d054352c 91 s after filing on a row the ask existed to REPLACE). The
    // control's subject is the VALUE shape (a real 40-char secret), so anchor
    // it after the question and leave the date rule to the replay suite.
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    seedStoreRow(SECRET_VALUE, new Date(Date.now() + 60_000));
    const stats = await sweepOwnerGatesOnce();
    expect(stats.credentialGatesResolved).toBe(1);
    expect(storedRow(q.id).status).toBe('answered');
  });

  it('PIN (the minting side of the 18:25Z spans=1 shape): a bare AKIA id in prose IS a secret-scan span — the corrupt row above is reachable, so slot-shape validation is the only guard class', () => {
    const spans = findSecretSpans(`the secret is ${ACCESS_KEY_ID}`);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: 'AWS access key', value: ACCESS_KEY_ID });
  });
});

// ── Review-bar addenda (lane f6fe262c, 2026-10-21) — the two failure shapes the
// incident's aftermath makes load-bearing: the owner's next paste must repair
// the live corrupt row, and a mismatched value must never corrupt the sibling. ──
describe('ticket 7caf07ed / c54074df — recovery overwrite + no cross-corruption (review addenda)', () => {
  const seedStoreRow = (envKey: string, value: string) => {
    mockCreds.push({
      id: `cred-seed-${mockCreds.length + 1}`, createdAt: new Date(), updatedAt: new Date(),
      userId: 'u1', provider: 'custom', envKey, label: '',
      valueEnc: encryptValue(value),
    });
  };

  it('ADDENDUM A (recovery overwrite): the owner\'s next two-value paste on the card OVERWRITES the live corrupt row byte-identical — no skip-on-existing, no preserve-old-value', async () => {
    // The live prod shape: the SECRET slot holds the corrupt 20-char key ID
    // (written 18:25Z). Post-deploy, the owner re-pastes the pair on the card.
    seedStoreRow(SECRET_KEY_ENV, ACCESS_KEY_ID);
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const answer = `x_access_key=${ACCESS_KEY_ID}, x_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer, { answeredBy: 'owner' });
    expect(r).toBe('ok');
    const rows = mockCreds.filter((c) => c.envKey === SECRET_KEY_ENV && !c.label);
    expect(rows).toHaveLength(1); // upserted in place — never a second row
    expect(vaultedValue(SECRET_KEY_ENV)).toBe(SECRET_VALUE);
    expect(vaultedValue(SECRET_KEY_ENV)).toHaveLength(40);
    expect(vaultedValue(SECRET_KEY_ENV)).not.toBe(ACCESS_KEY_ID);
  });

  it('ADDENDUM B (no cross-corruption): on the bare-akia refusal shape the mismatched value never lands on the healthy sibling KEY row either — nothing new is written', async () => {
    seedStoreRow('CANLAW_CPT_S3_KEY', ACCESS_KEY_ID); // the healthy sibling
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', `the secret is ${ACCESS_KEY_ID}`, { answeredBy: 'owner' });
    expect(['ok', 'reply_recorded', 'credential_pending']).toContain(r);
    // The mismatched key-ID span was refused for the declared SECRET slot — and
    // it must NOT be re-routed onto the sibling KEY row (a wrong-slot capture is
    // never "helpfully" filed elsewhere), and must not duplicate the row.
    const keyRows = mockCreds.filter((c) => c.envKey === 'CANLAW_CPT_S3_KEY' && !c.label);
    expect(keyRows).toHaveLength(1);
    expect(vaultedValue('CANLAW_CPT_S3_KEY')).toBe(ACCESS_KEY_ID); // untouched, single row
    expect(vaultedValue(SECRET_KEY_ENV)).not.toBe(ACCESS_KEY_ID); // never minted as the secret
    // Strengthened (review finding 8): row state cannot see a same-value
    // REWRITE of the sibling — the pin must hold on the upsert CALL log too:
    // the vault path never issues ANY store against the sibling KEY slot.
    expect(mockUpsertCalls.filter((c) => c.envKey === 'CANLAW_CPT_S3_KEY')).toHaveLength(0);
  });

  it('ADDENDUM C (sweeper provenance): the auto-heal resolve is stamped as a MACHINE answer, never the owner\'s', async () => {
    // Ticket 9759bf5c: seed AFTER the card so the row is genuinely newer than
    // the ask — "the healthy row landed, so the arm acts" is this test's
    // subject. The pre-fix order (seed, then flag) only passed because ANY
    // existing row lifted, which is the false green the ticket reports.
    const q = await flagCredentialAsk(SECRET_KEY_ENV);
    seedStoreRow(SECRET_KEY_ENV, SECRET_VALUE); // healthy row — the arm must act
    mockCreds[0].updatedAt = new Date(Date.now() + 60_000);
    const stats = await sweepOwnerGatesOnce();
    expect(stats.credentialGatesResolved).toBe(1);
    const after = storedRow(q.id);
    expect(after.status).toBe('answered');
    expect(after.answeredBy).toBe('default'); // truthful provenance — not 'owner'
    expect(String(after.answer)).toContain('auto-heal');
    expect(String(after.answer)).not.toMatch(/credential [A-Z0-9_]+ stored \(gate lifted/);
  });

  it('ADDENDUM D (the Account→Coding surface gets the same guard): upsertCredential refuses an AKIA key ID into a SECRET slot and a 40-char secret into a KEY-ID slot — the shared bottom layer', async () => {
    const { upsertCredential } = require('../coding/credentials.service');
    await expect(upsertCredential('u1', 'custom', SECRET_KEY_ENV, ACCESS_KEY_ID, '')).rejects.toThrow(/ACCESS KEY ID/);
    await expect(upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_ACCESS_KEY_ID', SECRET_VALUE, '')).rejects.toThrow(/SECRET ACCESS KEY/);
    // Byte-fidelity control: the correct pair still stores verbatim.
    const ok1 = await upsertCredential('u1', 'custom', SECRET_KEY_ENV, SECRET_VALUE, '');
    expect(ok1.envKey).toBe(SECRET_KEY_ENV);
    const ok2 = await upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_KEY', ACCESS_KEY_ID, '');
    expect(ok2.envKey).toBe('CANLAW_CPT_S3_KEY');
  });
});
