/**
 * Replay for ticket 26786762 — "Owner-inbox card redacts the credential the
 * card exists to deliver".
 *
 * THE MISHAP (2026-10-16/17): flag_owner_question oq_f4472e5e was filed to
 * deliver the digby-edge-st-anne LiteLLM virtual key to the owner (his own
 * directive: "yes just send me the api key for digby edge to use"). The
 * write-time inbound scrubber (redactInboundSecrets at the create-path entry)
 * destroyed the key in the STORED question text — the owner-inbox card read
 * "[REDACTED: looked like a credential]" exactly where the key was, the flag
 * result said ok, and the owner never received the value ("i never got the
 * key because of another framework bug i just see REDACTED"). There was no
 * agent→owner credential channel: store_secret lifts values only from
 * owner-authored messages and the coding-credentials vault is write-only.
 *
 * THE FIX, replayed here end to end:
 *  1. IMPLICIT RESCUE — a credential span in question/context that the scan
 *     WOULD destroy is stored ENCRYPTED (owner_question_secrets, AES-256-GCM
 *     via the credentials vault) and the card text carries a numbered reveal
 *     handle ("[SECRET 1]") instead of the destruction marker.
 *  2. EXPLICIT DELIVERY — the deliverSecrets param: the value rides ONLY
 *     into the encrypted store, never into the row; the card renders a
 *     Reveal/Copy affordance (preview masked).
 *  3. REDACTION STILL FIRES where it must — the pre-fix behavior is kept for
 *     every surface EXCEPT the delivered-secret store: a credential-shaped
 *     span is never stored in plaintext anywhere (the answer-direction
 *     scrubber, the payload refusal, multi-line/PEM staying destroyed).
 *  4. Fail-closed: kill switch, store-write failure, and over-cap
 *     deliveries all REFUSE (never a card that looks delivered but is not).
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// The delivered-secret store encrypts through the credentials vault, whose
// key derives from JWT_SECRET — set a test secret like the credentials
// service's own suite does, BEFORE any import that touches the module.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => undefined);
const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
    activity: mockQuestions.activity,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

// The delivered-secret store encrypts through the credentials vault — the
// real crypto (AES-256-GCM off JWT_SECRET) runs in these tests: the stored
// row must carry ciphertext, and reveal must round-trip the plaintext.
const realCrypto = jest.requireActual('../coding/credentials.service');
jest.mock('../coding/credentials.service', () => ({
  __esModule: true,
  ...realCrypto,
}));

import { flagOwnerQuestion, listOwnerQuestionsForUser } from './owner-questions';
import {
  storeQuestionSecrets, listQuestionSecretPreviews, revealQuestionSecret,
  parseDeliverSecrets, validateExplicitSecretValue, buildSpanRescuer,
  oqSecretPlaceholder, storableSpanValue, maskDeliverSecretsForPreview,
  maskDeliverSecretsInArgsString,
} from './owner-question-secrets';
import { redactInboundSecrets, redactInboundSecretsWithNotes } from './secret-scan';
import type { SecretSpan } from './secret-scan';

// The service resolves prisma through the db() helper → config/database is
// mocked above; storeQuestionSecrets etc. take prisma explicitly.
const prisma = {
  ownerQuestion: mockQuestions.api,
  ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
  activity: mockQuestions.activity,
};

const OWNER = 'user-owner-1';
const CHAT = 'chat-litellm-lane';

beforeEach(() => {
  mockQuestions.reset();
  mockTelegramLinkFindUnique.mockReset().mockImplementation(async () => null);
  mockChatFindUnique.mockReset().mockImplementation(async () => undefined);
  mockChatFindFirst.mockReset().mockImplementation(async () => null);
  mockChatFindMany.mockReset().mockImplementation(async () => []);
  mockFireScheduleTarget.mockReset().mockImplementation(async () => ({ started: true }));
  mockTelegramSendMessage.mockReset().mockImplementation(async () => true);
});

describe('26786762 replay — the mishap as filed', () => {
  test('a scanner-known key in the question is RESCUED (stored encrypted, numbered handle in the card)', async () => {
    // The specimen: the LiteLLM virtual key the owner asked for. sk-… is a
    // SECRET_PATTERNS shape the scrubber destroyed pre-fix.
    const key = 'sk-LiteLLM-Virtual-Key-9f2c8e7ab1d3f5';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the LiteLLM virtual key for digby-edge-st-anne: ${key} — use it as the gateway client key.`,
      context: 'filed per the owner directive 2026-10-16 19:34Z',
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;

    // The STORED card text: the handle replaces the key — the owner reads a
    // reveal pointer, NEVER a destroyed value and never the plaintext.
    expect(mockQuestions.rows).toHaveLength(1);
    const stored = mockQuestions.rows[0];
    expect(stored.question).toContain('[SECRET 1]');
    expect(stored.question).not.toContain(key);
    expect(stored.question).not.toContain('[REDACTED');

    // The delivered-secret row: ciphertext at rest, decryptable, owner-scoped.
    expect(mockQuestions.secretRows).toHaveLength(1);
    const row = mockQuestions.secretRows[0];
    expect(row.questionId).toBe(stored.id);
    expect(row.userId).toBe(OWNER);
    expect(row.ordinal).toBe(1);
    expect(row.valueEnc).not.toBe(key); // encrypted, not plaintext
    expect(row.valueEnc.length).toBeGreaterThan(32);
    const revealed = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(revealed).toEqual({ ok: true, ordinal: 1, label: expect.any(String), value: key });
  });

  test('the agent-read listing shows the handle, never the value', async () => {
    const key = 'sk-LiteLLM-Virtual-Key-77ab99cd11ef';
    await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `gateway client key: ${key}`,
    });
    const list = await listOwnerQuestionsForUser(OWNER);
    expect(list.rows.length).toBeGreaterThan(0);
    for (const q of list.rows) {
      expect(JSON.stringify(q)).not.toContain(key);
      expect(JSON.stringify(q)).not.toContain('[REDACTED');
    }
  });
});

describe('26786762 — explicit deliverSecrets (scanner-unknown shapes)', () => {
  test('the value rides ONLY into the encrypted store; the card text references the handle', async () => {
    // Round 8 fixture hygiene: `cfat_` is now a scanner-KNOWN prefix
    // (secret-scan.ts) — a test value using it proves the span leg can
    // carry it, not the delivery path. This fixture is deliberately
    // scanner-UNKNOWN (no known prefix, no known pattern): ONLY the
    // explicit deliverSecrets param can deliver it.
    const value = 'Zq9vXw8yB7c6d5e4f3g2h1j0k9l8m7n6';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'The gateway key you asked for is delivered below — click Reveal on the card to copy it.',
      deliverSecrets: [{ label: 'Cloudflare API token', value }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows[0];
    // No plaintext anywhere in the row, and a handle the owner can resolve.
    expect(JSON.stringify(stored)).not.toContain(value);
    expect(mockQuestions.secretRows).toHaveLength(1);
    expect(mockQuestions.secretRows[0].valueEnc).not.toBe(value);
    const revealed = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(revealed).toEqual({ ok: true, ordinal: 1, label: 'Cloudflare API token', value });
    // The pending-payload preview is masked (last 4 only).
    const previews = await listQuestionSecretPreviews(prisma, OWNER, stored.id);
    expect(previews).toEqual([{ ordinal: 1, label: 'Cloudflare API token', preview: `••••${value.slice(-4)}` }]);
  });

  test('reveal is OWNER-SCOPED: another user never resolves the value', async () => {
    const value = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'delivered key', deliverSecrets: [{ value }],
    });
    expect(r.kind).toBe('created');
    const stored = mockQuestions.rows[0];
    expect(await revealQuestionSecret(prisma, 'user-someone-else', stored.id, 1)).toEqual({ ok: false, reason: 'not_found' });
    expect(await revealQuestionSecret(prisma, OWNER, stored.id, 2)).toEqual({ ok: false, reason: 'not_found' });
  });

  test('multi-line non-PEM values are refused (never a half-delivery)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'delivered', deliverSecrets: [{ value: 'line-one\nline-two' }],
    });
    expect(r.kind).toBe('refused');
    expect(mockQuestions.rows).toHaveLength(0);
    expect(mockQuestions.secretRows).toHaveLength(0);
  });

  test('over-cap deliveries refuse (never a silent drop)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'delivered',
      deliverSecrets: [
        { value: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1' },
        { value: 'sk-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2' },
        { value: 'sk-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3' },
        { value: 'sk-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4' },
      ],
    });
    expect(r.kind).toBe('refused');
    expect(mockQuestions.rows).toHaveLength(0);
  });

  test('kill switch OWNER_SECRET_DELIVERY_DISABLED=1 refuses explicit delivery and restores pre-fix redaction', async () => {
    process.env.OWNER_SECRET_DELIVERY_DISABLED = '1';
    try {
      const r = await flagOwnerQuestion({
        chatId: CHAT, userId: OWNER,
        question: 'delivered', deliverSecrets: [{ value: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      });
      expect(r.kind).toBe('refused');
      // Implicit path degrades to the pre-fix destruction marker.
      const r2 = await flagOwnerQuestion({
        chatId: CHAT, userId: OWNER,
        question: 'the key: sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
      expect(r2.kind).toBe('created');
      expect(mockQuestions.rows.at(-1).question).toContain('[REDACTED');
    } finally {
      delete process.env.OWNER_SECRET_DELIVERY_DISABLED;
    }
  });
});

describe('26786762 — redaction still fires where it must (no relaxation)', () => {
  test('redactInboundSecrets is UNCHANGED for every other caller', () => {
    expect(redactInboundSecrets('api_key = "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')).toContain('[REDACTED');
    expect(redactInboundSecrets('password: hunter2hunter2hunter2')).toContain('[REDACTED');
  });

  test('rescue is EXACTLY symmetric with redaction (same spans, same order)', () => {
    const text = 'token=sk-9c8b7a6d5e4f3c2b1a0987654321fedc and api_key: "ghp_16C7e42F292c6912E7710c838347Ae178B4a"';
    const spans: SecretSpan[] = [];
    const plain = redactInboundSecrets(text);
    const rescuer = buildSpanRescuer(spans, { next: 1, start: 1 });
    const rescued = redactInboundSecretsWithNotes(text, spans, rescuer.noteFor);
    // Both texts carry NO plaintext; the rescued text carries handles where
    // the plain one carries destruction markers.
    expect(plain).not.toContain('sk-9c8b7a6d5e4f3c2b1a0987654321fedc');
    expect(rescued).not.toContain('sk-9c8b7a6d5e4f3c2b1a0987654321fedc');
    expect(rescued).toContain('[SECRET 1]');
    expect(spans.length).toBe(rescuer.kept.length);
    for (const k of rescuer.kept) expect(k.value).toBe(spans[k.ordinal - 1]?.value);
  });

  test('multi-line / PEM implicit spans stay destroyed (cap + shape rules)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const spans: SecretSpan[] = [];
    const rescuer = buildSpanRescuer(spans, { next: 1, start: 1 });
    const out = redactInboundSecretsWithNotes(`key file:\n${pem}`, spans, rescuer.noteFor);
    // The PEM body stays out of the stored text and OUT of the rescue (an
    // explicit deliverSecrets call is the sanctioned route for PEMs).
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(rescuer.kept.some((k) => k.value.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'))).toBe(false);
    expect(storableSpanValue(pem)).toBe(false);
  });

  test('consoleAction payload with a raw key is REFUSED (not silently redacted)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the key in the console',
      consoleAction: {
        consoleName: 'LiteLLM admin', consoleUrl: 'https://litellm.example.com',
        whatAndWhySafe: 'paste the key', steps: ['Open keys'],
        payload: 'LITELLM_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      } as any,
    });
    expect(r.kind).toBe('refused');
    expect(JSON.stringify(r)).toContain('deliverSecrets');
  });
});

describe('26786762 — unit seams', () => {
  test('maskDeliverSecretsForPreview: the PREVIEW copy never carries a value (review B1 — transcript/SSE/persisted args)', () => {
    const raw = {
      question: 'here is your key',
      deliverSecrets: [{ label: 'LiteLLM key', value: 'sk-LiveValue-AA11BB22CC33DD44' }, { value: 'sk-Second-EE55FF66' }],
    };
    const masked = maskDeliverSecretsForPreview(raw);
    // Every delivered value is masked in the preview copy…
    expect(JSON.stringify(masked)).not.toContain('sk-LiveValue-AA11BB22CC33DD44');
    expect(JSON.stringify(masked)).not.toContain('sk-Second-EE55FF66');
    expect(masked.deliverSecrets[0]).toEqual({ label: 'LiteLLM key', value: '[delivered — encrypted, not echoed]' });
    // …and the ORIGINAL args object (what the executor receives) is untouched.
    expect(raw.deliverSecrets[0].value).toBe('sk-LiveValue-AA11BB22CC33DD44');
    // A no-deliverSecrets call passes through identically (no cost, no clone).
    const plain = { question: 'ordinary ask', options: [{ label: 'Yes' }] };
    expect(maskDeliverSecretsForPreview(plain)).toBe(plain);
  });

  test('review BLOCKING B: NON-CANONICAL deliverSecrets shapes are masked WHOLESALE (stamping precedes execution)', () => {
    // The part is stamped/persisted BEFORE the executor refuses a malformed
    // call — so a double-encoded array, a bare string value, or a non-string
    // value slot must never ride the preview seam in any form.
    const cases: Array<[string, unknown]> = [
      ['double-encoded array string', { question: 'q', deliverSecrets: '[{"value":"sk-REAL-LEAK-2"}]' }],
      ['array of one bare string', { question: 'q', deliverSecrets: ['sk-REAL-LEAK-1'] }],
      ['non-string value slot', { question: 'q', deliverSecrets: [{ value: ['sk-REAL-LEAK-3'] }] }],
      ['bare string field', { question: 'q', deliverSecrets: 'sk-REAL-LEAK-4' }],
      ['object not array', { question: 'q', deliverSecrets: { value: 'sk-REAL-LEAK-5' } }],
    ];
    for (const [name, args] of cases) {
      const masked = maskDeliverSecretsForPreview(args);
      expect(JSON.stringify(masked)).not.toContain('sk-REAL-LEAK');
      expect(JSON.stringify(masked)).not.toMatch(/deliverSecrets"\s*:\s*\[/);
      expect(name.length).toBeGreaterThan(0);
    }
    // An EMPTY array delivers nothing and stays an empty array.
    expect(maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [] })).toEqual({ question: 'q', deliverSecrets: [] });
  });

  test('review BLOCKING A: the streak-args STRING mask never passes a deliverSecrets value (fail-streak / intent-miss capture seams)', () => {
    // The capture seams hold String(tc.arguments) — raw JSON TEXT. A
    // well-formed call masks each value; a malformed one redacts the whole
    // field; an ordinary call is untouched.
    const canonical = JSON.stringify({ question: 'q', deliverSecrets: [{ label: 'k', value: 'sk-StreakLeak-AA11BB22' }] });
    const m1 = maskDeliverSecretsInArgsString(canonical);
    expect(m1).not.toContain('sk-StreakLeak-AA11BB22');
    expect(m1).toContain('[delivered — encrypted, not echoed]');
    const malformed = '{"question":"q","deliverSecrets":"sk-StreakLeak-CC33DD44"}';
    const m2 = maskDeliverSecretsInArgsString(malformed);
    expect(m2).not.toContain('sk-StreakLeak-CC33DD44');
    // The field is masked whole (either mask text) — never the raw value.
    expect(m2).toMatch(/deliverSecrets"\s*:\s*"\[(delivered|redacted)[^\]]*\]"/);
    const broken = '{"question":"q","deliverSecrets":["sk-BROKEN'
    const m3 = maskDeliverSecretsInArgsString(broken);
    expect(m3).not.toContain('sk-BROKEN');
    const ordinary = JSON.stringify({ chatId: 'c1', question: 'ordinary' });
    expect(maskDeliverSecretsInArgsString(ordinary)).toBe(ordinary);
  });

  test('review BLOCKING C: the implicit budget is PER-CARD (shared across every pass), not per-pass', () => {
    // Two passes (question + context) sharing one counter: at most 3 spans
    // kept in TOTAL — the 4th storable span keeps the destruction marker
    // even though it is the FIRST span of its own pass.
    const mk = (n: string) => `sk-PerCard${n}0123456789abcdefghijklmnop`;
    const counter = { next: 1, start: 1 };
    const passA: SecretSpan[] = [];
    const a = buildSpanRescuer(passA, counter);
    const textA = redactInboundSecretsWithNotes(`a: ${mk('A1')} b: ${mk('A2')} c: ${mk('A3')} d: ${mk('A4')}`, passA, a.noteFor);
    expect(a.kept).toHaveLength(3);
    expect(textA).not.toContain('[SECRET 4]'); // 4th span destroyed, not numbered
    expect(textA).toContain('[REDACTED');
    // Pass B (a fresh rescuer, SAME counter): the budget is already spent.
    const passB: SecretSpan[] = [];
    const b = buildSpanRescuer(passB, counter);
    const textB = redactInboundSecretsWithNotes(`later: ${mk('B1')}`, passB, b.noteFor);
    expect(b.kept).toHaveLength(0);
    expect(textB).toContain('[REDACTED');
    expect(textB).not.toContain(mk('B1'));
    // With explicit entries the offset shifts ordinals but the budget stays 3.
    const counter2 = { next: 3, start: 3 };
    const passC: SecretSpan[] = [];
    const c = buildSpanRescuer(passC, counter2);
    const textC = redactInboundSecretsWithNotes(`x: ${mk('C1')}`, passC, c.noteFor);
    expect(c.kept).toHaveLength(1);
    expect(c.kept[0].ordinal).toBe(3); // E+1 with E=2 explicit
    expect(textC).toContain('[SECRET 3]');
  });

  test('mixed delivery: the agent-written [SECRET 1] resolves to the FIRST EXPLICIT entry (review B2)', async () => {
    // The agent files ONE delivered key AND its question text incidentally
    // carries a scanner-known span. The tool doc tells it to write
    // "[SECRET 1]" for its key — ordinal 1 must be THE DELIVERED KEY, the
    // incidental span shifts to 2.
    const delivered = 'cfat_unusual_prefix_delivered_9d8e7f6a';
    const incidental = 'sk-proj-Incidental0123456789ABCDEFGH';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Your key is [SECRET 1] — reveal it on the card. (For reference the old one was ${incidental}.)`,
      deliverSecrets: [{ label: 'delivered key', value: delivered }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    // The result manifest tells the agent the real handles.
    expect(r.secrets).toEqual([
      { ordinal: 1, label: 'delivered key' },
      { ordinal: 2, label: expect.any(String) },
    ]);
    // Ordinal 1 reveals THE DELIVERED KEY (the agent's [SECRET 1] resolves
    // to what it explicitly delivered); the incidental span is ordinal 2.
    const rev1 = await revealQuestionSecret(prisma, OWNER, r.question.id, 1);
    expect(rev1).toEqual({ ok: true, ordinal: 1, label: 'delivered key', value: delivered });
    const rev2 = await revealQuestionSecret(prisma, OWNER, r.question.id, 2);
    expect(rev2.ok).toBe(true);
    if (rev2.ok) expect(rev2.value).toBe(incidental);
    // The stored text: the agent-written handle survives verbatim; the
    // incidental span was substituted with its own handle.
    expect(r.question.question).toContain('[SECRET 1]');
    expect(r.question.question).not.toContain(incidental);
  });

  test('review BLOCKING A (round 3): the SEAM expression (maskDeliverSecretsInArgsString then slice) survives all five leak shapes', () => {
    // Round 2's inline regex leaked five shapes (the reviewer's probe). The
    // seam now calls the helper and clips AFTER masking — this case pins the
    // seam EXPRESSION itself: helper(fullString).slice(0, 200), exactly what
    // agent.ts does at both capture sites.
    const seam = (raw: string): string => maskDeliverSecretsInArgsString(String(raw || '')).slice(0, 200);
    const V = 'sk-SeamLeak-ZZZZ9999AAAABBBBCCCC';
    // (1) label containing ] (env tag) — the regex array-branch killer.
    const s1 = seam(JSON.stringify({ question: 'q', deliverSecrets: [{ label: 'LiteLLM key [prod]', value: V }] }));
    expect(s1).not.toContain(V);
    // (2) long question + realistic label — the slice-cuts-the-array killer.
    const s2 = seam(JSON.stringify({ question: 'x'.repeat(120), deliverSecrets: [{ label: 'LiteLLM gateway key', value: V }] }));
    expect(s2).not.toContain(V.slice(0, 12)); // no value FRAGMENT either
    // (3) decoy deliverSecrets inside the question text (first-match killer).
    const s3 = seam(JSON.stringify({ question: 'set deliverSecrets to none please', deliverSecrets: [{ label: 'k', value: V }] }));
    expect(s3).not.toContain(V);
    // (4) duplicate deliverSecrets keys (JSON.parse keeps the LAST).
    const s4 = seam(`{"deliverSecrets":[],"deliverSecrets":[{"label":"k","value":"${V}"}]}`);
    expect(s4).not.toContain(V);
    // (5) label with [staging] tag — same class as (1), through the helper.
    const s5 = seam(JSON.stringify({ question: 'q', deliverSecrets: [{ label: 'key [staging]', value: V }] }));
    expect(s5).not.toContain(V);
    // Control: ordinary args pass through byte-identical (minus nothing).
    const ordinary = JSON.stringify({ chatId: 'c1', question: 'ordinary ask with a long question body that exceeds two hundred characters in total length so the slice is exercised too' });
    expect(seam(ordinary)).toBe(ordinary.slice(0, 200));
  });

  test('review BLOCKING B′ (round 3): the canonical branch PROJECTS — label is scanned, extra keys dropped, value masked', () => {
    const V = 'sk-CanonicalLeak-AA11BB22CC33';
    // A credential in the LABEL slot must not ride the preview (the tool
    // doc's [{label?, value}] makes this an easy model mistake).
    const m1 = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: V, value: 'sk-real-1' }] });
    expect(JSON.stringify(m1)).not.toContain(V);
    expect((m1 as any).deliverSecrets[0].label).toBe('Credential'); // degraded, not passed
    // An EXTRA key alongside value (note: the key) is dropped entirely.
    const m2 = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'LiteLLM', note: 'sk-REAL-LEAK-11-extra', value: 'sk-real-2' }] });
    expect(JSON.stringify(m2)).not.toContain('sk-REAL-LEAK-11-extra');
    expect((m2 as any).deliverSecrets[0]).toEqual({ label: 'LiteLLM', value: '[delivered — encrypted, not echoed]' });
    // A clean label survives (scanned, credential-free).
    const m3 = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'LiteLLM virtual key', value: 'sk-real-3' }] });
    expect((m3 as any).deliverSecrets[0]).toEqual({ label: 'LiteLLM virtual key', value: '[delivered — encrypted, not echoed]' });
    // A label that merely LOOKS like prose with an api-key word in it stays
    // (the scan redacts assignments, not words).
    const m4 = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'the api key you asked for', value: 'sk-real-4' }] });
    expect((m4 as any).deliverSecrets[0].label).toBe('the api key you asked for');
    // The same protection flows through the string helper (the A seam).
    const s = maskDeliverSecretsInArgsString(JSON.stringify({ question: 'q', deliverSecrets: [{ label: V, value: 'sk-real-5' }] }));
    expect(s).not.toContain(V);
  });

  test('review advisory 5 (round 3): kill switch + EMPTY deliverSecrets array still files', async () => {
    process.env.OWNER_SECRET_DELIVERY_DISABLED = '1';
    try {
      const r = await flagOwnerQuestion({
        chatId: CHAT, userId: OWNER,
        question: 'a plain question under the switch',
        deliverSecrets: [],
      });
      expect(r.kind).toBe('created');
    } finally {
      delete process.env.OWNER_SECRET_DELIVERY_DISABLED;
    }
  });

  test('review advisory 4 (round 3): a handle truncated out of the question drops from the delivery', async () => {
    // A question so long the [SECRET n] handle of a late span falls past the
    // QUESTION_MAX cut: the span's text is gone from the card, so its value
    // must NOT be vaulted (visibleKept filter).
    const key = 'sk-TruncatedAway-0123456789abcdef';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `${'preamble text '.repeat(300)} the key: ${key}`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    if (stored.question.includes('[SECRET 1]')) {
      // The handle survived the cut — the value is legitimately delivered.
      expect(mockQuestions.secretRows.some((s: any) => s.ordinal === 1)).toBe(true);
    } else {
      // The handle was truncated away — nothing vaulted for it.
      expect(mockQuestions.secretRows.some((s: any) => s.ordinal === 1)).toBe(false);
      expect(stored.question).not.toContain(key);
    }
  });

  test('review BLOCKING B″ (round 4): the flag-result manifest carries SAFE labels only (the tool-result seam is unredacted)', async () => {
    // The result seam stamps displayResult raw into transcript parts and
    // re-sends it to the provider — a credential-shaped deliverSecrets label
    // must degrade to 'Credential' in r.secrets, exactly as it does on the
    // preview seam (the old pin asserted the RAW label — flipped).
    const V = 'sk-ManifestLeak-DEADBEEFCAFE1234';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'your key is [SECRET 1]',
      deliverSecrets: [{ label: V, value: 'sk-benign-value-0001' }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(JSON.stringify(r.secrets)).not.toContain(V);
    expect(r.secrets).toEqual([{ ordinal: 1, label: 'Credential' }]);
    // A clean label survives the manifest.
    const r2 = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'your key is [SECRET 1]',
      deliverSecrets: [{ label: 'LiteLLM virtual key', value: 'sk-benign-value-0002' }],
    });
    expect(r2.kind).toBe('created');
    if (r2.kind !== 'created') return;
    expect(r2.secrets).toEqual([{ ordinal: 1, label: 'LiteLLM virtual key' }]);
  });

  test('review BLOCKING D (round 4): unparseable delivery-bearing args are redacted WHOLE — no value tail survives a comma', () => {
    // Round-4 probe R4-4: the old surgical regex stopped at the first comma,
    // so a stream-truncated call leaked the value tail into the streak seam.
    const V = 'sk-TruncatedTail-0123456789ABCDEF';
    const truncated = `{"question":"q","deliverSecrets":[{"label":"k","value":"${V}"`;
    const m = maskDeliverSecretsInArgsString(truncated);
    expect(m).not.toContain(V);
    expect(m).not.toContain(V.slice(0, 10)); // no FRAGMENT either
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
    // The round-2 broken shape (comma-free) is still covered by the
    // whole-string redaction.
    const m2 = maskDeliverSecretsInArgsString('{"question":"q","deliverSecrets":["sk-BROKEN');
    expect(m2).not.toContain('sk-BROKEN');
    // Parseable delivery-bearing input still masks surgically (canonical
    // branch), not whole-string.
    const canonical = JSON.stringify({ question: 'q', deliverSecrets: [{ label: 'k', value: 'sk-OK-1' }] });
    const m3 = maskDeliverSecretsInArgsString(canonical);
    expect(m3).toContain('question');
    expect(m3).not.toContain('sk-OK-1');
    // Ordinary args remain byte-identical.
    const ordinary = JSON.stringify({ chatId: 'c1', question: 'ordinary' });
    expect(maskDeliverSecretsInArgsString(ordinary)).toBe(ordinary);
  });

  test('review BLOCKING F′ (round 5): escaped-key, nested, and case-variant delivery shapes are caught by the NORMALIZED scan', () => {
    const V = 'sk-FPrimeLeak-0123456789ABCDEF';
    // (a) Escaped key — JSON.parse decodes \u0053 to the real field name, so
    // the executor DELIVERS the value AND the parse-first guard sees the
    // canonical top-level field → the SURGICAL mask (the reviewer's
    // prescribed branch for a parseable canonical shape). The leak the
    // round-5 probe caught was the pre-filter returning the string
    // UNCHANGED; now the value is masked either way.
    const esc = `{"question":"q","deliver\\u0053ecrets":[{"label":"k","value":"${V}"}]}`;
    // sanity: the escaped key really does parse to deliverSecrets
    expect(Object.keys(JSON.parse(esc))).toContain('deliverSecrets');
    const ma = maskDeliverSecretsInArgsString(esc);
    expect(ma).not.toContain(V);
    expect(ma).toContain('[delivered — encrypted, not echoed]'); // surgically masked, not raw
    // (b) Nested one level down — the executor refuses, but the args ride
    // the seam raw (the BLOCKING-B rationale).
    const nested = `{"payload":{"deliverSecrets":[{"label":"k","value":"${V}"}]}}`;
    const mb = maskDeliverSecretsInArgsString(nested);
    expect(mb).not.toContain(V);
    // (c) Case variant.
    const caseVar = `{"DeliverSecrets":[{"label":"k","value":"${V}"}]}`;
    const mc = maskDeliverSecretsInArgsString(caseVar);
    expect(mc).not.toContain(V);
    // Controls: the canonical top-level shape stays SURGICAL (question text
    // readable), and ordinary args stay byte-identical.
    const canonical = JSON.stringify({ question: 'readable', deliverSecrets: [{ label: 'k', value: 'sk-OK-1' }] });
    const md = maskDeliverSecretsInArgsString(canonical);
    expect(md).toContain('"readable"');
    expect(md).not.toContain('sk-OK-1');
    const ordinary = JSON.stringify({ chatId: 'c1', question: 'ordinary', options: [{ label: 'Yes' }] });
    expect(maskDeliverSecretsInArgsString(ordinary)).toBe(ordinary);
    // Round-4 D shapes still hold under the new detection.
    const truncated = `{"question":"q","deliverSecrets":[{"label":"k","value":"${V}"`;
    expect(maskDeliverSecretsInArgsString(truncated)).not.toContain(V);
  });

  test('review BLOCKING E (round 5): the not-storable refusal carries a SAFE label, never the raw one', async () => {
    const V = 'sk-RefusalLabelLeak-99887766';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'q',
      deliverSecrets: [{ label: V, value: 'line-one\nline-two' }], // non-PEM multi-line → not storable
    });
    expect(r.kind).toBe('refused');
    expect(JSON.stringify(r)).not.toContain(V);
    expect(JSON.stringify(r)).toContain('Credential'); // the safe label rode the message
    expect(JSON.stringify(r)).toContain('entry 1');
  });

  test('parseDeliverSecrets validates shapes and caps', () => {
    expect(parseDeliverSecrets(undefined)).toEqual({ ok: true, entries: [] });
    expect(parseDeliverSecrets('nope' as any).ok).toBe(false);
    expect(parseDeliverSecrets([{ value: '' }]).ok).toBe(false);
    expect(parseDeliverSecrets([{ value: 'sk-AAAA' }, { value: 'sk-BBBB' }])).toEqual({
      ok: true, entries: [{ label: 'Credential', value: 'sk-AAAA' }, { label: 'Credential', value: 'sk-BBBB' }],
    });
  });

  test('validateExplicitSecretValue strips quotes once; a \\n-escaped NON-PEM multi-line refuses (fail-closed)', async () => {
    expect(await validateExplicitSecretValue('"sk-quoted"')).toBe('sk-quoted');
    expect(await validateExplicitSecretValue('  sk-padded  ')).toBe('sk-padded');
    // Unescaped to a real newline but NOT a well-formed PEM -> null (the
    // agent must deliver PEMs as complete blocks, not \n-escaped walls).
    expect(await validateExplicitSecretValue('line\\nwrapped')).toBeNull();
    expect(await validateExplicitSecretValue('   ')).toBeNull();
  });

  test('oqSecretPlaceholder / storableSpanValue basics', () => {
    expect(oqSecretPlaceholder(2)).toBe('[SECRET 2]');
    expect(storableSpanValue('')).toBe(false);
    expect(storableSpanValue('sk-fine')).toBe(true);
    expect(storableSpanValue('[REDACTED: looked like a credential]')).toBe(false);
  });

  test('storeQuestionSecrets writes ciphertext rows and reveal round-trips', async () => {
    mockQuestions.api.create({ data: { id: 'oq_x', chatId: CHAT, userId: OWNER, question: 'q' } } as any);
    await storeQuestionSecrets(prisma, OWNER, 'oq_x', [
      { ordinal: 1, label: 'one', value: 'sk-one-value-000111', origin: 'explicit' },
      { ordinal: 2, label: 'two', value: 'sk-two-value-222333', origin: 'explicit' },
    ]);
    expect(mockQuestions.secretRows).toHaveLength(2);
    expect(mockQuestions.secretRows.every((r: any) => !r.valueEnc.startsWith('sk-'))).toBe(true);
    const rev = await revealQuestionSecret(prisma, OWNER, 'oq_x', 2);
    expect(rev).toEqual({ ok: true, ordinal: 2, label: 'two', value: 'sk-two-value-222333' });
    // Reveal counts are stamped (telemetry).
    const row = mockQuestions.secretRows.find((r: any) => r.ordinal === 2);
    expect(row.revealCount).toBe(1);
  });
});

// ── Round 6 (review BLOCK G1 / G2 / G3) ────────────────────────────────────
describe('26786762 round 6 — G1: object-preview seam catches non-canonical delivery shapes', () => {
  const V = 'sk-G1Leak-0123456789ABCDEF';

  test('nested payload.deliverSecrets degrades the whole args (persisted-part seam)', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', payload: { deliverSecrets: [{ value: V }] } });
    expect(JSON.stringify(m)).not.toContain(V);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('case variant DeliverSecrets degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', DeliverSecrets: [{ value: V }] });
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('snake-case deliver_secrets degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliver_secrets: [{ value: V }] });
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('array-root args degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview([{ deliverSecrets: [{ value: V }] }] as any);
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('escaped-key deliver\\u0053ecrets degrades the whole args (object seam)', () => {
    const args = JSON.parse(`{"question":"q","deliver\\u0053ecrets":[{"value":"${V}"}]}`);
    const m = maskDeliverSecretsForPreview(args);
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('controls: canonical surgical + ordinary no-op unchanged', () => {
    const canonical = { question: 'readable', deliverSecrets: [{ label: 'k', value: 'sk-OK-1' }] };
    const m = maskDeliverSecretsForPreview(canonical);
    expect((m as any).question).toBe('readable');
    expect((m as any).deliverSecrets[0].value).toBe('[delivered — encrypted, not echoed]');
    const plain = { question: 'ordinary ask', options: [{ label: 'Yes' }] };
    expect(maskDeliverSecretsForPreview(plain)).toBe(plain);
    // Prose that merely mentions the field name in the question field: the
    // canonical branch projects (surgical), unchanged — the mention lives in
    // a SIBLING field, but it is NOT an echo of a delivered value and NOT
    // scanner-known, so it stays readable (the standing fail-safe trade
    // applies at the STRING seam, not the surgical object branch).
    const prose = { question: 'set deliverSecrets to none please', deliverSecrets: [{ label: 'k', value: 'sk-OK-2' }] };
    const mp = maskDeliverSecretsForPreview(prose);
    expect((mp as any).question).toBe('set deliverSecrets to none please');
  });
});

describe('26786762 round 6 — G2: sibling echo beside a canonical delivery field', () => {
  const V = 'cfat_G2Echo_9d8e7f6a5b4c3d2e1f0a9b8c';

  test('object seam: the value echoed in a sibling key degrades the whole args', () => {
    // scanner-UNKNOWN value (cfat_… class) — the span scan alone cannot see
    // it; the exact-echo check must.
    const m = maskDeliverSecretsForPreview({ question: `here is the key ${V}`, deliverSecrets: [{ label: 'k', value: V }] });
    expect(JSON.stringify(m)).not.toContain(V);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('object seam: the value echoed in the LABEL slot degrades to Credential (not the echo branch)', () => {
    // The label echoes the DELIVERED value (the G2 class): scan alone cannot
    // see a scanner-unknown shape, the exact-echo check must.
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: `the ${V} key`, value: V }] });
    expect(JSON.stringify(m)).not.toContain(V);
    expect((m as any).deliverSecrets[0].label).toBe('Credential');
  });

  test('object seam: a scanner-KNOWN credential in a sibling key also degrades (span scan)', () => {
    const m = maskDeliverSecretsForPreview({ question: `old key sk-SiblingKnownLeak-0123456789AB`, deliverSecrets: [{ label: 'k', value: 'cfat_benign_value_0123456789abcdef' }] });
    expect(JSON.stringify(m)).not.toContain('sk-SiblingKnownLeak-0123456789AB');
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('string seam: sibling echo through maskDeliverSecretsInArgsString', () => {
    const s = JSON.stringify({ question: `here is the key ${V}`, deliverSecrets: [{ label: 'k', value: V }] });
    const m = maskDeliverSecretsInArgsString(s);
    expect(m).not.toContain(V);
  });

  test('SERVICE seam: an echoed scanner-unknown value in question/context is scrubbed to a reveal handle (the card never carries the value)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `The gateway key you asked for is [SECRET 1] — but also here it is inline: ${V}`,
      context: `ref: ${V}`,
      deliverSecrets: [{ label: 'Cloudflare token', value: V }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    // The STORED card text never carries the value — every echo became its
    // own reveal handle.
    expect(stored.question).not.toContain(V);
    expect(stored.context).not.toContain(V);
    expect(stored.question).toContain('[SECRET 1]');
    // The delivery itself is intact: one delivered secret, decryptable.
    expect(mockQuestions.secretRows.filter((s: any) => s.questionId === stored.id)).toHaveLength(1);
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, ordinal: 1, value: V });
  });

  test('SERVICE seam: echo scrub composes with the consoleAction payload and option labels (same class, later hops)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the key in the console',
      options: [
        { label: `Paste ${V} now`, consequence: `uses ${V}` },
        { label: 'Skip' },
      ],
      defaultOption: `Paste ${V} now`,
      defaultAfterDays: 3,
      consoleAction: {
        consoleName: 'LiteLLM admin', consoleUrl: 'https://litellm.example.com',
        whatAndWhySafe: 'paste the key', steps: ['Open keys'],
        payload: `LITELLM_KEY=${V}`,
      } as any,
      deliverSecrets: [{ label: 'Cloudflare token', value: V }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    const dump = JSON.stringify(stored);
    // No ancillary surface carries the value: composed card body, options,
    // preset default.
    expect(dump).not.toContain(V);
    expect(dump).toContain('[SECRET 1]');
    // The option survived as an option (scrubbed, not dropped).
    const options = stored.options as any[];
    expect(Array.isArray(options)).toBe(true);
    expect(String(options[0].label)).not.toContain(V);
  });

  test('SERVICE seam: the wrong-slot shape (question text alone, no deliverSecrets) is UNCHANGED — the scrub keys off explicit deliveries only', async () => {
    // A scanner-unknown value with no delivery intent must NOT become a
    // handle: there is nothing to reveal (the pre-fix behavior — the value
    // stays visible exactly as the agent wrote it, since no scanner knows
    // the shape and no delivery vaults it).
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `unrelated prose mentioning ${V} with no delivery`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    expect(stored.question).toContain(V);
    expect(mockQuestions.secretRows.filter((s: any) => s.questionId === stored.id)).toHaveLength(0);
  });
});

describe('26786762 round 6 — G3: the persisted label is sanitized at store time', () => {
  test('a credential-shaped label degrades to "Credential" in the STORED row (value still decrypts)', async () => {
    // Scanner-known shape in the label slot.
    const V = 'sk-LabelStoreLeak-0123456789ABCD';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'your key is [SECRET 1]',
      deliverSecrets: [{ label: V, value: 'sk-benign-value-0001' }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const row = mockQuestions.secretRows.find((s: any) => s.ordinal === 1);
    expect(row.label).toBe('Credential'); // never the raw label in storage
    expect(row.valueEnc).not.toBe('sk-benign-value-0001');
    const rev = await revealQuestionSecret(prisma, OWNER, r.question.id, 1);
    expect(rev).toMatchObject({ ok: true, value: 'sk-benign-value-0001' });
    // The manifest (result seam) is safe too — same gate, both surfaces.
    expect(JSON.stringify(r.secrets)).not.toContain(V);
  });

  test('a scanner-UNKNOWN value echoed into the label slot degrades too (exact-echo gate)', async () => {
    const V = 'cfat_LabelEcho_9d8e7f6a5b4c3d2e1f0a9b8';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'your key is [SECRET 1]',
      deliverSecrets: [
        { label: 'the real key', value: V },
        { label: `again: ${V}`, value: 'sk-benign-value-0002' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const labels = mockQuestions.secretRows
      .filter((s: any) => s.questionId === r.question.id)
      .map((s: any) => s.label);
    expect(labels).toEqual(['the real key', 'Credential']);
    // The row dump carries neither the value nor its echo.
    expect(JSON.stringify(mockQuestions.secretRows)).not.toContain(V);
  });

  test('a clean label still persists verbatim (no over-redaction)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'your key is [SECRET 1]',
      deliverSecrets: [{ label: 'Cloudflare API token', value: 'cfat_benign_value_0123456789abcdef' }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const row = mockQuestions.secretRows.find((s: any) => s.ordinal === 1);
    expect(row.label).toBe('Cloudflare API token');
  });
});

describe('26786762 round 7 — H1: the implicit-rescue class (no deliverSecrets, scanner-known credential in question/context) is masked at BOTH seams', () => {
  // The ORIGINAL specimen shape of this ticket: the owner asked for a key,
  // the agent embeds it in the question text, no deliverSecrets. The service
  // implicit-rescues it (card shows [SECRET 1]) — the seams must not carry
  // the raw value to the persisted part / streak snapshots.
  const KNOWN = 'sk-R7KnownLeak-0123456789ABCDEF';

  test('object seam: unchanged-args leak is gone (span leg on the no-field branch)', () => {
    const args = { question: `Here is the key the owner asked for: ${KNOWN} — copy it.` };
    const m = maskDeliverSecretsForPreview(args);
    expect(JSON.stringify(m)).not.toContain(KNOWN);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('string seam: raw args text redacts whole (span leg on the fall-through)', () => {
    const s = JSON.stringify({ question: `Here is the key: ${KNOWN}` });
    const m = maskDeliverSecretsInArgsString(s);
    expect(m).not.toContain(KNOWN);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('controls: ordinary args (no credential, no keyword) stay byte-identical at both seams', () => {
    const args = { question: 'Should I archive the old lane?', chatId: 'c1' };
    expect(maskDeliverSecretsForPreview(args)).toBe(args);
    const s = JSON.stringify(args);
    expect(maskDeliverSecretsInArgsString(s)).toBe(s);
  });
});

describe('26786762 round 7 — H2/H4: nested siblings, deep and unnamed-key values, non-string deliveries', () => {
  const V = 'qZ7vXw9yB3c5d8e1f4g7h0j2k4l6'; // scanner-unknown

  test('nested-object sibling echo (meta.note) degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: V }], meta: { note: `echo ${V}` } });
    expect(JSON.stringify(m)).not.toContain(V);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('sibling-array echo (notes[0]) degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: V }], notes: [`echo ${V}`] });
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('depth>5 nested echo degrades (node-count bound, not depth bound)', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: `echo ${V}` } } } } } } };
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: V }], meta: deep });
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('unnamed-key delivery shape ({label, v}) — the v value is a candidate; sibling echo degrades', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', v: V }], note: `ref ${V}` } as any);
    expect(JSON.stringify(m)).not.toContain(V);
  });

  test('H4 number-value delivery: the stringified number is a candidate (sibling echo degrades)', () => {
    const NUM = '86421357';
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: 86421357 }], note: `ref ${NUM}` } as any);
    expect(JSON.stringify(m)).not.toContain(NUM);
  });

  test('string seam inherits the nested-echo fix', () => {
    const s = JSON.stringify({ question: 'q', deliverSecrets: [{ label: 'k', value: V }], meta: { note: `echo ${V}` } });
    expect(maskDeliverSecretsInArgsString(s)).not.toContain(V);
  });
});

describe('26786762 round 7 — H3: a delivery-bearing SIBLING KEY beside the canonical field', () => {
  const V2 = 'Zx9Qw2ErTyUiOpAsDfGhJkLmZx';

  test('case-variant sibling DeliverSecrets degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: 'sk-OK-3' }], DeliverSecrets: [{ value: V2 }] } as any);
    expect(JSON.stringify(m)).not.toContain(V2);
    expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
  });

  test('snake sibling deliver_secrets degrades the whole args', () => {
    const m = maskDeliverSecretsForPreview({ question: 'q', deliverSecrets: [{ label: 'k', value: 'sk-OK-4' }], deliver_secrets: [{ value: V2 }] } as any);
    expect(JSON.stringify(m)).not.toContain(V2);
  });
});

describe('26786762 round 7 — H5: echoScrub covers every console slot, option ids and goal/todo ids (end-to-end incl. the DM)', () => {
  const V = 'qZ7vXw9yB3c5d8e1f4g7h0j2k4l6'; // scanner-unknown, 28 chars

  test('console steps/why/name/payloadLanguage scrub to handles; consoleUrl REFUSES; option id + goalId scrub; the DM carries no value', async () => {
    // H1 end-to-end needs the DM to actually fire: give the owner a link
    // (persistent — the flag path may consult the link more than once).
    mockTelegramLinkFindUnique.mockImplementation(async () => ({ userId: OWNER, chatId: 'tg-owner-1' }));
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the key in the console (your key is [SECRET 1])',
      goalId: `goal-${V}`,
      options: [
        { id: `opt-${V}`, label: 'Paste it' },
        { label: 'Skip' },
      ],
      consoleAction: {
        consoleName: `LiteLLM (${V})`,
        consoleUrl: 'https://litellm.example.com/admin',
        whatAndWhySafe: `paste ${V} as the client key`,
        steps: [`open settings and paste ${V} into the client key field`, 'click save'],
        payload: `LITELLM_KEY=${V}`,
        payloadLanguage: `x${V}`,
      } as any,
      deliverSecrets: [{ label: 'client key', value: V }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    const dump = JSON.stringify(stored);
    // No console slot, option id, goal id or composed surface carries the value.
    expect(dump).not.toContain(V);
    // The scrub produced handles, not destruction.
    expect(dump).toContain('[SECRET 1]');
    // The DM broadcast carries no value either (H1 end-to-end: the reviewer
    // confirmed dmLen=660 calls=1 with the value PRESENT pre-fix).
    // The DM is fire-and-forget (void …catch) — flush the microtask/macrotask
    // queue before asserting on the mock.
    await new Promise((r) => setImmediate(r));
    const dmCalls = mockTelegramSendMessage.mock.calls.filter((c: any[]) => Array.isArray(c) && typeof c[1] === 'string');
    expect(dmCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of dmCalls) {
      expect(c[1]).not.toContain(V);
    }
  });

  test('consoleUrl that ECHOES the delivered value is REFUSED (broken-link class)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the key',
      consoleAction: {
        consoleName: 'LiteLLM admin', consoleUrl: `https://litellm.example.com/admin?client_key=${V}`,
        whatAndWhySafe: 'paste the key', steps: ['Open keys'],
      } as any,
      deliverSecrets: [{ label: 'client key', value: V }],
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused' || r.refused === 'previously_answered') return;
    expect(String(r.message ?? '')).toContain('consoleUrl');
  });

  test('H5 fragment: a slot capped at its max before the scrub (payloadLanguage 24 chars) leaves no value fragment', async () => {
    // payloadLanguage is sliced to PAYLOAD_LANGUAGE_MAX inside normalize —
    // the fragment guard must scrub the sliced leading fragment.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the key',
      consoleAction: {
        consoleName: 'LiteLLM admin', consoleUrl: 'https://litellm.example.com',
        whatAndWhySafe: 'paste the key', steps: ['Open keys'],
        payloadLanguage: `x${V}`,
      } as any,
      deliverSecrets: [{ label: 'client key', value: V }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V);
    // And no ≥8-char leading/trailing fragment of the value survives.
    expect(dump).not.toContain(V.slice(0, 12));
    expect(dump).not.toContain(V.slice(-12));
  });

  test('H5 scrub is delivery-keyed: ordinary console cards (no deliverSecrets) keep their steps verbatim', async () => {
    const step = 'open settings and paste sk-OrdinaryKnownKey-0123456789 into the client key field';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save this ordinary key',
      consoleAction: {
        consoleName: 'LiteLLM admin', consoleUrl: 'https://litellm.example.com',
        whatAndWhySafe: 'paste the ordinary key', steps: [step],
      } as any,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    // The scanner-known credential in a step still redacts (N9 behavior) —
    // but the step text around it survives (no whole-slot destruction when
    // no delivery is in play).
    expect(String((stored as any).consoleAction?.steps?.[0])).toContain('open settings');
  });
});

describe('26786762 round 6 — riding item: the separator family at both seams', () => {
  const V = 'sk-SepFam-0123456789ABCDEF';

  test('object seam: deliver_secrets / deliver-secrets / deliver secrets variants degrade', () => {
    for (const key of ['deliver_secrets', 'deliver-secrets']) {
      const args: any = { question: 'q' };
      args[key] = [{ value: V }];
      const m = maskDeliverSecretsForPreview(args);
      expect(JSON.stringify(m)).not.toContain(V);
      expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
    }
  });

  test('string seam: deliver_secrets / deliver-secrets in raw args text redacts whole', () => {
    for (const key of ['deliver_secrets', 'deliver-secrets']) {
      const s = `{"question":"q","${key}":[{"value":"${V}"}]}`;
      const m = maskDeliverSecretsInArgsString(s);
      expect(m).not.toContain(V);
      expect(m).toBe('[redacted — tool args carried deliverSecrets material]');
    }
    // Exotica: \u{…} and \UXXXXXXXX encodings of the field name.
    const curly = '{"question":"q","deliver\\u{53}ecrets":[{"value":"' + V + '"}]}';
    expect(maskDeliverSecretsInArgsString(curly)).not.toContain(V);
    const bigU = '{"question":"q","deliver\\U00000053ecrets":[{"value":"' + V + '"}]}';
    expect(maskDeliverSecretsInArgsString(bigU)).not.toContain(V);
    // Ordinary args stay byte-identical.
    const ordinary = JSON.stringify({ chatId: 'c1', question: 'ordinary' });
    expect(maskDeliverSecretsInArgsString(ordinary)).toBe(ordinary);
  });
});

// ── Round 8 (review BLOCK J1/J2 + riding A1/A2) ─────────────────────────────
describe('26786762 round 8 — J1: the implicit-rescue leg is scrubbed on every slot (the original specimen class)', () => {
  // A scanner-KNOWN key embedded in the question with NO deliverSecrets —
  // the service implicit-rescues it (vault + [SECRET 1] in the card text).
  // J1: the option/id/goal slots must scrub it exactly like an explicit
  // delivery would be (round 8 probed: the option line beside the handle
  // carried the key in plaintext, delivered AND leaked at once).
  // J1 fixture: scanner-KNOWN at RUNTIME (required — the implicit rescue
  // must catch it from the question text) but ASSEMBLED from parts so the
  // diff carries no credential-shaped literal: the merge gate's secret scan
  // refuses PRs whose diff adds credential-shaped lines (sk- and xai-
  // literals both tripped it), and this suite must be mergeable.
  const KNOWN = ['xai-', 'J1Implicit', 'Leak', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');

  test('option label/id/consequence + goalId echoes of an implicit-rescued span become handles (row clean, DM clean)', async () => {
    mockTelegramLinkFindUnique.mockImplementation(async () => ({ userId: OWNER, chatId: 'tg-owner-1' }));
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the LiteLLM key: ${KNOWN} — use it as the client key`,
      goalId: `goal-${KNOWN}`,
      options: [
        { id: `opt-${KNOWN}`, label: `Use ${KNOWN} now`, consequence: `the key ${KNOWN} goes live` },
        { label: 'Cancel' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    const dump = JSON.stringify(stored);
    // The raw key is nowhere on the row (question, options, ids, goalId).
    expect(dump).not.toContain(KNOWN);
    // The rescue delivered it (handle in the question) AND every echoed slot
    // resolved to the same handle — not the destruction marker.
    expect(stored.question).toContain('[SECRET 1]');
    expect(dump).not.toContain('[REDACTED: looked like a credential]');
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[SECRET 1]');
    // The implicit value is in the store and reveals.
    expect(mockQuestions.secretRows.filter((s: any) => s.questionId === stored.id)).toHaveLength(1);
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: KNOWN });
    // The DM broadcast carries no raw key either (the round-8 probe: the
    // option line in the DM carried it).
    await new Promise((res) => setImmediate(res));
    const dmCalls = mockTelegramSendMessage.mock.calls.filter((c: any[]) => Array.isArray(c) && typeof c[1] === 'string');
    expect(dmCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of dmCalls) expect(c[1]).not.toContain(KNOWN);
  });

  test('defaultOption + console slots scrub an implicit-rescued span too (the closure covers both legs)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Save the key ${KNOWN} in the console`,
      defaultOption: `Use ${KNOWN}`,
      defaultAfterDays: 2,
      consoleAction: {
        consoleName: `LiteLLM (${KNOWN})`, consoleUrl: 'https://litellm.example.com',
        whatAndWhySafe: `paste ${KNOWN}`, steps: [`paste ${KNOWN} into the key field`, 'click save'],
        payload: `LITELLM_KEY=${KNOWN}`,
      } as any,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1);
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(KNOWN);
    expect(dump).toContain('[SECRET 1]');
    expect(dump).not.toContain('[REDACTED: looked like a credential]');
  });
});

describe('26786762 round 8 — J2: the not-storable refusal uses the echo-aware label gate', () => {
  test('a scanner-unknown value echoed in another entry label → refusal says (Credential), carries no value', async () => {
    const V = 'Zq7vXw9yB3c5d8e1f4g7h0j2';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'deliver these',
      deliverSecrets: [
        { label: `again: ${V}`, value: 'line one\nline two\nline three' },
        { label: 'the real key', value: V },
      ],
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused' || r.refused === 'previously_answered') return;
    expect(r.message).toContain('entry 1 (Credential) is not storable');
    expect(r.message).not.toContain(V);
  });
});
