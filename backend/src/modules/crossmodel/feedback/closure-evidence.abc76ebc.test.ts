/**
 * Replay for ticket abc76ebc — "3× tool-failure streak: update_feedback on
 * 'Fix nightly-suite regressions' — framework or model?"
 * (mishap, breaker trip 2026-10-15T18:37:05Z, session
 * b92ef13f-c3f8-487e-8267-767e56543150, run 9232e15b-ac68-417c-b83c-81189f1cf61d).
 *
 * THE INCIDENT: the nightly-suite fix lane had just MERGED PR #1516 (squash
 * 3c5ef643c8d7, 18:29:43Z — replay tests
 * chat-agent/first-word-note.test.ts and
 * langgraph/memory.banned-topics-carveout.6fd4663a.test.ts, both citing the
 * right ticket prefixes) and then tried to close tickets afc10e95 (Quick-lane
 * first-word latency) + 6fd4663a (suite failing case) at 18:35–18:37Z, inside
 * the deploy window: the instance checkout did not carry the merge yet. Four
 * update_feedback refusals followed (receipts 102c7b4b/598cb706/54c23d0d/
 * c6c94752):
 *   1. 18:35:39 afc10e95 done → replay_test_unciting (local stale copy,
 *      origin/main lane UNAVAILABLE — the ticket owner has no GitHub token)
 *   2. 18:35:41 6fd4663a done → replay_test_missing (local miss, origin/main
 *      lane UNAVAILABLE)
 *   3. 18:37:00 afc10e95 in_progress → evidence_required (unbound mutation)
 *   4. 18:37:02 6fd4663a in_progress → evidence_required (unbound mutation)
 * Three failure-shaped refusals tripped the derail breaker → this ticket.
 *
 * ADJUDICATION (this lane, 2026-10-15): the STREAK ITSELF is the breaker's
 * by-design counting (e72251c9/b61fb6c9 precedent — truthful, self-describing
 * refusals; a mid-streak success resets; one deduped ticket per streak). But
 * the streak's TEXTS exposed TWO deterministic framework defects this replay
 * pins:
 *
 * DEFECT A (closure-evidence.ts): the origin/main tolerance lane (built by
 * tickets 012d3aa2/cc7004a7 for EXACTLY this deploy-window shape) rides
 * ONLY the ticket OWNER's GitHub token — getValidToken(ticket.userId). The
 * nightly query suite files its tickets from the suite's own synthetic bench
 * account (userId f4350445…, NO connected GitHub token — the learnings entry
 * banked in PR #1521 names this exact class), so for the entire nightly-suite
 * ticket class the tolerance lane was structurally DEAD and the lane got the
 * pre-012d3aa2 fail-closed refusals anyway. THE FIX: when the ticket owner
 * has no token, the lane rides the LANE-HOME owner's (feedback/lane-home.ts
 * — TICKET_LANE_PROJECT_ID's owner, else the standing lane chat's project
 * owner); kill switch FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=1.
 *
 * DEFECT B (platform-tools.ts): refusals 3+4 narrated "(its
 * context.dispatchedTo names another session)" for tickets that were NEVER
 * DISPATCHED to anyone — both rows carry context:null (held for owner review
 * since 15:32:57Z; the supervisor's oq_e4869c75 approval at 16:48Z was never
 * stamped by the admin-UI path), and the gate's own guard_strike telemetry
 * for those calls stamped binding:'no_context', dispatchedTo:null,
 * filedBy:null. That is the d2c2744b fabrication class ("a broken narrated
 * state in an advertised recovery path") surviving in the exists-but-
 * undispatched shape: d2c2744b's fix only covered reason 'ticket_not_found'.
 * THE FIX: the default-branch refusal narrates the row's REAL state —
 * "it has never been dispatched to any session — no context.dispatchedTo
 * stamp" — when the loaded row carries no dispatchedTo. The truthful
 * "(its context.dispatchedTo names another session)" narration stays for a
 * row genuinely dispatched elsewhere (pinned here as the NO-REGRESSION case).
 *
 * These tests replay both defects through the REAL gates (the REAL
 * fetchReplayTestFromOriginMain token-resolution path runs; only the token
 * seam and the network fetch are stubbed). Mock discipline mirrors
 * closure-evidence.012d3aa2.test.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// prisma surface: the ticket row + the lane-home lookups (project by
// TICKET_LANE_PROJECT_ID / standing-lane chat by PLATFORM_ENGINEER_CHAT_ID).
const mockPrisma: any = {
  userFeatureRequest: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { verifyMachineCloseEvidence } from './closure-evidence';

// The incident's REAL ids (verbatim from ticket abc76ebc's body). The replay
// paths are FICTIONAL siblings of the real ones (same directories): the real
// files exist in this dev worktree, and process.cwd()/parent are replay-root
// candidates — a real path would resolve locally and never engage the
// origin/main lane (the 012d3aa2 suite's own discipline).
const STREAK_TICKET = 'afc10e95-cf22-4c45-ad22-e7b1e81a439e';
const SIBLING_TICKET = '6fd4663a-db0d-4c42-a0d2-9b66c12f096c';
const BENCH_ACCOUNT = 'f4350445-1111-4222-8333-444455556666'; // the suite's synthetic filer — NO GitHub token
const LANE_HOME_OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4'; // the platform operator
const REPLAY_REL = 'backend/src/modules/crossmodel/chat-agent/first-word-note.abc76ebc-sim.test.ts';
const SIBLING_REL = 'backend/src/modules/crossmodel/langgraph/memory.banned-topics-carveout.abc76ebc-sim.test.ts';

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  // The STALE INSTANCE: a mounted checkout mid-deploy — the just-merged
  // replay test is NOT there yet (refusal #1's shape: pre-existing file,
  // stale content; refusal #2's shape: file absent entirely).
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-abc76ebc-'));
  process.env.REPLAY_TEST_ROOT = root;
  process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
  delete process.env.PLATFORM_ENGINEER_CHAT_ID;
  delete process.env.FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED;
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  // The nightly-suite ticket row: filed by the BENCH account.
  mockPrisma.userFeatureRequest.findUnique.mockImplementation(async ({ where }: any) => {
    if (where?.id === STREAK_TICKET) {
      return { id: STREAK_TICKET, type: 'bug_report', title: '[nightly query suite] first-word latency over the bar', userId: BENCH_ACCOUNT };
    }
    if (where?.id === SIBLING_TICKET) {
      return { id: SIBLING_TICKET, type: 'bug_report', title: '[nightly query suite] failing cases', userId: BENCH_ACCOUNT };
    }
    return null;
  });
  // The lane home resolves to the operator's project (TICKET_LANE_PROJECT_ID).
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'proj-lane-home', userId: LANE_HOME_OWNER });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
});

/** A GitHub contents-API payload for a file whose content is `text`. */
const contentsPayload = (text: string) => ({
  type: 'file',
  encoding: 'base64',
  content: Buffer.from(text, 'utf8').toString('base64').replace(/.{1,60}/g, '$&\n'),
});

const fetchReturning = (status: number, body?: any) =>
  jest.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as any;

describe('ticket abc76ebc — DEFECT A: the origin/main tolerance lane rides a token the nightly-suite filer never had', () => {
  it('REPLAY (refusal #1, 18:35:39Z): bench-account ticket, stale local copy, owner tokenless — the lane-home owner\'s token now verifies the close (was: lane dead → replay_test_unciting)', async () => {
    // The pre-merge copy of the replay test exists locally WITHOUT the citation.
    fs.mkdirSync(path.join(root, 'backend/src/modules/crossmodel/chat-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(root, REPLAY_REL),
      "describe('firstWordNote (ticket 4f7263e4)', () => { it('older copy — no bench citation', () => {}); });",
    );
    // The ticket owner (bench account) has NO token; the LANE-HOME owner does.
    mockGetValidToken.mockImplementation(async (userId: string) =>
      userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

    const v = await verifyMachineCloseEvidence({
      ticketId: STREAK_TICKET,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl: fetchReturning(200, contentsPayload(`// ticket afc10e95 — quick-lane first-word p50\nit('pins it', () => {});`)),
    });

    // THE FIX: the tolerance lane engaged and the close verifies (pre-fix this
    // was the fail-closed replay_test_unciting refusal the streak recorded).
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect(mockGetValidToken).toHaveBeenCalledWith(BENCH_ACCOUNT); // owner tried FIRST
    expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER); // then the lane-home owner
    const note = (v as any).auditNote ?? '';
    expect(note).toContain('origin/main');
    expect(note).toContain('stale-checkout tolerated');
  });

  it('REPLAY (refusal #2, 18:35:41Z): the sibling ticket\'s file absent locally entirely — the fallback still verifies it on origin/main (was: lane dead → replay_test_missing)', async () => {
    // No local file at all (the merge had not synced).
    mockGetValidToken.mockImplementation(async (userId: string) =>
      userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);

    const v = await verifyMachineCloseEvidence({
      ticketId: SIBLING_TICKET,
      evidence: { replayTestPath: SIBLING_REL },
      fetchImpl: fetchReturning(200, contentsPayload(`// replays ticket 6fd4663a\nit('pins the carve-out', () => {});`)),
    });

    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER);
  });

  it('NO REGRESSION: the ticket OWNER\'s own token still wins — the fallback never engages when the owner has one', async () => {
    // A local-only fictional file citing the ticket: local hit, no GitHub lane.
    fs.writeFileSync(path.join(root, 'x.abc76ebc.test.ts'), `// cites afc10e95 locally\nit('local hit', () => {});`);
    mockGetValidToken.mockResolvedValue('gh-token-owner');
    const v = await verifyMachineCloseEvidence({
      ticketId: STREAK_TICKET,
      evidence: { replayTestPath: 'x.abc76ebc.test.ts' },
      fetchImpl: jest.fn() as any,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect(mockGetValidToken).not.toHaveBeenCalled(); // local hit → token never consulted
  });

  it('NO REGRESSION (fail-closed survives): neither owner nor lane-home owner has a token → the degraded refusal still names the stale-checkout cause + retry remedy', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const v = await verifyMachineCloseEvidence({
      ticketId: STREAK_TICKET,
      evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
      fetchImpl: jest.fn() as any,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    const msg = (v as any).message;
    expect(msg).toContain('STALE INSTANCE CHECKOUT');
    expect(msg).toContain('retry the close after the deploy settles');
    expect(msg).toContain('the ticket owner or the lane-home owner');
  });

  it('KILL SWITCH: FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=1 restores owner-token-only (the lane degrades, never bypasses)', async () => {
    process.env.FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED = '1';
    try {
      mockGetValidToken.mockImplementation(async (userId: string) =>
        userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);
      const v = await verifyMachineCloseEvidence({
        ticketId: STREAK_TICKET,
        evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
        fetchImpl: jest.fn() as any,
      });
      expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
      expect(mockGetValidToken).toHaveBeenCalledTimes(1); // owner only
      expect(mockGetValidToken).toHaveBeenCalledWith(BENCH_ACCOUNT);
      expect((v as any).message).toContain('lane-home fallback disabled');
    } finally {
      delete process.env.FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED;
    }
  });

  it('DEGRADED SAFELY: a lane-home lookup failure never throws — the refusal degrades to unavailable (fail-closed)', async () => {
    mockPrisma.crossModelProject.findUnique.mockRejectedValue(new Error('db wobble'));
    mockGetValidToken.mockResolvedValue(null);
    const v = await verifyMachineCloseEvidence({
      ticketId: STREAK_TICKET,
      evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
      fetchImpl: jest.fn() as any,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    expect((v as any).message).toContain('STALE INSTANCE CHECKOUT');
  });
});

describe('ticket abc76ebc — DEFECT A edge: the standing-lane chat is the lane home when no TICKET_LANE_PROJECT_ID', () => {
  it('the lane-home owner resolves through the standing lane chat\'s project owner', async () => {
    delete process.env.TICKET_LANE_PROJECT_ID;
    process.env.PLATFORM_ENGINEER_CHAT_ID = 'chat-standing-lane';
    try {
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: LANE_HOME_OWNER, projectId: 'proj-standing' });
      mockGetValidToken.mockImplementation(async (userId: string) =>
        userId === LANE_HOME_OWNER ? 'gh-token-operator' : null);
      const v = await verifyMachineCloseEvidence({
        ticketId: SIBLING_TICKET,
        evidence: { replayTestPath: SIBLING_REL },
        fetchImpl: fetchReturning(200, contentsPayload(`// replays ticket 6fd4663a\nit('pins the carve-out', () => {});`)),
      });
      expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
      expect(mockGetValidToken).toHaveBeenCalledWith(LANE_HOME_OWNER);
    } finally {
      delete process.env.PLATFORM_ENGINEER_CHAT_ID;
      process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
    }
  });
});
