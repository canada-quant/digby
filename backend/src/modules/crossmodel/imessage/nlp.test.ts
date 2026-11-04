/**
 * Tests for iMessage NLP contact resolution.
 * 2026-06-25: Created alongside the regex-injection hardening in resolveNamedChat().
 *
 * The module imports logger (→ env.ts, which process.exit(1)s without env vars in
 * tests) and utilityChat. Both are mocked so importing nlp.ts is side-effect-free.
 */
// Decision gate (2026-09-24): stubbed OFF so this suite keeps pinning the
// pre-gate behaviour. The real module's import chain (loop-metrics.service →
// config/database → config/env) and its shadow-mode seat lookup
// (model-roles.service → middleware/error-handler → config/env) both
// process.exit(1) without env vars. Gate behaviour: *.decision-gate.test.ts.
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(),
}));

import { resolveNamedChat } from './nlp';

describe('resolveNamedChat', () => {
  const chats = [
    { chatId: 1, identifier: '+15551234567', displayName: 'Sarah Connor' },
    { chatId: 2, identifier: 'jsmith@example.com', displayName: 'John Smith' },
  ];

  it('matches a full display name appearing verbatim', () => {
    expect(resolveNamedChat('text Sarah Connor I am late', chats)?.chatId).toBe(1);
  });

  it('matches on first name', () => {
    expect(resolveNamedChat('let John know dinner is ready', chats)?.chatId).toBe(2);
  });

  it('returns null when no contact is referenced', () => {
    expect(resolveNamedChat('what time is it', chats)).toBeNull();
  });

  it('does not throw on contact names with regex metacharacters', () => {
    // Defensive: norm() strips these, but the RegExp build must never throw/inject.
    const weird = [
      { chatId: 9, identifier: 'cpp@example.com', displayName: 'C++ Group' },
      { chatId: 10, identifier: 'ob@example.com', displayName: "O'Brien (work)" },
    ];
    expect(() => resolveNamedChat('ping the cpp group', weird)).not.toThrow();
  });

  it('returns null for empty input', () => {
    expect(resolveNamedChat('', chats)).toBeNull();
  });
});
