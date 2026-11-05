/**
 * Backlog CA-1 (ticket 1b1c41bc residual, todo 76fd0cce) — a console ask filed
 * as PLAIN FREE TEXT is detected at intake and recorded OBSERVE-ONLY.
 *
 * The specimen is the 2026-10-16 amd-server-1 ACL stall: oq_ea52c6ae
 * ("Action needed in the Tailscale admin console (only you can do this): save
 * the v2 ACL …") rendered as an ordinary short card because the flagger passed
 * no `consoleAction` spec, even though PR #1593 had already made the structured
 * path available and doctrine-coaxed.
 *
 * What is pinned here:
 *   • the pure classifier — surface noun AND a do-verb, with the decision-opener
 *     veto that keeps "Should I enable Tailscale?" an ordinary decision card;
 *   • the intake wiring — `console_ask_specless` is recorded for a spec-less
 *     console ask, NOT for a structured one (complete by construction), NOT for a
 *     non-console ask, and never as a refusal;
 *   • the kill switch OWNER_CONSOLE_ASK_DETECT_DISABLED=1.
 *
 * Isolation follows owner-questions.fea78360.test.ts: fresh chatId per test (the
 * testkit table has no deleteMany and the flag path rate-caps 3/hour/chatId).
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
import { detectSpeclessConsoleAsk } from './console-ask';

const USER = 'user-ca1';
let chatSeq = 0;
const uniqueChat = (): string => `chat-ca1-${++chatSeq}`;
const specless = () => metricCalls.filter((c) => c.kind === 'console_ask_specless');

async function flag(args: Record<string, unknown>, chatId: string = uniqueChat()) {
  return flagOwnerQuestion({ chatId, userId: USER, ...args } as any);
}

/** The specimen card, verbatim in shape (oq_ea52c6ae). */
const SPECIMEN = "[ctrl.cql.ca] Action needed in the Tailscale admin console (only you can do this): save the v2 ACL that grants the deploy lane's key access to amd-server-1.";

beforeEach(() => {
  jest.clearAllMocks();
  metricCalls.length = 0;
  delete process.env.OWNER_CONSOLE_ASK_DETECT_DISABLED;
  delete process.env.OWNER_CARD_CONTRACT_DISABLED;
});

// ── the pure classifier ─────────────────────────────────────────────────────
describe('detectSpeclessConsoleAsk — surface noun AND do-verb', () => {
  it('detects the specimen (Tailscale + save)', () => {
    const d = detectSpeclessConsoleAsk(SPECIMEN);
    expect(d.detected).toBe(true);
    expect(d.surfaces).toContain('tailscale');
    expect(d.verbs).toContain('save');
    expect(d.excerpt).toContain('Tailscale');
  });

  it('detects the other console shapes the backlog names (GCP / AWS / Gmail / admin console)', () => {
    expect(detectSpeclessConsoleAsk('Please paste this policy into the GCP console and save it.').detected).toBe(true);
    expect(detectSpeclessConsoleAsk('Go to the AWS console and create an IAM user for the lane.').detected).toBe(true);
    expect(detectSpeclessConsoleAsk('In Gmail settings, enable the SMTP relay and confirm.').detected).toBe(false); // "settings", not a console — surfaces only, still no surface match
    expect(detectSpeclessConsoleAsk('In the admin console, click Save to apply the ACL.').detected).toBe(true);
    expect(detectSpeclessConsoleAsk('Open the Cloudflare dashboard and add the TXT record.').detected).toBe(true);
  });

  it('a surface with NO do-verb is a status mention, not a console ask', () => {
    expect(detectSpeclessConsoleAsk('The Tailscale tailnet is healthy and unchanged tonight.').detected).toBe(false);
    expect(detectSpeclessConsoleAsk('The AWS bill came in lower this month.').detected).toBe(false);
    expect(detectSpeclessConsoleAsk('We moved the whole thing to Cloudflare last quarter.').detected).toBe(false);
  });

  it('a do-verb with NO surface is an ordinary ask', () => {
    expect(detectSpeclessConsoleAsk('Create the todo and save the plan.').detected).toBe(false);
    expect(detectSpeclessConsoleAsk('').detected).toBe(false);
  });

  it('the decision-opener veto keeps an owner-directed decision a decision ("Should I enable Tailscale?")', () => {
    const d = detectSpeclessConsoleAsk('Should I enable Tailscale on the new box, or leave it off?');
    expect(d.detected).toBe(false);
    expect(d.surfaces).toContain('tailscale'); // the surface is still REPORTED — evidence, not a verdict
    expect(detectSpeclessConsoleAsk('Do you want me to create the GCP service account?').detected).toBe(false);
    expect(detectSpeclessConsoleAsk('Which registrar should we use — paste the options?').detected).toBe(false);
  });

  it('a bare "console" alone is NOT a surface — it needs an operator qualifier', () => {
    expect(detectSpeclessConsoleAsk('Check the console output of the build and save the log.').detected).toBe(false);
    // …while a QUALIFIED console is a real surface: the owner is told to act there.
    expect(detectSpeclessConsoleAsk('In the admin console, click Save to apply the ACL.').detected).toBe(true);
    expect(detectSpeclessConsoleAsk('Open the DNS console and add the TXT record.').detected).toBe(true);
  });
});

// ── intake wiring ──────────────────────────────────────────────────────────
describe('console_ask_specless (observe-only intake metric)', () => {
  it('records ONE row for a spec-less console ask — and never refuses the card', async () => {
    const r = await flag({ question: SPECIMEN });
    expect(r.kind).toBe('created');
    expect(specless()).toHaveLength(1);
    expect(specless()[0].meta).toMatchObject({ kind: 'flag' });
    expect(specless()[0].meta.surfaces).toContain('tailscale');
    expect(specless()[0].meta.verbs).toContain('save');
    expect(String(specless()[0].meta.excerpt)).toContain('Tailscale');
  });

  it('does NOT record for a card that carries the structured consoleAction spec (complete by construction)', async () => {
    const r = await flag({
      question: 'Tailscale ACL for amd-server-1',
      consoleAction: {
        consoleName: 'Tailscale admin console',
        consoleUrl: 'https://login.tailscale.com/admin/acls',
        whatAndWhySafe: 'Grants the deploy lane SSH access; safe because the tag is lane-scoped.',
        payload: '{"acls":[{"action":"accept","src":["tag:digby-dev"],"dst":["amd-server-1:22"]}]}',
        payloadLanguage: 'json',
        steps: ['Open the Access Controls tab', 'Select all and paste', 'Click Save'],
      },
    });
    expect(r.kind).toBe('created');
    expect(specless()).toHaveLength(0);
  });

  it('does NOT record for an ordinary non-console decision card', async () => {
    await flag({ question: 'Which of these two launch dates do you prefer — Nov 12 or Nov 19?' });
    expect(specless()).toHaveLength(0);
  });

  it('detects in the CONTEXT too, not only the question line', async () => {
    await flag({
      question: 'One 2-minute step, only you can do it.',
      context: 'In the Tailscale admin console → Access Controls, replace the tests line and click Save.',
    });
    expect(specless()).toHaveLength(1);
  });

  it('OWNER_CONSOLE_ASK_DETECT_DISABLED=1 stops the metric (the card still files)', async () => {
    process.env.OWNER_CONSOLE_ASK_DETECT_DISABLED = '1';
    try {
      const r = await flag({ question: SPECIMEN });
      expect(r.kind).toBe('created');
      expect(specless()).toHaveLength(0);
    } finally { delete process.env.OWNER_CONSOLE_ASK_DETECT_DISABLED; }
  });
});