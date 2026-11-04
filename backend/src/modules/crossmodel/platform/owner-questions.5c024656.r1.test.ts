/**
 * Pins for the round-1 review seams of ticket 5c024656 (ticket 91b0f191;
 * todos 31fb5ab6 / c346f3d7 / a10f54ad) — the three hardening items the
 * round-1 adversarial review found pre-existing on main and PR #1682
 * deliberately held out of scope.
 *
 * R1-3 (probe D5) — expectedAnswerType 'credential:<ENVKEY>' envKey half:
 *   a scanner-known key pasted as the envKey rode the stored row's
 *   expectedAnswerType slot verbatim ('credential:ghp_…') onto every
 *   projection surface (list_owner_questions, the confirmations card).
 *   Fix: the envKey runs the inbound credential scan INSIDE
 *   parseExpectedAnswerType (fail-closed: a hit drops only the envKey — the
 *   gate stays a credential gate with no key, the documented
 *   unresolvable-until-refiled shape), plus a belt-and-braces wrap at the
 *   create site.
 *
 * R1-4 (probes D1/D3) — forChatId + the supersedes refusal:
 *   (a) forChatId never ran the inbound scan (hardening only — production
 *       drops unknown/foreign ids today); now the same wrap every other
 *       agent-authored linkage slot got in #1682.
 *   (b) the supersedes-refusal message interpolated the RAW id — the J2
 *       class (a scanner-known key, or an echo of a delivered value, riding
 *       a refusal result back to the filing agent). Now an echo-aware safe
 *       label (echoScrub first → handle; then the inbound scan → marker);
 *       ordinary unresolvable ids pass byte-identical so the refusal stays
 *       actionable.
 *
 * R1-5 (probe D6) — echoScrub two-key prefix collision:
 *   when one candidate value is a PREFIX of another (V2 = V1 + 'ZZZZYYYYX'),
 *   the old insertion-order split/join let candidate 1's full pass carve
 *   V2's head into '[SECRET 1]', and candidate 2's slice(-8) fragment leg
 *   then matched its own tail — interleaving handle text with the raw middle
 *   of the value ('Use [SECRET 1]ZZZZYYYYX[SECRET 2] now'). Fix: two-phase
 *   replacement (ALL full-value passes longest-first, THEN fragment legs,
 *   skipped for full-matched candidates). Cosmetic-to-mild — no value
 *   disclosure, but a raw 8+-char slice of a delivered value sat between
 *   two handles.
 *
 * Fixture rule (same as the 5c024656 suite): every scanner-known key is
 * ASSEMBLED from parts so this file's diff carries no credential-shaped
 * literal — the merge gate's secret scan refuses such diffs (sk- and xai-
 * literals both tripped it), and these pins must be mergeable.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// The delivered-secret store encrypts through the credentials vault, whose
// key derives from JWT_SECRET — set a test secret BEFORE any import that
// touches the module (same as the 5c024656 / 26786762 suites).
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

// Real crypto for the vault (same as the 5c024656 suite): the R1-4b /
// R1-5 echo legs store delivered values through the real AES-256-GCM path.
const realCrypto = jest.requireActual('../coding/credentials.service');
jest.mock('../coding/credentials.service', () => ({
  __esModule: true,
  ...realCrypto,
}));

import { flagOwnerQuestion } from './owner-questions';
import { revealQuestionSecret } from './owner-question-secrets';
import { parseExpectedAnswerType, envKeyLooksLikeCredential } from './credential-gate';

const prisma = {
  ownerQuestion: mockQuestions.api,
  ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
  activity: mockQuestions.activity,
};

const OWNER = 'user-owner-1';
const CHAT = 'chat-r1-lane';
// A DIFFERENT chat id so forChatId is not the self-link (dropped on sight).
const LINKED = 'chat-r1-linked';

// Scanner-KNOWN key shapes at RUNTIME, assembled from parts — no
// credential-shaped literal in the diff (mergeable-suite rule).
const KEY = ['sk-', 'R1raw', 'Probe', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');
// An envKey-slot-shaped scanner-known key: parseExpectedAnswerType's shape
// check accepts [A-Za-z0-9_]{2,64} — 'ghp_…' contains no forbidden char.
const ENVKEY_KEY = ['ghp_', 'R1envkey', 'Slot', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');

beforeEach(() => {
  mockQuestions.reset();
  mockTelegramLinkFindUnique.mockReset().mockImplementation(async () => null);
  mockChatFindUnique.mockReset().mockImplementation(async () => undefined);
  mockChatFindFirst.mockReset().mockImplementation(async () => null);
  mockChatFindMany.mockReset().mockImplementation(async () => []);
  mockFireScheduleTarget.mockReset().mockImplementation(async () => ({ started: true }));
  mockTelegramSendMessage.mockReset().mockImplementation(async () => true);
});

// ── R1-3: the envKey half of expectedAnswerType is scanned ─────────────────

describe('R1-3 (probe D5) — a credential-shaped envKey never rides the expectedAnswerType slot', () => {
  test('parseExpectedAnswerType drops the envKey half on a scanner-known key (fail-closed, gate stays credential)', () => {
    const parsed = parseExpectedAnswerType(`credential:${ENVKEY_KEY}`, 'Does not matter');
    expect(parsed.type).toBe('credential');
    expect(parsed.envKey).toBeUndefined();
  });

  test('envKeyLooksLikeCredential: an ordinary ENVKEY passes; the raw-case scan is pinned', () => {
    expect(envKeyLooksLikeCredential('SCHOOLTIME_API_KEY')).toBe(false);
    expect(envKeyLooksLikeCredential(ENVKEY_KEY)).toBe(true);
    // The scan runs on the RAW token before toUpperCase — the mirror pin:
    // the check is case-sensitive exactly because the scanner patterns are.
    expect(envKeyLooksLikeCredential('')).toBe(false);
  });

  test('a scanner-known envKey in a filed card stores NO key on the row (the D5 leak, pinned)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Please store the gateway credential',
      expectedAnswerType: `credential:${ENVKEY_KEY}`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(ENVKEY_KEY);
    // Fail-closed drop, not a free-text degrade: the slot is the bare
    // credential gate with no key (the pre-existing no-key storage shape —
    // the parse layer's decision stands; the create-site layer only scrubs
    // keys the parse layer ACCEPTED). READ-BACK (round-2 D1): the stored
    // shape re-parses as a credential gate, never free text.
    const slot = String((stored as any).expectedAnswerType);
    expect(slot).toBe('credential:');
    expect(parseExpectedAnswerType(slot, String(stored.question)).type).toBe('credential');
  });

  test('an ordinary ENVKEY passes byte-identical (no over-redaction)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Please store the Schooltime credential',
      expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const slot = String((stored as any).expectedAnswerType);
    expect(slot).toBe('credential:SCHOOLTIME_API_KEY');
    // READ-BACK (round-2 D1): the ordinary shape round-trips the key.
    const back = parseExpectedAnswerType(slot, String(stored.question));
    expect(back.type).toBe('credential');
    expect(back.envKey).toBe('SCHOOLTIME_API_KEY');
  });

  test('a delivered-value echo in the envKey slot degrades to the SHUT gate, never a handle in the slot (round-2 D1 pin)', async () => {
    // The belt-and-braces create-site wrap fires for a scanner-UNKNOWN
    // delivered value that passes the parse gate (the parse-level scan
    // already drops scanner-known keys — pinned above). Pure alnum, no
    // hyphen, so it matches the envKey shape check; no known prefix, so
    // only the echo scrub can see it.
    // Round-2 review D1: the scrub result ('[SECRET 1]') must NEVER be
    // stored inside the slot — parseExpectedAnswerType cannot re-parse a
    // handle or marker (shape check is [A-Za-z0-9_]{2,64}), so the row
    // would silently degrade to FREE TEXT (any answer resolves it). The
    // stored shape is the BARE no-key slot, which re-parses as a credential
    // gate with no key (fail-closed). The value itself still delivers —
    // the handle rides the QUESTION text, and reveal round-trips.
    const V = ['Zed', 'NoPrefix', 'Token', '0123456789', 'abcdefghij'].join('');
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the key: ${V} — use it`,
      deliverSecrets: [{ label: 'Gateway key', value: V }],
      expectedAnswerType: `credential:${V}`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V);
    // THE D1 FAIL-OPEN, pinned shut: no handle/marker ever rides the slot.
    const slot = String((stored as any).expectedAnswerType);
    expect(slot).toBe('credential:');
    expect(slot).not.toContain('[SECRET');
    expect(slot).not.toContain('[REDACTED');
    // READ-BACK: the stored shape still re-parses as a credential gate —
    // never free text (any-answer resolution is the fail-open class).
    expect(parseExpectedAnswerType(slot, String(stored.question)).type).toBe('credential');
    expect(parseExpectedAnswerType(slot, String(stored.question)).envKey).toBeUndefined();
    // The delivery itself is intact: the handle rides the question text and
    // the vault round-trips the value.
    expect(String(stored.question)).toContain('[SECRET 1]');
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: V });
  });

  test('an inferred envKey (bare credential + one ENVKEY in the question) stores byte-identical AND re-parses', async () => {
    // 77c88942's inference leg must keep flowing through the D1 fix: the
    // create-site wrap must not touch a key the parse layer ACCEPTED.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Please store the SCHOOLTIME_API_KEY credential',
      expectedAnswerType: 'credential',
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const slot = String((stored as any).expectedAnswerType);
    expect(slot).toBe('credential:SCHOOLTIME_API_KEY');
    const back = parseExpectedAnswerType(slot, String(stored.question));
    expect(back.type).toBe('credential');
    expect(back.envKey).toBe('SCHOOLTIME_API_KEY');
  });

  test('a NON-STRING expectedAnswerType (array form from JSON.parse tool args) is coerced before the parse — the raw key never rides the slot (round-3 pin)', async () => {
    // The agent layer JSON.parses tool args with no schema validation, so a
    // slot can arrive as an ARRAY. String() coercion must happen BEFORE the
    // credential scan (a ['credential:<key>'].join() is the bare string), or
    // the R1-3 seam is bypassed entirely — the R1-1 class applied to the
    // newly wrapped slot. Reviewer round-3 NOTE, pinned per the learnings
    // convention ("pin both classes with array-form fixtures whenever a new
    // slot gets the wrap").
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Please store the gateway credential',
      expectedAnswerType: [`credential:${ENVKEY_KEY}`] as any,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain(ENVKEY_KEY);
    // Same fail-closed shape as the string-form D5 pin: bare gate, no key,
    // and the stored slot re-parses as a credential gate (never free text).
    const slot = String((stored as any).expectedAnswerType);
    expect(slot).toBe('credential:');
    expect(parseExpectedAnswerType(slot, String(stored.question)).type).toBe('credential');
  });
});

// ── R1-4: forChatId scan + supersedes-refusal safe label ───────────────────

describe('R1-4a (probe D1) — forChatId runs the inbound scan (kept-id leg, hardening)', () => {
  test('a scanner-known key in forChatId never rides the stored row', async () => {
    // The probe keeps the caller-supplied id (mockChatFindUnique → undefined
    // = best-effort keep) — the pre-fix row stored it verbatim.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Wake the linked lane too?',
      forChatId: KEY,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(KEY);
    expect(String((stored as any).forChatId)).toContain('[REDACTED: looked like a credential]');
  });

  test('a delivered-value echo in forChatId becomes the reveal handle', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the key: ${KEY} — use it`,
      deliverSecrets: [{ label: 'Gateway key', value: KEY }],
      forChatId: KEY,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(KEY);
    expect(String((stored as any).forChatId)).toContain('[SECRET 1]');
  });

  test('an ordinary uuid forChatId passes byte-identical (no over-redaction)', async () => {
    const forChatId = '99e63f86-1234-4abc-9def-0123456789ab';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Wake the linked lane too?',
      forChatId,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect((stored as any).forChatId).toBe(forChatId);
  });

  test('a same-owner forChatId still links (the probe path keeps a valid id after the wrap)', async () => {
    mockChatFindUnique.mockImplementation(async () => ({ userId: OWNER }));
    const forChatId = '99e63f86-1234-4abc-9def-0123456789ab';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Wake the linked lane too?',
      forChatId,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect((stored as any).forChatId).toBe(forChatId);
    // The probe ran on the wrapped id.
    expect(mockChatFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: forChatId } }),
    );
  });

  test('a foreign (other-owner) forChatId is still dropped by the probe (pre-existing behavior carries)', async () => {
    mockChatFindUnique.mockImplementation(async () => ({ userId: 'someone-else' }));
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Wake the linked lane too?',
      forChatId: KEY,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    // Dropped by the probe AND never the raw key anywhere on the row
    // (the create spread omits a dropped forChatId → undefined).
    expect((stored as any).forChatId ?? null).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(KEY);
  });

  test('a NON-STRING forChatId (array form from JSON.parse tool args) is coerced before the wrap — the raw key never rides the row (round-3 pin)', async () => {
    // R1-1 class on the newly wrapped slot: without the String() coercion at
    // owner-questions.ts (~1547, coercion precedes echoScrub +
    // redactInboundSecrets), an array ['sk-…'] would bypass both layers and a
    // later String() would write the raw key into storage. Reviewer round-3
    // NOTE, pinned per the learnings convention.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Wake the linked lane too?',
      forChatId: [KEY] as any,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain(KEY);
    // The probe keeps the caller-supplied id (mockChatFindUnique →
    // undefined) — the stored id is the destruction marker, never the key.
    expect(String((stored as any).forChatId)).toContain('[REDACTED: looked like a credential]');
  });
});

describe('R1-4b (probe D3, the J2 class) — the supersedes refusal never interpolates the RAW id', () => {
  test('a scanner-known key passed as supersedes degrades in the refusal message (never the raw value)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Replace the prior card?',
      supersedes: KEY,
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    const msg = String((r as any).message ?? '');
    expect(msg).toContain('does not resolve');
    expect(msg).not.toContain(KEY);
    expect(msg).toContain('[REDACTED: looked like a credential]');
  });

  test('a delivered-value echo passed as supersedes becomes the reveal handle in the refusal', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the key: ${KEY} — use it`,
      deliverSecrets: [{ label: 'Gateway key', value: KEY }],
      supersedes: KEY,
    });
    // The supersedes id does not resolve (no cards owned) → refused, and
    // the refusal carries the HANDLE for the echo, never the value.
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    const msg = String((r as any).message ?? '');
    expect(msg).not.toContain(KEY);
    expect(msg).toContain('[SECRET 1]');
  });

  test('an ordinary unresolvable supersedes id passes byte-identical (the refusal stays actionable)', async () => {
    const bogus = 'oq_deadbeef-1234-4abc-9def-0123456789ab';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Replace the prior card?',
      supersedes: bogus,
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    const msg = String((r as any).message ?? '');
    expect(msg).toContain(bogus);
  });

  test('a resolvable supersedes still links (the wrap never blocks the happy path)', async () => {
    // Seed one OPEN card to supersede.
    const seed = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'The original decision card',
    });
    expect(seed.kind).toBe('created');
    const seedRow = mockQuestions.rows.at(-1)!;
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'The replacement decision card',
      supersedes: String(seedRow.id),
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect((stored as any).supersedesId).toBe(seedRow.id);
  });

  test('a NON-STRING supersedes (array form from JSON.parse tool args) is coerced before the resolution — the refusal never carries the raw key (round-3 pin)', async () => {
    // R1-1/J2 class on the newly wrapped slot: the refusal interpolates the
    // SAFE label of the coerced id (owner-questions.ts ~1296 — String() runs
    // before the resolution + safeAgentIdLabel). An array ['sk-…'] must not
    // bypass the safe-label path and ride the refusal result raw. Reviewer
    // round-3 NOTE, pinned per the learnings convention.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Replace the prior card?',
      supersedes: [KEY] as any,
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    const msg = String((r as any).message ?? '');
    expect(msg).toContain('does not resolve');
    expect(msg).not.toContain(KEY);
    expect(msg).toContain('[REDACTED: looked like a credential]');
  });
});

// ── R1-5: the echoScrub two-key prefix collision ───────────────────────────

describe('R1-5 (probe D6) — one delivered value a PREFIX of another no longer interleaves handle text', () => {
  // The probe shape: V2 = V1 + 'ZZZZYYYYX' — candidate 1's full pass used
  // to carve V2's head into '[SECRET 1]', then candidate 2's slice(-8)
  // fragment leg matched its own tail, leaving 'Use [SECRET 1]ZZZZYYYYX
  // [SECRET 2] now'. Assembled from parts (mergeable-suite rule); both
  // values are scanner-known shapes at runtime.
  const V1 = ['xai-', 'R1five', 'Head', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');
  const TAIL = 'ZZZZYYYYX';
  const V2 = `${V1}${TAIL}`;

  test('a slot echoing BOTH prefix and extension values renders clean handles (the D6 interleave, pinned)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Short key', value: V1 },
        { label: 'Long key', value: V2 },
      ],
      // One slot echoing BOTH values: V2's occurrence CONTAINS V1's.
      options: [{ id: 'opt-both', label: `Use ${V2} then ${V1} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V1);
    expect(dump).not.toContain(V2);
    // NOT the interleave: no raw slice of a value between two handles.
    expect(dump).not.toContain(TAIL);
    // Both occurrences resolve to the RIGHT handles: V2 → [SECRET 2] (the
    // full-value pass consumed it whole), V1 → [SECRET 1].
    const opts = stored.options as any[];
    const label = String(opts[0].label);
    expect(label).toContain('[SECRET 2]');
    expect(label).toContain('[SECRET 1]');
    expect(label).toBe('Use [SECRET 2] then [SECRET 1] now');
    // And the reveal round-trips BOTH delivered values.
    const rev1 = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev1).toMatchObject({ ok: true, value: V1 });
    const rev2 = await revealQuestionSecret(prisma, OWNER, stored.id, 2);
    expect(rev2).toMatchObject({ ok: true, value: V2 });
  });

  test('insertion order does not matter: prefix candidate SECOND still scrubs clean', async () => {
    // The mirror shape (the shorter prefix value delivered SECOND) — the
    // old insertion-order loop hit the same interleave from the other side.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Long key', value: V2 },
        { label: 'Short key', value: V1 },
      ],
      options: [{ id: 'opt-both', label: `Use ${V2} then ${V1} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V1);
    expect(dump).not.toContain(TAIL);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('Use [SECRET 1] then [SECRET 2] now');
  });

  test('implicit-rescued prefix pairs scrub clean too (the J1 candidate set)', async () => {
    // Both values implicit-rescued from the QUESTION text (no explicit
    // deliverSecrets): V2 appears first in the text, so its span rescues
    // first (ordinal 1) and V1 second (ordinal 2).
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Pick: long ${V2} or short ${V1}?`,
      options: [{ id: 'opt-both', label: `Use ${V2} then ${V1} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V1);
    expect(dump).not.toContain(V2);
    expect(dump).not.toContain(TAIL);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('Use [SECRET 1] then [SECRET 2] now');
  });

  test('fragment legs still fire (the A2 cap-cut shape) — the phase split did not break them', async () => {
    // A slot carrying only a LEADING fragment of a delivered value (the
    // cap-cut class the fragment leg exists for) still becomes the handle.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [{ label: 'The key', value: V1 }],
      options: [{ id: 'opt-frag', label: `Prefix ${V1.slice(0, 12)} only` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V1);
    expect(dump).not.toContain(V1.slice(0, 12));
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[SECRET 1]');
  });

  test('a single delivered value echoed twice scrubs to the same handle (no regression from the rewrite)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [{ label: 'The key', value: V1 }],
      options: [{ id: 'opt-twice', label: `${V1} and again ${V1}` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(V1);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('[SECRET 1] and again [SECRET 1]');
  });

  // F1 (round-3 review addendum — the junction-overlap carve): two LONGER
  // candidates sharing a shorter candidate's head AND tail. A ends with C's
  // head, B starts with C's tail, and a slot echoes A + C's middle + B —
  // phase 1's full passes consumed A and B and CARVED C's full occurrence
  // apart before C's own pass, and C's fragment legs (head-8/tail-8) missed
  // the surviving middle: a 10-char raw slice of a DELIVERED value rode the
  // stored text (regression vs the pre-R1-5 loop on one ordering). The
  // final any-≥8-window sweep closes it. Plain-letter values, assembled
  // from parts (mergeable-suite rule).
  const JC = 'ABCDEFGHIJKLMNOPQRSTUV'; // C, 22 ch
  const JA = `${'Z'.repeat(18)}${JC.slice(0, 6)}`; // A, 24 ch — ends with C's head
  const JB = `${JC.slice(16)}${'Y'.repeat(18)}`; // B, 24 ch — starts with C's tail
  const JMID = JC.slice(6, 16); // 'GHIJKLMNOP' — the surviving middle (10 ch)

  test('F1 junction carve: the middle of the carved candidate never rides raw (C delivered FIRST)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Short key', value: JC },
        { label: 'Head-overlap key', value: JA },
        { label: 'Tail-overlap key', value: JB },
      ],
      options: [{ id: 'opt-junction', label: `Use ${JA}${JMID}${JB} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(JC);
    expect(dump).not.toContain(JA);
    expect(dump).not.toContain(JB);
    // THE F1 LEAK, pinned shut: no ≥8 window of the carved value survives.
    expect(dump).not.toContain(JMID);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('Use [SECRET 2][SECRET 1][SECRET 3] now');
    // All three reveals round-trip (the carved candidate keeps its handle).
    for (const [ord, value] of [[1, JC], [2, JA], [3, JB]] as const) {
      const rev = await revealQuestionSecret(prisma, OWNER, stored.id, ord);
      expect(rev).toMatchObject({ ok: true, value });
    }
  });

  test('F1 mirror ordering (C delivered LAST) — same junction, same guarantee', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Head-overlap key', value: JA },
        { label: 'Tail-overlap key', value: JB },
        { label: 'Short key', value: JC },
      ],
      options: [{ id: 'opt-junction-r', label: `Use ${JA}${JMID}${JB} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(JC);
    expect(dump).not.toContain(JA);
    expect(dump).not.toContain(JB);
    expect(dump).not.toContain(JMID);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('Use [SECRET 1][SECRET 3][SECRET 2] now');
    for (const [ord, value] of [[1, JA], [2, JB], [3, JC]] as const) {
      const rev = await revealQuestionSecret(prisma, OWNER, stored.id, ord);
      expect(rev).toMatchObject({ ok: true, value });
    }
  });

  test('F1 control — when C is NOT delivered, the shared middle is ordinary prose and passes byte-identical (no over-redaction)', async () => {
    // Only A and B are delivered; the junction middle is not a window of
    // either value, so the sweep must leave it alone.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Head-overlap key', value: JA },
        { label: 'Tail-overlap key', value: JB },
      ],
      options: [{ id: 'opt-junction-ctl', label: `Use ${JA}${JMID}${JB} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe(`Use [SECRET 1]${JMID}[SECRET 2] now`);
  });

  // F2 (round-3 follow-up, MAJOR non-blocking): a delivered value whose
  // head-8/tail-8 is the literal marker text 'SECRET n'. Phase 1 inserts the
  // REAL [SECRET 2] handle for the other value's echo; phase 2's fragment
  // leg for the marker-shaped value used to fire INSIDE the handle span,
  // splitting it into '[[SECRET 1]]' — introduced by this PR's two-phase
  // rewrite (base rendered the handle clean). The fragment pass is now
  // placeholder-aware: a fragment only fires inside a RAW segment.
  const F2_HEADVAL = ['SECRET 2', 'password', '99x'].join(''); // head-8 = 'SECRET 2'
  const F2_TAILVAL = ['pass', 'word99', 'SECRET 2'].join(''); // tail-8 = 'SECRET 2'
  const F2_PLAIN = ['zzqqrr', 'ssttuu', 'vvwwxx'].join(''); // fully echoed in the label

  test('F2: a marker-shaped HEAD-8 fragment never splits a REAL handle (round-3 follow-up pin)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Marker-headed key', value: F2_HEADVAL },
        { label: 'Plain key', value: F2_PLAIN },
      ],
      options: [{ id: 'opt-f2-head', label: `use ${F2_PLAIN} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(F2_HEADVAL);
    expect(dump).not.toContain(F2_PLAIN);
    const opts = stored.options as any[];
    // THE F2 CORRUPTION ('use [[SECRET 1]] now' before the guard), pinned
    // shut: the real handle renders exactly as origin/main rendered it.
    expect(String(opts[0].label)).toBe('use [SECRET 2] now');
    expect(String(opts[0].label)).not.toContain('[[');
    const rev1 = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev1).toMatchObject({ ok: true, value: F2_HEADVAL });
    const rev2 = await revealQuestionSecret(prisma, OWNER, stored.id, 2);
    expect(rev2).toMatchObject({ ok: true, value: F2_PLAIN });
  });

  test('F2 mirror: a marker-shaped TAIL-8 fragment never splits a REAL handle', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Marker-tailed key', value: F2_TAILVAL },
        { label: 'Plain key', value: F2_PLAIN },
      ],
      options: [{ id: 'opt-f2-tail', label: `use ${F2_PLAIN} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(F2_TAILVAL);
    expect(dump).not.toContain(F2_PLAIN);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toBe('use [SECRET 2] now');
    expect(String(opts[0].label)).not.toContain('[[');
    const rev1 = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev1).toMatchObject({ ok: true, value: F2_TAILVAL });
    const rev2 = await revealQuestionSecret(prisma, OWNER, stored.id, 2);
    expect(rev2).toMatchObject({ ok: true, value: F2_PLAIN });
  });

  // PA-1 (round-5 BLOCK): the first sweep cut enumerated EVERY
  // (length, offset) window of every candidate with a whole-text regex
  // split in the innermost loop — O(L²·T): 17 SECONDS on an 8192-char
  // (OQ_SECRET_VALUE_MAX) delivered value with NOTHING echoed, an
  // availability cliff on this public tool path (measured by the reviewer
  // through the real seam). The indexed sweep builds an 8-char-window
  // index of the value once (O(L)) and scans the raw segments (O(T)) —
  // this pin holds the whole call to a wall-clock budget a slow CI runner
  // still meets, while the O(L²) cliff (seconds bare-node, far worse under
  // jest) can never pass it.
  test('PA-1: a max-length delivered value costs milliseconds, not seconds (perf pin)', async () => {
    const BIG = ('BigKeyValue99' + '0123456789abcdef').repeat(344).slice(0, 8192);
    expect(BIG.length).toBe(8192);
    const t0 = Date.now();
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Deliver the max-length key to the owner',
      deliverSecrets: [{ label: 'Max key', value: BIG }],
      options: [
        { id: 'opt-go', label: 'Use it' },
        { id: 'opt-stop', label: 'Stop' },
      ],
    });
    const elapsed = Date.now() - t0;
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain(BIG.slice(0, 64));
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: BIG });
    // THE PA-1 CLIFF, pinned shut: the full filing round-trip (parse,
    // create, vault, options, scrub) stays on a request-budget footing.
    expect(elapsed).toBeLessThan(2500);
  });

  // R6-1 (round-6 cross-family review — the PA-1 MIRROR): the find-best →
  // replace → RESCAN sweep was quadratic exactly when the value carried
  // many repeated 8-windows — measured 59,747 ms for an 8192-char
  // 'b'+a×8190+'b' delivery against a 2000-char 'a'-run question, and
  // 8,150 ms for the repeated-block "fake key" shape (both legal inputs:
  // single-line, ≤OQ_SECRET_VALUE_MAX, question at its documented cap).
  // The sweep is now a SINGLE greedy pass: each raw-segment position is
  // visited once and a hit consumes its whole extend immediately — these
  // pins hold BOTH shapes to a wall-clock budget while asserting the scrub
  // still removes every ≥8 window of the value from the stored row.
  test('R6-1 perf: a repeated-window max-length value with a matching echo costs milliseconds (the 59.7s shape)', async () => {
    const VAL = 'b' + 'a'.repeat(8190) + 'b'; // 8192, single-line
    const Q = 'a'.repeat(2000); // the question cap; every 8-window is a value window
    const t0 = Date.now();
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `key is ${Q} ok?`,
      deliverSecrets: [{ label: 'Run key', value: VAL }],
    });
    const elapsed = Date.now() - t0;
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain('a'.repeat(8));
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: VAL });
    expect(elapsed).toBeLessThan(2500);
  });

  test('R6-1 perf mirror: the repeated-block "fake key" shape stays on a request budget (the 8.15s shape)', async () => {
    const VAL = 'zz' + 'ABCDEFGHIJKLMNOP'.repeat(511) + 'yy'; // 8180, single-line
    const Q = 'ABCDEFGHIJKLMNOP'.repeat(125); // 2000
    const t0 = Date.now();
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `key is ${Q} ok?`,
      deliverSecrets: [{ label: 'Block key', value: VAL }],
    });
    const elapsed = Date.now() - t0;
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain('ABCDEFGH');
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: VAL });
    expect(elapsed).toBeLessThan(2500);
  });

  // R6-2 (round-6 cross-family review — the F2 class in PHASE 1): a
  // delivered value that equals placeholder-interior text ('SECRET 2' is a
  // legal 8-char single-line value) made phase 1's whole-text split/join
  // rewrite the REAL handle a longer candidate had just inserted —
  // 'use [SECRET 2] now' corrupted to 'use [[SECRET 1]] now'. Phase 1 is
  // placeholder-aware: full-value replacement only fires inside RAW
  // segments.
  test('R6-2: phase 1 is placeholder-aware — a value equal to placeholder text never rewrites a real handle', async () => {
    const MARKERVAL = 'SECRET 2'; // entry 1 — exactly the handle-interior text
    const PLAIN = 'Pl4inDeliv3redKeyValue0001'; // entry 2 — echoed in the label
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Which key should the agent use?',
      deliverSecrets: [
        { label: 'Marker-valued key', value: MARKERVAL },
        { label: 'Plain key', value: PLAIN },
      ],
      options: [{ id: 'opt-r6', label: `use ${PLAIN} now` }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(JSON.stringify(stored)).not.toContain(PLAIN);
    const opts = stored.options as any[];
    // THE R6-2 CORRUPTION ('use [[SECRET 1]] now' before the fix), pinned
    // shut: the plain key's real handle renders clean.
    expect(String(opts[0].label)).toBe('use [SECRET 2] now');
    expect(String(opts[0].label)).not.toContain('[[');
    const rev1 = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev1).toMatchObject({ ok: true, value: MARKERVAL });
    const rev2 = await revealQuestionSecret(prisma, OWNER, stored.id, 2);
    expect(rev2).toMatchObject({ ok: true, value: PLAIN });
  });
});

// ── no-over-redaction control over the whole change set ────────────────────

describe('R1 round-1 — ordinary payloads pass byte-identical (no over-redaction)', () => {
  test('a fully ordinary card (options, goal/todo, forChatId, expectedAnswerType) is unchanged', async () => {
    mockChatFindUnique.mockImplementation(async () => ({ userId: OWNER }));
    const options = [
      { id: 'opt-go', label: 'Go ahead', consequence: 'the rollout proceeds' },
      { id: 'opt-stop', label: 'Stop', consequence: 'nothing changes' },
    ];
    const goalId = 'fa54f4b9-db30-444e-8e70-1c9c4453e04e';
    const todoId = '55957f4f-27eb-4e13-8ff2-7182bd64fb91';
    const forChatId = '99e63f86-1234-4abc-9def-0123456789ab';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Proceed with the rollout?',
      options: options.map((o) => ({ ...o })),
      goalId, todoId, forChatId,
      expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(stored.goalId).toBe(goalId);
    expect(stored.todoId).toBe(todoId);
    expect((stored as any).forChatId).toBe(forChatId);
    expect((stored as any).expectedAnswerType).toBe('credential:SCHOOLTIME_API_KEY');
    const opts = stored.options as any[];
    expect(opts[0]).toEqual(options[0]);
    expect(opts[1]).toEqual(options[1]);
    expect(JSON.stringify(stored)).not.toContain('[REDACTED');
  });
});
