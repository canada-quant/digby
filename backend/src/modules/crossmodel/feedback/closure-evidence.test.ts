/**
 * Verified-close evidence gate (audit roadmap #7/#7b) — closure-evidence unit
 * tests with mocked Prisma and REAL fs against a temp REPLAY_TEST_ROOT.
 *
 * Pins: no evidence refuses; mishap (type AND title-class) requires a replay
 * test even when a commitSha is supplied; replayTestPath is deterministically
 * verified (existing+citing file passes, missing file refuses, non-citing
 * content refuses, non-test filename refuses, traversal refuses); commitSha is
 * format-verified and recorded as such; prUrl/deployRunId are supporting-only
 * (never satisfy the bar alone, malformed ones refuse); every refusal carries
 * the exact contract telling the model what to supply.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { verifyMachineCloseEvidence, resolveReplayTestFile } from './closure-evidence';

const TICKET_ID = 'abc12345-6789-4def-9012-3456789abcde';
const PREFIX = 'abc12345';

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-root-'));
  process.env.REPLAY_TEST_ROOT = root;
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
    id: TICKET_ID, type: 'bug_report', title: 'Attach button dead on the default coding model',
  });
});

function writeReplay(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

describe('verifyMachineCloseEvidence — the bar itself', () => {
  it('refuses with evidence_required when no evidence is supplied (structured contract in the message)', async () => {
    for (const evidence of [undefined, null, {}]) {
      const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: evidence as any });
      expect(v).toMatchObject({ ok: false, reason: 'evidence_required' });
      const msg = (v as any).message as string;
      expect(msg).toContain('replayTestPath');
      expect(msg).toContain('commitSha');
      expect(msg).toContain(PREFIX); // the exact prefix the replay test must cite
      expect(msg).toContain('leave it in_progress'); // the honest fallback path
    }
  });

  it('refuses an unknown ticket (ticket_not_found) without touching fs', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    const v = await verifyMachineCloseEvidence({ ticketId: 'nope', evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
  });

  it('fails CLOSED on a ticket-load error (never an unverified close)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockRejectedValue(new Error('db down'));
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
    expect((v as any).message).toContain('NOT applied');
  });
});

describe('verifyMachineCloseEvidence — mishap → replay-test policy (#7b)', () => {
  it("a type='mishap' ticket refuses done without replayTestPath even with a valid commitSha", async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: TICKET_ID, type: 'mishap', title: 'Guard withheld answer' });
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_required_for_mishap' });
    expect((v as any).message).toContain('replayTestPath is REQUIRED');
  });

  it('a TITLE-class mishap (word "mishap" in the title, filed under another type) also requires the replay test', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: TICKET_ID, type: 'bug_report', title: 'Recurring dispatch mishap in the nightly lane' });
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_required_for_mishap' });
  });

  it('a mishap with a verified replay test passes', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: TICKET_ID, type: 'mishap', title: 'Guard withheld answer' });
    const rel = writeReplay('src/mishaps/guard-withhold.replay.test.ts', `// replays ticket ${PREFIX}\nit('pins it', () => {});`);
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect((v as any).auditNote).toContain(rel);
    expect((v as any).auditNote).toContain(`cites ${PREFIX}`);
  });

  it('forClose:false (the ticket-18086326 machine-MUTATION gate) does NOT demand the replay test — commitSha alone satisfies the bar', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: TICKET_ID, type: 'mishap', title: 'Guard withheld answer' });
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: 'a'.repeat(40) }, forClose: false });
    expect(v).toMatchObject({ ok: true, verified: ['commitSha'] });
  });

  it('forClose omitted (default) keeps the mishap replay demand — close behavior unchanged', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: TICKET_ID, type: 'mishap', title: 'Guard withheld answer' });
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_required_for_mishap' });
  });
});

describe('verifyMachineCloseEvidence — replayTestPath verification', () => {
  it('an existing test file citing the ticket prefix passes (case-insensitive cite)', async () => {
    const rel = writeReplay('src/replays/attach-button.test.ts', `describe('${PREFIX.toUpperCase()} replay', () => {});`);
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
  });

  it('a MISSING file refuses (replay_test_missing) — committed-and-present is the bar', async () => {
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: 'src/replays/never-written.test.ts' } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    expect((v as any).message).toContain('does not exist');
  });

  it('a file that never cites the ticket id prefix refuses (replay_test_unciting)', async () => {
    const rel = writeReplay('src/replays/unrelated.test.ts', 'it("mentions nothing relevant", () => {});');
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
    expect((v as any).message).toContain(PREFIX);
  });

  it('a non-test filename refuses (replay_test_not_a_test) — a README citing the id is not a replay', async () => {
    const rel = writeReplay('docs/notes.md', `see ${PREFIX}`);
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: false, reason: 'replay_test_not_a_test' });
  });

  it('traversal and absolute paths are rejected as missing', async () => {
    for (const p of ['../outside.test.ts', 'src/../../outside.test.ts', '/etc/passwd.test.ts']) {
      const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: p } });
      expect(v).toMatchObject({ ok: false, reason: 'replay_test_missing' });
    }
  });

  it("resolves repo-root-relative 'backend/…' paths against a backend-only root (container layout)", async () => {
    writeReplay('src/replays/root-relative.test.ts', `// ${PREFIX}`);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { replayTestPath: 'backend/src/replays/root-relative.test.ts' },
    });
    expect(v).toMatchObject({ ok: true });
  });

  it('resolveReplayTestFile returns null outside every root', () => {
    expect(resolveReplayTestFile('no/such/file.test.ts')).toBeNull();
    expect(resolveReplayTestFile('../escape.test.ts')).toBeNull();
  });

  it("resolves a repo-root-relative 'backend/…' path VERBATIM under a FULL-REPO $REPLAY_TEST_ROOT (the prod /opt/crossmodel:/repo:ro bind mount)", async () => {
    // The prod containers mount the whole rsynced repo at /repo and set
    // REPLAY_TEST_ROOT=/repo — a repo-root-relative path must resolve there
    // without the backend/ strip (the mount root HAS the backend dir).
    const rel = writeReplay('backend/src/replays/full-repo-root.test.ts', `// pins ticket ${PREFIX}\nit('replays it', () => {});`);
    expect(resolveReplayTestFile(rel)).toBe(path.join(root, rel));
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
  });
});

describe('verifyMachineCloseEvidence — commitSha and supporting members', () => {
  it('a well-formed commitSha satisfies the bar for a NON-mishap ticket, recorded as format-verified', async () => {
    const sha = 'deadbeefcafe1234'.padEnd(40, '0');
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: sha } });
    expect(v).toMatchObject({ ok: true, verified: ['commitSha'] });
    const note = (v as any).auditNote as string;
    expect(note).toContain(sha);
    expect(note).toContain('format-verified');
    expect(note).toContain('existence not checkable server-side');
  });

  it('a malformed commitSha refuses (invalid_commit_sha) — junk prose is not a sha', async () => {
    for (const sha of ['not-a-sha', 'abc123', 'g'.repeat(40), 'a'.repeat(41)]) {
      const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { commitSha: sha } });
      expect(v).toMatchObject({ ok: false, reason: 'invalid_commit_sha' });
    }
  });

  it('prUrl / deployRunId ALONE never satisfy the bar (unverifiable_evidence)', async () => {
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { prUrl: 'https://github.com/canada-quant/digby/pull/595', deployRunId: '123456789' },
    });
    expect(v).toMatchObject({ ok: false, reason: 'unverifiable_evidence' });
    expect((v as any).message).toContain('replayTestPath');
  });

  it('a FAILING supplied member refuses even when another member passes (never silently dropped)', async () => {
    const good = 'a'.repeat(40);
    const badPr = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID, evidence: { commitSha: good, prUrl: 'http://evil.example/pull/1' },
    });
    expect(badPr).toMatchObject({ ok: false, reason: 'invalid_pr_url' });
    const badRun = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID, evidence: { commitSha: good, deployRunId: 'run-42' },
    });
    expect(badRun).toMatchObject({ ok: false, reason: 'invalid_deploy_run_id' });
  });

  it('valid supporting members ride the audit note alongside the satisfying member', async () => {
    const sha = 'b'.repeat(40);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { commitSha: sha, prUrl: 'https://github.com/canada-quant/digby/pull/595', deployRunId: '17654321000' },
    });
    expect(v).toMatchObject({ ok: true });
    const note = (v as any).auditNote as string;
    expect(note).toContain('PR https://github.com/canada-quant/digby/pull/595');
    expect(note).toContain('deploy run 17654321000');
  });

  it('a valid repo slug rides the audit note (ticket cf5f9718) — the done-bar knows where to look', async () => {
    const sha = 'c'.repeat(40);
    const v = await verifyMachineCloseEvidence({
      ticketId: TICKET_ID,
      evidence: { commitSha: sha, repo: 'canada-quant/example-repo' },
    });
    expect(v).toMatchObject({ ok: true, verified: ['commitSha'] });
    const note = (v as any).auditNote as string;
    expect(note).toContain(`commit ${sha}`);
    expect(note).toContain('repo canada-quant/example-repo');
  });

  it('a malformed repo slug refuses (invalid_repo) — a malformed scope must not silently downgrade to the platform repo and 404', async () => {
    for (const repo of ['nonsense', 'pasta paul/optcg', 'canada-quant/example-repo/x', 'canada-quant/', '/optcg', 'canada-quant/example-repo extra']) {
      const v = await verifyMachineCloseEvidence({
        ticketId: TICKET_ID,
        evidence: { commitSha: 'd'.repeat(40), repo },
      });
      expect(v).toMatchObject({ ok: false, reason: 'invalid_repo' });
    }
  });
});
