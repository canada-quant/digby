/**
 * Ticket cf5f9718 — the done-bar's merged ∧ deployed proof was PLATFORM-
 * repo-scoped: fix-state.ts hardcoded the instance repo (production default
 * canada-quant/digby) into every GitHub read, so a fix verified merged +
 * live in a DIFFERENT repo (2026-10-27, ticket 4e818bb9: deckpose fix merged
 * in canada-quant/example-repo, PR #184, live-probed) could NEVER machine-close —
 * the compare 404'd deterministically and the close was refused fix_not_live.
 *
 * THE FIX: the evidence envelope may name the repo (evidence.repo,
 * "owner/name" — validated + audited by closure-evidence.ts, parsed here by
 * parseClosureEvidenceNote) and EVERY GitHub read in fix-state.ts (merge
 * compare, Actions run, head + box-ancestry descendant check) targets THAT
 * repo. The default (no repo member) stays the instance's own slug — the
 * pre-cf5f9718 behavior byte-identical. The same merged ∧ deployed bar
 * applies in the named repo; nothing loosens.
 *
 * DETECTOR-RECALL REPLAY (the done-bar is an evidence gate; this change
 * widens WHO can pass, never the bar): the prior true positives are replayed
 * below — an unscoped cross-repo close still refuses (GitHub compare 404 on
 * the platform repo, the exact 4e818bb9 refusal), an UNMERGED sha in the
 * named repo still refuses, and the kill switch
 * FIX_STATE_EVIDENCE_REPO_DISABLED=1 restores the pre-cf5f9718 behavior.
 *
 * Mock discipline mirrors fix-state.b165cfdb.test.ts (the token seam, the
 * prisma telemetry/lane-home reads and the network fetch are stubbed — the
 * REAL resolver, parser and scope helper run).
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

import { resolveFixStateFromEvidence, parseClosureEvidenceNote, resolveEvidenceRepoScope } from './fix-state';

const OWNER_TOKEN_USER = '11111111-2222-4333-8444-555566667777';
const OPTCG_FIX = '23fb37165c53eee4418b31e1cac935369de013f2'; // the 4e818bb9 deckpose merge commit (canada-quant/example-repo)
const OPTCG_RUN = '40440661177'; // a green Actions run id
const TICKET = 'cf5f9718-4a17-4438-8837-d1f58f942816';

let urls: string[] = [];
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

const OPTCG_GREEN = [
  { match: new RegExp(`/repos/canada-quant/example-repo/compare/${OPTCG_FIX}\\.\\.\\.main`), body: { status: 'ahead', ahead_by: 2, behind_by: 0 } },
  { match: new RegExp(`/repos/canada-quant/example-repo/actions/runs/${OPTCG_RUN}`), body: { status: 'completed', conclusion: 'success' } },
];

const ENV = { ...process.env };

beforeAll(() => {
  // Prod instance (default): unset the boundary vars so the UNSCOPED slug is
  // the production default and the named-repo boundary test can opt INTO a
  // non-prod instance explicitly.
  delete process.env.DIGBY_INSTANCE;
  delete process.env.GITHUB_REPO_SLUG;
  delete process.env.FIX_STATE_EVIDENCE_REPO_DISABLED;
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
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  // The named-repo scenarios need the owner's box-env opt-in: the allowlist
  // (lane-unwritable) is the trust anchor — unset = the instance repo only.
  process.env.FIX_STATE_EVIDENCE_REPO_ALLOWLIST = 'canada-quant/example-repo';
});

describe('ticket cf5f9718 — the merged ∧ deployed proof targets the repo the evidence names', () => {
  it('REPLAY (the 4e818bb9 refusal): the SAME merged+green optcg evidence machine-closes once the evidence names the repo', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'canada-quant/example-repo', deployRunId: OPTCG_RUN },
      { fetchImpl: makeGh(OPTCG_GREEN) },
    );
    expect(st.fixLive).toBe(true);
    expect(st.reason).toContain('ancestor of origin/main');
    expect(st.reason).toContain(`deploy run ${OPTCG_RUN} concluded success`);
    // Every GitHub read went to the NAMED repo — never the platform repo.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes('/repos/canada-quant/example-repo/'))).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY: the SAME evidence WITHOUT repo still targets the platform repo and refuses (the pre-cf5f9718 true positive — the exact 4e818bb9 compare-404 refusal — still fires)', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, deployRunId: OPTCG_RUN },
      { fetchImpl: makeGh() }, // crossmodel compare 404s (a foreign sha)
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('GitHub compare 404');
    expect(urls.every((u) => u.includes('/repos/canada-quant/digby/'))).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY: an UNMERGED sha in the NAMED repo still refuses — the bar did not loosen', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'canada-quant/example-repo', deployRunId: OPTCG_RUN },
      {
        fetchImpl: makeGh([
          { match: new RegExp(`/repos/canada-quant/example-repo/compare/${OPTCG_FIX}`), body: { status: 'behind', ahead_by: 0, behind_by: 5 } },
        ]),
      },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('NOT merged');
  });

  it('a green deploy run in the named repo is read from the NAMED repo too (Actions run URL)', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'canada-quant/example-repo', deployRunId: OPTCG_RUN },
      {
        fetchImpl: makeGh([
          { match: new RegExp(`/repos/canada-quant/example-repo/compare/${OPTCG_FIX}\\.\\.\\.main`), body: { status: 'identical' } },
          { match: new RegExp(`/repos/canada-quant/example-repo/actions/runs/${OPTCG_RUN}`), body: { status: 'completed', conclusion: 'success' } },
        ]),
      },
    );
    expect(st.fixLive).toBe(true);
    expect(urls.some((u) => u.includes(`/repos/canada-quant/example-repo/actions/runs/${OPTCG_RUN}`))).toBe(true);
  });

  it('a NON-prod instance refuses to scope ticket-closure evidence at the PRODUCTION repo (the c75b5f34 boundary applies to the scope) — and makes NO GitHub read', async () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    try {
      const st = await resolveFixStateFromEvidence(
        { id: TICKET, userId: OWNER_TOKEN_USER },
        { commitSha: OPTCG_FIX, repo: 'canada-quant/digby', deployRunId: OPTCG_RUN },
        { fetchImpl: makeGh() },
      );
      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('ISOLATION BOUNDARY');
      expect(st.reason).toContain('canada-quant/digby');
      expect(urls).toEqual([]);
    } finally {
      delete process.env.DIGBY_INSTANCE;
    }
  });

  it('a repo NOT on the allowlist refuses with REPO NOT ALLOWED before ANY GitHub read (the lane-unwritable trust anchor — a scratch repo cannot launder a merged ∧ deployed proof)', async () => {
    process.env.FIX_STATE_EVIDENCE_REPO_ALLOWLIST = 'canada-quant/digby';
    try {
      const st = await resolveFixStateFromEvidence(
        { id: TICKET, userId: OWNER_TOKEN_USER },
        { commitSha: OPTCG_FIX, repo: 'canada-quant/example-repo', deployRunId: OPTCG_RUN },
        { fetchImpl: makeGh(OPTCG_GREEN) }, // green evidence would have passed — the allowlist must refuse FIRST
      );
      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('REPO NOT ALLOWED');
      expect(st.reason).toContain('FIX_STATE_EVIDENCE_REPO_ALLOWLIST');
      expect(urls).toEqual([]);
    } finally {
      process.env.FIX_STATE_EVIDENCE_REPO_ALLOWLIST = 'canada-quant/example-repo';
    }
  });

  it('kill switch FIX_STATE_EVIDENCE_REPO_DISABLED=1 ignores the named repo (restores the pre-cf5f9718 all-platform behavior)', async () => {
    process.env.FIX_STATE_EVIDENCE_REPO_DISABLED = '1';
    try {
      const st = await resolveFixStateFromEvidence(
        { id: TICKET, userId: OWNER_TOKEN_USER },
        { commitSha: OPTCG_FIX, repo: 'canada-quant/example-repo', deployRunId: OPTCG_RUN },
        { fetchImpl: makeGh() }, // crossmodel compare 404s
      );
      expect(st.fixLive).toBe(false);
      expect(st.reason).toContain('GitHub compare 404');
      expect(urls.every((u) => u.includes('/repos/canada-quant/digby/'))).toBe(true);
    } finally {
      delete process.env.FIX_STATE_EVIDENCE_REPO_DISABLED;
    }
  });

  it('an INVALID repo slug degrades to the platform scope (fail-safe — never crashes, never fabricates a repo)', async () => {
    const st = await resolveFixStateFromEvidence(
      { id: TICKET, userId: OWNER_TOKEN_USER },
      { commitSha: OPTCG_FIX, repo: 'not-a-slug', deployRunId: OPTCG_RUN },
      { fetchImpl: makeGh() },
    );
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('GitHub compare 404');
    expect(urls.every((u) => u.includes('/repos/canada-quant/digby/'))).toBe(true);
  });
});

describe('resolveEvidenceRepoScope — the lane-unwritable trust anchor (ticket cf5f9718 review)', () => {
  const ALLOW = { FIX_STATE_EVIDENCE_REPO_ALLOWLIST: 'Acme-Corp/Widgets, canada-quant/other, canada-quant/example-repo' } as NodeJS.ProcessEnv;

  it('a repo ON the allowlist resolves; case is normalized', () => {
    expect(resolveEvidenceRepoScope({ repo: 'Acme-Corp/Widgets' }, ALLOW)).toEqual({ slug: 'acme-corp/widgets' });
  });
  it('UNSET allowlist = the instance repo only: naming the platform repo on prod resolves (the pre-cf5f9718 behavior)', () => {
    expect(resolveEvidenceRepoScope({ repo: 'canada-quant/digby' }, {})).toEqual({ slug: 'canada-quant/digby' });
  });
  it('UNSET allowlist: naming any OTHER repo refuses with owner-action guidance naming the env var', () => {
    const r = resolveEvidenceRepoScope({ repo: 'canada-quant/example-repo' }, {});
    expect(r.refusal).toContain('REPO NOT ALLOWED');
    expect(r.refusal).toContain('FIX_STATE_EVIDENCE_REPO_ALLOWLIST');
    expect(r.slug).toBeUndefined();
  });
  it('the isolation boundary fires BEFORE the allowlist (a non-prod instance never reads production, allowlist or not)', () => {
    const env = { DIGBY_INSTANCE: 'edge', FIX_STATE_EVIDENCE_REPO_ALLOWLIST: 'canada-quant/digby' } as NodeJS.ProcessEnv;
    expect(resolveEvidenceRepoScope({ repo: 'canada-quant/digby' }, env).refusal).toContain('ISOLATION BOUNDARY');
  });
  it('absent repo → unscoped (the instance slug), allowlist untouched', () => {
    expect(resolveEvidenceRepoScope({}, ALLOW)).toEqual({});
  });
  it('an invalid slug → unscoped, not an error', () => {
    expect(resolveEvidenceRepoScope({ repo: 'pasta paul' }, ALLOW)).toEqual({});
  });
  it('the kill switch ignores the named repo', () => {
    const env = { FIX_STATE_EVIDENCE_REPO_DISABLED: '1', FIX_STATE_EVIDENCE_REPO_ALLOWLIST: 'canada-quant/example-repo' } as NodeJS.ProcessEnv;
    expect(resolveEvidenceRepoScope({ repo: 'canada-quant/example-repo' }, env)).toEqual({});
  });
  it('EVIDENCE MISMATCH: a prUrl naming a DIFFERENT repo than the scope refuses before any read', () => {
    const r = resolveEvidenceRepoScope({ repo: 'canada-quant/example-repo', prUrl: 'https://github.com/canada-quant/digby/pull/184' }, ALLOW);
    expect(r.refusal).toContain('EVIDENCE MISMATCH');
    expect(r.refusal).toContain('canada-quant/digby');
  });
  it('a prUrl INSIDE the named repo is consistent (case-insensitive)', () => {
    expect(resolveEvidenceRepoScope({ repo: 'canada-quant/example-repo', prUrl: 'https://github.com/Canada-Quant/Example-Repo/pull/184' }, ALLOW)).toEqual({ slug: 'canada-quant/example-repo' });
  });
  it('an unparseable prUrl is left to the close gate (no mismatch refusal here)', () => {
    expect(resolveEvidenceRepoScope({ repo: 'canada-quant/example-repo', prUrl: 'http://evil.example/pull/1' }, ALLOW)).toEqual({ slug: 'canada-quant/example-repo' });
  });
});

describe('parseClosureEvidenceNote — the repo member round-trips through the audit note', () => {
  it('repo <owner/name> parses (the shape closure-evidence.ts / closure-manifest.ts record)', () => {
    const note = parseClosureEvidenceNote(
      `[machine-close evidence: commit ${OPTCG_FIX}; repo canada-quant/example-repo; PR https://github.com/canada-quant/example-repo/pull/184; deploy run ${OPTCG_RUN}]`,
    );
    expect(note).toEqual({
      commitSha: OPTCG_FIX,
      repo: 'canada-quant/example-repo',
      prUrl: 'https://github.com/canada-quant/example-repo/pull/184',
      deployRunId: OPTCG_RUN,
    });
  });
  it('a block without repo parses repo-less (old notes keep parsing)', () => {
    expect(parseClosureEvidenceNote('[machine-close evidence: commit abcdef1 (format-verified)]')).toEqual({ commitSha: 'abcdef1' });
  });
  it('a malformed repo token is NOT parsed as a repo (the resolver degrades to the platform scope)', () => {
    expect(parseClosureEvidenceNote('[machine-close evidence: commit abcdef1; repo nonsense]')?.repo).toBeUndefined();
  });
});
