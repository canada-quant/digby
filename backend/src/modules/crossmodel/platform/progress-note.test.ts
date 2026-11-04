/**
 * Ticket a8d6e514 — progressNote storage cap vs display clamp (pure leaf).
 * The round-trip through the real tools lives in
 * platform-tools.progress-note.a8d6e514.test.ts; each renderer pins its own clamp.
 */
import {
  PROGRESS_NOTE_MAX, PROGRESS_NOTE_LEGACY_MAX, PROGRESS_NOTE_DISPLAY_MAX,
  progressNoteMax, progressNoteLongDisabled, progressNoteForDisplay, progressNoteLead,
  progressNoteClipNotice, clipProgressNote,
} from './progress-note';

afterEach(() => { delete process.env.PROGRESS_NOTE_LONG_DISABLED; });

/** The amputated ledger from the ticket (todo d14e0d2d), extended past 200 chars the way the lane wrote it. */
const LEDGER = 'FO f15 cycle (2026-10-05 16:00Z): queue 0 open / 2 in_progress. 9cc62eef stale-by-closure … f8c62820 (hook-retirement shortfall, my finding) filed; next firing continues from f16: re-check 9cc62eef closure evidence, then sweep the hook-retirement class for siblings (d14e0d2d ledger).';

describe('storage cap', () => {
  it('stores 2,000 chars; PROGRESS_NOTE_LONG_DISABLED=1 restores the legacy 200', () => {
    expect(PROGRESS_NOTE_MAX).toBe(2000);
    expect(progressNoteLongDisabled()).toBe(false);
    expect(progressNoteMax()).toBe(2000);
    process.env.PROGRESS_NOTE_LONG_DISABLED = '1';
    expect(progressNoteLongDisabled()).toBe(true);
    expect(progressNoteMax()).toBe(PROGRESS_NOTE_LEGACY_MAX);
    expect(PROGRESS_NOTE_LEGACY_MAX).toBe(200);
  });
});

describe('progressNoteForDisplay', () => {
  it('a note within 200 chars is returned byte-identically (every pre-a8d6e514 note renders unchanged)', () => {
    expect(progressNoteForDisplay('3/5 shards trained, loss 2.1')).toBe('3/5 shards trained, loss 2.1');
    const exactly200 = 'a'.repeat(200);
    expect(progressNoteForDisplay(exactly200)).toBe(exactly200);
    expect(progressNoteForDisplay(' padded\nnote ')).toBe(' padded\nnote ');
  });

  it('a long note is cut on a word boundary, closed with "…", and never exceeds the max', () => {
    expect(LEDGER.length).toBeGreaterThan(PROGRESS_NOTE_DISPLAY_MAX);
    const shown = progressNoteForDisplay(LEDGER)!;
    expect(shown.length).toBeLessThanOrEqual(PROGRESS_NOTE_DISPLAY_MAX);
    expect(shown.endsWith('…')).toBe(true);
    const body = shown.slice(0, -1);
    expect(LEDGER.startsWith(body)).toBe(true);
    // the cut lands on a word boundary — never mid-word (the ticket's "my fi" amputation)
    expect(LEDGER[body.length]).toMatch(/[\s,;:—–-]/);
    const two = progressNoteForDisplay('x'.repeat(10) + ' ' + 'y'.repeat(2000))!;
    expect(two.length).toBeLessThanOrEqual(PROGRESS_NOTE_DISPLAY_MAX); // one giant token: cut mid-token, not emptied
    expect(two.length).toBeGreaterThan(100);
  });

  it('takes a custom max (the digest fact line uses 90) and is code-point safe', () => {
    const s = progressNoteForDisplay(LEDGER, 90)!;
    expect(s.length).toBeLessThanOrEqual(90);
    expect(s.endsWith('…')).toBe(true);
    const emoji = '🚀'.repeat(250);
    const e = progressNoteForDisplay(emoji)!;
    expect(Array.from(e).length).toBeLessThanOrEqual(PROGRESS_NOTE_DISPLAY_MAX);
    expect(e).not.toMatch(/\uD83D(?!\uDE80)/); // no split surrogate pair
  });

  it('null / non-string → null', () => {
    expect(progressNoteForDisplay(null)).toBeNull();
    expect(progressNoteForDisplay(undefined)).toBeNull();
    expect(progressNoteForDisplay(42 as unknown)).toBeNull();
  });
});

describe('progressNoteLead', () => {
  it('is the first 200 chars raw — what the HOLD / fraction readers always saw', () => {
    expect(progressNoteLead(LEDGER)).toBe(LEDGER.slice(0, 200));
    expect(progressNoteLead('HOLD — owner said wait')).toBe('HOLD — owner said wait');
    expect(progressNoteLead(null)).toBe('');
  });
});

describe('progressNoteClipNotice (ticket f3e56567 — never report plain success for a vanished tail)', () => {
  it('is null when the whole note fits the cap (no false alarm on normal writes)', () => {
    expect(progressNoteClipNotice('3/5 shards trained, loss 2.1', '3/5 shards trained, loss 2.1')).toBeNull();
    expect(progressNoteClipNotice('a'.repeat(2000), 'a'.repeat(2000))).toBeNull();
  });

  it('is null for a null/undefined clear and for a non-string payload', () => {
    expect(progressNoteClipNotice(null, null)).toBeNull();
    expect(progressNoteClipNotice(undefined, null)).toBeNull();
    expect(progressNoteClipNotice(42 as unknown, 'x')).toBeNull();
  });

  it('fires on a clipped note and names the sent / stored / lost counts', () => {
    // The live shape observed 2026-10-30 on a deployed build: a 2,604-char
    // glyph-rich note stored as exactly 2,000 chars, with no error anywhere.
    const sent = Array.from({ length: 130 }, (_, i) => `L${i} ≥2 → ×3 · 中文`).join('\n');
    expect(Array.from(sent).length).toBeGreaterThan(2000);
    const note = progressNoteClipNotice(sent, Array.from(sent).slice(0, 2000).join(''))!;
    expect(note).toContain('[progressNote CLIPPED]');
    expect(note).toContain(`${Array.from(sent).length} chars sent`);
    expect(note).toContain('2000 stored');
    expect(note).toContain(`${Array.from(sent).length - 2000} chars did NOT land`);
    // It must never echo the note's content back (user prose; may carry secrets).
    expect(note).not.toContain('中文');
  });

  it('counts CODE POINTS, not UTF-16 units — a glyph-rich note is not falsely clipped', () => {
    // 1,000 astral-plane emoji = 2,000 UTF-16 units but only 1,000 code points.
    // A length check on .length would wrongly report a clip here.
    const emoji = '🚀'.repeat(1000);
    expect(emoji.length).toBe(2000);
    expect(progressNoteClipNotice(emoji, emoji)).toBeNull();
  });

  it('honours PROGRESS_NOTE_LONG_DISABLED=1 (legacy 200-char cap) for the lost count', () => {
    process.env.PROGRESS_NOTE_LONG_DISABLED = '1';
    const sent = 'x'.repeat(300);
    const note = progressNoteClipNotice(sent, sent.slice(0, 200))!;
    expect(note).toContain('200 stored');
    expect(note).toContain('100 chars did NOT land');
  });
});

/**
 * f3e56567 follow-up (2026-10-30) — the writer and the guard must count the
 * SAME unit. `goals.service` used to cap with `.slice(0, progressNoteMax())`,
 * which counts UTF-16 units while progressNoteClipNotice counts code points;
 * the mismatch made the guard go silent exactly on astral-plane payloads.
 */
describe('clipProgressNote (the STORAGE cap — code points, never a split surrogate)', () => {
  const hasLoneSurrogate = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  it('returns a note that FITS byte-identically (no rewriting of normal notes)', () => {
    expect(clipProgressNote(LEDGER)).toBe(LEDGER);
    expect(clipProgressNote('  3/5 shards trained  ')).toBe('3/5 shards trained');
    expect(clipProgressNote('a'.repeat(2000))).toBe('a'.repeat(2000));
    expect(clipProgressNote(null)).toBe('');
    expect(clipProgressNote(undefined)).toBe('');
    expect(clipProgressNote(42 as unknown)).toBe('');
  });

  it('caps at 2,000 CODE POINTS — 2,000 emoji survive whole, not 1,000', () => {
    // The defect: 2,000 emoji = 4,000 UTF-16 units, so .slice(0, 2000) kept
    // only half the note. It must keep all 2,000 code points.
    const emoji = '🚀'.repeat(2000);
    const out = clipProgressNote(emoji);
    expect(Array.from(out).length).toBe(2000);
    expect(out.length).toBe(4000);
    expect(out).toBe(emoji);
  });

  it('never emits a lone surrogate — a cut mid-pair would serialize to U+FFFD', () => {
    const cases = [
      `${'b'.repeat(1999)}${'🚀'.repeat(500)}`,
      `${'a'.repeat(999)}${'🚀'.repeat(800)}`,
      `${'x'.repeat(2001)}${'🚀'.repeat(10)}`,
    ];
    for (const sent of cases) {
      const out = clipProgressNote(sent);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(Array.from(out).length).toBeLessThanOrEqual(2000);
      // A clean prefix: nothing but the tail is missing.
      expect(sent.startsWith(out)).toBe(true);
    }
  });

  it('the guard and the writer agree — a clipped astral note is NEVER silent', () => {
    // The regression this pins: requested cp <= max but stored cp < requested,
    // so the old code point-gated notice returned null on a real half-loss.
    const sent = '🚀'.repeat(2000);
    const stored = clipProgressNote(sent);
    expect(progressNoteClipNotice(sent, stored)).toBeNull(); // nothing was lost
    // And when a write IS cut, the same pair produces the loud notice.
    const over = '🚀'.repeat(2500);
    const cut = clipProgressNote(over);
    expect(Array.from(cut).length).toBe(2000);
    expect(progressNoteClipNotice(over, cut)).toContain('[progressNote CLIPPED]');
  });

  it('still honours the legacy 200 cap under PROGRESS_NOTE_LONG_DISABLED=1', () => {
    process.env.PROGRESS_NOTE_LONG_DISABLED = '1';
    expect(Array.from(clipProgressNote('🚀'.repeat(500))).length).toBe(200);
    expect(clipProgressNote('short')).toBe('short');
  });
});
