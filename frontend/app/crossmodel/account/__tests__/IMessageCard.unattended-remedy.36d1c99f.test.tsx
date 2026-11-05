/**
 * Ticket 36d1c99f — "confusing still macos app install".
 *
 * WHAT THE OWNER REPORTED (verbatim, untrusted report data):
 *   "now i see two digby agent to drsapg and drop see screen shot…also when i
 *    run tyhe command to unattended enable it says command not found…also
 *    shouldnt it just be a button to click to allow unasttended access login
 *    not a command tp p[aste ion? we want to cater to non technical uisers"
 *
 * THE TWO DEFECTS THIS FILE REPLAYS.
 *
 * 1. `command not found`. The card and the backend reason both printed the BARE
 *    `digby-agent unattended enable`. No Digby install shape puts that name on
 *    `PATH`: the `.pkg` postinstall and the one-line installer write the shim to
 *    `~/Library/Application Support/Digby/bin/digby-agent` and nothing adds that
 *    directory to the user's `PATH`. So the owner copied the remedy the product
 *    printed and the shell answered `command not found` — which reads as "this
 *    feature does not exist", not "you need a PATH edit first". The remedy is
 *    now an absolute, quoted path that works in a stock Terminal with no setup.
 *
 * 2. "shouldn't it just be a button". Applying the preset writes root-owned
 *    login-window state and `/etc/kcpassword`; the paired agent runs as the
 *    logged-in user and its broker vocabulary is permission_* verbs only, so it
 *    genuinely cannot perform the enable. What was missing — and what a
 *    non-technical owner needs — is that they never have to hand-select a shell
 *    string: the card now offers a Copy button next to it.
 *
 * Assertions are source-level + SSR, matching this repo's node-environment
 * vitest idiom for this card (no jsdom, no effects — see
 * IMessageCard.remote-control.c468f922.test.tsx).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  RemoteControlSection,
  unattendedEnableCmd,
  unattendedNeedsSudoPriming,
  MAC_AGENT_CLI_PATH,
} from '../IMessageCard';
import type { IMessageAgentInfo } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * SSR markup escapes `<`, `>`, `&` and `"`, but a browser DECODES them before
 * the owner reads the line — so the user really does see `enable <account>`.
 * Assertions about what the owner reads must therefore run against decoded
 * text; pinning the raw entity would freeze an implementation detail and, worse,
 * would pass while the visible string was something else entirely.
 */
const decodeHtml = (html: string): string =>
  html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const CARD = readSrc('../IMessageCard.tsx');
const BACKEND = readSrc(
  '../../../../../backend/src/modules/crossmodel/imessage/unattended-verdict.ts',
);

const baseAgent = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo => ({
  id: 'agent-1',
  label: 'MacBook Pro',
  online: true,
  ...over,
});

/** A Mac whose preset is measured-off — the state that renders the remedy. */
const offMac = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo =>
  baseAgent({
    platform: 'macos',
    prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
    remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    unattendedReady: { state: 'off', enabled: false, ready: false, reason: 'preset not enabled on this device' },
    ...over,
  });

const render = (over: Partial<IMessageAgentInfo> = {}) =>
  renderToStaticMarkup(createElement(RemoteControlSection, { agent: offMac(over) }));

describe('ticket 36d1c99f — the enable remedy can never be "command not found"', () => {
  it('the rendered macOS command is an ABSOLUTE, quoted path — not a bare name', () => {
    const cmd = unattendedEnableCmd('macos');
    // The exact shim the .pkg postinstall writes
    // (macos-pkg/scripts/postinstall: CLI_DIR="$USER_HOME/Library/Application
    // Support/Digby/bin") and that install.sh writes too.
    expect(cmd).toContain('/Library/Application Support/Digby/bin/digby-agent');
    expect(cmd).toContain('unattended enable');
    // The broken shape, verbatim: a bare command (with or without sudo).
    expect(cmd).not.toMatch(/^(sudo\s+)?digby-agent\s/);
    // The path contains spaces; unquoted it would split into two shell words and
    // fail a SECOND way. Quoting is part of the fix, not cosmetic.
    expect(cmd.startsWith('"')).toBe(true);
    expect(cmd.endsWith('unattended enable')).toBe(true);
  });

  it('renders that absolute command on the card, not the bare form', () => {
    const html = render();
    expect(html).toContain('data-testid="remote-control-unattended-enable-cmd"');
    expect(html).toContain('/Library/Application Support/Digby/bin/digby-agent');
    // The literal string the owner reported failing must not appear anywhere.
    expect(html).not.toMatch(/(^|[">\s])digby-agent unattended enable/);
  });

  it('the Windows path is unchanged — there the bare name DOES resolve', () => {
    // The Windows agent ships an installer that puts digby-win-agent on PATH, so
    // "fix" must not rewrite the one platform where the printed form works.
    const cmd = unattendedEnableCmd('windows');
    expect(cmd).toBe('digby-win-agent unattended enable');
  });

  it('the frontend and backend agree on the shim path (one source of truth)', () => {
    // Drift here is the defect returning on whichever half was not updated.
    expect(MAC_AGENT_CLI_PATH).toContain('/Library/Application Support/Digby/bin/digby-agent');
    expect(BACKEND).toContain('MAC_AGENT_CLI_PATH');
    expect(BACKEND).toContain('/Library/Application Support/Digby/bin/digby-agent');
    // Neither side may reintroduce the bare macOS command as the remedy.
    expect(BACKEND).not.toMatch(/'digby-agent unattended enable'/);
  });
});

describe('ticket 36d1c99f — a Copy button, so nobody hand-selects a shell string', () => {
  it('offers a copy control beside the command', () => {
    const html = render();
    expect(html).toContain('data-testid="remote-control-unattended-copy"');
    expect(html.toLowerCase()).toContain('copy');
  });

  it('copies the FULL absolute command, never a truncated label', () => {
    // The button's handler must receive the same string the code span shows —
    // a copy that yields a different command would be its own defect.
    //
    // TICKET 36d1c99f (guided flow, owner ruling oq_1f11df6b option A): the
    // copied line is now the COMPLETE working sequence, not the bare `enable`.
    // TICKET bcdf5d2f: which sequence depends on the DEVICE's agent version —
    // ≥ 0.9.21 escalates for itself (enable alone, no sudo for the owner to
    // type), older builds keep the one-time `sudo -v` prefix because a bare
    // `enable` refuses on a fresh Terminal. Either way the script must carry the
    // absolute quoted shim path (never the bare name), which is the original pin.
    expect(CARD).toMatch(/copyEnableCmd\(unattendedEnableScript\(agent\.platform,/);
    expect(CARD).toMatch(/\{unattendedEnableScript\(agent\.platform,/);
    // The version must actually be threaded through — a paste that ignores it
    // would print the wrong advice to one of the two agent generations.
    expect(CARD).toMatch(/unattendedEnableScript\(agent\.platform, agent\.agentVersion\)/);
  });

  it('stays a status surface for the CHANNEL — no remote-access enable button', () => {
    // Regression guard on the c468f922 contract: `remote-access enable` drives
    // root tooling the paired agent cannot reach, so it must keep printing a
    // command. Only the unattended remedy gained a copy affordance.
    //
    // TICKET 36d1c99f (review finding): this assertion used to pin the BARE
    // `sudo digby-agent …` — i.e. it froze the very `command not found` defect
    // this ticket exists to fix, on the same card, twelve lines below the fixed
    // one. `sudo` resets `PATH`, so that form failed even for an owner who had
    // added the directory to their `PATH` themselves. It now pins the absolute,
    // sudo-safe form, so a future regression reddens this test instead of
    // passing it.
    const html = render();
    expect(html).toContain('data-testid="remote-control-enable-cmd"');
    // Assert on DECODED text: the browser renders `&lt;account&gt;` as
    // `<account>`, and that decoded form is what the owner copies and runs.
    expect(decodeHtml(html)).toContain('remote-access enable <account>');
    expect(html).toContain('/Library/Application Support/Digby/bin/digby-agent');
    expect(html).not.toMatch(/sudo digby-agent remote-access/);
  });

  it('renders no remedy at all when the preset is already ready', () => {
    const html = render({
      unattendedReady: { state: 'ready', enabled: true, ready: true, reason: '' },
    });
    expect(html).not.toContain('data-testid="remote-control-unattended-enable-cmd"');
    expect(html).not.toContain('data-testid="remote-control-unattended-copy"');
  });
});

describe('ticket 36d1c99f — the owner is told what will happen before they start', () => {
  it('warns about the macOS password prompt, and that it stays on the device', () => {
    // A command that is suddenly followed by a password prompt is where a
    // non-technical owner stops and assumes a phishing page. Naming it in
    // advance — with the two facts that make it acceptable (local only, and
    // reversible) — is the difference between "run this" and "you can do this".
    const html = render();
    expect(html).toContain('data-testid="remote-control-unattended-password-note"');
    expect(html).toContain('never sent to Digby');
    expect(html).toContain('disable');
  });

  // ── TICKET bcdf5d2f: the advice must follow the DEVICE's binary ────────────
  // Agent 0.9.21 obtains admin rights itself (ensureAdminRights → `sudo -v`
  // attached to the terminal). Every build before it gates on `sudo -n`, which
  // never prompts, so on THOSE the owner really must prime sudo. One string for
  // both would be a lie on one side of the fence — and the owner's complaint was
  // precisely that the product's instructions contradicted the binary.
  it('bcdf5d2f: a pre-0.9.21 agent still tells the owner to prime sudo', () => {
    const html = decodeHtml(render({ agentVersion: '0.9.20' }));
    expect(html).toContain('sudo -v');
    expect(html).toContain('predates the automatic prompt');
    // It must not promise an automatic prompt this build cannot produce.
    expect(html).not.toContain('macOS will ask for your Mac password once');
  });

  it('bcdf5d2f: a 0.9.21+ agent drops the priming step entirely', () => {
    const html = decodeHtml(render({ agentVersion: '0.9.21' }));
    // The exact ritual this ticket exists to delete.
    expect(html).not.toContain('sudo -v');
    expect(html).toContain('Password:');
  });

  it('bcdf5d2f: a newer agent keeps the simplified copy (no future regression)', () => {
    for (const v of ['0.9.22', '0.10.0', '1.0.0']) {
      expect(decodeHtml(render({ agentVersion: v }))).not.toContain('sudo -v');
    }
  });

  it('bcdf5d2f: an UNKNOWN version takes the safe branch (priming also works on a new agent)', () => {
    // An absent version is a legacy row that never advertised. Priming is the
    // choice that cannot fail: a primed sudo merely means the new agent has
    // nothing left to prompt for.
    for (const v of [undefined, null, '', 'garbage']) {
      expect(decodeHtml(render({ agentVersion: v as never }))).toContain('sudo -v');
    }
  });

  it('bcdf5d2f: the version gate is pure and pinned to 0.9.21', () => {
    expect(unattendedNeedsSudoPriming('0.9.20')).toBe(true);
    expect(unattendedNeedsSudoPriming('0.9.21')).toBe(false);
    expect(unattendedNeedsSudoPriming('0.9.9')).toBe(true);
    expect(unattendedNeedsSudoPriming('0.8.99')).toBe(true);
    expect(unattendedNeedsSudoPriming('0.10.0')).toBe(false);
    expect(unattendedNeedsSudoPriming('1.0.0')).toBe(false);
    expect(unattendedNeedsSudoPriming(null)).toBe(true);
  });

  it('does not print the macOS note on a Windows device', () => {
    const html = render({ platform: 'windows' });
    expect(html).not.toContain('data-testid="remote-control-unattended-password-note"');
  });

  it('the note carries no credential-shaped content', () => {
    // Criterion from the c468f922 contract, re-checked on the new text: prose
    // ABOUT a password must never drift into a password field or a value.
    const html = render();
    expect(html).not.toMatch(/type="password"|password=|hunter2|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

// DEFERRED, and recorded here rather than as a test: the agent's usage line
// omitted `unattended` and `remote-access`, so someone looking for help inside
// the build that HAS the feature saw a list without it. That edit lives in
// imessage-agent/src/index.ts, and ANY change there is gated by
// agent-release.c468f922.test.ts, which requires the served tarball to be
// republished AND AGENT_VERSION bumped — a fleet-wide self-update wave that a
// cosmetic usage string should not trigger from a UX ticket. It ships with the
// next real agent release.
//
// There is deliberately NO test block here: an assertion that cannot fail
// (`expect(true).toBe(true)`, or reading a file that throws at import if it is
// missing) would stay green forever — including after the deferred fix landed
// and after it silently regressed — so it would record nothing while looking
// like coverage. The deferral is tracked in the PR body and the ticket
// adminNote, where a human actually reads it.