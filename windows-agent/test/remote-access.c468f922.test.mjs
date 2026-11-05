/**
 * BROKERED REMOTE ACCESS — Windows device-side tests (ticket c468f922, OWNER
 * RULING 2026-10-29 on card oq_b5118c38: "can we do option three but a little
 * more secure like how it's just like TeamViewer").
 *
 * All pure — runs on Linux CI, no Windows box. The IO seam is injected, exactly
 * like the sibling `win-unattended.2026-10-28.test.mjs`.
 *
 * WHAT IS PINNED HERE, and why each pin is load-bearing:
 *   1. THE CORRECTED PREMISE. The ticket claimed "RDP DOES work on a locked
 *      console". It does not — RDP creates a session BESIDE a locked one. The
 *      module must say so, or a future lane rebuilds to a false premise.
 *   2. The firewall rule is applied BEFORE TermService can listen (same
 *      ordering argument as macOS: the reverse leaves a public RDP port).
 *   3. NLA is REQUIRED (`UserAuthentication=0x1`), because without it the host
 *      allocates a session before authenticating — the pre-auth surface RDP
 *      brute-force tooling targets.
 *   4. A DEDICATED channel account is required; using the primary/auto-logon
 *      account is reported as `account-password`.
 *   5. The enable path NEVER accepts or stores a password (structural: the
 *      function signature has no password parameter).
 *   6. The revert is VERIFIED by reading two surfaces back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const mod = await import('../dist/remote-access.js');
const {
  parseRdpEnabled,
  parseNlaRequired,
  parseRegSz,
  parseFirewallRule,
  firewallScopedToTunnel,
  parseFirewallProfiles,
  evaluateWinRemoteAccess,
  remoteAccessAdvertValue,
  planWinRemoteEnable,
  planWinRemoteRevert,
  verifyWinRemoteRevert,
  probeWinRemoteAccess,
  probeWinRemoteListener,
  FIREWALL_RULE_NAME,
  TS_KEY,
  RDP_TCP_KEY,
} = mod;

const RULE_SCOPED = [
  'Rule Name:                            ' + FIREWALL_RULE_NAME,
  '----------------------------------------------------------------------',
  'Enabled:                              Yes',
  'Direction:                            In',
  'LocalPort:                            3389',
  'RemoteIP:                             10.8.0.0/24',
].join('\n');

const RULE_ANY = RULE_SCOPED.replace('10.8.0.0/24', 'Any');

/** `netsh advfirewall show allprofiles state` with every profile filtering —
 *  the healthy default. An OFF profile makes the Defender rule inert, which is
 *  the false-green this fixture combination now pins (added 2026-10-29). */
const PROFILES_ALL_ON = [
  'Domain Profile Settings:',
  '----------------------------------------------------------------------',
  'State                                 ON',
  '',
  'Private Profile Settings:',
  '----------------------------------------------------------------------',
  'State                                 ON',
  '',
  'Public Profile Settings:',
  '----------------------------------------------------------------------',
  'State                                 ON',
].join('\n');

function fakeIo(overrides = {}) {
  const calls = [];
  const table = {
    [`reg query ${TS_KEY} /v fDenyTSConnections`]: { stdout: 'HKEY_LOCAL_MACHINE\\...\\Terminal Server\n    fDenyTSConnections    REG_DWORD    0x0', code: 0 },
    [`reg query ${RDP_TCP_KEY} /v UserAuthentication`]: { stdout: '    UserAuthentication    REG_DWORD    0x1', code: 0 },
    [`netsh advfirewall firewall show rule name=${FIREWALL_RULE_NAME} verbose`]: { stdout: RULE_SCOPED, code: 0 },
    // ENFORCEMENT probe (added 2026-10-29). A scoped rule whose profile
    // firewall is OFF filters nothing. Default fixture = all profiles ON.
    'netsh advfirewall show allprofiles state': { stdout: PROFILES_ALL_ON, code: 0 },
    'reg query HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon /v DefaultUserName': {
      stdout: '    DefaultUserName    REG_SZ    paul',
      code: 0,
    },
    ...overrides,
  };
  return {
    calls,
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return table[key] ?? { stdout: '', code: 1 };
    },
  };
}

// ── Parsers ────────────────────────────────────────────────────────────────
test('parseRdpEnabled: fDenyTSConnections 0x0 ⇒ enabled, 0x1 ⇒ disabled, absent ⇒ unknown', () => {
  assert.equal(parseRdpEnabled('    fDenyTSConnections    REG_DWORD    0x0'), true);
  assert.equal(parseRdpEnabled('    fDenyTSConnections    REG_DWORD    0x1'), false);
  // An absent value is an honest UNKNOWN, never a fabricated "enabled".
  assert.equal(parseRdpEnabled('', 1), null);
  assert.equal(parseRdpEnabled('ERROR: The system was unable to find the specified registry key', 1), null);
});

test('parseNlaRequired: UserAuthentication 0x1 ⇒ required; 0x0 ⇒ not; absent ⇒ unknown', () => {
  assert.equal(parseNlaRequired('    UserAuthentication    REG_DWORD    0x1'), true);
  assert.equal(parseNlaRequired('    UserAuthentication    REG_DWORD    0x0'), false);
  assert.equal(parseNlaRequired(''), null);
});

test('parseRegSz: reads the string, and treats "(value not set)" as absent', () => {
  assert.equal(parseRegSz('    DefaultUserName    REG_SZ    paul'), 'paul');
  assert.equal(parseRegSz('    DefaultUserName    REG_SZ    (value not set)'), null);
  assert.equal(parseRegSz(''), null);
});

test('parseFirewallRule: an absent rule is DISTINCT from an existing unscoped one', () => {
  const absent = parseFirewallRule('No rules match the specified criteria.');
  assert.equal(absent.exists, false);
  const present = parseFirewallRule(RULE_SCOPED);
  assert.equal(present.exists, true);
  assert.equal(present.enabled, true);
  assert.deepEqual(present.localPorts, [3389]);
  assert.deepEqual(present.remoteIps, ['10.8.0.0/24']);
});

test('parseFirewallRule: a disabled rule reads as not enabled', () => {
  const r = parseFirewallRule(RULE_SCOPED.replace('Enabled:                              Yes', 'Enabled:                              No'));
  assert.equal(r.exists, true);
  assert.equal(r.enabled, false);
});

test('firewallScopedToTunnel: Any / 0.0.0.0/0 / empty RemoteIP all mean EXPOSED', () => {
  assert.equal(firewallScopedToTunnel(RULE_SCOPED, '10.8.0.0/24'), true);
  assert.equal(firewallScopedToTunnel(RULE_ANY, '10.8.0.0/24'), false);
  assert.equal(firewallScopedToTunnel(RULE_SCOPED.replace('10.8.0.0/24', '0.0.0.0/0'), '10.8.0.0/24'), false);
  assert.equal(firewallScopedToTunnel(RULE_SCOPED.replace('10.8.0.0/24', '::/0'), '10.8.0.0/24'), false);
});

test('firewallScopedToTunnel: an absent rule is UNKNOWN (null), a present unscoped one is false', () => {
  assert.equal(firewallScopedToTunnel('No rules match the specified criteria.', '10.8.0.0/24'), null);
  assert.equal(firewallScopedToTunnel(RULE_ANY, '10.8.0.0/24'), false);
});

test('firewallScopedToTunnel: a rule for a DIFFERENT port does not satisfy us', () => {
  const wrongPort = RULE_SCOPED.replace('LocalPort:                            3389', 'LocalPort:                            445');
  assert.equal(firewallScopedToTunnel(wrongPort, '10.8.0.0/24'), false);
});

// ── The ordering pin ───────────────────────────────────────────────────────
test('planWinRemoteEnable adds the firewall rule BEFORE TermService can listen', () => {
  const steps = planWinRemoteEnable({ tunnelCidr: '10.8.0.0/24' });
  const firewallIdx = steps.findIndex((s) => s.cmd === 'netsh' && s.args.includes(`name=${FIREWALL_RULE_NAME}`));
  const enableIdx = steps.findIndex((s) => s.args.includes('fDenyTSConnections') && s.args.includes('0'));
  assert.ok(firewallIdx >= 0, 'a firewall-add step must exist');
  assert.ok(enableIdx > firewallIdx, 'the scoped rule MUST exist before RDP listens');
});

test('planWinRemoteEnable requires NLA and does so BEFORE enabling RDP', () => {
  const steps = planWinRemoteEnable({ tunnelCidr: '10.8.0.0/24' });
  const nlaIdx = steps.findIndex((s) => s.args.includes('UserAuthentication'));
  const enableIdx = steps.findIndex((s) => s.args.includes('fDenyTSConnections') && s.args.includes('0'));
  assert.ok(nlaIdx >= 0, 'NLA must be set explicitly');
  assert.ok(nlaIdx < enableIdx, 'NLA must be on before the listener accepts anyone');
});

test('the firewall rule carries the tunnel remoteip and TCP 3389', () => {
  const steps = planWinRemoteEnable({ tunnelCidr: '10.8.0.0/24' });
  const fw = steps.find((s) => s.cmd === 'netsh' && s.args.includes('add'));
  assert.ok(fw.args.includes('remoteip=10.8.0.0/24'));
  assert.ok(fw.args.includes('localport=3389'));
  assert.ok(fw.args.includes('protocol=TCP'));
  // Never a rule that allows Any.
  assert.equal(fw.args.includes('remoteip=any'), false);
});

test('the enable plan reads the rule back afterwards instead of assuming', () => {
  const steps = planWinRemoteEnable({ tunnelCidr: '10.8.0.0/24' });
  const last = steps[steps.length - 1];
  assert.equal(last.cmd, 'netsh');
  assert.ok(last.args.includes('show'));
});

// ── Credential discipline (structural) ─────────────────────────────────────
test('planWinRemoteEnable accepts NO password parameter at all', () => {
  // The whole design: this module must be structurally incapable of putting the
  // machine's real login password behind a listening service.
  const steps = planWinRemoteEnable({ tunnelCidr: '10.8.0.0/24' });
  const flat = steps.map((s) => s.args.join(' ')).join(' | ');
  assert.doesNotMatch(flat, /password/i);
  assert.doesNotMatch(flat, /\/d\s+["']?[^ ]*secret/i);
  // No user-creation step either — an administrator creates the account.
  assert.doesNotMatch(flat, /\bnet user\b/i);
});

test('the module source never sets a password for any account', () => {
  const src = SRC('src/remote-access.ts');
  assert.doesNotMatch(src, /net user \S+ \S+/);
  assert.doesNotMatch(src, /Set-LocalUser.*-Password/i);
});

// ── Evaluation ─────────────────────────────────────────────────────────────
test('evaluateWinRemoteAccess: a fully hardened PC has NO blockers', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: true,
    nlaRequired: true,
    firewallScopedToTunnel: true,
    channelAccount: 'digby-brokered',
    primaryAccount: 'paul',
    tunnelBound: true,
  });
  assert.deepEqual(v.blockers, []);
  assert.equal(v.enabled, true);
});

test('⚠ account-password: the channel must NOT use the auto-logon account', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: true,
    nlaRequired: true,
    firewallScopedToTunnel: true,
    channelAccount: 'paul',
    primaryAccount: 'paul',
    tunnelBound: true,
  });
  assert.ok(v.blockers.includes('account-password'));
});

test('account-password comparison is CASE-INSENSITIVE (Windows account names are)', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: true,
    nlaRequired: true,
    firewallScopedToTunnel: true,
    channelAccount: 'PAUL',
    primaryAccount: 'paul',
    tunnelBound: true,
  });
  assert.ok(v.blockers.includes('account-password'));
});

test('evaluateWinRemoteAccess: exposed outranks the config nags', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: true,
    nlaRequired: false,
    firewallScopedToTunnel: false,
    channelAccount: null,
    primaryAccount: 'paul',
    tunnelBound: false,
  });
  assert.ok(v.blockers.includes('exposed'));
  assert.ok(v.blockers.includes('no-nla'));
  assert.ok(v.blockers.includes('no-cred'));
  assert.ok(v.blockers.includes('no-tunnel'));
});

test('evaluateWinRemoteAccess: unknown values do not fabricate blockers, and RDP off is not enabled', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: null,
    nlaRequired: null,
    firewallScopedToTunnel: null,
    channelAccount: null,
    primaryAccount: null,
    tunnelBound: false,
  });
  assert.equal(v.enabled, false);
  assert.deepEqual(v.blockers, []);
});

test('evaluateWinRemoteAccess: an absent rule on an ENABLED channel reports no-firewall', () => {
  const v = evaluateWinRemoteAccess({
    rdpEnabled: true,
    nlaRequired: true,
    firewallScopedToTunnel: null,
    channelAccount: 'digby-brokered',
    primaryAccount: 'paul',
    tunnelBound: true,
  });
  assert.ok(v.blockers.includes('no-firewall'));
});

// ── Advert value ───────────────────────────────────────────────────────────
test('remoteAccessAdvertValue emits on,tunnel,<blockers> and nothing else', () => {
  assert.equal(remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: [] }), 'on,tunnel');
  assert.equal(remoteAccessAdvertValue({ enabled: true, tunnelOnly: false, blockers: ['exposed'] }), 'on,exposed');
  assert.equal(remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [] }), '');
});

test('a PROVED-off device advertises `off`, and `on` always wins a conflict', () => {
  // Owner ruling 2026-10-30, health-line item 2: the fleet must be able to say
  // "off" (healthy default) rather than "unavailable" (agent too old to report).
  assert.equal(remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [], off: true }), 'off');
  assert.equal(
    remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: [], off: true }),
    'on,tunnel',
    'off must never be able to clear a green',
  );
});

test('probeWinRemoteListener MEASURES the OS — it never restates local config', async () => {
  // fDenyTSConnections = 0 ⇒ enabled/listening ⇒ true (full probe then runs, so
  // a hand-enabled RDP listener surfaces as on+exposed instead of vanishing).
  const on = fakeIo();
  assert.equal(await probeWinRemoteListener(on), true);
  // fDenyTSConnections = 1 ⇒ denied ⇒ false, the only value that may be `off`.
  const off = fakeIo({
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server /v fDenyTSConnections': {
      stdout: '\r\n    fDenyTSConnections    REG_DWORD    0x1\r\n',
      code: 0,
    },
  });
  assert.equal(await probeWinRemoteListener(off), false);
  // Unreadable ⇒ null, so the poll emits NOTHING (absent-never-clobbers).
  const unknown = fakeIo({
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server /v fDenyTSConnections': {
      stdout: '',
      code: 1,
    },
  });
  assert.equal(await probeWinRemoteListener(unknown), null);
});

test('the cheap listener probe is ONE reg read — no firewall or service enumeration', async () => {
  // It runs on every poll, including for devices that never opted in.
  const io = fakeIo();
  await probeWinRemoteListener(io);
  assert.deepEqual(io.calls, [
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server /v fDenyTSConnections',
  ]);
});

test('the poll advertises a proved off, and stays silent on unknown', () => {
  const idx = SRC('src/index.ts');
  assert.match(idx, /config\.remoteAccess\?\.enabled \? true : await probeWinRemoteListener/);
  assert.match(idx, /off: !verdict\.enabled/);
  assert.match(idx, /else if \(listener === false\)/);
});

test('the advert value cannot carry a secret even if one is passed', () => {
  const v = remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: [], accountPassword: 'leaky' });
  assert.equal(v, 'on,tunnel');
  assert.equal(v.includes('leaky'), false);
});

// ── Probe + revert ─────────────────────────────────────────────────────────
test('probeWinRemoteAccess reads four surfaces and reports the verdict', async () => {
  const snap = await probeWinRemoteAccess(fakeIo(), {
    channelAccount: 'digby-brokered',
    tunnelCidr: '10.8.0.0/24',
    tunnelBound: true,
  });
  assert.equal(snap.rdpEnabled, true);
  assert.equal(snap.nlaRequired, true);
  assert.equal(snap.firewallScopedToTunnel, true);
  assert.equal(snap.primaryAccount, 'paul');
  assert.equal(snap.tunnelBound, true);
});

// ── THE FALSE GREEN (defect found 2026-10-29 by live measurement) ──────────
// A Defender rule that reads back perfectly is INERT when the profile it
// applies to has its firewall OFF. Our own enable plan writes `profile=any`,
// so protection requires EVERY profile on. Before this fix the probe never
// read the profile state, so scoped could be true while 3389 was unfiltered.
test('probeWinRemoteAccess: a scoped rule with a firewall profile OFF is NOT scoped (the false green)', async () => {
  const io = fakeIo({
    'netsh advfirewall show allprofiles state': {
      stdout: PROFILES_ALL_ON.replace(/State(\s+)ON/, 'State$1OFF'),
      code: 0,
    },
  });
  const snap = await probeWinRemoteAccess(io, {
    channelAccount: 'digby-brokered',
    tunnelCidr: '10.8.0.0/24',
    tunnelBound: true,
  });
  assert.equal(snap.firewallProfilesOn, false);
  assert.equal(snap.firewallScopedToTunnel, false);
  assert.ok(evaluateWinRemoteAccess(snap).blockers.includes('exposed'));
});

test('probeWinRemoteAccess: unreadable profile state is UNKNOWN, never a claimed green', async () => {
  const io = fakeIo({ 'netsh advfirewall show allprofiles state': { stdout: '', code: 1 } });
  const snap = await probeWinRemoteAccess(io, {
    channelAccount: 'digby-brokered',
    tunnelCidr: '10.8.0.0/24',
    tunnelBound: true,
  });
  assert.equal(snap.firewallProfilesOn, null);
  assert.equal(snap.firewallScopedToTunnel, null);
});

test('parseFirewallProfiles: allOn only when every parsed profile is ON', () => {
  const all = parseFirewallProfiles(PROFILES_ALL_ON);
  assert.equal(all.allOn, true);
  assert.deepEqual(Object.keys(all.profiles).sort(), ['domain', 'private', 'public']);
  const oneOff = parseFirewallProfiles(PROFILES_ALL_ON.replace(/State(\s+)ON/, 'State$1OFF'));
  assert.equal(oneOff.allOn, false);
  assert.equal(parseFirewallProfiles('gibberish'), null);
});

test('planWinRemoteRevert denies RDP FIRST, then removes the rule', () => {
  const steps = planWinRemoteRevert();
  const denyIdx = steps.findIndex((s) => s.args.includes('fDenyTSConnections') && s.args.includes('1'));
  const delIdx = steps.findIndex((s) => s.args.includes('delete'));
  assert.ok(denyIdx >= 0, 'the revocation must disable RDP');
  assert.ok(delIdx > denyIdx, 'deny first, then clean up the rule');
  const last = steps[steps.length - 1];
  assert.match(last.why, /VERIFY/);
});

test('verifyWinRemoteRevert: clean only when RDP is denied and the rule is gone', () => {
  assert.equal(
    verifyWinRemoteRevert({ fDenyTsConnections: '    fDenyTSConnections    REG_DWORD    0x1', firewallRule: 'No rules match' }).clean,
    true,
  );
  assert.equal(
    verifyWinRemoteRevert({ fDenyTsConnections: '    fDenyTSConnections    REG_DWORD    0x0', firewallRule: 'No rules match' }).clean,
    false,
  );
  assert.equal(
    verifyWinRemoteRevert({ fDenyTsConnections: '    fDenyTSConnections    REG_DWORD    0x1', firewallRule: RULE_SCOPED }).clean,
    false,
  );
});

test('verifyWinRemoteRevert: an unreadable flag is an UNVERIFIED revert, never clean', () => {
  const out = verifyWinRemoteRevert({ fDenyTsConnections: '', firewallRule: 'No rules match' });
  assert.equal(out.clean, false);
  assert.match(out.remaining.join(' '), /UNVERIFIED/);
});

// ── Documented honesty: the corrected premise ──────────────────────────────
test('the module CORRECTS the ticket premise: RDP does not unlock a locked console', () => {
  const src = SRC('src/remote-access.ts');
  assert.match(src, /PREMISE IS WRONG|premise is wrong/);
  assert.match(src, /creates a session BESIDE/i);
  assert.match(src, /tscon/i);
});

test('the module states it ships no RDP client (so prelogin_input stays honest)', () => {
  const src = SRC('src/remote-access.ts');
  assert.match(src, /no RDP client|ships no RDP/i);
});

test('the CLI is registered and refuses to enable without a dedicated account', () => {
  const src = SRC('src/index.ts');
  assert.match(src, /case 'remote-access':/);
  assert.match(src, /MUST be a dedicated account/);
  assert.match(src, /never sets or stores a password/i);
});

test('the agent advertises ?remoteaccess on the poll but no secret can ride it', () => {
  const api = SRC('src/api.ts');
  assert.match(api, /remoteaccess=\$\{encodeURIComponent\(remoteAccess\)\}/);
  const idx = SRC('src/index.ts');
  assert.match(idx, /remoteAccessAdvert \|\| null/);
});

// ── DEFAULT TUNNEL CIDR (defect found + fixed 2026-10-29) ────────────────────
// The default established WHEN NO CIDR IS NAMED is a security decision, not a
// convenience: it decides which hosts may reach 3389. The old default was
// `10.0.0.0/8`, which is wrong in BOTH directions at once — too broad (the
// ordinary LAN range, so every local 10.x host is admitted) and too narrow (the
// fleet's Tailscale peers are 100.64.0.0/10, so NO brokered peer could ever
// connect). These pins exist so a future edit cannot quietly restore it.

test('DEFAULT_TUNNEL_CIDR is the tailnet block, NOT the LAN default', () => {
  assert.equal(mod.DEFAULT_TUNNEL_CIDR, '100.64.0.0/10');
  // The regression that matters: 10/8 is the ordinary RFC1918 LAN range.
  assert.notEqual(mod.DEFAULT_TUNNEL_CIDR, '10.0.0.0/8');
  assert.notEqual(mod.DEFAULT_TUNNEL_CIDR, '0.0.0.0/0');
});

test('DEFAULT_TUNNEL_CIDR actually ADMITS a tailnet peer (the old default admitted none)', () => {
  // Pure containment check — no network, no Windows box.
  const [base, bits] = mod.DEFAULT_TUNNEL_CIDR.split('/');
  const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  const inRange = (ip) => (toInt(ip) & mask) === (toInt(base) & mask);
  assert.equal(inRange('100.64.0.1'), true, 'a real fleet peer must be admitted');
  assert.equal(inRange('10.1.2.3'), false, 'an ordinary LAN host must NOT be admitted');
  assert.equal(inRange('192.168.1.10'), false);
});

test('no hardcoded 10.0.0.0/8 default survives anywhere in the agent', () => {
  // Both the CLI default and the two probe defaults must go through the
  // constant, or the fleet can report scoped-against-LAN while the rule is
  // written against something else.
  const idx = SRC('src/index.ts');
  assert.equal(
    (idx.match(/10\.0\.0\.0\/8/g) || []).length,
    0,
    'a hardcoded 10.0.0.0/8 default survived — use DEFAULT_TUNNEL_CIDR',
  );
  assert.equal(
    (idx.match(/DEFAULT_TUNNEL_CIDR/g) || []).length,
    4,
    'expected the constant at all 3 call sites + the import',
  );
  assert.match(idx, /DEFAULT_TUNNEL_CIDR/);
});

test('an explicit per-device CIDR still wins over the default (override preserved)', () => {
  const steps = mod.planWinRemoteEnable({ tunnelCidr: '100.64.0.0/10' });
  const rule = steps.find((s) => s.cmd === 'netsh' && s.args.includes('remoteip=100.64.0.0/10'));
  assert.ok(rule, 'the firewall step must carry the tunnel-scoped remoteip');
  // And a custom block is honoured verbatim, not silently replaced.
  const custom = mod.planWinRemoteEnable({ tunnelCidr: '192.0.2.0/24' });
  assert.ok(custom.find((s) => s.cmd === 'netsh' && s.args.includes('remoteip=192.0.2.0/24')));
});