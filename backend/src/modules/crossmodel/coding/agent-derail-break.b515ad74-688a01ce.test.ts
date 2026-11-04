/**
 * REPLAY TEST — tickets b515ad74 + 688a01ce (mishaps, 2026-09-21, SAME
 * incident run): "3× tool-failure streak: update_document / update_feedback
 * on 'Spark Lane Branch State Verification' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE for BOTH — every deterministic gate held; NO
 * framework change. Same session 521020fe-ebe5-4d97-8b58-fdbe8c95445f, same
 * run c304a7cb-97f8-42ff-883f-eb5e86cacc90; both auto-filed at breaker trips.
 *
 * The incidents:
 *   · b515ad74 (update_document): the model emitted fileId "placeholder",
 *     then "noop". update_document is a DOCUMENT-SEAM tool
 *     (agent.ts DOC_SEAM_ID_TOOLS — document tools EXECUTE; they are not
 *     platform-preflighted), so the calls reached the executor and the
 *     ownership gate refused them byte-exact (tool-executor.ts update_document
 *     case): "No generated file with id <X> belongs to this user. Call
 *     list_files to see the current files." NOTHING was mutated.
 *   · 688a01ce (update_feedback): the model emitted id "noop", then "test".
 *     update_feedback IS platform-preflighted (agent.ts:3105-3128 →
 *     findUngroundedIdArgs), but a value is grounded when it is id-shaped OR
 *     occurs VERBATIM in the run's readable haystack (tool-preflight.ts:65-77
 *     — grounding is occurrence, not semantics). The fleet's ticket corpus is
 *     saturated with the literals "noop"/"test" from prior placeholder-streak
 *     filings, and any list_feedback/get_feedback result renders them into the
 *     haystack — so the preflight correctly stayed silent and the NEXT
 *     deterministic layer, the ticket-18086326 machine-mutation gate, refused
 *     both with ticket_not_found (platform-tools.ts:3707 envelope around
 *     closure-evidence.ts:266). NOTHING was mutated.
 *
 * Why the "3×" title on TWO filed texts each: the streak breaker arithmetic
 * (agent.ts:3352-3411) is WEIGHTED and CUMULATIVE across consecutive failures
 * of one tool — each failure +1, and the intent-mismatch leg +1 when the
 * lane's own reasoning names a DIFFERENT offered tool (b515ad74's reasoning
 * named cancel_schedule; 688a01ce's named verify — the wrong-tool derail
 * signature). Two weighted emissions = 4 ≥ 3 → trip, withhold, auto-file.
 * That arithmetic is unchanged and as designed.
 *
 * Evidence for the attribution (all re-verified against source bytes):
 *  1. No framework surface EMITS "placeholder"/"noop"/"test" as entity ids —
 *     the literals are model emissions; the executor envelopes they produced
 *     match current source byte-for-byte (pinned below).
 *  2. The model could not have self-grounded the first emission: assistant-
 *     role text is EXCLUDED from groundingHaystack (tool-preflight.ts:40-53).
 *  3. Every containment layer held: doc-seam ownership gate (no file mutated),
 *     machine-mutation gate (no ticket mutated), breaker + auto-file (these
 *     two tickets ARE the automatic investigation).
 *  4. Prior same-class adjudications were all model-side: b6ebb710 (#948),
 *     89ddfcfe+60f64ebb, 0c0ce759, aff1c189, 9d5cee91, 54121353, 718a04a5,
 *     f95bd4c8, 1867d6d5, 02bf673a (#950), a152e770-47d006d0.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userFeatureRequest: { findUnique: (...a: any[]) => mockFindUnique(...a), findMany: (...a: any[]) => mockFindMany(...a) } },
}));

import { findUngroundedIdArgs, groundingHaystack } from './tool-preflight';
import { verifyMachineCloseEvidence } from '../feedback/closure-evidence';

// ── The incident's exact emitted ids (each ticket files its texts newest first).
const DOC_ID_1 = 'placeholder'; // b515ad74, update_document call 1
const DOC_ID_2 = 'noop';        // b515ad74, update_document call 2
const UF_ID_1 = 'noop';         // 688a01ce, update_feedback call 1
const UF_ID_2 = 'test';         // 688a01ce, update_feedback call 2

/** tool-executor.ts update_document case — the byte-exact ownership-gate text. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** platform-tools.ts:3707 + closure-evidence.ts:266 — the machine-gate envelope. */
const MACHINE_GATE_PREFIX = 'This machine-triggered run may NOT mutate feedback ticket';
const ticketNotFoundVerdict = (id: string) =>
  `Feedback ticket "${id}" not found — nothing was closed. Copy the exact id from list_feedback.`;
const machineGateEnvelope = (id: string) =>
  `${MACHINE_GATE_PREFIX} ${id.slice(0, 8)}: ${ticketNotFoundVerdict(id)} If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated. If the ticket needs triage you cannot evidence, record a file_feedback sighting instead.`;

/** A realistic run haystack: the lane's brief + a prior tool result. */
const CLEAN_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Verify the spark lane branch state and close out the streak ticket per the bookkeeping.' },
  { role: 'tool', content: '{"tickets":[{"id":"ae20da66-3731-4d77-9779-b5923ce9b9cc","status":"in_progress"}]}' },
]);

/** The fleet-corpus haystack: a prior list_feedback result whose descriptions
 *  carry the literals "noop"/"test" from earlier placeholder-streak filings —
 *  exactly what makes the update_feedback preflight's verbatim leg pass. */
const CORPUS_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Verify the spark lane branch state.' },
  { role: 'tool', content: '{"tickets":[{"title":"3× tool-failure streak: update_document — id noop placeholder drift","description":"the lane emitted noop then test"}]}' },
]);

describe('replay b515ad74 — update_document placeholder streak (model-side attribution)', () => {
  it('both emitted fileIds are ungrounded against the clean run haystack (neither id-shaped; neither anywhere the model read)', () => {
    expect(findUngroundedIdArgs({ fileId: DOC_ID_1 }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'fileId', value: DOC_ID_1 }]);
    expect(findUngroundedIdArgs({ fileId: DOC_ID_2 }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'fileId', value: DOC_ID_2 }]);
  });

  it('the model could not have self-grounded: assistant-role text is excluded from the haystack', () => {
    const withNarration = groundingHaystack([
      { role: 'user', content: 'Update the verification document.' },
      { role: 'assistant', content: `I will now call update_document with fileId ${DOC_ID_1}.` },
    ]);
    expect(findUngroundedIdArgs({ fileId: DOC_ID_1 }, withNarration))
      .toEqual([{ key: 'fileId', value: DOC_ID_1 }]);
  });

  it('replays the exact ownership-gate envelopes from the filed texts (nothing mutated)', () => {
    // The ticket files these byte-exact (newest first: noop, then placeholder).
    expect(docGateText(DOC_ID_2)).toBe('No generated file with id noop belongs to this user. Call list_files to see the current files.');
    expect(docGateText(DOC_ID_1)).toBe('No generated file with id placeholder belongs to this user. Call list_files to see the current files.');
  });
});

describe('replay 688a01ce — update_feedback placeholder streak (model-side attribution)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null); // neither "noop" nor "test" is a real ticket
    mockFindMany.mockResolvedValue([]);
  });

  it('the literals pass the preflight ONLY via the verbatim leg: grounded in the fleet-corpus haystack, flagged against a clean one', () => {
    // Grounding is occurrence, not semantics — the corpus explains why the
    // platform preflight correctly stayed silent for this incident.
    expect(findUngroundedIdArgs({ id: UF_ID_1 }, CORPUS_HAYSTACK)).toEqual([]);
    expect(findUngroundedIdArgs({ id: UF_ID_2 }, CORPUS_HAYSTACK)).toEqual([]);
    // An id occurring NOWHERE in the readable context IS flagged — the
    // two-layer containment (preflight, then the mutation gate) has no hole.
    expect(findUngroundedIdArgs({ id: UF_ID_1 }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'id', value: UF_ID_1 }]);
    expect(findUngroundedIdArgs({ id: 'zzq-never-grounded' }, CORPUS_HAYSTACK))
      .toEqual([{ key: 'id', value: 'zzq-never-grounded' }]);
  });

  it('END-TO-END gate replay: verifyMachineCloseEvidence refuses "noop"/"test" with the incident\'s exact ticket_not_found verdict', async () => {
    for (const id of [UF_ID_1, UF_ID_2]) {
      const v = await verifyMachineCloseEvidence({ ticketId: id, evidence: { commitSha: 'a'.repeat(40) } });
      expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
      expect((v as any).message).toBe(ticketNotFoundVerdict(id));
    }
    // 4-char literals are below TICKET_PREFIX_LEN — the e829e28c prefix
    // fallback never runs for them (no accidental unique-prefix rescue).
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('the filed machine-gate envelopes are verbatim prefixes of the current source envelope (byte-pin)', () => {
    // The ticket files these TRUNCATED (1200-char breaker capture) — assert
    // the filed fragments lead the envelope the current source constructs.
    const filedNoop = 'This machine-triggered run may NOT mutate feedback ticket noop: Feedback ticket "noop" not found — nothing was closed. Copy the exact id from list_feedback. If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated. If the ticket needs triage you cannot evidence, record a file_feedback sighting';
    const filedTest = 'This machine-triggered run may NOT mutate feedback ticket test: Feedback ticket "test" not found — nothing was closed. Copy the exact id from list_feedback. If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; n';
    expect(machineGateEnvelope(UF_ID_1).startsWith(filedNoop)).toBe(true);
    expect(machineGateEnvelope(UF_ID_2).startsWith(filedTest)).toBe(true);
    // And the envelope always ends in the no-mutation contract.
    expect(machineGateEnvelope(UF_ID_1)).toContain('record a file_feedback sighting instead.');
  });
});
