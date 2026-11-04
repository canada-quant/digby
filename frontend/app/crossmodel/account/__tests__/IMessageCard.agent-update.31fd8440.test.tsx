/**
 * Ticket 31fd8440 — "Desktop app re-download still serves older agent
 * version" (owner report, paired Mac mbp-2, 2026-10-09). Frontend pins.
 *
 * Root cause: the served Digby.dmg (0.1.10, published 2026-09-26) bundles Mac
 * agent 0.6.3 while the current release is 0.8.1; re-downloading the app
 * CANNOT update the agent (the .app bundles its own copy), and nothing
 * anywhere said which agent a re-download installs — the owner re-downloaded
 * and still had an old agent, with no way to tell "which build do I have"
 * from "which is latest". The DMG itself can only be rebuilt on the owner's
 * signing Mac (owner-gated), so the code-side fix is the ticket's second
 * acceptance clause: a CLEAR VERSION INDICATOR + a served path to the current
 * release (the one-line installer, which pulls the CURRENT tarball from
 * digby.example.com). The web UI is served LIVE inside the existing desktop app
 * (WKWebView), so these surfaces reach the owner's installed app immediately.
 *
 * Two idioms per the repo's node-environment vitest constraints (no jsdom, no
 * effects — see IMessageCard.permissions.2f646c10.test.tsx):
 *   1. SSR render of the PURE AgentUpdateHint (MacPermissionsSection idiom)
 *      for every display state;
 *   2. SOURCE-LEVEL pins on IMessageCard.tsx / IntegrationsTab.tsx /
 *      install-digby-agent.sh / desktop-latest.json for the effectful wiring
 *      (the update one-liner, the download line, the feed stamp).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { AgentUpdateHint, agentVersionOlder } from '../IMessageCard';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');
const SETUP_LIB = readSrc('../../../../lib/instance-setup.ts');
const TAB = readSrc('../IntegrationsTab.tsx');
const INSTALLER = readSrc('../../../../public/install-digby-agent.sh');
const FEED = JSON.parse(readSrc('../../../../public/desktop-latest.json')) as {
  version: string;
  url: string;
  agentVersion?: string;
  notes: string;
};

const UPDATE_CMD = 'curl -fsSL https://digby.example.com/install-digby-agent.sh | bash -s -- --update-only';

// The agent the CURRENT tree bundles into a freshly built DMG — build-app.sh
// stamps desktop-latest.json's agentVersion from this exact file at build
// time (and its staleness guard refuses a tree whose agent ≠ the release
// manifest), so once the feed moves past 0.1.10 the stamp MUST equal it.
const AGENT_PKG = JSON.parse(readSrc('../../../../../imessage-agent/package.json')) as {
  version: string;
};

/** Dotted numeric compare ('0.1.9' < '0.1.10'), like the shell's isNewer. */
function atLeast(ver: string, floor: string): boolean {
  const a = ver.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const renderHint = (over: Partial<Parameters<typeof AgentUpdateHint>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AgentUpdateHint, {
      agentVersion: '0.6.3',
      latest: '0.8.1',
      platform: 'macos',
      updateCmd: UPDATE_CMD,
      ...over,
    }),
  );

describe('agentVersionOlder — the compare (never a false "outdated")', () => {
  it('strictly-older → true', () => {
    expect(agentVersionOlder('0.6.3', '0.8.1')).toBe(true);
    expect(agentVersionOlder('0.8.0', '0.8.1')).toBe(true);
    expect(agentVersionOlder('0.9', '0.10.0')).toBe(true);
  });
  it('same or newer → false (no noise for up-to-date Macs)', () => {
    expect(agentVersionOlder('0.8.1', '0.8.1')).toBe(false);
    expect(agentVersionOlder('0.9.0', '0.8.1')).toBe(false);
  });
  it('unreadable/missing either side → false (never claim outdated)', () => {
    expect(agentVersionOlder(null, '0.8.1')).toBe(false);
    expect(agentVersionOlder('0.6.3', null)).toBe(false);
    expect(agentVersionOlder('', '0.8.1')).toBe(false);
    expect(agentVersionOlder('unknown', '0.8.1')).toBe(false);
    expect(agentVersionOlder('0.6.3', 'unknown')).toBe(false);
  });
});

describe('AgentUpdateHint — display states (SSR)', () => {
  it('a stale Mac agent renders the amber hint: which build, which is latest, and the one-liner', () => {
    const html = renderHint();
    expect(html).toContain('data-testid="agent-update-hint"');
    // The version indicator — the ticket's acceptance clause: "which build
    // they have and which is latest", named out loud.
    expect(html).toContain('v0.6.3');
    expect(html).toContain('v0.8.1');
    expect(html).toContain('Mac agent update available');
    // 933e6ca4: the copy must say WHICH component updates (the agent) and
    // that the desktop app is NOT involved — the app/agent duality was the
    // owner's confusion. The one-liner updates the agent only.
    expect(html).toContain('This updates the background');
    expect(html).toContain('not the Digby desktop app');
    // The TCC-invalidation warning (933e6ca4 c): replacing the helper binary
    // orphans its grants — the hint must say so BEFORE the owner runs it.
    expect(html).toMatch(/grants are\s+.*tied to the old helper binary/);
    // The update command itself, copyable.
    expect(html).toContain(UPDATE_CMD);
    expect(html).toContain('Copy the update command');
    // Where it installs + that pairing is kept.
    expect(html).toContain('~/Library/Application Support/Digby');
    expect(html).toContain('Your pairing is kept');
  });

  it('an up-to-date Mac agent renders NOTHING', () => {
    expect(renderHint({ agentVersion: '0.8.1' })).toBe('');
  });

  it('a Windows agent renders NOTHING (a Windows agent updates via its own installer)', () => {
    expect(renderHint({ platform: 'windows' })).toBe('');
  });

  it('an unreadable version renders NOTHING (never a false "outdated")', () => {
    expect(renderHint({ latest: null })).toBe('');
    expect(renderHint({ agentVersion: null })).toBe('');
  });
});

describe('IMessageCard — wiring pins (source level)', () => {
  it('the device block renders the hint from the STATUS the card already fetches', () => {
    // The hint is driven by /status's additive latestAgentVersion (the backend
    // manifest) — the card already fetches status; no second feed call.
    expect(CARD).toContain('<AgentUpdateHint');
    expect(CARD).toContain('latest={status?.latestAgentVersion}');
    expect(CARD).toContain('agentVersion={a.agentVersion}');
  });

  it('the update one-liner carries --update-only, not a pairing code placeholder', () => {
    // YOUR-CODE in the update path would tell an already-paired Mac user to
    // go get a code they do not need — --update-only skips pairing. Since the
    // 2026-10-20 self-host hardening both one-liners are built by
    // lib/instance-setup.ts from the page origin (so a self-host never points
    // its Macs at digby.example.com); the card calls the helper, the helper carries the flag.
    expect(CARD).toContain("bash -s -- --update-only"); // production's exact one-liner
    expect(CARD).toContain('macAgentUpdateCommand(installOrigin)'); // a self-host origin's
    expect(SETUP_LIB).toContain("bash -s -- --update-only");
    expect(CARD).not.toContain('bash -s -- ${pairingCode || ' + "'YOUR-CODE'}</");
  });

  it('the per-device meta line still names the running agent version', () => {
    expect(CARD).toContain('· agent v{a.agentVersion}');
  });
});

describe('IntegrationsTab — the download line says which agent the DMG bundles', () => {
  it('fetches the SAME feed the app updater reads (never SW-cached) and renders the stamp', () => {
    expect(TAB).toContain("fetch('/desktop-latest.json')");
    expect(TAB).toContain('dmgAgentVersion');
    expect(TAB).toContain('This download bundles');
    expect(TAB).toContain('Mac agent v{dmgAgentVersion}');
  });
});

describe('desktop-latest.json — the bundled-agent stamp', () => {
  it('carries agentVersion naming WHICH agent the served DMG bundles', () => {
    // build-app.sh stamps this from imessage-agent/package.json at build time.
    // Two windows: while the served DMG is still the 0.1.10 build (commit
    // 7b74ecc5b) the stamp is the bundled 0.6.3; once the feed moves to
    // ≥0.1.12 the DMG is built from the current tree, so the stamp may
    // honestly name an OLDER agent (a later agent bump before the DMG is
    // rebuilt) but never a WISHFUL newer one — the exact hand-stamp bug
    // this suite was written to pin.
    expect(FEED.url).toBe('https://digby.example.com/Digby.dmg');
    if (atLeast(FEED.version, '0.1.12')) {
      expect(agentVersionOlder(AGENT_PKG.version, FEED.agentVersion ?? '')).toBe(false);
    } else {
      expect(FEED.version).toBe('0.1.10');
      expect(FEED.agentVersion).toBe('0.6.3');
    }
  });

  it('the notes tell a re-downloader the DMG is not the current agent release', () => {
    if (atLeast(FEED.version, '0.1.12')) {
      // 0.1.12+ is built from the current tree and build-app.sh's staleness
      // guard (ticket 405927c9) refuses a stale agent, so the DMG bundles
      // the CURRENT release — the stale-agent caveat must be gone.
      expect(FEED.notes).not.toMatch(/not the current agent release/i);
    } else {
      expect(FEED.notes).toMatch(/0\.6\.3/i);
      expect(FEED.notes).toMatch(/one-line installer/i);
    }
  });
});

describe('install-digby-agent.sh — the --update-only path (served from digby.example.com)', () => {
  it('accepts --update-only and skips the pairing-code requirement for it', () => {
    expect(INSTALLER).toContain('--update-only');
    // The update path does not hard-exit on a missing code — that early-exit
    // was the reason "reinstall without a code" was impossible.
    expect(INSTALLER).toContain('if [[ "$UPDATE_ONLY" = "1" && -z "$PAIR_CODE" ]]');
  });

  it('fails fast (right guidance, no bogus pairing attempt) on a never-paired Mac', () => {
    expect(INSTALLER).toContain('--update-only: this Mac has no Digby agent pairing to update');
  });

  it('positional args survive the flag: code + --update-only still pairs', () => {
    // The ARGS filter strips ONLY the flag — a pairing code passed alongside
    // the flag keeps flowing to the pair step.
    expect(INSTALLER).toContain('PAIR_CODE="${ARGS[0]:-${DIGBY_PAIR_CODE:-}}"');
  });
});

describe('install.sh — the app-bundled agent must not keep running beside the self-managed install', () => {
  it('boots out every never-updating install shape when installing', () => {
    // Both agents poll with the SAME token; the bundled 0.6.3 (predates
    // self-update, below the minUpdaterVersion floor) never catches up, and a
    // re-downloaded app re-installs it — the ticket's exact loop. 405927c9
    // extended the retire to the /Library/Digby .pkg install too (its served
    // .pkg froze agent 0.1.0 — the "still says I have old 0.63" flap).
    const installSh = readSrc('../../../../../imessage-agent/install.sh');
    expect(installSh).toContain('ai.digby.imessage-agent.plist');
    expect(installSh).toContain('stopped an old Digby install');
    expect(installSh).toContain('"/Library/Digby/"*');
  });
});
