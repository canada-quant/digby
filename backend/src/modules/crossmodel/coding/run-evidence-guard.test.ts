/**
 * Tests for the phantom-fabrication evidence guard (feedback cluster be0b5271):
 * line-level completion-claim extraction (Layer 1), the zero-evidence
 * cross-check + guard note (Layer 2), GitHub PR-claim verification + footer
 * (Layer 3), and the finalize-seam orchestrator.
 *
 * Boundary-mocked: the GitHub token manager is a stub and global.fetch is
 * stubbed per case; the REAL guard module executes. Never import config/env
 * transitively here (the guard itself must stay deterministic — no prisma,
 * no LLM, no config).
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
  extractCompletionClaims, extractPrClaimKinds, extractPrNumbers, claimHasEvidence, findUnprovenClaims,
  renderEvidenceGuardNote, verifyPrClaims, renderVerificationFooter,
  applyCompletionClaimGuard, MAX_VERIFY_PRS,
  summarizeGuardVerdict, renderSuppressedFinal, renderRedactedFinal, REDACTED_CLAIM_LINE, REDACTED_CLOCK_LINE, findFutureDatedClaims, verdictHasFindings,
  findUnmatchedQuotedOutputs, renderQuotedOutputNote, toolTextsFromMessages,
  evidenceClockMs, EVIDENCE_CLOCK_MAX_LEAD_MS,
  extractDeployRunClaims, verifyDeployRunClaims, renderDeployVerificationFooter,
  extractTicketIdCitations, MAX_VERIFY_DEPLOY_RUNS,
  renderGuardRejectBackNotice, evaluateFinalCandidateForRejectBack,
} from './run-evidence-guard';
import type { GuardVerdict, CompletionClaim } from './run-evidence-guard';
import type { MessagePart } from './agent';
import type { ToolReceipt } from './run-receipts';

/** The phantom final answer, adapted from ticket 1b605132 (feedback be0b5271). */
const PHANTOM = [
  'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.',
  'Blob-verified on main: 217,530/47,189 B.',
  'Box probe 03:07:22: items.jsonl 511 lines, md5 50dd0c04.',
  'Tallies: 363 PASS / 111 TRUNC.',
  'Deploy green, health check 200.',
].join('\n');

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

/** Minimal Response stand-in for the GitHub API. */
const ghResponse = (status: number, body?: any): any => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('extractCompletionClaims', () => {
  it('THE PHANTOM REGRESSION: pr_merged(#224) + probe + benchmark + deploy all detected', () => {
    const claims = extractCompletionClaims(PHANTOM);
    const kinds = claims.map((c) => c.kind);

    expect(kinds).toContain('pr_merged');
    expect(kinds).toContain('probe');
    expect(kinds).toContain('benchmark');
    expect(kinds).toContain('deploy');

    const merge = claims.find((c) => c.kind === 'pr_merged');
    expect(merge?.prNumber).toBe(224);
    expect(merge?.text).toContain('squash-merged');

    const probe = claims.find((c) => c.kind === 'probe');
    expect(probe?.text).toContain('Box probe');

    const bench = claims.find((c) => c.kind === 'benchmark');
    expect(bench?.text).toContain('363 PASS');

    const deploy = claims.find((c) => c.kind === 'deploy');
    expect(deploy?.text).toContain('Deploy green');
  });

  it('merge verb-first ("merged PR #224") is a claim; bare mentions are not', () => {
    const claims = extractCompletionClaims('merged PR #224 after review');
    expect(claims.some((c) => c.kind === 'pr_merged' && c.prNumber === 224)).toBe(true);

    expect(extractCompletionClaims('see PR #281 for context')).toEqual([]);
    expect(extractCompletionClaims('')).toEqual([]);
  });

  it('negation WINDOW: a negation AFTER the verb does NOT suppress the claim', () => {
    // The review regression: whole-line negation let a phantom evade by
    // putting any "not" on the claim line — the window keeps this a claim.
    const claims = extractCompletionClaims('Merged PR #224, though the box probe did not pass');
    expect(claims.some((c) => c.kind === 'pr_merged' && c.prNumber === 224)).toBe(true);
  });

  it('negation WINDOW: a cue in the ~40 chars BEFORE the verb suppresses the pr claim', () => {
    expect(extractCompletionClaims('did not merge PR #224')
      .filter((c) => c.kind.startsWith('pr_'))).toEqual([]);
    expect(extractCompletionClaims('PR #224 is still open — merge failed')
      .filter((c) => c.kind === 'pr_merged')).toEqual([]);
    expect(extractCompletionClaims('could not merge PR #5 — CI red')
      .filter((c) => c.kind.startsWith('pr_'))).toEqual([]);
    expect(extractCompletionClaims("PR #9 was never merged; didn't get review")
      .filter((c) => c.kind === 'pr_merged')).toEqual([]);
    expect(extractCompletionClaims('PR #7 was not closed')
      .filter((c) => c.kind === 'pr_closed')).toEqual([]);
  });

  it('negation WINDOW applies to deploy/probe evidence keywords too', () => {
    expect(extractCompletionClaims('deploy is not live yet')
      .filter((c) => c.kind === 'deploy')).toEqual([]);
    expect(extractCompletionClaims('I could not deploy — pipeline red')
      .filter((c) => c.kind === 'deploy')).toEqual([]);
    expect(extractCompletionClaims('probe found nothing active')
      .filter((c) => c.kind === 'probe')).toEqual([]);
    // …while the honest POSITIVE probe report is still a claim.
    expect(extractCompletionClaims('Box probe 03:07:22 PDT: wd active, HTTP 200')
      .some((c) => c.kind === 'probe')).toBe(true);
  });

  it('pr_created / pr_closed detected with their numbers', () => {
    const claims = extractCompletionClaims('Opened PR #300 with the fix.\nClosed PR #299 as superseded.');
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pr_created', prNumber: 300 }),
      expect.objectContaining({ kind: 'pr_closed', prNumber: 299 }),
    ]));
  });

  it('NO bare-merge false positives: conflict/future/conditional phrasing is not a claim', () => {
    // Review round-2 blockers: bare "merge" matched honest plan/conflict lines.
    expect(extractCompletionClaims('Fixed the merge conflict in PR #224')
      .filter((c) => c.kind.startsWith('pr_'))).toEqual([]);
    expect(extractCompletionClaims('Next step: merge PR #224 once CI passes')
      .filter((c) => c.kind.startsWith('pr_'))).toEqual([]);
    expect(extractCompletionClaims('when you merge PR #224, watch the migrations')
      .filter((c) => c.kind.startsWith('pr_'))).toEqual([]);
  });

  it('CLAUSE association: "did not merge PR #224; merged PR #225 instead" claims #225 ONLY', () => {
    // Review round-2 blocker: first-verb-only negation let the #225 merge evade.
    const claims = extractCompletionClaims('did not merge PR #224; merged PR #225 instead');
    expect(claims.filter((c) => c.kind === 'pr_merged').map((c) => c.prNumber)).toEqual([225]);
    expect(extractPrNumbers('did not merge PR #224; merged PR #225 instead')).toEqual([225]);
  });

  it('CLAUSE-CUT negation: a cue in an EARLIER clause does not suppress a later claim', () => {
    expect(extractCompletionClaims('did not deploy; the box probe is active')
      .some((c) => c.kind === 'probe')).toBe(true);
    // …and the negated clause itself still yields nothing.
    expect(extractCompletionClaims('did not deploy; the box probe is active')
      .filter((c) => c.kind === 'deploy')).toEqual([]);
  });

  it('comma stays associative: "Merged PR #5, superseding PR #4" tags BOTH numbers', () => {
    const kinds = extractPrClaimKinds('Merged PR #5, superseding PR #4.');
    expect(kinds.get(5)).toEqual(new Set(['pr_merged']));
    expect(kinds.get(4)).toEqual(new Set(['pr_merged']));
  });

  // ── commit_pushed (ticket b8fa321a — "commits 1539fa86/42f4a4a2 live on
  //    origin/main" named no PR and no deploy keyword, so it evaded the guard)
  it('THE b8fa321a REGRESSION: bare shas + "live on origin/main" claim commit_pushed per sha', () => {
    const claims = extractCompletionClaims('Superset re-export commits 1539fa86/42f4a4a2 are live on origin/main (15,643 records).');
    const commits = claims.filter((c) => c.kind === 'commit_pushed');
    expect(commits.map((c) => c.sha)).toEqual(['1539fa86', '42f4a4a2']);
    expect(commits[0].text).toContain('live on origin/main');
  });

  it('pushed/landed verbs claim; bare "push" (future/failed phrasing) does not', () => {
    expect(extractCompletionClaims('Pushed 84fe3ae0 to origin.')
      .some((c) => c.kind === 'commit_pushed' && c.sha === '84fe3ae0')).toBe(true);
    expect(extractCompletionClaims('Landed abc12345 on main.')
      .some((c) => c.kind === 'commit_pushed')).toBe(true);
    expect(extractCompletionClaims('Next step: push 84fe3ae0 once CI passes.')
      .filter((c) => c.kind === 'commit_pushed')).toEqual([]);
    expect(extractCompletionClaims('The push failed for 84fe3ae0 — remote rejected.')
      .filter((c) => c.kind === 'commit_pushed')).toEqual([]);
  });

  it('commit negation: windowed cue suppresses; clause association claims the clean sha only', () => {
    expect(extractCompletionClaims('did not push 1539fa86')
      .filter((c) => c.kind === 'commit_pushed')).toEqual([]);
    const claims = extractCompletionClaims('did not push 1539fa86; pushed 42f4a4a2 instead');
    expect(claims.filter((c) => c.kind === 'commit_pushed').map((c) => c.sha)).toEqual(['42f4a4a2']);
  });

  it('sha shape guard: hex-alphabet WORDS and plain NUMBERS near a push verb claim nothing', () => {
    // "acceded" is 7 chars of pure [a-f] — a letter-only token is not a sha.
    expect(extractCompletionClaims('The team acceded and pushed back on the plan.')
      .filter((c) => c.kind === 'commit_pushed')).toEqual([]);
    // All-digit tokens (counts, timestamps) are not shas either.
    expect(extractCompletionClaims('Pushed 1234567 records to the warehouse.')
      .filter((c) => c.kind === 'commit_pushed')).toEqual([]);
  });

  it('one commit_pushed claim per sha per line (no double-count across clauses)', () => {
    const claims = extractCompletionClaims('Pushed 84fe3ae0; 84fe3ae0 is live on origin now.');
    expect(claims.filter((c) => c.kind === 'commit_pushed')).toHaveLength(1);
  });

  it('a PR-merge line with a merge sha stays pr_merged only (no push verb)', () => {
    const claims = extractCompletionClaims('PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.');
    expect(claims.some((c) => c.kind === 'pr_merged' && c.prNumber === 224)).toBe(true);
    expect(claims.filter((c) => c.kind === 'commit_pushed')).toEqual([]);
  });
});

describe('extractPrNumbers', () => {
  it('collects numbers from pr_* claim lines only, deduped and order-preserving', () => {
    const text = [
      'Merged PR #5. Opened PR #7.',
      'see PR #9 for context', // no claim on this line → not verified
      'Closed PR #5 after the revert.',
    ].join('\n');
    expect(extractPrNumbers(text)).toEqual([5, 7]);
  });

  it('caps at MAX_VERIFY_PRS', () => {
    const text = [10, 11, 12, 13, 14, 15, 16].map((n) => `merged PR #${n}`).join('\n');
    expect(extractPrNumbers(text)).toEqual([10, 11, 12, 13, 14]);
    expect(MAX_VERIFY_PRS).toBe(5);
  });
});

describe('extractPrClaimKinds', () => {
  it('a number inherits the kinds of EVERY claim line it appears on; non-pr kinds + bare mentions excluded', () => {
    const text = [
      'Opened PR #300 with the fix.',
      'Merged PR #224, superseding PR #299.',
      'Closed PR #299 as superseded.',
      'Deploy green, health check 200.', // deploy claim — not a pr kind
      'see PR #281 for context', // no claim on this line → no entry
    ].join('\n');
    const kinds = extractPrClaimKinds(text);
    expect(kinds.get(300)).toEqual(new Set(['pr_created']));
    expect(kinds.get(224)).toEqual(new Set(['pr_merged']));
    expect(kinds.get(299)).toEqual(new Set(['pr_merged', 'pr_closed']));
    expect(kinds.has(281)).toBe(false);
    // extractPrNumbers delegates: same numbers, same first-appearance order.
    expect(extractPrNumbers(text)).toEqual([300, 224, 299]);
  });
});

describe('findUnprovenClaims / claimHasEvidence', () => {
  it('zero parts → the claims are unproven (the phantom signature)', () => {
    const claims = extractCompletionClaims(PHANTOM);
    expect(findUnprovenClaims(PHANTOM, [])).toEqual(claims);
  });

  it('only non-evidence tools (update_plan / search_memory) → still unproven', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', name: 'update_plan', args: {} },
      { type: 'tool_call', name: 'search_memory', args: { q: 'pr 224' } },
      { type: 'text', text: PHANTOM },
    ];
    expect(findUnprovenClaims(PHANTOM, parts).length).toBeGreaterThan(0);
  });

  it('ONE evidence-bearing tool_call (run_command) → proven', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', name: 'run_command', args: { command: 'gh pr view 224' } },
      { type: 'text', text: PHANTOM },
    ];
    const claim = extractCompletionClaims(PHANTOM)[0];
    expect(claimHasEvidence(claim, parts)).toBe(true);
    expect(findUnprovenClaims(PHANTOM, parts)).toEqual([]);
  });

  it('EVIDENCE TIERS: a local read (read_file) does NOT evidence a pr_merged claim → UNPROVEN', () => {
    // The resumed-phantom hole: re-reading local files is not a merge.
    const parts: MessagePart[] = [{ type: 'tool_call', name: 'read_file', args: { path: 'x.ts' } }];
    const unproven = findUnprovenClaims('Merged PR #224 after review.', parts);
    expect(unproven.map((c) => c.kind)).toEqual(['pr_merged']);
  });

  it('EVIDENCE TIERS: the same local read DOES evidence a benchmark tally', () => {
    const parts: MessagePart[] = [{ type: 'tool_call', name: 'read_file', args: { path: 'x.ts' } }];
    expect(findUnprovenClaims('Tallies: 363 PASS / 111 TRUNC.', parts)).toEqual([]);
  });

  it('EVIDENCE TIERS: delegate evidences EVERY kind (subagents have real tools)', () => {
    const parts: MessagePart[] = [{ type: 'tool_call', name: 'delegate', args: { role: 'coder', task: 'merge' } }];
    expect(findUnprovenClaims('Merged PR #224 after review.', parts)).toEqual([]);
    expect(findUnprovenClaims(PHANTOM, parts)).toEqual([]);
  });

  it('EVIDENCE TIERS: update_plan evidences NOTHING — the probe claim stays unproven', () => {
    const parts: MessagePart[] = [{ type: 'tool_call', name: 'update_plan', args: {} }];
    const unproven = findUnprovenClaims('Box probe 03:07:22 PDT: wd active, HTTP 200', parts);
    expect(unproven.map((c) => c.kind)).toEqual(['probe']);
  });

  it('EVIDENCE TIERS: per-claim filtering — mixed evidence leaves ONLY the unproven kinds', () => {
    // run_command satisfies everything; read_file satisfies probe/benchmark…
    const parts: MessagePart[] = [{ type: 'tool_call', name: 'read_file', args: {} }];
    const unproven = findUnprovenClaims(PHANTOM, parts);
    // …so the pr_merged/deploy claims are exposed, probe/benchmark pass.
    // ("Plan 6/6 — CLOSED." is a plan-status marker, NOT a PR-close claim —
    // clause association keeps it off #224.)
    expect(unproven.map((c) => c.kind).sort()).toEqual(['deploy', 'pr_merged']);
  });

  it('EVIDENCE TIERS: commit_pushed demands an EXTERNAL-ACTION tool — local reads do not count', () => {
    const text = 'Commits 1539fa86/42f4a4a2 are live on origin/main.';
    expect(findUnprovenClaims(text, [{ type: 'tool_call', name: 'read_file', args: {} }])
      .map((c) => c.kind)).toEqual(['commit_pushed', 'commit_pushed']);
    expect(findUnprovenClaims(text, [{ type: 'tool_call', name: 'run_command', args: { command: 'git push' } }])).toEqual([]);
    expect(findUnprovenClaims(text, [{ type: 'tool_call', name: 'delegate', args: {} }])).toEqual([]);
  });
});

describe('renderEvidenceGuardNote', () => {
  it('contains the guard banner, triggerKind, zero-evidence framing, UNVERIFIED, and per-kind counts', () => {
    const note = renderEvidenceGuardNote(extractCompletionClaims(PHANTOM), { triggerKind: 'schedule', resumed: true });

    expect(note).toContain('HARNESS EVIDENCE GUARD');
    expect(note).toContain('schedule');
    expect(note).toContain('zero evidence-bearing tool calls');
    expect(note).toContain('NO FRESH EVIDENCE this turn');
    expect(note).toContain('UNVERIFIED');
    expect(note).toContain('pr_merged: 1');
    expect(note).toContain('probe: 1');
    expect(note).toContain('benchmark: 1');
    expect(note).toContain('deploy: 1');
  });
});

describe('verifyPrClaims', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

  it('(a) merged PR → merged + real sha + mergedAt; Authorization header sent', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, merge_commit_sha: 'abc123def4567890', merged_at: '2026-08-20T04:19:21Z',
    }));
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [224] });

    expect(vs).toEqual([{
      number: 224, state: 'merged', mergeCommitSha: 'abc123def4567890', mergedAt: '2026-08-20T04:19:21Z',
    }]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/224');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['User-Agent']).toBe('digby-evidence-guard');
    expect(mockGetValidToken).toHaveBeenCalledWith('u1', undefined);
  });

  it('(b) open PR → open', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    expect(await verifyPrClaims({ ...OPTS, prNumbers: [224] })).toEqual([{ number: 224, state: 'open' }]);
  });

  it('(b2) claimKinds ride through onto each PrVerification (per-kind footer input)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const claimKinds = new Map<number, Set<any>>([[300, new Set(['pr_created'])]]);
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [300], claimKinds });
    expect(vs).toEqual([{ number: 300, state: 'open', claimKinds: ['pr_created'] }]);
  });

  it('(c) 404 → missing', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [224] });
    expect(vs[0].state).toBe('missing');
  });

  it('(d) fetch rejects → unavailable, never throws', async () => {
    mockFetch.mockRejectedValue(new Error('socket hang up'));
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [224] });
    expect(vs[0].state).toBe('unavailable');
    expect(vs[0].reason).toContain('socket hang up');
  });

  it('(e) no stored token → unavailable (no GitHub token), fetch never called', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [224] });
    expect(vs).toEqual([{ number: 224, state: 'unavailable', reason: 'no GitHub token' }]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('(f) 7 PR numbers → only 5 fetched', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const vs = await verifyPrClaims({ ...OPTS, prNumbers: [1, 2, 3, 4, 5, 6, 7] });
    expect(vs.map((v) => v.number)).toEqual([1, 2, 3, 4, 5]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("(g) provider 'blank' → unavailable (no GitHub repo), fetch never called", async () => {
    const vs = await verifyPrClaims({ ...OPTS, provider: 'blank', prNumbers: [224] });
    expect(vs).toEqual([{ number: 224, state: 'unavailable', reason: 'no GitHub repo' }]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it('unparseable / missing repoUrl → unavailable (no GitHub repo); ssh + bare slugs parse', async () => {
    expect((await verifyPrClaims({ ...OPTS, repoUrl: null, prNumbers: [1] }))[0].reason).toBe('no GitHub repo');
    expect((await verifyPrClaims({ ...OPTS, repoUrl: 'not-a-url', prNumbers: [1] }))[0].reason).toBe('no GitHub repo');
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'closed' }));
    await verifyPrClaims({ ...OPTS, repoUrl: 'git@github.com:o/r2.git', prNumbers: [1] });
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r2/pulls/1');
    await verifyPrClaims({ ...OPTS, repoUrl: 'o/r3', prNumbers: [2] });
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.github.com/repos/o/r3/pulls/2');
  });

  it('honours the githubLabel when loading the token', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    await verifyPrClaims({ ...OPTS, githubLabel: 'work', prNumbers: [1] });
    expect(mockGetValidToken).toHaveBeenCalledWith('u1', 'work');
  });
});

describe('renderVerificationFooter', () => {
  const NOW = new Date('2026-08-20T23:30:00.000Z');

  it('PER-KIND verdicts: create+open → ✅ VERIFIED OPEN; close+closed-unmerged → ✅ VERIFIED CLOSED', () => {
    // The review regressions: an honest "Opened PR #300" / "Closed PR #299 as
    // superseded" used to be flagged ❌ under the merge-only templates.
    const out = renderVerificationFooter([
      { number: 300, state: 'open', claimKinds: ['pr_created'] },
      { number: 299, state: 'closed', claimKinds: ['pr_closed'] },
    ], NOW);

    expect(out).toContain('• PR #300 — ✅ VERIFIED OPEN (create claim confirmed)');
    expect(out).toContain('• PR #299 — ✅ VERIFIED CLOSED (close claim confirmed; not merged)');
    expect(out).not.toContain('❌');
  });

  it('PER-KIND verdicts: merge+open → ❌ still OPEN; merge+closed → ❌ CLOSED but NOT merged; create+missing → ❌ fabricated', () => {
    const out = renderVerificationFooter([
      { number: 224, state: 'open', claimKinds: ['pr_merged'] },
      { number: 5, state: 'closed', claimKinds: ['pr_merged'] },
      { number: 301, state: 'missing', claimKinds: ['pr_created'] },
    ], NOW);

    expect(out).toContain('• PR #224 — ❌ UNVERIFIED merge claim: GitHub says this PR is still OPEN');
    expect(out).toContain('• PR #5 — ❌ UNVERIFIED: PR is CLOSED but NOT merged');
    expect(out).toContain('• PR #301 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated');
  });

  it('mixed kinds on ONE number (created+merged claims, GitHub merged) → a single ✅ merged receipt line', () => {
    const out = renderVerificationFooter([
      {
        number: 281, state: 'merged', claimKinds: ['pr_created', 'pr_merged'],
        mergeCommitSha: '0b8d237e1234567890', mergedAt: '2026-08-20T20:00:00Z',
      },
    ], NOW);

    const pr281Lines = out.split('\n').filter((l) => l.includes('PR #281'));
    expect(pr281Lines).toHaveLength(1);
    expect(pr281Lines[0]).toBe('• PR #281 — ✅ VERIFIED MERGED on GitHub: sha 0b8d237e1234…, merged_at 2026-08-20T20:00:00Z');
  });

  it('mixed kinds with a MISMATCH → the strongest (merge) ❌ wins over a matching kind', () => {
    const out = renderVerificationFooter([
      { number: 44, state: 'open', claimKinds: ['pr_created', 'pr_merged'] },
    ], NOW);

    const lines = out.split('\n').filter((l) => l.includes('PR #44'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('• PR #44 — ❌ UNVERIFIED merge claim: GitHub says this PR is still OPEN');
  });

  it('the rest of the per-kind matrix: close+open ❌; create+closed ✅ exists; create+merged ✅ in-fact-MERGED; close+merged ✅ CLOSED (merged)', () => {
    const out = renderVerificationFooter([
      { number: 10, state: 'open', claimKinds: ['pr_closed'] },
      { number: 11, state: 'closed', claimKinds: ['pr_created'] },
      { number: 12, state: 'merged', claimKinds: ['pr_created'], mergeCommitSha: 'abc123def4567890', mergedAt: '2026-08-20T20:00:00Z' },
      { number: 13, state: 'merged', claimKinds: ['pr_closed'], mergeCommitSha: 'abc123def4567890', mergedAt: '2026-08-20T20:00:00Z' },
    ], NOW);

    expect(out).toContain('• PR #10 — ❌ UNVERIFIED close claim: GitHub says this PR is still OPEN');
    expect(out).toContain('• PR #11 — ✅ VERIFIED — PR exists (closed, not merged)');
    expect(out).toContain('• PR #12 — ✅ VERIFIED — PR exists and is in fact MERGED (sha abc123def456…, merged_at 2026-08-20T20:00:00Z)');
    expect(out).toContain('• PR #13 — ✅ VERIFIED CLOSED (merged)');
  });

  it('no claimKinds → legacy merge-claim reading; unavailable → ⚠︎ treat as unverified', () => {
    const out = renderVerificationFooter([
      { number: 281, state: 'merged', mergeCommitSha: '0b8d237e1234567890', mergedAt: '2026-08-20T20:00:00Z' },
      { number: 224, state: 'open' },
      { number: 999, state: 'missing' },
      { number: 7, state: 'unavailable', reason: 'no GitHub token' },
    ], NOW);

    expect(out).toContain('---');
    expect(out).toContain('🔍 Harness claim verification (verified-at 2026-08-20T23:30:00.000Z):');
    expect(out).toContain('• PR #281 — ✅ VERIFIED MERGED on GitHub: sha 0b8d237e1234…, merged_at 2026-08-20T20:00:00Z');
    expect(out).toContain('• PR #224 — ❌ UNVERIFIED merge claim: GitHub says this PR is still OPEN');
    expect(out).toContain('• PR #999 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated');
    expect(out).toContain('• PR #7 — ⚠︎ could not be verified (no GitHub token) — treat the claim as unverified');
  });
});

describe('applyCompletionClaimGuard', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');

  it('FULL PHANTOM SCENARIO: schedule run, zero parts, PR 404 → guard note AND fabricated-claim footer, original preserved', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: PHANTOM, parts: [], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
    });

    // Original text preserved ABOVE the annotations.
    expect(out.finalText.startsWith(PHANTOM)).toBe(true);
    // Guard-1 note (machine trigger + zero evidence)…
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    expect(out.finalText).toContain('zero evidence-bearing tool calls');
    expect(out.finalText).toContain('NO FRESH EVIDENCE this turn');
    // …then the guard-2 footer exposing the fabricated merge.
    expect(out.finalText).toContain('❌ UNVERIFIED');
    expect(out.finalText).toContain('NO such PR (404)');
    expect(out.finalText).toContain('fabricated');
    expect(out.finalText.indexOf('HARNESS EVIDENCE GUARD')).toBeLessThan(out.finalText.indexOf('Harness claim verification'));
    // audit 2026-10-06 T7-6: the pr_merged conviction waits for the PR API — PR
    // #224 404s, so it still convicts, in a second guard note AFTER the footer.
    expect(out.notes).toHaveLength(3);
    expect(out.notes[2]).toContain('(pr_merged: 1)');
    expect(out.finalText.lastIndexOf('HARNESS EVIDENCE GUARD]')).toBeGreaterThan(out.finalText.indexOf('Harness claim verification'));
    expect(out.verdict.unprovenKinds).toEqual(['pr_merged', 'probe', 'benchmark', 'deploy']); // appearance order kept
  });

  it('returns a MACHINE-VERIFIABLE verdict: unproven kinds + fabricated PRs + refuted merges (two-lane hardening)', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: PHANTOM, parts: [], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
    });
    expect(out.verdict.unprovenKinds.length).toBeGreaterThan(0);
    expect(out.verdict.fabricatedPrs).toContain(224);
    // refuted merge: GitHub says the claimed-merged PR is still open
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const refuted = await applyCompletionClaimGuard({
      finalText: 'Merged PR #44 after green CI.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'hook', now: NOW, ...OPTS,
    });
    expect(refuted.verdict.refutedMergePrs).toEqual([44]);
    expect(refuted.verdict.unprovenKinds).toEqual([]); // evidence-bearing tool call present
    // clean run → empty verdict
    const clean = await applyCompletionClaimGuard({
      finalText: 'Scheduled wake: reviewed the plan, nothing actionable this turn.',
      parts: [], triggerKind: 'machine', now: NOW, ...OPTS,
    });
    expect(clean.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
  });

  it('GUARD 3 (ticket 8e814f45): future-dated merge claim flags even with evidence-tier tools AND a GitHub-verified PR', async () => {
    // The #31/#32 bypass class: the run DID make an external-action call (so
    // guard 1 stays silent) and the PR is REAL and merged (so guard 2 stays
    // silent) — but the claimed merged_at is later than the run's wall clock.
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, merge_commit_sha: '9f3cc5c81234567890', merged_at: '2026-08-22T18:23:33Z',
    }));
    const out = await applyCompletionClaimGuard({
      finalText: 'PR #253 squash-merged at 2026-08-22T18:23:33Z, sha 9f3cc5c8.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} } as any],
      triggerKind: 'schedule', now: new Date('2026-08-22T18:10:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]); // guard 1 silent (run_command evidences pr_merged)
    expect(out.verdict.futureDated).toHaveLength(1);
    expect(out.verdict.futureDated[0]).toContain('2026-08-22T18:23:33Z');
    expect(out.verdict.futureDated[0]).toMatch(/\(\+\d+m ahead\)/);
    expect(verdictHasFindings(out.verdict)).toBe(true); // futureDated ALONE is a finding
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS');
    expect(out.finalText).toContain('cannot be dated in the future');
  });

  it('GUARD 3: same claim with a past merged_at produces NO future-dated finding', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, merge_commit_sha: '9f3cc5c81234567890', merged_at: '2026-08-22T17:58:33Z',
    }));
    const out = await applyCompletionClaimGuard({
      finalText: 'PR #253 squash-merged at 2026-08-22T17:58:33Z, sha 9f3cc5c8.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} } as any],
      triggerKind: 'schedule', now: new Date('2026-08-22T18:10:00.000Z'), ...OPTS,
    });
    expect(out.verdict.futureDated).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('clean run: user trigger + evidence + a REAL merged PR → footer receipt, NO guard-1 note', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, merge_commit_sha: '0b8d237e1234567890', merged_at: '2026-08-20T20:00:00Z',
    }));
    const text = 'Merged PR #281, sha 0b8d237e';
    const out = await applyCompletionClaimGuard({
      finalText: text,
      parts: [{ type: 'tool_call', name: 'run_command', args: { command: 'gh pr merge 281' } }],
      triggerKind: 'user', now: NOW, ...OPTS,
    });

    expect(out.finalText).toContain('✅ VERIFIED MERGED');
    expect(out.finalText).toContain('sha 0b8d237e1234…');
    expect(out.finalText).not.toContain('HARNESS EVIDENCE GUARD');
    expect(out.notes).toHaveLength(1);
  });

  it('machine run with zero tools and NO claims → finalText identical, notes empty, no fetch', async () => {
    const text = 'Scheduled wake: reviewed the plan, nothing actionable this turn.';
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'machine', now: NOW, ...OPTS,
    });
    expect(out.finalText).toBe(text);
    expect(out.notes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('machine trigger WITH evidence → no guard-1 note, but the footer still lands (all triggers)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'Merged PR #44 after green CI.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'hook', now: NOW, ...OPTS,
    });
    expect(out.finalText).not.toContain('HARNESS EVIDENCE GUARD');
    expect(out.finalText).toContain('still OPEN'); // footer caught the false merge claim
    expect(out.notes).toHaveLength(1);
  });

  it('unproven commit claims reach the verdict + the guard note + the commits-API re-query (ticket b8fa321a plumbing, guard-2b lane)', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: 'Commits 1539fa86/42f4a4a2 are live on origin/main (15,643 records).',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    expect(out.finalText).toContain('commit_pushed: 2');
    // Guard 2b: no PR numbers, but the two claimed shas ARE re-queried — and 404.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('/commits/1539fa86'),
      expect.stringContaining('/commits/42f4a4a2'),
    ]);
    expect(out.verdict.fabricatedShas).toEqual(['1539fa86', '42f4a4a2']);
    expect(out.finalText).toContain('Harness push-claim verification');
  });
});

// ── Receipt-based claim resolution (run-receipts wiring) + the forgery layer ─

describe('applyCompletionClaimGuard — receipts provided (claim→receipt resolution)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');

  const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, n = 1): ToolReceipt => ({
    id: `r${n}`, chatId: 'c1', runId: 'run1', tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: NOW,
  });

  it('claims matching receipt ids → NO unprovenKinds (the receipts exonerate, parts are irrelevant)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { sha: 'x' })); // guard 2b confirms the receipt shas on origin
    // Finding A1 (2026-09-27): the exonerating receipt must be a git_push (the
    // sha reached origin) — a git_commit receipt is LOCAL and no longer
    // exonerates "live on origin" (the canlaw 710-commits / 1-push hole).
    const out = await applyCompletionClaimGuard({
      finalText: 'Commits 1539fa86/42f4a4a2 are live on origin/main.',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_push', true, { branch: 'main', sha: '1539fa86' }), receipt('git_push', true, { branch: 'main', sha: '42f4a4a2' }, 2)],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.finalText).not.toContain('NO FRESH EVIDENCE');
    // Guard 2b: the claim shas (also receipt-carried) are re-queried and confirmed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(out.finalText).toContain('EXISTS on origin');
    expect(out.verdict.fabricatedShas ?? []).toEqual([]);
  });

  it('an EMPTY receipt set convicts: zero-evidence claims are unproven (no legacy parts fallback)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Commits 1539fa86/42f4a4a2 are live on origin/main.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} } as any], // would exonerate under the legacy path
      triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
  });

  it('the hole-fix pin: an ok:false push receipt does NOT evidence a push claim; an ok one does', async () => {
    const text = 'Pushed 84fe3ae0 to origin.';
    const failed = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_push', false)],
    });
    expect(failed.verdict.unprovenKinds).toEqual(['commit_pushed']);

    const pushed = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_push', true, { branch: 'main' })],
    });
    expect(pushed.verdict.unprovenKinds).toEqual([]);
  });

  it('legacy path pinned UNCHANGED when receipts is absent: a bare run_command tool_call still exonerates (name-only)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });
});

describe('applyCompletionClaimGuard — FORGERY layer (harness-only markers in the answer)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');

  it.each([
    ['verification-footer header', '🔍 Harness claim verification (verified-at 2026-08-24T00:00:00.000Z):'],
    ['replacement banner', "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]"],
    ['audit-quote fence', '--- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---'],
  ])('a forged %s → forgedFooter + note, even with NO extractable claims (user trigger too)', async (_label, marker) => {
    const text = `All quiet this sweep.\n\n${marker}`;
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'user', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(verdictHasFindings(out.verdict)).toBe(true); // forgery ALONE is a finding
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER');
    expect(out.notes.some((n) => n.includes('FORGED HARNESS MARKER'))).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the BARE [HARNESS EVIDENCE GUARD] prefix is NOT forgery (legit inside quoted journal strings)', async () => {
    const text = 'Reviewed the journal: "[HARNESS EVIDENCE GUARD] zero evidence-bearing tool calls" — noted, nothing actionable.';
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'machine', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBeFalsy();
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(text); // untouched
  });
});

describe('applyCompletionClaimGuard — receipt-id citation pinpoint (citable receipt ids follow-up)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');
  const KNOWN_ID = '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd';

  // A receipt the harness actually wrote this run (uuid id, as the seam
  // generates). ids carry NO prNumber — so receiptMatchesClaim CANNOT
  // exonerate a pr_created claim from it; only the citation lane can.
  const citedReceipt = (tool = 'run_command'): ToolReceipt => ({
    id: KNOWN_ID, chatId: 'c1', runId: 'run1', tool, ok: true, ids: {},
    inputHash: null, outputHash: null, createdAt: NOW,
  });

  it('a cited KNOWN receipt id counts as explicit evidence for claims on the citing line — CONTENT-BOUND since P4 v1#24: the claim token must appear in the run\'s tool output', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' })); // guard 2 still runs
    const out = await applyCompletionClaimGuard({
      finalText: `Opened PR #300 with the fix (receipt ${KNOWN_ID}).`,
      parts: [{ type: 'tool_result', name: 'run_command', result: 'https://github.com/o/r/pull/300' } as any],
      triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [citedReceipt()],
    });
    expect(out.verdict.unprovenKinds).toEqual([]); // citation + output-bound token exonerated, not the receipt's ids
    expect(out.verdict.forgedFooter).toBeFalsy();
    expect(out.finalText).toContain('✅ VERIFIED OPEN'); // real GitHub receipt still lands
  });

  it('P4 v1#24: the same citation with the claim token in NO tool output no longer exonerates (content binding)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({
      finalText: `Opened PR #300 with the fix (receipt ${KNOWN_ID}).`,
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [citedReceipt()],
    });
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']); // the ok receipt on the line proves nothing about #300
  });

  it('a cited receipt id ABSENT from the harness set → forgedFooter conviction (forged citation)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'Opened PR #300 with the fix (receipt 9c8b7a6d-1111-2222-3333-444455556666).',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [citedReceipt()],
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FORGED RECEIPT CITATION');
    expect(out.finalText).toContain('9c8b7a6d-1111-2222-3333-444455556666');
    // …and the claim itself is still unproven (the forged citation evidences NOTHING).
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
  });

  it('a citation-shaped mention is INERT when receipts are absent (legacy lane never resolves citations)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({
      finalText: `Opened PR #300 with the fix (receipt ${KNOWN_ID}).`,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }], // legacy name-tier evidence
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBeFalsy();
    expect(out.verdict.unprovenKinds).toEqual([]); // legacy lane, unchanged
  });

  it('a PREFIX citation ("receipt 3f09a1bc") is ignored entirely — never half-matched either way', async () => {
    mockFetch.mockResolvedValue(ghResponse(404)); // guard 2b re-queries the line's shas — unrelated to the citation lane
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin (receipt 3f09a1bc).',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [citedReceipt('verify')], // non-external tool: no coarse-tier exoneration
    });
    expect(out.verdict.forgedFooter).toBeFalsy(); // not a full-uuid citation → not a forgery
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']); // …and not evidence either
  });
});

describe('applyCompletionClaimGuard — GUARD 2b: push-claim primary-source re-query (commits API)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');
  const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, n = 1): ToolReceipt => ({
    id: `r${n}`, chatId: 'c1', runId: 'run1', tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: NOW,
  });

  it('a claimed sha that EXISTS on origin → footer exoneration, no fabricatedShas (guard-1 unproven lane is independent)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { sha: '84fe3ae0cafe' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/commits/84fe3ae0');
    expect(out.finalText).toContain('Harness push-claim verification (commits API)');
    expect(out.finalText).toContain('✅ EXISTS on origin');
    expect(out.verdict.fabricatedShas ?? []).toEqual([]);
    // Guard-1 semantics preserved: zero in-run evidence still convicts guard 1 —
    // the footer is the exoneration lane (same as a VERIFIED MERGED PR footer).
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
  });

  it('a claimed sha that 404s → fabricatedShas conviction + ❌ footer (the model cannot conjure a sha INTO the repo)', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [],
    });
    expect(out.verdict.fabricatedShas).toEqual(['84fe3ae0']);
    expect(out.finalText).toContain('❌ UNVERIFIED: no such commit on origin (404) — the push claim is fabricated');
    expect(verdictHasFindings(out.verdict)).toBe(true); // fabricatedShas alone is a finding
  });

  it('a receipt-sourced sha gets CONFIRMED (present) or a soft caution (404) — never a fabrication conviction', async () => {
    // Receipt-ONLY sha (the claim text never cites it) → receipt lane rendering.
    mockFetch.mockResolvedValue(ghResponse(200, { sha: 'x' }));
    const confirmed = await applyCompletionClaimGuard({
      finalText: 'Deploy green, health check 200.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_push', true, { branch: 'main', sha: 'deadbeef99' })],
    });
    expect(confirmed.finalText).toContain('(harness receipt confirmed)');
    expect(confirmed.verdict.fabricatedShas).toBeUndefined();

    // A sha cited by BOTH the claim text and a receipt is CLAIM-sourced (claims
    // win dedup priority — the 404 must convict the model's claim)…
    mockFetch.mockResolvedValue(ghResponse(404));
    const amended = await applyCompletionClaimGuard({
      finalText: 'Commits 1539fa86 are live on origin/main.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_commit', true, { sha: '1539fa86' })],
    });
    expect(amended.verdict.fabricatedShas).toEqual(['1539fa86']);

    // …but a receipt-only sha that 404s is NOT a fabrication: amended history.
    mockFetch.mockResolvedValue(ghResponse(404));
    const receiptOnly = await applyCompletionClaimGuard({
      finalText: 'Deploy green, health check 200.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('git_push', true, { branch: 'main', sha: 'deadbeef99' }, 2)],
    });
    expect(receiptOnly.finalText).toContain('amended/force-pushed history?');
    expect(receiptOnly.verdict.fabricatedShas ?? []).toEqual([]);
  });

  it('fetch THROWS → the lane stays silent: no footer, no verdict fields touched', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [],
    });
    expect(out.finalText).not.toContain('push-claim verification');
    expect(out.verdict.fabricatedShas).toBeUndefined();
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']); // guard 1 unchanged
  });

  it('non-GitHub provider / no repo slug → silent (no fetch at all)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Pushed 84fe3ae0 to origin.', parts: [], triggerKind: 'schedule', now: NOW,
      userId: 'u1', repoUrl: null, provider: 'blank', receipts: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out.finalText).not.toContain('push-claim verification');
  });
});

// ── Annotate→REPLACE escalation (ticket be199e93) ───────────────────────────

describe('summarizeGuardVerdict', () => {
  it('renders each finding lane, joined with semicolons', () => {
    const line = summarizeGuardVerdict({
      unprovenKinds: ['pr_merged', 'commit_pushed'],
      fabricatedPrs: [237, 246],
      refutedMergePrs: [44],
      futureDated: ['2026-08-22T18:23:33Z (+13m ahead)'],
    });
    expect(line).toBe(
      'zero-evidence completion claims: pr_merged, commit_pushed; '
      + 'fabricated PR claims (GitHub 404): #237, #246; '
      + 'merge claims refuted by GitHub (PR not merged): #44; '
      + 'future-dated observation claims: 2026-08-22T18:23:33Z (+13m ahead)',
    );
    expect(summarizeGuardVerdict({ unprovenKinds: [], fabricatedPrs: [9], refutedMergePrs: [], futureDated: [] }))
      .toBe('fabricated PR claims (GitHub 404): #9');
  });

  it('includes the forged-footer lane (and it alone is a finding)', () => {
    expect(summarizeGuardVerdict({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], forgedFooter: true }))
      .toContain('forged harness markers');
    expect(verdictHasFindings({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], forgedFooter: true })).toBe(true);
  });
});

// ── Future-dated claim detection (ticket 8e814f45) ──────────────────────────

// ── 2026-09-08 audit (a8976e11 firing-87 draft B, verbatim shapes) ─────────
describe('extractCompletionClaims — receipt-mimicry shapes from the 2026-09-08 fabrications', () => {
  const NOW_REDO = new Date('2026-09-08T11:25:00Z');

  it('a KEY:VALUE receipt row with a glued PR label ("F87_PR520: 520 | state: closed | merged: True") is a pr_merged claim', () => {
    const L2 = 'F87_PR520: 520 | state: closed | merged: True | merge_sha: 759e5ebf6c5bc1c499a4fa7b41bc039cb1a032e4 == F87_MAIN_TIP: 759e5ebf… · F87_BRANCH_DEL:204';
    const kinds = extractCompletionClaims(L2).map((c) => `${c.kind}#${c.prNumber}`);
    expect(kinds).toContain('pr_merged#520');
    expect(kinds).not.toContain('pr_closed#520'); // merged wins over the state field
  });

  it('"state: closed" without a merged field is a pr_closed claim; "merged: false" / "state: open" claim nothing', () => {
    expect(extractCompletionClaims('PR #12 | state: closed | merged: false').map((c) => c.kind)).toEqual(['pr_closed']);
    expect(extractCompletionClaims('PR #12 | state: open | merged: false')).toEqual([]);
  });

  it('glued PR tokens extract ("PR520", "_PR520", "PR-520"); a longer word ending in PR does not ("GDPR520")', () => {
    expect(extractCompletionClaims('merged PR520 this morning').map((c) => c.prNumber)).toEqual([520]);
    expect(extractCompletionClaims('merged PR-520 this morning').map((c) => c.prNumber)).toEqual([520]);
    expect(extractCompletionClaims('the GDPR520 audit merged nothing')).toEqual([]);
  });

  it('the fabricated box-probe line makes a probe claim (md5s / _CLOCK / healthy / Up N hours vocabulary)', () => {
    const L4 = 'Box probe captured @ F87_WATCH_CLOCK:2026-09-08T11:22:20Z: tt-flashnext|Up 4 hours (healthy), tt-commandr|Exited (0) 7 days ago, P8091:200, fork 2a70e12d…, md5s match.';
    expect(extractCompletionClaims(L4).map((c) => c.kind)).toEqual(['probe']);
  });

  it('a content-hash citation ("doc md5 3a13ba98…") in a "landed" clause is NOT a commit_pushed claim; a bare "merge sha …" still is', () => {
    const L3 = 'Fold landed: PR #520 merged (merge sha 759e5ebf… == main tip 759e5ebf…, doc md5 3a13ba98… fresh-GET-verified LEN 938,551, branch deleted).';
    const shas = extractCompletionClaims(L3).filter((c) => c.kind === 'commit_pushed').map((c) => c.sha);
    expect(shas).toEqual(['759e5ebf']);
    expect(extractCompletionClaims('sha256sum e01f828dcc7feef4 landed in the artifact store').filter((c) => c.kind === 'commit_pushed')).toEqual([]);
  });

  it('a numbered run NAME ("Firing-87 summary (… 11:41:33Z)") is not a forward-reference exemption — the headline clock flags; "next firing at …" still exempts', () => {
    const L5 = 'Firing-87 summary (07:41 AM EDT Sep 8 / 2026-09-08T11:41:33Z): The sync-bookkeeping verification leg is done.';
    expect(findFutureDatedClaims(L5, NOW_REDO).map((f) => f.stamp)).toEqual(['2026-09-08T11:41:33Z', '07:41 AM EDT Sep 8']);
    expect(findFutureDatedClaims('Next firing at 12:19:30Z per list_schedules.', NOW_REDO)).toEqual([]);
    expect(findFutureDatedClaims('firing #88 fires at 12:19:30Z per list_schedules.', NOW_REDO)).toEqual([]);
  });

  it('an identifier-glued clock ("F87V_CLOCK_11:41:33Z", "F87_CLOCK_2026-09-08T11:41:33Z") is scanned like any other stamp', () => {
    expect(findFutureDatedClaims('re-probed @ F87V_CLOCK_11:41:33Z (healthy)', NOW_REDO).map((f) => f.stamp)).toEqual(['11:41:33Z']);
    expect(findFutureDatedClaims('captured @ F87_CLOCK_2026-09-08T11:41:33Z', NOW_REDO).map((f) => f.stamp)).toEqual(['2026-09-08T11:41:33Z']);
  });
});

describe('intent-cue exemption — completed-work override + label vocabulary (2026-09-08 audit)', () => {
  const NOW = new Date('2026-09-08T11:25:00Z');
  it.each([
    'Window discipline: PR #520 merged at 11:41:33Z',
    'Resume: PR #520 merged at 11:41:33Z (sha 759e5ebf)',
    'Next, probed the box @ 11:41:33Z — healthy',
    'Due diligence: re-probed @ 11:41:33Z, P8091:200',
    'FIRING_87_CLOCK:11:41:33Z — the probe returned healthy',
    'WINDOW_CLOCK:11:41:33Z: P8091 returned 200',
    'firing_87 fold verified at 11:41:33Z',
  ])('an observation clock behind the lane\'s label vocabulary still convicts: %s', (line) => {
    expect(findFutureDatedClaims(line, NOW).map((f) => f.stamp)).toEqual(['11:41:33Z']);
  });

  it.each([
    'Next probe at 12:00:00Z per list_schedules.',
    'The deploy landed at 11:00:00Z; next window at 12:30:00Z.',
    'Window closes at 12:30:00Z — nothing to do until then.',
    'NEXT_RUN_AT: 2026-09-08T12:19:30Z (schedule receipt)',
    'Resume the monitor at 12:30:00Z if the queue is still empty.',
    'the tally will have been recorded at the 12:30:00Z checkpoint',
  ])('honest forward references stay exempt: %s', (line) => {
    expect(findFutureDatedClaims(line, NOW)).toEqual([]);
  });
});

describe('relay-citation anchoring is source-scoped (2026-09-08 audit)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-09-08T11:25:00.000Z');
  const LINE = 'Path C reports commit 84fe3ae0 landed on the training branch (msg 84fe3ae0).';

  it('a sha prefix cited as "msg …" that merely appears in run_command output (a local git log) anchors NOTHING — the claim convicts and the sha is re-queried', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(404)));
    const out = await applyCompletionClaimGuard({
      finalText: LINE,
      parts: [{ type: 'tool_result', name: 'run_command', result: '[command OK]\n84fe3ae0 fold: T44 occupancy learnings (HEAD -> lane/b95e9df6)' }],
      triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.verdict.fabricatedShas).toEqual(['84fe3ae0']);
  });

  it('the same citation anchored in a get_chat_messages pull stays a grounded relay (the 93006fd8 contract)', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(404)));
    const out = await applyCompletionClaimGuard({
      finalText: LINE,
      parts: [{ type: 'tool_result', name: 'get_chat_messages', result: '{"messages":[{"id":"84fe3ae0-2222-4222-8222-222222222222","role":"assistant","content":"commit landed"}]}' }],
      triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.fabricatedShas).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a message-id-SHAPED occurrence ("id": "…") in any tool output still anchors (resumed runs relay through prior-attempt texts)', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(404)));
    const out = await applyCompletionClaimGuard({
      finalText: LINE,
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [],
      priorToolTexts: ['{"messages":[{"id":"84fe3ae0-2222-4222-8222-222222222222","content":"commit landed"}]}'],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });
});

describe('deploy-run and ticket lanes — quoted-void exemption is BLOCK-LOCAL too (2026-09-08)', () => {
  it('extractDeployRunClaims: a void cue paragraphs away does not launder a blockquoted deploy claim; a near cue still does', () => {
    const far = ['The prior note was struck as fabricated.', 'Line A.', 'Line B.', 'Line C.', 'Line D.', '> deploy 33236939738 completed success'].join('\n');
    expect(extractDeployRunClaims(far).map((c) => c.runId)).toEqual(['33236939738']);
    const near = ['VOIDED prior tick — see below.', '> deploy 33236939738 completed success'].join('\n');
    expect(extractDeployRunClaims(near)).toEqual([]);
  });

  it('extractTicketIdCitations: same rule', () => {
    const far = ['VOID prior note.', 'Line A.', 'Line B.', 'Line C.', 'Line D.', '> ticket 01226f89 was triaged'].join('\n');
    expect(extractTicketIdCitations(far).map((c) => c.id)).toEqual(['01226f89']);
    const near = ['VOID prior note — the batch below was struck.', '> ticket 01226f89 was triaged'].join('\n');
    expect(extractTicketIdCitations(near)).toEqual([]);
  });
});

// ── 2026-09-08 audit: guard-composition hardening ────────────────────────────
describe('applyCompletionClaimGuard — composition hardening (2026-09-08 audit)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-09-08T11:25:00.000Z');
  const receipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
    id: '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd', chatId: 'c1', runId: 'run1', tool: 'run_command', ok: true, ids: {},
    inputHash: null, outputHash: null, createdAt: NOW, ...over,
  });

  it.each([
    ['push-claim footer header', '🔍 Harness push-claim verification (commits API):\n• 759e5ebf6c5b… — ✅ EXISTS on origin'],
    ['deploy-run footer header', '🔍 Harness deploy-run verification (GitHub Actions API):\n• run 33236939738 — ✅ EXISTS (completed/success)'],
  ])('a forged %s is convicted as harness-marker forgery', async (_label, marker) => {
    const out = await applyCompletionClaimGuard({ finalText: `Done.\n\n${marker}`, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS });
    expect(out.verdict.forgedFooter).toBe(true);
  });

  it('citing the REAL id of an ok:false receipt (a failed git_push) evonerates NOTHING — the claim stays unproven, and it is not a forged citation', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const failedPush = receipt({ tool: 'git_push', ok: false });
    const out = await applyCompletionClaimGuard({
      finalText: `Opened PR #300 with the fix (receipt ${failedPush.id}).`,
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [failedPush],
    });
    expect(out.verdict.forgedFooter).toBeFalsy();
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
  });

  it('GUARD 2 verifies the RISKIEST PR numbers first and names the ones past the cap as unverified (five honest mentions no longer pad out a sixth fabricated one)', async () => {
    mockFetch.mockImplementation((url: any) => Promise.resolve(String(url).endsWith('/pulls/999')
      ? ghResponse(404)
      : ghResponse(200, { merged: true, merge_commit_sha: 'abc123def456', merged_at: '2026-09-08T10:00:00Z' })));
    // Receipts prove #10–#14 (open_pull_request ids); #999 has none and sits LAST in the text.
    const receipts = [10, 11, 12, 13, 14].map((n) => receipt({ id: `00000000-0000-4000-8000-00000000000${n - 10}`, tool: 'open_pull_request', ids: { prNumber: n } }));
    const text = [...[10, 11, 12, 13, 14].map((n) => `merged PR #${n}`), 'merged PR #999 too'].join('\n');
    const out = await applyCompletionClaimGuard({ finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts });
    expect(out.verdict.fabricatedPrs).toEqual([999]);
    const queried = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(queried.some((u) => u.endsWith('/pulls/999'))).toBe(true);
    expect(queried.filter((u) => /\/pulls\/\d+$/.test(u))).toHaveLength(MAX_VERIFY_PRS);
    expect(out.finalText).toMatch(/#\d+ — ⚠︎ NOT verified \(per-answer cap of 5 GitHub lookups reached\)/);
  });

  it('GUARD 5 lane A skips the Actions API only when the evidence shows the id WITH the claimed state — an in_progress row in tool output still triggers verification (and refutation)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success.',
      parts: [{ type: 'tool_result', name: 'run_command', result: 'gh run list\n33236939738  in_progress  deploy  main  2m' }],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.refutedDeployRuns).toEqual(['33236939738']);
    // …while an observed SUCCESS row keeps lane A's API-free exoneration.
    mockFetch.mockClear();
    const ok = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success.',
      parts: [{ type: 'tool_result', name: 'run_command', result: 'gh run view 33236939738\n✓ main deploy · 33236939738\nstatus: completed  conclusion: success' }],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ok.verdict.refutedDeployRuns).toBeUndefined();
    expect(ok.verdict.fabricatedDeployRuns).toBeUndefined();
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/actions/runs/'))).toBe(false);
  });
});

describe('findFutureDatedClaims', () => {
  // 2026-08-22T18:10:00Z == 11:10 AM PDT — the true clock behind phantom #31's
  // fabricated "11:23:33 AM PDT merge".
  const NOW = new Date('2026-08-22T18:10:00.000Z');

  it('flags a merge claim whose ISO merged_at is minutes in the future (phantom #31 shape)', () => {
    const fd = findFutureDatedClaims('real PR #253 squash-merged at 2026-08-22T18:23:33Z with sha 9f3cc5c8', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('2026-08-22T18:23:33Z');
    expect(fd[0].aheadMs).toBeGreaterThan(90_000);
  });

  it('does not flag the same claim with a past timestamp', () => {
    const text = 'real PR #253 squash-merged at 2026-08-22T17:58:33Z with sha 9f3cc5c8';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('flags a probe claim with a clock-only PDT time minutes ahead of now', () => {
    const fd = findFutureDatedClaims('box probe at 11:23:33 AM PDT showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('11:23:33 AM PDT');
  });

  it('does not flag a clock-only claim behind now', () => {
    const text = 'box probe at 10:55:12 AM PDT showed md5 4a30d268';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('does not flag a clock-only yesterday-reference near midnight', () => {
    const NEAR_MIDNIGHT = new Date('2026-08-22T07:30:00.000Z'); // 00:30 PDT
    const text = 'box probe at 11:50:00 PM PDT showed uptime 9h';
    expect(findFutureDatedClaims(text, NEAR_MIDNIGHT)).toHaveLength(0);
  });

  it('flags a benchmark tally carrying a future clock stamp', () => {
    const text = 'Tallies: 906/990 = 668 PASS / 34 FAIL at 19:55:38 UTC';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(1);
  });

  it('ticket 63e9a3cb: a clock stamp deep in an "ETA (projection):" line is projection-scoped, not a fabricated observation', () => {
    // The fleet evidence discipline mandates future estimates live on the
    // standalone ETA line; the per-stamp 48-char intent window misses stamps
    // sitting further down the line (the Path C lane's "…; cyan restage
    // completes ~02:45Z" struck +42m on a mandated ETA line, 2026-08-28).
    const text = 'ETA (projection): aqua finishes model load + begins replay within ~10 min of 6:05 PM PDT; cyan restage completes ~12:45 PM PDT';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
    // Control: the SAME stamp without the projection header still flags.
    // (Operator iteration 11, 2026-09-25: a "~"-governed clock is now an
    // estimate in its own right — estimateGovernedStamp — so the control
    // drops the tilde to stay a control for the HEADER exemption.)
    const control = 'Status: aqua finishes model load + begins replay within ~10 min of 6:05 PM PDT; cyan restage completes 12:45 PM PDT';
    expect(findFutureDatedClaims(control, NOW)).toHaveLength(1);
    // …and the tilde form alone is exempt without any header (iteration 11).
    expect(findFutureDatedClaims('Status: cyan restage completes ~12:45 PM PDT', NOW)).toHaveLength(0);
  });

  it('ticket 63e9a3cb: the projection-header exemption covers explicit-date ISO stamps on the line', () => {
    const text = 'ETA (projection): round-37 subset closure commits at 2026-08-22T19:30:00Z after window expiry';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
    const control = 'Closure status: round-37 subset closure commits at 2026-08-22T19:30:00Z';
    expect(findFutureDatedClaims(control, NOW)).toHaveLength(1);
  });

  it('ticket 63e9a3cb: a decorated (blockquoted) ETA line is still projection-scoped', () => {
    const text = '> ETA (projection): ckpt-36 restore completes ~12:45 PM PDT, then 35→34 per the chain';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('ticket 63e9a3cb anti-smuggle: an ETA TOKEN mid-line does NOT projection-scope the line', () => {
    // Only a line OPENING with the header is exempt — "Summary: …" is a status
    // line and its future observation clock still flags (the ETA token sits
    // >48 chars back, so the per-stamp intent window does not suppress either).
    const text = 'Summary: probes done per the ETA plan and the full verification narrative; box probe at 12:45 PM PDT showed md5 4a30d268';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(1);
  });

  it('ignores future-intent schedule lines even when claim-ish words appear', () => {
    const text = 'next firing scheduled at 06:10Z will re-check uptime';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('ticket da1dfa2f: a probe-cited ETA quoted as a glued ETA_UTC= token is NOT future-dated', () => {
    // The real flagged line shape (run c8c7989c): a benchmark-claim line
    // quoting the probe's own printed projection as ETA_UTC=<stamp>. "_" is
    // a word char, so the bare-word \b intent-scoper never fired pre-fix.
    // 20:15Z is ~125m ahead of NOW (inside the clock-only 3h window), so
    // this passes ONLY via the glued-suffix suppression — the control proves
    // the line really is claim-classified (same stamp, no ETA token → flag).
    const text = 'Tallies: 906/990 = 668 PASS / 34 FAIL at 18:04:49 UTC; ETA_PDT=13:15/ETA_UTC=20:15Z per probe CID 933cd3b4';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
    const control = 'Tallies: 906/990 = 668 PASS / 34 FAIL at 18:04:49 UTC; probe CID 933cd3b4 printed 20:15Z';
    expect(findFutureDatedClaims(control, NOW)).toHaveLength(1);
  });

  it('ticket da1dfa2f: the glued-suffix suppression stays windowed — a stamp >48 chars later still flags', () => {
    // Evasion guard: the suffix widens the intent TOKEN, never the 48-char
    // window. The glued 19:00Z is suppressed; the narrative-laundered 20:15Z
    // sits ~80 chars past the token and must still flag.
    const text = 'Tallies: 906/990 = 668 PASS / 34 FAIL at 18:04:49 UTC; ETA_UTC=19:00Z and the extended verification narrative eventually cites completion at 20:15Z';
    const fd = findFutureDatedClaims(text, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('20:15Z');
  });

  it('ignores timestamps on lines with no completion claim', () => {
    const text = 'the nightly schedule fires at 2026-08-23T06:10:00Z';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('M1 regression: a seconds-less ISO stamp with a PAST explicit date is NOT re-dated to today', () => {
    // "2026-08-21 18:23 UTC" at now=2026-08-22T18:10Z — yesterday, honest.
    const text = 'box probe at 2026-08-21 18:23 UTC showed uptime 9h';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('M1 regression: a seconds-less ISO stamp with a FUTURE explicit date still flags', () => {
    const text = 'PR #253 squash-merged at 2026-08-22 19:30 UTC, sha 9f3cc5c8.';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(1);
  });

  it('M2 regression: an intent word suppresses ONLY the stamp that follows it — not the fabricated one before', () => {
    const text = 'PR #253 squash-merged at 2026-08-22T19:30:00Z, sha 9f3cc5c8; next probe 20:00Z will confirm uptime';
    const fd = findFutureDatedClaims(text, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('2026-08-22T19:30:00Z');
  });

  it('L5 regression: the same instant claimed twice on one line yields ONE finding', () => {
    const text = 'PR #253 squash-merged at 2026-08-22T19:30:00Z, re-confirmed 2026-08-22T19:30:00Z, sha 9f3cc5c8.';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(1);
  });

  it('ticket c0f5a799: a stamp inside an explicitly hypothetical clause is a future THRESHOLD, not an observation', () => {
    // The verbatim incident shape (run b536ad83, real clock 10:37Z): "11:00Z"
    // flagged +23m ahead because its intent words FOLLOW the stamp (", the
    // next firing steers it") — outside the 48-char backward intent window.
    // Pre-fix this line produced exactly one finding ("11:00Z"); "10:59Z" was
    // suppressed by the backward window ("next ~") and "11:15Z" by "firing"
    // within 48 chars back. The "if" governing the stamp's own clause makes
    // the stamp a conditional threshold the run SET, not an observation it
    // claims to have made.
    const INCIDENT_NOW = new Date('2026-08-28T10:37:00.000Z');
    const text = 'the sweep (`7eded31b`, next ~10:59Z) carries the continuation; if the lane is still 0/7 with a stale heartbeat at ~11:00Z, the next firing steers it; unresponsive by ~11:15Z, it\'s stood down and replaced again';
    expect(findFutureDatedClaims(text, INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket c0f5a799 control: the same stamp WITHOUT a governing conditional still flags', () => {
    const INCIDENT_NOW = new Date('2026-08-28T10:37:00.000Z');
    const text = 'lane audit complete: the heartbeat probe at ~11:00Z showed the lane still 0/7';
    const fd = findFutureDatedClaims(text, INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('11:00Z');
  });

  it('ticket c0f5a799 anti-smuggle: a conditional word in a LATER clause never exempts a fabricated stamp', () => {
    // Clause-bounded: "if" sits after a ";" — it governs the second clause
    // (and DOES exempt its own 19:00Z stamp: +50m vs NOW, inside the 3h
    // clock-only window, so without the conditional exemption it WOULD flag
    // — the exemption itself is exercised), but the fabricated merge stamp
    // in the first clause still convicts.
    const text = 'PR #253 squash-merged at 2026-08-22T19:30:00Z, sha 9f3cc5c8; if the probe at 19:00Z confirms uptime, promote';
    const fd = findFutureDatedClaims(text, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('2026-08-22T19:30:00Z');
  });

  it('ticket c0f5a799 window edge: a conditional word >96 chars before the stamp does NOT exempt it', () => {
    const INCIDENT_NOW = new Date('2026-08-28T10:37:00.000Z');
    // Pad must avoid every INTENT_BEFORE_STAMP_RE word too (an earlier pad
    // containing "window" was exempted by the 48-char backward window, not
    // the conditional layer — the guard was right, the pad was wrong).
    const pad = 'with the full verification narrative spanning far past the documented reach and extra padding detail ';
    const text = `if the lane ${pad}reports a stale heartbeat at ~11:00Z it is wedged`;
    const fd = findFutureDatedClaims(text, INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('11:00Z');
  });

  it('ticket c0f5a799: when/once/unless-governed future stamps are hypothetical too', () => {
    const INCIDENT_NOW = new Date('2026-08-28T10:37:00.000Z');
    expect(findFutureDatedClaims('when the sweep runs at ~11:00Z it re-checks the lane', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('once the lane hits 9/9 at ~11:00Z merge it', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('unless the probe at ~11:00Z fails promote the build', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba: an inline "projected completion ≈ <stamp>" projection is NOT a fabricated observation clock', () => {
    // Verbatim incident shape (tt-rd lane a8976e11, run 16ecf6a3, real clock
    // 2026-08-28T17:12Z): the run's honest audit-closed line projected the
    // benchmark leg's completion and LABELED it a projection — but "projected"
    // was not in the backward intent vocabulary, so the guard struck
    // "18:55Z (+103m ahead)" and blanket-un-verified an honest final.
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const text = 'the GPQA-D ×5 leg is genuinely running and advancing — **358/990 items (36%)** at ~10 s/item, projected completion ≈ 18:55Z (~11:55 AM PDT, projection not a tool-printed instant)';
    expect(findFutureDatedClaims(text, INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba control: the same stamp WITHOUT projection framing still flags', () => {
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const fd = findFutureDatedClaims('the GPQA-D ×5 leg tally was recorded at 18:55Z with 358/990 items', INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('18:55Z');
  });

  it('ticket 2884edba: a stamp NAMING a scheduled future tick ("The 18:05Z tick owns the fold") is a forward reference', () => {
    // Second verbatim incident shape (same run): the run navigated its own
    // recurring monitor — "The 18:05Z tick owns the fold → AIME26 launch
    // sequence" — the stamp SUBJECT-labels a scheduled future event (whose
    // nextRunAt IS a real future instant), it does not claim an observation
    // happened at 18:05Z. Pre-fix this struck "18:05Z (+53m ahead)".
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const text = 'Nothing folded, nothing launched, nothing published this tick — correctly, because the completion gate isn\'t met. The 18:05Z tick owns the fold → AIME26 launch sequence; todo and monitor state verified clean.';
    expect(findFutureDatedClaims(text, INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba anti-smuggle: a stamp naming a COMPLETED-work noun ("the 18:55Z probe showed …") still flags', () => {
    // The schedule-subject exemption covers schedule-navigation nouns ONLY
    // (tick/firing/window/cycle/round/handoff) — a stamp subject-labeling a
    // past-tense work artifact claims the work existed at a future instant:
    // the phantom shape, still convicted.
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const fd = findFutureDatedClaims('the 18:55Z probe showed md5 4a30d268 and the leg tallied clean', INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('18:55Z');
  });

  it('ticket 2884edba window discipline: projection vocabulary >48 chars before the stamp does NOT exempt it', () => {
    // The projection words widen the intent VOCABULARY, never the 48-char
    // window (same anti-laundering constraint as da1dfa2f). Pad avoids every
    // other intent/conditional word and every schedule-subject noun.
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const pad = 'with the full verification narrative spanning far past the documented reach and extra padding detail ';
    const text = `projected early on: the lane ${pad}reports a stale heartbeat at ~19:00Z as logged`;
    const fd = findFutureDatedClaims(text, INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:00Z');
  });

  it('ticket 2884edba: the full verbatim flagged paragraph yields ZERO findings (both incident stamps)', () => {
    // The exact audit-closed paragraph from run 16ecf6a3. Pre-fix this
    // reproduced the observed verdict exactly: 2 findings — "18:55Z (+103m
    // ahead)" and "18:05Z (+53m ahead)". The past 10:09/10:11 AM PDT clocks
    // stay quiet throughout.
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    const text = '**Audit-closed bottom line (10:09–10:11 AM PDT):** tt-commandr healthy on `:8090` (HTTP 200, ctx 131,072); the GPQA-D ×5 leg is genuinely running and advancing — **358/990 items (36%)** at ~10 s/item, projected completion ≈ 18:55Z (~11:55 AM PDT, projection not a tool-printed instant). Early log-line trend 87/295 ≈ 29.5% pass — trend only; the definitive tally comes from `items.jsonl` at completion. Nothing folded, nothing launched, nothing published this tick — correctly, because the completion gate isn\'t met. The 18:05Z tick owns the fold → AIME26 launch sequence; todo and monitor state verified clean.';
    expect(findFutureDatedClaims(text, INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba sighting 2: a parenthesized zone-conversion twin inherits the exempt primary stamp\'s classification', () => {
    // Second incident shape (same lane, the 18:05Z firing, run wall clock
    // 2026-08-28T18:19Z): "The 19:05Z tick (12:05 PM PDT) should land …" — the
    // primary stamp exempts via the schedule-subject rule, but its PDT gloss
    // (the SAME instant, mandated by the fleet's dual-zone reporting culture)
    // re-evaluated bare: its own backward window has no intent word and its
    // after-text ") should land" matches no subject noun — 1 finding even
    // after the first 2884edba fix. The twin is a re-RENDERING of an instant
    // already classified as a forward reference on this line, not a new claim.
    const INCIDENT2_NOW = new Date('2026-08-28T18:19:00.000Z');
    const text = 'The 19:05Z tick (12:05 PM PDT) should land right at the final `===` line and owns the fold';
    expect(findFutureDatedClaims(text, INCIDENT2_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba sighting 2 control: the twin shape does NOT dodge conviction when the primary is a fabrication', () => {
    // No intent/conditional/subject framing around the primary — both stamps
    // of the same future instant convict (deduped to ONE finding by the
    // standing same-instant rule).
    const INCIDENT2_NOW = new Date('2026-08-28T18:19:00.000Z');
    const fd = findFutureDatedClaims('box probe showed the leg at 19:05Z (12:05 PM PDT) and it tallied clean', INCIDENT2_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
  });

  it('ticket 2884edba sighting 2 anti-smuggle: a closed parenthesis (or >24-char gap) before the twin breaks the inheritance', () => {
    // The gloss window is TIGHT: the twin must sit inside a parenthesis group
    // opening within 24 chars of the exempted occurrence. "next probe 19:00Z"
    // exempts; the second 19:00Z arrives 77 chars later (beyond BOTH the
    // 24-char gloss reach AND the 48-char intent window) — a fabricated
    // completion stamp cannot launder behind a distant intent-scoped twin of
    // the same instant.
    const INCIDENT2_NOW = new Date('2026-08-28T18:19:00.000Z');
    const fd = findFutureDatedClaims('next probe 19:00Z (done); after the full verification narrative concludes the merge landed at 19:00Z with sha 84fe3ae0', INCIDENT2_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:00Z');
  });

  it('ticket 2884edba sighting 2: an intent-exempted primary also exempts its adjacent zone-conversion gloss', () => {
    const INCIDENT2_NOW = new Date('2026-08-28T18:19:00.000Z');
    expect(findFutureDatedClaims('next probe 19:00Z (12:00 PM PDT) will confirm the tally', INCIDENT2_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba sighting 3: a QUALIFIED schedule subject ("the 19:05Z monitor tick") is still a forward reference', () => {
    // Third incident shape (same lane, run wall clock 2026-08-28T18:26Z): the
    // lane wrote "The 19:05Z monitor tick should land …" — the qualifier noun
    // "monitor" between stamp and schedule noun defeated the strictly-glued
    // subject regex. Qualifiers are schedule-descriptors ONLY (scheduled/
    // monitor/audit/checkpoint) — completed-work qualifiers (verify/probe/
    // review pass …) still convict.
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    const text = 'The 19:05Z monitor tick should land right at the final `===` line and owns: tally from `items.jsonl` → fold';
    expect(findFutureDatedClaims(text, INCIDENT3_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba sighting 3 anti-smuggle: a stamp subject-labeling a COMPLETED-work qualifier chain still flags', () => {
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    const fd = findFutureDatedClaims('the 19:05Z verify pass re-checked the lane and found it clean', INCIDENT3_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
  });

  it('review #2 F1 (BLOCKING): a past-tense completion verb after the subject noun REVOKES the exemption', () => {
    // The qualifier group alone is verb-blind: "the 19:05Z audit cycle
    // verified the tally, md5 4a30d268" exempted (parent code convicted) AND
    // escaped every other layer (no PR number; "verified" ∉
    // COMMIT_PUSH_VERB_RE so the sha never reaches GUARD 2b) — the guard's
    // own phantom class, laundered. The exemption now requires the 48 chars
    // after the matched noun phrase to carry NO past-tense completion verb.
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    const fd = findFutureDatedClaims('the 19:05Z audit cycle verified the tally, md5 4a30d268', INCIDENT3_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
  });

  it('review #2 F1: the verb gate covers qualified AND unqualified subjects (residual 22efe001 shape)', () => {
    const fd = findFutureDatedClaims('the 19:30Z tick merged PR #253, sha 84fe3ae0', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:30Z');
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    const fd2 = findFutureDatedClaims('the 19:05Z scheduled window verified the merge', INCIDENT3_NOW);
    expect(fd2).toHaveLength(1);
    expect(fd2[0].stamp).toBe('19:05Z');
  });

  it('review #2 F1 honest control: a subject reference with NO past-tense verb stays exempt', () => {
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    expect(findFutureDatedClaims('the 19:05Z audit cycle begins the fold watch; no tally yet', INCIDENT3_NOW)).toHaveLength(0);
  });

  it('review #2 F1 window edge: a past-tense verb >48 chars after the noun phrase does NOT revoke the honest exemption', () => {
    // The incident line's own "todo and monitor state verified clean" sits 65
    // chars after "tick" — outside the verb-gate reach — so the honest
    // schedule-navigation reference keeps its exemption.
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('The 18:05Z tick owns the fold → AIME26 launch sequence; todo and monitor state verified clean.', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 10ee7161: "the monitor collects it at the <stamp> checkpoint" is a forward reference to a scheduled event', () => {
    // Verbatim incident shape (bench lane c9ccf88a, msg b98da923, verify clock
    // ~2026-08-31T00:05Z): the final summary navigated the lane's own monitor —
    // "the monitor collects it at the 6:04 PM PDT checkpoint" — a present-tense
    // scheduled-event reference, struck "6:04 PM PDT (+59m ahead)" because the
    // schedule-subject layer's terminal noun list lacked "checkpoint" (it sat in
    // the qualifier group only) and the user-question turn carried no schedule
    // receipt for tool provenance.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    const text = 'the NVFP4-arm probe is live again with ETA (projection) ~45–90 min, and the monitor collects it at the 6:04 PM PDT checkpoint. Production serve untouched and healthy at 2 days';
    expect(findFutureDatedClaims(text, INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 10ee7161: "<stamp> monitor checkpoint" and "<stamp> collection checkpoint" subject shapes are forward references', () => {
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    // Supervisor shape (msg 4fe227f5): qualifier + terminal checkpoint.
    expect(findFutureDatedClaims('QLOOPNV4 re-fired and live; collection lands at the 01:04Z monitor checkpoint', INCIDENT_NOW)).toHaveLength(0);
    // Bench-lane shape (msg 0492e8e4): "collection checkpoint" after the stamp.
    expect(findFutureDatedClaims('monitor armed for the 6:04 PM PDT collection checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 10ee7161 anti-gut: a stamp subject-labeling COMPLETED work at a checkpoint/collection still convicts (verb gate intact)', () => {
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    const fd = findFutureDatedClaims('the 01:04Z checkpoint verified the collection tally', INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('01:04Z');
    const fd2 = findFutureDatedClaims('the 01:04Z collection showed 3 failures', INCIDENT_NOW);
    expect(fd2).toHaveLength(1);
    expect(fd2[0].stamp).toBe('01:04Z');
  });

  it('ticket 10ee7161 control: a bare future stamp with no schedule subject still flags', () => {
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    const fd = findFutureDatedClaims('probe completed at 01:04Z with all arms green', INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('01:04Z');
  });

  it('ticket 10ee7161: the dual-zone gloss inherits the checkpoint exemption', () => {
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the 01:04Z checkpoint (6:04 PM PDT) collects the QLOOPNV4 arm', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b: a NOVEL scheduled-event noun in no list still exempts (open vocabulary closed)', () => {
    // The recurring hole this ticket closes: lanes keep inventing scheduled-
    // event nouns ("checkpoint" ca153ef8, "collection" 10ee7161) and every
    // omission shipped as a fabrication strike on a clean answer. Under the
    // inverted gate ANY subject-shaped phrase exempts — "rollup" is in no
    // list, so this pair passes ONLY because the gate no longer enumerates.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the 01:04Z rollup owns the digest', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the monitor collects it at the 6:04 PM PDT rollup', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b anti-gut: a completed-work verb with a NOVEL noun still convicts', () => {
    // The inversion moves conviction onto the verb gates, not the noun:
    // "the 01:04Z rollup verified …" subject-labels the stamp yet asserts
    // COMPLETED work — the phantom shape, still convicted.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    const fd = findFutureDatedClaims('the 01:04Z rollup verified the digest tally', INCIDENT_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('01:04Z');
  });

  it('ticket f1afaa7b shape gate: a clause continuation after the stamp is NOT a schedule subject', () => {
    // Closed-class openers (pronoun / coordinator / preposition) and
    // verb-governed frames convict exactly as they did under the noun list.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the heartbeat probe at ~01:04Z it is wedged', INCIDENT_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box tail read 01:04Z and looked clean', INCIDENT_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the merge landed at 01:04Z with sha 84fe3ae0', INCIDENT_NOW)).toHaveLength(1);
    // A lone bare word at end-of-line is a state fragment (RESULT STATE at
    // the stamped instant), not a subject reference — convicts for EVERY
    // state word symmetrically (review F2: no adjective vocabulary).
    expect(findFutureDatedClaims('probe tail 01:04Z clean', INCIDENT_NOW)).toHaveLength(1);
  });

  it('ticket f1afaa7b review F2: lone state words convict SYMMETRICALLY; an article-governed lone novel noun exempts', () => {
    // The reviewer's asymmetry probe: a state-adjective list would convict
    // "green" yet exempt "red". The lone-word+article rule is structural —
    // every bare state fragment convicts alike.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z'); // 19:05Z = +113m, inside the 3h window
    expect(findFutureDatedClaims('box probe 19:05Z red', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z green', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('probe tail 19:05Z passing', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('probe tail 19:05Z wedged', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('probe tail 19:05Z degraded', PHANTOM_NOW)).toHaveLength(1);
    // …while the honest article-governed scheduled-event fragment exempts.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('collection lands at the 01:04Z rollup', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review F1: a LONG subject phrase cannot push the completed-work verb out of the gate', () => {
    // The inversion's flat 48-char window let a long subject phrase launder
    // the verb ("…checkpoint revalidated the arm and verified the tally" —
    // verb at +53 — escaped every layer, claims=[]). The window is now
    // clause-bounded 96 chars: both verbs convict.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the 19:05Z scheduled monitor checkpoint revalidated the arm and verified the tally', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the 19:05Z weekly cross-model reconciliation rollup summary verified the tally', PHANTOM_NOW)).toHaveLength(1);
  });

  it('ticket f1afaa7b review F3: the fleet\'s own observation verbs convict with a novel noun', () => {
    // With the noun list gone the verb gates are the sole conviction path
    // for subject phantoms — the shared vocabulary now spans the fleet's
    // observed completion verbs.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the 19:05Z rollup revalidated the arm', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the 19:05Z rollup collected the digest', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the 19:05Z rollup saw 3 failures', PHANTOM_NOW)).toHaveLength(1);
    // Round-2 NOTE: near-synonyms join the shared list.
    expect(findFutureDatedClaims('the 19:05Z rollup validated the tally', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the 19:05Z rollup summarized the digest', PHANTOM_NOW)).toHaveLength(1);
  });

  it('ticket f1afaa7b review round-2 F1: "at THE <stamp>" does not defeat the backward verb gate', () => {
    // The inserted article both silenced the backward gate AND earned the
    // lone-word rule's article governance — a composed hole (OLD=1 → NEW=0
    // with zero other-layer coverage). The gate now absorbs the article.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    const fd = findFutureDatedClaims('the tally was recorded at the 19:05Z rollup', PHANTOM_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
    expect(findFutureDatedClaims('probe completed at the 19:05Z green', PHANTOM_NOW)).toHaveLength(1);
  });

  it('ticket f1afaa7b review round-2 F1 honest control: a future/ongoing passive never trips the backward gate', () => {
    // "get logged" / "will be verified" are forward frames the pre-inversion
    // list exempted — the auxiliary guard keeps the gate off them, while the
    // past passive ("was recorded") above still convicts.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('results get logged at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the digest is collected at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-2 F2: a sentence-final period does not defeat the lone-word rule', () => {
    // Real monitor prose terminates sentences — "box probe 19:05Z green."
    // exempted while the period-free form convicted. The lone-word matcher
    // now absorbs one terminal [.!?]; governance stays the discriminator.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('box probe 19:05Z green.', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z red.', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('probe tail 19:05Z clean.', PHANTOM_NOW)).toHaveLength(1);
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('collection lands at the 01:04Z rollup.', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-3 F1: the dual-zone gloss colon does NOT shield a completed-work verb behind it', () => {
    // The fleet's mandated gloss "(12:05 PM PDT)" carries a colon-clock; a
    // ':' clause bound truncated the forward window at the gloss so the verb
    // behind it escaped — and the twin then INHERITED the exemption. The
    // bound is now [;!?]; the honest gloss keeps its exemption (no listed
    // verb in 96 chars at all).
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    const fd = findFutureDatedClaims('the 19:05Z rollup (12:05 PM PDT) verified the tally', PHANTOM_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
    expect(findFutureDatedClaims('the 19:05Z scheduled monitor checkpoint (12:05 PM PDT) revalidated the arm and verified the tally', PHANTOM_NOW)).toHaveLength(1);
    // Honest control: a present-tense frame behind the same gloss exempts,
    // and the twin inherits it.
    expect(findFutureDatedClaims('the 19:05Z rollup (12:05 PM PDT) collects the arm', PHANTOM_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-3 F2: "has/had been + participle" is the COMPLETED perfect and convicts', () => {
    // The 'been' lookbehind laundered the completed perfect ("the tally has
    // been recorded at the 19:05Z rollup" → OLD=1, NEW=0, claims=0). It is
    // removed; future-perfects stay exempt via the standing INTENT layer.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the tally has been recorded at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally had been recorded at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the tally will have been recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-4 F1: "was/were + being/getting" is the PAST continuous and convicts', () => {
    // One inserted word past the was/were conviction: bare being/getting
    // lookbehinds laundered "the arm was being folded at the 01:04Z
    // checkpoint" (OLD=1 → NEW=0, claims=0). The stack now blocks only the
    // PRESENT frames (is/are being, is/are getting).
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the tally was being recorded at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the tallies were being recorded at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally was getting recorded at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the arm was being folded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(1);
    // Honest control: the present-continuous schedule frame stays exempt.
    expect(findFutureDatedClaims('the tally is being recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-4 F2: composed terminal punctuation does not defeat the lone-word rule', () => {
    // One more character past the single-period fix: "green,", "green;",
    // "green..", "green…", "green!!" and the standard `"green".` quote order
    // all exempted (OLD=1 → NEW=0). The matcher now absorbs a RUN of
    // terminators/quotes; governance stays the discriminator.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('box probe 19:05Z green,', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z green;', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z green..', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z green…', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z green!!', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('box probe 19:05Z "green".', PHANTOM_NOW)).toHaveLength(1);
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('collection lands at the 01:04Z rollup…', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b review round-5 F1: a comma between verb and "at" does not launder the phantom clock', () => {
    // One comma past the was/were conviction: "the tally was recorded, at
    // the 19:05Z rollup." — the comma sat in the span's boundary class, so
    // the backward gate went silent while the text still ended "at the "
    // (earning lone-word governance). Commas are intra-clause; only
    // sentence/clause boundaries [;.:!?] bound the span now.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    const fd = findFutureDatedClaims('The tally was recorded, at the 19:05Z rollup.', PHANTOM_NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:05Z');
    expect(findFutureDatedClaims('the tally was recorded, per the runbook, at the 19:05Z rollup', PHANTOM_NOW)).toHaveLength(1);
  });

  it('ticket f1afaa7b review round-5 F2: an \'s-contraction keeps the honest present-frame exemption', () => {
    // One apostrophe from the pinned "is being recorded" frame: "'s being
    // recorded" struck the honest present continuous (NEW=1, OLD=0). The
    // aux stack now covers 's-contractions (ASCII + curly), and the bare
    // "'s " resolves the is/has ambiguity toward no-strike.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('it\'s being recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally\'s being recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally\'s getting recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('it’s being recorded at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('it\'s collected at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b (round-6 C1-C4): observation-output verbs convict — returned / came back / yielded', () => {
    // The inverted gate initially exempted these — "returned"/"came"/
    // "yielded" sat outside the completed-work verb list while OLD's noun
    // list convicted (differential probe: OLD=1, NEW=0). With the noun list
    // gone the verb gates are the sole conviction path for subject phantoms,
    // so the fleet's observation-OUTPUT verbs join the list.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('probe at 19:05Z returned 511 lines', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the on-box check at 19:05Z returned 0 rows', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the probe at 19:05Z came back clean', PHANTOM_NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('the probe at 19:05Z yielded 3 rows', PHANTOM_NOW)).toHaveLength(1);
    // Honest direction: an aux-guarded passive ("are returned") and a
    // present frame ("comes back") never convict.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('results are returned at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the queue comes back at the 01:04Z checkpoint', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b (round-6 C5): the backward gate reach stays 24 chars — long asides exempt by design, honest compounds stay exempt', () => {
    // A >24-char aside between verb and "at" defeats the backward gate — an
    // ACCEPTED residual in the sanctioned no-strike direction: widening the
    // reach would false-convict honest compound clauses ("…recorded
    // yesterday and the rollup lands at <stamp>") whose "and"-joined second
    // clause carries no boundary character. Both directions pinned so the
    // trade-off is deliberate, not accidental.
    const PHANTOM_NOW = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the tally was recorded, per the nightly operational runbook, at the 19:05Z rollup window', PHANTOM_NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally was recorded yesterday and the rollup lands at the 19:05Z window', PHANTOM_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b (round-7 B1): the forward window bounds sentence boundaries — period-joined honest prose stays exempt', () => {
    // Post-merge review B1: the 96-char window crossed '.' to a completed-work
    // verb in the NEXT sentence (OLD=0 → NEW=1) — a sentence boundary is a
    // clause boundary, so '.' joins [;!?] (':' stays unbounded for the gloss).
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    const NOW2 = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('The 18:05Z tick owns the fold → AIME26 launch sequence. Todo and monitor state verified clean.', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the 01:04Z window owns the digest. The box probe returned 511 lines', NOW2)).toHaveLength(0);
    // Conviction control: a verb BEFORE the boundary still convicts.
    expect(findFutureDatedClaims('the 19:05Z rollup verified the tally. md5 4a30d268', NOW1)).toHaveLength(1);
  });

  it('ticket f1afaa7b (round-7 B2): the backward span never crosses a coordinator — honest compounds exempt, compound verbs convict', () => {
    // The round-6 C5 "protection" was a length accident (32-char connector);
    // the same compound with a 22-char connector false-convicted (OLD=0 →
    // NEW=1). The span is now tempered on and/but/or/nor.
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    const NOW2 = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the tally was recorded and the rollup lands at the 19:05Z window', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally was recorded and the rollup lands at the 01:04Z checkpoint', NOW2)).toHaveLength(0);
    // Compound VERBS sharing the stamp convict via the last verb before "at".
    expect(findFutureDatedClaims('the tally was recorded and logged at the 19:05Z rollup window', NOW1)).toHaveLength(1);
  });

  it('ticket f1afaa7b (round-7 B3): preposition-governed honest frames exempt; the past-tense reading convicts', () => {
    // Governance and the backward gate widened TOGETHER to
    // at/during/in/into/within — governance alone would have laundered
    // "recorded during the <stamp> window"; the aux stack protects the
    // honest frames on both.
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    const NOW2 = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('results get logged during the 01:04Z window', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('results are collected during the 01:04Z window', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('results get logged in the 01:04Z window', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the digest is folded into the 01:04Z window', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('results are being logged during the 01:04Z window', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally was recorded during the 19:05Z window', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally was recorded in the 19:05Z rollup window', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('the digest was folded into the 01:04Z window', NOW2)).toHaveLength(1);
  });

  it('ticket f1afaa7b (round-7 S-class, round-8 amended): gave convicts; read/printed delisted (round-8 B-1); passives stay protected', () => {
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    const NOW2 = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the probe at 19:05Z gave 0 errors', NOW1)).toHaveLength(1);
    // Round-8 B-1 (BLOCKING): read (present/past homograph) and printed
    // (adjective/reduced-passive) convicted honest scheduled prose — both left the
    // vocabulary, so these framings now exempt BY DESIGN (honest-side pins in the
    // round-8 B-1 block above).
    expect(findFutureDatedClaims('the probe at 19:05Z read clean', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the probe at 19:05Z printed 3 rows', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('results are read at the 01:04Z checkpoint', NOW2)).toHaveLength(0);
  });

  it('ticket f1afaa7b (round-7 B4): predicated state readings exempt BY DESIGN — documented accepted residual', () => {
    // "the 19:05Z probe was green" vs honest schedule metadata ("the 01:04Z
    // rollup was rescheduled"): no structural boundary; the -ed/-en
    // participle heuristic fails on the fleet's own state vocabulary
    // ("wedged"); a state-adjective list recreates the F2 open-vocabulary
    // trap. Sanctioned no-strike direction — pinned so the trade-off is
    // deliberate, never accidental.
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the 19:05Z probe was green', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally at 19:05Z was 3 failures', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the 19:05Z probe looked green', NOW1)).toHaveLength(0);
  });

  it('ticket f1afaa7b: the backward verb gate is clause-bounded — a neighbouring verified-clause never convicts the subject', () => {
    // "verified" sits across a ";" — the 01:04Z subject keeps its exemption.
    // Without clause-bounding this honest line would be the inversion's own
    // false-positive shape.
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('tally verified clean; the 01:04Z rollup collects the digest', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket f1afaa7b: the dual-zone gloss inherits the novel-noun exemption', () => {
    const INCIDENT_NOW = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('the 01:04Z rollup (6:04 PM PDT) collects the digest', INCIDENT_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba: the full verbatim SIGHTING-2 paragraph yields ZERO findings (post-fix)', () => {
    // The exact bottom-line paragraph from the 18:05Z firing (message
    // f010e4b2). After the FIRST 2884edba fix this still produced 1 finding
    // ("12:05 PM PDT" — the gloss twin); the footer observed pre-deploy was
    // "19:00Z (+41m ahead); 19:05Z (+46m ahead)".
    const INCIDENT2_NOW = new Date('2026-08-28T18:19:00.000Z');
    const text = '**Bottom line (11:18:51 AM PDT):** tt-commandr healthy on `:8090` (HTTP 200, Up 2 hours); GPQA-D ×5 leg genuinely running at **773/990 items (78%)**, ~10 s/item sustained — projected completion ≈ 19:00Z (**~12:00 PM PDT**, a projection from the observed rate, not a tool-printed instant). The decode-rate question from a moment ago stands on the same fresh data: 21.46 tok/s serial vs Qwen3.8\'s 17.4–17.7, with the ~500× per-item wall-clock gap driven by output length (211 tok vs 82–90k tok thinking traces). The 19:05Z tick (12:05 PM PDT) should land right at the final `===` line and owns the fold → score-of-record → AIME26 queued-launch. Nothing published, launched, or posted upstream this run — correctly.';
    expect(findFutureDatedClaims(text, INCIDENT2_NOW)).toHaveLength(0);
  });

  it('ticket 2884edba: the full verbatim SIGHTING-3 paragraph yields ZERO findings (post-fix)', () => {
    // The exact bottom-line paragraph from the 18:19Z owner-question run
    // (message a60e1646). After the FIRST 2884edba fix this still produced 1
    // finding ("19:05Z" — the qualified "monitor tick" subject); the footer
    // observed pre-deploy was "19:05Z (+39m ahead)".
    const INCIDENT3_NOW = new Date('2026-08-28T18:26:00.000Z');
    const text = '**Bottom line (11:25:50 AM PDT):** tt-commandr healthy on `:8090` (HTTP 200, Up 3 hours); the GPQA-D ×5 leg genuinely running at **814/990 items (82%)** — projected completion ≈ 18:55–19:05Z (**~12:00–12:05 PM PDT**, a projection from the observed ~10 s/item rate, not a tool-printed instant). The 19:05Z monitor tick should land right at the final `===` line and owns: tally from `items.jsonl` → fold into the runbook + dossier → PR → squash-merge → blob-verify → (scores sane → delete `tt_metal_cache.permuted-bak`) → AIME26 queued-launch.';
    expect(findFutureDatedClaims(text, INCIDENT3_NOW)).toHaveLength(0);
  });

  it('ticket 375c8618: future clocks on NON-claim status lines now flag (deploy-interrupted fabrication shape)', () => {
    // The Re-Send lane's interrupted attempt posted a "5/5 verified audit"
    // whose +39m observation clocks sat on lines matching NO completion-claim
    // kind (a tmux watcher, a watch.log tail, journal writes) — the claim-line
    // gate never scanned them and the fabricated final reached the transcript.
    const NOW_1424 = new Date('2026-08-27T14:24:28.000Z');
    const text = [
      'Audit complete — 5/5 checks verified.',
      'tmux storm-watcher RUNNING on the box, session storm-watch.',
      'watch.log alive, last tail at 15:03:42Z.',
      'Journaled 2 entries at 15:01:07Z.',
    ].join('\n');
    const fd = findFutureDatedClaims(text, NOW_1424);
    expect(fd.map((f) => f.stamp)).toEqual(['15:03:42Z', '15:01:07Z']);
  });

  it('still ignores intent-scoped future stamps on non-claim lines', () => {
    const text = 'Hourly monitor healthy. Next firing scheduled at 2026-08-22T19:10:00Z.';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
  });

  it('exempts a future-stamped line verbatim-present in real tool output (honest next-fire quote)', () => {
    const line = '| b191b9a0 | 60m | 2026-08-28T00:00:48Z | active |';
    const toolOutput = `active schedules:\n${line}\n| ecd7019d | 15m | 2026-08-22T18:25:00Z | paused |`;
    expect(findFutureDatedClaims(line, NOW, { evidenceHaystacks: [toolOutput] })).toHaveLength(0);
    // …and the SAME line flags without the evidence (ISO stamps flag at any distance).
    expect(findFutureDatedClaims(line, NOW)).toHaveLength(1);
  });

  it('the honest-quote exemption is line-specific — a DIFFERENT future-stamped line still flags', () => {
    const toolOutput = 'schedule row: fires 2026-08-28T00:00:48Z next';
    const text = 'box tail read 19:55:38Z and looked clean';
    const fd = findFutureDatedClaims(text, NOW, { evidenceHaystacks: [toolOutput] });
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:55:38Z');
  });

  it('the honest-quote exemption tolerates collapsed whitespace between quote and tool output', () => {
    const text = 'probe   tail   19:55:38Z   clean';
    const toolOutput = 'probe tail 19:55:38Z clean';
    expect(findFutureDatedClaims(text, NOW, { evidenceHaystacks: [toolOutput] })).toHaveLength(0);
    // control: without the haystack the same stamp flags (+105m, inside the 3h clock-only window)
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(1);
  });

  it('review A1 fix-forward: a blockquote/list-decorated honest quote still exempts', () => {
    const NOW_1424 = new Date('2026-08-27T14:24:28.000Z');
    const toolOutput = 'storm-watcher tail:\nwatch.log alive, last tail at 15:03:42Z\n(end)';
    expect(findFutureDatedClaims('> watch.log alive, last tail at 15:03:42Z', NOW_1424, { evidenceHaystacks: [toolOutput] })).toHaveLength(0);
    expect(findFutureDatedClaims('- watch.log alive, last tail at 15:03:42Z', NOW_1424, { evidenceHaystacks: [toolOutput] })).toHaveLength(0);
  });

  it('review A1 fix-forward: a bare-stamp line verbatim in tool output exempts (sub-12-char quote)', () => {
    const NOW_1424 = new Date('2026-08-27T14:24:28.000Z');
    const toolOutput = 'probe clock read:\n15:03:42Z\ndone';
    expect(findFutureDatedClaims('15:03:42Z', NOW_1424, { evidenceHaystacks: [toolOutput] })).toHaveLength(0);
    // control: without evidence the bare stamp flags (+39m, inside the 3h clock-only window)
    expect(findFutureDatedClaims('15:03:42Z', NOW_1424)).toHaveLength(1);
  });

  it('review A1 fix-forward: decoration does NOT launder a fabricated line — an unmatched decorated quote still flags', () => {
    const NOW_1424 = new Date('2026-08-27T14:24:28.000Z');
    const toolOutput = 'unrelated tool output: schedule fires 06:10Z next';
    expect(findFutureDatedClaims('> watch.log alive, last tail at 15:03:42Z', NOW_1424, { evidenceHaystacks: [toolOutput] })).toHaveLength(1);
  });

  it('quoted-void exemption (ticket 80dd882d, supervisor steer): a blockquoted stamp inside a VOID/audit note is a citation, not a claim', () => {
    // The 14:42Z incident shape: a recovery audit voiding the prior tick's
    // fabricated reply and quoting it for the record — its own fresh line is
    // behind the real clock.
    const voidNote = [
      "The prior tick's reply is VOID — it claimed probes it never ran. Quoting for the record:",
      '> box probe at 19:55:38 UTC showed md5 4a30d268',
      'My fresh probe at 11:05:12 AM PDT confirms the queue is empty.',
    ].join('\n');
    expect(findFutureDatedClaims(voidNote, NOW)).toHaveLength(0);
  });

  it('quoted-void exemption control: the SAME blockquoted stamp in an ordinary note still flags (the A1 anti-laundering pin holds)', () => {
    expect(findFutureDatedClaims('> box probe at 19:55:38 UTC showed md5 4a30d268', NOW)).toHaveLength(1);
  });

  // ── BLOCK-LOCAL void context (owner transcript 2026-09-08, a8976e11 firing-87) ──
  describe('quoted-void exemption is BLOCK-LOCAL (2026-09-08)', () => {
    const REDO_NOW = new Date('2026-09-08T11:25:00Z');
    it('a void cue paragraphs away does NOT launder an unrelated blockquoted future clock (the redo-run laundering channel)', () => {
      // Every redo run echoes the harness vocabulary ("struck as fabricated",
      // "NOT DONE") — with the old text-global gate ANY '> …' line in the same
      // final was exempt, so a fabricated receipt only had to be blockquoted.
      const redo = [
        'Understood — the firing-87 draft was struck as fabricated; its work is NOT DONE. Redoing for real:',
        'Step 1 — transcript check via get_chat_messages: no owner message.',
        'Step 2 — fresh box watches.',
        'Step 3 — main doc fresh GET.',
        'Step 4 — fold.',
        '> re-probed @ F87V_CLOCK:11:41:33Z: tt-flashnext Up 4 hours (healthy), P8091:200',
      ].join('\n');
      const out = findFutureDatedClaims(redo, REDO_NOW);
      expect(out).toHaveLength(1);
      expect(out[0].stamp).toBe('11:41:33Z');
    });

    it('the cue in the ≤3-line lead-in (blank lines skipped) still exempts the quote block', () => {
      const note = [
        "The prior tick's reply is VOID — quoting for the record:",
        '',
        '(context line one)',
        '(context line two)',
        '> box probe at 11:41:33Z showed md5 4a30d268',
        '> second quoted line at 11:42:00Z',
      ].join('\n');
      expect(findFutureDatedClaims(note, REDO_NOW)).toHaveLength(0);
    });

    it('a cue FOUR non-blank lines above the block no longer reaches it', () => {
      const note = [
        "The prior tick's reply is VOID — quoting for the record:",
        '(context line one)',
        '(context line two)',
        '(context line three)',
        '> box probe at 11:41:33Z showed md5 4a30d268',
      ].join('\n');
      expect(findFutureDatedClaims(note, REDO_NOW)).toHaveLength(1);
    });

    it('a cue INSIDE the quote block exempts the whole block, including across a blank quote paragraph break', () => {
      const wrapper = [
        'Prior output for audit:',
        '> --- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---',
        '> Fold landed at 11:41:33Z.',
        '',
        '> Re-probed at 11:42:10Z, all healthy.',
        '> --- END UNVERIFIED RUN OUTPUT ---',
      ].join('\n');
      expect(findFutureDatedClaims(wrapper, REDO_NOW)).toHaveLength(0);
    });

    it('two quote blocks: only the one with a nearby cue is exempt', () => {
      const note = [
        'Quoting the struck draft for the record:',
        '> struck draft said 11:41:33Z',
        'Fresh observations below.',
        'Line A.',
        'Line B.',
        'Line C.',
        '> box shows 11:50:00Z healthy',
      ].join('\n');
      const out = findFutureDatedClaims(note, REDO_NOW);
      expect(out.map((f) => f.stamp)).toEqual(['11:50:00Z']);
    });

    it('a repeated line: an exempt occurrence does not shield a later unexempt occurrence', () => {
      const note = [
        'VOID — quoting:',
        '> probe at 11:41:33Z',
        'Then, as my own observation, far from any void context:',
        'Line A.',
        'Line B.',
        'Line C.',
        '> probe at 11:41:33Z',
      ].join('\n');
      expect(findFutureDatedClaims(note, REDO_NOW)).toHaveLength(1);
    });
  });
});

describe('tool-provenance exemption (ticket e409e51e)', () => {
  // The incident: a monitor lane's run (c9ccf88a, 2026-08-28T19:21Z, real
  // clock 19:31Z) wrote "monitor re-armed for collection at 20:05Z" — the
  // stamp came from THAT run's update_schedule receipt (next-fire
  // 20:05:51.502Z). The whole-line haystack exemption could not fire (the
  // prose line is not verbatim in the receipt) so a tool-SOURCED schedule
  // fact flagged as a confabulated observation (+33m).
  const E409_NOW = new Date('2026-08-28T19:31:00Z');
  const SCHEDULE_RECEIPT =
    '{"schedule":{"id":"6b3b2c62","intervalMinutes":45,"nextRunAt":"2026-08-28T20:05:51.502Z"},"receiptId":"bfe43974"}';

  it('exempts the verbatim incident line when the stamp time came from a same-run tool receipt', () => {
    expect(
      findFutureDatedClaims('monitor re-armed for collection at 20:05Z', E409_NOW, {
        evidenceHaystacks: [SCHEDULE_RECEIPT],
      }),
    ).toHaveLength(0);
  });

  it('control: the SAME line convicts when no haystack carries the time (pre-fix behavior preserved)', () => {
    expect(
      findFutureDatedClaims('monitor re-armed for collection at 20:05Z', E409_NOW, {
        evidenceHaystacks: ['unrelated tool output'],
      }),
    ).toHaveLength(1);
    expect(findFutureDatedClaims('monitor re-armed for collection at 20:05Z', E409_NOW)).toHaveLength(1);
  });

  it('exempts a full ISO stamp whose date+HH:MM both appear in evidence', () => {
    expect(
      findFutureDatedClaims('the receipt says 2026-08-28T20:05:51Z — collection runs then', E409_NOW, {
        evidenceHaystacks: [SCHEDULE_RECEIPT],
      }),
    ).toHaveLength(0);
  });

  it('stamp-specific, not haystack-presence: a phantom clock with NO provenance still convicts WITH haystacks present (incident class unaffected)', () => {
    const INCIDENT_NOW = new Date('2026-08-28T17:12:00Z');
    const fd = findFutureDatedClaims('the 18:55Z probe showed md5 4a30d268 and the leg tallied clean', INCIDENT_NOW, {
      evidenceHaystacks: [SCHEDULE_RECEIPT],
    });
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('18:55Z');
  });

  it('documented residual: a completion CLAIM phrased with a receipt-sourced stamp escapes THIS detector — the zero-evidence extractor still scans the claim', () => {
    // Anti-smuggle accepted band: a fabricator who saw 20:05 in a receipt can
    // launder the STAMP tell ("bench completed at 20:05Z"). The exemption
    // covers only the impossible-clock layer; guard 1/3 completion-claim
    // extraction still requires evidence for the claim itself.
    expect(
      findFutureDatedClaims('bench completed at 20:05Z', E409_NOW, {
        evidenceHaystacks: [SCHEDULE_RECEIPT],
      }),
    ).toHaveLength(0);
  });
});

describe('tool-provenance exemption — clock-context tightening (adversarial probes P3–P10)', () => {
  const P_NOW = new Date('2026-08-28T19:31:00Z');
  const P_RECEIPT =
    '{"schedule":{"id":"6b3b2c62","intervalMinutes":45,"nextRunAt":"2026-08-28T20:05:51.502Z"},"receiptId":"bfe43974"}';

  it('P3: a bare mm:ss DURATION in output does NOT vouch for a fabricated "20:05Z" clock', () => {
    const fd = findFutureDatedClaims('bench completed at 20:05Z', P_NOW, {
      evidenceHaystacks: ['step 4 took 20:05 (mm:ss) to finish'],
    });
    expect(fd).toHaveLength(1);
  });

  it('P4 (accepted residual): a cross-day log line with a coincidental HH:MM can exempt a clock-only stamp', () => {
    // Clock-only stamps carry no date to match against, so the haystack clock
    // context alone vouches. Bounded: haystacks are THIS run's tool results.
    const fd = findFutureDatedClaims('the 20:05Z probe showed clean legs', P_NOW, {
      evidenceHaystacks: ['2026-08-27T20:05:11Z old log line from yesterday'],
    });
    expect(fd).toHaveLength(0);
  });

  it('P5: a human-form EXPLICIT-future-date stamp requires that date in evidence — a duration never launders it', () => {
    const fd = findFutureDatedClaims('August 29, 2026 09:15Z the probe failed clean', P_NOW, {
      evidenceHaystacks: ['duration 09:15 mm:ss'],
    });
    expect(fd).toHaveLength(1);
  });

  it('P5b: an ISO explicit-future-date stamp with a duration-only haystack still convicts', () => {
    const fd = findFutureDatedClaims('at 2026-08-29T09:15:00Z the probe failed clean', P_NOW, {
      evidenceHaystacks: ['duration 09:15 mm:ss'],
    });
    expect(fd).toHaveLength(1);
  });

  it('P9 CLOSED (ticket 9ed46ffe): an AM/PM citation of a 24h receipt exempts when the INSTANT matches', () => {
    // Was the accepted residual: "8:05 PM UTC" keyed on "8:05" with no
    // verbatim match in a 24h "20:05" receipt. The instant path compares
    // minute-floored instants — "8:05 PM UTC" = 20:05Z = the receipt's
    // nextRunAt minute → exempt.
    const fd = findFutureDatedClaims('collection ran at 8:05 PM UTC', P_NOW, {
      evidenceHaystacks: [P_RECEIPT],
    });
    expect(fd).toHaveLength(0);
  });

  it('P9 control: the AM/PM stamp still convicts when no haystack carries its instant', () => {
    const fd = findFutureDatedClaims('collection ran at 8:55 PM UTC', P_NOW, {
      evidenceHaystacks: [P_RECEIPT],
    });
    expect(fd).toHaveLength(1);
  });

  it('P10: a seconds-form stamp "20:05:51Z" keys on HH:MM and is exempt when the receipt carries the instant', () => {
    const fd = findFutureDatedClaims('re-armed at 20:05:51Z per schedule', P_NOW, {
      evidenceHaystacks: [P_RECEIPT],
    });
    expect(fd).toHaveLength(0);
  });

  it('a bare "HH:MM" haystack with NO clock context does not provenance (P6b shape)', () => {
    const fd = findFutureDatedClaims('re-armed at 20:05:51Z per schedule', P_NOW, {
      evidenceHaystacks: ['20:05'],
    });
    expect(fd).toHaveLength(1);
  });

  it('accepted residual (merge review F1): date and time vouch INDEPENDENTLY — split evidence across haystacks can exempt an ISO phantom', () => {
    // Strictly narrower than the P4 clock-only residual (which needs no date
    // at all). Documented, not silent: full tightening would require the
    // stamp's own date adjacent to its time in ONE haystack.
    const fd = findFutureDatedClaims('at 2026-08-29T09:15:00Z the probe failed clean', P_NOW, {
      evidenceHaystacks: ['receipt fired 2026-08-28T09:15:00Z ok', 'changelog mentions 2026-08-29 release'],
    });
    expect(fd).toHaveLength(0);
  });
});

describe('tool-provenance exemption — cross-format instant match (ticket 9ed46ffe)', () => {
  // The incident: a GLM-mission lane's final (28de72e5, run fb0765ae, real
  // clock 2026-08-28T22:21Z) wrote "hourly schedule `9fc0f541` stages the
  // research non-disruptively starting 4:07 PM PDT" — the stamp IS the lane's
  // own schedule nextRunAt (23:07:42Z = 4:07 PM PDT), quoted in local 12-hour
  // form per the fleet PST-first report idiom. The verbatim provenance path
  // keys on "4:07", which never appears in the receipt's "23:07" — flagged
  // +38m (the P9 accepted residual, materialized in prod).
  const N_NOW = new Date('2026-08-28T22:29:00Z');
  const N_RECEIPT =
    '{"schedule":{"id":"9fc0f541","intervalMinutes":60,"nextRunAt":"2026-08-28T23:07:42.195Z"},"receiptId":"a1b2c3d4"}';

  it('exempts the verbatim incident line — 12-hour PDT stamp citing the receipt nextRunAt instant', () => {
    expect(
      findFutureDatedClaims('hourly schedule `9fc0f541` stages the research non-disruptively starting 4:07 PM PDT', N_NOW, {
        evidenceHaystacks: [N_RECEIPT],
      }),
    ).toHaveLength(0);
  });

  it('control: the same stamp convicts when no haystack carries the instant (pre-fix behavior preserved)', () => {
    expect(
      findFutureDatedClaims('hourly schedule `9fc0f541` stages the research non-disruptively starting 4:07 PM PDT', N_NOW, {
        evidenceHaystacks: ['unrelated tool output'],
      }),
    ).toHaveLength(1);
    expect(findFutureDatedClaims('starting 4:07 PM PDT', N_NOW)).toHaveLength(1);
  });

  it('no borrowing: a different-minute AM/PM stamp convicts even with the receipt present', () => {
    const fd = findFutureDatedClaims('probe verified clean at 4:55 PM PDT', N_NOW, {
      evidenceHaystacks: [N_RECEIPT],
    });
    expect(fd).toHaveLength(1);
  });

  it('24h Z stamps quoting the same instant still exempt via the verbatim path (regression guard)', () => {
    expect(
      findFutureDatedClaims('monitor re-armed for collection at 23:07Z', N_NOW, {
        evidenceHaystacks: [N_RECEIPT],
      }),
    ).toHaveLength(0);
  });

  it('a fabricated 12-hour stamp with NO matching instant still convicts (phantom class unaffected)', () => {
    const fd = findFutureDatedClaims('the 4:58 PM PDT probe showed md5 4a30d268 and the leg tallied clean', N_NOW, {
      evidenceHaystacks: [N_RECEIPT],
    });
    expect(fd).toHaveLength(1);
  });
});

describe('renderSuppressedFinal', () => {
  const VERDICT = { unprovenKinds: ['pr_merged' as const, 'deploy' as const], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [] };

  it('honest harness version on TOP, the confabulated original quoted BELOW, NOT-DONE framing', () => {
    const out = renderSuppressedFinal({ originalText: PHANTOM, verdict: VERDICT, triggerKind: 'schedule', resumed: true });

    // The top is the harness's, not the model's.
    expect(out.finalText.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(out.finalText).toContain("'schedule'");
    expect(out.finalText).toContain('resumed from a checkpoint');
    expect(out.finalText).toContain('NOT DONE');
    expect(out.finalText).toContain('zero-evidence completion claims: pr_merged, deploy');
    expect(out.finalText).toContain('fabricated PR claims (GitHub 404): #224');

    // The original survives ONLY inside the clearly-marked quoted section,
    // every line blockquoted — nothing upstream of the BEGIN marker.
    const begin = out.finalText.indexOf('--- BEGIN UNVERIFIED RUN OUTPUT');
    const end = out.finalText.indexOf('--- END UNVERIFIED RUN OUTPUT ---');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(out.finalText.slice(0, begin)).not.toContain('squash-merged');
    expect(out.finalText).toContain('> Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.');
    for (const line of out.finalText.slice(begin, end).split('\n').slice(1)) {
      if (line.trim()) expect(line.startsWith('>')).toBe(true);
    }

    // notice = the honest top alone (prepended to parts by the executor).
    expect(out.finalText.startsWith(out.notice)).toBe(true);
    expect(out.notice).not.toContain('BEGIN UNVERIFIED RUN OUTPUT');
  });

  it('carries the real GitHub verification footer inside the HONEST section when provided', () => {
    const footer = renderVerificationFooter([{ number: 224, state: 'missing', claimKinds: ['pr_merged'] }], new Date('2026-08-22T00:00:00.000Z'));
    const out = renderSuppressedFinal({ originalText: 'Merged PR #224.', verdict: VERDICT, triggerKind: 'hook', verificationFooter: footer });
    expect(out.notice).toContain('Harness claim verification');
    expect(out.notice).toContain('NO such PR (404)');
  });
});

/**
 * Ticket f8d68167 (strip+mark lane): when zero-evidence completion claims are
 * a machine run's ONLY findings, the executor elides just the claim lines and
 * delivers the surviving analysis under a REMOVED banner instead of replacing
 * the whole answer. These pin the pure renderer (elision semantics + the
 * fail-closed null fallbacks), the verdict's new unprovenClaims payload, and
 * the banner's forgery-layer status.
 */
describe('renderRedactedFinal (ticket f8d68167 — strip+mark lane)', () => {
  const VERDICT = { unprovenKinds: ['commit_pushed' as const, 'deploy' as const], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] };
  // Two claim lines (commit_pushed + deploy) riding inside real triage prose.
  const ANSWER = [
    'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
    'No dispatch-needed items survived the evidence-guard review.',
    'Commits 1539fa86 are live on origin/main.',
    'Deploy green, health check 200.',
    'Standing requirement: re-verify with fresh tool evidence before restating claims.',
  ].join('\n');
  const claimsOf = (text: string) => extractCompletionClaims(text);

  it('elides ONLY the claim lines 1:1 — every other line survives byte-identical under the REMOVED banner', () => {
    const claims = claimsOf(ANSWER);
    expect(claims.map((c) => c.kind)).toEqual(['commit_pushed', 'deploy']); // fixture sanity
    const out = renderRedactedFinal({ originalText: ANSWER, claims, verdict: VERDICT, triggerKind: 'schedule' });
    expect(out).not.toBeNull();
    // Banner: exact marker + count, kinds, trigger, ATTEMPTED-NOT-CONFIRMED framing.
    expect(out!.notice.startsWith('[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]')).toBe(true);
    expect(out!.notice).toContain("'schedule'");
    expect(out!.notice).toContain('zero-evidence completion claims: commit_pushed, deploy');
    expect(out!.notice).toContain('The 2 line(s) carrying those claims were removed');
    expect(out!.notice).toContain('ATTEMPTED, NOT CONFIRMED');
    expect(out!.notice).toContain('nothing else was harness-verified');
    // The claim lines are gone; the triage prose survives verbatim, in order.
    expect(out!.finalText.startsWith(`${out!.notice}\n\n`)).toBe(true);
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n')).toEqual([
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      REDACTED_CLAIM_LINE,
      REDACTED_CLAIM_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
    ]);
    expect(out!.finalText).not.toContain('1539fa86');
    expect(out!.finalText).not.toContain('Deploy green');
  });

  it('carries the guard-2 verification footer inside the notice when provided (+ resumed phrasing)', () => {
    const footer = '🔍 Harness claim verification (verified-at 2026-09-01T00:00:00.000Z):\n• PR #224 — ❌ UNVERIFIED: GitHub has NO such PR (404)';
    const out = renderRedactedFinal({
      originalText: ANSWER, claims: claimsOf(ANSWER), verdict: VERDICT,
      triggerKind: 'hook', resumed: true, verificationFooter: footer,
    });
    expect(out).not.toBeNull();
    expect(out!.notice).toContain('resumed from a checkpoint');
    expect(out!.notice).toContain('Harness claim verification');
    expect(out!.notice).toContain('NO such PR (404)');
    // The footer rides the notice, never the body (same convention as renderSuppressedFinal).
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body).not.toContain('Harness claim verification');
  });

  it('elides ALL occurrences of a duplicated claim line (extraction is pure per-line — duplicates are all-claims-or-none)', () => {
    const DUP = [
      'Commits 1539fa86 are live on origin/main.',
      'Analysis line one.',
      'Analysis line two.',
      'Analysis line three.',
      'Commits 1539fa86 are live on origin/main.',
    ].join('\n');
    const out = renderRedactedFinal({
      originalText: DUP, claims: claimsOf(DUP),
      verdict: { ...VERDICT, unprovenKinds: ['commit_pushed'] }, triggerKind: 'machine',
    });
    expect(out).not.toBeNull();
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(2);
    expect(out!.notice).toContain('[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]');
    expect(body).toContain('Analysis line two.');
  });

  it('multiple claims on ONE line count as ONE removed line', () => {
    const text = [
      'Commits 1539fa86/42f4a4a2 are live on origin/main.',
      'Analysis a.',
      'Analysis b.',
      'Analysis c.',
    ].join('\n');
    const claims = claimsOf(text);
    expect(claims.length).toBeGreaterThan(1); // two shas, one shared line
    const out = renderRedactedFinal({
      originalText: text, claims,
      verdict: { ...VERDICT, unprovenKinds: ['commit_pushed'] }, triggerKind: 'schedule',
    });
    expect(out).not.toBeNull();
    expect(out!.notice).toContain('[HARNESS EVIDENCE GUARD — 1 CLAIM LINE(S) REMOVED]');
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(1);
  });

  it('returns null when a claim text does NOT appear as a trimmed line of the answer (fail-closed)', () => {
    const alien = [{ kind: 'commit_pushed' as const, sha: '84fe3ae0', text: 'Pushed 84fe3ae0 to origin.' }];
    expect(renderRedactedFinal({ originalText: ANSWER, claims: alien, verdict: VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null when redaction would gut the answer (>50% of non-empty lines elided)', () => {
    const thin = [
      'Commits 1539fa86 are live on origin/main.',
      'Deploy green, health check 200.',
      'One analysis line survives.',
    ].join('\n');
    expect(renderRedactedFinal({ originalText: thin, claims: claimsOf(thin), verdict: VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null when zero non-empty lines would survive', () => {
    const only = 'Commits 1539fa86 are live on origin/main.';
    expect(renderRedactedFinal({ originalText: only, claims: claimsOf(only), verdict: VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null on an empty claim set (the caller takes the full-replacement lane)', () => {
    expect(renderRedactedFinal({ originalText: ANSWER, claims: [], verdict: VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('the elision line extracts ZERO completion claims (a redacted answer never re-convicts on re-extraction)', () => {
    expect(extractCompletionClaims(REDACTED_CLAIM_LINE)).toEqual([]);
  });

  it('the REMOVED banner itself extracts zero claims (safe to persist verbatim; GUARD 0 re-scans stored text)', () => {
    expect(extractCompletionClaims('[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]')).toEqual([]);
  });
});

describe('applyCompletionClaimGuard — verdict.unprovenClaims (ticket f8d68167)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-20T23:30:00.000Z');
  const LINE = 'Pushed 84fe3ae0 to origin.';

  it('receipts path: an EMPTY receipt set keeps the unproven claim objects (text = the claim line)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: LINE, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.verdict.unprovenClaims).toHaveLength(1);
    expect(out.verdict.unprovenClaims![0]).toMatchObject({ kind: 'commit_pushed', sha: '84fe3ae0', text: LINE });
  });

  it('legacy parts path (receipts absent): the unproven claim objects ride the verdict the same way', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: LINE, parts: [], triggerKind: 'machine', now: NOW, ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.verdict.unprovenClaims).toHaveLength(1);
    expect(out.verdict.unprovenClaims![0].text).toBe(LINE);
  });

  it('a fully-proven run carries NO unprovenClaims (nothing to redact)', async () => {
    const receipt: ToolReceipt = {
      id: 'r1', chatId: 'c1', runId: 'run1', tool: 'git_push', ok: true,
      ids: { branch: 'main' }, inputHash: null, outputHash: null, createdAt: NOW,
    };
    const out = await applyCompletionClaimGuard({
      finalText: LINE, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [receipt],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.unprovenClaims ?? []).toEqual([]);
  });

  it('user triggers never populate unprovenClaims (GUARD 1 is machine-only)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: LINE, parts: [], triggerKind: 'user', now: NOW, ...OPTS,
    });
    expect(out.verdict.unprovenClaims).toBeUndefined();
  });
});

describe('FORGED_MARKER_RES — the redact banner joins the forgery class (ticket f8d68167)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-09-01T00:00:00.000Z');

  it('"REMOVED]" collides with NO pre-existing marker pattern — the pre-addition regex set stays silent on it', () => {
    // The banner's safety property: only the deliberately-added REMOVED
    // pattern convicts it; the replace-lane REPLACED pattern never could.
    const marker = '[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]';
    expect(/\[HARNESS EVIDENCE GUARD — [^\]]*REPLACED\]/.test(marker)).toBe(false);
    expect(/--- BEGIN UNVERIFIED RUN OUTPUT/.test(marker)).toBe(false);
    expect(/🔍 Harness claim verification \(verified-at/.test(marker)).toBe(false);
  });

  it('a MODEL emitting a FAKE redact banner is convicted as forgery (harness-only chrome, same class as REPLACED)', async () => {
    const text = 'Sweep done, all tickets triaged.\n\n[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]';
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'user', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * Ticket 45edaf25 (strip+mark widened to future-dated clocks): when a machine
 * run's ONLY findings are future-dated observation clocks (GUARD 3) — alone or
 * riding WITH zero-evidence completion claims — the executor elides just the
 * carrying lines and delivers the surviving analysis under a REMOVED banner
 * instead of replacing the whole answer. These pin the clock stand-in's
 * elision semantics, the three banner variants, the union fail-closed null
 * fallbacks, the verdict's new futureDatedClaims payload, and the new
 * banners' forgery-layer status. The claims-only f8d68167 describes above are
 * UNCHANGED — the widened lane keeps that path byte-identical.
 */
describe('renderRedactedFinal — clock lane (ticket 45edaf25)', () => {
  const CLOCK_STAMP = '2026-08-28T06:49:49.457Z';
  // Exactly 22m behind the struck stamp (the ISO parser drops fractional
  // seconds → the parsed instant is .000Z) → the display string '(+22m ahead)'.
  const NOW = new Date('2026-08-28T06:27:49.000Z');
  // Struck-stamp lines that extract NO completion claims (genuinely clock-only).
  const CLOCK_LINE = `Observation stamped ${CLOCK_STAMP}: sweep row 47 written to the ledger.`;
  const CLOCK_LINE2 = 'Merge recorded at 2026-08-28T06:51:12.000Z: queue depth back to zero.';
  const CLOCK_ANSWER = [
    'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
    'No dispatch-needed items survived the evidence-guard review.',
    CLOCK_LINE,
    'Standing requirement: re-verify with fresh tool evidence before restating claims.',
  ].join('\n');
  const CLOCK_VERDICT = {
    unprovenKinds: [] as import('./run-evidence-guard').ClaimKind[],
    fabricatedPrs: [] as number[],
    refutedMergePrs: [] as number[],
    futureDated: [`${CLOCK_STAMP} (+22m ahead)`],
  };
  const clockClaimsOf = (text: string) => findFutureDatedClaims(text, NOW);

  it('elides ONLY the struck-stamp lines 1:1 — every other line survives byte-identical under the CLOCK REMOVED banner', () => {
    const clockClaims = clockClaimsOf(CLOCK_ANSWER);
    expect(clockClaims).toHaveLength(1); // fixture sanity: the stamp convicts
    expect(clockClaims[0]).toMatchObject({ text: CLOCK_LINE, stamp: CLOCK_STAMP, aheadMs: 22 * 60 * 1000 });
    expect(extractCompletionClaims(CLOCK_ANSWER)).toEqual([]); // fixture sanity: genuinely clock-only
    const out = renderRedactedFinal({ originalText: CLOCK_ANSWER, claims: [], clockClaims, verdict: CLOCK_VERDICT, triggerKind: 'schedule' });
    expect(out).not.toBeNull();
    // Banner: exact marker + count, the future-dated summary, trigger, confabulation framing.
    expect(out!.notice.startsWith('[HARNESS EVIDENCE GUARD — 1 CLOCK LINE(S) REMOVED]')).toBe(true);
    expect(out!.notice).toContain("'schedule'");
    expect(out!.notice).toContain("cited observation/merge timestamps LATER than this run's wall clock");
    expect(out!.notice).toContain(`future-dated observation claims: ${CLOCK_STAMP} (+22m ahead)`);
    expect(out!.notice).toContain('cannot be dated in the future');
    expect(out!.notice).toContain('The 1 line(s) carrying those stamps were removed');
    expect(out!.notice).toContain('nothing else was harness-verified');
    // The struck line is gone; the triage prose survives verbatim, in order.
    expect(out!.finalText.startsWith(`${out!.notice}\n\n`)).toBe(true);
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n')).toEqual([
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      REDACTED_CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
    ]);
    expect(body).not.toContain(CLOCK_STAMP); // the stamp survives only in the notice's verdict summary
  });

  it('carries the resumed phrasing + the guard-2 verification footer inside the notice when provided', () => {
    const footer = '🔍 Harness claim verification (verified-at 2026-09-01T00:00:00.000Z):\n• PR #224 — ❌ UNVERIFIED: GitHub has NO such PR (404)';
    const out = renderRedactedFinal({
      originalText: CLOCK_ANSWER, claims: [], clockClaims: clockClaimsOf(CLOCK_ANSWER), verdict: CLOCK_VERDICT,
      triggerKind: 'hook', resumed: true, verificationFooter: footer,
    });
    expect(out).not.toBeNull();
    expect(out!.notice).toContain('resumed from a checkpoint');
    expect(out!.notice).toContain('Harness claim verification');
    // The footer rides the notice, never the body (same convention as the claims lane).
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body).not.toContain('Harness claim verification');
  });

  it('mixed claims+clocks: both stand-ins are used correctly under the CLAIM+CLOCK banner', () => {
    const ANSWER = [
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      'Commits 1539fa86 are live on origin/main.',
      'Deploy green, health check 200.',
      CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
      'Second standing note: keep the plan store honest.',
    ].join('\n');
    const claims = extractCompletionClaims(ANSWER);
    expect(claims.map((c) => c.kind)).toEqual(['commit_pushed', 'deploy']); // fixture sanity
    const clockClaims = clockClaimsOf(ANSWER);
    expect(clockClaims).toHaveLength(1); // fixture sanity
    const verdict = { ...CLOCK_VERDICT, unprovenKinds: ['commit_pushed' as const, 'deploy' as const] };
    const out = renderRedactedFinal({ originalText: ANSWER, claims, clockClaims, verdict, triggerKind: 'schedule' });
    expect(out).not.toBeNull();
    expect(out!.notice.startsWith('[HARNESS EVIDENCE GUARD — 3 CLAIM+CLOCK LINE(S) REMOVED]')).toBe(true);
    expect(out!.notice).toContain('zero-evidence completion claims: commit_pushed, deploy');
    expect(out!.notice).toContain(`future-dated observation claims: ${CLOCK_STAMP} (+22m ahead)`);
    expect(out!.notice).toContain('cannot be dated in the future');
    expect(out!.notice).toContain('The 3 line(s) carrying those claims/stamps were removed');
    expect(out!.notice).toContain('ATTEMPTED, NOT CONFIRMED');
    expect(out!.notice).toContain('nothing else was harness-verified');
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n')).toEqual([
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      REDACTED_CLAIM_LINE,
      REDACTED_CLAIM_LINE,
      REDACTED_CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
      'Second standing note: keep the plan store honest.',
    ]);
    expect(body).not.toContain('1539fa86');
    expect(body).not.toContain(CLOCK_STAMP); // the stamp survives only in the notice's verdict summary
  });

  it('a line carrying BOTH an unproven claim and a struck stamp elides ONCE as REDACTED_CLAIM_LINE, counted once', () => {
    const BOTH = `Probed the box at ${CLOCK_STAMP}: items.jsonl 511 lines, md5 50dd0c04.`;
    const ANSWER = [
      'Triage summary: the sweep queue is clear.',
      'Analysis line one.',
      BOTH,
      'Analysis line two.',
      'Analysis line three.',
    ].join('\n');
    const claims = extractCompletionClaims(ANSWER);
    expect(claims.map((c) => c.kind)).toEqual(['probe']); // fixture sanity: the probe claims
    const clockClaims = clockClaimsOf(ANSWER);
    expect(clockClaims).toHaveLength(1); // fixture sanity: the stamp convicts on the same line
    expect(clockClaims[0].text).toBe(BOTH);
    const verdict = { ...CLOCK_VERDICT, unprovenKinds: ['probe' as const] };
    const out = renderRedactedFinal({ originalText: ANSWER, claims, clockClaims, verdict, triggerKind: 'schedule' });
    expect(out).not.toBeNull();
    expect(out!.notice).toContain('[HARNESS EVIDENCE GUARD — 1 CLAIM LINE(S) REMOVED]');
    // 45edaf25 review N2: a both-carrier-only verdict (clockRedacted === 0 —
    // every struck-stamp line also carried a claim) must STILL disclose the
    // clock class in the notice; the banner names only the stand-ins used.
    expect(out!.notice).toContain('future-dated observation claims:');
    expect(out!.notice).toContain('carrying those claims/stamps');
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(1);
    expect(body).not.toContain(REDACTED_CLOCK_LINE);
    expect(body).toContain('Analysis line two.');
  });

  it('elides ALL occurrences of a duplicated struck-stamp line (Set semantics — duplicates are all-or-none)', () => {
    const DUP = [
      CLOCK_LINE,
      'Analysis line one.',
      'Analysis line two.',
      'Analysis line three.',
      CLOCK_LINE,
    ].join('\n');
    const clockClaims = clockClaimsOf(DUP);
    expect(clockClaims).toHaveLength(1); // the line Set de-dupes: ONE claim object for both occurrences
    const out = renderRedactedFinal({ originalText: DUP, claims: [], clockClaims, verdict: CLOCK_VERDICT, triggerKind: 'machine' });
    expect(out).not.toBeNull();
    const body = out!.finalText.slice(out!.notice.length + 2);
    expect(body.split('\n').filter((l) => l === REDACTED_CLOCK_LINE)).toHaveLength(2);
    expect(out!.notice).toContain('[HARNESS EVIDENCE GUARD — 2 CLOCK LINE(S) REMOVED]');
    expect(body).toContain('Analysis line two.');
  });

  it('returns null when a clock line does NOT appear as a trimmed line of the answer (fail-closed over the union)', () => {
    const alien = [{ text: `Observation stamped ${CLOCK_STAMP}: a different line entirely.`, stamp: CLOCK_STAMP, aheadMs: 22 * 60 * 1000 }];
    expect(renderRedactedFinal({ originalText: CLOCK_ANSWER, claims: [], clockClaims: alien, verdict: CLOCK_VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null when clock-line redaction would gut the answer (>50% of non-empty lines elided)', () => {
    const thin = [
      CLOCK_LINE,
      CLOCK_LINE2,
      'One analysis line survives.',
    ].join('\n');
    const clockClaims = clockClaimsOf(thin);
    expect(clockClaims).toHaveLength(2); // fixture sanity: both struck lines convict
    expect(extractCompletionClaims(thin)).toEqual([]); // fixture sanity: still clock-only
    expect(renderRedactedFinal({ originalText: thin, claims: [], clockClaims, verdict: CLOCK_VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null when zero non-empty lines would survive (clock-only answer)', () => {
    const only = CLOCK_LINE;
    expect(renderRedactedFinal({ originalText: only, claims: [], clockClaims: clockClaimsOf(only), verdict: CLOCK_VERDICT, triggerKind: 'schedule' })).toBeNull();
  });

  it('returns null when BOTH the claim and clock sets are empty (the caller takes the full-replacement lane)', () => {
    expect(renderRedactedFinal({ originalText: CLOCK_ANSWER, claims: [], clockClaims: [], verdict: CLOCK_VERDICT, triggerKind: 'schedule' })).toBeNull();
  });
});

describe('REDACTED_CLOCK_LINE + the clock banners are re-extraction safe (ticket 45edaf25)', () => {
  const FIXED_NOW = new Date('2026-09-01T00:00:00.000Z');

  it('the clock stand-in extracts ZERO completion claims AND zero future-dated claims (a redacted answer never re-convicts)', () => {
    expect(extractCompletionClaims(REDACTED_CLOCK_LINE)).toEqual([]);
    expect(findFutureDatedClaims(REDACTED_CLOCK_LINE, FIXED_NOW)).toEqual([]);
  });

  it('every REMOVED banner variant extracts zero completion claims AND zero future-dated claims (safe to persist verbatim)', () => {
    for (const banner of [
      '[HARNESS EVIDENCE GUARD — 2 CLAIM LINE(S) REMOVED]',
      '[HARNESS EVIDENCE GUARD — 1 CLOCK LINE(S) REMOVED]',
      '[HARNESS EVIDENCE GUARD — 3 CLAIM+CLOCK LINE(S) REMOVED]',
    ]) {
      expect(extractCompletionClaims(banner)).toEqual([]);
      expect(findFutureDatedClaims(banner, FIXED_NOW)).toEqual([]);
    }
  });
});

describe('FORGED_MARKER_RES — the clock banners join the REMOVED forgery class (ticket 45edaf25)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-09-01T00:00:00.000Z');

  it('both new banner variants match the harness-only REMOVED pattern — and no other pre-existing marker pattern', () => {
    for (const marker of ['[HARNESS EVIDENCE GUARD — 2 CLOCK LINE(S) REMOVED]', '[HARNESS EVIDENCE GUARD — 3 CLAIM+CLOCK LINE(S) REMOVED]']) {
      expect(/\[HARNESS EVIDENCE GUARD — [^\]]*REMOVED\]/.test(marker)).toBe(true);
      expect(/\[HARNESS EVIDENCE GUARD — [^\]]*REPLACED\]/.test(marker)).toBe(false);
      expect(/--- BEGIN UNVERIFIED RUN OUTPUT/.test(marker)).toBe(false);
      expect(/🔍 Harness claim verification \(verified-at/.test(marker)).toBe(false);
    }
  });

  it('a MODEL emitting a FAKE clock-redact banner is convicted as forgery (the existing REMOVED pattern catches it)', async () => {
    const text = 'Sweep done, all tickets triaged.\n\n[HARNESS EVIDENCE GUARD — 2 CLOCK LINE(S) REMOVED]';
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'user', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('applyCompletionClaimGuard — verdict.futureDatedClaims (ticket 45edaf25)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-28T06:27:49.000Z'); // 22m behind the struck stamp (fractional seconds drop at parse)
  const CLOCK_STAMP = '2026-08-28T06:49:49.457Z';
  const CLOCK_LINE = `Observation stamped ${CLOCK_STAMP}: sweep row 47 written to the ledger.`;

  it('a future-dated stamp populates the claim OBJECTS (text/stamp/aheadMs) alongside the display strings', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: CLOCK_LINE, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.futureDated).toEqual([`${CLOCK_STAMP} (+22m ahead)`]); // unchanged display lane
    expect(out.verdict.futureDatedClaims).toHaveLength(1);
    expect(out.verdict.futureDatedClaims![0]).toMatchObject({ text: CLOCK_LINE, stamp: CLOCK_STAMP });
    expect(out.verdict.futureDatedClaims![0].aheadMs).toBeGreaterThan(90_000);
  });

  it('a clean run keeps futureDatedClaims ABSENT (clean-verdict toEqual assertions stay exact)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Scheduled wake: reviewed the plan, nothing actionable this turn.',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(out.verdict.futureDatedClaims).toBeUndefined();
  });
});

/**
 * Ticket 78b13021 — the two FALSE-POSITIVE classes behind the a8976e11 guard
 * replacements (2026-08-23): human-form dated log quotes re-dated to today by
 * the clock-only pass (case 1), and negative-probe / future-intent PR
 * references extracted as completion claims and 404-branded "fabricated"
 * (case 2). The production verify-at clocks are reused so the exact flagged
 * deltas (+106m, +161m) would reproduce on the unfixed code.
 */
describe('ticket 78b13021 — dated log quotes (guard 3 human-date pass)', () => {
  const NOW_1354 = new Date('2026-08-23T14:00:20.648Z'); // flagged "9:41 AM PDT (+161m ahead)"
  const NOW_1643 = new Date('2026-08-23T16:51:49.518Z'); // flagged "18:37:41Z (+106m ahead)"

  it('CASE 1 REGRESSION: a human-dated watchdog-log quote ("Aug 22 18:37:41Z") is NOT re-dated to today', () => {
    const line = '| Health probe | WD `active/enabled`; `RESTART_COUNT 18`; tail `Aug 22 18:37:41Z restart complete, resuming probes`; `MODELS_HTTP 200`; `tt-qwen38 Up 22 hours` |';
    expect(findFutureDatedClaims(line, NOW_1643)).toHaveLength(0);
  });

  it('CASE 1 REGRESSION: the serving-since memo time ("Aug 14 9:41 AM PDT") no longer flags', () => {
    const line = '- **Box healthy** (6:59 AM PDT): Qwen3.8-27B serving live on :8090 since Aug 14 9:41 AM PDT; watchdog active/enabled; HTTP 200; tt-qwen38 Up 19h; 2.7T avail.';
    expect(findFutureDatedClaims(line, NOW_1354)).toHaveLength(0);
  });

  it('CASE 1: long month + explicit year ("August 22, 2026 11:37:41 AM PDT") resolves to the past', () => {
    const line = 'Box probe: watchdog active/enabled, HTTP 200; no new restart since August 22, 2026 11:37:41 AM PDT.';
    expect(findFutureDatedClaims(line, NOW_1643)).toHaveLength(0);
  });

  it('guard kept: a FUTURE human-dated stamp on a claim line still flags', () => {
    const NOW = new Date('2026-08-22T18:10:00.000Z');
    const fd = findFutureDatedClaims('box probe at Aug 22 19:30:00 UTC showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('Aug 22 19:30:00 UTC');
  });

  it('guard kept: an explicit-year human date flags at ANY future distance (ISO parity)', () => {
    const NOW = new Date('2026-08-22T18:10:00.000Z');
    const fd = findFutureDatedClaims('PR #253 squash-merged at August 23, 2026 09:00 UTC, sha 9f3cc5c8.', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('August 23, 2026 09:00 UTC');
  });

  it('no over-flag: a year-less human date far in the future stays under the 3h clock-only window', () => {
    const NOW = new Date('2026-08-22T18:10:00.000Z'); // August — "Dec 31" reads as a year-less reference
    expect(findFutureDatedClaims('box probe at Dec 31 11:00 PM UTC showed uptime 9h', NOW)).toHaveLength(0);
  });

  it('intent scoping applies to human-dated stamps too ("next probe Aug 22 20:10 UTC …")', () => {
    const NOW = new Date('2026-08-22T18:10:00.000Z');
    const text = 'PR #253 squash-merged at 2026-08-22T19:30:00Z, sha 9f3cc5c8; next probe Aug 22 20:10 UTC will re-check uptime';
    const fd = findFutureDatedClaims(text, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('2026-08-22T19:30:00Z');
  });

  it('guard kept: a BARE clock-only stamp still flags — no date prefix to rescue it', () => {
    const fd = findFutureDatedClaims('box probe at 18:37:41Z showed md5 4a30d268', NOW_1643);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('18:37:41Z');
  });
});

/**
 * Ticket 3611ab4a — clock+zone stamps carrying a TRAILING explicit ISO date
 * ("10:55 AM PDT 2026-08-24", time-first order — matched by neither
 * ISO_STAMP_RE nor HUMAN_DATE_STAMP_RE). The clock-only pass used to bind the
 * time portion to TODAY in the claimed zone and never consulted the date one
 * space later, so a lane's standing "last verified ~10:55 AM PDT 2026-08-24"
 * historical reference flagged as "10:55 AM PDT (+120m ahead)" whenever the
 * time-of-day delta fell inside the 3h clock-only window (production
 * replacement at 2026-08-25T15:52:29Z). The compound pass resolves the
 * explicit date instead. Every line below is a REAL claim line (claim
 * extraction asserted/controlled per case) — no vacuously-clean assertions.
 */
describe('ticket 3611ab4a — clock+zone + trailing ISO date (compound pass)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-25T15:52:29Z'); // the production verify-at clock

  it('REGRESSION: the UNVERIFIED HISTORICAL standing reference (last verified ~10:55 AM PDT 2026-08-24) no longer flags', async () => {
    // Verbatim-shape production line, extended to carry its probe claim
    // ("box … md5") — on the unfixed guard this flagged "10:55 AM PDT
    // (+123m ahead)" and the answer was replaced.
    const line = '- **All box state NOT VERIFIED this run.** UNVERIFIED HISTORICAL (last verified ~10:55 AM PDT 2026-08-24): box probe showed AIME26 ×4 119/120 = 78 stops, md5 4a30d268';
    expect(extractCompletionClaims(line).map((c) => c.kind)).toEqual(['probe']); // non-vacuous: the line IS a claim
    const out = await applyCompletionClaimGuard({
      finalText: line,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} } as any],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.futureDated).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false); // the line is fully honest — NOTHING fires
  });

  it('guard kept: an explicit-FUTURE-date compound flags at ANY distance — the 3h clock-only window does not apply', () => {
    const fd = findFutureDatedClaims('PR #253 merged at 10:55 AM PDT 2026-08-26, sha 9f3cc5c8.', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:55 AM PDT 2026-08-26');
    // ~26h ahead — far outside FUTURE_CLOCK_ONLY_MAX_AHEAD_MS, flagged anyway (explicit date).
    expect(fd[0].aheadMs).toBeGreaterThan(3 * 60 * 60 * 1000);
  });

  it('a PAST-date compound resolves to the past and stays clean', () => {
    const line = 'box probe verified at 10:55 AM PDT 2026-08-24 showed md5 4a30d268';
    expect(extractCompletionClaims(line).map((c) => c.kind)).toEqual(['probe']);
    expect(findFutureDatedClaims(line, NOW)).toHaveLength(0);
  });

  it('intent scoping applies to compound stamps too ("next probe 10:55 AM PDT 2026-08-26 will confirm …")', () => {
    // 14:04:49 UTC is BEHIND now — the line's only future stamp is the
    // intent-scoped compound. The control (same line, no intent word) flags,
    // proving the compound really is future-dated here and the suppression —
    // not a non-claim line — produces the clean result.
    const text = 'box probe at 14:04:49 UTC showed md5 4a30d268; next probe 10:55 AM PDT 2026-08-26 will confirm uptime';
    expect(findFutureDatedClaims(text, NOW)).toHaveLength(0);
    const control = 'box probe at 14:04:49 UTC showed md5 4a30d268; probe 10:55 AM PDT 2026-08-26 confirmed uptime';
    const fd = findFutureDatedClaims(control, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:55 AM PDT 2026-08-26');
  });

  it('an impossible date ("2026-02-31") does NOT mask: the clock stamp inside stays visible to the clock pass', () => {
    const line = 'box probe verified at 10:55 AM PDT 2026-02-31 showed md5 4a30d268';
    expect(extractCompletionClaims(line).map((c) => c.kind)).toEqual(['probe']);
    // Compound parse fails (Feb 31 rolls over) → span NOT masked → the clock
    // pass interprets "10:55 AM PDT" exactly as a plain clock-only stamp:
    // 17:55Z today = ~+123m at NOW (inside the 3h window) → flags.
    const fd = findFutureDatedClaims(line, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:55 AM PDT');
    // …and at a now where the plain clock-only reading is PAST, the fallback is clean.
    expect(findFutureDatedClaims(line, new Date('2026-08-25T19:00:00Z'))).toHaveLength(0); // 12:00 PM PDT — 10:55 AM today already past
  });

  it('a TODAY-date compound flags exactly as the old clock-only path would (~+123m)', () => {
    const fd = findFutureDatedClaims('box probed at 10:55 AM PDT 2026-08-25 showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:55 AM PDT 2026-08-25');
    // Same instant the clock-only binding computes: 10:55 AM PDT today = 17:55Z = +2h02m31s.
    expect(Math.round(fd[0].aheadMs / 60000)).toBe(123);
  });
});

/**
 * Ticket 85f8d318 — clock+zone stamps carrying a TRAILING HUMAN date pin
 * ("10:23:17Z Aug-29", "17:01Z on Aug-27"). The chat lane struck on this
 * postposed-pin shape in prod 2026-08-30 (ticket 9ed1bf8e: a truthful
 * 24h-old citation "batch-5 prompt (`6d2c45a4`, 10:23:17Z Aug-29)" flagged
 * as a +6m future observation) and was fixed in PR #515; this lane had the
 * same gap — it honored LEADING human dates (HUMAN_DATE_STAMP_RE) and
 * trailing ISO dates (CLOCK_ISO_DATE_COMPOUND_RE, ticket 3611ab4a) but not a
 * trailing month-day pin, so the bare-clock pass re-dated "10:23:17Z" to
 * TODAY and convicted. The trailing-human compound pass resolves the pinned
 * date instead. NOW below is the chat-lane incident's real verify clock.
 * Every line carries a real probe claim — no vacuously-clean assertions.
 */
describe('ticket 85f8d318 — clock+zone + trailing HUMAN date pin (compound pass)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-30T10:17:40.990Z'); // the prod-strike real clock (9ed1bf8e was +6m on this stamp)

  it('REGRESSION: "10:23:17Z Aug-29" (dash pin) resolves to the pinned PAST day, not today', () => {
    const line = 'box probe verified at 10:23:17Z Aug-29 showed md5 4a30d268';
    expect(extractCompletionClaims(line).map((c) => c.kind)).toEqual(['probe']); // non-vacuous: the line IS a claim
    expect(findFutureDatedClaims(line, NOW)).toHaveLength(0);
  });

  it('space separator and the "on" connector resolve too ("10:23:17Z Aug 29", "10:23:17Z on Aug-29")', () => {
    expect(findFutureDatedClaims('box probe verified at 10:23:17Z Aug 29 showed md5 4a30d268', NOW)).toHaveLength(0);
    expect(findFutureDatedClaims('box probe verified at 10:23:17Z on Aug-29 showed md5 4a30d268', NOW)).toHaveLength(0);
  });

  it('full month name + explicit year ("10:23:17Z August 29, 2026") resolves', () => {
    expect(findFutureDatedClaims('box probe verified at 10:23:17Z August 29, 2026 showed md5 4a30d268', NOW)).toHaveLength(0);
  });

  it('ANTI-GUT: a FUTURE same-day trailing pin cannot dodge — the compound itself flags (+6m)', () => {
    const line = 'box probe confirmed at 10:23:17Z Aug-30 showed md5 4a30d268';
    expect(extractCompletionClaims(line).map((c) => c.kind)).toEqual(['probe']);
    const fd = findFutureDatedClaims(line, NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:23:17Z Aug-30'); // the COMPOUND convicts, not a bare-clock fallback
    expect(Math.round(fd[0].aheadMs / 60000)).toBe(6); // 10:23:17.000 − 10:17:40.990
  });

  it('ANTI-GUT: a year-EXPLICIT future pin flags at ANY distance (no 3h clock-only window)', () => {
    const fd = findFutureDatedClaims('box probe confirmed at 10:23:17Z Aug-31, 2026 showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:23:17Z Aug-31, 2026');
    expect(fd[0].aheadMs).toBeGreaterThan(3 * 60 * 60 * 1000); // ~24h ahead — outside the year-less window
  });

  it('documented residual (leading-pass parity): a year-LESS future pin beyond the 3h window stays clean', () => {
    // Same accepted residual as the LEADING human pass ("an honest Dec 31 …
    // reference in early January must not flag as a year-ahead phantom").
    expect(findFutureDatedClaims('box probe confirmed at 10:23:17Z Aug-31 showed md5 4a30d268', NOW)).toHaveLength(0);
  });

  it('ANTI-GUT: a date modifying a LATER noun across words does NOT pin (non-adjacent falls back to today re-dating)', () => {
    // "with 358/990 items; see the" between the clock and "Aug-29" is not a
    // connector gap (digits + words), so the compound must not match — the
    // bare-clock pass re-dates to today and convicts, exactly as pre-fix.
    const fd = findFutureDatedClaims('the tally was recorded at 10:23:17Z with 358/990 items; see the Aug-29 sheet', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:23:17Z');
  });

  it('an impossible pin ("Aug-32") does NOT mask: the clock stamp inside stays visible to the clock pass', () => {
    const fd = findFutureDatedClaims('box probe confirmed at 10:23:17Z Aug-32 showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:23:17Z');
  });

  it('ANTI-LAUNDER: provenance requires the ASSERTED date literally — a receipt carrying only the clock does not vouch for a dash pin (P5 parity)', () => {
    const line = 'box probe confirmed at 10:23:17Z Aug-31, 2026 showed md5 4a30d268';
    // Evidence carries the clock as a real reading but NOT "Aug 31" — without
    // the dash-aware literal-date check the compound would borrow the bare
    // clock and dodge its asserted future date.
    const fd = findFutureDatedClaims(line, NOW, { evidenceHaystacks: ['probe tail 2026-08-30T10:23:17Z ok'] });
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('10:23:17Z Aug-31, 2026');
  });

  it('provenance positive control: evidence carrying the asserted month-day literally DOES vouch for the pin', () => {
    const line = 'box probe confirmed at 10:23:17Z Aug-31, 2026 showed md5 4a30d268';
    expect(findFutureDatedClaims(line, NOW, { evidenceHaystacks: ['schedule row: fires Aug-31 at 10:23 UTC'] })).toHaveLength(0);
  });

  it('REGRESSION (full lane): the verbatim-shape prod line passes applyCompletionClaimGuard with NO findings', async () => {
    const line = '- Fresh pull: batch-5 prompt posted at 10:23:17Z Aug-29 verified; box probe showed md5 4a30d268';
    const out = await applyCompletionClaimGuard({
      finalText: line,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} } as any],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.futureDated).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false); // the line is fully honest — NOTHING fires
  });
});

describe('ticket 78b13021 — negative probes + future intent (pr_* extraction)', () => {
  it('CASE 2 REGRESSION: the production negative-probe line — #264 reported 404 claims NOTHING; the #263 receipt still claims', () => {
    const text = '| GitHub state | `HEAD == ls-remote == 0520afc9538aff50f5ca5767474af7318d5376b8`; `PORCELAIN 0`; **PR #263** `closed`, `merged_at 2026-08-23T15:34:09Z`, sha `0520afc9538a` — REAL (fresh GET); **PR #264 → HTTP 404** (free); `OPEN_PRS 0` | ✅ |';
    expect(extractPrNumbers(text)).toEqual([263]);
    const kinds = extractPrClaimKinds(text);
    expect(kinds.has(264)).toBe(false);
    expect(Array.from(kinds.get(263) ?? [])).toEqual(['pr_closed']);
  });

  it('absence cues are PER-NUMBER: "merged PR #263, and PR #999 → HTTP 404" still claims #263 (no evasion-by-append)', () => {
    const claims = extractCompletionClaims('merged PR #263, and PR #999 → HTTP 404');
    expect(claims.filter((c) => c.prNumber === 263).map((c) => c.kind)).toEqual(['pr_merged']);
    expect(claims.some((c) => c.prNumber === 999)).toBe(false);
  });

  it('absence cue forms: "not found" / "does not exist" suppress only their own number', () => {
    const claims = extractCompletionClaims('created PR #8 after PR #7 not found; PR #9 does not exist; opened PR #10');
    expect(claims.filter((c) => c.prNumber === 8).map((c) => c.kind)).toEqual(['pr_created']);
    expect(claims.filter((c) => c.prNumber === 10).map((c) => c.kind)).toEqual(['pr_created']);
    expect(claims.some((c) => c.prNumber === 7 || c.prNumber === 9)).toBe(false);
  });

  it('future-intent verb forms are PLANS, not claims ("will be created/merged", "to be opened", "once created")', () => {
    for (const text of [
      'the completion publish: PR #264 will be created once AIME26 finishes',
      'PR #264 will be merged after review',
      'results to be opened as PR #264 pending the sweep',
      'once created, PR #264 will carry the docs',
    ]) {
      expect(extractPrNumbers(text)).toEqual([]);
    }
  });

  it('intent suppression is BEFORE-only: "created PR #7 when the tests passed" still claims', () => {
    expect(extractCompletionClaims('created PR #7 when the tests passed').map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_created#7']);
  });

  it('real claims are untouched: past-passive create + cross-clause intent scoping', () => {
    expect(extractCompletionClaims('PR #263 was created and is open').map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_created#263']);
    expect(extractPrNumbers('PR #264 will be created; PR #263 was created')).toEqual([263]);
  });

  it('E2E: a schedule run reporting "#263 closed + #264 → 404" verifies #263 and NEVER fetches/flags #264', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: true, merge_commit_sha: '0520afc9538aff50f5ca5767474af7318d5376b8', merged_at: '2026-08-23T15:34:09Z' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'GitHub state fresh: **PR #263** `closed`, `merged_at 2026-08-23T15:34:09Z`, sha `0520afc9538a` — REAL (fresh GET); **PR #264 → HTTP 404** (free); `OPEN_PRS 0`.',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule',
      now: new Date('2026-08-23T17:18:03.242Z'), // the production verify-at clock
      userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/pulls/263');
    expect(out.verdict.fabricatedPrs).toEqual([]);
    expect(out.verdict.refutedMergePrs).toEqual([]);
    expect(out.verdict.futureDated).toEqual([]);
    expect(out.finalText).toContain('PR #263 — ✅ VERIFIED CLOSED (merged)');
    expect(out.finalText).not.toContain('PR #264 —');
  });
});

/**
 * Adversarial review 2026-08-23 — PR #332's false-positive fixes overshot and
 * opened EVASION channels. These pin BOTH directions: the evasions are closed
 * (a bare 404/"not found"/narrative connective no longer erases a claim) AND
 * the original false positives stay fixed (genuine negative probes, true
 * future-intent phrasing, human-dated log quotes remain exempt).
 */
describe('adversarial hardening — #332 guard-evasion channels closed', () => {
  it('(a) bare "404" in prose no longer suppresses: "Merged PR #999, resolving the 404 issue" still claims pr_merged', () => {
    const text = 'Merged PR #999, resolving the 404 issue';
    expect(extractCompletionClaims(text).map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_merged#999']);
    expect(extractPrNumbers(text)).toEqual([999]);
  });

  it('(a) chained guard-3 blindness closed: a future stamp on that line flags again', () => {
    const NOW = new Date('2026-08-22T18:10:00.000Z');
    const fd = findFutureDatedClaims('Merged PR #999 at 19:30:00 UTC, resolving the 404 issue', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('19:30:00 UTC');
  });

  it('(a) bare "not found" in prose no longer suppresses either', () => {
    const claims = extractCompletionClaims('merged PR #999 but the asset was not found on the CDN');
    expect(claims.map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_merged#999']);
  });

  it('(b) genuine negative-probe shapes stay exempt: arrow/verb/predicate forms still suppress their own number', () => {
    const claims = extractCompletionClaims('merged PR #263, and PR #264 → HTTP 404');
    expect(claims.map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_merged#263']);
    expect(extractPrNumbers('I checked PR #264 — GitHub returns 404, it does not exist')).toEqual([]);
    const claims2 = extractCompletionClaims('filed PR #10 since PR #264 does not exist');
    expect(claims2.map((c) => `${c.kind}#${c.prNumber}`)).toEqual(['pr_created#10']);
  });

  it('(c) past-narrative connectives no longer erase claims: "After review, …" / "When the tests passed, …"', () => {
    expect(extractCompletionClaims('After review, merged PR #999').map((c) => `${c.kind}#${c.prNumber}`))
      .toEqual(['pr_merged#999']);
    expect(extractCompletionClaims('When the tests passed, I merged PR #999').map((c) => `${c.kind}#${c.prNumber}`))
      .toEqual(['pr_merged#999']);
  });

  it('(d) participial future-intent stays a non-claim: "once merged, PR #400 will be deployed"', () => {
    expect(extractCompletionClaims('once merged, PR #400 will be deployed')).toEqual([]);
    expect(extractPrNumbers('once merged, PR #400 will be deployed')).toEqual([]);
    expect(extractPrNumbers('when merged, PR #400 will be announced')).toEqual([]);
  });

  it('(e) invalid human date no longer masks: "Feb 31 18:37:41Z" leaves the future clock stamp visible and it flags', () => {
    const NOW = new Date('2026-08-23T16:51:49.518Z'); // 18:37:41Z today = ~1h46m ahead
    const fd = findFutureDatedClaims('box probe at Feb 31 18:37:41Z showed md5 4a30d268', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('18:37:41Z');
  });

  it('(f) the original FP stays fixed: a VALID human-dated log quote is masked and never re-dated to today', () => {
    const NOW = new Date('2026-08-23T16:51:49.518Z');
    const line = '| Health probe | WD `active/enabled`; tail `Aug 22 18:37:41Z restart complete, resuming probes`; `MODELS_HTTP 200`; `tt-qwen38 Up 22 hours` |';
    expect(findFutureDatedClaims(line, NOW)).toHaveLength(0);
  });
});

describe('GUARD 4 — quoted-output verification (ticket 7cb26cb0)', () => {
  const REAL_LOG = '[34/55] gpqa-101 r0 PASS 12.4s\n[35/55] gpqa-102 r0 FAIL 88.1s';
  const logParts: MessagePart[] = [
    { type: 'tool_call', name: 'run_command', args: { command: 'tail -2 bench.log' } },
    { type: 'tool_result', name: 'run_command', result: REAL_LOG },
  ];

  it('flags a quoted log block whose lines appear in NO tool result (the 2026-08-26 fabrication)', () => {
    const text = [
      'On-box log tail:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '[35/55] gpqa-101 r0 TRUNC 3719.8s',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-100');
    expect(out[0].matched).toBe(0);
    expect(out[0].total).toBe(2);
  });

  it('passes a genuine quote — lines copied from the real tool result match 100%', () => {
    const text = ['On-box log tail:', '```', REAL_LOG, '```'].join('\n');
    expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
  });

  it('tolerates whitespace re-alignment (normalization) and `$ command` prompt lines (excluded from the tally)', () => {
    const text = [
      'probe output:',
      '```console',
      '$ tail -2 bench.log',
      '[34/55]   gpqa-101   r0   PASS   12.4s',
      '[35/55] gpqa-102 r0 FAIL 88.1s',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
  });

  it('flags a fabricated write receipt: json fence + strong cue ("returned") whose payload matches nothing', () => {
    const receiptParts: MessagePart[] = [
      { type: 'tool_result', name: 'todo_update', result: '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:07:01.000Z" }' },
    ];
    const text = [
      'todo_update returned:',
      '```json',
      '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:18:13.155Z" }',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, receiptParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('12:18:13.155Z');
  });

  it('json fence with only a WEAK cue is skipped (illustrative schema, not a receipt quote)', () => {
    const text = [
      'The log entry schema:',
      '```json',
      '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:18:13.155Z" }',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('cue-gating: no observation cue above the block → never checked, even with zero parts', () => {
    const text = [
      'I wrote this helper:',
      '```',
      'function normalizeQuoteLine(line: string): string {',
      '  return line.replace(/\\s+/g, " ").trim();',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('language-tagged code fences are skipped outright, cue or not', () => {
    const text = [
      'The fix output is:',
      '```ts',
      'const fabricatedQuotes = unmatchedQuotes.map((u) => u.excerpt);',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('expectation framing suppresses: "Expected output:" is a sample, not an observation', () => {
    const text = [
      'Expected output:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '[35/55] gpqa-101 r0 TRUNC 3719.8s',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('past-run attribution suppresses: quoting what an EARLIER run observed is honest', () => {
    const text = [
      'The previous run observed:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '[35/55] gpqa-101 r0 TRUNC 3719.8s',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('authorship framing suppresses (review finding 1 repro): an AUTHORED bash script under cue words is not convicted', () => {
    const text = [
      'Here is the helper script that parses the worker log output:',
      '```bash',
      "tail -n 200 /var/log/worker.log | grep ERROR | awk '{print $1, $5}'",
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('authorship suppression stays narrow: "here is the log tail:" still CHECKs (no artifact noun)', () => {
    const text = [
      'Here is the log tail:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
  });

  it('the cue window steps OVER an adjacent preceding block (review finding 2 repro): a cue between two blocks is found', () => {
    const text = [
      'Real log tail:',
      '```',
      '[34/55] gpqa-101 r0 PASS 12.4s',
      '```',
      'grep returned:',
      '```',
      '[99/99] gpqa-999 r0 TRUNC 9999.9s',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    // Block 1 quotes the real tool result (passes); block 2 is fabricated and
    // its cue ("grep returned:") must survive sitting behind block 1's fence.
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-999');
  });

  it('round-2 evasions FLAG: observation framings the first authorship regex wrongly suppressed', () => {
    const fabricated = '[99/99] gpqa-999 r0 TRUNC 9999.9s';
    const evasions = [
      'The script output was:',
      'The script returned:',
      'The function returned:',
      'The helper output:',
      'The helper returned this log tail:',
      'This helper printed to stdout:',
      'Here is a snippet of the worker log output:',
      'I added this log excerpt:',
      'Running this probe returned:',
      'Save this output for later:',
      'I captured this output:',
      'The script that returned:',
    ];
    for (const intro of evasions) {
      const text = [intro, '```', fabricated, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
    }
    // …including the json receipt lane via an observation-framed artifact.
    const receiptEvasion = ['The script returned:', '```json', '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:18:13.155Z" }', '```'].join('\n');
    expect(findUnmatchedQuotedOutputs(receiptEvasion, logParts)).toHaveLength(1);
  });

  it('documented boundary: an intro with NO observation cue ("The script that I ran:") is cue-gated out — unchecked by design', () => {
    // The cue gate is the lane's FP/recall boundary: a block introduced with
    // zero observation language never enters matching (same as "Behold:").
    // This is NOT the authorship lane — suppression regexes never ran here.
    const text = ['The script that I ran:', '```', '[99/99] gpqa-999 r0 TRUNC 9999.9s', '```'].join('\n');
    expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
  });

  it('round-4 (review F3 revert): produced/printed-family framings do NOT cue — honest composed content never convicts', () => {
    // The round-3 cue additions were REVERTED: under these framings the block
    // is usually content the model ASSEMBLED (a summary table, a file list, a
    // config), not a verbatim quote — a miss costs less than a false
    // conviction (honest answer replaced + false integrity ticket).
    const composed = '| Step | Status |\n| --- | --- |\n| migrate | done |\n| seed | pending |';
    for (const intro of ['The migration produced:', 'The summary printed below:', 'I dumped the config:', 'The recurrence yields:', 'The function printed:']) {
      const text = [intro, '```', composed, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-4 (review F2): a fabricated line PADDED between real ones flags — any unmatched substantial line convicts', () => {
    const text = [
      'On-box log tail:',
      '```',
      '[34/55] gpqa-101 r0 PASS 12.4s',
      '[99/99] gpqa-999 r0 TRUNC 9999.9s',
      '[35/55] gpqa-102 r0 FAIL 88.1s',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-999');
    expect(out[0].matched).toBe(2);
    expect(out[0].total).toBe(3);
  });

  it('round-4 (review F4): the command exclusion is instruction-scoped — command-shaped FABRICATED lines under an OBSERVATION framing still convict', () => {
    const text = [
      'On-box log tail:',
      '```',
      'tail -n 999 /var/log/fake.log | grep ERROR | wc -l',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('tail -n 999');
  });

  it('round-4 (review F1): a RESUMED run quoting its pre-interrupt log matches the checkpoint haystack, not a conviction', () => {
    // This attempt's parts are EMPTY (the resume rehydrates messages, not
    // parts); the pre-interrupt log lives in the checkpoint's tool messages.
    const text = ['On-box log tail:', '```', REAL_LOG, '```'].join('\n');
    const checkpointMessages = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'run_command', arguments: '{}' } }] },
      { role: 'tool', content: REAL_LOG },
    ];
    const prior = toolTextsFromMessages(checkpointMessages);
    expect(prior).toEqual([REAL_LOG]);
    // …and without the union the same honest quote WOULD have convicted.
    expect(findUnmatchedQuotedOutputs(text, [])).toHaveLength(1);
    expect(findUnmatchedQuotedOutputs(text, [], prior)).toEqual([]);
  });

  it('toolTextsFromMessages: string + text-part content, non-tool roles and junk ignored, never throws', () => {
    expect(toolTextsFromMessages(undefined)).toEqual([]);
    expect(toolTextsFromMessages('not an array')).toEqual([]);
    expect(toolTextsFromMessages([
      { role: 'tool', content: 'alpha output' },
      { role: 'tool', content: [{ type: 'text', text: 'beta output' }, { type: 'image' }] },
      { role: 'user', content: 'not a tool message' },
      { role: 'tool' },
      null,
      'junk',
    ])).toEqual(['alpha output', 'beta output']);
  });

  it('round-5 (review B-1): an honest quote PAST the 8000-char display cut matches the full model-facing text — no conviction', async () => {
    // agent.ts slices tool results >8000 chars for `parts` and appends a
    // truncation marker, but the model was SHOWN the full result in its
    // role:'tool' message — an honest quote of a line past the cut must match
    // opts.toolTexts (AgentRunResult.toolTexts), not convict.
    const fullLines = Array.from({ length: 220 }, (_, i) => `[${i + 1}/220] gpqa-${1000 + i} r0 PASS 24${i % 10}.8s worker ok`);
    const full = fullLines.join('\n');
    expect(full.length).toBeGreaterThan(8000);
    let off = 0; let pastCut = '';
    for (const l of fullLines) { off += l.length + 1; if (off > 8150) { pastCut = l; break; } }
    expect(pastCut).toBeTruthy();
    const display = `${full.slice(0, 8000)}\n…[truncated ${full.length - 8000} chars — full detail is searchable via search_memory]`;
    expect(display).not.toContain(pastCut);
    const truncParts: MessagePart[] = [
      { type: 'tool_call', name: 'run_command', args: { command: 'cat bench.log' } },
      { type: 'tool_result', name: 'run_command', result: display },
    ];
    const text = ['On-box log tail:', '```', pastCut, '```'].join('\n');
    // The display-slice-only haystack convicts the HONEST quote (the B-1 repro)…
    expect(findUnmatchedQuotedOutputs(text, truncParts)).toHaveLength(1);
    // …and the full model-facing text acquits it.
    expect(findUnmatchedQuotedOutputs(text, truncParts, [full])).toEqual([]);
    // E2E: the union flows through applyCompletionClaimGuard's toolTexts opt.
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: truncParts, triggerKind: 'schedule',
      userId: 'u1', repoUrl: null, githubLabel: null, provider: null,
      now: new Date('2026-08-26T14:00:00.000Z'), toolTexts: [full],
    });
    expect(out.verdict.fabricatedQuotes).toBeUndefined();
    expect(out.finalText).not.toContain('UNVERIFIED QUOTED OUTPUT');
  });

  it('round-5 (review F-1): "Here is the …" / "… run returned:" framings are OBSERVATION — command-shaped fabrications convict', () => {
    // The pre-round-5 QUOTE_INSTRUCTION_RE matched bare `run` and `here is`,
    // so these canonical observation framings were misclassified as
    // instruction windows and command-shaped fabricated lines skipped.
    for (const intro of ['Here is the on-box log tail:', 'The monitor run returned:', "Here's the grep output:"]) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
    }
  });

  it('round-5 (review F-1): instruction/authorship framings still shield AUTHORED commands — no false conviction', () => {
    const script = "tail -n 200 /var/log/worker.log | grep ERROR | awk '{print $1, $5}'";
    for (const intro of ['Run this to reproduce:', 'To reproduce, run:', "Here's how to run it:", 'Here is the command I ran:', 'Here is the helper script:', 'The command I used:']) {
      const text = [intro, '```', script, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-6 (review F1 blocker): imperative "run" command suggestions stay shielded even with a cue word in the window', () => {
    const probe = 'curl -s https://digby.ai/api/health | jq .status';
    for (const intro of [
      'Run curl to probe the box:',
      'Check the probe output yourself.\nTo verify, run:',
      'To fix it, run curl to probe the box:',
      'Run the tests:',
    ]) {
      const text = [intro, '```', probe, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-6 (review F1): noun-"run" observation framings still convict command-shaped fabrications', () => {
    for (const intro of ['Run completed successfully.\nOutput:', 'The run came back with this output:']) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
    }
  });

  it('round-6 (review F2): bare "command" no longer flips a window to instruction — all-command fabrications convict', () => {
    const text = [
      'The on-box command transcript:',
      '```',
      'tail -n 200 /var/log/worker.log | grep -c TRUNC',
      'cat /tmp/gpqa-results.json | jq .passed',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
  });

  it('round-6 (review F3): quoting output the USER pasted is not a fabrication — user-source framing suppressed', () => {
    for (const intro of ['The log you pasted:', 'The output you provided:']) {
      const text = [intro, '```', '[99/99] gpqa-999 r0 TRUNC 9999.9s — not from any tool result of this run', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-7 (review B1): connector-less imperative "run" + bare "Execute:" stay shielded — class-fix, not example-fix', () => {
    const cases: Array<[string, string]> = [
      ['To see the full error output, simply run npm test:', 'npm test -- --watchAll=false'],
      ['Then run npm test:', 'npm test -- --watchAll=false'],
      ['Now run curl -s https://digby.ai/api/health | jq .status:', 'curl -s https://digby.ai/api/health | jq .status'],
      ['Check the probe output.\nExecute:', 'npm test -- --watchAll=false'],
      ['Just execute the migration and check the output:\nExecute:', 'npx prisma migrate deploy --skip-seed'],
    ];
    for (const [intro, cmd] of cases) {
      const text = [intro, '```', cmd, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-7 (review B1): past-tense "executed" / noun-"run" framings still convict command-shaped fabrications', () => {
    for (const intro of ['The job executed and returned:', 'The monitor run returned:']) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
    }
  });

  it('round-7 (documented residuals): "run it"/trailing-"run:" noun framings classify instruction — command-shaped fabrications skip (accepted: far from the incident signature)', () => {
    // "The run it produced:" — "run it" reads imperative to the regex (it is
    // not an observation verb); "The long run:" — trailing-run lane. Under
    // both, command-shaped fabricated lines skip. LOG-shaped fabrications
    // still convict under these framings; the accepted miss is command-shaped
    // content only, and a miss costs less than a false conviction.
    for (const intro of ['The run it produced:', 'The long run:']) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-8 (review B1′): imperative modifiers below/above/earlier shield again — the round-7 guard-word regression is reverted', () => {
    const cases: Array<[string, string]> = [
      ['Run below commands to see the output:', 'npm test -- --watchAll=false'],
      ['Run above commands to see the output:', 'npm test -- --watchAll=false'],
      ['Run earlier migrations and check the output:', 'npx prisma migrate deploy --skip-seed'],
    ];
    for (const [intro, cmd] of cases) {
      const text = [intro, '```', cmd, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-8 (review M1): mid-line "execute" + participial-object "run failed tests" shield honest commands', () => {
    const cases: Array<[string, string]> = [
      ['To verify the fix, execute npm test -- --watchAll=false and check the output:', 'npm test -- --watchAll=false'],
      ['Next execute the migration and check the output:', 'npx prisma migrate deploy --skip-seed'],
      ['To see the error output, run failed tests again:', 'npm test -- --onlyFailures'],
    ];
    for (const [intro, cmd] of cases) {
      const text = [intro, '```', cmd, '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('round-8 (review M2): observation-verb guard grows passed/log — these framings convict command-shaped fabrications', () => {
    for (const intro of ['The run passed. Output:', 'The run log:']) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toHaveLength(1);
    }
  });

  it('round-8 (review M2): the wider miss-direction residual class is pinned — command-shaped fabrications skip, by doctrine', () => {
    for (const intro of ['The run on the box returned:', 'The run at 3am returned:', 'The run overnight returned:', 'The run took 3h. Output:', 'The run below:']) {
      const text = [intro, '```', 'tail -n 999 /var/log/fake.log | grep ERROR | wc -l', '```'].join('\n');
      expect(findUnmatchedQuotedOutputs(text, logParts)).toEqual([]);
    }
  });

  it('ticket f1afaa7b (round-8 B-1): read/printed leave the verb vocabulary — homograph/adjective honest frames stay exempt; gave stays convicting', () => {
    // Round-8 review B-1 (BLOCKING): "read" (present/past homograph) and "printed"
    // (adjective / reduced passive) convicted clearly-honest scheduled prose
    // (NEW=1 vs OLD=0 on every shape below). Both leave COMPLETED_WORK_VERB_RE_SRC —
    // the vocabulary's own "past-tense only" invariant. "gave" survives: an
    // unambiguous past-tense output verb with no honest FP class (reviewer-verified).
    const NOW2 = new Date('2026-08-31T00:05:00.000Z');
    expect(findFutureDatedClaims('probes read the digest at the 01:04Z checkpoint', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the monitor read cycle runs at the 01:04Z checkpoint', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the 01:04Z probes read the digest', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the digest printed summary lands at the 01:04Z checkpoint', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('readings printed at the 01:04Z checkpoint roll up hourly', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('readings printed during the 01:04Z window roll up hourly', NOW2)).toHaveLength(0);
    expect(findFutureDatedClaims('the monitor gave it a pass at the 01:04Z checkpoint', NOW2)).toHaveLength(1);
    expect(findFutureDatedClaims('the monitor gave status at the 01:04Z checkpoint', NOW2)).toHaveLength(1);
  });

  it('ticket f1afaa7b (round-8 B-2): coordinator tempering is clause-conditional — verb-less ellipses still convict', () => {
    // Round-8 review B-2 (BLOCKING regression): the unconditional coordinator temper
    // laundered fabricated completions — one "and" + a verb-less noun (or nothing)
    // before "at the <stamp>" exempted what the untempered span convicted. The temper
    // now refuses to cross a coordinator ONLY when a genuine new clause follows
    // (optional article + two non-preposition words — "and the rollup lands at").
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the tally was verified and the fold at the 19:05Z rollup', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('results were logged and the digest at the 19:05Z rollup', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally was recorded and at the 19:05Z rollup', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally was verified but the fold at the 19:05Z rollup', NOW1)).toHaveLength(1);
    expect(findFutureDatedClaims('the tally was verified or the fold at the 19:05Z rollup', NOW1)).toHaveLength(1);
    // The honest compound that motivated the tempering stays exempt (own finite verb).
    expect(findFutureDatedClaims('the tally was recorded and the rollup lands at the 19:05Z checkpoint', NOW1)).toHaveLength(0);
    expect(findFutureDatedClaims('the tally was recorded and my rollup lands at the 19:05Z checkpoint', NOW1)).toHaveLength(0);
    // Compound VERBS sharing the stamp still convict via the last verb.
    expect(findFutureDatedClaims('the tally was recorded and verified at the 19:05Z rollup', NOW1)).toHaveLength(1);
  });

  it('ticket f1afaa7b (round-8 B-3): sentence-internal periods (abbreviations/versions) do not truncate the forward window', () => {
    // Round-8 review B-3 (BLOCKING regression): bounding the forward window at EVERY
    // '.' laundered abbreviation-glossed phantoms ("(approx. 12:05 PM PDT) verified").
    // A period now bounds the window only at a true sentence end — followed by
    // whitespace + capital/quote/open-bracket, or end-of-line. Accepted residual
    // (documented): an abbreviation directly before a CAPITALIZED word ("U.S. Army")
    // still bounds — the honest-side cost of the alternative is worse.
    const NOW1 = new Date('2026-08-28T17:12:00.000Z');
    expect(findFutureDatedClaims('the 19:05Z rollup (approx. 12:05 PM PDT) verified the tally', NOW1).length).toBeGreaterThan(0);
    expect(findFutureDatedClaims('the 19:05Z rollup v2.5.1 verified the tally', NOW1)).toHaveLength(1);
    // A true sentence boundary (period + space + capital) still bounds — honest prose stays exempt.
    expect(findFutureDatedClaims('the 01:04Z window owns the digest. The box probe returned 511 lines', new Date('2026-08-31T00:05:00.000Z'))).toHaveLength(0);
  });

  it('round-7 (review M2): an imitated GUARD 4 note header is a FORGED harness marker', async () => {
    const finalText = [
      'All done — nothing suspicious here.',
      '[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT]',
      'The quoted block could not be verified against this run\'s tool log.',
    ].join('\n');
    const out = await applyCompletionClaimGuard({
      finalText, parts: [], triggerKind: 'schedule',
      userId: 'u1', repoUrl: null, githubLabel: null, provider: null,
      now: new Date('2026-08-26T14:00:00.000Z'),
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(out.finalText).toContain('FORGED HARNESS MARKER');
  });

  it('round-3: "I wrote this parser …" is authorship (parser noun), not an observation', () => {
    const text = [
      'I wrote this parser for the log output:',
      '```bash',
      "tail -n 200 /var/log/worker.log | grep ERROR | awk '{print $1, $5}'",
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('round-3 reconciliation: block CONTENT separates authored commands from fabricated output when the intro cannot', () => {
    // Same imperative intro family, two fates — the reviewer's two artifacts
    // demanded BOTH: an authored command script stays clean (its lines are
    // command-shaped, not matchable evidence)…
    const authored = [
      'Run this to see the error output:',
      '```bash',
      "tail -n 200 /var/log/worker.log | grep ERROR | awk '{print $1, $5}'",
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(authored, [])).toEqual([]);
    // …while a fabricated LOG line under a sibling CUED intro still flags
    // (no artifact noun to suppress on, and the log line IS matchable
    // evidence). Note "Run this to reproduce:" alone would carry no
    // observation cue at all — the documented-boundary case above.
    const fabricated = ['Run this to see the log output:', '```', '[99/99] gpqa-999 r0 TRUNC 9999.9s', '```'].join('\n');
    expect(findUnmatchedQuotedOutputs(fabricated, logParts)).toHaveLength(1);
  });

  it('round-3: prose merely DISCUSSING observation is not a cue ("observation" stem dropped)', () => {
    const text = [
      'Some prose with no observation words.',
      '```',
      '> not a quote — inside the fence interior',
      '```',
      'The probe returned:',
      '> [99/99] gpqa-999 r0 TRUNC 9999.9s',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-999');
  });

  it('round-3 extraction battery: stacked fences, fence-in-blockquote, unterminated, ~~~, blockquote-then-fence', () => {
    const FAB0 = '[99/99] gpqa-999 r0 TRUNC 9999.9s';
    const FAB1 = '[98/99] gpqa-998 r0 TRUNC 8888.8s';
    // Stacked fabrications with NO prose between — the second inherits the cue.
    expect(findUnmatchedQuotedOutputs(
      ['The log tail:', '```', FAB0, '```', '```', FAB1, '```'].join('\n'), logParts,
    )).toHaveLength(2);
    // A fence INSIDE a blockquote is one de-prefixed blockquote block.
    const inQuote = findUnmatchedQuotedOutputs(['The log tail:', '> ```', `> ${FAB0}`, '> ```'].join('\n'), logParts);
    expect(inQuote).toHaveLength(1);
    expect(inQuote[0].excerpt).toContain('gpqa-999');
    // Unterminated fence at EOF still checks (no hang, no crash).
    expect(findUnmatchedQuotedOutputs(['The log tail:', '```', FAB0, FAB1].join('\n'), logParts)).toHaveLength(1);
    // ~~~ fences are checked.
    expect(findUnmatchedQuotedOutputs(['The log tail:', '~~~', FAB0, '~~~'].join('\n'), logParts)).toHaveLength(1);
    // A cue between a blockquote run and a fence is found.
    const mixed = findUnmatchedQuotedOutputs(['> [34/55] gpqa-101 r0 PASS 12.4s', 'grep returned:', '```', FAB0, '```'].join('\n'), logParts);
    expect(mixed).toHaveLength(1);
    expect(mixed[0].excerpt).toContain('gpqa-999');
    // Empty answer extracts nothing.
    expect(findUnmatchedQuotedOutputs('', [])).toEqual([]);
  });

  it('authorship stays suppressed for genuine artifact presentations (round-2 narrowness)', () => {
    const legit = [
      ['The helper script below parses logs:', '```bash', "tail -n 200 /var/log/worker.log | grep ERROR | awk '{print $1, $5}'", '```'],
      ['Script to rotate logs:', '```bash', "find /var/log -name '*.log' -mtime +30 -delete", '```'],
      ['The script that parses the worker log:', '```bash', 'grep -c ERROR /var/log/worker.log', '```'],
      ['Save this as rotate.sh:', '```bash', 'find /var/log -name "*.old" -delete', '```'],
      ['The following function tails the worker log:', '```bash', 'tail -f /var/log/worker.log', '```'],
    ];
    for (const lines of legit) {
      expect(findUnmatchedQuotedOutputs(lines.join('\n'), logParts)).toEqual([]);
    }
  });

  it('multi-word info strings still extract ("```log output" no longer hides the block — round-2 hardening)', () => {
    const text = ['Fresh probe output:', '```log output', '[99/99] gpqa-999 r0 TRUNC 9999.9s', '```'].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-999');
  });

  it('a 4-backtick fence does not close early at a ```python decoy line (round-2 hardening)', () => {
    const text = [
      'Fresh probe output:',
      '````',
      '```python',
      '[99/99] gpqa-999 r0 TRUNC 9999.9s',
      '````',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-999');
  });

  it('blockquote runs are checked too (de-prefixed), with the same cue gate', () => {
    const text = [
      'grep returned:',
      '> [34/55] gpqa-100 r0 TRUNC 3719.4s',
      '> [35/55] gpqa-101 r0 TRUNC 3719.8s',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, logParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('gpqa-100');
  });

  it('a zero-tool run quoting observed output is flagged (the phantom signature itself)', () => {
    const text = ['Fresh probe output:', '```', '[34/55] gpqa-100 r0 TRUNC 3719.4s', '```'].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toHaveLength(1);
  });

  it('renderQuotedOutputNote renders the harness notice with exhibits and match counts', () => {
    const note = renderQuotedOutputNote([{ excerpt: '[34/55] gpqa-100 r0 TRUNC 3719.4s', matched: 0, total: 2 }]);
    expect(note).toContain('HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT');
    expect(note).toContain('gpqa-100');
    expect(note).toContain('0/2 lines matched');
  });

  // Replay pins — ticket ef85fb3f (2026-09-03): a hook run in session b9362874
  // quoted "pixel7: verdict=FAIL inputBottom=912.4 innerH=839 gap=73.4" as
  // verbatim Playwright probe output that no tool result of the run produced.
  // The strike was a true positive; these pins keep the conviction stable.
  it('ticket ef85fb3f: a fabricated mobile-probe verdict line quoted as verbatim output is flagged', () => {
    const probeParts: MessagePart[] = [
      { type: 'tool_call', name: 'run_command', args: { command: 'cd tmp/uitests && node uitest.mjs https://deckpose.com mobile' } },
      { type: 'tool_result', name: 'run_command', result: 'desktop: verdict=PASS inputBottom=780.0 innerH=800 gap=20.0\nmobile-chromium: verdict=PASS' },
    ];
    const text = [
      'Playwright output:',
      '```',
      'desktop: verdict=PASS inputBottom=780.0 innerH=800 gap=20.0',
      'pixel7: verdict=FAIL inputBottom=912.4 innerH=839 gap=73.4',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, probeParts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('pixel7: verdict=FAIL');
    expect(out[0].matched).toBe(1);
    expect(out[0].total).toBe(2);
  });

  it('ticket ef85fb3f control: the same verdict line present in a real tool result is an honest quote', () => {
    const probeParts: MessagePart[] = [
      { type: 'tool_result', name: 'run_command', result: 'desktop: verdict=PASS inputBottom=780.0 innerH=800 gap=20.0\npixel7: verdict=FAIL inputBottom=912.4 innerH=839 gap=73.4' },
    ];
    const text = [
      'Playwright output:',
      '```',
      'desktop: verdict=PASS inputBottom=780.0 innerH=800 gap=20.0',
      'pixel7: verdict=FAIL inputBottom=912.4 innerH=839 gap=73.4',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, probeParts)).toEqual([]);
  });

  it('ticket ef85fb3f boundary: the same line under expectation framing stays exempt (honest shape)', () => {
    const text = [
      'Expected output once the fix lands:',
      '```',
      'pixel7: verdict=PASS inputBottom=839.0 innerH=839 gap=0.0',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });
});

describe('applyCompletionClaimGuard — GUARD 4 lane (ticket 7cb26cb0)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-26T13:00:00.000Z');

  it('THE TICKET SCENARIO: PR claim verifies ✅ while fabricated log + receipt quotes are flagged (the footer no longer stands alone)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, merge_commit_sha: '9f3cc5c81234567890abcdef', merged_at: '2026-08-26T12:05:11Z',
    }));
    const finalText = [
      'Publish chain complete: PR #265 merged 2026-08-26T12:05:11Z.',
      'On-box log tail:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '[35/55] gpqa-101 r0 TRUNC 3719.8s',
      '```',
      'todo_update returned:',
      '```json',
      '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:18:13.155Z" }',
      '```',
    ].join('\n');
    const parts: MessagePart[] = [
      { type: 'tool_call', name: 'run_command', args: { command: 'tail bench.log' } },
      { type: 'tool_result', name: 'run_command', result: '[34/55] gpqa-101 r0 PASS 12.4s\n[35/55] gpqa-102 r0 FAIL 88.1s' },
      { type: 'tool_result', name: 'todo_update', result: '{ "id": "todo-1", "status": "done", "updatedAt": "2026-08-26T12:07:01.000Z" }' },
    ];
    const out = await applyCompletionClaimGuard({ finalText, parts, triggerKind: 'schedule', now: NOW, ...OPTS });

    // The publish-chain lane still verifies the real PR — that was never broken.
    expect(out.finalText).toContain('✅ VERIFIED MERGED');
    // …but the fabricated observations the old guard TRUSTED are now flagged.
    expect(out.verdict.fabricatedQuotes).toHaveLength(2);
    expect(out.verdict.fabricatedQuotes![0]).toContain('gpqa-100');
    expect(out.verdict.fabricatedQuotes![1]).toContain('12:18:13.155Z');
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT');
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(summarizeGuardVerdict(out.verdict)).toContain('verbatim output');
    expect(out.verdict.forgedFooter).toBeUndefined();
  });

  it('runs even when the answer makes NO completion claims (placed before the no-claims early return)', async () => {
    const finalText = [
      'Status only. Fresh probe output:',
      '```',
      '[34/55] gpqa-100 r0 TRUNC 3719.4s',
      '```',
    ].join('\n');
    const out = await applyCompletionClaimGuard({ finalText, parts: [], triggerKind: 'machine', now: NOW, ...OPTS });
    expect(out.verdict.fabricatedQuotes).toHaveLength(1);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('UNVERIFIED QUOTED OUTPUT');
  });

  it('a clean run with a genuine quote keeps the empty verdict shape (no fabricatedQuotes field)', async () => {
    const finalText = [
      'Reviewed the log, nothing new. On-box log tail:',
      '```',
      '[34/55] gpqa-101 r0 PASS 12.4s',
      '```',
    ].join('\n');
    const parts: MessagePart[] = [
      { type: 'tool_result', name: 'run_command', result: '[34/55] gpqa-101 r0 PASS 12.4s\n[35/55] gpqa-102 r0 FAIL 88.1s' },
    ];
    const out = await applyCompletionClaimGuard({ finalText, parts, triggerKind: 'schedule', now: NOW, ...OPTS });
    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(out.notes).toEqual([]);
  });

  it('ticket 375c8618: a fabricated status audit with future clocks on NON-claim lines is convicted at send time (no-claims early return no longer shields it)', async () => {
    // The Re-Send lane incident shape: zero extractable completion claims, so
    // GUARD 3 previously never ran (early return) AND its scan was claim-line
    // gated — the +39m clocks reached the transcript unchallenged.
    const NOW_1424 = new Date('2026-08-27T14:24:28.000Z');
    const finalText = [
      'Audit complete — 5/5 checks verified.',
      'tmux storm-watcher RUNNING on the box, session storm-watch.',
      'watch.log alive, last tail at 15:03:42Z.',
      'Journaled 2 entries at 15:01:07Z.',
    ].join('\n');
    const out = await applyCompletionClaimGuard({ finalText, parts: [], triggerKind: 'schedule', now: NOW_1424, ...OPTS });
    expect(out.verdict.futureDated).toHaveLength(2);
    expect(out.verdict.futureDated[0]).toContain('15:03:42Z');
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS');
    expect(verdictHasFindings(out.verdict)).toBe(true);
  });

  it('a future stamp quoted verbatim from a REAL tool result stays exempt (honest next-fire report)', async () => {
    const line = '| b191b9a0 | 60m | 2026-08-28T00:00:48Z | active |';
    const finalText = `Schedule state, quoted from list_schedules:\n${line}`;
    const parts: MessagePart[] = [
      { type: 'tool_result', name: 'list_schedules', result: `active schedules:\n${line}\n(end)` },
    ];
    const out = await applyCompletionClaimGuard({ finalText, parts, triggerKind: 'schedule', now: NOW, ...OPTS });
    expect(out.verdict.futureDated).toEqual([]);
    expect(out.notes).toEqual([]);
  });
});

describe('evidence-clock calibration (ticket 28b9414d)', () => {
  // The 2026-08-28 incident (run bdf31a94): the guard host clock read ~06:27:30
  // at finalize while the run's satellite + GitHub Date headers (mutually
  // corroborated at +6..+13s) read ~06:29:45-51 — four honest ~+2m composite
  // quotes were convicted as fabricated observation clocks.
  const NOW = new Date('2026-08-28T06:27:30.000Z');
  const NOW_MS = NOW.getTime();

  const INCIDENT_FINAL = [
    '**Goal #1 tick — AUDIT CLOSED.** Platform anchor: `2026-08-28T06:29:49.457Z` (todo `updatedAt`, re-read fresh).',
    'Clocks bracketed: `C1 2026-08-28T06:28:37Z` vs `GH date: Fri, 28 Aug 2026 06:28:24 GMT` (+13 s); `REAUD_C 2026-08-28T06:29:51Z` vs `REAUD_GH date: Fri, 28 Aug 2026 06:29:45 GMT` (+6 s).',
    'Fresh `todo_get`: `updatedAt 2026-08-28T06:29:49.457Z` (in_progress, goal active).',
  ].join('\n');

  const INCIDENT_EVIDENCE = [
    'HTTP/2 200\ndate: Fri, 28 Aug 2026 06:29:45 GMT\ncontent-type: application/json; charset=utf-8',
    '$ date -u +%Y-%m-%dT%H:%M:%SZ\n2026-08-28T06:29:51Z',
    '{"id":"4f9381eb","status":"in_progress","updatedAt":"2026-08-28T06:29:49.457Z"}',
  ];

  describe('evidenceClockMs', () => {
    it('returns undefined for empty evidence and for past-only stamps', () => {
      expect(evidenceClockMs([], NOW_MS)).toBeUndefined();
      expect(evidenceClockMs(['no stamps here', 'probe at 2026-08-28T06:20:00Z done'], NOW_MS)).toBeUndefined();
    });

    it('returns the MAX proven instant across ISO / human / HTTP-date stamps and texts', () => {
      const texts = [
        'HTTP/2 200\ndate: Fri, 28 Aug 2026 06:29:45 GMT', // HTTP-date, day-first
        'log line: Aug 28, 2026 6:29:48 AM UTC captured', // human-date, month-first
        '2026-08-28T06:29:51Z', // ISO
      ];
      expect(evidenceClockMs(texts, NOW_MS)).toBe(Date.parse('2026-08-28T06:29:51Z'));
    });

    it('parses the GitHub Date header shape (RFC-2822, day-first) — the incident ground truth', () => {
      expect(evidenceClockMs(['date: Fri, 28 Aug 2026 06:29:45 GMT'], NOW_MS))
        .toBe(Date.parse('2026-08-28T06:29:45Z'));
    });

    it('rejects impossible HTTP dates (no Feb-31 rollover)', () => {
      expect(evidenceClockMs(['date: Fri, 31 Feb 2026 06:29:45 GMT'], NOW_MS)).toBeUndefined();
    });

    it('excludes stamps beyond EVIDENCE_CLOCK_MAX_LEAD_MS (a schedule next-fire hours out must not raise the ceiling)', () => {
      expect(EVIDENCE_CLOCK_MAX_LEAD_MS).toBe(5 * 60 * 1000);
      expect(evidenceClockMs(['{"nextFireAt":"2026-08-28T07:27:30.000Z"}'], NOW_MS)).toBeUndefined();
      // Boundary: exactly at the cap counts; one second past it does not.
      expect(evidenceClockMs(['x 2026-08-28T06:32:30Z'], NOW_MS)).toBe(Date.parse('2026-08-28T06:32:30Z'));
      expect(evidenceClockMs(['x 2026-08-28T06:32:31Z'], NOW_MS)).toBeUndefined();
    });

    it('excludes intent-scoped stamps ("next fire …") even inside the lead window', () => {
      expect(evidenceClockMs(['1fbe4800 [active] recurring every 60m — next fire 2026-08-28T06:30:20Z'], NOW_MS)).toBeUndefined();
    });

    it('review M1: camelCase-glued JSON intent keys ("nextFireAt") are excluded too; ordinary camelCase keys still calibrate', () => {
      // +170s from NOW — inside the lead window, so ONLY the intent filter can exclude it.
      expect(evidenceClockMs(['{"nextFireAt":"2026-08-28T06:30:20.000Z"}'], NOW_MS)).toBeUndefined();
      expect(evidenceClockMs(['{"scheduledFor":"2026-08-28T06:30:20.000Z"}'], NOW_MS)).toBeUndefined();
      expect(evidenceClockMs(['{"expiresAt":"2026-08-28T06:30:20.000Z"}'], NOW_MS)).toBeUndefined();
      // Not an intent word: an observation-time field must keep calibrating.
      expect(evidenceClockMs(['{"observedAt":"2026-08-28T06:30:20.000Z"}'], NOW_MS)).toBe(Date.parse('2026-08-28T06:30:20Z'));
    });

    it('never re-dates clock-only stamps (a "23:50 PDT" near midnight would mint a +23h ceiling)', () => {
      expect(evidenceClockMs(['box clock read 06:29:45 GMT exactly'], NOW_MS)).toBeUndefined();
    });
  });

  it('THE INCIDENT REGRESSION: honest composite quotes pass when the run\'s own evidence proves the evidence domain ran ahead', async () => {
    const r = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: [], triggerKind: 'user', userId: 'u1',
      toolTexts: INCIDENT_EVIDENCE, now: NOW,
    });
    expect(r.verdict.futureDated).toEqual([]);
    expect(r.finalText).toBe(INCIDENT_FINAL);
    expect(r.notes).toEqual([]);
  });

  it('CONTROL: the same text with NO proven-forward evidence still convicts (+2m phantom class)', async () => {
    const r = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: [], triggerKind: 'user', userId: 'u1',
      toolTexts: ['no stamps in this output'], now: NOW,
    });
    expect(r.verdict.futureDated?.length).toBe(4); // the incident's exact four findings: 2× 06:29:49.457Z + 06:29:51Z + 06:29:45 GMT
    expect(r.verdict.futureDated?.every((f) => f.includes('+2m ahead'))).toBe(true);
    expect(r.finalText).toContain('FUTURE-DATED CLAIMS');
  });

  it('the lead cap refuses a far-future evidence stamp, so a fabricated +3m clock still convicts', async () => {
    const finalText = 'Box probe completed at 2026-08-28T06:30:45Z, all green.';
    const r = await applyCompletionClaimGuard({
      finalText, parts: [], triggerKind: 'user', userId: 'u1',
      toolTexts: ['{"nextFireAt":"2026-08-28T07:27:30.000Z"}'], // +60m, beyond the 5m cap
      now: NOW,
    });
    expect(r.verdict.futureDated?.length).toBe(1);
    expect(r.finalText).toContain('FUTURE-DATED CLAIMS');
  });

  it('an intent-scoped next-fire inside the window does NOT calibrate — a fabricated +2m clock still convicts', async () => {
    const finalText = 'Fresh `todo_get`: `updatedAt 2026-08-28T06:29:49Z` (in_progress).';
    const r = await applyCompletionClaimGuard({
      finalText, parts: [], triggerKind: 'user', userId: 'u1',
      toolTexts: ['1fbe4800 [active] recurring every 60m — next fire 2026-08-28T06:30:20Z'],
      now: NOW,
    });
    expect(r.verdict.futureDated?.length).toBe(1);
    expect(r.finalText).toContain('FUTURE-DATED CLAIMS');
  });

  it('calibration relief is bounded by the PROVEN instant (+90s margin): a quote beyond it still convicts', async () => {
    const finalText = [
      'Clocks bracketed: `REAUD_C 2026-08-28T06:29:51Z` vs `REAUD_GH date: Fri, 28 Aug 2026 06:29:45 GMT` (+6 s).',
      'But this probe line claims 2026-08-28T06:32:00Z — over two minutes past the last proven observation.',
    ].join('\n');
    const r = await applyCompletionClaimGuard({
      finalText, parts: [], triggerKind: 'user', userId: 'u1',
      toolTexts: INCIDENT_EVIDENCE, now: NOW,
    });
    expect(r.verdict.futureDated?.length).toBe(1);
    expect(r.verdict.futureDated?.[0]).toContain('2026-08-28T06:32:00Z');
  });
});

// ── GUARD 5: deploy-run-id claim→journal cross-check (ticket 8e9d6496) ──────

describe('extractDeployRunClaims (guard 5, ticket 8e9d6496)', () => {
  it('incident phrasing: "deploy <id> completed success" is a SUCCESS claim', () => {
    expect(extractDeployRunClaims('deploy 33236939738 completed success at 06:30:44Z'))
      .toEqual([{ runId: '33236939738', claimedState: 'success', text: 'deploy 33236939738 completed success at 06:30:44Z' }]);
  });

  it('failure + bare-completed claims extract their own states', () => {
    expect(extractDeployRunClaims('deploy 33236939738 failed at the typecheck stage').map((c) => c.claimedState)).toEqual(['failure']);
    expect(extractDeployRunClaims('deploy 33236939738 completed').map((c) => c.claimedState)).toEqual(['completed']);
  });

  it('a bare mention with NO state cue claims nothing', () => {
    expect(extractDeployRunClaims('still watching deploy 33236939738')).toEqual([]);
    expect(extractDeployRunClaims('deploy 33236656591')).toEqual([]);
  });

  it('watch-scoped + negated + intent cues suppress the claim', () => {
    expect(extractDeployRunClaims('waiting for deploy 33236939738 to go green')).toEqual([]);
    expect(extractDeployRunClaims('deploy 33236939738 has not succeeded')).toEqual([]);
    expect(extractDeployRunClaims('will report deploy 33236939738 completed success once done')).toEqual([]);
  });

  it('a 10-digit unix timestamp is NOT a run id (the 11-12 digit floor)', () => {
    expect(extractDeployRunClaims('deploy at 1787991318 completed success')).toEqual([]);
  });

  it('a refutation/audit line asserts nothing (phantom context)', () => {
    expect(extractDeployRunClaims('phantom claim: deploy 33236656591 completed success — 404 on fresh pull')).toEqual([]);
  });

  it('quoted-void exemption: a blockquoted claim inside a VOID note is a citation', () => {
    expect(extractDeployRunClaims('VOIDED prior tick — see below.\n> deploy 33236939738 completed success')).toEqual([]);
  });

  it('multiple ids on one line all extract (deduped by id)', () => {
    const claims = extractDeployRunClaims('deploy 33236656591 completed success; deploy 33236939738 completed success');
    expect(claims.map((c) => c.runId)).toEqual(['33236656591', '33236939738']);
  });

  // ── Adversarial-review pins (9dff051c review: N1, N2, N3) ────────────────

  it('review N1a: audit/second-hand phrasing ("the prior run claimed …") asserts nothing', () => {
    expect(extractDeployRunClaims('the prior run claimed deploy 33236656591 completed success')).toEqual([]);
  });

  it('review N1b: absence-cue suppression — "— 404 on fresh pull" is a report, not a claim', () => {
    expect(extractDeployRunClaims('deploy 33236656591 completed success — 404 on fresh pull')).toEqual([]);
  });

  it('review N2a: cross-clause cue bleed — a negated own-clause cue is not rescued by the next clause\'s clean one', () => {
    const claims = extractDeployRunClaims('deploy 33236656591 has not succeeded; retry deploy 33236939740 succeeded');
    expect(claims).toEqual([{ runId: '33236939740', claimedState: 'success', text: 'deploy 33236656591 has not succeeded; retry deploy 33236939740 succeeded' }]);
  });

  it('review N2b: an earlier clause\'s "passed" is not attributed to a watched id', () => {
    expect(extractDeployRunClaims('All checks passed; watching deploy 33236939738')).toEqual([]);
  });

  it('review N3: "should go green" is a projection, not an observation', () => {
    expect(extractDeployRunClaims('deploy 33236939738 is still running, should go green soon')).toEqual([]);
  });
});

describe('verifyDeployRunClaims (guard 5, ticket 8e9d6496)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' as const };
  const claim = (runId: string, claimedState: 'success' | 'failure' | 'completed' = 'success') => ({ runId, claimedState, text: `deploy ${runId}` });

  it('404 → missing (the fabrication lane)', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const vs = await verifyDeployRunClaims({ claims: [claim('33236656591')], ...OPTS, fetchImpl: mockFetch as any });
    expect(vs).toEqual([{ runId: '33236656591', claimedState: 'success', state: 'missing', reason: 'GitHub 404' }]);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/actions/runs/33236656591');
  });

  it('success claim + in_progress run → REFUTED with GitHub actual state', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const vs = await verifyDeployRunClaims({ claims: [claim('33236939738')], ...OPTS, fetchImpl: mockFetch as any });
    expect(vs[0]).toMatchObject({ state: 'refuted', actual: 'in_progress' });
  });

  it('success claim + completed/success run → confirmed', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
    const vs = await verifyDeployRunClaims({ claims: [claim('33236939738')], ...OPTS, fetchImpl: mockFetch as any });
    expect(vs[0]).toMatchObject({ state: 'confirmed', actual: 'completed/success' });
  });

  it('bare "completed" claim + completed/failure run → CONFIRMED (completed is literally true); a SUCCESS claim there is refuted', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'failure' }));
    const done = await verifyDeployRunClaims({ claims: [claim('33236939738', 'completed')], ...OPTS, fetchImpl: mockFetch as any });
    expect(done[0].state).toBe('confirmed');
    const success = await verifyDeployRunClaims({ claims: [claim('33236939738', 'success')], ...OPTS, fetchImpl: mockFetch as any });
    expect(success[0]).toMatchObject({ state: 'refuted', actual: 'completed/failure' });
  });

  it('failure claim + completed/success run → refuted (conservative direction)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
    const vs = await verifyDeployRunClaims({ claims: [claim('33236939738', 'failure')], ...OPTS, fetchImpl: mockFetch as any });
    expect(vs[0].state).toBe('refuted');
  });

  it('fetch rejects → unavailable, never throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const vs = await verifyDeployRunClaims({ claims: [claim('33236939738')], ...OPTS, fetchImpl: mockFetch as any });
    expect(vs[0].state).toBe('unavailable');
  });

  it('non-GitHub provider → unavailable, fetch never called', async () => {
    const vs = await verifyDeployRunClaims({ claims: [claim('33236939738')], userId: 'u1', repoUrl: null, provider: 'blank', fetchImpl: mockFetch as any });
    expect(vs[0]).toMatchObject({ state: 'unavailable', reason: 'no GitHub repo' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('7 claims → only MAX_VERIFY_DEPLOY_RUNS fetched', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const claims = Array.from({ length: 7 }, (_, i) => claim(`3323693973${i}`));
    const vs = await verifyDeployRunClaims({ claims, ...OPTS, fetchImpl: mockFetch as any });
    expect(vs).toHaveLength(MAX_VERIFY_DEPLOY_RUNS);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_VERIFY_DEPLOY_RUNS);
  });
});

describe('renderDeployVerificationFooter (guard 5)', () => {
  it('renders one line per checked run with its verdict', () => {
    const footer = renderDeployVerificationFooter([
      { runId: '1', claimedState: 'success', state: 'confirmed', actual: 'completed/success' },
      { runId: '2', claimedState: 'success', state: 'missing' },
      { runId: '3', claimedState: 'success', state: 'refuted', actual: 'in_progress' },
    ]);
    expect(footer).toContain('Harness deploy-run verification');
    expect(footer).toContain('✅ EXISTS');
    expect(footer).toContain('no such GitHub Actions run (404)');
    expect(footer).toContain('REFUTED');
  });
});

// ── GUARD 6: feedback-ticket-id claim→journal cross-check (ticket 8e9d6496) ──

describe('extractTicketIdCitations (guard 6, ticket 8e9d6496)', () => {
  it('incident phrasing: a ticket-cue 8-hex chain extracts every id', () => {
    const cites = extractTicketIdCitations('the open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged');
    expect(cites.map((c) => c.id)).toEqual(['01226f89', '4de4a5ef']);
  });

  it('full-uuid citation on a ticket line', () => {
    const cites = extractTicketIdCitations('ticket 8e9d6496-e3d9-4407-971b-ef9b4bec1919 filed for the guard gap');
    expect(cites.map((c) => c.id)).toEqual(['8e9d6496-e3d9-4407-971b-ef9b4bec1919']);
  });

  it('"ticketed <id>" phrasing extracts', () => {
    expect(extractTicketIdCitations('ticketed e7aae794 after the guard caught the run').map((c) => c.id)).toEqual(['e7aae794']);
    // …but a refutation word on the SAME line ("…for the phantom lifecycle") scopes it to audit context — a miss, never a false conviction.
    expect(extractTicketIdCitations('ticketed e7aae794 for the phantom lifecycle')).toEqual([]);
  });

  it('a sha-cued hex token is NOT a ticket citation; the ticket-cued one is', () => {
    expect(extractTicketIdCitations('merge sha fb4ab3bd (ticket be199e93)').map((c) => c.id)).toEqual(['be199e93']);
  });

  it('absence cues make it an honest refutation report, not a citation', () => {
    expect(extractTicketIdCitations('ticket 01226f89 → 404')).toEqual([]);
    expect(extractTicketIdCitations('tickets 01226f89 / 4de4a5ef — ALL 404 on fresh pulls')).toEqual([]);
  });

  it('a date-shaped 8-DIGIT token is not a hex id', () => {
    expect(extractTicketIdCitations('ticket 20260829 closed')).toEqual([]);
  });

  it('refutation-context line: "invented ticket ids …" asserts nothing', () => {
    expect(extractTicketIdCitations('the nightly lane cited invented ticket ids 01226f89 / 4de4a5ef')).toEqual([]);
  });

  it('quoted-void exemption for blockquoted citations', () => {
    expect(extractTicketIdCitations('VOID prior note — the batch below was struck.\n> ticket 01226f89 was triaged')).toEqual([]);
  });

  it('ticket 00317531 replay: a parsed claims block lifts ONLY its ticket_update ref — never dispatch/session/push refs', () => {
    // The 2026-09-15 false strike (chat b92ef13f msg 80af58c5): this single-line
    // block carries "type":"ticket_update", so /\bticket/i matched the WHOLE
    // line and shape (a) lifted the dispatch entry's session receipt uuid
    // 0867090a-… as a "ticket citation" — the feedback-store existence check
    // then struck a REAL receipt as a fabricated ticket id.
    const text = [
      'All done — details above.',
      '```claims',
      '[{"type":"push","ref":"276a3e9e5278ab5daab25c1b81556a71774ace8c"},{"type":"pr","ref":"776"},{"type":"file_change","ref":"8552d719cc7a4aacbdd68f1dbf66267957b7bd9a"},{"type":"deploy","ref":"34919945008"},{"type":"verify","ref":"typecheck+lint+test exit 0"},{"type":"ticket_update","ref":"1c536f51-2a93-4b50-8169-cb121a9721b3"},{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"}]',
      '```',
    ].join('\n');
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['1c536f51-2a93-4b50-8169-cb121a9721b3']);
  });

  it('ticket 00317531 conviction control: a ticket_update ref IS extracted for the existence check', () => {
    const text = [
      '```claims',
      '[{"type":"dispatch","ref":"daee2916-fa75-4159-94a1-3d767abfd192"},{"type":"ticket_update","ref":"9de0f1ab-1234-4abc-8def-000000000000"}]',
      '```',
    ].join('\n');
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['9de0f1ab-1234-4abc-8def-000000000000']);
  });

  it('ticket 00317531: an all-digit 8-hex ticket_update ref is accepted in typed context (prose date-guard does not apply)', () => {
    const text = '```claims\n[{"type":"ticket_update","ref":"00317531"}]\n```';
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['00317531']);
  });

  it('ticket 00317531: a MALFORMED claims block keeps the legacy generic scan (miss-safe fallback)', () => {
    // Unquoted keys → unparseable → the block is ignored as typed context and
    // the prose scan still lifts a uuid sharing a "ticket" line (the claims
    // lane separately flags the malformed block).
    const text = '```claims\n[{type:"ticket_update",ref:"eeeeeeee-1111-4222-8333-444444444444"}]\n```';
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['eeeeeeee-1111-4222-8333-444444444444']);
  });

  it('ticket 00317531: prose ticket citations OUTSIDE the block are unaffected when a block is present', () => {
    const text = [
      'Ticket 01226f89 was triaged.',
      '```claims',
      '[{"type":"ticket_update","ref":"1c536f51-2a93-4b50-8169-cb121a9721b3"}]',
      '```',
    ].join('\n');
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['01226f89', '1c536f51-2a93-4b50-8169-cb121a9721b3']);
  });

  it('ticket 59ac00bd F1 replay: an over-indented (≥4 spaces) pseudo-claims-block does NOT evade the generic scan', () => {
    // Reviewer sub-session 783bf716 (2026-09-15): the #777 exclusion span was
    // computed on TRIMMED lines, so a second fence indented ≥4 spaces matched
    // the span grammar while the RAW parser (strict 0–3-space opener) never
    // saw it — a fabricated ticket_update ref hidden there was excluded from
    // the generic /\bticket/i scan AND never lifted as typed context, evading
    // the feedback-store existence check entirely. Fixed: spans come from
    // parseClaimsBlocks (raw-line grammar, span ↔ parse bound), so the
    // pseudo-block stays on the generic scan and the invented uuid is lifted.
    const text = [
      'Done. Merged the fix via PR #777.',
      '```claims',
      '[{"type":"dispatch","ref":"daee2916-fa75-4159-94a1-3d767abfd192"}]',
      '```',
      '',
      '    ```claims',
      '    [{"type":"ticket_update","ref":"deadbeef-0000-4000-8000-000000000000"}]',
      '    ```',
    ].join('\n');
    // The invented id IS lifted for the existence check (pre-#777 behavior
    // restored); the VALID block's dispatch ref stays typed-scoped (never lifted).
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['deadbeef-0000-4000-8000-000000000000']);
  });

  it('ticket 59ac00bd F1 baseline: a lone over-indented pseudo-block (no valid block) keeps the generic scan', () => {
    const text = [
      '    ```claims',
      '    [{"type":"ticket_update","ref":"deadbeef-0000-4000-8000-000000000000"}]',
      '    ```',
    ].join('\n');
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual(['deadbeef-0000-4000-8000-000000000000']);
  });

  it('ticket 59ac00bd F2 replay: EVERY parsed claims block gets typed context — not just the last', () => {
    // Two raw-valid blocks (an earlier one quoted in an audit replay): #777
    // typed ONLY the last block, so the earlier block kept the legacy generic
    // scan and its single-line "ticket_update" shape lifted the sibling
    // dispatch uuid as a prose citation — the 00317531 false-strike shape
    // persisted. Fixed: both blocks are parsed; both spans are excluded;
    // ticket_update refs are lifted from EACH.
    const text = [
      'Audit replay — earlier struck block quoted verbatim:',
      '```claims',
      '[{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"},{"type":"ticket_update","ref":"00317531-7099-4202-85b9-5590f5a35e66"}]',
      '```',
      'And the live final block:',
      '```claims',
      '[{"type":"push","ref":"faa938a9545aab09c3eda0b21114bd56fc3f3089"},{"type":"ticket_update","ref":"59ac00bd-d5f3-4ae3-a8c5-8c24ac9e055a"}]',
      '```',
    ].join('\n');
    // BOTH ticket refs lifted (source order); NEITHER dispatch/push ref lifted.
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual([
      '00317531-7099-4202-85b9-5590f5a35e66',
      '59ac00bd-d5f3-4ae3-a8c5-8c24ac9e055a',
    ]);
  });

  it('ticket 59ac00bd F2: a MALFORMED earlier block keeps the generic scan while the valid later block gets typed context (per-block miss-safe)', () => {
    const text = [
      '```claims',
      '[{type:"ticket_update",ref:"eeeeeeee-1111-4222-8333-444444444444"}]', // unquoted keys → malformed
      '```',
      '```claims',
      '[{"type":"ticket_update","ref":"9de0f1ab-1234-4abc-8def-000000000000"}]',
      '```',
    ].join('\n');
    expect(extractTicketIdCitations(text).map((c) => c.id)).toEqual([
      'eeeeeeee-1111-4222-8333-444444444444', // prose-lifted from the malformed block
      '9de0f1ab-1234-4abc-8def-000000000000', // typed-lifted from the valid block
    ]);
  });
});

// ── Guards 5/6 at the finalize seam: the 2026-08-29 incident replays ────────

describe('applyCompletionClaimGuard — guards 5/6 (ticket 8e9d6496 incident replays)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
  const NOW = new Date('2026-08-29T06:17:30.000Z');

  it('INCIDENT 1 composite: phantom PR + phantom deploy-run + invented ticket ids ALL convict', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(404)));
    const resolver = jest.fn(async () => new Set<string>());
    const out = await applyCompletionClaimGuard({
      finalText: [
        'Ticket lifecycle shipped: merged PR #481, deploy 33236656591 completed success.',
        'Open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
      ].join('\n'),
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(out.verdict.fabricatedPrs).toEqual([481]);
    expect(out.verdict.fabricatedDeployRuns).toEqual(['33236656591']);
    expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    const summary = summarizeGuardVerdict(out.verdict);
    expect(summary).toContain('fabricated PR claims');
    expect(summary).toContain('fabricated deploy-run claims (no such GitHub Actions run): 33236656591');
    expect(summary).toContain('fabricated feedback-ticket ids (no such ticket): 01226f89, 4de4a5ef');
    expect(out.finalText).toContain('Harness deploy-run verification');
    expect(out.finalText).toContain('FABRICATED TICKET IDS');
    expect(resolver).toHaveBeenCalledWith(['01226f89', '4de4a5ef']);
    expect(String(mockFetch.mock.calls.map((c) => String(c[0])).join(' '))).toContain('/actions/runs/33236656591');
  });

  it('INCIDENT 2 replay: "completed success" while the run is in_progress → REFUTED + the future stamp fires (pre-claims-gate lane)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success at 06:30:44Z',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.refutedDeployRuns).toEqual(['33236939738']);
    expect(out.verdict.futureDated).toHaveLength(1);
    expect(out.verdict.futureDated[0]).toContain('06:30:44Z');
    expect(out.finalText).toContain('REFUTED');
    expect(out.finalText).toContain('FUTURE-DATED CLAIMS');
    expect(String(mockFetch.mock.calls[0][0])).toContain('/actions/runs/33236939738');
  });

  it('INCIDENT 2b: the same line against a REAL completed/success run → no deploy finding (the future stamp still fires)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success at 06:30:44Z',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.fabricatedDeployRuns ?? []).toEqual([]);
    expect(out.verdict.refutedDeployRuns ?? []).toEqual([]);
    expect(out.finalText).toContain('✅ EXISTS');
    expect(out.verdict.futureDated).toHaveLength(1);
  });

  it('claim→journal lane: a deploy-run id THIS run observed (toolTexts) skips the API entirely', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      toolTexts: ['poll 06:12Z: {"id":33236939738,"status":"completed","conclusion":"success"}'],
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedDeployRuns ?? []).toEqual([]);
    expect(out.verdict.refutedDeployRuns ?? []).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('INCIDENT 3 replay: invented batch ticket ids convict with NO fetch (existence is store-backed)', async () => {
    const resolver = jest.fn(async () => new Set<string>());
    const out = await applyCompletionClaimGuard({
      finalText: 'Nightly triage complete — the open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(resolver).toHaveBeenCalledWith(['01226f89', '4de4a5ef']);
    expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
    expect(out.finalText).toContain('FABRICATED TICKET IDS');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('REAL ticket ids pass clean (resolver confirms) — and NO clean-pass footer (annotation noise)', async () => {
    const resolver = jest.fn(async () => new Set<string>(['01226f89', '4de4a5ef']));
    const out = await applyCompletionClaimGuard({
      finalText: 'Triaged the batch: tickets 01226f89 / 4de4a5ef both closed.',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('ticket 00317531 E2E replay: a dispatch-type claims-block ref is NEVER existence-checked against the feedback store', async () => {
    // The 2026-09-15 false strike (chat b92ef13f msg 80af58c5): the claims
    // block cited a REAL cross-run start_coding_session receipt
    // (0867090a-…, reviewer sub-session 66ddd09d) whose id is absent from
    // this run's haystacks; the single-line block's "ticket_update" text made
    // /\bticket/i match the whole line and shape (a) lifted the dispatch uuid
    // as a ticket citation → FABRICATED TICKET IDS on a fully-real receipt.
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
    const resolver = jest.fn(async () => new Set<string>(['1c536f51-2a93-4b50-8169-cb121a9721b3']));
    const out = await applyCompletionClaimGuard({
      finalText: [
        'Per-ticket summary table posted above.',
        '```claims',
        '[{"type":"push","ref":"276a3e9e5278ab5daab25c1b81556a71774ace8c"},{"type":"pr","ref":"776"},{"type":"file_change","ref":"8552d719cc7a4aacbdd68f1dbf66267957b7bd9a"},{"type":"deploy","ref":"34919945008"},{"type":"verify","ref":"typecheck+lint+test exit 0"},{"type":"ticket_update","ref":"1c536f51-2a93-4b50-8169-cb121a9721b3"},{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"}]',
        '```',
      ].join('\n'),
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    // The resolver sees ONLY the ticket_update ref — the dispatch/session,
    // push, file_change and deploy refs never reach the feedback store.
    expect(resolver).toHaveBeenCalledWith(['1c536f51-2a93-4b50-8169-cb121a9721b3']);
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
  });

  it('ticket 00317531 E2E conviction control: a fabricated ticket_update claims ref still convicts (and names no other ref)', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
    const resolver = jest.fn(async () => new Set<string>());
    const out = await applyCompletionClaimGuard({
      finalText: [
        '```claims',
        '[{"type":"ticket_update","ref":"1c536f51-2a93-4b50-8169-cb121a9721b3"},{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"}]',
        '```',
      ].join('\n'),
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(resolver).toHaveBeenCalledWith(['1c536f51-2a93-4b50-8169-cb121a9721b3']);
    expect(out.verdict.fabricatedTicketIds).toEqual(['1c536f51-2a93-4b50-8169-cb121a9721b3']);
    expect(out.finalText).toContain('FABRICATED TICKET IDS');
    // The strike NOTE names only the ticket ref — the dispatch receipt id rides
    // the delivered block verbatim but is never cited as a fabricated ticket.
    const noteLine = out.finalText.split('\n').find((l) => l.includes('do not exist in the feedback store')) ?? '';
    expect(noteLine).toContain('1c536f51');
    expect(noteLine).not.toContain('0867090a');
  });

  it('ticket 59ac00bd F1 E2E replay: a fabricated ticket_update ref in an over-indented pseudo-block CONVICTS (no guard-6 evasion)', async () => {
    // Reviewer sub-session 783bf716: pre-fix, the second fence (indented ≥4
    // spaces) was span-excluded from the generic scan on TRIMMED lines yet
    // never parsed (raw grammar), so the invented uuid below reached NO
    // existence check — the resolver was never called with it and the final
    // shipped clean. Post-fix the resolver sees it and it convicts.
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
    const resolver = jest.fn(async () => new Set<string>());
    const out = await applyCompletionClaimGuard({
      finalText: [
        'Done. Merged the fix via PR #777.',
        '```claims',
        '[{"type":"dispatch","ref":"daee2916-fa75-4159-94a1-3d767abfd192"}]',
        '```',
        '',
        '    ```claims',
        '    [{"type":"ticket_update","ref":"deadbeef-0000-4000-8000-000000000000"}]',
        '    ```',
      ].join('\n'),
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(resolver).toHaveBeenCalledWith(['deadbeef-0000-4000-8000-000000000000']);
    expect(out.verdict.fabricatedTicketIds).toEqual(['deadbeef-0000-4000-8000-000000000000']);
    expect(out.finalText).toContain('FABRICATED TICKET IDS');
  });

  it('ticket 59ac00bd F2 E2E replay: the resolver sees EVERY parsed block\'s ticket_update refs — and never their dispatch/push refs', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
    const resolver = jest.fn(async () => new Set<string>(['00317531-7099-4202-85b9-5590f5a35e66', '59ac00bd-d5f3-4ae3-a8c5-8c24ac9e055a']));
    const out = await applyCompletionClaimGuard({
      finalText: [
        'Audit replay — earlier struck block quoted verbatim:',
        '```claims',
        '[{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"},{"type":"ticket_update","ref":"00317531-7099-4202-85b9-5590f5a35e66"}]',
        '```',
        'And the live final block:',
        '```claims',
        '[{"type":"push","ref":"faa938a9545aab09c3eda0b21114bd56fc3f3089"},{"type":"ticket_update","ref":"59ac00bd-d5f3-4ae3-a8c5-8c24ac9e055a"}]',
        '```',
      ].join('\n'),
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    // Both blocks' ticket refs — the earlier block's dispatch uuid (a REAL
    // cross-run receipt) never reaches the feedback store: no false strike.
    expect(resolver).toHaveBeenCalledWith(['00317531-7099-4202-85b9-5590f5a35e66', '59ac00bd-d5f3-4ae3-a8c5-8c24ac9e055a']);
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
  });

  it('claim→journal lane: a cited id already in this run\'s evidence never reaches the resolver', async () => {
    const resolver = jest.fn(async () => new Set<string>());
    const out = await applyCompletionClaimGuard({
      finalText: 'ticket 01226f89 is handled',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      toolTexts: ['{"tickets":[{"id":"01226f89-1111-2222-3333-444444444444","title":"x"}]}'],
      ticketIdsExist: resolver,
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
  });

  it('no resolver injected → the ticket lane stays SILENT', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'the open batch is 11 tickets: 01226f89 / 4de4a5ef',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
  });

  it('a THROWING resolver stays silent (never a conviction on infra)', async () => {
    const resolver = jest.fn(async () => { throw new Error('db down'); });
    const out = await applyCompletionClaimGuard({
      finalText: 'the open batch is 11 tickets: 01226f89 / 4de4a5ef',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
  });

  it('GitHub 500 on the Actions API → the deploy lane renders NOTHING and touches NO verdict field', async () => {
    mockFetch.mockResolvedValue(ghResponse(500));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.fabricatedDeployRuns ?? []).toEqual([]);
    expect(out.verdict.refutedDeployRuns ?? []).toEqual([]);
    expect(out.finalText).not.toContain('Harness deploy-run verification');
  });

  it('clean pass: an honest final with no claim classes keeps a clean verdict', async () => {
    const resolver = jest.fn(async () => new Set<string>());
    const text = 'Reviewed the board and the journal; nothing actionable this turn.';
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      ticketIdsExist: resolver,
    });
    expect(out.finalText).toBe(text);
    expect(out.notes).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  // ── ticket dc636d0c: a receipt-backed goal/todo id cited under the claims
  // fence's ticket_update type is LEGITIMATE ledger work, never a fabricated
  // ticket id. The claims vocabulary (claims-block.ts) documents ticket_update
  // refs as ids.ticketId | ids.goalId | ids.todoId, but GUARD 6 resolved every
  // fence ref against the feedback store alone.
  describe('ticket dc636d0c — goal/todo ids in claims-fence ticket_update refs', () => {
    const ledgerReceipt = (tool: string, ok: boolean, ids: Record<string, unknown>): ToolReceipt => ({
      id: `r-${tool}`, chatId: 'c1', runId: 'run1', tool, ok, ids,
      inputHash: null, outputHash: null, createdAt: NOW,
    });
    const fence = (ref: string): string => [
      'Ledger work done: todo closed and goal premise registered.',
      '```claims',
      `[{"type":"ticket_update","ref":"${ref}"}]`,
      '```',
    ].join('\n');

    it('INCIDENT replay: a REAL todo id under ticket_update + a receipt carrying ids.todoId → NO strike', async () => {
      // Coding lane 60dfc8a8 (Schooltime), msg 3db88de6: the run's ledger
      // writes were todo_update/goal_premise_set on todo 71c98f40 and goal
      // 8f0dcd6f; the fence cited the todo id under ticket_update and the
      // guard struck it as a fabricated FEEDBACK-ticket id. Two exoneration
      // legs: the todo_update receipt (ids.todoId) and the todo board.
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>()); // the feedback store does NOT have it
      const todos = jest.fn(async () => new Set<string>(['71c98f40']));
      const out = await applyCompletionClaimGuard({
        finalText: fence('71c98f40'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        receipts: [ledgerReceipt('todo_update', true, { todoId: '71c98f40-1111-2222-3333-444444444444' })],
        ticketIdsExist: tickets, todoIdsExist: todos,
      });
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
      expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
      // The todo_update RECEIPT alone exonerates the id even when the board
      // resolver is absent (older wiring) or the board lookup misses.
      expect(todos).not.toHaveBeenCalled();
    });

    it('INCIDENT replay: a REAL goal id under ticket_update (no receipt in this run) → the goal board exonerates it', async () => {
      // The 8f0dcd6f half of the incident: a goal_premise_set in an EARLIER
      // run (carried) or a cross-lane goal — no ids.goalId receipt THIS run,
      // so the union-resolve against the goal board is the exoneration leg.
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>(['8f0dcd6f']));
      const out = await applyCompletionClaimGuard({
        finalText: fence('8f0dcd6f'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals,
      });
      expect(goals).toHaveBeenCalledWith(['8f0dcd6f']);
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
      expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
    });

    it('a receipt carrying ids.goalId (goal_premise_set) exonerates a fence ticket_update ref', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: fence('8f0dcd6f'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        receipts: [ledgerReceipt('goal_premise_set', true, { goalId: '8f0dcd6f-aaaa-bbbb-cccc-dddddddddddd' })],
        ticketIdsExist: tickets,
      });
      expect(tickets).not.toHaveBeenCalled();
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
      expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
    });

    it('absent board resolvers: the ticket store stays the only resolver — a real-todo id NOT in a receipt still strikes (pre-wiring behavior is honest, not silent)', async () => {
      // Back-compat: a lane on an older executor (no goalIdsExist) with a
      // goal/todo id that has no THIS-run receipt still gets the OLD verdict.
      // This documents the residual gap, not a regression: the incident lane
      // HAD the todo_update receipt, so this shape never fired there.
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: fence('71c98f40'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['71c98f40']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });

    it('a THROWING board resolver exonerates its fence ids (fail-open — a DB hiccup must not re-create the false strike)', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => { throw new Error('db down'); });
      const out = await applyCompletionClaimGuard({
        finalText: fence('8f0dcd6f'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals,
      });
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
      expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
    });

    it('a fence id in NEITHER store still convicts (the guard keeps its recall on invented ledger ids)', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>());
      const todos = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: fence('deadbeef'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals, todoIdsExist: todos,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['deadbeef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
      // The board resolvers are consulted for FENCE refs (the union leg).
      expect(goals).toHaveBeenCalledWith(['deadbeef']);
      expect(todos).toHaveBeenCalledWith(['deadbeef']);
    });

    it('a PROSE batch citation is NEVER board-resolved: invented "tickets 01226f89 / 4de4a5ef" still convict even when a goal board holds them', async () => {
      // The 8e9d6496 recall is the load-bearing invariant: prose ticket
      // citations stay feedback-store-only. A lane must not launder an
      // invented ticket id by ALSO naming a goal of the same id.
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>(['01226f89']));
      const todos = jest.fn(async () => new Set<string>(['01226f89']));
      const out = await applyCompletionClaimGuard({
        finalText: 'The open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals, todoIdsExist: todos,
      });
      expect(tickets).toHaveBeenCalledWith(['01226f89', '4de4a5ef']);
      expect(goals).not.toHaveBeenCalled();
      expect(todos).not.toHaveBeenCalled();
      expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });

    it('mixed fence: a real todo id AND an invented id in one block — only the invented id strikes', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const todos = jest.fn(async () => new Set<string>(['71c98f40']));
      const goals = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          'Ledger: one todo closed; one id invented.',
          '```claims',
          '[{"type":"ticket_update","ref":"71c98f40"},{"type":"ticket_update","ref":"4de4a5ef"}]',
          '```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, todoIdsExist: todos, goalIdsExist: goals,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['4de4a5ef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
      const noteLine = out.finalText.split('\n').find((l) => l.includes('do not exist in the feedback store')) ?? '';
      expect(noteLine).toContain('4de4a5ef');
      expect(noteLine).not.toContain('71c98f40');
    });

    it('an id cited BOTH in prose and in a fence takes the union (exoneration superset)', async () => {
      // The same id on a prose ticket line AND a fence ticket_update entry:
      // the fence classification wins the union leg — if either board holds
      // it, no strike (misses acceptable, false convictions not).
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const todos = jest.fn(async () => new Set<string>(['71c98f40']));
      const out = await applyCompletionClaimGuard({
        finalText: [
          'Ticket 71c98f40 work is done — the todo is closed.',
          '```claims',
          '[{"type":"ticket_update","ref":"71c98f40"}]',
          '```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, todoIdsExist: todos,
      });
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
      expect(out.finalText).not.toContain('FABRICATED TICKET IDS');
    });

    it('extractor: the fromClaimsFence flag is set on fence-lifted refs only', () => {
      const cites = extractTicketIdCitations([
        'The open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
        '```claims',
        '[{"type":"ticket_update","ref":"71c98f40"}]',
        '```',
      ].join('\n'));
      const byId = new Map(cites.map((c) => [c.id, c]));
      expect(byId.get('01226f89')?.fromClaimsFence).toBeUndefined();
      expect(byId.get('71c98f40')?.fromClaimsFence).toBe(true);
    });

    it('a non-ticket_update fence ref (dispatch) is never lifted at all — and never board-resolved', async () => {
      // 00317531 parity: dispatch/push/pr refs never reach ANY existence
      // check. The board resolvers must not widen that hole.
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>());
      const todos = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          'Dispatched the reviewer.',
          '```claims',
          '[{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"}]',
          '```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals, todoIdsExist: todos,
      });
      expect(tickets).not.toHaveBeenCalled();
      expect(goals).not.toHaveBeenCalled();
      expect(todos).not.toHaveBeenCalled();
      expect(out.verdict.fabricatedTicketIds ?? []).toEqual([]);
    });
  });

  // DETECTOR-RECALL REPLAY: this PR touches coding/run-evidence-guard.ts (a
  // framework detector), so it replays the guard's PRIOR true positives —
  // the convicting cases above — and asserts they STILL convict after the
  // dc636d0c union-resolve change. The relaxations must not erode recall:
  //   1. the 8e9d6496 incident-3 invented batch ids (prose citations),
  //   2. the 00317531 conviction control (fabricated ticket_update fence ref),
  //   3. the 59ac00bd F1 indented pseudo-block evasion,
  //   4. the invented ledger id in NEITHER board (fence recall),
  //   5. prose laundering attempt (boards hold the id, prose still convicts).
  describe('DETECTOR-RECALL REPLAY — the evidence guard\'s prior true positives still convict', () => {
    it('8e9d6496 incident 3: invented prose batch ticket ids still convict with no fetch', async () => {
      const resolver = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: 'Nightly triage complete — the open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: resolver,
      });
      expect(resolver).toHaveBeenCalledWith(['01226f89', '4de4a5ef']);
      expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('8e9d6496 incident 1 composite: phantom PR + phantom deploy + invented ticket ids ALL convict together', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(ghResponse(404)));
      const resolver = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          'Ticket lifecycle shipped: merged PR #481, deploy 33236656591 completed success.',
          'Open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: resolver,
      });
      expect(out.verdict.fabricatedPrs).toEqual([481]);
      expect(out.verdict.fabricatedDeployRuns).toEqual(['33236656591']);
      expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });

    it('00317531 conviction control: a fabricated ticket_update fence ref still convicts (and names no other ref)', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
      const resolver = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          '```claims',
          '[{"type":"ticket_update","ref":"1c536f51-2a93-4b50-8169-cb121a9721b3"},{"type":"dispatch","ref":"0867090a-62ff-4221-8ecf-0426e030b665"}]',
          '```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: resolver,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['1c536f51-2a93-4b50-8169-cb121a9721b3']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
      const noteLine = out.finalText.split('\n').find((l) => l.includes('do not exist in the feedback store')) ?? '';
      expect(noteLine).toContain('1c536f51');
      expect(noteLine).not.toContain('0867090a');
    });

    it('59ac00bd F1: a fabricated ticket_update ref in an over-indented pseudo-block still convicts', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(ghResponse(200, { status: 'completed', conclusion: 'success' })));
      const resolver = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          'Done. Merged the fix via PR #777.',
          '```claims',
          '[{"type":"dispatch","ref":"daee2916-fa75-4159-94a1-3d767abfd192"}]',
          '```',
          '',
          '    ```claims',
          '    [{"type":"ticket_update","ref":"deadbeef-0000-4000-8000-000000000000"}]',
          '    ```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: resolver,
      });
      expect(resolver).toHaveBeenCalledWith(['deadbeef-0000-4000-8000-000000000000']);
      expect(out.verdict.fabricatedTicketIds).toEqual(['deadbeef-0000-4000-8000-000000000000']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });

    it('fence recall: an invented ledger id in NEITHER board still convicts even with both board resolvers wired', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>());
      const todos = jest.fn(async () => new Set<string>());
      const out = await applyCompletionClaimGuard({
        finalText: [
          '```claims',
          '[{"type":"ticket_update","ref":"4de4a5ef"}]',
          '```',
        ].join('\n'),
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals, todoIdsExist: todos,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['4de4a5ef']);
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });

    it('laundering attempt: prose ticket citations never board-resolve — the invented ids still convict', async () => {
      mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
      const tickets = jest.fn(async () => new Set<string>());
      const goals = jest.fn(async () => new Set<string>(['01226f89', '4de4a5ef']));
      const todos = jest.fn(async () => new Set<string>(['01226f89', '4de4a5ef']));
      const out = await applyCompletionClaimGuard({
        finalText: 'The open batch is 11 tickets: 01226f89 / 4de4a5ef, all triaged.',
        parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
        ticketIdsExist: tickets, goalIdsExist: goals, todoIdsExist: todos,
      });
      expect(out.verdict.fabricatedTicketIds).toEqual(['01226f89', '4de4a5ef']);
      expect(goals).not.toHaveBeenCalled();
      expect(todos).not.toHaveBeenCalled();
      expect(out.finalText).toContain('FABRICATED TICKET IDS');
    });
  });
});

// ── REJECT-BACK lane (ticket dc04deea — f8d68167 option (b)) ────────────────
// The in-loop pre-submission gate: the notice that goes BACK TO THE MODEL and
// the decision helper the agentLoop clean-finish exit calls.

describe('guard reject-back (ticket dc04deea)', () => {
  const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

  beforeEach(() => {
    // GitHub verification 'unavailable' — only the deterministic lanes fire
    // (no token → pulls/commits/actions lanes return 'unavailable', which is
    // SILENT: never a conviction, never a footer).
    mockGetValidToken.mockResolvedValue(null);
  });

  describe('renderGuardRejectBackNotice', () => {
    const longClaim = `Merged PR #57 with the full migration verified — ${'x'.repeat(200)}`;
    const fullVerdict = (): GuardVerdict => ({
      unprovenKinds: ['pr_merged', 'deploy'],
      unprovenClaims: [1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'pr_merged', prNumber: 57, text: n === 1 ? longClaim : `claim line ${n}` }) as CompletionClaim),
      fabricatedPrs: [57, 58],
      refutedMergePrs: [60],
      futureDated: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
      forgedFooter: true,
      fabricatedShas: ['aaaaaaaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbbbbbbb2', 'cccccccccccccccccccc3', 'dddddddddddddddddddd4', 'eeeeeeeeeeeeeeeeeeee5', 'ffffffffffffffffffff6'],
      fabricatedQuotes: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
      fabricatedDeployRuns: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
      refutedDeployRuns: ['r1', 'r2'],
      fabricatedTicketIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
    });

    it('renders EVERY finding class with its missing-receipt list', () => {
      const notice = renderGuardRejectBackNotice(fullVerdict());
      expect(notice).toContain('evidence guard REJECTED your previous answer');
      expect(notice).toContain("zero-evidence completion claims (no successful tool call in each claim's evidence class this run): pr_merged, deploy");
      expect(notice).toContain('fabricated PR claims (GitHub has no such PR): #57, #58');
      expect(notice).toContain('merge claims refuted by GitHub (the PR is not merged): #60');
      expect(notice).toContain("future-dated observation claims (later than this run's real clock): f1; f2; f3; f4; f5");
      expect(notice).toContain('forged harness markers (the answer imitated harness-only output)');
      expect(notice).toContain('fabricated push shas (no such commit on origin): aaaaaaaaaaaa, bbbbbbbbbbbb, cccccccccccc, dddddddddddd, eeeeeeeeeeee');
      expect(notice).toContain('quoted "verbatim output" no tool produced: "q1", "q2", "q3", "q4", "q5"');
      expect(notice).toContain('fabricated deploy-run ids (GitHub Actions has no such run): d1, d2, d3, d4, d5');
      expect(notice).toContain('deploy-completion claims refuted by GitHub Actions: r1, r2');
      expect(notice).toContain('fabricated feedback-ticket ids (no such ticket exists): t1, t2, t3, t4, t5');
      expect(notice).toContain('Do the verification NOW with real tool calls');
      expect(notice).toContain('attempted, unverified');
    });

    it('caps every list at 5 entries', () => {
      const notice = renderGuardRejectBackNotice(fullVerdict());
      expect(notice).not.toContain('f6');
      expect(notice).not.toContain('ffffffffffffffffffff6'.slice(0, 12));
      expect(notice).not.toContain('"q6"');
      expect(notice).not.toContain('d6');
      expect(notice).not.toContain('t6');
      expect(notice).not.toContain('claim line 6');
    });

    it('truncates long claim texts at 120 chars with an ellipsis', () => {
      const notice = renderGuardRejectBackNotice(fullVerdict());
      expect(notice).toContain(`"${longClaim.slice(0, 120)}…"`);
      expect(notice).not.toContain(`${'x'.repeat(121)}`);
    });

    it('CHROME RULE: the notice NEVER contains the harness-only conviction chrome (FORGED_MARKER_RES patterns)', () => {
      const notice = renderGuardRejectBackNotice(fullVerdict());
      for (const chrome of [
        'Harness claim verification (verified-at',
        'REPLACED]',
        'REMOVED]',
        'BEGIN UNVERIFIED RUN OUTPUT',
        'UNVERIFIED QUOTED OUTPUT',
      ]) {
        expect(notice).not.toContain(chrome);
      }
    });
  });

  describe('evaluateFinalCandidateForRejectBack', () => {
    const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, n = 1): ToolReceipt => ({
      id: `r${n}`, chatId: 'c1', runId: 'run1', tool, ok, ids,
      inputHash: null, outputHash: null, createdAt: new Date('2026-08-20T23:30:00.000Z'),
    });

    it("triggerKind 'user' + a zero-evidence claim → NOT rejected (user runs are never gated)", async () => {
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'PR #57 merged at 10:00Z', parts: [], triggerKind: 'user', resumed: false,
        ...OPTS, receipts: [],
      });
      expect(out).toEqual({ rejected: false });
    });

    it("triggerKind 'schedule' + a zero-evidence pr_merged claim (empty receipts) → REJECTED with the missing-receipt notice", async () => {
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'PR #57 merged at 10:00Z', parts: [], triggerKind: 'schedule', resumed: false,
        ...OPTS, receipts: [],
      });
      expect(out.rejected).toBe(true);
      expect(out.notice).toContain('pr_merged');
      expect(out.notice).toContain('attempted, unverified');
      expect(out.summary).toContain('pr_merged');
    });

    it('the same claim WITH a matching ok receipt → NOT rejected (receiptMatchesClaim exonerates)', async () => {
      // No clock stamp on the claim text: evaluateFinalCandidateForRejectBack
      // resolves the guard against the REAL wall clock (no `now` seam), and a
      // clock-only stamp inside GUARD 3's 3h future window would convict on
      // wall time alone — the receipt lane under test must stay deterministic.
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'PR #57 merged after green CI.', parts: [], triggerKind: 'schedule', resumed: false,
        ...OPTS, receipts: [receipt('run_command', true)],
      });
      expect(out).toEqual({ rejected: false });
    });

    it('a PRIOR attempts receipt exonerates a resumed run (unioned in-process-first)', async () => {
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'PR #57 merged after green CI.', parts: [], triggerKind: 'schedule', resumed: true,
        ...OPTS, receipts: [], priorReceipts: [receipt('run_command', true)],
      });
      expect(out).toEqual({ rejected: false });
    });

    it('a clean finalText (no claims) → NOT rejected', async () => {
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'Reviewed the board and the journal; nothing actionable this turn.',
        parts: [], triggerKind: 'machine', resumed: false, ...OPTS, receipts: [],
      });
      expect(out).toEqual({ rejected: false });
    });

    it('never throws: a guard-side failure degrades to NOT rejected (the executor replace lane stays the fallback)', async () => {
      // applyCompletionClaimGuard itself NEVER throws (its own outer catch) —
      // so exercise evaluateFinalCandidateForRejectBack's catch with a null
      // receipts array: the in-process-first union spread throws TypeError.
      const out = await evaluateFinalCandidateForRejectBack({
        finalText: 'PR #57 merged after green CI.', parts: [], triggerKind: 'schedule', resumed: false,
        ...OPTS, receipts: null as any,
      });
      expect(out).toEqual({ rejected: false });
    });
  });
});

/**
 * Ticket 680dd00a (session c9ccf88a — evidence-guard strikes on a coding
 * schedule run): pins the ticket's exact strike shapes so the convictions
 * stay true-positive. Sighting 1 (2026-08-28): a "22:45Z" observation clock
 * claimed ~22 minutes ahead of the run's real 22:22:49Z clock. Sighting 2
 * (2026-09-01): a "22:09Z" clock ~4 minutes ahead of the real 22:05:09Z clock
 * — small-ahead is still a REAL evasion class (FUTURE_SKEW_MS = 90s is
 * deliberate; widening was rejected for ticket 80dd882d). Sighting 3
 * (2026-09-03): zero-evidence deploy + probe completion claims with an
 * empty tool journal — findUnprovenClaims flags both kinds.
 */
describe('ticket 680dd00a — session c9ccf88a strikes stay convicted', () => {
  it('sighting 1: a 22:45Z observation clock +22m ahead of the 22:22:49Z run clock is flagged', () => {
    const NOW = new Date('2026-08-28T22:22:49.000Z');
    const fd = findFutureDatedClaims('Fleet probe at 22:45Z confirmed the lane idle', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].stamp).toBe('22:45Z');
    expect(fd[0].aheadMs).toBeGreaterThan(90_000);
  });

  it('sighting 2: a 22:09Z clock +4m ahead of the 22:05:09Z run clock is flagged (small-ahead is a real evasion class)', () => {
    const NOW = new Date('2026-09-01T22:05:09.000Z');
    const fd = findFutureDatedClaims('Deploy watch at 22:09Z showed the run green', NOW);
    expect(fd).toHaveLength(1);
    expect(fd[0].aheadMs).toBeGreaterThan(90_000);
  });

  it('sighting 3: zero-evidence deploy + probe claims are flagged when the journal is empty', () => {
    const claims = findUnprovenClaims('Deploy green, health check 200.\nBox probe 03:07:22: items.jsonl 511 lines, md5 50dd0c04.', []);
    const kinds = claims.map((c) => c.kind);
    expect(kinds).toContain('deploy');
    expect(kinds).toContain('probe');
  });
});

// Replay pins — ticket 02102222 (2026-09-05): session a8976e11 (Tenstorrent
// R&D, kimi-k3) struck three times. Sighting 2 quoted a recalled traceback
// line as observed output ("File \".../ttnn_gated_attention.py\", line 398,
// in gated_atten") that no tool result of the run produced — the elided path
// (".../") is itself a fabrication tell, tools print real paths. Sighting 3
// restated prompt-carried production status as a this-run probe observation
// with no probe evidence in the journal (answer withheld). All three strikes
// were true positives; these pins keep the convictions stable. Sighting 1's
// lanes (phantom PR GitHub-404, +4m/+5m future clocks) are already pinned by
// the GitHub-verify tests and the 680dd00a block above.
describe('ticket 02102222 — session a8976e11 strikes stay convicted', () => {
  it('sighting 2: a recalled traceback line with an elided path quoted as observed output is flagged', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', name: 'run_command', args: { command: 'tail -50 /var/log/tt-flashnext.log' } },
      { type: 'tool_result', name: 'run_command', result: 'INFO serving on :8091\nINFO decode tick' },
    ];
    const text = [
      'The box log shows:',
      '```',
      'INFO serving on :8091',
      'File ".../ttnn_gated_attention.py", line 398, in gated_atten',
      '```',
    ].join('\n');
    const out = findUnmatchedQuotedOutputs(text, parts);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('ttnn_gated_attention.py');
    expect(out[0].matched).toBe(1);
    expect(out[0].total).toBe(2);
  });

  it('sighting 2 honest shape: the same line attributed to a previous run is suppressed (past-run carryover lane)', () => {
    const text = [
      'Log tail (previous run observed):',
      '```',
      'File ".../ttnn_gated_attention.py", line 398, in gated_atten',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, [])).toEqual([]);
  });

  it('sighting 2 control: the same traceback line present in a real tool result is an honest quote', () => {
    const parts: MessagePart[] = [
      { type: 'tool_result', name: 'run_command', result: 'Traceback (most recent call last):\nFile ".../ttnn_gated_attention.py", line 398, in gated_atten' },
    ];
    const text = [
      'The box log shows:',
      '```',
      'File ".../ttnn_gated_attention.py", line 398, in gated_atten',
      '```',
    ].join('\n');
    expect(findUnmatchedQuotedOutputs(text, parts)).toEqual([]);
  });

  it('sighting 3: a probe claim restating prompt-carried production status with no probe evidence in the journal is flagged', () => {
    const claims = findUnprovenClaims('Box watch this firing: tt-flashnext Up healthy on :8091, /v1/models HTTP 200, serve md5 verified.', []);
    expect(claims.map((c) => c.kind)).toContain('probe');
  });
});
