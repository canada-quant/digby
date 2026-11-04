/**
 * Ticket c6e91d19 — "update-only command runs but the agent stays v0.6.3 on
 * both Macs after uninstall/reinstall".
 *
 * THE MISHAP: the one-line updater EXITED 0 while the Mac kept reporting
 * 0.6.3. `launchctl load` returning 0 proves the plist was read — not that a
 * process launched, and not that the stale app-bundled helper (label
 * ai.digby.imessage-agent, frozen at 0.6.3 inside the served 0.1.10 desktop
 * app, whose one-click setup has no self-managed guard) isn't still the only
 * poller. Nothing in the pipeline could distinguish "installed AND running"
 * from "downloaded, load swallowed, stale helper still polling".
 *
 * THE FIX, pinned here end to end:
 *   1. running-agent.ts — the LIVE process stamps
 *      ~/.config/digby-agent/running-agent.json {version, pid, entry} first
 *      thing in runLoop: the stamp is ground truth for WHAT IS RUNNING (disk
 *      trees only prove what was downloaded).
 *   2. install.sh — after `launchctl load`, WAITS for the stamp to name the
 *      installed tree's version + entry (one kickstart retry at 20s, LOUD
 *      failure with next steps at 90s, exit 1). Silent success is gone.
 *   3. index.ts — the idle poll loop re-runs retireBundledHelper every 5 min
 *      so an app-side re-registration mid-run is cleaned in minutes, not at
 *      the next reboot (the one-click button can fire at ANY moment).
 *
 * WHAT CI CAN AND CANNOT REPLAY: the true mishap needs launchd + a Mac; CI
 * (Linux) replays the DETERMINISTIC CORE of "install → the running agent
 * reports the installed version": the stamp functions themselves (write →
 * read → the exact matcher install.sh runs), the installer source-bytes pins
 * (the wait loop, the loud failure, the exit), and the source-bytes pins of
 * the loop wiring. This is the same idiom as installer-ux.405927c9.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const { writeRunningAgentStamp, readRunningAgentStamp, runningAgentStampPath } =
  await import('../dist/running-agent.js');
const { AGENT_VERSION } = await import('../dist/config.js');
const { reRetireDue, _stampRetireCheck, RETIRE_RECHECK_MS } = await import('../dist/retire-clock.js');

const read = (p) => readFileSync(join(pkgRoot, p), 'utf8');
const readRepo = (p) => readFileSync(join(pkgRoot, '..', p), 'utf8');
const installSh = read('install.sh');
const indexTs = read('src/index.ts');
const pkgJson = JSON.parse(read('package.json'));

// ── 1. The stamp: write → read round-trip, and the installer's exact check ──

test('c6e91d19: writeRunningAgentStamp/readRunningAgentStamp round-trip the running identity', () => {
  const home = mkHome('stamp-roundtrip');
  try {
    const wrote = writeRunningAgentStamp('/tmp/fake/agent/dist/index.js', home);
    assert.ok(wrote, 'writeRunningAgentStamp returns the stamp on success');
    const stamp = readRunningAgentStamp(home);
    assert.ok(stamp, 'the stamp is readable back');
    // version MUST be the live build's AGENT_VERSION — the value every poll
    // advertises, and the value install.sh's verification waits for.
    assert.equal(stamp.version, AGENT_VERSION);
    assert.equal(stamp.entry, '/tmp/fake/agent/dist/index.js');
    assert.equal(typeof stamp.pid, 'number');
    assert.equal(typeof stamp.startedAt, 'string');
    assert.ok(stamp.startedAt.length > 0);
    // The path is the ticket's one authoritative answer to "what is running".
    assert.equal(runningAgentStampPath(home), join(home, '.config', 'digby-agent', 'running-agent.json'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('c6e91d19: a stale stamp (an old version / another tree) reads back as what it is — the verification must be able to see the mismatch', () => {
  const home = mkHome('stamp-stale');
  try {
    // Simulate the wedged Mac: an OLD helper's stamp on disk (0.6.3, a
    // different entry) while this build is 0.9.3.
    const path = runningAgentStampPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: '0.6.3', pid: 999, entry: '/Applications/Digby.app/Contents/Resources/imessage-agent/dist/index.js', startedAt: '2026-10-23T00:00:00.000Z' }));
    const stamp = readRunningAgentStamp(home);
    assert.equal(stamp?.version, '0.6.3');
    // The installer's matcher (replicated below) MUST refuse this stamp when
    // the installer just wrote 0.9.3 to $AGENT_DIR — pinning that a stale
    // helper's stamp can never satisfy the verification.
    const installedVersion = AGENT_VERSION;
    const installedEntry = '/tmp/fake/agent/dist/index.js';
    const ok = stamp?.version === installedVersion && stamp?.entry === installedEntry;
    assert.equal(ok, false, 'a 0.6.3 stamp from another tree must NOT verify against a 0.9.3 install');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('c6e91d19: an unwritable HOME never throws — the stamp is best-effort', () => {
  // A path under a FILE (not a dir) cannot be created → writeFileSync throws
  // inside, writeRunningAgentStamp swallows and returns null; the agent keeps
  // polling (an unwritable Mac must never lose its agent over diagnostics).
  const home = mkHome('stamp-unwritable');
  try {
    writeFileSync(join(home, 'blocker'), 'not a directory');
    const wrote = writeRunningAgentStamp('/x/dist/index.js', join(home, 'blocker', 'sub'));
    assert.equal(wrote, null);
    assert.equal(readRunningAgentStamp(join(home, 'blocker', 'sub')), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 2. install.sh: the wait-for-the-stamp verification (source-bytes pins) ───

test('c6e91d19: install.sh waits for the RUNNING agent to name the installed version (no more silent success)', () => {
  // The stamp path + version matcher — the exact mechanism.
  assert.match(installSh, /running-agent\.json/);
  assert.match(installSh, /verify_running_agent/);
  // The wait loop is bounded and fails LOUDLY with exit 1 — "the command
  // completed but nothing changed" (this ticket) is no longer possible.
  assert.match(installSh, /THE AGENT DID NOT COME UP/);
  assert.match(installSh, /exit 1/);
  // It waits for the INSTALLED tree's version AND entry — proving the running
  // process comes from THIS tree (the ticket's root-cause #1: two installs
  // coexisting, the old one still launching). The entry match accepts BOTH
  // the invocation path and its realpath (0.9.4/D-3: the agent realpaths
  // __dirname, a symlinked invocation names a logical path).
  assert.match(installSh, /EXPECTED_VERSION=.*package\.json.*version/);
  assert.match(installSh, /\[\[ "\$v" = "\$EXPECTED_VERSION" && \( "\$e" = "\$AGENT_DIR\/dist\/index\.js" \|\| "\$e" = "\$AGENT_DIR_REAL\/dist\/index\.js" \) \]\]/);
  // One bounded kickstart retry — never a poll loop, never faster than the
  // service's own ThrottleInterval.
  assert.match(installSh, /launchctl kickstart -k "gui\/\$\(id -u\)\/\$LABEL"/);
  // The failure text names the three real wedge causes + the diagnostics to
  // send (the ticket's owner was told to run these BY HAND — now the
  // installer prints them itself at the moment of failure).
  assert.match(installSh, /launchctl list \| grep -i digby/);
  assert.match(installSh, /digby-agent\.err\.log/);
  // And on SUCCESS it prints the verified pid + entry (the owner can SEE the
  // running identity flipped).
  assert.match(installSh, /verified: the RUNNING agent is v/);
});

test('c6e91d19: install.sh still retires the app-bundled helper BEFORE loading our service (the other half of the wedge)', () => {
  // The retire block must run before the load (so the two never poll side by
  // side) and still match by CONTENT (.app/Contents/Resources/ or /Library/
  // Digby/), never by label alone.
  const retireAt = installSh.indexOf('APP_PLIST=');
  const loadAt = installSh.indexOf('launchctl load "$PLIST_DEST"');
  assert.ok(retireAt > 0, 'the retire block exists');
  assert.ok(loadAt > retireAt, 'the retire runs BEFORE our service loads');
  assert.match(installSh, /\.app\/Contents\/Resources\//);
  assert.match(installSh, /\/Library\/Digby\//);
});

// ── 3. The poll loop: startup stamp + periodic re-retire wiring ──────────────

test('c6e91d19: runLoop stamps the running agent BEFORE anything else and the loop re-retires on an interval', () => {
  // The stamp write sits at the top of runLoop (after the pair gate — an
  // unpaired Mac never claims to be a running agent).
  const runLoopAt = indexTs.indexOf('async function runLoop');
  const stampAt = indexTs.indexOf('writeRunningAgentStamp(');
  const retireAt = indexTs.indexOf('retireBundledHelper()');
  assert.ok(runLoopAt > 0 && stampAt > runLoopAt, 'runLoop writes the stamp');
  // Before the FIRST poll (the stamp exists by the time install.sh could read
  // it — the installer waits at most 90s, the first poll is within seconds).
  const whileAt = indexTs.indexOf('while (true)');
  assert.ok(stampAt < whileAt, 'the stamp is written before the poll loop');
  assert.ok(retireAt > runLoopAt, 'the startup retire remains in runLoop');
  // The clock is armed at the startup retire (one full window before the first
  // re-check — no redundant first-poll duplicate of what startup just did).
  assert.match(indexTs, /_stampRetireCheck\(nowMs\(\)\)/);
  // The periodic re-retire: due-check + stamp + the call inside the idle loop
  // (an app-side re-registration is cleaned within minutes, not at reboot).
  assert.match(indexTs, /reRetireDue\(nowMs\(\)\)/);
  const reRetireAt = indexTs.indexOf('reRetireDue(nowMs())');
  assert.ok(reRetireAt > whileAt, 'the re-retire check runs INSIDE the poll loop');
});

test('c6e91d19: reRetireDue fires on the interval (the re-infection window is minutes, not a reboot)', () => {
  // Direct behavioral check of the clock: not due right after the startup
  // retire stamped it, due one window later, then re-armed on firing.
  const T0 = 1_000_000;
  _stampRetireCheck(T0);
  assert.equal(reRetireDue(T0 + 1000), false, 'not due 1s after the startup retire');
  assert.equal(reRetireDue(T0 + RETIRE_RECHECK_MS - 1), false, 'not due 1ms before the window closes');
  assert.equal(reRetireDue(T0 + RETIRE_RECHECK_MS), true, 'due at the full 5-min window');
  _stampRetireCheck(T0 + RETIRE_RECHECK_MS);
  assert.equal(reRetireDue(T0 + RETIRE_RECHECK_MS + 1000), false, 're-armed on firing — not due 1s later');
  assert.equal(reRetireDue(T0 + 2 * RETIRE_RECHECK_MS), true, 'due again at the next window');
});

// ── 4. The release this ships in: install → version match, versioned coherently

test('c6e91d19: this fix ships as a normal self-update release (the wedged Macs heal without a manual reinstall)', () => {
  // package.json and config.ts AGENT_VERSION must agree (publish-agent-tarball
  // enforces it; pin it here so a mismatch fails BEFORE the publish step).
  assert.equal(pkgJson.version, AGENT_VERSION);
  // This release is the one that carries the stamp + verification.
  assert.match(AGENT_VERSION, /^0\.9\.([4-9]|\d+)/);
  // And the wait loop verifies against the tree's OWN package.json — so the
  // assertion "install → the running agent reports the installed version"
  // holds for EVERY future release without editing install.sh. 0.9.4 (D-1):
  // the path crosses via $ENV, never interpolation (an apostrophe in the
  // tree path broke the JS literal).
  assert.match(installSh, /EXPECTED_VERSION="\$\(AGENT_DIR="\$AGENT_DIR" node -p "require\(process\.env\.AGENT_DIR \+ '\/package\.json'\)\.version"/);
});

// ── helpers ───────────────────────────────────────────────────────────────────

function mkHome(name) {
  const dir = join(process.env.RUNNER_TEMP || '/tmp', `c6e91d19-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Keep execFileSync referenced for parity with the sibling suites' idiom.
void execFileSync;

// ── 5. EXECUTED harness (0.9.4): the post-merge review defects, replayed ─────
//
// The source-byte pins above could NOT catch D-1/D-2/D-3 (advisory 3 of the
// post-merge adversarial review of 5e8d73fc — all three defects shipped
// through a green suite that pinned bytes but never ran the block). This
// section EXTRACTS install.sh's exact load+verify block and EXECUTES it under
// bash with a faked `launchctl` (no-op) and a faked `sleep` that plays the
// agent: on its Nth call it writes the stamp a real runLoop would. CI (Linux)
// replays the deterministic core this way; launchd itself stays Mac-only.

const BLOCK_START = installSh.indexOf('launchctl unload "$PLIST_DEST"');
const VERIFIED_MARK = '✓ verified: the RUNNING agent is v';
const VERIFIED_AT = installSh.indexOf(VERIFIED_MARK);
const verifyBlock = (() => {
  assert.ok(BLOCK_START > 0, 'install.sh has the unload line');
  assert.ok(VERIFIED_AT > BLOCK_START, 'install.sh has the success echo after the load');
  return installSh.slice(BLOCK_START, installSh.indexOf('\n', VERIFIED_AT) + 1);
})();

/** A pid that is ALIVE for the duration of the test (kill -0 must see it). */
function livePid() {
  const child = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  return { pid: child.pid, stop: () => child.kill('SIGKILL') };
}

/** A pid that is provably DEAD right now (spawned, killed, reaped). */
async function deadPid() {
  const child = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  const pid = child.pid;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

/**
 * Build the sandbox and run install.sh's extracted block in it.
 *   agentDir       the tree the "installer" runs in (gets a package.json)
 *   stampAt        the fake sleep call-count at which the "agent" stamps (999999 = never)
 *   stampPid       pid written into the stamp
 *   stampEntry     entry written into the stamp (the agent realpaths __dirname);
 *                  omit for the honest default `${tree}/dist/index.js`
 *   seedStamp      optional stamp JSON planted BEFORE the run (the stale stamp)
 *   execute        false = build the sandbox only (no run — for re-invocation tests)
 */
function runBlock(name, { agentDir, stampAt, stampPid, stampEntry, seedStamp, execute = true }) {
  const root = mkHome(`exec-${name}`);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const tree = join(root, agentDir);
  const stampPath = join(home, '.config', 'digby-agent', 'running-agent.json');
  mkdirSync(join(bin), { recursive: true });
  mkdirSync(join(home, '.config', 'digby-agent'), { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'digby-imessage-agent', version: pkgJson.version }, null, 2) + '\n');
  if (seedStamp) writeFileSync(stampPath, typeof seedStamp === 'function' ? seedStamp(tree) : seedStamp);

  // faked launchctl: accept every subcommand, succeed.
  writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
  // faked sleep: plays the agent — writes the stamp on its $STAMP_AT call.
  writeFileSync(
    join(bin, 'sleep'),
    [
      '#!/usr/bin/env bash',
      'n=$(cat "$SB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > "$SB_COUNT"',
      'if [[ "$n" -ge "$STAMP_AT" ]]; then',
      '  printf \'{"version":"%s","pid":%s,"entry":"%s","startedAt":"2026-10-23T21:00:00.000Z"}\\n\' "$STAMP_VERSION" "$STAMP_PID" "$STAMP_ENTRY" > "$STAMP_PATH"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'launchctl'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);

  const script = join(root, 'block.sh');
  writeFileSync(script, `set -euo pipefail\n${verifyBlock}`);
  // The block's full environment (returned so re-invocation tests — e.g. the
  // symlink test, which swaps AGENT_DIR for a link — can spread and override).
  const blockEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    AGENT_DIR: tree,
    PLIST_DEST: join(home, 'Library', 'LaunchAgents', 'com.digby.agent.plist'),
    LOG_DIR: join(home, 'Library', 'Logs', 'digby-agent'),
    LABEL: 'com.digby.agent',
    STAMP_PATH: stampPath,
    STAMP_AT: String(stampAt),
    STAMP_VERSION: pkgJson.version,
    STAMP_PID: String(stampPid),
    // The honest default: the agent realpaths __dirname into entry.
    STAMP_ENTRY: stampEntry ?? `${tree}/dist/index.js`,
    SB_COUNT: join(root, 'sleep.count'),
  };
  if (!execute) return { res: null, root, tree, stampPath, env: blockEnv };
  const res = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: blockEnv,
  });
  return { res, root, tree, stampPath, env: blockEnv };
}

test('0.9.4/D-1 (executed): an apostrophe AND a space in the tree path still verify — the old interpolated literal falsely failed every install', () => {
  const live = livePid();
  try {
    const { res } = runBlock('d1-apostrophe', {
      agentDir: "O'Brien's Mac/agent", // D-1's exact shape: ' breaks a '…' JS literal
      stampAt: 1,
      stampPid: live.pid,
      // stampEntry omitted → the honest default: ${tree}/dist/index.js
    });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /✓ verified: the RUNNING agent is v/);
  } finally {
    live.stop();
  }
});

test('0.9.4/D-2 (executed): a pre-seeded SAME-VERSION stamp from a dead pid can no longer satisfy the verification — the old block printed success with nothing running', async () => {
  const dead = await deadPid();
  try {
    const live = livePid();
    try {
      // Wedged-Mac shape: the stamp names THIS tree's version+entry but its
      // writer is long gone, and nothing new ever starts.
      const { res } = runBlock('d2-stale-stamp', {
        agentDir: 'agent',
        stampAt: 999999, // nothing comes up
        stampPid: live.pid, // (unused — nothing writes)
        seedStamp: (tree) => JSON.stringify({ version: pkgJson.version, pid: dead, entry: `${tree}/dist/index.js`, startedAt: '2026-10-23T00:00:00.000Z' }),
      });
      assert.notEqual(res.status, 0, 'the block must FAIL when only a dead process\'s stamp exists');
      assert.ok(`${res.stdout}${res.stderr}`.includes('THE AGENT DID NOT COME UP'), 'the failure is loud');
      assert.ok(!`${res.stdout}${res.stderr}`.includes(VERIFIED_MARK), 'no false ✓ verified');
    } finally {
      live.stop();
    }
  } finally {
    void dead;
  }
});

test('0.9.4/D-2 complement (executed): over a stale OLD stamp, a real start still verifies — invalidating the stamp did not break the honest path', () => {
  const live = livePid();
  try {
    const { res } = runBlock('d2-honest-path', {
      agentDir: 'agent',
      stampAt: 1, // the new process stamps on the first sleep tick
      stampPid: live.pid,
      // stampEntry omitted → the honest default (${tree}/dist/index.js)
      seedStamp: JSON.stringify({ version: '0.6.3', pid: 999, entry: '/Applications/Digby.app/Contents/Resources/imessage-agent/dist/index.js', startedAt: '2026-06-01T00:00:00.000Z' }),
    });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /✓ verified: the RUNNING agent is v/);
  } finally {
    live.stop();
  }
});

test('0.9.4/D-3 (executed): a symlinked invocation verifies against the agent\'s realpath entry', () => {
  const live = livePid();
  try {
    // Build the sandbox only (no first execution — the AGENT_DIR env would be
    // the real tree, not the link), then hand the block a SYMLINK to the tree
    // as its AGENT_DIR: the agent realpaths __dirname, so the stamp names the
    // REAL tree while $AGENT_DIR stays logical.
    const base = runBlock('d3-symlink', {
      agentDir: 'real-agent',
      stampAt: 999999,
      stampPid: live.pid,
      stampEntry: 'unused',
      execute: false,
    });
    const realTree = base.tree;
    const linkTree = join(base.root, 'link-agent');
    spawnSync('ln', ['-s', realTree, linkTree]);
    // The agent starts from the LINK but realpaths __dirname to the REAL
    // tree: its stamp (written by the first sleep tick — AFTER the block's
    // pre-load invalidation, like a real launchd start) names the realpath
    // while $AGENT_DIR stays logical. The OLD matcher compared the logical
    // path only and falsely failed; 0.9.4 accepts AGENT_DIR_REAL.
    const res = spawnSync('bash', [join(base.root, 'block.sh')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...base.env, AGENT_DIR: linkTree, STAMP_AT: '1', STAMP_ENTRY: `${realTree}/dist/index.js` },
    });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /✓ verified: the RUNNING agent is v/);
  } finally {
    live.stop();
  }
});

test('0.9.4 live-pid guard (executed): a FRESHLY WRITTEN stamp naming a dead pid never verifies', async () => {
  const dead = await deadPid();
  try {
    const live = livePid();
    try {
      const { res } = runBlock('live-pid-guard', {
        agentDir: 'agent',
        stampAt: 1, // the "agent" stamps immediately…
        stampPid: dead, // …but names a pid that is already gone
        // stampEntry omitted → the honest default (${tree}/dist/index.js)
      });
      assert.notEqual(res.status, 0, 'a stamp whose writer is dead must not verify');
      assert.ok(`${res.stdout}${res.stderr}`.includes('THE AGENT DID NOT COME UP'));
      assert.ok(!`${res.stdout}${res.stderr}`.includes(VERIFIED_MARK));
    } finally {
      live.stop();
    }
  } finally {
    void dead;
  }
});
