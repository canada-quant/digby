/**
 * Ticket 36d1c99f — the GUIDED enable flow (owner ruling oq_1f11df6b, option A).
 *
 * WHAT THE OWNER ASKED FOR, verbatim (untrusted report data):
 *   "shouldnt it just be a button to click to allow unasttended access login
 *    not a command tp [paste] in? we want to cater to non technical uisers"
 *
 * THE RULING (oq_1f11df6b, answered by the owner):
 *   "A — Keep it explicit, make it painless: a guided 2-click flow in the
 *    desktop app that runs the enable with your admin password, shows the
 *    FileVault/password-on-disk tradeoff BEFORE it runs."
 *
 * WHY THIS FILE ASSERTS PURE FUNCTIONS + SOURCE ORDER, NOT CLICKED MARKUP.
 * The owner's requirement is an ORDERING constraint: the consequence must be
 * readable BEFORE the step that causes it. This card's test idiom is
 * node-environment SSR (no jsdom, no effects — see
 * IMessageCard.remote-control.c468f922.test.tsx), which cannot click, so the
 * panel's opened state is not renderable here. Ordering is therefore pinned two
 * ways that DO work: (a) the disclosure list is produced by a pure function, so
 * its content and order are directly assertable; (b) the JSX source order —
 * tradeoffs list before the confirm button — is asserted from the source text,
 * the same technique this repo already uses to pin main.swift from a TS test.
 *
 * THE FABRICATION THIS FILE GUARDS (found while building it). While the preset
 * is OFF the agent SUPPRESSES the preset blockers on purpose and advertises a
 * bare `off` (imessage-agent/src/unattended.ts `unattendedAdvertValue`). The
 * guided flow runs in exactly that state. So an absent `filevault` token there
 * means "not reported", NOT "FileVault is off" — and a security disclosure that
 * claims FileVault is off on a Mac where it might be on is worse than one that
 * says it does not know.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  RemoteControlSection,
  unattendedTradeoffs,
  unattendedEnableScript,
  unattendedEnableCmd,
  unattendedNeedsSudoPriming,
  MAC_AGENT_CLI_PATH,
} from '../IMessageCard';
import type { IMessageAgentInfo } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD_SRC = readSrc('../IMessageCard.tsx');

const baseAgent = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo =>
  ({
    id: 'a1',
    label: 'Pauls-MBP',
    platform: 'darwin',
    online: true,
    // RemoteControlSection renders a "legacy backend" placeholder when BOTH of
    // these are absent (`if (!pre && !remote)`), so the fixtures must carry
    // them or every guide assertion is made against the wrong tree.
    prelogin: { status: 'unavailable', blockedNow: false, reason: 'no privileged helper in this build' },
    remoteAccess: {
      state: 'off',
      enabled: false,
      tunnelOnly: true,
      ready: false,
      reason: 'off (healthy default)',
    },
    ...over,
  }) as IMessageAgentInfo;

/** The `off` device — the state the guided flow actually runs in. */
const offAgent = (blockers?: string[]): IMessageAgentInfo =>
  baseAgent({
    unattendedReady: {
      state: 'off',
      enabled: false,
      ready: false,
      reason: 'preset not enabled on this device',
      ...(blockers ? { blockers } : {}),
    },
  });

describe('36d1c99f option A — the tradeoff is disclosed, in order, before the action', () => {
  it('returns the FileVault consequence FIRST — it is the one that can refuse the enable', () => {
    const t = unattendedTradeoffs(offAgent());
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t[0].key).toBe('filevault');
  });

  it('names the password-on-disk consequence, and that it never leaves the Mac', () => {
    const kc = unattendedTradeoffs(offAgent()).find((x) => x.key === 'kcpassword')!;
    expect(kc).toBeDefined();
    expect(kc.title).toMatch(/password/i);
    expect(kc.body).toContain('/etc/kcpassword');
    // The reassuring half is load-bearing: this is the line that separates a
    // legitimate admin flow from a phishing dialog in the owner's mind.
    expect(kc.body).toMatch(/never leaves/i);
    // The reassurance must be STATED, not merely implied.
    expect(kc.body).toContain('not sent to Digby');
  });

  it('says it is reversible — `disable` restores every setting', () => {
    const undo = unattendedTradeoffs(offAgent()).find((x) => x.key === 'undo')!;
    expect(undo.body).toContain('disable');
  });

  it('DOES NOT claim FileVault is off — it says to check (the off-state trap)', () => {
    // `state:'off'` advertises no preset blockers. Absence must read as
    // UNKNOWN — asserting "off" here would fabricate a security fact.
    const fv = unattendedTradeoffs(offAgent()).find((x) => x.key === 'filevault')!;
    expect(fv.title).not.toMatch(/is off on this Mac/i);
    expect(fv.title).toMatch(/check it first/i);
    expect(fv.blocks).toBe(false);
  });

  it('an OLDER backend (no blockers field at all) gets the same honest copy', () => {
    const fv = unattendedTradeoffs(offAgent(undefined)).find((x) => x.key === 'filevault')!;
    expect(fv.title).toMatch(/check it first/i);
  });

  it('the FileVault line is IDENTICAL across every verdict state — one honest copy', () => {
    // Deliberately a single string. An earlier revision branched on
    // `blockers.includes('filevault')` and on `state === 'blocked'` to assert
    // "FileVault is ON" / "FileVault is off on this Mac". The reviewer proved
    // both unreachable (the guide only mounts for `state:'off'`, where the
    // backend hardcodes `blockers: []`) and that the "off" one inferred a
    // security fact from an ABSENT token — while `parseFdesetupStatus` returns
    // null on unreadable output, so absent means NOT MEASURED. Those branches
    // are deleted; this test fails if anyone revives them.
    const states: Array<IMessageAgentInfo['unattendedReady']> = [
      { state: 'off', enabled: false, ready: false, reason: '', blockers: [] },
      { state: 'blocked', enabled: true, ready: false, reason: 'FileVault is on', blockers: ['filevault'] },
      { state: 'blocked', enabled: true, ready: false, reason: 'sleeps', blockers: ['sleep'] },
      { state: 'ready', enabled: true, ready: true, reason: '', blockers: [] },
      { state: 'unavailable', enabled: false, ready: false, reason: '', blockers: [] },
    ];
    const titles = states.map(
      (v) => unattendedTradeoffs(baseAgent({ unattendedReady: v })).find((x) => x.key === 'filevault')!.title,
    );
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toMatch(/check it first/i);
    // And it must stay non-blocking: blocking is what replaced the confirm
    // button, and there is no reachable state that could justify it here.
    expect(
      unattendedTradeoffs(baseAgent({ unattendedReady: states[1] })).find((x) => x.key === 'filevault')!.blocks,
    ).toBe(false);
  });

  it('it scopes the FileVault requirement to auto-login, not to remote control', () => {
    // Ticket 539a99c3 reports the confusion this prevents: FileVault does not
    // block remote control (Screen Sharing authenticates AT the login window);
    // only unattended AUTO-LOGIN needs it off.
    const fv = unattendedTradeoffs(offAgent()).find((x) => x.key === 'filevault')!;
    expect(fv.body).toMatch(/only unattended auto-login does/i);
  });
});

describe('36d1c99f option A — click 2 hands over a sequence that WORKS', () => {
  it('a CURRENT agent (>= 0.9.21) gets the enable ALONE — no sudo for the user to type', () => {
    // TICKET bcdf5d2f, the owner's words: "normal users wouldnt know to run
    // sudo prefix to command". Agent 0.9.21's `ensureAdminRights` runs `sudo -v`
    // attached to the terminal itself, so the owner only answers the macOS
    // Password: prompt. Printing a `sudo` command to them is the defect.
    const script = unattendedEnableScript('darwin', '0.9.21');
    expect(script).toBe(unattendedEnableCmd('darwin'));
    expect(script).not.toContain('sudo');
  });

  it('a NEWER agent keeps the no-sudo paste (the fix must not regress forward)', () => {
    for (const v of ['0.9.22', '0.10.0', '1.0.0']) {
      expect(unattendedEnableScript('darwin', v)).not.toContain('sudo');
    }
  });

  it('an OLDER agent still gets `sudo -v` primed FIRST, then the absolute enable', () => {
    // Those builds gate on a bare `sudo -n`, which NEVER prompts, so the enable
    // alone refuses on a fresh Terminal and "looks like nothing happened".
    for (const v of ['0.9.20', '0.9.19', '0.8.7']) {
      const script = unattendedEnableScript('darwin', v);
      expect(script).toBe(`sudo -v && ${unattendedEnableCmd('darwin')}`);
      expect(script.indexOf('sudo -v')).toBeLessThan(script.indexOf('unattended enable'));
    }
  });

  it('an UNKNOWN/unreadable version primes — the branch that is safe on BOTH agents', () => {
    // A legacy row that never advertised, or a hand-edited payload, cannot be
    // assumed to carry the fix; a primed sudo simply means no second prompt.
    for (const v of [undefined, null, '', 'unknown', 'v0.9.21', '0.9.x']) {
      expect(unattendedNeedsSudoPriming(v)).toBe(true);
      expect(unattendedEnableScript('darwin', v)).toContain('sudo -v &&');
    }
  });

  it('Windows never gets a POSIX sudo prefix, on any version', () => {
    for (const v of [undefined, '0.9.20', '0.9.21']) {
      expect(unattendedEnableScript('windows', v)).toBe(unattendedEnableCmd('windows'));
      expect(unattendedEnableScript('windows', v)).not.toContain('sudo');
    }
  });

  it('the enable half is the absolute, quoted shim path — never the bare name', () => {
    const script = unattendedEnableScript('darwin', '0.9.21');
    expect(script).toContain(`"${MAC_AGENT_CLI_PATH}"`);
    expect(script).not.toMatch(/&&\s*digby-agent\s/);
  });

  it('the legacy two steps are joined with && so a cancelled prompt cannot fall through', () => {
    expect(unattendedEnableScript('darwin', '0.9.20')).toContain('&&');
  });
});

describe('36d1c99f option A — the panel is step 1 and cannot skip the disclosure', () => {
  it('the card offers a first click that opens the guide (not the enable itself)', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlSection, { agent: offAgent() }));
    expect(html).toContain('data-testid="remote-control-unattended-guide"');
    expect(html).toContain('data-testid="remote-control-unattended-guide-open"');
    // Collapsed by default: the panel's confirm does NOT exist until opened.
    expect(html).not.toContain('data-testid="remote-control-unattended-guide-panel"');
    expect(html).not.toContain('data-testid="remote-control-unattended-guide-confirm"');
  });

  it('the copyable command row STILL renders — a plain browser has no privileged path', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlSection, { agent: offAgent() }));
    expect(html).toContain('data-testid="remote-control-unattended-enable-cmd"');
    expect(html).toContain('data-testid="remote-control-unattended-copy"');
  });

  it('SOURCE ORDER: the tradeoff list renders before the confirm button', () => {
    // The owner's requirement is ordering. Assert the JSX source so a future
    // reorder of two blocks fails here instead of shipping a warning under
    // the button it was supposed to precede.
    const guide = CARD_SRC.slice(CARD_SRC.indexOf('remote-control-unattended-guide-panel'));
    const tradeoffsAt = guide.indexOf('remote-control-unattended-tradeoffs');
    const confirmAt = guide.indexOf('remote-control-unattended-guide-confirm');
    expect(tradeoffsAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(tradeoffsAt).toBeLessThan(confirmAt);
  });

  it('SOURCE: a blocking tradeoff replaces the confirm button (no clickable dead end)', () => {
    // FileVault ON means applyMacPreset REFUSES. An enabled confirm there would
    // reproduce this ticket one layer down.
    expect(CARD_SRC).toContain('remote-control-unattended-guide-blocked');
    expect(CARD_SRC).toMatch(/blockingTradeoff \?/);
  });

  it('the guide is macOS-only — Windows is never offered a flow it cannot run', () => {
    const html = renderToStaticMarkup(
      createElement(RemoteControlSection, { agent: offAgent() }),
    );
    expect(html).toContain('data-testid="remote-control-unattended-guide"');

    const win = offAgent();
    (win as any).platform = 'windows';
    const winHtml = renderToStaticMarkup(createElement(RemoteControlSection, { agent: win }));
    expect(winHtml).not.toContain('data-testid="remote-control-unattended-guide"');
  });

  it('the disclosure never promises a silent FileVault change', () => {
    const all = unattendedTradeoffs(offAgent()).map((t) => `${t.title} ${t.body}`).join(' ');
    // Only the NEGATED form is allowed: "Digby never turns FileVault off for
    // you" is the reassurance we want. What must never appear is a promise to
    // do it silently, so assert on the affirmative shape and on the absence of
    // any "we will handle FileVault" phrasing.
    expect(all).toMatch(/never turns FileVault off for you/i);
    expect(all).not.toMatch(/\b(we|digby)('ll| will) (turn|disable|switch off) FileVault/i);
    expect(all).not.toMatch(/FileVault (will be|is) (turned|disabled|switched) off automatically/i);
  });
});

/**
 * Ticket 36d1c99f — the FIRST thing the owner reported was the duplicate:
 *   "now i see two digby agent to drsapg and drop see screen shot…"
 *
 * Two rows on one Mac is normally two INSTALL SHAPES reporting separately (the
 * app-bundled helper, an old .pkg, and the self-managed agent all name a
 * different binary), so the fix is not to hide a row — it is to explain it and
 * point at the per-device Disconnect that already exists. Pinned at source level
 * because that hint lives in the stateful IMessageCard, which this node-env
 * idiom cannot render (no jsdom).
 */
describe('36d1c99f — the duplicate-device confusion is explained in the UI', () => {
  it('renders a hint explaining two rows, and only when more than one is paired', () => {
    expect(CARD_SRC).toContain('remote-control-duplicate-hint');
    // Gated on >1: a single-device owner must never see a duplicate explainer.
    const hintAt = CARD_SRC.indexOf('remote-control-duplicate-hint');
    const gateAt = CARD_SRC.lastIndexOf('agents.length > 1', hintAt);
    expect(gateAt).toBeGreaterThan(-1);
  });

  it('the hint names the Disconnect affordance rather than leaving the owner stuck', () => {
    const start = CARD_SRC.indexOf('remote-control-duplicate-hint');
    const hint = CARD_SRC.slice(start, start + 700);
    expect(hint).toMatch(/Disconnect/i);
    // It must say the removal is scoped to this list — never imply it wipes the
    // app or the other Mac.
    expect(hint).toMatch(/this list only/i);
  });

  it('the docs carry the duplicate-install map with a no-terminal route', () => {
    const docs = readFileSync(
      fileURLToPath(new URL('../../../../../docs/UNATTENDED_DEVICES.md', import.meta.url)),
      'utf8',
    );
    const start = docs.indexOf('"I see TWO Digby agents"');
    expect(start).toBeGreaterThan(-1);
    const section = docs.slice(start, start + 2500);
    expect(section).toContain('/Library/Digby');
    expect(section).toMatch(/Without a terminal/i);
    expect(section).toMatch(/Disconnect/);
  });
});