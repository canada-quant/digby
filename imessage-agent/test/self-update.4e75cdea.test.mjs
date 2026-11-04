/**
 * Agent self-update (ticket 4e75cdea, 2026-10-08) — "the agent is not getting
 * updated automatically": all three paired Macs sat on 0.6.3 (below the 0.7.0
 * floor) days after 0.7.3 shipped because upgrades only happened when a human
 * pushed a tarball over SSH.
 *
 * Two layers, the house idiom (permissions.2f646c10 / browser-cdp-attach.4258335e):
 *   1. REAL unit tests of the pure pieces in dist/self-update.js — the action
 *      gate (version strictly newer, https URL, 64-hex sha256), the
 *      self-managed-install gate (.app/pkg/dev-tree exclusion), the retry
 *      gate (backoff + max attempts), the tarball-version parser and the
 *      version comparator.
 *   2. SOURCE-BYTES pins on the macOS/network wiring that cannot run on Linux
 *      CI: the sha256-before-swap ordering, the tarball-version-equals-advert
 *      gate, the smoke-test-before-swap gate, the backup-kept swap, the
 *      detached rollback watchdog, the idle-only update (never mid-command),
 *      the exit(1) launchd relaunch, and the kill switch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const indexSrc = SRC('src/index.ts');
const selfUpdateSrc = SRC('src/self-update.ts');
const apiSrc = SRC('src/api.ts');
const configSrc = SRC('src/config.ts');
const pkg = JSON.parse(SRC('package.json'));

const {
  versionNewer, advertActionable, isSelfManagedInstall, retryAllowed,
  parseTarballVersion, selfUpdateDisabled,
} = await import(join(pkgRoot, 'dist', 'self-update.js'));

const SHA = 'b'.repeat(64);

// ── 1. Pure decisions ────────────────────────────────────────────────────────

test('versionNewer: strictly-newer only (the ticket case 0.6.3 → 0.8.0)', () => {
  assert.equal(versionNewer('0.8.0', '0.6.3'), true);
  assert.equal(versionNewer('0.7.3', '0.6.3'), true);
  assert.equal(versionNewer('0.8.0', '0.8.0'), false, 'same version is not newer');
  assert.equal(versionNewer('0.6.3', '0.8.0'), false, 'older is not newer (no downgrades)');
  assert.equal(versionNewer('0.10.0', '0.9.10'), true, 'numeric compare, not lexical');
});

test('advertActionable: shape gate — version + https url + 64-hex sha256', () => {
  const good = { version: '0.8.0', url: 'https://digby.example.com/x.tar.gz', sha256: SHA };
  assert.equal(advertActionable(good, '0.6.3'), true);
  assert.equal(advertActionable(null, '0.6.3'), false);
  assert.equal(advertActionable({}, '0.6.3'), false);
  assert.equal(advertActionable({ ...good, version: 'garbage' }, '0.6.3'), false);
  assert.equal(advertActionable({ ...good, url: 'http://digby.example.com/x.tar.gz' }, '0.6.3'), false, 'plain http refused');
  assert.equal(advertActionable({ ...good, url: 'file:///etc/passwd' }, '0.6.3'), false);
  assert.equal(advertActionable({ ...good, sha256: 'REPLACE_WITH_TARBALL_SHA256' }, '0.6.3'), false);
  assert.equal(advertActionable({ ...good, sha256: 'zz' }, '0.6.3'), false);
  // the advert must be newer than the RUNNING agent — a stale manifest never walks a Mac backwards
  assert.equal(advertActionable(good, '0.8.0'), false);
  assert.equal(advertActionable(good, '0.9.0'), false);
});

test('isSelfManagedInstall: only tarball/install.sh installs may self-swap', () => {
  const mk = (root, opts = {}) => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    if (opts.marker) writeFileSync(join(root, '.digby-selfupdate'), '0.8.0\n');
    if (opts.parentGit) mkdirSync(join(root, '..', '.git'), { recursive: true });
    return root;
  };
  const base = mkdtempSync(join(tmpdir(), 'digby-su-'));
  try {
    // marked self-managed install → allowed
    const marked = mk(join(base, 'marked'), { marker: true });
    assert.equal(isSelfManagedInstall(marked), true);
    // plain tree without the marker or the canonical path → NOT self-managed
    const unmarked = mk(join(base, 'unmarked'));
    assert.equal(isSelfManagedInstall(unmarked), false);
    // .app-bundled helper → never (the app's DMG + bundleReplaced owns it)
    const inApp = mk(join(base, 'Digby.app/Contents/Resources/imessage-agent'), { marker: true });
    assert.equal(isSelfManagedInstall(inApp), false);
    // repo checkout (../.git) → never
    const dev = mk(join(base, 'checkout', 'imessage-agent'), { marker: true, parentGit: true });
    assert.equal(isSelfManagedInstall(dev), false);
    // node_modules copy → never
    const nm = mk(join(base, 'node_modules', 'digby-agent'), { marker: true });
    assert.equal(isSelfManagedInstall(nm), false);
    // nonexistent → never
    assert.equal(isSelfManagedInstall(join(base, 'nope')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('retryAllowed: backoff window + max attempts (a poison release must not crash-loop the fleet)', () => {
  const now = Date.now();
  assert.equal(retryAllowed(null, now), true, 'no state → first try');
  assert.equal(retryAllowed({ lastAttemptAt: new Date(now - 1000).toISOString(), failures: 0 }, now), false, 'seconds after → wait');
  const SIX_H = 6 * 60 * 60 * 1000;
  assert.equal(retryAllowed({ lastAttemptAt: new Date(now - SIX_H - 1000).toISOString(), failures: 1 }, now), true, 'past the backoff → retry');
  assert.equal(retryAllowed({ lastAttemptAt: new Date(now - SIX_H - 1000).toISOString(), failures: 3 }, now), false, 'MAX_ATTEMPTS reached → stop');
  assert.equal(retryAllowed({ lastAttemptAt: 'garbage', failures: 0 }, now), true, 'unparseable stamp does not wedge the agent');
  // Reviewer F2 (4e75cdea): the failure cap is PER RELEASE — a Mac that gave
  // up on 0.8.0 must still take a NEWER release without a manual state edit.
  assert.equal(retryAllowed({ lastAttemptAt: new Date(now - SIX_H - 1000).toISOString(), failures: 3, version: '0.8.0' }, now, '0.9.0'), true, 'a new release resets the cap');
  assert.equal(retryAllowed({ lastAttemptAt: new Date(now - SIX_H - 1000).toISOString(), failures: 3, version: '0.8.0' }, now, '0.8.0'), false, 'same release stays capped');
});

test('parseTarballVersion: the tarball\'s own package.json must name a version', () => {
  assert.equal(parseTarballVersion('{"version":"0.8.0"}'), '0.8.0');
  assert.equal(parseTarballVersion('{"version":"0.1.0"}'), '0.1.0');
  assert.equal(parseTarballVersion('{"version":"garbage"}'), null);
  assert.equal(parseTarballVersion('not json'), null);
});

test('kill switch: DIGBY_SELF_UPDATE=0 disables', () => {
  const prev = process.env.DIGBY_SELF_UPDATE;
  process.env.DIGBY_SELF_UPDATE = '0';
  try {
    assert.equal(selfUpdateDisabled(), true);
  } finally {
    if (prev === undefined) delete process.env.DIGBY_SELF_UPDATE;
    else process.env.DIGBY_SELF_UPDATE = prev;
  }
  assert.equal(selfUpdateDisabled(), false);
});

// ── 2. Version pins ──────────────────────────────────────────────────────────

test('4e75cdea pin: this tree IS 0.9.1 (the self-updating agent line)', () => {
  assert.match(configSrc, /AGENT_VERSION = '0\.9\.19'/, 'config.ts AGENT_VERSION must be 0.9.19');
  assert.equal(pkg.version, '0.9.19', 'package.json version must match');
});

test('4e75cdea pin: the poll response carries the additive update block next to command', () => {
  assert.match(apiSrc, /update\?: UpdateAdvert/, 'PollResult.update exists');
  assert.match(apiSrc, /command: json\?\.command \?\? null/, 'command still parsed first (pre-0.8.0 contract)');
  assert.match(apiSrc, /json\?\.update/, 'the update block is read from the same response');
});

// ── 3. Source-bytes pins on the procedure (cannot execute on Linux CI) ───────

const stripLineComments = (s) => s.replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('4e75cdea pin: checksum + tarball-version are verified BEFORE any swap', () => {
  const idxSha = selfUpdateSrc.indexOf('digest !== a.sha256');
  const idxTar = selfUpdateSrc.indexOf("tarVersion !== a.version");
  const idxSwap = selfUpdateSrc.indexOf('renameSync(agentRoot, backupDir)');
  assert.ok(idxSha > 0, 'sha256 mismatch guard present');
  assert.ok(idxTar > idxSha, 'tarball version gate comes after the checksum');
  assert.ok(idxSwap > idxTar, 'the swap happens only after both gates');
});

test('4e75cdea pin: the new tree is smoke-tested before the swap (a build that cannot boot never ships)', () => {
  const idxSmoke = selfUpdateSrc.indexOf("'selftest'");
  const idxSwap = selfUpdateSrc.indexOf('renameSync(agentRoot, backupDir)');
  assert.ok(idxSmoke > 0, 'selftest smoke gate present');
  assert.ok(idxSwap > idxSmoke, 'swap ordered after the smoke test');
  assert.match(selfUpdateSrc, /SELFTEST_OK/, 'the smoke test asserts the version string');
});

test('4e75cdea pin: the prior tree is KEPT (rollback) and restored on a failed swap', () => {
  assert.match(selfUpdateSrc, /renameSync\(agentRoot, backupDir\)/, 'old tree moved aside, not deleted');
  assert.match(selfUpdateSrc, /renameSync\(backupDir, agentRoot\)/, 'failed swap restores the old tree');
});

test('4e75cdea pin: a detached watchdog from the OLD tree rolls back an unhealthy update', () => {
  assert.match(selfUpdateSrc, /update-watchdog/, 'watchdog subcommand exists');
  assert.match(selfUpdateSrc, /detached: true/, 'spawned detached (survives our exit)');
  assert.match(selfUpdateSrc, /join\(backupDir, 'dist', 'index\.js'\)/, 'spawned from the BACKUP tree');
  assert.match(stripLineComments(selfUpdateSrc), /if \(existsSync\(OK_PATH\)\) \{\s*try \{ rmSync\(PENDING_PATH/, 'ok-marker stands the watchdog down');
});

test('4e75cdea pin: a successful poll confirms a pending update (noteHealthyPoll)', () => {
  assert.match(indexSrc, /noteHealthyPoll\(\)/, 'the run loop confirms health after every successful poll');
  assert.match(selfUpdateSrc, /pending\.version !== AGENT_VERSION/, 'only the pending binary confirms');
});

test('4e75cdea pin: updates apply ONLY while idle — never with a command in hand', () => {
  const loop = indexSrc.split('while (true)')[1].split('async function pair(')[0];
  const updateIdx = loop.indexOf('trySelfUpdate(update');
  const cmdIdx = loop.indexOf('→ command');
  assert.ok(updateIdx > 0, 'run loop acts on the update advert');
  assert.ok(cmdIdx > updateIdx, 'the update path sits in the no-command (idle) branch, before command execution');
  assert.match(loop, /if \(!command\) \{/, 'the idle branch is explicit');
});

test('4e75cdea pin: an applied update restarts via exit(1) + launchd KeepAlive (the permission_relaunch idiom)', () => {
  const loop = indexSrc.split('while (true)')[1].split('async function pair(')[0];
  assert.match(loop, /Self-updated to agent v/, 'the update is logged');
  assert.match(loop, /process\.exit\(1\)/, 'exit 1 → launchd KeepAlive relaunches the NEW binary');
});

test('4e75cdea pin: a failed/skipped update NEVER kills the agent', () => {
  const loop = indexSrc.split('while (true)')[1].split('async function pair(')[0];
  assert.match(loop, /outcome === 'failed'/, 'failure is handled');
  assert.match(loop, /continue;/, 'the loop continues polling after a skip/failure');
  // no exit inside the failure branch: extract the failure line and check what follows
  const failIdx = loop.indexOf("r.outcome === 'failed'");
  const appliedIdx = loop.indexOf("r.outcome === 'applied'");
  assert.ok(appliedIdx > 0 && failIdx > appliedIdx, 'applied precedes failed handling');
  const between = loop.slice(failIdx, failIdx + 400);
  assert.ok(!between.includes('process.exit'), 'a failed update logs and keeps polling');
});

test('4e75cdea pin: the selftest command exists and imports every runtime module', () => {
  assert.match(indexSrc, /case 'selftest':/, 'CLI selftest command');
  assert.match(selfUpdateSrc, /AGENT_SELFTEST_MODULES/, 'module list exported');
  assert.match(selfUpdateSrc, /'\.\/config', '\.\/api', '\.\/chatdb'/, 'the module list is explicit');
  assert.match(selfUpdateSrc, /'\.\/browser', '\.\/computer'/, 'native/ABI modules included');
});

test('4e75cdea pin: trySelfUpdate never throws (a failed update leaves the agent running)', () => {
  assert.match(selfUpdateSrc, /outcome: 'failed'/, 'failures are values');
  const body = selfUpdateSrc.slice(selfUpdateSrc.indexOf('export async function trySelfUpdate'));
  assert.ok(body.includes('} catch (e: any) {'), 'the procedure is fully wrapped');
});
