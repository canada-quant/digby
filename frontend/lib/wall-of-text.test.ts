/**
 * Ticket 6ee7a779 — the render-time twin of the backend persist repair: an
 * answer whose newlines ALL arrived as spaces renders as a real document the
 * first time (owner: "one big block of text… then double checker fixes it but
 * should show correct the first time"). Mirrors
 * backend/src/modules/crossmodel/wall-of-text.test.ts — keep in sync.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { repairWallOfText, WALL_MIN_CHARS } from './wall-of-text';
import { normalizeMarkdownForRender } from './markdown-normalize';

/** The thumbed-down supervisor answer (prod shape: 1,647 chars, zero newlines). */
const WALL = "Fresh probe across the board, the repo and S3 — here is the real state at 5:16 PM PDT (00:16Z): ## Not quite. **95% — two tail items left, both tracked.** **Done and verified on main (sha bc59c291 — nothing ahead of it):** - P1 Juriterm + Termium: 19,593 documents + 23 ZIPs - P2 Manitoba + New Brunswick + LégisQuébec current: 3,165 + 2,188 + 9,545 files - P3 LégisQuébec historique: 420,107 version pages, 0 errors (biggest single source) - P4 Érudit FR commentary: 5,991 files / 5.83 GB - Ontario statutes: 83,117 files (prior leg) **Still open — 2 items:** 1. **English commentary (bcli) wrapper chain:** ALIVE (PID 70221, checked moments ago) — 253 files / 263 MB harvested so far, on its 3rd deferral pass. 2. **BC point-in-time + NB twin check:** fix committed, relaunch blocked on the remaining 2,111 E-Laws point-in-time queue draining. Then the same one-PR close-out.";

describe('repairWallOfText (frontend port)', () => {
  it('re-lines heading, labels, bullets and numbered items', () => {
    const out = repairWallOfText(WALL);
    expect(out).toContain('(00:16Z):\n\n## Not quite. **95% — two tail items left, both tracked.**\n\n**Done and verified on main');
    expect(out).toContain('nothing ahead of it):**\n- P1 Juriterm + Termium: 19,593 documents + 23 ZIPs\n- P2 Manitoba');
    expect(out).toContain('(prior leg)\n\n**Still open — 2 items:**\n1. **English commentary (bcli) wrapper chain:** ALIVE');
    expect(out).toContain('deferral pass.\n2. **BC point-in-time + NB twin check:**');
    expect(repairWallOfText(out)).toBe(out);
  });

  it('leaves short text, text with a line break and plain prose alone', () => {
    expect(repairWallOfText('a - B - C ## D')).toBe('a - B - C ## D');
    const withBreak = `${WALL.slice(0, 300)}\n${WALL.slice(300)}`;
    expect(repairWallOfText(withBreak)).toBe(withBreak);
    const prose = 'The run took 10 - 12 minutes and the second pass - which we expected - was faster than the first one by a wide margin. '.repeat(4);
    expect(prose.length).toBeGreaterThan(WALL_MIN_CHARS);
    expect(repairWallOfText(prose)).toBe(prose);
  });
});

describe('normalizeMarkdownForRender runs the repair (NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('renders the wall as CommonMark and stays idempotent', () => {
    const out = normalizeMarkdownForRender(WALL);
    expect(out).toContain('\n\n## Not quite.');
    expect(out).toContain(':**\n\n- P1 Juriterm');
    expect(normalizeMarkdownForRender(out)).toBe(out);
  });

  it('the kill switch restores the pre-6ee7a779 render', () => {
    vi.stubEnv('NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED', '1');
    expect(normalizeMarkdownForRender(WALL)).toBe(WALL);
  });
});
