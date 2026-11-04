/**
 * REPLAY PIN — ticket 0cea589d (bug_report, filed 2026-10-12T16:14Z by session
 * b92ef13f, firing 22 of the R&D shortfall-hunt loop, with live evidence).
 *
 * TWO false-positive classes on GUARD 1's commit_local branch, both struck live:
 *
 * CLASS 1 (the 2026-10-12 incident, chat 837a636a runs 9f3d54df 12:24Z /
 * e9c097ff 13:23Z / 954e3d38 14:24Z / 373cb6ee 15:23Z — guard_strike seam
 * final_verdict kinds [unproven_completion] ×4): during the fleet-wide GitHub
 * write outage (oq_6fbf2dc6) the ticket lane's honest final read "Still
 * blocked: GitHub write gate oq_6fbf2dc6 open (fresh reads this run: gate
 * `open`; `git_push` → \"No connected GitHub account/token\"); ticket 59185759
 * stays `in_progress` with banked commit `0bf7dda2d` — backstop remains
 * armed." — receipts held ONLY reads + git_push ok:false — yet GUARD 1 mined
 * commit_local off "banked commit 0bf7dda2d". The line already reports the
 * push as REFUSED and the lane as blocked: exactly what the strike would say.
 * Fix: PUSH_REFUSED_RE (line-scoped, beside LOCAL_HONEST_RE, rides the A1
 * kill switch) suppresses the branch.
 *
 * CLASS 2 (the 2026-10-11T06:13Z sibling, chat 6ef785c3 run 72efa842 — named
 * by the 06:13Z adjudication as the banked/board-id seam, still live at f22):
 * "progressNote is already banked current" beside todo-id 198ff490 — the
 * board-id-shaped hex beside the ledger verb "banked" mined the TODO ID as a
 * commit sha. Fix: BOARD_LABEL_BEFORE_RE (the ARTIFACT/RELAY label family)
 * excludes a board-labelled hex token from commitShasInClause.
 *
 * Pins: (1) the verbatim 837a636a incident line mines NOTHING; (2) each
 * PUSH_REFUSED_RE marker class alone (platform refusal string, push-failure
 * phrasing, write-gate, still/remains/stays blocked) suppresses the branch
 * while a clean "banked <sha>" line still mines; (3) commit_pushed is NOT
 * suppressed (a refused push is still a push claim to verify); (4) the
 * board-id forms ("todo 198ff490", "todo-id 198ff490", "session 837a636a",
 * "schedule d2b633c0") mine nothing while a real sha on the same line still
 * mines; (5) the A1 kill switch restores the old behaviour.
 *
 * Boundary-mocked like run-evidence-guard.commit-local.test.ts: logger +
 * GitHub token manager are stubs, global.fetch is a mock; the real modules
 * execute. No network.
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

import { extractCompletionClaims, applyCompletionClaimGuard, guardFindingKinds } from './run-evidence-guard';
import { commitLocalClaimGuardDisabled, type ToolReceipt } from './run-receipts';
import type { MessagePart } from './agent';

const NOW = new Date('2026-10-12T15:23:57.000Z');
const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
// The incident's genuinely-banked LOCAL commit sha (ticket 59185759's replay
// test, branch digby/session-837a636a — a real commit, pushed nowhere while
// the write gate is open).
const BANKED = '0bf7dda2d';
const SHA = 'a65e79f4c0ffee01';

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();
const ghResponse = (status: number, body?: any): any => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const rc = (tool: string, ids: Record<string, unknown> = {}, ok = true, id = `r-${tool}-${Math.random().toString(16).slice(2, 10)}`): ToolReceipt =>
  ({ id, chatId: 'c1', runId: 'run1', tool, ok, ids, inputHash: null, outputHash: null, createdAt: NOW });
const call = (name: string): MessagePart => ({ type: 'tool_call', name, args: {} } as any);

const KS = 'COMMIT_LOCAL_CLAIM_GUARD_DISABLED';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
  delete process.env[KS];
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env[KS];
});

// The verbatim final that struck 4× on 2026-10-12 (chat 837a636a).
const INCIDENT_LINE = 'Still blocked: GitHub write gate oq_6fbf2dc6 open (fresh reads this run: gate `open`; `git_push` → "No connected GitHub account/token"); ticket 59185759 stays `in_progress` with banked commit `0bf7dda2d` — backstop remains armed.';
// The verbatim 2026-10-11 06:13Z sibling line (chat 6ef785c3, run 72efa842) —
// the banked/board-id seam. TODO_ID is a todo row id, not a commit.
const SIBLING_LINE = 'No todo_update issued: progressNote is already banked current (todo-id 198ff490, updatedAt 2026-10-10T16:48:33.650Z).';

describe('0cea589d class 1 — an honest BLOCKED line never mines commit_local', () => {
  it('THE INCIDENT REPLAY: the verbatim 837a636a final mines NOTHING (was: commit_local on 0bf7dda2d)', () => {
    expect(extractCompletionClaims(INCIDENT_LINE)).toEqual([]);
  });

  it('end-to-end: the incident line with the incident receipts (reads + git_push ok:false) is a CLEAN verdict', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_LINE,
      parts: [call('get_feedback'), call('list_owner_questions'), call('git_push')],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('get_feedback'), rc('list_owner_questions'), rc('git_push', {}, false)],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(guardFindingKinds(out.verdict)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled(); // no sha re-query — no claim was mined
  });

  it('each refusal marker class alone suppresses the branch (the verb still present)', () => {
    const lines = [
      // the platform's verbatim refusal string
      `ticket 59185759 stays in_progress with banked commit ${BANKED} — git_push → "No connected GitHub account/token".`,
      // push-failure phrasings
      `ticket stays in_progress with banked commit ${BANKED} — push refused (label mismatch).`,
      `ticket stays in_progress with banked commit ${BANKED} — push failed twice this run.`,
      `ticket stays in_progress with banked commit ${BANKED} — pushes blocked fleet-wide.`,
      `ticket stays in_progress with banked commit ${BANKED} — cannot push until the gate clears.`,
      // the write-gate class
      `Still blocked on the GitHub write gate with banked commit ${BANKED}.`,
      // remains/stays blocked
      `Lane remains blocked with banked commit ${BANKED}.`,
      `Lane stays blocked with banked commit ${BANKED}.`,
      `Lane still blocked with banked commit ${BANKED}.`,
    ];
    for (const line of lines) {
      expect(extractCompletionClaims(line)).toEqual([]); // ${line}
    }
  });

  it('the suppression is commit_local-ONLY: a refused line with a PUSH verb still mines commit_pushed', () => {
    const out = extractCompletionClaims(`Push failed — but run 42 already pushed ${SHA} to origin earlier.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_pushed']);
    expect(out[0].sha).toBe(SHA);
  });

  it('a clean "banked <sha>" line with no refusal marker still mines (the spark case is unchanged)', () => {
    const out = extractCompletionClaims(`Spark B11: fully banked ${SHA} on lane/spark-b11.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_local']);
    expect(out[0].sha).toBe(SHA);
  });

  it('kill switch COMMIT_LOCAL_CLAIM_GUARD_DISABLED=1 turns the whole class off (the incident line mines nothing, as does the spark case)', () => {
    process.env[KS] = '1';
    expect(commitLocalClaimGuardDisabled()).toBe(true);
    expect(extractCompletionClaims(INCIDENT_LINE)).toEqual([]);
    expect(extractCompletionClaims(`Spark B11: fully banked ${SHA} on lane/spark-b11.`)).toEqual([]);
    delete process.env[KS];
  });
});

describe('0cea589d class 2 — a BOARD-ID-labelled hex token is never a commit sha', () => {
  it('THE SIBLING REPLAY: the verbatim 06:13Z line (banked + todo-id) mines NOTHING', () => {
    expect(extractCompletionClaims(SIBLING_LINE)).toEqual([]);
  });

  it('each board-label form excludes the labelled token while a real sha on the same clause still mines', () => {
    // labelled board ids mine nothing…
    expect(extractCompletionClaims(`banked the note under todo 198ff490.`)).toEqual([]);
    expect(extractCompletionClaims(`banked the note under todo-id 198ff490.`)).toEqual([]);
    expect(extractCompletionClaims(`committed on session 837a636a.`)).toEqual([]);
    expect(extractCompletionClaims(`committed on chat 837a636a.`)).toEqual([]);
    expect(extractCompletionClaims(`banked on schedule d2b633c0.`)).toEqual([]);
    expect(extractCompletionClaims(`committed on ticket 59185759 stays open.`)).toEqual([]);
    expect(extractCompletionClaims(`committed on goal b3f240e4.`)).toEqual([]);
    expect(extractCompletionClaims(`banked on lane 837a636a.`)).toEqual([]);
    // …but a REAL sha in the same clause is untouched by the label rule
    const out = extractCompletionClaims(`banked ${SHA} on lane 837a636a's branch.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_local']);
    expect(out[0].sha).toBe(SHA);
  });

  it('the board label excludes the token from commit_pushed too (a board id is never a sha, whatever the verb)', () => {
    expect(extractCompletionClaims(`pushed todo 198ff490 to the board.`)).toEqual([]);
    const out = extractCompletionClaims(`pushed ${SHA} after todo 198ff490 was done.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_pushed']);
    expect(out[0].sha).toBe(SHA);
  });

  it('kill switch restores the old behaviour on the PUSH path (a board-labelled hex is mined as a sha again)', () => {
    // The label rules ride the A1 switch: under KS=1 the commit_local branch
    // is off entirely (nothing to mine there), and commitShasInClause stops
    // excluding board-labelled tokens — so a "pushed todo 198ff490" line
    // mines the board id as a commit_pushed sha, the pre-fix behaviour.
    process.env[KS] = '1';
    const out = extractCompletionClaims(`pushed todo 198ff490 to the board.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_pushed']);
    expect(out[0].sha).toBe('198ff490');
    delete process.env[KS];
  });

  it('the label window is bounded: a distant board noun does not swallow a later sha', () => {
    // 40+ chars of prose between the label and the token — outside the 24-char
    // window, the sha mines normally (the family's windowing contract).
    const out = extractCompletionClaims(`todo was updated, and then fully banked ${SHA} much later in the same clause.`);
    expect(out.map((c) => c.kind)).toEqual(['commit_local']);
    expect(out[0].sha).toBe(SHA);
  });
});
