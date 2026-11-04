/**
 * Replay pin — ticket 8e900af9 (mishap, breaker trip 2026-09-20 03:36:40Z,
 * session 1b30452f-d4eb-4dde-98d0-f63a95e31a65 "Ticket B9cb221b Investigation",
 * run 4e72bc29-4330-4cec-bd80-ad74bf2a5a29; first streak this run; the lane's
 * reasoning named grep).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak: edit_file'
 * mishap with two failure texts (newest first):
 *   1. `Tool edit_file failed: EISDIR: illegal operation on a directory, read`
 *   2. `Tool edit_file failed: ENOENT: no such file or directory, open
 *      '/app/coding-workspaces/worktrees/1b30452f-d4eb-4dde-98d0-f63a95e31a65/
 *      backend/src/modules/crossmodel/coding/agent-derail-break.aff1c189.test.ts'`
 *
 * WHAT ACTUALLY HAPPENED (adjudication 2026-09-20, all evidence fresh):
 *  1. BOTH texts are truthful Node errnos from the DESIGNED seam. edit_file
 *     (tools.ts case 'edit_file') runs resolveRealInside + a raw
 *     `fs.readFile(abs, 'utf8')`; a DIRECTORY argument throws EISDIR and a
 *     MISSING file throws ENOENT, and the executeCodingTool catch-all renders
 *     `Tool ${name} failed: ${err.message}` verbatim. resolveRealInside falls
 *     back to the lexical jail path for a not-yet-created file ("not created
 *     yet — lexical check stands"), so the ENOENT names the jail-resolved
 *     absolute path under the lane's OWN worktree. A wrong path MUST fail —
 *     the honest-errno contract already adjudicated correct and pinned for
 *     list_dir in ticket 4bf65e24 (listdir-enoent.4bf65e24.test.ts); 8e900af9
 *     is the same class one tool over.
 *  2. The ENOENT target genuinely does not exist in the lane's worktree:
 *     agent-derail-break.aff1c189.test.ts landed on MAIN via PR #889 (squash
 *     c818d802, deploy run 35483594361 success 03:03:49Z) while the lane's
 *     session branch was 79 commits behind main — the lane's own transcript
 *     (msg d6f96b29, 03:44:37Z): "`ls` just confirmed the ENOENT target
 *     genuinely doesn't exist on this 79-behind branch — truthful errno".
 *     The lane read about the suite in supervisor steers (msg 1b29bf4e: the
 *     replay suites "exist ONLY on main lineage") and tried to edit_file a
 *     main-lineage file without rebasing or verifying it existed in ITS tree —
 *     edit_file is documented "edit targets an EXISTING file" (tools.ts
 *     comment). The correct moves were rebase-first or write_file-to-create.
 *  3. The EISDIR text means the lane passed a DIRECTORY path to a tool whose
 *     contract is exact-string replacement inside a file — a model-authored
 *     bad arg, truthfully rejected.
 *  4. "Lane's reasoning named grep" — the intent-mismatch signature: the model
 *     NARRATED grep while EMITTING edit_file. No fuzzy routing exists to
 *     blame: dispatch is `switch (name)` on the exact tool name the model
 *     emitted (4bf65e24 precedent point 3). Same narration/emission mismatch
 *     family as f839cede/aff1c189/ec9d7424 (pinned 2026-09-20, PR #889) — this
 *     streak was the tail of the lane's "repeated wrong-tool derailment (2
 *     episodes)" run-end at 03:36:33Z, 7s before the breaker trip.
 *  5. No framework regression: recent tools.ts touches (#888 wake-reconcile,
 *     checkpoints, repo hooks, diagnostics) never touched edit_file's error
 *     surface; the b6013de0 dollar-pattern fix is about replace semantics.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — NO platform
 * code change. Softening these errnos into in-band guidance would contradict
 * the pinned 4bf65e24 honest-errno contract and is out of the report's scope.
 * Every deterministic seam behaved as designed: honest failure surfaces, the
 * breaker counted the streak and auto-filed with correct metadata (tool,
 * session, run, intent-mismatch note), and no mutation was wrongly executed.
 *
 * These tests pin the honest-errno contract for edit_file through the REAL
 * executeCodingTool (boundary mocks mirror listdir-enoent.4bf65e24.test.ts),
 * so a future framework change that masks, misroutes, or softens this failure
 * surface is caught — and the recovery doctrine (write_file creates;
 * edit_file edits existing) is pinned as the working path.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// listdir-enoent.4bf65e24.test.ts (the tools.ts import graph reaches
// config/env, which process.exit(1)s without env).
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

import { executeCodingTool, resolveInside, ToolContext } from './tools';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let WT = '';
// The incident's ENOENT target — main-lineage since PR #889, absent from the
// lane's 79-commits-behind worktree (and from this replay worktree).
const ENOENT_TARGET = 'backend/src/modules/crossmodel/coding/agent-derail-break.aff1c189.test.ts';
const EXISTING = 'backend/src/modules/crossmodel/coding/existing-note.ts';

const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-8e900af9', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

beforeAll(async () => {
  // A worktree shaped like the incident lane's 79-behind branch: the coding/
  // dir EXISTS (the lane edited other files there) but the #889 replay suite
  // does NOT. realpath() so byte-exact path assertions survive symlinked
  // tmpdirs (macOS /var → /private/var); Linux CI is already canonical.
  WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'replay-8e900af9-')));
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/coding'), { recursive: true });
  await fs.writeFile(path.join(WT, EXISTING), 'alpha\nbeta\ngamma\n');
});
afterAll(async () => {
  await fs.rm(WT, { recursive: true, force: true });
});

describe('ticket 8e900af9 — honest-errno contract for edit_file (the streak was model behavior)', () => {
  it('REPLAY filed text #1: edit_file on a DIRECTORY fails with the byte-exact incident surface — catch-all prefix + raw EISDIR', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: 'backend/src/modules/crossmodel/coding', old_string: 'alpha', new_string: 'BETA',
    });
    // The exact incident string (breaker trip 2026-09-20 03:36:40Z, newest
    // first): fs.readFile on a directory throws EISDIR; the executeCodingTool
    // catch-all renders `Tool ${name} failed: ${err.message}` verbatim.
    expect(out).toBe('Tool edit_file failed: EISDIR: illegal operation on a directory, read');
  });

  it('REPLAY filed text #2: edit_file on the #889-lineage suite MISSING from the worktree fails with the byte-exact ENOENT + jail-resolved path', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: ENOENT_TARGET, old_string: 'describe', new_string: 'xdescribe',
    });
    expect(out).toBe(`Tool edit_file failed: ENOENT: no such file or directory, open '${WT}/${ENOENT_TARGET}'`);
  });

  it('the failure names the JAIL-resolved absolute path (resolveInside), and an outside-worktree absolute path hits the containment error — never an errno read of /etc', async () => {
    expect(resolveInside(WT, ENOENT_TARGET)).toBe(`${WT}/${ENOENT_TARGET}`);
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: '/etc/hostname', old_string: 'a', new_string: 'b',
    });
    expect(out).toMatch(/^Tool edit_file failed: path is outside the worktree: \/etc\/hostname/);
  });

  it('control: edit_file on an EXISTING file with an exact old_string succeeds — the tool is NOT broken for present files', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: EXISTING, old_string: 'beta', new_string: 'BETA',
    });
    expect(out).not.toMatch(/^Tool edit_file failed:/);
    expect(out).toMatch(new RegExp(`^Edited ${EXISTING.replace(/\//g, '\\/')}`));
    expect(await fs.readFile(path.join(WT, EXISTING), 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('recovery doctrine pinned: write_file CREATES the missing suite path (what the lane should have done on its stale branch) — then edit_file edits it', async () => {
    const wrote = await executeCodingTool(mkCtx(), 'write_file', {
      path: ENOENT_TARGET, content: '/** replay suite placeholder */\ndescribe("x", () => {});\n',
    });
    expect(wrote).toMatch(new RegExp(`^Wrote ${ENOENT_TARGET.replace(/\//g, '\\/')} \\(`));
    const edited = await executeCodingTool(mkCtx(), 'edit_file', {
      path: ENOENT_TARGET, old_string: 'replay suite placeholder', new_string: 'replay suite',
    });
    expect(edited).not.toMatch(/^Tool edit_file failed:/);
  });

  it('contrast family: a CONTENT miss on an existing file returns the designed in-band guidance (no "Tool failed:" prefix) — path errnos stay honest failures', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: EXISTING, old_string: 'not-in-the-file', new_string: 'x',
    });
    expect(out).toBe(`old_string not found in ${EXISTING}. Read the file and match exactly.`);
  });
});
