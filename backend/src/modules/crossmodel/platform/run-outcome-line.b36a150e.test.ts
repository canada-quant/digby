/**
 * Ticket b36a150e — STRUCTURED VERDICT FIELD for run-outcome extraction.
 *
 * THE COVERAGE CEILING (from 4baa7c3e, PR #1772): an 8-round adversarial
 * ladder over NEGATIVE_RE/STANDING showed every regex widening mints NEW
 * boundary classes of its own, so the supervisor's ladder-close ruling CAPPED
 * the vocabulary (four prose classes pinned as DOCUMENTED BOUNDARY in
 * run-outcome-line.4baa7c3e.test.ts) and routed the residual coverage to a
 * STRUCTURED field: the reviewer/lane emits a machine-readable verdict line
 * alongside its prose —
 *
 *   {"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}
 *
 * — and extractRunVerdict reads it with precedence over the regex fallback:
 *   - a structured NOT-MERGE-SAFE wins outright (over prose, over the
 *     explicit VERDICT: line) and carries its own blocking count;
 *   - a structured MERGE-SAFE is gated by the SAME negative tests the
 *     explicit-line lane uses (a prose negative flips it; the B1 quoted
 *     negative veto and the truncation veto decline to n/a) — the prose wins
 *     ties against a positive field, exactly as it does against an explicit
 *     positive line, because a false MERGE-SAFE is the module's documented
 *     dangerous direction;
 *   - a field that is not the exact contract (wrong value, tail, multi-line,
 *     foreign key order) is ABSENT — the regex fallback runs unchanged.
 *
 * NO-REGRESSION PROOF: every no-field expectation in this file was probed
 * against the PRISTINE (pre-change) module blob this lane — identical
 * readings, zero drift; the four boundary classes keep their pinned
 * DOCUMENTED BOUNDARY readings in the 4baa7c3e file (MERGE-SAFE by regex,
 * untouched). The with-field rows are the ticket's acceptance corpus.
 */
import { extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome } from './run-outcome-line';

describe('ticket b36a150e — the structured verdict field', () => {
  it('REPLAY: a structured NOT-MERGE-SAFE stamps NOT-MERGE-SAFE with its own blocking count', () => {
    expect(extractRunVerdict('merge-safe — F3 is unresolved\n{"verdict":"NOT-MERGE-SAFE","blocking":1,"source":"reviewer-final"}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
  });

  it('CLASS 1 (r7 findings 2+3): identifier/pronoun-led standing and the "tests" noun remain-forms', () => {
    for (const prose of [
      'merge-safe — F3 is unresolved',
      'merge-safe — F3 remains unresolved',
      'merge-safe — the tests remain unfixed',
      'merge-safe — the tests remain unresolved',
    ]) {
      expect(extractRunVerdict(`${prose}\n{"verdict":"NOT-MERGE-SAFE","blocking":1,"source":"reviewer-final"}`).verdict)
        .toBe('NOT-MERGE-SAFE');
      expect(extractRunVerdict(prose).verdict).toBe('MERGE-SAFE'); // boundary pin — regex untouched
    }
  });

  it('CLASS 2 (r8 finding 1): negated scope/deferred words and cascade suppression', () => {
    for (const prose of [
      'merge-safe — the blocker was not fixed; this is not an accepted risk',
      'merge-safe — the blocker was not fixed; it was not deferred, it is simply open',
      'merge-safe — the blocker was not fixed; F2 still stands; the lockfile warning is pre-existing',
      'merge-safe — the blocker was not fixed; the cosmetic nit was deferred; F3 still stands',
      'merge-safe — the blocker was not fixed; the cosmetic nit was deferred; two blockers remain open',
    ]) {
      expect(extractRunVerdict(`${prose}\n{"verdict":"NOT-MERGE-SAFE","blocking":2}`).verdict).toBe('NOT-MERGE-SAFE');
      expect(extractRunVerdict(prose).verdict).toBe('MERGE-SAFE'); // boundary pin — regex untouched
    }
  });

  it('CLASS 2 controls: deferred / pre-existing / out-of-scope narration stays safe, with or without a field', () => {
    for (const control of [
      'merge-safe — the blocker was not fixed by this round; it was deferred to the next ticket by the owner',
      'merge-safe — not fixed by this round, but pre-existing on main',
      'merge-safe — the stale lockfile warning was not fixed — pre-existing, out of scope',
    ]) {
      expect(extractRunVerdict(control).verdict).toBe('MERGE-SAFE'); // pinned in the 4baa file
      expect(extractRunVerdict(`${control}\n{"verdict":"MERGE-SAFE","blocking":0}`).verdict).toBe('MERGE-SAFE');
    }
  });

  it('CLASS 3 (r8 finding 2): except-qualified absences', () => {
    for (const prose of [
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain except F3.',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain except F3 and F5.',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no issues remain except F2.',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain but F3.',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; zero blockers remain except F3.',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain except F3, which the owner deferred.',
    ]) {
      expect(extractRunVerdict(`${prose}\n{"verdict":"NOT-MERGE-SAFE","blocking":1}`).verdict).toBe('NOT-MERGE-SAFE');
    }
    // The control — the SAME sentence WITHOUT the except-qualifier — keeps
    // discounting in every shape (pure prose fails open to n/a, the close-out
    // template with its own VERDICT: MERGE-SAFE line reads MERGE-SAFE): a
    // positive field agrees, it never flips a discount to negative.
    const noExcept = 'Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed; no blockers remain';
    expect(extractRunVerdict(`${noExcept}.`).verdict).toBe('n/a');
    expect(extractRunVerdict(`${noExcept}.\n\nVERDICT: MERGE-SAFE`).verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict(`${noExcept}.\n{"verdict":"MERGE-SAFE","blocking":0}`).verdict).toBe('MERGE-SAFE');
  });

  it('CLASS 4: auxiliary standing forms after a masked absence', () => {
    for (const prose of [
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain; the latch race has not been resolved',
      'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain; F2 has not been fixed',
    ]) {
      expect(extractRunVerdict(`${prose}\n{"verdict":"NOT-MERGE-SAFE","blocking":1}`).verdict).toBe('NOT-MERGE-SAFE');
      // Pure prose fails open to n/a on main (probed pristine-identical) —
      // with a trailing close-out VERDICT: MERGE-SAFE line it reads
      // MERGE-SAFE, the ticket's boundary class; the field fixes both.
      expect(extractRunVerdict(prose).verdict).toBe('n/a');
      expect(extractRunVerdict(`${prose}\n\nVERDICT: MERGE-SAFE`).verdict).toBe('MERGE-SAFE');
    }
  });

  it('PRECEDENCE: the structured negative outranks the explicit VERDICT: line and prose', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n{"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE"}\nall tests pass, safe to merge, no blockers remain').verdict)
      .toBe('NOT-MERGE-SAFE');
    // The close-out template shape the ticket cites: an except-qualified
    // absence that the positional rule discounts, PLUS the live field.
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain except F3.\n\nVERDICT: MERGE-SAFE\n{"verdict":"NOT-MERGE-SAFE","blocking":1}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
  });

  it('PRECEDENCE: a structured MERGE-SAFE is gated by the prose negative tests (the prose wins ties)', () => {
    // A current negative in the lane's own words flips the field's positive.
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE","blocking":0}\nHowever, DO NOT MERGE — the isolation boundary leaks.').verdict)
      .toBe('NOT-MERGE-SAFE');
    // The B1 quoted-negative veto: a masked FOREIGN negative declines to n/a,
    // never MERGE-SAFE over the reviewer's word.
    expect(extractRunVerdict('Our fix is merge-safe.\n{"verdict":"MERGE-SAFE","blocking":0}\nThe reviewer wrote "DO NOT MERGE".').verdict)
      .toBe('n/a');
    // An open quote that truncated the view declines to n/a (R2-2 veto).
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE"}\nsafe to merge.\n0.5" of drift\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n').verdict)
      .toBe('n/a');
    // A HISTORICAL (doctrine-discounted) negative does NOT veto the field.
    expect(extractRunVerdict('The round-1 review returned NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed in 256c7399e.\n{"verdict":"MERGE-SAFE","blocking":0}').verdict)
      .toBe('MERGE-SAFE');
  });

  it('PRECEDENCE: the explicit VERDICT: line and the guard override keep their contracts (no field present)', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — all clear').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: '{"verdict":"MERGE-SAFE"}', verdictOverride: 'GUARD-REPLACED' }))
      .toContain('VERDICT: GUARD-REPLACED');
  });

  it('FIELD ABSENCE: shapes that are not the exact contract are ignored (the regex fallback runs)', () => {
    // Wrong value — absent; the prose fallback decides (merge-safe prose wins,
    // no "BLOCK" value hoists a negative).
    expect(extractRunVerdict('{"verdict":"BLOCK"}\nthe fix is merge-safe').verdict).toBe('n/a');
    // Lower-case value — the FIELD is absent (exact contract), but the
    // pre-existing relay carve-out keeps a colon-introduced quoted bare
    // positive verbatim (case-insensitive, the da70e157 relay idiom), so the
    // prose fallback still finds it — pristine-identical, documented here so
    // the FIELD's absence is not confused with the text's reading.
    expect(extractRunVerdict('{"verdict":"merge-safe"}').verdict).toBe('MERGE-SAFE');
    // A tail after the value — absent.
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE — once CI is green"}').verdict).toBe('n/a');
    // Extra unknown keys between the contract keys — the FIELD is absent; the
    // pre-existing relay carve-out still keeps the colon-introduced quoted
    // bare positive, so the reading stays MERGE-SAFE via prose (the field
    // contract is what is pinned here — pristine-identical).
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE","other":true,"blocking":0}').verdict).toBe('MERGE-SAFE');
    // blocking before verdict — the FIELD is absent (key order is part of the
    // contract); the pre-existing relay carve-out still keeps the quoted bare
    // positive (colon-introduced by "verdict":), so prose reads MERGE-SAFE.
    expect(extractRunVerdict('{"blocking":0,"verdict":"MERGE-SAFE"}').verdict).toBe('MERGE-SAFE');
    // No verdict key at all — absent, and no relay cue either.
    expect(extractRunVerdict('{"result":"MERGE-SAFE"}').verdict).toBe('n/a');
  });

  it('REPLAY: the field survives the environments a real final answer puts it in', () => {
    // 3c354a95: a field inside a FENCE the emitter quoted is FOREIGN text (a
    // documented/quoted example, not the author's assertion) — the negative
    // falls to the prose tiers, where the mask has already erased the span;
    // the quoted-negative veto declines to n/a. Pre-fix this read
    // NOT-MERGE-SAFE (the field was read pre-mask on raw text). A field on
    // the author's OWN line keeps its fail-closed win — pinned below and in
    // the 3c354a95 suite.
    expect(extractRunVerdict('Final answer prose.\n```\n{"verdict":"NOT-MERGE-SAFE","blocking":2}\n```\n').verdict)
      .toBe('n/a');
    // Spaces inside the JSON (pretty-printed on one line).
    expect(extractRunVerdict('prose { "verdict" : "MERGE-SAFE" } tail').verdict).toBe('MERGE-SAFE');
    // A "source" self-description key is tolerated in either slot order.
    expect(extractRunVerdict('{"source":"lane-final","verdict":"NOT-MERGE-SAFE","blocking":1}').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE","source":"lane-final"}').verdict).toBe('NOT-MERGE-SAFE');
    // A historical QUOTED negative field plus a final positive field: the
    // relay carve-out keeps the colon-introduced quoted negative verbatim in
    // the masked view (a kept relay feeds the prose negative scan —
    // fail-closed), so the pair reads NOT-MERGE-SAFE even though the last
    // parse is positive. Pristine-identical semantics for the quoted span;
    // the safe reading for a contradictory pair.
    expect(extractRunVerdict('the round-1 field was {"verdict":"NOT-MERGE-SAFE","blocking":2} and both findings were fixed in 256c7399e\n{"verdict":"MERGE-SAFE","blocking":0}').verdict)
      .toBe('NOT-MERGE-SAFE');
  });

  it('FAIL-CLOSED: a negative field in the text keeps the negative read even when it is not the last parse', () => {
    // Both orderings read NOT-MERGE-SAFE: the field is read pre-mask on the
    // raw text, so an early negative field plus a later positive one is a
    // CONTRADICTORY pair — the safe reading is the negative (a reviewer that
    // wrote NOT-MERGE-SAFE anywhere in a field-shaped line is never stamped
    // MERGE-SAFE by a later line it may not have written).
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE"}\nmore prose\n{"verdict":"MERGE-SAFE"}').verdict)
      .toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE"}\nmore prose\n{"verdict":"NOT-MERGE-SAFE","blocking":3}').verdict)
      .toBe('NOT-MERGE-SAFE');
    // A historical quoted field with NO later field: the negative value is
    // still read (fail-closed — a quoted reviewer negative is never erased),
    // and it keeps its blocking count.
    expect(extractRunVerdict('the round-1 field was {"verdict":"NOT-MERGE-SAFE","blocking":2} and both findings were fixed in 256c7399e'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('REPLAY: the producer outcome line carries the structured field verdict, front-loaded', () => {
    const line = buildRunOutcomeLine({
      outcome: 'completed',
      finalText: 'merge-safe — F3 is unresolved\n{"verdict":"NOT-MERGE-SAFE","blocking":1,"source":"reviewer-final"}',
    });
    expect(line).toContain('VERDICT: NOT-MERGE-SAFE');
    expect(line).toContain('BLOCKING: 1');
    const front = frontLoadRunOutcome('Summary text.', {
      outcome: 'completed',
      finalText: 'Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; no blockers remain except F3.\n{"verdict":"NOT-MERGE-SAFE","blocking":1}',
    });
    expect(front.startsWith('RUN_OUTCOME:')).toBe(true);
    expect(front).toContain('VERDICT: NOT-MERGE-SAFE');
    expect(front).toContain('BLOCKING: 1');
  });

  it('REVIEW F1 (BLOCKING, fixed): a FOREIGN positive field never stamps MERGE-SAFE — the attribution gate', () => {
    // All twelve reviewer repros (adversarial review of 2b03daf12, finding F1).
    // Pre-fix: every one read MERGE-SAFE/0. Post-fix: the structured positive
    // must live on text the masking contract counts as the author's OWN — a
    // fence, blockquote, table row, inline-code span, or quoted/relayed span
    // is not the author's assertion, so the field is absent and the regex
    // fallback decides (these prose tails carry no fallback vocabulary → n/a,
    // or a live negative → NOT-MERGE-SAFE). NEVER MERGE-SAFE.
    const repros: Array<[string, 'n/a' | 'NOT-MERGE-SAFE']> = [
      // All 12 read n/a/0 on old main per the reviewer's table; the post-fix
      // expectation is the return to that safe reading (the reviewer's table
      // column "old" is the contract — prose tails outside the capped
      // vocabulary fail open to n/a, in-vocabulary tails read NOT-MERGE-SAFE).
      ['```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nTwo blockers remain open after the fix.', 'n/a'],
      ['```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nThe latch race has not been resolved.', 'n/a'],
      ['```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nThe tests remain unfixed.', 'n/a'],
      ['Per doctrine the line is:\n```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nThat is the contract.', 'n/a'],
      ['emit `{"verdict":"MERGE-SAFE","blocking":0}` to stamp it', 'n/a'],
      ['> {"verdict":"MERGE-SAFE","blocking":0}\nprose after', 'n/a'],
      ['| field |\n| --- |\n| {"verdict":"MERGE-SAFE","blocking":0} |', 'n/a'],
      ['Final verdict (read this run, message 5cedea7b, 14:26Z): "{"verdict":"MERGE-SAFE","blocking":0}" — I disagree; two blockers remain open', 'n/a'],
      ['Applied the fixes.\n\nReviewer final answer:\n```json\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nBuild is green.', 'n/a'],
      ['The prior lane reported:\n> {"verdict":"MERGE-SAFE","blocking":0}\nI have not re-run anything.', 'n/a'],
      ['The reviewer wrote `{"verdict":"MERGE-SAFE","blocking":0}` in its final line.', 'n/a'],
      ['| lane | field |\n|---|---|\n| reviewer | {"verdict":"MERGE-SAFE","blocking":0} |', 'n/a'],
    ];
    for (const [text, expected] of repros) {
      const got = extractRunVerdict(text).verdict;
      expect(got).toBe(expected);
      expect(got).not.toBe('MERGE-SAFE');
    }
    // The gate must NOT break the author's OWN field: same shapes, the field
    // on the author's own unquoted line, still stamp MERGE-SAFE.
    expect(extractRunVerdict('All checks green.\n{"verdict":"MERGE-SAFE","blocking":0}').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE"}\nnothing else asserts a verdict').verdict).toBe('MERGE-SAFE');
  });

  it('REVIEW F2 (fixed): multi-line JSON is absent — the one-line contract is now real', () => {
    // The reviewer proved the first regex matched across newlines (\s). The
    // fixed regex uses [ \t] only: a multi-line object is absent as a FIELD.
    // The reading here is still fail-closed: the pre-existing relay carve-out
    // (11a35cfb — "verdict" + colon introduces the quoted value span) keeps
    // the quoted NOT-MERGE-SAFE value verbatim for the PROSE fallback, so the
    // multi-line negative reads NOT-MERGE-SAFE through prose, main-identical.
    // The load-bearing pin is that the FIELD no longer contributes a count:
    // pre-fix the multi-line negative field hoisted blocking:2; post-fix the
    // count tier falls back to prose (0).
    expect(extractRunVerdict('{\n  "verdict": "NOT-MERGE-SAFE",\n  "blocking": 2\n}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 0 });
    // A multi-line POSITIVE is absent AND its quoted positive is masked as a
    // foreign span (no relay cue for a bare positive... the "verdict": cue
    // keeps it — so this pins the relay idiom, not the field): the reading
    // stays MERGE-SAFE via prose, fail-open like any prose positive on main.
    expect(extractRunVerdict('{\n  "verdict": "MERGE-SAFE",\n  "blocking": 0\n}').verdict).toBe('MERGE-SAFE');
    // The one-line shape with internal spaces still matches as a field.
    expect(extractRunVerdict('prose { "verdict" : "MERGE-SAFE" } tail').verdict).toBe('MERGE-SAFE');
  });

  it('REVIEW F3 (documented): source-BEFORE-verdict is not the contract — verdict-first key order only', () => {
    // The reviewer measured: {"source":…,"verdict":…} does not match (field
    // absent, blocking count lost, prose fallback runs). Pinned as the
    // documented contract rather than widened: the machine shape is exact,
    // and the doctrine bullet teaches verdict-first. Both orders read safe
    // here (the negative direction still fires via the prose fallback).
    expect(extractRunVerdict('{"source":"r","verdict":"NOT-MERGE-SAFE","blocking":1}').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE","source":"r","blocking":1}').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE","source":"r"}').verdict).toBe('NOT-MERGE-SAFE');
    // Verdict-first with blocking keeps its count; source-first does NOT
    // contribute a count (the field is absent — the count tier falls back to
    // prose, 0 here).
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"r"}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('{"source":"r","verdict":"NOT-MERGE-SAFE","blocking":2}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 0 });
  });
});
