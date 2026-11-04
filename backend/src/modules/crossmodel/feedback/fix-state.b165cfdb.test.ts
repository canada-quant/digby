/**
 * Replay for ticket b165cfdb — "fix-state.ts deploy-run lane rides the
 * ticket owner's GitHub token only — dead for test-account tickets
 * (abc76ebc sibling)".
 *
 * THE GAP (sibling of abc76ebc DEFECT A, fixed in closure-evidence.ts by
 * PR #1527): resolveFixStateFromEvidence — the merged ∧ deployed proof
 * behind closure-manifest's evidence-gated entries and the reopen path's
 * fixLive check — resolved its GitHub token with getValidToken(row.userId)
 * ONLY. The nightly query suite files its tickets from the canonical TEST
 * account (a synthetic bench account with NO connected GitHub token), so for
 * the entire nightly-suite ticket class this lane was structurally dead:
 * every deploy-run check and box-ancestry compare failed closed with "no
 * connected GitHub token for the ticket owner", evidence-gated manifest
 * entries stayed "PENDING — fix not proven live" forever, and the reopen
 * path degraded to the legacy reopen. (The sibling lane manifested the same
 * class live during the 2026-10-15 incident window: PR #1516 merged
 * 18:29:43Z, closes attempted 18:35–18:37Z.)
 *
 * THE FIX (mirrors abc76ebc / PR #1527): the ticket OWNER's token first,
 * then — when the owner has none — the LANE-HOME owner's
 * (feedback/lane-home.ts: TICKET_LANE_PROJECT_ID's owner, else the standing
 * lane chat's project owner). Kill switch
 * FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED=1 restores owner-token-only.
 * An absent row.userId no longer short-circuits: it falls through to the
 * lane-home owner too (the sibling fix removed the equivalent early return).
 *
 * These tests replay the gap through the REAL resolveFixStateFromEvidence
 * (only the token seam, the prisma lane-home lookups and the network fetch
 * are stubbed — the 208ad03d / box-ancestry mock discipline). The fail-safe
 * contract (fixLive=false on ANY missing data; never throws) is pinned
 * alongside.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// prisma surface: box_health telemetry (loopMetric) + the lane-home lookups
// (project by TICKET_LANE_PROJECT_ID / standing-lane chat by
// PLATFORM_ENGINEER_CHAT_ID).
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { resolveFixStateFromEvidence } from './fix-state';

const BENCH_ACCOUNT = 'f4350445-1111-4222-8333-444455556666'; // the nightly suite's synthetic filer — NO GitHub token (ticket b165cfdb's class)
const LANE_HOME_OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4'; // the platform operator
const FIX = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555'; // a 40-hex merge commit recorded at machine-close time
const DEPLOY_RUN = '38770623441'; // a green deploy run id

/** Route-based GitHub stub: fix merged into main + the deploy run green. */
const ghGreen = () =>
  jest.fn(async (url: any) => {
    const s = String(url);
    if (s.includes(`/compare/${FIX}...main`)) {
      return { status: 200, ok: true, json: async () => ({ status: 'ahead', ahead_by: 3, behind_by: 0 }) } as any;
    }
    if (s.includes(`/actions/runs/${DEPLOY_RUN}`)) {
      return { status: 200, ok: true, json: async () => ({ status: 'completed', conclusion: 'success' }) } as any;
    }
    return { status: 404, ok: false, json: async () => ({}) } as any;
  }) as any;

const ENV = { ...process.env };

beforeAll(() => {
  process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
  delete process.env.PLATFORM_ENGINEER_CHAT_ID;
  delete process.env.FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED;
});

afterAll(() => {
  process.env = ENV;
});

beforeEach(() => {
  jest.clearAllMocks();
  // The lane home resolves to the operator's project (TICKET_LANE_PROJECT_ID).
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'proj-lane-home', userId: LANE_HOME_OWNER });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
});

describe('ticket b165cfdb — the merged ∧ deployed lane rides a token the nightly-suite filer never had', () => {
  it('REPLAY: bench-account ticket (owner tokenless), merged + deploy green — the lane-home owner\'s token now proves the fix LIVE (was: lane dead → fixLive=false forever)', async () => {
    // The ticket owner (bench account) has NO token; the LANE-HOME owner does.
    mockGetValidToken.mockImplementation(async (userId: string) =>
      userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

    const st = await resolveFixStateFromEvidence(
      { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
      { commitSha: FIX, deployRunId: DEPLOY_RUN },
      { fetchImpl: ghGreen() },
    );

    // THE FIX: the proof ran and holds (pre-fix: fixLive=false, "no connected
    // GitHub token for the ticket owner" — the whole lane structurally dead).
    expect(st.fixLive).toBe(true);
    expect(st.reason).toContain('ancestor of origin/main');
    expect(st.reason).toContain(`deploy run ${DEPLOY_RUN} concluded success`);
    expect(mockGetValidToken).toHaveBeenCalledWith(BENCH_ACCOUNT); // owner tried FIRST
    expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER); // then the lane-home owner
  });

  it('NO REGRESSION: the ticket OWNER\'s own token still wins — the fallback never engages when the owner has one', async () => {
    mockGetValidToken.mockResolvedValue('gh-token-owner');

    const st = await resolveFixStateFromEvidence(
      { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: 'user-with-token' },
      { commitSha: FIX, deployRunId: DEPLOY_RUN },
      { fetchImpl: ghGreen() },
    );

    expect(st.fixLive).toBe(true);
    expect(mockGetValidToken).toHaveBeenCalledTimes(1); // the owner only — no lane-home consult
    expect(mockGetValidToken).toHaveBeenCalledWith('user-with-token');
    expect(mockPrisma.crossModelProject.findUnique).not.toHaveBeenCalled();
  });

  it('EDGE (the removed early return): a ticket row with NO userId falls through to the lane-home owner instead of short-circuiting', async () => {
    mockGetValidToken.mockImplementation(async (userId: string) =>
      userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

    const st = await resolveFixStateFromEvidence(
      { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: null },
      { commitSha: FIX, deployRunId: DEPLOY_RUN },
      { fetchImpl: ghGreen() },
    );

    // Pre-fix this returned "the ticket row carries no owner id — no GitHub
    // token path" before ever consulting the lane home; now it proves live.
    expect(st.fixLive).toBe(true);
    expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER);
  });

  it('KILL SWITCH: FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED=1 restores owner-token-only (the lane degrades, never bypasses)', async () => {
    process.env.FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED = '1';
    try {
      mockGetValidToken.mockImplementation(async (userId: string) =>
        userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

      const st = await resolveFixStateFromEvidence(
        { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
        { commitSha: FIX, deployRunId: DEPLOY_RUN },
        { fetchImpl: jest.fn() as any,
        },
      );

      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('no connected GitHub token for the ticket owner');
      expect(st.reason).toContain('lane-home fallback disabled');
      expect(mockGetValidToken).toHaveBeenCalledTimes(1); // owner only
      expect(mockGetValidToken).toHaveBeenCalledWith(BENCH_ACCOUNT);
    } finally {
      delete process.env.FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED;
    }
  });

  it('FAIL-CLOSED SURVIVES: neither the owner nor the lane-home owner has a token — fixLive=false naming BOTH accounts (never a bypass)', async () => {
    mockGetValidToken.mockResolvedValue(null);

    const st = await resolveFixStateFromEvidence(
      { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
      { commitSha: FIX, deployRunId: DEPLOY_RUN },
      { fetchImpl: jest.fn() as any },
    );

    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('no connected GitHub token for the ticket owner or the lane-home owner');
    expect(st.reason).toContain('merge/deploy state unverifiable');
  });

  it('DEGRADED SAFELY: a lane-home lookup failure never throws — the proof degrades to fixLive=false (the fail-safe contract)', async () => {
    mockPrisma.crossModelProject.findUnique.mockRejectedValue(new Error('db wobble'));
    mockGetValidToken.mockResolvedValue(null);

    const st = await resolveFixStateFromEvidence(
      { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
      { commitSha: FIX, deployRunId: DEPLOY_RUN },
      { fetchImpl: jest.fn() as any },
    );

    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('no connected GitHub token');
  });
});

describe('ticket b165cfdb — lane-home edges (the abc76ebc discipline)', () => {
  it('no TICKET_LANE_PROJECT_ID: the lane home resolves through the standing lane chat\'s project owner', async () => {
    delete process.env.TICKET_LANE_PROJECT_ID;
    process.env.PLATFORM_ENGINEER_CHAT_ID = 'chat-standing-lane';
    try {
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: LANE_HOME_OWNER, projectId: 'proj-standing' });
      mockGetValidToken.mockImplementation(async (userId: string) =>
        userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

      const st = await resolveFixStateFromEvidence(
        { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
        { commitSha: FIX, deployRunId: DEPLOY_RUN },
        { fetchImpl: ghGreen() },
      );

      expect(st.fixLive).toBe(true);
      expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER);
    } finally {
      process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
      delete process.env.PLATFORM_ENGINEER_CHAT_ID;
    }
  });

  it('no lane home at all (both env vars unset) and a tokenless owner — fail-closed, never a throw', async () => {
    delete process.env.TICKET_LANE_PROJECT_ID;
    delete process.env.PLATFORM_ENGINEER_CHAT_ID;
    try {
      mockGetValidToken.mockResolvedValue(null);

      const st = await resolveFixStateFromEvidence(
        { id: 'b165cfdb-42cb-4ee1-a439-2fe048b362c7', userId: BENCH_ACCOUNT },
        { commitSha: FIX, deployRunId: DEPLOY_RUN },
        { fetchImpl: jest.fn() as any },
      );

      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('no connected GitHub token');
    } finally {
      process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
    }
  });
});
