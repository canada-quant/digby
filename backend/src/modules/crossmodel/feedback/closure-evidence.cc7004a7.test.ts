/**
 * REPLAY for ticket cc7004a7 — "3× tool-failure streak: update_feedback on
 * 'Digby's Nightly Self-Improvement Enginee' — framework or model?"
 *
 * THE MISHAP (2026-09-23, session b92ef13f run 006efc0d, refusals 18:4x–18:5xZ,
 * breaker filed 18:51:07Z): two machine-close attempts were refused
 * replay_test_unciting on replayTestPaths whose citations WERE already on
 * origin/main —
 *   · ast-tools.test.ts: the 05198c8e pins merged at 18:14:06Z (69d535687,
 *     PR #1003) but the refusal came 37 minutes later;
 *   · run-executor.test.ts: the cca4e450 citation append merged 18:37:25Z
 *     (ef42d60e3, PR #1006) but the refusal came 14 minutes later.
 * Both files PRE-EXISTED the merge (created 2026-09-20 / 2026-07-24), so the
 * serving boxes' bind mount resolved them LOCALLY with the pre-append content
 * — and the 012d3aa2 origin/main fallback engaged ONLY on local-file ABSENCE
 * (closure-evidence.ts `if (!abs)`), so the local citation miss refused
 * without ever consulting origin/main. The refusal's advertised remedy ("add
 * a comment or test name carrying X") was already satisfied on main, making
 * the retries correct-but-doomed until wave 35901047857 synced the checkout
 * (the 05198c8e close then passed via a plain local hit at 19:12:19Z).
 *
 * ADJUDICATION: FRAMEWORK-SIDE (deterministic). The tool schema
 * (platform-tools.ts) already promised "must exist (on this instance or on
 * origin/main) and mention the ticket id prefix" — the code just never
 * consulted origin/main on the citation-miss shape. The 2026-09-20 closeout
 * batch (agent-derail-break.closeout-20260920.test.ts) had already worked
 * around this exact hole with NEW-file pins ("A NEW file is a local MISS,
 * which engages the designed origin/main fallback lane"); cc7004a7 is the
 * second occurrence of the class, so this fix closes the hole at the cause.
 *
 * THE FIX: a local CITATION miss now runs the same
 * fetchReplayTestFromOriginMain consult as a local FILE miss —
 *   found+citing  → verifies, auditNote says "verified via origin/main …
 *                   stale-checkout tolerated", remaining members still checked;
 *   found+unciting→ refuses "exists (both on this instance and on origin/main)
 *                   but never mentions …" (genuinely unciting everywhere);
 *   unavailable/absent → legacy fail-closed refusal, now naming the STALE
 *                   INSTANCE CHECKOUT cause + retry-after-deploy remedy.
 *
 * These tests replay all four shapes through the REAL gate (temp
 * REPLAY_TEST_ROOT simulates the stale bind mount; getValidToken mocked,
 * fetchImpl injected — no network). Mock discipline mirrors
 * closure-evidence.012d3aa2.test.ts.
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

const TICKET_ID = 'cc7004a7-e9cb-48a0-974f-a0e855f538c9';
const PREFIX = 'cc7004a7';
const OWNER = 'user-83e4fbf9';
// A FICTIONAL repo-relative path (never present in a real checkout) so the
// temp REPLAY_TEST_ROOT truly simulates the stale instance; the FILE exists
// there (pre-existing) but WITHOUT the citation — exactly ast-tools.test.ts
// on the serving boxes between 18:14Z and the wave-35901047857 sync.
const REPLAY_REL = 'backend/src/modules/crossmodel/coding/stale-cite-sim.cc7004a7.test.ts';

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-stale-cite-cc7004a7-'));
  process.env.REPLAY_TEST_ROOT = root;
  // The STALE INSTANCE: the file is present (it pre-existed the merge) but
  // carries the PRE-APPEND content — no cc7004a7 citation.
  const abs = path.join(root, REPLAY_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'describe("pre-append copy", () => {\n  it("mentions nothing relevant", () => {});\n});\n');
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
    id: TICKET_ID,
    type: 'mishap',
    title: '3× tool-failure streak: update_feedback on "Digby\'s Nightly Self-Improvement Enginee" — framework or model?',
    userId: OWNER,
  });
  mockGetValidToken.mockResolvedValue('gh-token-cc7004a7');
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

describe('ticket cc7004a7 — the stale-checkout APPEND-CITATION replay', () => {
  it('REPLAY: the file exists locally WITHOUT the citation, but origin/main HAS it (append merged 14–37 min ago) — the close now verifies', async () => {
    // Before the fix this refused replay_test_unciting even though the
    // citation was committed — the exact 18:5xZ refusals.
    const fetchImpl = fetchReturning(
      200,
      contentsPayload(`// replays ticket ${PREFIX}\nit('pins it', () => {});`),
    );
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    const note = (v as any).auditNote as string;
    expect(note).toContain('origin/main');
    expect(note).toContain(`cites ${PREFIX}`);
    expect(note).toContain('stale-checkout tolerated');
    // The consult rode the ticket owner's token for exactly this path.
    expect(mockGetValidToken).toHaveBeenCalledWith(OWNER);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(`/contents/${REPLAY_REL.split('/').map(encodeURIComponent).join('/')}`);
    expect(url).toContain('ref=main');
  });

  it('the tolerant origin/main hit still validates the OTHER evidence members (a bad commitSha alongside still refuses)', async () => {
    const fetchImpl = fetchReturning(
      200,
      contentsPayload(`// replays ticket ${PREFIX}\nit('pins it', () => {});`),
    );
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL, commitSha: 'not-a-sha' },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'invalid_commit_sha' });
  });

  it('a local file that never cites AND an origin/main copy that never cites refuses — genuinely unciting everywhere', async () => {
    const fetchImpl = fetchReturning(200, contentsPayload('it("mentions nothing relevant", () => {});'));
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
    const msg = (v as any).message as string;
    expect(msg).toContain('both on this instance and on origin/main');
    expect(msg).toContain(`"${PREFIX}"`);
    expect(msg).toContain(`add a comment or test name carrying "${PREFIX}"`);
  });

  it('no GitHub token → fail-closed refusal that names the STALE INSTANCE CHECKOUT cause + retry-after-deploy remedy (the lane stops re-diagnosing)', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const fetchImpl = jest.fn() as any;
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
    const msg = (v as any).message as string;
    // The legacy conviction text survives (the refusal is still unciting)…
    expect(msg).toContain('exists but never mentions');
    expect(msg).toContain(`add a comment or test name carrying "${PREFIX}"`);
    // …and the new guidance names the real cause + remedy + both tickets.
    expect(msg).toContain('STALE INSTANCE CHECKOUT');
    expect(msg).toContain('cc7004a7');
    expect(msg).toContain('retry the close after the deploy settles');
    expect(fetchImpl).not.toHaveBeenCalled(); // no token → no fetch at all
  });

  it('a GitHub 5xx degrades identically (transient infra ≠ unciting test) and still names the stale-checkout cause', async () => {
    const fetchImpl = fetchReturning(502);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: REPLAY_REL },
      fetchImpl,
    });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
    const msg = (v as any).message as string;
    expect(msg).toContain('STALE INSTANCE CHECKOUT');
    expect(msg).toContain('GitHub HTTP 502');
  });

  it('a local file that ALREADY cites never consults GitHub (no network on the hot path)', async () => {
    // Post-sync state: the bind mount caught up (wave 35901047857) — the
    // 19:12:19Z 05198c8e close shape. Plain local hit, zero GitHub traffic.
    const abs = path.join(root, REPLAY_REL);
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
    // Restore the stale pre-append copy for any later ordering.
    fs.writeFileSync(abs, 'describe("pre-append copy", () => {\n  it("mentions nothing relevant", () => {});\n});\n');
  });
});
