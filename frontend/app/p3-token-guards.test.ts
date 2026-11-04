/**
 * P3 — design-token guards (UI overhaul Phase 3).
 *
 * Three pins that keep the token system from rotting:
 *   1. app/** may not grow NEW raw violet-* / emerald-* utilities — brand and
 *      success color rides the tokens (text-brand, bg-success-soft, …).
 *      Justified exceptions live in app/p3-palette-allowlist.json.
 *   2. The brand/status tokens exist in globals.css for BOTH themes (light
 *      values on :root, adaptive dark halves in .dark, @theme inline aliases
 *      so the utilities compile), and the brand gradient rides the brand-mark
 *      stop tokens.
 *   3. tailwind.config.* stays deleted — Tailwind v4 never read it (no
 *      @config in globals.css) and its stale hsl() values contradicted the
 *      live oklch tokens; it must not come back as a trap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

// ── 1. no new raw violet/emerald utilities in app/** ────────────────────────
describe('P3.1 — raw violet-*/emerald-* utilities are banned in app/** (allowlist for judged exceptions)', () => {
  it('every raw violet/emerald utility in app/** is covered by p3-palette-allowlist.json', () => {
    const allowlist = JSON.parse(read('app/p3-palette-allowlist.json')) as {
      entries: { file: string; classes: string[] }[];
    };
    const allowed = new Map<string, Set<string>>(
      allowlist.entries.map((e) => [e.file, new Set(e.classes)]),
    );

    const UTIL = /[\w:[\]./-]*\b(?:violet|emerald)-\d+(?:\/\d+)?/g;
    const violations: string[] = [];
    for (const abs of walk(join(FRONTEND_ROOT, 'app'))) {
      const rel = abs.slice(FRONTEND_ROOT.length).replace(/\\/g, '/');
      if (rel.startsWith('app/dev-accordion-harness/')) continue; // dev-only harness
      if (/\.test\.(t|j)sx?$/.test(rel)) continue; // tests pin their own strings
      const src = readFileSync(abs, 'utf8');
      for (const m of src.match(UTIL) ?? []) {
        if (allowed.get(rel)?.has(m)) continue;
        violations.push(`${rel}: ${m}`);
      }
    }
    expect(
      violations,
      `raw violet/emerald utilities found outside the allowlist — use the Phase 3 tokens ` +
        `(text-brand, bg-brand-soft, text-success, …) or add a justified allowlist entry:\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('the allowlist itself stays honest: every listed class still exists in its file', () => {
    const allowlist = JSON.parse(read('app/p3-palette-allowlist.json')) as {
      entries: { file: string; classes: string[] }[];
    };
    for (const e of allowlist.entries) {
      const src = read(e.file);
      for (const cls of e.classes) {
        expect(src, `${e.file} no longer uses allowlisted "${cls}" — prune the entry`).toContain(cls);
      }
    }
  });
});

// ── 2. tokens exist for both themes ──────────────────────────────────────────
describe('P3.2 — brand/status tokens are defined for light AND dark', () => {
  const GLOBALS = read('app/globals.css');
  // First :root block (design tokens) and the .dark block.
  const rootBlock = GLOBALS.slice(GLOBALS.indexOf(':root {'), GLOBALS.indexOf('.dark {'));
  const darkStart = GLOBALS.indexOf('.dark {');
  const darkBlock = GLOBALS.slice(darkStart, GLOBALS.indexOf('\n}', darkStart));

  it('light halves live on :root', () => {
    for (const v of [
      '--brand:', '--brand-hover:', '--brand-accent:', '--brand-ring:',
      '--brand-foreground:', '--brand-text:', '--brand-soft:', '--brand-muted:',
      '--brand-faint:', '--brand-border:',
      '--success:', '--success-strong:', '--success-accent:', '--success-ring:',
      '--success-soft:', '--success-muted:', '--success-faint:', '--success-border:',
      '--warning:', '--info:',
    ]) {
      expect(rootBlock, `missing ${v} in :root`).toContain(v);
    }
  });

  it('Digby Frontier sweep (2026-10-06): the legacy brand/status tokens follow the neutral Frontier tokens — no .dark copies', () => {
    // They are re-pointed in :root at --send / --ink / --line / --ok / --warn-ink,
    // which carry their own .dark values — a .dark copy would pin the old violet/green.
    for (const v of ['--brand-text:', '--brand-soft:', '--success:', '--success-soft:', '--warning:', '--info:']) {
      expect(darkBlock, `stale ${v} in .dark`).not.toContain(v);
    }
    expect(rootBlock).toContain('--brand: var(--send);');
    expect(rootBlock).toContain('--success: var(--ok);');
    expect(rootBlock).toContain('--warning: var(--warn-ink);');
    expect(darkBlock).toContain('--warn-ink:');
  });

  it('@theme inline exposes the utilities (text-brand, bg-success-soft, …)', () => {
    for (const v of [
      '--color-brand: var(--brand);',
      '--color-brand-text: var(--brand-text);',
      '--color-brand-soft: var(--brand-soft);',
      '--color-success: var(--success);',
      '--color-success-accent: var(--success-accent);',
      '--color-warning: var(--warning);',
      '--color-info: var(--info);',
      '--color-destructive: var(--destructive);',
    ]) {
      expect(GLOBALS, `missing "${v}" in @theme inline`).toContain(v);
    }
  });

  it('the Digby gradient rides the brand-mark stop tokens (no re-inlined hexes)', () => {
    expect(GLOBALS).toContain('--color-brand-red: #E52128;');
    expect(GLOBALS).toContain('--color-brand-yellow: #F9D015;');
    expect(GLOBALS).toContain('--color-brand-green: #00A550;');
    expect(GLOBALS).toContain('--color-brand-blue: #0093D7;');
    expect(GLOBALS).toMatch(
      /--brand-gradient-stops:\s*var\(--color-brand-red\),\s*var\(--color-brand-yellow\),\s*\n?\s*var\(--color-brand-green\),\s*var\(--color-brand-blue\);/,
    );
  });
});

// ── 3. the dead config stays dead ────────────────────────────────────────────
describe('P3.3 — tailwind.config.* stays deleted (v4 reads @theme in globals.css)', () => {
  it('no tailwind.config file exists in frontend/', () => {
    for (const name of ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
      expect(existsSync(join(FRONTEND_ROOT, name)), `${name} must not exist`).toBe(false);
    }
  });

  it('globals.css does not opt back into a config via @config', () => {
    expect(read('app/globals.css')).not.toContain('@config');
  });
});
