#!/usr/bin/env node
/**
 * Palette pairing analysis for the Phase 3 token codemod.
 * For every className string literal in app/** + components/**, extract
 * violet/purple/indigo/green/emerald utilities and report which light class
 * co-occurs with which dark: counterpart (same property) in the SAME string.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app', 'components'];
const FAMILY = process.argv[2] || 'violet|purple|indigo';
const familyRe = new RegExp(`^(${FAMILY})$`);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

// token: (variants:)*prop-family-shade(/opacity)?
const TOKEN_RE = /(?:[a-zA-Z0-9[\]&>_.:-]*:)?(?:text|bg|border(?:-[trblxy])?(?:-[lr])?|ring|fill|stroke|from|to|via|accent|shadow|divide|outline|decoration|placeholder|caret)-(?:violet|purple|indigo|fuchsia|green|emerald)-\d+(?:\/\d+)?/g;

const pairCounts = new Map(); // "prop light->dark" => count + example
const singles = new Map(); // bare tokens with no dark counterpart in same string

function propOf(tok) {
  const m = tok.match(/(text|bg|border(?:-[trblxy])?|ring|fill|stroke|from|to|via|accent|shadow|divide|outline|decoration|placeholder|caret)-(violet|purple|indigo|fuchsia|green|emerald)-\d+(\/\d+)?$/);
  return m ? m[1] : null;
}
function colorOf(tok) {
  const m = tok.match(/(violet|purple|indigo|fuchsia|green|emerald)-\d+(\/\d+)?$/);
  return m ? m[0] : null;
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    // pull string literals ('...', "...", `...`) — good enough for className scanning
    const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = strRe.exec(src))) {
      const s = m[2];
      if (!/(violet|purple|indigo|fuchsia|green|emerald)-\d/.test(s)) continue;
      const toks = s.match(TOKEN_RE) || [];
      const interesting = toks.filter((t) => {
        const c = colorOf(t);
        return c && familyRe.test(c.split('-')[0]);
      });
      if (!interesting.length) continue;
      // group by property, split light vs dark
      const byProp = new Map();
      for (const t of interesting) {
        const p = propOf(t);
        if (!p) continue;
        const isDark = /(^|:)dark:/.test(t) || t.includes('dark:');
        const variants = t.slice(0, t.lastIndexOf(p + '-'));
        const key = p + '|' + variants.replace(/dark:/, '');
        if (!byProp.has(key)) byProp.set(key, { light: [], dark: [] });
        byProp.get(key)[isDark ? 'dark' : 'light'].push(colorOf(t));
      }
      for (const [key, { light, dark }] of byProp) {
        const [p, variants] = key.split('|');
        if (light.length && dark.length) {
          for (let i = 0; i < Math.max(light.length, dark.length); i++) {
            const l = light[Math.min(i, light.length - 1)];
            const d = dark[Math.min(i, dark.length - 1)];
            const k = `${p} ${variants ? '[' + variants + '] ' : ''}${l} -> dark:${d}`;
            const e = pairCounts.get(k) || { n: 0, ex: `${file}` };
            e.n++;
            pairCounts.set(k, e);
          }
        } else {
          for (const l of [...light.map((x) => x), ...dark.map((x) => 'DARKONLY:' + x)]) {
            const k = `${p} ${variants ? '[' + variants + '] ' : ''}${l}`;
            const e = singles.get(k) || { n: 0, ex: `${file}` };
            e.n++;
            singles.set(k, e);
          }
        }
      }
    }
  }
}

const fmt = (map) =>
  [...map.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${String(v.n).padStart(4)}  ${k}   (${v.ex})`)
    .join('\n');

console.log('=== PAIRED (light -> dark on same property in same class string) ===');
console.log(fmt(pairCounts));
console.log('\n=== UNPAIRED (no dark counterpart in same string) ===');
console.log(fmt(singles));
