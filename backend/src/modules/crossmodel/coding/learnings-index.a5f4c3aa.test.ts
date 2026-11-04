/**
 * REPLAY — ticket a5f4c3aa (2026-09-10, mishap, priority 0): "3× tool-failure
 * streak: read_file on 'Open Feedback Ticket Burn-Down' — framework or model?"
 * Session 536473e0-67e4-4213-83c8-6929fb9b3833, run fca18838-402a-4d31-8cbc-
 * 2258cf1227b7; tool read_file; the lane's reasoning named grep.
 *
 * WHAT THE LANE DID: two read_file calls on learnings-index.service.ts windows
 * that BOTH carried the FAILURE_MARKERS source block inside the breaker's
 * 1200-char capture (agent.ts: `String(result).slice(0, 1200)`). The ticket's
 * "failure texts" are ordinary file content with line-number prefixes — the
 * reads SUCCEEDED.
 *
 * ROOT CAUSE (deterministic framework bug, not model behavior): the breaker
 * counts a result as a failure via looksLikeToolFailure, whose UNANCHORED
 * marker /\[exit: (?!0[\]\s])[^\]\n]{0,40}\]/ matched its OWN regex source
 * text inside the payload — the literal characters `[exit: (?!0[\]` satisfy
 * the pattern (pinned in test 1). Two benign reads = streak 2, plus the
 * intent-mismatch fast-trip weight (reasoning mentioned grep) = 3 → breaker
 * tripped, read_file was withheld, and this phantom mishap was auto-filed.
 *
 * THE SHIPPED FIX (#669, sibling ticket 7c1e5b9f — same bug class, fixed
 * mid-flight while this PR was open): every marker is anchored to the
 * position the harness actually authors it — prefix envelopes ^-anchored
 * (⚠️ schedule_self FAILED …, Tool "<name>" exceeded Ns and was aborted) and
 * the run_command exit marker TAIL-anchored (/(?:^|\n)\[exit: …\]\s*$/ on the
 * result's last 500 chars — it is written as a `\n[exit: N]` suffix).
 * Line-number-prefixed read_file/grep payloads can never match it, and a
 * >4000-char output still surfaces its tail marker. THIS FILE pins the
 * a5f4c3aa incident against the shipped semantics so the close evidence
 * cites its own ticket id (the verified-close mishap gate).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import * as fs from 'fs';
import * as path from 'path';
import { looksLikeToolFailure } from './learnings-index.service';

// The pre-fix marker, reproduced verbatim from the pre-fix FAILURE_MARKERS
// list — the detection semantics the lane was judged by.
const LEGACY_EXIT_MARKER = /\[exit: (?!0[\]\s])[^\]\n]{0,40}\]/;

const SRC = fs.readFileSync(path.join(__dirname, 'learnings-index.service.ts'), 'utf8').split('\n');

/** read_file-style payload: 1-based line number + TAB + content, joined; the
 *  breaker captured String(result).slice(0, 1200) — mirror that exactly. */
function readFilePayload(lines: string[], startLine: number, count: number): string {
  return lines
    .slice(startLine - 1, startLine - 1 + count)
    .map((l, i) => `${startLine + i}\t${l}`)
    .join('\n')
    .slice(0, 1200);
}

// The trap: the exit-marker's own source line inside the service file (needle
// matches both the pre-fix FAILURE_MARKERS line and the shipped
// EXIT_MARKER_TAIL_RE line — wherever the marker source lives).
const markerSourceLineIdx = SRC.findIndex(l => l.includes('\\[exit: (?!0[\\]\\s])'));
const markersBlockIdx = SRC.findIndex(l => l.includes('const FAILURE_MARKERS'));

describe('ticket a5f4c3aa replay — read_file payloads must never be failure-shaped', () => {
  test('1. mechanism pin: the legacy unanchored [exit: marker matches its OWN regex source', () => {
    expect(markerSourceLineIdx).toBeGreaterThan(-1);
    const sourceLine = SRC[markerSourceLineIdx];
    expect(sourceLine).toContain('[exit:');
    // The deterministic false-positive: the pattern matches the literal text
    // of its own definition (the "exit code" it captures is regex syntax).
    expect(LEGACY_EXIT_MARKER.test(sourceLine)).toBe(true);
  });

  test('2. the lane\'s reads, reconstructed: capture windows carrying the marker source are NOT failures', () => {
    expect(markersBlockIdx).toBeGreaterThan(-1);
    expect(markerSourceLineIdx).toBeGreaterThan(markersBlockIdx); // sanity: the trap lives in the markers block
    // Window A — starts just above the marker source (the ticket's first
    // failure text: a read whose 1200-char capture carried the [exit: source).
    const trapLine1 = markerSourceLineIdx + 1; // 1-based
    const a = readFilePayload(SRC, trapLine1 - 6, 15);
    // Window B — starts further up (the ticket's second text: a retrieval-
    // region read whose 1200-char capture reached INTO the markers).
    const b = readFilePayload(SRC, trapLine1 - 9, 20);
    for (const payload of [a, b]) {
      expect(payload).toContain('[exit:'); // both really carry the trap
      expect(LEGACY_EXIT_MARKER.test(payload)).toBe(true); // pre-fix: counted as failures
      expect(looksLikeToolFailure(payload)).toBe(false); // shipped: benign content
    }
  });

  test('3. the ticket\'s filed failure texts, verbatim: not failure-shaped', () => {
    // Bullet 1 (newest), exactly as filed (line-number-prefixed file content):
    const filed1 = [
      '346\t  }', '347\t}', '348\t', '349\t// ── Retrieval: on-tool-failure requery ───────────────────────────────────────',
      '350\t', '351\t// Conservative, harness-authored failure shapes only (a read_file result that',
      '352\t// merely CONTAINS the word "error" must not fire a nudge).', '353\tconst FAILURE_MARKERS: RegExp[] = [',
      '354\t  /^Tool \\S+ failed:/,                    // executeCodingTool catch-all',
      '355\t  /^\\{\\s*"ok":\\s*false/,                  // platform tools\' structured refusal envelope (JSON.stringify …,null,1)',
      '356\t  /^',
    ].join('\n');
    // Bullet 2, exactly as filed (buildLearningsBlock retrieval region):
    const filed2 = [
      '270\t    const hits = await memSearch([{ type: \'project\', id: projectId }], query.slice(0, 2000), k, { sources: [LEARNING_SOURCE] });',
      '271\t    if (!hits.length) return \'\';',
      '272\t    const header = `[RELEVANT LEARNINGS — durable conventions from .digby/notes/learnings.md matched to this task; find more via search_memory(scope:\'project\', source:\'learning\')]`;',
      '273\t    let block = header;',
      '274\t    for (const h of hits) {',
      '275\t      const line = `\\n- ${h.content.slice(0, INJECT_ENTRY_CAP)}`;',
      '276\t      if (',
    ].join('\n');
    expect(looksLikeToolFailure(filed1)).toBe(false);
    expect(looksLikeToolFailure(filed2)).toBe(false);
  });

  test('4. run_command keeps its [exit: N] tail detection (breaker + nudger coverage preserved)', () => {
    expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
    expect(looksLikeToolFailure('build died\n[exit: 137 — timed out]')).toBe(true);
    expect(looksLikeToolFailure('ok\n[exit: 0]')).toBe(false); // exit 0 is not a failure
  });

  test('5. content tools are not failed by quoted logs/source either', () => {
    expect(looksLikeToolFailure('backend/x.test.ts:290:expect(looksLikeToolFailure(\'build died\\n[exit: 137 — timed out]\')).toBe(true);')).toBe(false);
    expect(looksLikeToolFailure('- the SIGKILL-137 verify-death signature: [exit: 137 — timed out] mid-line, never at a line start')).toBe(false);
  });

  test('6. anchored envelopes still fire — and their quoted source does NOT', () => {
    // tools.ts schedule_self refusal envelope (starts with the ⚠️ prefix):
    expect(looksLikeToolFailure('⚠️ schedule_self FAILED — no schedule was created. Shorten the prompt (max 8000 chars).')).toBe(true);
    // …but a read_file window quoting that producer line must not fire:
    expect(looksLikeToolFailure('1983\t        if (!res.ok) return `⚠️ schedule_self FAILED — no schedule was created. ${res.error}`;')).toBe(false);
    // agent-loop hard-timeout abort line (agent.ts:2172) at result start:
    expect(looksLikeToolFailure('Tool "grep" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe(true);
    // …but content quoting it mid-string must not fire:
    expect(looksLikeToolFailure('2172\t              () => resolve(`Tool "${tc.name}" exceeded ${Math.round(TOOL_HARD_TIMEOUT_MS / 1000)}s and was aborted. Do not retry it; proceed with what you have.`),')).toBe(false);
  });

  test('7. a GENUINE read_file failure still counts (breaker protection preserved)', () => {
    expect(looksLikeToolFailure('Tool read_file failed: path resolves outside the worktree')).toBe(true);
    expect(looksLikeToolFailure('{\n "ok": false,\n "reason": "ungrounded_id"\n}')).toBe(true);
  });
});
