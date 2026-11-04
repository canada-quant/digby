/**
 * Replay for ticket 17faa5e9 — "3× tool-failure streak: update_feedback on
 * 'Investigate Untrusted Ticket Report' — framework or model?" (P0 mishap;
 * replay_test_missing streak in session d2f1ca97, run d9e1b3e7, tripped
 * 2026-09-17T05:00Z).
 *
 * THE STREAK: the lane closing ticket ce9ee48d had merged its replay test
 * (backend/src/modules/crossmodel/chat-agent/cross-check-artifact-grounding.
 * ce9ee48d.test.ts — commit da32c1721, PR #826 squash df84038d3,
 * 2026-09-17T04:43:01Z) and tried to evidence-close ~17 minutes later, before
 * the deploy synced the instance checkout. The then-current gate verified
 * replayTestPath ONLY against local roots ($REPLAY_TEST_ROOT, the backend dir,
 * its parent — closure-evidence.ts:302 at the time), so replay_test_missing
 * was the CORRECT verdict per that contract: the file genuinely did not exist
 * on the instance yet. Not lane misuse (the test was properly committed to
 * origin/main) and not a gate misfire (no false negative against its
 * contract) — a known just-merged-vs-stale-instance race.
 *
 * THE FIX (ticket 012d3aa2, PR #841, 817e81035, landed 2026-09-18T00:25:44Z —
 * ~19h AFTER the streak): on a local-root miss the gate ALSO verifies the path
 * against origin/main via the GitHub contents lane.
 *
 * These tests replay the streak through the REAL gate (mock discipline mirrors
 * closure-evidence.012d3aa2.test.ts — logger + config/database + the token
 * seam mocked ABOVE the imports; a temp REPLAY_TEST_ROOT WITHOUT the file
 * simulates the stale instance; fetchImpl injected, no network):
 *  1. the 05:00Z scenario — absent locally, PRESENT on origin/main → now ok;
 *  2. the ORIGINAL FAILING PATH resolves through the real gate today (the
 *     ce9ee48d replay test rides this checkout, so the local lane hits and
 *     GitHub is never consulted);
 *  3. a GitHub 404 stays an authoritative replay_test_missing — had the lane's
 *     file truly never been committed, the refusal still fires.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findUnique: jest.fn(), findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { verifyMachineCloseEvidence } from './closure-evidence';

// The REAL ticket ids from the streak (verbatim from the 17faa5e9 ticket body).
const TICKET_ID = '17faa5e9-af54-41c6-9d25-f6238e308758';
const PREFIX = '17faa5e9';
const CE_TICKET_ID = 'ce9ee48d-c48a-4fff-8704-39303d0a483e';
const OWNER = 'user-83e4fbf9';
// The EXACT replayTestPath the lane supplied at 05:00Z (verbatim from the
// failure texts). Present in this checkout — used by test 2's local-lane pin.
const STREAK_REL = 'backend/src/modules/crossmodel/chat-agent/cross-check-artifact-grounding.ce9ee48d.test.ts';
// A FICTIONAL path so the temp REPLAY_TEST_ROOT truly simulates the stale
// instance (a real worktree path would resolve locally via the backend-dir
// root and defeat the simulation — same discipline as the 012d3aa2 replay).
const SIM_REL = 'backend/src/modules/crossmodel/feedback/stale-instance-sim.17faa5e9.test.ts';

const ROWS: Record<string, any> = {
  [TICKET_ID]: {
    id: TICKET_ID,
    type: 'mishap',
    title: '3× tool-failure streak: update_feedback on "Investigate Untrusted Ticket Report" — framework or model?',
    userId: OWNER,
  },
  [CE_TICKET_ID]: {
    id: CE_TICKET_ID,
    type: 'bug_report',
    title: "L2 cross-check draft confabulated a phantom 'Progress Recap' artifact citation",
    userId: OWNER,
  },
};

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  // The STALE INSTANCE: a mounted checkout that predates the merge — it does
  // NOT carry the replay test.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-stale-17faa5e9-'));
  process.env.REPLAY_TEST_ROOT = root;
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockImplementation((args: any) => Promise.resolve(ROWS[args?.where?.id] ?? null));
  mockGetValidToken.mockResolvedValue('gh-token-17faa5e9');
});

/** A GitHub contents-API payload for a file whose content is `text`. */
const contentsPayload = (text: string) => ({
  type: 'file',
  encoding: 'base64',
  // GitHub wraps base64 at 60 cols — the decoder must tolerate whitespace.
  content: Buffer.from(text, 'utf8').toString('base64').replace(/.{1,60}/g, '$&\n'),
});

const fetchReturning = (status: number, body?: any) =>
  jest.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as any;

describe('ticket 17faa5e9 — the replay_test_missing streak replay', () => {
  it('REPLAY: the replay test is absent from the stale instance checkout but PRESENT on origin/main — the close now verifies', async () => {
    // At 2026-09-17T05:00Z this shape refused replay_test_missing 3× (the
    // streak) because the gate had no origin/main lane yet (#841, 817e81035).
    const fetchImpl = fetchReturning(200, contentsPayload(`// replays ticket ${PREFIX}\nit('pins it', () => {});`));
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: SIM_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    const note = (v as any).auditNote as string;
    expect(note).toContain('origin/main');
    expect(note).toContain(`cites ${PREFIX}`);
    // The lane asked GitHub for exactly this path on ref=main with the token.
    expect(mockGetValidToken).toHaveBeenCalledWith(OWNER);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(`/contents/${SIM_REL.split('/').map(encodeURIComponent).join('/')}`);
    expect(url).toContain('ref=main');
  });

  it('the ORIGINAL failing path resolves through the real gate today — the ce9ee48d replay test rides this checkout (local lane, no network)', async () => {
    // STREAK_REL is the verbatim replayTestPath from the 05:00Z failure texts.
    // It is committed on origin/main (da32c1721 / PR #826) and present in this
    // checkout, so the gate's local lane resolves it and never consults
    // GitHub — the exact close that was refused at 05:00Z passes now.
    const fetchImpl = jest.fn() as any;
    const v = await verifyMachineCloseEvidence({
      ticketId: CE_TICKET_ID,
      evidence: { replayTestPath: STREAK_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it('a GitHub 404 stays AUTHORITATIVE — had the lane never committed the file, replay_test_missing still fires', async () => {
    const fetchImpl = fetchReturning(404);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/never-committed.17faa5e9.test.ts' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    const msg = (v as any).message as string;
    expect(msg).toContain('NOT on origin/main');
  });
});
