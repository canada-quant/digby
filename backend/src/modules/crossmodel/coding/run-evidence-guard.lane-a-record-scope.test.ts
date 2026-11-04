/**
 * DETECTOR-RECALL REPLAY + shortfall pin — F33 (2026-10-23, R&D stream-1
 * cycle, finding D): GUARD 5 Lane A's haystack exoneration window is
 * RECORD-SCOPED.
 *
 * THE SHORTFALL (verifier-strike surface probe, explorer bg1-378g; verified
 * first-hand on origin/main cebb81b15):
 *   haystackShowsDeployState (run-evidence-guard.ts) sliced a raw ±120-char
 *   window around each id occurrence with no record boundary. In a compact
 *   `gh run list --json databaseId,conclusion` array the NEIGHBOR object sits
 *   ~26 chars from a different run's id; in a `gh run list` table the next
 *   row sits one newline away. Either way a neighbor record's state cue
 *   ("conclusion":"success" belonging to ANOTHER run) laundered the claimed
 *   run's "completed success" claim: Lane A exonerated it,
 *   verifyDeployRunClaims never ran, and no refutedDeployRuns strike fired —
 *   a fabricated claim about an in-flight/failed run sailed through.
 *
 * THE FIX (both directions pinned below):
 *   - JSON record bound: when the id occurrence sits inside a {...} object,
 *     only cues inside that object count (enclosingJsonObject).
 *   - Foreign-run bound: any OTHER 11-12-digit token (GitHub run-id shape,
 *     same class DEPLOY_RUN_ID_RE captures) near the id means the haystack is
 *     multi-record — scope the window to the id's own LINE, and cut at any
 *     foreign token sitting between a cue and the id. Repeats of the claimed
 *     id itself stay same-record (gh run view prints it on several lines).
 *   Both bounds only TIGHTEN: a miss falls through to the Actions-API lane —
 *   the primary source — never a lost conviction ('unavailable' stays
 *   silent).
 *
 * The DETECTOR-RECALL REPLAY section replays the detector's prior true
 * positives (the 2026-08-29 incident fabrications and the 2026-09-08 audit's
 * Lane A contracts), asserting they still fire / still hold.
 *
 * Boundary-mocked exactly like run-evidence-guard.test.ts.
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

import { applyCompletionClaimGuard, verdictHasFindings } from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' } as const;
const NOW = new Date('2026-10-23T12:00:00.000Z');

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

const part = (result: string): any => ({ type: 'tool_result', name: 'run_command', result });
const ranAction = (runId: string): boolean =>
  mockFetch.mock.calls.some((c) => String(c[0]).includes(`/actions/runs/${runId}`));

describe('GUARD 5 Lane A record scoping (finding D, 2026-10-23)', () => {
  it('NEIGHBOR JSON OBJECT (compact gh run list --json): the claimed run is in flight, the NEXT object shows success → NOT exonerated; the Actions API refutes it', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('[{"databaseId":39976710021,"conclusion":""},{"databaseId":39976709930,"conclusion":"success"}]')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('NEIGHBOR JSON OBJECT, reverse key order (--json conclusion,databaseId): the PREVIOUS object’s success no longer launders the failure run', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'failure' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('[{"conclusion":"success","databaseId":39976709930},{"conclusion":"failure","databaseId":39976710021}]')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('NEIGHBOR TABLE ROW (gh run list text): the next row’s success must not launder the in_progress row', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('gh run list\n39976710021  in_progress  Deploy to AWS EC2  main\n39976709930  success  CI  main')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('NEIGHBOR ROW BEFORE (CSV shape, cue after the foreign id): the previous record’s success must not launder the in_progress row', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('databaseId,conclusion\n39976709930,success\n39976710021,in_progress')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('SINGLE-LINE multi-record text: a foreign id between the cue and our id separates records (between-ness cut)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('runs: 39976709930 success · 39976710021 in_progress')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('VERBOSE NEIGHBOUR BLOCK (review B1): the neighbour gh run view block puts its ID >120 chars away while its cue stays in the window → NOT exonerated', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part([
        'gh run view 39976709930',
        '✓ Deploy to AWS EC2 · 39976709930',
        '  ✓ deploy in 4m 3s',
        '  ✓ notify in 2s',
        'status: completed  conclusion: success',
        '',
        'gh run view 39976710021',
        '✓ Deploy to AWS EC2 · 39976710021',
        '  ✓ deploy in 4m 3s',
        '  ✓ notify in 2s',
        'status: in_progress  conclusion: ""',
      ].join('\n'))],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('REVERSED COLUMNS (review M1): conclusion before databaseId — our own row’s success still exonerates when a foreign row sits above', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('conclusion,databaseId\nfailure,39976709930\nsuccess,39976710021')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/actions/runs/'))).toBe(false);
    expect(out.verdict.refutedDeployRuns).toBeUndefined();
    expect(out.verdict.fabricatedDeployRuns).toBeUndefined();
  });

  it('REAL gh api OBJECT (review M2): a 9-12 digit sibling field (check_suite_id) inside the SAME object is not a foreign record — exoneration holds', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('{\n  "id": 39976710021,\n  "check_suite_id": 39976500011,\n  "status": "completed",\n  "conclusion": "success"\n}')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/actions/runs/'))).toBe(false);
    expect(out.verdict.refutedDeployRuns).toBeUndefined();
    expect(out.verdict.fabricatedDeployRuns).toBeUndefined();
  });

  it('TEN-DIGIT NEIGHBOUR (review M3): a 10-digit id row above is still a foreign record — no laundering', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('gh run list\n9688947695  success  CI  main\n39976710021  in_progress  Deploy  main')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('CONCATENATED gh run view BLOCKS: the previous run’s block (id + conclusion on separate lines) must not launder ours', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'failure' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('gh run view 39976709930\nstatus: completed  conclusion: success\ngh run view 39976710021\nstatus: completed  conclusion: failure')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('claimed state COMPLETED is record-scoped too: a neighbor object’s "status":"completed" must not launder an in-flight run', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed.',
      parts: [part('[{"databaseId":39976710021,"status":"in_progress"},{"databaseId":39976709930,"status":"completed"}]')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('39976710021')).toBe(true);
    expect(out.verdict.refutedDeployRuns).toEqual(['39976710021']);
  });

  it('TIGHTENING (documented tradeoff): a cue OUTSIDE the enclosing object now goes to the Actions API — the primary source confirms it, still no strike', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'completed', conclusion: 'success' }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success.',
      parts: [part('poll: {"id":33236939738,"status":"completed"} — deploy succeeded')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(ranAction('33236939738')).toBe(true);
    expect(out.verdict.refutedDeployRuns ?? []).toEqual([]);
    expect(out.verdict.fabricatedDeployRuns ?? []).toEqual([]);
    expect(out.finalText).toContain('✅ EXISTS');
  });
});

// ── DETECTOR-RECALL REPLAY: the detector's prior true positives still fire,
//    and its prior legitimate exoneration contracts still hold. ─────────────
describe('DETECTOR-RECALL REPLAY — Lane A prior contracts (2026-09-08 audit + 2026-08-29 incidents)', () => {
  it('RECALL: gh run view multi-line block (ONE run, several lines, no foreign ids) still exonerates WITHOUT an API call', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success.',
      parts: [part('gh run view 33236939738\n✓ main deploy · 33236939738\nstatus: completed  conclusion: success')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/actions/runs/'))).toBe(false);
    expect(out.verdict.refutedDeployRuns).toBeUndefined();
    expect(out.verdict.fabricatedDeployRuns).toBeUndefined();
  });

  it('RECALL: a same-object JSON poll (toolTexts) still exonerates WITHOUT an API call', async () => {
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

  it('RECALL: a table row where the id’s OWN row shows success still exonerates (neighbor rows present)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 39976710021 completed success.',
      parts: [part('gh run list\n39976710021  success  Deploy to AWS EC2  main\n39976709930  failure  CI  main')],
      triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/actions/runs/'))).toBe(false);
    expect(out.verdict.refutedDeployRuns).toBeUndefined();
    expect(out.verdict.fabricatedDeployRuns).toBeUndefined();
  });

  it('RECALL (2026-08-29 incident 2): claimed success, no haystack, API says in_progress → STILL REFUTED', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { status: 'in_progress', conclusion: null }));
    const out = await applyCompletionClaimGuard({
      finalText: 'deploy 33236939738 completed success at 06:30:44Z',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.refutedDeployRuns).toEqual(['33236939738']);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/actions/runs/33236939738');
  });

  it('RECALL (2026-08-29 incident 1): a phantom deploy-run id 404s → STILL fabricatedDeployRuns', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: 'merged PR #481, deploy 33236656591 completed success.',
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.fabricatedDeployRuns).toEqual(['33236656591']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
  });
});
