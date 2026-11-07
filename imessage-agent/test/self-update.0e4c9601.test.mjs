/**
 * Agent self-update native-module carry (ticket 0e4c9601, 2026-10-09) — the
 * adhoc better_sqlite3.node blind spot.
 *
 * LIVE MISHAP REPLAYED (cql-stanne-mbp-5.local, 0.8.0 bootstrap): `npm ci`
 * builds better_sqlite3 locally → adhoc/linker-signed .node (codesign flags
 * 0x20002). A Team-signed HARDENED-runtime interpreter (DigbyHelper) refuses
 * adhoc libraries at dlopen ("mapping process and mapped file (non-platform)
 * have different Team IDs"), but ONLY under the real launchd context — the
 * pre-swap smoke STILL printed SELFTEST_OK (the kernel serves a cached
 * signature for the in-place-overwritten vnode), the swap landed the adhoc
 * module, and the agent ran degraded (iMessage/FDA reads dead) without ever
 * failing a health check, so the rollback watchdog stood down.
 *
 * Two layers, the 4e75cdea house idiom:
 *   1. REAL unit tests of the pure pieces in dist/self-update.js — the native
 *      carry (copy same-version, refuse changed-version, fresh-vnode rename),
 *      the dep-version reader and the fresh-child loadability probe.
 *   2. SOURCE-BYTES pins on the macOS wiring that cannot run on Linux CI: the
 *      carry step sits BETWEEN the staged build and the smoke test, and the
 *      selftest loads every native addon in a FRESH child process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const selfUpdateSrc = SRC('src/self-update.ts');
const indexSrc = SRC('src/index.ts');
const configSrc = SRC('src/config.ts');
const installSh = SRC('install.sh');
const pkgJson = JSON.parse(SRC('package.json'));

const { carryNativeModules, depVersion, nativeAddonLoadable, nativeAddonProbe } = await import(join(pkgRoot, 'dist', 'self-update.js'));

/** Bytes of THIS tree's real, loadable better-sqlite3 addon (npm ci builds it
 *  on CI — the probe test below pins that). 8bcd1c4a: carryNativeModules only
 *  carries a module the CURRENT interpreter can load, so a fixture whose carry
 *  must HAPPEN needs the real thing; synthetic bytes model a broken module.
 *  Read LAZILY (reviewer F7): a tree without a built addon must fail only the
 *  tests that need it, with this message — not the whole file at import. */
function realAddon() {
  try {
    return readFileSync(join(pkgRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
  } catch {
    throw new Error('this tree has no built better_sqlite3.node — run `npm install` in imessage-agent first (the 8bcd1c4a carry fixtures need the real, loadable addon)');
  }
}

/** Build a fake agent tree with a better-sqlite3 install of `version` whose
 *  addon bytes are `bytes` — the minimal shape carryNativeModules reads. */
function mkTree(base, name, version, bytes) {
  const root = join(base, name);
  const depRoot = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(join(depRoot, 'build', 'Release'), { recursive: true });
  writeFileSync(join(depRoot, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version }));
  writeFileSync(join(depRoot, 'build', 'Release', 'better_sqlite3.node'), bytes);
  return root;
}

// ── 1. The carry decision (real logic, fake trees) ───────────────────────────

test('0e4c9601: same dep version → the current tree\'s .node is carried over the staged adhoc rebuild', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    // 8bcd1c4a: the carry only happens when the CURRENT module loads under
    // this interpreter — so the fixture carries this tree's REAL addon.
    const cur = mkTree(base, "cur", "11.10.0", realAddon());
    const stg = mkTree(base, "stg", "11.10.0", "ADHOC-REBUILD-BYTES");
    const r = carryNativeModules(cur, stg);
    assert.equal(r.ok, true);
    assert.deepEqual(r.carried, ['better-sqlite3@11.10.0']);
    const staged = readFileSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
    assert.ok(staged.equals(realAddon()), 'the staged adhoc rebuild was REPLACED by the proven-loadable module');
    // the current tree is untouched (source of the carry)
    assert.ok(readFileSync(join(cur, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')).equals(realAddon()));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('0e4c9601: the ticket case — a staged 11.10.0 rebuild over a current 11.10.0 (mbp-5: identical dep versions)', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    // exactly the live shape: both trees carry better-sqlite3 11.10.0 (the
    // old tree's is Team-signed, the staged rebuild adhoc)
    const cur = mkTree(base, "agent-0.7.3", "11.10.0", realAddon());
    const stg = mkTree(base, "staging", "11.10.0", "ADHOC");
    const r = carryNativeModules(cur, stg);
    assert.equal(r.ok, true);
    assert.ok(readFileSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')).equals(realAddon()));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('0e4c9601: dep version CHANGED → the swap is REFUSED (signed manual release required)', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    const cur = mkTree(base, 'cur', '11.10.0', 'TEAM-SIGNED');
    const stg = mkTree(base, 'stg', '12.0.0', 'ADHOC-NEW-ABI');
    const r = carryNativeModules(cur, stg);
    assert.equal(r.ok, false);
    assert.match(r.reason, /better-sqlite3 version changed \(11\.10\.0 → 12\.0\.0\)/);
    assert.match(r.reason, /signed manual release/);
    // nothing was carried into a refused tree
    assert.equal(readFileSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'utf8'), 'ADHOC-NEW-ABI');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('0e4c9601: a current tree WITHOUT the native addon is left to the smoke test (no crash, no carry)', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    const cur = mkTree(base, 'cur', '11.10.0', 'X');
    rmSync(join(cur, 'node_modules', 'better-sqlite3', 'build'), { recursive: true, force: true }); // no addon
    const stg = mkTree(base, 'stg', '11.10.0', 'ADHOC');
    const r = carryNativeModules(cur, stg);
    assert.equal(r.ok, true);
    assert.deepEqual(r.carried, [], 'nothing carried when the current tree has no addon');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('0e4c9601: the carry lands on a FRESH vnode (rename, not an in-place overwrite)', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    const cur = mkTree(base, "cur", "11.10.0", realAddon());
    const stg = mkTree(base, 'stg', '11.10.0', 'ADHOC');
    const before = statSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
    carryNativeModules(cur, stg);
    const after = statSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
    // A rename replaces the vnode: inode changes (mtime would also move on
    // any write). The ticket's masking mechanism is precisely an in-place
    // overwrite of the SAME vnode keeping its cached signature.
    assert.notEqual(before.ino, after.ino, 'staged .node inode changed → the carried module is a FRESH vnode, not an in-place overwrite');
    // and no .carry-* temp litter is left behind
    const release = join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release');
    assert.equal(readdirSync(release).filter((n) => n.includes('.carry-')).length, 0, 'no carry temp files left');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


// ── 2. depVersion + the fresh-child probe (real logic) ───────────────────────

test('0e4c9601: depVersion reads a dependency\'s installed version', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    const cur = mkTree(base, 'cur', '9.9.9', 'X');
    assert.equal(depVersion(cur, 'better-sqlite3'), '9.9.9');
    assert.equal(depVersion(join(base, 'nope'), 'better-sqlite3'), null, 'a missing tree reads null (never a guess)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('0e4c9601: nativeAddonLoadable loads the real better-sqlite3 in a fresh child (this tree\'s own install)', async () => {
  // pkgRoot has better-sqlite3 installed on CI (npm ci builds it here on Linux).
  // The probe must succeed — and must have used a CHILD (no cached signature).
  assert.equal(nativeAddonLoadable(pkgRoot, 'better-sqlite3'), true);
  // a tree whose addon bytes are garbage fails the fresh-child load
  const base = mkdtempSync(join(tmpdir(), 'carry-0e4c9601-'));
  try {
    const bad = mkTree(base, 'bad', '1.0.0', 'NOT-A-MACH-O');
    assert.equal(nativeAddonLoadable(bad, 'better-sqlite3'), false, 'a corrupt addon fails the probe');
    const none = mkTree(base, 'none', '1.0.0', 'X');
    rmSync(join(none, 'node_modules', 'better-sqlite3', 'build'), { recursive: true, force: true });
    assert.equal(nativeAddonLoadable(none, 'better-sqlite3'), false, 'a missing addon fails the probe');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 3. Source-bytes pins on the procedure (cannot execute on Linux CI) ───────

test('0e4c9601 pin: the native carry sits BETWEEN the staged build and the smoke test', () => {
  const idxBuild = selfUpdateSrc.indexOf('npm run build');
  const idxCarry = selfUpdateSrc.indexOf('carryNativeModules(agentRoot, stagedAgent)');
  const idxSmoke = selfUpdateSrc.indexOf("'selftest'");
  const idxSwap = selfUpdateSrc.indexOf('renameSync(agentRoot, backupDir)');
  assert.ok(idxBuild > 0, 'staged build present');
  assert.ok(idxCarry > idxBuild, 'native carry runs AFTER the staged build');
  assert.ok(idxSmoke > idxCarry, 'smoke runs AFTER the carry (it validates the carried tree)');
  assert.ok(idxSwap > idxSmoke, 'swap still ordered after the smoke test');
});

test('0e4c9601 pin: a refused carry FAILS the update (the adhoc tree is never swapped in)', () => {
  assert.match(selfUpdateSrc, /if \(!carry\.ok\) return \{ outcome: 'failed', reason: carry\.reason \}/, 'carry refusal fails the update');
});

test('0e4c9601 pin: selftest loads every native addon in a FRESH CHILD process', () => {
  assert.match(selfUpdateSrc, /AGENT_NATIVE_MODULES/, 'the native module list exists');
  assert.match(selfUpdateSrc, /nativeAddonProbe\(dirname\(__dirname\), dep\)/, 'selftest probes native addons');
  assert.match(selfUpdateSrc, /spawnSync\(process\.execPath/, 'the probe is a real child process, not an in-process require');
  assert.match(selfUpdateSrc, /SELFTEST_FAIL native:/, 'a refused addon fails the selftest loudly');
});

// ── 5. Ticket 8bcd1c4a — the npm ≥12 / stale-ABI blind spot ──────────────────

// The ticket's Mac: Homebrew node v26.11.1 + npm 12. The 0.8.1/0.8.2 tarball ships
// src/ with NO allowScripts — npm 12 BLOCKS better-sqlite3's install script,
// and on a re-install over an existing tree `npm install` says "up to date"
// and rebuilds nothing, so the addon is missing or stale-ABI. The selftest
// then fails with a message that GUESSES "signature refused?" (a
// hardened-runtime class that cannot happen on a plain Homebrew node) and
// hides the child's real dlopen error.

test('8bcd1c4a: package.json ships allowScripts for better-sqlite3 (npm ≥12 unblocks the build)', () => {
  assert.ok(pkgJson.allowScripts, 'allowScripts present');
  assert.equal(pkgJson.allowScripts['better-sqlite3'], true, 'better-sqlite3 install script approved');
});

test('8bcd1c4a: install.sh rebuilds better-sqlite3 when the built addon fails a fresh-child load', () => {
  // the loadability probe + rebuild — the recovery for a missing (npm ≥12
  // blocked build) OR unloadable (Node upgrade changed the V8 ABI) addon.
  const idxRebuild = installSh.indexOf('npm rebuild better-sqlite3');
  assert.ok(idxRebuild > 0, 'the rebuild fallback exists');
  assert.match(installSh, /sqlite_loads\(\)/, 'the probe is a fresh-child load of the built addon');
  assert.match(installSh, /if ! sqlite_loads; then/, 'the rebuild outcome is re-checked by the same probe');
  // ordering: npm install/build → rebuild fallback → 0e4c9601 carry → selftest.
  // Reviewer F1 (8bcd1c4a): the rebuild fallback must NEVER exit before the
  // carry — under DigbyHelper the fresh build is always adhoc-refused and the
  // sibling-tree carry (or the selftest) is the only remaining path.
  const idxInstall = installSh.indexOf('npm install');
  const idxCarry = installSh.indexOf('agent-*/node_modules/better-sqlite3');
  const idxSelftest = installSh.indexOf('dist/index.js" selftest');
  assert.ok(idxInstall > 0 && idxRebuild > idxInstall, 'rebuild fallback runs after npm install');
  assert.ok(idxCarry > idxRebuild, 'the 0e4c9601 carry still runs after the rebuild fallback');
  assert.ok(idxSelftest > idxCarry, 'the selftest still gates last');
  const rebuildBlock = installSh.slice(installSh.indexOf('── Native module rebuild fallback'), idxCarry);
  assert.doesNotMatch(rebuildBlock, /exit 1/, 'the rebuild fallback falls through to the carry, never exits early');
});

test('8bcd1c4a: the probe failure names the real child error (never a bare "signature refused?" guess)', () => {
  assert.doesNotMatch(selfUpdateSrc, /signature refused\?\)/, 'the hardcoded guess is gone');
  assert.match(selfUpdateSrc, /nativeAddonProbe\(/, 'the evidence-carrying probe exists');
  assert.match(selfUpdateSrc, /Common causes:/, 'the failure output lists the candidate causes');
});

test('8bcd1c4a: nativeAddonProbe returns the child\'s stderr (an unloadable addon is diagnosable)', () => {
  const base = mkdtempSync(join(tmpdir(), 'probe-8bcd1c4a-'));
  try {
    const bad = mkTree(base, 'bad', '11.10.0', 'NOT-A-MACH-O');
    const r = nativeAddonProbe(bad, 'better-sqlite3');
    assert.equal(r.ok, false);
    assert.match(r.error, /.+/, 'the child\'s real error text is present (not a guess)');
    // the real addon probes ok with no error text
    const real = nativeAddonProbe(pkgRoot, 'better-sqlite3');
    assert.equal(real.ok, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('8bcd1c4a: a current tree whose addon does NOT load is never the carry source (skip, not poison)', () => {
  const base = mkdtempSync(join(tmpdir(), 'carry-8bcd1c4a-'));
  try {
    // the ticket's shape: the current install holds a stale/blocked-build
    // addon that cannot load; the staged tree has a fresh adhoc build.
    const cur = mkTree(base, 'cur', '11.10.0', 'STALE-ABI-JUNK');
    const stg = mkTree(base, 'stg', '11.10.0', 'ADHOC-FRESH');
    const r = carryNativeModules(cur, stg);
    assert.equal(r.ok, true, 'the update is not refused');
    assert.deepEqual(r.carried, [], 'nothing carried — the unloadable current module never poisons the staged tree');
    assert.equal(readFileSync(join(stg, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'utf8'), 'ADHOC-FRESH', 'the staged fresh build survives for the smoke test to judge');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('8bcd1c4a/51d8dbe0 pin: this tree IS the current version', () => {
  assert.match(configSrc, /AGENT_VERSION = '0\.9\.24'/, 'config.ts AGENT_VERSION must be 0.9.24');
  assert.equal(pkgJson.version, '0.9.24', 'package.json version must match AGENT_VERSION');
});

test('0e4c9601 pin: the smoke child runs with the STAGED tree as its tree (dist/ resolves node_modules from the staged root)', () => {
  // The smoke invokes <staging>/dist/index.js selftest with cwd=stagedAgent:
  // dist/../node_modules is the STAGED install — exactly what the swap lands.
  const idxSmokeRun = selfUpdateSrc.indexOf("join(stagedAgent, 'dist', 'index.js'), 'selftest'");
  assert.ok(idxSmokeRun > 0, 'the smoke runs the staged dist with cwd stagedAgent');
  assert.match(selfUpdateSrc, /cwd: stagedAgent/, 'smoke cwd is the staged agent root');
});

// ── 4. Pins shared with 4e75cdea that must SURVIVE this change ───────────────

test('0e4c9601 pin: the 4e75cdea contract survives — smoke-before-swap, SELFTEST_OK, rollback watchdog', () => {
  const idxSmoke = selfUpdateSrc.indexOf("'selftest'");
  const idxSwap = selfUpdateSrc.indexOf('renameSync(agentRoot, backupDir)');
  assert.ok(idxSmoke > 0 && idxSwap > idxSmoke, 'smoke still gates the swap');
  assert.match(selfUpdateSrc, /SELFTEST_OK/, 'the smoke test still asserts the version string');
  assert.match(selfUpdateSrc, /update-watchdog/, 'the rollback watchdog survives');
  assert.match(selfUpdateSrc, /try \{ rmSync\(PENDING_PATH/, 'ok-marker stands the watchdog down');
  assert.match(indexSrc, /case 'selftest':/, 'CLI selftest command survives');
});
