/**
 * Bubble-text colour pins (ticket a1aeb151, 2026-10-17) — the Fleet Supervisor
 * user-bubble timestamp regressed to `text-white/70` sitting on the neutral
 * `bg-bubble` token (oklch 0.94 ≈ #ebebeb in light → ~1.1:1 contrast) when
 * 3e640f12 swept every legacy colour onto the Frontier palette: the bubble went
 * light but the timestamp kept the white that only worked on the old dark
 * violet bubble. Three guards, all source-level (no rendered DOM, no line
 * numbers):
 *
 *  1. PIN — both bg-bubble user-bubble timestamps (Fleet Supervisor chat +
 *     its dev harness mirror) use `text-ink-2`, never `text-white*`.
 *  2. LINT — no component renders `text-white*` / `primary-foreground` within
 *     15 lines below a `bg-bubble` element: the bubble body is a LIGHT token
 *     in every palette, so white-on-light is unreadable by construction.
 *  3. TOKENS — `--ink` and `--ink-2` stay ≥4.5:1 (WCAG AA, small text)
 *     against `--bubble` in every palette block of globals.css. Luminance
 *     uses the neutral-oklch approximation Y ≈ L³ (all bubble/ink tokens
 *     carry chroma ≤ 0.015, where the error is <1%). NB: `--ink-3` is
 *     intentionally NOT asserted — it measures ≈4.2:1 on `--bubble` in light,
 *     which is exactly why the fix pins `text-ink-2`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

/** The two mirrored user-bubble renderers (the harness page is SupervisorChatTab's dev twin). */
const BUBBLE_PIN_SITES = [
  'app/crossmodel/management/SupervisorChatTab.tsx',
  'app/dev-accordion-harness/page.tsx',
];

/* ── 1. Pin ──────────────────────────────────────────────────────────────── */

describe('Bubble pins (a1aeb151) — user-bubble timestamp colour', () => {
  for (const rel of BUBBLE_PIN_SITES) {
    it(`${rel}: timestamp uses text-ink-2 on the bg-bubble bubble (never text-white)`, () => {
      const src = read(rel);
      // The user bubble itself is the neutral Frontier bubble.
      expect(src).toContain('bg-bubble text-ink');
      // The timestamp rides INSIDE that bubble: ink-2 measures ≈7.1:1 on
      // --bubble in light, ≈7.4:1 in dark (AA floor is 4.5:1).
      expect(src).toContain('text-[10px] mt-1 text-ink-2 text-right');
      // The regressed class must not come back anywhere in these files.
      expect(src).not.toMatch(/text-white(\/\d+)?/);
    });
  }
});

/* ── 2. Lint — no white text inside a bg-bubble element ─────────────────── */

const SCAN_ROOTS = ['app', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo']);

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) yield* walkTsx(join(dir, entry.name));
    } else if (extname(entry.name) === '.tsx') {
      yield join(dir, entry.name);
    }
  }
}

/** Files where a `bg-bubble` element has text-white (any opacity) or primary-foreground in the 15 lines below it. */
function bubbleWhiteViolations(): string[] {
  const violations: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = join(FRONTEND_ROOT, root);
    if (!statSync(rootDir).isDirectory()) continue;
    for (const file of walkTsx(rootDir)) {
      // Test files legitimately assert on class strings — they are not rendered surfaces.
      if (/\.test\.|\.spec\./.test(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('bg-bubble')) return;
        // The element's own line plus the 15 below it (the SupervisorChatTab
        // bubble body spans 12 lines end-to-end).
        const win = lines.slice(i, i + 16).join('\n');
        if (/text-white(\/\d+)?/.test(win) || win.includes('primary-foreground')) {
          violations.push(`${relative(FRONTEND_ROOT, file)}:${i + 1}`);
        }
      });
    }
  }
  return violations;
}

describe('Bubble lint (a1aeb151) — no text-white inside any bg-bubble element', () => {
  it('every bg-bubble site renders bubble-safe text classes below it', () => {
    expect(bubbleWhiteViolations()).toEqual([]);
  });
});

/* ── 3. Token contrast — bubble text stays WCAG-AA on --bubble ──────────── */

type Oklch = { l: number; c: number; h: number };

/** Flat CSS blocks (selector → oklch-literal custom properties). */
function parseOklchBlocks(css: string): { selector: string; vars: Record<string, Oklch> }[] {
  const blocks: { selector: string; vars: Record<string, Oklch> }[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(css))) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    const vars: Record<string, Oklch> = {};
    const varRe = /(--[a-z0-9-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g;
    let v: RegExpExecArray | null;
    while ((v = varRe.exec(m[2]))) {
      vars[v[1]] = { l: parseFloat(v[2]), c: parseFloat(v[3]), h: parseFloat(v[4]) };
    }
    if (vars['--bubble'] && vars['--ink'] && vars['--ink-2']) blocks.push({ selector, vars });
  }
  return blocks;
}

/** Neutral-oklch relative luminance ≈ L³ (chroma ≤ 0.015 → <1% error). */
const luminance = (t: Oklch): number => t.l ** 3;
/** WCAG contrast ratio between two colours. */
const contrast = (a: Oklch, b: Oklch): number => {
  const ys = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (ys[1] + 0.05) / (ys[0] + 0.05);
};

describe('Bubble token contrast (a1aeb151) — WCAG AA on --bubble', () => {
  const blocks = parseOklchBlocks(read('app/globals.css'));

  it('globals.css exposes the light/dark × neutral/cool palette blocks', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const selectors = blocks.map((b) => b.selector).join(' | ');
    expect(selectors).toContain(':root');
    expect(selectors).toContain('.dark');
    expect(selectors).toContain('[data-palette="cool"]');
  });

  for (const block of blocks) {
    it(`${block.selector}: --ink and --ink-2 measure ≥4.5:1 on --bubble`, () => {
      const bubble = block.vars['--bubble'];
      for (const token of ['--ink', '--ink-2'] as const) {
        expect(contrast(block.vars[token], bubble)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
