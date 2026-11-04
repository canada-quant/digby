/**
 * Replay for ticket 012d3aa2 — "Evidence-close gate rejects valid replay-test
 * closes ~2h post-deploy (stale instance checkout)".
 *
 * THE BUG (2026-09-17, dd4e20ad lifecycle): the fix merged (PR #836) and
 * deployed, but the machine-verified close was REFUSED for ~2h20m because the
 * gate verified replayTestPath only against the INSTANCE checkout (the prod
 * /opt/crossmodel bind mount), which still predated the merge — the committed
 * replay test "did not exist" from the gate's view. The lane needed three
 * self-scheduled retries until the instance synced.
 *
 * THE FIX (this ticket): on a local-root miss the gate now ALSO verifies
 * against origin/main via the GitHub contents API (riding the ticket owner's
 * connected token), and the degraded refusal names the stale-instance-checkout
 * cause + the retry-after-deploy remedy.
 *
 * These tests replay both sides through the REAL gate: a temp REPLAY_TEST_ROOT
 * WITHOUT the file simulates the stale instance; the GitHub lane is stubbed at
 * the token + fetch seams (getValidToken mocked, fetchImpl injected — no
 * network). Mock discipline mirrors closure-evidence.test.ts: logger +
 * config/database mocked ABOVE the imports.
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

const TICKET_ID = '012d3aa2-2d78-4e00-956c-e422ade9c4f7';
const PREFIX = '012d3aa2';
const OWNER = 'user-83e4fbf9';
// A FICTIONAL path (never present in this dev worktree) so the temp
// REPLAY_TEST_ROOT truly simulates the stale instance — using a real worktree
// path would resolve locally via process.cwd() and defeat the simulation.
const REPLAY_REL = 'backend/src/modules/crossmodel/feedback/stale-instance-sim.012d3aa2.test.ts';

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  // The STALE INSTANCE: a mounted checkout that predates the merge — it does
  // NOT carry the replay test.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-stale-012d3aa2-'));
  process.env.REPLAY_TEST_ROOT = root;
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
    id: TICKET_ID,
    type: 'bug_report',
    title: 'Evidence-close gate rejects valid replay-test closes ~2h post-deploy (stale instance checkout)',
    userId: OWNER,
  });
  mockGetValidToken.mockResolvedValue('gh-token-012d3aa2');
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

describe('ticket 012d3aa2 — the stale-instance replay', () => {
  it('REPLAY: the replay test is absent from the stale instance checkout but PRESENT on origin/main — the close now verifies', async () => {
    // Before the fix this refused replay_test_missing for ~2h20m (dd4e20ad).
    const fetchImpl = fetchReturning(200, contentsPayload(`// replays ticket ${PREFIX}\nit('pins it', () => {});`));
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    const note = (v as any).auditNote as string;
    expect(note).toContain('origin/main');
    expect(note).toContain(`cites ${PREFIX}`);
    // The lane asked GitHub for exactly this path on ref=main with the token.
    expect(mockGetValidToken).toHaveBeenCalledWith(OWNER);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(`/contents/${REPLAY_REL.split('/').map(encodeURIComponent).join('/')}`);
    expect(url).toContain('ref=main');
  });

  it('a LOCAL hit still wins and never consults GitHub (no network on the hot path)', async () => {
    const abs = path.join(root, REPLAY_REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// local pin for ${PREFIX}\n`);
    const fetchImpl = jest.fn() as any;
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it('GitHub 404 is AUTHORITATIVE — the refusal says the file was never committed (no stale-checkout misdiagnosis)', async () => {
    const fetchImpl = fetchReturning(404);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/never-committed.test.ts' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    const msg = (v as any).message as string;
    expect(msg).toContain('NOT on origin/main');
    expect(msg).toContain('never committed');
    expect(msg).not.toContain('STALE INSTANCE CHECKOUT');
  });

  it('a non-citing file on origin/main refuses replay_test_unciting (content is checked there too)', async () => {
    const fetchImpl = fetchReturning(200, contentsPayload('it("mentions nothing relevant", () => {});'));
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/unrelated.test.ts' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
    expect((v as any).message).toContain(PREFIX);
  });

  it('a non-test filename on origin/main refuses replay_test_not_a_test', async () => {
    const fetchImpl = fetchReturning(200, contentsPayload(`see ${PREFIX}`));
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'docs/notes.md' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_not_a_test' });
  });
});

describe('ticket 012d3aa2 — the degraded lanes stay honest', () => {
  it('no GitHub token → legacy fail-closed refusal that NOW names the stale-instance-checkout cause + retry remedy', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const fetchImpl = jest.fn() as any;
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    const msg = (v as any).message as string;
    // The pre-fix text survives verbatim (existing pins keep passing)…
    expect(msg).toContain('does not exist under any configured repo root');
    expect(msg).toContain('The file must be COMMITTED and present on this instance before it counts.');
    // …and the new guidance names the real cause + remedy.
    expect(msg).toContain('STALE INSTANCE CHECKOUT');
    expect(msg).toContain('012d3aa2');
    expect(msg).toContain('retry the close after the deploy settles');
    expect(fetchImpl).not.toHaveBeenCalled(); // no token → no fetch at all
  });

  it('a GitHub 5xx degrades identically (transient infra ≠ missing test)', async () => {
    const fetchImpl = fetchReturning(502);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    const msg = (v as any).message as string;
    expect(msg).toContain('STALE INSTANCE CHECKOUT');
    expect(msg).toContain('GitHub HTTP 502');
  });

  it('an unsafe path never touches the GitHub lane (traversal refuses exactly as before)', async () => {
    const fetchImpl = jest.fn() as any;
    for (const p of ['../outside.test.ts', 'src/../../outside.test.ts', '/etc/passwd.test.ts']) {
      const v = await verifyMachineCloseEvidence({
        ticketId: TICKET_ID,
        evidence: { replayTestPath: p },
        fetchImpl,
      });
      expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it('a ticket row without an owner id degrades to unavailable (never throws, fails closed)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
      id: TICKET_ID, type: 'bug_report', title: 'x', userId: undefined,
    });
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/just-merged.test.ts' },
      fetchImpl: jest.fn() as any,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    expect((v as any).message).toContain('STALE INSTANCE CHECKOUT');
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });
});
