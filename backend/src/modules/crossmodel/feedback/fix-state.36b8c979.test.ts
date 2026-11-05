/**
 * Ticket 36b8c979 — the liveness-probe path IN THE RESOLVER (fix-state.ts).
 *
 * DETECTOR-RECALL REPLAY: the done-bar is an evidence gate, and this change
 * widens WHO can pass its deployed leg — never the bar. The prior true
 * positives are replayed below and must still fire:
 *   (1) the cf5f9718 unscoped cross-repo refusal (the exact 4e818bb9
 *       compare-404 shape) — a fix NOT merged in the resolved repo refuses
 *       BEFORE any deployed check, probe or not;
 *   (2) a probe on a fix that IS merged but whose surface has since dropped
 *       the strings refuses (stale probe re-fires — the fail-closed
 *       direction);
 *   (3) a probe refusal (SSRF-shaped host recorded in a note) refuses;
 *   (4) the kill switch FIX_STATE_LIVENESS_PROBE_DISABLED=1 ignores a
 *       recorded probe (the pre-36b8c979 behavior — refused on the plain
 *       no-run/no-telemetry shape);
 *   (5) no probe recorded + no run + no telemetry = the pre-36b8c979
 *       refusal, byte-shaped ("no box runs the fix sha").
 * And the NEW positive: merged + probe-live = fixLive:true with all three
 * details in the reason — the deckpose/optcg close that motivated the ticket.
 *
 * Mock discipline mirrors fix-state.cf5f9718.test.ts (token seam, prisma
 * telemetry reads, GitHub fetch, DNS — all stubbed; the REAL parser and
 * resolver run).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  loopMetric: { findMany: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { resolveFixStateFromEvidence, parseClosureEvidenceNote } from './fix-state';
import type { DnsLookupAll } from './liveness-probe';

const OWNER_TOKEN_USER = '11111111-2222-4333-8444-555566667777';
const OPTCG_FIX = '23fb37165c53eee4418b31e1cac935369de013f2'; // the 4e818bb9 deckpose merge commit (example-org/optcg)
const TICKET = '36b8c979-8a3f-41d6-b81f-2f789bf1942d';
const PROBE = { url: 'https://deckpose.com/', expect: ['Save to My Decks', 'Copy decklist'] };
const PUBLIC_IP = '76.76.21.21';

let urls: string[];
/** Route-based GitHub stub: 200+body on the first matching route, else 404. Every URL is recorded. */
const makeGh = (routes: Array<{ match: RegExp; body: any }> = []) =>
  jest.fn(async (url: any) => {
    const s = String(url);
    urls.push(s);
    for (const r of routes) {
      if (r.match.test(s)) return { status: 200, ok: true, json: async () => r.body } as any;
    }
    return { status: 404, ok: false, json: async () => ({}) } as any;
  }) as any;

/** The merged optcg evidence with NO Actions run (total_count 0 — the ticket's shape). */
const MERGED_OPTCG = [{ match: new RegExp(`/repos/example-org/optcg/compare/${OPTCG_FIX}\\.\\.\\.main`), body: { status: 'ahead', ahead_by: 2, behind_by: 0 } }];

/** The probe seam (rides resolveFixStateFromEvidence's probeFetchImpl opt — the probe fetches the LIVE SURFACE, never the GitHub-wrapped fetch): deckpose.com resolves public, the fetch returns the shipped strings. */
const makeProbeSeam = (body: string, status = 200) => ({
  probeFetchImpl: jest.fn(async (url: any) => ({
    status,
    ok: status === 200,
    headers: { get: () => null },
    text: async () => body,
    json: async () => ({}),
  })) as any,
  doLookup: (jest.fn(async () => [{ address: PUBLIC_IP, family: 4 }]) as unknown) as DnsLookupAll,
});

const ENV = { ...process.env };

beforeAll(() => {
  delete process.env.DIGBY_INSTANCE;
  delete process.env.GITHUB_REPO_SLUG;
  delete process.env.FIX_STATE_EVIDENCE_REPO_DISABLED;
  delete process.env.FIX_STATE_LIVENESS_PROBE_DISABLED;
  process.env.TICKET_LANE_PROJECT_ID = 'proj-lane-home';
});

afterAll(() => {
  process.env = ENV;
});

beforeEach(() => {
  jest.clearAllMocks();
  urls = [];
  mockGetValidToken.mockResolvedValue('gh-token-owner');
  mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockPrisma.loopMetric.findMany.mockResolvedValue([]); // no box_health rows — the ticket's shape
  process.env.FIX_STATE_EVIDENCE_REPO_ALLOWLIST = 'example-org/optcg';
});

describe('ticket 36b8c979 — the deployed leg proves liveness by re-fetching the recorded probe server-side', () => {
  it('THE 4e818bb9 SHAPE: merged in example-org/optcg (no Actions runs, no box_health) + live-probe 200 with the strings = fixLive', async () => {
    const seam = makeProbeSeam('<html>Save to My Decks — Copy decklist — Edit deck</html>');
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: PROBE },
      { fetchImpl: makeGh(MERGED_OPTCG), ...seam },
    );
    expect(st.fixLive).toBe(true);
    expect(st.reason).toContain('ancestor of origin/main');
    expect(st.reason).toContain('live-probe https://deckpose.com/');
    expect(st.reason).toContain('all 2 expected string(s)');
    // Every GITHUB read went to the named repo; the probe fetch went to the probe url.
    expect(urls.every((u) => u.includes('/repos/example-org/optcg/'))).toBe(true);
    expect(seam.probeFetchImpl.mock.calls.every((c: any[]) => String(c[0]).startsWith('https://deckpose.com/'))).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY (cf5f9718): an UNMERGED sha refuses BEFORE the probe — the merged leg never loosens', async () => {
    const seam = makeProbeSeam('Save to My Decks');
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: PROBE },
      { fetchImpl: makeGh([{ match: new RegExp(`/repos/example-org/optcg/compare/${OPTCG_FIX}`), body: { status: 'diverged' } }]), ...seam },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('NOT merged');
    expect(seam.probeFetchImpl).not.toHaveBeenCalled(); // no probe ran — merge gate first
  });

  it('DETECTOR-RECALL REPLAY: the unscoped cross-repo close (no repo member) still refuses on the platform-repo compare 404', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, livenessProbe: PROBE },
      { fetchImpl: makeGh(), ...makeProbeSeam('x') },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('GitHub compare 404');
    expect(urls.every((u) => u.includes('/repos/example-org/crossmodel/'))).toBe(true);
  });

  it('FAIL-CLOSED: a surface that has since dropped the strings refuses (the stale probe re-fires)', async () => {
    const seam = makeProbeSeam('<html>deck rebuilt — strings removed</html>');
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: PROBE },
      { fetchImpl: makeGh(MERGED_OPTCG), ...seam },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('2/2 expected string(s) missing');
  });

  it('FAIL-CLOSED: a probe whose recorded host resolves non-public refuses (SSRF guard inside the resolver)', async () => {
    const seam = makeProbeSeam('anything');
    (seam.doLookup as any).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: { url: 'https://rebinding.example.com/', expect: ['x'] } },
      { fetchImpl: makeGh(MERGED_OPTCG), ...seam },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('non-public address');
  });

  it('FAIL-CLOSED: a probe fetch error refuses (never throws into the done-bar)', async () => {
    const seam = makeProbeSeam('x');
    (seam.probeFetchImpl as any).mockRejectedValue(new Error('ECONNRESET'));
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: PROBE },
      { fetchImpl: makeGh(MERGED_OPTCG), ...seam },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('fetch error');
  });

  it('KILL SWITCH: FIX_STATE_LIVENESS_PROBE_DISABLED=1 ignores the recorded probe (the pre-36b8c979 refusal returns)', async () => {
    process.env.FIX_STATE_LIVENESS_PROBE_DISABLED = '1';
    try {
      const seam = makeProbeSeam('Save to My Decks — Copy decklist');
      const st = await resolveFixStateFromEvidence(
        { id: TICKET, userId: OWNER_TOKEN_USER },
        { commitSha: OPTCG_FIX, repo: 'example-org/optcg', livenessProbe: PROBE },
        { fetchImpl: makeGh(MERGED_OPTCG), ...seam },
      );
      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('no box_health telemetry with a deploy sha');
      expect(seam.probeFetchImpl).not.toHaveBeenCalled();
    } finally {
      delete process.env.FIX_STATE_LIVENESS_PROBE_DISABLED;
    }
  });

  it('NO PROBE: the pre-36b8c979 no-run/no-telemetry shape refuses byte-shaped ("no box runs the fix sha")', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'example-org/optcg' },
      { fetchImpl: makeGh(MERGED_OPTCG) },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('no box_health telemetry with a deploy sha');
  });

  it('parseClosureEvidenceNote: the `live-probe` member survives the LAST-block rule (a reclose replaces the probe)', () => {
    const first = '[machine-close evidence: commit 1111111111111111111111111111111111111111 (format-verified); repo example-org/optcg; live-probe https://old.example.com/ (expects "old")]';
    const second = '[machine-close evidence: commit 2222222222222222222222222222222222222222 (format-verified); repo example-org/optcg; live-probe https://deckpose.com/ (expects "Save to My Decks|Copy decklist")]';
    const note = parseClosureEvidenceNote(`${first}\n${second}`);
    expect(note?.livenessProbe).toEqual(PROBE);
    expect(note?.commitSha).toBe('2222222222222222222222222222222222222222');
    const onlyFirst = parseClosureEvidenceNote(first);
    expect(onlyFirst?.livenessProbe).toEqual({ url: 'https://old.example.com/', expect: ['old'] });
  });
});
