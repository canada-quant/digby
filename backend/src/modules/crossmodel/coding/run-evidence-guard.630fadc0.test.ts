/**
 * REPLAY PIN — tickets 630fadc0 + be8b6939 (2026-09-11, session 17f71915
 * "Bounty Submission Status Inquiry", run 0478465a-b420-479e-a1fa-d9e4a2fd55ad).
 *
 * THE MISHAP: a tt-rd-workspace session runs a recurring watch on an EXTERNAL
 * repo's PR — tenstorrent/tt-metal #55747 (Command-R bounty bring-up; VERIFIED
 * REAL at investigation time: state open, head 5d2f7eb9, via
 * GET /repos/tenstorrent/tt-metal/pulls/55747). Its acting run's final answer
 * referenced that PR in create posture ("created 2026-09-08"), and the evidence
 * guard convicted on TWO lanes:
 *   - zero-evidence completion claims: pr_created  (GUARD 1 — no this-run
 *     creation receipt; the run's receipts were for tt-rd PR #540)
 *   - fabricated PR claims (GitHub 404): #55747    (GUARD 2 — verified the
 *     number against the SESSION repo canada-quant/tt-rd, where no PR #55747
 *     exists: GET /repos/canada-quant/tt-rd/pulls/55747 → 404)
 * The second conviction was a DETERMINISTIC FALSE POSITIVE: the guard queried
 * only the session repo and ignored the owner/repo qualification in the claim
 * text. Every rewrite of the answer re-tripped the same lane → 3× final_answer
 * failure streak → derail breaker → ticket be8b6939. The guard then filed
 * ticket 630fadc0 (containedPreDelivery: true — the answer never shipped).
 *
 * THE FIX (this PR): extractPrRepoQualifiers maps a number to an owner/repo
 * named ADJACENT to it (URL / owner/repo#n / owner/repo PR #n forms), and
 * verifyPrClaims verifies qualified numbers against the QUALIFIED repo. A
 * qualified repo gets ONE existence pre-check (cached): repo-level 404 (or a
 * lookup hiccup) → 'unavailable', NEVER 'missing' — the guard convicts only
 * when the named repo exists AND the PR 404s inside it, so the anti-phantom
 * lane is fully preserved.
 *
 * WHAT THE FIX DELIBERATELY DOES NOT CHANGE: GUARD 1's receipts-only lane for
 * consequential kinds. A create/merge/close verb on ANY PR number without a
 * this-run action receipt still flags unproven_completion — that discipline is
 * what catches real phantoms, and the flagged session's schedule prompt was
 * steered (no create-verbs on the watched external PR) to stop producing the
 * posture. The replay below pins BOTH lanes: fabricated_pr cleared, unproven
 * pr_created still convicted without receipts.
 *
 * Mock discipline mirrors run-evidence-guard.incidents.test.ts: logger + the
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
  extractPrRepoQualifiers,
  verdictHasFindings,
} from './run-evidence-guard';
import type { ToolReceipt } from './run-receipts';

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

/** Minimal Response stand-in for the GitHub API (same shape as the unit suites). */
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

/** The flagged session's project repo (tt-rd workspace — the repo the guard verified against pre-fix). */
const OPTS = { userId: 'u1', repoUrl: 'https://github.com/canada-quant/tt-rd', provider: 'github' };
const NOW = new Date('2026-09-11T02:17:00.000Z');

let receiptSeq = 0;
const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}): ToolReceipt => ({
  id: `rcpt-${++receiptSeq}`, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});

describe('extractPrRepoQualifiers — qualification shapes (ticket 630fadc0)', () => {
  it('parses the github.com URL form', () => {
    const m = extractPrRepoQualifiers('see https://github.com/tenstorrent/tt-metal/pull/55747 for the bring-up');
    expect(m.get(55747)).toEqual({ owner: 'tenstorrent', repo: 'tt-metal' });
  });
  it('parses the owner/repo#n shorthand', () => {
    const m = extractPrRepoQualifiers('watching tenstorrent/tt-metal#55747');
    expect(m.get(55747)).toEqual({ owner: 'tenstorrent', repo: 'tt-metal' });
  });
  it('parses the prose owner/repo PR #n form (the watch prompt\u2019s own style)', () => {
    const m = extractPrRepoQualifiers('RECURRING WATCH: tenstorrent/tt-metal PR #55747 — catch new activity.');
    expect(m.get(55747)).toEqual({ owner: 'tenstorrent', repo: 'tt-metal' });
  });
  it('leaves a bare PR #n unqualified (legacy session-repo lane)', () => {
    expect(extractPrRepoQualifiers('Created PR #999 with the fix.').size).toBe(0);
  });
  it('first qualification wins on conflicting slugs', () => {
    const m = extractPrRepoQualifiers('acme/a PR #1 then beta/b PR #1');
    expect(m.get(1)).toEqual({ owner: 'acme', repo: 'a' });
  });
});

describe('GUARD 2 external-repo lane — incident replay + anti-phantom pins (tickets 630fadc0 / be8b6939)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidToken.mockResolvedValue('tok');
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('REPLAYS the incident: external-qualified REAL PR is NOT fabricated (the 630fadc0 false positive), create-posture without receipts still flags pr_created', async () => {
    route([
      ['repos/tenstorrent/tt-metal/pulls/55747', { status: 200, body: { state: 'open' } }],
      ['repos/tenstorrent/tt-metal', { status: 200, body: { full_name: 'tenstorrent/tt-metal' } }],
      ['repos/canada-quant/tt-rd/pulls/540', { status: 200, body: { merged: true, merge_commit_sha: 'abc123def456', merged_at: '2026-09-11T02:25:00Z' } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: [
        'Posted pointer comment 5628494459 on issue #49307 surfacing tenstorrent/tt-metal PR #55747 (created 2026-09-08, open, head 5d2f7eb9, CI green).',
        'Tracker §2026-09-11 updated; landed tt-rd main via PR #540.',
      ].join('\n'),
      parts: [],
      triggerKind: 'hook',
      now: NOW,
      receipts: [receipt('merge_pull_request', true, { prNumber: 540 }), receipt('git_push', true, {})],
      ...OPTS,
    });

    // THE BUG FIX: pre-fix this was [55747] — a REAL external PR convicted as fabricated.
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    // GUARD 1 discipline PRESERVED: a create-verb on any PR without a this-run
    // creation receipt still flags (the prompt steer removes the posture).
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
    // The qualified number verifies against the QUALIFIED repo, named in the footer.
    expect(out.finalText).toContain('PR #55747 (tenstorrent/tt-metal) — ✅ VERIFIED OPEN (create claim confirmed)');
    expect(out.finalText).toContain('PR #540 — ✅ VERIFIED MERGED');
    // 3 fetches: repo pre-check + qualified PR + session-repo PR #540.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('anti-phantom PRESERVED for qualified repos: repo exists, PR 404s in it → fabricated', async () => {
    route([
      ['repos/acme-widgets/api/pulls/7777', { status: 404 }],
      ['repos/acme-widgets/api', { status: 200, body: { full_name: 'acme-widgets/api' } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: 'Created acme-widgets/api PR #7777 with the fix.',
      parts: [],
      triggerKind: 'schedule',
      now: NOW,
      receipts: [],
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([7777]);
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(out.finalText).toContain('PR #7777 (acme-widgets/api) — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fail-open: a qualified repo the token cannot see (repo-level 404) is unavailable, NEVER fabricated', async () => {
    route([
      ['repos/acme-widgets/private-repo', { status: 404 }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: 'Created acme-widgets/private-repo PR #42 yesterday.',
      parts: [],
      triggerKind: 'schedule',
      now: NOW,
      receipts: [],
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(out.finalText).toContain('cannot adjudicate');
    // Only the repo pre-check fires — the PR fetch is skipped on an invisible repo.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('legacy lane pinned: an UNQUALIFIED phantom still verifies against the session repo and convicts', async () => {
    route([
      ['repos/canada-quant/tt-rd/pulls/999', { status: 404 }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: 'Created PR #999 with the fix.',
      parts: [],
      triggerKind: 'schedule',
      now: NOW,
      receipts: [],
      ...OPTS,
    });
    expect(out.verdict.fabricatedPrs).toEqual([999]);
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(out.finalText).toContain('PR #999 — ❌ UNVERIFIED: GitHub has NO such PR (404)');
    expect(mockFetch).toHaveBeenCalledTimes(1); // no repo pre-check on the session lane
  });

  it('a number qualified with the SESSION repo itself stays on the legacy lane (no pre-check, no repo tag)', async () => {
    route([
      ['repos/canada-quant/tt-rd/pulls/540', { status: 200, body: { merged: true, merge_commit_sha: 'abc123def456', merged_at: '2026-09-11T02:25:00Z' } }],
    ]);
    const out = await applyCompletionClaimGuard({
      finalText: 'Merged canada-quant/tt-rd PR #540.',
      parts: [],
      triggerKind: 'schedule',
      now: NOW,
      receipts: [receipt('merge_pull_request', true, { prNumber: 540 })],
      ...OPTS,
    });
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toContain('PR #540 — ✅ VERIFIED MERGED');
    expect(out.finalText).not.toContain('PR #540 (canada-quant/tt-rd)');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
