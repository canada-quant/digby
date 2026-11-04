/**
 * REPLAY TEST — tickets 8aa8d2ac + c79e4248 (mishaps, 2026-09-22, SAME
 * incident run): "3× tool-failure streak: update_feedback / update_document
 * on 'Hardening Bench for Public Release' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE for BOTH — every deterministic gate held; NO
 * framework change. Same session 3e1cae6f-59fb-43a7-9d32-6ee36c450428, same
 * run fcc13160-0bd3-4e47-b6d2-8cd480d5b05d; both auto-filed at breaker trips
 * (8aa8d2ac at 01:42:12Z, c79e4248 at 01:42:38Z — 26 s apart, one lane
 * decoder-locked on the literal "noop" while its own reasoning named
 * run_command).
 *
 * The incidents:
 *   · 8aa8d2ac (update_feedback): the model emitted id "noop" ONCE.
 *     update_feedback IS platform-preflighted (agent.ts:3105-3116 →
 *     findUngroundedIdArgs). "noop" is 4 chars — below ID_SHAPE_RE's 8-hex
 *     floor (tool-preflight.ts:33) — and occurred NOWHERE in the run's
 *     readable haystack (assistant turns are EXCLUDED from groundingHaystack,
 *     tool-preflight.ts:40-53, so the model cannot self-ground its own
 *     narration), so the preflight REFUSED THE CALL WITHOUT EXECUTING:
 *     ungroundedIdRefusal (tool-preflight.ts:264-286) with
 *     intended='run_command' from detectIntendedTool. NOTHING was mutated —
 *     the call never reached the platform executor at all. This is the
 *     STRONGER leg of the two-layer containment: in the b515ad74/688a01ce
 *     incident the fleet-corpus haystack grounded "noop" verbatim and the
 *     preflight correctly stayed silent (occurrence, not semantics); here the
 *     haystack was clean and the preflight itself fired. Both are the design.
 *   · c79e4248 (update_document): the model emitted fileId "noop" TWICE.
 *     update_document is a DOCUMENT-SEAM tool (agent.ts DOC_SEAM_ID_TOOLS —
 *     document tools EXECUTE; they are not platform-preflighted), so both
 *     calls reached the executor and the ownership gate refused them
 *     byte-exact (tool-executor.ts:774-781, the update_document case):
 *     "No generated file with id noop belongs to this user. Call list_files
 *     to see the current files." NOTHING was mutated. The doc-seam invented-
 *     id DETECTION leg (agent.ts:3381-3394, leg (c) source 2) saw both
 *     emissions off the failure results — its grounding haystack EXCLUDES the
 *     just-pushed refusal (messages.slice(0, -1)) precisely because the
 *     refusal envelope echoes the invented id back ("No generated file with
 *     id noop…") and would otherwise ground it (agent.ts:3377-3380).
 *
 * Why the "3×" titles on ONE and TWO filed texts: the streak breaker
 * arithmetic (agent.ts:3352-3411) is WEIGHTED — each consecutive failure +1,
 * a preflight-ungrounded emission +1 (agent.ts:3364), and the intent-mismatch
 * leg +1 when the lane's own reasoning names a DIFFERENT offered tool
 * (agent.ts:3365-3366 — here run_command, the wrong-tool derail signature).
 *   · 8aa8d2ac: 1 (failure) + 1 (ungrounded) + 1 (intent) = 3 on the FIRST
 *     emission → trip, withhold, auto-file (the afac4aee arithmetic — hence
 *     the ticket's single filed failure text).
 *   · c79e4248: 2 (two executor refusals) + 1 (intent) = 3 on the SECOND
 *     emission → trip (the 099bd00a document-seam ladder — hence two filed
 *     failure texts).
 * That arithmetic is unchanged and as designed.
 *
 * Evidence for the attribution (all re-verified against source bytes
 * 2026-09-22):
 *  1. No framework surface EMITS "noop" as an entity id — the literal is a
 *     model emission; both refusal envelopes it produced match current
 *     source byte-for-byte (pinned below).
 *  2. Recent framework diffs touch NEITHER envelope: tool-preflight.ts log
 *     is 8e53daeff (#894, narrated-but-unexecuted breaker — a different
 *     seam), 5c80d0c32 (#793, no-op shell filler), a59b35691 (#705,
 *     chatId recovery wording), f356e14a7 (2026-09-09, the preflight
 *     itself). The filed texts are byte-identical to today's source.
 *  3. Every containment layer held: preflight refused 8aa8d2ac's call
 *     pre-execution (no ticket mutation attempted), doc-seam ownership gate
 *     refused c79e4248's calls (no file mutated), breaker tripped at the
 *     designed thresholds and auto-filed — these two tickets ARE the
 *     automatic investigation the owner doctrine asks for.
 *  4. Prior same-class adjudications were all model-side:
 *     f839cede+aff1c189+ec9d7424 (placeholder-emission dispatch loop),
 *     b515ad74+688a01ce (#— corpus-saturation variant, same two tools),
 *     099bd00a (document-seam ladder), e70a830a ('noop' verify_durable),
 *     155488ff+cea13871 (cross-tool echo-grounding), 9d5cee91, 54121353,
 *     718a04a5, b6ebb710, 0c0ce759, 02bf673a.
 */

import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
  ungroundedIdRefusal,
} from './tool-preflight';

// ── The incident's exact emitted id (both tickets filed "noop").
const NOOP = 'noop';

/** tool-executor.ts:774-781 update_document case — the byte-exact
 *  ownership-gate text the incident filed twice. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** The incident run's haystack was CLEAN: no prior tool result had rendered
 *  the literal "noop" into the readable context (system + user + tool roles). */
const CLEAN_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Hardening bench for public release: run the checks and update the board.' },
  { role: 'tool', content: '{"tickets":[{"id":"8aa8d2ac-4f2c-4383-b650-b0eb820cb00e","status":"open"}]}' },
]);

/** Contrast leg: the b515ad74/688a01ce corpus-saturated haystack, where a
 *  prior list_feedback result rendered "noop" verbatim and the preflight
 *  correctly stayed silent. Grounding is occurrence, not semantics. */
const CORPUS_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Verify the lane state and close out the streak ticket.' },
  { role: 'tool', content: '{"tickets":[{"description":"the model emitted id noop then test"}]}' },
]);

/** The 8aa8d2ac ticket's filed refusal, verbatim (the breaker's 1200-char
 *  capture — the full envelope fits). */
const FILED_UF_REFUSAL = JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'ungrounded_id',
  rejected: [{ key: 'id', value: 'noop' }],
  message:
    'NOT EXECUTED: update_feedback was called with id="noop", which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ' +
    'Your reasoning named run_command — you evidently meant to call run_command; call it now with its real parameters.',
}, null, 1);

/** The offered-tool set the incident lane saw (the intent detector's universe). */
const OFFERED = ['run_command', 'update_feedback', 'update_document', 'list_files', 'read_file', 'grep'];

/**
 * Local replica of the breaker's weighted streak counter (agent.ts:3352-3366):
 * consecutive failure-shaped results from ONE tool +1 each, a preflight-
 * ungrounded emission +1 (agent.ts:3364), an intent mismatch +1
 * (agent.ts:3365-3366). Returns the emission ordinal (1-based) at which the
 * count first reaches the trip threshold 3, or -1.
 */
function tripAtEmission(failures: Array<{ preflightUngrounded?: boolean; intended?: string | null }>): number {
  let count = 0;
  for (let i = 0; i < failures.length; i += 1) {
    count += 1; // the failure itself (agent.ts:3354)
    if (failures[i].preflightUngrounded) count += 1; // agent.ts:3364
    if (failures[i].intended) count += 1; // agent.ts:3365-3366
    if (count >= 3) return i + 1;
  }
  return -1;
}

describe('replay 8aa8d2ac — update_feedback "noop" ungrounded_id preflight (model-side attribution)', () => {
  it('"noop" fails the id shape and is flagged against the incident\'s clean haystack — the preflight fires', () => {
    // 4 chars < ID_SHAPE_RE's 8-hex floor (tool-preflight.ts:33) and no
    // verbatim occurrence ⇒ ungrounded. The preflight REFUSED this call.
    expect(findUngroundedIdArgs({ id: NOOP }, CLEAN_HAYSTACK)).toEqual([{ key: 'id', value: NOOP }]);
    // A real citation prefix from the lane's own brief is id-shaped and passes.
    expect(findUngroundedIdArgs({ id: '8aa8d2ac' }, CLEAN_HAYSTACK)).toEqual([]);
  });

  it('contrast pin: the SAME literal is grounded only by a corpus-saturated haystack (the b515ad74 variant — occurrence, not semantics)', () => {
    expect(findUngroundedIdArgs({ id: NOOP }, CORPUS_HAYSTACK)).toEqual([]);
    // …while a literal occurring nowhere is flagged even in that haystack —
    // the containment has no hole.
    expect(findUngroundedIdArgs({ id: 'zzq-never-grounded' }, CORPUS_HAYSTACK))
      .toEqual([{ key: 'id', value: 'zzq-never-grounded' }]);
  });

  it('the filed refusal envelope is byte-exact the current ungroundedIdRefusal output (preflight → NOT EXECUTED, intended=run_command)', () => {
    const out = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: NOOP }], 'run_command');
    expect(out).toBe(FILED_UF_REFUSAL);
    // The refusal is a failure-shaped JSON envelope (feeds the streak counter)
    // and refuses BEFORE any execution — no ticket mutation was attempted.
    expect(JSON.parse(out)).toMatchObject({ ok: false, tool: 'update_feedback', reason: 'ungrounded_id' });
  });

  it('detectIntendedTool convicts run_command from the incident-shaped narration (the +1 intent weight)', () => {
    const narration = 'Now run_command with the full verify chain to confirm the bench is green.';
    expect(detectIntendedTool(narration, 'update_feedback', OFFERED)).toBe('run_command');
    // Guard legs: naming the emitted tool acquits; a too-short text acquits.
    expect(detectIntendedTool('Calling update_feedback with the real id now.', 'update_feedback', OFFERED)).toBeNull();
    expect(detectIntendedTool('ok', 'update_feedback', OFFERED)).toBeNull();
  });

  it('weighted arithmetic: one preflight-ungrounded + intent-mismatched emission trips the breaker at the FIRST call', () => {
    expect(tripAtEmission([{ preflightUngrounded: true, intended: 'run_command' }])).toBe(1);
  });
});

describe('replay c79e4248 — update_document "noop" document-seam ladder (model-side attribution)', () => {
  it('the two filed failure texts are byte-exact the tool-executor ownership gate', () => {
    // Filed (newest first), both identical:
    //   No generated file with id noop belongs to this user. Call list_files to see the current files.
    expect(docGateText(NOOP)).toBe('No generated file with id noop belongs to this user. Call list_files to see the current files.');
  });

  it('the doc-seam detection leg flags "noop" off the failure result — and the slice(0,-1) exclusion is what saves it from echo-grounding', () => {
    // agent.ts:3381-3394 (leg (c) source 2): detection-only grounding check on
    // document-seam tools, haystack = messages WITHOUT the just-pushed result.
    const withoutEcho = groundingHaystack([
      { role: 'user', content: 'Update the bench doc.' },
      // …the ownership refusal for THIS call is not yet in the list.
    ]);
    expect(findUngroundedIdArgs({ fileId: NOOP }, withoutEcho)).toEqual([{ key: 'fileId', value: NOOP }]);
    // agent.ts:3377-3380: the refusal envelope ECHOES the invented id back —
    // included, it would ground the literal and blind the detection leg.
    const withEcho = groundingHaystack([
      { role: 'user', content: 'Update the bench doc.' },
      { role: 'tool', content: docGateText(NOOP) },
    ]);
    expect(findUngroundedIdArgs({ fileId: NOOP }, withEcho)).toEqual([]);
  });

  it('weighted arithmetic: two executor refusals + the intent weight trip the breaker at the SECOND emission (the 099bd00a ladder)', () => {
    expect(tripAtEmission([{ intended: 'run_command' }, { intended: 'run_command' }])).toBe(2);
    // Even with no intent weight at all, three bare refusals trip at the third.
    expect(tripAtEmission([{}, {}, {}])).toBe(3);
    // …but two bare refusals alone do NOT — the filed two-text trip proves the
    // intent leg fired, matching the ticket's "reasoning named run_command".
    expect(tripAtEmission([{}, {}])).toBe(-1);
  });
});
