/**
 * Ticket 11a35cfb — the run_completed digest FABRICATED "VERDICT: MERGE-SAFE ·
 * BLOCKING: 0" on a FIX lane whose final answer carried NO verdict at all.
 *
 * First-hand shape (read fresh this run, 2026-10-17T19:58Z, get_chat_messages
 * msg 4f2d6c12 of chat d3d82b39 — the c75b5f34 fix lane, run completed
 * 12:05:12Z): the lane's own text never issues a verdict — it says the PR is
 * deliberately held pending the in-flight adversarial review. The ONLY
 * merge-safe-shaped token anywhere in the answer is the QUOTED reviewer
 * sub-session TITLE, sitting in plain prose:
 *   title now "Adversarial review: isolation boundary diff · Merge-safety
 *   audit: prod-path" — the external wait is **genuinely still running**.
 * The occurrence ran on PRE-#1676 production code, where the whole-text
 * fallback's MERGE[-\s]SAFE alternation was UNBOUNDED and matched inside the
 * "Merge-safety" inside the quoted title. #1676 word-bounded that alternation
 * (so the exact instance re-reads n/a on current tip — pinned below), but the
 * CLASS is still live on tip in two flavors this ticket's survey measured:
 *   (a) a quoted span whose carried token is word-bounded-safe anyway —
 *       'title now "… VERDICT: MERGE-SAFE · all blockers fixed"' still reads
 *       MERGE-SAFE on tip (fabricated — the lane said it holds the PR), and
 *       'branch "fix-merge-safe-guard"' still reads MERGE-SAFE;
 *   (b) the same mechanism fabricating the NEGATIVE — a quoted ticket title
 *       '… "not merge-safe" …' reads NOT-MERGE-SAFE on tip.
 *
 * THE FIX (QUOTED-SPAN RULE in run-outcome-line.ts): a double-quoted span
 * names FOREIGN text (a reviewer title, a chat name, a branch name, a relayed
 * verdict) and is masked before every verdict/blocking regex runs — with ONE
 * carve-out preserving the pinned da70e157 relay idiom: a span the lane
 * explicitly ATTRIBUTES as a verdict (cue word "verdict" within 64 chars
 * before the opening quote, same line) still scans, because a lane relaying
 * the reviewer's CURRENT verdict in its own final answer is vouching for it.
 *
 * Mutation note: every primary assertion below goes red without the fix
 * (verified by the fixing lane — on unmodified tip the four fabrication
 * fixtures read MERGE-SAFE / MERGE-SAFE / MERGE-SAFE / NOT-MERGE-SAFE via the
 * whole-text fallback; the relay pin reads MERGE-SAFE on both, and that
 * contract is pinned here as a regression guard for THIS change).
 */

import { extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome } from './run-outcome-line';

/**
 * Near-verbatim excerpt of msg 4f2d6c12 — every verdict-relevant construct
 * preserved: the quoted reviewer TITLE in plain prose (the smoking gun), the
 * held-PR audit language, the inline-code tool quote, and the claims block.
 */
const REAL_FINAL = [
  'Self-audit complete. Reviewer re-probe (the one cheap check): `get_chat_status(464b87b3)` this turn returned `"running": true`, its own review plan at 3/7 completed, title now "Adversarial review: isolation boundary diff · Merge-safety audit: prod-path" — the external wait is **genuinely still running**. All three blocked steps stay blocked; their gating chain (verdict → fix findings → PR → merge → deploy verify → close) is intact.',
  '',
  '## Deliverable — isolation boundary for ticket c75b5f34: implemented, verified green, pushed; PR/ticket-close held for the in-flight adversarial review',
  '',
  '**The artifact** (commits `72f9b1d2` + `8af0da667` on `digby/session-d3d82b39`, pushed; 22 files, +791/−16):',
  '',
  '1. **`backend/src/modules/crossmodel/platform/instance-targets.ts`** — import-free leaf: `DIGBY_INSTANCE` identity, `IsolationBoundaryError`, resolver guards. 36 unit tests pin the ticket\'s verbatim ACCEPT.',
  '2. All five silent prod fallbacks removed and rewired to instance env.',
  '',
  '**Audit line:** criteria 1–4 verified by this-run receipts. Criteria 5–7 (review verdict, PR landed + deploy green + E2E, ticket close + supervisor report) are **not done** — blocked on reviewer 464b87b3, confirmed still running this turn; PR deliberately not opened, ticket c75b5f34 remains `in_progress`, no merge/deploy/close claims made.',
  '',
  '```claims',
  '[{"ref": "72f9b1d2", "scope": "this_run", "type": "commit", "note": "Isolation boundary implementation"}',
  ']```',
].join('\n');

describe('ticket 11a35cfb replay — a fix-lane final with NO verdict reads n/a, never a fabricated one', () => {
  it('counterfactual pin: the fixture\'s only merge-safe-shaped token is the QUOTED reviewer title', () => {
    expect(REAL_FINAL).toContain('"Adversarial review: isolation boundary diff · Merge-safety audit: prod-path"');
    // …and the answer issues no verdict of its own: no VERDICT: status line…
    expect(REAL_FINAL.split('\n').some((l) => /^[>\s*•\-–#]*VERDICT:/i.test(l))).toBe(false);
    // …and the only MERGE-SAFE-family word is inside the quoted title.
    const markerLines = REAL_FINAL.split('\n').filter((l) => /MERGE[-\s]?SAFE/i.test(l));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain('"Adversarial review');
  });

  it('the replayed occurrence extracts n/a · 0 — the lane issued no verdict, so the digest carries none', () => {
    expect(extractRunVerdict(REAL_FINAL)).toEqual({ verdict: 'n/a', blocking: 0 });
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: REAL_FINAL }))
      .toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });

  it('the front-loaded digest the supervisor would have received opens with n/a, not a fabricated verdict', () => {
    const summary = frontLoadRunOutcome('Coding run completed. Final answer: Self-audit complete…', {
      outcome: 'completed', finalText: REAL_FINAL,
    });
    expect(summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });
});

describe('ticket 11a35cfb — the class survey (each fabricated MERGE-SAFE on pre-fix tip, pinned n/a now)', () => {
  it('a quoted span carrying a word-bounded-safe positive token still cannot fabricate MERGE-SAFE', () => {
    // On tip (pre-fix) this read MERGE-SAFE: the quoted title carries an
    // explicit "VERDICT: MERGE-SAFE" that the whole-text fallback hoisted.
    const t = 'Reviewer update: title now "Adversarial review — VERDICT: MERGE-SAFE · all blockers fixed". The lane itself holds the PR pending review.';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('a quoted span carrying the dimension word ("merge-safe audit") stays n/a', () => {
    const t = 'Reviewer re-probe: title now "MERGE-SAFE audit — prod-path". The lane holds the PR pending review.';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('a quoted chat/branch NAME carrying the token stays n/a (no real verdict either way)', () => {
    expect(extractRunVerdict('Pushed branch "fix-merge-safe-guard" with both fixes; PR held.').verdict).toBe('n/a');
    expect(extractRunVerdict('A new chat "merge-safe round 2" was spawned for the re-review; verdict pending.').verdict).toBe('n/a');
  });

  it('the mask is DIRECTION-AGNOSTIC: a quoted span fabricating NOT-MERGE-SAFE is also blocked', () => {
    // Pre-fix tip read NOT-MERGE-SAFE here — a quoted ticket title, not the
    // lane's verdict. n/a is the safe truth: the lane issued no verdict.
    const t = 'the ticket title says "not merge-safe" but the lane is a fix lane holding its PR.';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('an unmatched opening quote masks to end of line (fail-closed — a dangling foreign fragment survives nothing)', () => {
    const t = 'title now "MERGE-SAFE audit — prod-path; the lane holds its PR.';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('the lane\'s OWN explicit verdict beats every quoted span in the same answer', () => {
    const t = 'Reviewer title was "VERDICT: MERGE-SAFE everywhere".\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 1\n';
    expect(extractRunVerdict(t)).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
  });
});

describe('ticket 11a35cfb — the relay carve-out (da70e157 build-lane contract preserved)', () => {
  it('a span the lane ATTRIBUTES as a verdict ("Final verdict …: …") still scans — the pinned relay idiom', () => {
    const t = '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.';
    expect(extractRunVerdict(t).verdict).toBe('MERGE-SAFE');
  });

  it('the relay carve-out preserves da70e157\'s fail-open for a relayed BLOCK: n/a, never MERGE-SAFE', () => {
    // Same shape as the pinned QUOTED_BLOCK_VARIANT (da70e157): BLOCK-family
    // words are whole-text-absent BY DESIGN (prose uses them positively about
    // fixes — "the fix blocks the leak"), so a relayed BLOCK declines to
    // assert rather than fabricating either direction. n/a is the documented
    // safe fail-open; the wake's harvest instruction stays authoritative.
    const t = '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: BLOCK — 2 blocking findings"**';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('the attribution cue must be NEAR the quote: a "verdict" word on an earlier sentence does not attribute a later title', () => {
    const t = 'The final verdict is still pending from the reviewer. Meanwhile the title now reads "MERGE-SAFE audit round 2".';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('a colon after "verdict" that introduces a TITLE, not the quote, still masks (handover punctuation, not word proximity)', () => {
    // The survey shape: the colon introduces "title now", and non-quote
    // text sits between it and the opening quote — no handover, mask holds.
    const t = 'the reviewer verdict came in: title now "MERGE-SAFE audit round 2".';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
  });

  it('typographic quotes (“”) are masked the same as straight ones, both directions', () => {
    expect(extractRunVerdict('title now “MERGE-SAFE audit” — the lane holds its PR.').verdict).toBe('n/a');
    // …and the relay idiom with typographic quotes still scans.
    expect(extractRunVerdict('Final verdict: “SAFE TO MERGE” — all fixed and re-verified.').verdict).toBe('MERGE-SAFE');
  });

  it('a line that is ONLY a quoted verdict (no attribution) declines to assert — n/a, both directions', () => {
    // Pre-fix the whole-text fallback hoisted these; with no lane-authored
    // frame the extractor cannot attribute the span, so it declines.
    expect(extractRunVerdict('"VERDICT: MERGE-SAFE"').verdict).toBe('n/a');
    expect(extractRunVerdict('"VERDICT: NOT-MERGE-SAFE"').verdict).toBe('n/a');
  });
});

describe('ticket 11a35cfb — SECOND live instance (chat 84887561, msg 51917e21, 20:27Z): the count half of the stamp', () => {
  /**
   * A supervisor delivered a fresh same-class instance WHILE the fix was in
   * review: an adversarial-review lane's digest stamped "VERDICT:
   * NOT-MERGE-SAFE · BLOCKING: 0" over a final carrying TWO real blocking
   * findings and ending "VERDICT: BLOCK — the two-probe contract is
   * structurally defeated…". The verdict half parsed correctly; the COUNT
   * read 0 because the reviewer names the count in a SECTION HEADING —
   * "## The two BLOCKING findings (both survived my own re-derivation…)" —
   * and every pre-fix count tier missed it (no BLOCKING: n line; the
   * verdict line's tail names no count; the finding lines carry no BLOCKING
   * label). New fourth tier: a deliberate count statement in the lane's own
   * words, last-wins, ≥ the labeled-line count.
   */
  const SECOND_INSTANCE = [
    'Adversarial review complete — final deliverable is the verdict, delivered to the requesting lane in two parts:',
    '',
    '- **First verdict (SAFE)** — receipt `765e27f6`',
    '- **Corrected verdict addendum (BLOCK)** — receipt `ac178915`, both steered into chat `d6eacd5d`\'s active run. The addendum supersedes the severity gradings; the claims table and A-G evidence stand.',
    '',
    '## Claims 1-8',
    '',
    '1-3, 5-7 **CONFIRMED**; 4 **REFUTED in part** (gate correct in isolation; the "second consecutive drain" guarantee false for multi-ticket sessions); 8 **REFUTED on the count only**.',
    '',
    '## The two BLOCKING findings (both survived my own re-derivation with fresh probes)',
    '',
    '1. **Per-row consumption of a per-session stamp** — confirmedAbsentTwice is called per ROW against a session-keyed stamp.',
    '2. **Branch no longer merges into main** — git merge-tree exit 1, content conflict.',
    '',
    'Plus one MAJOR, and the ledger-date minors.',
    '',
    '**VERDICT: BLOCK — the two-probe contract is structurally defeated for multi-ticket sessions and the branch conflicts with main\'s #1685 in the very block it edits; both must be fixed before merge.**',
  ].join('\n');

  it('counterfactual pin: the count statement is a heading with no labeled finding lines and no BLOCKING: n line', () => {
    expect(SECOND_INSTANCE).toContain('## The two BLOCKING findings');
    // No explicit count line, no BLOCKING-labeled finding lines, no count on
    // the verdict line's own tail — every pre-fix tier absent by construction.
    expect(SECOND_INSTANCE.split('\n').some((l) => /BLOCKING(?:\s+FINDINGS)?\s*:\s*\d/i.test(l))).toBe(false);
    expect(SECOND_INSTANCE.split('\n').some((l) => /^[>\s*•\-–#]*(?:\d+[.)]\s*)?(?:\*\*)?BLOCKING(?!\s+FINDINGS)\b/.test(l))).toBe(false);
    expect((SECOND_INSTANCE.match(/VERDICT:[^\n]*/g) ?? []).join(' ')).not.toMatch(/\b\d+\s+blocking\b/i);
  });

  it('the replayed second instance extracts NOT-MERGE-SAFE · 2 — the count now rides the digest', () => {
    expect(extractRunVerdict(SECOND_INSTANCE)).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: SECOND_INSTANCE }))
      .toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
  });

  it('the count statement is LAST-WINS and only consulted below the verdict-line tail tier', () => {
    // The verdict line's own tail still beats a loose statement.
    expect(extractRunVerdict('## The two BLOCKING findings\n\n## **VERDICT: BLOCK** — 3 blocking findings\n').blocking).toBe(3);
    // The LAST deliberate statement wins (recency, same principle as the last
    // VERDICT: line) — and agrees-or-exceeds the labeled lines.
    const t = 'The two BLOCKING findings stood at round 1.\n\nRound 3 re-derivation: the three blocking findings all survive.\n';
    expect(extractRunVerdict(t).blocking).toBe(3);
  });

  it('a count inside a RELAYED verdict span never hoists (da70e157 QUOTED_BLOCK_VARIANT contract)', () => {
    // The relay carve-out keeps the span for the VERDICT tier, but the count
    // tiers read the no-relay view — a reviewer's quoted count is foreign.
    const t = '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: BLOCK — 2 blocking findings"**';
    expect(extractRunVerdict(t)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('a count inside a quoted TITLE never hoists (first-instance class, count direction)', () => {
    expect(extractRunVerdict('title now "2 blocking findings pending" — the lane holds its PR.').blocking).toBe(0);
  });

  it('F1 (adversarial review): a verdict cue+colon does not rescue a FOREIGN span — the span itself must be verdict-shaped', () => {
    // The reviewer's four exact repros — each fabricated MERGE-SAFE pre-F1
    // (cue+colon admitted any span; the kept "merge-safe" substring fed the
    // whole-text fallback). The span must now carry an explicit VERDICT:
    // token or be exactly a verdict value phrase.
    expect(extractRunVerdict('No verdict yet from the reviewer; its title now reads: "MERGE-SAFE audit round 2". The lane holds its PR.').verdict).toBe('n/a');
    expect(extractRunVerdict('Final verdict: "fix-merge-safe-guard"').verdict).toBe('n/a');
    expect(extractRunVerdict('Waiting on verdict from chat: "merge-safe round 2" before anything lands.').verdict).toBe('n/a');
    expect(extractRunVerdict('Checking the verdict digest: "MERGE-SAFE round 2" was the title of the review; the lane holds its PR.').verdict).toBe('n/a');
  });

  it('F1 guard: the pinned relay idioms are STILL verdict-shaped and keep scanning', () => {
    // Explicit VERDICT: token inside the span (the da70e157 idiom)…
    expect(extractRunVerdict('- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified.').verdict).toBe('MERGE-SAFE');
    // …and a bare verdict-value span (no VERDICT: token) behind the cue.
    expect(extractRunVerdict('Final verdict: "SAFE TO MERGE" — all fixed and re-verified.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "NOT-MERGE-SAFE" — C2 regressed.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3 (adversarial review): a hyphenated compound is not a count statement ("2 blocking-style advisories")', () => {
    expect(extractRunVerdict('There were 2 blocking-style advisories, none real blockers.').blocking).toBe(0);
    // …while the real count statement still counts.
    expect(extractRunVerdict('There were 2 blocking findings, both real.').blocking).toBe(2);
  });

  it('"blockers"/"findings" without the word "blocking" is NOT a count statement (no false counts)', () => {
    expect(extractRunVerdict('Two blockers remain, both confirmed.\nVERDICT: BLOCK\n').blocking).toBe(0);
    expect(extractRunVerdict('## Findings\nTwo findings, both advisory.\n').blocking).toBe(0);
  });

  it('own-prose history with a stale early count does not undercount later labeled findings', () => {
    // The statement agrees-or-exceeds the labeled lines: max(1, 2) = 2.
    const t = 'Round 1 named one blocking finding.\n- BLOCKING: A — regression\n- BLOCKING: B — unverified\n';
    expect(extractRunVerdict(t).blocking).toBe(2);
  });

  it('apostrophes (single quotes) are never openers — "don\'t"/"won\'t" prose keeps scanning', () => {
    const t = "The reviewer said it isn't MERGE-SAFE until C2 is re-run.";
    expect(extractRunVerdict(t).verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 11a35cfb — prior contracts preserved (54af5c27 / da70e157 / bf30c5d9 pins re-run here)', () => {
  it('54af5c27: table/blockquote/fence/inline-code quoting still masks', () => {
    expect(extractRunVerdict('| history | verdict: NOT-MERGE-SAFE-as-described |').verdict).toBe('n/a');
    expect(extractRunVerdict('> VERDICT: NOT-MERGE-SAFE\nOwn re-probe: all hold.').verdict).toBe('n/a');
    expect(extractRunVerdict('```\nVERDICT: NOT-MERGE-SAFE\n```').verdict).toBe('n/a');
    expect(extractRunVerdict('The parent wake read `VERDICT: NOT-MERGE-SAFE` in its header.').verdict).toBe('n/a');
  });

  it('da70e157: heading BLOCK verdicts still read NOT-MERGE-SAFE with their counts', () => {
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings, 9 advisory\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings, 9 advisory\n').blocking).toBe(2);
  });

  it('bf30c5d9: own-prose fallback markers still scan; the LAST own VERDICT: line wins', () => {
    expect(extractRunVerdict('All eight claims hold — safe to merge.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('If C5 regressed this would be NOT-MERGE-SAFE; otherwise MERGE-SAFE.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Draft said VERDICT: MERGE-SAFE earlier.\n…revised…\nVERDICT: NOT-MERGE-SAFE\n').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('a verdict inside DOUBLE QUOTES on its own explicit line shape is foreign text, not a status line', () => {
    // The line-anchored explicit lane never matched quoted VERDICT: tokens
    // (they sit mid-line); the QUOTED-SPAN mask now closes the fallback hole.
    expect(extractRunVerdict('Reviewer update: title now "Adversarial review — VERDICT: MERGE-SAFE".').verdict).toBe('n/a');
  });
});

describe('ticket 11a35cfb — adversarial review ROUND 2 (BLOCK findings B1/B2/B3 + F4/F3, pinned verbatim)', () => {
  // The reviewer's amended verdict (21:16Z, post-merge of round 1) found three
  // blocking defects its first battery missed. Every repro below is the
  // reviewer's exact input; every expected value is the SAFE direction (n/a
  // decline or NOT-MERGE-SAFE — never a fabricated MERGE-SAFE).

  it('B1: a quoted reviewer NEGATIVE vetoes the lane\'s own positive PROSE fallback (no NOT-MERGE-SAFE→MERGE-SAFE flip)', () => {
    // 4baa7c3e round-2 adjudication (2026-10-18): this line's own-words half
    // carries a live CONDITIONAL ("merge-safe; the re-probe is pending"), which
    // the round-2 free window now correctly reads as NOT-MERGE-SAFE (the
    // c90958af F3 doctrine: a conditional positive literally means "not safe
    // yet"). Both n/a (the old B1 decline) and NOT-MERGE-SAFE are safe-direction
    // values per this block's header; MERGE-SAFE — the flip the pin guards
    // against — remains impossible. The other three repros keep the n/a decline
    // (their own-words halves carry no conditional).
    expect(extractRunVerdict('Reviewer wrote: "DO NOT MERGE — the isolation boundary leaks". Our fix is merge-safe; the re-probe is pending.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Reviewer: "cannot ship". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "NOT-MERGE-SAFE". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict("Reviewer wrote: \"it isn't merge-safe yet\". This patch is safe to merge.").verdict).toBe('n/a');
    // Controls: each half alone keeps its own meaning.
    expect(extractRunVerdict('Reviewer wrote: "DO NOT MERGE — the isolation boundary leaks".').verdict).toBe('n/a');
    expect(extractRunVerdict('This patch is safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('B1 guard: the veto does not touch the lane\'s OWN explicit verdict line (54af5c27 contract preserved)', () => {
    // The pinned 54af5c27 shape: a quoted historical negative must NOT
    // override the lane's own explicit MERGE-SAFE verdict line.
    const t = '| history | the e8ed45c3 verdict: NOT-MERGE-SAFE-as-described |\n\nAll blockers cured by the rebase.\nVERDICT: MERGE-SAFE\n';
    expect(extractRunVerdict(t).verdict).toBe('MERGE-SAFE');
  });

  it('B2: a RELAYED negative imperative still reads NOT-MERGE-SAFE (f5bdeaf3 O1 contract restored at the relay shape)', () => {
    expect(extractRunVerdict('Final verdict: "DO NOT MERGE — the isolation boundary leaks". Our fix is merge-safe.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "cannot ship" per the reviewer.').verdict).toBe('NOT-MERGE-SAFE');
    // …and the whole relay family, both directions.
    expect(extractRunVerdict('Final verdict: "NOT-MERGE-SAFE" — C2 regressed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "UNSAFE TO MERGE" until C2 re-runs.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('B3: a foreign span that merely CONTAINS a VERDICT token never relays — the token must start a verdict line', () => {
    expect(extractRunVerdict('Reviewer verdict pending. Title now: "Adversarial review — VERDICT: MERGE-SAFE · all blockers fixed". The lane holds its PR.').verdict).toBe('n/a');
    expect(extractRunVerdict('Final verdict: "fix for VERDICT: MERGE-SAFE regression" branch pushed.').verdict).toBe('n/a');
    // …while a span that IS a verdict line still relays.
    expect(extractRunVerdict('- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — re-verified.').verdict).toBe('MERGE-SAFE');
  });

  it('F4: a quoted span wrapping across LINES stays masked on the continuation line', () => {
    const t = 'Reviewer title now "Adversarial review: isolation boundary diff ·\nMerge-safe audit: prod-path" — the lane holds its PR.';
    expect(extractRunVerdict(t).verdict).toBe('n/a');
    // …and the closer ends the carried state: own lines after it scan again.
    const t2 = 'Reviewer title now "Adversarial review: isolation boundary diff ·\nMerge-safe audit: prod-path" — the lane holds its PR.\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 1\n';
    expect(extractRunVerdict(t2)).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
  });

  it('F3: a BALANCED single-quoted foreign title is masked (guarded — apostrophes in contractions/possessives never open)', () => {
    expect(extractRunVerdict("the reviewer title reads 'Merge-safe audit: prod-path' and the lane holds its PR.").verdict).toBe('n/a');
    // Contraction/possessive guards: these still scan as own prose.
    expect(extractRunVerdict("The reviewer said it isn't MERGE-SAFE until C2 is re-run.").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict("The reviewers' report won't ship; it says C2's fix isn't verified. The lane holds its PR.").verdict).toBe('NOT-MERGE-SAFE');
    // A single-quoted VERDICT never relays (the pinned idiom is double-quoted):
    expect(extractRunVerdict("Final verdict: 'SAFE TO MERGE' — all fixed.").verdict).toBe('n/a');
  });
});

describe('ticket 11a35cfb — adversarial review ROUND 3 (R2-1 relay tails + R2-2 carry flip + P1 veto vocabulary)', () => {
  // The round-2 re-review (28c54be3, 21:49Z + 21:5xZ addendum) found the
  // em-dash tail re-opening the ticket's class (9 repros, parent n/a → head
  // MERGE-SAFE) and the never-closed carry flipping a real NOT-MERGE-SAFE
  // (with BLOCKING: 3) to MERGE-SAFE/0 over an inch mark. Every repro below
  // is the reviewer's exact input; expected values are the safe direction.

  it('R2-1: a POSITIVE value relays only BARE — any tail is foreign/conditional and masks', () => {
    const tailed = [
      'Final verdict: "SAFE TO MERGE — says the title of the review" (the lane holds its PR).',
      'Reviewer verdict pending. Title now: "SAFE TO MERGE — the review title, not a verdict". The lane holds its PR.',
      'Final verdict: "MERGE-SAFE — every claim re-verified by the reviewer\'s own probes this run".',
      'Final verdict: "SAFE TO MERGE — after the deploy probe goes green" per the reviewer.',
      'Final verdict: "SAFE TO MERGE - pending CI green".',
      'Final verdict: "SAFE TO MERGE — the reviewer re-ran all four probe rounds and each one held, see the table above".',
      'Final verdict: "SAFE TO MERGE — NOT: the seam still leaks" per the reviewer.',
      'Final verdict: "MERGE-SAFE — 2 blocking findings remain".',
    ];
    for (const t of tailed) expect(extractRunVerdict(t).verdict).toBe('n/a');
    // …and the producer stamp over the same shape declines too (R7, end-to-end).
    const s = frontLoadRunOutcome('Coding run completed. Final answer: …', { outcome: 'completed', finalText: tailed[0] });
    expect(s.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });

  it('R2-1 guard: BARE positive relay pins still scan MERGE-SAFE', () => {
    expect(extractRunVerdict('- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "SAFE TO MERGE" — all fixed and re-verified.').verdict).toBe('MERGE-SAFE');
  });

  it('R2-1 guard: NEGATIVE values still relay WITH arbitrary tails (NEGATIVE wins the fallback tie)', () => {
    expect(extractRunVerdict('Final verdict: "DO NOT MERGE — the isolation boundary leaks". Our fix is merge-safe.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict("Final verdict: \"won't ship until C2 is re-run\".").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "cannot ship" per the reviewer.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "UNSAFE TO MERGE" until C2 re-runs.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('R2-2: a NEVER-CLOSED carry no longer erases the lane\'s own verdict block (inch-mark repro)', () => {
    expect(extractRunVerdict('All blockers are fixed; the patch is safe to merge.\nWe measured 0.5" of drift in the harness.\n\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 3 });
    expect(extractRunVerdict('Our re-probe is green and the patch is safe to merge.\nReviewer title was "round 2.\n\n## The two BLOCKING findings\n\n1. Per-row consumption.\n2. Branch no longer merges.\n\nVERDICT: BLOCK — structurally defeated.'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // The carry ends at a blank line: an own verdict after the break keeps its voice.
    expect(extractRunVerdict('The reviewer wrote "broken on two counts.\n\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // A fence opened inside the carry: the fenced verdict stays masked (safe n/a).
    expect(extractRunVerdict('"see below:\n\n```\nVERDICT: NOT-MERGE-SAFE\n```\n').verdict).toBe('n/a');
  });

  it('R2-2 control: a carry that CLOSES before the verdict block changes nothing', () => {
    expect(extractRunVerdict('The reviewer said "not this one" earlier.\n\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 3 });
  });

  it('P1 (veto vocabulary): BLOCK/REJECTED/NO-GO/HOLD-MERGE shapes in a quoted span veto the own-positive fallback', () => {
    expect(extractRunVerdict('Reviewer wrote: "BLOCK — 2 blocking findings stand". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "REJECTED". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "NO-GO on the merge". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "hold the merge until C2 re-runs". This patch is safe to merge.').verdict).toBe('n/a');
    // Guard: BLOCK as ordinary prose ("this code block is fine") does NOT veto.
    expect(extractRunVerdict('The reviewer said "this code block is fine". This patch is safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('P2: a relayed bare BLOCK never reads MERGE-SAFE (fail-open n/a; never relays)', () => {
    expect(extractRunVerdict('Final verdict: "BLOCK — 2 blocking findings"').verdict).toBe('n/a');
  });
});

describe('ticket 11a35cfb — THIRD live instance (chat ea0285f6, msg 724d694d, 22:29Z): a conditional verdict with an operative negative tail', () => {
  // A supervisor captured this repro live at 22:29Z: reviewer chat ea0285f6's
  // run_completed digest read "VERDICT: NOT-MERGE-SAFE · BLOCKING: 0" over a
  // final whose ground-truth verdict line is "Verdict: MERGE-SAFE —
  // conditional on the standard switch-ledger re-stitch. NOT ff-mergeable as
  // pushed." ADJUDICATION: NOT-MERGE-SAFE is the CORRECT (fail-closed)
  // reading — the verdict is CONDITIONAL and its operative tail is a
  // negative ("NOT ff-mergeable as pushed"); by the module's bias rule a
  // conditional positive with an unmet condition must never bless a branch
  // as unconditionally merge-safe. This pins the adjudication so the
  // extractor keeps reading this shape negative.
  it('the conditional-positive-with-negative-tail line reads NOT-MERGE-SAFE (fail-closed adjudication)', () => {
    expect(extractRunVerdict('Verdict: MERGE-SAFE — conditional on the standard switch-ledger re-stitch. NOT ff-mergeable as pushed.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('a conditional positive fails closed to NOT-MERGE-SAFE, never blesses (extends the once/if/when doctrine)', () => {
    // Pre-existing gap closed by the third instance: the conditional list
    // knew once/if/when/after/provided/assuming/pending but not the word
    // "conditional", and its connector did not span an em-dash — so
    // 'VERDICT: MERGE-SAFE — conditional on the re-stitch.' blessed while
    // 'VERDICT: MERGE-SAFE once CI is green.' read negative. Both shapes now
    // fail closed, like every conditional in the vocabulary.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — conditional on the re-stitch.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE conditional on CI green.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — once CI is green.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE once CI is green.').verdict).toBe('NOT-MERGE-SAFE');
    // Guard: an UNCONDITIONAL positive keeps its voice.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — every claim re-verified this run.').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 11a35cfb — adversarial review ROUND 3 ADDENDUM (F1 trailing-newline flip + F2 fence reset + F3 veto vocabulary)', () => {
  // The cross-family review (deepseek-flash) found the R2-2 veto defeated by
  // ANY trailing newline; the reviewer reproduced it first-hand and upgraded
  // its round-3 verdict to BLOCK. Every repro below is the reviewer's exact
  // input (22:51Z addendum); expected values are the safe direction.

  it('F1: a trailing newline or later blank line cannot resurrect a positive over an erased verdict', () => {
    // The R2-2.a inch-mark shape, WITH the trailing "\n" that defeated the
    // transient veto (the empty final element reset carryOpen, the earlier
    // own-positive then won the fallback → MERGE-SAFE/0 at e33fa8d36).
    expect(extractRunVerdict('All blockers are fixed; the patch is safe to merge.\nWe measured 0.5" of drift in the harness.\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n').verdict).toBe('n/a');
    // A blank line + prose AFTER the erased block — same resurrection.
    expect(extractRunVerdict('All blockers are fixed; the patch is safe to merge.\nWe measured 0.5" of drift in the harness.\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n\nDone.').verdict).toBe('n/a');
    // No trailing newline — the original pinned shape (veto always fired).
    expect(extractRunVerdict('All blockers are fixed; the patch is safe to merge.\nWe measured 0.5" of drift in the harness.\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3').verdict).toBe('n/a');
  });

  it('F2: a fence OPEN genuinely ends the carried span — the verdict after the fence keeps its voice', () => {
    expect(extractRunVerdict('He said "see below:\n```\ncode\n```\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('F3: BLOCKED / FAILED / REFUSED / VETOED shapes in a quoted span veto the own-positive fallback', () => {
    expect(extractRunVerdict('Reviewer wrote: "BLOCKED — the seam inverts". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "FAILED — the gate bypassed". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "REFUSED — C2 unverified". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "VETOED by the owner". This patch is safe to merge.').verdict).toBe('n/a');
    // Guard: FAIL-family as ordinary quoted prose ("the CI job failed
    // twice") does NOT veto — FAILED requires the verdict shape (terminal
    // punctuation or a dash tail), the CI-prose form has a continuing tail.
    expect(extractRunVerdict('The reviewer said "the CI job failed twice" but the patch is safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('F1 guard: the pinned R2-2 shapes (blank line BEFORE the verdict) still read their verdicts with counts', () => {
    expect(extractRunVerdict('Our re-probe is green and the patch is safe to merge.\nReviewer title was "round 2.\n\n## The two BLOCKING findings\n\n1. Per-row consumption.\n2. Branch no longer merges.\n\nVERDICT: BLOCK — structurally defeated.'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('The reviewer wrote "broken on two counts.\n\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });
});

describe('ticket 11a35cfb — round-4 addendum B1 (R4-B1: the veto rewrite dropped REJECT/REJECTS)', () => {
  // The round-5 rewrite of QUOTED_NEGATIVE_VETO_RE replaced the round-3 arm
  // \bREJECT(?:ED|S)?\b with \bREJECTED?\b — which matches only
  // REJECTE/REJECTED and silently lost bare REJECT and REJECTS. A quoted
  // reviewer negative then blessed a merge (the ticket's original class,
  // reintroduced by the fix itself; found by the cross-family review,
  // reproduced first-hand by the reviewer at head vs e33fa8d36/0876d5e37).
  // The family is restored (with stem alignment: REFUS(E|ES|ED),
  // VETO(ES|ED)); every repro below is the reviewer's exact input.

  it('every REJECT-family shape vetoes the own-positive fallback (restored family)', () => {
    expect(extractRunVerdict('Reviewer wrote: "REJECT". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('The reviewer said "the owner rejects this branch". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict("The reviewer said 'the owner rejects the merge' and this patch is safe to merge.").verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "REJECT — C2 unverified". This patch is safe to merge.').verdict).toBe('n/a');
    // The pre-existing control arm still works.
    expect(extractRunVerdict('Reviewer wrote: "REJECTED". This patch is safe to merge.').verdict).toBe('n/a');
  });

  it('end-to-end: the producer stamp declines over a quoted REJECT (never MERGE-SAFE)', () => {
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: 'Reviewer wrote: "REJECT". This patch is safe to merge.' }))
      .toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });

  it('full veto vocabulary sweep — every arm fires, none dropped (the lesson from R4-B1)', () => {
    // One probe per arm of QUOTED_NEGATIVE_VETO_RE so a future rewrite that
    // drops an arm goes red here, not in production.
    const arms = ['REJECT', 'REJECTS', 'REJECTED', 'REFUSE', 'REFUSED', 'REFUSES', 'VETO', 'VETOED', 'VETOES', 'BLOCK', 'BLOCKED', 'NO-GO', 'NO GO', 'DO NOT MERGE'];
    for (const w of arms) {
      expect(extractRunVerdict(`Reviewer wrote: "${w} — C2 unverified". This patch is safe to merge.`).verdict).toBe('n/a');
    }
    // FAIL-family verdict shape + HOLD-MERGE phrase.
    expect(extractRunVerdict('Reviewer wrote: "FAILED — the gate bypassed". This patch is safe to merge.').verdict).toBe('n/a');
    expect(extractRunVerdict('Reviewer wrote: "hold the merge until C2 re-runs". This patch is safe to merge.').verdict).toBe('n/a');
  });
});

describe('extractRunVerdict — historical verdict attribution (c90958af / cf2601d5)', () => {
  it('does not stamp NOT-MERGE-SAFE when a past review verdict is only cited', () => {
    expect(extractRunVerdict(
      'The review verdict (DO NOT MERGE, 3 blockers) is in the transcript from yesterday.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review of the first cut returned NOT-MERGE-SAFE on three findings; every finding was fixed.',
    ).verdict).toBe('n/a');
  });

  it('still vetoes a live quoted or explicit negative, including one after a historical citation', () => {
    expect(extractRunVerdict('Final verdict: "DO NOT MERGE"').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: DO NOT MERGE').verdict).toBe('NOT-MERGE-SAFE');
    // B1: own positive + a live quoted negative declines to n/a, never MERGE-SAFE.
    expect(extractRunVerdict(
      'Reviewer wrote: "DO NOT MERGE". This patch is safe to merge.',
    ).verdict).toBe('n/a');
    // da70e157: an explicit VERDICT line stays fail-closed.
    expect(extractRunVerdict(
      'VERDICT: MERGE-SAFE — the earlier NOT-MERGE-SAFE concern is fixed',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // A later sentence that is itself a live veto is not swallowed with the citation.
    expect(extractRunVerdict(
      'Adversarial review of the first cut returned NOT-MERGE-SAFE on three findings; every finding was fixed. The current cut is DO NOT MERGE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // returned + negative with no resolution cue is a live relay.
    expect(extractRunVerdict(
      'Adversarial review returned NOT-MERGE-SAFE on three findings.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('stamps the parenthetical citation as n/a on the outcome line', () => {
    const line = buildRunOutcomeLine({
      outcome: 'completed',
      finalText: 'The review verdict (DO NOT MERGE, 3 blockers) is in the transcript from yesterday.',
    });
    expect(line).toContain('VERDICT: n/a');
    expect(line).toContain('BLOCKING: 0');
  });
});
