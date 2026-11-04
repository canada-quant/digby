/**
 * Ticket ad4fae90 — replay: secrets handling on the owner-question Q&A cards
 * was "very buggy and annoying … doesn't work most of the time".
 *
 * The defects this suite replays (all on CREDENTIAL-GATED cards,
 * expectedAnswerType 'credential:<ENVKEY>'):
 *
 *  1. THE PROVIDER-PREFIX HOLE (the 82dd8756 / 4e8257c4 class): the vault leg
 *     (ticket 50bcd1e7) routed only spans findSecretSpans recognized. A key
 *     whose shape SECRET_PATTERNS does not know was NOT vaulted and NOT even
 *     redacted (the same pattern set drives the N9 inbound scan), and the raw
 *     value sat VERBATIM on the row inside the mismatch record (`reply was:
 *     "<the raw key>"`). Fleet homework measured 12 of 14 credential-ask
 *     cards answered with no usable credential: "doesn't work most of the
 *     time" was literal.
 *
 *  2. NO CARD AFFORDANCE: needsCredential was stamped server-side but had
 *     ZERO frontend consumers — the card rendered a plain text box, so the
 *     owner had no "this is the key" signal to give.
 *
 * The reviewed design (post adversarial review, session eb7dd709 — findings
 * F1/F2/B1/B2/F4 all folded in):
 *  - the WHOLE-ANSWER vault path runs ONLY on the owner's EXPLICIT paste
 *    intent (credentialPaste: true — the card's dedicated secret input, the
 *    owner-authenticated REST surface). An implicit declared-envKey leg was
 *    removed (finding F2/B1: no shape heuristic separates hyphenated prose
 *    and git SHAs from keys — "yes-use-the-staging-one" silently minted and
 *    lifted a declared gate);
 *  - with intent, the WHOLE trimmed answer is the candidate — multi-word
 *    values INCLUDED (finding F1: a Gmail app password in Google's displayed
 *    "abcd efgh ijkl mnop" form is a real key form; refusing it made the
 *    mismatch record quote it verbatim);
 *  - a paste-path answer on a shut gate is NEVER quoted (F1's leak half) —
 *    nor is any opaque-token reply (the original ad4fae90 leak);
 *  - a BARE 'credential' row lifts on an explicit paste that stored any key
 *    (finding B2: a known-shape key on a bare row stored via the span leg
 *    but never lifted, dead-ending the card with a false "not stored" record);
 *  - known-shape keys keep flowing through the span leg from PLAIN text
 *    (50bcd1e7 regression pin) — proven shapes need no intent.
 *
 * Runs against the REAL secret-scan + credentials.service (the
 * owner-answer-vault.50bcd1e7.test.ts harness pattern — only config/database
 * and the wake boundaries are mocked).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];
let mockActivity: any[] = [];

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
    activity: { create: async ({ data }: any) => { mockActivity.push(data); return data; } },
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

import { flagOwnerQuestion, answerOwnerQuestion, explicitPasteValue, isOpaqueTokenShape } from './owner-questions';
import { decryptValue, isPemBlock } from '../coding/credentials.service';
import { findSecretSpans } from './secret-scan';

/** An UNKNOWN-shape provider token (fixture, never a real credential): a
 * prefix SECRET_PATTERNS does not carry + 40 mixed chars — exactly the
 * 82dd8756/4e8257c4 class. The suite asserts the scanner REALLY misses it so
 * the replay cannot silently pass after someone adds the pattern. */
const UNKNOWN_SHAPED_KEY = 'provk_9f8e7d6c5b4a3210fedcba9876543210xyz';
/** A known-shape token (vaulted by the span leg since 50bcd1e7). Assembled
 *  from parts so the commit-time secret scan never sees a contiguous key
 *  literal in source (the e90db560c/50bcd1e7 fixture convention) — it is a
 *  FAKE value, never a real credential. */
const KNOWN_SHAPED_KEY = ['sk', 'proj-abcdefghijklmnopqrstuvwxyz123456'].join('-');
/** Review F2's specimen class: hyphenated PROSE a shape heuristic cannot
 *  separate from a key — the reason the implicit leg was removed. */
const HYPHENATED_PROSE = 'yes-use-the-staging-one';
/** Review F1's specimen: a Gmail app password in Google's displayed spaced
 *  form (fixture groups, never a real password). */
const SPACED_APP_PASSWORD = 'abcd efgh ijkl mnop';

const flagCredentialAsk = async (envKey?: string) => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: `Please paste the ${envKey ?? 'SCHOOLTIME_API_KEY'} so the Drive watch can authenticate`,
    // envKey undefined → BARE 'credential' (envKey inferred from the question
    // text's single ENVKEY-shaped token by parseExpectedAnswerType) — pass
    // envKey:null explicitly for a truly-bare row (see the bare tests).
    expectedAnswerType: envKey ? `credential:${envKey}` : 'credential',
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
  mockCreds = [];
  mockActivity = [];
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ticket ad4fae90 — the provider-prefix hole on credential-gated cards', () => {
  it('the replay premise holds: the scanner genuinely does not know the fixture shapes (else this replay is void)', () => {
    // If someone adds 'provk_' to SECRET_PATTERNS this test FAILS ON PURPOSE —
    // the whole-answer path below would then be covered by the span leg and
    // the replay needs a fresh unknown shape.
    expect(findSecretSpans(UNKNOWN_SHAPED_KEY)).toHaveLength(0);
    expect(findSecretSpans(KNOWN_SHAPED_KEY)).toHaveLength(1);
    expect(findSecretSpans(HYPHENATED_PROSE)).toHaveLength(0);
    expect(findSecretSpans(SPACED_APP_PASSWORD)).toHaveLength(0);
  });

  it('REVIEW F2/B1 pin: an unknown-shape token as PLAIN TEXT never mints a credential — gate shut, value withheld from the row', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', UNKNOWN_SHAPED_KEY);
    expect(r).toBe('credential_pending');
    expect(mockCreds).toHaveLength(0); // the implicit declared-envKey leg is GONE
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.status)).toBe('open');
    // F2's leak half: the opaque token is withheld, never quoted verbatim.
    expect(String(after.answer)).not.toContain(UNKNOWN_SHAPED_KEY);
    expect(String(after.answer)).toContain('opaque token was pasted — withheld');
  });

  it('REVIEW F2/B1 pin: hyphenated prose and a bare git SHA as plain text never mint or lift (the false-lift class)', async () => {
    for (const junk of [HYPHENATED_PROSE, '3a492aa7b8927fb8d0d3a1bfa3ab829d2519de90']) {
      mockQuestions.reset();
      mockCreds = [];
      const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
      const r = await answerOwnerQuestion(q.id, 'u1', junk);
      expect(r).toBe('credential_pending');
      expect(mockCreds).toHaveLength(0);
      const after = mockQuestions.rows.find((row: any) => row.id === q.id);
      expect(String(after.answer)).not.toContain(junk);
      expect(String(after.status)).toBe('open');
    }
  });

  it('a PROSE answer (multi-word) on a credential gate stays shut and is quoted only as prose (no spans, no intent)', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes go ahead and use the staging one');
    // 2026-10-20: prose is a counter-question — reply_recorded + the lane is
    // woken to answer on the card; the gate itself is still shut (no store).
    expect(r).toBe('reply_recorded');
    expect(mockCreds).toHaveLength(0);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toContain('recorded, not yet an answer');
    expect(String(after.status)).toBe('open');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a known-shape paste keeps flowing through the span leg (50bcd1e7 regression pin) and lifts the declared gate', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', KNOWN_SHAPED_KEY);
    expect(r).toBe('ok');
    const stored = mockCreds.find((c) => c.envKey === 'SCHOOLTIME_API_KEY');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(KNOWN_SHAPED_KEY);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(KNOWN_SHAPED_KEY);
  });
});

describe('ticket ad4fae90 — the dedicated paste intent (credentialPaste, the card secret input)', () => {
  it('an unknown-shape key pasted with intent vault-stores under the declared envKey and lifts the gate on that answer', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', UNKNOWN_SHAPED_KEY, { credentialPaste: true });
    expect(r).toBe('ok');
    const stored = mockCreds.find((c) => c.envKey === 'SCHOOLTIME_API_KEY');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(UNKNOWN_SHAPED_KEY);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(UNKNOWN_SHAPED_KEY);
    expect(String(after.status)).toBe('answered');
    expect(String(after.answer)).toContain('SCHOOLTIME_API_KEY');
  });

  it('REVIEW F1 pin: a MULTI-WORD secret (spaced app password) pasted with intent STORES — and never rides the row', async () => {
    const q = await flagCredentialAsk('GMAIL_APP_PASSWORD');
    const r = await answerOwnerQuestion(q.id, 'u1', SPACED_APP_PASSWORD, { credentialPaste: true });
    expect(r).toBe('ok');
    const stored = mockCreds.find((c) => c.envKey === 'GMAIL_APP_PASSWORD');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(SPACED_APP_PASSWORD);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SPACED_APP_PASSWORD);
    expect(String(after.answer)).not.toContain('abcd');
  });

  it('REVIEW F1 leak-half pin: a paste-path answer on a SHUT gate is never quoted — even when the vault leg refuses it', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    // Force the vault leg to refuse (kill switch) so the gate stays shut and
    // the mismatch record is written from the paste path.
    process.env.OWNER_ANSWER_VAULT_DISABLED = '1';
    const r = await answerOwnerQuestion(q.id, 'u1', SPACED_APP_PASSWORD, { credentialPaste: true });
    expect(r).toBe('credential_pending');
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SPACED_APP_PASSWORD);
    expect(String(after.answer)).not.toContain('abcd');
    expect(String(after.answer)).toContain('withheld');
    delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  });

  it('REVIEW F4 pin: multi-line NON-PEM junk pasted with intent is refused (no store) and never quoted', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', 'line one of junk\nline two of junk', { credentialPaste: true });
    expect(r).toBe('credential_pending');
    expect(mockCreds).toHaveLength(0);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain('line one of junk');
  });

  it('credentialPaste is ignored on a NON-credential row — a free-text card never mints a credential', async () => {
    const out = await flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?' });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    const r = await answerOwnerQuestion(out.question.id, 'u1', 'stg_live_9f8e7d6c5b4a3210fedcba98', { credentialPaste: true });
    expect(r).toBe('ok');
    expect(mockCreds).toHaveLength(0);
  });

  it('REVIEW B2 pin: a BARE credential row lifts when an explicit paste stored ANY key (span leg included)', async () => {
    // Truly-bare: no ENVKEY-shaped token in the question, no declared envKey.
    const out = await flagOwnerQuestion({
      chatId: 'chat-1',
      userId: 'u1',
      question: 'Please paste the provider key so the watch can authenticate',
      expectedAnswerType: 'credential',
    });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    // KNOWN shape: the span leg stores it (spans.length > 0 → not the
    // whole-answer path) — before the B2 fix this stored but never lifted.
    const r = await answerOwnerQuestion(out.question.id, 'u1', KNOWN_SHAPED_KEY, { credentialPaste: true });
    expect(r).toBe('ok');
    expect(mockCreds.some((c) => c.envKey.startsWith('OWNER_ANSWER_'))).toBe(true);
    const after = mockQuestions.rows.find((row: any) => row.id === out.question.id);
    expect(String(after.status)).toBe('answered');
  });

  it('a bare credential row with an UNKNOWN-shape key + intent stores under the derived question key and lifts', async () => {
    const out = await flagOwnerQuestion({
      chatId: 'chat-1',
      userId: 'u1',
      question: 'Please paste the provider key so the watch can authenticate',
      expectedAnswerType: 'credential',
    });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    const r = await answerOwnerQuestion(out.question.id, 'u1', UNKNOWN_SHAPED_KEY, { credentialPaste: true });
    expect(r).toBe('ok');
    expect(mockCreds.some((c) => c.envKey.startsWith('OWNER_ANSWER_'))).toBe(true);
    const stored = mockCreds.find((c) => c.envKey.startsWith('OWNER_ANSWER_'));
    expect(decryptValue(stored.valueEnc)).toBe(UNKNOWN_SHAPED_KEY);
  });

  it('honest-intent semantics: prose pasted INTO THE KEY FIELD stores as-is and lifts (the owner said it is the key)', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes use the staging one', { credentialPaste: true });
    expect(r).toBe('ok');
    const stored = mockCreds.find((c) => c.envKey === 'SCHOOLTIME_API_KEY');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe('yes use the staging one');
  });

  it('a redaction marker pasted with intent is refused (never re-stored as a "credential")', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', '[REDACTED: looked like a credential]', { credentialPaste: true });
    expect(r).toBe('credential_pending');
    expect(mockCreds).toHaveLength(0);
  });

  it('a complete PEM paste through the secret input vault-stores the full block', async () => {
    const BEGIN = (label: string) => `-----BEGIN ${label}-----`;
    const END = (label: string) => `-----END ${label}-----`;
    const pem = [BEGIN('PRIVATE KEY'), 'MIIBFAKEFAKEFAKEFAKEFAKEFAKEFAKE0w==', END('PRIVATE KEY')].join('\n');
    const q = await flagCredentialAsk('VAULT_SIGNING_KEY');
    const r = await answerOwnerQuestion(q.id, 'u1', pem, { credentialPaste: true });
    expect(r).toBe('ok');
    const stored = mockCreds.find((c) => c.envKey === 'VAULT_SIGNING_KEY');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(pem);
  });

  it('REVIEW F-A pin: a paste the vault REFUSES never rides the row — even when the gate lifts from a PRE-EXISTING credential (preset-managed key)', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    // A PRE-EXISTING credential for the declared key (stored earlier via the
    // Account UI) — credentialLifted's store-state check sees it.
    mockCreds.push({ id: 'cred-pre', userId: 'u1', provider: 'cloudflare', envKey: 'SCHOOLTIME_API_KEY', label: '', valueEnc: 'x', createdAt: new Date(), updatedAt: new Date() });
    // And the SAME (userId, envKey, label) row visible to the vault leg's
    // findUnique — with a NON-custom provider, the vault leg skips it (the
    // never-flip-an-infra-managed-row guard) → nothing stored THIS answer.
    // (Same row, one object: provider 'cloudflare'.)
    const r = await answerOwnerQuestion(q.id, 'u1', UNKNOWN_SHAPED_KEY, { credentialPaste: true });
    // The gate LIFTS (pre-existing state) — but the caller is told the paste
    // was NOT stored, and the raw token never rides the row.
    expect(r).toBe('ok_paste_refused');
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(UNKNOWN_SHAPED_KEY);
    expect(String(after.answer)).toContain('NOT stored');
    expect(String(after.status)).toBe('answered');
  });

  it('REVIEW F-A pin (kill-switch variant): vault disabled + paste + pre-existing lift → ok_paste_refused, raw value never on the row', async () => {
    const q = await flagCredentialAsk('SCHOOLTIME_API_KEY');
    mockCreds.push({ id: 'cred-pre', userId: 'u1', provider: 'custom', envKey: 'SCHOOLTIME_API_KEY', label: '', valueEnc: 'x', createdAt: new Date(), updatedAt: new Date() });
    process.env.OWNER_ANSWER_VAULT_DISABLED = '1';
    const r = await answerOwnerQuestion(q.id, 'u1', SPACED_APP_PASSWORD, { credentialPaste: true });
    expect(r).toBe('ok_paste_refused');
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SPACED_APP_PASSWORD);
    expect(String(after.answer)).not.toContain('abcd');
    expect(String(after.answer)).toContain('NOT stored');
    delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  });

  it('REVIEW F-B pin: an option-matched paste answer carries the marker, not the raw value (no "typed:" bypass)', async () => {
    // A credential-gated row WITH a typed option whose label the paste happens
    // to match is contrived — the real F-B risk is the matched branch
    // rebuilding storage text from `trimmed` instead of `answerText`. Pin it
    // with a vaulted whole-answer paste on a row that ALSO carries options:
    // whichever branch stores, the raw token must never appear.
    const out = await flagOwnerQuestion({
      chatId: 'chat-1',
      userId: 'u1',
      question: 'Please paste the SCHOOLTIME_API_KEY so the watch can authenticate',
      expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
      options: [{ id: 'opt_1', label: 'Use the staging key instead' }],
    });
    if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
    const r = await answerOwnerQuestion(out.question.id, 'u1', UNKNOWN_SHAPED_KEY, { credentialPaste: true });
    expect(r).toBe('ok');
    const after = mockQuestions.rows.find((row: any) => row.id === out.question.id);
    expect(String(after.answer)).not.toContain(UNKNOWN_SHAPED_KEY);
    expect(String(after.status)).toBe('answered');
  });

  it('pure guards: explicitPasteValue refuses only empty/redacted; isOpaqueTokenShape is single-token', () => {
    expect(explicitPasteValue('', () => false)).toBeNull();
    expect(explicitPasteValue('   ', () => false)).toBeNull();
    expect(explicitPasteValue('[REDACTED: looked like a credential]', () => false)).toBeNull();
    // With intent the whole value is the candidate — prose, URLs, names
    // included (honest-intent; the owner chose the key field).
    expect(explicitPasteValue(SPACED_APP_PASSWORD, () => false)).toBe(SPACED_APP_PASSWORD);
    expect(explicitPasteValue('https://example.com/keys/abcdef', () => false)).toBe('https://example.com/keys/abcdef');
    expect(explicitPasteValue('SCHOOLTIME_API_KEY', () => false)).toBe('SCHOOLTIME_API_KEY');
    // A multi-line value still passes ONLY as a complete PEM block (headers
    // assembled via helpers — no contiguous BEGIN/END literal in source, the
    // e90db560c convention).
    const BEGIN = (label: string) => `-----BEGIN ${label}-----`;
    const END = (label: string) => `-----END ${label}-----`;
    const pem = [BEGIN('PRIVATE KEY'), 'MIIBFAKEFAKEFAKEFAKE0w==', END('PRIVATE KEY')].join('\n');
    expect(explicitPasteValue(pem, isPemBlock)).toBe(pem);
    expect(explicitPasteValue('junk\nlines', isPemBlock)).toBeNull();
    expect(isOpaqueTokenShape(UNKNOWN_SHAPED_KEY)).toBe(true);
    expect(isOpaqueTokenShape(HYPHENATED_PROSE)).toBe(true);
    expect(isOpaqueTokenShape('yes go ahead')).toBe(false);
  });
});
