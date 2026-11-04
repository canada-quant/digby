/**
 * REPLAY — ticket 51ff7e93 "Deploy telemetry only covers the framework repo —
 * project lanes can't verify their own deploys".
 *
 * The mishap: the One Piece TCG publish lane (repo canada-quant/example-repo, prod
 * deckpose.com) called get_fleet_telemetry view 'deploy' to verify its own
 * deploy and got the FRAMEWORK repo's runs back (DEPLOY_REPO is hardcoded),
 * so it fell back to probing production directly — weaker evidence, per-lane
 * duplicated effort. These tests pin the fix: view 'deploy' accepts a repo
 * scope ('owner/name' + optional ref) that reads ANY repo the connected
 * GitHub account can access, surfaces an ACCESS ERROR instead of silence
 * when it cannot, and answers "no Actions runs" honestly (optcg had ZERO
 * workflows on 2026-09-24 — an empty list is a real fact, not an error);
 * the default (no repo) framework read is unchanged.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockQuery: jest.Mock = jest.fn(async () => []);
const mockSummary: jest.Mock = jest.fn(async () => []);
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  queryLoopMetrics: (...a: any[]) => mockQuery(...a),
  summarizeLoopMetrics: (...a: any[]) => mockSummary(...a),
  recordLoopMetric: jest.fn(),
}));

import {
  clampTelemetryArgs,
  fleetTelemetry,
  readRepoDeployPicture,
  workflowName,
} from './fleet-telemetry';
import { fetchRepoActionRuns, fetchRepoHead, DEPLOY_REPO, type RepoRunsResult } from './infra-watch.service';

const NOW = new Date('2026-09-24T11:00:00.000Z');
const OPTCG = 'canada-quant/example-repo';

const mkRun = (over: Record<string, any> = {}) => ({
  id: 35980000001,
  head_sha: 'abcd12340000000000000000000000000000ffff',
  status: 'completed',
  conclusion: 'success',
  display_title: 'publish deckpose.com',
  created_at: '2026-09-24T09:40:00Z',
  updated_at: '2026-09-24T09:47:00Z',
  html_url: 'https://github.com/canada-quant/example-repo/actions/runs/35980000001',
  path: '.github/workflows/publish.yml',
  name: 'publish',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
  mockSummary.mockResolvedValue([]);
});

describe('51ff7e93 · clampTelemetryArgs repo/ref validation', () => {
  it('accepts a valid owner/name slug and optional ref, and defaults both away', () => {
    expect(clampTelemetryArgs({ view: 'deploy', repo: OPTCG })).toMatchObject({ view: 'deploy', repo: OPTCG });
    expect(clampTelemetryArgs({ view: 'deploy', repo: OPTCG, ref: 'release/1.x' })).toMatchObject({ repo: OPTCG, ref: 'release/1.x' });
    const plain = clampTelemetryArgs({ view: 'deploy' }) as any;
    expect(plain.repo).toBeUndefined();
    expect(plain.ref).toBeUndefined();
  });

  it('rejects anything that is not a plain owner/name slug (no path traversal, no query, no protocol)', () => {
    for (const bad of ['canada-quant/example-repo/actions/runs', '../etc', 'https://api.github.com/x', 'DROP TABLE', 'canada-quant', 'a/b/c', 'owner/name?per_page=100']) {
      expect(clampTelemetryArgs({ view: 'deploy', repo: bad })).toMatchObject({ error: expect.stringContaining("repo must be a GitHub slug 'owner/name'") });
    }
  });

  it('rejects a ref without repo, a malformed ref, and repo scoping on non-deploy views', () => {
    expect(clampTelemetryArgs({ view: 'deploy', ref: 'main' })).toMatchObject({ error: expect.stringContaining('ref requires repo') });
    expect(clampTelemetryArgs({ view: 'deploy', repo: OPTCG, ref: 'main?per_page=100' })).toMatchObject({ error: expect.stringContaining('ref must be a plain branch name') });
    expect(clampTelemetryArgs({ view: 'metrics', kind: 'x', repo: OPTCG })).toMatchObject({ error: expect.stringContaining("repo/ref scoping is supported on view 'deploy' only") });
  });
});

describe('51ff7e93 · repo-scoped deploy view', () => {
  it('returns the project repo\'s runs (every workflow), its main head, and NO box picture', async () => {
    const out: any = await fleetTelemetry(
      { view: 'deploy', repo: OPTCG },
      {
        userId: 'owner', now: NOW,
        getGithubToken: async () => 'tok',
        fetchRepoRuns: async () => ({ ok: true, runs: [mkRun()] }),
        fetchRepoHead: async () => ({ sha: 'abcd12340000000000000000000000000000ffff', committedAt: '2026-09-24T09:38:00Z', title: 'publish deckpose.com (#12)' }),
      },
    );
    expect(out.ok).toBe(true);
    expect(out.repo).toBe(OPTCG);
    expect(out.ref).toBe('main');
    expect(out.mainHead).toMatchObject({ sha: 'abcd1234', title: 'publish deckpose.com (#12)' });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ id: 35980000001, sha: 'abcd1234', status: 'completed', conclusion: 'success', workflow: 'publish.yml' });
    expect(out.inFlight).toBe(false);
    expect(out.boxes).toBeUndefined(); // box_health rows are the FRAMEWORK's boxes — never shown against a foreign repo
    expect(out.reading).toContain('canada-quant/example-repo main head is abcd1234.');
    expect(out.reading).toContain('Last completed Actions run: abcd1234 (publish.yml) → success');
  });

  it('passes the ref through to the scoped read when narrowed', async () => {
    const fetchRepoRuns = jest.fn(async (): Promise<RepoRunsResult> => ({ ok: true, runs: [] }));
    await fleetTelemetry(
      { view: 'deploy', repo: OPTCG, ref: 'release/1.x' },
      { userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchRepoRuns, fetchRepoHead: async () => null },
    );
    expect(fetchRepoRuns).toHaveBeenCalledWith('tok', OPTCG, { perPage: 6, ref: 'release/1.x' });
  });

  it('an inaccessible repo is an ACCESS ERROR, never a silent empty run list', async () => {
    const out: any = await fleetTelemetry(
      { view: 'deploy', repo: 'canada-quant/private-not-yours' },
      {
        userId: 'owner', now: NOW,
        getGithubToken: async () => 'tok',
        fetchRepoRuns: async () => ({ ok: false, status: 404, message: 'HTTP 404 — the repo does not exist, or this connected GitHub account has no access to it (GitHub answers private repos you cannot read with 404)' }),
        fetchRepoHead: async () => null,
      },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('cannot read Actions runs for canada-quant/private-not-yours');
    expect(out.error).toContain('no access');
    expect(out.error).toContain('not "no runs"');
    expect(out.runs).toBeUndefined();
  });

  it('says so without a connected GitHub account', async () => {
    const out: any = await fleetTelemetry({ view: 'deploy', repo: OPTCG }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(out.ok).toBe(true);
    expect(out.github).toContain('no connected GitHub account');
  });

  it('an EMPTY run list is a real fact, said honestly (the optcg zero-workflows case)', async () => {
    const out: any = await fleetTelemetry(
      { view: 'deploy', repo: OPTCG },
      { userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchRepoRuns: async () => ({ ok: true, runs: [] }), fetchRepoHead: async () => ({ sha: 'abcd12340000000000000000000000000000ffff', committedAt: '', title: '' }) },
    );
    expect(out.ok).toBe(true);
    expect(out.runs).toEqual([]);
    expect(out.reading).toContain('No Actions runs found for this repo');
    expect(out.reading).toContain('verify the repo has Actions workflows at all');
  });

  it('an EXPLICIT framework-repo scope takes the repo-scoped path (repo-wide runs, no boxes) — not the default picture', async () => {
    // Self-audit gap: repo = the FRAMEWORK repo passed EXPLICITLY must not be
    // silently folded onto the default path — it is a scoped read like any
    // other, just aimed at DEPLOY_REPO (repo-wide runs incl. non-deploy
    // workflows, no box picture, default-path seams never fire).
    const fetchHead = jest.fn();
    const fetchRuns = jest.fn();
    const out: any = await fleetTelemetry(
      { view: 'deploy', repo: DEPLOY_REPO },
      {
        userId: 'owner', now: NOW,
        getGithubToken: async () => 'tok',
        fetchHead, fetchRuns,
        fetchRepoRuns: async (): Promise<RepoRunsResult> => ({ ok: true, runs: [mkRun({ id: 42, path: '.github/workflows/ci.yml', name: 'CI' })] }),
        fetchRepoHead: async () => ({ sha: 'abcd12340000000000000000000000000000ffff', committedAt: '', title: '' }),
      },
    );
    expect(out.ok).toBe(true);
    expect(out.repo).toBe(DEPLOY_REPO);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ id: 42, workflow: 'ci.yml' }); // repo-WIDE: a non-deploy workflow is visible
    expect(out.boxes).toBeUndefined(); // no box picture on ANY repo-scoped read, the framework repo included
    expect(fetchHead).not.toHaveBeenCalled();
    expect(fetchRuns).not.toHaveBeenCalled();
  });

  it('the DEFAULT (no repo) framework read is unchanged — framework repo, boxes, onMainHead', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-24T10:50:00Z'), meta: { host: 'box-a', process: 'web', sha: '834efb4e', diskPct: 10, diskFreeGb: 932.3, memFreePct: 47, load1: 0.1, upMin: 12 } },
    ]);
    const out: any = await fleetTelemetry(
      { view: 'deploy' },
      {
        userId: 'owner', now: NOW,
        getGithubToken: async () => 'tok',
        fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '', title: '' }),
        fetchRuns: async () => [],
      },
    );
    expect(out.repo).toBe(DEPLOY_REPO);
    expect(out.boxes).toHaveLength(1);
    expect(out.boxes[0]).toMatchObject({ host: 'box-a', onMainHead: true });
  });
});

describe('51ff7e93 · fetchers (URL construction + error discrimination)', () => {
  const fetchSpy = (status: number, body: any) => jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body } as any);
  afterEach(() => { jest.restoreAllMocks(); });

  it('fetchRepoActionRuns reads the REPO-WIDE Actions runs endpoint (not deploy.yml) with the branch filter', async () => {
    const spy = fetchSpy(200, { workflow_runs: [mkRun()] });
    const r = await fetchRepoActionRuns('tok', OPTCG, { perPage: 6, ref: 'main' });
    expect(r).toEqual({ ok: true, runs: [expect.objectContaining({ id: 35980000001 })] });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toBe(`https://api.github.com/repos/canada-quant/example-repo/actions/runs?per_page=6&branch=main`);
    expect(url).not.toContain('deploy.yml'); // a project repo may deploy through ANY workflow file
  });

  it('fetchRepoActionRuns discriminates 404 (access) and 403 from an empty list', async () => {
    fetchSpy(404, { message: 'Not Found' });
    const missing = await fetchRepoActionRuns('tok', 'canada-quant/does-not-exist', {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(404);
      expect(missing.message).toContain('no access');
    }
    fetchSpy(403, { message: 'rate limit' });
    const forbidden = await fetchRepoActionRuns('tok', OPTCG, {});
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.status).toBe(403);
  });

  it('fetchRepoActionRuns fails closed on network failure/timeout', async () => {
    jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('ECONNRESET'));
    const out = await fetchRepoActionRuns('tok', OPTCG, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('ECONNRESET');
  });

  it('fetchRepoHead reads the ref head commit and returns null on failure', async () => {
    fetchSpy(200, { sha: 'abcd1234ffff', commit: { committer: { date: '2026-09-24T09:38:00Z' }, message: 'publish deckpose.com (#12)\n\nbody' } });
    const head = await fetchRepoHead('tok', OPTCG, 'main');
    expect(head).toMatchObject({ sha: 'abcd1234ffff', committedAt: '2026-09-24T09:38:00Z', title: 'publish deckpose.com (#12)' });
    fetchSpy(404, { message: 'Not Found' });
    expect(await fetchRepoHead('tok', OPTCG, 'no-such-branch')).toBeNull();
  });
});

describe('51ff7e93 · readRepoDeployPicture', () => {
  it('names the in-flight / not-live-yet cases without a box picture', () => {
    const runs = [
      { id: 1, sha: 'bbbbbbbb', status: 'in_progress', conclusion: null, title: '', createdAt: '', updatedAt: '', url: '', workflow: 'publish.yml' },
      { id: 2, sha: 'aaaaaaaa', status: 'completed', conclusion: 'success', title: '', createdAt: '', updatedAt: '', url: '', workflow: 'publish.yml' },
    ];
    const text = readRepoDeployPicture(OPTCG, 'main', { sha: 'bbbbbbbb' }, runs as any);
    expect(text).toContain('canada-quant/example-repo main head is bbbbbbbb.');
    expect(text).toContain('1 Actions run(s) in flight (bbbbbbbb publish.yml in_progress)');
    expect(text).not.toContain('box-a');
  });

  it('flags a head with no successful run', () => {
    const runs = [
      { id: 1, sha: 'cccccccc', status: 'completed', conclusion: 'failure', title: '', createdAt: '', updatedAt: '', url: '', workflow: 'publish.yml' },
    ];
    const text = readRepoDeployPicture(OPTCG, 'main', { sha: 'cccccccc' }, runs as any);
    expect(text).toContain('No successful Actions run at all for canada-quant/example-repo');
    expect(text).toContain('main head cccccccc is NOT verified as deployed');
  });

  it('workflowName takes the workflow file basename', () => {
    expect(workflowName({ path: '.github/workflows/deploy-production.yml', name: 'Deploy' })).toBe('deploy-production.yml');
    expect(workflowName({ name: 'Deploy' })).toBe('Deploy');
    expect(workflowName(null)).toBe('unknown');
  });
});
