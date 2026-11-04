/**
 * REPLAY PIN — tool-failure-streak FAMILY, lane fe8f1971 (2026-10-29): three
 * same-day auto-filed mishaps, ONE adjudication (no deterministic framework
 * defect — every refusal was TRUTHFUL at call time against the filing lane's
 * OWN tree), THREE distinct fingerprints, one pin each:
 *
 *  - ticket dae518c6 (lead) — `verify` ×3 in session 7b38541c, the lane
 *    AUTHORING ticket 36b8c979 (= PR #2049, merged c2eb6cb284). Chronological
 *    order (filed newest-first, so reversed): switches → lint → test. Each
 *    leg refused a REAL condition in that lane's mid-edit worktree:
 *      · switches — `✗ [unregistered] FIX_STATE_LIVENESS_PROBE_DISABLED is
 *        read by …/feedback/fix-state.ts but is not in SWITCHES`: the lane had
 *        just added the kill-switch reads to fix-state.ts and had not yet run
 *        `npm run switches:sync`. The advertised recovery path WORKS and was
 *        taken: the row + ledger line exist on main today (row 320, ledger
 *        line 1008 → count 690) and `switches:check` is green.
 *      · lint — exit 2 with only WARNINGS in the captured tail: the fatal
 *        diagnostic sat outside the captured tail of a tree that was still
 *        being edited; full `npm run lint` on main is 0 errors / 364 warnings,
 *        exit 0.
 *      · test — FAIL …/agent-derail-break.e72251c9.test.ts: the lane's own
 *        in-flight edit of a pin suite; that suite passes 3/3 on main.
 *
 *  - ticket 05675489 — `verify {only:["typecheck","switches"]}` ×3 in session
 *    a88b2470, the lane AUTHORING ticket 68167bbf (= PR #2061, merged
 *    60247b90b7). Same authoring class, different fingerprint: a transient
 *    `TS1005: ')' expected` INSIDE switch-registry.ts at (1008,1684) — the
 *    middle of the SWITCH_COUNT_LEDGER `why:` string being authored — plus
 *    the identical unregistered-read refusal for the new
 *    SYSTEM_FIRST_NORMALIZE_DISABLED reads, plus a TS2339 on `providerError`
 *    in its own brand-new test. All three are the lane's own unfinished tree;
 *    on main tsc is exit 0, the ledger line parses (1009, 1674 chars),
 *    switches are green, and that pin passes 6/6.
 *
 *  - ticket 1ffaa187 — `read_file` ×2 ENOENT on …/coding/system-first.ts in
 *    session 7f7878ce, an adversarial REVIEW lane for the same ticket
 *    68167bbf. The file was ADDED to main by 60247b90b7 at 2026-10-28
 *    20:36:59Z; the ticket was filed at 20:07:03Z — 30 minutes EARLIER, from
 *    a worktree whose base predated the merge. The ENOENT was therefore
 *    literal truth about that worktree, and the jail is honest from every
 *    direction (a relative path resolves under the worktree; the file was
 *    simply not there). The recovery leaves the worktree — `git_show` on the
 *    PR branch / `origin/main`, or a run_command — exactly the tool the
 *    pinned e0d5b63d honest-errno contract says the worker must reach for.
 *
 * ADJUDICATION (251e9329 rule — diff the refusal text against the tools it
 * names before calling a streak model behavior): every refusal here is either
 * a build guard reporting a real defect in the caller's own unfinished tree
 * (dae518c6, 05675489) or a truthful errno with NO advertised recovery path to
 * break (1ffaa187). No refusal names a tool that cannot do what it claims, and
 * no guard fired on a clean tree. The model-side error, in all three, is
 * ORDERING: a lane ran the full verify chain / read a path repeatedly WHILE
 * the tree was mid-edit or from a base that predated the merge — the documented
 * iteration class (6a950136), not a framework defect.
 *
 * These pins lock the detected shapes so a future relaxation of the switch
 * guard (the DA0-2 style "stop failing on unregistered reads" temptation) or a
 * "soften the ENOENT into guidance" change reds here first. The switch-guard
 * describes deliberately replay the guard's PRIOR TRUE POSITIVES (the exact
 * violation kinds these tickets filed) — an unregistered backend read and a
 * count raise with no ledger line must STILL be reported.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from
// agent-derail-break.e0d5b63d.test.ts (the tools.ts import graph reaches
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
// One boundary mock beyond the e0d5b63d set, required ONLY because this suite
// also imports learnings-index.service for `looksLikeToolFailure` (a pure regex
// test): that module imports unified-memory.service for its nudger path, which
// this suite never exercises.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memSearch: jest.fn(async () => []),
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

import { executeCodingTool, ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';
import {
  switchRegistryViolations, SWITCHES, SWITCH_COUNT_LEDGER,
  type SwitchScanInput, type SwitchSpec, type SwitchCountLine,
} from '../platform/switch-registry';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TODAY = '2026-10-29';

/** A scan that reads ONLY the given switch(es), from the given files. */
const scanReading = (name: string, files: string[], forwarded = true): SwitchScanInput => ({
  backend: new Map([[name, files]]),
  frontend: new Map(),
  compose: {
    backend: forwarded ? new Set([name]) : new Set(),
    worker: forwarded ? new Set([name]) : new Set(),
    frontendArgs: new Set(),
  },
  frontendDockerArgs: new Set(),
});

/**
 * registry/ledger fixtures whose count AGREES with the fixture registry, so
 * `count_mismatch` cannot fire.
 *
 * NB these fixtures cannot suppress `unread`: the guard emits one per registry
 * row the scan did not see (switch-registry.ts, code ⇄ registry loop), and a
 * single-name scan legitimately reports ~690 of them. Assert on the NAMED
 * violation kind — never `expect(v).toEqual([])`.
 */
const agreedFixtures = (registry: readonly SwitchSpec[]): readonly SwitchCountLine[] =>
  [{ on: TODAY, count: registry.length, why: 'fixture — count agrees with the fixture registry' }];

// ── Member 1: dae518c6 (lead) — the switches leg ─────────────────────────────
describe('ticket dae518c6: an unregistered switch read REFUSES (the guard was truthful; recovery `switches:sync` works)', () => {
  const NAME = 'FIX_STATE_LIVENESS_PROBE_DISABLED';
  const READER = 'backend/src/modules/crossmodel/feedback/fix-state.ts';

  it('DETECTOR-RECALL REPLAY — the filed violation STILL fires for the incident shape (read by fix-state.ts, absent from SWITCHES)', () => {
    // The lane's mid-edit tree: fix-state.ts reads the new kill switch, the
    // registry row does not exist yet. This is the exact filed text's shape.
    const registry = SWITCHES.filter((s) => s.name !== NAME);
    expect(registry.some((s) => s.name === NAME)).toBe(false); // the fixture really omits it
    const v = switchRegistryViolations(scanReading(NAME, [READER]), TODAY, registry, agreedFixtures(registry), []);
    const unregistered = v.find((x) => x.kind === 'unregistered');
    expect(unregistered).toBeDefined();
    expect(unregistered!.name).toBe(NAME);
    // The message names the reader files and the recovery — the exact contract
    // the filing lane's text quotes.
    expect(unregistered!.message).toContain(`${NAME} is read by ${READER} but is not in SWITCHES`);
    expect(unregistered!.message).toContain('npm run switches:sync');
  });

  it('the recovery path was TAKEN: the row and its ledger line are on main, agreeing on the count (the guard is green today)', () => {
    const row = SWITCHES.find((s) => s.name === NAME);
    // `expires` is asserted DELIBERATELY: both rows are release switches that
    // the registry's own doctrine says must be DELETED on expiry. When that
    // cleanup happens, this failure must read "the pin outlived the switch it
    // pins — delete the pin with the switch", not a mystery `undefined`.
    expect(row).toMatchObject({ name: NAME, kind: 'release', added: '2026-10-28', expires: '2026-11-18' });
    // The ledger keeps the raise JUSTIFIED (a bare count bump is itself a
    // violation) and its last line agrees with SWITCHES.length.
    const last = SWITCH_COUNT_LEDGER[SWITCH_COUNT_LEDGER.length - 1];
    expect(last.count).toBe(SWITCHES.length);
    expect(SWITCH_COUNT_LEDGER.some((l) => l.why.includes(NAME))).toBe(true);
  });

  it('all three filed verify texts are failure-shaped to the breaker (the counting seam was correct, not a false alarm)', () => {
    // Reconstituted from the filed description, not lifted from a log — but
    // byte-faithful to it, and all five texts across both members match the
    // SAME `Verify FAILED at` failure marker (they do not fall through to the
    // `[exit: N]` tail marker), so this is one marker with several spellings.
    for (const text of [
      'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✓ switches (exit 0)  ✗ test (exit 1)',
      'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 2)',
      'Verify FAILED at "switches": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ switches (exit 1)',
    ]) expect(looksLikeToolFailure(text)).toBe(true);
  });
});

// ── Member 2: 05675489 — same authoring class, different fingerprint ─────────
describe('ticket 05675489: the count ratchet + the unregistered read (a lane authoring its own registry change)', () => {
  const NAME = 'SYSTEM_FIRST_NORMALIZE_DISABLED';
  const READERS = [
    'backend/src/modules/crossmodel/coding/coding-model.ts',
    'backend/src/modules/crossmodel/coding/system-first.ts',
  ];

  it('DETECTOR-RECALL REPLAY — the filed unregistered-read refusal STILL fires (both reader files named)', () => {
    const registry = SWITCHES.filter((s) => s.name !== NAME);
    const v = switchRegistryViolations(scanReading(NAME, READERS), TODAY, registry, agreedFixtures(registry), []);
    const unregistered = v.find((x) => x.kind === 'unregistered' && x.name === NAME);
    expect(unregistered).toBeDefined();
    expect(unregistered!.message).toContain('but is not in SWITCHES');
  });

  it('DETECTOR-RECALL REPLAY — a count raise with no ledger line is STILL a violation (the other half of the authoring trap)', () => {
    // The lane added the row without the ledger line: SWITCHES.length exceeds
    // the last ledger count. The guard must name the raise, not stay silent.
    const registry = SWITCHES; // the row is present
    const stale = SWITCH_COUNT_LEDGER.slice(0, -1).concat([{ on: TODAY, count: SWITCHES.length - 1, why: 'stale fixture count (one below the registry)' }]);
    const v = switchRegistryViolations(scanReading(NAME, READERS), TODAY, registry, stale, []);
    expect(v.find((x) => x.kind === 'count_mismatch')).toBeDefined();
  });

  it('the registry row and its ledger line are on main (the authoring trap never reached it)', async () => {
    // Same tombstone shape as member 1: name the expiry so the mandated
    // release-switch cleanup produces a self-explaining failure.
    expect(SWITCHES.find((s) => s.name === NAME)).toMatchObject({ name: NAME, kind: 'release', added: '2026-10-28', expires: '2026-11-18' });
    const last = SWITCH_COUNT_LEDGER[SWITCH_COUNT_LEDGER.length - 1];
    expect(last.count).toBe(SWITCHES.length);
    expect(SWITCH_COUNT_LEDGER.some((l) => l.why.includes(NAME))).toBe(true);
    // The filed TS2339 named its own brand-new pin suite: assert it EXISTS in
    // this checkout. (Its greenness is main's tsc/CI — measured by the verify
    // chain, not re-proven here.) Awaited + isFile: an un-awaited `.resolves`
    // assertion reports a deletion as an unattributed worker crash instead of
    // a red assertion naming the ticket, and `resolves.toBeTruthy()` on an
    // fs.Stats asserts only "did not reject".
    const pin = await fs.stat(path.resolve(__dirname, 'agent-message-order.68167bbf.test.ts'));
    expect(pin.isFile()).toBe(true);
  });

  it('both filed verify texts are failure-shaped to the breaker', () => {
    for (const text of [
      'Verify FAILED at "typecheck": ✗ typecheck (exit 1)',
      'Verify FAILED at "switches": ✓ typecheck (exit 0)  ✗ switches (exit 1)',
    ]) expect(looksLikeToolFailure(text)).toBe(true);
  });
});

// ── Member 3: 1ffaa187 — truthful ENOENT on a not-yet-merged file ────────────
describe('ticket 1ffaa187: read_file ENOENT on coding/system-first.ts — truthful errno, recovery outside the worktree', () => {
  const REL = 'backend/src/modules/crossmodel/coding/system-first.ts';
  let WT = '';

  const mkCtx = (): ToolContext => ({
    worktree: WT, sessionId: 'sess-1ffaa187', userId: 'u1', permissionMode: 'auto',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: jest.fn(async () => 'allow' as const),
    execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
  }) as unknown as ToolContext;

  beforeAll(async () => {
    WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'family-1ffaa187-')));
  });
  afterAll(async () => {
    await fs.rm(WT, { recursive: true, force: true }).catch(() => undefined);
  });

  it('REPLAY — the byte-exact incident surface: catch-all prefix + raw ENOENT + the worktree-resolved absolute path, NO softening', async () => {
    // The incident worktree's base predated the merge that ADDED the file, so
    // the relative path resolved under the worktree root and missed. Same shape
    // here: the jail resolves relative paths under the worktree, and the file
    // is absent from this one.
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REL });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${WT}/${REL}'`);
    // And it is failure-shaped — the input to the 1→2→3 count.
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('the line-range form refuses identically (the incident\'s second call carried start_line/end_line)', async () => {
    // read_file reads the file BEFORE slicing (tools.ts), so the range form is
    // the same ENOENT — the incident's second call is not a distinct failure
    // surface. The assertion below is what makes this test more than a
    // duplicate of the one above: on a PRESENT file the range path must emit
    // the `140\t…` numbered format, so a regression inside the slice is caught.
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REL, start_line: 140, end_line: 174 });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${WT}/${REL}'`);
    // Present-file control: the SAME args against a file that exists.
    await fs.mkdir(path.join(WT, path.dirname(REL)), { recursive: true });
    const numbered = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(path.join(WT, REL), numbered, 'utf8');
    const sliced = await executeCodingTool(mkCtx(), 'read_file', { path: REL, start_line: 2, end_line: 4 });
    expect(sliced).toBe('2\tline 2\n3\tline 3\n4\tline 4');
    await fs.rm(path.join(WT, 'backend'), { recursive: true, force: true });
  });

  it('RECOVERY — the file exists in the repo today (it landed 30 min after the filing), and a worktree that HAS it reads fine', async () => {
    // Discriminator: the file is real and present in this checkout at exactly
    // the path the reviewer asked for — the ENOENT was snapshot-freshness, not
    // a jail bug. A reviewer reaches it with git_show / origin/main.
    const real = await fs.stat(path.resolve(__dirname, 'system-first.ts'));
    expect(real.isFile()).toBe(true);
    // Control: put the same relative path in the worktree and the identical
    // call succeeds — the tool was never broken, only the snapshot was stale.
    await fs.mkdir(path.join(WT, path.dirname(REL)), { recursive: true });
    await fs.writeFile(path.join(WT, REL), 'export const marker = 1;\n', 'utf8');
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REL });
    expect(out).toContain('export const marker = 1;');
    await fs.rm(path.join(WT, 'backend'), { recursive: true, force: true });
  });
});