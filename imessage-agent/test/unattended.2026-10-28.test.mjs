/**
 * "Unattended / Autonomous use" macOS preset — tests (2026-10-28, owner request
 * on card oq_f7955582: "how can you fix this for all mac and windows clients to
 * give full remote login permissions etc").
 *
 * The incident class: macOS puts the login window BELOW every TCC permission, so
 * a Mac that reboots / sleeps into a lock strands the fleet behind a screen only
 * a human finger can clear. Three owner cards in one day asked for that act.
 *
 * WHAT IS PINNED HERE (all pure — runs on Linux CI, no Mac, no sudo):
 *   1. The fdesetup / defaults / pmset / pwpolicy / console parsers against the
 *      LIVE output shapes.
 *   2. The verdict: FileVault is a hard blocker; drift only when auto-login is
 *      gone; unknown values NEVER become blockers OR readiness.
 *   3. The wire value ('on,ok' / 'on,filevault' / '' = advertise nothing).
 *   4. /etc/kcpassword encoding (Apple's XOR key + NUL + zero pad).
 *   5. applyMacPreset REFUSES on FileVault and on missing sudo WITHOUT touching
 *      the machine (no half-configure), and captures the revert backup.
 *   6. revertMacPreset restores the captured values (never a guessed default).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const {
  parseFdesetupStatus,
  parseIntSetting,
  parseAutoLoginUser,
  parsePmsetCustom,
  pmsetEffective,
  parsePasswordExpiry,
  parseFastUserSwitching,
  consoleIsAtLoginWindow,
  evaluateMacUnattended,
  unattendedAdvertValue,
  encodeKcPassword,
  KCPASSWORD_KEY,
  probeMacUnattended,
  captureMacBackup,
  applyMacPreset,
  revertMacPreset,
  UnattendedRefusal,
  BLOCKER_ORDER,
  BLOCKER_TEXT,
} = await import(join(pkgRoot, 'dist', 'unattended.js'));

/** A snapshot with nothing set — each test flips the fields it cares about. */
function snap(over = {}) {
  return {
    user: 'paul',
    fileVaultOn: false,
    autoLoginUser: 'paul',
    kcPasswordExists: true,
    askForPassword: 0,
    askForPasswordDelay: 0,
    idleTime: 0,
    sleepMinutes: 0,
    powerNap: 0,
    fastUserSwitching: false,
    passwordExpires: false,
    atLoginScreen: false,
    enabled: true,
    canAdmin: true,
    ...over,
  };
}

/** A scripted command runner: `handler(cmd, args)` → {stdout, code}. */
function fakeIo(handler) {
  const calls = [];
  return {
    calls,
    async run(cmd, args, opts) {
      calls.push([cmd, ...(args || [])].join(' '));
      const out = await handler(cmd, args || [], opts);
      return out ?? { stdout: '', code: 1 };
    },
  };
}

// ── 1. Parsers, against the real output shapes ───────────────────────────────

test('parseFdesetupStatus: On / Off / paused / garbage', () => {
  assert.equal(parseFdesetupStatus('FileVault is On.'), true);
  assert.equal(parseFdesetupStatus('FileVault is Off.'), false);
  assert.equal(parseFdesetupStatus('FileVault is On, but encryption is paused.'), true);
  assert.equal(parseFdesetupStatus(''), null);
  assert.equal(parseFdesetupStatus('something else entirely'), null);
});

test('parseIntSetting / parseAutoLoginUser: values, unset keys, defaults chatter', () => {
  assert.equal(parseIntSetting('0\n'), 0);
  assert.equal(parseIntSetting('  300  '), 300);
  assert.equal(parseIntSetting(''), null);
  assert.equal(parseIntSetting('not a number'), null);

  assert.equal(parseAutoLoginUser('paul\n'), 'paul');
  assert.equal(parseAutoLoginUser('"paul"\n'), 'paul');
  assert.equal(parseAutoLoginUser(''), null);
  // the exact defaults CLI failure line for a missing key
  assert.equal(
    parseAutoLoginUser('The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist'),
    null,
  );
});

test('parsePmsetCustom: AC and Battery sections are kept apart; effective prefers AC', () => {
  const out = [
    'Battery Power:',
    ' sleep                10',
    ' displaysleep         2',
    ' disksleep            10',
    ' powernap             0',
    'AC Power:',
    ' sleep                0',
    ' displaysleep         5',
    ' disksleep            0',
    ' powernap             0',
  ].join('\n');
  const p = parsePmsetCustom(out);
  assert.equal(p.ac.sleep, 0);
  assert.equal(p.battery.sleep, 10);
  assert.equal(pmsetEffective(p, 'sleep'), 0, 'AC wins — an unattended Mac is plugged in');
  assert.equal(pmsetEffective(p, 'displaysleep'), 5);
  assert.equal(pmsetEffective(p, 'nonexistent'), null);

  // A desktop Mac reports AC only — Battery absence must not blind the read.
  const desktop = parsePmsetCustom('AC Power:\n sleep                0\n powernap             0\n');
  assert.equal(pmsetEffective(desktop, 'sleep'), 0);
  assert.equal(pmsetEffective(desktop, 'powernap'), 0);
});

test('parsePasswordExpiry: maxMinutesUntilChangePassword, the 10.13+ categories, and no-policy', () => {
  assert.equal(
    parsePasswordExpiry('<?xml version="1.0"?><plist><dict><key>policyCategoryPasswordChange</key><array><dict/></array></dict></plist>'),
    true,
  );
  assert.equal(parsePasswordExpiry('<key>maxMinutesUntilChangePassword</key>\n<integer>0</integer>'), false);
  assert.equal(parsePasswordExpiry('<key>maxMinutesUntilChangePassword</key>\n<integer>5184000</integer>'), true);
  assert.equal(parsePasswordExpiry('<key>policyAttributeMaximumPasscodeAge</key>'), true);
  assert.equal(parsePasswordExpiry(''), null, 'an unreadable policy is UNKNOWN — never a blocker');
});

test('parseFastUserSwitching / consoleIsAtLoginWindow', () => {
  assert.equal(parseFastUserSwitching('1\n'), true);
  assert.equal(parseFastUserSwitching('1\n'), true);
  assert.equal(parseFastUserSwitching('0\n'), false);
  assert.equal(parseFastUserSwitching(''), null);

  assert.equal(consoleIsAtLoginWindow('_windowserver\n'), true);
  assert.equal(consoleIsAtLoginWindow('loginwindow\n'), true);
  assert.equal(consoleIsAtLoginWindow('root\n'), true);
  assert.equal(consoleIsAtLoginWindow('paul\n'), false);
  assert.equal(consoleIsAtLoginWindow(''), null);
});

// ── 2. The verdict ───────────────────────────────────────────────────────────

test('evaluate: a fully configured Mac is OK (the shipped-ready state)', () => {
  const v = evaluateMacUnattended(snap());
  assert.deepEqual(v, { enabled: true, blockers: [] });
  assert.equal(unattendedAdvertValue(snap()), 'on,ok');
});

test('evaluate: FileVault is a HARD blocker and outranks everything else', () => {
  const v = evaluateMacUnattended(snap({ fileVaultOn: true, askForPassword: 1, atLoginScreen: true }));
  assert.equal(v.blockers[0], 'filevault', 'the physical impossibility is reported first');
  assert.ok(v.blockers.includes('lock'));
  assert.ok(v.blockers.includes('locked'));
  assert.equal(unattendedAdvertValue(snap({ fileVaultOn: true })), 'on,filevault');
});

test('evaluate: a not-enabled Mac SAYS SO (`off`) instead of advertising nothing', () => {
  const v = evaluateMacUnattended(snap({ enabled: false }));
  assert.equal(v.enabled, false);
  // TICKET 11b6974f: '' made "the owner never turned this on" and "this build
  // cannot report the preset" the same bytes, so every device read the fleet's
  // "never reported by this build — update the agent" sentence. `off` is a
  // positive claim, and the fleet verdict finally distinguishes the two.
  assert.equal(unattendedAdvertValue(snap({ enabled: false })), 'off');
});

test('evaluate: a NOT-enabled Mac still advertises a LIVE login-window lock (ticket c468f922)', () => {
  // The incident's device class: never opted in, sitting at the login window.
  // Suppressing the live lock here made the fleet-side pre-login gate
  // unreachable for exactly the Macs it needed to protect.
  assert.equal(unattendedAdvertValue(snap({ enabled: false, atLoginScreen: true })), 'off,locked');
  // The bare token carries NO `on` — the fleet verdict gates on `enabled`
  // first, so this still reads "preset not enabled", never a false ready.
  assert.equal(evaluateMacUnattended(snap({ enabled: false, atLoginScreen: true })).enabled, false);
  // Preset-shaped blockers stay suppressed when not opted in (they are
  // guidance about a preset the user never enabled).
  assert.equal(unattendedAdvertValue(snap({ enabled: false, askForPassword: 1, sleepMinutes: 30 })), 'off');
});

test('evaluate: enabled but auto-login missing → autologin (+ drift when other keys also reverted)', () => {
  const v = evaluateMacUnattended(snap({ autoLoginUser: null }));
  assert.deepEqual(v.blockers, ['autologin']);

  // kcpassword missing is the same class — the user name alone cannot log in.
  assert.deepEqual(evaluateMacUnattended(snap({ kcPasswordExists: false })).blockers, ['autologin']);

  // The macOS-UPDATE story: auto-login gone AND the lock key back to 1.
  const reset = evaluateMacUnattended(snap({ autoLoginUser: null, askForPassword: 1 }));
  assert.ok(reset.blockers.includes('drift'), 'a macOS update reset must be named as drift, not just "locked"');
  assert.ok(reset.blockers.includes('lock'));
});

test('evaluate: lock / sleep / fast-user / pwd-expiry / locked each name their own reason', () => {
  assert.deepEqual(evaluateMacUnattended(snap({ askForPassword: 1 })).blockers, ['lock']);
  assert.deepEqual(evaluateMacUnattended(snap({ idleTime: 300 })).blockers, ['lock']);
  assert.deepEqual(evaluateMacUnattended(snap({ sleepMinutes: 10 })).blockers, ['sleep']);
  assert.deepEqual(evaluateMacUnattended(snap({ powerNap: 1 })).blockers, ['sleep']);
  assert.deepEqual(evaluateMacUnattended(snap({ fastUserSwitching: true })).blockers, ['fast-user']);
  assert.deepEqual(evaluateMacUnattended(snap({ passwordExpires: true })).blockers, ['pwd-expiry']);
  assert.deepEqual(evaluateMacUnattended(snap({ atLoginScreen: true })).blockers, ['locked']);
  assert.deepEqual(evaluateMacUnattended(snap({ canAdmin: false })).blockers, ['no-admin']);
});

test('evaluate: an UNKNOWN value is never a blocker (null ≠ broken)', () => {
  const v = evaluateMacUnattended(snap({
    fileVaultOn: null, kcPasswordExists: null, askForPassword: null, idleTime: null,
    sleepMinutes: null, powerNap: null, fastUserSwitching: null, passwordExpires: null,
    atLoginScreen: null, canAdmin: null,
  }));
  assert.deepEqual(v.blockers, [], 'unreadable keys must not fabricate a blocker');
  // …and an unknown never fabricates DRIFT either, even with auto-login missing.
  assert.deepEqual(evaluateMacUnattended(snap({ autoLoginUser: null, askForPassword: null, idleTime: null })).blockers, ['autologin']);
});

test('the blocker vocabulary matches the fleet order (first reason a lane reads)', () => {
  assert.deepEqual(BLOCKER_ORDER, [
    'filevault', 'autologin', 'drift', 'no-admin', 'pwd-expiry', 'fast-user', 'lock', 'sleep', 'locked',
  ]);
  for (const b of BLOCKER_ORDER) assert.ok(BLOCKER_TEXT[b] && BLOCKER_TEXT[b].length > 10, `no text for ${b}`);
});

// ── 3. kcpassword encoding ───────────────────────────────────────────────────

test('encodeKcPassword: Apple key, NUL terminator, zero pad to a whole key block', () => {
  assert.equal(KCPASSWORD_KEY.length, 11);
  const enc = encodeKcPassword('pw');
  assert.equal(enc.length, 11, '3 bytes (p,w,NUL) padded up to one whole key block');
  assert.equal(enc[0], 'p'.charCodeAt(0) ^ KCPASSWORD_KEY[0]);
  assert.equal(enc[1], 'w'.charCodeAt(0) ^ KCPASSWORD_KEY[1]);
  assert.equal(enc[2], 0 ^ KCPASSWORD_KEY[2], 'the NUL terminator is XORed too');
  assert.equal(enc[3], KCPASSWORD_KEY[3], 'zero padding XORs to the key itself');
  // A password EXACTLY filling a block (10 chars + NUL = 11) stays one block;
  // one byte more pads to TWO.
  assert.equal(encodeKcPassword('0123456789').length, 11);
  assert.equal(encodeKcPassword('0123456789x').length, 22);
});

// ── 4. probeMacUnattended: one failed read never blinds the rest ─────────────

test('probeMacUnattended: assembles the snapshot from the real commands, degrading per key', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'fdesetup status') return { stdout: 'FileVault is Off.', code: 0 };
    if (line === 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser') return { stdout: 'paul\n', code: 0 };
    if (line === 'test -f /etc/kcpassword') return { stdout: '', code: 0 };
    if (line === 'defaults read com.apple.screensaver askForPassword') return { stdout: '0\n', code: 0 };
    if (line === 'defaults read com.apple.screensaver askForPasswordDelay') return { stdout: '0\n', code: 0 };
    if (line === 'defaults -currentHost read com.apple.screensaver idleTime') return { stdout: '0\n', code: 0 };
    if (line === 'pmset -g custom') return { stdout: 'AC Power:\n sleep                0\n powernap             0\n', code: 0 };
    if (line.startsWith('pwpolicy')) return { stdout: '', code: 1 }; // unreadable → null
    if (line.startsWith('defaults read com.apple.loginwindow ShowUserList')) return { stdout: '0\n', code: 0 };
    if (line.startsWith('stat -f %Su /dev/console')) return { stdout: 'paul\n', code: 0 };
    if (line === 'sudo -n true') return { stdout: '', code: 0 };
    return { stdout: '', code: 1 };
  });
  const s = await probeMacUnattended(io, { user: 'paul', enabled: true });
  assert.equal(s.fileVaultOn, false);
  assert.equal(s.autoLoginUser, 'paul');
  assert.equal(s.kcPasswordExists, true);
  assert.equal(s.sleepMinutes, 0);
  assert.equal(s.passwordExpires, null, 'an unreadable policy stays unknown');
  assert.equal(s.atLoginScreen, false);
  assert.equal(s.canAdmin, true);
  assert.deepEqual(evaluateMacUnattended(s).blockers, [], 'the fully-configured Mac is ready');
});

test('probeMacUnattended: a missing kcpassword reads false (not "unknown")', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'test -f /etc/kcpassword') return { stdout: '', code: 1 };
    return { stdout: '', code: 1 };
  });
  const s = await probeMacUnattended(io, { user: 'paul', enabled: true });
  assert.equal(s.kcPasswordExists, false);
});

// ── 5. apply / revert ────────────────────────────────────────────────────────

test('applyMacPreset REFUSES on FileVault and changes NOTHING (never half-configure)', async () => {
  const io = fakeIo((cmd, args) => {
    if ([cmd, ...args].join(' ') === 'fdesetup status') return { stdout: 'FileVault is On.', code: 0 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyMacPreset(io, { user: 'paul', password: 'pw' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'filevault' && /FileVault is ON/.test(e.message) && /Nothing was changed/.test(e.message),
  );
  // The ONLY command that ran was the read.
  assert.deepEqual(io.calls, ['fdesetup status']);
});

test('applyMacPreset REFUSES without sudo rights, still touching nothing', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'fdesetup status') return { stdout: 'FileVault is Off.', code: 0 };
    if (line === 'sudo -n true') return { stdout: '', code: 1 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyMacPreset(io, { user: 'paul', password: 'pw' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'no-admin',
  );
  assert.ok(!io.calls.some((c) => c.includes('kcpassword')), 'no write happened');
});

test('applyMacPreset REFUSES with no password (auto-login needs it)', async () => {
  const io = fakeIo(() => ({ stdout: '', code: 0 }));
  await assert.rejects(
    () => applyMacPreset(io, { user: 'paul', password: '' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'autologin',
  );
  assert.deepEqual(io.calls, [], 'not even a read — the refusal is decided first');
});

test('applyMacPreset: writes auto-login + the never-lock keys + pmset, and captures the backup', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'fdesetup status') return { stdout: 'FileVault is Off.', code: 0 };
    if (line === 'sudo -n true') return { stdout: '', code: 0 };
    // pre-change values
    if (line === 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser') return { stdout: '', code: 1 };
    if (line === 'test -f /etc/kcpassword') return { stdout: '', code: 1 };
    if (line === 'defaults read com.apple.screensaver askForPassword') return { stdout: '1\n', code: 0 };
    if (line === 'defaults read com.apple.screensaver askForPasswordDelay') return { stdout: '60\n', code: 0 };
    if (line === 'defaults -currentHost read com.apple.screensaver idleTime') return { stdout: '300\n', code: 0 };
    if (line === 'pmset -g custom') return { stdout: 'AC Power:\n sleep                10\n disksleep            10\n powernap             1\n', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await applyMacPreset(io, { user: 'paul', password: 'hunter2' });
  assert.deepEqual(r.backup, {
    capturedAt: r.backup.capturedAt,
    user: 'paul',
    autoLoginUser: null,
    kcPasswordExisted: false,
    askForPassword: 1,
    askForPasswordDelay: 60,
    idleTime: 300,
    acSleep: 10,
    acDiskSleep: 10,
    acPowerNap: 1,
  });
  const all = io.calls.join('\n');
  assert.match(all, /defaults write \/Library\/Preferences\/com\.apple\.loginwindow autoLoginUser paul/);
  assert.match(all, /defaults write com\.apple\.screensaver askForPassword -int 0/);
  assert.match(all, /-currentHost write com\.apple\.screensaver idleTime -int 0/);
  assert.match(all, /pmset -a sleep 0 disksleep 0 powernap 0/);
  // The password NEVER appears in the command line — it rides a base64 of the
  // ENCODED bytes through stdin-free `sh -c` with the raw password absent.
  assert.ok(!all.includes('hunter2'), 'the plaintext password must never reach a command line');
  assert.ok(all.includes('/etc/kcpassword'));
  assert.ok(r.applied.length >= 4);
});

test('revertMacPreset: restores the captured values (and defaults where absent)', async () => {
  const io = fakeIo(() => ({ stdout: '', code: 0 }));
  const out = await revertMacPreset(io, {
    capturedAt: '2026-10-28T00:00:00Z',
    user: 'paul',
    autoLoginUser: null,
    kcPasswordExisted: false,
    askForPassword: null,
    askForPasswordDelay: null,
    idleTime: null,
    acSleep: 10,
    acDiskSleep: 10,
    acPowerNap: 1,
  });
  const all = io.calls.join('\n');
  assert.match(all, /defaults delete \/Library\/Preferences\/com\.apple\.loginwindow autoLoginUser/);
  assert.match(all, /rm -f \/etc\/kcpassword/);
  // askForPassword absent before → its EFFECTIVE default 1 comes back (never
  // left at the preset's 0).
  assert.match(all, /defaults write com\.apple\.screensaver askForPassword -int 1/);
  assert.match(all, /pmset -a sleep 10 disksleep 10 powernap 1/);
  assert.ok(out.reverted.length >= 3);
});

test('captureMacBackup records values only — the shape has no field that could hold a secret', async () => {
  const io = fakeIo(() => ({ stdout: '', code: 0 }));
  const b = await captureMacBackup(io, 'paul');
  const keys = Object.keys(b).sort();
  assert.deepEqual(keys, [
    'acDiskSleep', 'acPowerNap', 'acSleep', 'askForPassword', 'askForPasswordDelay',
    'autoLoginUser', 'capturedAt', 'idleTime', 'kcPasswordExisted', 'user',
  ]);
  for (const k of keys) assert.ok(!/^(autoLoginPassword|password|passwd)?$/i.test(k), `${k} must not carry a secret`);
});

// ── 6. Source pins on the wiring that cannot run on Linux ────────────────────

test('the run loop advertises the verdict on EVERY poll (source pin)', () => {
  const indexSrc = SRC('src/index.ts');
  assert.match(indexSrc, /unattendedAdvertValue|unattendedAdvert/, 'index.ts must compute the advert');
  assert.match(indexSrc, /&?unattended/, 'and hand it to the poll');
  const apiSrc = SRC('src/api.ts');
  assert.match(apiSrc, /unattended/, 'api.ts pollCommand must carry the param');
});

test('the agent never transmits the password: no network client imports the unattended module', () => {
  const apiSrc = SRC('src/api.ts');
  assert.ok(!/from '\.\/unattended'/.test(apiSrc), 'api.ts must never import the preset module (the password must not reach a request body)');
});