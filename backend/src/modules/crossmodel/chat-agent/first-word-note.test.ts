import { firstWordNote, firstWordNoteEnabled, quickFirstWordNote, FIRST_WORD_OPENER_DISABLED_ENV } from './first-word-note';

describe('firstWordNote (ticket 4f7263e4 — first-word opener on human plain-chat turns)', () => {
  it('is ON by default and asks for one useful line before the first tool call', () => {
    const note = firstWordNote({});
    expect(firstWordNoteEnabled({})).toBe(true);
    expect(note).toMatch(/## First word/);
    expect(note).toMatch(/OPEN WITH ONE USEFUL LINE before your first tool call/);
    // The three honest opener shapes (answer / best take + confidence / what you are about to check)
    expect(note).toMatch(/Already certain\?/);
    expect(note).toMatch(/Not certain\?/);
    expect(note).toMatch(/Genuinely unknowable without looking\?/);
    // One line, then tools — and never a second opener (mid-turn prose after a tool call is dropped)
    expect(note).toMatch(/ONE line, then your first tool call/);
    expect(note).toMatch(/never re-open later rounds/);
  });

  it('kill switch FIRST_WORD_OPENER_DISABLED=1 removes the note (the adapter still delivers an opener a model writes on its own)', () => {
    expect(firstWordNote({ [FIRST_WORD_OPENER_DISABLED_ENV]: '1' })).toBe('');
    expect(firstWordNoteEnabled({ [FIRST_WORD_OPENER_DISABLED_ENV]: '1' })).toBe(false);
    // any other value keeps the note on (the flag is an on/off switch, fail-open to the fix)
    expect(firstWordNote({ [FIRST_WORD_OPENER_DISABLED_ENV]: '0' })).toMatch(/## First word/);
  });

  it('quickFirstWordNote (ticket afc10e95 — Quick-lane first-chunk p50 53.4s vs the 45s bar) opens with one line before the FIRST SEARCH', () => {
    const note = quickFirstWordNote({});
    expect(note).toMatch(/## First word \(this turn — Quick lane\)/);
    expect(note).toMatch(/OPEN WITH ONE LINE before your first search/);
    // The two honest opener shapes for a lookup turn
    expect(note).toMatch(/Already know the answer off-hand\?/);
    expect(note).toMatch(/Do not know it\?/);
    // never a bare "let me check…" opener — the 2026-10-15 turns that breached the bar opened on tool calls
    expect(note).toMatch(/never "let me check…" alone/);
    // the lane's web budget is named so the opener rule and the lane brief agree
    expect(note).toMatch(/web budget: one search, one page at most/);
    expect(note).toMatch(/ONE opening line, then the search in the SAME turn/);
    expect(note).toMatch(/never re-open later rounds/);
  });

  it('quickFirstWordNote respects the same kill switch (single off-switch for both variants)', () => {
    expect(quickFirstWordNote({ [FIRST_WORD_OPENER_DISABLED_ENV]: '1' })).toBe('');
    expect(quickFirstWordNote({ [FIRST_WORD_OPENER_DISABLED_ENV]: '0' })).toMatch(/## First word/);
  });
});
