/**
 * Todo 77c88942 item 2 (audit 2026-10-16 — monitor lesson 3): TYPED ANSWER
 * GATES on owner questions. Pins specimen (b):
 *
 * oq_211513ed + oq_483730f8 were both answered "yes public" 3 seconds apart
 * (04:33:13Z / 04:33:16Z 2026-10-16) — neither answer held a credential —
 * and the credential-gated Schooltime todo 746aa1c5 flipped in_progress 18
 * seconds later (04:33:31Z). The Fleet Supervisor's homework over 100
 * answered owner questions: 12 of 14 credential-ask cards were answered with
 * text holding NO credential.
 *
 * The fix checks STATE, not text: flag_owner_question declares the expected
 * answer type; a credential gate resolves ONLY when a store_secret receipt
 * for that envKey exists (item 1's channel) or the CodingCredential store
 * holds the key. Mismatched text is recorded on the row as a counter-question
 * and the gate stays shut.
 */
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
// The credential lift check reads runToolReceipt (ids.path envKey) then
// codingCredential (state fallback) — driven from these rows.
const receiptRows: any[] = [];
const credentialRows: any[] = [];
const runToolReceiptApi = {
  findFirst: jest.fn(async ({ where }: any) => {
    // Owner scoping rides the chat relation; the test rows carry userId.
    if (where?.chat?.userId && !receiptRows.some((r) => r.userId === where.chat.userId)) return null;
    const envKey: string | undefined = where?.ids?.path?.[0] === 'envKey' ? where.ids.string_starts_with : undefined;
    return receiptRows.find((r) => r.tool === 'store_secret' && r.ok === true && typeof envKey === 'string' && String(r.ids?.envKey ?? '').startsWith(envKey)) ?? null;
  }),
  findMany: jest.fn(async () => receiptRows.slice()),
};
const codingCredentialApi = {
  findFirst: jest.fn(async ({ where }: any) =>
    credentialRows.find((c) => c.userId === where?.userId && String(c.envKey).startsWith(where?.envKey?.startsWith ?? '')) ?? null),
};
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: { ...mockQuestions.crossModelChat, findFirst: jest.fn(async () => null) },
    runToolReceipt: runToolReceiptApi,
    codingCredential: codingCredentialApi,
    telegramLink: { findUnique: jest.fn(async () => null) },
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

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));

const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

const mockAppendAnsweredQuestionDirective: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnsweredQuestionDirective(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  answerOwnerQuestion,
  flagOwnerQuestion,
} from './owner-questions';
import { CREDENTIAL_REPLY_INSTRUCTION, CREDENTIAL_REPLY_WAKE_HEADER } from './owner-questions';
import { CHOICE_REPLY_INSTRUCTION, CHOICE_REPLY_WAKE_HEADER } from './owner-questions';
import { parseExpectedAnswerType, answerLooksLikeCredential, envKeysInText } from './credential-gate';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
  mockAppendAnsweredQuestionDirective.mockReset().mockResolvedValue(undefined);
  mockRecordLoopMetric.mockReset();
  receiptRows.length = 0;
  credentialRows.length = 0;
});

const flagCredentialGate = async (overrides: Record<string, unknown> = {}) => {
  const r = await flagOwnerQuestion({
    chatId: 'chat-1', userId: 'u1',
    question: 'SCHOOLTIME API KEY: please provide the SCHOOLTIME_API_KEY so the sweep can call the API.',
    machineTriggered: true,
    expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
    ...overrides,
  });
  if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.question;
};

// ── The parser ───────────────────────────────────────────────────────────────

describe('parseExpectedAnswerType', () => {
  it('parses the four declared shapes', () => {
    expect(parseExpectedAnswerType('free', 'any')).toEqual({ type: 'free' });
    expect(parseExpectedAnswerType('choice', 'any')).toEqual({ type: 'choice' });
    expect(parseExpectedAnswerType('yes_no', 'any')).toEqual({ type: 'yes_no' });
    expect(parseExpectedAnswerType('credential:SCHOOLTIME_API_KEY', 'any')).toEqual({ type: 'credential', envKey: 'SCHOOLTIME_API_KEY' });
    expect(parseExpectedAnswerType('credential:<SCHOOLTIME_API_KEY>', 'any')).toEqual({ type: 'credential', envKey: 'SCHOOLTIME_API_KEY' });
  });

  it('infers the envKey from the question when the flagger said bare "credential"', () => {
    expect(parseExpectedAnswerType('credential', 'Please paste your SCHOOLTIME_API_KEY here.'))
      .toEqual({ type: 'credential', envKey: 'SCHOOLTIME_API_KEY' });
  });

  it('bare "credential" with NO unambiguous key in the question stays credential with no envKey (fail-closed, never free-text)', () => {
    expect(parseExpectedAnswerType('credential', 'Can you send the keys?')).toEqual({ type: 'credential' });
    expect(parseExpectedAnswerType('credential:', 'Can you send the keys?')).toEqual({ type: 'credential' });
  });

  it('null/empty/junk degrade to null (legacy free-text behavior)', () => {
    expect(parseExpectedAnswerType(null, 'any')).toEqual({ type: null });
    expect(parseExpectedAnswerType('', 'any')).toEqual({ type: null });
    expect(parseExpectedAnswerType('gibberish', 'any')).toEqual({ type: null });
  });

  it('envKeysInText finds ENVKEY-shaped tokens only', () => {
    expect(envKeysInText('SCHOOLTIME_API_KEY and AWS_SECRET_KEY too')).toEqual(['SCHOOLTIME_API_KEY', 'AWS_SECRET_KEY']);
    expect(envKeysInText('no keys here')).toEqual([]);
  });
});

describe('answerLooksLikeCredential', () => {
  // Assemble the PEM fixture headers via helpers — no contiguous header
  // literal in source lines (same pattern as b929b0ee8's PEM fixtures).
  const pemFixture = (label: string) => `-----BEGIN ${label}-----\nMIIE...\n-----END ${label}-----`;
  it('flags PEM blocks and long opaque tokens', () => {
    expect(answerLooksLikeCredential(pemFixture('RSA PRIVATE KEY'))).toBe(true);
    expect(answerLooksLikeCredential('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IWDJSNIyR2QvGhUiQ')).toBe(true);
  });
  it('does not flag prose', () => {
    expect(answerLooksLikeCredential('yes public')).toBe(false);
    expect(answerLooksLikeCredential('Please use the other one.')).toBe(false);
  });
});

// ── Specimen (b): the "yes public" pair must NOT open the gate ──────────────

describe('credential gate vs the oq_211513ed/oq_483730f8 specimen', () => {
  it('flag stores the declared type; a "yes public" answer REFUSES to resolve and keeps the row OPEN', async () => {
    const q = await flagCredentialGate();
    expect(q.status).toBe('open');
    expect((q as any).expectedAnswerType).toBe('credential:SCHOOLTIME_API_KEY');

    // No receipt, no stored credential — the owner answers with text.
    // 2026-10-20: the owner's WORDS are a counter-question — the reply is
    // delivered + the lane is WOKEN to answer on the card, and the surfaces
    // get reply_recorded (the info toast), never the red credential banner.
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
    expect(r).toBe('reply_recorded');

    // The row stayed open: no flip, no wake-as-DECISION, no gate fan-out.
    const after = mockQuestions.rows.find((row) => row.id === q.id);
    expect(after.status).toBe('open');
    expect(after.resolvedAt).toBeNull();
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
    // The mismatch record quotes the owner's words.
    expect(String(after.answer)).toContain('yes public');
    // f3a69ed3: the record is the OWNER-FACING block — it still says the gate
    // did not resolve (recorded, not yet an answer) and where the reply went;
    // the legacy 'gate still shut — conversation, not the key' phrasing is
    // retired with the legacy record format (parseOwnerRecordedReply reads
    // BOTH, so 2026-10-16→21-era rows keep rendering on the card).
    expect(String(after.answer)).toContain('recorded, not yet an answer');
    expect(String(after.answer)).toContain('the agent was woken with it');
    // The observe-only metric fired (now with the conversational flag).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_type_mismatch', meta: expect.objectContaining({ expectedType: 'credential', envKey: 'SCHOOLTIME_API_KEY', conversational: true, woken: true }) }),
    );
    // The lane was woken ONCE with the credential counter-question wake — the
    // question (with its id, so supersedes can name it), the owner's words,
    // and the answer-on-the-card instruction; never the decision header.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.sessionId).toBe('chat-1');
    expect(wake.prompt.startsWith(CREDENTIAL_REPLY_WAKE_HEADER)).toBe(true);
    expect(wake.prompt).toContain(`(question id ${q.id})`);
    expect(wake.prompt).toContain('Owner replied: "yes public"');
    expect(wake.prompt).toContain(CREDENTIAL_REPLY_INSTRUCTION);
    expect(wake.prompt).not.toContain('OWNER just answered');
    expect(wake.prompt).not.toContain('Act on this answer now');
    // The transcript note tells the lane the same thing.
    const notes = mockQuestions.crossModelMessage.create.mock.calls.map((c: any) => String(c[0].data.content));
    expect(notes.some((n) => n.includes('you are being woken now — answer the owner ON THE CARD'))).toBe(true);
  });

  it('2026-10-20: the ctrl.cql.ca specimen — "i never got the json policy" wakes the lane with the question context echoed', async () => {
    const q = await flagCredentialGate({
      question: 'Whenever convenient: paste the canlaw-bucket access key you created with the read-only policy I sent, so the corridor snapshot fetch can run.',
      context: 'Policy JSON:\n```json\n{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::cql-canlaw-cpt/*"}]}\n```',
      expectedAnswerType: 'credential:CANLAW_BUCKET_ACCESS_KEY',
    });
    const r = await answerOwnerQuestion(q.id, 'u1', 'i never got the json policy to copy...');
    expect(r).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === q.id).status).toBe('open');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.prompt).toContain('Owner replied: "i never got the json policy to copy..."');
    expect(wake.prompt).toContain('[Question context — as filed with the flag]');
    expect(wake.prompt).toContain('cql-canlaw-cpt');
    expect(wake.prompt).toContain('supersedes:<this question id>');
  });

  it('2026-10-20: CREDENTIAL_REPLY_WAKE_DISABLED=1 restores the pre-fix answer — credential_pending, note only, no wake', async () => {
    process.env.CREDENTIAL_REPLY_WAKE_DISABLED = '1';
    try {
      const q = await flagCredentialGate();
      const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
      expect(r).toBe('credential_pending');
      expect(mockFireScheduleTarget).not.toHaveBeenCalled();
      const after = mockQuestions.rows.find((row) => row.id === q.id);
      expect(after.status).toBe('open');
      expect(String(after.answer)).not.toContain('conversation, not the key');
    } finally {
      delete process.env.CREDENTIAL_REPLY_WAKE_DISABLED;
    }
  });

  it('2026-10-20: a replayed preset DEFAULT (not fresh owner input) on a credential gate never wakes the lane', async () => {
    const q = await flagCredentialGate();
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public', { answeredBy: 'default' });
    expect(r).toBe('credential_pending');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockQuestions.rows.find((row) => row.id === q.id).status).toBe('open');
  });

  // ── ccc2e7ad: the gate surfaces must name ALL three lift channels ─────────
  // The pre-fix wake note said the gate opens "ONLY when the key is stored
  // via store_secret" while credentialLifted() also lifts on the
  // CodingCredential row (the Account UI / a key stored before the receipt
  // channel existed) and the card key-field paste lifts the bare-key case.
  // A lane reading the note could tell the owner their already-stored key
  // "won't work" — the exact accuracy class f7b86353 fixed in the schema.
  it('ccc2e7ad: the inbox note names all three lift channels (store_secret, the card key field, the Account UI) — never store_secret only', async () => {
    const q = await flagCredentialGate();
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
    expect(r).toBe('reply_recorded');
    const notes = mockQuestions.crossModelMessage.create.mock.calls.map((c: any[]) => String(c[0]?.data?.content ?? ''));
    const note = notes.find((n: string) => n.includes('The gate stays SHUT'));
    expect(note).toBeTruthy();
    // The accurate channel list — all three, in the note the lane reads.
    expect(note).toContain("via store_secret, the card's key field or the Account UI");
    // The store_secret-only inaccuracy is gone from every surface.
    expect(note).not.toContain('stored via store_secret');
    expect(note).not.toContain('store_secret for SCHOOLTIME_API_KEY');
  });

  it('ccc2e7ad: the mismatch record on the row names all three channels too (the counter-question guidance)', async () => {
    const q = await flagCredentialGate();
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
    expect(r).toBe('reply_recorded');
    const after = mockQuestions.rows.find((row) => row.id === q.id);
    // f3a69ed3: the owner-facing block names the lift channels in the reason.
    expect(String(after.answer)).toContain('recorded, not yet an answer');
    expect(String(after.answer)).toContain("store_secret / Account → Coding credentials");
    // store_secret-only phrasing never rides the row.
    expect(String(after.answer)).not.toContain('credential via store_secret');
  });

  it('ccc2e7ad: a BARE credential gate (no envKey) says the key-field paste is its only lift — accurate, not store_secret', async () => {
    const q = await flagCredentialGate({
      question: 'Can you send the keys?',
      expectedAnswerType: 'credential',
    });
    expect((q as any).expectedAnswerType).toBe('credential:');
    // Bare by construction: the stored declaration parses to no envKey.
    expect(parseExpectedAnswerType((q as any).expectedAnswerType, q.question)).toEqual({ type: 'credential' });
    const r = await answerOwnerQuestion(q.id, 'u1', 'later, i will add it in settings');
    expect(r).toBe('reply_recorded');
    const notes = mockQuestions.crossModelMessage.create.mock.calls.map((c: any[]) => String(c[0]?.data?.content ?? ''));
    const note = notes.find((n: string) => n.includes('The gate stays SHUT'));
    expect(note).toBeTruthy();
    // No declared envKey ⇒ no store_secret/Account-UI lookup can lift it —
    // only a later answer's key-field paste (the ad4fae90 lift path).
    expect(note).toContain("no envKey declared, so only a later answer's key-field paste can lift it");
    expect(note).not.toContain('stored via store_secret');
  });

  it('ccc2e7ad: CREDENTIAL_REPLY_INSTRUCTION (the wake the lane receives) names all three channels', async () => {
    // The instruction is a module constant pinned here so a future wording
    // edit cannot silently drop a channel again (the f7b86353 diet class).
    expect(CREDENTIAL_REPLY_INSTRUCTION).toContain('store_secret');
    expect(CREDENTIAL_REPLY_INSTRUCTION).toContain("the card's key field");
    expect(CREDENTIAL_REPLY_INSTRUCTION).toContain('the Account UI');
    expect(CREDENTIAL_REPLY_INSTRUCTION).not.toContain('key lands in the vault (the card');
  });

  it('a credential-shaped PASTE also keeps the gate shut (the value never lands in a question row)', async () => {
    const q = await flagCredentialGate();
    const paste = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IWDJSNIyR2QvGhUiQ';
    const r = await answerOwnerQuestion(q.id, 'u1', paste);
    expect(r).toBe('credential_pending');
    const after = mockQuestions.rows.find((row) => row.id === q.id);
    expect(after.status).toBe('open');
    // The record warns the paste was NOT stored — the value must go through store_secret.
    expect(String(after.answer)).toContain('looked like a pasted credential');
    // 2026-10-20: a paste-shaped reply is NOT a counter-question — no wake
    // (the lane gains nothing from "not stored"; the toast's "use the key
    // field" is the right guidance), and the paste never rides the wake.
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
  });

  it('the gate RESOLVES once a store_secret receipt for that envKey exists (state, not text)', async () => {
    const q = await flagCredentialGate();
    receiptRows.push({
      id: 'r-1', userId: 'u1', tool: 'store_secret', ok: true,
      ids: { envKey: 'SCHOOLTIME_API_KEY' },
    });
    const r = await answerOwnerQuestion(q.id, 'u1', 'stored it just now');
    expect(r).toBe('ok');
    const after = mockQuestions.rows.find((row) => row.id === q.id);
    expect(after.status).toBe('answered');
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalled();
  });

  it('a receipt for a DIFFERENT envKey does not lift the gate', async () => {
    const q = await flagCredentialGate();
    receiptRows.push({ id: 'r-2', userId: 'u1', tool: 'store_secret', ok: true, ids: { envKey: 'OTHER_KEY' } });
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
    // 2026-10-20: words → reply_recorded (lane woken); the gate is still shut.
    expect(r).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === q.id).status).toBe('open');
  });

  it('a refusal receipt (ok:false — the call ran but did NOT store) does not lift the gate', async () => {
    const q = await flagCredentialGate();
    receiptRows.push({ id: 'r-3', userId: 'u1', tool: 'store_secret', ok: false, ids: {} });
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes public');
    expect(r).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === q.id).status).toBe('open');
  });

  it('a pre-channel stored credential (CodingCredential row) also lifts the gate — state, not channel', async () => {
    const q = await flagCredentialGate();
    credentialRows.push({ id: 'c-1', userId: 'u1', envKey: 'SCHOOLTIME_API_KEY' });
    const r = await answerOwnerQuestion(q.id, 'u1', 'yes I stored it earlier');
    expect(r).toBe('ok');
  });

  it('a labeled store (ids.envKey = ENVKEY_LABEL) lifts the base-key gate', async () => {
    const q = await flagCredentialGate();
    receiptRows.push({ id: 'r-4', userId: 'u1', tool: 'store_secret', ok: true, ids: { envKey: 'SCHOOLTIME_API_KEY_WORK' } });
    const r = await answerOwnerQuestion(q.id, 'u1', 'done');
    expect(r).toBe('ok');
  });
});

// ── Triage routing: a credential ask is OWNER-ONLY ──────────────────────────

describe('credential asks never route to a supervisor', () => {
  it('a machine-flagged credential ask classified supervisor-side is forced to the owner', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'What are your credentials for the provider? Please bank the SCHOOLTIME_API_KEY.',
      machineTriggered: true,
      expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
    });
    if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
    expect((r.question as any).triage ?? null).toBeNull(); // never triaged
  });
});

// ── The bypass surfaces ──────────────────────────────────────────────────────

describe('typed gates bypass-proofing', () => {
  it('applyDefaultAnswerIfDue never auto-answers a typed gate', async () => {
    const q = await flagCredentialGate({ defaultAfterDays: 1, defaultOption: 'no' });
    const { applyDefaultAnswerIfDue } = await import('./owner-questions');
    const fired = await applyDefaultAnswerIfDue(
      { ...q, createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } as any,
    );
    expect(fired).toBe(false);
  });

  it('a duplicate same-decision question does NOT resolve from the credential row\'s own answer', async () => {
    // Two identical credential asks (the specimen pair shape) — DISTINCT
    // question texts so the flag-time open-dupe refusal doesn't fire first.
    const mk = (n: number) => flagOwnerQuestion({
      chatId: `chat-${n}`, userId: 'u1',
      question: `SCHOOLTIME API KEY (attempt ${n}): please provide the SCHOOLTIME_API_KEY so the sweep can call the API.`,
      machineTriggered: true,
      expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
    });
    const q1 = (await mk(1));
    if (q1.kind !== 'created') throw new Error('expected created');
    // q1 resolves legitimately (receipt exists)…
    receiptRows.push({ id: 'r-5', userId: 'u1', tool: 'store_secret', ok: true, ids: { envKey: 'SCHOOLTIME_API_KEY' } });
    expect(await answerOwnerQuestion(q1.question.id, 'u1', 'stored')).toBe('ok');
    // …a second credential gate with NO state behind it still refuses text.
    const q3 = (await mk(3));
    if (q3.kind !== 'created') throw new Error('expected created');
    receiptRows.length = 0; // state gone again
    expect(await answerOwnerQuestion(q3.question.id, 'u1', 'yes public')).toBe('reply_recorded'); // words: lane woken, gate still shut (2026-10-20)
    expect(mockQuestions.rows.find((row) => row.id === q3.question.id).status).toBe('open');
  });

  it('a yes_no gate refuses a non-ruling answer and stays open', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Should we make the project public?',
      expectedAnswerType: 'yes_no',
    });
    if (r.kind !== 'created') throw new Error('expected created');
    // The counter-question shape the specimen used on a DECISION gate.
    const res = await answerOwnerQuestion(r.question.id, 'u1', 'what would that change about the keys?');
    // Todo 0dd7d3f2: the choice/yes_no mismatch branch returns its OWN code —
    // the reply reached the asking chat as conversation; credential_pending
    // belongs ONLY to credential gates (specimen oq_17b85b72 showed the owner
    // the credential banner on a choice card).
    expect(res).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('open');
  });

  it('a yes_no gate resolves on a real ruling', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Should we make the project public?',
      expectedAnswerType: 'yes_no',
    });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes public')).toBe('ok');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('answered');
  });

  it('a choice gate requires a typed-option match', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Which region for the new box?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'ca-central-1' }, { id: 'b', label: 'us-east-1' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'whichever is cheaper?')).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('open');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
  });

  it('todo 0dd7d3f2: a LONG non-matching reply on a choice card returns reply_recorded and the FULL text reaches BOTH the row and the inbox note', async () => {
    // The monitor-reported incident (specimen oq_17b85b72, 2026-10-18): the
    // owner typed a long reply (policy lines + a pasted console error) on a
    // CHOICE card. Pre-fix behavior: the return code was credential_pending
    // (wrong banner: "needs a credential") and the reply reached the asking
    // chat clipped to 200 chars (note) / 300 chars (row) — the console error
    // at the tail was lost. Post-fix: the card says the reply was sent as
    // conversation, and ANSWER_MAX-length text (8000) rides both surfaces.
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Security: how should we respond to the password-guessing campaign?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'Lock the account' }, { id: 'b', label: 'Rate-limit the source IPs' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const tail = 'CONSOLE-ERROR-FULL-TAIL-502-BAD-GATEWAY-TRACEBACK-END';
    // ~4,050 chars: 13x the old 300-char row clip. The row gives the reply
    // its own headroom inside ANSWER_MAX (review finding 2) — the bracket
    // never eats the reply's tail; the note carries the reply verbatim.
    const longReply = `${'Policy line: rotate the exposed credentials before anything else. '.repeat(60)}${tail}`;
    expect(longReply.length).toBeGreaterThan(3000); // well past the old 200/300 clips
    const res = await answerOwnerQuestion(r.question.id, 'u1', longReply);
    expect(res).toBe('reply_recorded');

    // The row keeps the FULL reply (not the 300-char excerpt) — ANSWER_MAX
    // headroom: the record is bracket text + the reply, sliced together.
    const after = mockQuestions.rows.find((row) => row.id === r.question.id);
    expect(after.status).toBe('open');
    expect(String(after.answer)).toContain(tail);
    expect(String(after.answer).length).toBeGreaterThan(4000);

    // The inbox note carries the full reply too (not the 200-char excerpt).
    const note = mockQuestions.crossModelMessage.create.mock.calls
      .map((c: any[]) => String(c[0]?.data?.content ?? ''))
      .find((s: string) => s.includes('does not resolve it'));
    expect(note).toBeTruthy();
    expect(note).toContain(tail);

    // The gate stays shut and the mismatch metric still fires (expectedType
    // is the row's own type, never 'credential' for a choice card).
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_type_mismatch', meta: expect.objectContaining({ expectedType: 'choice' }) }),
    );

    // A later typed-option pick still resolves the card (the reply is not
    // stuck: the card stays open and answerable).
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'Lock the account')).toBe('ok');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('answered');
  });

  it('todo 0dd7d3f2 (review MINOR-1): a MAXIMAL reply (at ANSWER_MAX) keeps its tail on BOTH the row and the inbox note', async () => {
    // The literal bar: "the full reply up to ANSWER_MAX into BOTH the inbox
    // note and the row". An earlier version capped the reply at
    // ANSWER_MAX − bracket inside the row and reused that same string for
    // the note — a maximal reply lost ~83 tail chars on both surfaces. The
    // reply itself (already ANSWER_MAX-capped upstream) now rides verbatim.
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Which launch posture?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'enabled by default' }, { id: 'b', label: 'staged off' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const tail = 'MAXIMAL-REPLY-TAIL-MARKER-918273645-END';
    // The filler must NOT be opaque-token-shaped (no spaces → the finding-3
    // withholding guard correctly takes it — that is a different test).
    const filler = 'filler words with spaces and punctuation, definitely not a token shape. '.repeat(200).slice(0, 8000 - tail.length);
    const maximalReply = `${filler}${tail}`;
    expect(maximalReply.length).toBe(8000); // exactly ANSWER_MAX
    const res = await answerOwnerQuestion(r.question.id, 'u1', maximalReply);
    expect(res).toBe('reply_recorded');
    const after = mockQuestions.rows.find((row) => row.id === r.question.id);
    expect(after.status).toBe('open');
    expect(String(after.answer)).toContain(tail); // row keeps the tail
    const note = mockQuestions.crossModelMessage.create.mock.calls
      .map((c: any[]) => String(c[0]?.data?.content ?? ''))
      .find((s: string) => s.includes('does not resolve it'));
    expect(note).toBeTruthy();
    expect(note).toContain(tail); // note keeps the tail too
  });

  it('todo 0dd7d3f2: a choice-gate mismatch NEVER reports credential_pending (the wrong-banner class)', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Launch posture for the hardened browser?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'enabled by default' }, { id: 'b', label: 'staged off until I flip it' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const res = await answerOwnerQuestion(r.question.id, 'u1', 'does enabled-by-default expose the debug endpoints?');
    expect(res).not.toBe('credential_pending');
    expect(res).toBe('reply_recorded');
    // No credential vocabulary anywhere the owner would see it.
    const after = mockQuestions.rows.find((row) => row.id === r.question.id);
    expect(String(after.answer)).not.toContain('credential via store_secret');
  });

  it('todo 0dd7d3f2 (review finding 3): an opaque token pasted on a CHOICE card is withheld from the row and the note — never quoted in full', async () => {
    // The widening gave the choice branch 8,000-char quoting; the credential
    // branch's ad4fae90 rule (shapes the scanner does not know are stored,
    // never quoted) applies here too — an unknown-shape secret must not ride
    // the question row or the transcript note.
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Pick the launch posture?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'enabled by default' }, { id: 'b', label: 'staged off' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const token = 'stg_live_9f8e7d6c5b4a3210fedcba9876543210';
    const res = await answerOwnerQuestion(r.question.id, 'u1', token);
    expect(res).toBe('reply_recorded');
    const after = mockQuestions.rows.find((row) => row.id === r.question.id);
    expect(after.status).toBe('open');
    expect(String(after.answer)).not.toContain(token);
    const note = mockQuestions.crossModelMessage.create.mock.calls
      .map((c: any[]) => String(c[0]?.data?.content ?? ''))
      .find((s: string) => s.includes('does not resolve it'));
    expect(note).toBeTruthy();
    expect(note).not.toContain(token);
    expect(note).toContain('opaque token was pasted');
  });

  it('legacy free-text rows (no expectedAnswerType) keep resolving on any answer', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Any other context for the sweep?',
    });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes public')).toBe('ok');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('answered');
  });
});

// ── Ticket c1714329 (2026-10-21): residuals over main's f3a69ed3 wake ───��───
// The wake itself (a fresh owner reply on a choice/yes_no card wakes the
// filing lane) landed on main as PR #1873 (f3a69ed3) while this ticket's
// first fix was in review. This block pins the c1714329 residuals:
//  (1) the sweeper dupe-replay guard — the dupe arm re-delivers an
//      owner-answered row's text onto still-open gated dupes every 5-minute
//      pass for a 24h lookback; without `replayed` that arm would re-fire
//      the f3a69ed3 wake every sweep (a wake loop on exactly the lanes the
//      wake exists to free);
//  (2) opaque-token withholding in the WAKE prompt — main's f3a69ed3 wake
//      quoted `trimmed`, so an unknown-shape secret pasted onto a choice
//      card would ride the wake verbatim (the ad4fae90 rule says quoted
//      surfaces never carry unknown-shape secrets);
//  (3) the specimen still wakes with the full context (regression pin).
describe('c1714329 residual: the f3a69ed3 choice-gate wake is replay-safe and never quotes opaque tokens', () => {
  it('the ticket specimen: executable instruction on a yes_no card wakes the lane with the owner\'s words + question id + context', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Should the cql-accelerator lane retry the tailscale join?',
      context: 'The tailscale json config is open and logged in on mbp-1.',
      expectedAnswerType: 'yes_no',
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const res = await answerOwnerQuestion(
      r.question.id, 'u1',
      'use my mbp-1 remote computer use to fix tailscale json i have it open and logged in',
    );
    expect(res).toBe('reply_recorded');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('open');
    // The wake: exactly one, to the FILING chat, with the header, the
    // question (id so supersedes can name it), the owner's words verbatim,
    // the filed context, and the instruction.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.sessionId).toBe('chat-1');
    expect(String(wake.prompt).startsWith(CHOICE_REPLY_WAKE_HEADER)).toBe(true);
    expect(String(wake.prompt)).toContain(`(question id ${r.question.id})`);
    expect(String(wake.prompt)).toContain('Owner replied: "use my mbp-1 remote computer use to fix tailscale json i have it open and logged in"');
    expect(String(wake.prompt)).toContain('[Question context — as filed with the flag]');
    expect(String(wake.prompt)).toContain('mbp-1');
    expect(String(wake.prompt)).toContain(CHOICE_REPLY_INSTRUCTION);
    // It is the counter-question wake, never a decision header.
    expect(String(wake.prompt)).not.toContain('OWNER just answered');
    expect(String(wake.prompt)).not.toContain('Act on this answer now');
    // The mismatch metric carries the wake stamp; the gate unblock never ran.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_type_mismatch', meta: expect.objectContaining({ expectedType: 'yes_no', woken: true }) }),
    );
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
    // The transcript note tells the lane the same thing.
    const notes = mockQuestions.crossModelMessage.create.mock.calls.map((c: any) => String(c[0].data.content));
    expect(notes.some((n: string) => n.includes('You are being woken NOW with the owner\'s words'))).toBe(true);
    // A later typed ruling still resolves the card (the reply is not stuck).
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes')).toBe('ok');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('answered');
  });

  it('a CHOICE card wakes on non-matching words too (the choice twin of the yes_no case)', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Which region for the new box?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'ca-central-1' }, { id: 'b', label: 'us-east-1' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'whichever is cheaper?')).toBe('reply_recorded');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(String(mockFireScheduleTarget.mock.calls[0][0].prompt)).toContain('whichever is cheaper?');
    expect(mockQuestions.rows.find((row) => row.id === r.question.id).status).toBe('open');
    // The card still resolves on the declared shape afterwards.
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
  });

  it('an opaque-token paste on a choice card NEVER wakes (main f3a69ed3 guard) and the token is withheld from every recorded surface', async () => {
    // Main's f3a69ed3 `conversationalChoice` excludes opaque-token shapes
    // outright — an unknown-shape secret pasted onto a choice card wakes
    // nobody (a wake prompt is a quoted surface; the ad4fae90 rule stores
    // unknown-shape secrets via the vault, never quotes them). This pin
    // holds that guard in place for BOTH the wake and the record.
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Pick the launch posture?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'enabled by default' }, { id: 'b', label: 'staged off' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const token = 'stg_live_c1714329fedcba9876543210abcdef01';
    const res = await answerOwnerQuestion(r.question.id, 'u1', token);
    expect(res).toBe('reply_recorded');
    // No wake fired — and no surface quoted the token.
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    const after = mockQuestions.rows.find((row) => row.id === r.question.id);
    expect(String(after.answer)).not.toContain(token);
    expect(String(after.answer)).toContain('opaque token was pasted');
    expect(after.status).toBe('open');
    // A later real decision still resolves the card.
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'b')).toBe('ok');
  });

  it('a sweeper REPLAY of stored answer text never wakes the lane (no 5-minute wake loop) — BOTH twins', async () => {
    // The owner-gate sweeper's dupe arm replays an owner-answered row's text
    // onto still-open rows every 5-min pass for a 24h lookback — with
    // answeredBy:'owner' and the row's real answer text. replayed:true marks
    // those calls; a wake there would re-fire a machine run every sweep.
    const r = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Which region for the new box?',
      expectedAnswerType: 'choice',
      options: [{ id: 'a', label: 'ca-central-1' }, { id: 'b', label: 'us-east-1' }],
    });
    if (r.kind !== 'created') throw new Error('expected created');
    const res = await answerOwnerQuestion(r.question.id, 'u1', 'whichever is cheaper?', { answeredBy: 'owner', replayed: true });
    expect(res).toBe('reply_recorded');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    // Non-owner provenance never wakes either (supervisor / default replay).
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'still cheaper?', { answeredBy: 'supervisor' })).toBe('reply_recorded');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'cheapest?', { answeredBy: 'default' })).toBe('reply_recorded');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    // The CREDENTIAL twin carries the same guard: an owner-answered row's
    // text replayed onto a credential-gated dupe (dupe.answeredBy 'owner' —
    // the sweeper's replayAnsweredBy) must not fire the credential wake
    // ('credential_pending' = recorded + noted, gate shut, NO wake).
    const q = await flagCredentialGate();
    const cred = await answerOwnerQuestion(q.id, 'u1', 'yes do it now please', { answeredBy: 'owner', replayed: true });
    expect(cred).toBe('credential_pending');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockQuestions.rows.find((row) => row.id === q.id).status).toBe('open');
  });
});
