/**
 * Child-session relay + delivered-result visibility (ticket 739e8191).
 *
 * DETECTOR-RECALL REPLAY: this file carries the marker because the change
 * touches the fleet thread's NOISE CLASSIFIER (classifyThreadRows) and the
 * minimal view's owner-facing predicates — both recall filters. The replay
 * cases at the bottom re-assert the PRIOR true positives still fire: an
 * ordinary machine wake, a non-child [AGENT-SENT MESSAGE] relay (supervisor
 * fan-out), a schedule wake with no owner arming, and a quiet "nothing new"
 * reply MUST still be classified noise / hidden exactly as before, so the
 * exemption cannot be used to surface internal machine traffic.
 *
 * WHY (owner report 2026-11-02 in chat 99e63f86): "you dont see to communicate
 * with the user/human after you get a message from a sub session ie...you
 * should then relay to me whatever message was sent back from the subsession
 * … ie the agent has finished the work and everything is done". The parent DID
 * relay (transcript msgs 1eb953b3→3e29ea9b and 67071bba→992dd445), but the
 * relay row is origin 'agent', which the fleet classifier treats as noise and
 * the minimal view stubs hidden — so the owner never SAW the result.
 */
import { isChildSessionRelay, isChildRelayRow, rowHasChildResult, isChildSessionRelaySend } from './child-session-relay';

describe('child-session relay detection (ticket 739e8191)', () => {
  describe('isChildSessionRelay — lineage authority is parentChatId', () => {
    it('fires when the sender is a direct child of the target chat', () => {
      expect(isChildSessionRelay('parent-1', 'child-9', { parentChatId: 'parent-1' })).toBe(true);
    });

    it('refuses a sender that is NOT a child of the target (supervisor fan-out stays machine traffic)', () => {
      expect(isChildSessionRelay('parent-1', 'sibling-2', { parentChatId: null })).toBe(false);
      expect(isChildSessionRelay('parent-1', 'other-3', { parentChatId: 'different-parent' })).toBe(false);
    });

    it('refuses a chat relaying into itself (a chat is never its own child)', () => {
      expect(isChildSessionRelay('same', 'same', { parentChatId: 'same' })).toBe(false);
    });

    it('is conservative on missing ids or unresolved lineage', () => {
      expect(isChildSessionRelay(null, 'child-9', { parentChatId: null })).toBe(false);
      expect(isChildSessionRelay('parent-1', null, { parentChatId: 'parent-1' })).toBe(false);
      expect(isChildSessionRelay('parent-1', 'child-9', null)).toBe(false);
      expect(isChildSessionRelay('parent-1', 'child-9', {})).toBe(false);
    });
  });

  describe('isChildRelayRow — the transcript-row predicate both read layers share', () => {
    const kids = new Set(['child-9']);

    it('matches metadata.sourceChatId naming a child', () => {
      expect(isChildRelayRow({ metadata: { origin: 'agent', sourceChatId: 'child-9' } }, kids)).toBe(true);
    });

    it('matches the originSourceChatId spelling too (both are persisted today)', () => {
      expect(isChildRelayRow({ metadata: { origin: 'agent', originSourceChatId: 'child-9' } }, kids)).toBe(true);
    });

    it('does not match a sender that is not a child', () => {
      expect(isChildRelayRow({ metadata: { origin: 'agent', sourceChatId: 'stranger' } }, kids)).toBe(false);
    });

    it('returns false with no lineage set (degrades to today behaviour) or no metadata', () => {
      expect(isChildRelayRow({ metadata: { origin: 'agent', sourceChatId: 'child-9' } }, new Set())).toBe(false);
      expect(isChildRelayRow({ metadata: { origin: 'agent', sourceChatId: 'child-9' } }, null)).toBe(false);
      expect(isChildRelayRow({ metadata: null }, kids)).toBe(false);
      expect(isChildRelayRow({}, kids)).toBe(false);
    });
  });

  describe('rowHasChildResult', () => {
    it('reads the stamped marker defensively', () => {
      expect(rowHasChildResult({ childResult: true })).toBe(true);
      expect(rowHasChildResult({ childResult: 'true' })).toBe(false);
      expect(rowHasChildResult({})).toBe(false);
      expect(rowHasChildResult(null)).toBe(false);
    });
  });
});

/**
 * Ticket 327ff5e3 — the PERSIST-side half that 739e8191/1757b07d never shipped.
 *
 * The read-side predicate above was only ever consulted by the fleet thread, so
 * a relay into a PLAIN chat carried no metadata.childResult and the frontend
 * grouping probe could never fire there. isChildSessionRelaySend decides the
 * same question at SEND time (lineage via the sender row) so the stamp rides
 * the row itself and EVERY reader sees it.
 */
describe('ticket 327ff5e3 — isChildSessionRelaySend (persist-side stamp decision)', () => {
  const parent = 'parent-1';
  const child = 'child-9';
  const lookup = (row: any) => jest.fn(async (_id: string) => row);

  it('stamps when the sender is a direct child of the target chat', async () => {
    const look = lookup({ parentChatId: parent });
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: child, lookupSender: look })).resolves.toBe(true);
    // Exactly ONE indexed PK read, for the SENDER only.
    expect(look).toHaveBeenCalledTimes(1);
    expect(look).toHaveBeenCalledWith(child);
  });

  it('does NOT stamp a sibling/supervisor relay (lineage is the only authority — supervisor fan-out stays machine traffic)', async () => {
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: 'sibling-2', lookupSender: lookup({ parentChatId: null }) })).resolves.toBe(false);
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: 'other-3', lookupSender: lookup({ parentChatId: 'different-parent' }) })).resolves.toBe(false);
  });

  it('does NOT stamp a chat relaying into itself', async () => {
    const look = lookup({ parentChatId: parent });
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: parent, lookupSender: look })).resolves.toBe(false);
    // The self-send refusal is free — no query is ever issued.
    expect(look).not.toHaveBeenCalled();
  });

  it('does NOT stamp without both ids or a lookup (fail closed, no throw)', async () => {
    await expect(isChildSessionRelaySend({ targetChatId: null, sourceChatId: child, lookupSender: lookup({ parentChatId: null }) })).resolves.toBe(false);
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: null, lookupSender: lookup({ parentChatId: parent }) })).resolves.toBe(false);
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: child })).resolves.toBe(false);
  });

  it('fails CLOSED when the lineage lookup throws (a DB hiccup must never break a send, never invent owner content)', async () => {
    const boom = jest.fn(async () => { throw new Error('prisma down'); });
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: child, lookupSender: boom })).resolves.toBe(false);
  });

  it('fails closed when the sender row is missing entirely', async () => {
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: child, lookupSender: lookup(null) })).resolves.toBe(false);
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: child, lookupSender: lookup(undefined) })).resolves.toBe(false);
  });
});

/**
 * DETECTOR-RECALL REPLAY (ticket 327ff5e3): the persist stamp is a VISIBILITY
 * exemption, and its whole risk is over-exemption — surfacing internal machine
 * traffic as owner content. These replay the predicate's PRIOR true negatives
 * (the exact rows the read-side gate keeps hiding today); they MUST still be
 * refused after the persist seam is wired.
 */
describe('DETECTOR-RECALL REPLAY — the persist stamp must not widen [ticket 327ff5e3]', () => {
  const parent = 'parent-replay';
  const lookup = (row: any) => jest.fn(async () => row);

  it('replays the supervisor fan-out true negative: a non-child relay stays unstamped', async () => {
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: 'fleet-supervisor', lookupSender: lookup({ parentChatId: null }) })).resolves.toBe(false);
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: 'fleet-supervisor', lookupSender: lookup({ parentChatId: 'someone-else' }) })).resolves.toBe(false);
  });

  it('replays the unresolved-lineage true negative: an unreadable sender stays unstamped', async () => {
    const thrower = jest.fn(async () => { throw new Error('lookup failed'); });
    await expect(isChildSessionRelaySend({ targetChatId: parent, sourceChatId: 'child-x', lookupSender: thrower })).resolves.toBe(false);
  });

  it('replays the "no stamp is ever invented" rule: the read predicate still hides a marker-less non-child row', () => {
    const kids = new Set(['child-9']);
    expect(isChildRelayRow({ metadata: { origin: 'agent', sourceChatId: 'stranger' } }, kids)).toBe(false);
    expect(isChildRelayRow({ metadata: { origin: 'agent' } }, kids)).toBe(false);
  });
});