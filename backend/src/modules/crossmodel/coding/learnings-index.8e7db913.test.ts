/**
 * Replay pin — ticket 8e7db913 (2026-09-10 breaker trip, session
 * 5b4b2396-ed41-4ae4-b29d-f3da15639857, run 66b65467-8348-4bd8-8146-781e422567b3,
 * auto-filed 23:14:12Z).
 *
 * THE INCIDENT: burn-down lane 5b4b2396 (dispatched 23:09Z to investigate the
 * sibling mishap 089d84cd) read_file'd the marker-quoting modules on a STALE
 * pre-#669 worktree: (1) learnings-index.1ad6f358.test.ts — whose header
 * comment quotes the failure markers' literal source — and (2)
 * learnings-index.service.ts itself, whose FAILURE_MARKERS block spells the
 * same literals. The pre-#669 classifier's UNANCHORED content regexes
 * (/FAILED — no schedule was created/, /\[exit: …\]/, /exceeded \d+s and was
 * aborted/) matched those QUOTED shapes inside SUCCESSFUL read results,
 * counted 3 reads as failures, tripped the derail breaker, and auto-filed
 * 8e7db913 whose "failure texts" are plain file excerpts. Third generation of
 * the 7c1e5b9f defect: 7c1e5b9f → a5f4c3aa → 1ad6f358/089d84cd → 8e7db913.
 *
 * ALREADY FIXED: PR #669 (ticket 7c1e5b9f) anchored every marker to the
 * position the harness actually authors it — quoted marker text can never sit
 * at an envelope start or the result tail. This pin proves the fix holds for
 * THIS incident's exact read results, so the ticket can close on evidence
 * instead of re-investigation (a stale-worktree lane re-trips on its own
 * snapshot until it rebases — that is the environment, not a live defect).
 *
 * NOTE on the filed evidence: the ticket's two 1200-char "failure texts" are
 * not failure-shaped under EITHER the pre-#669 or the current classifier —
 * the evidence capture truncated each read result before the content that the
 * pre-#669 classifier actually matched. Both are replayed verbatim below.
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

// ── 8e7db913's filed "Failure texts (newest first)" — verbatim ─────────────
// Text #1: an UNRANGED read_file (raw content shape) of
// learnings-index.1ad6f358.test.ts — the capture ends mid-word ("the fai") at
// the 1200-char cut, just before the marker-quoting prose that the pre-#669
// classifier matched.
const FILED_READ_1 =
  '/**\n'
  + ' * Replay pin — ticket 1ad6f358 (2026-09-10 breaker trip, session 536473e0,\n'
  + ' * run fca18838, auto-filed 22:21:40Z) and its sibling 089d84cd (session\n'
  + ' * e8be6aa7, run 745a08ff, auto-filed 22:44:25Z).\n'
  + ' *\n'
  + ' * THE INCIDENT: burn-down lane 536473e0 was investigating a5f4c3aa — the\n'
  + ' * read_file phantom-failure streak on THIS module (the 7c1e5b9f class) — and\n'
  + ' * grepped its own in-flight fix inside learnings-index.service.ts. Three\n'
  + ' * SUCCESSFUL grep results came back whose match lines quote the fai';

// Text #2: a RANGED read_file of learnings-index.service.ts starting at line
// 330 (tools.ts shapes ranged reads as `${line}\t${content}`). The capture ends
// mid-token ("for (") — the FAILURE_MARKERS block it was approaching sat just
// beyond the 1200-char cut.
const FILED_READ_2 =
  '330\t  try {\n'
  + "331\t    const hits = await memSearch([{ type: 'project', id: projectId }], query.slice(0, 2000), k, { sources: [LEARNING_SOURCE] });\n"
  + "332\t    if (!hits.length) return '';\n"
  + "333\t    const header = `[RELEVANT LEARNINGS — durable conventions from .digby/notes/learnings.md matched to this task; find more via search_memory(scope:'project', source:'learning')]`;\n"
  + '334\t    let block = header;\n'
  + '335\t    for (';

// ── The pre-#669 source the incident lane actually read (verbatim lines
// 349–369 of learnings-index.service.ts from the stale worktree, numbered in
// the ranged-read shape) — the text the pre-#669 classifier matched ON. ─────
const PRE_669_SERVICE_EXCERPT =
  '349\t// ── Retrieval: on-tool-failure requery ───────────────────────────────────────\n'
  + '350\t\n'
  + '351\t// Conservative, harness-authored failure shapes only (a read_file result that\n'
  + '352\t// merely CONTAINS the word "error" must not fire a nudge).\n'
  + '353\tconst FAILURE_MARKERS: RegExp[] = [\n'
  + '354\t  /^Tool \\S+ failed:/,                    // executeCodingTool catch-all\n'
  + '355\t  /^\\{\\s*"ok":\\s*false/,                  // platform tools\' structured refusal envelope (JSON.stringify …,null,1)\n'
  + '356\t  /^Verify FAILED at/,                    // verify tool\n'
  + '357\t  /^git commit failed:/,\n'
  + '358\t  /^COMMIT BLOCKED/,\n'
  + '359\t  /^Opening the PR failed:/,\n'
  + '360\t  /FAILED — no schedule was created/,\n'
  + '361\t  /\\[exit: (?!0[\\]\\s])[^\\]\\n]{0,40}\\]/,   // run_command non-zero exit marker\n'
  + '362\t  /exceeded \\d+s and was aborted/,        // agent-loop hard-timeout backstop\n'
  + '363\t];\n'
  + '364\t\n'
  + '365\t/** True when a tool result is one of the harness\'s failure shapes. */\n'
  + '366\texport function looksLikeToolFailure(result: string): boolean {\n'
  + '367\t  const text = (result || \'\').slice(0, 4000);\n'
  + '368\t  return FAILURE_MARKERS.some(re => re.test(text));\n'
  + '369\t}';

// ── The incident classifier (historical, pre-#669): the three UNANCHORED
// content regexes that fired on quoted marker text. Embedded verbatim so the
// replay cannot pass vacuously — if the current classifier ever regresses to
// matching these shapes mid-string, the contrast assertions below fail. ─────
const PRE_669_UNANCHORED: RegExp[] = [
  /FAILED — no schedule was created/,
  /\[exit: (?!0[\]\s])[^\]\n]{0,40}\]/,
  /exceeded \d+s and was aborted/,
];
const pre669Fires = (result: string): boolean =>
  PRE_669_UNANCHORED.some((re) => re.test((result || '').slice(0, 4000)));

// Live source of the two modules the incident lane read (self-updating: any
// future marker edit must keep them safe to READ).
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'learnings-index.service.ts'), 'utf8');
const SIBLING_PIN_SOURCE = fs.readFileSync(path.join(__dirname, 'learnings-index.1ad6f358.test.ts'), 'utf8');

/** tools.ts's ranged-read_file result shape: slice the range, then `${line}\t${content}` per line. */
const asRangedRead = (content: string, startLine: number): string =>
  content.split('\n').slice(startLine - 1).map((l, i) => `${startLine + i}\t${l}`).join('\n');

describe('ticket 8e7db913 — read_file results quoting failure-marker source are NOT failures', () => {
  it.each([
    ['filed text #1 (unranged read of the 1ad6f358 replay pin, mid-word cut)', FILED_READ_1],
    ['filed text #2 (ranged read of learnings-index.service.ts from line 330, mid-token cut)', FILED_READ_2],
  ])('%s', (_label, text) => {
    expect(looksLikeToolFailure(text)).toBe(false);
  });

  it('the filed 1200-char captures fire NEITHER classifier — the capture truncated before the matching content', () => {
    // Why the ticket's evidence looked benign: the pre-#669 classifier matched
    // marker text beyond the 1200-char evidence cut; the captures themselves
    // are inert under both classifiers.
    expect(pre669Fires(FILED_READ_1)).toBe(false);
    expect(pre669Fires(FILED_READ_2)).toBe(false);
  });

  it.each([
    ['learnings-index.service.ts (raw read_file shape)', SERVICE_SOURCE],
    ['learnings-index.service.ts as a ranged read from line 330 (the incident shape)', asRangedRead(SERVICE_SOURCE, 330)],
    ['learnings-index.1ad6f358.test.ts (quotes the marker literals in prose)', SIBLING_PIN_SOURCE],
  ])('the module the incident lane read is safe to read today: %s', (_label, text) => {
    expect(looksLikeToolFailure(text)).toBe(false);
  });
});

describe('anti-vacuity — the incident classifier (pre-#669, unanchored) DID fire on these reads', () => {
  it('the verbatim pre-#669 service excerpt fires the historical classifier, not the current one', () => {
    // The defect mechanism: the module's own marker literals matched themselves.
    expect(pre669Fires(PRE_669_SERVICE_EXCERPT)).toBe(true);
    expect(looksLikeToolFailure(PRE_669_SERVICE_EXCERPT)).toBe(false);
  });

  it('even the FIXED modules would have tripped a pre-#669 lane — their comments quote the old shapes', () => {
    // The classifier windows only the first 4000 chars of a result: the
    // incident's RANGED read (line 330+) pulled the marker-quoting comment
    // into that window, and the sibling pin's quoting prose sits in its
    // header. If either file ever stops quoting the marker shapes inside the
    // window this leg fails — intentionally: the replay must stay honest
    // about WHY the incident was possible (a stale-worktree lane reading ANY
    // revision of this module, fixed or not, racked up phantom failures).
    expect(pre669Fires(asRangedRead(SERVICE_SOURCE, 330))).toBe(true);
    expect(pre669Fires(SIBLING_PIN_SOURCE)).toBe(true);
    // …while a whole-file read of today's service keeps the quoting comment
    // BEYOND the 4000-char window — pinned here as the window's boundary doc.
    expect(pre669Fires(SERVICE_SOURCE)).toBe(false);
  });

  it('a quoted [exit: N] mid-string fired historically; today only the authored tail envelope fires', () => {
    const quoted = 'investigating the log excerpt: [exit: 1] from earlier\nfinal line of real output';
    expect(pre669Fires(quoted)).toBe(true);
    expect(looksLikeToolFailure(quoted)).toBe(false);
    // The authored shape still fires (run_command's own tail marker) — control.
    expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
  });
});
