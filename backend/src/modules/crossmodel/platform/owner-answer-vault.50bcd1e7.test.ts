/**
 * Ticket 50bcd1e7 — replay: the credential-shaped safety filter destroyed an
 * owner-pasted credential in transit on an owner-question card (the
 * 2026-10-16 Schooltime Drive-watch incident, oq_312999fe: the owner pasted a
 * full GCP service-account JSON as his card answer; the private_key line
 * arrived as "[REDACTED: looked like a credential]" in both the supervisor's
 * and the lane's view, and the lane had to file a follow-up re-paste card).
 *
 * The fix: on an OWNER answer, the credential spans of the RAW answer are
 * routed to the encrypted coding-credentials vault (the same sanctioned
 * hand-off store_secret uses) under a stable question-derived envKey BEFORE
 * the N9 inbound redaction runs — the stored row / transcript note / wake
 * prompt stay redacted (unchanged posture) but carry a $ENVKEY notice, so the
 * woken lane uses the credential instead of re-asking the owner.
 *
 * This suite runs against the REAL secret-scan + credentials.service (only
 * config/database is mocked, the owner-questions.testkit pattern) so the
 * replay proves the incident shape end-to-end: JSON paste → spans found →
 * PEM unescaped → vaulted (decryptable) → row redacted + notice.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    codingCredential: {
      findUnique: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
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
// mocked at the boundary (the owner-questions.test.ts pattern).
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

import { flagOwnerQuestion, answerOwnerQuestion, isCounterQuestionRow, isCounterQuestionAnswer } from './owner-questions';
import { decryptValue } from '../coding/credentials.service';
import { REDACTED_NOTE } from './secret-scan';

// The incident shape (FIXTURE values, never a real credential): a GCP-style
// service-account JSON pasted as one card answer, private_key as a
// literal-\n escaped PEM — exactly what the owner pasted on oq_312999fe.
// PEM fixture headers are ASSEMBLED via helpers (the e90db560c convention) —
// no contiguous BEGIN/END header literal in source lines, so the commit-time
// secret scan never matches the fixture itself.
const BEGIN = (label: string) => `-----BEGIN ${label}-----`;
const END = (label: string) => `-----END ${label}-----`;
const PEM_BODY_LINE = 'MIIBFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0w==';
const PEM_BLOCK = [BEGIN('PRIVATE KEY'), PEM_BODY_LINE, END('PRIVATE KEY')].join('\n');
const INCIDENT_ANSWER = [
  '{',
  '  "type": "service_account",',
  '  "project_id": "schooltime-drive",',
  '  "client_email": "watch@schooltime-drive.iam.gserviceaccount.com",',
  `  "private_key": "${PEM_BLOCK.replace(/\n/g, '\\n')}",`,
  '  "token_uri": "https://oauth2.googleapis.com/token"',
  '}',
].join('\n');

let mockCreds: any[] = [];
let mockActivity: any[] = [];

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Please paste the service-account JSON for the Drive watch', ...over });

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

describe('50bcd1e7 — owner card answer credential routing (replay of the 2026-10-16 incident)', () => {
  it('replays the incident: the PEM span of the owner-pasted JSON is VAULTED (decryptable) while the stored answer stays REDACTED with a $ENVKEY notice', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', INCIDENT_ANSWER)).toBe('ok');

    // The credential reached the vault under the stable question-derived key,
    // unescaped to the REAL PEM block (the escaped paste is not a usable key).
    expect(mockCreds).toHaveLength(1);
    expect(mockCreds[0].envKey).toMatch(/^OWNER_ANSWER_[0-9A-Za-z]{8}$/);
    expect(mockCreds[0].provider).toBe('custom');
    expect(decryptValue(mockCreds[0].valueEnc)).toBe(PEM_BLOCK);

    // The stored row keeps every other field and the N9 redaction of the
    // private_key line — with the vault notice naming the envKey.
    const row = mockQuestions.rows[0];
    expect(row.answer).toContain('"project_id": "schooltime-drive"');
    expect(row.answer).toContain(REDACTED_NOTE);
    expect(row.answer).not.toContain(PEM_BODY_LINE);
    expect(row.answer).toMatch(/\[CREDENTIAL VAULTED — .*\$OWNER_ANSWER_[0-9A-Za-z]{8}/);

    // The transcript note and the wake prompt render the same redacted +
    // noticed text — the lane is told to use $ENVKEY, never the value.
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data;
    expect(note.content).toContain(REDACTED_NOTE);
    expect(note.content).not.toContain(PEM_BODY_LINE);
    expect(note.content).toMatch(/\$OWNER_ANSWER_[0-9A-Za-z]{8}/);
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.prompt).toContain(REDACTED_NOTE);
    expect(wake.prompt).not.toContain(PEM_BODY_LINE);
    expect(wake.prompt).toMatch(/\$OWNER_ANSWER_[0-9A-Za-z]{8}/);

    // The audit row names the env key only — never the value.
    const audit = mockActivity.find((a) => a.action === 'coding_credential.store');
    expect(audit).toBeTruthy();
    expect(audit.metadata.via).toBe('owner_answer_vault');
    expect(JSON.stringify(mockActivity)).not.toContain(PEM_BODY_LINE);
  });

  it('the follow-up re-paste card (the incident\'s oq_7a5f6c52 shape) vaults under its OWN key — no collision with the first card', async () => {
    // First card answered with the mangled-by-redaction credential.
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', INCIDENT_ANSWER);
    expect(mockCreds).toHaveLength(1);
    const firstEnvKey = mockCreds[0].envKey;

    // The lane files a follow-up re-paste card; the owner pastes again — a
    // DIFFERENT question id derives a DIFFERENT key, so the second vault row
    // never collides with or overwrites the first (per-question keys).
    const r2 = await flag({ chatId: 'chat-1', question: 'The private_key came through redacted — please paste the service-account JSON once more' });
    if (r2.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r2.question.id, 'u1', INCIDENT_ANSWER);
    expect(mockCreds).toHaveLength(2);
    expect(mockCreds[1].envKey).not.toBe(firstEnvKey);
    expect(decryptValue(mockCreds[1].valueEnc)).toBe(PEM_BLOCK);
  });

  it('a provider TOKEN answer (ghp_…) vaults too — the routing is not PEM-only', async () => {
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', `use ${FAKE_GH} for the deploy`);
    expect(mockCreds).toHaveLength(1);
    expect(decryptValue(mockCreds[0].valueEnc)).toBe(FAKE_GH);
    const row = mockQuestions.rows[0];
    expect(row.answer).toBe(`use ${REDACTED_NOTE} for the deploy ${row.answer.match(/\[CREDENTIAL VAULTED[^\]]*\]/)?.[0] ?? ''}`.trim());
    expect(row.answer).not.toContain(FAKE_GH);
  });

  it('N9 regression intact: with the kill switch on, the answer is redacted exactly as before — NO vault row, NO notice', async () => {
    process.env.OWNER_ANSWER_VAULT_DISABLED = '1';
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', `use ${FAKE_GH} for the deploy`);
    expect(mockCreds).toHaveLength(0);
    const row = mockQuestions.rows[0];
    expect(row.answer).toBe('use [REDACTED: looked like a credential] for the deploy');
    expect(row.answer).not.toContain('[CREDENTIAL VAULTED');
  });

  it('a SUPERVISOR answer is never vaulted (untrusted source — redaction only, no credential minted)', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', INCIDENT_ANSWER, { answeredBy: 'supervisor' });
    expect(mockCreds).toHaveLength(0);
    const row = mockQuestions.rows[0];
    expect(row.answer).toContain(REDACTED_NOTE);
    expect(row.answer).not.toContain('[CREDENTIAL VAULTED');
    expect(row.answer).not.toContain(PEM_BODY_LINE);
  });

  it('a non-credential answer is untouched: no vault row, no notice, verbatim storage', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'Yes — go ahead with the Drive watch on the schooltime folder.');
    expect(mockCreds).toHaveLength(0);
    expect(mockQuestions.rows[0].answer).toBe('Yes — go ahead with the Drive watch on the schooltime folder.');
  });

  it('a credential the vault refuses (truncated PEM — BEGIN with no END) is redacted as before, never stored broken', async () => {
    const TRUNCATED = `${BEGIN('PRIVATE KEY')}\\nMIIBFAKEtruncated`;
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', `here it is: ${TRUNCATED}`);
    expect(mockCreds).toHaveLength(0);
    expect(mockQuestions.rows[0].answer).toContain(REDACTED_NOTE);
    // ca0b57cd delta-review #3 (of 722064990): a captured-but-unstorable span
    // used to be silently destroyed with NO notice. The notice is now the
    // pure WARNING — it names the PATTERN (never the value), never claims a
    // store, and tells the owner to re-supply. Nothing-stored ⇒ no $ENVKEY.
    expect(mockQuestions.rows[0].answer).toMatch(/\[CREDENTIAL VAULTED — WARNING: 1 credential-shaped value was captured in this answer but could NOT be stored/);
    expect(mockQuestions.rows[0].answer).not.toMatch(/vault as \$[A-Z]/);
  });

  it('a MAXIMAL answer keeps the notice intact inside ANSWER_MAX (text gives way, never the envKey)', async () => {
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', `${'x'.repeat(9000)} ${FAKE_GH}`);
    const row = mockQuestions.rows[0];
    expect(row.answer.length).toBeLessThanOrEqual(8000);
    // The redacted text is capped, but the actionable notice (with $ENVKEY)
    // rides whole inside the cap.
    expect(row.answer).toMatch(/\[CREDENTIAL VAULTED — [^\n]*\$OWNER_ANSWER_[0-9A-Z]{8,11}\b/);
    expect(row.answer).toMatch(/Do not ask the owner to re-paste them\.\]$/);
    expect(row.answer).not.toContain(FAKE_GH);
    expect(mockCreds).toHaveLength(1);
  });

  // ── Review findings (adversarial review of 44493555, 2026-10-16) ──────────

  it('B2 — a credential-carrying counter-question still classifies as a counter-question with the notice appended', async () => {
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    // The owner replies with the credential AND a question back — no ruling.
    await answerOwnerQuestion(r.question.id, 'u1', `here is the key ${FAKE_GH} — which environment did you want it for?`);
    const row = mockQuestions.rows[0];
    expect(row.answer).toContain(REDACTED_NOTE);
    expect(row.answer).toMatch(/\[CREDENTIAL VAULTED — [^\n]*\$OWNER_ANSWER_/);
    // Pre-fix behavior preserved: the row READS as a counter-question (the
    // trailing vault notice is bookkeeping, not the owner's words) — so the
    // gate sweeper, watchdog, digest and status card never treat it as a
    // decision.
    expect(isCounterQuestionRow(row)).toBe(true);
    expect(isCounterQuestionAnswer(row.answer, null)).toBe(true);
    // The vault leg still ran (the credential is delivered) — the
    // classification fix must not disable vaulting.
    expect(mockCreds).toHaveLength(1);
  });

  it('F1 — an AGENT-authored defaultOption is redacted at flag time (no credential rides into storage)', async () => {
    const FAKE_GH = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3j2'; // fixture
    const r = await flagOwnerQuestion({
      chatId: 'chat-agent', userId: 'u1',
      question: 'Which deploy environment should this ship to?',
      defaultAfterDays: 3, defaultOption: FAKE_GH,
    } as any);
    if (r.kind !== 'created') throw new Error('expected created');
    // The preset default NEVER stores the raw credential — it is agent text.
    expect(String((mockQuestions.rows[0] as any).defaultOption)).not.toContain(FAKE_GH);
    expect(String((mockQuestions.rows[0] as any).defaultOption)).toContain(REDACTED_NOTE);
  });

  it('N1 — MAX_CREDS_PER_USER exhaustion degrades silently: answer ok, no vault row, no notice (never blocks)', async () => {
    // 50 pre-existing credentials = the per-user cap (credentials.service
    // MAX_CREDS_PER_USER) — the vault write throws, the answer must survive.
    mockCreds = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, userId: 'u1', envKey: `EXISTING_${i}`, label: '' }));
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    // The mock's count (50) is what upsertCredential checks; make its upsert
    // throw like the real service does at the cap for a NEW envKey.
    const before = mockCreds.length;
    expect(await answerOwnerQuestion(r.question.id, 'u1', `use ${FAKE_GH} for the deploy`)).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.answer).toContain(REDACTED_NOTE);
    expect(row.answer).not.toContain('[CREDENTIAL VAULTED');
    expect(mockCreds.length).toBe(before); // nothing minted
  });

  it('N1 — the ask_user card sibling (resolveOwnerQuestionsForChatAnswer) routes + notices the SAME way', async () => {
    const { resolveOwnerQuestionsForChatAnswer } = await import('./owner-questions');
    const r = await flag({ chatId: 'chat-card' });
    if (r.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({
      chatId: 'chat-card', userId: 'u1',
      askedQuestion: 'Please paste the service-account JSON for the Drive watch',
      answer: INCIDENT_ANSWER,
    });
    expect(out.resolved).toBe(1);
    expect(mockCreds).toHaveLength(1);
    expect(decryptValue(mockCreds[0].valueEnc)).toBe(PEM_BLOCK);
    const row = mockQuestions.rows[0];
    expect(row.answer).toContain(REDACTED_NOTE);
    expect(row.answer).not.toContain(PEM_BODY_LINE);
    expect(row.answer).toMatch(/\[CREDENTIAL VAULTED — [^\n]*\$OWNER_ANSWER_/);
    // And the replay provenance guard on the sibling: a non-owner replay
    // never mints.
    const r2 = await flag({ chatId: 'chat-card', question: 'Same decision re-filed — paste the key again?' });
    if (r2.kind !== 'created') throw new Error('expected created');
    const out2 = await resolveOwnerQuestionsForChatAnswer({
      chatId: 'chat-card', userId: 'u1',
      askedQuestion: 'Same decision re-filed — paste the key again?',
      answer: INCIDENT_ANSWER, answeredBy: 'default',
    });
    expect(out2.resolved).toBe(1);
    expect(mockCreds).toHaveLength(1); // unchanged — replay refused
  });

  it('F1 — the sweeper replay of a stored NON-OWNER answer never vaults (launder chain severed)', async () => {
    const FAKE_GH = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3j2'; // fixture
    // Row 1: a question auto-answered with an agent preset default (pre-fix
    // this stored the raw credential; post-fix flag-time redaction already
    // broke the chain — this simulates the residual legacy row shape).
    const r1 = await flag({ chatId: 'chat-x' });
    if (r1.kind !== 'created') throw new Error('expected created');
    mockQuestions.rows[0].status = 'answered';
    mockQuestions.rows[0].answer = `use ${FAKE_GH} for the deploy [auto-answered with the flagger's preset default after 3 days with no owner answer]`;
    mockQuestions.rows[0].answeredBy = 'default';
    // Row 2: the SAME decision re-filed open on another surface — the
    // sweeper-(b) replay target.
    const r2 = await flag({ chatId: 'chat-x', question: 'Which deploy environment should this ship to — same decision, re-filed' });
    if (r2.kind !== 'created') throw new Error('expected created');
    // The replay with the stored row's provenance ('default') — the vault leg
    // must refuse: replayed non-owner text never mints a credential.
    const res = await answerOwnerQuestion(r2.question.id, 'u1', mockQuestions.rows[0].answer, { answeredBy: 'default' });
    expect(res).toBe('ok');
    expect(mockCreds).toHaveLength(0);
    const row2 = mockQuestions.rows.find((x: any) => x.id === r2.question.id);
    expect(String(row2.answer)).toContain(REDACTED_NOTE);
    expect(String(row2.answer)).not.toContain(FAKE_GH);
    expect(String(row2.answer)).not.toContain('[CREDENTIAL VAULTED');
    expect(String((row2 as any).answeredBy)).toBe('default');
  });
});
