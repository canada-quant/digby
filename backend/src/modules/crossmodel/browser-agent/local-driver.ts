/**
 * LocalBrowserDriver — the user's own Mac via the paired Digby agent (Playwright).
 *
 * The action vocabulary is dispatched to the Mac through the long-poll command
 * broker (agentBroker). The agent (imessage-agent/src/browser.ts, v0.2.0+) runs a
 * local Playwright browser and returns BrowserObservation-shaped results, so this
 * driver is a thin marshaller: action → `browser_<name>` command → observation.
 *
 * What this browser IS (honesty fix 2026-09-09): Digby's OWN persistent browser
 * profile on the user's Mac (~/.config/digby-agent/browser-profile). It stays
 * logged in to whatever the user signed into THROUGH Digby (a pop-out login
 * persists), so it beats cloud for anti-bot pages and for accounts the user has
 * connected here — but it is NOT their everyday Chrome/Safari profile and does
 * not inherit those logins. Tasks that need the user's EXISTING browser session
 * or a desktop app belong to the computer agent (computer-agent/), which drives
 * their real screen; the router can hand off there (kind 'computer').
 *
 * Browser ops can be slow (page loads, JS), so we dispatch with a 45s timeout.
 */

import logger from '../../../utils/logger';
import { agentBroker, agentVersionAtLeast } from '../imessage/agent-link';
import { BrowserAction, BrowserDriver, BrowserObservation, LiveViewFrame } from './types';

const BROWSER_OP_TIMEOUT_MS = 45000;
/** e6b16c4e: same per-observation page-content cap the agent sides (mac/win
 *  browser.ts) and CloudBrowserDriver apply — defense in depth against an
 *  unclipped payload from an old/buggy agent build (see execute()). */
const MAX_CONTENT_CHARS = 8000;
/** Live-view capture (browser panel only) — a Playwright screenshot is fast;
 *  never let it eat the step budget. */
const LIVE_VIEW_TIMEOUT_MS = 12000;
/** JPEG quality asked of a ≥0.4.1 agent for live-view frames (a 1280×900 PNG
 *  is 3-6× the bytes of a q60 JPEG on the Redis run-event mirror). Older agents
 *  ignore the params and return PNG — still rendered, just heavier. */
const LIVE_VIEW_JPEG_QUALITY = 60;
/** browser_pop_out ships in Mac agent v0.4.0 (the headless-by-default cutover —
 *  older agents run headed already, so the window is visible without it). */
const POP_OUT_MIN_AGENT_VERSION = '0.4.0';
const POP_OUT_TIMEOUT_MS = 20000;
/** CDP-attach mode ships in Mac agent v0.5.0 (ticket 4258335e) — an older agent
 *  does not understand params.attach and would silently run its Digby profile
 *  anyway, so the driver withholds the param and names the gap in attachNote(). */
const ATTACH_MIN_AGENT_VERSION = '0.5.0';

export class LocalBrowserDriver implements BrowserDriver {
  readonly kind = 'local' as const;
  constructor(
    private readonly agentId: string,
    /** The paired agent's reported version, when the caller knows it — gates the
     *  pop-out dispatch so pre-0.4.0 agents are skipped without a round trip. */
    private readonly agentVersion?: string | null,
    /** Per-task CDP-attach opt-in (4258335e): ride params.attach on every
     *  browser_* command. The AGENT applies it only when the owner's master
     *  switch is on too; here we additionally withhold it from pre-0.5.0 agents. */
    private readonly attach = false,
  ) {}

  /** True when this session wants CDP-attach AND the paired agent is new enough
   *  to understand it. An unknown version is treated as too old (conservative). */
  attachAllowed(): boolean {
    return this.attach && !!this.agentVersion && agentVersionAtLeast(this.agentVersion, ATTACH_MIN_AGENT_VERSION);
  }

  /** Why a requested attach will NOT be honored — surfaced in the session's
   *  localBrowserStatus so the calling model can answer "why didn't my own
   *  Chrome engage?" honestly. Null when attach runs (or was never asked). */
  attachNote(): string | null {
    if (!this.attach) return null;
    if (this.attachAllowed()) return null;
    return `CDP attach was requested but the Mac agent is v${this.agentVersion || 'unknown'} (attach needs agent v${ATTACH_MIN_AGENT_VERSION}+) — running on Digby's separate browser profile instead.`;
  }

  async isAvailable(): Promise<boolean> {
    // Availability (online + capable version) is decided by the router before this
    // driver is constructed; a quick ping confirms the agent is still answering.
    // capability (W1, 2026-09-25): broker-side claiming gate — a poller that
    // advertises a capability set WITHOUT 'browser' (the handshake allows it)
    // requeues instead of claiming; a legacy Mac (no advertisement) claims as
    // before.
    try {
      const res: any = await agentBroker.dispatch(this.agentId, 'ping', {}, 8000, { capability: 'browser' });
      return !!res;
    } catch {
      return false;
    }
  }

  async execute(action: BrowserAction): Promise<BrowserObservation> {
    const method = `browser_${action.name}`; // browser_navigate, browser_click, …
    const params: Record<string, unknown> = {
      url: action.url,
      format: action.format,
      selector: action.selector,
      text: action.text,
      submit: action.submit,
      direction: action.direction,
      amount: action.amount,
      instruction: action.instruction,
      // 4258335e: per-task CDP-attach opt-in — withheld from pre-0.5.0 agents
      // (attachNote explains); the agent additionally requires its owner-side
      // master switch, so this param alone never enables attach.
      attach: this.attachAllowed() ? true : undefined,
    };
    try {
      // capability (W1, 2026-09-25): browser-tagged commands stay queued for a
      // browser-capable poller — a device advertising a capability set WITHOUT
      // 'browser' requeues instead of claiming (a legacy Mac claims as before).
      const res: any = await agentBroker.dispatch(this.agentId, method, params, BROWSER_OP_TIMEOUT_MS, { capability: 'browser' });
      // The agent returns a BrowserObservation-shaped object; normalize defensively.
      // e6b16c4e: cap page content at the same 8k the agent sides (mac/win
      // browser.ts) and the cloud driver apply. Every shipped agent clips, but
      // this driver trusts the wire — an unclipped/degenerate payload from an
      // old or buggy build rides straight into the model's tool result. A cap
      // here is defense in depth, never the primary guard (isDegenerate +
      // looksLikeCaptcha guard the loop).
      const rawContent = typeof res?.content === 'string' ? res.content : undefined;
      const clipped =
        rawContent && rawContent.length > MAX_CONTENT_CHARS
          ? rawContent.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]'
          : rawContent;
      return {
        ok: res?.ok !== false,
        driver: 'local',
        action: action.name,
        url: res?.url,
        content: clipped,
        screenshotBase64: res?.screenshotBase64,
        screenshotMime: typeof res?.mime === 'string' ? res.mime : undefined,
        links: Array.isArray(res?.links) ? res.links.slice(0, 50) : undefined,
        error: res?.error,
        truncated: res?.truncated === true || (rawContent?.length || 0) > MAX_CONTENT_CHARS,
        // 4258335e: which browser ACTUALLY drove (attached / digby-profile) —
        // a pre-0.5.0 agent stamps no mode, so absence means "unknown/legacy".
        mode: res?.mode === 'attached' || res?.mode === 'digby-profile' ? res.mode : undefined,
      };
    } catch (e: any) {
      logger.warn(`LocalBrowserDriver: ${method} failed: ${e?.message || e}`);
      return { ok: false, driver: 'local', action: action.name, error: e?.message || String(e) };
    }
  }

  /**
   * Headed escalation (UI Phase 6b): ask the Mac agent to relaunch its
   * headless-by-default browser HEADED on the same persistent profile (URL
   * restored) so the user can complete a login/2FA by hand. Best-effort — never
   * throws: a pre-0.4.0 agent is skipped without a round trip (it runs headed
   * already and would answer "Unknown method"), and any dispatch/agent failure
   * (env-forced headless, no live page, timeout) resolves false.
   */
  async popOutHeaded(): Promise<boolean> {
    if (this.agentVersion && !agentVersionAtLeast(this.agentVersion, POP_OUT_MIN_AGENT_VERSION)) {
      logger.info(
        `LocalBrowserDriver: skipping browser_pop_out — Mac agent v${this.agentVersion} < v${POP_OUT_MIN_AGENT_VERSION} (headed by default there)`,
      );
      return false;
    }
    try {
      const res: any = await agentBroker.dispatch(this.agentId, 'browser_pop_out', {}, POP_OUT_TIMEOUT_MS, { capability: 'browser' });
      if (res?.ok === false) {
        logger.info(`LocalBrowserDriver: browser_pop_out declined by agent: ${res?.error || 'no reason given'}`);
        return false;
      }
      return true;
    } catch (e: any) {
      // Never fail the session over the pop-out — an unknown-version old agent
      // answers "Unknown method: browser_pop_out"; treat every error as a no-op.
      logger.warn(`LocalBrowserDriver: browser_pop_out failed (non-fatal): ${e?.message || e}`);
      return false;
    }
  }

  /**
   * Live view for the browser panel (2026-09-09): one `browser_screenshot` per
   * executed action, asked as JPEG (agent ≥ 0.4.1; older agents return PNG).
   * Best-effort — null on any failure, never throws.
   */
  async liveView(): Promise<LiveViewFrame | null> {
    try {
      // capability (W1, 2026-09-25): same broker claiming gate as every other
      // browser_* command (see execute).
      const res: any = await agentBroker.dispatch(
        this.agentId,
        'browser_screenshot',
        { format: 'jpeg', quality: LIVE_VIEW_JPEG_QUALITY, purpose: 'live-view' },
        LIVE_VIEW_TIMEOUT_MS,
        { capability: 'browser' },
      );
      if (!res || res.ok === false || typeof res.screenshotBase64 !== 'string' || !res.screenshotBase64) return null;
      return {
        screenshotBase64: res.screenshotBase64,
        mime: typeof res.mime === 'string' && res.mime.startsWith('image/') ? res.mime : 'image/png',
        url: typeof res.url === 'string' ? res.url : undefined,
      };
    } catch (e: any) {
      logger.info(`LocalBrowserDriver: live-view capture skipped: ${e?.message || e}`);
      return null;
    }
  }

  async close(): Promise<void> {
    // capability (W1, 2026-09-25): same claiming gate; best-effort as before.
    try { await agentBroker.dispatch(this.agentId, 'browser_close', {}, 10000, { capability: 'browser' }); } catch { /* best-effort */ }
  }
}
