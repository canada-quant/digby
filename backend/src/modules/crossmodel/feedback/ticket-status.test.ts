/**
 * feedback/ticket-status.ts — the ONE status vocabulary (backlog audit T8,
 * 2026-09-28): canonical write set, the closed read set with every legacy
 * spelling, normalisation on read, the query list and the sort rank.
 */
import {
  FEEDBACK_STATUSES,
  OPEN_TICKET_STATUSES,
  LEGACY_CLOSED_TICKET_STATUSES,
  CLOSED_TICKET_STATUSES,
  isCanonicalTicketStatus,
  MANIFEST_CLOSABLE_STATUSES,
  isClosedTicketStatus,
  normalizeTicketStatus,
  closedTicketStatusesForQuery,
  ticketStatusRank,
} from './ticket-status';

describe('ticket-status vocabulary', () => {
  it('canonical write set + open set + closed set are consistent and disjoint where they must be', () => {
    expect([...FEEDBACK_STATUSES]).toEqual(['open', 'in_progress', 'queued', 'done', 'awaiting_verification', 'deployed_verified', 'reopened']);
    expect([...OPEN_TICKET_STATUSES]).toEqual(['open', 'in_progress', 'queued', 'reopened']);
    expect(CLOSED_TICKET_STATUSES[0]).toBe('done');
    expect(CLOSED_TICKET_STATUSES).toEqual(['done', 'deployed_verified', ...LEGACY_CLOSED_TICKET_STATUSES]);
    for (const s of OPEN_TICKET_STATUSES) expect(CLOSED_TICKET_STATUSES).not.toContain(s);
    // awaiting_verification is LIMBO — neither open (never re-dispatched) nor closed.
    expect(OPEN_TICKET_STATUSES).not.toContain('awaiting_verification');
    expect(CLOSED_TICKET_STATUSES).not.toContain('awaiting_verification');
    // Every legacy spelling the coding stopped-schedule alert accepted is still closed.
    expect(CLOSED_TICKET_STATUSES).toEqual(expect.arrayContaining(['done', 'closed', 'resolved', 'archived', 'rejected', 'duplicate', 'wontfix']));
  });

  it('isCanonicalTicketStatus / isClosedTicketStatus', () => {
    expect(isCanonicalTicketStatus('done')).toBe(true);
    expect(isCanonicalTicketStatus('deployed_verified')).toBe(true);
    expect(isCanonicalTicketStatus('reopened')).toBe(true);
    expect(isCanonicalTicketStatus('awaiting_verification')).toBe(true);
    expect(isCanonicalTicketStatus('resolved')).toBe(false);
    expect(isCanonicalTicketStatus(42)).toBe(false);
    expect(isClosedTicketStatus('done')).toBe(true);
    expect(isClosedTicketStatus('deployed_verified')).toBe(true);
    expect(isClosedTicketStatus('reopened')).toBe(false); // work owed
    expect(isClosedTicketStatus('awaiting_verification')).toBe(false); // limbo
    expect(isClosedTicketStatus(' Resolved ')).toBe(true);
    expect(isClosedTicketStatus('open')).toBe(false);
    expect(isClosedTicketStatus(null)).toBe(false);
  });

  it('normalizeTicketStatus folds every legacy closed spelling to done and passes canonical / unknown through', () => {
    for (const legacy of LEGACY_CLOSED_TICKET_STATUSES) expect(normalizeTicketStatus(legacy)).toBe('done');
    expect(normalizeTicketStatus('RESOLVED')).toBe('done');
    for (const s of FEEDBACK_STATUSES) expect(normalizeTicketStatus(s)).toBe(s);
    expect(normalizeTicketStatus('weird')).toBe('weird');
    expect(normalizeTicketStatus(null)).toBe('');
    expect(normalizeTicketStatus(undefined)).toBe('');
  });

  it('closedTicketStatusesForQuery lists done + the legacy spellings; ticketStatusRank ranks a legacy row with done', () => {
    expect(closedTicketStatusesForQuery()).toEqual([...CLOSED_TICKET_STATUSES]);
    expect(ticketStatusRank('open')).toBe(0);
    expect(ticketStatusRank('in_progress')).toBe(1);
    expect(ticketStatusRank('queued')).toBe(2);
    expect(ticketStatusRank('done')).toBe(5);
    expect(ticketStatusRank('deployed_verified')).toBe(6);
    expect(ticketStatusRank('resolved')).toBe(5); // legacy closed ranks with done
    expect(ticketStatusRank('weird')).toBe(FEEDBACK_STATUSES.length); // unknown → last
  });

  it('post-deploy done-bar extension (6665fff6): the verifier states + the manifest-closable set', () => {
    // The verifier's writes are canonical (writable vocabulary)…
    expect(FEEDBACK_STATUSES).toEqual(expect.arrayContaining(['deployed_verified', 'reopened', 'awaiting_verification']));
    // …and reopened re-enters the dispatch drain's open set.
    expect(OPEN_TICKET_STATUSES).toContain('reopened');
    // The closure manifest NEVER re-closes a verifier-reopened row (reopen
    // wins forever) nor one awaiting verification.
    expect(MANIFEST_CLOSABLE_STATUSES).toEqual(['open', 'in_progress', 'queued']);
    expect(MANIFEST_CLOSABLE_STATUSES).not.toContain('reopened');
    expect(MANIFEST_CLOSABLE_STATUSES).not.toContain('awaiting_verification');
  });
});
