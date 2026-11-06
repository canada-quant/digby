#!/usr/bin/env node
/**
 * render-published-compose.mjs — emit docker-compose.selfhost.published.yml
 * from docker-compose.selfhost.yml (Phase 1 self-host, todo 9caf3230).
 *
 * WHY A GENERATOR AND NOT A HAND-WRITTEN FILE
 *   The self-host stack is defined ONCE, in docker-compose.selfhost.yml: every
 *   service, port, healthcheck, volume, depends_on and environment line. A
 *   second, hand-maintained "published" compose file would drift — the first
 *   service added to the source file would be missing from the published one,
 *   and the failure mode is a stranger's broken install, not a red test.
 *
 *   So this script DERIVES the published file mechanically and a test
 *   (scripts/selfhost/render-published-compose.test.mjs) fails if the committed
 *   output does not match a fresh render. Drift becomes impossible to merge.
 *
 * THE ONLY TRANSFORMATION
 *   Services that `build:` from the source tree get an `image:` instead:
 *
 *     build: { context: ./backend, target: production }  ->  -backend:${TAG}
 *     build: { context: ./backend, target: build }       ->  -backend:${TAG}-build
 *     build: { context: ./frontend, target: production } ->  -frontend:${TAG}
 *     build: { context: ./google-mcp }                   ->  -google-mcp:${TAG}
 *
 *   Everything else — image: services (postgres, redis, caddy, stt, ...),
 *   ports, env, volumes, healthchecks, profiles, containers — is copied
 *   byte-for-byte. The published stack is the SAME stack.
 *
 *   The migrate service needs its own tag because it runs `prisma migrate
 *   deploy` and the production stage is deps-only (no prisma CLI), which is why
 *   publish-images.yml pushes a second `-build` tag.
 *
 * WHY `image:` AND NOT A COMPOSE OVERRIDE FILE
 *   `docker compose -f base.yml -f override.yml` would work, but it makes the
 *   override's merge semantics part of the install contract (which keys append
 *   vs replace, and `!override` tags for ports). A stranger debugging a failed
 *   install should be reading ONE file that says exactly what runs.
 *
 * USAGE
 *   node scripts/selfhost/render-published-compose.mjs           # write the file
 *   node scripts/selfhost/render-published-compose.mjs --check   # exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const SOURCE = path.join(REPO_ROOT, 'docker-compose.selfhost.yml');
export const TARGET = path.join(REPO_ROOT, 'docker-compose.selfhost.published.yml');

/** Registry prefix + tag are compose-time variables so a fork can point at its
 *  own namespace (and an operator can pin a release) without editing the file. */
export const REGISTRY_EXPR = '${DIGBY_IMAGE_REGISTRY:-ghcr.io/canada-quant/digby}';
export const TAG_EXPR = '${DIGBY_IMAGE_TAG:-latest}';

/** Compose build contexts that have a published counterpart, keyed by the
 *  `context:` value exactly as it appears in the source file. */
const CONTEXT_TO_IMAGE = {
  './backend': 'backend',
  './frontend': 'frontend',
  './google-mcp': 'google-mcp',
  './github-mcp': 'github-mcp',
  './x-mcp': 'x-mcp',
  './slack-mcp': 'slack-mcp',
  './asana-mcp': 'asana-mcp',
  './discord-mcp': 'discord-mcp',
  './digby-mcp': 'digby-mcp',
  './mcp-gateway': 'mcp-gateway',
  './browser-service': 'browser-service',
};

const HEADER = `# Digby — self-hosted, single-host, full isolated stack (PRE-BUILT IMAGES).
#
# ██ GENERATED FILE — DO NOT EDIT ██
# Produced by scripts/selfhost/render-published-compose.mjs from
# docker-compose.selfhost.yml. Edit the source file (or that script), never
# this one; scripts/selfhost/render-published-compose.test.mjs fails the build
# if this file and a fresh render disagree.
#
# This is the NO-SOURCE-CLONE install: every service that would build from the
# source tree instead pulls a published image. You do not need the repository.
#
# Quick start (full guide: docs/SELF_HOST.md § Install from published images):
#   curl -fsSLO https://raw.githubusercontent.com/canada-quant/digby/main/scripts/selfhost/install.sh
#   sh install.sh
#
# Or by hand:
#   cp selfhost.env.example .env      # then edit — set at least ONE model key
#   mkdir -p branding
#   docker compose -f docker-compose.selfhost.published.yml pull
#   docker compose -f docker-compose.selfhost.published.yml up -d
#
# Pinning a release (recommended for anything you care about):
#   DIGBY_IMAGE_TAG=1.0.0 docker compose -f docker-compose.selfhost.published.yml up -d
#
# NOTE ON THE FRONTEND: the image is built with a RELATIVE API base (/api), so
# it is correct on http://localhost:8080, on a LAN IP and on a real domain with
# no rebuild. SELFHOST_PUBLIC_URL is still read by the BACKEND (cookie scope,
# links, OAuth redirects) — set it to the URL browsers actually use.
`;

/**
 * Render the published compose from a source string.
 * Pure: no I/O, so the drift test can feed it the real file.
 */
export function render(source) {
  const lines = source.split('\n');
  const out = [];

  let skipping = false;
  let buildIndent = -1;
  let context = null;
  let target = null;

  const flush = () => {
    const key = context ? CONTEXT_TO_IMAGE[context] : null;
    if (!key) {
      throw new Error(
        `build context '${context}' has no published image mapping — add it to ` +
          `CONTEXT_TO_IMAGE in render-published-compose.mjs (and to the matrix in ` +
          `.github/workflows/publish-images.yml)`,
      );
    }
    // The migrate service builds the `build` stage (it needs the prisma CLI);
    // every other backend consumer runs the `production` stage.
    const suffix = target === 'build' ? '-build' : '';
    out.push(`${' '.repeat(buildIndent)}image: ${REGISTRY_EXPR}-${key}:${TAG_EXPR}${suffix}`);
  };

  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;

    if (skipping) {
      // The build block ends at the first non-blank line indented no deeper
      // than `build:` itself.
      if (line.trim() === '' || indent > buildIndent) {
        const m = line.match(/^\s+context:\s*(\S+)\s*$/);
        if (m) context = m[1];
        const t = line.match(/^\s+target:\s*(\S+)\s*$/);
        if (t) target = t[1];
        continue;
      }
      flush();
      skipping = false;
      buildIndent = -1;
      context = null;
      target = null;
      // fall through so this line is emitted normally
    }

    const b = line.match(/^( *)(build):\s*$/);
    if (b) {
      skipping = true;
      buildIndent = b[1].length;
      context = null;
      target = null;
      continue;
    }

    out.push(line);
  }

  // A file ending inside a build block (no trailing newline) would otherwise
  // silently lose the image line — the same unterminated-tail class that once
  // dropped a scrub rule.
  if (skipping) flush();

  return HEADER + '\n' + out.join('\n');
}

export function readSource() {
  return readFileSync(SOURCE, 'utf8');
}

function main() {
  const rendered = render(readSource());
  const check = process.argv.includes('--check');

  if (check) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      console.error(`FAIL  ${path.relative(REPO_ROOT, TARGET)} is missing — run the generator`);
      process.exit(1);
    }
    if (current !== rendered) {
      console.error(
        `FAIL  ${path.relative(REPO_ROOT, TARGET)} is stale — it does not match a fresh ` +
          `render of docker-compose.selfhost.yml.\n` +
          `      Regenerate: node scripts/selfhost/render-published-compose.mjs`,
      );
      process.exit(1);
    }
    console.log('PASS  published compose matches the source compose');
    return;
  }

  writeFileSync(TARGET, rendered);
  const n = rendered.split('\n').filter((l) => /^\s+image:/.test(l)).length;
  console.log(`wrote ${path.relative(REPO_ROOT, TARGET)} (${n} image: refs)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}