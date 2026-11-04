/**
 * OWNER-INTERRUPT-ECONOMY (supervisor SOTA round 3, 2026-10-20) — the pure
 * helpers: the owner-only interrupt class, the immediate-vs-digest verdict,
 * the STRICT same-decision match + the prior-decision pick, the annotation
 * round-trip and its "Same as before" expansion, the ask-vs-decide advisory,
 * the reversible-default eligibility, the digest due rule and its render.
 * The service paths (flag / answer / sweeps) are covered end to end in
 * owner-questions.interrupt-economy.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  ownerOnlyInterruptReason,
  classifyOwnerQuestionDelivery,
  isStrictSameDecision,
  pickPriorOwnerDecision,
  renderPriorDecisionAnnotation,
  parsePriorDecisionAnnotation,
  resolveSameAsBefore,
  withPriorDecisionOption,
  priorDecisionOption,
  priorDecisionAnswerCore,
  priorDecisionRefusalMessage,
  askVsDecideAdvisory,
  reversibleDefaultEligibility,
  reversibleDefaultFitsTypedGate,
  digestDue,
  renderOwnerDecisionDigest,
  fitOwnerDecisionDigest,
  mapPriorDecisionToOption,
  annotateQuestionWithPriorDecision,
  isPermanentReversibleRefusal,
  QUESTION_TRUNCATED_FOR_NOTE_MARK,
  DIGEST_TEXT_MAX,
  SAME_AS_BEFORE_ANSWER_RE,
  PRIOR_DECISION_OPTION_ID,
  OWNER_DECISION_DIGEST_WINDOW_MS,
  OWNER_DECISION_DIGEST_SLACK_MS,
  HIGH_COST_OF_DELAY_USD_PER_DAY,
} from './owner-interrupt-economy';
import type { PriorDecisionMatch } from './owner-interrupt-economy';
import {
  stripPriorDecisionAnnotation, clipQuestionKeepingAnnotation, isSameDecisionQuestion,
  questionTopicDedupeMatch, PRIOR_DECISION_MARK,
} from './owner-questions';

const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const ENV_KEYS = [
  'OWNER_PRIOR_DECISION_RECALL_DISABLED', 'OWNER_DECISION_DIGEST_DISABLED',
  'OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED', 'OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED',
  'OWNER_INTERRUPT_METRICS_DISABLED',
];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('ownerOnlyInterruptReason — the classes only the owner can answer (owner rule 2026-10-20)', () => {
  it.each([
    ['Approve $40/month for the monitoring subscription?', 'money'],
    ['Should we buy two more H100 hours to finish the sweep?', 'money'],
    ['Delete the stale staging branch and its preview database?', 'irreversible'],
    ['Force-push the rebased history to main?', 'irreversible'],
    ['Which API key should the lane use for the scraper?', 'credentials'],
    ['Send the launch post to LinkedIn?', 'external_send'],
    ['Commit to the pilot agreement with the vendor this week?', 'external_commitment'],
    ['Does that directive apply to our SFT-2 chain?', 'cross_project_scope'],
  ])('%s → %s', (q, reason) => {
    expect(ownerOnlyInterruptReason(q)).toBe(reason);
  });

  it('an ordinary approval on a lane\'s own work is NOT owner-only', () => {
    expect(ownerOnlyInterruptReason('Use the 8B or the 14B checkpoint for tonight\'s eval run?')).toBeNull();
    expect(ownerOnlyInterruptReason('Rename the results table column to pass_rate?')).toBeNull();
    // Engineering nouns are not external commitments.
    expect(ownerOnlyInterruptReason('Should the API client retry on 429, and commit to main after the fix?')).toBeNull();
  });

  it('structural flags (credential gate / console action / delivered secrets / named other project) are owner-only', () => {
    const q = 'Ready to continue?';
    expect(ownerOnlyInterruptReason(q, null, { credentialGate: true })).toBe('credentials');
    expect(ownerOnlyInterruptReason(q, null, { carriesSecrets: true })).toBe('credentials');
    expect(ownerOnlyInterruptReason(q, null, { consoleAction: true })).toBe('physically_human');
    expect(ownerOnlyInterruptReason(q, null, { namesOtherProject: true })).toBe('cross_project_scope');
  });

  it('the context counts (it carries the dollar figures), the prior-decision annotation does not', () => {
    expect(ownerOnlyInterruptReason('Keep the node?', 'It costs $2.10/h idle.')).toBe('money');
    const annotated = `Use the 8B checkpoint for tonight's eval?${PRIOR_DECISION_MARK} you decided this on 2026-10-01 (oq_12345678): «delete the 14B run». Reply "Same as before" to repeat it.`;
    expect(ownerOnlyInterruptReason(annotated)).toBeNull();
  });
});

describe('classifyOwnerQuestionDelivery — immediate vs the 12 h digest', () => {
  it('owner-only, urgent and high cost-of-delay cards go at once; the rest are batched', () => {
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: 'money' })).toEqual({ delivery: 'immediate', reason: 'owner_only:money' });
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: null, urgent: true })).toEqual({ delivery: 'immediate', reason: 'urgent' });
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: null, idleUsdPerDay: HIGH_COST_OF_DELAY_USD_PER_DAY })).toEqual({ delivery: 'immediate', reason: 'cost_of_delay' });
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: null, idleUsdPerDay: 3 })).toEqual({ delivery: 'digest', reason: 'batched' });
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: null })).toEqual({ delivery: 'digest', reason: 'batched' });
  });

  it('OWNER_DECISION_DIGEST_DISABLED=1 restores the DM-on-every-flag behaviour', () => {
    process.env.OWNER_DECISION_DIGEST_DISABLED = '1';
    expect(classifyOwnerQuestionDelivery({ ownerOnlyReason: null })).toEqual({ delivery: 'immediate', reason: 'digest_disabled' });
  });
});

describe('isStrictSameDecision — refusals apply only on a strict match', () => {
  it('reworded / reordered / re-punctuated same decision is strict', () => {
    expect(isStrictSameDecision(
      '[CanLaw] Should we halt SFT-2 training on the H100 pool?',
      '[CanLaw] Halt SFT-2 training on H100 pool?',
    )).toBe(true);
    expect(isStrictSameDecision('Flip wake_triage to act?', 'flip wake_triage to act')).toBe(true);
  });

  it('a subset decision (isSameDecisionQuestion residual a) is NOT strict', () => {
    const a = 'Merge PR 601 into main now?';
    const b = 'Merge PR 601 and PR 602 into main now?';
    expect(isSameDecisionQuestion(a, b)).toBe(true); // the loose matcher's documented residual
    expect(isStrictSameDecision(a, b)).toBe(false);
  });

  it('a negation flip (isSameDecisionQuestion residual b) is NOT strict', () => {
    const a = 'Ship the release stack with the schema migration?';
    const b = 'Ship the release stack without the schema migration?';
    expect(isSameDecisionQuestion(a, b)).toBe(true);
    expect(isStrictSameDecision(a, b)).toBe(false);
  });

  it('different numbers / lanes are never strict', () => {
    expect(isStrictSameDecision('Raise the eval batch size to 64 for lane Helios?', 'Raise the eval batch size to 128 for lane Helios?')).toBe(false);
    expect(isStrictSameDecision('Lane Helios: GO with the current plan, or hold the lane?', 'Lane Apollo: GO with the current plan, or hold the lane?')).toBe(false);
  });

  it('the annotation is ignored on both sides', () => {
    const base = 'Use the 8B checkpoint for tonight\'s eval run?';
    const annotated = `${base}${PRIOR_DECISION_MARK} you decided this on 2026-10-01 (oq_12345678): «yes, 8B». Reply "Same as before" to repeat it.`;
    expect(isStrictSameDecision(annotated, base)).toBe(true);
  });
});

describe('pickPriorOwnerDecision — the owner\'s own answers, 90 days', () => {
  const Q = 'Use the 8B checkpoint for tonight\'s eval run?';
  const row = (over: Record<string, any> = {}) => ({
    id: 'oq_aaaaaaaa-1111-2222-3333-444444444444', question: Q, status: 'answered',
    answer: 'Yes — 8B, the 14B is still training', answeredBy: 'owner', resolvedAt: daysAgo(5), ...over,
  });

  it('picks the newest matching owner answer, strict flag + decided-on date', () => {
    const m = pickPriorOwnerDecision(Q, [row({ id: 'oq_old', resolvedAt: daysAgo(30), answer: 'old' }), row()], NOW);
    expect(m?.row.id).toBe('oq_aaaaaaaa-1111-2222-3333-444444444444');
    expect(m?.strict).toBe(true);
    expect(m?.decidedOn).toBe('2026-10-15');
  });

  it('a legacy row (answeredBy null) is the owner\'s decision', () => {
    expect(pickPriorOwnerDecision(Q, [row({ answeredBy: null })], NOW)).not.toBeNull();
  });

  it.each([
    ['supervisor answers', { answeredBy: 'supervisor' }],
    ['preset defaults', { answeredBy: 'default' }],
    ['counter-questions', { answer: 'didn\'t we already change the eval set?' }],
    ['credential gates', { expectedAnswerType: 'credential:HF_TOKEN' }],
    ['answers older than 90 days', { resolvedAt: daysAgo(91) }],
    ['open / dismissed rows', { status: 'dismissed' }],
    ['empty answers', { answer: '' }],
  ])('excludes %s', (_label, over) => {
    expect(pickPriorOwnerDecision(Q, [row(over)], NOW)).toBeNull();
  });

  it('a loose (subset) match is found but not strict', () => {
    const m = pickPriorOwnerDecision('Use the 8B checkpoint for tonight\'s eval run and the regression suite?', [row()], NOW);
    expect(m).not.toBeNull();
    expect(m?.strict).toBe(false);
  });

  it('an unrelated question finds nothing', () => {
    expect(pickPriorOwnerDecision('Rotate the nightly bench to 03:00 UTC?', [row()], NOW)).toBeNull();
  });
});

describe('annotation round-trip + Same as before', () => {
  const match: PriorDecisionMatch = {
    row: { id: 'oq_1a2b3c4d-0000-0000-0000-000000000000', question: '[Spark] Keep shadow or flip?', status: 'answered', answer: 'Keep shadow [option hold; typed: "2"]', chosenOption: 'hold', resolvedAt: daysAgo(3) },
    strict: true,
    decidedOn: '2026-10-17',
  };

  it('renders "you decided this on <date>" with the short ref and the answer core, and parses back', () => {
    const note = renderPriorDecisionAnnotation(match);
    expect(note.startsWith(PRIOR_DECISION_MARK)).toBe(true);
    expect(note).toContain('you decided this on 2026-10-17 (oq_1a2b3c4d)');
    expect(note).toContain('«Keep shadow»');
    expect(note).toContain('Reply "Same as before"');
    const q = `[Spark] Keep shadow or flip?${note}`;
    expect(stripPriorDecisionAnnotation(q)).toBe('[Spark] Keep shadow or flip?');
    expect(parsePriorDecisionAnnotation(q)).toEqual({ decidedOn: '2026-10-17', questionRef: 'oq_1a2b3c4d', answer: 'Keep shadow' });
    expect(parsePriorDecisionAnnotation('[Spark] Keep shadow or flip?')).toBeNull();
  });

  it('a loose match quotes the prior question; an owner-only re-ask says why it is asked again', () => {
    const loose = renderPriorDecisionAnnotation({ ...match, strict: false });
    expect(loose).toContain('a closely matching question on 2026-10-17 (oq_1a2b3c4d: "Keep shadow or flip?")');
    expect(renderPriorDecisionAnnotation(match, { ownerOnlyReason: 'money' })).toContain('needs your call each time');
  });

  it('the dedupe / topic matchers ignore the annotation', () => {
    const q = '[Spark] Keep the wake_triage purpose in shadow mode?';
    const annotated = `${q}${renderPriorDecisionAnnotation(match)}`;
    expect(isSameDecisionQuestion(annotated, q)).toBe(true);
    expect(questionTopicDedupeMatch(annotated, q)).toBe(true);
  });

  it('priorDecisionAnswerCore strips option bookkeeping and the vault / same-as-before stamps', () => {
    expect(priorDecisionAnswerCore('Keep shadow [option hold; typed: "2"]')).toBe('Keep shadow');
    expect(priorDecisionAnswerCore('go [same as before — repeating the owner\'s 2026-10-01 decision oq_12345678]')).toBe('go');
  });

  it('withPriorDecisionOption appends "Same as before" to typed options only (≤ 6, never twice)', () => {
    const opts = [{ id: 'flip', label: 'Flip to act' }, { id: 'hold', label: 'Keep shadow' }];
    const out = withPriorDecisionOption(opts, match)!;
    expect(out.map((o) => o.id)).toEqual(['flip', 'hold', PRIOR_DECISION_OPTION_ID]);
    expect(out[2].consequence).toContain('repeat your 2026-10-17 decision: "Keep shadow"');
    expect(withPriorDecisionOption(out, match)).toBe(out);
    expect(withPriorDecisionOption(null, match)).toBeNull();
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(withPriorDecisionOption(six, match)).toBe(six);
  });

  it('resolveSameAsBefore maps the option pick / the words to the prior decision and its option', () => {
    const q = `[Spark] Flip wake_triage to act?${renderPriorDecisionAnnotation(match)}`;
    const options = withPriorDecisionOption([{ id: 'flip', label: 'Flip to act' }, { id: 'hold', label: 'Keep shadow' }], match)!;
    const viaOption = resolveSameAsBefore({ question: q, reply: '3', options, priorRow: { status: 'answered', answer: 'Keep shadow [option hold; typed: "2"]', chosenOption: 'hold' } });
    expect(viaOption).toEqual(expect.objectContaining({ reply: 'Keep shadow', option: expect.objectContaining({ id: 'hold' }) }));
    expect(viaOption?.stamp).toContain('repeating the owner\'s 2026-10-17 decision oq_1a2b3c4d');
    const viaWords = resolveSameAsBefore({ question: q, reply: 'same as before', options, priorRow: null });
    expect(viaWords?.reply).toBe('Keep shadow');
    expect(resolveSameAsBefore({ question: q, reply: 'Flip to act', options, priorRow: null })).toBeNull();
    expect(resolveSameAsBefore({ question: '[Spark] Flip?', reply: 'same as before', options: [], priorRow: null })).toBeNull();
  });

  it('SAME_AS_BEFORE_ANSWER_RE accepts the short forms and nothing longer', () => {
    for (const s of ['Same as before', 'same as before.', 'same', 'as before', 'same answer', 'repeat my decision']) expect(SAME_AS_BEFORE_ANSWER_RE.test(s)).toBe(true);
    for (const s of ['same as before but use the 14B', 'not the same as before']) expect(SAME_AS_BEFORE_ANSWER_RE.test(s)).toBe(false);
  });

  it('priorDecisionOption + refusal message cite the date, the ref and the answer', () => {
    expect(priorDecisionOption(match)).toEqual(expect.objectContaining({ id: PRIOR_DECISION_OPTION_ID, label: 'Same as before' }));
    const msg = priorDecisionRefusalMessage(match);
    expect(msg).toContain('2026-10-17 (oq_1a2b3c4d)');
    expect(msg).toContain('"Keep shadow"');
    expect(msg).toContain('revisitReason');
  });
});

describe('askVsDecideAdvisory — observe-only, supervisor filer on a machine turn', () => {
  it('advises deciding a non-owner-only card; the reversible + recommendation variant names it', () => {
    const plain = askVsDecideAdvisory({ supervisorFiler: true, machine: true, ownerOnlyReason: null });
    expect(plain.advise).toBe(true);
    expect(plain.reason).toBe('not_owner_only');
    expect(plain.message).toContain('[ASK-VS-DECIDE — observe-only]');
    expect(plain.message).toContain('nothing was refused');
    const rec = askVsDecideAdvisory({ supervisorFiler: true, machine: true, ownerOnlyReason: null, reversible: true, hasRecommendation: true });
    expect(rec.reason).toBe('reversible_with_recommendation');
  });

  it('never advises on a lane, a human turn, an owner-only class, or with the switch on', () => {
    expect(askVsDecideAdvisory({ supervisorFiler: false, machine: true, ownerOnlyReason: null }).advise).toBe(false);
    expect(askVsDecideAdvisory({ supervisorFiler: null, machine: true, ownerOnlyReason: null }).advise).toBe(false);
    expect(askVsDecideAdvisory({ supervisorFiler: true, machine: false, ownerOnlyReason: null }).advise).toBe(false);
    expect(askVsDecideAdvisory({ supervisorFiler: true, machine: true, ownerOnlyReason: 'money' }).advise).toBe(false);
    process.env.OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED = '1';
    expect(askVsDecideAdvisory({ supervisorFiler: true, machine: true, ownerOnlyReason: null }).advise).toBe(false);
  });
});

describe('reversibleDefaultEligibility — reversible WITH a recommendation, outside the owner-only classes', () => {
  it('arms only with both halves and no owner-only class', () => {
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'Keep 8B', ownerOnlyReason: null })).toEqual({ armed: true, reason: 'armed' });
    expect(reversibleDefaultEligibility({ reversible: false, recommendedDefault: 'Keep 8B', ownerOnlyReason: null }).armed).toBe(false);
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: '  ', ownerOnlyReason: null }).reason).toBe('no_recommended_default');
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'Keep 8B', ownerOnlyReason: 'money' }).reason).toBe('owner_only:money');
  });

  it('typed gates arm only when the default IS the declared shape', () => {
    const options = [{ id: 'go', label: 'Go' }, { id: 'hold', label: 'Hold' }];
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'hold', ownerOnlyReason: null, expectedType: 'choice', options }).armed).toBe(true);
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'later', ownerOnlyReason: null, expectedType: 'choice', options }).reason).toBe('default_not_an_option');
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'no', ownerOnlyReason: null, expectedType: 'yes_no' }).armed).toBe(true);
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'x', ownerOnlyReason: null, expectedType: 'credential' }).reason).toBe('credential_gate');
    expect(reversibleDefaultFitsTypedGate('choice', 'go', options)).toBe(true);
    expect(reversibleDefaultFitsTypedGate('credential', 'go', options)).toBe(false);
    expect(reversibleDefaultFitsTypedGate(null, 'anything', [])).toBe(true);
  });

  it('OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED=1 never arms', () => {
    process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED = '1';
    expect(reversibleDefaultEligibility({ reversible: true, recommendedDefault: 'Keep 8B', ownerOnlyReason: null }).reason).toBe('disabled');
  });
});

describe('digestDue — at most every 12 h, no card held past 12 h', () => {
  const anchor = Date.parse('2026-10-20T00:00:00Z');
  it('is due one sweep (15 min) before the oldest card turns 12 h old', () => {
    expect(digestDue({ oldestAnchorMs: anchor, nowMs: anchor + OWNER_DECISION_DIGEST_WINDOW_MS - OWNER_DECISION_DIGEST_SLACK_MS - 1 })).toBe(false);
    expect(digestDue({ oldestAnchorMs: anchor, nowMs: anchor + OWNER_DECISION_DIGEST_WINDOW_MS - OWNER_DECISION_DIGEST_SLACK_MS })).toBe(true);
    expect(digestDue({ oldestAnchorMs: NaN, nowMs: anchor })).toBe(true); // unreadable anchor is never held
  });
});

describe('renderOwnerDecisionDigest', () => {
  it('leads with the bare-reply marker, lists each card by its ref (no ordinal) + options, lists applied defaults and the load', () => {
    const text = renderOwnerDecisionDigest({
      questions: [
        { id: 'oq_11111111-a', question: '[Spark] Use the 8B checkpoint?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
        { id: 'oq_22222222-b', question: '[CanLaw] Rename the column?', defaultAfterDays: 1, defaultOption: 'Keep it' },
      ],
      defaults: [{ id: 'oq_33333333-c', question: '[Spark] Retry the flaky shard?', defaultLabel: 'Retry once' }],
      more: 2,
      load: { asked: 9, answeredByOwner: 4, defaulted: 1 },
    });
    expect(text).toMatch(/^🗂 Digby needs your decision — 2 cards in this 12-hour digest/);
    expect(text).toContain('• [11111111] [Spark] Use the 8B checkpoint?');
    expect(text).toContain('   1. Yes');
    expect(text).toContain('• [22222222] [CanLaw] Rename the column?');
    expect(text).toContain('defaults to "Keep it" after 1 day');
    expect(text).toContain('…and 2 more in Digby → Management → Inbox.');
    expect(text).toContain('Defaults applied (reversible');
    expect(text).toContain('• [33333333] [Spark] Retry the flaky shard? → "Retry once"');
    expect(text).toContain('Your last 7 days: 9 cards filed · 4 answered by you · 1 resolved by a default.');
    expect(text).toContain('answer <ref>');
  });

  it('never numbers the cards: the Telegram router reads "answer <N>" as the N-th open card NEWEST first (review 2026-10-20)', () => {
    const text = renderOwnerDecisionDigest({
      questions: [
        { id: 'oq_aaaaaaaa-1', question: 'Oldest card?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
        { id: 'oq_bbbbbbbb-2', question: 'Newer card?' },
      ],
      defaults: [],
    });
    // A card line never starts with an ordinal — only option lines (indented,
    // scoped to their own card) are numbered.
    expect(text).not.toMatch(/^\d+\.\s*\[/m);
    expect(text.split('\n').filter((l) => /^\s+\d+\. /.test(l))).toEqual(['   1. A', '   2. B']);
    // The reply hint spells a REAL ref, never a position.
    expect(text).toContain('"answer aaaaaaaa <your answer>"');
  });

  it('a defaults-only digest has no decision marker and no answer hint', () => {
    const text = renderOwnerDecisionDigest({ questions: [], defaults: [{ id: 'oq_33333333-c', question: 'Retry?', defaultLabel: 'Retry once' }] });
    expect(text).not.toContain('needs your decision');
    expect(text).not.toContain('answer <ref>');
  });
});

describe('fitOwnerDecisionDigest — ONE Telegram message (review 2026-10-20)', () => {
  const card = (i: number) => ({
    id: `oq_${String(i).padStart(8, '0')}-x`,
    question: `Card ${i}: ${'long context '.repeat(40)}`,
    options: [{ id: 'a', label: 'Option A', consequence: 'c'.repeat(250) }, { id: 'b', label: 'Option B', consequence: 'd'.repeat(250) }],
  });

  it('moves the newest cards to "…and N more" until the text fits; the oldest stay', () => {
    const questions = Array.from({ length: 15 }, (_, i) => card(i + 1));
    const { text, shown } = fitOwnerDecisionDigest({ questions, defaults: [] });
    expect(text.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
    expect(shown).toBeLessThan(15);
    expect(shown).toBeGreaterThan(0);
    expect(text).toContain('[00000001]');
    expect(text).toContain(`…and ${15 - shown} more in Digby → Management → Inbox.`);
  });

  it('counts defaults past the cap; drops option consequences, then hard-clips a single giant card', () => {
    const defaults = Array.from({ length: 14 }, (_, i) => ({ id: `oq_d${i}`, question: `Default ${i}?`, defaultLabel: 'Go' }));
    const many = fitOwnerDecisionDigest({ questions: [card(1)], defaults });
    expect(many.text).toContain('…and 4 more defaults applied');
    const compact = fitOwnerDecisionDigest({ questions: [card(1)], defaults: [], maxChars: 1200 });
    expect(compact.text.length).toBeLessThanOrEqual(1200);
    expect(compact.text).toContain('1. Option A');
    expect(compact.text).not.toContain('cccc');
    const clipped = fitOwnerDecisionDigest({ questions: [card(1)], defaults: [], maxChars: 300 });
    expect(clipped.text.length).toBeLessThanOrEqual(300);
    expect(clipped.text.endsWith('…')).toBe(true);
  });
});

describe('"Same as before" maps by LABEL, never by option id / position (review 2026-10-20 BLOCKING)', () => {
  // The reproduction: the prior card offered [opt_1 "Keep it going", opt_2
  // "Kill the run"] and the owner chose opt_2. A lane re-asks with the options
  // REORDERED — normalizeOwnerQuestionOptions assigns positional ids, so opt_2
  // now means "Keep it going".
  const prior = {
    id: 'oq_9f8e7d6c-0000-0000-0000-000000000000', question: 'Kill the stalled run or keep it going?', status: 'answered',
    answer: 'Kill the run [option opt_2; typed: "2"]', chosenOption: 'opt_2',
    options: [{ id: 'opt_1', label: 'Keep it going' }, { id: 'opt_2', label: 'Kill the run' }], resolvedAt: daysAgo(1),
  };
  const match: PriorDecisionMatch = { row: prior, strict: true, decidedOn: '2026-10-19' };
  const reordered = [{ id: 'opt_1', label: 'Kill the run' }, { id: 'opt_2', label: 'Keep it going' }];

  it('mapPriorDecisionToOption picks the option carrying the prior LABEL', () => {
    expect(mapPriorDecisionToOption({ priorRow: prior, answer: prior.answer, options: reordered })?.id).toBe('opt_1');
    // Same order: the same label → the same option.
    expect(mapPriorDecisionToOption({ priorRow: prior, answer: prior.answer, options: prior.options })?.id).toBe('opt_2');
    // Labels differ only by case / punctuation → still the same decision.
    expect(mapPriorDecisionToOption({ priorRow: prior, answer: prior.answer, options: [{ id: 'x', label: 'kill the run!' }] })?.id).toBe('x');
  });

  it('no option with that label → null (free text), never an id or a bare number', () => {
    expect(mapPriorDecisionToOption({ priorRow: prior, answer: prior.answer, options: [{ id: 'opt_2', label: 'Pause it' }, { id: 'opt_1', label: 'Resume it' }] })).toBeNull();
    // A prior FREE-TEXT answer "2" is not "option 2 of THIS card".
    expect(mapPriorDecisionToOption({ priorRow: { chosenOption: null }, answer: '2', options: reordered })).toBeNull();
    // A prior answer that happens to equal an id is not that option either.
    expect(mapPriorDecisionToOption({ priorRow: { chosenOption: null }, answer: 'opt_2', options: reordered })).toBeNull();
  });

  it('resolveSameAsBefore on the reordered card returns "Kill the run" / opt_1 (it used to return "Keep it going" / opt_2)', () => {
    const q = `Kill the stalled run or keep it going?${renderPriorDecisionAnnotation(match)}`;
    const options = withPriorDecisionOption(reordered, match)!;
    const viaButton = resolveSameAsBefore({ question: q, reply: PRIOR_DECISION_OPTION_ID, options, priorRow: prior });
    expect(viaButton).toEqual(expect.objectContaining({ reply: 'Kill the run', option: expect.objectContaining({ id: 'opt_1', label: 'Kill the run' }) }));
    const viaWords = resolveSameAsBefore({ question: q, reply: 'same as before', options, priorRow: prior });
    expect(viaWords?.option?.id).toBe('opt_1');
    // The prior row unavailable: the annotation's answer text is the label.
    expect(resolveSameAsBefore({ question: q, reply: 'same as before', options, priorRow: null })?.option?.id).toBe('opt_1');
  });

  it('withPriorDecisionOption: a typed gate gets the button only when the prior decision satisfies it', () => {
    expect(withPriorDecisionOption(reordered, match, { expectedType: 'choice' })!.map((o) => o.id)).toEqual(['opt_1', 'opt_2', PRIOR_DECISION_OPTION_ID]);
    const unrelated = [{ id: 'opt_1', label: 'Pause it' }, { id: 'opt_2', label: 'Resume it' }];
    expect(withPriorDecisionOption(unrelated, match, { expectedType: 'choice' })).toBe(unrelated);
    // yes_no: a prior ruling qualifies; a non-ruling that maps to nothing does not.
    const yesPrior: PriorDecisionMatch = { ...match, row: { ...prior, answer: 'Yes — kill it', chosenOption: null, options: null } };
    expect(withPriorDecisionOption(unrelated, yesPrior, { expectedType: 'yes_no' })!.some((o) => o.id === PRIOR_DECISION_OPTION_ID)).toBe(true);
    expect(withPriorDecisionOption(unrelated, match, { expectedType: 'yes_no' })).toBe(unrelated);
    expect(withPriorDecisionOption(unrelated, match, { expectedType: 'credential' })).toBe(unrelated);
    // An untyped card keeps today's behaviour (free text covers an unmapped prior).
    expect(withPriorDecisionOption(unrelated, match)!.some((o) => o.id === PRIOR_DECISION_OPTION_ID)).toBe(true);
  });
});

describe('annotateQuestionWithPriorDecision — the new question is never cut silently (review 2026-10-20)', () => {
  const match: PriorDecisionMatch = {
    row: { id: 'oq_1a2b3c4d-0000-0000-0000-000000000000', question: 'Old: keep shadow?', status: 'answered', answer: `Keep shadow ${'because '.repeat(40)}`, resolvedAt: daysAgo(3) },
    strict: false,
    decidedOn: '2026-10-17',
  };

  it('full note when it fits; compact note near the budget; an explicit marker only when even that cannot fit', () => {
    const short = annotateQuestionWithPriorDecision('Flip it?', match, { budget: 2000 });
    expect(short).toBe(`Flip it?${renderPriorDecisionAnnotation(match)}`);
    const near = 'q'.repeat(1700);
    const compact = annotateQuestionWithPriorDecision(near, match, { budget: 2000 });
    expect(compact.startsWith(near)).toBe(true); // every char of the new question kept
    expect(compact.length).toBeLessThanOrEqual(2000);
    expect(compact).toContain('a closely matching question on 2026-10-17 (oq_1a2b3c4d)');
    expect(parsePriorDecisionAnnotation(compact)).toEqual(expect.objectContaining({ questionRef: 'oq_1a2b3c4d' }));
    const huge = 'z'.repeat(1990);
    const cut = annotateQuestionWithPriorDecision(huge, match, { budget: 2000 });
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut).toContain(QUESTION_TRUNCATED_FOR_NOTE_MARK);
    expect(stripPriorDecisionAnnotation(cut).endsWith(QUESTION_TRUNCATED_FOR_NOTE_MARK)).toBe(true);
  });
});

describe('isPermanentReversibleRefusal', () => {
  it('owner-only and typed-gate refusals retire the default; transient ones do not', () => {
    expect(isPermanentReversibleRefusal('owner_only:money')).toBe(true);
    expect(isPermanentReversibleRefusal('typed_gate')).toBe(true);
    for (const r of ['error', 'lost_race', 'not_due', 'not_open', 'reversible_disabled']) expect(isPermanentReversibleRefusal(r)).toBe(false);
  });
});

describe('clipQuestionKeepingAnnotation', () => {
  it('keeps the annotation when the question is clipped; byte-identical head slice otherwise', () => {
    const head = 'x'.repeat(1200);
    const q = `${head}${PRIOR_DECISION_MARK} you decided this on 2026-10-01 (oq_12345678): «go». Reply "Same as before" to repeat it.`;
    const out = clipQuestionKeepingAnnotation(q, 900);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out).toContain('you decided this on 2026-10-01');
    expect(clipQuestionKeepingAnnotation(head, 900)).toBe(head.slice(0, 900));
    expect(clipQuestionKeepingAnnotation('short', 900)).toBe('short');
  });
});
