/**
 * Ticket 8f5989c7 — the write-time half of the scope-statement fix.
 *
 * Specimen oq_81ce2c39: a 792-char self-contained credential ask
 * ("[cql-accelerator] One thing only you can supply: the pcozz sudo
 * password … Nothing else is needed from you.") whose only admission gap
 * was the options axis — the card enumerates its ENTIRE ask and declares
 * nothing beyond it, an EMPTY decision space. The leaf (owner-card-gaps.ts)
 * now completes the options axis on the card's own scope statement
 * (ASK_SCOPE_COMPLETE); this suite pins that at the SERVICE level: the
 * write-time contract metric owner_card_payload_incomplete no longer fires
 * for an enumerated ask, and a flagger who declared optionalAsk:false
 * still gets the metric (typed beats prose). One definition, two
 * enforcement points — the sweep-level pins are in
 * fleet/framework-signal-detectors.test.ts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../config/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOwnerQuestionTable } = require('./owner-questions.testkit');
  const mockQuestions = createOwnerQuestionTable();
  return {
    __esModule: true,
    default: {
      ownerQuestion: mockQuestions.api,
      crossModelMessage: mockQuestions.crossModelMessage,
      crossModelChat: mockQuestions.crossModelChat,
    },
  };
});

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the ad4fae90 suite pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(),
}));

jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => undefined),
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
}));

const metricCalls: Array<{ kind: string; meta: Record<string, unknown> }> = [];
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn((input: any) => {
    metricCalls.push({ kind: input?.kind, meta: input?.meta ?? {} });
  }),
}));

import { flagOwnerQuestion } from './owner-questions';
import { detectOwnerCardPayloadGaps } from './owner-card-gaps';

const USER = 'user-8f5989c7';
let chatSeq = 0;
const uniqueChat = (): string => `chat-8f5989c7-${++chatSeq}`;

/** The db mock (for row-state assertions). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = (jest.requireMock('../../../config/database') as any).default;

async function flag(args: Record<string, unknown>, chatId: string = uniqueChat()) {
  return flagOwnerQuestion({ chatId, userId: USER, ...args } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  metricCalls.length = 0;
  delete process.env.OWNER_CARD_CONTRACT_DISABLED;
});

/** The specimen's shape (verbatim scope statements, shortened middle). */
const ENUMERATED_ASK = [
  '[cql-accelerator] One thing only you can supply: the pcozz sudo password on the AGX.',
  'The box rebooted 03:58Z and is healthy, but the memory leak is uncontained (it froze twice tonight); the lane tried to apply the fix itself, but sudo on the AGX requires a password — measured twice tonight.',
  'Paste the pcozz password into this card\u2019s credential field; it goes straight to the encrypted vault and the lane applies the containment cap over SSH within minutes, verifies, and rolls back safely if anything fails.',
  'Nothing else is needed from you.',
].join('\n');

describe('scope-statement completion (8f5989c7, write-time)', () => {
  it('an enumerated single-action ask records NO payload-incomplete metric', async () => {
    const r = await flag({ question: ENUMERATED_ASK });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('the exact live specimen (792 chars, verbatim) records NO metric', async () => {
    const ask = [
      '[cql-accelerator] One thing only you can supply: the pcozz sudo password on the AGX. Your Hue power cycle worked — the box rebooted 03:58Z and is healthy (23.6 GiB RAM free, embed + rerank serving) — but the memory leak is uncontained and will re-wedge the box within hours (it froze twice tonight). The lane tried to apply the fix itself per your "you have shell access" reply, but sudo on the AGX requires a password — measured twice tonight: "sudo: a password is required" (01:00Z and 04:03Z). Paste the pcozz password into this card\u2019s credential field; it goes straight to the encrypted vault (never into any chat) and the lane applies the containment cap (44G/48G + auto-restart) over SSH within minutes, verifies, and rolls back safely if anything fails. Nothing else is needed from you.',
    ].join('\n');
    const r = await flag({ question: ask });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('a scope statement does NOT complete the BACKGROUND axis — a bare cue ask with no background still records the metric', async () => {
    // Scope completes the OPTIONS axis only; background stays its own axis
    // (the a3a7dd88 separation). No background cue anywhere, context null.
    const r = await flag({
      question: 'paste the recovery key — that is all',
    });
    expect(r.kind).toBe('created');
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect(row!.meta.missing).toEqual(['background']);
    expect(row!.meta.missing).not.toContain('options');
  });

  it('optionalAsk:false still gaps an enumerated ask — typed beats prose (8f5989c7)', async () => {
    const r = await flag({
      question: 'nothing else is needed - paste the recovery key',
      optionalAsk: false,
    });
    expect(r.kind).toBe('created');
    expect((r as any).question.optionalAsk).toBe(false);
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect(row!.meta.missing).toContain('options');
  });

  it('the near-miss class stays gapped: withholding "needed", no scope statement', async () => {
    const r = await flag({
      question: 'the api key is needed to restore the route - paste it',
    });
    expect(r.kind).toBe('created');
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect(row!.meta.missing).toContain('options');
  });

  it('one definition, two enforcement points: the stored row re-read by the sweep admission agrees', async () => {
    // The exact shape the read-time sweep selects
    // (framework-signal-sweep loadQuestions): gaps computed from the stored
    // row must agree with the write-time verdict — the metric does not fire
    // and the sweep would not flag.
    const r = await flag({ question: ENUMERATED_ASK });
    expect(r.kind).toBe('created');
    const stored = await db.ownerQuestion.findFirst({ where: { userId: USER } });
    expect(stored).toBeTruthy();
    const gaps = detectOwnerCardPayloadGaps({
      question: stored.question,
      context: stored.context,
      options: stored.options ?? undefined,
      optionalAsk: stored.optionalAsk === true ? true : stored.optionalAsk === false ? false : null,
      expectedAnswerType: typeof stored.expectedAnswerType === 'string' ? stored.expectedAnswerType : null,
    });
    expect(gaps).toEqual([]);
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });
});
