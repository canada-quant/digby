/**
 * REPLAY — ticket c75b5f34, adversarial review finding F3 (zero choke-point
 * tests) + the follow-up fixes F2/F4/F6/F12.
 *
 * The leaf's contract is pinned in instance-targets.test.ts and the wired
 * resolvers in instance-isolation.c75b5f34.test.ts. THIS suite pins the
 * PUBLISH CHOKE POINTS in coding/tools.ts — the call sites a non-prod
 * instance (DIGBY_INSTANCE != prod) must never publish to / read from the
 * production repo through, EVEN in spellings parseOwnerRepo cannot parse
 * (review F1: `https://github.com/example-org/crossmodel/` parsed to null and
 * the push guard was skipped entirely — the guard now keys on the NORMALIZED
 * target, never on the parse):
 *
 *   - pushSessionBranch (the ONE push seam — git_push and
 *     open_pull_request's push both route through it);
 *   - check_ci (read-side twin);
 *   - merge_pull_request (write-side, both the explicit repo:"owner/name"
 *     route and the ctx.repoUrl route);
 *   - open_pull_request (covers the explicit-headBranch route that skips
 *     the push seam).
 *
 * The second describe block is REMOVAL-GUARD pins (the repo's established
 * source-grep pattern — see learnings: "source-grep pin suites") for the
 * follow-up fixes that live in entrypoints / scripts / sweeps an import-based
 * test cannot reach without booting a server: server.ts's rethrow (F12),
 * session-history-sync's push guard + terminal routing (F2), the branch
 * janitor's repo enumeration guard (F2), fix-state's pre-check + belt
 * re-surface (F4), closure-evidence's dedicated isolation_boundary state
 * (F4), and the backup script's selfhost dump legs (F6).
 */

// ── The tools.test.ts mock boundary (same set, same reasons) ─────────────────
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockAnswerImageQuestion: jest.Mock = jest.fn();
jest.mock('../image-describe', () => ({
  __esModule: true,
  answerImageQuestion: (...a: any[]) => mockAnswerImageQuestion(...a),
}));
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
const mockSameOwnerSessions = jest.fn(async (): Promise<Array<{ id: string; projectId: string | null }>> => []);
jest.mock('../../../config/database', () => ({ __esModule: true, default: { chatCodingState: { findMany: (...a: any[]) => mockSameOwnerSessions(...(a as [])) } } }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard', MERGE_WAIT_ONCE: 'merge_wait_once',
    GUARD_STRIKE: 'guard_strike',
  },
}));
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: jest.fn(async () => ({ policy: 'on', source: 'setting' })),
  checkOrAskOwner: jest.fn(async () => 'pending'),
  evaluateMergeGates: jest.fn(async () => ({ ok: true, alreadyMerged: false, headSha: 'headsha1234567890abcd', evidenceHash: 'ev1', evidenceNotes: ['gates green'] })),
  readAttempt: jest.fn(async () => ({})),
  writeAttempt: jest.fn(async () => {}),
  clearAttempt: jest.fn(async () => {}),
  recordMergeLearning: jest.fn(async () => {}),
  deleteMergedHeadBranch: jest.fn(async () => ({ outcome: 'kept', branch: null })),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => ({ put: jest.fn(), get: jest.fn(), delete: jest.fn() }),
  classifyMergeWait: () => null,
  mergeWaitOnceMs: () => 3,
  repoCiP50Ms: jest.fn(async () => null),
  tryAcquireMergeWaitSlot: () => true,
  releaseMergeWaitSlot: jest.fn(),
  mergeWaitSleep: jest.fn(async () => undefined),
}));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: jest.fn(async () => ({ kind: 'created' })),
}));
jest.mock('./ci-status', () => ({
  __esModule: true,
  observeCiAfterPush: jest.fn(async () => ''),
  fetchCiStatus: jest.fn(async () => ({ state: 'none', checks: [], failing: [], total: 0 })),
  renderCiStatus: jest.fn(() => ''),
  emitCiFailed: jest.fn(),
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  createSchedule: jest.fn(async () => ({ ok: true, schedule: { id: 'sch1', kind: 'recurring', intervalSec: 3600 } })),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async () => null),
  findPriorRunPrReceipt: jest.fn(async () => null),
  prHeadMatchesReceipt: jest.fn(async () => false),
  prReceiptHeadState: jest.fn(async () => undefined),
  prStateWarrantsSkip: (st: any) => !!st && st.headMatches && st.state === 'open' && !st.merged,
}));

import { executeCodingTool, pushSessionBranch, ToolContext } from './tools';
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_SRC = path.join(__dirname, '../../..'); // backend/src
const read = (rel: string): string => fs.readFileSync(path.join(BACKEND_SRC, rel), 'utf8');
const REPO_ROOT = path.join(__dirname, '../../../../../'); // repo root (scripts/ etc.)

const ENV_KEY = 'DIGBY_INSTANCE';
let savedInstance: string | undefined;

beforeEach(() => { savedInstance = process.env[ENV_KEY]; });
afterEach(() => {
  if (savedInstance === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedInstance;
});

/** A publish-context pointed at the given repo. */
function isoCtx(repoUrl: string): ToolContext {
  return {
    worktree: '/tmp/iso-chokepoint-wt-does-not-exist',
    sessionId: 'sess-iso', userId: 'u1', permissionMode: 'auto',
    repoUrl, provider: 'github', branch: 'digby/session-iso', baseBranch: 'main',
    emit: () => {}, requestApproval: async () => 'allow' as const,
  } as unknown as ToolContext;
}

const PROD_SLASH = 'https://github.com/example-org/crossmodel/'; // review F1's exact spelling: parseOwnerRepo → null
const OWN_FORK = 'https://github.com/acme/edge-digby';

describe('c75b5f34 F1/F3 — pushSessionBranch: the ONE push seam refuses every prod spelling on non-prod', () => {
  it('F1 pin: trailing-slash prod URL (unparseable by parseOwnerRepo) still REFUSES with the boundary text', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await pushSessionBranch(isoCtx(PROD_SLASH));
    expect(out).toMatch(/ISOLATION BOUNDARY/);
    expect(out).toMatch(/example-org\/crossmodel/);
    expect(out).toMatch(/must never push to/);
  });

  it('the .git and bare-URL prod spellings refuse too (parseable — always did)', async () => {
    process.env[ENV_KEY] = 'edge';
    for (const url of ['https://github.com/example-org/crossmodel.git', 'https://github.com/example-org/crossmodel']) {
      const out = await pushSessionBranch(isoCtx(url));
      expect(out).toMatch(/ISOLATION BOUNDARY/);
    }
  });

  it('non-prod + the instance OWN fork passes the boundary (no refusal — the self-improvement loop works)', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await pushSessionBranch(isoCtx(OWN_FORK));
    expect(out).not.toMatch(/ISOLATION BOUNDARY/);
  });

  it('PROD instance (DIGBY_INSTANCE unset) + the production repo: no boundary — push behavior unchanged', async () => {
    delete process.env[ENV_KEY];
    const out = await pushSessionBranch(isoCtx('https://github.com/example-org/crossmodel'));
    expect(out).not.toMatch(/ISOLATION BOUNDARY/);
  });
});

describe('c75b5f34 F3 — check_ci (read-side twin)', () => {
  it('non-prod + trailing-slash prod URL ⇒ boundary refusal (before the parse, before any token work)', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await executeCodingTool(isoCtx(PROD_SLASH), 'check_ci', { sha: '0123456789abcdef' });
    expect(out).toMatch(/ISOLATION BOUNDARY/);
  });

  it('PROD + the production repo ⇒ no boundary (proceeds to the token check)', async () => {
    delete process.env[ENV_KEY];
    const out = await executeCodingTool(isoCtx('https://github.com/example-org/crossmodel'), 'check_ci', {});
    expect(out).not.toMatch(/ISOLATION BOUNDARY/);
    expect(out).toMatch(/No connected GitHub account\/token/);
  });
});

describe('c75b5f34 F3 — merge_pull_request (write-side, both routes)', () => {
  it('non-prod + explicit repo:"example-org/crossmodel" ⇒ boundary refusal', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await executeCodingTool(isoCtx(OWN_FORK), 'merge_pull_request', { pullNumber: 1, repo: 'example-org/crossmodel' });
    expect(out).toMatch(/ISOLATION BOUNDARY/);
  });

  it('non-prod + ctx.repoUrl trailing-slash prod (no repo arg) ⇒ boundary refusal, not a generic parse error', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await executeCodingTool(isoCtx(PROD_SLASH), 'merge_pull_request', { pullNumber: 1 });
    expect(out).toMatch(/ISOLATION BOUNDARY/);
  });

  it('PROD + explicit prod repo ⇒ no boundary (proceeds to the token check)', async () => {
    delete process.env[ENV_KEY];
    const out = await executeCodingTool(isoCtx(OWN_FORK), 'merge_pull_request', { pullNumber: 1, repo: 'example-org/crossmodel' });
    expect(out).not.toMatch(/ISOLATION BOUNDARY/);
    expect(out).toMatch(/No connected GitHub account\/token/);
  });

  it('review §7 pin: non-prod + case-variant prod slug (example-org/crossmodel — GitHub resolves casing) ⇒ STILL refused (the leaf normalizes case)', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await executeCodingTool(isoCtx(OWN_FORK), 'merge_pull_request', { pullNumber: 1, repo: 'example-org/crossmodel' });
    expect(out).toMatch(/ISOLATION BOUNDARY/);
  });
});

describe('c75b5f34 F3 — open_pull_request (covers the explicit-headBranch route that skips the push seam)', () => {
  it('non-prod + trailing-slash prod repoUrl ⇒ boundary refusal before the PR gate', async () => {
    process.env[ENV_KEY] = 'selfhost';
    const out = await executeCodingTool(isoCtx(PROD_SLASH), 'open_pull_request', { title: 't' });
    expect(out).toMatch(/ISOLATION BOUNDARY/);
  });

  it('PROD + the production repo ⇒ no boundary (proceeds to headBranch validation)', async () => {
    delete process.env[ENV_KEY];
    const out = await executeCodingTool(isoCtx('https://github.com/example-org/crossmodel'), 'open_pull_request', { title: 't', headBranch: 'feature x' });
    expect(out).not.toMatch(/ISOLATION BOUNDARY/);
  });
});

describe('c75b5f34 F2/F4/F6/F12 — removal-guard pins for the follow-up fixes', () => {
  // Entrypoints and shell scripts cannot be unit-imported (server.ts boots a
  // listener; the sweep guards live behind unexported functions); these pins
  // are the repo's established source-grep pattern against silent removal.

  it('F12: server.ts rethrows IsolationBoundaryError out of the non-fatal infra-watch catch (web boot hard-fails like the worker)', () => {
    const src = read('server.ts');
    expect(src).toContain("if (err?.name === 'IsolationBoundaryError') throw err;");
  });

  it('F2: session-history-sync guards pushRemoteFor and routes the boundary refusal to the TERMINAL (quarantine) path', () => {
    const src = read('modules/crossmodel/coding/session-history-sync.service.ts');
    expect(src).toContain('assertRepoTargetAllowed(String(project?.repoUrl ?? \'\') || \'origin\')');
    const terminal = src.match(/err instanceof IsolationBoundaryError/g) ?? [];
    // ONE catch: the legacy per-session path (and its second catch) was deleted
    // with SESSION_HISTORY_SINGLE_BRANCH_DISABLED in RSW-1 cluster 42, so the
    // consolidated catch below is now the ONLY place the boundary refusal routes
    // to the quarantine path. Pinned exactly so a future refactor cannot drop it
    // silently while still satisfying a >=1 count by accident elsewhere.
    expect(terminal.length).toBe(1); // the consolidated catch
  });

  it('F2: the branch janitor refuses to enumerate the production repo on a non-prod instance', () => {
    const src = read('modules/crossmodel/fleet/branch-janitor.service.ts');
    expect(src).toContain('if (!repoTargetAllowed(p.repoUrl ?? \'\')) { boundaryRefused++; continue; }');
  });

  it('F4: fix-state resolves the boundary OUTSIDE every belt (verbatim reason) and re-surfaces it in the merge-check belt', () => {
    const src = read('modules/crossmodel/feedback/fix-state.ts');
    expect(src).toContain('const isoTarget = resolveInstanceRepoTarget(process.env);');
    expect(src).toContain('return { fixLive: false, reason: isoTarget.refusal, evidence };');
    expect(src).toContain("if (err?.name === 'IsolationBoundaryError') return { fixLive: false, reason: String(err.message), evidence };");
  });

  it('F4: closure-evidence carries a dedicated isolation_boundary state rendered by BOTH origin/main callers', () => {
    const src = read('modules/crossmodel/feedback/closure-evidence.ts');
    expect(src.match(/state: 'isolation_boundary'/g)?.length).toBeGreaterThanOrEqual(1); // the type
    expect(src.match(/remote\.state === 'isolation_boundary'/g)?.length).toBe(2); // file-miss + citation-miss lanes
    // and it is checked BEFORE the fetch (outside the try), never demoted by the catch
    expect(src.indexOf('const isoRefusal = replayIsolationRefusal();')).toBeLessThan(src.indexOf('const ctrl = new AbortController();'));
  });

  it('F6: the backup script has the selfhost dump legs (digby-postgres container + digby-backend env)', () => {
    const sh = fs.readFileSync(path.join(REPO_ROOT, 'scripts/backup/digby-backup.sh'), 'utf8');
    expect(sh).toContain('docker exec digby-postgres pg_dump -U admin -d admin_db -Fc');
    expect(sh).toContain('for c in admin-backend-blue admin-backend-green digby-backend; do');
    // and the selfhost leg is bounded to NON-prod instances only
    expect(sh).toMatch(/\[ "\$\{DIGBY_INSTANCE:-prod\}" != "prod" \] && docker ps/);
  });

  it('review §11 pin: infra-watch fetchCompareFiles short-circuits on the unconfigured non-prod repo (the commit-2 follow-up, now tested)', () => {
    const src = read('modules/crossmodel/fleet/infra-watch.service.ts');
    expect(src).toContain('if (!DEPLOY_REPO) return null;');
    // the short-circuit sits in fetchCompareFiles itself (not only fetchDeployRuns)
    const fn = src.slice(src.indexOf('export async function fetchCompareFiles'));
    expect(fn.slice(0, 800)).toContain('if (!DEPLOY_REPO) return null;');
  });

  it('review §5/§6 pin: F1-class bypass closed — the push guard keys on the normalized target, never on parseOwnerRepo', () => {
    const src = read('modules/crossmodel/coding/tools.ts');
    // the old bypass: `if (isoRepo && !repoTargetAllowed(ctx.repoUrl))` — the
    // parse null on a trailing-slash prod URL skipped the whole guard.
    expect(src).not.toContain('if (isoRepo && !repoTargetAllowed(ctx.repoUrl))');
    expect(src).toContain('if (!repoTargetAllowed(ctx.repoUrl))');
  });
});
