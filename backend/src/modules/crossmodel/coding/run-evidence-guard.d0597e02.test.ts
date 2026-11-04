/**
 * Replay/regression tests for feedback ticket d0597e02 (mishap, fleet-integrity,
 * priority 5, 3 occurrences within ~4 minutes on 2026-09-09):
 * "Evidence guard: machine run asserted unproven completions".
 *
 * THE MISHAP BEING REPLAYED — two sighting shapes across three sessions:
 *
 *   Shape A — GUARD-4 / CLAIMS-CONTRACT TRAP (sightings 1-2, sessions 10cb988f
 *   run 3d5df466 and cec340f2 run c1b5ea5c): the run's final ended with the
 *   harness-MANDATED terminal ```claims fence, but the ≤2 prose lines above
 *   the fence carried a guard-4 observation cue ("output / returned / receipts
 *   / verbatim / verified"). findUnmatchedQuotedOutputs then scanned the
 *   model-authored claims JSON as a "quoted verbatim output" block — and since
 *   a {type,ref} self-report can NEVER appear in a tool result, the run struck
 *   fabricatedQuotes. Both strike exhibits were the run's OWN claims array
 *   ("[{\"type\":\"file_change\",\"ref\":\"a530c4dd…"). The commit the run
 *   cited was REAL (a530c4dd is the session-branch tip, authored mid-run) —
 *   the conviction lane itself was mismatched: the claims block's truth
 *   channel is the CLAIMS lane (applyClaimsBlockLane's receipt check), never
 *   the quote lane. FIX: findUnmatchedQuotedOutputs now skips info==='claims'
 *   fences outright.
 *
 *   Shape B — REFUTED MERGE CLAIM (sighting 3, session a8976e11 run 86d57acb):
 *   the run claimed its fold PR #535 on canada-quant/tt-rd MERGED; GitHub
 *   shows that PR OPEN (merged:false). Guard 2's refutedMergePrs lane was the
 *   true positive; pinned here so it can never regress. (Session-side fix is
 *   behavioral: GUARD-RECURRENCE rule steered into schedule 1fbe4800 —
 *   never assert a merge without a this-firing GET quoting merged:true.)
 *
 * These tests pin, against the REAL guard:
 *   1. shape A is CLEAN post-fix — the mandated claims fence is exempt from
 *      the quote lane even under a cue-word intro (the exact trap shape);
 *   2. NO HOLE: the same claims JSON quoted as "output" in a non-claims fence
 *      (json / bare) STILL strikes fabricatedQuotes — fabricated tool
 *      envelopes remain convicted;
 *   3. the compliant shape (cue-free line above the fence) was and stays
 *      clean — no behavior change for disciplined runs;
 *   4. shape B stays convicted: an open PR claimed merged refutes; a merged
 *      PR claimed merged verifies clean.
 *
 * Boundary-mocked like run-evidence-guard.680dd00a.test.ts: logger + the
 * GitHub token manager are stubs; global.fetch is stubbed per case; the REAL
 * guard module executes.
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
  applyCompletionClaimGuard, findUnmatchedQuotedOutputs,
  summarizeGuardVerdict, verdictHasFindings,
} from './run-evidence-guard';
import type { MessagePart } from './agent';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/canada-quant/tt-rd', provider: 'github' };
const NOW = new Date('2026-09-09T06:44:00.000Z');

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();
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

/**
 * Sighting-1 exhibit (session 10cb988f, run 3d5df466): the strike exhibit was
 * the run's own claims array — the commit a530c4dd is REAL (session-branch
 * tip, authored 2026-09-09T06:35:19Z mid-run) but the quote lane can never
 * match a {type,ref} self-report against a tool result.
 */
const CLAIMS_ARRAY = '[{"type":"file_change","ref":"a530c4ddc4fe419ec208cefb7e26b6ae4d7c3fb0"},{"type":"push","ref":"a530c4ddc4fe419ec208cefb7e26b6ae4d7c3fb0"}]';

/** A tool result that does NOT contain the claims JSON (the run did real work). */
const PARTS: MessagePart[] = [
  { type: 'tool_call', name: 'run_command', args: { command: 'date -u' } },
  { type: 'tool_result', name: 'run_command', result: 'Wed Sep 9 06:35:19 UTC 2026' },
];

describe('ticket d0597e02 replay — shape A: the claims-fence trap (sessions 10cb988f 3d5df466, cec340f2 c1b5ea5c)', () => {
  it('REPLAY: the mandated ```claims fence under a cue-word intro is EXEMPT from the quote lane (post-fix)', () => {
    // The exact trap shape: a prose line carrying a guard-4 observation cue
    // ("output … receipts") directly above the REQUIRED terminal claims fence.
    const text = [
      'Docs update committed and pushed; fresh output + receipts verified above.',
      '```claims',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');

    expect(findUnmatchedQuotedOutputs(text, PARTS)).toEqual([]);
  });

  it('composed guard: the sighting-1 final shape produces NO fabricatedQuotes finding', async () => {
    const text = [
      'Staleness sweep complete; docs current.',
      'Receipts cited inline; output lines quoted above.',
      '```claims',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');
    const out = await applyCompletionClaimGuard({
      finalText: text, parts: PARTS, triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
    });

    expect(out.verdict.fabricatedQuotes ?? []).toEqual([]);
    expect(out.finalText).not.toContain('UNVERIFIED QUOTED OUTPUT');
  });

  it('NO HOLE: the same claims JSON quoted as "returned output" in a ```json fence STILL strikes', () => {
    const text = [
      'The claims verifier returned:',
      '```json',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');

    const out = findUnmatchedQuotedOutputs(text, PARTS);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('a530c4dd');
  });

  it('NO HOLE: the same claims JSON quoted as output in a BARE fence STILL strikes', () => {
    const text = [
      'Fresh output from the push:',
      '```',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');

    const out = findUnmatchedQuotedOutputs(text, PARTS);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('a530c4dd');
  });

  it('CONTROL (unchanged behavior): a cue-free line above the mandated fence was and stays clean', () => {
    const text = [
      'Owner action needed: merge the PR to land the update on main.',
      '```claims',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');

    expect(findUnmatchedQuotedOutputs(text, PARTS)).toEqual([]);
  });
});

describe('ticket d0597e02 — exact-shape tightening (independent-review finding: off-shape fences must NOT be exempt)', () => {
  // The claims lane recognizes ONLY the exact opener ```claims (up to 3
  // leading spaces, trailing whitespace). Any off-shape variant is invisible
  // to the claims lane, so the quote lane must keep scanning it — otherwise
  // fabricated "quoted output" hides from BOTH lanes.
  const CUE_LINE = 'The verifier returned this output verbatim:';

  it.each([
    ['uppercase info', '```CLAIMS'],
    ['multi-word info', '```claims extra'],
    ['tilde fence', '~~~claims'],
    ['four backticks', '````claims'],
  ])('NO TWO-LANE HOLE: a %s fence with fabricated claims JSON under a cue STILL strikes', (_label, opener) => {
    const closer = opener.startsWith('~~~') ? '~~~' : opener.startsWith('````') ? '````' : '```';
    const text = [CUE_LINE, opener, CLAIMS_ARRAY, closer].join('\n');

    const out = findUnmatchedQuotedOutputs(text, PARTS);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toContain('a530c4ddc4fe419ec208cefb7e26b6ae4d7c3fb0');
  });

  it('exact-shape boundary: ```claims with 3 leading spaces and trailing whitespace STAYS exempt', () => {
    const text = [
      'Docs update committed and pushed; fresh output + receipts verified above.',
      '   ```claims   ',
      CLAIMS_ARRAY,
      '```',
    ].join('\n');

    expect(findUnmatchedQuotedOutputs(text, PARTS)).toEqual([]);
  });
});

describe('ticket d0597e02 replay — shape B: refuted merge claim on tt-rd PR #535 (session a8976e11 run 86d57acb)', () => {
  it('REPLAY: claiming PR #535 merged while GitHub shows it OPEN refutes the merge claim', async () => {
    // Live state at the sighting (re-verified 2026-09-09T06:5xZ): tt-rd #535
    // "Firing 104 fold…" is state:open, merged:false.
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'Folded the firing-104 results — merged PR #535 to main.',
      parts: PARTS,
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
    });

    expect(out.verdict.refutedMergePrs).toEqual([535]);
    expect(out.verdict.unprovenKinds).toEqual([]); // evidence-bearing tool call present
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(summarizeGuardVerdict(out.verdict)).toContain('refuted');
  });

  it('CONTROL: the same claim with GitHub showing merged:true verifies clean', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {
      merged: true, state: 'closed',
      merge_commit_sha: 'fea135093a3d1ccd361686e77ea4e899ccf14950',
      merged_at: '2026-09-09T06:30:00Z',
    }));
    const out = await applyCompletionClaimGuard({
      finalText: 'Folded the firing-104 results — merged PR #535 to main.',
      parts: PARTS,
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
    });

    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });
});
