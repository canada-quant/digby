/**
 * Agent feedback loop — feedback.service unit tests with mocked Prisma.
 * Pins: validation, the 90-day dedup (normalized title), the per-session +
 * global rate caps (structured refusals, never throws), the agent-source
 * create path (nullable userId), and the admin list/update shapes.
 * Pattern follows platform/platform.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The burn-down drain hook dynamically imports ticket-dispatch.service, which
// pulls config/redis → config/env (process.exit without env vars) — mock the
// boundary.
const mockDrainOpenTicketsToLane = jest.fn(async () => ({ result: 'sent', batched: 1 }));
const mockReleaseTicketDispatchClaim = jest.fn(async () => undefined);
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: (...a: any[]) => (mockDrainOpenTicketsToLane as any)(...a),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: (...a: any[]) => (mockReleaseTicketDispatchClaim as any)(...a),
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import {
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  DEDUP_SCAN_PAGE,
  fileFeedbackTicket,
  findCrossSourceDuplicate,
  getFeedbackTicketById,
  isSystemTicketFiling,
  listFeedbackTickets,
  promoteQueuedFeedbackTickets,
  updateFeedbackTicket,
  isAdminUser,
  normalizeFeedbackTitle,
  titleTokenJaccard,
} from './feedback.service';
import { Prisma } from '@prisma/client';

const VALID = {
  userId: 'u1',
  type: 'bug_report',
  title: 'Send button unresponsive on mobile',
  description: 'Tapping send does nothing until the keyboard is dismissed.',
  context: { sessionId: 'sess-1', surface: 'chat', filedAt: '2026-07-29T00:00:00.000Z' },
};

beforeEach(() => jest.clearAllMocks());

describe('FEEDBACK_TYPES', () => {
  it('covers the 3 legacy user types plus the 3 agent categories', () => {
    expect([...FEEDBACK_TYPES]).toEqual([
      'feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea',
    ]);
  });
});

describe('fileFeedbackTicket — validation', () => {
  it('rejects an unknown type without touching the DB', async () => {
    const r = await fileFeedbackTicket({ ...VALID, type: 'epiphany' });
    expect(r).toMatchObject({ error: 'invalid' });
    expect((r as any).message).toMatch(/Invalid type "epiphany"/);
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('rejects empty titles; SHORTENS oversized ones instead of rejecting (ticket 79cc46ee)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-79cc46ee', ...data }));
    expect(await fileFeedbackTicket({ ...VALID, title: '   ' })).toMatchObject({ error: 'invalid' });
    // 79cc46ee: a >140-char title is no longer rejected — it is stored shortened
    // (word boundary + '…') with the full original at the top of the description
    // and on context.originalTitle. The two lost 157/173-char P1 filings were
    // the incident; never reject on title length again.
    const long = await fileFeedbackTicket({ ...VALID, title: 'x'.repeat(141) });
    expect('error' in long).toBe(false);
    expect((long as any).ticket.title.length).toBeLessThanOrEqual(140);
    expect((long as any).ticket.title.endsWith('…')).toBe(true);
    expect(String((long as any).ticket.description)).toContain('Full title: ');
    expect((long as any).ticket.context.originalTitle).toBe('x'.repeat(141));
  });

  it('rejects empty / oversized descriptions', async () => {
    expect(await fileFeedbackTicket({ ...VALID, description: '' })).toMatchObject({ error: 'invalid' });
    expect(await fileFeedbackTicket({ ...VALID, description: 'x'.repeat(8001) })).toMatchObject({ error: 'invalid' });
  });

  it('rejects out-of-range / non-integer priority', async () => {
    for (const priority of [-1, 6, 2.5, NaN]) {
      expect(await fileFeedbackTicket({ ...VALID, priority })).toMatchObject({ error: 'invalid' });
    }
  });

  it('rejects an oversized area hint', async () => {
    expect(await fileFeedbackTicket({ ...VALID, area: 'x'.repeat(41) })).toMatchObject({ error: 'invalid' });
  });
});

describe('fileFeedbackTicket — dedup', () => {
  it('a repeat sighting bumps priority + occurrences instead of creating a row', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't1', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
      priority: 1, source: 'agent', description: 'Original report.',
      context: { sessionId: 'sess-0', occurrences: 3, area: 'chat' },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't1' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 4 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't1' });
    expect(upd.data.priority).toBe(4); // max(old 1, new 4)
    expect(upd.data.context.sessionId).toBe('sess-0'); // original context kept
    expect(upd.data.context.area).toBe('chat');
    expect(upd.data.context.occurrences).toBe(4);
    expect(typeof upd.data.context.lastSeen).toBe('string');
    // the repeat sighting's evidence is kept: the new description appended
    // under a separator, plus a sightings-trail entry from the NEW filing
    expect(upd.data.description).toBe(`Original report.\n\n--- sighting 4 ---\n${VALID.description}`);
    expect(upd.data.context.sightings).toEqual([
      { sessionId: 'sess-1', filedAt: '2026-07-29T00:00:00.000Z' },
    ]);
  });

  it('normalization matches punctuation/case/whitespace variants', async () => {
    expect(normalizeFeedbackTitle('  Send   BUTTON — unresponsive (on mobile)!! ')).toBe('send button unresponsive on mobile');
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't2', type: 'bug_report', title: 'Send   BUTTON — unresponsive (on mobile)!!', status: 'in_progress',
      priority: 5, source: 'agent', description: 'First report.', context: null,
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't2' });
    const r = await fileFeedbackTicket({ ...VALID, title: 'Send button: UNRESPONSIVE on mobile.', priority: 2 });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.priority).toBe(5); // max(old 5, new 2) — never downgrades
    expect(upd.data.context.occurrences).toBe(2); // no prior occurrences → 1 + 1
  });

  it('does NOT dedup across a different type — and the reopen scan is done-only, same type, agent-sourced', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]); // query is type/status-scoped
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockResolvedValue({ id: 't3' });
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: false });
    // the dedup query is scoped to open-ish AGENT tickets of the same type,
    // 90-day window, newest-first and bounded
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[0][0];
    expect(q.where.type).toBe('bug_report');
    expect(q.where.source).toBe('agent'); // never dedup against user-filed rows
    expect(q.where.status).toEqual({ in: ['open', 'in_progress', 'queued', 'reopened'] });
    expect(q.where.createdAt.gte.getTime()).toBeLessThanOrEqual(Date.now() - 89 * 24 * 3600_000);
    // 586ebe71: the scan pages newest-first over the FULL 90-day window on a
    // (createdAt, id) total order — no 200-row ceiling to erode under volume.
    expect(q.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(q.take).toBe(DEDUP_SCAN_PAGE);
    // and the page is narrowed DB-side by the normalization-stable prefilter
    expect(q.where.AND).toEqual([{ title: { contains: 'unresponsive', mode: 'insensitive' } }]);
    // the reopen-on-recurrence scan: same type/source/window, CLOSED rows
    // only, most-recently-closed first (2026-08-31 self-fix-loop hardening)
    const rq = mockPrisma.userFeatureRequest.findMany.mock.calls[1][0];
    expect(rq.where.type).toBe('bug_report');
    expect(rq.where.source).toBe('agent');
    // 'done' plus every legacy closed spelling (ticket-status.ts, audit T8)
    expect(rq.where.status).toEqual({ in: ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'] });
    expect(rq.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
  });

  it('a USER-filed open ticket with the same title is NOT bumped — a new agent ticket is filed', async () => {
    // The candidate scan is source-scoped, so the user row never comes back
    // from the DB; the agent filing must create its own ticket rather than
    // write agent occurrences/sightings onto the user-visible one.
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.source).toBe('agent');
  });

  it('the sightings trail keeps only the last 5 entries', async () => {
    const prior = Array.from({ length: 5 }, (_, i) => ({ sessionId: `old-${i}`, filedAt: `2026-07-0${i + 1}T00:00:00.000Z` }));
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't8', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
      priority: 0, source: 'agent', description: 'd',
      context: { occurrences: 6, sightings: prior },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't8' });
    await fileFeedbackTicket({
      ...VALID,
      context: { sessionId: 'sess-new', role: 'reviewer', filedAt: '2026-07-29T12:00:00.000Z' },
    });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.context.occurrences).toBe(7);
    expect(upd.data.context.sightings).toHaveLength(5);
    expect(upd.data.context.sightings[0]).toEqual(prior[1]); // oldest dropped
    expect(upd.data.context.sightings[4]).toEqual({
      sessionId: 'sess-new', role: 'reviewer', filedAt: '2026-07-29T12:00:00.000Z',
    });
  });

  it('at the 8000-char cap, evicts OLDEST evidence and always lands the NEWEST sighting (ticket 300802aa)', async () => {
    const big = 'x'.repeat(7950);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't9', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
      priority: 2, source: 'agent', description: big,
      context: { sessionId: 'sess-0', occurrences: 1 },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't9' });
    const r = await fileFeedbackTicket({ ...VALID, description: 'y'.repeat(200) });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    // PRE-FIX this was `toBe(big)` — the old text, with the newest sighting
    // silently discarded (the 300802aa defect: occurrences kept counting while
    // the evidence a lane must adjudicate never arrived).
    const desc = upd.data.description as string;
    expect(desc).not.toBe(big);
    expect(desc).toContain('--- sighting 2 ---');
    expect(desc).toContain('y'.repeat(200)); // the NEW sighting's body landed
    expect(desc.length).toBeLessThanOrEqual(8000);
    // AND the original report survives essentially intact (review 2026-11-02
    // defect 1: the first cut of this fix halved the head by rule and destroyed
    // ~3950 chars of the ticket's own report for a 171-char overflow).
    expect(desc.startsWith('x'.repeat(7700))).toBe(true);
    expect(8000 - desc.length).toBeLessThan(300); // budget used, not squandered
    expect(upd.data.context.occurrences).toBe(2);
    expect(upd.data.context.sightings).toHaveLength(1);
  });

  it('recurrence escalation (2026-08-31): a sighting on an IN_PROGRESS ticket climbs priority +1 (the fix did not hold), capped at PRIORITY_MAX', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't-ip', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'in_progress',
      priority: 3, source: 'agent', description: 'd', context: { occurrences: 2 },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-ip' });
    const r = await fileFeedbackTicket({ ...VALID, priority: 3 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.priority).toBe(4); // max(3,3)+1 — recurrence escalates
  });

  it('recurrence escalation is CAPPED: an in_progress ticket already at priority 5 stays at 5 (never out of range)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't-cap', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'in_progress',
      priority: 5, source: 'agent', description: 'd', context: { occurrences: 9 },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-cap' });
    await fileFeedbackTicket({ ...VALID, priority: 3 });
    expect(mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.priority).toBe(5);
  });

  it('an OPEN-ticket sighting keeps the flat max() priority (no escalation until a dispatch exists)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{
      id: 't-op', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
      priority: 4, source: 'agent', description: 'd', context: { occurrences: 1 },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-op' });
    await fileFeedbackTicket({ ...VALID, priority: 1 });
    expect(mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.priority).toBe(4); // max(4,1) — unchanged
  });
});

describe('fileFeedbackTicket — reopen-on-recurrence (2026-08-31 self-fix-loop hardening)', () => {
  it('an exact-title match against a CLOSED agent ticket REOPENS it: occurrence trail survives, priority +1, claim released, drain fired', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass — nothing open
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 3, source: 'agent', description: 'Original report.\n\nFixed in PR #430.',
        context: { sessionId: 'sess-0', occurrences: 4, sightings: [{ sessionId: 'sess-0' }] },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'open' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 3 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-done' });
    expect(upd.data.status).toBe('open');
    expect(upd.data.priority).toBe(4); // max(3,3)+1 — recurrence after closure escalates too
    expect(upd.data.context.occurrences).toBe(5); // the trail survives closure
    expect(upd.data.context.reopenCount).toBe(1);
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    expect(upd.data.description).toContain('recurrence AFTER closure');
    expect(upd.data.description).toContain('Fixed in PR #430'); // history kept
    // the 30d dispatch claim is released so the drain re-routes it, and the
    // drain fires (both via the dynamic-import boundary — fire-and-forget, so
    // flush the microtask queue before asserting)
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith('t-done');
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('a delivered-redacted (strip+mark) sighting on a CLOSED ticket counter-bumps WITHOUT reopening — no status flip, no priority escalation, no dispatch release (5e1ca207 churn fix)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass — nothing open
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 4, source: 'agent', description: 'Original report.\n\nFixed in PR #430.',
        context: { sessionId: 'sess-0', occurrences: 4, sightings: [{ sessionId: 'sess-0' }], reopenCount: 2 },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'done' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', deliveredRedacted: true, filedAt: '2026-09-01T10:00:00Z' } });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-done' });
    expect(upd.data.status).toBeUndefined();           // NO status flip — the ticket stays done
    expect(upd.data.priority).toBeUndefined();         // NO priority escalation
    expect(upd.data.adminNote).toBeUndefined();        // NO "fix did not hold" note
    expect(upd.data.context.occurrences).toBe(5);      // the trail still grows
    expect(upd.data.context.reopenCount).toBe(2);      // NOT incremented — this was not a reopen
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', deliveredRedacted: true, filedAt: '2026-09-01T10:00:00Z' });
    expect(upd.data.context.lastSeen).toBeDefined();
    expect(upd.data.description).toContain('delivered redacted — handled by strip+mark; NOT a reopen');
    expect(upd.data.description).toContain('Fixed in PR #430'); // history kept
    expect(upd.data.description).not.toContain('the fix did not hold');
    // the dispatch claim is NOT released and the drain does NOT fire — nothing
    // re-enters the drain queue for a handled event
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('an UNMARKED (full-withhold) sighting on a CLOSED ticket still reopens — the marker is opt-in, legacy behavior is the default', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 3, source: 'agent', description: 'd',
        context: { sessionId: 'sess-0', occurrences: 1, sightings: [] },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'open' });

    // context carries NO deliveredRedacted marker — the withhold-writer shape
    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', filedAt: '2026-09-01T10:00:00Z' } });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.priority).toBe(4);
    expect(upd.data.context.reopenCount).toBe(1);
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    expect(upd.data.context.sightings[0].deliveredRedacted).toBeUndefined();
  });

  it('a containedPreDelivery (pre-delivery replacement) sighting on a CLOSED ticket counter-bumps WITHOUT reopening — ticket aac649ba churn fix: a guardMachineWakeFinalAnswer strike means the struck content never reached the thread, so it is NOT a "fix did not hold" recurrence', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass — nothing open
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 5, source: 'agent', description: 'Original report.\n\nFixed in PR #592.',
        context: { sessionId: 'sess-0', occurrences: 9, sightings: [{ sessionId: 'sess-0' }], reopenCount: 3 },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'done' });

    // The aac649ba shape: 9 occurrences / 3 reopens on chat aa78e314, every one
    // a pre-delivery REPLACED strike (contained — the phantom never delivered),
    // each reopening the closed ticket and re-dispatching the engineering lane.
    const r = await fileFeedbackTicket({ ...VALID, priority: 5, context: { sessionId: 'sess-1', containedPreDelivery: true, filedAt: '2026-09-03T14:36:35Z' } });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-done' });
    expect(upd.data.status).toBeUndefined();           // NO status flip — the ticket stays done
    expect(upd.data.priority).toBeUndefined();         // NO priority escalation
    expect(upd.data.adminNote).toBeUndefined();        // NO "fix did not hold" note — the redispatcher never overwrites the adjudication
    expect(upd.data.context.occurrences).toBe(10);     // the trail still grows
    expect(upd.data.context.reopenCount).toBe(3);      // NOT incremented — contained, not a reopen
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', containedPreDelivery: true, filedAt: '2026-09-03T14:36:35Z' });
    expect(upd.data.context.lastSeen).toBeDefined();
    expect(upd.data.description).toContain('pre-delivery strike — the note was replaced before delivery, the struck content never reached the thread; NOT a reopen');
    expect(upd.data.description).not.toContain('the fix did not hold');
    // nothing re-enters the drain queue for a contained event — no redispatch
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('a CLOSED ticket with a DIFFERENT title does not reopen — a new row is filed', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass
      .mockResolvedValueOnce([{  // reopen scan — a closed ticket for an UNRELATED defect
        id: 't-unrelated', type: 'bug_report', title: 'Sidebar misroutes clicks', status: 'done',
        priority: 3, source: 'agent', description: 'd', context: null,
      }])
      .mockResolvedValue([]); // fuzzy pass + queued-promotion scan + anything later — pinned (no base-implementation leakage from earlier tests)
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));

    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(1);
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
  });

  it('a same-title closed USER-filed ticket is never reopened (agent immutability rule)', async () => {
    // The reopen scan is source-scoped to agent rows, so a user row never comes
    // back from the DB — the mock returns [] for both scans, exactly like prod.
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: false });
    const rq = mockPrisma.userFeatureRequest.findMany.mock.calls[1][0];
    expect(rq.where.source).toBe('agent'); // user rows can never be reopen candidates
  });

  it('a withhold sighting on a CLOSED ticket already at the reopen-saturation cap counter-bumps WITHOUT reopening (ba65163d churn pathology)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass — nothing open
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket, class already reopened 3×
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 5, source: 'agent', description: 'Original report.\n\nFixed in PR #430.',
        context: { sessionId: 'sess-0', occurrences: 41, sightings: [{ sessionId: 'sess-0' }], reopenCount: 3 },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'done' });

    // context carries NO deliveredRedacted marker — the withhold-writer shape
    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', filedAt: '2026-09-02T10:00:00Z' } });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-done' });
    expect(upd.data.status).toBeUndefined();                 // NO status flip — saturated, stays done
    expect(upd.data.priority).toBeUndefined();               // NO priority escalation
    expect(upd.data.adminNote).toBeUndefined();              // NO "fix did not hold" note
    expect(upd.data.context.occurrences).toBe(42);           // the trail still grows
    expect(upd.data.context.reopenCount).toBe(3);            // NOT incremented
    expect(upd.data.context.reopenSuppressedCount).toBe(1);  // the suppression is recorded
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', reopenSuppressed: true, filedAt: '2026-09-02T10:00:00Z' });
    expect(upd.data.description).toContain('reopen SUPPRESSED — class saturated at 3 reopens');
    expect(upd.data.description).not.toContain('the fix did not hold');
    // the dispatch claim is NOT released and the drain does NOT fire — the
    // saturated class stops re-entering the drain queue
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('a withhold sighting on a CLOSED ticket ONE below the saturation cap still reopens (boundary — cap is ≥, not >)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass
      .mockResolvedValueOnce([{  // reopen scan — closed same-title ticket, reopenCount 2 (< 3)
        id: 't-done', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 3, source: 'agent', description: 'd',
        context: { sessionId: 'sess-0', occurrences: 4, sightings: [{ sessionId: 'sess-0' }], reopenCount: 2 },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-done', status: 'open' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', filedAt: '2026-09-02T10:00:00Z' } });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');                    // still reopens below the cap
    expect(upd.data.context.reopenCount).toBe(3);            // this reopen REACHES the cap — the NEXT withhold is suppressed
    expect(upd.data.context.reopenSuppressedCount).toBeUndefined();
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith('t-done');
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('a live-ticket dedup bump copies deliveredRedacted into the sighting trail (handled/unhandled provenance fix)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([{  // live exact pass — the OPEN same-title ticket
        id: 't-open', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
        priority: 3, source: 'agent', description: 'd',
        context: { sessionId: 'sess-0', occurrences: 2, sightings: [{ sessionId: 'sess-0' }] },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-open', status: 'open' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', deliveredRedacted: true, filedAt: '2026-09-02T10:00:00Z' } });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-open' });
    expect(upd.data.context.occurrences).toBe(3);
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', deliveredRedacted: true, filedAt: '2026-09-02T10:00:00Z' });
  });

  it('a live-ticket dedup bump copies containedPreDelivery into the sighting trail (aac649ba provenance parity with deliveredRedacted)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([{  // live exact pass — the OPEN same-title ticket
        id: 't-open', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'open',
        priority: 3, source: 'agent', description: 'd',
        context: { sessionId: 'sess-0', occurrences: 2, sightings: [{ sessionId: 'sess-0' }] },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-open', status: 'open' });

    const r = await fileFeedbackTicket({ ...VALID, priority: 3, context: { sessionId: 'sess-1', containedPreDelivery: true, filedAt: '2026-09-03T14:36:35Z' } });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-open' });
    expect(upd.data.context.occurrences).toBe(3);
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', containedPreDelivery: true, filedAt: '2026-09-03T14:36:35Z' });
  });
});

describe('titleTokenJaccard', () => {
  it('1 for identical word sets, 0 for disjoint/empty', () => {
    expect(titleTokenJaccard('digby has no response toast', 'digby has no response toast')).toBe(1);
    expect(titleTokenJaccard('send button broken', 'sidebar misroutes clicks')).toBe(0);
    expect(titleTokenJaccard('', 'anything')).toBe(0);
  });

  it('scores paraphrases by word-set overlap', () => {
    const a = normalizeFeedbackTitle('Digby has no response toast shown despite response delivered');
    const b = normalizeFeedbackTitle("'Digby has no response' toast shown despite reply delivered");
    expect(titleTokenJaccard(a, b)).toBeGreaterThanOrEqual(0.6);
    // Heavier paraphrases score lower — the 0.6 threshold is deliberately strict.
    const c = normalizeFeedbackTitle('User saw Digby has no response toast — run ended with no visible assistant message');
    expect(titleTokenJaccard(a, c)).toBeLessThan(0.6);
  });
});

describe('fileFeedbackTicket — FUZZY dedup (tickets 167822fb/9982d063)', () => {
  const FUZZY = {
    ...VALID,
    type: 'bug_report',
    title: 'Digby has no response toast shown despite response delivered',
    context: { sessionId: 'chat-4c5fc144', surface: 'chat', filedAt: '2026-08-13T16:00:00.000Z' },
  };

  it('a paraphrased same-session title bumps the existing ticket — even ACROSS types', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact pass (type-scoped) — no literal match
      .mockResolvedValueOnce([]) // reopen pass (closed same-type) — nothing closed to reopen
      .mockResolvedValueOnce([{  // fuzzy pass (same session, 24h, any type)
        id: 't-fz', type: 'mishap', title: "'Digby has no response' toast shown despite reply delivered",
        status: 'open', priority: 2, source: 'agent', description: 'First report.',
        context: { sessionId: 'chat-4c5fc144', occurrences: 1 },
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-fz' });

    const r = await fileFeedbackTicket({ ...FUZZY, priority: 3 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-fz' });
    expect(upd.data.priority).toBe(3); // max(2, 3)
    expect(upd.data.context.occurrences).toBe(2);
    expect(upd.data.description).toContain('--- sighting 2 ---');

    // The fuzzy query: agent-only, open-ish, 24h window, keyed on the
    // session/chat id via context JSON paths — user rows can never come back.
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[2][0];
    expect(q.where.source).toBe('agent');
    expect(q.where.status).toEqual({ in: ['open', 'in_progress', 'queued', 'reopened'] });
    expect(q.where.type).toBeUndefined(); // cross-type by design
    expect(q.where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(Date.now() - 25 * 3600_000);
    expect(q.where.OR).toEqual([
      { context: { path: ['sessionId'], equals: 'chat-4c5fc144' } },
      { context: { path: ['chatId'], equals: 'chat-4c5fc144' } },
    ]);
    expect(q.take).toBe(50);
  });

  it('a DISSIMILAR same-session title stays a separate ticket (threshold guard)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact pass
      .mockResolvedValueOnce([]) // reopen pass (closed same-type)
      .mockResolvedValueOnce([{  // same session, unrelated issue
        id: 't-other', type: 'bug_report', title: 'Sidebar link routed to the wrong chat',
        status: 'open', priority: 2, source: 'agent', description: 'd', context: { sessionId: 'chat-4c5fc144' },
      }]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));

    const r = await fileFeedbackTicket(FUZZY);
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(1);
  });

  it('no sessionId/chatId in context → the fuzzy pass is skipped entirely', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-nc', ...data }));

    const r = await fileFeedbackTicket({ ...FUZZY, context: { surface: 'chat' } });
    expect(r).toMatchObject({ deduped: false });
    // exact + reopen + cross-source (T2) + under-cap queued-promotion scan — fuzzy skipped
    // (+1 from the adjudicated-class dedupe pass, audit 2026-10-16 6df5fc61, which
    // runs last-chance before the fresh create)
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledTimes(5);
  });

  it('the EXACT pass still wins first — no fuzzy query when the literal title matches', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([{
      id: 't-exact', type: 'bug_report', title: FUZZY.title, status: 'open',
      priority: 1, source: 'agent', description: 'd', context: null,
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-exact' });

    const r = await fileFeedbackTicket(FUZZY);
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('fileFeedbackTicket — class-keyed MISHAP dedup (audit #9c)', () => {
  // Normalized length > 60 with a varying tail — the exact pass misses these,
  // the class pass (first 60 normalized chars) must merge them.
  const CLASS_HEAD = 'evidence guard withheld the final answer for coding session number';
  const MISHAP = {
    userId: 'u1',
    type: 'mishap',
    title: `${CLASS_HEAD} 99999`,
    description: 'The guard withheld again for a different session.',
    context: { sessionId: 'sess-new', surface: 'coding', filedAt: '2026-09-02T00:00:00.000Z' },
  };

  it('a same-class mishap (shared 60-char normalized prefix, differing tail) BUMPS the open ticket instead of duplicating', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact pass — the tails differ, no exact row
      .mockResolvedValueOnce([{ // class-keyed pass — the same failure class
        id: 't-class', type: 'mishap', title: `${CLASS_HEAD} 12345`, status: 'open',
        priority: 2, source: 'agent', description: 'First sighting.',
        context: { sessionId: 'sess-old', occurrences: 1 },
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-class' });

    const r = await fileFeedbackTicket({ ...MISHAP, priority: 3 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    // TWO scans (586ebe71): the exact pass first, then the class-keyed pass's
    // own unbounded scan (its prefilter token derives from the CLASS KEY).
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledTimes(2);
    const classQuery = mockPrisma.userFeatureRequest.findMany.mock.calls[1][0];
    expect(classQuery.where.AND).toEqual([{ title: { contains: 'evidence', mode: 'insensitive' } }]); // longest CLASS-KEY token (8 chars, first of the tie)
    expect(classQuery.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-class' });
    expect(upd.data.priority).toBe(3);
    expect(upd.data.context.occurrences).toBe(2);
    expect(upd.data.description).toContain('--- sighting 2 ---');
  });

  it('an in_progress same-class mishap sighting escalates priority +1 (the dispatched fix did not hold)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact pass
      .mockResolvedValueOnce([{ // class-keyed pass
        id: 't-class-ip', type: 'mishap', title: `${CLASS_HEAD} 12345`, status: 'in_progress',
        priority: 3, source: 'agent', description: 'First sighting.',
        context: { occurrences: 4 },
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-class-ip' });
    const r = await fileFeedbackTicket({ ...MISHAP, priority: 3 });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.priority).toBe(4);
  });

  it('a DIFFERENT mishap class (divergence inside the first 60 normalized chars) stays a separate ticket', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([{ // open candidates — different class head
        id: 't-otherclass', type: 'mishap', title: 'dispatch brief exceeded the schedule cap for coding session number 12345',
        status: 'open', priority: 2, source: 'agent', description: 'd', context: {},
      }])
      .mockResolvedValue([]); // reopen + fuzzy + promote scans
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new-class', ...data }));

    const r = await fileFeedbackTicket(MISHAP);
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('NON-mishap types never class-dedup — a shared 60-char prefix on bug_reports still files a new row', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([{ // same class head, but the filing is a bug_report
        id: 't-bug', type: 'bug_report', title: `${CLASS_HEAD} 12345`, status: 'open',
        priority: 2, source: 'agent', description: 'd', context: {},
      }])
      .mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new-bug', ...data }));

    const r = await fileFeedbackTicket({ ...MISHAP, type: 'bug_report' });
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });
});

describe('getFeedbackTicketById (audit #9d — full-row single read)', () => {
  const ROW = {
    id: 'abcd1234-5678-4abc-9def-000011112222', type: 'bug_report', title: 'T',
    description: 'Full description, never truncated.', status: 'open', priority: 2,
    source: 'agent', adminNote: 'note', context: { occurrences: 3 }, userId: 'u1',
    createdAt: new Date(), updatedAt: new Date(),
  };

  it('returns the full row on an exact id', async () => {
    mockPrisma.userFeatureRequest.findUnique = jest.fn(async () => ROW);
    const r = await getFeedbackTicketById(ROW.id);
    expect(r).toEqual({ ok: true, ticket: ROW });
  });

  it('resolves a UNIQUE ≥8-char prefix; an ambiguous prefix returns the candidates', async () => {
    mockPrisma.userFeatureRequest.findUnique = jest.fn(async () => null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([ROW]);
    expect(await getFeedbackTicketById('abcd1234')).toEqual({ ok: true, ticket: ROW });
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { startsWith: 'abcd1234' } }, take: 3 }),
    );

    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([ROW, { ...ROW, id: 'abcd1234-9999-4abc-9def-000011112222' }]);
    const amb = await getFeedbackTicketById('abcd1234');
    expect(amb).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect((amb as any).candidates).toHaveLength(2);
  });

  it('audit 2026-10-08 W3-3: a ≥8-char SUFFIX / prefix+suffix splice resolves through the shared heal tier', async () => {
    mockPrisma.userFeatureRequest.findUnique = jest.fn(async ({ where }: any) => (where.id === ROW.id ? ROW : null));
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async ({ where }: any) => {
      const rows = [ROW, { ...ROW, id: 'ffff0000-5678-4abc-9def-000099998888' }];
      return rows.filter((r) => (where.id?.startsWith === undefined || r.id.startsWith(where.id.startsWith)) && (where.id?.endsWith === undefined || r.id.endsWith(where.id.endsWith)));
    });
    expect(await getFeedbackTicketById('…11112222')).toEqual({ ok: true, ticket: ROW });
    expect(await getFeedbackTicketById('abcd1234-11112222')).toEqual({ ok: true, ticket: ROW });
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    try {
      expect(await getFeedbackTicketById('abcd1234-11112222')).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      delete process.env.ID_RESOLVER_HEAL_DISABLED;
      mockPrisma.userFeatureRequest.findMany.mockReset();
    }
  });

  it('a SHORT prefix (<8 chars) never scans — not_found without a findMany', async () => {
    mockPrisma.userFeatureRequest.findUnique = jest.fn(async () => null);
    expect(await getFeedbackTicketById('abcd12')).toEqual({ ok: false, reason: 'not_found' });
    expect(await getFeedbackTicketById('  ')).toEqual({ ok: false, reason: 'not_found' });
    expect(mockPrisma.userFeatureRequest.findMany).not.toHaveBeenCalled();
  });

  it('an unknown id is not_found', async () => {
    mockPrisma.userFeatureRequest.findUnique = jest.fn(async () => null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([]);
    expect(await getFeedbackTicketById('ffffffff-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('fileFeedbackTicket — rate caps store-and-queue (2026-08-31)', () => {
  it('a session-cap hit QUEUES the ticket (status queued, stored not dropped)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count
      .mockResolvedValueOnce(21)  // session count > 20
      .mockResolvedValueOnce(0)   // queued backlog for this session
      .mockResolvedValueOnce(0);  // queued backlog global
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-q', ...data }));
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ queued: true });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.status).toBe('queued');
    expect(data.source).toBe('agent');
    expect(data.context.queuedReason).toMatch(/session cap: 21 tickets/);
    // the session cap counts source='agent' rows keyed on context->>sessionId
    const q = mockPrisma.userFeatureRequest.count.mock.calls[0][0];
    expect(q.where.source).toBe('agent');
    expect(q.where.context).toEqual({ path: ['sessionId'], equals: 'sess-1' });
  });

  it('the global backstop (300/24h) QUEUES instead of dropping', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count
      .mockResolvedValueOnce(0)    // session ok
      .mockResolvedValueOnce(300)  // global hit
      .mockResolvedValueOnce(0)    // queued backlog for this session
      .mockResolvedValueOnce(0);   // queued backlog global
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-qg', ...data }));
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ queued: true });
    expect(mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.context.queuedReason).toMatch(/global backstop/);
  });

  it('the queued-backlog backstop is the only real DROP (per-session depth)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count
      .mockResolvedValueOnce(21)  // session cap hit
      .mockResolvedValueOnce(10)  // queued backlog for this session at cap
      .mockResolvedValueOnce(0);
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ error: 'rate_limited' });
    expect((r as any).message).toMatch(/queue is full/);
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('the global queued backstop drops too', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count
      .mockResolvedValueOnce(21)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(500); // global queued backlog at cap
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ error: 'rate_limited' });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('an under-cap filing auto-promotes the oldest queued rows (self-draining, no sweeper)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([])  // exact dedup pass
      .mockResolvedValueOnce([])  // reopen pass
      .mockResolvedValueOnce([])  // fuzzy pass
      .mockResolvedValueOnce([])  // cross-source user-row pass (audit T2)
      .mockResolvedValueOnce([{ id: 't-old1' }, { id: 't-old2' }]); // oldest queued scan (promotion)
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));

    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: false });
    const promoQuery = mockPrisma.userFeatureRequest.findMany.mock.calls[4][0];
    // TICKET-FAMILY-ROUTING review (2026-10-20): family-queued rows are excluded in the query (null-safe column filter).
    expect(promoQuery.where).toEqual({ source: 'agent', status: 'queued', OR: [{ adminNote: null }, { NOT: { adminNote: { startsWith: 'Queued for the next' } } }] });
    expect(promoQuery.orderBy).toEqual({ createdAt: 'asc' });
    expect(mockPrisma.userFeatureRequest.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t-old1', 't-old2'] }, status: 'queued' },
      data: { status: 'open' },
    });
  });

  it('dedup matches a QUEUED ticket too (a repeat sighting bumps, never duplicates)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([{
      id: 't-queued', type: VALID.type, title: VALID.title, status: 'queued',
      priority: 1, source: 'agent', description: 'd', context: { sessionId: 'sess-1' },
    }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-queued', title: VALID.title, priority: 1, context: {} });
    const r = await fileFeedbackTicket(VALID);
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.count).not.toHaveBeenCalled();
  });
});

describe('promoteQueuedFeedbackTickets', () => {
  it('promotes the oldest N queued rows with a status re-guard', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 3 });
    const n = await promoteQueuedFeedbackTickets(3);
    expect(n).toBe(3);
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith({
      where: { source: 'agent', status: 'queued', OR: [{ adminNote: null }, { NOT: { adminNote: { startsWith: 'Queued for the next' } } }] },
      orderBy: { createdAt: 'asc' },
      take: 3,
      select: { id: true, context: true },
    });
    expect(mockPrisma.userFeatureRequest.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] }, status: 'queued' },
      data: { status: 'open' },
    });
  });

  it('empty queue is a no-op (no updateMany)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    expect(await promoteQueuedFeedbackTickets(3)).toBe(0);
    expect(mockPrisma.userFeatureRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe('fileFeedbackTicket — create path', () => {
  it('creates with source=agent, nullable userId, and area merged into context', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't4', ...data }));

    const r = await fileFeedbackTicket({
      userId: null, type: 'mishap', title: 'Duplicate toasts on send', description: 'Two toasts stack.',
      priority: 1, area: 'ui', context: { sessionId: 'anon-9', surface: 'chat', filedAt: '2026-07-29T00:00:00.000Z' },
    });
    expect(r).toMatchObject({ deduped: false });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.source).toBe('agent');
    expect(data.userId).toBeNull();
    expect(data.type).toBe('mishap');
    expect(data.priority).toBe(1);
    expect(data.context).toMatchObject({ sessionId: 'anon-9', surface: 'chat', area: 'ui' });
    expect((r as any).ticket.id).toBe('t4');
  });

  it('defaults priority to 0 and trims title/description', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't5', ...data }));
    await fileFeedbackTicket({ ...VALID, title: '  Padded title  ', description: '  padded desc  ' });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.priority).toBe(0);
    expect(data.title).toBe('Padded title');
    expect(data.description).toBe('padded desc');
  });
});

describe('listFeedbackTickets (admin)', () => {
  const row = {
    id: 't6', type: 'enhancement', title: 'T', description: 'D', status: 'open', priority: 2,
    source: 'agent', userId: null, createdAt: new Date('2026-07-29'),
    context: { area: 'coding', occurrences: 3, sessionId: 's' },
    user: null,
  };

  it('rejects invalid filters with a 400 AppError', async () => {
    await expect(listFeedbackTickets({ status: 'closed' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(listFeedbackTickets({ type: 'epiphany' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(listFeedbackTickets({ source: 'robot' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('maps rows to the trimmed shape (area + occurrences lifted from context) and clamps the limit', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([row]);
    const rows = await listFeedbackTickets({ status: 'open', type: 'enhancement', source: 'agent', limit: 500 });
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ status: 'open', type: 'enhancement', source: 'agent' });
    expect(q.take).toBe(200); // clamped
    // status is NOT in the DB orderBy — an alphabetical status sort is the bug
    // (a1ca6bfc); the DB orders by priority/recency, the explicit STATUS_RANK
    // sort (asserted separately below) applies the open-first grouping.
    expect(q.orderBy).toEqual([{ priority: 'desc' }, { createdAt: 'desc' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 't6', type: 'enhancement', status: 'open', priority: 2, source: 'agent',
      area: 'coding', occurrences: 3, userId: null, user: null,
    });
  });

  it('defaults limit to 50 and occurrences to 1 when context has none', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{ ...row, context: null, user: { email: 'a@b.c', name: 'A' }, userId: 'u1' }]);
    const rows = await listFeedbackTickets({});
    expect(mockPrisma.userFeatureRequest.findMany.mock.calls[0][0].take).toBe(50);
    expect(rows[0].occurrences).toBe(1);
    expect(rows[0].area).toBeNull();
    expect(rows[0].user).toEqual({ email: 'a@b.c', name: 'A' });
  });

  it('ranks status open → in_progress → done regardless of DB row order (ticket a1ca6bfc)', async () => {
    // The DB returns rows ordered by priority/recency only — status could come
    // back in ANY order (here deliberately done-first, mimicking the old
    // alphabetical bug). listFeedbackTickets must re-rank so open/in_progress
    // land before done, and keep the priority/newest order WITHIN each status.
    const mk = (id: string, status: string, priority: number, createdAt: string) =>
      ({ ...row, id, status, priority, createdAt: new Date(createdAt), context: null, user: null, userId: null });
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      mk('done-hi', 'done', 5, '2026-07-29'),
      mk('done-lo', 'done', 0, '2026-07-28'),
      mk('open-hi', 'open', 4, '2026-07-27'),
      mk('open-lo', 'open', 1, '2026-07-26'),
      mk('prog', 'in_progress', 3, '2026-07-25'),
    ]);
    const rows = await listFeedbackTickets({});
    expect(rows.map((r) => r.id)).toEqual(['open-hi', 'open-lo', 'prog', 'done-hi', 'done-lo']);
    // status is never handed to the DB orderBy (that alphabetical sort is the bug)
    expect(mockPrisma.userFeatureRequest.findMany.mock.calls[0][0].orderBy)
      .toEqual([{ priority: 'desc' }, { createdAt: 'desc' }]);
  });

  it('caps description at 500 chars with an ellipsis so a list result stays context-sized', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{ ...row, id: 't-long', description: 'd'.repeat(600) }]);
    const rows = await listFeedbackTickets({});
    expect(rows[0].description).toBe(`${'d'.repeat(500)}…`);
    expect(rows[0].id).toBe('t-long'); // the id remains for a follow-up read of the full row
  });
});

describe('updateFeedbackTicket (admin)', () => {
  it('rejects an invalid status / priority with a 400 AppError', async () => {
    // 'closed' / 'resolved' are LEGACY closed spellings that normalise to 'done'
    // (audit T8) — a genuinely unknown value is what 400s.
    await expect(updateFeedbackTicket({ id: 't7', status: 'bogus' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateFeedbackTicket({ id: 't7', priority: 9 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateFeedbackTicket({ id: '' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('updates only the provided fields', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 't7' });
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't7', status: 'done', priority: 0, adminNote: 'shipped' });
    const r = await updateFeedbackTicket({ id: 't7', status: 'done', adminNote: 'shipped' });
    expect(mockPrisma.userFeatureRequest.update).toHaveBeenCalledWith({
      where: { id: 't7' },
      data: { status: 'done', adminNote: 'shipped' },
    });
    expect(r).toMatchObject({ id: 't7', status: 'done' });
  });

  it('a not-found id 404s at the pre-check — the throwing update never runs (prisma:error log-spray fix 2026-09-08)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]); // no same-prefix candidate either (e829e28c prefix path)
    await expect(updateFeedbackTicket({ id: 'placeholder-do-not-call', status: 'done' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('maps Prisma P2025 to a 404 AppError (delete-race belt behind the pre-check)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 'gone' });
    mockPrisma.userFeatureRequest.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(updateFeedbackTicket({ id: 'gone', status: 'done' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── REGRESSION (ticket 696d4346): the guarded empty-expected write vs SQL NULL ──

describe('updateFeedbackTicket — guarded empty-expected context write (696d4346)', () => {
  it('an expectContext:{} write on a SQL-NULL-context row targets the row with the AnyNull OR (never equals: null, which misses NULL on this stack)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 't-null-ctx' });
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 1 });
    await updateFeedbackTicket({ id: 't-null-ctx', context: { heldEscalation: { questionId: 'q1', at: 'x' } }, expectContext: {} });
    const where = mockPrisma.userFeatureRequest.updateMany.mock.calls[0][0].where;
    // THE fix: the null arm must be Prisma.AnyNull — the old `equals: null`
    // compiles to ("context" = 'null'::jsonb OR "context" IS NULL) inside one
    // filter object, which the PrismaPg adapter driver folds into a
    // non-matching filter, so a SQL-NULL row was NEVER updated (every
    // held-ticket escalation stamp failed as context_conflict → the owner was
    // re-asked every ~30 min despite answering Dismiss six times).
    expect(where).toEqual({
      id: 't-null-ctx',
      OR: [{ context: { equals: {} } }, { context: { equals: Prisma.AnyNull } }],
    });
    // Non-empty expected contexts keep the plain exact-match shape.
    mockPrisma.userFeatureRequest.updateMany.mockClear();
    await updateFeedbackTicket({ id: 't-null-ctx', context: { heldEscalation: { decision: 'dismiss' } }, expectContext: { heldEscalation: { questionId: 'q1', at: 'x' } } });
    const where2 = mockPrisma.userFeatureRequest.updateMany.mock.calls[0][0].where;
    expect(where2).toEqual({ id: 't-null-ctx', context: { equals: { heldEscalation: { questionId: 'q1', at: 'x' } } } });
  });

  it('a 0-count guarded update reports context_conflict (the caller decides), and a successful one persists the merged context', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 't2' });
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
    const conflict = await updateFeedbackTicket({ id: 't2', context: { heldEscalation: { q: 1 } }, expectContext: {} });
    expect(conflict).toMatchObject({ ok: false, reason: 'context_conflict' });

    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 't2', context: { heldEscalation: { decision: 'dismiss', decidedAt: 'x' } } });
    const okRes = await updateFeedbackTicket({ id: 't2', status: 'done', adminNote: 'Dismissed by the owner from the held-ticket card — closed unworked (another account\'s ticket; no lane ran).', context: { heldEscalation: { decision: 'dismiss', decidedAt: 'x' } }, expectContext: {} });
    expect(okRes).toMatchObject({ id: 't2', context: { heldEscalation: { decision: 'dismiss', decidedAt: 'x' } } });
  });
});

describe('isAdminUser', () => {
  it('false for missing userId, USER role, or unknown user; true for ADMIN', async () => {
    expect(await isAdminUser(null)).toBe(false);
    expect(await isAdminUser(undefined)).toBe(false);

    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    expect(await isAdminUser('u-user')).toBe(false);

    mockPrisma.user.findUnique.mockResolvedValue(null);
    expect(await isAdminUser('u-ghost')).toBe(false);

    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    expect(await isAdminUser('u-admin')).toBe(true);
    expect(mockPrisma.user.findUnique).toHaveBeenLastCalledWith({ where: { id: 'u-admin' }, select: { role: true } });
  });
});

// ── Backlog audit T2 (2026-09-28): cross-source duplicate match ──────────────
// d6110694 (agent, "Owner report … shared workspaces dont work and throw
// errors", filed from a supervisor chat) duplicated the owner's OWN user ticket
// 7acaa7ba filed 38 min earlier; every agent pass is source='agent', so the
// twin was never consulted and a SECOND lane was dispatched. The fix: a
// READ-ONLY match on the user's open rows (24 h) → the agent row is filed as a
// LINKED DUPLICATE (done, duplicateOf, autoDispatch:false) and never dispatched.

describe('findCrossSourceDuplicate (pure matcher, audit T2)', () => {
  const user = { id: 'u-7acaa7ba', title: 'shared workspaces dont work and throw errors', description: 'Opening a shared workspace from the sidebar errors out.' };

  it('matches the d6110694 capture ("Owner report: <the owner sentence>") — the word-set overlap clears the Jaccard bar', () => {
    const m = findCrossSourceDuplicate([user], { title: 'Owner report: shared workspaces dont work and throw errors', description: 'Captured from the supervisor chat.' });
    expect(m).toMatchObject({ candidate: { id: 'u-7acaa7ba' }, matchedBy: 'fuzzy-title' }); // 7 shared / 9 union = 0.78
  });

  it('matches the owner sentence carried inside a LONGER agent-captured title (containment, ≥4 tokens, below the Jaccard bar)', () => {
    const m = findCrossSourceDuplicate([user], { title: 'Owner report from the supervisor chat this afternoon: shared workspaces dont work and throw errors', description: 'Captured verbatim.' });
    expect(m).toMatchObject({ candidate: { id: 'u-7acaa7ba' }, matchedBy: 'title-contained' }); // 7 / 14 = 0.5 < 0.6
  });

  it('matches an exact normalized title first, then a paraphrase at Jaccard ≥ 0.6', () => {
    expect(findCrossSourceDuplicate([user], { title: 'Shared Workspaces dont work — and throw errors!', description: 'x' })?.matchedBy).toBe('exact');
    expect(findCrossSourceDuplicate([user], { title: 'shared workspaces throw errors and dont work at all', description: 'x' })?.matchedBy).toBe('fuzzy-title');
  });

  it('matches when the AGENT title (≥4 tokens) is contained in the user filing text', () => {
    const m = findCrossSourceDuplicate(
      [{ id: 'u2', title: 'Sidebar bug', description: 'Since this morning the sidebar link routes to the wrong chat every time.' }],
      { title: 'sidebar link routes to the wrong chat', description: 'seen twice' },
    );
    expect(m?.matchedBy).toBe('title-contained');
  });

  it('never matches on a short generic title by containment, and never on a dissimilar one', () => {
    expect(findCrossSourceDuplicate([{ id: 'u3', title: 'Send button', description: 'd' }], { title: 'The send button is unresponsive on mobile after the keyboard closes', description: 'x' })).toBeNull();
    expect(findCrossSourceDuplicate([user], { title: 'Telegram digest arrives twice each morning', description: 'x' })).toBeNull();
    expect(findCrossSourceDuplicate([], { title: 'anything', description: 'x' })).toBeNull();
  });
});

describe('fileFeedbackTicket — cross-source duplicate link (audit T2, ticket d6110694 / 7acaa7ba)', () => {
  const OWNER_REMARK = {
    ...VALID,
    userId: 'owner-1',
    type: 'bug_report',
    title: 'Owner report: shared workspaces dont work and throw errors',
    description: 'The owner said in the supervisor chat: shared workspaces dont work and throw errors.',
    context: { sessionId: 'sup-9e6e1712', chatId: 'sup-9e6e1712', surface: 'chat', filedAt: '2026-09-28T18:06:00.000Z' },
  };
  const USER_ROW = { id: 'user-7acaa7ba', title: 'shared workspaces dont work and throw errors', description: 'Opening a shared workspace errors.' };

  const chain = (userRows: any[]) => mockPrisma.userFeatureRequest.findMany
    .mockResolvedValueOnce([])       // exact (agent) pass
    .mockResolvedValueOnce([])       // reopen (closed agent) pass
    .mockResolvedValueOnce([])       // fuzzy same-session pass
    .mockResolvedValueOnce(userRows); // cross-source USER rows (24 h, same user)

  it('links the agent capture as a DONE duplicate of the user ticket — user row untouched, nothing dispatched', async () => {
    chain([USER_ROW]);
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null); // no earlier linked row
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'agent-d6110694', ...data }));

    const r = await fileFeedbackTicket(OWNER_REMARK);
    expect(r).toMatchObject({ deduped: true, duplicateOf: 'user-7acaa7ba' });
    expect((r as any).ticket.id).toBe('agent-d6110694'); // the agent's OWN linked row, never the user row
    // The user-row query: same user, source user, open-ish, 24h window, bounded.
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[3][0];
    expect(q.where).toMatchObject({ source: 'user', userId: 'owner-1', status: { in: ['open', 'in_progress', 'queued', 'reopened'] } });
    expect(q.where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(Date.now() - 25 * 3600_000);
    expect(q.take).toBe(50);
    // The linked row: done, never dispatchable, pointing at the user ticket.
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ source: 'agent', status: 'done', userId: 'owner-1' });
    expect(created.context).toMatchObject({ duplicateOf: 'user-7acaa7ba', duplicateMatch: 'fuzzy-title', autoDispatch: false, sessionId: 'sup-9e6e1712' });
    expect(created.adminNote).toContain('Duplicate of user ticket user-7acaa7ba');
    expect(created.adminNote).toContain('NOT dispatched');
    // Read-only on the user row + no drain fired.
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('a repeat capture of the same remark bumps the EXISTING linked row instead of minting another', async () => {
    chain([USER_ROW]);
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue({
      id: 'agent-d6110694', priority: 1, description: 'first capture', status: 'done',
      context: { duplicateOf: 'user-7acaa7ba', autoDispatch: false, occurrences: 1 },
    });
    mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));

    const r = await fileFeedbackTicket({ ...OWNER_REMARK, priority: 3 });
    expect(r).toMatchObject({ deduped: true, duplicateOf: 'user-7acaa7ba' });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const fq = mockPrisma.userFeatureRequest.findFirst.mock.calls[0][0];
    expect(fq.where).toEqual({ source: 'agent', context: { path: ['duplicateOf'], equals: 'user-7acaa7ba' } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'agent-d6110694' }); // the LINKED row, never the user row
    expect(upd.data.status).toBeUndefined();              // stays done
    expect(upd.data.context).toMatchObject({ duplicateOf: 'user-7acaa7ba', occurrences: 2 });
  });

  it('no matching user row → the ordinary create path (open, dispatchable) — an unrelated user ticket never links', async () => {
    chain([{ id: 'user-other', title: 'Telegram digest arrives twice each morning', description: 'd' }]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));
    const r = await fileFeedbackTicket(OWNER_REMARK);
    expect(r).toMatchObject({ deduped: false });
    expect((r as any).duplicateOf).toBeUndefined();
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created.status).toBeUndefined(); // default 'open'
    expect(created.context.duplicateOf).toBeUndefined();
  });

  it('an anonymous filing (userId null) skips the pass — there is no "own" user row to match', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-anon', ...data }));
    await fileFeedbackTicket({ ...OWNER_REMARK, userId: null });
    const sources = mockPrisma.userFeatureRequest.findMany.mock.calls.map((c: any[]) => c[0]?.where?.source);
    expect(sources).not.toContain('user');
  });

  it('the closed-reopen scan never REOPENS a linked duplicate row (it is a record of a user ticket, not a closed fix)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact
      .mockResolvedValueOnce([{  // reopen scan returns the linked (done) row with the same title
        id: 'agent-d6110694', type: 'bug_report', title: OWNER_REMARK.title, status: 'done', priority: 1,
        source: 'agent', description: 'linked', userId: 'owner-1', adminNote: 'Duplicate of user ticket user-7acaa7ba',
        context: { duplicateOf: 'user-7acaa7ba', autoDispatch: false },
      }])
      .mockResolvedValueOnce([]) // fuzzy
      .mockResolvedValueOnce([]) // cross-source: the user ticket is closed by now
      .mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-fresh', ...data }));
    const r = await fileFeedbackTicket(OWNER_REMARK);
    expect(r).toMatchObject({ deduped: false });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled(); // no reopen
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
  });
});

// ── Backlog audit T8 (2026-09-28): the legacy 'resolved' status ──────────────

describe('legacy closed status reads as done (audit T8)', () => {
  it('FEEDBACK_STATUSES is the canonical write set — no legacy spelling', () => {
    // 6665fff6: the post-deploy done-bar states join the canonical set.
    expect([...FEEDBACK_STATUSES]).toEqual(['open', 'in_progress', 'queued', 'done', 'awaiting_verification', 'deployed_verified', 'reopened']);
  });

  it('listFeedbackTickets maps a "resolved" row to status done and ranks it after open rows', async () => {
    const base = { type: 'bug_report', title: 'T', description: 'D', priority: 0, source: 'user', userId: 'u', context: null, user: null, createdAt: new Date('2026-04-01') };
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { ...base, id: 'legacy', status: 'resolved' },
      { ...base, id: 'live', status: 'open' },
    ]);
    const rows = await listFeedbackTickets({});
    expect(rows.map((r) => r.id)).toEqual(['live', 'legacy']);
    expect(rows[1].status).toBe('done');
  });

  it('getFeedbackTicketById normalises a legacy status on the returned row (the row itself is not rewritten)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 'legacy-full-id', status: 'resolved', title: 'T' });
    const r = await getFeedbackTicketById('legacy-full-id');
    expect(r).toMatchObject({ ok: true, ticket: { id: 'legacy-full-id', status: 'done' } });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('updateFeedbackTicket writes the canonical "done" when asked for "resolved"', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: 't-upd', status: 'open' });
    mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
    const r = await updateFeedbackTicket({ id: 't-upd', status: 'resolved' });
    expect(r.status).toBe('done');
    expect(mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.status).toBe('done');
  });
});

// ── Ticket beb1788b (2026-10-18): system filings never park as linked dups ────
// The defect: the log-signal sweep files with the FIRST ADMIN's userId, which
// activates the cross-source pass against that admin's own 24h user-filed
// tickets; the sweep description embeds a 600-char raw log excerpt that
// enlarges the containment haystack. On a containment hit the pass files the
// fingerprint as a done + duplicateOf row — recorded as "handled", never
// dispatched, and later weeks re-file it (the row carries the sweep's OWN
// title, so the sweep-side title-agreement guard could never catch it). The
// same park class fired via the incident-twin link on shared boilerplate
// (live 2026-10-16: the run-journal P0 spec parked twice under the
// preempted-turns P0). Fix: a SYSTEM filing (server-stamped surface 'system'
// — the file_feedback tool layer stamps ctx.agentSurface ?? 'coding', and
// agentSurface is only ever 'chat' | 'coding', so no agent-carried context
// can forge it) skips BOTH link-creating passes; its stable title keeps the
// 90-day exact/reopen contract.

describe('isSystemTicketFiling (ticket beb1788b discriminator)', () => {
  it('recognizes the server-stamped system surface (case/whitespace tolerant)', () => {
    expect(isSystemTicketFiling({ surface: 'system' })).toBe(true);
    expect(isSystemTicketFiling({ surface: ' System ' })).toBe(true);
  });

  it('an agent filing (chat/coding surface, or no surface) is NOT a system filing', () => {
    expect(isSystemTicketFiling({ surface: 'chat' })).toBe(false);
    expect(isSystemTicketFiling({ surface: 'coding' })).toBe(false);
    expect(isSystemTicketFiling({ sessionId: 'sess-1' })).toBe(false);
    expect(isSystemTicketFiling(null)).toBe(false);
    expect(isSystemTicketFiling([])).toBe(false);
  });

  it('FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED=1 restores the link paths (fail-safe kill switch)', () => {
    const prev = process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED;
    try {
      process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED = '1';
      expect(isSystemTicketFiling({ surface: 'system' })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED;
      else process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED = prev;
    }
  });
});

describe('fileFeedbackTicket — system filings never park (ticket beb1788b)', () => {
  // The replay shape: a sweep filing whose description carries a raw log
  // excerpt that ≥4-token-CONTAINS the admin's own user ticket title — the
  // exact park the ticket describes. Pre-fix: done + duplicateOf row, never
  // dispatched. Post-fix: the ordinary open, dispatchable row.
  const SWEEP_FILING = {
    ...VALID,
    userId: 'admin-owner-1', // the FIRST ADMIN's userId — what the sweep files with
    type: 'bug_report',
    title: 'log-signal: session history sync project chat push refused permanently terminal auth quarantined for 6h one fresh attempt after 401 bad credentials',
    description: [
      'Fingerprint (normalized message): session history sync project X — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials',
      'RULE 1 — recurrence across 8 distinct hours (15 rows in 24 h).',
      'Example raw message (newest row, URL credentials scrubbed at write time, secret shapes redacted at sweep time — ticket 885614de):\n---\nsession history sync: project chat_a1 — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials\n---',
      'Auto-filed by the hourly log-signal-sweep cron (ticket 8a66441e).',
    ].join('\n\n'),
    context: { sessionId: 'log-signal-sweep:abc123def456', surface: 'system', origin: 'log-signal-sweep', about: 'digby_platform', fingerprintHash: 'abc123def456' },
  };
  // The admin's OWN user ticket from the same 24h whose title the sweep's
  // excerpt contains (≥4 tokens) — the cross-source matcher WOULD match.
  const ADMIN_USER_ROW = {
    id: 'user-90ab12cd',
    title: 'push refused permanently terminal auth quarantined for 6h',
    description: 'My coding session keeps failing to sync.',
  };

  it('a system filing (surface system) is NOT parked by the cross-source pass even when the containment matcher would match — it files open and dispatchable', async () => {
    // Sanity: the pure matcher DOES match this pair (the defect's premise).
    expect(findCrossSourceDuplicate([ADMIN_USER_ROW], { title: SWEEP_FILING.title, description: SWEEP_FILING.description })).toMatchObject({ candidate: { id: 'user-90ab12cd' } });

    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]); // no exact/mishap/reopen/fuzzy candidates
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);     // under the rate caps
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-sweep-open', ...data }));

    const r = await fileFeedbackTicket(SWEEP_FILING);
    // The ordinary create path: open, dispatchable, no duplicateOf.
    expect(r).toMatchObject({ deduped: false });
    expect((r as any).duplicateOf).toBeUndefined();
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created.status).toBeUndefined(); // default 'open'
    expect(created.context.duplicateOf).toBeUndefined();
    expect(created.context.autoDispatch).toBeUndefined();
    // The user rows were never even consulted for a system filing — the
    // where.source === 'user' query must not run.
    const sources = mockPrisma.userFeatureRequest.findMany.mock.calls.map((c: any[]) => c[0]?.where?.source);
    expect(sources).not.toContain('user');
  });

  it('an AGENT capture of an owner remark (surface chat) still links — the T2 contract is untouched', async () => {
    // The T2 shape from the suite above, restated against the same user row:
    // an agent-carried context (surface 'chat') keeps the cross-source link.
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([])       // exact (agent) pass
      .mockResolvedValueOnce([])       // reopen (closed agent) pass
      .mockResolvedValueOnce([])       // fuzzy same-session pass
      .mockResolvedValueOnce([ADMIN_USER_ROW]); // cross-source USER rows (24 h, same user)
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'agent-capture-1', ...data }));

    const r = await fileFeedbackTicket({
      ...VALID,
      userId: 'admin-owner-1',
      type: 'bug_report',
      title: 'Owner report: push refused permanently terminal auth quarantined for 6h',
      description: 'The owner said in the supervisor chat: push refused permanently terminal auth quarantined for 6h.',
      context: { sessionId: 'sup-9e6e1712', chatId: 'sup-9e6e1712', surface: 'chat', filedAt: '2026-10-18T00:00:00.000Z' },
    });
    expect(r).toMatchObject({ deduped: true, duplicateOf: 'user-90ab12cd' });
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ source: 'agent', status: 'done' });
    expect(created.context).toMatchObject({ duplicateOf: 'user-90ab12cd', autoDispatch: false });
  });

  it('a system filing is NOT parked by the incident-twin link either (the live 2026-10-16 class)', async () => {
    // The run-journal P0 shape: the same filing-text overlap that parked the
    // memory-audit P0s under a5b36dc6 (matched on shared boilerplate, not
    // defect substance). A system filing must never take the twin link.
    const OVERLAPPING_OPEN_AGENT_ROW = {
      id: 'agent-a5b36dc6',
      type: 'bug_report',
      title: 'Fleet Supervisor: preempted turns lose in-flight intents',
      description: 'P0 framework defect from the Digby Code agent\'s supervisor memory + behavior audit. Routing: spec + green verify then PR, no merge.',
      source: 'agent',
      status: 'open',
      priority: 5,
      createdAt: new Date(Date.now() - 5 * 60_000), // 5 min ago — inside the twin window
      context: { sessionId: 'fleet-sup-chat-1', chatId: 'fleet-sup-chat-1' },
    };
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // exact
      .mockResolvedValueOnce([]) // reopen
      .mockResolvedValueOnce([OVERLAPPING_OPEN_AGENT_ROW]) // fuzzy same-session candidates (the twin scan pool)
      .mockResolvedValueOnce([]); // cross-source (never reached — system filing skips; harmless if reached)
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-sweep-open-2', ...data }));

    const r = await fileFeedbackTicket({
      ...SWEEP_FILING,
      title: 'Fleet Supervisor has no run journal (cross-run memory)',
      description: 'P0 framework defect from the Digby Code agent\'s supervisor memory + behavior audit. Routing: spec + green verify then PR, no merge. writeRunJournalEntryAsync is coding-only; chat-agent finalize never calls it. Example raw log: quarantined for 6h, one fresh attempt after.',
    });
    expect(r).toMatchObject({ deduped: false });
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created.status).toBeUndefined(); // open, not done
    expect(created.context.duplicateOf).toBeUndefined();
    expect(created.context.duplicateMatch).toBeUndefined();
  });

  it('a system filing with the SAME stable title still bumps the standing open row (the 90-day exact contract the sweep relies on)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { id: 't-standing', type: 'bug_report', source: 'agent', status: 'open', priority: 2, description: 'first filing', title: SWEEP_FILING.title, context: { sessionId: 'log-signal-sweep:abc123def456', occurrences: 1 } },
    ]);
    mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));

    const r = await fileFeedbackTicket(SWEEP_FILING);
    expect(r).toMatchObject({ deduped: true, ticket: { id: 't-standing' } });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-standing' });
    expect(upd.data.context).toMatchObject({ occurrences: 2 });
  });
});

describe('fileFeedbackTicket — delivered-annotated sightings (ticket 336f3d38: the trail must state the actual delivery mode)', () => {
  it('a deliveredAnnotated containedPreDelivery sighting counter-bumps WITHOUT reopen, and the trail prose says the content DID reach the thread — never "never reached the thread"', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([]) // live exact pass — nothing open
      .mockResolvedValueOnce([]) // mishap-class pass — no open class sibling
      .mockResolvedValueOnce([{  // reopen scan — the closed same-title ticket
        id: 't-ann', type: 'mishap', title: 'Supervisor fabricated evidence citation: cited id(s) do not exist (chat 99e63f86)', status: 'done',
        priority: 3, source: 'agent', description: 'Original report.\n\nAdjudicated: true fabrication on a zero-tool wake; verifier true positive.',
        context: { sessionId: 'sess-0', occurrences: 1, sightings: [{ sessionId: 'sess-0' }] },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-ann', status: 'done' });

    const r = await fileFeedbackTicket({
      ...VALID, type: 'mishap',
      title: 'Supervisor fabricated evidence citation: cited id(s) do not exist (chat 99e63f86)',
      context: { sessionId: 'sess-1', containedPreDelivery: true, deliveredAnnotated: true, filedAt: '2026-10-19T16:31:43.822Z' },
    });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't-ann' });
    expect(upd.data.status).toBeUndefined();           // NO reopen — containment class (aac649ba)
    expect(upd.data.adminNote).toBeUndefined();        // no "fix did not hold" note
    expect(upd.data.context.occurrences).toBe(2);
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', containedPreDelivery: true, deliveredAnnotated: true });
    // THE FIX (ticket 336f3d38): the trail names the annotated delivery — the
    // incident's closed-ticket trail claimed "never reached the thread" while
    // the W1-4 default had delivered the note as written and the fabricated
    // citations had reached the peer lane.
    expect(upd.data.description).toContain('delivered AS WRITTEN with an observe-only annotation');
    expect(upd.data.description).not.toContain('never reached the thread');
    expect(upd.data.description).toContain('Adjudicated: true fabrication'); // history kept
    await new Promise((res) => setImmediate(res));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled(); // containment: no re-dispatch
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY — a containedPreDelivery sighting with NO deliveredAnnotated marker (pre-W1-4 replacement shape) keeps the legacy trail prose and still does not reopen (aac649ba pin)', async () => {
    mockPrisma.userFeatureRequest.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 't-legacy', type: 'bug_report', title: 'Send button unresponsive on mobile', status: 'done',
        priority: 5, source: 'agent', description: 'Original report.\n\nFixed in PR #592.',
        context: { sessionId: 'sess-0', occurrences: 9, sightings: [{ sessionId: 'sess-0' }], reopenCount: 3 },
        createdAt: new Date(), updatedAt: new Date(),
      }]);
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: 't-legacy', status: 'done' });

    const r = await fileFeedbackTicket({
      ...VALID, priority: 3,
      context: { sessionId: 'sess-1', containedPreDelivery: true, filedAt: '2026-09-03T14:36:35Z' },
    });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined(); // NO reopen
    expect(upd.data.priority).toBeUndefined(); // counter-bump: no priority escalation
    // Legacy prose preserved for the un-marked (pre-W1-4 replacement) shape.
    expect(upd.data.description).toContain('pre-delivery strike — the note was replaced before delivery, the struck content never reached the thread; NOT a reopen');
  });
});
