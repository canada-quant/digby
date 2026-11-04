#!/usr/bin/env node
/**
 * Phase 3 icon-scale codemod — adjacent equal `h-N w-N` (or `w-N h-N`) pairs
 * in app/** become the equivalent `size-N` utility (Tailwind size-* === h+w,
 * so this is purely mechanical and pixel-identical).
 *
 * Convention (documented in globals.css): size-4 = default icon,
 * size-3.5 = compact, size-3 = micro. Vendor components/ui are untouched.
 *
 * Variant-prefixed halves (`sm:h-4 sm:w-4`) are deliberately skipped — the
 * lookbehind refuses a `:`/`-`/word char before the pair, so only bare
 * utility pairs convert. Repeatable: node scripts/codemods/icon-size.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const ROOTS = ['app'];
const EXCLUDE = ['app/dev-accordion-harness'];
const EXCLUDE_TESTS = /\.test\.(t|j)sx?$/; // pins updated by hand in lockstep

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

const PAIR_HW = /(?<![\w:.[-])h-(\d+(?:\.\d+)?) w-(\d+(?:\.\d+)?)(?![\w.-])/g;
const PAIR_WH = /(?<![\w:.[-])w-(\d+(?:\.\d+)?) h-(\d+(?:\.\d+)?)(?![\w.-])/g;

const stats = new Map();
const bump = (k) => stats.set(k, (stats.get(k) || 0) + 1);

let files = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (EXCLUDE.some((e) => file.startsWith(e))) continue;
    if (EXCLUDE_TESTS.test(file)) continue;
    let src = readFileSync(file, 'utf8');
    const before = src;
    for (const re of [PAIR_HW, PAIR_WH]) {
      src = src.replace(re, (m, a, b) => {
        if (a !== b) return m; // h-4 w-5 is a real rectangle — leave it
        bump(`size-${a}`);
        return `size-${a}`;
      });
    }
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
