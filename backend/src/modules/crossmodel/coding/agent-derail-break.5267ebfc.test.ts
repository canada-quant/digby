/**
 * Replay pin — ticket 5267ebfc (mishap, auto-filed at breaker trip
 * 2026-10-22T23:22:11Z; session c0e22e36-1c74-4295-8049-9b48335c6c37
 * "Fleet Supervisor · sweep"; tool answer_owner_question; first streak this
 * run).
 *
 * THE INCIDENT: THREE consecutive answer_owner_question bounces, all the
 * same {ok:false, reason:'reply_recorded'} envelope on question
 * oq_d2fc079f-e83a-42cc-8c5e-9577592c680b — a CHOICE card ("Renew the token
 * plan, or leave those routes on metered pricing?", expectedAnswerType
 * 'choice', optionalAsk:true). The FS answered prose each time: "Leave those
 * routes on metered pricing", then two longer citations of the owner's
 * money.grant standing directive.
 *
 * VERDICT (this lane, 2026-10-23, evidence-led): the GATE fired BY DESIGN —
 * reply_recorded is todo 0dd7d3f2's own code (a typed choice card resolves
 * only on a typed-option pick, owner-questions.ts matchAnswerToOption: exact
 * id / case-insensitive label / 1-based number; prose never matches), and the
 * text DID reach the asking chat each time. But the refusal's recovery
 * instruction — "pick the option that matches their words and re-answer with
 * it" — was UNSATISFIABLE in context: no surface available to the retrying
 * agent rendered the card's options (the triage wake rendered them once at
 * flag time, hours stale by the retry; list_owner_questions carried only
 * expectedAnswerType). A deterministic remedy-visibility gap, on the exact
 * shape the FS hit.
 *
 * FIX (this ticket): (1) the reply_recorded refusal now reprints the card's
 * OWN options when it has them (platform-tools.ts answer_owner_question),
 * and (2) list_owner_questions renders options on OPEN rows. This pin holds
 * the matcher contract and the failure-shape so the fix cannot silently
 * regress the gate the incident proved correct:
 *   · prose never resolves a choice card (the FS's three filed answers,
 *     replayed verbatim, all stay reply_recorded-class: no option match);
 *   · a typed pick by id, by label, and by number DOES resolve (the remedy
 *     now visible is actionable);
 *   · the bounce envelope is failure-shaped to the breaker ({ok:false} at
 *     envelope start) — the streak filing was correct and stays.
 *
 * The row itself is now dismissed (dismissedBy 'agent' — verified live this
 * run via list_owner_questions), so no live gate depends on this shape.
 */

import { matchAnswerToOption, parseStoredOptions, renderOptionsNumbered } from '../platform/owner-questions';

// The card's stored options (oq_d2fc079f, read live via list_owner_questions
// this run — the row shows expectedAnswerType 'choice'). The PRE-FIX listing
// never rendered options (that is this ticket's gap), and the bounce itself
// proves the real labels differ from the FS's filed prose: the matcher is a
// deterministic exact id/label/number match, so ANY exact-label equality
// would have RESOLVED the card — these labels model that proven-distinct
// shape (same decision arms, non-equal strings).
const OPTS = parseStoredOptions([
  { id: 'renew_token_plan', label: 'Renew the Alibaba Token Plan' },
  { id: 'stay_metered', label: 'Leave those routes on metered PAYG — no renewal' },
]);

// The ticket's three filed answers — verbatim (newest first).
const FILED_ANSWERS = [
  'Leave those routes on metered pricing',
  'Leave those routes on metered pricing — no owner gate (rule money.grant: spend inside existing paid arrangements is pre-approved; the owner\'s standing words: "stop asking me so much, figure it out")',
  'Leave the 9 Alibaba order-1 legs on metered PAYG — no owner gate (covered under the standing grant, rule money.grant: spend inside an existing paid arrangement is pre-approved; the owner\'s standing words apply)',
];

describe('replay 5267ebfc — prose never resolves a choice card; a typed pick does', () => {
  it('the card parses to two typed options (the gate had real options to pick)', () => {
    expect(OPTS.length).toBe(2);
  });

  it.each(FILED_ANSWERS.map((a, i) => [i, a] as const))(
    'filed answer #%i (verbatim) matches NO option — reply_recorded is the correct verdict',
    (_i, answer) => {
      expect(matchAnswerToOption(OPTS, answer)).toBeNull();
    },
  );

  it('the remedy is satisfiable: id, label (case-insensitive) and number all resolve', () => {
    expect(matchAnswerToOption(OPTS, 'stay_metered')?.id).toBe('stay_metered');
    expect(matchAnswerToOption(OPTS, 'leave those routes on metered payg — no renewal')?.id).toBe('stay_metered');
    expect(matchAnswerToOption(OPTS, '2')?.id).toBe('stay_metered');
  });

  it('renderOptionsNumbered produces the numbered pick list the refusal now reprints', () => {
    const rendered = renderOptionsNumbered(OPTS);
    expect(rendered).toBe('1. Renew the Alibaba Token Plan\n2. Leave those routes on metered PAYG — no renewal');
  });

  it('a near-miss paraphrase still does not match (exact contract unchanged)', () => {
    expect(matchAnswerToOption(OPTS, 'leave it on metered')).toBeNull();
    expect(matchAnswerToOption(OPTS, 'metered pricing')).toBeNull();
  });
});
