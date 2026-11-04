/**
 * Ticket 79cc46ee (2026-10-17) — the feedback filer REJECTED any title over
 * 140 chars, and the filing agent never noticed: two P1 memory-audit filings
 * (157/173-char titles) were lost on 2026-10-16 ~3:40 PM PT. Replay pins the
 * fix: an over-length title is SHORTENED (word boundary, ≤139 + '…'), the
 * full original rides at the top of the description and on
 * context.originalTitle, and the row files successfully instead of being
 * rejected. Accept criteria 1–3 from the ticket:
 *   1) a 173-char title files; stored title ≤140; description starts with the
 *      full original title.
 *   2) no path rejects for title length.
 *   3) the tool result says the title was shortened.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const created: any[] = [];
const mockPrisma: any = {
  userFeatureRequest: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    create: jest.fn(async (args: any) => {
      const row = { id: `fresh-${created.length + 1}`, ...args.data };
      created.push(row);
      return row;
    }),
    update: jest.fn(async (args: any) => ({ id: args?.where?.id ?? 'bumped' })),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  releaseDispatchClaim: jest.fn(async () => ({})),
  drainUnderCapTickets: jest.fn(async () => 0),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {},
  asyncHandler: (fn: any) => fn,
  sendError: jest.fn(),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
}));
jest.mock('./incident-twin', () => ({
  __esModule: true,
  findIncidentTwin: jest.fn(async () => null),
  incidentTwinDedupeDisabled: () => true,
}));

import { fileFeedbackTicket, shortenFilingTitle } from './feedback.service';

const CONTEXT = { sessionId: 'sess-79cc46ee', surface: 'coding', filedAt: '2026-10-17T16:00:00.000Z' };

const file = (title: string, description = 'Body text for the filing.') =>
  fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title, description, context: CONTEXT });

describe('shortenFilingTitle (pure helper, ticket 79cc46ee)', () => {
  test('exactly 140 chars — unchanged, never shortened', () => {
    const t140 = 'a'.repeat(140);
    const r = shortenFilingTitle(t140);
    expect(r.shortened).toBe(false);
    expect(r.title).toBe(t140);
  });

  test('141 chars — shortened, stored title ≤140, ends with …', () => {
    const t141 = ('a'.repeat(20) + ' ').repeat(6) + 'tail'; // 121 words-chars + padding → 141
    const made = 'b'.repeat(141);
    const r = shortenFilingTitle(made);
    expect(r.shortened).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(140);
    expect(r.title.endsWith('…')).toBe(true);
    expect(r.originalTitle).toBe(made);
  });

  test('300 chars — shortened to ≤140 with full original preserved', () => {
    const t300 = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const r = shortenFilingTitle(t300);
    expect(r.shortened).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(140);
    expect(r.title.endsWith('…')).toBe(true);
    expect(r.originalTitle).toBe(t300);
  });

  test('no-space title — hard cut, still ≤140 + …, never blows the column', () => {
    const noSpace = 'x'.repeat(200);
    const r = shortenFilingTitle(noSpace);
    expect(r.shortened).toBe(true);
    // no word boundary: the cut is TITLE_MAX-1 chars + the ellipsis = 140 total
    expect(r.title.length).toBe(140);
    expect(r.title).toBe(`${'x'.repeat(139)}…`);
  });

  test('multibyte at the cut point — emoji stays whole (orphan surrogate dropped)', () => {
    // 138 plain chars, then an emoji (2 code units) at the 139/140 boundary.
    const t = `${'a'.repeat(138)}🙂tail that pushes it past one hundred forty characters`;
    const r = shortenFilingTitle(t);
    expect(r.shortened).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(140);
    // no lone surrogate anywhere in the stored title
    expect(/[\uD800-\uDBFF]$/.test(r.title.slice(0, -1))).toBe(false);
    expect(r.title).not.toContain('\uFFFD');
  });

  test('short title — untouched', () => {
    const r = shortenFilingTitle('Short title');
    expect(r.shortened).toBe(false);
    expect(r.title).toBe('Short title');
  });
});

describe('fileFeedbackTicket — over-length titles FILE, never reject (ticket 79cc46ee)', () => {
  beforeEach(() => created.length = 0);

  test('accept 1: a 173-char title files; stored title ≤140; description opens with the full title', async () => {
    const t173 = `${'P1 memory-audit finding with a long descriptive title '.repeat(3)}trailing context words`;
    expect(t173.length).toBeGreaterThan(170);
    const result = await file(t173);
    expect('error' in result).toBe(false); // filed — NOT rejected
    const row = created[0];
    expect(row.title.length).toBeLessThanOrEqual(140);
    expect(row.title.endsWith('…')).toBe(true);
    expect(String(row.description).startsWith(`Full title: ${t173}`)).toBe(true);
    expect(row.context.originalTitle).toBe(t173);
  });

  test('accept 2: no rejection for title length — exactly 141 chars files', async () => {
    const t141 = 'b'.repeat(141);
    const result = await file(t141);
    expect('error' in result).toBe(false);
    expect(created[0].title.length).toBeLessThanOrEqual(140);
  });

  test('empty title is STILL rejected (the only invalid title shape left)', async () => {
    const result = await file('   ');
    expect('error' in result).toBe(true);
    expect((result as any).message).toContain('at least 1 char');
  });

  test('a short title keeps the legacy shape: no prefix, no context stamp', async () => {
    await file('Normal-length title');
    const row = created[0];
    expect(row.title).toBe('Normal-length title');
    expect(String(row.description)).toBe('Body text for the filing.');
    expect(row.context.originalTitle).toBeUndefined();
  });

  test('a near-cap description: the full-title prefix is skipped, context.originalTitle still carries it', async () => {
    const body = 'z'.repeat(7999); // + prefix would exceed 8000
    const longTitle = `${'t'.repeat(30)} `.repeat(4) + 'more words past the cap for sure';
    const result = await file(longTitle, body);
    expect('error' in result).toBe(false);
    const row = created[0];
    expect(String(row.description)).toBe(body); // body untouched, never over cap
    expect(row.context.originalTitle).toBe(longTitle.trim());
  });
});
