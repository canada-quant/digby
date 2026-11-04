/**
 * BROKERED SESSION — pins the per-session auth contract for ticket c468f922
 * (owner ruling 2026-10-29 on card oq_b5118c38: "can we do option three but a
 * little more secure like how it's just like TeamViewer").
 *
 * WHY THIS TEST EXISTS. Before this module, the shipped hardening contract
 * DECLARED a session-window requirement and a `stale` blocker token, and
 * NOTHING ever produced it:
 *   - `REMOTE_HARDEN_REQUIREMENTS` carries `session-window`;
 *   - `REMOTE_BLOCKER_PRIORITY` carries `stale`;
 *   - both agents list `stale` in their blocker union;
 *   - and no code anywhere could emit it.
 * A rule with no producer is prose. These tests are what make the token real,
 * and they pin the ONE distinction that keeps it trustworthy: `stale` is for a
 * session that WAS live and outlived its window, never for a grant that merely
 * expired unused (that would be a false alarm, and a token that cries wolf is
 * a token lanes learn to ignore).
 *
 * ALSO PINNED: no credential can ride these shapes (criterion 5), and the
 * window can never be extended by use.
 */

import {
  BROKERED_SESSION_DEFAULT_SEC,
  BROKERED_SESSION_HARD_MAX_SEC,
  applyBrokeredSessionWindow,
  brokeredSessionBlocker,
  brokeredSessionState,
  closeBrokeredSession,
  consumeBrokeredSession,
  issueBrokeredSession,
  reasonForBrokeredRefusal,
  type BrokeredSessionGrant,
} from './brokered-session';
import {
  REMOTE_BLOCKER_PRIORITY,
  normalizeRemoteAccess,
  remoteAccessVerdict,
  type RemoteAccessAdvert,
} from './remote-access-verdict';

const T0 = 1_700_000_000_000;
const READY = { ready: true } as const;
const NOT_READY = { ready: false } as const;

/** A grant that was issued and never used. */
function unused(overrides: Partial<BrokeredSessionGrant> = {}): BrokeredSessionGrant {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    channel: 'macos-screen-sharing',
    issuedAt: T0,
    expiresAt: T0 + 600_000,
    ...overrides,
  };
}

/** A grant that was used at T0 (live unless its window passed). */
function live(overrides: Partial<BrokeredSessionGrant> = {}): BrokeredSessionGrant {
  return unused({ consumedAt: T0 + 1_000, ...overrides });
}

describe('the declared requirement now has a producer', () => {
  it('session-window is a declared hardening requirement AND this module exists to satisfy it', () => {
    const declared = REMOTE_BLOCKER_PRIORITY.find((b) => b.token === 'stale');
    expect(declared).toBeDefined();
    // The exact token this module emits is the declared one — ONE spelling in
    // the tree, so a fleet grepping `stale` finds the producer.
    expect(brokeredSessionBlocker(live(), T0 + 900_000)).toBe('stale');
    expect(declared!.token).toBe('stale');
  });
});

describe('issueBrokeredSession — the harden gate comes first', () => {
  const req = { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' as const };

  it('refuses to mint a session on a channel that is not ready', () => {
    const out = issueBrokeredSession(req, NOT_READY, T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('not-ready');
  });

  it('refuses when no verdict is supplied at all (unknown is never ready)', () => {
    const out = issueBrokeredSession(req, null, T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('not-ready');
  });

  it('reports the CHANNEL problem before a window problem, so a caller cannot fix the wrong one', () => {
    // Both wrong at once: a lane told "window too long" would shorten it and
    // still mint onto an unsafe channel. Channel first is deliberate.
    const out = issueBrokeredSession({ ...req, windowSec: 99_999 }, NOT_READY, T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('not-ready');
  });

  it('mints a ready grant with the default window when none is requested', () => {
    const out = issueBrokeredSession(req, READY, T0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.expiresInSec).toBe(BROKERED_SESSION_DEFAULT_SEC);
    expect(out.grant.expiresAt).toBe(T0 + BROKERED_SESSION_DEFAULT_SEC * 1000);
    expect(out.grant.consumedAt).toBeUndefined();
    expect(out.grant.closedAt).toBeUndefined();
  });

  it('enforces the hard ceiling — "pass a big number" cannot make an unbounded window', () => {
    const tooLong = issueBrokeredSession(
      { ...req, windowSec: BROKERED_SESSION_HARD_MAX_SEC + 1 },
      READY,
      T0,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.refusal).toBe('window-too-long');

    const atCeiling = issueBrokeredSession(
      { ...req, windowSec: BROKERED_SESSION_HARD_MAX_SEC },
      READY,
      T0,
    );
    expect(atCeiling.ok).toBe(true);
  });

  it('refuses a non-positive window (an already-dead grant is not a grant)', () => {
    for (const windowSec of [0, -1]) {
      const out = issueBrokeredSession({ ...req, windowSec }, READY, T0);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.refusal).toBe('window-not-positive');
    }
  });

  it('refuses malformed requests', () => {
    for (const bad of [
      null,
      undefined,
      { ...req, sessionId: '' },
      { ...req, agentId: '   ' },
      { ...req, channel: '' as never },
      { ...req, windowSec: Number.NaN },
    ]) {
      const out = issueBrokeredSession(bad as never, READY, T0);
      expect(out.ok).toBe(false);
    }
  });
});

describe('consumeBrokeredSession — single-use, device-bound, time-boxed', () => {
  const claim = { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' as const };

  it('consumes once and stamps consumedAt', () => {
    const out = consumeBrokeredSession(unused(), claim, T0 + 5_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.grant.consumedAt).toBe(T0 + 5_000);
  });

  it('refuses a REPLAY — a captured authorization cannot open a second session', () => {
    const first = consumeBrokeredSession(unused(), claim, T0 + 5_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = consumeBrokeredSession(first.grant, claim, T0 + 6_000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal).toBe('already-consumed');
  });

  it('refuses a CLOSED session as a replay rather than reviving it', () => {
    const closed = closeBrokeredSession(live(), T0 + 9_000)!;
    const out = consumeBrokeredSession(closed, claim, T0 + 10_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('already-consumed');
  });

  it('refuses the WRONG DEVICE, and checks identity before validity', () => {
    const out = consumeBrokeredSession(unused(), { ...claim, agentId: 'agent-2' }, T0 + 1_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('wrong-device');
    // Identity first: an EXPIRED grant presented by the wrong device still
    // reports wrong-device, so a leaked grant learns nothing about its window.
    const expiredWrong = consumeBrokeredSession(unused(), { ...claim, agentId: 'agent-2' }, T0 + 900_000);
    expect(expiredWrong.ok).toBe(false);
    if (!expiredWrong.ok) expect(expiredWrong.refusal).toBe('wrong-device');
  });

  it('refuses a grant presented on the OTHER channel (macOS grant to a Windows agent)', () => {
    const out = consumeBrokeredSession(unused(), { ...claim, channel: 'windows-rdp' }, T0 + 1_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('wrong-device');
  });

  it('refuses an EXPIRED grant and says nothing is left authenticated', () => {
    const out = consumeBrokeredSession(unused(), claim, T0 + 700_000);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('expired');
      expect(out.reason).toMatch(/never opened a session/);
    }
  });

  it('NEVER extends the window on use — a self-renewing grant is a backdoor in costume', () => {
    const out = consumeBrokeredSession(unused(), claim, T0 + 500_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.grant.expiresAt).toBe(unused().expiresAt);
  });
});

describe('brokeredSessionState — stale is NOT merely expired', () => {
  it('none for no grant (honest unknown, never stale)', () => {
    expect(brokeredSessionState(null, T0)).toBe('none');
    expect(brokeredSessionState(undefined, T0)).toBe('none');
  });

  it('issued → open → closed as a session lives', () => {
    expect(brokeredSessionState(unused(), T0 + 1)).toBe('issued');
    expect(brokeredSessionState(live(), T0 + 60_000)).toBe('open');
    expect(brokeredSessionState(closeBrokeredSession(live(), T0 + 60_000)!, T0 + 61_000)).toBe('closed');
  });

  it('a grant that expired UNUSED is `expired`, NOT `stale` — no false alarm', () => {
    expect(brokeredSessionState(unused(), T0 + 900_000)).toBe('expired');
    expect(brokeredSessionBlocker(unused(), T0 + 900_000)).toBeNull();
  });

  it('a session that WAS live and outlived its window is `stale` — the real finding', () => {
    expect(brokeredSessionState(live(), T0 + 900_000)).toBe('stale');
    expect(brokeredSessionBlocker(live(), T0 + 900_000)).toBe('stale');
  });

  it('a cleanly closed session is never stale, even long after its window', () => {
    const closed = closeBrokeredSession(live(), T0 + 60_000)!;
    expect(brokeredSessionState(closed, T0 + 9_000_000)).toBe('closed');
    expect(brokeredSessionBlocker(closed, T0 + 9_000_000)).toBeNull();
  });

  it('closing is idempotent — the first close wins', () => {
    const once = closeBrokeredSession(live(), T0 + 60_000)!;
    const twice = closeBrokeredSession(once, T0 + 90_000)!;
    expect(twice.closedAt).toBe(once.closedAt);
  });
});

describe('applyBrokeredSessionWindow — additive only, can only make a verdict STRICTER', () => {
  const enabledAdvert: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: [] };

  it('adds stale to an enabled channel whose session overran', () => {
    const out = applyBrokeredSessionWindow(enabledAdvert, live(), T0 + 900_000)!;
    expect(out.blockers).toContain('stale');
  });

  it('leaves the advert UNCHANGED when nothing qualifies (absent-never-clobbers)', () => {
    expect(applyBrokeredSessionWindow(enabledAdvert, null, T0)).toBe(enabledAdvert);
    expect(applyBrokeredSessionWindow(enabledAdvert, unused(), T0 + 900_000)).toBe(enabledAdvert);
    expect(applyBrokeredSessionWindow(enabledAdvert, live(), T0 + 1_000)).toBe(enabledAdvert);
  });

  it('never attaches stale to a channel that is OFF — nothing was authenticated there', () => {
    const off: RemoteAccessAdvert = { enabled: false, tunnelOnly: false, blockers: [] };
    expect(applyBrokeredSessionWindow(off, live(), T0 + 900_000)).toBe(off);
  });

  it('never REMOVES an existing blocker or clears `off`', () => {
    const blocked: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: ['exposed'] };
    const out = applyBrokeredSessionWindow(blocked, live(), T0 + 900_000)!;
    expect(out.blockers).toContain('exposed');
    expect(out.blockers).toContain('stale');
    expect(out.off).toBeUndefined();
  });

  it('re-emits blockers in PRIORITY order so the stored JSONB is stable', () => {
    const out = applyBrokeredSessionWindow(enabledAdvert, live(), T0 + 900_000)!;
    const order = REMOTE_BLOCKER_PRIORITY.map((b) => b.token);
    const idx = out.blockers.map((t) => order.indexOf(t));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('does not duplicate a stale the agent already reported', () => {
    const already: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: ['stale'] };
    expect(applyBrokeredSessionWindow(already, live(), T0 + 900_000)).toBe(already);
  });

  it('the folded advert actually flips the verdict to blocked, and the reason is the stale one', () => {
    const before = remoteAccessVerdict(enabledAdvert);
    expect(before.ready).toBe(true);
    const folded = applyBrokeredSessionWindow(enabledAdvert, live(), T0 + 900_000)!;
    const after = remoteAccessVerdict(folded);
    expect(after.ready).toBe(false);
    expect(after.state).toBe('blocked');
    expect(after.reason).toBe(REMOTE_BLOCKER_PRIORITY.find((b) => b.token === 'stale')!.reason);
  });
});

describe('criterion 5 — no credential can ride these shapes', () => {
  it('a grant carries no field a secret could occupy', () => {
    const out = issueBrokeredSession(
      { sessionId: 's', agentId: 'a', channel: 'macos-screen-sharing' },
      READY,
      T0,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.grant).sort()).toEqual([
      'agentId', 'channel', 'expiresAt', 'issuedAt', 'sessionId',
    ]);
    // A credential passed in by accident has nowhere to go: issue takes a
    // closed request shape and returns a closed grant shape.
    const smuggled = issueBrokeredSession(
      { sessionId: 's', agentId: 'a', channel: 'macos-screen-sharing', password: 'hunter2' } as never,
      READY,
      T0,
    );
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) return;
    expect(JSON.stringify(smuggled.grant)).not.toContain('hunter2');
    expect(JSON.stringify(smuggled.grant)).not.toMatch(/password|secret|vnc|token/i);
  });

  it('every refusal reason is non-empty and none asks for a credential', () => {
    for (const code of [
      'not-ready', 'window-too-long', 'window-not-positive', 'wrong-device',
      'already-consumed', 'expired', 'malformed',
    ] as const) {
      const reason = reasonForBrokeredRefusal(code);
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toMatch(/enter (your )?password|provide a password|paste .*credential/i);
    }
  });

  it('the folded advert still round-trips through normalizeRemoteAccess (no new wire vocabulary)', () => {
    // The blocker token is a DECLARED one, so the existing normalizer already
    // understands it — this module introduces no wire-format change at all.
    const advert: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: [] };
    const folded = applyBrokeredSessionWindow(advert, live(), T0 + 900_000)!;
    const round = normalizeRemoteAccess(['on', 'tunnel', ...folded.blockers]);
    expect(round).toBeDefined();
    expect(round!.blockers).toContain('stale');
  });
});