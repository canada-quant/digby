/**
 * Ticket 405927c9 — "why arent we just bundling the macosapp and digy agent
 * always and updating the entire imstaller? also the new .pkg doesnt have
 * Digby in the name or anything or logo its very sketchy llooking and just
 * called Installer installed '' and still i cant figure out how to remove
 * old digby helper and i ran command now i have 2 digbyhelper and one
 * digbyagrent and still says i have old 0.63 version very confusing poor
 * user experience . streamline it"
 *
 * Four user-visible defects, four fix surfaces, pinned here:
 *
 *  1. THE NAMELESS .PKG ("Installer installed ''", "very sketchy looking"):
 *     build-pkg.sh used `productbuild --package <component>` alone, which
 *     produces a distribution with NO title. Fix: a distribution XML whose
 *     <title> names "Digby iMessage Agent" (Installer.app's title bar and
 *     System Settings → Installation history both read it).
 *
 *  2. THE LYING VERSION ("still says i have old 0.63"): the .pkg version was
 *     a hardcoded default 0.1.0 while the agent inside was 0.9.1, and the
 *     served .pkg froze agent 0.1.0 from June 2026 — a .pkg install never
 *     self-updates, and it polls beside a self-managed agent with the SAME
 *     token, so the Mac's stored agentVersion flaps to the stale value
 *     forever. Fixes: the .pkg version now comes from the agent source; the
 *     .pkg build REFUSES an agent older than the release manifest; and the
 *     self-managed agent (0.9.2) retires a .pkg install's LaunchAgent (by
 *     plist content — the /Library/Digby/ prefix covers both postinstall
 *     generations), with the payload left inert (removal needs sudo and is
 *     printed in the installer's output).
 *
 *  3. THE DUPLICATES ("2 digbyhelper and one digbyagent"): the desktop app's
 *     one-click setup unconditionally overwrote the bundled-helper plist,
 *     clobbering a newer self-managed agent with the DMG-frozen one. Fix:
 *     main.swift refuses to install the bundled helper when a self-managed
 *     agent (com.digby.agent.plist) exists; and the fresh .pkg's postinstall
 *     yields to a self-managed install instead of starting beside it.
 *
 *  4. THE STREAMLINED FLOW: install.sh now retires BOTH never-updating
 *     shapes (app-bundled + .pkg), tells the user exactly what was retired
 *     and how to drop the inert /Library/Digby payload, and the .pkg build
 *     stamps the real agent version so "what version is this?" has one
 *     answer everywhere.
 *
 * Pins follow the repo idiom (agent-app-connection.933e6ca4.test.mjs):
 * compiled dist/ imports for the pure functions, raw source reads for the
 * installer/builder wiring the dist build cannot express.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const {
  isAppBundledPlist,
  isPkgInstallPlist,
  isRetireablePlist,
  runningIsPkgAgent,
  retireBundledHelper,
  BUNDLED_AGENT_LABEL,
} = await import('../dist/retire-bundled-helper.js');

const read = (p) => readFileSync(join(pkgRoot, p), 'utf8');
const readRepo = (p) => readFileSync(join(pkgRoot, '..', p), 'utf8');
const installSh = read('install.sh');
const postinstall = readRepo('macos-pkg/scripts/postinstall');
const buildPkg = readRepo('macos-pkg/build-pkg.sh');
const buildApp = readRepo('macos-app/build-app.sh');
const mainSwift = readRepo('macos-app/Sources/Digby/main.swift');
const configTs = read('src/config.ts');

const pkgPlist = (prog) => `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>Label</key><string>${BUNDLED_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${prog}</string><string>run</string></array>
</dict></plist>`;

// ── 1. The nameless .pkg — the installer must carry a Digby title ───────────

test('405927c9: build-pkg.sh ships a distribution XML with a Digby title', () => {
  // The old `productbuild --package` alone → Installer.app showed a generic
  // "Installer", the completion line read `installed ""`, and System Settings
  // listed a nameless package.
  assert.match(buildPkg, /productbuild --distribution/);
  assert.match(buildPkg, /<title>Digby iMessage Agent<\/title>/);
  // The component pkg file must be named to match the <pkg-ref> text —
  // productbuild resolves the reference against --package-path by filename.
  assert.match(buildPkg, /"\$BUILD\/\$BUNDLE_ID\.pkg"/);
  assert.match(buildPkg, />\$\{BUNDLE_ID\}\.pkg<\/pkg-ref>/);
  // The distribution must be signed exactly as before (productsign unchanged).
  assert.match(buildPkg, /productsign --sign "\$INST_HASH" --timestamp "\$BUILD\/unsigned\.pkg" "\$OUT"/);
  // Review round 3 (Apple Distribution XML schema): os-version takes `min`
  // (required), NOT `version`, and lives inside allowed-os-versions under
  // volume-check — installer-gui-script has no bare os-version child. The
  // malformed form fails at INSTALL time on a user's Mac, not at build time.
  assert.match(buildPkg, /<volume-check>/);
  assert.match(buildPkg, /<allowed-os-versions>/);
  assert.match(buildPkg, /<os-version min="12\.0"\/>/);
  assert.ok(!/os-version version=/.test(buildPkg), 'no malformed os-version version= attribute');
  // hostArchitectures uses Apple arch names (arm64|x86_64), never node's x64
  // (review advisory 1 — x64 fails at install time on Intel Macs).
  assert.match(buildPkg, /hostArchitectures="\$\{PKG_ARCH\}"/);
  assert.match(buildPkg, /PKG_ARCH=x86_64/);
  assert.ok(!/hostArchitectures="\$\{NARCH\}"/.test(buildPkg), 'never the node-tarball arch name');
  // R9 (cross-family review, 405927c9): the Digby mark as the installer
  // <background> — a .pkg's own file icon cannot be customized, so the
  // background is Installer.app's one branding surface. The image ships INSIDE
  // the distribution via --resources (productbuild resolves `file` against it).
  assert.match(buildPkg, /<background file="installer-background\.png" mime-type="image\/png" alignment="center" scaling="proportional"\/>/);
  assert.match(buildPkg, /cp "\$ROOT\/macos-pkg\/assets\/installer-background\.png" "\$BUILD\/resources\/installer-background\.png"/);
  assert.match(buildPkg, /--resources "\$BUILD\/resources"/);
  assert.ok(existsSync(join(pkgRoot, '..', 'macos-pkg', 'assets', 'installer-background.png')), 'the background asset exists');
});

// ── 2. The lying version — .pkg version from source + staleness guards ──────

test('405927c9: the .pkg version comes from the AGENT source, never a hardcoded default', () => {
  // The ticket's "0.63" flap needs TWO lies gone: the served .pkg's agent
  // (frozen 0.1.0) AND the pkg version label (hardcoded 0.1.0). This pins
  // that the version is READ from imessage-agent/package.json (with an
  // explicit VERSION env still winning) and that no bare default remains.
  assert.match(buildPkg, /VERSION="\$\{VERSION:-\}"/);
  assert.match(buildPkg, /require\(\\"\$AGENT_SRC\/package\.json\\"\)/);
  assert.ok(!/VERSION="\$\{VERSION:-0\.1\.0\}"/.test(buildPkg), 'no hardcoded 0.1.0 default');
});

test('405927c9: build-pkg.sh refuses a .pkg bundling an agent older than the release manifest', () => {
  // The served .pkg froze agent 0.1.0 for four months; nothing tied the .pkg
  // to the tarball agents actually download. The guard reads the manifest's
  // version and exits 1 on a mismatch.
  assert.match(buildPkg, /agent-release\.ts/);
  assert.match(buildPkg, /MANIFEST_VERSION/);
  assert.match(buildPkg, /"?\$MANIFEST_VERSION" != "\$VERSION"/);
  assert.match(buildPkg, /exit 1/);
});

test('405927c9: build-app.sh refuses a DMG bundling a stale agent', () => {
  // Same guard for the .app: a DMG bundling an agent older than the release
  // tarball installs a downgrade via one-click that clobbers newer installs.
  assert.match(buildApp, /agent-release\.ts/);
  assert.match(buildApp, /MANIFEST_VERSION/);
  assert.match(buildApp, /"?\$MANIFEST_VERSION" != "\$AGENT_TREE_VERSION"?/);
});

test('405927c9: the tree agent matches the current release (lockstep pin)', () => {
  assert.match(configTs, /AGENT_VERSION = '0\.9\.19'/);
});

// ── 3. The duplicates — no shape installs beside a self-managed agent ───────

test('405927c9: the .pkg postinstall yields to a self-managed install', () => {
  // Installing the .pkg over a self-managed agent must not start a SECOND
  // polling agent with the same token (the version flap).
  assert.match(postinstall, /SELF_PLIST="\$USER_HOME\/Library\/LaunchAgents\/com\.digby\.agent\.plist"/);
  assert.match(postinstall, /if \[\[ -f "\$SELF_PLIST" \]\]/);
  // Yield happens AFTER the console-user resolution (USER_HOME is set) but
  // BEFORE the plist write + bootstrap — order pin.
  const yieldAt = postinstall.indexOf('SELF_PLIST=');
  const homeAt = postinstall.indexOf('USER_HOME=');
  const writeAt = postinstall.indexOf('cat > "$PLIST"');
  assert.ok(yieldAt > homeAt, 'the yield check follows USER_HOME resolution');
  assert.ok(writeAt < 0 || yieldAt < writeAt, 'the yield check precedes the plist write');
});

test('405927c9: the desktop app never clobbers a self-managed agent', () => {
  // main.swift's one-click setup must refuse when com.digby.agent.plist
  // exists — the old unconditional overwrite installed the DMG-frozen helper
  // over a NEWER self-managed agent.
  assert.match(mainSwift, /com\.digby\.agent\.plist/);
  assert.match(mainSwift, /fileExists\(atPath: selfManagedPlist\)/);
  // Both paired and unpaired states get an actionable message (no dead end).
  assert.match(mainSwift, /already installed/);
  assert.match(mainSwift, /self-updating Digby agent/i);
});

// ── 4. Single-agent convergence — the retire policy in the agent ────────────

test('405927c9: isPkgInstallPlist matches BOTH .pkg generations by path prefix', () => {
  // Current postinstall: /Library/Digby/imessage-agent/DigbyAgent
  assert.equal(isPkgInstallPlist(pkgPlist('/Library/Digby/imessage-agent/DigbyAgent')), true);
  // June 2026 postinstall: a plain "node" — matched by PREFIX, never by name.
  assert.equal(isPkgInstallPlist(pkgPlist('/Library/Digby/imessage-agent/node')), true);
  // Not a .pkg install: the bundled helper, a self-managed agent, junk.
  assert.equal(isPkgInstallPlist(pkgPlist('/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper')), false);
  assert.equal(isPkgInstallPlist(pkgPlist('/Users/x/Library/Application Support/Digby/bin/DigbyAgent')), false);
  assert.equal(isPkgInstallPlist(null), false);
  assert.equal(isPkgInstallPlist('<not-a-plist'), false);
  assert.equal(isPkgInstallPlist(pkgPlist('/Library/DigbyFake/imessage-agent/node')), false, 'prefix must not over-match');
});

test('405927c9: isRetireablePlist covers both never-updating shapes', () => {
  assert.equal(isRetireablePlist(pkgPlist('/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper')), true);
  assert.equal(isRetireablePlist(pkgPlist('/Library/Digby/imessage-agent/DigbyAgent')), true);
  assert.equal(isRetireablePlist(pkgPlist('/Library/Digby/imessage-agent/node')), true);
  // The self-managed agent's OWN plist is NEVER retireable — it is the one
  // running the retire.
  assert.equal(isRetireablePlist(pkgPlist('/Users/x/Library/Application Support/Digby/bin/DigbyAgent')), false);
});

test('405927c9: the .pkg agent never retires anything (identity guard)', () => {
  // A .pkg agent running the retire logic must be a no-op, exactly like the
  // bundled helper: postinstall yields to the self-managed install, and a
  // .pkg agent must never fight back or remove its own job.
  assert.equal(runningIsPkgAgent('/Library/Digby/imessage-agent/DigbyAgent'), true);
  assert.equal(runningIsPkgAgent('/Library/Digby/imessage-agent/node'), true);
  assert.equal(runningIsPkgAgent('/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper'), false);
  assert.equal(runningIsPkgAgent('/Users/x/Library/Application Support/Digby/bin/DigbyAgent'), false);
  const src = read('src/retire-bundled-helper.ts');
  assert.match(src, /if \(runningIsPkgAgent\(\)\)/);
  assert.match(src, /self: true/);
});

test('405927c9: retireBundledHelper retires a .pkg plist end-to-end (scratch HOME)', () => {
  const home = join(pkgRoot, 'test', '.scratch-405927c9');
  rmSync(home, { recursive: true, force: true });
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, 'ai.digby.imessage-agent.plist');
  writeFileSync(plist, pkgPlist('/Library/Digby/imessage-agent/DigbyAgent'));
  const r = retireBundledHelper(home);
  assert.equal(r.present, true);
  assert.equal(r.retired, true, 'the .pkg install is retired by the self-managed agent');
  assert.equal(existsSync(plist), false, 'its plist is gone (no resurrect at login)');
  // The unknown-shape rule survives: an unparseable/foreign plist is left.
  writeFileSync(plist, '<not-a-plist');
  const r2 = retireBundledHelper(home);
  assert.equal(r2.retired, false);
  assert.equal(existsSync(plist), true);
  rmSync(home, { recursive: true, force: true });
});

test('405927c9: install.sh retires BOTH never-updating shapes and says what to clean up', () => {
  // The one-line installer is the user's "I ran command" path — it must
  // retire the .app-bundled helper AND the .pkg install, and for the .pkg
  // tell the user how to drop the now-inert /Library/Digby payload.
  assert.match(installSh, /"\$APP_PROG" == \*"\.app\/Contents\/Resources\/"\* \|\| "\$APP_PROG" == "\/Library\/Digby\/"\*/);
  assert.match(installSh, /sudo rm -rf \/Library\/Digby/);
  // The retire still precedes our own service load (order pin from 933e6ca4).
  const retireAt = installSh.indexOf('rm -f "$APP_PLIST"');
  const loadAt = installSh.indexOf('launchctl load "$PLIST_DEST"');
  assert.ok(retireAt >= 0 && loadAt >= 0, 'both the retire and the load exist');
  assert.ok(retireAt < loadAt, 'the stale install is retired BEFORE this service loads');
  // The agent-side twin keeps its identity guards (source pin).
  const src = read('src/retire-bundled-helper.ts');
  assert.match(src, /runningIsPkgAgent/);
  assert.match(src, /isRetireablePlist\(xml\)/);
});
