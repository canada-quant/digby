/**
 * Ticket b71367e5 — replay: the four advisories deferred by the ca0b57cd
 * lane (PR #1826, squash 49a5345f5716) after its adversarial review passes.
 *
 *  1. A8 — SEPARATOR-DEPENDENT KEY NAMING. The keyword leg
 *     (`db_password=`, `auth_token:`, `api_secret=`, `export DB_PASSWORD=`)
 *     fired on the SAME compound labels the named-compound leg covers, but
 *     pushed NO label — so the vault keyed the value by SEPARATOR:
 *     `db_password+<v>` stored as $DB_PASSWORD (named-compound leg, label
 *     carried) while `db_password=<v>` fell to the opaque ordinal
 *     OWNER_ANSWER_<id>_2 key. Value never lost, name unpredictable.
 *     FIX: the keyword leg carries the label whenever its label NAMES a
 *     NAMED_COMPOUND_TAILS compound (compoundCredentialLabel).
 *
 *  2. Pass-3 finding #7 — ZERO-STORE WARNING NOT DELIVERED ON THE
 *     GATE-MISMATCH PATH. vaultOwnerAnswerSecrets computed the honest
 *     notice (capture count / "captured but could NOT be stored" WARNING),
 *     but the credential- and typed-gate MISMATCH records overwrote
 *     row.answer with the bare "[owner replied, gate still shut — …]"
 *     record and DROPPED the notice — an owner whose paste was refused
 *     (truncated PEM, per-answer cap, protected key) learned nothing.
 *     FIX: both mismatch records weave the vault notice in, text capped so
 *     the actionable notice never truncates.
 *
 *  3. ESCAPED-JSON RESIDUALS. The named-compound separator accepted ONE
 *     optional backslash before a quote, so a double-escaped JSON paste
 *     (`\\\"secret_access_key\\\": \\\"<40>\\\"`) matched nothing; and both
 *     assignment legs' value charset stopped at `\`, so an escaped-slash
 *     value (`"abC…\/xyz"`) either matched nothing (short prefix) or
 *     redacted only the PREFIX, leaving the tail riding the row verbatim.
 *     FIX: `\\*` before the quotes, `\/` admitted as a value unit, `\/`
 *     unescaped BEFORE the path/URL/ARN exemption tests, and the vault
 *     unescapes `\/` at store time so the stored credential is the REAL
 *     value.
 *
 *  4. A6 — NO FRESHNESS GUARD ON THE oq_ REPAIR LEG. store_secret
 *     {fromMessageId: oq_…} lifted the answer text of ANY owner-answered
 *     row into the vault under any caller-named envKey — a 30-day-old row
 *     (value possibly rotated/revoked, card long superseded) silently
 *     minted a credential. FIX: the leg refuses rows whose ANSWER
 *     (resolvedAt, else createdAt) is older than STORE_SECRET_OQ_MAX_AGE_DAYS
 *     (default 7; empty/unparsable → default, never 0 — the compose
 *     Number('')===0 gotcha); STORE_SECRET_OQ_FRESHNESS_DISABLED=1 restores
 *     the unguarded leg.
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

jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: async () => null, set: async () => true, del: async () => true } }));

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
        // credentialLifted queries { envKey: { startsWith } } — shape-aware.
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
  },
}));

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the owner-questions.test.ts pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The resolution wake + gate unblock + telegram pushes are dynamic imports —
// mocked at the boundary (the 50bcd1e7 harness pattern).
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
import { executeSecretHandoffTool } from './secret-handoff-tools';
import { decryptValue } from '../coding/credentials.service';
import { findSecretSpans, redactInboundSecrets } from './secret-scan';

/** Fake credentials, assembled so no credential-shaped literal sits
 *  contiguous in source (the 50bcd1e7/ad4fae90 fixture convention). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_VALUE = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const DB_PW = ['DbPw', '9xkQLe7Rm2vTzhA'].join('');
const DECLARED_ENVKEY = 'CANLAW_CPT_S3_KEY';

const parse = (s: string) => JSON.parse(s);

const flagCredentialAsk = async (envKey: string) => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: `Please paste the ${envKey} credential pair so the lane can sign S3 requests`,
    expectedAnswerType: `credential:${envKey}`,
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

beforeEach(() => {
  mockQuestions.reset();
  mockCreds = [];
  mockMessages = [];
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
  delete process.env.STORE_SECRET_OQ_MAX_AGE_DAYS;
  delete process.env.STORE_SECRET_OQ_FRESHNESS_DISABLED;
});

// ── 1. A8 — separator-independent key naming ────────────────────────────────

describe('ticket b71367e5 — A8: the keyword leg carries the compound label on every separator', () => {
  it('db_password= / db_password: / export DB_PASSWORD= all yield a span carrying the label', () => {
    const forms = [
      `db_password=${DB_PW}`,
      `db_password: ${DB_PW}`,
      `export DB_PASSWORD=${DB_PW}`,
    ];
    for (const f of forms) {
      const spans = findSecretSpans(f);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ name: 'Credential assignment', value: DB_PW });
      // pre-fix: NO label on the keyword leg — the vault keyed this value by
      // separator (`db_password+<v>` named it, `db_password=<v>` did not).
      expect(spans[0].label).toBeTruthy();
    }
    // the `+` form (named-compound leg) already carried it — same name now.
    const plus = findSecretSpans(`db_password+${DB_PW}`);
    expect(plus[0].label).toBeTruthy();
    expect(plus[0].label).toBe(findSecretSpans(`db_password=${DB_PW}`)[0].label);
  });

  it('auth_token= and api_secret= carry their labels too (the reviewer\'s dead-tail set)', () => {
    for (const [form, label] of [['auth_token=', 'auth_token'], ['api_secret=', 'api_secret']] as const) {
      const spans = findSecretSpans(`${form}${DB_PW}`);
      expect(spans).toHaveLength(1);
      expect(spans[0].label).toBe(label);
    }
  });

  it('BARE keyword labels stay unlabeled (password=, api_key=) and non-credential labels stay untouched', () => {
    for (const form of ['password=', 'api_key=', 'secret=']) {
      const spans = findSecretSpans(`${form}${DB_PW}`);
      expect(spans).toHaveLength(1);
      expect(spans[0].label).toBeUndefined();
    }
    // `X-API-Key:` names a keyword, not a compound — no label.
    expect(findSecretSpans(`X-API-Key: ${DB_PW}`)[0].label).toBeUndefined();
    // non-credential compound labels never match at all (ca0b57cd pin).
    expect(findSecretSpans('the sort_order of the report is alphabetical_this_week_no_really')).toHaveLength(0);
  });

  it('end-to-end: the second named value stores as $DB_PASSWORD under = , : and export forms — same key for every separator', async () => {
    for (const second of [`db_password=${DB_PW}`, `db_password: ${DB_PW}`, `export DB_PASSWORD=${DB_PW}`, `db_password+${DB_PW}`]) {
      mockQuestions.reset(); mockCreds = [];
      const q = await flagCredentialAsk(DECLARED_ENVKEY);
      const r = await answerOwnerQuestion(q.id, 'u1', `aws_access_key_id=${ACCESS_KEY_ID} ${second}`);
      expect(r).toBe('ok');
      const named = mockCreds.find((c: any) => c.envKey === 'DB_PASSWORD');
      expect(named).toBeTruthy();
      expect(decryptValue(named.valueEnc)).toBe(DB_PW);
      expect(mockCreds.find((c: any) => c.envKey === DECLARED_ENVKEY)).toBeTruthy();
      const after = mockQuestions.rows.find((row: any) => row.id === q.id);
      expect(String(after.answer)).not.toContain(DB_PW);
      expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
      expect(String(after.answer)).toContain('$DB_PASSWORD');
    }
  });
});

// ── 2. Pass-3 finding #7 — the zero-store WARNING rides the mismatch record ──

describe('ticket b71367e5 — pass-3 #7: the vault notice is delivered on the gate-mismatch path', () => {
  /** A TRUNCATED PEM (BEGIN, no END): the span scan captures the whole
   *  block, the vault REFUSES it (not a well-formed block) → the honest
   *  zero-store WARNING; the gate cannot lift on it → the mismatch record.
   *  Assembled from fragments so no PEM-shaped literal sits contiguous in
   *  source (the 50bcd1e7/ad4fae90 fixture convention). */
  const TRUNCATED_PEM = [['-----BEGIN RSA PRIVATE', ' KEY-----'].join(''), 'AbCdEf123dummybodylines'].join('\n');

  it('credential gate: the mismatch record carries the zero-store WARNING (pre-fix: only "gate still shut")', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const r = await answerOwnerQuestion(q.id, 'u1', TRUNCATED_PEM);
    expect(r).toBe('reply_recorded'); // conversational path — but the record is written first
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    const answer = String(after.answer);
    // f3a69ed3: the record is the owner-facing block; the semantic bar stands
    // (the zero-store WARNING rides the record; the raw value never does).
    expect(answer).toMatch(/recorded, not yet an answer/);
    expect(answer).toMatch(/WARNING: 1 credential-shaped value was captured in this answer but could NOT be stored/);
    expect(answer).not.toContain('dummybodylines');
    expect(mockCreds).toHaveLength(0); // nothing stored — the WARNING is honest
  });

  it('typed (yes/no) gate: the mismatch record carries the vault notice too (same defect class)', async () => {
    const out = await flagOwnerQuestion({
      chatId: 'chat-1',
      userId: 'u1',
      question: 'Ship the rotation tonight?',
      expectedAnswerType: 'yes_no',
    });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    const r = await answerOwnerQuestion(out.question.id, 'u1', TRUNCATED_PEM);
    expect(r).toBe('reply_recorded');
    const after = mockQuestions.rows.find((row: any) => row.id === out.question.id);
    const answer = String(after.answer);
    // f3a69ed3: the owner-facing block names the yes/no reason (the legacy
    // 'expected a yes/no ruling' phrasing retired with the old record).
    expect(answer).toMatch(/yes\/no ruling/);
    expect(answer).toMatch(/WARNING: 1 credential-shaped value was captured in this answer but could NOT be stored/);
  });

  it('typed-gate P1 (adversarial review 99eefe90): a near-MAXIMAL reply never truncates the notice tail — the reply gives way', async () => {
    // Pre-fix: the typed-gate record flat-sliced at ANSWER_MAX + 200 with NO
    // reservation for the notice, so a reply near ANSWER_MAX amputated the
    // actionable "Re-supply …" tail — the exact defect class pass-3 #7 claims
    // to fix. The credential-gate twin (base gives way, line ~3990) was safe;
    // this pins the same arithmetic on the typed-gate site.
    const out = await flagOwnerQuestion({
      chatId: 'chat-1',
      userId: 'u1',
      question: 'Ship the rotation tonight?',
      expectedAnswerType: 'yes_no',
    });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    // A long conversational reply (words, never an opaque-token shape) with
    // the TRUNCATED PEM at the end: the vault leg captures the PEM, refuses
    // it, and the honest zero-store WARNING must ride the record COMPLETE.
    const longReply = `${'some deployment context for the rotation decision '.repeat(200)}\n${TRUNCATED_PEM}`;
    const r = await answerOwnerQuestion(out.question.id, 'u1', longReply);
    expect(r).toBe('reply_recorded');
    const after = mockQuestions.rows.find((row: any) => row.id === out.question.id);
    const answer = String(after.answer);
    // The reply rides the record capped (never the notice): prefix intact…
    expect(answer).toMatch(/yes\/no ruling/);
    // …the zero-store WARNING intact…
    expect(answer).toMatch(/WARNING: 1 credential-shaped value was captured in this answer but could NOT be stored/);
    // …and the ACTIONABLE tail verbatim-complete — pre-fix this was the part
    // the flat (ANSWER_MAX + 200) slice amputated. (f3a69ed3: the record no
    // longer closes with the legacy ']]' bracket — the owner-facing block
    // ends with the vault notice, which is the actionable tail itself.)
    expect(answer).toMatch(/Re-supply it \(store_secret, or Account → Coding → Credentials\)\.\]$/);
    // The record never exceeds the row budget the f3a69ed3 owner-facing
    // wrapper allows (ANSWER_MAX + REPLY_RECORD_WRAPPER_ALLOWANCE — the
    // legacy +200 ceiling retired with the legacy bracket; the two standing
    // doctrines hold: the reply itself never exceeds ANSWER_MAX, and the
    // actionable tail never clips).
    expect(answer.length).toBeLessThanOrEqual(8000 + 600);
    expect(mockCreds).toHaveLength(0); // the WARNING is honest — nothing stored
  });

  it('a mismatch record with NOTHING captured stays notice-free (regression pin)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    await answerOwnerQuestion(q.id, 'u1', 'i never got the json policy, can you resend it?');
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toMatch(/recorded, not yet an answer/);
    expect(String(after.answer)).not.toMatch(/CREDENTIAL VAULTED/);
  });
});

// ── 3. Escaped-JSON residual forms ──────────────────────────────────────────

describe('ticket b71367e5 — escaped-JSON: doubled backslashes and escaped-slash values', () => {
  it('a once-escaped JSON paste still yields the span (50bcd1e7 regression pin)', () => {
    const once = JSON.stringify(JSON.stringify({ secret_access_key: SECRET_VALUE })).slice(1, -1);
    const spans = findSecretSpans(once);
    expect(spans.filter((s) => s.name === 'Named credential assignment')).toHaveLength(1);
    expect(redactInboundSecrets(once)).not.toContain(SECRET_VALUE);
  });

  it('a DOUBLE-escaped JSON paste yields the span with the label (pre-fix: matched nothing, rode verbatim)', () => {
    const twice = JSON.stringify(JSON.stringify(JSON.stringify({ secret_access_key: SECRET_VALUE }))).slice(1, -1);
    const spans = findSecretSpans(twice);
    expect(spans.filter((s) => s.name === 'Named credential assignment')).toHaveLength(1);
    expect(spans[0].value).toBe(SECRET_VALUE);
    expect(spans[0].label).toBe('secret_access_key');
    const out = redactInboundSecrets(twice);
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).toContain('secret_access_key');
  });

  it('an escaped-slash VALUE no longer slips the keyword leg (pre-fix: the tail after \\/ rode verbatim)', () => {
    // In source, '\\/' is a literal backslash+slash — the escaped-JSON unit.
    const ESC_TAIL = ['Mno', '456pqr'].join('');
    const pasted = ['{"api_secret": "AbC12', '3defGhiJkl\\/'].join('') + ESC_TAIL + '"}';
    const spans = findSecretSpans(pasted);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toContain('\\/');
    const out = redactInboundSecrets(pasted);
    expect(out).not.toContain(ESC_TAIL);      // the post-backslash tail never rides the row
    expect(out).not.toContain('3defGhiJkl');  // nor the prefix
    expect(out).toContain('api_secret');      // the label stays visible
  });

  it('an escaped-slash VALUE on the named-compound leg vaults as the UNESCAPED real value', async () => {
    const ESC_VALUE = ['AbC12', '3defGhiJkl\\/Mno', '456pqrStU'].join('');
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    // AKIA id first (the live specimen shape): the escaped value is the
    // SECOND span, so it rides the label-derived key.
    const pasted = `aws_access_key_id=${ACCESS_KEY_ID} {"secret_access_key": "${ESC_VALUE}"}`;
    const r = await answerOwnerQuestion(q.id, 'u1', pasted);
    expect(r).toBe('ok');
    const second = mockCreds.find((c: any) => c.envKey === 'SECRET_ACCESS_KEY');
    expect(second).toBeTruthy();
    // the stored credential is the REAL value — backslash-slash unescaped at store time
    expect(decryptValue(second.valueEnc)).toBe(['AbC12', '3defGhiJkl/Mno', '456pqrStU'].join(''));
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain('456pqrStU');
  });

  it('an escaped path REFERENCE is still exempt (no span) — the exemption judges the unescaped form', () => {
    const pasted = '{"private_key": "\\/etc\\/ssl\\/private\\/key2024.pem"}';
    expect(findSecretSpans(pasted).filter((s) => s.name === 'Named credential assignment')).toHaveLength(0);
  });

  it('a base64 secret with a leading slash still REDACTS (delta-review #1 pin — the \\/ unit must not re-open it)', () => {
    const B64 = ['/', '9j4Kq7wXb2mNpQrStUvWx3yZ5aBcD'].join('');
    const spans = findSecretSpans(`AWS_SECRET_ACCESS_KEY=${B64}`);
    expect(spans.filter((s) => s.name === 'Named credential assignment')).toHaveLength(1);
    expect(redactInboundSecrets(`AWS_SECRET_ACCESS_KEY=${B64}`)).not.toContain(B64);
  });
});

// ── 4. A6 — freshness guard on the store_secret oq_ repair leg ──────────────

describe('ticket b71367e5 — A6: store_secret {fromMessageId: oq_…} freshness guard', () => {
  const machineCtx = () => ({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '' });
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  const pushRow = (id: string, createdAt: Date, resolvedAt: Date) => {
    mockQuestions.rows.push({
      id, chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${DECLARED_ENVKEY} credential pair`,
      answer: `canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`,
      answeredBy: 'owner', expectedAnswerType: `credential:${DECLARED_ENVKEY}`,
      createdAt, resolvedAt,
    });
  };

  it('a FRESH row (answered an hour ago) still lifts — the ca0b57cd repair path is intact (regression pin)', async () => {
    pushRow('oq_fresh0001-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - HOUR), new Date(Date.now() - HOUR));
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_fresh0001' });
    expect(raw).not.toContain(SECRET_VALUE);
    const out = parse(raw);
    expect(out.ok).toBe(true);
    expect(decryptValue(mockCreds.find((c: any) => c.envKey === 'X_KEY').valueEnc)).toBe(SECRET_VALUE);
  });

  it('a STALE row (answered 30 days ago) is refused stale_row and nothing stores (pre-fix: lifted under any caller key)', async () => {
    pushRow('oq_stale0001-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_stale0001-ca0b-4994-8770-6933e8567e06' });
    const out = parse(raw);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('stale_row');
    expect(mockCreds).toHaveLength(0);
  });

  it('STORE_SECRET_OQ_MAX_AGE_DAYS widens the window; an EMPTY value falls back to the default (never 0 — the compose Number(\'\') gotcha)', async () => {
    pushRow('oq_stale0002-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    process.env.STORE_SECRET_OQ_MAX_AGE_DAYS = '90';
    let out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_stale0002-ca0b-4994-8770-6933e8567e06' }));
    expect(out.ok).toBe(true);

    mockQuestions.reset(); mockCreds = [];
    pushRow('oq_stale0003-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    process.env.STORE_SECRET_OQ_MAX_AGE_DAYS = ''; // unset-shaped — must NOT become 0 (guard off)
    out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_stale0003-ca0b-4994-8770-6933e8567e06' }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('stale_row');
  });

  it('STORE_SECRET_OQ_FRESHNESS_DISABLED=1 restores the unguarded leg (kill switch)', async () => {
    pushRow('oq_stale0004-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    process.env.STORE_SECRET_OQ_FRESHNESS_DISABLED = '1';
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_stale0004-ca0b-4994-8770-6933e8567e06' }));
    expect(out.ok).toBe(true);
  });

  it('freshness measures the ANSWER (resolvedAt), not the card — a 30-day-old card answered an hour ago lifts', async () => {
    pushRow('oq_oldcard001-ca0b-4994-8770-6933e8567e06', new Date(Date.now() - 30 * DAY), new Date(Date.now() - HOUR));
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_oldcard001' }));
    expect(out.ok).toBe(true);
  });
});
