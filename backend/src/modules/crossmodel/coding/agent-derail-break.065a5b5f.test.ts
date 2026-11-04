/**
 * Ticket 065a5b5f (mishap, auto-filed 2026-10-23T20:02:42Z) — "3×
 * tool-failure streak: edit_file — framework or model?"
 *
 * THE INCIDENT (all bytes below are the REAL prod bytes, recovered read-only
 * from agent_events of run c86525f1, session 19dd22bc — schooltime's
 * census-correct lane, editing scratch/curriculum/usngss/us_extract.py):
 *   seq 666 (fail 1, hint "99%"):  old_string typo `K-2-EPS1` vs file's
 *     `K-2-ETS1` — MODEL-side miss; the model self-diagnosed it in its next
 *     narration ("My old_string had a typo (EPS1 vs ETS1)").
 *   seq 672 (fail 2, hint "100%"): typo fixed; the quote now differs from the
 *     file's lines 382–406 on EXACTLY ONE line — file L395 is
 *       `          f"{ {k: pg_t[k] for k in sorted(pg_t)} } total {sum(pg_t.values())}")`
 *     but the quote omits ` total {sum(pg_t.values())}`. Every token of that
 *     fragment (total/sum/pg_t/values) already appears elsewhere in the
 *     25-line block, so token-Jaccard = EXACTLY 1 — the hint printed
 *     "100% similar" while exact match said "not found": a self-contradictory
 *     dead end with no gradient left (measured: Jaccard(old672, fileRegion)
 *     === 1). FRAMEWORK-side defect (the hint's only metric saturates exactly
 *     when byte-level help is needed).
 *   seq 677: the model DID read_file the region (seq 678, windowed 380–408)
 *     and at seq 680 CORRECTLY diagnosed "line 395 lacks the total suffix I
 *     guessed" — then seq 682 (fail 3) re-sent old_string bytes IDENTICAL to
 *     attempt 2 (672 === 682 byte-identical, both len 1289). MODEL-side: the
 *     diagnosed fix never landed in the args.
 *   seq 684: breaker trips; ticket filed; the run recovered via a python
 *     line-splice (run_command), no work lost.
 *
 * VERDICT: BOTH, each measured — model behavior (typo; identical re-send
 * after a correct diagnosis) AND a framework defect in the 2026-10-22 hint
 * feature itself: at token-saturation the hint's percentage goes blank, and
 * the strongest anti-loop signal ("you re-sent identical bytes") is never
 * surfaced. THE FIX (this PR): probe (e) — at ≥99% similarity the hint names
 * the FIRST differing line with BOTH excerpts so the model copies the fix
 * instead of re-sending; plus MARKER SAFETY in clipEditFileHint: a `]` in a
 * file excerpt would break the FAILURE_MARKERS tail (`[^\]\n]{0,320}`) and
 * the refusal would read as SUCCESS to the derail breaker (the d2e6b0fb
 * blind-spot class reintroduced — this incident's own region contains
 * `ct['total_rows']`).
 *
 * DETECTOR-RECALL REPLAY (the merge gate's requirement for touching the
 * detector path): every PRIOR true positive of the widened marker + the four
 * probes still fires — the efcdcbca/bb77c6ad envelopes, the d2e6b0fb
 * refusal-is-failure pins, and the 5200f182 byte-exact envelopes (83%/60%
 * hints unchanged: both < 0.99 so probe (e) does not engage).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config mocks: learnings-index.service.ts (imported for looksLikeToolFailure)
// pulls unified-memory.service → config/database → config/env, which
// process.exit(1)s without env (the d2e6b0fb suite's discipline).
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
// Import-time boundary mocks — verbatim discipline from edit-file-hint.test.ts
// (the tools.ts import graph reaches config/env, which process.exit(1)s).
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

// ── THE INCIDENT, verbatim from prod (run c86525f1) ────────────────────────
// File lines 382–406 as they stood at the failures (recovered via the seq 678
// read_file result; L395 is THE line — file has the total-suffix fragment).
const INCIDENT_FILE = `    # fan-out both readings (the count table contradicts itself on K-2-ETS1)
    def per_grade(fan):
        pg = {}
        for band, grades in fan.items():
            n = bands.get(band, 0)
            for g in grades:
                pg[g] = pg.get(g, 0) + n
        return pg
    fan_resolved = dict(FAN_OUT)
    fan_table = dict(FAN_OUT, **TABLE_FAN_OUT)
    pg_r, pg_t = per_grade(fan_resolved), per_grade(fan_table)
    oracle_pg = {int(k): v for k, v in ct["per_grade_rows"].items()}
    print(f"  fan-out reading A (table fan_out map, K-2-ETS1->[0,1,2]): "
          f"{ {k: pg_t[k] for k in sorted(pg_t)} } total {sum(pg_t.values())}")
    print(f"  fan-out reading B (resolved, K-2-ETS1->[1,2]):            "
          f"{ {k: pg_r[k] for k in sorted(pg_r)} } total {sum(pg_r.values())}")
    print(f"  oracle per_grade_rows/total_rows:                          "
          f"{ {k: oracle_pg[k] for k in sorted(oracle_pg)} } "
          f"total {ct['total_rows']}")
    if pg_t != oracle_pg:
        print("  → reading A DISAGREES with the oracle per_grade_rows "
              "(documented STRUCTURE.md §4 — the table's fan_out map "
              "contradicts its own per_grade_rows/total_rows)")
    if pg_r != oracle_pg:
        errs.append(f"resolved fan-out per-grade {pg_r} != oracle {oracle_pg}")
`;

// Attempt 2/3's old_string: L395 WITHOUT ` total {sum(pg_t.values())}`
// (byte-identical to prod seq 672/682 — the fragment whose tokens all appear
// elsewhere, so token-Jaccard saturates at exactly 1).
const INCIDENT_OLD = `    # fan-out both readings (the count table contradicts itself on K-2-ETS1)
    def per_grade(fan):
        pg = {}
        for band, grades in fan.items():
            n = bands.get(band, 0)
            for g in grades:
                pg[g] = pg.get(g, 0) + n
        return pg
    fan_resolved = dict(FAN_OUT)
    fan_table = dict(FAN_OUT, **TABLE_FAN_OUT)
    pg_r, pg_t = per_grade(fan_resolved), per_grade(fan_table)
    oracle_pg = {int(k): v for k, v in ct["per_grade_rows"].items()}
    print(f"  fan-out reading A (table fan_out map, K-2-ETS1->[0,1,2]): "
          f"{ {k: pg_t[k] for k in sorted(pg_t)} }")
    print(f"  fan-out reading B (resolved, K-2-ETS1->[1,2]):            "
          f"{ {k: pg_r[k] for k in sorted(pg_r)} } total {sum(pg_r.values())}")
    print(f"  oracle per_grade_rows/total_rows:                          "
          f"{ {k: oracle_pg[k] for k in sorted(oracle_pg)} } "
          f"total {ct['total_rows']}")
    if pg_t != oracle_pg:
        print("  → reading A DISAGREES with the oracle per_grade_rows "
              "(documented STRUCTURE.md §4 — the table's fan_out map "
              "contradicts its own per_grade_rows/total_rows)")
    if pg_r != oracle_pg:
        errs.append(f"resolved fan-out per-grade {pg_r} != oracle {oracle_pg}")
`;

let WT: string;
const TARGET = 'gate.py';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-065a5b5f', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

beforeAll(async () => {
  WT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'edit-file-hint-065a5b5f-')));
});
afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED; });

describe('ticket 065a5b5f — the saturation dead end (REAL incident bytes)', () => {
  it('PRECONDITION (the defect, measured): attempt 2/3 old_string vs file region token-Jaccard is EXACTLY 1', () => {
    const toks = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9_$]+/g) || []));
    const a = toks(INCIDENT_OLD), b = toks(INCIDENT_FILE);
    let inter = 0; for (const t of a) if (b.has(t)) inter++;
    const j = inter / (a.size + b.size - inter);
    expect(j).toBe(1); // words identical, bytes differ — the class the old hint was blind to
  });

  it('THE FIX (probe e): at saturation the hint names the differing line + column with windowed RAW excerpts', () => {
    const hint = editFileMissDiagnostic(INCIDENT_FILE, INCIDENT_OLD);
    expect(hint).toContain('100% similar');
    expect(hint).toContain('but line 14 differs at col 51'); // region-relative; L395 of the real file
    expect(hint).toContain('total {sum(pg_t.values())}');
    expect(hint).toContain('copy the file\'s line 14 byte-exactly');
  });

  it('THE FIX never prints identical excerpts (adversarial review #1): a diff past an 80-char line-start cut still shows diverging windows', () => {
    // The differing byte sits deep in the line (col ~113) and is TOKEN-NEUTRAL
    // (`-padding` vs `=padding`: token set identical → Jaccard 1.0, so (e)
    // engages); line-start excerpts cut at 80 would have come out IDENTICAL
    // (the dead end again) — the column-windowed raw excerpts diverge.
    const pad = 'padding' + '-padding'.repeat(11);
    const cur = `line_zero = 0\nthree = merge_all(rows, "${pad}")\n`;
    const oldS = `line_zero = 0\nthree = merge_all(rows, "${pad.replace(/-padding$/, '=padding')}")\n`;
    const hint = editFileMissDiagnostic(cur, oldS);
    expect(hint).toContain('but line 2 differs');
    const fileEx = hint.match(/file '([^']*)'/)?.[1] ?? '';
    const yoursEx = hint.match(/vs yours '([^']*)'/)?.[1] ?? '';
    expect(fileEx).not.toBe(yoursEx);
    expect(fileEx).toContain('-padding")');
    expect(yoursEx).toContain('=padding")');
  });

  it('THE FIX shows indent diffs when a token-neutral content diff elsewhere blocks probe (c) — raw windows keep the leading whitespace', () => {
    // Line 2's ONLY difference is indentation, and line 3's punctuation-only
    // diff ('.' vs ',') keeps probe (c) (whole-string leading-strip
    // containment) from claiming the call, so (e) names line 2 — and the
    // untrimmed windows show the indent.
    const hint = editFileMissDiagnostic('one\n    span = measure(rows)\nthree.\n', 'one\nspan = measure(rows)\nthree,\n');
    expect(hint).toContain('but line 2 differs at col 1');
    expect(hint).toContain("file '    span = measure");
    expect(hint).toContain("vs yours 'span = measure");
  });

  it('THE FIX cuts excerpts at ] — a copy target never carries a neutralized bracket (adversarial review #2)', () => {
    // The differing line contains ct['total_rows']: the excerpt is cut BEFORE
    // the ], so the copy authority stays the file line number and no fullwidth
    // ］ ever rides a "copy byte-exactly" target. clipEditFileHint stays the
    // marker-safety net for the rest of the hint. The diff itself is
    // token-neutral (';;' vs ';') so Jaccard saturates at 1.0.
    const line = `    flag = (ct['total_rows'] + ct['width']) == total;`;
    const cur = `aa = 1\nbb = 2\n${line}\ncc = 3\n`;
    const oldS = `aa = 1\nbb = 2\n${line.replace(';', ';;')}\ncc = 3\n`;
    const hint = editFileMissDiagnostic(cur, oldS);
    expect(hint).toContain('but line 3 differs');
    expect(hint).toContain('ct[');            // the raw window reaches the bracket…
    expect(hint).not.toContain('］');          // …but is never re-encoded fullwidth
    const envelope = `old_string not found in gate.py. Read the file and match exactly. [edit_file hint: ${clipEditFileHint(hint)}]`;
    expect(looksLikeToolFailure(envelope)).toBe(true);
  });

  it('THE FIX keeps the refusal failure-shaped: the marker still counts the enriched hint', () => {
    const hint = editFileMissDiagnostic(INCIDENT_FILE, INCIDENT_OLD);
    const envelope = `old_string not found in gate.py. Read the file and match exactly. [edit_file hint: ${clipEditFileHint(hint)}]`;
    expect(looksLikeToolFailure(envelope)).toBe(true);
  });

  it('MARKER SAFETY (clip): a hint excerpt containing ] no longer breaks the marker — and never carries a corrupted copy target', () => {
    // PRE-FIX SHAPE (the defect, for the record): the raw ] broke the tail and
    // the refusal read as SUCCESS to the breaker (the d2e6b0fb blind-spot
    // class reintroduced by the hint feature itself).
    const rawHint = "first difference is line 17: file has '          f\"total {ct['total_rows']}\")'";
    const brokenEnvelope = `old_string not found in gate.py. Read the file and match exactly. [edit_file hint: ${rawHint}]`;
    expect(looksLikeToolFailure(brokenEnvelope)).toBe(false);
    // POST-FIX: clipEditFileHint neutralizes ] so ANY hint riding the clip is
    // marker-safe (the (e) branch avoids needing it by cutting at ]; the
    // legacy (d) excerpt path can still carry ] — the clip catches it).
    const envelope = `old_string not found in gate.py. Read the file and match exactly. [edit_file hint: ${clipEditFileHint(rawHint)}]`;
    expect(clipEditFileHint(rawHint)).not.toContain(']');
    expect(looksLikeToolFailure(envelope)).toBe(true);
  });

  it('BUDGET PIN (adversarial review #6): the raw (e) hint fits the clip so the actionable tail never truncates mid-instruction', () => {
    // Worst realistic shape: the diff deep in a long line, so both windows are
    // full 71-char excerpts — the raw hint must stay ≤300 so "copy the file's
    // line N byte-exactly" survives un-clipped.
    const line = `value_alpha = compute_step(input_ref, context_state, "zone-padding-zone-padding-zone-padding-zone-padding-zone")`;
    const cur = `r0\nr1\nr2\n${line};\nr4\nr5\nr6\n`;
    const oldS = `r0\nr1\nr2\n${line};;\nr4\nr5\nr6\n`;
    const hint = editFileMissDiagnostic(cur, oldS);
    expect(hint.length).toBeLessThanOrEqual(300);
    expect(hint).toContain('copy the file\'s line 4 byte-exactly');
  });

  it('BAND PIN (adversarial review #5): 0.95–0.99 similarity now takes the (e) text (the threshold is 0.95, not 0.99)', () => {
    // 39 shared tokens + 1 differing: j = 39/41 ≈ 0.951 — inside the band the
    // first cut (0.99) left on the legacy dead-end text.
    const toks = Array.from({ length: 39 }, (_, i) => `tok${i}`);
    const cur = toks.join(' ') + '\n';
    const oldS = toks.slice(0, 38).join(' ') + ' eps1x\n';
    const hint = editFileMissDiagnostic(cur, oldS);
    expect(hint).toContain('differs at col');
    expect(hint).not.toContain('re-read that region');
  });

  it('at saturation with EVERY line equal, the hint names the between-lines class — and surplus lines are NAMED (adversarial review #3)', () => {
    const hint = editFileMissDiagnostic('one\ntwo\nthree', 'one\ntwo\nthree\n');
    expect(hint).toContain('every line matches');
    expect(hint).toContain('BETWEEN lines');
    // an extra duplicated line past the window: named, not mislabeled as blanks
    const dup = editFileMissDiagnostic('a = 1\nb = 2\nc = 3', 'a = 1\nb = 2\nc = 3\na = 1');
    expect(dup).toContain('MORE line(s)');
    expect(dup).not.toContain('blank lines');
  });

  it('below saturation (<0.95) the legacy (d) hint is byte-unchanged — the 5200f182 envelope survives', () => {
    const cur = "import { a, b, c } from './x';\nrouter.get('/health', h);\n";
    const hint = editFileMissDiagnostic(cur, "import { a, b } from './x';");
    expect(hint).toBe("nearest match is 83% similar at lines 1–1: 'import { a, b, c } from './x';' — re-read that region and quote it byte-exactly");
  });

  it('handler integration: the REAL incident miss now returns the actionable delta end-to-end', async () => {
    await fs.writeFile(path.join(WT, TARGET), INCIDENT_FILE);
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: INCIDENT_OLD, new_string: 'x' });
    expect(out.startsWith(`old_string not found in ${TARGET}. Read the file and match exactly. [edit_file hint: `)).toBe(true);
    expect(out).toContain('but line 14 differs');
    expect(out).toContain('total {sum(pg_t.values())}');
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('attempt 1 (the EPS1 typo, 99%): the typo is now SHOWN — the differing line names EPS1 vs ETS1', () => {
    const old = INCIDENT_OLD.replace('K-2-ETS1->[0,1,2]', 'K-2-EPS1->[0,1,2]');
    const hint = editFileMissDiagnostic(INCIDENT_FILE, old);
    expect(hint).toContain('but line 13 differs');
    expect(hint).toContain('EPS1');
    expect(hint).toContain('ETS1');
  });
});

// ── DETECTOR-RECALL REPLAY: prior true positives of this detector path ─────
describe('DETECTOR-RECALL REPLAY — the widened marker + prior probe pins still fire', () => {
  it('REPLAY efcdcbca (the .digby/rules miss): refusal still counts as failure', () => {
    expect(looksLikeToolFailure('old_string not found in .digby/rules/00-current-state.md. Read the file and match exactly.')).toBe(true);
  });

  it('REPLAY bb77c6ad (the krmoe miss): refusal still counts as failure', () => {
    expect(looksLikeToolFailure('old_string not found in scratch/curriculum/krmoe/kr_extract.py. Read the file and match exactly.')).toBe(true);
  });

  it('REPLAY d2e6b0fb pins: the refusal-is-failure anchor discipline survives (narration still never fires)', () => {
    expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly.')).toBe(true);
    expect(looksLikeToolFailure('old_string not found in docs/my notes.md. Read the file and match exactly.')).toBe(true); // spaced path class
    expect(looksLikeToolFailure('I saw: old_string not found in README.md. Read the file and match exactly.')).toBe(false);
    expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly. — then I re-read it')).toBe(false);
    expect(looksLikeToolFailure('// the refusal reads: old_string not found in x. Read the file and match exactly.')).toBe(false);
    expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly. [edit_file hint: unterminated')).toBe(false);
  });

  it('REPLAY 5200f182 envelope (83% hint): byte-identical through the handler — probe (e) does not engage below 0.99', async () => {
    await fs.writeFile(path.join(WT, TARGET), "import { a, b, c } from './x';\nrouter.get('/health', h);\n");
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: "import { a, b } from './x';", new_string: 'y' });
    expect(out).toBe(`old_string not found in ${TARGET}. Read the file and match exactly. [edit_file hint: nearest match is 83% similar at lines 1–1: 'import { a, b, c } from './x';' — re-read that region and quote it byte-exactly]`);
  });

  it('REPLAY probes (a)/(b)/(c): the three exact-explanation probes still fire unchanged', () => {
    expect(editFileMissDiagnostic('alpha\r\nbeta\r\n', 'alpha\nbeta')).toContain('CRLF');
    expect(editFileMissDiagnostic('foo  \nbar\n', 'foo\nbar')).toContain('TRAILING whitespace');
    expect(editFileMissDiagnostic('    foo\n    bar\n', 'foo\nbar')).toContain('DIFFERENT INDENTATION');
  });

  it('REPLAY multi-occurrence: the count>1 diagnostic is unchanged', () => {
    const { editFileMultiDiagnostic } = jest.requireActual('./edit-file-hint');
    expect(editFileMultiDiagnostic('dup\nmid\ndup\nend\n', 'dup')).toContain('lines: 1, 3');
  });

  it('REPLAY EDIT_FILE_MISS_DIAGNOSTICS_DISABLED=1: the byte-exact pre-hint envelope is still restored', async () => {
    process.env.EDIT_FILE_MISS_DIAGNOSTICS_DISABLED = '1';
    await fs.writeFile(path.join(WT, TARGET), INCIDENT_FILE);
    const out = await executeCodingTool(mkCtx(), 'edit_file', { path: TARGET, old_string: INCIDENT_OLD, new_string: 'x' });
    expect(out).toBe(`old_string not found in ${TARGET}. Read the file and match exactly.`);
  });
});
