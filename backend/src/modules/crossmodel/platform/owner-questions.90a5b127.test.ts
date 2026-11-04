/**
 * Ticket 90a5b127 — the write-time half of the owner-card options-axis fix.
 *
 * The cea10fa4 fix completed the options axis from PROSE (optionality
 * wording + decline path); its adversarial review (session c688f0c7,
 * MERGE-SAFE, 3 non-blocking findings) surfaced the wording-chase recurrence
 * that produced this ticket. This suite pins the STRUCTURAL half at the
 * service level: the flagger's typed optionalAsk declaration (and the
 * declared answer type) rides flag_owner_question, is stored on the row, and
 * feeds the SAME detectOwnerCardPayloadGaps admission the read-time sweep
 * applies (one definition, two enforcement points — the leaf-level pins are
 * in owner-card-gaps.90a5b127.test.ts, the sweep-level pins in
 * fleet/framework-signal-detectors.test.ts).
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

const USER = 'user-90a5b127';
let chatSeq = 0;
const uniqueChat = (): string => `chat-90a5b127-${++chatSeq}`;

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

describe('optionalAsk declaration (90a5b127, write-time)', () => {
  it('optionalAsk:true stores true on the row and completes the options axis — no metric', async () => {
    // An urgent-worded ask with NO optionality prose: pre-90a5b127 this card
    // recorded owner_card_payload_incomplete missing:['options'].
    const r = await flag({
      question: 'the deploy routes are 401 without the api key - paste it',
      optionalAsk: true,
    });
    expect(r.kind).toBe('created');
    expect((r as any).question.optionalAsk).toBe(true);
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('optionalAsk:false stores false and suppresses the prose fallback', async () => {
    const r = await flag({
      question: 'no rush - paste the key',
      optionalAsk: false,
    });
    expect(r.kind).toBe('created');
    expect((r as any).question.optionalAsk).toBe(false);
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect(row!.meta.missing).toContain('options');
  });

  it('omitted optionalAsk stores NULL and the prose fallback applies', async () => {
    const r = await flag({
      question: 'no rush - paste the key',
    });
    expect(r.kind).toBe('created');
    expect((r as any).question.optionalAsk).toBeUndefined();
    // The options axis completed via the PROSE fallback (no declaration);
    // 'background' is still legitimately missing (no background cue) — the
    // pinned axis here is options, which must NOT be in missing.
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row?.meta.missing).not.toContain('options');
  });

  it('a yes_no declaration completes the options axis at write time too', async () => {
    const r = await flag({
      question: 'should i proceed with the rollback? background: the deploy failed at 03:00Z',
      expectedAnswerType: 'yes_no',
    });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('a credential declaration does NOT complete the options axis', async () => {
    const r = await flag({
      question: 'paste the deploy key now',
      context: 'the deploy is failing',
      expectedAnswerType: 'credential:DEPLOY_KEY',
    });
    expect(r.kind).toBe('created');
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect(row!.meta.missing).toContain('options');
  });

  it('one definition, two enforcement points: the write-time stored row re-read by the sweep admission agrees', async () => {
    // The exact shape the read-time sweep selects (framework-signal-sweep
    // loadQuestions): the stored row must produce the SAME verdict through
    // detectOwnerCardPayloadGaps as the write-time admission did.
    const r = await flag({
      question: 'the deploy routes are 401 without the api key - paste it',
      optionalAsk: true,
    });
    expect(r.kind).toBe('created');
    const stored = (r as any).question;
    const gaps = detectOwnerCardPayloadGaps({
      question: stored.question,
      context: stored.context ?? null,
      options: stored.options,
      optionalAsk: stored.optionalAsk ?? null,
      expectedAnswerType: stored.expectedAnswerType ?? null,
    });
    expect(gaps).toEqual([]); // complete — the sweep will skip this card too
  });

  it('DETECTOR-RECALL REPLAY (90a5b127): the write-time metric still fires for prior convictions', async () => {
    // The pre-family classic: a bare ask, no context, no options, no cues.
    const r = await flag({ question: 'Which color for the header bar?' });
    expect(r.kind).toBe('created');
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect((row!.meta.missing as string[]).sort()).toEqual(['background', 'options']);
  });
});
