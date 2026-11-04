/**
 * BROKERED REMOTE ACCESS — tests (ticket c468f922, OWNER RULING 2026-10-29 on
 * card oq_b5118c38: "can we do option three but a little more secure like how
 * it's just like TeamViewer").
 *
 * WHAT THE OWNER DECIDED. Option 3 = drive the OS's OWN remote channel (macOS
 * Screen Sharing / Windows RDP) instead of the framebuffer. The weak part of
 * plain option 3 is a permanently open inbound port per device; TeamViewer's
 * shape is the inverse — the device dials OUT to a broker and the operator
 * reaches it only through that path.
 *
 * THE CONTRACT PINNED HERE:
 *   1. The vocabulary is CLOSED and a credential cannot ride it (structurally,
 *      not by convention) — criterion 5 of the ticket.
 *   2. Priority order puts a live exposure ABOVE every configuration nag, so a
 *      public port outranks a missing nicety.
 *   3. Unknown NEVER becomes ready AND never becomes a fabricated blocker.
 *   4. An enabled-but-not-tunnel-attested device FAILS CLOSED — the fleet cannot
 *      prove the port is unreachable, so it must not read as ready.
 *   5. Absent never clobbers (a legacy agent must not wipe a stored verdict).
 *   6. The fleet surfaces (driver selection, account-tools device row, the
 *      computer_task result) actually read this module.
 *   7. It is a SEPARATE fact from prelogin_input, and prelogin_input stays
 *      honest — merging them is the bug class the ticket exists to end.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REMOTE_BLOCKER_PRIORITY,
  REMOTE_HARDEN_REQUIREMENTS,
  REMOTE_ON,
  REMOTE_TUNNEL,
  normalizeRemoteAccess,
  remoteAccessVerdict,
  remoteAccessReadyFor,
  remoteAccessAdvertValue,
  remoteChannelFor,
  remoteChannelPort,
  reasonForRemoteBlocker,
} from './remote-access-verdict';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('remote-access-verdict — the closed vocabulary (c468f922)', () => {
  it('every blocker has a non-empty, actionable reason naming what to do', () => {
    for (const b of REMOTE_BLOCKER_PRIORITY) {
      expect(b.reason.length).toBeGreaterThan(40);
      expect(reasonForRemoteBlocker(b.token)).toBe(b.reason);
    }
  });

  it('an unknown token is the empty reason, never a throw', () => {
    expect(reasonForRemoteBlocker('not-a-token')).toBe('');
    expect(reasonForRemoteBlocker('')).toBe('');
  });

  it('EXPOSURE outranks every configuration blocker (a public port is a live hole)', () => {
    const tokens = REMOTE_BLOCKER_PRIORITY.map((b) => b.token);
    expect(tokens[0]).toBe('exposed');
    // The credential error is second: it silently widens what a stolen secret
    // unlocks, so it outranks a missing nicety.
    expect(tokens[1]).toBe('account-password');
    expect(tokens.indexOf('exposed')).toBeLessThan(tokens.indexOf('no-firewall'));
    expect(tokens.indexOf('exposed')).toBeLessThan(tokens.indexOf('no-cred'));
    expect(tokens.indexOf('exposed')).toBeLessThan(tokens.indexOf('no-tunnel'));
  });

  it('the hardening contract covers exposure, firewall, credential, NLA, transport, session window', () => {
    const ids = REMOTE_HARDEN_REQUIREMENTS.map((r) => r.id);
    for (const required of ['exposure', 'firewall', 'credential', 'credential-present', 'nla', 'transport', 'session-window']) {
      expect(ids).toContain(required);
    }
    // Every requirement names a blocker that actually exists.
    const tokens = REMOTE_BLOCKER_PRIORITY.map((b) => b.token);
    for (const r of REMOTE_HARDEN_REQUIREMENTS) expect(tokens).toContain(r.blocker);
  });

  it('the firewall requirement states WHY it exists: the OS cannot bind these services', () => {
    const fw = REMOTE_HARDEN_REQUIREMENTS.find((r) => r.id === 'firewall')!;
    // Verified platform fact (ss64 kickstart flags; Windows TermService): there is
    // no bind-to-interface option, so the firewall IS the boundary. If this text
    // ever loses that fact, a future editor may "simplify" the firewall away.
    expect(fw.requirement).toMatch(/no bind-to-interface option/i);
  });
});

describe('normalizeRemoteAccess — absent never clobbers, garbage never lies', () => {
  it('returns undefined for an ABSENT param (legacy agent must not wipe a verdict)', () => {
    expect(normalizeRemoteAccess(undefined)).toBeUndefined();
    expect(normalizeRemoteAccess(null)).toBeUndefined();
  });

  it('returns undefined for empty/garbage so nothing is advertised', () => {
    expect(normalizeRemoteAccess('')).toBeUndefined();
    expect(normalizeRemoteAccess('   ')).toBeUndefined();
    expect(normalizeRemoteAccess('not-a-real-token')).toBeUndefined();
    expect(normalizeRemoteAccess([])).toBeUndefined();
    expect(normalizeRemoteAccess({})).toBeUndefined();
    expect(normalizeRemoteAccess(42)).toBeUndefined();
    expect(normalizeRemoteAccess(true)).toBeUndefined();
  });

  it('parses the comma list an agent actually sends', () => {
    expect(normalizeRemoteAccess('on,tunnel')).toEqual({ enabled: true, tunnelOnly: true, blockers: [] });
    expect(normalizeRemoteAccess('on,exposed')).toEqual({ enabled: true, tunnelOnly: false, blockers: ['exposed'] });
  });

  it('drops unknown tokens (a newer agent must never break the poll)', () => {
    const out = normalizeRemoteAccess('on,tunnel,some-future-blocker');
    expect(out).toEqual({ enabled: true, tunnelOnly: true, blockers: [] });
  });

  it('emits blockers in PRIORITY order so the deciding reason is first', () => {
    const out = normalizeRemoteAccess('on,no-cred,exposed,no-firewall');
    expect(out!.blockers).toEqual(['exposed', 'no-firewall', 'no-cred']);
  });

  it('round-trips the stored object shape', () => {
    const stored = { enabled: true, tunnelOnly: true, blockers: ['no-nla'] };
    expect(normalizeRemoteAccess(stored)).toEqual(stored);
  });

  it('accepts a wire object carrying `tokens` as well as `blockers`', () => {
    expect(normalizeRemoteAccess({ tokens: ['on', 'tunnel'] })).toEqual({
      enabled: true, tunnelOnly: true, blockers: [],
    });
  });
});

describe('remoteAccessVerdict — unknown is never ready, enabled-but-unproven fails CLOSED', () => {
  it('a device that never advertised is "not configured", never ready', () => {
    const v = remoteAccessVerdict(normalizeRemoteAccess(undefined));
    expect(v.ready).toBe(false);
    expect(v.reason).toMatch(/never reported/i);
  });

  it('not enabled is not ready, and says it is opt-in', () => {
    const v2 = remoteAccessVerdict({ enabled: false, tunnelOnly: true, blockers: [] });
    expect(v2.ready).toBe(false);
    expect(v2.state).toBe('off');
    expect(v2.reason).toMatch(/opt-in, per device, off by default/i);
  });

  it('enabled + tunnel + no blockers IS ready', () => {
    const v = remoteAccessVerdict({ enabled: true, tunnelOnly: true, blockers: [] });
    expect(v).toEqual({ state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' });
  });

  it('⚠ enabled but NOT tunnel-attested fails CLOSED — the key hardening property', () => {
    const v = remoteAccessVerdict({ enabled: true, tunnelOnly: false, blockers: [] });
    expect(v.ready).toBe(false);
    // The fleet cannot prove the port is unreachable, so it must not assume the
    // better property. This is the difference between a policy and a wish.
    expect(v.reason).toMatch(/cannot prove the port is unreachable|did not advertise the brokered-tunnel/i);
  });

  it('the FIRST blocker in priority order is the one reported', () => {
    const v = remoteAccessVerdict({ enabled: true, tunnelOnly: true, blockers: ['no-cred', 'exposed'] });
    expect(v.ready).toBe(false);
    expect(v.reason).toBe(reasonForRemoteBlocker('exposed'));
  });

  it('never throws on garbage', () => {
    expect(() => remoteAccessVerdict(null)).not.toThrow();
    expect(() => remoteAccessReadyFor({ remoteAccess: 'wat' })).not.toThrow();
    expect(remoteAccessReadyFor(null).ready).toBe(false);
  });
});

describe('the three-state health line — off / on / unavailable (owner ruling 2026-10-30)', () => {
  it('a PROVED-off device is OFF, not "unavailable" — the healthy default', () => {
    const v = remoteAccessVerdict(normalizeRemoteAccess('off'));
    expect(v.state).toBe('off');
    expect(v.ready).toBe(false);
    expect(v.enabled).toBe(false);
    // The reason must NOT nag the operator to switch a listener on as the
    // remedy for a device that is correct precisely because it is off: no
    // "run remote-access enable" instruction, no "update the agent" remedy.
    // (Prose may contain "enabled"; the nag is the imperative COMMAND.)
    expect(v.reason).not.toMatch(/`?remote-access enable`?/i);
    expect(v.reason).not.toMatch(/update the agent/i);
    expect(v.reason).toMatch(/that is the default/i);
    // And the opt-in is framed as a CHOICE, not a repair.
    expect(v.reason).toMatch(/if you want/i);
  });

  it('a device that never reported is UNAVAILABLE — never confused with off', () => {
    const v = remoteAccessVerdict(normalizeRemoteAccess(undefined));
    expect(v.state).toBe('unavailable');
    expect(v.reason).toMatch(/never reported/i);
  });

  it('the three states are all reachable and mutually exclusive', () => {
    expect(remoteAccessVerdict(normalizeRemoteAccess('off')).state).toBe('off');
    expect(remoteAccessVerdict(normalizeRemoteAccess('on,tunnel')).state).toBe('on');
    expect(remoteAccessVerdict(normalizeRemoteAccess(undefined)).state).toBe('unavailable');
    expect(remoteAccessVerdict(normalizeRemoteAccess('on,exposed')).state).toBe('blocked');
  });

  it('⚠ a VERIFIED REVOKE must clear the stored green — the false-green bug', () => {
    // Shape of the incident: the device was ready, then `disable` removed the
    // listener/rule/credential and advertised `off`. Before REMOTE_OFF existed
    // the advert was empty, absent-never-clobbers kept the old row, and the
    // fleet read ready:true on a box with nothing listening.
    const beforeRevoke = remoteAccessReadyFor({ remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] } });
    expect(beforeRevoke.ready).toBe(true);
    const afterRevoke = remoteAccessReadyFor({ remoteAccess: { enabled: false, tunnelOnly: false, blockers: [], off: true } });
    expect(afterRevoke.ready).toBe(false);
    expect(afterRevoke.state).toBe('off');
  });

  it('the stored boolean `off` round-trips through normalize', () => {
    const stored = { enabled: false, tunnelOnly: false, blockers: [], off: true };
    expect(normalizeRemoteAccess(stored)).toEqual(stored);
    expect(remoteAccessVerdict(normalizeRemoteAccess(stored)).state).toBe('off');
  });

  it('`on` beats `off` when a wire value contradicts itself', () => {
    // Off must never be able to clear a green: the safe reading of an
    // ambiguous "it might be listening" is the ENABLED one.
    const out = normalizeRemoteAccess('on,off,tunnel');
    expect(out!.enabled).toBe(true);
    expect(out!.off).toBeUndefined();
    expect(remoteAccessVerdict(out).state).toBe('on');
  });

  it('an unknown listener state emits NOTHING, so it never becomes a fabricated off', () => {
    // absent-never-clobbers still holds: a probe that could not tell sends no
    // token at all, and the backend must not invent either state.
    expect(normalizeRemoteAccess('')).toBeUndefined();
    expect(remoteAccessVerdict(normalizeRemoteAccess('')).state).toBe('unavailable');
  });
});

describe('remoteAccessAdvertValue — a credential CANNOT ride the wire (criterion 5)', () => {
  it('emits only state marks and closed-vocabulary tokens', () => {
    const v = remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: ['exposed', 'no-nla'] });
    expect(v).toBe('on,tunnel,exposed,no-nla');
    for (const token of v.split(',')) {
      expect([REMOTE_ON, REMOTE_TUNNEL, ...REMOTE_BLOCKER_PRIORITY.map((b) => b.token)]).toContain(token);
    }
  });

  it('a smuggled secret has NOWHERE to go — the value stays vocabulary-only', () => {
    // Structurally true: the function reads only enabled/tunnelOnly/blockers.
    // An unexpected extra field cannot reach the wire.
    const smuggled = {
      enabled: true,
      tunnelOnly: true,
      blockers: [],
      vncPassword: 'hunter2-super-secret',
      accountPassword: 'also-secret',
    } as any;
    const v = remoteAccessAdvertValue(smuggled);
    expect(v).toBe('on,tunnel');
    expect(v).not.toContain('hunter2');
    expect(v).not.toContain('secret');
  });

  it('off advertises the empty string (the param is omitted entirely)', () => {
    expect(remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [] })).toBe('');
  });

  it('a PROVED-off device advertises `off`, not silence (owner ruling 2026-10-30)', () => {
    expect(remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [], off: true })).toBe('off');
  });

  it('`on` always wins a conflict — an ambiguous advert can never clear a green', () => {
    expect(remoteAccessAdvertValue({ enabled: true, tunnelOnly: true, blockers: [], off: true })).toBe('on,tunnel');
  });
});

describe('channel mapping — each platform gets ITS own channel, total by construction', () => {
  it('macOS → Screen Sharing on 5900, Windows → RDP on 3389', () => {
    expect(remoteChannelFor('macos')).toBe('macos-screen-sharing');
    expect(remoteChannelPort('macos-screen-sharing')).toBe(5900);
    expect(remoteChannelFor('windows')).toBe('windows-rdp');
    expect(remoteChannelPort('windows-rdp')).toBe(3389);
  });

  it('an unknown/legacy platform is treated as macOS (legacy rows are Macs)', () => {
    expect(remoteChannelFor(null)).toBe('macos-screen-sharing');
    expect(remoteChannelFor(undefined)).toBe('macos-screen-sharing');
    expect(remoteChannelFor('linux')).toBe('macos-screen-sharing');
  });
});

describe('wire parity — the fleet surfaces actually READ this module (not a lookalike)', () => {
  it('the driver selection carries the verdict on all three return paths', () => {
    const src = SRC('backend/src/modules/crossmodel/computer-agent/driver.ts');
    const hits = src.match(/remoteAccess:\s*remoteAccessReadyFor\(/g) ?? [];
    expect(hits.length).toBe(3);
    expect(src).toMatch(/import \{[^}]*remoteAccessReadyFor[^}]*\} from "\.\.\/imessage\/remote-access-verdict"/);
  });

  it('the computer_task result carries it beside prelogin (both, never merged)', () => {
    const src = SRC('backend/src/modules/crossmodel/computer-agent/computer-loop.ts');
    expect(src).toMatch(/\.\.\.\(selection\.prelogin \? \{ prelogin: selection\.prelogin \} : \{\}\)/);
    expect(src).toMatch(/\.\.\.\(selection\.remoteAccess \? \{ remoteAccess: selection\.remoteAccess \} : \{\}\)/);
  });

  it('the scheduler-facing device list exposes it', () => {
    const src = SRC('backend/src/modules/crossmodel/platform/account-tools.ts');
    // Owner ruling 2026-10-29: the device list now reads the BROKERED-SESSION
    // fold (so an overrun operator session reports `stale` here too), falling
    // back to the plain verdict when the session store gave nothing for this
    // device. The pin is on BOTH halves: the fold is the new requirement, and
    // the fallback proves a session-store hiccup still yields a real verdict
    // rather than dropping the field.
    expect(src).toMatch(/remoteAccess:\s*remoteAccessByDevice\[a\.id\]\s*\?\?\s*remoteAccessReadyFor\(a\)/);
    expect(src).toMatch(/withBrokeredSessionWindow\(a\.id,\s*normalizeRemoteAccess\(a\.remoteAccess\)\)/);
  });

  it('the /agents payload uses the same fold, so the two surfaces cannot disagree', () => {
    const ctrl = SRC('backend/src/modules/crossmodel/imessage/imessage.controller.ts');
    expect(ctrl).toMatch(
      /remoteAccess:\s*remoteAccessVerdict\(\s*await withBrokeredSessionWindow\(agent\.id,\s*normalizeRemoteAccess\(agent\.remoteAccess\)\)/,
    );
  });

  it('the poll accepts the ?remoteaccess param and persists it', () => {
    const ctrl = SRC('backend/src/modules/crossmodel/imessage/imessage.controller.ts');
    expect(ctrl).toMatch(/normalizeRemoteAccess\(req\.query\.remoteaccess\)/);
    expect(ctrl).toMatch(/advertRemoteAccess \? \{ remoteAccess: advertRemoteAccess \}/);
    const svc = SRC('backend/src/modules/crossmodel/imessage/imessage.service.ts');
    // pair-update, pair-create and the poll all persist it.
    expect((svc.match(/advert\?\.remoteAccess \? \{ remoteAccess: advert\.remoteAccess \}/g) ?? []).length).toBe(3);
  });

  it('PURE LEAF: no Prisma / Redis / logger imports (one definition for every surface)', () => {
    const src = SRC('backend/src/modules/crossmodel/imessage/remote-access-verdict.ts');
    expect(src).not.toMatch(/from '@prisma\/client'/);
    expect(src).not.toMatch(/from '\.\.\/\.\.\/\.\.\/config\/redis'/);
    expect(src).not.toMatch(/from '\.\.\/\.\.\/\.\.\/utils\/logger'/);
  });
});

describe('separation from prelogin_input — the bug class this ticket exists to end', () => {
  it('prelogin_input still reports UNAVAILABLE: a hardened channel is NOT in-session input', () => {
    // The whole point: no RFB/RDP client ships, so computer_task cannot type at
    // a login window. Reporting 'available' here would re-create the exact
    // burn-4-runs failure c468f922 was filed for.
    const src = SRC('backend/src/modules/crossmodel/imessage/prelogin-capability.ts');
    expect(src).toMatch(/status:\s*'unavailable'/);
  });

  it('the result type documents them as DIFFERENT questions', () => {
    const src = SRC('backend/src/modules/crossmodel/computer-agent/types.ts');
    expect(src).toMatch(/SEPARATE from `prelogin`/);
    expect(src).toMatch(/remoteAccess\?:/);
  });
});

describe('the migration records the owner ruling and the no-secret guarantee', () => {
  const sql = SRC('backend/prisma/migrations/20261029050000_agent_remote_access/migration.sql');

  it('adds the JSONB column on imessage_agents', () => {
    expect(sql).toMatch(/ALTER TABLE "imessage_agents" ADD COLUMN "remoteAccess" JSONB;/);
  });

  it('cites the owner ruling verbatim and the TeamViewer shape', () => {
    expect(sql).toMatch(/a little more secure like how it's/);
    expect(sql).toMatch(/TeamViewer/i);
  });

  it('states that no secret lands in the column and where the credential actually lives', () => {
    expect(sql).toMatch(/NO SECRET EVER LANDS HERE/i);
    expect(sql).toMatch(/VNCSettings\.txt/);
  });

  it('states plainly that this is NOT computer_task typing at a login screen', () => {
    expect(sql).toMatch(/NOT "computer_task CAN TYPE AT A LOGIN SCREEN"/i);
  });
});