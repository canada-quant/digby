/**
 * reject-back-seed (autonomy loop #11): the pure seed builder the machine-wake
 * reject-back seam appends to its ONE bounded retry.
 */
import {
  buildRejectBackRetrySeed, collectToolResults, REJECT_BACK_SEED_HEADER, REPEAT_SEED_HEADER,
  SEED_MAX_DRAFT_CHARS, SEED_MAX_PER_RESULT_CHARS,
} from './reject-back-seed';

const parts = [
  { type: 'text', text: 'thinking…' },
  { type: 'tool_call', name: 'get_chat_status', args: { chatId: 'b92ef13f' } },
  { type: 'tool_result', name: 'get_chat_status', result: 'chat b92ef13f: idle since 11:20:03Z; last run 3fd48f73 completed' },
  { type: 'tool_call', name: 'list_feedback', args: {} },
  { type: 'tool_result', result: '2 open tickets: 431518a2 (in_progress), 78f32515 (open)' }, // no name → paired with the preceding call
  { type: 'tool_result', name: 'empty_tool', result: '   ' }, // blank → dropped
];

describe('collectToolResults', () => {
  it('keeps non-blank tool_result texts and pairs a nameless result with the nearest preceding tool_call', () => {
    expect(collectToolResults(parts)).toEqual([
      { name: 'get_chat_status', text: 'chat b92ef13f: idle since 11:20:03Z; last run 3fd48f73 completed' },
      { name: 'list_feedback', text: '2 open tickets: 431518a2 (in_progress), 78f32515 (open)' },
    ]);
    expect(collectToolResults(null)).toEqual([]);
    expect(collectToolResults([{ type: 'tool_result', result: 42 } as any])).toEqual([]);
  });
});

describe('buildRejectBackRetrySeed', () => {
  it('quotes the rejected draft line by line and lists this run\'s tool results with rewrite instructions', () => {
    const seed = buildRejectBackRetrySeed(parts, '**WAKE 2026-09-20T11:35Z**\nLane b92ef13f idle as of 11:41Z.\n- next: watch ticket 431518a2');
    expect(seed.startsWith(REJECT_BACK_SEED_HEADER)).toBe(true);
    expect(seed).toMatch(/Do not redo the whole wake/);
    expect(seed).toMatch(/ONE fresh evidence-bearing tool call/);
    expect(seed).toContain('--- REJECTED DRAFT (quoted for rewriting — UNVERIFIED; struck items are NOT DONE) ---\n> **WAKE 2026-09-20T11:35Z**\n> Lane b92ef13f idle as of 11:41Z.\n> - next: watch ticket 431518a2\n--- END REJECTED DRAFT ---');
    expect(seed).toContain('--- TOOL RESULTS FROM THIS RUN (2 of 2 shown; still valid — cite them, do not re-fetch them) ---');
    expect(seed).toContain('[1] get_chat_status:\nchat b92ef13f: idle since 11:20:03Z; last run 3fd48f73 completed');
    expect(seed).toContain('[2] list_feedback:\n2 open tickets');
    expect(seed).toContain('--- END TOOL RESULTS ---');
  });

  it('caps the draft, each result and the total tool budget, and says what was not shown', () => {
    const bigParts = Array.from({ length: 30 }, (_, i) => ({ type: 'tool_result', name: `t${i}`, result: 'x'.repeat(2_000) }));
    const seed = buildRejectBackRetrySeed(bigParts, 'd'.repeat(SEED_MAX_DRAFT_CHARS + 500), { maxToolChars: 5_000, maxPerResult: SEED_MAX_PER_RESULT_CHARS });
    expect(seed).toContain(`…[500 more chars not shown]`); // the draft clip
    expect(seed).toContain('…[500 more chars not shown]\n'); // per-result clip (2000 → 1500)
    expect(seed).toMatch(/TOOL RESULTS FROM THIS RUN \(\d+ of 30 shown/);
    // Total tool budget 5 000 → at most 4 results of ≤ ~1 500 chars.
    const shown = Number(/\((\d+) of 30 shown/.exec(seed)![1]);
    expect(shown).toBeLessThanOrEqual(4);
    expect(shown).toBeGreaterThanOrEqual(3);
  });

  it('nothing to seed (no draft, no results) → empty string', () => {
    expect(buildRejectBackRetrySeed([], '')).toBe('');
    expect(buildRejectBackRetrySeed([{ type: 'text', text: 'hi' }], '   ')).toBe('');
  });

  it('a draft alone or results alone still seed (each section is independent)', () => {
    const draftOnly = buildRejectBackRetrySeed([], 'just a draft');
    expect(draftOnly).toContain('> just a draft');
    expect(draftOnly).not.toContain('TOOL RESULTS FROM THIS RUN');
    const resultsOnly = buildRejectBackRetrySeed(parts, '');
    expect(resultsOnly).not.toContain('REJECTED DRAFT');
    expect(resultsOnly).toContain('[1] get_chat_status:');
  });
});

// Tickets 4c7aebf7 + 9a976d83, round-2 nit (finding 7): a struck-note REPEAT's retry is NOT a rewrite — the draft
// is the re-posted struck note and the repeat notice asks for fresh tool calls on every flagged claim, so the
// rewrite seed's "REWRITE … do not redo the whole wake … do not re-fetch them" contradicted it.
describe('buildRejectBackRetrySeed — the struck-note repeat mode', () => {
  it('carries this run\'s tool results as REFERENCE only: no draft, no rewrite / do-not-re-fetch wording', () => {
    const seed = buildRejectBackRetrySeed(parts, 'the re-posted struck note', { mode: 'repeat' });
    expect(seed.startsWith(REPEAT_SEED_HEADER)).toBe(true);
    expect(seed).not.toContain(REJECT_BACK_SEED_HEADER);
    expect(seed).not.toContain('REJECTED DRAFT');
    expect(seed).not.toContain('the re-posted struck note');
    expect(seed).not.toMatch(/rewrit|REWRITE|do not re-fetch|Do not redo the whole wake/i);
    expect(seed).toMatch(/fresh tool call/);
    expect(seed).toContain('[1] get_chat_status:');
    expect(seed).toMatch(/--- TOOL RESULTS FROM THIS RUN \(2 of 2 shown; reference only — re-run every step the notice flags\) ---/);
  });

  it('no tool results ⇒ empty (the repeat notice carries the whole retry)', () => {
    expect(buildRejectBackRetrySeed([], 'the re-posted struck note', { mode: 'repeat' })).toBe('');
  });

  it('the default mode is byte-identical to the rewrite seed', () => {
    expect(buildRejectBackRetrySeed(parts, 'x', { mode: 'rewrite' })).toBe(buildRejectBackRetrySeed(parts, 'x'));
  });
});
