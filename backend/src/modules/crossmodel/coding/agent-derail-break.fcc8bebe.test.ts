/**
 * Replay pin — ticket fcc8bebe (mishap, auto-filed 2026-09-20T10:02:45Z at
 * breaker trip; incident lane 26bd5857-5fe1-4de6-9c83-f5601037e326
 * "Adversarial Review: Refute, Don't Confir", crossmodel, coding seat
 * kimi-k3, machine run a324be0a-3e36-4cad-bb52-9234c4bb8b29).
 *
 * THE INCIDENT (this ticket's half): the reviewer lane emitted update_document
 * with two MODEL-AUTHORED file ids while its own reasoning named run_command:
 *   · not-a-file  (first emission — a bare placeholder noun)
 *   · dd3a19fa    (second emission — the id prefix of dd3a19fa, the TICKET
 *                  under adversarial review, mistaken for a generated-file id)
 * Both calls EXECUTED into the harmless existence refusal ("No generated file
 * with id X belongs to this user. Call list_files to see the current files.")
 * — the tool-side envelope, never the preflight's NOT-EXECUTED shape — and
 * the breaker filed this ticket with the two texts NEWEST-FIRST on the
 * update_document trip that ended the run ("3 episodes; intended tool
 * appears to be run_command"; the FULL-RUN replay lives in
 * agent-derail-break.9d5cee91.test.ts, which pins the terminal state, the
 * {update_feedback:2, update_document:1} arithmetic, and both filings).
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the
 * placeholder-emission dispatch-loop class (f839cede / aff1c189 / ec9d7424):
 * narration/emission mismatch with fabricated ids, never a framework defect.
 * Every deterministic seam behaved AS DESIGNED:
 *   1. update_document is NOT in PLATFORM_TOOL_NAMES, so the grounding
 *      preflight never inspects its fileId — the calls execute (that is why
 *      the filed texts are the tool's existence refusal, not NOT-EXECUTED).
 *   2. Even where the preflight DOES apply, it validates VERBATIM OCCURRENCE
 *      / ID SHAPE, never EXISTENCE (718a04a5): dd3a19fa is 8 hex chars —
 *      shape-grounded by construction, exactly like the ticket id the model
 *      confused it with.
 *   3. The existence-refusal envelope is failure-shaped by design (27e3a5fd)
 *      so the breaker counts it — the primary derailment signal; NO shape
 *      exemption (ea69c94e / d0b9c6a6 disposition).
 *   4. Trip arithmetic pinned by the filed evidence: +1 failure +1 intent
 *      (the reasoning named run_command) per call ⇒ the streak crosses 3 on
 *      the SECOND call with exactly the two filed texts (unshift ⇒
 *      newest-first).
 *
 * These unit pins lock the incident's facts; the full-run replay of run
 * a324be0a (both seams, the terminal note, the telemetry rows, the exact
 * per-tool filings) is agent-derail-break.9d5cee91.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
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

import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool, findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** The incident's filed envelope, verbatim (fcc8bebe's two failure texts). */
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const UD_ID_FIRST = 'not-a-file';
const UD_ID_NEWEST = 'dd3a19fa';

/** The incident-shape narration: names run_command, never update_document. */
const narration = (id: string) =>
  `run_command cannot refresh the generated digest — writing the reconciled figures into file ${id} now.`;

describe('ticket fcc8bebe — update_document existence-refusal streak on fabricated file ids (run a324be0a)', () => {
  it('both filed envelopes are failure-shaped (the breaker correctly counted them)', () => {
    expect(looksLikeToolFailure(UD_ENVELOPE(UD_ID_FIRST))).toBe(true);
    expect(looksLikeToolFailure(UD_ENVELOPE(UD_ID_NEWEST))).toBe(true);
    // …and the streak's trip math the ticket's two texts prove: with the
    // intent mismatch live, the streak crosses 3 on the SECOND call —
    // failStreakTexts unshift keeps them newest-first, exactly the ticket's
    // filing order.
    const texts: string[] = [];
    texts.unshift(UD_ENVELOPE(UD_ID_FIRST)); // call 1: +1 failure +1 intent = 2
    texts.unshift(UD_ENVELOPE(UD_ID_NEWEST)); // call 2: +1 +1 = 4 ≥ 3 ⇒ TRIP
    expect(texts).toEqual([UD_ENVELOPE(UD_ID_NEWEST), UD_ENVELOPE(UD_ID_FIRST)]);
  });

  it('the intent preflight names run_command on the incident-shape narration (never the called tool)', () => {
    const offered = ['run_command', 'verify', 'update_feedback', 'update_document'];
    expect(detectIntendedTool(narration(UD_ID_FIRST), 'update_document', offered)).toBe('run_command');
    expect(detectIntendedTool(narration(UD_ID_NEWEST), 'update_document', offered)).toBe('run_command');
    // Sanity: faithful narration (naming update_document) convicts nothing.
    expect(detectIntendedTool('Calling update_document now with the real file id.', 'update_document', offered)).toBeNull();
  });

  it('the calls EXECUTE rather than preflight-refuse: update_document is not a platform tool, and dd3a19fa is shape-grounded anyway', () => {
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback'); // contrast: the sibling seam IS preflighted (9d5cee91)
    // Even under the preflight's own rules: the ticket prefix is 8 hex chars —
    // grounded by ID SHAPE with an empty haystack; the bare placeholder noun
    // is neither shaped nor occurring (had update_document been preflighted,
    // 'not-a-file' alone would have been refused NOT-EXECUTED).
    expect(findUngroundedIdArgs({ fileId: UD_ID_NEWEST }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: UD_ID_FIRST }, '')).toEqual([{ key: 'fileId', value: UD_ID_FIRST }]);
    // Occurrence grounding is verbatim-only, never existence: a haystack that
    // carries the ticket id (the review brief did) grounds the arg.
    expect(findUngroundedIdArgs({ fileId: UD_ID_FIRST }, `the model wrote ${UD_ID_FIRST} in prose`)).toEqual([]);
  });
});
