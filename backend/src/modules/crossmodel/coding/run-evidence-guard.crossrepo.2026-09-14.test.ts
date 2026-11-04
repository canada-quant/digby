/**
 * REPLAY PIN — rollout watch 2026-09-14, spark repo lane 98723a76 → Fleet
 * Supervisor (13:45:59Z): "the evidence-guard strikes on my 12:26Z/12:49Z/13:22Z
 * runs (fabricated PR #16, merge-refuted #2/#3) are DISPROVEN by fresh glm53
 * API reads: glm53 PR #16 merged=True … #2, #3 all merged=True. ROOT CAUSE: the
 * guard resolved those PR numbers against THIS session's worktree origin
 * (canada-quant/spark-cluster), where PR #16 is HTTP 404 and #2/#3 are
 * different, unmerged PRs — the claims were about the glm53 sibling repo."
 *
 * Four observe-only strikes (kinds fabricated_pr + refuted_merge) on an honest
 * lane, feeding false fabrication verdicts to supervisors.
 *
 * THE FIX: (1) a repo ALIAS map (owner's projects' repoUrls, built by
 * run-executor) lets "glm53 PR #16" resolve to canada-quant/glm53 and verify
 * THERE; (2) an alias the map does not know is a HINT — the number is never
 * looked up in the session repo and renders UNVERIFIED with a write-it-as
 * owner/repo#N instruction; (3) bare "PR #N" stays the legacy session-repo lane.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockGetValidToken: jest.Mock = jest.fn(async () => 'tok');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  applyCompletionClaimGuard,
  extractPrRepoQualifiers,
  extractPrRepoHints,
  prRepoAliasMentions,
  verifyPrClaims,
} from './run-evidence-guard';

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();
const ghResponse = (status: number, body?: any): any => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const route = (routes: Array<[string, { status: number; body?: any }]>) => {
  mockFetch.mockImplementation(async (url: any) => {
    const u = String(url);
    for (const [frag, r] of routes) if (u.includes(frag)) return ghResponse(r.status, r.body);
    return ghResponse(404);
  });
};
const SESSION = { userId: 'u1', repoUrl: 'https://github.com/canada-quant/spark-cluster', provider: 'github' };
const ALIASES = new Map([
  ['glm53', { owner: 'canada-quant', repo: 'glm53' }],
  ['canada-quant/glm53', { owner: 'canada-quant', repo: 'glm53' }],
  ['spark-cluster', { owner: 'canada-quant', repo: 'spark-cluster' }],
]);
const NOTE = 'Merged glm53 PR #16 (81e68530) and confirmed glm53 PR #2, glm53 PR #3 merged=True; the H200 numbers folded via PR #14 in glm53.';

beforeEach(() => { jest.clearAllMocks(); mockFetch.mockReset(); global.fetch = mockFetch as any; });
afterEach(() => { global.fetch = realFetch; });

describe('prRepoAliasMentions / extractPrRepoHints — the sibling-repo idiom', () => {
  it('mines "<alias> PR #N", "PR #N in <alias>", possessive and "repo" forms; stopwords never mine', () => {
    const got = prRepoAliasMentions(NOTE);
    expect(got).toEqual(expect.arrayContaining([['glm53', 16], ['glm53', 2], ['glm53', 3], ['glm53', 14]]));
    expect(prRepoAliasMentions('Merged PR #16 and opened PR #17; the PR #18 is a draft PR #19.')).toEqual([]);
    // Prose words are never repo aliases: ALL-CAPS status words, trailing-dot sentence ends, plain nouns without a digit/hyphen.
    expect(prRepoAliasMentions('Plan 6/6 — CLOSED. PR #224 squash-merged; tracker PR #9 filed; the status PR #5 too')).toEqual([]);
    expect(prRepoAliasMentions("tt-rd's PR #540 landed; see PR #7 in the tt-metal repo")).toEqual(expect.arrayContaining([['tt-rd', 540], ['tt-metal', 7]]));
  });

  it('hints exclude the session repo itself and every alias the map resolves', () => {
    expect(extractPrRepoHints(NOTE, 'spark-cluster', ALIASES).size).toBe(0);
    const unknown = extractPrRepoHints(NOTE, 'spark-cluster', undefined);
    expect([...unknown.entries()]).toEqual(expect.arrayContaining([[16, 'glm53'], [2, 'glm53'], [3, 'glm53'], [14, 'glm53']]));
    expect(extractPrRepoHints('spark-cluster PR #12 merged; sparkcluster PR #13 too', 'spark-cluster').size).toBe(0);
  });

  it('extractPrRepoQualifiers resolves known aliases to their slug (slug-qualified forms unchanged)', () => {
    const m = extractPrRepoQualifiers(NOTE, ALIASES);
    expect(m.get(16)).toEqual({ owner: 'canada-quant', repo: 'glm53' });
    expect(m.get(14)).toEqual({ owner: 'canada-quant', repo: 'glm53' });
    expect(extractPrRepoQualifiers(NOTE).size).toBe(0); // no map → legacy behaviour
    expect(extractPrRepoQualifiers('tenstorrent/tt-metal#55747', ALIASES).get(55747)).toEqual({ owner: 'tenstorrent', repo: 'tt-metal' });
  });
});

describe('verifyPrClaims — hints are never adjudicated against the session repo', () => {
  it('a hinted number returns UNVERIFIED with the owner/repo#N instruction and makes NO GitHub call', async () => {
    route([]);
    const vs = await verifyPrClaims({ prNumbers: [16], userId: 'u1', repoUrl: SESSION.repoUrl, provider: 'github', repoHints: new Map([[16, 'glm53']]) });
    expect(vs[0]).toMatchObject({ number: 16, state: 'unavailable', repo: 'glm53' });
    expect(vs[0].reason).toContain('owner/repo#16');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a resolved alias override verifies against THAT repo (existing 630fadc0 lane), hint ignored when an override exists', async () => {
    route([
      ['repos/canada-quant/glm53/pulls/16', { status: 200, body: { merged: true, merge_commit_sha: '81e68530540e', merged_at: '2026-09-14T13:03:45Z' } }],
      ['repos/canada-quant/glm53', { status: 200, body: { full_name: 'canada-quant/glm53' } }],
    ]);
    const vs = await verifyPrClaims({
      prNumbers: [16], userId: 'u1', repoUrl: SESSION.repoUrl, provider: 'github',
      repoOverrides: new Map([[16, { owner: 'canada-quant', repo: 'glm53' }]]), repoHints: new Map([[16, 'glm53']]),
    });
    expect(vs[0]).toMatchObject({ number: 16, state: 'merged', repo: 'canada-quant/glm53' });
  });
});

describe('applyCompletionClaimGuard — THE INCIDENT REPLAY (lane 98723a76, 12:26–13:46Z)', () => {
  const now = new Date('2026-09-14T13:46:00Z');
  const sessionRepoRoutes: Array<[string, { status: number; body?: any }]> = [
    // In the SESSION repo: #16 is a 404 and #2/#3 are different, unmerged PRs (the false-positive inputs).
    ['repos/canada-quant/spark-cluster/pulls/16', { status: 404 }],
    ['repos/canada-quant/spark-cluster/pulls/2', { status: 200, body: { state: 'open' } }],
    ['repos/canada-quant/spark-cluster/pulls/3', { status: 200, body: { state: 'closed' } }],
    ['repos/canada-quant/spark-cluster/pulls/14', { status: 404 }],
  ];
  const glm53Routes: Array<[string, { status: number; body?: any }]> = [
    ['repos/canada-quant/glm53/pulls/16', { status: 200, body: { merged: true, merge_commit_sha: '81e68530540e', merged_at: '2026-09-14T13:03:45Z' } }],
    ['repos/canada-quant/glm53/pulls/2', { status: 200, body: { merged: true, merge_commit_sha: '1304b9ec845d', merged_at: '2026-09-13T10:00:00Z' } }],
    ['repos/canada-quant/glm53/pulls/3', { status: 200, body: { merged: true, merge_commit_sha: 'a9a32c3b7d48', merged_at: '2026-09-13T11:00:00Z' } }],
    ['repos/canada-quant/glm53/pulls/14', { status: 200, body: { merged: true, merge_commit_sha: '98ceae6ce95e', merged_at: '2026-09-14T09:00:00Z' } }],
    ['repos/canada-quant/glm53', { status: 200, body: { full_name: 'canada-quant/glm53' } }],
  ];

  it('WITH the alias map: every glm53 claim verifies against glm53 → zero fabricated / refuted (pre-fix: #16 fabricated, #2/#3 refuted)', async () => {
    route([...glm53Routes, ...sessionRepoRoutes]);
    const out = await applyCompletionClaimGuard({ finalText: NOTE, parts: [], triggerKind: 'hook', now, receipts: [], ...SESSION, repoAliases: ALIASES } as any);
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    expect(mockFetch.mock.calls.some((c: any[]) => String(c[0]).includes('spark-cluster/pulls'))).toBe(false);
  });

  it('WITHOUT the alias map: the sibling name is a hint → UNVERIFIED, no session-repo lookup, still zero convictions', async () => {
    route(sessionRepoRoutes);
    const out = await applyCompletionClaimGuard({ finalText: NOTE, parts: [], triggerKind: 'hook', now, receipts: [], ...SESSION } as any);
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    expect(mockFetch.mock.calls.some((c: any[]) => String(c[0]).includes('/pulls/'))).toBe(false);
    expect(out.finalText).toContain('owner/repo#16');
  });

  it('a bare "PR #16" with no repo name keeps the legacy session-repo lane (404 → fabricated)', async () => {
    route(sessionRepoRoutes);
    const out = await applyCompletionClaimGuard({ finalText: 'Merged PR #16 (81e68530) into main.', parts: [], triggerKind: 'hook', now, receipts: [], ...SESSION, repoAliases: ALIASES } as any);
    expect(out.verdict.fabricatedPrs).toEqual([16]);
  });
});
