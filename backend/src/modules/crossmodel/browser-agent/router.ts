/**
 * Browser driver router — REASONS which browser to use (no hardcoded triggers).
 *
 * Availability gates the choice first:
 *   - Cloud (BrightData via the Digby MCP gateway) is always available.
 *   - Local (the user's Mac) is available only when a paired Digby agent is online
 *     and new enough to run the browser (agentVersion ≥ 0.2.0).
 *   - Computer (the user's REAL desktop — their everyday browser with its existing
 *     logins, Mail, any installed app, driven by screenshots + clicks/keys via the
 *     computer agent) is available when the same paired Mac is online at agent
 *     ≥ 0.3.0 AND the vision model is configured (2026-09-09 — owner: "full
 *     computer use… uses whatever browser or common apps the user already uses").
 *
 * When ONLY cloud is available, that's the answer. Otherwise GLM-5.3 reasons
 * about the task and the destinations' strengths and picks one — there are NO
 * keyword/trigger lists. The model is told what each destination is good at and
 * decides which fits the user's request. A 'computer' pick is a HANDOFF: the
 * glm-loop runs the computer agent instead of a browser driver.
 */

import logger from '../../../utils/logger';
import { isOnline } from '../imessage/imessage.service';
import { advertisesCapabilities, hasCapability } from '../imessage/agent-capabilities';
import { computerAgentStatus, computerUseAvailable } from '../computer-agent/availability';
import { visionConfigured } from '../computer-agent/vision-client';
import { CloudBrowserDriver } from './cloud-driver';
import { LocalBrowserDriver } from './local-driver';
import { HostedBrowserDriver } from './hosted-driver';
import { BROWSER_SERVICE_ENABLED, sessionBrowserAvailable } from './session-browser-client';
import { glmChat, glmConfigured, stripThink } from './glm-client';
import { BrowserDriver } from './types';
import { decide, decisionMode, decisionThreshold, recordDecisionOutcome } from '../platform/decision-gate';
import type { DecideResult } from '../platform/decision-gate';

/** Minimum agent version that ships the local Playwright browser (legacy Mac gate). */
const MIN_LOCAL_BROWSER_VERSION = [0, 2, 0];

function versionAtLeast(version: string | null | undefined, min: number[]): boolean {
  if (!version) return false;
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a > min[i]) return true;
    if (a < min[i]) return false;
  }
  return true; // equal
}

/** A browser driver was chosen (cloud or the Mac's Digby browser profile). */
export interface BrowserDriverSelection {
  driver: BrowserDriver;
  kind: 'cloud' | 'local' | 'hosted';
  reason: string;
  /** Human-readable local (paired-Mac) browser availability at selection time —
   *  surfaced to the UI/tool caller (feedback 2027d98d). */
  localStatus?: string;
  /** Ticket e6b16c4e: identity of the paired agent that drove the LOCAL driver,
   *  when kind === 'local' — lets the caller re-read the device's presence at
   *  result time instead of repeating a selection-time 'connected' that may be
   *  minutes stale (a Windows agent that died mid-task still read 'connected'). */
  localAgentId?: string;
}

/** The router chose the user's REAL desktop: the glm-loop hands the task to
 *  the computer agent (computer-agent/computer-loop.ts) — no browser driver. */
export interface ComputerHandoffSelection {
  driver: null;
  kind: 'computer';
  reason: string;
  localStatus?: string;
  /** computerAgentStatus() line at selection time. */
  computerStatus: string;
}

export type DriverSelection = BrowserDriverSelection | ComputerHandoffSelection;

/** Short relative-age line for the local-status diagnostics. */
function lastSeenAgo(lastSeenAt: Date | null | undefined): string {
  if (!lastSeenAt) return 'never seen online';
  const mins = Math.max(0, Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60000));
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `last seen ${hours} h ago`;
  return `last seen ${Math.round(hours / 24)} d ago`;
}

/**
 * Human-readable local-browser availability (feedback 2027d98d). The old cloud
 * fallback said only "no Digby browser is connected", so a user with a paired
 * Mac could not tell WHY the local browser was skipped — not paired, offline,
 * or too old (the local Playwright browser needs app v0.2.0+).
 */
/**
 * The local-driver availability gate as ONE reusable predicate (UI Phase 6a):
 * exactly the check selectBrowserDriver / selectLocalFallbackDriver apply —
 * paired agent online AND version ≥ 0.2.0. Exported so status surfaces (the
 * imessage /status endpoint → Connected-instances "Browser:" row) report the
 * SAME availability the router actually routes on, instead of re-deriving it.
 */
export function localBrowserAvailable(agent: {
  agentVersion?: string | null;
  lastSeenAt?: Date | null;
  platform?: string | null;
  capabilities?: readonly string[] | null;
} | null): boolean {
  if (!agent || !isOnline(agent.lastSeenAt)) return false;
  // W0 capability handshake (2026-09-25): an advertising agent answers from
  // its advertisement; a legacy Mac row keeps the historical version gate.
  if (advertisesCapabilities(agent)) return hasCapability(agent, 'browser');
  return versionAtLeast(agent.agentVersion, MIN_LOCAL_BROWSER_VERSION);
}

export function localBrowserStatus(agent: {
  agentVersion?: string | null;
  lastSeenAt?: Date | null;
  platform?: string | null;
  capabilities?: readonly string[] | null;
} | null): string {
  if (!agent) {
    return 'not connected — no Digby Mac agent is paired (pair the Mac app to let Digby drive your own logged-in browser)';
  }
  const isWindows = agent.platform === 'windows';
  if (!isOnline(agent.lastSeenAt)) {
    return isWindows
      ? `offline — your paired Windows PC is ${lastSeenAgo(agent.lastSeenAt)} (open the Digby app to reconnect)`
      : `offline — your paired Mac is ${lastSeenAgo(agent.lastSeenAt)} (open the Digby Mac app to reconnect)`;
  }
  // W0 handshake: an advertising agent answers from its advertisement.
  if (advertisesCapabilities(agent)) {
    if (hasCapability(agent, 'browser')) {
      return `connected (${isWindows ? 'Windows agent' : 'Mac app'} v${agent.agentVersion || 'unknown'})`;
    }
    return `connected — this ${isWindows ? 'Windows PC' : 'Mac'} does not offer the local browser (capabilities: ${(agent.capabilities || []).join(', ') || 'none'})`;
  }
  if (!versionAtLeast(agent.agentVersion, MIN_LOCAL_BROWSER_VERSION)) {
    return `connected but too old — Mac app v${agent.agentVersion || 'unknown'}; the local browser needs v${MIN_LOCAL_BROWSER_VERSION.join('.')} or newer (update the Digby Mac app)`;
  }
  return `connected (Mac app v${agent.agentVersion || 'unknown'})`;
}

/**
 * Multi-Mac (owner 2026-09-24): aggregate the local-browser availability of ALL
 * paired Macs. "Too old" excludes only THAT Mac, never the whole surface — a
 * MacBook Pro on v0.1.9 next to a Mac mini on v0.4.1 reads as "available on
 * 'Mac mini'; 'MacBook Pro' is too old". The single-agent localBrowserStatus
 * above stays the per-device line (status payloads render it per Mac).
 */
export function localBrowserStatusMulti(
  agents: { id: string; label?: string | null; deviceName?: string | null; agentVersion?: string | null; lastSeenAt?: Date | null; platform?: string | null; capabilities?: readonly string[] | null }[] | null | undefined,
): string {
  if (!agents || agents.length === 0) return localBrowserStatus(null);
  if (agents.length === 1) return localBrowserStatus(agents[0]);
  const name = (a: typeof agents[0]) => a.label || a.deviceName || 'Mac';
  // W1 (2026-09-25): capability-aware per-device parts — an advertising agent
  // answers from its advertisement (mirrors localBrowserStatus and the gate the
  // router routes on); a legacy row keeps the historical version line. The
  // aggregate shape and the 'no usable Mac browser' prefix are unchanged.
  const parts = agents.map((a) => {
    if (!isOnline(a.lastSeenAt)) return `'${name(a)}': ${lastSeenAgo(a.lastSeenAt)} (offline)`;
    if (advertisesCapabilities(a)) {
      return hasCapability(a, 'browser')
        ? `'${name(a)}': connected (v${a.agentVersion || 'unknown'})`
        : `'${name(a)}': no browser capability (capabilities: ${(a.capabilities || []).join(', ') || 'none'})`;
    }
    if (!versionAtLeast(a.agentVersion, MIN_LOCAL_BROWSER_VERSION)) {
      return `'${name(a)}': too old (v${a.agentVersion || 'unknown'} < ${MIN_LOCAL_BROWSER_VERSION.join('.')})`;
    }
    return `'${name(a)}': connected (v${a.agentVersion || 'unknown'})`;
  });
  const anyUsable = agents.some((a) => isOnline(a.lastSeenAt) && localBrowserAvailable(a));
  return anyUsable
    ? `connected — ${parts.join('; ')}`
    : `no usable Mac browser — ${parts.join('; ')}`;
}

/**
 * Ticket e6b16c4e: re-read the LOCAL driver device's presence at RESULT time.
 * A browser session can outlive its device — the incident's Windows agent
 * answered one poll at selection, died mid-task, and the result header still
 * said 'connected (Windows agent v0.9.0)' over a wall of timeouts. The
 * glm-loop calls this when assembling its result: pass the agent id the router
 * stamped on the selection (selection.localAgentId) and get the CURRENT
 * per-device status line. Null (agent deleted, lookup error) keeps the
 * selection-time line — a degraded re-read must never blank the header.
 */
export async function freshLocalBrowserStatus(agentId: string, fallback: string): Promise<string> {
  try {
    const { findAgentById } = await import('../imessage/imessage.service');
    const agent = await findAgentById(agentId);
    return agent ? localBrowserStatus(agent) : fallback;
  } catch {
    return fallback;
  }
}

const CLOUD_DESC =
  'CLOUD browser (BrightData): a hosted browser in the cloud with residential proxies and ' +
  'anti-bot handling. Best for PUBLIC websites, research, scraping, sites that block datacenter ' +
  'traffic, or anything that does NOT require the user to be logged in. It has no access to the ' +
  "user's personal accounts, cookies, or private sessions.";

const LOCAL_DESC =
  "LOCAL browser (Digby's own browser on the user's Mac): a real Chromium running on the user's " +
  "computer under a persistent DIGBY profile — it stays signed in wherever the user logged in " +
  "THROUGH Digby before (a pop-out login persists for later tasks), and it can click, type and " +
  "scroll. It is NOT the user's everyday Chrome/Safari profile and does not inherit those logins " +
  '(UNLESS the caller explicitly requested per-task CDP-attach mode — then the task may run in a ' +
  'dedicated new tab of their everyday Chrome; the session reports which mode actually ran). ' +
  'Good for interactive web tasks, anti-bot pages, and sites the user has already connected here. ' +
  'It only works while their Mac is online.';

const COMPUTER_DESC =
  "COMPUTER (the user's real desktop): Digby sees the user's actual Mac screen and clicks/types " +
  'like a person — in THEIR everyday browser (Chrome/Safari with all their existing logins, ' +
  'extensions, open tabs) and in any installed app (Mail, Calendar, Finder, Slack, Xcode, System ' +
  'Settings…). Choose it when the task must run in the user\'s EXISTING browser session or an app, ' +
  "when the user names their browser or an app or their screen (\"in Chrome\", \"in my Mail\", " +
  "\"what's on my screen\", \"on my Mac\"), or when success depends on logins only their real " +
  'browser has. It is slower per step than the browsers — do not use it for plain public-web reading.';

/** Ticket 8fe9429c — the observe-only COMPUTER description: a read-only
 *  worker's session cannot act on the desktop, so the router must not pick
 *  COMPUTER for an interactive task in that mode — only for looking (reading
 *  the screen / a desktop app's contents). */
const COMPUTER_DESC_OBSERVE =
  "COMPUTER (the user's real desktop, CAMERA-ONLY for this session): Digby can SEE the user's " +
  'actual screen and READ what is on it (their everyday browser, any installed app, dialogs, ' +
  'Terminal output) but CANNOT click, type, press keys, scroll, open or quit apps — this session ' +
  'is observe-only, so every input action is refused by the harness. Choose it ONLY when the task ' +
  'is to LOOK at the screen or read something displayed there (read the Terminal window, check ' +
  "what's open, verify an app's state). If the task needs to ACT on the desktop, do NOT choose " +
  'COMPUTER — choose cloud or local and report the limitation.';

// One-sentence summaries of the three *_DESC blocks for the decision gate's
// CHOICE criteria (purpose 'browser_driver'; ≤ 200 chars each — the gate
// reads a small state, not the full routing prompt).
const CLOUD_GATE_SUMMARY =
  "Hosted cloud browser with residential proxies and anti-bot handling: public websites, research and scraping; no access to the user's accounts, cookies or private sessions.";
const LOCAL_GATE_SUMMARY =
  "Digby's own Chromium on the user's Mac (persistent Digby profile, signed in wherever the user logged in through Digby): clicks, types, scrolls; not their everyday browser.";
const COMPUTER_GATE_SUMMARY =
  "The user's real desktop seen and driven like a person: their everyday browser with existing logins plus any installed app; slowest per step, choose only when the task needs their real session or a desktop app.";

/** Ticket ea3ad8a8 — the HOSTED hardened browser: Digby's own pinned-Chromium
 *  container, ONE persistent context per session (own cookies/cache, saved
 *  across runs). The destination for users with NO paired desktop agent. */
const HOSTED_DESC =
  'HOSTED browser (Digby\u2019s own hardened browser in the cloud, one persistent ' +
  'session per chat): a real Chromium with its OWN cookies/localStorage that SURVIVE ' +
  'between tasks — sign in once (in a task where you do the login) and later tasks in ' +
  'the same chat resume signed in. It can click, type, scroll and screenshot. It is ' +
  'isolated per session (never the user\u2019s everyday browser, never shared with other ' +
  'users) and needs no paired device. Good for interactive web tasks and staying logged ' +
  'in when there is no Mac/Windows agent; it does NOT have the user\u2019s pre-existing ' +
  'personal logins (those need computer/local).';

const HOSTED_GATE_SUMMARY =
  "Digby's own cloud-hosted Chromium with a persistent per-session profile (cookies survive between tasks in the same chat): fully interactive, no paired device needed; not the user's existing logins.";

const DRIVER_GATE_INSTRUCTIONS =
  'Which destination should run this browser/computer task? Choose cloud for public web tasks needing no login; ' +
  'local for interactive web tasks, anti-bot pages, or accounts connected through Digby; computer when the task needs ' +
  "the user's existing everyday browser session, a desktop app, or their screen, or when they name their browser/app/screen/Mac; " +
  'hosted when the task should keep a persistent login in Digby\u2019s own browser for this session and no paired device is involved.';

/**
 * Reason about which driver fits. Returns the chosen driver, its kind, and a short
 * human-readable reason (surfaced to the UI). Falls back to cloud on any error.
 */
export async function selectBrowserDriver(userId: string, message: string, opts: { attach?: boolean; device?: string; computerInputMode?: 'full' | 'observe'; sessionKey?: string } = {}): Promise<DriverSelection> {
  // ── Availability ──────────────────────────────────────────────────────────
  let localAgentId: string | null = null;
  let localAgentVersion: string | null = null;
  let localStatus: string;
  let computerStatus = '';
  let computerOk = false;
  try {
    // Multi-Mac (owner 2026-09-24): reason over ALL paired Macs. The local
    // browser routes through selectAgent WITH a capability gate — an
    // online-but-too-old Mac excludes only itself, never the surface: a
    // capable sibling serves instead (default Mac preferred). Computer use
    // keeps its own capable-Mac pool below (same invariant, separately gated
    // on Mac app ≥ 0.3.0 + server-side vision).
    const { selectAgent, listAgents, agentDisplayName } = await import('../imessage/imessage.service');
    // The local-browser capability gate (online + Mac app ≥ 0.2.0, OR an
    // advertised browser capability — W0 handshake 2026-09-25): selectAgent
    // applies it to the default/sibling fallover, so an incapable default
    // with a capable sibling routes the LOCAL driver to the sibling.
    const localGate = {
      capable: (a: { agentVersion?: string | null; platform?: string | null; capabilities?: readonly string[] | null }) => localBrowserAvailable(a),
      reason: (a: { agentVersion?: string | null; platform?: string | null; capabilities?: readonly string[] | null }) =>
        localBrowserAvailable(a)
          ? ''
          : advertisesCapabilities(a)
            ? `no browser capability advertised (capabilities: ${(a.capabilities || []).join(', ') || 'none'})`
            : `too old (v${a.agentVersion || 'unknown'} < ${MIN_LOCAL_BROWSER_VERSION.join('.')})`,
      surface: 'the local browser',
    };
    const selection = await selectAgent(userId, opts.device, localGate);
    const agent = selection.agent;
    // Zero Macs paired → the canonical not-connected line (feedback 2027d98d
    // wording, pinned by tests); a targeting failure (offline/unknown device)
    // → the selection's own error, which names the devices.
    localStatus = !agent && selection.note === 'no paired Mac'
      ? localBrowserStatus(null)
      : selection.agent
        ? localBrowserStatus(selection.agent) + (selection.note && selection.note !== 'the paired Mac' ? ` [${selection.note}]` : '')
        : (selection.error || localBrowserStatus(null));
    if (agent && localBrowserAvailable(agent)) {
      localAgentId = agent.id;
      localAgentVersion = agent.agentVersion ?? null;
    }
// Computer use: any capable Mac (default Mac preferred, then the most
    // recently online capable one) — the same gate the computer driver applies.
    const allMacs = await listAgents(userId);
    const capable = allMacs.filter((a) => computerUseAvailable(a));
    const computerAgent = capable.find((a) => a.isDefault) ?? capable[0] ?? null;
    computerStatus = computerAgent
      ? computerAgentStatus(computerAgent) + (allMacs.length > 1 && computerAgent ? ` [device: '${agentDisplayName(computerAgent)}']` : '')
      : (allMacs.length > 0
        ? `no capable Mac for computer use — ${allMacs.map((a) => `'${agentDisplayName(a)}' ${computerAgentStatus(a)}`).join('; ')}`
        : computerAgentStatus(null));
    computerOk = !!computerAgent && (await visionConfigured());
  } catch (e: any) {
    logger.warn(`browser router: agent lookup failed: ${e?.message || e}`);
    localStatus = 'unknown — could not check your paired Mac (the lookup failed)';
  }

  const cloud = (): BrowserDriverSelection => ({
    driver: new CloudBrowserDriver(),
    kind: 'cloud',
    reason: localAgentId
      ? 'This task suits the cloud browser (public web / no personal login needed).'
      : 'Using the cloud browser — no usable local Mac browser for this task (see the local-browser status line).',
    localStatus,
  });

  // ── Hosted hardened browser (ticket ea3ad8a8) ────────────────────────────
  // Staged rollout: BROWSER_SERVICE_ENABLED must be set AND the service must
  // answer /health AND the caller must name its session key (the persistent
  // context's scope — chat:<chatId> / session:<id>). No key → no hosted
  // destination (a persistent profile cannot exist without a scope).
  let hostedOk = false;
  try {
    if (BROWSER_SERVICE_ENABLED() && opts.sessionKey) {
      hostedOk = await sessionBrowserAvailable(opts.sessionKey);
    }
  } catch { /* probe failure = unavailable, fall through to the other drivers */ }
  const hosted = (): BrowserDriverSelection => ({
    driver: new HostedBrowserDriver(opts.sessionKey!),
    kind: 'hosted',
    reason: 'Using Digby\u2019s own hosted browser — a persistent, isolated session for this chat (sign in once, stay signed in).',
    localStatus,
  });
  const local = (reason: string): BrowserDriverSelection => ({
    driver: new LocalBrowserDriver(localAgentId!, localAgentVersion, opts.attach === true), kind: 'local', reason, localStatus,
    // e6b16c4e: the caller re-reads this device's presence at result time so a
    // mid-task death surfaces as 'offline', not a stale selection-time 'connected'.
    localAgentId: localAgentId ?? undefined,
  });
  const computer = (reason: string): ComputerHandoffSelection => ({
    driver: null, kind: 'computer', reason, localStatus, computerStatus,
  });

  // Only cloud available → done, no reasoning needed. The hosted hardened
  // browser (ea3ad8a8) counts as an available destination: an app-less user
  // (no paired Mac, no computer use) with the hosted service up + a session
  // key is EXACTLY the user this destination exists for — route them to it
  // directly rather than falling through to the read-only cloud scrape.
  if (!localAgentId && !computerOk) {
    if (hostedOk) return hosted();
    return cloud();
  }

  // A Mac is paired → reason. If GLM is unavailable, default to the Mac (the
  // user explicitly connected it, so honor it for ambiguous cases): the Digby
  // browser when it runs there, else the computer agent.
  if (!(await glmConfigured())) {
    return localAgentId
      ? local('Your Mac browser is connected, so using it.')
      : computer('Your Mac is connected (computer use), so using it.');
  }

  const options: string[] = [];
  // 8fe9429c: an observe-only session describes the COMPUTER destination with
  // its camera-only ceiling so the router (GLM / decision gate) cannot pick it
  // for an interactive desktop task — the capability limit is named up front.
  const computerDesc = opts.computerInputMode === 'observe' ? COMPUTER_DESC_OBSERVE : COMPUTER_DESC;
  if (localAgentId) options.push(LOCAL_DESC);
  options.push(CLOUD_DESC);
  if (hostedOk) options.push(HOSTED_DESC);
  if (computerOk) options.push(computerDesc);
  const allowed = [localAgentId ? '"local"' : null, '"cloud"', hostedOk ? '"hosted"' : null, computerOk ? '"computer"' : null].filter(Boolean).join('|');

  // Decision gate (2026-09-24, purpose 'browser_driver'): a typed CHOICE over
  // the SAME available destinations before the 30 s GLM reasoning call.
  // shadow = ask, then let GLM choose as before and record GLM's pick next to
  // the gate's; act = route on a confident pick — never to a destination that
  // is not actually available (the same guard the GLM path applies). The gate
  // can only remove work: any error here falls through to the GLM path.
  let gate: DecideResult | null = null;
  // E6 (2026-09-25): SHADOW runs the gate CONCURRENTLY with the GLM call (the
  // nlp.ts pattern) — the 2026-09-24 site awaited decide() in every mode and
  // added the readout's ~0.8 s to a user-facing path for a row that only gets
  // compared afterwards. Only ACT awaits first (a confident pick skips GLM).
  // The outcome is recorded once BOTH have settled.
  let gatePending: Promise<DecideResult | null> | null = null;
  const settleGate = async (): Promise<DecideResult | null> => {
    if (gate) return gate;
    if (!gatePending) return null;
    gate = await gatePending.catch(() => null);
    gatePending = null;
    return gate;
  };
  try {
    const mode = decisionMode('browser_driver');
    if (mode !== 'off') {
      const criteria: Record<string, string> = {
        cloud: CLOUD_GATE_SUMMARY,
        ...(localAgentId ? { local: LOCAL_GATE_SUMMARY } : {}),
        ...(hostedOk ? { hosted: HOSTED_GATE_SUMMARY } : {}),
        ...(computerOk ? { computer: COMPUTER_GATE_SUMMARY } : {}),
      };
      const ask = decide(
        { task: message.slice(0, 2000), mac_browser_available: !!localAgentId, computer_use_available: computerOk },
        { driver: { type: 'choice', instructions: DRIVER_GATE_INSTRUCTIONS, criteria } },
        { purpose: 'browser_driver', timeoutMs: 2000 },
      );
      if (mode === 'act') gate = await ask;
      else gatePending = ask;
      const pick = gate?.answers.driver;
      // E2 (2026-09-25): the RESULT's mode gates acting (an uncalibrated backend answers as 'shadow').
      if (gate?.mode === 'act' && pick && pick.type === 'choice' && pick.confidence >= decisionThreshold('browser_driver', 0.7)) {
        const choice = pick.choice;
        const available = choice === 'cloud' || (choice === 'local' && !!localAgentId) || (choice === 'hosted' && hostedOk) || (choice === 'computer' && computerOk);
        if (available) {
          recordDecisionOutcome(gate, 'browser_driver', { question: 'driver', actual: null, acted: true });
          logger.info(`browser router: decision gate chose ${choice} (confidence ${pick.confidence.toFixed(2)}) — skipping GLM reasoning`);
          if (choice === 'local') return local('Using your Mac browser for this task (decision gate).');
          if (choice === 'hosted') return hosted();
          if (choice === 'computer') return computer('Using your Mac directly (computer use) for this task (decision gate).');
          return { driver: new CloudBrowserDriver(), kind: 'cloud', reason: 'Using the cloud browser for this task (decision gate).', localStatus };
        }
        logger.debug(`browser router: decision gate chose "${choice}", which is not available — falling through to GLM`);
      }
    }
  } catch (e: any) {
    logger.debug(`browser router: decision gate failed open: ${e?.message || e}`);
  }

  try {
    const res = await glmChat({
      messages: [
        {
          role: 'system',
          content:
            'You route a task to the best available way of using a browser or computer for the user. ' +
            'Reason about the task; do NOT rely on specific keywords. Available destinations:\n\n' +
            options.map((d, i) => `${i + 1}. ${d}`).join('\n\n') + '\n\n' +
            'Choose CLOUD for public web tasks where no login is needed. ' +
            (localAgentId ? 'Choose LOCAL for interactive web tasks, anti-bot pages, or accounts the user has connected through Digby. ' : '') +
            (computerOk ? "Choose COMPUTER when the task needs the user's EXISTING everyday browser session (their own Chrome/Safari logins), a desktop app, or their screen — or when they name their browser/app/screen/Mac. " : '') +
            `Respond with ONLY compact JSON: {"driver":${allowed},"reason":"<one short sentence>"}.`,
        },
        { role: 'user', content: `TASK:\n${message.slice(0, 2000)}` },
      ],
      reasoningEffort: 'high',
      maxTokens: 600,
      temperature: 0,
      timeout: 30000,
    });
    const raw = stripThink(res.content);
    const slice = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(slice);
    let chosen: 'local' | 'cloud' | 'computer' | 'hosted' =
      parsed.driver === 'local' ? 'local' : parsed.driver === 'computer' ? 'computer' : parsed.driver === 'hosted' ? 'hosted' : 'cloud';
    // Never route to a destination that isn't actually available (model drift).
    if (chosen === 'local' && !localAgentId) chosen = computerOk ? 'computer' : 'cloud';
    if (chosen === 'computer' && !computerOk) chosen = localAgentId ? 'local' : 'cloud';
    if (chosen === 'hosted' && !hostedOk) chosen = 'cloud';
    const reason = String(parsed.reason || '').trim() ||
      (chosen === 'local' ? 'Using your Mac browser for this task.'
        : chosen === 'computer' ? 'Using your Mac directly (computer use) for this task.'
        : chosen === 'hosted' ? 'Using Digby\u2019s own hosted browser for this task.'
        : 'Using the cloud browser for this task.');
    logger.info(`browser router: chose ${chosen} — ${reason}`);
    // E6: the shadow gate settles here — after GLM — so it never delays the pick.
    recordDecisionOutcome(await settleGate(), 'browser_driver', { question: 'driver', actual: chosen, acted: false });
    if (chosen === 'local') return local(reason);
    if (chosen === 'hosted') return hosted();
    if (chosen === 'computer') return computer(reason);
    return { driver: new CloudBrowserDriver(), kind: 'cloud', reason, localStatus };
  } catch (e: any) {
    logger.warn(`browser router: reasoning failed, defaulting to the paired Mac: ${e?.message || e}`);
    const defaulted: 'local' | 'computer' = localAgentId ? 'local' : 'computer';
    recordDecisionOutcome(await settleGate(), 'browser_driver', { question: 'driver', actual: defaulted, acted: false, note: 'GLM reasoning failed — defaulted to the paired Mac' });
    return defaulted === 'local'
      ? local('Your Mac browser is connected, so using it.')
      : computer('Your Mac is connected (computer use), so using it.');
  }
}

/**
 * Mid-session escape hatch (feedback b346ce80): the cloud driver discovers a
 * BrightData zone-block only when a CDP navigate is refused — AFTER selection.
 * The glm-loop calls this to re-route to the user's paired Mac browser. Same
 * availability gate as selectBrowserDriver (online + version ≥ 0.2.0); returns
 * null when no usable local agent exists, so the session just carries on
 * read-only.
 */
export async function selectLocalFallbackDriver(userId: string, opts: { attach?: boolean; device?: string } = {}): Promise<BrowserDriverSelection | null> {
  try {
    // Multi-Mac: same device-aware selection as the primary route — INCLUDING
    // the capability gate, so mid-loop re-routing also finds the capable
    // sibling when the default Mac is online but too old.
    const { selectAgent } = await import('../imessage/imessage.service');
    // W1 (2026-09-25): the SAME capability gate as the primary route — an
    // advertising agent answers from its advertisement (a Windows agent
    // advertises 'browser'); a legacy Mac row keeps the version gate, so a
    // pre-handshake fleet re-routes exactly as before.
    const localGate = {
      capable: (a: { agentVersion?: string | null; platform?: string | null; capabilities?: readonly string[] | null }) => localBrowserAvailable(a),
      reason: (a: { agentVersion?: string | null; platform?: string | null; capabilities?: readonly string[] | null }) =>
        localBrowserAvailable(a)
          ? ''
          : advertisesCapabilities(a)
            ? `no browser capability advertised (capabilities: ${(a.capabilities || []).join(', ') || 'none'})`
            : `too old (v${a.agentVersion || 'unknown'} < ${MIN_LOCAL_BROWSER_VERSION.join('.')})`,
      surface: 'the local browser',
    };
    const selection = await selectAgent(userId, opts.device, localGate);
    const agent = selection.agent;
    if (agent && localBrowserAvailable(agent)) {
      return {
        driver: new LocalBrowserDriver(agent.id, agent.agentVersion, opts.attach === true),
        kind: 'local',
        reason: 'This task needs interaction (clicks/typing) the cloud browser cannot do from this server — switching to your Mac browser.',
        localStatus: localBrowserStatus(agent),
        // e6b16c4e: same result-time presence re-read contract as the primary route.
        localAgentId: agent.id,
      };
    }
  } catch (e: any) {
    logger.warn(`browser router: local fallback lookup failed: ${e?.message || e}`);
  }
  return null;
}
