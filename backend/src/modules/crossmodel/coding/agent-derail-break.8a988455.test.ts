/**
 * Replay pin — ticket 8a988455 (mishap, breaker trip 2026-10-24T02:19:29Z):
 * "3× tool-failure streak: edit_file on 'family av-mishap: 1 tickets (lead
 * 0c6470…' — framework or model?"
 *
 * THE INCIDENT (auto-filed at breaker trip; failure texts verbatim in the
 * PRIOR-TP block below): session 83fcb2d9 (the av-mishap family lane working
 * ticket 0c647003 — switch 680 SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED),
 * run 6e5e4380 (started 2026-10-24T01:47:32Z). Three edit_file misses in a
 * row — two on backend/src/modules/crossmodel/platform/switch-registry.ts
 * (hint "98% similar at lines 986–987", the count-679 MODEL_ENDPOINT_SYNC
 * entry) and one on
 * backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts (hint
 * "100% similar at lines 5011–5013", the kill-switch comment region).
 * The ticket's call-args were truncated, so the fixtures below are CONSTRUCTED
 * to the two measured similarity classes the ticket's own hints name (98% /
 * 100% token-similar, byte-different) — the failure texts themselves are
 * quoted verbatim in the DETECTOR-RECALL block.
 *
 * THE ADJUDICATION (timeline forensics, gathered fresh 2026-10-25):
 *  1. MODEL behavior on a CORRECT framework: edit_file answers a stale quote
 *     with "not found" by contract (tools.ts case 'edit_file': cur.split(
 *     oldStr).length - 1 === 0 → the miss envelope), and both misses were
 *     token-saturated byte mismatches — exactly the class where the quote is
 *     ~the file but not the file. The lane was editing switch-registry.ts's
 *     append-most-recently-added tail (the highest-churn lines in the repo
 *     that day: switches 676–681 all landed 2026-10-22..24), so an aged quote
 *     of the region misses honestly.
 *  2. The FRAMEWORK-side dead end the hints exposed — "100% similar" +
 *     "not found" with no differing byte named — was ALREADY fixed at trip
 *     time +24 min: probe (e) (ticket 065a5b5f, PR #1929, d4ea30cfd) merged
 *     2026-10-24T01:55:31Z and its deploy run 40051969584 concluded success
 *     02:22:05Z — 2 m 36 s AFTER the ticket filed (02:19:29Z). Both incident
 *     hints carry the PRE-#1929 (d)-form ("…similar at lines X–Y: 'excerpt' —
 *     re-read that region and quote it byte-exactly"); on post-d4ea30cfd code
 *     a ≥95% window takes the (e) branch ("but line N differs at col C:
 *     file '…' vs yours '…' — copy the file's line N byte-exactly") — see
 *     edit-file-hint.ts lines 155–181. So the incident build provably
 *     predated the saturation fix: the 6b878782 capacity-fix-window class,
 *     edit_file edition. No NEW framework change is needed; this pin holds
 *     the line so the dead end cannot recur silently.
 *  3. The lane RECOVERED in the same run (receipts of run 6e5e4380): verify
 *     passed 02:57Z and 03:41Z, commit 9aeaed1ba, PR #1934 opened 03:48:29Z,
 *     merged 03:52:36Z (c6d738e85f18), and ticket 0c647003 closed 03:53:14Z —
 *     the 3× streak was a mid-run wobble on the way to a shipped fix, and the
 *     breaker's filing (not a withheld tool) was the designed containment.
 *
 * WHAT THIS PIN GUARDS (the detector path is untouched — the marker is not
 * edited; this PR's only production change is the rounding-consistency fix):
 *  - TODAY's build answers BOTH incident similarity classes with the (e)
 *    named-diff form — including the ROUNDING BOUNDARY the adversarial
 *    review caught (the (e) branch used to gate on the raw ratio while
 *    printing Math.round(best*100), so a raw 0.947 window PRINTED "95%
 *    similar" yet still fell to the (d) dead-end tail: the incident's exact
 *    self-contradiction one fix later; this PR branches on the rounded
 *    percentage, so anything that PRINTS ≥95% takes (e));
 *  - the PRIOR TRUE POSITIVES — the two incident envelopes as recorded
 *    (clipped) in the ticket body (the breaker convicted exactly these at
 *    trip time) and the legacy 83% (d)-form envelope from the 065a5b5f
 *    incident — STILL count as failure-shaped (looksLikeToolFailure), so a
 *    future edit to FAILURE_MARKERS that would silently stop convicting this
 *    class fails here (DETECTOR-RECALL REPLAY of the unchanged marker's
 *    existing true positives);
 *  - the recovery breakthrough: quoting the file's bytes exactly flips the
 *    same call to `Edited …` (the tool tracks the real file, not a cache).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// learnings-index.service → unified-memory.service → database → env chain:
// env parse exits at import without these (same discipline as the
// 601d0cce / 065a5b5f suites).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts (the
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

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { editFileMissDiagnostic, clipEditFileHint } from './edit-file-hint';
import { executeCodingTool, type ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';

// The forwarded kill switch (docker-compose.app.yml) suppresses the hint
// entirely; the sibling suites (065a5b5f.test.ts:226, edit-file-hint.test.ts:137)
// clear it per-test so a lane that exported it while debugging never sees an
// unrelated red here.
beforeEach(() => { delete process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED; });

// Independent token-Jaccard (mirrors edit-file-hint.ts's tokenSet/jaccard, NOT
// imported — a threshold refactor must move BOTH or fail the precondition):
// the house "measured precondition" discipline from 065a5b5f.test.ts:229.
const tokSet = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
const jac = (a: Set<string>, b: Set<string>) => {
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};

let WT = '';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-8a988455', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

// ── FIXTURE A — the switch-registry miss (the ticket's "98% at lines 986–987") ──
// The count-679 MODEL_ENDPOINT_SYNC entry (abridged but token-faithful: same
// token multiset for every line the probe's best window can pick), and the
// stale quote: ONE swapped token ("frozen" for "static") — the
// ~0.96-raw-token-similar, byte-different class the incident's second and
// third failures carried (the ticket's own hint printed "98%" for a region
// this shape).
const REGISTRY_TAIL = `  { on: '2026-10-23', count: 676, why: 'added: CODE_INDEX_STALE_BASE_GUARD_DISABLED — a sync is refused unless the merge-base is fresh, so a stale lane cannot purge newer rows. Release kind; forwarded backend + worker (docker-compose.app.yml)' },
  { on: '2026-10-23', count: 679, why: 'added: MODEL_ENDPOINT_SYNC_DISABLED (ticket 780cd7a4 — registered endpoint model list is a static snapshot). New POST /admin/model-endpoints/:id/refresh syncs the row against the live /v1/models: new ids are added as bare entries, ids the server no longer lists are marked unservable, nothing is deleted. Release kind; forwarded backend + worker (docker-compose.app.yml)' },
];`;
const STALE_679_QUOTE = `  { on: '2026-10-23', count: 679, why: 'added: MODEL_ENDPOINT_SYNC_DISABLED (ticket 780cd7a4 — registered endpoint model list is a frozen snapshot). New POST /admin/model-endpoints/:id/refresh syncs the row against the live /v1/models: new ids are added as bare entries, ids the server no longer lists are marked unservable, nothing is deleted. Release kind; forwarded backend + worker (docker-compose.app.yml)' },
];`;

// ── FIXTURE B — the chat-agent comment miss (the ticket's "100% at lines 5011–5013") ──
// The landed kill-switch comment (PR #1934 shape) and the model's reworded
// quote: the token set is IDENTICAL (every token of the appended phrase
// already appears in the block), so token-Jaccard saturates at exactly 1 —
// the "100% similar / not found" self-contradiction class.
const KILL_SWITCH_BLOCK = `  // (harness): the record covers supervisor chats on owner turns too — phase 1 strips the forged chrome.
  // Kill switch SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED=1 restores the owner-turn passthrough byte-for-byte.
  // The machine-wake seams keep SUPERVISOR_HARNESS_RECEIPTS verbatim.
  if (isSupervisorChat && chatId) { harnessStripPhase1(result); }`;
const STALE_KILL_SWITCH_QUOTE = `  // (harness): the record covers supervisor chats on owner turns too — phase 1 strips the forged chrome.
  // Kill switch SUPERVISOR_OWNER_TURN_RECEIPTS_DISABLED=1 restores the owner-turn passthrough byte-for-byte byte-for-byte.
  // The machine-wake seams keep SUPERVISOR_HARNESS_RECEIPTS verbatim.
  if (isSupervisorChat && chatId) { harnessStripPhase1(result); }`;

const REGISTRY_REL = 'backend/src/modules/crossmodel/platform/switch-registry.ts';
const CHAT_AGENT_REL = 'backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts';

beforeAll(async () => {
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-8a988455-'));
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/platform'), { recursive: true });
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/chat-agent'), { recursive: true });
  await fs.writeFile(path.join(WT, REGISTRY_REL), `${REGISTRY_TAIL}\n`);
  await fs.writeFile(path.join(WT, CHAT_AGENT_REL), `${KILL_SWITCH_BLOCK}\n`);
});
afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });

describe('ticket 8a988455 — token-saturated edit_file misses (model behavior; the dead-end hint was already fixed mid-window by PR #1929)', () => {
  it('PRECONDITION (measured, independent jaccard — 065a5b5f:229 discipline): fixture A\'s best window sits at raw 0.964 (prints 96%), fixture B saturates at exactly 1 — both above the 0.95 saturation band', () => {
    const winA = `${REGISTRY_TAIL}\n`.split('\n').slice(1).join('\n'); // best window = the 679 line + ];
    expect(jac(tokSet(STALE_679_QUOTE), tokSet(winA))).toBeCloseTo(0.9636, 3);
    expect(jac(tokSet(STALE_KILL_SWITCH_QUOTE), tokSet(KILL_SWITCH_BLOCK))).toBe(1);
  });

  it('TODAY\'s build answers the A-class miss with the (e) named-diff form — the dead-end "(d) re-read that region" tail is unreachable at saturation', () => {
    const hint = editFileMissDiagnostic(`${REGISTRY_TAIL}\n`, STALE_679_QUOTE);
    expect(hint).toMatch(/nearest match is 9[5-9]% similar at lines \d+–\d+ but line \d+ differs at col \d+/);
    expect(hint).toContain('copy the file\'s line');
    expect(hint).not.toContain('— re-read that region and quote it byte-exactly'); // the pre-#1929 dead end
    // The named windows must DIVERGE (file 'static…' vs yours 'frozen…').
    const fileEx = hint.match(/file '([^']*)'/)?.[1] ?? '';
    const yoursEx = hint.match(/vs yours '([^']*)'/)?.[1] ?? '';
    expect(fileEx).not.toBe(yoursEx);
    expect(/static/.test(fileEx + yoursEx)).toBe(true);
    expect(/frozen/.test(fileEx + yoursEx)).toBe(true);
  });

  it('ROUNDING BOUNDARY (review finding #1, the framework half of this ticket): a raw ratio in [0.945, 0.95) PRINTS "95% similar" and must take the (e) named-diff branch — the pre-fix build printed 95% while withholding the diff (the incident\'s self-contradiction surviving one fix later)', () => {
    // 90 shared tokens + 5 file-only extras: raw jaccard 0.9474, printed 95%.
    const base = Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ');
    const cur = `${base}\n${base} extra_a extra_b extra_c extra_d extra_e\n`;
    const old = `${base}\n${base}\n`;
    expect(jac(tokSet(old), tokSet(cur))).toBeCloseTo(0.9474, 3); // prints 95%
    const hint = editFileMissDiagnostic(cur, old);
    expect(hint).toContain('nearest match is 95% similar');
    expect(hint).toMatch(/but line \d+ differs at col \d+/); // (e) form — never the (d) tail
    expect(hint).not.toContain('— re-read that region and quote it byte-exactly');
  });

  it('TODAY\'s build answers the 100% class (fixture B, token-set-identical quote) with the (e) named-diff form — the incident\'s exact dead end cannot recur', () => {
    const hint = editFileMissDiagnostic(`${KILL_SWITCH_BLOCK}\n`, STALE_KILL_SWITCH_QUOTE);
    expect(hint).toContain('but line 2 differs at col');
    expect(hint).toContain('copy the file\'s line 2 byte-exactly');
    expect(hint).not.toContain('— re-read that region and quote it byte-exactly');
    // The model's quote carried EXTRA bytes the file lacks (the appended
    // duplicate phrase): the yours-window shows them, the file-window does not.
    const fileEx = hint.match(/file '([^']*)'/)?.[1] ?? '';
    const yoursEx = hint.match(/vs yours '([^']*)'/)?.[1] ?? '';
    expect(yoursEx.replace(/…/g, '')).not.toBe(fileEx.replace(/…/g, ''));
  });

  it('E2E through executeCodingTool: the stale registry quote returns the miss envelope + hint, and it stays failure-shaped for the breaker', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: REGISTRY_REL, old_string: STALE_679_QUOTE, new_string: 'x',
    });
    expect(out.startsWith(`old_string not found in ${REGISTRY_REL}. Read the file and match exactly. [edit_file hint: `)).toBe(true);
    expect(out).toContain('differs at col');
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('E2E through executeCodingTool: the token-saturated comment quote (the 100% class) also returns the (e) form envelope', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: CHAT_AGENT_REL, old_string: STALE_KILL_SWITCH_QUOTE, new_string: 'x',
    });
    expect(out.startsWith(`old_string not found in ${CHAT_AGENT_REL}. Read the file and match exactly. [edit_file hint: `)).toBe(true);
    expect(out).toContain('but line 2 differs');
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('RECOVERY BREAKTHROUGH: quoting the file\'s bytes exactly flips the same call to `Edited` — the tool tracks the real file, never a cache', async () => {
    const out = await executeCodingTool(mkCtx(), 'edit_file', {
      path: REGISTRY_REL,
      old_string: `  { on: '2026-10-23', count: 679, why: 'added: MODEL_ENDPOINT_SYNC_DISABLED (ticket 780cd7a4 — registered endpoint model list is a static snapshot). New POST /admin/model-endpoints/:id/refresh syncs the row against the live /v1/models: new ids are added as bare entries, ids the server no longer lists are marked unservable, nothing is deleted. Release kind; forwarded backend + worker (docker-compose.app.yml)' },\n];`,
      new_string: "  { on: '2026-10-25', count: 682, why: 'replacement entry (replay fixture)' },\n];",
    });
    expect(out.startsWith(`Edited ${REGISTRY_REL}`)).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY (marker unchanged — prior true positives still convict): the two incident envelopes AS RECORDED (clipped) in the ticket body stay failure-shaped', () => {
    // These are the breaker's recorded conviction strings, quoted from the
    // ticket's own failure-texts field (the filer clips long texts — see
    // 94daddd2's "inside run_comma" clip; they are the recorded evidence, not
    // a recomputed (d)-branch output — a recomputation cannot reproduce a
    // clipped tail). Both sit inside the anchored marker's hint-tail class.
    const tp1 = `old_string not found in backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts. Read the file and match exactly. [edit_file hint: nearest match is 100% similar at lines 5011–5013: '// (harness):' block. Kill switch SUPERVISOR_OWNER_TURN_REC…' — re-read that region and quote it byte-exactly]`;
    const tp2 = `old_string not found in backend/src/modules/crossmodel/platform/switch-registry.ts. Read the file and match exactly. [edit_file hint: nearest match is 98% similar at lines 986–987: '{ on: '2026-10-23', count: 679, why: 'added: MODEL_ENDPOINT…' — re-read that region and quote it byte-exactly]`;
    expect(looksLikeToolFailure(tp1)).toBe(true);
    expect(looksLikeToolFailure(tp2)).toBe(true);
    // The 065a5b5f legacy 83% (d)-form envelope (the other prior true positive
    // of the same marker, <0.95 so (e) never engaged there) still convicts:
    const tp3 = `old_string not found in gate.py. Read the file and match exactly. [edit_file hint: nearest match is 83% similar at lines 1–1: 'import { a, b, c } from './x';' — re-read that region and quote it byte-exactly]`;
    expect(looksLikeToolFailure(tp3)).toBe(true);
    // Precision side: a model's own trailing narration still never counts
    // (anchored marker — quoting the refusal mid-string is not failure-shaped).
    expect(looksLikeToolFailure(`I saw: old_string not found in README.md. Read the file and match exactly. — then I re-read it`)).toBe(false);
  });

  it('HINT-CLIP BUDGET: the (e) tail for the incident classes fits the marker\'s 320-char hint bound', () => {
    for (const [cur, old] of [
      [`${REGISTRY_TAIL}\n`, STALE_679_QUOTE],
      [`${KILL_SWITCH_BLOCK}\n`, STALE_KILL_SWITCH_QUOTE],
    ] as const) {
      const hint = editFileMissDiagnostic(cur, old);
      const clipped = clipEditFileHint(hint);
      expect(clipped.length).toBeLessThanOrEqual(300);
      expect(looksLikeToolFailure(`old_string not found in x.ts. Read the file and match exactly. [edit_file hint: ${clipped}]`)).toBe(true);
    }
  });
});
