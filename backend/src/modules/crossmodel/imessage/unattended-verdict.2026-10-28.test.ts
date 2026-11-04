/**
 * "Unattended / Autonomous use" fleet-side verdict — tests (2026-10-28).
 *
 * THE INCIDENT: three owner cards in one day asked for the same single physical
 * act — unlock mbp-1 at the macOS login screen — because macOS puts the login
 * window BELOW every TCC permission. Lanes had no device-level fact to read, so
 * they filed lock-screen cards against machines that were fixable in one
 * setting.
 *
 * The contract pinned here:
 *   1. Unknown agent tokens are DROPPED (forward compatible; never a false ready).
 *   2. An ABSENT advert normalizes to undefined — absent-never-clobbers, so a
 *      legacy agent never wipes a stored verdict.
 *   3. The verdict reports the FIRST blocker in PRIORITY order, so a lane reads
 *      one actionable sentence instead of triaging a checklist.
 *   4. `ready` is true ONLY for enabled + zero blockers. Unknown ≠ ready.
 *   5. The token vocabulary is pinned to BOTH agents' vocabularies (source pins
 *      over their src) — a wire drift is the failure mode that would silently
 *      show a stranded device as ready.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeUnattended,
  unattendedVerdict,
  unattendedReadyFor,
  reasonForBlocker,
  BLOCKER_PRIORITY,
} from './unattended-verdict';

// backend/src/modules/crossmodel/imessage → the repo root is five levels up.
const REPO = join(__dirname, '..', '..', '..', '..', '..');

describe('normalizeUnattended — the wire → stored shape', () => {
  it('parses the poll query list, keeping only known blocker tokens', () => {
    expect(normalizeUnattended('on,ok')).toEqual({ enabled: true, blockers: [] });
    expect(normalizeUnattended('on,filevault')).toEqual({ enabled: true, blockers: ['filevault'] });
    expect(normalizeUnattended('on,lock,sleep')).toEqual({ enabled: true, blockers: ['lock', 'sleep'] });
  });

  it('DROPS an unknown token instead of propagating it (a newer agent must not break the poll)', () => {
    // A 2027 agent reports a blocker this backend has never heard of: it is
    // ignored, so the row still normalizes — but it can never turn into a
    // fabricated reason OR a fabricated ready (the enabled gate still applies).
    expect(normalizeUnattended('on,some-future-blocker')).toEqual({ enabled: true, blockers: [] });
    expect(normalizeUnattended('on,filevault,some-future-blocker')).toEqual({ enabled: true, blockers: ['filevault'] });
  });

  it('reorders blockers into PRIORITY order so the deciding one is first in the row', () => {
    // The agent may report them in detection order; the stored row is stable.
    expect(normalizeUnattended('on,lock,filevault')!.blockers).toEqual(['filevault', 'lock']);
  });

  it('`ok` is a state mark, never a blocker', () => {
    expect(normalizeUnattended('on,ok,lock')).toEqual({ enabled: true, blockers: ['lock'] });
  });

  it('an ABSENT advert normalizes to undefined (absent-never-clobbers)', () => {
    expect(normalizeUnattended(undefined)).toBeUndefined();
    expect(normalizeUnattended(null)).toBeUndefined();
    expect(normalizeUnattended('')).toBeUndefined();
    expect(normalizeUnattended('   ')).toBeUndefined();
    expect(normalizeUnattended([])).toBeUndefined();
    expect(normalizeUnattended(42)).toBeUndefined();
  });

  it('a list of only unknown tokens with no `on` is NOT an advert (nothing recognizable)', () => {
    expect(normalizeUnattended('unknown-token')).toBeUndefined();
  });

  it('accepts the pair-body array and the stored object round-trip', () => {
    expect(normalizeUnattended(['on', 'filevault'])).toEqual({ enabled: true, blockers: ['filevault'] });
    expect(normalizeUnattended({ enabled: true, blockers: ['hello'] })).toEqual({ enabled: true, blockers: ['hello'] });
    // Ticket 11b6974f: an explicit `enabled:false` IS a report, so it carries
    // the proved-off flag (that is what keeps it distinct from "never reported").
    expect(normalizeUnattended({ enabled: false, blockers: [] })).toEqual({ enabled: false, blockers: [], off: true });
  });

  it('is case/whitespace tolerant (a hand-typed value in a log must still parse)', () => {
    expect(normalizeUnattended(' ON , FileVault ')).toEqual({ enabled: true, blockers: ['filevault'] });
  });
});

describe('unattendedVerdict — what a lane reads before filing an unlock card', () => {
  it('a never-advertised device is an honest NO, not a false ready', () => {
    const v = unattendedVerdict(undefined);
    expect(v.ready).toBe(false);
    expect(v.enabled).toBe(false);
    // TICKET 11b6974f: `unavailable` = NOT MEASURED. It must never be worded as
    // if the owner could have switched something on — that conflation is the
    // defect (all 5 paired devices read the old "not configured" sentence).
    expect(v.state).toBe('unavailable');
    expect(v.reason).toMatch(/not reported/);
    // …and the reason tells the lane the fix, rather than saying "unlock it".
    expect(v.reason).toMatch(/update the agent/);
  });

  it('an opted-out device says so plainly (opt-in, off by default)', () => {
    const v = unattendedVerdict({ enabled: false, blockers: [] });
    expect(v).toMatchObject({ state: 'off', enabled: false, ready: false });
    expect(v.reason).toMatch(/preset not enabled/);
  });

  it('enabled + no blockers = READY (the state that stops the card spam)', () => {
    expect(unattendedVerdict({ enabled: true, blockers: [] })).toEqual({
      state: 'ready',
      enabled: true,
      ready: true,
      reason: '',
    });
  });

  it('reports the FIRST blocker in priority order — one actionable sentence', () => {
    const v = unattendedVerdict({ enabled: true, blockers: ['lock', 'filevault', 'sleep'] });
    expect(v.ready).toBe(false);
    expect(v.enabled).toBe(true);
    expect(v.state).toBe('blocked');
    // FileVault outranks a reverted lock setting: it is the one that makes the
    // others moot (no auto-login at all on a FileVault volume).
    expect(v.reason).toMatch(/FileVault/);
    expect(v.reason).toMatch(/turn FileVault off/);
  });

  it('every blocker token has a human reason naming what to do', () => {
    for (const { token, reason } of BLOCKER_PRIORITY) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reasonForBlocker(token)).toBe(reason);
    }
    expect(reasonForBlocker('not-a-token')).toBe('');
  });

  it('unattendedReadyFor reads a stored row and never throws on garbage', () => {
    expect(unattendedReadyFor({ unattended: { enabled: true, blockers: [] } })).toMatchObject({ ready: true });
    expect(unattendedReadyFor({ unattended: null })).toMatchObject({ ready: false });
    expect(unattendedReadyFor({})).toMatchObject({ ready: false });
    expect(unattendedReadyFor(null)).toMatchObject({ ready: false });
    expect(unattendedReadyFor(undefined)).toMatchObject({ ready: false });
    // A stored string (a hand-written migration row) still resolves.
    expect(unattendedReadyFor({ unattended: 'on,ok' })).toMatchObject({ ready: true });
  });
});

describe('ticket 11b6974f — "not enabled" must not be reported as "never reported"', () => {
  it('`off` on the wire is a MEASURED not-enabled, with the exact device command', () => {
    const v = unattendedVerdict(normalizeUnattended('off'));
    expect(v.state).toBe('off');
    expect(v.enabled).toBe(false);
    expect(v.ready).toBe(false);
    // The defect: this used to read "never reported by this build — update the
    // agent" for every device, including devices whose owner HAD enabled it.
    expect(v.reason).not.toMatch(/update the agent/);
    expect(v.reason).toContain('digby-agent unattended enable');
  });

  it('an ABSENT advert is still the agent-gap reading (absence is not a claim)', () => {
    expect(normalizeUnattended('')).toBeUndefined();
    expect(normalizeUnattended(null)).toBeUndefined();
    expect(unattendedVerdict(normalizeUnattended('')).state).toBe('unavailable');
  });

  it('the reason names the RIGHT command per platform', () => {
    expect(unattendedVerdict(normalizeUnattended('off'), 'windows').reason).toContain(
      'digby-win-agent unattended enable',
    );
    expect(unattendedVerdict(normalizeUnattended('off'), 'darwin').reason).toContain(
      'digby-agent unattended enable',
    );
    expect(unattendedVerdict(undefined, 'windows').reason).toContain('digby-win-agent unattended enable');
  });

  it('`off,locked` stays off and keeps the live-lock fact without going ready', () => {
    const a = normalizeUnattended('off,locked');
    expect(a).toMatchObject({ enabled: false, off: true, blockers: ['locked'] });
    const v = unattendedVerdict(a);
    // Gated on `enabled` FIRST, so the lock token can never read as ready.
    expect(v.state).toBe('off');
    expect(v.ready).toBe(false);
  });

  it('`on` WINS a contradictory advert — off can never clear a stored green', () => {
    const a = normalizeUnattended('on,off');
    expect(a?.enabled).toBe(true);
    expect(a?.off).toBeUndefined();
    expect(unattendedVerdict(a).state).toBe('ready');
  });

  it('a stored row round-trips the proved-off fact (JSONB keeps the distinction)', () => {
    const stored = normalizeUnattended('off');
    expect(stored).toBeDefined();
    // What lands in the DB, read back by the next poll's verdict.
    const reread = normalizeUnattended(stored);
    expect(reread).toMatchObject({ enabled: false, off: true });
    expect(unattendedVerdict(reread).state).toBe('off');
  });

  it('an older stored row (no off flag, enabled:false) still reads as off, not unavailable', () => {
    // A row written before this change: the object shape with enabled:false IS
    // a report, so it must not be re-labelled an agent gap.
    expect(unattendedReadyFor({ unattended: { enabled: false, blockers: [] } }).state).toBe('off');
  });
});

describe('wire parity — the fleet vocabulary is pinned to BOTH agents', () => {
  /** Every token a device can legitimately send: the union of the two agents'
   *  vocabularies. A backend that drops one of these silently mis-reports a
   *  device, which is exactly the failure this feature exists to prevent. */
  const MAC_TOKENS = ['filevault', 'autologin', 'drift', 'no-admin', 'pwd-expiry', 'fast-user', 'lock', 'sleep', 'locked'];
  const WIN_TOKENS = ['bitlocker-pin', 'credguard', 'hello', 'domain-policy', 'autologin', 'drift', 'no-admin', 'pwd-expiry', 'lock', 'sleep', 'locked'];

  it('every macOS agent token is a known backend blocker', () => {
    const known = new Set(BLOCKER_PRIORITY.map((b) => b.token));
    for (const t of MAC_TOKENS) expect(known.has(t)).toBe(true);
  });

  it('every Windows agent token is a known backend blocker', () => {
    const known = new Set(BLOCKER_PRIORITY.map((b) => b.token));
    for (const t of WIN_TOKENS) expect(known.has(t)).toBe(true);
  });

  it('the macOS agent source declares exactly that vocabulary', () => {
    const src = readFileSync(join(REPO, 'imessage-agent', 'src', 'unattended.ts'), 'utf8');
    for (const t of MAC_TOKENS) {
      expect(src).toContain(`'${t}'`);
    }
  });

  it('the Windows agent source declares exactly that vocabulary', () => {
    const src = readFileSync(join(REPO, 'windows-agent', 'src', 'unattended.ts'), 'utf8');
    for (const t of WIN_TOKENS) {
      expect(src).toContain(`'${t}'`);
    }
  });
});