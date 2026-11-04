/**
 * Replay for ticket 1ecde029 — "3× tool-failure streak: grep on
 * 'Owner-reported panel defects: request · ' — framework or model?"
 *
 * THE INCIDENT (auto-filed 2026-10-20T00:40Z, session bd275609, run 924b662a;
 * a ticket-lane run triaging panel-defect tickets): three consecutive grep
 * calls, patterns `(?i)qwen`, `(?i)helper`, `(?i)4b` (newest first), each
 * failed with the VERBATIM text
 *   `Tool grep failed: fatal: -e option, '(?i)…': Invalid preceding regular
 *    expression — fix the pattern/scope, or use run_command with plain grep.`
 *
 * ROOT CAUSE (deterministic, framework-side — reproduced verbatim pre-fix):
 * the grep tool's engine is `git grep -nIE -e <pattern>` = POSIX ERE. ERE has
 * no `(?…)` group constructs at all — every one of them fails regex
 * compilation with exit 128 (`fatal: -e option, '…': Invalid preceding
 * regular expression`), which routes to the generic failure branch. The
 * model's `(?i)` is CORRECT ripgrep/PCRE (the tool's own schema said
 * "ripgrep-like", inviting exactly this), so the generic remedy text ("fix
 * the pattern/scope") — which never names the ERE-vs-PCRE gap — taught
 * nothing: the session retried three times varying only the search term
 * while keeping `(?i)`. Verdict: framework defect (engine/schema mismatch +
 * unclassified failure), with the model's only sin being schema trust.
 *
 * THE FIX (tools.ts, all pinned here end-to-end against a REAL temp git
 * repo + REAL bash execShell, mirroring grep-false-zero.b6d50f4a.test.ts):
 *  1. `translatePcreToEre` preflight: leading flags-only groups
 *     (?i) (?im) (?is) (?s)… are stripped and translated to `git grep -i`
 *     (i → -i; m/s already default in git grep's line mode); `(?:` → `(`;
 *     anything else `(?…)` returns a CLASSIFIED teaching failure naming the
 *     construct and the way out — never an opaque git fatal.
 *  2. The schema description now says POSIX ERE explicitly, documents the
 *     native classes (\w \W \s \S \b \B outside brackets) and the
 *     auto-translations (\d \D \A \z \Z, (?:, leading (?i)), and tells the
 *     model to write explicit ranges inside […] — instead of "ripgrep-like".
 *
 * THE DISCRIMINATORS (fail on the old code, pass on the new):
 *  - `(?i)qwen`-style patterns RETURN MATCHES (they fatal'd before);
 *  - a lookaround/PCRE-class pattern gets the NEW classified failure text,
 *    not `fatal: -e option, … Invalid preceding regular expression`.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
  stopProcess: jest.fn(),
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
  findPriorRunPushReceipt: jest.fn(async (): Promise<any> => null),
  findPriorRunPrReceipt: jest.fn(async (): Promise<any> => null),
  prHeadMatchesReceipt: jest.fn(async (): Promise<boolean> => false),
}));

import { executeCodingTool, ToolContext } from './tools';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

let WT = '';

/** REAL execShell — mirrors agent.ts execInProcess exactly (bash -lc, cwd-locked,
 * timeout rejection reshaped to the {stdout, stderr:'[exit: …]'} infra shape).
 */
const realExec = async (command: string, cwd?: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('bash', ['-lc', command], { cwd: cwd || WT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }))
    .catch((e: any) => ({ stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]` }));
};

const mkCtx = (exec: typeof realExec = realExec): ToolContext => ({
  worktree: WT, sessionId: 'sess-1ecde029', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: exec,
}) as unknown as ToolContext;

beforeAll(async () => {
  // A worktree shaped like the incident's: the terms the filing session
  // searched for (qwen / helper / 4b, mixed case so -i is PROVEN load-bearing),
  // committed so git grep --untracked sees them.
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-1ecde029-'));
  const git = async (...args: string[]) => execFileAsync('git', args, { cwd: WT });
  await git('init', '-q', '.');
  await fs.mkdir(path.join(WT, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(WT, 'docs/model-notes.md'),
    `# notes\n` +
    `The QWEN model is tuned via helper scripts.\n` +
    `A helper macro lives here.\n` +
    `The 4b marker references model 4b.\n` +
    `plain lowercase qwen line\n`,
  );
  await fs.writeFile(path.join(WT, 'docs/other.md'), `nothing relevant\n`);
  await git('add', '.');
  await git('-c', 'user.email=replay@digby.test', '-c', 'user.name=replay', 'commit', '-qm', 'init');
}, 60_000);

afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });

describe('ticket 1ecde029 — grep (?i) PCRE-prefix replay (pre-flight ERE translation + teaching failures)', () => {
  jest.setTimeout(60_000);

  it('REPLAY: the incident pattern (?i)qwen RETURNS the matches — not the fatal it produced on 2026-10-20', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?i)qwen' });
    // The pre-fix behavior was: Tool grep failed: fatal: -e option, '(?i)qwen':
    // Invalid preceding regular expression — fix the pattern/scope, …
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('docs/model-notes.md');
    expect(out).toContain('QWEN'); // uppercase hit — -i is load-bearing, not decorative
    expect(out).toContain('qwen'); // lowercase hit
  });

  it('REPLAY: the second incident pattern (?i)helper returns matches case-insensitively', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?i)helper' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('helper'); // the lowercase macro line
    expect((out.match(/helper/g) || []).length).toBeGreaterThanOrEqual(2); // "helper scripts" + "A helper macro"
  });

  it('REPLAY: the third incident pattern (?i)4b returns matches', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?i)4b' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('4b marker');
  });

  it('the (?i) translation is proven on-case: WITHOUT it (plain pattern) case differs — no false-pass-by-accident', async () => {
    // A plain 'QWEN' pattern (no (?i) prefix) must NOT match the lowercase
    // 'qwen' line — proving the -i above comes from the translation, not from
    // a globally case-insensitive tool.
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'QWEN' });
    expect(out).toContain('QWEN model is tuned');
    expect(out).not.toContain('plain lowercase qwen');
  });

  it('stacked leading flags translate: (?im) / (?is) / (?mi) behave as case-insensitive', async () => {
    for (const p of ['(?im)qwen', '(?is)qwen', '(?mi)qwen']) {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: p });
      expect(out).not.toMatch(/^Tool grep failed:/);
      expect(out).toContain('QWEN');
      expect(out).toContain('plain lowercase qwen');
    }
  });

  it('(?m) alone stays case-SENSITIVE (m is a no-op on single-line subjects) — (?s) is covered by its own REVIEW A1 test', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?m)QWEN' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('QWEN model is tuned');
    expect(out).not.toContain('plain lowercase qwen');
  });

  it('non-capturing groups (?: … ) translate to plain ERE groups and still match — mid-pattern included', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?:qwen|helper)' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('QWEN model is tuned');
    expect(out).toContain('A helper macro');
    const mid = await executeCodingTool(mkCtx(), 'grep', { pattern: 'tuned (?:via|by) helper' });
    expect(mid).not.toMatch(/^Tool grep failed:/);
    expect(mid).toContain('tuned via helper');
  });

  it('escaped literal \\(? stays a literal — the leading-flags loop must not eat it', async () => {
    // \(? in ERE: \( is a literal paren, then ? quantifies it (zero-or-one
    // literal parens). Writing '(qwen' + escaped-lookalike shapes guards the
    // scanner against misreading an ESCAPED (? as a group.
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '\\(?i\\)qwen' });
    // No such literal text exists in the fixture ⇒ honest no-matches, NOT a
    // failure and NOT a translated search.
    expect(out).toBe('(no matches)');
  });

  it('(? inside a bracket class stays literal — a class interior is never read as a PCRE group', async () => {
    // [q(?] is the POSIX set {q, (, ?} followed by 'wen' — it matches the
    // lowercase 'qwen' line. (Guard: the scanner must not classify class
    // interiors; pre-fix there was no scanner at all — git handled this fine.)
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '[q(?]wen' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('plain lowercase qwen');
  });

  it('a leading flag set ERE cannot honour ((?x), (?u), (?a)) gets the CLASSIFIED teaching failure, not a git fatal', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?x)qwen' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?x\)' which this tool cannot translate to POSIX ERE/);
    expect(out).toContain('only a leading i/m/s translates');
    expect(out).not.toMatch(/Invalid preceding regular expression/);
  });

  it('lookarounds get the CLASSIFIED teaching failure naming the construct — the pre-fix opaque fatal is gone', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'q(?=wen)' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?=' which this tool cannot translate to POSIX ERE/);
    expect(out).toContain('no lookaround');
    expect(out).not.toMatch(/Invalid preceding regular expression/);
    const behind = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?<=q)wen' });
    expect(behind).toMatch(/^Tool grep failed: the pattern uses '\(\?<=' which this tool cannot translate to POSIX ERE/);
    expect(behind).toContain("uses '(?<='");
    expect(behind).not.toMatch(/Invalid preceding regular expression/);
  });


  it('scoped flags groups (?i: …) get the classified failure with the hoist remedy (and its cost stated)', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?i:qwen)' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?i:…\)' which this tool cannot translate to POSIX ERE/);
    expect(out).toContain('hoist the flag to a leading (?i) prefix');
    expect(out).toContain('WHOLE pattern case-insensitive');
    expect(out).not.toMatch(/Invalid preceding regular expression/);
  });

  it('mid-pattern flags (?i) AFTER content get the classified failure — they do not silently vanish', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'qwen(?i)helper' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?i\)' which this tool cannot translate to POSIX ERE/);
    expect(out).not.toMatch(/Invalid preceding regular expression/);
  });

  it('backreference-style (?P<name>…) names the construct and never reaches git', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?P<term>qwen)' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?P' which this tool cannot translate to POSIX ERE/);
    expect(out).not.toMatch(/Invalid preceding regular expression/);
  });

  // ── Review follow-up (adversarial review of the first cut) ──────────────

  it('REVIEW B1: a literal (?: inside a bracket class reaches git VERBATIM — never rewritten', async () => {
    // [(?:] is the set {(, :, ?}. The first-cut implementation's blanket
    // (?:→( rewrite silently mangled this to [(] (matching only '(' lines —
    // a false negative); the single-pass builder must copy it through.
    await fs.writeFile(path.join(WT, 'docs/classes.txt'), 'has colon : here\nhas paren ( here\nhas question ? here\n');
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '[(?:]' });
      expect(out).not.toMatch(/^Tool grep failed:/);
      expect(out).toContain('has colon : here');
      expect(out).toContain('has paren ( here');
      expect(out).toContain('has question ? here');
    } finally {
      await fs.rm(path.join(WT, 'docs/classes.txt'), { force: true });
    }
  });

  it('REVIEW A1: (?s) drops cleanly (dot never sees a newline on single-line subjects) — not case-insensitive, not a failure', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?s)QWEN' });
    expect(out).not.toMatch(/^Tool grep failed:/);
    expect(out).toContain('QWEN model is tuned'); // case-SENSITIVE: s sets no case flag
    expect(out).not.toContain('plain lowercase qwen');
  });

  it('REVIEW A1: a flags-only pattern (?i) alone is a validation failure — never a match-everything dump', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?i)' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(flags-only pattern\)' which this tool cannot translate to POSIX ERE/);
    expect(out).toContain('match EVERY line');
  });

  it('REVIEW A2: \\d translates to [0-9] — glibc ERE would otherwise match the literal letter d', async () => {
    await fs.writeFile(path.join(WT, 'docs/digits.txt'), 'model 4b here\nplain d letter here\nno digits here\n');
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: 'model \\d' });
      expect(out).not.toMatch(/^Tool grep failed:/);
      expect(out).toContain('model 4b here'); // 4 ∈ [0-9]
      expect(out).not.toContain('plain d letter here'); // the silent-wrong-match line
      const cls = await executeCodingTool(mkCtx(), 'grep', { pattern: '[\\d]' });
      expect(cls).toContain('model 4b here');
      expect(cls).not.toContain('plain d letter here');
    } finally {
      await fs.rm(path.join(WT, 'docs/digits.txt'), { force: true });
    }
  });

  it('REVIEW A2: \\d as a range endpoint is classified, and \\D inside a class is classified', async () => {
    const endpoint = await executeCodingTool(mkCtx(), 'grep', { pattern: '[a-\\d]' });
    expect(endpoint).toMatch(/^Tool grep failed: the pattern uses '\\d \(inside a bracket class, as a range endpoint\)' which this tool cannot translate to POSIX ERE/);
    const negated = await executeCodingTool(mkCtx(), 'grep', { pattern: '[\\D]' });
    expect(negated).toMatch(/^Tool grep failed: the pattern uses '\\D \(inside a bracket class\)' which this tool cannot translate to POSIX ERE/);
  });

  it('REVIEW N1: a TRAILING dash is a literal member — [\\d-] expands to digits-or-hyphen, never misclassified', async () => {
    await fs.writeFile(path.join(WT, 'docs/dash.txt'), '9digit start\nx-digit here\nplain words\n');
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '[\\d-]digit' });
      expect(out).not.toMatch(/^Tool grep failed:/);
      expect(out).toContain('9digit start'); // the 0-9 member
      expect(out).toContain('x-digit here'); // the literal trailing-dash member
      expect(out).not.toContain('plain words');
      // An ESCAPED dash before a class escape translates FAITHFULLY by
      // relocating the dash to the end of the class: PCRE's [a\-\d] is the set
      // {a, -, 0-9}, and ERE's [a0-9-] is the SAME set (a trailing dash is
      // always a literal member — probe-verified). Never a git "Invalid range
      // end" fatal, never a dropped member.
      const escaped = await executeCodingTool(mkCtx(), 'grep', { pattern: '[a\\-\\d]+' });
      expect(escaped).not.toMatch(/^Tool grep failed:/);
      expect(escaped).toContain('x-digit here'); // the escaped-dash member survives the translation
    } finally {
      await fs.rm(path.join(WT, 'docs/dash.txt'), { force: true });
    }
  });

  it('REVIEW N2: [\\w…] and [\\s…] class escapes EXPAND faithfully to POSIX class sequences (glibc reads them as literal backslash-or-letter)', async () => {
    await fs.writeFile(path.join(WT, 'docs/wclass.txt'), 'snake_case-1.5\nback\\slash w here\na b c\nplain text\n');
    try {
      const w = await executeCodingTool(mkCtx(), 'grep', { pattern: '[\\w.-]+_case' });
      expect(w).not.toMatch(/^Tool grep failed:/);
      expect(w).toContain('snake_case-1.5'); // the [:alnum:]_ expansion hits 'snake' + '_case'
      const ws = await executeCodingTool(mkCtx(), 'grep', { pattern: 'a[\\s]b' });
      expect(ws).not.toMatch(/^Tool grep failed:/);
      expect(ws).toContain('a b c'); // [[:space:]] expansion — no literal control chars in the command
      // negated class escapes are classified, not expanded
      const W = await executeCodingTool(mkCtx(), 'grep', { pattern: '[\\W]' });
      expect(W).toMatch(/^Tool grep failed: the pattern uses '\\W \(inside a bracket class\)'/);
    } finally {
      await fs.rm(path.join(WT, 'docs/wclass.txt'), { force: true });
    }
  });

  it('REVIEW N4: (?: combined with a backreference is classified — the rewrite would silently renumber it', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?:q)(wen)\\1' });
    expect(out).toMatch(/^Tool grep failed: the pattern uses '\(\?: … combined with a backreference/);
    expect(out).toContain('renumber');
    // …while (?: WITHOUT backreferences still translates and matches
    const plain = await executeCodingTool(mkCtx(), 'grep', { pattern: '(?:q)(wen)' });
    expect(plain).not.toMatch(/^Tool grep failed:/);
    expect(plain).toContain('qwen');
  });

  it('REVIEW A2: \\w \\s \\b are NATIVE glibc ERE — copied verbatim, still matching', async () => {
    await fs.writeFile(path.join(WT, 'docs/native.txt'), 'word abc wxyz\nspace a b\nunquoted word\n');
    try {
      const w = await executeCodingTool(mkCtx(), 'grep', { pattern: '\\wxyz' });
      expect(w).toContain('word abc wxyz');
      const s = await executeCodingTool(mkCtx(), 'grep', { pattern: 'a\\sb' });
      expect(s).toContain('space a b');
      const b = await executeCodingTool(mkCtx(), 'grep', { pattern: '\\bword\\b' });
      expect(b).toContain('unquoted word');
      expect(b).toContain('word abc wxyz');
    } finally {
      await fs.rm(path.join(WT, 'docs/native.txt'), { force: true });
    }
  });

  it('REVIEW A2: \\A and \\z translate to ^ and $ — anchors that work in ERE', async () => {
    const a = await executeCodingTool(mkCtx(), 'grep', { pattern: '\\AThe QWEN' });
    expect(a).not.toMatch(/^Tool grep failed:/);
    expect(a).toContain('The QWEN model is tuned');
    const z = await executeCodingTool(mkCtx(), 'grep', { pattern: 'qwen line\\z' });
    expect(z).toContain('plain lowercase qwen');
  });

  it('REVIEW A3: POSIX [:class:] sequences inside brackets are legal ERE — copied verbatim, never misread as a (? group', async () => {
    await fs.writeFile(path.join(WT, 'docs/posix-class.txt'), 'alpha X here\n9digit start\n');
    try {
      const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '[[:alpha:](?i)] here' });
      expect(out).not.toMatch(/^Tool grep failed:/);
      expect(out).toContain('alpha X here'); // :alpha: matches the X… the class ALSO has (, ?, i members
      expect(out).not.toContain('9digit start');
    } finally {
      await fs.rm(path.join(WT, 'docs/posix-class.txt'), { force: true });
    }
  });

  it('REVIEW A4: an unterminated bracket class passes through — git’s own Unmatched [ diagnostic is the honest failure', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '[abc(?i)' });
    expect(out).toMatch(/^Tool grep failed:/);
    expect(out).toContain('Unmatched [');
    expect(out).not.toBe('(no matches)');
  });

  it('SCHEMA PIN (review N6): the grep tool description documents ERE + the translations — never "ripgrep-like"', async () => {
    // The root cause was a schema that advertised a syntax family the engine
    // cannot parse. Pin the honest wording so a future edit cannot quietly
    // re-introduce the mismatch.
    const { CODING_TOOL_SCHEMA } = await import('./tools');
    const grep = (CODING_TOOL_SCHEMA as Array<{ function?: { name?: string; description?: string } }>)
      .find(t => t?.function?.name === 'grep');
    expect(grep).toBeTruthy();
    const desc = grep!.function!.description!;
    expect(desc).toContain('POSIX extended regex');
    expect(desc).toContain('LEADING (?i)'); // case-insensitive prefix documented
    expect(desc).not.toContain('ripgrep-like');
    expect(desc).toContain('auto-translated');
  });

  it('injection safety is PRESERVED: the translated pattern stays single-quote-escaped', async () => {
    const commands: string[] = [];
    const captureExec = async (command: string) => { commands.push(command); return { stdout: '', stderr: '' }; };
    await executeCodingTool(mkCtx(captureExec as typeof realExec), 'grep', { pattern: '(?i)$(touch /tmp/pwned)' });
    const cmd = commands[0];
    expect(cmd).toContain('grep -nIEi --untracked'); // the translated flag composes into -nIEi
    expect(cmd).toContain(`-e '$(touch /tmp/pwned)'`); // still single-quoted, unexpanded
    expect(cmd).not.toMatch(/-e \$\(touch/); // never unquoted
    expect(cmd).toContain('"${PIPESTATUS[0]}"'); // sentinel intact
  });

  it('plain ERE patterns are untouched: no -i flag added, alternation still works', async () => {
    const commands: string[] = [];
    const captureExec = async (command: string) => { commands.push(command); return { stdout: '', stderr: '' }; };
    await executeCodingTool(mkCtx(captureExec as typeof realExec), 'grep', { pattern: 'qwen|helper' });
    const cmd = commands[0];
    expect(cmd).toContain('grep -nIE --untracked'); // no trailing i
    expect(cmd).toContain(`-e 'qwen|helper'`);
  });

  it('b6d50f4a contract intact: an infra-killed search still fails honestly (no regression of the false-zero fix)', async () => {
    const deadExec = async () => ({ stdout: '', stderr: '[exit: 124 — timed out]' });
    const out = await executeCodingTool(mkCtx(deadExec as typeof realExec), 'grep', { pattern: '(?i)qwen' });
    expect(out).toMatch(/^Tool grep failed: the search did not complete/);
    expect(out).toContain('NOT a "no matches" verdict');
  });

  it('empty-pattern validation is unchanged', async () => {
    const out = await executeCodingTool(mkCtx(), 'grep', { pattern: '   ' });
    expect(out).toMatch(/^Tool grep failed: a pattern is required/);
  });
});
