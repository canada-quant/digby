/**
 * PRE-LOGIN CREDENTIAL MODEL — tests (2026-11-01, ticket c468f922).
 *
 * THE OWNER'S RULING this file pins, in the owner's own words:
 *
 *   card oq_96b31bed, answered 2026-11-01 —
 *   "(d) + (b) together — recommended"
 *
 * TeamViewer's "Easy Access" is a privileged helper, NOT a stored password: its
 * Windows service / macOS root daemon buys the ABILITY to show and type at the
 * login screen, while the OS password is still typed by the human operator who
 * connects, and TeamViewer deliberately stores no OS password. Digby is
 * autonomous, so there is no human at the far end — the one piece that does not
 * transfer, and the piece that settled the fork.
 *
 * So the ruling separates two things that were previously welded together:
 *   (d) capability — a privileged helper MAY post input at the login window;
 *   (b) posture    — the unattended preset keeps a device from idling locked;
 * and explicitly REJECTS option (a), the helper that holds the login password.
 *
 * WHY THIS FILE EXISTS. Before this, the "no stored credential" guarantee lived
 * only in a decision card and a prose paragraph in docs/UNATTENDED_DEVICES.md.
 * Prose does not fail a build. A later lane reading "add a privileged helper"
 * could reintroduce a root-Keychain password and every test would stay green.
 * These assertions make the REJECTED option fail loudly instead.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED: that (d) is implemented. It is not —
 * no privileged helper ships, so `status` must stay honestly 'unavailable'.
 * A test that demanded 'available' here would be pinning a fiction.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRELOGIN_CREDENTIAL_MODEL,
  PRELOGIN_CREDENTIAL_POLICY,
  preloginInputFor,
} from './prelogin-capability';

// backend/src/modules/crossmodel/imessage → the repo root is five levels up.
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const PRELOGIN_SRC = readFileSync(
  join(REPO, 'backend/src/modules/crossmodel/imessage/prelogin-capability.ts'),
  'utf8',
);

describe('the owner ruling (d)+(b) as data — capability without custody', () => {
  it('names the model the owner actually chose', () => {
    expect(PRELOGIN_CREDENTIAL_MODEL).toBe('owner-typed-never-stored');
  });

  it('a privileged helper is permitted — this is the (d) capability half', () => {
    // The owner did NOT pick (c) "ship neither": the helper is allowed.
    expect(PRELOGIN_CREDENTIAL_POLICY.privilegedHelper).toBe(true);
  });

  it('…but it may NEVER hold the OS login password — the (a) option the owner rejected', () => {
    // This is the load-bearing assertion in the whole file. If a future lane
    // flips this to true, it has silently reversed an owner security decision.
    expect(PRELOGIN_CREDENTIAL_POLICY.storesOsPassword).toBe(false);
  });

  it('the password comes from the human, at the moment the device is locked', () => {
    expect(PRELOGIN_CREDENTIAL_POLICY.passwordSource).toBe('human-on-demand');
  });

  it('the (b) half: the unattended preset is the default posture', () => {
    // (d)+(b) TOGETHER — not (d) alone. The preset is what stops most devices
    // reaching a lock screen at all, so the helper stays the rare escape hatch.
    expect(PRELOGIN_CREDENTIAL_POLICY.unattendedPresetDefault).toBe(true);
  });
});

describe('no credential can ride the capability payload', () => {
  it('the capability object carries exactly status/blockedNow/reason — no credential field', () => {
    // A wire-shape pin, not a source grep: even if someone adds a password to
    // the agent row, there is no slot for it on the capability a lane reads.
    for (const agent of [
      {},
      { unattended: 'on,locked' },
      { unattended: { enabled: true, blockers: ['filevault'] } },
    ]) {
      expect(Object.keys(preloginInputFor(agent as never)).sort()).toEqual([
        'blockedNow',
        'reason',
        'status',
      ]);
    }
  });

  it('neither reason string ever asks for, or mentions storing, a password', () => {
    // The reasons are the only prose this module puts in front of a lane. They
    // must never suggest that supplying a password is the remedy.
    for (const agent of [{}, { unattended: 'on,locked' }, { unattended: { enabled: true } }]) {
      const { reason } = preloginInputFor(agent as never);
      expect(reason).not.toMatch(/enter your password|save (the |your )?password|store (the |your )?password/i);
    }
  });
});

describe('the ruling does not fake the capability (d) has not shipped yet', () => {
  it('status stays `unavailable` while no privileged helper exists', () => {
    // The honest half. (d) is DECIDED, not BUILT: a root LaunchDaemon /
    // LocalSystem service is still absent from this tree, so a locked device
    // still cannot be typed into. Reporting 'available' would make lanes
    // dispatch work that cannot land — the exact burn this ticket exists to end.
    expect(preloginInputFor({}).status).toBe('unavailable');
    expect(preloginInputFor({ unattended: 'on,locked' }).status).toBe('unavailable');
  });

  it('the accepted cost is stated: a locked device still waits for a human', () => {
    const { reason } = preloginInputFor({ unattended: 'on,locked' });
    expect(reason).toMatch(/unlock the device once/);
  });
});

describe('the module itself never persists an OS credential', () => {
  it('prelogin-capability.ts is a PURE LEAF — it cannot write or shell out at all', () => {
    // Structural, not prose. The module's whole job is to ANSWER a capability
    // question; it has no business holding a database handle, a filesystem
    // handle or a subprocess. Asserting the absence of those capabilities is
    // what makes "this module can never store a password" true by construction
    // rather than by comment. (A grep for the literal string 'kcpassword' would
    // be worse than useless here — the doc comment NAMES that file precisely to
    // forbid writing it, so the honest grep would flag the prohibition.)
    const imports = PRELOGIN_SRC.match(/^import[\s\S]*?from\s+'[^']+';?$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0); // the pin must be able to fail
    for (const line of imports) {
      expect(line).not.toMatch(/'(fs|node:fs|child_process|node:child_process)'/);
      expect(line).not.toMatch(/@prisma\/client|prisma/i);
      expect(line).not.toMatch(/ioredis|redis/i);
    }
    // No credential-writing API is even reachable without those imports.
    expect(PRELOGIN_SRC).not.toMatch(/execSync|spawnSync|writeFileSync|execFileSync/);
    expect(PRELOGIN_SRC).not.toMatch(/prisma\./);
  });

  it('the policy is exported so a helper-facing surface reads it from ONE place', () => {
    expect(PRELOGIN_SRC).toContain('export const PRELOGIN_CREDENTIAL_POLICY');
    expect(PRELOGIN_SRC).toContain('export const PRELOGIN_CREDENTIAL_MODEL');
  });
});