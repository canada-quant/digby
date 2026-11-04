/**
 * ticket-family.ts — TICKET-FAMILY-ROUTING (2026-10-20) pure helpers + the one
 * bounded history read. Pins the classifier (four 47397831 families + three V2
 * families, the V2 kill switch), the close classifier (negation-aware), the
 * measured-precision threshold, the class-fix absorption rules and the
 * filing-time route's gates.
 */

const mockFindMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockProjectFindUnique = jest.fn();
const mockChatFindUnique = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
    crossModelProject: { findUnique: (...a: unknown[]) => mockProjectFindUnique(...a) },
    crossModelChat: { findUnique: (...a: unknown[]) => mockChatFindUnique(...a) },
  },
}));

import {
  ticketFamilyKey,
  classifyFamilyClose,
  hasFixEvidence,
  fixCommitSha,
  familyPrecision,
  familyAbsorbKey,
  latestClassFixes,
  absorbVerdict,
  sightingTimeMs,
  loadFamilyHistory,
  familyFilingRoute,
  familyQueuedNote,
  familyDayWaitNote,
  isFamilyQueuedRow,
  classFixTimeMs,
  closeStampPatch,
  detectorRecheckVerdict,
  detectorRecheckLine,
  neverLaned,
  noteNamesShippedFix,
  ticketOwnerScopeAllowed,
  familyQueueScopeAllowed,
  FAMILY_PRECISION_WINDOW,
  FAMILY_NOISY_MIN,
  type FamilyCloseRow,
} from './ticket-family';

const H = 3600_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
function close(over: Partial<FamilyCloseRow> & { id: string }): FamilyCloseRow {
  return {
    title: 'Incomplete owner card oq_00001', type: 'bug_report', status: 'done', adminNote: null, context: {},
    createdAt: new Date(NOW - 20 * H), updatedAt: new Date(NOW - 10 * H), ...over,
  };
}
const ENV = { ...process.env };
beforeEach(() => {
  mockFindMany.mockReset();
  mockUserFindUnique.mockReset();
  mockProjectFindUnique.mockReset();
  mockChatFindUnique.mockReset();
  process.env = { ...ENV };
  for (const k of ['TICKET_FAMILY_PREFIX_V2_DISABLED', 'TICKET_FAMILY_PRECISION_ROUTING_DISABLED', 'TICKET_FAMILY_BATCHING_DISABLED', 'TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_DISPATCH_ANY_USER', 'TICKET_LANE_PROJECT_ID', 'PLATFORM_ENGINEER_CHAT_ID']) delete process.env[k];
});
afterAll(() => { process.env = ENV; });

describe('ticketFamilyKey', () => {
  it('keeps the four 47397831 families and adds incomplete-card / missed-bug / av-mishap', () => {
    expect(ticketFamilyKey('Recurring log signature ef6bd89e')).toBe('recurring-log-signature');
    expect(ticketFamilyKey('Raw marker SEND_EMAIL (high) survived in chat c0e22e36')).toBe('raw-marker');
    expect(ticketFamilyKey('log-signal: invalid signature')).toBe('log-signal');
    expect(ticketFamilyKey('3× tool-failure streak: verify on "x" — framework or model?')).toBe('tool-failure-streak');
    expect(ticketFamilyKey('Incomplete owner card oq_d5948')).toBe('incomplete-card');
    expect(ticketFamilyKey('Missed bug: owner frustration in chat 1a2b3c4d')).toBe('missed-bug');
    expect(ticketFamilyKey('Phantom action claim: chat asserted action(s) never executed (chat 1a2b3c4d)', { context: { verifier: 'action-verifier' } })).toBe('av-mishap');
  });

  it('av-mishap keys on the verifier stamp, never on title alone', () => {
    expect(ticketFamilyKey('Phantom action claim: chat asserted action(s) never executed (chat 1a2b3c4d)')).toBeNull();
    expect(ticketFamilyKey('Phantom action claim (chat 1a2b3c4d)', { context: { verifier: 'other' } })).toBeNull();
  });

  it('never matches a human title that merely mentions a family', () => {
    expect(ticketFamilyKey('The incomplete owner card detector is noisy')).toBeNull();
    expect(ticketFamilyKey('Missed bug in the sweep')).toBeNull();
    expect(ticketFamilyKey(undefined)).toBeNull();
  });

  it('TICKET_FAMILY_PREFIX_V2_DISABLED=1 restores the four-family classifier', () => {
    const env = { ...process.env, TICKET_FAMILY_PREFIX_V2_DISABLED: '1' };
    expect(ticketFamilyKey('Incomplete owner card oq_d5948', null, env)).toBeNull();
    expect(ticketFamilyKey('Missed bug: owner frustration in chat 1a2b3c4d', null, env)).toBeNull();
    expect(ticketFamilyKey('x', { context: { verifier: 'action-verifier' } }, env)).toBeNull();
    expect(ticketFamilyKey('Raw marker BATCH survived in chat c0e22e36', null, env)).toBe('raw-marker');
  });
});

describe('classifyFamilyClose', () => {
  it('sibling: a duplicate link or "same root cause as" wording', () => {
    expect(classifyFamilyClose({ status: 'done', context: { duplicateOf: 'x' } })).toBe('sibling');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'Same root cause as ticket 1234abcd — closed with it.' })).toBe('sibling');
  });

  it('false positive: adjudication wording or the adjudicated stamp, and it beats fix evidence', () => {
    expect(classifyFamilyClose({ status: 'done', adminNote: 'False positive: the marker was quoted in a code block.' })).toBe('false_positive');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'Model behavior, guard correct.' })).toBe('false_positive');
    expect(classifyFamilyClose({ status: 'done', context: { adjudicatedClass: true } })).toBe('false_positive');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'False positive — detector narrowed.\n[machine-close evidence: commit abcdef1234567 (x)]' })).toBe('false_positive');
  });

  it('a NEGATED verdict is not an adjudication (the confirmed-defect close shape)', () => {
    expect(classifyFamilyClose({ status: 'done', adminNote: 'Real framework defect, not a false positive.\n[machine-close evidence: commit abcdef1234567 (x)]' })).toBe('true_defect');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'NOT model behavior — fixed and deployed in commit abcdef1234567.' })).toBe('true_defect');
  });

  it('true defect: fix evidence; unknown: nothing recorded', () => {
    expect(classifyFamilyClose({ status: 'deployed_verified' })).toBe('true_defect');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'Fixed in https://github.com/o/r/pull/12' })).toBe('true_defect');
    expect(classifyFamilyClose({ status: 'done', adminNote: 'closed' })).toBe('unknown');
  });

  it('hasFixEvidence / fixCommitSha read the LAST evidence block', () => {
    expect(hasFixEvidence({ adminNote: '[machine-close evidence: replay test x.test.ts]' })).toBe(true);
    expect(hasFixEvidence({ adminNote: 'nothing' })).toBe(false);
    expect(fixCommitSha('[machine-close evidence: commit aaaaaaa1 (x)]\n[machine-close evidence: commit BBBBBBB2 (y)]')).toBe('bbbbbbb2');
  });
});

describe('familyPrecision', () => {
  it(`is noisy at ${FAMILY_NOISY_MIN} false positives / siblings in the last ${FAMILY_PRECISION_WINDOW} closes`, () => {
    const fp = (id: string) => close({ id, adminNote: 'False positive.' });
    const td = (id: string) => close({ id, adminNote: '[machine-close evidence: commit abcdef1234567 (x)]' });
    expect(familyPrecision('incomplete-card', [fp('1'), fp('2'), td('3')]).noisy).toBe(false);
    const p = familyPrecision('incomplete-card', [fp('1'), close({ id: '2', context: { duplicateOf: 'x' } }), fp('3'), td('4')]);
    expect(p).toMatchObject({ considered: 4, falsePositives: 2, siblings: 1, trueDefects: 1, noisy: true });
  });

  it('only the newest five closes count, and the dispatcher\'s own absorbed rows never do', () => {
    const fp = (id: string) => close({ id, adminNote: 'False positive.' });
    const td = (id: string) => close({ id, adminNote: '[machine-close evidence: commit abcdef1234567 (x)]' });
    // newest-first: 5 true defects then 3 false positives (older) → not noisy
    expect(familyPrecision('missed-bug', [td('1'), td('2'), td('3'), td('4'), td('5'), fp('6'), fp('7'), fp('8')]).noisy).toBe(false);
    const absorbed = (id: string) => close({ id, context: { duplicateOf: 'f', absorbedByClassFix: { ticketId: 'f' } } });
    expect(familyPrecision('missed-bug', [absorbed('1'), absorbed('2'), absorbed('3'), td('4')]).noisy).toBe(false);
  });

  it('notes are dispatcher-shaped and name the measurement', () => {
    const p = familyPrecision('av-mishap', [close({ id: '1', adminNote: 'False positive.' }), close({ id: '2', adminNote: 'False positive.' }), close({ id: '3', adminNote: 'False positive.' })]);
    expect(familyQueuedNote(p)).toMatch(/^Queued for the next av-mishap family lane — .*3 false positives \+ 0 siblings in its last 3 closes/);
    expect(familyDayWaitNote(p)).toMatch(/^Waiting for the next av-mishap family lane — /);
  });
});

describe('class-fix absorption', () => {
  const FIX = '[machine-close evidence: commit abcdef1234567 (x)]';
  /** A close the update path stamped (context.closedAt) — the only fix time absorption trusts. */
  const stamped = (hoursAgo: number, ctx: Record<string, unknown> = {}) => ({ ...ctx, closedAt: new Date(NOW - hoursAgo * H).toISOString() });

  it('absorb keys: raw-marker per marker (instance); incomplete-card / missed-bug / av-mishap detector-wide; none for log families', () => {
    expect(familyAbsorbKey('raw-marker', { title: 'Raw marker HARNESS survived in chat 1' })).toEqual({ key: 'raw-marker:HARNESS', detectorWide: false });
    expect(familyAbsorbKey('raw-marker', { title: 'x', context: { marker: 'send_email' } })).toEqual({ key: 'raw-marker:SEND_EMAIL', detectorWide: false });
    // Review 2026-10-20: one av-mishap title class spans every chat and many causes — detector-wide, never absorbed.
    expect(familyAbsorbKey('av-mishap', { title: 'Phantom action claim: chat asserted action(s) never executed (chat 1a2b3c4d)' })).toEqual({ key: 'av-mishap', detectorWide: true });
    expect(familyAbsorbKey('incomplete-card', { title: 'x' })).toEqual({ key: 'incomplete-card', detectorWide: true });
    expect(familyAbsorbKey('missed-bug', { title: 'x' })).toEqual({ key: 'missed-bug', detectorWide: true });
    expect(familyAbsorbKey('log-signal', { title: 'log-signal: x' })).toBeNull();
    expect(familyAbsorbKey('recurring-log-signature', { title: 'Recurring log signature aaaaaa' })).toBeNull();
  });

  it('closeStampPatch stamps ONLY the transition into closed / awaiting_verification', () => {
    const iso = new Date(NOW).toISOString();
    expect(closeStampPatch('in_progress', 'done', iso)).toEqual({ closedAt: iso });
    expect(closeStampPatch('open', 'awaiting_verification', iso)).toEqual({ closedAt: iso });
    expect(closeStampPatch('reopened', 'done', iso)).toEqual({ closedAt: iso }); // a re-close stamps afresh
    expect(closeStampPatch('awaiting_verification', 'deployed_verified', iso)).toBeNull(); // the verifier keeps the lane's close time
    expect(closeStampPatch('done', 'done', iso)).toBeNull();
    expect(closeStampPatch('open', 'in_progress', iso)).toBeNull();
    expect(closeStampPatch('open', undefined, iso)).toBeNull();
  });

  it('classFixTimeMs: closedAt, else the done-bar handoff time — NEVER updatedAt (a later write moves it)', () => {
    expect(classFixTimeMs({ updatedAt: new Date(NOW), context: { closedAt: new Date(NOW - 6 * H).toISOString() } })).toBe(NOW - 6 * H);
    expect(classFixTimeMs({ updatedAt: new Date(NOW), context: { verification: { queuedAt: new Date(NOW - 4 * H).toISOString() } } })).toBe(NOW - 4 * H);
    expect(classFixTimeMs({ updatedAt: new Date(NOW), context: { laneArchivedAt: new Date(NOW).toISOString() } })).toBeNull();
    expect(classFixTimeMs({ updatedAt: new Date(NOW - 2 * H), context: { closedAt: new Date(NOW).toISOString() } })).toBe(NOW - 2 * H); // never later than updatedAt
  });

  it('latestClassFixes: newest fix per class; siblings and UNSTAMPED closes never fix; detector-wide needs a false-positive close with a COMMIT', () => {
    const rows = [
      close({ id: 'new', title: 'Raw marker HARNESS survived in chat 1', adminNote: `Fixed renderer. ${FIX}`, context: stamped(1), updatedAt: new Date(NOW - 0.1 * H) }),
      close({ id: 'old', title: 'Raw marker HARNESS survived in chat 2', adminNote: `Fixed. ${FIX}`, context: stamped(5), updatedAt: new Date(NOW - 5 * H) }),
      close({ id: 'sib', title: 'Raw marker BATCH survived in chat 3', adminNote: `Duplicate of 1234abcd. ${FIX}`, context: stamped(2) }),
      close({ id: 'nostamp', title: 'Raw marker SECRET survived in chat 4', adminNote: `Fixed. ${FIX}` }),
    ];
    const fixes = latestClassFixes('raw-marker', rows);
    expect(fixes.get('raw-marker:HARNESS')).toMatchObject({ ticketId: 'new', detectorWide: false, commitSha: 'abcdef1234567' });
    // The fix time is the CLOSE stamp (1 h ago), not updatedAt (6 min ago — e.g. the lane-archive write).
    expect(fixes.get('raw-marker:HARNESS')?.fixedAt.getTime()).toBe(NOW - 1 * H);
    expect(fixes.has('raw-marker:BATCH')).toBe(false);
    expect(fixes.has('raw-marker:SECRET')).toBe(false); // unstamped close: never an anchor
    expect(latestClassFixes('incomplete-card', [close({ id: 'td', adminNote: `Fixed one card. ${FIX}`, context: stamped(1) })]).size).toBe(0);
    expect(latestClassFixes('incomplete-card', [close({ id: 'fpnc', adminNote: 'False positive — detector narrowed.\n[machine-close evidence: replay test x.test.ts]', context: stamped(1) })]).size).toBe(0);
    expect(latestClassFixes('incomplete-card', [close({ id: 'fp', adminNote: `False positive — detector narrowed. ${FIX}`, context: stamped(1) })]).get('incomplete-card'))
      .toMatchObject({ ticketId: 'fp', detectorWide: true });
  });

  it('absorbVerdict: only an undispatched, never-laned open/queued sighting LAST seen BEFORE the fix', () => {
    const fixes = latestClassFixes('raw-marker', [close({ id: 'fix', title: 'Raw marker HARNESS survived in chat 1', adminNote: FIX, context: stamped(1), updatedAt: new Date(NOW) })]);
    const s = (over: Record<string, unknown>) => ({ id: 's', title: 'Raw marker HARNESS survived in chat 2', status: 'open', createdAt: new Date(NOW - 3 * H), adminNote: null, context: {}, ...over });
    expect(absorbVerdict('raw-marker', s({}), fixes)?.ticketId).toBe('fix');
    expect(absorbVerdict('raw-marker', s({ status: 'queued' }), fixes)?.ticketId).toBe('fix');
    expect(absorbVerdict('raw-marker', s({ status: 'reopened' }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ createdAt: new Date(NOW - 0.5 * H) }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ context: { dispatchedTo: 'lane' } }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ context: { autoDispatch: false } }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ id: 'fix' }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ title: 'Raw marker SECRET survived in chat 2' }), fixes)).toBeNull();
    // Review 2026-10-20: first seen before the fix, BUMPED after it — a post-fix recurrence.
    expect(absorbVerdict('raw-marker', s({ context: { lastSeen: new Date(NOW - 0.5 * H).toISOString() } }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ context: { sightings: [{ filedAt: new Date(NOW - 0.2 * H).toISOString() }] } }), fixes)).toBeNull();
    // Review 2026-10-20: a row a lane already carried (handed back to open) is never absorbed.
    expect(absorbVerdict('raw-marker', s({ context: { previousLanes: ['lane-1'] } }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ context: { laneDispatches: 2 } }), fixes)).toBeNull();
    expect(absorbVerdict('raw-marker', s({ adminNote: 'Auto re-dispatch stopped — 3 ticket lanes ran without closing it; it needs a human look.' }), fixes)).toBeNull();
  });

  it('a DETECTOR-WIDE class is never absorbed — the pending sighting gets a re-check verdict instead', () => {
    const fixes = latestClassFixes('missed-bug', [close({ id: 'det-0001', title: 'Missed bug: owner frustration in chat 1111aaaa', adminNote: `False positive — owner was venting; detector narrowed. ${FIX}`, context: stamped(1), updatedAt: new Date(NOW) })]);
    const pending = { id: 'p', title: 'Missed bug: owner frustration in chat 2222bbbb', status: 'queued', createdAt: new Date(NOW - 3 * H), adminNote: null, context: { familyQueued: true } };
    expect(absorbVerdict('missed-bug', pending, fixes)).toBeNull();
    expect(detectorRecheckVerdict('missed-bug', pending, fixes)?.ticketId).toBe('det-0001');
    expect(detectorRecheckVerdict('missed-bug', { ...pending, createdAt: new Date(NOW - 0.5 * H) }, fixes)).toBeNull(); // sighted after the narrowing
    const line = detectorRecheckLine('missed-bug', fixes.get('missed-bug')!, ['p-1111-aaaa', 'bad id with spaces']);
    expect(line).toMatch(/^DETECTOR NARROWED — RE-CHECK: ticket det-0001 \(commit abcdef123456\) recorded the missed-bug detector as over-firing/);
    expect(line).toContain('p-1111-aaaa');
    expect(line).not.toContain('bad id');
    expect(line).toContain('Never close one on the narrowing alone');
    expect(detectorRecheckLine('missed-bug', fixes.get('missed-bug')!, ['bad id'])).toBeNull();
  });

  it('sightingTimeMs: the observed event time (never later than filing), or a later dedup bump when newer', () => {
    expect(sightingTimeMs({ createdAt: new Date(NOW), context: { observedAt: new Date(NOW - H).toISOString() } })).toBe(NOW - H);
    expect(sightingTimeMs({ createdAt: new Date(NOW), context: { observedAt: new Date(NOW + H).toISOString() } })).toBe(NOW);
    expect(sightingTimeMs({ createdAt: new Date(NOW), context: {} })).toBe(NOW);
    expect(sightingTimeMs({ createdAt: new Date(NOW - 5 * H), context: { lastSeen: new Date(NOW - H).toISOString() } })).toBe(NOW - H);
    expect(sightingTimeMs({ createdAt: new Date(NOW - 5 * H), context: { sightings: [{ filedAt: new Date(NOW - 2 * H).toISOString() }, null] } })).toBe(NOW - 2 * H);
  });

  it('neverLaned / noteNamesShippedFix', () => {
    expect(neverLaned({ adminNote: 'Queued for the next raw-marker family lane — …', context: {} })).toBe(true);
    expect(neverLaned({ context: { previousLanes: [] } })).toBe(true);
    expect(neverLaned({ context: { previousLanes: ['x'] } })).toBe(false);
    expect(noteNamesShippedFix('Root cause: renderer dropped the tag; the guard was correct to flag it. Fixed in commit abc1234.')).toBe(true);
    expect(noteNamesShippedFix('See https://github.com/o/r/pull/12')).toBe(true);
    expect(noteNamesShippedFix('False positive.\n[machine-close evidence: replay test x.test.ts]')).toBe(false);
  });

  it('isFamilyQueuedRow needs both the status and the stamp', () => {
    expect(isFamilyQueuedRow({ status: 'queued', context: { familyQueued: true } })).toBe(true);
    expect(isFamilyQueuedRow({ status: 'queued', context: { queuedReason: 'session cap' } })).toBe(false);
    expect(isFamilyQueuedRow({ status: 'open', context: { familyQueued: true } })).toBe(false);
  });
});

describe('loadFamilyHistory + familyFilingRoute', () => {
  const fpRow = (id: string, title: string) => close({ id, title, adminNote: 'False positive.' });

  it('one bounded read: closed statuses, a lookback, family-narrowed OR; grouped newest first; non-family / open rows dropped', async () => {
    mockFindMany.mockResolvedValueOnce([
      fpRow('a', 'Incomplete owner card oq_00011'),
      close({ id: 'b', title: 'Some human ticket' }),
      close({ id: 'c', title: 'Incomplete owner card oq_00012', status: 'open' }),
      close({ id: 'd', title: 'x', context: { verifier: 'action-verifier' } }),
    ]);
    const h = await loadFamilyHistory(NOW);
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where.status.in).toContain('done');
    expect(arg.where.updatedAt.gte).toBeInstanceOf(Date);
    expect(arg.take).toBe(200);
    expect(arg.where.OR.length).toBeGreaterThan(4);
    expect(h.byFamily.get('incomplete-card')?.map((r) => r.id)).toEqual(['a']);
    expect(h.byFamily.get('av-mishap')?.map((r) => r.id)).toEqual(['d']);
    expect(h.error).toBeUndefined();
  });

  it('never throws: a failed read is an empty map with the error', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    const h = await loadFamilyHistory(NOW);
    expect(h.byFamily.size).toBe(0);
    expect(h.error).toContain('db down');
  });

  const inScope = { scopeAllowed: async () => true };
  const noisy = () => mockFindMany.mockResolvedValue([fpRow('a', 'Missed bug: owner frustration in chat 11111111'), fpRow('b', 'Missed bug: owner frustration in chat 22222222'), fpRow('c', 'Missed bug: owner frustration in chat 33333333')]);

  it('routes a NOISY family\'s new member, nothing else', async () => {
    noisy();
    const route = await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, process.env, inScope);
    expect(route).toMatchObject({ family: 'missed-bug', noisy: true, falsePositives: 3 });
    expect(await familyFilingRoute({ title: 'A human ticket' }, NOW, process.env, inScope)).toBeNull();
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444', context: { severity: 'high' } }, NOW, process.env, inScope)).toBeNull();
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, { ...process.env, TICKET_FAMILY_PRECISION_ROUTING_DISABLED: '1' }, inScope)).toBeNull();
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, { ...process.env, TICKET_FAMILY_BATCHING_DISABLED: '1' }, inScope)).toBeNull();
  });

  it('review 2026-10-20: a noisy-family row the fresh-lane drain cannot carry files OPEN (never stranded as queued)', async () => {
    noisy();
    // out of owner scope (another account's ticket) → open, where the held list sees it
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444', userId: 'someone-else' }, NOW, process.env, { scopeAllowed: async () => false })).toBeNull();
    // the standing-lane path is serving (it reads open rows only)
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, { ...process.env, TICKET_DISPATCH_FRESH_LANES_DISABLED: '1' }, inScope)).toBeNull();
    // the default scope check, with no lane home, files open too
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444', userId: 'owner-1' }, NOW)).toBeNull();
    // the scope check runs only for a NOISY family (a quiet family never pays the lane-home read)
    mockFindMany.mockResolvedValue([fpRow('a', 'Missed bug: owner frustration in chat 11111111')]);
    const scope = jest.fn(async () => true);
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, process.env, { scopeAllowed: scope })).toBeNull();
    expect(scope).not.toHaveBeenCalled();
  });

  it('familyQueueScopeAllowed: the lane-home owner, an ADMIN author or an approved row; nothing without a lane home', async () => {
    process.env.TICKET_LANE_PROJECT_ID = 'proj-home';
    mockProjectFindUnique.mockResolvedValue({ id: 'proj-home', userId: 'owner-1' });
    expect(await familyQueueScopeAllowed({ userId: 'owner-1' })).toBe(true);
    mockUserFindUnique.mockResolvedValueOnce({ role: 'ADMIN' });
    expect(await familyQueueScopeAllowed({ userId: 'admin-2' })).toBe(true);
    mockUserFindUnique.mockResolvedValueOnce({ role: 'USER' });
    expect(await familyQueueScopeAllowed({ userId: 'user-3' })).toBe(false);
    expect(await familyQueueScopeAllowed({ userId: 'user-3', context: { dispatchApproved: true } })).toBe(true);
    expect(await familyQueueScopeAllowed({ userId: null })).toBe(false);
    expect(await familyQueueScopeAllowed({ userId: 'owner-1' }, { ...process.env, TICKET_DISPATCH_FRESH_LANES_DISABLED: '1' })).toBe(false);
    mockProjectFindUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await familyQueueScopeAllowed({ userId: 'owner-1' })).toBe(false); // never throws
    delete process.env.TICKET_LANE_PROJECT_ID;
    expect(await familyQueueScopeAllowed({ userId: 'owner-1' })).toBe(false); // no lane home
  });

  it('ticketOwnerScopeAllowed is the F3 rule (owner / admin author / approved; ANY_USER opens it)', () => {
    expect(ticketOwnerScopeAllowed({ userId: 'o' }, 'o')).toBe(true);
    expect(ticketOwnerScopeAllowed({ userId: 'x', user: { role: 'admin' } }, 'o')).toBe(true);
    expect(ticketOwnerScopeAllowed({ userId: 'x' }, 'o')).toBe(false);
    expect(ticketOwnerScopeAllowed({ userId: null, context: { dispatchApproved: true } }, 'o')).toBe(true);
    expect(ticketOwnerScopeAllowed({ userId: 'x' }, 'o', { ...process.env, TICKET_DISPATCH_ANY_USER: '1' })).toBe(true);
  });

  it('a read failure routes nothing (the pre-routing filing)', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    expect(await familyFilingRoute({ title: 'Missed bug: owner frustration in chat 44444444' }, NOW, process.env, inScope)).toBeNull();
  });
});
