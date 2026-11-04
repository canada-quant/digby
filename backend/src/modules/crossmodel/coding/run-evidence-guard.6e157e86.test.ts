/**
 * REPLAY PIN — ticket 6e157e86-ed58-4765-92ac-39e92f4ac838 (2026-09-14,
 * session 98723a76 "GLM53 Flash Repo Management" — a spark-cluster worktree
 * lane monitoring the EXTERNAL repo canada-quant/glm53-flash-w4a16-fp8-mtp).
 *
 * THE MISHAP: three machine-triggered runs (12:26Z, 12:49Z, 13:22Z) were each
 * struck by GUARD 2 with rows like
 *   "fabricated PR claims (GitHub 404): #16; merge claims refuted by GitHub
 *    (PR not merged): #2, #3"
 * — every one a DETERMINISTIC FALSE POSITIVE. Fresh per-PR GitHub GETs during
 * investigation showed PR #16 merged=True (merge sha 81e68530540e @13:03:45Z,
 * == main head) and PRs #2 (1304b9ec845d) / #3 (a9a32c3b7d48) / #14 / #15 all
 * merged=True ON THE MONITORED REPO. The guard verified the BARE numbers
 * against the session's origin (canada-quant/spark-cluster), where #16 is a
 * genuine 404 and #2/#3 are different, unmerged PRs.
 *
 * WHY #676 DIDN'T SAVE THESE RUNS: tickets 630fadc0/be8b6939 fixed
 * TEXT-ADJACENT qualification (github.com URL / owner/repo#n / "owner/repo
 * PR #n"). These finals name the monitored repo only by NICKNAME ("glm53
 * main", "the model repo") — no extractable slug adjacent to any number — so
 * every number fell through to the session-repo lane. The runs' OBSERVED TOOL
 * OUTPUTS, however, self-described the repo: the lane's GitHub API reads
 * returned PR payloads carrying
 *   "url":      "https://api.github.com/repos/canada-quant/glm53-flash-w4a16-fp8-mtp/pulls/16"
 *   "html_url": "https://github.com/canada-quant/glm53-flash-w4a16-fp8-mtp/pull/16"
 *
 * THE FIX (this PR): extractPrRepoEvidenceBindings mines the run's
 * tool-output haystack (parts ∪ toolTexts ∪ priorToolTexts — the same union
 * GUARDs 1/3/4 already read) for repo-bearing PR URL shapes and binds each
 * observed number to the repo it was READ from. GUARD 2 merges the bindings
 * UNDER the text qualifiers (an explicit "… PR #n" naming a repo always wins)
 * and verifies bound numbers against the OBSERVED repo, reusing #676's
 * fail-open repo-existence pre-check. A number with NEITHER anchor keeps the
 * legacy session-repo lane — an unobserved phantom still convicts there.
 *
 * RELATIONSHIP TO THE SIBLING FIX 3aa41a40d (same-day, alias map + hints):
 * that fix covers the "<alias> PR #N" idiom and downgrades unknown sibling
 * names to UNVERIFIED — but the VERBATIM incident phrasing carries no
 * adjacent alias at all ("…glm53 main: PR #16 merged"; "PR #2 merged=True
 * …"), so prRepoAliasMentions mines nothing, no hint fires, and the number
 * still fell through to the session repo. The "GAP PIN" describe below
 * reproduces exactly that under main's alias map, and the replay shows the
 * evidence anchor closing it. Composed precedence: text/alias qualifier >
 * observed-evidence binding > unresolved hint > legacy session lane.
 *
 * Mock discipline mirrors run-evidence-guard.630fadc0.test.ts: logger + the
 * GitHub token manager stubbed, global.fetch stubbed with a URL router, the
 * REAL guard executes. Never import config/env transitively here.
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
  extractPrRepoEvidenceBindings,
} from './run-evidence-guard';

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

/** Minimal Response stand-in for the GitHub API (same shape as the sibling suites). */
const ghResponse = (status: number, body?: any): any => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** URL-fragment router — longest fragments FIRST (the repo pre-check URL is a prefix of the pulls URL). */
const route = (routes: Array<[string, { status: number; body?: any }]>) => {
  mockFetch.mockImplementation(async (url: any) => {
    const u = String(url);
    for (const [frag, r] of routes) {
      if (u.includes(frag)) return ghResponse(r.status, r.body);
    }
    return ghResponse(404);
  });
};

/** The flagged session's worktree origin (the repo the guard verified against pre-fix). */
const OPTS = { userId: 'u1', repoUrl: 'https://github.com/canada-quant/spark-cluster', provider: 'github' };
/** Just after the third flagged run (13:22Z) — every cited stamp is safely past. */
const NOW = new Date('2026-09-14T13:30:00.000Z');

/** The monitored external repo's slug, as the API payloads self-describe it. */
const MONITORED = 'canada-quant/glm53-flash-w4a16-fp8-mtp';

/** A GitHub PR API payload the way the lane's curl/gh reads emitted it (repo-bearing URLs intact). */
const prPayload = (n: number, opts: { merged: boolean; sha?: string; mergedAt?: string }): string =>
  JSON.stringify({
    number: n,
    state: opts.merged ? 'closed' : 'open',
    merged: opts.merged,
    merge_commit_sha: opts.sha ?? null,
    merged_at: opts.mergedAt ?? null,
    url: `https://api.github.com/repos/${MONITORED}/pulls/${n}`,
    html_url: `https://github.com/${MONITORED}/pull/${n}`,
  });

/** The incident runs' observed evidence: per-PR GET payloads for #16/#2/#3 (+ a bare main-head line). */
const INCIDENT_TOOL_TEXTS = [
  prPayload(16, { merged: true, sha: '81e68530540e8d3f1a2b4c5d6e7f8a9b0c1d2e3f', mergedAt: '2026-09-14T13:03:45Z' }),
  prPayload(2, { merged: true, sha: '1304b9ec845d1a2b3c4d5e6f7a8b9c0d1e2f3a4b', mergedAt: '2026-09-13T17:54:18Z' }),
  prPayload(3, { merged: true, sha: 'a9a32c3b7d481a2b3c4d5e6f7a8b9c0d1e2f3a4b', mergedAt: '2026-09-13T18:03:59Z' }),
  'GLM53_MAIN 81e68530540e @13:03:44Z\nOPEN_PRS 0 []',
];

/**
 * The flagged finals' claim lines, VERBATIM in shape: bare numbers, the
 * monitored repo named only by NICKNAME ("glm53 main") — no extractable slug
 * adjacent to any number (that is why #676's text qualifiers stayed empty).
 */
const INCIDENT_FINAL = [
  'Concrete update on glm53 main: PR #16 merged — merge sha 81e68530540e @2026-09-14T13:03:45Z, == main head (fresh GET).',
  'Sibling closure re-verified: PR #2 merged=True 1304b9ec845d @2026-09-13T17:54:18Z; audit-reopen PR #3 merged=True a9a32c3b7d48 @2026-09-13T18:03:59Z.',
].join('\n');

const mergedBody = (sha: string, at: string) => ({ merged: true, merge_commit_sha: sha, merged_at: at });

describe('extractPrRepoEvidenceBindings — observed-output URL shapes (ticket 6e157e86)', () => {
  it('binds a number from an api.github.com/repos/<o>/<r>/pulls/<n> payload URL', () => {
    const m = extractPrRepoEvidenceBindings([prPayload(16, { merged: true })]);
    expect(m.get(16)).toEqual({ owner: 'canada-quant', repo: 'glm53-flash-w4a16-fp8-mtp' });
  });
  it('binds a number from a github.com/<o>/<r>/pull/<n> html_url', () => {
    const m = extractPrRepoEvidenceBindings(['"html_url": "https://github.com/tenstorrent/tt-metal/pull/55747"']);
    expect(m.get(55747)).toEqual({ owner: 'tenstorrent', repo: 'tt-metal' });
  });
  it('binds from a PR sub-resource URL (/pulls/<n>/files)', () => {
    const m = extractPrRepoEvidenceBindings([`https://api.github.com/repos/${MONITORED}/pulls/16/files`]);
    expect(m.get(16)).toEqual({ owner: 'canada-quant', repo: 'glm53-flash-w4a16-fp8-mtp' });
  });
  it('ignores LIST urls (no number), issue urls, and commit urls', () => {
    const m = extractPrRepoEvidenceBindings([
      `https://api.github.com/repos/${MONITORED}/pulls?state=open&per_page=30`,
      `https://api.github.com/repos/${MONITORED}/issues/16`,
      `https://api.github.com/repos/${MONITORED}/commits/81e68530540e`,
    ]);
    expect(m.size).toBe(0);
  });
  it('binds NOTHING from shorthand lane output that names no repo (no laundering via "PR16 closed | merged True")', () => {
    const m = extractPrRepoEvidenceBindings(['PR16 closed | merged True | merge_sha 81e68530540e', 'GLM53_MAIN 81e68530540e @13:03:44Z']);
    expect(m.size).toBe(0);
  });
  it('first binding per number wins across texts', () => {
    const m = extractPrRepoEvidenceBindings([
      prPayload(16, { merged: true }),
      `"url": "https://api.github.com/repos/other-org/other-repo/pulls/16"`,
    ]);
    expect(m.get(16)).toEqual({ owner: 'canada-quant', repo: 'glm53-flash-w4a16-fp8-mtp' });
  });
  it('empty and blank haystacks bind nothing', () => {
    expect(extractPrRepoEvidenceBindings([]).size).toBe(0);
    expect(extractPrRepoEvidenceBindings(['']).size).toBe(0);
  });
});

describe('GUARD 2 evidence-anchored repo resolution — incident replay + controls (ticket 6e157e86)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidToken.mockResolvedValue('tok');
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('REPLAYS the incident: bare-number claims about the monitored repo are NOT fabricated when the run observed them there', async () => {
    route([
      [`repos/${MONITORED}/pulls/16`, { status: 200, body: mergedBody('81e68530540e8d3f1a2b4c5d6e7f8a9b0c1d2e3f', '2026-09-14T13:03:45Z') }],
      [`repos/${MONITORED}/pulls/2`, { status: 200, body: mergedBody('1304b9ec845d1a2b3c4d5e6f7a8b9c0d1e2f3a4b', '2026-09-13T17:54:18Z') }],
      [`repos/${MONITORED}/pulls/3`, { status: 200, body: mergedBody('a9a32c3b7d481a2b3c4d5e6f7a8b9c0d1e2f3a4b', '2026-09-13T18:03:59Z') }],
      [`repos/${MONITORED}`, { status: 200, body: { full_name: MONITORED } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      // 'user' trigger isolates GUARD 2 (GUARD 1's receipts lane is
      // machine-only): this pin is about WHERE numbers verify, not the
      // zero-evidence lane — the incident runs' rows were GUARD 2's.
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: INCIDENT_TOOL_TEXTS,
      ...OPTS,
    });

    // THE BUG FIX: pre-fix this was fabricatedPrs [16] + refutedMergePrs [2,3]
    // — three REAL merged PRs convicted against the wrong repo.
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    // Every number verified against the OBSERVED repo, named in the footer.
    expect(out.finalText).toContain(`PR #16 (${MONITORED}) — ✅ VERIFIED MERGED`);
    expect(out.finalText).toContain(`PR #2 (${MONITORED}) — ✅ VERIFIED MERGED`);
    expect(out.finalText).toContain(`PR #3 (${MONITORED}) — ✅ VERIFIED MERGED`);
    // 4 fetches: ONE cached repo pre-check + three per-PR GETs; the session
    // repo was NEVER queried for these numbers.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    for (const call of mockFetch.mock.calls) expect(String(call[0])).not.toContain('spark-cluster');
  });

  it('CONTROL (anti-phantom): the SAME final with no repo-bearing observation keeps the legacy lane — the incident strike rows still convict', async () => {
    route([
      ['repos/canada-quant/spark-cluster/pulls/16', { status: 404 }],
      ['repos/canada-quant/spark-cluster/pulls/2', { status: 200, body: { state: 'open' } }],
      ['repos/canada-quant/spark-cluster/pulls/3', { status: 200, body: { state: 'closed', merged: false } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      // Shorthand outputs ONLY — the lane's own summary lines name no repo, so
      // nothing binds and every number falls through to the session repo.
      toolTexts: ['GLM53_MAIN 81e68530540e @13:03:44Z', 'PR16 closed | merged True | merge_sha 81e68530540e', 'OPEN_PRS 0 []'],
      ...OPTS,
    });

    // The ticket's false-positive class, reproduced when NO evidence anchors
    // the numbers elsewhere: #16 (no alias-ish token near it) convicts on the
    // legacy session lane; #2's real-but-OPEN session-repo namesake refutes.
    // A phantom cannot launder through a nickname or a shorthand output line.
    expect(out.verdict.fabricatedPrs).toEqual([16]);
    expect(out.verdict.refutedMergePrs).toEqual([2]);
    // #3 is NOT convicted here — the sibling hint lane (3aa41a40d) mines
    // "audit-reopen PR #3" as an unknown-alias hint → UNVERIFIED with the
    // write-it-as-owner/repo instruction; a hint is never adjudicated
    // against the session repo (and makes NO GitHub call → 2 fetches total).
    expect(out.finalText).toContain('owner/repo#3');
    expect(out.finalText).toContain('PR #16 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) expect(String(call[0])).toContain('spark-cluster');
  });

  it('CONTROL (precedence): an explicit TEXT qualifier naming the session repo wins over a conflicting evidence binding', async () => {
    route([
      ['repos/canada-quant/spark-cluster/pulls/16', { status: 404 }],
    ]);
    const out = await applyCompletionClaimGuard({
      // The claim EXPLICITLY names the session repo — it must be judged there,
      // even though the run also read #16 from the monitored repo.
      finalText: 'Merged canada-quant/spark-cluster PR #16 with the container stack.',
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: [prPayload(16, { merged: true })],
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([16]);
    // Session-slug lane: no repo pre-check, one PR GET, no glm53 fetch at all.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('repos/canada-quant/spark-cluster/pulls/16');
  });

  it('CONTROL (fail-open): a bound repo the token cannot see (repo-level 404) is unavailable, NEVER fabricated', async () => {
    route([
      [`repos/${MONITORED}`, { status: 404 }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: 'Concrete update on glm53 main: PR #16 merged — merge sha 81e68530540e @2026-09-14T13:03:45Z.',
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: [prPayload(16, { merged: true })],
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    expect(out.finalText).toContain('cannot adjudicate');
    // Only the repo pre-check fires — the PR fetch is skipped on an invisible repo.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bound repos get ACCURATE verdicts: a real-but-unmerged observed PR is refuted (not "fabricated"), a merged one verifies', async () => {
    route([
      [`repos/${MONITORED}/pulls/16`, { status: 200, body: { state: 'open' } }],
      [`repos/${MONITORED}/pulls/2`, { status: 200, body: { state: 'closed', merged: false } }],
      [`repos/${MONITORED}/pulls/3`, { status: 200, body: mergedBody('a9a32c3b7d481a2b3c4d5e6f7a8b9c0d1e2f3a4b', '2026-09-13T18:03:59Z') }],
      [`repos/${MONITORED}`, { status: 200, body: { full_name: MONITORED } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: INCIDENT_TOOL_TEXTS,
      ...OPTS,
    });
    // Pre-fix BOTH were mis-labeled: #16 would have been "fabricated" (404 on
    // the session repo) instead of the accurate "merge refuted — still OPEN".
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([16, 2]);
    expect(out.finalText).toContain(`PR #16 (${MONITORED}) — ❌ UNVERIFIED merge claim: GitHub says this PR is still OPEN`);
    expect(out.finalText).toContain(`PR #3 (${MONITORED}) — ✅ VERIFIED MERGED`);
  });
});

describe('GAP PIN vs the sibling alias fix 3aa41a40d (ticket 6e157e86)', () => {
  /** What run-executor's buildRepoAliasMap hands the guard for this owner's projects (repo NAME → slug). */
  const PROD_ALIASES = new Map([
    ['glm53-flash-w4a16-fp8-mtp', { owner: 'canada-quant', repo: 'glm53-flash-w4a16-fp8-mtp' }],
    ['spark-cluster', { owner: 'canada-quant', repo: 'spark-cluster' }],
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidToken.mockResolvedValue('tok');
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('the VERBATIM incident phrasing still convicted under the alias map alone (no adjacent alias → no qualifier, no hint)', async () => {
    route([
      ['repos/canada-quant/spark-cluster/pulls/16', { status: 404 }],
      ['repos/canada-quant/spark-cluster/pulls/2', { status: 200, body: { state: 'open' } }],
      ['repos/canada-quant/spark-cluster/pulls/3', { status: 200, body: { state: 'closed', merged: false } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: ['GLM53_MAIN 81e68530540e @13:03:44Z', 'PR16 closed | merged True | merge_sha 81e68530540e'],
      repoAliases: PROD_ALIASES,
      ...OPTS,
    });
    // The residual false-positive class under main's alias fix alone: #16
    // still convicts (no alias-ish token near it) and #2 still refutes; #3
    // is hint-downgraded by the sibling lane ("audit-reopen PR #3"). This is
    // the gap the evidence anchor closes (next test).
    expect(out.verdict.fabricatedPrs).toEqual([16]);
    expect(out.verdict.refutedMergePrs).toEqual([2]);
    expect(out.finalText).toContain('owner/repo#3');
  });

  it('aliases + evidence bindings compose: with the SAME alias map, observed payload URLs clear every conviction', async () => {
    route([
      [`repos/${MONITORED}/pulls/16`, { status: 200, body: mergedBody('81e68530540e8d3f1a2b4c5d6e7f8a9b0c1d2e3f', '2026-09-14T13:03:45Z') }],
      [`repos/${MONITORED}/pulls/2`, { status: 200, body: mergedBody('1304b9ec845d1a2b3c4d5e6f7a8b9c0d1e2f3a4b', '2026-09-13T17:54:18Z') }],
      [`repos/${MONITORED}/pulls/3`, { status: 200, body: mergedBody('a9a32c3b7d481a2b3c4d5e6f7a8b9c0d1e2f3a4b', '2026-09-13T18:03:59Z') }],
      [`repos/${MONITORED}`, { status: 200, body: { full_name: MONITORED } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'user',
      now: NOW,
      receipts: [],
      toolTexts: INCIDENT_TOOL_TEXTS,
      repoAliases: PROD_ALIASES,
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    expect(out.finalText).toContain(`PR #16 (${MONITORED}) — ✅ VERIFIED MERGED`);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    for (const call of mockFetch.mock.calls) expect(String(call[0])).not.toContain('spark-cluster');
  });
});
