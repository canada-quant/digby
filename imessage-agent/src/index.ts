#!/usr/bin/env node
/**
 * Digby macOS iMessage bridge agent — entry point.
 *
 * Commands:
 *   digby-agent pair     Interactive pairing (enter the code from the Digby web UI)
 *   digby-agent run      Run the agent loop (long-poll → execute → return result)
 *   digby-agent status   Print config + verify chat.db access
 */

import { hostname, tmpdir } from 'os';
import { execFile } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { AgentConfig, AGENT_VERSION, loadConfig, reloadConfig, saveConfig, clearConfig, configPath, getDeviceId } from './config';
import { pairComplete, pollCommand, postResult, AgentCommand, fetchRelayFrames, postRelayFrame, isIdleRelayRefusal, RelayFrame } from './api';
import { RelaySessionCodec, captureScreenRgba, keysymToKeyName, keysymToText } from './relay-session';
import { retireBundledHelper, BUNDLED_AGENT_LABEL } from './retire-bundled-helper';
import { writeRunningAgentStamp } from './running-agent';
import { trySelfUpdate, noteHealthyPoll, runWatchdog, selfTest } from './self-update';
import { healRuntimeIfCoupled } from './runtime-dylib';
import { listChats, getMessages, checkAccess } from './chatdb';
import { sendMessage } from './sender';
import { listEvents, calendarAuthStatus } from './calendar';
import { readConsentEpisode } from './calendar-consent';
import * as browser from './browser';
import * as computer from './computer';
import { lastCaptureTruth, lastAutomationDenial, clearAutomationDenial, isAutomationDenialText } from './computer';
import {
  computePermissionStatus,
  bundleReplaced,
  currentBinaryIdentity,
  onboardingDue,
  missingPermissionPanes,
  onboardingMessage,
  PANE_LABELS,
  PANE_URLS,
  PermissionPane,
  PermissionStatus,
  noteCalendarRead,
  calendarAdvert,
  helperDisplayName,
} from './permissions';
import {
  ReGrantKey,
  TccReGrantNeeded,
  TccDenialSource,
  buildTccReGrantNeeded,
  regrantNeededMessage,
  regrantEpisodeKey,
  convictionChangesEpisode,
  classifyDenial,
  denialFromErrorText,
  preflightGrants,
  preflightCauseFromSwap,
  regressionCovered,
  WATCHDOG_CAUSE,
  REGRANT_PANE_URLS,
} from './tcc-regrant';
import { reRetireDue, nowMs, _stampRetireCheck } from './retire-clock';
import { readRuntimeSwapStamp, clearRuntimeSwapStamp } from './runtime-dylib';
import {
  probeMacUnattended,
  realMacIo,
  unattendedAdvertValue,
  evaluateMacUnattended,
  BLOCKER_TEXT,
  applyMacPreset,
  revertMacPreset,
  ensureAdminRights,
  UnattendedRefusal,
  MacUnattendedSnapshot,
} from './unattended';
import {
  probeMacRemoteAccess,
  probeMacRemoteListener,
  realMacRemoteIo,
  evaluateMacRemoteAccess,
  remoteAccessAdvertValue,
  planMacRemoteEnable,
  planMacRemoteRevert,
  runMacRemotePlan,
  verifyMacRemoteRevert,
  privilegedRunRefusal,
  MAC_AGENT_CLI_QUOTED,
  VNC_SETTINGS_FILE,
} from './remote-access';

const DEFAULT_API_BASE = 'https://digby.ai/api';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Permission-regression surfacing (ticket e2915963, agent 0.9.7) ───────────
//
// THE MISHAP: the agent's runtime heal (21c68e74) swaps the DigbyAgent binary
// at its stable path when the runtime is still keg-coupled (a rename — a new
// inode, and for a FIRST heal genuinely different bytes). macOS TCC grants
// (Accessibility / Screen Recording / Full Disk Access) attach to the exact
// file, so the swap silently orphans them: System Settings still shows the
// switch ON, but the next computer_* dispatch dies at steps 0 with "Missing
// macOS permission(s): Accessibility" and NOTHING told the owner. On the
// incident Mac (cqlstannembp1, 2026-10-24 14:48Z) a 0.9.4→0.9.6 self-update
// took exactly this path (the 0.9.4 runtime was a keg-coupled Homebrew node
// copy; the heal swapped in the official build) and a scheduled AWS-console
// drive stood down at zero steps until the owner physically re-granted.
//
// THE SURFACING CONTRACT (the "proactively surface them" half of the ticket's
// suggestion — the grants CANNOT be preserved when the binary really changes,
// but the owner can be told the moment it happens):
//   1. The successor of a swap reads runtime-swap.json and SEEDS its TCC
//      baseline from the PREDECESSOR's last-known grants where available —
//      the swap's restart means the regression can span processes (review
//      F6), so the agent half alone must not miss it.
//   2. On every poll, a previously-true flag reading false is a REGRESSION.
//   3. A regression surfaces as (a) a macOS notification, (b) the Privacy &
//      Security pane deep-link, (c) a log line — all FIRE-AND-FORGET (review
//      F2: the display-dialog channel is NOT awaited here; an unclicked
//      dialog waits 120 s for an absent owner and would stall the poll loop).
//      The in-app Integrations card already live-updates from the advert
//      (2f646c10), and the Telegram half rides the backend's
//      stored-permissions regression detector (e2915963, backend
//      imessage.controller.ts).
//
// Pure decision core (exported for the Linux-CI test suite):
//   whichPermissionsRegressed(before, after) → the keys that WERE granted
//   and are now missing (ax/sr/fda only — `relaunch` is advisory, `cal`
//   fires on first calendar use, not a TCC regression of this class).

/** The TCC grants this class of regression can lose. */
export type TccGrantKey = 'ax' | 'sr' | 'fda';

/** Pure: which of ax/sr/fda were granted before and are missing after. */
export function whichPermissionsRegressed(
  before: { ax?: boolean; sr?: boolean; fda?: boolean } | null | undefined,
  after: { ax?: boolean; sr?: boolean; fda?: boolean } | null | undefined,
): TccGrantKey[] {
  const out: TccGrantKey[] = [];
  for (const k of ['ax', 'sr', 'fda'] as const) {
    if (before?.[k] === true && after?.[k] !== true) out.push(k);
  }
  return out;
}

/** Map a regression key to its System Settings pane (shared with computer.ts). */
export function regressionPane(key: TccGrantKey): PermissionPane {
  return key === 'ax' ? 'accessibility' : key === 'sr' ? 'screen-recording' : 'full-disk-access';
}

const TCC_GRANT_LABELS: Record<TccGrantKey, string> = {
  ax: 'Accessibility',
  sr: 'Screen Recording',
  fda: 'Full Disk Access',
};

/** The owner-facing message for a regression (pure — the tests pin it). */
export function regressionMessage(keys: TccGrantKey[], cause: string | null): string {
  const names = keys.map((k) => TCC_GRANT_LABELS[k]).join(', ');
  const why = cause
    ? ` This happened because the Digby agent updated itself and its runtime binary changed (${cause}); macOS attaches these permissions to the exact file.`
    : '';
  return (
    `Digby needs a macOS permission re-granted: ${names}.${why} ` +
    'Open System Settings → Privacy & Security, find DigbyAgent in each list, and toggle it off then on. ' +
    'Until then, remote control of this Mac will fail with "Missing macOS permission(s)".'
  );
}

/**
 * Fire the on-Mac surfacing for a detected regression. FIRE-AND-FORGET by
 * design (review F2): every leg is independent and none is awaited by the
 * poll loop — the dialog leg especially is a `display dialog` that WAITS for
 * a click (up to its 120 s timeout) and must never stall a long-poll agent.
 * The pane deep-link is the SAME vocabulary permission_open_pane validates
 * server-side (PANE_URLS — never a drift).
 */
function surfacePermissionRegression(keys: TccGrantKey[], cause: string | null): void {
  const msg = regressionMessage(keys, cause);
  log(`⚠️  macOS permission regression (${keys.join(', ')}): the grants must be re-made — ${cause ?? 'cause unknown'}.`);
  // The notification + dialog + pane are each best-effort, in the
  // background: an unclicked dialog parks harmlessly while the notification
  // lands in the notification center for an absent owner.
  void (async () => {
    try {
      execFile('osascript', ['-e', `display notification ${JSON.stringify(msg.slice(0, 240))} with title ${JSON.stringify('Digby — permission re-grant needed')}`], { timeout: 15000 }, () => { /* best-effort */ });
    } catch { /* best-effort */ }
    const first = keys[0];
    try { execFile('open', [PANE_URLS[regressionPane(first)]]); } catch { /* best-effort */ }
    try { await osascriptNotify(msg, 'Digby — permission re-grant needed'); } catch { /* best-effort */ }
  })();
}

// ── TCC grant-loss self-heal (ticket c44b19e9, agent 0.9.9) ──────────────────
// The consolidated surface: ONE event per episode listing EVERY lost grant
// (the e2915963 dialog above names only ax/sr/fda and knows nothing of the
// Calendars loss), with the pane deep-link per grant and the QUIT+RELAUNCH
// line last (the operator rule, incident 6f4f8b36: a new grant applies only
// to a freshly launched process). Fire-and-forget — same review-F2 shape as
// surfacePermissionRegression (the click-waiting dialog never stalls a poll).
function surfaceTccReGrant(event: TccReGrantNeeded): void {
  const helper = helperDisplayName();
  const msg = regrantNeededMessage(event, helper);
  log(`⚠️  TCC re-grant needed (${event.grants.join(', ')}) — ${event.cause ?? 'cause unknown'}; quit + relaunch after re-granting.`);
  void (async () => {
    try {
      execFile('osascript', ['-e', `display notification ${JSON.stringify(msg.slice(0, 240))} with title ${JSON.stringify('Digby — permissions lost after update')}`], { timeout: 15000 }, () => { /* best-effort */ });
    } catch { /* best-effort */ }
    // The FIRST pane deep-link only — the message names every pane; opening
    // four System Settings windows at once is its own spam.
    try { execFile('open', [REGRANT_PANE_URLS[event.grants[0]]]); } catch { /* best-effort */ }
    try { await osascriptNotify(msg, 'Digby — permissions lost after update'); } catch { /* best-effort */ }
  })();
}

/** The open grant-loss episode (this process): grants convicted at call
 *  time by REAL outcomes. Heals are reconciled from the latches every poll
 *  (see the loop) — never by a probe. */
let openTccEpisode: ReGrantKey[] = [];
/** The episode key already surfaced (joined grants) — ONE surfacing +
 *  ONE `regrant` poll param per episode; re-arms when the set changes. */
let surfacedReGrantKey: string | null = null;

/** Feed the watchdog: a classified call-time TCC denial ADDS its grant to
 *  the open episode (deduped — the same denial on every command while the
 *  episode is open changes nothing, the 30787bc4 anti-pattern). Called from
 *  the run loop's result/error classification — never from a probe. */
function noteTccDenial(source: TccDenialSource | null): void {
  if (!source) return;
  if (convictionChangesEpisode(openTccEpisode, source)) {
    openTccEpisode = [...openTccEpisode, classifyDenial(source)!];
  }
}


/** Native macOS text-input dialog. Returns the entered text, or null (cancel / no GUI). */
function osascriptPrompt(message: string, title = 'Connect Digby'): Promise<string | null> {
  return new Promise((resolve) => {
    const script =
      `display dialog ${JSON.stringify(message)} with title ${JSON.stringify(title)} ` +
      `default answer "" buttons {"Cancel", "Connect"} default button "Connect"`;
    execFile('osascript', ['-e', script], { timeout: 180000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = /text returned:(.*)$/m.exec((stdout || '').trim());
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** Native macOS notification dialog (OK only). Best-effort — no-op without a GUI. */
function osascriptNotify(message: string, title = 'Digby'): Promise<void> {
  return new Promise((resolve) => {
    const script =
      `display dialog ${JSON.stringify(message)} with title ${JSON.stringify(title)} ` +
      `buttons {"OK"} default button "OK"`;
    execFile('osascript', ['-e', script], { timeout: 120000 }, () => resolve());
  });
}

/** Open System Settings → Full Disk Access and reveal this binary so the user can add it. */
function openFullDiskAccessGuidance(): void {
  try {
    execFile('open', [PANE_URLS['full-disk-access']]);
    execFile('open', ['-R', process.execPath]); // reveal the helper binary in Finder
  } catch { /* best-effort */ }
}

/**
 * Pair (silent env-code path or interactive), sending the CURRENT permission
 * state with the pair request (ticket 2f646c10) — the Account card can show
 * "needs Full Disk Access" from the first second, not after the first poll.
 * Best-effort: when the probes fail (no GUI preflight context, sqlite wedged)
 * the pair proceeds without permissions and the run loop's advert carries it.
 */
async function pairWithPermissions(apiBaseUrl: string, code: string): Promise<{ agentId: string; agentToken: string }> {
  const deviceName = hostname();
  const deviceId = getDeviceId();
  let permissions: PermissionStatus | null = null;
  try {
    permissions = await computePermissionStatus();
  } catch {
    permissions = null;
  }
  return pairComplete(apiBaseUrl, code, deviceName, deviceId, permissions);
}

/**
 * Return the saved config, or pair via a native popup (zero-Terminal) if unpaired.
 * Returns null if the user cancels or no GUI is available.
 */
async function ensurePaired(): Promise<AgentConfig | null> {
  const existing = loadConfig();
  if (existing) return existing;

  const apiBaseUrl = (process.env.DIGBY_API_URL || '').trim() || DEFAULT_API_BASE;
  const deviceName = hostname();
  const deviceId = getDeviceId();

  // Non-interactive pairing when a code is supplied via env — used by the bundled
  // macOS app, which writes the LaunchAgent with DIGBY_PAIR_CODE set so the agent
  // pairs silently (no second code-entry popup). Falls through to the interactive
  // prompt if the env code is missing or expired.
  const envCode = (process.env.DIGBY_PAIR_CODE || '').trim().replace(/[^A-Za-z0-9-]/g, '');
  if (envCode) {
    try {
      // Multi-Mac (2026-09-24): the stable device id lets the backend upsert
      // THIS Mac's row — re-pairing never disturbs the user's other Macs.
      // 2f646c10: the pair request carries the current TCC state.
      const { agentId, agentToken } = await pairWithPermissions(apiBaseUrl, envCode);
      const config: AgentConfig = { apiBaseUrl, agentId, agentToken, deviceId };
      saveConfig(config);
      osascriptNotify(`Connected as "${deviceName}". Digby can now read and send your iMessages.`).catch(() => {});
      return config;
    } catch {
      /* code expired / already used → ask interactively below */
    }
  }

  const code = await osascriptPrompt(
    'Enter your Digby pairing code.\n\n' +
    'Get it from digby.ai → Account → Integrations → iMessage → Connect your Mac.',
  );
  if (!code) return null;

  const cleanCode = code.replace(/[^A-Za-z0-9-]/g, '');
  try {
    const { agentId, agentToken } = await pairWithPermissions(apiBaseUrl, cleanCode);
    const config: AgentConfig = { apiBaseUrl, agentId, agentToken, deviceId };
    saveConfig(config);
    osascriptNotify(`Connected as "${deviceName}". Digby can now read and send your iMessages.`).catch(() => {});
    return config;
  } catch (e: any) {
    osascriptNotify(`Pairing failed: ${e?.message || e}\n\nGet a fresh code from Digby and try again.`).catch(() => {});
    return null;
  }
}

/** Execute a single command from the backend. */
async function execute(command: AgentCommand): Promise<unknown> {
  const { method, params } = command;
  switch (method) {
    case 'list_chats':
      return listChats(Number(params.limit) || 20);
    case 'get_messages':
      return getMessages(String(params.chat || ''), Number(params.limit) || 25);
    case 'send_message':
      return sendMessage(String(params.to || ''), String(params.text || ''));
    case 'ping':
      return { pong: true, version: AGENT_VERSION };
    // ── Calendar read (v0.7.2, ticket 1ea9a120) — EventKit read over the
    // ObjC bridge (ASOC); the result feeds the calendar TCC latch so the
    // permissions advert reflects REAL read outcomes (never a standalone
    // probe — the 0.7.2 auth-tier gate denies not-determined/write-only
    // tiers BEFORE any read, so consent never fires mid-dispatch; the grant
    // is driven from System Settings). The
    // handler itself never throws: every failure shape comes back as
    // {events:null, unavailable:{reason, pane:'calendar'}}.
    case 'calendar_list_events': {
      const days = Math.min(Math.max(Number(params.days) || 7, 1), 120);
      const result = await listEvents(days);
      // c44b19e9: a classified DENIAL is also the watchdog's conviction
      // (the calendar-denied class — the live probe at 19:26Z 2026-10-24
      // showed it surfacing with NO remediation). add-only; heals below.
      if (result.unavailable?.reason === 'calendar-denied') noteTccDenial({ kind: 'calendar-denied' });
      // Latch semantics (permissions.ts noteCalendarRead): a successful read
      // grants; a classified DENIAL (reason 'calendar-denied' — EventKit auth
      // denied / write-only tier, or the legacy TCC -1743 Apple-events
      // denial) flips it off; an UNREACHABLE read (bridge failure ≠
      // permission revoked) is not fed to the latch at all, so the advert
      // keeps its previous value and never masquerades as a denial or a grant.
      // daf8706a: 'calendar-never-requested' (tier 0 — this client never
      // asked) IS a permission-state negative, so it feeds false like a
      // denial — but deliberately NOT noteTccDenial: the post-update
      // preflight owns TCC grant-loss detection (a first-ever ungranted
      // Mac must not file a spurious regression, the 0.9.8 lesson), and
      // the read path fires the consent request itself on this tier.
      if (result.events !== null) {
        noteCalendarRead(true);
      } else if (
        result.unavailable?.reason === 'calendar-denied' ||
        result.unavailable?.reason === 'calendar-never-requested'
      ) {
        noteCalendarRead(false);
      }
      return result;
    }
    // ── Calendar consent status (2026-11-06) — NON-REQUESTING ────────────
    // Reports the LAST consent episode this Mac observed, read from the
    // persisted record (a file read; it can never fire an EventKit request,
    // so it is safe on the integrations card's poll — the 0.9.8 rule). The
    // backend uses it to describe what actually happened instead of claiming
    // a dialog it never saw. Absent episode → { state: null } with the tier
    // read from the NON-REQUESTING authorization-status probe, so a Mac that
    // was never asked is distinguishable from one that was asked and is
    // still undecided.
    case 'calendar_consent_status': {
      const episode = readConsentEpisode();
      const grantedNow = await calendarAuthStatus();
      return {
        consent: episode,
        // true = readable now, false = not readable, null = unknown (the
        // status probe itself failed — never reported as a denial).
        readable: grantedNow,
        client: process.execPath || 'unknown',
      };
    }
    // ── Browser automation (v0.2.0+) — driven by the backend's LocalBrowserDriver ──
    // v0.5.0 (4258335e): the per-task CDP-attach opt-in rides every browser_*
    // command as params.attach — it only takes effect when the owner's master
    // switch (config.json browserCdpAttach / DIGBY_BROWSER_CDP_ATTACH) is on too.
    case 'browser_navigate':
      return browser.navigate(String(params.url || ''), { attach: params.attach === true });
    case 'browser_get_content':
      return browser.getContent((params.format as 'text' | 'html' | 'snapshot') || 'text', { attach: params.attach === true });
    case 'browser_extract':
      return browser.getContent('text', { attach: params.attach === true });
    case 'browser_click':
      return browser.click(String(params.selector || ''), { attach: params.attach === true });
    case 'browser_type':
      return browser.type(String(params.selector || ''), String(params.text || ''), Boolean(params.submit), { attach: params.attach === true });
    case 'browser_scroll':
      return browser.scroll((params.direction as 'up' | 'down' | 'top' | 'bottom') || 'down', Number(params.amount) || undefined, { attach: params.attach === true });
    case 'browser_screenshot':
      // v0.4.1: optional {format:'jpeg', quality} for the backend's per-action
      // live-view frames (older backends send no params → PNG as before).
      return browser.screenshot({
        format: params.format === 'jpeg' ? 'jpeg' : 'png',
        quality: Number(params.quality) || undefined,
        attach: params.attach === true,
      });
    // v0.4.0+: headed escalation — relaunch the (headless-by-default) browser
    // HEADED on the same profile so the user can complete a login/2FA by hand.
    case 'browser_pop_out':
      return browser.popOut();
    case 'browser_close':
      return browser.close();
    // ── Computer use (v0.3.0+) — see the screen and drive it, via CGEvent ──
    case 'computer_screenshot':
      return computer.screenshot();
    case 'computer_click':
      return computer.click(Number(params.x), Number(params.y), params.button === 'right' ? 'right' : 'left', Number(params.clicks) === 2 ? 2 : 1);
    case 'computer_type':
      return computer.typeText(String(params.text || ''));
    case 'computer_key':
      return computer.keyPress(String(params.key || ''), Array.isArray(params.modifiers) ? params.modifiers.map(String) : []);
    case 'computer_scroll':
      // v0.4.3 (ticket 4e4d56ff): optional x/y target (image px of the last
      // screenshot) — the pointer is moved+verified there before the wheel.
      return computer.scroll(
        params.direction === 'up' ? 'up' : 'down',
        Number(params.amount) || 10,
        typeof params.x === 'number' ? Number(params.x) : undefined,
        typeof params.y === 'number' ? Number(params.y) : undefined,
      );
    case 'computer_open':
      return computer.openApp(String(params.target || ''));
    case 'computer_frontmost':
      return computer.frontmost();
    // ── Permission onboarding actions (v0.6.0, ticket 2f646c10) — dispatched
    // by the Account → Integrations card's buttons. The card only enables them
    // while the agent is online (a dead helper can't bounce itself), and the
    // backend validates the action/pane before dispatching.
    case 'permission_relaunch':
      // The button means "restart the helper" — exit 1 so launchd's KeepAlive
      // (ThrottleInterval 10s) relaunches from the CURRENT bundle, which
      // re-evaluates TCC (the stale-grant self-heal). The result is posted
      // BEFORE the exit — the backend resolves its request first.
      setTimeout(() => process.exit(1), 500);
      return { relaunching: true };
    case 'permission_open_pane': {
      // Open System Settings → Privacy & Security → <pane>; the same
      // centralized PANE_URLS the agent's own guidance dialogs use.
      const pane = String(params.pane || '') as PermissionPane;
      if (!PANE_URLS[pane]) throw new Error(`Unknown permission pane: ${params.pane || '(none)'}`);
      await new Promise<void>((resolve, reject) =>
        execFile('open', [PANE_URLS[pane]], { timeout: 15000 }, (err) => (err ? reject(new Error(err.message)) : resolve())),
      );
      return { opened: pane };
    }
    case 'permission_reveal':
      // Reveal the DigbyHelper binary in Finder — the user drags THIS exact
      // file into the permission list (grants attach to the binary at a
      // stable path inside Digby.app).
      await new Promise<void>((resolve, reject) =>
        execFile('open', ['-R', process.execPath], { timeout: 15000 }, (err) => (err ? reject(new Error(err.message)) : resolve())),
      );
      return { revealed: process.execPath };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * First-launch permission onboarding (v0.6.3 — owner 2026-09-26: "shouldn't
 * the macOS client request all necessary system settings changes the first
 * time you install, so you don't have to then separately do Accessibility,
 * Screen Recording etc?"). Once per helper BINARY (config.permissionsOnboarded;
 * a reinstall or app update re-arms it because the re-signed helper may need
 * its grants re-made):
 *   1. the NATIVE Accessibility prompt (macOS pre-lists DigbyHelper — one switch),
 *   2. the NATIVE Screen Recording prompt (a throwaway screencapture — also the
 *      ground truth, since macOS 26's preflight cannot see this permission;
 *      30787bc4: this is one of the only two prompt-armed capture paths — the
 *      status poll may never fire one, it goes through the backoff ladder),
 *   3. Full Disk Access (no prompt API): the pane + DigbyHelper revealed in Finder,
 *   4. ONE consolidated checklist dialog of whatever is still missing.
 * Never a gate: the agent proceeds into the poll loop either way and the
 * Integrations card live-updates as each grant lands. Returns true when the
 * onboarding ran (so runLoop's steady-state FDA nudge stays quiet this launch).
 * DIGBY_PERMISSIONS_ONBOARD=0 disables the prompts (log only).
 */
async function firstLaunchOnboarding(config: AgentConfig): Promise<boolean> {
  const current = currentBinaryIdentity();
  const due = onboardingDue(config.permissionsOnboarded, current, AGENT_VERSION);
  const disabled = (process.env.DIGBY_PERMISSIONS_ONBOARD || '').trim() === '0';
  const stamp = () => {
    if (!current) return;
    try {
      saveConfig({ ...config, permissionsOnboarded: { version: AGENT_VERSION, dev: current.dev, ino: current.ino, at: new Date().toISOString() } });
    } catch { /* best-effort — a failed stamp only means asking again next launch */ }
  };
  if (!due) return false;
  if (disabled) {
    log('🔐 First launch of this helper binary — permission prompts disabled (DIGBY_PERMISSIONS_ONBOARD=0); the integrations card carries the steps.');
    stamp();
    return false;
  }
  log(`🔐 First launch of this helper binary (v${AGENT_VERSION}) — requesting macOS permissions up front (Accessibility, Input Monitoring, Screen Recording, Full Disk Access)…`);
  let status: PermissionStatus | null = null;
  try {
    status = await computePermissionStatus(true);
  } catch {
    status = null;
  }
  // Accessibility: the native prompt only when not already granted.
  let ax = status?.ax === true;
  if (!ax) ax = await computer.requestAccessibilityPrompt();
  // 30d3c366: Input Monitoring — the native consent sheet, the exact prompt
  // the owner asked for ("why doesn't it request that for you automatically on
  // new digby install"). REQUESTING, so it lives HERE (first-launch onboarding
  // is the one place the 0.9.8 rule permits one — same class as request_ax
  // above) and never on the status poll. Best-effort: an older bridge that
  // lacks CGRequestListenEventAccess answers false and onboarding carries on.
  let im = status?.inputMonitoring === true;
  if (!im) im = await computer.requestInputMonitoringPrompt().catch(() => false);
  // Screen Recording: ALWAYS a real capture — it is both the native prompt
  // (first ask from this binary) and the only trustworthy probe on macOS 26.
  const sr = await computer.probeScreenRecording();
  const fda = status ? status.fda : checkAccess().ok;
  const missing = missingPermissionPanes({
    ax, sr, fda,
    // 30d3c366: thread the Input Monitoring result through, or a dismissed
    // native sheet produces no fallback line at all (the computed `im` was
    // previously discarded — a dead branch). `im === false` is the checklist
    // case; true means granted and is omitted.
    ...(im === false ? { im: false } : {}),
  });
  if (missing.length === 0) {
    log('   all macOS permissions are granted — nothing to ask.');
    stamp();
    return true;
  }
  // One System Settings destination: Full Disk Access when it is missing (its
  // grant needs the add-the-file dance, so reveal the helper too); otherwise
  // the first missing pane. The native prompts carry their own Open System
  // Settings buttons for Accessibility / Screen Recording.
  if (missing.includes('full-disk-access')) openFullDiskAccessGuidance();
  else {
    try { execFile('open', [PANE_URLS[missing[0]]]); } catch { /* best-effort */ }
  }
  await sleep(1500); // let the native prompts land first so the checklist sits on top
  osascriptNotify(onboardingMessage(missing), 'Digby — one-time setup').catch(() => {});
  log(`   still missing after the prompts: ${missing.map((m) => PANE_LABELS[m]).join(', ')} — checklist shown; the integrations card updates live as each one lands.`);
  stamp();
  return true;
}

/**
 * ── RELAY PUMP (ticket c468f922) — the Mac's dial-OUT for a brokered session ─
 *
 * Independent review of the first cut found the relay had a server and no
 * client. This is the client's engine: on every loop tick it (1) drains frames
 * the operator queued for this Mac and (2) flushes anything this Mac has queued
 * back. Both are requests THIS process initiates — there is no inbound port, so
 * the backend still cannot reach this Mac and a home NAT is no obstacle.
 *
 * Deliberately NOT wired to capture/input yet. The request scoped this slice to
 * "a relay forwarder + agent-side dial-out channel that demonstrably CARRIES an
 * authorized session's byte stream ... (screen/control payloads may be minimal
 * or mocked)". So the pump moves bytes and hands them to a handler; the RFB
 * codec and the real screen/input producers are the next slice. Wiring a fake
 * screen producer in here would make it look finished while carrying nothing
 * anyone can use.
 *
 * RATE: one relay poll per loop tick, which the loop already bounds to ~25 s.
 * That is a command-channel cadence, not a video cadence — a real screen stream
 * will need its own tighter pump, called out in the doc rather than pretended.
 */
interface RelayPumpState {
  sessionId: string | null;
  /** Last sequence number received from the operator. */
  cursor: number;
  /** Last refusal we LOGGED, so an idle Mac does not spam the log every tick. */
  lastLoggedRefusal: string;
}

const relayPump: RelayPumpState = { sessionId: null, cursor: 0, lastLoggedRefusal: '' };

/**
 * The RFB codec for the current brokered session (ticket c468f922).
 *
 * ONE instance per process, RESET on every session boundary: the decoder
 * buffers partial messages, so reusing one across sessions would prepend a dead
 * session's trailing bytes to a live stream — which decodes as garbage that
 * looks like a real (wrong) screen.
 */
const relayCodec = new RelaySessionCodec();
/** Set once a capture produced nothing, so a denied permission logs ONCE. */
let relayScreenRefused = false;
/** True once this session's FIRST frame has been sent (change-gating bypass). */
let relayScreenFirstSent = false;
/** Last geometry we logged, so a 4K screen does not log per frame. */
let relayLastScreenLog = '';

/** Frames this Mac wants to send to the operator, drained by the pump. */
const relayOutbox: RelayFrame[] = [];

/** Queue a frame for the operator. `payload` is base64 and stays opaque. */
export function queueRelayFrame(payloadB64: string, final = false): void {
  // Bounded: an unattended Mac must not grow this without limit if nobody is
  // reading (the backend returns queue-full, and this is the mirror of that
  // guard on our side).
  if (relayOutbox.length >= 256) relayOutbox.shift();
  relayOutbox.push({ seq: 0, payloadB64, sentAt: Date.now(), ...(final ? { final: true } : {}) });
}

/**
 * One pump tick. Never throws into the poll loop: a relay problem must not cost
 * this Mac its command channel, which is how it gets repaired.
 */
async function pumpRelay(config: AgentConfig): Promise<void> {
  // ── Drain what the operator sent us ──
  try {
    const out = await fetchRelayFrames(config, relayPump.cursor);
    if (out.ok) {
      // A session that just STARTED must not inherit the previous session's
      // decoder cursor, canvas or half-decoded message: the codec state is
      // per-session, exactly like the relay's own capability.
      if (out.data.sessionId && out.data.sessionId !== relayPump.sessionId) {
        relayCodec.reset();
        relayScreenFirstSent = false;
        log(`⇄ relay session ${out.data.sessionId.slice(0, 8)}… open — RFB codec attached`);
      }
      relayPump.sessionId = out.data.sessionId ?? relayPump.sessionId;
      relayPump.cursor = out.data.cursor;
      relayPump.lastLoggedRefusal = '';
      for (const frame of out.data.frames) {
        // THE HANDLER SEAM, NOW WIRED (ticket c468f922): the carried bytes go
        // through the RFB codec and come out as input actions this Mac can
        // execute. Before this, a received frame was acknowledged and dropped —
        // a transport with no codec above it, which is this ticket's recurring
        // defect one layer up from "the relay has no client".
        await applyRelayInput(relayCodec, frame);
      }
      if (relayPump.sessionId && !relayCodec.control.isHalted) {
        // Push one screen so the operator actually SEES the session it opened.
        // A control-only channel would be an operator driving a blank window.
        //
        // `force` only on the first frame of a session: the channel change-gates
        // identical pixels (audit F1 — the ~25 s tick must not re-push an
        // unchanged desktop as ~16-30 MB/min), but a fresh operator genuinely
        // has nothing yet.
        await sendRelayScreen(config, !relayScreenFirstSent);
        relayScreenFirstSent = true;
      }
    } else if (!isIdleRelayRefusal(out.code)) {
      // Idle refusals (no-session / not-open / stale) are the NORMAL steady
      // state on a paired Mac nobody is brokering — logging them each tick
      // would bury a real failure in noise.
      if (relayPump.lastLoggedRefusal !== out.code) {
        relayPump.lastLoggedRefusal = out.code;
        log(`⚠️  relay: ${out.code} — not carrying frames`);
      }
    } else if (relayPump.sessionId) {
      // A session we WERE serving just ended (closed or stale). Drop our
      // cursor so the next session starts clean rather than inheriting a
      // position that would skip its first frames.
      relayPump.sessionId = null;
      relayPump.cursor = 0;
      relayCodec.reset();
      log('⇄ relay session ended — RFB codec detached');
    }
  } catch {
    /* best-effort — the next tick retries */
  }

  // ── Flush anything we owe the operator ──
  while (relayOutbox.length > 0) {
    const frame = relayOutbox[0];
    const res = await postRelayFrame(config, frame.payloadB64, frame.final === true);
    if (!res.ok) {
      // Leave it queued when the refusal is transient/backpressure; drop it
      // when the session is simply not open, or the outbox would replay a dead
      // session's frames into the NEXT one.
      if (isIdleRelayRefusal(res.code)) relayOutbox.length = 0;
      break;
    }
    relayOutbox.shift();
  }
}

/**
 * Decode ONE carried payload into input actions and execute them.
 *
 * Never throws: a malformed stream halts the control channel (the codec's own
 * desync contract) and everything else is best-effort, because the caller is
 * the poll loop. A control message that cannot be executed must cost one
 * action, never the session.
 */
async function applyRelayInput(codec: RelaySessionCodec, frame: RelayFrame): Promise<void> {
  const actions = codec.control.ingest(frame.payloadB64);
  if (codec.control.isHalted) {
    log(`⚠️  relay control stream halted: ${codec.control.haltReason ?? 'unknown'}`);
    return;
  }
  for (const action of actions) {
    try {
      if (action.kind === 'pointer') {
        // Only a BUTTON PRESS executes as a click. A bare move (mask 0) is a
        // pointer position report; acting on it would fire a click per mouse
        // pixel. The coordinate space is the operator's framebuffer, which is
        // the captured screen's pixels — the same space `computer.click`
        // converts from, so a resolution mismatch is refused there rather than
        // silently mis-landing.
        if (!action.pressed) continue;
        await computer.click(action.x, action.y, (action.buttonMask & 0x04) !== 0 ? 'right' : 'left');
        continue;
      }
      if (!action.down) continue; // releases are implied by macOS's key handling
      const keyName = keysymToKeyName(action.keysym);
      const text = keysymToText(action.keysym);
      if (keyName) await computer.keyPress(keyName);
      else if (text) await computer.typeText(text);
    } catch {
      /* one bad action must not end the session */
    }
  }
}

/**
 * Capture this Mac's screen and queue it for the operator, AS REAL RFB.
 *
 * `screencapture -t bmp` rather than PNG because the codec needs raw pixels and
 * BMP is uncompressed — a bounded parser instead of an image-decoder dependency
 * on a device agent. When the capture fails (Screen Recording not granted, a
 * sleeping display) this logs ONCE per session and sends nothing: an operator
 * staring at a stale frame must be able to tell "capture is refused" from
 * "nothing has changed".
 *
 * TWO THINGS THE PUMP MUST GET RIGHT (audit F1, 2026-11-02):
 *  1. `force` on the FIRST frame of a session. The channel change-gates identical
 *     pixels, which is what stops the ~25 s tick re-pushing an unchanging
 *     desktop — but on a fresh session the operator genuinely has nothing, so
 *     the first capture must ignore the gate.
 *  2. The capture may be DOWNSCALED to fit the relay's frame budget
 *     (`RELAY_SCREEN_FRAME_BUDGET`). The operator's click coordinates are in the
 *     FITTED image's space, so the geometry primed for input must be the fitted
 *     dimensions — not the native capture's. Priming with the native size would
 *     land every click at the wrong place on any Retina display.
 */
async function sendRelayScreen(config: AgentConfig, force = false): Promise<void> {
  if (relayScreenRefused) return; // already reported this session
  try {
    const shot = await captureScreenRgba({
      run: async (args) => {
        await new Promise<void>((resolve, reject) => {
          execFile('screencapture', args, { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
        });
      },
      readFile: (p) => readFileSync(p),
      tmpPath: () => join(mkdtempSync(join(tmpdir(), 'digby-relay-')), 'screen.bmp'),
    });
    if (!shot) {
      relayScreenRefused = true;
      log('⚠️  relay screen capture produced nothing (Screen Recording refused, or an undecodable frame) — the operator sees no video this session');
      return;
    }
    const nativeW = shot.width;
    const nativeH = shot.height;
    const frames = relayCodec.screen.sendScreen(shot, (payloadB64) => queueRelayFrame(payloadB64), { force });
    const g = relayCodec.screen.geometry;

    // Audit F2: give the input path REAL geometry, or every decoded click is
    // refused. `computer.click` converts through `toPoints`, which requires a
    // primed screenshot geometry and fails LOUD rather than guessing; the relay
    // capture is not `computer.screenshot`, so nothing had primed it. The
    // operator's coordinates are in the FITTED image space, so that is what we
    // prime with.
    if (frames > 0 && g.width > 0 && g.height > 0) {
      const primed = await computer.primeScreenGeometry(g.width, g.height);
      if (!primed.ok) {
        log(`⚠️  relay input geometry refused: ${primed.error} — screen is visible but clicks will be refused rather than mis-placed`);
      }
    }

    // Log the geometry change, not every frame: a 4K screen is ~500 frames per
    // capture and a per-frame line would be its own outage.
    const geometryNote = g.width !== nativeW || g.height !== nativeH ? ` (fitted from ${nativeW}x${nativeH})` : '';
    if (frames > 0 && relayLastScreenLog !== `${g.width}x${g.height}`) {
      relayLastScreenLog = `${g.width}x${g.height}`;
      log(`⇄ relay screen ${g.width}x${g.height}${geometryNote} → ${frames} frame(s)`);
    }
  } catch {
    /* best-effort — the next tick retries */
  }
}

async function runLoop(): Promise<void> {
  // 21c68e74: the runtime heal runs ONCE per process (the steady state is a
  // plain runtime — one 64KB head read + Mach-O parse, then never again).
  let runtimeHealChecked = false;
  // TICKET 11b6974f: `let`, not `const` — the loop re-reads this from disk on
  // every poll (see the reloadConfig call at the top of the loop body). The
  // interactive subcommands (`unattended enable`, `remote-access enable`) are
  // SEPARATE processes that persist by rewriting config.json; a daemon holding
  // a startup snapshot both advertises a stale preset forever AND clobbers the
  // CLI's write on its next saveConfig.
  let config = await ensurePaired();
  if (!config) {
    console.error('Not paired. Open Digby → Account → Integrations → iMessage to get a code, then relaunch.');
    // Exit 0 so a KeepAlive(SuccessfulExit=false) LaunchAgent does not relaunch-loop.
    process.exit(0);
  }

  // ── The RUNNING-agent stamp (ticket c6e91d19) ─────────────────────────────
  // ~/.config/digby-agent/running-agent.json names THIS process: its version,
  // pid and entry path. Disk trees only prove what was downloaded; the stamp
  // is what launchd actually runs. install.sh waits on it after `launchctl
  // load` so "the command completed but the version never flipped" becomes a
  // loud failure instead of a silent one. Re-written on every relaunch and
  // after a self-update swap (the new process overwrites it).
  writeRunningAgentStamp(resolve(__dirname, 'index.js'));
  log(`ℹ️  running-agent stamp: ${AGENT_VERSION} pid ${process.pid} (${resolve(__dirname, 'index.js')})`);

  // ── 933e6ca4 + 405927c9: retire every non-self-managed install ────────────
  // A stale ai.digby.imessage-agent plist (the .app-bundled helper OR the
  // /Library/Digby .pkg install) polls beside us with the SAME token — the
  // stored agentVersion flaps and the web card's update hint never clears,
  // and neither install shape can ever self-update. Best-effort, one log
  // line, never fatal (see retire-bundled-helper.ts). If WE are the bundled
  // helper or the .pkg agent ourselves, retireBundledHelper refuses — those
  // installs are the app's/.pkg's own supported paths (reviewer blocker 1,
  // and the .pkg yields rather than counter-retires).
  try {
    const r = retireBundledHelper();
    if (r.self) {
      log('ℹ️  running as a bundled/.pkg install — leaving other Digby installs alone');
    } else if (r.retired) {
      log('♻️  stopped a stale Digby install (its launchd plist is removed so it cannot come back at login)');
    } else if (r.present) {
      log(`ℹ️  found an ${BUNDLED_AGENT_LABEL} launchd job (${r.program || 'unknown program'}) — not a retireable install shape, left in place`);
    }
  } catch { /* never fatal */ }
  // The re-retire clock starts HERE: the startup retire just ran, so the
  // periodic re-check (idle loop, below) is one full window after it.
  _stampRetireCheck(nowMs());

  // ── Full Disk Access: guidance, but NEVER a hard gate (ticket 2f646c10) ──
  // Pre-0.6.0 the agent showed the dialog and exited 90s later, looping on
  // relaunch while FDA was missing — it never polled, so the backend could
  // never see its own broken state and the card just said "offline". Now the
  // guidance (dialog + System Settings + Finder reveal) still fires once, but
  // the agent PROCEEDS into the poll loop: the fda:0 advert reaches the card,
  // which live-updates the checklist as the user grants each permission (the
  // FDA probe is re-run on a 15s TTL inside computePermissionStatus). iMessage
  // reads fail with a clear permission error until the grant lands.
  // ── Permissions at startup: onboarding once per binary, then a quiet nudge ──
  // v0.6.3: firstLaunchOnboarding fires the native prompts + ONE checklist the
  // first time this helper binary runs (and after an update). On later
  // launches only Full Disk Access gets the pane + Finder reveal when it is
  // missing (no dialog — the card carries the live checklist). Never a gate
  // (ticket 2f646c10): the poll loop always runs, the fda:0 advert reaches the
  // card, and iMessage reads fail with a clear permission error until granted.
  const onboarded = await firstLaunchOnboarding(config).catch(() => false);
  const access = checkAccess();
  if (!access.ok) {
    log(`⚠️  Full Disk Access missing — iMessage reads are disabled until it is granted (${access.error})`);
    log('   The Digby integrations card shows the exact steps; they update live as you grant them.');
    if (!onboarded) openFullDiskAccessGuidance();
  } else {
    log(`Digby iMessage agent v${AGENT_VERSION} started. Linked to ${config.apiBaseUrl}`);
  }
  // One-time local-browser setup in the background: the agent ships the
  // Playwright package but NOT the ~170MB Chromium binary — fetch it now so
  // the first browser_* command usually finds it ready. Best-effort: the
  // iMessage bridge must keep working even if this fails (no network, etc.).
  browser.ensureChromium().catch((e) => log(`⚠️  background Chromium setup failed (browser commands will retry on demand): ${e?.message || e}`));

  // e2915963: the FIRST successful poll of this process snapshots the TCC
  // baseline (what was granted when we started). Later polls compare against
  // it: a previously-true ax/sr/fda reading false is a REGRESSION — the
  // class the 0.9.4→0.9.6 runtime swap produced on 2026-10-24 (grants attach
  // to the exact file; the swap's new inode orphans them silently).
  let tccBaseline: { ax?: boolean; sr?: boolean; fda?: boolean } | null = null;
  let runtimeSwapCause: string | null = null;
  // Surfaced regression set (joined keys) — one surfacing per regression
  // episode, re-armed when the grants heal (see the loop).
  let lastRegressionKey: string | null = null;

  // ── Post-update TCC preflight (c44b19e9) ───────────────────────────────────
  // ONE preflight per process, exactly once, before the first poll — the
  // successor of a self-update / runtime swap attributes every lost grant
  // in ONE consolidated event. NON-REQUESTING ONLY: the grant state comes
  // from the permissions preflight (AXIsProcessTrusted / JXA CGPreflight /
  // sqlite FDA check / capture-truth latch — the 0.9.8 backoff-gated probe
  // class), plus calendarAuthStatus() (authorizationStatusForEntityType —
  // the status API, never a request; it can NEVER raise a consent dialog).
  // NO path here calls probeScreenRecording() / requestAccessibilityPrompt()
  // / a read: the 0.9.8 invariant, pinned by the c44b19e9 suite.
  let postUpdatePreflightDone = false;
  // Unattended-preset drift surfacing (2026-10-28): the last advert we logged,
  // so a reverted setting is logged ONCE per flip (never every 25s poll).
  let lastUnattendedAdvert = '';
  // Brokered-remote-access drift surfacing (ticket c468f922, owner ruling
  // 2026-10-29): the last advert we logged, so an exposure/drift flip is logged
  // ONCE per change (never every 25 s poll).
  let lastRemoteAccessAdvert = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // TICKET 11b6974f: re-read the config EVERY poll. The interactive
    // subcommands are separate processes writing config.json (that is how
    // `unattended enable` / `remote-access enable` persist an owner's choice);
    // without this the running daemon re-advertised its startup snapshot
    // forever, so a freshly enabled preset never reached the fleet. Cheap: one
    // stat + read of a small file per 25 s poll.
    config = reloadConfig(config);
    let permissions: PermissionStatus | null = null;
    try {
      permissions = await computePermissionStatus();
    } catch {
      permissions = null; // advertise nothing rather than a wrong guess
    }
    // ── Post-update TCC preflight (ticket c44b19e9, agent 0.9.9) ──
    // Runs ONCE per process, right after the first permission computation.
    // The successor of a self-update checks the ENTIRE surface in one shot:
    // the ax/sr/fda advert regressions the loop already computes, PLUS the
    // Calendars loss the e2915963 seams never saw (the status-only EventKit
    // authorization query). Never requesting; never in a loop (the runtime-
    // swap stamp is consumed on read).
    if (!postUpdatePreflightDone) {
      postUpdatePreflightDone = true;
      try {
        const swap = readRuntimeSwapStamp();
        const calStatus = await calendarAuthStatus();
        // The post-update grant set: the ax/sr/fda regressions against the
        // predecessor's last-advertised grants, plus the Calendars loss —
        // pure, unit-pinned (preflightGrants). calStatus === null (the
        // status query itself failed) contributes nothing — an unknown
        // never fabricates a loss.
        const missing = preflightGrants(
          (config as any)?.lastAdvertisedPermissions,
          // 30d3c366: the Input Monitoring reading joins the comparison. It is
          // the NON-REQUESTING CGPreflightListenEventAccess result, mapped from
          // PermissionStatus.inputMonitoring onto the wire key `im`. Undefined
          // (the bridge could not answer) contributes nothing — the c44b19e9
          // unknown-never-convicts rule.
          {
            ax: permissions?.ax ?? false,
            sr: permissions?.sr ?? false,
            fda: permissions?.fda ?? false,
            ...(permissions?.inputMonitoring !== undefined ? { im: permissions.inputMonitoring } : {}),
          },
          calStatus,
          // Automation has no status-only query (TCC exposes none), so the
          // only truthful source is a REAL AppleEvent outcome: the latch set
          // by a denied front_window probe. null = no evidence either way.
          lastAutomationDenial() ? false : null,
        );
        const cause = preflightCauseFromSwap(swap, AGENT_VERSION);
        const event = buildTccReGrantNeeded(missing, cause);
        if (event) {
          // Seed the watchdog episode with the preflight's findings so the
          // call-time surfacings do not re-push the same grants (ONE
          // episode; the poll param + card stay up until heal).
          openTccEpisode = [...event.grants];
          surfacedReGrantKey = regrantEpisodeKey(event.grants);
          surfaceTccReGrant(event);
        }
        // The stamp is NOT consumed here: the e2915963 block below reads it
        // in THIS same iteration (first poll) and owns the consume — its
        // attribution dialog + baseline seeding must keep working; the
        // consolidated card above names the full set (ax/sr/fda/cal). NOTE
        // (review D2): a SELF-UPDATE tree-swap successor has NO stamp (only
        // the runtime heal writes one) — its cause stays null ("cause
        // unknown"), which is correct attribution, and this log still fires.
        log(
          swap
            ? `♻️  post-update TCC preflight after the ${swap.swappedAt} runtime swap: ${missing.length} grant(s) need re-making (c44b19e9).`
            : `♻️  post-update TCC preflight: ${missing.length} grant(s) lost${cause ? ` (${cause})` : ' — cause unknown (self-update tree swap leaves no stamp; that is expected)'} (c44b19e9).`,
        );
      } catch { /* best-effort: a failed preflight never breaks the loop */ }
    }
    // ── Permission-regression surfacing (ticket e2915963) ──
    // Compare the CURRENT TCC state to this process's baseline. Only a
    // BEFORE-true → now-false flip counts (a never-granted permission is a
    // pre-existing gap the onboarding flow owns, not a regression). The
    // pending runtime-swap stamp attributes the cause when the agent itself
    // just swapped its runtime binary; read it ONCE (it is consumed — the
    // swap that wrote it is this process's predecessor).
    if (permissions) {
      // Persist the last-advertised grants on CHANGE only (a write per poll
      // would hammer the config file every 25 s): a successor process seeds
      // its regression baseline from this (review F6 — the swap restarts us,
      // so the regression spans processes).
      const prevAdvert = (config as any).lastAdvertisedPermissions as
        { ax: boolean; sr: boolean; fda: boolean; cal?: boolean; im?: boolean; ae?: boolean; at: string } | undefined;
      if (
        !prevAdvert ||
        prevAdvert.ax !== permissions.ax ||
        prevAdvert.sr !== permissions.sr ||
        prevAdvert.fda !== permissions.fda ||
        prevAdvert.cal !== permissions.calendar ||
        // 30d3c366: the two ticket grants ride the same baseline-change test.
        prevAdvert.im !== permissions.inputMonitoring
      ) {
        try {
          saveConfig({
            ...config,
            // c44b19e9: cal rides the persisted baseline so a successor
            // process's post-update preflight can see a LOST Calendars
            // grant (the e2915963 ax/sr/fda set alone cannot).
            // 30d3c366: im rides it for the same reason — the ticket's own
            // grants must be comparable across the self-update boundary.
            lastAdvertisedPermissions: {
              ax: permissions.ax, sr: permissions.sr, fda: permissions.fda,
              ...(permissions.calendar !== undefined ? { cal: permissions.calendar } : {}),
              ...(permissions.inputMonitoring !== undefined ? { im: permissions.inputMonitoring } : {}),
              // `ae` is persisted from the LAST KNOWN state: the automation
              // latch only ever reports a loss, so a stamped denial records
              // false and an untroubled run records nothing new (the prior
              // true, if any, survives via the spread of the previous value).
              ...(lastAutomationDenial() ? { ae: false }
                : (prevAdvert as any)?.ae !== undefined ? { ae: (prevAdvert as any).ae } : {}),
              at: new Date().toISOString(),
            },
          } as AgentConfig);
        } catch { /* best-effort persistence */ }
      }
      if (!tccBaseline) {
        tccBaseline = { ax: permissions.ax, sr: permissions.sr, fda: permissions.fda };
        const swap = readRuntimeSwapStamp();
        if (swap) {
          runtimeSwapCause = `runtime binary swapped ${swap.swappedAt}`;
          clearRuntimeSwapStamp();
          log(`♻️  this process started from a runtime swap performed at ${swap.swappedAt} — watching the TCC grants for a regression (e2915963).`);
          // Review F6: the swap RESTARTED us, so the regression can span
          // processes — this successor's first read is already post-swap.
          // Seed the comparison from the PREDECESSOR's last-advertised
          // grants (the config's permissionsOnboarded stamp is rewritten on
          // every successful onboarding of the binary that had them), so a
          // swap that orphaned a grant is caught by the agent half too, not
          // only by the backend's stored-advertisement seam.
          const prev = (config as any)?.lastAdvertisedPermissions as
            { ax?: boolean; sr?: boolean; fda?: boolean } | undefined;
          if (prev && typeof prev === 'object') {
            const seeded = whichPermissionsRegressed(prev, permissions);
            // c44b19e9 T1 (follow-up review): if the consolidated re-grant
            // episode ALREADY covers this swap's lost grants, the
            // e2915963-seam dialog is suppressed — ONE incident, ONE Mac
            // dialog (the consolidated card names every grant + the
            // relaunch line; the older dialog would add a second).
            if (seeded.length > 0 && !regressionCovered(seeded, openTccEpisode)) {
              lastRegressionKey = seeded.join(',');
              surfacePermissionRegression(seeded, runtimeSwapCause);
            }
          }
        }
      } else {
        const regressed = whichPermissionsRegressed(tccBaseline, permissions);
        if (regressed.length > 0) {
          // Surface ONCE per regression set (the dialog would otherwise
          // re-fire on every 25 s poll while the grant is missing).
          // c44b19e9 T1 (follow-up review): a regression the consolidated
          // re-grant episode already covers is suppressed here — the
          // consolidated card IS the surfacing for it (one dialog, not two).
          const key = regressed.join(',');
          if (lastRegressionKey !== key && !regressionCovered(regressed, openTccEpisode)) {
            lastRegressionKey = key;
            surfacePermissionRegression(regressed, runtimeSwapCause);
          }
        } else {
          lastRegressionKey = null; // healed — a future regression re-surfaces
        }
      }
    }
    // ── c44b19e9: reconcile the watchdog episode from REAL outcomes ──
    // 30d3c366: drain the Automation-denial latch FIRST — a -1743 stamped at a
    // real front_window call is a grant loss, so it joins the open episode
    // exactly like a classified command denial does (one episode, one card).
    if (lastAutomationDenial()) {
      noteTccDenial({ kind: 'automation-denied' });
      clearAutomationDenial();
    }
    // Heals come from the latches (a successful calendar read or capture —
    // the same signals that feed the advert), never from a probe: a healed
    // grant drops out of the open episode; an EMPTY episode after a heal
    // releases the poll param (the card clears with the next poll). The
    // surfaced key stays until the set CHANGES (more grants lost → one
    // fresh surfacing) or empties (the episode healed — re-armed).
    if (openTccEpisode.length > 0) {
      if (calendarAdvert() === true) openTccEpisode = openTccEpisode.filter((g) => g !== 'cal');
      if (lastCaptureTruth() === true) openTccEpisode = openTccEpisode.filter((g) => g !== 'sr');
      // FDA heal: a real chat.db open succeeding (checkAccess is the
      // status-only sqlite probe the advert itself uses — never a request).
      try { if (checkAccess().ok) openTccEpisode = openTccEpisode.filter((g) => g !== 'fda'); } catch { /* unknown — keep */ }
      // 30d3c366: NO auto-heal for 'ae'. The only positive Automation signal
      // this agent has is a successful front_window probe, which runs inside a
      // capture — deriving a heal from "no denial latched" would heal the
      // episode on the very poll after it opened (the latch is drained above).
      // A restored Automation grant therefore clears when the owner re-grants
      // and the agent relaunches (the card's own instruction), not by guess.
      if (openTccEpisode.length === 0 && surfacedReGrantKey !== null) {
        surfacedReGrantKey = null; // episode fully healed — the card clears
        log('✅ TCC re-grant episode healed (c44b19e9) — the next grant loss re-arms the consolidated card.');
      } else if (openTccEpisode.length > 0) {
        const key = regrantEpisodeKey(openTccEpisode);
        if (surfacedReGrantKey !== key) {
          // A NEW grant joined the open episode (more lost than the first
          // surfacing named) — surface ONCE for the new set, then update.
          const event = buildTccReGrantNeeded(openTccEpisode, WATCHDOG_CAUSE);
          if (event) surfaceTccReGrant(event);
          surfacedReGrantKey = key;
        }
      }
    }
    try {
      // "Unattended / Autonomous use" preset advert (2026-10-28, owner request
      // oq_f7955582): the agent re-reads every setting the preset owns on EVERY
      // poll — that IS the drift detector (a macOS update silently resets
      // auto-login; the fleet must see "unattended-ready: NO — <reason>"
      // instead of a lane discovering a lock screen hours later). '' when the
      // preset is off (opt-in, off by default) → the param is omitted entirely.
      let unattendedAdvert = '';
      try {
        const prevEnabled = !!config.unattended?.enabled;
        const snap: MacUnattendedSnapshot = await probeMacUnattended(realMacIo, {
          user: config.unattended?.backup?.user || process.env.USER || '',
          enabled: prevEnabled,
        });
        unattendedAdvert = unattendedAdvertValue(snap);
        // Log a drift/flip ONCE per changed verdict, never per poll.
        const verdictKey = unattendedAdvert || 'off';
        if (verdictKey !== lastUnattendedAdvert) {
          lastUnattendedAdvert = verdictKey;
          const v = evaluateMacUnattended(snap);
          if (v.enabled && v.blockers.length > 0) {
            log(`⚠️  unattended-ready: NO — ${v.blockers.map((b) => BLOCKER_TEXT[b]).join('; ')}`);
          } else if (v.enabled) {
            log('✅ unattended-ready: YES (auto-login + no lock + no sleep all hold)');
          }
        }
      } catch { /* the advert is best-effort — never break the poll */ }
      // ── BROKERED REMOTE ACCESS advert (ticket c468f922, OWNER RULING 2026-10-29:
      // "can we do option three but a little more secure like how it's just like
      // TeamViewer") ──
      // Re-probed on EVERY poll, because a macOS update resets
      // ALLOW_SCREENSHARING and a policy reset can drop the PF anchor — the
      // fleet must SEE "exposed" instead of a lane discovering a public VNC
      // port later.
      //
      // `off` is advertised from a LIVE PROBE, not from config (owner ruling
      // 2026-10-30, health-line item 2). A user who ticks "Screen Sharing" in
      // System Settings by hand has a listener the config knows nothing about;
      // asking the OS means that case surfaces as `on`+`exposed` instead of
      // silently reading "off". A probe that cannot tell emits nothing, so
      // absent-never-clobbers still holds.
      // remoteAccessAdvertValue() emits ONLY closed-vocabulary tokens: the
      // dedicated VNC password has no field to ride here.
      let remoteAccessAdvert = '';
      try {
        const listener = config.remoteAccess?.enabled ? true : await probeMacRemoteListener(realMacRemoteIo);
        if (listener === true) {
          const snap = await probeMacRemoteAccess(realMacRemoteIo, {
            tunnelBound: config.remoteAccess?.tunnelOnly === true,
            tunnelInterface: config.remoteAccess?.tunnelInterface || 'utun',
          });
          const verdict = evaluateMacRemoteAccess(snap);
          remoteAccessAdvert = remoteAccessAdvertValue({
            enabled: verdict.enabled,
            tunnelOnly: config.remoteAccess?.tunnelOnly === true,
            blockers: verdict.blockers,
            off: !verdict.enabled,
          });
          // Log a flip ONCE per changed verdict, never per poll.
          if (remoteAccessAdvert !== lastRemoteAccessAdvert) {
            lastRemoteAccessAdvert = remoteAccessAdvert;
            if (verdict.blockers.length > 0) {
              log(`⚠️  remote-access: NOT ready — ${verdict.blockers.join('; ')} (run \`${MAC_AGENT_CLI_QUOTED} remote-access status\`)`);
            } else if (verdict.enabled) {
              log('✅ remote-access: ready (tunnel-scoped, dedicated credential, designated account only)');
            } else {
              log('✅ remote-access: off — nothing is listening (the default; opt in per device to enable)');
            }
          }
        } else if (listener === false) {
          remoteAccessAdvert = remoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [], off: true });
          if (remoteAccessAdvert !== lastRemoteAccessAdvert) {
            lastRemoteAccessAdvert = remoteAccessAdvert;
            log('✅ remote-access: off — nothing is listening (the default; opt in per device to enable)');
          }
        }
      } catch { /* the advert is best-effort — never break the poll */ }
      // c44b19e9: while a grant-loss episode is OPEN, the poll carries the
      // joined grant set (`regrant=cal,sr` — sorted, URL-encoded) so the
      // backend surfaces the ONE consolidated owner card and keeps the
      // Integrations card's checklist red until the heal clears it. The key
      // CHANGES only when the set changes (one card per episode-shape).
      const { command, update } = await pollCommand(
        config,
        permissions,
        openTccEpisode.length > 0 ? regrantEpisodeKey(openTccEpisode) : null,
        unattendedAdvert || null,
        remoteAccessAdvert || null,
      );
      // ── Self-heal after an app update (ticket 2f646c10) ──
      // The poll above RESOLVED with the relaunch advert already persisted
      // server-side (touchAgent ran on the request), so exiting here never
      // loses it. When the .app bundle was swapped under us the running
      // DigbyHelper is a ghost from the deleted bundle — its TCC grants no
      // longer apply. Exit 1; launchd's KeepAlive (ThrottleInterval 10s)
      // restarts from the CURRENT bundle, which re-evaluates TCC and starts
      // advertising the true state.
      if (bundleReplaced()) {
        log('♻️  Digby.app was updated — this helper is from the replaced bundle. Restarting from the new one (the card will re-check permissions).');
        process.exit(1);
      }
      // This poll succeeded → this binary is alive and talking to the backend.
      // If it is the pending self-update, confirm it so the rollback watchdog
      // stands down (ticket 4e75cdea).
      noteHealthyPoll();

      // ── RELAY PUMP (ticket c468f922) ──
      // Runs after every successful poll so a brokered session carries frames
      // on the same ~25 s beat the command channel uses. Best-effort and fully
      // self-contained: `pumpRelay` swallows its own failures, because losing the
      // relay must never cost this Mac the command channel that repairs it.
      await pumpRelay(config);

      // ── Periodic re-retire (ticket c6e91d19) ──────────────────────────────
      // The startup retire (above) runs ONCE per process; the desktop app's
      // one-click "Set up iMessage on this Mac" can re-register the bundled
      // helper's launchd job at ANY later moment (the served app predates the
      // 549cef000 guard), after which a stale 0.6.3 helper polls beside us
      // with the SAME token — the exact stuck-version report. Re-check the
      // retireable plist on an interval. This runs right after a successful
      // poll whether or not a command came back: retireBundledHelper only
      // boots/removes the ai.digby.imessage-agent job (never our own label),
      // spawns one bounded launchctl and never touches the in-flight command,
      // so it cannot interrupt mid-task work. Cheap (one stat + read of a
      // small plist every 5 min), best-effort, never fatal. (Review A-1:
      // comment corrected to match the code.)
      if (reRetireDue(nowMs())) {
        _stampRetireCheck(nowMs());
        try {
          const r = retireBundledHelper();
          if (r.retired) {
            log(`♻️  re-retired a stale Digby install that came back (${r.program || 'unknown program'}) — its launchd plist is removed again`);
          }
        } catch { /* never fatal */ }
      }
      if (!command) {
        // ── Self-update (ticket 4e75cdea) ──
        // The backend advertises a release only to an agent older than it.
        // Act on the advert ONLY while idle (no command in hand — a dispatched
        // task must never have its helper swapped mid-flight). trySelfUpdate
        // re-checks every gate (kill switch, sha256 pin, self-managed install,
        // retry backoff); on success it swaps the tree, arms the rollback
        // watchdog and we exit 1 so launchd relaunches the NEW binary — the
        // same idiom permission_relaunch uses. A skip/failure just logs and
        // keeps polling (the agent never dies of a failed update).
        if (update) {
          const agentRoot = join(__dirname, '..');
          const r = await trySelfUpdate(update, agentRoot);
          if (r.outcome === 'applied') {
            log(`⬆️  Self-updated to agent v${r.version} (prior tree kept at ${r.backupDir}) — restarting into it.`);
            process.exit(1);
          }
          if (r.outcome === 'failed') log(`⚠️  self-update to ${update.version} failed: ${r.reason}`);
          // 'skipped' is quiet by design (backoff/dev-tree gates fire hourly).
        }
        // ── Self-contained runtime heal (ticket 21c68e74) ──
        // Once per process, while idle: when the launchd runtime
        // (~/…/Digby/bin/DigbyAgent) is a keg-coupled Homebrew copy it is
        // one `brew upgrade`/`cleanup` away from the ticket's dyld
        // crash-loop. Try replacing it with the official self-contained
        // build of the SAME node version (sha-verified + selftested under
        // the new binary BEFORE the swap — runtime-dylib.ts). 'healed'
        // exits 1 so launchd relaunches from the fixed runtime (the
        // self-update idiom); a skip just logs and keeps polling.
        if (!runtimeHealChecked) {
          runtimeHealChecked = true;
          try {
            const heal = await healRuntimeIfCoupled();
            if (heal.outcome === 'healed') {
              log(`♻️  replaced the keg-coupled DigbyAgent runtime with an official self-contained Node (${heal.to}) — restarting into it.`);
              process.exit(1);
            }
            if (heal.outcome === 'skipped') log(`⚠️  runtime heal skipped: ${heal.reason}`);
          } catch { /* never fatal */ }
        }
        continue; // poll window elapsed with no work — poll again
      }
      log(`→ command ${command.method} (${command.cmdId})`);
      try {
        const result = await execute(command);
        // c44b19e9 (review D3): computer-use permission denials come back as
        // {ok:false, error} OBSERVATIONS (computer.ts never throws them), so
        // the watchdog must classify the RESULT's error text too — this is
        // the path the 33401f39 solid-capture conviction (SR) and the
        // Accessibility block actually arrive on. A result without an error
        // string classifies null and adds nothing.
        const r = result as { ok?: boolean; error?: string } | null;
        if (r && typeof r === 'object' && r.ok === false && typeof r.error === 'string') {
          noteTccDenial(denialFromErrorText(r.error));
        }
        await postResult(config, command.cmdId, true, result);
        log(`✓ ${command.method} done`);
      } catch (e: any) {
        // c44b19e9: a command error whose text convicts a TCC grant feeds the
        // watchdog (the classification is exact-marker; a non-permission
        // error classifies null and adds nothing).
        const denial = denialFromErrorText(e?.message || String(e));
        if (denial) noteTccDenial(denial);
        await postResult(config, command.cmdId, false, undefined, e?.message || String(e));
        log(`✗ ${command.method} failed: ${e?.message || e}`);
      }
    } catch (e: any) {
      if (e?.message === 'UNAUTHORIZED') {
        log('✗ Agent token rejected (unpaired or revoked) — clearing config to re-pair.');
        clearConfig();
        osascriptNotify(
          'Digby disconnected this Mac. Reconnect from Digby → Account → Integrations → iMessage.',
        ).catch(() => {});
        process.exit(1); // relaunch → ensurePaired() prompts for a fresh code
      }
      // Network blip / backend restart — back off and retry.
      await sleep(5000);
    }
  }
}

async function pair(): Promise<void> {
  // Non-interactive path used by the one-line installer: code/URL via env vars.
  const envCode = (process.env.DIGBY_PAIR_CODE || '').trim();
  if (envCode) {
    const apiBaseUrl = (process.env.DIGBY_API_URL || '').trim() || DEFAULT_API_BASE;
    const { agentId, agentToken } = await pairWithPermissions(apiBaseUrl, envCode);
    saveConfig({ apiBaseUrl, agentId, agentToken, deviceId: getDeviceId() });
    console.log(`\n✓ Paired as "${hostname()}". Config saved to ${configPath()}`);
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const existing = loadConfig();
    const apiDefault = existing?.apiBaseUrl || DEFAULT_API_BASE;
    const apiBaseUrl =
      (await rl.question(`Digby API base URL [${apiDefault}]: `)).trim() || apiDefault;
    const code = (await rl.question('Pairing code (from Digby → Account → Integrations): ')).trim();
    if (!code) {
      console.error('No pairing code entered.');
      process.exit(1);
    }
    const { agentId, agentToken } = await pairWithPermissions(apiBaseUrl, code);
    const config: AgentConfig = { apiBaseUrl, agentId, agentToken, deviceId: getDeviceId() };
    saveConfig(config);
    console.log(`\n✓ Paired as "${hostname()}". Config saved to ${configPath()}`);
    console.log('  Start the agent with:  digby-agent run');
    console.log('  (or install it as a background service — see README.md)');
  } catch (e: any) {
    console.error(`Pairing failed: ${e?.message || e}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

/**
 * `digby-agent unattended <status|enable|disable>` — the macOS preset CLI
 * (2026-10-28, owner request on card oq_f7955582).
 *
 * SECURITY POSTURE, enforced by this function's shape:
 *   - the account password is read from the LOCAL terminal (never argv, never
 *     an env var, never the pairing config, never the network) and is used
 *     exactly once to write /etc/kcpassword;
 *   - `enable` captures the pre-change values into the config BEFORE changing
 *     anything, so `disable` can always restore them;
 *   - nothing here ever prints the password.
 */
async function unattendedCli(argv: string[]): Promise<void> {
  const sub = (argv[0] || 'status').toLowerCase();
  const config = loadConfig();
  const user = process.env.USER || '';
  const enabled = !!config?.unattended?.enabled;

  if (sub === 'status') {
    const snap = await probeMacUnattended(realMacIo, { user: config?.unattended?.backup?.user || user, enabled });
    const v = evaluateMacUnattended(snap);
    console.log(`Unattended preset: ${v.enabled ? 'ENABLED' : 'OFF (opt-in, per device)'}`);
    console.log(`Unattended-ready:  ${v.enabled && v.blockers.length === 0 ? 'YES' : 'NO'}`);
    if (v.blockers.length > 0) {
      for (const b of v.blockers) console.log(`  - ${b}: ${BLOCKER_TEXT[b]}`);
    }
    console.log(`fileVault=${snap.fileVaultOn} autoLoginUser=${snap.autoLoginUser ?? '(none)'} ` +
      `askForPassword=${snap.askForPassword} idleTime=${snap.idleTime} ` +
      `pmsetSleep=${snap.sleepMinutes} powerNap=${snap.powerNap} ` +
      `fus=${snap.fastUserSwitching} pwdExpires=${snap.passwordExpires} atLoginScreen=${snap.atLoginScreen}`);
    console.log('Nothing was changed (status is read-only).');
    return;
  }

  if (sub === 'enable') {
    if (!config) {
      console.error(`Not paired — run \`${MAC_AGENT_CLI_QUOTED} pair\` first (the fleet can only see a paired device).`);
      process.exit(1);
    }
    const loginUser = (argv[1] || user).trim();
    console.log(`Enabling the unattended preset for "${loginUser}".`);
    console.log('This LOWERS this Mac\'s security while it is enabled: anyone with physical access to the');
    console.log('unlocked machine can use it, and the account password is kept on disk in /etc/kcpassword');
    console.log('(root-only, obfuscated — loginwindow must read it before any session exists).');
    console.log(`\`${MAC_AGENT_CLI_QUOTED} unattended disable\` restores every prior setting.`);
    // TICKET bcdf5d2f: obtain administrator rights FIRST, before asking for
    // anything else. REVIEW FINDING (B-3): the account-password prompt used to
    // run first, so an owner who then cancelled or failed the sudo prompt had
    // already typed their password for nothing — after being told the order was
    // the other way round. Escalating first means the one step that can fail on
    // permissions fails BEFORE anything is typed, and a refusal costs nothing.
    const admin = await ensureAdminRights(realMacIo);
    if (!admin.ok) {
      console.error(`\n✗ Cannot enable on this Mac — ${admin.message}`);
      process.exit(2);
    }
    // Say what the ONE remaining prompt is, before it appears. The old flow was
    // silent about it — the first sign was an opaque refusal ("run it in a
    // terminal where sudo is already authorised", which asked the user to know
    // about `sudo -v`) or a password prompt they did not expect, which is where
    // a non-technical owner stops and assumes they are being phished.
    console.log('');
    console.log('Now your Mac password once more, hidden this time: Digby needs it on this Mac');
    console.log('so the machine can sign in at startup (/etc/kcpassword). It is never sent to');
    console.log('Digby, and `unattended disable` removes it.');
    console.log('');
    // The password prompt: hidden input on the LOCAL tty. Never argv/env.
    const password = await readSecret('macOS account password (input hidden, used once for /etc/kcpassword): ');
    if (!password) {
      console.error('No password entered — nothing was changed.');
      process.exit(1);
    }
    try {
      const r = await applyMacPreset(realMacIo, { user: loginUser, password, loginUser });
      saveConfig({ ...config, unattended: { enabled: true, backup: r.backup, enabledAt: new Date().toISOString() } });
      console.log(`\n✓ Applied: ${r.applied.join(', ')}`);
      if (r.skipped.length) console.log(`⚠️  Skipped: ${r.skipped.join(', ')}`);
      console.log('The agent now advertises `unattended=on,ok` (or the blocker it finds) on every poll,');
      console.log('so the fleet shows this device as UNATTENDED-READY instead of filing an unlock card.');
    } catch (e: any) {
      if (e instanceof UnattendedRefusal) {
        console.error(`\n✗ Cannot enable on this Mac — ${e.message}`);
        process.exit(2);
      }
      throw e;
    } finally {
      // Do not leave the password in a live binding longer than the write.
      // (JS strings are immutable; this only drops the reference.)
    }
    return;
  }

  if (sub === 'disable') {
    if (!config) {
      console.error('Not paired — nothing to disable.');
      process.exit(1);
    }
    const backup = config.unattended?.backup;
    if (!backup) {
      console.error('No captured pre-change values — the preset was never applied from this Mac. Nothing changed.');
      process.exit(1);
    }
    const r = await revertMacPreset(realMacIo, backup);
    saveConfig({ ...config, unattended: { enabled: false, backup } });
    console.log(`\n✓ Restored: ${r.reverted.join(', ')}`);
    console.log('The preset is OFF — this Mac now locks and sleeps normally, and the fleet shows');
    console.log('unattended-ready: NO (preset not enabled).');
    return;
  }

  console.log('Usage: digby-agent unattended <status|enable [loginUser]|disable>');
  process.exit(1);
}

/**
 * `digby-agent remote-access <status|enable|disable>` — the BROKERED REMOTE
 * ACCESS CLI (ticket c468f922, OWNER RULING 2026-10-29 on card oq_b5118c38:
 * "can we do option three but a little more secure like how it's just like
 * TeamViewer").
 *
 * WHAT IT DOES: provisions the OS's OWN remote channel (macOS Screen Sharing,
 * driven by ARDAgent's `kickstart`) under the hardened posture — PF anchor
 * scoping 5900 to the tunnel BEFORE the service can listen, a DEDICATED VNC
 * password (never the account password), and access limited to the designated
 * account rather than -allUsers.
 *
 * SECURITY POSTURE, enforced by this function's shape:
 *   - the VNC password is read from the LOCAL terminal (never argv, never an
 *     env var, never the config, never the network) and is handed to
 *     `kickstart` exactly once. `kickstart` accepts it ONLY in argv, so it is
 *     briefly visible in `ps` — documented in remote-access.ts, and the reason
 *     the credential must be dedicated: a stolen VNC password grants
 *     VNC-through-the-firewall, never the account.
 *   - `enable` writes the NON-SECRET facts (account, tunnel interface) to the
 *     config so the poll can advertise and `disable` can revoke. The password
 *     itself is NEVER stored by us — macOS owns it in
 *     /Library/Preferences/com.apple.VNCSettings.txt.
 *   - `disable` is a VERIFIED revoke: it re-reads the flag, the credential file
 *     and the PF anchor, and reports anything that survived rather than
 *     printing "done".
 *   - nothing here ever prints the password (runMacRemotePlan withholds the
 *     argv of any step carrying it).
 */
async function remoteAccessCli(argv: string[]): Promise<void> {
  const sub = (argv[0] || 'status').toLowerCase();
  const config = loadConfig();
  const enabled = !!config?.remoteAccess?.enabled;
  const iface = config?.remoteAccess?.tunnelInterface || 'utun';

  if (sub === 'status') {
    const snap = await probeMacRemoteAccess(realMacRemoteIo, {
      tunnelBound: config?.remoteAccess?.tunnelOnly === true,
      tunnelInterface: iface,
    });
    const v = evaluateMacRemoteAccess(snap);
    console.log(`Brokered remote access: ${v.enabled ? 'ENABLED' : 'OFF (opt-in, per device)'}`);
    console.log(`Remote-ready:           ${v.enabled && v.blockers.length === 0 ? 'YES' : 'NO'}`);
    for (const b of v.blockers) console.log(`  - ${b}`);
    console.log(`screenSharing=${snap.screenSharingEnabled} vncCredential=${snap.vncCredentialPresent} ` +
      `firewall=${snap.firewallEnabled} scopedToTunnel(${iface})=${snap.firewallScopedToTunnel} ` +
      `tunnelBound=${snap.tunnelBound} account=${config?.remoteAccess?.account ?? '(none)'}`);
    console.log('Nothing was changed (status is read-only).');
    return;
  }

  if (sub === 'enable') {
    // Fail fast BEFORE touching anything: the privileged steps below need root,
    // and a user-session run would otherwise produce a wall of per-command
    // failures instead of the one actionable fact.
    const refusalUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    // Two distinct refusals, and the pairing one narrows `config` for the
    // saveConfig() below — never fold them back into one branch.
    if (!config) {
      console.error(privilegedRunRefusal({ uid: refusalUid, paired: false }));
      process.exit(1);
    }
    const refusal = privilegedRunRefusal({ uid: refusalUid, paired: true });
    if (refusal) {
      console.error(refusal);
      process.exit(1);
    }
    const account = (argv[1] || process.env.USER || '').trim();
    const tunnelInterface = (argv[2] || 'utun').trim();
    if (!account) {
      console.error('Usage: digby-agent remote-access enable <account> [tunnelInterface]');
      process.exit(1);
    }
    console.log(`Enabling BROKERED remote access (Screen Sharing) for account "${account}",`);
    console.log(`firewalled to the tunnel interface "${tunnelInterface}".`);
    console.log('');
    console.log('This ENABLES a listening service on this Mac. The protections are:');
    console.log(`  - the PF anchor allows port 5900 ONLY on ${tunnelInterface} and drops it everywhere else`);
    console.log('    (macOS cannot bind Screen Sharing to one interface — the firewall is the boundary);');
    console.log('  - a DEDICATED VNC password, NOT your account password (a stolen VNC password cannot');
    console.log('    unlock the account);');
    console.log(`  - access limited to "${account}" only (never all users).`);
    console.log('It does NOT let the Digby agent type at the login window on its own.');
    console.log(`\`${MAC_AGENT_CLI_QUOTED} remote-access disable\` removes all of it, verified.`);
    const vncPassword = await readSecret('New VNC password for remote access (input hidden): ');
    if (!vncPassword) {
      console.error('No password entered — nothing was changed.');
      process.exit(1);
    }
    const steps = planMacRemoteEnable({ vncPassword, account, tunnelInterface });
    const results = await runMacRemotePlan(realMacRemoteIo, steps, { secret: vncPassword });
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error('\n✗ Enable did NOT fully apply — the channel is being left OFF:');
      for (const f of failed) console.error(`  - ${f.cmd}: ${f.why} (exit ${f.code})`);
      // Fail CLOSED: a half-applied enable could leave the service listening
      // without its firewall scoping, which is the exposure case this whole
      // feature exists to prevent. Revert immediately.
      console.error('  Revoking to a known-safe state...');
      await runMacRemotePlan(realMacRemoteIo, planMacRemoteRevert(tunnelInterface));
      process.exit(2);
    }
    for (const r of results) console.log(`✓ ${r.cmd} — ${r.why}`);
    saveConfig({
      ...config,
      remoteAccess: {
        enabled: true,
        account,
        tunnelInterface,
        // The device cannot attest its own OUTBOUND broker binding from a local
        // probe, so this stays false until the broker path confirms it — which
        // makes the fleet report "not ready" rather than a false green.
        tunnelOnly: false,
        enabledAt: new Date().toISOString(),
      },
    });
    console.log('\nThe channel is up and firewalled to the tunnel.');
    console.log('The fleet will show remote-ready: NO until the brokered tunnel binding is confirmed');
    console.log('(that is deliberate — an unprovable exposure boundary never reads as ready).');
    return;
  }

  if (sub === 'disable') {
    if (!config) {
      console.error('Not paired — nothing to disable.');
      process.exit(1);
    }
    // The revert is privileged too (kickstart + pfctl), so it fails the same
    // silent way when run unprivileged — one actionable line instead.
    const revokeRefusal = privilegedRunRefusal({
      uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
      paired: true,
    });
    if (revokeRefusal) {
      console.error(revokeRefusal.replace('enable <account> [tunnelInterface]', 'disable'));
      process.exit(1);
    }
    const steps = planMacRemoteRevert(iface);
    const results = await runMacRemotePlan(realMacRemoteIo, steps);
    for (const r of results) console.log(`${r.ok ? '✓' : '⚠️ '} ${r.cmd} — ${r.why}`);
    // VERIFY rather than assume: read the three surfaces back.
    const [sharing, anchor] = await Promise.all([
      realMacRemoteIo.run('defaults', ['read', '/Library/Preferences/com.apple.RemoteManagement', 'ALLOW_SCREENSHARING']),
      realMacRemoteIo.run('pfctl', ['-a', 'com.digby.brokered', '-sr']),
    ]);
    const vncExists = await realMacRemoteIo.exists(VNC_SETTINGS_FILE);
    const check = verifyMacRemoteRevert({
      allowScreenSharing: sharing.stdout,
      vncFileExists: vncExists,
      anchorRules: anchor.stdout,
    });
    saveConfig({
      ...config,
      remoteAccess: { enabled: false, account: config.remoteAccess?.account, tunnelInterface: iface },
    });
    if (check.clean) {
      console.log('\n✓ Revoked and VERIFIED: the service is off, the credential file is gone, and the');
      console.log('  firewall anchor no longer passes 5900.');
    } else {
      console.error('\n⚠️  Revoked, but VERIFICATION FOUND REMAINDERS:');
      for (const r of check.remaining) console.error(`  - ${r}`);
      console.error(`  Re-run \`${MAC_AGENT_CLI_QUOTED} remote-access disable\`, or remove these by hand.`);
      process.exit(2);
    }
    return;
  }

  console.log('Usage: digby-agent remote-access <status|enable <account> [tunnelInterface]|disable>');
  process.exit(1);
}

/** Read a secret from the LOCAL terminal with echo disabled. Never argv, never
 *  an environment variable, never piped — the value exists only in this
 *  process's memory for the length of the /etc/kcpassword write. */
function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: refuse rather than read a secret from a pipe (a
      // shell history / script file holding the password is the exact
      // mistake this restriction prevents).
      console.error('Refusing to read a password from a non-interactive shell — run this in Terminal.app.');
      resolve('');
      return;
    }
    const rl = createInterface({ input, output });
    // node's readline ignores echo suppression portably; use the raw-mode
    // approach instead so the password never echoes into a scrollback.
    rl.close();
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') { // ctrl-c
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve('');
          return;
        }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function status(): void {
  const config = loadConfig();
  console.log(`Digby iMessage agent v${AGENT_VERSION}`);
  console.log(`Config: ${configPath()}`);
  if (!config) {
    console.log('State:  NOT PAIRED  (run: digby-agent pair)');
  } else {
    console.log(`State:  paired → ${config.apiBaseUrl}  (agentId ${config.agentId})`);
  }
  const access = checkAccess();
  console.log(`chat.db access: ${access.ok ? 'OK' : 'DENIED — ' + access.error}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || 'run';
  switch (cmd) {
    case 'pair':
      await pair();
      break;
    case 'run':
      await runLoop();
      break;
    case 'status':
      status();
      break;
    // Full Disk Access probe for THIS executable (ticket 51d8dbe0): install.sh
    // runs it under the DigbyAgent binary so the add-the-file dance is only
    // walked when the grant is actually missing. Exits 0 when chat.db opens
    // (granted), 3 when denied. Never touches the network.
    case 'fda-check': {
      const access = checkAccess();
      console.log(access.ok ? 'FDA_OK' : `FDA_MISSING: ${access.error || 'unknown'}`);
      process.exit(access.ok ? 0 : 3);
    }
    // ── "Unattended / Autonomous use" preset (2026-10-28) ──────────────────
    // `status`   — read-only verdict (what the fleet sees), no changes.
    // `enable`   — apply the preset. The account password is TYPED BY THE USER
    //              into this terminal, used once for /etc/kcpassword, and never
    //              logged, stored in the config, or sent anywhere.
    // `disable`  — the kill switch: restores every captured pre-change value.
    case 'unattended':
      await unattendedCli(process.argv.slice(3));
      break;
    // ── BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29) ───
    // `status`  — read-only verdict (what the fleet sees), no changes.
    // `enable`  — provision Screen Sharing under the hardened posture: PF
    //             anchor scoping 5900 to the tunnel BEFORE the service listens,
    //             a DEDICATED VNC password typed by the user (never the account
    //             password, never stored by us), designated account only.
    // `disable` — verified revoke: removes the credential file, the anchor and
    //             the service, then RE-READS all three and reports survivors.
    case 'remote-access':
      await remoteAccessCli(process.argv.slice(3));
      break;
    // Pre-swap smoke test (ticket 4e75cdea): trySelfUpdate runs this against a
    // STAGED tree before swapping it in; also handy by hand after a manual
    // install. Never touches the network or the backend.
    case 'selftest':
      selfTest();
      break;
    // Detached rollback watchdog (ticket 4e75cdea), spawned by trySelfUpdate
    // from the OLD tree: sleeps the deadline, then either stands down (the new
    // binary confirmed itself via the ok-marker) or restores the backup.
    case 'update-watchdog': {
      const agentRoot = process.argv[3];
      const backupDir = process.argv[4];
      const deadlineMs = Number(process.argv[5] || 0);
      if (!agentRoot || !backupDir || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        console.error('Usage: digby-agent update-watchdog <agentRoot> <backupDir> <deadlineMs>');
        process.exit(2);
      }
      process.exit(await runWatchdog(agentRoot, backupDir, deadlineMs));
    }
    default:
      console.log('Usage: digby-agent <pair|run|status|selftest|fda-check|update-watchdog>');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
