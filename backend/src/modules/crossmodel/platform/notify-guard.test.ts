/**
 * audit 2026-10-06 T3-6 — notify_user guards (platform/notify-guard.ts), pure
 * + store-backed pins: near-duplicate detection over token HASHES (never text)
 * inside the window, the dismissed-question cite / re-raise match, and both
 * kill switches. The executor wiring is pinned in account-tools.test.ts.
 */

const mockRedisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => mockRedisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockRedisStore.set(k, v); return 'OK'; }),
  },
}));
const mockOwnerQuestions: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: {
      findMany: jest.fn(async ({ where }: any) => mockOwnerQuestions.filter((q) => q.userId === where.userId && q.status === where.status && new Date(q.resolvedAt) >= where.resolvedAt.gte)),
    },
  },
}));

import {
  notifyTokens, notifySimilarity, notifyTokenHashes, citedOwnerQuestionIds,
  findNotifyDuplicate, rememberNotify, findDismissedQuestionRaised,
  renderNotifyDuplicateRefusal, renderNotifyDismissedRefusal,
} from './notify-guard';

const ENV = ['NOTIFY_USER_DEDUPE_DISABLED', 'NOTIFY_USER_DISMISSED_GUARD_DISABLED', 'NOTIFY_USER_DEDUPE_WINDOW_MIN', 'NOTIFY_USER_DEDUPE_SIMILARITY'];
beforeEach(() => { mockRedisStore.clear(); mockOwnerQuestions.length = 0; for (const k of ENV) delete process.env[k]; });

describe('pure helpers', () => {
  it('tokens are normalized; the stored form is hashes only; Jaccard similarity', () => {
    // FIXTURE TOKEN, DELIBERATELY NOT A SCRUB TARGET (todo 13069ce2, 2026-11-05).
    // This fixture used the internal host label. In a public export the scrub
    // rewrote the INPUT ('node-a' -> 'node-a') while the expectation literal was a
    // DIFFERENT spelling ('node-a'), so the pin failed for a reason that has
    // nothing to do with notifyTokens — and worse, it could PASS VACUOUSLY the
    // other way round (a redacted-away token cannot appear in storage no matter
    // what the code does, so `.not.toContain(...)` would prove nothing). A
    // neutral token keeps the pin tree-invariant: it proves the same thing in
    // the private tree AND the export instead of being skipped in one of them.
    expect(notifyTokens('BENCH hit 42.7 tok/s — NEW best!')).toEqual(['bench', 'hit', '42', '7', 'tok', 'new', 'best']);
    const h = notifyTokenHashes('BENCH hit 42.7 tok/s');
    expect(h.every((x) => /^[0-9a-f]{10}$/.test(x))).toBe(true);
    expect(JSON.stringify(h)).not.toContain('bench');
    expect(notifySimilarity(notifyTokenHashes('a bb cc dd'), notifyTokenHashes('a bb cc dd'))).toBe(1);
    expect(notifySimilarity(notifyTokenHashes('lane x finished run 3 42.7 tok/s'), notifyTokenHashes('lane x finished run 4 43.1 tok/s'))).toBeLessThan(0.7);
  });

  it('cited oq_ ids need ≥ 8 hex after the prefix', () => {
    expect(citedOwnerQuestionIds('see question oq_e5338871 in your inbox and oq_ab')).toEqual(['oq_e5338871']);
    expect(citedOwnerQuestionIds('OQ_E5338871-1234-')).toEqual(['oq_e5338871-1234']);
  });
});

describe('near-duplicate window', () => {
  it('a repeat of a delivered push inside 6 h is a duplicate; a different push is not; the window and the kill switch apply', async () => {
    const t0 = Date.now();
    await rememberNotify('u1', 'node-a reached 42.7 tok/s on the bench — new best, PR #88 merged.', t0);
    expect(mockRedisStore.get('notify:recent:u1')).not.toContain('node-a');
    const dup = await findNotifyDuplicate('u1', 'node-a reached 42.7 tok/s on the bench — new best! PR #88 merged', t0 + 11 * 60_000);
    expect(dup).toMatchObject({ duplicate: true, similarity: 1 });
    expect(renderNotifyDuplicateRefusal(dup!)).toMatch(/Nothing was sent: a near-identical notification/);
    expect(await findNotifyDuplicate('u1', 'AGX box is back online; serving resumed at 18 tok/s.', t0 + 60_000)).toBeNull();
    expect(await findNotifyDuplicate('u1', 'node-a reached 42.7 tok/s on the bench — new best, PR #88 merged.', t0 + 7 * 3600_000)).toBeNull();
    expect(await findNotifyDuplicate('u2', 'node-a reached 42.7 tok/s on the bench — new best, PR #88 merged.', t0 + 60_000)).toBeNull();
    process.env.NOTIFY_USER_DEDUPE_DISABLED = '1';
    expect(await findNotifyDuplicate('u1', 'node-a reached 42.7 tok/s on the bench — new best, PR #88 merged.', t0 + 60_000)).toBeNull();
  });
});

describe('dismissed owner questions', () => {
  const dismissed = (over: any = {}) => ({ id: 'oq_e5338871-aaaa-bbbb-cccc-000000000001', userId: 'u1', status: 'dismissed', question: 'Run the 2-minute setup wizard on the AGX box so the agent can pair', resolvedAt: new Date(Date.now() - 30 * 60_000), ...over });

  it('a push citing a dismissed question id (inside 24 h) is caught; one dismissed 2 days ago is not', async () => {
    mockOwnerQuestions.push(dismissed());
    const hit = await findDismissedQuestionRaised('u1', 'Reminder: question oq_e5338871 in your Digby inbox still needs the 2-minute wizard step.');
    expect(hit).toMatchObject({ id: dismissed().id, via: 'cited' });
    expect(renderNotifyDismissedRefusal(hit!)).toMatch(/OWNER DISMISSED/);
    mockOwnerQuestions.length = 0;
    mockOwnerQuestions.push(dismissed({ resolvedAt: new Date(Date.now() - 48 * 3600_000) }));
    expect(await findDismissedQuestionRaised('u1', 'question oq_e5338871 still open?')).toBeNull();
  });

  it('a re-raise without the id needs the same topic AND ask-shaped wording; a plain report on the topic passes; the kill switch disables it', async () => {
    mockOwnerQuestions.push(dismissed());
    expect(await findDismissedQuestionRaised('u1', 'Please run the 2-minute setup wizard on the AGX box so the agent can pair — waiting on you.'))
      .toMatchObject({ via: 'topic' });
    expect(await findDismissedQuestionRaised('u1', 'Nightly digest: 3 PRs merged, bench steady at 42 tok/s.')).toBeNull();
    process.env.NOTIFY_USER_DISMISSED_GUARD_DISABLED = '1';
    expect(await findDismissedQuestionRaised('u1', 'question oq_e5338871 needs you')).toBeNull();
  });
});
