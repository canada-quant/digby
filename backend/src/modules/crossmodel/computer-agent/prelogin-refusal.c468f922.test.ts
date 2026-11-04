/**
 * PRE-LOGIN REFUSAL NOTICE — tests (ticket c468f922).
 *
 * WHY THESE EXIST. PR #2129 shipped the typed three-state remote-channel health
 * line but left the pre-login refusal branching on `prelogin.blockedNow` alone,
 * so a locked device WITH a working hardened channel read identically to a
 * locked device with no path at all — one message for two opposite dead ends.
 * Independent review caught it; this file pins the fix.
 *
 * The fix is only worth anything if it is TESTED BY CALLING IT, which is why
 * the notice was extracted into `prelogin-refusal.ts`. A regex over
 * computer-loop.ts would pass on a comment and cannot distinguish the branches.
 */

import {
  preloginChannelLine,
  preloginRefusalNotice,
} from './prelogin-refusal';
import {
  remoteAccessReadyFor,
} from '../imessage/remote-access-verdict';

const BASE = {
  status: 'locked',
  noun: 'Mac',
  preloginReason: 'the device is at the login window',
};

describe('preloginChannelLine — the two dead ends must not read alike', () => {
  it('a WORKING channel says who can use it — and NEVER tells this lane to', () => {
    const line = preloginChannelLine({ state: 'on', ready: true, reason: '' });
    expect(line).toContain('remoteAccess: on');
    expect(line).toContain('IS enabled');
    // Who can use it: an operator, not the run being refused.
    expect(line).toContain('OPERATOR can reach the login window');
    // THE DEFECT THIS TEST NOW GUARDS (shipped by #2139, caught by independent
    // review): the first version read "reach the device through it instead of
    // waiting for a physical unlock" — an instruction a lane CANNOT carry out,
    // because no RFB/VNC/RDP client ships (remote-access-verdict.ts:61,
    // types.ts:218). That is the c468f922 bug class itself: a message that sends
    // a lane down a path that cannot work. Assert the misleading instruction is
    // GONE, not merely that some other phrasing is present.
    expect(line).not.toMatch(/reach the device through it/i);
    expect(line).not.toMatch(/instead of waiting for a physical unlock/i);
    // …and assert the honest limitation is stated instead.
    expect(line).toMatch(/no RFB\/RDP client ships/i);
    expect(line).toContain('do not retry it as a computer_task');
  });

  it.each([
    ['unavailable', 'unavailable — the Digby agent on this device never reported a remote channel'],
    ['blocked', 'the channel is enabled but the device did not advertise the brokered-tunnel binding'],
  ] as const)('state %s is named, and its reason is carried through', (state, reason) => {
    const line = preloginChannelLine({ state, ready: false, reason });
    expect(line).toContain(`remoteAccess: ${state}`);
    expect(line).toContain('No hardened remote channel is available');
    // The reason's own `<state> — ` prefix is stripped, so the token is not
    // rendered twice ("remoteAccess: unavailable — unavailable — …").
    expect(line).not.toContain(`${state} — ${state}`);
  });

  it('`off` is reported as a STATE, never as a fault (it is the healthy default)', () => {
    // The asymmetry that must not be flattened: `off` means nobody opted in, on
    // essentially every device in the fleet. Calling that a fault would nag the
    // owner to open a listener for no reason — the exact bug class #2129 fixed
    // on the health line, which must not be reintroduced in the refusal.
    //
    // The FIRST version of this line (shipped by #2139) read "No hardened remote
    // channel is available EITHER (remoteAccess: off)" — framing the healthy
    // default as a deficiency, which is the enable-nag REMOTE_OFF_REASON exists
    // to prevent. Independent review caught it; assert the framing is gone.
    const line = preloginChannelLine({
      state: 'off',
      ready: false,
      reason: 'off — brokered remote access is not enabled on this device and nothing is listening; that is the default. Turn it on for this device only if you want Digby to be able to reach it while it is locked',
    });
    expect(line).toContain('remoteAccess: off');
    expect(line).toContain('healthy default, not a fault');
    // Not framed as a missing capability…
    expect(line).not.toMatch(/not available/i);
    expect(line).not.toMatch(/available either/i);
    // …and the doubled `off — off —` render is gone.
    expect(line).not.toContain('off — off');
    // A bare word-blacklist cannot express this: the line legitimately SAYS the
    // words "not a fault", so banning /fault/ would fail on the very phrasing
    // that is correct (the first version of this test did exactly that). Assert
    // the positive framing instead, plus the genuinely-wrong vocabularies.
    expect(line).not.toMatch(/\b(broken|misconfigured|failed|failure|error)\b/i);
    expect(line).not.toMatch(/\bis a fault\b/i);
  });

  it('an absent verdict (no device reported one) is UNKNOWN, not a clean bill', () => {
    const line = preloginChannelLine(undefined);
    expect(line).toContain('remoteAccess: unavailable');
    expect(line).toContain('the device never reported one');
  });

  it('an empty reason falls back to the unknown sentence rather than an empty slot', () => {
    const line = preloginChannelLine({ state: 'blocked', ready: false, reason: '' });
    expect(line).toContain('the device never reported one');
    expect(line).not.toMatch(/—\s*\./); // no "— ." hole where the reason was
  });
});

describe('preloginRefusalNotice — the full refusal', () => {
  it('keeps the marker a lane greps, the noun, and both facts', () => {
    const notice = preloginRefusalNotice({
      ...BASE,
      remoteAccess: { state: 'on', ready: true, reason: '' },
    });
    expect(notice).toContain('COMPUTER USE BLOCKED — prelogin_input: locked');
    expect(notice).toContain('No screen was captured and no input was sent to the Mac');
    expect(notice).toContain('the device is at the login window');
    expect(notice).toContain('remoteAccess: on');
    expect(notice).toContain('Do NOT retry this task against the same device');
  });

  it('names the Windows PC when the caller resolved that platform', () => {
    const notice = preloginRefusalNotice({
      ...BASE,
      noun: 'Windows PC',
      status: 'secure_desktop',
      remoteAccess: { state: 'off', ready: false, reason: 'not enabled' },
    });
    expect(notice).toContain('no input was sent to the Windows PC');
    expect(notice).toContain('prelogin_input: secure_desktop');
  });

  it('still refuses when NOTHING was reported — the refusal never depends on the channel', () => {
    // Silence about remote access must not weaken the pre-login refusal: the
    // lock report is the cause, the channel only chooses the follow-up sentence.
    const notice = preloginRefusalNotice({ ...BASE });
    expect(notice).toContain('COMPUTER USE BLOCKED');
    expect(notice).toContain('remoteAccess: unavailable');
    expect(notice).toContain('Do NOT retry this task against the same device');
  });

  it('never invents a credential: it can only echo the reason the verdict gave', () => {
    // The FIRST version of this test was wrong, not the code: it fed a reason
    // that CONTAINED the word "password" and then asserted the notice had none.
    // A reason that DESCRIBES the credential ("stored without -setvnclegacy")
    // is not a leaked credential — it is the diagnostic an operator needs.
    //
    // The real criterion-5 property is about the vocabulary the module can
    // EMIT, not about banning a word. So: (a) the notice passes the reason
    // through verbatim (it composes, it never rewrites or adds), and (b) every
    // reason the REAL verdict function emits — across every reachable state —
    // is credential-free, because the advert carries only closed-vocabulary
    // tokens and the reasons are prose about tokens.
    const reason = 'the VNC password is stored without -setvnclegacy';
    const notice = preloginRefusalNotice({ ...BASE, remoteAccess: { state: 'blocked', ready: false, reason } });
    expect(notice).toContain(reason); // echoed, not mangled

    const SECRET_SHAPED = /(?:[A-Za-z0-9+/]{24,}={0,2})|(?:passw(?:or)?d\s*[:=]\s*\S)/i;
    for (const advert of ['', 'off', 'on', 'on,tunnel', 'on,tunnel,no-firewall', 'on,account-password'] as const) {
      const v = remoteAccessReadyFor({ remoteAccess: advert });
      expect(v.reason).not.toMatch(SECRET_SHAPED);
    }
  });

  it('ends with exactly one full stop — the channel line joins without doubling', () => {
    const notice = preloginRefusalNotice({
      ...BASE,
      remoteAccess: { state: 'off', ready: false, reason: 'not enabled' },
    });
    expect(notice).not.toMatch(/\.\s*\./);
    expect(notice.trimEnd().endsWith('burns the run.')).toBe(true);
  });
});

describe('the verdict contract these branches rely on', () => {
  it('`ready: true` implies state `on` — the proxy preloginChannelLine depends on', () => {
    // remoteAccessVerdict() has exactly ONE `ready: true` return and it is
    // tunnel-bound and blocker-free. If a future branch adds a second green with
    // another state, the refusal would print "IS available" for a state it
    // cannot name — so assert the invariant against the REAL verdict function
    // rather than trusting the comment.
    const on = remoteAccessReadyFor({ remoteAccess: 'on,tunnel' });
    expect(on.ready).toBe(true);
    expect(on.state).toBe('on');
    // …and the neighbours that must NEVER be ready.
    expect(remoteAccessReadyFor({ remoteAccess: 'off' })).toMatchObject({ state: 'off', ready: false });
    expect(remoteAccessReadyFor({ remoteAccess: 'on' })).toMatchObject({ state: 'blocked', ready: false });
    expect(remoteAccessReadyFor({ remoteAccess: undefined })).toMatchObject({ state: 'unavailable', ready: false });
  });
});