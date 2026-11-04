/**
 * Replay pin — ticket f245e262 (mishap, breaker trip filed 2026-10-26T07:32Z,
 * session eb34a8db-f248-470b-a216-ac66aa01a80f "Author CR rule text for 63 ·
 * Implement i", run 0832fbaf-e264-427c-93a6-9c40f4c7a33a; tool edit_file; first
 * streak this run).
 *
 * THE INCIDENT (the filed failure texts, newest first):
 *   · `old_string not found in site/sim-engine.js. Read the file and match
 *     exactly. [edit_file hint: nearest match is 100% similar at lines
 *     713–744 but line 713 differs at col 5: file '      s.battle = null;
 *     ev.push("battle ends");' vs yours '    var dmg = hasKw(ainfo, "Double
 *     Attack") ? 2 :…' — copy the file's line 713 byte-exactly]` ×2, then
 *   · the line-691 variant (same shape: `  };` vs
 *     `  P._resolveDamage = function () {`, col 3).
 *
 * WHAT ACTUALLY HAPPENED (adjudication 2026-10-27; the ticket body carries the
 * call args verbatim): the model was ADDING a new method (`P._resolveDamage`)
 * to site/sim-engine.js. The method did not exist in the file — there was
 * nothing to replace — so the model kept sending the NEW code (the code it
 * wanted to INSERT) as old_string: it treated edit_file as
 * insert-at-position. edit_file's contract is exact-string replacement inside
 * an EXISTING file; the correct move was write_file to create, or a real
 * existing anchor.
 *
 * WHY THIS IS MODEL BEHAVIOR, NOT A FRAMEWORK DEFECT (the mandated
 * investigation, verified this run against the live code):
 *  1. The miss diagnostics (tickets efcdcbca + bb77c6ad, 2026-10-22; the
 *     saturation-delta leg 065a5b5f, 2026-10-23) fired EXACTLY as designed on
 *     every attempt: each refusal carried the nearest window (713–744 /
 *     691–745), the differing line + column, and raw excerpts of BOTH sides.
 *     edit-file-hint.ts is a pure leaf (no I/O); every hint named true bytes.
 *  2. The "100% similar" percentage is token-Jaccard — deliberately blind to
 *     arrangement and punctuation. For a NEW method written in the SAME
 *     vocabulary as the surrounding battle-resolution code (s, battle, ainfo,
 *     hasKw, d.life.length, s.winner, b.attacker_seat, ev.push …) the best
 *     window's token set equals the anchor's while the bytes differ: the
 *     percentage is honest about tokens and blind to exactly the insert-intent
 *     class. No deterministic hint can make a replace-with-nonexistent-anchor
 *     succeed, and auto-inserting would violate the tool's contract (the
 *     8e900af9 honest-surface doctrine, one family over).
 *  3. The model re-sent near-identical args 3× AFTER a byte-correct
 *     diagnosis — the same adjudicated class as 8e900af9 (edit_file honest
 *     errnos), 4bf65e24 (list_dir ENOENT), and the efcdcbca/bb77c6ad
 *     miss-diagnostics family: the tool failed truthfully and helpfully; the
 *     model ignored the diagnostic.
 *
 * VERDICT: MODEL BEHAVIOR — no platform code change for the miss legs. These
 * tests pin the machinery as the incident's record: the filed "100% similar +
 * copy the file's line byte-exactly" envelope reproduces deterministically on
 * the token-saturated insert-intent shape; a wholly-absent method anchor gets
 * the honest sub-saturation miss (never a masked success, never the
 * self-contradictory 100%); and the recovery doctrine (write_file creates,
 * edit_file edits) stays pinned.
 *
 * Boundary mock discipline copied verbatim from
 * agent-derail-break.8e900af9.test.ts (the tools.ts import graph).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// listdir-enoent.4bf65e24.test.ts / agent-derail-break.8e900af9.test.ts (the
// tools.ts import graph reaches config/env, which process.exit(1)s without env).
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
  listProcesses: jest.fn(() => ''),
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
  getStoredSchedulePrompt: jest.fn(async () => null),
}));

import { executeCodingTool, ToolContext } from './tools';
import { editFileMissDiagnostic } from './edit-file-hint';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const FILE = 'site/sim-engine.js';

/** The file's battle-resolution tail — the region the incident's hints named
 *  (file line 713 `      s.battle = null; ev.push("battle ends");`), scaled
 *  to a replay fixture. The identifiers are the incident's own vocabulary. */
const FILE_BODY = [
  'var hasKw = function (info, kw) { return (info.kw || []).indexOf(kw) >= 0; };',
  'P._resolveBattle = function () {',
  '  var s = this.state, b = s.battle;',
  '  var ainfo = this._p(b.attacker_seat).info;',
  '  var dmg = hasKw(ainfo, "Double Attack") ? 2 : 1;',
  '  var banish = hasKw(ainfo, "Banish");',
  '  if (!d.life.length) { s.winner = b.attacker_seat; ev.push(d.name + " takes " + dmg); }',
  '};',
  'P._endBattle = function () { s.battle = null; ev.push("battle ends"); };',
].join('\n');

/** SATURATION species (filed text #1's shape): the anchor quotes the file's
 *  battle tail but re-arranges the ev.push operand order — the token SET is
 *  identical to the window's (token-Jaccard 1.0 → "100% similar") while the
 *  bytes differ. Reproduces the incident's `100% similar at lines 713–744 …
 *  copy the file's line 713 byte-exactly` envelope deterministically. */
const SATURATED_ANCHOR = [
  '  var dmg = hasKw(ainfo, "Double Attack") ? 2 : 1;',
  '  var banish = hasKw(ainfo, "Banish");',
  '  if (!d.life.length) { s.winner = b.attacker_seat; }',
  '  ev.push(d.name + dmg + " takes ");',
].join('\n');

/** INSERT-INTENT species (the ticket's call args, line 691's shape): the
 *  whole NEW method P._resolveDamage — absent from the file. Fresh
 *  identifiers (resolveDamage, defeated) keep token-Jaccard below the 95%
 *  saturation bar, so the honest sub-saturation miss fires instead. */
const NEW_METHOD_ANCHOR = [
  '  P._resolveDamage = function () {',
  '    var s = this.state, b = s.battle;',
  '    var ainfo = this._p(b.attacker_seat).info;',
  '    var dmg = hasKw(ainfo, "Double Attack") ? 2 : 1;',
  '    var banish = hasKw(ainfo, "Banish");',
  '    if (!d.life.length) { s.winner = b.attacker_seat; ev.push(d.name + " is defeated"); }',
  '  };',
].join('\n');

let WT = '';
beforeAll(async () => {
  WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'replay-f245e262-')));
  await fs.mkdir(path.join(WT, 'site'), { recursive: true });
  await fs.writeFile(path.join(WT, FILE), FILE_BODY, 'utf8');
});
afterAll(async () => {
  await fs.rm(WT, { recursive: true, force: true });
});

const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-f245e262', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

describe('ticket f245e262 — insert-intent edit_file miss: honest miss diagnostics, model behavior (no code change)', () => {
  it('REPLAY saturation species: the filed envelope — "100% similar … copy the file line byte-exactly" — reproduces deterministically through the REAL executeCodingTool', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: FILE, old_string: SATURATED_ANCHOR, new_string: SATURATED_ANCHOR.replace('" takes "', '" strikes "'),
    });
    // The designed in-band miss surface (no catch-all failure prefix — the
    // 8e900af9 contrast family: path errnos and content misses stay distinct).
    expect(out).toMatch(/^old_string not found in site\/sim-engine\.js\. Read the file and match exactly\./);
    expect(out).not.toMatch(/^Tool edit_file failed:/);
    // The saturation-delta hint (065a5b5f): names the percentage, the window,
    // the differing line + column, BOTH raw excerpts (windowed c−25..c+45),
    // and the copy authority. The en-dash is the hint's own (edit-file-hint.ts).
    expect(out).toMatch(/\[edit_file hint: nearest match is 100% similar at lines 5–8 but line 7 differs at col \d+: file '.{0,80}' vs yours '.{0,80}' — copy the file's line 7 byte-exactly\]$/);
  });

  it('REPLAY insert-intent species: the whole NEW method (P._resolveDamage) is an honest sub-saturation miss — never a masked success, never the self-contradictory 100%', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: FILE, old_string: NEW_METHOD_ANCHOR, new_string: 'x',
    });
    expect(out).toMatch(/^old_string not found in site\/sim-engine\.js\. Read the file and match exactly\./);
    expect(out).not.toMatch(/^Tool edit_file failed:/);
    // Below the saturation bar the hint names the true (non-100) percentage —
    // the model's anchor is NOT "almost there"; there is nothing to replace.
    expect(out).not.toContain('100% similar');
  });

  it('UNIT (pure leaf): the diagnostic is deterministic — identical inputs, identical hint (the machinery that fired 3× in the incident)', () => {
    const h1 = editFileMissDiagnostic(FILE_BODY, SATURATED_ANCHOR);
    const h2 = editFileMissDiagnostic(FILE_BODY, SATURATED_ANCHOR);
    expect(h1).toBe(h2);
    expect(h1).toContain('100% similar');
    // Marker safety (065a5b5f): the raw hint body carries no bare `]` that
    // could break the failure-marker envelope — the excerpt cuts at `]`.
    expect(editFileMissDiagnostic(FILE_BODY, NEW_METHOD_ANCHOR)).not.toContain('100% similar');
  });

  it('RECOVERY doctrine pinned (the 8e900af9 close, same family): write_file CREATES the new method — then edit_file edits it. Insert intent belongs to write_file, never to a fabricated old_string', async () => {
    const NEW_FILE = 'site/sim-engine-damage.js';
    const wrote = await executeCodingTool(mkCtx(), 'write_file', {
      path: NEW_FILE, content: 'P._resolveDamage = function () { return 1; };\n',
    });
    expect(wrote).toMatch(/^Wrote site\/sim-engine-damage\.js \(/);
    const edited = await executeCodingTool(mkCtx(), 'edit_file', {
      path: NEW_FILE, old_string: 'return 1;', new_string: 'return 2;',
    });
    expect(edited).toMatch(/^Edited site\/sim-engine-damage\.js/);
    expect(await fs.readFile(path.join(WT, NEW_FILE), 'utf8')).toBe('P._resolveDamage = function () { return 2; };\n');
  });
});
