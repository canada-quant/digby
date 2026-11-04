/**
 * Ticket 2f14eb79 — the run-outcome digest's blocking count over a
 * backticked structured-verdict field on a clean adversarial-review final.
 *
 * THE DEFECT: a reviewer lane's run_completed digest carried
 * "VERDICT: MERGE-SAFE · BLOCKING: 2" while the lane's own final answer
 * (msg b6434ddf, chat 05f3c943, 13:07Z 2026-10-24) stated VERDICT: MERGE-SAFE
 * with the machine line `{"verdict":"MERGE-SAFE","blocking":0}` — the field
 * wrapped in an inline code span. TWO causes interacted:
 *   (a) the 54af5c27/11a35cfb OWN-WORDS mask erases the span, so the field
 *       (verdict AND count) never reached the b36a150e field read;
 *   (b) even pre-ticket, a positive field's "blocking" count was honored
 *       ONLY for negative fields — an unwrapped field would ALSO have read
 *       BLOCKING: 2 (probe: this file's NO-FIELD/UNWRAPPED rows pinned the
 *       pre-fix reading at 2 for all three shapes).
 * The count then fell to the BLOCKING_COUNT_STATEMENT tier, which mined the
 * RESOLVED round history ("Round-1 blocking findings — both fixed, both
 * proven fixed") into 2.
 *
 * THE FIX (COUNT CORROBORATION): a positive field's "blocking":0 is honored
 * as a COUNT — never as a verdict — regardless of attribution, replacing the
 * prose-mined count at every MERGE-SAFE return. A masked-span field still
 * never supplies a VERDICT (the b36a150e/3c354a95 attribution contract is
 * untouched: the 3c354a95 documentation-example pins must stay green); a
 * nonzero field count never overrides a prose count (overcount is the safe
 * direction); the last ATTRIBUTED positive field beats the raw last field
 * (a later documentation example quoting 0 must not zero the live emitter's
 * own nonzero count).
 */
import { buildRunOutcomeLine, extractRunVerdict } from './run-outcome-line';

describe('ticket 2f14eb79 — the production specimen (msg b6434ddf, replayed verbatim in its load-bearing head)', () => {
  // The reviewer's round-2 final, VERBATIM in every load-bearing fragment:
  // the explicit VERDICT heading, the backticked machine field, the resolved
  // round-1 history heading (the false-count source), the two FIXED findings,
  // the fenced probe output, the markdown battery table, and the close-out
  // tail that restates the resolved count.
  const SPECIMEN = [
    '# ADVERSARIAL RE-REVIEW — round 2, tip `0c7e5ac35` (ticket 1a6afc6a) — FINAL VERDICT',
    '',
    'The full battery ran before the server restart (all results below were executed by me in detached worktrees at the tip `0c7e5ac35` and at fail-open `4c9753df7`; scratch worktrees were cleaned up). After the restart I re-anchored the mutable state with fresh reads — which changes the frame: **the change set has already landed** (PR #1945, MERGED 2026-10-24T12:53:42Z, `headRefOid` exactly `0c7e5ac35`, squash-merged as `fa32db807`, now origin/main\'s tip). The verdict below therefore stands as the merge-safety verdict for the review subject, with landed-state proof attached.',
    '',
    '## VERDICT: MERGE-SAFE',
    '',
    '`{"verdict":"MERGE-SAFE","blocking":0}`',
    '',
    '## Round-1 blocking findings — both fixed, both proven fixed with independent reproductions',
    '',
    '**B1 (fail-open re-read) — FIXED.** At the tip, `closedIds = statuses === null ? null : …` with `if (closedIds === null)` → own warn ("spawn skipped, claims released (fail-closed…)", service :3822) and the guard `if (closedIds === null || closedIds.length)` (:3831) releasing all member + lead claims, refunding the token, `continue` — *before* `startCodingSession` (:3838). Metric records only on a positive closed-sighting.',
    '',
    '**B2 (vacuous fail-closed test) — FIXED.** The test now fails only the re-read\'s exact query shape and proves the block came from the fail-closed path via the drain\'s own warn log. Probe suite: `Tests: 1 passed, 1 total`.',
    '',
    '**Bottom line for ticket 1a6afc6a\'s claim manifest:** fix verified, replay test 13/13, verify chain green at the tip, PR #1945 MERGED at 12:53:42Z with the reviewed head. Round-1\'s two blocking findings are resolved; remaining observations are non-blocking and already recorded.',
  ].join('\n');

  it('REPLAY: the specimen reads MERGE-SAFE · 0 (pre-fix: MERGE-SAFE · 2, the ticket\'s report)', () => {
    expect(extractRunVerdict(SPECIMEN)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('REPLAY: the producer digest line over the specimen carries BLOCKING: 0', () => {
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: SPECIMEN }))
      .toBe('RUN_OUTCOME: completed · VERDICT: MERGE-SAFE · BLOCKING: 0');
  });

  it('the field UNWRAPPED (the ticket\'s suggested fix 2 shape) reads the same MERGE-SAFE · 0', () => {
    const plain = SPECIMEN.replace('`{"verdict":"MERGE-SAFE","blocking":0}`', '{"verdict":"MERGE-SAFE","blocking":0}');
    expect(extractRunVerdict(plain)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('CONTROL: with NO field, the resolved round history still mines 2 — only the machine count zeroes it', () => {
    // The prose statement tier is untouched: a lane with the same resolved
    // history and NO machine field keeps the narration-mined count (2 —
    // overcount is the safe direction). This pins that the fix reads the
    // FIELD, not a widened statement-tier discount.
    const noField = SPECIMEN.replace('`{"verdict":"MERGE-SAFE","blocking":0}`', '');
    expect(extractRunVerdict(noField)).toEqual({ verdict: 'MERGE-SAFE', blocking: 2 });
  });

  it('CONTROL: the field alone (no verdict heading, no round history) is not a verdict — MERGE-SAFE still requires the own-words read', () => {
    // The 3c354a95 contract: a masked-span field NEVER supplies a verdict.
    // A lane that only quotes the example in an inline-code span with no
    // verdict of its own keeps reading n/a (fail-open).
    expect(extractRunVerdict('emit `{"verdict":"MERGE-SAFE","blocking":0}` to stamp it')).toEqual({ verdict: 'n/a', blocking: 0 });
  });
});

describe('ticket 2f14eb79 — count-corroboration boundaries (fail-closed direction pins)', () => {
  it('an UNATTRIBUTED nonzero field count never overrides a prose count (overcount stays the safe direction; an ATTRIBUTED one does — machine contract)', () => {
    // The emitter states blocking:2 while the prose tiers mine 2 as well;
    // and a field stating 1 must not LOWER a 2 mined from labeled lines.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE","blocking":1}`\n- BLOCKING: A\n- BLOCKING: B').blocking).toBe(2);
  });

  it('REVIEW ROUND 2 (blocking finding 1, R1–R4): an UNATTRIBUTED field zero never zeroes the author\'s OWN explicit BLOCKING: n, verdict-tail count, or labeled findings — only the statement tier', () => {
    // R1: explicit BLOCKING: 2 line + a blockquoted foreign field zero.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nBLOCKING: 2\n> the prior lane wrote {"verdict":"MERGE-SAFE","blocking":0}').blocking).toBe(2);
    // R2: explicit BLOCKING: 2 + a fenced json schema example zero.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nBLOCKING: 2\n```\n{"verdict":"MERGE-SAFE","blocking":0}\n```').blocking).toBe(2);
    // R3: explicit BLOCKING: 2 with tail prose + inline-code doc example zero.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nBLOCKING: 2 — both LOW severity, tracked in follow-ups\na doc example `{"verdict":"MERGE-SAFE","blocking":0}`').blocking).toBe(2);
    // R4: backticked field zero + labeled finding lines.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE","blocking":0}`\n- BLOCKING: A\n- BLOCKING: B').blocking).toBe(2);
    // The verdict-line's own count tail is equally the author's own count.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE — 2 blocking findings\n`{"verdict":"MERGE-SAFE","blocking":0}`').blocking).toBe(2);
  });

  it('REVIEW ROUND 2 (optional hardening): RELAY shapes never corroborate — a blockquoted or table-row field zero stays foreign', () => {
    // The masker doctrine: blockquote/table-row spans are QUOTED/foreign
    // narration ("the prior lane wrote …"). Their field zeros never
    // corroborate a statement-tier count.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n> the prior lane wrote {"verdict":"MERGE-SAFE","blocking":0}\nThe two blocking findings from round 1 are fixed').blocking).toBe(2);
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n| prior | {"verdict":"MERGE-SAFE","blocking":0} |\nThe two blocking findings from round 1 are fixed').blocking).toBe(2);
    // The self-emission idioms stay corroborable: inline code (the ticket
    // specimen's idiom) and a fenced span (unlabeled code block, still the
    // author's own emission surface).
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE","blocking":0}`\nThe two blocking findings from round 1 are fixed').blocking).toBe(0);
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nThe two blocking findings from round 1 are fixed').blocking).toBe(0);
  });

  it('REVIEW ROUND 3 (blocking finding 1, E/F/K/M4/M5): a field zero — attributed OR not — never zeroes the author\'s OWN explicit BLOCKING: n or labeled-finding counts', () => {
    // E: bare-prose attributed field zero + explicit BLOCKING: 2 (the field
    // is narration of round 1; the live count is the explicit line).
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nBLOCKING: 2\nRound 1 emitted {"verdict":"MERGE-SAFE","blocking":0}; this round found two new blockers').blocking).toBe(2);
    // F: bare-prose field zero + labeled finding lines.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nEmit {"verdict":"MERGE-SAFE","blocking":0} at the end.\n- BLOCKING: A\n- BLOCKING: B').blocking).toBe(2);
    // K: an EARLY own-line field zero made stale by a later explicit count.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":0}\nBLOCKING: 2').blocking).toBe(2);
    // M4: early own-line zero + later explicit tail count.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":0}\nBLOCKING: 2 — found this round').blocking).toBe(2);
    // M5: early own-line zero + later labeled headings.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":0}\n### BLOCKING 1 — the first\n### BLOCKING 2 — the second').blocking).toBe(2);
  });

  it('REVIEW ROUND 3 (N1): a no-count field asserts nothing — it does not ERASE an earlier field\'s count', () => {
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":2}\n{"verdict":"MERGE-SAFE"}\nThe two blocking findings are tracked.\n`{"verdict":"MERGE-SAFE","blocking":0}`').blocking).toBe(2);
  });

  it('REVIEW ROUND 3 (N3): a pipe MID-line is the author\'s prose, not a table row — the field on that line still corroborates', () => {
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\nstatus a|b `{"verdict":"MERGE-SAFE","blocking":0}`\nThe two blocking findings from round 1 are fixed').blocking).toBe(0);
  });

  it('REVIEW ROUND 3 (control): the field still speaks when the prose tiers found NOTHING (a clean verdict)', () => {
    // No explicit line, no tail, no labeled lines, no statement narration —
    // the field is the only count voice (round-3: "blocking from
    // labeledCount 0 and no explicit line/tail").
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE","blocking":0}`\nEverything green.').blocking).toBe(0);
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":2}\nEverything else green.').blocking).toBe(2);
  });

  it('an ATTRIBUTED positive field\'s count stands whole and beats a LATER unattributed field (documentation-example precedence)', () => {
    // The live emitter's own line says 2 (attributed, machine contract); a
    // later documentation example quotes 0 in backticks. The emitter's count
    // stands — an unattributed field may only corroborate a ZERO, never
    // override a nonzero machine count.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":2}\nplus a doc example `{"verdict":"MERGE-SAFE","blocking":0}`').blocking).toBe(2);
    // Mirror: emitter 0 attributed, later doc example quotes 2 → the
    // unattributed nonzero must not raise the emitter's zero.
    expect(extractRunVerdict('## VERDICT: MERGE-SAFE\n{"verdict":"MERGE-SAFE","blocking":0}\nplus a doc example `{"verdict":"MERGE-SAFE","blocking":2}`').blocking).toBe(0);
  });

  it('a backticked zero corroborates the count when the prose has no count material at all', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE","blocking":0}`\nEverything green.').blocking).toBe(0);
  });

  it('a field with NO count key asserts nothing — the prose count stands', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n`{"verdict":"MERGE-SAFE"}`\nRound-1 blocking findings — both fixed.').blocking).toBe(1);
  });

  it('an UNATTRIBUTED nonzero field never raises the prose count (foreign text must not mint a false nonzero)', () => {
    // The ticket's own impact class: a documentation example quoting a
    // nonzero count on a clean verdict must not stamp that nonzero.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nEverything green, no findings.\nplus a doc example `{"verdict":"MERGE-SAFE","blocking":2}`').blocking).toBe(0);
  });

  it('the structured NEGATIVE contract is untouched: an ATTRIBUTED negative field wins outright with its own count; an unattributed one declines to n/a', () => {
    // b36a150e: an attributed (own-line) negative field beats even an explicit
    // positive VERDICT: line and carries its machine count.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n{"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // 3c354a95 (the B16 pin class): an UNATTRIBUTED (backticked) negative
    // field is documentation/foreign text — never a stamp, and it vetoes the
    // positive explicit line (decline to n/a, never MERGE-SAFE).
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n`{"verdict":"NOT-MERGE-SAFE","blocking":2}`')).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('an unattributed NEGATIVE field still declines a positive explicit line to n/a (3c354a95 F1)', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nthe round-1 field was `{"verdict":"NOT-MERGE-SAFE","blocking":2}` and both findings were fixed')).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('the b36a150e producer replays keep their readings: a live own-line field plus clean prose reads MERGE-SAFE', () => {
    expect(extractRunVerdict('Our fix is merge-safe.\n{"verdict":"MERGE-SAFE","blocking":0}')).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE","blocking":0}\nHowever, DO NOT MERGE — the isolation boundary leaks.').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 2f14eb79 — DETECTOR-RECALL REPLAY (prior true positives of the count tiers must still fire)', () => {
  // DETECTOR-RECALL REPLAY: this change touches the run-outcome extractor's
  // count path (platform/run-outcome-line.ts — the detector family this
  // ticket's lane is bound to). These rows replay the count tiers' PRIOR true
  // positives (the 11a35cfb/da70e157 convicting cases), asserting they STILL
  // fire with the corroboration rule in place.
  it('DETECTOR-RECALL REPLAY 1 — the explicit BLOCKING: n line still wins the count over a corroborated zero', () => {
    expect(extractRunVerdict('## VERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n`{"verdict":"MERGE-SAFE","blocking":0}`').blocking).toBe(2);
    // Negative verdict + explicit count: the negative field's own count wins.
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE\nBLOCKING: 2').blocking).toBe(2);
  });

  it('DETECTOR-RECALL REPLAY 2 — labeled finding lines still count (da70e157 heading shape)', () => {
    expect(extractRunVerdict('### BLOCKING 1 — the delivered value understates the risk\n### BLOCKING 2 — no regression test').blocking).toBe(2);
  });

  it('DETECTOR-RECALL REPLAY 3 — the verdict line\'s own "— n blocking findings" tail still counts (da70e157 ⑦)', () => {
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings')).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('DETECTOR-RECALL REPLAY 4 — the count statement tier still mines the last own-words count (11a35cfb second instance)', () => {
    expect(extractRunVerdict('## The two BLOCKING findings\n- BLOCKING: A\n- BLOCKING: B')).toEqual({ verdict: 'n/a', blocking: 2 });
  });
});
