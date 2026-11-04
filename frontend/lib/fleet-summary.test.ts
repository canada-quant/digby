import { describe, it, expect } from 'vitest';
import { parseSupervisorWakeNote, classifyWakeHeadline, cleanWakeLabel } from './fleet-summary';

describe('parseSupervisorWakeNote (dashboard Fleet-summary card, platform task 2026-09-03)', () => {
  it('extracts the headline (markdown stripped) + status chips from a real wake-note shape', () => {
    const note = [
      '**Fleet wake — 2 lane completions, both no-ops**',
      '',
      '- **cec340f2** probe lane: green, next tick 04:52Z',
      '- **b92ef13f** nightly: 8/8, PR merged',
      '1. queue: 3 in_progress',
      '',
      'Trailing prose the chips must skip.',
    ].join('\n');
    const r = parseSupervisorWakeNote(note);
    expect(r.headline).toBe('Fleet wake — 2 lane completions, both no-ops');
    expect(r.chips).toEqual([
      'cec340f2 probe lane: green, next tick 04:52Z',
      'b92ef13f nightly: 8/8, PR merged',
      'queue: 3 in_progress',
    ]);
    expect(r.body).toContain('Trailing prose');
  });

  it('skips bracketed chrome headers when picking the headline', () => {
    const r = parseSupervisorWakeNote('[SUPERVISOR STATE]\n\nActual summary line\n- chip one');
    expect(r.headline).toBe('Actual summary line');
    expect(r.chips).toEqual(['chip one']);
  });

  it('caps the headline at 90 chars and chips at 4 entries', () => {
    const long = 'x'.repeat(120);
    const chips = Array.from({ length: 8 }, (_, i) => `- chip ${i}`).join('\n');
    const r = parseSupervisorWakeNote(`${long}\n${chips}`);
    expect(r.headline).toHaveLength(90);
    expect(r.chips).toHaveLength(4);
  });

  it('handles an empty / whitespace-only note without fabricating anything', () => {
    expect(parseSupervisorWakeNote('')).toEqual({ headline: '', chips: [], body: '' });
    expect(parseSupervisorWakeNote('\n\n  \n').headline).toBe('');
  });

  it('a heading-only note produces no chips and an empty body', () => {
    const r = parseSupervisorWakeNote('## Fleet wake — quiet hour');
    expect(r.headline).toBe('Fleet wake — quiet hour');
    expect(r.chips).toEqual([]);
    expect(r.body).toBe('');
  });
});

describe('classifyWakeHeadline (semantic wake-row tinting, owner polish pass 2026-09-03)', () => {
  it("'quiet' — nothing-happened phrasings dim", () => {
    expect(classifyWakeHeadline('Fleet sweep — all lanes idle')).toBe('quiet');
    expect(classifyWakeHeadline('No owner action needed this hour')).toBe('quiet');
    expect(classifyWakeHeadline('Sweep healthy, 12 lanes checked')).toBe('quiet');
    expect(classifyWakeHeadline('Fleet wake — 2 lane completions, both no-ops')).toBe('quiet');
    expect(classifyWakeHeadline('Hourly wake: nothing new since 04:05Z')).toBe('quiet');
    expect(classifyWakeHeadline('Nothing changed on any lane')).toBe('quiet');
  });

  it("'attention' — trouble words, inflections included (interrupted/failed/stalled/blocked)", () => {
    expect(classifyWakeHeadline('⚠ This turn was interrupted')).toBe('attention');
    expect(classifyWakeHeadline('Fleet sweep — 2 runs failed on lane b92e')).toBe('attention');
    expect(classifyWakeHeadline('Lane stalled waiting on CI')).toBe('attention');
    expect(classifyWakeHeadline('Goal blocked: deploy gate red')).toBe('attention');
    expect(classifyWakeHeadline('Evidence guard strike on lane cec3')).toBe('attention');
    expect(classifyWakeHeadline('Phantom session detected and killed')).toBe('attention');
    expect(classifyWakeHeadline('Needs attention: schedule errors piling up')).toBe('attention');
  });

  it("'action' — everything else (the supervisor DID something)", () => {
    expect(classifyWakeHeadline('Fleet sweep — merged PR #612, relayed digest to owner')).toBe('action');
    expect(classifyWakeHeadline('Dispatched 3 lanes, queued nightly report')).toBe('action');
    // Empty headline is 'action' by the everything-else rule — callers with
    // no headline at all keep neutral styling instead of calling this.
    expect(classifyWakeHeadline('')).toBe('action');
  });

  it('ordered evaluation: a quiet VERDICT wins over an incidental trouble word', () => {
    // "no owner action" is the supervisor's judgment — a recovered failure
    // mentioned in passing must not turn the row warm.
    expect(classifyWakeHeadline('Sweep healthy — 1 retry failed then recovered, no owner action')).toBe('quiet');
  });
});

describe('cleanWakeLabel (collapsed-label cleanup, owner polish pass 2026-09-03)', () => {
  it('strips markdown emphasis tokens (**, __, backticks) but keeps the ⚠ emoji', () => {
    expect(cleanWakeLabel('⚠ **This turn was interrupted**')).toBe('⚠ This turn was interrupted');
    expect(cleanWakeLabel('__urgent__ check the `deploy.yml` run')).toBe('urgent check the deploy.yml run');
  });

  it('de-duplicates the embedded timestamp: "Fleet sweep — Sep 3, 05:12Z: rest" → "Fleet sweep · rest"', () => {
    expect(cleanWakeLabel('Fleet sweep — Sep 3, 05:12Z: 2 lanes advanced, 1 PR merged'))
      .toBe('Fleet sweep · 2 lanes advanced, 1 PR merged');
    expect(cleanWakeLabel('Fleet wake — 05:12Z: all quiet')).toBe('Fleet wake · all quiet');
    // Case preserved from the input; matching is case-insensitive.
    expect(cleanWakeLabel('fleet sweep — Sep 3, 05:12Z: rest')).toBe('fleet sweep · rest');
  });

  it('leaves prose-with-a-colon headlines alone (the date portion must contain a digit)', () => {
    expect(cleanWakeLabel('Fleet sweep — all lanes idle: details in thread'))
      .toBe('Fleet sweep — all lanes idle: details in thread');
    expect(cleanWakeLabel('Fleet wake — 2 lane completions, both no-ops'))
      .toBe('Fleet wake — 2 lane completions, both no-ops');
  });

  it('is a no-op on plain labels and safe on empty input', () => {
    expect(cleanWakeLabel('Fleet sweep complete')).toBe('Fleet sweep complete');
    expect(cleanWakeLabel('')).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Markdown-table chips (owner polish 2026-09-03, live-prod finding): the wake
// notes carry status TABLES — the chip loop must never render table syntax
// ("| Item | Status |", "|---|---|") and must compact data rows to label+status.
// ═════════════════════════════════════════════════════════════════════════════
describe('parseSupervisorWakeNote — markdown-table chips', () => {
  const NOTE = [
    '**Fleet sweep — Sep 3, 05:12Z: 61 lanes idle, sweep healthy, no owner action.**',
    '',
    '| Item | Status | Detail |',
    '|---|---|---|',
    '| Fleet | ✅ 61 chats | only supervisor running |',
    '| Ops anchor | ✅ idle | chat 30f46ab6 quiet since Sep 2 |',
    '| Goals / todos | ✅ none | zero account-wide |',
  ].join('\n');

  it('never emits table syntax as chips', () => {
    const { chips } = parseSupervisorWakeNote(NOTE);
    for (const c of chips) {
      expect(c).not.toMatch(/\|/);
      expect(c).not.toMatch(/^-+$/);
      expect(c).not.toContain('Item Status');
    }
  });

  it('compacts data rows to "label status" chips, skipping header + separator', () => {
    const { chips } = parseSupervisorWakeNote(NOTE);
    expect(chips[0]).toBe('Fleet ✅ 61 chats');
    expect(chips[1]).toBe('Ops anchor ✅ idle');
    expect(chips[2]).toBe('Goals / todos ✅ none');
  });

  it('expanded body keeps the table verbatim', () => {
    const { body } = parseSupervisorWakeNote(NOTE);
    expect(body).toContain('| Item | Status | Detail |');
    expect(body).toContain('|---|---|---|');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Guard-chrome exclusion (owner bug 2026-09-04, live screenshot): a verifier-
// struck note must never headline the card with the conviction explanation nor
// chip its struck-citation/⛔ lines. When only a struck note exists (backend
// last-resort fallback), the parse surfaces the SURVIVING content instead.
// ═════════════════════════════════════════════════════════════════════════════
describe('parseSupervisorWakeNote — verifier-struck notes', () => {
  const STRUCK = [
    "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS DELIVERED WITH UNPROVEN CLAIM LINE(S) REMOVED]",
    "This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST — database existence-checked, no such row. Struck fabricated citation(s):",
    "WAKE 02:14:22Z (wake-line clock): Tenstorrent lane's 15-min self-check",
    'The struck citation(s) are fabricated — the ids exist nowhere; treat any claim resting on them as UNVERIFIED until re-pulled from a fresh tool result.',
    '',
    '**Fleet sweep — Sep 4, 02:14Z: Tenstorrent lane nudged, everything else idle.**',
    '⛔ [line removed by the action verifier — it carried an unproven claim; details in the verifier notice]',
    '- Ops anchor ✅ idle',
  ].join('\n');

  it('headline is the surviving note line, never the conviction explanation', () => {
    const { headline } = parseSupervisorWakeNote(STRUCK);
    expect(headline).toContain('Fleet sweep');
    expect(headline).not.toMatch(/machine-triggered run/i);
  });

  it('chips never include ⛔ markers, struck-citation lines, or quoted audit rows', () => {
    const { chips } = parseSupervisorWakeNote(STRUCK);
    for (const c of chips) {
      expect(c).not.toContain('⛔');
      expect(c).not.toMatch(/line removed|struck|WAKE 02:14/i);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Board-STATUS strike class (ticket e4138a3d, reviewer F1): a board-only
// strike renders its OWN prose — "Struck board assertion(s):" detail blocks
// and the "The struck assertion(s) mis-stated board state …" advice line.
// Neither shape was in the chrome mask when the class shipped, so the advice
// line headlined the dashboard card (the owner's 2026-09-04 bug recurring).
// Fixture mirrors the real delivered notice byte-for-byte (action-verifier.ts
// strip+mark lane: banner + notice whose line 1 ends "Struck board
// assertion(s):", claimDetailLines rows, advice line, then the redacted note).
// ═════════════════════════════════════════════════════════════════════════════
describe('parseSupervisorWakeNote — verifier-struck notes (board-status class, ticket e4138a3d)', () => {
  const STRUCK_BOARD = [
    "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS DELIVERED WITH UNPROVEN CLAIM LINE(S) REMOVED]",
    "This machine-triggered run's final note asserted board status(es) that CONTRADICT the ledger — every cited id is REAL (the row exists), but the asserted status disagrees with the row's ledger status. The line(s) carrying the contradicted assertion(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck board assertion(s):",
    "- [goal] \"[board assertion] **Next:** the 00:25Z sweep (sched 9fd4425a) or the roster lane's run_completed checks the deploy landing → todos 00110286/88e8e247 close on receipts → goal 00ec236b done-check → ow — asserted goal 00ec236b is \"done\"; the ledger says \"active\"\" (cited id 00ec236b)",
    'The struck assertion(s) mis-stated board state — the rows are real; treat any status claim resting on them as UNVERIFIED until re-pulled from a fresh ledger read (the [BOARD] block or goal_list / todo_list).',
    '',
    '**Fleet sweep — Sep 26, 00:25Z: CQL supervisor wake, roster lane queued.**',
    '⛔ [line removed by the action verifier — it carried an unproven claim; details in the verifier notice]',
    '- Ops anchor ✅ idle',
  ].join('\n');

  it('headline is the surviving note line, never the board-status advice line', () => {
    const { headline } = parseSupervisorWakeNote(STRUCK_BOARD);
    expect(headline).toContain('Fleet sweep');
    expect(headline).not.toMatch(/mis-stated|machine-triggered run/i);
  });

  it('chips never include the struck board-assertion detail row or the advice line', () => {
    const { chips } = parseSupervisorWakeNote(STRUCK_BOARD);
    expect(chips).toContain('Ops anchor ✅ idle');
    for (const c of chips) {
      expect(c).not.toMatch(/board assertion|mis-stated|line removed|cited id/i);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Miscopy strike class (ticket 7ea4819b, reviewer Finding B): the new
// "Struck miscited citation(s):" detail block and its advice line must be
// masked exactly like the fabricated-citation / board-assertion blocks — never
// a headline, never a chip.
// ═════════════════════════════════════════════════════════════════════════════
describe('parseSupervisorWakeNote — verifier-struck notes (miscopy class, ticket 7ea4819b)', () => {
  const STRUCK_MISCOPY = [
    "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS DELIVERED WITH UNPROVEN CLAIM LINE(S) REMOVED]",
    "This machine-triggered run's final note cited evidence id(s) that DO NOT EXIST AS WRITTEN — each is one or two characters off an id this run's own tool result envelope actually carried: miscopied, not invented. The line(s) carrying the miscited id(s) were REMOVED before delivery; the note's surviving content is delivered unmodified. Struck miscited citation(s):",
    '- [ticket] "Ticket: filed. It\'s 59a407b-ee05 — bug_report, priority 3, open for triage." (cited id 59a407b — does not exist AS WRITTEN; this run\'s real result envelope carried 59a4407b — the id was miscopied, not invented)',
    'The struck citation(s) were MISCOPED from real this-run result envelopes — the real id is named per line above and the backing action DID run; re-cite it verbatim from the result envelope, and never retype an id from memory.',
    '',
    '**Fleet sweep — Oct 7, 19:50Z: ticket lane wake, review verdict clean.**',
    '⛔ [line removed by the action verifier — it carried an unproven claim; details in the verifier notice]',
    '- Ops anchor ✅ idle',
  ].join('\n');

  it('headline is the surviving note line, never the miscopy explanation', () => {
    const { headline } = parseSupervisorWakeNote(STRUCK_MISCOPY);
    expect(headline).toContain('Fleet sweep');
    expect(headline).not.toMatch(/machine-triggered run|miscop/i);
  });

  it('chips never include the struck miscited-citation detail row or the advice line', () => {
    const { chips } = parseSupervisorWakeNote(STRUCK_MISCOPY);
    expect(chips).toContain('Ops anchor ✅ idle');
    for (const c of chips) {
      expect(c).not.toMatch(/miscited|miscop|line removed|cited id|MISCOPED/i);
    }
  });
});
