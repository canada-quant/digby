/**
 * Replay for the SECOND `tool-failure-streak` auto-filer family (5 mishap
 * tickets filed 2026-11-03T06:28Z … 10:48Z, lead b7bf4dcb; members 0c6a47de,
 * c2bcf488, 74f242f3, 2fe7261c).
 *
 * This is the batch the FIRST family's fix (#2390, commit 5e888f1705, merged
 * 2026-11-03T08:29:15Z) could only half-cover, and the per-member disposition
 * recorded here is the attribution this file pins:
 *
 *  · b7bf4dcb + 74f242f3 — `grep`, 3× each. ALREADY FIXED BY #2390 and not a
 *    fresh defect: both tickets' recorded failure texts are the PRE-fix shape
 *    (`Tool grep failed: the search did not complete ([exit: 1]) …` — NO
 *    `[INFRA]` prefix), and both were filed at/before the fix merged (06:28Z
 *    and 08:27Z vs 08:29:15Z). Their recorded patterns AND scopes are valid:
 *    the REPLAY case below runs all six call shapes against the real worktree
 *    and every one succeeds.
 *  · 0c6a47de — `ast_search`, 3×. THE ONE REAL DEFECT THIS FILE FIXES. The
 *    grep branch has classified a transport death since #2390, but the
 *    ast_search/ast_rewrite branch kept ONLY `execShell`'s stdout, so a dead
 *    shell rendered as the opaque `Tool ast_search failed: no output from
 *    ast-grep` — naming nothing, offering no retry, matching FAILURE_MARKERS,
 *    and so withholding the tool for a model round while blaming the model.
 *  · c2bcf488 — `goal_premise_set`. NOT a framework defect: the goal genuinely
 *    sat at its 12/12 premise cap (`PREMISE_MAX_PER_GOAL`), the lane re-sent a
 *    shape the refusal had already named, and the second failure's text already
 *    carries the settled af24badf caveat from #2243 ("the kpi: path is CLOSED
 *    … register the number under its own non-kpi key"). A cap refusal is a
 *    REAL, actionable failure and must keep counting — see the discriminator.
 *  · 2fe7261c — `verify`. NOT a framework defect and NOT reproducible: the
 *    cited test file is byte-identical to main, untouched since 2026-07 and
 *    declares `mockPost` exactly ONCE, and `npx tsc --noEmit` over the whole
 *    backend exits 0. The lane's own tree had the duplicate declaration; verify
 *    reporting it was correct behaviour.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from
// grep-false-zero.b6d50f4a.test.ts (the tools.ts import graph reaches config/env,
// which process.exit(1)s without env).
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
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
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
  },
}));
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: jest.fn(async (): Promise<any> => ({ policy: 'on', source: 'setting' })),
  checkOrAskOwner: jest.fn(async (): Promise<any> => 'pending'),
  evaluateMergeGates: jest.fn(async (): Promise<any> => ({ ok: true, alreadyMerged: false, headSha: 'x', evidenceHash: 'e', evidenceNotes: [] })),
  readAttempt: jest.fn(async (): Promise<any> => ({})),
  writeAttempt: jest.fn(async () => {}),
  clearAttempt: jest.fn(async () => {}),
  recordMergeLearning: jest.fn(async () => {}),
  deleteMergedHeadBranch: jest.fn(async (): Promise<any> => ({ outcome: 'kept', branch: null })),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => ({ put: jest.fn(), get: jest.fn(), delete: jest.fn() }),
}));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created' })) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
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
  createSchedule: jest.fn(async () => ({ ok: true, schedule: { id: 'sch1', kind: 'recurring', intervalSec: 3600, nextRunAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-09-13T00:00:00.000Z' } })),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async (): Promise<any> => null),
  findPriorRunPrReceipt: jest.fn(async (): Promise<any> => null),
  prHeadMatchesReceipt: jest.fn(async (): Promise<boolean> => false),
}));

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

import { executeCodingTool, ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';
import { isExecTransportFailure } from './exec-transport';
import { AST_TIMEOUT_MS } from './ast-tools';
import { isExportTree } from '../../../utils/export-mode';

const execFileAsync = promisify(execFile);

/** The repo root — the REPLAY cases grep the REAL tracked tree. */
function repoRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'backend')) ? cwd : path.resolve(cwd, '..');
}
const ROOT = repoRoot();

/** REAL execShell — mirrors agent.ts execInProcess (bash -lc, cwd-locked). */
const realExec = async (command: string, cwd?: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('bash', ['-lc', command], { cwd: cwd || ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
};

const mkCtx = (exec: typeof realExec = realExec): ToolContext => ({
  worktree: ROOT, sessionId: 'sess-tool-failure-streak-2', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: exec,
}) as unknown as ToolContext;

/** The exact call shapes members b7bf4dcb + 74f242f3 recorded (grep). */
const GREP_MEMBER_CALLS: Array<{ pattern: string; path?: string; glob?: string }> = [
  // b7bf4dcb
  { pattern: 'isRunning|docker ps|container.*health|ensureSessionContainer|execTargetName', path: 'backend/src/modules/crossmodel/coding/agent.ts' },
  { pattern: 'function renderVerifyFeedback|renderVerifyFeedback =', path: 'backend/src/modules/crossmodel/coding' },
  { pattern: 'No such container|is not running|docker inspect|containerState', path: 'backend/src/modules/crossmodel/coding/container.service.ts' },
  // 74f242f3
  { pattern: 'LEASE_MS', path: 'backend/src/modules/crossmodel/coding/run-state.ts' },
  { pattern: 'LEASE_MS|heartbeat', path: 'backend/src/modules/crossmodel/coding/run-state.ts' },
  { pattern: 'framework_signal_finding|framework-signal-sweep|raw-marker', glob: '*.md' },
];

/** The exact call shapes member 0c6a47de recorded (ast_search). */
const AST_MEMBER_CALLS: Array<{ pattern: string; path?: string; lang?: string }> = [
  { pattern: 'const renderVerifyFeedback = ($$$ARGS) => $B', lang: 'ts', path: 'backend/src/modules/crossmodel/coding' },
  { pattern: 'ensureSessionContainer($$$ARGS)', lang: 'ts' },
  { pattern: 'function renderVerifyFeedback($$$ARGS)', lang: 'ts' },
];

describe('tool-failure-streak family 2 (b7bf4dcb lead) — per-member attribution', () => {
  // The REPLAY cases run REAL `git grep` / REAL ast-grep over this worktree, so
  // they share the box with every other jest worker. The ceiling is DERIVED from
  // the real bounds instead of guessed, so the assertion — never the clock — is
  // what decides: 3 ast-grep calls at AST_TIMEOUT_MS each, 6 greps at 30 s each,
  // plus teardown. Importing AST_TIMEOUT_MS keeps the two from drifting apart
  // (a hand-picked 240 s was already smaller than the 270 s the ast calls alone
  // may legitimately consume).
  jest.setTimeout(3 * AST_TIMEOUT_MS + 6 * 30_000 + 30_000);

  // ── b7bf4dcb + 74f242f3 (grep) — the #2390 fix already covers them ──────
  // EXPORT TREE (todo 13069ce2, 2026-11-05): the `grep` tool is backed by
  // `git grep`, and a public export has no `.git` (the exporter ships CONTENT,
  // never history). Outside a repo `git grep` exits 128, so the tool correctly
  // reports "not a git repository; use run_command with plain grep" and this
  // replay sees `(no matches)` for every call — a tree fact, not the per-member
  // attribution this suite exists to prove. Skip the replay in an export and
  // keep it in every checkout: the dead-shell pin BELOW stays unconditional,
  // because it exercises the INFRA anchoring, not the repo.
  const grepReplay = isExportTree() ? it.skip : it;
  grepReplay('REPLAY (b7bf4dcb + 74f242f3): all six recorded grep calls SUCCEED today — pattern/scope was never the defect', async () => {
    for (const c of GREP_MEMBER_CALLS) {
      const out = await executeCodingTool(mkCtx(), 'grep', c);
      expect(out).not.toMatch(/^\[INFRA\] Tool grep failed/);
      expect(out).not.toMatch(/^Tool grep failed/);
      expect(out).not.toBe('(no matches)');
    }
  });

  it('b7bf4dcb + 74f242f3: a dead shell is INFRA-anchored by the shipped #2390 fix and never charges the model', async () => {
    const deadExec = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container 49e506f86e0b851e03af5269c07b57f2ea4f1bec2e01538ad094a01357a86bff is not running\n[exit: 1]',
    });
    const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'grep', GREP_MEMBER_CALLS[3]);
    expect(out).toMatch(/^\[INFRA\] Tool grep failed: the search did not complete/);
    expect(out).toContain('Retry the SAME call');
    expect(looksLikeToolFailure(out)).toBe(false);
  });

  // ── 0c6a47de (ast_search) — THE DEFECT THIS FILE FIXES ─────────────────
  it('REPLAY (0c6a47de): all three recorded ast_search calls parse today — the patterns were never the problem', async () => {
    let tested = 0;
    let skipped = '';
    for (const c of AST_MEMBER_CALLS) {
      const out = await executeCodingTool(mkCtx(), 'ast_search', c);
      // A sandbox without registry access cannot exercise this case (ast-grep is
      // fetched through npx), and a cold fetch slower than AST_TIMEOUT_MS reads
      // as a timed-out transport death. Both are environment limits, NOT
      // defects — skip them rather than assert a match we could not produce.
      const envLimit = /ast-grep is unavailable in this container/.test(out)
        || (/^\[INFRA\] Tool ast_search failed: ast-grep never ran/.test(out) && /timed out/i.test(out));
      if (envLimit) { skipped = out.slice(0, 200); continue; }
      tested += 1;
      // Either real matches or a real "(no matches …)" verdict — never the
      // opaque "no output from ast-grep" that racked the streak.
      expect(out).not.toMatch(/^Tool ast_search failed: no output from ast-grep/);
      expect(out).toMatch(/^(\d+ match\(es\)|\(no matches)/);
    }
    // A hollow green is worse than an honest skip: an UNEXERCISED replay must be
    // a named red unless the operator opted in explicitly (DIGBY_AST_REPLAY_SKIP=1).
    if (!tested && process.env.DIGBY_AST_REPLAY_SKIP !== '1') {
      throw new Error(`replay 0c6a47de did not run (ast-grep unavailable in this sandbox): ${skipped} — set DIGBY_AST_REPLAY_SKIP=1 to accept an unexercised replay`);
    }
  });

  it('0c6a47de: a dead shell on ast_search is INFRA — named, anchored, retry-the-SAME-call, and never a streak', async () => {
    const deadExec = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container 49e506f86e0b851e03af5269c07b57f2ea4f1bec2e01538ad094a01357a86bff is not running\n[exit: 1]',
    });
    const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'ast_search', AST_MEMBER_CALLS[1]);
    // 1. Anchored so the derail breaker can exempt it.
    expect(out).toMatch(/^\[INFRA\] Tool ast_search failed: ast-grep never ran/);
    // 2. It tells the truth: retry the SAME call — do NOT rewrite the pattern.
    expect(out).toContain('Retry the SAME call');
    expect(out).toContain('NOT a bad pattern');
    // 3. It never falsely claims "no matches".
    expect(out).not.toContain('(no matches)');
    // 4. …and the derail breaker does NOT charge it to the model.
    expect(looksLikeToolFailure(out)).toBe(false);
  });

  it('0c6a47de: three dead shells in a row on ast_search never form a streak (the exact 3× shape of the member)', async () => {
    const deadExec = async () => ({
      stdout: '',
      stderr: 'Error response from daemon: container abc is not running\n[exit: 1]',
    });
    let streak = 0;
    for (let i = 0; i < 3; i++) {
      const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'ast_search', AST_MEMBER_CALLS[i]);
      if (looksLikeToolFailure(out)) streak += 1;
    }
    // Pre-fix this was 3 → the breaker withheld `ast_search` and auto-filed a
    // mishap blaming the model for a dead box.
    expect(streak).toBe(0);
  });

  it('0c6a47de DISCRIMINATOR: a silent ast-grep with NO transport signature still counts, and says re-run once then use grep', async () => {
    // No stderr at all: the shell ran, ast-grep emitted nothing, no exit marker
    // ⇒ NOT provably infra. It must stay a failure (never a silent pass), but
    // the text must stop a lane rewriting a valid pattern.
    const silent = async () => ({ stdout: '', stderr: '' });
    const out = await executeCodingTool(mkCtx(silent as typeof realExec), 'ast_search', { pattern: 'x' });
    expect(out).not.toMatch(/^\[INFRA\]/);
    expect(out).toMatch(/^Tool ast_search failed: no output from ast-grep — this is NOT a "no matches" verdict/);
    expect(out).toContain('Re-run the SAME call once');
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('0c6a47de DISCRIMINATOR: a bad PATTERN is still a plain failure WITH the ast-grep warning (unchanged)', async () => {
    const warn = async () => ({ stdout: '[]\nWarning: Pattern contains an ERROR node and may cause unexpected results.\n', stderr: '' });
    const out = await executeCodingTool(mkCtx(warn as typeof realExec), 'ast_search', { pattern: 'if (' });
    expect(out).toMatch(/^\(no matches\)\n\[ast-grep\] Warning: Pattern contains an ERROR node/);
    expect(out).toContain('fix the pattern');
    expect(out).not.toMatch(/^\[INFRA\]/);
  });

  // ── c2bcf488 (goal_premise_set) — a REAL cap refusal, correctly counted ──
  it('c2bcf488: a premise-cap refusal is a REAL, actionable failure — it must KEEP feeding the breaker', () => {
    // Verbatim head of the member's recorded failure text (the JSON refusal
    // envelope goal_premise_set returns at the 12-premise cap).
    const capRefusal = JSON.stringify({
      ok: false,
      error: 'goal_premise_set: a goal holds at most 12 premises (got 13: 12 already registered + 1 new key(s) in this call) — 1 key must go: drop at least 1 of the NEW key(s) …',
    }, null, 1);
    // This is the model's own mistake to fix (drop the new key, or free a slot
    // with mode:'replace'). Exempting it would hide a genuine register loop.
    expect(looksLikeToolFailure(capRefusal)).toBe(true);
    // …and it is NOT misclassified as infrastructure.
    expect(isExecTransportFailure(capRefusal)).toBe(false);
  });

  // ── 2fe7261c (verify) — not a framework defect, not reproducible ────────
  it('2fe7261c: a genuine "Verify FAILED at typecheck" still counts — the framework reporting a real red is CORRECT', () => {
    const red = 'Verify FAILED at "typecheck": ✗ typecheck (exit 1)\n--- typecheck output tail ---\nsrc/modules/crossmodel/brightdata-direct.test.ts(12,7): error TS2451: Cannot redeclare block-scoped variable \'mockPost\'.';
    expect(looksLikeToolFailure(red)).toBe(true);
    expect(isExecTransportFailure(red)).toBe(false);
  });

  it('2fe7261c: the cited file is CLEAN on the tracked tree — one mockPost declaration (the streak was the lane\'s own tree)', () => {
    const p = path.join(ROOT, 'backend/src/modules/crossmodel/brightdata-direct.test.ts');
    const src = fs.readFileSync(p, 'utf8');
    const decls = src.split('\n').filter((l) => /^\s*(?:const|let|var)\s+mockPost\b/.test(l));
    expect(decls).toHaveLength(1);
  });

  // ── detector-recall obligations for the [INFRA] exemption ───────────────
  it('DETECTOR-RECALL REPLAY — the [INFRA] exemption never swallows a pre-existing true positive', () => {
    // looksLikeToolFailure is a framework detector (coding/learnings-index.service.ts);
    // this lane changed a framework TOOL, so every prior convicting shape must
    // still fire, and only the `[INFRA]` anchor is exempt.
    const truePositives = [
      'Tool grep failed: fatal: Unmatched ( or \\(',
      // The REAL emitted shape for an npm/registry outage (astGrepUnavailableReason
      // intercepts the raw npm line and wraps it) — pinning the raw npm text, which
      // the tool never emits, would defend the wrong shape.
      'Tool ast_search failed: ast-grep is unavailable in this container (npm ERR! code ENOTFOUND) — fall back to grep.',
      'Verify FAILED at "typecheck": ✗ typecheck (exit 1)',
      'git commit failed: pre-commit hook',
      'COMMIT BLOCKED — evidence',
      'Opening the PR failed: 422',
      '{\n "ok": false,\n "error": "nope"\n}',
      'run finished\n[exit: 1]',
    ];
    for (const tp of truePositives) expect(looksLikeToolFailure(tp)).toBe(true);
    // The exemption is the `[INFRA]` ANCHOR and nothing else — an infra phrase
    // WITHOUT the anchor (an older/other emitter) is still counted, so the
    // exemption can never silently widen.
    expect(looksLikeToolFailure('Tool grep failed: container is not running')).toBe(true);
    expect(looksLikeToolFailure('[INFRA] Tool ast_search failed: ast-grep never ran')).toBe(false);
    expect(looksLikeToolFailure('[INFRA] Tool ast_search failed: ast-grep is unavailable in this container')).toBe(false);
  });
});