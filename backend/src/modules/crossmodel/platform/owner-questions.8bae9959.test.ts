/**
 * Ticket 8bae9959 replay pins (2026-09-14): listOwnerQuestionsForUser's ids
 * filter was an exact `id IN (…)` — an oq_-prefixed ≥8-char SHORT PREFIX (the
 * form lane relays and attention blocks cite, e.g. "oq_9a0e5a3a") matched NO
 * row, and the list_owner_questions tool replied "it has resolved or never
 * existed — do not report it as a blocker" about a gate that was OPEN and
 * triaged. The false-cleared gate then propagates "gate cleared" to blocked
 * work — the exact failure class the gate-state probe exists to kill.
 *
 * Ticket repro (two consecutive calls, same wake, 2026-09-14 ~13:40Z):
 *   list_owner_questions(ids=["oq_9a0e5a3a","oq_18f7b49d"]) → "No owner
 *     questions match those filters. … never existed …"
 *   list_owner_questions(chatId=b95e9df6-…) → BOTH rows existed:
 *     oq_9a0e5a3a-2b1d-46a9-bf1d-04e104346ead (OPEN, triaged) and
 *     oq_18f7b49d-3113-4bf8-9e82-82da61556064 (answered).
 *
 * Pins:
 *   - a unique ≥8-char oq_-prefixed prefix resolves its row (the ticket's
 *     exact id pair reproduces the report and now returns BOTH rows);
 *   - full ids keep working (a full id is a prefix of itself);
 *   - a prefix shorter than 8 chars does NOT resolve (sibling-tool contract:
 *     "unique ≥8-char prefix") and is reported in unmatchedIds;
 *   - an ambiguous prefix returns EVERY candidate row (a read-only probe
 *     showing two live statuses beats a false "never existed");
 *   - supplied ids matching no row come back in unmatchedIds — the tool names
 *     them instead of the blanket "never existed";
 *   - resolution is owner-scoped and NOT intersected with the status/chatId
 *     filters (a real id hidden by a filter is never reported unmatched).
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listOwnerQuestionsForUser } from './owner-questions';

// The ticket's exact id pair (prefix forms cited in the report: oq_9a0e5a3a
// and oq_18f7b49d — 11 chars each, well past the ≥8 bar).
const OPEN_ID = 'oq_9a0e5a3a-2b1d-46a9-bf1d-04e104346ead';
const ANSWERED_ID = 'oq_18f7b49d-3113-4bf8-9e82-82da61556064';

function seed() {
  mockQuestions.rows.push(
    { id: OPEN_ID, userId: 'u1', chatId: 'lane-a', question: 'Rebuild the index now?', status: 'open', answer: null, createdAt: new Date(Date.now() - 2000), resolvedAt: null },
    { id: ANSWERED_ID, userId: 'u1', chatId: 'lane-a', question: 'Ship the checkpoint?', status: 'answered', answer: 'yes — ship it', createdAt: new Date(Date.now() - 1000), resolvedAt: new Date(Date.now() - 500) },
  );
}

beforeEach(() => {
  mockQuestions.reset();
  jest.clearAllMocks();
});

describe('listOwnerQuestionsForUser — oq_-prefixed short-prefix ids (ticket 8bae9959)', () => {
  it('TICKET REPRO: the two cited 11-char prefixes return BOTH rows at their live status — never a false "never existed"', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_9a0e5a3a', 'oq_18f7b49d'] });
    expect(unmatchedIds).toEqual([]);
    expect(rows.map((q) => q.id).sort()).toEqual([OPEN_ID, ANSWERED_ID].sort());
    // Live statuses survive — the answered gate is visible as answered.
    expect(rows.find((q) => q.id === OPEN_ID)?.status).toBe('open');
    expect(rows.find((q) => q.id === ANSWERED_ID)?.status).toBe('answered');
  });

  it('full ids keep working (a full id is a prefix of itself)', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: [OPEN_ID, ANSWERED_ID] });
    expect(unmatchedIds).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it('an 8-char prefix resolves (the documented floor); a 7-char fragment does NOT — it lands in unmatchedIds', async () => {
    seed();
    const eight = await listOwnerQuestionsForUser('u1', { ids: [OPEN_ID.slice(0, 8)] }); // 'oq_9a0e5a'
    expect(eight.unmatchedIds).toEqual([]);
    expect(eight.rows.map((q) => q.id)).toEqual([OPEN_ID]);
    const seven = await listOwnerQuestionsForUser('u1', { ids: [OPEN_ID.slice(0, 7)] }); // 'oq_9a0e'
    expect(seven.rows).toEqual([]);
    expect(seven.unmatchedIds).toEqual([OPEN_ID.slice(0, 7)]);
  });

  it('an ambiguous prefix returns EVERY candidate row (read-only probe: two live statuses beat a false miss)', async () => {
    mockQuestions.rows.push(
      { id: 'oq_aabbcc11-0000-4000-8000-000000000001', userId: 'u1', chatId: 'lane-a', question: 'Q1?', status: 'open', answer: null, createdAt: new Date(Date.now() - 2000), resolvedAt: null },
      { id: 'oq_aabbcc22-0000-4000-8000-000000000002', userId: 'u1', chatId: 'lane-b', question: 'Q2?', status: 'answered', answer: 'no', createdAt: new Date(Date.now() - 1000), resolvedAt: new Date() },
    );
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_aabbcc'] });
    expect(unmatchedIds).toEqual([]);
    expect(rows.map((q) => q.id).sort()).toEqual([
      'oq_aabbcc11-0000-4000-8000-000000000001',
      'oq_aabbcc22-0000-4000-8000-000000000002',
    ].sort());
  });

  it('ids matching no row are reported in unmatchedIds (mixed probe: found + bogus)', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_9a0e5a3a', 'oq_deadbeef'] });
    expect(rows.map((q) => q.id)).toEqual([OPEN_ID]);
    expect(unmatchedIds).toEqual(['oq_deadbeef']);
  });

  it('resolution is owner-scoped: another user\'s row is NOT resolved by its prefix', async () => {
    mockQuestions.rows.push(
      { id: OPEN_ID, userId: 'someone-else', chatId: 'lane-x', question: 'Not yours?', status: 'open', answer: null, createdAt: new Date(), resolvedAt: null },
    );
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_9a0e5a3a'] });
    expect(rows).toEqual([]);
    expect(unmatchedIds).toEqual(['oq_9a0e5a3a']);
  });

  it('resolution is NOT intersected with the status filter — a real id hidden by status:open is not "unmatched"', async () => {
    seed();
    // The answered row exists but is hidden by the open-only filter: rows is
    // empty for it, yet unmatchedIds must NOT claim it never existed.
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_18f7b49d'], status: 'open' });
    expect(rows).toEqual([]);
    expect(unmatchedIds).toEqual([]);
  });

  it('duplicate supplied ids resolve the row once', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['oq_9a0e5a3a', 'oq_9a0e5a3a', OPEN_ID] });
    expect(unmatchedIds).toEqual([]);
    expect(rows.map((q) => q.id)).toEqual([OPEN_ID]);
  });

  it('blank/whitespace entries are dropped before resolution (never probed, never unmatched)', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', { ids: ['   ', '', OPEN_ID] });
    expect(unmatchedIds).toEqual([]);
    expect(rows.map((q) => q.id)).toEqual([OPEN_ID]);
  });

  it('no ids → plain list path unchanged (unmatchedIds empty)', async () => {
    seed();
    const { rows, unmatchedIds } = await listOwnerQuestionsForUser('u1', {});
    expect(rows).toHaveLength(2);
    expect(unmatchedIds).toEqual([]);
  });
});
