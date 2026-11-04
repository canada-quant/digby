/**
 * Replay pin — ticket 7c1e5b9f (2026-09-10 breaker trip, session b92ef13f,
 * run 668d02ca, auto-filed 10:48:54Z).
 *
 * THE INCIDENT: a burn-down lane investigating ticket 8579d419 (the derail
 * breaker itself) read learnings-index.service.ts — the module that DEFINES
 * the failure markers — plus goals.service.ts, all SUCCESSFULLY. Three of
 * looksLikeToolFailure's markers were UNANCHORED content regexes:
 *   /FAILED — no schedule was created/      → matches its own source line
 *   /\[exit: (?!0[\]\s])[^\]\n]{0,40}\]/    → matches its own source line
 *   /exceeded \d+s and was aborted/         → matches any quoted abort text
 * so the successful read_file results were COUNTED as failures, the 3×
 * read_file streak tripped the derail breaker (read_file withheld), and the
 * auto-filed mishap's "failure texts" were plain file excerpts. (The grep
 * output among them matched nothing — it was swept in by the pre-#656
 * trip-time evidence scan, fixed separately under 8579d419.)
 *
 * THE FIX: every marker is anchored to the position the harness actually
 * authors it — prefix envelopes stay ^-anchored, the schedule_self rejection
 * is anchored to its authored `⚠️ schedule_self FAILED — …` prefix, the abort
 * backstop to its authored `Tool "<name>" exceeded Ns and was aborted`
 * prefix, and the run_command exit marker to the result's TAIL line (it is
 * written as a `\n[exit: N]` suffix). Content merely QUOTING a failure shape
 * (this file's own source, docs, logs) is never failure-shaped again.
 *
 * These tests replay the incident's exact filed texts and pin both directions:
 * quoted markers never fire, authored envelopes always fire.
 *
 * SECOND SIGHTING — ticket a5f4c3aa (2026-09-10 21:54:55Z, session 536473e0,
 * run fca18838): the lane FIXING 7c1e5b9f tripped its own breaker reading
 * this same module mid-fix — its auto-filed failure texts are the same file
 * excerpts (lines 270-276, 346-356). Same root cause, same fix; this replay
 * file covers both tickets.
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

// ── The incident's filed "Failure texts (newest first)" — verbatim shapes ────
// (read_file results are line-number-prefixed, grep results colon-prefixed).

// Failure text #1: read_file of learnings-index.service.ts lines 340-354.
const INCIDENT_READ_CHUNK_1 = `340\t      }
341\t      block += line;
342\t    }
343\t    return block === header ? '' : block;
344\t  } catch {
345\t    return '';
346\t  }
347\t}
348\t
349\t// ── Retrieval: on-tool-failure requery ───────────────────────────────────────
350\t
351\t// Conservative, harness-authored failure shapes only (a read_file result that
352\t// merely CONTAINS the word "error" must not fire a nudge).
353\tconst FAILURE_MARKERS: RegExp[] = [
354\t  /^Tool \\S+ failed:/,                    // executeCodingTool catch-all`;

// Failure text #2: the SAME file lines 360-371 — the chunk whose literal
// marker source the unanchored regexes matched (the streak's deciding reads).
const INCIDENT_READ_CHUNK_2 = `360\t  /FAILED — no schedule was created/,
361\t  /\\[exit: (?!0[\\]\\s])[^\\]\\n]{0,40}\\]/,   // run_command non-zero exit marker
362\t  /exceeded \\d+s and was aborted/,        // agent-loop hard-timeout backstop
363\t];
364\t
365\t/** True when a tool result is one of the harness's failure shapes. */
366\texport function looksLikeToolFailure(result: string): boolean {
367\t  const text = (result || '').slice(0, 4000);
368\t  return FAILURE_MARKERS.some(re => re.test(text));
369\t}
370\t
371\t/** Shared distinc`;

// Failure text #3: a grep result over goals.service.ts (matched nothing even
// then — swept into the ticket by the pre-#656 trip-time evidence scan).
const INCIDENT_GREP_RESULT = `432:async function getGoalRow(goalId: string, userId: string): Promise<any> {
452:async function getTodoRow(todoId: string, userId: string): Promise<any> {
743:  const goal = await getGoalRow(goalId, userId);
993:  const goal = await getGoalRow(opts.goalId, opts.userId);
1038:  const goal = await getGoalRow(goalId, userId);
1137:  const todo = await getTodoRow(todoId, userId);
1425:  const goal = await getGoalRow(opts.goalId, opts.userId);
1541:  const todo = await getTodoRow(opts.todoId, opts`;

describe('ticket 7c1e5b9f replay — quoted failure shapes are NOT failures', () => {
  test('the incident read_file chunks that tripped the breaker are not failure-shaped', () => {
    // Pre-fix both chunks 1's sibling lines and chunk 2 matched (markers 6+7);
    // these exact texts were the phantom 3× read_file streak.
    expect(looksLikeToolFailure(INCIDENT_READ_CHUNK_1)).toBe(false);
    expect(looksLikeToolFailure(INCIDENT_READ_CHUNK_2)).toBe(false);
    expect(looksLikeToolFailure(INCIDENT_GREP_RESULT)).toBe(false);
  });

  test('self-referential guard: the CURRENT learnings-index.service.ts source never flags itself', () => {
    // Read the live module from disk and replay it as read_file-style windows
    // (line-number prefixes, 40-line chunks) AND as a raw cat — no shape may
    // fire, however the markers evolve, or the breaker false-trips again the
    // next time a lane investigates this module.
    const src = fs.readFileSync(path.join(__dirname, 'learnings-index.service.ts'), 'utf8');
    const lines = src.split('\n');
    for (let start = 0; start < lines.length; start += 40) {
      const window = lines
        .slice(start, start + 40)
        .map((l, i) => `${start + i + 1}\t${l}`)
        .join('\n');
      expect(looksLikeToolFailure(window)).toBe(false);
    }
    expect(looksLikeToolFailure(src)).toBe(false);
  });

  test('docs/logs/tests QUOTING the markers mid-string are not failure-shaped', () => {
    expect(looksLikeToolFailure('the deploy died with [exit: 1] and we rolled back')).toBe(false);
    expect(looksLikeToolFailure('[exit: 1] was the marker we fixed')).toBe(false); // leading quote, not the tail envelope
    expect(looksLikeToolFailure('see "exceeded 900s and was aborted" in agent.ts:2172')).toBe(false);
    expect(looksLikeToolFailure('notes: FAILED — no schedule was created, per tools.ts')).toBe(false);
    expect(looksLikeToolFailure('ok\n[exit: 0]')).toBe(false);
    expect(looksLikeToolFailure('')).toBe(false);
  });
});

describe('ticket 7c1e5b9f — authored failure ENVELOPES still fire', () => {
  test('schedule_self rejection (tools.ts authored prefix)', () => {
    expect(looksLikeToolFailure('⚠️ schedule_self FAILED — no schedule was created. prompt exceeds 8000 chars')).toBe(true);
  });

  test('agent-loop hard-timeout backstop (agent.ts authored prefix)', () => {
    expect(looksLikeToolFailure('Tool "grep" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe(true);
  });

  test('run_command non-zero exit marker as the TAIL line', () => {
    expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
    expect(looksLikeToolFailure('build died\n[exit: 137 — timed out]')).toBe(true);
    expect(looksLikeToolFailure('[exit: 2]')).toBe(true);
    expect(looksLikeToolFailure('partial output\n[exit: 1]\n')).toBe(true); // tolerate a trailing newline
  });

  test('exit marker beyond the 4000-char head slice is still seen (tail-anchored)', () => {
    // The pre-fix head-slice missed a long output's tail marker entirely.
    expect(looksLikeToolFailure(`${'x'.repeat(20_000)}\n[exit: 2]`)).toBe(true);
  });

  test('the pre-existing prefix envelopes are untouched', () => {
    expect(looksLikeToolFailure('Tool run_command failed: spawn ENOENT')).toBe(true);
    expect(looksLikeToolFailure('Verify FAILED at "test": ✓ typecheck  ✗ test (exit 1)')).toBe(true);
    expect(looksLikeToolFailure('git commit failed: nothing to commit')).toBe(true);
    expect(looksLikeToolFailure('COMMIT BLOCKED — the staged changes appear to contain secrets')).toBe(true);
    expect(looksLikeToolFailure('{\n "ok": false,\n "reason": "tool_not_offered",\n "needsConfirmation": false\n}')).toBe(true);
  });
});
