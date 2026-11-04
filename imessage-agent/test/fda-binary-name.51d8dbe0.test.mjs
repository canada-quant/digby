/**
 * Digby-named runtime (ticket 51d8dbe0, 2026-10-16) — "after updating
 * digbyhelper via command line it is called 'node'".
 *
 * LIVE MISHAP REPLAYD (the ticket's transcript): the CLI installer's launchd
 * service runs the SHARED Homebrew node (`sed "s|__NODE__|$NODE_BIN|"`), so
 * the Full Disk Access step reveals and names a file literally called
 * 'node' — TCC lists the executable's NAME, the entry reads like a system
 * component, and the grant hands EVERY node process on the Mac Full Disk
 * Access. The .app bundle had already solved this by shipping its Node
 * runtime as "DigbyHelper" (macos-app/build-app.sh: "reads far better than
 * 'node'"); the CLI path never got the rename.
 *
 * FIX: install.sh copies the resolved node interpreter to
 * ~/Library/Application Support/Digby/bin/DigbyAgent — a STABLE path OUTSIDE
 * the self-update swap tree (mv agentRoot → agentRoot.bak would orphan a
 * binary inside it; each tarball download stages a fresh agent-<n>/ dir, so
 * <tree>-sibling paths are not stable either) — points the plist at it,
 * reveals + names DigbyAgent in the FDA step, and records the ORIGINAL node
 * path in .node-origin BESIDE the copy (the copy's own dir has no
 * npm-cli.js, and the origin's dir must head the PATH during a self-update
 * build). The FDA step now probes the grant through the new binary first
 * (fda-check) and says one line when it is already granted.
 *
 * Layers, the 4e75cdea house idiom:
 *   1. REAL unit tests of the pure pieces in dist/ (nodeOriginPath reads the
 *      marker beside the binary; npmCliPath falls back to the origin's dir;
 *      helperDisplayName names the real executable).
 *   2. SOURCE-BYTES pins on the macOS wiring that cannot run on Linux CI
 *      (install.sh's copy/reveal/probe, the plist template substitution, the
 *      self-update build PATH).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const installSh = SRC('install.sh');
const plistTemplate = SRC('launchd/com.digby.agent.plist.template');
const selfUpdateSrc = SRC('src/self-update.ts');
const permissionsSrc = SRC('src/permissions.ts');
const indexSrc = SRC('src/index.ts');
const pkgJson = JSON.parse(SRC('package.json'));

// Pure pieces from the BUILT tree (npm test runs `npm run build` first).
const selfUpdateDist = await import(join(pkgRoot, 'dist', 'self-update.js'));
const { nodeOriginPath, npmCliPath } = selfUpdateDist;
const { helperDisplayName: helperName } = await import(join(pkgRoot, 'dist', 'permissions.js'));

// ── 1. install.sh wiring (source-bytes — the macOS-only surface) ─────────────

test('51d8dbe0: install.sh copies the node runtime to a Digby-named, STABLE-path binary', () => {
  assert.match(installSh, /DIGBY_RUNTIME_DIR="\$HOME\/Library\/Application Support\/Digby\/bin"/,
    'the runtime dir is the Application Support root (STABLE — the self-update swaps the agent tree, and tarball downloads stage agent-<n>/ siblings, so neither the tree nor its sibling dir can hold the binary)');
  assert.match(installSh, /DIGBY_AGENT_BIN="\$DIGBY_RUNTIME_DIR\/DigbyAgent"/, 'the binary is named DigbyAgent (TCC lists the executable name)');
  // 21c68e74: the runtime source may now be the OFFICIAL self-contained
  // build (RUNTIME_SRC) when the resolved node is a keg-coupled Homebrew
  // copy — still a COPY of a real node binary at the stable path, never the
  // shared Homebrew binary the service would run in-place.
  assert.match(installSh, /cp -f "\$RUNTIME_SRC" "\$DIGBY_AGENT_BIN"/, 'it is a COPY of the resolved node (or the official self-contained build of it, 21c68e74), not the shared Homebrew binary');
  assert.match(installSh, /RUNTIME_SRC="\$NODE_BIN"/, 'the plain-node case is still the resolved interpreter');
  assert.match(installSh, /chmod 755 "\$DIGBY_AGENT_BIN"/, 'the copy is executable');
});

test('51d8dbe0: the plist runs the DigbyAgent binary, not the shared node', () => {
  assert.match(installSh, /sed -e "s\|__NODE__\|\$DIGBY_AGENT_BIN\|g"/,
    'the __NODE__ placeholder is substituted with $DIGBY_AGENT_BIN (was $NODE_BIN — the shared Homebrew node)');
});

test('51d8dbe0: the FDA step reveals and NAMES DigbyAgent — never the bare node binary', () => {
  assert.doesNotMatch(installSh, /open -R "\$NODE_BIN"/, 'the Finder reveal must not target the shared node binary');
  assert.match(installSh, /open -R "\$DIGBY_AGENT_BIN"/, 'the Finder reveal targets the DigbyAgent copy');
  assert.match(installSh, /a file called 'DigbyAgent' \(highlighted\)/, 'the instructions name DigbyAgent');
  assert.doesNotMatch(installSh, /a file called 'node'/, "the instructions never name a file called 'node' (the ticket's exact complaint)");
});

test('51d8dbe0: the FDA step PROBES first — an already-granted Mac skips the dance', () => {
  assert.match(installSh, /fda-check/, 'install.sh runs the fda-check probe under the new binary');
  assert.match(installSh, /Full Disk Access is already granted to DigbyAgent/, 'the granted branch says so in one line');
  assert.match(indexSrc, /case 'fda-check':/, 'the agent ships the fda-check subcommand');
  assert.match(indexSrc, /FDA_OK/, 'fda-check prints the machine-readable verdict');
});

test('51d8dbe0: install.sh records the ORIGIN node beside the copy', () => {
  assert.match(installSh, /printf '%s\\n' "\$NODE_BIN" > "\$DIGBY_RUNTIME_DIR\/\.node-origin"/,
    'the origin marker is written BESIDE the binary (outside every agent tree — swaps never move it)');
});

// ── 2. Agent-side pure pieces (real units against dist/) ────────────────────

test('51d8dbe0: nodeOriginPath reads .node-origin beside the binary', () => {
  const base = mkdtempSync(join(tmpdir(), 'digby-51d8dbe0-'));
  try {
    // Simulate the DigbyAgent layout: <bin>/DigbyAgent + <bin>/.node-origin
    // naming the ORIGINAL Homebrew/nvm node.
    const binDir = join(base, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, '.node-origin'), '/opt/homebrew/bin/node\n');
    assert.equal(nodeOriginPath?.(join(binDir, 'DigbyAgent')), '/opt/homebrew/bin/node',
      'running as the DigbyAgent copy → the origin marker names the real node');
    // No marker beside the binary (dev checkout / DigbyHelper) → null.
    assert.equal(nodeOriginPath?.(join(base, 'plain-node')), null);
    // A marker naming ITSELF (self-reference) → null, not a self-candidate.
    writeFileSync(join(binDir, '.node-origin'), join(binDir, 'DigbyAgent'));
    assert.equal(nodeOriginPath?.(join(binDir, 'DigbyAgent')), null,
      'a marker naming the binary itself is ignored (no self-origin)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('51d8dbe0: npmCliPath falls back to the ORIGIN node dir (the copy dir has no npm-cli.js)', () => {
  const base = mkdtempSync(join(tmpdir(), 'digby-51d8dbe0-npm-'));
  try {
    // DigbyAgent copy dir: NO npm-cli.js beside it; the ORIGIN dir has one.
    const binDir = join(base, 'Digby', 'bin');
    const originDir = join(base, 'opt', 'homebrew', 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(originDir, { recursive: true });
    writeFileSync(join(binDir, '.node-origin'), join(originDir, 'node'));
    writeFileSync(join(originDir, 'npm-cli.js'), '#!/usr/bin/env node\n');
    assert.equal(npmCliPath?.(join(binDir, 'DigbyAgent')), join(originDir, 'npm-cli.js'),
      'the npm-cli.js is found beside the ORIGIN node, not beside the copy');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('51d8dbe0: the self-update build PATH heads with the ORIGIN node dir', () => {
  assert.match(selfUpdateSrc, /originNode \? `\$\{dirname\(originNode\)\}:`/, 'an nvm-installed origin stays visible to the staged npm ci/build');
});

// ── 3. User-facing copy names the REAL binary everywhere ────────────────────

test('51d8dbe0: onboarding + computer-use guidance name the actual executable, not a hardcoded DigbyHelper', () => {
  assert.match(permissionsSrc, /helperDisplayName/, 'permissions.ts derives the name from process.execPath');
  assert.match(permissionsSrc, /\$\{helper\}/, 'onboardingMessage interpolates the real name');
  assert.doesNotMatch(permissionsSrc, /add the "DigbyHelper" file/, 'no hardcoded DigbyHelper in the FDA line (a CLI install reveals DigbyAgent)');
  assert.match(permissionsSrc, /"DigbyAgent" on a CLI\/tarball install/, 'the doc comment names the CLI binary');
  assert.doesNotMatch(SRC('src/computer.ts'), /file called "DigbyHelper"/, 'computer-use guidance names the real binary too');
  assert.ok(helperName, 'helperDisplayName is exported and importable from dist/permissions.js');
});

test('51d8dbe0: version lockstep — this tree is 0.9.1 (the Digby-named runtime release)', () => {
  assert.match(SRC('src/config.ts'), /AGENT_VERSION = '0\.9\.19'/, 'config.ts AGENT_VERSION must be 0.9.19');
  assert.equal(pkgJson.version, '0.9.19', 'package.json version must match AGENT_VERSION');
  assert.match(SRC('src/config.ts'), /51d8dbe0/, 'the release note cites the ticket');
});
