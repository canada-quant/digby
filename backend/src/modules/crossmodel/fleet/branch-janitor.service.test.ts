/**
 * Branch janitor (owner 2026-09-14) — unit tests with a routed fake GitHub
 * API + mocked Prisma/token boundaries. Pins: the delete rules (fully merged,
 * squash-merged/closed-PR lane, legacy per-session history mirror), every
 * NEVER rule (default/main, protected, open-PR head OR base, < 2 h tip,
 * non-framework prefix — always, even when fully merged (review 2026-09-14) —,
 * re-pushed after close), the per-pass deletion
 * cap, dry-run, the kill switch, 404 = already gone, rate-limit abort, repo
 * dedupe + token fallback, and the ONE loop_metrics row per repo per pass.
 *
 * Extended rules (2026-10-21, LLC1021): on the framework's OWN repo — fo/ +
 * state/ as framework prefixes (48 h floor), the docs-only repush rule, the
 * Claude-session (audit/ ops/ batch/ probe-) merged-or-ported rule, and ONE
 * archive commit + tag per repo per pass (required for the new deletes, best
 * effort for pr_merged / pr_closed). On every repo, the live-lane and
 * session-history keeps. A USER repo gets nothing else (review 2026-10-21).
 * The original rules suite runs under BRANCH_JANITOR_EXTENDED_RULES_DISABLED=1
 * and pins the byte-for-byte restore.
 *
 * Reviewed deletes (2026-10-22): the manifest on default turns the four
 * unprovable keeps into a 'reviewed' delete at the exact reviewed tip only.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockProjectFindMany: jest.Mock = jest.fn(async () => []);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<Array<{ id: string }>> => []);
const mockRunCount: jest.Mock = jest.fn(async () => 0);
const mockScheduleCount: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelProject: { findMany: (...a: any[]) => mockProjectFindMany(...a) },
    crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
    agentRun: { count: (...a: any[]) => mockRunCount(...a) },
    chatSchedule: { count: (...a: any[]) => mockScheduleCount(...a) },
  },
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockGetValidToken: jest.Mock = jest.fn(async (_userId: string): Promise<string | null> => 'TOK');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

jest.mock('../coding/session-history-sync.service', () => ({
  __esModule: true,
  LEGACY_SESSION_HISTORY_PREFIX: 'digby/session-history/',
  SESSION_HISTORY_BRANCH: 'digby/session-history',
}));

import logger from '../../../utils/logger';
import {
  runBranchJanitorOnce,
  sweepBranches,
  janitorRepo,
  branchJanitorExtendedRulesDisabled,
  parseGithubSlug,
  isFrameworkBranch,
  isLegacySessionHistoryBranch,
  encodeRef,
  BRANCH_JANITOR_INTERVAL_SEC,
  BRANCH_JANITOR_DISABLED_ENV,
  BRANCH_JANITOR_DRY_RUN_ENV,
  BRANCH_JANITOR_MAX_DELETIONS_PER_PASS,
  BRANCH_JANITOR_RECENT_MS,
  FRAMEWORK_BRANCH_PREFIXES,
  MACHINE_BRANCH_PREFIXES,
  BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV,
  BRANCH_JANITOR_EXTENDED_MIN_AGE_MS,
  BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET,
  MAX_PORT_CHECK_FILES,
  isMachineBranch,
  isDocsPath,
  isClaudeSessionBranch,
  archiveTagName,
  archiveCommitMessage,
  isExtendedPrefixBranch,
  isFrameworkOwnedRepo,
  laneId8Of,
  defaultLaneLive,
  parseReviewedDeletes,
  branchJanitorReviewedDeletesDisabled,
  BRANCH_JANITOR_REVIEWED_DELETES_PATH,
  MAX_REVIEWED_DELETE_ENTRIES,
  type JanitorGithubApi,
} from './branch-janitor.service';

const NOW = new Date('2026-09-14T16:00:00.000Z');
/** The fake's archive commit sha and the pass's ONE archive tag at NOW. */
const ARCHIVE_SHA = 'arc1234567890abcdef';
const ARCHIVE_TAG = 'archive/2026-09-14/branch-janitor-1600Z';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const BASE = 'https://api.github.com/repos/o/r';

interface Fixture {
  defaultBranch?: string;
  repoStatus?: number;
  branches: Array<{ name: string; sha: string; protected?: boolean }>;
  openHeads?: string[];
  /** Branches that are the BASE of an open PR (stacked PRs) — never deleted. */
  openBases?: string[];
  /** name → ahead_by (or 'ERR403' to simulate a rate limit on that compare) */
  aheadBy?: Record<string, number | 'ERR403'>;
  closedPrs?: Record<string, Array<{ merged_at?: string | null; closed_at: string; head?: { sha: string } }>>;
  /** sha → committer date */
  commitDates?: Record<string, string>;
  /** name → DELETE status (default 204) */
  deleteStatus?: Record<string, number>;
  /** name → `files` of compare <default>...<name> (extended port check) */
  compareFiles?: Record<string, any[]>;
  /** name → compare <PR head sha>...<name> answer (docs-repush rule); absent ⇒ 404 */
  repushCompare?: Record<string, { status: string; files: any[] }>;
  /** default's recursive tree (path → blob sha); 'truncated' ⇒ a truncated tree; absent ⇒ 404 */
  mainTree?: Record<string, string> | 'truncated';
  /** default's per-path contents fallback (path → blob sha); an absent path ⇒ 404 */
  mainContents?: Record<string, string>;
  /** tag name → POST git/refs status (default: 201, or 422 when the tag already exists) */
  tagPostStatus?: Record<string, number>;
  /** tag name → the `message` of a failed tag POST (e.g. a 403's rate-limit wording) */
  tagPostMessage?: Record<string, string>;
  /** GET commits/<default>: status (default 200) and tree sha (default 'tree-main') */
  defaultCommitStatus?: number;
  defaultTree?: string;
  /** POST git/commits (the archive commit): status (default 201), sha (default ARCHIVE_SHA), failure message */
  commitPostStatus?: number;
  commitPostMessage?: string;
  archiveCommitSha?: string;
  /** tag name → sha of a tag that ALREADY exists on the remote */
  existingTags?: Record<string, string>;
  /** Third review (2026-10-22): GET git/ref/heads/<branch> right before a deferred
   *  delete — branch → its CURRENT sha (a push during the pass), or an HTTP status.
   *  Default: the listing sha (the ref did not move); 404 for a branch not listed. */
  headsNow?: Record<string, string | number>;
  /** Fourth review (2026-10-22): PRs opened / reopened DURING the pass — seen by the
   *  per-branch open-PR re-read (head= / base= filtered GETs) but not by the
   *  pass-start listing; `openPrNowStatus` makes that re-read answer an HTTP status. */
  openHeadsNow?: string[];
  openBasesNow?: string[];
  openPrNowStatus?: Record<string, number>;
  /** Reviewed deletes (2026-10-22): the manifest on default — a document (served base64),
   *  a raw string body (served base64 as-is), or an HTTP status. Absent ⇒ 404. */
  reviewedManifest?: unknown;
  reviewedManifestRaw?: string;
  reviewedManifestStatus?: number;
}

type FakeApi = JanitorGithubApi & {
  deletes: string[];
  gets: string[];
  posts: Array<{ url: string; body: any }>;
  /** Every call in order ('GET <url>' / 'POST commit' / 'POST <tag>' / 'DELETE <branch>'). */
  calls: string[];
};

/** Routed fake of the GitHub REST surface the janitor touches. Routes on the
 *  path AFTER /repos/<owner>/<repo>, so one fake serves any repo slug. */
function mkApi(fx: Fixture): FakeApi {
  const deletes: string[] = [];
  const gets: string[] = [];
  const posts: Array<{ url: string; body: any }> = [];
  const calls: string[] = [];
  const tags: Record<string, string> = { ...(fx.existingTags ?? {}) };
  const nameFrom = (encoded: string) => decodeURIComponent(encoded);
  const tail = (url: string) => url.replace(/^https:\/\/api\.github\.com\/repos\/[^/?]+\/[^/?]+/, '');
  const pathFrom = (encoded: string) => encoded.split('/').map(decodeURIComponent).join('/');
  return {
    deletes, gets, posts, calls,
    async get(url: string) {
      gets.push(url);
      calls.push(`GET ${url}`);
      const rest = tail(url);
      if (rest === '') return { status: fx.repoStatus ?? 200, data: { default_branch: fx.defaultBranch ?? 'main' } };
      if (rest.startsWith('/branches?')) {
        return { status: 200, data: fx.branches.map(b => ({ name: b.name, commit: { sha: b.sha }, protected: b.protected === true })) };
      }
      const filtered = rest.match(/^\/pulls\?state=open&(head|base)=([^&]+)/);
      if (filtered) {
        const value = decodeURIComponent(filtered[2]);
        const branch = filtered[1] === 'head' ? value.replace(/^[^:]+:/, '') : value;
        const st = fx.openPrNowStatus?.[branch];
        if (st !== undefined) return { status: st, data: {} };
        const hit = filtered[1] === 'head'
          ? [...(fx.openHeads ?? []), ...(fx.openHeadsNow ?? [])].includes(branch)
          : [...(fx.openBases ?? []), ...(fx.openBasesNow ?? [])].includes(branch);
        return { status: 200, data: hit ? [{ number: 1 }] : [] };
      }
      if (rest.startsWith('/pulls?state=open')) {
        return { status: 200, data: [
          ...(fx.openHeads ?? []).map(h => ({ head: { ref: h }, base: { ref: fx.defaultBranch ?? 'main' } })),
          ...(fx.openBases ?? []).map(b => ({ head: { ref: `stack/on-${b}` }, base: { ref: b } })),
        ] };
      }
      if (rest.startsWith('/git/trees/')) {
        if (fx.mainTree === undefined) return { status: 404, data: {} };
        if (fx.mainTree === 'truncated') return { status: 200, data: { truncated: true, tree: [] } };
        return { status: 200, data: { truncated: false, tree: Object.entries(fx.mainTree).map(([path, sha]) => ({ path, sha, type: 'blob' })) } };
      }
      if (rest.startsWith('/contents/')) {
        const path = pathFrom(rest.slice('/contents/'.length).replace(/\?.*$/, ''));
        if (path === '.digby/branch-janitor/reviewed-deletes.json') {
          if (fx.reviewedManifestStatus !== undefined) return { status: fx.reviewedManifestStatus, data: {} };
          const body = fx.reviewedManifestRaw ?? (fx.reviewedManifest === undefined ? undefined : JSON.stringify(fx.reviewedManifest));
          if (body === undefined) return { status: 404, data: {} };
          // GitHub's contents API wraps the base64 body with a newline every 60 characters.
          const content = Buffer.from(body, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
          return { status: 200, data: { type: 'file', path, encoding: 'base64', content } };
        }
        const sha = fx.mainContents?.[path];
        return sha ? { status: 200, data: { type: 'file', path, sha } } : { status: 404, data: {} };
      }
      if (rest.startsWith('/git/ref/heads/')) {
        const name = pathFrom(rest.slice('/git/ref/heads/'.length));
        const now = fx.headsNow?.[name] ?? fx.branches.find(b => b.name === name)?.sha ?? 404;
        if (typeof now === 'number') return { status: now, data: {} };
        return { status: 200, data: { ref: `refs/heads/${name}`, object: { sha: now, type: 'commit' } } };
      }
      if (rest.startsWith('/git/ref/tags/')) {
        const tag = pathFrom(rest.slice('/git/ref/tags/'.length));
        return tags[tag] ? { status: 200, data: { ref: `refs/tags/${tag}`, object: { sha: tags[tag], type: 'commit' } } } : { status: 404, data: {} };
      }
      const cmp = url.match(/\/compare\/([^.]+)\.\.\.(.+)$/);
      if (cmp) {
        const name = nameFrom(cmp[2]);
        if (nameFrom(cmp[1]) !== (fx.defaultBranch ?? 'main')) {
          // compare <PR head sha>...<branch> (the docs-only repush rule)
          const since = fx.repushCompare?.[name];
          return since ? { status: 200, data: since } : { status: 404, data: {} };
        }
        const v = fx.aheadBy?.[name];
        if (v === 'ERR403') return { status: 403, data: { message: 'API rate limit exceeded' } };
        return { status: 200, data: { ahead_by: v ?? 1, ...(fx.compareFiles?.[name] ? { files: fx.compareFiles[name] } : {}) } };
      }
      const closed = url.match(/\/pulls\?state=closed&head=([^&]+)/);
      if (closed) {
        const name = decodeURIComponent(closed[1]).replace(/^[^:]+:/, ''); // head=<owner>:<branch>, any owner
        return { status: 200, data: fx.closedPrs?.[name] ?? [] };
      }
      const commit = url.match(/\/commits\/([^/]+)$/);
      if (commit && decodeURIComponent(commit[1]) === (fx.defaultBranch ?? 'main')) {
        // The archive commit's tree: default's head.
        const status = fx.defaultCommitStatus ?? 200;
        return status === 200 ? { status, data: { commit: { tree: { sha: fx.defaultTree ?? 'tree-main' } } } } : { status, data: {} };
      }
      if (commit) {
        const date = fx.commitDates?.[decodeURIComponent(commit[1])];
        return date ? { status: 200, data: { commit: { committer: { date } } } } : { status: 404, data: {} };
      }
      throw new Error(`unrouted GET ${url}`);
    },
    async delete(url: string) {
      deletes.push(url);
      const m = url.match(/\/git\/refs\/heads\/(.+)$/);
      const name = m ? nameFrom(m[1]) : '';
      calls.push(`DELETE ${name}`);
      return { status: fx.deleteStatus?.[name] ?? 204, data: {} };
    },
    async post(url: string, body: any) {
      posts.push({ url, body });
      if (url.endsWith('/git/commits')) {
        calls.push('POST commit');
        const status = fx.commitPostStatus ?? 201;
        return status === 201 ? { status, data: { sha: fx.archiveCommitSha ?? ARCHIVE_SHA } } : { status, data: { message: fx.commitPostMessage ?? '' } };
      }
      if (!url.endsWith('/git/refs')) throw new Error(`unrouted POST ${url}`);
      const tag = String(body?.ref ?? '').replace(/^refs\/tags\//, '');
      calls.push(`POST ${tag}`);
      const status = fx.tagPostStatus?.[tag] ?? (tags[tag] ? 422 : 201);
      if (status === 201) tags[tag] = String(body?.sha ?? '');
      return { status, data: { message: fx.tagPostMessage?.[tag] ?? '' } };
    },
  };
}

/** The canonical fixture — one branch per rule. */
function canonicalFixture(): Fixture {
  return {
    branches: [
      { name: 'main', sha: 'sha-main' },
      { name: 'release', sha: 'sha-release', protected: true },
      { name: 'digby/open-lane', sha: 'sha-open' },
      { name: 'digby/merged-fully', sha: 'sha-mf' },
      { name: 'digby/squashed', sha: 'sha-sq' },
      { name: 'fix/closed-unmerged', sha: 'sha-cu' },
      { name: 'claude/repushed', sha: 'sha-rp' },
      { name: 'codex/active', sha: 'sha-act' },
      { name: 'feat/recent', sha: 'sha-rec' },
      { name: 'digby/session-history/abc', sha: 'sha-leg' },
      { name: 'digby/session-history/hot', sha: 'sha-leghot' },
      { name: 'experiment/foo', sha: 'sha-exp' },
      { name: 'experiment/merged', sha: 'sha-expm' },
      { name: 'digby/session-history', sha: 'sha-cons' },
    ],
    openHeads: ['digby/open-lane'],
    aheadBy: {
      'digby/merged-fully': 0, 'digby/squashed': 2, 'fix/closed-unmerged': 1, 'claude/repushed': 1,
      'codex/active': 3, 'feat/recent': 0, 'experiment/foo': 2, 'experiment/merged': 0, 'digby/session-history': 5,
    },
    closedPrs: {
      'digby/squashed': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }],
      'fix/closed-unmerged': [{ merged_at: null, closed_at: hoursAgo(6) }],
      'claude/repushed': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }],
    },
    commitDates: {
      'sha-mf': hoursAgo(3), 'sha-sq': hoursAgo(7), 'sha-cu': hoursAgo(8), 'sha-rp': hoursAgo(5),
      'sha-rec': hoursAgo(0.5), 'sha-leg': hoursAgo(5), 'sha-leghot': hoursAgo(0.2), 'sha-expm': hoursAgo(30),
    },
  };
}

// SELF_REPO / DIGBY_INSTANCE decide isFrameworkOwnedRepo — cleared so the box's env never leaks in.
const ENV_KEYS = [BRANCH_JANITOR_DISABLED_ENV, BRANCH_JANITOR_DRY_RUN_ENV, BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV, 'SELF_REPO', 'DIGBY_INSTANCE'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('TOK');
  mockProjectFindMany.mockResolvedValue([{ id: 'p1', userId: 'u1', repoUrl: 'https://github.com/o/r.git', defaultBranch: 'main' }]);
  mockChatFindMany.mockResolvedValue([]);
  mockRunCount.mockResolvedValue(0);
  mockScheduleCount.mockResolvedValue(0);
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('pure helpers', () => {
  it('exports the hourly cadence, the 50-per-pass cap, the 2 h recency window and the framework prefixes', () => {
    expect(BRANCH_JANITOR_INTERVAL_SEC).toBe(3600);
    expect(BRANCH_JANITOR_MAX_DELETIONS_PER_PASS).toBe(50);
    expect(BRANCH_JANITOR_RECENT_MS).toBe(2 * 60 * 60 * 1000);
    expect([...FRAMEWORK_BRANCH_PREFIXES]).toEqual(['digby/', 'cursor/', 'codex/', 'claude/', 'fix/', 'feat/', 'feature/']);
  });

  it('parseGithubSlug handles https/.git/ssh shapes and rejects non-GitHub URLs', () => {
    expect(parseGithubSlug('https://github.com/example-org/crossmodel.git')).toEqual({ owner: 'example-org', repo: 'crossmodel' });
    expect(parseGithubSlug('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubSlug('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubSlug('https://gitlab.com/o/r')).toBeNull();
    expect(parseGithubSlug(null)).toBeNull();
  });

  it('isFrameworkBranch / isLegacySessionHistoryBranch / encodeRef', () => {
    expect(isFrameworkBranch('digby/x')).toBe(true);
    expect(isFrameworkBranch('feature/x')).toBe(true);
    expect(isFrameworkBranch('experiment/x')).toBe(false);
    expect(isLegacySessionHistoryBranch('digby/session-history/abc')).toBe(true);
    expect(isLegacySessionHistoryBranch('digby/session-history')).toBe(false);        // the consolidated branch
    expect(isLegacySessionHistoryBranch('digby/session-history/a/b')).toBe(false);    // not the per-session shape
    expect(encodeRef('feat/a b#c')).toBe('feat/a%20b%23c');
  });
});

describe('janitorRepo — the rules (BRANCH_JANITOR_EXTENDED_RULES_DISABLED=1: the pre-2026-10-21 set, byte-for-byte)', () => {
  beforeEach(() => { process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = '1'; });

  it('deletes fully-merged, squash-merged, closed-PR and legacy-history branches; keeps default/protected/open-PR/recent/active/re-pushed/foreign — and records ONE branch_janitor row', async () => {
    const api = mkApi(canonicalFixture());
    const budget = { remaining: BRANCH_JANITOR_MAX_DELETIONS_PER_PASS };

    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget });

    // Review 2026-09-14 BLOCKER: `experiment/merged` (foreign prefix, ahead_by 0,
    // 30 h old) is NOT deleted — a user's develop/staging that momentarily equals
    // main is never the janitor's business. Foreign prefixes are kept outright.
    expect(api.deletes.sort()).toEqual([
      `${BASE}/git/refs/heads/digby/merged-fully`,
      `${BASE}/git/refs/heads/digby/session-history/abc`,
      `${BASE}/git/refs/heads/digby/squashed`,
      `${BASE}/git/refs/heads/fix/closed-unmerged`,
    ].sort());
    expect(r.scanned).toBe(14);
    expect(r.deleted).toBe(4);
    expect(r.kept).toBe(10);
    expect(r.failed).toBe(0);
    // feat/recent (ahead_by 0, human prefix, no PR) is kept_active now: the bare
    // "fully merged" rule applies to MACHINE prefixes only (EOD review 2026-09-14).
    expect(r.reasons).toEqual({
      merged: 1, pr_merged: 1, pr_closed: 1, legacy_session_history: 1,
      kept_default: 1, kept_protected: 1, kept_open_pr: 1, kept_recent: 1, kept_repushed: 1,
      kept_active: 3, kept_foreign_prefix: 2,
    });
    expect(budget.remaining).toBe(BRANCH_JANITOR_MAX_DELETIONS_PER_PASS - 4);
    // The legacy mirror never needs a compare call; a foreign-prefix branch
    // costs NO API call at all (neither compare nor closed-PR lookup).
    expect(api.gets.some(u => u.includes('/compare/main...digby/session-history/abc'))).toBe(false);
    expect(api.gets.some(u => u.includes('experiment'))).toBe(false);
    // Default/protected/open-PR branches cost no API calls at all.
    for (const n of ['main', 'release', 'digby/open-lane']) {
      expect(api.gets.some(u => u.includes(`...${n}`) || u.includes(encodeURIComponent(`o:${n}`)))).toBe(false);
    }
    // =1: no archive tag is ever created, no lane lookup runs, and the
    // consolidated history branch is judged by the ordinary rules (kept_active).
    expect(api.posts).toEqual([]);
    expect(mockChatFindMany).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'branch_janitor', value: 4, unit: 'branches',
      meta: {
        repo: 'o/r', scanned: 14, deleted: 4,
        deletedBranches: ['digby/merged-fully', 'digby/squashed', 'fix/closed-unmerged', 'digby/session-history/abc'],
        kept: 10, reasons: r.reasons, dryRun: false, failed: 0, alreadyGone: 0,
      },
    });
  });

  it('human prefixes (fix/ feat/ feature/) are deleted ONLY through the PR-closed rule — a fully-merged feat/ branch with no PR stays (EOD review 2026-09-14)', async () => {
    const api = mkApi({
      branches: [{ name: 'feat/human-merged', sha: 'hm' }, { name: 'feat/pr-merged', sha: 'pm' }, { name: 'claude/machine-merged', sha: 'mm' }],
      aheadBy: { 'feat/human-merged': 0, 'feat/pr-merged': 0, 'claude/machine-merged': 0 },
      closedPrs: { 'feat/pr-merged': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }] },
      commitDates: { hm: hoursAgo(40), pm: hoursAgo(8), mm: hoursAgo(9) },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes.sort()).toEqual([`${BASE}/git/refs/heads/claude/machine-merged`, `${BASE}/git/refs/heads/feat/pr-merged`].sort());
    expect(r.reasons).toEqual({ merged: 1, pr_merged: 1, kept_active: 1 });
  });

  it('a branch that is the BASE of an open (stacked) PR is kept even when fully merged and old — and costs no API call (review 2026-09-14)', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/stack-base', sha: 'sb' }, { name: 'digby/gone', sha: 'g' }],
      openBases: ['digby/stack-base'],
      aheadBy: { 'digby/stack-base': 0, 'digby/gone': 0 },
      commitDates: { sb: hoursAgo(30), g: hoursAgo(30) },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes).toEqual([`${BASE}/git/refs/heads/digby/gone`]);
    expect(r.reasons).toEqual({ merged: 1, kept_open_pr_base: 1 });
    expect(api.gets.some(u => u.includes('stack-base'))).toBe(false);
  });

  it('never deletes "main"/"master" even when the API names another default; a missing default falls back to the project setting', async () => {
    const api = mkApi({
      defaultBranch: 'trunk',
      branches: [{ name: 'main', sha: 'a' }, { name: 'master', sha: 'b' }, { name: 'trunk', sha: 'c' }],
      aheadBy: { main: 0, master: 0 },
      commitDates: { a: hoursAgo(50), b: hoursAgo(50) },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes).toEqual([]);
    expect(r.reasons).toEqual({ kept_default: 3 });
  });

  it('the recency guard applies to EVERY delete reason — a legacy mirror pushed 10 minutes ago survives', async () => {
    const api = mkApi({
      branches: [{ name: 'main', sha: 'm' }, { name: 'digby/session-history/hot', sha: 'h' }, { name: 'digby/done', sha: 'd' }],
      aheadBy: { 'digby/done': 0 },
      commitDates: { h: hoursAgo(0.1), d: hoursAgo(1.9) },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes).toEqual([]);
    expect(r.reasons).toEqual({ kept_default: 1, kept_recent: 2 });
  });

  it('an unreadable tip date is conservative (kept_unknown_age) — never a delete on a guess', async () => {
    const api = mkApi({ branches: [{ name: 'digby/x', sha: 'nodate' }], aheadBy: { 'digby/x': 0 } });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes).toEqual([]);
    expect(r.reasons).toEqual({ kept_unknown_age: 1 });
  });

  it('the per-pass deletion cap is shared across repos: budget exhausted ⇒ kept_cap, nothing else is called', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/a', sha: 'a' }, { name: 'digby/b', sha: 'b' }, { name: 'digby/c', sha: 'c' }],
      aheadBy: { 'digby/a': 0, 'digby/b': 0, 'digby/c': 0 },
      commitDates: { a: hoursAgo(9), b: hoursAgo(9), c: hoursAgo(9) },
    });
    const budget = { remaining: 2 };
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget });
    expect(api.deletes).toHaveLength(2);
    expect(r.deleted).toBe(2);
    expect(r.reasons).toEqual({ merged: 2, kept_cap: 1 });
    expect(budget.remaining).toBe(0);
  });

  it('DRY RUN: nothing is deleted, every would-be deletion is logged + counted under its reason, the metric carries dryRun:true and deleted 0', async () => {
    const api = mkApi(canonicalFixture());
    const budget = { remaining: 50 };
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: true, budget });
    expect(api.deletes).toEqual([]);
    expect(r.deleted).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(r.reasons.kept_dry_run).toBe(4);
    expect(r.reasons.merged).toBe(1);
    expect(r.reasons.legacy_session_history).toBe(1);
    expect(budget.remaining).toBe(50);
    expect((logger.info as jest.Mock).mock.calls.filter(c => String(c[0]).includes('[dry-run]: would delete'))).toHaveLength(4);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'branch_janitor', value: 0, meta: expect.objectContaining({ dryRun: true, deleted: 0 }),
    }));
  });

  it('a 404/422 on DELETE is "already gone" (GitHub or a lane got there first), any other status is a counted failure — neither aborts the scan', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/a', sha: 'a' }, { name: 'digby/b', sha: 'b' }, { name: 'digby/c', sha: 'c' }],
      aheadBy: { 'digby/a': 0, 'digby/b': 0, 'digby/c': 0 },
      commitDates: { a: hoursAgo(9), b: hoursAgo(9), c: hoursAgo(9) },
      deleteStatus: { 'digby/a': 404, 'digby/b': 500 },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(api.deletes).toHaveLength(3);
    expect(r.alreadyGone).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.deleted).toBe(1);
    expect(r.aborted).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('delete o/r:digby/b answered 500'));
  });

  it('a 403/429 mid-scan ABORTS that repo for this pass (recorded, metric still lands) — deletions so far stand', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/a', sha: 'a' }, { name: 'digby/b', sha: 'b' }, { name: 'digby/c', sha: 'c' }],
      aheadBy: { 'digby/a': 0, 'digby/b': 'ERR403', 'digby/c': 0 },
      commitDates: { a: hoursAgo(9), c: hoursAgo(9) },
    });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(r.deleted).toBe(1);
    expect(r.aborted).toBe('rate_limited_403');
    expect(api.deletes).toEqual([`${BASE}/git/refs/heads/digby/a`]);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'branch_janitor', meta: expect.objectContaining({ aborted: 'rate_limited_403', deleted: 1 }),
    }));
  });

  it('an unreadable repo (404) aborts before any listing', async () => {
    const api = mkApi({ repoStatus: 404, branches: [] });
    const r = await janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 } });
    expect(r.aborted).toBe('repo unreadable (404)');
    expect(api.gets).toEqual([BASE]);
  });
});

describe('sweepBranches / runBranchJanitorOnce', () => {
  it('discovers live GitHub projects, dedupes by owner/repo, authenticates with the project owner token, and sums the per-repo results', async () => {
    mockProjectFindMany.mockResolvedValue([
      { id: 'p1', userId: 'u1', repoUrl: 'https://github.com/o/r.git', defaultBranch: 'main' },
      { id: 'p2', userId: 'u2', repoUrl: 'https://github.com/O/R', defaultBranch: 'main' }, // same repo, different case/suffix
    ]);
    const apis: Array<ReturnType<typeof mkApi>> = [];
    const apiFactory = (token: string) => { expect(token).toBe('TOK'); const a = mkApi(canonicalFixture()); apis.push(a); return a; };

    const r = await sweepBranches({ now: NOW, apiFactory });

    expect(mockProjectFindMany).toHaveBeenCalledWith({
      where: { repoProvider: 'github', repoUrl: { not: null }, archivedAt: null },
      select: { id: true, userId: true, repoUrl: true, defaultBranch: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(apis).toHaveLength(1); // deduped
    expect(mockGetValidToken).toHaveBeenCalledTimes(1);
    expect(mockGetValidToken).toHaveBeenCalledWith('u1');
    expect(r).toMatchObject({ disabled: false, dryRun: false, repos: 1, noToken: 0, scanned: 14, deleted: 4, kept: 10, failed: 0 });
    expect(r.perRepo[0].repo).toBe('o/r');
  });

  it('falls back to the NEXT owner token when the first project owner has no GitHub connection; a repo with no token at all is skipped (counted, no API calls)', async () => {
    mockProjectFindMany.mockResolvedValue([
      { id: 'p1', userId: 'u1', repoUrl: 'https://github.com/o/r', defaultBranch: 'main' },
      { id: 'p2', userId: 'u2', repoUrl: 'https://github.com/o/r', defaultBranch: 'main' },
      { id: 'p3', userId: 'u3', repoUrl: 'https://github.com/o/other', defaultBranch: 'main' },
    ]);
    mockGetValidToken.mockImplementation(async (userId: string) => (userId === 'u2' ? 'TOK2' : null));
    const tokens: string[] = [];
    const apiFactory = (token: string) => { tokens.push(token); return mkApi({ branches: [] }); };

    const r = await sweepBranches({ now: NOW, apiFactory });

    expect(tokens).toEqual(['TOK2']);
    expect(r.repos).toBe(1);
    expect(r.noToken).toBe(1);
  });

  it('BRANCH_JANITOR_DISABLED=1: the sweep is a no-op (no DB, no API) and the cron entry reports "disabled"', async () => {
    process.env[BRANCH_JANITOR_DISABLED_ENV] = '1';
    const apiFactory = jest.fn();
    const r = await sweepBranches({ now: NOW, apiFactory });
    expect(r.disabled).toBe(true);
    expect(mockProjectFindMany).not.toHaveBeenCalled();
    expect(apiFactory).not.toHaveBeenCalled();
    await expect(runBranchJanitorOnce({ now: NOW, apiFactory })).resolves.toBe('disabled');
  });

  it('BRANCH_JANITOR_DRY_RUN=1 flows through the sweep: no deletes, summary tagged (dry-run)', async () => {
    process.env[BRANCH_JANITOR_DRY_RUN_ENV] = '1';
    const api = mkApi(canonicalFixture());
    const summary = await runBranchJanitorOnce({ now: NOW, apiFactory: () => api });
    expect(api.deletes).toEqual([]);
    expect(summary).toBe('repos 1, scanned 14, deleted 0, kept 14 (dry-run)');
  });

  it('runBranchJanitorOnce returns the one-line summary and never throws (project discovery failure included)', async () => {
    const api = mkApi(canonicalFixture());
    await expect(runBranchJanitorOnce({ now: NOW, apiFactory: () => api })).resolves.toBe('repos 1, scanned 14, deleted 4, kept 10');
    expect(logger.info).toHaveBeenCalledWith('branch-janitor: repos 1, scanned 14, deleted 4, kept 10');

    mockProjectFindMany.mockRejectedValue(new Error('db down'));
    await expect(runBranchJanitorOnce({ now: NOW, apiFactory: () => api })).resolves.toBe('repos 0, scanned 0, deleted 0, kept 0');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('project discovery failed'));
  });

  it('the 50-deletion cap is enforced ACROSS repos in one pass', async () => {
    mockProjectFindMany.mockResolvedValue([
      { id: 'p1', userId: 'u1', repoUrl: 'https://github.com/o/r', defaultBranch: 'main' },
      { id: 'p2', userId: 'u1', repoUrl: 'https://github.com/o/r2', defaultBranch: 'main' },
    ]);
    const mergedRepo = (n: number, prefix: string) => {
      const branches = Array.from({ length: n }, (_, i) => ({ name: `digby/${prefix}${i}`, sha: `${prefix}${i}` }));
      const fx: Fixture = { branches, aheadBy: {}, commitDates: {} };
      for (const b of branches) { fx.aheadBy![b.name] = 0; fx.commitDates![b.sha] = hoursAgo(9); }
      return fx;
    };
    const made: Array<ReturnType<typeof mkApi>> = [];
    // One fake per repo (the fake routes on the path tail, so o/r2 is served too).
    const apiFactory = () => { const a = mkApi(made.length === 0 ? mergedRepo(40, 'a') : mergedRepo(40, 'b')); made.push(a); return a; };
    const r = await sweepBranches({ now: NOW, apiFactory });
    expect(r.deleted).toBe(BRANCH_JANITOR_MAX_DELETIONS_PER_PASS);
    expect(made[0].deletes).toHaveLength(40);
    expect(made[1].deletes).toHaveLength(10);
    expect(r.perRepo[1].reasons.kept_cap).toBe(30);
  });
});

// ── Extended rules (2026-10-21, LLC1021) ─────────────────────────────────────

const ref = (branch: string) => `${BASE}/git/refs/heads/${branch}`;
/** The framework's own repo is the default for this suite (the rules' home). */
const run = (api: FakeApi, extra: Partial<Parameters<typeof janitorRepo>[0]> = {}) =>
  janitorRepo({ api, owner: 'o', repo: 'r', now: NOW, dryRun: false, budget: { remaining: 50 }, frameworkOwned: true, ...extra });
/** The pass's archive writes: the commit POST body and the tag POST bodies. */
const archiveCommitPosts = (api: FakeApi) => api.posts.filter(p => p.url.endsWith('/git/commits')).map(p => p.body);
const tagPosts = (api: FakeApi) => api.posts.filter(p => p.url.endsWith('/git/refs')).map(p => p.body);
const writes = (api: FakeApi) => api.calls.filter(c => !c.startsWith('GET'));

describe('extended rules — pure helpers', () => {
  it('pins the new constants and keeps the exported prefix lists unchanged', () => {
    expect(BRANCH_JANITOR_EXTENDED_MIN_AGE_MS).toBe(48 * 60 * 60 * 1000);
    expect(MAX_PORT_CHECK_FILES).toBe(40);
    expect(BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET).toBe(300);
    expect([...MACHINE_BRANCH_PREFIXES]).toEqual(['digby/', 'cursor/', 'codex/', 'claude/']);
  });

  it('fo/ and state/ are framework AND machine branches only on the framework\'s own repo, and only while the extended rules are on', () => {
    for (const n of ['fo/f120', 'state/fo-firing-55']) {
      expect(isFrameworkBranch(n, true)).toBe(true);
      expect(isMachineBranch(n, true)).toBe(true);
      // A user repo (the default): fo/ and state/ are foreign (review 2026-10-21).
      expect(isFrameworkBranch(n)).toBe(false);
      expect(isMachineBranch(n)).toBe(false);
    }
    process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = '1';
    expect(isFrameworkBranch('fo/f120', true)).toBe(false);
    expect(isMachineBranch('state/fo-firing-55', true)).toBe(false);
    expect(isMachineBranch('digby/x')).toBe(true);
  });

  it('isDocsPath: .digby/**, memory-bank/**, docs/** and any *.md — nothing else', () => {
    for (const p of ['.digby/rules/00-current-state.md', '.digby/config.json', 'memory-bank/crossmodel-progress.md', 'docs/a.txt', 'AGENTS.md', 'backend/README.MD']) {
      expect(isDocsPath(p)).toBe(true);
    }
    for (const p of ['backend/src/a.ts', 'frontend/docs/x.ts', 'scripts/memory-bank/x.sh', 'md', '']) {
      expect(isDocsPath(p)).toBe(false);
    }
  });

  it('isClaudeSessionBranch / isExtendedPrefixBranch / archiveTagName / archiveCommitMessage / laneId8Of', () => {
    for (const n of ['audit/turn-plan-canary', 'ops/iso-census-1012', 'batch/20261019T0435Z', 'probe-h-4f7263e4']) {
      expect(isClaudeSessionBranch(n)).toBe(true);
      expect(isExtendedPrefixBranch(n)).toBe(true);
    }
    for (const n of ['auditx/y', 'probe/x', 'digby/probe-c0b2b0c8', 'experiment/foo']) expect(isClaudeSessionBranch(n)).toBe(false);
    expect(isExtendedPrefixBranch('fo/f120')).toBe(true);
    expect(isExtendedPrefixBranch('state/x')).toBe(true);
    for (const n of ['digby/x', 'fix/y', 'feature/z', 'experiment/foo']) expect(isExtendedPrefixBranch(n)).toBe(false);
    // ONE tag per pass, under the repo's archive/<date>/ folder (the manual sweep's shape).
    expect(archiveTagName(new Date('2026-09-27T23:59:00Z'))).toBe('archive/2026-09-27/branch-janitor-2359Z');
    expect(archiveTagName(new Date('2026-10-22T00:01:30Z'))).toBe('archive/2026-10-22/branch-janitor-0001Z');
    const msg = archiveCommitMessage([{ name: 'fo/f106/v2', sha: 'aaa111', reason: 'merged' }, { name: 'audit/x', sha: 'bbb222', reason: 'ported' }], NOW);
    expect(msg.split('\n')[0]).toBe('branch-janitor archive 2026-09-14T16:00Z: 2 branch tip(s)');
    expect(msg).toContain('Restore one: git push origin <sha>:refs/heads/<branch>');
    expect(msg).toContain('\nfo/f106/v2 aaa111 (merged)\naudit/x bbb222 (ported)');
    expect(laneId8Of('digby/session-0a1b2c3d')).toBe('0a1b2c3d');
    for (const n of ['digby/session-history', 'digby/session-history/0a1b2c3d', 'digby/session-0A1B2C3D', 'digby/session-0a1b2c3d-x', 'digby/state-0b97b061-run2']) {
      expect(laneId8Of(n)).toBeNull();
    }
  });

  it('isFrameworkOwnedRepo: the instance\'s own repo (SELF_REPO; the platform repo on prod) — never a user repo, never prod from a non-prod instance', () => {
    // Prod, SELF_REPO unset: the platform repo, any spelling.
    expect(isFrameworkOwnedRepo('example-org/crossmodel', {})).toBe(true);
    expect(isFrameworkOwnedRepo('example-org/crossmodel', {})).toBe(true);
    expect(isFrameworkOwnedRepo('https://github.com/example-org/crossmodel.git', {})).toBe(true);
    expect(isFrameworkOwnedRepo('someuser/their-app', {})).toBe(false);
    expect(isFrameworkOwnedRepo('o/r', {})).toBe(false);
    expect(isFrameworkOwnedRepo('', {})).toBe(false);
    // SELF_REPO names the instance's own repo.
    expect(isFrameworkOwnedRepo('acme/digby-fork', { SELF_REPO: 'https://github.com/acme/digby-fork' })).toBe(true);
    expect(isFrameworkOwnedRepo('example-org/crossmodel', { SELF_REPO: 'acme/digby-fork' })).toBe(false);
    // A non-prod instance: its SELF_REPO only; unset or the prod repo ⇒ owns nothing.
    expect(isFrameworkOwnedRepo('acme/digby-fork', { DIGBY_INSTANCE: 'selfhost', SELF_REPO: 'acme/digby-fork' })).toBe(true);
    expect(isFrameworkOwnedRepo('example-org/crossmodel', { DIGBY_INSTANCE: 'selfhost' })).toBe(false);
    expect(isFrameworkOwnedRepo('example-org/crossmodel', { DIGBY_INSTANCE: 'selfhost', SELF_REPO: 'example-org/crossmodel' })).toBe(false);
  });

  it('defaultLaneLive: an unarchived chat with a queued/running/interrupted run or an enabled schedule is live; an error is live (fail closed)', async () => {
    await expect(defaultLaneLive('0a1b2c3d')).resolves.toBe(false); // no chat
    expect(mockChatFindMany).toHaveBeenCalledWith({ where: { id: { startsWith: '0a1b2c3d' }, archivedAt: null }, select: { id: true }, take: 5 });
    expect(mockRunCount).not.toHaveBeenCalled();

    mockChatFindMany.mockResolvedValue([{ id: '0a1b2c3d-1111' }]);
    await expect(defaultLaneLive('0a1b2c3d')).resolves.toBe(false); // idle, nothing scheduled
    expect(mockRunCount).toHaveBeenCalledWith({ where: { sessionId: { in: ['0a1b2c3d-1111'] }, status: { in: ['queued', 'running', 'interrupted'] } } });
    expect(mockScheduleCount).toHaveBeenCalledWith({ where: { sessionId: { in: ['0a1b2c3d-1111'] }, enabled: true } });

    mockRunCount.mockResolvedValueOnce(1);
    await expect(defaultLaneLive('0a1b2c3d')).resolves.toBe(true);
    mockScheduleCount.mockResolvedValueOnce(1);
    await expect(defaultLaneLive('0a1b2c3d')).resolves.toBe(true);
    mockChatFindMany.mockRejectedValueOnce(new Error('db down'));
    await expect(defaultLaneLive('0a1b2c3d')).resolves.toBe(true);
  });
});

describe('janitorRepo — extended rules on the framework\'s own repo', () => {
  it('fo/ and state/ follow the digby/ rules with a 48 h floor: merged / pr_merged go into the archive (required); a 3 h state/ branch equal to main is kept_young', async () => {
    const api = mkApi({
      branches: [
        { name: 'fo/iter48', sha: 'fo1' }, { name: 'state/fo-firing-55', sha: 'st1' }, { name: 'fo/active', sha: 'fo2' },
        { name: 'fo/hot', sha: 'fo3' }, { name: 'state/prod', sha: 'st2' },
      ],
      aheadBy: { 'fo/iter48': 0, 'state/fo-firing-55': 2, 'fo/active': 3, 'fo/hot': 0, 'state/prod': 0 },
      closedPrs: { 'state/fo-firing-55': [{ merged_at: hoursAgo(70), closed_at: hoursAgo(70), head: { sha: 'st1' } }] },
      commitDates: { fo1: hoursAgo(72), st1: hoursAgo(71), fo3: hoursAgo(1), st2: hoursAgo(3) },
    });
    const r = await run(api);
    expect(api.deletes.sort()).toEqual([ref('fo/iter48'), ref('state/fo-firing-55')].sort());
    expect(r.reasons).toEqual({ merged: 1, pr_merged: 1, kept_active: 1, kept_recent: 1, kept_young: 1 });
    // ONE archive commit holds both tips — 'merged' included (it is an extended-rule delete).
    expect(archiveCommitPosts(api)).toEqual([expect.objectContaining({ tree: 'tree-main', parents: ['fo1', 'st1'] })]);
    expect(tagPosts(api)).toEqual([{ ref: `refs/tags/${ARCHIVE_TAG}`, sha: ARCHIVE_SHA }]);
    expect(r.archiveTag).toBe(ARCHIVE_TAG);
    expect(r.archivedTips).toEqual([{ branch: 'fo/iter48', sha: 'fo1' }, { branch: 'state/fo-firing-55', sha: 'st1' }]);
  });

  it('DOCS-ONLY REPUSH ≥ 48 h: deleted as pr_closed_docs_repush — archived FIRST, then deleted; the metric carries the tag and the tip', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/learnings', sha: 'tip1' }],
      aheadBy: { 'digby/learnings': 3 },
      closedPrs: { 'digby/learnings': [
        { merged_at: hoursAgo(80), closed_at: hoursAgo(80), head: { sha: 'old-head' } },
        { merged_at: hoursAgo(60), closed_at: hoursAgo(60), head: { sha: 'pr-head' } },
      ] },
      commitDates: { tip1: hoursAgo(50) }, // re-pushed AFTER the last close (60 h ago)
      repushCompare: { 'digby/learnings': { status: 'ahead', files: [
        { filename: 'memory-bank/crossmodel-progress.md', status: 'modified' },
        { filename: '.digby/rules/00-current-state.md', status: 'modified' },
        { filename: 'docs/notes.txt', status: 'added' },
        { filename: 'AGENTS.md', status: 'modified' },
      ] } },
    });
    const r = await run(api);
    // The repush diff is read from the head of the LATEST-closed PR.
    expect(api.gets).toContain(`${BASE}/compare/pr-head...digby/learnings`);
    expect(r.reasons).toEqual({ pr_closed_docs_repush: 1 });
    expect(r.deletedBranches).toEqual(['digby/learnings']);
    expect(writes(api)).toEqual(['POST commit', `POST ${ARCHIVE_TAG}`, 'DELETE digby/learnings']);
    expect(api.gets).toContain(`${BASE}/commits/main`); // the archive commit's tree
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'branch_janitor', value: 1,
      meta: expect.objectContaining({
        ownRepo: true, archiveTag: ARCHIVE_TAG, archivedTips: [{ branch: 'digby/learnings', sha: 'tip1' }], reasons: { pr_closed_docs_repush: 1 },
      }),
    }));
  });

  it('COMPARE-AND-SWAP (third review 2026-10-22): a deferred delete re-reads its ref right before the DELETE — a ref a lane pushed to during the pass is kept_moved (its new commits are in neither the branch nor the archive), a ref that vanished is alreadyGone, an unreadable ref is kept; an unmoved one is deleted', async () => {
    const docsRepush = (name: string, tip: string) => ({
      aheadBy: { [name]: 3 },
      closedPrs: { [name]: [{ merged_at: hoursAgo(60), closed_at: hoursAgo(60), head: { sha: `pr-${tip}` } }] },
      commitDates: { [tip]: hoursAgo(50) },
      repushCompare: { [name]: { status: 'ahead', files: [{ filename: 'memory-bank/crossmodel-progress.md', status: 'modified' }] } },
    });
    const parts = [docsRepush('digby/still', 't-still'), docsRepush('digby/pushed', 't-pushed'), docsRepush('digby/vanished', 't-van'), docsRepush('digby/unreadable', 't-unr')];
    const merge = (k: string) => Object.assign({}, ...parts.map((x: any) => x[k]));
    const api = mkApi({
      branches: [{ name: 'digby/still', sha: 't-still' }, { name: 'digby/pushed', sha: 't-pushed' }, { name: 'digby/vanished', sha: 't-van' }, { name: 'digby/unreadable', sha: 't-unr' }],
      aheadBy: merge('aheadBy'), closedPrs: merge('closedPrs'), commitDates: merge('commitDates'), repushCompare: merge('repushCompare'),
      headsNow: { 'digby/pushed': 't-pushed-NEW', 'digby/vanished': 404, 'digby/unreadable': 500 },
    });
    const r = await run(api);
    // All four went into the ONE archive (their LISTING tips) …
    expect(archiveCommitPosts(api)[0].parents.sort()).toEqual(['t-pushed', 't-still', 't-unr', 't-van']);
    // … but only the unmoved ref is deleted, and every delete is preceded by its own ref read.
    expect(writes(api)).toEqual(['POST commit', `POST ${ARCHIVE_TAG}`, 'DELETE digby/still']);
    const stillRead = api.calls.indexOf(`GET ${BASE}/git/ref/heads/digby/still`);
    expect(stillRead).toBeGreaterThan(api.calls.indexOf(`POST ${ARCHIVE_TAG}`));
    expect(stillRead).toBeLessThan(api.calls.indexOf('DELETE digby/still'));
    expect(r.deletedBranches).toEqual(['digby/still']);
    expect(r.reasons).toMatchObject({ pr_closed_docs_repush: 1, kept_moved: 2 });
    expect(r.alreadyGone).toBe(1);
  });

  it('COMPARE-AND-SWAP (fourth review 2026-10-22): a deferred delete re-reads the OPEN-PR state of its branch — a PR reopened on it during the pass (no push: the ref CAS reads same) is kept_open_pr, a PR stacked onto it is kept_open_pr_base, an unreadable re-read is kept; a quiet one is deleted', async () => {
    const docsRepush = (name: string, tip: string) => ({
      aheadBy: { [name]: 3 },
      closedPrs: { [name]: [{ merged_at: hoursAgo(60), closed_at: hoursAgo(60), head: { sha: `pr-${tip}` } }] },
      commitDates: { [tip]: hoursAgo(50) },
      repushCompare: { [name]: { status: 'ahead', files: [{ filename: 'memory-bank/crossmodel-progress.md', status: 'modified' }] } },
    });
    const parts = [docsRepush('digby/quiet', 't-q'), docsRepush('digby/reopened', 't-r'), docsRepush('digby/stacked', 't-s'), docsRepush('digby/unread', 't-u')];
    const merge = (k: string) => Object.assign({}, ...parts.map((x: any) => x[k]));
    const api = mkApi({
      branches: [{ name: 'digby/quiet', sha: 't-q' }, { name: 'digby/reopened', sha: 't-r' }, { name: 'digby/stacked', sha: 't-s' }, { name: 'digby/unread', sha: 't-u' }],
      aheadBy: merge('aheadBy'), closedPrs: merge('closedPrs'), commitDates: merge('commitDates'), repushCompare: merge('repushCompare'),
      openHeadsNow: ['digby/reopened'], openBasesNow: ['digby/stacked'], openPrNowStatus: { 'digby/unread': 502 },
    });
    const r = await run(api);
    expect(writes(api)).toEqual(['POST commit', `POST ${ARCHIVE_TAG}`, 'DELETE digby/quiet']);
    expect(r.deletedBranches).toEqual(['digby/quiet']);
    expect(r.reasons).toMatchObject({ pr_closed_docs_repush: 1, kept_open_pr: 2, kept_open_pr_base: 1 });
    // the re-read sits between the ref CAS and the DELETE
    const quietPr = api.calls.indexOf(`GET ${BASE}/pulls?state=open&head=${encodeURIComponent('o:digby/quiet')}&per_page=1`);
    expect(quietPr).toBeGreaterThan(api.calls.indexOf(`GET ${BASE}/git/ref/heads/digby/quiet`));
    expect(quietPr).toBeLessThan(api.calls.indexOf('DELETE digby/quiet'));
  });

  it('the extended-rules switch reads like every other switch of the 2026-10-21 wave: "1", "true" and "on" all restore the pre-2026-10-21 rules (third review 2026-10-22)', () => {
    for (const v of ['1', 'true', 'TRUE', ' on ']) {
      process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = v;
      expect(branchJanitorExtendedRulesDisabled()).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off']) {
      process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = v;
      expect(branchJanitorExtendedRulesDisabled()).toBe(false);
    }
    delete process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV];
  });

  it('a docs-only repush younger than 48 h is kept_young; a code repush, a non-ahead repush, a code→doc rename and an unreadable repush diff stay kept_repushed', async () => {
    const prs = (h: number) => [{ merged_at: hoursAgo(h), closed_at: hoursAgo(h), head: { sha: 'pr-head' } }];
    const api = mkApi({
      branches: [
        { name: 'digby/young-docs', sha: 'y' }, { name: 'digby/code', sha: 'c' }, { name: 'digby/diverged', sha: 'd' },
        { name: 'digby/renamed', sha: 'rn' }, { name: 'digby/no-diff', sha: 'nd' }, { name: 'digby/empty', sha: 'e' },
      ],
      aheadBy: { 'digby/young-docs': 1, 'digby/code': 1, 'digby/diverged': 1, 'digby/renamed': 1, 'digby/no-diff': 1, 'digby/empty': 1 },
      closedPrs: { 'digby/young-docs': prs(40), 'digby/code': prs(80), 'digby/diverged': prs(80), 'digby/renamed': prs(80), 'digby/no-diff': prs(80), 'digby/empty': prs(80) },
      commitDates: { y: hoursAgo(30), c: hoursAgo(70), d: hoursAgo(70), rn: hoursAgo(70), nd: hoursAgo(70), e: hoursAgo(70) },
      repushCompare: {
        'digby/young-docs': { status: 'ahead', files: [{ filename: 'memory-bank/x.md', status: 'modified' }] },
        'digby/code': { status: 'ahead', files: [{ filename: 'docs/a.md', status: 'modified' }, { filename: 'backend/src/a.ts', status: 'modified' }] },
        'digby/diverged': { status: 'diverged', files: [{ filename: 'docs/a.md', status: 'modified' }] },
        'digby/renamed': { status: 'ahead', files: [{ filename: 'docs/moved.md', previous_filename: 'backend/src/moved.ts', status: 'renamed' }] },
        'digby/empty': { status: 'ahead', files: [] },
      },
    });
    const r = await run(api);
    expect(api.deletes).toEqual([]);
    expect(api.posts).toEqual([]);
    expect(r.reasons).toEqual({ kept_young: 1, kept_repushed: 5 });
    expect(r.archiveTag).toBeUndefined(); // nothing to archive ⇒ no archive attempted
  });

  it('Claude-session prefixes (audit/ ops/ batch/ probe-): merged ⇒ deleted after the archive (required — nothing else keeps the sha); < 48 h ⇒ kept_young before any compare; other foreign prefixes cost no call', async () => {
    const api = mkApi({
      branches: [
        { name: 'audit/turn-plan-replay', sha: 'a1' }, { name: 'ops/iso-census-1012', sha: 'o1' },
        { name: 'batch/20261019T0435Z', sha: 'b1' }, { name: 'probe-h-4f7263e4', sha: 'p1' },
        { name: 'audit/fresh', sha: 'a2' }, { name: 'experiment/foo', sha: 'x1' },
      ],
      aheadBy: { 'audit/turn-plan-replay': 0, 'ops/iso-census-1012': 0, 'batch/20261019T0435Z': 0, 'probe-h-4f7263e4': 0, 'audit/fresh': 0 },
      commitDates: { a1: hoursAgo(72), o1: hoursAgo(49), b1: hoursAgo(60), p1: hoursAgo(300), a2: hoursAgo(30) },
    });
    const r = await run(api);
    expect(api.deletes.sort()).toEqual([ref('audit/turn-plan-replay'), ref('ops/iso-census-1012'), ref('batch/20261019T0435Z'), ref('probe-h-4f7263e4')].sort());
    expect(r.reasons).toEqual({ merged: 4, kept_young: 1, kept_foreign_prefix: 1 });
    expect(archiveCommitPosts(api)).toEqual([expect.objectContaining({ parents: ['a1', 'o1', 'b1', 'p1'] })]);
    expect(tagPosts(api)).toHaveLength(1);
    expect(api.gets.some(u => u.includes('/compare/') && u.includes('audit/fresh'))).toBe(false);
    expect(api.gets.some(u => u.includes('experiment'))).toBe(false);
  });

  it('PORTED via the tree map: every non-doc change is on default with the same blob (removed ⇒ gone, renamed ⇒ new path equal + old path gone) — ONE tree read per repo pass, archived, deleted', async () => {
    const files = [
      { filename: 'backend/src/a.ts', status: 'modified', sha: 'blob-a' },
      { filename: 'docs/notes.md', status: 'added', sha: 'never-on-main' }, // docs are ignored
      { filename: 'old.ts', status: 'removed', sha: 'blob-old' },
      { filename: 'new.ts', previous_filename: 'gone.ts', status: 'renamed', sha: 'blob-n' },
    ];
    const api = mkApi({
      branches: [{ name: 'audit/ported-1', sha: 'p1' }, { name: 'ops/ported-2', sha: 'p2' }],
      aheadBy: { 'audit/ported-1': 2, 'ops/ported-2': 1 },
      compareFiles: { 'audit/ported-1': files, 'ops/ported-2': [{ filename: 'backend/src/a.ts', status: 'added', sha: 'blob-a' }] },
      commitDates: { p1: hoursAgo(72), p2: hoursAgo(72) },
      mainTree: { 'backend/src/a.ts': 'blob-a', 'new.ts': 'blob-n', 'README.md': 'r' },
    });
    const r = await run(api);
    expect(r.reasons).toEqual({ ported: 2 });
    expect(api.deletes.sort()).toEqual([ref('audit/ported-1'), ref('ops/ported-2')].sort());
    expect(r.archivedTips).toEqual([{ branch: 'audit/ported-1', sha: 'p1' }, { branch: 'ops/ported-2', sha: 'p2' }]);
    expect(api.gets.filter(u => u.includes('/git/trees/'))).toEqual([`${BASE}/git/trees/main?recursive=1`]);
    expect(api.gets.some(u => u.includes('/contents/'))).toBe(false);
  });

  it('a Claude-session branch that changed ONLY docs is ported (nothing to compare) — still archived first, so its tip stays reachable', async () => {
    const api = mkApi({
      branches: [{ name: 'audit/report-only', sha: 'r' }],
      aheadBy: { 'audit/report-only': 1 },
      compareFiles: { 'audit/report-only': [{ filename: 'docs/AUDIT_2026-10-03.md', status: 'added', sha: 'blob-r' }] },
      commitDates: { r: hoursAgo(72) },
      mainTree: { 'README.md': 'x' },
    });
    const r = await run(api);
    expect(r.reasons).toEqual({ ported: 1 });
    expect(writes(api)).toEqual(['POST commit', `POST ${ARCHIVE_TAG}`, 'DELETE audit/report-only']);
    expect(api.gets.some(u => u.includes('/git/trees/'))).toBe(false); // no code file ⇒ default's tree never read
  });

  it('PORTED via the contents fallback when the tree is truncated — each read spends the pass-wide port-call budget', async () => {
    const api = mkApi({
      branches: [{ name: 'audit/x', sha: 'x' }],
      aheadBy: { 'audit/x': 1 },
      compareFiles: { 'audit/x': [{ filename: 'src/a b.ts', status: 'modified', sha: 'blob-a' }, { filename: 'src/gone.ts', status: 'removed' }] },
      commitDates: { x: hoursAgo(72) },
      mainTree: 'truncated',
      mainContents: { 'src/a b.ts': 'blob-a' },
    });
    const budget: { remaining: number; portCalls?: number } = { remaining: 50 };
    const r = await run(api, { budget });
    expect(r.reasons).toEqual({ ported: 1 });
    expect(api.gets).toContain(`${BASE}/contents/src/a%20b.ts?ref=main`);
    expect(api.gets).toContain(`${BASE}/contents/src/gone.ts?ref=main`);
    expect(budget.portCalls).toBe(BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET - 2);
    expect(budget.remaining).toBe(49);
  });

  it('one mismatched blob ⇒ kept_unported; a removed file still on default or a rename whose old path is still on default ⇒ kept_unported — never archived, never deleted', async () => {
    const api = mkApi({
      branches: [{ name: 'audit/mismatch', sha: 'm' }, { name: 'audit/removed', sha: 'rm' }, { name: 'audit/renamed', sha: 'rn' }, { name: 'audit/missing', sha: 'ms' }],
      aheadBy: { 'audit/mismatch': 1, 'audit/removed': 1, 'audit/renamed': 1, 'audit/missing': 1 },
      compareFiles: {
        'audit/mismatch': [{ filename: 'a.ts', status: 'modified', sha: 'blob-a' }, { filename: 'b.ts', status: 'modified', sha: 'blob-b-NEW' }],
        'audit/removed': [{ filename: 'old.ts', status: 'removed' }],
        'audit/renamed': [{ filename: 'new.ts', previous_filename: 'a.ts', status: 'renamed', sha: 'blob-n' }],
        'audit/missing': [{ filename: 'scratch/probe.py', status: 'added', sha: 'blob-p' }],
      },
      commitDates: { m: hoursAgo(72), rm: hoursAgo(72), rn: hoursAgo(72), ms: hoursAgo(72) },
      mainTree: { 'a.ts': 'blob-a', 'b.ts': 'blob-b', 'old.ts': 'blob-old', 'new.ts': 'blob-n' },
    });
    const r = await run(api);
    expect(r.reasons).toEqual({ kept_unported: 4 });
    expect(api.posts).toEqual([]);
    expect(api.deletes).toEqual([]);
  });

  it('kept_port_unverified: > 40 non-doc files, a 300-file (possibly cut) diff, no files at all, or a spent contents budget', async () => {
    const many = Array.from({ length: MAX_PORT_CHECK_FILES + 1 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', sha: `b${i}` }));
    const cut = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/f${i}.md`, status: 'modified', sha: `d${i}` }));
    const api = mkApi({
      branches: [{ name: 'audit/many', sha: 'm' }, { name: 'audit/cut', sha: 'c' }, { name: 'audit/nofiles', sha: 'n' }, { name: 'audit/budget', sha: 'b' }],
      aheadBy: { 'audit/many': 1, 'audit/cut': 1, 'audit/nofiles': 1, 'audit/budget': 1 },
      compareFiles: { 'audit/many': many, 'audit/cut': cut, 'audit/budget': [{ filename: 'src/a.ts', status: 'modified', sha: 'blob-a' }] },
      commitDates: { m: hoursAgo(72), c: hoursAgo(72), n: hoursAgo(72), b: hoursAgo(72) },
      mainTree: 'truncated',
      mainContents: { 'src/a.ts': 'blob-a' },
    });
    const r = await run(api, { budget: { remaining: 50, portCalls: 0 } });
    expect(r.reasons).toEqual({ kept_port_unverified: 4 });
    // No per-file contents read (the budget is spent); the reviewed-deletes manifest read is not a port check.
    expect(api.gets.some(u => u.includes('/contents/') && !u.includes('reviewed-deletes'))).toBe(false);
    expect(api.deletes).toEqual([]);
  });

  it('ONE archive per repo per pass (review 2026-10-21): a single commit whose parents are every archived tip (deduped), default\'s tree, ONE tag — old-rule merged and legacy deletes stay outside it and go first', async () => {
    const api = mkApi({
      branches: [
        { name: 'digby/sq-a', sha: 'tipA' }, { name: 'fix/closed', sha: 'tipB' }, { name: 'digby/merged', sha: 'tipM' },
        { name: 'digby/session-history/abc', sha: 'tipL' }, { name: 'fo/done', sha: 'tipF' }, { name: 'state/same-tip', sha: 'tipF' },
        { name: 'digby/sq-zero', sha: 'tipZ' },
      ],
      aheadBy: { 'digby/sq-a': 2, 'fix/closed': 1, 'digby/merged': 0, 'fo/done': 0, 'state/same-tip': 0, 'digby/sq-zero': 0 },
      closedPrs: {
        'digby/sq-a': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }],
        'fix/closed': [{ merged_at: null, closed_at: hoursAgo(6) }],
      },
      commitDates: { tipA: hoursAgo(7), tipB: hoursAgo(7), tipM: hoursAgo(9), tipL: hoursAgo(9), tipF: hoursAgo(60), tipZ: hoursAgo(9) },
      defaultTree: 'tree-of-main-head',
    });
    const r = await run(api);
    expect(r.deleted).toBe(7);
    // Inline (no archive) deletes run during the scan; the archived ones after the ONE archive.
    expect(writes(api)).toEqual([
      'DELETE digby/merged', 'DELETE digby/session-history/abc', 'DELETE digby/sq-zero',
      'POST commit', `POST ${ARCHIVE_TAG}`,
      'DELETE digby/sq-a', 'DELETE fix/closed', 'DELETE fo/done', 'DELETE state/same-tip',
    ]);
    const [commit] = archiveCommitPosts(api);
    expect(commit.tree).toBe('tree-of-main-head');
    expect(commit.parents).toEqual(['tipA', 'tipB', 'tipF']); // the shared fo/ + state/ tip once
    expect(commit.message).toContain('\ndigby/sq-a tipA (pr_merged)\nfix/closed tipB (pr_closed)\nfo/done tipF (merged)\nstate/same-tip tipF (merged)');
    expect(tagPosts(api)).toEqual([{ ref: `refs/tags/${ARCHIVE_TAG}`, sha: ARCHIVE_SHA }]);
    expect(r.archivedTips?.map(t => t.branch)).toEqual(['digby/sq-a', 'fix/closed', 'fo/done', 'state/same-tip']);
    expect(r.reasons).toEqual({ merged: 4, legacy_session_history: 1, pr_merged: 1, pr_closed: 1 });
  });

  it('a deterministically failed archive (tag 422 + tag unreadable) never blocks an old-rule delete: the squash-merged lane goes untagged as pr_merged, the ported branch is kept_archive_failed, the metric names the failure', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/session-aaaabbbb', sha: 'lane-tip' }, { name: 'audit/ported', sha: 'port-tip' }],
      aheadBy: { 'digby/session-aaaabbbb': 2, 'audit/ported': 1 },
      closedPrs: { 'digby/session-aaaabbbb': [{ merged_at: hoursAgo(72), closed_at: hoursAgo(72) }] },
      compareFiles: { 'audit/ported': [{ filename: 'a.ts', status: 'modified', sha: 'blob-a' }] },
      commitDates: { 'lane-tip': hoursAgo(73), 'port-tip': hoursAgo(72) },
      mainTree: { 'a.ts': 'blob-a' },
      tagPostStatus: { [ARCHIVE_TAG]: 422 }, // a tag ruleset: 422, and GET of the tag answers 404
    });
    const budget = { remaining: 50 };
    const r = await run(api, { budget, laneLive: async () => false });
    expect(api.deletes).toEqual([ref('digby/session-aaaabbbb')]);
    expect(r.reasons).toEqual({ pr_merged: 1, kept_archive_failed: 1 });
    expect(r.kept).toBe(1);
    expect(budget.remaining).toBe(49);
    expect(r.archiveTag).toBeNull();
    expect(r.archiveFailed).toBe('exists_unreadable_404');
    expect(r.archivedTips).toBeUndefined();
    expect(r.aborted).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('branch-janitor: archive for o/r failed (exists_unreadable_404) — 1 branch(es) kept, 1 old-rule delete(s) go ahead untagged');
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toEqual(expect.objectContaining({ archiveTag: null, archiveFailed: 'exists_unreadable_404' }));
  });

  it.each([
    ['the archive commit POST answers 500', { commitPostStatus: 500 }, 'commit_500'],
    ['the archive commit POST answers a permission 403 (not a rate limit)', { commitPostStatus: 403, commitPostMessage: 'Resource not accessible by integration' }, 'commit_403'],
    ['default\'s head commit is unreadable', { defaultCommitStatus: 404 }, 'tree_unreadable_404'],
    ['the tag POST answers a ruleset 403', { tagPostStatus: { [ARCHIVE_TAG]: 403 }, tagPostMessage: { [ARCHIVE_TAG]: 'Repository rule violations found' } }, 'post_403'],
  ] as Array<[string, Partial<Fixture>, string]>)('%s ⇒ a failed archive, never an abort: old-rule deletes go ahead, required ones are kept', async (_label, extra, why) => {
    const api = mkApi({
      branches: [{ name: 'digby/sq', sha: 's' }, { name: 'fo/old', sha: 'f' }],
      aheadBy: { 'digby/sq': 2, 'fo/old': 0 },
      closedPrs: { 'digby/sq': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }] },
      commitDates: { s: hoursAgo(7), f: hoursAgo(60) },
      ...extra,
    });
    const r = await run(api);
    expect(r.aborted).toBeUndefined();
    expect(api.deletes).toEqual([ref('digby/sq')]);
    expect(r.reasons).toEqual({ pr_merged: 1, kept_archive_failed: 1 });
    expect(r.archiveFailed).toBe(why);
  });

  it('422 on the archive tag: a name held by ANOTHER commit ⇒ ONE retry with the archive commit\'s -<sha7>; a failed retry is a failed archive', async () => {
    const fx = (existing: Record<string, string>): Fixture => ({
      branches: [{ name: 'fo/done', sha: 'f' }],
      aheadBy: { 'fo/done': 0 },
      commitDates: { f: hoursAgo(60) },
      existingTags: existing,
    });
    const retried = mkApi(fx({ [ARCHIVE_TAG]: 'an-earlier-archive' }));
    const r1 = await run(retried);
    expect(tagPosts(retried).map(b => b.ref)).toEqual([`refs/tags/${ARCHIVE_TAG}`, `refs/tags/${ARCHIVE_TAG}-arc1234`]);
    expect(r1.archiveTag).toBe(`${ARCHIVE_TAG}-arc1234`);
    expect(retried.deletes).toEqual([ref('fo/done')]);

    const both = mkApi(fx({ [ARCHIVE_TAG]: 'an-earlier-archive', [`${ARCHIVE_TAG}-arc1234`]: 'another-one' }));
    const r2 = await run(both);
    expect(r2.archiveFailed).toBe('retry_other');
    expect(r2.reasons).toEqual({ kept_archive_failed: 1 });
    expect(both.deletes).toEqual([]);
  });

  it.each([
    ['a 429 on the archive commit POST', { commitPostStatus: 429 }, 'rate_limited_429'],
    ['a rate-limit 403 on the tag POST', { tagPostStatus: { [ARCHIVE_TAG]: 403 }, tagPostMessage: { [ARCHIVE_TAG]: 'API rate limit exceeded for user ID 1' } }, 'rate_limited_403'],
  ] as Array<[string, Partial<Fixture>, string]>)('%s aborts the repo like a GET rate limit — the scan\'s inline deletes stand, nothing archived is deleted', async (_label, extra, aborted) => {
    const api = mkApi({
      branches: [{ name: 'digby/sq', sha: 's' }, { name: 'digby/merged', sha: 'm' }],
      aheadBy: { 'digby/sq': 2, 'digby/merged': 0 },
      closedPrs: { 'digby/sq': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }] },
      commitDates: { s: hoursAgo(7), m: hoursAgo(7) },
      ...extra,
    });
    const r = await run(api);
    expect(r.aborted).toBe(aborted);
    expect(api.deletes).toEqual([ref('digby/merged')]);
  });

  it('a LIVE digby/session-<id8> lane is kept before any compare; an idle one follows the rules; a throwing probe counts as live', async () => {
    const probed: string[] = [];
    const laneLive = async (id8: string) => {
      probed.push(id8);
      if (id8 === 'deadbeef') throw new Error('probe down');
      return id8 === '0a1b2c3d';
    };
    const api = mkApi({
      branches: [{ name: 'digby/session-0a1b2c3d', sha: 'live' }, { name: 'digby/session-11112222', sha: 'idle' }, { name: 'digby/session-deadbeef', sha: 'err' }],
      aheadBy: { 'digby/session-0a1b2c3d': 0, 'digby/session-11112222': 0, 'digby/session-deadbeef': 0 },
      commitDates: { live: hoursAgo(30), idle: hoursAgo(30), err: hoursAgo(30) },
    });
    const r = await run(api, { laneLive });
    expect(probed).toEqual(['0a1b2c3d', '11112222', 'deadbeef']);
    expect(api.deletes).toEqual([ref('digby/session-11112222')]);
    expect(r.reasons).toEqual({ merged: 1, kept_live_lane: 2 });
    expect(api.gets.some(u => u.includes('session-0a1b2c3d'))).toBe(false);
    expect(api.gets.some(u => u.includes('session-deadbeef'))).toBe(false);
  });

  it('digby/session-history (the consolidated history branch) is kept outright with no API call; a legacy mirror is still deleted with no compare and no archive', async () => {
    const api = mkApi({
      branches: [{ name: 'digby/session-history', sha: 'cons' }, { name: 'digby/session-history/abc', sha: 'leg' }],
      aheadBy: { 'digby/session-history': 0 },
      commitDates: { cons: hoursAgo(100), leg: hoursAgo(5) },
    });
    const laneLive = jest.fn(async () => false);
    const r = await run(api, { laneLive });
    expect(r.reasons).toEqual({ kept_session_history: 1, legacy_session_history: 1 });
    expect(api.deletes).toEqual([ref('digby/session-history/abc')]);
    expect(api.posts).toEqual([]);
    expect(laneLive).not.toHaveBeenCalled();
    expect(api.gets.some(u => u.includes('/compare/'))).toBe(false);
    expect(api.gets.some(u => u.includes('/commits/cons'))).toBe(false);
  });

  it('DRY RUN: never POSTs or deletes — logs "would archive" for every archived rule and "would delete" for every deletion', async () => {
    const api = mkApi({
      branches: [{ name: 'audit/ported', sha: 'p1234567890' }, { name: 'digby/merged', sha: 'm' }],
      aheadBy: { 'audit/ported': 1, 'digby/merged': 0 },
      compareFiles: { 'audit/ported': [{ filename: 'a.ts', status: 'modified', sha: 'blob-a' }] },
      commitDates: { p1234567890: hoursAgo(72), m: hoursAgo(9) },
      mainTree: { 'a.ts': 'blob-a' },
    });
    const r = await run(api, { dryRun: true });
    expect(api.posts).toEqual([]);
    expect(api.deletes).toEqual([]);
    expect(r.reasons).toEqual({ ported: 1, merged: 1, kept_dry_run: 2 });
    const infos = (logger.info as jest.Mock).mock.calls.map(c => String(c[0]));
    expect(infos.filter(l => l.includes('[dry-run]: would archive'))).toEqual([`branch-janitor[dry-run]: would archive o/r:audit/ported@p123456 in ${ARCHIVE_TAG} (required)`]);
    expect(infos.filter(l => l.includes('[dry-run]: would delete'))).toHaveLength(2);
  });

  it('the per-pass deletion cap still holds: an archived delete holds its share of the cap, a capped branch is never in the archive', async () => {
    const api = mkApi({
      branches: ['a', 'b', 'c'].map(x => ({ name: `digby/sq-${x}`, sha: x })),
      aheadBy: { 'digby/sq-a': 1, 'digby/sq-b': 1, 'digby/sq-c': 1 },
      closedPrs: Object.fromEntries(['a', 'b', 'c'].map(x => [`digby/sq-${x}`, [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6) }]])),
      commitDates: { a: hoursAgo(7), b: hoursAgo(7), c: hoursAgo(7) },
    });
    const budget = { remaining: 2 };
    const r = await run(api, { budget });
    expect(archiveCommitPosts(api)).toEqual([expect.objectContaining({ parents: ['a', 'b'] })]);
    expect(api.deletes).toHaveLength(2);
    expect(r.reasons).toEqual({ pr_merged: 2, kept_cap: 1 });
    expect(budget.remaining).toBe(0);
  });

  it('BRANCH_JANITOR_EXTENDED_RULES_DISABLED=1: fo/ audit/ probe- are foreign again (no API call), docs repush is kept_repushed, no lane probe, no archive, no new metric keys', async () => {
    process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = '1';
    const laneLive = jest.fn(async () => true);
    const api = mkApi({
      branches: [
        { name: 'fo/iter48', sha: 'f' }, { name: 'audit/x', sha: 'a' }, { name: 'probe-h-1', sha: 'p' },
        { name: 'digby/session-0a1b2c3d', sha: 'l' }, { name: 'digby/learnings', sha: 'd' },
      ],
      aheadBy: { 'fo/iter48': 0, 'audit/x': 0, 'probe-h-1': 0, 'digby/session-0a1b2c3d': 0, 'digby/learnings': 1 },
      closedPrs: { 'digby/learnings': [{ merged_at: hoursAgo(60), closed_at: hoursAgo(60), head: { sha: 'pr-head' } }] },
      commitDates: { l: hoursAgo(9), d: hoursAgo(50) },
      repushCompare: { 'digby/learnings': { status: 'ahead', files: [{ filename: 'memory-bank/x.md', status: 'modified' }] } },
    });
    const r = await run(api, { laneLive }); // frameworkOwned: true is ignored under =1
    expect(r.reasons).toEqual({ kept_foreign_prefix: 3, merged: 1, kept_repushed: 1 });
    expect(api.deletes).toEqual([ref('digby/session-0a1b2c3d')]);
    expect(laneLive).not.toHaveBeenCalled();
    expect(api.posts).toEqual([]);
    expect(api.gets.some(u => u.includes('/compare/pr-head'))).toBe(false);
    expect(r.ownRepo).toBeUndefined();
    expect(r.archiveTag).toBeUndefined();
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    for (const k of ['ownRepo', 'archiveTag', 'archivedTips', 'archiveFailed']) expect(Object.keys(meta)).not.toContain(k);
  });
});

describe('reviewed deletes (2026-10-22): the manifest on default clears branches the rules can only keep', () => {
  const sha40 = (c: string) => c.repeat(40).slice(0, 40);
  const ACT = sha40('a'); const RP = sha40('b'); const UNP = sha40('c'); const STALE = sha40('d'); const NAMED_NOT = sha40('e');
  const MANIFEST_URL = `${BASE}/contents/.digby/branch-janitor/reviewed-deletes.json?ref=main`;
  /** One branch per keep the manifest can clear, all old enough, plus a stale and an unnamed one. */
  const reviewFixture = (manifest: unknown = {
    entries: [
      { branch: 'digby/session-aaaaaaaa', sha: ACT, verdict: 'landed' },
      { branch: 'digby/session-bbbbbbbb', sha: RP, verdict: 'superseded' },
      { branch: 'audit/scratch', sha: UNP, verdict: 'scratch' },
      { branch: 'digby/stale', sha: sha40('f'), verdict: 'landed' }, // reviewed at an OLDER tip
    ],
  }): Fixture => ({
    branches: [
      { name: 'digby/session-aaaaaaaa', sha: ACT }, // no PR, ahead ⇒ kept_active
      { name: 'digby/session-bbbbbbbb', sha: RP }, // code repush after its PR ⇒ kept_repushed
      { name: 'audit/scratch', sha: UNP }, // Claude-session, unported ⇒ kept_unported
      { name: 'digby/stale', sha: STALE }, // no PR, named at another sha ⇒ kept_review_stale
      { name: 'digby/unnamed', sha: NAMED_NOT }, // no PR, not in the manifest ⇒ kept_active
    ],
    aheadBy: { 'digby/session-aaaaaaaa': 2, 'digby/session-bbbbbbbb': 3, 'audit/scratch': 1, 'digby/stale': 1, 'digby/unnamed': 1 },
    closedPrs: { 'digby/session-bbbbbbbb': [{ merged_at: hoursAgo(300), closed_at: hoursAgo(300), head: { sha: 'pr-head' } }] },
    repushCompare: { 'digby/session-bbbbbbbb': { status: 'ahead', files: [{ filename: 'backend/src/x.ts', status: 'modified' }] } },
    compareFiles: { 'audit/scratch': [{ filename: 'scripts/ec2-ops/playbook.sh', status: 'modified', sha: 'blob-branch' }] },
    mainTree: { 'scripts/ec2-ops/playbook.sh': 'blob-main' },
    commitDates: { [ACT]: hoursAgo(400), [RP]: hoursAgo(200), [UNP]: hoursAgo(300), [STALE]: hoursAgo(100), [NAMED_NOT]: hoursAgo(100) },
    reviewedManifest: manifest,
  });
  const ENV = 'BRANCH_JANITOR_REVIEWED_DELETES_DISABLED';
  let savedReviewEnv: string | undefined;
  beforeEach(() => { savedReviewEnv = process.env[ENV]; delete process.env[ENV]; });
  afterEach(() => { if (savedReviewEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedReviewEnv; });

  it('parseReviewedDeletes: full 40-hex shas only, trimmed non-empty names, several shas per branch, null without an entries array', () => {
    const m = parseReviewedDeletes({ entries: [
      { branch: 'digby/a', sha: ACT }, { branch: 'digby/a', sha: RP }, // two reviewed tips of one branch
      { branch: 'digby/short', sha: 'abc1234' }, { branch: 'digby/upper', sha: ACT.toUpperCase() },
      { branch: ' digby/padded', sha: ACT }, { branch: '', sha: ACT }, { sha: ACT }, null, 'digby/x',
    ] });
    expect(m).not.toBeNull();
    expect([...m!.keys()]).toEqual(['digby/a']);
    expect([...m!.get('digby/a')!]).toEqual([ACT, RP]);
    expect(parseReviewedDeletes({})).toBeNull();
    expect(parseReviewedDeletes([])).toBeNull();
    expect(parseReviewedDeletes(null)).toBeNull();
    expect(parseReviewedDeletes({ entries: [] })!.size).toBe(0);
    const many = { entries: Array.from({ length: MAX_REVIEWED_DELETE_ENTRIES + 5 }, (_, i) => ({ branch: `digby/b${i}`, sha: ACT })) };
    expect(parseReviewedDeletes(many)!.size).toBe(MAX_REVIEWED_DELETE_ENTRIES);
    expect(BRANCH_JANITOR_REVIEWED_DELETES_PATH).toBe('.digby/branch-janitor/reviewed-deletes.json');
  });

  it('the SHIPPED manifest (.digby/branch-janitor/reviewed-deletes.json) parses whole: every entry kept, full 40-hex shas, no branch listed twice', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const file = path.resolve(__dirname, '../../../../..', BRANCH_JANITOR_REVIEWED_DELETES_PATH);
    if (!fs.existsSync(file)) return; // a checkout without the manifest (it is optional)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = parseReviewedDeletes(doc);
    expect(m).not.toBeNull();
    const names = doc.entries.map((e: { branch: string }) => e.branch);
    expect(new Set(names).size).toBe(names.length);
    expect(m!.size).toBe(doc.entries.length); // nothing silently dropped by the parser
    for (const e of doc.entries) expect(e.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('kept_active / kept_repushed / kept_unported branches named AT THEIR TIP are deleted as reviewed — archived first (required), the manifest read ONCE; a moved tip is kept_review_stale; an unnamed one keeps its reason', async () => {
    const api = mkApi(reviewFixture());
    const r = await run(api);
    expect(r.reasons).toEqual({ reviewed: 3, kept_review_stale: 1, kept_active: 1 });
    expect(r.deletedBranches.sort()).toEqual(['audit/scratch', 'digby/session-aaaaaaaa', 'digby/session-bbbbbbbb']);
    expect(api.gets.filter(u => u === MANIFEST_URL)).toHaveLength(1);
    expect(archiveCommitPosts(api)).toEqual([expect.objectContaining({ parents: [ACT, RP, UNP] })]);
    expect(writes(api)).toEqual(['POST commit', `POST ${ARCHIVE_TAG}`, 'DELETE digby/session-aaaaaaaa', 'DELETE digby/session-bbbbbbbb', 'DELETE audit/scratch']);
    expect(archiveCommitPosts(api)[0].message).toContain(`digby/session-bbbbbbbb ${RP} (reviewed)`);
    expect(r.reviewedManifest).toBe('loaded');
    expect(r.reviewedEntries).toBe(4);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'branch_janitor',
      meta: expect.objectContaining({ reviewedManifest: 'loaded', reviewedEntries: 4, archiveTag: ARCHIVE_TAG, reasons: { reviewed: 3, kept_review_stale: 1, kept_active: 1 } }),
    }));
  });

  it('the other two keep sites clear too: kept_port_unverified (a Claude-session diff the port check cannot read) and the first kept_repushed site (an own-repo closed PR with no head sha); unnamed, both keep', async () => {
    const UV = sha40('1'); const NOHEAD = sha40('2');
    const fx = (named: boolean): Fixture => ({
      branches: [{ name: 'probe-unverified', sha: UV }, { name: 'digby/session-cccccccc', sha: NOHEAD }],
      aheadBy: { 'probe-unverified': 2, 'digby/session-cccccccc': 2 }, // no compareFiles ⇒ the port check reads 'unverified'
      closedPrs: { 'digby/session-cccccccc': [{ merged_at: hoursAgo(300), closed_at: hoursAgo(300) }] }, // no head.sha
      commitDates: { [UV]: hoursAgo(100), [NOHEAD]: hoursAgo(100) }, // re-pushed after the close
      reviewedManifest: { entries: named ? [{ branch: 'probe-unverified', sha: UV }, { branch: 'digby/session-cccccccc', sha: NOHEAD }] : [] },
    });
    const cleared = mkApi(fx(true));
    const r1 = await run(cleared);
    expect(r1.reasons).toEqual({ reviewed: 2 });
    expect(r1.deletedBranches.sort()).toEqual(['digby/session-cccccccc', 'probe-unverified']);
    const kept = mkApi(fx(false));
    const r2 = await run(kept);
    expect(r2.reasons).toEqual({ kept_port_unverified: 1, kept_repushed: 1 });
    expect(kept.deletes).toEqual([]);
  });

  it('a reviewed delete re-reads its ref and its open-PR state right before the DELETE: pushed during the pass ⇒ kept_moved, a PR opened during the pass ⇒ kept_open_pr', async () => {
    const fx = reviewFixture();
    fx.headsNow = { 'digby/session-aaaaaaaa': sha40('7') };
    fx.openHeadsNow = ['audit/scratch'];
    const api = mkApi(fx);
    const r = await run(api);
    expect(r.deletedBranches).toEqual(['digby/session-bbbbbbbb']);
    expect(r.reasons.kept_moved).toBe(1);
    expect(r.reasons.kept_open_pr).toBe(1);
  });

  it('manifest bounds: a body over 512 KiB is unreadable (decoded size; GitHub wraps the base64), a name over 255 chars is skipped', async () => {
    const huge = { entries: [{ branch: 'digby/session-aaaaaaaa', sha: ACT, evidence: 'x'.repeat(512 * 1024) }] };
    const api = mkApi({ ...reviewFixture(), reviewedManifest: huge });
    const r = await run(api);
    expect(r.reviewedManifest).toBe('unreadable');
    expect(api.deletes).toEqual([]);
    // Just under the bound still loads.
    const fits = { entries: [{ branch: 'digby/session-aaaaaaaa', sha: ACT, evidence: 'x'.repeat(500 * 1024) }] };
    const r2 = await run(mkApi({ ...reviewFixture(), reviewedManifest: fits }));
    expect(r2.reviewedManifest).toBe('loaded');
    expect(r2.reasons.reviewed).toBe(1);
    const long = `digby/${'n'.repeat(250)}`; // 256 chars
    expect(parseReviewedDeletes({ entries: [{ branch: long, sha: ACT }, { branch: long.slice(0, 255), sha: ACT }] })!.size).toBe(1);
  });

  it('the archive message tells a restorer to remove a reviewed entry first (the entry outlives the delete); a pass with no reviewed tip says nothing about it', () => {
    const withReviewed = archiveCommitMessage([{ name: 'digby/session-aaaaaaaa', sha: ACT, reason: 'reviewed' }], NOW);
    expect(withReviewed).toContain('A (reviewed) tip: remove its entry from .digby/branch-janitor/reviewed-deletes.json first, or the next pass deletes it again.');
    expect(archiveCommitMessage([{ name: 'audit/x', sha: ACT, reason: 'ported' }], NOW)).not.toContain('reviewed-deletes');
  });

  it('every guard after the rule still applies: a reviewed tip < 48 h is kept_young (< 2 h kept_recent), a failed archive keeps it (required), the per-pass cap holds', async () => {
    const young = reviewFixture();
    young.commitDates = { ...young.commitDates, [ACT]: hoursAgo(20), [RP]: hoursAgo(1) };
    const r1 = await run(mkApi(young));
    // audit/scratch's own < 48 h check runs before the compare; here it is old, so it is still reviewed.
    expect(r1.reasons).toEqual({ reviewed: 1, kept_young: 1, kept_recent: 1, kept_review_stale: 1, kept_active: 1 });

    const failed = mkApi({ ...reviewFixture(), commitPostStatus: 500 });
    const r2 = await run(failed);
    expect(failed.deletes).toEqual([]);
    expect(r2.reasons).toEqual({ kept_archive_failed: 3, kept_review_stale: 1, kept_active: 1 });

    const capped = mkApi(reviewFixture());
    const r3 = await run(capped, { budget: { remaining: 1 } });
    expect(r3.deletedBranches).toHaveLength(1);
    expect(r3.reasons.kept_cap).toBe(2);
  });

  it('a live lane, an open PR head and the default branch are kept BEFORE the manifest is consulted, even when it names them', async () => {
    mockChatFindMany.mockImplementation(async (q: any) => (q?.where?.id?.startsWith === 'aaaaaaaa' ? [{ id: 'aaaaaaaa-1111' }] : []));
    mockScheduleCount.mockResolvedValue(1);
    const fx = reviewFixture({ entries: [
      { branch: 'digby/session-aaaaaaaa', sha: ACT }, { branch: 'digby/session-bbbbbbbb', sha: RP }, { branch: 'main', sha: sha40('9') },
    ] });
    fx.branches.push({ name: 'main', sha: sha40('9') });
    fx.openHeads = ['digby/session-bbbbbbbb'];
    const r = await run(mkApi(fx));
    expect(r.reasons.kept_live_lane).toBe(1);
    expect(r.reasons.kept_open_pr).toBe(1);
    expect(r.reasons.kept_default).toBe(1);
    expect(r.deletedBranches).not.toContain('digby/session-aaaaaaaa');
    expect(r.deletedBranches).not.toContain('digby/session-bbbbbbbb');
  });

  it('no manifest (404) ⇒ every rule keeps as before, metric says absent; an unreadable manifest (500, bad JSON, no entries) ⇒ the same keeps, a warning, metric says unreadable', async () => {
    const absent = mkApi({ ...reviewFixture(), reviewedManifest: undefined });
    const r0 = await run(absent);
    expect(absent.deletes).toEqual([]);
    expect(r0.reasons).toEqual({ kept_active: 3, kept_repushed: 1, kept_unported: 1 });
    expect(r0.reviewedManifest).toBe('absent');
    expect(r0.reviewedEntries).toBeUndefined();
    for (const bad of [{ reviewedManifestStatus: 500 }, { reviewedManifestRaw: '{not json' }, { reviewedManifest: { branches: [] } }]) {
      (logger.warn as jest.Mock).mockClear();
      const api = mkApi({ ...reviewFixture(), ...bad });
      const r = await run(api);
      expect(api.deletes).toEqual([]);
      expect(r.reasons).toEqual({ kept_active: 3, kept_repushed: 1, kept_unported: 1 });
      expect(r.reviewedManifest).toBe('unreadable');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reviewed-deletes.json is unreadable'));
    }
  });

  it('a rate-limited manifest read aborts the repo like every other janitor read; nothing is deleted', async () => {
    const api = mkApi({ ...reviewFixture(), reviewedManifestStatus: 403 });
    const r = await run(api);
    expect(r.aborted).toBeDefined();
    expect(api.deletes).toEqual([]);
  });

  it(`${'BRANCH_JANITOR_REVIEWED_DELETES_DISABLED'}=1 (1 / true / on), the extended-rules switch, or a USER repo: the manifest is never read and the rules keep as before`, async () => {
    for (const v of ['1', 'true', 'on']) {
      process.env[ENV] = v;
      const api = mkApi(reviewFixture());
      const r = await run(api);
      expect(api.gets).not.toContain(MANIFEST_URL);
      expect(api.deletes).toEqual([]);
      expect(r.reasons).toEqual({ kept_active: 3, kept_repushed: 1, kept_unported: 1 });
      expect(r.reviewedManifest).toBeUndefined();
      expect(branchJanitorReviewedDeletesDisabled()).toBe(true);
    }
    delete process.env[ENV];
    const user = mkApi(reviewFixture());
    const ru = await run(user, { frameworkOwned: false });
    expect(user.gets.some(u => u.includes('reviewed-deletes'))).toBe(false);
    expect(user.deletes).toEqual([]);
    process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV] = '1';
    const off = mkApi(reviewFixture());
    await run(off);
    expect(off.gets.some(u => u.includes('reviewed-deletes'))).toBe(false);
    expect(off.deletes).toEqual([]);
    expect(ru.reviewedManifest).toBeUndefined();
  });

  it('DRY RUN: logs "would archive … (required)" and "would delete … (reviewed)" — never POSTs or deletes', async () => {
    const api = mkApi(reviewFixture());
    const r = await run(api, { dryRun: true });
    expect(api.posts).toEqual([]);
    expect(api.deletes).toEqual([]);
    expect(r.reasons.reviewed).toBe(3);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('would delete o/r:digby/session-aaaaaaaa (reviewed)'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('(required)'));
  });
});

describe('janitorRepo — extended rules on a USER repo (review 2026-10-21): keeps only, no new deletes, no archive writes', () => {
  /** The reviewer's scratch scenario (someuser/their-app): five branches the
   *  first cut deleted, three of them as 'merged' with no tag. */
  const userRepoFixture = (): Fixture => ({
    branches: [
      { name: 'ops/production', sha: 'ops' }, { name: 'state/prod', sha: 'stp' }, { name: 'probe-sensor-driver', sha: 'prb' },
      { name: 'audit/q3-security', sha: 'aud' }, { name: 'feature/onboarding', sha: 'onb' },
      { name: 'digby/squashed', sha: 'sq' }, { name: 'digby/session-0a1b2c3d', sha: 'lane' }, { name: 'digby/session-history', sha: 'hist' },
    ],
    aheadBy: { 'ops/production': 0, 'state/prod': 0, 'probe-sensor-driver': 0, 'audit/q3-security': 1, 'feature/onboarding': 1, 'digby/squashed': 2, 'digby/session-0a1b2c3d': 0 },
    closedPrs: {
      'feature/onboarding': [{ merged_at: hoursAgo(240), closed_at: hoursAgo(240), head: { sha: 'onb-pr' } }],
      'digby/squashed': [{ merged_at: hoursAgo(6), closed_at: hoursAgo(6), head: { sha: 'sq' } }],
    },
    compareFiles: { 'audit/q3-security': [{ filename: 'docs/q3.md', status: 'added', sha: 'blob-q3' }] },
    repushCompare: { 'feature/onboarding': { status: 'ahead', files: [{ filename: 'docs/onboarding.md', status: 'modified' }] } },
    commitDates: { ops: hoursAgo(120), stp: hoursAgo(3), prb: hoursAgo(300), aud: hoursAgo(100), onb: hoursAgo(72), sq: hoursAgo(7), lane: hoursAgo(9) },
  });

  it('ops/ state/ probe- audit/ are foreign, a docs-only repush on feature/ is kept_repushed, the old rules still delete untagged, and the lane / history keeps apply', async () => {
    const api = mkApi(userRepoFixture());
    const laneLive = jest.fn(async () => true);
    // frameworkOwned left to its default: someuser/their-app is not the instance's own repo.
    const r = await janitorRepo({ api, owner: 'someuser', repo: 'their-app', now: NOW, dryRun: false, budget: { remaining: 50 }, laneLive });
    expect(r.ownRepo).toBe(false);
    expect(api.deletes).toEqual(['https://api.github.com/repos/someuser/their-app/git/refs/heads/digby/squashed']);
    expect(r.reasons).toEqual({ kept_foreign_prefix: 4, kept_repushed: 1, pr_merged: 1, kept_live_lane: 1, kept_session_history: 1 });
    expect(api.posts).toEqual([]);
    expect(laneLive).toHaveBeenCalledWith('0a1b2c3d');
    // Foreign prefixes cost no call; the docs-repush compare is never read on a user repo.
    for (const n of ['ops/production', 'state/prod', 'probe-sensor-driver', 'audit/q3-security']) {
      expect(api.gets.some(u => u.includes(n))).toBe(false);
    }
    expect(api.gets.some(u => u.includes('/compare/onb-pr'))).toBe(false);
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.ownRepo).toBe(false);
    for (const k of ['archiveTag', 'archivedTips', 'archiveFailed']) expect(Object.keys(meta)).not.toContain(k);
  });

  it('the same fixture on the framework\'s own repo: the new rules apply, every new delete is archived, the 3 h state/ branch is kept_young', async () => {
    const api = mkApi({ ...userRepoFixture(), mainTree: { 'README.md': 'x' } });
    const r = await run(api, { laneLive: async () => true });
    expect(r.ownRepo).toBe(true);
    expect(api.deletes.sort()).toEqual([ref('ops/production'), ref('probe-sensor-driver'), ref('audit/q3-security'), ref('feature/onboarding'), ref('digby/squashed')].sort());
    expect(r.reasons).toEqual({ merged: 2, ported: 1, pr_closed_docs_repush: 1, pr_merged: 1, kept_young: 1, kept_live_lane: 1, kept_session_history: 1 });
    expect(r.archivedTips?.map(t => t.sha)).toEqual(['ops', 'prb', 'aud', 'onb', 'sq']);
    expect(tagPosts(api)).toHaveLength(1);
  });
});

describe('sweepBranches — extended rules', () => {
  const laneFixture = (): Fixture => ({
    ...canonicalFixture(),
    branches: [...canonicalFixture().branches, { name: 'digby/session-0a1b2c3d', sha: 'sha-lane' }],
    aheadBy: { ...canonicalFixture().aheadBy, 'digby/session-0a1b2c3d': 0 },
    commitDates: { ...canonicalFixture().commitDates, 'sha-lane': hoursAgo(9) },
  });

  it('the platform repo: the consolidated history branch is kept, the lane probe is threaded through, both squash/closed lanes go into ONE archive before their delete', async () => {
    mockProjectFindMany.mockResolvedValue([{ id: 'p1', userId: 'u1', repoUrl: 'https://github.com/example-org/crossmodel.git', defaultBranch: 'main' }]);
    const api = mkApi(laneFixture());
    const laneLive = jest.fn(async () => true);
    const r = await sweepBranches({ now: NOW, apiFactory: () => api, laneLive });
    expect(laneLive).toHaveBeenCalledWith('0a1b2c3d');
    expect(r).toMatchObject({ repos: 1, scanned: 15, deleted: 4, kept: 11 });
    expect(r.perRepo[0]).toMatchObject({ repo: 'example-org/crossmodel', ownRepo: true, archiveTag: ARCHIVE_TAG });
    expect(r.perRepo[0].reasons).toMatchObject({ kept_session_history: 1, kept_live_lane: 1, kept_active: 2 });
    expect(r.perRepo[0].deletedBranches).toEqual(['digby/merged-fully', 'digby/session-history/abc', 'digby/squashed', 'fix/closed-unmerged']);
    expect(archiveCommitPosts(api)).toEqual([expect.objectContaining({ tree: 'tree-main', parents: ['sha-sq', 'sha-cu'] })]);
    expect(tagPosts(api)).toEqual([{ ref: `refs/tags/${ARCHIVE_TAG}`, sha: ARCHIVE_SHA }]);
  });

  it('a user repo: the same four deletes as the pre-2026-10-21 rules, untagged — no archive write at all', async () => {
    mockProjectFindMany.mockResolvedValue([{ id: 'p1', userId: 'u1', repoUrl: 'https://github.com/someuser/their-app', defaultBranch: 'main' }]);
    const api = mkApi(laneFixture());
    const r = await sweepBranches({ now: NOW, apiFactory: () => api, laneLive: async () => true });
    expect(r).toMatchObject({ repos: 1, scanned: 15, deleted: 4, kept: 11 });
    expect(r.perRepo[0]).toMatchObject({ repo: 'someuser/their-app', ownRepo: false });
    expect(r.perRepo[0].archiveTag).toBeUndefined();
    expect(r.perRepo[0].deletedBranches).toEqual(['digby/merged-fully', 'digby/squashed', 'fix/closed-unmerged', 'digby/session-history/abc']);
    expect(api.posts).toEqual([]);
  });

  it('the contents-fallback budget is shared across repos in one pass', async () => {
    const budget: { remaining: number; portCalls?: number } = { remaining: 50, portCalls: 1 };
    const fx = (): Fixture => ({
      branches: [{ name: 'audit/x', sha: 'x' }],
      aheadBy: { 'audit/x': 1 },
      compareFiles: { 'audit/x': [{ filename: 'a.ts', status: 'modified', sha: 'blob-a' }] },
      commitDates: { x: hoursAgo(72) },
      mainTree: 'truncated',
      mainContents: { 'a.ts': 'blob-a' },
    });
    const first = await janitorRepo({ api: mkApi(fx()), owner: 'o', repo: 'r', now: NOW, dryRun: false, budget, frameworkOwned: true });
    const second = await janitorRepo({ api: mkApi(fx()), owner: 'o', repo: 'r2', now: NOW, dryRun: false, budget, frameworkOwned: true });
    expect(first.reasons).toEqual({ ported: 1 });
    expect(second.reasons).toEqual({ kept_port_unverified: 1 });
    expect(budget.portCalls).toBe(0);
  });
});
