/**
 * Ticket c735df85 — the "not reported" row must not accuse the wrong party.
 *
 * THE REPORTED DEFECT. Owner ticket e530220e's card showed, for every Mac whose
 * remote-channel row was empty:
 *
 *     "The agent on this Mac is too old to report a remote channel — update
 *      it, then re-check here. Nothing is known to be listening."
 *
 * That sentence was printed unconditionally. It was true for
 * `example-tailnet-peer` (v0.9.21) and FALSE for `cql-stanne-mbp-2` (v0.9.22) —
 * the same build that was reporting an honest `off` on the owner's other two
 * Macs. So the card sent him to an update that could not possibly change the
 * row, and hid the one on-device command that would name the real cause
 * (`digby-agent remote-access status`).
 *
 * WHY VERSION RANGES AND NOT A SINGLE FLOOR. Two different releases changed the
 * meaning of silence, and the gap between them is where a wrong remedy gets
 * printed:
 *   • 0.9.12 (imessage-agent/src/config.ts) is the FIRST artifact that ships the
 *     `remote-access` subcommand — below it no diagnostic even exists.
 *   • 0.9.22 is the release where an ABSENT Screen Sharing key reads as a
 *     measured `off` instead of `null`. Below it every stock Mac (Screen
 *     Sharing never configured — the normal case) stayed silent BY DESIGN, so
 *     silence there is expected and the update genuinely fixes it.
 *
 * PINS BELOW. The pure classifier over every range, the rendered sentence per
 * range, and a source-level assertion that the old unconditional wording is
 * gone — because the defect was one hard-coded string, and a future edit could
 * reintroduce it without touching the classifier.
 *
 * Node-environment vitest (no jsdom, no effects) — the same SSR idiom as
 * IMessageCard.remote-control.c468f922.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  RemoteControlSection,
  remoteUnavailableCause,
  REMOTE_ACCESS_MIN_AGENT_VERSION,
  REMOTE_HONEST_OFF_MIN_AGENT_VERSION,
} from '../IMessageCard';
import type { IMessageAgentInfo } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');

const baseAgent = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo => ({
  id: 'agent-1',
  label: 'MacBook Pro',
  online: true,
  ...over,
});

/** A silent remote-channel row — the state under test. */
const renderUnavailable = (over: Partial<IMessageAgentInfo> = {}) =>
  renderToStaticMarkup(
    createElement(RemoteControlSection, {
      agent: baseAgent({
        platform: 'macos',
        prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
        remoteAccess: {
          state: 'unavailable',
          enabled: false,
          tunnelOnly: false,
          ready: false,
          reason: 'unavailable — never reported a remote channel',
        },
        ...over,
      }),
    }),
  );

describe('the two release floors are what the agent source says they are', () => {
  it('0.9.12 shipped the command; 0.9.22 shipped the honest off', () => {
    // Guarding the CONSTANTS, not just their use: an off-by-one here silently
    // reassigns a whole device cohort to the wrong remedy, and both values are
    // claims about imessage-agent/src/config.ts, not preferences.
    expect(REMOTE_ACCESS_MIN_AGENT_VERSION).toBe('0.9.12');
    expect(REMOTE_HONEST_OFF_MIN_AGENT_VERSION).toBe('0.9.22');
  });

  it('the floors are in the documented order — lowering either is a defect', () => {
    // If these ever invert, every Mac falls into one bucket and the split this
    // ticket exists to create is gone. Compare the FULL triples (a bare
    // major*1000+minor compare collapses 0.9.12 and 0.9.22 to the same 9).
    const num = (v: string) => v.split('.').map(Number);
    const [a1, b1, c1] = num(REMOTE_ACCESS_MIN_AGENT_VERSION);
    const [a2, b2, c2] = num(REMOTE_HONEST_OFF_MIN_AGENT_VERSION);
    const older =
      a2 !== a1 ? a2 > a1 : b2 !== b1 ? b2 > b1 : c2 > c1;
    expect(older).toBe(true);
  });
});

describe('remoteUnavailableCause — pure, total, and never guesses', () => {
  it('below 0.9.12 the command does not exist at all (no-command)', () => {
    for (const v of ['0.9.11', '0.9.4', '0.8.2', '0.6.3', '0.7.0']) {
      expect(remoteUnavailableCause(v, 'macos'), v).toBe('no-command');
    }
  });

  it('0.9.12 → 0.9.21 has the command but still goes silent on a stock Mac (pre-honest-off)', () => {
    // The owner's Mac mini: v0.9.21. An update genuinely IS the remedy here —
    // but not because the command is missing; because the honest `off` had not
    // shipped yet. Passing this range is what keeps the Mac mini's remedy.
    for (const v of ['0.9.12', '0.9.13', '0.9.20', '0.9.21']) {
      expect(remoteUnavailableCause(v, 'macos'), v).toBe('pre-honest-off');
    }
  });

  it('0.9.22 and up CAN report, so silence is this device\'s probe (silent-probe)', () => {
    // The owner's cql-stanne-mbp-2: v0.9.22. An update changes nothing; the card
    // must send him to the on-device diagnostic instead.
    for (const v of ['0.9.22', '0.9.23', '0.9.24', '0.10.0', '1.0.0', '2.0.0']) {
      expect(remoteUnavailableCause(v, 'macos'), v).toBe('silent-probe');
    }
  });

  it('a legacy row with no platform is treated as a Mac, not as a PC', () => {
    // Every legacy row is a Mac (the platform column was added 2026-09-25).
    expect(remoteUnavailableCause('0.9.23')).toBe('silent-probe');
    expect(remoteUnavailableCause('0.9.21', null)).toBe('pre-honest-off');
  });

  it('Windows is gated on its OWN floor — not a permanent "never reports it"', () => {
    // docs/UNATTENDED_DEVICES.md §4: the Windows agent is 0.9.1 and the
    // subcommands landed on main AFTER that installer was built — so on the
    // current published PC build "update it" has no destination. But
    // windows-agent/src/index.ts:790 DOES implement `remote-access`, so a
    // blanket "no Windows release reports it" becomes a LIE at the next
    // installer. Hence a version floor, not a platform constant.
    for (const v of ['0.9.0', '0.9.1']) {
      expect(remoteUnavailableCause(v, 'windows'), v).toBe('no-windows-support');
    }
    // At/above the floor the build is assumed capable — send the owner to the
    // on-device diagnostic (honest in both worlds: a truly absent subcommand
    // prints "unknown command", and the card never claimed it exists).
    for (const v of ['0.9.2', '0.9.23', '1.0.0']) {
      expect(remoteUnavailableCause(v, 'windows'), v).toBe('silent-probe');
    }
  });

  it('an unreadable Windows version is `unknown`, not "nothing to update"', () => {
    // The unreadable gate must run FIRST — otherwise a PC with no readable
    // version would be told there is nothing to update, a claim about a build
    // we cannot even identify.
    for (const v of [null, undefined, '', 'garbage']) {
      expect(remoteUnavailableCause(v, 'windows'), String(v)).toBe('unknown');
    }
  });

  it('an unreadable version is `unknown` — it never accuses the device', () => {
    // The house rule (agentVersionOlder / pkgStampIsFresh): never claim a fact
    // about a version we cannot parse. A missing/blank/malformed version must
    // not become "too old" or "broken probe".
    for (const v of [null, undefined, '', '   ', 'v0.9.23', 'latest', 'x.y.z', '0.9.x']) {
      expect(remoteUnavailableCause(v, 'macos'), String(v)).toBe('unknown');
    }
    // A PREFIX-shaped version ('0.9') IS parseable and is older than 0.9.12 —
    // it must land in a real bucket, not fall through to "unknown".
    expect(remoteUnavailableCause('0.9', 'macos')).toBe('no-command');
  });
});

describe('the rendered sentence names the TRUE remedy per range', () => {
  it('0.9.11 tells the owner to update — the command is absent there', () => {
    const html = renderUnavailable({ agentVersion: '0.9.11' });
    expect(html).toContain('predates remote-channel reporting');
    expect(html).toContain('update it');
    // No diagnostic command: it does not exist on this artifact.
    expect(html).not.toContain('remote-access status');
  });

  it('0.9.21 tells the owner to update, and says WHY updating helps', () => {
    const html = renderUnavailable({ agentVersion: '0.9.21' });
    expect(html).toContain('only reports a remote channel once one has been configured');
    expect(html).toContain('v0.9.22');
    // Crucially it must NOT claim an update is pointless — on this build it is
    // the actual fix, and this is the owner's Mac mini.
    expect(html).not.toContain('update will not change it');
  });

  it('0.9.22 stops pointing at an update and prints the on-device command', () => {
    const html = renderUnavailable({ agentVersion: '0.9.22' });
    expect(html).toContain('update will not change it');
    // The one command that names the real cause. Read-only by construction —
    // this surface must never tell an owner to ENABLE a listener as a remedy
    // for silence.
    expect(html).toContain('remote-access status');
    expect(html).not.toContain('remote-access enable');
    // It must not repeat the old accusation on a build that can report.
    expect(html).not.toContain('too old to report a remote channel');
  });

  it('0.9.23 (current) gets the same diagnostic path, not an update nag', () => {
    const html = renderUnavailable({ agentVersion: '0.9.23' });
    expect(html).toContain('remote-access status');
    expect(html).toContain('update will not change it');
  });

  it('a Windows PC on the published build is told plainly that no release reports it', () => {
    const html = renderUnavailable({ platform: 'windows', agentVersion: '0.9.1' });
    expect(html).toContain('No published Windows agent reports a remote channel yet');
    expect(html).toContain('nothing to update into');
    expect(html).not.toContain('remote-access status');
    expect(html).not.toContain('remote-access enable');
  });

  it('a NEWER Windows agent is assumed capable — the on-device diagnostic, not a dead end', () => {
    // The blanket-platform version of this branch would tell a PC running a
    // build that CAN report that there is nothing to update — the same defect
    // class, moved to a new platform.
    const html = renderUnavailable({ platform: 'windows', agentVersion: '0.9.4' });
    expect(html).not.toContain('No published Windows agent reports');
    expect(html).toContain('remote-access status');
    expect(html).toContain('update will not change it');
  });

  it('an unreadable version accuses neither the build nor the device', () => {
    const html = renderUnavailable({ agentVersion: null });
    expect(html).toContain('could not be read');
    expect(html).toContain('reason is unknown');
    expect(html).not.toContain('too old');
    expect(html).not.toContain('remote-access status');
    expect(html).not.toContain('remote-access enable');
  });

  it('NO range ever prints the old unconditional sentence', () => {
    // The defect itself, asserted absent across every cohort in one place.
    for (const v of ['0.6.3', '0.9.11', '0.9.12', '0.9.21', '0.9.22', '0.9.23', null]) {
      const html = renderUnavailable({ agentVersion: v });
      expect(html, String(v)).not.toContain('too old to report a remote channel');
      // Still the honest unknown tail — silence is never upgraded to "off".
      expect(html, String(v)).toContain('Nothing is known to be listening');
    }
  });
});

describe('the hard-coded cause is gone from the source (the defect was one string)', () => {
  it('IMessageCard.tsx no longer RENDERS the old unconditional sentence', () => {
    // A future edit could restore the wording without touching the classifier
    // (which would keep every test above green). Pin the source, not just the
    // render — the same belt-and-braces the unattended card's pins use.
    //
    // Scoped to RENDERED output, not comments: the fix's own documentation and
    // the classifier's docblock both quote the old sentence on purpose (the
    // defect is unreadable without it), so a blanket substring ban would forbid
    // explaining the bug. Strip block/line comments, then assert.
    const codeOnly = CARD
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(codeOnly).not.toContain('too old to report a remote channel');
  });

  it('the unavailable row routes through the version-aware classifier', () => {
    expect(CARD).toMatch(/remoteUnavailableCause\(agent\.agentVersion, agent\.platform\)/);
    // ...and the row keeps its testid, which the sibling ticket test pins.
    expect(CARD).toContain('data-testid="remote-control-update-agent"');
  });

  it('the diagnostic command is the absolute CLI path, sudo-safe (ticket 36d1c99f)', () => {
    // Same lesson as the enable command: a bare `digby-agent` is not on PATH on
    // a stock install and `sudo` resets PATH, so the remedy would fail with
    // `command not found` — the exact defect 36d1c99f fixed elsewhere.
    const html = renderUnavailable({ agentVersion: '0.9.23' });
    expect(html).toContain('Library/Application Support/Digby/bin/digby-agent');
  });
});