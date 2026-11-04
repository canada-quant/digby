/**
 * PRE-LOGIN INPUT capability — tests (2026-10-28, ticket c468f922).
 *
 * THE INCIDENT. A `computer_task` aimed at `cql-stanne-mbp1` (agent v0.9.11)
 * sitting at the macOS login window accepted 0 input: refusedRepeats=0,
 * noChangeStrikes=0, and a harness positive control (Cmd+Space) produced a
 * byte-identical frame. That is not a stuck agent — macOS refuses synthetic
 * events from any app inside a logged-in user session at `loginwindow`, and the
 * Windows secure desktop is unreachable the same way. A lane had no device-level
 * fact to read, so it retried and burned 4+ runs on the deerland Amplify work.
 *
 * The contract pinned here (the ticket's own second acceptance criterion —
 * "without the helper, the agent reports a typed capability so lanes fail fast"):
 *   1. `status` is a TYPED string ('unavailable' in this build), never a bare
 *      boolean — the wire value has to be self-describing in a tool result.
 *   2. `blockedNow` is true ONLY on a POSITIVE lock report. An agent that never
 *      advertised (= every pre-2026-10-28 agent) is an honest unknown and must
 *      NOT refuse — silence never blocks work.
 *   3. Garbage in never throws and never fabricates a refusal.
 *   4. The marker a lane greps is `prelogin_input: <status>`.
 *   5. WIRE PARITY: `locked` is the token both agents emit for "at a lock/login
 *      screen right now", and all three carriers (account-tools device rows, the
 *      driver selection, the tool-result header) actually read this module.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRELOGIN_INPUT,
  PRELOGIN_LOCKED_REASON,
  PRELOGIN_OPTED_IN_REASON,
  PRELOGIN_STANDING_REASON,
  preloginInputFor,
  preloginInputMarker,
} from './prelogin-capability';
import { BLOCKER_PRIORITY, normalizeUnattended } from './unattended-verdict';

// backend/src/modules/crossmodel/imessage → the repo root is five levels up.
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('preloginInputFor — the typed capability', () => {
  it('a device that never advertised is an honest unknown: unavailable, NOT blocked', () => {
    const cap = preloginInputFor({});
    expect(cap.status).toBe('unavailable');
    // The critical half: silence must never refuse a run. Every agent that
    // shipped before 2026-10-28 lands here.
    expect(cap.blockedNow).toBe(false);
    expect(cap.reason).toBe(PRELOGIN_STANDING_REASON);
  });

  it('null / undefined / garbage resolve to the same honest unknown (never throws)', () => {
    for (const bad of [null, undefined, {}, { unattended: null }, { unattended: 'garbage-token' }]) {
      const cap = preloginInputFor(bad as never);
      expect(cap).toMatchObject({ status: 'unavailable', blockedNow: false });
    }
    expect(preloginInputFor(42 as never).blockedNow).toBe(false);
  });

  it('a POSITIVE `locked` report blocks the dispatch', () => {
    const cap = preloginInputFor({ unattended: { enabled: true, blockers: ['locked'] } });
    expect(cap.status).toBe('unavailable');
    expect(cap.blockedNow).toBe(true);
    expect(cap.reason).toBe(PRELOGIN_LOCKED_REASON);
    // The reason must name BOTH the impossibility and the way out — a lane
    // that only reads "blocked" retries.
    expect(cap.reason).toMatch(/lock \/ login screen/);
    expect(cap.reason).toMatch(/unlock the device once/);
    expect(cap.reason).toMatch(/Unattended \/ Autonomous use/);
  });

  it('`locked` is reported even when the user never opted into the preset', () => {
    // A locked device is locked whether or not the preset is on — the poll
    // carries the token either way, so the capability must not be gated on it.
    expect(preloginInputFor({ unattended: 'off,locked' }).blockedNow).toBe(true);
    expect(preloginInputFor({ unattended: ['on', 'filevault', 'locked'] }).blockedNow).toBe(true);
  });

  it('other blockers do NOT block a dispatch (only the live lock state does)', () => {
    // FileVault is a readiness problem for unattended use, not a reason to
    // refuse a device whose session is alive and drivable right now.
    const cap = preloginInputFor({ unattended: { enabled: true, blockers: ['filevault', 'sleep'] } });
    expect(cap.blockedNow).toBe(false);
    expect(cap.reason).toBe(PRELOGIN_OPTED_IN_REASON);
  });

  it('an opted-in device is NOT told to enable the preset it already enabled', () => {
    // The card-spam class this whole feature exists to end: nagging a device
    // that is already configured with "should have the preset enabled".
    const optedIn = preloginInputFor({ unattended: { enabled: true, blockers: [] } });
    expect(optedIn.reason).toBe(PRELOGIN_OPTED_IN_REASON);
    expect(optedIn.reason).not.toMatch(/should have the "Unattended/);
    // …while a device that has NOT opted in still gets the actionable line.
    expect(preloginInputFor({}).reason).toBe(PRELOGIN_STANDING_REASON);
    expect(preloginInputFor({}).reason).toMatch(/should have the "Unattended/);
  });

  it('status is a typed string, never a boolean (self-describing on the wire)', () => {
    expect(typeof preloginInputFor({}).status).toBe('string');
    expect(['available', 'unavailable']).toContain(preloginInputFor({}).status);
  });

  it('the marker a lane greps is `prelogin_input: <status>`', () => {
    expect(PRELOGIN_INPUT).toBe('prelogin_input');
    const marker = preloginInputMarker(preloginInputFor({ unattended: 'on,locked' }));
    expect(marker.startsWith('prelogin_input: unavailable (')).toBe(true);
    expect(marker).toContain(PRELOGIN_LOCKED_REASON);
  });
});

describe('wire parity — `locked` means the same thing on both agents', () => {
  it('the backend vocabulary carries `locked`, so normalizeUnattended keeps it', () => {
    // Dropped on the wire would mean a locked device read as merely
    // "not configured" — exactly the silent mis-report this feature prevents.
    expect(BLOCKER_PRIORITY.map((b) => b.token)).toContain('locked');
    expect(normalizeUnattended('on,locked')).toEqual({ enabled: true, blockers: ['locked'] });
  });

  it('both agents emit `locked` from their own live console probe', () => {
    // macOS: `stat -f %Su /dev/console` → loginwindow/_windowserver.
    const mac = SRC(join('imessage-agent', 'src', 'unattended.ts'));
    expect(mac).toContain("'locked'");
    expect(mac).toMatch(/consoleIsAtLoginWindow/);
    // Windows: `query user` shows no Active session.
    const win = SRC(join('windows-agent', 'src', 'unattended.ts'));
    expect(win).toContain("'locked'");
    expect(win).toMatch(/parseAtLockScreen/);
  });
});

describe('every carrier actually reads the capability', () => {
  it('get_account_overview device rows carry `prelogin`', () => {
    const src = SRC(join('backend', 'src', 'modules', 'crossmodel', 'platform', 'account-tools.ts'));
    expect(src).toMatch(/import \{[^}]*preloginInputFor[^}]*\} from '\.\.\/imessage\/prelogin-capability'/);
    expect(src).toMatch(/prelogin: preloginInputFor\(/);
  });

  it('the driver selection carries it on every device-selecting path', () => {
    const src = SRC(join('backend', 'src', 'modules', 'crossmodel', 'computer-agent', 'driver.ts'));
    const occurrences = src.match(/prelogin: preloginInputFor\(/g) || [];
    // auto-bound + explicit target + default pick.
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('every path that returns a REAL driver also carries `prelogin` (no path can drop it)', () => {
    // A bare occurrence count cannot prove three DISTINCT paths: one
    // reformatted line satisfies it while a fourth path loses the field, and
    // `prelogin` is OPTIONAL so tsc would not flag the omission. This asserts
    // the invariant structurally instead — within `selectComputerDriver`,
    // every `driver: new LocalComputerDriver(` return block must be followed
    // by a `prelogin:` before the next one (or the function end).
    const src = SRC(join('backend', 'src', 'modules', 'crossmodel', 'computer-agent', 'driver.ts'));
    const start = src.indexOf('export async function selectComputerDriver');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    const driverSites = [...body.matchAll(/driver: new LocalComputerDriver\(/g)].map((m) => m.index ?? 0);
    expect(driverSites.length).toBe(3); // the three documented selection paths
    for (let i = 0; i < driverSites.length; i++) {
      const from = driverSites[i];
      const to = i + 1 < driverSites.length ? driverSites[i + 1] : body.length;
      expect(body.slice(from, to)).toMatch(/prelogin: preloginInputFor\(/);
    }
  });

  it('the computer loop refuses BEFORE capturing a frame or taking the lock', () => {
    const src = SRC(join('backend', 'src', 'modules', 'crossmodel', 'computer-agent', 'computer-loop.ts'));
    const gate = src.indexOf('selection.prelogin?.blockedNow');
    expect(gate).toBeGreaterThan(-1);
    // The refusal must precede the use-lock acquisition — otherwise a locked
    // device would still contend for (and win) the per-device lock.
    expect(gate).toBeLessThan(src.indexOf('acquireComputerUseLock('));
    // c468f922 follow-up: the notice moved to ./prelogin-refusal so its three
    // branches are CALLABLE by a test (see prelogin-refusal.c468f922.test.ts).
    // The marker invariant is unchanged — it just lives one call away now, so
    // assert BOTH halves: the loop builds the notice through that module, and
    // the module still emits the marker a lane greps.
    expect(src).toMatch(/preloginRefusalNotice\(\{/);
    const noticeSrc = SRC(join('backend', 'src', 'modules', 'crossmodel', 'computer-agent', 'prelogin-refusal.ts'));
    expect(noticeSrc).toMatch(/COMPUTER USE BLOCKED — prelogin_input: \$\{input\.status\}/);
  });

  it('the tool-result header renders the typed marker', () => {
    const src = SRC(join('backend', 'src', 'modules', 'crossmodel', 'tool-executor.ts'));
    expect(src).toMatch(/prelogin_input: \$\{result\.prelogin\.status\}/);
  });
});