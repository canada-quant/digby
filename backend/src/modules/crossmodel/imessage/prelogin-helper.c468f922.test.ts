/**
 * PRE-LOGIN HELPER — tests (2026-11-01, ticket c468f922, option (d)).
 *
 * THE OWNER'S RULING this file pins, in the owner's own words:
 *
 *   card oq_96b31bed, answered 2026-11-01 —
 *   "(d) + (b) together — recommended"
 *
 *   (d) = a privileged helper that buys the ABILITY to render and post input
 *         at the login window. CAPABILITY ONLY.
 *   (b) = the "Unattended / Autonomous use" preset stays the default posture.
 *   (a) = helper + the login password in the root Keychain. REJECTED.
 *
 * TeamViewer is the worked example the owner asked about and it is exactly
 * (d): a root daemon buys the ABILITY to reach the login screen, and the OS
 * password is still typed by the human who connects. TeamViewer stores no OS
 * password. So does this helper.
 *
 * THE CONTRACT PINNED HERE:
 *   1. The vocabulary is CLOSED and a credential cannot ride it — structurally,
 *      not by convention.
 *   2. Unknown NEVER becomes ready (a device that never advertised is not a
 *      device with a working helper).
 *   3. A helper that claims credential custody can NEVER read as ready — the
 *      owner's rejected option (a) fails closed, not open.
 *   4. The daemon plist carries no credential key of any kind.
 *   5. Revoke is BOOTOUT-THEN-RM (order asserted), and verification is a
 *      read-back, not an intention.
 *   6. `prelogin_input` composes FROM this verdict and keeps its exact
 *      three-key wire shape.
 *   7. The module is a pure leaf: it imports nothing, so it cannot shell out,
 *      write a file or hold a database handle.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HELPER_OFF,
  HELPER_OFF_REASON,
  HELPER_ON,
  HELPER_UNKNOWN_REASON,
  PRELOGIN_HELPER_ADVERT_PARAM,
  PRELOGIN_HELPER_BINARY,
  PRELOGIN_HELPER_BLOCKER_PRIORITY,
  PRELOGIN_HELPER_INSTALL_DIR,
  PRELOGIN_HELPER_LABEL,
  PRELOGIN_HELPER_PLIST,
  helperStatusLine,
  normalizePreloginHelper,
  planMacHelperInstall,
  planMacHelperRevert,
  preloginHelperAdvertValue,
  preloginHelperReadyFor,
  preloginHelperVerdict,
  reasonForHelperBlocker,
  renderHelperPlist,
  verifyMacHelperRevert,
} from './prelogin-helper';
import { PRELOGIN_CREDENTIAL_POLICY, preloginInputFor } from './prelogin-capability';

// backend/src/modules/crossmodel/imessage → the repo root is five levels up.
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');
const HELPER_SRC = SRC('backend/src/modules/crossmodel/imessage/prelogin-helper.ts');

describe('the daemon is a system LaunchDaemon — the whole point of the ticket', () => {
  it('lives in /Library/LaunchDaemons under an ai.digby label', () => {
    expect(PRELOGIN_HELPER_PLIST).toBe(`/Library/LaunchDaemons/${PRELOGIN_HELPER_LABEL}.plist`);
    expect(PRELOGIN_HELPER_LABEL).toBe('ai.digby.prelogin-helper');
  });

  it('installs to its OWN root tree, not the yield-able user-agent payload', () => {
    // postinstall's 405927c9 yield removes /Library/Digby/imessage-agent when a
    // self-managed install owns the Mac. A system daemon must not be collateral
    // damage of a USER-level installer deciding to yield.
    expect(PRELOGIN_HELPER_INSTALL_DIR).toBe('/Library/Digby/prelogin-helper');
    expect(PRELOGIN_HELPER_INSTALL_DIR.startsWith('/Library/Digby/imessage-agent')).toBe(false);
    expect(PRELOGIN_HELPER_BINARY.startsWith(PRELOGIN_HELPER_INSTALL_DIR)).toBe(true);
  });

  it('the advert param sits beside the existing closed-vocabulary params', () => {
    expect(PRELOGIN_HELPER_ADVERT_PARAM).toBe('preloginhelper');
  });
});

describe('normalizePreloginHelper — closed vocabulary, absent-never-clobbers', () => {
  it('an ABSENT param is undefined, so a legacy agent never wipes a stored verdict', () => {
    expect(normalizePreloginHelper(undefined)).toBeUndefined();
    expect(normalizePreloginHelper(null)).toBeUndefined();
    expect(normalizePreloginHelper(42)).toBeUndefined();
  });

  it('unknown tokens are DROPPED — a newer agent cannot break the poll or inject blockers', () => {
    const a = normalizePreloginHelper('on,not-loaded,some-future-blocker');
    expect(a?.blockers).toEqual(['not-loaded']);
    expect(a?.installed).toBe(true);
  });

  it('a garbage string advertises nothing rather than a fabricated state', () => {
    expect(normalizePreloginHelper('nonsense,entirely')).toBeUndefined();
  });

  it('`off` is a POSITIVE proof of absence, distinct from never having reported', () => {
    const off = normalizePreloginHelper(HELPER_OFF);
    expect(off).toMatchObject({ installed: false, loaded: false, off: true });
    // …while absent stays undefined (unknown).
    expect(normalizePreloginHelper('')).toBeUndefined();
  });

  it('`on` wins a conflict, so an ambiguous advert can never clear a stored green', () => {
    const a = normalizePreloginHelper(`${HELPER_ON},${HELPER_OFF}`);
    expect(a?.installed).toBe(true);
    expect(a?.off).toBeUndefined();
  });

  it('an object advert (the stored/pair-body shape) round-trips', () => {
    const a = normalizePreloginHelper({ installed: true, loaded: false, blockers: ['not-loaded'] });
    expect(a).toEqual({ installed: true, loaded: false, blockers: ['not-loaded'] });
  });

  it('installed but not loaded is NOT loaded — a plist launchd never bootstrapped is inert', () => {
    const a = normalizePreloginHelper('on,not-loaded');
    expect(a?.installed).toBe(true);
    expect(a?.loaded).toBe(false);
    const v = preloginHelperVerdict(a);
    expect(v.ready).toBe(false);
    expect(v.state).toBe('blocked');
    expect(v.reason).toBe(reasonForHelperBlocker('not-loaded'));
  });
});

describe('no credential can ride the advert wire (criterion 5 at the agent end)', () => {
  it('preloginHelperAdvertValue emits ONLY closed-vocabulary tokens', () => {
    const v = preloginHelperAdvertValue({ installed: true, loaded: true, blockers: ['unsigned'] });
    expect(v).toBe(`on,unsigned`);
    for (const token of v.split(',')) {
      expect([HELPER_ON, HELPER_OFF, ...PRELOGIN_HELPER_BLOCKER_PRIORITY.map((b) => b.token)]).toContain(token);
    }
  });

  it('a secret passed in by accident has nowhere to go', () => {
    // The shape is the guarantee: there is no field for a password, and the
    // only string produced is a join over the closed vocabulary.
    const smuggled = {
      installed: true,
      loaded: true,
      blockers: ['unsigned'],
      password: 'hunter2',
      keychainItem: 'login-password',
    } as never;
    const v = preloginHelperAdvertValue(smuggled);
    expect(v).not.toContain('hunter2');
    expect(v).not.toContain('keychain');
  });
});

describe('the verdict fails CLOSED on the option the owner rejected', () => {
  it('unknown (never advertised) is NEVER ready', () => {
    const v = preloginHelperVerdict(undefined);
    expect(v.ready).toBe(false);
    expect(v.state).toBe('unavailable');
    expect(v.reason).toBe(HELPER_UNKNOWN_REASON);
  });

  it('absent-by-proof is `off` — a healthy default, and still not ready', () => {
    const v = preloginHelperVerdict(normalizePreloginHelper(HELPER_OFF));
    expect(v.state).toBe('off');
    expect(v.ready).toBe(false);
    expect(v.reason).toBe(HELPER_OFF_REASON);
  });

  it('installed + loaded + no blockers is ready (the (d) capability exists)', () => {
    const v = preloginHelperVerdict(normalizePreloginHelper('on'));
    expect(v.state).toBe('on');
    expect(v.ready).toBe(true);
  });

  it('THE GATE: if the policy ever allows credential custody, ready goes FALSE', () => {
    // This is the assertion that makes the owner's ruling structural rather
    // than advisory. A future lane that flips storesOsPassword to true does not
    // get a green fleet — it gets a blocked one, naming credential custody.
    const ready = normalizePreloginHelper('on');
    const withRuling = preloginHelperVerdict(ready, PRELOGIN_CREDENTIAL_POLICY);
    expect(withRuling.ready).toBe(true); // the real policy forbids custody

    const ifReversed = preloginHelperVerdict(ready, { storesOsPassword: true });
    expect(ifReversed.ready).toBe(false);
    expect(ifReversed.state).toBe('blocked');
    expect(ifReversed.reason).toBe(reasonForHelperBlocker('credential-custody'));
  });

  it('credential-custody OUTRANKS every other blocker (it is a ruling breach)', () => {
    const tokens = PRELOGIN_HELPER_BLOCKER_PRIORITY.map((b) => b.token);
    expect(tokens[0]).toBe('credential-custody');
    const v = preloginHelperVerdict(
      normalizePreloginHelper('on,stale,credential-custody,unsigned'),
    );
    expect(v.reason).toBe(reasonForHelperBlocker('credential-custody'));
  });

  it('the real policy still forbids custody, so the gate is not vacuous', () => {
    expect(PRELOGIN_CREDENTIAL_POLICY.storesOsPassword).toBe(false);
  });

  it('preloginHelperReadyFor reads the stored row and never throws on garbage', () => {
    expect(preloginHelperReadyFor({ preloginHelper: 'on' }).ready).toBe(true);
    expect(preloginHelperReadyFor({ preloginHelper: 'on,unsigned' }).ready).toBe(false);
    expect(preloginHelperReadyFor({}).ready).toBe(false);
    expect(preloginHelperReadyFor(undefined).ready).toBe(false);
  });
});

describe('the daemon plist carries NO credential key — the enforcement half of (d)', () => {
  const plist = renderHelperPlist();
  // Assert against the plist WITHOUT its XML comments. The comment block names
  // the forbidden mechanisms on purpose ("no Keychain item, no kcpassword
  // write") — a grep over the raw text would flag the PROHIBITION rather than
  // a violation, which is a false pass in disguise. Strip comments, then the
  // assertion is about what launchd actually reads.
  const plistKeysOnly = plist.replace(/<!--[\s\S]*?-->/g, '');

  it('is a well-formed plist naming the helper label and binary', () => {
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain(PRELOGIN_HELPER_LABEL);
    expect(plist).toContain(PRELOGIN_HELPER_BINARY);
    expect(plist).toContain('serve');
  });

  it('has no password / keychain / credential key of ANY kind', () => {
    // The load-bearing assertion. A future lane that "just" adds a stored
    // credential to the daemon has to delete this test, which is a review
    // signal rather than a silent ship.
    expect(plistKeysOnly).not.toMatch(/<key>\s*(Password|Passphrase|Keychain|KeychainItem|Credential|Secret|Token|VNC|Login)\w*\s*<\/key>/i);
    expect(plistKeysOnly).not.toMatch(/kcpassword/i);
    expect(plistKeysOnly).not.toMatch(/hunter2/);
    // Prove the strip actually happened, so the assertion above cannot pass
    // by removing everything (the vacuity trap).
    expect(plistKeysOnly).toContain('<key>Label</key>');
    expect(plistKeysOnly.length).toBeGreaterThan(200);
  });

  it('runs at load with a restart policy (a daemon that dies must come back)', () => {
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });
});

describe('the install plan is the sequence that survives a reboot', () => {
  const plan = planMacHelperInstall({ stagedBinary: '/tmp/staged/DigbyPreloginHelper' });

  it('lays the binary and the plist down root-owned, plist 0644 root:wheel', () => {
    // launchd REFUSES a daemon plist that is group- or world-writable; 0644
    // root:wheel is the only shape it will load.
    const plistStep = plan.find((s) => s.args.includes(PRELOGIN_HELPER_PLIST) && s.cmd === 'install');
    expect(plistStep).toBeDefined();
    expect(plistStep!.args).toContain('0644');
    expect(plistStep!.args).toContain('root');
    expect(plistStep!.args).toContain('wheel');
  });

  it('bootstraps the SYSTEM domain (the domain outside every user session)', () => {
    const boot = plan.find((s) => s.cmd === 'launchctl' && s.args[0] === 'bootstrap');
    expect(boot).toBeDefined();
    expect(boot!.args).toEqual(['bootstrap', 'system', PRELOGIN_HELPER_PLIST]);
  });

  it('enables the job so a revoke/reinstall cycle is symmetric', () => {
    expect(plan.some((s) => s.cmd === 'launchctl' && s.args[0] === 'enable')).toBe(true);
  });

  it('every step states WHY (a privileged step must be auditable)', () => {
    for (const step of plan) expect(step.why.length).toBeGreaterThan(10);
  });

  it('no install step carries a secret', () => {
    for (const step of plan) {
      expect([step.cmd, ...step.args].join(' ')).not.toMatch(/password|--secret|keystore/i);
    }
  });
});

describe('the revoke plan is BOOTOUT-THEN-RM, verified', () => {
  const plan = planMacHelperRevert();

  it('boots the job OUT of the system domain BEFORE removing the plist', () => {
    // The order is load-bearing: launchd reloads any plist that still exists
    // at boot, so `rm` first leaves the daemon running until reboot (the
    // retire-bundled-helper.ts:128-178 lesson, adapted gui/<uid> → system).
    const bootout = plan.findIndex((s) => s.cmd === 'launchctl' && s.args[0] === 'bootout');
    const rmPlist = plan.findIndex((s) => s.cmd === 'rm' && s.args.includes(PRELOGIN_HELPER_PLIST));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(rmPlist).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(rmPlist);
  });

  it('disables the label so a leftover plist cannot resurrect the job at boot', () => {
    expect(plan.some((s) => s.cmd === 'launchctl' && s.args[0] === 'disable')).toBe(true);
  });

  it('removes the binary tree as well as the plist', () => {
    expect(plan.some((s) => s.cmd === 'rm' && s.args.includes(PRELOGIN_HELPER_INSTALL_DIR))).toBe(true);
  });

  it('has NO credential-deleting step — by design (d) never creates one', () => {
    // This absence IS the ruling. A credential-shredding step here would imply
    // one existed; the verify function checks for that positively instead.
    const joined = plan.map((s) => `${s.cmd} ${s.args.join(' ')}`).join('\n');
    expect(joined).not.toMatch(/VNCSettings|kcpassword|security delete-generic-password/);
  });

  it('ends with a read-back verification step', () => {
    const last = plan[plan.length - 1];
    expect(last.cmd).toBe('launchctl');
    expect(last.why).toMatch(/VERIFY/);
  });
});

describe('verifyMacHelperRevert — "revoked" is a claim with a check behind it', () => {
  const clean = { plistExists: false, dirExists: false, jobLoaded: false };

  it('clean only when the job, the plist AND the tree are all gone', () => {
    expect(verifyMacHelperRevert(clean)).toEqual({ clean: true, remaining: [] });
  });

  it('a still-loaded daemon outranks everything (it is still able to type)', () => {
    const v = verifyMacHelperRevert({ ...clean, jobLoaded: true });
    expect(v.clean).toBe(false);
    expect(v.remaining[0]).toMatch(/still loaded in the system domain/);
  });

  it('a surviving plist or tree is named', () => {
    expect(verifyMacHelperRevert({ ...clean, plistExists: true }).remaining.join()).toContain(PRELOGIN_HELPER_PLIST);
    expect(verifyMacHelperRevert({ ...clean, dirExists: true }).remaining.join()).toContain(PRELOGIN_HELPER_INSTALL_DIR);
  });

  it('a SURVIVING CREDENTIAL is reported as an owner-ruling breach, not a tidy-up', () => {
    // The positive half of "option (d) stores nothing": if a credential
    // artifact is found after a revoke, something reintroduced option (a).
    const v = verifyMacHelperRevert({
      ...clean,
      credentialArtifacts: ['/Library/Keychains/System.keychain (login-password)'],
    });
    expect(v.clean).toBe(false);
    expect(v.remaining.join()).toMatch(/owner-ruling breach/);
  });
});

describe('helperStatusLine — the `prelogin-helper status` read-out', () => {
  it('nothing installed at all reads as the healthy `off` default', () => {
    const v = helperStatusLine({ plistExists: false, jobLoaded: false, binaryExists: false });
    expect(v.state).toBe('off');
    expect(v.ready).toBe(false);
  });

  it('plist without its program is `no-binary`, not ready', () => {
    const v = helperStatusLine({ plistExists: true, jobLoaded: false, binaryExists: false });
    expect(v.reason).toBe(reasonForHelperBlocker('no-binary'));
    expect(v.ready).toBe(false);
  });

  it('installed but never bootstrapped is `not-loaded`, not ready', () => {
    const v = helperStatusLine({ plistExists: true, jobLoaded: false, binaryExists: true });
    expect(v.reason).toBe(reasonForHelperBlocker('not-loaded'));
    expect(v.ready).toBe(false);
  });

  it('installed + loaded + program present is ready', () => {
    const v = helperStatusLine({ plistExists: true, jobLoaded: true, binaryExists: true });
    expect(v.state).toBe('on');
    expect(v.ready).toBe(true);
  });
});

describe('prelogin_input composes from the helper verdict and stays honest', () => {
  it('a device with a ready helper reports `available` — the hardcoded flip', () => {
    // THE FLIP. Before this change preloginInputFor() returned 'unavailable'
    // unconditionally; a device that has not advertised a helper still does.
    const cap = preloginInputFor({ preloginHelper: 'on' });
    expect(cap.status).toBe('available');
    expect(cap.blockedNow).toBe(false);
    expect(cap.reason).toMatch(/login password is typed by a human/);
  });

  it('a locked device WITH a helper says so honestly — the accepted cost, not a bug', () => {
    const cap = preloginInputFor({ preloginHelper: 'on', unattended: 'on,locked' });
    expect(cap.status).toBe('available');
    expect(cap.blockedNow).toBe(true);
    expect(cap.reason).toMatch(/typed by a human at the Mac/);
    // It must never suggest supplying a password as the remedy.
    expect(cap.reason).not.toMatch(/enter your password|save (the |your )?password/i);
  });

  it('a device that never advertised a helper still reports `unavailable`', () => {
    // The legacy-agent case is unchanged: this must not become a false green
    // for the entire installed fleet.
    expect(preloginInputFor({}).status).toBe('unavailable');
    expect(preloginInputFor({ unattended: 'on,locked' }).status).toBe('unavailable');
  });

  it('a blocked helper surfaces ITS remedy rather than the generic preset nag', () => {
    const cap = preloginInputFor({ preloginHelper: 'on,unsigned', unattended: 'on' });
    expect(cap.status).toBe('unavailable');
    expect(cap.reason).toBe(reasonForHelperBlocker('unsigned'));
  });

  it('the capability wire shape stays exactly status/blockedNow/reason', () => {
    // No fourth slot ⇒ a credential can never start riding the capability.
    for (const agent of [
      {},
      { preloginHelper: 'on' },
      { preloginHelper: 'on,unsigned' },
      { preloginHelper: 'on', unattended: 'on,locked' },
    ]) {
      expect(Object.keys(preloginInputFor(agent as never)).sort()).toEqual([
        'blockedNow',
        'reason',
        'status',
      ]);
    }
  });
});

describe('P2 regressions (review 2026-11-02) — each reported defect is now pinned', () => {
  it('a custody breach without a positive install signal reads BLOCKED, never the healthy `off`', () => {
    // Reported defect: preloginHelperVerdict checked `!installed` BEFORE the
    // blocker scan, so a custody breach — which an agent can only emit as a
    // bare token — rendered as "off — the default". The owner's REJECTED
    // option (a) must never look like a healthy device.
    const v = preloginHelperVerdict(normalizePreloginHelper({ blockers: ['credential-custody'] }));
    expect(v.state).toBe('blocked');
    expect(v.ready).toBe(false);
    expect(v.reason).toBe(reasonForHelperBlocker('credential-custody'));
    expect(v.reason).not.toBe(HELPER_OFF_REASON);
  });

  it('a LOADED daemon with no plist is never reported as "no helper installed"', () => {
    // Reported defect: helperStatusLine collapsed loaded-without-plist to
    // `off`, which would send an operator to install a SECOND copy on top of a
    // live pre-login daemon.
    const v = helperStatusLine({ plistExists: false, jobLoaded: true, binaryExists: true });
    expect(v.state).not.toBe('off');
    expect(v.installed).toBe(true);
    expect(v.ready).toBe(true); // loaded + no blockers = the capability IS live
  });

  it('the devicePayload surface enforces the policy exactly like prelogin_input', () => {
    // Reported defect: devicePayload called preloginHelperReadyFor(agent) with
    // NO policy argument, so a custody flip would block the capability while
    // the fleet row still read ready:true. Both surfaces must answer alike.
    const ready = { preloginHelper: 'on' };
    const capability = preloginInputFor(ready);
    const fleetRow = preloginHelperReadyFor(ready, PRELOGIN_CREDENTIAL_POLICY);
    expect(capability.status).toBe('available');
    expect(fleetRow.ready).toBe(true);
    // …and under a hypothetical custody-permitting policy BOTH must refuse.
    expect(preloginHelperVerdict(normalizePreloginHelper('on'), { storesOsPassword: true }).ready).toBe(false);
  });

  it('the credential-custody remedy names real commands, not a nonexistent subcommand', () => {
    // Reported defect: the text told operators to run `digby-agent
    // prelogin-helper revoke`, which does not exist — an operator following a
    // ruling-breach message would hit "unknown command".
    const reason = reasonForHelperBlocker('credential-custody');
    expect(reason).not.toMatch(/digby-agent prelogin-helper revoke/);
    expect(reason).toContain('launchctl bootout system');
    expect(reason).toContain(PRELOGIN_HELPER_PLIST);
  });

  it('`stale` stays in the vocabulary — dropping it would vanish a stale advert into a false green', () => {
    // The normalizer drops unknown tokens, so removing this row would make a
    // stale helper's advert disappear and read as a healthy `on`.
    expect(normalizePreloginHelper('on,stale')?.blockers).toEqual(['stale']);
    expect(preloginHelperVerdict(normalizePreloginHelper('on,stale')).state).toBe('blocked');
  });
});

describe('the module itself is a pure leaf and never persists a credential', () => {
  it('imports NOTHING — it cannot shell out, write a file or hold a handle', () => {
    // Structural, not prose. The same discipline prelogin-capability.ts is
    // pinned to: asserting the ABSENCE of those capabilities is what makes
    // "this module can never store a password" true by construction.
    const imports = HELPER_SRC.match(/^import[\s\S]*?from\s+'[^']+';?$/gm) ?? [];
    expect(imports).toEqual([]);
    expect(HELPER_SRC).not.toMatch(/require\(/);
    expect(HELPER_SRC).not.toMatch(/execSync|spawnSync|writeFileSync|execFileSync/);
    expect(HELPER_SRC).not.toMatch(/prisma\./);
  });

  it('the credential-holding option is described as REJECTED in the source', () => {
    // Keeps the reasoning attached to the code so a future lane cannot read the
    // absence of a credential store as an unfinished feature.
    expect(HELPER_SRC).toMatch(/REJECTED/);
    expect(HELPER_SRC).toMatch(/oq_96b31bed/);
  });
});