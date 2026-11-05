/**
 * BROKERED REMOTE ACCESS — macOS device-side tests (ticket c468f922, OWNER
 * RULING 2026-10-29 on card oq_b5118c38: "can we do option three but a little
 * more secure like how it's just like TeamViewer").
 *
 * All pure — runs on Linux CI, no Mac, no sudo. The IO seam is injected, exactly
 * like the sibling `unattended.2026-10-28.test.mjs`.
 *
 * WHAT IS PINNED HERE, and why each pin is load-bearing:
 *   1. The firewall rule is applied BEFORE Screen Sharing can listen. Reversing
 *      that ordering leaves a public VNC port for however long the gap lasts —
 *      the difference between a policy and a gesture.
 *   2. The PF anchor passes 5900 ONLY on the tunnel interface and drops it
 *      everywhere else. macOS `kickstart` has NO interface flag (its
 *      `-targetdisk` is a mountpoint, not an interface), so the firewall IS the
 *      exposure boundary. This is the fact most likely to be "simplified" away.
 *   3. The credential is DEDICATED and `-allUsers` is NEVER used.
 *   4. The VNC password cannot reach a log/result envelope (argv leak guard).
 *   5. The revert is VERIFIED by reading three surfaces back, not assumed.
 *   6. `exposed` outranks every configuration blocker.
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
  parseAllowScreenSharing,
  parseSocketfilterState,
  parsePfAnchor,
  parsePfEnabled,
  parseAnchorReferenced,
  evaluateMacRemoteAccess,
  remoteAccessAdvertValue,
  planMacRemoteEnable,
  planMacRemoteRevert,
  planFirewallRule,
  verifyMacRemoteRevert,
  argvContainsSecret,
  runMacRemotePlan,
  probeMacRemoteAccess,
  probeMacRemoteListener,
  VNC_SETTINGS_FILE,
  KICKSTART,
} = mod;

// ── A fake Mac: every probe answers from a table, nothing touches the host ──
function fakeIo(overrides = {}) {
  const calls = [];
  const table = {
    'defaults read /Library/Preferences/com.apple.RemoteManagement ALLOW_SCREENSHARING': { stdout: '1', code: 0 },
    'defaults read com.apple.RemoteManagement ALLOW_SCREENSHARING': { stdout: '1', code: 0 },
    '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate': { stdout: 'Firewall is enabled. (State = 1)', code: 0 },
    'pfctl -a com.digby.brokered -sr': {
      stdout: 'pass in quick on utun proto tcp from any to any port 5900\nblock drop in quick proto tcp from any to any port 5900',
      code: 0,
    },
    // ENFORCEMENT probes (added 2026-10-29). Rules that merely read back are
    // not scoping anything: pf must be ON and the main ruleset must reference
    // our anchor. Default fixture = the healthy, enforced case.
    'pfctl -s info': { stdout: 'Status: Enabled for 1 days 02:03:04', code: 0 },
    'pfctl -sr': { stdout: 'anchor "com.apple/*" all\nanchor "com.digby.brokered" all', code: 0 },
    ...overrides,
  };
  return {
    calls,
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return table[key] ?? { stdout: '', code: 1 };
    },
    async exists() {
      return true;
    },
  };
}

// ── Parsers ────────────────────────────────────────────────────────────────
test('parseAllowScreenSharing: 1 ⇒ enabled, 0 ⇒ disabled, an unreadable read ⇒ unknown', () => {
  assert.equal(parseAllowScreenSharing('1'), true);
  assert.equal(parseAllowScreenSharing('ALLOW_SCREENSHARING = 1'), true);
  assert.equal(parseAllowScreenSharing('0'), false);
  assert.equal(parseAllowScreenSharing('ALLOW_SCREENSHARING = 0'), false);
  // A read that failed for an unreadable reason stays UNKNOWN — never a
  // fabricated "disabled" (that would hide an exposure behind a false green).
  assert.equal(parseAllowScreenSharing('', 1), null);
  assert.equal(parseAllowScreenSharing('', 1, 'Could not write domain'), null);
});

// TICKET e530220e. This is the pin for the defect the owner reported: on a Mac
// that never enabled Screen Sharing the key is ABSENT, macOS says so on stderr,
// and the agent therefore used to advertise NOTHING — which the fleet rendered
// as "the agent on this Mac is too old to report a remote channel — update it".
// The `off` state already existed in the backend for exactly this case; the
// agent simply never emitted it. A positive "not enabled" is a measurement and
// must read `off`, NOT `unavailable`.
test('parseAllowScreenSharing: macOS "does not exist" is a POSITIVE not-enabled, not an unknown (e530220e)', () => {
  const ABSENT = 'The domain/default pair of (/Library/Preferences/com.apple.RemoteManagement, ALLOW_SCREENSHARING) does not exist';
  // The real shape: empty stdout, exit 1, the sentence on stderr.
  assert.equal(parseAllowScreenSharing('', 1, ABSENT), false);
  // Tolerate the sentence arriving on stdout (older/other `defaults` shapes, and
  // the fake-IO runners in this suite) — same meaning, same answer.
  assert.equal(parseAllowScreenSharing(ABSENT, 1), false);
  // …and the whole-domain form with no key set.
  assert.equal(parseAllowScreenSharing('', 1, 'Domain /Library/Preferences/com.apple.RemoteManagement does not exist'), false);
});

test('e530220e: a stock Mac advertises `off` instead of falling silent (the end-to-end wire value)', async () => {
  const ABSENT = 'The domain/default pair of (/Library/Preferences/com.apple.RemoteManagement, ALLOW_SCREENSHARING) does not exist';
  const { probeMacRemoteListener, remoteAccessAdvertValue } = await import('../dist/remote-access.js');
  // io.run for the ONE defaults read the cheap listener probe performs.
  const stockIo = {
    run: async () => ({ stdout: '', code: 1, stderr: ABSENT }),
    exists: async () => false,
  };
  const listener = await probeMacRemoteListener(stockIo);
  assert.equal(listener, false, 'the stock Mac is PROVED not listening');
  const advert = remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [], off: true });
  assert.equal(advert, 'off', 'and it says so on the poll, so the card shows "off (healthy default)"');
  // The contrast that used to be invisible: a genuinely unreadable probe
  // emits nothing, and the backend keeps reporting `unavailable`.
  const unreadableIo = { run: async () => ({ stdout: '', code: 1, stderr: 'Operation not permitted' }), exists: async () => false };
  assert.equal(await probeMacRemoteListener(unreadableIo), null);
});

test('parseSocketfilterState: only an explicit wording decides; anything else is unknown', () => {
  assert.equal(parseSocketfilterState('Firewall is enabled. (State = 1)'), true);
  assert.equal(parseSocketfilterState('Firewall is disabled. (State = 0)'), false);
  assert.equal(parseSocketfilterState('gibberish'), null);
  assert.equal(parseSocketfilterState(''), null);
});

test('parsePfAnchor: separates tunnel PASS from blanket BLOCK and reads the interface', () => {
  const out = parsePfAnchor(
    [
      '# comment',
      'pass in quick on utun proto tcp from any to any port 5900',
      'block drop in quick proto tcp from any to any port 5900',
    ].join('\n'),
  );
  assert.deepEqual(out.passPorts, [5900]);
  assert.deepEqual(out.blockPorts, [5900]);
  assert.deepEqual(out.passOnInterfaces, ['utun']);
});

test('parsePfAnchor: an empty anchor parses to empty sets (never a throw)', () => {
  assert.deepEqual(parsePfAnchor(''), { passPorts: [], blockPorts: [], passOnInterfaces: [] });
});

// ── The ordering pin: firewall BEFORE the service can listen ────────────────
test('planMacRemoteEnable applies the firewall anchor BEFORE any kickstart step', () => {
  const steps = planMacRemoteEnable({ vncPassword: 'pw', account: 'brokered', tunnelInterface: 'utun' });
  const firstKickstart = steps.findIndex((s) => s.cmd === KICKSTART);
  const firewallStep = steps.findIndex((s) => s.cmd === 'pfctl' && s.args.includes('-f'));
  assert.ok(firewallStep >= 0, 'a pfctl -f step must exist');
  assert.ok(firstKickstart > firewallStep, 'the firewall MUST come before Screen Sharing can listen');
  // And the anchor body actually rides that step (an empty -f - applies nothing).
  assert.match(steps[firewallStep].stdin, /port 5900/);
});

// ── ENFORCEMENT MUST BE ESTABLISHED, not assumed (defect 2026-10-29) ───────
// The probe now only reports scoped=true when pf is ON and the anchor is
// REFERENCED. If the enable plan did not establish both, every enable would
// read `exposed` forever — and worse, the pre-fix plan DID leave the port
// unfiltered while reporting success. This pin is the other half of the fix.
test('planMacRemoteEnable ENABLES pf and REFERENCES the anchor before writing rules', () => {
  const steps = planMacRemoteEnable({ vncPassword: 'pw', account: 'brokered', tunnelInterface: 'utun' });
  const enforceStep = steps.findIndex((s) => s.cmd === 'sh' && s.args.join(' ').includes('PLAN_PF_ENFORCEMENT') === false && /pfctl -e/.test(s.args.join(' ')));
  assert.ok(enforceStep >= 0, 'an enforcement step must exist');
  const firewallStep = steps.findIndex((s) => s.cmd === 'pfctl' && s.args.includes('-f'));
  assert.ok(enforceStep < firewallStep, 'enforcement must precede the rules it makes meaningful');
  const script = steps[enforceStep].args[1];
  // Purely additive + idempotent: it must never rewrite or remove stock rules.
  assert.match(script, /grep -q "anchor/);
  assert.match(script, /cp -n /);
  // `>>` append is the ONLY write it may do — a bare `> "$CONF"` would
  // truncate the stock com.apple/* rules and silently drop the device's
  // existing firewall posture, which is a worse hole than the one we are closing.
  assert.doesNotMatch(script, /(^|[^>])>\s*"\$CONF"/, 'must never truncate pf.conf');
  // And it must VERIFY rather than assume (the caller fails closed on non-zero).
  assert.match(script, /pfctl -s info \| grep -q "Status: Enabled"/);
  assert.match(script, /pfctl -sr \| grep -q "anchor/);
});

test('the revert leaves the pf.conf reference but empties the anchor (inert, not a hole)', () => {
  const steps = planMacRemoteRevert('utun');
  const flat = steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' | ');
  // Clearing the anchor's RULES is what closes the port; the leftover
  // reference in pf.conf then filters nothing, so it is not a hole. Revert must
  // NOT disable pf (that would downgrade the device's filtering posture).
  assert.match(flat, /-F rules/);
  assert.doesNotMatch(flat, /pfctl -d/);
});

test('the enable plan reads the anchor back afterwards instead of assuming the write landed', () => {
  const steps = planMacRemoteEnable({ vncPassword: 'pw', account: 'brokered', tunnelInterface: 'utun' });
  const last = steps[steps.length - 1];
  assert.equal(last.cmd, 'pfctl');
  assert.deepEqual(last.args, ['-a', 'com.digby.brokered', '-sr']);
});

test('planFirewallRule: pass ONLY on the tunnel (quick), drop everywhere else', () => {
  const rule = planFirewallRule('utun');
  const lines = rule.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.match(lines[0], /^pass in quick on utun .*port 5900$/);
  assert.match(lines[1], /^block drop in quick .*port 5900$/);
  // The pass must be `quick` or the blanket block below it would swallow tunnel
  // traffic too.
  assert.match(lines[0], /quick/);
  // And it must be scoped to the interface, not to "any".
  assert.doesNotMatch(lines[0], /on any /);
});

test('planFirewallRule honours a non-default tunnel interface name', () => {
  assert.match(planFirewallRule('tun7'), /on tun7 /);
});

// ── Credential discipline ──────────────────────────────────────────────────
test('the dedicated VNC password is set and -allUsers is NEVER used', () => {
  const steps = planMacRemoteEnable({ vncPassword: 'the-vnc-pw', account: 'brokered', tunnelInterface: 'utun' });
  const flat = steps.map((s) => s.args.join(' ')).join(' | ');
  assert.match(flat, /-setvncpw -vncpw the-vnc-pw/);
  assert.match(flat, /-setvnclegacy -vnclegacy yes/);
  assert.match(flat, /-allowAccessFor -specifiedUsers/);
  assert.match(flat, /-users brokered/);
  // ss64 warns -allUsers "can be used to grant very permissive incoming access".
  assert.doesNotMatch(flat, /-allUsers/);
});

test('the ACCOUNT password is never part of the plan (only a dedicated VNC one)', () => {
  const steps = planMacRemoteEnable({ vncPassword: 'vnc-only', account: 'brokered', tunnelInterface: 'utun' });
  // Nothing writes /etc/kcpassword — that is the unattended preset's job and the
  // whole point of this channel needing no account password.
  const flat = steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' | ');
  assert.doesNotMatch(flat, /kcpassword/i);
});

// ── The argv leak guard (criterion 5) ──────────────────────────────────────
test('argvContainsSecret detects the credential so a caller can refuse to log it', () => {
  assert.equal(argvContainsSecret('-vncpw hunter2secret', 'hunter2secret'), true);
  assert.equal(argvContainsSecret('-vncpw somethingelse', 'hunter2secret'), false);
  // A very short "secret" is not flagged (it would match everything).
  assert.equal(argvContainsSecret('abc', 'ab'), false);
  assert.equal(argvContainsSecret('anything', ''), false);
});

test('runMacRemotePlan WITHHOLDS the argv of any step carrying the secret', async () => {
  const io = fakeIo();
  const steps = planMacRemoteEnable({ vncPassword: 'top-secret-pw', account: 'brokered', tunnelInterface: 'utun' });
  const results = await runMacRemotePlan(io, steps, { secret: 'top-secret-pw' });
  const serialised = JSON.stringify(results);
  // The credential must not appear anywhere in the reported outcome.
  assert.equal(serialised.includes('top-secret-pw'), false);
  // ...and the step that carried it is labelled as withheld, not silently dropped.
  assert.ok(results.some((r) => r.cmd.includes('(args withheld)')));
});

test('the module never logs argv: no console/logger call inside it', () => {
  const src = SRC('src/remote-access.ts');
  assert.doesNotMatch(src, /console\.(log|error|warn|info)/);
  assert.doesNotMatch(src, /logger\./);
});

// ── Evaluation: exposure outranks everything, unknown never accuses ────────
test('evaluateMacRemoteAccess: an enabled channel with no tunnel scoping is EXPOSED', () => {
  const v = evaluateMacRemoteAccess({
    screenSharingEnabled: true,
    vncCredentialPresent: true,
    firewallEnabled: true,
    firewallScopedToTunnel: false,
    tunnelBound: true,
    tunnelInterface: 'utun',
  });
  assert.equal(v.enabled, true);
  assert.ok(v.blockers.includes('exposed'));
});

test('evaluateMacRemoteAccess: a fully hardened device has NO blockers', () => {
  const v = evaluateMacRemoteAccess({
    screenSharingEnabled: true,
    vncCredentialPresent: true,
    firewallEnabled: true,
    firewallScopedToTunnel: true,
    tunnelBound: true,
    tunnelInterface: 'utun',
  });
  assert.deepEqual(v.blockers, []);
  assert.equal(v.enabled, true);
});

test('evaluateMacRemoteAccess: UNKNOWN values do not fabricate blockers', () => {
  const v = evaluateMacRemoteAccess({
    screenSharingEnabled: null,
    vncCredentialPresent: null,
    firewallEnabled: null,
    firewallScopedToTunnel: null,
    tunnelBound: false,
    tunnelInterface: 'utun',
  });
  // Not enabled ⇒ no exposure claim. And `no-tunnel` only fires for an ENABLED
  // channel, so an unknown device is not accused.
  assert.deepEqual(v.blockers, []);
  assert.equal(v.enabled, false);
});

test('evaluateMacRemoteAccess: missing credential, firewall and tunnel binding each report', () => {
  const v = evaluateMacRemoteAccess({
    screenSharingEnabled: true,
    vncCredentialPresent: false,
    firewallEnabled: false,
    firewallScopedToTunnel: false,
    tunnelBound: false,
    tunnelInterface: 'utun',
  });
  for (const token of ['exposed', 'no-firewall', 'no-cred', 'no-tunnel']) {
    assert.ok(v.blockers.includes(token), `expected ${token}`);
  }
});

// ── The advert value ───────────────────────────────────────────────────────
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

test('probeMacRemoteListener MEASURES the OS — it never restates local config', async () => {
  // Listening ⇒ true (so the poll runs the FULL probe and the hand-enabled
  // case surfaces as on+exposed instead of vanishing as "off").
  const on = fakeIo();
  assert.equal(await probeMacRemoteListener(on), true);
  // Not listening ⇒ false, which is the only value that may become `off`.
  const off = fakeIo({
    'defaults read /Library/Preferences/com.apple.RemoteManagement ALLOW_SCREENSHARING': {
      stdout: '0',
      code: 0,
    },
  });
  assert.equal(await probeMacRemoteListener(off), false);
  // Unreadable ⇒ null, so the poll emits NOTHING (absent-never-clobbers).
  const unknown = fakeIo({
    'defaults read /Library/Preferences/com.apple.RemoteManagement ALLOW_SCREENSHARING': { stdout: '', code: 1 },
  });
  assert.equal(await probeMacRemoteListener(unknown), null);
});

test('the cheap listener probe does not shell out to pfctl/kickstart', async () => {
  // It runs on EVERY poll, including for devices that never opted in — so it
  // must stay one `defaults read`, never the six-surface full probe.
  const io = fakeIo();
  await probeMacRemoteListener(io);
  assert.deepEqual(io.calls, [
    'defaults read /Library/Preferences/com.apple.RemoteManagement ALLOW_SCREENSHARING',
  ]);
});

test('the poll advertises a proved off, and stays silent on unknown', () => {
  const idx = SRC('src/index.ts');
  // The cheap probe gates the advert, so `off` is a measurement.
  assert.match(idx, /config\.remoteAccess\?\.enabled \? true : await probeMacRemoteListener/);
  assert.match(idx, /off: !verdict\.enabled/);
  assert.match(idx, /else if \(listener === false\)/);
});

test('the advert value cannot carry a secret even if one is passed', () => {
  const v = remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: [], vncPassword: 'leaky' });
  assert.equal(v, 'on,tunnel');
  assert.equal(v.includes('leaky'), false);
});

// ── Probe + revert verification ────────────────────────────────────────────
test('probeMacRemoteAccess reads four surfaces and reports the scoping verdict', async () => {
  const io = fakeIo();
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  assert.equal(snap.screenSharingEnabled, true);
  assert.equal(snap.vncCredentialPresent, true);
  assert.equal(snap.firewallEnabled, true);
  assert.equal(snap.firewallScopedToTunnel, true);
  assert.equal(snap.tunnelBound, true);
});

test('probeMacRemoteAccess: an anchor missing the blanket block is NOT scoped (exposure)', async () => {
  const io = fakeIo({
    'pfctl -a com.digby.brokered -sr': { stdout: 'pass in quick on utun proto tcp from any to any port 5900', code: 0 },
  });
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  // A pass alone does not prove the port is unreachable everywhere else.
  assert.equal(snap.firewallScopedToTunnel, false);
});

// ── THE FALSE GREEN (defect found 2026-10-29 by live measurement) ──────────
// Correct-looking rules are NOT scoping. pf ships DISABLED on stock macOS and
// stock /etc/pf.conf references only com.apple/*, so an anchor written with
// `pfctl -a NAME -f -` loads and reads back perfectly while every packet
// passes. Before this fix the probe called that scoped=true and the fleet
// reported the channel HARDENED with 5900 wide open. These three pins exist so
// that specific regression cannot come back.
test('probeMacRemoteAccess: correct rules with pf DISABLED are NOT scoped (the false green)', async () => {
  const io = fakeIo({
    'pfctl -s info': { stdout: 'Status: Disabled', code: 0 },
  });
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  assert.equal(snap.pfEnabled, false);
  // The rules are perfect; the filter is OFF. That IS exposure.
  assert.equal(snap.firewallScopedToTunnel, false);
  const v = evaluateMacRemoteAccess(snap);
  assert.ok(v.blockers.includes('exposed'), 'an inert rule must report exposed');
});

test('probeMacRemoteAccess: correct rules with the anchor UNREFERENCED are NOT scoped', async () => {
  const io = fakeIo({
    // Stock macOS main ruleset: our anchor is never mentioned, so it is inert.
    'pfctl -sr': { stdout: 'anchor "com.apple/*" all', code: 0 },
  });
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  assert.equal(snap.anchorReferenced, false);
  assert.equal(snap.firewallScopedToTunnel, false);
  assert.ok(evaluateMacRemoteAccess(snap).blockers.includes('exposed'));
});

test('probeMacRemoteAccess: unreadable enforcement state is UNKNOWN, never a claimed green', async () => {
  const io = fakeIo({
    'pfctl -s info': { stdout: '', code: 1 },
    'pfctl -sr': { stdout: '', code: 1 },
  });
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  assert.equal(snap.pfEnabled, null);
  assert.equal(snap.anchorReferenced, null);
  // Cannot prove enforcement ⇒ must NOT claim scoped.
  assert.equal(snap.firewallScopedToTunnel, null);
});

test('parsePfEnabled / parseAnchorReferenced read only explicit evidence', () => {
  assert.equal(parsePfEnabled('Status: Enabled for 3 days'), true);
  assert.equal(parsePfEnabled('Status: Disabled'), false);
  assert.equal(parsePfEnabled('gibberish'), null);
  assert.equal(parseAnchorReferenced('anchor "com.digby.brokered" all', 'com.digby.brokered'), true);
  assert.equal(parseAnchorReferenced('anchor "com.apple/*" all', 'com.digby.brokered'), false);
  assert.equal(parseAnchorReferenced('', 'com.digby.brokered'), null);
});

test('probeMacRemoteAccess: a pass on the WRONG interface is not scoped to our tunnel', async () => {
  const io = fakeIo({
    'pfctl -a com.digby.brokered -sr': {
      stdout: 'pass in quick on en0 proto tcp from any to any port 5900\nblock drop in quick proto tcp from any to any port 5900',
      code: 0,
    },
  });
  const snap = await probeMacRemoteAccess(io, { tunnelBound: true, tunnelInterface: 'utun' });
  assert.equal(snap.firewallScopedToTunnel, false);
});

test('planMacRemoteRevert removes the credential file, the anchor and the service', () => {
  const steps = planMacRemoteRevert('utun');
  const flat = steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' | ');
  assert.match(flat, new RegExp(`rm -f ${VNC_SETTINGS_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(flat, /pfctl -a com.digby.brokered -F rules/);
  assert.match(flat, /-deactivate/);
  assert.match(flat, /-access -off/);
  // The final step is a READ — "revoked" must be backed by a check.
  const last = steps[steps.length - 1];
  assert.equal(last.cmd, 'defaults');
  assert.match(last.why, /VERIFY/);
});

test('verifyMacRemoteRevert: clean only when all three surfaces are clear', () => {
  assert.equal(verifyMacRemoteRevert({ allowScreenSharing: '', vncFileExists: false, anchorRules: '' }).clean, true);
  assert.equal(verifyMacRemoteRevert({ allowScreenSharing: '1', vncFileExists: false, anchorRules: '' }).clean, false);
  assert.equal(verifyMacRemoteRevert({ allowScreenSharing: '', vncFileExists: true, anchorRules: '' }).clean, false);
  assert.equal(
    verifyMacRemoteRevert({ allowScreenSharing: '', vncFileExists: false, anchorRules: 'pass in quick on utun proto tcp from any to any port 5900' }).clean,
    false,
  );
});

test('verifyMacRemoteRevert names every surviving item (no silent partial revoke)', () => {
  const out = verifyMacRemoteRevert({
    allowScreenSharing: '1',
    vncFileExists: true,
    anchorRules: 'pass in quick on utun proto tcp from any to any port 5900',
  });
  assert.equal(out.clean, false);
  assert.equal(out.remaining.length, 3);
});

// ── Documented honesty: the module must SAY what it cannot do ──────────────
test('the module documents the argv leak and why the credential must be dedicated', () => {
  const src = SRC('src/remote-access.ts');
  assert.match(src, /argv/i);
  assert.match(src, /ps/);
  assert.match(src, /dedicated/i);
});

test('the module documents that kickstart has no bind-to-interface option', () => {
  const src = SRC('src/remote-access.ts');
  assert.match(src, /no interface-restriction flag|NO\n \*    \*?interface|has NO\n \*    \*?interface/i);
  assert.match(src, /targetdisk/i);
  assert.match(src, /MOUNTPOINT/i);
});

test('the module states it ships NO VNC/RFB client (so prelogin_input stays honest)', () => {
  const src = SRC('src/remote-access.ts');
  assert.match(src, /no RFB\/VNC client|ships no RFB/i);
});

// ── The CLI is registered and reads the secret from the terminal only ──────
test('the remote-access CLI is registered and never takes the password from argv/env', () => {
  const src = SRC('src/index.ts');
  assert.match(src, /case 'remote-access':/);
  // The secret comes from readSecret (local tty), not from process.argv.
  assert.match(src, /readSecret\('New VNC password/);
});

test('the agent advertises ?remoteaccess on the poll but no secret can ride it', () => {
  const api = SRC('src/api.ts');
  assert.match(api, /remoteaccess=\$\{encodeURIComponent\(remoteAccess\)\}/);
  const idx = SRC('src/index.ts');
  assert.match(idx, /remoteAccessAdvert \|\| null/);
});
// ── PRIVILEGED-RUN PREFLIGHT (defect found + fixed 2026-10-29) ───────────────
// The plan below shells out to pfctl and ARDAgent's kickstart, which are
// root-owned. The agent itself runs as a per-user LaunchAgent, so running the
// command from that terminal attempted every step unprivileged: each failed,
// the fail-closed path reverted, and the operator got a wall of per-command
// errors instead of "you are not root". Under sudo the opposite silent failure
// appeared: homedir() became root's, so a paired device answered "Not paired".
// These pins make both states say the useful thing and stop BEFORE any step.

test('unprivileged run refuses with the exact remedy, before any step runs', () => {
  const msg = mod.privilegedRunRefusal({ uid: 501, paired: true });
  assert.ok(msg, 'a non-root run must be refused');
  assert.match(msg, /Administrator rights are required/);
  assert.match(msg, /sudo/);
  assert.match(msg, /Nothing was changed/);
});

test('a root run on a paired device is allowed (no false refusal)', () => {
  assert.equal(mod.privilegedRunRefusal({ uid: 0, paired: true }), null);
});

test('unpaired is refused and EXPLAINS the sudo-home trap', () => {
  const msg = mod.privilegedRunRefusal({ uid: 0, paired: false });
  assert.ok(msg);
  assert.match(msg, /Not paired/);
  // The load-bearing hint: pairing lives in the invoking user's home.
  assert.match(msg, /~\/\.config\/digby-agent/);
});

test('a platform without getuid is not refused on a fabricated uid', () => {
  assert.equal(mod.privilegedRunRefusal({ uid: undefined, paired: true }), null);
});

test('the enable AND disable CLI paths both gate on the preflight', () => {
  const idx = SRC('src/index.ts');
  // Two call sites: enable (paired+uid), disable (paired forced true).
  assert.equal((idx.match(/privilegedRunRefusal\(/g) || []).length, 3,
    'expected 3 calls: enable pairing, enable uid, disable uid');
  assert.match(idx, /uid: refusalUid, paired: false/);
  assert.match(idx, /uid: refusalUid, paired: true/);
});

test('config resolves the INVOKING user home under sudo (not root home)', () => {
  const cfg = SRC('src/config.ts');
  assert.match(cfg, /SUDO_USER/);
  assert.match(cfg, /function configHomeDir/);
  // The config must not be a bare homedir() join any more — that was the bug.
  assert.ok(!/const CONFIG_DIR = join\(homedir\(\)/.test(cfg),
    'CONFIG_DIR must go through configHomeDir(), never bare homedir()');
});
