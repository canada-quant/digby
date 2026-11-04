/**
 * "Unattended / Autonomous use" Windows preset — tests (2026-10-28, owner
 * request on card oq_f7955582: "how can you fix this for all mac and windows
 * clients to give full remote login permissions etc … required for most users
 * to use their remote devices autonomously").
 *
 * All PURE: every parser runs against the REAL Windows output shapes on Linux
 * CI; the apply/revert paths run against a scripted IO that records the exact
 * commands, so the SECURITY invariants are pinned rather than described:
 *   - the password never appears in a command line, an argument or a file;
 *   - the LSA secret is the storage (not the plaintext DefaultPassword value);
 *   - a hard blocker refuses BEFORE anything is written;
 *   - the kill switch restores the captured values.
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
  parseBitlockerPinProtector,
  parseBitlockerOn,
  parseCredentialGuard,
  parseRegValue,
  parseRegDword,
  parsePowercfgAcIndexSeconds,
  parsePasswordExpiry,
  parseDomainManaged,
  parseHelloOnly,
  parseAtLockScreen,
  parseElevated,
  evaluateWinUnattended,
  unattendedAdvertValue,
  probeWinUnattended,
  captureWinBackup,
  applyWinPreset,
  revertWinPreset,
  buildLsaStoreScript,
  buildLsaClearScript,
  buildKeepAwakeCommand,
  planConsoleReattach,
  buildConsoleReattachCommand,
  UnattendedRefusal,
  BLOCKER_ORDER,
  BLOCKER_TEXT,
} = await import(join(pkgRoot, 'dist', 'unattended.js'));

function snap(over = {}) {
  return {
    user: 'paul',
    bitlockerPin: false,
    credentialGuard: false,
    autoAdminLogon: true,
    defaultUserName: 'paul',
    lsaSecretPresent: true,
    noLockScreen: true,
    inactivityTimeoutSecs: 0,
    screensaverSecure: false,
    acStandbyMinutes: 0,
    helloOnly: false,
    domainPolicy: false,
    atLockScreen: false,
    passwordNeverExpires: true,
    elevated: true,
    enabled: true,
    ...over,
  };
}

function fakeIo(handler) {
  const calls = [];
  return {
    calls,
    async run(cmd, args, opts) {
      const line = [cmd, ...(args || [])].join(' ');
      calls.push({ line, stdin: opts?.stdin });
      const out = await handler(cmd, args || [], opts);
      return out ?? { stdout: '', code: 1 };
    },
  };
}

// ── 1. Parsers against the real Windows output shapes ───────────────────────

test('parseBitlockerPinProtector: TPM+PIN and a Password protector are pre-boot; TPM-only is not', () => {
  assert.equal(parseBitlockerPinProtector('      TPM And PIN\n'), true);
  // manage-bde's "Password:" protector makes the volume ask at startup — the
  // same pre-Windows stop as a TPM PIN, so it is a blocker too.
  assert.equal(parseBitlockerPinProtector('Password:\n  ID: {abc}\n'), true);
  assert.equal(parseBitlockerPinProtector('Numerical Password:\n  ID: {x}\n  Password protects the OS volume at startup.\n'), true);
  assert.equal(parseBitlockerPinProtector('      TPM Only\n'), false);
  assert.equal(parseBitlockerPinProtector('  Conversion Status:    Fully Decrypted\n'), false);
  assert.equal(parseBitlockerPinProtector(''), null);
});

test('parseBitlockerOn: distinguishes "no BitLocker" from "BitLocker without a PIN"', () => {
  assert.equal(parseBitlockerOn('  Conversion Status:    Fully Encrypted\n'), true);
  assert.equal(parseBitlockerOn('  Conversion Status:    Fully Decrypted\n'), false);
  assert.equal(parseBitlockerOn('  Protection Status: Protection On\n'), true);
  assert.equal(parseBitlockerOn('  Protection Status: Protection Off\n'), false);
  assert.equal(parseBitlockerOn('nonsense'), null);
});

test('parseCredentialGuard: SecurityServicesRunning list (2 = Credential Guard), msinfo32 text, LsaCfgFlags', () => {
  assert.equal(parseCredentialGuard('2'), true);
  assert.equal(parseCredentialGuard('1,2'), true);
  assert.equal(parseCredentialGuard('1'), false, 'HVCI alone is not Credential Guard');
  assert.equal(parseCredentialGuard(''), null);
  assert.equal(parseCredentialGuard('Credential Guard:  Running'), true);
  assert.equal(parseCredentialGuard('Credential Guard:  Not Running'), false);
  assert.equal(parseCredentialGuard('"LsaCfgFlags"=dword:00000001'), true);
  assert.equal(parseCredentialGuard('"LsaCfgFlags"=dword:00000000'), false);
});

test('parseRegValue / parseRegDword: REG_SZ, hex DWORD, and the missing-value ERROR line', () => {
  assert.equal(parseRegValue('    AutoAdminLogon    REG_SZ    1'), '1');
  assert.equal(parseRegValue('    DefaultUserName    REG_SZ    paul'), 'paul');
  assert.equal(parseRegValue('    NoLockScreen    REG_DWORD    0x1'), '0x1');
  assert.equal(parseRegValue('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseRegValue(''), null);

  assert.equal(parseRegDword('    NoLockScreen    REG_DWORD    0x1'), 1);
  assert.equal(parseRegDword('    InactivityTimeoutSecs    REG_DWORD    0x0'), 0, 'a 0 IS a value — not "unset"');
  assert.equal(parseRegDword('    InactivityTimeoutSecs    REG_DWORD    0x384'), 900);
  assert.equal(parseRegDword('ERROR: not found'), null);
});

test('parsePowercfgAcIndexSeconds: the AC index is hex seconds', () => {
  const out = [
    '  Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Standby timeout)',
    '    Possible Setting Index: 0000000000000000',
    '  Current AC Power Setting Index: 0x00000000',
    '  Current DC Power Setting Index: 0x00000384',
  ].join('\n');
  assert.equal(parsePowercfgAcIndexSeconds(out), 0);
  assert.equal(parsePowercfgAcIndexSeconds('  Current AC Power Setting Index: 0x00000258'), 600, '600 s = 10 min');
  assert.equal(parsePowercfgAcIndexSeconds(''), null);
});

test('parsePasswordExpiry: net accounts "Maximum password age" and PasswordExpires', () => {
  assert.equal(parsePasswordExpiry('Maximum password age (days):                          42'), true);
  assert.equal(parsePasswordExpiry('Maximum password age (days):                          0'), false);
  assert.equal(parsePasswordExpiry('Maximum password age (days):                          Unlimited'), false);
  assert.equal(parsePasswordExpiry('PasswordExpires : True'), true);
  assert.equal(parsePasswordExpiry(''), null);
});

test('parseDomainManaged: Entra join, domain join, MDM enrolment, and a clean workgroup', () => {
  assert.equal(parseDomainManaged('AzureAdJoined : YES'), true);
  assert.equal(parseDomainManaged('DomainJoined : YES'), true);
  assert.equal(parseDomainManaged('AzureAdJoined : NO\nDomainJoined : NO'), false);
  assert.equal(parseDomainManaged('Workgroup: WORKGROUP'), false);
  assert.equal(parseDomainManaged(''), null);
});

test('parseHelloOnly: UsePassportForWork=0 is a Hello-only policy; other keys read are NOT', () => {
  assert.equal(parseHelloOnly('    UsePassportForWork    REG_DWORD    0x0'), true);
  assert.equal(parseHelloOnly('    Enabled    REG_DWORD    0x0'), true);
  assert.equal(parseHelloOnly('    UsePassportForWork    REG_DWORD    0x1'), false);
  assert.equal(parseHelloOnly(''), null);
});

test('parseAtLockScreen: an Active console session is unlocked; Disc / no session is not', () => {
  assert.equal(parseAtLockScreen(' USERNAME              SESSIONNAME        ID  STATE   \n>paul                  console             1  Active'), false);
  assert.equal(parseAtLockScreen(' USERNAME              SESSIONNAME        ID  STATE   \n paul                  console             1  Disc'), true);
  assert.equal(parseAtLockScreen('No User exists for *'), true);
  assert.equal(parseAtLockScreen(''), null);
});

test('parseElevated: the mandatory-label line decides', () => {
  assert.equal(parseElevated('Mandatory Label\\High Mandatory Level\\Label S-1-16-12288'), true);
  assert.equal(parseElevated('Mandatory Label\\Medium Mandatory Level\\Label S-1-16-8192'), false);
  assert.equal(parseElevated(''), null);
});

// ── 2. The verdict ───────────────────────────────────────────────────────────

test('evaluate: a fully configured PC is OK (the shipped-ready state)', () => {
  assert.deepEqual(evaluateWinUnattended(snap()), { enabled: true, blockers: [] });
  assert.equal(unattendedAdvertValue(snap()), 'on,ok');
});

test('evaluate: every hard blocker outranks every setting', () => {
  for (const [field, token] of [
    ['bitlockerPin', 'bitlocker-pin'],
    ['credentialGuard', 'credguard'],
    ['helloOnly', 'hello'],
    ['domainPolicy', 'domain-policy'],
  ]) {
    const v = evaluateWinUnattended(snap({ [field]: true, noLockScreen: false, atLockScreen: true }));
    assert.equal(v.blockers[0], token, `${field} must be the FIRST reason a lane reads`);
    assert.equal(unattendedAdvertValue(snap({ [field]: true })), `on,${token}`);
  }
});

test('evaluate: a NOT-enabled PC SAYS SO (`off`) instead of advertising nothing', () => {
  assert.equal(evaluateWinUnattended(snap({ enabled: false })).enabled, false);
  // TICKET 11b6974f: '' made "the owner never turned this on" and "this agent
  // build cannot report the preset" the SAME bytes on the wire, so the fleet
  // rendered its "never reported by this build — update the agent" sentence on
  // every paired device regardless of the owner's toggle. `off` is a positive
  // claim about a measured state, which is what finally distinguishes them.
  assert.equal(unattendedAdvertValue(snap({ enabled: false })), 'off');
});

test('evaluate: a NOT-enabled PC still advertises a LIVE lock screen (ticket c468f922)', () => {
  // Same rule as macOS: "nobody is signed in / the session is locked right now"
  // is a fact about the DEVICE, and it is the one a dispatch lane needs in
  // order to refuse instead of burning a run on a PC it can never type into.
  assert.equal(unattendedAdvertValue(snap({ enabled: false, atLockScreen: true })), 'off,locked');
  // No `on` token — the fleet verdict gates on `enabled` first, so this never
  // reads as a false ready.
  assert.equal(evaluateWinUnattended(snap({ enabled: false, atLockScreen: true })).enabled, false);
  // Preset-shaped blockers stay suppressed when the user never opted in.
  assert.equal(unattendedAdvertValue(snap({ enabled: false, sleepMinutes: 30 })), 'off');
});

test('evaluate: auto-logon needs ALL THREE (AutoAdminLogon + DefaultUserName + the LSA secret)', () => {
  assert.deepEqual(evaluateWinUnattended(snap({ autoAdminLogon: false })).blockers, ['autologin']);
  assert.deepEqual(evaluateWinUnattended(snap({ defaultUserName: null })).blockers, ['autologin']);
  assert.deepEqual(evaluateWinUnattended(snap({ lsaSecretPresent: false })).blockers, ['autologin'],
    'the two registry values are inert without the LSA secret — the secret is the real gate');
  // the Windows-update / policy-refresh story
  const reset = evaluateWinUnattended(snap({ autoAdminLogon: false, noLockScreen: false, inactivityTimeoutSecs: 900 }));
  assert.ok(reset.blockers.includes('drift'), 'a reverted preset must be named as drift');
  assert.ok(reset.blockers.includes('lock'));
});

test('evaluate: lock / sleep / expiry / live state each name their own reason', () => {
  assert.deepEqual(evaluateWinUnattended(snap({ noLockScreen: false })).blockers, ['lock']);
  assert.deepEqual(evaluateWinUnattended(snap({ inactivityTimeoutSecs: 900 })).blockers, ['lock']);
  assert.deepEqual(evaluateWinUnattended(snap({ screensaverSecure: true })).blockers, ['lock']);
  assert.deepEqual(evaluateWinUnattended(snap({ acStandbyMinutes: 15 })).blockers, ['sleep']);
  assert.deepEqual(evaluateWinUnattended(snap({ passwordNeverExpires: false })).blockers, ['pwd-expiry']);
  assert.deepEqual(evaluateWinUnattended(snap({ elevated: false })).blockers, ['no-admin']);
  assert.deepEqual(evaluateWinUnattended(snap({ atLockScreen: true })).blockers, ['locked']);
});

test('evaluate: an UNKNOWN read is never a blocker and never fabricates drift', () => {
  const v = evaluateWinUnattended(snap({
    bitlockerPin: null, credentialGuard: null, autoAdminLogon: null, lsaSecretPresent: null,
    noLockScreen: null, inactivityTimeoutSecs: null, screensaverSecure: null, acStandbyMinutes: null,
    helloOnly: null, domainPolicy: null, atLockScreen: null, passwordNeverExpires: null, elevated: null,
  }));
  assert.deepEqual(v.blockers, []);
});

test('the vocabulary matches the fleet order and every token has text', () => {
  assert.deepEqual(BLOCKER_ORDER, [
    'bitlocker-pin', 'credguard', 'hello', 'domain-policy', 'autologin', 'drift', 'no-admin',
    'pwd-expiry', 'lock', 'sleep', 'locked',
  ]);
  for (const b of BLOCKER_ORDER) assert.ok(BLOCKER_TEXT[b] && BLOCKER_TEXT[b].length > 10, `no text for ${b}`);
});

// ── 3. probeWinUnattended ────────────────────────────────────────────────────

test('probeWinUnattended: assembles the snapshot and degrades per key', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('manage-bde -status')) return { stdout: '  Conversion Status:    Fully Decrypted\n', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: '      TPM\n', code: 0 };
    if (line.startsWith('powershell') && line.includes('DeviceGuard')) return { stdout: '0', code: 0 };
    if (line.includes('AutoAdminLogon')) return { stdout: '    AutoAdminLogon    REG_SZ    1', code: 0 };
    if (line.includes('DefaultUserName')) return { stdout: '    DefaultUserName    REG_SZ    paul', code: 0 };
    if (line.includes('Secrets')) return { stdout: 'PRESENT', code: 0 };
    if (line.includes('NoLockScreen')) return { stdout: '    NoLockScreen    REG_DWORD    0x1', code: 0 };
    if (line.includes('InactivityTimeoutSecs')) return { stdout: '    InactivityTimeoutSecs    REG_DWORD    0x0', code: 0 };
    if (line.includes('ScreenSaveSecure')) return { stdout: '    ScreenSaveSecure    REG_SZ    0', code: 0 };
    if (line.startsWith('powercfg')) return { stdout: '  Current AC Power Setting Index: 0x00000000', code: 0 };
    if (line.startsWith('reg query HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork')) return { stdout: '', code: 1 };
    if (line.startsWith('dsregcmd')) return { stdout: 'AzureAdJoined : NO\nDomainJoined : NO', code: 0 };
    if (line.startsWith('query user')) return { stdout: '>paul   console   1  Active', code: 0 };
    if (line.startsWith('net accounts')) return { stdout: 'Maximum password age (days):  Unlimited', code: 0 };
    if (line.startsWith('whoami /groups')) return { stdout: 'Mandatory Label\\High Mandatory Level', code: 0 };
    return { stdout: '', code: 1 };
  });
  const s = await probeWinUnattended(io, { user: 'paul', enabled: true });
  assert.equal(s.bitlockerPin, false, 'no BitLocker ⇒ no pre-boot PIN, regardless of protector rows');
  assert.equal(s.credentialGuard, false);
  assert.equal(s.autoAdminLogon, true);
  assert.equal(s.lsaSecretPresent, true);
  assert.equal(s.noLockScreen, true);
  assert.equal(s.atLockScreen, false);
  assert.equal(s.elevated, true);
  assert.deepEqual(evaluateWinUnattended(s).blockers, [], 'a fully-configured PC is ready');
});

test('probeWinUnattended: an unreadable key stays null (and does not block)', async () => {
  const io = fakeIo(() => ({ stdout: '', code: 1 }));
  const s = await probeWinUnattended(io, { user: 'paul', enabled: true });
  for (const k of ['bitlockerPin', 'credentialGuard', 'lsaSecretPresent', 'noLockScreen', 'acStandbyMinutes', 'elevated']) {
    assert.equal(s[k], null, `${k} must be null on an unreadable read`);
  }
  assert.deepEqual(evaluateWinUnattended(s).blockers, []);
});

// ── 4. The LSA route (security invariants) ──────────────────────────────────

test('the store script uses LsaStorePrivateData and never a plaintext DefaultPassword value', () => {
  const script = buildLsaStoreScript('paul');
  assert.match(script, /LsaStorePrivateData/, 'the LSA secret is the storage route');
  assert.match(script, /AutoAdminLogon/, 'and the non-secret Winlogon switch is set');
  assert.match(script, /DefaultUserName/);
  assert.match(script, /\[Console\]::In\s*::In\.ReadLine|\[Console\]::In\.ReadLine/, 'the password comes from stdin');
  // The plaintext registry route is the thing we deliberately do NOT use.
  assert.ok(!/New-ItemProperty[^\n]*DefaultPassword/i.test(script), 'never write DefaultPassword as a registry value');
  assert.ok(!/DefaultPassword'\s*\)?\s*-Value/i.test(script));
  // No password placeholder: the script carries no secret at all.
  assert.ok(!/hunter2/.test(script));
});

test('the store script escapes a single-quoted user name (no PowerShell injection)', () => {
  const script = buildLsaStoreScript("o'brien");
  assert.match(script, /\$user = 'o''brien'/, "a quote is doubled — the name cannot break out of the literal");
});

test('the clear script deletes the secret with a NULL PrivateData pointer', () => {
  const script = buildLsaClearScript();
  assert.match(script, /LsaStorePrivateData\(\$handle, \[ref\]\$key, \[IntPtr\]::Zero\)/);
  assert.match(script, /AutoAdminLogon[^\n]*'0'/);
  assert.match(script, /Remove-ItemProperty[^\n]*DefaultPassword/);
});

// ── 5. apply / revert ───────────────────────────────────────────────────────

test('applyWinPreset REFUSES on a BitLocker pre-boot PIN, writing nothing', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami /groups')) return { stdout: 'High Mandatory Level', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: '      TPM And PIN\n', code: 0 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyWinPreset(io, { user: 'paul', password: 'hunter2' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'bitlocker-pin' && /Nothing was changed/.test(e.message),
  );
  assert.ok(!io.calls.some((c) => c.line.includes('reg add')), 'no write happened');
  assert.ok(!io.calls.some((c) => c.stdin), 'the password was never even read');
});

test('applyWinPreset REFUSES without elevation (writes nothing)', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami /groups')) return { stdout: 'Medium Mandatory Level', code: 0 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyWinPreset(io, { user: 'paul', password: 'hunter2' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'no-admin',
  );
  assert.equal(io.calls.length, 1, 'only the elevation probe ran');
});

test('applyWinPreset REFUSES on Credential Guard and on a Hello-only policy', async () => {
  const cgIo = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami')) return { stdout: 'High Mandatory Level', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: 'TPM Only', code: 0 };
    if (line.includes('DeviceGuard')) return { stdout: '2', code: 0 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyWinPreset(cgIo, { user: 'paul', password: 'hunter2' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'credguard',
  );

  const helloIo = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami')) return { stdout: 'High Mandatory Level', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: 'TPM Only', code: 0 };
    if (line.includes('DeviceGuard')) return { stdout: '0', code: 0 };
    if (line.includes('PassportForWork')) return { stdout: '    UsePassportForWork    REG_DWORD    0x0', code: 0 };
    return { stdout: '', code: 0 };
  });
  await assert.rejects(
    () => applyWinPreset(helloIo, { user: 'paul', password: 'hunter2' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'hello',
  );
});

test('applyWinPreset: the password rides STDIN only — never an argument, never a file', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami')) return { stdout: 'High Mandatory Level', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: 'TPM Only', code: 0 };
    if (line.includes('DeviceGuard')) return { stdout: '0', code: 0 };
    if (line.includes('PassportForWork')) return { stdout: '', code: 1 };
    if (line.includes('LsaStorePrivateData')) return { stdout: 'LSA_OK', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await applyWinPreset(io, { user: 'paul', password: 'hunter2' });
  // The secret appears ONLY in the stdin slot of the LSA call.
  for (const c of io.calls) {
    assert.ok(!c.line.includes('hunter2'), `the password must never be in a command line: ${c.line}`);
  }
  const withSecret = io.calls.filter((c) => c.stdin === 'hunter2');
  assert.equal(withSecret.length, 1, 'exactly one call carries the secret, on stdin');
  assert.match(withSecret[0].line, /LsaStorePrivateData|powershell/, 'and that call is the LSA write');
  assert.ok(r.applied.some((a) => a.includes('LSA secret')));
  assert.ok(r.applied.some((a) => a.includes('NoLockScreen')));
  assert.ok(r.applied.some((a) => a.includes('InactivityTimeoutSecs')));
  assert.ok(r.applied.some((a) => a.includes('ScreenSaveSecure')));
  assert.ok(io.calls.some((c) => c.line.includes('powercfg /change standby-timeout-ac 0')), 'AC sleep off');
  assert.ok(!io.calls.some((c) => c.line.includes('powercfg /change standby-timeout-dc')), 'battery sleep is left alone (a laptop SHOULD sleep on battery)');
});

test('applyWinPreset captures the pre-change values for the revert path', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.startsWith('whoami')) return { stdout: 'High Mandatory Level', code: 0 };
    if (line.startsWith('manage-bde -protectors')) return { stdout: 'TPM Only', code: 0 };
    if (line.includes('DeviceGuard')) return { stdout: '0', code: 0 };
    if (line.includes('PassportForWork')) return { stdout: '', code: 1 };
    if (line.includes('AutoAdminLogon')) return { stdout: '    AutoAdminLogon    REG_SZ    0', code: 0 };
    if (line.includes('NoLockScreen')) return { stdout: '    NoLockScreen    REG_DWORD    0x0', code: 0 };
    if (line.includes('InactivityTimeoutSecs')) return { stdout: '    InactivityTimeoutSecs    REG_DWORD    0x384', code: 0 };
    if (line.includes('ScreenSaveSecure')) return { stdout: '    ScreenSaveSecure    REG_SZ    1', code: 0 };
    if (line.startsWith('powercfg /query')) return { stdout: '  Current AC Power Setting Index: 0x00000258', code: 0 };
    if (line.includes('Secrets')) return { stdout: 'ABSENT', code: 0 };
    if (line.includes('LsaStorePrivateData')) return { stdout: 'LSA_OK', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await applyWinPreset(io, { user: 'paul', password: 'hunter2' });
  assert.deepEqual(r.backup, {
    capturedAt: r.backup.capturedAt,
    user: 'paul',
    autoAdminLogon: '0',
    defaultUserName: null,
    noLockScreen: '0x0',
    inactivityTimeoutSecs: '0x384',
    screensaverSecure: '1',
    acStandbyMinutes: '10',
    lsaSecretExisted: false,
  });
});

test('revertWinPreset restores the captured values and clears the secret', async () => {
  const io = fakeIo((cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (line.includes('LsaStorePrivateData')) return { stdout: 'LSA_CLEARED', code: 0 };
    return { stdout: '', code: 0 };
  });
  const out = await revertWinPreset(io, {
    capturedAt: '2026-10-28T00:00:00Z',
    user: 'paul',
    autoAdminLogon: '0',
    defaultUserName: null,
    noLockScreen: '0x0',
    inactivityTimeoutSecs: '0x384',
    screensaverSecure: '1',
    acStandbyMinutes: '10',
    lsaSecretExisted: false,
  });
  const all = io.calls.map((c) => c.line).join('\n');
  assert.match(all, /NoLockScreen[^\n]*0x0/, 'the captured NoLockScreen came back');
  assert.match(all, /InactivityTimeoutSecs[^\n]*0x384/, 'the captured idle timeout came back');
  assert.match(all, /ScreenSaveSecure[^\n]*'1'|ScreenSaveSecure[^\n]*"\s*1|ScreenSaveSecure/, 'the secure screensaver came back');
  assert.match(all, /powercfg \/change standby-timeout-ac 10/);
  assert.ok(out.reverted.some((s) => /LSA secret cleared/.test(s)));
});

test('the backup shape holds values only — no field can carry a secret', async () => {
  const io = fakeIo(() => ({ stdout: '', code: 1 }));
  const b = await captureWinBackup(io, 'paul');
  assert.deepEqual(Object.keys(b).sort(), [
    'acStandbyMinutes', 'autoAdminLogon', 'capturedAt', 'defaultUserName',
    'inactivityTimeoutSecs', 'lsaSecretExisted', 'noLockScreen', 'screensaverSecure', 'user',
  ]);
});

// ── 6. keep-awake flags ─────────────────────────────────────────────────────

test('buildKeepAwakeCommand: ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED', () => {
  const { cmd, args } = buildKeepAwakeCommand();
  assert.equal(cmd, 'powershell');
  assert.ok(args.join(' ').includes('0x80000003'), 'the three flags ORed together — a wrong constant silently stops holding the PC awake');
  assert.ok(args.join(' ').includes('SetThreadExecutionState'));
});

// ── 7. Remote-unlock: the one mechanically recoverable case ─────────────────

test('planConsoleReattach: a DISCONNECTED session is re-attached to the console', () => {
  const quser = ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME\n paul                  rdp-tcp#3           2  Disc          12:04  10/28/2026 08:10';
  const plan = planConsoleReattach(quser, { enabled: true });
  assert.ok(plan, 'a Disc row must produce a plan');
  assert.equal(plan.sessionId, 2);
  assert.deepEqual(plan.args, ['2', '/dest:console']);
  assert.match(plan.reason, /DISCONNECTED/);
  assert.deepEqual(buildConsoleReattachCommand(plan), { cmd: 'tscon', args: ['2', '/dest:console'] });
});

test('planConsoleReattach NEVER acts on an Active session (nothing to recover)', () => {
  const quser = ' USERNAME              SESSIONNAME        ID  STATE   \n>paul                  console             1  Active';
  assert.equal(planConsoleReattach(quser, { enabled: true }), null);
});

test('planConsoleReattach is gated on the preset being ENABLED (opt-in, never touch an opt-out device)', () => {
  const quser = ' paul                  rdp-tcp#3           2  Disc';
  assert.equal(planConsoleReattach(quser, { enabled: false }), null);
});

test('planConsoleReattach refuses: no session, services session, id 0, garbage', () => {
  assert.equal(planConsoleReattach('No User exists for *', { enabled: true }), null);
  assert.equal(planConsoleReattach(' services                   0  Disc', { enabled: true }), null, 'the services session is not a desktop');
  assert.equal(planConsoleReattach(' paul                  rdp-tcp#3           0  Disc', { enabled: true }), null, 'id 0 must never be guessed');
  assert.equal(planConsoleReattach('', { enabled: true }), null);
  assert.equal(planConsoleReattach('nonsense', { enabled: true }), null);
});

test('planConsoleReattach: picks a Disc row even when an Active session coexists', () => {
  const quser = [
    ' USERNAME              SESSIONNAME        ID  STATE',
    '>paul                  console             1  Active',
    ' paul                  rdp-tcp#3           2  Disc',
  ].join('\n');
  const plan = planConsoleReattach(quser, { enabled: true });
  assert.ok(plan);
  assert.equal(plan.sessionId, 2, 'attaches the DISCONNECTED one, not the healthy console');
});

// ── 8. Source pins for the wiring ───────────────────────────────────────────

test('the run loop advertises the verdict on every poll and the API carries the param', () => {
  assert.match(SRC('src/index.ts'), /unattendedAdvert|unattended/, 'index.ts must compute the advert');
  assert.match(SRC('src/api.ts'), /unattended/, 'api.ts pollCommand must carry the param');
});

test('the network client never imports the preset module (the password must not reach a request body)', () => {
  assert.ok(!/from '\.\/unattended'/.test(SRC('src/api.ts')));
});