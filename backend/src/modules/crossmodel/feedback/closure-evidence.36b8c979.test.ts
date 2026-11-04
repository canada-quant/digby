/**
 * Ticket 36b8c979 — the liveness probe at the CLOSE GATE (closure-evidence.ts
 * verifyMachineCloseEvidence): the probe is optional SUPPORTING evidence —
 * a malformed one refuses (invalid_liveness_probe), a valid one is audited
 * into the `[machine-close evidence: …]` note as
 * `live-probe <url> (expects "a|b")`, and the bar itself never loosens:
 * a probe alone never satisfies the machine-close bar, and a mishap still
 * needs its replay test.
 *
 * Mock discipline mirrors closure-evidence.ef7d082b.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { verifyMachineCloseEvidence, closeEvidenceContract } from './closure-evidence';

const TICKET_ID = '36b8c979-8a3f-41d6-b81f-2f789bf1942d';
const OWNER = '11111111-2222-4333-8444-555566667777';
const SHA = '23fb37165c53eee4418b31e1cac935369de013f2';
const PROBE = { url: 'https://deckpose.com/', expect: ['Save to My Decks', 'Copy decklist'] };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
    id: TICKET_ID,
    type: 'bug_report',
    title: 'Repo-scoped done-bar still cannot close a manually-deployed foreign repo',
    userId: OWNER,
  });
});

const attempt = (evidence: any) => verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence });

describe('ticket 36b8c979 — the close gate validates + records the liveness probe', () => {
  it('THE 4e818bb9 CLOSE: commitSha + repo + probe audits `live-probe` into the note', async () => {
    const v = await attempt({ commitSha: SHA, repo: 'canada-quant/example-repo', livenessProbe: PROBE });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.verified).toContain('commitSha');
    expect(v.auditNote).toContain(`commit ${SHA} (format-verified`);
    expect(v.auditNote).toContain('repo canada-quant/example-repo');
    expect(v.auditNote).toContain('live-probe https://deckpose.com/ (expects "Save to My Decks|Copy decklist")');
  });

  it('SUPPORTING ONLY: a probe alone never satisfies the bar (unverifiable_evidence)', async () => {
    const v = await attempt({ livenessProbe: PROBE });
    expect(v).toMatchObject({ ok: false, reason: 'unverifiable_evidence' });
    if (v.ok) return;
    expect(v.message).toContain('livenessProbe'); // the contract names the new member
  });

  it('MISHAP: a probe does not replace the replay test (replay_required_for_mishap)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
      id: TICKET_ID,
      type: 'mishap',
      title: 'A mishap-class ticket',
      userId: OWNER,
    });
    const v = await attempt({ commitSha: SHA, livenessProbe: PROBE });
    expect(v).toMatchObject({ ok: false, reason: 'replay_required_for_mishap' });
  });

  it('MALFORMED refuses: non-https url, non-string expect member, empty expect, quote/pipe in an expect string', async () => {
    const badUrl = await attempt({ commitSha: SHA, livenessProbe: { url: 'http://deckpose.com/', expect: ['x'] } });
    expect(badUrl).toMatchObject({ ok: false, reason: 'invalid_liveness_probe' });
    if (!badUrl.ok) expect(badUrl.message).toContain('must be https');

    const badMember = await attempt({ commitSha: SHA, livenessProbe: { url: 'https://deckpose.com/', expect: ['ok', 7] } });
    expect(badMember).toMatchObject({ ok: false, reason: 'invalid_liveness_probe' });
    if (!badMember.ok) expect(badMember.message).toContain('non-empty string');

    const emptyExpect = await attempt({ commitSha: SHA, livenessProbe: { url: 'https://deckpose.com/', expect: [] } });
    expect(emptyExpect).toMatchObject({ ok: false, reason: 'invalid_liveness_probe' });

    const pipe = await attempt({ commitSha: SHA, livenessProbe: { url: 'https://deckpose.com/', expect: ['a|b'] } });
    expect(pipe).toMatchObject({ ok: false, reason: 'invalid_liveness_probe' });
    if (!pipe.ok) expect(pipe.message).toContain('pipe');

    const ssrf = await attempt({ commitSha: SHA, livenessProbe: { url: 'https://127.0.0.1/', expect: ['x'] } });
    expect(ssrf).toMatchObject({ ok: false, reason: 'invalid_liveness_probe' });
  });

  it('a probe + prUrl (no commitSha/replayTestPath) still refuses — the bar never loosens', async () => {
    const v = await attempt({ prUrl: 'https://github.com/canada-quant/example-repo/pull/184', livenessProbe: PROBE });
    expect(v).toMatchObject({ ok: false, reason: 'unverifiable_evidence' });
  });

  it('no evidence at all still refuses with evidence_required', async () => {
    const v = await attempt({});
    expect(v).toMatchObject({ ok: false, reason: 'evidence_required' });
  });

  it('the contract sentence teaches the new member (a refused close names what to supply)', () => {
    expect(closeEvidenceContract('36b8c979', false)).toContain('livenessProbe');
    expect(closeEvidenceContract('36b8c979', false)).toContain('36b8c979');
  });
});
