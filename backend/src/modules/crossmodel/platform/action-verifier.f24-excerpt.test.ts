/**
 * FO firing 24 (2026-09-26) — token-anchored clockHits excerpts.
 *
 * The fired-24 forensic: three in-window future-clock strikes (c0e22e36
 * 21:44:00.309Z CanLaw "TRAIN_DONE ~2:30–2:45 PM PDT" +9min, 23:06:59.323Z
 * CQL "~4:40 PM PDT" +41min, 00:19:36.900Z CQL "5:45 PM PDT" +34min) needed a
 * live in-container repro to classify because the stored clockHits.line
 * excerpts were LINE-HEAD slices (rawLine.trim().slice(0, 160) in the guard,
 * re-sliced to 120 in the chat-agent seam). On the 00:19Z row the stored
 * excerpt ENDED BEFORE THE TOKEN — the row is unrecoverable post-hoc (the
 * governing context, marker or clause-scoped verb, is gone). This suite pins
 * the new excerpt contract (tokenAnchoredExcerpt):
 *  1. a short strike line is stored whole;
 *  2. a long strike line keeps the TOKEN visible (the 00:19Z shape);
 *  3. an unmarked range END's start rides along (the 21:44Z shape) so the
 *     operator sees the range, not a lone clock;
 *  4. a mid-line window start is marked with a leading ellipsis;
 *  5. the excerpt stays ≤161 chars — the seam's 164 re-slice keeps it whole.
 * Conviction shapes here are BARE tokens (no ~ marker, no intent word) — the
 * marked/estimate lines clear on current code by design (i11/i14/i15).
 */
const mockPrisma: any = { crossModelChat: { findUnique: jest.fn(async () => null) }, $queryRawUnsafe: jest.fn(async () => []) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })), appendVerifierRefutation: jest.fn(async () => {}) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { findFutureObservedTimestamps } from './action-verifier';

const NOW = new Date('2026-09-25T21:36:00Z'); // 2:45 PM PDT = 21:45Z → +9 min (the CanLaw strike geometry)

describe('FO firing 24 — token-anchored clockHits excerpts (findFutureObservedTimestamps.line)', () => {
  it('strikes a short bare-token line and stores it whole', () => {
    const line = '| lane X | serving green through the 2:45 PM PDT cutover |';
    const hits = findFutureObservedTimestamps(line + '\n', NOW, {});
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.token.includes('2:45'))!;
    expect(hit.line).toBe(line);
    expect(hit.line).toContain(hit.token);
  });

  it('keeps the struck TOKEN visible when the line far exceeds the window (00:19Z CQL shape)', () => {
    const line = '| CQL Gateway | ✅ Your 4 AGX routes + engine rename + tag fix all merged · deploy executing with the known-bad node-b leg still serving the legacy spark route through the 2:45 PM PDT cutover';
    expect(line.length).toBeGreaterThan(160); // the old excerpt cut off before the token
    const hits = findFutureObservedTimestamps(line + '\n', NOW, {});
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.token.includes('2:45'))!;
    expect(hit.line).toContain('2:45 PM PDT');
    expect(hit.line).toContain('merged'); // the clause-scoped verb context rides along
    expect(hit.line.length).toBeLessThanOrEqual(161);
  });

  it('carries the range START with an unmarked range END (21:44Z CanLaw shape)', () => {
    const line = '| CanLaw | Final SFT round training, no 5th preemption, all lanes healthy, disk and thermals nominal, serving steady | TRAIN_DONE 2:30–2:45 PM PDT |';
    const hits = findFutureObservedTimestamps(line + '\n', NOW, {});
    expect(hits.length).toBeGreaterThanOrEqual(1); // unmarked range: the END convicts bare
    const hit = hits.find((h) => h.token.includes('2:45'))!;
    expect(hit.line).toContain('2:30–2:45'); // the operator sees it is a range END
  });

  it('marks a mid-window start with a leading ellipsis and bounds the excerpt', () => {
    const line = 'z'.repeat(400) + 'serving green through the 2:45 PM PDT cutover, drains nominal';
    const hits = findFutureObservedTimestamps(line + '\n', NOW, {});
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.token.includes('2:45'))!;
    expect(hit.line.startsWith('…')).toBe(true);
    expect(hit.line).toContain('2:45 PM PDT');
    expect(hit.line.length).toBeLessThanOrEqual(161);
  });
});
