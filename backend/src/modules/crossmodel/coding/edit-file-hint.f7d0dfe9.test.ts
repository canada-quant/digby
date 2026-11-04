/**
 * REPLAY PIN — ticket f7d0dfe9 (mishap, auto-filed 2026-10-26T04:20:45Z by the
 * tool-failure-streak breaker): "3× tool-failure streak: edit_file on
 * 'ticket 0ef6794e: log-signal sweep: adjud' — framework or model?"
 *
 * ADJUDICATION (this lane, 2026-10-26): MODEL BEHAVIOR — no deterministic
 * framework defect; the edit_file miss diagnostics (#1900, #1929, #1968) and
 * the streak breaker both worked as designed.
 *
 * THE INCIDENT: session 22784bba (lane for ticket 0ef6794e) was authoring the
 * NEW leaf backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts
 * inside its own worktree. Three edit_file calls (run ef24a8be) missed with
 * saturation-delta hints:
 *   · nearest match is 100% similar at lines 113–148 but line 113 differs at
 *     col 1: file '' vs yours '/** A machine-close evidence block (closure-e…
 *   · nearest match is 100% similar at lines 115–148 but line 115 differs at
 *     col 1: file 'const MACHINE_CLOSE_BLOCK_RE = /\\[machine-clo…' vs yours
 *     '/** A repo-relative path token inside an evid…'
 *   · nearest match is 100% similar at lines 115–147 but line 115 differs …
 *
 * WHY IT IS THE MODEL, NOT THE FRAMEWORK (run-level evidence, this lane):
 *   1. PHANTOM CONTENT — the model's "yours" lines quote docstring shapes the
 *      file never had ('A repo-relative path token inside an evid…' exists
 *      nowhere in the file the lane produced; its only "token" line is the
 *      final replay-test docstring — read_session_file + nl this run). The
 *      file was ALSO mid-construction: attempt 1's named line 113 was an
 *      EMPTY line the model assumed held the machine-close docstring (text 3:
 *      the file was LESS complete than the model assumed); attempts 2/3 quote
 *      a docstring MORE complete than the file had. Stale/planned-content
 *      quotes mid-authoring — exactly the class probes (d)/(e) exist for.
 *   2. THE HINT'S FILE EXCERPTS ARE REAL BYTES — 'const MACHINE_CLOSE_BLOCK_RE
 *      = /\\[machine-clo…' is the file's actual constant (final position 113;
 *      position 115 at the failing moments — the region shifted 2 lines as the
 *      lane kept landing edits between the misses).
 *   3. "100% similar BUT line differs" IS THE DESIGNED saturation-delta
 *      output (tickets 065a5b5f/#1929 + 8a988455/#1968): at token saturation
 *      the percentage is blind to the surviving bytes, so the hint names the
 *      first differing line+column with raw windowed excerpts — the only
 *      signal that can break an "I quoted it right" assumption.
 *   4. THE RUN SELF-RECOVERED — get_run_receipts on run ef24a8be shows it
 *      still RUNNING at step 114 after the streak (verify receipts at
 *      04:46Z/04:49Z), with the file's final content containing BOTH constants
 *      the failing edits were inserting. The 3-miss streak tripped the breaker
 *      (this ticket) and the lane kept working — the designed self-heal path
 *      (owner doctrine 2026-09-10), not a derailed run.
 *
 * META-CONFIRMATION: while writing THIS pin, edit_file missed 2× on this very
 * file with the same hint shape (a trailing space after an embedded comment
 * terminator, at 100% similarity, named line/col/excerpts all honest) — the
 * diagnostic fired correctly on its own pin author.
 *
 * FIXTURE SOURCING (independent-review round 2026-10-26, findings F1/F2): the
 * incident-class fixture is built FROM THE LEAF ITSELF — read at runtime from
 * backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts (on
 * origin/main since PR #1980) — so byte-fidelity is structural. The first cut
 * hand-typed "verbatim" constants and one drifted (';' pushed inside the
 * regex literal: '\\b;/' vs the file's '\\b/;') with nothing asserting it.
 * The exact-string assertions below pin those bytes. Fixture 2 is a SYNTHETIC
 * token-neutral line — a generic probe of the #1929 windowing class, not
 * incident bytes.
 *
 * WHAT THIS FILE PINS (so a future "fix" cannot make the hint less honest or
 * the breaker blind to this exact shape):
 *   - INCIDENT CLASS (fixture 1, a phantom docstring swap at j=3 / col 21):
 *     the (e) branch fires at 100% with the named line ACTUALLY differing
 *     from the old_string's line at that window offset, and both excerpts
 *     recoverable from their real lines;
 *   - #1929 WINDOWING CLASS (fixture 2, a token-neutral diff at col 393 past
 *     the pre-#1929 80-char line-start cut): the windowed excerpts around the
 *     diff are NOT identical (the dead-end class the (e) rewrite closed) and
 *     remain recoverable from their real lines after stripping the windowing
 *     ellipses;
 *   - BREAKER VISIBILITY of the LIVE hint: the computed hint, composed through
 *     clipEditFileHint into the real refusal envelope, is failure-shaped to
 *     looksLikeToolFailure (clipEditFileHint BOUNDS the tail ≤300; the
 *     ']'→'］' neutralization BRANCH is pinned in the 065a5b5f suite — the (e)
 *     excerpt cuts at the first ']' (edit-file-hint.ts win()) before a raw
 *     ']' can surface here, so this suite does not re-pin it);
 *   - the ticket's THREE VERBATIM failure texts are failure-shaped;
 *   - DETECTOR-RECALL REPLAY: the edit_file marker family's prior true
 *     positives still fire, plus adjacent anchored markers, and the anchored
 *     precision (narration / mid-string quotes) still holds;
 *   - the 7c1e5b9f SELF-REFERENTIAL GUARD: reading this test's own source,
 *     learnings-index.service.ts and tools.ts never phantom-trips the breaker.
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
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 0),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
    INDEX_SWEPT: 'index_swept',
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import { editFileMissDiagnostic, clipEditFileHint } from './edit-file-hint';
import { looksLikeToolFailure } from './learnings-index.service';

// ── The leaf's REAL bytes, read from the file itself (F1/F2: byte-fidelity is
// structural — the incident-class fixture is BUILT from these, never
// hand-typed). Predicates are col-0 openers/constants, unique against the
// module docstring's prose mentions of the same shapes. ────────────────────
const LEAF_PATH = path.join(__dirname, '../fleet/log-signal-adjudication.ts');
const LEAF_LINES = fs.readFileSync(LEAF_PATH, 'utf8').split('\n');
const leafLine = (pred: (l: string) => boolean): string => {
  const i = LEAF_LINES.findIndex(pred);
  expect(i).toBeGreaterThanOrEqual(0); // the byte this pin anchors on exists
  return LEAF_LINES[i];
};
const MC_DOC = leafLine(l => l.startsWith('/** A machine-close evidence block'));
const MC = leafLine(l => l.startsWith('const MACHINE_CLOSE_BLOCK_RE'));
const REPLAY_DOC = leafLine(l => l.startsWith('/** A repo-relative replay-test path token'));
const REPLAY_CONST = leafLine(l => l.startsWith('const REPLAY_PATH_RE'));
// The rowReplayPin doc block + function body — the region the failing edits
// were re-quoting: from the last '/**' line before the export through the
// function's column-0 closing brace.
const exportIdx = LEAF_LINES.findIndex(l => l.startsWith('export function rowReplayPin'));
expect(exportIdx).toBeGreaterThanOrEqual(0);
const docStart = LEAF_LINES.lastIndexOf('/**', exportIdx - 1);
expect(docStart).toBeGreaterThanOrEqual(0);
const fnRel = LEAF_LINES.slice(exportIdx, exportIdx + 80).indexOf('}');
expect(fnRel).toBeGreaterThanOrEqual(0);
const PIN_REGION = LEAF_LINES.slice(docStart, exportIdx + fnRel + 1);

const head = (n: number): string[] => Array.from({ length: n }, (_, i) => `// pad ${i + 1}`);

// FIXTURE 1 — the INCIDENT class: the model's old_string mixes the file's real
// bytes with a PHANTOM docstring ('A repo-relative path token inside an
// evidence block.') the file never had. At the failing moments MC sat at line
// 115 (the incident hint's own named line), so the reconstruction pads 113
// lines: MC_DOC at 114, MC at 115, REPLAY_DOC at 117 (col 21: 'replay' vs
// 'path' after the shared '/** A repo-relative ' prefix).
const CUR = [...head(113), MC_DOC, MC, '', REPLAY_DOC, REPLAY_CONST, '', ...PIN_REGION].join('\n');
const CUR_LINES = CUR.split('\n');
const PHANTOM_DOC = '/** A repo-relative path token inside an evidence block. */';
const OLD = [MC_DOC, MC, '', PHANTOM_DOC, REPLAY_CONST, '', ...PIN_REGION].join('\n');
const OLD_LINES = OLD.split('\n');

// FIXTURE 2 — SYNTHETIC (the #1929 windowing class, not incident bytes): a
// token-neutral byte diff (a doubled ';') at col 393, PAST the pre-#1929
// 80-char line-start cut, so line-start excerpts would come out IDENTICAL on
// both sides (the dead end (e) closed).
const LONG_LINE = '  const out: AdjudicationVerdict = { suppressed: false, ticketId: row.id, fingerprintHash: (asCtx(row.context).fingerprintHash as string) ?? null, cycles: rowAdjudicationCycles(row), baseline: rowBaseline(row), bar: parseAdjudicatedReopenBar(row), pin: rowReplayPin(row), verdict: \'not-suppressed: the fail direction stays open and every lookup miss files exactly as before this leaf existed; tail padding to push the diff past the 80-char line-start cut of the pre-1929 dead end';
const LONG_LINE_REGRESSED = LONG_LINE.replace('existed; tail', 'existed;; tail');
const CUR2 = [...head(108), MC_DOC, MC, '', REPLAY_DOC, REPLAY_CONST, '', LONG_LINE, '', ...PIN_REGION].join('\n');
const OLD2 = CUR2.replace(LONG_LINE, LONG_LINE_REGRESSED);
const CUR2_LINES = CUR2.split('\n');

// The ticket's three failure texts, VERBATIM (… and – are the hint's own).
const INCIDENT_TEXTS = [
  'old_string not found in backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts. Read the file and match exactly. [edit_file hint: nearest match is 100% similar at lines 115–147 but line 115 differs at col 1: file \'const MACHINE_CLOSE_BLOCK_RE = /\\[machine-clo…\' vs yours \'/** A repo-relative path token inside an evid…\' — copy the file\'s line 115 byte-exactly]',
  'old_string not found in backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts. Read the file and match exactly. [edit_file hint: nearest match is 100% similar at lines 115–148 but line 115 differs at col 1: file \'const MACHINE_CLOSE_BLOCK_RE = /\\[machine-clo…\' vs yours \'/** A repo-relative path token inside an evid…\' — copy the file\'s line 115 byte-exactly]',
  'old_string not found in backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts. Read the file and match exactly. [edit_file hint: nearest match is 100% similar at lines 113–148 but line 113 differs at col 1: file \'\' vs yours \'/** A machine-close evidence block (closure-e…\' — copy the file\'s line 113 byte-exactly]',
];

const ENVELOPE = (hint: string) =>
  `old_string not found in backend/src/modules/crossmodel/fleet/log-signal-adjudication.ts. Read the file and match exactly. [edit_file hint: ${hint}]`;

// The (e) hint's full output shape (edit-file-hint.ts:176).
const E_RE = /nearest match is (\d+)% similar at lines (\d+)–(\d+) but line (\d+) differs at col (\d+): file '([^']*)' vs yours '([^']*)' — copy the file's line \d+ byte-exactly/;

// Strip the hint's windowing ellipses (LEADING '…' when from > 0, TRAILING
// '…' when the window is cut — edit-file-hint.ts:174) — the surviving bytes
// are the excerpt's recoverable core.
const excerptCore = (s: string) => s.replace(/^…/, '').replace(/…$/, '');

describe('f7d0dfe9 replay pin — edit_file saturation-delta honesty on a mid-authoring stale quote', () => {
  describe('fixture 1 — the incident class (phantom docstring swap)', () => {
    it('fixture fidelity: constants are the leaf\'s REAL bytes (F1 pin: the \';\' OUTSIDE the regex literal), MC at line 115 mirroring the incident hint, the phantom exists nowhere in the file', () => {
      // The two constants the failing edits were inserting — pinned exactly
      // (the first cut hand-typed these and drifted at the ';' boundary).
      expect(MC).toBe('const MACHINE_CLOSE_BLOCK_RE = /\\[machine-close evidence: ([^\\]]+)\\]/g;');
      expect(REPLAY_CONST).toBe('const REPLAY_PATH_RE = /[\\w./-]+\\.(?:ts|tsx|js|py)\\b/;');
      expect(REPLAY_CONST.endsWith('\\b/;')).toBe(true); // ';' OUTSIDE the regex literal — the F1 drift class
      expect(REPLAY_DOC).toBe('/** A repo-relative replay-test path token. */');
      // The reconstruction mirrors the incident's file state: line 115 IS the
      // MC constant the incident hint named.
      expect(CUR_LINES[114]).toBe(MC);
      // …and the phantom docstring the model quoted is nowhere in it.
      expect(CUR).not.toContain('A repo-relative path token inside an evidence block');
      expect(OLD).toContain(PHANTOM_DOC);
    });

    it('fires the (e) saturation-delta branch at TRUE 100% token saturation (the incident\'s figure, not a rounding artifact)', () => {
      const hint = editFileMissDiagnostic(CUR, OLD);
      const m = E_RE.exec(hint);
      expect(m).not.toBeNull();
      expect(m![1]).toBe('100');
    });

    it('HONESTY: the named line ACTUALLY differs from the old_string\'s line at that window offset (j > 0 — an off-by-window-start regression names the WRONG line\'s bytes)', () => {
      const m = E_RE.exec(editFileMissDiagnostic(CUR, OLD))!;
      const [, , from, , diffLine] = m;
      const fileLine = CUR_LINES[Number(diffLine) - 1];
      const oldLine = OLD_LINES[Number(diffLine) - Number(from)];
      expect(Number(diffLine) - Number(from)).toBeGreaterThan(0); // j > 0
      expect(fileLine).toBeDefined();
      expect(oldLine).toBeDefined();
      expect(fileLine).not.toBe(oldLine);
    });

    it('HONESTY: the named column is byte-exact (common prefix, first differing byte) and both excerpts recover from their real lines', () => {
      const m = E_RE.exec(editFileMissDiagnostic(CUR, OLD))!;
      const [, , from, , diffLine, col, fileExcerpt, yoursExcerpt] = m;
      const fileLine = CUR_LINES[Number(diffLine) - 1];
      const oldLine = OLD_LINES[Number(diffLine) - Number(from)];
      const c = Number(col) - 1;
      expect(fileLine.slice(0, c)).toBe(oldLine.slice(0, c)); // common prefix
      expect(fileLine[c]).not.toBe(oldLine[c]); // first differing byte
      expect(fileExcerpt).not.toBe(yoursExcerpt); // never the dead-end identical pair
      expect(fileLine.includes(excerptCore(fileExcerpt))).toBe(true);
      expect(oldLine.includes(excerptCore(yoursExcerpt))).toBe(true);
    });
  });

  describe('fixture 2 — the #1929 windowing class (synthetic token-neutral diff past the line-start cut)', () => {
    it('fires (e) at 100% with the diff column PAST 80 (where pre-#1929 line-start excerpts came out identical on both sides)', () => {
      const m = E_RE.exec(editFileMissDiagnostic(CUR2, OLD2))!;
      expect(m).not.toBeNull();
      expect(m![1]).toBe('100');
      expect(Number(m![5])).toBeGreaterThan(80);
    });

    it('HONESTY: the windowed excerpts are NOT identical (the pre-#1929 dead end would return identical line-start excerpts here) and recover from their real lines', () => {
      const m = E_RE.exec(editFileMissDiagnostic(CUR2, OLD2))!;
      const [, , from, , diffLine, col, fileExcerpt, yoursExcerpt] = m;
      const fileLine = CUR2_LINES[Number(diffLine) - 1];
      const oldLine = OLD2.split('\n')[Number(diffLine) - Number(from)];
      expect(fileExcerpt).not.toBe(yoursExcerpt);
      expect(fileLine.includes(excerptCore(fileExcerpt))).toBe(true);
      expect(oldLine.includes(excerptCore(yoursExcerpt))).toBe(true);
      const c = Number(col) - 1;
      expect(fileLine.slice(0, c)).toBe(oldLine.slice(0, c));
      expect(fileLine[c]).not.toBe(oldLine[c]);
    });

    it('the LIVE hint stays breaker-visible: clipEditFileHint BOUNDS it (≤300) and the composed real envelope is failure-shaped', () => {
      // A >300-char tail would push the hint body past the failure markers'
      // {0,320} windowed-tail class and the refusal would read as SUCCESS to
      // the breaker — the bound is what keeps the live hint counted.
      const hint = editFileMissDiagnostic(CUR2, OLD2);
      const clipped = clipEditFileHint(hint);
      expect(clipped.length).toBeLessThanOrEqual(300);
      expect(looksLikeToolFailure(ENVELOPE(clipped))).toBe(true);
      // …and fixture 1's live hint likewise.
      const clipped1 = clipEditFileHint(editFileMissDiagnostic(CUR, OLD));
      expect(clipped1.length).toBeLessThanOrEqual(300);
      expect(looksLikeToolFailure(ENVELOPE(clipped1))).toBe(true);
      // (The ']'→'］' neutralization BRANCH — a raw ']' riding a copy target —
      // is pinned in agent-derail-break.065a5b5f.test.ts:285; the (e) excerpt
      // cuts at the first ']' (edit-file-hint.ts win()) before one can surface
      // here, so this suite does not re-pin it.)
    });
  });

  describe('the breaker counted the incident (detector recall — edit_file marker family)', () => {
    it('all three VERBATIM failure texts from the ticket are failure-shaped', () => {
      for (const t of INCIDENT_TEXTS) {
        expect(looksLikeToolFailure(t)).toBe(true);
      }
    });

    it('prior true positives still fire: the bare refusal, a generic hint-tailed refusal, the count>1 sibling marker, and the adjacent anchored markers', () => {
      expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly.')).toBe(true);
      expect(looksLikeToolFailure(
        "old_string not found in note.ts. Read the file and match exactly. [edit_file hint: nearest match is 83% similar at lines 1–1: 'import { a, b, c } from './x';' — re-read that region and quote it byte-exactly]",
      )).toBe(true);
      expect(looksLikeToolFailure(
        'old_string appears 2× in note.ts — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 4, 9 — widen old_string with surrounding context unique to your target]',
      )).toBe(true);
      expect(looksLikeToolFailure('Tool edit_file failed: boom')).toBe(true);
      expect(looksLikeToolFailure('No generated file with id file_abc123 belongs to this user.')).toBe(true);
      expect(looksLikeToolFailure('schedule_self FAILED — no schedule was created')).toBe(true);
      expect(looksLikeToolFailure('line one\n[exit: 1]')).toBe(true);
    });

    it('anchored precision holds: narration after a hint tail, a mid-string quote, and the staged-confirmation envelope never phantom-trip (7c1e5b9f / 1ab1a52b)', () => {
      expect(looksLikeToolFailure(
        'old_string not found in README.md. Read the file and match exactly. [edit_file hint: nearest match is 95% similar at lines 1–1] — then I re-read it',
      )).toBe(false);
      expect(looksLikeToolFailure(
        "2298:        if (count === 0) return `old_string not found in ${args.path}. Read the file and match exactly.`;",
      )).toBe(false);
      expect(looksLikeToolFailure(
        'I considered the refusal \'old_string not found in x.ts. Read the file and match exactly.\' and decided to re-read.',
      )).toBe(false);
      expect(looksLikeToolFailure('{\n  "ok": false,\n  "needsConfirmation": true,\n  "confirmationId": "cf_123"\n}')).toBe(false);
    });

    it('SELF-REFERENTIAL GUARD (7c1e5b9f): reading this test\'s own source, learnings-index.service.ts and tools.ts never trips the breaker', () => {
      const ownSrc = fs.readFileSync(__filename, 'utf8');
      expect(ownSrc).toContain('old_string not found in'); // the literals are really here
      const lines = ownSrc.split('\n');
      for (let start = 0; start < lines.length; start += 40) {
        const window = lines
          .slice(start, start + 40)
          .map((l, i) => `${start + i + 1}\t${l}`)
          .join('\n');
        expect(looksLikeToolFailure(window)).toBe(false);
      }
      expect(looksLikeToolFailure(ownSrc)).toBe(false);
      const markerSrc = fs.readFileSync(path.join(__dirname, 'learnings-index.service.ts'), 'utf8');
      expect(markerSrc).toContain('old_string not found in');
      expect(looksLikeToolFailure(markerSrc)).toBe(false);
      const toolsSrc = fs.readFileSync(path.join(__dirname, 'tools.ts'), 'utf8');
      expect(toolsSrc).toContain('old_string not found in');
      expect(looksLikeToolFailure(toolsSrc)).toBe(false);
    });
  });

  describe('the recovery path (why the run finished)', () => {
    it('a quote re-anchored on the file\'s TRUE bytes is an exact substring — the edit lands on the count>0 path and no refusal is ever authored', () => {
      const reanchored = [MC_DOC, MC, '', REPLAY_DOC, REPLAY_CONST, '', ...PIN_REGION].join('\n');
      expect(CUR.includes(reanchored)).toBe(true);
    });
  });
});
