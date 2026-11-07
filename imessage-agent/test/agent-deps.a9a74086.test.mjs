/**
 * Ticket a9a74086 — "tried to run the command Digby gave me" (owner-filed,
 * Mac mini, 2026-10-13): the one-line installer died building better-sqlite3
 * under Homebrew Node v26.0.0 —
 *   npm error prebuild-install warn install No prebuilt binaries found
 *     (target=26.0.0 runtime=node arch=arm64 …)
 *   npm error   CXX(target) Release/obj.target/better_sqlite3/src/better_sqlite3.o
 *   npm error code 1
 *
 * Root cause: better-sqlite3 11.10.0 (the pre-0.8.2 pin) ships darwin
 * prebuilds only for Node ABIs 108/115/127/131 (Node 18/20/22/23) — Node
 * 24/25/26 have NO prebuild, so npm falls to node-gyp, and 11.x's C++ uses
 * V8 APIs Node 26 removed (v8::Object::GetPrototype → GetPrototypeV2,
 * v8::Context::GetIsolate, v8::PropertyCallbackInfo::This — upstream PR
 * WiseLibs/better-sqlite3#1469), so the compile dies mid-CXX. The bootstrap
 * itself makes this likely on a fresh Mac: `brew install node` installs
 * current Node = 26.
 *
 * The fix, pinned here:
 *   • better-sqlite3 EXACT-PINNED to 12.11.1 (engines 20.x||22.x||23.x||
 *     24.x||25.x||26.x; darwin prebuilds for ABI 127/137/141/147 =
 *     Node 22/24/25/26 — confirmed for darwin-arm64 AND darwin-x64). The pin
 *     is EXACT, not ^: a native-dep version change refuses the self-update
 *     swap (ticket 0e4c9601's carry rule), so a caret that silently drifted
 *     to 12.12.x on a future lockfile regen would strand the fleet on a
 *     mismatched tarball.
 *   • engines floor raised 18 → 20 (Node 18 is EOL and has no 12.x prebuild
 *     either); install.sh + the served installer preflight the Node major
 *     and fail fast with the fix instead of a node-gyp wall.
 *
 * House idiom: SOURCE-BYTES pins (permissions.2f646c10 /
 * browser-cdp-attach.4258335e) — the install path runs only on macOS, but
 * its source ships in the tarball and must stay correct on every platform.
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const read = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const installSh = read('install.sh');

test('a9a74086: better-sqlite3 is exact-pinned to 12.11.1 (Node 20–26 prebuilds)', () => {
  // EXACT pin, never ^ — a drift to 12.12.x would change the native dep and
  // refuse the self-update swap (0e4c9601 carry rule) on every Mac.
  assert.equal(pkg.dependencies['better-sqlite3'], '12.11.1');
  assert.equal(lock.packages['node_modules/better-sqlite3'].version, '12.11.1');
});

test('a9a74086: the engines floor is Node 20 (18 is EOL and cannot install 12.x)', () => {
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(lock.packages[''].engines.node, '>=20');
});

test('a9a74086: install.sh preflights the Node major and fails fast under 20', () => {
  // The preflight extracts the major and hard-fails below 20 with the fix in
  // hand — no node-gyp wall further down (the ticket's second screen).
  assert.match(installSh, /NODE_MAJOR="\$\(node -v \| sed 's\/\^v\/\/' \| cut -d\. -f1\)"/);
  assert.match(installSh, /\[\[ "\$NODE_MAJOR" -lt 20 \]\]/);
  assert.match(installSh, /Node\.js 20 or newer is required/);
  assert.match(installSh, /brew upgrade node/);
  // Node 26 itself must PASS the gate (the ticket's exact Mac) — the check is
  // a floor, not a ceiling.
  assert.doesNotMatch(installSh, /NODE_MAJOR" -gt /);
});

test('a9a74086: an npm install failure explains itself instead of a bare node-gyp wall', () => {
  // The ticket's terminal dump: 40 lines of node-gyp and "npm error code 1"
  // with no hint of what to do. The build step now wraps npm install and
  // prints the two Mac causes (CLT missing / wrong Node major).
  assert.match(installSh, /if ! npm install; then/);
  assert.match(installSh, /Installing dependencies failed/);
  assert.match(installSh, /xcode-select --install/);
  assert.match(installSh, /brew upgrade node/);
});

test('a9a74086: the served bootstrap installer (frontend/public) carries the same preflight', () => {
  // The one-line command the web card shows pipes THIS file from digby.ai;
  // an old Node must be stopped before the download+build too. (The four
  // --update-only strings the frontend test pins are untouched by this.)
  const bootstrap = readFileSync(
    join(pkgRoot, '..', 'frontend', 'public', 'install-digby-agent.sh'),
    'utf8',
  );
  assert.match(bootstrap, /NODE_MAJOR="\$\(node -v \| sed 's\/\^v\/\/' \| cut -d\. -f1\)"/);
  assert.match(bootstrap, /\[\[ "\$NODE_MAJOR" -lt 20 \]\]/);
  assert.match(bootstrap, /Node\.js 20 or newer is required/);
});

test('a9a74086: the bump is stamped — tree current (installer-duality release line)', () => {
  assert.equal(pkg.version, '0.9.24');
  assert.match(read('src/config.ts'), /AGENT_VERSION = '0\.9\.24'/);
  assert.match(read('src/config.ts'), /a9a74086/);
  assert.match(read('src/config.ts'), /8bcd1c4a/);
});

test('e530220e: package-lock.json names the SAME version as package.json (the lock ships inside the tarball)', () => {
  // THE DEFECT THIS PINS. 0.9.22 was published with a package-lock.json still
  // stamping 0.9.21: only package.json was bumped, and until e530220e the
  // publish script verified package.json ALONE. The lock is staged into the
  // tarball (scripts/publish-agent-tarball.sh), so the released artifact
  // misstated its own version in two fields — the one artifact a device
  // downloads and a human reads to answer "what is this?". Caught by
  // adversarial review, not by CI, which is exactly why it is pinned here.
  //
  // BOTH fields, because npm writes the version twice: the lock's root
  // `version` and `packages[""].version`. A bump that updates one and not the
  // other is the same lie in a smaller font.
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // And config.ts AGENT_VERSION is the third leg of the same lockstep —
  // publish-agent-tarball.sh refuses to ship when they disagree.
  assert.match(read('src/config.ts'), new RegExp(`AGENT_VERSION = '${pkg.version.replace(/\./g, '\\.')}'`));
});
