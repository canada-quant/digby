/**
 * Agent TCC consolidated re-grant card — pure-function replay (feedback
 * ticket c44b19e9, 2026-10-24, agent 0.9.9).
 *
 * THE MISHAP: the agent's self-update swaps its binary tree; macOS TCC keys
 * the ax/sr/fda/CAL grants to the exact file, so they silently die. The
 * e2915963 detector catches the ax/sr/fda advert flips but CANNOT see the
 * Calendars loss (TCC_REGRESSION_KEYS is ax/sr/fda; the cal advert flips
 * only after the first DENIED read — re-probed live 19:26Z 2026-10-24,
 * {"reason":"calendar-denied"} with NO remediation). The 0.9.9 agent runs
 * a non-requesting post-update preflight + a runtime grant-loss watchdog
 * and carries the joined grant set on every poll while the episode is open
 * (`regrant=cal,sr`).
 *
 * THIS SUITE pins the backend half (agent-tcc-regrant.ts + the poll wiring):
 *   1. parseRegrantParam — the wire contract (garbage never fabricates an
 *      episode; unknown tokens are rejected whole).
 *   2. tccReGrantPushText — the ONE consolidated card: every grant's pane
 *      + the QUIT-and-RELAUNCH line (the operator rule, incident 6f4f8b36).
 *   3. shouldPushReGrant — ONE push per episode (the agent re-sends the key
 *      every 25 s poll while the owner is at System Settings; the backend
 *      must not echo that as a message storm).
 *   4. Source pins: the poll wiring + the calendars pane joining VALID_PANES.
 */

import {
  parseRegrantParam,
  shouldPushReGrant,
  tccReGrantPushText,
  regrantEpisodeKey,
  regrantDedupeKey,
  regrantCoversRegression,
  REGRANT_LABELS,
  REGRANT_PANES,
} from './agent-tcc-regrant';
import { readFileSync } from 'fs';
import { join } from 'path';

const controllerSrc = readFileSync(join(__dirname, 'imessage.controller.ts'), 'utf8');

describe('c44b19e9: parseRegrantParam — the poll wire contract', () => {
  it('parses the agent\'s joined form into the canonical ordered set', () => {
    // The agent sends regrantEpisodeKey output: sorted, comma-separated.
    expect(parseRegrantParam('cal,sr')).toEqual(['sr', 'cal']);
    expect(parseRegrantParam('ax,cal,fda,sr')).toEqual(['ax', 'sr', 'fda', 'cal']);
    expect(parseRegrantParam('cal')).toEqual(['cal']);
  });

  it('dedupes repeated tokens', () => {
    expect(parseRegrantParam('cal,cal')).toEqual(['cal']);
  });

  it('absent / empty / garbage is null — never a fabricated episode', () => {
    expect(parseRegrantParam(undefined)).toBeNull();
    expect(parseRegrantParam('')).toBeNull();
    expect(parseRegrantParam('   ')).toBeNull();
    expect(parseRegrantParam('not-a-key')).toBeNull();
    // An unknown token poisons the WHOLE param (not silently dropped) — a
    // half-parsed card that omits a lost grant is worse than no card.
    expect(parseRegrantParam('cal,bogus')).toBeNull();
    expect(parseRegrantParam(123 as unknown as string)).toBeNull();
    expect(parseRegrantParam(null as unknown as string)).toBeNull();
  });
});

describe('c44b19e9: tccReGrantPushText — the ONE consolidated card', () => {
  it('lists every lost grant with its System Settings pane, and ends with the quit-and-relaunch line', () => {
    const text = tccReGrantPushText('Paul\'s MacBook Pro', ['cal', 'sr'], '0.9.8 → 0.9.9');
    expect(text).toContain("🔐 Digby Mac permission re-grant needed — Paul's MacBook Pro (0.9.8 → 0.9.9):");
    // Every grant's pane line.
    expect(text).toContain('• Calendars — System Settings → Privacy & Security → Calendars,');
    expect(text).toContain('• Screen Recording — System Settings → Privacy & Security → Screen Recording,');
    // The operator rule rides the card — the 2026-10-24 incident shape was
    // exactly an owner who re-granted while the RUNNING process stayed blind.
    expect(text).toContain('Then QUIT and RELAUNCH the Digby agent on that Mac — a newly granted permission only applies to a freshly launched process');
  });

  it('renders with a null cause (the watchdog episode has no version transition)', () => {
    const text = tccReGrantPushText('Mac mini', ['fda'], null);
    expect(text).toContain('re-grant needed — Mac mini:');
    expect(text).toContain('• Full Disk Access — System Settings → Privacy & Security → Full Disk Access,');
  });
});

describe('c44b19e9: shouldPushReGrant — ONE push per episode', () => {
  it('fires on a grant-set not yet pushed', () => {
    expect(shouldPushReGrant(['cal'], null)).toBe(true);
    expect(shouldPushReGrant(['cal', 'sr'], 'ax')).toBe(true);
  });

  it('stays quiet while the SAME set re-arrives every 25 s poll (the storm guard)', () => {
    expect(shouldPushReGrant(['cal', 'sr'], 'cal,sr')).toBe(false);
    expect(shouldPushReGrant(['sr', 'cal'], 'cal,sr')).toBe(false); // order-insensitive
  });

  it('a DIFFERENT set (more grants lost) is a new episode and pushes again', () => {
    expect(shouldPushReGrant(['cal', 'sr', 'fda'], 'cal,sr')).toBe(true);
  });

  it('an empty set never pushes', () => {
    expect(shouldPushReGrant([], null)).toBe(false);
    expect(shouldPushReGrant([], 'cal')).toBe(false);
  });
});

describe('c44b19e9: the dedupe key + labels + panes', () => {
  it('the dedupe key is per-agent and distinct from the e2915963 seam key', () => {
    expect(regrantDedupeKey('agent-1')).toBe('tcc_regrant:agent-1');
    expect(regrantDedupeKey('agent-1')).not.toContain('tcc_regression');
  });

  it('regrantEpisodeKey joins in the same format as the agent\'s key (sorted)', () => {
    expect(regrantEpisodeKey(['sr', 'cal'])).toBe('cal,sr'); // sorted — agent-side parity
  });

  it('every grant has a label and a pane the card can dispatch (open-pane vocabulary)', () => {
    expect(REGRANT_LABELS.cal).toBe('Calendars');
    expect(REGRANT_PANES).toEqual({
      ax: 'accessibility',
      sr: 'screen-recording',
      fda: 'full-disk-access',
      cal: 'calendars',
      // 30d3c366: Input Monitoring + Automation join the vocabulary — the two
      // grants a self-update actually orphaned on the owner's Macs.
      im: 'input-monitoring',
      ae: 'automation',
    });
  });
});

describe('c44b19e9: source pins — the poll wiring (house idiom)', () => {
  it('the poll parses the regrant param and pushes ONE deduped consolidated card', () => {
    expect(controllerSrc).toContain('parseRegrantParam(req.query.regrant)');
    expect(controllerSrc).toContain('shouldPushReGrant(regrantGrants, pushedKeySet)');
    expect(controllerSrc).toContain('pushTccReGrantToOwner(agent.userId, device, text, key, regrantEpisodeKey(regrantGrants))');
  });

  it('an ABSENT param releases the episode key (absent-never-clobbers; future episodes push fresh)', () => {
    expect(controllerSrc).toMatch(/const regrantGrants = parseRegrantParam\(req\.query\.regrant\);[\s\S]*?\} else \{\s*\n\s*\/\/ Episode healed[\s\S]*?regrantDedupeKey\(agent\.id\)/);
  });

  it('the push helper is the same mark-first/release-on-failure discipline as e2915963 (fire-and-forget, never throws)', () => {
    expect(controllerSrc).toMatch(/async function pushTccReGrantToOwner\([\s\S]*?: Promise<void>/);
    expect(controllerSrc).toMatch(/void pushTccReGrantToOwner\(/);
    // Mark FIRST (anti-spam), release on send failure (retry semantics).
    const fn = controllerSrc.slice(
      controllerSrc.indexOf('async function pushTccReGrantToOwner'),
      controllerSrc.indexOf('async function pushTccReGrantToOwner') + 1800,
    );
    expect(fn.indexOf('.set(dedupeKey, episodeKeySet')).toBeLessThan(fn.indexOf('sendMessage'));
    expect(fn).toContain('.del(dedupeKey)');
  });

  it('the calendars pane joins the permissionAction VALID_PANES (the card\'s button must not 400)', () => {
    expect(controllerSrc).toContain(
      // 30d3c366: the two new panes join the same single-line gate, or the
      // card's per-grant button 400s for exactly the grants the ticket lost.
      "['accessibility', 'screen-recording', 'full-disk-access', 'calendars', 'input-monitoring', 'automation']",
    );
  });

  it('the e2915963 regression seam is INTACT beside the new surface', () => {
    expect(controllerSrc).toContain('whichTccPermissionsRegressed(agentPermissions(agent), mergedPerms)');
    expect(controllerSrc).toContain('pushTccRegressionToOwner(');
  });

  it('T1 (follow-up review): a regression the OPEN consolidated episode covers does NOT also push the e2915963 message — ONE incident, ONE message', () => {
    // The pure covered-guard: full coverage suppresses; partial does not; no
    // episode (an agent older than 0.9.9) never suppresses.
    expect(regrantCoversRegression(['ax', 'sr'], ['ax', 'sr', 'cal'])).toBe(true);
    expect(regrantCoversRegression(['ax'], ['sr', 'cal'])).toBe(false);
    expect(regrantCoversRegression(['ax'], null)).toBe(false);
    expect(regrantCoversRegression([], ['ax'])).toBe(false);
    // The wiring: the guard rides the regression push condition, and the
    // parse is hoisted ABOVE it (the guard needs the episode first).
    expect(controllerSrc).toContain('!regrantCoversRegression(regressed, regrantGrants)');
    const parseAt = controllerSrc.indexOf('const regrantGrants = parseRegrantParam(req.query.regrant);');
    const guardAt = controllerSrc.indexOf('!regrantCoversRegression(regressed, regrantGrants)');
    expect(parseAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(parseAt);
  });

  it('T3 (follow-up review): a NO-CHANNEL outcome releases the dedupe key — the episode is never deduped into silence', () => {
    // Both seams: the unconfigured-Telegram and no-linked-chat early returns
    // must release the key they just marked (a permanently-marked key with
    // nowhere to send would swallow the episode for its 7-day TTL).
    const regrantFn = controllerSrc.slice(
      controllerSrc.indexOf('async function pushTccReGrantToOwner'),
      controllerSrc.indexOf('async function pushTccReGrantToOwner') + 2200,
    );
    expect(regrantFn).toContain("if (!tg?.isConfigured?.()) {");
    expect(regrantFn.match(/del\(dedupeKey\)/g)?.length).toBeGreaterThanOrEqual(3);
    const regressionFn = controllerSrc.slice(
      controllerSrc.indexOf('async function pushTccRegressionToOwner'),
      controllerSrc.indexOf('async function pushTccReGrantToOwner'),
    );
    expect(regressionFn).toContain("if (!tg?.isConfigured?.()) {");
    expect(regressionFn.match(/del\(dedupeKey\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
