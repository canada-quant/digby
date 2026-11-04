/**
 * Ticket 365588cf — 2026-10-30 — ACCEPTANCE REPLAY.
 *
 * THE INCIDENT (measured): the owner pasted a whole AWS access-key PAIR into an
 * owner card's free-text reply box — the card was `expectedAnswerType: 'choice'`
 * (or a credential card whose answer came by reply), so there was NO key field
 * for the value to land in. TWO independent defects followed:
 *
 *  (a) CAPTURE — `owner-questions.ts vaultOwnerAnswerSecrets` → the shared
 *      scanner `findSecretSpans` could not see the 40-char secret half:
 *      SECRET_PATTERNS knows the 20-char key id (`AKIA…`) and NOTHING for a
 *      bare AWS secret access key. Probe (this session):
 *        findSecretSpans(`Access key\nAKIA…\nSecret access key\n<40-char>\nHide`)
 *          → [ { name: 'AWS access key', len: 20 } ]      (only the key id)
 *        extractSecretForHandoff(<stored note with the secret>, 'CANLAW_…_SECRET_ACCESS_KEY')
 *          → { ok: false, reason: 'none' }
 *      So the pair vaulted its key ID and the secret was DESTROYED — redacted
 *      away in the answer row, never vaulted.
 *
 *  (b) HONEST MISS — `store_secret {fromMessageId: <oq id>}` reads ONLY the
 *      resolving `ownerQuestion.answer`. When that holds no liftable value (it
 *      had been redacted / notice-stamped) the tool answered a bare
 *      `no_secret_found` with no hint that the vault may ALREADY hold the
 *      paste — a dead end that forces the owner into a re-paste loop for a
 *      credential the vault already has.
 *
 * WHAT THIS SUITE PINS
 *   T1 capture on a CREDENTIAL card: the secret half lands INTACT (40 chars,
 *      byte-identical, leading '/' preserved) under the declared slot, and the
 *      key ID never takes that slot.
 *   T2 capture on an UNGATED `choice` card: the secret span is still captured
 *      (routed to an OWNER_ANSWER_* key) instead of being silently dropped.
 *   T3 the honest miss: after T1's capture, `store_secret` on the oq id names
 *      the vaulted envKey (the positive pointer) instead of dead-ending.
 *   T4 detector-adjacent regressions: the app-password context-gated shape
 *      still fires and still stays out of the commit gate, and a 40-char pure
 *      hex sha1 beside an AWS cue is NOT captured (the value-shape guard).
 *
 * Harness: the owner-answer-vault.2cee7764.test.ts pattern — the REAL
 * secret-scan + credentials.service, mocked config/database (the shared
 * owner-questions.testkit ownerQuestion table) and the wake boundaries.
 * EVERY value is FAKE, assembled from string parts so no credential-shaped
 * literal sits contiguous in source (the ca0b57cd / 7caf07ed convention).
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
    // Ticket 365588cf (2b): the honest-miss vault lookup reads the audit rows
    // the vault itself writes — create AND findMany (userId + action filter,
    // createdAt desc, take).
    activity: {
      create: async ({ data }: any) => { mockActivityRows.push({ id: `act-${mockActivityRows.length + 1}`, createdAt: new Date(), ...data }); return data; },
      findMany: async ({ where, take }: any = {}) => mockActivityRows
        .filter((r) => (!where?.userId || r.userId === where.userId) && (!where?.action || r.action === where.action))
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, typeof take === 'number' ? take : undefined),
    },
  },
}));

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the owner-questions.test.ts pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The resolution wake + gate unblock + telegram pushes are dynamic imports —
// mocked at the boundary (the ca0b57cd / 2cee7764 harness pattern).
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
import {
  CONTEXT_GATED_PATTERNS,
  REDACTED_NOTE,
  SECRET_PATTERNS,
  findSecretSpans,
  redactSecrets,
  scanTextForSecrets,
} from './secret-scan';

/** FAKE incident specimens, assembled from string parts (no credential-shaped
 *  literal sits contiguous in source — the ca0b57cd/7caf07ed fixture rule). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');           // 20 chars, the key-id half
const SECRET_BODY = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const SECRET_VALUE = `/${SECRET_BODY}`;                                 // 40 chars, leading '/' — the byte-fidelity shape
const SECRET_ENV = 'CANLAW_CPT_S3_SECRET_ACCESS_KEY';
/** A sha1-shaped 40-char PURE HEX run — a hash, never an AWS secret. */
const FAKE_SHA1 = ['3dc48ac3797981ef', 'eff56d36b5a145a6', 'b75183cb'].join('');
/** A FAKE Google app-password shape (four unrelated 4-letter groups — the
 *  prose guard rejects runs of ordinary English words). */
const FAKE_APP_PW = ['wqzk', 'bmvt', 'hfjl', 'cnrx'].join(' ');

/** The pasted pair EXACTLY as the AWS console shows it (the incident shape). */
const PAIR_PASTE = `Access key\n${ACCESS_KEY_ID}\nSecret access key\n${SECRET_VALUE}\nHide`;

const parse = (s: string) => JSON.parse(s);
const machineCtx = (extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-365588cf', userId: 'u1', machineTriggered: true, userTurnText: '', ...extra });

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

/** The UNGATED card of the incident: a plain 'choice' card (no key field at
 *  all), answered with a paste. */
const flagChoiceAsk = async () => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: 'Which environment should the S3 signing run against?',
    expectedAnswerType: 'choice',
    options: [
      { id: 'a', label: 'staging' },
      { id: 'b', label: 'production' },
    ],
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

const storedRow = (id: string) => mockQuestions.rows.find((row: any) => row.id === id);
const vaultedValue = (envKey: string) => {
  const row = mockCreds.find((c) => c.envKey === envKey && !c.label);
  return row ? decryptValue(row.valueEnc) : null;
};
const vaultedSecretRow = () => mockCreds.find((c) => !c.label && decryptValue(c.valueEnc) === SECRET_VALUE);

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
  delete process.env.STORE_SECRET_OQ_FRESHNESS_DISABLED;
  delete process.env.STORE_SECRET_HONEST_MISS_DISABLED;
});
afterEach(() => {
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
  delete process.env.STORE_SECRET_OQ_FRESHNESS_DISABLED;
  delete process.env.STORE_SECRET_HONEST_MISS_DISABLED;
});

// ── T1 — the capture defect on a CREDENTIAL-declared card ────────────────────
describe('365588cf T1 — capture: the bare AWS secret half reaches the vault INTACT', () => {
  it('the SECRET lands under the declared slot byte-identical (40 chars, leading "/", never the key id)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    const r = await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    expect(r).toBe('ok'); // the credential gate LIFTED on this answer
    const v = vaultedValue(SECRET_ENV);
    expect(v).toBe(SECRET_VALUE);
    expect(String(v)).toHaveLength(40);
    expect(String(v).startsWith('/')).toBe(true); // no trim, no quote residue
    expect(String(v).slice(1)).toBe(SECRET_BODY); // byte-identical to the paste
    expect(v).not.toBe(ACCESS_KEY_ID);
  });

  it('the key-id half is NEVER minted into the secret slot; the readable row keeps no raw half', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    expect(mockUpsertCalls.filter((c) => c.envKey === SECRET_ENV && !c.label)).toHaveLength(1);
    const row = storedRow(q.id);
    expect(String(row.answer)).not.toContain(SECRET_VALUE);
    expect(String(row.answer)).not.toContain(ACCESS_KEY_ID);
    expect(String(row.answer)).toMatch(/\[CREDENTIAL VAULTED/);
    expect(String(row.answer)).toContain(`$${SECRET_ENV}`);
  });

  it('the KEY-ID half is still vaulted (under its own derived key) — the pair is fully recoverable', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    const idRow = mockCreds.find((c) => !c.label && decryptValue(c.valueEnc) === ACCESS_KEY_ID);
    expect(idRow).toBeTruthy();
    expect(idRow && idRow.envKey !== SECRET_ENV).toBe(true);
  });
});

// ── T2 — the same capture on an UNGATED 'choice' card (the incident's shape) ─
describe('365588cf T2 — capture on a plain choice card (no key field, the incident shape)', () => {
  it('the secret span is captured and routed to an OWNER_ANSWER_* key — not silently dropped', async () => {
    const q = await flagChoiceAsk();
    await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    const secretRow = vaultedSecretRow();
    expect(secretRow).toBeTruthy();
    // The undecorated ordinal key — the shape a card with no declared slot
    // uses for every captured value it cannot name (owner-questions.ts
    // ownerAnswerEnvKey). This is the assertion the pre-fix code fails: NO row
    // held the 40-char secret at all.
    expect(String(secretRow && secretRow.envKey)).toMatch(/^OWNER_ANSWER_[0-9A-Z]{1,8}(?:_\d+)?$/);
    // The readable row is redacted at rest and the vault notice names only keys.
    const row = storedRow(q.id);
    expect(String(row.answer)).not.toContain(SECRET_VALUE);
    expect(String(row.answer)).toMatch(/\[CREDENTIAL VAULTED/);
  });

  it('the pre-fix probe shape is exactly what changed: the span list now carries the 40-char half', () => {
    // The measured BEFORE: [ { name: 'AWS access key', len: 20 } ].
    const spans = findSecretSpans(PAIR_PASTE);
    expect(spans.map((s) => s.name)).toEqual(['AWS access key', 'AWS secret access key']);
    expect(spans.map((s) => s.value.length)).toEqual([20, 40]);
  });
});

// ── T3 — the honest miss: the vault pointer instead of a re-paste dead end ───
describe('365588cf T3 — store_secret on the oq id names what the vault ALREADY holds', () => {
  it('the refusal points at the vaulted envKey (still ok:false / no_secret_found, no write, no value)', async () => {
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    // The resolving answer is redacted + notice-stamped at rest, so a lift
    // finds nothing (the measured `{ ok:false, reason:'none' }`).
    const credsBefore = mockCreds.length;
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: q.id });
    expect(raw).not.toContain(SECRET_VALUE); // the value is never echoed
    expect(raw).not.toContain(ACCESS_KEY_ID);
    const out = parse(raw);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no_secret_found');
    // THE FIX: the refusal is a POSITIVE POINTER naming what is already there.
    expect(out.message).toContain(SECRET_ENV);
    expect(out.message).toContain(`$${SECRET_ENV}`);
    expect(out.message).toMatch(/vault ALREADY holds a credential captured from this card/);
    expect(out.message).toMatch(/never re-paste/);
    // ...and it never claims the row was stored unredacted (the old dead-end
    // wording) — the row IS redacted by design.
    expect(out.message).not.toMatch(/stored unredacted/);
    expect(out.vaultedEnvKeys).toEqual(expect.arrayContaining([SECRET_ENV]));
    expect(mockCreds).toHaveLength(credsBefore); // nothing was written
    expect(mockUpsertCalls.filter((c) => c.envKey === SECRET_ENV && !c.label)).toHaveLength(1); // only T1's store
  });

  it('no vault row for this card ⇒ the fallback names the card\'s own key field (never a bare re-paste)', async () => {
    // An OWNER-ANSWERED credential card whose resolving answer carries nothing
    // liftable and whose vault never captured anything (the vault was off when
    // the answer landed). Written directly rather than through
    // answerOwnerQuestion: a credential gate does NOT flip on a non-credential
    // reply, so the live path leaves the row open with no answeredBy stamp —
    // this pins the refusal leg itself, not the gate.
    mockQuestions.rows.push({
      id: 'oq_365588cf-9f2c-4f4c-9c1a-365588cf0001',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${SECRET_ENV}`,
      answer: 'staging please, I will paste the key later',
      answeredBy: 'owner', expectedAnswerType: `credential:${SECRET_ENV}`,
      createdAt: new Date(Date.now() - 60_000), resolvedAt: new Date(),
    });
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: 'oq_365588cf-9f2c-4f4c-9c1a-365588cf0001' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(out.message).toMatch(/no credential-shaped value/);
    expect(out.message).toMatch(/the card's key field/); // card declares the slot
    expect(out.message).toContain(SECRET_ENV);
    expect(out.message).toContain('Account → Coding → Credentials');
    expect(out.message).not.toMatch(/vault ALREADY holds/);
  });

  it('the chat-message leg keeps its own wording (the oq pointer never leaks to a message row)', async () => {
    mockMessages.push({ id: 'msg-clean-365588cf', role: 'user', content: 'here are the notes for the signing change', metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: 'msg-clean-365588cf' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(out.message).toMatch(/no value in it matches a credential shape this tool knows/);
    expect(out.message).not.toMatch(/vault ALREADY holds/);
    expect(out.vaultedEnvKeys).toBeUndefined();
  });
});

// ── T4 — prior true positives stay green (detector-adjacent) ────────────────
describe('365588cf T4 — the shapes that already worked keep working', () => {
  it('the app-password context-gated shape still fires, and still stays OUT of the commit gate', () => {
    const text = `the gmail app password is ${FAKE_APP_PW}`;
    const r = redactSecrets(text);
    expect(r.hits).toContain('App password');
    expect(r.text).toBe(`the gmail app password is ${REDACTED_NOTE}`);
    expect(scanTextForSecrets(text)).toEqual([]);
    expect(CONTEXT_GATED_PATTERNS.filter((p) => p.name === 'App password')).toHaveLength(2);
    expect(SECRET_PATTERNS.some((p) => p.name === 'App password')).toBe(false);
  });

  it('the new AWS-secret row is context-gated only — the commit gate stays blind to it', () => {
    expect(CONTEXT_GATED_PATTERNS.some((p) => p.name === 'AWS secret access key')).toBe(true);
    expect(SECRET_PATTERNS.some((p) => p.name === 'AWS secret access key')).toBe(false);
    expect(scanTextForSecrets(`aws secret access key ${SECRET_VALUE}`)).toEqual([]);
  });

  it('a 40-char pure-hex sha1 beside an AWS/S3 cue is NOT captured (the value-shape guard)', () => {
    for (const text of [`aws s3 signing commit ${FAKE_SHA1}`, `secret access key ${FAKE_SHA1}`]) {
      expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(false);
      expect(redactSecrets(text).text).toBe(text); // left exactly as typed
    }
  });

  it('a 40-char run with no AWS/S3 cue nearby is left alone (length alone is not evidence)', () => {
    const text = `here is the blob ${SECRET_VALUE} for the parse`;
    expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(false);
    expect(redactSecrets(text).text).toBe(text);
  });
});

// ── guard pin: corrupt rows are still refused on the direct door ────────────
describe('365588cf — the direct-corruption door stays shut', () => {
  it('a key-id-only lift targeting the SECRET slot is refused (slot mismatch), never stored', async () => {
    mockQuestions.rows.push({
      id: 'oq_365588cf-01b7-427d-8820-ad67548218f4',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${SECRET_ENV}`,
      answer: `the access key id is ${ACCESS_KEY_ID}`,
      answeredBy: 'owner', expectedAnswerType: `credential:${SECRET_ENV}`,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: SECRET_ENV, fromMessageId: 'oq_365588cf-01b7-427d-8820-ad67548218f4' }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('store_failed');
    expect(out.message).toMatch(/SECRET-ACCESS-KEY slot/);
    expect(vaultedValue(SECRET_ENV)).toBeNull();
  });

  it('a pre-existing corrupt secret row is REPLACED by the correctly captured one (upsert posture)', async () => {
    mockCreds.push({
      id: 'cred-corrupt-365588cf', createdAt: new Date('2026-10-30T16:00:00Z'), updatedAt: new Date('2026-10-30T16:00:00Z'),
      userId: 'u1', provider: 'custom', envKey: SECRET_ENV, label: '', valueEnc: encryptValue(ACCESS_KEY_ID),
    });
    const q = await flagCredentialAsk(SECRET_ENV);
    await answerOwnerQuestion(q.id, 'u1', PAIR_PASTE, { answeredBy: 'owner' });
    expect(vaultedValue(SECRET_ENV)).toBe(SECRET_VALUE);
    expect(mockCreds.filter((c) => !c.label && c.envKey === SECRET_ENV)).toHaveLength(1);
  });
});