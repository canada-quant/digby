#!/usr/bin/env node
/**
 * render-public-workflows.mjs — emit the public variants of the nightly
 * quality workflows (Phase 1 self-host, todo 9caf3230).
 *
 * THE DEFECT THIS FIXES
 *   Two workflows that ship to the public repo guard their job with
 *   `if: vars.X_DISABLED != '1'`. That expression is TRUE when the variable is
 *   UNSET — which is exactly the state of the public repo, which by owner
 *   ruling (2026-11-05T18:07Z) carries ZERO production credentials (0 secrets,
 *   0 vars). So an unprovisioned public repo FIRES these jobs and fails them,
 *   nightly, forever:
 *
 *     trajectory-evals.yml    6 secrets  (model API keys for the eval run)
 *     nightly-query-suite.yml 2 vars     (model endpoints for the query suite)
 *
 *   C2's own doctrine: "a workflow that only fails nightly is worse than one
 *   that is absent."
 *
 * THE FIX: OPT-IN, NOT OPT-OUT
 *   The public variant flips the guard to `if: vars.X_ENABLED == '1'`, FALSE
 *   when unset. Same workflow, same steps, same evidence on a repo that
 *   deliberately provisions the credential; inert on one that has not. Nothing
 *   is deleted, and the PRIVATE tree keeps its opt-out behaviour, where the
 *   secrets DO exist and the job should run by default.
 *
 * NOT INCLUDED, DELIBERATELY: windows.yml
 *   C2 also flags windows.yml (6 Azure signing secrets), but that one is a
 *   FALSE POSITIVE and rewriting it would be wrong. Its secrets are only
 *   `env:`-injected into a resolve step that folds them into a `signing`
 *   boolean; every sign step is gated `if: ... signing == 'true'`, so on a
 *   zero-secret repo it builds UNSIGNED and passes with a skip notice (the
 *   workflow header says exactly this). It has no `*_DISABLED` opt-out guard to
 *   flip. scan-public-tree.sh C2 distinguishes the two cases structurally:
 *   a credential that appears ONLY as an `env:`/`with:` value cannot fire a
 *   run by itself, whereas an opt-out guard fires precisely when unset.
 *
 * WHY GENERATED
 *   A hand-maintained public copy of a 300-line workflow drifts the moment the
 *   private one changes, and the drift is invisible here and loud for whoever
 *   provisions the credential. This script derives each variant from its
 *   private source by ONE textual transformation, and
 *   backend/scripts/selfhost/render-published-compose.test.ts fails the build
 *   if a committed variant and a fresh render disagree.
 *
 * USAGE
 *   node scripts/selfhost/render-public-workflows.mjs           # write variants
 *   node scripts/selfhost/render-public-workflows.mjs --check   # exit 1 on drift
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** private workflow name -> the variable whose guard polarity flips. */
export const VARIANTS = [
  { name: 'trajectory-evals', variable: 'TRAJECTORY_EVALS' },
  { name: 'nightly-query-suite', variable: 'NIGHTLY_QUERY_SUITE' },
];

export const publicPath = (name) => path.join(REPO_ROOT, '.digby', 'publish', `${name}.public.yml`);

/**
 * Rewrite `<VAR>_DISABLED != '1'` (opt-out, TRUE when unset) into
 * `<VAR>_ENABLED == '1'` (opt-in, FALSE when unset).
 *
 * Both spellings appear in this repo — `${{ vars.X_DISABLED != '1' }}` and a
 * bare `vars.X_DISABLED != '1'` — and the raw-text substitution covers both.
 */
export function render(source, variable) {
  const from = `${variable}_DISABLED != '1'`;
  const to = `${variable}_ENABLED == '1'`;

  if (!source.includes(from)) {
    throw new Error(
      `guard '${from}' not found — the private workflow changed shape. Update ` +
        `scripts/selfhost/render-public-workflows.mjs rather than editing the variant.`,
    );
  }

  const banner =
    `# ██ GENERATED PUBLIC VARIANT — DO NOT EDIT ██\n` +
    `# Derived from .github/workflows/${variable.toLowerCase()}.yml by\n` +
    `# scripts/selfhost/render-public-workflows.mjs.\n` +
    `#\n` +
    `# ONE change from the private workflow: the job guard is OPT-IN\n` +
    `#   if: vars.${variable}_ENABLED == '1'      (FALSE when unset)\n` +
    `# instead of opt-out\n` +
    `#   if: vars.${variable}_DISABLED != '1'     (TRUE when unset)\n` +
    `#\n` +
    `# Why: this repo carries ZERO production credentials by owner ruling, so\n` +
    `# the opt-out form fired these jobs nightly and failed them. To run this\n` +
    `# workflow on your own fork, provision the credential AND set\n` +
    `#   vars.${variable}_ENABLED = 1\n`;

  return banner + source.replaceAll(from, to);
}

function main() {
  const check = process.argv.includes('--check');
  let failed = 0;

  for (const { name, variable } of VARIANTS) {
    const src = path.join(REPO_ROOT, '.github', 'workflows', `${name}.yml`);
    if (!existsSync(src)) {
      console.error(`MISSING  ${path.relative(REPO_ROOT, src)}`);
      failed++;
      continue;
    }
    const rendered = render(readFileSync(src, 'utf8'), variable);
    const dest = publicPath(name);

    if (check) {
      const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
      if (current !== rendered) {
        console.error(`FAIL  ${path.relative(REPO_ROOT, dest)} is stale — regenerate`);
        failed++;
      } else {
        console.log(`PASS  ${name}.public.yml matches its private source`);
      }
      continue;
    }

    writeFileSync(dest, rendered);
    console.log(`wrote ${path.relative(REPO_ROOT, dest)}`);
  }

  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}