#!/usr/bin/env node
/**
 * Phase 3 palette codemod — raw violet/green/emerald utilities → design tokens.
 *
 * Every rule is IDENTITY-TRUE for violet/green: the replacing token resolves to
 * the exact same color the raw utility resolved to, in light AND dark (adaptive
 * tokens collapse `X dark:Y` pairs whose values the token carries per theme).
 * The ONE deliberate exception: emerald→success unifies the green-vs-emerald
 * split for the same "success/ready" semantic onto the green ramp (small hue
 * shift at equal lightness) — ordered by the Phase 3 spec.
 *
 * Repeatable: node scripts/codemods/palette-tokens.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');

// ── Scope ───────────────────────────────────────────────────────────────────
const ROOTS = ['app', 'components/ui/custom'];
const EXCLUDE = [
  'app/dev-accordion-harness', // dev-only harness, explicitly out of scope
  'app/crossmodel/components/canvas-meta.ts', // categorical type palette (doc=blue, code=emerald, html=orange, mermaid=violet) — NOT brand/success semantics
  'scripts/', // this script + analysis tooling
];
// Test files pin exact source strings; they are updated by hand in lockstep.
const EXCLUDE_TESTS = /\.test\.(t|j)sx?$/;

// ── Rules (ordered: pair collapses BEFORE shade-constant singles) ───────────
// [pattern, replacement, note]
const RULES = [
  // ── violet pair collapses → adaptive tokens ──
  ['text-violet-600 dark:text-violet-400', 'text-brand-text'],
  ['hover:text-violet-600 dark:hover:text-violet-400', 'hover:text-brand-text'],
  ['bg-violet-50 dark:bg-violet-900/20', 'bg-brand-soft'],
  ['bg-violet-100 dark:bg-violet-900/30', 'bg-brand-muted'],
  ['bg-violet-50/50 dark:bg-violet-900/10', 'bg-brand-faint'],
  ['border-violet-200 dark:border-violet-800', 'border-brand-border'],

  // ── green pair collapses → adaptive success tokens ──
  ['text-green-600 dark:text-green-400', 'text-success'],
  ['text-green-700 dark:text-green-400', 'text-success-strong'],
  ['border-green-200 dark:border-green-800', 'border-success-border'],
  ['bg-green-100 dark:bg-green-900/30', 'bg-success-muted'],
  ['bg-green-50/40 dark:bg-green-900/10', 'bg-success-faint'],
  ['hover:bg-green-50 dark:hover:bg-green-900/20', 'hover:bg-success-soft'],

  // ── emerald → success (the deliberate hue unification) ──
  ['text-emerald-600 dark:text-emerald-400', 'text-success'],
  ['bg-emerald-50 dark:bg-emerald-900/20', 'bg-success-soft'],
  ['border-emerald-200 dark:border-emerald-800', 'border-success-border'],

  // ── shade-constant singles: violet-N → brand tier of identical value.
  //    Variant prefixes (hover:, dark:, focus:, nav:, …) and opacity
  //    modifiers (/60) survive untouched, so rendering is unchanged.
  [/violet-600(?![\w.])/g, 'REWRITE:brand'],
  [/violet-700(?![\w.])/g, 'REWRITE:brand-hover'],
  [/violet-500(?![\w.])/g, 'REWRITE:brand-accent'],
  [/violet-400(?![\w.])/g, 'REWRITE:brand-ring'],

  // emerald singles → success tiers (hue unification, equal shade level)
  [/emerald-600(?![\w.])/g, 'REWRITE:success'],
  [/emerald-500(?![\w.])/g, 'REWRITE:success-accent'],
  [/emerald-400(?![\w.])/g, 'REWRITE:success-ring'],

  // green-500 singles: status dots/icons — semantic success everywhere it
  // appears in app code (verified per-site; chart-y greens use other shades)
  // EXCEPTION hand-reverted after the run: the news LOCAL category accent in
  // page.tsx is categorical (local=green/us=blue), not success — kept raw.
  [/green-500(?![\w.])/g, 'REWRITE:success-accent'],

  // ── second tier: shade-true constants + dark-half compositions for the
  //    non-adjacent pairs the string rules above can't see. Each rule is
  //    value-identical; the adaptive ones (violet-50/100/200 → soft/muted/
  //    border) are safe because EVERY remaining site carries its own dark:
  //    override in the same class string (verified 2026-09-07), so the
  //    token's dark half never surfaces.
  ['dark:border-violet-800/40', 'dark:border-brand-border/40'],
  ['dark:border-violet-800', 'dark:border-brand-border'],
  [/violet-300(?![\w.])/g, 'REWRITE:brand-pale'],
  [/violet-900(?![\w.])/g, 'REWRITE:brand-dim'],
  [/violet-950(?![\w.])/g, 'REWRITE:brand-deep'],
  [/violet-200(?![\w.])/g, 'REWRITE:brand-border'],
  [/violet-100(?![\w.])/g, 'REWRITE:brand-muted'],
  // violet-50 → brand-soft: ChatComposer's bare bg-violet-50/10 drag halo has
  // NO dark override (theme-agnostic 10% haze) — allowlisted, skipped here.
  [/violet-50(?![\w.])/g, 'REWRITE:brand-soft', { skip: ['app/crossmodel/components/ChatComposer.tsx'] }],

  // ── non-adjacent green success pairs (VERIFIED 2026-09-07: every remaining
  //    `text-green-700`, `bg-green-100`, `dark:text-green-400` and
  //    `dark:bg-green-900/30` line carries its counterpart on the SAME line,
  //    so collapsing to the adaptive token + deleting the now-covered dark
  //    half is value-identical in both themes). Deliberately NOT converted:
  //    the IntegrationsTab `border-green-200 dark:border-green-700` pair and
  //    `border-green-300`/`text-green-600`/solid green button shades — no
  //    matching tier (converting would change a rendered value).
  ['bg-green-50/60 dark:bg-green-900/20', 'bg-success-soft/60 dark:bg-success-soft'],
  [' dark:text-green-400', ''],
  ['text-green-700', 'text-success-strong'],
  [' dark:bg-green-900/30', ''],
  ['bg-green-100', 'bg-success-muted'],
];

// Utility-property prefixes a color shade can legally hang off — the REWRITE
// rules only fire inside one of these utilities, never in prose/emoji/strings.
const PROP = '(?:text|bg|border(?:-[trblxy])?|ring|fill|stroke|from|to|via|accent|shadow|divide|outline|decoration|placeholder|caret)';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

const stats = new Map();
const bump = (k, n = 1) => stats.set(k, (stats.get(k) || 0) + n);

let files = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (EXCLUDE.some((e) => file.startsWith(e) || file === e)) continue;
    if (EXCLUDE_TESTS.test(file)) continue;
    const before = readFileSync(file, 'utf8');
    // Line-based so a `palette-keep` marker on a line (or the line above it)
    // pins deliberate raw-palette exceptions (e.g. categorical accents).
    const lines = before.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('palette-keep')) continue;
      if (i > 0 && lines[i - 1].includes('palette-keep')) continue;
      for (const [pat, rep, opts] of RULES) {
        if (opts?.skip?.some((s) => file.endsWith(s) || file === s)) continue;
        if (typeof pat === 'string') {
          const n = lines[i].split(pat).length - 1;
          if (n) {
            lines[i] = lines[i].split(pat).join(rep);
            bump(`${pat} -> ${rep}`, n);
          }
        } else {
          // shade rewrite: only when preceded by a real utility property prefix
          const tier = rep.slice('REWRITE:'.length);
          const shadeRe = new RegExp(`(${PROP}-)${pat.source}`, 'g');
          lines[i] = lines[i].replace(shadeRe, (m, propPrefix) => {
            bump(`${pat.source.replace('(?![\\w.])', '')} -> ${tier}`);
            return `${propPrefix}${tier}`;
          });
        }
      }
    }
    const src = lines.join('\n');
    if (src !== before) {
      files++;
      if (!DRY) writeFileSync(file, src);
    }
  }
}

console.log(`${DRY ? '[dry] ' : ''}files changed: ${files}`);
for (const [k, v] of [...stats.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(v).padStart(4), ' ', k);
}
